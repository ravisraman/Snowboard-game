import { clamp, formatTime } from './mathx.js';

/**
 * The HUD and the overlay screens. Deliberately thin: it reads game state and
 * writes text, and only touches the DOM when a value has actually changed.
 */

const BEST_TIME_KEY = 'alpine-carve.best';
const BEST_SCORE_KEY = 'alpine-carve.bestScore';

export class HUD {
  constructor() {
    const $ = (id) => document.getElementById(id);

    this.el = {
      hud: $('hud'),
      score: $('score-value'),
      combo: $('combo'),
      comboValue: $('combo-value'),
      comboBar: document.querySelector('.combo-bar'),
      comboFill: $('combo-fill'),
      trick: $('trick-callout'),
      trickLabel: $('trick-label'),
      trickPoints: $('trick-points'),
      spin: $('spin-value'),
      speed: $('speed-value'),
      speedFill: $('speed-fill'),
      timer: $('timer-value'),
      progress: $('progress-fill'),
      air: $('air-meter'),
      airValue: $('air-value'),
      powder: $('powder-tag'),
      overlay: $('overlay'),
      title: $('screen-title'),
      crash: $('screen-crash'),
      finish: $('screen-finish'),
      crashReason: $('crash-reason'),
      crashTime: $('crash-time'),
      crashDist: $('crash-dist'),
      crashTop: $('crash-top'),
      finishTime: $('finish-time'),
      finishBest: $('finish-best'),
      finishTop: $('finish-top'),
      finishAir: $('finish-air'),
      finishScore: $('finish-score'),
      finishBestScore: $('finish-best-score'),
      finishTricks: $('finish-tricks'),
      crashScore: $('crash-score'),
      loading: $('loading'),
      start: $('btn-start'),
      retry: $('btn-retry'),
      again: $('btn-again'),
      stuck: $('stuck-prompt'),
      rescue: $('btn-rescue'),
      restartRun: $('btn-restart-run'),
      mute: $('btn-mute'),
    };

    this._last = {
      speed: -1, timer: '', air: false, powder: false, progress: -1,
      score: -1, combo: -1, comboPct: -1, spin: -1,
    };
    this.best = this._load(BEST_TIME_KEY);
    this.bestScore = this._load(BEST_SCORE_KEY);
  }

