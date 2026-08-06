/**
 * Three things to go and do on each mountain.
 *
 * "Get to the bottom" was the only goal the game ever stated, and it is a goal
 * you stop caring about the second time you achieve it. A leaderboard is not a
 * substitute: a number that has to beat another number is a goal for the kind
 * of player who already likes the game, and it says nothing at all about *what
 * to try*. A challenge does — "land a 540" is a sentence a seven-year-old can
 * act on, and "clear the gap without touching the knuckle" is one an adult will
 * spend four runs on.
 *
 * ---------------------------------------------------------------------------
 * How they are written
 * ---------------------------------------------------------------------------
 * A challenge is a `test(stats)` over the run's totals plus a `label`. It never
 * sees the world, the rider or the score object — only a flat bag of numbers
 * that `Game` accumulates and hands over at the end. That keeps them cheap
 * (nothing runs per frame), impossible to break by riding oddly, and trivial to
 * add to: a new challenge is a new line, not a new hook in the game loop.
 *
 * They are checked at the *end* of a run, whether it finished or ended in the
 * snow — going down on the last kicker should not cost you the three hundred
 * stars you collected on the way, and a challenge you can only complete on a
 * clean run is a challenge most seven-year-olds will never see completed.
 */

const KEY = 'alpine-carve.challenges';

/**
 * @typedef {object} RunStats
 * @property {number} stars      collected this run
 * @property {number} bestSpin   biggest landed rotation, in degrees
 * @property {number} tricks     clean landings
 * @property {number} grinds     rails ridden and popped off cleanly
 * @property {number} longestAir seconds
 * @property {number} topSpeed   m/s
 * @property {number} score      final total
 * @property {number} wipeouts   used
 * @property {number} gates      slalom poles passed
 * @property {boolean} finished  reached the village
 * @property {boolean} boosted   spent boost at least once
 */

/**
 * Per run. Three each, deliberately ordered easy → hard, because a list whose
 * first item is unreachable reads as "this is not for you".
 */
const BY_RUN = {
  classic: [
    { id: 'classic-stars', label: 'Collect 25 stars', test: (s) => s.stars >= 25 },
    { id: 'classic-finish', label: 'Reach the village without a wipeout', test: (s) => s.finished && s.wipeouts === 0 },
    { id: 'classic-540', label: 'Land a 540', test: (s) => s.bestSpin >= 540 },
  ],
  park: [
    { id: 'park-grind', label: 'Grind three rails in one run', test: (s) => s.grinds >= 3 },
    { id: 'park-air', label: 'Stay in the air for 2 seconds', test: (s) => s.longestAir >= 2 },
    { id: 'park-score', label: 'Score 25,000 on the Park', test: (s) => s.score >= 25000 },
  ],
  backcountry: [
    { id: 'back-finish', label: 'Reach the village at all', test: (s) => s.finished },
    { id: 'back-boost', label: 'Burn a full boost through the trees', test: (s) => s.boosted && s.finished },
    { id: 'back-clean', label: 'Land ten tricks without running out of chances', test: (s) => s.tricks >= 10 && s.wipeouts < 3 },
  ],
};

/** Never throws, and never returns something a UI has to be defensive about. */
export function challengesFor(runId) {
  return BY_RUN[runId] ?? BY_RUN.classic;
}

/* ------------------------------------------------------------------
 * Which ones are done
 *
 * Stored as a flat array of ids rather than per-run objects: a challenge id
 * already carries its run, and a flat list survives a run being renamed,
 * reordered or removed without needing a migration.
 * ---------------------------------------------------------------- */

export function loadDone() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveDone(set) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...set]));
  } catch {
    /* private browsing — the run still counted, it just will not be remembered */
  }
}

/**
 * Scores a finished run against its challenges.
 *
 * Returns every challenge with its state, plus which ones were completed *for
 * the first time just now* — that last part is what the results screen
 * celebrates, and it has to be computed before the store is updated or every
 * challenge looks freshly earned on every subsequent run.
 */
export function settle(runId, stats) {
  const done = loadDone();
  const list = challengesFor(runId);

  const results = list.map((c) => {
    const passed = !!c.test(stats);
    return { id: c.id, label: c.label, passed, wasDone: done.has(c.id) };
  });

  const fresh = results.filter((r) => r.passed && !r.wasDone);
  if (fresh.length) {
    for (const r of fresh) done.add(r.id);
    saveDone(done);
  }

  return { results, fresh, done: new Set(done) };
}

/** How many of a run's challenges are already in the bag. For the run card. */
export function progressFor(runId, done = loadDone()) {
  const list = challengesFor(runId);
  return { done: list.filter((c) => done.has(c.id)).length, total: list.length };
}
