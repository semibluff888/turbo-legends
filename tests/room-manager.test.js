import test from 'node:test';
import assert from 'node:assert/strict';

import { ERROR_CODES, ROOM_STATES } from '../src/net/protocol.js';
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
  manager.on('managerError', () => {});
  return {
    manager,
    simulations,
    messages,
    now: () => now,
    advance(ms) { now += ms; },
  };
}

function addTwoPlayers(harness) {
  const host = harness.manager.createRoom({ displayName: 'Host', characterId: 'pip' });
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

test('room lobby enforces host settings, unique names/characters, and ready resets', () => {
  const harness = createHarness();
  const { host, guest } = addTwoPlayers(harness);

  assert.throws(
    () => harness.manager.joinRoom(host.roomCode, { displayName: 'host', characterId: 'kit' }),
    (error) => error instanceof GameError && error.code === ERROR_CODES.NAME_TAKEN,
  );
  assert.throws(
    () => harness.manager.selectCharacter(guest.participantId, 'pip'),
    (error) => error.code === ERROR_CODES.CHARACTER_TAKEN,
  );
  assert.throws(
    () => harness.manager.setRoom(guest.participantId, { difficulty: 'hard' }),
    (error) => error.code === ERROR_CODES.FORBIDDEN,
  );

  harness.manager.setReady(host.participantId, true);
  harness.manager.setReady(guest.participantId, true);
  assert.equal(harness.manager.getRoomState(host.roomCode).canStart, true);
  harness.manager.setRoom(host.participantId, { difficulty: 'hard' });
  assert.deepEqual(
    harness.manager.getRoomState(host.roomCode).members.map((member) => member.ready),
    [false, false],
  );
});

test('start prepares one deterministic eight-kart roster and launches after all clients load', async () => {
  const harness = createHarness();
  const { host, race } = await startTwoPlayerRace(harness);
  const simulation = harness.simulations[0];
  const prepare = harness.messages
    .map((event) => event.message)
    .find((message) => message.type === 'prepare_race');

  assert.equal(harness.manager.getRoomState(host.roomCode).state, ROOM_STATES.COUNTDOWN);
  assert.equal(prepare.roster.length, 8);
  assert.equal(new Set(prepare.roster.map((entry) => entry.characterId)).size, 8);
  assert.deepEqual(prepare.roster, simulation.args.roster);
  assert.deepEqual(prepare.roster.map((entry) => entry.kartIndex), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(race.seed, 424242);
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
    event.participantId === host.participantId && event.message.type === 'snapshot'
  ))?.message;
  assert.equal(snapshot.ack, 2);
  assert.equal(snapshot.inputAck, 2);
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
  assert.equal(simulation.controllers[hostIndex], 'human');
  assert.equal(harness.manager.getRoomState(host.roomCode).hostParticipantId, guest.participantId);
});

test('a sole player reclaiming an empty room becomes its host again', () => {
  const harness = createHarness();
  const host = harness.manager.createRoom({ displayName: 'Host', characterId: 'pip' });
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
  assert.equal(roomState.state, ROOM_STATES.LOBBY);
  assert.equal(harness.simulations.length, 0);
  assert.deepEqual(roomState.members.map((member) => member.ready), [false, false]);
  assert.deepEqual(roomState.members.map((member) => member.controllerKind), ['human', 'human']);
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
  assert.equal(harness.manager.getRoomState(host.roomCode).state, ROOM_STATES.LOBBY);
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

  harness.manager.returnToLobby(host.participantId);
  const guest = harness.manager.getRoomState(host.roomCode).members
    .find((member) => member.participantId !== host.participantId);
  harness.manager.returnToLobby(guest.participantId);
  assert.equal(harness.manager.handleInput(host.participantId, input), false);
});

test('players return independently and can prepare while others remain in game', async () => {
  const harness = createHarness();
  const { host, guest } = await startTwoPlayerRace(harness);
  const room = harness.manager.rooms.get(host.roomCode);
  harness.manager._finishRace(room, harness.now());

  harness.manager.returnToLobby(host.participantId);
  let state = harness.manager.getRoomState(host.roomCode);
  assert.equal(state.state, ROOM_STATES.RESULTS);
  assert.equal(state.members.find((member) => member.participantId === host.participantId).activityState, 'lobby');
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

  harness.manager.returnToLobby(guest.participantId);
  state = harness.manager.getRoomState(host.roomCode);
  assert.equal(state.state, ROOM_STATES.LOBBY);
  assert.equal(state.settings.difficulty, 'hard');
  assert.equal(state.members.find((member) => member.participantId === host.participantId).characterId, 'kit');
  assert.equal(state.members.find((member) => member.participantId === host.participantId).ready, true);
  assert.equal(state.members.find((member) => member.participantId === guest.participantId).ready, false);
});
