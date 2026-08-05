// RaceSimulation: authoritative, presentation-agnostic simulation for one race.
//
// A roster supplies 2-8 stable participant identities and their current
// controller ownership. Every kart has a pre-created independent AiDriver, so a
// human seat can switch to takeover AI (and back) without rebuilding the race.
// Human inputs are keyed by kart index and pass through the same physics and
// item pipeline as AI controls.

import { RACE, RACE_STATE, DIFFICULTY, SURFACE } from '../core/constants.js';
import { clamp, clamp01, loopDelta } from '../core/mathx.js';
import { deriveRng } from '../core/rng.js';
import { Kart, resetControls } from './kart.js';
import { CHARACTERS_BY_ID, isPlayableCharacterId } from './characters.js';
import { stepKartPhysics, resolveKartCollisions, updateDrafting } from './physics.js';
import { AiDriver } from './ai.js';
import { ItemSystem } from './items.js';

const START_PRESS_THRESHOLD = 0.5;
const LAP_TELEPORT_GUARD_FRAC = 0.25;
const WRONG_WAY_WINDOW = 1.5;
const WRONG_WAY_TRIGGER = -2.5;
const WRONG_WAY_MIN_SPEED = 3.0;

export const CONTROLLER_KIND = Object.freeze({
  HUMAN: 'human',
  AI: 'ai',
  TAKEOVER_AI: 'takeover-ai',
});

const CONTROLLER_KINDS = new Set(Object.values(CONTROLLER_KIND));

/** Return a copied roster in deterministic grid order for the supplied seed. */
export function shuffleRosterForGrid(roster, seed) {
  if (!Array.isArray(roster)) throw new TypeError('roster must be an array');
  const ordered = roster.map((entry) => ({ ...entry }));
  deriveRng(seed, 'roster-grid').shuffle(ordered);
  return ordered;
}

function compareStandings(a, b) {
  if (a.finished || b.finished) {
    if (a.finished && b.finished) return a._finishIndex - b._finishIndex;
    return a.finished ? -1 : 1;
  }
  if (b.progress !== a.progress) return b.progress - a.progress;
  return a.index - b.index;
}

function resolveDifficulty(difficulty) {
  if (typeof difficulty === 'string') {
    const key = DIFFICULTY[difficulty] ? difficulty : 'normal';
    return { key, value: DIFFICULTY[key] };
  }
  return { key: 'custom', value: difficulty || DIFFICULTY.normal };
}

function normalizeRoster(roster) {
  if (!Array.isArray(roster)
    || roster.length < 2
    || roster.length > RACE.totalKarts) {
    throw new RangeError(`RaceSimulation roster must contain 2 to ${RACE.totalKarts} entries`);
  }

  const participantIds = new Set();
  return roster.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError(`roster[${index}] must be an object`);
    }

    const participantId = String(entry.participantId || '').trim();
    if (!participantId) throw new TypeError(`roster[${index}].participantId is required`);
    if (participantIds.has(participantId)) {
      throw new TypeError(`duplicate participantId: ${participantId}`);
    }
    participantIds.add(participantId);

    const characterId = String(entry.characterId || '');
    const character = CHARACTERS_BY_ID[characterId];
    if (!character) throw new TypeError(`unknown characterId: ${characterId}`);
    if (!isPlayableCharacterId(characterId)) {
      throw new TypeError(`locked characterId: ${characterId}`);
    }

    const controllerKind = entry.controllerKind;
    if (!CONTROLLER_KINDS.has(controllerKind)) {
      throw new TypeError(`invalid controllerKind for ${participantId}: ${controllerKind}`);
    }

    const displayName = String(entry.displayName || character.name).trim() || character.name;
    return {
      ...entry,
      participantId,
      displayName,
      characterId,
      controllerKind,
      isPlayer: !!entry.isPlayer,
    };
  });
}

