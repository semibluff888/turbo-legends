// RaceDirector: the conductor of one race.
//
// Owns kart creation, the countdown (rocket/jump starts), the per-step
// pipeline (input → AI → items → physics → collisions → drafting → laps →
// rank), lap counting, finishing, and the race state machine. Pure simulation:
// no THREE, no DOM — a whole race runs headlessly under Node.
//
// Lap counting model (see ARCHITECTURE.md pin): signed arc-length deltas are
// accumulated into a per-kart `_traveled` float. The grid sits behind the
// start line, so `_traveled` begins slightly negative and the first crossing
// of the line brings it to 0 (start of lap 1). Lap N completes when
// `_traveled` passes N * track.length; a monotonic high-water mark
// (`_lapsCounted`) makes back-and-forth over the line safe by construction.

import { RACE, RACE_STATE, DIFFICULTY, SURFACE } from '../core/constants.js';
import { clamp, clamp01, loopDelta, angleDelta } from '../core/mathx.js';
import { Rng } from '../core/rng.js';
import { Kart, resetControls } from './kart.js';
import { CHARACTERS, getCharacter } from './characters.js';
import { stepKartPhysics, resolveKartCollisions, updateDrafting } from './physics.js';
import { AiDriver } from './ai.js';
import { ItemSystem } from './items.js';

// Local tuning that has no home in constants.js (director-internal).
const START_PRESS_THRESHOLD = 0.5;  // throttle level that counts as "held" pre-GO
const LAP_TELEPORT_GUARD_FRAC = 0.25; // |s delta| ≥ length/4 in one step = teleport, ignore
const WRONG_WAY_WINDOW = 1.5;       // seconds of history in the decaying accumulator
const WRONG_WAY_TRIGGER = -2.5;     // net meters backwards before the flag trips
const WRONG_WAY_MIN_SPEED = 3.0;
const CRUISE_THROTTLE = 0.5;        // post-finish fallback cruise (human player)
const CRUISE_LOOKAHEAD_MIN = 6.0;
const CRUISE_LOOKAHEAD_SPEED = 0.55;
const CRUISE_STEER_GAIN = 2.0;

/**
 * Standings comparator: finished karts first in finish order, then everyone
 * else by monotonic progress. Kart index tiebreak keeps the sort stable and
 * therefore deterministic.
 */
function compareStandings(a, b) {
  if (a.finished || b.finished) {
    if (a.finished && b.finished) return a._finishIndex - b._finishIndex;
    return a.finished ? -1 : 1;
  }
  if (b.progress !== a.progress) return b.progress - a.progress;
  return a.index - b.index;
}

export class RaceDirector {
  /**
   * @param {import('../track/track.js').Track} track
   * @param {object} [opts]
   * @param {string} [opts.playerCharacterId]
   * @param {string|object} [opts.difficulty] DIFFICULTY key ('easy'|'normal'|'hard') or preset object
   * @param {number} [opts.laps] defaults to the track's lap count
   * @param {number} [opts.seed]
   * @param {boolean} [opts.autopilot] give the player kart an AiDriver too (headless tests)
   */
  constructor(track, {
    playerCharacterId,
    difficulty = 'normal',
    laps = track.laps,
    seed = 12345,
    autopilot = false,
  } = {}) {
    this.track = track;
    this.laps = laps;
    this.seed = seed;
    this.autopilot = autopilot;

    if (typeof difficulty === 'string') {
      this.difficultyKey = DIFFICULTY[difficulty] ? difficulty : 'normal';
      this.difficulty = DIFFICULTY[this.difficultyKey];
    } else {
      this.difficultyKey = 'custom';
      this.difficulty = difficulty || DIFFICULTY.normal;
    }

    this.rng = new Rng(seed);

    // --- Roster: player + 7 distinct AI characters --------------------------
    this._playerCharacter = getCharacter(playerCharacterId);
    const aiChars = this._drawAiCharacters();

    // Player takes the BACK grid slot (classic: you start last).
    this._karts = [];
    for (let i = 0; i < RACE.totalKarts - 1; i++) {
      this._karts.push(new Kart({ index: i, character: aiChars[i], isPlayer: false }));
    }
    this._player = new Kart({
      index: RACE.totalKarts - 1,
      character: this._playerCharacter,
      isPlayer: true,
    });
    this._karts.push(this._player);

    this._drivers = new Array(this._karts.length).fill(null);
    this._createDrivers();

    this._items = new ItemSystem(track, this.rng);

    // --- Race state ----------------------------------------------------------
    this.state = RACE_STATE.COUNTDOWN;
    this.countdown = RACE.countdownDuration;
    this.elapsed = 0;

    this._finishOrder = [];
    this._firstFinishTime = null;
    /** countdown value at which each kart's current throttle hold began (null = not held). */
    this._startPress = new Array(this._karts.length).fill(null);
    this._standings = this._karts.slice();

    // Scratch objects — zero allocation per step.
    this._world = {
      karts: this._karts,
      items: this._items,
      raceState: RACE_STATE.COUNTDOWN,
      elapsed: 0,
      countdown: RACE.countdownDuration,
    };
    this._gridScratch = { x: 0, y: 0, z: 0, heading: 0, s: 0 };
    this._pt = { x: 0, y: 0, z: 0, heading: 0 };
    this._finishersThisStep = [];

    this._placeGrid();
  }

