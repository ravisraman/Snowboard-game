import * as THREE from 'three';
import { Course, COURSE } from '../world/Course.js';
import { buildTerrain } from '../world/Terrain.js';
import { buildKickers } from '../world/Kickers.js';
import { buildForest, bucketColliders } from '../world/Trees.js';
import { buildVillage } from '../world/Village.js';
import { buildSky, buildMountains, buildClouds, buildLighting, buildSkyProbe, HORIZON_COLOR } from '../world/Environment.js';
import { REFLECTIVE_MATERIALS } from '../entities/RiderModel.js';
import { buildResort } from '../world/Resort.js';
import { Rider, RIDER_TUNING } from '../entities/Rider.js';
import { Skiers } from '../entities/Skiers.js';
import { SnowSpray } from '../fx/SnowSpray.js';
import { GameAudio } from '../fx/Audio.js';
import { SnowTracks } from '../fx/SnowTracks.js';
import { ChaseCamera } from './ChaseCamera.js';
import { Input } from './Input.js';
import { HUD } from './HUD.js';
import { Score } from './Score.js';
import { TouchControls } from './TouchControls.js';
import { difficulty, applyDifficulty, loadDifficulty } from './Difficulty.js';
import { clamp } from './mathx.js';

/**
 * Assembles the world, owns the game state machine and drives the frame loop.
 *
 * States: `title` → `riding` → (`crashing` → `crashed`) | `finished` → `title`…
 * `crashing` is a short slow-motion beat before the overlay appears; it makes
 * a wipeout land as a moment rather than an interruption.
 */

const OUT_OF_BOUNDS = 148;
const CRASH_SLOWMO = 1.15;

/** Below this speed, for this long, the rider is offered a way out. */
const STUCK_SPEED = 2.2;
const STUCK_SECONDS = 2.5;

/** How close to a tree, and how fast, counts as threading it. */
const NEAR_MISS_MARGIN = 1.6;
const NEAR_MISS_SPEED = 12;

export class Game {
  constructor(renderer, quality = {}) {
    this.renderer = renderer;
    this.quality = quality;
    this.scene = new THREE.Scene();
    // Thick enough that the far snowfields reach the fog colour before the
    // world runs out, so the mountains rise out of haze instead of standing
    // behind a bright seam.
    this.scene.fog = new THREE.FogExp2(HORIZON_COLOR.getHex(), quality.fogDensity ?? 0.0026);

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.5, 9000);
    this.chase = new ChaseCamera(this.camera);
    this.input = new Input();
    this.hud = new HUD();
    this.score = new Score();
    this.audio = new GameAudio({ enabled: quality.audio !== false });
    this.touch = new TouchControls(this.input);

    this._sprayPos = new THREE.Vector3();

    // Before anything reads the tuning table.
    this.difficultyName = loadDifficulty();
    applyDifficulty(this.difficultyName);

    this._buildWorld();

    // A steady cross-slope breeze, blowing across the fall line rather than
    // down it — which is what makes the drift read as wind rather than as
    // something the rider is kicking up.
    this._wind = {
      x: -4.6,
      z: 1.4,
      rate: quality.driftRate ?? 26,
      groundAt: (x, z) => this.course.groundHeight(x, z),
    };

    this.state = 'title';
    this.elapsed = 0;
    this.crashTimer = 0;
    this.finishTimer = 0;
    this.previewTime = 0;

    this.hud.onAction({
      onStart: () => this.start(),
      onRestart: () => this.restart(),
      onRescue: () => this.rescue(),
      onMute: () => this.hud.setMuted(this.audio.toggleMuted()),
      onHelp: () => this.toggleHelp(),
      onDifficulty: (name) => this.setDifficulty(name),
    });
    this.hud.setMuted(this.audio.muted);
    this.hud.setDifficulty(this.difficultyName);

