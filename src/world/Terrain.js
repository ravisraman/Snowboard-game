import * as THREE from 'three';
import { CLASSIC } from './Runs.js';
import { SUN_DIRECTION } from './Environment.js';
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
 *
 * ---------------------------------------------------------------------------
 * Everything here comes from the `Course` instance it is handed
 * ---------------------------------------------------------------------------
 * This file used to read the module-level `COURSE` view at module scope and
 * bake `trackHalfWidth` and `edgeSoftness` into GLSL source as literals. That
 * only worked because exactly one course exists at a time and `Game.js` happens
 * to build the terrain after it — and it stopped being *expressible* the moment
 * a fork made the piste's width a function of z, since a baked constant cannot
 * vary down the hill.
 *
 * So the width is no longer in the shader at all. Each vertex carries `aEdge` —
 * its signed distance to the corduroy edge, in metres, negative on the piste —
 * computed on the CPU from `course.trackHalfWidthAt(z)`. Every place the shader
 * used to compare `abs(vU)` against a baked half-width now looks at that
 * distance instead, which is correct whatever the width is doing, and the only
 * scalar left is the edge softness, which is a real uniform.
 */

// Groomed snow is white, not blue. The blue in a photograph of a piste is the
// sky reflecting off it and the shadow inside each groove — so the tint here is
// barely there, and the grooming itself is carried by the shaded normal.
const GROOMED_COLOR = new THREE.Color('#eef5fb'); // packed corduroy
const GROOMED_DEEP = new THREE.Color('#d3e3f1');  // troughs between the ridges
const POWDER_COLOR = new THREE.Color('#fbfdff');  // untracked snow
const SHADE_COLOR = new THREE.Color('#dceaf6');   // far-field cooling

/** How hard the forward-scatter sheen sits on top of the lit surface. */
const SHEEN_STRENGTH = 0.5;

/**
 * The subsurface term. `WRAP` is how far light bleeds past the terminator —
 * 0 is a hard Lambert edge, 1 wraps light all the way round the object.
 */
const WRAP = 0.55;
const WRAP_STRENGTH = 0.5;

/** Depth of the boot-print-scale relief that keeps the near snow from being
 * geometrically perfect. */
const MICRO_DEPTH = 0.045;

/** Brightness of the ice glitter close to the camera. */
const GLITTER = 0.85;

/** Depth of the wind ripples out in the powder, as a normal perturbation. */
const SASTRUGI_DEPTH = 0.95;

/** Corduroy ridge spacing and depth, in metres. A groomer's tiller is fine. */
const CORDUROY_PERIOD = 0.3;
const CORDUROY_DEPTH = 0.011;

/** How far the mesh reaches sideways, including the coarse far-field skirt. */
const TERRAIN_REACH = 620;

/** Length of one frustum-cullable slice of slope, in metres. */
const CHUNK_LENGTH = 190;

/** Ordinary row spacing down the hill, in metres. */
const ROW_STEP = 3.5;

/**
 * Rows per wavelength demanded of a mogul field.
 *
 * At the ordinary 3.5 m spacing a 12 m bump gets three and a bit samples and
 * the mesh reconstructs it as a flattened triangle wave, several centimetres
 * shallower than the height field the board is actually riding. Collision here
 * is analytic and therefore exact, so any under-sampling shows up directly as
 * the rider floating over the crests — which is the one thing this file's
 * whole "one analytic height field" arrangement exists to prevent.
 */
const MOGUL_ROWS_PER_BUMP = 8;

/**
 * Contact shading: how dark the snow goes right at the foot of something, and
 * how far out it reaches. Cheap, baked, and worth more than it looks — a tree
 * standing on unshaded snow reads as a sticker laid on top of the slope.
 */
const AO_STRENGTH = 0.3;
const AO_REACH = 2.4;

