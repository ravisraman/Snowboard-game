/**
 * Where everything actually lands, on every run.
 *
 * The presets in `src/world/Runs.js` place their signature features by
 * *fraction of the run* (`kickers.hip.atFraction` and friends) and their fork
 * and tunnels by absolute z. Those two coordinate systems know nothing about
 * each other, and the ordinary kicker walk knows about neither — so nothing in
 * the config stops a gap jump being promoted from a kicker that happens to sit
 * on the fork's divider, or a rail from being placed in the middle of a bore's
 * mouth. The numbers are all reasonable individually; it is the *combination*
 * that has to be checked, and it changes whenever a seed or a spacing does.
 *
 * This prints the layout of each run down the hill and flags the overlaps that
 * matter. It is a tuning instrument, not a test: it exits non-zero only on a
 * real collision, so it can be run in a loop while adjusting numbers.
 *
 *   GAME_URL=http://localhost:5190/ node tools/audit-runs.mjs
 *   GAME_URL=... node tools/audit-runs.mjs --verbose    # every feature, not just clashes
 *
 * Why it drives a browser: `Course` is the only thing that knows where a
 * feature ends up, and it is built to run in one. Importing it in node means
 * reimplementing the rng walk, which would then be the thing being audited.
 */

import { chromium } from 'playwright';

const URL = process.env.GAME_URL ?? 'http://localhost:5173/';
const VERBOSE = process.argv.includes('--verbose');

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('PAGEERROR:', e.message));
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.game, null, { timeout: 90_000 });

const runs = await page.evaluate(async () => {
  const { RUNS } = await import('/src/world/Runs.js');
  const { Course } = await import('/src/world/Course.js');

  return RUNS.map((cfg) => {
    const course = new Course(cfg.seed, cfg);
    const off = (k) => +(k.x - course.centerX(k.z)).toFixed(1);

    /* Which of the four shapes a kicker ended up as. The flags are set by the
     * promotion pass, so this is what was *built*, not what was configured. */
    const kind = (k) =>
      k.gap ? 'gap' : k.stepDown ? 'step-down' : k.hip ? 'hip' : 'kicker';

    const kickers = course.kickers.map((k) => ({
      z: Math.round(k.z),
      kind: kind(k),
      off: off(k),
      halfWidth: +k.halfWidth.toFixed(1),
      /* How open the fork is *here*. At the ramp-in and ramp-out this is
       * nearly zero and there is no ridge to speak of, so it has to be part of
       * the test — a kicker at z0 + 2 is not on a divider, it is on flat snow
       * that will be a divider a hundred metres further down. */
      forkAmount: +course.forkAmount(k.z).toFixed(3),
      /* A decked shape occupies ground well behind and ahead of its lip. */
      from: Math.round(k.z - (k.deck ? k.deck.approach + k.length : k.length)),
      to: Math.round(k.z + (k.deck ? k.deck.segments.at(-1).end : 0)),
    }));

    const rails = course.rails.map((r) => ({
      z: Math.round(r.z),
      off: off(r),
      forkAmount: +course.forkAmount(r.z).toFixed(3),
      from: Math.round(r.z),
      to: Math.round(r.z + r.length),
    }));

    const fork = cfg.fork.enabled ? { ...cfg.fork } : null;
    const moguls = cfg.moguls.enabled ? { ...cfg.moguls } : null;
    const tunnels = cfg.tunnels.enabled
      ? (course.tunnels?.list ?? []).map((t) => ({
          from: Math.round(t.from ?? t.z0),
          to: Math.round(t.to ?? t.z1),
          halfWidth: +(t.halfWidth ?? 0).toFixed(1),
        }))
      : [];

    return {
      id: cfg.id,
      name: cfg.name,
      finishZ: cfg.finishZ,
      halfWidth: cfg.track.halfWidth,
      kickers,
      rails,
      fork,
      moguls,
      tunnels,
      widestHalfWidth: +course.maxTrackHalfWidth().toFixed(1),
    };
  });
});

await browser.close();

