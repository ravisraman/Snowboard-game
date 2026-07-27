import * as THREE from 'three';
import { COURSE } from './Course.js';
import { smoothstep } from '../core/mathx.js';

/**
 * The slope mesh.
 *
 * The grid is laid out in *track space* rather than world space: each row of
 * vertices runs perpendicular to the track's tangent, and the columns are
 * spaced tightly across the groomed piste and progressively wider out in the
 * powder. That buys a crisp corduroy surface where the rider actually is,
 * without paying for 2 m triangles a hundred metres out in the trees.
 *
 * The corduroy itself is drawn in the shader from the across-track coordinate,
 * so the grooming lines follow every bend of the piste exactly.
 */

const GROOMED_COLOR = new THREE.Color('#8fbfe6'); // the blue-tinted corduroy
const GROOMED_DEEP = new THREE.Color('#6fa3d2'); // troughs between the ridges
const POWDER_COLOR = new THREE.Color('#f6fbff'); // untracked snow, near-white
const SHADE_COLOR = new THREE.Color('#c2dcf2');

/** How far the mesh reaches sideways, including the coarse far-field skirt. */
const TERRAIN_REACH = 620;

/** Length of one frustum-cullable slice of slope, in metres. */
const CHUNK_LENGTH = 190;

export function buildTerrain(course) {
  const offsets = buildOffsetColumns();
  const zFrom = -70;
  const zTo = COURSE.length + 420;
  const dz = 3.5;
  const rows = Math.ceil((zTo - zFrom) / dz) + 1;
  const cols = offsets.length;

  const count = rows * cols;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const aU = new Float32Array(count);

  const tangent = { x: 0, z: 1 };
  const color = new THREE.Color();

  for (let r = 0; r < rows; r++) {
    const z0 = zFrom + r * dz;
    const cx = course.centerX(z0);
    course.trackTangent(z0, tangent);
    // Perpendicular to the tangent, pointing to skier's right.
    const px = tangent.z;
    const pz = -tangent.x;

    for (let c = 0; c < cols; c++) {
      const u = offsets[c];
      const i = r * cols + c;

      // Rows follow the track's tangent near the piste for clean corduroy, then
      // relax into a plain world-space grid further out. Without that relaxation
      // the perpendicular sweep folds over itself wherever the track's radius of
      // curvature is tighter than the offset.
      const w = smoothstep(45, 120, Math.abs(u));
      const x = (cx + u * px) * (1 - w) + u * w;
      const z = (z0 + u * pz) * (1 - w) + z0 * w;
      const y = course.terrainHeight(x, z);

      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;

      // Shade from the true perpendicular distance, which stays exact even
      // where the grid has relaxed away from track space.
      const su = course.trackOffset(x, z);
      aU[i] = su;

      // Base tint: groomed blue on the piste, bright white out in the powder.
      const au = Math.abs(su);
      const powder = smoothstep(COURSE.trackHalfWidth - COURSE.edgeSoftness, COURSE.trackHalfWidth + 2.5, au);
      color.copy(GROOMED_COLOR).lerp(POWDER_COLOR, powder);
      // Very slight cooling far from the track keeps the eye on the line.
      color.lerp(SHADE_COLOR, smoothstep(60, 175, au) * 0.35);

      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
  }

  // Normals are computed once over the whole field so chunk seams stay smooth.
  const normals = computeGridNormals(positions, rows, cols);

  // The slope is sliced into chunks along its length purely so the renderer can
  // frustum-cull it. As one mesh it is ~170k triangles drawn every frame — and
  // again for the shadow pass — when only a fraction is ever on screen.
  const group = new THREE.Group();
  group.name = 'slope';
  const material = makeSnowMaterial();
  const rowsPerChunk = Math.ceil(CHUNK_LENGTH / dz);

  for (let start = 0; start < rows - 1; start += rowsPerChunk) {
    // Chunks share their boundary row, so there is no crack between them.
    const end = Math.min(rows - 1, start + rowsPerChunk);
    const nRows = end - start + 1;
    const n = nRows * cols;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions.slice(start * cols * 3, (start + nRows) * cols * 3), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals.slice(start * cols * 3, (start + nRows) * cols * 3), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors.slice(start * cols * 3, (start + nRows) * cols * 3), 3));
    geometry.setAttribute('aU', new THREE.BufferAttribute(aU.slice(start * cols, (start + nRows) * cols), 1));

    const indices = [];
    for (let r = 0; r < nRows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c;
        indices.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
      }
    }
    geometry.setIndex(
      n > 65535 ? new THREE.Uint32BufferAttribute(indices, 1) : new THREE.Uint16BufferAttribute(indices, 1)
    );
    geometry.computeBoundingSphere();

    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  return group;
}

/**
 * Area-weighted vertex normals for a regular grid. Doing this by hand rather
 * than per-chunk with `computeVertexNormals` is what keeps the lighting
 * continuous across chunk boundaries.
 */
