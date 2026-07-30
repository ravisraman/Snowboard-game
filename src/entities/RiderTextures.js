import * as THREE from 'three';
import { makeRng } from '../core/mathx.js';
import { characterById, DEFAULT_CHARACTER } from './Characters.js';

/**
 * The rider's textures, painted onto a canvas at start-up.
 *
 * Everything else in this project is generated rather than downloaded, and the
 * character is no exception: this file draws one 1024² atlas — colour, height
 * and roughness — and the whole body then renders as a single textured mesh.
 *
 * Why an atlas rather than a material per garment: a skinned character can be
 * one draw call, but only if it is one material. Splitting the jacket, the
 * trousers, the skin and the mittens into separate materials would put the
 * character back to a handful of draws for no visual gain, so instead each
 * part gets a rectangle of one shared texture and `remapUV` folds its
 * generated 0-1 coordinates into that rectangle.
 *
 * The height canvas is the interesting one. Seams, stitching, knit and the
 * ribbing on the cuffs are drawn into it in greyscale and then run through a
 * Sobel filter to make a normal map, so a flat orange shell picks up creases
 * and panel lines that catch the low alpine sun. That relief is most of what
 * separates "wearing a jacket" from "painted orange".
 */

const SIZE = 1024;

/**
 * Where each part of the rider lives in the atlas, in canvas pixels.
 *
 * The V axis of every region runs the way the part does: the torso's V goes
 * hem to collar, a sleeve's goes shoulder to cuff, a leg's goes waist to
 * ankle. That is what lets a cuff be painted as a band across the bottom of a
 * rectangle rather than being worked out in three dimensions.
 */
export const REGION = {
  torso:  { x: 0,   y: 0,   w: 512, h: 512 },
  sleeve: { x: 512, y: 0,   w: 256, h: 512 },
  spare:  { x: 768, y: 0,   w: 256, h: 512 },
  pants:  { x: 0,   y: 512, w: 256, h: 512 },
  head:   { x: 256, y: 512, w: 256, h: 256 },
  boot:   { x: 256, y: 768, w: 256, h: 256 },
  mitten: { x: 512, y: 512, w: 256, h: 256 },
  beanie: { x: 768, y: 512, w: 256, h: 256 },
  strap:  { x: 512, y: 768, w: 256, h: 256 },
};

/**
 * The palette in force while the atlas is being painted.
 *
 * Module-level and reassigned, which wants justifying. Every `paint*` function
 * below reaches for `C` a hundred times; threading a palette argument through
 * all of them would be a lot of noise for a value that is constant for the
 * whole of one bake. So `riderTextures()` points `C` at the character being
 * painted, paints, and the result is cached under that character's id.
 *
 * The safety of that rests on one fact: nothing here is re-entrant. A bake is
 * synchronous from the first `inRegion` to the last, with no await and no
 * callback into anything that could start a second one.
 */
let C = characterById(DEFAULT_CHARACTER).palette;

/**
 * Turns a part's own 0-1 UVs into atlas coordinates.
 *
 * The V flip is the fiddly bit: a `CanvasTexture` is sampled with `flipY`, so
 * texture V=0 is the *bottom* row of the canvas while the region is measured
 * from the top. Getting this wrong puts everyone's collar around their knees,
 * which is how it was found.
 */
export function remapUV(geo, region) {
  const uv = geo.attributes.uv;
  if (!uv) return geo;
  const ox = region.x / SIZE;
  const sx = region.w / SIZE;
  const oy = 1 - (region.y + region.h) / SIZE;
  const sy = region.h / SIZE;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, ox + uv.getX(i) * sx, oy + uv.getY(i) * sy);
  }
  uv.needsUpdate = true;
  return geo;
}

/* ------------------------------------------------------------------
 * Canvas helpers
 * ---------------------------------------------------------------- */

