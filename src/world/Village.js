import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeRng } from '../core/mathx.js';

/**
 * The village at the bottom of the run: a cluster of timber chalets with deep
 * snow on their roofs, gathered around a small church with a steeple.
 *
 * Everything is built from a handful of primitives and merged into two meshes
 * — one lit, one unlit for the warm window glow — so the whole village costs
 * two draw calls.
 */

const PALETTE = {
  timber: ['#8a5b3a', '#7a4e33', '#95643f', '#6d4530'],
  plaster: ['#e9dcc6', '#dfd0b8'],
  roof: '#4a3324',
  stone: '#6f6a63',
  snow: '#fbfdff',
  snowShade: '#dfeaf6',
  glow: '#ffd489',
};

/* ------------------------------------------------------------------
 * Primitive helpers — each returns a coloured, transform-baked geometry
 * ---------------------------------------------------------------- */

/**
 * Applies a flat colour and normalises the geometry for merging. The roofs and
 * spires are authored as raw triangle soup while the boxes come out of three.js
 * indexed, and `mergeGeometries` refuses to mix the two — so everything is
 * de-indexed here. Flat shading wants the split vertices anyway.
 */
function tint(geometry, color) {
  const geo = geometry.index ? geometry.toNonIndexed() : geometry;
  geo.deleteAttribute('uv');
  const c = new THREE.Color(color);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function box(w, h, d, color, x = 0, y = 0, z = 0) {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(x, y + h * 0.5, z);
  return tint(geo, color);
}

/** A gable roof: two slopes meeting at a ridge running along Z. */
function gable(w, d, h, color) {
  const hw = w * 0.5;
  const hd = d * 0.5;
  const v = [];
  const quad = (a, b, c, e) => v.push(...a, ...b, ...c, ...a, ...c, ...e);

  quad([-hw, 0, -hd], [-hw, 0, hd], [0, h, hd], [0, h, -hd]); // left slope
  quad([hw, 0, hd], [hw, 0, -hd], [0, h, -hd], [0, h, hd]);   // right slope
  v.push(-hw, 0, hd, hw, 0, hd, 0, h, hd);                     // front gable
  v.push(hw, 0, -hd, -hw, 0, -hd, 0, h, -hd);                  // back gable

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  geo.computeVertexNormals();
  return tint(geo, color);
}

/** A four-sided spire. */
function pyramid(w, h, color) {
  const hw = w * 0.5;
  const c = [
    [-hw, 0, -hw],
    [hw, 0, -hw],
    [hw, 0, hw],
    [-hw, 0, hw],
  ];
  const v = [];
  for (let i = 0; i < 4; i++) {
    const a = c[i];
    const b = c[(i + 1) % 4];
    v.push(...a, ...b, 0, h, 0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  geo.computeVertexNormals();
  return tint(geo, color);
}

/* ------------------------------------------------------------------
 * Buildings
 * ---------------------------------------------------------------- */

function buildChalet(rng, solid, glow) {
  const w = 6 + rng() * 3.5;
  const d = 5 + rng() * 3;
  const wallH = 3.2 + rng() * 1.9;
  const roofH = 2.1 + rng() * 1.1;
  const wallColor = rng() < 0.72 ? rng.pick(PALETTE.timber) : rng.pick(PALETTE.plaster);

  // Stone footing, then the timber storey.
  solid.push(box(w * 1.04, 0.6, d * 1.04, PALETTE.stone, 0, -0.15, 0));
  solid.push(box(w, wallH, d, wallColor, 0, 0.45, 0));

  // A darker band under the eaves reads as the balcony rail.
  solid.push(box(w * 1.12, 0.34, d * 1.12, '#4f3728', 0, wallH * 0.62, 0));

  // Roof with generous eaves, and deep snow lying on the top 78% of it.
  const rw = w * 1.28;
  const rd = d * 1.22;
  const roof = gable(rw, rd, roofH, PALETTE.roof);
  roof.translate(0, wallH + 0.45, 0);
  solid.push(roof);

  const snow = gable(rw * 0.78 + 0.12, rd * 1.02, roofH * 0.78, PALETTE.snow);
  snow.translate(0, wallH + 0.45 + roofH * 0.22 + 0.05, 0);
  solid.push(snow);

  // Chimney with its own little cap of snow.
  const cx = w * (rng() < 0.5 ? -0.24 : 0.24);
  solid.push(box(0.7, roofH + 1.5, 0.7, '#5c5049', cx, wallH + 0.45, d * 0.18));
  solid.push(box(0.86, 0.24, 0.86, PALETTE.snow, cx, wallH + roofH + 1.95, d * 0.18));

  // Warm windows facing downhill.
  const rows = wallH > 4 ? 2 : 1;
  for (let r = 0; r < rows; r++) {
    const count = 2 + (rng() < 0.4 ? 1 : 0);
    for (let i = 0; i < count; i++) {
      const px = (i - (count - 1) / 2) * (w / (count + 0.6));
      const py = 1.1 + r * 1.7;
      glow.push(box(0.85, 1.05, 0.12, PALETTE.glow, px, py, d * 0.5 + 0.02));
      solid.push(box(1.05, 1.25, 0.1, '#3d2b1f', px, py - 0.1, d * 0.5 - 0.01));
    }
  }

  return Math.max(w, d) * 0.62;
}

function buildChurch(solid, glow) {
  const w = 8;
  const d = 15;
  const wallH = 6.5;

  solid.push(box(w * 1.05, 0.7, d * 1.05, PALETTE.stone, 0, -0.2, 0));
  solid.push(box(w, wallH, d, '#e6dac4', 0, 0.4, 0));

  const roof = gable(w * 1.2, d * 1.05, 3.2, PALETTE.roof);
  roof.translate(0, wallH + 0.4, 0);
  solid.push(roof);
  const snow = gable(w * 1.2 * 0.78 + 0.12, d * 1.07, 3.2 * 0.78, PALETTE.snow);
  snow.translate(0, wallH + 0.4 + 3.2 * 0.22 + 0.05, 0);
  solid.push(snow);

  // Bell tower at the downhill end.
  const tw = 4.2;
  const towerH = 15;
  const tz = d * 0.5 + tw * 0.35;
  solid.push(box(tw, towerH, tw, '#eadfca', 0, 0.4, tz));
  solid.push(box(tw * 1.14, 0.4, tw * 1.14, '#cdbfa6', 0, towerH * 0.78, tz));

  // Belfry openings.
  for (const [ox, oz] of [
    [0, tw * 0.5 + 0.02],
    [tw * 0.5 + 0.02, 0],
    [-tw * 0.5 - 0.02, 0],
  ]) {
    const g = box(oz === 0 ? 0.12 : 1.1, 1.9, oz === 0 ? 1.1 : 0.12, '#2c2419', ox, towerH * 0.5, tz + oz);
    solid.push(g);
  }

  // Steeple, snow-capped, with a cross on top.
  const spireH = 8.5;
  const spire = pyramid(tw * 1.12, spireH, '#3f5a6d');
  spire.translate(0, towerH + 0.8, tz);
  solid.push(spire);
  const spireSnow = pyramid(tw * 1.12 * 0.5, spireH * 0.5, PALETTE.snow);
  spireSnow.translate(0, towerH + 0.8 + spireH * 0.5, tz);
  solid.push(spireSnow);

  solid.push(box(0.18, 1.5, 0.18, '#2f2a24', 0, towerH + 0.8 + spireH, tz));
  solid.push(box(0.9, 0.18, 0.18, '#2f2a24', 0, towerH + 1.8 + spireH, tz));

  glow.push(box(1.3, 2.4, 0.12, PALETTE.glow, 0, 2.2, d * 0.5 + 0.02));

  return Math.max(w, d) * 0.7;
}

/* ------------------------------------------------------------------
 * Assembly
 * ---------------------------------------------------------------- */

export function buildVillage(course, seed = 4242) {
  const rng = makeRng(seed);
  const solid = [];
  const glow = [];
  const footprints = [];

  const place = (parts, x, z, yaw) => {
    const y = course.terrainHeight(x, z);
    const m = new THREE.Matrix4()
      .makeRotationY(yaw)
      .premultiply(new THREE.Matrix4().makeTranslation(x, y, z));
    for (const g of parts) g.applyMatrix4(m);
  };

  const addBuilding = (builder, x, z, yaw) => {
    const s = [];
    const g = [];
    const radius = builder(s, g);
    place(s, x, z, yaw);
    place(g, x, z, yaw);
    solid.push(...s);
    glow.push(...g);
    footprints.push({ x, z, r: radius });
  };

  // The church anchors the square, set a little off the fall line.
  addBuilding((s, g) => buildChurch(s, g), course.centerX(3080) - 26, 3080, -0.22);

  // Chalets clustered around it, kept clear of the runout so the rider coasts in.
  const spots = [];
  for (let i = 0; i < 26; i++) {
    const z = 2960 + rng() * 300;
    const side = rng() < 0.5 ? -1 : 1;
    const x = course.centerX(z) + side * (16 + rng() * 46);
    spots.push({ x, z, yaw: rng.spread(0.5) + (side < 0 ? 0.25 : -0.25) });
  }

  for (const s of spots) {
    // Reject anything overlapping an existing building.
    if (footprints.some((f) => Math.hypot(f.x - s.x, f.z - s.z) < f.r + 7.5)) continue;
    addBuilding((sol, gl) => buildChalet(rng, sol, gl), s.x, s.z, s.yaw);
  }

  const group = new THREE.Group();
  group.name = 'village';

  const solidMesh = new THREE.Mesh(
    mergeGeometries(solid, false),
    new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0 })
  );
  solidMesh.castShadow = true;
  solidMesh.receiveShadow = true;
  group.add(solidMesh);

  const glowMesh = new THREE.Mesh(
    mergeGeometries(glow, false),
    new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false })
  );
  group.add(glowMesh);

  group.add(buildFinishGate(course));

  /** Used to keep the forest from growing through the village. */
  const exclude = (x, z) =>
    footprints.some((f) => Math.hypot(f.x - x, f.z - z) < f.r + 5.5);

  return { group, exclude, footprints };
}

