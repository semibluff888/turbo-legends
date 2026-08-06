import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_SEND_INTERVAL_MS,
  ERROR_CODES,
  PROTOCOL_VERSION,
  ROOM_STATES,
  ROOM_TYPES,
} from '../src/net/protocol.js';
import { decodeSnapshotPacket } from '../src/net/binary-race-codec.js';
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
    wallClock: () => 1_700_000_000_000 + now,
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

async function addTwoPlayers(harness) {
  const host = await harness.manager.createRoom({
    displayName: 'Host',
    characterId: 'pip',
    roomName: 'Host Raceway',
    roomType: ROOM_TYPES.PUBLIC,
    maxPlayers: 8,
  });
  const guest = await harness.manager.joinRoom(host.roomCode, {
    displayName: 'Guest', characterId: 'nova',
  });
  return { host, guest };
}

async function startTwoPlayerRace(harness) {
  const players = await addTwoPlayers(harness);
  harness.manager.setRoom(players.host.participantId, { autoFillAi: true });
  harness.manager.setReady(players.host.participantId, true);
  harness.manager.setReady(players.guest.participantId, true);
  const race = harness.manager.startRace(players.host.participantId);
  await harness.manager.markRaceLoaded(players.host.participantId, race.raceId);
  await harness.manager.markRaceLoaded(players.guest.participantId, race.raceId);
  return { ...players, race };
}

function progressionStore(settlements) {
  return {
    settleRace(settlement) {
      settlements.push(structuredClone(settlement));
      return new Map(settlement.participants.map((participant) => [participant.userId, {
        xpDelta: participant.escaped ? 0 : 20,
        ratingDelta: 0,
        levelBefore: 1,
        levelAfter: 1,
        bestTimeUpdated: false,
        profile: null,
      }]));
    },
  };
}

async function finishHarnessRace(harness) {
  harness.simulations[0].state = ROOM_STATES.RESULTS;
  harness.advance(17);
  await harness.manager.tick();
}