function canvas(fill, willReadFrequently = false) {
  const el = document.createElement('canvas');
  el.width = el.height = SIZE;
  // `willReadFrequently` moves the canvas off the GPU and into main memory.
  // Without it, the one `getImageData` the normal map needs has to drag a
  // megapixel back across the bus, and on a software renderer that single call
  // measured at 2.6 seconds — the whole of a stall on the loading screen.
  const ctx = el.getContext('2d', { willReadFrequently });
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, SIZE, SIZE);
  return { el, ctx };
}

/** Runs a painter with the origin moved to a region and clipped to it. */
function inRegion(ctx, r, paint) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.translate(r.x, r.y);
  paint(ctx, r.w, r.h);
  ctx.restore();
}

/** Woven cloth: fine crossed threads, plus a little large-scale mottling. */
function weave(ctx, w, h, rng, { dark = 'rgba(0,0,0,0.055)', light = 'rgba(255,255,255,0.05)', step = 4 } = {}) {
  ctx.lineWidth = 1;
  for (let x = 0; x < w; x += step) {
    ctx.strokeStyle = rng() > 0.5 ? dark : light;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
    ctx.stroke();
  }
  for (let y = 0; y < h; y += step) {
    ctx.strokeStyle = rng() > 0.5 ? dark : light;
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
    ctx.stroke();
  }
  // Broad soft blotches, so the cloth is not perfectly even under the sun.
  //
  // Filled over the blob's own bounding box rather than the whole region. The
  // first version filled the full rectangle for each of twenty-six blobs
  // across eight regions, which is a couple of hundred megapixel fills and was
  // most of a two-and-a-half second stall on the loading screen.
  const R = 90;
  for (let i = 0; i < 14; i++) {
    const cx = rng() * w;
    const cy = rng() * h;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    g.addColorStop(0, rng() > 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
  }
}

/** A run of stitching. Drawn into both the colour and the height canvas. */
function stitch(ctx, x0, y0, x1, y1, { colour = 'rgba(0,0,0,0.4)', dash = [7, 6], width = 2 } = {}) {
  ctx.save();
  ctx.setLineDash(dash);
  ctx.lineWidth = width;
  ctx.strokeStyle = colour;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.restore();
}

/** Ribbed knit: the cuffs, the hem and the beanie. */
function ribbing(ctx, x, y, w, h, colour, step = 9) {
  ctx.fillStyle = colour;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(0,0,0,0.22)';
  ctx.lineWidth = 3;
  for (let i = x; i < x + w; i += step) {
    ctx.beginPath();
    ctx.moveTo(i, y);
    ctx.lineTo(i, y + h);
    ctx.stroke();
  }
}

/* ------------------------------------------------------------------
 * The parts
 * ---------------------------------------------------------------- */

function paintTorso(ctx, w, h, rng, height) {
  // V runs hem (bottom) to collar (top); U wraps right round the body.
  ctx.fillStyle = C.shell;
  ctx.fillRect(0, 0, w, h);
  weave(ctx, w, h, rng);

  // A darker yoke across the shoulders, with a soft edge — the single most
  // recognisable thing about a snowboard jacket at a distance.
  const yoke = ctx.createLinearGradient(0, 0, 0, h * 0.42);
  yoke.addColorStop(0, C.shellDark);
  yoke.addColorStop(0.72, C.shellDark);
  yoke.addColorStop(1, 'rgba(201,84,26,0)');
  ctx.fillStyle = yoke;
  ctx.fillRect(0, 0, w, h * 0.42);

  // Hem band and a waist drawcord.
  ribbing(ctx, 0, h - 46, w, 46, C.trim);
  stitch(ctx, 0, h - 52, w, h - 52, { colour: 'rgba(255,255,255,0.18)' });

  // Chest panel, pocket and zip. The zip sits a quarter of the way round from
  // the seam, which is where the front of the body lands in the loft's UVs.
  const front = w * 0.25;
  ctx.fillStyle = C.trim;
  ctx.fillRect(front - 6, h * 0.18, 12, h * 0.62);
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  for (let y = h * 0.18; y < h * 0.8; y += 8) ctx.fillRect(front - 3, y, 6, 4);

  ctx.fillStyle = C.shellDeep;
  ctx.fillRect(front - 96, h * 0.3, 78, 54);
  stitch(ctx, front - 96, h * 0.3, front - 18, h * 0.3, { colour: 'rgba(0,0,0,0.35)' });

  // Sponsor flash, the same orange the board's topsheet carries.
  ctx.fillStyle = C.beanie;
  ctx.fillRect(front + 26, h * 0.34, 62, 14);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillRect(front + 26, h * 0.37, 62, 4);

  // Panel seams around the body.
  for (const u of [0.5, 0.75]) stitch(ctx, w * u, 0, w * u, h, { colour: 'rgba(0,0,0,0.28)' });

  /* ---- height ---- */
  inRegion(height, REGION.torso, (hc) => {
    hc.fillStyle = '#808080';
    hc.fillRect(0, 0, w, h);
    hc.fillStyle = '#9a9a9a';
    hc.fillRect(0, 0, w, h * 0.4);                      // the yoke stands proud
    ribbing(hc, 0, h - 46, w, 46, '#6f6f6f');
    hc.fillStyle = '#b4b4b4';
    hc.fillRect(front - 6, h * 0.18, 12, h * 0.62);      // the zip
    hc.fillStyle = '#6a6a6a';
    hc.fillRect(front - 96, h * 0.3, 78, 54);            // the pocket, recessed
    for (const u of [0.25, 0.5, 0.75]) stitch(hc, w * u, 0, w * u, h, { colour: '#5c5c5c', width: 3 });
    stitch(hc, 0, h * 0.4, w, h * 0.4, { colour: '#5c5c5c', width: 3 });
  });
}

function paintSleeve(ctx, w, h, rng, height) {
  // V runs shoulder (top) to cuff (bottom).
  ctx.fillStyle = C.shell;
  ctx.fillRect(0, 0, w, h);
  weave(ctx, w, h, rng);

  const shoulder = ctx.createLinearGradient(0, 0, 0, h * 0.3);
  shoulder.addColorStop(0, C.shellDark);
  shoulder.addColorStop(1, 'rgba(201,84,26,0)');
  ctx.fillStyle = shoulder;
  ctx.fillRect(0, 0, w, h * 0.3);

  // Forearm in the darker shell, elbow patch, knitted cuff.
  ctx.fillStyle = C.shellDeep;
  ctx.fillRect(0, h * 0.62, w, h * 0.28);
  ctx.fillStyle = C.trimLight;
  ctx.fillRect(w * 0.1, h * 0.5, w * 0.35, h * 0.14);
  ribbing(ctx, 0, h * 0.9, w, h * 0.1, C.trim);
  stitch(ctx, 0, h * 0.62, w, h * 0.62, { colour: 'rgba(0,0,0,0.35)' });
  stitch(ctx, w * 0.5, 0, w * 0.5, h, { colour: 'rgba(0,0,0,0.25)' });

  inRegion(height, REGION.sleeve, (hc) => {
    hc.fillStyle = '#808080';
    hc.fillRect(0, 0, w, h);
    hc.fillStyle = '#9b9b9b';
    hc.fillRect(w * 0.1, h * 0.5, w * 0.35, h * 0.14);
    ribbing(hc, 0, h * 0.9, w, h * 0.1, '#6e6e6e');
    stitch(hc, 0, h * 0.62, w, h * 0.62, { colour: '#5a5a5a', width: 3 });
    stitch(hc, w * 0.5, 0, w * 0.5, h, { colour: '#5a5a5a', width: 3 });
  });
}

function paintPants(ctx, w, h, rng, height) {
  ctx.fillStyle = C.pants;
  ctx.fillRect(0, 0, w, h);
  weave(ctx, w, h, rng, { step: 3 });

  // Reinforced knee panel and a cuff gaiter over the boot.
  ctx.fillStyle = C.pantsDark;
  ctx.fillRect(0, h * 0.46, w, h * 0.16);
  ctx.fillStyle = C.trim;
  ctx.fillRect(0, h * 0.88, w, h * 0.12);
  stitch(ctx, 0, h * 0.46, w, h * 0.46, { colour: 'rgba(255,255,255,0.14)' });
  stitch(ctx, 0, h * 0.62, w, h * 0.62, { colour: 'rgba(255,255,255,0.14)' });
  // Side seam and a thigh pocket.
  stitch(ctx, w * 0.25, 0, w * 0.25, h, { colour: 'rgba(0,0,0,0.3)' });
  ctx.fillStyle = C.pantsDark;
  ctx.fillRect(w * 0.32, h * 0.22, 56, 44);

  inRegion(height, REGION.pants, (hc) => {
    hc.fillStyle = '#808080';
    hc.fillRect(0, 0, w, h);
    hc.fillStyle = '#9d9d9d';
    hc.fillRect(0, h * 0.46, w, h * 0.16);
    ribbing(hc, 0, h * 0.88, w, h * 0.12, '#707070', 12);
    for (const u of [0.25, 0.75]) stitch(hc, w * u, 0, w * u, h, { colour: '#5c5c5c', width: 3 });
  });
}

/**
 * The head.
 *
 * Mapped from a sphere, so U wraps and V runs chin to crown. Only the band of
 * V between the goggles and the chin is ever visible — the beanie covers the
 * top and the goggles cover the eyes — so this paints a jaw, a mouth and some
 * shading and leaves it there.
 */
function paintHead(ctx, w, h, rng, height) {
  ctx.fillStyle = C.skin;
  ctx.fillRect(0, 0, w, h);

  // Sphere UVs put U=0.25 at the face for the orientation this head is built
  // with. Everything below is measured from there.
  const face = w * 0.25;
  // Soft shading down the sides of the face and under the jaw.
  const side = ctx.createLinearGradient(0, 0, w, 0);
  side.addColorStop(0, 'rgba(0,0,0,0.16)');
  side.addColorStop(0.25, 'rgba(0,0,0,0)');
  side.addColorStop(0.5, 'rgba(0,0,0,0.16)');
  side.addColorStop(1, 'rgba(0,0,0,0.16)');
  ctx.fillStyle = side;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  ctx.fillRect(0, h * 0.8, w, h * 0.2);

  // A neck gaiter pulled up under the chin. It has to stay *low*: the goggles
  // already take the middle of the face and the beanie takes the top, and if
  // the gaiter creeps up to meet them the head renders as one dark blob with
  // no face in it at all — which is how the first version came out.
  // Mid-slate rather than the jacket's near-black trim: it wraps the whole
  // underside of the head, so from behind and above it is most of what you
  // see, and in black it reads as a hole where the neck should be.
  ctx.fillStyle = C.trimLight;
  ctx.fillRect(0, h * 0.78, w, h * 0.22);
  ribbing(ctx, 0, h * 0.78, w, h * 0.07, C.trim, 11);

  // Cheeks and a chin, in the band the goggles and the gaiter leave.
  ctx.fillStyle = 'rgba(206,116,88,0.4)';
  ctx.fillRect(face - 62, h * 0.6, 44, 40);
  ctx.fillRect(face + 18, h * 0.6, 44, 40);
  ctx.fillStyle = 'rgba(120,60,45,0.35)';
  ctx.fillRect(face - 22, h * 0.72, 44, 9);            // mouth

  // Eyebrows, just visible above the goggle frame in a big grab.
  ctx.fillStyle = '#4a3527';
  ctx.fillRect(face - 42, h * 0.36, 32, 8);
  ctx.fillRect(face + 12, h * 0.36, 32, 8);

  inRegion(height, REGION.head, (hc) => {
    hc.fillStyle = '#808080';
    hc.fillRect(0, 0, w, h);
    ribbing(hc, 0, h * 0.78, w, h * 0.22, '#8e8e8e', 11);
  });
}

function paintMitten(ctx, w, h, rng, height) {
  ctx.fillStyle = C.mitten;
  ctx.fillRect(0, 0, w, h);
  weave(ctx, w, h, rng, { step: 5, dark: 'rgba(0,0,0,0.12)', light: 'rgba(255,255,255,0.06)' });
  ribbing(ctx, 0, 0, w, h * 0.22, C.trimLight, 10);   // gauntlet cuff
  ctx.fillStyle = C.shell;
  ctx.fillRect(w * 0.2, h * 0.5, w * 0.6, 16);         // a flash of the jacket orange
  stitch(ctx, 0, h * 0.72, w, h * 0.72, { colour: 'rgba(255,255,255,0.16)' });

  inRegion(height, REGION.mitten, (hc) => {
    hc.fillStyle = '#808080';
    hc.fillRect(0, 0, w, h);
    ribbing(hc, 0, 0, w, h * 0.22, '#6c6c6c', 10);
    stitch(hc, 0, h * 0.72, w, h * 0.72, { colour: '#5e5e5e', width: 3 });
  });
}

function paintBeanie(ctx, w, h, rng, height) {
  ctx.fillStyle = C.beanie;
  ctx.fillRect(0, 0, w, h);
  // Knitted V-stitch: two crossed hatches at a coarse pitch reads as knit at
  // any distance the camera ever gets to.
  ctx.strokeStyle = 'rgba(0,0,0,0.2)';
  ctx.lineWidth = 4;
  for (let i = -h; i < w; i += 18) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + h, h);
    ctx.moveTo(i + h, 0);
    ctx.lineTo(i, h);
    ctx.stroke();
  }
  ctx.fillStyle = C.beanieDark;
  ctx.fillRect(0, h * 0.66, w, h * 0.12);
  ribbing(ctx, 0, h * 0.78, w, h * 0.22, C.beanieDark, 13);   // turned-up brim

  inRegion(height, REGION.beanie, (hc) => {
    hc.fillStyle = '#787878';
    hc.fillRect(0, 0, w, h);
    hc.strokeStyle = '#9c9c9c';
    hc.lineWidth = 5;
    for (let i = -h; i < w; i += 18) {
      hc.beginPath();
      hc.moveTo(i, 0);
      hc.lineTo(i + h, h);
      hc.moveTo(i + h, 0);
      hc.lineTo(i, h);
      hc.stroke();
    }
    ribbing(hc, 0, h * 0.78, w, h * 0.22, '#8c8c8c', 13);
  });
}

