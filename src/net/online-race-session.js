// Client-side view of an authoritative online race.
//
// The server owns gameplay. This session mirrors snapshots into Kart-shaped
// objects so existing rendering/HUD/audio can stay unchanged. The local kart
// gets lightweight movement prediction; collisions, items, ranks, and events
// always come from the server.

import { FIXED_DT, KART_STATE, RACE, RACE_STATE, SURFACE } from '../core/constants.js';
import { angleDelta, clamp, lerp, loopDelta } from '../core/mathx.js';
import { getCharacter } from '../game/characters.js';
import { Kart, makeControls } from '../game/kart.js';
import { stepKartPhysics } from '../game/physics.js';

const INPUT_DT = 1 / 60;
const REMOTE_BLEND_TIME = 0.1;
const CORRECTION_TIME = 0.1;
const SNAP_DISTANCE = 4;
const MAX_INPUT_HISTORY = 240;
// At 60 Hz this is 250 ms without an authoritative acknowledgement. Keeping
// the window this small prevents a stalled LAN socket from later flushing a
// burst large enough to trip the server's 90-message-per-second limit.
export const MAX_UNACKED_INPUTS = 15;

const KART_FIELDS = [
  'x', 'y', 'z', 'yaw', 'vx', 'vy', 'vz', 'speed', 'airborne',
  'visualYawOffset', 'visualRoll', 'visualPitch', 'visualScale', 'wheelSpin',
  'steerAngle',
  'drifting', 'driftDirection', 'driftCharge', 'driftTier', 'hopTimer',
  'boostTimer', 'boostPower', 'boostSource', 'speedMul', 'draftCharge',
  'state', 'stateTimer', 'aiSpeedMul', 'startPenaltyTimer',
  'invulnTimer', 'starTimer', 'shrinkTimer', 'spinDirection',
  'item', 'itemUses', 'rouletteTimer', 'rouletteFace', 'pendingItem', 'heldCount',
  's', 'lateral', 'surface', 'offTrackDepth', 'progress', 'lap', 'rank',
  'finished', 'finishTime', 'currentLapStart', 'bestLap', 'wrongWay',
  'prevX', 'prevZ',
];

const PREDICTED_FIELDS = [
  'x', 'y', 'z', 'yaw', 'vx', 'vy', 'vz', 'speed', 'airborne',
  'visualYawOffset', 'visualRoll', 'visualPitch', 'visualScale', 'wheelSpin',
  'steerAngle',
  'drifting', 'driftDirection', 'driftCharge', 'driftTier', 'hopTimer',
  'boostTimer', 'boostPower', 'boostSource', 'speedMul', 'draftCharge',
  's', 'lateral', 'surface', 'offTrackDepth', 'prevX', 'prevZ',
];

const MOTION_FIELDS = new Set([
  'x', 'y', 'z', 'yaw', 'vx', 'vy', 'vz', 'speed',
  'visualYawOffset', 'visualRoll', 'visualPitch', 'visualScale',
]);

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function copyControls(dst, src) {
  dst.throttle = clamp(finite(src?.throttle, 0), 0, 1);
  dst.brake = clamp(finite(src?.brake, 0), 0, 1);
  dst.steer = clamp(finite(src?.steer, 0), -1, 1);
  dst.drift = !!src?.drift;
  dst.useItem = !!src?.useItem;
  dst.lookBack = !!src?.lookBack;
  return dst;
}

function cloneControls(src) {
  return copyControls(makeControls(), src);
}

function copyKartFields(kart, snapshot, { motion = true } = {}) {
  for (const field of KART_FIELDS) {
    if (!motion && MOTION_FIELDS.has(field)) continue;
    if (snapshot[field] !== undefined) kart[field] = snapshot[field];
  }
  if (Array.isArray(snapshot.lapTimes)) kart.lapTimes = snapshot.lapTimes.slice();
  if (snapshot.controls) copyControls(kart.controls, snapshot.controls);
  if (snapshot.displayName != null) kart.name = String(snapshot.displayName);
  if (snapshot.participantId !== undefined) kart.participantId = snapshot.participantId;
  if (snapshot.controllerKind !== undefined) kart.controllerKind = snapshot.controllerKind;
  if (snapshot.connected !== undefined) kart.connected = !!snapshot.connected;
}

function copyPredictedFields(dst, src) {
  for (const field of PREDICTED_FIELDS) dst[field] = src[field];
  copyControls(dst.controls, src.controls);
}