/* ------------------------------------------------------------------
 * The clashes worth failing on
 *
 * Only two are real. A feature standing on the divider is nonsense — the
 * ridge runs up through the middle of it. And a *decked* shape (a step-down or
 * a gap) anywhere inside the fork is nonsense too, even out in a lane: the
 * deck is a flat plateau in the kicker field and the divider is a ridge in the
 * terrain field, and the two are summed with no idea about each other.
 *
 * Tunnels are deliberately *not* a clash. `buildTunnels` scans its own span
 * for kickers and raises the arch until it clears them, which is the whole
 * reason that code exists — a jump inside a bore is a feature.
 * ---------------------------------------------------------------- */
const problems = [];

/**
 * The ridge is only a ridge where it has risen. Below this much crest height it
 * is under the depth of a board's edge and nothing is standing on anything —
 * which is the state at both ends of the fork, where the ramps live.
 */
const RIDGE_MATTERS_M = 0.35;

for (const run of runs) {
  const lines = [];
  const overlaps = (a0, a1, b0, b1) => a0 <= b1 && b0 <= a1;

  for (const k of run.kickers) {
    const notes = [];
    if (run.fork && overlaps(k.from, k.to, run.fork.z0, run.fork.z3)) {
      const crest = k.forkAmount * run.fork.maxHeight;
      const separation = k.forkAmount * run.fork.maxSeparation;
      const onDivider = crest >= RIDGE_MATTERS_M && Math.abs(k.off) - k.halfWidth < separation;
      if (k.kind === 'step-down' || k.kind === 'gap') {
        notes.push(`DECKED SHAPE INSIDE THE FORK (${run.fork.z0}-${run.fork.z3})`);
      } else if (onDivider) {
        notes.push(
          `ON THE DIVIDER (|off| ${Math.abs(k.off)} - hw ${k.halfWidth} < ${separation.toFixed(1)}, ` +
          `crest ${crest.toFixed(2)} m)`
        );
      }
    }
    if (run.moguls && k.kind !== 'kicker' && overlaps(k.from, k.to, run.moguls.z0, run.moguls.z3)) {
      notes.push(`signature shape in the mogul field (${run.moguls.z0}-${run.moguls.z3})`);
    }
    if (notes.length) problems.push(`${run.id}: ${k.kind} at z=${k.z} — ${notes.join('; ')}`);
    if (VERBOSE || notes.length || k.kind !== 'kicker') {
      lines.push(
        `  z=${String(k.z).padStart(4)}  ${k.kind.padEnd(9)} off=${String(k.off).padStart(6)} ` +
        `hw=${String(k.halfWidth).padStart(4)}  [${k.from}..${k.to}]` +
        (notes.length ? `  <-- ${notes.join('; ')}` : '')
      );
    }
  }

  for (const r of run.rails) {
    if (run.fork && overlaps(r.from, r.to, run.fork.z0, run.fork.z3) &&
        r.forkAmount * run.fork.maxHeight >= RIDGE_MATTERS_M &&
        Math.abs(r.off) < r.forkAmount * run.fork.maxSeparation) {
      problems.push(`${run.id}: rail at z=${r.z} off=${r.off} sits on the divider`);
      lines.push(`  z=${String(r.z).padStart(4)}  rail      off=${String(r.off).padStart(6)}  <-- ON THE DIVIDER`);
    }
  }

  console.log(`\n${run.name}  (${run.id})`);
  console.log(`  track half-width ${run.halfWidth} m, widest ${run.widestHalfWidth} m` +
              `   ${run.kickers.length} kickers, ${run.rails.length} rails`);
  if (run.fork) console.log(`  fork    ${run.fork.z0}-${run.fork.z3}  (held ${run.fork.z1}-${run.fork.z2}), lanes ` +
                            `${(run.halfWidth + run.fork.widen - run.fork.maxSeparation).toFixed(1)} m across`);
  if (run.moguls) console.log(`  moguls  ${run.moguls.z0}-${run.moguls.z3}`);
  for (const t of run.tunnels) console.log(`  tunnel  ${t.from}-${t.to}  (bore half-width ${t.halfWidth} m)`);
  for (const l of lines) console.log(l);
}

console.log();
if (problems.length) {
  for (const p of problems) console.log(`CLASH  ${p}`);
  console.log(`\n${problems.length} clash(es) — adjust atFraction, the fork range, or the seed.`);
  process.exit(1);
}
console.log('No clashes: every signature shape is clear of the fork and the divider.');
