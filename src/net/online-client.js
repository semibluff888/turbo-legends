// Browser-side WebSocket client for room/lobby lifecycle.
//
// Race rendering and prediction live in online-race-session.js. This class
// owns transport, reconnect credentials, lobby commands, and typed event
// delivery. It deliberately does not touch the DOM.

import {
  CLIENT_MESSAGE_TYPES,
  ERROR_CODES,
  PROTOCOL_VERSION,
  SERVER_MESSAGE_TYPES,
} from './protocol.js';

const SESSION_STORAGE_KEY = 'turbo-legends.online-session.v1';
const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000];
const RECONNECT_WINDOW_MS = 30_000;

function safeStorage(candidate) {
  if (!candidate) return null;
  try {
    const probe = '__turbo_legends_probe__';
    candidate.setItem(probe, '1');
    candidate.removeItem(probe);
    return candidate;
  } catch {
    return null;
  }
}

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
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
    now = () => Date.now(),
  } = {}) {
    this.WebSocketImpl = WebSocketImpl;
    this.url = webSocketUrl(location);
    this.storage = safeStorage(sessionStorage);
    this._setTimeout = setTimeoutImpl;
    this._clearTimeout = clearTimeoutImpl;
    this._now = now;

    this.socket = null;
    this.state = 'idle';
    this.room = null;
    this.selfId = null;
    this.resumeToken = null;
    this.raceId = null;

    this._listeners = new Map();
    this._initialMessage = null;
    this._intentionalClose = false;
    this._reconnectTimer = null;
    this._reconnectAttempt = 0;
    this._reconnectDeadline = 0;

    this._loadStoredSession();
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

  createRoom(nickname) {
    this._clearStoredSession();
    this._open({
      type: CLIENT_MESSAGE_TYPES.CREATE_ROOM,
      displayName: String(nickname || '').trim(),
    });
  }

  joinRoom(code, nickname) {
    this._clearStoredSession();
    this._open({
      type: 'join_room',
      roomCode: normalizeCode(code),
      displayName: String(nickname || '').trim(),
    });
  }

  resumeStored() {
    if (!this.room?.code || !this.selfId || !this.resumeToken) return false;
    this._open(this._resumeMessage(), true);
    return true;
  }

  selectCharacter(characterId) {
    return this.send({ type: 'select_character', characterId });
  }

  setRoom(settings) {
    return this.send({ type: 'set_room', ...settings });
  }

  setReady(ready) {
    return this.send({ type: 'set_ready', ready: !!ready });
  }

  startRace() {
    return this.send({ type: 'start_race' });
  }

  markRaceLoaded(raceId = this.raceId) {
    return this.send({ type: 'race_loaded', raceId });
  }

  returnLobby() {
    return this.send({ type: 'return_lobby', raceId: this.raceId });
  }

  sendInput(input) {
    if (!this.raceId) return false;
    return this.send({ type: 'input', raceId: this.raceId, ...input });
  }

  ping(clientTime = (globalThis.performance?.now?.() ?? this._now())) {
    return this.send({ type: 'ping', clientTime });
  }

  send(message) {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return false;
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...message }));
    return true;
  }

  leave() {
    this._intentionalClose = true;
    if (this._reconnectTimer != null) this._clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this._reconnectAttempt = 0;
    this._reconnectDeadline = 0;
    this.send({ type: 'leave', raceId: this.raceId });
    this._clearStoredSession();
    this.raceId = null;
    if (this.socket && this.socket.readyState < 2) this.socket.close(1000, 'left room');
    this.state = 'idle';
    this._emit('connection', { state: this.state });
  }

  dispose() {
    this._intentionalClose = true;
    if (this._reconnectTimer != null) this._clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    if (this.socket && this.socket.readyState < 2) this.socket.close(1000, 'disposed');
    this.socket = null;
    this._listeners.clear();
  }

  _open(initialMessage, reconnecting = false) {
    if (!this.WebSocketImpl) {
      this._emit('error', { code: 'websocket_unavailable', message: 'WebSocket is unavailable.' });
      return;
    }
    if (this._reconnectTimer != null) this._clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    if (this.socket && this.socket.readyState < 2) {
      this._intentionalClose = true;
      this.socket.close(1000, 'replaced');
    }

    this._intentionalClose = false;
    this._initialMessage = { v: PROTOCOL_VERSION, ...initialMessage };
    this.state = reconnecting ? 'reconnecting' : 'connecting';
    this._emit('connection', { state: this.state });

    const socket = new this.WebSocketImpl(this.url);
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (socket !== this.socket) return;
      this.state = reconnecting ? 'reconnecting' : 'connected';
      socket.send(JSON.stringify(this._initialMessage));
      this._emit('connection', { state: this.state });
    });
    socket.addEventListener('message', (event) => {
      if (socket !== this.socket) return;
      this._handleRawMessage(event.data);
    });
    socket.addEventListener('error', () => {
      if (socket !== this.socket) return;
      this._emit('error', { code: 'socket_error', message: 'Network connection failed.' });
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
      this._emit('error', { code: 'invalid_server_message', message: 'Received invalid server data.' });
      return;
    }
    if (!message || message.v !== PROTOCOL_VERSION || typeof message.type !== 'string') {
      this._emit('error', { code: 'protocol_mismatch', message: 'Server protocol mismatch.' });
      return;
    }

    let resumeRejected = null;
    if (message.type === SERVER_MESSAGE_TYPES.WELCOME) {
      this._captureSession(message);
      if (message.participantId || message.session?.participantId) {
        this._reconnectAttempt = 0;
        this._reconnectDeadline = 0;
      }
      this.state = 'connected';
      this._emit('connection', { state: this.state });
    } else if (message.type === SERVER_MESSAGE_TYPES.ROOM_STATE) {
      this.room = message.room || message;
      this._captureSession(message);
      const phase = String(this.room?.phase || this.room?.state || '');
      const members = this.room?.members || this.room?.participants || this.room?.players || [];
      const self = Array.isArray(members)
        ? members.find((member) => String(member?.participantId || member?.id || '') === String(this.selfId || ''))
        : null;
      if (phase === 'lobby' || (phase === 'results' && self?.postRaceState === 'lobby')) {
        this.raceId = null;
      }
    } else if (message.type === SERVER_MESSAGE_TYPES.PREPARE_RACE) {
      this.raceId = message.raceId;
    } else if (message.type === SERVER_MESSAGE_TYPES.RACE_RESULTS) {
      this.raceId = message.raceId || this.raceId;
    } else if (message.type === SERVER_MESSAGE_TYPES.ERROR
      && this._initialMessage?.type === CLIENT_MESSAGE_TYPES.RESUME
      && (message.code === ERROR_CODES.SESSION_NOT_FOUND
        || message.code === ERROR_CODES.SESSION_EXPIRED)) {
      resumeRejected = { roomCode: this.room?.code || null, code: message.code };
      this._clearStoredSession();
    }

    this._emit(message.type, message);
    if (resumeRejected) this._emit('reconnect_expired', resumeRejected);
  }

  _captureSession(message) {
    const session = message.session || message.self || message;
    const participantId = session.participantId || session.id;
    const resumeToken = session.resumeToken;
    const code = session.roomCode
      || message.roomCode
      || message.room?.roomCode
      || message.room?.code
      || message.code
      || this.room?.roomCode
      || this.room?.code;
    if (participantId) this.selfId = participantId;
    if (resumeToken) this.resumeToken = resumeToken;
    if (code) {
      this.room = this.room && typeof this.room === 'object'
        ? { ...this.room, code: normalizeCode(code) }
        : { code: normalizeCode(code) };
    }
    this._saveStoredSession();
  }

  _handleClose(event) {
    if (this._intentionalClose) {
      this._intentionalClose = false;
      return;
    }
    this.state = 'disconnected';
    this._emit('connection', {
      state: this.state,
      code: event?.code,
      reason: event?.reason || '',
    });

    // The server uses 4001 when the same credentials are resumed by another
    // browser. Retrying from this stale socket would make the two clients
    // repeatedly evict each other, so retire the old credentials immediately.
    if (event?.code === 4001) {
      const replaced = { roomCode: this.room?.code || null, code: 'session_replaced' };
      this._clearStoredSession();
      this._emit('reconnect_expired', replaced);
      this._emit('error', {
        code: 'session_replaced',
        message: 'This room session was resumed in another window.',
      });
      return;
    }
    if (!this.room?.code || !this.selfId || !this.resumeToken) return;

    if (!this._reconnectDeadline) this._reconnectDeadline = this._now() + RECONNECT_WINDOW_MS;
    if (this._now() >= this._reconnectDeadline) {
      const expired = { roomCode: this.room.code, code: ERROR_CODES.SESSION_EXPIRED };
      this._clearStoredSession();
      this._emit('reconnect_expired', expired);
      return;
    }
    const delay = RECONNECT_DELAYS_MS[
      Math.min(this._reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
    ];
    this._reconnectAttempt++;
    this._reconnectTimer = this._setTimeout(() => {
      this._reconnectTimer = null;
      this._open(this._resumeMessage(), true);
    }, delay);
  }

  _resumeMessage() {
    return {
      type: 'resume',
      roomCode: this.room.code,
      participantId: this.selfId,
      resumeToken: this.resumeToken,
    };
  }

  _loadStoredSession() {
    if (!this.storage) return;
    try {
      const value = JSON.parse(this.storage.getItem(SESSION_STORAGE_KEY) || 'null');
      if (!value || typeof value !== 'object') return;
      if (value.code) this.room = { code: normalizeCode(value.code) };
      if (value.participantId) this.selfId = value.participantId;
      if (value.resumeToken) this.resumeToken = value.resumeToken;
    } catch {
      this.storage.removeItem(SESSION_STORAGE_KEY);
    }
  }

  _saveStoredSession() {
    if (!this.storage || !this.room?.code || !this.selfId || !this.resumeToken) return;
    try {
      this.storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
        code: this.room.code,
        participantId: this.selfId,
        resumeToken: this.resumeToken,
      }));
    } catch {
      // Storage can disappear in privacy modes; the live socket still works.
    }
  }

  _clearStoredSession() {
    if (this.storage) {
      try { this.storage.removeItem(SESSION_STORAGE_KEY); } catch {}
    }
    this.room = null;
    this.selfId = null;
    this.resumeToken = null;
    this.raceId = null;
  }
}

export const ONLINE_SESSION_STORAGE_KEY = SESSION_STORAGE_KEY;