function motionState(source) {
  return {
    x: source.x, y: source.y, z: source.z, yaw: source.yaw,
    vx: source.vx, vy: source.vy, vz: source.vz, speed: source.speed,
    visualYawOffset: source.visualYawOffset,
    visualRoll: source.visualRoll,
    visualPitch: source.visualPitch,
    visualScale: source.visualScale,
  };
}

function applyMotion(kart, from, to, t) {
  kart.x = lerp(from.x, to.x, t);
  kart.y = lerp(from.y, to.y, t);
  kart.z = lerp(from.z, to.z, t);
  kart.yaw = from.yaw + angleDelta(from.yaw, to.yaw) * t;
  kart.vx = lerp(from.vx, to.vx, t);
  kart.vy = lerp(from.vy, to.vy, t);
  kart.vz = lerp(from.vz, to.vz, t);
  kart.speed = lerp(from.speed, to.speed, t);
  kart.visualYawOffset = lerp(from.visualYawOffset, to.visualYawOffset, t);
  kart.visualRoll = lerp(from.visualRoll, to.visualRoll, t);
  kart.visualPitch = lerp(from.visualPitch, to.visualPitch, t);
  kart.visualScale = lerp(from.visualScale, to.visualScale, t);
}

function syncEntities(target, snapshots) {
  const existing = new Map(target.map((entity) => [entity.id, entity]));
  const next = [];
  for (const snapshot of snapshots || []) {
    let entity = existing.get(snapshot.id);
    if (!entity) entity = {};
    Object.assign(entity, snapshot);
    next.push(entity);
  }
  target.length = 0;
  target.push(...next);
}

class OnlineItemView {
  constructor() {
    this._projectiles = [];
    this._hazards = [];
    this._vfx = [];
  }

  get projectiles() { return this._projectiles; }
  get hazards() { return this._hazards; }

  applySnapshot(snapshot) {
    syncEntities(this._projectiles, snapshot.projectiles);
    syncEntities(this._hazards, snapshot.hazards);
  }

  pushVfx(events) {
    if (Array.isArray(events)) this._vfx.push(...events);
  }

  drainVfx() {
    if (this._vfx.length === 0) return [];
    return this._vfx.splice(0, this._vfx.length);
  }
}

export class OnlineRaceSession {
  constructor({ client, track, raceId, roster, localParticipantId }) {
    this.kind = 'online';
    this.client = client;
    this.track = track;
    this.raceId = raceId;
    this.localParticipantId = localParticipantId;

    this.state = RACE_STATE.COUNTDOWN;
    this.countdown = RACE.countdownDuration;
    this.elapsed = 0;
    this.laps = track.laps;
    this.tick = 0;
    this.lastAck = -1;
    this._hasSnapshot = false;

    this._karts = [];
    this._byIndex = new Map();
    this._remoteMotion = new Map();
    this._items = new OnlineItemView();
    this._lastEventId = -1;
    this._seenEventIds = new Set();
    this._eventIdOrder = [];
    this._inputSeq = 0;
    this._useItemSeq = 0;
    this._receivedUseItemSeq = 0;
    this._prevUseItem = false;
    this._sendAccumulator = 0;
    this._inputHistory = [];
    this._unacknowledgedInputSeqs = [];
    this._correction = { x: 0, y: 0, z: 0, yaw: 0 };
    this._unsubscribers = [];

    for (const entry of [...roster].sort((a, b) => a.kartIndex - b.kartIndex)) {
      const index = entry.kartIndex;
      const character = getCharacter(entry.characterId);
      const isLocal = entry.participantId === localParticipantId;
      const kart = new Kart({ index, character, isPlayer: isLocal });
      kart.participantId = entry.participantId ?? null;
      kart.controllerKind = entry.controllerKind || (entry.isAi ? 'ai' : 'human');
      kart.connected = entry.connected !== false;
      kart.name = entry.displayName || character.name;
      this._karts.push(kart);
      this._byIndex.set(index, kart);
      if (isLocal) this._player = kart;
    }
    if (!this._player) throw new Error('Online roster does not contain the local participant');

    // The authoritative simulation is created only after every connected
    // client reports that its scene is ready. Place the mirrored karts on the
    // announced grid immediately so the loading wait never renders all racers
    // stacked at the world origin.
    const gridSlot = { x: 0, y: 0, z: 0, heading: 0, s: 0 };
    for (const kart of this._karts) {
      track.gridSlot(
        kart.index,
        this._karts.length,
        RACE.gridRowSpacing,
        RACE.gridColumnOffset,
        gridSlot,
      );
      kart.resetTo(gridSlot.x, gridSlot.y, gridSlot.z, gridSlot.heading);
      kart.s = gridSlot.s;
      kart._lastS = gridSlot.s;
      kart.lateral = (kart.index % 2 === 0 ? -1 : 1) * RACE.gridColumnOffset;
      kart.surface = SURFACE.ROAD;
      kart.offTrackDepth = 0;
      kart.progress = loopDelta(0, gridSlot.s, track.length);
      kart.lap = 1;
      kart.rank = kart.index + 1;
    }

    this._predictedKart = new Kart({
      index: this._player.index,
      character: this._player.character,
      isPlayer: true,
    });
    this._predictionReady = false;

    if (client?.on) {
      this._unsubscribers.push(
        client.on('connection', ({ state } = {}) => {
          if (state === 'disconnected') this.prepareForReconnect();
        }),
        client.on('snapshot', (message) => this.applySnapshot(message)),
        client.on('race_events', (message) => this.applyEvents(message)),
        client.on('race_results', (message) => this.applyResults(message)),
      );
    }
  }

