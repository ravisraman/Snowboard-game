import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { COURSE } from './Course.js';
import { makeRng, clamp } from '../core/mathx.js';

/**
 * The furniture that makes a slope read as a *resort* rather than as a hill
 * with snow on it: marker poles down both edges of the piste, safety netting on
 * the outside of the sharpest bends, a chairlift running the length of the run
 * with chairs moving on it, and rock outcrops out in the far field.
 *
 * The poles are the ones that do gameplay work as well as scenery. The line
 * where corduroy becomes powder is a shader gradient and, at speed, genuinely
 * hard to read; a row of poles turns it into something you can see coming.
 *
 * Everything static is merged and chunked along the course so the renderer can
 * cull it, which is the same treatment the forest and the slope already get.
 * The chairs are the only moving part, and they are one InstancedMesh.
 */

const PALETTE = {
  pole: '#2b3440',
  poleTip: '#ff7a34',
  net: '#ff8a3d',
  netPost: '#39424f',
  steel: '#5d666f',
  steelDark: '#434b55',
  cable: '#2f363f',
  chair: '#c8562c',
  rock: '#6d6f75',
  rockShade: '#54565c',
  rockSnow: '#f4f9fe',
};

/** Chunk length for the merged static furniture, in metres. */
const CHUNK = 300;

/* ------------------------------------------------------------------
 * Geometry helpers
 * ---------------------------------------------------------------- */

/**
 * Flat colour, de-indexed. `mergeGeometries` refuses to mix indexed and
 * non-indexed inputs, and three's primitives disagree with hand-built triangle
 * soup about which they are — so everything is normalised here.
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

function box(w, h, d, color, x, y, z) {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(x, y + h * 0.5, z);
  return tint(geo, color);
}

function post(radius, height, color, x, y, z, sides = 6) {
  const geo = new THREE.CylinderGeometry(radius * 0.85, radius, height, sides, 1);
  geo.translate(x, y + height * 0.5, z);
  return tint(geo, color);
}

/** Where the piste edge is in world space, and which way is across it. */
function edgePoint(course, z, side, extra = 0) {
  const tan = course.trackTangent(z);
  const px = tan.z;
  const pz = -tan.x;
  // Asked of the course at this z rather than read off the module-level view:
  // the piste widens through a fork, and marker poles that carried on down the
  // base half-width would run straight across the outer lane.
  const u = side * (course.trackHalfWidthAt(z) + extra);
  return { x: course.centerX(z) + px * u, z: z + pz * u, px, pz };
}

/* ------------------------------------------------------------------
 * The pieces
 * ---------------------------------------------------------------- */

/** Slalom-style marker poles down both edges of the groomer. */
function addMarkerPoles(course, bucket, shade) {
  for (let z = 120; z < COURSE.finishZ - 60; z += 32) {
    for (const side of [-1, 1]) {
      const p = edgePoint(course, z, side, 1.2);
      const y = course.terrainHeight(p.x, p.z);
      // Chunky on purpose. A real marker is a slim wand, but slim white-on-white
      // at fifty metres is nothing at all, and these have to be readable at
      // exactly the distance where the piste edge stops being obvious.
      bucket(z, post(0.075, 1.55, PALETTE.pole, p.x, y - 0.1, p.z));
      bucket(z, post(0.085, 0.55, PALETTE.poleTip, p.x, y + 1.4, p.z));
      shade.push({ x: p.x, z: p.z, r: 0.16 });
    }
  }
}

/**
 * A line of poles down the crest of the fork's divider.
 *
 * The ridge itself is a fine shape and a hopeless *sign*. Untracked snow on a
 * groomed piste, viewed from a hundred and fifty metres back at eye level, is
 * white on white nearly edge-on: photographed from the approach, a three-metre
 * divider read as a slight swelling in the corduroy and a four-and-a-half-metre
 * one read as very little more. Height was never going to fix it, because the
 * problem is contrast rather than size — the same conclusion `addMarkerPoles`
 * reached about the piste edge, in the comment a few lines above.
 *
 * So the divider gets marked the way a real resort marks a piste that splits:
 * a row of poles straight down the middle of it, which at distance is a dark
 * dashed line running to a point and is unmistakably a thing to go *around*.
 * They are placed on the crest, which is also where nobody sensible is riding.
 *
 * Poles are furniture, not hazards — `_checkHazards` knows about trees and
 * skiers and nothing else — so a rider who insists on going over the top hits
 * nothing, and the penalty stays what it was: the climb, and the powder.
 */
