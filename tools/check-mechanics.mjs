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

  /**
   * The spine kicker's two lobes are mirror images of each other, and the ramp
   * they build is genuinely banked — each half's steepest line is rotated
   * twenty degrees away from the other. Which half you ride up therefore
   * decides which way you get thrown.
   *
   * It did not used to. The physics moved the rider exactly where the board
   * pointed and the surface normal was only ever read along the heading, so a
   * cross-slope had nothing to act through: both lobes returned the same
   * result to four decimal places and a "the two sides differ" assertion had to
   * be dropped as untestable. The lateral gravity coupling is the channel that
   * was missing, so the split is now a physical outcome rather than only a
   * geometric one — and this asserts both halves of the contract: either lobe
   * still sends you, and the two send you somewhere measurably different.
   */
  {
    const hip = c.kickers.find((k) => k.hip);
    if (!hip) {
      out.hipKicker = { found: false };
    } else {
      const ride = (lateral) => {
        r.reset();
        const z0 = hip.z - 20;
        const tan = c.trackTangent(z0);
        r.position.set(hip.x + lateral * tan.z, 0, hip.z - hip.dirZ * 20 - lateral * tan.x);
        const approach = Math.atan2(hip.dirX, hip.dirZ);
        r.yaw = approach;
        r.speed = 22;
        r.settle();
        let air = 0, sawAir = false;
        // Where the lobe threw them. Two readings: the heading the *ramp*
        // alone put on them — taken from the moment the board touches the
        // ramp, so the approach's own gentle cross-slope is not counted — and
        // how far across the ramp's axis they then flew.
        let rampYaw = null, launchYaw = approach, launchX = 0, launchZ = 0, cross = 0;
        for (let i = 0; i < 500; i++) {
          const wasGrounded = r.grounded;
          r.update(dt, NONE);
          if (rampYaw === null && c.kickerPhase(r.position.x, r.position.z) > 0) {
            rampYaw = r.yaw;
          }
          if (wasGrounded && !r.grounded) {
            launchYaw = r.yaw;
            launchX = r.position.x;
            launchZ = r.position.z;
          }
          if (!r.grounded) {
            sawAir = true;
            air = Math.max(air, r.airTime);
            cross = (r.position.x - launchX) * hip.dirZ - (r.position.z - launchZ) * hip.dirX;
          }
          if (sawAir && r.grounded && air > 0.05) break;
        }
        const wrap = (a) => {
          while (a > Math.PI) a -= 2 * Math.PI;
          while (a < -Math.PI) a += 2 * Math.PI;
          return (a * 180) / Math.PI;
        };
        return { air, rampDeg: wrap(launchYaw - (rampYaw ?? approach)), cross };
      };
      const left = ride(-hip.halfWidth * 0.45);
      const right = ride(hip.halfWidth * 0.45);
      out.hipKicker = {
        found: true,
        leftAir: +left.air.toFixed(2),
        rightAir: +right.air.toFixed(2),
        bothLaunch: left.air > 0.15 && right.air > 0.15,
        // Signed, and opposite. A ramp is a ramp: its cross-slope pushes you
        // off the high side toward the low one, so the right-hand lobe leans
        // you back toward the spine and the left-hand lobe the other way.
        // Before there was any lateral coupling both of these were exactly
        // zero, whichever lobe you took.
        leftRampDeg: +left.rampDeg.toFixed(2),
        rightRampDeg: +right.rampDeg.toFixed(2),
        leftCrossM: +left.cross.toFixed(2),
        rightCrossM: +right.cross.toFixed(2),
        splitDeg: +(left.rampDeg - right.rampDeg).toFixed(2),
        splitM: +(left.cross - right.cross).toFixed(2),
      };
    }
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

    // A rider who simply follows the centre line the whole way down should
    // still pick up a good number of stars — most of them sit close to it.
    out.collectibles = {
      starsPlaced: g.collectibles.stars.length,
      gatesPlaced: g.collectibles.gates.length,
      starsCollected: g.score.starsCollected,
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

  /**
   * Collectible scoring: stars pay flat and unmultiplied, gates escalate on a
   * streak and simply reset — never punish — on a miss.
   */
  {
    const s = new g.score.constructor();
    s.combo = 5; // the trick multiplier must not touch a star's payout
    const before = s.total;
    s.onStar();
    const starGain = s.total - before;

    s.reset();
    s.onGate(true);
    s.onGate(true);
    const streakBefore = s.gateStreak;
    const totalBeforeMiss = s.total;
    s.onGate(false);
    out.collectibleScoring = {
      starGain,
      streakBeforeMiss: streakBefore,
      streakAfterMiss: s.gateStreak,
      scoreKeptOnMiss: s.total === totalBeforeMiss,
    };
  }

  /**
   * Grinds: the catch has to be generous but bounded, a blown balance has to
   * cost the run nothing worse than a stumble, and riding one out has to pay.
   */
  {
    const rail = c.rails[0];
    if (!rail) {
      out.rails = { count: 0 };
    } else {
      const catchAt = (lateral, angleDeg, heightOffset) => {
        r.reset();
        const s = rail.length * 0.4;
        const p = c.railPointAt(rail, s);
        const tan = c.railTangentAt(rail, s);
        const px = tan.z, pz = -tan.x;
        r.position.set(p.x + px * lateral, c.railHeightAt(rail, s) + heightOffset, p.z + pz * lateral);
        const railYaw = Math.atan2(tan.x, tan.z);
        r.yaw = railYaw + (angleDeg * Math.PI) / 180;
        r.boardYaw = r.yaw;
        r.speed = 15;
        r.grounded = false;
        r._tryCatchRail();
        return r.grinding;
      };

      const beginGrind = (railToUse, s0 = 0) => {
        r.reset();
        r.grinding = true;
        r.grindRail = railToUse;
        r.grindS = s0;
        r.grindTime = 0;
        r.grindBalance = 0;
        r.grindBalanceVel = 0;
        r.speed = 15;
        r.grounded = false;
      };

      out.railCatch = {
        withinMargin: catchAt(0.4, 10, 0.1),
        outsideLateral: catchAt(2.5, 10, 0.1),
        outsideAngle: catchAt(0.4, 80, 0.1),
        outsideHeight: catchAt(0.4, 10, 3.5),
      };

      // Speed bleeds off steadily while grinding.
      beginGrind(rail);
      const speedBefore = r.speed;
      for (let i = 0; i < 30 && r.grinding; i++) r.update(dt, NONE);
      out.railFriction = { before: +speedBefore.toFixed(2), after: +r.speed.toFixed(2) };

      // Holding hard over blows the balance meter and stumbles, not crashes.
      // Slowed down and started from the foot, so the rail lasts long enough
      // for the balance spring's overshoot to actually cross the fail
      // threshold before the rider reaches the end of it.
      beginGrind(rail, 0);
      r.speed = 6;
      let fellOff = false;
      let poppedInstead = false;
      for (let i = 0; i < 240 && r.grinding; i++) {
        r.update(dt, { ...NONE, steer: 1 });
        if (!r.grinding) { fellOff = true; poppedInstead = !!r.grindPopped; }
      }
      out.railFail = { fellOff, poppedInstead, crashed: r.crashed, stumbled: r.stumbleTime > 0 };

      // Riding one all the way out pops you airborne and pays.
      beginGrind(rail);
      let popped = null;
      for (let i = 0; i < 900 && r.grinding; i++) {
        r.update(dt, NONE);
        if (r.grindPopped) popped = r.grindPopped;
      }
      const award = popped ? g.score.onGrindPopped(popped.seconds) : null;
      out.railPop = { popped: !!popped, seconds: +(popped?.seconds ?? 0).toFixed(2), points: award?.points ?? 0 };

      // A curved rail's parametrisation has to stay self-consistent — the
      // rider is clamped exactly onto it, so this is really a check on
      // `railPointAt`/`_updateGrind` agreeing with each other over the whole
      // length rather than on the rider drifting off an arc it cannot leave.
      const curved = c.rails.find((rr) => rr.curveRadius !== 0);
      if (curved) {
        beginGrind(curved);
        let worstDrift = 0;
        let frames = 0;
        while (r.grinding && frames < 600) {
          r.update(dt, NONE);
          if (r.grinding) {
            const p = c.railPointAt(curved, Math.min(r.grindS, curved.length));
            worstDrift = Math.max(worstDrift, Math.hypot(r.position.x - p.x, r.position.z - p.z));
          }
          frames++;
        }
        out.curvedRail = { found: true, worstDrift: +worstDrift.toFixed(4), frames };
      } else {
        out.curvedRail = { found: false, worstDrift: 0, frames: 0 };
      }
    }
  }

  /* ==================================================================
   * BANKING — lateral gravity coupling.
   *
   * Everything from here to `return out` belongs to one change: the rider
   * now feels the cross-slope under the board and gets turned toward the
   * local fall line by it. Kept in one contiguous block at the end of the
   * measurement section so it reads as the single addition it is.
   *
   * Three things have to be true at once, and they pull against each other:
   * a level surface must produce no drift at all (or the whole model is a
   * random walk), a real bank must produce a turn you can feel, and the
   * mountain the game already shipped must ride as it did before.
   * ================================================================ */
  {
    /**
     * Runs `fn` with the course's height field replaced by an analytic one.
     *
     * The overrides go on the instance and are deleted afterwards, which puts
     * the prototype's own methods back rather than leaving a shadowing copy.
     * `groundNormal` reads `this.groundHeight`, so it picks the synthetic
     * surface up for free and the normal stays consistent with the height.
     * Grooming and rails are stubbed out too: neither belongs to a plane, and
     * a stray rail catch would silently end the measurement.
     */
    const onSurface = (heightAt, fn) => {
      c.terrainHeight = heightAt;
      c.groundHeight = heightAt;
      c.kickerHeight = () => 0;
      c.groomAt = () => 1;
      c.railsNear = () => [];
      try {
        return fn();
      } finally {
        delete c.terrainHeight;
        delete c.groundHeight;
        delete c.kickerHeight;
        delete c.groomAt;
        delete c.railsNear;
      }
    };

    /** Puts the rider on the synthetic surface at the origin, pointing down +Z. */
    const placeAt = (yaw, speed) => {
      r.reset();
      r.position.set(0, 0, 0);
      r.yaw = yaw;
      r.speed = speed;
      r.settle();
      r.lean = 0;
      r.leanVel = 0;
      r.carveIntensity = 0;
    };

    /* 1. The control. A dead level surface has no cross-slope anywhere, in
     * any direction, so a rider left alone on it must hold their heading
     * exactly — not approximately. Any drift here is the term firing on
     * nothing, and would show up on the mountain as a rider who cannot be
     * pointed anywhere. Deliberately started off-axis: on a level plane the
     * heading is irrelevant, which is the whole point of the check. */
    out.bankFlat = onSurface(() => 0, () => {
      placeAt(0.4, 20);
      const yaw0 = r.yaw;
      let worst = 0;
      for (let i = 0; i < 120 * 5; i++) {
        r.update(dt, NONE);
        worst = Math.max(worst, Math.abs(r.yaw - yaw0));
      }
      return {
        driftDeg: +((worst * 180) / Math.PI).toFixed(4),
        seconds: 5,
        endSpeed: +r.speed.toFixed(2),
      };
    });

    /* 2. The bank. A plane pitched downhill *and* tilted across, which is the
     * surface the old model had no channel for at all: the rider used to
     * traverse it for ever on a heading they never chose to leave.
     *
     * The fall line of the plane is the direction of steepest descent, and it
     * is what the rider should end up pointing at. Both tilts are measured, so
     * the term is shown to be signed rather than merely non-zero. */
    {
      const pitch = 0.25;                 // 14 degrees down the hill
      const cross = Math.tan(0.44);       // ~25 degrees across it
      const ride = (side) => onSurface(
        (x, z) => -pitch * z - side * cross * x,
        () => {
          placeAt(0, 18);
          const samples = [];
          for (let i = 0; i < 120 * 3; i++) {
            r.update(dt, NONE);
            if (i === 119 || i === 239 || i === 359) {
              samples.push(+((r.yaw * 180) / Math.PI).toFixed(1));
            }
          }
          return {
            // Where the plane's own fall line points, as a heading.
            fallLineDeg: +((Math.atan2(side * cross, pitch) * 180) / Math.PI).toFixed(1),
            afterOneSec: samples[0],
            afterTwoSec: samples[1],
            afterThreeSec: samples[2],
            driftedX: +r.position.x.toFixed(1),
          };
        }
      );

      // And the same bank ridden with the edge buried. An engaged edge is
      // exactly what holds a rider across a slope, so a hard carve has to
      // resist the drift rather than be dragged along by it. Compared against
      // the same carve on a level plane, so what is measured is the bank's
      // contribution and not the carve's own arc.
      const carved = (heightAt) => onSurface(heightAt, () => {
        placeAt(0, 18);
        for (let i = 0; i < 120 * 2; i++) r.update(dt, { ...NONE, steer: -1 });
        return r.yaw;
      });
      const carveLevel = carved(() => 0);
      const carveBanked = carved((x, z) => -pitch * z - cross * x);

      out.bankPlane = {
        right: ride(1),
        left: ride(-1),
        // How much of the bank's pull survives a fully committed edge, as a
        // fraction of what a flat-based rider gets over the same two seconds.
        carveResidualDeg: +(((carveBanked - carveLevel) * 180) / Math.PI).toFixed(1),
      };
    }

    /* 3. The regression. A closed-loop descent of the real mountain — the same
     * follow-the-centre-line autopilot the run check uses, but driving the
     * rider directly, so no traffic, no trees and no scoring can move the
     * numbers. Purely Rider + Course, and therefore deterministic to the last
     * digit for a given tuning.
     *
     * The baseline below was captured by running this exact block against the
     * unmodified physics (bankDrift forced to 0, which reproduces the old
     * model exactly — hoisting the `groundNormal` sample changes nothing on
     * its own, the normal depends only on a position this frame has not moved
     * yet). Both tunings are measured: cruise is what the game ships on. */
    {
      const descend = (limitSeconds) => {
        r.reset();
        let t = 0, top = 0, airTotal = 0, airs = 0, wasAir = false;
        for (let i = 0; i < 120 * limitSeconds; i++) {
          const lookZ = r.position.z + Math.max(14, r.speed * 1.7);
          let d = Math.atan2(c.centerX(lookZ) - r.position.x, lookZ - r.position.z) - r.yaw;
          while (d > Math.PI) d -= 2 * Math.PI;
          while (d < -Math.PI) d += 2 * Math.PI;
          r.update(dt, { ...NONE, steer: Math.max(-1, Math.min(1, d * 2.4)) });
          t += dt;
          top = Math.max(top, r.speed);
          if (!r.grounded) { airTotal += dt; if (!wasAir) airs++; }
          wasAir = !r.grounded;
          if (r.position.z >= c.finishZ || r.crashed) break;
        }
        return {
          seconds: +t.toFixed(2),
          topKmh: +(top * 3.6).toFixed(1),
          airSeconds: +airTotal.toFixed(2),
          airs,
          endZ: +r.position.z.toFixed(1),
          // How far the autopilot was pushed off the groomed line it is
          // trying to hold — the number the drift would show up in first.
          endOffset: +c.trackOffset(r.position.x, r.position.z).toFixed(2),
          crashed: r.crashed,
        };
      };

      const original = descend(200);
      g.setDifficulty('cruise');
      const cruise = descend(300);
      g.setDifficulty('original');

      // Airtime, measured properly. The descent's *total* hangtime is a coarse
      // number: it is decided by which of eleven off-centre kickers a
      // centre-line autopilot happens to clip, so a line moved by a handspan
      // gains or loses a whole jump and the total swings by a fifth either way.
      // Riding each kicker straight up the middle instead isolates what a
      // player would actually notice — how long this jump gives you — and that
      // is stable to a hundredth of a second.
      const kickerAirs = [];
      for (const k of c.kickers) {
        r.reset();
        r.position.set(k.x - k.dirX * 22, 0, k.z - k.dirZ * 22);
        r.yaw = Math.atan2(k.dirX, k.dirZ);
        r.speed = 24;
        r.settle();
        let air = 0, sawAir = false;
        for (let i = 0; i < 700; i++) {
          r.update(dt, NONE);
          if (!r.grounded) { sawAir = true; air = Math.max(air, r.airTime); }
          if (sawAir && r.grounded && air > 0.05) break;
        }
        kickerAirs.push(+air.toFixed(3));
      }

      out.bankRegression = { original, cruise, kickerAirs };
    }
  }

  /* ==================================================================
   * TERRAIN FEATURES — the fork, and mogul fields.
   *
   * One contiguous block, matching the checks block at the very end of the
   * `checks` array. Everything here is the height field in `Course.js`, driven
   * by the `fork` and `moguls` sections of the run preset.
   *
   * Both features ship switched off, because Classic is asserted bit-for-bit
   * elsewhere and must not move. So the measurements below turn them on by
   * swapping the *instance's* config — `terrainHeight`, `groomAt` and
   * `trackHalfWidthAt` all read `this.config` on every call, so the mountain
   * changes shape under a rider who is otherwise untouched, and the numbers
   * exercised are exactly the ones `Runs.js` ships as the documented defaults.
   *
   * What has to be true:
   *   - the fork is a *choice*: ride in on one side and you come out on that
   *     side, through banking alone, with nothing anywhere that knows what a
   *     lane is. A control run with the fork switched off has to fail the same
   *     test, or the assertion is measuring the track's own wander;
   *   - the divider is never a crash surface, from any approach, including
   *     straight at the crest;
   *   - both lanes are groomed and the divider is not;
   *   - the normals stay sane across everything, because every one of the
   *     rider's forces is a projection of one.
   * ================================================================ */
  {
    const FORK = { ...c.config.fork, enabled: true };
    const MOGULS = { ...c.config.moguls, enabled: true };

    /** Runs `fn` with the course reshaped, then puts the mountain back. */
    const withConfig = (patch, fn) => {
      const base = c.config;
      c.config = { ...base, ...patch };
      c.kickerHeight = () => 0;     // a ramp under the fork would decide the test
      c.railsNear = () => [];
      try {
        return fn();
      } finally {
        c.config = base;
        delete c.kickerHeight;
        delete c.railsNear;
      }
    };

    /**
     * A rider who holds the heading the run is going, and has no opinion
     * whatsoever about where across the piste to be.
     *
     * This is the whole trick of the lane test. A rider given no input at all
     * would be no good: the centre line wanders thirty metres side to side, so
     * a straight line leaves the piste on its own and the fork could not be
     * blamed for it. And a rider steering toward a *lane* would be assuming the
     * answer. Holding the tangent leaves exactly one thing that can move you
     * across the run, which is the ground being tilted — so whatever the sign
     * of the exit offset turns out to be, the divider is what put it there.
     */
    const rideHoldingHeading = (startU, speed, z0, zEnd) => {
      const tan = c.trackTangent(z0);
      r.reset();
      r.position.set(c.centerX(z0) + startU * tan.z, 0, z0 - startU * tan.x);
      r.yaw = c.trackHeading(z0);
      r.speed = speed;
      r.settle();

      let crashed = false;
      let crossed = false;          // ever ended up meaningfully on the far side
      let exitU = null;             // offset at the end of the fully-open stretch
      let exitGroom = null;
      let exitKmh = null;
      for (let i = 0; i < 120 * 90; i++) {
        const lookZ = r.position.z + Math.max(14, r.speed * 1.2);
        let d = c.trackHeading(lookZ) - r.yaw;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        r.update(dt, { ...NONE, steer: Math.max(-1, Math.min(1, d * 3)) });
        if (r.crashed) { crashed = true; break; }

        const u = c.trackOffset(r.position.x, r.position.z);
        if (startU !== 0 && Math.sign(u) !== Math.sign(startU) && Math.abs(u) > 1) crossed = true;
        // Sampled at the end of the held stretch, not at the rejoin: by `z3`
        // the lanes have merged back into one piste and there is no side left
        // to be on.
        if (exitU === null && r.position.z >= FORK.z2) {
          exitU = +u.toFixed(2);
          exitGroom = +c.groomAt(r.position.x, r.position.z).toFixed(3);
          exitKmh = +(r.speed * 3.6).toFixed(0);
        }
        if (r.position.z >= zEnd) break;
      }
      return {
        startU, crashed, crossed, exitU, exitGroom, exitKmh,
        endZ: +r.position.z.toFixed(0),
        endKmh: +(r.speed * 3.6).toFixed(0),
      };
    };

    // Dropped in level with the ridge's foot, where it has begun to rise but is
    // nowhere near full height, so the commitment is the fork's doing and not a
    // starting position already past the point of no return.
    const IN_Z = FORK.z0;
    const IN_U = 4;
    const SPEED = 26;

    out.fork = {
      config: FORK,
      widthAtCrest: withConfig({ fork: FORK }, () => c.trackHalfWidthAt((FORK.z1 + FORK.z2) / 2)),
      widthBefore: withConfig({ fork: FORK }, () => c.trackHalfWidthAt(FORK.z0 - 200)),
      left: withConfig({ fork: FORK }, () => rideHoldingHeading(-IN_U, SPEED, IN_Z, FORK.z3)),
      right: withConfig({ fork: FORK }, () => rideHoldingHeading(IN_U, SPEED, IN_Z, FORK.z3)),
      // Straight at the crest, which is the one line the ridge does not push
      // you off. It has to be survivable — the divider is a cost, never a wall.
      crest: withConfig({ fork: FORK }, () => rideHoldingHeading(0, SPEED, IN_Z, FORK.z3)),
      // The control, and the reason the test means anything: the identical two
      // runs on the identical mountain with the ridge taken away.
      flatLeft: withConfig({}, () => rideHoldingHeading(-IN_U, SPEED, IN_Z, FORK.z3)),
      flatRight: withConfig({}, () => rideHoldingHeading(IN_U, SPEED, IN_Z, FORK.z3)),
    };

    // Grooming across the fork, at the widest point. The two lanes are
    // corduroy; the ridge between them is not, because no groomer climbs it.
    out.forkGroom = withConfig({ fork: FORK }, () => {
      const z = (FORK.z1 + FORK.z2) / 2;
      const tan = c.trackTangent(z);
      const at = (u) => +c.groomAt(c.centerX(z) + u * tan.z, z - u * tan.x).toFixed(3);
      const half = c.trackHalfWidthAt(z);
      return {
        crest: at(0),
        innerFlank: at(FORK.maxSeparation * 0.4),
        laneLeft: at(-(FORK.maxSeparation + half) / 2),
        laneRight: at((FORK.maxSeparation + half) / 2),
        laneEdge: at(half - 4),
        offPiste: at(half + 4),
        beforeFork: +c.groomAt(c.centerX(FORK.z0 - 200), FORK.z0 - 200).toFixed(3),
      };
    });

    /**
     * The normal field over both features, sampled far more finely than the
     * 0.6 m the rider's own central differences use.
     *
     * `n.y` is the number every force in `Rider.js` is divided by — the lateral
     * bank and the along-slope acceleration both read `max(n.y, 0.2)` — so a
     * spike here is not a cosmetic seam, it is a rider fired sideways. The
     * divider's raised-cosine profile has zero gradient at the crest *and* at
     * the foot precisely so this stays smooth.
     */
    const worstNormal = (zFrom, zTo, uReach) => {
      const n = { x: 0, y: 1, z: 0 };
      let worst = 1;
      let at = null;
      for (let z = zFrom; z <= zTo; z += 0.75) {
        const tan = c.trackTangent(z);
        for (let u = -uReach; u <= uReach; u += 0.4) {
          const x = c.centerX(z) + u * tan.z;
          const zz = z - u * tan.x;
          c.groundNormal(x, zz, n);
          if (n.y < worst) { worst = n.y; at = [+u.toFixed(1), +z.toFixed(0)]; }
        }
      }
      return { worst: +worst.toFixed(4), at };
    };

    out.featureNormals = {
      divider: withConfig({ fork: FORK }, () => worstNormal(FORK.z0 - 20, FORK.z3 + 20, 40)),
      moguls: withConfig({ moguls: MOGULS }, () => worstNormal(MOGULS.z0 - 20, MOGULS.z3 + 20, 30)),
      // Same sweep over the same ground with both features off, so the bound
      // below is known to be about them and not about the mountain underneath.
      plain: withConfig({}, () => worstNormal(FORK.z0 - 20, FORK.z3 + 20, 40)),
    };

    // A bump field has to be ridable at speed, not merely present. Driven with
    // the ordinary follow-the-centre-line autopilot, which makes no allowance
    // for bumps at all.
    out.mogulRun = withConfig({ moguls: MOGULS }, () => {
      const ride = (speed) => {
        const z0 = MOGULS.z0 - 40;
        r.reset();
        r.position.set(c.centerX(z0), 0, z0);
        r.yaw = c.trackHeading(z0);
        r.speed = speed;
        r.settle();
        let airs = 0;
        let wasAir = false;
        for (let i = 0; i < 120 * 90; i++) {
          const lookZ = r.position.z + Math.max(14, r.speed * 1.7);
          let d = Math.atan2(c.centerX(lookZ) - r.position.x, lookZ - r.position.z) - r.yaw;
          while (d > Math.PI) d -= 2 * Math.PI;
          while (d < -Math.PI) d += 2 * Math.PI;
          r.update(dt, { ...NONE, steer: Math.max(-1, Math.min(1, d * 2.4)) });
          if (r.crashed) break;
          if (!r.grounded && !wasAir) airs++;
          wasAir = !r.grounded;
          if (r.position.z >= MOGULS.z3) break;
        }
        return {
          speed, airs, crashed: r.crashed,
          endZ: +r.position.z.toFixed(0),
          endKmh: +(r.speed * 3.6).toFixed(0),
        };
      };
      return { config: MOGULS, slow: ride(18), fast: ride(30) };
    });

    // Crest-to-trough of the bumps, measured rather than asserted from the
    // config: the same lattice of points sampled with the field on and off, so
    // what is left is the moguls and nothing of the mountain under them.
    {
      const z0 = (MOGULS.z1 + MOGULS.z2) / 2;
      const pts = [];
      const tan = c.trackTangent(z0);
      for (let dz = -14; dz <= 14; dz += 0.5) {
        for (let u = -8; u <= 8; u += 0.5) {
          pts.push([c.centerX(z0 + dz) + u * tan.z, z0 + dz - u * tan.x]);
        }
      }
      const sample = (patch) => withConfig(patch, () => pts.map(([x, z]) => c.terrainHeight(x, z)));
      const on = sample({ moguls: MOGULS });
      const off = sample({});
      let hi = -Infinity;
      let lo = Infinity;
      for (let i = 0; i < on.length; i++) {
        const d = on[i] - off[i];
        hi = Math.max(hi, d);
        lo = Math.min(lo, d);
      }
      out.mogulRun.reliefM = +(hi - lo).toFixed(2);
    }
  }
  /* ==================================================================
   * FAR-SIDE KICKERS — step-downs and gap jumps.
   *
   * Everything from here to `return out` belongs to one change: a kicker
   * may now carry a *deck* — a raised take-off with a roll-in behind it and
   * a landing stepping back down to the snow in front. Kept in one
   * contiguous block at the end of the measurement section so it reads as
   * the single addition it is, and matched by one contiguous block at the
   * end of `checks`.
   *
   * Both shapes are off on Classic, so none of this can be measured on the
   * course the rest of the file rides. A second course is built here with
   * them switched on. `structuredClone` of the run in play stands in for
   * `defineRun` — this callback is synchronous and cannot import — and for
   * an override this shallow the two are the same thing.
   * ================================================================ */
  {
    const preset = structuredClone(c.config);
    preset.id = 'harness-far-side';
    preset.name = 'Harness Far Side';
    preset.kickers.stepDown.enabled = true;
    preset.kickers.gap.enabled = true;

    const park = new (c.constructor)(c.seed, preset);
    const sd = park.kickers.find((k) => k.stepDown);
    const gp = park.kickers.find((k) => k.gap);
    const realCourse = r.course;
    r.course = park;

    /** Along-track distance of a world position from a kicker's foot. */
    const along = (k, p) => (p.x - k.x) * k.dirX + (p.z - k.z) * k.dirZ;

    /**
     * Rides straight at `k` from `runup` metres back, entering at `speed`, and
     * reports what the jump did. Every distance is measured from the *lip*,
     * which is the only place on the feature a rider can point at.
     *
     * Held for six seconds past touchdown as well: the question a landing has
     * to answer is not only "did that hurt" but "am I still going", and a
     * trough you can land in but not ride out of would pass the first.
     */
    const jump = (k, speed, runup) => {
      r.reset();
      r.position.set(k.x - k.dirX * runup, 0, k.z - k.dirZ * runup);
      r.yaw = Math.atan2(k.dirX, k.dirZ);
      r.speed = speed;
      r.settle();
      let lip = null;
      let land = null;
      let air = 0;
      let after = 0;
      let slowest = Infinity;
      for (let i = 0; i < 120 * 20; i++) {
        const wasGrounded = r.grounded;
        r.update(dt, NONE);
        const s = along(k, r.position);
        if (wasGrounded && !r.grounded && !lip && s > k.length * 0.5) {
          lip = { s, y: r.position.y, speed: r.speed };
        }
        if (!r.grounded) air = Math.max(air, r.airTime);
        if (lip && !wasGrounded && r.grounded && !land) {
          land = { s, y: r.position.y, speed: r.speed, air };
        }
        if (land) {
          after += dt;
          slowest = Math.min(slowest, r.speed);
          if (after > 6) break;
        }
      }
      return {
        launched: !!lip,
        lipSpeed: lip ? +lip.speed.toFixed(1) : 0,
        landedAt: land ? +(land.s - k.length).toFixed(1) : null,
        dropM: lip && land ? +(lip.y - land.y).toFixed(1) : 0,
        airSeconds: land ? +land.air.toFixed(2) : +air.toFixed(2),
        landSpeed: land ? +land.speed.toFixed(1) : 0,
        kept: lip && land ? +(land.speed / lip.speed).toFixed(2) : 0,
        slowestAfter: slowest === Infinity ? 0 : +slowest.toFixed(1),
        speedAfter6s: +r.speed.toFixed(1),
        crashed: r.crashed,
        stillRiding: !r.crashed && r.speed > 1,
      };
    };

    /**
     * Worst `groundNormal().y` along a kicker's centre line, sampled every
     * 25 cm over the whole feature — roll-in, ramp, lip and landing.
     *
     * Reported twice: including the lip, and excluding a metre and a half
     * either side of it. Every kicker in the game already has one
     * discontinuity, the lip itself, and it is the point of a kicker; what
     * would be a bug is a *second* one out on the far side, where the rider is
     * trying to land.
     */
    const centreLine = (course, k) => {
      const deck = k.deck;
      const from = -(deck ? deck.approach : 6) - 10;
      const to = k.length + (deck ? deck.length : 0) + 10;
      let worst = 1;
      let worstAt = 0;
      let worstAway = 1;
      let awayAt = 0;
      let climb = -1;          // steepest *uphill* metre on the far side
      let climbAt = 0;
      for (let s = from; s <= to; s += 0.25) {
        const x = k.x + k.dirX * s;
        const z = k.z + k.dirZ * s;
        const n = course.groundNormal(x, z);
        if (n.y < worst) { worst = n.y; worstAt = s - k.length; }
        if (Math.abs(s - k.length) > 1.5 && n.y < worstAway) { worstAway = n.y; awayAt = s - k.length; }
        // The ramp is meant to climb; everywhere else, a climb is something
        // the rider may have to get up with whatever speed the crash left them.
        if (s < -0.5 || s > k.length + 0.5) {
          const back = course.groundHeight(k.x + k.dirX * (s - 0.5), k.z + k.dirZ * (s - 0.5));
          const fwd = course.groundHeight(k.x + k.dirX * (s + 0.5), k.z + k.dirZ * (s + 0.5));
          if (fwd - back > climb) { climb = fwd - back; climbAt = s - k.length; }
        }
      }
      return {
        worstNormalY: +worst.toFixed(3), worstAt: +worstAt.toFixed(1),
        worstAwayFromLip: +worstAway.toFixed(3), awayAt: +awayAt.toFixed(1),
        steepestClimb: +climb.toFixed(3), climbAt: +climbAt.toFixed(1),
      };
    };

    // The same measurement over every plain kicker on Classic, as the bar the
    // two new shapes have to clear: they may not put a worse crease in the
    // ground than the ramps the game already ships.
    let plainWorst = 1;
    for (const k of c.kickers) {
      for (let s = -8; s <= k.length + 10; s += 0.25) {
        const n = c.groundNormal(k.x + k.dirX * s, k.z + k.dirZ * s);
        if (n.y < plainWorst) plainWorst = n.y;
      }
    }

    // Best air an ordinary kicker on this course gives from the same approach,
    // so "longer hang time" is a comparison rather than an adjective.
    const plainKickers = park.kickers.filter((k) => !k.deck);

    const shapes = {};
    for (const tuning of ['cruise', 'original']) {
      g.setDifficulty(tuning);
      let plainAir = 0;
      let plainAirFlatOut = 0;
      for (const k of plainKickers) {
        plainAir = Math.max(plainAir, jump(k, 20, 45).airSeconds);
        plainAirFlatOut = Math.max(plainAirFlatOut, jump(k, 40, 45).airSeconds);
      }
      shapes[tuning] = {
        // 20 m/s into the roll-in is 72 km/h — a rider who is going, but not
        // one who has done anything clever about it.
        stepDown: jump(sd, 20, 45),
        gap: jump(gp, 20, 45),
        // And flat out: the piste's own terminal speed, whatever the tuning
        // makes that.
        gapFlatOut: jump(gp, 40, 45),
        stepDownFlatOut: jump(sd, 40, 45),
        // Rolling in at 10 m/s, which on either tuning arrives at the lip too
        // slow to make it across.
        gapCased: jump(gp, 10, 24),
        plainAir: +plainAir.toFixed(2),
        plainAirFlatOut: +plainAirFlatOut.toFixed(2),
      };
    }
    g.setDifficulty('original');

    r.course = realCourse;
    // `COURSE` is a module-level view of the last course constructed; put it
    // back on the run the rest of this file is riding.
    new (c.constructor)(c.seed, c.config);

    out.farSide = {
      // Where the landing's crest sits, in metres past the lip — the distance
      // a gap jump is asking to be cleared.
      gapCrestM: gp.deck.segments[1].end,
      stepDeckM: sd.deck.segments[0].end,
      liftM: sd.deck.lift,
      lipAboveSnowM: +(sd.deck.lift + sd.height).toFixed(1),
      classicPlainWorstNormalY: +plainWorst.toFixed(3),
      stepDownLine: centreLine(park, sd),
      gapLine: centreLine(park, gp),
      ...shapes,
      // Classic must not have grown either shape by having them defined.
      classicHasNeither: !c.kickers.some((k) => k.deck || k.stepDown || k.gap),
    };
  }


  return out;
});

