// Turbo Legends — unified input: keyboard, gamepad, and touch mapped onto the
// makeControls() shape (see src/game/kart.js). Presentation-side module: it
// may touch the DOM, but only inside the constructor/methods so importing it
// under Node (tools/syntax-check.mjs stubs) is side-effect free.
//
// Design notes:
// - Keyboard uses e.code (physical layout independent — WASD works anywhere).
// - Gamepad standard mapping: 0=A 1=B 2=X 3=Y 4=LB 5=RB 6=LT 7=RT 9=Start
//   12..15=dpad. Throttle/brake read the analog trigger values so RT is a
//   real analog gas pedal.
// - readControls() reports LEVELS only (the item system edge-detects useItem
//   itself); menu navigation, anyKey and muteToggle are per-update EDGES.
// - Digital steering is intentionally not smoothed here — physics owns that.
// - Zero allocation in update()/readControls(): all per-frame state lives in
//   scalar fields, one reused `menu` object, and pad buttons in a bitmask.

/** Analog stick deadzone; inputs inside it read as exactly 0. */
const DEADZONE = 0.18;
/** Stick deflection that counts as a digital menu-nav press. */
const MENU_STICK = 0.5;
/** Right-stick pulled toward the player → look back. */
const LOOKBACK_STICK = 0.6;
/** Horizontal drag distance (px) for full touch steering lock. */
const TOUCH_STEER_RANGE_PX = 72;
/** Ignore trigger noise below this raw value. */
const TRIGGER_NOISE = 0.02;

/** Standard-mapping gamepad button indices. */
const PAD = Object.freeze({
  A: 0, B: 1, X: 2, Y: 3,
  LB: 4, RB: 5, LT: 6, RT: 7,
  START: 9,
  DPAD_UP: 12, DPAD_DOWN: 13, DPAD_LEFT: 14, DPAD_RIGHT: 15,
});

/** Keys whose browser default (page scroll, focused-button re-click) we suppress. */
const PREVENT_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

// Shared options object so addEventListener calls never allocate.
const PASSIVE_FALSE = Object.freeze({ passive: false });

/** True when the event target is a text-entry element (don't eat its keys). */
function isTypingTarget(t) {
  if (!t || !t.tagName) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true;
}

/** Deadzone with rescale so output still spans the full -1..1 smoothly. */
function deadzone(v) {
  if (v > DEADZONE) return Math.min((v - DEADZONE) / (1 - DEADZONE), 1);
  if (v < -DEADZONE) return Math.max((v + DEADZONE) / (1 - DEADZONE), -1);
  return 0;
}

