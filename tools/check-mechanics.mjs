/**
 * Headless smoke test for the ride model.
 *
 * Boots the game in Chromium, takes over the frame loop so simulated time is
 * independent of render speed, and asserts the handful of properties that make
 * the game playable: a carve turns at a sane radius, powder actually bogs you
 * down without ever trapping you, every kicker on the course launches, tricks
 * score, sound behaves, and the run is completable.
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

  // Everything below this line was written against the original tuning and
  // asserts numbers from it — carve radius, terminal speed, which landings wash
  // out. The game now ships on the gentler `cruise` tuning by default, so the
  // harness has to say which one it means rather than inherit whichever is
  // current. The differences between the two get their own block at the end.
  g.setDifficulty('original');
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

  /* Spinning must rotate the board without bending the flight path. */
  {
    const k = c.kickers[0];
    const ride = (steer, grab) => {
      r.reset();
      const z0 = k.z - 26;
      const u = c.trackOffset(k.x, k.z);
      const tan = c.trackTangent(z0);
      r.position.set(c.centerX(z0) + u * tan.z, 0, z0 - u * tan.x);
      r.yaw = c.trackHeading(z0);
      r.speed = 24;
      r.settle();

      let launched = false, travelAtLaunch = 0, drift = 0, peakSpin = 0, landing = null;
      let airFrames = 0;
      for (let i = 0; i < 900; i++) {
        const wasGrounded = r.grounded;

        // A spin has to be asked for after take-off, so centre the stick for a
        // beat first — exactly what a player does. Holding an edge through the
        // lip deliberately does *not* spin you.
        airFrames = r.grounded ? 0 : airFrames + 1;
        const steerNow = r.grounded || airFrames < 12 ? 0 : steer;

        r.update(dt, { ...NONE, steer: steerNow, grabType: !r.grounded && grab ? grab : null });
        if (wasGrounded && !r.grounded) { launched = true; travelAtLaunch = r.yaw; }
        if (launched && !r.grounded) {
          peakSpin = Math.max(peakSpin, r.spinDegrees);
          drift = Math.max(drift, Math.abs(((r.yaw - travelAtLaunch) * 180) / Math.PI));
        }
        if (r.trickLanded || r.trickFailed) {
          landing = r.trickFailed ? { failed: true } : r.trickLanded;
          break;
        }
      }
      return { peakSpin: +peakSpin.toFixed(0), drift: +drift.toFixed(3), landing };
    };

    const spun = ride(1, null);
    const grabbed = ride(0, 'indy');
    // Every grab has to reach the landing intact and be named for what it was.
    const grabNames = ['indy', 'melon', 'nose', 'method'].map((g) => {
      const l = ride(0, g).landing;
      return `${g}:${l?.grabType ?? 'none'}`;
    });

    // Carrying an edge straight through the lip, never centring the stick:
    // this must not rotate the board at all.
    r.reset();
    const z1 = k.z - 26;
    const u1 = c.trackOffset(k.x, k.z);
    const tan1 = c.trackTangent(z1);
    r.position.set(c.centerX(z1) + u1 * tan1.z, 0, z1 - u1 * tan1.x);
    r.yaw = c.trackHeading(z1);
    r.speed = 24;
    r.settle();
    let heldSpin = 0;
    for (let i = 0; i < 900; i++) {
      r.update(dt, { ...NONE, steer: 1 });
      if (!r.grounded) heldSpin = Math.max(heldSpin, r.spinDegrees);
      if (r.trickLanded || r.trickFailed) break;
    }

    out.spin = {
      peakSpinDegrees: spun.peakSpin,
      travelDriftDegrees: spun.drift,
      grabSeconds: +(grabbed.landing?.grabTime ?? 0).toFixed(2),
      heldCarveSpin: +heldSpin.toFixed(1),
      grabNames,
    };
  }

  /* Popping at the lip has to be worth timing, and only at the lip. */
  {
    const ollieAt = (phaseWanted) => {
      const k = c.kickers[3];
      r.reset();
      const z0 = k.z - 30;
      const u = c.trackOffset(k.x, k.z);
      const tan = c.trackTangent(z0);
      r.position.set(c.centerX(z0) + u * tan.z, 0, z0 - u * tan.x);
      r.yaw = c.trackHeading(z0);
      r.speed = 24;
      r.settle();

      let popped = null;
      let air = 0;
      for (let i = 0; i < 900; i++) {
        const phase = c.kickerPhase(r.position.x, r.position.z);
        // Ollie the moment the ramp has been climbed as far as asked for.
        const jump = popped === null && phase > 0 && phase >= phaseWanted;
        r.update(dt, { ...NONE, jumpPressed: jump });
        if (jump) popped = r.popped;
        if (popped !== null && !r.grounded) air = Math.max(air, r.airTime);
        if (popped !== null && r.grounded && air > 0) break;
      }
      return { popped, air: +air.toFixed(2) };
    };
    out.pop = { atLip: ollieAt(0.9), atFoot: ollieAt(0.05) };
  }

  /* Butters: a ground spin that leaves you riding switch. */
  {
    r.reset();
    r.position.set(c.centerX(500), 0, 500);
    r.yaw = c.trackHeading(500);
    r.speed = 18;
    r.settle();

    let trick = null;
    let leftGround = false;
    // Press and hold a steer until the board has come round half a turn, then
    // let it back down.
    for (let i = 0; i < 900; i++) {
      const done = r.pressDegrees > 175;
      r.update(dt, { ...NONE, press: !done, steer: done ? 0 : 1 });
      if (!r.grounded) leftGround = true;
      if (r.groundTrick) { trick = r.groundTrick; break; }
    }
    out.butter = {
      halfTurns: trick?.halfTurns ?? 0,
      clean: !!trick?.clean,
      switchStance: r.switchStance,
      crashed: r.crashed,
      leftGround,
    };

    // A butter must not leak into the air as free rotation: take off mid-press
    // and the spin starts from zero again.
    r.reset();
    r.position.set(c.centerX(500), 0, 500);
    r.yaw = c.trackHeading(500);
    r.speed = 18;
    r.settle();
    for (let i = 0; i < 240; i++) r.update(dt, { ...NONE, press: true, steer: 1 });
    const carried = r.pressDegrees;
    r.grounded = false;
    r.vy = 6;
    r._beginAir();
    out.butter.groundSpinCarried = +r.spinDegrees.toFixed(1);
    out.butter.groundSpinBefore = +carried.toFixed(0);
  }

  /* A shifty is spun out and brought back — not a 180. */
  {
    r.reset();
    r.position.set(c.centerX(620), 0, 620);
    r.yaw = c.trackHeading(620);
    r.speed = 22;
    r.settle();
    r.grounded = false;
    r.vy = 8;
    r._beginAir();
    r.spinArmed = true;

    let landing = null;
    for (let i = 0; i < 900; i++) {
      // Out for a beat, then all the way back.
      const steer = r.spinPeak < 75 && r.spinDegrees >= 0 && i < 40 ? 1 : (r.spinDegrees > 4 ? -1 : 0);
      r.update(dt, { ...NONE, steer });
      if (r.trickLanded) { landing = r.trickLanded; break; }
      if (r.trickFailed) break;
    }
    out.shifty = {
      peak: +(landing ? 0 : 0),
      shifty: !!landing?.shifty,
      netDegrees: +(landing?.spinDegrees ?? -1).toFixed(0),
    };
  }

  /* Landing angle has to decide the outcome, forwards and switch alike. */
  {
    const landAt = (deg) => {
      r.reset();
      r.position.set(c.centerX(600), 0, 600);
      r.yaw = c.trackHeading(600);
      r.speed = 22;
      r.settle();
      r.grounded = false;
      r.vy = 6;
      r._beginAir();
      for (let i = 0; i < 900; i++) {
        r.boardYaw = r.yaw + (deg * Math.PI) / 180;   // hold the board off-axis
        r.update(dt, NONE);
        if (r.trickFailed) return r.crashed ? 'crashed out' : 'washed out';
        if (r.trickLanded) return r.trickLanded.clean ? 'clean' : 'sketchy';
      }
      return 'never landed';
    };
    out.landings = { 0: landAt(0), 30: landAt(30), 50: landAt(50), 90: landAt(90), 180: landAt(180) };
  }

  /**
   * No tree may reach over the groomed line. Trees are placed by offset and
   * sized separately, so a wide variant landing in the "encroaching" band is
   * all it takes to leave a collider sitting on the piste — a run ended by a
   * tree the rider never went near.
   */
  {
    let worst = Infinity;
    let where = 0;
    const seen = new Set();
    for (let z = 0; z < c.finishZ; z += 6) {
      for (const t of g.trees.query(z)) {
        if (seen.has(t)) continue;
        seen.add(t);
        const clearance = Math.abs(c.trackOffset(t.x, t.z)) - t.r - c.trackHalfWidth;
        if (clearance < worst) { worst = clearance; where = Math.round(t.z); }
      }
    }
    out.treeClearance = { metres: +worst.toFixed(2), atZ: where, counted: seen.size };
  }

  /**
   * A tree square on ends the run; a tree clipped in passing does not.
   *
   * This is the rule that decides whether the mountain is ridable, so it is
   * worth pinning: aim the rider straight at a trunk, then at one offset far
   * enough to the side that a shoulder catches it, and check the two outcomes
   * differ.
   */
  {
    const realTrees = g.trees;

    const runAt = (fraction) => {
      g.reset();
      g.state = 'riding';

      // One tree, placed by hand. Using a real one from the forest means the
      // rider can meet a *different* trunk on the way in and the test measures
      // the wrong collision.
      const rr = g.rider;
      const z = 700;
      const tree = { x: c.centerX(z), z, r: 1.1 };
      g.trees = { query: () => [tree] };

      const reach = tree.r + 0.62;
      rr.reset();
      rr.position.set(tree.x - fraction * reach, 0, tree.z - 26);
      rr.yaw = 0;
      rr.speed = 20;
      rr.settle();

      const fake = { steer: 0, tuck: false, brake: false, press: false, grabType: null,
        jumpPressed: false, restartPressed: false, helpPressed: false, endFrame() {}, clear() {} };
      const realInput = g.input;
      g.input = fake;
      for (let i = 0; i < 600; i++) {
        g.update(1 / 120);
        if (g.state !== 'riding') break;
        if (rr.stumbleTime > 0 && rr.position.z > tree.z) break;
      }
      g.input = realInput;
      return rr.crashed ? `crashed: ${rr.crashReason}` : (rr.stumbleTime > 0 ? 'brushed past' : 'missed');
    };

    out.trees = { squareOn: runAt(0), glancing: runAt(0.8) };
    g.trees = realTrees;
    // Back to the title, or `start()` further down sees a run already in
    // progress and returns without resetting anything.
    g.state = 'title';
    g.reset();
  }

  /* The track ribbon must wrap its ring buffer without tearing. */
  {
    const g2 = window.game;
    g2.tracks.reset();
    const t = g2.tracks;
    const total = t.segments;

    // Drive far enough to wrap the buffer right round and start overwriting.
    r.reset();
    r.position.set(c.centerX(400), 0, 400);
    r.yaw = c.trackHeading(400);
    r.speed = 24;
    r.settle();
    for (let i = 0; i < 120 * 90; i++) {
      const lookZ = r.position.z + Math.max(14, r.speed * 1.6);
      let d = Math.atan2(c.centerX(lookZ) - r.position.x, lookZ - r.position.z) - r.yaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      r.update(dt, { ...NONE, steer: Math.max(-1, Math.min(1, d * 3.2)) });
      t.update(r);
      if (r.crashed || r.position.z > c.finishZ - 40) break;
    }

    const attr = t.mesh.geometry.attributes;
    let nan = 0;
    let worstDrop = 0;
    for (let k = 0; k < attr.position.count; k++) {
      const x = attr.position.getX(k);
      const y = attr.position.getY(k);
      const z = attr.position.getZ(k);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) nan++;
      if (attr.aAlpha.getX(k) > 0.01) {
        worstDrop = Math.max(worstDrop, Math.abs(y - (c.groundHeight(x, z) + 0.03)));
      }
    }
    out.tracks = {
      wrapped: t.filled >= total,
      nanVertices: nan,
      // Every visible vertex must sit on the analytic surface, not float or sink.
      worstHeightError: +worstDrop.toFixed(4),
    };
  }

  /**
   * And the whole run has to be completable without touching anything — with
   * the traffic left in.
   *
   * The autopilot rides the centre line and makes no attempt to avoid anybody,
   * so this is the strongest statement of the thing that matters: that a rider
   * who simply points down the hill gets to the village. It only holds because
   * skiers stay out of the middle of the piste and because clipping one is a
   * stumble rather than the end of the run.
   */
  {
    const fake = { steer: 0, tuck: false, brake: false, press: false, grabType: null,
      jumpPressed: false, restartPressed: false, endFrame() {}, clear() {} };
    const realInput = g.input;
    g.input = fake;
    g.start();

    let airs = 0, wasAir = false, top = 0, bumps = 0, wasStumbling = false, air = 0;
    // The tracker marker has to march down the rail and never jump back.
    const marker = document.getElementById('tracker-rider');
    let lastTop = -1, trackerBacktracked = false, trackerSamples = 0;

    for (let i = 0; i < 120 * 300; i++) {
      const rr = g.rider;
      const lookZ = rr.position.z + Math.max(14, rr.speed * 1.7);
      let d = Math.atan2(c.centerX(lookZ) - rr.position.x, lookZ - rr.position.z) - rr.yaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      // On the snow, follow the line. In the air, centre the stick for a beat
      // to arm the spin and then throw a grabbed rotation — so this run also
      // proves that a rider who actually tricks their way down still gets to
      // the bottom, and that the run scores something.
      //
      // Proportional, not bang-bang. Full lock either side of a deadband keeps
      // the rider oscillating across the piste, and sooner or later it meets a
      // kicker mid-correction, takes off pointing across the hill and flies
      // into the trees — which says nothing about whether the course is
      // ridable, only that the autopilot was sawing at the stick.
      air = rr.grounded ? 0 : air + 1;
      fake.steer = rr.grounded
        ? Math.max(-1, Math.min(1, d * 2.4))
        : (air > 12 && air < 78 ? 1 : 0);
      fake.grabType = !rr.grounded && air > 12 && air < 62 ? 'method' : null;
      fake.tuck = rr.grounded && fake.steer === 0;
      g.update(1 / 120);
      if (g.state === 'riding') {
        top = Math.max(top, rr.speed);
        if (!rr.grounded && !wasAir) airs++;
        wasAir = !rr.grounded;
        const stumbling = rr.stumbleTime > 0;
        if (stumbling && !wasStumbling) bumps++;
        wasStumbling = stumbling;
        if (i % 240 === 0) {
          const t = parseFloat(marker?.style.top ?? '0') || 0;
          if (t < lastTop - 0.01) trackerBacktracked = true;
          lastTop = t;
          trackerSamples++;
        }
      }
      if (g.state !== 'riding') break;
    }
    out.run = {
      finished: g.state === 'finished',
      seconds: +(g.finishElapsed ?? g.elapsed).toFixed(1),
      topSpeedKmh: +(top * 3.6).toFixed(0),
      airs,
      crashReason: g.rider.crashReason ?? null,
      score: Math.round(g.score.total),
      tricksLogged: g.score.log.length,
      bumps,
      // Where it ended, and how far off the groomed line — which is the
      // difference between "the course is unfair" and "the autopilot wandered".
      endZ: Math.round(g.rider.position.z),
      endOffset: +c.trackOffset(g.rider.position.x, g.rider.position.z).toFixed(1),
    };

    out.tracker = {
      ticks: document.querySelectorAll('#tracker-ticks i').length,
      kickers: c.kickers.length,
      backtracked: trackerBacktracked,
      samples: trackerSamples,
      endedAt: lastTop,
    };

    // A crash keeps the points already banked but takes the streak.
    g.score.combo = 5;
    const bankedBeforeCrash = g.score.total;
    g.score.onCrash();
    out.combo = { afterCrash: g.score.combo, keptPoints: g.score.total === bankedBeforeCrash };
    g.input = realInput;
  }

  /**
   * And the same descent on the gentle tuning, which is the one the game
   * actually ships on and the one a child will meet first. Same autopilot, same
   * traffic, no avoidance — if this does not reach the village then the default
   * difficulty does not do what it claims.
   */
  {
    g.setDifficulty('cruise');
    const fake = { steer: 0, tuck: false, brake: false, press: false, grabType: null,
      jumpPressed: false, restartPressed: false, helpPressed: false, endFrame() {}, clear() {} };
    const realInput = g.input;
    g.input = fake;
    g.state = 'title';
    g.start();

    for (let i = 0; i < 120 * 400; i++) {
      const rr = g.rider;
      const lookZ = rr.position.z + Math.max(14, rr.speed * 1.7);
      let d = Math.atan2(c.centerX(lookZ) - rr.position.x, lookZ - rr.position.z) - rr.yaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      fake.steer = rr.grounded ? Math.max(-1, Math.min(1, d * 2.4)) : 0;
      fake.tuck = false;
      g.update(1 / 120);
      if (g.state !== 'riding') break;
    }

    out.cruiseRun = {
      finished: g.state === 'finished',
      seconds: +(g.finishElapsed ?? g.elapsed).toFixed(1),
      crashReason: g.rider.crashReason ?? null,
    };

    g.input = realInput;
    g.setDifficulty('original');
    g.state = 'title';
    g.reset();
  }

  /**
   * The gentle tuning has to be measurably gentler, in the three ways a
   * seven-year-old actually runs into: how fast it gets away from you, how long
   * you have in the air to do something, and whether the landing forgives you.
   */
  {
    const glide = () => {
      // Ten seconds down the piste, following the line. Steering matters: left
      // to run straight the rider leaves the groomer as the track bends away,
      // bogs down in the powder, and the *faster* tuning ends up slower — which
      // measures the powder, not the top speed.
      r.reset();
      r.position.set(c.centerX(700), 0, 700);
      r.yaw = c.trackHeading(700);
      r.speed = 6;
      r.settle();
      let top = 0;
      for (let i = 0; i < 120 * 10; i++) {
        const lookZ = r.position.z + Math.max(14, r.speed * 1.7);
        let d = Math.atan2(c.centerX(lookZ) - r.position.x, lookZ - r.position.z) - r.yaw;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        r.update(dt, { ...NONE, steer: Math.max(-1, Math.min(1, d * 2.4)) });
        top = Math.max(top, r.speed);
      }
      return +(top * 3.6).toFixed(0);
    };

    const airTime = () => {
      // A plain ollie on the flat, which isolates the two things that decide
      // how long you have to do something: the pop and gravity.
      r.reset();
      r.position.set(c.centerX(700), 0, 700);
      r.yaw = c.trackHeading(700);
      r.speed = 14;
      r.settle();
      let air = 0;
      let sawAir = false;
      for (let i = 0; i < 900; i++) {
        r.update(dt, { ...NONE, jumpPressed: i === 0 });
        if (!r.grounded) { sawAir = true; air = Math.max(air, r.airTime); }
        if (sawAir && r.grounded && air > 0.05) break;
      }
      return +air.toFixed(2);
    };

    // A landing well off square, and whether it rides away.
    const landAt90 = () => {
      r.reset();
      r.position.set(c.centerX(600), 0, 600);
      r.yaw = c.trackHeading(600);
      r.speed = 20;
      r.settle();
      r.grounded = false;
      r.vy = 6;
      r._beginAir();
      for (let i = 0; i < 900; i++) {
        r.boardYaw = r.yaw + Math.PI * 0.5;
        r.update(dt, NONE);
        if (r.trickFailed) return 'washed out';
        if (r.trickLanded) return 'rode away';
      }
      return 'never landed';
    };

    // A spin thrown without ever centring the stick — which the original
    // deliberately refuses and the gentle tuning deliberately allows.
    const spinWithoutArming = () => {
      r.reset();
      r.position.set(c.centerX(600), 0, 600);
      r.yaw = c.trackHeading(600);
      r.speed = 20;
      r.settle();
      r.grounded = false;
      r.vy = 7;
      r._beginAir();
      let peak = 0;
      for (let i = 0; i < 300 && !r.grounded; i++) {
        r.update(dt, { ...NONE, steer: 1 });
        peak = Math.max(peak, r.spinDegrees);
      }
      return Math.round(peak);
    };

    g.setDifficulty('original');
    const original = { kmh: glide(), air: airTime(), landing: landAt90(), spin: spinWithoutArming() };
    g.setDifficulty('cruise');
    const cruise = { kmh: glide(), air: airTime(), landing: landAt90(), spin: spinWithoutArming() };
    g.setDifficulty('original');

    out.tuning = { original, cruise };
  }

  /**
   * Hopping must not be a scoring strategy. A straight air pays nothing and
   * banks nothing, however long it hangs; the same air with a grab on it pays.
   */
  {
    const hop = { clean: true, stomped: false, spinDegrees: 4, shifty: false,
      grabTime: 0, grabType: null, popped: false, switchStance: false, airTime: 1.6 };
    const withGrab = { ...hop, grabTime: 0.9, grabType: 'indy' };

    g.score.reset();
    const hopAward = g.score.onTrickLanded(hop);
    const hopCombo = g.score.combo;
    g.score.reset();
    const grabAward = g.score.onTrickLanded(withGrab);

    out.hop = {
      hopPaid: hopAward ? hopAward.points : 0,
      hopCombo,
      grabPaid: grabAward ? grabAward.points : 0,
      grabCombo: g.score.combo,
    };
    g.score.reset();
  }

  return out;
});