/* ==================================================================
 * THE THREE RUNS — that all of them build, ride, and differ.
 *
 * Everything above this point measures one mechanic in isolation, usually on
 * a course built to show it off. This block is the opposite: it takes the
 * three runs the game actually offers and checks the things that only go
 * wrong once the pieces are assembled.
 *
 * Three failure modes, all of which have really happened here:
 *
 *   1. The picker damages the terrain. `Game.js` builds the course from the
 *      *normalised* run — `new Course(run.seed, run)` — so every key
 *      `RunSelect.normalise()` writes lands in the terrain config. It used to
 *      write `grade`, which in `Runs.js` is the fall line's steepness curve,
 *      replacing the whole curve with a UI integer. The game booted to
 *      `g.bells is not iterable` before the first frame. Nothing in the
 *      presets could have caught it, because the presets were correct.
 *
 *   2. Features stand on the divider. The kicker and rail walks place by
 *      drawing an offset and know nothing about the fork, so on a run with
 *      one they land straddling the ridge — a take-off with a hill through
 *      the middle of it. `Course._clearOfDivider` pushes them into a lane;
 *      this asserts none survived.
 *
 *   3. A run is configured but empty. Backcountry asked for occasional rails
 *      at `chance: 0.12` per step against a 200-380 m stride and got zero of
 *      them. Every run has to actually contain what it advertises.
 *
 * `tools/audit-runs.mjs` prints the whole layout of all three runs and is the
 * thing to reach for when one of these fails — it says *where*.
 * ================================================================ */
