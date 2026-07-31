import { EventEmitter } from 'node:events';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { CHARACTERS } from '../src/game/characters.js';
import { shuffleRosterForGrid } from '../src/game/race-simulation.js';
import { TRACKS } from '../src/track/tracks.js';
import {
  CONTROLLER_KINDS,
  ERROR_CODES,
  ROOM_STATES,
  ROOM_TYPES,
  SERVER_MESSAGE_TYPES,
  serverMessage,
  validateDisplayName,
  validateRoomCapacity,
  validateRoomName,
  validateRoomPassword,
  validateRoomType,
} from '../src/net/protocol.js';
import { GameError } from './game-error.js';

const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const POST_RACE_STATES = Object.freeze({
  RESULTS: 'results',
  ROOM: 'room',
});
const PASSWORD_HASH_BYTES = 32;
const DEFAULT_ZERO_INPUT = Object.freeze({
  throttle: 0,
  brake: 0,
  steer: 0,
  drift: false,
  lookBack: false,
});

function opaqueId(bytes = 16) {
  return randomBytes(bytes).toString('base64url');
}

function randomSeed() {
  return randomBytes(4).readUInt32LE(0);
}

function requireValid(result) {
  if (!result.ok) throw new GameError(result.error.code, result.error.message);
  return result.value;
}

function occupiedMembers(room) {
  return [...room.members.values()].filter((member) => !member.abandoned);
}