/* ------------------------------------------------------------------
 * Audio needs a fresh page (the run above has already ended), a real user
 * gesture to create the context, and real elapsed time — the continuous
 * voices ride on setTargetAtTime, which converges in wall-clock seconds and
 * reads as silence if you sample it in the same tick you set it.
 * ---------------------------------------------------------------- */

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.game, null, { timeout: 90000 });

const audio = { supported: await page.evaluate(() => window.game.audio.supported) };
audio.beforeGesture = await page.evaluate(() => !!window.game.audio.ctx);

await page.click('#btn-start');
await page.waitForTimeout(600);
audio.afterGesture = await page.evaluate(() => window.game.audio.ctx?.state ?? 'none');

await page.evaluate(() => {
  const g = window.game;
  g.renderer.setAnimationLoop(null);
  const r = g.rider;
  r.grounded = true; r.powder = 0; r.braking = false;
  r.speed = 4; r.carveIntensity = 0;
  g.audio.update(r, true);
});
await page.waitForTimeout(450);
audio.idle = await page.evaluate(() => +window.game.audio.edgeGain.gain.value.toFixed(3));

await page.evaluate(() => {
  const g = window.game, r = g.rider;
  r.speed = 30; r.carveIntensity = 1;
  g.audio.update(r, true);
});
await page.waitForTimeout(900);
audio.carving = await page.evaluate(() => ({
  edge: +window.game.audio.edgeGain.gain.value.toFixed(3),
  wind: +window.game.audio.windGain.gain.value.toFixed(3),
}));

