// Lobby directory, pre-race room and authoritative online results screens.
//
// The network/application layer owns transport and navigation. This module only
// normalizes server payloads, renders them, and emits user intent callbacks.
// Keeping the view-model helpers free of DOM access makes protocol/UI behavior
// straightforward to exercise with Node's built-in test runner.

import { CHARACTER_STAT_RANGE, DIFFICULTY } from '../core/constants.js';
import {
  AVATARS,
  DEFAULT_ONLINE_LOADOUT,
  PAINT_THEMES,
} from '../game/appearance.js';
import { CHARACTERS } from '../game/characters.js';
import { onlineErrorMessage } from '../net/online-flow.js';
import { ERROR_CODES, validateRoomPassword } from '../net/protocol.js';
import { TRACKS } from '../track/tracks.js';
import {
  formatCopy,
  formatOrdinal,
  getUiCopy,
  localizeAvatar,
  localizeCharacter,
  localizeDifficulty,
  localizePaint,
  localizeTrack,
  sanitizeLanguage,
} from './copy.js';

export const ONLINE_ROOM_CAPACITY = 8;
export const ONLINE_ROOM_MIN_CAPACITY = 2;
export const ONLINE_ROOM_CODE_LENGTH = 6;
export const ONLINE_ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const ROOM_CODE_CHARS = new Set(ONLINE_ROOM_CODE_ALPHABET);
const ROOM_TYPES = new Set(['public', 'private']);
const IN_GAME_PHASES = new Set(['loading', 'countdown', 'racing', 'race', 'results', 'in_game', 'ingame']);
const MEDALS = ['\u{1F947}', '\u{1F948}', '\u{1F949}'];
const PROFILE_COPY = Object.freeze({
  en: {
    open: 'Open player profile', title: 'PLAYER PROFILE', level: 'Level', rating: 'Rating',
    races: 'Races', finishes: 'Finishes', completionRate: 'Finish rate', escapes: 'Escapes',
    escapeRate: 'Escape rate', firsts: 'Wins', seconds: 'Second', thirds: 'Third',
    records: 'FASTEST FINISHES', noRecord: '--', close: 'Close', syncing: 'Syncing player stats...',
    failed: 'Stats update failed', xp: 'Experience', unchanged: 'Rating unchanged',
    levelUp: 'LEVEL UP! LV {level}', newRecord: 'NEW TRACK RECORD',
  },
  'zh-CN': {
    open: '打开玩家资料', title: '玩家资料', level: '等级', rating: '竞技分',
    races: '比赛场次', finishes: '完赛场次', completionRate: '完赛率', escapes: '逃跑次数',
    escapeRate: '逃跑率', firsts: '冠军', seconds: '亚军', thirds: '季军',
    records: '各地图最快完赛', noRecord: '--', close: '关闭', syncing: '正在同步用户数据…',
    failed: '数据统计更新失败', xp: '经验', unchanged: '竞技分未变化',
    levelUp: '升级！LV {level}', newRecord: '刷新地图纪录',
  },
});
const ERROR_COPY_KEYS = new Map(Object.entries(ERROR_CODES).map(([key, value]) => [value, key]));
const LOADOUT_TABS = new Set(['racer', 'paint', 'avatar']);

function userCopy(language) {
  return PROFILE_COPY[sanitizeLanguage(language)] || PROFILE_COPY.en;
}

function formatRate(value) {
  const rate = Number(value);
  return `${(Number.isFinite(rate) ? Math.max(0, rate) : 0) * 100}`
    .replace(/(\.\d)\d+$/u, '$1')
    .replace(/\.0$/u, '') + '%';
}

const cssColor = (value) => `#${(value >>> 0).toString(16).padStart(6, '0')}`;

function trackOutlinePoints(points = []) {
  if (!points.length) return '';
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, Number(point.x) || 0);
    maxX = Math.max(maxX, Number(point.x) || 0);
    minZ = Math.min(minZ, Number(point.z) || 0);
    maxZ = Math.max(maxZ, Number(point.z) || 0);
  }
  const pad = 6;
  const width = 100 - pad * 2;
  const height = 60 - pad * 2;
  const scale = Math.min(
    width / Math.max(1e-6, maxX - minX),
    height / Math.max(1e-6, maxZ - minZ),
  );
  const offsetX = (100 - (maxX - minX) * scale) / 2;
  const offsetY = (60 - (maxZ - minZ) * scale) / 2;
  return points.map((point) => (
    `${(offsetX + ((Number(point.x) || 0) - minX) * scale).toFixed(1)},${(
      60 - offsetY - ((Number(point.z) || 0) - minZ) * scale
    ).toFixed(1)}`
  )).join(' ');
}

function trackPreviewMarkup(track) {
  if (!track) return '';
  const theme = track.theme || {};
  const road = theme.road == null ? '#3a3f4a' : cssColor(theme.road);
  const points = trackOutlinePoints(track.points);
  return `
    <svg viewBox="0 0 100 60" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <polygon points="${points}" fill="none" stroke="rgba(255,255,255,0.9)" stroke-width="7"
        stroke-linejoin="round" stroke-linecap="round" />
      <polygon points="${points}" fill="none" stroke="${road}" stroke-width="4.5"
        stroke-linejoin="round" stroke-linecap="round" />
    </svg>`;
}

function trackPreviewBackground(track) {
  const theme = track?.theme || {};
  const sky = theme.sky == null ? '#4aa8ff' : cssColor(theme.sky);
  const offroad = theme.offroad == null ? '#557755' : cssColor(theme.offroad);
  return `linear-gradient(180deg, ${sky}cc, ${offroad}cc)`;
}

function sameLoadout(a, b) {
  return Boolean(a && b
    && a.characterId === b.characterId
    && a.paintId === b.paintId
    && a.avatarId === b.avatarId);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function finiteNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function clampInteger(value, minimum, maximum, fallback) {
  const number = finiteNumber(value);
  if (number === null) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
}

function participantIdOf(value) {
  return String(firstDefined(value?.participantId, value?.playerId, value?.id, ''));
}

function connectionStateOf(member) {
  if (member?.connected === false) return 'disconnected';
  if (member?.connected === true) return 'connected';
  const state = String(firstDefined(member?.connectionState, member?.status, 'connected')).toLowerCase();
  return state === 'online' ? 'connected' : state;
}

function roomTypeOf(room) {
  const type = String(firstDefined(room?.roomType, room?.type, 'public')).toLowerCase();
  return ROOM_TYPES.has(type) ? type : 'public';
}

function roomCapacityOf(room) {
  return clampInteger(
    firstDefined(room?.maxPlayers, room?.capacity),
    ONLINE_ROOM_MIN_CAPACITY,
    ONLINE_ROOM_CAPACITY,
    ONLINE_ROOM_CAPACITY,
  );
}

function roomPlayerCountOf(room, fallback = 0) {
  return Math.max(0, Math.trunc(finiteNumber(
    room?.playerCount,
    room?.occupiedPlayers,
    room?.memberCount,
    fallback,
  ) ?? fallback));
}

function normalizedRoomPhase(value) {
  const phase = String(value || 'waiting').toLowerCase().replace(/[\s-]+/g, '_');
  return phase === 'lobby' ? 'waiting' : phase;
}

function roomStatusOf(room, playerCount, maxPlayers) {
  const state = normalizedRoomPhase(firstDefined(room?.status, room?.phase, room?.state, 'waiting'));
  if (IN_GAME_PHASES.has(state)) return 'in_game';
  if (state === 'full' || playerCount >= maxPlayers) return 'full';
  return 'waiting';
}

function createNode(doc, tag, className, parent, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
}

function statusSortOrder(room) {
  if (room.joinable) return 0;
  if (room.status === 'full') return 1;
  if (room.status === 'in_game') return 2;
  return 3;
}

function defaultRoomName(copy = getUiCopy()) {
  return normalizeRoomName(copy.online.lobby.defaultRoomName);
}

/** Normalize a user-entered room code to the server's unambiguous alphabet. */
export function normalizeRoomCode(value) {
  const chars = String(value ?? '').toUpperCase();
  let code = '';
  for (const char of chars) {
    if (ROOM_CODE_CHARS.has(char)) code += char;
    if (code.length === ONLINE_ROOM_CODE_LENGTH) break;
  }
  return code;
}

/** Apply lightweight client-side nickname hygiene; the server remains authoritative. */
export function normalizeDisplayName(value, maxLength = 20) {
  const cleaned = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, Math.max(1, maxLength)).join('');
}

/** Normalize a display-only room name using the protocol's 32-character limit. */
export function normalizeRoomName(value, maxLength = 32) {
  const cleaned = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, Math.max(1, maxLength)).join('');
}

/** Client-side convenience validation; the server remains authoritative. */
export function isValidRoomPassword(value) {
  const result = validateRoomPassword(value);
  return result.ok && result.value !== undefined;
}

export function roomCodeFromSearch(search) {
  const params = new URLSearchParams(String(search ?? '').replace(/^\?/, ''));
  return normalizeRoomCode(params.get('room'));
}