function paintBoot(ctx, w, h, rng, height) {
  ctx.fillStyle = C.boot;
  ctx.fillRect(0, 0, w, h);
  weave(ctx, w, h, rng, { step: 6, dark: 'rgba(0,0,0,0.2)', light: 'rgba(255,255,255,0.04)' });
  ctx.fillStyle = C.trimLight;
  ctx.fillRect(0, h * 0.1, w, 18);
  ctx.fillStyle = C.shell;
  ctx.fillRect(w * 0.36, h * 0.2, 28, 28);      // lace ratchet, in the jacket orange
  for (let y = h * 0.3; y < h * 0.8; y += 34) {
    stitch(ctx, w * 0.2, y, w * 0.8, y, { colour: 'rgba(255,255,255,0.13)', dash: [10, 8], width: 4 });
  }

  inRegion(height, REGION.boot, (hc) => {
    hc.fillStyle = '#808080';
    hc.fillRect(0, 0, w, h);
    for (let y = h * 0.3; y < h * 0.8; y += 34) {
      stitch(hc, w * 0.2, y, w * 0.8, y, { colour: '#a2a2a2', dash: [10, 8], width: 5 });
    }
  });
}

function paintStrap(ctx, w, h, rng, height) {
  ctx.fillStyle = C.trimLight;
  ctx.fillRect(0, 0, w, h);
  weave(ctx, w, h, rng, { step: 5 });
  for (let y = 0; y < h; y += 26) {
    stitch(ctx, 0, y, w, y, { colour: 'rgba(0,0,0,0.3)', dash: [12, 10], width: 5 });
  }
  inRegion(height, REGION.strap, (hc) => {
    hc.fillStyle = '#808080';
    hc.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 26) {
      stitch(hc, 0, y, w, y, { colour: '#606060', width: 5 });
    }
  });
}

