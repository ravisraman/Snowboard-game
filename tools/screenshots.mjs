/**
 * Screenshots the game at desktop and phone sizes.
 *
 *   npm run dev
 *   node tools/screenshots.mjs ./shots riding
 *
 * The second argument picks the moment: `riding` fast-forwards the simulation
 * 45 s down the mountain first, because software rendering runs far slower than
 * real time and simply waiting leaves the rider on the start gate.
 */

import { chromium } from 'playwright';

const OUT = process.argv[2] ?? '/tmp/shots';
const SHOT = process.argv[3] ?? 'help';
const BASE = process.env.GAME_URL ?? 'http://localhost:5173/';

const launchOptions = { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] };
if (process.env.CHROMIUM_PATH) launchOptions.executablePath = process.env.CHROMIUM_PATH;
const browser = await chromium.launch(launchOptions);

const cases = [
  { name: 'desktop', viewport: { width: 1440, height: 810 }, url: BASE },
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    url: `${BASE}?quality=mobile` },
];

for (const c of cases) {
  const ctx = await browser.newContext({
    viewport: c.viewport, hasTouch: !!c.hasTouch, isMobile: !!c.isMobile,
    deviceScaleFactor: c.isMobile ? 2 : 1,
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(c.url, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.game, null, { timeout: 90000 });

  const tap = (sel) => (c.hasTouch ? page.tap(sel) : page.click(sel));

  if (SHOT === 'help') {
    await tap('#btn-help-title');
    // Long, because CSS animations advance on rendered frames and the WebGL
    // loop starves them under software rendering: half a second of wall clock
    // can be zero frames, and the panel is caught mid-fade at opacity 0.
    await page.waitForTimeout(6000);
    await page.screenshot({ path: `${OUT}/${c.name}-help.png`, fullPage: false });
  } else {
    await tap('#btn-start');
    await page.waitForTimeout(400);
    const state = await page.evaluate((seconds) => {
      const g = window.game;
      const c2 = g.course;
      const fake = { steer: 0, tuck: false, brake: false, jumpPressed: false, restartPressed: false, helpPressed: false, endFrame() {}, clear() {} };
      const realInput = g.input;
      g.input = fake;
      const realHits = g.skiers.hits.bind(g.skiers);
      g.skiers.hits = () => null;
      for (let i = 0; i < seconds * 120; i++) {
        const rr = g.rider;
        const lookZ = rr.position.z + Math.max(14, rr.speed * 1.7);
        let d = Math.atan2(c2.centerX(lookZ) - rr.position.x, lookZ - rr.position.z) - rr.yaw;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        fake.steer = rr.grounded ? (d > 0.025 ? 1 : d < -0.025 ? -1 : 0) : 0;
        fake.tuck = fake.steer === 0;
        g.update(1 / 120);
        if (g.state !== 'riding') break;
      }
      g.input = realInput;
      g.skiers.hits = realHits;
      return { state: g.state, z: Math.round(g.rider.position.z), score: Math.round(g.score.total) };
    }, 45);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/${c.name}-riding.png` });
    console.log(c.name, JSON.stringify(state));
  }
  console.log(c.name, 'errors:', errs);
  await ctx.close();
}
await browser.close();