    this.reset();
    this.hud.showScreen('title');
  }

  /* ================================================================
   * World construction
   * ============================================================== */

  _buildWorld() {
    const course = new Course();
    this.course = course;

    // Backdrop rides with the camera on X/Z so the peaks stay distant.
    this.backdrop = new THREE.Group();
    this.backdrop.add(buildSky());
    this.backdrop.add(buildMountains(909, this.quality));
    if (this.quality.clouds !== false) this.backdrop.add(buildClouds());
    this.scene.add(this.backdrop);

    this.lights = buildLighting(this.scene, this.quality);

    this.scene.add(buildKickers(course));

    const village = buildVillage(course);
    this.scene.add(village.group);

    this.resort = buildResort(course, this.quality);
    this.scene.add(this.resort.group);

    // The forest goes up before the slope does, so the slope can bake a ring of
    // contact shade into the snow around every trunk.
    const keepClear = (x, z) => village.exclude(x, z) || this.resort.exclude(x, z);
    const forest = buildForest(course, { exclude: keepClear, quality: this.quality });
    this.scene.add(forest.group);
    this.trees = forest.colliders;
    this.forest = forest;

    // The slope bakes contact shade around everything standing on it — trees,
    // rocks, lift towers, marker poles. It is the substitute for a screen-space
    // AO pass, which this scene's kilometre-deep depth range cannot support.
    const standing = bucketColliders([...forest.list, ...this.resort.occluders], 14);
    this.scene.add(buildTerrain(course, { quality: this.quality, occluders: standing }));

    this.skiers = new Skiers(course);
    this.scene.add(this.skiers.group);

    this.rider = new Rider(course);
    this.scene.add(this.rider.model.root);

    // Hand the sky to the few materials that are meant to reflect it.
    const probe = buildSkyProbe(this.renderer);
    for (const mat of REFLECTIVE_MATERIALS) {
      mat.envMap = probe;
      mat.envMapIntensity = 1.1;
      mat.needsUpdate = true;
    }

    this.spray = new SnowSpray(this.quality.maxParticles);
    this.scene.add(this.spray.points);

    this.tracks = new SnowTracks(course, { segments: this.quality.trackSegments });
    this.scene.add(this.tracks.mesh);

    // The tracker's ticks come from the course itself, so the rail cannot
    // disagree with the kickers that are actually out there.
    this.hud.buildTracker(course);
  }

  /* ================================================================
   * State
   * ============================================================== */

  reset() {
    this.rider.reset();
    this.skiers.reset();
    this.spray.reset();
    this.tracks.reset();
    this.score.reset();
    this._grazed = new Set();
    this._bumped = new Set();
    this.chase.reset(this.rider);
    this.elapsed = 0;
    this.crashTimer = 0;
    this.finishTimer = 0;
    this.stuckTimer = 0;
    this.isStuck = false;
    this._finishShown = false;
    this.hud.setStuck(false);
    this.hud.resetTicker();
    this.hud.update(this.rider, 0, 0, this.score);
  }

  /**
   * The controls panel, which doubles as the pause screen.
   *
   * Mid-run it stops the world — the clock included, since reading the controls
   * should never cost you a run. From any of the overlay screens it is just
   * another page, and closing it puts back the one you came from.
   */
  toggleHelp() {
    if (this.state === 'paused') {
      this.state = 'riding';
      this.input.clear();
      this.hud.hideOverlay();
      this.hud.setHudVisible(true);
      this.touch.setVisible(true);
      return;
    }

    if (this.state === 'riding') {
      this.state = 'paused';
      this._helpReturn = null;
      this.input.clear();
      this.audio.quiet();
      this.touch.setVisible(false);
      this.hud.setStuck(false);
      this.hud.showScreen('help');
      return;
    }

    // On an overlay screen already: swap to the panel and back again.
    if (this.hud.currentScreen === 'help') {
      this.hud.showScreen(this._helpReturn ?? 'title');
    } else if (this.hud.currentScreen) {
      this._helpReturn = this.hud.currentScreen;
      this.hud.showScreen('help');
    }
  }

  /**
   * Switches tuning. Safe at any moment, including mid-run: the rider reads the
   * shared tuning table every frame rather than copying it once, so there is no
   * state to migrate and nothing to rebuild.
   */
  setDifficulty(name) {
    this.difficultyName = name;
    applyDifficulty(name);
    this.hud.setDifficulty(name);
  }

  start() {
    // The only place an AudioContext can legally be created on mobile Safari:
    // inside the user gesture that got us here.
    this.audio.unlock();
    if (this.state === 'riding') return;
    this.reset();
    this.state = 'riding';
    this.input.clear();
    this.hud.hideOverlay();
    this.hud.setHudVisible(true);
    this.touch.setVisible(true);
  }

  /** Straight back into a fresh run — a retry should never cost a second click. */
  restart() {
    this.state = 'title';
    this.start();
  }

  /**
   * Drop the rider back onto the groomer where they are, pointed down the
   * fall line with enough speed to get going. The timer keeps running, so it
   * costs you the run rather than ending it.
   */
  rescue() {
    // Only once you are actually bogged down. Ungated, a stray key press drops
    // the rider out of a jump and onto the piste, which reads as the game
    // teleporting you for no reason.
    if (this.state !== 'riding' || !this.isStuck) return;
    const r = this.rider;
    const z = r.position.z;
    r.position.set(this.course.centerX(z), 0, z);
    r.yaw = this.course.trackHeading(z);
    r.speed = 10;
    r.lean = 0;
    r.leanVel = 0;
    r.settle();
    this.tracks.lift();
    this.chase.reset(r);
    this.stuckTimer = 0;
    this.isStuck = false;
    this.hud.setStuck(false);
    this.spray.burst(r.position, 40, 4, 0.6);
  }

  /**
   * Clipping a tree in passing rather than hitting it square. Costs the speed
   * and the streak, and shoves the rider clear so the next frame is not simply
   * the same collision again — deeper, and fatal.
   */
  _brush(tree, dx, dz, d2) {
    const r = this.rider;
    if (!r.stumble()) return;

    const d = Math.max(0.001, Math.sqrt(d2));
    const push = (tree.r + RIDER_TUNING.riderRadius) - d + 0.25;
    r.position.x -= (dx / d) * push;
    r.position.z -= (dz / d) * push;

    this.score.onCrash();
    this.audio.crash();
    this.chase.kick(1.3);
    this.spray.burst(r.position, 40, 4, r.powder);
    this.hud.flashBump('CLIPPED A TREE');
  }

  _crash(reason) {
    if (this.state !== 'riding') return;
    this.touch.setVisible(false);
    this.hud.setStuck(false);
    this.rider.crash(reason);
    this.score.onCrash();
    this.audio.crash();
    this.state = 'crashing';
    this.crashTimer = 0;
    this.chase.kick(1.6);
    this.spray.burst(this.rider.position, 120, 5.5 + this.rider.speed * 0.18, this.rider.powder);
  }

  _finish() {
    if (this.state !== 'riding') return;
    this.touch.setVisible(false);
    this.hud.setStuck(false);
    this.state = 'finished';
    this.finishTimer = 0;
    this.finishElapsed = this.elapsed;
  }

  /* ================================================================
   * Frame
   * ============================================================== */

  update(rawDt) {
    // Clamp dt so an alt-tab or a stall can never tunnel the rider through the
    // world; the integration is stable well past this — it's collision that cares.
    const dt = Math.min(rawDt, 1 / 20);

    // Opening the controls freezes everything, the clock included — looking up
    // what a button does should never cost you the run.
    if (this.input.helpPressed) {
      this.input.endFrame();
      this.toggleHelp();
      return;
    }
    if (this.state === 'paused') {
      this.audio.quiet();
      this.input.endFrame();
      return;
    }

    if (this.state === 'title') {
      this.previewTime += dt;
      this.chase.preview(this.rider, this.previewTime);
      this._updateBackdrop();
      this.spray.update(dt);
      this.audio.quiet();
      this.input.endFrame();
      return;
    }

    // Restart is available at any time, including mid-run: being wedged
    // somewhere unrecoverable should never mean sitting through a timer.
    if (this.input.restartPressed) {
      this.input.endFrame();
      this.restart();
      return;
    }
    if (this.input.rescuePressed && this.state === 'riding') {
      this.input.endFrame();
      this.rescue();
      return;
    }

    let scale = 1;
    if (this.state === 'crashing') {
      this.crashTimer += dt;
      scale = 0.36;
      if (this.crashTimer > CRASH_SLOWMO) {
        this.state = 'crashed';
        this.hud.showCrash(this.rider, this.elapsed, this.rider.position.z, this.score);
      }
    } else if (this.state === 'finished') {
      this.finishTimer += dt;
      scale = 0.85;
      // Let the rider coast past the banner for a beat before the results land.
      if (this.finishTimer > 1.6 && !this._finishShown) {
        this._finishShown = true;
        this.hud.showFinish(this.rider, this.finishElapsed, this.score);
      }
    }

    const sdt = dt * scale;

    if (this.state === 'riding') {
      this.elapsed += dt;
      this.rider.update(sdt, this.input);
      this.score.update(sdt, this.rider);
      if (this.rider.trickLanded) this.score.onTrickLanded(this.rider.trickLanded);
      if (this.rider.groundTrick) this.score.onGroundTrick(this.rider.groundTrick);
      if (this.rider.trickFailed) {
        // Washed out. No longer the end of the run, but it costs the streak and
        // most of the speed, and it needs to look and sound like a mistake.
        this.score.onCrash();
        this.audio.fail();
        this.chase.kick(1.4);
        this.spray.burst(this.rider.position, 60, 5, this.rider.powder);
        this.hud.flashBump('WASHED OUT');
      }
      this._emitAudio();
      this._checkHazards();
      this._trackStuck(dt);
    } else if (this.state === 'finished') {
      // Coast into the village with the input ignored.
      this.rider.update(sdt, COASTING);
    } else {
      this.rider.update(sdt, COASTING);
    }

    this.touch.setAirborne(!this.rider.grounded && this.state === 'riding');
    this.skiers.update(sdt, this.rider.position.z);
    this.resort.update(sdt);
    this.forest.update(sdt);
    this.audio.update(this.rider, this.state === 'riding');
    this.tracks.update(this.rider);
    this._emitSpray(sdt);
    this.spray.update(sdt);
    this.chase.update(this.rider, dt);
    this.spray.setViewport(this.renderer.domElement.height, this.camera.fov);
    this._updateBackdrop();
    this.lights.follow(this.rider.position);

    if (this.state === 'riding') {
      this.hud.update(this.rider, this.elapsed, this.rider.position.z / COURSE.finishZ, this.score);
    }

    this.score.endFrame();
    this.input.endFrame();
  }

  /**
   * The sky dome and the mountain ranges track the camera on all three axes,
   * which is what "infinitely distant" means. Following only X and Z looks
   * right at the top of the mountain and then fails badly: four hundred metres
   * of descent later the camera is below the peaks' bases and the whole range
   * hangs upside down out of the sky.
   */
  /**
   * Watches for the rider grinding to a halt — bogged in deep snow, stopped on
   * the runout, or pointed back up the hill — and offers a way out rather than
   * leaving them to work out that the run is over.
   */
  _trackStuck(dt) {
    const crawling = this.rider.grounded && this.rider.speed < STUCK_SPEED;
    this.stuckTimer = crawling ? this.stuckTimer + dt : 0;
    this.isStuck = this.stuckTimer > STUCK_SECONDS;
    this.hud.setStuck(this.isStuck);
  }

  _updateBackdrop() {
    this.backdrop.position.copy(this.camera.position);
  }

  /* ---------------------------------------------------------------- */

  /** Fires the one-shots off the rider's per-frame event flags. */
  _emitAudio() {
    const r = this.rider;
    if (r.justLaunched) this.audio.ollie();
    if (r.skated) this.audio.skate();
    if (r.justLanded > 2) {
      this.audio.land(r.justLanded, r.powder);
      if (r.powder > 0.5) this.audio.powderPuff();
    }
    if (r.trickLanded) {
      // The award has already been scored by now, so the pitch reflects the
      // multiplier you just earned rather than the one you had.
      if (r.trickLanded.clean) this.audio.trick(this.score.combo);
      else this.audio.fail();
    }
    if (r.groundTrick) {
      if (r.groundTrick.clean) this.audio.trick(this.score.combo);
      else this.audio.fail();
    }
  }

  _emitSpray(dt) {
    const r = this.rider;

    // Weather, not the rider: loose snow streaming off the open slope. It is
    // the only thing in the scene that moves when you are standing still.
    if (this.quality.spindrift !== false) {
      this.spray.emitDrift(r.position, r.yaw, this._wind, dt);
    }

    if (r.crashed) {
      // Rooster tail of snow while the wipeout slides out.
      if (r.speed > 2) this.spray.burst(r.position, 3, 2 + r.speed * 0.12, r.powder);
      return;
    }
    if (!r.grounded) return;

    r.sprayOrigin(this._sprayPos);
    const side = -Math.sign(r.lean || 1);
    this.spray.emitCarve(this._sprayPos, r.boardYaw, side, r.speed, r.carveIntensity + (r.braking ? 0.9 : 0), r.powder, dt);
    this.spray.emitTrail(this._sprayPos, r.boardYaw, r.speed, r.powder, dt);

    if (r.justLanded > 4) {
      this.spray.burst(r.position, Math.round(18 + r.justLanded * 3), 1.6 + r.justLanded * 0.22, r.powder);
      this.chase.kick(clamp(r.justLanded / 22, 0, 1) * 0.9);
    }
  }

  _checkHazards() {
    const r = this.rider;
    const { x, z } = r.position;
    const heightAboveGround = r.position.y - this.course.groundHeight(x, z);

    if (z >= this.course.finishZ) {
      this._finish();
      return;
    }

    // Out of bounds: the powder will normally stop you long before this.
    if (Math.abs(this.course.trackOffset(x, z)) > OUT_OF_BOUNDS) {
      this._crash('You rode off the edge of the resort.');
      return;
    }

    // Trees. You can clear a small one on a big air, but not much more.
    if (heightAboveGround < 5.5) {
      for (const t of this.trees.query(z)) {
        const dx = t.x - x;
        const dz = t.z - z;
        const d2 = dx * dx + dz * dz;
        // How much of the trunk actually bites is a difficulty setting: on the
        // gentle tuning a tree is a smaller obstacle than it looks, which is
        // easier to explain to a seven-year-old than it is to a physicist.
        const rr = t.r * difficulty.treeRadiusScale + RIDER_TUNING.riderRadius;
        if (d2 < rr * rr) {
          // Square on, or a shoulder clipped in passing? The honest test is how
          // far off the travel line the trunk sits, not how deep the overlap
          // got: at thirty metres a second you cross a whole collider between
          // frames, so depth says more about the frame rate than about the hit.
          const lateral = Math.abs(-dx * this.rider.forwardZ + dz * this.rider.forwardX);
          if (lateral > rr * difficulty.treeGlanceFraction) {
            // Geometry decides this, and it decides it every frame the contact
            // lasts. Letting the "already counted" guard fall through to the
            // crash instead made the *second* frame of a graze fatal — you were
            // shoved clear and then killed by the tree you had just cleared.
            if (!this._bumped.has(t)) {
              this._bumped.add(t);
              this._brush(t, dx, dz, d2);
            }
          } else {
            this._crash('You found a tree the hard way.');
          }
          return;
        }
        // Threading a gap at speed is the most fun thing you can do off-piste,
        // so it should pay. Each tree can only do this once per run, or riding
        // slowly past one would tick over and over.
        const near = rr + NEAR_MISS_MARGIN;
        if (d2 < near * near && r.speed > NEAR_MISS_SPEED && !this._grazed.has(t)) {
          this._grazed.add(t);
          this.score.onNearMiss();
        }
      }
    }

    // Skiers — jumpable, unlike the trees, and survivable unlike the trees too.
    // Clattering into one costs you the line, the speed and the streak, but it
    // does not end a three-kilometre descent.
    if (heightAboveGround < 1.9) {
      const hit = this.skiers.hits(x, z, RIDER_TUNING.riderRadius);
      if (hit && !this._bumped.has(hit) && this.rider.stumble()) {
        this._bumped.add(hit);
        this.score.onCrash();          // the streak does not survive it
        this.audio.land(14, r.powder); // a solid thump
        this.chase.kick(1.1);
        this.spray.burst(r.position, 46, 4.5, r.powder);
        this.hud.flashBump();
      }
    }
  }

  resize(width, height) {
    this.camera.aspect = width / height;
    this.chase.setAspect(this.camera.aspect);
    this.camera.updateProjectionMatrix();
    this.spray.setViewport(this.renderer.domElement.height, this.camera.fov);
  }
}

/** A frozen "no input" object used while the rider is not under player control. */
const COASTING = {
  steer: 0,
  tuck: false,
  brake: false,
  press: false,
  grabType: null,
  jumpPressed: false,
};