/* ------------------------------------------------------------------
 * Height -> normal
 * ---------------------------------------------------------------- */

/**
 * Sobel over the height canvas.
 *
 * Cheaper and far more controllable than trying to model stitching as
 * geometry: the seams and knit only ever need to *catch light*, and a normal
 * map does that for the cost of one pass over a canvas at start-up.
 */
function heightToNormal(height, strength = 2.6) {
  // Run at half resolution. Nine samples per pixel over a megapixel is nearly
  // ten million array reads on the main thread, and the difference is invisible
  // — a normal map for stitching and knit has nothing in it that needs a pixel
  // per texel, and the GPU filters it back up for free.
  const N = SIZE / 2;
  const small = document.createElement('canvas');
  small.width = small.height = N;
  const sctx = small.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(height.el, 0, 0, N, N);

  const src = sctx.getImageData(0, 0, N, N).data;
  const out = new ImageData(N, N);
  const d = out.data;
  const at = (x, y) => src[((y & (N - 1)) * N + (x & (N - 1))) * 4] / 255;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx =
        at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1) -
        at(x + 1, y - 1) - 2 * at(x + 1, y) - at(x + 1, y + 1);
      const dy =
        at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1) -
        at(x - 1, y + 1) - 2 * at(x, y + 1) - at(x + 1, y + 1);

      let nx = dx * strength;
      let ny = dy * strength;
      const len = Math.hypot(nx, ny, 1);
      const i = (y * N + x) * 4;
      d[i] = ((nx / len) * 0.5 + 0.5) * 255;
      d[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      d[i + 2] = (1 / len) * 255;
      d[i + 3] = 255;
    }
  }

  const el = document.createElement('canvas');
  el.width = el.height = N;
  el.getContext('2d').putImageData(out, 0, 0);
  return el;
}