export function buildTerrain(course, { quality = {}, occluders = null } = {}) {
  const cfg = course.config;
  const offsets = buildOffsetColumns(course, quality.skirtStep ?? 28);
  const rowZs = buildRowZs(course);
  const rows = rowZs.length;
  const cols = offsets.length;

  const count = rows * cols;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const aU = new Float32Array(count);
  // Signed metres from the corduroy edge, negative on the piste. This is what
  // replaced the half-width baked into the shader — see the header.
  const aEdge = new Float32Array(count);
  // How much of the fork's divider is under this vertex, 0 to 1.
  const aDiv = new Float32Array(count);

  const tangent = { x: 0, z: 1 };
  const color = new THREE.Color();

  for (let r = 0; r < rows; r++) {
    const z0 = rowZs[r];
    const halfWidth = course.trackHalfWidthAt(z0);
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
      const edge = au - halfWidth;
      const div = course.dividerMask(x, z);
      aEdge[i] = edge;
      aDiv[i] = div;

      const powder = smoothstep(-cfg.track.edgeSoftness, 2.5, edge);
      color.copy(GROOMED_COLOR).lerp(POWDER_COLOR, powder);
      // The fork's divider is untracked snow standing in the middle of the
      // corduroy, and it has to look it — a ridge painted piste-blue reads as a
      // lump in the piste rather than as the thing you have to choose a side of.
      if (div > 0) color.lerp(POWDER_COLOR, div);
      // Very slight cooling far from the track keeps the eye on the line.
      color.lerp(SHADE_COLOR, smoothstep(60, 175, au) * 0.35);

      // Pool a little shade around the base of every trunk. The real thing is
      // ambient occlusion plus the tree's own snow shadow plus the drift that
      // always collects there; one darkened vertex ring stands in for all three.
      if (occluders) {
        let shade = 0;
        for (const o of occluders.query(z)) {
          const d = Math.hypot(o.x - x, o.z - z) - o.r;
          if (d < AO_REACH) shade = Math.max(shade, 1 - smoothstep(0, AO_REACH, Math.max(d, 0)));
        }
        if (shade > 0) color.lerp(SHADE_COLOR, shade * AO_STRENGTH);
      }

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
  const material = makeSnowMaterial(course);

  // Chunk boundaries are found by walking z rather than counting rows, because
  // the rows are not evenly spaced: a mogul field asks for finer ones.
  for (let start = 0; start < rows - 1; ) {
    let end = start + 1;
    while (end < rows - 1 && rowZs[end] - rowZs[start] < CHUNK_LENGTH) end++;
    // Chunks share their boundary row, so there is no crack between them.
    const nRows = end - start + 1;
    const n = nRows * cols;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions.slice(start * cols * 3, (start + nRows) * cols * 3), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals.slice(start * cols * 3, (start + nRows) * cols * 3), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors.slice(start * cols * 3, (start + nRows) * cols * 3), 3));
    geometry.setAttribute('aU', new THREE.BufferAttribute(aU.slice(start * cols, (start + nRows) * cols), 1));
    geometry.setAttribute('aEdge', new THREE.BufferAttribute(aEdge.slice(start * cols, (start + nRows) * cols), 1));
    geometry.setAttribute('aDiv', new THREE.BufferAttribute(aDiv.slice(start * cols, (start + nRows) * cols), 1));

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

    start = end;
  }

  return group;
}

/**
 * The z of every row, from above the gate to past the end of the fall line.
 *
 * Evenly spaced, except over a mogul field, where the rows close up enough to
 * resolve the bumps. The grid stays perfectly rectangular either way — the
 * chunking and `computeGridNormals` both depend on that — because it is only
 * the *spacing* that varies, never the number of columns in a row.
 */
