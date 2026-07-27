import { clamp, formatTime } from './mathx.js';
import { CONTROL_GROUPS, TRICK_GUIDE, SCORING_NOTE } from './Controls.js';

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
      trackerTicks: $('tracker-ticks'),
      trackerRider: $('tracker-rider'),
      trackerDone: $('tracker-done'),
      trackerDistance: $('tracker-distance'),
      air: $('air-meter'),
      airValue: $('air-value'),
      powder: $('powder-tag'),
      bump: $('bump-tag'),
      overlay: $('overlay'),
      title: $('screen-title'),
      crash: $('screen-crash'),
      finish: $('screen-finish'),
      help: $('screen-help'),
      helpBody: $('help-body'),
      helpBtn: $('btn-help'),
      helpTitleBtn: $('btn-help-title'),
      resume: $('btn-resume'),
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
      finishLog: $('finish-log'),
      crashLog: $('crash-log'),
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
      score: -1, combo: -1, comboPct: -1, spin: -1, metres: -1,
    };
    this.best = this._load(BEST_TIME_KEY);
    this.bestScore = this._load(BEST_SCORE_KEY);
    this._buildHelp();
  }

  /**
   * The run tracker: a rail with a tick for every kicker on the mountain.
   *
   * Built once, from the course itself, so it cannot disagree with what is
   * actually out there. A bare percentage tells you how far you have come; the
   * ticks are the part that tells you what is still coming, which is the thing
   * you actually want to know at 100 km/h.
   */
  buildTracker(course) {
    this.finishZ = course.finishZ;
    const ticks = this.el.trackerTicks;
    if (!ticks) return;
    ticks.innerHTML = course.kickers
      .map((k) => {
        const pct = Math.min(100, (k.z / course.finishZ) * 100);
        // Bigger kickers get a wider tick, so the rail carries a hint of what
        // kind of jump is coming rather than just that one is.
        const scale = (0.7 + (k.height - 1.5) / 3.4).toFixed(2);
        return `<i style="top:${pct.toFixed(2)}%;transform:scaleX(${scale})"></i>`;
      })
      .join('');
    this._ticks = [...ticks.children].map((el, i) => ({ el, z: course.kickers[i].z, passed: false }));
  }

  /**
   * Renders the controls panel from the one table in `Controls.js`. Built once
   * at startup — it is the same list every time it is opened, and the pause
   * screen is not the moment to be assembling DOM.
   */
  _buildHelp() {
    const body = this.el.helpBody;
    if (!body) return;

    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const html = [];

    for (const group of CONTROL_GROUPS) {
      html.push(`<h3 class="help-heading">${esc(group.title)}</h3>`);

      // Keyboard and touch get their own list, so a row without a touch
      // equivalent simply isn't offered to a phone.
      const keyRows = group.rows
        .map((r) => `<div class="ctrl">${r.keys.map((k) => `<kbd>${esc(k)}</kbd>`).join('')}<span>${esc(r.label)}</span></div>`)
        .join('');
      html.push(`<div class="controls keys-only">${keyRows}</div>`);

      const touchRows = group.rows
        .filter((r) => r.touch)
        .map((r) => `<div class="ctrl"><span class="tkey">${esc(r.touch)}</span><span>${esc(r.label)}</span></div>`)
        .join('');
      html.push(`<div class="controls touch-only">${touchRows}</div>`);
    }

    html.push('<h3 class="help-heading">What scores</h3>');
    html.push('<dl class="help-tricks">');
    for (const t of TRICK_GUIDE) {
      html.push(`<div><dt>${esc(t.name)}</dt><dd>${esc(t.detail)}</dd></div>`);
    }
    html.push('</dl>');
    html.push(`<p class="help-note">${esc(SCORING_NOTE)}</p>`);

    body.innerHTML = html.join('');
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

  onAction({ onStart, onRestart, onRescue, onMute, onHelp }) {
    this.el.start.addEventListener('click', onStart);
    this.el.retry.addEventListener('click', onRestart);
    this.el.again.addEventListener('click', onRestart);
    this.el.rescue?.addEventListener('click', onRescue);
    this.el.restartRun?.addEventListener('click', onRestart);
    this.el.mute?.addEventListener('click', onMute);
    this.el.helpBtn?.addEventListener('click', onHelp);
    this.el.helpTitleBtn?.addEventListener('click', onHelp);
    this.el.resume?.addEventListener('click', onHelp);
  }

  setMuted(muted) {
    this.el.mute?.classList.toggle('is-muted', muted);
  }

  /** Says what just happened, so a sudden loss of speed is not a mystery. */
  flashBump(text = 'CLIPPED A SKIER') {
    const el = this.el.bump;
    if (!el) return;
    el.textContent = text;
    el.classList.remove('on');
    void el.offsetWidth;   // reflow, or the re-add is coalesced away
    el.classList.add('on');
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
    this.currentScreen = name;
    // The panel already carries a BACK button, and on a phone the corner pair
    // would otherwise sit on top of the list.
    document.body.classList.toggle('help-open', name === 'help');
    for (const key of ['title', 'crash', 'finish', 'help']) {
      const el = this.el[key];
      el.classList.toggle('hidden', key !== name);
      el.classList.remove('enter');
    }
    this.el.overlay.classList.remove('hidden');
    // Restart the entrance animation on the screen being shown; the reflow is
    // what stops the class removal and re-add being coalesced into nothing.
    const shown = this.el[name];
    if (shown) {
      void shown.offsetWidth;
      shown.classList.add('enter');
    }
    // Let the button take focus so Enter/Space works without a mouse.
    const btn = {
      title: this.el.start,
      crash: this.el.retry,
      finish: this.el.again,
      help: this.el.resume,
    }[name];
    if (btn) setTimeout(() => btn.focus({ preventScroll: true }), 60);
  }

  hideOverlay() {
    this.currentScreen = null;
    document.body.classList.remove('help-open');
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

    this._updateTracker(rider.position.z, progress);

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

  /** Moves the marker, and dims each kicker as it goes by. */
  _updateTracker(z, progress) {
    if (!this.el.trackerRider) return;

    // Ten metres is finer than a pixel on the rail, and the whole discipline of
    // this class is not touching the DOM for changes nobody can see.
    const metres = Math.round(Math.max(0, z) / 10) * 10;
    if (metres === this._last.metres) return;
    this._last.metres = metres;

    const pct = clamp(progress, 0, 1) * 100;
    this.el.trackerRider.style.top = `${pct.toFixed(2)}%`;
    this.el.trackerDone.style.height = `${pct.toFixed(2)}%`;
    this.el.trackerDistance.textContent =
      `${metres.toLocaleString('en-US')} / ${Math.round(this.finishZ ?? 0).toLocaleString('en-US')} m`;

    for (const t of this._ticks ?? []) {
      const passed = z > t.z;
      if (passed !== t.passed) {
        t.passed = passed;
        t.el.classList.toggle('passed', passed);
      }
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

  /**
   * The run's best tricks. Half the point of a trick vocabulary is finding out
   * afterwards what the game called the thing you just did.
   */
  _fillLog(el, score) {
    if (!el) return;
    const best = score?.bestTricks?.() ?? [];
    el.innerHTML = best
      .map((t) => `<li><span>${t.label.replace(/</g, '&lt;')}</span><b>${t.points.toLocaleString('en-US')}</b></li>`)
      .join('');
    el.classList.toggle('on', best.length > 0);
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
    this._fillLog(this.el.crashLog, score);
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
    this._fillLog(this.el.finishLog, score);
    this.showScreen('finish');
  }

  resetTicker() {
    this._stuckShown = undefined;
    this.el.trick?.classList.remove('pop');
    this.el.bump?.classList.remove('on');
    this._last = {
      speed: -1, timer: '', air: false, powder: false, progress: -1,
      score: -1, combo: -1, comboPct: -1, spin: -1, metres: -1,
    };
    for (const t of this._ticks ?? []) {
      t.passed = false;
      t.el.classList.remove('passed');
    }
  }
}