  // ---------------------------------------------------------------------------
  // Contract getters
  // ---------------------------------------------------------------------------

  get karts() { return this._karts; }
  get player() { return this._player; }
  get items() { return this._items; }
  /** Karts sorted by current rank (finished first, then by progress). */
  get standings() { return this._standings; }
  get isRaceOver() { return this.state === RACE_STATE.RESULTS; }

  // ---------------------------------------------------------------------------
  // Setup / reset
  // ---------------------------------------------------------------------------

  /** Shuffle the non-player roster and take 7. Consumes rng draws. */
  _drawAiCharacters() {
    const pool = CHARACTERS.filter((c) => c.id !== this._playerCharacter.id);
    this.rng.shuffle(pool);
    return pool.slice(0, RACE.totalKarts - 1);
  }

  /**
   * Every AI kart gets a driver; the player only under autopilot. Drivers are
   * created in kart order so the rng stream is reproducible.
   */
  _createDrivers() {
    for (let i = 0; i < this._karts.length; i++) {
      const kart = this._karts[i];
      if (kart.isPlayer && !this.autopilot) {
        this._drivers[i] = null;
        continue;
      }
      this._drivers[i] = new AiDriver(kart, this.track, this.rng, this.difficulty, this.rng.float());
    }
  }

  /** Put every kart on its grid slot and zero all per-race bookkeeping. */
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
      // Grid is behind the line: small negative arc distance back to s = 0.
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

  /**
   * Restart the exact same race: same seed, same roster, same AI
   * personalities. rng.reset() + redoing the construction-time draws in the
   * same order realigns the random stream, so a reset race replays
   * identically given identical inputs.
   */
  reset() {
    this.rng.reset();
    this._drawAiCharacters(); // consume the same draws as construction
    this._createDrivers();    // fresh driver state, identical personalities
    this._placeGrid();
    this._items.reset();
    this._finishOrder.length = 0;
    this._firstFinishTime = null;
    this.state = RACE_STATE.COUNTDOWN;
    this.countdown = RACE.countdownDuration;
    this.elapsed = 0;
  }

  // ---------------------------------------------------------------------------
  // Per-step pipeline
  // ---------------------------------------------------------------------------

  /**
   * One fixed simulation step.
   * @param {number} dt
   * @param {object|null} playerControls makeControls() shape from the input layer
   */
  update(dt, playerControls = null) {
    if (this.state === RACE_STATE.COUNTDOWN) {
      this._updateCountdown(dt, playerControls);
      return;
    }

    this.elapsed += dt;

    this._updatePlayerControls(playerControls);
    this._updateDrivers(dt);
    this._items.update(dt, this._karts, this.elapsed);

    for (const kart of this._karts) stepKartPhysics(kart, this.track, dt);
    resolveKartCollisions(this._karts, dt);
    updateDrafting(this._karts, dt);

    this._updateLapsAndProgress(dt);
    this._updateStateMachine();
    this._updateRanks();
  }

  // ---------------------------------------------------------------------------
  // Countdown
  // ---------------------------------------------------------------------------

  _updateCountdown(dt, playerControls) {
    this.countdown -= dt;

    // Human player controls are observed (for start timing) but karts stay
    // frozen — physics is simply not stepped until GO.
    if (!this._drivers[this._player.index]) {
      this._copyControls(this._player.controls, playerControls);
    }

    const world = this._world;
    world.raceState = RACE_STATE.COUNTDOWN;
    world.elapsed = 0;
    world.countdown = this.countdown;
    for (const driver of this._drivers) if (driver) driver.update(dt, world);

    // Record when each kart's current throttle hold began (countdown value).
    for (let i = 0; i < this._karts.length; i++) {
      const held = this._karts[i].controls.throttle > START_PRESS_THRESHOLD;
      if (!held) this._startPress[i] = null;
      else if (this._startPress[i] === null) this._startPress[i] = this.countdown;
    }

    if (this.countdown > 0) return;

    // --- GO ------------------------------------------------------------------
    this.countdown = 0;
    const [early, late] = RACE.rocketStartWindow;
    for (let i = 0; i < this._karts.length; i++) {
      const kart = this._karts[i];
      const pressAt = this._startPress[i];
      if (pressAt === null) continue; // not holding at GO — normal start
      if (pressAt > early) {
        // Held too early: wheels spin, throttle locked (physics decrements).
        kart.startPenaltyTimer = RACE.jumpStartPenalty;
        kart.emit('jump_start');
      } else if (pressAt >= late) {
        kart.applyBoost(RACE.rocketStartPower, RACE.rocketStartDuration, 'start');
        kart.emit('rocket_start');
      }
    }
    this.state = RACE_STATE.RACING;
    this.elapsed = 0;
    this._player.emit('go');
  }

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------

