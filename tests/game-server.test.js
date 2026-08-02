import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';

import { createGameServer } from '../server.mjs';
import { ROOM_PRESENCE_HEARTBEAT_INTERVAL_MS } from '../server/websocket-game-server.js';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const wsModule = await import('ws').catch(() => null);

function readJson(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function connectClient(WebSocket, url, origin, options = {}) {
  const socket = new WebSocket(url, { ...options, headers: { Origin: origin } });
  const messages = [];
  const waiters = [];
  socket.on('message', data => {
    const message = JSON.parse(data.toString('utf8'));
    messages.push(message);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (!waiters[i].predicate(message)) continue;
      const [waiter] = waiters.splice(i, 1);
      waiter.resolve(message);
    }
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return {
    socket,
    next(predicate, after = 0) {
      const existing = messages.slice(after).find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for WebSocket message')), 2000);
        waiters.push({
          predicate,
          resolve(message) { clearTimeout(timer); resolve(message); },
        });
      });
    },
    mark() { return messages.length; },
    messagesAfter(mark = 0) { return messages.slice(mark); },
    send(message) { socket.send(JSON.stringify({ v: 2, ...message })); },
    close() {
      if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
      return new Promise(resolve => {
        socket.once('close', resolve);
        socket.close(1000, 'test complete');
      });
    },
  };
}

test('Room presence heartbeat is shorter than the reconnect window', () => {
  assert.equal(ROOM_PRESENCE_HEARTBEAT_INTERVAL_MS, 3_000);
});

