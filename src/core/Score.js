import { clamp } from './mathx.js';

/**
 * Scoring.
 *
 * The run is scored, not raced, so this is what the game is actually about.
 * Two ideas carry it:
 *
 * Rotation pays escalating dividends — a 720 is worth far more than two 360s —
 * so there is always a reason to hold the spin one beat longer than is safe.
 *
 * And the combo multiplier only *banks* on a clean landing, and a crash takes
 * it away. Points already banked are yours; the multiplier you have been
 * building is not. That asymmetry is the whole risk model: the longer your
 * streak runs, the more a bad landing costs you.
 */

const TUNING = {
  airPerSecond: 14,
  halfTurnBase: 50,      // rotation pays base * n(n+1)/2 for n half-turns
  grabPerSecond: 55,
  grabMinimum: 0.22,     // shorter than this is a fumble, not a grab
  cleanBonus: 45,
  sketchyScale: 0.4,     // a scrappy landing still pays, but not much
  nearMiss: 30,
  powderPerSecond: 22,   // hard carving off-piste, while it lasts
  comboDecay: 4.5,       // seconds of nothing before the multiplier slides back
  comboMax: 8,
};

export const SCORE_TUNING = TUNING;

export class Score {
  constructor() {
    this.reset();
  }

  reset() {
    this.total = 0;
    this.combo = 1;
    this.comboTimer = 0;
    this.best = null;
    this.lastAward = null;   // one-frame event for the HUD callout
    this.biggestTrick = 0;
    this.tricksLanded = 0;
  }

  /** Clears the per-frame event. Call at the end of each frame. */
  endFrame() {
    this.lastAward = null;
  }

  update(dt, rider) {
    // The multiplier is a streak, so it has to be losable by simply not doing
    // anything with it.
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.combo = 1;
    }

    // Powder is otherwise pure punishment — slow, grabby, and a good way to
    // end a run. Paying for a committed turn out there makes it a choice.
    if (rider.grounded && rider.powder > 0.5 && rider.carveIntensity > 0.55 && rider.speed > 8) {
      this._add(TUNING.powderPerSecond * dt * rider.powder, null);
    }
  }

  /** A landing, judged. Returns the award for the HUD, or null if it paid nothing. */
  onTrickLanded(trick) {
    const halfTurns = Math.round(trick.spinDegrees / 180);
    const grabbed = trick.grabTime >= TUNING.grabMinimum;

    let points = TUNING.airPerSecond * trick.airTime;
    if (halfTurns > 0) points += TUNING.halfTurnBase * ((halfTurns * (halfTurns + 1)) / 2);
    if (grabbed) points += TUNING.grabPerSecond * trick.grabTime;
    if (trick.clean) points += TUNING.cleanBonus;

    // A straight hop off a roller is not a trick; don't spam the HUD with it.
    if (halfTurns === 0 && !grabbed && trick.airTime < 0.55) return null;

    if (!trick.clean) points *= TUNING.sketchyScale;

    const label = this._name(halfTurns, grabbed, trick.switchStance, trick.clean);
    const award = this._add(points, label);

    if (trick.clean) {
      // Only a clean landing banks it.
      this.combo = Math.min(TUNING.comboMax, this.combo + 1);
      this.comboTimer = TUNING.comboDecay;
      this.tricksLanded++;
      this.biggestTrick = Math.max(this.biggestTrick, award.points);
    } else {
      // Sketchy keeps what you had but doesn't build on it.
      this.comboTimer = Math.max(this.comboTimer, TUNING.comboDecay * 0.5);
    }
    return award;
  }

  onNearMiss() {
    if (this.combo <= 1 && this.comboTimer <= 0) this.comboTimer = TUNING.comboDecay * 0.6;
    return this._add(TUNING.nearMiss, 'CLOSE ONE');
  }

  /** The streak dies with you. Everything already banked stays banked. */
  onCrash() {
    this.combo = 1;
    this.comboTimer = 0;
  }

  _add(rawPoints, label) {
    const points = Math.round(rawPoints * this.combo);
    this.total += points;
    if (label) this.lastAward = { label, points, combo: this.combo };
    return { points, label };
  }

  _name(halfTurns, grabbed, switchStance, clean) {
    const parts = [];
    if (switchStance) parts.push('SW');
    if (halfTurns > 0) parts.push(String(halfTurns * 180));
    if (grabbed) parts.push('GRAB');
    if (!parts.length) parts.push('AIR');
    if (!clean) parts.push('· SKETCHY');
    return parts.join(' ');
  }

  /** 0–1 for how far the multiplier is through its decay, for the HUD bar. */
  get comboFraction() {
    return clamp(this.comboTimer / TUNING.comboDecay, 0, 1);
  }
}
