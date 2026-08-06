/**
 * Photograph the backdrop, and only the backdrop.
 *
 * `run-shots.mjs` frames the *run* — the rider fills the middle of every frame
 * and the panorama is a strip along the top. That is the right picture for
 * judging a kicker and the wrong one for judging a sky, so this tool rides
 * nowhere: it freezes at the gate and swings the camera round the horizon
 * instead, which costs one browser and one world build for the whole set.
 *
 *   node tools/sky-shots.mjs /tmp/skyshots
 *
 * The headings are chosen against the sun, because almost everything that makes
 * an atmosphere look real is a function of the angle to it: the warm wash and
 * the glow on the sun's side, the deeper blue opposite, and the band across the
 * top that is neither. A backdrop that only ever gets looked at down-slope can
 * hide a lot.
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.GAME_URL ?? 'http://localhost:5173/';
const OUT = process.argv[2] ?? '/tmp/skyshots';
const launchOptions = { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] };
if (process.env.CHROMIUM_PATH) launchOptions.executablePath = process.env.CHROMIUM_PATH;

/**
 * `bearing` is radians about Y from straight down the fall line; `pitch` is
 * radians above the horizon. The sun sits at (-0.66, 0.72, 0.28) normalised,
 * which is up and to the rider's left and slightly behind — so bearing -1.2 is
 * roughly into it and +1.9 is roughly away from it.
 */
const VIEWS = [
  { name: 'downhill', bearing: 0, pitch: 0.06 },
  { name: 'into-sun', bearing: -1.2, pitch: 0.10 },
  { name: 'away-from-sun', bearing: 1.9, pitch: 0.06 },
  { name: 'skyward', bearing: -0.6, pitch: 0.42 },
  { name: 'horizon-wide', bearing: 2.9, pitch: 0.02 },
];

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch(launchOptions);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.game, null, { timeout: 90_000 });
await page.click('#btn-start');
// Wait for the state, not for a duration. A fixed pause was enough until the
// picker grew a fourth card and stopped being enough — and the failure is
// silent: the tool photographs the title screen and says nothing, which is
// exactly the kind of wrong picture that gets believed.
await page.waitForFunction(() => window.game?.state === 'riding', null, { timeout: 30_000 });

// Freeze once, then only the camera moves. See the note in `run-shots.mjs` for
// why this is a stubbed `update` rather than handing input back.
const started = await page.evaluate(() => {
  const g = window.game;
  for (let i = 0; i < 120 * 6; i++) g.update(1 / 120);
  g.update = () => {};
  // The HUD is not the subject and its white numerals sit exactly where the
  // sky's gradient is most worth looking at.
  document.querySelector('#hud')?.style.setProperty('display', 'none');
  // And the title overlay, which is on its way out under a CSS transition when
  // this runs. Waiting for the transition instead would work and would also be
  // a thing to get wrong later; the overlay is not the subject, so it goes.
  document.querySelector('#overlay')?.style.setProperty('display', 'none');
  return { state: g.state, z: Math.round(g.rider.position.z) };
});
if (started.state !== 'riding') throw new Error(`not riding after the settle: ${started.state}`);
console.log(`riding at z=${started.z}\n`);

for (const view of VIEWS) {
  await page.evaluate(({ bearing, pitch }) => {
    const g = window.game;
    const r = g.rider;
    const a = r.yaw + bearing;
    g.camera.position.set(r.position.x, r.position.y + 2.4, r.position.z);
    g.camera.lookAt(
      r.position.x + Math.sin(a) * 100,
      r.position.y + 2.4 + Math.tan(pitch) * 100,
      r.position.z + Math.cos(a) * 100,
    );
    g.camera.updateMatrixWorld();
  }, view);
  // Two frames: the composer's passes read the previous frame's targets, so the
  // first render after a camera jump can still carry the old view's history.
  await page.waitForTimeout(120);
  await page.screenshot({ path: `${OUT}/${view.name}.png` });
  console.log(view.name.padEnd(16), `bearing ${view.bearing}, pitch ${view.pitch}`);
}

if (errs.length) console.log('\npage errors:', errs.join(' | '));
console.log(`\n${VIEWS.length} shots in ${OUT}`);
await browser.close();