/* ------------------------------------------------------------------
 * Assembly
 * ---------------------------------------------------------------- */

/** One baked atlas per character id. A character never changes mid-page. */
const cache = new Map();

/**
 * Paints the atlas once and hands back the three maps.
 *
 * Cached, because the textures are the same every run — the rider does not
 * change with the seed, and repainting a megapixel three times on every
 * restart is a visible stall.
 */
export function riderTextures(characterId = DEFAULT_CHARACTER) {
  const character = characterById(characterId);
  const hit = cache.get(character.id);
  if (hit) return hit;

  C = character.palette;

  // The same seed for every character, deliberately: the weave, the stitching
  // and the blotching should be the *same* garment in a different colour, not
  // a different garment. A per-character seed made the fox's jacket a subtly
  // different fabric from the rider's for no reason anybody could name.
  const rng = makeRng(91117);
  const colour = canvas('#000000');
  const height = canvas('#808080', true);
  const rough = canvas('#b4b4b4');

  const parts = [
    [REGION.torso, paintTorso, 0.78],
    [REGION.sleeve, paintSleeve, 0.78],
    [REGION.pants, paintPants, 0.86],
    [REGION.head, paintHead, 0.7],
    [REGION.mitten, paintMitten, 0.82],
    [REGION.beanie, paintBeanie, 0.94],
    [REGION.boot, paintBoot, 0.55],
    [REGION.strap, paintStrap, 0.72],
  ];

  for (const [region, paint, roughness] of parts) {
    inRegion(colour.ctx, region, (ctx, w, h) => paint(ctx, w, h, rng, height.ctx));
    // Roughness is flat per garment: the variation that matters visually comes
    // from the normal map, and a per-pixel roughness map on top of it mostly
    // reads as noise.
    rough.ctx.fillStyle = `rgb(${Math.round(roughness * 255)},${Math.round(roughness * 255)},${Math.round(roughness * 255)})`;
    rough.ctx.fillRect(region.x, region.y, region.w, region.h);
  }

  const map = new THREE.CanvasTexture(colour.el);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;

  const normalMap = new THREE.CanvasTexture(heightToNormal(height));
  const roughnessMap = new THREE.CanvasTexture(rough.el);

  for (const t of [map, normalMap, roughnessMap]) {
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
  }

  const maps = { map, normalMap, roughnessMap };
  cache.set(character.id, maps);
  return maps;
}
