import { makeRng, clamp, smoothstep, valueNoise2 } from '../core/mathx.js';

/**
 * The Course is the single source of truth for the shape of the mountain.
 *
 * Every other system — the terrain mesh, the trees, the skiers, the village and
 * the rider's own physics — asks this object where the ground is. Keeping one
 * analytic height field means the visuals and the collision can never disagree.
 *
 * Coordinate system:
 *   +Z  is downhill (the direction the rider travels)
 *   +X  is skier's right
 *   +Y  is up
 * Yaw 0 points down +Z; positive yaw rotates toward +X.
 */

export const COURSE = {
  length: 3000,        // metres from the drop-in gate to the finish banner
  startZ: 24,
  finishZ: 2870,
  halfWidth: 190,      // how far the meshed terrain extends either side of the track
  trackHalfWidth: 13,  // groomed corduroy half-width
  edgeSoftness: 3.2,   // metres of blend between corduroy and powder
};

export class Course {
  constructor(seed = 20240117) {
    this.rng = makeRng(seed);
    this.length = COURSE.length;
    this.finishZ = COURSE.finishZ;
    this.trackHalfWidth = COURSE.trackHalfWidth;

    this._buildBaseProfile();
    this._buildKickers();
    this._indexKickers();
  }

  /* ------------------------------------------------------------------
   * Fall line
   * ---------------------------------------------------------------- */

  /** Steepness at a given z. Two steeper pitches, then a runout to the village. */
  _gradeAt(z) {
    const bell = (c, w) => Math.exp(-(((z - c) / w) ** 2));
    return (
      0.17 +
      0.07 * bell(900, 280) +
      0.06 * bell(1850, 320) -
      0.135 * smoothstep(2660, 2980, z)
    );
  }

  /**
   * Integrating the grade numerically once at startup lets the steepness vary
   * freely while the height stays perfectly continuous.
   */
  _buildBaseProfile() {
    const n = this.length + 420;
    const table = new Float32Array(n + 1);
    let h = 0;
    for (let z = 0; z <= n; z++) {
      table[z] = h;
      h -= this._gradeAt(z);
    }
    this._baseTable = table;
    this._baseMax = n;
  }

  /** Height of the smooth fall line at z (metres, negative going downhill). */
  baseHeight(z) {
    const t = this._baseTable;
    const zc = clamp(z, 0, this._baseMax - 1);
    const i = Math.floor(zc);
    const f = zc - i;
    return t[i] + (t[i + 1] - t[i]) * f;
  }

  /** Rolling undulations along the fall line, faded out over the runout. */
  _undulation(z) {
    const taper = 1 - 0.85 * smoothstep(2560, 2940, z);
    return (
      (4.0 * Math.sin(z * 0.006) +
        2.4 * Math.sin(z * 0.014 + 1.3) +
        1.2 * Math.sin(z * 0.028 + 0.4)) *
      taper
    );
  }

  /* ------------------------------------------------------------------
   * The groomed track
   * ---------------------------------------------------------------- */

  /** X position of the centre of the groomed track at a given z. */
  centerX(z) {
    const taper = 1 - 0.9 * smoothstep(2680, 2980, z); // straighten out for the finish
    return (
      (34 * Math.sin(z * 0.0042) +
        17 * Math.sin(z * 0.0098 + 2.1) +
        8.5 * Math.sin(z * 0.019 + 0.7)) *
      taper
    );
  }

  /** dX/dZ of the track centre — the track's tangent slope in plan view. */
  centerSlope(z) {
    const d = 0.5;
    return (this.centerX(z + d) - this.centerX(z - d)) / (2 * d);
  }

  /** Unit tangent of the track in the XZ plane. */
  trackTangent(z, out = { x: 0, z: 1 }) {
    const m = this.centerSlope(z);
    const inv = 1 / Math.hypot(m, 1);
    out.x = m * inv;
    out.z = inv;
    return out;
  }

  /** Heading (yaw) that follows the track at z. */
  trackHeading(z) {
    return Math.atan2(this.centerSlope(z), 1);
  }

  /**
   * Signed perpendicular distance from the track centre line.
   * Negative is skier's left, positive is skier's right.
   */
  trackOffset(x, z) {
    const m = this.centerSlope(z);
    return (x - this.centerX(z)) / Math.hypot(m, 1);
  }

  /** 1 on the corduroy, 0 in deep powder, smoothly blended at the edge. */
  groomAt(x, z) {
    const u = Math.abs(this.trackOffset(x, z));
    return 1 - smoothstep(COURSE.trackHalfWidth - COURSE.edgeSoftness, COURSE.trackHalfWidth, u);
  }

  /* ------------------------------------------------------------------
   * Height field
   * ---------------------------------------------------------------- */

  /**
   * The terrain surface, excluding kickers. The kickers are separate meshes so
   * they can be modelled at a much finer resolution than the slope grid.
   */
  terrainHeight(x, z) {
    const u = this.trackOffset(x, z);
    const au = Math.abs(u);

    // A shallow bowl cradles the track so the piste reads as a valley floor.
    // The rise is eased off far out so the valley walls don't become cliffs.
    const bowl = 0.1 * (Math.hypot(u, 30) - 30) * (1 - 0.45 * smoothstep(90, 320, au));

    // Powder is lumpy; the groomed surface is glass. Blend between the two.
    const powderness = smoothstep(COURSE.trackHalfWidth - 1, COURSE.trackHalfWidth + 9, au);
    const lumps =
      powderness *
      (0.95 * (valueNoise2(x * 0.036, z * 0.036, 71) - 0.5) +
        0.32 * (valueNoise2(x * 0.085, z * 0.085, 913) - 0.5));

    // The groomer leaves a very slight camber on the piste itself.
    const camber = (1 - powderness) * 0.06 * Math.cos(u * 0.24);

    // Slow rolling out in the far snowfields. Without it the terrain's outer
    // edge draws a dead-straight line against the peaks on the horizon.
    const far = smoothstep(200, 420, au);
    const farRoll =
      far *
      (12 * (valueNoise2(x * 0.0028, z * 0.0028, 31) - 0.5) +
        4.5 * (valueNoise2(x * 0.0065, z * 0.0065, 57) - 0.5));

    return this.baseHeight(z) + this._undulation(z) + bowl + lumps + camber + farRoll;
  }

