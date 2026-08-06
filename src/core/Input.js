/**
 * Keyboard input. WASD (or the arrow keys) to ride, Space to ollie, R to restart.
 *
 * `steer` is raw -1/0/1 on purpose: all of the smoothing lives in the rider's
 * edge-angle spring, so the weight of a turn is a property of the board rather
 * than of the input layer.
 *
 * The grab keys are the one place this layer knows about tricks, and only
 * enough to say *which* grab is being asked for — whether a grab is possible at
 * all is the rider's business, not the keyboard's.
 */

const KEYMAP = {
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  KeyW: 'tuck', ArrowUp: 'tuck',
  KeyS: 'brake', ArrowDown: 'brake',
  Space: 'jump',
  KeyR: 'restart',
  KeyE: 'rescue',
  KeyQ: 'melon',
  KeyF: 'method',
  ShiftLeft: 'press', ShiftRight: 'press',
  Escape: 'help', KeyH: 'help', Slash: 'help',
};

export class Input {
  constructor(target = window) {
    this.down = new Set();
    this.jumpPressed = false;
    /**
     * Set on the frame the jump key comes *up*, which is when a charged ollie
     * actually fires. Edge-triggered like `jumpPressed` and cleared by
     * `endFrame` in the same place.
     */
    this.jumpReleased = false;
    this.restartPressed = false;
    this.rescuePressed = false;
    this.helpPressed = false;

    /**
     * Written by the on-screen controls. Steering is analog here, unlike the
     * keyboard's ±1 — a thumb on a drag pad has a magnitude and it would be a
     * waste to throw it away, and the edge-angle spring reads any value in
     * between perfectly happily.
     */
    this.touch = { steer: 0, tuck: false, brake: false, press: false };

    this._onKeyDown = (e) => {
      const action = KEYMAP[e.code];
      if (!action) return;
      // Space and the arrows scroll the page otherwise.
      e.preventDefault();
      if (e.repeat) return;
      if (action === 'jump') this.jumpPressed = true;
      if (action === 'restart') this.restartPressed = true;
      if (action === 'rescue') this.rescuePressed = true;
      if (action === 'help') this.helpPressed = true;
      this.down.add(action);
    };

    this._onKeyUp = (e) => {
      const action = KEYMAP[e.code];
      if (!action) return;
      if (action === 'jump') this.jumpReleased = true;
      this.down.delete(action);
    };

    this._onBlur = () => this.down.clear();

    target.addEventListener('keydown', this._onKeyDown, { passive: false });
    target.addEventListener('keyup', this._onKeyUp);
    target.addEventListener('blur', this._onBlur);
    this._target = target;
  }

  get steer() {
    const keys = (this.down.has('right') ? 1 : 0) - (this.down.has('left') ? 1 : 0);
    const s = keys + this.touch.steer;
    return s < -1 ? -1 : s > 1 ? 1 : s;
  }

  /**
   * Whether the jump key is still down, so the ollie can be charged.
   *
   * Deliberately keyboard-only. The on-screen button writes `jumpPressed`
   * directly without ever entering `down`, so a tap on a phone reads as
   * pressed-but-never-held and pops instantly at zero charge — which is the
   * right behaviour for a control you cannot hold accurately anyway.
   */
  get jumpHeld() { return this.down.has('jump'); }

  get tuck() { return this.down.has('tuck') || this.touch.tuck; }
  get brake() { return this.down.has('brake') || this.touch.brake; }
  get press() { return this.down.has('press') || this.touch.press; }

  /**
   * Which grab is being asked for, or null. Tuck and brake double up here —
   * neither does anything airborne, so the two keys a rider already has under
   * their fingers become two of the four grabs, and the phone gets both without
   * growing a single new button.
   */
  get grabType() {
    if (this.down.has('method')) return 'method';
    if (this.down.has('melon')) return 'melon';
    if (this.tuck) return 'nose';
    if (this.brake) return 'indy';
    return null;
  }

  /** Call once per frame, after the world has read the edge-triggered flags. */
  endFrame() {
    this.jumpPressed = false;
    this.jumpReleased = false;
    this.restartPressed = false;
    this.rescuePressed = false;
    this.helpPressed = false;
  }

  clear() {
    this.down.clear();
    this.touch.steer = 0;
    this.touch.tuck = false;
    this.touch.brake = false;
    this.touch.press = false;
    this.jumpPressed = false;
    this.jumpReleased = false;
    this.restartPressed = false;
    this.rescuePressed = false;
    this.helpPressed = false;
  }

  dispose() {
    this._target.removeEventListener('keydown', this._onKeyDown);
    this._target.removeEventListener('keyup', this._onKeyUp);
    this._target.removeEventListener('blur', this._onBlur);
  }
}
