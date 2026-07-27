import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeRng, clamp } from '../core/mathx.js';
import { COURSE } from '../world/Course.js';

/**
 * Recreational skiers drifting down the piste.
 *
 * They traverse in lazy S-turns across the groomer at a fraction of the
 * rider's speed, which makes them a moving hazard you have to read a line
 * around rather than a static obstacle you memorise.
 *
 * Two things keep them from making the run unridable. They stay out of the
 * middle of the piste — each one is anchored to a lane off to one side, so
 * there is always a corridor down the fall line rather than a wall of traffic
 * sweeping the full width — and the top of the mountain is empty, so the first
 * stretch is yours to get up to speed on.
 */

const JACKETS = ['#e04b4b', '#3f7fd8', '#f0c33c', '#57b56a', '#b45fd0', '#e8863c'];
const SKI_COUNT = 30;

/** No traffic above this, so the drop-in is clear. */
const FIRST_SKIER_Z = 430;

/** Half-width of the corridor down the middle that skiers stay out of. */
const CORRIDOR = 4.5;

function tint(geo, color) {
  geo.deleteAttribute('uv');
  const c = new THREE.Color(color);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function box(w, h, d, color, x, y, z, rotX = 0) {
  const geo = new THREE.BoxGeometry(w, h, d);
  if (rotX) geo.rotateX(rotX);
  geo.translate(x, y, z);
  return tint(geo, color);
}

/** One skier, facing +Z, standing on the snow at y = 0. */
function buildSkierGeometry(jacket) {
  const parts = [];

  // Skis, slightly angled into a snowplough-ish stance.
  for (const sx of [-0.17, 0.17]) {
    parts.push(box(0.1, 0.04, 1.65, '#1d2733', sx, 0.03, 0.1));
    parts.push(box(0.1, 0.04, 0.22, '#1d2733', sx, 0.07, 0.98, -0.45)); // tip kick
  }

  // Boots and legs
  for (const sx of [-0.17, 0.17]) {
    parts.push(box(0.16, 0.2, 0.26, '#2b323d', sx, 0.15, 0.04));
    parts.push(box(0.17, 0.5, 0.2, '#39414f', sx, 0.5, 0.0));
  }

  // Torso, arms, head
  parts.push(box(0.44, 0.5, 0.28, jacket, 0, 0.99, 0));
  parts.push(box(0.48, 0.1, 0.31, '#2b323d', 0, 0.79, 0));
  for (const sx of [-0.29, 0.29]) {
    parts.push(box(0.13, 0.42, 0.15, jacket, sx, 0.98, 0.05));
    parts.push(box(0.1, 0.1, 0.1, '#2b323d', sx, 0.76, 0.1)); // glove
    // Pole, planted back and out. Centre it so the basket sits on the snow
    // rather than a hand's width below it.
    parts.push(box(0.03, 0.92, 0.03, '#464e5a', sx * 1.15, 0.48, -0.24, 0.22));
  }
  parts.push(box(0.2, 0.2, 0.2, '#e8b48c', 0, 1.34, 0));     // head
  parts.push(box(0.24, 0.14, 0.24, '#2b323d', 0, 1.47, 0));  // beanie
  parts.push(box(0.22, 0.08, 0.05, '#7fd4f0', 0, 1.36, 0.1)); // goggles

  const merged = mergeGeometries(parts, false);
  merged.computeVertexNormals();
  return merged;
}

export class Skiers {
  constructor(course, seed = 5150) {
    this.course = course;
    const rng = makeRng(seed);

    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.8,
      metalness: 0,
    });

    // One geometry per jacket colour, shared by every skier wearing it.
    this.geometries = JACKETS.map((c) => buildSkierGeometry(c));

    this.group = new THREE.Group();
    this.group.name = 'skiers';
    this.skiers = [];

    for (let i = 0; i < SKI_COUNT; i++) {
      const z = FIRST_SKIER_Z + (i / SKI_COUNT) * (COURSE.finishZ - FIRST_SKIER_Z - 260) + rng.spread(26);
      const gi = rng.int(0, JACKETS.length - 1);
      const mesh = new THREE.Mesh(this.geometries[gi], this.material);
      mesh.castShadow = true;
      this.group.add(mesh);

      // Each skier works a lane off to one side. The arcs are still wide and
      // lazy, but they are wide *within* a lane, so the two of them never close
      // the middle of the piste at the same time.
      const side = rng() < 0.5 ? -1 : 1;
      const amp = rng.range(1.6, 3.4);
      const lane = side * (CORRIDOR + amp + rng() * (COURSE.trackHalfWidth - CORRIDOR - amp - 1.5));

      this.skiers.push({
        mesh,
        z0: z,
        z,
        lane,
        amp,
        freq: rng.range(0.016, 0.038),
        phase: rng() * Math.PI * 2,
        speed: rng.range(3.4, 7.2),
        bob: rng() * Math.PI * 2,
        radius: 0.72,
        x: 0,
        u: 0,
      });
    }

    this.reset();
  }

  reset() {
    for (const s of this.skiers) {
      s.z = s.z0;
      this._place(s, 0);
    }
  }

  _place(s, dt) {
    const c = this.course;
    s.z += s.speed * dt;
    const u = s.lane + Math.sin(s.z * s.freq + s.phase) * s.amp;
    const tan = c.trackTangent(s.z);
    const x = c.centerX(s.z) + u * tan.z;
    const z = s.z - u * tan.x;

    s.x = x;
    s.u = u;
    s.wz = z;

    const y = c.groundHeight(x, z);
    s.mesh.position.set(x, y, z);

    // Heading: track tangent plus the derivative of the traverse.
    const dudz = Math.cos(s.z * s.freq + s.phase) * s.amp * s.freq;
    s.mesh.rotation.y = c.trackHeading(s.z) + Math.atan(dudz) * 0.85;
    // Lean into the traverse, and bob gently with each turn.
    s.mesh.rotation.z = -clamp(dudz, -1, 1) * 0.3;
    s.bob += dt * 3;
    s.mesh.position.y = y + Math.sin(s.bob) * 0.03;
  }

  /**
   * Only skiers near the rider need simulating; the rest are parked and
   * hidden, which keeps this at a few dozen matrix updates a frame.
   */
  update(dt, riderZ) {
    for (const s of this.skiers) {
      const near = s.z > riderZ - 120 && s.z < riderZ + 320;
      s.mesh.visible = near;
      if (near) this._place(s, dt);
    }
  }

  /** Nearest-skier collision test against the rider. */
  hits(x, z, radius) {
    for (const s of this.skiers) {
      if (!s.mesh.visible) continue;
      const dx = s.x - x;
      const dz = s.wz - z;
      const r = s.radius + radius;
      if (dx * dx + dz * dz < r * r) return s;
    }
    return null;
  }
}
