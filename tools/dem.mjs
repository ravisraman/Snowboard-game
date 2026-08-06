/**
 * Reading real elevation, with nothing installed.
 *
 * AWS hosts the Mapzen "terrarium" tile set publicly and without a key: a
 * global 256x256 PNG pyramid where every pixel's colour *is* its height. It is
 * the one real-world elevation source reachable from this sandbox, and it needs
 * no account, no token and no client library.
 *
 *     height metres = (R * 256 + G + B / 256) - 32768
 *
 * The only obstacle is that Node cannot read a PNG. Rather than take a
 * dependency for a tool that runs a handful of times and then never again, the
 * decoder is here: terrarium tiles are 8-bit RGB, non-interlaced, which is the
 * simplest case the format has, and `zlib` already ships with Node. That is
 * about sixty lines, all of them below, versus a package in `node_modules` that
 * the game itself would never load.
 *
 * Nothing here runs in the browser. This is a baking tool — it writes a small
 * table into the repo and the game reads that. See `tools/bake-run.mjs`.
 */

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, '..', '.dem-cache');

const TILE = 256;

/* ------------------------------------------------------------------------
 * PNG
 * ---------------------------------------------------------------------- */

/**
 * Decode an 8-bit RGB non-interlaced PNG to a flat Uint8Array of RGB triples.
 *
 * Deliberately not a general PNG decoder: it asserts the shape it expects
 * rather than handling the rest of the format, because a terrarium tile that
 * is not 8-bit RGB means the endpoint changed and silently coping with that
 * would bake wrong heights into the repo.
 */
export function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];

  // Walk the chunk list: length, four-character type, payload, CRC.
  for (let p = 8; p < buffer.length; ) {
    const len = buffer.readUInt32BE(p);
    const type = buffer.toString('ascii', p + 4, p + 8);
    const body = buffer.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      if (bitDepth !== 8 || colorType !== 2) {
        throw new Error(`unexpected PNG format: depth ${bitDepth}, colour type ${colorType}`);
      }
      if (body[12] !== 0) throw new Error('interlaced PNG');
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + len;
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  const out = new Uint8Array(width * height * 3);

  /*
   * Un-filtering. Each scanline carries a one-byte filter type, and every
   * filter is defined against the byte one pixel to the left (`a`), the same
   * byte on the previous line (`b`), and the one diagonally back (`c`). The
   * decoded output is the reference for both `a` and `b`, so this has to run
   * strictly in order — it cannot be vectorised or parallelised away.
   */
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= 3 ? out[dst + i - 3] : 0;
      const b = y > 0 ? out[dst - stride + i] : 0;
      const c = i >= 3 && y > 0 ? out[dst - stride + i - 3] : 0;
      let v;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) {
        // Paeth: pick whichever of the three neighbours the linear estimate
        // a + b - c lands closest to.
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`unknown PNG filter ${filter}`);
      out[dst + i] = v & 0xff;
    }
  }

  return { width, height, data: out };
}

/* ------------------------------------------------------------------------
 * Tiles
 * ---------------------------------------------------------------------- */

/**
 * Web Mercator tile coordinates, as fractions — the whole part is the tile and
 * the fraction is the position inside it, which is what sampling needs.
 */
export function lonLatToTile(lon, lat, zoom) {
  const n = 2 ** zoom;
  const latRad = (lat * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  };
}

/** Ground resolution in metres per pixel — Mercator, so it shrinks with latitude. */
export function metresPerPixel(lat, zoom) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom / (256 / TILE);
}

/**
 * Tiles are cached on disk. Not for speed — for reproducibility: once a bake
 * has run, re-running it offline gives byte-identical output, so the numbers
 * committed to the repo can be re-derived without the network.
 */
async function fetchTile(zoom, tx, ty) {
  const file = path.join(CACHE, `${zoom}-${tx}-${ty}.png`);
  if (fs.existsSync(file)) return fs.readFileSync(file);

  const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${tx}/${ty}.png`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, buf);
  return buf;
}

/**
 * A rectangular block of tiles, stitched into one height grid.
 *
 * Stitching rather than sampling per tile matters at the seams: bilinear
 * interpolation across a tile boundary needs the neighbour's first column, and
 * a per-tile sampler would clamp there instead, leaving a visible crease every
 * few hundred metres.
 */
export async function fetchHeightGrid({ zoom, minTx, minTy, tilesX, tilesY }) {
  const width = tilesX * TILE;
  const height = tilesY * TILE;
  const grid = new Float32Array(width * height);

  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const png = decodePng(await fetchTile(zoom, minTx + tx, minTy + ty));
      if (png.width !== TILE || png.height !== TILE) {
        throw new Error(`tile ${minTx + tx},${minTy + ty} is ${png.width}x${png.height}`);
      }
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          const s = (y * TILE + x) * 3;
          const metres = png.data[s] * 256 + png.data[s + 1] + png.data[s + 2] / 256 - 32768;
          grid[(ty * TILE + y) * width + tx * TILE + x] = metres;
        }
      }
    }
  }

  return { width, height, grid, zoom, minTx, minTy };
}

/** Bilinear height at fractional pixel coordinates within the stitched block. */
export function sampleGrid(block, px, py) {
  const { width, height, grid } = block;
  const x = Math.min(Math.max(px, 0), width - 1.001);
  const y = Math.min(Math.max(py, 0), height - 1.001);
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const i = iy * width + ix;
  const h00 = grid[i];
  const h10 = grid[i + 1];
  const h01 = grid[i + width];
  const h11 = grid[i + width + 1];
  return (
    h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) + h01 * (1 - fx) * fy + h11 * fx * fy
  );
}

/** Where a lon/lat lands in the stitched block, in pixels. */
export function project(block, lon, lat) {
  const t = lonLatToTile(lon, lat, block.zoom);
  return { px: (t.x - block.minTx) * TILE, py: (t.y - block.minTy) * TILE };
}