function hasOnlineMember(room) {
  return occupiedMembers(room).some((member) => member.connected);
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function copyEntity(entity, keys) {
  const out = {};
  for (const key of keys) {
    const value = entity?.[key];
    if (value !== undefined) out[key] = Number.isFinite(value) || typeof value !== 'number' ? value : null;
  }
  return out;
}

function serializeKart(kart, rosterEntry, member) {
  return {
    index: kart.index,
    id: kart.id,
    participantId: rosterEntry?.participantId ?? null,
    displayName: rosterEntry?.displayName ?? kart.name,
    characterId: rosterEntry?.characterId ?? kart.character?.id ?? null,
    connected: rosterEntry?.controllerKind === CONTROLLER_KINDS.AI ? true : Boolean(member?.connected),
    controllerKind: member?.controllerKind ?? rosterEntry?.controllerKind ?? CONTROLLER_KINDS.AI,
    ...copyEntity(kart, [
      'x', 'y', 'z', 'yaw', 'vx', 'vy', 'vz', 'speed', 'airborne',
      'visualYawOffset', 'visualRoll', 'visualPitch', 'visualScale', 'wheelSpin',
      'steerAngle', 'drifting', 'driftDirection', 'driftCharge', 'driftTier', 'hopTimer',
      'boostTimer', 'boostPower', 'boostSource', 'speedMul', 'draftCharge',
      'state', 'stateTimer', 'aiSpeedMul', 'startPenaltyTimer', 'invulnTimer',
      'starTimer', 'shrinkTimer', 'spinDirection',
      'item', 'itemUses', 'rouletteTimer', 'rouletteFace', 'pendingItem', 'heldCount',
      's', 'lateral', 'surface', 'offTrackDepth', 'progress', 'lap', 'rank',
      'finished', 'finishTime', 'currentLapStart', 'wrongWay', 'prevX', 'prevZ',
    ]),
    controls: copyEntity(kart.controls, [
      'throttle', 'brake', 'steer', 'drift', 'lookBack',
    ]),
    bestLap: finiteOrNull(kart.bestLap),
    lapTimes: Array.isArray(kart.lapTimes) ? kart.lapTimes.slice() : [],
  };
}

function serializeSimulation(room) {
  const simulation = room.race.simulation;
  const supplied = simulation.getSnapshot?.() ?? simulation.serializeSnapshot?.();
  if (supplied && typeof supplied === 'object') return supplied;

  const rosterByIndex = new Map(room.race.roster.map((entry) => [entry.kartIndex, entry]));
  const membersById = room.members;
  const karts = Array.isArray(simulation.karts)
    ? simulation.karts.map((kart) => {
      const rosterEntry = rosterByIndex.get(kart.index);
      return serializeKart(kart, rosterEntry, membersById.get(rosterEntry?.participantId));
    })
    : [];
  const items = simulation.items;
  const track = simulation.track ?? items?.track;
  return {
    state: simulation.state,
    countdown: finiteOrNull(simulation.countdown),
    elapsed: finiteOrNull(simulation.elapsed),
    laps: simulation.laps,
    standings: Array.isArray(simulation.standings)
      ? simulation.standings.map((kart) => kart.index)
      : karts.slice().sort((a, b) => a.rank - b.rank).map((kart) => kart.index),
    karts,
    projectiles: (items?.projectiles ?? []).map((entity) => copyEntity(entity, [
      'id', 'kind', 'x', 'y', 'z', 'yaw', 'vx', 'vy', 'vz', 'ownerIndex',
      'age', 's', 'bounces', 'targetIndex', 'straight', 'diving', 'armed',
    ])),
    hazards: (items?.hazards ?? []).map((entity) => copyEntity(entity, [
      'id', 'kind', 'x', 'y', 'z', 'yaw', 'ownerIndex', 'age', 's',
      'lateral', 'armed', 'fuse', 'dead',
    ])),
    itemBoxes: (track?.itemBoxes ?? []).map((box) => copyEntity(box, [
      'id', 'x', 'y', 'z', 's', 'lateral', 'active', 'respawnAt',
    ])),
  };
}

function defaultRaceResults(room) {
  const simulation = room.race.simulation;
  const supplied = simulation.getResults?.();
  if (supplied) return supplied;
  const rosterByIndex = new Map(room.race.roster.map((entry) => [entry.kartIndex, entry]));
  return (simulation.standings ?? simulation.karts ?? []).map((kart, index) => {
    const entry = rosterByIndex.get(kart.index);
    return {
      rank: kart.rank ?? index + 1,
      kartIndex: kart.index,
      participantId: entry?.participantId ?? null,
      displayName: entry?.displayName ?? kart.name,
      characterId: entry?.characterId ?? kart.character?.id ?? null,
      finishTime: finiteOrNull(kart.finishTime),
      bestLap: finiteOrNull(kart.bestLap),
      lapTimes: Array.isArray(kart.lapTimes) ? kart.lapTimes.slice() : [],
      finished: Boolean(kart.finished),
    };
  });
}

function publicRoster(roster) {
  return roster.map(({ participantId, displayName, characterId, controllerKind, kartIndex }) => ({
    participantId,
    displayName,
    characterId,
    controllerKind,
    kartIndex,
  }));
}

export class RoomManager extends EventEmitter {
  constructor({
    now = () => performance.now(),
    raceFactory = null,
    tracks = TRACKS,
    characters = CHARACTERS,
    difficulties = ['easy', 'normal', 'hard'],
    maxPlayers = 8,
    loadTimeoutMs = 10_000,
    resumeTimeoutMs = 30_000,
    emptyRoomTtlMs = 60_000,
    resultsTimeoutMs = 30_000,
    inputTimeoutMs = 1_500,
    networkHz = 60,
    snapshotHz = 20,
    maxCatchUpTicks = 8,
    participantIdFactory = () => opaqueId(12),
    resumeTokenFactory = () => opaqueId(24),
    raceIdFactory = () => opaqueId(12),
    seedFactory = randomSeed,
    roomCodeFactory = null,
    random = Math.random,
    passwordSaltFactory = () => randomBytes(16),
  } = {}) {
    super();
    this.now = now;
    this.raceFactory = raceFactory;
    this.tracks = new Map(tracks.map((track) => [track.id, track]));
    this.characters = characters.slice();
    this.characterIds = new Set(characters.map((character) => character.id));
    this.difficulties = new Set(difficulties);
    this.maxPlayers = Math.min(8, maxPlayers, characters.length);
    this.loadTimeoutMs = loadTimeoutMs;
    this.resumeTimeoutMs = resumeTimeoutMs;
    this.emptyRoomTtlMs = emptyRoomTtlMs;
    this.resultsTimeoutMs = resultsTimeoutMs;
    this.inputTimeoutMs = inputTimeoutMs;
    this.networkStepMs = 1000 / networkHz;
    this.snapshotEveryTicks = Math.max(1, Math.round(networkHz / snapshotHz));
    this.maxCatchUpTicks = maxCatchUpTicks;
    this.participantIdFactory = participantIdFactory;
    this.resumeTokenFactory = resumeTokenFactory;
    this.raceIdFactory = raceIdFactory;
    this.seedFactory = seedFactory;
    this.roomCodeFactory = roomCodeFactory;
    this.random = random;
    this.passwordSaltFactory = passwordSaltFactory;
    this._passwordVerifiers = new WeakMap();
    this.rooms = new Map();
    this.participantRooms = new Map();
    this._joinOrder = 0;
  }

  get roomCount() { return this.rooms.size; }

  get activeRaceCount() {
    let count = 0;
    for (const room of this.rooms.values()) if (room.state !== ROOM_STATES.WAITING) count++;
    return count;
  }

  getMetrics() {
    return { rooms: this.roomCount, races: this.activeRaceCount };
  }

  listRooms() {
    const rooms = [];
    for (const room of this.rooms.values()) {
      if (!hasOnlineMember(room)) continue;
      const members = occupiedMembers(room);
      const playerCount = members.length;
      const isWaiting = room.state === ROOM_STATES.WAITING;
      const isFull = isWaiting && playerCount >= room.maxPlayers;
      const host = room.members.get(room.hostParticipantId);
      rooms.push({
        roomCode: room.code,
        roomName: room.roomName,
        roomType: room.roomType,
        requiresPassword: room.roomType === ROOM_TYPES.PRIVATE,
        playerCount,
        maxPlayers: room.maxPlayers,
        hostDisplayName: host?.displayName ?? '',
        status: !isWaiting ? 'in_game' : isFull ? 'full' : 'waiting',
        joinable: isWaiting && !isFull,
      });
    }
    return rooms;
  }

  createRoom(options = {}) {
    const displayName = requireValid(validateDisplayName(options.displayName));
    const characterId = options.characterId;
    const roomName = requireValid(validateRoomName(
      options.roomName ?? `${displayName}'s Room`,
    ));
    const roomType = requireValid(validateRoomType(options.roomType ?? ROOM_TYPES.PUBLIC));
    const maxPlayers = requireValid(validateRoomCapacity(options.maxPlayers ?? this.maxPlayers));
    if (maxPlayers > this.maxPlayers) {
      throw new GameError(
        ERROR_CODES.ROOM_CAPACITY_INVALID,
        `This server supports at most ${this.maxPlayers} players per room.`,
      );
    }
    const password = requireValid(validateRoomPassword(options.password, {
      required: roomType === ROOM_TYPES.PRIVATE,
    }));
    const passwordVerifier = roomType === ROOM_TYPES.PRIVATE
      ? (() => {
        const salt = this.passwordSaltFactory();
        return { salt, hash: scryptSync(password, salt, PASSWORD_HASH_BYTES) };
      })()
      : null;
    const now = this.now();
    const roomCode = this._allocateRoomCode();
    const track = this.tracks.values().next().value;
    if (!track) throw new GameError(ERROR_CODES.INVALID_SETTING, 'No tracks are configured.');
    const room = {
      code: roomCode,
      roomName,
      roomType,
      maxPlayers,
      state: ROOM_STATES.WAITING,
      hostParticipantId: null,
      settings: { trackId: track.id, difficulty: 'normal' },
      members: new Map(),
      race: null,
      lastRaceId: null,
      createdAt: now,
      emptySince: null,
    };
    if (passwordVerifier) this._passwordVerifiers.set(room, passwordVerifier);
    this.rooms.set(roomCode, room);
    let session;
    try {
      session = this._addParticipant(room, { displayName, characterId }, now);
    } catch (error) {
      this.rooms.delete(roomCode);
      throw error;
    }
    room.hostParticipantId = session.participantId;
    this._broadcastRoomState(room);
    return { ...session, roomCode, roomState: this.getRoomState(roomCode) };
  }

  joinRoom(roomCode, { displayName, characterId, password } = {}) {
    const room = this._requireRoom(roomCode);
    if (room.state !== ROOM_STATES.WAITING) {
      throw new GameError(ERROR_CODES.ROOM_LOCKED, 'This race has already started.');
    }
    if (occupiedMembers(room).length >= room.maxPlayers) {
      throw new GameError(ERROR_CODES.ROOM_FULL, 'This room is full.');
    }
    this._verifyPassword(room, password);
    const session = this._addParticipant(room, { displayName, characterId }, this.now());
    if (!room.hostParticipantId) this._migrateHost(room);
    this._broadcastRoomState(room);
    return { ...session, roomCode: room.code, roomState: this.getRoomState(room.code) };
  }

  quickMatch({ displayName, characterId } = {}) {
    displayName = requireValid(validateDisplayName(displayName));
    const candidates = [...this.rooms.values()].filter((room) => {
      if (room.roomType !== ROOM_TYPES.PUBLIC
        || room.state !== ROOM_STATES.WAITING
        || !hasOnlineMember(room)
        || occupiedMembers(room).length >= room.maxPlayers) return false;
      if (characterId === undefined) return true;
      return !occupiedMembers(room).some((member) => member.characterId === characterId);
    });
    if (candidates.length === 0) {
      throw new GameError(
        ERROR_CODES.NO_MATCHING_ROOM,
        'No joinable public room is available.',
      );
    }
    const index = Math.min(
      candidates.length - 1,
      Math.max(0, Math.floor(this.random() * candidates.length)),
    );
    return this.joinRoom(candidates[index].code, { displayName, characterId });
  }

  resume(roomCode, participantId, resumeToken) {
    const room = this._requireRoom(roomCode, ERROR_CODES.SESSION_NOT_FOUND);
    const member = room.members.get(participantId);
    if (!member || member.resumeToken !== resumeToken || (member.abandoned && !member.resumeExpired)) {
      throw new GameError(ERROR_CODES.SESSION_NOT_FOUND, 'That session cannot be resumed.');
    }
    if (member.resumeExpired) {
      throw new GameError(ERROR_CODES.SESSION_EXPIRED, 'The reconnect window has expired.');
    }
    const now = this.now();
    if (!member.connected && member.resumeExpiresAt !== null && now > member.resumeExpiresAt) {
      throw new GameError(ERROR_CODES.SESSION_EXPIRED, 'The reconnect window has expired.');
    }
    member.connected = true;
    member.disconnectedAt = null;
    member.resumeExpiresAt = null;
    room.emptySince = null;
    if (room.race?.simulation && member.kartIndex !== null) {
      this._setController(room, member, CONTROLLER_KINDS.HUMAN);
      member.lastInputAt = now;
    }
    if (!room.hostParticipantId) this._migrateHost(room);
    this._broadcastRoomState(room);
    return {
      roomCode: room.code,
      participantId,
      resumeToken: member.resumeToken,
      resumed: true,
      roomState: this.getRoomState(room.code),
      messages: this.getCatchUpMessages(participantId),
    };
  }

  disconnect(participantId) {
    const { room, member } = this._findParticipant(participantId, false) ?? {};
    if (!room || !member || !member.connected) return false;
    const now = this.now();
    member.connected = false;
    member.resumeExpired = false;
    member.disconnectedAt = now;
    member.resumeExpiresAt = now + this.resumeTimeoutMs;
    if (room.race?.simulation && member.kartIndex !== null) {
      this._setController(room, member, CONTROLLER_KINDS.TAKEOVER_AI);
    }
    if (room.hostParticipantId === participantId) this._migrateHost(room);
    if (![...room.members.values()].some((candidate) => candidate.connected)) room.emptySince = now;
    this._broadcastRoomState(room);
    return true;
  }

  leave(participantId) {
    const { room, member } = this._findParticipant(participantId);
    if (room.state === ROOM_STATES.WAITING) {
      this._removeParticipant(room, member);
    } else {
      member.abandoned = true;
      member.resumeExpired = false;
      member.connected = false;
      member.resumeExpiresAt = null;
      if (room.race?.simulation && member.kartIndex !== null) {
        this._setController(room, member, CONTROLLER_KINDS.TAKEOVER_AI);
      }
      if (room.hostParticipantId === participantId) this._migrateHost(room);
    }
    if (![...room.members.values()].some((candidate) => candidate.connected)) room.emptySince = this.now();
    if (this._maybeReturnRoom(room)) return;
    this._broadcastRoomState(room);
  }

  selectCharacter(participantId, characterId) {
    const { room, member } = this._findParticipant(participantId);
    this._requireMemberRoom(room, member);
    if (!this.characterIds.has(characterId)) {
      throw new GameError(ERROR_CODES.CHARACTER_INVALID, 'That character does not exist.');
    }
    for (const other of room.members.values()) {
      if (other.participantId !== participantId && other.characterId === characterId) {
        throw new GameError(ERROR_CODES.CHARACTER_TAKEN, 'That character is already selected.');
      }
    }
    if (member.characterId !== characterId) {
      member.characterId = characterId;
      member.ready = false;
      this._broadcastRoomState(room);
    }
    return this.getRoomState(room.code);
  }

  setRoom(participantId, patch) {
    const { room, member } = this._findParticipant(participantId);
    this._requireMemberRoom(room, member);
    this._requireHost(room, participantId);
    let changed = false;
    if (patch.trackId !== undefined) {
      if (!this.tracks.has(patch.trackId)) {
        throw new GameError(ERROR_CODES.INVALID_SETTING, 'That track does not exist.');
      }
      if (room.settings.trackId !== patch.trackId) {
        room.settings.trackId = patch.trackId;
        changed = true;
      }
    }
    if (patch.difficulty !== undefined) {
      if (!this.difficulties.has(patch.difficulty)) {
        throw new GameError(ERROR_CODES.INVALID_SETTING, 'That difficulty does not exist.');
      }
      if (room.settings.difficulty !== patch.difficulty) {
        room.settings.difficulty = patch.difficulty;
        changed = true;
      }
    }
    if (changed) {
      for (const member of room.members.values()) member.ready = false;
      this._broadcastRoomState(room);
    }
    return this.getRoomState(room.code);
  }

  setReady(participantId, ready) {
    const { room, member } = this._findParticipant(participantId);
    this._requireMemberRoom(room, member);
    member.ready = Boolean(ready);
    this._broadcastRoomState(room);
    return this.getRoomState(room.code);
  }

  startRace(participantId) {
    const { room } = this._findParticipant(participantId);
    this._requireWaiting(room);
    this._requireHost(room, participantId);
    const members = [...room.members.values()].filter((member) => !member.abandoned);
    const connected = members.filter((member) => member.connected);
    if (connected.length < 2) {
      throw new GameError(ERROR_CODES.NOT_ENOUGH_PLAYERS, 'At least two connected players are required.');
    }
    if (connected.length !== members.length || connected.some((member) => !member.ready)) {
      throw new GameError(ERROR_CODES.NOT_READY, 'Every player must be connected and ready.');
    }

    const now = this.now();
    const seed = this.seedFactory() >>> 0;
    const raceId = this.raceIdFactory();
    const roster = this._buildRoster(room, seed);
    for (const member of members) {
      member.postRaceState = null;
      member.raceLoaded = false;
      member.kartIndex = roster.find((entry) => entry.participantId === member.participantId)?.kartIndex ?? null;
      member.controllerKind = CONTROLLER_KINDS.TAKEOVER_AI;
      member.lastInputSeq = -1;
      member.lastUseItemSeq = 0;
      member.lastAppliedSeq = -1;
      member.pendingUseItems = 0;
      member.lastInput = { ...DEFAULT_ZERO_INPUT };
      member.lastInputAt = now;
    }
    const track = this.tracks.get(room.settings.trackId);
    room.state = ROOM_STATES.LOADING;
    room.race = {
      raceId,
      seed,
      roster,
      trackId: track.id,
      difficulty: room.settings.difficulty,
      laps: track.laps ?? 3,
      loadingDeadline: now + this.loadTimeoutMs,
      simulation: null,
      launchPromise: null,
      tick: 0,
      eventId: 0,
      lastTickAt: now,
      accumulatorMs: 0,
      resultsAt: null,
      results: null,
    };
    this._emitToRoom(room, serverMessage(SERVER_MESSAGE_TYPES.PREPARE_RACE, {
      raceId,
      seed,
      trackId: track.id,
      difficulty: room.settings.difficulty,
      laps: room.race.laps,
      roster: publicRoster(roster),
      loadTimeoutMs: this.loadTimeoutMs,
    }));
    this._broadcastRoomState(room);
    return room.race;
  }

  async markRaceLoaded(participantId, raceId) {
    const { room, member } = this._findParticipant(participantId);
    if (room.state !== ROOM_STATES.LOADING || room.race?.raceId !== raceId) {
      throw new GameError(ERROR_CODES.RACE_MISMATCH, 'That race is not loading.');
    }
    member.raceLoaded = true;
    this._broadcastRoomState(room);
    const active = [...room.members.values()].filter((candidate) => candidate.connected && !candidate.abandoned);
    if (active.length >= 2 && active.every((candidate) => candidate.raceLoaded)) {
      await this._beginRace(room, this.now());
    }
  }

  handleInput(participantId, input) {
    const { room, member } = this._findParticipant(participantId);
    if (!room.race) {
      if (input.raceId === room.lastRaceId) return false;
      throw new GameError(ERROR_CODES.RACE_MISMATCH, 'That input belongs to a different race.');
    }
    if (input.raceId !== room.race.raceId) {
      throw new GameError(ERROR_CODES.RACE_MISMATCH, 'That input belongs to a different race.');
    }
    if (!room.race.simulation
      || ![ROOM_STATES.COUNTDOWN, ROOM_STATES.RACING].includes(room.state)) return false;
    if (!member.connected || member.abandoned || !member.raceLoaded) {
      throw new GameError(ERROR_CODES.FORBIDDEN, 'This participant is not controlling a kart.');
    }

    let accepted = false;
    if (input.useItemSeq > member.lastUseItemSeq) {
      const delta = input.useItemSeq - member.lastUseItemSeq;
      member.pendingUseItems = Math.min(8, member.pendingUseItems + Math.min(delta, 8));
      member.lastUseItemSeq = input.useItemSeq;
      accepted = true;
    }
    if (input.seq > member.lastInputSeq) {
      member.lastInputSeq = input.seq;
      member.lastInput = {
        throttle: input.throttle,
        brake: input.brake,
        steer: input.steer,
        drift: input.drift,
        lookBack: input.lookBack,
      };
      accepted = true;
    }
    if (accepted) {
      member.lastInputAt = this.now();
      this._setController(room, member, CONTROLLER_KINDS.HUMAN);
    }
    return accepted;
  }

  returnToRoom(participantId) {
    const { room, member } = this._findParticipant(participantId);
    if (room.state === ROOM_STATES.WAITING) return this.getRoomState(room.code);
    if (room.state !== ROOM_STATES.RESULTS) {
      throw new GameError(ERROR_CODES.INVALID_STATE, 'The race is not showing results.');
    }
    if (member.postRaceState !== POST_RACE_STATES.ROOM) {
      member.postRaceState = POST_RACE_STATES.ROOM;
      member.ready = false;
    }
    if (!this._maybeReturnRoom(room)) this._broadcastRoomState(room);
    return this.getRoomState(room.code);
  }

  getRoomState(roomCode) {
    const room = this._requireRoom(roomCode);
    const track = this.tracks.get(room.settings.trackId);
    const members = [...room.members.values()]
      .sort((a, b) => a.joinOrder - b.joinOrder)
      .map((member) => ({
        participantId: member.participantId,
        displayName: member.displayName,
        characterId: member.characterId,
        isHost: member.participantId === room.hostParticipantId,
        ready: member.ready,
        connected: member.connected,
        postRaceState: member.postRaceState,
        activityState: room.state === ROOM_STATES.RESULTS
          && member.postRaceState !== POST_RACE_STATES.ROOM
          ? 'in_game'
          : 'room',
        loaded: room.state === ROOM_STATES.LOADING ? member.raceLoaded : undefined,
        controllerKind: member.controllerKind,
      }));
    return serverMessage(SERVER_MESSAGE_TYPES.ROOM_STATE, {
      roomCode: room.code,
      roomName: room.roomName,
      roomType: room.roomType,
      maxPlayers: room.maxPlayers,
      state: room.state,
      hostParticipantId: room.hostParticipantId,
      settings: {
        trackId: room.settings.trackId,
        difficulty: room.settings.difficulty,
        laps: track?.laps ?? 3,
      },
      raceId: room.race?.raceId ?? null,
      members,
      canStart: this._canStart(room),
    });
  }

  getCatchUpMessages(participantId) {
    const { room, member } = this._findParticipant(participantId);
    const messages = [this.getRoomState(room.code)];
    const returnedFromResults = room.state === ROOM_STATES.RESULTS
      && member.postRaceState === POST_RACE_STATES.ROOM;
    if (room.race && !returnedFromResults) {
      messages.push(serverMessage(SERVER_MESSAGE_TYPES.PREPARE_RACE, {
        raceId: room.race.raceId,
        seed: room.race.seed,
        trackId: room.race.trackId,
        difficulty: room.race.difficulty,
        laps: room.race.laps,
        roster: publicRoster(room.race.roster),
        resumed: true,
      }));
      if (room.race.simulation) messages.push(this._snapshotFor(room, member));
      if (room.state === ROOM_STATES.RESULTS && room.race.results) {
        messages.push(serverMessage(SERVER_MESSAGE_TYPES.RACE_RESULTS, {
          raceId: room.race.raceId,
          results: room.race.results,
        }));
      }
    }
    return messages;
  }

  async tick(now = this.now()) {
    const launches = [];
    for (const room of this.rooms.values()) {
      if (room.emptySince !== null && now - room.emptySince >= this.emptyRoomTtlMs) {
        this._destroyRoom(room);
        continue;
      }
      if (room.state === ROOM_STATES.WAITING) {
        this._expireWaitingMembers(room, now);
        continue;
      }
      this._expireRaceSessions(room, now);
      if (room.state === ROOM_STATES.LOADING) {
        if (now >= room.race.loadingDeadline) launches.push(this._beginRace(room, now));
        continue;
      }
      if ([ROOM_STATES.COUNTDOWN, ROOM_STATES.RACING].includes(room.state)) {
        this._advanceRace(room, now);
        continue;
      }
      if (room.state === ROOM_STATES.RESULTS
        && now - room.race.resultsAt >= this.resultsTimeoutMs) {
        this._returnRoom(room);
      }
    }
    if (launches.length) {
      const results = await Promise.allSettled(launches);
      for (const result of results) {
        if (result.status === 'rejected') this.emit('managerError', result.reason);
      }
    }
  }

  close() {
    for (const room of [...this.rooms.values()]) this._destroyRoom(room);
    this.removeAllListeners();
  }

  _addParticipant(room, { displayName, characterId }, now) {
    const validatedName = validateDisplayName(displayName);
    if (!validatedName.ok) {
      throw new GameError(validatedName.error.code, validatedName.error.message);
    }
    displayName = validatedName.value;
    const usedCharacters = new Set([...room.members.values()].map((member) => member.characterId));
    const selectedCharacter = characterId ?? this.characters.find((character) => !usedCharacters.has(character.id))?.id;
    if (!this.characterIds.has(selectedCharacter)) {
      throw new GameError(ERROR_CODES.CHARACTER_INVALID, 'That character does not exist.');
    }
    if (usedCharacters.has(selectedCharacter)) {
      throw new GameError(ERROR_CODES.CHARACTER_TAKEN, 'That character is already selected.');
    }
    const participantId = this.participantIdFactory();
    const resumeToken = this.resumeTokenFactory();
    const member = {
      participantId,
      resumeToken,
      displayName,
      characterId: selectedCharacter,
      ready: false,
      connected: true,
      abandoned: false,
      resumeExpired: false,
      disconnectedAt: null,
      resumeExpiresAt: null,
      joinOrder: this._joinOrder++,
      raceLoaded: false,
      kartIndex: null,
      controllerKind: CONTROLLER_KINDS.HUMAN,
      lastInputSeq: -1,
      lastUseItemSeq: 0,
      lastAppliedSeq: -1,
      pendingUseItems: 0,
      lastInput: { ...DEFAULT_ZERO_INPUT },
      lastInputAt: now,
      postRaceState: null,
    };
    room.members.set(participantId, member);
    this.participantRooms.set(participantId, room.code);
    room.emptySince = null;
    return { participantId, resumeToken };
  }

  _buildRoster(room, seed) {
    const roster = [...room.members.values()]
      .filter((member) => !member.abandoned)
      .map((member) => ({
        participantId: member.participantId,
        displayName: member.displayName,
        characterId: member.characterId,
        controllerKind: CONTROLLER_KINDS.HUMAN,
      }));
    const used = new Set(roster.map((entry) => entry.characterId));
    for (const character of this.characters) {
      if (roster.length >= this.characters.length || roster.length >= 8) break;
      if (used.has(character.id)) continue;
      roster.push({
        participantId: `ai-${character.id}`,
        displayName: character.name,
        characterId: character.id,
        controllerKind: CONTROLLER_KINDS.AI,
      });
    }
    const ordered = shuffleRosterForGrid(roster, seed);
    for (let i = 0; i < ordered.length; i++) ordered[i].kartIndex = i;
    return ordered;
  }

  async _beginRace(room, now) {
    const race = room.race;
    if (room.state !== ROOM_STATES.LOADING || !race || race.simulation) return;
    if (race.launchPromise) return race.launchPromise;
    const launchPromise = (async () => {
      const activeHumans = [...room.members.values()]
        .filter((member) => member.connected && member.raceLoaded && !member.abandoned);
      if (activeHumans.length < 2) {
        this._finalizeRaceMembers(room, { resetReady: true });
        room.state = ROOM_STATES.WAITING;
        room.race = null;
        this._emitToRoom(room, serverMessage(SERVER_MESSAGE_TYPES.ERROR, {
          code: ERROR_CODES.NOT_ENOUGH_PLAYERS,
          message: 'Race cancelled because fewer than two players finished loading.',
        }));
        this._broadcastRoomState(room);
        return;
      }
      if (!this.raceFactory) {
        throw new GameError(ERROR_CODES.INTERNAL_ERROR, 'No authoritative race factory is configured.');
      }
      const simulation = await this.raceFactory({
        raceId: race.raceId,
        seed: race.seed,
        trackId: race.trackId,
        trackDef: this.tracks.get(race.trackId),
        difficulty: race.difficulty,
        laps: race.laps,
        roster: race.roster.map((entry) => ({ ...entry })),
      });
      if (!simulation || typeof simulation.update !== 'function') {
        throw new GameError(ERROR_CODES.INTERNAL_ERROR, 'Race factory returned an invalid simulation.');
      }
      if (room.race !== race || room.state !== ROOM_STATES.LOADING) {
        simulation.dispose?.();
        return;
      }
      race.simulation = simulation;
      race.lastTickAt = now;
      race.accumulatorMs = 0;
      room.state = simulation.state === ROOM_STATES.RACING
        ? ROOM_STATES.RACING
        : ROOM_STATES.COUNTDOWN;
      for (const member of room.members.values()) {
        const kind = member.connected && member.raceLoaded && !member.abandoned
          ? CONTROLLER_KINDS.HUMAN
          : CONTROLLER_KINDS.TAKEOVER_AI;
        this._setController(room, member, kind, true);
      }
      this._broadcastRoomState(room);
    })().catch((error) => {
      if (room.state === ROOM_STATES.LOADING && room.race === race) {
        this._finalizeRaceMembers(room, { resetReady: true });
        room.state = ROOM_STATES.WAITING;
        room.race = null;
        this._emitToRoom(room, serverMessage(SERVER_MESSAGE_TYPES.ERROR, {
          code: error instanceof GameError ? error.code : ERROR_CODES.INTERNAL_ERROR,
          message: 'The authoritative race could not be started.',
        }));
        this._broadcastRoomState(room);
      }
      this.emit('managerError', error);
    });
    race.launchPromise = launchPromise;
    return launchPromise;
  }

  _advanceRace(room, now) {
    const race = room.race;
    const wallDelta = Math.max(0, Math.min(250, now - race.lastTickAt));
    race.lastTickAt = now;
    race.accumulatorMs += wallDelta;
    let steps = 0;
    while (race.accumulatorMs >= this.networkStepMs && steps < this.maxCatchUpTicks) {
      race.accumulatorMs -= this.networkStepMs;
      this._networkTick(room, now);
      steps++;
      if (room.state === ROOM_STATES.RESULTS) break;
    }
    if (steps === this.maxCatchUpTicks) {
      race.accumulatorMs = Math.min(race.accumulatorMs, this.networkStepMs);
    }
  }

  _networkTick(room, now) {
    const race = room.race;
    const firstInputs = new Array(race.roster.length).fill(null);
    const secondInputs = new Array(race.roster.length).fill(null);
    for (const member of room.members.values()) {
      if (member.kartIndex === null) continue;
      const timedOut = now - member.lastInputAt > this.inputTimeoutMs;
      const human = member.connected && member.raceLoaded && !member.abandoned && !timedOut;
      this._setController(room, member, human ? CONTROLLER_KINDS.HUMAN : CONTROLLER_KINDS.TAKEOVER_AI);
      if (!human) continue;
      const useItem = member.pendingUseItems > 0;
      firstInputs[member.kartIndex] = { ...member.lastInput, useItem };
      secondInputs[member.kartIndex] = { ...member.lastInput, useItem: false };
      if (useItem) member.pendingUseItems--;
      member.lastAppliedSeq = member.lastInputSeq;
    }

    race.simulation.update(1 / 120, firstInputs);
    race.simulation.update(1 / 120, secondInputs);
    race.tick++;
    this._drainRaceEvents(room);
    if (race.tick % this.snapshotEveryTicks === 0) this._broadcastSnapshots(room);

    const simulationState = race.simulation.state;
    if (simulationState === ROOM_STATES.RACING && room.state === ROOM_STATES.COUNTDOWN) {
      room.state = ROOM_STATES.RACING;
      this._broadcastRoomState(room);
    }
    if (simulationState === ROOM_STATES.RESULTS || race.simulation.isRaceOver) {
      this._finishRace(room, now);
    }
  }

  _drainRaceEvents(room) {
    const simulation = room.race.simulation;
    let events = simulation.drainEvents?.() ?? [];
    let vfx = simulation.drainVfx?.() ?? simulation.items?.drainVfx?.() ?? [];
    if (!Array.isArray(events) || events.length === 0) {
      events = [];
      for (const kart of simulation.karts ?? []) {
        for (const event of kart.events ?? []) events.push({ kartIndex: kart.index, ...event });
        kart.clearEvents?.();
      }
    }
    if (!Array.isArray(vfx)) vfx = [];
    if (events.length === 0 && vfx.length === 0) return;
    const numbered = events.map((event) => ({ ...event, eventId: ++room.race.eventId }));
    const numberedVfx = vfx.map((event) => ({ ...event, eventId: ++room.race.eventId }));
    this._emitToRoom(room, serverMessage(SERVER_MESSAGE_TYPES.RACE_EVENTS, {
      raceId: room.race.raceId,
      events: numbered,
      vfx: numberedVfx,
    }));
  }

  _broadcastSnapshots(room) {
    for (const member of room.members.values()) {
      if (!member.connected || member.abandoned) continue;
      this._emitToParticipant(member.participantId, this._snapshotFor(room, member));
    }
  }

  _snapshotFor(room, member) {
    const snapshot = serializeSimulation(room);
    return serverMessage(SERVER_MESSAGE_TYPES.SNAPSHOT, {
      ...snapshot,
      raceId: room.race.raceId,
      tick: room.race.tick,
      serverTime: this.now(),
      ack: member.lastAppliedSeq,
      inputAck: member.lastAppliedSeq,
      receivedInputSeq: member.lastInputSeq,
      receivedUseItemSeq: member.lastUseItemSeq,
    });
  }

  _finishRace(room, now) {
    if (room.state === ROOM_STATES.RESULTS) return;
    room.state = ROOM_STATES.RESULTS;
    room.race.resultsAt = now;
    room.race.results = defaultRaceResults(room);
    for (const member of room.members.values()) {
      member.ready = false;
      member.postRaceState = member.abandoned ? null : POST_RACE_STATES.RESULTS;
    }
    this._broadcastSnapshots(room);
    this._emitToRoom(room, serverMessage(SERVER_MESSAGE_TYPES.RACE_RESULTS, {
      raceId: room.race.raceId,
      results: room.race.results,
    }));
    this._broadcastRoomState(room);
  }

  _returnRoom(room) {
    room.race?.simulation?.dispose?.();
    room.lastRaceId = room.race?.raceId ?? room.lastRaceId;
    this._finalizeRaceMembers(room);
    room.race = null;
    room.state = ROOM_STATES.WAITING;
    this._migrateHost(room);
    this._broadcastRoomState(room);
  }

  _finalizeRaceMembers(room, { resetReady = false, now = this.now() } = {}) {
    for (const member of [...room.members.values()]) {
      const reconnectWindowExpired = member.resumeExpired
        || (!member.connected
          && member.resumeExpiresAt !== null
          && now > member.resumeExpiresAt);
      if (member.abandoned || reconnectWindowExpired) {
        this._removeParticipant(room, member);
        continue;
      }
      if (resetReady) member.ready = false;
      member.raceLoaded = false;
      member.kartIndex = null;
      member.controllerKind = CONTROLLER_KINDS.HUMAN;
      member.pendingUseItems = 0;
      member.postRaceState = null;
    }
    this._migrateHost(room);
  }

  _maybeReturnRoom(room) {
    if (room.state !== ROOM_STATES.RESULTS) return false;
    const active = [...room.members.values()]
      .filter((member) => member.connected && !member.abandoned);
    if (active.length === 0
      || active.some((member) => member.postRaceState !== POST_RACE_STATES.ROOM)) {
      return false;
    }
    this._returnRoom(room);
    return true;
  }

  _setController(room, member, kind, force = false) {
    const rosterEntry = room.race?.roster.find((entry) => entry.participantId === member.participantId);
    if (!force && member.controllerKind === kind && rosterEntry?.controllerKind === kind) return;
    member.controllerKind = kind;
    if (rosterEntry) rosterEntry.controllerKind = kind;
    room.race?.simulation?.setController?.(member.kartIndex, kind);
  }

  _canStart(room) {
    if (room.state !== ROOM_STATES.WAITING) return false;
    const members = [...room.members.values()].filter((member) => !member.abandoned);
    return members.length >= 2 && members.every((member) => member.connected && member.ready);
  }

  _expireWaitingMembers(room, now) {
    let changed = false;
    for (const member of [...room.members.values()]) {
      if (!member.connected && member.resumeExpiresAt !== null && now > member.resumeExpiresAt) {
        this._removeParticipant(room, member);
        changed = true;
      }
    }
    if (changed) {
      this._migrateHost(room);
      this._broadcastRoomState(room);
    }
  }

  _expireRaceSessions(room, now) {
    let changed = false;
    for (const member of room.members.values()) {
      if (!member.connected && member.resumeExpiresAt !== null && now > member.resumeExpiresAt) {
        member.resumeExpiresAt = null;
        member.abandoned = true;
        member.resumeExpired = true;
        changed = true;
      }
    }
    if (changed) this._broadcastRoomState(room);
  }

  _removeParticipant(room, member) {
    room.members.delete(member.participantId);
    this.participantRooms.delete(member.participantId);
    if (room.hostParticipantId === member.participantId) this._migrateHost(room);
  }

  _migrateHost(room) {
    if (room.members.get(room.hostParticipantId)?.connected) return;
    const next = [...room.members.values()]
      .filter((member) => member.connected && !member.abandoned)
      .sort((a, b) => a.joinOrder - b.joinOrder)[0];
    room.hostParticipantId = next?.participantId ?? null;
  }

  _destroyRoom(room) {
    room.race?.simulation?.dispose?.();
    for (const participantId of room.members.keys()) this.participantRooms.delete(participantId);
    this.rooms.delete(room.code);
    this.emit('roomDestroyed', { roomCode: room.code });
    this.emit('lobbyChanged');
  }

  _requireRoom(roomCode, code = ERROR_CODES.ROOM_NOT_FOUND) {
    const room = this.rooms.get(String(roomCode).toUpperCase());
    if (!room) throw new GameError(code, 'Room not found.');
    return room;
  }

  _findParticipant(participantId, required = true) {
    const roomCode = this.participantRooms.get(participantId);
    const room = roomCode ? this.rooms.get(roomCode) : null;
    const member = room?.members.get(participantId);
    if ((!room || !member) && required) throw new GameError(ERROR_CODES.NOT_IN_ROOM, 'Join a room first.');
    return room && member ? { room, member } : null;
  }

  _requireWaiting(room) {
    if (room.state !== ROOM_STATES.WAITING) {
      throw new GameError(ERROR_CODES.INVALID_STATE, 'This action is only available while the room is waiting.');
    }
  }

  _requireMemberRoom(room, member) {
    if (room.state === ROOM_STATES.WAITING) return;
    if (room.state === ROOM_STATES.RESULTS
      && member.postRaceState === POST_RACE_STATES.ROOM) return;
    throw new GameError(ERROR_CODES.INVALID_STATE, 'Return to the room before doing that.');
  }

  _requireHost(room, participantId) {
    if (room.hostParticipantId !== participantId) {
      throw new GameError(ERROR_CODES.FORBIDDEN, 'Only the room host can do that.');
    }
  }

  _allocateRoomCode() {
    for (let attempt = 0; attempt < 100; attempt++) {
      let code = this.roomCodeFactory?.();
      if (!code) {
        const bytes = randomBytes(6);
        code = '';
        for (const byte of bytes) code += ROOM_ALPHABET[byte % ROOM_ALPHABET.length];
      }
      code = String(code).toUpperCase();
      if (!this.rooms.has(code)) return code;
    }
    throw new GameError(ERROR_CODES.SERVER_BUSY, 'Could not allocate a room code.');
  }

  _verifyPassword(room, password) {
    if (room.roomType !== ROOM_TYPES.PRIVATE) return;
    if (password === undefined || password === null || password === '') {
      throw new GameError(ERROR_CODES.PASSWORD_REQUIRED, 'A password is required for this room.');
    }
    const validated = validateRoomPassword(password);
    if (!validated.ok) {
      throw new GameError(ERROR_CODES.PASSWORD_INVALID, 'The room password is incorrect.');
    }
    const verifier = this._passwordVerifiers.get(room);
    if (!verifier) {
      throw new GameError(ERROR_CODES.INTERNAL_ERROR, 'Room password verifier is unavailable.');
    }
    const candidate = scryptSync(validated.value, verifier.salt, PASSWORD_HASH_BYTES);
    if (!timingSafeEqual(candidate, verifier.hash)) {
      throw new GameError(ERROR_CODES.PASSWORD_INVALID, 'The room password is incorrect.');
    }
  }

  _broadcastRoomState(room) {
    if (!this.rooms.has(room.code)) return;
    this._emitToRoom(room, this.getRoomState(room.code));
    this.emit('lobbyChanged');
  }

  _emitToRoom(room, message) {
    this.emit('message', { roomCode: room.code, participantId: null, message });
  }

  _emitToParticipant(participantId, message) {
    this.emit('message', { roomCode: null, participantId, message });
  }
}

export { serializeSimulation };
