import * as THREE from 'three';
import { Course, COURSE } from '../world/Course.js';
import { buildTerrain } from '../world/Terrain.js';
import { buildKickers } from '../world/Kickers.js';
import { buildForest } from '../world/Trees.js';
import { buildVillage } from '../world/Village.js';
import { buildSky, buildMountains, buildLighting, HORIZON_COLOR } from '../world/Environment.js';
import { Rider, RIDER_TUNING } from '../entities/Rider.js';
import { Skiers } from '../entities/Skiers.js';
import { SnowSpray } from '../fx/SnowSpray.js';
import { ChaseCamera } from './ChaseCamera.js';
import { Input } from './Input.js';
import { HUD } from './HUD.js';
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

export class Game {
  constructor(renderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    // Thick enough that the far snowfields reach the fog colour before the
    // world runs out, so the mountains rise out of haze instead of standing
    // behind a bright seam.
    this.scene.fog = new THREE.FogExp2(HORIZON_COLOR.getHex(), 0.0026);

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.5, 9000);
    this.chase = new ChaseCamera(this.camera);
    this.input = new Input();
    this.hud = new HUD();

    this._sprayPos = new THREE.Vector3();

    this._buildWorld();

    this.state = 'title';
    this.elapsed = 0;
    this.crashTimer = 0;
    this.finishTimer = 0;
    this.previewTime = 0;

    this.hud.onAction({
      onStart: () => this.start(),
      onRestart: () => this.restart(),
    });

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
    this.backdrop.add(buildMountains());
    this.scene.add(this.backdrop);

    this.lights = buildLighting(this.scene);

    this.scene.add(buildTerrain(course));
    this.scene.add(buildKickers(course));

    const village = buildVillage(course);
    this.scene.add(village.group);

    const forest = buildForest(course, { exclude: village.exclude });
    this.scene.add(forest.group);
    this.trees = forest.colliders;

    this.skiers = new Skiers(course);
    this.scene.add(this.skiers.group);

    this.rider = new Rider(course);
    this.scene.add(this.rider.model.root);

    this.spray = new SnowSpray();
    this.scene.add(this.spray.points);
  }

  /* ================================================================
   * State
   * ============================================================== */

  reset() {
    this.rider.reset();
    this.skiers.reset();
    this.spray.reset();
    this.chase.reset(this.rider);
    this.elapsed = 0;
    this.crashTimer = 0;
    this.finishTimer = 0;
    this._finishShown = false;
    this.hud.resetTicker();
    this.hud.update(this.rider, 0, 0);
  }

  start() {
    if (this.state === 'riding') return;
    this.reset();
    this.state = 'riding';
    this.input.clear();
    this.hud.hideOverlay();
    this.hud.setHudVisible(true);
  }

  /** Straight back into a fresh run — a retry should never cost a second click. */
  restart() {
    this.state = 'title';
    this.start();
  }

  _crash(reason) {
    if (this.state !== 'riding') return;
    this.rider.crash(reason);
    this.state = 'crashing';
    this.crashTimer = 0;
    this.chase.kick(1.6);
    this.spray.burst(this.rider.position, 120, 5.5 + this.rider.speed * 0.18, this.rider.powder);
  }

  _finish() {
    if (this.state !== 'riding') return;
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

    if (this.state === 'title') {
      this.previewTime += dt;
      this.chase.preview(this.rider, this.previewTime);
      this._updateBackdrop();
      this.spray.update(dt);
      this.input.endFrame();
      return;
    }

    if (this.input.restartPressed && this.state !== 'riding') {
      this.input.endFrame();
      this.restart();
      return;
    }

    let scale = 1;
    if (this.state === 'crashing') {
      this.crashTimer += dt;
      scale = 0.36;
      if (this.crashTimer > CRASH_SLOWMO) {
        this.state = 'crashed';
        this.hud.showCrash(this.rider, this.elapsed, this.rider.position.z);
      }
    } else if (this.state === 'finished') {
      this.finishTimer += dt;
      scale = 0.85;
      // Let the rider coast past the banner for a beat before the results land.
      if (this.finishTimer > 1.6 && !this._finishShown) {
        this._finishShown = true;
        this.hud.showFinish(this.rider, this.finishElapsed);
      }
    }

    const sdt = dt * scale;

    if (this.state === 'riding') {
      this.elapsed += dt;
      this.rider.update(sdt, this.input);
      this._checkHazards();
    } else if (this.state === 'finished') {
      // Coast into the village with the input ignored.
      this.rider.update(sdt, COASTING);
    } else {
      this.rider.update(sdt, COASTING);
    }

    this.skiers.update(sdt, this.rider.position.z);
    this._emitSpray(sdt);
    this.spray.update(sdt);
    this.chase.update(this.rider, dt);
    this.spray.setViewport(this.renderer.domElement.height, this.camera.fov);
    this._updateBackdrop();
    this.lights.follow(this.rider.position);

    if (this.state === 'riding') {
      this.hud.update(this.rider, this.elapsed, this.rider.position.z / COURSE.finishZ);
    }

    this.input.endFrame();
  }

  /**
   * The sky dome and the mountain ranges track the camera on all three axes,
   * which is what "infinitely distant" means. Following only X and Z looks
   * right at the top of the mountain and then fails badly: four hundred metres
   * of descent later the camera is below the peaks' bases and the whole range
   * hangs upside down out of the sky.
   */
  _updateBackdrop() {
    this.backdrop.position.copy(this.camera.position);
  }

  /* ---------------------------------------------------------------- */

  _emitSpray(dt) {
    const r = this.rider;
    if (r.crashed) {
      // Rooster tail of snow while the wipeout slides out.
      if (r.speed > 2) this.spray.burst(r.position, 3, 2 + r.speed * 0.12, r.powder);
      return;
    }
    if (!r.grounded) return;

    r.sprayOrigin(this._sprayPos);
    const side = -Math.sign(r.lean || 1);
    this.spray.emitCarve(this._sprayPos, r.yaw, side, r.speed, r.carveIntensity + (r.braking ? 0.9 : 0), r.powder, dt);
    this.spray.emitTrail(this._sprayPos, r.yaw, r.speed, r.powder, dt);

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
        const rr = t.r + RIDER_TUNING.riderRadius;
        if (dx * dx + dz * dz < rr * rr) {
          this._crash('You found a tree the hard way.');
          return;
        }
      }
    }

    // Skiers — jumpable, unlike the trees.
    if (heightAboveGround < 1.9 && this.skiers.hits(x, z, RIDER_TUNING.riderRadius)) {
      this._crash('You took out a skier.');
    }
  }

  resize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.spray.setViewport(this.renderer.domElement.height, this.camera.fov);
  }
}

/** A frozen "no input" object used while the rider is not under player control. */
const COASTING = {
  steer: 0,
  tuck: false,
  brake: false,
  jumpPressed: false,
};
