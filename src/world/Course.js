import { makeRng, clamp, smoothstep, valueNoise2 } from '../core/mathx.js';
import { CLASSIC } from './Runs.js';

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
 *
 * ---------------------------------------------------------------------------
 * The shape itself lives in `Runs.js`
 * ---------------------------------------------------------------------------
 * This file holds the *structure* — an integrated fall line, a sine-sum centre
 * line, a bowl, powder lumps, walked kicker and rail placement — and takes
 * every number in it from a run preset. `new Course(seed)` still builds the
 * Classic descent, byte for byte; `new Course(seed, PARK)` builds a different
 * mountain out of the same code.
 */

/**
 * Layout of the run most recently constructed, as a plain module-level object.
 *
 * This exists for the modules that were written before runs were a thing and
 * still read the course's extent at module scope: `Terrain.js` (which bakes
 * `trackHalfWidth` and `edgeSoftness` straight into GLSL source), `Resort.js`,
 * `Skiers.js` and `Game.js`. It is a *view*, refreshed by the `Course`
 * constructor — read it, never write it.
 *
 * Anything with a `Course` instance to hand should prefer `course.config`,
 * which is the real thing and is per-instance.
 */
export const COURSE = {
  length: CLASSIC.length,             // metres from the drop-in gate to the finish banner
  startZ: CLASSIC.startZ,
  finishZ: CLASSIC.finishZ,
  halfWidth: CLASSIC.halfWidth,       // how far the meshed terrain extends either side of the track
  // Groomed corduroy half-width. Wider than a real piste of this pitch, and
  // deliberately so: at a hundred and twenty km/h a board covers thirty-odd
  // metres a second, and the margin for a wobble has to be measured in the same
  // units as the speed.
  trackHalfWidth: CLASSIC.track.halfWidth,
  edgeSoftness: CLASSIC.track.edgeSoftness,  // metres of blend between corduroy and powder
};

/** Refreshes the legacy `COURSE` view from a run config. */
function publishLayout(config) {
  COURSE.length = config.length;
  COURSE.startZ = config.startZ;
  COURSE.finishZ = config.finishZ;
  COURSE.halfWidth = config.halfWidth;
  COURSE.trackHalfWidth = config.track.halfWidth;
  COURSE.edgeSoftness = config.track.edgeSoftness;
}

export class Course {
  /**
   * @param {number} [seed] world seed — the leaderboard files it with every run,
   *   because a score is only comparable with another from the same mountain.
   * @param {typeof CLASSIC} [config] a run preset from `Runs.js`.
   */
  constructor(seed = CLASSIC.seed, config = CLASSIC) {
    this.seed = seed;
    this.config = config;
    this.rng = makeRng(seed);
    this.length = config.length;
    this.startZ = config.startZ;
    this.finishZ = config.finishZ;
    this.trackHalfWidth = config.track.halfWidth;
    this.halfWidth = config.halfWidth;
    this.edgeSoftness = config.track.edgeSoftness;

    // Keep the module-level view in step for the older importers. For Classic
    // this rewrites the values it already had.
    publishLayout(config);

    this._buildBaseProfile();
    this._buildKickers();
    this._indexKickers();
    this._buildRails();
    this._indexRails();
  }

  /** Human-readable identity of the run, for the HUD and the leaderboard. */
  get runId() { return this.config.id; }
  get runName() { return this.config.name; }

  /* ------------------------------------------------------------------
   * Fall line
   * ---------------------------------------------------------------- */

  /**
   * Steepness at a given z: a resting grade, plus a Gaussian bump per steeper
   * pitch, minus the runout that flattens the finish. On Classic that reads as
   * two steeper pitches and a runout to the village.
   */
  _gradeAt(z) {
    const g = this.config.grade;
    const bell = (c, w) => Math.exp(-(((z - c) / w) ** 2));
    let grade = g.base;
    for (const b of g.bells) grade += b.amp * bell(b.center, b.width);
    return grade - g.runout.amount * smoothstep(g.runout.from, g.runout.to, z);
  }

