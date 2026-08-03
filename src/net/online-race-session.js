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
import { decodeKartSnapshot } from './protocol.js';

const INPUT_DT = 1 / 60;
const NETWORK_TICK_HZ = 60;
const INTERPOLATION_DELAY_TICKS = 6;
const MAX_EXTRAPOLATION_TICKS = 6;
const MAX_SNAPSHOT_BUFFER = 12;
const MAX_CONTIGUOUS_SNAPSHOT_GAP_TICKS = 12;
const RECOVERY_BLEND_TIME = 0.5;
const ITEM_ACTION_FRESHNESS = 0.25;
const MAX_INPUT_HISTORY = 240;

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

function extrapolateMotion(source, seconds) {
  return {
    ...source,
    x: source.x + source.vx * seconds,
    y: source.y + source.vy * seconds,
    z: source.z + source.vz * seconds,
  };
}

function smoothstep(t) {
  const value = clamp(t, 0, 1);
  return value * value * (3 - 2 * value);
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
  constructor({ client, track, raceId, roster, localParticipantId, roomState = null }) {
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
    this._latestSnapshotTick = null;
    this._estimatedServerTick = null;
    this._hasLocalSnapshot = false;
    this._transportConnected = client?.state === undefined || client.state === 'connected';
    this._loadAcknowledged = Boolean(client?.hasRaceLoadedAck?.(raceId));

    this._karts = [];
    this._byIndex = new Map();
    this._byParticipantId = new Map();
    this._remoteMotion = new Map();
    this._items = new OnlineItemView();
    this._lastEventId = -1;
    this._seenEventIds = new Set();
    this._eventIdOrder = [];
    this._inputSeq = 0;
    this._useItemSeq = 0;
    this._prevUseItem = false;
    this._pendingUseItem = false;
    this._pendingUseItemAge = 0;
    this._sendAccumulator = 0;
    this._pauseKeepaliveAccumulator = 0;
    this._lastFrameControls = makeControls();
    this._inputHistory = [];
    this._correction = { x: 0, y: 0, z: 0, yaw: 0 };
    this._correctionTime = 0.15;
    this._unsubscribers = [];

    for (const entry of [...roster].sort((a, b) => a.kartIndex - b.kartIndex)) {
      const index = entry.kartIndex;
      const character = getCharacter(entry.characterId);
      const isLocal = entry.participantId === localParticipantId;
      const kart = new Kart({
        index,
        character,
        isPlayer: isLocal,
        paintId: entry.paintId ?? null,
        avatarId: entry.avatarId ?? null,
      });
      kart.participantId = entry.participantId ?? null;
      kart.controllerKind = entry.controllerKind || (entry.isAi ? 'ai' : 'human');
      kart.connected = entry.connected !== false;
      kart.presenceState = kart.controllerKind === 'ai'
        ? null
        : (entry.presenceState || (kart.connected ? 'connected' : 'reconnecting'));
      kart.name = entry.displayName || character.name;
      this._karts.push(kart);
      this._byIndex.set(index, kart);
      if (kart.participantId) this._byParticipantId.set(String(kart.participantId), kart);
      if (isLocal) this._player = kart;
    }
    if (!this._player) throw new Error('Online roster does not contain the local participant');

    if (roomState) this.applyRoomState(roomState);

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
      paintId: this._player.paintId,
      avatarId: this._player.avatarId,
    });
    this._predictionReady = false;

    if (client?.on) {
      this._unsubscribers.push(
        client.on('snapshot', (message) => this.applySnapshot(message)),
        client.on('race_loaded_ack', (message) => this.applyRaceLoadedAck(message)),
        client.on('room_state', (message) => this.applyRoomState(message)),
        client.on('race_events', (message) => this.applyEvents(message)),
        client.on('race_results', (message) => this.applyResults(message)),
        client.on('connection', (event) => this._handleConnection(event)),
      );
    }
  }

  get karts() { return this._karts; }
  get player() { return this._player; }
  get items() { return this._items; }
  get hasSnapshot() { return this._hasSnapshot; }
  get loadAcknowledged() { return this._loadAcknowledged; }
  get standings() {
    return this._karts.slice().sort((a, b) => (a.rank - b.rank) || (a.index - b.index));
  }
  get isRaceOver() { return this.state === RACE_STATE.RESULTS; }

  resumeFromPrepare(message) {
    if (!message || message.raceId !== this.raceId) return false;
    this._sendAccumulator = 0;
    return true;
  }

  update(dt, controls) {
    copyControls(this._player.controls, controls);
    if (this._pendingUseItem) {
      this._pendingUseItemAge += Math.max(0, dt);
      if (this._pendingUseItemAge > ITEM_ACTION_FRESHNESS) this._pendingUseItem = false;
    }
    this._sendAccumulator += Math.max(0, dt);

    if (this.state === RACE_STATE.RACING
      && this._transportConnected
      && this._player.controllerKind === 'human'
      && this._predictionReady
      && !this._player.finished) {
      copyControls(this._predictedKart.controls, controls);
      stepKartPhysics(this._predictedKart, this.track, dt);
      this._predictedKart.clearEvents();
      this._updateLocalDisplay(dt);
    }
    this._updateRemoteKarts(dt);
  }

  /** Flush at most one current input packet from the browser render frame. */
  flushInput(controls, { force = false } = {}) {
    const normalized = cloneControls(controls);
    const useItemPressed = normalized.useItem && !this._prevUseItem;
    if (useItemPressed) {
      this._pendingUseItem = true;
      this._pendingUseItemAge = 0;
    }
    const urgent = useItemPressed
      || normalized.drift !== this._lastFrameControls.drift
      || normalized.lookBack !== this._lastFrameControls.lookBack
      || (normalized.throttle === 0) !== (this._lastFrameControls.throttle === 0)
      || (normalized.brake === 0) !== (this._lastFrameControls.brake === 0);
    this._prevUseItem = normalized.useItem;
    copyControls(this._lastFrameControls, normalized);

    if (!this._canSendInput() || (!force && !urgent && this._sendAccumulator < INPUT_DT)) {
      return false;
    }
    // A long render stall still produces only the newest packet, never catch-up traffic.
    this._sendAccumulator = 0;
    return this._sendInput(normalized);
  }

  /** Send one neutral keepalive every 500ms while the online pause menu is open. */
  flushPausedInput(dt) {
    this._sendAccumulator = 0;
    this._pauseKeepaliveAccumulator += Math.max(0, dt);
    if (this._pauseKeepaliveAccumulator < 0.5) return false;
    this._pauseKeepaliveAccumulator = 0;
    return this.sendNeutralInput();
  }

  resumeInput(controls) {
    this._pauseKeepaliveAccumulator = 0;
    return this.flushInput(controls, { force: true });
  }

  /** Immediately relinquish held controls without advancing prediction. */
  sendNeutralInput() {
    const controls = makeControls();
    copyControls(this._player.controls, controls);
    this._prevUseItem = false;
    this._pendingUseItem = false;
    this._pendingUseItemAge = 0;
    copyControls(this._lastFrameControls, controls);
    this._pauseKeepaliveAccumulator = 0;
    if (!this._canSendInput()) return false;
    this._sendAccumulator = 0;
    return this._sendInput(controls);
  }

  applySnapshot(snapshot) {
    if (!snapshot || snapshot.raceId !== this.raceId) return false;
    const suppliedTick = Number(snapshot.tick);
    const hasSuppliedTick = Number.isFinite(suppliedTick);
    if (hasSuppliedTick && this._latestSnapshotTick !== null
      && suppliedTick <= this._latestSnapshotTick) return false;
    const snapshotTick = hasSuppliedTick
      ? suppliedTick
      : (this._latestSnapshotTick ?? this.tick) + 1;
    this._hasSnapshot = true;
    this._latestSnapshotTick = snapshotTick;
    this._estimatedServerTick = this._estimatedServerTick === null
      ? snapshotTick
      : Math.max(this._estimatedServerTick, snapshotTick);
    this.tick = snapshotTick;
    this.state = snapshot.state || snapshot.raceState || this.state;
    this.countdown = Math.max(0, finite(snapshot.countdown, this.countdown));
    this.elapsed = Math.max(0, finite(snapshot.elapsed, this.elapsed));
    this.laps = Math.max(1, snapshot.laps | 0 || this.laps);

    const localAcks = Array.isArray(snapshot.acks)
      ? snapshot.acks.find((entry) => Array.isArray(entry) && entry[0] === this._player.index)
      : null;
    const ack = Number.isInteger(localAcks?.[1]) ? localAcks[1] : this.lastAck;
    if (ack >= 0) this._inputSeq = Math.max(this._inputSeq, ack);
    if (ack > this.lastAck) {
      this.lastAck = ack;
      this._inputHistory = this._inputHistory.filter((command) => command.seq > ack);
    }
    if (Number.isInteger(localAcks?.[2]) && localAcks[2] >= 0) {
      this._useItemSeq = Math.max(this._useItemSeq, localAcks[2]);
    }

    for (const encodedKart of snapshot.karts || []) {
      const kartSnapshot = decodeKartSnapshot(encodedKart);
      if (!kartSnapshot) continue;
      const kart = this._byIndex.get(kartSnapshot.index);
      if (!kart) continue;
      if (kart === this._player) this._applyLocalSnapshot(kartSnapshot, snapshotTick);
      else this._applyRemoteSnapshot(kart, kartSnapshot, { snapshotTick });
    }

    this._items.applySnapshot(snapshot);
    this._applyItemBoxes(snapshot.itemBoxes);
    return true;
  }

  applyRaceLoadedAck(message) {
    if (!message || message.raceId !== this.raceId) return false;
    this._loadAcknowledged = true;
    this._sendAccumulator = 0;
    return true;
  }

  applyRoomState(message) {
    const roomState = message?.room || message;
    if (!roomState || typeof roomState !== 'object') return false;
    if (Object.hasOwn(roomState, 'raceId') && roomState.raceId !== this.raceId) return false;
    const members = roomState.members || roomState.participants || roomState.players;
    if (!Array.isArray(members)) return false;

    let changed = false;
    for (const member of members) {
      const participantId = member?.participantId ?? member?.id;
      const kart = this._byParticipantId.get(String(participantId || ''));
      if (!kart) continue;
      if (member.connected !== undefined) kart.connected = member.connected !== false;
      if (member.controllerKind !== undefined) kart.controllerKind = member.controllerKind;
      kart.presenceState = member.presenceState
        || (kart.connected ? 'connected' : 'reconnecting');
      changed = true;
    }
    return changed;
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
    const pendingUseItem = this._pendingUseItem
      && this._pendingUseItemAge <= ITEM_ACTION_FRESHNESS;
    const command = {
      seq: this._inputSeq + 1,
      useItemSeq: this._useItemSeq + (pendingUseItem ? 1 : 0),
      throttle: clamp(finite(controls?.throttle, 0), 0, 1),
      brake: clamp(finite(controls?.brake, 0), 0, 1),
      steer: clamp(finite(controls?.steer, 0), -1, 1),
      drift: !!controls?.drift,
      lookBack: !!controls?.lookBack,
    };
    const sent = this.client?.sendInput?.(command) !== false;
    if (!sent) return false;
    this._inputSeq = command.seq;
    if (pendingUseItem) {
      this._useItemSeq = command.useItemSeq;
      this._pendingUseItem = false;
      this._pendingUseItemAge = 0;
    }
    if (this.state === RACE_STATE.RACING && !this._player.finished) {
      this._inputHistory.push({ ...command, controls: cloneControls(controls) });
      if (this._inputHistory.length > MAX_INPUT_HISTORY) this._inputHistory.shift();
    }
    return true;
  }

  _canSendInput() {
    return this._hasSnapshot
      && this._loadAcknowledged
      && this._transportConnected
      && !this._player.finished
      && (this.state === RACE_STATE.COUNTDOWN || this.state === RACE_STATE.RACING);
  }

  _applyLocalSnapshot(snapshot, snapshotTick) {
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
      this._applyRemoteSnapshot(display, snapshot, { blendFirstSnapshot: true, snapshotTick });
      copyKartFields(this._predictedKart, snapshot);
      return;
    }
    const controllerKind = snapshot.controllerKind ?? display.controllerKind;
    if (!this._transportConnected || controllerKind !== 'human') {
      this._inputHistory.length = 0;
      this._sendAccumulator = 0;
      this._correction.x = 0;
      this._correction.y = 0;
      this._correction.z = 0;
      this._correction.yaw = 0;
      this._predictionReady = false;
      this._applyRemoteSnapshot(display, snapshot, { blendFirstSnapshot: true, snapshotTick });
      copyKartFields(this._predictedKart, snapshot);
      this._hasLocalSnapshot = true;
      return;
    }

    const wasPredictionReady = this._predictionReady;
    const firstLocalSnapshot = !this._hasLocalSnapshot;
    const before = { x: display.x, y: display.y, z: display.z, yaw: display.yaw, state: display.state };
    copyKartFields(display, snapshot);
    copyKartFields(this._predictedKart, snapshot);
    this._remoteMotion.delete(display.index);
    this._predictionReady = true;
    this._hasLocalSnapshot = true;
    const authoritativeTeleport = snapshot.state === KART_STATE.RESPAWNING;
    if (authoritativeTeleport) this._inputHistory.length = 0;

    if (this.state === RACE_STATE.RACING && !snapshot.finished && !authoritativeTeleport) {
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
    const mustSnap = authoritativeTeleport
      || firstLocalSnapshot
      || !Number.isFinite(before.x);

    this._correction.x = mustSnap ? 0 : dx;
    this._correction.y = mustSnap ? 0 : dy;
    this._correction.z = mustSnap ? 0 : dz;
    this._correction.yaw = mustSnap ? 0 : angleDelta(this._predictedKart.yaw, before.yaw);
    this._correctionTime = distance <= 2 ? 0.15 : distance <= 8 ? 0.3 : 0.5;
    if (!wasPredictionReady && !firstLocalSnapshot && !mustSnap) {
      this._correctionTime = Math.max(this._correctionTime, 0.3);
    }
    this._updateLocalDisplay(0);
  }

  _applyRemoteSnapshot(kart, snapshot, {
    blendFirstSnapshot = false,
    snapshotTick = this.tick,
  } = {}) {
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
    let channel = this._remoteMotion.get(kart.index);
    if (!channel) {
      channel = { samples: [], recovery: null };
      this._remoteMotion.set(kart.index, channel);
    }
    const previous = channel.samples.at(-1);
    const gap = previous ? snapshotTick - previous.tick : null;
    const teleport = snapshot.state === KART_STATE.RESPAWNING;
    if (teleport) {
      applyMotion(kart, target, target, 1);
      channel.samples = [{ tick: snapshotTick, motion: target }];
      channel.recovery = null;
      return;
    }
    if (!previous) {
      channel.samples.push({ tick: snapshotTick, motion: target });
      if (blendFirstSnapshot) {
        channel.recovery = { from: current, elapsed: 0, duration: RECOVERY_BLEND_TIME };
      } else {
        applyMotion(kart, target, target, 1);
      }
      return;
    }
    if (gap > MAX_CONTIGUOUS_SNAPSHOT_GAP_TICKS) {
      channel.samples.length = 0;
      channel.recovery = { from: current, elapsed: 0, duration: RECOVERY_BLEND_TIME };
    }
    channel.samples.push({ tick: snapshotTick, motion: target });
    if (channel.samples.length > MAX_SNAPSHOT_BUFFER) channel.samples.shift();
  }

  _updateLocalDisplay(dt) {
    const decay = dt > 0 ? Math.exp(-dt / this._correctionTime) : 1;
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
    if (this._latestSnapshotTick === null || this._estimatedServerTick === null) return;
    const maxEstimatedTick = this._latestSnapshotTick
      + INTERPOLATION_DELAY_TICKS + MAX_EXTRAPOLATION_TICKS;
    this._estimatedServerTick = Math.min(
      maxEstimatedTick,
      this._estimatedServerTick + Math.max(0, dt) * NETWORK_TICK_HZ,
    );
    const renderTick = this._estimatedServerTick - INTERPOLATION_DELAY_TICKS;
    for (const [index, channel] of this._remoteMotion) {
      const kart = this._byIndex.get(index);
      if (!kart || channel.samples.length === 0) continue;
      const target = this._motionAtTick(channel.samples, renderTick);
      if (channel.recovery) {
        channel.recovery.elapsed = Math.min(
          channel.recovery.duration,
          channel.recovery.elapsed + Math.max(0, dt),
        );
        const t = smoothstep(channel.recovery.elapsed / channel.recovery.duration);
        applyMotion(kart, channel.recovery.from, target, t);
        if (channel.recovery.elapsed >= channel.recovery.duration) channel.recovery = null;
      } else {
        applyMotion(kart, target, target, 1);
      }
      while (channel.samples.length > 2 && channel.samples[1].tick < renderTick) {
        channel.samples.shift();
      }
    }
  }

  _motionAtTick(samples, renderTick) {
    const first = samples[0];
    if (renderTick <= first.tick) return first.motion;
    for (let index = 1; index < samples.length; index++) {
      const next = samples[index];
      if (renderTick > next.tick) continue;
      const previous = samples[index - 1];
      const span = Math.max(1, next.tick - previous.tick);
      const target = { ...previous.motion };
      applyMotion(target, previous.motion, next.motion, (renderTick - previous.tick) / span);
      return target;
    }
    const latest = samples.at(-1);
    const ticks = Math.min(MAX_EXTRAPOLATION_TICKS, Math.max(0, renderTick - latest.tick));
    return extrapolateMotion(latest.motion, ticks / NETWORK_TICK_HZ);
  }

  _handleConnection(event) {
    const connected = event?.state === 'connected';
    if (connected) {
      this._transportConnected = true;
      this._sendAccumulator = 0;
      this._pauseKeepaliveAccumulator = 0;
      return;
    }
    if (event?.state === 'idle') return;
    this._transportConnected = false;
    this._loadAcknowledged = false;
    this._inputHistory.length = 0;
    this._sendAccumulator = 0;
    this._pauseKeepaliveAccumulator = 0;
    this._pendingUseItem = false;
    this._pendingUseItemAge = 0;
    this._prevUseItem = false;
    this._predictionReady = false;
    this._correction.x = 0;
    this._correction.y = 0;
    this._correction.z = 0;
    this._correction.yaw = 0;
  }

  _applyItemBoxes(snapshots) {
    if (!Array.isArray(snapshots)) return;
    for (let index = 0; index < snapshots.length; index++) {
      const snapshot = snapshots[index];
      const box = this.track.itemBoxes[index];
      if (!box) continue;
      if (Array.isArray(snapshot)) {
        if (snapshot[0] !== undefined) box.active = !!snapshot[0];
        if (snapshot[1] !== undefined) box.respawnAt = snapshot[1];
      }
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
