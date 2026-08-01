// Browser-side WebSocket client for Lobby / Room lifecycle.
//
// Race rendering and prediction live in online-race-session.js. This class
// owns one reusable transport, in-memory Room reconnect credentials, Lobby commands,
// and typed event delivery. It deliberately does not touch the DOM.

import {
  CLIENT_MESSAGE_TYPES,
  ERROR_CODES,
  PROTOCOL_VERSION,
  ROOM_STATES,
  ROOM_TYPES,
  SERVER_MESSAGE_TYPES,
} from './protocol.js';

const SESSION_STORAGE_KEY = 'turbo-legends.online-session.v2';
const LEGACY_SESSION_STORAGE_KEY = 'turbo-legends.online-session.v1';
const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000];
const RECONNECT_WINDOW_MS = 30_000;
export const TELEMETRY_PING_INTERVAL_MS = 5_000;
export const TELEMETRY_STALE_MS = 15_000;
export const MAX_RACE_INPUT_BUFFERED_BYTES = 4 * 1024;

function storageForCleanup(candidate) {
  return candidate && typeof candidate.removeItem === 'function' ? candidate : null;
}

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

function displayNameOf(value) {
  return String(value || '').trim().replace(/\s+/gu, ' ');
}

function roomCommandPayload(value, legacyDisplayName) {
  if (value && typeof value === 'object') return value;
  return { roomCode: value, displayName: legacyDisplayName };
}

