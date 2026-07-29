// Online multiplayer entry, lobby and authoritative results screens.
//
// This controller is deliberately independent from the single-player Screens
// class. The application/network layer owns navigation and feeds server state
// through showEntry(), showLobby()/updateLobby() and showResults(). No DOM work
// occurs at module import time, which keeps the view-model helpers testable.

import { DIFFICULTY } from '../core/constants.js';
import { CHARACTERS } from '../game/characters.js';
import { TRACKS } from '../track/tracks.js';
import { UI_COPY } from './copy.js';

export const ONLINE_ROOM_CAPACITY = 8;
export const ONLINE_ROOM_CODE_LENGTH = 6;
export const ONLINE_ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const ROOM_CODE_CHARS = new Set(ONLINE_ROOM_CODE_ALPHABET);
const CONNECTION_STATES = new Set([
  'connecting', 'connected', 'reconnecting', 'disconnected', 'error',
]);
const MEDALS = ['🥇', '🥈', '🥉'];

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

function participantIdOf(value) {
  return String(firstDefined(value?.participantId, value?.playerId, value?.id, ''));
}

function connectionStateOf(member) {
  if (member?.connected === false) return 'disconnected';
  if (member?.connected === true) return 'connected';
  const state = String(firstDefined(member?.connectionState, member?.status, 'connected')).toLowerCase();
  return state === 'online' ? 'connected' : state;
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

export function roomCodeFromSearch(search) {
  const params = new URLSearchParams(String(search ?? '').replace(/^\?/, ''));
  return normalizeRoomCode(params.get('room'));
}

/** Create a same-page invite link without leaking participant or resume tokens. */
export function buildInviteUrl(roomCode, locationLike = globalThis.location) {
  const code = normalizeRoomCode(roomCode);
  if (!code || !locationLike) return '';
  const fallbackBase = `${locationLike.origin || 'http://localhost'}${locationLike.pathname || '/'}`;
  const url = new URL(locationLike.href || fallbackBase, fallbackBase);
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', code);
  return url.toString();
}

export function formatOnlineTime(seconds) {
  if (seconds === null || seconds === undefined || seconds === '') return '—';
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '—';
  const minutes = Math.floor(value / 60);
  const remainder = value - minutes * 60;
  return `${minutes}:${remainder < 10 ? '0' : ''}${remainder.toFixed(2)}`;
}

/**
 * Normalize a room_state payload into presentation facts. Alternate field names
 * make the UI tolerant while the server protocol is being wired up.
 */
export function buildLobbyView(roomState = {}, localParticipantId = '') {
  const settings = roomState.settings || {};
  const phase = String(firstDefined(roomState.phase, roomState.state, 'lobby'));
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
    return {
      participantId,
      displayName: String(firstDefined(member.displayName, member.nickname, member.name, `Racer ${index + 1}`)),
      characterId: String(firstDefined(member.characterId, member.character?.id, '')),
      ready: Boolean(firstDefined(member.ready, member.isReady, false)),
      connected: !['disconnected', 'offline', 'expired'].includes(state),
      connectionState: state,
      isHost: participantId === hostId || member.isHost === true,
      isLocal: member.isLocal === true
        || (participantId !== '' && participantId === String(localParticipantId || '')),
      joinOrder: finiteNumber(member.joinOrder, member.joinedAt, index) ?? index,
    };
  }) : [];

  const localMember = members.find((member) => member.isLocal) || null;
  const onlineMembers = members.filter((member) => member.connected);
  const occupiedCharacterIds = members
    .map((member) => member.characterId)
    .filter(Boolean);
  const everyoneOnline = members.length > 0 && onlineMembers.length === members.length;
  const everyoneReady = everyoneOnline && members.every((member) => member.ready);
  const serverAllowsStart = typeof roomState.canStart === 'boolean'
    ? roomState.canStart
    : onlineMembers.length >= 2 && everyoneReady && phase === 'lobby';
  const isHost = Boolean(localMember?.isHost || (localParticipantId && String(localParticipantId) === hostId));

  return {
    roomCode: normalizeRoomCode(firstDefined(roomState.roomCode, roomState.code, '')),
    phase,
    hostId,
    members,
    localMember,
    onlineCount: onlineMembers.length,
    capacity: ONLINE_ROOM_CAPACITY,
    everyoneReady,
    isHost,
    canStart: isHost && serverAllowsStart && phase === 'lobby',
    occupiedCharacterIds,
    trackId: String(firstDefined(settings.trackId, roomState.trackId, TRACKS[0]?.id, '')),
    difficulty: String(firstDefined(settings.difficulty, roomState.difficulty, 'normal')),
  };
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
    isHost: Boolean(firstDefined(resultState.isHost, false))
      || Boolean(localParticipantId && String(firstDefined(
        resultState.hostParticipantId,
        resultState.hostId,
        '',
      )) === String(localParticipantId)),
    autoReturnSeconds: finiteNumber(resultState.autoReturnSeconds, resultState.returnIn),
  };
}