audio.oneShots = await page.evaluate(() => {
  const a = window.game.audio;
  try {
    a.ollie(); a.land(12, 0.2); a.powderPuff(); a.skate(); a.trick(4); a.fail(); a.crash();
    return 'ok';
  } catch (e) {
    return `threw: ${e.message}`;
  }
});

await page.click('#btn-mute');
await page.waitForTimeout(320);
audio.muted = await page.evaluate(() => +window.game.audio.master.gain.value.toFixed(3));

/* ------------------------------------------------------------------
 * The controls panel and the pause it implies. This needs the real frame
 * loop running — the whole point of the assertion is that wall-clock time
 * passes and the run clock does not move with it.
 * ---------------------------------------------------------------- */

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.game, null, { timeout: 90000 });

const ui = {};

// From the title screen the panel is just another page, and closing it puts
// back the screen you came from.
await page.click('#btn-help-title');
ui.fromTitle = await page.evaluate(() => window.game.hud.currentScreen);
await page.click('#btn-resume');
ui.backToTitle = await page.evaluate(() => window.game.hud.currentScreen);

await page.click('#btn-start');
await page.waitForTimeout(500);
await page.click('#btn-help');
ui.pausedState = await page.evaluate(() => window.game.state);

const elapsedAtPause = await page.evaluate(() => window.game.elapsed);
await page.waitForTimeout(900);
ui.clockDrift = await page.evaluate((before) => +(window.game.elapsed - before).toFixed(4), elapsedAtPause);