/** Create the canonical URL for the current page without online room state. */
export function buildLobbyUrl(locationLike = globalThis.location) {
  if (!locationLike) return '';
  const fallbackBase = `${locationLike.origin || 'http://localhost'}${locationLike.pathname || '/'}`;
  const url = new URL(locationLike.href || fallbackBase, fallbackBase);
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** Create a same-page invite link without leaking participant or resume tokens. */
export function buildInviteUrl(roomCode, locationLike = globalThis.location) {
  const code = normalizeRoomCode(roomCode);
  if (!code || !locationLike) return '';
  const url = new URL(buildLobbyUrl(locationLike));
  url.searchParams.set('room', code);
  return url.toString();
}

export function formatOnlineTime(seconds) {
  if (seconds === null || seconds === undefined || seconds === '') return '\u2014';
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '\u2014';
  const minutes = Math.floor(value / 60);
  const remainder = value - minutes * 60;
  return `${minutes}:${remainder < 10 ? '0' : ''}${remainder.toFixed(2)}`;
}

export function formatProfileBestTime(finishTimeMs, noRecord = '--') {
  if (finishTimeMs === null || finishTimeMs === undefined || finishTimeMs === '') return noRecord;
  const timeMs = Number(finishTimeMs);
  return Number.isFinite(timeMs) && timeMs >= 0
    ? formatOnlineTime(timeMs / 1000)
    : noRecord;
}

/**
 * Normalize lobby_state into searchable, sorted room cards. Search matches room
 * name, host display name, and room code without treating names as identities.
 */
export function buildLobbyView(lobbyState = {}, options = {}) {
  const copy = options.copy || getUiCopy(options.language);
  const rawRooms = Array.isArray(lobbyState)
    ? lobbyState
    : firstDefined(lobbyState.rooms, lobbyState.roomList, []);
  const search = String(firstDefined(options.search, lobbyState.search, '')).trim();
  const normalizedSearch = search.toLocaleLowerCase();
  const inviteRoomCode = normalizeRoomCode(firstDefined(
    options.inviteRoomCode,
    options.roomCode,
    lobbyState.inviteRoomCode,
    '',
  ));
  const tracks = Array.isArray(options.tracks) ? options.tracks : TRACKS;
  const trackById = new Map(tracks.map((track) => [track.id, track]));

  const rooms = (Array.isArray(rawRooms) ? rawRooms : []).map((room, index) => {
    const roomCode = normalizeRoomCode(firstDefined(room.roomCode, room.code, ''));
    const maxPlayers = roomCapacityOf(room);
    const memberFallback = Array.isArray(room.members) ? room.members.length : 0;
    const playerCount = Math.min(maxPlayers, roomPlayerCountOf(room, memberFallback));
    const roomType = roomTypeOf(room);
    const status = roomStatusOf(room, playerCount, maxPlayers);
    const roomName = normalizeRoomName(firstDefined(room.roomName, room.name, ''))
      || roomCode
      || copy.online.lobby.unnamedRoom;
    const hostDisplayName = normalizeDisplayName(firstDefined(
      room.hostDisplayName,
      room.hostName,
      room.host?.displayName,
      '',
    )) || copy.online.lobby.unknownHost;
    const requiresPassword = room.requiresPassword === true || roomType === 'private';
    const joinable = status === 'waiting' && room.joinable !== false;
    const isInvited = Boolean(inviteRoomCode && roomCode === inviteRoomCode);
    const trackId = String(firstDefined(
      room.trackId,
      room.settings?.trackId,
      room.track?.id,
      tracks[0]?.id,
      '',
    ));
    const track = trackById.get(trackId) || tracks[0] || null;
    const trackName = String(firstDefined(room.trackName, room.track?.name, track?.name, trackId));
    const haystack = `${roomName}\n${hostDisplayName}\n${roomCode}\n${trackName}`.toLocaleLowerCase();
    const matchesSearch = !normalizedSearch || haystack.includes(normalizedSearch) || isInvited;
    return {
      roomCode,
      roomName,
      roomType,
      requiresPassword,
      playerCount,
      maxPlayers,
      hostDisplayName,
      trackId,
      trackName,
      track,
      status,
      joinable,
      isInvited,
      matchesSearch,
      sourceIndex: index,
    };
  });

  const sortedRooms = rooms.slice().sort((a, b) => {
    const statusDifference = statusSortOrder(a) - statusSortOrder(b);
    return statusDifference || a.sourceIndex - b.sourceIndex;
  });
  const invitedRoom = inviteRoomCode
    ? sortedRooms.find((room) => room.roomCode === inviteRoomCode) || null
    : null;

  return {
    rooms: sortedRooms.filter((room) => room.matchesSearch),
    allRooms: sortedRooms,
    search,
    inviteRoomCode,
    invitedRoom,
    invitedRoomMissing: Boolean(inviteRoomCode && !invitedRoom),
    totalRooms: sortedRooms.length,
    joinableRooms: sortedRooms.filter((room) => room.joinable).length,
  };
}

/** Normalize room_state into pre-race room presentation facts. */
export function buildRoomView(roomState = {}, localParticipantId = '', options = {}) {
  const copy = options.copy || getUiCopy(options.language);
  const settings = roomState.settings || {};
  const phase = normalizedRoomPhase(firstDefined(roomState.phase, roomState.state, 'waiting'));
  const hostId = String(firstDefined(
    roomState.hostParticipantId,
    roomState.hostId,
    roomState.ownerId,
    '',
  ));
  const rawMembers = firstDefined(roomState.members, roomState.participants, roomState.players, []);
  const members = Array.isArray(rawMembers) ? rawMembers.map((member, index) => {
    const participantId = participantIdOf(member);
    const state = connectionStateOf(member);
    const postRaceState = normalizedRoomPhase(firstDefined(member.postRaceState, ''));
    return {
      participantId,
      displayName: String(firstDefined(
        member.displayName,
        member.nickname,
        member.name,
        formatCopy(copy.common.racerFallback, { rank: index + 1 }),
      )),
      characterId: String(firstDefined(member.characterId, member.character?.id, '')),
      paintId: String(firstDefined(member.paintId, DEFAULT_ONLINE_LOADOUT.paintId)),
      avatarId: String(firstDefined(member.avatarId, DEFAULT_ONLINE_LOADOUT.avatarId)),
      ready: Boolean(firstDefined(member.ready, member.isReady, false)),
      connected: !['disconnected', 'offline', 'expired'].includes(state),
      connectionState: state,
      postRaceState,
      activityState: String(firstDefined(
        member.activityState,
        phase === 'results' && !['waiting', 'room'].includes(postRaceState) ? 'in_game' : 'room',
      )),
      isHost: participantId === hostId || member.isHost === true,
      isLocal: member.isLocal === true
        || (participantId !== '' && participantId === String(localParticipantId || '')),
      joinOrder: finiteNumber(member.joinOrder, member.joinedAt, index) ?? index,
    };
  }) : [];

  const localMember = members.find((member) => member.isLocal) || null;
  const onlineMembers = members.filter((member) => member.connected);
  const reconnectingMembers = members.filter((member) => !member.connected);
  const everyoneOnline = members.length > 0 && onlineMembers.length === members.length;
  const everyoneReady = everyoneOnline && members.every((member) => member.ready);
  const serverAllowsStart = typeof roomState.canStart === 'boolean'
    ? roomState.canStart
    : onlineMembers.length >= 2 && everyoneReady && phase === 'waiting';
  const isHost = Boolean(localMember?.isHost
    || (localParticipantId && String(localParticipantId) === hostId));
  const maxPlayers = roomCapacityOf(roomState);
  const playerCount = Math.min(maxPlayers, roomPlayerCountOf(roomState, members.length));
  const canManageRoom = phase === 'waiting'
    || (phase === 'results' && ['waiting', 'room'].includes(localMember?.postRaceState));

  return {
    roomCode: normalizeRoomCode(firstDefined(roomState.roomCode, roomState.code, '')),
    roomName: normalizeRoomName(firstDefined(roomState.roomName, roomState.name, ''))
      || copy.online.room.unnamedRoom,
    roomType: roomTypeOf(roomState),
    maxPlayers,
    capacity: maxPlayers,
    playerCount,
    phase,
    hostId,
    members,
    localMember,
    onlineCount: onlineMembers.length,
    reconnectingMembers,
    reconnectingCount: reconnectingMembers.length,
    everyoneReady,
    isHost,
    canManageRoom,
    canStart: isHost && serverAllowsStart && phase === 'waiting',
    trackId: String(firstDefined(settings.trackId, roomState.trackId, TRACKS[0]?.id, '')),
    difficulty: String(firstDefined(settings.difficulty, roomState.difficulty, 'normal')),
    autoFillAi: Boolean(firstDefined(settings.autoFillAi, roomState.autoFillAi, false)),
  };
}

export function roomStatusMessage(view, copy = getUiCopy().online.room) {
  if (view.phase !== 'waiting') return copy.phase[view.phase] || copy.loading;
  if (view.reconnectingCount === 1) {
    return copy.waitingForReconnect.replace('{name}', view.reconnectingMembers[0].displayName);
  }
  if (view.reconnectingCount > 1) {
    return copy.waitingForReconnectCount.replace('{count}', String(view.reconnectingCount));
  }
  if (view.onlineCount < 2) return copy.waitingForRacer;
  if (!view.everyoneReady) {
    return copy.readyCount
      .replace('{ready}', String(view.members.filter((member) => member.ready && member.connected).length))
      .replace('{total}', String(view.onlineCount));
  }
  return view.isHost ? copy.readyToStart : copy.waitingForHost;
}

/** Normalize a race_results payload for the results table. */
export function buildOnlineResultsView(resultState = {}, localParticipantId = '', options = {}) {
  const copy = options.copy || getUiCopy(options.language);
  const rawRows = firstDefined(resultState.standings, resultState.results, []);
  const aiRows = Array.isArray(rawRows) ? rawRows.filter((row) => (
    Number(row?.aiPlayerNumber) > 0
    || /^ai[-:](\d+)(?:[-:]|$)/u.test(participantIdOf(row))
  )).slice().sort((a, b) => {
    const order = (row) => {
      const explicit = Math.trunc(Number(row?.aiPlayerNumber) || 0);
      if (explicit > 0) return explicit;
      const match = /^ai[-:](\d+)(?:[-:]|$)/u.exec(participantIdOf(row));
      return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
    };
    return order(a) - order(b);
  }) : [];
  const aiNumbers = new Map(aiRows.map((row, index) => [row, (
    Math.trunc(Number(row?.aiPlayerNumber) || 0) || index + 1
  )]));
  const standings = Array.isArray(rawRows) ? rawRows.map((row, index) => {
    const participantId = participantIdOf(row);
    const finishTime = finiteNumber(row.finishTime, row.totalTime, row.time);
    const bestLap = finiteNumber(row.bestLap, row.bestLapTime);
    const finished = row.completed === undefined
      ? row.finished !== false && finishTime !== null
      : Boolean(row.completed);
    const aiPlayerNumber = aiNumbers.get(row) ?? 0;
    return {
      participantId,
      displayName: aiPlayerNumber > 0
        ? `${copy.common.aiPlayer} ${aiPlayerNumber}`
        : String(firstDefined(
          row.displayName,
          row.nickname,
          row.name,
          formatCopy(copy.common.racerFallback, { rank: index + 1 }),
        )),
      characterId: String(firstDefined(row.characterId, row.character?.id, '')),
      paintId: String(firstDefined(row.paintId, DEFAULT_ONLINE_LOADOUT.paintId)),
      avatarId: String(firstDefined(row.avatarId, DEFAULT_ONLINE_LOADOUT.avatarId)),
      rank: Math.max(1, Math.trunc(finiteNumber(row.rank, row.position, index + 1) ?? index + 1)),
      finishTime: finished ? finishTime : null,
      bestLap,
      finished,
      isLocal: participantId !== '' && participantId === String(localParticipantId || ''),
    };
  }).sort((a, b) => a.rank - b.rank) : [];

  return {
    standings,
    trackName: String(firstDefined(resultState.trackName, resultState.track?.name, '')),
    autoReturnSeconds: finiteNumber(resultState.autoReturnSeconds, resultState.returnIn),
  };
}

export class OnlineScreens {
  constructor(roots = {}, callbacks = {}, options = {}) {
    const pick = (...keys) => keys.map((key) => roots[key]).find(Boolean) || null;
    this.roots = {
      lobby: pick('lobby', 'onlineLobby', 'screen-online-lobby'),
      room: pick('room', 'onlineRoom', 'screen-online-room'),
      results: pick('results', 'onlineResults', 'screen-online-results'),
    };
    this.doc = Object.values(this.roots).find(Boolean)?.ownerDocument || globalThis.document;
    if (!this.doc) throw new Error('OnlineScreens requires DOM roots or a document');

    this.callbacks = callbacks || {};
    this.language = sanitizeLanguage(options.language);
    this.copy = getUiCopy(this.language);
    this.characters = options.characters || CHARACTERS;
    this.paints = options.paints || PAINT_THEMES;
    this.avatars = options.avatars || AVATARS;
    this.characterById = new Map(this.characters.map((character) => [character.id, character]));
    this.playableCharacterIds = new Set(
      this.characters
        .filter((character) => character.availability !== 'locked')
        .map((character) => character.id),
    );
    this.paintById = new Map(this.paints.map((paint) => [paint.id, paint]));
    this.avatarById = new Map(this.avatars.map((avatar) => [avatar.id, avatar]));
    this.defaultLoadout = {
      characterId: this.playableCharacterIds.has(DEFAULT_ONLINE_LOADOUT.characterId)
        ? DEFAULT_ONLINE_LOADOUT.characterId
        : this.characters.find((character) => character.availability !== 'locked')?.id,
      paintId: this.paintById.has(DEFAULT_ONLINE_LOADOUT.paintId)
        ? DEFAULT_ONLINE_LOADOUT.paintId : this.paints[0]?.id,
      avatarId: this.avatarById.has(DEFAULT_ONLINE_LOADOUT.avatarId)
        ? DEFAULT_ONLINE_LOADOUT.avatarId : this.avatars[0]?.id,
    };
    this.tracks = options.tracks || TRACKS;
    this.trackById = new Map(this.tracks.map((track) => [track.id, track]));
    this.difficulties = options.difficulties || DIFFICULTY;
    this.location = options.location || globalThis.location;
    this.navigator = options.navigator || globalThis.navigator;
    this._screen = null;
    this._listeners = [];
    this._busy = false;
    this._displayName = '';
    this._lobbyState = {};
    this._lobbySearch = '';
    this._inviteRoomCode = '';
    this._locatedInviteCode = '';
    this._lobbyView = buildLobbyView({}, { copy: this.copy });
    this._lobbyRoomByCode = new Map();
    this._createFormInitialized = false;
    this._roomState = {};
    this._roomView = buildRoomView({}, '', { copy: this.copy });
    this._resultsState = {};
    this._userProfile = null;
    this._progressionState = null;
    this._localParticipantId = '';
    this._activeDialog = null;
    this._activeAlert = null;
    this._roomReconnectFocus = null;
    this._pendingAction = null;
    this._loadoutDraft = { ...this.defaultLoadout };
    this._loadoutTab = 'racer';
    this._pendingLoadout = null;
    this._previewHost = null;
    this._toastTimer = null;
    this._sharedUi = null;

    this._buildLobby();
    this._buildRoom();
    this._buildResults();
    this._buildSharedUi();
  }

  get activeScreen() { return this._screen; }

  setLanguage(language) {
    const next = sanitizeLanguage(language);
    if (next === this.language) return false;

    const draft = this._captureLobbyDraft();
    const reconnecting = !this.roots.room?.querySelector('[data-room-reconnect]')?.hidden;
    const sharedHost = this._sharedUi?.host;
    this._detachLoadoutPreview();
    for (const remove of this._listeners.splice(0)) remove();
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = null;
    sharedHost?.remove();
    this._sharedUi = null;
    this._activeDialog = null;
    this._activeAlert = null;
    this._roomReconnectFocus = null;

    this.language = next;
    this.copy = getUiCopy(next);
    this._createFormInitialized = false;
    this._buildLobby();
    this._buildRoom();
    this._buildResults();
    this._buildSharedUi();

    this._lobbySearch = draft.search;
    this.updateLobby(this._lobbyState, {
      displayName: this._displayName,
      inviteRoomCode: this._inviteRoomCode,
      search: draft.search,
    });
    this._restoreLobbyDraft(draft);
    if (Object.keys(this._roomState).length) {
      this.updateRoom(this._roomState, { localParticipantId: this._localParticipantId });
    }
    if (Object.keys(this._resultsState).length) {
      this.updateResults(this._resultsState, { localParticipantId: this._localParticipantId });
    }
    if (reconnecting) this.setRoomReconnecting(true, { restoreFocus: false });
    this._syncBusyState();
    return true;
  }

  _captureLobbyDraft() {
    const root = this.roots.lobby;
    const value = (selector, fallback = '') => root?.querySelector(selector)?.value ?? fallback;
    return {
      nickname: value('[data-field="nickname"]', this._displayName),
      search: value('[data-field="search"]', this._lobbySearch),
      roomName: value('[data-create-field="roomName"]'),
      roomType: value('[data-create-field="roomType"]', 'public'),
      maxPlayers: value('[data-create-field="maxPlayers"]', String(ONLINE_ROOM_CAPACITY)),
      trackId: value('[data-create-field="trackId"]', this.tracks[0]?.id || ''),
      password: value('[data-create-field="password"]'),
    };
  }

  _restoreLobbyDraft(draft) {
    const root = this.roots.lobby;
    const set = (selector, value) => {
      const node = root?.querySelector(selector);
      if (node) node.value = value;
    };
    set('[data-field="nickname"]', draft.nickname);
    set('[data-field="search"]', draft.search);
    set('[data-create-field="roomName"]', draft.roomName || defaultRoomName(this.copy));
    set('[data-create-field="roomType"]', draft.roomType);
    set('[data-create-field="maxPlayers"]', draft.maxPlayers);
    set('[data-create-field="trackId"]', draft.trackId);
    set('[data-create-field="password"]', draft.password);
    this._syncCreateRoomType();
    this._syncCreateTrackPreview();
    this._refreshLobbyView();
  }

  /** Join a public invite immediately, or prompt when its room needs a password. */
  joinInvitedRoom(roomCode) {
    const room = this._lobbyRoomByCode.get(normalizeRoomCode(roomCode));
    if (!room?.joinable || this._busy) return false;
    if (room.requiresPassword) this._openJoinDialog(room, null);
    else this._submitJoinRoom(room);
    return true;
  }

  _listen(node, type, listener, options) {
    if (!node) return;
    node.addEventListener(type, listener, options);
    this._listeners.push(() => node.removeEventListener(type, listener, options));
  }

  _emit(name, payload) {
    const callback = this.callbacks[name];
    if (typeof callback !== 'function') return undefined;
    try {
      const result = callback(payload);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => this.showError(error?.message || this.copy.online.errors.generic));
      }
      return result;
    } catch (error) {
      this.showError(error?.message || this.copy.online.errors.generic);
      return undefined;
    }
  }

  _pageActionsMarkup() {
    const copy = this.copy.online.pageActions;
    return `
      <div class="online-page-actions" aria-label="${copy.label}">
        <button type="button" class="online-page-action" data-page-action="settings"
          aria-label="${copy.settings}" title="${copy.settings}">
          <span class="online-page-action-icon" aria-hidden="true">&#9881;</span>
        </button>
        <button type="button" class="online-page-action" data-page-action="help"
          aria-label="${copy.help}" title="${copy.help}">
          <span class="online-page-action-icon" aria-hidden="true">?</span>
        </button>
      </div>`;
  }

  _buildSharedUi() {
    const parent = this.doc.body
      || Object.values(this.roots).find(Boolean)?.parentElement;
    if (!parent) return;
    const copy = this.copy.online.alerts;
    const host = createNode(this.doc, 'div', 'online-shared-ui', parent);
    host.innerHTML = `
      <div class="online-toast" data-online-toast role="status" aria-live="polite" hidden></div>
      <div class="online-alert-backdrop" data-online-alert hidden>
        <section class="online-alert" role="alertdialog" aria-modal="true"
          aria-labelledby="online-alert-title" aria-describedby="online-alert-message">
          <h2 id="online-alert-title" data-alert-title>${copy.genericTitle}</h2>
          <p id="online-alert-message" data-alert-message></p>
          <div class="online-alert-actions">
            <button type="button" class="online-action online-action-quiet" data-action="cancel-alert" hidden>${copy.cancel}</button>
            <button type="button" class="online-action online-action-primary" data-action="dismiss-alert">${copy.dismiss}</button>
          </div>
        </section>
      </div>`;
    this._sharedUi = {
      host,
      toast: host.querySelector('[data-online-toast]'),
      alert: host.querySelector('[data-online-alert]'),
    };
    this._listen(host.querySelector('[data-action="dismiss-alert"]'), 'click', () => this.confirmAlert());
    this._listen(host.querySelector('[data-action="cancel-alert"]'), 'click', () => this.cancelAlert());
    this._listen(this._sharedUi.alert, 'keydown', (event) => this._handleAlertKeydown(event));
  }

  _wirePageActions(root) {
    for (const item of root.querySelectorAll('[data-page-action]')) {
      this._listen(item, 'click', () => {
        if (item.dataset.pageAction === 'settings') this._emit('onOpenSettings');
        else if (item.dataset.pageAction === 'help') this._emit('onOpenHelp');
      });
    }
  }

  focusPageAction(screen = this._screen) {
    this.roots[screen]?.querySelector('[data-page-action="settings"]')?.focus();
  }

  _fieldControl(field) {
    const selectors = {
      nickname: '[data-field="nickname"]',
      'create-room-name': '[data-create-field="roomName"]',
      'create-room-type': '[data-create-field="roomType"]',
      'create-max-players': '[data-create-field="maxPlayers"]',
      'create-track': '[data-create-field="trackId"]',
      'create-password': '[data-create-field="password"]',
      'join-password': '[data-join-field="password"]',
    };
    return this.roots.lobby?.querySelector(selectors[field] || '.__missing-online-field') || null;
  }

  showFieldError(field, message, { focus = false } = {}) {
    const node = this.roots.lobby?.querySelector(`[data-field-error="${field}"]`);
    const control = this._fieldControl(field);
    if (!node || !control) return false;
    node.textContent = String(message || this.copy.online.errors.generic);
    node.hidden = false;
    control.setAttribute('aria-invalid', 'true');
    if (focus) control.focus();
    return true;
  }

  clearFieldError(field) {
    const node = this.roots.lobby?.querySelector(`[data-field-error="${field}"]`);
    const control = this._fieldControl(field);
    if (node) {
      node.textContent = '';
      node.hidden = true;
    }
    control?.removeAttribute('aria-invalid');
  }

  _clearDialogFieldErrors(name) {
    if (name === 'loadout') return;
    const fields = name === 'create'
      ? ['create-room-name', 'create-room-type', 'create-max-players', 'create-track', 'create-password']
      : ['join-password'];
    for (const field of fields) this.clearFieldError(field);
  }

  _errorText(message) {
    if (typeof message === 'string') return message || this.copy.online.errors.generic;
    const code = String(message?.code || '');
    const copyKey = ERROR_COPY_KEYS.get(code);
    return String(
      this.copy.online.errors[copyKey]
      || onlineErrorMessage(message, this.copy.online.errors.generic),
    );
  }

  _fieldForError(code, action) {
    if (code === ERROR_CODES.NAME_INVALID) return 'nickname';
    if (code === ERROR_CODES.ROOM_NAME_INVALID) return action === 'create' ? 'create-room-name' : null;
    if (code === ERROR_CODES.ROOM_TYPE_INVALID) return action === 'create' ? 'create-room-type' : null;
    if (code === ERROR_CODES.ROOM_CAPACITY_INVALID) return action === 'create' ? 'create-max-players' : null;
    if (code === ERROR_CODES.PASSWORD_REQUIRED || code === ERROR_CODES.PASSWORD_INVALID) {
      if (action === 'join' || this._activeDialog?.name === 'join') return 'join-password';
      if (action === 'create' || this._activeDialog?.name === 'create') return 'create-password';
    }
    return null;
  }

  _alertTitle(action, connectionError = false) {
    const copy = (this.copy || getUiCopy(this.language)).online.alerts;
    if (connectionError) return copy.connectionTitle;
    if (action === 'join') return copy.joinTitle;
    if (action === 'create') return copy.createTitle;
    if (action === 'quick') return copy.quickTitle;
    if (['start', 'ready', 'character', 'loadout', 'settings', 'kick'].includes(action)) return copy.roomTitle;
    return copy.genericTitle;
  }

  presentError(message, context = {}) {
    const code = typeof message === 'string' ? '' : String(message?.code || '');
    const pendingAction = this._pendingAction;
    const action = context.action || pendingAction?.kind || '';
    const field = this._fieldForError(code, action);
    const text = this._errorText(message);
    this._pendingAction = null;
    if (action === 'loadout') {
      this._pendingLoadout = null;
      this._syncLoadoutDialog();
    }
    if (field && this.showFieldError(field, text, { focus: true })) return 'field';
    let restoreFocus = this.doc.activeElement;
    if (this._activeDialog?.name === 'join' && action === 'join') {
      restoreFocus = this._activeDialog.opener || restoreFocus;
      this._closeDialog(false);
    } else if (action === 'join' && pendingAction?.roomCode) {
      restoreFocus = this.roots.lobby?.querySelector(
        `[data-action="join-room"][data-room-code="${pendingAction.roomCode}"]`,
      ) || restoreFocus;
    }
    this.showAlert(text, {
      title: context.title || this._alertTitle(action, context.connectionError),
      restoreFocus,
    });
    return 'alert';
  }

  showAlert(message, options = {}) {
    const {
      title = this.copy.online.alerts.genericTitle,
      restoreFocus = this.doc.activeElement,
      buttonLabel = this.copy.online.alerts.dismiss,
      cancelLabel = null,
      onConfirm = null,
      onCancel = null,
    } = options;
    const alert = this._sharedUi?.alert;
    if (!alert) return;
    const previous = this._activeAlert?.restoreFocus || restoreFocus;
    const suspendedDialog = this._activeDialog?.node || null;
    if (suspendedDialog) {
      suspendedDialog.setAttribute('inert', '');
      suspendedDialog.setAttribute('aria-hidden', 'true');
    }
    alert.querySelector('[data-alert-title]').textContent = title;
    alert.querySelector('[data-alert-message]').textContent = String(message || this.copy.online.errors.generic);
    alert.querySelector('[data-action="dismiss-alert"]').textContent = String(buttonLabel);
    const cancel = alert.querySelector('[data-action="cancel-alert"]');
    cancel.textContent = String(cancelLabel || this.copy.online.alerts.cancel);
    cancel.hidden = !cancelLabel;
    alert.hidden = false;
    this._activeAlert = {
      node: alert,
      restoreFocus: previous,
      suspendedDialog,
      onConfirm: typeof onConfirm === 'function' ? onConfirm : null,
      onCancel: typeof onCancel === 'function' ? onCancel : null,
      isConfirm: Boolean(cancelLabel),
    };
    alert.querySelector('[data-action="dismiss-alert"]')?.focus();
  }

  dismissAlert(restoreFocus = true) {
    if (!this._activeAlert) return;
    const { node, restoreFocus: previous, suspendedDialog } = this._activeAlert;
    node.hidden = true;
    this._activeAlert = null;
    suspendedDialog?.removeAttribute('inert');
    suspendedDialog?.removeAttribute('aria-hidden');
    if (restoreFocus && previous?.isConnected) previous.focus();
  }

  confirmAlert() {
    if (!this._activeAlert) return;
    const { onConfirm } = this._activeAlert;
    this.dismissAlert();
    onConfirm?.();
  }

  cancelAlert() {
    if (!this._activeAlert) return;
    const { onCancel } = this._activeAlert;
    this.dismissAlert();
    onCancel?.();
  }

  showToast(message, durationMs = 2000) {
    const toast = this._sharedUi?.toast;
    if (!toast) return;
    if (this._toastTimer) clearTimeout(this._toastTimer);
    toast.textContent = String(message || '');
    toast.hidden = false;
    toast.classList.remove('is-showing');
    void toast.offsetWidth;
    toast.classList.add('is-showing');
    this._toastTimer = setTimeout(() => {
      toast.hidden = true;
      toast.classList.remove('is-showing');
      this._toastTimer = null;
    }, Math.max(0, Number(durationMs) || 0));
  }

  _handleAlertKeydown(event) {
    event.stopPropagation();
    if (!this._activeAlert) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (this._activeAlert.isConfirm) this.cancelAlert();
      else this.confirmAlert();
      return;
    }
    this._trapFocus(event, this._activeAlert.node);
  }

  _trapFocus(event, container) {
    if (event.key !== 'Tab') return;
    const focusable = [...container.querySelectorAll(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)',
    )].filter((node) => !node.hidden && node.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && this.doc.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && this.doc.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  _buildLobby() {
    const root = this.roots.lobby;
    if (!root) return;
    const copy = this.copy.online.lobby;
    const profileCopy = userCopy(this.language);
    root.innerHTML = `
      <div class="online-panel online-directory-panel">
        <header class="online-directory-header">
          <button type="button" class="online-back online-lobby-back" data-action="back" aria-label="${copy.back}">
            <span aria-hidden="true">&#8592;</span><span>${copy.back}</span>
          </button>
          <div class="online-lobby-brand">
            <h2 data-screen-heading tabindex="-1" aria-label="Turbo Legends">
              <span>TURBO</span><strong>LEGENDS</strong>
            </h2>
            <small>${copy.heading}</small>
          </div>
          <div class="online-lobby-account">
            <button type="button" class="online-profile-button" data-action="profile" data-busy-action
              aria-label="${profileCopy.open}">
              <span class="online-profile-mark" aria-hidden="true">TL</span>
              <span class="online-profile-summary">
                <strong data-profile-level-badge>LV --</strong>
                <small data-profile-rating-badge>R ----</small>
              </span>
            </button>
            <label class="online-nickname-field">
              <span class="sr-only">${copy.nickname}</span>
              <input class="online-input" data-field="nickname" type="text" maxlength="20"
                autocomplete="nickname" spellcheck="false" placeholder="${copy.nicknamePlaceholder}"
                aria-describedby="online-nickname-error" />
              <span class="online-nickname-edit" aria-hidden="true">&#9998;</span>
              <span id="online-nickname-error" class="online-field-error" data-field-error="nickname" role="alert" hidden></span>
            </label>
            ${this._pageActionsMarkup()}
          </div>
        </header>

        <div class="online-lobby-layout">
          <aside class="online-lobby-sidebar" aria-label="${copy.playerSetup}">
            <button type="button" class="online-action online-action-secondary online-quick-start"
              data-action="quick" data-busy-action>
              <span class="online-quick-start-icon" aria-hidden="true">&#9889;</span>
              <strong>${copy.quickMatch}</strong>
            </button>

            <form class="online-create-card" data-form="create" aria-labelledby="online-create-heading">
              <div class="online-create-card-heading">
                <span aria-hidden="true">+</span>
                <h3 id="online-create-heading">${copy.createRoom}</h3>
              </div>
              <label class="online-field">
                <span class="online-field-label">${copy.roomName}</span>
                <input class="online-input" data-create-field="roomName" type="text" maxlength="32" required
                  placeholder="${copy.roomNamePlaceholder}" aria-describedby="online-create-room-name-error" />
                <span id="online-create-room-name-error" class="online-field-error"
                  data-field-error="create-room-name" role="alert" hidden></span>
              </label>
              <label class="online-field">
                <span class="online-field-label">${copy.maxPlayers}</span>
                <select class="online-select" data-create-field="maxPlayers"
                  aria-describedby="online-create-max-players-error">
                  <option value="2">2</option><option value="3">3</option><option value="4">4</option>
                  <option value="5">5</option><option value="6">6</option><option value="7">7</option>
                  <option value="8" selected>8</option>
                </select>
                <span id="online-create-max-players-error" class="online-field-error"
                  data-field-error="create-max-players" role="alert" hidden></span>
              </label>
              <label class="online-field">
                <span class="online-field-label">${copy.track}</span>
                <span class="online-create-track-preview" data-create-track-preview aria-hidden="true"></span>
                <select class="online-select" data-create-field="trackId" aria-label="${copy.track}"></select>
              </label>
              <label class="online-field">
                <span class="online-field-label">${copy.roomType}</span>
                <select class="online-select" data-create-field="roomType"
                  aria-describedby="online-create-room-type-error">
                  <option value="public">${copy.publicRoom}</option>
                  <option value="private">${copy.privateRoom}</option>
                </select>
                <span id="online-create-room-type-error" class="online-field-error"
                  data-field-error="create-room-type" role="alert" hidden></span>
              </label>
              <label class="online-field" data-private-password-field hidden>
                <span class="online-field-label">${copy.password}</span>
                <input class="online-input" data-create-field="password" type="password" minlength="3" maxlength="20"
                  autocomplete="off" placeholder="${copy.passwordPlaceholder}"
                  aria-describedby="online-create-password-help online-create-password-error" />
                <span id="online-create-password-help" class="online-field-help">${copy.passwordHelp}</span>
                <span id="online-create-password-error" class="online-field-error"
                  data-field-error="create-password" role="alert" hidden></span>
              </label>
              <button type="submit" class="online-action online-action-primary online-create-submit" data-busy-action>
                <span aria-hidden="true">+</span> ${copy.create}
              </button>
            </form>
          </aside>

          <section class="online-room-browser" aria-labelledby="online-room-list-heading">
            <div class="online-room-browser-header">
              <div>
                <h3 id="online-room-list-heading">${copy.roomList}</h3>
                <p class="online-room-browser-count" data-room-count role="status" aria-live="polite"></p>
              </div>
              <label class="online-search-field">
                <span class="sr-only">${copy.search}</span>
                <input class="online-input online-search-input" data-field="search" type="search"
                  autocomplete="off" spellcheck="false" placeholder="${copy.searchPlaceholder}" />
              </label>
            </div>
            <div class="online-room-list" data-room-list role="list"></div>
          </section>
        </div>
      </div>

      <div class="online-dialog-backdrop" data-dialog="join" hidden>
        <form class="online-dialog" data-form="join" role="dialog" aria-modal="true" aria-labelledby="online-join-heading">
          <div class="online-dialog-header">
            <div>
              <p class="online-eyebrow">${copy.privateRoomHeading}</p>
              <h3 id="online-join-heading" data-join-room-name>${copy.joinRoom}</h3>
              <p class="online-dialog-room-code" data-join-room-code></p>
            </div>
            <button type="button" class="online-dialog-close" data-action="close-dialog" aria-label="${copy.close}">&#215;</button>
          </div>
          <label class="online-field">
            <span class="online-field-label">${copy.password}</span>
            <input class="online-input" data-join-field="password" type="password" minlength="3" maxlength="20"
              autocomplete="off" placeholder="${copy.enterPassword}" required
              aria-describedby="online-join-password-error" />
            <span id="online-join-password-error" class="online-field-error"
              data-field-error="join-password" role="alert" hidden></span>
          </label>
          <div class="online-dialog-actions">
            <button type="button" class="online-action online-action-quiet" data-action="close-dialog">${copy.cancel}</button>
            <button type="submit" class="online-action online-action-secondary" data-busy-action>${copy.join}</button>
          </div>
        </form>
      </div>

      <div class="online-dialog-backdrop" data-dialog="profile" hidden>
        <section class="online-dialog online-profile-dialog" role="dialog" aria-modal="true"
          aria-labelledby="online-profile-heading">
          <div class="online-dialog-header">
            <div><p class="online-eyebrow">TURBO LEGENDS</p><h3 id="online-profile-heading">${profileCopy.title}</h3></div>
            <button type="button" class="online-dialog-close" data-action="close-dialog"
              aria-label="${profileCopy.close}">&#215;</button>
          </div>
          <div class="online-profile-hero">
            <div><span>${profileCopy.level}</span><strong data-profile-level>LV 1</strong></div>
            <div><span>${profileCopy.rating}</span><strong data-profile-rating>1000</strong></div>
          </div>
          <div class="online-profile-progress"><span data-profile-progress></span></div>
          <p class="online-profile-xp" data-profile-xp></p>
          <div class="online-profile-stats">
            <div><span>${profileCopy.races}</span><strong data-profile-stat="races">0</strong></div>
            <div><span>${profileCopy.finishes}</span><strong data-profile-stat="finishes">0</strong></div>
            <div><span>${profileCopy.completionRate}</span><strong data-profile-stat="completionRate">0%</strong></div>
            <div><span>${profileCopy.escapes}</span><strong data-profile-stat="escapes">0</strong></div>
            <div><span>${profileCopy.escapeRate}</span><strong data-profile-stat="escapeRate">0%</strong></div>
            <div><span>${profileCopy.firsts}</span><strong data-profile-stat="firsts">0</strong></div>
            <div><span>${profileCopy.seconds}</span><strong data-profile-stat="seconds">0</strong></div>
            <div><span>${profileCopy.thirds}</span><strong data-profile-stat="thirds">0</strong></div>
          </div>
          <h4 class="online-profile-records-heading">${profileCopy.records}</h4>
          <div class="online-profile-records" data-profile-records></div>
          <div class="online-dialog-actions">
            <button type="button" class="online-action online-action-primary" data-action="close-dialog">${profileCopy.close}</button>
          </div>
        </section>
      </div>`;

    this._listen(root, 'keydown', (event) => this._handleScreenKeydown(event));
    this._listen(root.querySelector('[data-action="back"]'), 'click', () => this._emit('onBackToTitle'));
    this._wirePageActions(root);
    this._listen(root.querySelector('[data-action="profile"]'), 'click', (event) => {
      this._renderUserProfile();
      this._openDialog('profile', event.currentTarget);
      this._emit('onOpenProfile');
    });
    this._listen(root.querySelector('[data-action="quick"]'), 'click', () => this._submitQuickMatch());
    for (const button of root.querySelectorAll('[data-action="close-dialog"]')) {
      this._listen(button, 'click', () => this._closeDialog());
    }

    const nickname = root.querySelector('[data-field="nickname"]');
    const search = root.querySelector('[data-field="search"]');
    const roomType = root.querySelector('[data-create-field="roomType"]');
    const trackSelect = root.querySelector('[data-create-field="trackId"]');
    for (const track of this.tracks) {
      const option = createNode(this.doc, 'option', '', trackSelect, track.name);
      option.value = track.id;
    }
    this._listen(nickname, 'input', () => this.clearFieldError('nickname'));
    this._listen(nickname, 'change', () => this._commitNickname(true));
    this._listen(nickname, 'keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (this._commitNickname(true)) search?.focus();
    });
    this._listen(search, 'input', () => {
      this._lobbySearch = search.value;
      this._refreshLobbyView();
    });
    this._listen(root.querySelector('[data-create-field="roomName"]'), 'input', () => {
      this.clearFieldError('create-room-name');
    });
    this._listen(root.querySelector('[data-create-field="password"]'), 'input', () => {
      this.clearFieldError('create-password');
    });
    this._listen(root.querySelector('[data-join-field="password"]'), 'input', () => {
      this.clearFieldError('join-password');
    });
    this._listen(roomType, 'change', () => {
      this.clearFieldError('create-room-type');
      this.clearFieldError('create-password');
      this._syncCreateRoomType();
    });
    this._listen(trackSelect, 'change', () => this._syncCreateTrackPreview());
    this._listen(root.querySelector('[data-create-field="maxPlayers"]'), 'change', () => {
      this.clearFieldError('create-max-players');
    });
    this._listen(root.querySelector('[data-form="create"]'), 'submit', (event) => {
      event.preventDefault();
      this._submitCreateRoom();
    });
    this._listen(root.querySelector('[data-form="join"]'), 'submit', (event) => {
      event.preventDefault();
      this._submitPrivateJoin();
    });
    this._listen(root.querySelector('[data-room-list]'), 'click', (event) => {
      const button = event.target.closest?.('[data-action="join-room"]');
      if (!button || button.disabled) return;
      const room = this._lobbyRoomByCode.get(normalizeRoomCode(button.dataset.roomCode));
      if (!room) return;
      if (room.requiresPassword) this._openJoinDialog(room, button);
      else this._submitJoinRoom(room);
    });
    this._syncCreateRoomType();
    this._syncCreateTrackPreview();
  }

  _buildRoom() {
    const root = this.roots.room;
    if (!root) return;
    const copy = this.copy.online.room;
    root.innerHTML = `
      <div class="online-panel online-room-panel" data-room-content>
        <header class="online-room-header">
          <button type="button" class="online-back online-room-back" data-action="leave" aria-label="${copy.back}">
            <span aria-hidden="true">&#8592;</span><span>${copy.back}</span>
          </button>
          <div class="online-room-heading">
            <h2 class="online-room-name" data-room-name data-screen-heading tabindex="-1">${copy.unnamedRoom}</h2>
            <div class="online-room-summary">
              <span class="online-room-type" data-room-type></span>
              <span data-room-players></span>
              <button type="button" class="online-room-code" data-action="copy"
                aria-label="${copy.copyInvite}" title="${copy.copyInvite}">
                <span data-room-code>------</span>
                <svg class="online-room-share-icon" aria-hidden="true" viewBox="0 0 24 24" focusable="false">
                  <path class="online-room-share-frame" d="M9.5 5H4.5v14.5h15V14" />
                  <path class="online-room-share-arrow" d="M13 2v3.4c-4.8.75-7.8 3.6-8.8 8.8 2.25-2.7 5.2-4.05 8.8-4.1V14l10-6.6L13 2Z" />
                </svg>
              </button>
            </div>
          </div>
          ${this._pageActionsMarkup()}
        </header>

        <div class="online-room-grid">
          <section class="online-card online-members-card">
            <h3>${copy.racers}</h3>
            <ol class="online-member-list" data-member-list></ol>
          </section>
          <section class="online-card online-loadout-card">
            <h3>${copy.yourRacer}</h3>
            <button type="button" class="online-loadout-preview-button" data-action="open-loadout">
              <span class="online-loadout-preview-host" data-loadout-preview-host="room">
                <span class="online-loadout-preview-fallback" data-loadout-avatar-glyph aria-hidden="true">\u{1F431}</span>
              </span>
              <span class="sr-only">${copy.customize}</span>
            </button>
            <div class="online-loadout-summary">
              <strong data-loadout-racer>Kit</strong>
              <span class="online-loadout-detail"><i data-loadout-paint-swatch></i><span data-loadout-paint>Turbo Blue</span></span>
              <span class="online-loadout-detail"><span data-loadout-avatar-glyph>\u{1F431}</span><span data-loadout-avatar>Cat</span></span>
            </div>
            <button type="button" class="online-action online-action-secondary online-loadout-customize"
              data-action="open-loadout">${copy.customize}</button>
          </section>
          <section class="online-card online-setup-card">
            <h3>${copy.raceSetup}</h3>
            <div class="online-setup-track-preview" data-room-track-preview aria-hidden="true"></div>
            <div class="online-setup-track-copy">
              <strong data-room-track-name></strong>
              <span class="chip chip-laps" data-room-track-laps></span>
              <p data-room-track-description></p>
            </div>
            <label class="online-field">
              <span class="online-field-label">${copy.track}</span>
              <select class="online-select" data-room-setting="trackId"></select>
            </label>
            <label class="online-field">
              <span class="online-field-label">${copy.difficulty}</span>
              <select class="online-select" data-room-setting="difficulty"></select>
            </label>
            <label class="online-checkbox-field">
              <input type="checkbox" data-room-setting="autoFillAi">
              <span class="online-checkbox-mark" aria-hidden="true"></span>
              <span class="online-checkbox-copy">
                <strong>${copy.autoFillAi}</strong>
              </span>
            </label>
            <p class="online-host-note" data-host-note></p>
          </section>
        </div>
        <p class="online-room-state" data-room-status role="status" aria-live="polite"></p>
        <footer class="online-room-actions">
          <button type="button" class="online-action online-action-secondary" data-action="ready">${copy.readyUp}</button>
          <button type="button" class="online-action online-action-primary" data-action="start">${copy.start}</button>
        </footer>
      </div>
      <div class="online-dialog-backdrop online-loadout-backdrop" data-dialog="loadout" hidden>
        <form class="online-loadout-dialog" data-form="loadout" role="dialog" aria-modal="true"
          aria-labelledby="online-loadout-heading">
          <header class="online-dialog-header online-loadout-dialog-header">
            <h3 id="online-loadout-heading">${copy.customizeRacer}</h3>
            <button type="button" class="online-dialog-close" data-action="close-loadout"
              aria-label="${copy.close}">\u00d7</button>
          </header>
          <div class="online-loadout-dialog-grid">
            <section class="online-loadout-dialog-preview">
              <div class="online-loadout-preview-host" data-loadout-preview-host="dialog">
                <span class="online-loadout-preview-fallback" data-loadout-avatar-glyph aria-hidden="true">\u{1F431}</span>
              </div>
              <div class="online-loadout-dialog-selection">
                <strong data-draft-racer>Kit</strong>
                <span data-draft-paint>Turbo Blue</span>
                <span data-draft-avatar>Cat</span>
              </div>
            </section>
            <section class="online-loadout-editor">
              <div class="online-loadout-tabs" role="tablist" aria-label="${copy.customizeRacer}">
                <button type="button" role="tab" id="online-loadout-tab-racer"
                  aria-controls="online-loadout-panel-racer" data-loadout-tab="racer">${copy.racerTab}</button>
                <button type="button" role="tab" id="online-loadout-tab-paint"
                  aria-controls="online-loadout-panel-paint" data-loadout-tab="paint">${copy.paintTab}</button>
                <button type="button" role="tab" id="online-loadout-tab-avatar"
                  aria-controls="online-loadout-panel-avatar" data-loadout-tab="avatar">${copy.avatarTab}</button>
              </div>
              <div class="online-loadout-panel" id="online-loadout-panel-racer"
                aria-labelledby="online-loadout-tab-racer" data-loadout-panel="racer" role="tabpanel">
                <div class="online-loadout-racer-grid" data-loadout-racer-grid></div>
              </div>
              <div class="online-loadout-panel" id="online-loadout-panel-paint"
                aria-labelledby="online-loadout-tab-paint" data-loadout-panel="paint" role="tabpanel" hidden>
                <div class="online-loadout-paint-grid" data-loadout-paint-grid></div>
              </div>
              <div class="online-loadout-panel" id="online-loadout-panel-avatar"
                aria-labelledby="online-loadout-tab-avatar" data-loadout-panel="avatar" role="tabpanel" hidden>
                <div class="online-loadout-avatar-grid" data-loadout-avatar-grid></div>
              </div>
            </section>
          </div>
          <footer class="online-dialog-actions online-loadout-actions">
            <button type="button" class="online-action online-action-quiet" data-action="cancel-loadout">${copy.cancel}</button>
            <button type="submit" class="online-action online-action-primary" data-action="save-loadout">${copy.save}</button>
          </footer>
        </form>
      </div>
      <div class="online-room-reconnect-backdrop" data-room-reconnect hidden>
        <section class="online-room-reconnect" role="status" aria-live="assertive"
          aria-busy="true" tabindex="-1">
          <span class="online-room-reconnect-spinner" aria-hidden="true"></span>
          <h3>${copy.reconnecting}</h3>
          <p>${copy.restoringSession}</p>
        </section>
      </div>`;

    this._listen(root, 'keydown', (event) => this._handleScreenKeydown(event));
    this._wirePageActions(root);

    const racerGrid = root.querySelector('[data-loadout-racer-grid]');
    for (const character of this.characters) {
      const localized = localizeCharacter(character, this.language);
      const locked = character.availability === 'locked';
      const button = createNode(this.doc, 'button',
        `online-loadout-racer-option${locked ? ' is-locked' : ''}`, racerGrid);
      button.type = 'button';
      button.dataset.loadoutCharacterId = character.id;
      button.disabled = locked;
      button.setAttribute('aria-label', locked
        ? formatCopy(this.copy.common.lockedAria, { name: character.name }) : character.name);
      const swatch = createNode(this.doc, 'span', 'online-loadout-racer-swatch', button,
        locked ? '' : '\u{1F3CE}\u{FE0F}');
      if (locked) {
        const sil = createNode(this.doc, 'span', 'racer-secret-silhouette', swatch);
        sil.innerHTML = `
          <svg class="racer-silhouette-svg" viewBox="0 0 140 45" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M 3 34 C 4 32, 10 26, 18 24 L 38 21 C 46 20, 52 11, 68 8 C 82 5, 94 9, 104 17 C 110 20, 118 21, 126 21 L 126 12 L 137 10 L 138 15 L 128 22 L 137 31 L 135 34 L 120 34 A 10 10 0 0 0 100 34 L 44 34 A 10 10 0 0 0 24 34 Z" fill="currentColor"/>
            <circle cx="34" cy="34" r="9" fill="#080a14" stroke="currentColor" stroke-width="2.2"/>
            <circle cx="34" cy="34" r="3.5" fill="currentColor"/>
            <circle cx="110" cy="34" r="9" fill="#080a14" stroke="currentColor" stroke-width="2.2"/>
            <circle cx="110" cy="34" r="3.5" fill="currentColor"/>
            <path d="M 54 20 C 62 13, 76 10, 88 13 L 98 19" stroke="rgba(255,255,255,0.3)" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
        `;
        createNode(this.doc, 'span', 'racer-lock-mark', swatch, '\u{1F512}');
      } else {
        swatch.style.background = `linear-gradient(135deg, ${cssColor(character.color)}, ${cssColor(character.accentColor)})`;
      }
      const body = createNode(this.doc, 'span', 'online-loadout-racer-body', button);
      const nameRow = createNode(this.doc, 'span', 'online-loadout-racer-name-row', body);
      createNode(this.doc, 'strong', '', nameRow, character.name);
      createNode(this.doc, 'span', locked ? 'chip chip-locked' : `chip chip-${character.weightClass}`,
        nameRow, locked ? this.copy.common.comingSoon : this.copy.common.weights[character.weightClass]);
      createNode(this.doc, 'span', 'online-loadout-racer-blurb', body, localized.blurb);
      const stats = createNode(this.doc, 'span', 'online-loadout-racer-stats', body);
      for (const [key, label] of Object.entries(this.copy.common.stats)) {
        const row = createNode(this.doc, 'span', 'online-loadout-stat-row', stats);
        createNode(this.doc, 'span', '', row, label);
        const bar = createNode(this.doc, 'span', 'online-loadout-stat-bar', row);
        const fill = createNode(this.doc, 'span', 'online-loadout-stat-fill', bar);
        const [minimum, maximum] = CHARACTER_STAT_RANGE[key];
        const overcap = character.stats[key] > maximum;
        fill.style.width = `${Math.max(8, Math.min(100,
          ((character.stats[key] - minimum) / (maximum - minimum)) * 100)).toFixed(0)}%`;
        fill.classList.toggle('is-overcap', overcap);
        createNode(this.doc, 'span', `online-loadout-stat-value${overcap ? ' is-overcap' : ''}`,
          row, `${Math.round(character.stats[key] * 100)}${overcap ? this.copy.common.max : ''}`);
      }
      if (!locked) {
        this._listen(button, 'click', () => this._updateLoadoutDraft({ characterId: character.id }));
      }
    }

    const paintGrid = root.querySelector('[data-loadout-paint-grid]');
    for (const paint of this.paints) {
      const localized = localizePaint(paint, this.language);
      const button = createNode(this.doc, 'button', 'online-loadout-paint-option', paintGrid);
      button.type = 'button';
      button.dataset.loadoutPaintId = paint.id;
      const swatch = createNode(this.doc, 'span', 'online-loadout-paint-swatch', button);
      swatch.style.background = `linear-gradient(135deg, ${cssColor(paint.color)} 52%, ${cssColor(paint.accentColor)} 52%)`;
      createNode(this.doc, 'strong', '', button, localized.name);
      this._listen(button, 'click', () => this._updateLoadoutDraft({ paintId: paint.id }));
    }

    const avatarGrid = root.querySelector('[data-loadout-avatar-grid]');
    for (const avatar of this.avatars) {
      const localized = localizeAvatar(avatar, this.language);
      const button = createNode(this.doc, 'button', 'online-loadout-avatar-option', avatarGrid);
      button.type = 'button';
      button.dataset.loadoutAvatarId = avatar.id;
      createNode(this.doc, 'span', 'online-loadout-avatar-glyph', button, avatar.glyph);
      createNode(this.doc, 'strong', '', button, localized.name);
      this._listen(button, 'click', () => this._updateLoadoutDraft({ avatarId: avatar.id }));
    }

    for (const button of root.querySelectorAll('[data-action="open-loadout"]')) {
      this._listen(button, 'click', (event) => this._openLoadoutDialog(event.currentTarget));
    }
    this._listen(root.querySelector('[data-action="close-loadout"]'), 'click', () => this._closeDialog());
    this._listen(root.querySelector('[data-action="cancel-loadout"]'), 'click', () => this._closeDialog());
    this._listen(root.querySelector('[data-form="loadout"]'), 'submit', (event) => {
      event.preventDefault();
      this._submitLoadout();
    });
    for (const tab of root.querySelectorAll('[data-loadout-tab]')) {
      this._listen(tab, 'click', () => this._setLoadoutTab(tab.dataset.loadoutTab));
    }

    const trackSelect = root.querySelector('[data-room-setting="trackId"]');
    for (const track of this.tracks) {
      const option = createNode(this.doc, 'option', '', trackSelect, track.name);
      option.value = track.id;
    }
    const difficultySelect = root.querySelector('[data-room-setting="difficulty"]');
    const autoFillAi = root.querySelector('[data-room-setting="autoFillAi"]');
    for (const [value, preset] of Object.entries(this.difficulties)) {
      const localized = localizeDifficulty(value, preset, this.language);
      const option = createNode(this.doc, 'option', '', difficultySelect, localized.label || value);
      option.value = value;
    }

    this._listen(trackSelect, 'change', () => {
      this._syncRoomTrackPreview(trackSelect.value);
      this._pendingAction = { kind: 'settings' };
      this._emit('onSetRoom', { trackId: trackSelect.value });
    });
    this._listen(difficultySelect, 'change', () => {
      this._pendingAction = { kind: 'settings' };
      this._emit('onSetRoom', { difficulty: difficultySelect.value });
    });
    this._listen(autoFillAi, 'change', () => {
      this._pendingAction = { kind: 'settings' };
      this._emit('onSetRoom', { autoFillAi: autoFillAi.checked });
    });
    this._listen(root.querySelector('[data-member-list]'), 'click', (event) => {
      const button = event.target.closest?.('[data-action="kick-player"]');
      if (!button || button.disabled) return;
      const member = this._roomView.members.find((candidate) => (
        candidate.participantId === button.dataset.participantId
      ));
      if (!member) return;
      this.showAlert(copy.kickMessage.replace('{name}', member.displayName), {
        title: copy.kickTitle,
        buttonLabel: copy.kickConfirm,
        cancelLabel: this.copy.online.alerts.cancel,
        restoreFocus: button,
        onConfirm: () => {
          this._pendingAction = { kind: 'kick' };
          this._emit('onKickPlayer', { participantId: member.participantId });
        },
      });
    });
    this._listen(root.querySelector('[data-action="ready"]'), 'click', () => {
      this._pendingAction = { kind: 'ready' };
      this._emit('onReadyChange', { ready: !this._roomView.localMember?.ready });
    });
    this._listen(root.querySelector('[data-action="start"]'), 'click', () => {
      this._pendingAction = { kind: 'start' };
      this._emit('onStartRace');
    });
    this._listen(root.querySelector('[data-action="leave"]'), 'click', () => this._emit('onLeaveRoom'));
    this._listen(root.querySelector('[data-action="copy"]'), 'click', () => this._copyInvite());
  }

  _sanitizeLoadout(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
      characterId: this.playableCharacterIds.has(source.characterId)
        ? source.characterId : this.defaultLoadout.characterId,
      paintId: this.paintById.has(source.paintId)
        ? source.paintId : this.defaultLoadout.paintId,
      avatarId: this.avatarById.has(source.avatarId)
        ? source.avatarId : this.defaultLoadout.avatarId,
    };
  }

  _memberLoadout(member = this._roomView.localMember) {
    return this._sanitizeLoadout(member);
  }

  _mountLoadoutPreview(host, loadout) {
    if (!host) return;
    this._previewHost = host;
    this._emit('onLoadoutPreviewMount', { host, loadout: { ...loadout } });
  }

  _updateLoadoutPreview(loadout) {
    if (!this._previewHost) return;
    this._emit('onLoadoutPreviewChange', { loadout: { ...loadout } });
  }

  _detachLoadoutPreview() {
    if (!this._previewHost) return;
    this._previewHost = null;
    this._emit('onLoadoutPreviewDetach');
  }

  _openLoadoutDialog(opener) {
    if (this._busy || this._pendingLoadout || !this._roomView.canManageRoom) return;
    const node = this.roots.room?.querySelector('[data-dialog="loadout"]');
    if (!node) return;
    this._closeDialog(false);
    this._loadoutDraft = this._memberLoadout();
    this._loadoutTab = 'racer';
    node.hidden = false;
    this._activeDialog = { name: 'loadout', node, opener };
    this._syncLoadoutDialog();
    this._mountLoadoutPreview(
      node.querySelector('[data-loadout-preview-host="dialog"]'),
      this._loadoutDraft,
    );
    node.querySelector('[data-loadout-tab="racer"]')?.focus();
  }

  _setLoadoutTab(tab) {
    if (!LOADOUT_TABS.has(tab) || this._pendingLoadout) return;
    this._loadoutTab = tab;
    this._syncLoadoutDialog();
  }

  _updateLoadoutDraft(patch) {
    if (this._activeDialog?.name !== 'loadout' || this._pendingLoadout) return;
    this._loadoutDraft = this._sanitizeLoadout({ ...this._loadoutDraft, ...patch });
    this._syncLoadoutDialog();
    this._updateLoadoutPreview(this._loadoutDraft);
  }

  _syncLoadoutDialog() {
    const node = this.roots.room?.querySelector('[data-dialog="loadout"]');
    if (!node) return;
    const character = this.characters.find((candidate) => candidate.id === this._loadoutDraft.characterId)
      || this.characters[0];
    const paint = this.paints.find((candidate) => candidate.id === this._loadoutDraft.paintId)
      || this.paints[0];
    const avatar = this.avatars.find((candidate) => candidate.id === this._loadoutDraft.avatarId)
      || this.avatars[0];
    node.querySelector('[data-draft-racer]').textContent = character?.name || '';
    node.querySelector('[data-draft-paint]').textContent = localizePaint(paint, this.language)?.name || '';
    node.querySelector('[data-draft-avatar]').textContent = localizeAvatar(avatar, this.language)?.name || '';
    node.querySelector('[data-loadout-avatar-glyph]').textContent = avatar?.glyph || '';

    for (const tab of node.querySelectorAll('[data-loadout-tab]')) {
      const active = tab.dataset.loadoutTab === this._loadoutTab;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      tab.disabled = Boolean(this._pendingLoadout);
    }
    for (const panel of node.querySelectorAll('[data-loadout-panel]')) {
      panel.hidden = panel.dataset.loadoutPanel !== this._loadoutTab;
    }
    for (const button of node.querySelectorAll('[data-loadout-character-id]')) {
      const selected = button.dataset.loadoutCharacterId === this._loadoutDraft.characterId;
      const locked = !this.playableCharacterIds.has(button.dataset.loadoutCharacterId);
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
      button.disabled = locked || Boolean(this._pendingLoadout);
    }
    for (const button of node.querySelectorAll('[data-loadout-paint-id]')) {
      const selected = button.dataset.loadoutPaintId === this._loadoutDraft.paintId;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
      button.disabled = Boolean(this._pendingLoadout);
    }
    for (const button of node.querySelectorAll('[data-loadout-avatar-id]')) {
      const selected = button.dataset.loadoutAvatarId === this._loadoutDraft.avatarId;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
      button.disabled = Boolean(this._pendingLoadout);
    }
    const unchanged = sameLoadout(this._loadoutDraft, this._memberLoadout());
    node.querySelector('[data-action="save-loadout"]').disabled = Boolean(this._pendingLoadout) || unchanged;
    node.querySelector('[data-action="cancel-loadout"]').disabled = Boolean(this._pendingLoadout);
    node.querySelector('[data-action="close-loadout"]').disabled = Boolean(this._pendingLoadout);
    node.setAttribute('aria-busy', String(Boolean(this._pendingLoadout)));
  }

  _submitLoadout() {
    if (this._activeDialog?.name !== 'loadout' || this._pendingLoadout) return;
    if (sameLoadout(this._loadoutDraft, this._memberLoadout())) {
      this._closeDialog();
      return;
    }
    this._pendingLoadout = { ...this._loadoutDraft };
    this._pendingAction = { kind: 'loadout' };
    this._syncLoadoutDialog();
    const sent = this._emit('onSetLoadout', { ...this._pendingLoadout });
    if (sent === false) {
      this._pendingLoadout = null;
      this._pendingAction = null;
      this._syncLoadoutDialog();
      this.presentError(this.copy.online.errors.generic, { action: 'loadout' });
    }
  }

  _syncRoomLoadoutSummary(loadout) {
    const root = this.roots.room;
    if (!root) return;
    const character = this.characters.find((candidate) => candidate.id === loadout.characterId)
      || this.characters[0];
    const paint = this.paints.find((candidate) => candidate.id === loadout.paintId)
      || this.paints[0];
    const avatar = this.avatars.find((candidate) => candidate.id === loadout.avatarId)
      || this.avatars[0];
    root.querySelector('[data-loadout-racer]').textContent = character?.name || '';
    root.querySelector('[data-loadout-paint]').textContent = localizePaint(paint, this.language)?.name || '';
    root.querySelector('[data-loadout-avatar]').textContent = localizeAvatar(avatar, this.language)?.name || '';
    root.querySelector('[data-loadout-preview-host="room"] [data-loadout-avatar-glyph]').textContent = avatar?.glyph || '';
    const swatch = root.querySelector('[data-loadout-paint-swatch]');
    if (swatch && paint) {
      swatch.style.background = `linear-gradient(135deg, ${cssColor(paint.color)} 52%, ${cssColor(paint.accentColor)} 52%)`;
    }
  }

  _buildResults() {
    const root = this.roots.results;
    if (!root) return;
    const copy = this.copy.online.results;
    const profileCopy = userCopy(this.language);
    root.innerHTML = `
      <div class="online-panel online-results-panel">
        <header class="online-results-header">
          <div>
            <p class="online-eyebrow">${copy.official}</p>
            <h2 class="online-heading" data-screen-heading tabindex="-1">${copy.heading}</h2>
            <p class="online-results-track" data-results-track></p>
          </div>
        </header>
        <div class="online-results-scroll">
          <table class="online-results-table">
            <thead><tr>
              <th scope="col">${copy.place}</th>
              <th scope="col">${copy.racer}</th>
              <th scope="col">${copy.time}</th>
              <th scope="col">${copy.bestLap}</th>
            </tr></thead>
            <tbody></tbody>
          </table>
        </div>
        <section class="online-progression-card" data-progression-card aria-live="polite">
          <p data-progression-status>${profileCopy.syncing}</p>
          <div class="online-progression-values" data-progression-values hidden>
            <strong data-progression-xp></strong>
            <strong data-progression-rating></strong>
            <span data-progression-level></span>
            <span data-progression-record></span>
          </div>
        </section>
        <p class="online-status" data-online-status role="status" aria-live="polite"></p>
        <p class="online-error" data-online-error role="alert" hidden></p>
        <footer class="online-results-actions">
          <button type="button" class="online-action online-action-primary" data-action="return">${copy.returnRoom}</button>
        </footer>
      </div>`;

    this._listen(root, 'keydown', (event) => this._handleScreenKeydown(event));
    this._listen(root.querySelector('[data-action="return"]'), 'click', () => this._emit('onReturnRoom'));
  }

  _handleScreenKeydown(event) {
    event.stopPropagation();
    const reconnectBackdrop = this.roots.room?.querySelector('[data-room-reconnect]');
    if (reconnectBackdrop && !reconnectBackdrop.hidden) {
      if (event.key === 'Tab' || event.key === 'Escape') event.preventDefault();
      reconnectBackdrop.querySelector('.online-room-reconnect')?.focus({ preventScroll: true });
      return;
    }
    if (!this._activeDialog) return;
    if (this._activeDialog.name === 'loadout'
      && event.target?.matches?.('[data-loadout-tab]')
      && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      const tabs = [...this._activeDialog.node.querySelectorAll('[data-loadout-tab]:not(:disabled)')];
      const current = tabs.indexOf(event.target);
      if (current >= 0 && tabs.length > 0) {
        const next = event.key === 'Home' ? 0
          : event.key === 'End' ? tabs.length - 1
            : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        event.preventDefault();
        this._setLoadoutTab(tabs[next].dataset.loadoutTab);
        tabs[next].focus();
        return;
      }
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this._closeDialog();
      return;
    }
    this._trapFocus(event, this._activeDialog.node);
  }

  _commitNickname(emitChange = false) {
    const input = this.roots.lobby?.querySelector('[data-field="nickname"]');
    const displayName = normalizeDisplayName(input?.value ?? this._displayName);
    if (!displayName) {
      this.showFieldError('nickname', this.copy.online.errors.nickname, { focus: true });
      return '';
    }
    this.clearFieldError('nickname');
    if (input) input.value = displayName;
    const changed = displayName !== this._displayName;
    this._displayName = displayName;
    if (changed && emitChange) this._emit('onNicknameChange', { displayName });
    return displayName;
  }

  _syncCreateRoomType() {
    const root = this.roots.lobby;
    if (!root) return;
    const isPrivate = root.querySelector('[data-create-field="roomType"]')?.value === 'private';
    const field = root.querySelector('[data-private-password-field]');
    const input = root.querySelector('[data-create-field="password"]');
    if (field) {
      field.hidden = false;
      field.classList.toggle('is-visible', isPrivate);
    }
    if (input) {
      input.required = isPrivate;
      if (!isPrivate) input.value = '';
    }
  }

  _syncCreateTrackPreview() {
    const root = this.roots.lobby;
    const select = root?.querySelector('[data-create-field="trackId"]');
    const preview = root?.querySelector('[data-create-track-preview]');
    if (!select || !preview) return;
    const track = this.trackById.get(select.value) || this.tracks[0] || null;
    preview.innerHTML = trackPreviewMarkup(track);
    preview.style.background = trackPreviewBackground(track);
    preview.title = track?.name || '';
  }

  _syncRoomTrackPreview(trackId) {
    const root = this.roots.room;
    const preview = root?.querySelector('[data-room-track-preview]');
    if (!preview) return;
    const track = this.trackById.get(trackId) || this.tracks[0] || null;
    preview.innerHTML = trackPreviewMarkup(track);
    preview.style.background = trackPreviewBackground(track);
    preview.title = track?.name || '';
    const name = root.querySelector('[data-room-track-name]');
    const description = root.querySelector('[data-room-track-description]');
    const laps = root.querySelector('[data-room-track-laps]');
    if (name) name.textContent = track?.name || '';
    if (description) description.textContent = localizeTrack(track, this.language)?.subtitle || '';
    if (laps) laps.textContent = formatCopy(this.copy.common.laps, { count: track?.laps ?? 3 });
  }

  _submitCreateRoom() {
    if (this._busy) return;
    const displayName = this._commitNickname(false);
    if (!displayName) return;
    const root = this.roots.lobby;
    const roomNameInput = root.querySelector('[data-create-field="roomName"]');
    const roomName = normalizeRoomName(roomNameInput.value);
    const roomType = root.querySelector('[data-create-field="roomType"]').value;
    const trackId = root.querySelector('[data-create-field="trackId"]')?.value || this.tracks[0]?.id;
    const maxPlayers = clampInteger(
      root.querySelector('[data-create-field="maxPlayers"]').value,
      ONLINE_ROOM_MIN_CAPACITY,
      ONLINE_ROOM_CAPACITY,
      ONLINE_ROOM_CAPACITY,
    );
    const password = root.querySelector('[data-create-field="password"]').value;
    if (!roomName) {
      this.showFieldError('create-room-name', this.copy.online.errors.ROOM_NAME_INVALID, { focus: true });
      return;
    }
    if (!ROOM_TYPES.has(roomType)) {
      this.showFieldError('create-room-type', this.copy.online.errors.ROOM_TYPE_INVALID, { focus: true });
      return;
    }
    if (roomType === 'private' && !isValidRoomPassword(password)) {
      this.showFieldError('create-password', this.copy.online.errors.PASSWORD_REQUIRED, { focus: true });
      return;
    }
    const payload = { displayName, roomName, roomType, maxPlayers, trackId };
    if (roomType === 'private') payload.password = password;
    this._pendingAction = { kind: 'create' };
    this._emit('onCreateRoom', payload);
  }

  _submitQuickMatch() {
    if (this._busy) return;
    const displayName = this._commitNickname(false);
    if (!displayName) return;
    this._pendingAction = { kind: 'quick' };
    this._emit('onQuickMatch', { displayName });
  }

  _openJoinDialog(room, opener) {
    if (this._busy) return;
    const root = this.roots.lobby;
    root.querySelector('[data-join-room-name]').textContent = room.roomName;
    root.querySelector('[data-join-room-code]').textContent = room.roomCode;
    root.querySelector('[data-join-field="password"]').value = '';
    this._openDialog('join', opener, room);
  }

  _submitPrivateJoin() {
    const room = this._activeDialog?.room;
    if (!room || this._busy) return;
    const passwordInput = this.roots.lobby.querySelector('[data-join-field="password"]');
    if (!isValidRoomPassword(passwordInput.value)) {
      this.showFieldError('join-password', this.copy.online.errors.PASSWORD_REQUIRED, { focus: true });
      return;
    }
    this._submitJoinRoom(room, passwordInput.value);
  }

  _submitJoinRoom(room, password) {
    if (!room?.joinable || this._busy) return;
    const displayName = this._commitNickname(false);
    if (!displayName) return;
    const payload = { displayName, roomCode: room.roomCode };
    if (room.requiresPassword) payload.password = String(password ?? '');
    this._pendingAction = { kind: 'join', roomCode: room.roomCode };
    this._emit('onJoinRoom', payload);
  }

  _openDialog(name, opener, room = null) {
    this._closeDialog(false);
    const node = this.roots.lobby?.querySelector(`[data-dialog="${name}"]`)
      || this.roots.room?.querySelector(`[data-dialog="${name}"]`);
    if (!node) return;
    node.hidden = false;
    this._activeDialog = { name, node, opener, room };
    this._clearDialogFieldErrors(name);
    const first = node.querySelector('input:not([type="hidden"]), select, button');
    first?.focus();
  }

  _closeDialog(restoreFocus = true) {
    if (!this._activeDialog) return;
    const { name, node, opener } = this._activeDialog;
    if (name === 'loadout' && this._pendingLoadout && restoreFocus) return;
    for (const password of node.querySelectorAll('input[type="password"]')) password.value = '';
    this._clearDialogFieldErrors(name);
    node.hidden = true;
    this._activeDialog = null;
    if (name === 'loadout') {
      if (!restoreFocus) this._pendingLoadout = null;
      this._loadoutDraft = this._memberLoadout();
      if (this._screen === 'room' && !this.roots.room?.hidden) {
        this._mountLoadoutPreview(
          this.roots.room.querySelector('[data-loadout-preview-host="room"]'),
          this._loadoutDraft,
        );
      } else {
        this._detachLoadoutPreview();
      }
    }
    const rootVisible = name === 'loadout' ? !this.roots.room?.hidden : !this.roots.lobby?.hidden;
    if (restoreFocus && opener?.isConnected && rootVisible) opener.focus();
  }

  _refreshLobbyView() {
    this._lobbyView = buildLobbyView(this._lobbyState, {
      search: this._lobbySearch,
      inviteRoomCode: this._inviteRoomCode,
      tracks: this.tracks,
      copy: this.copy,
    });
    this._renderLobbyRooms(this._lobbyView);
    this._syncLobbyCount(this._lobbyView);
    return this._lobbyView;
  }

  _renderLobbyRooms(view) {
    const root = this.roots.lobby;
    const list = root?.querySelector('[data-room-list]');
    if (!list) return;
    list.innerHTML = '';
    this._lobbyRoomByCode = new Map(view.allRooms.map((room) => [room.roomCode, room]));
    const copy = this.copy.online.lobby;
    if (!view.rooms.length) {
      const empty = createNode(this.doc, 'div', 'online-room-list-empty', list);
      empty.setAttribute('role', 'status');
      createNode(this.doc, 'span', 'online-room-list-empty-icon', empty, '\u{1F3C1}');
      createNode(
        this.doc,
        'strong',
        '',
        empty,
        view.totalRooms ? copy.noSearchResults : copy.noRooms,
      );
      createNode(
        this.doc,
        'span',
        '',
        empty,
        view.totalRooms ? copy.tryAnotherSearch : copy.noRoomsHint,
      );
      return;
    }

    for (const room of view.rooms) {
      const card = createNode(
        this.doc,
        'article',
        `online-room-list-item is-${room.status}${room.isInvited ? ' is-invited' : ''}`,
        list,
      );
      card.setAttribute('role', 'listitem');
      card.dataset.roomCode = room.roomCode;
      const title = createNode(this.doc, 'div', 'online-room-list-title', card);
      const titleLine = createNode(this.doc, 'div', 'online-room-list-title-line', title);
      const type = createNode(
        this.doc,
        'span',
        `online-room-type is-${room.roomType}`,
        titleLine,
        room.roomType === 'private' ? copy.privateBadge : copy.publicBadge,
      );
      type.title = room.requiresPassword ? copy.passwordRequired : copy.noPasswordRequired;
      createNode(this.doc, 'h4', '', titleLine, room.roomName);
      createNode(this.doc, 'span', 'online-room-list-code', title, room.roomCode);

      const track = createNode(this.doc, 'div', 'online-room-list-track', card);
      const trackPreview = createNode(this.doc, 'span', 'online-room-track-preview', track);
      trackPreview.innerHTML = trackPreviewMarkup(room.track);
      trackPreview.style.background = trackPreviewBackground(room.track);
      const trackCopy = createNode(this.doc, 'span', 'online-room-track-copy', track);
      createNode(this.doc, 'small', '', trackCopy, copy.track);
      createNode(this.doc, 'strong', '', trackCopy, room.trackName);

      const facts = createNode(this.doc, 'dl', 'online-room-facts', card);
      const playerFact = createNode(this.doc, 'div', '', facts);
      createNode(this.doc, 'dt', '', playerFact, copy.players);
      createNode(this.doc, 'dd', '', playerFact, `${room.playerCount}/${room.maxPlayers}`);
      const hostFact = createNode(this.doc, 'div', '', facts);
      createNode(this.doc, 'dt', '', hostFact, copy.host);
      createNode(this.doc, 'dd', '', hostFact, room.hostDisplayName);

      const action = createNode(this.doc, 'div', 'online-room-list-action', card);
      const status = createNode(
        this.doc,
        'span',
        `online-room-status is-${room.status}`,
        action,
        copy.status[room.status],
      );
      status.setAttribute('aria-label', `${copy.statusLabel}: ${copy.status[room.status]}`);
      const join = createNode(this.doc, 'button', 'online-action online-room-join', action, copy.join);
      join.type = 'button';
      join.dataset.action = 'join-room';
      join.dataset.roomCode = room.roomCode;
      join.disabled = this._busy || !room.joinable;
      if (!room.joinable) {
        join.title = room.status === 'full' ? copy.roomFull : copy.roomInGame;
      } else if (room.requiresPassword) {
        join.setAttribute('aria-label', `${copy.join} ${room.roomName}. ${copy.passwordRequired}`);
      }
    }

    if (view.invitedRoom && view.inviteRoomCode !== this._locatedInviteCode) {
      this._locatedInviteCode = view.inviteRoomCode;
      const invited = [...list.querySelectorAll('[data-room-code]')]
        .find((node) => node.dataset.roomCode === view.inviteRoomCode);
      invited?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    }
  }

  _syncLobbyCount(view) {
    const copy = this.copy.online.lobby;
    const node = this.roots.lobby?.querySelector('[data-room-count]');
    if (!node) return;
    node.textContent = view.search
      ? copy.searchCount.replace('{count}', String(view.rooms.length))
      : copy.roomCount.replace('{count}', String(view.totalRooms));
  }

  async _copyInvite() {
    const url = buildInviteUrl(this._roomView.roomCode, this.location);
    if (!url) return;
    try {
      if (!this.navigator?.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await this.navigator.clipboard.writeText(url);
      this.showToast(this.copy.online.room.copied);
    } catch {
      const fallback = createNode(this.doc, 'textarea', 'online-copy-fallback', this.roots.room, url);
      fallback.setAttribute('readonly', '');
      fallback.select();
      let copied = false;
      try { copied = Boolean(this.doc.execCommand?.('copy')); } catch { copied = false; }
      fallback.remove();
      if (copied) this.showToast(this.copy.online.room.copyFallback);
      else this.presentError(this.copy.online.room.copyFailed, { action: 'copy' });
    }
  }

  _show(name) {
    this._closeDialog(false);
    if (name !== 'room') this._detachLoadoutPreview();
    for (const [key, root] of Object.entries(this.roots)) {
      if (root) root.hidden = key !== name;
    }
    this._screen = name;
    this._pendingAction = null;
    this.roots[name]?.querySelector('[data-screen-heading]')?.focus({ preventScroll: true });
  }

  showLobby(lobbyState = {}, context = {}) {
    this._show('lobby');
    return this.updateLobby(lobbyState, context);
  }

  updateLobby(lobbyState = this._lobbyState, context = {}) {
    this._lobbyState = lobbyState || {};
    if (context.displayName !== undefined) {
      this._displayName = normalizeDisplayName(context.displayName);
      const input = this.roots.lobby?.querySelector('[data-field="nickname"]');
      if (input && this.doc.activeElement !== input) input.value = this._displayName;
    }
    if (context.userProfile !== undefined) this._userProfile = context.userProfile;
    this._renderUserProfile();
    if (!this._createFormInitialized) {
      const root = this.roots.lobby;
      const roomName = root?.querySelector('[data-create-field="roomName"]');
      const roomType = root?.querySelector('[data-create-field="roomType"]');
      const maxPlayers = root?.querySelector('[data-create-field="maxPlayers"]');
      const trackId = root?.querySelector('[data-create-field="trackId"]');
      const password = root?.querySelector('[data-create-field="password"]');
      if (roomName) roomName.value = defaultRoomName(this.copy);
      if (roomType) roomType.value = 'public';
      if (maxPlayers) maxPlayers.value = String(ONLINE_ROOM_CAPACITY);
      if (trackId && this.tracks[0]) trackId.value = this.tracks[0].id;
      if (password) password.value = '';
      this._createFormInitialized = true;
      this._syncCreateRoomType();
      this._syncCreateTrackPreview();
    }
    if (context.inviteRoomCode !== undefined || context.roomCode !== undefined) {
      const nextInvite = normalizeRoomCode(firstDefined(context.inviteRoomCode, context.roomCode, ''));
      if (nextInvite !== this._inviteRoomCode) this._locatedInviteCode = '';
      this._inviteRoomCode = nextInvite;
    }
    if (context.search !== undefined) {
      this._lobbySearch = String(context.search || '');
      const search = this.roots.lobby?.querySelector('[data-field="search"]');
      if (search && this.doc.activeElement !== search) search.value = this._lobbySearch;
    }
    const view = this._refreshLobbyView();
    if (context.status !== undefined) this.showToast(context.status);
    if (context.error) this.presentError(context.error, context.errorContext);
    this._syncBusyState();
    return view;
  }

  showRoom(roomState = {}, context = {}) {
    this._show('room');
    return this.updateRoom(roomState, context);
  }

  setRoomReconnecting(reconnecting, { restoreFocus = true } = {}) {
    const root = this.roots.room;
    const content = root?.querySelector('[data-room-content]');
    const backdrop = root?.querySelector('[data-room-reconnect]');
    const panel = backdrop?.querySelector('.online-room-reconnect');
    if (!root || !content || !backdrop || !panel) return false;

    const next = Boolean(reconnecting);
    if (next === !backdrop.hidden) return false;
    if (next) {
      this._roomReconnectFocus = this.doc.activeElement;
      backdrop.hidden = false;
      panel.focus({ preventScroll: true });
      content.setAttribute('inert', '');
      content.setAttribute('aria-hidden', 'true');
    } else {
      content.removeAttribute('inert');
      content.removeAttribute('aria-hidden');
      backdrop.hidden = true;
      const previous = this._roomReconnectFocus;
      this._roomReconnectFocus = null;
      if (restoreFocus && this._screen === 'room' && previous?.isConnected) previous.focus();
    }
    return true;
  }

  updateRoom(roomState = this._roomState, context = {}) {
    this._roomState = roomState || {};
    if (context.localParticipantId !== undefined) {
      this._localParticipantId = String(context.localParticipantId || '');
    }
    const view = buildRoomView(this._roomState, this._localParticipantId, { copy: this.copy });
    this._roomView = view;
    const root = this.roots.room;
    if (!root) return view;
    const copy = this.copy.online.room;
    const authoritativeLoadout = this._memberLoadout(view.localMember);
    if (this._pendingLoadout && sameLoadout(authoritativeLoadout, this._pendingLoadout)) {
      const committed = { ...this._pendingLoadout };
      this._pendingLoadout = null;
      this._pendingAction = null;
      this._loadoutDraft = committed;
      this._emit('onLoadoutCommitted', committed);
      if (this._activeDialog?.name === 'loadout') this._closeDialog();
    } else if (this._activeDialog?.name === 'loadout' && !view.canManageRoom) {
      this._closeDialog(false);
    }
    this._syncRoomLoadoutSummary(authoritativeLoadout);
    if (this._activeDialog?.name === 'loadout') {
      this._syncLoadoutDialog();
      this._updateLoadoutPreview(this._loadoutDraft);
    } else if (this._screen === 'room') {
      this._mountLoadoutPreview(
        root.querySelector('[data-loadout-preview-host="room"]'),
        authoritativeLoadout,
      );
    }
    root.querySelector('[data-room-name]').textContent = view.roomName;
    const type = root.querySelector('[data-room-type]');
    type.textContent = view.roomType === 'private' ? copy.privateRoom : copy.publicRoom;
    type.className = `online-room-type is-${view.roomType}`;
    root.querySelector('[data-room-players]').textContent = copy.playerCount
      .replace('{count}', String(view.playerCount))
      .replace('{max}', String(view.maxPlayers));
    root.querySelector('[data-room-code]').textContent = view.roomCode || '------';
    root.querySelector('[data-action="copy"]').disabled = !view.roomCode;

    const memberList = root.querySelector('[data-member-list]');
    memberList.innerHTML = '';
    const sortedMembers = view.members.slice().sort((a, b) => a.joinOrder - b.joinOrder);
    for (let index = 0; index < view.maxPlayers; index += 1) {
      const member = sortedMembers[index];
      const canKick = Boolean(member && view.isHost && view.phase === 'waiting' && !member.isLocal);
      const item = createNode(
        this.doc,
        'li',
        `online-member${member?.isLocal ? ' is-local' : ''}${member && !member.connected ? ' is-disconnected' : ''}${member ? '' : ' is-empty'}${canKick ? ' can-kick' : ''}`,
        memberList,
      );
      createNode(this.doc, 'span', 'online-member-slot', item, String(index + 1).padStart(2, '0'));
      if (!member) {
        createNode(this.doc, 'span', 'online-member-name', item, copy.openSlot);
        continue;
      }
      const identity = createNode(this.doc, 'span', 'online-member-identity', item);
      const name = createNode(this.doc, 'span', 'online-member-name', identity, member.displayName);
      if (member.isLocal) createNode(this.doc, 'span', 'online-mini-chip', name, copy.you);
      if (member.isHost) createNode(this.doc, 'span', 'online-mini-chip is-host', name, copy.host);
      const character = this.characterById.get(member.characterId);
      const loadout = createNode(this.doc, 'span', 'online-member-loadout', identity);
      const memberLoadout = this._sanitizeLoadout(member);
      const avatar = this.avatarById.get(memberLoadout.avatarId);
      const paint = this.paintById.get(memberLoadout.paintId);
      createNode(this.doc, 'span', 'online-member-avatar', loadout, avatar?.glyph || '\u{1F3CE}\u{FE0F}');
      const paintDot = createNode(this.doc, 'span', 'online-member-paint', loadout);
      paintDot.style.background = paint ? cssColor(paint.color) : 'currentColor';
      createNode(this.doc, 'span', 'online-member-character', loadout, character?.name || copy.choosing);
      const badges = createNode(this.doc, 'span', 'online-member-badges', item);
      const inGame = member.activityState === 'in_game';
      const ready = createNode(
        this.doc,
        'span',
        `online-ready-chip${member.connected && member.ready ? ' is-ready' : ''}${member.connected && inGame ? ' is-in-game' : ''}${!member.connected ? ' is-reconnecting' : ''}`,
        badges,
        !member.connected
          ? copy.reconnecting
          : inGame
            ? copy.inGame
            : member.ready ? copy.ready : copy.notReady,
      );
      ready.title = member.connected ? '' : copy.reconnectingHint;
      if (canKick) {
        const kick = createNode(this.doc, 'button', 'online-member-kick', item, '\u00d7');
        kick.type = 'button';
        kick.dataset.action = 'kick-player';
        kick.dataset.participantId = member.participantId;
        kick.disabled = this._busy;
        kick.setAttribute('aria-label', copy.kickPlayer.replace('{name}', member.displayName));
        kick.title = copy.kickPlayer.replace('{name}', member.displayName);
      }
    }

    for (const button of root.querySelectorAll('[data-action="open-loadout"]')) {
      button.disabled = this._busy || Boolean(this._pendingLoadout) || !view.canManageRoom;
    }

    const trackSelect = root.querySelector('[data-room-setting="trackId"]');
    const difficultySelect = root.querySelector('[data-room-setting="difficulty"]');
    const autoFillAi = root.querySelector('[data-room-setting="autoFillAi"]');
    trackSelect.value = view.trackId;
    this._syncRoomTrackPreview(view.trackId);
    difficultySelect.value = view.difficulty;
    autoFillAi.checked = view.autoFillAi;
    trackSelect.disabled = this._busy || !view.isHost || !view.canManageRoom;
    difficultySelect.disabled = this._busy || !view.isHost || !view.canManageRoom;
    autoFillAi.disabled = this._busy || !view.isHost || !view.canManageRoom;
    root.querySelector('[data-host-note]').textContent = view.isHost
      ? copy.hostControls
      : copy.hostOnly;

    const ready = root.querySelector('[data-action="ready"]');
    ready.textContent = view.localMember?.ready ? copy.cancelReady : copy.readyUp;
    ready.classList.toggle('is-active', Boolean(view.localMember?.ready));
    ready.disabled = this._busy
      || Boolean(this._pendingLoadout)
      || !view.canManageRoom
      || !view.localMember?.connected
      || !view.localMember?.characterId;
    const start = root.querySelector('[data-action="start"]');
    start.hidden = !view.isHost;
    start.disabled = this._busy || Boolean(this._pendingLoadout) || !view.canStart;
    root.querySelector('[data-action="leave"]').disabled = this._busy;

    const status = roomStatusMessage(view, copy);
    root.querySelector('[data-room-status]').textContent = String(context.status ?? status);
    if (context.error) this.presentError(context.error, context.errorContext);
    return view;
  }

  showResults(resultState = {}, context = {}) {
    this._show('results');
    return this.updateResults(resultState, context);
  }

  updateResults(resultState = this._resultsState, context = {}) {
    this._resultsState = resultState || {};
    if (context.localParticipantId !== undefined) {
      this._localParticipantId = String(context.localParticipantId || '');
    }
    if (context.progression !== undefined) this._progressionState = context.progression;
    const merged = {
      ...this._resultsState,
      ...(context.trackName === undefined ? {} : { trackName: context.trackName }),
      ...(context.autoReturnSeconds === undefined ? {} : { autoReturnSeconds: context.autoReturnSeconds }),
    };
    const view = buildOnlineResultsView(merged, this._localParticipantId, { copy: this.copy });
    const root = this.roots.results;
    if (!root) return view;
    root.querySelector('[data-results-track]').textContent = view.trackName;
    const body = root.querySelector('tbody');
    body.innerHTML = '';
    view.standings.forEach((result, index) => {
      const row = createNode(this.doc, 'tr', result.isLocal ? 'is-local' : '', body);
      row.style.setProperty('--row-i', index);
      const place = createNode(this.doc, 'td', 'online-result-rank', row);
      place.textContent = result.rank <= 3 ? MEDALS[result.rank - 1] : formatOrdinal(result.rank, this.language);
      const racer = createNode(this.doc, 'td', 'online-result-racer', row);
      const resultLoadout = this._sanitizeLoadout(result);
      const avatar = this.avatarById.get(resultLoadout.avatarId);
      const paint = this.paintById.get(resultLoadout.paintId);
      createNode(this.doc, 'span', 'online-result-avatar', racer, avatar?.glyph || '\u{1F3CE}\u{FE0F}');
      const paintDot = createNode(this.doc, 'span', 'online-result-paint', racer);
      paintDot.style.background = paint ? cssColor(paint.color) : 'currentColor';
      createNode(this.doc, 'span', 'online-result-name', racer, result.displayName);
      if (result.isLocal) createNode(this.doc, 'span', 'online-mini-chip', racer, this.copy.online.room.you);
      createNode(this.doc, 'td', 'online-result-time', row, result.finished ? formatOnlineTime(result.finishTime) : 'DNF');
      createNode(this.doc, 'td', 'online-result-time', row, formatOnlineTime(result.bestLap));
    });
    const countdown = view.autoReturnSeconds === null
      ? ''
      : this.copy.online.results.autoReturn.replace(
        '{seconds}',
        String(Math.max(0, Math.ceil(view.autoReturnSeconds))),
      );
    const statusText = context.status ?? '';
    const fullStatus = [statusText, countdown].filter(Boolean).join(' ');
    this.showStatus(fullStatus, 'results');
    if (context.error) this.showError(context.error, 'results');
    else if (context.clearError) this.clearError('results');
    root.querySelector('[data-action="return"]').disabled = this._busy;
    this._renderProgression();
    return view;
  }

  updateUserProfile(profile) {
    this._userProfile = profile || null;
    this._renderUserProfile();
  }

  updateProgression(progression) {
    this._progressionState = progression || null;
    this._renderProgression();
  }

  _renderUserProfile() {
    const root = this.roots.lobby;
    if (!root) return;
    const profile = this._userProfile;
    const user = profile?.user || {};
    const stats = profile?.stats || {};
    const level = Math.max(1, Math.trunc(Number(user.level) || 1));
    const rating = Math.max(0, Math.trunc(Number(user.rating) || 0));
    const currentXp = Math.max(0, Number(user.currentLevelXp) || 0);
    const nextXp = Math.max(1, Number(user.nextLevelXp) || 1);
    const levelBadge = root.querySelector('[data-profile-level-badge]');
    const ratingBadge = root.querySelector('[data-profile-rating-badge]');
    if (levelBadge) levelBadge.textContent = profile ? `LV ${level}` : 'LV --';
    if (ratingBadge) ratingBadge.textContent = profile ? `R ${rating}` : 'R ----';
    const levelNode = root.querySelector('[data-profile-level]');
    const ratingNode = root.querySelector('[data-profile-rating]');
    if (levelNode) levelNode.textContent = `LV ${level}`;
    if (ratingNode) ratingNode.textContent = String(rating);
    const progress = root.querySelector('[data-profile-progress]');
    if (progress) progress.style.width = `${Math.min(100, currentXp / nextXp * 100)}%`;
    const xp = root.querySelector('[data-profile-xp]');
    if (xp) xp.textContent = `${Math.trunc(currentXp)} / ${Math.trunc(nextXp)} XP`;
    for (const key of ['races', 'finishes', 'escapes', 'firsts', 'seconds', 'thirds']) {
      const node = root.querySelector(`[data-profile-stat="${key}"]`);
      if (node) node.textContent = String(Math.max(0, Math.trunc(Number(stats[key]) || 0)));
    }
    for (const key of ['completionRate', 'escapeRate']) {
      const node = root.querySelector(`[data-profile-stat="${key}"]`);
      if (node) node.textContent = formatRate(stats[key]);
    }
    const records = root.querySelector('[data-profile-records]');
    if (records) {
      records.innerHTML = '';
      const recordByTrack = new Map((profile?.trackBestTimes || []).map((record) => [record.trackId, record]));
      for (const track of this.tracks) {
        const row = createNode(this.doc, 'div', 'online-profile-record', records);
        createNode(this.doc, 'span', '', row, localizeTrack(track, this.language)?.name || track.name);
        createNode(this.doc, 'strong', '', row, formatProfileBestTime(
          recordByTrack.get(track.id)?.finishTimeMs,
          userCopy(this.language).noRecord,
        ));
      }
    }
  }

  _renderProgression() {
    const root = this.roots.results;
    if (!root) return;
    const copy = userCopy(this.language);
    const progression = this._progressionState;
    const status = root.querySelector('[data-progression-status]');
    const values = root.querySelector('[data-progression-values]');
    if (!progression || progression.status === 'pending') {
      if (status) status.textContent = copy.syncing;
      if (values) values.hidden = true;
      return;
    }
    if (progression.status === 'error') {
      if (status) status.textContent = copy.failed;
      if (values) values.hidden = true;
      return;
    }
    if (status) status.textContent = '';
    if (values) values.hidden = false;
    const xp = root.querySelector('[data-progression-xp]');
    const rating = root.querySelector('[data-progression-rating]');
    const level = root.querySelector('[data-progression-level]');
    const record = root.querySelector('[data-progression-record]');
    const ratingDelta = Math.trunc(Number(progression.ratingDelta) || 0);
    if (xp) xp.textContent = `+${Math.max(0, Math.trunc(Number(progression.xpDelta) || 0))} XP`;
    if (rating) rating.textContent = ratingDelta === 0
      ? copy.unchanged
      : `${copy.rating} ${ratingDelta > 0 ? '+' : ''}${ratingDelta}`;
    if (level) level.textContent = progression.levelAfter > progression.levelBefore
      ? formatCopy(copy.levelUp, { level: progression.levelAfter })
      : '';
    if (record) record.textContent = progression.bestTimeUpdated ? copy.newRecord : '';
  }

  setBusy(busy) {
    this._busy = Boolean(busy);
    this._syncBusyState();
  }

  _syncBusyState() {
    for (const root of Object.values(this.roots)) {
      if (!root) continue;
      root.setAttribute('aria-busy', String(this._busy));
      for (const button of root.querySelectorAll('[data-busy-action]')) {
        button.disabled = this._busy;
      }
    }
    if (this.roots.lobby) this._renderLobbyRooms(this._lobbyView);
    if (this.roots.room && Object.keys(this._roomState).length) {
      this.updateRoom(this._roomState, { localParticipantId: this._localParticipantId });
    }
    const resultButton = this.roots.results?.querySelector('[data-action="return"]');
    if (resultButton) resultButton.disabled = this._busy;
  }

  showStatus(message, screen = this._screen) {
    if (screen === 'lobby') {
      this.showToast(message);
      return;
    }
    const node = screen === 'room'
      ? this.roots.room?.querySelector('[data-room-status]')
      : this.roots[screen]?.querySelector('[data-online-status]');
    if (node) node.textContent = String(message || '');
  }

  showError(message, screen = this._screen) {
    if (screen !== 'results') {
      this.presentError(message);
      return;
    }
    const node = this.roots[screen]?.querySelector('[data-online-error]');
    if (!node) return;
    const errors = this.copy.online.errors;
    const code = typeof message === 'string' ? message : message?.code;
    const fallback = typeof message === 'string' ? message : message?.message;
    node.textContent = String(errors[code] || fallback || errors.generic);
    node.hidden = false;
  }

  clearError(screen = this._screen) {
    const node = this.roots[screen]?.querySelector('[data-online-error]');
    if (!node) return;
    node.textContent = '';
    node.hidden = true;
  }

  isTextEntryActive() {
    const active = this.doc.activeElement;
    if (!active) return false;
    const tag = active.tagName?.toLowerCase();
    if (!['input', 'textarea', 'select'].includes(tag)) return false;
    return Object.values(this.roots).some((root) => root?.contains(active));
  }

  /** Integration helper for global keyboard handlers. */
  ownsKeyboardEvent(event) {
    const target = event?.target;
    if (!target) return this.isTextEntryActive();
    const tag = target.tagName?.toLowerCase();
    return ['input', 'textarea', 'select'].includes(tag)
      && Object.values(this.roots).some((root) => root?.contains(target));
  }

  hideAll() {
    this._closeDialog(false);
    this._detachLoadoutPreview();
    this.dismissAlert(false);
    this.setRoomReconnecting(false, { restoreFocus: false });
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = null;
    if (this._sharedUi?.toast) {
      this._sharedUi.toast.hidden = true;
      this._sharedUi.toast.classList.remove('is-showing');
    }
    for (const root of Object.values(this.roots)) {
      if (root) root.hidden = true;
    }
    this._screen = null;
    this._pendingAction = null;
  }

  dispose() {
    for (const remove of this._listeners.splice(0)) remove();
    this.hideAll();
    this._sharedUi?.host.remove();
    this._sharedUi = null;
  }
}
