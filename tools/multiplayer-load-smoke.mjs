// Self-contained multiplayer load smoke. It starts an ephemeral local server,
// mutates only in-memory test state, prints aggregate metrics, and exits.
import { WebSocket } from 'ws';

import { createGameServer } from '../server.mjs';
import { outgoingMessageAction } from '../server/websocket-game-server.js';
import { PROTOCOL_VERSION, encodeKartSnapshot } from '../src/net/protocol.js';

const LOBBY_CLIENTS = Math.max(3, Number(process.env.SMOKE_LOBBY_CLIENTS) || 8);
const RECONNECT_CLIENTS = Math.max(1, Number(process.env.SMOKE_RECONNECT_CLIENTS) || 6);

class SmokeSimulation {
  constructor({ roster, laps }) {
    this.state = 'racing';
    this.elapsed = 0;
    this.laps = laps;
    this.karts = roster.map((entry) => ({
      index: entry.kartIndex,
      x: entry.kartIndex * 2,
      y: 0,
      z: 0,
      yaw: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      speed: 0,
      lap: 1,
      rank: entry.kartIndex + 1,
      state: 'normal',
      controllerKind: entry.controllerKind,
    }));
    this.items = { projectiles: [], hazards: [] };
    this.track = { itemBoxes: [] };
  }

  update(dt, controls) {
    this.elapsed += dt;
    for (let index = 0; index < this.karts.length; index++) {
      if (controls[index]) this.karts[index].speed = controls[index].throttle * 20;
    }
  }

  getSnapshot() {
    return {
      state: this.state,
      countdown: 0,
      elapsed: this.elapsed,
      laps: this.laps,
      karts: this.karts.map((kart) => encodeKartSnapshot(kart, kart.controllerKind)),
      projectiles: [],
      hazards: [],
      itemBoxes: [],
    };
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connect(url, origin) {
  const socket = new WebSocket(url, { headers: { Origin: origin } });
  const messages = [];
  const waiters = [];
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString('utf8'));
    messages.push(message);
    for (let index = waiters.length - 1; index >= 0; index--) {
      if (!waiters[index].predicate(message)) continue;
      const waiter = waiters.splice(index, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  function next(predicate, timeoutMs = 3_000) {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error('Smoke client timed out waiting for a server message.'));
      }, timeoutMs);
      waiters.push(waiter);
    });
  }
  return {
    socket,
    messages,
    send(message) { socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...message })); },
    next,
    async close() {
      if (socket.readyState >= 2) return;
      await new Promise((resolve) => {
        socket.once('close', resolve);
        socket.close(1000, 'smoke complete');
      });
    },
  };
}