  _updatePlayerControls(playerControls) {
    const player = this._player;
    if (this._drivers[player.index]) return; // autopilot AiDriver owns the controls
    if (player.finished) {
      this._cruise(player);
      return;
    }
    this._copyControls(player.controls, playerControls);
  }

  /** Copy the input layer's controls into the kart, sanitized. */
  _copyControls(dst, src) {
    if (!src) {
      resetControls(dst);
      return;
    }
    dst.throttle = clamp01(src.throttle || 0);
    dst.brake = clamp01(src.brake || 0);
    dst.steer = clamp(src.steer || 0, -1, 1);
    dst.drift = !!src.drift;
    dst.useItem = !!src.useItem;
    dst.lookBack = !!src.lookBack;
  }

  /** Post-finish fallback when the player has no AiDriver: gentle centreline cruise. */
  _cruise(kart) {
    const c = kart.controls;
    const look = Math.max(CRUISE_LOOKAHEAD_MIN, kart.speed * CRUISE_LOOKAHEAD_SPEED);
    this.track.toWorld(kart.s + look, 0, this._pt);
    const desired = Math.atan2(this._pt.x - kart.x, this._pt.z - kart.z);
    c.steer = clamp(angleDelta(kart.yaw, desired) * CRUISE_STEER_GAIN, -1, 1);
    c.throttle = CRUISE_THROTTLE;
    c.brake = 0;
    c.drift = false;
    c.useItem = false;
    c.lookBack = false;
  }

  _updateDrivers(dt) {
    const world = this._world;
    world.raceState = this.state;
    world.elapsed = this.elapsed;
    world.countdown = 0;
    for (const driver of this._drivers) if (driver) driver.update(dt, world);
  }

  // ---------------------------------------------------------------------------
  // Laps, progress, wrong-way, finishing
  // ---------------------------------------------------------------------------

  _updateLapsAndProgress(dt) {
    const length = this.track.length;
    const teleportGuard = length * LAP_TELEPORT_GUARD_FRAC;
    const decay = Math.exp(-dt / WRONG_WAY_WINDOW);
    const finishers = this._finishersThisStep;
    finishers.length = 0;

    for (const kart of this._karts) {
      const delta = loopDelta(kart._lastS, kart.s, length);
      kart._lastS = kart.s;
      // A respawn/teleport can snap `s` a long way in one step — never let
      // that count as (or steal) track progress.
      if (Math.abs(delta) >= teleportGuard) continue;

      kart._traveled += delta;
      kart.progress = kart._traveled;

      if (!kart.finished) {
        // Decaying accumulator ≈ net signed meters over the last ~1.5 s.
        kart._wwDist = kart._wwDist * decay + delta;
        kart.wrongWay = kart._wwDist < WRONG_WAY_TRIGGER
          && Math.abs(kart.speed) > WRONG_WAY_MIN_SPEED;
      }

      const lapsDone = Math.floor(kart._traveled / length);
      kart.lap = clamp(lapsDone + 1, 1, this.laps);
      if (kart.finished) continue;

      // High-water mark: a lap only counts the first time its line is crossed
      // forward, so reversing over the line and re-crossing never double-counts.
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

    // Photo finish: karts crossing within the same 1/120 s step are ordered
    // by how far past the line they got, not by array index.
    if (finishers.length > 1) {
      finishers.sort((a, b) => (b._traveled - a._traveled) || (a.index - b.index));
    }
    for (const kart of finishers) this._finishKart(kart, false);
  }

  _finishKart(kart, autoPlaced) {
    kart.finished = true;
    kart.finishTime = this.elapsed;
    kart.wrongWay = false;
    kart._finishIndex = this._finishOrder.length;
    this._finishOrder.push(kart);
    kart.rank = kart._finishIndex + 1; // frozen from here on
    kart.emit('finish', { rank: kart.rank, time: kart.finishTime, autoPlaced });
    if (this._firstFinishTime === null) this._firstFinishTime = this.elapsed;
  }

  // ---------------------------------------------------------------------------
  // State machine + ranking
  // ---------------------------------------------------------------------------

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
      return;
    }

    if (this._player.finished && this.state === RACE_STATE.RACING) {
      this.state = RACE_STATE.FINISHED;
    }
  }

  /** Timeout hit: place everyone still on track by current progress. */
  _autoPlaceRemaining() {
    const remaining = this._karts
      .filter((k) => !k.finished)
      .sort((a, b) => (b.progress - a.progress) || (a.index - b.index));
    for (const kart of remaining) this._finishKart(kart, true);
  }

  _updateRanks() {
    const standings = this._standings;
    standings.sort(compareStandings);
    for (let i = 0; i < standings.length; i++) {
      // Finished karts keep their frozen rank (their sort position equals it).
      if (!standings[i].finished) standings[i].rank = i + 1;
    }
  }
}