await page.click('#btn-resume');
// Generous, because this renders through SwiftShader: a couple of frames here
// can take the best part of a second, and the assertion is only that the clock
// starts moving again at all.
await page.waitForTimeout(2000);
ui.resumedState = await page.evaluate(() => window.game.state);
ui.clockRuns = await page.evaluate((before) => window.game.elapsed > before, elapsedAtPause);

// What the scene itself costs, a third of the way down the mountain. Measured
// from a direct render rather than from the live frame: `renderer.info` resets
// on every `render()` call, and through the composer the last of those is a
// single fullscreen quad, so reading it after a frame reports "1 draw call".
ui.draws = await page.evaluate(() => {
  const g = window.game;
  g.renderer.info.reset();
  g.renderer.render(g.scene, g.camera);
  const info = g.renderer.info.render;
  return { calls: info.calls, triangles: info.triangles };
});

/* ------------------------------------------------------------------
 * The rider's rig.
 *
 * The model is one skinned mesh over a skeleton whose bone names `Rider.js`
 * reaches for directly. Nothing here judges whether the character looks good —
 * that needs eyes, and `tools/rider-shots.mjs` is what puts pictures in front
 * of them. What can be checked is that the rig is the shape the posing code
 * assumes, and that a full descent never drives a bone to a value that would
 * make the whole body vanish.
 * ---------------------------------------------------------------- */
