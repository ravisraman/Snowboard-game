import * as THREE from 'three';

/**
 * Grind rails: a thin steel strip sampled from exactly the same
 * `railPointAt`/`railHeightAt` the physics reads, plus a handful of support
 * posts so it reads as a structure sitting on the snow rather than a line
 * floating above it.
 */

const RAIL_COLOR = new THREE.Color('#d8dee6');
const RAIL_SHADE = new THREE.Color('#8b93a0');
const POST_COLOR = new THREE.Color('#5a5f68');

export function buildRails(course) {
  const positions = [];
  const colors = [];
  const indices = [];
  const color = new THREE.Color();

  for (const rail of course.rails) {
    const steps = Math.max(8, Math.round(rail.length / 1.2));
    const base = positions.length / 3;
    const hw = rail.halfWidth;

    // --- The rail top surface, a thin flat strip -----------------------
    for (let i = 0; i <= steps; i++) {
      const s = (i / steps) * rail.length;
      const p = course.railPointAt(rail, s);
      const tan = course.railTangentAt(rail, s);
      const px = tan.z;
      const pz = -tan.x;
      const y = course.railHeightAt(rail, s);

      for (const side of [-1, 1]) {
        positions.push(p.x + px * hw * side, y, p.z + pz * hw * side);
        color.copy(RAIL_COLOR).lerp(RAIL_SHADE, side > 0 ? 0.35 : 0);
        colors.push(color.r, color.g, color.b);
      }
    }
    for (let i = 0; i < steps; i++) {
      const a = base + i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }

    // --- Support posts every couple of metres ---------------------------
    const postCount = Math.max(2, Math.round(rail.length / 2.6));
    for (let i = 0; i <= postCount; i++) {
      const s = (i / postCount) * rail.length;
      const p = course.railPointAt(rail, s);
      const y = course.railHeightAt(rail, s);
      const ground = course.terrainHeight(p.x, p.z);
      if (y - ground < 0.08) continue; // the rail is nearly on the snow here

      const postBase = positions.length / 3;
      const r = 0.05;
      for (const [dx, dz] of [[-r, 0], [r, 0], [0, -r], [0, r]]) {
        positions.push(p.x + dx, ground, p.z + dz);
        colors.push(POST_COLOR.r, POST_COLOR.g, POST_COLOR.b);
        positions.push(p.x + dx, y, p.z + dz);
        colors.push(POST_COLOR.r, POST_COLOR.g, POST_COLOR.b);
      }
      // Two faces of the little post, enough to read as a strut rather than a wire.
      indices.push(postBase, postBase + 1, postBase + 2, postBase + 2, postBase + 1, postBase + 3);
      indices.push(postBase + 4, postBase + 5, postBase + 6, postBase + 6, postBase + 5, postBase + 7);
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
    roughness: 0.35,
    metalness: 0.75,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'rails';
  return mesh;
}
