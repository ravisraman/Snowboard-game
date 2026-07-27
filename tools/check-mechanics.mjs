/**
 * Headless smoke test for the ride model.
 *
 * Boots the game in Chromium, takes over the frame loop so simulated time is
 * independent of render speed, and asserts the handful of properties that make
 * the game playable: a carve turns at a sane radius, powder actually bogs you
 * down without ever trapping you, every kicker on the course launches, and the
 * run is completable.
 *
 *   npm run dev          # in another shell
 *   npm run check
 *
 * Set CHROMIUM_PATH if Playwright's bundled browser isn't installed.
 */

import { chromium } from 'playwright';

const URL = process.env.GAME_URL ?? 'http://localhost:5173/';
const launchOptions = { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] };
if (process.env.CHROMIUM_PATH) launchOptions.executablePath = process.env.CHROMIUM_PATH;

const browser = await chromium.launch(launchOptions);
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });

const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.game, null, { timeout: 90000 });

const results = await page.evaluate(() => {
  const g = window.game;
  const c = g.course;
  const r = g.rider;
  const dt = 1 / 120;
  const NONE = { steer: 0, tuck: false, brake: false, jumpPressed: false };
  const step = (n, input) => { for (let i = 0; i < n; i++) r.update(dt, input); };
  const out = {};

  /* A sustained carve should hold a believable radius. */
  {
    r.reset();
    r.position.set(c.centerX(600), 0, 600);
    r.yaw = 0; r.speed = 22; r.settle();
    step(120, NONE);
    const yaw0 = r.yaw;
    step(240, { ...NONE, steer: 1 });
    const turned = r.yaw - yaw0;
    out.carve = {
      edgeDeg: +((r.lean * 180) / Math.PI).toFixed(1),
      degPerSec: +((turned * 180) / Math.PI / 2).toFixed(1),
      radiusM: +(r.speed / (turned / 2)).toFixed(1),
    };
  }

  /* Powder must cost far more speed than the groomer. */
  {
    const z = 700;
    const tan = c.trackTangent(z);
    const u = 30;
    r.reset();
    r.position.set(c.centerX(z) + u * tan.z, 0, z - u * tan.x);
    r.yaw = c.trackHeading(z); r.speed = 25; r.settle();
    step(180, NONE);
    const offPiste = r.speed;

    r.reset();
    r.position.set(c.centerX(z), 0, z);
    r.yaw = c.trackHeading(z); r.speed = 25; r.settle();
    step(180, NONE);
    out.powder = {
      kmhAfterPowder: +(offPiste * 3.6).toFixed(0),
      kmhAfterPiste: +(r.speed * 3.6).toFixed(0),
    };
  }

  /* You must never be able to come to a permanent halt. */
  {
    const spots = [
      ['powder, mid-slope', 700, 30],
      ['powder, steep pitch', 900, 34],
      ['powder, village runout', 2800, 26],
      ['piste, village runout', 2820, 0],
    ];
    const stuck = [];
    for (const [label, z, u] of spots) {
      const tan = c.trackTangent(z);
      r.reset();
      r.position.set(c.centerX(z) + u * tan.z, 0, z - u * tan.x);
      r.yaw = c.trackHeading(z);
      r.speed = 0;
      r.settle();
      step(600, NONE);                       // 5 s from a dead stop, no input
      stuck.push({ where: label, kmhAfter5s: +(r.speed * 3.6).toFixed(1) });
    }

    // And from a standstill pointed straight back up the hill, which the
    // carve alone cannot recover from because carving needs speed.
    r.reset();
    r.position.set(c.centerX(700), 0, 700);
    r.yaw = Math.PI;
    r.speed = 0;
    r.settle();
    let turned = 0;
    for (let i = 0; i < 480; i++) {
      r.update(dt, { ...NONE, steer: 1 });   // 4 s of holding one way
      turned = Math.abs(r.yaw - Math.PI);
    }
    out.unstick = {
      spots: stuck,
      slowestKmh: Math.min(...stuck.map((s) => s.kmhAfter5s)),
      uphillPivotDeg: +((turned * 180) / Math.PI).toFixed(0),
    };
  }

  /* The skate shove has to work when you are too slow to ollie. */
  {
    r.reset();
    r.position.set(c.centerX(700), 0, 700);
    r.yaw = c.trackHeading(700);
    r.speed = 0;
    r.settle();
    r.update(dt, { ...NONE, jumpPressed: true });
    out.skate = { kmhFromStandstill: +(r.speed * 3.6).toFixed(1), stayedGrounded: r.grounded };
  }

  /* Every kicker on the course has to actually send you. */
  {
    const airs = [];
    for (const k of c.kickers) {
      r.reset();
      r.position.set(k.x - k.dirX * 22, 0, k.z - k.dirZ * 22);
      r.yaw = Math.atan2(k.dirX, k.dirZ);
      r.speed = 24; r.settle();
      let air = 0, sawAir = false;
      for (let i = 0; i < 700; i++) {
        r.update(dt, NONE);
        if (!r.grounded) { sawAir = true; air = Math.max(air, r.airTime); }
        if (sawAir && r.grounded && air > 0.05) break;
      }
      airs.push(+air.toFixed(2));
    }
    out.kickers = { count: airs.length, minAir: Math.min(...airs), maxAir: Math.max(...airs) };
  }

  /* And the whole run has to be completable without touching anything. */
  {
    for (const s of g.skiers.skiers) s.mesh.visible = false;
    const realHits = g.skiers.hits.bind(g.skiers);
    g.skiers.hits = () => null;

    const fake = { steer: 0, tuck: false, brake: false, jumpPressed: false, restartPressed: false, endFrame() {}, clear() {} };
    const realInput = g.input;
    g.input = fake;
    g.start();

    let airs = 0, wasAir = false, top = 0;
    for (let i = 0; i < 120 * 300; i++) {
      const rr = g.rider;
      const lookZ = rr.position.z + Math.max(14, rr.speed * 1.7);
      let d = Math.atan2(c.centerX(lookZ) - rr.position.x, lookZ - rr.position.z) - rr.yaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      fake.steer = d > 0.025 ? 1 : d < -0.025 ? -1 : 0;
      fake.tuck = fake.steer === 0;
      g.update(1 / 120);
      if (g.state === 'riding') {
        top = Math.max(top, rr.speed);
        if (!rr.grounded && !wasAir) airs++;
        wasAir = !rr.grounded;
      }
      if (g.state !== 'riding') break;
    }
    out.run = {
      finished: g.state === 'finished',
      seconds: +(g.finishElapsed ?? g.elapsed).toFixed(1),
      topSpeedKmh: +(top * 3.6).toFixed(0),
      airs,
      crashReason: g.rider.crashReason ?? null,
    };
    g.skiers.hits = realHits;
    g.input = realInput;
  }

  return out;
});