/**
 * Authoritative race simulation for a 2-8 kart roster.
 *
 * The supplied roster order is the authoritative grid order. Room/server code
 * can use shuffleRosterForGrid() before construction when it needs a seeded
 * randomized grid; preserving the order keeps announced kart indices stable.
 */
export class RaceSimulation {
  /**
   * @param {import('../track/track.js').Track} track
   * @param {object} opts
   * @param {Array<{
   *   participantId:string,
   *   displayName:string,
   *   characterId:string,
   *   controllerKind:'human'|'ai'|'takeover-ai',
   * }>} opts.roster
   * @param {string|object} [opts.difficulty]
   * @param {number} [opts.laps]
   * @param {number|string} [opts.seed]
   * @param {string} [opts.mode] caller-defined race context ('online'|'local')
   */
  constructor(track, {
    roster,
    difficulty = 'normal',
    laps = track.laps,
    seed = 12345,
    mode = 'online',
  } = {}) {
    if (!track) throw new TypeError('RaceSimulation requires a track');
    if (!Number.isInteger(laps) || laps < 1) {
      throw new RangeError('RaceSimulation laps must be a positive integer');
    }

    this.track = track;
    this.laps = laps;
    this.seed = seed;
    this.mode = mode;

    const resolved = resolveDifficulty(difficulty);
    this.difficultyKey = resolved.key;
    this.difficulty = resolved.value;

    // Named streams isolate grid order, item draws, and every individual AI.
    this.rosterRng = deriveRng(seed, 'roster-grid');
    this.itemRng = deriveRng(seed, 'items');
    // Backward-friendly handle for callers that only inspected `rng`.
    this.rng = this.itemRng;

    const normalizedRoster = normalizeRoster(roster);
    this._roster = normalizedRoster.map((entry) => ({ ...entry }));

    this._controllerKinds = this._roster.map((entry) => entry.controllerKind);
    this._rubberBandEligible = this._roster.map((entry) => (
      entry.controllerKind === CONTROLLER_KIND.AI && entry.rubberBandEligible !== false
    ));
    this._aiBaseSpeedEligible = this._roster.map((entry) => entry.aiBaseSpeedEligible !== false);

    this._karts = this._roster.map((entry, index) => new Kart({
      index,
      character: CHARACTERS_BY_ID[entry.characterId],
      isPlayer: entry.isPlayer,
      participantId: entry.participantId,
      displayName: entry.displayName,
      controllerKind: entry.controllerKind,
      paintId: entry.paintId ?? null,
      avatarId: entry.avatarId ?? null,
    }));

    this._aiRngs = this._roster.map((entry) => (
      deriveRng(seed, `ai:${entry.participantId}`)
    ));
    this._drivers = new Array(this._karts.length).fill(null);
    this._createDrivers();

    this._items = new ItemSystem(track, this.itemRng);

    this.state = RACE_STATE.COUNTDOWN;
    this.countdown = RACE.countdownDuration;
    this.elapsed = 0;

    this._finishOrder = [];
    this._firstFinishTime = null;
    this._startPress = new Array(this._karts.length).fill(null);
    this._standings = this._karts.slice();
    this._humanProgressScratch = [];

    this._world = {
      karts: this._karts,
      items: this._items,
      raceState: RACE_STATE.COUNTDOWN,
      elapsed: 0,
      countdown: RACE.countdownDuration,
      controllerKinds: this._controllerKinds,
      rubberBandEligible: this._rubberBandEligible,
      aiBaseSpeedEligible: this._aiBaseSpeedEligible,
      rubberBandTargetProgress: null,
    };
    this._gridScratch = { x: 0, y: 0, z: 0, heading: 0, s: 0 };
    this._finishersThisStep = [];

    this._placeGrid();
  }

  get roster() { return this._roster; }
  get karts() { return this._karts; }
  get items() { return this._items; }
  get standings() { return this._standings; }
  get controllerKinds() { return this._controllerKinds; }
  get isRaceOver() { return this.state === RACE_STATE.RESULTS; }
  get rubberBandTargetProgress() { return this._getRubberBandTargetProgress(); }

