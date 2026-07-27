import * as THREE from 'three';
import { clamp } from '../core/mathx.js';

/**
 * The trench the board leaves behind.
 *
 * A ribbon of quads written into a ring buffer: two vertices appended per
 * frame at the board's edges, wrapping round and overwriting the oldest pair
 * once the buffer is full.
 *
 * The alternative — rendering tracks into an orthographic texture over the
 * terrain — is what you would reach for if the whole mountain had to remember
 * them. It doesn't. The chase camera never sees more than about 150 m behind,
 * so a few hundred metres of ribbon is indistinguishable from the full thing
 * at a fraction of the machinery, and because every vertex samples the same
 * analytic `groundHeight()` the physics reads, it lies exactly on the snow
 * over every roll and lip.
 *
 * The ring buffer needs one trick: the wrap point would otherwise draw a quad
 * stretching from the newest position all the way back to the oldest, a stripe
 * across the whole mountain. Degenerate quads at the seam solve it, and the
 * same mechanism handles the rider leaving the ground — the ribbon simply
 * stops and restarts rather than bridging the gap.
 */

const TRACK_COLOR = new THREE.Color('#b6cfe4');
const POWDER_COLOR = new THREE.Color('#cddff0');

export class SnowTracks {
  constructor(course, { segments = 2600 } = {}) {
    this.course = course;
    this.segments = segments;
    this.cursor = 0;
    this.filled = 0;
    this.pending = true;   // next sample starts a new ribbon
    this.lastX = 0;
    this.lastZ = 0;

    const verts = segments * 2;
    this.positions = new Float32Array(verts * 3);
    this.colors = new Float32Array(verts * 3);
    this.alphas = new Float32Array(verts);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));

    // Two triangles per segment, joining each vertex pair to the next.
    const index = [];
    for (let i = 0; i < segments - 1; i++) {
      const a = i * 2;
      index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    geometry.setIndex(index);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: /* glsl */ `
        attribute float aAlpha;
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          vAlpha = aAlpha;
          vColor = color;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          if (vAlpha < 0.004) discard;
          gl_FragColor = vec4(vColor, vAlpha);
        }
      `,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.name = 'snow-tracks';
  }

  reset() {
    this.alphas.fill(0);
    this.cursor = 0;
    this.filled = 0;
    this.pending = true;
    this.mesh.geometry.attributes.aAlpha.needsUpdate = true;
  }

  /** Breaks the ribbon — call whenever the board leaves the snow or teleports. */
  lift() {
    this.pending = true;
  }

  update(rider) {
    if (!rider.grounded || rider.crashed) {
      this.lift();
      return;
    }

    // One sample every ~0.35 m rather than every frame, so the ribbon's length
    // in metres doesn't depend on the frame rate.
    const dx = rider.position.x - this.lastX;
    const dz = rider.position.z - this.lastZ;
    if (!this.pending && dx * dx + dz * dz < 0.12) return;

    this._append(rider);
    this.lastX = rider.position.x;
    this.lastZ = rider.position.z;
  }

  _append(rider) {
    const { position, boardYaw, carveIntensity, powder, speed } = rider;

    // Perpendicular to the board, so the trench widens as it goes on edge.
    const rx = Math.cos(boardYaw);
    const rz = -Math.sin(boardYaw);
    const halfWidth = 0.14 + carveIntensity * 0.2 + powder * 0.5;

    const i = this.cursor * 2;
    const alpha = clamp(0.1 + carveIntensity * 0.42 + powder * 0.2, 0, 0.6) *
      clamp(speed / 9, 0, 1);

    const color = powder > 0.5 ? POWDER_COLOR : TRACK_COLOR;

    for (let k = 0; k < 2; k++) {
      const side = k === 0 ? -halfWidth : halfWidth;
      const x = position.x + rx * side;
      const z = position.z + rz * side;
      const p = (i + k) * 3;
      this.positions[p] = x;
      // Sits on the analytic surface, lifted just clear of the terrain mesh.
      this.positions[p + 1] = this.course.groundHeight(x, z) + 0.03;
      this.positions[p + 2] = z;
      this.colors[p] = color.r;
      this.colors[p + 1] = color.g;
      this.colors[p + 2] = color.b;

      // A pending sample starts a new ribbon: zero alpha means the quad
      // bridging the gap — or wrapping round the ring — draws nothing.
      this.alphas[i + k] = this.pending ? 0 : alpha;
    }

    this.pending = false;
    this.cursor = (this.cursor + 1) % this.segments;
    this.filled = Math.min(this.filled + 1, this.segments);

    // Blank the pair just ahead of the cursor. That is the oldest data, and it
    // is also where the ribbon wraps — without this the newest point is joined
    // to the oldest by a quad stretching right across the mountain.
    const ahead = ((this.cursor + 1) % this.segments) * 2;
    this.alphas[ahead] = 0;
    this.alphas[ahead + 1] = 0;

    const attrs = this.mesh.geometry.attributes;
    attrs.position.needsUpdate = true;
    attrs.color.needsUpdate = true;
    attrs.aAlpha.needsUpdate = true;
  }
}
