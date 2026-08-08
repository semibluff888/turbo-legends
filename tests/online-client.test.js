import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEGACY_ONLINE_SESSION_STORAGE_KEY,
  MAX_RACE_INPUT_BUFFERED_BYTES,
  OnlineClient,
  ONLINE_SESSION_STORAGE_KEY,
  TELEMETRY_PING_INTERVAL_MS,
  TELEMETRY_STALE_MS,
  webSocketUrl,
} from '../src/net/online-client.js';
import {
  CHAT_SEND_INTERVAL_MS,
  ERROR_CODES,
  PROTOCOL_VERSION,
} from '../src/net/protocol.js';
import {
  decodeInputPacket,
  encodeSnapshotPacket,
} from '../src/net/binary-race-codec.js';

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
    this.bufferedAmount = 0;
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

  receiveBinary(value) {
    this.emit('message', { data: value });
  }

  send(value) {
    this.sent.push(typeof value === 'string' ? JSON.parse(value) : value);
  }

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
    random: () => 0.5,
    connectTimeoutMs: 0,
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

test('room chat is locally limited to one successful send every 3 seconds', () => {
  FakeWebSocket.instances.length = 0;
  let now = 1_000;
  const client = makeClient({ now: () => now });
  const rateLimits = [];
  client.on('chat_rate_limited', event => rateLimits.push(event));
  client.enterLobby();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  boundWelcome(socket);

  assert.equal(client.sendChat('  Hello room  '), true);
  assert.deepEqual(socket.sent.at(-1), {
    v: PROTOCOL_VERSION,
    type: 'send_chat',
    content: 'Hello room',
  });

  now += CHAT_SEND_INTERVAL_MS - 1;
  assert.equal(client.sendChat('Too soon'), false);
  assert.deepEqual(rateLimits, [{
    code: ERROR_CODES.CHAT_RATE_LIMITED,
    retryAfterMs: 1,
  }]);
  assert.equal(socket.sent.some(message => message.content === 'Too soon'), false);

  now += 1;
  assert.equal(client.sendChat('Ready now'), true);
  assert.equal(socket.sent.at(-1).content, 'Ready now');
});

test('telemetry keeps the browser-global receiver for native timer functions', () => {
  FakeWebSocket.instances.length = 0;
  const receivers = [];
  const timers = [];
  function browserSetTimeout(fn, ms) {
    receivers.push(this);
    timers.push({ fn, ms });
    return timers.length;
  }
  function browserClearTimeout() {
    receivers.push(this);
  }
  const client = makeClient({
    setTimeoutImpl: browserSetTimeout,
    clearTimeoutImpl: browserClearTimeout,
  });
  client.startTelemetry();
  client.enterLobby();

  FakeWebSocket.instances[0].open();
  assert.equal(receivers[0], globalThis);
  assert.equal(timers[0].ms, TELEMETRY_PING_INTERVAL_MS);

  client.stopTelemetry();
  assert.equal(receivers[1], globalThis);
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
    displayName: 'Nova', roomName: 'Nova Grid', roomType: 'private', maxPlayers: 6,
    trackId: 'harbor-loop', password: 'FastPass',
    characterId: 'kit', paintId: 'turbo-blue', avatarId: 'cat',
  });
  client.joinRoom({
    roomCode: 'ab2cd3', displayName: 'Nova', password: 'FastPass',
    characterId: 'kit', paintId: 'pearl-flash', avatarId: 'rabbit',
  });
  client.quickMatch({
    displayName: 'Nova', characterId: 'kit', paintId: 'violet-volt', avatarId: 'fox',
  });

  assert.equal(FakeWebSocket.instances.length, 1);
  assert.deepEqual(socket.sent.slice(1), [
    {
      v: PROTOCOL_VERSION,
      type: 'create_room',
      roomName: 'Nova Grid',
      roomType: 'private',
      maxPlayers: 6,
      trackId: 'harbor-loop',
      password: 'FastPass',
      characterId: 'kit',
      paintId: 'turbo-blue',
      avatarId: 'cat',
    },
    {
      v: PROTOCOL_VERSION,
      type: 'join_room',
      roomCode: 'AB2CD3',
      password: 'FastPass',
      characterId: 'kit',
      paintId: 'pearl-flash',
      avatarId: 'rabbit',
    },
    {
      v: PROTOCOL_VERSION, type: 'quick_match',
      characterId: 'kit', paintId: 'violet-volt', avatarId: 'fox',
    },
  ]);
});

