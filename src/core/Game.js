import * as THREE from 'three';
import { Course } from '../world/Course.js';
import { buildTerrain } from '../world/Terrain.js';
import { buildKickers } from '../world/Kickers.js';
import { buildRails } from '../world/Rails.js';
import { buildTunnels } from '../world/Tunnels.js';
import { buildCollectibles, STAR_PICKUP_RADIUS } from '../world/Collectibles.js';
import { buildForest, bucketColliders } from '../world/Trees.js';
import { buildVillage } from '../world/Village.js';
import { buildSky, buildMountains, buildClouds, buildLighting, buildSkyProbe, HORIZON_COLOR } from '../world/Environment.js';
import { REFLECTIVE_MATERIALS } from '../entities/RiderModel.js';
import { buildResort } from '../world/Resort.js';
import { Rider, RIDER_TUNING } from '../entities/Rider.js';
import { Ghost, GhostRecorder, loadGhost } from '../entities/Ghost.js';
import { Skiers } from '../entities/Skiers.js';
import { SnowSpray } from '../fx/SnowSpray.js';
import { GameAudio } from '../fx/Audio.js';
import { SnowTracks } from '../fx/SnowTracks.js';
import { ChaseCamera } from './ChaseCamera.js';
import { Input } from './Input.js';
import { HUD } from './HUD.js';
import { Score } from './Score.js';
import { TouchControls } from './TouchControls.js';
import { difficulty, applyDifficulty, loadDifficulty, presetInfo } from './Difficulty.js';
// Which mountain, and remembering the choice across the reload a switch needs.
import { runInfo, loadRun, saveRun, armDropIn, takeDropIn } from './RunSelect.js';
import { loadCharacter, saveCharacter, characterById } from './CharacterSelect.js';
import { settle as settleChallenges, progressFor } from './Challenges.js';
import { Leaderboard } from '../services/Leaderboard.js';
import { Profile } from '../services/Profile.js';
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

/**
 * How many times you can go down before the run is actually over.
 *
 * A crash used to end it outright: one tree, ninety seconds gone, back to the
 * title screen. For an adult that is a fair price. For a seven-year-old it is
 * the game saying stop playing, and it was by a distance the most likely
 * reason for a session to end.
 *
 * So a wipeout is a *resource*. It still hurts — the multiplier is gone, the
 * boost with it, and you get up slowly while the clock runs — but the run
 * continues, and the score you had banked is still yours. Only running out
 * ends things, which turns the last one into a real moment rather than a
 * surprise.
 */
const WIPEOUTS = 3;

/** How fast you are riding again after getting up. Slow enough to sting. */
const RECOVER_SPEED = 9;

/** Below this speed, for this long, the rider is offered a way out. */
const STUCK_SPEED = 2.2;
const STUCK_SECONDS = 2.5;

/** How close to a tree, and how fast, counts as threading it. */
const NEAR_MISS_MARGIN = 1.6;
const NEAR_MISS_SPEED = 12;

/**
 * How much of the boost meter a trick worth `points` is worth.
 *
 * Square-rooted rather than linear, and capped. A trick's score already runs
 * away with itself by design — the multiplier is exponential and a big
 * late-run combo can pay thousands — and a linear meter would mean one huge
 * trick filling it from empty while ten honest ones did nothing much. The
 * curve makes a modest trick feel worth doing and a monster trick feel
 * generous without being the only thing that matters.
 */
