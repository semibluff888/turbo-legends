import test from 'node:test';
import assert from 'node:assert/strict';

import { FIXED_DT, RACE_STATE } from '../src/core/constants.js';
import { OnlineRaceSession } from '../src/net/online-race-session.js';
import { encodeKartSnapshot } from '../src/net/protocol.js';
import { Track } from '../src/track/track.js';
import { getTrackDef } from '../src/track/tracks.js';

const INPUT_STEP = FIXED_DT * 2;

class FakeClient {
  constructor() {
    this.listeners = new Map();
    this.inputs = [];
    this.sendAllowed = true;
    this.ackedRaces = new Set();
  }
  on(type, listener) {
    this.listeners.set(type, listener);
    return () => this.listeners.delete(type);
  }
  emit(type, value) { this.listeners.get(type)?.(value); }
  hasRaceLoadedAck(raceId) { return this.ackedRaces.has(raceId); }
  ack(raceId, late = false) {
    this.ackedRaces.add(raceId);
    this.emit('race_loaded_ack', {
      type: 'race_loaded_ack', raceId, phase: late ? 'racing' : 'countdown', late,
    });
  }
  sendInput(input) {
    if (!this.sendAllowed) return false;
    this.inputs.push(input);
    return true;
  }
}

function roster() {
  return [
    {
      kartIndex: 0,
      participantId: 'local',
      displayName: 'Local',
      characterId: 'kit',
      paintId: 'turbo-blue',
      avatarId: 'cat',
      controllerKind: 'human',
      connected: true,
    },
    {
      kartIndex: 1,
      participantId: 'remote',
      displayName: 'Remote',
      characterId: 'kit',
      paintId: 'crimson-heat',
      avatarId: 'dog',
      controllerKind: 'human',
      connected: true,
    },
  ];
}

function snapshotKart(index, extra = {}) {
  const kart = {
    index,
    x: index * 2,
    y: 0,
    z: 10,
    yaw: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    speed: 0,
    state: 'normal',
    lap: 1,
    rank: index + 1,
    progress: 0,
    ...extra,
  };
  return encodeKartSnapshot(kart, kart.controllerKind || 'human');
}

function snapshotAcks(inputAck = 0, useItemAck = 0) {
  return [[0, inputAck, useItemAck], [1, -1, 0]];
}

test('online snapshot populates Kart-shaped state and item views', () => {
  const track = new Track(getTrackDef('sunset-circuit'));
  const client = new FakeClient();
  const session = new OnlineRaceSession({
    client,
    track,
    raceId: 'race-1',
    roster: roster(),
    localParticipantId: 'local',
  });
  const firstBox = track.itemBoxes[0];

  assert.equal(session.karts[0].character.id, 'kit');
  assert.equal(session.karts[1].character.id, 'kit');
  assert.equal(session.karts[0].paintId, 'turbo-blue');
  assert.equal(session.karts[1].paintId, 'crimson-heat');
  assert.equal(session.karts[1].avatarId, 'dog');

  assert.equal(session.applySnapshot({
    raceId: 'race-1',
    tick: 12,
    acks: snapshotAcks(),
    state: RACE_STATE.RACING,
    elapsed: 1.5,
    countdown: 0,
    laps: 3,
    karts: [
      snapshotKart(0, { x: 4, displayName: 'Local Driver' }),
      snapshotKart(1, { x: 7, displayName: 'Remote Driver' }),
    ],
    projectiles: [{ id: 1, kind: 'green_shell', x: 2, y: 0, z: 5 }],
    hazards: [{ id: 2, kind: 'banana', x: 3, y: 0, z: 6 }],
    itemBoxes: [[false, 9]],
  }), true);

  assert.equal(session.player.name, 'Local');
  assert.equal(session.player.isPlayer, true);
  assert.equal(session.karts[1].name, 'Remote');
  assert.equal(session.items.projectiles[0].id, 1);
  assert.equal(session.items.hazards[0].id, 2);
  assert.equal(firstBox.active, false);
  assert.equal(firstBox.respawnAt, 9);
});

