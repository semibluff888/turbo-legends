import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';

import { createGameServer } from '../server.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const wsModule = await import('ws').catch(() => null);

function readJson(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function connectClient(WebSocket, url, origin) {
  const socket = new WebSocket(url, { headers: { Origin: origin } });
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
    send(message) { socket.send(JSON.stringify({ v: 1, ...message })); },
    close() {
      if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
      return new Promise(resolve => {
        socket.once('close', resolve);
        socket.close(1000, 'test complete');
      });
    },
  };
}

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

test('game server creates and joins a room over /ws and reports aggregate health', {
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
    host = await connectClient(WebSocket, url, origin);
    assert.equal((await host.next(message => message.type === 'welcome')).session, null);
    host.send({ type: 'create_room', nickname: 'Host', characterId: 'pip' });
    const hostWelcome = await host.next(message => message.type === 'welcome' && message.session);
    const hostRoom = await host.next(message => message.type === 'room_state' && message.members.length === 1);
    assert.equal(hostRoom.self.participantId, hostWelcome.participantId);
    assert.equal(hostRoom.self.isHost, true);

    guest = await connectClient(WebSocket, url, origin);
    guest.send({
      type: 'join_room',
      code: hostWelcome.roomCode,
      nickname: 'Guest',
      characterId: 'nova',
    });
    const guestWelcome = await guest.next(message => message.type === 'welcome' && message.session);
    const guestRoom = await guest.next(message => message.type === 'room_state' && message.members.length === 2);
    const updatedHostRoom = await host.next(message => message.type === 'room_state' && message.members.length === 2);
    assert.equal(guestWelcome.roomCode, hostWelcome.roomCode);
    assert.equal(guestRoom.self.isHost, false);
    assert.equal(updatedHostRoom.self.isHost, true);

    const guestClosed = new Promise(resolve => guest.socket.once('close', resolve));
    guest.socket.terminate();
    await guestClosed;
    const disconnectedRoom = await host.next(message => (
      message.type === 'room_state'
      && message.members.some(member => member.participantId === guestWelcome.participantId && !member.connected)
    ));
    assert.equal(disconnectedRoom.members.length, 2);

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

test('two WebSocket clients can ready, start, receive snapshots/results, and return to lobby', {
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
    host.send({ type: 'create_room', nickname: 'Host', characterId: 'pip' });
    const hostWelcome = await host.next(message => message.type === 'welcome' && message.session);

    guest = await connectClient(WebSocket, url, origin);
    guest.send({
      type: 'join_room',
      code: hostWelcome.roomCode,
      nickname: 'Guest',
      characterId: 'nova',
    });
    const guestWelcome = await guest.next(message => message.type === 'welcome' && message.session);

    host.send({ type: 'select_character', characterId: 'kit' });
    await host.next(message => (
      message.type === 'room_state'
      && message.members.some(member => member.participantId === hostWelcome.participantId
        && member.characterId === 'kit')
    ));
    guest.send({ type: 'select_character', characterId: 'gearbox' });
    await guest.next(message => (
      message.type === 'room_state'
      && message.members.some(member => member.participantId === guestWelcome.participantId
        && member.characterId === 'gearbox')
    ));

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
    assert.deepEqual(
      hostPrepare.roster.filter(entry => entry.controllerKind === 'human').map(entry => entry.characterId).sort(),
      ['gearbox', 'kit'],
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

    const hostMark = host.mark();
    const guestMark = guest.mark();
    host.send({ type: 'return_lobby' });
    const hostLobby = await host.next(message => (
      message.type === 'room_state' && message.state === 'lobby' && message.raceId === null
    ), hostMark);
    const guestLobby = await guest.next(message => (
      message.type === 'room_state' && message.state === 'lobby' && message.raceId === null
    ), guestMark);
    assert.equal(hostLobby.members.every(member => member.ready === false), true);
    assert.equal(guestLobby.members.length, 2);
  } finally {
    await guest?.close();
    await host?.close();
    await server.shutdown();
  }
});