const boostFor = (points) => Math.min(0.34, Math.sqrt(Math.max(0, points)) / 90);

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

    // Which mountain gets built, and who rides it. Both before `_buildWorld`,
    // for obvious reasons.
    this.runId = loadRun();
    this.characterId = loadCharacter();

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
    this._hitStop = 0;

    this.hud.onAction({
      onStart: () => this.start(),
      onRestart: () => this.restart(),
      onRescue: () => this.rescue(),
      onMute: () => this.hud.setMuted(this.audio.toggleMuted()),
      onHelp: () => this.toggleHelp(),
      onDifficulty: (name) => this.setDifficulty(name),
      onRun: (id) => this.setRun(id),
      onCharacter: (id) => this.setCharacter(id),
    });
    this.hud.setMuted(this.audio.muted);
    this.hud.setDifficulty(this.difficultyName);
    this.hud.setRun(this.runId);
    this.hud.setCharacter(this.characterId);

    // Who is riding, and what everyone has scored. Both are local for now and
    // both are read through interfaces that a server can sit behind later.
    this.profile = new Profile();
    this.leaderboard = new Leaderboard();
    this.hud.setName(this.profile.name);
    this.hud.onName((name) => this.profile.save(name));
    this._refreshTitleBoard();

    this.reset();
    this.hud.showScreen('title');

    // Arrived here by picking a different run and pressing DROP IN: the reload
    // was the rebuild, and this is the press it was carrying.
    if (takeDropIn()) this.start();
  }

  /* ================================================================
   * World construction
   * ============================================================== */

  _buildWorld() {
    const run = runInfo(this.runId);
    const course = new Course(run.seed, run);
    this.course = course;
    // What is actually standing, as opposed to what is selected. `start` reads
    // it to notice that the player has picked a different mountain.
    this._builtRunId = run.id;

    // Backdrop rides with the camera on X/Z so the peaks stay distant.
    this.backdrop = new THREE.Group();
    this.sky = buildSky(this.quality);
    this.backdrop.add(this.sky);
    this.backdrop.add(buildMountains(909, this.quality));
    if (this.quality.clouds !== false) this.backdrop.add(buildClouds());
    this.scene.add(this.backdrop);

    this.lights = buildLighting(this.scene, this.quality);

    this.scene.add(buildKickers(course));
    this.scene.add(buildRails(course));

    // Tunnels. Pure spectacle: nothing in `_checkHazards` ever asks about
    // them, so a bore can only ever change how the mountain looks and sounds.
    // Off entirely on runs whose preset does not ask for one, in which case
    // this is an empty group and an `update()` that returns immediately.
    this.tunnels = buildTunnels(course, run.tunnels);
    this.scene.add(this.tunnels.group);
    // Bound after the lighting rig exists, and it snapshots the run's daylight
    // values on the way in — so "restore daylight" always means the values
    // this world was actually built with.
    this.tunnels.bind({ scene: this.scene, lights: this.lights, audio: this.audio });

    this.collectibles = buildCollectibles(course);
    this.scene.add(this.collectibles.group);

    const village = buildVillage(course);
    this.scene.add(village.group);

    this.resort = buildResort(course, this.quality);
    this.scene.add(this.resort.group);

    // The forest goes up before the slope does, so the slope can bake a ring of
    // contact shade into the snow around every trunk.
    // A spruce growing through the roof of a tunnel reads as a bug, so the
    // bore's footprint joins the village and the resort in the scatter's
    // keep-clear test. On a run with no tunnels `covers()` is a constant
    // false, which is what leaves Classic's forest digest untouched.
    const keepClear = (x, z) =>
      village.exclude(x, z) || this.resort.exclude(x, z) || this.tunnels.covers(x, z);
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

    this.rider = new Rider(course, this.characterId);

    /* The rabbit. Built once and reused for the life of the page — a restart
     * reloads its data, not its geometry. */
    this.ghost = new Ghost(this.characterId);
    this.scene.add(this.ghost.root);
    this.ghostRecorder = new GhostRecorder();
    // Same reason `_builtRunId` exists: what is *standing* is not what is
    // *selected*, and `start` needs to know the difference.
    this._builtCharacterId = characterById(this.characterId).id;
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
    this.collectibles.resetRun();
    // A fresh recording, and the stored best reloaded — which matters after a
    // run that *beat* it, since the next run should chase the new one.
    this.ghostRecorder.reset();
    this.ghost.load(loadGhost(this.runId, this.difficultyName));
    this.ghost.reset();
    // Straight back to full daylight and dry audio. Restarting from inside a
    // bore is the one case the per-frame blend cannot cover on its own — the
    // rider is at the gate again a frame later, but nothing else would have
    // been told, and the whole next run would be ridden in the dark.
    this.tunnels.reset();
    this._grazed = new Set();
    this._bumped = new Set();
    this.chase.reset(this.rider);
    this.elapsed = 0;
    this.crashTimer = 0;
    this.finishTimer = 0;
    this.stuckTimer = 0;
    this.isStuck = false;
    this._finishShown = false;
    this.wipeoutsLeft = WIPEOUTS;
    this.wipeoutsUsed = 0;
    // Whether boost was ever actually spent — a challenge asks, and neither
    // the rider nor the score keeps a run-long record of it.
    this.everBoosted = false;
    this.hud.setWipeouts(this.wipeoutsLeft, WIPEOUTS);
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
    // The two difficulties keep separate tables, so the title board has to
    // follow the switch — otherwise it shows scores from a game you are not
    // about to play.
    this._refreshTitleBoard();
  }

  /**
   * Picks a mountain. Unlike the difficulty this is not free mid-run — the
   * world is built from it — so it only records the choice and repoints the
   * board; `start` is where a different run actually gets built.
   */
  setRun(id) {
    this.runId = runInfo(id).id;
    saveRun(this.runId);
    this.hud.setRun(this.runId);
    // Each run keeps its own table, for the same reason each difficulty does.
    this._refreshTitleBoard();
  }

  /**
   * Records who is riding. Like `setRun`, this cannot swap the thing already
   * standing — `start` reloads for that — so it only remembers the choice.
   *
   * No leaderboard split: a character is a costume. Two players who rode the
   * same mountain on the same tuning are comparable whatever they were wearing,
   * and splitting the table three more ways would leave every one of them
   * empty.
   */
  setCharacter(id) {
    this.characterId = characterById(id).id;
    saveCharacter(this.characterId);
    this.hud.setCharacter(this.characterId);
  }

  async _refreshTitleBoard() {
    // The table is the run and the tuning together — the title board has to
    // show scores from the game you are about to play, not a neighbouring one.
    const table = { course: this.runId, difficulty: this.difficultyName };
    this.hud.showTitleBoard(await this.leaderboard.top(table, 3));
  }

  /**
   * Files the run that has just ended, and fills in the table under it.
   *
   * Deliberately not awaited by the caller: the results screen is already on
   * screen with the score on it, and a board that appears a frame later is far
   * better than a results screen that waits for storage. Every failure inside
   * the leaderboard resolves to an empty table rather than throwing, so there
   * is nothing here that can take a finished run down with it.
   */
  async _fileRun({ finished, elapsed }) {
    const r = this.rider;

    /* Store the run as a ghost if it beat the one already there.
     *
     * Before the leaderboard call, and not awaited: `submit` is async and the
     * results screen is already up, so anything downstream of an await here is
     * racing the player's next press of RETRY.
     */
    const beat = this.ghostRecorder.saveIfBest(this._builtRunId, this.difficultyName, {
      finished,
      elapsed,
      distance: r.position.z,
    });
    if (beat) this.hud.flashCallout('NEW GHOST');

    const result = await this.leaderboard.submit({
      name: this.profile.display,
      score: Math.round(this.score?.total ?? 0),
      timeMs: elapsed * 1000,
      tricks: this.score?.tricksLanded ?? 0,
      topSpeed: r.topSpeed,
      bestAir: r.longestAir,
      difficulty: this.difficultyName,
      course: this._builtRunId,
      seed: this.course.seed ?? 0,
      finished,
    });

    // Both halves of the split, so the table above the rows says which table
    // it is: a Park score never competes with a Classic one.
    const label = `${runInfo(this._builtRunId).name} · ${presetInfo(this.difficultyName).label}`;
    this.hud.showRunBoard(finished ? 'finish' : 'crash', result, label);
    this._refreshTitleBoard();
    return result;
  }

  start() {
    // The only place an AudioContext can legally be created on mobile Safari:
    // inside the user gesture that got us here.
    this.audio.unlock();
    if (this.state === 'riding') return;
    // A different mountain than the one standing has to be built, and a reload
    // is how that is done — see the note in `RunSelect.js`. The press is
    // carried across it, so this reads as a slightly slower drop-in rather
    // than as a button that did nothing.
    if (this.runId !== this._builtRunId || this.characterId !== this._builtCharacterId) {
      armDropIn();
      location.reload();
      return;
    }
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

  /**
   * Everything the challenges are scored against, in one flat bag.
   *
   * Assembled here and nowhere else: `Challenges.js` never sees the world, the
   * rider or the score object, which is what keeps a challenge a single line
   * rather than a hook in the game loop.
   */
  _runStats(finished) {
    const s = this.score;
    return {
      stars: s.starsCollected,
      bestSpin: s.bestSpin,
      tricks: s.tricksLanded,
      grinds: s.grindsLanded,
      gates: s.gateBest,
      longestAir: this.rider.longestAir,
      topSpeed: this.rider.topSpeed,
      score: Math.round(s.total),
      wipeouts: this.wipeoutsUsed,
      boosted: this.everBoosted,
      finished,
    };
  }

  /**
   * Spend a wipeout and carry on.
   *
   * Called at the end of the slow-motion beat, so the tumble still reads as a
   * tumble — the player sees themselves go down, and only then get up. Putting
   * the recovery on the frame of the impact instead made a crash feel like a
   * stutter rather than a mistake.
   *
   * The rider comes back on the centre line, which is also what quietly fixes
   * an out-of-bounds crash: whatever they rode off the edge of, they are back
   * on the piste now.
   */
  _getUp() {
    const r = this.rider;
    const z = clamp(r.position.z, 0, this.course.finishZ - 5);
    this.wipeoutsLeft -= 1;
    this.wipeoutsUsed += 1;
    r.recover(this.course.centerX(z), z, this.course.trackHeading(z), RECOVER_SPEED);
    // The meter goes with the multiplier. Boost is the reward for a run that
    // is going well, and this one just stopped going well.
    r.boost = 0;
    this.tracks.lift();
    this.chase.reset(r);
    this.stuckTimer = 0;
    this.isStuck = false;
    this.hud.setStuck(false);
    this.hud.setWipeouts(this.wipeoutsLeft, WIPEOUTS);
    this.hud.flashCallout(this.wipeoutsLeft > 0
      ? `WIPEOUT — ${this.wipeoutsLeft} LEFT`
      : 'LAST CHANCE');
    this.spray.burst(r.position, 50, 4, 0.6);
    this.touch.setVisible(true);
    this.state = 'riding';
    this.crashTimer = 0;
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
        if (this.wipeoutsLeft > 0) this._getUp();
        else {
          this.state = 'crashed';
          this.hud.setWipeoutsUsed(this.wipeoutsUsed);
          this.hud.showChallenges(settleChallenges(this.runId, this._runStats(false)));
          this.hud.showCrash(this.rider, this.elapsed, this.rider.position.z, this.score);
          this._fileRun({ finished: false, elapsed: this.elapsed });
        }
      }
    } else if (this.state === 'finished') {
      this.finishTimer += dt;
      scale = 0.85;
      // Let the rider coast past the banner for a beat before the results land.
      if (this.finishTimer > 1.6 && !this._finishShown) {
        this._finishShown = true;
        this.hud.setWipeoutsUsed(this.wipeoutsUsed);
        this.hud.showChallenges(settleChallenges(this.runId, this._runStats(true)));
        this.hud.showFinish(this.rider, this.finishElapsed, this.score);
        this._fileRun({ finished: true, elapsed: this.finishElapsed });
        this.audio.cheer();
      }
    }

    // A few frames of near-freeze on the best moments — real time, so it
    // decays the same whether or not the run itself is also in slow motion.
    if (this._hitStop > 0) {
      this._hitStop = Math.max(0, this._hitStop - dt);
      scale *= 0.12;
    }

    const sdt = dt * scale;

    if (this.state === 'riding') {
      this.elapsed += dt;
      // Recorded and replayed against the *wall* clock, not the slow-motion
      // one: a ghost is a record of a past run and has no business slowing
      // down because this one is having a moment.
      this.ghostRecorder.sample(dt, this.rider, this.elapsed);
      this.ghost.update(this.elapsed);
      this.rider.update(sdt, this.input);
      this.score.update(sdt, this.rider);
      if (this.rider.trickLanded) {
        const award = this.score.onTrickLanded(this.rider.trickLanded);
        // Only a clean landing pays boost, for the same reason only a clean
        // landing banks the multiplier: the meter is the reward for finishing
        // a trick, and a trick you scrape away from is not finished.
        if (award && this.rider.trickLanded.clean) this.rider.addBoost(boostFor(award.points));
        if (award && this.rider.trickLanded.clean) {
          const text = this._trickCallout(this.rider.trickLanded, award.points);
          if (text) {
            this.hud.flashCallout(text);
            this._bigMoment(1.1, 0.05);
            this.audio.cheer();
          }
        }
      }
      if (this.rider.boosting) this.everBoosted = true;
      if (this.rider.groundTrick) this.score.onGroundTrick(this.rider.groundTrick);
      if (this.rider.grindPopped) {
        const award = this.score.onGrindPopped(this.rider.grindPopped.seconds);
        if (award) {
          this.rider.addBoost(boostFor(award.points));
          this.audio.trick(this.score.combo);
          this.chase.kick(0.7);
          if (award.points > 90) {
            this.hud.flashCallout('RAIL GRIND!');
            this._bigMoment(0.9, 0.04);
            this.audio.cheer();
          }
        }
      }
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
      this._checkCollectibles();
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
    this.collectibles.update(sdt);
    // Before the audio, so the frame's muffle is the frame's position rather
    // than the one before it. Real dt, not the slow-motion one: a wipeout in a
    // tunnel should not also slow the light down.
    this.tunnels.update(dt, this.rider.position);
    this.audio.update(this.rider, this.state === 'riding');
    this.tracks.update(this.rider);
    this._emitSpray(sdt);
    this.spray.update(sdt);
    this.chase.update(this.rider, dt);
    this.spray.setViewport(this.renderer.domElement.height, this.camera.fov);
    this._updateBackdrop();
    this.lights.follow(this.rider.position);

    if (this.state === 'riding') {
      // The course's own finish line, not the module constant: with more than
      // one run they are no longer the same number.
      this.hud.update(this.rider, this.elapsed, this.rider.position.z / this.course.finishZ, this.score);
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
    // The cirrus drifts. It is the only thing in the upper half of the frame
    // that moves, and a sky that is perfectly still is one of those details
    // nobody names and everybody notices.
    const u = this.sky.material.uniforms;
    if (u?.uTime) u.uTime.value = this.elapsed;
  }

  /* ---------------------------------------------------------------- */

  /** A kick and a few frames of hit-stop — the shared texture of a big moment. */
  _bigMoment(kickAmount, hitStopSeconds = 0.05) {
    this.chase.kick(kickAmount);
    this._hitStop = Math.max(this._hitStop, hitStopSeconds);
  }

  /**
   * What to shout for a landed trick, or nothing — most tricks are worth
   * banking quietly, and a callout on every one would stop meaning anything.
   */
  _trickCallout(trick, points) {
    if (points < 140) return null;
    if (trick.spinDegrees >= 360 && trick.grabType) return 'SICK GRAB!';
    if (trick.spinDegrees >= 360) return 'SICK SPIN!';
    if (trick.stomped && points > 220) return 'STOMPED!';
    if (trick.grabType) return 'NICE GRAB!';
    if (trick.shifty) return 'SMOOTH SHIFTY!';
    return points > 260 ? 'HUGE!' : null;
  }

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

  /**
   * Stars and gates. Neither can end a run — a star just sits there if you
   * miss it, and a missed gate only costs the streak — so this never needs to
   * distinguish "hit" from "hazard" the way `_checkHazards` does.
   */
  _checkCollectibles() {
    const r = this.rider;
    const { x, y, z } = r.position;

    for (const s of this.collectibles.starsBucket.query(z)) {
      if (s.collected) continue;
      const dx = s.x - x;
      const dz = s.z - z;
      const dy = s.y - y;
      if (dx * dx + dz * dz > STAR_PICKUP_RADIUS * STAR_PICKUP_RADIUS) continue;
      if (Math.abs(dy) > 1.6) continue;
      s.collected = true;
      this.collectibles.collectStar(s.id);
      this.score.onStar();
      // A little, so a rider who only collects still sees the meter move and
      // finds out what it does. Not enough to make collecting the fast way
      // down — that has to stay the reward for landing things.
      this.rider.addBoost(0.04);
      this.audio.trick(1);
      this.spray.burst(r.position, 10, 2, 0);
    }

    for (const g of this.collectibles.gatesBucket.query(z)) {
      if (g.passed || z < g.z) continue;
      g.passed = true;
      const t = (x - g.x) * g.dirZ - (z - g.z) * g.dirX;
      const hit = Math.abs(t) < g.halfWidth;
      // Both the hit and the miss go through the score — a miss resets the
      // streak but is otherwise silent, exactly like a combo lapsing.
      const award = this.score.onGate(hit);
      if (award) {
        this.audio.trick(1);
        if (this.score.gateStreak >= 3 && this.score.gateStreak % 2 === 1) {
          this.hud.flashCallout(`GATE STREAK ×${this.score.gateStreak}!`);
          this._bigMoment(0.5, 0);
        }
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
