import * as THREE from 'three';
import { clamp, damp, smoothstep, angleDelta } from '../core/mathx.js';

/**
 * The snowboarder: model, and the carving physics that give the game its feel.
 *
 * The physics model in one paragraph. Steering input tips the rider onto an
 * edge, and the edge angle is driven by a spring so it has weight — you can't
 * flick between edges, you have to commit. Edge angle becomes *curvature*, not
 * a turn rate, so the board follows an arc of a fixed radius and the resulting
 * yaw rate scales with speed exactly like a real carve. Holding an arc scrubs
 * speed proportionally to how hard you're carving, so the fastest line is the
 * straightest one you can get away with. Off the groomer, the powder multiplies
 * drag and steals your edge grip.
 */

const TUNING = {
  gravity: 20.5,          // arcade gravity — snappier airs than 9.81
  maxSpeed: 36,           // m/s (~130 km/h)
  startSpeed: 7,
  dragBase: 0.0022,       // quadratic; sets the terminal speed on the pitch
  dragTuck: 0.55,         // multiplier while tucked
  dragBrake: 0.020,
  dragPowder: 0.019,
  frictionBase: 0.35,     // snow friction (m/s^2) at full ploughing speed
  frictionPowder: 5.5,
  ploughSpeed: 4,         // speed by which snow resistance has fully built up
  tuckThrust: 1.6,

  maxLean: 0.62,          // ~35 degrees of edge angle
  leanSpeedFloor: 7,      // m/s at which full edge angle becomes available
  pivotSpeed: 8,          // below this the board can be shuffled round on the spot
  pivotRate: 1.5,         // rad/s of that shuffle at a standstill
  skateSpeed: 6,          // below this the jump button skates instead of ollies
  skatePush: 3.4,         // m/s gained per skate
  leanStiffness: 36,      // spring toward the commanded edge
  leanDamping: 8.5,
  maxCurvature: 1 / 15.5, // tightest carve radius, in 1/metres
  powderGrip: 0.55,       // edge authority retained in deep snow

  spinRate: 5.2,          // rad/s the board rotates in the air (~1.2 s per 360)
  boardSettle: 12,        // how fast the board lines back up after landing
  landCleanTol: 0.7,      // rad from forward-or-switch that still rides away
  landSketchyTol: 1.25,   // past this the edge catches and you go down
  landSketchyScrub: 0.72, // fraction of speed kept on a scrappy landing
  landStompTol: 0.12,     // dead straight, and paid for as such

  popPhase: 0.72,         // how far up the ramp an ollie has to be to count
  popBoost: 0.55,         // extra ollie, as a fraction of the normal one

  pressMinSpeed: 5,       // too slow to butter — the board just sits down
  butterRate: 2.9,        // rad/s the board swings round while pressed
  butterScrub: 2.6,       // m/s^2 bled off while riding on one end of the board
  butterCatch: 0.9,       // rad off travel at which releasing costs you dearly
  butterEdge: 0.12,       // how much edge is left to carve on while pressed

  scrub: 0.055,           // speed lost to carving hard
  brakeScrub: 7.5,

  ollie: 5.6,
  leaveSpeed: 1.2,        // m/s of separation before the board is truly airborne
  landHardImpact: 13,
  landSpeedKeep: 0.87,

  riderRadius: 0.62,

  stumbleSeconds: 1.1,    // how long a clipped skier stays with you
  stumbleScrub: 0.45,     // fraction of speed kept through the hit
};

export const RIDER_TUNING = TUNING;

/**
 * The four grabs, as poses.
 *
 * `front`/`back` are the two arm angles, `fold` is how far the torso folds over
 * the board, and `tweak` is the sideways bone — a method is mostly tweak, an
 * indy is mostly fold. They differ enough to be told apart from behind, which
 * is the only view the player ever has of them.
 */
const GRAB_POSES = {
  indy:   { front: -1.85, back: 1.15, fold: 0.34, tweak: 0 },
  melon:  { front: -1.2, back: 1.95, fold: 0.28, tweak: -0.3 },
  nose:   { front: -2.25, back: 0.7, fold: 0.46, tweak: 0.12 },
  method: { front: -1.05, back: 2.3, fold: 0.16, tweak: -0.62 },
};

export class Rider {
  constructor(course) {
    this.course = course;
    this.model = buildRiderModel();

    // Scratch objects, reused every frame to keep the update allocation-free.
    this._normal = { x: 0, y: 1, z: 0 };
    this._v = new THREE.Vector3();

    this.reset();
  }

