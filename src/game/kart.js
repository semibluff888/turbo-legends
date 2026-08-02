// Kart: the complete state of one racer.
//
// This is the central shared data structure. Physics writes motion, the item
// system writes effects, the race director writes lap/rank, AI and input write
// `controls`, and the renderer reads everything. No THREE, no DOM.

import { KART, KART_STATE, ITEM, ITEM_INFO, SURFACE, DRIFT_TIERS } from '../core/constants.js';
import { clamp } from '../core/mathx.js';
import { resolveKartAppearance } from './appearance.js';

/**
 * Control inputs for one simulation step. AI and human input both produce this
 * exact shape, which is what lets the player kart and the AI karts run through
 * the identical physics function.
 */
export function makeControls() {
  return {
    throttle: 0,   // 0..1
    brake: 0,      // 0..1
    steer: 0,      // -1 (left) .. +1 (right)
    drift: false,  // drift/hop button held
    useItem: false,// rising edge consumed by the item system
    lookBack: false,
  };
}

export function resetControls(c) {
  c.throttle = 0;
  c.brake = 0;
  c.steer = 0;
  c.drift = false;
  c.useItem = false;
  c.lookBack = false;
  return c;
}

export class Kart {
  /**
   * @param {object} opts
   * @param {number} opts.index grid index / stable id
   * @param {object} opts.character character definition (see characters.js)
   * @param {boolean} opts.isPlayer
   * @param {string|null} [opts.participantId] stable race participant identity
   * @param {string|null} [opts.displayName] player-facing racer name
   * @param {string|null} [opts.controllerKind] 'human' | 'ai' | 'takeover-ai'
   * @param {string|null} [opts.paintId] cosmetic paint theme
   * @param {string|null} [opts.avatarId] cosmetic driver avatar
   */
  constructor({
    index,
    character,
    isPlayer = false,
    participantId = null,
    displayName = null,
    controllerKind = null,
    paintId = null,
    avatarId = null,
  }) {
    this.index = index;
    this.id = `kart${index}`;
    this.character = character;
    this.isPlayer = isPlayer;
    this.participantId = participantId;
    this.displayName = displayName || character.name;
    this.controllerKind = controllerKind;
    this.name = this.displayName;
    const appearance = resolveKartAppearance(character, { paintId, avatarId });
    this.paintId = appearance.paintId;
    this.avatarId = appearance.avatarId;
    this.avatar = appearance.avatar;
    this.color = appearance.color;
    this.accentColor = appearance.accentColor;

    // --- Transform ---------------------------------------------------------
    this.x = 0; this.y = 0; this.z = 0;
    this.yaw = 0;              // heading, radians, atan2(dx, dz) convention
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.speed = 0;            // signed forward speed along `yaw`
    this.airborne = false;

    // Visual-only body orientation (drift lean, squash, hop).
    this.visualYawOffset = 0;
    this.visualRoll = 0;
    this.visualPitch = 0;
    this.visualScale = 1;
    this.wheelSpin = 0;

    // --- Controls ----------------------------------------------------------
    this.controls = makeControls();
    this.steerAngle = 0;       // smoothed steering, -maxSteerAngle..+maxSteerAngle

    // --- Drift -------------------------------------------------------------
    this.drifting = false;
    this.driftDirection = 0;   // -1 left, +1 right, 0 none
    this.driftCharge = 0;      // seconds of sustained drift
    this.driftTier = -1;       // index into DRIFT_TIERS, -1 = none
    this.hopTimer = 0;

    // --- Boost -------------------------------------------------------------
    this.boostTimer = 0;
    this.boostPower = 1;       // max-speed multiplier while boostTimer > 0
    this.boostSource = '';     // 'drift' | 'pad' | 'mushroom' | 'start' | 'draft' | 'star' | 'bullet'
    this.speedMul = 1;         // smoothed applied multiplier (renderer reads this)
    this.draftCharge = 0;

    // --- Status ------------------------------------------------------------
    this.state = KART_STATE.NORMAL;
    this.stateTimer = 0;
    /** AI rubber-band multiplier on max speed (always 1 for the player). */
    this.aiSpeedMul = 1;
    /** While > 0 the throttle is locked to zero (jumped the start). */
    this.startPenaltyTimer = 0;
    this.invulnTimer = 0;      // brief i-frames after recovering
    this.starTimer = 0;        // invincibility (star)
    this.shrinkTimer = 0;      // lightning
    this.spinDirection = 1;

    // --- Items -------------------------------------------------------------
    this.item = ITEM.NONE;
    this.itemUses = 0;
    this.rouletteTimer = 0;    // > 0 while the item box roulette spins
    this.rouletteFace = ITEM.BANANA;
    this.pendingItem = ITEM.NONE;
    /** Items being dragged/held behind the kart (e.g. trailing shells). */
    this.heldCount = 0;

    // --- Track position ----------------------------------------------------
    this.s = 0;                // arc length along the spline
    this.lateral = 0;
    this.surface = SURFACE.ROAD;
    this.offTrackDepth = 0;
    /** Monotonic progress = lap * trackLength + s. Drives ranking. */
    this.progress = 0;
    this.lap = 0;              // 0 until the first crossing of the line
    this.rank = index + 1;
    this.finished = false;
    this.finishTime = 0;
    this.lapTimes = [];
    this.currentLapStart = 0;
    this.bestLap = Infinity;
    /** Guards the lap counter against back-and-forth over the line. */
    this._lastS = 0;
    this._wrongWayTimer = 0;
    this.wrongWay = false;

    // Position on the previous frame — used for swept collision tests.
    this.prevX = 0;
    this.prevZ = 0;

    // --- Stats (character multipliers) -------------------------------------
    const st = character.stats;
    this.statSpeed = st.speed;
    this.statAccel = st.accel;
    this.statHandling = st.handling;
    this.statWeight = st.weight;

    // Events emitted this step for audio/particles. Cleared each frame by
    // `clearEvents()` after the renderer and audio system have consumed them.
    this.events = [];
  }