export class OnlineScreens {
  constructor(roots = {}, callbacks = {}, options = {}) {
    const pick = (...keys) => keys.map((key) => roots[key]).find(Boolean) || null;
    this.roots = {
      entry: pick('entry', 'onlineEntry', 'screen-online-entry'),
      lobby: pick('lobby', 'onlineLobby', 'screen-online-lobby'),
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
    this._entryBusy = false;
    this._lobbyState = {};
    this._lobbyView = buildLobbyView();
    this._resultsState = {};
    this._localParticipantId = '';
    this._connection = { state: 'disconnected', message: '' };

    this._buildEntry();
    this._buildLobby();
    this._buildResults();
  }

  get activeScreen() { return this._screen; }

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

  _buildEntry() {
    const root = this.roots.entry;
    if (!root) return;
    const copy = UI_COPY.online.entry;
    root.innerHTML = `
      <div class="online-panel online-entry-panel">
        <header class="online-panel-header">
          <button type="button" class="online-back" data-action="back" aria-label="${copy.back}">‹ ${copy.back}</button>
          <span class="online-connection" data-online-connection role="status"></span>
        </header>
        <div class="online-heading-wrap">
          <span class="online-heading-icon" aria-hidden="true">🌐</span>
          <h2 class="online-heading">${copy.heading}</h2>
          <p class="online-subtitle">${copy.subtitle}</p>
        </div>
        <div class="online-entry-fields">
          <label class="online-field">
            <span class="online-field-label">${copy.nickname}</span>
            <input class="online-input" data-field="nickname" type="text" maxlength="20"
              autocomplete="nickname" spellcheck="false" placeholder="${copy.nicknamePlaceholder}" />
          </label>
          <button type="button" class="online-action online-action-primary" data-action="create">${copy.create}</button>
          <div class="online-divider"><span>${copy.or}</span></div>
          <label class="online-field">
            <span class="online-field-label">${copy.roomCode}</span>
            <input class="online-input online-code-input" data-field="room-code" type="text"
              maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false"
              inputmode="text" placeholder="${copy.roomCodePlaceholder}" />
          </label>
          <button type="button" class="online-action online-action-secondary" data-action="join">${copy.join}</button>
        </div>
        <p class="online-status" data-online-status role="status" aria-live="polite"></p>
        <p class="online-error" data-online-error role="alert" hidden></p>
      </div>`;

    this._listen(root, 'keydown', (event) => event.stopPropagation());

    const nickname = root.querySelector('[data-field="nickname"]');
    const roomCode = root.querySelector('[data-field="room-code"]');
    this._listen(root.querySelector('[data-action="back"]'), 'click', () => this._emit('onBackToTitle'));
    this._listen(root.querySelector('[data-action="create"]'), 'click', () => this._submitCreate());
    this._listen(root.querySelector('[data-action="join"]'), 'click', () => this._submitJoin());
    this._listen(roomCode, 'input', () => {
      const normalized = normalizeRoomCode(roomCode.value);
      if (roomCode.value !== normalized) roomCode.value = normalized;
    });
    for (const input of [nickname, roomCode]) {
      this._listen(input, 'keydown', (event) => {
        // Keep global WASD/Enter gameplay handlers from seeing text-entry keys.
        event.stopPropagation();
        if (event.key === 'Escape') {
          input.blur();
          return;
        }
        if (event.key !== 'Enter') return;
        event.preventDefault();
        if (input === nickname && normalizeRoomCode(roomCode.value).length !== ONLINE_ROOM_CODE_LENGTH) {
          roomCode.focus();
        } else if (input === roomCode) {
          this._submitJoin();
        } else {
          this._submitCreate();
        }
      });
    }
  }

  _buildLobby() {
    const root = this.roots.lobby;
    if (!root) return;
    const copy = UI_COPY.online.lobby;
    root.innerHTML = `
      <div class="online-panel online-lobby-panel">
        <header class="online-lobby-header">
          <div>
            <p class="online-eyebrow">${copy.room}</p>
            <button type="button" class="online-room-code" data-action="copy" title="${copy.copyInvite}">
              <span data-room-code>------</span><span aria-hidden="true"> ⧉</span>
            </button>
          </div>
          <span class="online-connection" data-online-connection role="status"></span>
        </header>
        <div class="online-lobby-grid">
          <section class="online-card online-members-card">
            <h3>${copy.racers}</h3>
            <ol class="online-member-list" data-member-list></ol>
          </section>
          <section class="online-card online-character-card">
            <h3>${copy.chooseRacer}</h3>
            <div class="online-character-grid" data-character-grid></div>
          </section>
          <section class="online-card online-room-card">
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
        <p class="online-status" data-online-status role="status" aria-live="polite"></p>
        <p class="online-error" data-online-error role="alert" hidden></p>
        <footer class="online-lobby-actions">
          <button type="button" class="online-action online-action-quiet" data-action="leave">${copy.leave}</button>
          <button type="button" class="online-action online-action-secondary" data-action="ready">${copy.ready}</button>
          <button type="button" class="online-action online-action-primary" data-action="start">${copy.start}</button>
        </footer>
      </div>`;

    this._listen(root, 'keydown', (event) => event.stopPropagation());

    const characterGrid = root.querySelector('[data-character-grid]');
    for (const character of this.characters) {
      const button = createNode(this.doc, 'button', 'online-character-option', characterGrid);
      button.type = 'button';
      button.dataset.characterId = character.id;
      button.style.setProperty('--character-color', `#${(character.color >>> 0).toString(16).padStart(6, '0')}`);
      createNode(this.doc, 'span', 'online-character-swatch', button, '🏎️');
      createNode(this.doc, 'span', 'online-character-name', button, character.name);
      createNode(this.doc, 'span', 'online-character-lock', button, 'LOCKED');
      this._listen(button, 'click', () => this._emit('onSelectCharacter', { characterId: character.id }));
    }

    const trackSelect = root.querySelector('[data-room-setting="trackId"]');
    for (const track of this.tracks) {
      const option = createNode(this.doc, 'option', '', trackSelect, `${track.name} · ${track.laps ?? 3} laps`);
      option.value = track.id;
    }
    const difficultySelect = root.querySelector('[data-room-setting="difficulty"]');
    for (const [key, difficulty] of Object.entries(this.difficulties)) {
      const option = createNode(this.doc, 'option', '', difficultySelect, difficulty.label || key);
      option.value = key;
    }

    this._listen(root.querySelector('[data-action="copy"]'), 'click', () => this._copyInvite());
    this._listen(root.querySelector('[data-action="leave"]'), 'click', () => this._emit('onLeaveRoom'));
    this._listen(root.querySelector('[data-action="ready"]'), 'click', () => {
      this._emit('onReadyChange', { ready: !this._lobbyView.localMember?.ready });
    });
    this._listen(root.querySelector('[data-action="start"]'), 'click', () => this._emit('onStartRace'));
    this._listen(trackSelect, 'change', () => this._emit('onSetRoom', { trackId: trackSelect.value }));
    this._listen(difficultySelect, 'change', () => this._emit('onSetRoom', { difficulty: difficultySelect.value }));
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
            <h2 class="online-heading">${copy.heading}</h2>
            <p class="online-results-track" data-results-track></p>
          </div>
          <span class="online-connection" data-online-connection role="status"></span>
        </header>
        <div class="online-results-scroll">
          <table class="online-results-table">
            <thead><tr><th>${copy.place}</th><th>${copy.racer}</th><th>${copy.time}</th><th>${copy.bestLap}</th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
        <p class="online-status" data-online-status role="status" aria-live="polite"></p>
        <p class="online-error" data-online-error role="alert" hidden></p>
        <footer class="online-results-actions">
          <button type="button" class="online-action online-action-quiet" data-action="leave">${copy.leave}</button>
          <button type="button" class="online-action online-action-primary" data-action="return">${copy.returnLobby}</button>
        </footer>
      </div>`;
    this._listen(root, 'keydown', (event) => event.stopPropagation());
    this._listen(root.querySelector('[data-action="leave"]'), 'click', () => this._emit('onLeaveRoom'));
    this._listen(root.querySelector('[data-action="return"]'), 'click', () => this._emit('onReturnLobby'));
  }

  _submitCreate() {
    if (this._entryBusy) return;
    const root = this.roots.entry;
    const displayName = normalizeDisplayName(root?.querySelector('[data-field="nickname"]')?.value);
    if (!displayName) {
      this.showError(UI_COPY.online.errors.nickname, 'entry');
      root?.querySelector('[data-field="nickname"]')?.focus();
      return;
    }
    this.clearError('entry');
    this._emit('onCreateRoom', { displayName });
  }

  _submitJoin() {
    if (this._entryBusy) return;
    const root = this.roots.entry;
    const displayName = normalizeDisplayName(root?.querySelector('[data-field="nickname"]')?.value);
    const roomCode = normalizeRoomCode(root?.querySelector('[data-field="room-code"]')?.value);
    if (!displayName) {
      this.showError(UI_COPY.online.errors.nickname, 'entry');
      root?.querySelector('[data-field="nickname"]')?.focus();
      return;
    }
    if (roomCode.length !== ONLINE_ROOM_CODE_LENGTH) {
      this.showError(UI_COPY.online.errors.roomCode, 'entry');
      root?.querySelector('[data-field="room-code"]')?.focus();
      return;
    }
    this.clearError('entry');
    this._emit('onJoinRoom', { displayName, roomCode });
  }

  async _copyInvite() {
    const roomCode = this._lobbyView.roomCode;
    const inviteUrl = buildInviteUrl(roomCode, this.location);
    if (!inviteUrl) return;
    let copied = false;
    try {
      if (this.navigator?.clipboard?.writeText) {
        await this.navigator.clipboard.writeText(inviteUrl);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (!copied && typeof this.doc.execCommand === 'function') {
      const fallback = createNode(this.doc, 'textarea', 'online-copy-fallback', this.doc.body);
      fallback.value = inviteUrl;
      fallback.setAttribute('readonly', '');
      fallback.select();
      try {
        copied = this.doc.execCommand('copy');
      } catch {
        copied = false;
      }
      fallback.remove();
    }
    this.showStatus(copied ? UI_COPY.online.lobby.copied : UI_COPY.online.lobby.copyFallback, 'lobby');
    this._emit('onCopyInvite', { roomCode, inviteUrl, copied });
  }

  _show(name) {
    this.hideAll();
    const root = this.roots[name];
    if (!root) return;
    root.hidden = false;
    this._screen = name;
    this._syncConnectionIndicators();
  }

  showEntry(state = {}) {
    this._show('entry');
    this.updateEntry(state);
    const root = this.roots.entry;
    const codeInput = root?.querySelector('[data-field="room-code"]');
    const nameInput = root?.querySelector('[data-field="nickname"]');
    (codeInput?.value ? codeInput : nameInput)?.focus();
  }

  updateEntry(state = {}) {
    const root = this.roots.entry;
    if (!root) return;
    const nickname = root.querySelector('[data-field="nickname"]');
    const roomCode = root.querySelector('[data-field="room-code"]');
    if (state.displayName !== undefined) nickname.value = String(state.displayName ?? '');
    if (state.roomCode !== undefined) roomCode.value = normalizeRoomCode(state.roomCode);
    else if (state.prefillFromLocation) roomCode.value = roomCodeFromSearch(this.location?.search);
    if (state.busy !== undefined) this.setBusy(state.busy);
    if (state.connectionState) this.setConnectionState(state.connectionState, state.connectionMessage);
    if (state.error) this.showError(state.error, 'entry');
    else if (state.clearError) this.clearError('entry');
    if (state.status !== undefined) this.showStatus(state.status, 'entry');
  }

  showLobby(roomState, context = {}) {
    this._show('lobby');
    this.updateLobby(roomState, context);
  }

  updateLobby(roomState = this._lobbyState, context = {}) {
    this._lobbyState = roomState || {};
    if (context.localParticipantId !== undefined) {
      this._localParticipantId = String(context.localParticipantId || '');
    }
    const view = buildLobbyView(this._lobbyState, this._localParticipantId);
    this._lobbyView = view;
    const root = this.roots.lobby;
    if (!root) return view;

    root.querySelector('[data-room-code]').textContent = view.roomCode || '------';
    root.querySelector('[data-action="copy"]').disabled = !view.roomCode;
    const memberList = root.querySelector('[data-member-list]');
    memberList.innerHTML = '';
    const characterById = new Map(this.characters.map((character) => [character.id, character]));
    for (let index = 0; index < view.capacity; index++) {
      const member = view.members[index];
      const row = createNode(this.doc, 'li', `online-member${member ? '' : ' is-empty'}`, memberList);
      if (!member) {
        createNode(this.doc, 'span', 'online-member-slot', row, String(index + 1));
        createNode(this.doc, 'span', 'online-member-name', row, UI_COPY.online.lobby.openSlot);
        continue;
      }
      if (member.isLocal) row.classList.add('is-local');
      if (!member.connected) row.classList.add('is-disconnected');
      createNode(this.doc, 'span', 'online-member-slot', row, String(index + 1));
      const identity = createNode(this.doc, 'span', 'online-member-identity', row);
      const name = createNode(this.doc, 'span', 'online-member-name', identity, member.displayName);
      if (member.isLocal) createNode(this.doc, 'span', 'online-mini-chip', name, UI_COPY.online.lobby.you);
      const character = characterById.get(member.characterId);
      createNode(this.doc, 'span', 'online-member-character', identity, character?.name || UI_COPY.online.lobby.choosing);
      const badges = createNode(this.doc, 'span', 'online-member-badges', row);
      if (member.isHost) createNode(this.doc, 'span', 'online-mini-chip is-host', badges, UI_COPY.online.lobby.host);
      createNode(
        this.doc,
        'span',
        `online-ready-chip ${member.connected && member.ready ? 'is-ready' : ''}`,
        badges,
        member.connected
          ? (member.ready ? UI_COPY.online.lobby.ready : UI_COPY.online.lobby.notReady)
          : UI_COPY.online.lobby.offline,
      );
    }

    const occupiedByOther = new Set(view.members
      .filter((member) => !member.isLocal)
      .map((member) => member.characterId));
    for (const button of root.querySelectorAll('[data-character-id]')) {
      const id = button.dataset.characterId;
      const selected = view.localMember?.characterId === id;
      const locked = occupiedByOther.has(id);
      button.classList.toggle('is-selected', selected);
      button.classList.toggle('is-locked', locked);
      button.disabled = view.phase !== 'lobby' || locked || !view.localMember?.connected;
      button.setAttribute('aria-pressed', String(selected));
    }

    const trackSelect = root.querySelector('[data-room-setting="trackId"]');
    const difficultySelect = root.querySelector('[data-room-setting="difficulty"]');
    if ([...trackSelect.options].some((option) => option.value === view.trackId)) trackSelect.value = view.trackId;
    if ([...difficultySelect.options].some((option) => option.value === view.difficulty)) difficultySelect.value = view.difficulty;
    const settingsDisabled = !view.isHost || view.phase !== 'lobby';
    trackSelect.disabled = settingsDisabled;
    difficultySelect.disabled = settingsDisabled;
    root.querySelector('[data-host-note]').textContent = view.isHost
      ? UI_COPY.online.lobby.hostControls
      : UI_COPY.online.lobby.hostOnly;

    const ready = root.querySelector('[data-action="ready"]');
    ready.textContent = view.localMember?.ready ? UI_COPY.online.lobby.cancelReady : UI_COPY.online.lobby.readyUp;
    ready.disabled = view.phase !== 'lobby' || !view.localMember?.connected;
    ready.classList.toggle('is-active', Boolean(view.localMember?.ready));
    const start = root.querySelector('[data-action="start"]');
    start.hidden = !view.isHost;
    start.disabled = !view.canStart;
    const status = view.phase !== 'lobby'
      ? UI_COPY.online.lobby.loading
      : view.onlineCount < 2
        ? UI_COPY.online.lobby.waitingForRacer
        : !view.everyoneReady
          ? UI_COPY.online.lobby.readyCount
            .replace('{ready}', String(view.members.filter((member) => member.ready && member.connected).length))
            .replace('{total}', String(view.onlineCount))
          : view.isHost ? UI_COPY.online.lobby.readyToStart : UI_COPY.online.lobby.waitingForHost;
    this.showStatus(context.status ?? status, 'lobby');
    if (context.error) this.showError(context.error, 'lobby');
    else if (context.clearError) this.clearError('lobby');
    return view;
  }

  showResults(resultState, context = {}) {
    this._show('results');
    this.updateResults(resultState, context);
  }

  updateResults(resultState = this._resultsState, context = {}) {
    this._resultsState = resultState || {};
    if (context.localParticipantId !== undefined) {
      this._localParticipantId = String(context.localParticipantId || '');
    }
    const merged = {
      ...this._resultsState,
      ...(context.isHost === undefined ? {} : { isHost: context.isHost }),
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
      if (result.isLocal) createNode(this.doc, 'span', 'online-mini-chip', racer, UI_COPY.online.lobby.you);
      createNode(this.doc, 'td', 'online-result-time', row, result.finished ? formatOnlineTime(result.finishTime) : 'DNF');
      createNode(this.doc, 'td', 'online-result-time', row, formatOnlineTime(result.bestLap));
    });
    const returnButton = root.querySelector('[data-action="return"]');
    returnButton.hidden = !view.isHost;
    const wait = view.isHost
      ? UI_COPY.online.results.hostHint
      : UI_COPY.online.results.waitingForHost;
    const countdown = view.autoReturnSeconds === null
      ? ''
      : ` ${UI_COPY.online.results.autoReturn.replace('{seconds}', String(Math.max(0, Math.ceil(view.autoReturnSeconds))))}`;
    this.showStatus(`${context.status ?? wait}${countdown}`, 'results');
    if (context.error) this.showError(context.error, 'results');
    else if (context.clearError) this.clearError('results');
    return view;
  }

  setConnectionState(state, message = '') {
    const normalized = CONNECTION_STATES.has(state) ? state : 'disconnected';
    this._connection = { state: normalized, message: String(message || '') };
    this._syncConnectionIndicators();
  }

  _syncConnectionIndicators() {
    const labels = UI_COPY.online.connection;
    for (const root of Object.values(this.roots)) {
      const node = root?.querySelector('[data-online-connection]');
      if (!node) continue;
      node.dataset.state = this._connection.state;
      node.textContent = this._connection.message || labels[this._connection.state] || labels.disconnected;
    }
  }

  setBusy(busy) {
    this._entryBusy = Boolean(busy);
    const root = this.roots.entry;
    if (!root) return;
    for (const button of root.querySelectorAll('[data-action="create"], [data-action="join"]')) {
      button.disabled = this._entryBusy;
    }
    root.setAttribute('aria-busy', String(this._entryBusy));
  }

  showStatus(message, screen = this._screen) {
    const node = this.roots[screen]?.querySelector('[data-online-status]');
    if (node) node.textContent = String(message || '');
  }

  showError(message, screen = this._screen) {
    const node = this.roots[screen]?.querySelector('[data-online-error]');
    if (!node) return;
    const text = typeof message === 'string'
      ? message
      : firstDefined(message?.message, message?.code, UI_COPY.online.errors.generic);
    node.textContent = String(text || UI_COPY.online.errors.generic);
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
    for (const root of Object.values(this.roots)) {
      if (root) root.hidden = true;
    }
    this._screen = null;
  }

  dispose() {
    for (const remove of this._listeners.splice(0)) remove();
    this.hideAll();
  }
}
