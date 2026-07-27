import * as THREE from 'three';
import { clamp, damp, lerp, smoothstep, angleDelta } from '../core/mathx.js';
import { buildRiderModel, solveTwoBone, RIG } from './RiderModel.js';

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
  maxCurvature: 1 / 13, // tightest carve radius, in 1/metres — enough to get
                        // out of the way of something you have just seen
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

  // Overwritten by `Difficulty.js`, which owns the handful of values that
  // differ between the gentle tuning and the original one.
  autoArmSpin: false,
};

export const RIDER_TUNING = TUNING;

/**
 * The four grabs, as places on the board to put a hand.
 *
 * Now that the arms are solved rather than posed, a grab is specified the way a
 * rider would describe it — which hand, and where on the board it goes — and
 * the elbow works itself out. `x` is across the board (positive toward the toe
 * edge) and `z` along it (positive toward the nose), both in metres.
 *
 * `fold` is how far the torso folds over the board and `tweak` is the sideways
 * bone: a method is mostly tweak, an indy is mostly fold. That is what tells
 * them apart from behind, which is the only view the player ever gets.
 */
const GRAB_POSES = {
  indy:   { arm: 'back',  x: 0.17,  z: 0.02,  fold: 0.48, tweak: 0 },
  melon:  { arm: 'front', x: -0.17, z: 0.1,   fold: 0.44, tweak: -0.3 },
  nose:   { arm: 'front', x: 0.0,   z: 0.6,   fold: 0.6,  tweak: 0.12 },
  method: { arm: 'front', x: -0.19, z: -0.02, fold: 0.32, tweak: -0.62 },
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

    // Secondary motion: the bobble on the beanie, on a spring of its own, and
    // where the rider is looking. Neither is driven by anything the physics
    // cares about — they exist because a body that only ever moves where it is
    // told reads as a mannequin being carried down the hill.
    this._bobble = { x: 0, z: 0, vx: 0, vz: 0 };
    this._look = 0;
    this._lastYaw = this.yaw;

    this.model.root.position.copy(this.position);
    this.model.root.rotation.set(0, this.yaw, 0);
    this.model.tilt.rotation.set(0, 0, 0);
    this.model.body.rotation.set(0, 0, 0);
    this.model.body.position.set(0, RIG.boardTop + RIG.hipHeight, 0);
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
      //
      // Except on the gentler tuning, where it is switched off: to anyone still
      // learning, a rule that silently withholds the spin until you let go
      // reads as spinning simply not working.
      if (input.steer === 0 || TUNING.autoArmSpin) this.spinArmed = true;

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

    // Landing sideways used to end the run, and it was by some distance the
    // most common way a run ended: coming off a kicker at a hundred km/h with
    // any rotation at all, an eye for the exact moment the board comes back
    // round is a lot to ask. It is a hard stumble now — you lose most of your
    // speed and the streak, and you have to gather it back up — which is what
    // washing out actually feels like. Trees still end it.
    if (align > TUNING.landSketchyTol) {
      this.trickFailed = true;
      this.stumble();
      this.boardYaw = settled;   // slammed back square rather than left crooked
      this.switchStance = false;
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
      // Grabbing, the board comes up to meet the hand as much as the hand goes
      // down to meet the board — that is most of how a grab is actually done,
      // and the arm alone cannot span the gap.
      crouch += -0.14 + spinTuck + (this.grabbing ? 0.36 : 0);
    }
    // Capped, because the knees have to make up every centimetre of it: fold
    // them much past this and the two-bone solve doubles the leg back on
    // itself and the skinned surface turns inside out at the crease.
    this._crouch = damp(this._crouch, clamp(crouch, -0.2, 0.38), this.grounded ? 12 : 8, dt);
    m.body.position.y = RIG.boardTop + RIG.hipHeight - this._crouch;
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

    this._poseLegs(dt);
    this._poseArms(dt, leanRatio, facing);

    // The board runs slightly across its own path in a carve.
    m.board.rotation.y = -leanRatio * 0.14;
    m.neck.rotation.z = -leanRatio * 0.12;

    // Where the rider is looking. A carve is led with the head — you look
    // through the turn well before the board gets there — so the head tracks
    // the *rate* of turn rather than the edge angle, and keeps looking that
    // way for a moment after the board has come round.
    const turnRate = clamp(angleDelta(this._lastYaw, this.yaw) / Math.max(dt, 1e-4) / 1.6, -1, 1);
    this._lastYaw = this.yaw;
    this._look = damp(this._look, turnRate, 6, dt);
    m.head.rotation.y = (leanRatio * 0.28 + this._look * 0.5) * facing + 0.15 * facing;
    // Chin down over the nose in a tuck, up and level in the air.
    m.head.rotation.x = this.tucking ? 0.24 : this.grounded ? 0.04 : -0.12;

    // Clipped somebody: arms up, and a wobble that decays over the second or so
    // it takes to gather yourself back up. Without it the speed simply vanishes
    // and the hit reads as the game glitching rather than as contact.
    if (this.stumbleTime > 0) {
      const w = this.stumbleTime / TUNING.stumbleSeconds;
      const t = (TUNING.stumbleSeconds - this.stumbleTime) * 19;
      m.tilt.rotation.z += Math.sin(t) * 0.34 * w;
      m.tilt.rotation.x += Math.sin(t * 0.7 + 1.2) * 0.16 * w;
      m.torso.rotation.x = Math.sin(t * 1.3) * 0.12 * w;
    } else {
      m.torso.rotation.x = 0;
    }

    this._swingBobble(dt);
  }

  /**
   * The bobble on the beanie, as a damped spring hanging off the head.
   *
   * It is driven by the head's own acceleration rather than by any input, so
   * it lags every landing, whips through a spin and settles on a straight
   * run — which is exactly the tell that separates a character from a prop.
   * Two axes are enough: it never needs to know it is a pendulum.
   */
  _swingBobble(dt) {
    const b = this._bobble;
    const m = this.model;
    // Head world position, cheaply: the bobble only needs to know how hard the
    // head is being thrown about, and the tilt group carries all of that.
    const driveX = -m.tilt.rotation.z * 2.2 - this._weight * 0.3;
    const driveZ = m.tilt.rotation.x * 1.8 + (this.grounded ? 0 : -0.5);

    const stiffness = 58;
    const damping = 7.5;
    b.vx += (driveX - b.x) * stiffness * dt - b.vx * damping * dt;
    b.vz += (driveZ - b.z) * stiffness * dt - b.vz * damping * dt;
    b.x = clamp(b.x + b.vx * dt, -1.1, 1.1);
    b.z = clamp(b.z + b.vz * dt, -1.1, 1.1);

    m.bobble.rotation.z = b.x * 0.5;
    m.bobble.rotation.x = b.z * 0.5;
  }

  /**
   * The boots are bolted to the board, so every bit of crouch has to come out
   * of the knees. Solving the legs to the bindings — rather than posing them
   * and hoping — is what stops the feet sinking through the deck when the rider
   * compresses, and it means the absorb on a landing is *visible* in the joints
   * rather than being the whole body sliding down a pole.
   */
  _poseLegs(dt) {
    const m = this.model;

    // The bindings, expressed relative to each hip. The body has already been
    // moved for this frame, so subtracting its offset gives the reach the legs
    // have to make up.
    const ankleY = RIG.boardTop + 0.14 - m.body.position.y;
    const legs = [
      [m.legFront, RIG.frontBindingZ],
      [m.legBack, RIG.backBindingZ],
    ];

    for (const [leg, bindingZ] of legs) {
      const targetY = ankleY - leg.root.position.y;
      const targetZ = bindingZ - m.body.position.z - leg.root.position.z;
      solveTwoBone(leg, targetY, targetZ, RIG.thigh, RIG.shin, 1);

      // Keep the boot flat on the board whatever the knee is doing. Without
      // this the foot points wherever the shin happens to end up, which looks
      // like a broken ankle.
      leg.boot.rotation.x = -(leg.root.rotation.x + leg.joint.rotation.x);
    }
  }

  /**
   * Arms, also solved. A grab is now specified as a point on the board and the
   * elbow works itself out, so the hand actually arrives at the edge it is
   * supposed to be holding instead of approximately gesturing at it.
   */
  _poseArms(dt, leanRatio, facing) {
    const m = this.model;
    const reach = leanRatio * facing;

    /**
     * Points the whole arm at a target and then bends the elbow to reach it.
     *
     * The shoulder swings about Y first so the arm faces the target, and the
     * two-bone solve then works in the plane that swing produced. Without the
     * swing every grab looks the same — the elbow can only bend in one plane,
     * so a nose grab and an indy come out as the same downward reach.
     */
    const aim = (arm, tx, ty, tz) => {
      arm.root.rotation.order = 'YXZ';
      arm.root.rotation.y = Math.atan2(tx, tz);
      solveTwoBone(arm, ty, Math.hypot(tx, tz), RIG.upperArm, RIG.forearm, -1);
    };

    /** A point on the board, as a target relative to one shoulder. */
    const boardTarget = (arm, bx, bz) => {
      // Board space -> body space -> torso space. The torso is turned a quarter
      // turn about Y, which swaps the horizontal axes: along-board becomes
      // torso X, across-board becomes torso Z.
      const t = {
        x: -bz - arm.root.position.x,
        y: RIG.boardTop - m.body.position.y - m.torso.position.y - arm.root.position.y,
        z: bx - arm.root.position.z,
      };
      return t;
    };

    // Neutral riding: hands out for balance, the lead one dropping toward the
    // inside of the arc, with a slow sway in the air.
    const sway = this.grounded ? 0 : Math.sin(this.airTime * 5) * 0.09;
    const front = { x: -0.12, y: -0.34 - Math.abs(reach) * 0.06, z: 0.2 + reach * 0.22 + sway };
    const back = { x: 0.12, y: -0.34, z: -0.22 + reach * 0.16 - sway };

    if (!this.grounded && this.grabbing) {
      const pose = GRAB_POSES[this.grabType] ?? GRAB_POSES.indy;
      const grab = clamp(this.grabTime * 6, 0, 1);
      const grabbing = pose.arm === 'front' ? front : back;
      const other = pose.arm === 'front' ? back : front;
      const arm = pose.arm === 'front' ? m.armFront : m.armBack;
      const t = boardTarget(arm, pose.x, pose.z);

      // Blend in over the first sixth of a second, so the hand travels to the
      // board rather than appearing on it.
      grabbing.x = lerp(grabbing.x, t.x, grab);
      grabbing.y = lerp(grabbing.y, t.y, grab);
      grabbing.z = lerp(grabbing.z, t.z, grab);
      // The free arm goes up and out, which is both what a rider does for
      // balance and what stops the two arms overlapping into a single blob.
      other.y += 0.28 * grab;
      other.z -= 0.14 * grab;

      m.body.rotation.x += grab * pose.fold;
      m.body.rotation.z += grab * pose.tweak;
    }

    aim(m.armFront, front.x, front.y, front.z);
    aim(m.armBack, back.x, back.y, back.z);

    // Clipped somebody: hands fly up. Applied on top of the solve, because it
    // is the one moment the rider is not in control of where their arms are.
    if (this.stumbleTime > 0) {
      const w = this.stumbleTime / TUNING.stumbleSeconds;
      m.armFront.root.rotation.x -= 1.1 * w;
      m.armBack.root.rotation.x -= 1.0 * w;
    }
  }
}