  reset() {
    const c = this.course;
    const z = 24;
    const x = c.centerX(z);

    this.position = new THREE.Vector3(x, c.groundHeight(x, z), z);
    this.yaw = c.trackHeading(z);
    this.speed = TUNING.startSpeed;
    this.vy = 0;
    this.grounded = true;
    this.lean = 0;
    this.leanVel = 0;
    this.steer = 0;

    this.airTime = 0;
    this.longestAir = 0;
    this.topSpeed = 0;
    this.crashed = false;
    this.landedHard = 0;
    this.carveIntensity = 0;
    this.powder = 0;
    this.braking = false;
    this.tucking = false;
    this.justLaunched = false;
    this.justLanded = 0;
    this.skated = 0;

    // Where the board points, as opposed to where the rider is travelling.
    // Locked together on the snow; free to rotate in the air.
    this.boardYaw = this.yaw;
    this.spinFrom = this.yaw;
    this.spinDegrees = 0;
    this.switchStance = false;
    this.grabbing = false;
    this.grabType = null;
    this.grabTime = 0;
    this.spinPeak = 0;
    this.popped = 0;
    this.trickLanded = null;
    this.trickFailed = false;
    this.spinArmed = false;
    this.stumbleTime = 0;

    // Butters: riding on one end of the board with the other in the air.
    this.pressing = false;
    this.pressDir = 1;          // +1 nose, -1 tail
    this.pressAmount = 0;       // eased, for the model
    this.pressFrom = this.yaw;
    this.pressDegrees = 0;
    this.groundTrick = null;    // one-frame event, like trickLanded

    this._tumble = new THREE.Vector3();
    this._modelPitch = 0;
    this._modelRoll = 0;
    this._crouch = 0;
    this._weight = 0;
    this._lastSpeed = this.speed;

    this.model.root.position.copy(this.position);
    this.model.root.rotation.set(0, this.yaw, 0);
    this.model.tilt.rotation.set(0, 0, 0);
    this.model.body.rotation.set(0, 0, 0);
    this.model.body.position.set(0, 0, 0);
    this.model.root.visible = true;
    this.settle();
  }

  /**
   * Drops the board onto the snow where it currently stands and matches its
   * vertical velocity to the surface. Without the seed, a rider placed at rest
   * on a descending pitch reads as the ground falling away from them and gets
   * flung into a phantom jump on the very first frame.
   */
  settle() {
    const c = this.course;
    this.position.y = c.groundHeight(this.position.x, this.position.z);
    const back = c.groundHeight(
      this.position.x - Math.sin(this.yaw) * 0.6,
      this.position.z - Math.cos(this.yaw) * 0.6
    );
    this.vy = this.speed * ((this.position.y - back) / 0.6);
    this.grounded = true;
    this.airTime = 0;
    this.boardYaw = this.yaw;
    this.switchStance = false;
  }

  get forwardX() { return Math.sin(this.yaw); }
  get forwardZ() { return Math.cos(this.yaw); }

  /* ================================================================
   * Physics
   * ============================================================== */