ui.rig = await page.evaluate(() => {
  const g = window.game;
  const m = g.rider.model;

  let skinnedMeshes = 0;
  m.root.traverse((o) => { if (o.isSkinnedMesh) skinnedMeshes++; });

  // Every node the posing code drives, and the bones behind them.
  const posed = ['root', 'tilt', 'board', 'body', 'hips', 'torso', 'neck', 'head', 'bobble'];
  const missing = posed.filter((k) => !m[k]);
  for (const limb of ['armFront', 'armBack', 'legFront', 'legBack']) {
    for (const part of ['root', 'joint', 'end']) {
      if (!m[limb]?.[part]?.isBone) missing.push(`${limb}.${part}`);
    }
  }
  for (const leg of ['legFront', 'legBack']) if (!m[leg]?.boot) missing.push(`${leg}.boot`);

  const geo = m.skinned.geometry;
  const bones = m.skeleton.bones.length;

  // Weights have to sum to one, or the surface shrinks toward the origin.
  const w = geo.attributes.skinWeight;
  let worstWeight = 0;
  for (let i = 0; i < w.count; i++) {
    const sum = w.getX(i) + w.getY(i) + w.getZ(i) + w.getW(i);
    worstWeight = Math.max(worstWeight, Math.abs(sum - 1));
  }

  // And every skinIndex has to name a bone that exists.
  const si = geo.attributes.skinIndex;
  let badIndex = 0;
  for (let i = 0; i < si.count; i++) {
    if (si.getX(i) >= bones || si.getY(i) >= bones) badIndex++;
  }

  return {
    skinnedMeshes,
    missing,
    bones,
    vertices: geo.attributes.position.count,
    hasUV: !!geo.attributes.uv,
    worstWeight: +worstWeight.toFixed(4),
    badIndex,
    culled: m.skinned.frustumCulled,
  };
});

