import * as THREE from 'three';
import { clamp, damp } from '../core/mathx.js';

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
  frictionBase: 0.35,     // constant snow friction (m/s^2)
  frictionPowder: 5.5,
  tuckThrust: 1.6,

  maxLean: 0.62,          // ~35 degrees of edge angle
  leanSpeedFloor: 7,      // m/s at which full edge angle becomes available
  leanStiffness: 36,      // spring toward the commanded edge
  leanDamping: 8.5,
  maxCurvature: 1 / 15.5, // tightest carve radius, in 1/metres
  airSteer: 0.95,         // rad/s of yaw authority while airborne
  powderGrip: 0.55,       // edge authority retained in deep snow

  scrub: 0.055,           // speed lost to carving hard
  brakeScrub: 7.5,

  ollie: 5.6,
  leaveSpeed: 1.2,        // m/s of separation before the board is truly airborne
  landHardImpact: 13,
  landSpeedKeep: 0.87,

  riderRadius: 0.62,
};

export const RIDER_TUNING = TUNING;

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

    this._tumble = new THREE.Vector3();
    this._modelPitch = 0;
    this._modelRoll = 0;
    this._crouch = 0;

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
  }

  get forwardX() { return Math.sin(this.yaw); }
  get forwardZ() { return Math.cos(this.yaw); }

  /* ================================================================
   * Physics
   * ============================================================== */

  update(dt, input) {
    if (this.crashed) return this._updateCrash(dt);

    const c = this.course;

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
      // Yaw rate = speed x curvature: a carve of fixed radius, exactly as a
      // real board's sidecut behaves. Turning gets quicker as you go faster.
      this.yaw += curvature * this.speed * dt;
    } else {
      this.yaw += input.steer * TUNING.airSteer * dt;
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
      accel -= TUNING.frictionBase + this.powder * TUNING.frictionPowder;

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

    if (input.jumpPressed && this.grounded) {
      this.grounded = false;
      this.vy = Math.max(this.vy, 0) + TUNING.ollie;
      this.justLaunched = true;
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
        this.airTime = 0;
      }
    }

    if (this.grounded) this.airTime = 0;
    this.landedHard = damp(this.landedHard, 0, 6, dt);

    this._animate(dt, slope, n);
  }

  /** Where the spray should come from: the outside edge of the board. */
  sprayOrigin(out) {
    const side = -Math.sign(this.lean || 1);
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    const off = 0.17 + 0.1 * this.carveIntensity;
    out.set(
      this.position.x + rx * side * off - Math.sin(this.yaw) * 0.35,
      this.position.y + 0.06,
      this.position.z + rz * side * off - Math.cos(this.yaw) * 0.35
    );
    return out;
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
    m.root.rotation.y = this.yaw;

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

    m.tilt.rotation.set(this._modelPitch, 0, this._modelRoll);

    // Crouch: low and coiled through hard carves, tucked for speed, absorbing
    // on landing, extended in the air.
    let crouch = 0.22 * Math.abs(leanRatio);
    if (this.tucking) crouch += 0.3;
    if (this.braking) crouch += 0.18;
    if (!this.grounded) crouch -= 0.12;
    crouch += this.landedHard * 0.32;
    this._crouch = damp(this._crouch, crouch, 12, dt);
    m.body.position.y = -this._crouch;
    m.body.rotation.x = this._crouch * 0.55 + (this.tucking ? 0.28 : 0);

    // The upper body leans a little further into the arc than the board does,
    // and the shoulders counter-rotate — the shape that makes a carve read as
    // a carve rather than as a topple.
    m.body.rotation.z = -leanRatio * 0.16;
    m.body.rotation.y = leanRatio * 0.3;

    // Lead arm drops toward the snow through the turn; trailing arm counters.
    const reach = leanRatio;
    m.armFront.rotation.z = -0.55 - reach * 0.95;
    m.armBack.rotation.z = 0.5 - reach * 0.85;
    if (!this.grounded) {
      const t = this.airTime * 5;
      m.armFront.rotation.z += Math.sin(t) * 0.22 - 0.35;
      m.armBack.rotation.z += Math.cos(t) * 0.2 + 0.3;
    }

    // The board runs slightly across its own path in a carve.
    m.board.rotation.y = -leanRatio * 0.14;
    m.head.rotation.y = leanRatio * 0.42 + 0.15;
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