  update(dt, input) {
    if (this.crashed) return this._updateCrash(dt);

    const c = this.course;

    // Cleared up here rather than with the other per-frame flags below, because
    // a butter is judged in section 2 — resetting it further down would wipe
    // the event in the same frame it was raised.
    this.groundTrick = null;

    this.powder = 1 - c.groomAt(this.position.x, this.position.z);
    this.tucking = input.tuck && this.grounded;
    this.braking = input.brake && this.grounded;

    /* ---- 1. Edge angle: a spring, so turns carry momentum ---------- */
    // You cannot hold an edge you have no speed to hold it with. Without this,
    // a rider bogged down in powder still lies over at forty degrees.
    const authority = clamp(this.speed / TUNING.leanSpeedFloor, 0, 1);
    const commanded = input.steer * TUNING.maxLean * authority;
    this.leanVel += (commanded - this.lean) * TUNING.leanStiffness * dt;
    this.leanVel *= Math.exp(-TUNING.leanDamping * dt);
    this.lean = clamp(this.lean + this.leanVel * dt, -TUNING.maxLean * 1.2, TUNING.maxLean * 1.2);
    this.steer = input.steer;

    /* ---- 2. Edge angle becomes curvature, curvature becomes yaw ---- */
    const grip = 1 - this.powder * (1 - TUNING.powderGrip);
    const curvature = (this.lean / TUNING.maxLean) * TUNING.maxCurvature * grip;
    this.carveIntensity = clamp(Math.abs(this.lean) / TUNING.maxLean, 0, 1.2);

    if (this.grounded) {
      // A butter is the ground version of a spin: weight onto one end, the
      // other end light, and the board swings round underneath you while you
      // keep travelling the way you were. Same `boardYaw` split as the air, and
      // it needs speed for the same reason a carve does — at walking pace you
      // are not buttering, you are standing on a board.
      const wantsPress = input.press && this.speed > TUNING.pressMinSpeed;
      if (wantsPress && !this.pressing) this._beginPress();
      else if (!wantsPress && this.pressing) this._endPress();
      this.pressing = wantsPress;
      if (this.pressing) this.pressDir = input.brake ? -1 : 1;

      // Yaw rate = speed x curvature: a carve of fixed radius, exactly as a
      // real board's sidecut behaves. Turning gets quicker as you go faster.
      //
      // Pressed, there is almost no edge left to carve on — one end of the
      // board is in the air. That is what lets the same stick spin the board
      // without also steering you off your line, and it is why a butter tracks
      // more or less straight while the board comes round underneath you.
      this.yaw += curvature * this.speed * dt * (this.pressing ? TUNING.butterEdge : 1);

      // Carving needs speed, so at a crawl the edge does nothing — which left
      // a rider who stopped facing across the hill unable to turn back down it.
      // Hopping the board round on the spot is what you'd actually do, and it
      // fades out as soon as there's enough speed to hold an edge.
      const pivot = 1 - clamp(this.speed / TUNING.pivotSpeed, 0, 1);
      this.yaw += input.steer * TUNING.pivotRate * pivot * dt;

      if (this.pressing) {
        // Pressed, the board is free to swing. Nothing pulls it back to travel
        // until you let go, which is what makes a ground 180 possible at all.
        this.boardYaw += input.steer * TUNING.butterRate * dt;
        this.pressDegrees = Math.abs(((this.boardYaw - this.pressFrom) * 180) / Math.PI);
      } else {
        // On the snow the board lines up with travel — or 180 out of it, if you
        // rode away switch. Settled rather than snapped, so a landing reads as a
        // landing instead of a jump cut.
        const settled = this.yaw + (this.switchStance ? Math.PI : 0);
        this.boardYaw = damp(this.boardYaw, settled, TUNING.boardSettle, dt);
      }
    } else {
      // A spin has to be *asked for*. Carrying a carve into the lip is ordinary
      // riding, and if that held edge kept rotating the board in the air you
      // would be flung into an unasked-for 360 and wash out on landing — the
      // game punishing you for turning. So the stick has to return to centre
      // once after take-off before it counts as a spin command.
      if (input.steer === 0) this.spinArmed = true;

      // In the air only the *board* turns. Travel stays ballistic, which is the
      // whole difference between a spin and a mid-air steer: you commit to your
      // line off the lip, and what you do after that is style, not navigation.
      if (this.spinArmed) this.boardYaw += input.steer * TUNING.spinRate * dt;

      // Net rotation from take-off, not distance travelled — otherwise
      // wiggling the stick back and forth would bank as a 720.
      this.spinDegrees = Math.abs(((this.boardYaw - this.spinFrom) * 180) / Math.PI);
      // The peak is what a shifty is judged on: spun out and brought back, so
      // the net rotation at touchdown is nearly nothing but the move happened.
      this.spinPeak = Math.max(this.spinPeak, this.spinDegrees);

      // Neither brake nor tuck has anything to do in the air, so they become
      // two of the four grabs. The type is whichever is held most recently;
      // the timer runs across the whole air, so tweaking between grabs is not
      // punished.
      const requested = input.grabType;
      this.grabbing = !!requested;
      if (requested) {
        this.grabType = requested;
        this.grabTime += dt;
      }
    }

    /* ---- 3. Longitudinal forces ----------------------------------- */
    c.groundNormal(this.position.x, this.position.z, this._normal);
    const n = this._normal;
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);

    // Rate of height change per metre travelled along the heading.
    const slope = -(n.x * fx + n.z * fz) / Math.max(n.y, 0.2);

    let accel = 0;
    if (this.grounded) {
      accel += -TUNING.gravity * slope / Math.sqrt(1 + slope * slope);

      // Snow resists by being ploughed out of the way, so the resistance has
      // to fall away as the board slows. Modelling it as a constant made deep
      // snow an inescapable dead end: at 5.85 m/s^2 it outweighs gravity's pull
      // on every gradient this course has, so a rider who stopped in powder
      // could never start again on any slope, however steep.
      const plough = smoothstep(0, TUNING.ploughSpeed, this.speed);
      accel -= (TUNING.frictionBase + this.powder * TUNING.frictionPowder) * plough;

      let drag = TUNING.dragBase + this.powder * TUNING.dragPowder;
      if (this.tucking) {
        drag *= TUNING.dragTuck;
        accel += TUNING.tuckThrust;
      }
      if (this.braking) {
        drag += TUNING.dragBrake;
        accel -= TUNING.brakeScrub;
      }
      accel -= drag * this.speed * this.speed;

      // Carving costs speed — the harder the arc, the more you scrub.
      accel -= TUNING.scrub * Math.abs(curvature) * this.speed * this.speed;

      // Riding on one end of the board digs the other end in. Buttering has to
      // cost something or it would simply be free style points.
      if (this.pressing) accel -= TUNING.butterScrub;
    } else {
      // In the air only the thin drag of the wind applies.
      accel -= TUNING.dragBase * 0.35 * this.speed * this.speed;
    }

    this.speed = clamp(this.speed + accel * dt, 0, TUNING.maxSpeed);
    this.topSpeed = Math.max(this.topSpeed, this.speed);

    /* ---- 4. Move ---------------------------------------------------- */
    this.position.x += fx * this.speed * dt;
    this.position.z += fz * this.speed * dt;

    const ground = c.groundHeight(this.position.x, this.position.z);
    this.justLaunched = false;
    this.justLanded = 0;
    this.skated = 0;
    this.popped = 0;
    this.trickLanded = null;
    this.trickFailed = false;