// Ride the whole course and watch the skeleton for anything non-finite. A
// single NaN propagates through `matrixWorld` and takes the entire character
// off screen, and it is exactly the sort of thing a bad IK target produces
// only in the one pose nobody screenshotted.
ui.boneHealth = await page.evaluate(() => {
  const g = window.game;
  g.restart();
  const dt = 1 / 60;
  let bad = 0;
  let frames = 0;
  let maxCrouch = 0;

  // The game reads its own input object, so driving it means substituting one.
  const fake = { steer: 0, tuck: false, brake: false, press: false, grabType: null,
    jumpPressed: false, restartPressed: false, helpPressed: false, endFrame() {}, clear() {} };
  const realInput = g.input;
  g.input = fake;

  for (let i = 0; i < 60 * 60 && g.state === 'riding'; i++) {
    // Steer back toward the middle of the piste, and spend a good part of the
    // descent in the air holding a grab — the deepest crouch the rig ever sees.
    const d = g.course.centerX(g.rider.position.z) - g.rider.position.x;
    fake.steer = Math.max(-1, Math.min(1, d * 2.4));
    fake.jumpPressed = i % 200 === 0;
    fake.grabType = i % 200 < 40 ? 'method' : null;
    fake.tuck = i % 200 > 120;
    g.update(dt);
    frames++;
    maxCrouch = Math.max(maxCrouch, g.rider._crouch);
    for (const b of g.rider.model.skeleton.bones) {
      const e = b.matrixWorld.elements;
      for (let k = 0; k < 16; k++) if (!Number.isFinite(e[k])) { bad++; k = 16; }
    }
  }
  g.input = realInput;
  return { bad, frames, maxCrouch: +maxCrouch.toFixed(3) };
});

// Rescue teleports the rider, so it must not fire on a stray key press — only
// once the game has actually offered it.
ui.rescue = await page.evaluate(() => {
  const g = window.game;
  g.isStuck = false;
  const z0 = g.rider.position.z;
  const x0 = g.rider.position.x;
  g.rescue();
  const ignored = g.rider.position.z === z0 && g.rider.position.x === x0;
  g.isStuck = true;
  g.rescue();
  return { ignoredWhenNotStuck: ignored, actedWhenStuck: g.rider.speed === 10 };
});

await browser.close();

/* ---------------------------------------------------------------- */