test('setLoadout sends one atomic Room command', () => {
  FakeWebSocket.instances.length = 0;
  const client = makeClient();
  client.enterLobby();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  boundWelcome(socket);
  assert.equal(client.setLoadout({
    characterId: 'kit', paintId: 'graphite-gold', avatarId: 'tiger',
  }), true);
  assert.deepEqual(socket.sent.at(-1), {
    v: PROTOCOL_VERSION,
    type: 'set_loadout',
    characterId: 'kit',
    paintId: 'graphite-gold',
    avatarId: 'tiger',
  });
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
    { v: PROTOCOL_VERSION, type: 'quick_match' },
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
  socket.receive({
    v: PROTOCOL_VERSION, type: 'prepare_race', raceId: 'race_identifier_123', wireRaceId: 123,
  });

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

test('kickPlayer sends the target id and kicked clears the resumable Room session', () => {
  FakeWebSocket.instances.length = 0;
  const client = makeClient();
  const kicked = [];
  client.on('kicked', (message) => kicked.push(message));
  client.enterLobby();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  boundWelcome(socket, { participantId: 'participant_host' });

  assert.equal(client.kickPlayer('participant_002'), true);
  assert.deepEqual(socket.sent.at(-1), {
    v: PROTOCOL_VERSION,
    type: 'kick_player',
    participantId: 'participant_002',
  });

  socket.receive({
    v: PROTOCOL_VERSION,
    type: 'kicked',
    roomCode: 'ROOM22',
    reason: 'ready_timeout',
    timeoutSeconds: 30,
    message: 'You were removed from the room by the host.',
  });
  assert.equal(client.scope, 'lobby');
  assert.equal(client.room, null);
  assert.equal(client.selfId, null);
  assert.equal(client.resumeToken, null);
  assert.equal(kicked.length, 1);
  assert.equal(kicked[0].reason, 'ready_timeout');
  assert.equal(kicked[0].timeoutSeconds, 30);
});

test('race input waits for load ACK and is suppressed while the WebSocket buffer is congested', () => {
  FakeWebSocket.instances.length = 0;
  const client = makeClient();
  client.enterLobby();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  boundWelcome(socket);
  socket.receive({
    v: PROTOCOL_VERSION, type: 'prepare_race', raceId: 'race_identifier_123', wireRaceId: 123,
  });
  const before = socket.sent.length;

  assert.equal(client.sendInput({
    seq: 1, useItemSeq: 0, throttle: 0.5, brake: 0, steer: 0.25,
    drift: false, lookBack: false,
  }), false);
  assert.equal(socket.sent.length, before);

  socket.receive({
    v: PROTOCOL_VERSION,
    type: 'race_loaded_ack',
    raceId: 'race_identifier_123',
    phase: 'countdown',
    late: false,
  });
  assert.equal(client.hasRaceLoadedAck('race_identifier_123'), true);

  socket.bufferedAmount = MAX_RACE_INPUT_BUFFERED_BYTES + 1;
  assert.equal(client.sendInput({ seq: 1, useItemSeq: 0, throttle: 1, brake: 0, steer: 0, drift: false, lookBack: false }), false);
  assert.equal(socket.sent.length, before);

  socket.bufferedAmount = 0;
  assert.equal(client.sendInput({ seq: 1, useItemSeq: 0, throttle: 0.5, brake: 0, steer: 0.25, drift: false, lookBack: false }), true);
  const sentInput = decodeInputPacket(socket.sent.at(-1));
  assert.equal(sentInput.type, 'input');
  assert.equal(sentInput.wireRaceId, 123);
  assert.equal(sentInput.seq, 1);
  assert.ok(Math.abs(sentInput.throttle - 0.5) <= 1 / 65535);
});

test('load ACK is cached before scene listeners attach and reset for the next race', () => {
  FakeWebSocket.instances.length = 0;
  const client = makeClient();
  const acks = [];
  client.enterLobby();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  boundWelcome(socket);
  socket.receive({
    v: PROTOCOL_VERSION, type: 'prepare_race', raceId: 'race_identifier_123', wireRaceId: 123,
  });
  socket.receive({
    v: PROTOCOL_VERSION,
    type: 'race_loaded_ack',
    raceId: 'race_identifier_123',
    phase: 'racing',
    late: true,
  });
  client.on('race_loaded_ack', (message) => acks.push(message));

  assert.deepEqual(client.getRaceLoadedAck('race_identifier_123'), {
    v: PROTOCOL_VERSION,
    type: 'race_loaded_ack',
    raceId: 'race_identifier_123',
    phase: 'racing',
    late: true,
  });
  assert.deepEqual(acks, []);

  socket.receive({
    v: PROTOCOL_VERSION, type: 'prepare_race', raceId: 'race_identifier_456', wireRaceId: 456,
  });
  assert.equal(client.hasRaceLoadedAck('race_identifier_123'), false);
  socket.receive({
    v: PROTOCOL_VERSION,
    type: 'room_state',
    roomCode: 'ROOM22',
    state: 'waiting',
    members: [],
  });
  assert.equal(client.hasRaceLoadedAck('race_identifier_456'), false);
});

test('binary snapshots use the announced wire race id and wrong-race packets are ignored', () => {
  FakeWebSocket.instances.length = 0;
  const client = makeClient();
  const snapshots = [];
  client.on('snapshot', message => snapshots.push(message));
  client.enterLobby();
  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.binaryType, 'arraybuffer');
  socket.open();
  boundWelcome(socket);
  socket.receive({
    v: PROTOCOL_VERSION, type: 'prepare_race', raceId: 'race_identifier_123', wireRaceId: 123,
  });

  const packet = (wireRaceId, tick) => encodeSnapshotPacket({
    wireRaceId,
    tick,
    serverTime: 1_000,
    countdown: 3,
    laps: 3,
    state: 'countdown',
    elapsed: 0,
    karts: [],
    projectiles: [],
    hazards: [],
    itemBoxes: [],
    acks: [],
  });
  socket.receiveBinary(packet(456, 1));
  assert.equal(snapshots.length, 0);
  socket.receiveBinary(packet(123, 2));
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].raceId, 'race_identifier_123');
  assert.equal(snapshots[0].wireRaceId, 123);
  assert.equal(snapshots[0].tick, 2);
});