    if (input.jumpPressed && this.grounded) {
      if (this.speed < TUNING.skateSpeed) {
        // Too slow to ollie usefully, so the same button skates instead: a
        // shove down the fall line to get moving again.
        this.speed = Math.min(TUNING.maxSpeed, this.speed + TUNING.skatePush);
        this.skated = 1;
      } else {
        // Popping right at the lip is what a rider actually times, and it is
        // worth real height. Anywhere else on the ramp is an ordinary ollie.
        const phase = c.kickerPhase(this.position.x, this.position.z);
        const popped = phase > TUNING.popPhase;
        this.grounded = false;
        this.vy = Math.max(this.vy, 0) + TUNING.ollie * (popped ? 1 + TUNING.popBoost : 1);
        this.justLaunched = true;
        this.popped = popped ? 1 : 0;
        this._beginAir(popped);
      }
    }

    /* ---- 5. Vertical: one rule for riding, launching and landing ------
     *
     * The slope is measured *behind* the board only. Sampling forwards is what
     * makes a rider chatter at a kicker's lip: a sample spanning the drop reads
     * as a near-vertical dive and throws them at the ground instead of into
     * the air.
     */
    const d = 0.6;
    const back = c.groundHeight(this.position.x - fx * d, this.position.z - fz * d);
    const surfaceSlope = (ground - back) / d;
    const surfaceRate = this.speed * surfaceSlope; // how fast the snow is dropping
    const wasGrounded = this.grounded;

    if (wasGrounded) {
      // Snow can push you up but never pull you down faster than gravity, so
      // the board tracks the surface only as far as gravity allows.
      const tracked = Math.max(surfaceRate, this.vy - TUNING.gravity * dt);

      // Leaving the ground is a question of *separation speed*, not of clearing
      // some distance this frame. Anything else flickers the rider on and off
      // the snow every time the pitch steepens slightly — which silently
      // cancels the ground friction, the spray and the powder drag with it.
      if (tracked - surfaceRate > TUNING.leaveSpeed) {
        this.grounded = false;
        this.vy = tracked;
        this.position.y += this.vy * dt;
        this.airTime = dt;
        this.justLaunched = this.vy > 1.2;
        this._beginAir();
      } else {
        this.vy = surfaceRate;
        this.position.y = ground;
      }
    } else {
      this.vy -= TUNING.gravity * dt;
      const nextY = this.position.y + this.vy * dt;

      if (nextY > ground) {
        this.position.y = nextY;
        this.airTime += dt;
      } else {
        this.position.y = ground;
        this.grounded = true;
        this.longestAir = Math.max(this.longestAir, this.airTime);

        // Project the landing velocity onto the slope. The component running
        // along the surface is kept — which is why landing on a steep
        // transition gives your speed back — while the component driven into
        // the snow is the impact, and only that part costs you.
        const inv = 1 / Math.sqrt(1 + surfaceSlope * surfaceSlope);
        const along = (this.speed + this.vy * surfaceSlope) * inv;
        const perp = Math.abs(this.vy - this.speed * surfaceSlope) * inv;

        this.speed = clamp(along * (1 - clamp((perp - 6) / 30, 0, 0.4)), 0, TUNING.maxSpeed);
        this.vy = this.speed * surfaceSlope;
        this.justLanded = perp;
        if (perp > TUNING.landHardImpact) this.landedHard = 1;
        this._judgeLanding();
        this.airTime = 0;
      }
    }

    if (this.grounded) this.airTime = 0;
    this.landedHard = damp(this.landedHard, 0, 6, dt);
    if (this.stumbleTime > 0) this.stumbleTime = Math.max(0, this.stumbleTime - dt);

