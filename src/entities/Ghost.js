import * as THREE from 'three';
import { buildRiderModel } from './RiderModel.js';

/**
 * The rider you were last time you did well here.
 *
 * There was no reason to ride the same mountain twice except a number on a
 * board, and a number is a poor rabbit. A translucent rider running your own
 * best is one a seven-year-old can literally chase and an adult can measure
 * themselves against without anybody else being involved.
 *
 * ---------------------------------------------------------------------------
 * What is recorded, and why so little
 * ---------------------------------------------------------------------------
 * Position, heading and board heading, ten times a second. That is it — no
 * pose, no limbs, no grabs. Three consequences, all of them the point:
 *
 *   - it is small. A 140-second run is about 1,400 samples; at five numbers
 *     each, rounded to two decimals, that is roughly 40 KB of JSON, which
 *     `localStorage` can hold several of without anybody having to think about
 *     quotas.
 *   - it cannot desync. A ghost that replayed *inputs* would have to be
 *     re-simulated, and any change to the physics — a tuning tweak, a new
 *     boost term — would silently invalidate every stored run. Positions are
 *     positions.
 *   - it looks right anyway. The ghost is behind you or ahead of you at
 *     twenty metres, translucent, at speed. What reads at that distance is the
 *     line it takes and how fast it is going, and both of those are exactly
 *     what is stored.
 *
 * The pose is *derived*: the model is leaned into its own turn from the rate of
 * change of heading, which is enough to make it read as riding rather than as
 * a mannequin being dragged along a spline.
 */

/** Samples per second. Ten is smooth once interpolated and cheap to store. */
const RATE = 10;

/** Runs are keyed by mountain *and* tuning: a cruise ghost is not a fair rabbit on original. */
const keyFor = (runId, difficulty) => `alpine-carve.ghost.${runId}.${difficulty}`;

/* ------------------------------------------------------------------
 * Recording
 * ---------------------------------------------------------------- */

export class GhostRecorder {
  constructor() {
    this.reset();
  }

  reset() {
    this.samples = [];
    this._acc = 0;
  }

  /** Called every frame of a run, with the rider being ridden. */
  sample(dt, rider, elapsed) {
    this._acc += dt;
    if (this._acc < 1 / RATE) return;
    this._acc = 0;
    this.samples.push([
      +rider.position.x.toFixed(2),
      +rider.position.y.toFixed(2),
      +rider.position.z.toFixed(2),
      +rider.yaw.toFixed(3),
      +rider.boardYaw.toFixed(3),
    ]);
  }

  /**
   * Stores this run if it beat the stored one, and says whether it did.
   *
   * Scored on distance first and time second, deliberately. A run that ended
   * in a tree at 2,400 m is a better rabbit than one that finished slowly,
   * because the thing being chased is *progress down the mountain* — and a
   * ghost that gets further than you did is the one worth having.
   */
  saveIfBest(runId, difficulty, { finished, elapsed, distance }) {
    if (this.samples.length < RATE) return false;
    const key = keyFor(runId, difficulty);
    const record = { v: 1, rate: RATE, finished, elapsed, distance, samples: this.samples };

    try {
      const prev = JSON.parse(localStorage.getItem(key) ?? 'null');
      if (prev && !better(record, prev)) return false;
      localStorage.setItem(key, JSON.stringify(record));
      return true;
    } catch {
      // Quota, private browsing, or a stored value somebody else wrote. None
      // of them are worth interrupting the results screen over.
      return false;
    }
  }
}

/** Further wins; at the same distance, faster wins. */
function better(a, b) {
  if (a.finished !== b.finished) return a.finished;
  if (a.finished && b.finished) return a.elapsed < b.elapsed;
  return a.distance > b.distance + 1;
}

