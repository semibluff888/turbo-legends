import test from 'node:test';
import assert from 'node:assert/strict';

import { FIXED_DT, ITEM, RACE_STATE } from '../src/core/constants.js';
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

function drivingSnapshotKart(track, index, extra = {}) {
  const s = 20 + index * 4;
  const world = track.toWorld(s, 0, {});
  const { controls = {}, ...state } = extra;
  return snapshotKart(index, {
    x: world.x,
    y: world.y,
    z: world.z,
    yaw: world.heading,
    speed: 18,
    airborne: false,
    drifting: false,
    driftDirection: 0,
    driftCharge: 0,
    driftTier: -1,
    hopTimer: 0,
    surface: 'road',
    s,
    lateral: 0,
    offTrackDepth: 0,
    progress: s,
    controls: {
      throttle: 1,
      brake: 0,
      steer: 0,
      drift: false,
      lookBack: false,
      ...controls,
    },
    ...state,
  });
}

function itemBoxSnapshotKart(track, index, box, extra = {}) {
  const ground = track.toWorld(box.s, box.lateral, {});
  return {
    index,
    x: box.x,
    y: ground.y,
    z: box.z,
    yaw: ground.heading,
    vx: 0,
    vy: 0,
    vz: 0,
    speed: 0,
    airborne: false,
    state: 'normal',
    item: ITEM.NONE,
    itemUses: 0,
    rouletteTimer: 0,
    rouletteFace: ITEM.BANANA,
    s: box.s,
    lateral: box.lateral,
    surface: 'road',
    offTrackDepth: 0,
    progress: box.s,
    lap: 1,
    rank: index + 1,
    finished: false,
    prevX: box.x,
    prevZ: box.z,
    controls: {
      throttle: 0,
      brake: 0,
      steer: 0,
      drift: false,
      lookBack: false,
    },
    ...extra,
  };
}