/* ------------------------------------------------------------------
 * Finish gate
 * ---------------------------------------------------------------- */

function buildFinishGate(course) {
  const z = course.finishZ;
  const cx = course.centerX(z);
  const group = new THREE.Group();
  group.name = 'finish-gate';

  const span = 30;
  const postH = 6.2;
  const parts = [];
  for (const side of [-1, 1]) {
    const px = cx + side * span * 0.5;
    const py = course.terrainHeight(px, z);
    const post = box(0.6, postH, 0.6, '#3f2d20', px, 0, z);
    post.translate(0, py, 0);
    parts.push(post);
  }
  const beamY = course.terrainHeight(cx, z) + postH;
  const beam = box(span + 1.2, 0.5, 0.6, '#3f2d20', cx, 0, z);
  beam.translate(0, beamY - 0.5, 0);
  parts.push(beam);

  const frame = new THREE.Mesh(
    mergeGeometries(parts, false),
    new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 })
  );
  frame.castShadow = true;
  group.add(frame);

  // Banner
  const banner = new THREE.Mesh(
    new THREE.PlaneGeometry(span, 2.6),
    new THREE.MeshBasicMaterial({ map: makeBannerTexture(), transparent: true, side: THREE.DoubleSide, toneMapped: false })
  );
  banner.position.set(cx, beamY - 1.9, z);
  banner.rotation.y = Math.PI;
  group.add(banner);

  return group;
}

function makeBannerTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#f5f8fb';
  ctx.fillRect(0, 0, 1024, 128);
  ctx.fillStyle = '#e2483c';
  for (let i = 0; i < 1024; i += 128) ctx.fillRect(i, 0, 64, 14);
  for (let i = 64; i < 1024; i += 128) ctx.fillRect(i, 114, 64, 14);

  ctx.fillStyle = '#152c40';
  ctx.font = '700 62px "Avenir Next", "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.letterSpacing = '18px';
  ctx.fillText('FINISH', 512, 68);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}
