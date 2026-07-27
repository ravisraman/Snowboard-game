import { clamp } from './mathx.js';

/**
 * On-screen controls for phones and tablets.
 *
 * Steering is a *relative* drag rather than a fixed stick: wherever the left
 * thumb lands becomes the centre, and the offset from there is the edge angle.
 * On a screen with no rim to feel for, an absolute stick means constantly
 * hunting for a target you can't see under your own thumb.
 *
 * The origin is also sticky — drag past full lock and the centre follows, so
 * flipping from a hard left carve to a hard right one is one thumb-width of
 * travel instead of a journey back across the pad.
 */

const FULL_LOCK_PX = 58;

export class TouchControls {
  constructor(input) {
    this.input = input;
    this.root = document.getElementById('touch-controls');
    this.pad = document.getElementById('touch-steer');
    this.knob = document.getElementById('touch-knob');
    if (!this.root || !this.pad) return;

    this.pointerId = null;
    this.originX = 0;

    this.pad.addEventListener('pointerdown', this._onDown, { passive: false });
    this.pad.addEventListener('pointermove', this._onMove, { passive: false });
    this.pad.addEventListener('pointerup', this._onUp);
    this.pad.addEventListener('pointercancel', this._onUp);

    this._bindButton('touch-jump', () => { this.input.jumpPressed = true; });
    this._bindHold('touch-tuck', (held) => { this.input.touch.tuck = held; });
    this._bindHold('touch-brake', (held) => { this.input.touch.brake = held; });

    this.brakeBtn = document.getElementById('touch-brake');
    this._airborne = null;
  }

  /**
   * Brake has nothing to do in the air, so the same button is the grab. It
   * relabels itself rather than adding a fifth control to a phone screen.
   */
  setAirborne(airborne) {
    if (airborne === this._airborne || !this.brakeBtn) return;
    this._airborne = airborne;
    this.brakeBtn.textContent = airborne ? 'GRAB' : 'BRAKE';
    this.brakeBtn.classList.toggle('is-grab', airborne);
  }

  /** Momentary: fires once on press. */
  _bindButton(id, fire) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.classList.add('is-down');
      fire();
    }, { passive: false });
    const release = () => el.classList.remove('is-down');
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('pointerleave', release);
  }

  /** Held: true while pressed, false on release. */
  _bindHold(id, set) {
    const el = document.getElementById(id);
    if (!el) return;
    const down = (e) => {
      e.preventDefault();
      el.setPointerCapture?.(e.pointerId);
      el.classList.add('is-down');
      set(true);
    };
    const up = () => {
      el.classList.remove('is-down');
      set(false);
    };
    el.addEventListener('pointerdown', down, { passive: false });
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', up);
  }

  _onDown = (e) => {
    if (this.pointerId !== null) return;
    e.preventDefault();
    this.pointerId = e.pointerId;
    this.originX = e.clientX;
    this.pad.setPointerCapture?.(e.pointerId);
    this.pad.classList.add('is-active');
    this._place(e.clientY, 0);
  };

  _onMove = (e) => {
    if (e.pointerId !== this.pointerId) return;
    e.preventDefault();

    let dx = e.clientX - this.originX;
    // Sticky origin: past full lock, drag the centre along behind the thumb.
    if (dx > FULL_LOCK_PX) {
      this.originX = e.clientX - FULL_LOCK_PX;
      dx = FULL_LOCK_PX;
    } else if (dx < -FULL_LOCK_PX) {
      this.originX = e.clientX + FULL_LOCK_PX;
      dx = -FULL_LOCK_PX;
    }

    this.input.touch.steer = clamp(dx / FULL_LOCK_PX, -1, 1);
    this._place(e.clientY, dx);
  };

  _onUp = (e) => {
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.input.touch.steer = 0;
    this.pad.classList.remove('is-active');
  };

  /**
   * The knob is only an indicator, so it is kept inside the pad even when the
   * thumb wanders past the edge. Steering still reads the raw drag — but an
   * unclamped knob slides out under the action buttons and looks like a bug.
   */
  _place(clientY, dx) {
    if (!this.knob) return;
    const rect = this.pad.getBoundingClientRect();
    const r = this.knob.offsetWidth * 0.5;
    const x = clamp(this.originX - rect.left + dx, r, Math.max(r, rect.width - r));
    const y = clamp(clientY - rect.top, r, Math.max(r, rect.height - r));
    this.knob.style.transform = `translate(${x}px, ${y}px)`;
  }

  setVisible(visible) {
    this.root?.classList.toggle('on', visible);
    if (!visible) {
      this.input.touch.steer = 0;
      this.input.touch.tuck = false;
      this.input.touch.brake = false;
      this.pointerId = null;
    }
  }
}