function itemBoxStates(track, consumedId = null) {
  return track.itemBoxes.map((box) => [box.id !== consumedId, consumedId === box.id ? 5 : 0]);
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

test('legacy dedicated AI rosters are numbered while takeover AI keeps the human name', () => {
  const track = new Track(getTrackDef('sunset-circuit'));
  const session = new OnlineRaceSession({
    client: new FakeClient(),
    track,
    raceId: 'race-ai-names',
    localParticipantId: 'local',
    aiPlayerLabel: 'AI玩家',
    roster: [
      ...roster(),
      {
        kartIndex: 3,
        participantId: 'ai-3-pip',
        displayName: 'SUGAR SPARK',
        characterId: 'pip',
        controllerKind: 'ai',
      },
      {
        kartIndex: 2,
        participantId: 'ai-2-nova',
        displayName: 'NEON RAZOR',
        characterId: 'nova',
        controllerKind: 'ai',
      },
    ],
  });

  assert.equal(session.karts[2].name, 'AI玩家 1');
  assert.equal(session.karts[3].name, 'AI玩家 2');
  assert.equal(session.karts[1].name, 'Remote');
  session.karts[1].controllerKind = 'takeover-ai';
  session.setAiPlayerLabel('AI player');
  assert.equal(session.karts[2].name, 'AI player 1');
  assert.equal(session.karts[3].name, 'AI player 2');
  assert.equal(session.karts[1].name, 'Remote');
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

test('online item-box pickup predicts immediate feedback and keeps it across pre-confirmation snapshots', () => {
  const track = new Track(getTrackDef('sunset-circuit'));
  const client = new FakeClient();
  client.latencyMs = 300;
  const session = new OnlineRaceSession({
    client, track, raceId: 'race-item-predict', roster: roster(), localParticipantId: 'local',
  });
  client.ack('race-item-predict');
  const box = track.itemBoxes[0];
  const beforePickup = itemBoxSnapshotKart(track, 0, box);
  session.applySnapshot({
    raceId: 'race-item-predict', tick: 1, acks: snapshotAcks(), state: RACE_STATE.RACING,
    karts: [beforePickup, snapshotKart(1)],
    itemBoxes: itemBoxStates(track),
  });

  session.update(FIXED_DT, {});
  assert.equal(box.active, false);
  assert.equal(session.player.item, ITEM.NONE, 'prediction never grants an item');
  assert.ok(session.player.rouletteTimer > 0, 'temporary roulette starts immediately');
  assert.deepEqual(session.player.events.at(-1), {
    type: 'itembox', boxId: box.id, speculative: true,
  });

  session.player.clearEvents();
  session.applySnapshot({
    raceId: 'race-item-predict', tick: 4, acks: snapshotAcks(), state: RACE_STATE.RACING,
    karts: [beforePickup, snapshotKart(1)],
    itemBoxes: itemBoxStates(track),
  });
  assert.equal(box.active, false, 'an older authoritative view cannot flash the box back on');
  assert.ok(session.player.rouletteTimer > 0);

  session.applyEvents({
    raceId: 'race-item-predict',
    events: [{ eventId: 10, kartIndex: 0, type: 'itembox', boxId: box.id }],
  });
  assert.equal(session.player.events.length, 0, 'the authoritative confirmation is not presented twice');

  session.applySnapshot({
    raceId: 'race-item-predict', tick: 7, acks: snapshotAcks(), state: RACE_STATE.RACING,
    karts: [
      itemBoxSnapshotKart(track, 0, box, {
        rouletteTimer: 0.82,
        rouletteFace: ITEM.RED_SHELL,
      }),
      snapshotKart(1),
    ],
    itemBoxes: itemBoxStates(track, box.id),
  });
  assert.equal(box.active, false);
  assert.equal(session.player.rouletteTimer, 0.82);
  assert.equal(session.player.rouletteFace, ITEM.RED_SHELL);
});

test('a rejected speculative item-box pickup rolls back and cannot retrigger while overlapping', () => {
  const track = new Track(getTrackDef('sunset-circuit'));
  const client = new FakeClient();
  client.latencyMs = 300;
  const session = new OnlineRaceSession({
    client, track, raceId: 'race-item-rollback', roster: roster(), localParticipantId: 'local',
  });
  client.ack('race-item-rollback');
  const box = track.itemBoxes[0];
  session.applySnapshot({
    raceId: 'race-item-rollback', tick: 1, acks: snapshotAcks(), state: RACE_STATE.RACING,
    karts: [itemBoxSnapshotKart(track, 0, box), snapshotKart(1)],
    itemBoxes: itemBoxStates(track),
  });
  session.update(FIXED_DT, {});
  session.player.clearEvents();

  for (let index = 0; index < 130; index++) session.update(FIXED_DT, {});

  assert.equal(box.active, true, 'the last authoritative active state is restored after timeout');
  assert.equal(session.player.rouletteTimer, 0);
  assert.equal(session.player.item, ITEM.NONE);
  assert.equal(session.player.events.length, 0, 'remaining inside the box does not loop feedback');
});

test('a box consumed by another racer cancels the local temporary roulette', () => {
  const track = new Track(getTrackDef('sunset-circuit'));
  const client = new FakeClient();
  const session = new OnlineRaceSession({
    client, track, raceId: 'race-item-contested', roster: roster(), localParticipantId: 'local',
  });
  client.ack('race-item-contested');
  const box = track.itemBoxes[0];
  const local = itemBoxSnapshotKart(track, 0, box);
  session.applySnapshot({
    raceId: 'race-item-contested', tick: 1, acks: snapshotAcks(), state: RACE_STATE.RACING,
    karts: [local, snapshotKart(1)],
    itemBoxes: itemBoxStates(track),
  });
  session.update(FIXED_DT, {});
  assert.ok(session.player.rouletteTimer > 0);

  session.player.clearEvents();
  session.karts[1].clearEvents();
  session.applyEvents({
    raceId: 'race-item-contested',
    events: [{ eventId: 20, kartIndex: 1, type: 'itembox', boxId: box.id }],
  });
  assert.equal(box.active, false);
  assert.equal(session.player.rouletteTimer, 0);
  assert.equal(session.karts[1].events.length, 0, 'the already-predicted box feedback is not doubled');

  session.applySnapshot({
    raceId: 'race-item-contested', tick: 4, acks: snapshotAcks(), state: RACE_STATE.RACING,
    karts: [local, snapshotKart(1)],
    itemBoxes: itemBoxStates(track, box.id),
  });
  assert.equal(box.active, false);
  assert.equal(session.player.rouletteTimer, 0);
  assert.equal(session.player.item, ITEM.NONE);
});

test('an unacknowledged drift press survives reconciliation with a pre-press snapshot', () => {
  const track = new Track(getTrackDef('sunset-circuit'));
  const client = new FakeClient();
  const session = new OnlineRaceSession({
    client, track, raceId: 'race-drift-latency', roster: roster(), localParticipantId: 'local',
  });
  client.ack('race-drift-latency');
  const prePressKarts = [
    drivingSnapshotKart(track, 0),
    drivingSnapshotKart(track, 1),
  ];
  session.applySnapshot({
    raceId: 'race-drift-latency', tick: 1, acks: snapshotAcks(),
    state: RACE_STATE.RACING, karts: prePressKarts,
  });

  const controls = {
    throttle: 1, brake: 0, steer: 1,
    drift: true, useItem: false, lookBack: false,
  };
  session.update(FIXED_DT, controls);
  session.flushInput(controls);
  assert.equal(session.player.drifting, true);
  assert.equal(session.player.airborne, true);

  session.applySnapshot({
    raceId: 'race-drift-latency', tick: 4, acks: snapshotAcks(),
    state: RACE_STATE.RACING, karts: prePressKarts,
  });
  assert.equal(session.player.drifting, true);
  assert.equal(session.player.airborne, true);
  assert.ok(session.player.hopTimer > 0);
});

test('an authoritative held drift does not become a duplicate press on the first prediction step', () => {
  const track = new Track(getTrackDef('sunset-circuit'));
  const client = new FakeClient();
  const session = new OnlineRaceSession({
    client, track, raceId: 'race-drift-held', roster: roster(), localParticipantId: 'local',
  });
  client.ack('race-drift-held');
  session.applySnapshot({
    raceId: 'race-drift-held', tick: 1, acks: snapshotAcks(), state: RACE_STATE.RACING,
    karts: [
      drivingSnapshotKart(track, 0, { controls: { drift: true } }),
      drivingSnapshotKart(track, 1),
    ],
  });

  session.update(FIXED_DT, {
    throttle: 1, brake: 0, steer: 1,
    drift: true, useItem: false, lookBack: false,
  });
  assert.equal(session.player.airborne, false);
  assert.equal(session.player.drifting, false);
  assert.equal(session.player.hopTimer, 0);
});

test('an unacknowledged drift release still cashes its boost after reconciliation', () => {
  const track = new Track(getTrackDef('sunset-circuit'));
  const client = new FakeClient();
  const session = new OnlineRaceSession({
    client, track, raceId: 'race-drift-release', roster: roster(), localParticipantId: 'local',
  });
  client.ack('race-drift-release');
  const heldKarts = [
    drivingSnapshotKart(track, 0, {
      drifting: true,
      driftDirection: 1,
      driftCharge: 1,
      driftTier: 0,
      controls: { steer: 1, drift: true },
    }),
    drivingSnapshotKart(track, 1),
  ];
  session.applySnapshot({
    raceId: 'race-drift-release', tick: 10, acks: snapshotAcks(1),
    state: RACE_STATE.RACING, karts: heldKarts,
  });

  const released = {
    throttle: 1, brake: 0, steer: 1,
    drift: false, useItem: false, lookBack: false,
  };
  session.update(FIXED_DT, released);
  session.flushInput(released);
  assert.equal(session.player.drifting, false);
  assert.equal(session.player.boostSource, 'drift');

  session.applySnapshot({
    raceId: 'race-drift-release', tick: 13, acks: snapshotAcks(1),
    state: RACE_STATE.RACING, karts: heldKarts,
  });
  assert.equal(session.player.drifting, false);
  assert.equal(session.player.boostSource, 'drift');
  assert.ok(session.player.boostTimer > 0);
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