const logger = { info() {}, warn() {}, error() {} };
const server = await createGameServer({
  logger,
  metricsLogIntervalMs: 0,
  maintenanceIntervalMs: 20,
  roomManagerOptions: { raceFactory: async (args) => new SmokeSimulation(args) },
  webSocketOptions: { lobbyBroadcastDebounceMs: 20, serverStatsDebounceMs: 10 },
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;
const url = `ws://127.0.0.1:${port}/ws`;
const clients = [];

try {
  // Lobby amplification and active-room snapshot traffic.
  for (let index = 0; index < LOBBY_CLIENTS; index++) {
    const client = await connect(url, origin);
    clients.push(client);
    client.send({ type: 'enter_lobby' });
    await client.next(message => message.type === 'lobby_state');
  }
  const host = clients[0];
  const guest = clients[1];
  host.send({
    type: 'create_room', displayName: 'Smoke Host', roomName: 'Load Smoke',
    roomType: 'public', maxPlayers: 2,
  });
  const hostWelcome = await host.next(message => message.type === 'welcome' && message.session);
  await clients[2].next(message => message.type === 'lobby_state'
    && message.rooms.some(room => room.roomCode === hostWelcome.roomCode));
  guest.send({ type: 'join_room', roomCode: hostWelcome.roomCode, displayName: 'Smoke Guest' });
  const guestWelcome = await guest.next(message => message.type === 'welcome' && message.session);
  host.send({ type: 'set_ready', ready: true });
  guest.send({ type: 'set_ready', ready: true });
  await host.next(message => message.type === 'room_state' && message.canStart === true);
  host.send({ type: 'start_race' });
  const prepare = await host.next(message => message.type === 'prepare_race');
  await guest.next(message => message.type === 'prepare_race' && message.raceId === prepare.raceId);
  host.send({ type: 'race_loaded', raceId: prepare.raceId });
  guest.send({ type: 'race_loaded', raceId: prepare.raceId });
  await host.next(message => message.type === 'snapshot');

  // Private authentication: one failed and one successful verification.
  const privateHost = await connect(url, origin);
  const privateGuest = await connect(url, origin);
  clients.push(privateHost, privateGuest);
  privateHost.send({ type: 'enter_lobby' });
  privateGuest.send({ type: 'enter_lobby' });
  await Promise.all([
    privateHost.next(message => message.type === 'lobby_state'),
    privateGuest.next(message => message.type === 'lobby_state'),
  ]);
  privateHost.send({
    type: 'create_room', displayName: 'Private Host', roomName: 'Private Smoke',
    roomType: 'private', maxPlayers: 2, password: 'PitLane9',
  });
  const privateWelcome = await privateHost.next(message => message.type === 'welcome' && message.session);
  privateGuest.send({
    type: 'join_room', roomCode: privateWelcome.roomCode,
    displayName: 'Private Guest', password: 'wrong-pass',
  });
  await privateGuest.next(message => message.type === 'error' && message.code === 'password_invalid');
  privateGuest.send({
    type: 'join_room', roomCode: privateWelcome.roomCode,
    displayName: 'Private Guest', password: 'PitLane9',
  });
  await privateGuest.next(message => message.type === 'welcome' && message.session);

  // Reconnect storm stays anonymous and exercises connection/stat coalescing.
  const storm = [];
  for (let index = 0; index < RECONNECT_CLIENTS; index++) {
    const client = await connect(url, origin);
    storm.push(client);
    client.send({ type: 'enter_lobby' });
  }
  for (const client of storm) client.socket.terminate();
  await delay(100);

  const metrics = server.runtimeMetrics.snapshot();
  const checks = {
    lobbyAmplificationMeasured: metrics.lobby.broadcasts > 0
      && metrics.lobby.recipients >= LOBBY_CLIENTS - 2,
    activeRoomSnapshotsMeasured: metrics.snapshot.built > 0 && metrics.snapshot.sent > 0,
    reconnectTrafficMeasured: metrics.traffic.inbound.byType.enter_lobby?.count >= LOBBY_CLIENTS,
    privateAuthenticationMeasured: metrics.auth.scryptCompleted >= 3,
    slowSnapshotWouldSkip: outgoingMessageAction({
      bufferedAmount: 32 * 1024, messageType: 'snapshot', serializedBytes: 8 * 1024,
    }) === 'skip',
    slowConnectionWouldClose: outgoingMessageAction({
      bufferedAmount: 600 * 1024, messageType: 'room_state', serializedBytes: 1024,
    }) === 'close',
  };
  if (Object.values(checks).some(value => !value)) {
    throw new Error(`Multiplayer load smoke failed: ${JSON.stringify(checks)}`);
  }
  console.log(JSON.stringify({
    scenario: {
      lobbyClients: LOBBY_CLIENTS,
      reconnectClients: RECONNECT_CLIENTS,
      rooms: 2,
      activeRaces: 1,
    },
    checks,
    metrics,
    participants: { host: Boolean(hostWelcome), guest: Boolean(guestWelcome) },
  }));
} finally {
  await Promise.allSettled(clients.map(client => client.close()));
  await server.shutdown();
}
