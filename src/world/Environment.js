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
const EXTINCTION_M = 12000;
const VALLEY_MURK = 0.76;
const SCALE_HEIGHT_M = 300;

/**
 * What the haze is *made of*, which is not one colour.
 *
 * Looking toward the sun you are looking into forward-scattered light and the
 * air between you and a mountain is bright and warm; looking away from it that
 * same air is scattering blue at you. This is the difference between a range
 * that sits in weather and one that has been faded toward grey, and it costs a
 * dot product.
 */
const HAZE_AWAY = new THREE.Color('#a2c1e0');
const HAZE_TOWARD = new THREE.Color('#d2dde8');

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
  const hazeCol = new THREE.Color();
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
    col.multiplyScalar(0.44 + 0.72 * sun);

    // Forward scatter: faces turned toward the sun pick up a warm rim. It is a
    // small effect and it does more for the sense of distance than the haze.
    col.lerp(SUN_WARM, Math.pow(sun, 3.5) * 0.3);

    // A conifer band around the feet of the nearer ranges.
    if (ring.forest > 0) {
      const band = smoothstep(0.015, 0.06, altitude) * (1 - smoothstep(0.1, 0.28, altitude));
      col.lerp(FOREST_COLOR, band * ring.forest * (1 - snowAmount * 0.55));
    }

    /*
     * Aerial perspective. See the constants at the top of the file for why this
     * is shaped the way it is; what happens here is only the arithmetic.
     *
     * The viewer is at the origin — the whole backdrop rides with the camera —
     * so the distance is just the facet's own radius, and the ray runs from
     * roughly valley height up to the facet. Averaging the density at the two
     * ends is a crude integral and an entirely sufficient one over three
     * kilometres of height: what it has to get right is the *ordering*, and it
     * does.
     */
    const midX = (p.x + q.x + r.x) / 3;
    const midZ = (p.z + q.z + r.z) / 3;
    const dist = Math.hypot(midX, midZ);

    // How far away it is.
    const byDistance = 1 - Math.exp(-(dist / EXTINCTION_M) * ring.hazeScale);
    // And how deep in the valley air it is, which is what dissolves the feet.
    const murk = Math.exp(-Math.max(midY, 0) / SCALE_HEIGHT_M);
    const haze = byDistance + (1 - byDistance) * murk * VALLEY_MURK;

    // The colour of that air, warm looking into the sun and blue looking away.
    const inv = 1 / Math.max(dist, 1e-3);
    const toward = (midX * inv) * SUN_DIRECTION.x + (midZ * inv) * SUN_DIRECTION.z;
    hazeCol.copy(HAZE_AWAY).lerp(HAZE_TOWARD, smoothstep(-0.35, 0.95, toward));

    col.lerp(hazeCol, clamp(haze, 0, 1));

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
      thetaSteps: steps(210), rSteps: Math.max(4, Math.round(7 * detail)),
      snowline: 0.74, forest: 0.85, hazeScale: 0.9,
      rock: '#24405c', snow: '#eef5fb',
    },
    {
      inner: 2200, outer: 3900, height: 1250, featureSize: 560,
      thetaSteps: steps(250), rSteps: Math.max(5, Math.round(10 * detail)),
      snowline: 0.5, forest: 0.42, hazeScale: 1.0,
      rock: '#1e3c60', snow: '#f3f8fd',
    },
    {
      inner: 3500, outer: 5600, height: 2100, featureSize: 820,
      thetaSteps: steps(220), rSteps: Math.max(5, Math.round(10 * detail)),
      snowline: 0.44, forest: 0.14, hazeScale: 1.12,
      rock: '#27496c', snow: '#f6fafe',
    },
    {
      inner: 5200, outer: 7400, height: 2950, featureSize: 1100,
      thetaSteps: steps(190), rSteps: Math.max(4, Math.round(8 * detail)),
      snowline: 0.4, forest: 0, hazeScale: 1.28,
      rock: '#355f85', snow: '#f8fbff',
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
