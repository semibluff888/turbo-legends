import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BINARY_INPUT_PACKET_BYTES,
  BinaryPacketWriter,
  RaceCodecError,
  binaryPacketHex,
  decodeInputPacket,
  decodeSnapshotPacket,
  encodeInputPacket,
  encodeSnapshotPacket,
} from '../src/net/binary-race-codec.js';

function kart(index = 0) {
  return {
    index,
    controllerKind: index < 2 ? 'human' : 'ai',
    x: index * 2.25,
    y: 0.125,
    z: -index * 3.5,
    yaw: Math.PI * 0.75,
    vx: 1.25,
    vy: -0.5,
    vz: 12.75,
    speed: 13.5,
    airborne: index % 2 === 0,
    visualYawOffset: -0.2,
    visualRoll: 0.1,
    visualPitch: -0.05,
    visualScale: 0.875,
    wheelSpin: 123.4,
    steerAngle: -0.42,
    drifting: true,
    driftDirection: -1,
    driftCharge: 2.345,
    driftTier: 2,
    hopTimer: 0.123,
    boostTimer: 1.234,
    boostPower: 1.5,
    boostSource: 'drift',
    speedMul: 1.375,
    draftCharge: 0.75,
    state: 'normal',
    stateTimer: 0,
    aiSpeedMul: 1.125,
    startPenaltyTimer: 0.25,
    invulnTimer: 0.5,
    starTimer: 3.25,
    shrinkTimer: 4.5,
    spinDirection: 1,
    item: 'triple_mushroom',
    itemUses: 2,
    rouletteTimer: 0.4,
    rouletteFace: 'red_shell',
    pendingItem: 'none',
    heldCount: 1,
    s: 826.125,
    lateral: -2.6,
    surface: 'road',
    offTrackDepth: 0,
    progress: 1826.5,
    lap: 2,
    rank: index + 1,
    finished: false,
    finishTime: 0,
    currentLapStart: 65.432,
    bestLap: index === 0 ? null : 62.345,
    wrongWay: false,
    prevX: index * 2.25 - 0.1,
    prevZ: -index * 3.5 - 0.2,
    controls: {
      throttle: 0.875,
      brake: 0.125,
      steer: -0.333,
      drift: true,
      lookBack: index % 2 === 1,
    },
  };
}

function projectile(index = 0) {
  return {
    id: index + 1,
    kind: index % 2 ? 'red_shell' : 'green_shell',
    x: index,
    y: 0.45,
    z: -index,
    yaw: 0.6,
    vx: 4,
    vy: 0,
    vz: 25,
    ownerIndex: index % 8,
    age: 1.25,
    s: 42.5,
    bounces: 2,
    targetIndex: -1,
    straight: true,
    diving: false,
    armed: true,
  };
}

function hazard(index = 0) {
  return {
    id: index + 100,
    kind: index % 2 ? 'bomb' : 'banana',
    x: index,
    y: 0.35,
    z: -index,
    yaw: -0.4,
    ownerIndex: index % 8,
    age: 2.5,
    s: 84,
    lateral: -1.5,
    armed: true,
    fuse: index % 2 ? 2.6 : Infinity,
    dead: false,
  };
}

function snapshot({
  karts = Array.from({ length: 8 }, (_, index) => kart(index)),
  projectiles = [],
  hazards = [],
  itemBoxes = Array.from({ length: 18 }, (_, index) => [index % 3 !== 0, index * 0.5]),
  acks = [[0, 123, 4], [1, 120, 3]],
} = {}) {
  return {
    wireRaceId: 0x12345678,
    tick: 456,
    serverTime: 123456.75,
    state: 'racing',
    countdown: 0,
    elapsed: 67.89,
    laps: 3,
    karts,
    projectiles,
    hazards,
    itemBoxes,
    acks,
  };
}