    this._animate(dt, slope, n);
  }

  /** Resets the per-air trick bookkeeping. Called however the rider left the snow. */
  _beginAir(popped = false) {
    this.spinFrom = this.boardYaw;
    this.spinDegrees = 0;
    this.spinPeak = 0;
    this.grabTime = 0;
    this.grabbing = false;
    this.grabType = null;
    this.airPopped = popped;
    // Armed only once the stick has been centred since take-off — see the
    // airborne branch of update() for why.
    this.spinArmed = false;
    // A butter does not survive take-off: the board's rotation so far is
    // already in `boardYaw`, and leaving the press open would let a ground spin
    // keep winding for free in the air.
    if (this.pressing) {
      this._endPress();
      this.pressing = false;
    }
  }

  /* ---- Butters -------------------------------------------------- */

  _beginPress() {
    this.pressFrom = this.boardYaw;
    this.pressDegrees = 0;
  }

  /**
   * Letting the board back down. Whatever rotation it swung through is judged
   * exactly like a landing — a half turn rides away switch — except that
   * getting it wrong costs speed rather than the run. A crash out of a butter
   * would make the whole move too expensive to ever practise.
   */
  _endPress() {
    const a = Math.abs(angleDelta(this.yaw, this.boardYaw));
    const align = Math.min(a, Math.PI - a);
    const halfTurns = Math.round(this.pressDegrees / 180);

    this.switchStance = a > Math.PI * 0.5;
    const settled = this.yaw + (this.switchStance ? Math.PI : 0);
    this.boardYaw = settled + angleDelta(settled, this.boardYaw);

    // Sideways at the moment you let it down and the edge bites.
    if (align > TUNING.butterCatch) this.speed *= 0.55;
    else if (align > TUNING.landCleanTol) this.speed *= 0.85;

    if (halfTurns > 0 && align < TUNING.butterCatch) {
      this.groundTrick = {
        halfTurns,
        nose: this.pressDir > 0,
        clean: align < TUNING.landCleanTol,
      };
    }
    this.pressDegrees = 0;
  }

  /**
   * Decides what the landing was worth.
   *
   * The only thing that matters is the angle between where the board points and
   * where the rider is actually travelling — and both forward *and* switch (180
   * out) are perfectly good ways to ride away, which is why the test folds the
   * angle into a quarter turn before comparing.
   */
  _judgeLanding() {
    const a = Math.abs(angleDelta(this.yaw, this.boardYaw));
    const align = Math.min(a, Math.PI - a);
    this.switchStance = a > Math.PI * 0.5;

    // Re-base the board next to the travel direction. `boardYaw` free-runs so
    // that a spin accumulates honestly, but left alone a rider who has just put
    // down two full rotations would visibly unwind both of them as the board
    // settles. This picks the congruent angle nearest the settle target, which
    // is the same orientation on screen and a short move away.
    const settled = this.yaw + (this.switchStance ? Math.PI : 0);
    this.boardYaw = settled + angleDelta(settled, this.boardYaw);

    if (align > TUNING.landSketchyTol) {
      this.trickFailed = true;
      this.crash('You landed sideways.');
      return;
    }

    // Still holding the grab as you touch down is a scrappy landing, same as
    // coming in crooked: you have no hands out and no time to absorb.
    const clean = align < TUNING.landCleanTol && !this.grabbing;
    if (!clean) this.speed *= TUNING.landSketchyScrub;

    this.trickLanded = {
      clean,
      stomped: clean && align < TUNING.landStompTol,
      spinDegrees: this.spinDegrees,
      // Spun out and brought back: the net rotation is nothing, but the move
      // happened and it is worth something.
      shifty: this.spinPeak >= 60 && this.spinDegrees < 30,
      grabTime: this.grabTime,
      grabType: this.grabType,
      popped: !!this.airPopped,
      switchStance: this.switchStance,
      airTime: this.airTime,
    };
  }

  /** Where the spray should come from: the outside edge of the board. */
  sprayOrigin(out) {
    const side = -Math.sign(this.lean || 1);
    const rx = Math.cos(this.boardYaw);
    const rz = -Math.sin(this.boardYaw);
    const off = 0.17 + 0.1 * this.carveIntensity;
    out.set(
      this.position.x + rx * side * off - Math.sin(this.boardYaw) * 0.35,
      this.position.y + 0.06,
      this.position.z + rz * side * off - Math.cos(this.boardYaw) * 0.35
    );
    return out;
  }

  /**
   * A clip rather than a crash.
   *
   * Clattering into somebody at speed should cost you the line, the speed and
   * the streak — but not the whole descent. A run that ends because a skier
   * wandered across the piste is a run you never really got to ride, and the
   * mountain is three kilometres long.
   */
  stumble() {
    if (this.crashed || this.stumbleTime > 0) return false;
    this.stumbleTime = TUNING.stumbleSeconds;
    this.speed *= TUNING.stumbleScrub;
    // Knocked off whatever edge you were on. Deliberately *not* a kick to the
    // edge spring as well: a hard involuntary carve at eighty km/h puts you in
    // the trees, which is the crash this was meant to replace.
    this.lean = 0;
    this.leanVel = 0;
    this.pressing = false;
    return true;
  }

  crash(reason = 'You caught an edge.') {
    if (this.crashed) return;
    this.crashed = true;
    this.crashReason = reason;
    this.grounded = false;
    this.vy = 4.5 + this.speed * 0.12;
    this._tumble.set(
      (Math.random() * 2 - 1) * 7,
      (Math.random() * 2 - 1) * 5,
      6 + Math.random() * 7
    );
  }

  _updateCrash(dt) {
    // Tumble out: keep the momentum, add gravity, spin, then slide to a stop.
    this.speed = Math.max(0, this.speed - 11 * dt);
    this.position.x += Math.sin(this.yaw) * this.speed * dt;
    this.position.z += Math.cos(this.yaw) * this.speed * dt;
    this.vy -= TUNING.gravity * dt;
    this.position.y += this.vy * dt;

    const ground = this.course.groundHeight(this.position.x, this.position.z);
    if (this.position.y < ground + 0.35) {
      this.position.y = ground + 0.35;
      this.vy *= -0.32;                       // a couple of bounces
      this._tumble.multiplyScalar(0.55);
      if (Math.abs(this.vy) < 0.6) this.vy = 0;
    }

    const m = this.model;
    m.root.position.copy(this.position);
    m.tilt.rotation.x += this._tumble.z * dt;
    m.tilt.rotation.y += this._tumble.y * dt;
    m.tilt.rotation.z += this._tumble.x * dt;
    this._tumble.multiplyScalar(Math.exp(-1.6 * dt));
  }

  /* ================================================================
   * Model animation
   * ============================================================== */

  _animate(dt, slope, n) {
    const m = this.model;
    const leanRatio = clamp(this.lean / TUNING.maxLean, -1.3, 1.3);

    m.root.position.copy(this.position);
    m.root.rotation.y = this.boardYaw;

    // Pitch follows the fall line; in the air it eases toward level.
    const targetPitch = this.grounded ? -Math.atan(slope) : -0.1;
    this._modelPitch = damp(this._modelPitch, targetPitch, this.grounded ? 9 : 3, dt);

    // Roll = edge angle, plus whatever cross-slope the board is sitting on.
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    const crossSlope = this.grounded ? -(n.x * rx + n.z * rz) / Math.max(n.y, 0.2) : 0;
    // Bank with the terrain and with the edge — but the visual roll is
    // deliberately a fraction of the physical edge angle. Rendering the full
    // 35 degrees, and then stacking the upper body's counter-lean on top of it
    // inside the same transform chain, lays the rider flat on their side.
    const targetRoll = clamp(Math.atan(crossSlope) * 0.55 - this.lean * 0.72, -0.8, 0.8);
    this._modelRoll = damp(this._modelRoll, targetRoll, 16, dt);

    // A press tips the whole board on its end, so it goes on the pitch rather
    // than into the body: nose down and tail in the air, or the reverse.
    this.pressAmount = damp(this.pressAmount, this.pressing ? 1 : 0, 9, dt);
    const pressPitch = this.pressAmount * this.pressDir * 0.34;

    m.tilt.rotation.set(this._modelPitch + pressPitch, 0, this._modelRoll);

    // Absorb and extend. A rider is never a fixed height: they compress into a
    // carve, fold up on landing, and stand tall off a lip. `landedHard` decays
    // over about a fifth of a second, which is exactly the absorb.
    let crouch = 0.22 * Math.abs(leanRatio);
    if (this.tucking) crouch += 0.3;
    if (this.braking) crouch += 0.18;
    crouch += this.landedHard * 0.42;
    // Buttering, the weight is deliberately dumped over one end: knees bent
    // low, arms out. Standing up straight through a press reads as a glitch.
    crouch += this.pressAmount * 0.2;
    if (!this.grounded) {
      // Extend off the lip, then tuck up as the rotation builds.
      const spinTuck = clamp(this.spinDegrees / 360, 0, 1) * 0.16;
      crouch += -0.14 + spinTuck + (this.grabbing ? 0.26 : 0);
    }
    this._crouch = damp(this._crouch, crouch, this.grounded ? 12 : 8, dt);
    m.body.position.y = -this._crouch;
    m.body.rotation.x = this._crouch * 0.55 + (this.tucking ? 0.28 : 0);

    // Weight moves fore and aft with acceleration — driven back under power,
    // forward over the nose when the snow is dragging you down.
    const surge = clamp((this.speed - this._lastSpeed) / Math.max(dt, 1e-4) / 12, -1, 1);
    this._lastSpeed = this.speed;
    this._weight = damp(this._weight, surge, 5, dt);
    m.body.position.z = this._weight * -0.06 + this.pressAmount * this.pressDir * 0.16;

    // The upper body leans a little further into the arc than the board does,
    // and the shoulders counter-rotate — the shape that makes a carve read as
    // a carve rather than as a topple.
    //
    // Riding switch, the whole stance mirrors: shoulders the other way round,
    // and the lead arm becomes the trailing one.
    const facing = this.switchStance && this.grounded ? -1 : 1;
    m.body.rotation.z = -leanRatio * 0.16;
    m.body.rotation.y = leanRatio * 0.3 * facing;

    // Through a spin the body winds up and unwinds against the board, so the
    // rotation looks driven rather than like the model being spun by a stick.
    if (!this.grounded && this.spinDegrees > 20) {
      const wind = clamp(this.spinDegrees / 220, 0, 1) * Math.sign(this.steer || 1);
      m.body.rotation.y -= wind * 0.5;
    }

    // Lead arm drops toward the snow through the turn; trailing arm counters.
    const reach = leanRatio * facing;
    m.armFront.rotation.z = -0.55 - reach * 0.95;
    m.armBack.rotation.z = 0.5 - reach * 0.85;

    if (!this.grounded) {
      if (this.grabbing) {
        // Reaching down to the board. Which hand goes where, and how far the
        // body folds over it, is what tells the four grabs apart at chase-camera
        // distance — the points would otherwise be the only difference.
        const grab = clamp(this.grabTime * 6, 0, 1);
        const pose = GRAB_POSES[this.grabType] ?? GRAB_POSES.indy;
        m.armFront.rotation.z = damp(m.armFront.rotation.z, pose.front, 18, dt);
        m.armBack.rotation.z = damp(m.armBack.rotation.z, pose.back, 14, dt);
        m.body.rotation.x += grab * pose.fold;
        m.body.rotation.z += grab * pose.tweak;
      } else {
        const t = this.airTime * 5;
        m.armFront.rotation.z += Math.sin(t) * 0.22 - 0.35;
        m.armBack.rotation.z += Math.cos(t) * 0.2 + 0.3;
      }
    }

    // The board runs slightly across its own path in a carve.
    m.board.rotation.y = -leanRatio * 0.14;
    m.head.rotation.y = leanRatio * 0.42 * facing + 0.15 * facing;

    // Clipped somebody: arms up, and a wobble that decays over the second or so
    // it takes to gather yourself back up. Without it the speed simply vanishes
    // and the hit reads as the game glitching rather than as contact.
    if (this.stumbleTime > 0) {
      const w = this.stumbleTime / TUNING.stumbleSeconds;
      const t = (TUNING.stumbleSeconds - this.stumbleTime) * 19;
      m.tilt.rotation.z += Math.sin(t) * 0.34 * w;
      m.tilt.rotation.x += Math.sin(t * 0.7 + 1.2) * 0.16 * w;
      m.armFront.rotation.z -= 0.9 * w;
      m.armBack.rotation.z += 0.9 * w;
    }
  }
}

