import { RIDER_TUNING } from '../entities/Rider.js';

/**
 * Two ways to ride the same mountain.
 *
 * The ride model was tuned for someone who already knows what a carve is: it
 * pegs at 125 km/h within a few seconds, a spin has to be *asked for* by
 * centring the stick after take-off, and landing more than 40° off square scrubs
 * you. All of that is deliberate and none of it is any good for a seven-year-old
 * who just wants to point down the hill and go off a jump.
 *
 * Cruise is the default, because the first thirty seconds decide whether anyone
 * plays a second run. Original is the tuning everything above was designed
 * around, one click away for whoever wants it back.
 *
 * These are *overrides on the same tuning table*, not a fork of the physics.
 * Every number here already existed; the difficulty picks values for it. That
 * matters — a second physics path would drift out of step with the first within
 * a week.
 */

const PRESETS = {
  cruise: {
    label: 'CRUISE',
    blurb: 'Slower, floatier, forgiving. Start here.',
    tuning: {
      // --- Speed -------------------------------------------------------
      // Terminal speed on the pitch is set by gravity against quadratic drag.
      // More than doubling the drag brings the top of the run down from about
      // 125 km/h to about 85, which is still fast enough to feel like a
      // mountain and slow enough to read what is in front of you.
      maxSpeed: 24,
      dragBase: 0.0052,
      tuckThrust: 1.0,

      // --- Staying on the piste ---------------------------------------
      // A tighter carve and more grip in the powder: both are about being able
      // to do something once you have seen the trouble.
      maxCurvature: 1 / 10.5,
      powderGrip: 0.78,
      frictionPowder: 3.8,
      leanSpeedFloor: 5,

      // --- Air ---------------------------------------------------------
      // Lower gravity and a bigger pop. The point is *hang time*: a trick you
      // have a second and a half to do is a different proposition from one you
      // have three quarters of a second to do.
      gravity: 16.5,
      ollie: 7.2,
      spinRate: 4.6,

      // --- Landing -----------------------------------------------------
      // Nearly anything rides away. Washing out is still possible, but it takes
      // landing almost sideways rather than merely crooked.
      landCleanTol: 1.05,
      landSketchyTol: 1.9,
      landSketchyScrub: 0.85,

      // A spin no longer has to be armed by centring the stick after take-off.
      // That rule stops an adult being flung into an unasked-for 360 by a held
      // carve; to a child it just reads as "spinning does not work".
      autoArmSpin: true,

      // Bumps cost less of your speed.
      stumbleScrub: 0.62,
    },
    // How much of a tree's collider actually bites, and how square you have to
    // hit one for it to end the run rather than shove you aside.
    treeRadiusScale: 0.66,
    treeGlanceFraction: 0.38,
  },

  original: {
    label: 'ORIGINAL',
    blurb: 'The tuning everything was designed around.',
    tuning: {
      maxSpeed: 36,
      dragBase: 0.0022,
      tuckThrust: 1.6,
      maxCurvature: 1 / 13,
      powderGrip: 0.55,
      frictionPowder: 5.5,
      leanSpeedFloor: 7,
      gravity: 20.5,
      ollie: 5.6,
      spinRate: 5.2,
      landCleanTol: 0.7,
      landSketchyTol: 1.25,
      landSketchyScrub: 0.72,
      autoArmSpin: false,
      stumbleScrub: 0.45,
    },
    treeRadiusScale: 1,
    treeGlanceFraction: 0.55,
  },
};

const KEY = 'alpine-carve.difficulty';

export const DIFFICULTY_NAMES = Object.keys(PRESETS);

/** The currently applied preset, including the parts the rider does not own. */
export let difficulty = PRESETS.cruise;

export function loadDifficulty() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && PRESETS[saved]) return saved;
  } catch {
    /* private browsing, embedded frames */
  }
  return 'cruise';
}

/**
 * Writes a preset into the shared tuning table.
 *
 * The rider reads `TUNING` every frame rather than copying it at construction,
 * so this takes effect immediately — no rebuild, no restart, and it can be
 * switched mid-run without anything getting out of step.
 */
export function applyDifficulty(name) {
  const preset = PRESETS[name] ?? PRESETS.cruise;
  Object.assign(RIDER_TUNING, preset.tuning);
  difficulty = preset;
  try {
    localStorage.setItem(KEY, name === 'original' ? 'original' : 'cruise');
  } catch {
    /* nothing worth interrupting a run over */
  }
  return preset;
}

export function presetInfo(name) {
  return PRESETS[name] ?? PRESETS.cruise;
}
