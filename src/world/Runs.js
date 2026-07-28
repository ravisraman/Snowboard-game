/**
 * Run presets — the shape of a mountain, as data.
 *
 * `Course` used to hold its numbers inline: the bell curves of the fall line,
 * the sine sum the track wanders along, how often a kicker appears and how big
 * it is. All of it is now here, so a new run is a new object in this file
 * rather than a new branch inside the generator.
 *
 *   import { CLASSIC } from './Runs.js';
 *   const course = new Course(seed, CLASSIC);
 *
 * ---------------------------------------------------------------------------
 * Writing a new preset
 * ---------------------------------------------------------------------------
 * Copy `CLASSIC`, change numbers, add it to `RUNS`. Nothing in `Course.js` or
 * `Trees.js` needs to know it exists. Two rules keep that true:
 *
 *   1. Every field below is required. There is no defaulting layer — a missing
 *      field is a `NaN` somewhere three hundred metres down the hill, not a
 *      sensible fallback. `defineRun()` copies `CLASSIC` for you so partial
 *      presets are still whole objects.
 *   2. Arrays are the extension point. `grade.bells`, `undulation.waves`,
 *      `track.waves`, `powder.lumps` and `farField.layers` may hold any number
 *      of entries, including none. That is how a run gets a different
 *      *character* rather than a different amount of the same character.
 *
 * ---------------------------------------------------------------------------
 * Coordinates
 * ---------------------------------------------------------------------------
 *   +Z downhill, +X skier's right, +Y up. `u` is signed perpendicular distance
 *   from the track centre line (negative left). Distances are metres,
 *   `grade` is a dimensionless slope (metres of drop per metre of z).
 */

/**
 * @typedef {{ amp: number, freq: number, phase: number }} Wave
 *   `amp * sin(z * freq + phase)`. Summed left to right in array order.
 * @typedef {{ amp: number, freq: number, seed: number }} NoiseLayer
 *   `amp * (valueNoise2(x * freq, z * freq, seed) - 0.5)`.
 * @typedef {{ min: number, range: number }} Span
 *   One `rng()` draw: `min + rng() * range`.
 * @typedef {{ amount: number, from: number, to: number }} Taper
 *   Multiplies by `1 - amount * smoothstep(from, to, z)` — used to flatten and
 *   straighten a run out before the finish.
 */

/**
 * The run the game has always shipped: a long alpine descent with two steeper
 * pitches, a lazy left-right wander, and a runout into the village.
 *
 * Treat these numbers as the reference for what each field means; every one of
 * them is exercised by the `classic course digest` assertions in
 * `tools/check-mechanics.mjs`, so changing one here will be caught there.
 */