  get karts() { return this._karts; }
  get player() { return this._player; }
  get items() { return this._items; }
  get hasSnapshot() { return this._hasSnapshot; }
  get standings() {
    return this._karts.slice().sort((a, b) => (a.rank - b.rank) || (a.index - b.index));
  }
  get isRaceOver() { return this.state === RACE_STATE.RESULTS; }

  update(dt, controls) {
    copyControls(this._player.controls, controls);
    const acceptsInput = this._hasSnapshot
      && !this._player.finished
      && (this.state === RACE_STATE.COUNTDOWN || this.state === RACE_STATE.RACING);
    if (acceptsInput && controls?.useItem && !this._prevUseItem) this._useItemSeq++;
    this._prevUseItem = !!controls?.useItem;

    if (acceptsInput) {
      this._sendAccumulator += dt;
      while (this._sendAccumulator >= INPUT_DT) {
        this._sendAccumulator -= INPUT_DT;
        this._sendInput(controls);
      }
    }

    if (this._hasSnapshot
      && this.state === RACE_STATE.RACING
      && this._predictionReady
      && !this._player.finished) {
      copyControls(this._predictedKart.controls, controls);
      stepKartPhysics(this._predictedKart, this.track, dt);
      this._predictedKart.clearEvents();
      this._updateLocalDisplay(dt);
    }
    this._updateRemoteKarts(dt);
  }

  /** Immediately relinquish held controls without advancing prediction. */
  sendNeutralInput() {
    const controls = makeControls();
    copyControls(this._player.controls, controls);
    this._prevUseItem = false;
    if (!this._hasSnapshot
      || (this.state !== RACE_STATE.COUNTDOWN && this.state !== RACE_STATE.RACING)) {
      return false;
    }
    this._sendAccumulator = 0;
    return this._sendInput(controls);
  }

  /** Freeze prediction until the server supplies a fresh catch-up snapshot. */
  prepareForReconnect() {
    this._hasSnapshot = false;
    this._predictionReady = false;
    this._sendAccumulator = 0;
    this._inputHistory.length = 0;
    this._unacknowledgedInputSeqs.length = 0;
    this._useItemSeq = this._receivedUseItemSeq;
    this._remoteMotion.clear();
    this._correction.x = 0;
    this._correction.y = 0;
    this._correction.z = 0;
    this._correction.yaw = 0;
    return true;
  }

  applySnapshot(snapshot) {
    if (!snapshot || snapshot.raceId !== this.raceId) return false;
    this._hasSnapshot = true;
    this.tick = finite(snapshot.tick, this.tick);
    this.state = snapshot.state || snapshot.raceState || this.state;
    this.countdown = Math.max(0, finite(snapshot.countdown, this.countdown));
    this.elapsed = Math.max(0, finite(snapshot.elapsed, this.elapsed));
    this.laps = Math.max(1, snapshot.laps | 0 || this.laps);

    const ack = Number.isInteger(snapshot.ack)
      ? snapshot.ack
      : Number.isInteger(snapshot.inputAck) ? snapshot.inputAck : this.lastAck;
    if (Number.isInteger(ack)) this.lastAck = Math.max(this.lastAck, ack);

    const receivedInputSeq = Number.isInteger(snapshot.receivedInputSeq)
      ? snapshot.receivedInputSeq
      : this.lastAck;
    if (Number.isInteger(receivedInputSeq)) {
      this._inputSeq = Math.max(this._inputSeq, receivedInputSeq);
      this._unacknowledgedInputSeqs = this._unacknowledgedInputSeqs
        .filter((seq) => seq > receivedInputSeq);
    }
    if (Number.isInteger(snapshot.receivedUseItemSeq)) {
      this._receivedUseItemSeq = Math.max(
        this._receivedUseItemSeq,
        snapshot.receivedUseItemSeq,
      );
      this._useItemSeq = Math.max(this._useItemSeq, this._receivedUseItemSeq);
    }
    this._inputHistory = this._inputHistory.filter((command) => command.seq > this.lastAck);

    for (const kartSnapshot of snapshot.karts || []) {
      const kart = this._byIndex.get(kartSnapshot.index);
      if (!kart) continue;
      if (kart === this._player) this._applyLocalSnapshot(kartSnapshot);
      else this._applyRemoteSnapshot(kart, kartSnapshot);
    }

    this._items.applySnapshot(snapshot);
    this._applyItemBoxes(snapshot.itemBoxes);
    return true;
  }