/* ==================================================================
 * Model
 * ================================================================ */

const MAT = {
  jacket: new THREE.MeshStandardMaterial({ color: '#f4762a', roughness: 0.72, flatShading: true }),
  jacketDark: new THREE.MeshStandardMaterial({ color: '#d2551a', roughness: 0.75, flatShading: true }),
  pants: new THREE.MeshStandardMaterial({ color: '#31589c', roughness: 0.85, flatShading: true }),
  pantsDark: new THREE.MeshStandardMaterial({ color: '#26457c', roughness: 0.85, flatShading: true }),
  boots: new THREE.MeshStandardMaterial({ color: '#1b2028', roughness: 0.7, flatShading: true }),
  skin: new THREE.MeshStandardMaterial({ color: '#e8b48c', roughness: 0.8, flatShading: true }),
  beanie: new THREE.MeshStandardMaterial({ color: '#f2b431', roughness: 0.9, flatShading: true }),
  beanieBand: new THREE.MeshStandardMaterial({ color: '#e2762a', roughness: 0.9, flatShading: true }),
  goggles: new THREE.MeshStandardMaterial({ color: '#7fd4f0', roughness: 0.15, metalness: 0.4, emissive: '#20505f', emissiveIntensity: 0.35 }),
  deck: new THREE.MeshStandardMaterial({ color: '#242a33', roughness: 0.5, flatShading: true }),
  base: new THREE.MeshStandardMaterial({ color: '#e9f1f8', roughness: 0.25, metalness: 0.15, flatShading: true }),
};