  // -------------------------------------------------------------------------
  // Derived values
  // -------------------------------------------------------------------------

  /** Max speed right now, accounting for character, boost, terrain, lightning. */
  get maxSpeed() {
    let v = KART.maxSpeed * this.statSpeed;
    if (this.shrinkTimer > 0) v *= 0.62;
    return v;
  }

  get forwardX() { return Math.sin(this.yaw); }
  get forwardZ() { return Math.cos(this.yaw); }
  get rightX() { return Math.cos(this.yaw); }
  get rightZ() { return -Math.sin(this.yaw); }

  /** True when the kart cannot be damaged. */
  get invulnerable() {
    return this.starTimer > 0
      || this.invulnTimer > 0
      || this.state === KART_STATE.BULLET
      || this.state === KART_STATE.RESPAWNING;
  }

  /** True when the player/AI has no control (spun out, squashed, respawning). */
  get incapacitated() {
    return this.state === KART_STATE.SPINNING
      || this.state === KART_STATE.SQUASHED
      || this.state === KART_STATE.RESPAWNING;
  }

  /** Normalized 0..1 speed for HUD/FOV/audio. */
  get speedRatio() {
    return clamp(Math.abs(this.speed) / (KART.maxSpeed * this.statSpeed), 0, 2);
  }

  get itemInfo() {
    return ITEM_INFO[this.item] || null;
  }