export function loadGhost(runId, difficulty) {
  try {
    const raw = JSON.parse(localStorage.getItem(keyFor(runId, difficulty)) ?? 'null');
    if (!raw || !Array.isArray(raw.samples) || raw.samples.length < 2) return null;
    return raw;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------
 * Playback
 * ---------------------------------------------------------------- */

export class Ghost {
  /**
   * Built once at world construction and reused for the life of the page, so a
   * restart is not a second character being built and thrown away.
   *
   * It borrows the *player's* character on purpose. Chasing a translucent copy
   * of yourself is the fantasy; chasing a translucent stranger is a different
   * and worse one.
   */
  constructor(characterId) {
    this.model = buildRiderModel(characterId);
    this.root = this.model.root;
    this.root.name = 'ghost';
    this.root.visible = false;

    /* Translucent, unlit-ish and never in the depth buffer.
     *
     * `depthWrite: false` is what stops the ghost from occluding the world
     * behind it through its own transparent pixels, and `castShadow: false`
     * everywhere is what stops a translucent rider from throwing a solid black
     * shadow across the piste — which was the first thing that gave it away as
     * a second rider rather than a memory. */
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = false;
      o.receiveShadow = false;
      /* One flat blue for the whole figure, rather than a faded copy of the
       * character's own colours.
       *
       * The faded copy was the obvious version and it was nearly invisible: a
       * translucent pale rider against bright snow is a light thing on a light
       * thing, which is exactly the problem the collectible stars had. What
       * reads at twenty metres is a *silhouette in a colour the mountain does
       * not contain*, so the ghost is a deep blue that no snow, tree or rider
       * on this hill is anywhere near, and the texture goes entirely. */
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      o.material = mats.map(() => new THREE.MeshStandardMaterial({
        color: '#17457f',
        emissive: '#2f9bff',
        emissiveIntensity: 0.45,
        roughness: 0.9,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      }));
      if (o.material.length === 1) o.material = o.material[0];
      o.renderOrder = 2;
    });

    this.data = null;
    this._prevYaw = 0;
  }

  /** Hand it a run to replay, or null to switch it off. */
  load(data) {
    this.data = data;
    this.root.visible = false;
  }

  reset() {
    this.root.visible = false;
    this._prevYaw = 0;
  }

  /**
   * Places the ghost at `elapsed` seconds into its stored run.
   *
   * Interpolated between samples rather than snapped to them: at ten samples a
   * second and a hundred and thirty km/h, snapping moves the ghost three and a
   * half metres at a time and reads as a strobe.
   */
  update(elapsed) {
    if (!this.data) return;
    const { samples, rate } = this.data;
    const t = elapsed * rate;
    const i = Math.floor(t);

    // Past the end of the recording the ghost simply stops existing, which is
    // the honest thing: it either finished or it went down, and either way it
    // is not on the mountain any more.
    if (i >= samples.length - 1) {
      this.root.visible = false;
      return;
    }

    const a = samples[i];
    const b = samples[i + 1];
    const f = t - i;
    const x = a[0] + (b[0] - a[0]) * f;
    const y = a[1] + (b[1] - a[1]) * f;
    const z = a[2] + (b[2] - a[2]) * f;
    const yaw = a[3] + angleDelta(a[3], b[3]) * f;
    const boardYaw = a[4] + angleDelta(a[4], b[4]) * f;

    this.root.visible = true;
    this.root.position.set(x, y, z);
    this.root.rotation.y = yaw;

    // A lean derived from how fast the heading is changing. Without it the
    // ghost stands bolt upright through every turn and reads as a cardboard
    // cutout on rails; with it, it carves.
    const turn = angleDelta(this._prevYaw, yaw);
    this._prevYaw = yaw;
    const lean = Math.max(-0.55, Math.min(0.55, turn * 9));
    this.model.tilt.rotation.z = lean;
    this.model.board.rotation.y = angleDelta(yaw, boardYaw);
  }
}

/** Shortest signed angle from `a` to `b`. Local copy — this file has no other maths. */
function angleDelta(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