export function webSocketUrl(locationLike = globalThis.location) {
  if (!locationLike) return 'ws://127.0.0.1:5173/ws';
  if (locationLike.protocol && locationLike.host) {
    const protocol = locationLike.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${locationLike.host}/ws`;
  }
  const url = new URL(locationLike.href || 'http://127.0.0.1:5173/');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  url.hash = '';
  return url.href;
}

export class OnlineClient {
  constructor({
    WebSocketImpl = globalThis.WebSocket,
    location = globalThis.location,
    sessionStorage = globalThis.sessionStorage,
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout,
    now = () => globalThis.performance?.now?.() ?? Date.now(),
  } = {}) {
    this.WebSocketImpl = WebSocketImpl;
    this.url = webSocketUrl(location);
    this.storage = storageForCleanup(sessionStorage);
    // Browser timer functions are Web API methods and some runtimes require
    // their receiver to remain the global Window/Worker scope. Storing them on
    // OnlineClient and calling `this._setTimeout(...)` would otherwise pass the
    // client instance as `this`, which can abort the loop after its first ping.
    this._setTimeout = setTimeoutImpl.bind(globalThis);
    this._clearTimeout = clearTimeoutImpl.bind(globalThis);
    this._now = now;

    this.socket = null;
    this.state = 'idle';
    this.scope = 'none';
    this.lobby = null;
    this.room = null;
    this.selfId = null;
    this.resumeToken = null;
    this.raceId = null;

    this._listeners = new Map();
    this._connectionPurpose = null;
    this._connectionFailureReported = false;
    this._pendingMessages = [];
    this._reconnectTimer = null;
    this._reconnectExpiryTimer = null;
    this._reconnectAttempt = 0;
    this._reconnectDeadline = 0;
    this._telemetryEnabled = false;
    this._telemetryTimer = null;
    this._lastPongAt = null;
    this.latencyMs = null;
    this.onlineCount = null;

    // Participant IDs and resume tokens are deliberately memory-only. Remove
    // credentials left by older builds without ever replaying or migrating them.
    this._purgePersistedSessions();
  }

  on(type, listener) {
    let set = this._listeners.get(type);
    if (!set) {
      set = new Set();
      this._listeners.set(type, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  _emit(type, value) {
    const direct = this._listeners.get(type);
    if (direct) for (const listener of [...direct]) listener(value);
    const all = this._listeners.get('*');
    if (all) for (const listener of [...all]) listener({ type, value });
  }

  /** Enter (or re-enter) the public Lobby subscription. */
  enterLobby({ discardRoomSession = false } = {}) {
    if (discardRoomSession) this._clearRoomSession();
    this.scope = 'lobby';
    this._cancelReconnect();

    if (this.socket?.readyState === 1) {
      return this.send({ type: CLIENT_MESSAGE_TYPES.ENTER_LOBBY });
    }
    if (this.socket?.readyState === 0
      && this._connectionPurpose === CLIENT_MESSAGE_TYPES.ENTER_LOBBY) return true;

    this._open({ type: CLIENT_MESSAGE_TYPES.ENTER_LOBBY });
    return true;
  }

  /** Create a Room through the already-subscribed Lobby connection. */
  createRoom(options = {}) {
    const value = typeof options === 'string' ? { displayName: options } : options;
    this._clearRoomSession();
    this.scope = 'lobby';
    const displayName = displayNameOf(value.displayName);
    const roomType = String(value.roomType || ROOM_TYPES.PUBLIC).trim().toLowerCase();
    const message = {
      type: CLIENT_MESSAGE_TYPES.CREATE_ROOM,
      displayName,
      roomName: String(value.roomName ?? `${displayName}'s Room`).trim().replace(/\s+/gu, ' '),
      roomType,
      maxPlayers: Number(value.maxPlayers ?? 8),
    };
    if (roomType === ROOM_TYPES.PRIVATE && value.password !== undefined) {
      message.password = String(value.password);
    }
    if (value.characterId) message.characterId = String(value.characterId);
    return this._sendLobbyCommand(message);
  }

  /** Join either a public Room or a password-protected friend Room. */
  joinRoom(options, legacyDisplayName) {
    const value = roomCommandPayload(options, legacyDisplayName);
    this._clearRoomSession();
    this.scope = 'lobby';
    const message = {
      type: CLIENT_MESSAGE_TYPES.JOIN_ROOM,
      roomCode: normalizeCode(value.roomCode),
      displayName: displayNameOf(value.displayName),
    };
    if (value.password !== undefined && value.password !== '') {
      message.password = String(value.password);
    }
    if (value.characterId) message.characterId = String(value.characterId);
    return this._sendLobbyCommand(message);
  }

  /** Ask the server to atomically choose and join an available public Room. */
  quickMatch(options = {}) {
    const value = typeof options === 'string' ? { displayName: options } : options;
    this._clearRoomSession();
    this.scope = 'lobby';
    const message = {
      type: CLIENT_MESSAGE_TYPES.QUICK_MATCH,
      displayName: displayNameOf(value.displayName),
    };
    if (value.characterId) message.characterId = String(value.characterId);
    return this._sendLobbyCommand(message);
  }

  resumeRoomSession() {
    if (!this.room?.code || !this.selfId || !this.resumeToken) return false;
    this.scope = 'room';
    this._open(this._resumeMessage(), true);
    return true;
  }

  selectCharacter(characterId) {
    return this.send({ type: CLIENT_MESSAGE_TYPES.SELECT_CHARACTER, characterId });
  }

  setRoom(settings) {
    return this.send({ type: CLIENT_MESSAGE_TYPES.SET_ROOM, ...settings });
  }

  setReady(ready) {
    return this.send({ type: CLIENT_MESSAGE_TYPES.SET_READY, ready: !!ready });
  }

  kickPlayer(participantId) {
    return this.send({ type: CLIENT_MESSAGE_TYPES.KICK_PLAYER, participantId });
  }

  startRace() {
    return this.send({ type: CLIENT_MESSAGE_TYPES.START_RACE });
  }

  markRaceLoaded(raceId = this.raceId) {
    return this.send({ type: CLIENT_MESSAGE_TYPES.RACE_LOADED, raceId });
  }

  returnRoom() {
    return this.send({ type: CLIENT_MESSAGE_TYPES.RETURN_ROOM });
  }

  sendInput(input) {
    if (!this.raceId) return false;
    const socket = this.socket;
    if (!socket || socket.readyState !== 1
      || Number(socket.bufferedAmount || 0) > MAX_RACE_INPUT_BUFFERED_BYTES) {
      return false;
    }
    return this.send({ type: CLIENT_MESSAGE_TYPES.INPUT, raceId: this.raceId, ...input });
  }

  ping(clientTime = this._now()) {
    return this.send({ type: CLIENT_MESSAGE_TYPES.PING, clientTime });
  }

  startTelemetry() {
    if (this._telemetryEnabled) return true;
    this._telemetryEnabled = true;
    if (this.socket?.readyState === 1) this._startTelemetryLoop();
    return true;
  }

  stopTelemetry() {
    this._telemetryEnabled = false;
    this._stopTelemetryLoop({ clearMetrics: true });
    return true;
  }

  send(message) {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return false;
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...message }));
    return true;
  }

  /** Leave the current Room but keep the socket subscribed to the Lobby. */
  leaveRoom() {
    this._cancelReconnect();
    const open = this.socket?.readyState === 1;
    if (open) {
      this.send({ type: CLIENT_MESSAGE_TYPES.LEAVE_ROOM });
    } else {
      this._closeCurrentSocket('leave room');
    }
    this._clearRoomSession();
    this.scope = 'lobby';
    if (!open) this._open({ type: CLIENT_MESSAGE_TYPES.ENTER_LOBBY });
    return true;
  }

  /** Close online transport when returning from the Lobby to the title. */
  disconnect({ clearSession = true } = {}) {
    this._cancelReconnect();
    this._stopTelemetryLoop({ clearMetrics: true });
    this._pendingMessages.length = 0;
    this._connectionPurpose = null;
    this._connectionFailureReported = false;
    this.scope = 'none';
    if (clearSession) this._clearRoomSession();
    this._closeCurrentSocket('left online');
    this.state = 'idle';
    this._emit('connection', { state: this.state });
  }

  dispose() {
    this.stopTelemetry();
    this.disconnect({ clearSession: false });
    this._listeners.clear();
  }

  _sendLobbyCommand(message) {
    if (this.send(message)) return true;
    this._pendingMessages.push(message);
    if (!this.socket || this.socket.readyState >= 2) {
      this._open({ type: CLIENT_MESSAGE_TYPES.ENTER_LOBBY });
    }
    return true;
  }

  _open(initialMessage, reconnecting = false) {
    if (!this.WebSocketImpl) {
      this._reportConnectionFailure({
        code: 'websocket_unavailable',
        message: 'WebSocket is unavailable.',
      });
      return;
    }
    this._cancelReconnect({ resetAttempts: false });
    this._stopTelemetryLoop({ clearMetrics: true });
    this._closeCurrentSocket('replaced');

    this._connectionPurpose = initialMessage.type;
    this.state = reconnecting ? 'reconnecting' : 'connecting';
    this._emit('connection', { state: this.state });

    const socket = new this.WebSocketImpl(this.url);
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (socket !== this.socket) return;
      this.state = reconnecting ? 'reconnecting' : 'connected';
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...initialMessage }));
      for (const message of this._pendingMessages.splice(0)) {
        socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...message }));
      }
      this._emit('connection', { state: this.state });
      if (this._telemetryEnabled) this._startTelemetryLoop();
    });
    socket.addEventListener('message', (event) => {
      if (socket !== this.socket) return;
      this._handleRawMessage(event.data);
    });
    socket.addEventListener('error', () => {
      if (socket !== this.socket) return;
      this._reportConnectionFailure({
        code: 'socket_error',
        message: 'Network connection failed.',
      });
    });
    socket.addEventListener('close', (event) => {
      if (socket !== this.socket) return;
      this.socket = null;
      this._handleClose(event);
    });
  }

  _handleRawMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      this._reportConnectionFailure({
        code: 'invalid_server_message',
        message: 'Received invalid server data.',
      });
      return;
    }
    if (!message || message.v !== PROTOCOL_VERSION || typeof message.type !== 'string') {
      this._reportConnectionFailure({
        code: 'protocol_mismatch',
        message: 'Server protocol mismatch.',
      });
      return;
    }

    // Any valid server message proves that the current outage is over. A later
    // transport failure may notify the UI again, while retries belonging to the
    // same outage remain silent after the first connection-error alert.
    this._connectionFailureReported = false;

    let resumeRejected = null;
    if (message.type === SERVER_MESSAGE_TYPES.WELCOME) {
      this._captureSession(message);
      const hasBoundSession = Boolean(message.participantId || message.session?.participantId);
      if (hasBoundSession) {
        this.scope = 'room';
        this._reconnectAttempt = 0;
        this._reconnectDeadline = 0;
        this._clearReconnectExpiry();
        this._connectionPurpose = null;
      }
      this.state = 'connected';
      this._emit('connection', { state: this.state });
    } else if (message.type === SERVER_MESSAGE_TYPES.LOBBY_STATE) {
      this.lobby = message;
      // lobby_state is authoritative proof that this connection is no longer
      // bound to a Room (leave, expiry, destruction, or a fresh subscription).
      this._clearRoomSession();
      this.scope = 'lobby';
      this._reconnectAttempt = 0;
      this._connectionPurpose = null;
      this.state = 'connected';
    } else if (message.type === SERVER_MESSAGE_TYPES.ROOM_STATE) {
      this.room = message.room || message;
      this.scope = 'room';
      this._captureSession(message);
      this._connectionPurpose = null;
      const phase = String(this.room?.phase || this.room?.state || '');
      const members = this.room?.members || this.room?.participants || this.room?.players || [];
      const self = Array.isArray(members)
        ? members.find((member) => String(member?.participantId || member?.id || '') === String(this.selfId || ''))
        : null;
      if (phase === ROOM_STATES.WAITING || self?.postRaceState === 'room') this.raceId = null;
    } else if (message.type === SERVER_MESSAGE_TYPES.KICKED) {
      this._cancelReconnect();
      this._clearRoomSession();
      this.scope = 'lobby';
      this._connectionPurpose = null;
    } else if (message.type === SERVER_MESSAGE_TYPES.PREPARE_RACE) {
      this.raceId = message.raceId;
    } else if (message.type === SERVER_MESSAGE_TYPES.RACE_RESULTS) {
      this.raceId = message.raceId || this.raceId;
    } else if (message.type === SERVER_MESSAGE_TYPES.PONG) {
      this._captureTelemetry(message);
    } else if (message.type === SERVER_MESSAGE_TYPES.SERVER_STATS) {
      this._captureOnlineCount(message);
    } else if (message.type === SERVER_MESSAGE_TYPES.ERROR
      && this._connectionPurpose === CLIENT_MESSAGE_TYPES.RESUME
      && (message.code === ERROR_CODES.SESSION_NOT_FOUND
        || message.code === ERROR_CODES.SESSION_EXPIRED)) {
      resumeRejected = { roomCode: this.room?.code || null, code: message.code };
      this._clearRoomSession();
      this.scope = 'lobby';
      this._connectionPurpose = null;
    }

    this._emit(message.type, message);
    if (resumeRejected) {
      this._emit('reconnect_expired', resumeRejected);
      this.send({ type: CLIENT_MESSAGE_TYPES.ENTER_LOBBY });
    }
  }

  _captureSession(message) {
    const session = message.session || message.self || message;
    const participantId = session.participantId || session.id;
    const resumeToken = session.resumeToken;
    const code = session.roomCode
      || message.roomCode
      || message.room?.roomCode
      || message.room?.code
      || this.room?.roomCode
      || this.room?.code;
    if (participantId) this.selfId = participantId;
    if (resumeToken) this.resumeToken = resumeToken;
    if (code) {
      this.room = this.room && typeof this.room === 'object'
        ? { ...this.room, code: normalizeCode(code) }
        : { code: normalizeCode(code) };
    }
  }

  _reportConnectionFailure(error) {
    if (this._connectionFailureReported) return false;
    this._connectionFailureReported = true;
    this._emit('error', error);
    return true;
  }

  _handleClose(event) {
    this._stopTelemetryLoop({ clearMetrics: true });
    this.state = 'disconnected';
    this._emit('connection', {
      state: this.state,
      code: event?.code,
      reason: event?.reason || '',
    });

    // A replaced Room session must not resume and evict the other window back.
    // It may still reconnect anonymously to the Lobby.
    if (event?.code === 4001) {
      const replaced = { roomCode: this.room?.code || null, code: 'session_replaced' };
      this._clearRoomSession();
      this.scope = 'lobby';
      this._emit('reconnect_expired', replaced);
      this._emit('error', {
        code: 'session_replaced',
        message: 'This room session was resumed in another window.',
      });
      this._scheduleLobbyReconnect();
      return;
    }

    if (this.scope === 'lobby') {
      this._scheduleLobbyReconnect();
      return;
    }
    if (this.scope !== 'room' || !this.room?.code || !this.selfId || !this.resumeToken) return;

    if (!this._reconnectDeadline) this._reconnectDeadline = this._now() + RECONNECT_WINDOW_MS;
    if (this._now() >= this._reconnectDeadline) {
      this._expireRoomReconnect();
      return;
    }
    const delay = this._nextReconnectDelay();
    this._reconnectTimer = this._setTimeout(() => {
      this._reconnectTimer = null;
      this._open(this._resumeMessage(), true);
    }, delay);
    this._armReconnectExpiry();
  }

  _scheduleLobbyReconnect() {
    const delay = this._nextReconnectDelay();
    this._reconnectTimer = this._setTimeout(() => {
      this._reconnectTimer = null;
      if (this.scope === 'lobby') {
        this._open({ type: CLIENT_MESSAGE_TYPES.ENTER_LOBBY }, true);
      }
    }, delay);
  }

  _nextReconnectDelay() {
    const delay = RECONNECT_DELAYS_MS[
      Math.min(this._reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
    ];
    this._reconnectAttempt++;
    return delay;
  }

  _cancelReconnect({ resetAttempts = true } = {}) {
    if (this._reconnectTimer != null) this._clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    if (resetAttempts) {
      this._clearReconnectExpiry();
      this._reconnectAttempt = 0;
      this._reconnectDeadline = 0;
    }
  }

  _armReconnectExpiry() {
    if (this._reconnectExpiryTimer != null || !this._reconnectDeadline) return;
    const delay = Math.max(0, this._reconnectDeadline - this._now());
    this._reconnectExpiryTimer = this._setTimeout(() => {
      this._reconnectExpiryTimer = null;
      if (!this._expireRoomReconnect()) this._armReconnectExpiry();
    }, delay);
  }

  _clearReconnectExpiry() {
    if (this._reconnectExpiryTimer != null) this._clearTimeout(this._reconnectExpiryTimer);
    this._reconnectExpiryTimer = null;
  }

  _expireRoomReconnect() {
    if (!this._reconnectDeadline || this._now() < this._reconnectDeadline
      || this.scope !== 'room' || !this.room?.code || !this.selfId || !this.resumeToken) {
      return false;
    }
    const expired = { roomCode: this.room.code, code: ERROR_CODES.SESSION_EXPIRED };
    this._cancelReconnect({ resetAttempts: false });
    this._closeCurrentSocket('Room reconnect expired');
    this._clearRoomSession();
    this.scope = 'lobby';
    this._emit('reconnect_expired', expired);
    this._scheduleLobbyReconnect();
    return true;
  }

  _startTelemetryLoop() {
    if (!this._telemetryEnabled || this.socket?.readyState !== 1) return;
    if (this._telemetryTimer != null) this._clearTimeout(this._telemetryTimer);
    this._telemetryTimer = null;
    this._runTelemetryCycle();
  }

  _runTelemetryCycle() {
    if (!this._telemetryEnabled || this.socket?.readyState !== 1) {
      this._telemetryTimer = null;
      return;
    }
    const now = this._now();
    if (this._lastPongAt != null && now - this._lastPongAt >= TELEMETRY_STALE_MS) {
      this._resetTelemetryMetrics();
    }
    this.ping(now);
    this._telemetryTimer = this._setTimeout(() => {
      this._telemetryTimer = null;
      this._runTelemetryCycle();
    }, TELEMETRY_PING_INTERVAL_MS);
  }

  _stopTelemetryLoop({ clearMetrics = false } = {}) {
    if (this._telemetryTimer != null) this._clearTimeout(this._telemetryTimer);
    this._telemetryTimer = null;
    this._lastPongAt = null;
    if (clearMetrics) this._resetTelemetryMetrics();
  }

  _captureTelemetry(message) {
    const now = this._now();
    const clientTime = Number(message.clientTime);
    const onlineCount = Number(message.onlineCount);
    const hasClientTime = message.clientTime !== null && message.clientTime !== undefined
      && message.clientTime !== '';
    const hasOnlineCount = message.onlineCount !== null && message.onlineCount !== undefined
      && message.onlineCount !== '';
    this._lastPongAt = now;
    this.latencyMs = hasClientTime && Number.isFinite(clientTime)
      ? Math.max(0, Math.round(now - clientTime))
      : null;
    this.onlineCount = hasOnlineCount && Number.isFinite(onlineCount) && onlineCount >= 0
      ? Math.trunc(onlineCount)
      : null;
    this._emit('telemetry', {
      latencyMs: this.latencyMs,
      onlineCount: this.onlineCount,
    });
  }

  _captureOnlineCount(message) {
    const onlineCount = Number(message.onlineCount);
    const hasOnlineCount = message.onlineCount !== null && message.onlineCount !== undefined
      && message.onlineCount !== '';
    this.onlineCount = hasOnlineCount && Number.isFinite(onlineCount) && onlineCount >= 0
      ? Math.trunc(onlineCount)
      : null;
    this._emit('telemetry', {
      latencyMs: this.latencyMs,
      onlineCount: this.onlineCount,
    });
  }

  _resetTelemetryMetrics() {
    if (this.latencyMs === null && this.onlineCount === null) return;
    this.latencyMs = null;
    this.onlineCount = null;
    this._emit('telemetry', { latencyMs: null, onlineCount: null });
  }

  _closeCurrentSocket(reason) {
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < 2) socket.close(1000, reason);
  }

  _resumeMessage() {
    return {
      type: CLIENT_MESSAGE_TYPES.RESUME,
      roomCode: this.room.code,
      participantId: this.selfId,
      resumeToken: this.resumeToken,
    };
  }

  _purgePersistedSessions() {
    if (!this.storage) return;
    try {
      this.storage.removeItem(LEGACY_SESSION_STORAGE_KEY);
      this.storage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // Storage can disappear in privacy modes; live in-memory play still works.
    }
  }

  _clearRoomSession() {
    this._clearReconnectExpiry();
    this._reconnectDeadline = 0;
    this._purgePersistedSessions();
    this.room = null;
    this.selfId = null;
    this.resumeToken = null;
    this.raceId = null;
  }
}

export const ONLINE_SESSION_STORAGE_KEY = SESSION_STORAGE_KEY;
export const LEGACY_ONLINE_SESSION_STORAGE_KEY = LEGACY_SESSION_STORAGE_KEY;
