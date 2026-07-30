import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEGACY_ONLINE_SESSION_STORAGE_KEY,
  OnlineClient,
  ONLINE_SESSION_STORAGE_KEY,
  TELEMETRY_PING_INTERVAL_MS,
  TELEMETRY_STALE_MS,
  webSocketUrl,
} from '../src/net/online-client.js';
import { PROTOCOL_VERSION } from '../src/net/protocol.js';

class MemoryStorage {
  constructor() { this.data = new Map(); this.writes = []; }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.writes.push([key, String(value)]); this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    let list = this.listeners.get(type);
    if (!list) {
      list = [];
      this.listeners.set(type, list);
    }
    list.push(listener);
  }

  emit(type, value = {}) {
    for (const listener of this.listeners.get(type) || []) listener(value);
  }

  open() {
    this.readyState = 1;
    this.emit('open');
  }

  receive(message) {
    this.emit('message', { data: JSON.stringify(message) });
  }

  send(value) { this.sent.push(JSON.parse(value)); }

  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }
}

function makeClient(options = {}) {
  return new OnlineClient({
    WebSocketImpl: FakeWebSocket,
    location: { protocol: 'http:', host: 'localhost:5173' },
    sessionStorage: new MemoryStorage(),
    ...options,
  });
}

function boundWelcome(socket, overrides = {}) {
  socket.receive({
    v: PROTOCOL_VERSION,
    type: 'welcome',
    session: {
      roomCode: 'ROOM22',
      participantId: 'p2',
      resumeToken: 'resume_token_1234567890',
      ...overrides,
    },
  });
}

function seedInMemoryRoomSession(client, overrides = {}) {
  client.room = { code: overrides.roomCode || 'ROOM22' };
  client.selfId = overrides.participantId || 'p2';
  client.resumeToken = overrides.resumeToken || 'resume_token_1234567890';
  client.scope = 'room';
}

test('webSocketUrl follows the page protocol and host', () => {
  assert.equal(
    webSocketUrl({ protocol: 'https:', host: 'game.example' }),
    'wss://game.example/ws',
  );
  assert.equal(
    webSocketUrl({ href: 'http://127.0.0.1:5173/play?x=1' }),
    'ws://127.0.0.1:5173/ws',
  );
});

test('enterLobby opens a versioned Lobby subscription', () => {
  FakeWebSocket.instances.length = 0;
  const client = makeClient();

  assert.equal(client.enterLobby(), true);
  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.url, 'ws://localhost:5173/ws');
  socket.open();
  assert.deepEqual(socket.sent, [{ v: PROTOCOL_VERSION, type: 'enter_lobby' }]);
  assert.equal(client.scope, 'lobby');
});