  applyEvents(message) {
    if (!message || message.raceId !== this.raceId) return false;
    for (const event of message.events || []) {
      const eventId = Number.isInteger(event.eventId) ? event.eventId : this._lastEventId + 1;
      if (!this._acceptEventId(eventId)) continue;
      const kart = this._byIndex.get(event.kartIndex);
      if (!kart) continue;
      const payload = event.data && typeof event.data === 'object'
        ? { type: event.type, ...event.data }
        : Object.fromEntries(
          Object.entries(event).filter(([key]) => !['eventId', 'kartIndex'].includes(key)),
        );
      kart.events.push(payload);
    }
    const vfx = [];
    for (const event of message.vfx || []) {
      const eventId = Number.isInteger(event.eventId) ? event.eventId : this._lastEventId + 1;
      if (!this._acceptEventId(eventId)) continue;
      const { eventId: _eventId, ...payload } = event;
      vfx.push(payload);
    }
    this._items.pushVfx(vfx);
    return true;
  }

  applyResults(message) {
    if (!message || message.raceId !== this.raceId) return false;
    this.state = RACE_STATE.RESULTS;
    for (const result of message.standings || message.results || []) {
      const kart = this._byIndex.get(result.index ?? result.kartIndex);
      if (!kart) continue;
      if (result.rank != null) kart.rank = result.rank;
      if (result.finishTime != null) kart.finishTime = result.finishTime;
      if (result.bestLap != null) kart.bestLap = result.bestLap;
      if (Array.isArray(result.lapTimes)) kart.lapTimes = result.lapTimes.slice();
      kart.finished = result.finished !== false;
    }
    return true;
  }

  dispose() {
    for (const unsubscribe of this._unsubscribers) unsubscribe?.();
    this._unsubscribers.length = 0;
  }

  _sendInput(controls) {
    if (this._unacknowledgedInputSeqs.length >= MAX_UNACKED_INPUTS) {
      this.prepareForReconnect();
      return false;
    }

    const command = {
      seq: this._inputSeq + 1,
      useItemSeq: this._useItemSeq,
      throttle: clamp(finite(controls?.throttle, 0), 0, 1),
      brake: clamp(finite(controls?.brake, 0), 0, 1),
      steer: clamp(finite(controls?.steer, 0), -1, 1),
      drift: !!controls?.drift,
      lookBack: !!controls?.lookBack,
    };
    const sent = this.client?.sendInput?.(command);
    if (sent === false) {
      this.prepareForReconnect();
      return false;
    }
    this._inputSeq = command.seq;
    this._unacknowledgedInputSeqs.push(command.seq);
    if (this.state === RACE_STATE.RACING && !this._player.finished) {
      this._inputHistory.push({ ...command, controls: cloneControls(controls) });
      if (this._inputHistory.length > MAX_INPUT_HISTORY) this._inputHistory.shift();
    }
    return true;
  }