test('room state updates live racer presence and cached state hydrates a resumed race', () => {
  const track = new Track(getTrackDef('sunset-circuit'));
  const client = new FakeClient();
  const session = new OnlineRaceSession({
    client,
    track,
    raceId: 'race-presence',
    roster: roster(),
    localParticipantId: 'local',
    roomState: {
      raceId: 'race-presence',
      members: [
        { participantId: 'local', connected: true, presenceState: 'connected', controllerKind: 'human' },
        { participantId: 'remote', connected: false, presenceState: 'left', controllerKind: 'takeover-ai' },
      ],
    },
  });
  const remote = session.karts.find((kart) => kart.participantId === 'remote');

  assert.equal(remote.presenceState, 'left');
  assert.equal(remote.connected, false);
  assert.equal(remote.controllerKind, 'takeover-ai');

  client.emit('room_state', {
    raceId: 'race-presence',
    members: [
      { participantId: 'remote', connected: false, presenceState: 'reconnecting', controllerKind: 'takeover-ai' },
    ],
  });
  assert.equal(remote.presenceState, 'reconnecting');

  client.emit('room_state', {
    raceId: 'another-race',
    members: [
      { participantId: 'remote', connected: false, presenceState: 'disconnected' },
    ],
  });
  assert.equal(remote.presenceState, 'reconnecting');

  client.emit('room_state', {
    raceId: 'race-presence',
    members: [
      { participantId: 'remote', connected: true, presenceState: 'connected', controllerKind: 'takeover-ai' },
    ],
  });
  assert.equal(remote.presenceState, 'connected');
  assert.equal(remote.controllerKind, 'takeover-ai');

  session.applySnapshot({
    raceId: 'race-presence',
    tick: 1,
    state: RACE_STATE.RACING,
    karts: [snapshotKart(0), snapshotKart(1, { controllerKind: 'human' })],
  });
  assert.equal(remote.presenceState, 'connected');
  assert.equal(remote.controllerKind, 'human');
});

test('announced roster is staged on the starting grid while clients finish loading', () => {
  const track = new Track(getTrackDef('sunset-circuit'));
  const session = new OnlineRaceSession({
    client: new FakeClient(),
    track,
    raceId: 'race-loading',
    roster: roster(),
    localParticipantId: 'local',
  });

  assert.equal(session.state, RACE_STATE.COUNTDOWN);
  assert.equal(session.countdown > 0, true);
  assert.equal(session.karts.every((kart) => kart.lap === 1), true);
  assert.equal(session.karts.every((kart) => Number.isFinite(kart.s)), true);
  assert.equal(session.karts.some((kart) => Math.hypot(kart.x, kart.z) > 1), true);
  assert.notDeepEqual(
    [session.karts[0].x, session.karts[0].z],
    [session.karts[1].x, session.karts[1].z],
  );
});

test('input is sampled at 60Hz and item presses use a monotonic action counter', () => {
  const track = new Track(getTrackDef('sunset-circuit'));
  const client = new FakeClient();
  const session = new OnlineRaceSession({
    client,
    track,
    raceId: 'race-2',
    roster: roster(),
    localParticipantId: 'local',
  });
  client.ack('race-2');
  session.applySnapshot({
    raceId: 'race-2',
    tick: 1,
    acks: snapshotAcks(),
    state: RACE_STATE.RACING,
    karts: [snapshotKart(0), snapshotKart(1)],
  });
  const controls = {
    throttle: 1, brake: 0, steer: 0.25,
    drift: false, useItem: true, lookBack: false,
  };
  session.update(FIXED_DT, controls);
  session.update(FIXED_DT, controls);
  session.flushInput(controls);
  assert.equal(client.inputs.length, 1);
  assert.equal(client.inputs[0].seq, 1);
  assert.equal(client.inputs[0].useItemSeq, 1);

  controls.useItem = false;
  session.update(FIXED_DT, controls);
  session.update(FIXED_DT, controls);
  session.flushInput(controls);
  controls.useItem = true;
  session.update(FIXED_DT, controls);
  session.update(FIXED_DT, controls);
  session.flushInput(controls);
  assert.equal(client.inputs.at(-1).useItemSeq, 2);
});

test('loading sessions send no input before a snapshot and can neutralize immediately', () => {
  const track = new Track(getTrackDef('sunset-circuit'));
  const client = new FakeClient();
  const session = new OnlineRaceSession({
    client,
    track,
    raceId: 'race-loading',
    roster: roster(),
    localParticipantId: 'local',
  });
  const controls = {
    throttle: 1, brake: 0, steer: 0.5,
    drift: true, useItem: false, lookBack: true,
  };

  session.update(FIXED_DT, controls);
  session.update(FIXED_DT, controls);
  assert.equal(session.hasSnapshot, false);
  assert.equal(client.inputs.length, 0);
  assert.equal(session.sendNeutralInput(), false);

  session.applySnapshot({
    raceId: 'race-loading',
    tick: 1,
    acks: snapshotAcks(),
    state: RACE_STATE.RACING,
    karts: [snapshotKart(0), snapshotKart(1)],
  });
  assert.equal(session.sendNeutralInput(), false);
  client.ack('race-loading');
  assert.equal(session.sendNeutralInput(), true);
  assert.deepEqual(client.inputs.at(-1), {
    seq: 1,
    useItemSeq: 0,
    throttle: 0,
    brake: 0,
    steer: 0,
    drift: false,
    lookBack: false,
  });
});

