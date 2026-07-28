import * as THREE from 'three';
import { makeRng } from '../core/mathx.js';
import { bucketColliders } from './Trees.js';

/**
 * Stars and slalom gates: a way to score that needs no trick skill at all.
 *
 * Both are placed with their own seeded RNG, the same reason `Trees.js` keeps
 * one of its own — a run should not reshuffle every time an unrelated system
 * changes how many random draws it makes.
 *
 * Neither ever ends a run or costs speed. Missing a star just leaves it there;
 * missing a gate resets the streak, not the score already banked. That is the
 * whole point of a collectible track running alongside the trick score: a run
 * with zero tricks still ends on a positive number.
 */

const STAR_COLOR = new THREE.Color('#ffd54a');
const STAR_CORE = new THREE.Color('#fff6d8');
const GATE_COLORS = [new THREE.Color('#ff4d4d'), new THREE.Color('#3fa9ff')];

export const STAR_PICKUP_RADIUS = 1.5;

/** A small faceted "gem" rather than a flat sprite — reads at speed and from any angle. */
function starGeometry() {
  const geo = new THREE.OctahedronGeometry(0.42, 0);
  geo.scale(1, 1.35, 1);
  return geo;
}

/** A slalom pole: a thin shaft with a flag near the top, in one merged shape. */
function poleGeometry() {
  const shaft = new THREE.CylinderGeometry(0.05, 0.07, 2.0, 6);
  shaft.translate(0, 1.0, 0);
  const flag = new THREE.ConeGeometry(0.26, 0.5, 4);
  flag.rotateZ(Math.PI / 2);
  flag.translate(0.22, 1.55, 0);
  const merged = shaft.toNonIndexed();
  const flagNI = flag.toNonIndexed();
  const positions = [...merged.attributes.position.array, ...flagNI.attributes.position.array];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

export function buildCollectibles(course, { seed = 8823 } = {}) {
  const rng = makeRng(seed);
  const stars = [];
  const gates = [];

  /* ------------------------------------------------------------------
   * Stars: scattered close to the line, with an occasional light detour
   * off it. Never on a kicker ramp — a star buried under a jump would be
   * unreachable, not tempting.
   * ---------------------------------------------------------------- */
  let z = 70;
  while (z < course.finishZ - 40) {
    z += 8 + rng() * 9;
    if (rng() > 0.6) continue;
    const cx = course.centerX(z);
    if (course.onKicker(cx, z, 8)) continue;

    const detour = rng() < 0.72;
    const off = detour
      ? rng.spread(course.trackHalfWidth * 0.55)
      : rng.spread(course.trackHalfWidth + 9);
    const tan = course.trackTangent(z);
    const x = cx + off * tan.z;
    const zw = z - off * tan.x;
    if (course.onKicker(x, zw, 4)) continue;

    stars.push({
      id: stars.length,
      x,
      z: zw,
      y: course.groundHeight(x, zw) + 1.05,
      phase: rng() * Math.PI * 2,
      collected: false,
    });
  }

  /* ------------------------------------------------------------------
   * Gates: short slalom runs of 3-5 pole pairs, on stretches straight
   * enough that a rider is not already fighting the terrain.
   * ---------------------------------------------------------------- */
  let gz = 220;
  let groupId = 0;
  while (gz < course.finishZ - 260) {
    const straight = Math.abs(course.centerSlope(gz)) < 0.3;
    if (straight && !course.onKicker(course.centerX(gz), gz, 12) && rng() < 0.55) {
      const n = 3 + rng.int(0, 2);
      let side = rng() < 0.5 ? -1 : 1;
      for (let i = 0; i < n; i++) {
        const zz = gz + i * (15 + rng() * 5);
        const cx = course.centerX(zz);
        const tan = course.trackTangent(zz);
        const weave = side * (5 + rng() * 3);
        const halfWidth = 3.4 + rng() * 0.8;
        const x = cx + weave * tan.z;
        const zw = zz - weave * tan.x;
        gates.push({
          id: gates.length,
          x,
          z: zw,
          dirX: tan.x,
          dirZ: tan.z,
          halfWidth,
          groupId,
          index: i,
          passed: false,
        });
        side *= -1;
      }
      groupId++;
      gz += n * 20 + 110 + rng() * 90;
    } else {
      gz += 45;
    }
  }

  const group = new THREE.Group();
  group.name = 'collectibles';

  /* --- Stars, instanced and toggled invisible on pickup --------------- */
  const starGeo = starGeometry();
  const starMat = new THREE.MeshStandardMaterial({
    color: STAR_CORE,
    emissive: STAR_COLOR,
    emissiveIntensity: 0.9,
    roughness: 0.35,
    metalness: 0.15,
    flatShading: true,
  });
  const starMesh = stars.length ? new THREE.InstancedMesh(starGeo, starMat, stars.length) : null;
  if (starMesh) {
    starMesh.name = 'stars';
    starMesh.castShadow = true;
    starMesh.frustumCulled = false; // spread over 3 km; culling a chunk at a time is not worth the bookkeeping here
    group.add(starMesh);
  }

  /* --- Gate poles, instanced, alternating colour by side -------------- */
  const poleGeo = poleGeometry();
  const poleColors = new Float32Array(poleGeo.attributes.position.count * 3);
  poleGeo.setAttribute('color', new THREE.BufferAttribute(poleColors, 3));
  const poleMat = new THREE.MeshStandardMaterial({
    vertexColors: false,
    roughness: 0.7,
    metalness: 0,
    flatShading: true,
  });
  const poleMesh = gates.length ? new THREE.InstancedMesh(poleGeo, poleMat, gates.length * 2) : null;
  if (poleMesh) {
    poleMesh.name = 'gates';
    poleMesh.castShadow = true;
    poleMesh.frustumCulled = false;
    poleMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(gates.length * 2 * 3), 3);
    group.add(poleMesh);
  }

  const dummy = new THREE.Object3D();
  if (poleMesh) {
    gates.forEach((g, i) => {
      const px = g.dirZ;
      const pz = -g.dirX;
      const ground = course.terrainHeight(g.x, g.z);
      for (let side = 0; side < 2; side++) {
        const sign = side === 0 ? -1 : 1;
        const x = g.x + px * g.halfWidth * sign;
        const z = g.z + pz * g.halfWidth * sign;
        dummy.position.set(x, ground, z);
        dummy.rotation.set(0, Math.atan2(g.dirX, g.dirZ), 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        const idx = i * 2 + side;
        poleMesh.setMatrixAt(idx, dummy.matrix);
        poleMesh.setColorAt(idx, GATE_COLORS[side]);
      }
    });
    poleMesh.instanceMatrix.needsUpdate = true;
    if (poleMesh.instanceColor) poleMesh.instanceColor.needsUpdate = true;
  }

  const collectStar = (id) => {
    if (!starMesh) return;
    dummy.position.set(0, -500, 0);
    dummy.scale.setScalar(0);
    dummy.updateMatrix();
    starMesh.setMatrixAt(id, dummy.matrix);
    starMesh.instanceMatrix.needsUpdate = true;
  };

  /** Bobs and spins every uncollected star — a couple hundred cheap matrix writes. */
  let time = 0;
  const update = (dt) => {
    if (!starMesh) return;
    time += dt;
    for (const s of stars) {
      if (s.collected) continue;
      dummy.position.set(s.x, s.y + Math.sin(time * 1.6 + s.phase) * 0.18, s.z);
      dummy.rotation.set(0, time * 1.4 + s.phase, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      starMesh.setMatrixAt(s.id, dummy.matrix);
    }
    starMesh.instanceMatrix.needsUpdate = true;
  };

  // Initial placement, before the first `update()` call runs.
  if (starMesh) {
    for (const s of stars) {
      dummy.position.set(s.x, s.y, s.z);
      dummy.rotation.set(0, s.phase, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      starMesh.setMatrixAt(s.id, dummy.matrix);
    }
    starMesh.instanceMatrix.needsUpdate = true;
  }

  /** A fresh run: every star reappears, every gate is unpassed. */
  const resetRun = () => {
    for (const s of stars) s.collected = false;
    for (const g of gates) g.passed = false;
  };

  return {
    group,
    stars,
    gates,
    starsBucket: bucketColliders(stars, 12),
    gatesBucket: bucketColliders(gates, 20),
    collectStar,
    resetRun,
    update,
  };
}