/** Analog value of a pad button; falls back to pressed for digital pads. */
function buttonValue(buttons, i) {
  const b = buttons[i];
  if (!b) return 0;
  const v = typeof b.value === 'number' ? b.value : (b.pressed ? 1 : 0);
  return v > TRIGGER_NOISE ? v : 0;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

export class InputManager {
  /**
   * @param {EventTarget} [targetEl=window] element receiving keyboard events
   */
  constructor(targetEl = window) {
    this._target = targetEl;

    // --- Keyboard ----------------------------------------------------------
    /** Currently held key codes. */
    this._keys = new Set();
    this._kbEdge = false;      // a new key went down since last update()

    // --- Public edge state (refreshed by update()) --------------------------
    /** Menu navigation, edge-triggered (true for exactly one update). */
    this.menu = {
      up: false, down: false, left: false, right: false,
      confirm: false, back: false, pause: false,
    };
    /** Any key/button/touch went down this update (title screens). */
    this.anyKey = false;
    /** KeyM went down this update. */
    this.muteToggle = false;
    /** True only while Tab is held inside an active, unpaused race. */
    this._standingsHeld = false;
    this._standingsContext = false;

    // Previous levels backing the edge detection above.
    this._pUp = false; this._pDown = false; this._pLeft = false; this._pRight = false;
    this._pConfirm = false; this._pBack = false; this._pPause = false; this._pMute = false;

    // --- Gamepad (polled each update) ---------------------------------------
    this._padConnected = false;
    this._padMask = 0;         // bitmask of pressed buttons 0..15
    this._padPrevMask = 0;
    this._padThrottle = 0;     // analog 0..1 (max of RT value and A)
    this._padBrake = 0;        // analog 0..1 (max of LT value and B)
    this._padSteer = 0;        // -1..1 post-deadzone
    this._padDrift = false;
    this._padItem = false;
    this._padLookBack = false;
    this._menuStickX = 0;      // raw left stick for menu nav thresholds
    this._menuStickY = 0;

    // --- Touch ---------------------------------------------------------------
    this._touchEnabled = typeof window !== 'undefined' && 'ontouchstart' in window;
    this._touchEdge = false;
    this._touchSteer = 0;      // -1..1 from the steer zone drag
    this._touchDrift = false;
    this._touchBrake = false;
    this._touchItem = false;
    this._touchPauseEdge = false;
    this._steerTouchId = -1;   // active touch identifier in the steer zone
    this._steerStartX = 0;
    this._steerZoneEl = null;  // bound lazily — the HUD creates these later
    this._driftBtnEl = null;
    this._brakeBtnEl = null;
    this._itemBtnEl = null;
    this._pauseBtnEl = null;

    /** 'kb' | 'pad' | 'touch' — whichever source was active most recently. */
    this._lastKind = this._touchEnabled ? 'touch' : 'kb';

    // --- Handlers (bound once so dispose() can detach them) ------------------
    this._onKeyDown = (e) => {
      const code = e.code;
      if (!code) return;
      if (code === 'Tab' && this._standingsContext && !isTypingTarget(e.target)) {
        e.preventDefault();
        this._standingsHeld = true;
      }
      if (PREVENT_KEYS.has(code) && !isTypingTarget(e.target)) e.preventDefault();
      if (e.repeat) return;
      if (!this._keys.has(code)) {
        this._keys.add(code);
        this._kbEdge = true;
        this._lastKind = 'kb';
      }
    };
    this._onKeyUp = (e) => {
      if (e.code === 'Tab') this._standingsHeld = false;
      if (e.code) this._keys.delete(e.code);
    };
    this._onBlur = () => {
      // Lost focus mid-race: never leave a phantom key held down.
      this._keys.clear();
      this._touchSteer = 0;
      this._touchDrift = false;
      this._touchBrake = false;
      this._touchItem = false;
      this._touchPauseEdge = false;
      this._steerTouchId = -1;
      this._standingsHeld = false;
      this._setTouchSteerVisual(0, false);
      this._setTouchButtonPressed(this._driftBtnEl, false);
      this._setTouchButtonPressed(this._brakeBtnEl, false);
      this._setTouchButtonPressed(this._itemBtnEl, false);
    };

    this._onSteerStart = (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      if (!t) return;
      // Newest touch takes over the zone (players re-grip constantly).
      this._steerTouchId = t.identifier;
      this._steerStartX = t.clientX;
      this._touchSteer = 0;
      this._touchEdge = true;
      this._lastKind = 'touch';
      this._setTouchSteerVisual(0, true);
    };
    this._onSteerMove = (e) => {
      e.preventDefault();
      const list = e.changedTouches;
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        if (t.identifier === this._steerTouchId) {
          this._touchSteer = clamp((t.clientX - this._steerStartX) / TOUCH_STEER_RANGE_PX, -1, 1);
          this._setTouchSteerVisual(this._touchSteer, true);
          return;
        }
      }
    };
    this._onSteerEnd = (e) => {
      const list = e.changedTouches;
      for (let i = 0; i < list.length; i++) {
        if (list[i].identifier === this._steerTouchId) {
          this._steerTouchId = -1;
          this._touchSteer = 0;
          this._setTouchSteerVisual(0, false);
          return;
        }
      }
    };

    this._onDriftDown = (e) => {
      e.preventDefault();
      this._touchDrift = true;
      this._touchEdge = true;
      this._lastKind = 'touch';
      this._setTouchButtonPressed(this._driftBtnEl, true);
    };
    this._onDriftUp = () => {
      this._touchDrift = false;
      this._setTouchButtonPressed(this._driftBtnEl, false);
    };
    this._onBrakeDown = (e) => {
      e.preventDefault();
      this._touchBrake = true;
      this._touchEdge = true;
      this._lastKind = 'touch';
      this._setTouchButtonPressed(this._brakeBtnEl, true);
    };
    this._onBrakeUp = () => {
      this._touchBrake = false;
      this._setTouchButtonPressed(this._brakeBtnEl, false);
    };
    this._onItemDown = (e) => {
      e.preventDefault();
      this._touchItem = true;
      this._touchEdge = true;
      this._lastKind = 'touch';
      this._setTouchButtonPressed(this._itemBtnEl, true);
    };
    this._onItemUp = () => {
      this._touchItem = false;
      this._setTouchButtonPressed(this._itemBtnEl, false);
    };
    this._onPauseDown = (e) => {
      e.preventDefault();
      this._touchPauseEdge = true;
      this._touchEdge = true;
      this._lastKind = 'touch';
      this._setTouchButtonPressed(this._pauseBtnEl, true);
    };
    this._onPauseUp = () => { this._setTouchButtonPressed(this._pauseBtnEl, false); };

    // --- Attach --------------------------------------------------------------
    targetEl.addEventListener('keydown', this._onKeyDown);
    targetEl.addEventListener('keyup', this._onKeyUp);
    if (typeof window !== 'undefined') window.addEventListener('blur', this._onBlur);

    if (this._touchEnabled && typeof document !== 'undefined'
        && document.body && document.body.classList) {
      // Lets styles.css show the touch HUD (steer zone + buttons).
      document.body.classList.add('touch');
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  get usingGamepad() { return this._lastKind === 'pad'; }
  get usingTouch() { return this._lastKind === 'touch'; }
  get lastInputKind() { return this._lastKind; }
  get gamepadConnected() { return this._padConnected; }
  get standingsHeld() { return this._standingsHeld && this._standingsContext; }

  /** Limit Tab capture to gameplay so normal menu focus traversal still works. */
  setStandingsContext(active) {
    this._standingsContext = Boolean(active);
    if (!this._standingsContext) this._standingsHeld = false;
  }

  /** Poll the gamepad and refresh all edge states. Call once per rendered frame. */
  update() {
    if (this._touchEnabled) this._bindTouchEls();
    this._pollGamepad();

    const k = this._keys;
    const mask = this._padMask;
    const sx = this._menuStickX;
    const sy = this._menuStickY;

    // Current LEVELS for each menu action, merged across keyboard + pad.
    const up = k.has('ArrowUp') || k.has('KeyW')
      || (mask & (1 << PAD.DPAD_UP)) !== 0 || sy < -MENU_STICK;
    const down = k.has('ArrowDown') || k.has('KeyS')
      || (mask & (1 << PAD.DPAD_DOWN)) !== 0 || sy > MENU_STICK;
    const left = k.has('ArrowLeft') || k.has('KeyA')
      || (mask & (1 << PAD.DPAD_LEFT)) !== 0 || sx < -MENU_STICK;
    const right = k.has('ArrowRight') || k.has('KeyD')
      || (mask & (1 << PAD.DPAD_RIGHT)) !== 0 || sx > MENU_STICK;
    const confirm = k.has('Enter') || k.has('NumpadEnter') || k.has('Space')
      || (mask & (1 << PAD.A)) !== 0;
    const back = k.has('Escape') || (mask & (1 << PAD.B)) !== 0;
    const pause = k.has('Escape') || (mask & (1 << PAD.START)) !== 0;
    const mute = k.has('KeyM');

    // Edges = pressed this update && not pressed last update.
    const m = this.menu;
    m.up = up && !this._pUp;
    m.down = down && !this._pDown;
    m.left = left && !this._pLeft;
    m.right = right && !this._pRight;
    m.confirm = confirm && !this._pConfirm;
    m.back = back && !this._pBack;
    m.pause = (pause && !this._pPause) || this._touchPauseEdge;
    this.muteToggle = mute && !this._pMute;

    this._pUp = up; this._pDown = down; this._pLeft = left; this._pRight = right;
    this._pConfirm = confirm; this._pBack = back; this._pPause = pause; this._pMute = mute;

    this.anyKey = this._kbEdge || this._touchEdge
      || (mask & ~this._padPrevMask) !== 0;
    this._kbEdge = false;
    this._touchEdge = false;
    this._touchPauseEdge = false;
  }

  /**
   * Fill `out` (makeControls() shape) with current driving levels.
   * Keyboard wins when actively pressed, then pad, then touch — so plugging in
   * a pad never fights the keyboard mid-corner.
   * @param {{throttle:number,brake:number,steer:number,drift:boolean,useItem:boolean,lookBack:boolean}} out
   */
  readControls(out) {
    const k = this._keys;

    const kbThrottle = (k.has('ArrowUp') || k.has('KeyW')) ? 1 : 0;
    const kbBrake = (k.has('ArrowDown') || k.has('KeyS')) ? 1 : 0;
    let kbSteer = 0;
    if (k.has('ArrowLeft') || k.has('KeyA')) kbSteer -= 1;
    if (k.has('ArrowRight') || k.has('KeyD')) kbSteer += 1;

    // Standard mobile kart control: gas is automatic while touch is the
    // active input source; the player only steers and presses drift/item/brake.
    // Braking releases mobile auto-gas so holding the button at low speed can
    // engage reverse instead of fighting a simultaneous throttle level.
    const touchGas = (this._touchEnabled && this._lastKind === 'touch' && !this._touchBrake) ? 1 : 0;

    out.throttle = Math.max(kbThrottle, this._padThrottle, touchGas);
    out.brake = Math.max(kbBrake, this._padBrake, this._touchBrake ? 1 : 0);
    // Devices report screen-space steer (-1 = screen-left, +1 = screen-right).
    // The simulation's +yaw direction appears on screen-left through the
    // three.js chase camera, so convert screen-space input to sim-space here.
    const rawSteer = kbSteer !== 0 ? kbSteer
      : (this._padSteer !== 0 ? this._padSteer : this._touchSteer);
    out.steer = -rawSteer;
    out.drift = k.has('Space') || k.has('ShiftLeft') || k.has('ShiftRight')
      || this._padDrift || this._touchDrift;
    // LEVEL, not edge — the item system edge-detects internally.
    out.useItem = k.has('ControlLeft') || k.has('ControlRight') || k.has('KeyE')
      || k.has('Enter') || this._padItem || this._touchItem;
    out.lookBack = k.has('KeyR') || this._padLookBack;
    return out;
  }

  /** Detach every listener. Safe to call twice. */
  dispose() {
    this._target.removeEventListener('keydown', this._onKeyDown);
    this._target.removeEventListener('keyup', this._onKeyUp);
    if (typeof window !== 'undefined') window.removeEventListener('blur', this._onBlur);
    if (this._steerZoneEl) {
      this._steerZoneEl.removeEventListener('touchstart', this._onSteerStart);
      this._steerZoneEl.removeEventListener('touchmove', this._onSteerMove);
      this._steerZoneEl.removeEventListener('touchend', this._onSteerEnd);
      this._steerZoneEl.removeEventListener('touchcancel', this._onSteerEnd);
      this._steerZoneEl = null;
    }
    if (this._driftBtnEl) {
      this._driftBtnEl.removeEventListener('touchstart', this._onDriftDown);
      this._driftBtnEl.removeEventListener('touchend', this._onDriftUp);
      this._driftBtnEl.removeEventListener('touchcancel', this._onDriftUp);
      this._driftBtnEl = null;
    }
    if (this._brakeBtnEl) {
      this._brakeBtnEl.removeEventListener('touchstart', this._onBrakeDown);
      this._brakeBtnEl.removeEventListener('touchend', this._onBrakeUp);
      this._brakeBtnEl.removeEventListener('touchcancel', this._onBrakeUp);
      this._brakeBtnEl = null;
    }
    if (this._itemBtnEl) {
      this._itemBtnEl.removeEventListener('touchstart', this._onItemDown);
      this._itemBtnEl.removeEventListener('touchend', this._onItemUp);
      this._itemBtnEl.removeEventListener('touchcancel', this._onItemUp);
      this._itemBtnEl = null;
    }
    if (this._pauseBtnEl) {
      this._pauseBtnEl.removeEventListener('touchstart', this._onPauseDown);
      this._pauseBtnEl.removeEventListener('touchend', this._onPauseUp);
      this._pauseBtnEl.removeEventListener('touchcancel', this._onPauseUp);
      this._pauseBtnEl = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * The HUD builds #touch-steer-zone / .btn-drift / .btn-item after we're
   * constructed, so bind lazily: cheap null queries until they exist, then
   * a one-time listener attach.
   */
  _bindTouchEls() {
    if (typeof document === 'undefined') return;
    if (!this._steerZoneEl) {
      const el = document.getElementById('touch-steer-zone');
      if (el) {
        this._steerZoneEl = el;
        el.addEventListener('touchstart', this._onSteerStart, PASSIVE_FALSE);
        el.addEventListener('touchmove', this._onSteerMove, PASSIVE_FALSE);
        el.addEventListener('touchend', this._onSteerEnd, PASSIVE_FALSE);
        el.addEventListener('touchcancel', this._onSteerEnd, PASSIVE_FALSE);
      }
    }
    if (!this._driftBtnEl) {
      const el = document.querySelector('.btn-drift');
      if (el) {
        this._driftBtnEl = el;
        el.addEventListener('touchstart', this._onDriftDown, PASSIVE_FALSE);
        el.addEventListener('touchend', this._onDriftUp, PASSIVE_FALSE);
        el.addEventListener('touchcancel', this._onDriftUp, PASSIVE_FALSE);
      }
    }
    if (!this._brakeBtnEl) {
      const el = document.querySelector('.btn-brake');
      if (el) {
        this._brakeBtnEl = el;
        el.addEventListener('touchstart', this._onBrakeDown, PASSIVE_FALSE);
        el.addEventListener('touchend', this._onBrakeUp, PASSIVE_FALSE);
        el.addEventListener('touchcancel', this._onBrakeUp, PASSIVE_FALSE);
      }
    }
    if (!this._itemBtnEl) {
      const el = document.querySelector('.btn-item');
      if (el) {
        this._itemBtnEl = el;
        el.addEventListener('touchstart', this._onItemDown, PASSIVE_FALSE);
        el.addEventListener('touchend', this._onItemUp, PASSIVE_FALSE);
        el.addEventListener('touchcancel', this._onItemUp, PASSIVE_FALSE);
      }
    }
    if (!this._pauseBtnEl) {
      const el = document.querySelector('.btn-pause');
      if (el) {
        this._pauseBtnEl = el;
        el.addEventListener('touchstart', this._onPauseDown, PASSIVE_FALSE);
        el.addEventListener('touchend', this._onPauseUp, PASSIVE_FALSE);
        el.addEventListener('touchcancel', this._onPauseUp, PASSIVE_FALSE);
      }
    }
  }

  /** Keep the visible steering rail in sync without making it the hit target. */
  _setTouchSteerVisual(value, active) {
    const pad = this._steerZoneEl?.querySelector?.('.touch-steer-pad');
    if (!pad) return;
    pad.style?.setProperty('--touch-steer-offset', `${Math.round(value * 38)}px`);
    pad.classList?.toggle('is-active', active);
  }

  _setTouchButtonPressed(el, pressed) {
    el?.classList?.toggle('is-pressed', pressed);
  }

  /** Read the first connected gamepad into scalar frame state. */
  _pollGamepad() {
    this._padPrevMask = this._padMask;

    let pad = null;
    if (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function') {
      const pads = navigator.getGamepads();
      if (pads) {
        for (let i = 0; i < pads.length; i++) {
          const p = pads[i];
          if (p && p.connected !== false) { pad = p; break; }
        }
      }
    }

    this._padConnected = pad !== null;
    if (!pad) {
      this._padMask = 0;
      this._padThrottle = 0;
      this._padBrake = 0;
      this._padSteer = 0;
      this._padDrift = false;
      this._padItem = false;
      this._padLookBack = false;
      this._menuStickX = 0;
      this._menuStickY = 0;
      return;
    }

    const btns = pad.buttons;
    const axes = pad.axes;

    let mask = 0;
    const n = btns.length < 16 ? btns.length : 16;
    for (let i = 0; i < n; i++) {
      const b = btns[i];
      if (b && (b.pressed || b.value > 0.5)) mask |= 1 << i;
    }
    this._padMask = mask;

    const rt = buttonValue(btns, PAD.RT);
    const lt = buttonValue(btns, PAD.LT);
    this._padThrottle = Math.max(rt, (mask & (1 << PAD.A)) !== 0 ? 1 : 0);
    this._padBrake = Math.max(lt, (mask & (1 << PAD.B)) !== 0 ? 1 : 0);
    this._padDrift = (mask & ((1 << PAD.RB) | (1 << PAD.X))) !== 0;
    this._padItem = (mask & ((1 << PAD.LB) | (1 << PAD.Y))) !== 0;

    const lx = axes.length > 0 ? axes[0] : 0;
    const ly = axes.length > 1 ? axes[1] : 0;
    const ry = axes.length > 3 ? axes[3] : 0;
    let steer = deadzone(lx);
    // Dpad steers too, at full lock (nice for digital-pad players).
    if ((mask & (1 << PAD.DPAD_LEFT)) !== 0) steer = -1;
    else if ((mask & (1 << PAD.DPAD_RIGHT)) !== 0) steer = 1;
    this._padSteer = steer;
    this._padLookBack = ry > LOOKBACK_STICK;
    this._menuStickX = lx;
    this._menuStickY = ly;

    // Any pad activity makes the pad the active input source.
    if ((mask & ~this._padPrevMask) !== 0 || steer !== 0 || rt > 0.12 || lt > 0.12) {
      this._lastKind = 'pad';
    }
  }
}