  getController(kartIndex) {
    this._assertKartIndex(kartIndex);
    return this._controllerKinds[kartIndex];
  }

  getKartIndexByParticipantId(participantId) {
    for (let i = 0; i < this._roster.length; i++) {
      if (this._roster[i].participantId === participantId) return i;
    }
    return -1;
  }

  /** Switch control ownership without replacing the Kart or its AiDriver. */
  setController(kartIndex, controllerKind) {
    this._assertKartIndex(kartIndex);
    if (!CONTROLLER_KINDS.has(controllerKind)) {
      throw new TypeError(`invalid controllerKind: ${controllerKind}`);
    }

    this._controllerKinds[kartIndex] = controllerKind;
    this._roster[kartIndex].controllerKind = controllerKind;
    this._karts[kartIndex].controllerKind = controllerKind;
    this._rubberBandEligible[kartIndex] = controllerKind === CONTROLLER_KIND.AI
      && this._roster[kartIndex].rubberBandEligible !== false;
    this._karts[kartIndex].aiSpeedMul = 1;
    resetControls(this._karts[kartIndex].controls);
    return controllerKind;
  }

  _assertKartIndex(kartIndex) {
    if (!Number.isInteger(kartIndex) || kartIndex < 0 || kartIndex >= this._karts.length) {
      throw new RangeError(`invalid kart index: ${kartIndex}`);
    }
  }

  _createDrivers() {
    for (let i = 0; i < this._karts.length; i++) {
      const rng = this._aiRngs[i];
      this._drivers[i] = new AiDriver(
        this._karts[i], this.track, rng, this.difficulty, rng.float(),
      );
    }
  }

  _placeGrid() {
    const slot = this._gridScratch;
    const length = this.track.length;
    for (let i = 0; i < this._karts.length; i++) {
      const kart = this._karts[i];
      this.track.gridSlot(i, this._karts.length, RACE.gridRowSpacing, RACE.gridColumnOffset, slot);
      kart.resetTo(slot.x, slot.y, slot.z, slot.heading);
      kart.s = slot.s;
      kart._lastS = slot.s;
      kart.lateral = (i % 2 === 0 ? -1 : 1) * RACE.gridColumnOffset;
      kart.surface = SURFACE.ROAD;
      kart.offTrackDepth = 0;
      kart._traveled = loopDelta(0, slot.s, length);
      kart.progress = kart._traveled;
      kart.lap = 1;
      kart.rank = i + 1;
      kart._finishIndex = -1;
      kart._lapsCounted = 0;
      kart._wwDist = 0;
      this._startPress[i] = null;
      this._standings[i] = kart;
    }
  }

  /** Restart this roster with identical grid order and independent RNG streams. */
  reset() {
    this.rosterRng.reset();
    this.itemRng.reset();
    for (const rng of this._aiRngs) rng.reset();
    this._createDrivers();
    this._placeGrid();
    this._items.reset();
    this._finishOrder.length = 0;
    this._firstFinishTime = null;
    this.state = RACE_STATE.COUNTDOWN;
    this.countdown = RACE.countdownDuration;
    this.elapsed = 0;
    this._syncWorld();
  }

  /**
   * Advance one simulation step.
   * @param {number} dt fixed timestep in seconds
   * @param {Array|Object|null} controlsByKartIndex human controls keyed by kart index
   */
  update(dt, controlsByKartIndex = null) {
    if (!Number.isFinite(dt) || dt <= 0 || this.state === RACE_STATE.RESULTS) return;

    if (this.state === RACE_STATE.COUNTDOWN) {
      this._updateCountdown(dt, controlsByKartIndex);
      return;
    }

    this.elapsed += dt;
    this._updateHumanControls(controlsByKartIndex);
    this._updateDrivers(dt);
    this._items.update(dt, this._karts, this.elapsed);

    for (const kart of this._karts) stepKartPhysics(kart, this.track, dt);
    resolveKartCollisions(this._karts, dt);
    updateDrafting(this._karts, dt);

    this._updateLapsAndProgress(dt);
    this._updateStateMachine();
    this._updateRanks();
  }

