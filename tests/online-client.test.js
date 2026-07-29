import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OnlineClient,
  ONLINE_SESSION_STORAGE_KEY,
  webSocketUrl,
} from '../src/net/online-client.js';

class MemoryStorage {
  constructor() { this.data = new Map(); }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.data.set(key, String(value)); }
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

test('createRoom opens a socket and sends a versioned command', () => {
  FakeWebSocket.instances.length = 0;
  const client = new OnlineClient({
    WebSocketImpl: FakeWebSocket,
    location: { protocol: 'http:', host: 'localhost:5173' },
    sessionStorage: new MemoryStorage(),
  });

  client.createRoom('Nova');
  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.url, 'ws://localhost:5173/ws');
  socket.open();
  assert.deepEqual(socket.sent[0], {
    v: 1,
    type: 'create_room',
    displayName: 'Nova',
  });
});

test('welcome credentials are persisted and room messages are emitted', () => {
  FakeWebSocket.instances.length = 0;
  const storage = new MemoryStorage();
  const client = new OnlineClient({
    WebSocketImpl: FakeWebSocket,
    location: { protocol: 'http:', host: 'localhost:5173' },
    sessionStorage: storage,
  });
  const received = [];
  client.on('room_state', (message) => received.push(message));

  client.joinRoom('ab2cd3', 'Kit');
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.receive({
    v: 1,
    type: 'welcome',
    code: 'AB2CD3',
    participantId: 'p1',
    resumeToken: 'secret',
  });
  socket.receive({
    v: 1,
    type: 'room_state',
    room: { code: 'AB2CD3', state: 'lobby', players: [] },
  });

  assert.equal(client.selfId, 'p1');
  assert.equal(client.resumeToken, 'secret');
  assert.equal(client.room.code, 'AB2CD3');
  assert.equal(received.length, 1);
  assert.deepEqual(JSON.parse(storage.getItem(ONLINE_SESSION_STORAGE_KEY)), {
    code: 'AB2CD3',
    participantId: 'p1',
    resumeToken: 'secret',
  });
});

test('returning from results clears the client race id without leaving the room', () => {
  FakeWebSocket.instances.length = 0;
  const client = new OnlineClient({
    WebSocketImpl: FakeWebSocket,
    location: { protocol: 'http:', host: 'localhost:5173' },
    sessionStorage: new MemoryStorage(),
  });
  client.createRoom('Host');
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.receive({
    v: 1,
    type: 'welcome',
    roomCode: 'ROOM22',
    participantId: 'host',
    resumeToken: 'secret',
  });
  socket.receive({ v: 1, type: 'prepare_race', raceId: 'race_identifier_123' });
  assert.equal(client.raceId, 'race_identifier_123');

  socket.receive({
    v: 1,
    type: 'room_state',
    roomCode: 'ROOM22',
    state: 'results',
    raceId: 'race_identifier_123',
    members: [
      { participantId: 'host', postRaceState: 'lobby', connected: true },
      { participantId: 'guest', postRaceState: 'results', connected: true },
    ],
  });
  assert.equal(client.raceId, null);
  assert.equal(client.room.code, 'ROOM22');
});

test('unexpected close schedules a resume attempt', () => {
  FakeWebSocket.instances.length = 0;
  const storage = new MemoryStorage();
  storage.setItem(ONLINE_SESSION_STORAGE_KEY, JSON.stringify({
    code: 'ROOM22',
    participantId: 'p2',
    resumeToken: 'token2',
  }));
  const timers = [];
  const client = new OnlineClient({
    WebSocketImpl: FakeWebSocket,
    location: { protocol: 'http:', host: 'localhost:5173' },
    sessionStorage: storage,
    setTimeoutImpl(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutImpl() {},
    now: () => 1000,
  });

  assert.equal(client.resumeStored(), true);
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.close(1006, 'network');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 250);

  timers[0].fn();
  const resumed = FakeWebSocket.instances[1];
  resumed.open();
  assert.deepEqual(resumed.sent[0], {
    v: 1,
    type: 'resume',
    roomCode: 'ROOM22',
    participantId: 'p2',
    resumeToken: 'token2',
  });
});

