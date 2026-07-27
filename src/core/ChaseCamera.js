import * as THREE from 'three';
import { clamp, damp, angleDelta } from './mathx.js';

/**
 * Third-person chase camera.
 *
 * Three separate lags stacked on top of each other do the work: the camera's
 * own yaw trails the rider's heading, the position trails its ideal offset,
 * and the look-at point trails a spot out in front of the board. Together they
 * give the camera the loose, swinging feel of a following shot rather than the
 * rigidity of a boom arm.
 */

export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.baseFov = 62;
    this._pos = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this.yaw = 0;
    this.roll = 0;
    this.fov = this.baseFov;
    this.shake = 0;
    this._initialised = false;
    this.portrait = 0;
  }

  /**
   * A phone held upright is a tall, narrow window. The camera's field of view
   * is vertical, so portrait spends it all on sky and foreground and leaves a
   * horizontal view barely wider than the piste — you cannot see a tree until
   * it is level with you. Standing further back, widening a little and aiming
   * lower buys back the width without bending the lens into a fisheye.
   */
  setAspect(aspect) {
    this.portrait = clamp((1.25 - aspect) / 0.75, 0, 1);
  }

  reset(rider) {
    this.yaw = rider.yaw;
    this.roll = 0;
    this.fov = this.baseFov;
    this.shake = 0;
    this._initialised = false;
    this.update(rider, 0.016, true);
  }

  /** Slow drifting preview shot used on the title screen. */
  preview(rider, time) {
    const r = 13;
    const a = time * 0.16 + 0.6;
    const p = rider.position;
    this.camera.position.set(p.x + Math.sin(a) * r, p.y + 5.2, p.z - Math.cos(a) * r * 0.75 - 4);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(p.x, p.y + 1.4, p.z + 6);
    if (this.camera.fov !== this.baseFov) {
      this.camera.fov = this.baseFov;
      this.camera.updateProjectionMatrix();
    }
  }

  update(rider, dt, snap = false) {
    const p = rider.position;
    const speedT = clamp(rider.speed / 30, 0, 1.25);
    const lean = clamp(rider.lean / 0.62, -1.3, 1.3);

    // 1. Camera yaw trails the rider's heading — this is the swing on turns.
    this.yaw += angleDelta(this.yaw, rider.yaw) * (snap ? 1 : 1 - Math.exp(-3.6 * dt));

    // 2. Ideal position: behind and above, pulled back and swung wide with speed.
    const dist = (7.3 + speedT * 3.2 + (rider.crashed ? 3 : 0)) * (1 + this.portrait * 0.4);
    const height = 2.95 + this.portrait * 1.1 + speedT * 0.7 + clamp((p.y - rider.course.groundHeight(p.x, p.z)) * 0.25, 0, 2.5);
    const side = -lean * 2.3;

    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    this._desired.set(
      p.x - sy * dist + cy * side,
      p.y + height,
      p.z - cy * dist - sy * side
    );

    if (snap || !this._initialised) {
      this._pos.copy(this._desired);
      this._initialised = true;
    } else {
      // A touch more lag vertically keeps jumps from feeling like an elevator.
      this._pos.x = damp(this._pos.x, this._desired.x, 7.5, dt);
      this._pos.y = damp(this._pos.y, this._desired.y, 5.0, dt);
      this._pos.z = damp(this._pos.z, this._desired.z, 7.5, dt);
    }

    // 3. Look at a point out ahead of the board, also lagged. The aim point
    // sits above the *slope* ahead rather than above the rider, so on a pitch
    // the camera tips down the fall line and you can see what's coming.
    const lead = 7 + speedT * 8;
    const aheadX = p.x + Math.sin(rider.yaw) * lead;
    const aheadZ = p.z + Math.cos(rider.yaw) * lead;
    const aheadY = rider.course.terrainHeight(aheadX, aheadZ) + 2.0 - this.portrait * 2.6;
    this._target.set(aheadX, Math.max(aheadY, p.y + 0.4), aheadZ);
    if (snap) this._look.copy(this._target);
    else {
      this._look.x = damp(this._look.x, this._target.x, 6.5, dt);
      this._look.y = damp(this._look.y, this._target.y, 5.5, dt);
      this._look.z = damp(this._look.z, this._target.z, 6.5, dt);
    }

    // Impact shake, decaying fast.
    this.shake = Math.max(0, this.shake - dt * 3.2);
    const s = this.shake * this.shake * 0.42;

    this.camera.position.copy(this._pos);
    if (s > 0.0001) {
      this.camera.position.x += (Math.random() * 2 - 1) * s;
      this.camera.position.y += (Math.random() * 2 - 1) * s;
    }

    // A little counter-roll sells the arc without making the horizon seasick.
    const targetRoll = -lean * 0.075;
    this.roll = snap ? targetRoll : damp(this.roll, targetRoll, 5, dt);
    this._up.set(Math.sin(this.roll), Math.cos(this.roll), 0).applyAxisAngle(UP, this.yaw);
    this.camera.up.copy(this._up);
    this.camera.lookAt(this._look);

    // Field of view opens up with speed: the cheapest, most effective speed cue.
    const targetFov = this.baseFov + this.portrait * 12 + speedT * 15 + (rider.tucking ? 3 : 0);
    const next = snap ? targetFov : damp(this.fov, targetFov, 2.6, dt);
    if (Math.abs(next - this.fov) > 0.01 || snap) {
      this.fov = next;
      this.camera.fov = next;
      this.camera.updateProjectionMatrix();
      return true; // fov changed — the caller may need to rescale point sprites
    }
    return false;
  }

  kick(amount) {
    this.shake = Math.min(2.2, this.shake + amount);
  }
}

const UP = new THREE.Vector3(0, 1, 0);