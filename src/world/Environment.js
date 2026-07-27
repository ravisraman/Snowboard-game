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
export const HORIZON_COLOR = new THREE.Color('#c6dcef');

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
      uZenith: { value: new THREE.Color('#2f76c9') },
      uHorizon: { value: new THREE.Color('#cfe4f6') },
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
  const snowline = base.map(() => 0.46 + rng() * 0.26);

  // Scene fog is off for the peaks — at four kilometres it would erase them —
  // so the atmosphere is painted on instead. Haze is heaviest at the base,
  // which is what dissolves the hard line where the fogged snowfields end and
  // the range begins, and plants the peaks behind the valley rather than on it.
  const hazeCol = new THREE.Color();
  const push = (v, c) => {
    const t = clamp(v.y / (height * 0.55), 0, 1);
    const f = (1 - t) * (1 - t);
    hazeCol.copy(c).lerp(HORIZON_COLOR, 0.12 + 0.85 * f);
    positions.push(v.x, v.y, v.z);
    colors.push(hazeCol.r, hazeCol.g, hazeCol.b);
  };

  const mid = new THREE.Vector3();
  for (let i = 0; i < sides; i++) {
    const a = base[i];
    const b = base[(i + 1) % sides];
    const ta = snowline[i];
    const tb = snowline[(i + 1) % sides];

    // Per-face shading variation gives the low-poly rock its facets.
    const v = 0.86 + rng() * 0.28;
    shade.copy(rockCol).multiplyScalar(v);

    const sa = mid.copy(a).lerp(apex, ta).clone();
    const sb = new THREE.Vector3().copy(b).lerp(apex, tb);

    // Rock skirt below the snowline.
    push(a, shade);
    push(b, shade);
    push(sb, shade);
    push(a, shade);
    push(sb, shade);
    push(sa, shade);

    // Snow cap above it.
    const sv = snowCol.clone().multiplyScalar(0.93 + rng() * 0.14);
    push(sa, sv);
    push(sb, sv);
    push(apex, sv);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
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
  const rings = [
    { radius: 1500, count: 26, hMin: 240, hMax: 470, rMin: 260, rMax: 420, rock: '#6d88a6', snow: '#f2f8ff', haze: 0.1 },
    { radius: 2700, count: 30, hMin: 420, hMax: 820, rMin: 400, rMax: 640, rock: '#8aa3bf', snow: '#edf5fd', haze: 0.3 },
    { radius: 4100, count: 32, hMin: 640, hMax: 1180, rMin: 620, rMax: 900, rock: '#a3b9cf', snow: '#e7f1fb', haze: 0.52 },
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
      m.setPosition(Math.sin(angle) * dist, -60, Math.cos(angle) * dist);
      geo.applyMatrix4(m);
      parts.push(geo);
    }

    const mesh = new THREE.Mesh(
      mergeGeometries(parts, false),
      new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, fog: false })
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
  const sun = new THREE.DirectionalLight('#fff4de', 2.9);
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
  const hemi = new THREE.HemisphereLight('#9fc8f0', '#dbeaf8', 0.55);
  scene.add(hemi);

  const fill = new THREE.AmbientLight('#dceaf8', 0.14);
  scene.add(fill);

  /** Keeps the shadow frustum tight around the rider. */
  const follow = (target) => {
    sun.target.position.copy(target);
    sun.position.copy(target).addScaledVector(SUN_DIRECTION, 190);
    sun.target.updateMatrixWorld();
  };

  return { sun, hemi, fill, follow };
}