test('the reconnect deadline clears stale credentials', () => {
  FakeWebSocket.instances.length = 0;
  const storage = new MemoryStorage();
  storage.setItem(ONLINE_SESSION_STORAGE_KEY, JSON.stringify({
    code: 'ROOM22',
    participantId: 'p2',
    resumeToken: 'token2',
  }));
  const timers = [];
  const expired = [];
  let now = 1_000;
  const client = new OnlineClient({
    WebSocketImpl: FakeWebSocket,
    location: { protocol: 'http:', host: 'localhost:5173' },
    sessionStorage: storage,
    setTimeoutImpl(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutImpl() {},
    now: () => now,
  });
  client.on('reconnect_expired', (event) => expired.push(event));

  client.resumeStored();
  FakeWebSocket.instances[0].open();
  FakeWebSocket.instances[0].close(1006, 'network');
  timers[0].fn();
  FakeWebSocket.instances[1].open();
  now = 31_001;
  FakeWebSocket.instances[1].close(1006, 'network');

  assert.equal(storage.getItem(ONLINE_SESSION_STORAGE_KEY), null);
  assert.equal(client.room, null);
  assert.deepEqual(expired, [{ roomCode: 'ROOM22', code: 'session_expired' }]);
});

test('a session replaced by another window does not start a reconnect fight', () => {
  FakeWebSocket.instances.length = 0;
  const storage = new MemoryStorage();
  storage.setItem(ONLINE_SESSION_STORAGE_KEY, JSON.stringify({
    code: 'ROOM22',
    participantId: 'p2',
    resumeToken: 'token2',
  }));
  const timers = [];
  const errors = [];
  const expired = [];
  const client = new OnlineClient({
    WebSocketImpl: FakeWebSocket,
    location: { protocol: 'http:', host: 'localhost:5173' },
    sessionStorage: storage,
    setTimeoutImpl(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutImpl() {},
  });
  client.on('error', (error) => errors.push(error));
  client.on('reconnect_expired', (event) => expired.push(event));

  client.resumeStored();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.close(4001, 'Session resumed elsewhere');

  assert.equal(timers.length, 0);
  assert.equal(storage.getItem(ONLINE_SESSION_STORAGE_KEY), null);
  assert.equal(client.room, null);
  assert.equal(errors.at(-1).code, 'session_replaced');
  assert.deepEqual(expired, [{ roomCode: 'ROOM22', code: 'session_replaced' }]);
});

test('a rejected stored resume is cleared instead of looping on every refresh', () => {
  FakeWebSocket.instances.length = 0;
  const storage = new MemoryStorage();
  storage.setItem(ONLINE_SESSION_STORAGE_KEY, JSON.stringify({
    code: 'ROOM22',
    participantId: 'p2',
    resumeToken: 'token2',
  }));
  const expired = [];
  const client = new OnlineClient({
    WebSocketImpl: FakeWebSocket,
    location: { protocol: 'http:', host: 'localhost:5173' },
    sessionStorage: storage,
  });
  client.on('reconnect_expired', (event) => expired.push(event));

  client.resumeStored();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.receive({
    v: 1,
    type: 'error',
    code: 'session_expired',
    message: 'The reconnect window has expired.',
  });

  assert.equal(storage.getItem(ONLINE_SESSION_STORAGE_KEY), null);
  assert.equal(client.room, null);
  assert.deepEqual(expired, [{ roomCode: 'ROOM22', code: 'session_expired' }]);
});

test('leave clears resume credentials', () => {
  FakeWebSocket.instances.length = 0;
  const storage = new MemoryStorage();
  const client = new OnlineClient({
    WebSocketImpl: FakeWebSocket,
    location: { protocol: 'http:', host: 'localhost:5173' },
    sessionStorage: storage,
  });
  client.createRoom('Kit');
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.receive({
    v: 1,
    type: 'welcome',
    code: 'ROOM33',
    participantId: 'p3',
    resumeToken: 'token3',
  });

  client.leave();
  assert.equal(storage.getItem(ONLINE_SESSION_STORAGE_KEY), null);
  assert.equal(client.room, null);
  assert.equal(client.selfId, null);
});

test('leave cancels a pending automatic reconnect', () => {
  FakeWebSocket.instances.length = 0;
  const storage = new MemoryStorage();
  storage.setItem(ONLINE_SESSION_STORAGE_KEY, JSON.stringify({
    code: 'ROOM22',
    participantId: 'p2',
    resumeToken: 'token2',
  }));
  const timers = [];
  const cleared = [];
  const client = new OnlineClient({
    WebSocketImpl: FakeWebSocket,
    location: { protocol: 'http:', host: 'localhost:5173' },
    sessionStorage: storage,
    setTimeoutImpl(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutImpl(id) { cleared.push(id); },
  });

  client.resumeStored();
  FakeWebSocket.instances[0].open();
  FakeWebSocket.instances[0].close(1006, 'network');
  client.leave();

  assert.equal(timers.length, 1);
  assert.deepEqual(cleared, [1]);
  assert.equal(client._reconnectTimer, null);
  assert.equal(client.room, null);
});

test('server roomCode/session fields are accepted for reconnect credentials', () => {
  FakeWebSocket.instances.length = 0;
  const storage = new MemoryStorage();
  const client = new OnlineClient({
    WebSocketImpl: FakeWebSocket,
    location: { protocol: 'http:', host: 'localhost:5173' },
    sessionStorage: storage,
  });
  client.createRoom('Pip');
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.receive({
    v: 1,
    type: 'welcome',
    session: {
      participantId: 'p4',
      resumeToken: 'token4',
      roomCode: 'FAST22',
    },
  });

  assert.equal(client.room.code, 'FAST22');
  assert.equal(JSON.parse(storage.getItem(ONLINE_SESSION_STORAGE_KEY)).code, 'FAST22');
});