function computeGridNormals(positions, rows, cols) {
  const normals = new Float32Array(positions.length);
  const get = (r, c, o) => positions[(r * cols + c) * 3 + o];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const rm = Math.max(0, r - 1);
      const rp = Math.min(rows - 1, r + 1);
      const cm = Math.max(0, c - 1);
      const cp = Math.min(cols - 1, c + 1);

      // Central differences of height against the actual grid spacing.
      const dxu = get(r, cp, 0) - get(r, cm, 0);
      const dyu = get(r, cp, 1) - get(r, cm, 1);
      const dzu = get(r, cp, 2) - get(r, cm, 2);
      const dxv = get(rp, c, 0) - get(rm, c, 0);
      const dyv = get(rp, c, 1) - get(rm, c, 1);
      const dzv = get(rp, c, 2) - get(rm, c, 2);

      // n = v x u, which orients +Y up for this winding.
      let nx = dyv * dzu - dzv * dyu;
      let ny = dzv * dxu - dxv * dzu;
      let nz = dxv * dyu - dyv * dxu;
      const len = Math.hypot(nx, ny, nz) || 1;
      const i = (r * cols + c) * 3;
      normals[i] = nx / len;
      normals[i + 1] = ny / len;
      normals[i + 2] = nz / len;
    }
  }
  return normals;
}

/**
 * Column offsets: 1.5 m across the piste, opening up to a coarse skirt that
 * carries the snowfields out past the fog so the world never shows an edge.
 */
function buildOffsetColumns() {
  const half = [];
  let u = 0;
  while (u < TERRAIN_REACH) {
    half.push(u);
    if (u < COURSE.trackHalfWidth + 4) u += 1.5;
    else if (u < 42) u += 3;
    else if (u < 95) u += 6.5;
    else if (u < COURSE.halfWidth) u += 12;
    else u += 28;
  }
  half.push(TERRAIN_REACH);
  const mirrored = half.slice(1).map((v) => -v).reverse();
  return mirrored.concat(half);
}

/**
 * Snow material: physically simple, stylistically specific.
 * Adds corduroy ridges on the piste and a faint sparkle in the powder.
 */
export function makeSnowMaterial(extra = {}) {
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.88,
    metalness: 0.0,
    ...extra,
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGroomDeep = { value: GROOMED_DEEP };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aU;
         varying float vU;
         varying vec3 vWorld;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vU = aU;
         vWorld = (modelMatrix * vec4(position, 1.0)).xyz;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying float vU;
         varying vec3 vWorld;
         uniform vec3 uGroomDeep;

         // Hash for the powder sparkle.
         float hash21(vec2 p) {
           p = fract(p * vec2(233.34, 851.73));
           p += dot(p, p + 23.45);
           return fract(p.x * p.y);
         }`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         {
           float au = abs(vU);
           float onPiste = 1.0 - smoothstep(${(COURSE.trackHalfWidth - COURSE.edgeSoftness).toFixed(2)}, ${COURSE.trackHalfWidth.toFixed(2)}, au);

           // --- Corduroy: ridges running down the fall line of the piste ---
           float w = fwidth(vU);
           float period = 1.15;
           float ridge = sin(vU * ${(Math.PI * 2).toFixed(6)} / period);
           // Fade the ridges out once they are finer than a pixel to stop shimmer.
           ridge *= 1.0 - smoothstep(0.18, 0.85, w / period);
           float groove = smoothstep(-0.25, 0.9, ridge);
           vec3 corduroy = mix(uGroomDeep, diffuseColor.rgb, 0.55 + 0.45 * groove);
           // A crisper dark seam at the bottom of every groove.
           corduroy *= 1.0 - 0.07 * (1.0 - smoothstep(0.0, 0.35, ridge + 0.85));
           diffuseColor.rgb = mix(diffuseColor.rgb, corduroy, onPiste);

           // --- Powder sparkle: a few bright grains catching the sun ---
           // Faded out with distance, otherwise the grain aliases into
           // shimmering blocks across the whole far field.
           float near = 1.0 - smoothstep(18.0, 65.0, length(vWorld - cameraPosition));
           float sparkle = hash21(floor(vWorld.xz * 7.0));
           sparkle = smoothstep(0.988, 1.0, sparkle) * (1.0 - onPiste) * near;
           diffuseColor.rgb += sparkle * 0.22;

           // Groomer edge: a soft berm line where the corduroy meets the powder.
           float edge = smoothstep(0.35, 0.0, abs(au - ${COURSE.trackHalfWidth.toFixed(2)}));
           diffuseColor.rgb *= 1.0 - 0.06 * edge;
         }`
      );
  };

  // Any change to onBeforeCompile needs a distinct cache key.
  material.customProgramCacheKey = () => 'alpine-snow-v1';
  return material;
}
