import { EventEmitter } from 'node:events';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { CHARACTERS } from '../src/game/characters.js';
import { deriveRng } from '../src/core/rng.js';
import {
  AVATARS,
  DEFAULT_ONLINE_LOADOUT,
  PAINT_THEMES,
  defaultLoadoutForCharacter,
  pickDistinctAppearance,
} from '../src/game/appearance.js';
import { shuffleRosterForGrid } from '../src/game/race-simulation.js';
import { TRACKS } from '../src/track/tracks.js';
import {
  CHAT_SEND_INTERVAL_MS,
  CONTROLLER_KINDS,
  ERROR_CODES,
  PROTOCOL_VERSION,
  ROOM_STATES,
  ROOM_TYPES,
  SERVER_MESSAGE_TYPES,
  encodeKartSnapshot,
  serverMessage,
  validateChatContent,
  validateDisplayName,
  validateRoomCapacity,
  validateRoomName,
  validateRoomPassword,
  validateRoomType,
} from '../src/net/protocol.js';
import {
  BinaryPacketWriter,
  RaceCodecError,
  encodeSnapshotPacket,
} from '../src/net/binary-race-codec.js';
import { GameError } from './game-error.js';
import { defaultScryptQueue, ScryptQueueFullError } from './scrypt-queue.js';

const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const BOT_ROOM_NAME = 'Bot自建房';
export const BOT_HOST_NAME = '赛博房主';
export const DEFAULT_BOT_ROOM_CHECK_INTERVAL_MS = 15_000;
export const DEFAULT_BOT_MAP_CHANGE_COOLDOWN_MS = 3_000;
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

function randomWireRaceId() {
  return randomSeed() || 1;
}

function requireValid(result) {
  if (!result.ok) throw new GameError(result.error.code, result.error.message);
  return result.value;
}

function occupiedMembers(room) {
  return [...room.members.values()].filter((member) => !member.abandoned);
}

function humanMembers(room) {
  return occupiedMembers(room).filter((member) => !member.isBot);
}

function hasLiveHuman(room) {
  return humanMembers(room).length > 0;
}

function hasConnectedHuman(room) {
  return humanMembers(room).some((member) => member.connected);
}

function botMemberOf(room) {
  return [...room.members.values()].find((member) => member.isBot) ?? null;
}

function hasOnlineMember(room) {
  if (room.botManaged && room.state === ROOM_STATES.WAITING && !room.botRetiring) return true;
  return hasConnectedHuman(room);
}

function normalizeBotCommandText(content) {
  const normalized = String(content || '')
    .trim()
    .replace(/^／/u, '/')
    .replace(/[０-９]/gu, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xFEE0));
  if (!normalized.startsWith('/')) return null;
  const parts = normalized.slice(1).trim().split(/\s+/u).filter(Boolean);
  const name = String(parts.shift() || '').toLocaleLowerCase('en-US');
  if (['帮助', 'help', 'h'].includes(name)) {
    return parts.length === 0 ? { kind: 'help' } : { kind: 'unknown' };
  }
  if (['地图', 'map', 'm'].includes(name)) return { kind: 'map', args: parts };
  if (['开始', 'start', 's'].includes(name)) {
    return parts.length === 0 ? { kind: 'start' } : { kind: 'unknown' };
  }
  return { kind: 'unknown' };
}