  _controlAt(controlsByKartIndex, kartIndex) {
    return controlsByKartIndex ? controlsByKartIndex[kartIndex] : null;
  }

  _updateCountdown(dt, controlsByKartIndex) {
    this.countdown -= dt;

    for (let i = 0; i < this._karts.length; i++) {
      if (this._controllerKinds[i] === CONTROLLER_KIND.HUMAN) {
        this._copyControls(this._karts[i].controls, this._controlAt(controlsByKartIndex, i));
      }
    }

    this._syncWorld();
    for (let i = 0; i < this._drivers.length; i++) {
      if (this._controllerKinds[i] !== CONTROLLER_KIND.HUMAN) {
        this._drivers[i].update(dt, this._world);
      }
    }

    for (let i = 0; i < this._karts.length; i++) {
      const held = this._karts[i].controls.throttle > START_PRESS_THRESHOLD;
      if (!held) this._startPress[i] = null;
      else if (this._startPress[i] === null) this._startPress[i] = this.countdown;
    }

    if (this.countdown > 0) return;

    this.countdown = 0;
    const [early, late] = RACE.rocketStartWindow;
    for (let i = 0; i < this._karts.length; i++) {
      const kart = this._karts[i];
      const pressAt = this._startPress[i];
      if (pressAt === null) continue;
      if (pressAt > early) {
        kart.startPenaltyTimer = RACE.jumpStartPenalty;
        kart.emit('jump_start');
      } else if (pressAt >= late) {
        kart.applyBoost(RACE.rocketStartPower, RACE.rocketStartDuration, 'start');
        kart.emit('rocket_start');
      }
    }
    this.state = RACE_STATE.RACING;
    this.elapsed = 0;
    for (const kart of this._karts) if (kart.isPlayer) kart.emit('go');
  }

  _updateHumanControls(controlsByKartIndex) {
    for (let i = 0; i < this._karts.length; i++) {
      if (this._controllerKinds[i] !== CONTROLLER_KIND.HUMAN) continue;
      const kart = this._karts[i];
      if (kart.finished) resetControls(kart.controls);
      else this._copyControls(kart.controls, this._controlAt(controlsByKartIndex, i));
    }
  }

  _copyControls(dst, src) {
    if (!src) {
      resetControls(dst);
      return;
    }
    const throttle = Number.isFinite(src.throttle) ? src.throttle : 0;
    const brake = Number.isFinite(src.brake) ? src.brake : 0;
    const steer = Number.isFinite(src.steer) ? src.steer : 0;
    dst.throttle = clamp01(throttle);
    dst.brake = clamp01(brake);
    dst.steer = clamp(steer, -1, 1);
    dst.drift = !!src.drift;
    dst.useItem = !!src.useItem;
    dst.lookBack = !!src.lookBack;
  }

  _syncWorld() {
    this._world.raceState = this.state;
    this._world.elapsed = this.elapsed;
    this._world.countdown = this.state === RACE_STATE.COUNTDOWN ? this.countdown : 0;
    this._world.rubberBandTargetProgress = this._getRubberBandTargetProgress();
  }

  _updateDrivers(dt) {
    this._syncWorld();
    for (let i = 0; i < this._drivers.length; i++) {
      if (this._controllerKinds[i] !== CONTROLLER_KIND.HUMAN) {
        this._drivers[i].update(dt, this._world);
      }
    }
  }