function addDividerPoles(course, bucket, shade) {
  const f = course.config.fork;
  if (!f || !f.enabled) return;

  for (let z = f.z0; z < f.z3; z += 13) {
    const amount = course.forkAmount(z);
    // Nothing to mark where the ridge has not risen; the poles would just be a
    // line of sticks down the middle of an ordinary piste.
    if (amount * f.maxHeight < 0.35) continue;

    const x = course.centerX(z);
    const y = course.terrainHeight(x, z);
    bucket(z, post(0.075, 1.55, PALETTE.pole, x, y - 0.1, z));
    bucket(z, post(0.085, 0.55, PALETTE.poleTip, x, y + 1.4, z));
    shade.push({ x, z, r: 0.16 });
  }
}

/**
 * Safety netting, on the outside of the bends only.
 *
 * Netting everywhere would be both wrong and expensive — a real piste only
 * fences the places you would actually leave it, which is exactly where the
 * track turns hardest and your speed carries you straight on.
 */
function addNetting(course, bucket) {
  const SPAN = 5;
  let z = 260;
  while (z < COURSE.finishZ - 200) {
    const slope = course.centerSlope(z);
    if (Math.abs(slope) < 0.16) { z += 20; continue; }

    // Outside of the bend: the side the track is turning away from.
    const side = Math.sign(slope) || 1;
    const length = 70;
    for (let s = 0; s < length; s += SPAN) {
      const zz = z + s;
      const a = edgePoint(course, zz, side, 3.4);
      const b = edgePoint(course, zz + SPAN, side, 3.4);
      const ya = course.terrainHeight(a.x, a.z);
      const yb = course.terrainHeight(b.x, b.z);

      bucket(zz, post(0.07, 1.5, PALETTE.netPost, a.x, ya - 0.1, a.z));

      // One quad of net per span, laid between the two posts and sitting a
      // little clear of the snow.
      const v = [];
      const A = [a.x, ya + 0.25, a.z];
      const B = [b.x, yb + 0.25, b.z];
      const C = [b.x, yb + 1.4, b.z];
      const D = [a.x, ya + 1.4, a.z];
      v.push(...A, ...B, ...C, ...A, ...C, ...D);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
      geo.computeVertexNormals();
      bucket(zz, tint(geo, PALETTE.net));
    }
    z += 340;
  }
}

/** A faceted boulder with snow lying on top of it. */
function rockGeometry(rng, radius, height) {
  const sides = rng.int(5, 8);
  const pos = [];
  const ring = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const r = radius * (0.62 + rng() * 0.6);
    ring.push([Math.cos(a) * r, rng.spread(height * 0.12), Math.sin(a) * r]);
  }
  const capY = height * (0.72 + rng() * 0.3);
  const cap = ring.map(([x, , z]) => [x * 0.46, capY, z * 0.46]);

  const parts = [];
  const push = (list, a, b, c) => list.push(...a, ...b, ...c);

  // Flanks, then a snow cap over the top — snow lies on anything flat enough.
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    push(pos, ring[i], ring[j], cap[j]);
    push(pos, ring[i], cap[j], cap[i]);
  }
  const body = new THREE.BufferGeometry();
  body.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  body.computeVertexNormals();
  parts.push(tint(body, rng() < 0.5 ? PALETTE.rock : PALETTE.rockShade));

  const capPos = [];
  for (let i = 1; i < sides - 1; i++) push(capPos, cap[0], cap[i], cap[i + 1]);
  const capGeo = new THREE.BufferGeometry();
  capGeo.setAttribute('position', new THREE.Float32BufferAttribute(capPos, 3));
  capGeo.computeVertexNormals();
  capGeo.translate(0, 0.12, 0);
  parts.push(tint(capGeo, PALETTE.rockSnow));

  return parts;
}