  get driftTierInfo() {
    return this.driftTier >= 0 ? DRIFT_TIERS[this.driftTier] : null;
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /**
   * Apply a boost. Ignored if an equal-or-stronger boost is already running
   * with more time left, so a weak pad can't cut short a big mini-turbo.
   * A weaker-but-longer boost may extend the timer, but then the multiplier
   * drops to the weaker power — no stacking the strong power onto the long tail.
   */
  applyBoost(power, duration, source = 'boost') {
    if (this.boostTimer > 0 && this.boostPower >= power && this.boostTimer >= duration) return;
    if (this.boostTimer > 0 && duration > this.boostTimer && power < this.boostPower) {
      this.boostPower = power;
    } else {
      this.boostPower = Math.max(power, this.boostTimer > 0 ? this.boostPower : power);
    }
    this.boostTimer = Math.max(this.boostTimer, duration);
    this.boostSource = source;
    this.emit('boost', { source, power });
  }

  /** Knock the kart out of control (shell, banana). */
  spinOut(cause = 'hit') {
    if (this.invulnerable || this.state === KART_STATE.BULLET) return false;
    this.state = KART_STATE.SPINNING;
    this.stateTimer = KART.spinOutDuration;
    this.spinDirection = this.spinDirection * -1 || 1;
    this.speed *= KART.spinOutSpeedMul;
    this.cancelDrift();
    this.boostTimer = 0;
    this.boostPower = 1;
    this.emit('spinout', { cause });
    return true;
  }

  /** Flatten the kart (bomb, blue shell, lightning). Heavier stop than a spin. */
  squash(cause = 'blast') {
    if (this.invulnerable || this.state === KART_STATE.BULLET) return false;
    this.state = KART_STATE.SQUASHED;
    this.stateTimer = KART.squashDuration;
    this.speed = 0;
    this.vx = 0;
    this.vz = 0;
    this.cancelDrift();
    this.boostTimer = 0;
    this.boostPower = 1;
    this.emit('squash', { cause });
    return true;
  }

  cancelDrift() {
    this.drifting = false;
    this.driftDirection = 0;
    this.driftCharge = 0;
    this.driftTier = -1;
  }

  /** Push a gameplay event for audio/VFX. Kept tiny — cleared every frame. */
  emit(type, data = null) {
    this.events.push(data ? { type, ...data } : { type });
  }

  clearEvents() {
    if (this.events.length) this.events.length = 0;
  }

  /** Give the kart an item (after the roulette resolves). */
  giveItem(item) {
    this.item = item;
    this.itemUses = ITEM_INFO[item]?.uses ?? 1;
    this.emit('item_get', { item });
  }

  /** Consume one use. Clears the slot when uses run out. */
  consumeItemUse() {
    this.itemUses -= 1;
    if (this.itemUses <= 0) {
      this.item = ITEM.NONE;
      this.itemUses = 0;
    }
  }

  clearItem() {
    this.item = ITEM.NONE;
    this.itemUses = 0;
  }

  /** Full reset back onto the grid. */
  resetTo(x, y, z, yaw) {
    this.x = x; this.y = y; this.z = z;
    this.prevX = x; this.prevZ = z;
    this.yaw = yaw;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.speed = 0;
    this.airborne = false;
    this.steerAngle = 0;
    this.visualYawOffset = 0;
    this.visualRoll = 0;
    this.visualPitch = 0;
    this.visualScale = 1;
    this.cancelDrift();
    this.boostTimer = 0;
    this.boostPower = 1;
    this.speedMul = 1;
    this.draftCharge = 0;
    this.state = KART_STATE.NORMAL;
    this.stateTimer = 0;
    this.invulnTimer = 0;
    this.starTimer = 0;
    this.shrinkTimer = 0;
    this.aiSpeedMul = 1;
    this.startPenaltyTimer = 0;
    this.clearItem();
    this.rouletteTimer = 0;
    this.lap = 0;
    this.progress = 0;
    this.finished = false;
    this.finishTime = 0;
    this.lapTimes = [];
    this.currentLapStart = 0;
    this.bestLap = Infinity;
    this.wrongWay = false;
    this._wrongWayTimer = 0;
    resetControls(this.controls);
    this.clearEvents();
  }
}
