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

import { ELEVATION_GRADE, ELEVATION_WANDER, ELEVATION_STEP } from './Elevation.js';

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
 * @typedef {{ samples: number[], step: number, scale: number }} Profile
 *   A baked table read against z — `samples[z / step] * scale`, interpolated,
 *   holding its end value beyond the last sample. Added to whatever the
 *   analytic terms alongside it produce, never replacing them. This is how
 *   surveyed elevation gets in; see `src/world/Elevation.js`.
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
   * `rating` is 1-3, gentlest first, and drives the dots on the card: a child
   * who cannot yet read the blurb can still see which run is the easy one.
   *
   * It is *not* called `grade`, which on this object is already the fall line's
   * steepness curve. The two would be the same key in the same object literal,
   * the terrain one would silently win, and the card would render its dots from
   * an object — which is exactly what happened before this comment existed.
   */
  rating: 1,
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
    /**
     * @type {Profile|null} Surveyed steepness, added to `base` and `bells`.
     * `null` on every hand-written run; see `MASSIF` for the one that uses it.
     */
    profile: null,
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
     * This is the *base* width. `fork` widens it over its own stretch of the
     * run, so anything that needs the width at a particular z should ask
     * `course.trackHalfWidthAt(z)` rather than reading this number.
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
    /** @type {Profile|null} Surveyed wander, added to `waves`. */
    profile: null,
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

  /* --- the fork -------------------------------------------------------- */
  /**
   * A fork and rejoin: the piste widens, a rounded ridge rises down the middle
   * of it, and for a few hundred metres there are two lanes instead of one.
   *
   * It is nothing but a shape in the height field. There is no lane parameter,
   * no committed-lane state on the rider and no second centre line — at every
   * (x, z) there is still exactly one ground height, so collision, the mesh,
   * the trees and the tracks ribbon all pick the fork up for free. What makes
   * it a *choice* rather than a bump is the rider's lateral gravity coupling
   * (`TUNING.bankDrift` in `Rider.js`): the ridge's flanks tilt across the
   * board and turn the nose away from the crest, so an approach a metre off
   * centre is carried into that lane and stays there. Ride the crest dead
   * straight and you go over it — it costs you height and speed, and that is
   * the whole penalty. It is never a wall.
   *
   * Two derived quantities matter to anyone writing a run:
   *   - the corduroy widens to `track.halfWidth + widen` while the fork is
   *     open, so both lanes sit on groomed snow rather than in the powder;
   *   - the lanes run from `|u| = maxSeparation` out to that widened edge, so
   *     each is `track.halfWidth + widen - maxSeparation` metres across.
   *
   * `Terrain.js` samples the *widest* the corduroy ever gets at its fine 1.5 m
   * spacing across the whole run, so `widen` costs vertices everywhere. Keep it
   * to what the lanes actually need.
   *
   * Off on Classic. Set `enabled: true` and the rest of these numbers describe
   * a fork you can ride; they are sized for a 16 m half-width piste.
   */
  fork: {
    enabled: false,
    /**
     * The ridge ramps in over `z0`→`z1`, is held at full height `z1`→`z2`, and
     * eases back out over `z2`→`z3`, each with the same smoothstep the track's
     * finish taper uses. Give the ramps room: a hundred metres or so, so the
     * split is visible from far enough back to be decided on.
     */
    z0: 1180, z1: 1310, z2: 1700, z3: 1830,
    /** Height of the crest above the piste it sits on, metres. */
    maxHeight: 3,
    /**
     * Half-width of the ridge, metres — so the two lanes are `2 * maxSeparation`
     * metres apart at their inner edges. Also sets how steep the flanks are:
     * the steepest gradient anywhere on the ridge is `maxHeight * PI / (2 *
     * maxSeparation)`, which at these numbers is about 36 degrees. Push that
     * much past 40 and it stops being rideable.
     */
    maxSeparation: 6.5,
    /** Extra groomed half-width while the fork is open, so both lanes are corduroy. */
    widen: 10,
    /**
     * Fraction of `maxSeparation` the groomer cannot reach. Inside it the ridge
     * is untracked snow — powder colour, wind ripples, no corduroy — which is
     * what makes the split read as a split rather than as a lump in the piste.
     */
    groomGap: 0.5,
  },

  /* --- moguls ----------------------------------------------------------- */
  /**
   * A bump field over a stretch of the piste: a cosine lattice across and along
   * the track, sheared so the rows run diagonally, and multiplied by value
   * noise so it is rhythmic without being a waffle iron.
   *
   * Rideable, not a crash surface. The steepest gradient the field can reach is
   * `amp * (1 + jitter) * 2*PI / min(spacingU, spacingZ)` — the two axes peak a
   * quarter-wave apart, so they do not add — which at the numbers below is 0.66.
   * `check-mechanics.mjs` sweeps the whole field and finds a worst surface
   * normal of n.y = 0.79, about 38 degrees, which a board carries speed over.
   *
   * `Terrain.js` refines its row spacing over the mogul range so the mesh
   * actually resolves the bumps — otherwise the visuals and the collision, which
   * is analytic and therefore exact, would quietly disagree by a boot's depth.
   *
   * Off on Classic.
   */
  moguls: {
    enabled: false,
    /** Faded in over `z0`→`z1`, held, faded out over `z2`→`z3`. */
    z0: 700, z1: 780, z2: 1050, z3: 1130,
    /** Half the crest-to-trough height, metres. */
    amp: 0.7,
    /** Metres between crests across the piste and down it. */
    spacingU: 9,
    spacingZ: 12,
    /** Shear: metres of z the lattice slides per metre across, so rows run diagonally. */
    skew: 0.45,
    /** Bumps fade to nothing this far inside the corduroy edge, and 2 m past it. */
    edgeFade: 3,
    /** Irregularity. `1 + jitter * 2 * (valueNoise2(...) - 0.5)` scales every bump. */
    jitter: 0.35,
    noiseFreq: 0.02,
    seed: 4471,
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

    /**
     * ---------------------------------------------------------------------
     * Shapes with a far side: step-downs and gap jumps
     * ---------------------------------------------------------------------
     * An ordinary kicker is a ramp and nothing else — past the lip the ground
     * is whatever the terrain says it is. These two are ramps *plus a landing*,
     * carried in the kicker's own height field rather than in the terrain:
     * `groundHeight = terrainHeight + kickerHeight`, and the kicker field is
     * free to describe as much of the far side as it likes. That is what lets a
     * run place a step-down or a gap anywhere without the terrain knowing.
     *
     * ---------------------------------------------------------------------
     * Why these are built *up* rather than dug down
     * ---------------------------------------------------------------------
     * `kickerHeight` may go negative — nothing stops it, and `groundHeight`
     * handles it correctly. It is the *rendering* that cannot: `Terrain.js`
     * meshes `terrainHeight` alone, as one opaque sheet, so any ground the
     * kicker field puts below the terrain is behind that sheet and is simply
     * not there to look at. An excavated landing rides fine and photographs as
     * unbroken snow, with the rider sinking into it. (Checked, with pictures,
     * before this was written the other way round.)
     *
     * So the drop is made by raising the take-off rather than by sinking the
     * landing. `lift` is a deck the whole feature stands on, reached over an
     * `approach` roll-in behind the ramp; the landing then steps back *down* to
     * the natural snow. What the rider feels is the height of the lip above
     * where they touch down, and that is the same either way — but this way
     * every surface they can see or ride is at or above the terrain.
     *
     * ---------------------------------------------------------------------
     * The `landing` chain
     * ---------------------------------------------------------------------
     * Both shapes are described by the same field: a list of segments walked
     * outward from the lip. Each eases from wherever the previous one finished
     * to `to` over `run` metres, with a smoothstep, so every joint has zero
     * gradient and the surface normal never steps. `to` is metres above the
     * natural snow; the chain starts at `lift` (the deck, immediately past the
     * lip) and should finish at 0, back onto the terrain, so the feature ends.
     *
     *   step-down  hold the deck, then step off it:   [lift, 0]
     *   gap        off the deck into the void, over
     *              the landing lip, away down its
     *              back:                              [0, +crest, 0]
     *
     * Two rules keep a landing ridable, and both are asserted in
     * `tools/check-mechanics.mjs`:
     *
     *   1. A segment's steepest gradient is `1.5 * |rise| / run` — the peak of
     *      a smoothstep. Every *climbing* segment (the roll-in, and a gap's
     *      landing lip) must stay under the run's local `grade`, or the feature
     *      contains a real hill and a rider who cases the gap is stranded at
     *      the bottom of it. Classic's grade is 0.17 at rest and about 0.24
     *      through the steeper pitches; a flatter run needs gentler numbers.
     *   2. The whole thing is a fall-line feature: nothing here steers, so it
     *      has to be wide enough to catch a rider who drifted on the way in.
     *      Hence `widthScale` — deck and landing are wider than the ramp — and
     *      `edgeBlend`, a long lateral taper rather than the ramp's short one,
     *      because a 4 m deck tapering over 2.6 m is a wall down each side.
     *
     * `atFraction` promotes whichever ordinary kicker lands nearest
     * `finishZ * atFraction`, exactly as `hip` does, so enabling one costs no
     * extra rng draws and moves no other feature. The promoted kicker is
     * recentred on the track: these are signature obstacles, and being handed a
     * gap jump tucked against the treeline is a different game.
     */

    /**
     * Step-down: a raised take-off, a deck running on past the lip, and then
     * the ground dropping away to the snow.
     *
     * The drop is what buys the hang time, and the transition is placed where
     * a committed rider actually touches down. Hang back and you land on the
     * flat of the deck or on the shallow top of the step and get bucked;
     * commit, and the face is running away from you at close to your own
     * flight angle and you keep nearly all of your speed.
     *
     * Fitted to the `cruise` tuning, which is what the game ships on: the lip
     * speeds a step-down has to serve span 19 to 35 m/s across the two
     * tunings, and 26 m of transition cannot cover the 44 m of landing spread
     * that implies. Flat out on `original` you over-jump it and land on the
     * flat past it, for about thirty per cent of your speed — which is what
     * over-jumping a landing costs, and it is still a landing.
     */
    stepDown: {
      enabled: false,
      /** Promoted from the ordinary kicker nearest `finishZ * atFraction`. */
      atFraction: 0.34,
      /**
       * Floors applied to the promoted kicker, so the shape is never a stub.
       *
       * `minHeight / minLength` is steeper than any ordinary kicker on Classic
       * reaches (0.34 against 0.30), and it has to be: the ramp's gradient at
       * the lip is what converts speed into loft, and a step-down that hangs no
       * longer than the kicker two hundred metres up the hill is only a kicker
       * with a view.
       */
      minHeight: 3.4,
      minLength: 10,
      minHalfWidth: 6.5,
      /** Height of the deck the take-off stands on, above the natural snow. */
      lift: 3.8,
      /**
       * Metres of roll-in behind the ramp's foot, from the snow up onto the
       * deck. Long enough that its steepest gradient — `1.5 * lift / approach`
       * — stays under the run's grade, so riding onto the deck never costs a
       * climb.
       */
      approach: 28,
      /**
       * Deck and landing half-width, as a multiple of the ramp's. The flat of
       * the deck is `halfWidth * widthScale - edgeBlend`, and that has to be at
       * least the ramp's own half-width or the ramp overhangs the deck's flank.
       */
      widthScale: 2.0,
      /** Metres of lateral taper at the deck's and the landing's edges. */
      edgeBlend: 6,
      /** @type {{ run: number, to: number }[]} */
      landing: [
        { run: 14, to: 3.8 },   // the deck runs on past the lip: the knuckle
        { run: 26, to: 0 },     // and then steps down to the snow
      ],
    },

    /**
     * Gap jump: take-off, a real void, and a landing lip on the far side.
     *
     * The void is the stretch where the deck has ended and the landing has not
     * begun: natural snow, nearly four metres below the crest of the landing
     * and over seven below the lip you left. Its floor and the landing's near
     * face are one continuous smoothstep, and that is the whole
     * safety story: a rider who comes up short lands in the trough and rides
     * back up out of it, losing speed and flow but nothing else. There is no
     * wall to hit, because in this game almost nothing but a tree square on
     * ends a run.
     */
    gap: {
      enabled: false,
      atFraction: 0.68,
      minHeight: 3.4,
      minLength: 11,
      minHalfWidth: 6.5,
      lift: 3.8,
      approach: 28,
      widthScale: 2.0,
      edgeBlend: 6,
      /**
       * @type {{ run: number, to: number }[]}
       * The gap proper is the first two segments — 22 m from the lip to the
       * crest of the landing. That number is the whole design, and it is set
       * by what the rider can actually reach at the speed the piste gives
       * them, measured rather than guessed. See the gap jump block at the end
       * of `tools/check-mechanics.mjs` for the air off this take-off and the
       * margin by which it clears the crest on both tunings.
       */
      landing: [
        { run: 8, to: 0 },      // off the deck into the void
        { run: 14, to: 3.8 },   // up over the landing lip
        { run: 28, to: 0 },     // and away down its back
      ],
    },
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

  /* --- tunnels ---------------------------------------------------------- */
  /**
   * Bores the rider shoots through, consumed by `buildTunnels()` in
   * `Tunnels.js`.
   *
   * Spectacle only, and deliberately so. A tunnel is never a hazard: there is
   * no ceiling collision, nothing in `_checkHazards` consults it, and the arch
   * is cut with far more headroom than anything on the run can throw you to.
   * What it changes is the *room* — the light drops, the fog closes in and
   * darkens, and the two continuous audio voices get a low-pass dragged down
   * over them, all three blended over `blend` metres so a portal at 36 m/s
   * reads as a transition rather than a cut.
   *
   * Off on Classic, which is why `spans` is empty and `enabled` is false: the
   * digest checks in `tools/check-mechanics.mjs` assert Classic's height
   * field, features and forest are bit-for-bit unchanged, and a tunnel adds
   * nothing to any of them anyway — it is a mesh over the top, not terrain.
   *
   * A run that wants tunnels sets `enabled: true` and lists `spans`. Every
   * section field may be given run-wide here and overridden per span:
   *
   *   tunnels: {
   *     enabled: true,
   *     crown: 16,
   *     spans: [
   *       { from: 820, to: 980 },
   *       { from: 1740, to: 1830, crown: 12, ribSpacing: 6 },
   *     ],
   *   }
   *
   * The bore follows the track: its axis is `centerX(z)` and its section is
   * squared up to `trackTangent(z)`, so it bends with the run rather than
   * cutting a straight chord across a curve.
   */
  tunnels: {
    /** Master switch. False means `buildTunnels` returns an empty group. */
    enabled: false,
    /**
     * @type {{ from: number, to: number, halfWidth?: number, wallHeight?: number,
     *          crown?: number, ribSpacing?: number, blend?: number }[]}
     * Each entry is one bore, `from` and `to` in metres of z. Anything omitted
     * falls back to the run-wide value below. Spans shorter than about 60 m
     * are not worth having — the blend eats most of them.
     */
    spans: [],

    /* --- section (run-wide defaults, overridable per span) --------------- */
    /**
     * Half the bore's width. Must clear `track.halfWidth` by a comfortable
     * margin: the walls are where the arch meets the ground, and a rider who
     * drifts off the corduroy inside a tunnel should still be under the roof.
     */
    halfWidth: 28,
    /**
     * Height of the vertical side walls, up to the springline, and the
     * headroom on the centre line at the top of the vault.
     *
     * Both are a *starting* shape, not a promise — `buildTunnels()` scales
     * them up if the two headroom numbers below are not met, so the authored
     * proportions survive while the guarantee holds. Read the built values off
     * `tunnels.list[i]`, not from here.
     */
    wallHeight: 8,
    crown: 16,
    /** Metres between the arch ribs. They are what turn a dark tube into speed. */
    ribSpacing: 9,

    /* --- guaranteed headroom --------------------------------------------- */
    /**
     * This is the part that makes a tunnel safe by construction rather than by
     * good intentions. `buildTunnels()` checks the arch at the *shoulder* —
     * `track.halfWidth + shoulder` metres off the centre line, the furthest
     * off the line a rider can plausibly be and still be at speed — and grows
     * the section until there is at least this much room. The vault only rises
     * from the shoulder inward, so clearing it clears the whole ridable width.
     *
     * `jumpHeadroom` is used when a kicker sits inside the span (or in the
     * sixty metres before it, which lands you inside all the same);
     * `headroom` when there is none, where nothing but a flat-ground ollie is
     * available and a metre would do.
     *
     * 19 m, because 15.84 m is the highest a rider can get above the snow
     * anywhere on Classic — measured, at the 36 m/s terminal speed of the
     * `original` tuning, off the biggest kicker on the mountain, with the
     * ollie popped right at the lip. Three metres of margin on top. A run with
     * bigger kickers than Classic's should raise it; the clearance assertions
     * in `tools/check-mechanics.mjs` measure the real reach either way.
     */
    shoulder: 6,
    headroom: 6,
    jumpHeadroom: 19,

    /* --- the transition -------------------------------------------------- */
    /**
     * Metres over which light, fog and sound cross-fade at a portal, centred
     * on the mouth — half outside, half in. 30 m is about 0.8 s at full tuck,
     * which is long enough not to pop and short enough to still feel like
     * going *through* something.
     */
    blend: 30,

    /* --- what the interior looks and sounds like ------------------------- */
    /** `FogExp2` density deep inside, against the run's own daylight density. */
    fogDensity: 0.011,
    /** Sun intensity inside, as a fraction of daylight. Nearly out — it is behind rock. */
    sunScale: 0.13,
    /** Sky fill inside, as a fraction. Halved, not killed, so this reads as shade not night. */
    hemiScale: 0.42,
    /** Ambient inside, as a fraction. Above 1 on purpose: it keeps the rider legible. */
    fillScale: 1.5,
    /** Where the low-pass over the continuous voices lands when fully inside, in Hz. */
    muffleHz: 620,
    /** Wet level of the short feedback delay that stands in for the near walls. */
    echo: 0.3,
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
      /**
       * Probability a candidate is discarded — raise it for a sparser run.
       *
       * 0.4 keeps three in five, which is the density Classic has always had.
       * The number used to be 0.6 and meant the opposite of what it said (the
       * old code discarded when `rng() > 0.6`), so reading it the documented
       * way cost the run a third of its stars until this was set to match.
       */
      skipChance: 0.4,
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
      /**
       * Probability a *clear* site becomes a slalom. Read against `gapAfter`,
       * not on its own: at 0.55 against a 110 m gap the run carried a slalom
       * every couple of hundred metres, which turned a thing you were pleased
       * to come across into scenery you rode through.
       */
      chance: 0.4,
      /** Poles per slalom group: `min + rng.int(0, extra)`. */
      count: { min: 4, extra: 2 },
      /** @type {Span} z between poles in a group. */
      spacing: { min: 15, range: 5 },
      /**
       * @type {Span} How far the line weaves side to side.
       *
       * A ceiling, not a promise. `buildCollectibles` clamps it so the outer
       * pole of every gate stays a metre inside the corduroy — on a narrow run
       * the drawn weave is regularly wider than the piste.
       */
      weave: { min: 5, range: 3 },
      /** @type {Span} Half the gap between the two poles of a gate. */
      halfWidth: { min: 3.4, range: 0.8 },
      /** Gap after a group: `count * gapPerGate + gapAfter`. */
      gapPerGate: 20,
      /** @type {Span} */
      gapAfter: { min: 280, range: 180 },
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

/* ===========================================================================
 * The other two mountains
 *
 * Both are `defineRun` calls, so they say only what makes them different and
 * inherit the rest. Read them against `CLASSIC` above: anything not mentioned
 * here is deliberately the same.
 *
 * These sit below `isPlain` rather than next to `CLASSIC` on purpose.
 * `defineRun` is a hoisted function declaration and could be called from
 * anywhere, but it reaches `isPlain`, which is a `const` — calling it earlier
 * in the file is a temporal-dead-zone crash at import time, before any of this
 * has a chance to be wrong in an interesting way.
 * ======================================================================== */

/**
 * The Park — built, deliberate, and dense with things to hit.
 *
 * The design rule is *rhythm*. A park is not a mountain with more jumps on it;
 * it is a sequence, and the rider should always be able to see the next thing
 * from the last one. So the line is straightened (two waves instead of three,
 * smaller amplitudes), the fall line is flattened into one long even pitch
 * instead of Classic's two steep bells, and the swells between features are
 * halved. Everything that would make the run *surprising* is spent instead on
 * making the features readable from far enough back to set up for them.
 *
 * The four signature obstacles are spaced down the hill by `atFraction`, and
 * the fork and both tunnels are placed in the gaps between them. Those
 * placements are not free-hand: `tools/audit-runs.mjs` reports where every
 * kicker actually lands for this seed and flags any that collide with the
 * fork's divider or a tunnel mouth. Change the seed, or the kicker spacing,
 * and that audit has to be re-run.
 */
export const PARK = defineRun({
  id: 'park',
  name: 'The Park',
  blurb: 'A built jump line, rails end to end, and a fork you get to call.',
  rating: 2,
  hint: 'PLAYFUL',
  features: ['Jump line, rails and tunnels', 'A fork — pick your own way down'],
  seed: 20240613,

  /**
   * One long even pitch. A park wants the *same* speed at every take-off, so
   * the jumps can be built to one size; Classic's two steeper bells are what
   * give it its character and exactly what a park does not want.
   */
  grade: {
    base: 0.178,
    bells: [{ amp: 0.045, center: 1500, width: 460 }],
    runout: { amount: 0.135, from: 2660, to: 2980 },
  },

  /** Shaped ground between features, not rolling ground. */
  undulation: {
    taper: { amount: 0.85, from: 2560, to: 2940 },
    waves: [
      { amp: 2.0, freq: 0.006, phase: 0 },
      { amp: 1.1, freq: 0.015, phase: 1.3 },
    ],
  },

  /**
   * Straighter than Classic and one metre narrower. The narrowing is not
   * difficulty — it is so the corduroy reads as a built corridor with an edge
   * you can see, rather than an open face you happen to be crossing.
   */
  track: {
    halfWidth: 15,
    waves: [
      { amp: 22, freq: 0.0038, phase: 0 },
      { amp: 9, freq: 0.0091, phase: 2.1 },
    ],
  },

  /** Flatter across than Classic: a park floor, not a valley floor. */
  bowl: { strength: 0.07, softness: 34, easeAmount: 0.45, easeFrom: 90, easeTo: 320 },

  /**
   * The jump line. Tighter spacing and a taller, wider size band than Classic —
   * every one of these is meant to be hit, so none of them is allowed to be the
   * little one you roll over.
   *
   * All four signature shapes are on, which is what makes this the park run.
   * Their `atFraction` values are chosen to spread them down the hill *and* to
   * keep each one clear of the fork and the tunnels — see the audit note above.
   */
  kickers: {
    spacing: { min: 105, range: 70 },
    height: { min: 1.8, range: 2.0 },
    length: { min: 7.5, range: 5.0 },
    width: { min: 9.0, range: 5.5 },
    hip: { enabled: true, atFraction: 0.46, angle: 0.4, minHalfWidth: 6.5, minLength: 10 },
    stepDown: { enabled: true, atFraction: 0.30 },
    gap: { enabled: true, atFraction: 0.62 },
  },

  /** Rails everywhere — the one thing a park has that a mountain does not. */
  rails: {
    firstZ: 180,
    spacing: { min: 90, range: 60 },
    chance: 0.85,
    length: { min: 11, range: 9 },
    curveChance: 0.5,
  },

  /**
   * The fork, sited late: by two thousand metres the rider has hit every jump
   * shape the run owns and a decision is the only thing left to give them.
   */
  fork: {
    enabled: true,
    /**
     * The rejoin finishes at 2470 rather than 2530 because the run's widest
     * kicker stands at 2486. `_clearOfDivider` will not move a feature into a
     * lane narrower than the feature, and a fourteen-metre table does not fit
     * beside a ridge that is still half a metre proud — so the ridge is done
     * before the kicker starts. `tools/audit-runs.mjs` is what says whether
     * that is still true after any change to the seed or the kicker spacing.
     */
    z0: 1990, z1: 2120, z2: 2340, z3: 2470,
    /**
     * Bigger than the documented default of 3 m / 6.5 m, and both together on
     * purpose: the steepest flank is `maxHeight * PI / (2 * maxSeparation)`, so
     * scaling the pair keeps the ridge at the same 36 degrees and only changes
     * how much of it there is.
     *
     * The default is a fine *shape* and was almost invisible as a *sign*. From
     * the corduroy a hundred and fifty metres back — which is where the choice
     * actually gets made — three metres of white on a twenty-five metre field
     * of white read as a slight swelling and nothing more. This is sized to be
     * seen from the approach, which is the only place its being there matters.
     */
    maxHeight: 4.5,
    maxSeparation: 9.5,
    /** Lanes are `halfWidth + widen - maxSeparation` = 17.5 m across. */
    widen: 12,
    groomGap: 0.5,
  },

  /**
   * Two bores. The first is a mid-run surprise; the second spits the rider out
   * into the village with the finish already in sight, which is the best thing
   * a tunnel exit can be pointed at.
   */
  tunnels: {
    enabled: true,
    spans: [
      { from: 1000, to: 1150 },
      { from: 2620, to: 2770, crown: 13, ribSpacing: 6 },
    ],
  },

  /** Groomed. A park with moguls in it is a park nobody swept. */
  moguls: { enabled: false },

  /** Held well back, so the built features are the only things in the way. */
  trees: {
    seed: 77021,
    density: 0.34,
    bands: {
      encroach: { upTo: 0.005, gap: 4.5, range: 2.4 },
      near: { upTo: 0.45, gap: 8, range: 26 },
      mid: { upTo: 0.8, gap: 22, range: 150 },
      far: { from: 200, range: 230 },
    },
  },

  /**
   * Denser stars, and slaloms cut down to fit.
   *
   * A four-to-six pole group needs a hundred metres clear of every kicker,
   * rail and the fork, and this run does not have a hundred such metres
   * anywhere — asking for Classic's groups here produced exactly zero gates.
   * Three poles and a finer search stride finds the gaps between features
   * instead of failing to fit between them, which is the honest way to have
   * "a few" rather than the accidental way to have none.
   */
  collectibles: {
    seed: 4409,
    stars: { skipChance: 0.28 },
    gates: { chance: 0.5, count: { min: 3, extra: 0 }, stride: 25, gapAfter: { min: 200, range: 120 } },
  },
});

/**
 * The Backcountry — tight, natural, and technical.
 *
 * Everything the Park spends on legibility this run spends on the opposite. The
 * line wanders hard and fast (a third wave, at more than double Classic's
 * amplitude on the low frequency), the corduroy is five metres narrower than
 * Classic on each side, and the trees come in close enough that the piste edge
 * is a thing you are actively avoiding rather than a thing you notice.
 *
 * The bowl is where this run earns the banking term. Classic's `strength: 0.1`
 * against a 30 m softness is nearly flat within the track; at `0.16` against 22
 * the walls just off the corduroy have a real cross-slope, so a rider who runs
 * wide gets *turned* — pushed back down toward the line if they are on the
 * inside of the wander, and carried further out if they are not. That is a
 * genuinely different ride rather than the same physics with more trees, and it
 * only works because lateral gravity coupling exists.
 *
 * No fork and no tunnels: those are built things, and nothing out here is
 * built. What it has instead is the gap jump and a long mogul field.
 */
export const BACKCOUNTRY = defineRun({
  id: 'backcountry',
  name: 'Backcountry',
  blurb: 'Trees close in, the line narrows, and nothing out here was groomed for you.',
  rating: 3,
  hint: 'WILD',
  features: ['Tight trees and a long mogul field', 'Gap jumps and banked walls'],
  seed: 20241105,

  /** Steeper throughout, and steeper again through both pitches. */
  grade: {
    base: 0.21,
    bells: [
      { amp: 0.085, center: 950, width: 300 },
      { amp: 0.075, center: 1900, width: 340 },
    ],
    runout: { amount: 0.175, from: 2640, to: 2980 },
  },

  /** Rolling ground, barely tamed. */
  undulation: {
    taper: { amount: 0.85, from: 2560, to: 2940 },
    waves: [
      { amp: 5.2, freq: 0.0058, phase: 0.4 },
      { amp: 3.1, freq: 0.0135, phase: 1.9 },
      { amp: 1.6, freq: 0.029, phase: 0.9 },
    ],
  },

  /**
   * Narrow, and it wanders. Five metres off Classic's half-width on each side,
   * with a plan-view line that swings further and turns over faster — so the
   * corduroy is genuinely somewhere you have to keep finding.
   */
  track: {
    halfWidth: 11,
    edgeSoftness: 2.4,
    waves: [
      { amp: 42, freq: 0.0045, phase: 0.6 },
      { amp: 19, freq: 0.0110, phase: 1.4 },
      { amp: 9, freq: 0.0230, phase: 2.6 },
    ],
  },

  /** The banked walls. See the note above — this is the run's real mechanic. */
  bowl: { strength: 0.16, softness: 22, easeAmount: 0.45, easeFrom: 80, easeTo: 300 },

  /** Deeper, lumpier snow either side of a narrower line. */
  powder: {
    blendFrom: -1,
    blendTo: 7,
    lumps: [
      { amp: 1.25, freq: 0.036, seed: 71 },
      { amp: 0.45, freq: 0.085, seed: 913 },
    ],
  },

  /**
   * Natural-feeling jumps: fewer, more varied, and smaller on average than the
   * Park's, because out here a jump is terrain you happened to hit rather than
   * something built to a spec. The gap is the exception and the signature.
   */
  kickers: {
    spacing: { min: 170, range: 150 },
    height: { min: 1.4, range: 2.2 },
    length: { min: 6.5, range: 5.5 },
    width: { min: 6.5, range: 5.0 },
    /**
     * Sited below the mogul field, not in it. A hip's whole point is that the
     * approach line decides which way it throws you, and picking that line off
     * a bump field is picking it out of a washing machine — the shape stops
     * reading as a choice and starts reading as luck.
     */
    hip: { enabled: true, atFraction: 0.62, angle: 0.32, minHalfWidth: 6.5, minLength: 10 },
    stepDown: { enabled: false },
    gap: { enabled: true, atFraction: 0.72 },
  },

  /**
   * The occasional fallen log, and nothing like a park's rail line. `chance` is
   * per *step* rather than per run, so it has to be read against `spacing`:
   * at 0.12 across a 200-380 m stride this produced no rails at all on the
   * shipped seed, which is not "occasional", it is "absent".
   */
  rails: {
    chance: 0.32,
    spacing: { min: 150, range: 150 },
    offsetMargin: 4,
    length: { min: 8, range: 5 },
    curveChance: 0.2,
  },

  /**
   * A long bump field through the first pitch, where the run is already
   * steepest — which is what makes it the technical section rather than a
   * texture. `Terrain.js` refines its row spacing over this range, so the
   * length is not free; six hundred metres is deliberate and about the most
   * this should ever be.
   */
  moguls: {
    enabled: true,
    z0: 900, z1: 1010, z2: 1400, z3: 1520,
    amp: 0.75,
    spacingU: 8,
    spacingZ: 11,
    skew: 0.5,
    edgeFade: 2.5,
    jitter: 0.4,
    noiseFreq: 0.022,
    seed: 6607,
  },

  /** Built things belong on the Park. */
  fork: { enabled: false },
  tunnels: { enabled: false, spans: [] },

  /**
   * The forest, close in. `encroach` is up sixfold over Classic and its gap is
   * cut to a metre and a half outside the tree's own collision radius, so trees
   * really do stand at the edge of the corduroy. That is the whole run: the
   * penalty for a wide line is immediate and visible, and the line is narrow.
   */
  trees: {
    seed: 33107,
    density: 0.86,
    thin: { from: 30, over: 190, amount: 0.35 },
    bands: {
      encroach: { upTo: 0.12, gap: 1.5, range: 2.2 },
      near: { upTo: 0.68, gap: 3, range: 24 },
      mid: { upTo: 0.9, gap: 20, range: 150 },
      far: { from: 200, range: 230 },
    },
  },

  /**
   * Stars are worth more here for the same reason they are harder: off the line
   * on this run means in the trees. Gates are rare — `gates.maxSlope` rejects
   * most of a wandering track anyway, and forcing them would put a slalom on a
   * traverse.
   */
  collectibles: {
    seed: 9151,
    stars: { skipChance: 0.5, offTrackExtra: 6, detourChance: 0.6 },
    gates: { chance: 0.28 },
  },
});

/* ===========================================================================
 * A mountain nobody designed
 *
 * The three runs above are invented: someone chose where the pitches go and
 * how the line swings, and it shows — each one has a rhythm, because a person
 * put a rhythm in it. This one was measured instead.
 *
 * `src/world/Elevation.js` holds two tables walked down real terrain above
 * Chamonix, from public elevation tiles, by `tools/bake-run.mjs`. They supply
 * the steepness and the plan-view wander, and nothing else — thirty-metre
 * elevation data cannot describe a sixteen-metre piste, so every feature the
 * rider touches is still the same analytic height field the other runs use.
 * What the real data buys is the one thing hand-writing sine waves is worst
 * at: a fall line that does not repeat.
 *
 * The profile it produced is genuinely unlike the others. It opens at 0.31, the
 * steepest ground in the game, mellows to a long 0.11 shelf through the middle
 * where the other runs would have put their second pitch, and then throws two
 * more steep rolls in the last kilometre. No one would write that. It is what
 * the mountain does.
 * ======================================================================== */

export const MASSIF = defineRun({
  id: 'massif',
  name: 'Massif',
  blurb: 'Three real kilometres, surveyed from the Mont Blanc massif above Chamonix.',
  rating: 3,
  hint: 'REAL',
  features: ['A fall line measured, not invented', 'Steep top, long shelf, two late rolls'],
  seed: 31411,

  /**
   * The whole fall line comes from the survey.
   *
   * `base` is 0 and `bells` is empty on purpose, and that is the readable form
   * of "nothing here was chosen": `_gradeAt` adds its analytic terms to the
   * profile rather than blending with it, so leaving them at zero is what makes
   * the measured table the only thing deciding steepness. `scale: 1` is the
   * real gradient, unmodified.
   *
   * The runout stays. It is not terrain — it is the finish, and the village has
   * to be arrived at rather than crashed into.
   */
  grade: {
    base: 0,
    bells: [],
    profile: { samples: ELEVATION_GRADE, step: ELEVATION_STEP, scale: 1 },
    runout: { amount: 0.145, from: 2660, to: 2980 },
  },

  /**
   * Swells damped down, because the profile already has the mountain's own
   * rolls in it at exactly the wavelengths these waves were imitating. Left at
   * Classic's amplitudes the two beat against each other and the run develops a
   * chop that is in neither the data nor the design.
   */
  undulation: {
    taper: { amount: 0.85, from: 2560, to: 2940 },
    waves: [
      { amp: 1.8, freq: 0.0075, phase: 1.1 },
      { amp: 0.9, freq: 0.021, phase: 2.4 },
    ],
  },

  /**
   * The line is the real one, at just under half strength.
   *
   * `waves` is empty for the same reason `bells` is: the plan view is measured.
   * The scale is not — the walked line strays 146 m off its own chord, and a
   * piste that swings nearly three hundred metres across reads as a slalom
   * course rather than a descent. At 0.45 it reaches about 66 m, which is where
   * Classic's summed waves top out, so the run wanders as much as the game
   * already expects a run to wander while doing it in the mountain's shape
   * rather than a sine's.
   *
   * Wide corduroy, because the top pitch is the steepest in the game and the
   * margin for a wobble has to grow with the speed it is taken at.
   */
  track: {
    halfWidth: 18,
    edgeSoftness: 3.6,
    waves: [],
    profile: { samples: ELEVATION_WANDER, step: ELEVATION_STEP, scale: 0.45 },
  },

  /** A high alpine bowl: broad and shallow, not the Backcountry's tight walls. */
  bowl: { strength: 0.085, softness: 38, easeAmount: 0.45, easeFrom: 100, easeTo: 340 },

  /**
   * Jumps read as terrain here, not as construction: no hip, no step-down, no
   * gap. The run's signature is the ground itself, and a built lip on the 0.31
   * pitch would be the thing you remember instead of the pitch.
   */
  kickers: {
    spacing: { min: 200, range: 170 },
    height: { min: 1.3, range: 1.9 },
    length: { min: 7, range: 5.5 },
    width: { min: 8, range: 6 },
    hip: { enabled: false },
    stepDown: { enabled: false },
    gap: { enabled: false },
  },

  /** Nothing out here was built, so nothing out here is a rail. */
  rails: { chance: 0 },

  /**
   * The bump field goes on the shelf, between z = 1150 and 1750, where the
   * survey's grade sits around 0.12 for six hundred metres. That stretch is the
   * one place this run would otherwise be dull — it is the flattest ground in
   * the game — so it gets the one thing that makes flat ground technical.
   */
  moguls: {
    enabled: true,
    z0: 1150, z1: 1260, z2: 1640, z3: 1750,
    amp: 0.62,
    spacingU: 9,
    spacingZ: 12,
    skew: 0.35,
    edgeFade: 3,
    jitter: 0.35,
    noiseFreq: 0.02,
    seed: 4831,
  },

  fork: { enabled: false },
  tunnels: { enabled: false, spans: [] },

  /** High alpine: thin above, thickening as the run drops toward the trees. */
  trees: {
    seed: 5147,
    density: 0.6,
    thin: { from: 25, over: 210, amount: 0.3 },
    bands: {
      encroach: { upTo: 0.05, gap: 2.4, range: 3 },
      near: { upTo: 0.55, gap: 5, range: 30 },
      mid: { upTo: 0.88, gap: 26, range: 170 },
      far: { from: 220, range: 260 },
    },
  },

  /**
   * Stars carry this run's rhythm where features do not. Gates are frequent by
   * this game's standards and can afford to be: with `waves` empty the line
   * turns over more slowly than any other run, so `gates.maxSlope` actually
   * accepts long stretches of it.
   */
  collectibles: {
    seed: 6231,
    stars: { skipChance: 0.35, offTrackExtra: 5, detourChance: 0.5 },
    gates: { chance: 0.4 },
  },
});

/** Every run the game can offer, in the order a menu should list them. */
export const RUNS = [CLASSIC, PARK, BACKCOUNTRY, MASSIF];

/** Look a run up by `id`, falling back to Classic rather than throwing. */
export function runById(id) {
  return RUNS.find((r) => r.id === id) ?? CLASSIC;
}