  _load(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? parseFloat(raw) : null;
    } catch {
      return null; // private browsing, embedded frames, etc.
    }
  }

  _save(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch {
      /* nothing we can do, and nothing worth interrupting the run for */
    }
  }

  recordTime(seconds) {
    if (this.best === null || seconds < this.best) {
      this.best = seconds;
      this._save(BEST_TIME_KEY, seconds);
    }
  }

  recordScore(points) {
    if (this.bestScore === null || points > this.bestScore) {
      this.bestScore = points;
      this._save(BEST_SCORE_KEY, points);
      return true;
    }
    return false;
  }

  onAction({ onStart, onRestart, onRescue, onMute }) {
    this.el.start.addEventListener('click', onStart);
    this.el.retry.addEventListener('click', onRestart);
    this.el.again.addEventListener('click', onRestart);
    this.el.rescue?.addEventListener('click', onRescue);
    this.el.restartRun?.addEventListener('click', onRestart);
    this.el.mute?.addEventListener('click', onMute);
  }

  setMuted(muted) {
    this.el.mute?.classList.toggle('is-muted', muted);
  }

  /** The "bogged down" offer, shown once the rider has ground to a halt. */
  setStuck(visible) {
    if (this._stuckShown === visible) return;
    this._stuckShown = visible;
    this.el.stuck?.classList.toggle('on', visible);
  }

  hideLoading() {
    this.el.loading.classList.add('hidden');
    setTimeout(() => this.el.loading.remove(), 800);
  }

  showScreen(name) {
    for (const key of ['title', 'crash', 'finish']) {
      this.el[key].classList.toggle('hidden', key !== name);
    }
    this.el.overlay.classList.remove('hidden');
    // Let the button take focus so Enter/Space works without a mouse.
    const btn = { title: this.el.start, crash: this.el.retry, finish: this.el.again }[name];
    if (btn) setTimeout(() => btn.focus({ preventScroll: true }), 60);
  }

  hideOverlay() {
    this.el.overlay.classList.add('hidden');
    document.activeElement?.blur?.();
  }

  setHudVisible(visible) {
    this.el.hud.classList.toggle('visible', visible);
  }

  update(rider, elapsed, progress, score) {
    if (score) this._updateScore(score, rider);

    const kmh = Math.round(rider.speed * 3.6);
    if (kmh !== this._last.speed) {
      this._last.speed = kmh;
      this.el.speed.textContent = kmh;
      this.el.speedFill.style.width = `${clamp((rider.speed / 36) * 100, 0, 100)}%`;
    }

    const t = formatTime(elapsed);
    if (t !== this._last.timer) {
      this._last.timer = t;
      this.el.timer.textContent = t;
    }

    const pct = Math.round(clamp(progress, 0, 1) * 100);
    if (pct !== this._last.progress) {
      this._last.progress = pct;
      this.el.progress.style.width = `${pct}%`;
    }

    const airborne = !rider.grounded && rider.airTime > 0.22;
    if (airborne !== this._last.air) {
      this._last.air = airborne;
      this.el.air.classList.toggle('on', airborne);
    }
    if (airborne) {
      this.el.airValue.textContent = `${rider.airTime.toFixed(1)}s`;

      // Live rotation: this is the number you're deciding whether to hold for.
      const spin = Math.round(rider.spinDegrees / 10) * 10;
      if (spin !== this._last.spin) {
        this._last.spin = spin;
        this.el.spin.textContent = `${spin}°`;
        this.el.spin.classList.toggle('on', spin >= 90);
      }
    } else if (this._last.spin !== -1) {
      this._last.spin = -1;
      this.el.spin.classList.remove('on');
    }

    const deep = rider.powder > 0.55 && rider.grounded;
    if (deep !== this._last.powder) {
      this._last.powder = deep;
      this.el.powder.classList.toggle('on', deep);
    }
  }

  _updateScore(score, rider) {
    const total = Math.round(score.total);
    if (total !== this._last.score) {
      this._last.score = total;
      this.el.score.textContent = total.toLocaleString('en-US');
    }

    // The multiplier only appears once it is worth something, so the corner
    // stays quiet on an ordinary cruise.
    const combo = score.combo;
    if (combo !== this._last.combo) {
      this._last.combo = combo;
      const live = combo > 1;
      this.el.comboValue.textContent = combo;
      this.el.combo.classList.toggle('on', live);
      this.el.comboBar.classList.toggle('on', live);
    }

    const pct = Math.round(score.comboFraction * 100);
    if (pct !== this._last.comboPct) {
      this._last.comboPct = pct;
      this.el.comboFill.style.width = `${pct}%`;
    }

    if (score.lastAward) this._popTrick(score.lastAward);
  }

  /** Throws the award up on screen. Retriggering restarts the animation. */
  _popTrick({ label, points }) {
    const el = this.el.trick;
    this.el.trickLabel.textContent = label;
    this.el.trickPoints.textContent = `+${points.toLocaleString('en-US')}`;
    el.classList.remove('pop');
    void el.offsetWidth; // reflow, or the class re-add is coalesced away
    el.classList.add('pop');
  }

  showCrash(rider, elapsed, distance, score) {
    // A wipeout still banks whatever you had already landed — it is only the
    // multiplier you were building that dies with you.
    const total = Math.round(score?.total ?? 0);
    this.recordScore(total);
    this.el.crashScore.textContent = total.toLocaleString('en-US');
    this.el.crashReason.textContent = rider.crashReason ?? 'You caught an edge.';
    this.el.crashTime.textContent = formatTime(elapsed);
    this.el.crashDist.textContent = `${Math.round(distance)} m`;
    this.el.crashTop.textContent = `${Math.round(rider.topSpeed * 3.6)} km/h`;
    this.showScreen('crash');
  }

  showFinish(rider, elapsed, score) {
    const total = Math.round(score?.total ?? 0);
    const isBestTime = this.best === null || elapsed < this.best;
    const isBestScore = this.recordScore(total);
    this.recordTime(elapsed);

    this.el.finishScore.textContent = total.toLocaleString('en-US');
    this.el.finishBestScore.textContent =
      this.bestScore === null ? '—' : Math.round(this.bestScore).toLocaleString('en-US');
    this.el.finishBestScore.style.color = isBestScore ? '#8ee6a0' : '';
    this.el.finishTricks.textContent = score?.tricksLanded ?? 0;

    this.el.finishTime.textContent = formatTime(elapsed);
    this.el.finishBest.textContent = this.best === null ? '—' : formatTime(this.best);
    this.el.finishBest.style.color = isBestTime ? '#8ee6a0' : '';
    this.el.finishTop.textContent = `${Math.round(rider.topSpeed * 3.6)} km/h`;
    this.el.finishAir.textContent = `${rider.longestAir.toFixed(1)} s`;
    this.showScreen('finish');
  }

  resetTicker() {
    this._stuckShown = undefined;
    this.el.trick?.classList.remove('pop');
    this._last = {
      speed: -1, timer: '', air: false, powder: false, progress: -1,
      score: -1, combo: -1, comboPct: -1, spin: -1,
    };
  }
}