  /**
   * Integrating the grade numerically once at startup lets the steepness vary
   * freely while the height stays perfectly continuous.
   */
  _buildBaseProfile() {
    const n = this.length + this.config.profileMargin;
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
    const u = this.config.undulation;
    const taper = 1 - u.taper.amount * smoothstep(u.taper.from, u.taper.to, z);
    return sumWaves(u.waves, z) * taper;
  }

  /* ------------------------------------------------------------------
   * The groomed track
   * ---------------------------------------------------------------- */

  /** X position of the centre of the groomed track at a given z. */
  centerX(z) {
    const t = this.config.track;
    const taper = 1 - t.taper.amount * smoothstep(t.taper.from, t.taper.to, z); // straighten out for the finish
    return sumWaves(t.waves, z) * taper;
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
    const t = this.config.track;
    const u = Math.abs(this.trackOffset(x, z));
    return 1 - smoothstep(t.halfWidth - t.edgeSoftness, t.halfWidth, u);
  }

  /* ------------------------------------------------------------------
   * Height field
   * ---------------------------------------------------------------- */

  /**
   * The terrain surface, excluding kickers. The kickers are separate meshes so
   * they can be modelled at a much finer resolution than the slope grid.
   */
  terrainHeight(x, z) {
    const cfg = this.config;
    const thw = cfg.track.halfWidth;
    const u = this.trackOffset(x, z);
    const au = Math.abs(u);

    // A shallow bowl cradles the track so the piste reads as a valley floor.
    // The rise is eased off far out so the valley walls don't become cliffs.
    const b = cfg.bowl;
    const bowl =
      b.strength *
      (Math.hypot(u, b.softness) - b.softness) *
      (1 - b.easeAmount * smoothstep(b.easeFrom, b.easeTo, au));

    // Powder is lumpy; the groomed surface is glass. Blend between the two.
    const p = cfg.powder;
    const powderness = smoothstep(thw + p.blendFrom, thw + p.blendTo, au);
    const lumps = powderness * sumNoise(p.lumps, x, z);

    // The groomer leaves a very slight camber on the piste itself.
    const camber = (1 - powderness) * cfg.camber.amp * Math.cos(u * cfg.camber.freq);

    // Slow rolling out in the far snowfields. Without it the terrain's outer
    // edge draws a dead-straight line against the peaks on the horizon.
    const ff = cfg.farField;
    const far = smoothstep(ff.from, ff.to, au);
    const farRoll = far * sumNoise(ff.layers, x, z);

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
    const cfg = this.config.kickers;
    this.kickers = [];
    let z = cfg.firstZ;
    while (z < this.finishZ - cfg.endMargin) {
      const size = rng();
      const height = cfg.height.min + size * cfg.height.range;   // 1.5 – 3.4 m lip on Classic
      const len = cfg.length.min + size * cfg.length.range;      // short and steep; ~25° at the lip
      const width = cfg.width.min + rng() * cfg.width.range;
      // Sit the kicker somewhere across the piste so lines have to be chosen.
      const offset = rng.spread(this.trackHalfWidth - width * 0.5 - cfg.offsetMargin);
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
      z += cfg.spacing.min + rng() * cfg.spacing.range;
    }

    // One signature jump: a spine down the middle, wide enough that the
    // approach line decides which way it throws you. Picked from the middle
    // of the mountain rather than placed separately — it reuses the same
    // record and the same `kickerProfile()` the ordinary kickers use, just
    // with a wider table and the `hip` flag set.
    if (cfg.hip.enabled && this.kickers.length) {
      const mid = this.finishZ * cfg.hip.atFraction;
      let spine = this.kickers[0];
      for (const k of this.kickers) {
        if (Math.abs(k.z - mid) < Math.abs(spine.z - mid)) spine = k;
      }
      spine.hip = true;
      spine.hipAngle = cfg.hip.angle;        // ~20 degrees of split either side on Classic
      spine.halfWidth = Math.max(spine.halfWidth, cfg.hip.minHalfWidth);
      spine.length = Math.max(spine.length, cfg.hip.minLength);
    }

    // Two more signature shapes, promoted the same way. A step-down and a gap
    // jump are both an ordinary ramp with a *far side*: a raised deck the ramp
    // stands on, and a landing that steps back down off it — all of it carried
    // in the kicker's own height field. See the `stepDown`/`gap` commentary in
    // `Runs.js` for what the numbers mean, and `kickerProfile()` below for how
    // the deck is evaluated.
    this._promoteDeck(cfg.stepDown, 'stepDown');
    this._promoteDeck(cfg.gap, 'gap');
  }

