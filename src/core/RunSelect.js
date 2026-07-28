/**
 * Which mountain you are about to ride — the player's side of the choice.
 *
 * `world/Runs.js` describes the terrain: grade curves, tree density, where the
 * kickers go. This file is everything *around* that — turning a preset into a
 * card, remembering which one was picked, and carrying a drop-in across the
 * reload that switching mountains needs. Keeping the two apart means the
 * picker never has to know what a bell curve is, and the course generator
 * never has to know what a card looks like.
 *
 * A run is a *place*, not a difficulty. The two are picked separately and
 * scored separately: CRUISE down the Backcountry is a real thing somebody
 * wants, and a Park score has no business sitting in the same table as a
 * Classic one.
 */

import { RUNS as RUN_PRESETS } from '../world/Runs.js';

/**
 * Fills in whatever a preset left out.
 *
 * `world/Runs.js` exists to describe *terrain*, so a run may arrive carrying
 * nothing the picker can render. Rather than make the UI defensive in three
 * places, everything it needs is guaranteed here — a run with nothing but an
 * `id` still comes out as a card the player can choose.
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
