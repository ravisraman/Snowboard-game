/**
 * Which mountain you are about to ride.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ STUB. The real run presets are being written as `src/world/Runs.js`, │
 * │ and this file exists so the picker, the HUD and the leaderboard      │
 * │ could be built and tested before that landed.                        │
 * │                                                                      │
 * │ To swap it for the real thing, replace the `RUN_PRESETS` array below │
 * │ with one import:                                                     │
 * │                                                                      │
 * │     import { RUNS as RUN_PRESETS } from '../world/Runs.js';          │
 * │                                                                      │
 * │ and delete the literal. Nothing else in this file changes, and       │
 * │ nothing outside it changes at all: every consumer goes through       │
 * │ `runInfo()`, and `normalise()` below fills in any field the real     │
 * │ presets do not happen to carry. The contract this was written        │
 * │ against is deliberately tiny — `id` and `name` are the only fields   │
 * │ that must already exist.                                            │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * A run is a *place*, not a difficulty. The two are picked separately and
 * scored separately: CRUISE down the Backcountry is a real thing somebody
 * wants, and a Park score has no business sitting in the same table as a
 * Classic one.
 */

const RUN_PRESETS = [
  {
    id: 'classic',
    name: 'CLASSIC',
    // The seed the mountain has always been built from. Keeping it explicit
    // here rather than leaning on `new Course()`'s default is what guarantees
    // a player who never opens the picker gets exactly the run they had.
    seed: 20240117,
    grade: 1,
    hint: 'GENTLE',
    description: 'Wide open groomers all the way to the village.',
    features: ['Big friendly kickers', 'Room to make mistakes'],
  },
  {
    id: 'park',
    name: 'PARK',
    seed: 70310,
    grade: 2,
    hint: 'PLAYFUL',
    description: 'A built line of rails, lips and a tunnel under the ridge.',
    features: ['Rails and step-downs', 'A fork — pick your side'],
  },
  {
    id: 'backcountry',
    name: 'BACKCOUNTRY',
    seed: 88421,
    grade: 3,
    hint: 'WILD',
    description: 'A narrow thread through the trees, and nothing is groomed.',
    features: ['Moguls and gap jumps', 'Banked walls, dense timber'],
  },
];

/**
 * Fills in whatever the presets left out.
 *
 * The real `Runs.js` is being written to describe *terrain*, so it may well
 * arrive with no display copy on it at all. Rather than make the picker
 * defensive in three places, everything it needs is guaranteed here — a run
 * with nothing but an `id` still renders as a card the player can choose.
 */
function normalise(preset, index) {
  const id = String(preset.id ?? `run${index}`);
  return {
    ...preset,
    id,
    name: String(preset.name ?? id).toUpperCase(),
    // `blurb` is what `Difficulty.js` calls this, so accept either spelling
    // and hand both back — whichever name the real presets use, it works.
    description: preset.description ?? preset.blurb ?? '',
    blurb: preset.blurb ?? preset.description ?? '',
    features: preset.features ?? [],
    // 1–3, gentlest first. Drives the dots on the card, so a child who cannot
    // yet read the copy can still see which run is the easy one.
    grade: preset.grade ?? index + 1,
    hint: preset.hint ?? ['GENTLE', 'PLAYFUL', 'WILD'][Math.min(2, index)],
    seed: preset.seed,
  };
}

export const RUNS = RUN_PRESETS.map(normalise);
export const RUN_IDS = RUNS.map((r) => r.id);

/** The run every existing score, save and screenshot already belongs to. */
export const DEFAULT_RUN = RUNS[0].id;

const KEY = 'alpine-carve.run';

/** Never throws and never returns an id that is not in the list. */
export function runInfo(id) {
  return RUNS.find((r) => r.id === id) ?? RUNS[0];
}

export function loadRun() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && RUN_IDS.includes(saved)) return saved;
  } catch {
    /* private browsing, embedded frames */
  }
  return DEFAULT_RUN;
}

export function saveRun(id) {
  try {
    localStorage.setItem(KEY, runInfo(id).id);
  } catch {
    /* nothing worth interrupting a run over */
  }
}

/* ------------------------------------------------------------------
 * Changing mountain
 *
 * The world is assembled once, at startup, from the saved run. Swapping it
 * live would mean tearing down a few hundred thousand triangles of terrain and
 * forest and disposing the materials underneath them — several of which are
 * module-level singletons shared with the rider and the resort, so disposing
 * them is a bug and *not* disposing them is a leak on every switch.
 *
 * Reloading the page does the whole job exactly, for free, and lands on the
 * "Shaping the mountain…" screen the player already expects to see before a
 * run. The one thing it must not do is lose the drop-in they already pressed:
 * coming back up on the title screen reads as the button not working. So the
 * intent to ride is parked in `sessionStorage` — per tab, and gone the moment
 * it is read, so a later reload can never start a run nobody asked for.
 * ---------------------------------------------------------------- */

const DROP_IN_KEY = 'alpine-carve.dropIn';

export function armDropIn() {
  try {
    sessionStorage.setItem(DROP_IN_KEY, '1');
  } catch {
    /* the worst case is one extra press of DROP IN */
  }
}

export function takeDropIn() {
  try {
    const armed = sessionStorage.getItem(DROP_IN_KEY) === '1';
    sessionStorage.removeItem(DROP_IN_KEY);
    return armed;
  } catch {
    return false;
  }
}
