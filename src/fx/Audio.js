/**
 * Sound, synthesised.
 *
 * Every sound here is made from one buffer of white noise plus a handful of
 * oscillators — no audio files, so the game still folds into a single
 * self-contained HTML page and still loads nothing over the network.
 *
 * That constraint suits the subject anyway. Almost everything a snowboard makes
 * *is* filtered noise: an edge in hard snow is a narrow band that climbs as you
 * lean on it, powder is the same band an octave down with the top rolled off,
 * and wind is the whole thing smeared. Two continuous voices tracked against
 * the rider's state get you most of the way, and the rest is short transients.
 */

const NOISE_SECONDS = 3;

export class GameAudio {
  constructor({ enabled = true } = {}) {
    this.supported = enabled && typeof window !== 'undefined' &&
      !!(window.AudioContext || window.webkitAudioContext);
    this.ready = false;
    this.muted = this._loadMuted();
    this.ctx = null;
  }

  _loadMuted() {
    try {
      return localStorage.getItem('alpine-carve.muted') === '1';
    } catch {
      return false;
    }
  }

  /**
   * Must be called from inside a real user gesture — a click or a touch. Mobile
   * Safari will not start an AudioContext any other way, and one created
   * outside a gesture stays suspended forever with no error to tell you so.
   */
  unlock() {
    if (!this.supported || this.ready) {
      this.ctx?.resume?.();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    this._build();
    this.ready = true;
    this.ctx.resume();
  }

  _build() {
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    this.master.connect(ctx.destination);

    // One noise buffer, shared by every voice in the game.
    const frames = Math.floor(ctx.sampleRate * NOISE_SECONDS);
    this.noise = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

    // --- Edge hiss: the board cutting snow ---------------------------
    this.edge = this._loop();
    this.edgeFilter = ctx.createBiquadFilter();
    this.edgeFilter.type = 'bandpass';
    this.edgeFilter.frequency.value = 1200;
    this.edgeFilter.Q.value = 1.1;
    this.edgeGain = ctx.createGain();
    this.edgeGain.gain.value = 0;
    this.edge.connect(this.edgeFilter).connect(this.edgeGain).connect(this.master);
    this.edge.start();

    // --- Wind: everything above about 40 km/h -------------------------
    this.wind = this._loop();
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 500;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.wind.connect(this.windFilter).connect(this.windGain).connect(this.master);
    this.wind.start();
  }

  _loop() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    return src;
  }

  setMuted(muted) {
    this.muted = muted;
    try {
      localStorage.setItem('alpine-carve.muted', muted ? '1' : '0');
    } catch {
      /* not worth interrupting a run over */
    }
    if (this.ready) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.9, this.ctx.currentTime, 0.02);
    }
  }

  toggleMuted() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /* ------------------------------------------------------------------
   * Continuous voices
   * ---------------------------------------------------------------- */

  update(rider, riding) {
    if (!this.ready || this.muted) return;
    const t = this.ctx.currentTime;
    const speed = rider.speed;

    // Edge: only when there is actually an edge in the snow. Powder drops the
    // band an octave and takes the top off — a duller, softer rush.
    let edgeGain = 0;
    let edgeFreq = 900;
    if (riding && rider.grounded && speed > 3) {
      const bite = Math.min(1, rider.carveIntensity) * Math.min(1, speed / 16);
      const scrape = rider.braking ? 0.55 : 0;
      edgeGain = Math.min(0.34, (0.045 + bite * 0.3 + scrape) * (1 - rider.powder * 0.35));
      edgeFreq = (700 + bite * 2400 + speed * 22) * (1 - rider.powder * 0.55);
      this.edgeFilter.Q.value = 1.1 + rider.powder * 1.4;
    }
    this.edgeGain.gain.setTargetAtTime(edgeGain, t, 0.06);
    this.edgeFilter.frequency.setTargetAtTime(edgeFreq, t, 0.08);

    // Wind rises with the square of speed and thins out in the air, where
    // there is no snow noise left to sit under it.
    const v = Math.max(0, speed - 8) / 28;
    const wind = riding ? Math.min(0.3, v * v * 0.42 + (rider.grounded ? 0 : 0.05)) : 0;
    this.windGain.gain.setTargetAtTime(wind, t, 0.15);
    this.windFilter.frequency.setTargetAtTime(380 + speed * 26, t, 0.2);
  }

  /** Silences the continuous voices without tearing anything down. */
  quiet() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.edgeGain.gain.setTargetAtTime(0, t, 0.1);
    this.windGain.gain.setTargetAtTime(0, t, 0.2);
  }

  /* ------------------------------------------------------------------
   * Transients
   * ---------------------------------------------------------------- */

  /** A shaped burst of filtered noise — the basis of every impact here. */
  _burst({ duration = 0.25, gain = 0.3, freq = 900, type = 'lowpass', q = 1, sweep = 0 }) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    // Start at a random point so repeated hits don't sound like a sample.
    const offset = Math.random() * (NOISE_SECONDS - duration - 0.05);

    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(freq, t);
    if (sweep) filter.frequency.exponentialRampToValueAtTime(Math.max(60, freq * sweep), t + duration);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    src.connect(filter).connect(env).connect(this.master);
    src.start(t, offset, duration + 0.05);
    src.stop(t + duration + 0.05);
  }

  /** A pitched body, for thumps and chimes. */
  _tone({ from = 220, to = 90, duration = 0.2, gain = 0.2, type = 'sine' }) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + duration);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    osc.connect(env).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  ollie() {
    this._burst({ duration: 0.11, gain: 0.2, freq: 2600, type: 'highpass', sweep: 0.4 });
    this._tone({ from: 320, to: 150, duration: 0.1, gain: 0.1 });
  }

  /** Landing. `impact` is the speed driven into the snow; powder softens it. */
  land(impact, powder) {
    const hard = Math.min(1, impact / 18);
    this._burst({
      duration: 0.18 + powder * 0.3,
      gain: 0.14 + hard * 0.28,
      freq: (1600 - powder * 900) * (0.6 + hard * 0.6),
      sweep: 0.25,
    });
    this._tone({ from: 130 - powder * 40, to: 44, duration: 0.16 + hard * 0.12, gain: 0.1 + hard * 0.2 });
  }

  /** The soft whump of dropping into deep snow. */
  powderPuff() {
    this._burst({ duration: 0.4, gain: 0.2, freq: 420, sweep: 0.3, q: 0.7 });
  }

  skate() {
    this._burst({ duration: 0.22, gain: 0.16, freq: 1500, type: 'bandpass', q: 1.4, sweep: 0.5 });
  }

  crash() {
    this._burst({ duration: 0.7, gain: 0.34, freq: 1900, sweep: 0.12 });
    this._tone({ from: 160, to: 35, duration: 0.5, gain: 0.22 });
  }

  /**
   * The reward. Pitch climbs with the multiplier, so a long streak audibly
   * escalates — you hear the combo before you look at it.
   */
  trick(combo) {
    const step = Math.min(combo, 8);
    const root = 440 * Math.pow(2, (step - 1) / 12);
    this._tone({ from: root, to: root * 1.5, duration: 0.16, gain: 0.11, type: 'triangle' });
    this._tone({ from: root * 2, to: root * 3, duration: 0.22, gain: 0.06, type: 'sine' });
  }

  fail() {
    this._burst({ duration: 0.3, gain: 0.2, freq: 700, sweep: 0.3 });
  }
}