/**
 * Rocks, kept well out in the snowfields. Close to the piste they would be
 * obstacles the physics knows nothing about, which is worse than not having
 * them at all.
 */
function addRocks(course, bucket, rng, density, shade) {
  for (let z = 200; z < COURSE.finishZ - 100; z += 46) {
    if (rng() > density) continue;
    const side = rng() < 0.5 ? -1 : 1;
    const offset = 62 + rng() * 90;
    const p = edgePoint(course, z + rng.spread(20), side, offset);
    const y = course.terrainHeight(p.x, p.z);
    const radius = 1.1 + rng() * 2.4;
    for (const g of rockGeometry(rng, radius, radius * (0.7 + rng() * 0.8))) {
      g.translate(p.x, y - 0.25, p.z);
      bucket(z, g);
    }
    shade.push({ x: p.x, z: p.z, r: radius });
  }
}

/* ------------------------------------------------------------------
 * Chairlift
 * ---------------------------------------------------------------- */

const LIFT_OFFSET = 58;      // metres to skier's left of the track centre
const TOWER_SPACING = 96;
const CABLE_HEIGHT = 9.2;
const CABLE_SAG = 1.9;
const LANE_GAP = 3.4;        // between the up cable and the down cable

/**
 * The line the lift runs on. Deliberately *not* the track's centre line offset
 * — a lift is built straight up the hill and the piste wanders under it, which
 * is what makes the two read as different things.
 */
function liftPoint(course, z) {
  const x = course.centerX(200) + (course.centerX(2600) - course.centerX(200)) * ((z - 200) / 2400) - LIFT_OFFSET;
  return { x, z };
}

function towerHeights(course) {
  const towers = [];
  for (let z = 180; z < COURSE.finishZ - 120; z += TOWER_SPACING) {
    const p = liftPoint(course, z);
    towers.push({ x: p.x, z, y: course.terrainHeight(p.x, z) });
  }
  return towers;
}

/** Cable height at a point between two towers, with a shallow catenary sag. */
function cableY(towers, z) {
  if (z <= towers[0].z) return towers[0].y + CABLE_HEIGHT;
  const last = towers[towers.length - 1];
  if (z >= last.z) return last.y + CABLE_HEIGHT;

  for (let i = 0; i < towers.length - 1; i++) {
    const a = towers[i];
    const b = towers[i + 1];
    if (z > b.z) continue;
    const t = (z - a.z) / (b.z - a.z);
    const straight = (a.y + CABLE_HEIGHT) + ((b.y + CABLE_HEIGHT) - (a.y + CABLE_HEIGHT)) * t;
    return straight - CABLE_SAG * Math.sin(Math.PI * t);
  }
  return last.y + CABLE_HEIGHT;
}

function addLift(course, bucket, towers, shade) {
  for (const t of towers) {
    shade.push({ x: t.x, z: t.z, r: 0.9 });
    // Tapered tower with a crossarm carrying both cables.
    bucket(t.z, post(0.42, CABLE_HEIGHT, PALETTE.steel, t.x, t.y - 0.4, t.z, 8));
    bucket(t.z, box(LANE_GAP + 1.9, 0.34, 0.42, PALETTE.steelDark, t.x, t.y + CABLE_HEIGHT - 0.5, t.z));
    for (const lane of [-1, 1]) {
      bucket(t.z, box(0.5, 0.34, 0.5, PALETTE.steel, t.x + lane * LANE_GAP * 0.5, t.y + CABLE_HEIGHT - 0.72, t.z));
    }
  }

  // Cable: short straight segments following the sag. A tube would be tens of
  // thousands of triangles across two and a half kilometres of mountain.
  const STEP = 12;
  for (let z = towers[0].z; z < towers[towers.length - 1].z; z += STEP) {
    const a = liftPoint(course, z);
    const b = liftPoint(course, z + STEP);
    const ya = cableY(towers, z);
    const yb = cableY(towers, z + STEP);
    for (const lane of [-1, 1]) {
      const x0 = a.x + lane * LANE_GAP * 0.5;
      const x1 = b.x + lane * LANE_GAP * 0.5;
      const v = [];
      const w = 0.07;
      // A thin ribbon rather than a cylinder: seen from below and side-on it is
      // indistinguishable, and it is two triangles instead of thirty.
      v.push(x0 - w, ya, z, x1 - w, yb, z + STEP, x1 + w, yb, z + STEP);
      v.push(x0 - w, ya, z, x1 + w, yb, z + STEP, x0 + w, ya, z);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
      geo.computeVertexNormals();
      bucket(z, tint(geo, PALETTE.cable));
    }
  }
}

