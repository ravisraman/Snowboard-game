import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeRng, clamp } from '../core/mathx.js';

/**
 * Sky, sun and the mountain panorama.
 *
 * The backdrop is a single group that rides along with the camera on X/Z but
 * never on Y, so the peaks read as genuinely distant while still growing
 * against the skyline as the rider drops down the valley.
 */

export const SUN_DIRECTION = new THREE.Vector3(-0.66, 0.72, 0.28).normalize();
export const HORIZON_COLOR = new THREE.Color('#c3d9ec');

/**
 * Aerial perspective.
 *
 * The panorama used to wash each range toward the horizon colour by a constant
 * chosen per ring, and that is what made it read as four flats on a stage: a
 * range had one haze value from its feet to its summit and from its nearest
 * spur to its furthest crest, so it came out as a single tone with a jagged top
 * edge. Depth was in the *ordering* of the layers and nowhere inside them.
 *
 * What replaces it is the real relationship, which is worth stating because
 * every number below follows from it: haze is extinction along the line of
 * sight, so it grows with distance, and air is denser low down, so it grows
 * faster near the valley floor than near a summit. Two consequences fall out
 * for free, and both are things the eye reads as distance — a peak's base is
 * always hazier than its top, and a spur pointing at you is always clearer than
 * the crest behind it, *within the same range*.
 *
 * `EXTINCTION_M` is the distance at which a ray has lost 1/e of its contrast.
 *
 * `VALLEY_MURK` and `SCALE_HEIGHT_M` are the second term, and it exists for a
 * reason distance alone cannot cover. The scene's own `FogExp2` is total by
 * about a kilometre — the snowfields are entirely dissolved into the horizon
 * colour by the time they reach the panorama's inner edge — so the feet of the
 * nearest range have to arrive already almost gone or there is a hard band
 * where one system stops and the other starts. Distance extinction at 820 m
 * gives 16%, which is nowhere near it. The murk is what sits in the valley and
 * thins going up, and it is also, incidentally, the thing that makes a range
 * look like it is standing in air rather than cut out of it.
 */
const EXTINCTION_M = 13000;
const VALLEY_MURK = 0.96;
const SCALE_HEIGHT_M = 95;

/**
 * What the haze is *made of*, which is not one colour.
 *
 * Looking toward the sun you are looking into forward-scattered light and the
 * air between you and a mountain is bright and warm; looking away from it that
 * same air is scattering blue at you. This is the difference between a range
 * that sits in weather and one that has been faded toward grey, and it costs a
 * dot product.
 */
