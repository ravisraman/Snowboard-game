import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeRng, clamp, smoothstep, valueNoise2 } from '../core/mathx.js';

/**
 * Sky, sun and the mountain panorama.
 *
 * The backdrop is a single group that rides along with the camera on X/Z but
 * never on Y, so the peaks read as genuinely distant while still growing
 * against the skyline as the rider drops down the valley.
 */

export const SUN_DIRECTION = new THREE.Vector3(-0.66, 0.72, 0.28).normalize();
export const HORIZON_COLOR = new THREE.Color('#c3d9ec');

/** The conifer band that wraps the lower slopes of every range. */
const FOREST_COLOR = new THREE.Color('#3d5a66');

/** Snow out of the sun goes blue, not grey — it is lit by sky alone. */
const SNOW_SHADOW = new THREE.Color('#7ba3cd');

/** The warm rim a face picks up when it is turned toward a low winter sun. */
const SUN_WARM = new THREE.Color('#ffeacb');

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
  uniform vec3 uHorizon;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;

  void main() {
    vec3 dir = normalize(vDir);
    float h = clamp(dir.y, -1.0, 1.0);

    // Deep blue overhead easing to a pale, slightly warm horizon. The exponent
    // decides how low the blue reaches: the chase camera sits close to the
    // horizon, so most of the sky the player ever sees is the bottom of this
    // gradient and a gentle curve leaves the whole frame washed out.
    float t = pow(clamp(h, 0.0, 1.0), 0.35);
    vec3 col = mix(uHorizon, uZenith, t);

    // A little extra light just above the skyline.
    col += uHorizon * 0.16 * pow(1.0 - abs(h), 8.0);

    float sun = max(dot(dir, normalize(uSunDir)), 0.0);
    col += uSunColor * pow(sun, 900.0) * 1.9;   // the disc
    col += uSunColor * pow(sun, 34.0) * 0.5;    // tight glow
    col += uSunColor * pow(sun, 4.0) * 0.16;    // broad wash across that side

    gl_FragColor = vec4(col, 1.0);
  }