  /** Online pacing reference: median progress of currently human-controlled seats. */
  _getRubberBandTargetProgress() {
    const progress = this._humanProgressScratch;
    progress.length = 0;
    for (let i = 0; i < this._karts.length; i++) {
      if (this._controllerKinds[i] === CONTROLLER_KIND.HUMAN) {
        progress.push(this._karts[i].progress);
      }
    }
    if (progress.length === 0) return null;
    progress.sort((a, b) => a - b);
    const mid = progress.length >> 1;
    return progress.length % 2 === 1
      ? progress[mid]
      : (progress[mid - 1] + progress[mid]) * 0.5;
  }

  _updateLapsAndProgress(dt) {
    const length = this.track.length;
    const teleportGuard = length * LAP_TELEPORT_GUARD_FRAC;
    const decay = Math.exp(-dt / WRONG_WAY_WINDOW);
    const finishers = this._finishersThisStep;
    finishers.length = 0;

    for (const kart of this._karts) {
      const delta = loopDelta(kart._lastS, kart.s, length);
      kart._lastS = kart.s;
      if (Math.abs(delta) >= teleportGuard) continue;

      kart._traveled += delta;
      kart.progress = kart._traveled;

      if (!kart.finished) {
        kart._wwDist = kart._wwDist * decay + delta;
        kart.wrongWay = kart._wwDist < WRONG_WAY_TRIGGER
          && Math.abs(kart.speed) > WRONG_WAY_MIN_SPEED;
      }

      const lapsDone = Math.floor(kart._traveled / length);
      kart.lap = clamp(lapsDone + 1, 1, this.laps);
      if (kart.finished) continue;

      if (lapsDone > kart._lapsCounted) {
        kart._lapsCounted = lapsDone;
        const lapTime = this.elapsed - kart.currentLapStart;
        kart.lapTimes.push(lapTime);
        if (lapTime < kart.bestLap) kart.bestLap = lapTime;
        kart.currentLapStart = this.elapsed;
        if (lapsDone < this.laps) {
          kart.emit('lap', { lap: lapsDone + 1, isFinal: lapsDone + 1 === this.laps });
        }
      }

      if (kart._traveled >= this.laps * length) finishers.push(kart);
    }

    if (finishers.length > 1) {
      finishers.sort((a, b) => (b._traveled - a._traveled) || (a.index - b.index));
    }
    for (const kart of finishers) this._finishKart(kart, false);
  }

  _finishKart(kart, autoPlaced) {
    kart.finished = true;
    kart.finishTime = this.elapsed;
    kart.wrongWay = false;
    kart.cancelDrift();
    kart.boostTimer = 0;
    kart.boostPower = 1;
    kart.boostSource = '';
    kart.speedMul = 1;
    resetControls(kart.controls);
    kart._finishIndex = this._finishOrder.length;
    this._finishOrder.push(kart);
    kart.rank = kart._finishIndex + 1;
    kart.emit('finish', { rank: kart.rank, time: kart.finishTime, autoPlaced });
    if (this._firstFinishTime === null) this._firstFinishTime = this.elapsed;
  }

  _updateStateMachine() {
    if (this.state === RACE_STATE.RESULTS) return;

    if (this._finishOrder.length === this._karts.length) {
      this.state = RACE_STATE.RESULTS;
      return;
    }

    if (this._firstFinishTime !== null
      && this.elapsed - this._firstFinishTime >= RACE.postRaceTimeout) {
      this._autoPlaceRemaining();
      this.state = RACE_STATE.RESULTS;
    }
  }

  _autoPlaceRemaining() {
    const remaining = this._karts
      .filter((kart) => !kart.finished)
      .sort((a, b) => (b.progress - a.progress) || (a.index - b.index));
    for (const kart of remaining) this._finishKart(kart, true);
  }

  _updateRanks() {
    this._standings.sort(compareStandings);
    for (let i = 0; i < this._standings.length; i++) {
      if (!this._standings[i].finished) this._standings[i].rank = i + 1;
    }
  }
}