test('telemetry pings immediately, reports RTT and clears stale metrics', () => {
  FakeWebSocket.instances.length = 0;
  const timers = [];
  let now = 1_000;
  const client = makeClient({
    now: () => now,
    setTimeoutImpl(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutImpl() {},
  });
  const samples = [];
  client.on('telemetry', sample => samples.push(sample));
  client.startTelemetry();
  client.enterLobby();

  const socket = FakeWebSocket.instances[0];
  socket.open();
  assert.deepEqual(socket.sent, [
    { v: PROTOCOL_VERSION, type: 'enter_lobby' },
    { v: PROTOCOL_VERSION, type: 'ping', clientTime: 1_000 },
  ]);
  assert.equal(timers[0].ms, TELEMETRY_PING_INTERVAL_MS);

  now = 1_043;
  socket.receive({
    v: PROTOCOL_VERSION,
    type: 'pong',
    clientTime: 1_000,
    onlineCount: 12,
  });
  assert.deepEqual(samples.at(-1), { latencyMs: 43, onlineCount: 12 });

  socket.receive({
    v: PROTOCOL_VERSION,
    type: 'server_stats',
    onlineCount: 13,
  });
  assert.deepEqual(samples.at(-1), { latencyMs: 43, onlineCount: 13 });

  now = 2_000;
  timers[0].fn();
  assert.deepEqual(socket.sent.at(-1), {
    v: PROTOCOL_VERSION,
    type: 'ping',
    clientTime: 2_000,
  });

  now = 2_044.6;
  socket.receive({
    v: PROTOCOL_VERSION,
    type: 'pong',
    clientTime: 2_000,
    onlineCount: 13,
  });
  assert.deepEqual(samples.at(-1), { latencyMs: 45, onlineCount: 13 });

  now = 2_044.6 + TELEMETRY_STALE_MS + 1;
  timers[1].fn();
  assert.deepEqual(samples.at(-1), { latencyMs: null, onlineCount: null });
  assert.deepEqual(socket.sent.at(-1), {
    v: PROTOCOL_VERSION,
    type: 'ping',
    clientTime: now,
  });
});

test('telemetry pauses on disconnect and resumes with the Lobby reconnect', () => {
  FakeWebSocket.instances.length = 0;
  const timers = [];
  const cleared = [];
  const client = makeClient({
    now: () => 2_000,
    setTimeoutImpl(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutImpl(id) { cleared.push(id); },
  });
  client.startTelemetry();
  client.enterLobby();
  FakeWebSocket.instances[0].open();
  FakeWebSocket.instances[0].close(1006, 'network');

  assert.equal(cleared.includes(1), true);
  const reconnect = timers.find(timer => timer.ms === 250);
  assert.ok(reconnect);
  reconnect.fn();
  const replacement = FakeWebSocket.instances[1];
  replacement.open();
  assert.deepEqual(replacement.sent, [
    { v: PROTOCOL_VERSION, type: 'enter_lobby' },
    { v: PROTOCOL_VERSION, type: 'ping', clientTime: 2_000 },
  ]);
});

test('create, join and quick match reuse the existing Lobby socket', () => {
  FakeWebSocket.instances.length = 0;
  const client = makeClient();
  client.enterLobby();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.receive({ v: PROTOCOL_VERSION, type: 'lobby_state', rooms: [] });

  client.createRoom({
    displayName: 'Nova', roomName: 'Nova Grid', roomType: 'private', maxPlayers: 6, password: 'FastPass',
  });
  client.joinRoom({ roomCode: 'ab2cd3', displayName: 'Nova', password: 'FastPass' });
  client.quickMatch({ displayName: 'Nova' });

  assert.equal(FakeWebSocket.instances.length, 1);
  assert.deepEqual(socket.sent.slice(1), [
    {
      v: PROTOCOL_VERSION,
      type: 'create_room',
      displayName: 'Nova',
      roomName: 'Nova Grid',
      roomType: 'private',
      maxPlayers: 6,
      password: 'FastPass',
    },
    {
      v: PROTOCOL_VERSION,
      type: 'join_room',
      roomCode: 'AB2CD3',
      displayName: 'Nova',
      password: 'FastPass',
    },
    { v: PROTOCOL_VERSION, type: 'quick_match', displayName: 'Nova' },
  ]);
});

test('a command issued while connecting is queued behind enter_lobby', () => {
  FakeWebSocket.instances.length = 0;
  const client = makeClient();
  client.enterLobby();
  client.quickMatch({ displayName: 'Drift Comet' });

  const socket = FakeWebSocket.instances[0];
  socket.open();
  assert.deepEqual(socket.sent, [
    { v: PROTOCOL_VERSION, type: 'enter_lobby' },
    { v: PROTOCOL_VERSION, type: 'quick_match', displayName: 'Drift Comet' },
  ]);
});

test('welcome credentials stay in memory and room messages are emitted', () => {
  FakeWebSocket.instances.length = 0;
  const storage = new MemoryStorage();
  const client = makeClient({ sessionStorage: storage });
  const received = [];
  client.on('room_state', (message) => received.push(message));
  client.enterLobby();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  boundWelcome(socket, { participantId: 'p1', resumeToken: 'resume_secret_1234' });
  socket.receive({
    v: PROTOCOL_VERSION,
    type: 'room_state',
    roomCode: 'ROOM22',
    state: 'waiting',
    members: [],
  });

  assert.equal(client.selfId, 'p1');
  assert.equal(client.resumeToken, 'resume_secret_1234');
  assert.equal(client.room.code, 'ROOM22');
  assert.equal(received.length, 1);
  assert.equal(storage.getItem(ONLINE_SESSION_STORAGE_KEY), null);
  assert.deepEqual(storage.writes, []);
  assert.equal(
    [...storage.data.values()].some((value) => /p1|resume_secret_1234/.test(value)),
    false,
  );
});

test('returnRoom keeps the Room session and clears race id after the local return', () => {
  FakeWebSocket.instances.length = 0;
  const client = makeClient();
  client.enterLobby();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  boundWelcome(socket, { participantId: 'host' });
  socket.receive({ v: PROTOCOL_VERSION, type: 'prepare_race', raceId: 'race_identifier_123' });

  assert.equal(client.returnRoom(), true);
  assert.deepEqual(socket.sent.at(-1), {
    v: PROTOCOL_VERSION,
    type: 'return_room',
  });
  socket.receive({
    v: PROTOCOL_VERSION,
    type: 'room_state',
    roomCode: 'ROOM22',
    state: 'results',
    members: [
      { participantId: 'host', postRaceState: 'room', connected: true },
      { participantId: 'guest', postRaceState: 'results', connected: true },
    ],
  });
  assert.equal(client.raceId, null);
  assert.equal(client.room.code, 'ROOM22');
});

test('unexpected Room close schedules a resume attempt', () => {
  FakeWebSocket.instances.length = 0;
  const timers = [];
  const client = makeClient({
    setTimeoutImpl(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutImpl() {},
    now: () => 1000,
  });

  client.enterLobby();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  boundWelcome(socket);
  socket.close(1006, 'network');
  assert.equal(timers[0].ms, 250);

  timers[0].fn();
  const resumed = FakeWebSocket.instances[1];
  resumed.open();
  assert.deepEqual(resumed.sent[0], {
    v: PROTOCOL_VERSION,
    type: 'resume',
    roomCode: 'ROOM22',
    participantId: 'p2',
    resumeToken: 'resume_token_1234567890',
  });
});

test('unexpected Lobby close reconnects with enter_lobby instead of resume', () => {
  FakeWebSocket.instances.length = 0;
  const timers = [];
  const client = makeClient({
    setTimeoutImpl(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutImpl() {},
  });
  client.enterLobby();
  FakeWebSocket.instances[0].open();
  FakeWebSocket.instances[0].close(1006, 'network');

  assert.equal(timers[0].ms, 250);
  timers[0].fn();
  FakeWebSocket.instances[1].open();
  assert.deepEqual(FakeWebSocket.instances[1].sent[0], {
    v: PROTOCOL_VERSION,
    type: 'enter_lobby',
  });
});

test('an anonymous welcome does not hide a later rejected resume', () => {
  FakeWebSocket.instances.length = 0;
  const storage = new MemoryStorage();
  const expired = [];
  const client = makeClient({ sessionStorage: storage });
  client.on('reconnect_expired', (event) => expired.push(event));
  seedInMemoryRoomSession(client);
  client.resumeRoomSession();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.receive({ v: PROTOCOL_VERSION, type: 'welcome', session: null });
  socket.receive({
    v: PROTOCOL_VERSION,
    type: 'error',
    code: 'session_expired',
    message: 'The reconnect window has expired.',
  });

  assert.equal(storage.getItem(ONLINE_SESSION_STORAGE_KEY), null);
  assert.equal(client.room, null);
  assert.deepEqual(expired, [{ roomCode: 'ROOM22', code: 'session_expired' }]);
  assert.deepEqual(socket.sent.at(-1), { v: PROTOCOL_VERSION, type: 'enter_lobby' });
});

test('the Room reconnect deadline retires credentials and falls back to Lobby', () => {
  FakeWebSocket.instances.length = 0;
  const storage = new MemoryStorage();
  const timers = [];
  const expired = [];
  let now = 1_000;
  const client = makeClient({
    sessionStorage: storage,
    setTimeoutImpl(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutImpl() {},
    now: () => now,
  });
  client.on('reconnect_expired', (event) => expired.push(event));

  client.enterLobby();
  FakeWebSocket.instances[0].open();
  boundWelcome(FakeWebSocket.instances[0]);
  FakeWebSocket.instances[0].close(1006, 'network');
  timers[0].fn();
  FakeWebSocket.instances[1].open();
  now = 31_001;
  FakeWebSocket.instances[1].close(1006, 'network');

  assert.equal(storage.getItem(ONLINE_SESSION_STORAGE_KEY), null);
  assert.equal(client.room, null);
  assert.equal(client.scope, 'lobby');
  assert.deepEqual(expired, [{ roomCode: 'ROOM22', code: 'session_expired' }]);
  assert.equal(timers.length, 2);
});

test('leaveRoom clears credentials, sends leave_room, and keeps the socket open', () => {
  FakeWebSocket.instances.length = 0;
  const storage = new MemoryStorage();
  const client = makeClient({ sessionStorage: storage });
  client.enterLobby();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  boundWelcome(socket, { participantId: 'p3', resumeToken: 'resume_token_3333333333' });

  client.leaveRoom();

  assert.deepEqual(socket.sent.at(-1), { v: PROTOCOL_VERSION, type: 'leave_room' });
  assert.equal(socket.readyState, 1);
  assert.equal(storage.getItem(ONLINE_SESSION_STORAGE_KEY), null);
  assert.equal(client.room, null);
  assert.equal(client.selfId, null);
  assert.equal(client.scope, 'lobby');
});

test('an authoritative lobby_state also retires stale Room credentials', () => {
  FakeWebSocket.instances.length = 0;
  const storage = new MemoryStorage();
  const client = makeClient({ sessionStorage: storage });
  client.enterLobby();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  boundWelcome(socket);
  assert.equal(client.room.code, 'ROOM22');

  socket.receive({ v: PROTOCOL_VERSION, type: 'lobby_state', rooms: [] });
  assert.equal(client.scope, 'lobby');
  assert.equal(client.room, null);
  assert.equal(client.selfId, null);
  assert.equal(storage.getItem(ONLINE_SESSION_STORAGE_KEY), null);
});

test('leaveRoom cancels a pending Room reconnect and opens a Lobby connection', () => {
  FakeWebSocket.instances.length = 0;
  const storage = new MemoryStorage();
  const timers = [];
  const cleared = [];
  const client = makeClient({
    sessionStorage: storage,
    setTimeoutImpl(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutImpl(id) { cleared.push(id); },
  });

  client.enterLobby();
  FakeWebSocket.instances[0].open();
  boundWelcome(FakeWebSocket.instances[0]);
  FakeWebSocket.instances[0].close(1006, 'network');
  client.leaveRoom();

  assert.deepEqual(cleared, [1]);
  assert.equal(client._reconnectTimer, null);
  const lobbySocket = FakeWebSocket.instances[1];
  lobbySocket.open();
  assert.deepEqual(lobbySocket.sent[0], { v: PROTOCOL_VERSION, type: 'enter_lobby' });
});

test('disconnect is the operation that closes the Lobby transport', () => {
  FakeWebSocket.instances.length = 0;
  const client = makeClient();
  client.enterLobby();
  const socket = FakeWebSocket.instances[0];
  socket.open();

  client.disconnect();
  assert.equal(socket.readyState, 3);
  assert.equal(client.socket, null);
  assert.equal(client.state, 'idle');
  assert.equal(client.scope, 'none');
});

test('protocol-v1 and v2 browser credentials are discarded instead of migrated', () => {
  const storage = new MemoryStorage();
  storage.setItem(LEGACY_ONLINE_SESSION_STORAGE_KEY, JSON.stringify({
    code: 'OLD234', participantId: 'old', resumeToken: 'old_token_123456',
  }));
  storage.setItem(ONLINE_SESSION_STORAGE_KEY, JSON.stringify({
    code: 'NEW234', participantId: 'new', resumeToken: 'new_token_123456',
  }));
  const client = makeClient({ sessionStorage: storage });

  assert.equal(storage.getItem(LEGACY_ONLINE_SESSION_STORAGE_KEY), null);
  assert.equal(storage.getItem(ONLINE_SESSION_STORAGE_KEY), null);
  assert.equal(client.room, null);
  assert.equal(client.resumeRoomSession(), false);
});
