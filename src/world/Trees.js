import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { COURSE } from './Course.js';
import { clamp } from '../core/mathx.js';

/**
 * Snow-laden alpine pines.
 *
 * These are not green trees with white trim. They are snow — thick, lumpy
 * masses of it lying over every whorl of branches — with the green surviving
 * only as a dark fringe under each tier and in the notches between the lumps.
 * Getting that ratio right is most of what makes a winter treeline read.
 *
 * Each tree is a stack of faceted green cones, each covered by a scalloped
 * white "drape" that is deliberately blunter than the whorl beneath it (see
 * `buildPineGeometry`). A handful of variants are built once and drawn with
 * instancing, so a couple of thousand trees cost a few draw calls.
 */

const TRUNK_COLOR = new THREE.Color('#5a4433');
const SNOW_COLOR = new THREE.Color('#fafdff');
const SNOW_SHADE = new THREE.Color('#dceaf7');

/** Length of one frustum-cullable slice of forest, in metres. */
const FOREST_CHUNK = 150;

const VARIANTS = [
  { tiers: 3, radius: 1.95, height: 5.6, sides: 8, green: '#2f6351', taper: 0.7 },
  { tiers: 4, radius: 1.7, height: 6.8, sides: 8, green: '#285848', taper: 0.75 },
  { tiers: 3, radius: 2.2, height: 4.9, sides: 9, green: '#376e57', taper: 0.66 },
  { tiers: 4, radius: 1.5, height: 7.6, sides: 7, green: '#245043', taper: 0.78 },
];

/**
 * A lumpy white cone: the snow lying over one whorl of branches.
 *
 * The base ring alternates between the full radius and a pulled-in radius, and
 * every other vertex dips below the rest. That scalloping is the whole trick —
 * it lets the green branches show through as a ragged fringe around the bottom
 * of each tier and in the notches between the lobes, instead of the snow
 * reading as a clean white band painted round the tree.
 */
