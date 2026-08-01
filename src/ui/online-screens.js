// Lobby directory, pre-race room and authoritative online results screens.
//
// The network/application layer owns transport and navigation. This module only
// normalizes server payloads, renders them, and emits user intent callbacks.
// Keeping the view-model helpers free of DOM access makes protocol/UI behavior
// straightforward to exercise with Node's built-in test runner.

import { DIFFICULTY } from '../core/constants.js';
import { CHARACTERS } from '../game/characters.js';
import { onlineErrorMessage } from '../net/online-flow.js';
import { ERROR_CODES, validateRoomPassword } from '../net/protocol.js';
import { TRACKS } from '../track/tracks.js';
import { UI_COPY } from './copy.js';

export const ONLINE_ROOM_CAPACITY = 8;
export const ONLINE_ROOM_MIN_CAPACITY = 2;
export const ONLINE_ROOM_CODE_LENGTH = 6;
export const ONLINE_ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const ROOM_CODE_CHARS = new Set(ONLINE_ROOM_CODE_ALPHABET);
const ROOM_TYPES = new Set(['public', 'private']);
const IN_GAME_PHASES = new Set(['loading', 'countdown', 'racing', 'race', 'results', 'in_game', 'ingame']);
const MEDALS = ['\u{1F947}', '\u{1F948}', '\u{1F949}'];
const ERROR_COPY_KEYS = new Map(Object.entries(ERROR_CODES).map(([key, value]) => [value, key]));

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

function ordinal(rank) {
  const n = Math.max(1, Math.trunc(Number(rank) || 1));
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  if (n % 10 === 1) return `${n}st`;
  if (n % 10 === 2) return `${n}nd`;
  if (n % 10 === 3) return `${n}rd`;
  return `${n}th`;
}

function statusSortOrder(room) {
  if (room.joinable) return 0;
  if (room.status === 'full') return 1;
  if (room.status === 'in_game') return 2;
  return 3;
}

