import test from 'node:test';
import assert from 'node:assert/strict';

import { ERROR_CODES, PROTOCOL_VERSION, ROOM_STATES, ROOM_TYPES } from '../src/net/protocol.js';
import { GameError } from '../server/game-error.js';
import { createDefaultRaceFactory } from '../server/race-factory.js';
import { RoomManager } from '../server/room-manager.js';

class FakeSimulation {
  constructor(args) {
    this.args = args;
    this.state = ROOM_STATES.COUNTDOWN;
    this.countdown = 3;
    this.elapsed = 0;
    this.laps = args.laps;
    this.controllers = args.roster.map((entry) => entry.controllerKind);
    this.updates = [];
    this.karts = args.roster.map((entry, index) => ({
      index,
      id: `kart${index}`,
      name: entry.displayName,
      character: { id: entry.characterId },
      x: index,
      y: 0,
      z: 0,
      yaw: 0,
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
    this.items = { projectiles: [], hazards: [], drainVfx: () => [] };
    this.track = { itemBoxes: [] };
  }

  setController(index, kind) {
    this.controllers[index] = kind;
  }

  update(dt, controls) {
    this.elapsed += dt;
    this.updates.push(controls.map((control) => control ? { ...control } : null));
  }
}

function createHarness(options = {}) {
  let now = 0;
  let participantSequence = 0;
  const simulations = [];
  const messages = [];
  const kicked = [];
  const managerErrors = [];
  const manager = new RoomManager({
    now: () => now,
    roomCodeFactory: () => 'ABC234',
    participantIdFactory: () => `participant_${String(++participantSequence).padStart(3, '0')}`,
    resumeTokenFactory: () => `resume_token_${String(participantSequence).padStart(24, '0')}`,
    raceIdFactory: () => 'race_identifier_123',
    seedFactory: () => 424242,
    raceFactory: async (args) => {
      const simulation = new FakeSimulation(args);
      simulations.push(simulation);
      return simulation;
    },
    ...options,
  });
  manager.on('message', (event) => messages.push(event));
  manager.on('participantKicked', (event) => kicked.push(event));
  manager.on('managerError', (error) => managerErrors.push(error));
  return {
    manager,
    simulations,
    messages,
    kicked,
    managerErrors,
    now: () => now,
    advance(ms) { now += ms; },
  };
}

function addTwoPlayers(harness) {
  const host = harness.manager.createRoom({
    displayName: 'Host',
    characterId: 'pip',
    roomName: 'Host Raceway',
    roomType: ROOM_TYPES.PUBLIC,
    maxPlayers: 8,
  });
  const guest = harness.manager.joinRoom(host.roomCode, {
    displayName: 'Guest', characterId: 'nova',
  });
  return { host, guest };
}

async function startTwoPlayerRace(harness) {
  const players = addTwoPlayers(harness);
  harness.manager.setReady(players.host.participantId, true);
  harness.manager.setReady(players.guest.participantId, true);
  const race = harness.manager.startRace(players.host.participantId);
  await harness.manager.markRaceLoaded(players.host.participantId, race.raceId);
  await harness.manager.markRaceLoaded(players.guest.participantId, race.raceId);
  return { ...players, race };
}

test('waiting room allows duplicate names and racers while loadout changes reset only that racer', () => {
  const harness = createHarness();
  const { host, guest } = addTwoPlayers(harness);
  const initialMembers = harness.manager.getRoomState(host.roomCode).members;
  assert.deepEqual(
    initialMembers.map(({ paintId, avatarId }) => ({ paintId, avatarId })),
    [
      { paintId: 'turbo-blue', avatarId: 'cat' },
      { paintId: 'turbo-blue', avatarId: 'cat' },
    ],
  );
  assert.throws(
    () => harness.manager.setLoadout(guest.participantId, {
      characterId: 'kit', paintId: 'missing-paint', avatarId: 'dog',
    }),
    (error) => error.code === ERROR_CODES.PAINT_INVALID,
  );
  assert.throws(
    () => harness.manager.setLoadout(guest.participantId, {
      characterId: 'kit', paintId: 'crimson-heat', avatarId: 'missing-avatar',
    }),
    (error) => error.code === ERROR_CODES.AVATAR_INVALID,
  );
  assert.deepEqual(
    harness.manager.getRoomState(host.roomCode).members[1],
    initialMembers[1],
  );

  const duplicateName = harness.manager.joinRoom(host.roomCode, {
    displayName: 'host', characterId: 'kit',
  });
  assert.notEqual(duplicateName.participantId, host.participantId);
  harness.manager.selectCharacter(guest.participantId, 'pip');
  assert.deepEqual(
    harness.manager.getRoomState(host.roomCode).members.map((member) => member.characterId),
    ['pip', 'pip', 'kit'],
  );
  assert.throws(
    () => harness.manager.setRoom(guest.participantId, { difficulty: 'hard' }),
    (error) => error.code === ERROR_CODES.FORBIDDEN,
  );

  harness.manager.setReady(host.participantId, true);
  harness.manager.setReady(guest.participantId, true);
  harness.manager.setReady(duplicateName.participantId, true);
  assert.equal(harness.manager.getRoomState(host.roomCode).canStart, true);
  harness.manager.setLoadout(guest.participantId, {
    characterId: 'pip', paintId: 'pearl-flash', avatarId: 'rabbit',
  });
  const changed = harness.manager.getRoomState(host.roomCode).members;
  assert.deepEqual(changed.map((member) => member.ready), [true, false, true]);
  assert.equal(changed[1].paintId, 'pearl-flash');
  assert.equal(changed[1].avatarId, 'rabbit');
  harness.manager.setReady(guest.participantId, true);
  assert.equal(harness.manager.getRoomState(host.roomCode).settings.autoFillAi, true);
  harness.manager.setRoom(host.participantId, { difficulty: 'hard', autoFillAi: false });
  assert.deepEqual(
    harness.manager.getRoomState(host.roomCode).members.map((member) => member.ready),
    [false, false, false],
  );
  assert.equal(harness.manager.getRoomState(host.roomCode).settings.autoFillAi, false);
});

test('duplicate human racers keep independent appearances in the announced roster', () => {
  const harness = createHarness();
  const host = harness.manager.createRoom({
    displayName: 'Host', characterId: 'kit', paintId: 'turbo-blue', avatarId: 'cat',
    roomName: 'Clone Cup', roomType: ROOM_TYPES.PUBLIC, maxPlayers: 2,
  });
  const guest = harness.manager.joinRoom(host.roomCode, {
    displayName: 'Guest', characterId: 'kit', paintId: 'crimson-heat', avatarId: 'dog',
  });
  harness.manager.setReady(host.participantId, true);
  harness.manager.setReady(guest.participantId, true);
  const race = harness.manager.startRace(host.participantId);
  const humans = race.roster.filter((entry) => entry.controllerKind === 'human');
  assert.equal(humans.length, 2);
  assert.deepEqual(humans.map((entry) => entry.characterId), ['kit', 'kit']);
  assert.deepEqual(new Set(humans.map((entry) => entry.paintId)), new Set(['turbo-blue', 'crimson-heat']));
  assert.deepEqual(new Set(humans.map((entry) => entry.avatarId)), new Set(['cat', 'dog']));
});

test('AI auto-fill uses room capacity and can be disabled by the host', () => {
  const filledHarness = createHarness();
  const filledHost = filledHarness.manager.createRoom({
    displayName: 'Host', characterId: 'pip', roomName: 'Four Kart Cup',
    roomType: ROOM_TYPES.PUBLIC, maxPlayers: 4,
  });
  const filledGuest = filledHarness.manager.joinRoom(filledHost.roomCode, {
    displayName: 'Guest', characterId: 'nova',
  });
  filledHarness.manager.setReady(filledHost.participantId, true);
  filledHarness.manager.setReady(filledGuest.participantId, true);
  const filledRace = filledHarness.manager.startRace(filledHost.participantId);
  assert.equal(filledRace.roster.length, 4);
  assert.equal(filledRace.roster.filter((entry) => entry.controllerKind === 'ai').length, 2);

  const humansOnlyHarness = createHarness();
  const humansOnlyHost = humansOnlyHarness.manager.createRoom({
    displayName: 'Host', characterId: 'pip', roomName: 'Human Cup',
    roomType: ROOM_TYPES.PUBLIC, maxPlayers: 4,
  });
  const humansOnlyGuest = humansOnlyHarness.manager.joinRoom(humansOnlyHost.roomCode, {
    displayName: 'Guest', characterId: 'nova',
  });
  humansOnlyHarness.manager.setRoom(humansOnlyHost.participantId, { autoFillAi: false });
  humansOnlyHarness.manager.setReady(humansOnlyHost.participantId, true);
  humansOnlyHarness.manager.setReady(humansOnlyGuest.participantId, true);
  const humansOnlyRace = humansOnlyHarness.manager.startRace(humansOnlyHost.participantId);
  assert.equal(humansOnlyRace.roster.length, 2);
  assert.equal(humansOnlyRace.roster.every((entry) => entry.controllerKind === 'human'), true);
});

test('only the host can kick another waiting-room player', () => {
  const harness = createHarness();
  const { host, guest } = addTwoPlayers(harness);

  assert.throws(
    () => harness.manager.kickPlayer(guest.participantId, host.participantId),
    (error) => error.code === ERROR_CODES.FORBIDDEN,
  );
  assert.throws(
    () => harness.manager.kickPlayer(host.participantId, host.participantId),
    (error) => error.code === ERROR_CODES.FORBIDDEN,
  );

  const result = harness.manager.kickPlayer(host.participantId, guest.participantId);
  assert.equal(result.participantId, guest.participantId);
  assert.deepEqual(harness.kicked, [{
    roomCode: host.roomCode,
    roomName: 'Host Raceway',
    participantId: guest.participantId,
    displayName: 'Guest',
  }]);
  assert.deepEqual(
    harness.manager.getRoomState(host.roomCode).members.map((member) => member.participantId),
    [host.participantId],
  );
  assert.equal(harness.manager.participantRooms.has(guest.participantId), false);

  const replacement = harness.manager.joinRoom(host.roomCode, {
    displayName: 'Replacement', characterId: 'nova',
  });
  assert.notEqual(replacement.participantId, guest.participantId);
});

test('room metadata, capacity, and list status use each room human-seat limit', () => {
  const harness = createHarness();
  const host = harness.manager.createRoom({
    displayName: 'Host', characterId: 'pip', roomName: 'Two Seat Sprint',
    roomType: ROOM_TYPES.PUBLIC, maxPlayers: 2, trackId: 'harbor-loop',
  });
  let state = harness.manager.getRoomState(host.roomCode);
  assert.equal(state.roomName, 'Two Seat Sprint');
  assert.equal(state.roomType, ROOM_TYPES.PUBLIC);
  assert.equal(state.maxPlayers, 2);
  assert.equal(state.settings.trackId, 'harbor-loop');
  assert.deepEqual(harness.manager.listRooms(), [{
    roomCode: host.roomCode,
    roomName: 'Two Seat Sprint',
    roomType: ROOM_TYPES.PUBLIC,
    requiresPassword: false,
    playerCount: 1,
    maxPlayers: 2,
    hostDisplayName: 'Host',
    trackId: 'harbor-loop',
    status: 'waiting',
    joinable: true,
  }]);

  harness.manager.joinRoom(host.roomCode, { displayName: 'Host', characterId: 'nova' });
  state = harness.manager.getRoomState(host.roomCode);
  assert.equal(state.members.length, 2);
  assert.equal(harness.manager.listRooms()[0].status, 'full');
  assert.equal(harness.manager.listRooms()[0].joinable, false);
  assert.throws(
    () => harness.manager.joinRoom(host.roomCode, { displayName: 'Third', characterId: 'kit' }),
    (error) => error.code === ERROR_CODES.ROOM_FULL,
  );
});

test('private rooms hash case-sensitive passwords and expose no verifier data', () => {
  const harness = createHarness();
  const host = harness.manager.createRoom({
    displayName: 'Host', characterId: 'pip', roomName: 'Private Only',
    roomType: ROOM_TYPES.PRIVATE, maxPlayers: 4, password: 'PitLane9',
  });
  const room = harness.manager.rooms.get(host.roomCode);
  assert.equal(Object.hasOwn(room, 'password'), false);
  assert.equal(Object.hasOwn(room, 'passwordSalt'), false);
  assert.equal(Object.hasOwn(room, 'passwordHash'), false);
  const verifier = harness.manager._passwordVerifiers.get(room);
  assert.equal(verifier.salt instanceof Buffer, true);
  assert.equal(verifier.hash instanceof Buffer, true);
  assert.equal(verifier.hash.toString('utf8').includes('PitLane9'), false);
  assert.equal(Object.hasOwn(harness.manager.listRooms()[0], 'passwordHash'), false);
  assert.equal(Object.hasOwn(harness.manager.getRoomState(host.roomCode), 'passwordHash'), false);
  assert.throws(
    () => harness.manager.joinRoom(host.roomCode, { displayName: 'Guest', characterId: 'nova' }),
    (error) => error.code === ERROR_CODES.PASSWORD_REQUIRED,
  );
  assert.throws(
    () => harness.manager.joinRoom(host.roomCode, {
      displayName: 'Guest', characterId: 'nova', password: 'pitlane9',
    }),
    (error) => error.code === ERROR_CODES.PASSWORD_INVALID,
  );
  const guest = harness.manager.joinRoom(host.roomCode, {
    displayName: 'Host', characterId: 'nova', password: 'PitLane9',
  });
  assert.notEqual(guest.participantId, host.participantId);
  assert.equal(harness.manager.listRooms()[0].requiresPassword, true);
});

test('quick match atomically joins only a visible joinable public room', () => {
  const codes = ['ABC234', 'DEF567'];
  const harness = createHarness({ roomCodeFactory: () => codes.shift() });
  harness.manager.createRoom({
    displayName: 'Private Host', characterId: 'pip', roomName: 'Private',
    roomType: ROOM_TYPES.PRIVATE, maxPlayers: 4, password: 'Secret99',
  });
  assert.throws(
    () => harness.manager.quickMatch({ displayName: 'Guest' }),
    (error) => error.code === ERROR_CODES.NO_MATCHING_ROOM,
  );

  const publicHost = harness.manager.createRoom({
    displayName: 'Public Host', characterId: 'nova', roomName: 'Public',
    roomType: ROOM_TYPES.PUBLIC, maxPlayers: 2,
  });
  const matched = harness.manager.quickMatch({ displayName: 'Public Host' });
  assert.equal(matched.roomCode, publicHost.roomCode);
  assert.equal(harness.manager.listRooms().find((room) => room.roomCode === publicHost.roomCode).status, 'full');
  assert.throws(
    () => harness.manager.quickMatch({ displayName: 'Another Guest' }),
    (error) => error.code === ERROR_CODES.NO_MATCHING_ROOM,
  );
});

test('room list counts reserved reconnect seats and hides rooms with no online member', () => {
  const harness = createHarness();
  const { host, guest } = addTwoPlayers(harness);
  harness.manager.disconnect(guest.participantId);
  assert.equal(harness.manager.listRooms()[0].playerCount, 2);
  assert.equal(harness.manager.listRooms()[0].hostDisplayName, 'Host');
  harness.manager.disconnect(host.participantId);
  assert.deepEqual(harness.manager.listRooms(), []);
});

test('connected waiting rooms remain available without an inactivity timeout', async () => {
  const harness = createHarness({ emptyRoomTtlMs: 60_000 });
  const host = harness.manager.createRoom({
    displayName: 'Host', characterId: 'pip', roomName: 'Long Wait',
    roomType: ROOM_TYPES.PUBLIC, maxPlayers: 8,
  });

  harness.advance(24 * 60 * 60_000);
  await harness.manager.tick();

  assert.equal(harness.manager.roomCount, 1);
  assert.equal(harness.manager.getRoomState(host.roomCode).members.length, 1);
  assert.equal(harness.manager.listRooms()[0].roomCode, host.roomCode);
});

test('a disconnected waiting room honors the full empty-room TTL', async () => {
  const harness = createHarness({ resumeTimeoutMs: 30_000, emptyRoomTtlMs: 60_000 });
  const destroyed = [];
  harness.manager.on('roomDestroyed', (event) => destroyed.push(event));
  const host = harness.manager.createRoom({
    displayName: 'Host', characterId: 'pip', roomName: 'Reconnect Window',
    roomType: ROOM_TYPES.PUBLIC, maxPlayers: 8,
  });
  harness.manager.disconnect(host.participantId);

  harness.advance(30_001);
  await harness.manager.tick();
  assert.equal(harness.manager.roomCount, 1);
  assert.equal(harness.manager.rooms.get(host.roomCode).members.size, 0);
  assert.deepEqual(harness.manager.listRooms(), []);

  harness.advance(29_998);
  await harness.manager.tick();
  assert.equal(harness.manager.roomCount, 1);

  harness.advance(1);
  await harness.manager.tick();
  assert.equal(harness.manager.roomCount, 0);
  assert.deepEqual(destroyed, [{ roomCode: host.roomCode }]);
});

test('an explicitly emptied waiting room also honors the full empty-room TTL', async () => {
  const harness = createHarness({ emptyRoomTtlMs: 60_000 });
  const host = harness.manager.createRoom({
    displayName: 'Host', characterId: 'pip', roomName: 'Empty Room',
    roomType: ROOM_TYPES.PUBLIC, maxPlayers: 8,
  });
  harness.manager.leave(host.participantId);

  assert.equal(harness.manager.roomCount, 1);
  assert.deepEqual(harness.manager.listRooms(), []);

  harness.advance(59_999);
  await harness.manager.tick();
  assert.equal(harness.manager.roomCount, 1);

  harness.advance(1);
  await harness.manager.tick();
  assert.equal(harness.manager.roomCount, 0);
});

test('start prepares one deterministic eight-kart roster and launches after all clients load', async () => {
  const harness = createHarness();
  const { host, race } = await startTwoPlayerRace(harness);
  const simulation = harness.simulations[0];
  const prepare = harness.messages
    .map((event) => event.message)
    .find((message) => message.type === 'prepare_race');

  assert.equal(harness.manager.getRoomState(host.roomCode).state, ROOM_STATES.COUNTDOWN);
  assert.equal(harness.manager.listRooms()[0].status, 'in_game');
  assert.equal(harness.manager.listRooms()[0].joinable, false);
  assert.equal(prepare.roster.length, 8);
  assert.equal(new Set(prepare.roster.map((entry) => entry.characterId)).size, 8);
  assert.deepEqual(prepare.roster, simulation.args.roster);
  assert.deepEqual(prepare.roster.map((entry) => entry.kartIndex), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(race.seed, 424242);
  const protocolMessages = harness.messages.map((event) => event.message.type);
  const lastAckIndex = protocolMessages.lastIndexOf('race_loaded_ack');
  const firstSnapshotIndex = protocolMessages.indexOf('snapshot');
  assert.notEqual(lastAckIndex, -1);
  assert.equal(firstSnapshotIndex === -1 || lastAckIndex < firstSnapshotIndex, true);
});

test('race_loaded ACK is emitted before simulation launch and duplicate loads are idempotent', async () => {
  const harness = createHarness();
  const { host, guest } = addTwoPlayers(harness);
  harness.manager.setReady(host.participantId, true);
  harness.manager.setReady(guest.participantId, true);
  const race = harness.manager.startRace(host.participantId);

  await harness.manager.markRaceLoaded(host.participantId, race.raceId);
  const hostAck = harness.messages.find((event) => (
    event.participantId === host.participantId
    && event.message.type === 'race_loaded_ack'
  ));
  assert.deepEqual(hostAck.message, {
    v: PROTOCOL_VERSION,
    type: 'race_loaded_ack',
    raceId: race.raceId,
    phase: ROOM_STATES.LOADING,
    late: false,
  });
  assert.equal(harness.simulations.length, 0);

  await harness.manager.markRaceLoaded(guest.participantId, race.raceId);
  assert.equal(harness.simulations.length, 1);
  await harness.manager.markRaceLoaded(guest.participantId, race.raceId);
  assert.equal(harness.simulations.length, 1);
  assert.equal(harness.messages.filter((event) => (
    event.participantId === guest.participantId
    && event.message.type === 'race_loaded_ack'
  )).length, 2);
});

test('new useItemSeq survives a stale movement seq and fires for exactly one physics step', async () => {
  const harness = createHarness();
  const { host, race } = await startTwoPlayerRace(harness);
  const base = {
    raceId: race.raceId,
    brake: 0,
    steer: 0.25,
    drift: false,
    lookBack: false,
  };
  harness.manager.handleInput(host.participantId, {
    ...base, seq: 2, useItemSeq: 0, throttle: 0.8,
  });
  harness.manager.handleInput(host.participantId, {
    ...base, seq: 1, useItemSeq: 1, throttle: 0.1,
  });

  harness.advance(51);
  await harness.manager.tick();
  const simulation = harness.simulations[0];
  const hostIndex = race.roster.find((entry) => entry.participantId === host.participantId).kartIndex;
  assert.equal(simulation.updates[0][hostIndex].throttle, 0.8);
  assert.equal(simulation.updates[0][hostIndex].useItem, true);
  assert.equal(simulation.updates[1][hostIndex].useItem, false);
  assert.equal(simulation.updates.slice(2).some((inputs) => inputs[hostIndex].useItem), false);

  const snapshot = harness.messages.find((event) => (
    event.roomCode === host.roomCode && event.message.type === 'snapshot'
  ))?.message;
  const hostAck = snapshot.acks.find((entry) => entry[0] === hostIndex);
  assert.deepEqual(hostAck, [hostIndex, 2, 1]);
  assert.equal(Object.hasOwn(snapshot, 'ack'), false);
  assert.equal(Object.hasOwn(snapshot, 'inputAck'), false);
  assert.equal(Object.hasOwn(snapshot, 'useItemAck'), false);
});

test('one public compact snapshot is built per room tick for every connected client', async () => {
  const harness = createHarness();
  const { host } = await startTwoPlayerRace(harness);
  const simulation = harness.simulations[0];
  let builds = 0;
  simulation.getSnapshot = () => {
    builds++;
    return {
      state: simulation.state,
      countdown: simulation.countdown,
      elapsed: simulation.elapsed,
      laps: simulation.laps,
      karts: simulation.karts,
      projectiles: [],
      hazards: [],
      itemBoxes: [],
    };
  };

  harness.advance(51);
  await harness.manager.tick();
  const snapshots = harness.messages.filter((event) => event.message.type === 'snapshot');
  assert.equal(builds, 1);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].roomCode, host.roomCode);
  assert.equal(snapshots[0].participantId, null);
  assert.equal(Array.isArray(snapshots[0].message.karts[0]), true);
  assert.equal(Object.hasOwn(snapshots[0].message, 'standings'), false);
});

test('a race ending on a scheduled snapshot tick emits only the final shared snapshot', async () => {
  const harness = createHarness();
  await startTwoPlayerRace(harness);
  const simulation = harness.simulations[0];
  const update = simulation.update.bind(simulation);
  let builds = 0;
  simulation.update = (dt, controls) => {
    update(dt, controls);
    if (simulation.updates.length >= 6) simulation.state = ROOM_STATES.RESULTS;
  };
  simulation.getSnapshot = () => {
    builds++;
    return {
      state: simulation.state,
      countdown: simulation.countdown,
      elapsed: simulation.elapsed,
      laps: simulation.laps,
      karts: simulation.karts,
      projectiles: [],
      hazards: [],
      itemBoxes: [],
    };
  };

  harness.advance(51);
  await harness.manager.tick();
  assert.equal(builds, 1);
  assert.equal(harness.messages.filter((event) => event.message.type === 'snapshot').length, 1);
  assert.equal(harness.messages.filter((event) => event.message.type === 'race_results').length, 1);
});

test('production eight-kart baseline snapshot stays below 7 KB without static roster data', async () => {
  const harness = createHarness({ raceFactory: createDefaultRaceFactory() });
  const { host } = await startTwoPlayerRace(harness);
  harness.advance(51);
  await harness.manager.tick();
  const snapshot = harness.messages.find((event) => (
    event.roomCode === host.roomCode && event.message.type === 'snapshot'
  ))?.message;
  const bytes = Buffer.byteLength(JSON.stringify(snapshot));

  assert.ok(bytes <= 7 * 1024, `expected <= 7168 bytes, received ${bytes}`);
  assert.equal(snapshot.karts.length, 8);
  assert.equal(snapshot.acks.length, 8);
  assert.equal(Object.hasOwn(snapshot, 'standings'), false);
  assert.equal(snapshot.karts.every((kart) => Array.isArray(kart)), true);
  assert.equal(snapshot.itemBoxes.every((box) => (
    Array.isArray(box) && box.length === 2
  )), true);
  const wire = JSON.stringify(snapshot);
  for (const staticField of ['displayName', 'participantId', 'characterId', 'paintId', 'avatarId', 'lapTimes']) {
    assert.equal(wire.includes(`\"${staticField}\"`), false, `${staticField} leaked into snapshot`);
  }
});

test('disconnect immediately transfers host and takeover AI can be reclaimed within 30 seconds', async () => {
  const harness = createHarness();
  const { host, guest, race } = await startTwoPlayerRace(harness);
  const simulation = harness.simulations[0];
  const hostIndex = race.roster.find((entry) => entry.participantId === host.participantId).kartIndex;

  harness.manager.disconnect(host.participantId);
  assert.equal(harness.manager.getRoomState(host.roomCode).hostParticipantId, guest.participantId);
  assert.equal(simulation.controllers[hostIndex], 'takeover-ai');

  harness.advance(29_000);
  const resumed = harness.manager.resume(host.roomCode, host.participantId, host.resumeToken);
  assert.equal(resumed.resumed, true);
  assert.deepEqual(
    resumed.messages.map((message) => message.type),
    ['room_state', 'prepare_race', 'race_loaded_ack', 'snapshot'],
  );
  assert.equal(simulation.controllers[hostIndex], 'takeover-ai');
  harness.manager.handleInput(host.participantId, {
    raceId: race.raceId,
    seq: 1,
    useItemSeq: 0,
    throttle: 0.6,
    brake: 0,
    steer: 0,
    drift: false,
    lookBack: false,
  });
  assert.equal(simulation.controllers[hostIndex], 'human');
  assert.equal(harness.manager.getRoomState(host.roomCode).hostParticipantId, guest.participantId);
});

test('room state distinguishes reconnecting, disconnected and explicit leave presence', async () => {
  const harness = createHarness();
  const { host, guest, race } = await startTwoPlayerRace(harness);

  let state = harness.manager.getRoomState(host.roomCode);
  assert.equal(
    state.members.find((member) => member.participantId === guest.participantId).presenceState,
    'connected',
  );

  harness.manager.disconnect(guest.participantId);
  state = harness.manager.getRoomState(host.roomCode);
  let guestState = state.members.find((member) => member.participantId === guest.participantId);
  assert.equal(guestState.presenceState, 'reconnecting');
  assert.equal(guestState.controllerKind, 'takeover-ai');

  harness.manager.resume(host.roomCode, guest.participantId, guest.resumeToken);
  state = harness.manager.getRoomState(host.roomCode);
  guestState = state.members.find((member) => member.participantId === guest.participantId);
  assert.equal(guestState.presenceState, 'connected');
  assert.equal(guestState.controllerKind, 'takeover-ai');

  harness.manager.handleInput(guest.participantId, {
    raceId: race.raceId,
    seq: 1,
    useItemSeq: 0,
    throttle: 0.5,
    brake: 0,
    steer: 0,
    drift: false,
    lookBack: false,
  });
  state = harness.manager.getRoomState(host.roomCode);
  assert.equal(
    state.members.find((member) => member.participantId === guest.participantId).controllerKind,
    'human',
  );

  harness.manager.disconnect(guest.participantId);
  harness.advance(30_001);
  await harness.manager.tick();
  state = harness.manager.getRoomState(host.roomCode);
  assert.equal(
    state.members.find((member) => member.participantId === guest.participantId).presenceState,
    'disconnected',
  );

  harness.manager.leave(host.participantId);
  state = harness.manager.getRoomState(host.roomCode);
  assert.equal(
    state.members.find((member) => member.participantId === host.participantId).presenceState,
    'left',
  );
});

test('item-only traffic cannot reclaim takeover AI or queue a delayed item use', async () => {
  const harness = createHarness();
  const { host, race } = await startTwoPlayerRace(harness);
  const simulation = harness.simulations[0];
  const hostIndex = race.roster.find((entry) => entry.participantId === host.participantId).kartIndex;
  const input = {
    raceId: race.raceId,
    seq: 10,
    useItemSeq: 0,
    throttle: 0.5,
    brake: 0,
    steer: 0,
    drift: false,
    lookBack: false,
  };
  harness.manager.handleInput(host.participantId, input);
  harness.manager.disconnect(host.participantId);
  harness.manager.resume(host.roomCode, host.participantId, host.resumeToken);

  harness.manager.handleInput(host.participantId, { ...input, useItemSeq: 1 });
  assert.equal(simulation.controllers[hostIndex], 'takeover-ai');
  harness.manager.handleInput(host.participantId, { ...input, seq: 11, useItemSeq: 1 });
  harness.advance(17);
  await harness.manager.tick();
  assert.equal(simulation.controllers[hostIndex], 'human');
  assert.equal(simulation.updates.some((inputs) => inputs[hostIndex]?.useItem), false);
});

test('a sole player reclaiming an empty room becomes its host again', () => {
  const harness = createHarness();
  const host = harness.manager.createRoom({
    displayName: 'Host', characterId: 'pip', roomName: 'Solo Room',
    roomType: ROOM_TYPES.PUBLIC, maxPlayers: 8,
  });
  harness.manager.disconnect(host.participantId);
  assert.equal(harness.manager.getRoomState(host.roomCode).hostParticipantId, null);
  harness.manager.resume(host.roomCode, host.participantId, host.resumeToken);
  assert.equal(harness.manager.getRoomState(host.roomCode).hostParticipantId, host.participantId);
});

test('loading timeout cancels a race when fewer than two clients finish loading', async () => {
  const harness = createHarness({ loadTimeoutMs: 10_000 });
  const { host, guest } = addTwoPlayers(harness);
  harness.manager.setReady(host.participantId, true);
  harness.manager.setReady(guest.participantId, true);
  const race = harness.manager.startRace(host.participantId);
  await harness.manager.markRaceLoaded(host.participantId, race.raceId);

  harness.advance(10_001);
  await harness.manager.tick();
  const roomState = harness.manager.getRoomState(host.roomCode);
  assert.equal(roomState.state, ROOM_STATES.WAITING);
  assert.equal(harness.simulations.length, 0);
  assert.deepEqual(roomState.members.map((member) => member.ready), [false, false]);
  assert.deepEqual(roomState.members.map((member) => member.controllerKind), ['human', 'human']);
  assert.deepEqual(harness.managerErrors, []);
});

test('two loaded players start at timeout while a late third player keeps AI until fresh movement', async () => {
  const harness = createHarness({ loadTimeoutMs: 10_000 });
  const { host, guest } = addTwoPlayers(harness);
  const late = harness.manager.joinRoom(host.roomCode, {
    displayName: 'Late', characterId: 'kit',
  });
  for (const player of [host, guest, late]) {
    harness.manager.setReady(player.participantId, true);
  }
  const race = harness.manager.startRace(host.participantId);
  await harness.manager.markRaceLoaded(host.participantId, race.raceId);
  await harness.manager.markRaceLoaded(guest.participantId, race.raceId);
  assert.equal(harness.simulations.length, 0);

  harness.advance(10_001);
  await harness.manager.tick();
  const simulation = harness.simulations[0];
  const lateIndex = race.roster.find((entry) => entry.participantId === late.participantId).kartIndex;
  assert.equal(harness.manager.getRoomState(host.roomCode).state, ROOM_STATES.COUNTDOWN);
  assert.equal(simulation.controllers[lateIndex], 'takeover-ai');

  const beforeLateLoad = harness.messages.length;
  await harness.manager.markRaceLoaded(late.participantId, race.raceId);
  const lateMessages = harness.messages.slice(beforeLateLoad);
  assert.deepEqual(lateMessages[0], {
    roomCode: null,
    participantId: late.participantId,
    message: {
      v: PROTOCOL_VERSION,
      type: 'race_loaded_ack',
      raceId: race.raceId,
      phase: ROOM_STATES.COUNTDOWN,
      late: true,
    },
  });
  assert.equal(simulation.controllers[lateIndex], 'takeover-ai');

  await harness.manager.markRaceLoaded(late.participantId, race.raceId);
  assert.equal(harness.simulations.length, 1);
  assert.equal(simulation.controllers[lateIndex], 'takeover-ai');

  harness.manager.handleInput(late.participantId, {
    raceId: race.raceId,
    seq: 0,
    useItemSeq: 0,
    throttle: 0,
    brake: 0,
    steer: 0,
    drift: false,
    lookBack: false,
  });
  assert.equal(simulation.controllers[lateIndex], 'human');
});

test('race_loaded rejects a wrong race and the results phase', async () => {
  const harness = createHarness();
  const { host, race } = await startTwoPlayerRace(harness);
  await assert.rejects(
    harness.manager.markRaceLoaded(host.participantId, 'another_race_123'),
    (error) => error.code === ERROR_CODES.RACE_MISMATCH,
  );
  const room = harness.manager.rooms.get(host.roomCode);
  harness.manager._finishRace(room, harness.now());
  await assert.rejects(
    harness.manager.markRaceLoaded(host.participantId, race.raceId),
    (error) => error.code === ERROR_CODES.RACE_MISMATCH,
  );
});

test('loading waits for the reconnect window instead of cancelling immediately at one player', async () => {
  const harness = createHarness({ loadTimeoutMs: 10_000 });
  const { host, guest } = addTwoPlayers(harness);
  harness.manager.setReady(host.participantId, true);
  harness.manager.setReady(guest.participantId, true);
  const race = harness.manager.startRace(host.participantId);
  await harness.manager.markRaceLoaded(host.participantId, race.raceId);
  harness.manager.disconnect(host.participantId);
  await harness.manager.markRaceLoaded(guest.participantId, race.raceId);
  assert.equal(harness.manager.getRoomState(host.roomCode).state, ROOM_STATES.LOADING);

  harness.advance(10_001);
  await harness.manager.tick();
  const state = harness.manager.getRoomState(host.roomCode);
  assert.equal(state.state, ROOM_STATES.WAITING);
  assert.equal(state.members.length, 2);
  assert.equal(harness.manager.listRooms()[0].playerCount, 2);
  assert.deepEqual(harness.managerErrors, []);
});

test('loading cancellation removes an abandoned member and releases their character', async () => {
  const harness = createHarness({ loadTimeoutMs: 10_000 });
  const { host, guest } = addTwoPlayers(harness);
  harness.manager.setReady(host.participantId, true);
  harness.manager.setReady(guest.participantId, true);
  const race = harness.manager.startRace(host.participantId);
  await harness.manager.markRaceLoaded(host.participantId, race.raceId);
  harness.manager.leave(guest.participantId);

  harness.advance(10_001);
  await harness.manager.tick();
  const state = harness.manager.getRoomState(host.roomCode);
  assert.equal(state.state, ROOM_STATES.WAITING);
  assert.deepEqual(state.members.map((member) => member.participantId), [host.participantId]);
  assert.equal(harness.manager.participantRooms.has(guest.participantId), false);
  harness.manager.selectCharacter(host.participantId, 'nova');
  assert.equal(harness.manager.getRoomState(host.roomCode).members[0].characterId, 'nova');
});

test('race factory failure removes loading-stage leavers instead of leaving ghosts', async () => {
  const harness = createHarness({
    raceFactory: async () => { throw new Error('factory failed'); },
  });
  const { host, guest } = addTwoPlayers(harness);
  const leaver = harness.manager.joinRoom(host.roomCode, {
    displayName: 'Leaver', characterId: 'kit',
  });
  for (const participant of [host, guest, leaver]) {
    harness.manager.setReady(participant.participantId, true);
  }
  const race = harness.manager.startRace(host.participantId);
  await harness.manager.markRaceLoaded(host.participantId, race.raceId);
  harness.manager.leave(leaver.participantId);
  await harness.manager.markRaceLoaded(guest.participantId, race.raceId);

  const state = harness.manager.getRoomState(host.roomCode);
  assert.equal(state.state, ROOM_STATES.WAITING);
  assert.deepEqual(
    state.members.map((member) => member.participantId),
    [host.participantId, guest.participantId],
  );
  assert.equal(harness.manager.participantRooms.has(leaver.participantId), false);
  harness.manager.selectCharacter(host.participantId, 'kit');
  assert.equal(
    harness.manager.getRoomState(host.roomCode).members
      .find((member) => member.participantId === host.participantId).characterId,
    'kit',
  );
});

test('expired reconnect credentials are rejected and the kart remains AI-controlled', async () => {
  const harness = createHarness();
  const { host, race } = await startTwoPlayerRace(harness);
  const simulation = harness.simulations[0];
  const hostIndex = race.roster.find((entry) => entry.participantId === host.participantId).kartIndex;
  harness.manager.disconnect(host.participantId);
  harness.advance(30_001);
  await harness.manager.tick();

  assert.throws(
    () => harness.manager.resume(host.roomCode, host.participantId, host.resumeToken),
    (error) => error.code === ERROR_CODES.SESSION_EXPIRED,
  );
  assert.equal(simulation.controllers[hostIndex], 'takeover-ai');
});

test('production race factory accepts the announced roster without reordering it', async () => {
  const harness = createHarness({ raceFactory: createDefaultRaceFactory() });
  const { host, race } = await startTwoPlayerRace(harness);
  const room = harness.manager.rooms.get(host.roomCode);
  assert.equal(room.race.simulation.karts.length, 8);
  assert.deepEqual(
    room.race.simulation.roster.map((entry) => entry.participantId),
    race.roster.map((entry) => entry.participantId),
  );

  harness.advance(17);
  await harness.manager.tick();
  assert.equal(room.race.tick, 1);
});

test('production race factory starts a two-player race when AI auto-fill is disabled', async () => {
  const harness = createHarness({ raceFactory: createDefaultRaceFactory() });
  const { host, guest } = addTwoPlayers(harness);
  harness.manager.setRoom(host.participantId, { autoFillAi: false });
  harness.manager.setReady(host.participantId, true);
  harness.manager.setReady(guest.participantId, true);
  const race = harness.manager.startRace(host.participantId);

  await harness.manager.markRaceLoaded(host.participantId, race.raceId);
  await harness.manager.markRaceLoaded(guest.participantId, race.raceId);

  const room = harness.manager.rooms.get(host.roomCode);
  assert.equal(room.state, ROOM_STATES.COUNTDOWN);
  assert.equal(room.race.roster.length, 2);
  assert.equal(room.race.simulation.karts.length, 2);
  assert.deepEqual(
    room.race.simulation.roster.map((entry) => entry.participantId),
    race.roster.map((entry) => entry.participantId),
  );
  assert.deepEqual(harness.managerErrors, []);
});

test('late input from the current finished race is ignored but another race id is rejected', async () => {
  const harness = createHarness();
  const { host, race } = await startTwoPlayerRace(harness);
  const room = harness.manager.rooms.get(host.roomCode);
  harness.manager._finishRace(room, harness.now());
  const input = {
    raceId: race.raceId,
    seq: 1,
    useItemSeq: 0,
    throttle: 1,
    brake: 0,
    steer: 0,
    drift: false,
    lookBack: false,
  };

  assert.equal(harness.manager.handleInput(host.participantId, input), false);
  assert.throws(
    () => harness.manager.handleInput(host.participantId, { ...input, raceId: 'another_race_123' }),
    (error) => error.code === ERROR_CODES.RACE_MISMATCH,
  );

  harness.manager.returnToRoom(host.participantId);
  const guest = harness.manager.getRoomState(host.roomCode).members
    .find((member) => member.participantId !== host.participantId);
  harness.manager.returnToRoom(guest.participantId);
  assert.equal(harness.manager.handleInput(host.participantId, input), false);
});

test('players return independently and can prepare while others remain in game', async () => {
  const harness = createHarness();
  const { host, guest } = await startTwoPlayerRace(harness);
  const room = harness.manager.rooms.get(host.roomCode);
  harness.manager._finishRace(room, harness.now());

  harness.manager.returnToRoom(host.participantId);
  let state = harness.manager.getRoomState(host.roomCode);
  assert.equal(state.state, ROOM_STATES.RESULTS);
  assert.equal(state.members.find((member) => member.participantId === host.participantId).activityState, 'room');
  assert.equal(state.members.find((member) => member.participantId === guest.participantId).activityState, 'in_game');
  assert.deepEqual(
    harness.manager.getCatchUpMessages(host.participantId).map((message) => message.type),
    ['room_state'],
  );

  harness.manager.selectCharacter(host.participantId, 'kit');
  harness.manager.setRoom(host.participantId, { difficulty: 'hard' });
  harness.manager.setReady(host.participantId, true);
  state = harness.manager.getRoomState(host.roomCode);
  assert.equal(state.members.find((member) => member.participantId === host.participantId).ready, true);
  assert.equal(state.canStart, false);

  harness.manager.returnToRoom(guest.participantId);
  state = harness.manager.getRoomState(host.roomCode);
  assert.equal(state.state, ROOM_STATES.WAITING);
  assert.equal(state.settings.difficulty, 'hard');
  assert.equal(state.members.find((member) => member.participantId === host.participantId).characterId, 'kit');
  assert.equal(state.members.find((member) => member.participantId === host.participantId).ready, true);
  assert.equal(state.members.find((member) => member.participantId === guest.participantId).ready, false);
});

test('results automatically return every online player to a waiting room after 30 seconds', async () => {
  const harness = createHarness({ resultsTimeoutMs: 30_000 });
  const { host } = await startTwoPlayerRace(harness);
  const room = harness.manager.rooms.get(host.roomCode);
  harness.manager._finishRace(room, harness.now());
  assert.equal(harness.manager.getRoomState(host.roomCode).state, ROOM_STATES.RESULTS);

  harness.advance(30_001);
  await harness.manager.tick();
  const state = harness.manager.getRoomState(host.roomCode);
  assert.equal(state.state, ROOM_STATES.WAITING);
  assert.equal(state.raceId, null);
  assert.equal(state.members.length, 2);
  assert.equal(state.members.every((member) => member.ready === false), true);
  assert.equal(state.members.every((member) => member.postRaceState === null), true);
  assert.equal(harness.manager.listRooms()[0].status, 'waiting');
  assert.deepEqual(harness.managerErrors, []);
});

test('results return keeps a disconnected member reserved and resumable within 30 seconds', async () => {
  const harness = createHarness();
  const { host, guest } = await startTwoPlayerRace(harness);
  const room = harness.manager.rooms.get(host.roomCode);
  harness.manager._finishRace(room, harness.now());
  harness.manager.disconnect(guest.participantId);
  harness.manager.returnToRoom(host.participantId);

  let state = harness.manager.getRoomState(host.roomCode);
  assert.equal(state.state, ROOM_STATES.WAITING);
  assert.equal(state.members.length, 2);
  assert.equal(
    state.members.find((member) => member.participantId === guest.participantId).connected,
    false,
  );
  assert.equal(harness.manager.listRooms()[0].playerCount, 2);
  assert.equal(state.canStart, false);

  harness.advance(29_000);
  const resumed = harness.manager.resume(host.roomCode, guest.participantId, guest.resumeToken);
  assert.equal(resumed.resumed, true);
  state = harness.manager.getRoomState(host.roomCode);
  assert.equal(state.members.length, 2);
  assert.equal(
    state.members.find((member) => member.participantId === guest.participantId).connected,
    true,
  );
});

test('a disconnected results member is removed after the waiting-room reconnect grace expires', async () => {
  const harness = createHarness();
  const { host, guest } = await startTwoPlayerRace(harness);
  const room = harness.manager.rooms.get(host.roomCode);
  harness.manager._finishRace(room, harness.now());
  harness.manager.disconnect(guest.participantId);
  harness.manager.returnToRoom(host.participantId);

  harness.advance(30_001);
  await harness.manager.tick();
  const state = harness.manager.getRoomState(host.roomCode);
  assert.deepEqual(state.members.map((member) => member.participantId), [host.participantId]);
  assert.equal(harness.manager.listRooms()[0].playerCount, 1);
  assert.equal(harness.manager.participantRooms.has(guest.participantId), false);
  assert.throws(
    () => harness.manager.resume(host.roomCode, guest.participantId, guest.resumeToken),
    (error) => error.code === ERROR_CODES.SESSION_NOT_FOUND,
  );
});