await browser.close();

/* ---------------------------------------------------------------- */

const checks = [
  ['no console errors', consoleErrors.length === 0, consoleErrors.join('; ')],
  ['carve holds a 10-20 m radius', results.carve.radiusM > 9 && results.carve.radiusM < 21, `${results.carve.radiusM} m`],
  ['carve turns 35-80 deg/s', results.carve.degPerSec > 35 && results.carve.degPerSec < 80, `${results.carve.degPerSec} deg/s`],
  ['powder costs real speed', results.powder.kmhAfterPowder < results.powder.kmhAfterPiste * 0.7,
    `${results.powder.kmhAfterPowder} vs ${results.powder.kmhAfterPiste} km/h`],
  ['never permanently stuck', results.unstick.slowestKmh > 3,
    results.unstick.spots.map((s) => `${s.where}: ${s.kmhAfter5s} km/h`).join(', ')],
  ['can pivot round from facing uphill', results.unstick.uphillPivotDeg > 90,
    `${results.unstick.uphillPivotDeg} deg in 4 s`],
  ['skate shoves you off from a standstill', results.skate.kmhFromStandstill > 8 && results.skate.stayedGrounded,
    `${results.skate.kmhFromStandstill} km/h`],
  ['every kicker launches', results.kickers.minAir > 0.4, `min air ${results.kickers.minAir}s over ${results.kickers.count} kickers`],
  ['run is completable', results.run.finished,
    results.run.finished ? `reached the finish in ${results.run.seconds} s` : (results.run.crashReason ?? 'never reached the finish')],
  ['run takes 60-180 s', results.run.seconds > 60 && results.run.seconds < 180, `${results.run.seconds} s`],
  ['kickers get hit on the way down', results.run.airs >= 3, `${results.run.airs} airs`],
];

console.log(JSON.stringify(results, null, 2));
console.log();

let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}

console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