`;

export function buildSky() {
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
      uHorizon: { value: HORIZON_COLOR.clone() },
      uSunColor: { value: new THREE.Color('#ffe9c2') },
      uSunDir: { value: SUN_DIRECTION.clone() },
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

/* ------------------------------------------------------------------
 * Peaks
 * ---------------------------------------------------------------- */

/**
 * Ridged fractal noise — the standard trick for mountains, and the reason these
 * ranges have crests rather than lumps.
 *
 * Ordinary fractal noise gives you rolling hills: its extremes are smooth
 * maxima, so every summit is a dome. Folding the noise about its midpoint
 * (`1 - |2n - 1|`) turns those smooth crossings into creases, and stacking
 * octaves of *that* gives sharp ridgelines with spurs and gullies hanging off
 * them, which is what an alpine range actually is.
 */
function ridged(x, y, seed, octaves = 5, lacunarity = 2.07, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let o = 0; o < octaves; o++) {
    const n = valueNoise2(fx, fy, seed + o * 131);
    const r = 1 - Math.abs(n * 2 - 1);
    // Squaring sharpens the crest and deepens the valleys between them.
    sum += amp * r * r;
    norm += amp;
    amp *= gain;
    fx *= lacunarity;
    fy *= lacunarity;
  }
  return sum / norm;
}

/**
 * One range: a band of mountains wrapped all the way round the horizon, built
 * as a height field over an annulus rather than as a row of separate peaks.
 *
 * That is the whole change in approach. Isolated cones read as cones however
 * carefully they are shaded — a real range is *continuous*, a crestline that
 * rises into summits and drops into cols with spurs running down toward you,
 * and you cannot get cols and spurs out of objects that do not touch. A polar
 * height field gets all of it for a few thousand triangles.
 */
function buildRange(rng, ring) {
  const positions = [];
  const colors = [];

  const seed = rng.int(0, 100000);
  const thetaSteps = ring.thetaSteps;
  const rSteps = ring.rSteps;
  const depth = ring.outer - ring.inner;

  const rockCol = new THREE.Color(ring.rock);
  const snowCol = new THREE.Color(ring.snow);

  /** Height of the range at a point on the annulus. */
  const heightAt = (theta, t) => {
    // Arc length, so noise features are a consistent size in metres however far
    // out the range sits — otherwise the distant ranges come out visibly
    // stretched sideways.
    const mid = ring.inner + depth * 0.5;
    const s = theta * mid;
    const r = ring.inner + t * depth;

    // The crest. Low frequency along the arc so summits are hundreds of metres
    // apart, and much slower still across the range so ridges run toward the
    // viewer rather than parallel to the horizon.
    const crest = ridged(s / ring.featureSize, r / (ring.featureSize * 2.6), seed);

    // Massifs: a slow envelope that lifts whole sections of the range and drops
    // others into passes, so the skyline has a rhythm instead of a uniform saw.
    const massif = 0.55 + 0.72 * valueNoise2(s / (ring.featureSize * 5.5), 0.5, seed + 7717);

    // Front-to-back envelope: the range rises out of the valley floor, tops out
    // a little past its middle, and falls away behind.
    const band = Math.sin(Math.PI * Math.pow(t, 0.78));

    return ring.height * Math.pow(crest, 1.15) * massif * band;
  };

  const P = (theta, t) => {
    const r = ring.inner + t * depth;
    return new THREE.Vector3(Math.sin(theta) * r, heightAt(theta, t), Math.cos(theta) * r);
  };

  const col = new THREE.Color();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const nrm = new THREE.Vector3();

  /**
   * Shades one facet and writes it out.
   *
   * Snow lies where the ground is flat enough to hold it. That single rule is
   * what turns a white pyramid into a mountain: the steep faces come out as
   * bare rock, the shoulders and the summit fields stay white, and the snowline
   * ends up ragged for free because the surface is ragged. Painting a snowline
   * at a fixed altitude instead gives you a wedding cake.
   */
  const face = (p, q, r) => {
    ab.subVectors(q, p);
    ac.subVectors(r, p);
    nrm.crossVectors(ab, ac).normalize();
    if (nrm.y < 0) nrm.negate();

    const sun = Math.max(0, nrm.dot(SUN_DIRECTION));
    const midY = (p.y + q.y + r.y) / 3;
    const altitude = clamp(midY / ring.height, 0, 1);

    // Flat enough, and high enough. Altitude gates it — nothing below the
    // snowline holds snow whatever its angle — and the slope then decides how
    // much: a plastered face up high keeps a quarter of it, a shoulder keeps
    // all of it, and the sheer walls stay bare rock, which is where all the
    // contrast in a real range comes from. The altitude term is jittered by the
    // facet's own position so the line never reads as a contour.
    const flat = smoothstep(0.5, 0.86, nrm.y);
    const jitter = valueNoise2(p.x * 0.004, p.z * 0.004, seed + 313) * 0.18;
    const high = smoothstep(ring.snowline - 0.08, ring.snowline + 0.26, altitude + jitter);
    const snowAmount = clamp(high * (0.12 + 0.9 * flat), 0, 1);

    col.copy(rockCol).lerp(snowCol, snowAmount);

    // Sunlit and shaded faces on a snow peak differ in hue more than in value —
    // one is warm white, the other is lit by blue sky alone. Darkening without
    // the hue shift is exactly what makes CG mountains look like grey card.
    col.lerp(SNOW_SHADOW, (1 - sun) * (0.34 + 0.34 * snowAmount));
    col.multiplyScalar(0.52 + 0.62 * sun);

    // Forward scatter: faces turned toward the sun pick up a warm rim. It is a
    // small effect and it does more for the sense of distance than the haze.
    col.lerp(SUN_WARM, Math.pow(sun, 3.5) * 0.3);

    // A conifer band around the feet of the nearer ranges.
    if (ring.forest > 0) {
      const band = smoothstep(0.015, 0.06, altitude) * (1 - smoothstep(0.1, 0.28, altitude));
      col.lerp(FOREST_COLOR, band * ring.forest * (1 - snowAmount * 0.55));
    }

    // Aerial perspective, heaviest at the base: the air between you and the
    // mountain is what dissolves the line where the fogged snowfields end, and
    // what plants the range behind the valley rather than standing on it.
    const f = (1 - altitude) * (1 - altitude);
    col.lerp(HORIZON_COLOR, clamp(ring.haze + (1 - ring.haze) * 0.45 * f, 0, 1));

    for (const v of [p, q, r]) {
      positions.push(v.x, v.y, v.z);
      colors.push(col.r, col.g, col.b);
    }
  };

  for (let i = 0; i < thetaSteps; i++) {
    const t0 = (i / thetaSteps) * Math.PI * 2;
    const t1 = ((i + 1) / thetaSteps) * Math.PI * 2;
    for (let j = 0; j < rSteps; j++) {
      const a = j / rSteps;
      const b = (j + 1) / rSteps;
      const p00 = P(t0, a);
      const p10 = P(t1, a);
      const p01 = P(t0, b);
      const p11 = P(t1, b);
      face(p00, p01, p11);
      face(p00, p11, p10);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geo;
}

/**
 * Four ranges, nested, each a continuous crestline wrapped round the horizon.
 *
 * Depth comes from three things working together, and all three have to be
 * there or the panorama flattens: each range is *further*, so it is smaller for
 * its height; each is *hazier*, washed further toward the sky colour; and each
 * overlaps the one behind, so the eye gets occlusion to read the order from.
 *
 * The nearest is a band of foothills whose only job is to bridge the gap
 * between the fogged edge of the snowfields and the first real range — without
 * it the mountains stand on a visible seam.
 *
 * `rock` is really shaded snow: these are snow-plastered alpine faces, so the
 * dark side of a ridge is blue, not brown.
 */
export function buildMountains(seed = 909, quality = {}) {
  const rng = makeRng(seed);
  const group = new THREE.Group();
  group.name = 'panorama';

  const detail = quality.panoramaDetail ?? 1;
  const steps = (n) => Math.max(48, Math.round(n * detail));

  const rings = [
    {
      // Foothills. The inner edge reaches back almost to the far lip of the
      // playable snowfields — its height there is zero, so what it contributes
      // is a floor, filling the band of empty fog between where the terrain
      // stops and where the mountains start. Without it the ranges rise out of
      // a flat grey strip along a visible seam.
      inner: 820, outer: 2600, height: 300, featureSize: 360,
      thetaSteps: steps(150), rSteps: Math.max(4, Math.round(6 * detail)),
      snowline: 0.74, forest: 0.85, haze: 0.12,
      rock: '#38536e', snow: '#eef5fb',
    },
    {
      inner: 2200, outer: 3900, height: 1250, featureSize: 560,
      thetaSteps: steps(200), rSteps: Math.max(5, Math.round(9 * detail)),
      snowline: 0.5, forest: 0.42, haze: 0.03,
      rock: '#1d4470', snow: '#f3f8fd',
    },
    {
      inner: 3500, outer: 5600, height: 2100, featureSize: 820,
      thetaSteps: steps(190), rSteps: Math.max(5, Math.round(9 * detail)),
      snowline: 0.44, forest: 0.14, haze: 0.3,
      rock: '#3d6693', snow: '#f6fafe',
    },
    {
      inner: 5200, outer: 7400, height: 2950, featureSize: 1100,
      thetaSteps: steps(170), rSteps: Math.max(4, Math.round(7 * detail)),
      snowline: 0.4, forest: 0, haze: 0.58,
      rock: '#6a90b8', snow: '#f8fbff',
    },
  ];

  const parts = [];
  for (const ring of rings) {
    const geo = buildRange(rng, ring);
    // Sunk a little, so the valley floor crops the very feet of the ranges and
    // they rise out of the haze rather than standing on top of it.
    geo.translate(0, -30, 0);
    parts.push(geo);
  }

  // Unlit: the sun, the snowline and the atmosphere are all already in the
  // vertex colours. One mesh, because it is always entirely on screen or
  // entirely behind you and there is nothing to cull.
  const mesh = new THREE.Mesh(
    mergeGeometries(parts, false),
    new THREE.MeshBasicMaterial({ vertexColors: true, fog: false })
  );
  mesh.frustumCulled = false;
  mesh.renderOrder = -950;
  group.add(mesh);

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
 * Each puff is a horizontal quad, and the whole thing lives or dies on the
 * edges: a hard-edged quad four kilometres away reads unmistakably as a white
 * rectangle stuck to a mountain. So the shader fades each one radially to
 * nothing well inside its own corners, and the cloud is the overlap of a
 * handful of them rather than any single shape.
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

  for (let i = 0; i < 22; i++) {
    const angle = rng() * Math.PI * 2;
    // Between the near range and the far one. Further out than this and the
    // back ring simply hides them; nearer and they read as fog, not cloud.
    const dist = 1500 + rng() * 900;
    const cx = Math.sin(angle) * dist;
    const cz = Math.cos(angle) * dist;
    // Low enough to catch on the ranges rather than float free above them.
    const cy = 380 + rng() * 320;

    // Each cloud is a handful of overlapping quads at slightly different
    // heights, which from below reads as depth without any of the cost.
    const puffs = rng.int(4, 8);
    for (let p = 0; p < puffs; p++) {
      const w = 180 + rng() * 420;
      const d = 90 + rng() * 190;
      const ox = rng.spread(340);
      const oz = rng.spread(200);
      const oy = rng.spread(70);

      // Underside darker than the top edge, which is the whole shape cue.
      col.copy(BRIGHT).lerp(SHADE, 0.3 + rng() * 0.4).lerp(HORIZON_COLOR, 0.22);

      const x0 = cx + ox - w * 0.5;
      const x1 = cx + ox + w * 0.5;
      const z0 = cz + oz - d * 0.5;
      const z1 = cz + oz + d * 0.5;
      const y = cy + oy;

      positions.push(x0, y, z0, x1, y, z1, x1, y, z0);
      positions.push(x0, y, z0, x0, y, z1, x1, y, z1);
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
      uniforms: { uOpacity: { value: 0.85 } },
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