function buildRowZs(course) {
  const cfg = course.config;
  const zFrom = -70;
  const zTo = course.length + cfg.profileMargin;

  const m = cfg.moguls;
  const fine = m && m.enabled
    // A metre of margin either side so the first and last bump are resolved too.
    ? { from: m.z0 - 8, to: m.z3 + 8, step: Math.min(ROW_STEP, m.spacingZ / MOGUL_ROWS_PER_BUMP) }
    : null;

  const zs = [];
  for (let z = zFrom; z <= zTo; ) {
    zs.push(z);
    z += fine && z >= fine.from && z < fine.to ? fine.step : ROW_STEP;
  }
  // One row past the end, so the last strip of triangles is a full one.
  zs.push(zs[zs.length - 1] + ROW_STEP);
  return zs;
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
 *
 * One set of columns serves every row, because the grid has to stay
 * rectangular. So the fine band is sized for the *widest* the corduroy ever
 * gets — through a fork, that is both lanes and the divider between them — and
 * a run without a fork pays nothing for it.
 */
function buildOffsetColumns(course, skirtStep) {
  const cfg = course.config;
  const fineTo = course.maxTrackHalfWidth() + 4;
  const half = [];
  let u = 0;
  while (u < TERRAIN_REACH) {
    half.push(u);
    if (u < fineTo) u += 1.5;
    else if (u < 42) u += 3;
    else if (u < 95) u += 6.5;
    else if (u < cfg.halfWidth) u += 12;
    else u += skirtStep;
  }
  half.push(TERRAIN_REACH);
  const mirrored = half.slice(1).map((v) => -v).reverse();
  return mirrored.concat(half);
}

/**
 * Snow material: physically simple, stylistically specific.
 * Adds corduroy ridges on the piste and a faint sparkle in the powder.
 *
 * Takes the `Course` it is shading so the one remaining piste scalar — the
 * softness of the corduroy edge — arrives as a uniform rather than as text
 * spliced into the shader source. The half-width itself is not here at all any
 * more; it varies with z, so it travels per-vertex as `aEdge`.
 *
 * The default keeps the export usable without a course to hand.
 */
export function makeSnowMaterial(course = null, extra = {}) {
  const edgeSoftness = course?.edgeSoftness ?? CLASSIC.track.edgeSoftness;
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.88,
    metalness: 0.0,
    ...extra,
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGroomDeep = { value: GROOMED_DEEP };
    shader.uniforms.uEdgeSoft = { value: edgeSoftness };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aU;
         attribute float aEdge;
         attribute float aDiv;
         varying float vU;
         varying float vEdge;
         varying float vDiv;
         varying vec3 vWorld;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vU = aU;
         vEdge = aEdge;
         vDiv = aDiv;
         vWorld = (modelMatrix * vec4(position, 1.0)).xyz;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying float vU;
         varying float vEdge;
         varying float vDiv;
         varying vec3 vWorld;
         uniform vec3 uGroomDeep;
         uniform float uEdgeSoft;

         const float CORD_PERIOD = ${CORDUROY_PERIOD.toFixed(3)};
         const float CORD_K = ${((Math.PI * 2) / CORDUROY_PERIOD).toFixed(5)};

         // How groomed this fragment is. vEdge is signed metres from the
         // corduroy edge, so this is correct wherever the piste widens — and
         // the fork's divider, which no groomer can climb, punches a hole
         // straight through the middle of it.
         float pisteAt() {
           return (1.0 - smoothstep(-uEdgeSoft, 0.0, vEdge)) * (1.0 - vDiv);
         }

         // Fades the grooming out once a ridge is finer than a pixel, which is
         // the only thing keeping the far piste from boiling.
         float cordFade(float w) {
           return 1.0 - smoothstep(0.16, 0.8, w / CORD_PERIOD);
         }

         float hash21(vec2 p) {
           p = fract(p * vec2(233.34, 851.73));
           p += dot(p, p + 23.45);
           return fract(p.x * p.y);
         }

         // Value noise from the same hash, so the micro-relief costs no extra
         // texture and no extra uniform — just arithmetic.
         float vnoise(vec2 p) {
           vec2 i = floor(p);
           vec2 f = fract(p);
           f = f * f * (3.0 - 2.0 * f);
           float a = hash21(i);
           float b = hash21(i + vec2(1.0, 0.0));
           float c = hash21(i + vec2(0.0, 1.0));
           float d = hash21(i + vec2(1.0, 1.0));
           return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
         }

         // Three octaves at boot-print scale and finer.
         float microRelief(vec2 p) {
           return vnoise(p * 3.0) * 0.55 + vnoise(p * 8.0) * 0.3 + vnoise(p * 19.0) * 0.15;
         }

         // Wind-scoured ripples in the untracked snow. Two waves crossed at an
         // angle, because sastrugi are cut by wind that has shifted over days —
         // a single sine reads as corrugated iron, not as a snowfield.
         float sastrugi(vec2 p) {
           float a = sin(dot(p, vec2(0.82, 0.57)) * 1.15);
           float b = sin(dot(p, vec2(-0.42, 0.91)) * 0.47 + 1.7);
           float c = sin(dot(p, vec2(0.94, -0.34)) * 2.6 + 0.4);
           return a * 0.5 + b * 0.34 + c * 0.16;
         }`
      )
      // The grooming is bumped into the *normal*, not painted into the colour.
      // Corduroy is white-on-white in life: what you actually see is a few
      // thousand tiny ridges catching the sun down one flank and shading down
      // the other, and only a shaded normal reproduces that.
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
         {
           float onPiste = pisteAt();
           float fade = cordFade(fwidth(vU)) * onPiste;
           if (fade > 0.001) {
             // World-space direction in which the across-track coordinate grows.
             vec3 duWorld = dFdx(vWorld) * dFdx(vU) + dFdy(vWorld) * dFdy(vU);
             float len = length(duWorld);
             if (len > 1e-6) {
               vec3 uDir = duWorld / len;
               float slope = cos(vU * CORD_K) * CORD_K * ${CORDUROY_DEPTH.toFixed(4)};
               normal = normalize(normal - uDir * slope * fade);
             }
           }

           // Micro-relief, everywhere and at the scale of a boot print. The
           // slope's triangles are metres across, so up close the surface is
           // otherwise geometrically perfect — and nothing in nature is. Three
           // octaves of hashed noise, bumped into the normal and faded out
           // before the frequency reaches a pixel and starts to crawl.
           float detailFade = 1.0 - smoothstep(4.0, 26.0, length(vWorld - cameraPosition));
           if (detailFade > 0.004) {
             float e = 0.07;
             float h0 = microRelief(vWorld.xz);
             float dx = microRelief(vWorld.xz + vec2(e, 0.0)) - h0;
             float dz = microRelief(vWorld.xz + vec2(0.0, e)) - h0;
             normal = normalize(normal - vec3(dx, 0.0, dz) * (${MICRO_DEPTH.toFixed(3)} * detailFade) / e);
           }

           // The powder gets the same treatment at a much coarser scale: wind
           // ripples bumped into the normal rather than painted on, so they
           // catch the light from one side exactly as the corduroy does.
           float offPiste = 1.0 - onPiste;
           float ripFade = 1.0 - smoothstep(30.0, 130.0, length(vWorld - cameraPosition));
           float rip = offPiste * ripFade * ${SASTRUGI_DEPTH.toFixed(4)};
           if (rip > 0.0005) {
             float e = 0.35;
             float h0 = sastrugi(vWorld.xz);
             float dx = sastrugi(vWorld.xz + vec2(e, 0.0)) - h0;
             float dz = sastrugi(vWorld.xz + vec2(0.0, e)) - h0;
             normal = normalize(normal - vec3(dx, 0.0, dz) * rip / e);
           }
         }`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         {
           float onPiste = pisteAt();
           float fade = cordFade(fwidth(vU));

           // A whisper of tone on top of the shaded ridges — the groomer packs
           // the troughs harder, so they sit a shade cooler than the crests.
           float ridge = sin(vU * CORD_K) * fade;
           vec3 corduroy = mix(uGroomDeep, diffuseColor.rgb, 0.72 + 0.28 * smoothstep(-1.0, 1.0, ridge));
           diffuseColor.rgb = mix(diffuseColor.rgb, corduroy, onPiste);

           // --- Powder sparkle: a few bright grains catching the sun ---
           // Faded out with distance, otherwise the grain aliases into
           // shimmering blocks across the whole far field.
           float near = 1.0 - smoothstep(18.0, 65.0, length(vWorld - cameraPosition));
           float sparkle = hash21(floor(vWorld.xz * 7.0));
           sparkle = smoothstep(0.988, 1.0, sparkle) * (1.0 - onPiste) * near;
           diffuseColor.rgb += sparkle * 0.2;

           // Groomer edge: a soft berm line where the corduroy meets the powder,
           // drawn from the per-vertex distance to that edge so it tracks the
           // piste widening through a fork instead of sitting at a fixed width.
           float edge = smoothstep(0.35, 0.0, abs(vEdge)) * (1.0 - vDiv);
           diffuseColor.rgb *= 1.0 - 0.04 * edge;

           // And the same line again where the corduroy runs out against the
           // foot of the fork's divider. Snow on snow is nearly contrastless in
           // this light, and two drawn edges are what turn a pale swelling in
           // the middle of the piste into a thing with two sides to it.
           float foot = smoothstep(0.0, 0.2, vDiv) * smoothstep(0.6, 0.25, vDiv);
           diffuseColor.rgb *= 1.0 - 0.05 * foot;
         }`
      )
      /*
       * Snow is not a diffuse surface, and a standard material insists that it
       * is. Three things have to be put back by hand, and together they are
       * most of the difference between "white plastic" and "snow":
       *
       * Light goes *into* snow and comes back out somewhere else. The top
       * centimetre is a scattering medium, so the terminator between lit and
       * shadowed is soft and slightly blue rather than a hard line — that is
       * the wrap term.
       *
       * It scatters strongly forward, so looking toward the sun across a
       * packed piste there is a broad sheen, brightest at grazing angles. This
       * is also where the bloom finds something worth blooming.
       *
       * And it is made of ice crystals, so it glitters: individual facets flash
       * as you move past them. Keying the sparkle to the camera's own position
       * is what turns a static speckle into a twinkle.
       */
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
         {
           vec3 sunDir = normalize(vec3(${SUN_DIRECTION.x.toFixed(4)}, ${SUN_DIRECTION.y.toFixed(4)}, ${SUN_DIRECTION.z.toFixed(4)}));
           float ndl = dot(normal, sunDir);
           // Light wrapped around the terminator, minus what the direct lobe
           // already accounted for — so this only fills in the shaded side.
           float wrapped = max(0.0, (ndl + ${WRAP.toFixed(2)}) / ${(1 + WRAP).toFixed(2)});
           float extra = max(0.0, wrapped - max(0.0, ndl));
           reflectedLight.indirectDiffuse += diffuseColor.rgb * extra * ${WRAP_STRENGTH.toFixed(3)} * vec3(0.72, 0.82, 1.0);
         }`
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
         {
           vec3 viewDir = normalize(cameraPosition - vWorld);
           vec3 sunDir = normalize(vec3(${SUN_DIRECTION.x.toFixed(4)}, ${SUN_DIRECTION.y.toFixed(4)}, ${SUN_DIRECTION.z.toFixed(4)}));
           float forward = max(dot(-viewDir, -sunDir), 0.0);
           float graze = 1.0 - abs(dot(normal, viewDir));
           float sheen = pow(forward, 7.0) * pow(graze, 2.2);
           gl_FragColor.rgb += sheen * ${SHEEN_STRENGTH.toFixed(3)};

           // Glitter. The cell hash is offset by the camera's own position, so
           // which crystals are catching the light changes as you ride past —
           // a fixed pattern reads as dirt on the lens.
           float near = 1.0 - smoothstep(6.0, 42.0, length(vWorld - cameraPosition));
           if (near > 0.01) {
             vec2 cell = floor(vWorld.xz * 22.0);
             float flash = hash21(cell + floor(cameraPosition.xz * 3.0));
             flash = smoothstep(0.9965, 1.0, flash);
             gl_FragColor.rgb += flash * near * ${GLITTER.toFixed(2)} * vec3(0.9, 0.96, 1.0);
           }
         }`
      );
  };

  // Any change to onBeforeCompile needs a distinct cache key. v7 moved the
  // piste width out of the source and into `aEdge`/`uEdgeSoft`; without the
  // bump the old program is served straight back out of the cache and none of
  // it takes effect.
  // It stays one key across every run, which is the point of making the width
  // data rather than source: two courses now share one compiled program.
  material.customProgramCacheKey = () => 'alpine-snow-v7';
  return material;
}
