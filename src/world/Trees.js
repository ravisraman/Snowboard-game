import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { COURSE } from './Course.js';
import { clamp } from '../core/mathx.js';

/**
 * Snowy alpine pines.
 *
 * Each tree is a stack of faceted cones. Every green tier gets its own white
 * cap — a second cone sharing the tier's taper but starting part-way up and
 * flaring very slightly wider, so a rim of snow overhangs the branches below
 * it. That overhang is what makes the snow read as *sitting on* the tree
 * rather than being painted on it.
 *
 * A handful of variants are built once and drawn with instancing, so a couple
 * of thousand trees cost a few draw calls.
 */

const TRUNK_COLOR = new THREE.Color('#5a4433');
const SNOW_COLOR = new THREE.Color('#fafdff');
const SNOW_SHADE = new THREE.Color('#dceaf7');

/** Length of one frustum-cullable slice of forest, in metres. */
const FOREST_CHUNK = 150;

const VARIANTS = [
  { tiers: 3, radius: 1.85, height: 6.2, sides: 8, green: '#2d6250', taper: 0.74 },
  { tiers: 4, radius: 1.55, height: 7.4, sides: 7, green: '#275746', taper: 0.78 },
  { tiers: 3, radius: 2.05, height: 5.4, sides: 9, green: '#356c55', taper: 0.7 },
  { tiers: 4, radius: 1.35, height: 8.2, sides: 8, green: '#234f41', taper: 0.8 },
];

/** Builds the merged geometry for a single pine, centred on its trunk base. */
function buildPineGeometry(v) {
  const parts = [];
  const m = new THREE.Matrix4();

  // Cones and cylinders are centred on their own origin; `baseY` is where we
  // want the *bottom* of the part to sit, which is friendlier to reason about.
  const add = (geo, color, baseY, height) => {
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

  // Snow mound around the base — hides the seam with the slope.
  const moundH = v.radius * 0.34;
  add(new THREE.ConeGeometry(v.radius * 0.72, moundH, v.sides, 1), SNOW_COLOR, -0.06, moundH);

  // Foliage tiers, each with its own snow cap.
  const canopyBase = trunkH * 0.72;
  const canopyH = v.height - canopyBase;
  const overlap = 0.42; // tiers overlap so no trunk shows between them
  const tierH = canopyH / (1 + (v.tiers - 1) * (1 - overlap));

  for (let i = 0; i < v.tiers; i++) {
    const t = i / Math.max(1, v.tiers - 1);
    const r = v.radius * (1 - t * v.taper);
    const h = tierH * (1 - t * 0.18);
    const y = canopyBase + i * tierH * (1 - overlap);

    // The green branch cone.
    add(new THREE.ConeGeometry(r, h, v.sides, 1), green.clone().multiplyScalar(0.92 + 0.16 * t), y, h);

    // Snow settled on the upper branches: it follows the same taper but starts
    // 40% of the way up and flares a little wider, so a white rim overhangs the
    // green branches below it.
    const f = 0.4;
    const snowR = r * (1 - f) + 0.13;
    const snowH = h * (1 - f) + 0.14;
    add(
      new THREE.ConeGeometry(snowR, snowH, v.sides, 1),
      i === v.tiers - 1 ? SNOW_COLOR : SNOW_COLOR.clone().lerp(SNOW_SHADE, 0.25 * (1 - t)),
      y + h * f,
      snowH
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
      } else {
        u = side * (COURSE.trackHalfWidth + 22 + rng() * 150);
      }
      if (Math.abs(u) > COURSE.halfWidth - 6) continue;

      // Thin the far field out so the near band stays the visual anchor.
      const density = 1 - clamp((Math.abs(u) - 30) / 190, 0, 1) * 0.55;
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
      colliders.push({ x, z: zw, r: VARIANTS[vi].radius * scale * 0.42 + 0.35 });
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