const checks = [
  ['no console errors', consoleErrors.length === 0, consoleErrors.join('; ')],
  // The lower bound was 9 m until the board was given enough bite to dodge
  // something at speed. A real carve runs 8-15 m, so this is still inside what
  // a snowboard does; what it must not become is a car on rails.
  ['carve holds an 8-20 m radius', results.carve.radiusM > 8 && results.carve.radiusM < 21, `${results.carve.radiusM} m`],
  ['carve turns 35-80 deg/s', results.carve.degPerSec > 35 && results.carve.degPerSec < 80, `${results.carve.degPerSec} deg/s`],
  ['powder costs real speed', results.powder.kmhAfterPowder < results.powder.kmhAfterPiste * 0.7,
    `${results.powder.kmhAfterPowder} vs ${results.powder.kmhAfterPiste} km/h`],
  ['never permanently stuck', results.unstick.slowestKmh > 3,
    results.unstick.spots.map((s) => `${s.where}: ${s.kmhAfter5s} km/h`).join(', ')],
  ['can pivot round from facing uphill', results.unstick.uphillPivotDeg > 90,
    `${results.unstick.uphillPivotDeg} deg in 4 s`],
  ['skate shoves you off from a standstill', results.skate.kmhFromStandstill > 8 && results.skate.stayedGrounded,
    `${results.skate.kmhFromStandstill} km/h`],
  ['a 360 fits in a kicker air', results.spin.peakSpinDegrees >= 360,
    `${results.spin.peakSpinDegrees} deg reached`],
  ['a held carve through the lip does not spin you', results.spin.heldCarveSpin < 5,
    `${results.spin.heldCarveSpin} deg from an uninterrupted hold`],
  ['spinning does not bend the flight path', results.spin.travelDriftDegrees < 0.01,
    `${results.spin.travelDriftDegrees} deg of travel drift`],
  ['grab registers while airborne', results.spin.grabSeconds > 0.3, `${results.spin.grabSeconds} s held`],
  ['every grab arrives at the landing named',
    results.spin.grabNames.every((s) => s.split(':')[0] === s.split(':')[1]),
    results.spin.grabNames.join(' ')],
  ['popping at the lip goes higher than coasting off it',
    results.pop.atLip.popped === 1 && results.pop.atFoot.popped === 0 &&
    results.pop.atLip.air > results.pop.atFoot.air,
    `lip ${results.pop.atLip.air}s (pop ${results.pop.atLip.popped}) vs foot ${results.pop.atFoot.air}s (pop ${results.pop.atFoot.popped})`],
  ['a butter 180 rides away switch, on the snow',
    results.butter.halfTurns === 1 && results.butter.clean && results.butter.switchStance &&
    !results.butter.crashed && !results.butter.leftGround,
    `${results.butter.halfTurns * 180} deg, ${results.butter.clean ? 'clean' : 'scrappy'}, switch ${results.butter.switchStance}`],
  ['a ground spin does not carry into the air',
    results.butter.groundSpinBefore > 90 && results.butter.groundSpinCarried === 0,
    `${results.butter.groundSpinBefore} deg on the snow -> ${results.butter.groundSpinCarried} deg at take-off`],
  ['a shifty scores as a shifty, not as a rotation',
    results.shifty.shifty && results.shifty.netDegrees < 30,
    `net ${results.shifty.netDegrees} deg, shifty ${results.shifty.shifty}`],
  ['a tree square on ends the run, one clipped in passing does not',
    results.trees.squareOn.startsWith('crashed') && results.trees.glancing === 'brushed past',
    `square on: ${results.trees.squareOn}, glancing: ${results.trees.glancing}`],
  ['washing out a landing costs the trick, not the run',
    results.landings[90] === 'washed out',
    `at 90 degrees: ${results.landings[90]}`],
  ['landing angle decides the outcome',
    results.landings[0] === 'clean' && results.landings[30] === 'clean' &&
    results.landings[50] === 'sketchy' && results.landings[90] === 'washed out' &&
    results.landings[180] === 'clean',
    Object.entries(results.landings).map(([d, v]) => `${d}:${v}`).join(' ')],
  ['a run accrues score', results.run.score > 0, `${results.run.score} points`],
  ['a crash clears the combo but banks the points',
    results.combo.afterCrash === 1 && results.combo.keptPoints,
    `combo -> ${results.combo.afterCrash}`],
  ['every kicker launches', results.kickers.minAir > 0.4, `min air ${results.kickers.minAir}s over ${results.kickers.count} kickers`],
  ['cruise gets down the mountain too', results.cruiseRun.finished,
    results.cruiseRun.finished
      ? `reached the village in ${results.cruiseRun.seconds} s`
      : (results.cruiseRun.crashReason ?? 'never reached the finish')],
  ['cruise runs slower than original', results.tuning.cruise.kmh < results.tuning.original.kmh * 0.75,
    `${results.tuning.cruise.kmh} vs ${results.tuning.original.kmh} km/h down the same pitch`],
  ['cruise gives longer in the air', results.tuning.cruise.air > results.tuning.original.air * 1.15,
    `${results.tuning.cruise.air}s vs ${results.tuning.original.air}s from the same ollie`],
  ['cruise forgives a landing that original washes out',
    results.tuning.original.landing === 'washed out' && results.tuning.cruise.landing === 'rode away',
    `at 90 degrees: original ${results.tuning.original.landing}, cruise ${results.tuning.cruise.landing}`],
  ['cruise spins without arming first, original does not',
    results.tuning.original.spin === 0 && results.tuning.cruise.spin > 90,
    `original ${results.tuning.original.spin} deg, cruise ${results.tuning.cruise.spin} deg`],
  ['a straight hop pays nothing and banks nothing',
    results.hop.hopPaid === 0 && results.hop.hopCombo === 1,
    `hop ${results.hop.hopPaid} pts (combo ${results.hop.hopCombo}), same air grabbed ${results.hop.grabPaid} pts (combo ${results.hop.grabCombo})`],
  ['a grabbed air still pays', results.hop.grabPaid > 60 && results.hop.grabCombo === 2,
    `${results.hop.grabPaid} pts`],
  ['clipping a skier does not end the run', results.run.finished || results.run.bumps === 0,
    `${results.run.bumps} skiers clipped on the way down`],
  ['run is completable, traffic and all', results.run.finished,
    results.run.finished ? `reached the finish in ${results.run.seconds} s` : (results.run.crashReason ?? 'never reached the finish')],
  ['run takes 60-180 s', results.run.seconds > 60 && results.run.seconds < 180, `${results.run.seconds} s`],
  ['audio stays asleep until a user gesture', audio.supported && !audio.beforeGesture,
    audio.beforeGesture ? 'a context existed before the click' : 'no context before DROP IN'],
  ['audio starts on the drop-in gesture', audio.afterGesture === 'running', audio.afterGesture],
  ['the edge voice tracks the carve', audio.carving.edge > audio.idle * 3 && audio.carving.edge > 0.1,
    `${audio.idle} idle -> ${audio.carving.edge} carving`],
  ['wind rises with speed', audio.carving.wind > 0.1, `${audio.carving.wind}`],
  ['one-shots fire without throwing', audio.oneShots === 'ok', audio.oneShots],
  ['mute silences the master', audio.muted === 0, `master ${audio.muted}`],
  ['kickers get hit on the way down', results.run.airs >= 3, `${results.run.airs} airs`],
  ['no tree reaches over the groomed line',
    results.treeClearance.metres > 0,
    `closest is ${results.treeClearance.metres} m clear at z=${results.treeClearance.atZ}, over ${results.treeClearance.counted} trees`],
  ['the tracker has a tick for every kicker',
    results.tracker.ticks === results.tracker.kickers,
    `${results.tracker.ticks} ticks for ${results.tracker.kickers} kickers`],
  ['the tracker marker only ever goes down the hill',
    !results.tracker.backtracked && results.tracker.samples > 10 && results.tracker.endedAt > 90,
    `${results.tracker.samples} samples, ended at ${results.tracker.endedAt}%`],
  ['a run keeps a trick log', results.run.tricksLogged > 0, `${results.run.tricksLogged} awards`],
  ['the controls panel opens from the title and closes back to it',
    ui.fromTitle === 'help' && ui.backToTitle === 'title', `${ui.fromTitle} -> ${ui.backToTitle}`],
  ['opening the controls mid-run pauses it', ui.pausedState === 'paused', ui.pausedState],
  ['a pause stops the clock', ui.clockDrift === 0, `${ui.clockDrift}s of drift over 0.9s paused`],
  ['closing it resumes the run', ui.resumedState === 'riding' && ui.clockRuns,
    `${ui.resumedState}, clock ${ui.clockRuns ? 'running' : 'stopped'}`],
  ['the rider is a single skinned mesh', ui.rig.skinnedMeshes === 1,
    `${ui.rig.skinnedMeshes} skinned meshes, ${ui.rig.vertices} vertices over ${ui.rig.bones} bones`],
  ['every node the posing code drives exists', ui.rig.missing.length === 0,
    ui.rig.missing.length ? `missing ${ui.rig.missing.join(', ')}` : 'all present, limbs are bones'],
  ['the skin weights are normalised and in range',
    ui.rig.worstWeight < 0.001 && ui.rig.badIndex === 0 && ui.rig.hasUV,
    `worst weight error ${ui.rig.worstWeight}, ${ui.rig.badIndex} out-of-range bone indices`],
  ['the rider is never frustum culled', ui.rig.culled === false,
    ui.rig.culled ? 'culled on its bind pose bounds' : 'always drawn'],
  ['no bone goes non-finite over a whole descent', ui.boneHealth.bad === 0,
    `${ui.boneHealth.bad} bad matrices over ${ui.boneHealth.frames} frames`],
  ['the crouch stays inside what the knees can solve', ui.boneHealth.maxCrouch <= 0.381,
    `deepest crouch ${ui.boneHealth.maxCrouch} m`],
  ['the frame stays inside its draw-call budget', ui.draws.calls > 0 && ui.draws.calls < 260,
    `${ui.draws.calls} calls, ${(ui.draws.triangles / 1000).toFixed(0)}k triangles`],
  ['rescue only fires once you are bogged down',
    ui.rescue.ignoredWhenNotStuck && ui.rescue.actedWhenStuck,
    ui.rescue.ignoredWhenNotStuck ? 'ignored mid-run, acted when offered' : 'teleported on a stray press'],
  ['the track ribbon wraps its ring buffer', results.tracks.wrapped, `filled the whole buffer`],
  ['the ribbon holds no NaN vertices', results.tracks.nanVertices === 0, `${results.tracks.nanVertices} bad vertices`],
  ['every visible ribbon vertex sits on the snow', results.tracks.worstHeightError < 0.001,
    `worst error ${results.tracks.worstHeightError} m`],
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