test('waiting room allows duplicate names and racers while loadout changes reset only that racer', async () => {
  const harness = createHarness();
  const { host, guest } = await addTwoPlayers(harness);
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
  assert.throws(
    () => harness.manager.setLoadout(guest.participantId, { characterId: 'tundra' }),
    (error) => error.code === ERROR_CODES.CHARACTER_LOCKED,
  );
  await assert.rejects(
    harness.manager.joinRoom(host.roomCode, {
      displayName: 'Prototype', characterId: 'gearbox',
    }),
    (error) => error.code === ERROR_CODES.CHARACTER_LOCKED,
  );
  assert.deepEqual(
    harness.manager.getRoomState(host.roomCode).members[1],
    initialMembers[1],
  );

  const duplicateName = await harness.manager.joinRoom(host.roomCode, {
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
  assert.equal(harness.manager.getRoomState(host.roomCode).settings.autoFillAi, false);
  harness.manager.setRoom(host.participantId, { difficulty: 'hard', autoFillAi: true });
  assert.deepEqual(
    harness.manager.getRoomState(host.roomCode).members.map((member) => member.ready),
    [false, false, false],
  );
  assert.equal(harness.manager.getRoomState(host.roomCode).settings.autoFillAi, true);
});

test('room chat uses authoritative identity, enforces 3 seconds, and is not replayed', async () => {
  const harness = createHarness();
  const { host } = await addTwoPlayers(harness);
  const mark = harness.messages.length;

  const first = harness.manager.sendChat(host.participantId, '  Good luck!  ');
  assert.deepEqual(first, {
    v: PROTOCOL_VERSION,
    type: 'room_chat',
    roomCode: host.roomCode,
    participantId: host.participantId,
    displayName: 'Host',
    sentAt: 1_700_000_000_000,
    content: 'Good luck!',
  });
  assert.deepEqual(harness.messages.slice(mark), [{
    roomCode: host.roomCode,
    participantId: null,
    message: first,
  }]);

  assert.throws(
    () => harness.manager.sendChat(host.participantId, 'Too soon'),
    (error) => error.code === ERROR_CODES.CHAT_RATE_LIMITED,
  );
  harness.advance(CHAT_SEND_INTERVAL_MS - 1);
  assert.throws(
    () => harness.manager.sendChat(host.participantId, 'Still too soon'),
    (error) => error.code === ERROR_CODES.CHAT_RATE_LIMITED,
  );
  harness.advance(1);
  assert.equal(
    harness.manager.sendChat(host.participantId, 'Now').sentAt,
    1_700_000_000_000 + CHAT_SEND_INTERVAL_MS,
  );
  assert.equal(
    harness.manager.getCatchUpMessages(host.participantId)
      .some((message) => message.type === 'room_chat'),
    false,
  );
});

test('one user cannot occupy two active room participants and resume requires the same user', async () => {
  const harness = createHarness();
  const host = await harness.manager.createRoom({
    userId: 'user-one', displayName: 'Host', roomName: 'Identity Room',
    roomType: ROOM_TYPES.PUBLIC, maxPlayers: 3,
  });

  await assert.rejects(
    harness.manager.joinRoom(host.roomCode, { userId: 'user-one', displayName: 'Duplicate' }),
    (error) => error.code === ERROR_CODES.ALREADY_IN_ROOM,
  );

  harness.manager.disconnect(host.participantId);
  assert.throws(
    () => harness.manager.resume(host.roomCode, host.participantId, host.resumeToken, 'user-two'),
    (error) => error.code === ERROR_CODES.SESSION_NOT_FOUND,
  );
  assert.equal(
    harness.manager.resume(host.roomCode, host.participantId, host.resumeToken, 'user-one').resumed,
    true,
  );
  assert.equal(
    JSON.stringify(harness.manager.getRoomState(host.roomCode)).includes('user-one'),
    false,
  );
});

test('duplicate human racers keep independent appearances in the announced roster', async () => {
  const harness = createHarness();
  const host = await harness.manager.createRoom({
    displayName: 'Host', characterId: 'kit', paintId: 'turbo-blue', avatarId: 'cat',
    roomName: 'Clone Cup', roomType: ROOM_TYPES.PUBLIC, maxPlayers: 2,
  });
  const guest = await harness.manager.joinRoom(host.roomCode, {
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

test('AI auto-fill is disabled by default and can be enabled by the host', async () => {
  const filledHarness = createHarness();
  const filledHost = await filledHarness.manager.createRoom({
    displayName: 'Host', characterId: 'pip', roomName: 'Four Kart Cup',
    roomType: ROOM_TYPES.PUBLIC, maxPlayers: 4,
  });
  const filledGuest = await filledHarness.manager.joinRoom(filledHost.roomCode, {
    displayName: 'Guest', characterId: 'nova',
  });
  assert.equal(filledHarness.manager.getRoomState(filledHost.roomCode).settings.autoFillAi, false);
  filledHarness.manager.setRoom(filledHost.participantId, { autoFillAi: true });
  filledHarness.manager.setReady(filledHost.participantId, true);
  filledHarness.manager.setReady(filledGuest.participantId, true);
  const filledRace = filledHarness.manager.startRace(filledHost.participantId);
  assert.equal(filledRace.roster.length, 4);
  assert.equal(filledRace.roster.filter((entry) => entry.controllerKind === 'ai').length, 2);
  assert.deepEqual(
    filledRace.roster
      .filter((entry) => entry.controllerKind === 'ai')
      .sort((a, b) => a.aiPlayerNumber - b.aiPlayerNumber)
      .map(({ displayName, aiPlayerNumber }) => ({ displayName, aiPlayerNumber })),
    [
      { displayName: 'AI player 1', aiPlayerNumber: 1 },
      { displayName: 'AI player 2', aiPlayerNumber: 2 },
    ],
  );

  const humansOnlyHarness = createHarness();
  const humansOnlyHost = await humansOnlyHarness.manager.createRoom({
    displayName: 'Host', characterId: 'pip', roomName: 'Human Cup',
    roomType: ROOM_TYPES.PUBLIC, maxPlayers: 4,
  });
  const humansOnlyGuest = await humansOnlyHarness.manager.joinRoom(humansOnlyHost.roomCode, {
    displayName: 'Guest', characterId: 'nova',
  });
  humansOnlyHarness.manager.setRoom(humansOnlyHost.participantId, { autoFillAi: false });
  humansOnlyHarness.manager.setReady(humansOnlyHost.participantId, true);
  humansOnlyHarness.manager.setReady(humansOnlyGuest.participantId, true);
  const humansOnlyRace = humansOnlyHarness.manager.startRace(humansOnlyHost.participantId);
  assert.equal(humansOnlyRace.roster.length, 2);
  assert.equal(humansOnlyRace.roster.every((entry) => entry.controllerKind === 'human'), true);
});

test('only the host can kick another waiting-room player', async () => {
  const harness = createHarness();
  const { host, guest } = await addTwoPlayers(harness);

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

  const replacement = await harness.manager.joinRoom(host.roomCode, {
    displayName: 'Replacement', characterId: 'nova',
  });
  assert.notEqual(replacement.participantId, guest.participantId);
});

test('room metadata, capacity, and list status use each room human-seat limit', async () => {
  const harness = createHarness();
  const host = await harness.manager.createRoom({
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

  await harness.manager.joinRoom(host.roomCode, { displayName: 'Host', characterId: 'nova' });
  state = harness.manager.getRoomState(host.roomCode);
  assert.equal(state.members.length, 2);
  assert.equal(harness.manager.listRooms()[0].status, 'full');
  assert.equal(harness.manager.listRooms()[0].joinable, false);
  await assert.rejects(
    harness.manager.joinRoom(host.roomCode, { displayName: 'Third', characterId: 'kit' }),
    (error) => error.code === ERROR_CODES.ROOM_FULL,
  );
});

test('multiplayer room creation and track changes accept Metropolis Highway', async () => {
  const harness = createHarness();
  const host = await harness.manager.createRoom({
    displayName: 'Host', characterId: 'pip', roomName: 'City Sprint',
    roomType: ROOM_TYPES.PUBLIC, maxPlayers: 8, trackId: 'metropolis-highway',
  });

  assert.equal(
    harness.manager.getRoomState(host.roomCode).settings.trackId,
    'metropolis-highway',
  );

  harness.manager.setRoom(host.participantId, { trackId: 'sunset-circuit' });
  harness.manager.setRoom(host.participantId, { trackId: 'metropolis-highway' });

  assert.equal(
    harness.manager.getRoomState(host.roomCode).settings.trackId,
    'metropolis-highway',
  );
});

test('private rooms hash case-sensitive passwords and expose no verifier data', async () => {
  const harness = createHarness();
  const host = await harness.manager.createRoom({
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
  await assert.rejects(
    harness.manager.joinRoom(host.roomCode, { displayName: 'Guest', characterId: 'nova' }),
    (error) => error.code === ERROR_CODES.PASSWORD_REQUIRED,
  );
  await assert.rejects(
    harness.manager.joinRoom(host.roomCode, {
      displayName: 'Guest', characterId: 'nova', password: 'pitlane9',
    }),
    (error) => error.code === ERROR_CODES.PASSWORD_INVALID,
  );
  const guest = await harness.manager.joinRoom(host.roomCode, {
    displayName: 'Host', characterId: 'nova', password: 'PitLane9',
  });
  assert.notEqual(guest.participantId, host.participantId);
  assert.equal(harness.manager.listRooms()[0].requiresPassword, true);
});

test('quick match atomically joins only a visible joinable public room', async () => {
  const codes = ['ABC234', 'DEF567'];
  const harness = createHarness({ roomCodeFactory: () => codes.shift() });
  await harness.manager.createRoom({
    displayName: 'Private Host', characterId: 'pip', roomName: 'Private',
    roomType: ROOM_TYPES.PRIVATE, maxPlayers: 4, password: 'Secret99',
  });
  await assert.rejects(
    harness.manager.quickMatch({ displayName: 'Guest' }),
    (error) => error.code === ERROR_CODES.NO_MATCHING_ROOM,
  );

  const publicHost = await harness.manager.createRoom({
    displayName: 'Public Host', characterId: 'nova', roomName: 'Public',
    roomType: ROOM_TYPES.PUBLIC, maxPlayers: 2,
  });
  const matched = await harness.manager.quickMatch({ displayName: 'Public Host' });
  assert.equal(matched.roomCode, publicHost.roomCode);
  assert.equal(harness.manager.listRooms().find((room) => room.roomCode === publicHost.roomCode).status, 'full');
  await assert.rejects(
    harness.manager.quickMatch({ displayName: 'Another Guest' }),
    (error) => error.code === ERROR_CODES.NO_MATCHING_ROOM,
  );
});

test('quick match prefers the joinable public room with the most players', async () => {
  const codes = ['ABC234', 'DEF567'];
  const harness = createHarness({
    roomCodeFactory: () => codes.shift(),
    random: () => 0,
  });
  const sparseRoom = await harness.manager.createRoom({
    displayName: 'Sparse Host', characterId: 'pip', roomName: 'Sparse Room',
    roomType: ROOM_TYPES.PUBLIC, maxPlayers: 4,
  });
  const busyRoom = await harness.manager.createRoom({
    displayName: 'Busy Host', characterId: 'nova', roomName: 'Busy Room',
    roomType: ROOM_TYPES.PUBLIC, maxPlayers: 4,
  });
  await harness.manager.joinRoom(busyRoom.roomCode, {
    displayName: 'Busy Guest', characterId: 'kit',
  });

  const matched = await harness.manager.quickMatch({ displayName: 'Quick Guest' });

  assert.equal(matched.roomCode, busyRoom.roomCode);
  assert.equal(harness.manager.getRoomState(sparseRoom.roomCode).members.length, 1);
  assert.equal(harness.manager.getRoomState(busyRoom.roomCode).members.length, 3);
});

test('room list counts reserved reconnect seats and hides rooms with no online member', async () => {
  const harness = createHarness();
  const { host, guest } = await addTwoPlayers(harness);
  harness.manager.disconnect(guest.participantId);
  assert.equal(harness.manager.listRooms()[0].playerCount, 2);
  assert.equal(harness.manager.listRooms()[0].hostDisplayName, 'Host');
  harness.manager.disconnect(host.participantId);
  assert.deepEqual(harness.manager.listRooms(), []);
});

test('connected waiting rooms remain available without an inactivity timeout', async () => {
  const harness = createHarness({ emptyRoomTtlMs: 60_000 });
  const host = await harness.manager.createRoom({
    displayName: 'Host', characterId: 'pip', roomName: 'Long Wait',
    roomType: ROOM_TYPES.PUBLIC, maxPlayers: 8,
  });

  harness.advance(24 * 60 * 60_000);
  harness.manager.maintenance();

  assert.equal(harness.manager.roomCount, 1);
  assert.equal(harness.manager.getRoomState(host.roomCode).members.length, 1);
  assert.equal(harness.manager.listRooms()[0].roomCode, host.roomCode);
});

test('a disconnected waiting room honors the full empty-room TTL', async () => {
  const harness = createHarness({ resumeTimeoutMs: 30_000, emptyRoomTtlMs: 60_000 });
  const destroyed = [];
  harness.manager.on('roomDestroyed', (event) => destroyed.push(event));
  const host = await harness.manager.createRoom({
    displayName: 'Host', characterId: 'pip', roomName: 'Reconnect Window',
    roomType: ROOM_TYPES.PUBLIC, maxPlayers: 8,
  });
  harness.manager.disconnect(host.participantId);

  harness.advance(30_001);
  harness.manager.maintenance();
  assert.equal(harness.manager.roomCount, 1);
  assert.equal(harness.manager.rooms.get(host.roomCode).members.size, 0);
  assert.deepEqual(harness.manager.listRooms(), []);

  harness.advance(29_998);
  harness.manager.maintenance();
  assert.equal(harness.manager.roomCount, 1);

  harness.advance(1);
  harness.manager.maintenance();
  assert.equal(harness.manager.roomCount, 0);
  assert.deepEqual(destroyed, [{ roomCode: host.roomCode }]);
});

test('an explicitly emptied waiting room also honors the full empty-room TTL', async () => {
  const harness = createHarness({ emptyRoomTtlMs: 60_000 });
  const host = await harness.manager.createRoom({
    displayName: 'Host', characterId: 'pip', roomName: 'Empty Room',
    roomType: ROOM_TYPES.PUBLIC, maxPlayers: 8,
  });
  harness.manager.leave(host.participantId);

  assert.equal(harness.manager.roomCount, 1);
  assert.deepEqual(harness.manager.listRooms(), []);

  harness.advance(59_999);
  harness.manager.maintenance();
  assert.equal(harness.manager.roomCount, 1);

  harness.advance(1);
  harness.manager.maintenance();
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
  assert.deepEqual(
    prepare.roster
      .filter((entry) => entry.controllerKind === 'ai')
      .sort((a, b) => a.aiPlayerNumber - b.aiPlayerNumber)
      .map(({ displayName, aiPlayerNumber }) => ({ displayName, aiPlayerNumber })),
    Array.from({ length: 6 }, (_, index) => ({
      displayName: `AI player ${index + 1}`,
      aiPlayerNumber: index + 1,
    })),
  );
  assert.equal(new Set(prepare.roster.map((entry) => entry.characterId)).size, 6);
  assert.equal(prepare.roster.some((entry) => ['tundra', 'gearbox'].includes(entry.characterId)), false);
  for (const characterId of new Set(prepare.roster.map((entry) => entry.characterId))) {
    const repeated = prepare.roster.filter((entry) => entry.characterId === characterId);
    const looks = repeated.map((entry) => `${entry.paintId}:${entry.avatarId}`);
    assert.equal(new Set(looks).size, looks.length,
      `${characterId} duplicates should have distinct appearances`);
  }
  assert.deepEqual(
    prepare.roster,
    simulation.args.roster.map(({ userId: _userId, ...entry }) => entry),
  );
  assert.equal(prepare.roster.some((entry) => Object.hasOwn(entry, 'userId')), false);
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
  const { host, guest } = await addTwoPlayers(harness);
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

test('ready, loadout, and ordinary race-loaded changes do not change the Lobby summary', async () => {
  const harness = createHarness();
  const lobbyChanges = [];
  harness.manager.on('lobbyChanged', event => lobbyChanges.push(event));
  const { host, guest } = await addTwoPlayers(harness);
  lobbyChanges.length = 0;

  harness.manager.setReady(host.participantId, true);
  harness.manager.setLoadout(guest.participantId, { paintId: 'crimson-heat' });
  assert.equal(lobbyChanges.length, 0);

  harness.manager.setReady(guest.participantId, true);
  const race = harness.manager.startRace(host.participantId);
  assert.equal(lobbyChanges.length, 1);
  lobbyChanges.length = 0;
  await harness.manager.markRaceLoaded(host.participantId, race.raceId);
  assert.equal(lobbyChanges.length, 0);
});

test('new useItemSeq survives a stale movement seq and fires for exactly one physics step', async () => {
  const harness = createHarness();
  const { host, race } = await startTwoPlayerRace(harness);
  const base = {
    wireRaceId: race.wireRaceId,
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
  const decoded = decodeSnapshotPacket(snapshot.binaryData);
  const hostAck = decoded.acks.find((entry) => entry[0] === hostIndex);
  assert.deepEqual(hostAck, [hostIndex, 2, 1]);
  assert.equal(Object.hasOwn(decoded, 'ack'), false);
  assert.equal(Object.hasOwn(decoded, 'inputAck'), false);
  assert.equal(Object.hasOwn(decoded, 'useItemAck'), false);
});

test('one public binary snapshot is built per room tick for every connected client', async () => {
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
  const decoded = decodeSnapshotPacket(snapshots[0].message.binaryData);
  assert.equal(decoded.karts.length, 8);
  assert.equal(Array.isArray(decoded.karts[0]), false);
  assert.equal(Object.hasOwn(decoded, 'standings'), false);
});

test('authoritative simulation continues but periodic snapshots are skipped without receivers', async () => {
  const counters = new Map();
  const metrics = {
    increment(group, name, amount = 1) {
      const key = `${group}.${name}`;
      counters.set(key, (counters.get(key) ?? 0) + amount);
    },
  };
  const harness = createHarness({ metrics });
  const { host } = await startTwoPlayerRace(harness);
  harness.manager.setRoomReceiverCountProvider(() => 0);
  const before = harness.messages.length;
  harness.advance(51);
  await harness.manager.tick();

  assert.equal(harness.simulations[0].updates.length > 0, true);
  assert.equal(
    harness.messages.slice(before).some(event => event.message.type === 'snapshot'),
    false,
  );
  assert.equal(counters.get('snapshot.noReceiversSkipped'), 1);
  assert.equal(
    harness.manager.getCatchUpMessages(host.participantId).some(message => message.type === 'snapshot'),
    true,
  );
});

test('one room simulation error is isolated without starving another active room', async () => {
  let now = 0;
  let participant = 0;
  const codes = ['BAD234', 'GOOD23'];
  const simulations = new Map();
  const errors = [];
  const manager = new RoomManager({
    now: () => now,
    roomCodeFactory: () => codes.shift(),
    participantIdFactory: () => `participant_${String(++participant).padStart(3, '0')}`,
    resumeTokenFactory: () => `resume_${participant}`,
    raceIdFactory: () => `race_${participant}`,
    raceFactory: async (args) => {
      const simulation = new FakeSimulation(args);
      const badRoom = args.roster.some(entry => entry.displayName === 'Bad Host');
      if (badRoom) {
        simulation.update = () => { throw new Error('bad room simulation'); };
      }
      simulations.set(badRoom ? 'bad' : 'good', simulation);
      return simulation;
    },
  });
  manager.on('managerError', error => errors.push(error));

  async function startRoom(hostName, guestName) {
    const host = await manager.createRoom({
      displayName: hostName, roomName: hostName, roomType: 'public', maxPlayers: 2,
    });
    const guest = await manager.joinRoom(host.roomCode, { displayName: guestName });
    manager.setReady(host.participantId, true);
    manager.setReady(guest.participantId, true);
    const race = manager.startRace(host.participantId);
    await manager.markRaceLoaded(host.participantId, race.raceId);
    await manager.markRaceLoaded(guest.participantId, race.raceId);
    return host;
  }

  const bad = await startRoom('Bad Host', 'Bad Guest');
  const good = await startRoom('Good Host', 'Good Guest');
  now = 20;
  const result = manager.tick();
  assert.equal(manager.getRoomState(bad.roomCode).state, ROOM_STATES.WAITING);
  assert.equal(manager.getRoomState(good.roomCode).state, ROOM_STATES.COUNTDOWN);
  assert.equal(simulations.get('good').updates.length, 2);
  assert.equal(result.roomErrors, 1);
  assert.equal(errors.length, 1);
  manager.close();
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

test('production eight-kart binary snapshot stays below 1536 bytes without static roster data', async () => {
  const harness = createHarness({ raceFactory: createDefaultRaceFactory() });
  const { host } = await startTwoPlayerRace(harness);
  harness.advance(51);
  await harness.manager.tick();
  const snapshot = harness.messages.find((event) => (
    event.roomCode === host.roomCode && event.message.type === 'snapshot'
  ))?.message;
  const bytes = snapshot.binaryData.byteLength;
  const decoded = decodeSnapshotPacket(snapshot.binaryData);

  assert.ok(bytes <= 1_536, `expected <= 1536 bytes, received ${bytes}`);
  assert.equal(decoded.karts.length, 8);
  assert.equal(decoded.acks.length, 2);
  assert.equal(Object.hasOwn(decoded, 'standings'), false);
  assert.equal(decoded.karts.every((kart) => !Array.isArray(kart)), true);
  assert.equal(decoded.itemBoxes.every((box) => (
    Array.isArray(box) && box.length === 2
  )), true);
  const wire = JSON.stringify(decoded);
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
  assert.equal(simulation.karts[hostIndex].name, 'Host');

  harness.advance(29_000);
  const resumed = harness.manager.resume(host.roomCode, host.participantId, host.resumeToken);
  assert.equal(resumed.resumed, true);
  assert.deepEqual(
    resumed.messages.map((message) => message.type),
    ['room_state', 'prepare_race', 'race_loaded_ack', 'snapshot'],
  );
  assert.equal(simulation.controllers[hostIndex], 'takeover-ai');
  harness.manager.handleInput(host.participantId, {
    wireRaceId: race.wireRaceId,
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

test('a reconnect before the deadline settles normally and emits private progression', async () => {
  const settlements = [];
  const harness = createHarness({ userStore: progressionStore(settlements) });
  const { host, guest, race } = await startTwoPlayerRace(harness);
  const simulation = harness.simulations[0];
  const hostKart = simulation.karts[race.roster.find(
    (entry) => entry.participantId === host.participantId,
  ).kartIndex];
  const guestKart = simulation.karts[race.roster.find(
    (entry) => entry.participantId === guest.participantId,
  ).kartIndex];
  hostKart.rank = 1;
  hostKart.finished = true;
  hostKart.finishTime = 90;
  guestKart.rank = 2;
  guestKart.finished = true;
  guestKart.finishTime = 95;

  harness.manager.disconnect(guest.participantId);
  harness.advance(10_000);
  harness.manager.resume(guest.roomCode, guest.participantId, guest.resumeToken);
  await finishHarnessRace(harness);

  assert.equal(settlements.length, 1);
  assert.equal(
    settlements[0].participants.find((entry) => entry.participantId === guest.participantId).escaped,
    false,
  );
  assert.equal(
    harness.messages.some((event) => event.participantId === guest.participantId
      && event.message.type === 'user_progression'
      && event.message.status === 'ok'),
    true,
  );
});

test('a natural finisher can leave before shared results without being marked escaped', async () => {
  const settlements = [];
  const harness = createHarness({ userStore: progressionStore(settlements) });
  const { guest, race } = await startTwoPlayerRace(harness);
  const guestKart = harness.simulations[0].karts[race.roster.find(
    (entry) => entry.participantId === guest.participantId,
  ).kartIndex];
  guestKart.rank = 1;
  guestKart.finished = true;
  guestKart.autoPlaced = false;
  guestKart.finishTime = 90;

  harness.manager.leave(guest.participantId);
  await finishHarnessRace(harness);

  const participant = settlements[0].participants.find(
    (entry) => entry.participantId === guest.participantId,
  );
  assert.equal(participant.completed, true);
  assert.equal(participant.finishTimeMs, 90_000);
  assert.equal(participant.escaped, false);
});

test('disconnecting after a natural finish settles normally without waiting for reconnect', async () => {
  const settlements = [];
  const harness = createHarness({ userStore: progressionStore(settlements) });
  const { guest, race } = await startTwoPlayerRace(harness);
  const guestKart = harness.simulations[0].karts[race.roster.find(
    (entry) => entry.participantId === guest.participantId,
  ).kartIndex];
  guestKart.rank = 2;
  guestKart.finished = true;
  guestKart.autoPlaced = false;
  guestKart.finishTime = 95;

  harness.manager.disconnect(guest.participantId);
  await finishHarnessRace(harness);

  assert.equal(settlements.length, 1);
  assert.equal(
    settlements[0].participants.find((entry) => entry.participantId === guest.participantId).escaped,
    false,
  );
});

test('results wait for a disconnected racer and expiry settles them as escaped', async () => {
  const settlements = [];
  const harness = createHarness({ userStore: progressionStore(settlements) });
  const { host, guest, race } = await startTwoPlayerRace(harness);
  harness.manager.disconnect(guest.participantId);
  const guestKart = harness.simulations[0].karts[race.roster.find(
    (entry) => entry.participantId === guest.participantId,
  ).kartIndex];
  guestKart.finished = true;
  guestKart.autoPlaced = false;
  guestKart.finishTime = 95;

  await finishHarnessRace(harness);
  assert.equal(settlements.length, 0);
  const results = harness.messages.find((event) => event.message.type === 'race_results')?.message;
  assert.equal(results.progressionPending, true);

  harness.advance(30_001);
  harness.manager.maintenance();
  assert.equal(settlements.length, 1);
  assert.equal(
    settlements[0].participants.find((entry) => entry.participantId === guest.participantId).escaped,
    true,
  );
  assert.equal(
    harness.messages.some((event) => event.participantId === host.participantId
      && event.message.type === 'user_progression'
      && event.message.status === 'ok'),
    true,
  );
});

test('a post-result reconnect defers private progression until the resumed socket can bind', async () => {
  const settlements = [];
  const harness = createHarness({ userStore: progressionStore(settlements) });
  const { guest } = await startTwoPlayerRace(harness);
  harness.manager.disconnect(guest.participantId);
  await finishHarnessRace(harness);
  assert.equal(settlements.length, 0);

  const mark = harness.messages.length;
  harness.manager.resume(guest.roomCode, guest.participantId, guest.resumeToken);
  assert.equal(
    harness.messages.slice(mark).some((event) => event.message.type === 'user_progression'),
    false,
  );

  await Promise.resolve();
  assert.equal(settlements.length, 1);
  assert.equal(
    harness.messages.slice(mark).some((event) => event.participantId === guest.participantId
      && event.message.type === 'user_progression'
      && event.message.status === 'ok'),
    true,
  );
});

test('leaving while post-race settlement is waiting resolves the escape immediately', async () => {
  const settlements = [];
  const harness = createHarness({ userStore: progressionStore(settlements) });
  const { guest } = await startTwoPlayerRace(harness);
  harness.manager.disconnect(guest.participantId);
  await finishHarnessRace(harness);
  assert.equal(settlements.length, 0);

  harness.manager.leave(guest.participantId);
  assert.equal(settlements.length, 1);
  assert.equal(
    settlements[0].participants.find((entry) => entry.participantId === guest.participantId).escaped,
    true,
  );
});

test('explicit race leave releases the user immediately and settles when every racer leaves', async () => {
  const settlements = [];
  const roomCodes = ['ABC234', 'DEF567'];
  const userStore = progressionStore(settlements);
  userStore.startRace = () => 2;
  const harness = createHarness({
    roomCodeFactory: () => roomCodes.shift(),
    userStore,
  });
  const host = await harness.manager.createRoom({
    userId: 'user-host', displayName: 'Host', characterId: 'pip',
    roomName: 'Original Room', roomType: ROOM_TYPES.PUBLIC, maxPlayers: 2,
  });
  const guest = await harness.manager.joinRoom(host.roomCode, {
    userId: 'user-guest', displayName: 'Guest', characterId: 'nova',
  });
  harness.manager.setReady(host.participantId, true);
  harness.manager.setReady(guest.participantId, true);
  const race = harness.manager.startRace(host.participantId);
  await harness.manager.markRaceLoaded(host.participantId, race.raceId);
  await harness.manager.markRaceLoaded(guest.participantId, race.raceId);

  harness.manager.leave(host.participantId);
  assert.equal(harness.manager.userParticipants.has('user-host'), false);

  const replacement = await harness.manager.createRoom({
    userId: 'user-host', displayName: 'Host', characterId: 'pip',
    roomName: 'Replacement Room', roomType: ROOM_TYPES.PUBLIC, maxPlayers: 2,
  });
  assert.equal(harness.manager.rooms.has(host.roomCode), true);
  assert.equal(harness.manager.userParticipants.get('user-host'), replacement.participantId);

  harness.manager.leave(guest.participantId);

  assert.equal(harness.manager.rooms.has(host.roomCode), false);
  assert.equal(harness.manager.rooms.has(replacement.roomCode), true);
  assert.equal(harness.manager.userParticipants.get('user-host'), replacement.participantId);
  assert.equal(harness.manager.userParticipants.has('user-guest'), false);
  assert.equal(settlements.length, 1);
  assert.deepEqual(
    settlements[0].participants
      .map(({ userId, escaped }) => ({ userId, escaped }))
      .sort((a, b) => a.userId.localeCompare(b.userId)),
    [
      { userId: 'user-guest', escaped: true },
      { userId: 'user-host', escaped: true },
    ],
  );
});

test('empty active race settles expired disconnects before room destruction', async () => {
  const settlements = [];
  const userStore = progressionStore(settlements);
  userStore.startRace = () => 2;
  const harness = createHarness({
    userStore,
    resumeTimeoutMs: 30_000,
    emptyRoomTtlMs: 60_000,
  });
  const host = await harness.manager.createRoom({
    userId: 'user-host', displayName: 'Host', characterId: 'pip',
    roomName: 'Disconnect Room', roomType: ROOM_TYPES.PUBLIC, maxPlayers: 2,
  });
  const guest = await harness.manager.joinRoom(host.roomCode, {
    userId: 'user-guest', displayName: 'Guest', characterId: 'nova',
  });
  harness.manager.setReady(host.participantId, true);
  harness.manager.setReady(guest.participantId, true);
  const race = harness.manager.startRace(host.participantId);
  await harness.manager.markRaceLoaded(host.participantId, race.raceId);
  await harness.manager.markRaceLoaded(guest.participantId, race.raceId);
  harness.manager.disconnect(host.participantId);
  harness.manager.disconnect(guest.participantId);

  harness.advance(60_000);
  harness.manager.maintenance();

  assert.equal(harness.manager.rooms.has(host.roomCode), false);
  assert.equal(harness.manager.userParticipants.size, 0);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].participants.every((participant) => participant.escaped), true);
});

test('auto-placed racers are public DNF entries and cannot set natural finish records', async () => {
  const settlements = [];
  const harness = createHarness({ userStore: progressionStore(settlements) });
  const { guest, race } = await startTwoPlayerRace(harness);
  const simulation = harness.simulations[0];
  const guestKart = simulation.karts[race.roster.find(
    (entry) => entry.participantId === guest.participantId,
  ).kartIndex];
  guestKart.rank = 2;
  guestKart.finished = true;
  guestKart.autoPlaced = true;
  guestKart.finishTime = 123.45;

  await finishHarnessRace(harness);
  const result = harness.messages.find((event) => event.message.type === 'race_results')
    ?.message.results.find((entry) => entry.participantId === guest.participantId);
  assert.equal(result.completed, false);
  assert.equal(result.finishTime, null);
  const participant = settlements[0].participants.find(
    (entry) => entry.participantId === guest.participantId,
  );
  assert.equal(participant.completed, false);
  assert.equal(participant.finishTimeMs, null);
  assert.equal(participant.escaped, false);
});

test('a transient database settlement failure retries and eventually sends progression success', async () => {
  let attempts = 0;
  const settlements = [];
  const harness = createHarness({
    settlementRetryDelaysMs: [100],
    userStore: {
      settleRace(settlement) {
        attempts++;
        if (attempts === 1) throw new Error('database unavailable');
        settlements.push(structuredClone(settlement));
        return new Map(settlement.participants.map((participant) => [participant.userId, {
          xpDelta: 20,
          ratingDelta: 0,
          levelBefore: 1,
          levelAfter: 1,
          bestTimeUpdated: false,
          profile: null,
        }]));
      },
    },
  });
  const { host, guest } = await startTwoPlayerRace(harness);
  await finishHarnessRace(harness);

  assert.equal(attempts, 1);
  assert.equal(settlements.length, 0);
  assert.equal(harness.manager.pendingSettlements.size, 1);
  assert.equal(
    harness.messages.some((event) => event.message.type === 'user_progression'),
    false,
  );

  harness.advance(100);
  harness.manager.maintenance();
  assert.equal(attempts, 2);
  assert.equal(settlements.length, 1);
  assert.equal(harness.manager.pendingSettlements.size, 0);
  for (const participantId of [host.participantId, guest.participantId]) {
    assert.equal(
      harness.messages.some((event) => event.participantId === participantId
        && event.message.type === 'user_progression'
        && event.message.status === 'ok'),
      true,
    );
  }
});

test('repeated database settlement failures stop after the configured retries', async () => {
  let attempts = 0;
  const harness = createHarness({
    settlementRetryDelaysMs: [100, 200],
    userStore: {
      settleRace() {
        attempts++;
        throw new Error('database unavailable');
      },
    },
  });
  const { host, guest } = await startTwoPlayerRace(harness);
  await finishHarnessRace(harness);

  assert.equal(
    harness.messages.some((event) => event.message.type === 'race_results'),
    true,
  );
  assert.equal(attempts, 1);
  harness.advance(100);
  harness.manager.maintenance();
  assert.equal(attempts, 2);
  harness.advance(200);
  harness.manager.maintenance();
  assert.equal(attempts, 3);
  assert.equal(harness.manager.pendingSettlements.size, 0);
  assert.equal(harness.managerErrors.length, 3);
  for (const participantId of [host.participantId, guest.participantId]) {
    assert.equal(
      harness.messages.some((event) => event.participantId === participantId
        && event.message.type === 'user_progression'
        && event.message.status === 'error'),
      true,
    );
  }
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
    wireRaceId: race.wireRaceId,
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

  harness.manager.leave(host.participantId);
  state = harness.manager.getRoomState(host.roomCode);
  assert.equal(
    state.members.find((member) => member.participantId === host.participantId).presenceState,
    'left',
  );

  harness.manager.disconnect(guest.participantId);
  harness.advance(30_001);
  harness.manager.maintenance();
  state = harness.manager.getRoomState(host.roomCode);
  assert.equal(
    state.members.find((member) => member.participantId === guest.participantId).presenceState,
    'disconnected',
  );
});

test('item-only traffic cannot reclaim takeover AI or queue a delayed item use', async () => {
  const harness = createHarness();
  const { host, race } = await startTwoPlayerRace(harness);
  const simulation = harness.simulations[0];
  const hostIndex = race.roster.find((entry) => entry.participantId === host.participantId).kartIndex;
  const input = {
    wireRaceId: race.wireRaceId,
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

test('a sole player reclaiming an empty room becomes its host again', async () => {
  const harness = createHarness();
  const host = await harness.manager.createRoom({
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
  const { host, guest } = await addTwoPlayers(harness);
  harness.manager.setReady(host.participantId, true);
  harness.manager.setReady(guest.participantId, true);
  const race = harness.manager.startRace(host.participantId);
  await harness.manager.markRaceLoaded(host.participantId, race.raceId);

  harness.advance(10_001);
  harness.manager.maintenance();
  await race.launchPromise;
  const roomState = harness.manager.getRoomState(host.roomCode);
  assert.equal(roomState.state, ROOM_STATES.WAITING);
  assert.equal(harness.simulations.length, 0);
  assert.deepEqual(roomState.members.map((member) => member.ready), [false, false]);
  assert.deepEqual(roomState.members.map((member) => member.controllerKind), ['human', 'human']);
  assert.deepEqual(harness.managerErrors, []);
});

test('race participation is recorded only after loading successfully reaches countdown', async () => {
  const starts = [];
  const userStore = {
    startRace(race) { starts.push(structuredClone(race)); },
    settleRace() { return new Map(); },
  };
  const cancelled = createHarness({ userStore, loadTimeoutMs: 10 });
  const cancelledPlayers = await addTwoPlayers(cancelled);
  cancelled.manager.setReady(cancelledPlayers.host.participantId, true);
  cancelled.manager.setReady(cancelledPlayers.guest.participantId, true);
  const cancelledRace = cancelled.manager.startRace(cancelledPlayers.host.participantId);
  await cancelled.manager.markRaceLoaded(cancelledPlayers.host.participantId, cancelledRace.raceId);
  cancelled.advance(11);
  cancelled.manager.maintenance();
  await cancelled.manager.rooms.get(cancelledPlayers.host.roomCode)?.race?.launchPromise;
  assert.equal(starts.length, 0);

  const started = createHarness({ userStore });
  await startTwoPlayerRace(started);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].participants.length, 2);
});

test('two loaded players start at timeout while a late third player keeps AI until fresh movement', async () => {
  const harness = createHarness({ loadTimeoutMs: 10_000 });
  const { host, guest } = await addTwoPlayers(harness);
  const late = await harness.manager.joinRoom(host.roomCode, {
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
  harness.manager.maintenance();
  await race.launchPromise;
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
    wireRaceId: race.wireRaceId,
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
  const { host, guest } = await addTwoPlayers(harness);
  harness.manager.setReady(host.participantId, true);
  harness.manager.setReady(guest.participantId, true);
  const race = harness.manager.startRace(host.participantId);
  await harness.manager.markRaceLoaded(host.participantId, race.raceId);
  harness.manager.disconnect(host.participantId);
  await harness.manager.markRaceLoaded(guest.participantId, race.raceId);
  assert.equal(harness.manager.getRoomState(host.roomCode).state, ROOM_STATES.LOADING);

  harness.advance(10_001);
  harness.manager.maintenance();
  await race.launchPromise;
  const state = harness.manager.getRoomState(host.roomCode);
  assert.equal(state.state, ROOM_STATES.WAITING);
  assert.equal(state.members.length, 2);
  assert.equal(harness.manager.listRooms()[0].playerCount, 2);
  assert.deepEqual(harness.managerErrors, []);
});

test('loading cancellation removes an abandoned member and releases their character', async () => {
  const harness = createHarness({ loadTimeoutMs: 10_000 });
  const { host, guest } = await addTwoPlayers(harness);
  harness.manager.setReady(host.participantId, true);
  harness.manager.setReady(guest.participantId, true);
  const race = harness.manager.startRace(host.participantId);
  await harness.manager.markRaceLoaded(host.participantId, race.raceId);
  harness.manager.leave(guest.participantId);

  harness.advance(10_001);
  harness.manager.maintenance();
  await race.launchPromise;
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
  const { host, guest } = await addTwoPlayers(harness);
  const leaver = await harness.manager.joinRoom(host.roomCode, {
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
  harness.manager.maintenance();

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
  const { host, guest } = await addTwoPlayers(harness);
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
    wireRaceId: race.wireRaceId,
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
    () => harness.manager.handleInput(host.participantId, { ...input, wireRaceId: race.wireRaceId + 1 }),
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
  harness.manager.maintenance();
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
  harness.manager.maintenance();
  const state = harness.manager.getRoomState(host.roomCode);
  assert.deepEqual(state.members.map((member) => member.participantId), [host.participantId]);
  assert.equal(harness.manager.listRooms()[0].playerCount, 1);
  assert.equal(harness.manager.participantRooms.has(guest.participantId), false);
  assert.throws(
    () => harness.manager.resume(host.roomCode, guest.participantId, guest.resumeToken),
    (error) => error.code === ERROR_CODES.SESSION_NOT_FOUND,
  );
});