  /**
   * Turns the kicker nearest `finishZ * atFraction` into a shape with a deck.
   *
   * Recentred on the track and given floors on its ramp, because these are the
   * obstacles a run is built around: one that happened to be drawn small and
   * pushed against the treeline would not read as the feature it is. It still
   * costs no extra rng draws, so enabling one moves nothing else on the
   * mountain.
   */
  _promoteDeck(spec, flag) {
    if (!spec?.enabled || !this.kickers.length) return null;
    const target = this.finishZ * spec.atFraction;
    let k = this.kickers[0];
    for (const c of this.kickers) {
      if (Math.abs(c.z - target) < Math.abs(k.z - target)) k = c;
    }

    k[flag] = true;
    k.x = this.centerX(k.z);
    k.height = Math.max(k.height, spec.minHeight);
    k.length = Math.max(k.length, spec.minLength);
    k.halfWidth = Math.max(k.halfWidth, spec.minHalfWidth);

    // The deck and the landing, pre-resolved into absolute heights above the
    // terrain so the profile does no more than pick a segment and interpolate.
    // `at` is the distance past the lip at which a segment ends.
    let at = 0;
    let from = spec.lift;
    const segments = spec.landing.map((seg) => {
      const s = { start: at, end: at + seg.run, from, to: seg.to };
      at = s.end;
      from = seg.to;
      return s;
    });
    k.deck = {
      lift: spec.lift,
      approach: spec.approach,
      rampLength: k.length,
      segments,
      length: at,
      halfWidth: k.halfWidth * spec.widthScale,
      edgeBlend: spec.edgeBlend,
    };
    return k;
  }

