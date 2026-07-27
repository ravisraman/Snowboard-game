import { clamp, formatTime } from './mathx.js';

/**
 * The HUD and the overlay screens. Deliberately thin: it reads game state and
 * writes text, and only touches the DOM when a value has actually changed.
 */

const BEST_KEY = 'alpine-carve.best';

export class HUD {
  constructor() {
    const $ = (id) => document.getElementById(id);

    this.el = {
      hud: $('hud'),
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
      loading: $('loading'),
      start: $('btn-start'),
      retry: $('btn-retry'),
      again: $('btn-again'),
      stuck: $('stuck-prompt'),
      rescue: $('btn-rescue'),
      restartRun: $('btn-restart-run'),
    };

    this._last = { speed: -1, timer: '', air: false, powder: false, progress: -1 };
    this.best = this._loadBest();
  }

  _loadBest() {
    try {
      const raw = localStorage.getItem(BEST_KEY);
      return raw ? parseFloat(raw) : null;
    } catch {
      return null; // private browsing, embedded frames, etc.
    }
  }

  recordTime(seconds) {
    if (this.best === null || seconds < this.best) {
      this.best = seconds;
      try {
        localStorage.setItem(BEST_KEY, String(seconds));
      } catch {
        /* nothing we can do, and nothing worth interrupting the run for */
      }
    }
  }

  onAction({ onStart, onRestart, onRescue }) {
    this.el.start.addEventListener('click', onStart);
    this.el.retry.addEventListener('click', onRestart);
    this.el.again.addEventListener('click', onRestart);
    this.el.rescue?.addEventListener('click', onRescue);
    this.el.restartRun?.addEventListener('click', onRestart);
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

  update(rider, elapsed, progress) {
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
    if (airborne) this.el.airValue.textContent = `${rider.airTime.toFixed(1)}s`;

    const deep = rider.powder > 0.55 && rider.grounded;
    if (deep !== this._last.powder) {
      this._last.powder = deep;
      this.el.powder.classList.toggle('on', deep);
    }
  }

  showCrash(rider, elapsed, distance) {
    this.el.crashReason.textContent = rider.crashReason ?? 'You caught an edge.';
    this.el.crashTime.textContent = formatTime(elapsed);
    this.el.crashDist.textContent = `${Math.round(distance)} m`;
    this.el.crashTop.textContent = `${Math.round(rider.topSpeed * 3.6)} km/h`;
    this.showScreen('crash');
  }

  showFinish(rider, elapsed) {
    const isBest = this.best === null || elapsed < this.best;
    this.recordTime(elapsed);
    this.el.finishTime.textContent = formatTime(elapsed);
    this.el.finishBest.textContent = this.best === null ? '—' : formatTime(this.best);
    this.el.finishBest.style.color = isBest ? '#8ee6a0' : '';
    this.el.finishTop.textContent = `${Math.round(rider.topSpeed * 3.6)} km/h`;
    this.el.finishAir.textContent = `${rider.longestAir.toFixed(1)} s`;
    this.showScreen('finish');
  }

  resetTicker() {
    this._stuckShown = undefined;
    this._last = { speed: -1, timer: '', air: false, powder: false, progress: -1 };
  }
}