export const CLASSIC = {
  /* --- identity -------------------------------------------------------- */
  id: 'classic',
  name: 'Classic Descent',
  blurb: 'Wide open groomers all the way to the village.',
  /**
   * Card copy for the run picker. Kept here rather than in the UI so that a
   * new run is still one object in one file — the terrain and the way the
   * player is told about it have no business drifting apart.
   *
   * `grade` is 1-3, gentlest first, and drives the dots on the card: a child
   * who cannot yet read the blurb can still see which run is the easy one.
   */
  grade: 1,
  hint: 'GENTLE',
  features: ['Big friendly kickers', 'Room to make mistakes'],
  /** Default world seed. A score is only comparable with one from the same mountain. */
  seed: 20240117,

  /* --- extent ---------------------------------------------------------- */
  /** Metres from the drop-in gate to the finish banner. */
  length: 3000,
  /** Where the rider is placed at the start of a run. */
  startZ: 24,
  /** Crossing this z ends the run. Placement loops all measure back from here. */
  finishZ: 2870,
  /** How far the meshed terrain extends either side of the track. */
  halfWidth: 190,
  /** Extra metres of fall line integrated past `length`, so the far field has ground under it. */
  profileMargin: 420,

  /* --- fall line ------------------------------------------------------- */
  /**
   * Steepness as a function of z, integrated once at startup into a height
   * table. `base` is the resting grade; each bell adds a pitch centred at
   * `center` with a Gaussian half-life of `width`; `runout` subtracts grade
   * over the last stretch so the run flattens into the village.
   */
  grade: {
    base: 0.17,
    /** @type {{ amp: number, center: number, width: number }[]} */
    bells: [
      { amp: 0.07, center: 900, width: 280 },
      { amp: 0.06, center: 1850, width: 320 },
    ],
    /** @type {Taper} `amount` is subtracted grade, not a multiplier. */
    runout: { amount: 0.135, from: 2660, to: 2980 },
  },

  /**
   * Rolling swells along the fall line, on top of the integrated grade.
   * Faded out by `taper` so the finish straight is flat enough to read.
   */
  undulation: {
    /** @type {Taper} */
    taper: { amount: 0.85, from: 2560, to: 2940 },
    /** @type {Wave[]} */
    waves: [
      { amp: 4.0, freq: 0.006, phase: 0 },
      { amp: 2.4, freq: 0.014, phase: 1.3 },
      { amp: 1.2, freq: 0.028, phase: 0.4 },
    ],
  },

  /* --- the groomed track ----------------------------------------------- */
  /**
   * The corduroy: how wide it is, and where its centre line goes.
   *
   * `waves` is the whole plan-view shape of the run. Bigger amplitudes at low
   * frequency give long sweeping traverses; adding a small high-frequency term
   * makes the line fidgety and hard to hold at speed.
   */
  track: {
    /**
     * Groomed half-width. Wider than a real piste of this pitch, deliberately:
     * at a hundred and twenty km/h a board covers thirty-odd metres a second,
     * and the margin for a wobble has to be measured in the same units as the
     * speed.
     *
     * NOTE: `Terrain.js` bakes this into GLSL from the module-level `COURSE`
     * export rather than from a `Course` instance — see the compatibility note
     * at the top of `Course.js` before varying it per run.
     */
    halfWidth: 16,
    /** Metres of blend between corduroy and powder. */
    edgeSoftness: 3.2,
    /** @type {Taper} Straightens the line out for the finish. */
    taper: { amount: 0.9, from: 2680, to: 2980 },
    /** @type {Wave[]} Summed to give `centerX(z)`. */
    waves: [
      { amp: 34, freq: 0.0042, phase: 0 },
      { amp: 17, freq: 0.0098, phase: 2.1 },
      { amp: 8.5, freq: 0.019, phase: 0.7 },
    ],
  },

  /* --- height field, across the slope ---------------------------------- */
  /**
   * A shallow bowl cradling the track, so the piste reads as a valley floor.
   * `strength * (hypot(u, softness) - softness)`, eased off past `easeFrom` so
   * the valley walls do not become cliffs.
   */
  bowl: { strength: 0.1, softness: 30, easeAmount: 0.45, easeFrom: 90, easeTo: 320 },

  /**
   * Off-piste lumpiness. `blendFrom`/`blendTo` are offsets from
   * `track.halfWidth`: powder is fully absent inside `halfWidth + blendFrom`
   * and fully present outside `halfWidth + blendTo`.
   */
  powder: {
    blendFrom: -1,
    blendTo: 9,
    /** @type {NoiseLayer[]} */
    lumps: [
      { amp: 0.95, freq: 0.036, seed: 71 },
      { amp: 0.32, freq: 0.085, seed: 913 },
    ],
  },

  /** The very slight crown the groomer leaves on the piste: `amp * cos(u * freq)`. */
  camber: { amp: 0.06, freq: 0.24 },

  /**
   * Slow rolling in the far snowfields, faded in between `from` and `to`
   * metres out. Without it the terrain's outer edge draws a dead-straight line
   * against the peaks on the horizon.
   */
  farField: {
    from: 200,
    to: 420,
    /** @type {NoiseLayer[]} */
    layers: [
      { amp: 12, freq: 0.0028, seed: 31 },
      { amp: 4.5, freq: 0.0065, seed: 57 },
    ],
  },

  /* --- kickers ---------------------------------------------------------- */
  /**
   * Walked down the hill from `firstZ` to `finishZ - endMargin`, one kicker per
   * step, stepping `spacing` each time. Density is therefore `spacing`: smaller
   * numbers mean a jump line, larger ones mean a mountain you mostly ride.
   *
   * `height`, `length` and `width` share one `size` draw for the first two, so
   * a taller kicker is always a longer one — a tall short ramp is a wall.
   */
  kickers: {
    firstZ: 300,
    /** Last kicker sits no closer than this to `finishZ`. */
    endMargin: 220,
    /** @type {Span} Metres of z between one kicker and the next. */
    spacing: { min: 150, range: 135 },
    /** @type {Span} Lip height. Shares its draw with `length`. */
    height: { min: 1.5, range: 1.9 },
    /** @type {Span} Ramp run. Short and steep — about 25 degrees at the lip on Classic. */
    length: { min: 6.5, range: 5.0 },
    /** @type {Span} Full table width (halved into `halfWidth` on the record). */
    width: { min: 7.5, range: 5.5 },
    /** Kept this far inside the corduroy edge when placed across the piste. */
    offsetMargin: 1.5,
    /** `pow(p, rampExponent)` along the ramp. Above 1 is steepest at the lip. */
    rampExponent: 1.7,
    /** Metres of taper down to nothing at the ramp's sides. */
    edgeBlend: 2.6,
    /**
     * One signature jump: a spine that splits down its own centreline, each
     * half rotated `angle` radians away from the other. Promoted from whichever
     * ordinary kicker lands nearest `finishZ * atFraction`, so it costs no
     * extra rng draws. Set `enabled: false` for a run with no spine.
     */
    hip: { enabled: true, atFraction: 0.5, angle: 0.36, minHalfWidth: 6.5, minLength: 10 },
  },

  /* --- rails ------------------------------------------------------------ */
  /**
   * Walked the same way as kickers, but each step only places a rail with
   * probability `chance`, and never within `kickerClearance` of a ramp.
   */
  rails: {
    firstZ: 260,
    endMargin: 200,
    /** @type {Span} */
    spacing: { min: 130, range: 140 },
    /** Probability a given step places a rail at all. 0 for a run with no rails. */
    chance: 0.5,
    /** Skip a candidate whose foot is within this many metres of a kicker. */
    kickerClearance: 10,
    /** @type {Span} */
    length: { min: 9, range: 7 },
    /** @type {Span} Height of the bar above the snow. */
    height: { min: 0.55, range: 0.35 },
    /** Kept this far inside the corduroy edge. */
    offsetMargin: 6,
    /** Visual width of the bar. The catch margin the rider uses is separate and wider. */
    halfWidth: 0.16,
    /** Probability a rail bends rather than running straight. */
    curveChance: 0.35,
    /** @type {Span} Radius of the bend, signed left or right on a coin flip. */
    curveRadius: { min: 35, range: 25 },
  },

  /* --- trees ------------------------------------------------------------ */
  /**
   * The forest scatter, consumed by `buildForest()` in `Trees.js`.
   *
   * It walks z in `step` metres and makes `attempts` candidates per step, so
   * the raw candidate count is fixed; `density` and the band rolls decide how
   * many survive. The generator keeps its own `seed` on purpose — sharing the
   * course's meant that a kicker moving reshuffled the whole treeline.
   *
   * `bands` decides how far off the line a tree stands. The `upTo` values are
   * cumulative thresholds on one `rng()` roll, so they must ascend:
   *   roll < encroach.upTo  -> right on the piste edge
   *   roll < near.upTo      -> the near treeline
   *   roll < mid.upTo       -> the mid slope
   *   otherwise             -> the far field (skipped entirely on low quality)
   * Each band places the tree at `track.halfWidth + gap + rng() * range` out,
   * except `far`, which is measured from the centre line: `from + rng() * range`.
   */
  trees: {
    seed: 51413,
    /** Scatter starts above the gate and runs `zMargin` past `length`. */
    zFrom: -60,
    zMargin: 380,
    step: 2.6,
    attempts: 3,
    /** Master keep-probability, multiplied by the quality setting's own scale. */
    density: 0.62,
    /** @type {Span} Per-tree uniform scale. */
    scale: { min: 0.62, range: 0.95 },
    /** Candidates further out than this are dropped outright. */
    maxOffset: 440,
    /** Thins the far field so the near band stays the visual anchor. */
    thin: { from: 30, over: 190, amount: 0.55 },
    /** Beyond `halfWidth - margin`, only `1 - keep` of candidates survive. */
    outerCull: { margin: 6, keep: 0.8 },
    bands: {
      /**
       * Encroaching on the piste, but with a couple of metres of forgiveness
       * outside the corduroy: drifting a board's width off the groomed line
       * while you sort out a landing should cost speed, not the run. `gap` is
       * added on top of the tree's own collision radius here.
       */
      encroach: { upTo: 0.02, gap: 2.6, range: 2.4 },
      near: { upTo: 0.6, gap: 4, range: 26 },
      mid: { upTo: 0.86, gap: 22, range: 150 },
      far: { from: 200, range: 230 },
    },
    /** Symmetric z jitter, so the rows the walk would otherwise make disappear. */
    jitter: 1.3,
    /** No tree within this many metres of a kicker ramp. */
    kickerPad: 4,
    /** A clearing around the village, so the chalets are visible on the run in. */
    clearing: { fromZ: 2820, halfWidth: 70, keep: 0.16 },
  },

  /* --- collectibles ----------------------------------------------------- */
  /**
   * Stars and slalom gates.
   *
   * DECLARED BUT NOT YET CONSUMED. `Collectibles.js` still holds these numbers
   * inline; it reads `course.finishZ` and `course.trackHalfWidth` from the
   * instance, so a new run already gets correctly-scaled placement, just not
   * a different density. The values below mirror what it currently does, so
   * wiring it up is a mechanical substitution with no behaviour change.
   */
  collectibles: {
    seed: 8823,
    stars: {
      firstZ: 70,
      endMargin: 40,
      /** @type {Span} z between candidates. */
      spacing: { min: 8, range: 9 },
      /** Probability a candidate is discarded — raise it for a sparser run. */
      skipChance: 0.6,
      kickerPad: 8,
      /** Probability a star sits near the line rather than off it. */
      detourChance: 0.72,
      /** Spread as a fraction of `track.halfWidth` for on-line stars. */
      onTrackSpread: 0.55,
      /** Extra metres past `track.halfWidth` for off-line stars. */
      offTrackExtra: 9,
      /** Metres above the ground. */
      hover: 1.05,
    },
    gates: {
      firstZ: 220,
      endMargin: 260,
      /** Only place where |centerSlope| is below this — a gate on a hard traverse is unfair. */
      maxSlope: 0.3,
      kickerPad: 12,
      chance: 0.55,
      /** Poles per slalom group: `min + rng.int(0, extra)`. */
      count: { min: 3, extra: 2 },
      /** @type {Span} z between poles in a group. */
      spacing: { min: 15, range: 5 },
      /** @type {Span} How far the line weaves side to side. */
      weave: { min: 5, range: 3 },
      /** @type {Span} Half the gap between the two poles of a gate. */
      halfWidth: { min: 3.4, range: 0.8 },
      /** Gap after a group: `count * gapPerGate + gapAfter`. */
      gapPerGate: 20,
      /** @type {Span} */
      gapAfter: { min: 110, range: 90 },
      /** z step taken when a candidate site is rejected. */
      stride: 45,
    },
  },
};

/**
 * Builds a preset from a sparse override on top of `CLASSIC`.
 *
 * Merging is deep for plain objects and *replacing* for arrays — an override
 * that supplies two `track.waves` gets exactly two, not two spliced over
 * Classic's three. Anything not mentioned is inherited, so a preset only ever
 * states what makes it different.
 */
export function defineRun(overrides) {
  return deepMerge(CLASSIC, overrides);
}

function deepMerge(base, over) {
  if (Array.isArray(over)) return over.map((v) => (isPlain(v) ? deepMerge({}, v) : v));
  if (!isPlain(over)) return over;
  const out = Array.isArray(base) ? [] : { ...base };
  for (const key of Object.keys(over)) {
    const b = out[key];
    const o = over[key];
    out[key] = isPlain(o) || Array.isArray(o) ? deepMerge(isPlain(b) || Array.isArray(b) ? b : {}, o) : o;
  }
  return out;
}

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Every run the game can offer, in the order a menu should list them. */
export const RUNS = [CLASSIC];

/** Look a run up by `id`, falling back to Classic rather than throwing. */
export function runById(id) {
  return RUNS.find((r) => r.id === id) ?? CLASSIC;
}