test('race events are deduplicated and world VFX drain once', () => {
  const track = new Track(getTrackDef('sunset-circuit'));
  const session = new OnlineRaceSession({
    client: new FakeClient(),
    track,
    raceId: 'race-3',
    roster: roster(),
    localParticipantId: 'local',
  });
  const message = {
    raceId: 'race-3',
    events: [{
      eventId: 10,
      kartIndex: 0,
      type: 'lap',
      data: { lap: 2, isFinal: false },
    }],
    vfx: [{ eventId: 11, type: 'explosion', x: 1, y: 2, z: 3 }],
  };
  session.applyEvents(message);
  session.applyEvents(message);

  assert.equal(session.player.events.length, 1);
  assert.deepEqual(session.player.events[0], {
    type: 'lap',
    lap: 2,
    isFinal: false,
  });
  assert.equal(session.items.drainVfx().length, 1);
  assert.equal(session.items.drainVfx().length, 0);
});

test('a finished local kart switches to snapshot interpolation and stops sending input', () => {
  const track = new Track(getTrackDef('sunset-circuit'));
  const client = new FakeClient();
  const session = new OnlineRaceSession({
    client,
    track,
    raceId: 'race-finished',
    roster: roster(),
    localParticipantId: 'local',
  });
  client.ack('race-finished');
  session.applySnapshot({
    raceId: 'race-finished',
    state: RACE_STATE.RACING,
    karts: [snapshotKart(0, { x: 0 }), snapshotKart(1)],
  });
  session.update(FIXED_DT, { throttle: 1 });
  session.update(FIXED_DT, { throttle: 1 });
  session.flushInput({ throttle: 1 });
  const sentBeforeFinish = client.inputs.length;

  session.applySnapshot({
    raceId: 'race-finished',
    state: RACE_STATE.RACING,
    karts: [snapshotKart(0, { x: 1, speed: 8, finished: true }), snapshotKart(1)],
  });
  assert.equal(session.player.x, 0);
  session.update(0.25, { throttle: 1 });
  assert.ok(session.player.x > 0 && session.player.x < 1);
  session.update(0.25, { throttle: 1 });
  assert.equal(session.player.x, 1);
  assert.equal(client.inputs.length, sentBeforeFinish);
});

test('congested sends do not advance input sequence and stale item presses expire', () => {
  const track = new Track(getTrackDef('sunset-circuit'));
  const client = new FakeClient();
  const session = new OnlineRaceSession({
    client, track, raceId: 'race-congested', roster: roster(), localParticipantId: 'local',
  });
  client.ack('race-congested');
  session.applySnapshot({
    raceId: 'race-congested', tick: 30, acks: snapshotAcks(40, 7),
    state: RACE_STATE.RACING,
    karts: [snapshotKart(0), snapshotKart(1)],
  });

  client.sendAllowed = false;
  session.update(INPUT_STEP, { throttle: 1, useItem: true });
  session.flushInput({ throttle: 1, useItem: true });
  session.update(0.3, { throttle: 0, useItem: false });
  session.flushInput({ throttle: 0, useItem: false });
  assert.equal(client.inputs.length, 0);

  client.sendAllowed = true;
  session.update(INPUT_STEP, { throttle: 0.25, useItem: false });
  session.flushInput({ throttle: 0.25, useItem: false });
  assert.deepEqual(client.inputs.at(-1), {
    seq: 41,
    useItemSeq: 7,
    throttle: 0.25,
    brake: 0,
    steer: 0,
    drift: false,
    lookBack: false,
  });
});

test('stale snapshots are ignored and large network gaps recover without an instant teleport', () => {
  const track = new Track(getTrackDef('sunset-circuit'));
  const session = new OnlineRaceSession({
    client: new FakeClient(), track, raceId: 'race-jitter', roster: roster(), localParticipantId: 'local',
  });
  session.applySnapshot({
    raceId: 'race-jitter', tick: 10, state: RACE_STATE.RACING,
    karts: [snapshotKart(0), snapshotKart(1, { x: 0, vx: 0 })],
  });
  assert.equal(session.karts[1].x, 0);
  assert.equal(session.applySnapshot({
    raceId: 'race-jitter', tick: 9, state: RACE_STATE.RACING,
    karts: [snapshotKart(0, { x: 999 }), snapshotKart(1, { x: 999 })],
  }), false);
  assert.equal(session.karts[1].x, 0);

  session.applySnapshot({
    raceId: 'race-jitter', tick: 40, state: RACE_STATE.RACING,
    karts: [snapshotKart(0), snapshotKart(1, { x: 30, vx: 0 })],
  });
  assert.equal(session.karts[1].x, 0);
  session.update(0.25, {});
  assert.ok(session.karts[1].x > 0 && session.karts[1].x < 30);
  session.update(0.25, {});
  assert.equal(session.karts[1].x, 30);
});