test('a silent Room connection is broadcast as reconnecting before it resumes', {
  skip: wsModule ? false : 'ws dependency is not installed in this workspace',
}, async () => {
  const { WebSocket } = wsModule;
  const logger = { info() {}, warn() {}, error() {} };
  const server = await createGameServer({
    root: PROJECT_ROOT,
    logger,
    webSocketOptions: { heartbeatIntervalMs: 20 },
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const url = `ws://127.0.0.1:${port}/ws`;
  let host;
  let guest;
  let resumedGuest;
  try {
    host = await connectClient(WebSocket, url, origin);
    host.send({
      type: 'create_room',
      displayName: 'Host',
      roomName: 'Presence Test',
      roomType: 'public',
      maxPlayers: 4,
      trackId: 'harbor-loop',
      characterId: 'pip',
    });
    const hostWelcome = await host.next(message => message.type === 'welcome' && message.session);
    await host.next(message => message.type === 'room_state' && message.members.length === 1);

    guest = await connectClient(WebSocket, url, origin, { autoPong: false });
    guest.send({
      type: 'join_room',
      roomCode: hostWelcome.roomCode,
      displayName: 'Guest',
      characterId: 'nova',
    });
    const guestWelcome = await guest.next(message => message.type === 'welcome' && message.session);
    await host.next(message => message.type === 'room_state' && message.members.length === 2);

    const disconnectMark = host.mark();
    const disconnectedRoom = await host.next(message => (
      message.type === 'room_state'
      && message.members.some(member => (
        member.participantId === guestWelcome.participantId && !member.connected
      ))
    ), disconnectMark);
    assert.equal(disconnectedRoom.members.length, 2);
    assert.equal(
      disconnectedRoom.members.find(member => member.participantId === guestWelcome.participantId)
        .presenceState,
      'reconnecting',
    );

    const resumeMark = host.mark();
    resumedGuest = await connectClient(WebSocket, url, origin);
    resumedGuest.send({
      type: 'resume',
      roomCode: hostWelcome.roomCode,
      participantId: guestWelcome.participantId,
      resumeToken: guestWelcome.resumeToken,
    });
    await resumedGuest.next(message => message.type === 'welcome' && message.session?.resumed);
    const reconnectedRoom = await host.next(message => (
      message.type === 'room_state'
      && message.members.some(member => (
        member.participantId === guestWelcome.participantId && member.connected
      ))
    ), resumeMark);
    assert.equal(reconnectedRoom.members.length, 2);
    assert.equal(
      reconnectedRoom.members.find(member => member.participantId === guestWelcome.participantId)
        .presenceState,
      'connected',
    );
  } finally {
    await resumedGuest?.close();
    await guest?.close();
    await host?.close();
    await server.shutdown();
  }
});

class QuickRaceSimulation {
  constructor({ roster, laps }) {
    this.roster = roster;
    this.laps = laps;
    this.state = 'countdown';
    this.countdown = 0.02;
    this.elapsed = 0;
    this.updateCount = 0;
    this.controllers = roster.map(entry => entry.controllerKind);
    this.karts = roster.map((entry, index) => ({
      index,
      id: `kart${index}`,
      name: entry.displayName,
      character: { id: entry.characterId },
      controls: { throttle: 0, brake: 0, steer: 0, drift: false, lookBack: false },
      x: index,
      y: 0,
      z: 0,
      yaw: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      speed: 0,
      lap: 1,
      rank: index + 1,
      finished: false,
      finishTime: 0,
      bestLap: Infinity,
      lapTimes: [],
      events: [],
      clearEvents() { this.events.length = 0; },
    }));
    this.standings = this.karts.slice();
    this.track = { itemBoxes: [] };
    this.items = { projectiles: [], hazards: [], drainVfx: () => [] };
  }

  setController(index, kind) {
    this.controllers[index] = kind;
  }

  update(dt) {
    this.updateCount++;
    this.elapsed += dt;
    this.countdown = Math.max(0, this.countdown - dt);
    if (this.updateCount >= 2) this.state = 'racing';
    if (this.updateCount < 8) return;
    this.state = 'results';
    for (let index = 0; index < this.karts.length; index++) {
      const kart = this.karts[index];
      kart.finished = true;
      kart.rank = index + 1;
      kart.finishTime = 10 + index;
      kart.bestLap = 3 + index / 10;
      kart.lapTimes = [kart.bestLap];
    }
  }
}

test('game server subscribes to Lobby, creates and joins a room, and reports aggregate health', {
  skip: wsModule ? false : 'ws dependency is not installed in this workspace',
}, async () => {
  const { WebSocket } = wsModule;
  const logger = { info() {}, warn() {}, error() {} };
  const server = await createGameServer({ root: PROJECT_ROOT, logger });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const url = `ws://127.0.0.1:${port}/ws`;
  let host;
  let guest;
  let resumedGuest;
  try {
    const packageMetadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const metadata = await readJson(port, '/api/meta');
    assert.equal(metadata.statusCode, 200);
    assert.equal(metadata.headers['cache-control'], 'no-store');
    assert.deepEqual(metadata.body, { version: packageMetadata.version });

    host = await connectClient(WebSocket, url, origin);
    assert.equal((await host.next(message => message.type === 'welcome')).session, null);
    host.send({ type: 'enter_lobby' });
    assert.deepEqual((await host.next(message => message.type === 'lobby_state')).rooms, []);
    host.send({
      type: 'create_room',
      displayName: 'Host',
      roomName: 'Host Raceway',
      roomType: 'public',
      maxPlayers: 4,
      trackId: 'harbor-loop',
      characterId: 'pip',
    });
    const hostWelcome = await host.next(message => message.type === 'welcome' && message.session);
    const hostRoom = await host.next(message => message.type === 'room_state' && message.members.length === 1);
    assert.equal(hostRoom.self.participantId, hostWelcome.participantId);
    assert.equal(hostRoom.self.isHost, true);
    assert.equal(hostRoom.state, 'waiting');
    assert.equal(hostRoom.roomName, 'Host Raceway');
    assert.equal(hostRoom.roomType, 'public');
    assert.equal(hostRoom.maxPlayers, 4);
    assert.equal(hostRoom.settings.trackId, 'harbor-loop');

    const twoClientMark = host.mark();
    guest = await connectClient(WebSocket, url, origin);
    const twoClientStats = await host.next(
      message => message.type === 'server_stats' && message.onlineCount === 2,
      twoClientMark,
    );
    assert.equal(twoClientStats.onlineCount, 2);
    guest.send({ type: 'enter_lobby' });
    const guestLobby = await guest.next(message => message.type === 'lobby_state');
    assert.deepEqual(guestLobby.rooms[0], {
      roomCode: hostWelcome.roomCode,
      roomName: 'Host Raceway',
      roomType: 'public',
      requiresPassword: false,
      playerCount: 1,
      maxPlayers: 4,
      hostDisplayName: 'Host',
      trackId: 'harbor-loop',
      status: 'waiting',
      joinable: true,
    });
    guest.send({
      type: 'join_room',
      roomCode: hostWelcome.roomCode,
      displayName: 'Guest',
      characterId: 'nova',
    });
    const guestWelcome = await guest.next(message => message.type === 'welcome' && message.session);
    const guestRoom = await guest.next(message => message.type === 'room_state' && message.members.length === 2);
    const updatedHostRoom = await host.next(message => message.type === 'room_state' && message.members.length === 2);
    assert.equal(guestWelcome.roomCode, hostWelcome.roomCode);
    assert.equal(guestRoom.self.isHost, false);
    assert.equal(updatedHostRoom.self.isHost, true);

    const oneClientMark = host.mark();
    const guestClosed = new Promise(resolve => guest.socket.once('close', resolve));
    guest.socket.terminate();
    await guestClosed;
    const disconnectedRoom = await host.next(message => (
      message.type === 'room_state'
      && message.members.some(member => member.participantId === guestWelcome.participantId && !member.connected)
    ));
    assert.equal(disconnectedRoom.members.length, 2);
    const oneClientStats = await host.next(
      message => message.type === 'server_stats' && message.onlineCount === 1,
      oneClientMark,
    );
    assert.equal(oneClientStats.onlineCount, 1);

    const resumeMark = host.mark();
    resumedGuest = await connectClient(WebSocket, url, origin);
    resumedGuest.send({
      type: 'resume',
      code: guestWelcome.roomCode,
      participantId: guestWelcome.participantId,
      resumeToken: guestWelcome.resumeToken,
    });
    const resumedWelcome = await resumedGuest.next(message => message.type === 'welcome' && message.session);
    const resumedRoom = await resumedGuest.next(message => message.type === 'room_state' && message.self);
    assert.equal(resumedWelcome.resumed, true);
    assert.equal(resumedRoom.self.participantId, guestWelcome.participantId);
    assert.equal(resumedRoom.self.connected, true);
    const reconnectedRoom = await host.next(message => (
      message.type === 'room_state'
      && message.members.some(member => (
        member.participantId === guestWelcome.participantId && member.connected
      ))
    ), resumeMark);
    assert.equal(reconnectedRoom.members.length, 2);

    const leaveMark = resumedGuest.mark();
    resumedGuest.send({ type: 'leave_room' });
    const lobbyAfterLeave = await resumedGuest.next(
      message => message.type === 'lobby_state', leaveMark,
    );
    assert.equal(lobbyAfterLeave.rooms[0].playerCount, 1);
    assert.equal(resumedGuest.messagesAfter(leaveMark)[0].type, 'lobby_state');
    assert.equal(
      resumedGuest.messagesAfter(leaveMark).some(message => message.type === 'room_state'),
      false,
    );

    const health = await readJson(port, '/healthz');
    assert.equal(health.statusCode, 200);
    assert.equal(health.body.rooms, 1);
    assert.equal(health.body.connections, 2);
    assert.equal(Object.hasOwn(health.body, 'roomCode'), false);
  } finally {
    await resumedGuest?.close();
    await guest?.close();
    await host?.close();
    await server.shutdown();
  }
});

test('a host can kick a guest back to the Lobby with an explicit notification', {
  skip: wsModule ? false : 'ws dependency is not installed in this workspace',
}, async () => {
  const { WebSocket } = wsModule;
  const logger = { info() {}, warn() {}, error() {} };
  const server = await createGameServer({ root: PROJECT_ROOT, logger });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const url = `ws://127.0.0.1:${port}/ws`;
  let host;
  let guest;
  try {
    host = await connectClient(WebSocket, url, origin);
    host.send({
      type: 'create_room', displayName: 'Host', characterId: 'pip',
      roomName: 'Kick Test', roomType: 'public', maxPlayers: 4,
    });
    const hostWelcome = await host.next(message => message.type === 'welcome' && message.session);
    await host.next(message => message.type === 'room_state' && message.members.length === 1);

    guest = await connectClient(WebSocket, url, origin);
    guest.send({
      type: 'join_room', roomCode: hostWelcome.roomCode,
      displayName: 'Guest', characterId: 'nova',
    });
    const guestWelcome = await guest.next(message => message.type === 'welcome' && message.session);
    await guest.next(message => message.type === 'room_state' && message.members.length === 2);
    await host.next(message => message.type === 'room_state' && message.members.length === 2);

    const hostMark = host.mark();
    const guestMark = guest.mark();
    host.send({ type: 'kick_player', participantId: guestWelcome.participantId });

    const kicked = await guest.next(message => message.type === 'kicked', guestMark);
    const lobby = await guest.next(message => message.type === 'lobby_state', guestMark);
    const hostRoom = await host.next(message => (
      message.type === 'room_state' && message.members.length === 1
    ), hostMark);
    assert.equal(kicked.roomCode, hostWelcome.roomCode);
    assert.equal(kicked.message, 'You were removed from the room by the host.');
    assert.equal(guest.messagesAfter(guestMark)[0].type, 'kicked');
    assert.equal(lobby.rooms[0].playerCount, 1);
    assert.deepEqual(hostRoom.members.map(member => member.participantId), [hostWelcome.participantId]);
  } finally {
    await guest?.close();
    await host?.close();
    await server.shutdown();
  }
});

test('quick match stays subscribed after no-match and can join a later public room with a duplicate name', {
  skip: wsModule ? false : 'ws dependency is not installed in this workspace',
}, async () => {
  const { WebSocket } = wsModule;
  const logger = { info() {}, warn() {}, error() {} };
  const server = await createGameServer({ root: PROJECT_ROOT, logger });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const url = `ws://127.0.0.1:${port}/ws`;
  let browser;
  let host;
  try {
    browser = await connectClient(WebSocket, url, origin);
    browser.send({ type: 'enter_lobby' });
    await browser.next(message => message.type === 'lobby_state');
    browser.send({ type: 'quick_match', displayName: 'Same Name' });
    const noMatch = await browser.next(message => message.type === 'error');
    assert.equal(noMatch.code, 'no_matching_room');

    host = await connectClient(WebSocket, url, origin);
    host.send({
      type: 'create_room', displayName: 'Same Name', roomName: 'Open Sprint',
      roomType: 'public', maxPlayers: 2, characterId: 'pip',
    });
    const hostWelcome = await host.next(message => message.type === 'welcome' && message.session);
    const listed = await browser.next(message => (
      message.type === 'lobby_state'
      && message.rooms.some(room => room.roomCode === hostWelcome.roomCode)
    ));
    assert.equal(listed.rooms[0].joinable, true);

    browser.send({ type: 'quick_match', displayName: 'Same Name' });
    const matchedWelcome = await browser.next(message => message.type === 'welcome' && message.session);
    const matchedRoom = await browser.next(message => (
      message.type === 'room_state' && message.members.length === 2
    ));
    assert.equal(matchedWelcome.roomCode, hostWelcome.roomCode);
    assert.deepEqual(matchedRoom.members.map(member => member.displayName), ['Same Name', 'Same Name']);
    assert.equal(new Set(matchedRoom.members.map(member => member.participantId)).size, 2);
  } finally {
    await browser?.close();
    await host?.close();
    await server.shutdown();
  }
});

test('WebSocket message limiting allows its burst budget and closes sustained excess traffic', {
  skip: wsModule ? false : 'ws dependency is not installed in this workspace',
}, async () => {
  const { WebSocket } = wsModule;
  const logger = { info() {}, warn() {}, error() {} };
  const server = await createGameServer({
    root: PROJECT_ROOT,
    logger,
    webSocketOptions: { messageRatePerSecond: 0, messageBurst: 5 },
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const url = `ws://127.0.0.1:${port}/ws`;
  let client;
  try {
    client = await connectClient(WebSocket, url, origin);
    for (let index = 0; index < 5; index++) client.send({ type: 'ping', clientTime: index });
    const fifthPong = await client.next(message => message.type === 'pong' && message.clientTime === 4);
    assert.equal(fifthPong.clientTime, 4);

    const closed = new Promise(resolve => client.socket.once('close', (code, reason) => resolve({
      code,
      reason: reason.toString(),
    })));
    client.send({ type: 'ping', clientTime: 5 });
    const error = await client.next(message => message.type === 'error' && message.code === 'rate_limited');
    assert.equal(error.message, 'Message rate limit exceeded.');
    assert.deepEqual(await closed, { code: 1008, reason: 'Rate limit exceeded' });
  } finally {
    await client?.close();
    await server.shutdown();
  }
});

test('two WebSocket clients can share a Racer with distinct loadouts through results', {
  skip: wsModule ? false : 'ws dependency is not installed in this workspace',
}, async () => {
  const { WebSocket } = wsModule;
  const logger = { info() {}, warn() {}, error() {} };
  const server = await createGameServer({
    root: PROJECT_ROOT,
    logger,
    roomManagerOptions: {
      raceFactory: async args => new QuickRaceSimulation(args),
    },
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const url = `ws://127.0.0.1:${port}/ws`;
  let host;
  let guest;
  try {
    host = await connectClient(WebSocket, url, origin);
    host.send({
      type: 'create_room', displayName: 'Host', characterId: 'kit',
      paintId: 'turbo-blue', avatarId: 'cat',
      roomName: 'Race Night', roomType: 'public', maxPlayers: 8,
    });
    const hostWelcome = await host.next(message => message.type === 'welcome' && message.session);

    guest = await connectClient(WebSocket, url, origin);
    guest.send({
      type: 'join_room',
      roomCode: hostWelcome.roomCode,
      displayName: 'Guest',
      characterId: 'kit',
      paintId: 'sunset-pop',
      avatarId: 'fox',
    });
    const guestWelcome = await guest.next(message => message.type === 'welcome' && message.session);

    const hostLoadoutMark = host.mark();
    const guestLoadoutMark = guest.mark();
    host.send({
      type: 'set_loadout',
      characterId: 'kit',
      paintId: 'pearl-flash',
      avatarId: 'panda',
    });
    const hostLoadoutRoom = await host.next(message => (
      message.type === 'room_state'
      && message.members.some(member => member.participantId === hostWelcome.participantId
        && member.paintId === 'pearl-flash'
        && member.avatarId === 'panda')
    ), hostLoadoutMark);
    const guestLoadoutRoom = await guest.next(message => (
      message.type === 'room_state'
      && message.members.some(member => member.participantId === hostWelcome.participantId
        && member.paintId === 'pearl-flash'
        && member.avatarId === 'panda')
    ), guestLoadoutMark);
    assert.deepEqual(
      {
        characterId: hostLoadoutRoom.self.characterId,
        paintId: hostLoadoutRoom.self.paintId,
        avatarId: hostLoadoutRoom.self.avatarId,
      },
      { characterId: 'kit', paintId: 'pearl-flash', avatarId: 'panda' },
    );
    assert.equal(
      guestLoadoutRoom.members.find(member => member.participantId === guestWelcome.participantId)
        ?.paintId,
      'sunset-pop',
    );

    host.send({ type: 'set_ready', ready: true });
    await host.next(message => (
      message.type === 'room_state'
      && message.members.find(member => member.participantId === hostWelcome.participantId)?.ready
    ));
    guest.send({ type: 'set_ready', ready: true });
    await host.next(message => message.type === 'room_state' && message.canStart === true);

    host.send({ type: 'start_race' });
    const hostPrepare = await host.next(message => message.type === 'prepare_race');
    const guestPrepare = await guest.next(message => message.type === 'prepare_race');
    assert.equal(hostPrepare.raceId, guestPrepare.raceId);
    assert.equal(hostPrepare.roster.length, 8);
    const humanRoster = hostPrepare.roster.filter(entry => entry.controllerKind === 'human');
    assert.deepEqual(humanRoster.map(entry => entry.characterId), ['kit', 'kit']);
    assert.deepEqual(
      humanRoster.map(({ participantId, paintId, avatarId }) => ({
        participantId, paintId, avatarId,
      })).sort((a, b) => a.participantId.localeCompare(b.participantId)),
      [
        { participantId: hostWelcome.participantId, paintId: 'pearl-flash', avatarId: 'panda' },
        { participantId: guestWelcome.participantId, paintId: 'sunset-pop', avatarId: 'fox' },
      ].sort((a, b) => a.participantId.localeCompare(b.participantId)),
    );

    host.send({ type: 'race_loaded', raceId: hostPrepare.raceId });
    guest.send({ type: 'race_loaded', raceId: guestPrepare.raceId });
    const hostSnapshot = await host.next(message => message.type === 'snapshot');
    const guestSnapshot = await guest.next(message => message.type === 'snapshot');
    assert.equal(hostSnapshot.raceId, hostPrepare.raceId);
    assert.equal(hostSnapshot.tick, guestSnapshot.tick);
    assert.equal(hostSnapshot.karts.length, 8);
    assert.equal(hostSnapshot.state, 'racing');

    const hostResults = await host.next(message => message.type === 'race_results');
    const guestResults = await guest.next(message => message.type === 'race_results');
    assert.equal(hostResults.raceId, hostPrepare.raceId);
    assert.deepEqual(hostResults.results, guestResults.results);
    assert.equal(hostResults.results.length, 8);
    assert.deepEqual(
      hostResults.results
        .filter(result => result.participantId === hostWelcome.participantId
          || result.participantId === guestWelcome.participantId)
        .map(({ participantId, characterId, paintId, avatarId }) => ({
          participantId, characterId, paintId, avatarId,
        }))
        .sort((a, b) => a.participantId.localeCompare(b.participantId)),
      [
        {
          participantId: hostWelcome.participantId,
          characterId: 'kit',
          paintId: 'pearl-flash',
          avatarId: 'panda',
        },
        {
          participantId: guestWelcome.participantId,
          characterId: 'kit',
          paintId: 'sunset-pop',
          avatarId: 'fox',
        },
      ].sort((a, b) => a.participantId.localeCompare(b.participantId)),
    );

    const hostMark = host.mark();
    const guestMark = guest.mark();
    host.send({ type: 'return_room' });
    const hostWaiting = await host.next(message => (
      message.type === 'room_state'
      && message.state === 'results'
      && message.members.find(member => member.participantId === hostWelcome.participantId)?.postRaceState === 'room'
    ), hostMark);
    const guestWaiting = await guest.next(message => (
      message.type === 'room_state'
      && message.state === 'results'
      && message.members.find(member => member.participantId === hostWelcome.participantId)?.postRaceState === 'room'
    ), guestMark);
    assert.equal(
      hostWaiting.members.find(member => member.participantId === guestWelcome.participantId)?.activityState,
      'in_game',
    );
    assert.equal(guestWaiting.state, 'results');

    const finalHostMark = host.mark();
    const finalGuestMark = guest.mark();
    guest.send({ type: 'return_room' });
    const hostLobby = await host.next(message => (
      message.type === 'room_state' && message.state === 'waiting' && message.raceId === null
    ), finalHostMark);
    const guestLobby = await guest.next(message => (
      message.type === 'room_state' && message.state === 'waiting' && message.raceId === null
    ), finalGuestMark);
    assert.equal(hostLobby.members.every(member => member.ready === false), true);
    assert.equal(guestLobby.members.length, 2);
  } finally {
    await guest?.close();
    await host?.close();
    await server.shutdown();
  }
});
