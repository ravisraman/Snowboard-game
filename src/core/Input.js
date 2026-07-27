/**
 * Keyboard input. WASD (or the arrow keys) to ride, Space to ollie, R to restart.
 *
 * `steer` is raw -1/0/1 on purpose: all of the smoothing lives in the rider's
 * edge-angle spring, so the weight of a turn is a property of the board rather
 * than of the input layer.
 */

const KEYMAP = {
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  KeyW: 'tuck', ArrowUp: 'tuck',
  KeyS: 'brake', ArrowDown: 'brake',
  Space: 'jump',
  KeyR: 'restart',
};

export class Input {
  constructor(target = window) {
    this.down = new Set();
    this.jumpPressed = false;
    this.restartPressed = false;

    /**
     * Written by the on-screen controls. Steering is analog here, unlike the
     * keyboard's ±1 — a thumb on a drag pad has a magnitude and it would be a
     * waste to throw it away, and the edge-angle spring reads any value in
     * between perfectly happily.
     */
    this.touch = { steer: 0, tuck: false, brake: false };

    this._onKeyDown = (e) => {
      const action = KEYMAP[e.code];
      if (!action) return;
      // Space and the arrows scroll the page otherwise.
      e.preventDefault();
      if (e.repeat) return;
      if (action === 'jump') this.jumpPressed = true;
      if (action === 'restart') this.restartPressed = true;
      this.down.add(action);
      this._anyKey = true;
    };

    this._onKeyUp = (e) => {
      const action = KEYMAP[e.code];
      if (action) this.down.delete(action);
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

  get tuck() { return this.down.has('tuck') || this.touch.tuck; }
  get brake() { return this.down.has('brake') || this.touch.brake; }

  /** Call once per frame, after the world has read the edge-triggered flags. */
  endFrame() {
    this.jumpPressed = false;
    this.restartPressed = false;
  }

  clear() {
    this.down.clear();
    this.touch.steer = 0;
    this.touch.tuck = false;
    this.touch.brake = false;
    this.jumpPressed = false;
    this.restartPressed = false;
  }

  dispose() {
    this._target.removeEventListener('keydown', this._onKeyDown);
    this._target.removeEventListener('keyup', this._onKeyUp);
    this._target.removeEventListener('blur', this._onBlur);
  }
}
