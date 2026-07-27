import * as THREE from 'three';
import { clamp } from '../core/mathx.js';

/**
 * Snow spray.
 *
 * A fixed pool of billboarded snow grains, simulated on the CPU (a couple of
 * thousand particles is nothing, and it keeps the spawn logic legible). The
 * important part is *where* they come from: the outside edge of the board,
 * fanning away from the arc, rising a little and dying fast. Harder carve →
 * more grains, launched wider and faster.
 */

const DEFAULT_MAX_PARTICLES = 4200;
const GRAVITY = 7.5;
const DRAG = 1.9;

export class SnowSpray {
  constructor(maxParticles = DEFAULT_MAX_PARTICLES) {
    const MAX_PARTICLES = maxParticles;
    this.max = MAX_PARTICLES;
    this.count = MAX_PARTICLES;

    this.px = new Float32Array(MAX_PARTICLES);
    this.py = new Float32Array(MAX_PARTICLES);
    this.pz = new Float32Array(MAX_PARTICLES);
    this.vx = new Float32Array(MAX_PARTICLES);
    this.vy = new Float32Array(MAX_PARTICLES);
    this.vz = new Float32Array(MAX_PARTICLES);
    this.life = new Float32Array(MAX_PARTICLES);
    this.maxLife = new Float32Array(MAX_PARTICLES);
    this.size0 = new Float32Array(MAX_PARTICLES);
    this.grow = new Float32Array(MAX_PARTICLES);

    this.cursor = 0;
    // Fractional emission counters, kept separate so the two emitters that run
    // every frame don't steal each other's remainders.
    this._carveCarry = 0;
    this._trailCarry = 0;

    const positions = new Float32Array(MAX_PARTICLES * 3);
    const aSize = new Float32Array(MAX_PARTICLES);
    const aAlpha = new Float32Array(MAX_PARTICLES);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(aAlpha, 1));
    geometry.setDrawRange(0, MAX_PARTICLES);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: makeGrainTexture() },
        uScale: { value: 600 },
        uColor: { value: new THREE.Color('#ffffff') },
      },
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aAlpha;
        varying float vAlpha;
        uniform float uScale;
        void main() {
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(-mv.z, 0.1);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          if (vAlpha <= 0.001) discard;
          vec4 tex = texture2D(uMap, gl_PointCoord);
          gl_FragColor = vec4(uColor, tex.a * vAlpha);
          if (gl_FragColor.a < 0.01) discard;
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.points.name = 'snow-spray';

    this._aPos = positions;
    this._aSize = aSize;
    this._aAlpha = aAlpha;
  }

  /** Point sizes are in world units; this maps them to pixels. */
  setViewport(height, fov) {
    this.material.uniforms.uScale.value = height / (2 * Math.tan((fov * Math.PI) / 360));
  }

  reset() {
    this.life.fill(0);
    this._aAlpha.fill(0);
    this.points.geometry.attributes.aAlpha.needsUpdate = true;
  }

  _spawn(x, y, z, vx, vy, vz, size, life, grow) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size0[i] = size;
    this.grow[i] = grow;
  }

  /**
   * The carve plume. `intensity` is 0–1 edge commitment, `powder` 0–1 for how
   * deep the snow is — powder throws a bigger, slower, puffier cloud.
   */
  emitCarve(origin, yaw, side, speed, intensity, powder, dt) {
    const strength = intensity * clamp(speed / 16, 0, 1.6);
    if (strength < 0.06) return;

    // Rate is carried across frames so slow frames don't drop particles.
    const rate = (90 + 560 * strength) * (1 + powder * 0.7);
    this._carveCarry += rate * dt;
    let n = Math.floor(this._carveCarry);
    this._carveCarry -= n;
    if (n > 160) n = 160;

    // Lateral (away from the arc) and backward (against travel) directions.
    const lx = Math.cos(yaw) * side;
    const lz = -Math.sin(yaw) * side;
    const bx = -Math.sin(yaw);
    const bz = -Math.cos(yaw);

    const fan = 1.7 + 5.8 * strength;
    const back = speed * (0.14 + 0.1 * intensity);
    const rise = (1.4 + 3.4 * strength) * (1 + powder * 0.85);

    for (let k = 0; k < n; k++) {
      const spread = (Math.random() * 2 - 1) * 0.55;
      const f = fan * (0.55 + Math.random() * 0.75);
      const vxp = lx * f + bx * back + (Math.random() * 2 - 1) * 1.5 + lz * spread;
      const vzp = lz * f + bz * back + (Math.random() * 2 - 1) * 1.5 - lx * spread;
      const vyp = rise * (0.4 + Math.random());

      this._spawn(
        origin.x + (Math.random() * 2 - 1) * 0.22,
        origin.y + Math.random() * 0.12,
        origin.z + (Math.random() * 2 - 1) * 0.22,
        vxp, vyp, vzp,
        (0.05 + Math.random() * 0.085) * (1 + powder * 0.55 + strength * 0.3),
        0.3 + Math.random() * 0.34 + powder * 0.24,
        0.6 + powder * 0.85
      );
    }
  }

  /** Fine dust kicked up by simply running fast over the snow. */
  emitTrail(origin, yaw, speed, powder, dt) {
    const strength = clamp((speed - 11) / 24, 0, 1) * (0.35 + powder);
    if (strength <= 0.02) return;
    this._trailCarry += 40 * strength * dt;
    const n = Math.floor(this._trailCarry);
    this._trailCarry -= n;
    const bx = -Math.sin(yaw);
    const bz = -Math.cos(yaw);
    for (let k = 0; k < n; k++) {
      this._spawn(
        origin.x + (Math.random() * 2 - 1) * 0.3,
        origin.y + 0.03,
        origin.z + (Math.random() * 2 - 1) * 0.3,
        bx * speed * 0.1 + (Math.random() * 2 - 1) * 0.9,
        0.7 + Math.random() * 1.5 + powder * 2,
        bz * speed * 0.1 + (Math.random() * 2 - 1) * 0.9,
        (0.035 + Math.random() * 0.06) * (1 + powder * 0.5),
        0.26 + Math.random() * 0.26,
        0.8
      );
    }
  }

  /** One-off puff: landings, crashes, hitting a lip. */
  burst(origin, count, power, powder = 0) {
    for (let k = 0; k < count; k++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random();
      const speed = power * (0.35 + r * 0.9);
      this._spawn(
        origin.x + (Math.random() * 2 - 1) * 0.35,
        origin.y + Math.random() * 0.25,
        origin.z + (Math.random() * 2 - 1) * 0.35,
        Math.cos(a) * speed,
        power * (0.4 + Math.random() * 0.85),
        Math.sin(a) * speed,
        (0.055 + Math.random() * 0.1) * (1 + powder * 0.6),
        0.36 + Math.random() * 0.4,
        0.75 + powder * 0.5
      );
    }
  }

  update(dt) {
    const decay = Math.exp(-DRAG * dt);
    const pos = this._aPos;
    const size = this._aSize;
    const alpha = this._aAlpha;

    for (let i = 0; i < this.max; i++) {
      const l = this.life[i];
      if (l <= 0) {
        if (alpha[i] !== 0) alpha[i] = 0;
        continue;
      }

      const nl = l - dt;
      if (nl <= 0) {
        this.life[i] = 0;
        alpha[i] = 0;
        continue;
      }
      this.life[i] = nl;

      this.vy[i] -= GRAVITY * dt;
      this.vx[i] *= decay;
      this.vy[i] *= decay;
      this.vz[i] *= decay;

      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;

      const t = 1 - nl / this.maxLife[i]; // 0 at birth, 1 at death
      pos[i * 3] = this.px[i];
      pos[i * 3 + 1] = this.py[i];
      pos[i * 3 + 2] = this.pz[i];
      size[i] = this.size0[i] * (1 + this.grow[i] * t);
      // Snap in, then fade out on a curve so the plume dissolves rather than
      // switching off.
      alpha[i] = Math.min(1, t * 9) * (1 - t) * (1 - t) * 0.92;
    }

    const attrs = this.points.geometry.attributes;
    attrs.position.needsUpdate = true;
    attrs.aSize.needsUpdate = true;
    attrs.aAlpha.needsUpdate = true;
  }
}

/** A soft round grain with a slightly hard core, so plumes read as granular. */
function makeGrainTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.92)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.32)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