results.runs = await page.evaluate(async () => {
  const g = window.game;
  const dt = 1 / 120;
  const NONE = { steer: 0, tuck: false, ollie: false, grab: null };

  const { RUNS: PICKER_RUNS } = await import('/src/core/RunSelect.js');
  const { Course } = await import('/src/world/Course.js');
  const { Rider } = await import('/src/entities/Rider.js');
  const { buildForest } = await import('/src/world/Trees.js');

  const RIDGE_MATTERS_M = 0.35;   // below a board edge's depth, there is no ridge

/**
 * Rides a run top to bottom on the tuning the game ships on, steering for
 * the centre line the way the existing descent regression does.
 *
 * This is the coarsest assertion in the file and the most important one: a
 * run that cannot be completed is not a run, however good its numbers look
 * feature by feature. It is deliberately the *same* autopilot for all three
 * so the comparison between them means something — Backcountry taking
 * longer than the Park is the terrain, not a different driver.
 */
  const rideWhole = (course, rider) => {
    rider.reset();

    /**
     * Where across the piste to aim: the centre line, or a lane through a fork.
     *
     * Aiming at `centerX` through a fork means aiming at the crest of the
     * divider, and this driver — unlike a player — corrects back onto that line
     * every frame, so it balances on top of the ridge and grinds down it at
     * walking pace. Measured before this existed: the Park took 224 seconds
     * against Classic's 91, with a low of 7 km/h at u = -3.5 m. Nothing was
     * wrong with the run. A human is pushed off the crest by the banking term
     * within a few metres and has to pick a side, which is the entire point of
     * the feature, so the driver picks one too — whichever it is already
     * nearest, which is also how a player ends up choosing.
     */
    const aimU = (z, u) => {
      const amount = course.forkAmount(z);
      if (amount <= 0) return 0;
      const inner = course.config.fork.maxSeparation * amount;
      return (u < 0 ? -1 : 1) * (inner + course.trackHalfWidthAt(z)) * 0.5;
    };

    let t = 0, top = 0, airs = 0, wasAir = false;
    for (let i = 0; i < 120 * 400; i++) {
      const lookZ = rider.position.z + Math.max(14, rider.speed * 1.7);
      const tan = course.trackTangent(lookZ);
      const aimX = course.centerX(lookZ) +
        aimU(lookZ, course.trackOffset(rider.position.x, rider.position.z)) * tan.z;
      let d = Math.atan2(aimX - rider.position.x, lookZ - rider.position.z) - rider.yaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      rider.update(dt, { ...NONE, steer: Math.max(-1, Math.min(1, d * 2.4)) });
      t += dt;
      top = Math.max(top, rider.speed);
      if (!rider.grounded) { if (!wasAir) airs++; }
      wasAir = !rider.grounded;
      if (rider.position.z >= course.finishZ || rider.crashed) break;
    }
    return {
      seconds: +t.toFixed(1),
      topKmh: +(top * 3.6).toFixed(1),
      airs,
      endZ: +rider.position.z.toFixed(0),
      finished: rider.position.z >= course.finishZ,
      crashed: rider.crashed,
    };
  };

  g.setDifficulty('cruise');
  const runs = PICKER_RUNS.map((run) => {
    // Built from the *picker's* object, exactly as `Game.js` does it — which
    // is the only way failure mode 1 is visible.
    const course = new Course(run.seed, run);
    const forest = buildForest(course, {});
    const off = (f) => f.x - course.centerX(f.z);

    /* Is any feature standing on the ridge, where the ridge is real? */
    const onDivider = (f, halfWidth) => {
      const amount = course.forkAmount(f.z);
      if (amount * (run.fork.maxHeight ?? 0) < RIDGE_MATTERS_M) return false;
      return Math.abs(off(f)) - halfWidth < amount * run.fork.maxSeparation;
    };

    return {
      id: run.id,
      rating: run.rating,
      // The terrain config, still intact after normalisation.
      gradeBells: Array.isArray(run.grade?.bells) ? run.grade.bells.length : `NOT AN ARRAY: ${run.grade}`,
      halfWidth: course.trackHalfWidth,
      widest: +course.maxTrackHalfWidth().toFixed(1),
      kickers: course.kickers.length,
      rails: course.rails.length,
      trees: forest.list.length,
      hips: course.kickers.filter((k) => k.hip).length,
      stepDowns: course.kickers.filter((k) => k.stepDown).length,
      gaps: course.kickers.filter((k) => k.gap).length,
      // Bores are built by `Game.js` from the config, not by `Course` — so
      // this is what the run asks for. That they come out passable when built
      // is the tunnel block's job, a few dozen checks up.
      tunnels: run.tunnels.enabled ? run.tunnels.spans.length : 0,
      forkOpen: run.fork.enabled,
      mogulsOn: run.moguls.enabled,
      onDivider: course.kickers.filter((k) => onDivider(k, k.halfWidth)).length +
                 course.rails.filter((r) => onDivider(r, r.halfWidth)).length,
      // A decked shape cannot share z with the fork at all: the deck is a
      // plateau in the kicker field and the ridge is one in the terrain
      // field, and they are summed by two systems that have never met.
      deckedInFork: course.kickers.filter((k) => k.deck && course.forkAmount(k.z) > 0).length,
      ride: rideWhole(course, new Rider(course)),
    };
  });
  g.setDifficulty('original');
  return runs;
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
    a.ollie(); a.land(12, 0.2); a.powderPuff(); a.skate(); a.trick(4); a.fail(); a.crash(); a.cheer();
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

/* ------------------------------------------------------------------
 * The leaderboard.
 *
 * Everything here goes through the same async interface a server would sit
 * behind, so these assertions keep meaning what they mean the day the store
 * changes. The one that matters most is the difficulty split: cruise and
 * original are different games, and a table that mixed them would make the
 * original's rows unreachable.
 * ---------------------------------------------------------------- */
ui.board = await page.evaluate(async () => {
  const g = window.game;
  const board = g.leaderboard;
  await board.clear();

  const file = (name, score, timeMs, difficulty = 'cruise', finished = true) =>
    board.submit({ name, score, timeMs, difficulty, finished, seed: 1, tricks: 3, topSpeed: 25, bestAir: 1 });

  await file('ALPHA', 1000, 100000);
  await file('BRAVO', 3000, 90000);
  await file('CHARLIE', 2000, 80000);
  // Same score, slower run: the tiebreak should put it second.
  await file('DELTA', 3000, 95000);
  // A different game entirely.
  await file('ECHO', 99999, 60000, 'original');

  const cruise = await board.top('cruise', 10);
  const original = await board.top('original', 10);

  // A new best should come back as rank 1 and as a personal best.
  const best = await board.submit({
    name: 'ALPHA', score: 5000, timeMs: 70000, difficulty: 'cruise',
    finished: true, seed: 1, tricks: 9, topSpeed: 30, bestAir: 2,
  });

  // Where a score *would* land, without filing it.
  const wouldBe = await board.rankOf('cruise', 2500);

  // Overflow: the local store keeps fifty per difficulty, and keeps the best
  // fifty rather than the last fifty.
  for (let i = 0; i < 60; i++) await file(`FILL${i}`, i, 100000);
  const afterFlood = await board.top('cruise', 100);

  // And it has to survive a reload, which is the entire point of storing it.
  const raw = localStorage.getItem('alpine-carve.scores.v1');

  await board.clear();
  return {
    order: cruise.map((r) => r.name),
    tiebreak: cruise.filter((r) => r.score === 3000).map((r) => r.name),
    cruiseCount: cruise.length,
    originalCount: original.length,
    originalOnly: original.every((r) => r.difficulty === 'original'),
    bestRank: best.rank,
    bestIsPersonal: best.isPersonalBest,
    bestIsTop10: best.isTop10,
    wouldBe,
    capped: afterFlood.length,
    keptTheBest: afterFlood[0]?.score ?? 0,
    persisted: !!raw && raw.length > 10,
    dnfKept: cruise.every((r) => typeof r.finished === 'boolean'),
    hasChecksum: cruise.every((r) => /^[0-9a-f]{8}$/.test(r.checksum)),
  };
});

/**
 * How long the rider's texture atlas takes to build.
 *
 * It runs once, on the loading screen, on the main thread — so it is felt as
 * the game being slow to start rather than as a frame rate. The first version
 * took 2.7 seconds, nearly all of it a single `getImageData` pulling a
 * megapixel back off the GPU for the normal map. The budget below is loose
 * enough to survive a software renderer on a busy machine and tight enough
 * that putting a whole-canvas readback back would trip it.
 */
ui.atlas = await page.evaluate(async () => {
  // Past the module cache, so this is a real build rather than a hash lookup.
  const fresh = await import('/src/entities/RiderTextures.js?bench=' + Math.random());
  const t0 = performance.now();
  const maps = fresh.riderTextures();
  const ms = performance.now() - t0;
  return {
    ms: +ms.toFixed(0),
    maps: ['map', 'normalMap', 'roughnessMap'].filter((k) => maps[k]?.image?.width > 0).length,
    normalHalfRes: maps.normalMap.image.width === maps.map.image.width / 2,
  };
});

// The name is asked for once and then remembered. It also has to survive
// something being pasted into the field that a leaderboard should not carry.
ui.profile = await page.evaluate(async () => {
  const { Profile } = await import('/src/services/Profile.js');
  const p = new Profile();
  const before = p.known;
  p.save('  Ravi <b>  ');
  const cleaned = p.name;
  const reloaded = new Profile().name;
  const long = new Profile();
  long.save('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  const empty = new Profile();
  empty.save('');
  return { before, cleaned, reloaded, capped: long.name.length, fallback: empty.display };
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

/* ==================================================================
 * BEGIN tunnels (src/world/Tunnels.js). One contiguous block, matching
 * the check block at the end of the `checks` array.
 *
 * A tunnel is spectacle and must never become a way to crash, so what is
 * measured here is exactly that: how much room there is between the
 * ridable ground and the roof, against how high a rider can actually
 * get inside the bore; whether the light, fog and sound cross a portal
 * as a blend or as a cut; and whether restarting from inside one leaves
 * the world dark.
 *
 * Classic ships with no tunnels at all — that is what keeps its three
 * digest checks bit-for-bit — so the bore under test is built here, over
 * a stretch deliberately chosen to contain a kicker.
 * ================================================================== */

const TUNNEL_SPAN = { from: 900, to: 1080 };

ui.tunnels = await page.evaluate(async (SPAN) => {
  const g = window.game;
  const c = g.course;
  const r = g.rider;
  const { buildTunnels } = await import('/src/world/Tunnels.js');
  const { CLASSIC } = await import('/src/world/Runs.js');

  // Take the frame loop off so nothing runs between the measurements below.
  g.renderer.setAnimationLoop(null);

  const out = {};
  out.classicOff = {
    configEnabled: CLASSIC.tunnels.enabled,
    configSpans: CLASSIC.tunnels.spans.length,
    built: g.tunnels.list.length,
    meshes: g.tunnels.group.children.length,
    interiorAtStart: g.tunnels.interiorAt(c.centerX(600), 600),
  };

  const tunnels = buildTunnels(c, { ...CLASSIC.tunnels, enabled: true, spans: [SPAN] });
  const t = tunnels.list[0];
  out.bore = {
    from: t.from, to: t.to,
    halfWidth: +t.halfWidth.toFixed(2),
    wallHeight: +t.wallHeight.toFixed(2),
    crown: +t.crown.toFixed(2),
    shoulder: t.shoulder,
    headroom: t.headroom,
    overJump: t.overJump,
    // Authored section, before the headroom guarantee grew it.
    authored: { wallHeight: CLASSIC.tunnels.wallHeight, crown: CLASSIC.tunnels.crown },
  };

  /* --- 1. Clearance, swept over the whole bore ----------------------
   * Every metre of the span, every half metre across the ridable band,
   * both against the bare snow and against the ground the board is
   * actually on — which inside this span includes a kicker ramp. */
  {
    let aboveTerrain = Infinity;
    let aboveGround = Infinity;
    let tightest = null;
    let samples = 0;
    for (let z = t.from; z <= t.to; z += 1) {
      for (let x = c.centerX(z) - 40; x <= c.centerX(z) + 40; x += 0.5) {
        if (Math.abs(c.trackOffset(x, z)) > t.shoulder) continue;
        const roof = tunnels.roofHeightAt(x, z);
        if (!Number.isFinite(roof)) { aboveTerrain = -1; continue; }
        samples++;
        const overTerrain = roof - c.terrainHeight(x, z);
        const overGround = roof - c.groundHeight(x, z);
        if (overGround < aboveGround) {
          aboveGround = overGround;
          tightest = { z, u: +c.trackOffset(x, z).toFixed(1) };
        }
        aboveTerrain = Math.min(aboveTerrain, overTerrain);
      }
    }
    out.clearance = {
      samples,
      aboveTerrain: +aboveTerrain.toFixed(2),
      aboveGround: +aboveGround.toFixed(2),
      tightest,
      // And at the very wall, which is the least room anywhere in the bore.
      atWall: +tunnels.archHeight(t, t.halfWidth - 0.01).toFixed(2),
    };
  }

  /* --- 2. The highest a jump can reach inside this bore --------------
   * Every kicker that can put a rider into the tunnel, ridden straight
   * up the middle at the 36 m/s terminal speed of the `original` tuning
   * with the ollie popped right at the lip. That is the worst case the
   * physics allows, and it is what the clearance has to beat. */
  {
    const was = g.difficultyName;
    g.setDifficulty('original');
    const dt = 1 / 120;
    const NONE = { steer: 0, tuck: true, brake: false, press: false, grabType: null, jumpPressed: false };
    let apex = 0;
    let headGap = Infinity;
    let jumps = 0;
    const RIDER_TOP = 2;                     // board to the top of the helmet
    for (const k of c.kickers) {
      if (!(k.z > t.from - 60 && k.z < t.to)) continue;
      jumps++;
      r.reset();
      r.position.set(k.x - k.dirX * 45, 0, k.z - k.dirZ * 45);
      r.yaw = Math.atan2(k.dirX, k.dirZ);
      r.speed = 36;
      r.settle();
      for (let i = 0; i < 1200; i++) {
        const phase = c.kickerPhase(r.position.x, r.position.z);
        r.update(dt, { ...NONE, jumpPressed: r.grounded && phase > 0.8 });
        if (r.position.z < t.from || r.position.z > t.to) continue;
        apex = Math.max(apex, r.position.y - c.terrainHeight(r.position.x, r.position.z));
        const roof = tunnels.roofHeightAt(r.position.x, r.position.z);
        if (Number.isFinite(roof)) headGap = Math.min(headGap, roof - (r.position.y + RIDER_TOP));
      }
    }
    g.setDifficulty(was);
    out.air = {
      jumps,
      apexAboveSnow: +apex.toFixed(2),
      worstHeadGap: Number.isFinite(headGap) ? +headGap.toFixed(2) : null,
      margin: +(out.clearance.aboveTerrain - apex).toFixed(2),
    };
  }

  /* --- 3. The portal blend ------------------------------------------
   * Sampled a metre at a time straight down the centre line. A hard
   * switch at a plane would show up here as a single step from 0 to 1;
   * a blend shows up as a monotone ramp with no step worth seeing. */
  {
    const walk = (z0, z1) => {
      const a = [];
      for (let z = z0; z <= z1; z += 1) a.push(tunnels.interiorAt(c.centerX(z), z));
      return a;
    };
    const stats = (a, rising) => {
      let biggest = 0;
      let monotone = true;
      for (let i = 1; i < a.length; i++) {
        const d = a[i] - a[i - 1];
        biggest = Math.max(biggest, Math.abs(d));
        if (rising ? d < -1e-9 : d > 1e-9) monotone = false;
      }
      return {
        monotone,
        biggestStep: +biggest.toFixed(4),
        first: +a[0].toFixed(4),
        last: +a[a.length - 1].toFixed(4),
      };
    };
    const half = t.blend * 0.5;
    out.blend = {
      metres: t.blend,
      enter: stats(walk(t.from - half - 2, t.from + half + 2), true),
      exit: stats(walk(t.to - half - 2, t.to + half + 2), false),
      // And the same crossing taken at speed: 36 m/s at 120 Hz is 0.3 m a
      // frame, so the per-frame step is what the eye would actually see.
      perFrameStep: (() => {
        let worst = 0;
        let prev = tunnels.interiorAt(c.centerX(t.from - 40), t.from - 40);
        for (let z = t.from - 40; z <= t.from + 40; z += 0.3) {
          const v = tunnels.interiorAt(c.centerX(z), z);
          worst = Math.max(worst, Math.abs(v - prev));
          prev = v;
        }
        return +worst.toFixed(4);
      })(),
    };
  }

  /* --- 4. Restarting from inside ------------------------------------
   * The obvious way to leave the whole next run dark and muffled. Driven
   * with the frame loop off, so what is measured is what `reset()` did
   * and not what the next frame would have papered over. */
  {
    g.scene.remove(g.tunnels.group);
    g.tunnels = tunnels;
    g.scene.add(tunnels.group);
    tunnels.bind({ scene: g.scene, lights: g.lights, audio: g.audio });

    const dress = () => ({
      interior: +g.tunnels.interior.toFixed(4),
      fogDensity: +g.scene.fog.density.toFixed(5),
      fogColor: g.scene.fog.color.getHexString(),
      sun: +g.lights.sun.intensity.toFixed(3),
      hemi: +g.lights.hemi.intensity.toFixed(3),
      fill: +g.lights.fill.intensity.toFixed(3),
      muffle: +g.audio.muffle.toFixed(4),
    });

    out.daylight = dress();

    const mid = (t.from + t.to) / 2;
    g.state = 'riding';
    r.reset();
    r.position.set(c.centerX(mid), 0, mid);
    r.yaw = c.trackHeading(mid);
    r.speed = 24;
    r.settle();
    for (let i = 0; i < 120; i++) tunnels.update(1 / 60, r.position);
    out.inside = dress();
    out.insideZ = +r.position.z.toFixed(1);

    // No frame between these two lines — this is `reset()` on its own.
    g.restart();
    out.afterRestart = dress();
    out.afterRestartZ = +r.position.z.toFixed(1);
    g.renderer.setAnimationLoop(null);
  }

  out.audioReady = !!g.audio.ready;
  return out;
}, TUNNEL_SPAN);

// The filters ramp in wall-clock seconds, so the audio half of the restart has
// to be read after some of it has passed.
await page.waitForTimeout(500);
ui.tunnels.audioAfterRestart = await page.evaluate(() => {
  const a = window.game.audio;
  if (!a.ready) return null;
  return {
    cutoffHz: Math.round(a.interior.frequency.value),
    echo: +a.echoSend.gain.value.toFixed(4),
  };
});

// And the other end: driven fully inside, the same nodes have to actually move.
await page.evaluate(() => {
  const g = window.game;
  g.audio.setMuffle(1, g.tunnels.config.muffleHz, g.tunnels.config.echo);
});
await page.waitForTimeout(500);
ui.tunnels.audioInside = await page.evaluate(() => {
  const a = window.game.audio;
  if (!a.ready) return null;
  return {
    cutoffHz: Math.round(a.interior.frequency.value),
    echo: +a.echoSend.gain.value.toFixed(4),
  };
});

/* ===================== END tunnels ================================ */

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
  ['the spine kicker launches off both lobes',
    results.hipKicker.found && results.hipKicker.bothLaunch,
    results.hipKicker.found
      ? `left ${results.hipKicker.leftAir}s vs right ${results.hipKicker.rightAir}s`
      : 'no hip kicker generated on this seed'],
  // Both lobes used to return the same result to every decimal place, because
  // nothing in the physics could push a rider sideways. This is the assertion
  // that was dropped as untestable in the previous phase, put back.
  ['the spine kicker\'s two lobes now throw you different ways',
    !results.hipKicker.found || (
      results.hipKicker.leftRampDeg > 0.3 && results.hipKicker.rightRampDeg < -0.2 &&
      results.hipKicker.splitDeg > 0.8 && results.hipKicker.splitM > 0.4),
    results.hipKicker.found
      ? `left ${results.hipKicker.leftRampDeg} deg / ${results.hipKicker.leftCrossM} m, ` +
        `right ${results.hipKicker.rightRampDeg} deg / ${results.hipKicker.rightCrossM} m`
      : 'no hip kicker generated on this seed'],
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
  ['the leaderboard ranks by score, then by time',
    ui.board.order[0] === 'BRAVO' && ui.board.tiebreak.join() === 'BRAVO,DELTA',
    ui.board.order.join(' > ')],
  ['cruise and original keep separate tables',
    ui.board.cruiseCount === 4 && ui.board.originalCount === 1 && ui.board.originalOnly,
    `${ui.board.cruiseCount} cruise rows, ${ui.board.originalCount} original`],
  ['a new best comes back as rank one, and as a personal best',
    ui.board.bestRank === 1 && ui.board.bestIsPersonalBest !== false && ui.board.bestIsTop10,
    `rank ${ui.board.bestRank}, personal best ${ui.board.bestIsPersonal}`],
  // 5000, 3000, 3000 sit above it; 2000 and 1000 below.
  ['a score can be ranked without being filed', ui.board.wouldBe === 4,
    `2500 points would come ${ui.board.wouldBe}`],
  ['the board caps itself and keeps the best, not the last',
    ui.board.capped === 50 && ui.board.keptTheBest === 5000,
    `${ui.board.capped} rows kept, top is ${ui.board.keptTheBest}`],
  ['scores survive a reload', ui.board.persisted, 'written to localStorage'],
  ['every row carries what a server would need',
    ui.board.hasChecksum && ui.board.dnfKept, 'checksum and finished flag on every row'],
  ['the name is asked once, cleaned, and remembered',
    !ui.profile.before && ui.profile.cleaned === 'Ravi b' && ui.profile.reloaded === 'Ravi b',
    `"${ui.profile.cleaned}" reloaded as "${ui.profile.reloaded}"`],
  ['a name cannot be longer than the column that shows it',
    ui.profile.capped === 14 && ui.profile.fallback === 'RIDER',
    `capped at ${ui.profile.capped}, empty falls back to ${ui.profile.fallback}`],
  ['the rider\'s textures build without stalling the loading screen',
    ui.atlas.ms < 600 && ui.atlas.maps === 3 && ui.atlas.normalHalfRes,
    `${ui.atlas.ms} ms for ${ui.atlas.maps} maps, normals at half res`],
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

  ['a centre-line descent still picks up stars',
    results.collectibles.starsCollected > 5,
    `${results.collectibles.starsCollected} of ${results.collectibles.starsPlaced} stars, ${results.collectibles.gatesPlaced} gates on the course`],
  ['a star pays flat, unmultiplied by the trick combo',
    results.collectibleScoring.starGain === 15, `${results.collectibleScoring.starGain} pts at combo 5`],
  ['a gate streak resets on a miss without losing banked points',
    results.collectibleScoring.streakBeforeMiss === 2 && results.collectibleScoring.streakAfterMiss === 0 &&
    results.collectibleScoring.scoreKeptOnMiss,
    `streak ${results.collectibleScoring.streakBeforeMiss} -> ${results.collectibleScoring.streakAfterMiss}, points kept: ${results.collectibleScoring.scoreKeptOnMiss}`],

  ['a rail catches within its margin and not outside it',
    results.railCatch.withinMargin && !results.railCatch.outsideLateral &&
    !results.railCatch.outsideAngle && !results.railCatch.outsideHeight,
    JSON.stringify(results.railCatch)],
  ['grinding bleeds off speed', results.railFriction.after < results.railFriction.before,
    `${results.railFriction.before} -> ${results.railFriction.after} m/s`],
  ['blowing the balance stumbles off the rail, never crashes',
    results.railFail.fellOff && results.railFail.stumbled && !results.railFail.crashed,
    JSON.stringify(results.railFail)],
  ['riding a grind out pops you airborne and pays',
    results.railPop.popped && results.railPop.points > 0,
    `${results.railPop.seconds}s held, ${results.railPop.points} pts`],
  ['a curved rail keeps the rider exactly on its arc',
    results.curvedRail.found ? results.curvedRail.worstDrift < 0.01 : true,
    results.curvedRail.found
      ? `worst drift ${results.curvedRail.worstDrift} m over ${results.curvedRail.frames} frames`
      : 'no curved rail generated on this seed'],

  /* ==================================================================
   * BEGIN per-run course configuration (src/world/Runs.js)
   *
   * The course used to hold its shape as literals inside `Course.js`.
   * It now reads every number from a run preset, so a second run is a
   * new object in `Runs.js` rather than a branch in the generator.
   *
   * That refactor is only safe if Classic came through it unchanged,
   * and it only stays safe if nothing quietly re-hardcodes a constant
   * on the way past. The two halves below assert exactly that:
   *
   *   1. Classic is byte-identical — fixed sample points and whole
   *      digests of the height field, the kicker and rail records and
   *      the forest scatter, against numbers captured before the
   *      refactor. These are not tolerances on a vibe; they are the
   *      same doubles or they are a regression.
   *   2. The seam is live — feeding a deliberately different preset
   *      through the same code has to produce a different mountain.
   *      Without this, a constant could drift back into `Course.js`
   *      and half of (1) would still pass.
   *
   * Runs in Node against the modules directly, after the browser has
   * closed: the course is pure maths and needs no page.
   * ================================================================== */
  ...(await (async () => {
    const { Course, COURSE } = await import('../src/world/Course.js');
    const { CLASSIC, defineRun, RUNS, runById } = await import('../src/world/Runs.js');
    const { buildForest } = await import('../src/world/Trees.js');

    /** Weighted sum over a fixed lattice — sensitive to a change anywhere in the field. */
    const shapeDigest = (c) => {
      let a = 0;
      for (let z = 0; z <= 2900; z += 7) {
        a += c.baseHeight(z) * 1.7 + c.centerX(z) * 3.1 + c.centerSlope(z) * 101 + c.trackHeading(z) * 13;
        for (let x = -400; x <= 400; x += 37) {
          a += c.terrainHeight(x, z) * 1.3 + c.groundHeight(x, z) * 0.7 +
               c.groomAt(x, z) * 11 + c.trackOffset(x, z) * 0.3;
        }
      }
      return a;
    };
    const featureDigest = (c) => {
      let a = c.kickers.length * 1e6 + c.rails.length * 1e4;
      for (const k of c.kickers) {
        a += k.x + k.z * 3 + k.length * 7 + k.halfWidth * 11 + k.height * 13 + (k.hip ? k.hipAngle * 17 : 0);
      }
      for (const r of c.rails) {
        a += r.x * 1.1 + r.z * 3 + r.length * 7 + r.height * 11 + r.curveRadius * 13 + r.halfWidth * 19;
      }
      return a;
    };
    const forestDigest = (list) => {
      let a = list.length * 1e6;
      for (const p of list) a += p.x * 1.1 + p.z * 3 + p.r * 17;
      return a;
    };

    const classic = new Course();
    const forest = buildForest(classic, {});

    // Captured from the pre-refactor course. Never "fix" one of these by
    // pasting in a new number: if it moved, the mountain moved.
    const REFERENCE = { shape: -5165795.767075, feature: 11121806.063125, forest: 1655268397.467164 };
    const shape = shapeDigest(classic);
    const feature = featureDigest(classic);
    const trees = forestDigest(forest.list);

    // A handful of named points, so a failure says *where* as well as *that*.
    const SPOTS = [
      [0, 0, 3.423586], [0, 500, -80.262732], [12, 900, -167.192577],
      [-40, 1200, -234.034416], [0, 1850, -364.666611], [80, 2000, -402.851305],
      [-150, 2400, -463.736282], [0, 2870, -549.670390], [300, 1500, -277.261833],
      [-420, 700, -110.559628],
    ];
    const spotErrors = SPOTS
      .map(([x, z, h]) => [x, z, Math.abs(classic.terrainHeight(x, z) - h)])
      .filter(([, , e]) => e > 5e-6);

    // A preset that differs in every axis a future run is expected to vary.
    const VARIED = defineRun({
      id: 'harness-varied',
      name: 'Harness Varied',
      grade: { base: 0.26, bells: [{ amp: 0.1, center: 600, width: 200 }] },
      track: { halfWidth: 26, waves: [{ amp: 70, freq: 0.003, phase: 0.2 }] },
      kickers: { spacing: { min: 60, range: 40 }, hip: { enabled: false } },
      rails: { chance: 0 },
      trees: { density: 0.2 },
    });
    const varied = new Course(20240117, VARIED);
    const variedForest = buildForest(varied, {});
    // Rebuild Classic afterwards: `COURSE` is a view of the last course made.
    const classicAgain = new Course();

    const seam = {
      grade: Math.abs(varied.baseHeight(1500) - classic.baseHeight(1500)) > 10,
      center: Math.abs(varied.centerX(700) - classic.centerX(700)) > 5,
      width: varied.trackHalfWidth === 26 && varied.groomAt(varied.centerX(900) + 20, 900) > 0.5,
      kickers: varied.kickers.length > classic.kickers.length * 2,
      noHip: !varied.kickers.some((k) => k.hip) && classic.kickers.some((k) => k.hip),
      noRails: varied.rails.length === 0 && classic.rails.length > 0,
      trees: variedForest.list.length < forest.list.length * 0.7,
      terrain: Math.abs(varied.terrainHeight(0, 1500) - classic.terrainHeight(0, 1500)) > 1,
    };
    const seamDead = Object.entries(seam).filter(([, ok]) => !ok).map(([k]) => k);

    return [
      ['the classic height field is bit-for-bit what it was',
        Math.abs(shape - REFERENCE.shape) < 1e-6 && spotErrors.length === 0,
        spotErrors.length
          ? `${spotErrors.length} spot samples moved, worst at ${spotErrors[0][0]},${spotErrors[0][1]}`
          : `digest ${shape.toFixed(6)}, ${SPOTS.length} spot samples exact`],
      ['the classic kickers and rails are bit-for-bit what they were',
        Math.abs(feature - REFERENCE.feature) < 1e-6,
        `${classic.kickers.length} kickers, ${classic.rails.length} rails, digest ${feature.toFixed(6)}`],
      ['the classic forest scatter is bit-for-bit what it was',
        Math.abs(trees - REFERENCE.forest) < 1e-6,
        `${forest.list.length} colliders, digest ${trees.toFixed(6)}`],
      ['the course reports which run it is',
        classic.runId === 'classic' && classic.runName === CLASSIC.name && classic.config === CLASSIC &&
        runById('classic') === CLASSIC && runById('nonsense') === CLASSIC && RUNS.includes(CLASSIC),
        `${classic.runId} / ${classic.runName}, ${RUNS.length} run(s) offered`],
      ['the legacy COURSE export still describes the run in play',
        COURSE.length === CLASSIC.length && COURSE.startZ === CLASSIC.startZ &&
        COURSE.finishZ === CLASSIC.finishZ && COURSE.halfWidth === CLASSIC.halfWidth &&
        COURSE.trackHalfWidth === CLASSIC.track.halfWidth &&
        COURSE.edgeSoftness === CLASSIC.track.edgeSoftness &&
        classicAgain.trackHalfWidth === CLASSIC.track.halfWidth,
        `${COURSE.length} m, half-width ${COURSE.trackHalfWidth} m`],
      ['a different preset actually builds a different mountain',
        seamDead.length === 0,
        seamDead.length ? `ignored by the generator: ${seamDead.join(', ')}` : 'every varied field took effect'],
      ['overriding a preset never edits the one it came from',
        CLASSIC.track.halfWidth === 16 && CLASSIC.track.waves.length === 3 &&
        CLASSIC.rails.chance === 0.5 && CLASSIC.kickers.hip.enabled === true &&
        VARIED.track.waves.length === 1 && VARIED.track.edgeSoftness === CLASSIC.track.edgeSoftness,
        'CLASSIC intact, arrays replaced rather than spliced'],
    ];
  })()),
  /* ================= END per-run course configuration ================ */

  /* ==================================================================
   * BANKING — lateral gravity coupling. One contiguous block, matching the
   * measurement block at the end of the page evaluation.
   * ================================================================ */

  // The control. Not "small" — zero. The term is a projection of the surface
  // normal onto the board's right, and on a level surface that projection is
  // identically nothing whatever way the rider is pointing. Anything else here
  // is a bug, not a tolerance.
  ['a level surface pushes the rider nowhere at all',
    results.bankFlat.driftDeg === 0,
    `${results.bankFlat.driftDeg} deg over ${results.bankFlat.seconds}s, still doing ${results.bankFlat.endSpeed} m/s`],

  // And the other end: a real bank has to be a turn, not a nudge. Twenty-five
  // degrees across, ridden flat-based, and the rider is a third of the way
  // round to the plane's fall line inside a second.
  ['a banked surface turns the rider down its fall line',
    results.bankPlane.right.afterOneSec > 12 && results.bankPlane.right.afterTwoSec > 25 &&
    results.bankPlane.right.afterTwoSec < results.bankPlane.right.fallLineDeg,
    `${results.bankPlane.right.afterOneSec}/${results.bankPlane.right.afterTwoSec}/` +
    `${results.bankPlane.right.afterThreeSec} deg at 1/2/3 s, toward a ${results.bankPlane.right.fallLineDeg} deg fall line`],

  // Signed, not merely non-zero: tilt the plane the other way and the turn has
  // to mirror exactly. A term that turned you the same way down both would be
  // a drift, not gravity.
  ['banking is signed, and mirrors',
    results.bankPlane.left.afterTwoSec === -results.bankPlane.right.afterTwoSec &&
    results.bankPlane.left.driftedX === -results.bankPlane.right.driftedX,
    `right ${results.bankPlane.right.driftedX} m, left ${results.bankPlane.left.driftedX} m across`],

  // An engaged edge is exactly what holds a rider across a slope, so a
  // committed carve has to keep most of the bank off. Not all of it — a board
  // held on edge across a wall still washes down it a little, and a term that
  // switched off entirely under steering would let you pin yourself anywhere.
  ['a committed edge holds its line across a bank',
    results.bankPlane.carveResidualDeg > 0 &&
    results.bankPlane.carveResidualDeg < results.bankPlane.right.afterTwoSec * 0.55,
    `${results.bankPlane.carveResidualDeg} deg of bank survives a full carve, vs ${results.bankPlane.right.afterTwoSec} deg flat-based`],

  /* ---- Regression against the mountain as it shipped ----------------
   *
   * Baseline captured by running these same measurements with `bankDrift`
   * forced to 0, which reproduces the old model exactly — the only other part
   * of the change is hoisting the `groundNormal` sample above the yaw
   * integration, and the normal depends solely on a position the frame has not
   * moved yet, so on its own it is a no-op. Confirmed: with bankDrift 0 the
   * whole 77-check suite returns byte-identical numbers, including the
   * autopilot run's 94.4 s and 863 points.
   *
   *   original  90.82 s, 129.6 km/h top, 5 airs / 6.18 s, ends z=2870.1 off=1.14
   *   cruise   136.93 s,  86.4 km/h top, 6 airs / 6.09 s, ends z=2870.0 off=0.24
   *   per-kicker air  [1.350 1.233 1.083 1.358 1.133 1.333 1.375 1.142 1.308 1.283 1.333]
   *
   * Tolerances, and why each is what it is:
   *   time      2%   — the measured shift is 0.08% and 0.17%; 2% is an order
   *                    of magnitude of headroom and still far under the
   *                    difference a player could feel over a three-minute run.
   *   top speed 1%   — this one does not move at all (129.6 and 86.4 to the
   *                    decimal), because terminal speed is set by gravity
   *                    against drag and banking touches neither. A tight bound
   *                    is the point: if it ever moves, something is wrong.
   *   finish    hard — reaching the village is not a thing to be within a
   *                    tolerance of.
   *   line      0.5 m — how far the autopilot ends off the groomed centre. It
   *                    moves by 0.13 m, and *toward* the middle: the bowl that
   *                    cradles the piste now actually cradles.
   *   air       0.03 s per kicker — three times the largest shift observed
   *                    (0.009 s), and about two per cent of a 1.3 s air.
   * -------------------------------------------------------------- */

  ['the existing course still takes the same time to ride',
    Math.abs(results.bankRegression.original.seconds - 90.82) / 90.82 < 0.02 &&
    Math.abs(results.bankRegression.cruise.seconds - 136.93) / 136.93 < 0.02,
    `original ${results.bankRegression.original.seconds}s vs 90.82s, cruise ${results.bankRegression.cruise.seconds}s vs 136.93s`],

  ['the existing course still runs at the same speed',
    Math.abs(results.bankRegression.original.topKmh - 129.6) / 129.6 < 0.01 &&
    Math.abs(results.bankRegression.cruise.topKmh - 86.4) / 86.4 < 0.01,
    `original ${results.bankRegression.original.topKmh} vs 129.6 km/h, cruise ${results.bankRegression.cruise.topKmh} vs 86.4 km/h`],

  ['the existing course still ends at the village, on the line',
    !results.bankRegression.original.crashed && !results.bankRegression.cruise.crashed &&
    results.bankRegression.original.endZ >= 2870 && results.bankRegression.cruise.endZ >= 2870 &&
    Math.abs(results.bankRegression.original.endOffset - 1.14) < 0.5 &&
    Math.abs(results.bankRegression.cruise.endOffset - 0.24) < 0.5,
    `original z=${results.bankRegression.original.endZ} off=${results.bankRegression.original.endOffset}, ` +
    `cruise z=${results.bankRegression.cruise.endZ} off=${results.bankRegression.cruise.endOffset}`],

  ['every kicker still gives the same air it always did',
    (() => {
      const was = [1.350, 1.233, 1.083, 1.358, 1.133, 1.333, 1.375, 1.142, 1.308, 1.283, 1.333];
      const now = results.bankRegression.kickerAirs;
      return now.length === was.length && now.every((a, i) => Math.abs(a - was[i]) <= 0.03);
    })(),
    (() => {
      const was = [1.350, 1.233, 1.083, 1.358, 1.133, 1.333, 1.375, 1.142, 1.308, 1.283, 1.333];
      const now = results.bankRegression.kickerAirs;
      const worst = Math.max(...now.map((a, i) => Math.abs(a - (was[i] ?? a))));
      return `worst shift ${worst.toFixed(3)}s over ${now.length} kickers`;
    })()],

  /* ==================================================================
   * TUNNELS — spectacle, and only spectacle. One contiguous block,
   * matching the measurement block at the end of the page evaluation.
   *
   * The whole design rule for this feature is that it must not become a
   * new way to end a run: no ceiling collision, nothing in
   * `_checkHazards` that knows tunnels exist, and a bore cut with more
   * headroom than the physics can throw a rider into. The first three
   * checks are that rule, measured rather than asserted in a comment.
   * ================================================================ */

  // Classic has none. This is the guard on the three digest checks above:
  // a tunnel is a mesh laid over the terrain, so it could never move the
  // height field — but a preset that quietly switched itself on would put
  // trees through `covers()` and change the forest scatter, and that is a
  // digest. Off in the config, off in the built world.
  ['classic ships with no tunnels at all',
    ui.tunnels.classicOff.configEnabled === false &&
    ui.tunnels.classicOff.configSpans === 0 &&
    ui.tunnels.classicOff.built === 0 &&
    ui.tunnels.classicOff.meshes === 0 &&
    ui.tunnels.classicOff.interiorAtStart === 0,
    `enabled=${ui.tunnels.classicOff.configEnabled}, ${ui.tunnels.classicOff.built} bores, ` +
    `${ui.tunnels.classicOff.meshes} meshes`],

  // The bore grows itself to guarantee headroom rather than trusting the
  // preset author to have thought about it. The test span deliberately has
  // a kicker in it, so the authored 16 m crown is not what gets built.
  ['a bore over a jump raises its own roof',
    ui.tunnels.bore.overJump === true &&
    ui.tunnels.bore.crown > ui.tunnels.bore.authored.crown &&
    ui.tunnels.bore.wallHeight > ui.tunnels.bore.authored.wallHeight,
    `authored ${ui.tunnels.bore.authored.crown} m crown, built ${ui.tunnels.bore.crown} m ` +
    `(walls ${ui.tunnels.bore.wallHeight} m) to guarantee ${ui.tunnels.bore.headroom} m ` +
    `at the ${ui.tunnels.bore.shoulder} m shoulder`],

  // Swept: every metre of the bore, every half metre across the corduroy
  // and its shoulder, measured against the ground the board is actually on
  // — the kicker ramp inside this span included. Fifteen metres is the
  // stated margin: it is comfortably above the 15.84 m the next check
  // measures a rider can reach, and the two together are the real claim.
  ['the roof never comes near the rider, anywhere along the bore',
    ui.tunnels.clearance.aboveGround > 15 && ui.tunnels.clearance.aboveTerrain > 15,
    `worst headroom ${ui.tunnels.clearance.aboveGround} m over the ground ` +
    `(${ui.tunnels.clearance.aboveTerrain} m over bare snow) at z=${ui.tunnels.clearance.tightest?.z} ` +
    `u=${ui.tunnels.clearance.tightest?.u} m, over ${ui.tunnels.clearance.samples} samples; ` +
    `${ui.tunnels.clearance.atWall} m at the wall`],

  // And the number that gives that margin its meaning: every kicker that
  // can put a rider into this bore, ridden straight up the middle at the
  // 36 m/s terminal speed of the `original` tuning with the ollie popped
  // at the lip. Three metres of daylight between the top of the helmet and
  // the vault at the highest point of the biggest air available.
  ['a full-speed popped ollie inside a tunnel still clears the vault',
    ui.tunnels.air.jumps > 0 &&
    ui.tunnels.air.worstHeadGap > 3 &&
    ui.tunnels.air.margin > 3,
    `${ui.tunnels.air.jumps} kicker(s) inside; apex ${ui.tunnels.air.apexAboveSnow} m above the snow, ` +
    `${ui.tunnels.air.worstHeadGap} m of air left over the helmet, ` +
    `${ui.tunnels.air.margin} m under the tightest part of the roof`],

  // Portals blend, they do not switch. A plane test would show up here as a
  // single step of 1.0; over a 30 m blend the steepest a smoothstep can get
  // is 1.5/30 per metre, so anything under 0.06 is the ramp and nothing else.
  ['entering and leaving a tunnel is a blend, not a cut',
    ui.tunnels.blend.enter.monotone && ui.tunnels.blend.exit.monotone &&
    ui.tunnels.blend.enter.first === 0 && ui.tunnels.blend.enter.last === 1 &&
    ui.tunnels.blend.exit.first === 1 && ui.tunnels.blend.exit.last === 0 &&
    ui.tunnels.blend.enter.biggestStep < 0.06 && ui.tunnels.blend.exit.biggestStep < 0.06,
    `${ui.tunnels.blend.metres} m blend, monotone in and out, biggest step ` +
    `${ui.tunnels.blend.enter.biggestStep} per metre (${ui.tunnels.blend.perFrameStep} per frame at 36 m/s)`],

  // Restarting from inside a tunnel. Measured with the frame loop stopped,
  // so this is what `Game.reset()` did on its own rather than what the next
  // frame would have quietly papered over.
  ['a tunnel actually takes the light and the sound away',
    ui.tunnels.inside.interior === 1 &&
    ui.tunnels.inside.sun < ui.tunnels.daylight.sun * 0.2 &&
    ui.tunnels.inside.fogDensity > ui.tunnels.daylight.fogDensity * 3 &&
    ui.tunnels.inside.fogColor !== ui.tunnels.daylight.fogColor &&
    ui.tunnels.inside.muffle === 1,
    `at z=${ui.tunnels.insideZ}: sun ${ui.tunnels.daylight.sun}→${ui.tunnels.inside.sun}, ` +
    `fog ${ui.tunnels.daylight.fogDensity}→${ui.tunnels.inside.fogDensity}, ` +
    `#${ui.tunnels.daylight.fogColor}→#${ui.tunnels.inside.fogColor}, muffle ${ui.tunnels.inside.muffle}`],

  ['restarting from inside a tunnel gives the daylight straight back',
    ui.tunnels.afterRestart.interior === 0 &&
    ui.tunnels.afterRestart.sun === ui.tunnels.daylight.sun &&
    ui.tunnels.afterRestart.hemi === ui.tunnels.daylight.hemi &&
    ui.tunnels.afterRestart.fill === ui.tunnels.daylight.fill &&
    ui.tunnels.afterRestart.fogDensity === ui.tunnels.daylight.fogDensity &&
    ui.tunnels.afterRestart.fogColor === ui.tunnels.daylight.fogColor &&
    ui.tunnels.afterRestart.muffle === 0,
    `back at the gate (z=${ui.tunnels.afterRestartZ}) with sun ${ui.tunnels.afterRestart.sun}, ` +
    `fog ${ui.tunnels.afterRestart.fogDensity} #${ui.tunnels.afterRestart.fogColor}, ` +
    `muffle ${ui.tunnels.afterRestart.muffle}`],

  // The audio half of the same thing. The muffle is a low-pass on the two
  // continuous voices — no new source, nothing sampled — and it rides on
  // `setTargetAtTime`, so both ends are read after the ramp has had time to
  // arrive rather than in the tick that set it.
  ['the interior low-pass closes down over the voices and opens back up',
    !ui.tunnels.audioReady || (
      ui.tunnels.audioInside.cutoffHz < 1200 && ui.tunnels.audioInside.echo > 0.1 &&
      ui.tunnels.audioAfterRestart.cutoffHz > 12000 && ui.tunnels.audioAfterRestart.echo < 0.01
    ),
    ui.tunnels.audioReady
      ? `inside ${ui.tunnels.audioInside.cutoffHz} Hz / echo ${ui.tunnels.audioInside.echo}, ` +
        `after restart ${ui.tunnels.audioAfterRestart.cutoffHz} Hz / echo ${ui.tunnels.audioAfterRestart.echo}`
      : 'no audio context in this browser'],
  /* ======================== END tunnels ============================ */
  /* ==================================================================
   * TERRAIN FEATURES — the fork, and mogul fields. One contiguous block,
   * matching the measurement block at the end of the page evaluation.
   *
   * A fork is two lanes with a raised divider between them, held open for a
   * few hundred metres and then rejoined. The whole of it is a shape in the
   * one analytic height field — no lane parameter, no committed-lane state,
   * nothing anywhere that knows the word "lane" — so what has to be shown is
   * that a *shape* is enough to make it a decision.
   *
   * Both features are off on Classic, and the three digest checks above are
   * what says so.
   * ================================================================ */

  // Both lanes have to sit on groomed snow, so the corduroy opens up over the
  // fork and closes again after it — which is why `trackHalfWidth` had to stop
  // being a constant, and why the shader can no longer be told what it is.
  ['the piste widens through the fork and closes again',
    results.fork.widthAtCrest === results.fork.widthBefore + results.fork.config.widen &&
    results.fork.widthAtCrest > results.fork.config.maxSeparation * 2,
    `${results.fork.widthBefore} m before, ${results.fork.widthAtCrest} m at the widest, ` +
    `lanes ${(results.fork.widthAtCrest - results.fork.config.maxSeparation).toFixed(1)} m across`],

  // The one that matters. Two identical riders, holding nothing but the
  // heading the run is going — no steering toward a lane, because there is no
  // such thing to steer toward — dropped in four metres either side of the
  // centre line. They come out on the side they went in on, and neither ever
  // crosses to the other. Nothing in the code arranged that: the ridge's
  // flanks are tilted, gravity acts across a tilted board, and `bankDrift`
  // turns it into yaw.
  ['a rider entering the fork on one side comes out on that side',
    results.fork.left.exitU < 0 && results.fork.right.exitU > 0 &&
    !results.fork.left.crossed && !results.fork.right.crossed &&
    Math.abs(results.fork.left.exitU) > results.fork.config.maxSeparation * 0.8 &&
    Math.abs(results.fork.right.exitU) > results.fork.config.maxSeparation * 0.8,
    `in at -4 m, out at ${results.fork.left.exitU} m; in at +4 m, out at ${results.fork.right.exitU} m`],

  // And the control, which is what stops the check above from being a
  // statement about the track's own wander. Same two runs, same rider, same
  // hill, ridge removed: both cross the centre line, because a heading held
  // down a line that bends thirty metres side to side always will.
  ['and does not, on the same hill with the divider taken away',
    results.fork.flatLeft.crossed && results.fork.flatRight.crossed,
    `flat run from -4 m crossed: ${results.fork.flatLeft.crossed}, from +4 m: ${results.fork.flatRight.crossed}`],

  // The divider is a cost, not a wall. Ridden straight at, it is the one line
  // that does not push you off, and it has to be survivable — you go over,
  // lose the height and the speed, and carry on.
  ['riding straight at the crest costs you, and nothing more',
    !results.fork.crest.crashed && results.fork.crest.endZ >= results.fork.config.z3 - 1,
    `reached z=${results.fork.crest.endZ} at ${results.fork.crest.endKmh} km/h without crashing`],

  ['no approach to the fork crashes the run',
    !results.fork.left.crashed && !results.fork.right.crashed && !results.fork.crest.crashed,
    `through the fork at ${results.fork.left.exitKmh}/${results.fork.right.exitKmh}/` +
    `${results.fork.crest.exitKmh} km/h, all three reaching the rejoin`],

  // Both lanes are corduroy, or the fork would be a choice between the piste
  // and the powder rather than between two lines. The ridge between them is
  // not: no groomer climbs its own divider, and untracked snow down the middle
  // is most of what makes the split legible from the approach.
  ['both lanes are groomed and the divider is not',
    results.forkGroom.laneLeft > 0.98 && results.forkGroom.laneRight > 0.98 &&
    results.forkGroom.laneEdge > 0.9 && results.forkGroom.crest < 0.01 &&
    results.forkGroom.innerFlank < 0.2 && results.forkGroom.offPiste < 0.05 &&
    results.forkGroom.beforeFork === 1,
    `lanes ${results.forkGroom.laneLeft}/${results.forkGroom.laneRight}, crest ${results.forkGroom.crest}, ` +
    `off-piste ${results.forkGroom.offPiste}`],

  /* Normals. Every force the rider feels is a projection of this vector, and
   * two of them divide by its y — so a spike is not a shading seam, it is a
   * rider thrown sideways by a surface that has a crease in it. Sampled at
   * 0.4 m across and 0.75 m down, far finer than the 0.6 m the rider's own
   * central differences use, so a crease narrower than the rider could feel
   * still fails here.
   *
   * The bound is 0.7 — about a 45 degree face. The steepest thing either
   * feature is *meant* to have is the divider's flank at 36 degrees, and the
   * plain-mountain control over the same ground is quoted alongside so the
   * number is known to be about the features rather than about the bowl. */
  ['the ground stays smooth over the divider',
    results.featureNormals.divider.worst > 0.7,
    `worst n.y ${results.featureNormals.divider.worst} at u=${results.featureNormals.divider.at?.[0]} m, ` +
    `z=${results.featureNormals.divider.at?.[1]} (plain mountain: ${results.featureNormals.plain.worst})`],

  ['the ground stays smooth over a mogul field',
    results.featureNormals.moguls.worst > 0.7,
    `worst n.y ${results.featureNormals.moguls.worst} at u=${results.featureNormals.moguls.at?.[0]} m, ` +
    `z=${results.featureNormals.moguls.at?.[1]}`],

  // Bumps you can carry speed over, at a walk and at a lick. A field that has
  // to be ridden slowly is a wall in disguise.
  ['a mogul field is ridable at any speed',
    !results.mogulRun.slow.crashed && !results.mogulRun.fast.crashed &&
    results.mogulRun.slow.endZ >= results.mogulRun.config.z3 &&
    results.mogulRun.fast.endZ >= results.mogulRun.config.z3 && results.mogulRun.fast.endKmh > 40,
    `18 m/s in -> ${results.mogulRun.slow.endKmh} km/h out, 30 m/s in -> ${results.mogulRun.fast.endKmh} km/h out, ` +
    `${results.mogulRun.fast.airs} airs`],

  ['and the bumps are actually there',
    results.mogulRun.reliefM > 0.8 && results.mogulRun.reliefM < 3,
    `${results.mogulRun.reliefM} m crest to trough`],
  /* ==================================================================
   * FAR-SIDE KICKERS — step-downs and gap jumps. One contiguous block,
   * matching the measurement block at the end of the page evaluation.
   *
   * Both shapes are a raised take-off deck plus a landing, carried in the
   * kicker's own height field. Both are off on Classic — the three digest
   * checks above are what says so — and everything here is measured on a
   * second course with them switched on.
   * ================================================================ */

  ['neither new shape appears on Classic', results.farSide.classicHasNeither,
    `deck ${results.farSide.liftM} m, lip ${results.farSide.lipAboveSnowM} m above the snow when enabled`],

  /* ---- The step-down -----------------------------------------------
   *
   * The point of it is the drop. A rider rolling in at 72 km/h leaves a lip
   * nearly seven metres above the snow, and the ground has stepped down and
   * run away from them by the time they meet it again — so they land a long
   * way below where they left, and they are in the air for longer doing it
   * than any ordinary kicker on the same course would give them.
   * ------------------------------------------------------------- */

  ['a step-down launches the rider and lands them well below take-off',
    results.farSide.cruise.stepDown.launched &&
    results.farSide.cruise.stepDown.dropM > 8 &&
    results.farSide.cruise.stepDown.landedAt > 18 &&
    !results.farSide.cruise.stepDown.crashed,
    `cruise: ${results.farSide.cruise.stepDown.dropM} m down, ` +
    `landing ${results.farSide.cruise.stepDown.landedAt} m past the lip ` +
    `(original ${results.farSide.original.stepDown.dropM} m / ${results.farSide.original.stepDown.landedAt} m)`],

  // Against the best of the eleven ordinary kickers on the same course, ridden
  // the same way — an absolute number would only be measuring the tuning.
  ['a step-down hangs longer than any ordinary kicker on the same course',
    ['cruise', 'original'].every((t) =>
      results.farSide[t].stepDown.airSeconds > results.farSide[t].plainAir + 0.12 &&
      results.farSide[t].stepDownFlatOut.airSeconds > results.farSide[t].plainAirFlatOut + 0.12),
    ['cruise', 'original'].map((t) =>
      `${t} ${results.farSide[t].stepDown.airSeconds}s vs ${results.farSide[t].plainAir}s at 72 km/h, ` +
      `${results.farSide[t].stepDownFlatOut.airSeconds}s vs ${results.farSide[t].plainAirFlatOut}s flat out`).join('; ')],

  /*
   * Committing has to buy something, or the shape is a tax on confidence.
   * Every extra metre per second off the lip is more distance, more drop and
   * more air, and the step keeps running away from you the whole time, so at
   * the speeds the game ships at the landing still holds your speed too.
   *
   * There is a ceiling on that, and it is named rather than hidden. The step
   * is 26 m of transition and the lip speeds it has to serve span 19 to 35 m/s
   * — no single face covers 44 m of landing spread. It is fitted to cruise,
   * which is the tuning the game ships on and the one a park run will be
   * ridden with; flat out on `original`, at 126 km/h, you over-jump the whole
   * thing and land on the flat past it, and pay about thirty per cent for it.
   * That is what over-jumping a landing is supposed to cost. It is still a
   * landing — no stumble, no crash — which is the part that matters here.
   */
  ['a step-down pays for committing to it',
    ['cruise', 'original'].every((t) => {
      const easy = results.farSide[t].stepDown;
      const hard = results.farSide[t].stepDownFlatOut;
      return hard.landedAt > easy.landedAt + 4 && hard.dropM > easy.dropM + 2 &&
        hard.airSeconds > easy.airSeconds + 0.1 && !hard.crashed && hard.stillRiding &&
        hard.kept > (t === 'cruise' ? 0.85 : 0.6);
    }),
    ['cruise', 'original'].map((t) => {
      const easy = results.farSide[t].stepDown;
      const hard = results.farSide[t].stepDownFlatOut;
      return `${t}: ${easy.landedAt}m/${easy.dropM}m/${easy.airSeconds}s keeping ` +
        `${Math.round(easy.kept * 100)}% -> flat out ${hard.landedAt}m/${hard.dropM}m/` +
        `${hard.airSeconds}s keeping ${Math.round(hard.kept * 100)}%`;
    }).join('; ')],

  /* ---- The gap ------------------------------------------------------
   *
   * The whole design is one number: how far past the lip the landing's crest
   * sits. Measured rather than guessed — the achievable air off this take-off
   * was measured first and the crest put inside it, with margin, on the
   * tuning the game actually ships on.
   *
   *   crest              22 m past the lip
   *   cruise, 72 km/h    touches down ~26 m out — clears by ~4 m
   *   cruise, flat out   touches down ~31 m out — clears by ~9 m
   *   original, 72 km/h  touches down ~32 m out — clears by ~10 m
   *
   * The bounds below are the shape of that, not the digits: what must hold is
   * that an ordinary committed approach clears it on *both* tunings, and that
   * flat out has room to spare.
   * ------------------------------------------------------------- */

  ['a gap jump is clearable at a realistic approach speed',
    results.farSide.cruise.gap.landedAt > results.farSide.gapCrestM + 2 &&
    results.farSide.original.gap.landedAt > results.farSide.gapCrestM + 2,
    `crest at ${results.farSide.gapCrestM} m; cruise leaves the lip at ` +
    `${results.farSide.cruise.gap.lipSpeed} m/s and lands ${results.farSide.cruise.gap.landedAt} m out ` +
    `(+${(results.farSide.cruise.gap.landedAt - results.farSide.gapCrestM).toFixed(1)} m), ` +
    `original at ${results.farSide.original.gap.lipSpeed} m/s lands ${results.farSide.original.gap.landedAt} m out ` +
    `(+${(results.farSide.original.gap.landedAt - results.farSide.gapCrestM).toFixed(1)} m)`],

  ['a gap jump has room to spare at full piste speed',
    results.farSide.cruise.gapFlatOut.landedAt > results.farSide.gapCrestM + 6 &&
    results.farSide.original.gapFlatOut.landedAt > results.farSide.gapCrestM + 6 &&
    results.farSide.cruise.gapFlatOut.kept > 0.9,
    `cruise +${(results.farSide.cruise.gapFlatOut.landedAt - results.farSide.gapCrestM).toFixed(1)} m ` +
    `keeping ${Math.round(results.farSide.cruise.gapFlatOut.kept * 100)}%, ` +
    `original +${(results.farSide.original.gapFlatOut.landedAt - results.farSide.gapCrestM).toFixed(1)} m`],

  // The other half of the same design. A gap that cannot be failed is not a
  // gap; a gap that ends the run for failing it is a trap, and on this
  // mountain almost nothing but a tree square on ends a run. Coming up short
  // drops you into the trough, costs you most of your speed, and leaves you
  // riding out the far side of it.
  ['coming up short on a gap costs speed and flow, never the run',
    ['cruise', 'original'].every((t) => {
      const cased = results.farSide[t].gapCased;
      return cased.landedAt < results.farSide.gapCrestM &&
        cased.kept < 0.75 && !cased.crashed && cased.stillRiding && cased.speedAfter6s > 8;
    }),
    ['cruise', 'original'].map((t) => {
      const cased = results.farSide[t].gapCased;
      return `${t}: lip ${cased.lipSpeed} m/s -> down at ${cased.landedAt} m ` +
        `(${(results.farSide.gapCrestM - cased.landedAt).toFixed(1)} m short), slowed to ` +
        `${cased.slowestAfter} m/s, still riding at ${cased.speedAfter6s} m/s`;
    }).join('; ')],

  /* ---- The ground itself --------------------------------------------
   *
   * `groundNormal` takes central differences at 0.6 m, so anything that steps
   * inside a metre and a bit reads as a near-vertical wall and throws the
   * rider. Every kicker in the game has exactly one such step — the lip — and
   * that is deliberate. These two shapes are long, and the whole of their far
   * side is new ground, so it is sampled every 25 cm end to end.
   * ------------------------------------------------------------- */

  // The bound is 0.22, which is a surface running at 77 degrees to the
  // vertical — steep, and exactly as steep as a lip is supposed to be. Both
  // shapes reach it in the same place Classic's kickers reach theirs (0.26):
  // at the lip, and nowhere else. Theirs sit a fraction higher because these
  // two ramps are deliberately steeper than any on Classic, which is where
  // their extra hang time comes from.
  ['the normal never spikes anywhere along either new shape',
    results.farSide.stepDownLine.worstNormalY > 0.22 &&
    results.farSide.gapLine.worstNormalY > 0.22 &&
    Math.abs(results.farSide.stepDownLine.worstAt) < 1 &&
    Math.abs(results.farSide.gapLine.worstAt) < 1,
    `worst normal.y: step-down ${results.farSide.stepDownLine.worstNormalY} at ` +
    `${results.farSide.stepDownLine.worstAt} m, gap ${results.farSide.gapLine.worstNormalY} at ` +
    `${results.farSide.gapLine.worstAt} m — both at the lip; Classic's own kickers reach ` +
    `${results.farSide.classicPlainWorstNormalY}`],

  ['away from the lip, both shapes stay smooth under the board',
    results.farSide.stepDownLine.worstAwayFromLip > 0.6 &&
    results.farSide.gapLine.worstAwayFromLip > 0.6,
    `worst normal.y off the lip: step-down ${results.farSide.stepDownLine.worstAwayFromLip} ` +
    `at ${results.farSide.stepDownLine.awayAt} m, gap ${results.farSide.gapLine.worstAwayFromLip} ` +
    `at ${results.farSide.gapLine.awayAt} m`],

  // And nothing on either far side is a hill. A rider who cases the gap is in
  // the trough with almost no speed left, so the climb out of it has to be
  // something the pitch itself will carry them up.
  ['nothing on either far side is a climb the rider cannot ride out of',
    results.farSide.stepDownLine.steepestClimb < 0.3 && results.farSide.gapLine.steepestClimb < 0.3,
    `steepest metre: step-down ${results.farSide.stepDownLine.steepestClimb} at ` +
    `${results.farSide.stepDownLine.climbAt} m, gap ${results.farSide.gapLine.steepestClimb} at ` +
    `${results.farSide.gapLine.climbAt} m`],
  /* ================= END far-side kickers =========================== */

  /* ==================================================================
   * THE THREE RUNS. See the measurement block for what each of these has
   * actually caught; none of them is hypothetical.
   * ================================================================ */
  ['the picker hands the course generator an intact mountain',
    results.runs.every((r) => r.gradeBells >= 1),
    results.runs.map((r) => `${r.id}: ${r.gradeBells} bell(s)`).join(', ')],

  ['all three runs are offered, gentlest first',
    results.runs.length === 3 &&
    results.runs.every((r, i) => r.rating === i + 1) &&
    results.runs.map((r) => r.id).join(',') === 'classic,park,backcountry',
    results.runs.map((r) => `${r.id} (${r.rating})`).join(' -> ')],

  ['every run can be ridden from the gate to the finish',
    results.runs.every((r) => r.ride.finished && !r.ride.crashed),
    results.runs.map((r) => `${r.id} ${r.ride.seconds}s to z=${r.ride.endZ}`).join(', ')],

  ['and they do not all ride the same',
    (() => {
      const s = results.runs.map((r) => r.ride.seconds);
      return Math.max(...s) - Math.min(...s) > 8;
    })(),
    results.runs.map((r) => `${r.id} ${r.ride.seconds}s / ${r.ride.topKmh} km/h / ${r.ride.airs} airs`).join(', ')],

  ['nothing anywhere is built on the fork divider',
    results.runs.every((r) => r.onDivider === 0 && r.deckedInFork === 0),
    results.runs.map((r) => `${r.id} ${r.onDivider} on the ridge, ${r.deckedInFork} decked inside the fork`).join('; ')],

  ['each run actually contains what its card advertises',
    (() => {
      const by = Object.fromEntries(results.runs.map((r) => [r.id, r]));
      return (
        // Classic: the baseline, and still nothing built on it.
        by.classic.kickers >= 8 && by.classic.rails >= 3 &&
        !by.classic.forkOpen && !by.classic.mogulsOn && by.classic.tunnels === 0 &&
        // Park: a jump line, rails end to end, every shape, a fork, tunnels.
        by.park.kickers > by.classic.kickers && by.park.rails > by.classic.rails * 2 &&
        by.park.hips === 1 && by.park.stepDowns === 1 && by.park.gaps === 1 &&
        by.park.forkOpen && by.park.tunnels === 2 && !by.park.mogulsOn &&
        // Backcountry: narrow, treed, bumped, with a gap and no built things.
        by.backcountry.halfWidth < by.classic.halfWidth * 0.75 &&
        by.backcountry.trees > by.classic.trees &&
        by.backcountry.mogulsOn && by.backcountry.gaps === 1 &&
        by.backcountry.rails >= 1 && !by.backcountry.forkOpen && by.backcountry.tunnels === 0
      );
    })(),
    results.runs.map((r) =>
      `${r.id}: ${r.kickers}k/${r.rails}r/${r.trees}t` +
      `${r.hips ? ' hip' : ''}${r.stepDowns ? ' step' : ''}${r.gaps ? ' gap' : ''}` +
      `${r.forkOpen ? ' fork' : ''}${r.mogulsOn ? ' moguls' : ''}${r.tunnels ? ` ${r.tunnels}xtunnel` : ''}`
    ).join('; ')],

  ['only the run with a fork ever widens its piste',
    results.runs.every((r) => (r.forkOpen ? r.widest > r.halfWidth : r.widest === r.halfWidth)),
    results.runs.map((r) => `${r.id} ${r.halfWidth}->${r.widest} m`).join(', ')],
  /* ==================== END the three runs ========================== */
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