test('large local authority corrections are smoothed while respawns still snap', () => {
  const track = new Track(getTrackDef('sunset-circuit'));
  const session = new OnlineRaceSession({
    client: new FakeClient(), track, raceId: 'race-correction', roster: roster(), localParticipantId: 'local',
  });
  session.applySnapshot({
    raceId: 'race-correction', tick: 10, acks: snapshotAcks(), state: RACE_STATE.RACING,
    karts: [snapshotKart(0, { x: 0 }), snapshotKart(1)],
  });
  session.applySnapshot({
    raceId: 'race-correction', tick: 13, acks: snapshotAcks(), state: RACE_STATE.RACING,
    karts: [snapshotKart(0, { x: 10 }), snapshotKart(1)],
  });
  assert.equal(session.player.x, 0);
  session.update(0.25, {});
  assert.ok(session.player.x > 0 && session.player.x < 10);

  session.applySnapshot({
    raceId: 'race-correction', tick: 16, acks: snapshotAcks(), state: RACE_STATE.RACING,
    karts: [snapshotKart(0, { x: 50, state: 'respawning' }), snapshotKart(1)],
  });
  assert.equal(session.player.x, 50);
});

test('disconnect pauses prediction and the next sent sequence continues from snapshot acknowledgement', () => {
  const track = new Track(getTrackDef('sunset-circuit'));
  const client = new FakeClient();
  const session = new OnlineRaceSession({
    client, track, raceId: 'race-resume', roster: roster(), localParticipantId: 'local',
  });
  client.ack('race-resume');
  session.applySnapshot({
    raceId: 'race-resume', tick: 60, acks: snapshotAcks(500, 0), state: RACE_STATE.RACING,
    karts: [snapshotKart(0), snapshotKart(1)],
  });
  client.emit('connection', { state: 'disconnected' });
  session.update(INPUT_STEP * 4, { throttle: 1 });
  session.flushInput({ throttle: 1 });
  assert.equal(client.inputs.length, 0);

  client.emit('connection', { state: 'connected' });
  client.ack('race-resume', true);
  session.applySnapshot({
    raceId: 'race-resume', tick: 63, acks: snapshotAcks(500, 0), state: RACE_STATE.RACING,
    karts: [snapshotKart(0, { controllerKind: 'takeover-ai' }), snapshotKart(1)],
  });
  session.update(INPUT_STEP, { throttle: 0.75 });
  session.flushInput({ throttle: 0.75 });
  assert.equal(client.inputs.at(-1).seq, 501);
});

test('a 250ms render stall flushes only the newest input packet', () => {
  const track = new Track(getTrackDef('sunset-circuit'));
  const client = new FakeClient();
  const session = new OnlineRaceSession({
    client, track, raceId: 'race-stall', roster: roster(), localParticipantId: 'local',
  });
  client.ack('race-stall');
  session.applySnapshot({
    raceId: 'race-stall', tick: 1, acks: snapshotAcks(), state: RACE_STATE.RACING,
    karts: [snapshotKart(0), snapshotKart(1)],
  });

  for (let index = 0; index < 30; index++) {
    session.update(FIXED_DT, { throttle: index === 29 ? 0.75 : 1, steer: index / 30 });
  }
  session.flushInput({ throttle: 0.75, steer: 29 / 30 });
  assert.equal(client.inputs.length, 1);
  assert.equal(client.inputs[0].throttle, 0.75);
});

test('online pause sends one immediate neutral input and 500ms neutral keepalives', () => {
  const track = new Track(getTrackDef('sunset-circuit'));
  const client = new FakeClient();
  const session = new OnlineRaceSession({
    client, track, raceId: 'race-pause', roster: roster(), localParticipantId: 'local',
  });
  client.ack('race-pause');
  session.applySnapshot({
    raceId: 'race-pause', tick: 1, acks: snapshotAcks(), state: RACE_STATE.RACING,
    karts: [snapshotKart(0), snapshotKart(1)],
  });

  assert.equal(session.sendNeutralInput(), true);
  for (let index = 0; index < 40; index++) session.flushPausedInput(0.25);
  assert.equal(client.inputs.length, 21);
  assert.equal(client.inputs.every((packet) => packet.throttle === 0 && packet.brake === 0), true);
});