  /**
   * Bucket kickers by z so the per-frame height lookup stays O(1).
   *
   * The reach has to span the *whole* feature — roll-in, ramp and landing. A
   * kicker bucketed only over its ramp would have its deck silently truncated
   * at a bucket boundary: the height field would step by metres in the middle
   * of a jump, which is far worse than the cost of a slightly wider index.
   */
  _indexKickers() {
    this._kickerBucketSize = 64;
    this._kickerBuckets = new Map();
    for (const k of this.kickers) {
      const deck = k.deck;
      const reach = k.length + (deck ? deck.length + deck.approach : 0) +
        Math.max(k.halfWidth, deck?.halfWidth ?? 0) + 4;
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

  /**
   * Height a single kicker adds at a world position.
   *
   * A `hip` kicker splits in two down its own centreline: each half is the
   * ordinary ramp, rotated a fixed angle away from the other. The two halves
   * are computed independently and picked by which side of the spine `(x,z)`
   * falls on, so the ramp's steepest gradient — the direction it actually
   * launches you — differs depending on which half you rode up. Nothing else
   * about it is special: it is still sampled by the same mesh builder and
   * read by the same physics as an ordinary kicker.
   *
   * A `stepDown` or `gap` kicker keeps that ramp exactly as it is and adds a
   * *deck* underneath it: a raised platform, reached over a roll-in behind the
   * ramp's foot, which continues past the lip and then steps back down to the
   * snow along the `landing` chain. Deck and ramp are two independent terms
   * summed here, with their own widths, so the ramp is a wedge sitting on a
   * wider table rather than a wedge with a table welded to its sides.
   *
   * The chain is one evaluator for both shapes — a step-down holds the deck
   * and steps off it, a gap drops into a void and climbs a landing lip — so
   * they differ only in the numbers `Runs.js` hands them. Zero gradient at
   * every joint is what keeps `groundNormal`'s central differences from
   * stepping anywhere along the feature; the one discontinuity in the whole
   * thing is the lip itself, which is the point of a kicker.
   */
  kickerProfile(k, x, z) {
    const dx = x - k.x;
    const dz = z - k.z;

    let dirX = k.dirX;
    let dirZ = k.dirZ;
    if (k.hip) {
      const side = dx * k.dirZ - dz * k.dirX >= 0 ? 1 : -1;
      const angle = side * k.hipAngle;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      dirX = k.dirX * cos + k.dirZ * sin;
      dirZ = -k.dirX * sin + k.dirZ * cos;
    }

    const s = dx * dirX + dz * dirZ;           // along the ramp
    const t = dx * dirZ - dz * dirX;           // across the ramp
    const at = Math.abs(t);
    const cfg = this.config.kickers;

    let h = 0;
    if (s >= 0 && s <= k.length && at <= k.halfWidth) {
      const p = s / k.length;
      // Steepest right at the lip: that is what converts speed into loft.
      const rise = Math.pow(p, cfg.rampExponent);
      const across = 1 - smoothstep(k.halfWidth - cfg.edgeBlend, k.halfWidth, at);
      h = k.height * rise * across;
    }

    const deck = k.deck;
    if (!deck || at > deck.halfWidth) return h;
    return h + this._deckHeight(deck, s - k.length) *
      (1 - smoothstep(deck.halfWidth - deck.edgeBlend, deck.halfWidth, at));
  }

  /**
   * The deck under a step-down or a gap, as a function of distance past the
   * lip.
   *
   * Behind the lip it is the roll-in easing from the snow up to `lift`, and
   * then the flat of the deck under the ramp itself. Past the lip it walks the
   * `landing` chain, one smoothstep per segment. Everything outside the
   * feature is 0, which is the terrain, so the whole thing joins the mountain
   * flush at both ends.
   */
  _deckHeight(deck, u) {
    if (u <= -deck.rampLength) {
      // The roll-in. Its foot is `approach` metres behind the ramp's foot.
      return deck.lift * smoothstep(-deck.rampLength - deck.approach, -deck.rampLength, u);
    }
    if (u <= 0) return deck.lift;
    if (u >= deck.length) return 0;
    // Which segment `u` falls in. There are two or three, so a scan beats
    // anything cleverer.
    let seg = deck.segments[deck.segments.length - 1];
    for (const c of deck.segments) {
      if (u < c.end) { seg = c; break; }
    }
    return seg.from + (seg.to - seg.from) * smoothstep(seg.start, seg.end, u);
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

  /**
   * True when a position is on (or very near) a kicker — used by scatter
   * placement to keep trees, rails and stars off a ramp.
   *
   * The deck counts, roll-in and landing and all. A tree in the run-out of a
   * gap jump is the one thing on this mountain that ends a run, planted at the
   * exact spot where the rider has no say in where they are going.
   */
  onKicker(x, z, pad = 3) {
    const near = this.kickersNear(z);
    for (const k of near) {
      const dx = x - k.x;
      const dz = z - k.z;
      const s = dx * k.dirX + dz * k.dirZ;
      const t = dx * k.dirZ - dz * k.dirX;
      if (s > -pad && s < k.length + pad && Math.abs(t) < k.halfWidth + pad) return true;
      const deck = k.deck;
      if (deck && s > -deck.approach - pad && s < k.length + deck.length + pad &&
          Math.abs(t) < deck.halfWidth + pad) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------
   * Rails
   *
   * A rail is a strip of ground-following height offset by a fixed lift, the
   * same `dirX/dirZ`-along, perpendicular-across parametrisation kickers use.
   * A minority bend, via `curveRadius`: a gentle quadratic drift across the
   * rail's length that approximates an arc without needing real arc-length
   * parametrisation over such a short span. Rails do not feed into
   * `terrainHeight`/`kickerHeight` — the snow underneath stays real snow, so
   * falling off drops you straight to it rather than ejecting you.
   * ---------------------------------------------------------------- */

  _buildRails() {
    const rng = this.rng;
    const cfg = this.config.rails;
    this.rails = [];
    let z = cfg.firstZ;
    while (z < this.finishZ - cfg.endMargin) {
      if (rng() < cfg.chance && !this.onKicker(this.centerX(z), z, cfg.kickerClearance)) {
        const curved = rng() < cfg.curveChance;
        const len = cfg.length.min + rng() * cfg.length.range;
        const height = cfg.height.min + rng() * cfg.height.range;
        const offset = rng.spread(this.trackHalfWidth - cfg.offsetMargin);
        const cx = this.centerX(z) + offset * Math.cos(Math.atan(this.centerSlope(z)));
        const tan = this.trackTangent(z);
        this.rails.push({
          x: cx,
          z,
          dirX: tan.x,
          dirZ: tan.z,
          length: len,
          height,
          halfWidth: cfg.halfWidth,   // visual width — the catch margin is separate and wider
          curveRadius: curved
            ? (rng() < 0.5 ? 1 : -1) * (cfg.curveRadius.min + rng() * cfg.curveRadius.range)
            : 0,
        });
      }
      z += cfg.spacing.min + rng() * cfg.spacing.range;
    }
  }

  _indexRails() {
    this._railBucketSize = 64;
    this._railBuckets = new Map();
    for (const rail of this.rails) {
      const reach = rail.length + 6;
      const from = Math.floor((rail.z - reach) / this._railBucketSize);
      const to = Math.floor((rail.z + reach) / this._railBucketSize);
      for (let b = from; b <= to; b++) {
        if (!this._railBuckets.has(b)) this._railBuckets.set(b, []);
        this._railBuckets.get(b).push(rail);
      }
    }
  }

  railsNear(z) {
    return this._railBuckets.get(Math.floor(z / this._railBucketSize)) ?? EMPTY;
  }

  /** World position at arc-length `s` along a rail, 0 at the foot. */
  railPointAt(rail, s) {
    const px = rail.dirZ;
    const pz = -rail.dirX;
    const bend = rail.curveRadius ? (s * s) / (2 * rail.curveRadius) : 0;
    return { x: rail.x + rail.dirX * s + px * bend, z: rail.z + rail.dirZ * s + pz * bend };
  }

  /** Unit tangent at arc-length `s` — where the rail is heading at that point. */
  railTangentAt(rail, s) {
    const dBend = rail.curveRadius ? s / rail.curveRadius : 0;
    const tx = rail.dirX + rail.dirZ * dBend;
    const tz = rail.dirZ - rail.dirX * dBend;
    const len = Math.hypot(tx, tz) || 1;
    return { x: tx / len, z: tz / len };
  }

  /** Height of the rail's riding surface at arc-length `s`. */
  railHeightAt(rail, s) {
    const p = this.railPointAt(rail, s);
    return this.terrainHeight(p.x, p.z) + rail.height;
  }
}

const EMPTY = [];

/**
 * Sum of `amp * sin(z * freq + phase)` over a list of waves.
 *
 * The fall line's swells and the track's wander are both built from one of
 * these. Keeping it a list rather than three named terms is what lets a run
 * preset change the *character* of the line — a single long traverse, or a
 * dozen tight switchbacks — instead of only its size.
 */
function sumWaves(waves, z) {
  let sum = 0;
  for (let i = 0; i < waves.length; i++) {
    const w = waves[i];
    sum += w.amp * Math.sin(z * w.freq + w.phase);
  }
  return sum;
}

/** Sum of `amp * (valueNoise2(x * freq, z * freq, seed) - 0.5)` over a list of octaves. */
function sumNoise(layers, x, z) {
  let sum = 0;
  for (let i = 0; i < layers.length; i++) {
    const n = layers[i];
    sum += n.amp * (valueNoise2(x * n.freq, z * n.freq, n.seed) - 0.5);
  }
  return sum;
}