function closeTo(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected}, received ${actual}`);
}

test('v4 input packet has a stable 28-byte golden representation', () => {
  const encoded = encodeInputPacket({
    wireRaceId: 0x12345678,
    seq: 9,
    useItemSeq: 2,
    throttle: 1,
    brake: 0.5,
    steer: -0.25,
    drift: true,
    lookBack: false,
  });
  assert.equal(encoded.byteLength, BINARY_INPUT_PACKET_BYTES);
  assert.equal(
    binaryPacketHex(encoded),
    '544c473401021c00785634120900000002000000ffff008000e00100',
  );
  const decoded = decodeInputPacket(encoded);
  assert.equal(decoded.wireRaceId, 0x12345678);
  assert.equal(decoded.seq, 9);
  assert.equal(decoded.useItemSeq, 2);
  closeTo(decoded.brake, 0.5, 1 / 65535, 'brake');
  closeTo(decoded.steer, -0.25, 1 / 32767, 'steer');
  assert.equal(decoded.drift, true);
  assert.equal(decoded.lookBack, false);
});

test('snapshot codec round-trips complete kart and entity state within wire precision', () => {
  const source = snapshot({ projectiles: [projectile()], hazards: [hazard()] });
  const encoded = encodeSnapshotPacket(source);
  const decoded = decodeSnapshotPacket(encoded);
  assert.equal(decoded.wireRaceId, source.wireRaceId);
  assert.equal(decoded.tick, source.tick);
  assert.equal(decoded.state, source.state);
  closeTo(decoded.elapsed, source.elapsed, 0.001, 'elapsed');
  assert.equal(decoded.karts.length, 8);
  assert.equal(decoded.projectiles.length, 1);
  assert.equal(decoded.hazards.length, 1);
  assert.deepEqual(decoded.acks, source.acks);
  closeTo(decoded.karts[0].x, source.karts[0].x, 1e-5, 'kart.x');
  closeTo(decoded.karts[0].yaw, source.karts[0].yaw, 0.0001, 'kart.yaw');
  closeTo(decoded.karts[0].boostTimer, source.karts[0].boostTimer, 0.001, 'boostTimer');
  closeTo(decoded.karts[0].boostPower, source.karts[0].boostPower, 1 / 4096, 'boostPower');
  closeTo(decoded.karts[0].controls.steer, source.karts[0].controls.steer, 1 / 32767,
    'controls.steer');
  assert.equal(decoded.karts[0].bestLap, null);
  assert.equal(decoded.hazards[0].fuse, null);
});

test('standard eight-kart snapshot meets the phase-2 size target', () => {
  const encoded = encodeSnapshotPacket(snapshot(), new BinaryPacketWriter({ initialBytes: 256 }));
  assert.equal(encoded.byteLength, 1173);
  assert.ok(encoded.byteLength <= 1536);
  assert.equal(binaryPacketHex(encoded).slice(0, 16), '544c473401019504');
});

test('entity-heavy binary snapshot is at least 55 percent smaller than JSON', () => {
  const source = snapshot({
    projectiles: Array.from({ length: 64 }, (_, index) => projectile(index)),
    hazards: Array.from({ length: 64 }, (_, index) => hazard(index)),
    itemBoxes: Array.from({ length: 255 }, (_, index) => [index % 3 !== 0, index * 0.01]),
  });
  const encoded = encodeSnapshotPacket(source);
  const jsonBytes = Buffer.byteLength(JSON.stringify({ v: 3, type: 'snapshot', ...source }));
  assert.ok(encoded.byteLength <= jsonBytes * 0.45,
    `expected <= ${Math.round(jsonBytes * 0.45)} bytes, received ${encoded.byteLength}`);
  const decoded = decodeSnapshotPacket(encoded);
  assert.equal(decoded.projectiles.length, 64);
  assert.equal(decoded.hazards.length, 64);
  assert.equal(decoded.itemBoxes.length, 255);
});

test('codec rejects damaged preambles, versions, types, lengths and reserved flags', () => {
  const goodInput = encodeInputPacket({ wireRaceId: 1, seq: 0, useItemSeq: 0 });
  const badMagic = goodInput.slice();
  badMagic[0] = 0;
  assert.throws(() => decodeInputPacket(badMagic), RaceCodecError);
  const badLength = goodInput.slice();
  badLength[6] = 27;
  assert.throws(() => decodeInputPacket(badLength), /length/i);
  const badVersion = goodInput.slice();
  badVersion[4] = 2;
  assert.throws(() => decodeInputPacket(badVersion), /version/i);
  const badType = goodInput.slice();
  badType[5] = 1;
  assert.throws(() => decodeInputPacket(badType), /type/i);
  const badFlags = goodInput.slice();
  badFlags[26] = 0x80;
  assert.throws(() => decodeInputPacket(badFlags), /flags/i);

  const goodSnapshot = encodeSnapshotPacket(snapshot());
  assert.throws(() => decodeSnapshotPacket(goodSnapshot.subarray(0, goodSnapshot.length - 1)), /length/i);
  const badEnum = goodSnapshot.slice();
  badEnum[41] = 0xff;
  assert.throws(() => decodeSnapshotPacket(badEnum), /unknown code/i);
  const badNumber = goodSnapshot.slice();
  new DataView(badNumber.buffer).setFloat32(58, NaN, true);
  assert.throws(() => decodeSnapshotPacket(badNumber), /not finite/i);

  const duplicate = snapshot({ karts: [kart(0), kart(0)], itemBoxes: [], acks: [] });
  const encodedDuplicate = encodeSnapshotPacket(duplicate);
  assert.throws(() => decodeSnapshotPacket(encodedDuplicate), /duplicate/i);
});

test('codec enforces packet counts and numeric wire ranges', () => {
  assert.throws(() => encodeSnapshotPacket(snapshot({
    karts: Array.from({ length: 9 }, (_, index) => kart(index)),
  })), /too many karts/i);
  assert.throws(() => encodeSnapshotPacket(snapshot({
    hazards: Array.from({ length: 65 }, (_, index) => hazard(index)),
  })), /too many hazards/i);
  assert.throws(() => encodeSnapshotPacket(snapshot({
    projectiles: Array.from({ length: 65 }, (_, index) => projectile(index)),
  })), /too many projectiles/i);
  assert.throws(() => encodeSnapshotPacket(snapshot({
    itemBoxes: Array.from({ length: 256 }, () => [true, null]),
  })), /too many item boxes/i);
  assert.throws(() => encodeInputPacket({
    wireRaceId: 1, seq: 0, useItemSeq: 0, throttle: 1.1,
  }), /between 0 and 1/i);
  assert.throws(() => encodeSnapshotPacket(snapshot({
    karts: [{ ...kart(0), state: 'unknown-state' }], itemBoxes: [], acks: [],
  })), /unknown value/i);
});
