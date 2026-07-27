import * as THREE from 'three';
import { clamp } from '../core/mathx.js';

/**
 * Kicker ramps.
 *
 * The geometry is sampled from exactly the same `kickerProfile()` the physics
 * reads, so what the rider sees is what the board rides. Each ramp ends in a
 * hard lip: the ground falls away instantly, which is what flings the rider.
 */

const BASE_COLOR = new THREE.Color('#93c1e7');
const LIP_COLOR = new THREE.Color('#ffffff');
const SIDE_COLOR = new THREE.Color('#9fc2e0');

export function buildKickers(course) {
  const positions = [];
  const colors = [];
  const indices = [];
  const color = new THREE.Color();

  for (const k of course.kickers) {
    const px = k.dirZ; // perpendicular, skier's right
    const pz = -k.dirX;

    // Deliberately coarse. A finely tessellated ramp renders as a flat white
    // slab with no readable form; faceting it at roughly a metre gives the
    // shoulders and the transition real shading, and matches the low-poly
    // language of the trees and peaks.
    const sSteps = Math.max(7, Math.round(k.length / 1.1));
    const tSteps = Math.max(6, Math.round((k.halfWidth * 2) / 1.5));
    const base = positions.length / 3;

    // --- Ramp surface -------------------------------------------------
    for (let i = 0; i <= sSteps; i++) {
      const s = (i / sSteps) * k.length;
      for (let j = 0; j <= tSteps; j++) {
        const t = -k.halfWidth + (j / tSteps) * k.halfWidth * 2;
        const x = k.x + k.dirX * s + px * t;
        const z = k.z + k.dirZ * s + pz * t;
        const lift = course.kickerProfile(k, x, z);
        // 15 mm of clearance keeps the ramp skirt out of the slope's z-buffer.
        positions.push(x, course.terrainHeight(x, z) + lift + 0.015, z);

        // Packed snow brightens toward the lip so the takeoff reads at speed.
        const up = clamp(lift / k.height, 0, 1);
        color.copy(BASE_COLOR).lerp(LIP_COLOR, 0.12 + 0.88 * up * up);
        colors.push(color.r, color.g, color.b);
      }
    }

    const row = tSteps + 1;
    for (let i = 0; i < sSteps; i++) {
      for (let j = 0; j < tSteps; j++) {
        const a = base + i * row + j;
        indices.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
      }
    }

    // --- Lip face: the vertical drop the rider launches off ------------
    const lipStart = positions.length / 3;
    for (let j = 0; j <= tSteps; j++) {
      const t = -k.halfWidth + (j / tSteps) * k.halfWidth * 2;
      const x = k.x + k.dirX * k.length + px * t;
      const z = k.z + k.dirZ * k.length + pz * t;
      const ground = course.terrainHeight(x, z);
      const lift = course.kickerProfile(k, x, z);
      positions.push(x, ground + lift + 0.015, z);
      colors.push(LIP_COLOR.r, LIP_COLOR.g, LIP_COLOR.b);
      positions.push(x, ground - 0.05, z);
      colors.push(SIDE_COLOR.r, SIDE_COLOR.g, SIDE_COLOR.b);
    }
    for (let j = 0; j < tSteps; j++) {
      const a = lipStart + j * 2;
      indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.8,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'kickers';
  return mesh;
}