  _applyLocalSnapshot(snapshot) {
    const display = this._player;
    if (snapshot.finished) {
      const justFinished = !display.finished;
      if (justFinished) {
        this._inputHistory.length = 0;
        this._sendAccumulator = 0;
        this._prevUseItem = false;
        this._correction.x = 0;
        this._correction.y = 0;
        this._correction.z = 0;
        this._correction.yaw = 0;
        this._predictionReady = false;
      }
      this._applyRemoteSnapshot(display, snapshot, { blendFirstSnapshot: true });
      copyKartFields(this._predictedKart, snapshot);
      return;
    }
    const wasPredictionReady = this._predictionReady;
    const before = { x: display.x, y: display.y, z: display.z, yaw: display.yaw, state: display.state };
    copyKartFields(display, snapshot);
    copyKartFields(this._predictedKart, snapshot);
    this._predictionReady = true;

    if (this.state === RACE_STATE.RACING && !snapshot.finished) {
      for (const command of this._inputHistory) {
        copyControls(this._predictedKart.controls, command.controls);
        stepKartPhysics(this._predictedKart, this.track, FIXED_DT);
        stepKartPhysics(this._predictedKart, this.track, FIXED_DT);
        this._predictedKart.clearEvents();
      }
    }

    const dx = before.x - this._predictedKart.x;
    const dy = before.y - this._predictedKart.y;
    const dz = before.z - this._predictedKart.z;
    const distance = Math.hypot(dx, dy, dz);
    const stateChanged = before.state !== snapshot.state;
    const mustSnap = distance > SNAP_DISTANCE
      || stateChanged
      || snapshot.state === KART_STATE.RESPAWNING
      || !wasPredictionReady
      || !Number.isFinite(before.x);

    this._correction.x = mustSnap ? 0 : dx;
    this._correction.y = mustSnap ? 0 : dy;
    this._correction.z = mustSnap ? 0 : dz;
    this._correction.yaw = mustSnap ? 0 : angleDelta(this._predictedKart.yaw, before.yaw);
    this._updateLocalDisplay(0);
  }

  _applyRemoteSnapshot(kart, snapshot, { blendFirstSnapshot = false } = {}) {
    const current = motionState(kart);
    copyKartFields(kart, snapshot, { motion: false });
    const target = {
      ...current,
      x: finite(snapshot.x, current.x),
      y: finite(snapshot.y, current.y),
      z: finite(snapshot.z, current.z),
      yaw: finite(snapshot.yaw, current.yaw),
      vx: finite(snapshot.vx, current.vx),
      vy: finite(snapshot.vy, current.vy),
      vz: finite(snapshot.vz, current.vz),
      speed: finite(snapshot.speed, current.speed),
      visualYawOffset: finite(snapshot.visualYawOffset, current.visualYawOffset),
      visualRoll: finite(snapshot.visualRoll, current.visualRoll),
      visualPitch: finite(snapshot.visualPitch, current.visualPitch),
      visualScale: finite(snapshot.visualScale, current.visualScale),
    };
    const distance = Math.hypot(target.x - current.x, target.y - current.y, target.z - current.z);
    if ((!blendFirstSnapshot && !this._remoteMotion.has(kart.index))
      || distance > SNAP_DISTANCE
      || snapshot.state === KART_STATE.RESPAWNING) {
      applyMotion(kart, target, target, 1);
      this._remoteMotion.set(kart.index, { from: target, to: target, elapsed: REMOTE_BLEND_TIME });
      return;
    }
    this._remoteMotion.set(kart.index, { from: current, to: target, elapsed: 0 });
  }

  _updateLocalDisplay(dt) {
    const decay = dt > 0 ? Math.exp(-dt / CORRECTION_TIME) : 1;
    this._correction.x *= decay;
    this._correction.y *= decay;
    this._correction.z *= decay;
    this._correction.yaw *= decay;
    copyPredictedFields(this._player, this._predictedKart);
    this._player.x += this._correction.x;
    this._player.y += this._correction.y;
    this._player.z += this._correction.z;
    this._player.yaw += this._correction.yaw;
  }

  _updateRemoteKarts(dt) {
    for (const [index, blend] of this._remoteMotion) {
      const kart = this._byIndex.get(index);
      if (!kart) continue;
      blend.elapsed = Math.min(REMOTE_BLEND_TIME, blend.elapsed + dt);
      applyMotion(kart, blend.from, blend.to, blend.elapsed / REMOTE_BLEND_TIME);
    }
  }

  _applyItemBoxes(snapshots) {
    if (!Array.isArray(snapshots)) return;
    const byId = new Map(this.track.itemBoxes.map((box) => [box.id, box]));
    for (const snapshot of snapshots) {
      const box = byId.get(snapshot.id);
      if (!box) continue;
      if (snapshot.active !== undefined) box.active = !!snapshot.active;
      if (snapshot.respawnAt !== undefined) box.respawnAt = snapshot.respawnAt;
    }
  }

  _acceptEventId(eventId) {
    if (this._seenEventIds.has(eventId)) return false;
    this._seenEventIds.add(eventId);
    this._eventIdOrder.push(eventId);
    if (eventId > this._lastEventId) this._lastEventId = eventId;
    if (this._eventIdOrder.length > 1024) {
      this._seenEventIds.delete(this._eventIdOrder.shift());
    }
    return true;
  }
}