const HAZE_AWAY = new THREE.Color('#8fb6e4');
const HAZE_TOWARD = new THREE.Color('#cfdcec');

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAG = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 uZenith;
  uniform vec3 uMid;
  uniform vec3 uHorizon;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  uniform float uTime;
  uniform float uCirrus;

  /* --- noise, for the cirrus ------------------------------------------ */

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  float fbm(vec2 p) {
    float s = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      s += a * vnoise(p);
      p *= 2.03;
      a *= 0.5;
    }
    return s;
  }

  void main() {
    vec3 dir = normalize(vDir);
    float h = clamp(dir.y, -1.0, 1.0);
    vec3 sunDir = normalize(uSunDir);
    float sun = max(dot(dir, sunDir), 0.0);

    /* --- the gradient -------------------------------------------------
     *
     * Three stops rather than two. A real clear sky is not a single ramp: it
     * is deep overhead, and then there is a distinctly paler band sitting on
     * the horizon where you are looking through the most air. Interpolating
     * straight from zenith to horizon puts that pale band nowhere and leaves
     * the middle of the sky — which is most of what a chase camera frames —
     * reading as one flat wash of blue. */
    float up = clamp(h, 0.0, 1.0);
    vec3 col = mix(uHorizon, uMid, pow(up, 0.42));
    col = mix(col, uZenith, pow(up, 1.35));

    // The horizon's own glow, tight to the skyline.
    col += uHorizon * 0.14 * pow(1.0 - abs(h), 9.0);

    /* --- cirrus -------------------------------------------------------
     *
     * Projected onto a flat deck rather than painted on the dome:
     * dir.xz / dir.y is where the view ray crosses a plane at unit height,
     * so the noise foreshortens toward the horizon exactly as a real cloud
     * layer does. Texturing the sphere directly instead gives cloud that is
     * the same size overhead and at the skyline, which reads immediately as a
     * painted ceiling.
     *
     * Stretched hard in one axis, because that is what cirrus is — ice blown
     * out into filaments along the wind at altitude. The domain warp on the
     * second sample is what bends those filaments into hooks instead of
     * leaving them as parallel stripes. */
    if (uCirrus > 0.0 && h > 0.0) {
      vec2 deck = dir.xz / max(h, 0.045);
      vec2 p = deck * vec2(5.0, 1.4) + vec2(uTime * 0.021, uTime * 0.007);
      float warp = fbm(deck * 0.8 + uTime * 0.008);
      float n = fbm(p + warp * 1.6);

      // Coverage: high threshold, so the sky is mostly empty and the cloud
      // that does exist has edges. A low threshold gives overcast.
      float cover = smoothstep(0.47, 0.74, n);
      // Gone at the horizon, where the projection stretches to infinity and
      // would smear a single noise cell across the whole skyline, and eased in
      // above it so the deck has a visible near edge.
      cover *= smoothstep(0.02, 0.30, h) * (1.0 - smoothstep(0.72, 1.0, h) * 0.45);

      // Thin ice cloud does not shade, it scatters — brightest when you are
      // looking through it toward the sun, which is the whole reason cirrus is
      // worth drawing at all.
      vec3 cloud = mix(vec3(0.94, 0.96, 1.0), uSunColor * 1.25, pow(sun, 2.2) * 0.8);
      col = mix(col, cloud, cover * uCirrus);
    }

    /* --- the sun ------------------------------------------------------ */
    col += uSunColor * pow(sun, 1400.0) * 2.2;   // the disc, with a soft limb
    col += uSunColor * pow(sun, 120.0) * 0.42;   // the aureole tight around it
    col += uSunColor * pow(sun, 22.0) * 0.22;    // the haze bloom beyond that
    col += uSunColor * pow(sun, 3.0) * 0.14;     // broad wash across that side

    /* --- dither -------------------------------------------------------
     *
     * A sky is the one thing in the frame that is a slow gradient across a
     * thousand pixels, which is precisely the case eight-bit output cannot
     * hold: it comes out as visible steps. A little noise below the size of a
     * quantisation step turns the steps into grain, which the eye does not
     * see. Cheaper and better than any amount of extra colour precision. */
    col += (hash(gl_FragCoord.xy) - 0.5) * 0.004;

    gl_FragColor = vec4(col, 1.0);
  }