/** One chair: a hanger, a seat and a back. */
function chairGeometry() {
  const parts = [
    box(0.09, 1.5, 0.09, PALETTE.steelDark, 0, -1.5, 0),
    box(1.7, 0.13, 0.62, PALETTE.chair, 0, -1.62, 0.06),
    box(1.7, 0.72, 0.12, PALETTE.chair, 0, -1.62, -0.24),
    box(1.75, 0.09, 0.1, PALETTE.steelDark, 0, -0.92, 0.34),
  ];
  return mergeGeometries(parts, false);
}

/* ------------------------------------------------------------------
 * Assembly
 * ---------------------------------------------------------------- */

export function buildResort(course, quality = {}) {
  const rng = makeRng(77123);
  const group = new THREE.Group();
  group.name = 'resort';

  // Everything that stands on the snow and should therefore have shade pooled
  // around its foot. Collected as it is placed and handed to the terrain, which
  // bakes the contact shading — see the occluder pass in `Terrain.js`.
  const occluders = [];

  // Static furniture, bucketed by z so it can be merged into cullable chunks.
  const chunks = new Map();
  const bucket = (z, geo) => {
    const key = Math.floor(z / CHUNK);
    if (!chunks.has(key)) chunks.set(key, []);
    chunks.get(key).push(geo);
  };

  addMarkerPoles(course, bucket, occluders);
  addDividerPoles(course, bucket, occluders);
  addNetting(course, bucket);
  if (quality.rocks !== false) addRocks(course, bucket, rng, quality.rockDensity ?? 1, occluders);

  const towers = towerHeights(course);
  if (quality.chairlift !== false) addLift(course, bucket, towers, occluders);

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.85,
    metalness: 0.05,
    side: THREE.DoubleSide,   // the netting and the cables are single-sided quads
  });

  for (const parts of chunks.values()) {
    const mesh = new THREE.Mesh(mergeGeometries(parts, false), material);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    group.add(mesh);
  }

  /* ---- Chairs ---------------------------------------------------- */

  let chairs = null;
  const CHAIR_SPACING = 58;
  const first = towers[0].z;
  const last = towers[towers.length - 1].z;
  const span = last - first;

  if (quality.chairlift !== false) {
    const count = Math.floor(span / CHAIR_SPACING) * 2;
    chairs = new THREE.InstancedMesh(chairGeometry(), material, count);
    chairs.castShadow = true;
    chairs.frustumCulled = false;
    chairs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(chairs);
  }

  const m = new THREE.Matrix4();
  let travelled = 0;

  /**
   * Chairs run up one cable and down the other. Only the offset along the line
   * changes each frame; the loop rewrites every instance matrix, which for a
   * few dozen chairs is far cheaper than any cleverness would be.
   */
  const update = (dt) => {
    if (!chairs) return;
    travelled = (travelled + dt * 2.6) % CHAIR_SPACING;

    let i = 0;
    for (let s = 0; s < span; s += CHAIR_SPACING) {
      for (const lane of [-1, 1]) {
        // Uphill on one side, downhill on the other.
        const along = lane < 0 ? s + travelled : span - (s + travelled);
        const z = first + clamp(along, 0, span);
        const p = liftPoint(course, z);
        m.makeTranslation(p.x + lane * LANE_GAP * 0.5, cableY(towers, z), z);
        chairs.setMatrixAt(i++, m);
      }
    }
    chairs.instanceMatrix.needsUpdate = true;
  };

  update(0);

  /** Keeps the forest out of the lift line and off the netting. */
  const exclude = (x, z) => {
    const p = liftPoint(course, z);
    return Math.abs(x - p.x) < 7;
  };

  return { group, update, exclude, towers, occluders };
}
