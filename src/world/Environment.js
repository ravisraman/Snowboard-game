import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeRng, clamp, smoothstep } from '../core/mathx.js';

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

    // Deep blue overhead easing to a pale, slightly warm horizon.
    float t = pow(clamp(h, 0.0, 1.0), 0.62);
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
    uniforms: {
      uZenith: { value: new THREE.Color('#4d90d6') },
      uHorizon: { value: new THREE.Color('#d2e4f4') },
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
 * One jagged peak: a faceted rock cone with a snow cap whose lower edge dips
 * to a different height on every face, giving the ragged snowline you see on
 * a real summit instead of a clean ring.
 */
function buildPeak(rng, { radius, height, sides, rock, snow }) {
  const positions = [];
  const colors = [];
  const rockCol = new THREE.Color(rock);
  const snowCol = new THREE.Color(snow);
  const shade = new THREE.Color();

  const apex = new THREE.Vector3(rng.spread(radius * 0.22), height, rng.spread(radius * 0.22));
  const base = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2 + rng.spread(0.16);
    const r = radius * (0.72 + rng() * 0.56);
    base.push(new THREE.Vector3(Math.cos(a) * r, rng.spread(height * 0.03), Math.sin(a) * r));
  }

  // Where the snow starts on each ridge, as a fraction from base to apex.
  const snowline = base.map(() => 0.34 + rng() * 0.26);

  // The peaks are drawn unlit, with everything baked into the vertex colours:
  // a directional shade from the sun, a band of dark conifer forest over the
  // lower slopes, and the atmosphere on top.
  //
  // Baking the light rather than letting the scene lamps do it is what keeps
  // the ranges from flattening into pale grey pyramids. The fill light the
  // snow in the foreground needs is far too much for a mountain four
  // kilometres away, and there is no one setting that serves both.
  //
  // Haze is heaviest at the base. That is what dissolves the hard line where
  // the fogged snowfields end and the range begins, and plants the peaks
  // behind the valley floor rather than standing on it.
  const col = new THREE.Color();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const nrm = new THREE.Vector3();

  const face = (p, q, r, baseColor) => {
    ab.subVectors(q, p);
    ac.subVectors(r, p);
    nrm.crossVectors(ab, ac).normalize();
    const d = Math.max(0, nrm.dot(SUN_DIRECTION));

    for (const v of [p, q, r]) {
      // Shade by hue as well as by value. A sunlit face and a shaded face on a
      // snow peak differ mostly in colour — one is warm white, the other is lit
      // by blue sky alone — and darkening alone just makes grey pyramids.
      col.copy(baseColor).lerp(SNOW_SHADOW, (1 - d) * 0.62).multiplyScalar(0.62 + 0.46 * d);

      const a = clamp(v.y / height, 0, 1);
      const forestBand = smoothstep(0.02, 0.09, a) * (1 - smoothstep(0.16, 0.34, a));

      const t = clamp(v.y / (height * 0.55), 0, 1);
      const f = (1 - t) * (1 - t);
      col.lerp(HORIZON_COLOR, 0.05 + 0.92 * f);
      // Forest goes on after the haze, or the band sits so low on the peak
      // that the atmosphere erases it entirely.
      col.lerp(FOREST_COLOR, forestBand * 0.62);

      positions.push(v.x, v.y, v.z);
      colors.push(col.r, col.g, col.b);
    }
  };

  for (let i = 0; i < sides; i++) {
    const a = base[i];
    const b = base[(i + 1) % sides];
    const ta = snowline[i];
    const tb = snowline[(i + 1) % sides];

    // A little per-face variation keeps neighbouring facets from banding.
    shade.copy(rockCol).multiplyScalar(0.9 + rng() * 0.2);
    const sa = new THREE.Vector3().copy(a).lerp(apex, ta);
    const sb = new THREE.Vector3().copy(b).lerp(apex, tb);

    // Shaded-snow flank below the ragged snowline.
    face(a, b, sb, shade);
    face(a, sb, sa, shade);

    // Bright snow above it.
    const sv = snowCol.clone().multiplyScalar(0.95 + rng() * 0.1);
    face(sa, sb, apex, sv);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geo;
}

/**
 * Three concentric rings of peaks. Nearer ranges are darker and more detailed;
 * far ranges wash out toward the horizon colour to fake aerial perspective.
 */
export function buildMountains(seed = 909) {
  const rng = makeRng(seed);
  const group = new THREE.Group();
  group.name = 'panorama';

  // `haze` is how far each range is washed toward the horizon colour. The
  // scene's fog is switched off for these meshes — at four kilometres it would
  // erase them entirely — so the aerial perspective is baked into the vertex
  // colours instead.
  // "rock" is really shaded snow: these are snow-plastered alpine faces, so the
  // dark side of a ridge is blue, not brown.
  const rings = [
    { radius: 1250, count: 24, hMin: 420, hMax: 760, rMin: 300, rMax: 470, rock: '#5d8fc4', snow: '#f2f7fc', haze: 0.04 },
    { radius: 2200, count: 28, hMin: 700, hMax: 1250, rMin: 470, rMax: 760, rock: '#7aa3cf', snow: '#f4f9fd', haze: 0.16 },
    { radius: 3400, count: 30, hMin: 1000, hMax: 1750, rMin: 720, rMax: 1050, rock: '#96b7d7', snow: '#f6fafe', haze: 0.34 },
  ];

  const hazed = (hex, amount) => new THREE.Color(hex).lerp(HORIZON_COLOR, amount).getStyle();

  for (const ring of rings) {
    const parts = [];
    const m = new THREE.Matrix4();
    for (let i = 0; i < ring.count; i++) {
      const angle = (i / ring.count) * Math.PI * 2 + rng.spread(0.09);
      const dist = ring.radius * (0.88 + rng() * 0.3);
      const geo = buildPeak(rng, {
        radius: rng.range(ring.rMin, ring.rMax),
        height: rng.range(ring.hMin, ring.hMax),
        sides: rng.int(5, 7),
        rock: hazed(ring.rock, ring.haze),
        snow: hazed(ring.snow, ring.haze * 0.6),
      });
      m.makeRotationY(rng() * Math.PI * 2);
      // Base height matters more than it looks. Sink the ranges and the valley
      // horizon crops away everything below the snowline, leaving a row of
      // featureless white pyramids; the shaded flanks and the forest band only
      // exist as far as they clear the skyline.
      m.setPosition(Math.sin(angle) * dist, -25, Math.cos(angle) * dist);
      geo.applyMatrix4(m);
      parts.push(geo);
    }

    // Unlit: the sun is already baked into the vertex colours above.
    const mesh = new THREE.Mesh(
      mergeGeometries(parts, false),
      new THREE.MeshBasicMaterial({ vertexColors: true, fog: false })
    );
    mesh.frustumCulled = false;
    group.add(mesh);
  }

  return group;
}

/* ------------------------------------------------------------------
 * Lighting
 * ---------------------------------------------------------------- */

export function buildLighting(scene) {
  // Warm, low-ish winter sun raking across the slope from one side.
  const sun = new THREE.DirectionalLight('#fff6e6', 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 460;
  sun.shadow.camera.left = -68;
  sun.shadow.camera.right = 68;
  sun.shadow.camera.top = 68;
  sun.shadow.camera.bottom = -68;
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
