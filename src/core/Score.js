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
  airPerSecond: 9,       // and only ever as part of a trick — see onTrickLanded
  halfTurnBase: 50,      // rotation pays base * n(n+1)/2 for n half-turns
  grabMinimum: 0.22,     // shorter than this is a fumble, not a grab
  cleanBonus: 35,
  stompBonus: 40,        // dead straight, both feet under you
  shifty: 45,
  pop: 35,               // ollied right at the lip
  sketchyScale: 0.4,     // a scrappy landing still pays, but not much
  nearMiss: 30,
  powderPerSecond: 22,   // hard carving off-piste, while it lasts
  butterBase: 45,        // ground rotation, same escalating curve as the air
  comboDecay: 4.5,       // seconds of nothing before the multiplier slides back
  comboMax: 8,

  // Collectibles score through their own bucket, deliberately outside the
  // trick multiplier — a run with zero tricks should still end on a positive
  // number, and a star should never be the thing that resets your combo.
  starPoints: 15,
  gateBase: 20,
  gateStreakBonus: 8,
  gateStreakCap: 5,

  // Grinds pay per second held, like a grab, and only bank on a clean pop-off.
  grindPerSecond: 40,
  grindPopBonus: 25,
};

/**
 * What each grab is worth per second held.
 *
 * The awkward ones pay more, which is the whole point of having four of them:
 * a method needs the back hand right across the body and the board boned out
 * sideways, and it should be worth reaching for over an indy you can hold all
 * day.
 */
const GRABS = {
  indy: { rate: 55, name: 'INDY' },
  nose: { rate: 65, name: 'NOSE' },
  melon: { rate: 72, name: 'MELON' },
  method: { rate: 95, name: 'METHOD' },
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
    this.log = [];           // every named award, for the results screen

    this.starsCollected = 0;
    this.gateStreak = 0;
    this.gateBest = 0;
  }

  /** The run's best tricks, biggest first — what the results screen shows. */
  bestTricks(limit = 5) {
    return [...this.log].sort((a, b) => b.points - a.points).slice(0, limit);
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
    const grab = grabbed ? (GRABS[trick.grabType] ?? GRABS.indy) : null;

    // Hopping is not a trick, however long you hang there.
    //
    // Air time used to pay on its own, and every clean landing banked the
    // multiplier — so the highest-scoring way to ride the mountain was to bunny
    // hop down it, never turning, letting the multiplier climb to its cap. Air
    // is now a *bonus on* a trick rather than a trick in itself: you have to
    // rotate, grab or shifty before any of it counts, and the combo only banks
    // when it does.
    if (halfTurns === 0 && !grabbed && !trick.shifty) return null;

    let points = TUNING.airPerSecond * trick.airTime;
    if (halfTurns > 0) points += TUNING.halfTurnBase * ((halfTurns * (halfTurns + 1)) / 2);
    if (grab) points += grab.rate * trick.grabTime;
    if (trick.shifty) points += TUNING.shifty;
    if (trick.popped) points += TUNING.pop;
    if (trick.clean) points += TUNING.cleanBonus;
    if (trick.stomped) points += TUNING.stompBonus;

    if (!trick.clean) points *= TUNING.sketchyScale;

    const label = this._name(halfTurns, grab, trick);
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

  /**
   * A butter, judged when the board comes back down. Worth less than the same
   * rotation in the air — it is easier and safer — but it is the thing to do
   * with the long empty stretches between kickers.
   */
  onGroundTrick(trick) {
    const n = trick.halfTurns;
    if (n < 1) return null;

    let points = TUNING.butterBase * ((n * (n + 1)) / 2);
    if (!trick.clean) points *= TUNING.sketchyScale;

    const label = `${trick.nose ? 'NOSE' : 'TAIL'} BUTTER ${n * 180}`;
    const award = this._add(points, label);

    // A butter *sustains* the streak but does not build it. It is the safe move
    // — no air, no landing to get wrong — and if it banked the multiplier like
    // an air does, spinning on the flat would be the whole game.
    if (trick.clean) {
      this.comboTimer = TUNING.comboDecay;
      this.tricksLanded++;
    }
    return award;
  }

  /**
   * A star, picked up in passing. Flat and unmultiplied — it needs no trick
   * skill and no streak, just riding close enough to touch it.
   */
  onStar() {
    this.starsCollected++;
    this.total += TUNING.starPoints;
    this.lastAward = { label: 'STAR', points: TUNING.starPoints, combo: 1 };
    return { points: TUNING.starPoints, label: 'STAR' };
  }

  /**
   * A gate, ridden through or missed. A miss costs nothing but the streak —
   * consistent with the rest of the collectible track paying only in reward.
   */
  onGate(hit) {
    if (!hit) {
      this.gateStreak = 0;
      return null;
    }
    this.gateStreak++;
    this.gateBest = Math.max(this.gateBest, this.gateStreak);
    const bonus = TUNING.gateStreakBonus * Math.min(this.gateStreak - 1, TUNING.gateStreakCap);
    const points = TUNING.gateBase + bonus;
    this.total += points;
    const label = this.gateStreak > 1 ? `GATE ×${this.gateStreak}` : 'GATE';
    this.lastAward = { label, points, combo: 1 };
    return { points, label };
  }

  /**
   * A grind, banked on a clean pop-off. Rate-based like a grab, and — same
   * risk model as everything airborne — only paid if you rode away from it.
   */
  onGrindPopped(seconds) {
    const points = Math.round(TUNING.grindPerSecond * seconds + TUNING.grindPopBonus);
    if (points <= 0) return null;
    const award = this._add(points, 'GRIND');
    this.combo = Math.min(TUNING.comboMax, this.combo + 1);
    this.comboTimer = TUNING.comboDecay;
    this.tricksLanded++;
    this.biggestTrick = Math.max(this.biggestTrick, award.points);
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
    if (label) {
      this.lastAward = { label, points, combo: this.combo };
      this.log.push({ label, points });
    }
    return { points, label };
  }

  /**
   * The name of the thing you just did, assembled in the order a rider would
   * say it: stance, rotation, grab, then how it went.
   */
  _name(halfTurns, grab, trick) {
    const parts = [];
    if (trick.switchStance) parts.push('SW');
    if (halfTurns > 0) parts.push(String(halfTurns * 180));
    else if (trick.shifty) parts.push('SHIFTY');
    if (grab) parts.push(grab.name);
    if (!parts.length) parts.push('AIR');
    if (trick.popped) parts.push('· POP');
    if (trick.stomped) parts.push('· STOMPED');
    else if (!trick.clean) parts.push('· SKETCHY');
    return parts.join(' ');
  }

  /** 0–1 for how far the multiplier is through its decay, for the HUD bar. */
  get comboFraction() {
    return clamp(this.comboTimer / TUNING.comboDecay, 0, 1);
  }
}