function part(geo, mat, x, y, z, parent) {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

/**
 * The snowboard: a lofted deck with sidecut at the waist and kicked tips,
 * built from a strip of quads so it keeps the faceted look of the scenery.
 */
function buildBoardGeometry() {
  const N = 16;
  const length = 1.62;
  const thickness = 0.035;
  const top = [];
  const bottom = [];

  for (let i = 0; i <= N; i++) {
    const s = (i / N) * 2 - 1;
    const z = (s * length) / 2;
    // Rounded nose and tail, waist narrower than the tips.
    const round = Math.sqrt(Math.max(0, 1 - Math.pow(Math.abs(s), 8)));
    const w = 0.166 * round * (1 - 0.17 * (1 - s * s));
    const kick = 0.085 * Math.pow(Math.abs(s), 6);
    top.push([-w, kick + thickness, z], [w, kick + thickness, z]);
    bottom.push([-w, kick, z], [w, kick, z]);
  }

  const pos = [];
  const push = (a, b, c) => pos.push(...a, ...b, ...c);
  const quad = (a, b, c, d) => { push(a, b, c); push(a, c, d); };

  for (let i = 0; i < N; i++) {
    const t0 = top[i * 2], t1 = top[i * 2 + 1];
    const t2 = top[i * 2 + 2], t3 = top[i * 2 + 3];
    const b0 = bottom[i * 2], b1 = bottom[i * 2 + 1];
    const b2 = bottom[i * 2 + 2], b3 = bottom[i * 2 + 3];
    quad(t0, t2, t3, t1);   // deck
    quad(b0, b1, b3, b2);   // base
    quad(t0, t1, b1, b0);   // (degenerate at the tips, harmless)
    quad(t0, b0, b2, t2);   // left edge
    quad(t1, t3, b3, b1);   // right edge
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  geo.translate(0, -thickness * 0.5, 0);
  return geo;
}

function buildRiderModel() {
  const root = new THREE.Group();
  root.name = 'rider';

  const tilt = new THREE.Group();   // edge angle + slope alignment
  root.add(tilt);

  const board = new THREE.Group();
  tilt.add(board);
  part(buildBoardGeometry(), MAT.deck, 0, 0.035, 0, board);
  // A bright base peeking out reads as the edge catching light mid-carve.
  const base = part(buildBoardGeometry(), MAT.base, 0, 0.028, 0, board);
  base.scale.set(0.96, 0.5, 0.99);

  // A top-sheet stripe down the deck: the board is seen almost edge-on from
  // the chase camera, and this is what keeps it from vanishing under the boots.
  part(new THREE.BoxGeometry(0.075, 0.012, 1.28), MAT.jacket, 0, 0.055, 0, board);

  // Bindings
  for (const bz of [0.34, -0.3]) {
    part(new THREE.BoxGeometry(0.26, 0.05, 0.3), MAT.boots, 0, 0.075, bz, board);
  }

  const body = new THREE.Group();   // everything above the board
  body.position.y = 0.09;
  tilt.add(body);

  // Legs — bent, with the rider's weight over the board.
  for (const [lz, bend] of [[0.33, 0.24], [-0.29, -0.2]]) {
    const leg = new THREE.Group();
    leg.position.set(0, 0, lz);
    leg.rotation.x = bend;
    body.add(leg);
    part(new THREE.BoxGeometry(0.19, 0.46, 0.22), MAT.pants, 0, 0.25, 0, leg);
    part(new THREE.BoxGeometry(0.22, 0.14, 0.28), MAT.boots, 0, 0.05, 0.01, leg);
  }

  // Hips and torso, turned across the board the way a rider stands.
  const torso = new THREE.Group();
  torso.position.y = 0.5;
  torso.rotation.y = Math.PI * 0.5; // face across the board
  body.add(torso);

  // Hips, then a jacket that tapers from waist to shoulder. A single box for
  // the whole torso reads as a cardboard carton at chase-camera distance;
  // the taper and the collar are what make it read as a person.
  part(new THREE.BoxGeometry(0.34, 0.2, 0.38), MAT.pantsDark, 0, 0.05, 0, torso);
  part(new THREE.BoxGeometry(0.43, 0.1, 0.45), MAT.jacketDark, 0, 0.19, 0, torso); // hem
  part(new THREE.BoxGeometry(0.36, 0.26, 0.4), MAT.jacket, 0, 0.35, 0, torso);     // waist
  part(new THREE.BoxGeometry(0.46, 0.24, 0.46), MAT.jacket, 0, 0.57, 0, torso);    // chest
  part(new THREE.BoxGeometry(0.32, 0.1, 0.34), MAT.jacketDark, 0, 0.7, 0, torso);  // collar

  // Arms hang from the shoulders and swing for balance. They sit fore and aft
  // along the board, which is where a rider actually holds them.
  const armFront = new THREE.Group();
  armFront.position.set(0.25, 0.66, 0.03);
  torso.add(armFront);
  part(new THREE.BoxGeometry(0.15, 0.28, 0.16), MAT.jacket, 0.05, -0.13, 0, armFront);
  part(new THREE.BoxGeometry(0.13, 0.24, 0.14), MAT.jacketDark, 0.12, -0.37, 0, armFront);
  part(new THREE.BoxGeometry(0.12, 0.12, 0.13), MAT.boots, 0.15, -0.53, 0, armFront);

  const armBack = new THREE.Group();
  armBack.position.set(-0.25, 0.66, 0.03);
  torso.add(armBack);
  part(new THREE.BoxGeometry(0.15, 0.28, 0.16), MAT.jacket, -0.05, -0.13, 0, armBack);
  part(new THREE.BoxGeometry(0.13, 0.24, 0.14), MAT.jacketDark, -0.12, -0.37, 0, armBack);
  part(new THREE.BoxGeometry(0.12, 0.12, 0.13), MAT.boots, -0.15, -0.53, 0, armBack);

  // Head: helmet with a goggle band.
  const head = new THREE.Group();
  head.position.set(0, 0.78, 0.02);
  torso.add(head);
  part(new THREE.BoxGeometry(0.15, 0.13, 0.15), MAT.skin, 0, -0.07, 0, head);
  // A knitted beanie with a turned-up brim and a bobble, not a helmet — it is
  // the one spot of warm colour up there and it reads from a long way off.
  part(new THREE.IcosahedronGeometry(0.175, 0), MAT.beanie, 0, 0.06, 0, head);
  part(new THREE.CylinderGeometry(0.185, 0.185, 0.075, 8), MAT.beanieBand, 0, -0.03, 0, head);
  part(new THREE.IcosahedronGeometry(0.055, 0), MAT.beanie, 0, 0.23, 0, head);
  part(new THREE.BoxGeometry(0.23, 0.09, 0.07), MAT.goggles, 0, -0.02, 0.13, head);

  root.traverse((o) => { if (o.isMesh) o.castShadow = true; });

  return { root, tilt, board, body, torso, armFront, armBack, head };
}