test('close 4006 and corrupt snapshots stop automatic reconnect and request a refresh', () => {
  for (const mode of ['close', 'corrupt']) {
    FakeWebSocket.instances.length = 0;
    const client = makeClient();
    const errors = [];
    client.on('error', error => errors.push(error));
    client.enterLobby();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    if (mode === 'close') socket.close(4006, 'Client update required');
    else socket.receiveBinary(new Uint8Array([1, 2, 3]));

    assert.equal(client.state, 'disconnected');
    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, mode === 'close' ? 'client_update_required' : 'protocol_error');
    assert.match(errors[0].message, /refresh/i);
  }
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

test('Lobby reconnect retries report one connection failure per outage', () => {
  FakeWebSocket.instances.length = 0;
  const timers = [];
  const errors = [];
  const client = makeClient({
    setTimeoutImpl(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutImpl() {},
  });
  client.on('error', (error) => errors.push(error));
  client.enterLobby();

  const initial = FakeWebSocket.instances[0];
  initial.open();
  initial.receive({ v: PROTOCOL_VERSION, type: 'lobby_state', rooms: [] });
  initial.emit('error');
  initial.close(1006, 'network');

  timers[0].fn();
  const firstRetry = FakeWebSocket.instances[1];
  firstRetry.emit('error');
  firstRetry.close(1006, 'network');

  assert.deepEqual(errors, [{
    code: 'socket_error',
    message: 'Network connection failed.',
  }]);

  timers[1].fn();
  const recovered = FakeWebSocket.instances[2];
  recovered.open();
  recovered.receive({ v: PROTOCOL_VERSION, type: 'lobby_state', rooms: [] });
  recovered.emit('error');

  assert.equal(errors.length, 2);
});

test('Room resume retries share the same connection-failure alert guard', () => {
  FakeWebSocket.instances.length = 0;
  const timers = [];
  const errors = [];
  const client = makeClient({
    setTimeoutImpl(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutImpl() {},
    now: () => 1_000,
  });
  client.on('error', (error) => errors.push(error));
  seedInMemoryRoomSession(client);
  client.resumeRoomSession();

  const initial = FakeWebSocket.instances[0];
  initial.emit('error');
  initial.close(1006, 'network');
  timers[0].fn();

  const retry = FakeWebSocket.instances[1];
  retry.emit('error');

  assert.deepEqual(errors, [{
    code: 'socket_error',
    message: 'Network connection failed.',
  }]);

  retry.open();
  boundWelcome(retry);
  retry.emit('error');
  assert.equal(errors.length, 2);
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

test('the local Room reconnect watchdog expires even while a retry socket stays connecting', () => {
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
  assert.equal(timers[0].ms, 250);
  assert.equal(timers[1].ms, 30_000);

  timers[0].fn();
  now = 31_001;
  timers[1].fn();

  assert.equal(storage.getItem(ONLINE_SESSION_STORAGE_KEY), null);
  assert.equal(client.room, null);
  assert.equal(client.scope, 'lobby');
  assert.deepEqual(expired, [{ roomCode: 'ROOM22', code: 'session_expired' }]);
  assert.equal(FakeWebSocket.instances[1].readyState, 3);
  assert.equal(timers.length, 3);
});

test('a successful Room resume makes a queued local expiry callback harmless', () => {
  FakeWebSocket.instances.length = 0;
  const timers = [];
  const expired = [];
  let now = 1_000;
  const client = makeClient({
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
  boundWelcome(FakeWebSocket.instances[1]);

  now = 31_001;
  timers[1].fn();
  assert.deepEqual(expired, []);
  assert.equal(client.scope, 'room');
  assert.equal(client.room.code, 'ROOM22');
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

  assert.deepEqual(cleared, [1, 2]);
  assert.equal(client._reconnectTimer, null);
  assert.equal(client._reconnectExpiryTimer, null);
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

test('reconnect delay applies injectable plus or minus twenty percent jitter', () => {
  const fastest = makeClient({ random: () => 0 });
  const slowest = makeClient({ random: () => 1 });
  assert.equal(fastest._nextReconnectDelay(), 200);
  assert.equal(slowest._nextReconnectDelay(), 300);
});

test('a connecting WebSocket is closed after the ten second handshake timeout', () => {
  FakeWebSocket.instances.length = 0;
  const timers = [];
  const errors = [];
  const client = makeClient({
    connectTimeoutMs: 10_000,
    setTimeoutImpl(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutImpl() {},
  });
  client.on('error', error => errors.push(error));
  client.enterLobby();

  assert.equal(timers[0].ms, 10_000);
  timers[0].fn();
  assert.equal(FakeWebSocket.instances[0].readyState, 3);
  assert.deepEqual(errors, [{
    code: 'connection_timeout', message: 'Network connection timed out.',
  }]);
});

test('hidden Lobby retries every twenty seconds and becoming visible retries immediately', () => {
  FakeWebSocket.instances.length = 0;
  const timers = [];
  const listeners = new Map();
  const document = {
    hidden: true,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener() {},
  };
  const client = makeClient({
    document,
    setTimeoutImpl(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutImpl() {},
  });
  client.enterLobby();
  FakeWebSocket.instances[0].open();
  FakeWebSocket.instances[0].close(1006, 'network');
  assert.equal(timers[0].ms, 20_000);

  document.hidden = false;
  listeners.get('visibilitychange')();
  assert.equal(FakeWebSocket.instances.length, 2);
  FakeWebSocket.instances[1].open();
  assert.deepEqual(FakeWebSocket.instances[1].sent[0], {
    v: PROTOCOL_VERSION, type: 'enter_lobby',
  });
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