function presenceStateOf(member) {
  if (member.abandoned) return member.resumeExpired ? 'disconnected' : 'left';
  if (!member.connected) return 'reconnecting';
  return 'connected';
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

function serializeSimulation(room) {
  const simulation = room.race.simulation;
  const supplied = simulation.getSnapshot?.() ?? simulation.serializeSnapshot?.();
  const source = supplied && typeof supplied === 'object' ? supplied : simulation;
  const rosterByIndex = room.race.rosterByKartIndex
    ?? new Map(room.race.roster.map((entry) => [entry.kartIndex, entry]));
  const membersById = room.members;
  const sourceKarts = Array.isArray(source.karts) ? source.karts : simulation.karts;
  const karts = Array.isArray(sourceKarts)
    ? sourceKarts.map((kart) => {
      if (Array.isArray(kart)) return kart;
      const rosterEntry = rosterByIndex.get(kart.index);
      const member = membersById.get(rosterEntry?.participantId);
      return encodeKartSnapshot(
        kart,
        member?.controllerKind ?? rosterEntry?.controllerKind ?? CONTROLLER_KINDS.AI,
      );
    })
    : [];
  const items = simulation.items;
  const track = simulation.track ?? items?.track;
  const sourceItemBoxes = Array.isArray(source.itemBoxes) ? source.itemBoxes : track?.itemBoxes;
  return {
    state: source.state ?? simulation.state,
    countdown: finiteOrNull(source.countdown ?? simulation.countdown),
    elapsed: finiteOrNull(source.elapsed ?? simulation.elapsed),
    laps: source.laps ?? simulation.laps,
    karts,
    projectiles: (source.projectiles ?? items?.projectiles ?? []).map((entity) => copyEntity(entity, [
      'id', 'kind', 'x', 'y', 'z', 'yaw', 'vx', 'vy', 'vz', 'ownerIndex',
      'age', 's', 'bounces', 'targetIndex', 'straight', 'diving', 'armed',
    ])),
    hazards: (source.hazards ?? items?.hazards ?? []).map((entity) => copyEntity(entity, [
      'id', 'kind', 'x', 'y', 'z', 'yaw', 'ownerIndex', 'age', 's',
      'lateral', 'armed', 'fuse', 'dead',
    ])),
    itemBoxes: (sourceItemBoxes ?? []).map((box) => (
      Array.isArray(box)
        ? [Boolean(box[0]), finiteOrNull(box[1])]
        : [Boolean(box?.active), finiteOrNull(box?.respawnAt)]
    )),
  };
}

function prepareBinarySnapshotSource(room, serverTime) {
  const race = room.race;
  const simulation = race.simulation;
  const supplied = simulation.getSnapshot?.() ?? simulation.serializeSnapshot?.();
  const source = supplied && typeof supplied === 'object' ? supplied : simulation;
  const items = simulation.items;
  const track = simulation.track ?? items?.track;
  const snapshot = race.snapshotSource;
  snapshot.state = source.state ?? simulation.state;
  snapshot.countdown = source.countdown ?? simulation.countdown ?? null;
  snapshot.elapsed = source.elapsed ?? simulation.elapsed ?? 0;
  snapshot.laps = source.laps ?? simulation.laps ?? race.laps;
  snapshot.karts = Array.isArray(source.karts) ? source.karts : simulation.karts ?? [];
  snapshot.controllerKinds = Array.isArray(source.controllerKinds)
    ? source.controllerKinds
    : simulation.controllerKinds ?? race.roster.map((entry) => entry.controllerKind);
  snapshot.projectiles = source.projectiles ?? items?.projectiles ?? [];
  snapshot.hazards = source.hazards ?? items?.hazards ?? [];
  snapshot.itemBoxes = Array.isArray(source.itemBoxes)
    ? source.itemBoxes
    : track?.itemBoxes ?? [];
  snapshot.tick = race.tick;
  snapshot.serverTime = serverTime;
  for (let index = 0; index < race.ackMembers.length; index++) {
    const member = room.members.get(race.ackMembers[index].participantId);
    const ack = race.ackEntries[index];
    ack[1] = member?.lastAppliedSeq ?? -1;
    ack[2] = member?.lastUseItemSeq ?? 0;
  }
  return snapshot;
}

function defaultRaceResults(room) {
  const simulation = room.race.simulation;
  const supplied = simulation.getResults?.();
  const rosterByIndex = new Map(room.race.roster.map((entry) => [entry.kartIndex, entry]));
  const rawResults = supplied ?? (simulation.standings ?? simulation.karts ?? []).map((kart, index) => {
    const entry = rosterByIndex.get(kart.index);
    return {
      rank: kart.rank ?? index + 1,
      kartIndex: kart.index,
      participantId: entry?.participantId ?? null,
      displayName: entry?.displayName ?? kart.name,
      aiPlayerNumber: entry?.aiPlayerNumber ?? null,
      characterId: entry?.characterId ?? kart.character?.id ?? null,
      paintId: entry?.paintId ?? null,
      avatarId: entry?.avatarId ?? null,
      finishTime: finiteOrNull(kart.finishTime),
      bestLap: finiteOrNull(kart.bestLap),
      lapTimes: Array.isArray(kart.lapTimes) ? kart.lapTimes.slice() : [],
      finished: Boolean(kart.finished),
      autoPlaced: Boolean(kart.autoPlaced),
    };
  });
  return rawResults.map((result) => {
    const completed = result.completed === undefined
      ? Boolean(result.finished && !result.autoPlaced)
      : Boolean(result.completed);
    return {
      ...result,
      completed,
      finishTime: completed ? finiteOrNull(result.finishTime) : null,
    };
  });
}

function publicRoster(roster) {
  return roster.map(({
    participantId, displayName, aiPlayerNumber, isBot,
    characterId, paintId, avatarId, controllerKind, kartIndex,
  }) => ({
    participantId,
    displayName,
    ...(aiPlayerNumber == null ? {} : { aiPlayerNumber }),
    ...(isBot ? { isBot: true } : {}),
    characterId,
    paintId,
    avatarId,
    controllerKind,
    kartIndex,
  }));
}

export class RoomManager extends EventEmitter {
  constructor({
    now = () => performance.now(),
    wallClock = () => Date.now(),
    raceFactory = null,
    tracks = TRACKS,
    characters = CHARACTERS,
    paints = PAINT_THEMES,
    avatars = AVATARS,
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
    wireRaceIdFactory = randomWireRaceId,
    seedFactory = randomSeed,
    roomCodeFactory = null,
    random = Math.random,
    passwordSaltFactory = () => randomBytes(16),
    scryptQueue = defaultScryptQueue,
    metrics = null,
    userStore = null,
    siteAnalytics = null,
    settlementRetryDelaysMs = [2_000, 10_000],
    roomReceiverCountProvider = null,
    botRoomsEnabled = false,
    botRoomCheckIntervalMs = DEFAULT_BOT_ROOM_CHECK_INTERVAL_MS,
    botMapChangeCooldownMs = DEFAULT_BOT_MAP_CHANGE_COOLDOWN_MS,
  } = {}) {
    super();
    this.now = now;
    this.wallClock = wallClock;
    this.raceFactory = raceFactory;
    this.tracks = new Map(tracks.map((track) => [track.id, track]));
    this.characters = characters.slice();
    this.characterIds = new Set(characters.map((character) => character.id));
    this.playableCharacters = characters.filter((character) => character.availability !== 'locked');
    this.playableCharacterIds = new Set(this.playableCharacters.map((character) => character.id));
    this.paints = paints.slice();
    this.avatars = avatars.slice();
    this.paintIds = new Set(paints.map((paint) => paint.id));
    this.avatarIds = new Set(avatars.map((avatar) => avatar.id));
    this.difficulties = new Set(difficulties);
    this.maxPlayers = Math.min(8, maxPlayers);
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
    this.wireRaceIdFactory = wireRaceIdFactory;
    this.seedFactory = seedFactory;
    this.roomCodeFactory = roomCodeFactory;
    this.random = random;
    this.passwordSaltFactory = passwordSaltFactory;
    this.scryptQueue = scryptQueue;
    this.metrics = metrics;
    this.userStore = userStore;
    this.siteAnalytics = siteAnalytics;
    this.settlementRetryDelaysMs = Array.isArray(settlementRetryDelaysMs)
      ? settlementRetryDelaysMs
        .map(Number)
        .filter((delay) => Number.isFinite(delay) && delay >= 0)
      : [];
    this.roomReceiverCountProvider = roomReceiverCountProvider;
    this.botRoomsEnabled = Boolean(botRoomsEnabled);
    this.botRoomCheckIntervalMs = Math.max(1_000, Number(botRoomCheckIntervalMs)
      || DEFAULT_BOT_ROOM_CHECK_INTERVAL_MS);
    this.botMapChangeCooldownMs = Math.max(0, Number(botMapChangeCooldownMs)
      || DEFAULT_BOT_MAP_CHANGE_COOLDOWN_MS);
    this.nextBotRoomCheckAt = this.now();
    this._passwordVerifiers = new WeakMap();
    this.rooms = new Map();
    this.activeRaceRooms = new Set();
    this.participantRooms = new Map();
    this.userParticipants = new Map();
    this.pendingSettlements = new Map();
    this._joinOrder = 0;
    this._lobbySignature = '[]';
    this._roomErrorLastAt = new WeakMap();
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

  isUserActive(userId) {
    const normalized = String(userId || '');
    if (!normalized) return false;
    if (this.userParticipants.has(normalized)) return true;
    for (const settlement of this.pendingSettlements.values()) {
      if (settlement.participants.some((participant) => participant.userId === normalized)) return true;
    }
    return false;
  }

  listRooms() {
    const rooms = [];
    for (const room of this.rooms.values()) {
      if (!hasOnlineMember(room)) continue;
      const members = occupiedMembers(room);
      const playerCount = members.length;
      const isWaiting = room.state === ROOM_STATES.WAITING;
      const isFull = isWaiting && playerCount >= room.maxPlayers;
      const joinable = isWaiting && !isFull;
      const host = room.members.get(room.hostParticipantId);
      rooms.push({
        roomCode: room.code,
        roomName: room.roomName,
        roomType: room.roomType,
        botManaged: Boolean(room.botManaged),
        requiresPassword: room.roomType === ROOM_TYPES.PRIVATE,
        playerCount,
        maxPlayers: room.maxPlayers,
        hostDisplayName: host?.displayName ?? '',
        trackId: room.settings.trackId,
        status: !isWaiting ? 'in_game' : isFull ? 'full' : 'waiting',
        joinable,
      });
    }
    return rooms;
  }

  reconcileBotRooms(now = this.now()) {
    this.nextBotRoomCheckAt = now + this.botRoomCheckIntervalMs;
    if (!this.botRoomsEnabled) return null;
    return this._reconcileBotRooms(now);
  }

  setBotRoomsEnabled(enabled, { reconcile = true } = {}) {
    const next = Boolean(enabled);
    const now = this.now();
    this.botRoomsEnabled = next;
    if (next) {
      for (const room of this.rooms.values()) {
        if (!room.botManaged || !room.botRetiring) continue;
        room.botRetiring = false;
        this._broadcastRoomState(room);
      }
      this.nextBotRoomCheckAt = now;
      if (reconcile) this.reconcileBotRooms(now);
    } else {
      this.nextBotRoomCheckAt = Infinity;
      for (const room of [...this.rooms.values()]) {
        if (!room.botManaged) continue;
        room.botRetiring = true;
        if (this._destroyBotRoomIfHumanless(room, now)) continue;
        this._broadcastRoomState(room);
      }
    }
    return this.botRoomsEnabled;
  }

  _isPublicJoinableRoom(room) {
    return room.roomType === ROOM_TYPES.PUBLIC
      && room.state === ROOM_STATES.WAITING
      && !room.botRetiring
      && hasOnlineMember(room)
      && occupiedMembers(room).length < room.maxPlayers;
  }

  _reconcileBotRooms(now) {
    const joinableRooms = [...this.rooms.values()].filter(
      (room) => this._isPublicJoinableRoom(room),
    );
    const idleBotRooms = [...this.rooms.values()]
      .filter((room) => room.botManaged
        && !room.botRetiring
        && room.state === ROOM_STATES.WAITING
        && !hasLiveHuman(room))
      .sort((a, b) => a.createdAt - b.createdAt);
    const usefulJoinableRoom = joinableRooms.some((room) => !idleBotRooms.includes(room));
    if (usefulJoinableRoom) {
      for (const room of idleBotRooms) this._destroyRoom(room);
      return null;
    }
    if (idleBotRooms.length > 0) {
      for (const room of idleBotRooms.slice(1)) this._destroyRoom(room);
      return idleBotRooms[0];
    }
    return this._createBotRoom(now);
  }

  _createBotRoom(now = this.now()) {
    const roomCode = this._allocateRoomCode();
    const setupSeed = this.seedFactory() >>> 0;
    const setupRng = deriveRng(setupSeed, `bot-room:${roomCode}`);
    const tracks = [...this.tracks.values()];
    const track = tracks[setupRng.int(0, Math.max(0, tracks.length - 1))];
    const character = this.playableCharacters[
      setupRng.int(0, Math.max(0, this.playableCharacters.length - 1))
    ];
    if (!track || !character) {
      throw new GameError(ERROR_CODES.INTERNAL_ERROR, 'Bot room setup is unavailable.');
    }
    const defaults = defaultLoadoutForCharacter(character.id);
    const appearance = pickDistinctAppearance(setupRng, [], this.paints, this.avatars);
    const participantId = `bot-${roomCode.toLowerCase()}`;
    const bot = {
      userId: null,
      participantId,
      resumeToken: null,
      displayName: BOT_HOST_NAME,
      characterId: character.id,
      paintId: appearance.paintId || defaults.paintId,
      avatarId: appearance.avatarId || defaults.avatarId,
      isBot: true,
      ready: true,
      connected: true,
      abandoned: false,
      resultLocked: false,
      resumeExpired: false,
      disconnectedAt: null,
      resumeExpiresAt: null,
      joinOrder: this._joinOrder++,
      raceLoaded: true,
      kartIndex: null,
      controllerKind: CONTROLLER_KINDS.AI,
      lastInputSeq: -1,
      lastUseItemSeq: 0,
      lastAppliedSeq: -1,
      awaitingFreshInput: false,
      pendingUseItems: 0,
      lastInput: { ...DEFAULT_ZERO_INPUT },
      lastInputAt: now,
      lastChatAt: -Infinity,
      postRaceState: null,
    };
    const room = {
      code: roomCode,
      roomName: BOT_ROOM_NAME,
      roomType: ROOM_TYPES.PUBLIC,
      maxPlayers: this.maxPlayers,
      state: ROOM_STATES.WAITING,
      hostParticipantId: participantId,
      settings: { trackId: track.id, difficulty: 'normal', autoFillAi: false },
      members: new Map([[participantId, bot]]),
      race: null,
      lastRaceId: null,
      lastWireRaceId: null,
      createdAt: now,
      emptySince: null,
      botManaged: true,
      botRetiring: false,
      botDestroyWhenHumanless: false,
      botLastMapChangeAt: -Infinity,
    };
    this.rooms.set(roomCode, room);
    this._broadcastRoomState(room);
    return room;
  }

  _botTrackEntries() {
    return [...this.tracks.values()].map((track, index) => ({
      number: index + 1,
      id: track.id,
      name: track.name,
    }));
  }

  _botChatMessage(room, { key, args = {}, content }) {
    const bot = botMemberOf(room);
    return serverMessage(SERVER_MESSAGE_TYPES.ROOM_CHAT, {
      roomCode: room.code,
      participantId: bot?.participantId ?? room.hostParticipantId,
      displayName: bot?.displayName ?? BOT_HOST_NAME,
      sentAt: this.wallClock(),
      content,
      isBot: true,
      botMessageKey: key,
      botMessageArgs: args,
    });
  }

  _sendBotChat(room, payload) {
    const message = this._botChatMessage(room, payload);
    this._emitToRoom(room, message);
    return message;
  }

  _botHelpPayload(room, { concise = false } = {}) {
    const tracks = this._botTrackEntries();
    const current = tracks.find((track) => track.id === room.settings.trackId) ?? tracks[0];
    if (concise) {
      return {
        key: 'helpShort',
        args: {},
        content: '可用指令：/h 帮助、/m <数字> 修改地图、/s 开始比赛。',
      };
    }
    const mapList = tracks.map((track) => `${track.number}=${track.name}`).join('，');
    return {
      key: 'help',
      args: {
        currentMapNumber: current?.number ?? 1,
        currentMapName: current?.name ?? '',
        maps: tracks,
      },
      content: `指令：/h 帮助、/m <数字> 修改地图、/s 开始比赛。地图：${mapList}。当前地图：${current?.number ?? 1}=${current?.name ?? ''}。`,
    };
  }

  _handleBotCommand(room, command, now) {
    if (!command) return null;
    if (command.kind === 'help') return this._sendBotChat(room, this._botHelpPayload(room));
    if (command.kind === 'unknown') {
      return this._sendBotChat(room, this._botHelpPayload(room, { concise: true }));
    }
    if (command.kind === 'map') {
      const [rawNumber] = command.args;
      const tracks = this._botTrackEntries();
      if (command.args.length !== 1 || !/^\d+$/u.test(rawNumber || '')) {
        return this._sendBotChat(room, {
          key: 'mapInvalid',
          args: { min: 1, max: tracks.length },
          content: `地图编号无效，请输入 1-${tracks.length} 的单个数字。`,
        });
      }
      const selected = tracks[Number(rawNumber) - 1];
      if (!selected) {
        return this._sendBotChat(room, {
          key: 'mapInvalid',
          args: { min: 1, max: tracks.length },
          content: `地图编号无效，请输入 1-${tracks.length} 的单个数字。`,
        });
      }
      if (room.state !== ROOM_STATES.WAITING) {
        return this._sendBotChat(room, {
          key: 'mapUnavailable',
          args: {},
          content: '当前无法修改地图。',
        });
      }
      if (room.settings.trackId === selected.id) {
        return this._sendBotChat(room, {
          key: 'mapUnchanged',
          args: { mapNumber: selected.number, mapName: selected.name },
          content: `当前已经是地图 ${selected.number}：${selected.name}。`,
        });
      }
      const remainingMs = room.botLastMapChangeAt + this.botMapChangeCooldownMs - now;
      if (remainingMs > 0) {
        const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
        return this._sendBotChat(room, {
          key: 'mapCooldown',
          args: { seconds },
          content: `地图修改冷却中，请等待 ${seconds} 秒。`,
        });
      }
      this._setRoomSettings(room, { trackId: selected.id });
      room.botLastMapChangeAt = now;
      return this._sendBotChat(room, {
        key: 'mapChanged',
        args: { mapNumber: selected.number, mapName: selected.name },
        content: `地图已修改为 ${selected.number}：${selected.name}。请重新准备。`,
      });
    }
    if (command.kind === 'start') {
      if (!this._canStart(room)) {
        return this._sendBotChat(room, {
          key: 'waitReady',
          args: {},
          content: '请等待所有人准备',
        });
      }
      this._startRace(room);
    }
    return null;
  }

  _destroyBotRoomIfHumanless(room, now = this.now()) {
    if (!room.botManaged || hasLiveHuman(room)) return false;
    if (room.state === ROOM_STATES.WAITING
      && !room.botRetiring
      && !room.botDestroyWhenHumanless) return false;
    if (room.race?.simulation
      && [ROOM_STATES.COUNTDOWN, ROOM_STATES.RACING].includes(room.state)) {
      this._finishRace(room, now);
    }
    this._destroyRoom(room);
    return true;
  }

  async createRoom(options = {}) {
    const userId = options.userId ?? null;
    const displayName = requireValid(validateDisplayName(options.displayName));
    const characterId = options.characterId;
    const paintId = options.paintId;
    const avatarId = options.avatarId;
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
    let passwordVerifier = null;
    if (roomType === ROOM_TYPES.PRIVATE) {
      const salt = this.passwordSaltFactory();
      passwordVerifier = { salt, hash: await this._runScrypt(password, salt) };
    }
    const now = this.now();
    const roomCode = this._allocateRoomCode();
    const defaultTrack = this.tracks.values().next().value;
    const track = options.trackId === undefined ? defaultTrack : this.tracks.get(options.trackId);
    if (!track) throw new GameError(ERROR_CODES.INVALID_SETTING, 'Choose a valid track.');
    const room = {
      code: roomCode,
      roomName,
      roomType,
      maxPlayers,
      state: ROOM_STATES.WAITING,
      hostParticipantId: null,
      settings: { trackId: track.id, difficulty: 'normal', autoFillAi: false },
      members: new Map(),
      race: null,
      lastRaceId: null,
      lastWireRaceId: null,
      createdAt: now,
      emptySince: null,
      botManaged: false,
      botRetiring: false,
      botDestroyWhenHumanless: false,
      botLastMapChangeAt: -Infinity,
    };
    if (passwordVerifier) this._passwordVerifiers.set(room, passwordVerifier);
    this.rooms.set(roomCode, room);
    let session;
    try {
      session = this._addParticipant(room, {
        userId, displayName, characterId, paintId, avatarId,
      }, now);
    } catch (error) {
      this.rooms.delete(roomCode);
      throw error;
    }
    room.hostParticipantId = session.participantId;
    this._broadcastRoomState(room);
    return { ...session, roomCode, roomState: this.getRoomState(roomCode) };
  }

  async joinRoom(roomCode, {
    userId = null, displayName, characterId, paintId, avatarId, password,
  } = {}) {
    const room = this._requireRoom(roomCode);
    if (room.state !== ROOM_STATES.WAITING) {
      throw new GameError(ERROR_CODES.ROOM_LOCKED, 'This race has already started.');
    }
    if (occupiedMembers(room).length >= room.maxPlayers) {
      throw new GameError(ERROR_CODES.ROOM_FULL, 'This room is full.');
    }
    await this._verifyPassword(room, password);
    if (this.rooms.get(room.code) !== room) {
      throw new GameError(ERROR_CODES.ROOM_NOT_FOUND, 'Room not found.');
    }
    if (room.state !== ROOM_STATES.WAITING) {
      throw new GameError(ERROR_CODES.ROOM_LOCKED, 'This race has already started.');
    }
    if (occupiedMembers(room).length >= room.maxPlayers) {
      throw new GameError(ERROR_CODES.ROOM_FULL, 'This room is full.');
    }
    const session = this._addParticipant(room, {
      userId, displayName, characterId, paintId, avatarId,
    }, this.now());
    if (room.botManaged) room.botDestroyWhenHumanless = false;
    if (!room.hostParticipantId) this._migrateHost(room);
    this._broadcastRoomState(room);
    const roomState = this.getRoomState(room.code);
    if (!room.botManaged) return { ...session, roomCode: room.code, roomState };
    const joinedMember = room.members.get(session.participantId);
    const welcome = this._botChatMessage(room, {
      key: 'welcome',
      args: { displayName: joinedMember?.displayName ?? displayName },
      content: `欢迎 ${joinedMember?.displayName ?? displayName} 加入房间！发送 /h 查看指令。`,
    });
    this._emitToRoom(room, welcome);
    return {
      ...session,
      roomCode: room.code,
      roomState,
      messages: [roomState, welcome],
    };
  }

  async quickMatch({ userId = null, displayName, characterId, paintId, avatarId } = {}) {
    displayName = requireValid(validateDisplayName(displayName));
    const candidates = [...this.rooms.values()].map((room) => ({
      room,
      playerCount: occupiedMembers(room).length,
    })).filter(({ room, playerCount }) => (
      room.roomType === ROOM_TYPES.PUBLIC
      && room.state === ROOM_STATES.WAITING
      && hasOnlineMember(room)
      && playerCount < room.maxPlayers
    ));
    if (candidates.length === 0) {
      throw new GameError(
        ERROR_CODES.NO_MATCHING_ROOM,
        'No joinable public room is available.',
      );
    }
    const highestPlayerCount = Math.max(...candidates.map(({ playerCount }) => playerCount));
    const preferredCandidates = candidates.filter(
      ({ playerCount }) => playerCount === highestPlayerCount,
    );
    const index = Math.min(
      preferredCandidates.length - 1,
      Math.max(0, Math.floor(this.random() * preferredCandidates.length)),
    );
    return await this.joinRoom(preferredCandidates[index].room.code, {
      userId, displayName, characterId, paintId, avatarId,
    });
  }

  resume(roomCode, participantId, resumeToken, userId = null) {
    const room = this._requireRoom(roomCode, ERROR_CODES.SESSION_NOT_FOUND);
    const member = room.members.get(participantId);
    if (!member || member.resumeToken !== resumeToken
      || (userId && member.userId !== userId)
      || (member.abandoned && !member.resumeExpired)) {
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
    if (room.botManaged) room.botDestroyWhenHumanless = false;
    room.emptySince = null;
    if (room.race?.simulation && member.kartIndex !== null) {
      // A resumed transport is not proof that the driver has fresh control.
      // Keep takeover AI active until a newer movement sequence arrives.
      member.awaitingFreshInput = true;
      this._setController(room, member, CONTROLLER_KINDS.TAKEOVER_AI, true);
    }
    if (!room.hostParticipantId) this._migrateHost(room);
    // Let the WebSocket gateway bind the resumed connection before a delayed
    // settlement emits the private progression message for this participant.
    queueMicrotask(() => this._resolvePendingParticipant(participantId, false, now));
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
    member.resultLocked = member.resultLocked || this._memberNaturallyFinished(room, member);
    member.connected = false;
    member.resumeExpired = false;
    member.disconnectedAt = now;
    member.resumeExpiresAt = now + this.resumeTimeoutMs;
    if (room.race?.simulation && member.kartIndex !== null) {
      member.awaitingFreshInput = true;
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
      const now = this.now();
      member.resultLocked = member.resultLocked || this._memberNaturallyFinished(room, member);
      member.abandoned = true;
      member.resumeExpired = false;
      member.connected = false;
      member.resumeExpiresAt = null;
      // Explicit leaves cannot resume. Keep the member only for this race's
      // standings/settlement, while releasing the account for another room.
      this._releaseUserParticipant(member);
      if (room.race?.simulation && member.kartIndex !== null) {
        this._setController(room, member, CONTROLLER_KINDS.TAKEOVER_AI);
      }
      if (room.hostParticipantId === participantId) this._migrateHost(room);
      this._resolvePendingParticipant(participantId, !member.resultLocked, now);
      if (room.botManaged && !hasLiveHuman(room)) {
        if (room.state !== ROOM_STATES.RESULTS && room.race?.simulation) {
          this._finishRace(room, now);
        }
        this._destroyRoom(room);
        return;
      }
      if (!room.botManaged && occupiedMembers(room).length === 0
        && [ROOM_STATES.COUNTDOWN, ROOM_STATES.RACING, ROOM_STATES.RESULTS]
          .includes(room.state)) {
        if (room.state !== ROOM_STATES.RESULTS) this._finishRace(room, now);
        this._destroyRoom(room);
        return;
      }
    }
    if (this._destroyBotRoomIfHumanless(room, this.now())) return;
    if (![...room.members.values()].some((candidate) => candidate.connected)) room.emptySince = this.now();
    if (this._maybeReturnRoom(room)) return;
    this._broadcastRoomState(room);
  }

  selectCharacter(participantId, characterId) {
    return this.setLoadout(participantId, { characterId });
  }

  setLoadout(participantId, { characterId, paintId, avatarId } = {}) {
    const { room, member } = this._findParticipant(participantId);
    this._requireMemberRoom(room, member);
    const nextCharacterId = characterId ?? member.characterId;
    const nextPaintId = paintId ?? member.paintId;
    const nextAvatarId = avatarId ?? member.avatarId;
    if (!this.characterIds.has(nextCharacterId)) {
      throw new GameError(ERROR_CODES.CHARACTER_INVALID, 'That character does not exist.');
    }
    if (!this.playableCharacterIds.has(nextCharacterId)) {
      throw new GameError(ERROR_CODES.CHARACTER_LOCKED, 'That Racer is not unlocked yet.');
    }
    if (!this.paintIds.has(nextPaintId)) {
      throw new GameError(ERROR_CODES.PAINT_INVALID, 'That paint does not exist.');
    }
    if (!this.avatarIds.has(nextAvatarId)) {
      throw new GameError(ERROR_CODES.AVATAR_INVALID, 'That avatar does not exist.');
    }
    if (member.characterId !== nextCharacterId
      || member.paintId !== nextPaintId
      || member.avatarId !== nextAvatarId) {
      member.characterId = nextCharacterId;
      member.paintId = nextPaintId;
      member.avatarId = nextAvatarId;
      member.ready = false;
      this._broadcastRoomState(room);
    }
    return this.getRoomState(room.code);
  }

  setRoom(participantId, patch) {
    const { room, member } = this._findParticipant(participantId);
    this._requireMemberRoom(room, member);
    this._requireHost(room, participantId);
    return this._setRoomSettings(room, patch);
  }

  _setRoomSettings(room, patch) {
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
    if (patch.autoFillAi !== undefined) {
      if (typeof patch.autoFillAi !== 'boolean') {
        throw new GameError(ERROR_CODES.INVALID_SETTING, 'AI auto-fill must be enabled or disabled.');
      }
      if (room.settings.autoFillAi !== patch.autoFillAi) {
        room.settings.autoFillAi = patch.autoFillAi;
        changed = true;
      }
    }
    if (changed) {
      for (const member of room.members.values()) member.ready = Boolean(member.isBot);
      this._broadcastRoomState(room);
    }
    return this.getRoomState(room.code);
  }

  kickPlayer(participantId, targetParticipantId) {
    const { room } = this._findParticipant(participantId);
    this._requireWaiting(room);
    this._requireHost(room, participantId);
    if (participantId === targetParticipantId) {
      throw new GameError(ERROR_CODES.FORBIDDEN, 'The room host cannot kick themselves.');
    }
    const target = room.members.get(targetParticipantId);
    if (!target || target.abandoned) {
      throw new GameError(ERROR_CODES.NOT_IN_ROOM, 'That player is no longer in the room.');
    }
    const event = {
      roomCode: room.code,
      roomName: room.roomName,
      participantId: target.participantId,
      displayName: target.displayName,
    };
    this._removeParticipant(room, target);
    this.emit('participantKicked', event);
    this._broadcastRoomState(room);
    return event;
  }

  setReady(participantId, ready) {
    const { room, member } = this._findParticipant(participantId);
    this._requireMemberRoom(room, member);
    member.ready = Boolean(ready);
    this._broadcastRoomState(room);
    return this.getRoomState(room.code);
  }

  sendChat(participantId, content) {
    const { room, member } = this._findParticipant(participantId);
    this._requireChatRoom(room, member);
    const now = this.now();
    if (now - member.lastChatAt < CHAT_SEND_INTERVAL_MS) {
      throw new GameError(
        ERROR_CODES.CHAT_RATE_LIMITED,
        'Chat messages must be at least 3 seconds apart.',
      );
    }
    const validatedContent = requireValid(validateChatContent(content));
    const message = serverMessage(SERVER_MESSAGE_TYPES.ROOM_CHAT, {
      roomCode: room.code,
      participantId: member.participantId,
      displayName: member.displayName,
      sentAt: this.wallClock(),
      content: validatedContent,
      isBot: false,
    });
    member.lastChatAt = now;
    this._emitToRoom(room, message);
    if (room.botManaged && !member.isBot) {
      this._handleBotCommand(room, normalizeBotCommandText(validatedContent), now);
    }
    return message;
  }

  startRace(participantId) {
    const { room, member } = this._findParticipant(participantId);
    this._requireWaiting(room);
    if (room.botManaged) {
      if (member.isBot) throw new GameError(ERROR_CODES.FORBIDDEN, 'A human player must start the race.');
    } else {
      this._requireHost(room, participantId);
    }
    const members = [...room.members.values()].filter((member) => !member.abandoned);
    const humans = members.filter((candidate) => !candidate.isBot);
    const connected = humans.filter((candidate) => candidate.connected);
    const minimumHumans = room.botManaged ? 1 : 2;
    if (connected.length < minimumHumans) {
      throw new GameError(ERROR_CODES.NOT_ENOUGH_PLAYERS, 'At least two connected players are required.');
    }
    if (connected.length !== humans.length || connected.some((candidate) => !candidate.ready)) {
      throw new GameError(ERROR_CODES.NOT_READY, 'Every player must be connected and ready.');
    }

    return this._startRace(room);
  }

  _startRace(room) {
    const members = [...room.members.values()].filter((member) => !member.abandoned);
    room.botDestroyWhenHumanless = false;
    const now = this.now();
    const seed = this.seedFactory() >>> 0;
    const raceId = this.raceIdFactory();
    const wireRaceId = Number(this.wireRaceIdFactory()) >>> 0;
    if (wireRaceId === 0) {
      throw new GameError(ERROR_CODES.INTERNAL_ERROR, 'Could not allocate a binary race id.');
    }
    const roster = this._buildRoster(room, seed);
    for (const member of members) {
      member.postRaceState = null;
      member.resultLocked = false;
      member.raceLoaded = Boolean(member.isBot);
      member.kartIndex = roster.find((entry) => entry.participantId === member.participantId)?.kartIndex ?? null;
      member.controllerKind = member.isBot ? CONTROLLER_KINDS.AI : CONTROLLER_KINDS.TAKEOVER_AI;
      member.awaitingFreshInput = !member.isBot;
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
      wireRaceId,
      seed,
      roster,
      rosterByKartIndex: new Map(roster.map((entry) => [entry.kartIndex, entry])),
      rosterByParticipantId: new Map(roster.map((entry) => [entry.participantId, entry])),
      ackMembers: roster
        .filter((entry) => {
          const member = room.members.get(entry.participantId);
          return Boolean(member && !member.isBot);
        })
        .sort((a, b) => a.kartIndex - b.kartIndex),
      ackEntries: [],
      firstInputs: new Array(roster.length).fill(null),
      secondInputs: new Array(roster.length).fill(null),
      inputPairs: Array.from({ length: roster.length }, () => ([
        { ...DEFAULT_ZERO_INPUT, useItem: false },
        { ...DEFAULT_ZERO_INPUT, useItem: false },
      ])),
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
      snapshotWriter: new BinaryPacketWriter(),
      snapshotSource: {
        wireRaceId,
        tick: 0,
        serverTime: now,
        state: ROOM_STATES.COUNTDOWN,
        countdown: null,
        elapsed: 0,
        laps: track.laps ?? 3,
        karts: [],
        controllerKinds: [],
        projectiles: [],
        hazards: [],
        itemBoxes: [],
        acks: [],
      },
    };
    room.race.ackEntries = room.race.ackMembers.map((entry) => [entry.kartIndex, -1, 0]);
    room.race.snapshotSource.acks = room.race.ackEntries;
    this._emitToRoom(room, serverMessage(SERVER_MESSAGE_TYPES.PREPARE_RACE, {
      raceId,
      wireRaceId,
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
    const phase = room.state;
    if (!room.race
      || room.race.raceId !== raceId
      || ![ROOM_STATES.LOADING, ROOM_STATES.COUNTDOWN, ROOM_STATES.RACING].includes(phase)) {
      throw new GameError(ERROR_CODES.RACE_MISMATCH, 'That race cannot accept loading now.');
    }
    const wasLoaded = member.raceLoaded;
    member.raceLoaded = true;
    const late = phase !== ROOM_STATES.LOADING;
    if (!wasLoaded && late) {
      member.awaitingFreshInput = true;
      this._setController(room, member, CONTROLLER_KINDS.TAKEOVER_AI, true);
    }
    this._emitToParticipant(member.participantId, this._raceLoadedAck(room, late));
    this._broadcastRoomState(room);
    if (phase !== ROOM_STATES.LOADING) return;
    const active = humanMembers(room).filter((candidate) => candidate.connected);
    const minimumHumans = room.botManaged ? 1 : 2;
    if (active.length >= minimumHumans && active.every((candidate) => candidate.raceLoaded)) {
      await this._beginRace(room, this.now());
    }
  }

  handleInput(participantId, input) {
    const { room, member } = this._findParticipant(participantId);
    if (!room.race) {
      if (input.wireRaceId === room.lastWireRaceId) return false;
      throw new GameError(ERROR_CODES.RACE_MISMATCH, 'That input belongs to a different race.');
    }
    if (input.wireRaceId !== room.race.wireRaceId) {
      throw new GameError(ERROR_CODES.RACE_MISMATCH, 'That input belongs to a different race.');
    }
    if (!room.race.simulation
      || ![ROOM_STATES.COUNTDOWN, ROOM_STATES.RACING].includes(room.state)) return false;
    if (!member.connected || member.abandoned || !member.raceLoaded) {
      throw new GameError(ERROR_CODES.FORBIDDEN, 'This participant is not controlling a kart.');
    }

    let accepted = false;
    const movementAccepted = input.seq > member.lastInputSeq;
    if (movementAccepted) {
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
    if (input.useItemSeq > member.lastUseItemSeq) {
      const delta = input.useItemSeq - member.lastUseItemSeq;
      member.lastUseItemSeq = input.useItemSeq;
      // An item-only packet cannot reclaim a takeover seat or leave an action
      // queued to fire later. A fresh movement sequence in the same packet can.
      if (member.controllerKind !== CONTROLLER_KINDS.TAKEOVER_AI || movementAccepted) {
        member.pendingUseItems = Math.min(8, member.pendingUseItems + Math.min(delta, 8));
      }
      accepted = true;
    }
    if (movementAccepted) {
      member.lastInputAt = this.now();
      member.awaitingFreshInput = false;
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
        paintId: member.paintId,
        avatarId: member.avatarId,
        isBot: Boolean(member.isBot),
        isHost: member.participantId === room.hostParticipantId,
        ready: member.ready,
        connected: member.connected,
        presenceState: presenceStateOf(member),
        postRaceState: member.postRaceState,
        activityState: room.state === ROOM_STATES.RESULTS
          && member.postRaceState !== POST_RACE_STATES.ROOM
          ? 'in_game'
          : 'room',
        loaded: [ROOM_STATES.LOADING, ROOM_STATES.COUNTDOWN, ROOM_STATES.RACING].includes(room.state)
          ? member.raceLoaded
          : undefined,
        controllerKind: member.controllerKind,
      }));
    return serverMessage(SERVER_MESSAGE_TYPES.ROOM_STATE, {
      roomCode: room.code,
      roomName: room.roomName,
      roomType: room.roomType,
      botManaged: Boolean(room.botManaged),
      maxPlayers: room.maxPlayers,
      state: room.state,
      hostParticipantId: room.hostParticipantId,
      settings: {
        trackId: room.settings.trackId,
        difficulty: room.settings.difficulty,
        autoFillAi: room.settings.autoFillAi,
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
        wireRaceId: room.race.wireRaceId,
        seed: room.race.seed,
        trackId: room.race.trackId,
        difficulty: room.race.difficulty,
        laps: room.race.laps,
        roster: publicRoster(room.race.roster),
        resumed: true,
      }));
      if (member.raceLoaded) messages.push(this._raceLoadedAck(
        room,
        room.state !== ROOM_STATES.LOADING,
      ));
      if (room.race.simulation) messages.push(this._snapshotFor(room));
      if (room.state === ROOM_STATES.RESULTS && room.race.results) {
        messages.push(serverMessage(SERVER_MESSAGE_TYPES.RACE_RESULTS, {
          raceId: room.race.raceId,
          results: room.race.results,
        }));
      }
    }
    return messages;
  }

  tick(now = this.now()) {
    let catchUpSteps = 0;
    let catchUpCapped = 0;
    let roomErrors = 0;
    for (const room of [...this.activeRaceRooms]) {
      if (!this.rooms.has(room.code) || !room.race?.simulation
        || ![ROOM_STATES.COUNTDOWN, ROOM_STATES.RACING].includes(room.state)) {
        this.activeRaceRooms.delete(room);
        continue;
      }
      try {
        const advanced = this._advanceRace(room, now);
        catchUpSteps += advanced.steps;
        if (advanced.capped) catchUpCapped++;
      } catch (error) {
        roomErrors++;
        this._isolateRoomError(room, error, now);
      }
    }
    return { catchUpSteps, catchUpCapped, roomErrors };
  }

  maintenance(now = this.now()) {
    for (const room of [...this.rooms.values()]) {
      try {
        if (room.emptySince !== null && now - room.emptySince >= this.emptyRoomTtlMs) {
          // Race starts are persisted immediately, so an expired empty room
          // must settle its active race before the in-memory roster is lost.
          if (room.race?.simulation
            && [ROOM_STATES.COUNTDOWN, ROOM_STATES.RACING].includes(room.state)) {
            this._finishRace(room, now);
          }
          this._destroyRoom(room);
          continue;
        }
        if (room.state === ROOM_STATES.WAITING) {
          this._expireWaitingMembers(room, now);
          if (this._destroyBotRoomIfHumanless(room, now)) continue;
          continue;
        }
        this._expireRaceSessions(room, now);
        if (this._destroyBotRoomIfHumanless(room, now)) continue;
        if (room.state === ROOM_STATES.LOADING) {
          if (now >= room.race.loadingDeadline) this._beginRace(room, now);
          continue;
        }
        if (room.state === ROOM_STATES.RESULTS
          && now - room.race.resultsAt >= this.resultsTimeoutMs) {
          this._returnRoom(room);
        }
      } catch (error) {
        this._isolateRoomError(room, error, now);
      }
    }
    this._settlePendingRaces(now);
    if (this.botRoomsEnabled && now >= this.nextBotRoomCheckAt) {
      try {
        this.reconcileBotRooms(now);
      } catch (error) {
        this.emit('managerError', error);
      }
    }
  }

  setRoomReceiverCountProvider(provider) {
    this.roomReceiverCountProvider = typeof provider === 'function' ? provider : null;
  }

  close() {
    for (const room of [...this.rooms.values()]) this._destroyRoom(room);
    this.pendingSettlements.clear();
    this.userParticipants.clear();
    this.removeAllListeners();
  }

  _addParticipant(room, {
    userId = null, displayName, characterId, paintId, avatarId,
  }, now) {
    if (userId && this.userParticipants.has(userId)) {
      throw new GameError(ERROR_CODES.ALREADY_IN_ROOM, 'This user is already in a room.');
    }
    const validatedName = validateDisplayName(displayName);
    if (!validatedName.ok) {
      throw new GameError(validatedName.error.code, validatedName.error.message);
    }
    displayName = validatedName.value;
    const selectedCharacter = characterId
      ?? (this.playableCharacterIds.has('kit') ? 'kit' : this.playableCharacters[0]?.id);
    if (!this.characterIds.has(selectedCharacter)) {
      throw new GameError(ERROR_CODES.CHARACTER_INVALID, 'That character does not exist.');
    }
    if (!this.playableCharacterIds.has(selectedCharacter)) {
      throw new GameError(ERROR_CODES.CHARACTER_LOCKED, 'That Racer is not unlocked yet.');
    }
    const selectedPaint = paintId ?? DEFAULT_ONLINE_LOADOUT.paintId;
    const selectedAvatar = avatarId ?? DEFAULT_ONLINE_LOADOUT.avatarId;
    if (!this.paintIds.has(selectedPaint)) {
      throw new GameError(ERROR_CODES.PAINT_INVALID, 'That paint does not exist.');
    }
    if (!this.avatarIds.has(selectedAvatar)) {
      throw new GameError(ERROR_CODES.AVATAR_INVALID, 'That avatar does not exist.');
    }
    const participantId = this.participantIdFactory();
    const resumeToken = this.resumeTokenFactory();
    const resolvedUserId = userId || `participant:${participantId}`;
    const member = {
      userId: resolvedUserId,
      participantId,
      resumeToken,
      displayName,
      characterId: selectedCharacter,
      paintId: selectedPaint,
      avatarId: selectedAvatar,
      ready: false,
      connected: true,
      abandoned: false,
      resultLocked: false,
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
      awaitingFreshInput: false,
      pendingUseItems: 0,
      lastInput: { ...DEFAULT_ZERO_INPUT },
      lastInputAt: now,
      lastChatAt: -Infinity,
      postRaceState: null,
    };
    room.members.set(participantId, member);
    this.participantRooms.set(participantId, room.code);
    this.userParticipants.set(resolvedUserId, participantId);
    room.emptySince = null;
    return { participantId, resumeToken };
  }

  _buildRoster(room, seed) {
    const roster = [...room.members.values()]
      .filter((member) => !member.abandoned)
      .map((member) => ({
        userId: member.userId,
        participantId: member.participantId,
        displayName: member.displayName,
        characterId: member.characterId,
        paintId: member.paintId,
        avatarId: member.avatarId,
        ...(member.isBot ? { isBot: true, aiPlayerNumber: 1 } : {}),
        controllerKind: member.isBot ? CONTROLLER_KINDS.AI : CONTROLLER_KINDS.HUMAN,
      }));
    if (room.settings.autoFillAi) {
      const used = new Set(roster.map((entry) => entry.characterId));
      const usedAppearances = new Map();
      for (const entry of roster) {
        const appearances = usedAppearances.get(entry.characterId) || [];
        appearances.push({ paintId: entry.paintId, avatarId: entry.avatarId });
        usedAppearances.set(entry.characterId, appearances);
      }
      const orderedCharacters = [
        ...this.playableCharacters.filter((character) => !used.has(character.id)),
        ...this.playableCharacters.filter((character) => used.has(character.id)),
      ];
      let aiIndex = 0;
      while (roster.length < room.maxPlayers && orderedCharacters.length > 0) {
        const character = orderedCharacters[aiIndex % orderedCharacters.length];
        const defaults = defaultLoadoutForCharacter(character.id);
        const appearanceRng = deriveRng(
          seed, `online-ai-appearance:${roster.length}:${character.id}`,
        );
        const appearances = usedAppearances.get(character.id) || [];
        const appearance = pickDistinctAppearance(
          appearanceRng, appearances, this.paints, this.avatars,
        );
        appearances.push(appearance);
        usedAppearances.set(character.id, appearances);
        roster.push({
          participantId: `ai-${roster.length}-${character.id}`,
          displayName: `AI player ${aiIndex + 1}`,
          aiPlayerNumber: aiIndex + 1,
          characterId: character.id,
          paintId: appearance.paintId || defaults.paintId,
          avatarId: appearance.avatarId || defaults.avatarId,
          controllerKind: CONTROLLER_KINDS.AI,
        });
        used.add(character.id);
        aiIndex += 1;
      }
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
        .filter((member) => !member.isBot
          && member.connected && member.raceLoaded && !member.abandoned);
      const minimumHumans = room.botManaged ? 1 : 2;
      if (activeHumans.length < minimumHumans) {
        this._finalizeRaceMembers(room, { resetReady: true });
        room.state = ROOM_STATES.WAITING;
        room.race = null;
        room.botDestroyWhenHumanless = room.botManaged
          && !hasConnectedHuman(room) && hasLiveHuman(room);
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
      race.analyticsStartedAt = null;
      this.activeRaceRooms.add(room);
      for (const member of room.members.values()) {
        const kind = member.isBot
          ? CONTROLLER_KINDS.AI
          : member.connected && member.raceLoaded && !member.abandoned
            ? CONTROLLER_KINDS.HUMAN
            : CONTROLLER_KINDS.TAKEOVER_AI;
        member.awaitingFreshInput = kind !== CONTROLLER_KINDS.HUMAN;
        if (member.isBot) member.awaitingFreshInput = false;
        else if (kind === CONTROLLER_KINDS.HUMAN) member.lastInputAt = now;
        this._setController(room, member, kind, true);
      }
      if (room.state === ROOM_STATES.RACING) this._recordAnalyticsRaceStart(room, now);
      this._recordRaceStart(room);
      this._broadcastRoomState(room);
    })().catch((error) => {
      if (room.state === ROOM_STATES.LOADING && room.race === race) {
        this.activeRaceRooms.delete(room);
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
    const capped = steps === this.maxCatchUpTicks && race.accumulatorMs >= this.networkStepMs;
    if (steps === this.maxCatchUpTicks) {
      race.accumulatorMs = Math.min(race.accumulatorMs, this.networkStepMs);
    }
    return { steps, capped };
  }

  _networkTick(room, now) {
    const race = room.race;
    const { firstInputs, secondInputs, inputPairs } = race;
    firstInputs.fill(null);
    secondInputs.fill(null);
    for (const member of room.members.values()) {
      if (member.kartIndex === null) continue;
      if (member.isBot) {
        this._setController(room, member, CONTROLLER_KINDS.AI);
        continue;
      }
      const timedOut = now - member.lastInputAt > this.inputTimeoutMs;
      if (timedOut) member.awaitingFreshInput = true;
      const human = member.connected
        && member.raceLoaded
        && !member.abandoned
        && !member.awaitingFreshInput
        && !timedOut;
      this._setController(room, member, human ? CONTROLLER_KINDS.HUMAN : CONTROLLER_KINDS.TAKEOVER_AI);
      if (!human) continue;
      const useItem = member.pendingUseItems > 0;
      const [firstInput, secondInput] = inputPairs[member.kartIndex];
      Object.assign(firstInput, member.lastInput, { useItem });
      Object.assign(secondInput, member.lastInput, { useItem: false });
      firstInputs[member.kartIndex] = firstInput;
      secondInputs[member.kartIndex] = secondInput;
      if (useItem) member.pendingUseItems--;
      member.lastAppliedSeq = member.lastInputSeq;
    }

    race.simulation.update(1 / 120, firstInputs);
    race.simulation.update(1 / 120, secondInputs);
    race.tick++;
    this._drainRaceEvents(room);

    const simulationState = race.simulation.state;
    if (simulationState === ROOM_STATES.RACING && room.state === ROOM_STATES.COUNTDOWN) {
      room.state = ROOM_STATES.RACING;
      this._recordAnalyticsRaceStart(room, now);
      this._broadcastRoomState(room);
    }
    if (simulationState === ROOM_STATES.RESULTS || race.simulation.isRaceOver) {
      this._finishRace(room, now);
      return;
    }
    if (race.tick % this.snapshotEveryTicks === 0) this._broadcastSnapshots(room);
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
    if (this.roomReceiverCountProvider
      && this.roomReceiverCountProvider(room.code) <= 0) {
      this.metrics?.increment('snapshot', 'noReceiversSkipped');
      return false;
    }
    this._emitToRoom(room, this._snapshotFor(room));
    return true;
  }

  _snapshotFor(room) {
    const startedAt = performance.now();
    try {
      const source = prepareBinarySnapshotSource(room, this.now());
      const binaryData = encodeSnapshotPacket(source, room.race.snapshotWriter);
      const durationMs = performance.now() - startedAt;
      this.metrics?.recordSnapshotEncoding?.({ bytes: binaryData.byteLength, durationMs });
      return {
        v: PROTOCOL_VERSION,
        type: SERVER_MESSAGE_TYPES.SNAPSHOT,
        raceId: room.race.raceId,
        wireRaceId: room.race.wireRaceId,
        tick: room.race.tick,
        binaryData,
      };
    } catch (error) {
      this.metrics?.recordCodecError?.({
        kind: error instanceof RaceCodecError ? error.code : 'snapshot_encode_failed',
        oversized: error instanceof RaceCodecError && error.code === 'packet_too_large',
      });
      throw error;
    }
  }

  _raceLoadedAck(room, late = room.state !== ROOM_STATES.LOADING) {
    return serverMessage(SERVER_MESSAGE_TYPES.RACE_LOADED_ACK, {
      raceId: room.race.raceId,
      phase: room.state,
      late: Boolean(late),
    });
  }

  _finishRace(room, now) {
    if (room.state === ROOM_STATES.RESULTS) return;
    this.activeRaceRooms.delete(room);
    room.state = ROOM_STATES.RESULTS;
    room.race.resultsAt = now;
    this._recordAnalyticsRaceFinish(room, now);
    room.race.results = defaultRaceResults(room);
    const settlement = this._createRaceSettlement(room);
    if (settlement) this.pendingSettlements.set(settlement.raceId, settlement);
    for (const member of room.members.values()) {
      member.ready = Boolean(member.isBot);
      member.postRaceState = member.isBot
        ? POST_RACE_STATES.ROOM
        : member.abandoned ? null : POST_RACE_STATES.RESULTS;
    }
    this._broadcastSnapshots(room);
    this._emitToRoom(room, serverMessage(SERVER_MESSAGE_TYPES.RACE_RESULTS, {
      raceId: room.race.raceId,
      results: room.race.results,
      progressionPending: Boolean(settlement),
    }));
    this._broadcastRoomState(room);
    if (settlement) this._trySettleRace(settlement, now);
  }

  _recordAnalyticsRaceStart(room, now) {
    if (!this.siteAnalytics || room.race.analyticsStartedAt !== null) return false;
    room.race.analyticsStartedAt = now;
    const humanCount = room.race.roster.filter((entry) => entry.aiPlayerNumber == null).length;
    try {
      this.siteAnalytics.recordRaceStart({ raceId: room.race.raceId, humanCount });
      return true;
    } catch (error) {
      this.emit('managerError', error);
      return false;
    }
  }

  _recordAnalyticsRaceFinish(room, now) {
    if (!this.siteAnalytics || room.race.analyticsStartedAt === null) return false;
    try {
      this.siteAnalytics.recordRaceFinish({
        raceId: room.race.raceId,
        durationMs: Math.max(0, Math.round(now - room.race.analyticsStartedAt)),
      });
      return true;
    } catch (error) {
      this.emit('managerError', error);
      return false;
    }
  }

  _recordRaceStart(room) {
    if (typeof this.userStore?.startRace !== 'function') return false;
    const participants = room.race.roster.flatMap((entry) => {
      const member = room.members.get(entry.participantId);
      return member?.userId && entry.aiPlayerNumber == null
        ? [{ userId: member.userId, participantId: member.participantId }]
        : [];
    });
    try {
      this.userStore.startRace({
        raceId: room.race.raceId,
        trackId: room.race.trackId,
        roomType: room.roomType,
        participants,
      });
      return true;
    } catch (error) {
      this.metrics?.increment?.('user', 'startErrors');
      this.emit('managerError', error);
      return false;
    }
  }

  _createRaceSettlement(room) {
    if (!this.userStore) return null;
    const resultsByParticipant = new Map(room.race.results
      .filter((result) => result.participantId)
      .map((result) => [result.participantId, result]));
    const participants = [];
    const pending = new Map();
    for (const rosterEntry of room.race.roster) {
      const member = room.members.get(rosterEntry.participantId);
      if (!member?.userId || rosterEntry.aiPlayerNumber != null) continue;
      const result = resultsByParticipant.get(member.participantId);
      if (!result) continue;
      const participant = {
        userId: member.userId,
        participantId: member.participantId,
        officialRank: result.rank,
        kartIndex: result.kartIndex,
        completed: Boolean(result.completed),
        finishTimeMs: result.completed && Number.isFinite(result.finishTime)
          ? Math.round(result.finishTime * 1000)
          : null,
        escaped: Boolean(member.abandoned && !member.resultLocked),
      };
      if (!participant.escaped && !member.resultLocked
        && !member.connected && member.resumeExpiresAt !== null) {
        pending.set(member.participantId, member.resumeExpiresAt);
      }
      participants.push(participant);
    }
    return {
      raceId: room.race.raceId,
      trackId: room.race.trackId,
      roomType: room.roomType,
      participants,
      pending,
      settlementAttempts: 0,
      settlementNextAttemptAt: 0,
    };
  }

  _resolvePendingParticipant(participantId, escaped, now = this.now()) {
    for (const settlement of this.pendingSettlements.values()) {
      if (!settlement.pending.has(participantId)) continue;
      settlement.pending.delete(participantId);
      const participant = settlement.participants.find(
        (candidate) => candidate.participantId === participantId,
      );
      if (participant) participant.escaped = Boolean(escaped);
      this._trySettleRace(settlement, now);
    }
  }

  _settlePendingRaces(now = this.now()) {
    for (const settlement of [...this.pendingSettlements.values()]) {
      this._trySettleRace(settlement, now);
    }
  }

  _trySettleRace(settlement, now = this.now()) {
    if (now < settlement.settlementNextAttemptAt) return false;
    for (const [participantId, deadline] of [...settlement.pending]) {
      if (now <= deadline) continue;
      settlement.pending.delete(participantId);
      const participant = settlement.participants.find(
        (candidate) => candidate.participantId === participantId,
      );
      if (participant) participant.escaped = true;
    }
    if (settlement.pending.size > 0) return false;
    try {
      const updates = this.userStore.settleRace(settlement);
      this.pendingSettlements.delete(settlement.raceId);
      for (const participant of settlement.participants) {
        const update = updates.get(participant.userId);
        if (!update) continue;
        this._emitToParticipant(participant.participantId, serverMessage(
          SERVER_MESSAGE_TYPES.USER_PROGRESSION,
          { raceId: settlement.raceId, status: 'ok', ...update },
        ));
      }
    } catch (error) {
      settlement.settlementAttempts++;
      this.metrics?.increment?.('user', 'settlementErrors');
      this.emit('managerError', error);
      const retryDelay = this.settlementRetryDelaysMs[settlement.settlementAttempts - 1];
      if (retryDelay !== undefined) {
        settlement.settlementNextAttemptAt = now + retryDelay;
        this.metrics?.increment?.('user', 'settlementRetries');
        return false;
      }
      this.pendingSettlements.delete(settlement.raceId);
      for (const participant of settlement.participants) {
        this._emitToParticipant(participant.participantId, serverMessage(
          SERVER_MESSAGE_TYPES.USER_PROGRESSION,
          { raceId: settlement.raceId, status: 'error' },
        ));
      }
    }
    return true;
  }

  _returnRoom(room) {
    this.activeRaceRooms.delete(room);
    room.race?.simulation?.dispose?.();
    room.lastRaceId = room.race?.raceId ?? room.lastRaceId;
    room.lastWireRaceId = room.race?.wireRaceId ?? room.lastWireRaceId;
    this._finalizeRaceMembers(room);
    room.race = null;
    room.state = ROOM_STATES.WAITING;
    room.botDestroyWhenHumanless = room.botManaged
      && !hasConnectedHuman(room) && hasLiveHuman(room);
    this._migrateHost(room);
    if (this._destroyBotRoomIfHumanless(room, this.now())) return;
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
      if (resetReady || member.isBot) member.ready = Boolean(member.isBot);
      member.raceLoaded = Boolean(member.isBot);
      member.kartIndex = null;
      member.controllerKind = member.isBot ? CONTROLLER_KINDS.AI : CONTROLLER_KINDS.HUMAN;
      member.awaitingFreshInput = false;
      member.pendingUseItems = 0;
      member.postRaceState = null;
      member.resultLocked = false;
    }
    this._migrateHost(room);
  }

  _maybeReturnRoom(room) {
    if (room.state !== ROOM_STATES.RESULTS) return false;
    const active = humanMembers(room).filter((member) => member.connected);
    if (active.length === 0
      || active.some((member) => member.postRaceState !== POST_RACE_STATES.ROOM)) {
      return false;
    }
    this._returnRoom(room);
    return true;
  }

  _setController(room, member, kind, force = false) {
    const rosterEntry = room.race?.rosterByParticipantId?.get(member.participantId)
      ?? room.race?.roster.find((entry) => entry.participantId === member.participantId);
    if (!force && member.controllerKind === kind && rosterEntry?.controllerKind === kind) return;
    if (kind === CONTROLLER_KINDS.TAKEOVER_AI
      && (force || member.controllerKind !== CONTROLLER_KINDS.TAKEOVER_AI)) {
      member.pendingUseItems = 0;
      member.lastInput = { ...DEFAULT_ZERO_INPUT };
    }
    member.controllerKind = kind;
    if (rosterEntry) rosterEntry.controllerKind = kind;
    room.race?.simulation?.setController?.(member.kartIndex, kind);
  }

  _memberNaturallyFinished(room, member) {
    if (member.resultLocked) return true;
    const result = room.race?.results?.find(
      (candidate) => candidate.participantId === member.participantId,
    );
    if (result) return Boolean(result.completed);
    const kart = room.race?.simulation?.karts?.[member.kartIndex];
    return Boolean(kart?.finished && !kart.autoPlaced);
  }

  _canStart(room) {
    if (room.state !== ROOM_STATES.WAITING) return false;
    const members = humanMembers(room);
    const minimumHumans = room.botManaged ? 1 : 2;
    return members.length >= minimumHumans
      && members.every((member) => member.connected && member.ready);
  }

  _expireWaitingMembers(room, now) {
    let changed = false;
    for (const member of [...room.members.values()]) {
      if (!member.connected && member.resumeExpiresAt !== null && now > member.resumeExpiresAt) {
        this._resolvePendingParticipant(member.participantId, true, now);
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
        this._resolvePendingParticipant(member.participantId, !member.resultLocked, now);
        changed = true;
      }
    }
    if (changed) {
      this._broadcastRoomState(room);
    }
  }

  _removeParticipant(room, member) {
    room.members.delete(member.participantId);
    this.participantRooms.delete(member.participantId);
    this._releaseUserParticipant(member);
    if (room.hostParticipantId === member.participantId) this._migrateHost(room);
  }

  _releaseUserParticipant(member) {
    if (this.userParticipants.get(member.userId) === member.participantId) {
      this.userParticipants.delete(member.userId);
    }
  }

  _migrateHost(room) {
    if (room.botManaged) {
      const bot = botMemberOf(room);
      room.hostParticipantId = bot?.participantId ?? null;
      return;
    }
    if (room.members.get(room.hostParticipantId)?.connected) return;
    const next = [...room.members.values()]
      .filter((member) => member.connected && !member.abandoned)
      .sort((a, b) => a.joinOrder - b.joinOrder)[0];
    room.hostParticipantId = next?.participantId ?? null;
  }

  _destroyRoom(room) {
    this.activeRaceRooms.delete(room);
    room.race?.simulation?.dispose?.();
    for (const member of room.members.values()) {
      this.participantRooms.delete(member.participantId);
      this._releaseUserParticipant(member);
    }
    this.rooms.delete(room.code);
    this.emit('roomDestroyed', { roomCode: room.code });
    this._emitLobbyChangedIfNeeded();
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

  _requireChatRoom(room, member) {
    if ([ROOM_STATES.WAITING, ROOM_STATES.LOADING].includes(room.state)) return;
    if (room.state === ROOM_STATES.RESULTS
      && member.postRaceState === POST_RACE_STATES.ROOM) return;
    throw new GameError(ERROR_CODES.INVALID_STATE, 'Room chat is not available during the race.');
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

  async _verifyPassword(room, password) {
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
    const candidate = await this._runScrypt(validated.value, verifier.salt);
    if (!timingSafeEqual(candidate, verifier.hash)) {
      throw new GameError(ERROR_CODES.PASSWORD_INVALID, 'The room password is incorrect.');
    }
  }

  _broadcastRoomState(room) {
    if (!this.rooms.has(room.code)) return;
    this._emitToRoom(room, this.getRoomState(room.code));
    this._emitLobbyChangedIfNeeded();
  }

  async _runScrypt(password, salt) {
    const startedAt = performance.now();
    try {
      const result = await this.scryptQueue.run(password, salt, PASSWORD_HASH_BYTES);
      this.metrics?.recordScrypt(performance.now() - startedAt);
      return result;
    } catch (error) {
      if (error instanceof ScryptQueueFullError) {
        this.metrics?.increment('auth', 'queueRejected');
        throw new GameError(ERROR_CODES.SERVER_BUSY, 'The server is busy. Try again shortly.');
      }
      throw error;
    }
  }

  _emitLobbyChangedIfNeeded() {
    const rooms = this.listRooms();
    const signature = JSON.stringify(rooms);
    if (signature === this._lobbySignature) return false;
    this._lobbySignature = signature;
    this.emit('lobbyChanged', { rooms });
    return true;
  }

  _isolateRoomError(room, error, now = this.now()) {
    this.metrics?.increment('tick', 'roomErrors');
    this.activeRaceRooms.delete(room);
    if (room.race) {
      room.race.simulation?.dispose?.();
      this._finalizeRaceMembers(room, { resetReady: true, now });
      room.lastRaceId = room.race.raceId;
      room.lastWireRaceId = room.race.wireRaceId;
      room.race = null;
      room.state = ROOM_STATES.WAITING;
      room.botDestroyWhenHumanless = room.botManaged
        && !hasConnectedHuman(room) && hasLiveHuman(room);
      this._emitToRoom(room, serverMessage(SERVER_MESSAGE_TYPES.ERROR, {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'This race was cancelled after an authoritative simulation error.',
      }));
      this._broadcastRoomState(room);
    }
    const lastAt = this._roomErrorLastAt.get(room) ?? -Infinity;
    if (now - lastAt >= 5_000) {
      this._roomErrorLastAt.set(room, now);
      this.emit('managerError', error);
    }
  }

  _emitToRoom(room, message) {
    this.emit('message', { roomCode: room.code, participantId: null, message });
  }

  _emitToParticipant(participantId, message) {
    this.emit('message', { roomCode: null, participantId, message });
  }
}

export { serializeSimulation };