  /** Terrain plus any kicker ramp — what the board actually rides on. */
  groundHeight(x, z) {
    return this.terrainHeight(x, z) + this.kickerHeight(x, z);
  }

  /** Surface normal of the ridable ground, via central differences. */
  groundNormal(x, z, out = { x: 0, y: 1, z: 0 }) {
    const d = 0.6;
    const hx = this.groundHeight(x + d, z) - this.groundHeight(x - d, z);
    const hz = this.groundHeight(x, z + d) - this.groundHeight(x, z - d);
    const nx = -hx / (2 * d);
    const nz = -hz / (2 * d);
    const len = Math.hypot(nx, 1, nz);
    out.x = nx / len;
    out.y = 1 / len;
    out.z = nz / len;
    return out;
  }

  /* ------------------------------------------------------------------
   * Kickers
   * ---------------------------------------------------------------- */

  _buildKickers() {
    const rng = this.rng;
    this.kickers = [];
    let z = 300;
    while (z < COURSE.finishZ - 220) {
      const size = rng();
      const height = 1.5 + size * 1.9;          // 1.5 – 3.4 m lip
      const len = 6.5 + size * 5.0;             // short and steep; ~25° at the lip
      const width = 7.5 + rng() * 5.5;
      // Sit the kicker somewhere across the piste so lines have to be chosen.
      const offset = rng.spread(COURSE.trackHalfWidth - width * 0.5 - 1.5);
      const cx = this.centerX(z) + offset * Math.cos(Math.atan(this.centerSlope(z)));
      const tan = this.trackTangent(z);
      this.kickers.push({
        x: cx,
        z,
        dirX: tan.x,
        dirZ: tan.z,
        length: len,
        halfWidth: width * 0.5,
        height,
      });
      z += 150 + rng() * 135;
    }
  }

  /** Bucket kickers by z so the per-frame height lookup stays O(1). */
  _indexKickers() {
    this._kickerBucketSize = 64;
    this._kickerBuckets = new Map();
    for (const k of this.kickers) {
      const reach = k.length + k.halfWidth + 4;
      const from = Math.floor((k.z - reach) / this._kickerBucketSize);
      const to = Math.floor((k.z + reach) / this._kickerBucketSize);
      for (let b = from; b <= to; b++) {
        if (!this._kickerBuckets.has(b)) this._kickerBuckets.set(b, []);
        this._kickerBuckets.get(b).push(k);
      }
    }
  }

  kickersNear(z) {
    return this._kickerBuckets.get(Math.floor(z / this._kickerBucketSize)) ?? EMPTY;
  }

  /** Height a single kicker adds at a world position. */
  kickerProfile(k, x, z) {
    const dx = x - k.x;
    const dz = z - k.z;
    const s = dx * k.dirX + dz * k.dirZ;       // along the ramp
    if (s < 0 || s > k.length) return 0;
    const t = dx * k.dirZ - dz * k.dirX;       // across the ramp
    const at = Math.abs(t);
    if (at > k.halfWidth) return 0;

    const p = s / k.length;
    // Steepest right at the lip: that is what converts speed into loft.
    const rise = Math.pow(p, 1.7);
    const across = 1 - smoothstep(k.halfWidth - 2.6, k.halfWidth, at);
    return k.height * rise * across;
  }

  /** Combined kicker contribution at a world position. */
  kickerHeight(x, z) {
    let h = 0;
    const near = this.kickersNear(z);
    for (let i = 0; i < near.length; i++) h += this.kickerProfile(near[i], x, z);
    return h;
  }

  /**
   * How far up a kicker ramp a position is, 0 at the foot and 1 at the lip;
   * 0 when not on a ramp at all. This is what an ollie is timed against — the
   * pop only pays if it happens in the last stretch before the lip.
   */
  kickerPhase(x, z) {
    let best = 0;
    const near = this.kickersNear(z);
    for (const k of near) {
      const dx = x - k.x;
      const dz = z - k.z;
      const s = dx * k.dirX + dz * k.dirZ;
      if (s < 0 || s > k.length) continue;
      const t = dx * k.dirZ - dz * k.dirX;
      if (Math.abs(t) > k.halfWidth) continue;
      best = Math.max(best, s / k.length);
    }
    return best;
  }

  /** True when a position is on (or very near) a kicker ramp — used by scatter placement. */
  onKicker(x, z, pad = 3) {
    const near = this.kickersNear(z);
    for (const k of near) {
      const dx = x - k.x;
      const dz = z - k.z;
      const s = dx * k.dirX + dz * k.dirZ;
      const t = dx * k.dirZ - dz * k.dirX;
      if (s > -pad && s < k.length + pad && Math.abs(t) < k.halfWidth + pad) return true;
    }
    return false;
  }
}

const EMPTY = [];
