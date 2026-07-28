/**
 * A photograph of every signature feature, on every run.
 *
 *   GAME_URL=http://localhost:5190/ node tools/run-shots.mjs /tmp/runshots
 *
 * `screenshots.mjs` takes the two pictures the README needs. This takes the
 * ones *review* needs: each new obstacle, from the seat of a rider actually
 * approaching it at speed. Nothing here is staged — the rider is driven down
 * the real course by the same follow-the-line autopilot the mechanics harness
 * uses, and the shutter opens when they reach the z the feature is at. A pose
 * assembled by hand can be made to look like anything; a rider who got there
 * by riding cannot.
 *
 * `lane` biases the line across the piste, which is the only way to photograph
 * both sides of a fork: -1 and +1 through the same z are the two choices the
 * player is being offered.
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? '/tmp/runshots';
const BASE = process.env.GAME_URL ?? 'http://localhost:5173/';

mkdirSync(OUT, { recursive: true });

/** @type {{ run: string, name: string, z: number, lane?: number }[]} */
const SHOTS = [
  { run: 'classic', name: 'hip', z: 1360 },

  { run: 'park', name: 'stepdown-approach', z: 905 },
  { run: 'park', name: 'tunnel-mouth', z: 985 },
  { run: 'park', name: 'tunnel-inside', z: 1080 },
  { run: 'park', name: 'gap-approach', z: 1735 },
  // The shot the fork lives or dies by: taken from *before* the ridge starts,
  // on the corduroy, looking at the split the player is about to be asked to
  // choose. From inside a lane the feature is already decided and the picture
  // proves nothing; from on top of the crest the camera looks along the ridge
  // and cannot see it at all.
  { run: 'park', name: 'fork-approach', z: 1975 },
  { run: 'park', name: 'fork-split', z: 2085 },
  { run: 'park', name: 'fork-left-lane', z: 2230, lane: -1 },
  { run: 'park', name: 'fork-right-lane', z: 2230, lane: 1 },
  { run: 'park', name: 'tunnel-two', z: 2660 },

  { run: 'backcountry', name: 'tight-trees', z: 620 },
  { run: 'backcountry', name: 'moguls-entry', z: 960 },
  { run: 'backcountry', name: 'moguls-mid', z: 1220 },
  { run: 'backcountry', name: 'gap-approach', z: 2130 },
];

const launchOptions = { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] };
if (process.env.CHROMIUM_PATH) launchOptions.executablePath = process.env.CHROMIUM_PATH;

/**
 * A run filter, because a whole mountain is built per shot — terrain, forest
 * meshes and all — and thirteen of them in one browser is an out-of-memory
 * kill, not a slow script. One browser per shot, and one run per invocation:
 *
 *   node tools/run-shots.mjs /tmp/runshots park
 */
const ONLY = process.argv[3];
const ONLY_NAME = process.argv[4];
const wanted = SHOTS.filter((s) =>
  (!ONLY || s.run === ONLY) && (!ONLY_NAME || s.name.includes(ONLY_NAME)));

for (const shot of wanted) {
  const browser = await chromium.launch(launchOptions);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  // The run is chosen before the world is built, because building it is the
  // only time the choice is read — see the note in `RunSelect.js`.
  await page.addInitScript((id) => {
    try { localStorage.setItem('alpine-carve.run', id); } catch { /* ignore */ }
  }, shot.run);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.game, null, { timeout: 90_000 });
  await page.click('#btn-start');
  await page.waitForTimeout(400);

  const state = await page.evaluate(({ z: targetZ, lane }) => {
    const g = window.game;
    const c = g.course;
    const fake = {
      steer: 0, tuck: false, brake: false, press: false, grabType: null,
      jumpPressed: false, restartPressed: false, helpPressed: false,
      endFrame() {}, clear() {},
    };
    const realInput = g.input;
    g.input = fake;
    // Skiers are people, and a person wandering into frame is not the subject.
    const realHits = g.skiers.hits.bind(g.skiers);
    g.skiers.hits = () => null;

    for (let i = 0; i < 120 * 400; i++) {
      const r = g.rider;
      if (r.position.z >= targetZ) break;

      const lookZ = r.position.z + Math.max(14, r.speed * 1.7);
      const tan = c.trackTangent(lookZ);
      // Hold a lane where one is asked for, widening with the fork so the line
      // stays on corduroy rather than drifting into the powder beside it.
      const u = lane ? lane * (c.trackHalfWidthAt(lookZ) * 0.55) : 0;
      const aimX = c.centerX(lookZ) + u * tan.z;
      let d = Math.atan2(aimX - r.position.x, lookZ - r.position.z) - r.yaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;

      fake.steer = r.grounded ? (d > 0.02 ? 1 : d < -0.02 ? -1 : 0) : 0;
      fake.tuck = r.grounded && fake.steer === 0;
      g.update(1 / 120);
      if (g.state !== 'riding') break;
    }

    /* Freeze here.
     *
     * The frame loop in `main.js` calls `game.update(dt)` and then renders, so
     * stubbing update leaves the real render path — post-processing and all —
     * drawing a scene that no longer moves. Handing control back to the real
     * input instead means the rider carries on unsteered for the whole of the
     * settle wait below, drifts off the line and ends the run: the first pass
     * of this tool photographed the title screen from the far side of a crash.
     *
     * The page is thrown away after the shutter, so mutating the game like this
     * costs nothing. */
    g.update = () => {};
    g.skiers.hits = realHits;
    void realInput;
    return {
      state: g.state,
      z: Math.round(g.rider.position.z),
      u: +c.trackOffset(g.rider.position.x, g.rider.position.z).toFixed(1),
      kmh: Math.round(g.rider.speed * 3.6),
    };
  }, shot);

  // Let the renderer actually draw the frame. Under software rendering a
  // wall-clock wait can be very few frames, so this is generous on purpose.
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/${shot.run}-${shot.name}.png` });
  console.log(
    `${shot.run}-${shot.name}`.padEnd(30),
    `z=${state.z} u=${state.u} ${state.kmh} km/h ${state.state}`,
    errs.length ? `ERRORS: ${errs.join(' | ')}` : ''
  );
  await ctx.close();
  await browser.close();
}

console.log(`\n${wanted.length} shots in ${OUT}`);