function defaultRoomName(displayName) {
  const name = normalizeDisplayName(displayName);
  return normalizeRoomName(name ? `${name}'s Room` : UI_COPY.online.lobby.defaultRoomName);
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

/**
 * Normalize lobby_state into searchable, sorted room cards. Search matches room
 * name, host display name, and room code without treating names as identities.
 */
export function buildLobbyView(lobbyState = {}, options = {}) {
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

  const rooms = (Array.isArray(rawRooms) ? rawRooms : []).map((room, index) => {
    const roomCode = normalizeRoomCode(firstDefined(room.roomCode, room.code, ''));
    const maxPlayers = roomCapacityOf(room);
    const memberFallback = Array.isArray(room.members) ? room.members.length : 0;
    const playerCount = Math.min(maxPlayers, roomPlayerCountOf(room, memberFallback));
    const roomType = roomTypeOf(room);
    const status = roomStatusOf(room, playerCount, maxPlayers);
    const roomName = normalizeRoomName(firstDefined(room.roomName, room.name, ''))
      || roomCode
      || UI_COPY.online.lobby.unnamedRoom;
    const hostDisplayName = normalizeDisplayName(firstDefined(
      room.hostDisplayName,
      room.hostName,
      room.host?.displayName,
      '',
    )) || UI_COPY.online.lobby.unknownHost;
    const requiresPassword = room.requiresPassword === true || roomType === 'private';
    const joinable = status === 'waiting' && room.joinable !== false;
    const isInvited = Boolean(inviteRoomCode && roomCode === inviteRoomCode);
    const haystack = `${roomName}\n${hostDisplayName}\n${roomCode}`.toLocaleLowerCase();
    const matchesSearch = !normalizedSearch || haystack.includes(normalizedSearch) || isInvited;
    return {
      roomCode,
      roomName,
      roomType,
      requiresPassword,
      playerCount,
      maxPlayers,
      hostDisplayName,
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
export function buildRoomView(roomState = {}, localParticipantId = '') {
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
      displayName: String(firstDefined(member.displayName, member.nickname, member.name, `Racer ${index + 1}`)),
      characterId: String(firstDefined(member.characterId, member.character?.id, '')),
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
  const occupiedCharacterIds = members.map((member) => member.characterId).filter(Boolean);
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
      || UI_COPY.online.room.unnamedRoom,
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
    occupiedCharacterIds,
    trackId: String(firstDefined(settings.trackId, roomState.trackId, TRACKS[0]?.id, '')),
    difficulty: String(firstDefined(settings.difficulty, roomState.difficulty, 'normal')),
  };
}

export function roomStatusMessage(view, copy = UI_COPY.online.room) {
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
export function buildOnlineResultsView(resultState = {}, localParticipantId = '') {
  const rawRows = firstDefined(resultState.standings, resultState.results, []);
  const standings = Array.isArray(rawRows) ? rawRows.map((row, index) => {
    const participantId = participantIdOf(row);
    const finishTime = finiteNumber(row.finishTime, row.totalTime, row.time);
    const bestLap = finiteNumber(row.bestLap, row.bestLapTime);
    const finished = row.finished !== false && finishTime !== null;
    return {
      participantId,
      displayName: String(firstDefined(row.displayName, row.nickname, row.name, `Racer ${index + 1}`)),
      characterId: String(firstDefined(row.characterId, row.character?.id, '')),
      rank: Math.max(1, Math.trunc(finiteNumber(row.rank, row.position, index + 1) ?? index + 1)),
      finishTime,
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
    this.characters = options.characters || CHARACTERS;
    this.tracks = options.tracks || TRACKS;
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
    this._lobbyView = buildLobbyView();
    this._lobbyRoomByCode = new Map();
    this._roomState = {};
    this._roomView = buildRoomView();
    this._resultsState = {};
    this._localParticipantId = '';
    this._activeDialog = null;
    this._activeAlert = null;
    this._activeMenu = null;
    this._roomReconnectFocus = null;
    this._pendingAction = null;
    this._toastTimer = null;
    this._sharedUi = null;

    this._buildLobby();
    this._buildRoom();
    this._buildResults();
    this._buildSharedUi();
  }

  get activeScreen() { return this._screen; }

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
        result.catch((error) => this.showError(error?.message || UI_COPY.online.errors.generic));
      }
      return result;
    } catch (error) {
      this.showError(error?.message || UI_COPY.online.errors.generic);
      return undefined;
    }
  }

  _menuMarkup() {
    const copy = UI_COPY.online.menu;
    return `
      <div class="online-page-menu" data-page-menu>
        <button type="button" class="online-menu-trigger" data-action="toggle-menu"
          aria-haspopup="menu" aria-expanded="false">${copy.label}</button>
        <div class="online-menu-popover" data-menu-popover role="menu" hidden>
          <button type="button" role="menuitem" data-menu-action="settings">${copy.settings}</button>
          <button type="button" role="menuitem" data-menu-action="help">${copy.help}</button>
        </div>
      </div>`;
  }

  _buildSharedUi() {
    const parent = this.doc.body
      || Object.values(this.roots).find(Boolean)?.parentElement;
    if (!parent) return;
    const copy = UI_COPY.online.alerts;
    const host = createNode(this.doc, 'div', 'online-shared-ui', parent);
    host.innerHTML = `
      <div class="online-toast" data-online-toast role="status" aria-live="polite" hidden></div>
      <div class="online-alert-backdrop" data-online-alert hidden>
        <section class="online-alert" role="alertdialog" aria-modal="true"
          aria-labelledby="online-alert-title" aria-describedby="online-alert-message">
          <h2 id="online-alert-title" data-alert-title>${copy.genericTitle}</h2>
          <p id="online-alert-message" data-alert-message></p>
          <button type="button" class="online-action online-action-primary" data-action="dismiss-alert">${copy.dismiss}</button>
        </section>
      </div>`;
    this._sharedUi = {
      host,
      toast: host.querySelector('[data-online-toast]'),
      alert: host.querySelector('[data-online-alert]'),
    };
    this._listen(host.querySelector('[data-action="dismiss-alert"]'), 'click', () => this.confirmAlert());
    this._listen(this._sharedUi.alert, 'keydown', (event) => this._handleAlertKeydown(event));
    this._listen(this.doc, 'pointerdown', (event) => {
      if (!this._activeMenu || this._activeMenu.node.contains(event.target)) return;
      this.closeMenu();
    });
  }

  _wirePageMenu(root, screen) {
    const node = root.querySelector('[data-page-menu]');
    const trigger = node?.querySelector('[data-action="toggle-menu"]');
    const popover = node?.querySelector('[data-menu-popover]');
    if (!node || !trigger || !popover) return;
    this._listen(trigger, 'click', () => {
      if (this._activeMenu?.node === node) this.closeMenu();
      else this._openMenu(screen, node, trigger, popover);
    });
    this._listen(trigger, 'keydown', (event) => {
      if (event.key !== 'ArrowDown') return;
      event.preventDefault();
      this._openMenu(screen, node, trigger, popover);
    });
    this._listen(popover, 'keydown', (event) => {
      const items = [...popover.querySelectorAll('[role="menuitem"]')];
      if (!items.length) return;
      const index = Math.max(0, items.indexOf(this.doc.activeElement));
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closeMenu();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        items[(index + direction + items.length) % items.length].focus();
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        items[event.key === 'Home' ? 0 : items.length - 1].focus();
      }
    });
    for (const item of popover.querySelectorAll('[data-menu-action]')) {
      this._listen(item, 'click', () => {
        const action = item.dataset.menuAction;
        this.closeMenu(false);
        if (action === 'settings') this._emit('onOpenSettings');
        else if (action === 'help') this._emit('onOpenHelp');
      });
    }
  }

  _openMenu(screen, node, trigger, popover) {
    this.closeMenu(false);
    popover.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    this._activeMenu = { screen, node, trigger, popover };
    popover.querySelector('[role="menuitem"]')?.focus();
  }

  closeMenu(restoreFocus = true) {
    if (!this._activeMenu) return;
    const { trigger, popover } = this._activeMenu;
    popover.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    this._activeMenu = null;
    if (restoreFocus && trigger.isConnected) trigger.focus();
  }

  focusMenuTrigger(screen = this._screen) {
    this.roots[screen]?.querySelector('[data-action="toggle-menu"]')?.focus();
  }

  _fieldControl(field) {
    const selectors = {
      nickname: '[data-field="nickname"]',
      'create-room-name': '[data-create-field="roomName"]',
      'create-room-type': '[data-create-field="roomType"]',
      'create-max-players': '[data-create-field="maxPlayers"]',
      'create-password': '[data-create-field="password"]',
      'join-password': '[data-join-field="password"]',
    };
    return this.roots.lobby?.querySelector(selectors[field] || '.__missing-online-field') || null;
  }

  showFieldError(field, message, { focus = false } = {}) {
    const node = this.roots.lobby?.querySelector(`[data-field-error="${field}"]`);
    const control = this._fieldControl(field);
    if (!node || !control) return false;
    node.textContent = String(message || UI_COPY.online.errors.generic);
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
    const fields = name === 'create'
      ? ['create-room-name', 'create-room-type', 'create-max-players', 'create-password']
      : ['join-password'];
    for (const field of fields) this.clearFieldError(field);
  }

  _errorText(message) {
    if (typeof message === 'string') return message || UI_COPY.online.errors.generic;
    const code = String(message?.code || '');
    const copyKey = ERROR_COPY_KEYS.get(code);
    return String(
      UI_COPY.online.errors[copyKey]
      || onlineErrorMessage(message, UI_COPY.online.errors.generic),
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
    const copy = UI_COPY.online.alerts;
    if (connectionError) return copy.connectionTitle;
    if (action === 'join') return copy.joinTitle;
    if (action === 'create') return copy.createTitle;
    if (action === 'quick') return copy.quickTitle;
    if (['start', 'ready', 'character', 'settings'].includes(action)) return copy.roomTitle;
    return copy.genericTitle;
  }

  presentError(message, context = {}) {
    const code = typeof message === 'string' ? '' : String(message?.code || '');
    const pendingAction = this._pendingAction;
    const action = context.action || pendingAction?.kind || '';
    const field = this._fieldForError(code, action);
    const text = this._errorText(message);
    this._pendingAction = null;
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

  showAlert(message, {
    title = UI_COPY.online.alerts.genericTitle,
    restoreFocus = this.doc.activeElement,
    buttonLabel = UI_COPY.online.alerts.dismiss,
    onConfirm = null,
  } = {}) {
    const alert = this._sharedUi?.alert;
    if (!alert) return;
    const previous = this._activeAlert?.restoreFocus || restoreFocus;
    const suspendedDialog = this._activeDialog?.node || null;
    if (suspendedDialog) {
      suspendedDialog.setAttribute('inert', '');
      suspendedDialog.setAttribute('aria-hidden', 'true');
    }
    alert.querySelector('[data-alert-title]').textContent = title;
    alert.querySelector('[data-alert-message]').textContent = String(message || UI_COPY.online.errors.generic);
    alert.querySelector('[data-action="dismiss-alert"]').textContent = String(buttonLabel);
    alert.hidden = false;
    this._activeAlert = {
      node: alert,
      restoreFocus: previous,
      suspendedDialog,
      onConfirm: typeof onConfirm === 'function' ? onConfirm : null,
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
      this.confirmAlert();
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
    const copy = UI_COPY.online.lobby;
    root.innerHTML = `
      <div class="online-panel online-directory-panel">
        <header class="online-panel-header online-directory-header">
          <button type="button" class="online-back" data-action="back" aria-label="${copy.back}">${copy.back}</button>
          <div class="online-heading-wrap online-heading-wrap-compact">
            <p class="online-eyebrow">${copy.eyebrow}</p>
            <h2 class="online-heading" data-screen-heading tabindex="-1">${copy.heading}</h2>
            <p class="online-subtitle">${copy.subtitle}</p>
          </div>
          ${this._menuMarkup()}
        </header>

        <section class="online-lobby-toolbar" aria-label="${copy.playerSetup}">
          <label class="online-field online-nickname-field">
            <span class="online-field-label">${copy.nickname}</span>
            <input class="online-input" data-field="nickname" type="text" maxlength="20"
              autocomplete="nickname" spellcheck="false" placeholder="${copy.nicknamePlaceholder}"
              aria-describedby="online-nickname-error" />
            <span id="online-nickname-error" class="online-field-error" data-field-error="nickname" role="alert" hidden></span>
          </label>
          <button type="button" class="online-action online-action-secondary" data-action="quick" data-busy-action>${copy.quickMatch}</button>
          <button type="button" class="online-action online-action-primary" data-action="open-create" data-busy-action>${copy.createRoom}</button>
        </section>

        <section class="online-room-browser" aria-labelledby="online-room-list-heading">
          <div class="online-room-browser-header">
            <div>
              <p class="online-eyebrow">${copy.availableRooms}</p>
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

      <div class="online-dialog-backdrop" data-dialog="create" hidden>
        <form class="online-dialog" data-form="create" role="dialog" aria-modal="true" aria-labelledby="online-create-heading">
          <div class="online-dialog-header">
            <div>
              <p class="online-eyebrow">${copy.newRoom}</p>
              <h3 id="online-create-heading">${copy.createRoom}</h3>
            </div>
            <button type="button" class="online-dialog-close" data-action="close-dialog" aria-label="${copy.close}">\u00d7</button>
          </div>
          <label class="online-field">
            <span class="online-field-label">${copy.roomName}</span>
            <input class="online-input" data-create-field="roomName" type="text" maxlength="32" required
              aria-describedby="online-create-room-name-error" />
            <span id="online-create-room-name-error" class="online-field-error"
              data-field-error="create-room-name" role="alert" hidden></span>
          </label>
          <div class="online-dialog-fields-row">
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
          </div>
          <label class="online-field" data-private-password-field hidden>
            <span class="online-field-label">${copy.password}</span>
            <input class="online-input" data-create-field="password" type="password" minlength="4" maxlength="20"
              autocomplete="off" placeholder="${copy.passwordPlaceholder}"
              aria-describedby="online-create-password-help online-create-password-error" />
            <span id="online-create-password-help" class="online-field-help">${copy.passwordHelp}</span>
            <span id="online-create-password-error" class="online-field-error"
              data-field-error="create-password" role="alert" hidden></span>
          </label>
          <div class="online-dialog-actions">
            <button type="button" class="online-action online-action-quiet" data-action="close-dialog">${copy.cancel}</button>
            <button type="submit" class="online-action online-action-primary" data-busy-action>${copy.create}</button>
          </div>
        </form>
      </div>

      <div class="online-dialog-backdrop" data-dialog="join" hidden>
        <form class="online-dialog" data-form="join" role="dialog" aria-modal="true" aria-labelledby="online-join-heading">
          <div class="online-dialog-header">
            <div>
              <p class="online-eyebrow">${copy.friendRoom}</p>
              <h3 id="online-join-heading" data-join-room-name>${copy.joinRoom}</h3>
              <p class="online-dialog-room-code" data-join-room-code></p>
            </div>
            <button type="button" class="online-dialog-close" data-action="close-dialog" aria-label="${copy.close}">\u00d7</button>
          </div>
          <label class="online-field">
            <span class="online-field-label">${copy.password}</span>
            <input class="online-input" data-join-field="password" type="password" maxlength="20"
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
      </div>`;

    this._listen(root, 'keydown', (event) => this._handleScreenKeydown(event));
    this._listen(root.querySelector('[data-action="back"]'), 'click', () => this._emit('onBackToTitle'));
    this._wirePageMenu(root, 'lobby');
    this._listen(root.querySelector('[data-action="quick"]'), 'click', () => this._submitQuickMatch());
    this._listen(root.querySelector('[data-action="open-create"]'), 'click', (event) => this._openCreateDialog(event.currentTarget));
    for (const button of root.querySelectorAll('[data-action="close-dialog"]')) {
      this._listen(button, 'click', () => this._closeDialog());
    }

    const nickname = root.querySelector('[data-field="nickname"]');
    const search = root.querySelector('[data-field="search"]');
    const roomType = root.querySelector('[data-create-field="roomType"]');
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
  }

  _buildRoom() {
    const root = this.roots.room;
    if (!root) return;
    const copy = UI_COPY.online.room;
    root.innerHTML = `
      <div class="online-panel online-room-panel" data-room-content>
        <header class="online-room-header">
          <div class="online-room-heading">
            <p class="online-eyebrow">${copy.eyebrow}</p>
            <h2 class="online-room-name" data-room-name data-screen-heading tabindex="-1">${copy.unnamedRoom}</h2>
            <div class="online-room-summary">
              <span class="online-room-type" data-room-type></span>
              <span data-room-players></span>
              <button type="button" class="online-room-code" data-action="copy" title="${copy.copyInvite}">
                <span data-room-code>------</span><span aria-hidden="true"> \u2398</span>
              </button>
            </div>
          </div>
          ${this._menuMarkup()}
        </header>

        <div class="online-room-grid">
          <section class="online-card online-members-card">
            <h3>${copy.racers}</h3>
            <ol class="online-member-list" data-member-list></ol>
          </section>
          <section class="online-card online-character-card">
            <h3>${copy.chooseRacer}</h3>
            <div class="online-character-grid" data-character-grid></div>
          </section>
          <section class="online-card online-setup-card">
            <h3>${copy.raceSetup}</h3>
            <label class="online-field">
              <span class="online-field-label">${copy.track}</span>
              <select class="online-select" data-room-setting="trackId"></select>
            </label>
            <label class="online-field">
              <span class="online-field-label">${copy.difficulty}</span>
              <select class="online-select" data-room-setting="difficulty"></select>
            </label>
            <p class="online-host-note" data-host-note></p>
          </section>
        </div>
        <p class="online-room-state" data-room-status role="status" aria-live="polite"></p>
        <footer class="online-room-actions">
          <button type="button" class="online-action online-action-quiet" data-action="leave">${copy.leave}</button>
          <button type="button" class="online-action online-action-secondary" data-action="ready">${copy.readyUp}</button>
          <button type="button" class="online-action online-action-primary" data-action="start">${copy.start}</button>
        </footer>
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
    this._wirePageMenu(root, 'room');

    const characterGrid = root.querySelector('[data-character-grid]');
    for (const character of this.characters) {
      const button = createNode(this.doc, 'button', 'online-character-option', characterGrid);
      button.type = 'button';
      button.dataset.characterId = character.id;
      button.style.setProperty('--character-color', `#${(character.color >>> 0).toString(16).padStart(6, '0')}`);
      createNode(this.doc, 'span', 'online-character-swatch', button, '\u{1F3CE}\u{FE0F}');
      createNode(this.doc, 'span', 'online-character-name', button, character.name);
      createNode(this.doc, 'span', 'online-character-lock', button, copy.taken);
      this._listen(button, 'click', () => {
        this._pendingAction = { kind: 'character' };
        this._emit('onSelectCharacter', { characterId: character.id });
      });
    }

    const trackSelect = root.querySelector('[data-room-setting="trackId"]');
    for (const track of this.tracks) {
      const option = createNode(this.doc, 'option', '', trackSelect, track.name);
      option.value = track.id;
    }
    const difficultySelect = root.querySelector('[data-room-setting="difficulty"]');
    for (const [value, preset] of Object.entries(this.difficulties)) {
      const option = createNode(this.doc, 'option', '', difficultySelect, preset.label || value);
      option.value = value;
    }

    this._listen(trackSelect, 'change', () => {
      this._pendingAction = { kind: 'settings' };
      this._emit('onSetRoom', { trackId: trackSelect.value });
    });
    this._listen(difficultySelect, 'change', () => {
      this._pendingAction = { kind: 'settings' };
      this._emit('onSetRoom', { difficulty: difficultySelect.value });
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

  _buildResults() {
    const root = this.roots.results;
    if (!root) return;
    const copy = UI_COPY.online.results;
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
    if (this._activeMenu && event.key === 'Escape') {
      event.preventDefault();
      this.closeMenu();
      return;
    }
    if (!this._activeDialog) return;
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
      this.showFieldError('nickname', UI_COPY.online.errors.nickname, { focus: true });
      return '';
    }
    this.clearFieldError('nickname');
    if (input) input.value = displayName;
    const changed = displayName !== this._displayName;
    this._displayName = displayName;
    if (changed && emitChange) this._emit('onNicknameChange', { displayName });
    return displayName;
  }

  _openCreateDialog(opener) {
    const displayName = this._commitNickname(true);
    if (!displayName || this._busy) return;
    const root = this.roots.lobby;
    root.querySelector('[data-create-field="roomName"]').value = defaultRoomName(displayName);
    root.querySelector('[data-create-field="roomType"]').value = 'public';
    root.querySelector('[data-create-field="maxPlayers"]').value = String(ONLINE_ROOM_CAPACITY);
    root.querySelector('[data-create-field="password"]').value = '';
    this._syncCreateRoomType();
    this._openDialog('create', opener);
  }

  _syncCreateRoomType() {
    const root = this.roots.lobby;
    if (!root) return;
    const isPrivate = root.querySelector('[data-create-field="roomType"]')?.value === 'private';
    const field = root.querySelector('[data-private-password-field]');
    const input = root.querySelector('[data-create-field="password"]');
    if (field) field.hidden = !isPrivate;
    if (input) {
      input.required = isPrivate;
      if (!isPrivate) input.value = '';
    }
  }

  _submitCreateRoom() {
    if (this._busy) return;
    const displayName = this._commitNickname(true);
    if (!displayName) return;
    const root = this.roots.lobby;
    const roomNameInput = root.querySelector('[data-create-field="roomName"]');
    const roomName = normalizeRoomName(roomNameInput.value);
    const roomType = root.querySelector('[data-create-field="roomType"]').value;
    const maxPlayers = clampInteger(
      root.querySelector('[data-create-field="maxPlayers"]').value,
      ONLINE_ROOM_MIN_CAPACITY,
      ONLINE_ROOM_CAPACITY,
      ONLINE_ROOM_CAPACITY,
    );
    const password = root.querySelector('[data-create-field="password"]').value;
    if (!roomName) {
      this.showFieldError('create-room-name', UI_COPY.online.errors.ROOM_NAME_INVALID, { focus: true });
      return;
    }
    if (!ROOM_TYPES.has(roomType)) {
      this.showFieldError('create-room-type', UI_COPY.online.errors.ROOM_TYPE_INVALID, { focus: true });
      return;
    }
    if (roomType === 'private' && !isValidRoomPassword(password)) {
      this.showFieldError('create-password', UI_COPY.online.errors.PASSWORD_REQUIRED, { focus: true });
      return;
    }
    const payload = { displayName, roomName, roomType, maxPlayers };
    if (roomType === 'private') payload.password = password;
    this._pendingAction = { kind: 'create' };
    this._emit('onCreateRoom', payload);
  }

  _submitQuickMatch() {
    if (this._busy) return;
    const displayName = this._commitNickname(true);
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
      this.showFieldError('join-password', UI_COPY.online.errors.PASSWORD_REQUIRED, { focus: true });
      return;
    }
    this._submitJoinRoom(room, passwordInput.value);
  }

  _submitJoinRoom(room, password) {
    if (!room?.joinable || this._busy) return;
    const displayName = this._commitNickname(true);
    if (!displayName) return;
    const payload = { displayName, roomCode: room.roomCode };
    if (room.requiresPassword) payload.password = String(password ?? '');
    this._pendingAction = { kind: 'join', roomCode: room.roomCode };
    this._emit('onJoinRoom', payload);
  }

  _openDialog(name, opener, room = null) {
    this._closeDialog(false);
    const node = this.roots.lobby?.querySelector(`[data-dialog="${name}"]`);
    if (!node) return;
    node.hidden = false;
    this._activeDialog = { name, node, opener, room };
    this._clearDialogFieldErrors(name);
    const first = node.querySelector('input:not([type="hidden"]), select, button');
    first?.focus();
  }

  _closeDialog(restoreFocus = true) {
    if (!this._activeDialog) return;
    const { node, opener } = this._activeDialog;
    for (const password of node.querySelectorAll('input[type="password"]')) password.value = '';
    this._clearDialogFieldErrors(this._activeDialog.name);
    node.hidden = true;
    this._activeDialog = null;
    if (restoreFocus && opener?.isConnected && !this.roots.lobby?.hidden) opener.focus();
  }

  _refreshLobbyView() {
    this._lobbyView = buildLobbyView(this._lobbyState, {
      search: this._lobbySearch,
      inviteRoomCode: this._inviteRoomCode,
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
    const copy = UI_COPY.online.lobby;
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
      createNode(this.doc, 'h4', '', titleLine, room.roomName);
      const type = createNode(
        this.doc,
        'span',
        `online-room-type is-${room.roomType}`,
        titleLine,
        room.roomType === 'private' ? copy.privateBadge : copy.publicBadge,
      );
      type.title = room.requiresPassword ? copy.passwordRequired : copy.noPasswordRequired;
      createNode(this.doc, 'span', 'online-room-list-code', title, room.roomCode);

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
    const copy = UI_COPY.online.lobby;
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
      this.showToast(UI_COPY.online.room.copied);
    } catch {
      const fallback = createNode(this.doc, 'textarea', 'online-copy-fallback', this.roots.room, url);
      fallback.setAttribute('readonly', '');
      fallback.select();
      let copied = false;
      try { copied = Boolean(this.doc.execCommand?.('copy')); } catch { copied = false; }
      fallback.remove();
      if (copied) this.showToast(UI_COPY.online.room.copyFallback);
      else this.presentError(UI_COPY.online.room.copyFailed, { action: 'copy' });
    }
  }

  _show(name) {
    this._closeDialog(false);
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
      this.closeMenu(false);
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
    const view = buildRoomView(this._roomState, this._localParticipantId);
    this._roomView = view;
    const root = this.roots.room;
    if (!root) return view;
    const copy = UI_COPY.online.room;
    root.querySelector('[data-room-name]').textContent = view.roomName;
    const type = root.querySelector('[data-room-type]');
    type.textContent = view.roomType === 'private' ? copy.privateRoom : copy.publicRoom;
    type.className = `online-room-type is-${view.roomType}`;
    root.querySelector('[data-room-players]').textContent = copy.playerCount
      .replace('{count}', String(view.playerCount))
      .replace('{max}', String(view.maxPlayers));
    root.querySelector('[data-room-code]').textContent = view.roomCode || '------';
    root.querySelector('[data-action="copy"]').disabled = !view.roomCode;

    const characterById = new Map(this.characters.map((character) => [character.id, character]));
    const memberList = root.querySelector('[data-member-list]');
    memberList.innerHTML = '';
    const sortedMembers = view.members.slice().sort((a, b) => a.joinOrder - b.joinOrder);
    for (let index = 0; index < view.maxPlayers; index += 1) {
      const member = sortedMembers[index];
      const item = createNode(
        this.doc,
        'li',
        `online-member${member?.isLocal ? ' is-local' : ''}${member && !member.connected ? ' is-disconnected' : ''}${member ? '' : ' is-empty'}`,
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
      const character = characterById.get(member.characterId);
      createNode(
        this.doc,
        'span',
        'online-member-character',
        identity,
        character?.name || copy.choosing,
      );
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
    }

    for (const button of root.querySelectorAll('[data-character-id]')) {
      const id = button.dataset.characterId;
      const selected = view.localMember?.characterId === id;
      const occupiedByOther = view.members.some((member) => (
        member.characterId === id && member.participantId !== view.localMember?.participantId
      ));
      button.classList.toggle('is-selected', selected);
      button.classList.toggle('is-locked', occupiedByOther);
      button.disabled = this._busy || !view.canManageRoom || occupiedByOther;
      button.setAttribute('aria-pressed', String(selected));
    }

    const trackSelect = root.querySelector('[data-room-setting="trackId"]');
    const difficultySelect = root.querySelector('[data-room-setting="difficulty"]');
    trackSelect.value = view.trackId;
    difficultySelect.value = view.difficulty;
    trackSelect.disabled = this._busy || !view.isHost || !view.canManageRoom;
    difficultySelect.disabled = this._busy || !view.isHost || !view.canManageRoom;
    root.querySelector('[data-host-note]').textContent = view.isHost
      ? copy.hostControls
      : copy.hostOnly;

    const ready = root.querySelector('[data-action="ready"]');
    ready.textContent = view.localMember?.ready ? copy.cancelReady : copy.readyUp;
    ready.classList.toggle('is-active', Boolean(view.localMember?.ready));
    ready.disabled = this._busy
      || !view.canManageRoom
      || !view.localMember?.connected
      || !view.localMember?.characterId;
    const start = root.querySelector('[data-action="start"]');
    start.hidden = !view.isHost;
    start.disabled = this._busy || !view.canStart;
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
    const merged = {
      ...this._resultsState,
      ...(context.trackName === undefined ? {} : { trackName: context.trackName }),
      ...(context.autoReturnSeconds === undefined ? {} : { autoReturnSeconds: context.autoReturnSeconds }),
    };
    const view = buildOnlineResultsView(merged, this._localParticipantId);
    const root = this.roots.results;
    if (!root) return view;
    root.querySelector('[data-results-track]').textContent = view.trackName;
    const body = root.querySelector('tbody');
    body.innerHTML = '';
    const characterById = new Map(this.characters.map((character) => [character.id, character]));
    view.standings.forEach((result, index) => {
      const row = createNode(this.doc, 'tr', result.isLocal ? 'is-local' : '', body);
      row.style.setProperty('--row-i', index);
      const place = createNode(this.doc, 'td', 'online-result-rank', row);
      place.textContent = result.rank <= 3 ? MEDALS[result.rank - 1] : ordinal(result.rank);
      const racer = createNode(this.doc, 'td', 'online-result-racer', row);
      createNode(this.doc, 'span', 'online-result-name', racer, result.displayName);
      const character = characterById.get(result.characterId);
      if (character) createNode(this.doc, 'span', 'online-result-character', racer, character.name);
      if (result.isLocal) createNode(this.doc, 'span', 'online-mini-chip', racer, UI_COPY.online.room.you);
      createNode(this.doc, 'td', 'online-result-time', row, result.finished ? formatOnlineTime(result.finishTime) : 'DNF');
      createNode(this.doc, 'td', 'online-result-time', row, formatOnlineTime(result.bestLap));
    });
    const countdown = view.autoReturnSeconds === null
      ? ''
      : ` ${UI_COPY.online.results.autoReturn.replace(
        '{seconds}',
        String(Math.max(0, Math.ceil(view.autoReturnSeconds))),
      )}`;
    this.showStatus(`${context.status ?? UI_COPY.online.results.returnHint}${countdown}`, 'results');
    if (context.error) this.showError(context.error, 'results');
    else if (context.clearError) this.clearError('results');
    root.querySelector('[data-action="return"]').disabled = this._busy;
    return view;
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
    const errors = UI_COPY.online.errors;
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
    this.closeMenu(false);
    this._closeDialog(false);
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