function snowDrapeGeometry(radius, height, sides) {
  const pos = [];
  const ring = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const lobe = i % 2 === 0;
    const r = radius * (lobe ? 1 : 0.88);
    ring.push([Math.cos(a) * r, lobe ? 0 : radius * 0.16, Math.sin(a) * r]);
  }
  // Wound b-then-a so the faces point outward. The other way round they are
  // all back-facing, get culled, and the tree renders as a bare green cone.
  for (let i = 0; i < sides; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % sides];
    pos.push(...b, ...a, 0, height, 0);
  }
  // Cap the underside so the drape is solid when a tree is seen from below.
  for (let i = 1; i < sides - 1; i++) {
    pos.push(...ring[0], ...ring[i + 1], ...ring[i]);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

/** Builds the merged geometry for a single pine, centred on its trunk base. */
function buildPineGeometry(v) {
  const parts = [];
  const m = new THREE.Matrix4();

  // Cones and cylinders are centred on their own origin; `baseY` is where we
  // want the *bottom* of the part to sit, which is friendlier to reason about.
  // (The snow drapes already sit on their own base, so they pass height 0.)
  //
  // Everything is de-indexed on the way in: the cones come out of three.js
  // indexed and the hand-built drapes are raw triangle soup, and mergeGeometries
  // refuses to mix the two. Flat shading wants the split vertices regardless.
  const add = (geometry, color, baseY, height) => {
    const geo = geometry.index ? geometry.toNonIndexed() : geometry;
    geo.deleteAttribute('uv');
    m.makeTranslation(0, baseY + height * 0.5, 0);
    geo.applyMatrix4(m);
    const n = geo.attributes.position.count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    parts.push(geo);
  };

  const green = new THREE.Color(v.green);
  const trunkH = v.height * 0.22;

  // Trunk
  add(
    new THREE.CylinderGeometry(v.radius * 0.11, v.radius * 0.16, trunkH, 6, 1),
    TRUNK_COLOR,
    0,
    trunkH
  );

  // A drift banked up around the base — hides the seam with the slope.
  const moundH = v.radius * 0.4;
  add(snowDrapeGeometry(v.radius * 0.82, moundH, v.sides), SNOW_COLOR, -0.1, 0);

  // Foliage tiers. These trees are *laden*: the snow covers nearly the whole
  // whorl and the green survives only as a ragged fringe around the bottom of
  // each tier and in the notches between the drape's lobes.
  const canopyBase = trunkH * 0.72;
  const canopyH = v.height - canopyBase;
  const overlap = 0.42; // tiers overlap so no trunk shows between them
  const tierH = canopyH / (1 + (v.tiers - 1) * (1 - overlap));

  for (let i = 0; i < v.tiers; i++) {
    const t = i / Math.max(1, v.tiers - 1);
    const r = v.radius * (1 - t * v.taper);
    const h = tierH * (1 - t * 0.18);
    const y = canopyBase + i * tierH * (1 - overlap);

    // The green branch whorl.
    add(new THREE.ConeGeometry(r, h, v.sides, 1), green.clone().multiplyScalar(0.9 + 0.2 * t), y, h);

    // The snow lying on it.
    //
    // The drape has to be *blunter* than the whorl it covers, not merely
    // bigger: a cone sharing the whorl's taper is uniformly scaled against it,
    // so it either buries the tree completely or — a few per cent the other way
    // — disappears inside it and the tree renders bare. Starting a little up
    // the whorl and running 1.35x its remaining height makes the drape shrink
    // more slowly, so it stands proud through the middle of the tier and piles
    // up over the apex, while the green survives as a fringe at the bottom rim
    // and in the notches between the drape's lobes. These trees are laden:
    // the snow is most of what you see, and the green is the accent.
    const foot = 0.1;
    const snowR = r * (1 - foot) * 1.04;
    const snowH = h * (1 - foot) * 1.3;
    add(
      snowDrapeGeometry(snowR, snowH, v.sides),
      i === v.tiers - 1 ? SNOW_COLOR : SNOW_COLOR.clone().lerp(SNOW_SHADE, 0.18 * (1 - t)),
      y + h * foot,
      0
    );
  }

  const merged = mergeGeometries(parts, false);
  merged.computeVertexNormals();
  return merged;
}

/**
 * Scatters trees over the slope and returns instanced meshes plus a
 * z-bucketed collider list.
 */
export function buildForest(course, { exclude } = {}) {
  const rng = course.rng;
  const placements = VARIANTS.map(() => []);
  const colliders = [];

  const zFrom = -60;
  const zTo = COURSE.length + 380;

  for (let z = zFrom; z < zTo; z += 2.6) {
    const attempts = 3;
    for (let a = 0; a < attempts; a++) {
      const side = rng() < 0.5 ? -1 : 1;

      // Most trees live in the forest band; a few crowd the edge of the piste.
      let u;
      const roll = rng();
      if (roll < 0.045) {
        u = side * (COURSE.trackHalfWidth + 0.4 + rng() * 3.2); // encroaching
      } else if (roll < 0.6) {
        u = side * (COURSE.trackHalfWidth + 4 + rng() * 26);
      } else if (roll < 0.86) {
        u = side * (COURSE.trackHalfWidth + 22 + rng() * 150);
      } else {
        u = side * (200 + rng() * 230);
      }
      if (Math.abs(u) > 440) continue;

      // Thin the far field out so the near band stays the visual anchor.
      const density = 1 - clamp((Math.abs(u) - 30) / 190, 0, 1) * 0.55;
      if (Math.abs(u) > COURSE.halfWidth - 6 && rng() > 0.8) continue;
      if (rng() > density * 0.62) continue;

      const zj = z + rng.spread(1.3);
      const cx = course.centerX(zj);
      const tan = course.trackTangent(zj);
      const x = cx + u * tan.z;
      const zw = zj - u * tan.x;

      if (course.onKicker(x, zw, 4)) continue;
      if (exclude && exclude(x, zw)) continue;

      // Thin the forest right out around the village so the chalets and the
      // church steeple are actually visible on the run in to the finish.
      if (zj > 2820 && Math.abs(u) < 70 && rng() > 0.16) continue;

      const vi = rng.int(0, VARIANTS.length - 1);
      const scale = 0.62 + rng() * 0.95;
      const y = course.terrainHeight(x, zw);

      placements[vi].push({ x, y, z: zw, scale, yaw: rng() * Math.PI * 2, tint: 0.9 + rng() * 0.18 });
      // The far band is scenery for the mid-ground only — the rider is out of
      // bounds long before reaching it, so it needs no colliders.
      if (Math.abs(u) < COURSE.halfWidth) {
        colliders.push({ x, z: zw, r: VARIANTS[vi].radius * scale * 0.42 + 0.35 });
      }
    }
  }

  const group = new THREE.Group();
  group.name = 'forest';
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.85,
    metalness: 0,
  });

  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();

  VARIANTS.forEach((v, i) => {
    if (!placements[i].length) return;
    const geo = buildPineGeometry(v);

    // Instances are grouped into slices along the course. A single instanced
    // mesh spanning three kilometres can only ever be all-in or all-out of the
    // frustum, so it would draw every tree on the mountain every frame.
    const chunks = new Map();
    for (const p of placements[i]) {
      const key = Math.floor(p.z / FOREST_CHUNK);
      if (!chunks.has(key)) chunks.set(key, []);
      chunks.get(key).push(p);
    }

    for (const list of chunks.values()) {
      const mesh = new THREE.InstancedMesh(geo, material, list.length);
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      list.forEach((p, k) => {
        dummy.position.set(p.x, p.y - 0.15, p.z);
        dummy.rotation.set(0, p.yaw, 0);
        dummy.scale.setScalar(p.scale);
        dummy.updateMatrix();
        mesh.setMatrixAt(k, dummy.matrix);
        tint.setScalar(p.tint);
        mesh.setColorAt(k, tint);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
  });

  return { group, colliders: bucketColliders(colliders) };
}

/** Buckets colliders by z so the rider only tests a handful per frame. */
export function bucketColliders(list, size = 12) {
  const buckets = new Map();
  for (const c of list) {
    const b = Math.floor(c.z / size);
    for (let k = b - 1; k <= b + 1; k++) {
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(c);
    }
  }
  return {
    size,
    query(z) {
      return buckets.get(Math.floor(z / size)) ?? [];
    },
  };
}