`;

export function buildSky(quality = {}) {
  const geometry = new THREE.SphereGeometry(7000, 32, 20);
  const material = new THREE.ShaderMaterial({
    // Authored for the tone mapper, not for the eye. These values are what
    // ACES has to *start* from to land on the winter blue we want; read
    // straight they look oversaturated, which is exactly the point — the
    // curve desaturates and lifts everything it touches.
    uniforms: {
      // The horizon deliberately matches the fog colour exactly. Both are tone
      // mapped by the same curve now, so matching the inputs is what makes the
      // seam where the fogged snowfields meet the sky disappear.
      uZenith: { value: new THREE.Color('#1f7ae8') },
      // The band between. Not a midpoint of the other two — it is a real stop,
      // and picking it a little greener and less saturated than the average is
      // what stops the gradient reading as one colour fading out.
      uMid: { value: new THREE.Color('#6ba8e4') },
      uHorizon: { value: HORIZON_COLOR.clone() },
      uSunColor: { value: new THREE.Color('#ffe9c2') },
      uSunDir: { value: SUN_DIRECTION.clone() },
      uTime: { value: 0 },
      // A phone pays five noise octaves twice per pixel across the whole upper
      // frame for this, which is exactly the shape of work its GPU is worst at
      // — the same reason the tier gives up bloom and the occlusion pass.
      uCirrus: { value: quality.cirrus === false ? 0 : (quality.cirrus ?? 0.8) },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  mesh.name = 'sky';
  return mesh;
}

/**
 * A reflection probe of the sky.
 *
 * Rendered once at startup from the sky shader itself, so the board's base, its
 * steel edge and the goggle lens reflect the actual sky they are under rather
 * than a guess. Without it a metal has nothing to be metallic *about* and comes
 * out as flat grey paint — which is what the edge and the goggles looked like.
 *
 * Deliberately not applied to the whole scene: giving every material an image
 * based light changes the snow's balance completely, and the snow's lighting is
 * hand-tuned.
 */
export function buildSkyProbe(renderer) {
  const scene = new THREE.Scene();
  scene.add(buildSky());
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const target = pmrem.fromScene(scene, 0, 1, 12000);
  pmrem.dispose();
  return target.texture;
}

/* ------------------------------------------------------------------
 * Peaks
 * ---------------------------------------------------------------- */

/**
 * Gradient noise, -1..1. Value noise is fine for lumps in a snowfield and wrong
 * for a mountain range: its features line up with its lattice, and folding it
 * into ridges turns that into crestlines that all run north-south or east-west.
 */
function gradNoise(x, y, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const g = (ix, iy, dx, dy) => {
    let h = Math.imul(ix, 0x1f1f1f1f) ^ Math.imul(iy, 0x2545f491) ^ Math.imul(seed, 0x9e3779b1);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    const a = ((h >>> 0) / 4294967296) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const a = g(xi, yi, xf, yf);
  const b = g(xi + 1, yi, xf - 1, yf);
  const c = g(xi, yi + 1, xf, yf - 1);
  const d = g(xi + 1, yi + 1, xf - 1, yf - 1);
  return (a + (b - a) * u + (c + (d - c) * u - (a + (b - a) * u)) * v) * 1.41;
}

/**
 * Ridged multifractal — the standard trick for mountains, and the reason these
 * ranges have crests rather than lumps.
 *
 * Ordinary fractal noise gives rolling hills: its extremes are smooth maxima,
 * so every summit is a dome. Folding the noise about zero (`1 - |n|`) turns
 * those crossings into creases. The *multi* part is that each octave is
 * weighted by the one before it, so detail piles up along the crests and the
 * valley floors between them stay smooth — which is what erosion does, and what
 * a plain sum of ridged octaves, equally rough everywhere, does not.
 */
function ridged(x, y, seed, octaves = 6) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let freq = 1;
  let prev = 1;
  for (let o = 0; o < octaves; o++) {
    let r = 1 - Math.abs(gradNoise(x * freq, y * freq, seed + o * 131));
    r *= r;
    sum += amp * r * (o === 0 ? 1 : clamp(prev * 1.7, 0, 1));
    norm += amp;
    prev = r;
    amp *= 0.46;
    freq *= 2.13;
  }
  return sum / norm;
}

/**
 * One range: a band of mountains wrapped all the way round the horizon, built
 * as a height field over an annulus rather than as a row of separate peaks. A
 * real range is *continuous* — a crestline that rises into summits and drops
 * into cols, with spurs running down toward you — and you cannot get cols and
 * spurs out of objects that do not touch.
 *
 * The mesh is dense and smooth-shaded, and that is the point of this version.
 * It used to be a few thousand flat-shaded facets, ten rows from foot to
 * summit, and what that draws is not a mountain but a sheet of crumpled paper
 * with long vertical slivers hanging off the skyline. Everything that reads as
 * rock, snow or forest is now decided per pixel in the shader; the geometry's
 * only job is to be the right *shape*, which takes a lot more of it.
 */
function buildRange(rng, ring) {
  const seed = rng.int(0, 100000);
  const { thetaSteps, rSteps } = ring;
  const depth = ring.outer - ring.inner;
  const f = 1 / ring.featureSize;

  const heightAt = (x, z, t) => {
    // Bend the lattice first, so ridges wander instead of running straight.
    const wx = gradNoise(x * f * 0.45, z * f * 0.45, seed + 11) * 0.5;
    const wz = gradNoise(x * f * 0.45 + 7.3, z * f * 0.45 - 2.1, seed + 23) * 0.5;
    const crest = ridged(x * f + wx, z * f + wz, seed);

    // Massifs: a slow envelope that lifts whole sections of the range and drops
    // others into passes, so the skyline has a rhythm instead of a uniform saw.
    const massif = clamp(
      0.42 + 0.5 * (gradNoise(x * f * 0.21, z * f * 0.21, seed + 7717) * 0.5 + 0.5)
        + 0.3 * Math.max(0, gradNoise(x * f * 0.5, z * f * 0.5, seed + 991)),
      0, 1);

    // Front-to-back envelope: the range rises out of the valley floor, tops out
    // a little before its middle, and falls away behind.
    const band = Math.sin(Math.PI * Math.pow(t, 0.8));

    // A broad base carrying a crest. The base is what gives a mountain its
    // bulk — with the ridges alone a range comes out as a row of needles.
    return ring.height * band * massif * (0.3 + 0.7 * Math.pow(crest, 1.25));
  };

  const cols = thetaSteps;           // wraps
  const rows = rSteps + 1;
  const count = cols * rows;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const info = new Float32Array(count * 4);
  const occ = new Float32Array(count);
  const heights = new Float32Array(count);

  for (let j = 0; j < rows; j++) {
    // Rows packed toward the viewer's side of the range, where the faces that
    // are actually seen are; the back of a mountain needs very little.
    const t = Math.pow(j / rSteps, 1.25);
    const r = ring.inner + t * depth;
    for (let i = 0; i < cols; i++) {
      const theta = (i / cols) * Math.PI * 2;
      const x = Math.sin(theta) * r;
      const z = Math.cos(theta) * r;
      const k = j * cols + i;
      const y = heightAt(x, z, t);
      heights[k] = y;
      positions[k * 3] = x;
      positions[k * 3 + 1] = y;
      positions[k * 3 + 2] = z;
      info[k * 4] = ring.height;
      info[k * 4 + 1] = ring.treeline;
      info[k * 4 + 2] = ring.detailScale;
      info[k * 4 + 3] = ring.snowline;
    }
  }

  const at = (i, j) => ((j < 0 ? 0 : j >= rows ? rows - 1 : j) * cols + ((i % cols) + cols) % cols);
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      const a = at(i - 1, j) * 3;
      const b = at(i + 1, j) * 3;
      const c = at(i, j - 1) * 3;
      const d = at(i, j + 1) * 3;
      e1.set(positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]);
      e2.set(positions[d] - positions[c], positions[d + 1] - positions[c + 1], positions[d + 2] - positions[c + 2]);
      n.crossVectors(e1, e2).normalize();
      if (n.y < 0) n.negate();
      normals[k * 3] = n.x;
      normals[k * 3 + 1] = n.y;
      normals[k * 3 + 2] = n.z;

      /*
       * Baked occlusion: how far this point sits below its neighbourhood. A
       * gully is darker than the spur beside it for reasons that have nothing
       * to do with which way either faces — it sees less sky — and without
       * that a ridged height field shades like a relief map lit by a torch.
       */
      let sum = 0;
      let m = 0;
      for (let dj = -4; dj <= 4; dj += 2) {
        for (let di = -4; di <= 4; di += 2) {
          sum += heights[at(i + di, j + dj)];
          m++;
        }
      }
      occ[k] = clamp(0.62 + (heights[k] - sum / m) / (ring.height * 0.085), 0, 1);
    }
  }

  const index = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * cols + i;
      const b = j * cols + ((i + 1) % cols);
      const c = a + cols;
      const d = b + cols;
      index.push(a, c, d, a, d, b);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('aInfo', new THREE.BufferAttribute(info, 4));
  geo.setAttribute('aOcc', new THREE.BufferAttribute(occ, 1));
  geo.setIndex(index);
  return geo;
}

const PANORAMA_VERT = /* glsl */ `
  attribute vec4 aInfo;
  attribute float aOcc;
  varying vec3 vPos;
  varying vec3 vNrm;
  varying vec4 vInfo;
  varying float vOcc;
  void main() {
    vPos = position;
    vNrm = normal;
    vInfo = aInfo;
    vOcc = aOcc;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * The mountain, per pixel.
 *
 * Three materials and the rules for where each one lives, which are the whole
 * of what makes a height field read as an alpine range:
 *
 * **Snow lies where the ground can hold it.** Steep faces shed it and come out
 * as bare rock; shoulders, bowls and summit fields stay white. The threshold is
 * broken up with noise so the boundary is a ragged edge of couloirs and ledges
 * rather than a contour line.
 *
 * **Forest stops at the treeline.** Dark conifer on the lower flanks, thinning
 * out and breaking into fingers as it climbs. This is the single biggest value
 * contrast in a winter landscape, and the thing whose absence made the old
 * panorama a wall of one grey: near-black forest under near-white snow.
 *
 * **Air is blue, and thicker low down.** Distance washes everything toward the
 * sky's own colour — warm on the sun's side, blue away from it — and the feet
 * of every range stand in valley haze, which is also what lets them dissolve
 * into the scene's own fog instead of meeting it on a seam.
 *
 * It is unlit as far as three.js is concerned: the scene's fill light is tuned
 * for snow ten metres away and is far too much for a peak at four kilometres,
 * so the sun and sky terms here are this shader's own.
 */
const PANORAMA_FRAG = /* glsl */ `
  varying vec3 vPos;
  varying vec3 vNrm;
  varying vec4 vInfo;
  varying float vOcc;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uSkyLight;
  uniform vec3 uHazeAway;
  uniform vec3 uHazeToward;
  uniform vec3 uHorizon;
  uniform float uExtinction;
  uniform float uMurk;
  uniform float uMurkHeight;

  float hash(vec2 p) {
    p = fract(p * vec2(233.34, 851.73));
    p += dot(p, p + 23.45);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float s = 0.0;
    float a = 0.5;
    for (int i = 0; i < DETAIL_OCTAVES; i++) {
      s += a * vnoise(p);
      p = p * 2.07 + 13.1;
      a *= 0.5;
    }
    return s;
  }

  void main() {
    vec3 Ng = normalize(vNrm);
    float H = vInfo.x;
    float treeline = vInfo.y;
    float s = vInfo.z;               // metres per unit of detail, per range
    float alt = vPos.y / H;

    // Two scales of breakup: buttress-sized and ledge-sized.
    float big = fbm(vPos.xz / (150.0 * s));
    float fine = fbm(vPos.xz / (34.0 * s) + 41.0);

    // Bump the fine relief into the normal, from screen-space derivatives, so
    // the lighting has rock structure in it that the mesh does not.
    vec3 N = Ng;
    {
      float h = (big * 0.6 + fine * 0.4) * 46.0 * s;
      vec3 dpx = dFdx(vPos);
      vec3 dpy = dFdy(vPos);
      float dhx = dFdx(h);
      float dhy = dFdy(h);
      vec3 r1 = cross(dpy, Ng);
      vec3 r2 = cross(Ng, dpx);
      float det = dot(dpx, r1);
      vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
      N = normalize(abs(det) * Ng - grad * 0.85);
    }

    /* --- what is on the ground here ---------------------------------- */

    // Rock: cold grey-brown, banded along the bedding and stained by the big
    // noise so a wall is not one flat tone.
    float strata = sin(vPos.y * 0.055 / s + big * 9.0 + fine * 3.0) * 0.5 + 0.5;
    vec3 rock = mix(vec3(0.060, 0.062, 0.075), vec3(0.150, 0.138, 0.135), big);
    rock *= 0.78 + 0.34 * strata;

    // Snow holds on anything gentler than a cliff.
    float steep = 1.0 - smoothstep(0.50, 0.70, Ng.y + (fine - 0.5) * 0.34 + (big - 0.5) * 0.12);
    float high = smoothstep(vInfo.w - 0.16, vInfo.w + 0.2, alt + (big - 0.5) * 0.3);
    // Up high even the walls are plastered; lower down they are swept bare.
    float snow = clamp(1.0 - steep * mix(1.0, 0.72, high), 0.0, 1.0);
    snow = max(snow, smoothstep(0.62, 0.9, fine) * 0.5 * high);
    vec3 albedo = mix(rock, vec3(0.93, 0.95, 0.98), snow);

    // Forest, to the treeline. The mask is three things multiplied: below the
    // (ragged) line, not on a cliff, and in a stand rather than a clearing.
    float trees = 0.0;
    if (treeline > 0.0) {
      float line = vPos.y + (big - 0.5) * treeline * 1.1 + (fine - 0.5) * treeline * 0.35;
      trees = 1.0 - smoothstep(treeline * 0.72, treeline * 1.08, line);
      trees *= smoothstep(0.42, 0.62, Ng.y);
      trees *= smoothstep(0.26, 0.44, fbm(vPos.xz / (260.0 * s) + 7.0) + trees * 0.2);
      // Individual crowns are far below a pixel out here; what survives the
      // distance is the stand's texture, dark trunks and snow-loaded tops.
      float crowns = vnoise(vPos.xz / (5.5 * s));
      vec3 forest = mix(vec3(0.016, 0.034, 0.030), vec3(0.060, 0.095, 0.080), crowns);
      forest = mix(forest, vec3(0.80, 0.86, 0.92), smoothstep(0.55, 0.95, crowns) * 0.42);
      albedo = mix(albedo, forest, trees);
    }

    /* --- light -------------------------------------------------------- */

    vec3 L = normalize(uSunDir);
    float ndl = dot(N, L);
    // Snow wraps light past the terminator; rock and forest do not.
    float wrap = mix(0.0, 0.28, snow * (1.0 - trees));
    float sun = clamp((ndl + wrap) / (1.0 + wrap), 0.0, 1.0);
    float sky = 0.55 + 0.45 * N.y;
    float occ = mix(0.42, 1.0, vOcc);
    vec3 col = albedo * (uSunColor * sun * mix(0.75, 1.0, vOcc) + uSkyLight * sky * occ);

    /* --- air ---------------------------------------------------------- */

    float dist = length(vPos);
    float byDistance = 1.0 - exp(-dist / uExtinction);
    vec2 bearing = normalize(vPos.xz);
    float toward = dot(bearing, normalize(L.xz));
    vec3 haze = mix(uHazeAway, uHazeToward, smoothstep(-0.35, 0.95, toward));
    col = mix(col, haze, byDistance);

    // Valley air: the same colour as the scene's fog, so the two meet unseen.
    float murk = exp(-max(vPos.y, 0.0) / uMurkHeight) * uMurk;
    col = mix(col, uHorizon, clamp(murk, 0.0, 1.0));

    gl_FragColor = vec4(col, 1.0);
  }
`;

/**
 * Four ranges, nested, each a continuous crestline wrapped round the horizon.
 *
 * Depth comes from three things working together, and all three have to be
 * there or the panorama flattens: each range is *further*, so it is smaller for
 * its height; each has more air in front of it; and each overlaps the one
 * behind, so the eye gets occlusion to read the order from.
 *
 * The nearest is a band of forested foothills, which bridges the gap between
 * the far edge of the snowfields and the first real range and gives the white
 * foreground something dark to sit against.
 *
 * `treeline` is in metres above the valley floor; `detailScale` stretches the
 * shader's rock and forest texture so a far range is not textured finer than a
 * pixel, which is what makes distant procedural detail crawl.
 */
export const PANORAMA_RINGS = [
  {
    inner: 760, outer: 2900, height: 330, featureSize: 620,
    thetaSteps: 420, rSteps: 30,
    treeline: 300, snowline: 0.9, detailScale: 0.55,
  },
  {
    inner: 2100, outer: 4700, height: 900, featureSize: 1250,
    thetaSteps: 520, rSteps: 60,
    treeline: 330, snowline: 0.42, detailScale: 1.0,
  },
  {
    inner: 3800, outer: 6500, height: 1650, featureSize: 1700,
    thetaSteps: 460, rSteps: 52,
    treeline: 300, snowline: 0.36, detailScale: 1.7,
  },
  {
    inner: 5600, outer: 7700, height: 2500, featureSize: 2000,
    thetaSteps: 360, rSteps: 40,
    treeline: 0, snowline: 0.3, detailScale: 2.4,
  },
];

/** How far below the camera the valley floor of the panorama sits, at rest. */
export const PANORAMA_SINK = 60;

export function buildMountains(seed = 909, quality = {}) {
  const rng = makeRng(seed);
  const group = new THREE.Group();
  group.name = 'panorama';

  const detail = quality.panoramaDetail ?? 1;

  const parts = [];
  for (const ring of PANORAMA_RINGS) {
    parts.push(buildRange(rng, {
      ...ring,
      thetaSteps: Math.max(96, Math.round(ring.thetaSteps * detail)),
      rSteps: Math.max(12, Math.round(ring.rSteps * detail)),
    }));
  }

  const material = new THREE.ShaderMaterial({
    defines: { DETAIL_OCTAVES: quality.panoramaOctaves ?? 4 },
    uniforms: {
      uSunDir: { value: SUN_DIRECTION.clone() },
      // Linear and a little over 1 between them: sunlit snow out here should
      // land where the sunlit piste does, so the tone mapper treats the two as
      // the same substance.
      uSunColor: { value: new THREE.Color(1.0, 0.94, 0.84).multiplyScalar(0.86) },
      uSkyLight: { value: new THREE.Color(0.34, 0.5, 0.82).multiplyScalar(0.36) },
      uHazeAway: { value: HAZE_AWAY.clone() },
      uHazeToward: { value: HAZE_TOWARD.clone() },
      uHorizon: { value: HORIZON_COLOR.clone() },
      uExtinction: { value: EXTINCTION_M },
      uMurk: { value: VALLEY_MURK },
      uMurkHeight: { value: SCALE_HEIGHT_M },
    },
    vertexShader: PANORAMA_VERT,
    fragmentShader: PANORAMA_FRAG,
    fog: false,
  });

  // One mesh, because it is always entirely on screen or entirely behind you
  // and there is nothing to cull.
  const mesh = new THREE.Mesh(mergeGeometries(parts, false), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -950;
  group.add(mesh);

  // Sunk a little, so the valley floor crops the very feet of the ranges and
  // they rise out of the haze rather than standing on top of it.
  group.position.y = -PANORAMA_SINK;
  return group;
}

/* ------------------------------------------------------------------
 * Clouds
 * ---------------------------------------------------------------- */

/**
 * A band of cloud caught between the ranges.
 *
 * Deliberately low and thin. A clear winter morning does not have weather in
 * it — what it has is a line of cloud snagged on the peaks, and that line is
 * worth having because it is the only thing in the upper half of the frame that
 * is not a triangle.
 *
 * Each puff is a quad, and the whole thing lives or dies on two things.
 *
 * The edges, first: a hard-edged quad four kilometres away reads unmistakably
 * as a white rectangle stuck to a mountain. So the shader fades each one
 * radially to nothing well inside its own corners, and a cloud is the overlap
 * of a handful of them rather than any single shape.
 *
 * And which way they face. These used to be *horizontal* quads, which is the
 * obvious way to build a cloud deck and completely wrong for this camera: the
 * viewer is at valley level looking at cloud four hundred metres up and a
 * kilometre and a half out, so every quad was seen almost edge-on and
 * foreshortened into a thin streak. They did not read as cloud. They read as
 * smears on the lens. Standing them upright and turning each one to face the
 * middle of the world — which is where the camera always is, since the backdrop
 * rides with it — costs one rotation at build time and is the whole fix.
 */

const CLOUD_VERT = /* glsl */ `
  attribute vec2 aPuffUv;
  varying vec2 vPuffUv;
  varying vec3 vColor;
  void main() {
    vPuffUv = aPuffUv;
    vColor = color;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const CLOUD_FRAG = /* glsl */ `
  varying vec2 vPuffUv;
  varying vec3 vColor;
  uniform float uOpacity;
  void main() {
    // Radial falloff from the middle of the puff, squared so the edge is soft
    // over most of the quad rather than only at the very rim.
    float r = length(vPuffUv - 0.5) * 2.0;
    float a = 1.0 - smoothstep(0.15, 1.0, r);
    a *= a;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor, a * uOpacity);
  }
`;

export function buildClouds(seed = 4471) {
  const rng = makeRng(seed);
  const positions = [];
  const colors = [];
  const uvs = [];
  const col = new THREE.Color();

  const BRIGHT = new THREE.Color('#ffffff');
  const SHADE = new THREE.Color('#b9cfe4');

  for (let i = 0; i < 16; i++) {
    const angle = rng() * Math.PI * 2;
    // Out beyond the second range, and high.
    //
    // These used to sit at 1500 m and 400 m up, which put them squarely in
    // front of the near peaks — and a soft translucent quad crossing a
    // mountain does not read as cloud in front of it, it reads as a smudge on
    // the picture. Behind the near ranges and above their summits, they are
    // unambiguously weather sitting between one range and the next, which is
    // the whole thing they were for.
    const dist = 2500 + rng() * 1500;
    const cx = Math.sin(angle) * dist;
    const cz = Math.cos(angle) * dist;
    // High enough to clear the near crestlines, low enough to still be caught
    // between ranges rather than floating free in the middle of the sky.
    const cy = 640 + rng() * 430;

    // The quad's own axes, once per cloud: `right` runs along the horizon at
    // this bearing and `up` is up. Both are perpendicular to the line of sight,
    // so the puff presents its full area to the camera instead of its edge.
    const rightX = Math.cos(angle);
    const rightZ = -Math.sin(angle);

    // Each cloud is a handful of overlapping quads offset from each other,
    // which from a fixed viewpoint reads as depth without any of the cost.
    const puffs = rng.int(5, 9);
    for (let p = 0; p < puffs; p++) {
      // Much wider than tall. Cloud snagged on a ridge spreads along it.
      const w = 360 + rng() * 760;
      const hgt = 110 + rng() * 210;
      const along = rng.spread(680);
      const oy = rng.spread(130);
      const depth = rng.spread(260);   // in and out, so they are not coplanar

      // Underside darker than the top edge, which is the whole shape cue. The
      // vertical span is now real, so this finally has somewhere to show.
      col.copy(BRIGHT).lerp(SHADE, 0.10 + rng() * 0.28).lerp(HORIZON_COLOR, 0.2);

      const bx = cx + rightX * along + Math.sin(angle) * depth;
      const bz = cz + rightZ * along + Math.cos(angle) * depth;
      const by = cy + oy;

      // Corner (u, v) in the puff's own plane, u across and v up.
      const V = (u, v) => positions.push(
        bx + rightX * u * w * 0.5,
        by + v * hgt * 0.5,
        bz + rightZ * u * w * 0.5,
      );

      V(-1, -1); V(1, 1); V(1, -1);
      V(-1, -1); V(-1, 1); V(1, 1);
      uvs.push(0, 0, 1, 1, 1, 0);
      uvs.push(0, 0, 0, 1, 1, 1);
      for (let v = 0; v < 6; v++) colors.push(col.r, col.g, col.b);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('aPuffUv', new THREE.Float32BufferAttribute(uvs, 2));

  const mesh = new THREE.Mesh(
    geo,
    new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0.55 } },
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
    })
  );
  mesh.renderOrder = -900;   // after the sky, before everything solid
  mesh.frustumCulled = false;
  mesh.name = 'clouds';
  return mesh;
}

/* ------------------------------------------------------------------
 * Lighting
 * ---------------------------------------------------------------- */

export function buildLighting(scene, quality = {}) {
  const mapSize = quality.shadowMapSize ?? 2048;
  const extent = quality.shadowExtent ?? 68;
  // Warm, low-ish winter sun raking across the slope from one side.
  const sun = new THREE.DirectionalLight('#fff6e6', 2.6);
  sun.castShadow = quality.shadows !== false;
  sun.shadow.mapSize.set(mapSize, mapSize);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 460;
  sun.shadow.camera.left = -extent;
  sun.shadow.camera.right = extent;
  sun.shadow.camera.top = extent;
  sun.shadow.camera.bottom = -extent;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.035;
  scene.add(sun);
  scene.add(sun.target);

  // Snow bounces a lot of light back up, and the sky fills the shadows blue —
  // but keep the fill low. Too much of it and the slope flattens into white
  // paper and the shadows stop reading at all.
  const hemi = new THREE.HemisphereLight('#a2c9f0', '#e2eefa', 0.72);
  scene.add(hemi);

  const fill = new THREE.AmbientLight('#e4eff9', 0.2);
  scene.add(fill);

  /** Keeps the shadow frustum tight around the rider. */
  const follow = (target) => {
    sun.target.position.copy(target);
    sun.position.copy(target).addScaledVector(SUN_DIRECTION, 190);
    sun.target.updateMatrixWorld();
  };

  return { sun, hemi, fill, follow };
}
