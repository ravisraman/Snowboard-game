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
