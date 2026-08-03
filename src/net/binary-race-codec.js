import {
  CONTROLLER_KINDS,
  PROTOCOL_VERSION,
  decodeKartSnapshot,
} from './protocol.js';

export const RACE_BINARY_CODEC_VERSION = 1;
export const MAX_BINARY_PACKET_BYTES = 0xffff;
export const BINARY_INPUT_PACKET_BYTES = 28;

export const BINARY_PACKET_TYPES = Object.freeze({
  SNAPSHOT: 1,
  INPUT: 2,
});

const MAGIC = Object.freeze([0x54, 0x4c, 0x47, 0x34]); // TLG4
const PREAMBLE_BYTES = 8;
const SNAPSHOT_HEADER_BYTES = 40;
const KART_RECORD_BYTES = 130;
const PROJECTILE_RECORD_BYTES = 44;
const HAZARD_RECORD_BYTES = 36;
const MAX_KARTS = 8;
const MAX_ENTITIES = 64;
const MAX_ITEM_BOXES = 255;
const NULL_U16 = 0xffff;
const NULL_U32 = 0xffffffff;
const ANGLE_SCALE = 32767 / Math.PI;
const Q12_SCALE = 4096;

const RACE_STATES = Object.freeze(['countdown', 'racing', 'finished', 'results']);
const CONTROLLERS = Object.freeze([
  CONTROLLER_KINDS.HUMAN,
  CONTROLLER_KINDS.AI,
  CONTROLLER_KINDS.TAKEOVER_AI,
]);
const KART_STATES = Object.freeze(['normal', 'spinning', 'squashed', 'respawning', 'bullet']);
const SURFACES = Object.freeze(['road', 'offroad', 'boost', 'wall']);
const ITEMS = Object.freeze([
  'none',
  'banana',
  'green_shell',
  'red_shell',
  'mushroom',
  'triple_mushroom',
  'bomb',
  'star',
  'lightning',
  'bullet',
  'blue_shell',
]);
const BOOST_SOURCES = Object.freeze([
  '', 'drift', 'pad', 'mushroom', 'start', 'draft', 'star', 'bullet',
]);

const KART_FLOAT_FIELDS = Object.freeze([
  'x', 'y', 'z', 'vx', 'vy', 'vz', 'speed', 'driftCharge',
  's', 'lateral', 'offTrackDepth', 'progress', 'prevX', 'prevZ',
]);
const KART_ANGLE_FIELDS = Object.freeze([
  'yaw', 'visualYawOffset', 'visualRoll', 'visualPitch', 'wheelSpin', 'steerAngle',
]);
const KART_Q12_FIELDS = Object.freeze([
  'visualScale', 'boostPower', 'speedMul', 'aiSpeedMul',
]);
const KART_Q12_DEFAULTS = Object.freeze({
  visualScale: 1,
  boostPower: 1,
  speedMul: 1,
  aiSpeedMul: 1,
});
const KART_TIMER_FIELDS = Object.freeze([
  'hopTimer', 'boostTimer', 'draftCharge', 'stateTimer', 'startPenaltyTimer',
  'invulnTimer', 'starTimer', 'shrinkTimer', 'rouletteTimer',
]);
const KART_TIME_FIELDS = Object.freeze(['finishTime', 'currentLapStart', 'bestLap']);

const PROJECTILE_FLOAT_FIELDS = Object.freeze([
  'x', 'y', 'z', 'vx', 'vy', 'vz', 'age', 's',
]);
const HAZARD_FLOAT_FIELDS = Object.freeze(['x', 'y', 'z', 'age', 's', 'lateral']);

export class RaceCodecError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RaceCodecError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new RaceCodecError(code, message);
}

function finite(value, name, fallback = 0) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) fail('number_invalid', `${name} must be finite.`);
  return number;
}

function uint(value, max, name, fallback = 0) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > max) {
    fail('integer_invalid', `${name} must be an integer from 0 to ${max}.`);
  }
  return number;
}

function sint(value, min, max, name, fallback = 0) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    fail('integer_invalid', `${name} must be an integer from ${min} to ${max}.`);
  }
  return number;
}

function enumCode(values, value, name, fallback) {
  const selected = value === undefined || value === null ? fallback : value;
  const index = values.indexOf(selected);
  if (index < 0) fail('enum_invalid', `${name} has an unknown value.`);
  return index;
}

function enumValue(values, code, name) {
  const value = values[code];
  if (value === undefined) fail('enum_invalid', `${name} has an unknown code.`);
  return value;
}

function angleToInt16(value, name) {
  const number = finite(value, name);
  const normalized = Math.atan2(Math.sin(number), Math.cos(number));
  return Math.max(-32767, Math.min(32767, Math.round(normalized * ANGLE_SCALE)));
}

function int16ToAngle(value) {
  return value / ANGLE_SCALE;
}

function q12ToInt16(value, name, fallback = 0) {
  const number = finite(value, name, fallback);
  const encoded = Math.round(number * Q12_SCALE);
  if (encoded < -32768 || encoded > 32767) {
    fail('number_overflow', `${name} exceeds the Q12 wire range.`);
  }
  return encoded;
}

function secondsToUint16(value, name, { nullable = false } = {}) {
  if (value === undefined || value === null) return nullable ? NULL_U16 : 0;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    if (nullable) return NULL_U16;
    fail('number_invalid', `${name} must be finite.`);
  }
  const encoded = Math.round(number * 1000);
  if (encoded < 0 || encoded >= NULL_U16) {
    fail('number_overflow', `${name} exceeds the uint16 millisecond wire range.`);
  }
  return encoded;
}

function uint16ToSeconds(value, { nullable = false } = {}) {
  if (nullable && value === NULL_U16) return null;
  return value / 1000;
}

function secondsToUint32(value, name, { nullable = false } = {}) {
  if (value === undefined || value === null) return nullable ? NULL_U32 : 0;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    if (nullable) return NULL_U32;
    fail('number_invalid', `${name} must be finite.`);
  }
  const encoded = Math.round(number * 1000);
  if (encoded < 0 || encoded >= NULL_U32) {
    fail('number_overflow', `${name} exceeds the uint32 millisecond wire range.`);
  }
  return encoded;
}

function uint32ToSeconds(value, { nullable = false } = {}) {
  if (nullable && value === NULL_U32) return null;
  return value / 1000;
}

function normalizedToUint16(value, name) {
  const number = finite(value, name);
  if (number < 0 || number > 1) fail('number_invalid', `${name} must be between 0 and 1.`);
  return Math.round(number * 65535);
}

function signedNormalizedToInt16(value, name) {
  const number = finite(value, name);
  if (number < -1 || number > 1) fail('number_invalid', `${name} must be between -1 and 1.`);
  return Math.max(-32767, Math.min(32767, Math.round(number * 32767)));
}

function viewOf(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  fail('packet_invalid', 'Binary packet must be an ArrayBuffer or typed array.');
}

function dataViewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readPreamble(data, expectedType) {
  const bytes = viewOf(data);
  if (bytes.byteLength < PREAMBLE_BYTES) fail('packet_truncated', 'Binary packet is truncated.');
  for (let index = 0; index < MAGIC.length; index++) {
    if (bytes[index] !== MAGIC[index]) fail('magic_invalid', 'Binary packet magic is invalid.');
  }
  const view = dataViewOf(bytes);
  if (view.getUint8(4) !== RACE_BINARY_CODEC_VERSION) {
    fail('codec_version_invalid', 'Binary codec version is unsupported.');
  }
  if (view.getUint8(5) !== expectedType) fail('packet_type_invalid', 'Binary packet type is invalid.');
  const declaredLength = view.getUint16(6, true);
  if (declaredLength !== bytes.byteLength) fail('packet_length_invalid', 'Binary packet length does not match.');
  return { bytes, view };
}

export class BinaryPacketWriter {
  constructor({ initialBytes = 4096, maxBytes = MAX_BINARY_PACKET_BYTES } = {}) {
    this.maxBytes = Math.min(MAX_BINARY_PACKET_BYTES, Math.max(PREAMBLE_BYTES, maxBytes | 0));
    this.buffer = new ArrayBuffer(Math.min(this.maxBytes, Math.max(PREAMBLE_BYTES, initialBytes | 0)));
    this.bytes = new Uint8Array(this.buffer);
    this.view = new DataView(this.buffer);
    this.offset = 0;
  }

  reset(packetType) {
    this.offset = 0;
    this.ensure(PREAMBLE_BYTES);
    for (const byte of MAGIC) this.u8(byte);
    this.u8(RACE_BINARY_CODEC_VERSION);
    this.u8(packetType);
    this.u16(0);
    return this;
  }

  ensure(additionalBytes) {
    const required = this.offset + additionalBytes;
    if (required > this.maxBytes) fail('packet_too_large', 'Binary packet exceeds 65,535 bytes.');
    if (required <= this.bytes.byteLength) return;
    let nextBytes = this.bytes.byteLength;
    while (nextBytes < required) nextBytes = Math.min(this.maxBytes, Math.max(nextBytes * 2, required));
    const next = new ArrayBuffer(nextBytes);
    new Uint8Array(next).set(this.bytes.subarray(0, this.offset));
    this.buffer = next;
    this.bytes = new Uint8Array(next);
    this.view = new DataView(next);
  }

  u8(value) { this.ensure(1); this.view.setUint8(this.offset, value); this.offset += 1; }
  i8(value) { this.ensure(1); this.view.setInt8(this.offset, value); this.offset += 1; }
  u16(value) { this.ensure(2); this.view.setUint16(this.offset, value, true); this.offset += 2; }
  i16(value) { this.ensure(2); this.view.setInt16(this.offset, value, true); this.offset += 2; }
  u32(value) { this.ensure(4); this.view.setUint32(this.offset, value, true); this.offset += 4; }
  i32(value) { this.ensure(4); this.view.setInt32(this.offset, value, true); this.offset += 4; }
  f32(value) { this.ensure(4); this.view.setFloat32(this.offset, value, true); this.offset += 4; }
  f64(value) { this.ensure(8); this.view.setFloat64(this.offset, value, true); this.offset += 8; }

  finish() {
    if (this.offset > MAX_BINARY_PACKET_BYTES) fail('packet_too_large', 'Binary packet is too large.');
    this.view.setUint16(6, this.offset, true);
    return this.bytes.slice(0, this.offset);
  }
}

function kartObject(encoded) {
  if (!Array.isArray(encoded)) return encoded || {};
  return decodeKartSnapshot(encoded) || {};
}

function writeKart(writer, encodedKart, controllerKinds = null) {
  const kart = kartObject(encodedKart);
  const controls = kart.controls || {};
  writer.u8(uint(kart.index, MAX_KARTS - 1, 'kart.index'));
  const controllerKind = controllerKinds?.[kart.index] ?? kart.controllerKind;
  writer.u8(enumCode(CONTROLLERS, controllerKind, 'kart.controllerKind', CONTROLLER_KINDS.AI));
  let flags = 0;
  if (kart.airborne) flags |= 1 << 0;
  if (kart.drifting) flags |= 1 << 1;
  if (kart.finished) flags |= 1 << 2;
  if (kart.wrongWay) flags |= 1 << 3;
  if (controls.drift) flags |= 1 << 4;
  if (controls.lookBack) flags |= 1 << 5;
  writer.u16(flags);
  writer.i8(sint(kart.driftDirection, -1, 1, 'kart.driftDirection'));
  writer.i8(sint(kart.driftTier, -1, 3, 'kart.driftTier', -1));
  writer.u8(enumCode(BOOST_SOURCES, kart.boostSource, 'kart.boostSource', ''));
  writer.u8(enumCode(KART_STATES, kart.state, 'kart.state', 'normal'));
  writer.u8(enumCode(ITEMS, kart.item, 'kart.item', 'none'));
  writer.u8(enumCode(ITEMS, kart.rouletteFace, 'kart.rouletteFace', 'banana'));
  writer.u8(enumCode(ITEMS, kart.pendingItem, 'kart.pendingItem', 'none'));
  writer.u8(enumCode(SURFACES, kart.surface, 'kart.surface', 'road'));
  writer.u8(uint(kart.itemUses, 255, 'kart.itemUses'));
  writer.u8(uint(kart.heldCount, 255, 'kart.heldCount'));
  writer.u8(uint(kart.lap, 255, 'kart.lap'));
  writer.u8(uint(kart.rank, 255, 'kart.rank', uint(kart.index, 7, 'kart.index') + 1));
  writer.i8(sint(kart.spinDirection, -1, 1, 'kart.spinDirection', 1));
  writer.u8(0);

  for (const field of KART_FLOAT_FIELDS) writer.f32(finite(kart[field], `kart.${field}`));
  for (const field of KART_ANGLE_FIELDS) writer.i16(angleToInt16(kart[field], `kart.${field}`));
  for (const field of KART_Q12_FIELDS) {
    writer.i16(q12ToInt16(kart[field], `kart.${field}`, KART_Q12_DEFAULTS[field]));
  }
  for (const field of KART_TIMER_FIELDS) {
    writer.u16(secondsToUint16(kart[field], `kart.${field}`));
  }
  for (const field of KART_TIME_FIELDS) {
    writer.u32(secondsToUint32(kart[field], `kart.${field}`, { nullable: field === 'bestLap' }));
  }
  writer.u16(normalizedToUint16(controls.throttle ?? 0, 'kart.controls.throttle'));
  writer.u16(normalizedToUint16(controls.brake ?? 0, 'kart.controls.brake'));
  writer.i16(signedNormalizedToInt16(controls.steer ?? 0, 'kart.controls.steer'));
}

function readKart(view, offset) {
  const start = offset;
  const kart = {};
  kart.index = view.getUint8(offset); offset += 1;
  if (kart.index >= MAX_KARTS) fail('kart_index_invalid', 'Kart index exceeds the protocol limit.');
  kart.controllerKind = enumValue(CONTROLLERS, view.getUint8(offset), 'kart.controllerKind'); offset += 1;
  const flags = view.getUint16(offset, true); offset += 2;
  if (flags & ~0x3f) fail('flags_invalid', 'Kart flags contain unsupported bits.');
  kart.airborne = Boolean(flags & (1 << 0));
  kart.drifting = Boolean(flags & (1 << 1));
  kart.finished = Boolean(flags & (1 << 2));
  kart.wrongWay = Boolean(flags & (1 << 3));
  kart.driftDirection = view.getInt8(offset); offset += 1;
  kart.driftTier = view.getInt8(offset); offset += 1;
  if (kart.driftDirection < -1 || kart.driftDirection > 1) fail('integer_invalid', 'Kart drift direction is invalid.');
  if (kart.driftTier < -1 || kart.driftTier > 3) fail('integer_invalid', 'Kart drift tier is invalid.');
  kart.boostSource = enumValue(BOOST_SOURCES, view.getUint8(offset), 'kart.boostSource'); offset += 1;
  kart.state = enumValue(KART_STATES, view.getUint8(offset), 'kart.state'); offset += 1;
  kart.item = enumValue(ITEMS, view.getUint8(offset), 'kart.item'); offset += 1;
  kart.rouletteFace = enumValue(ITEMS, view.getUint8(offset), 'kart.rouletteFace'); offset += 1;
  kart.pendingItem = enumValue(ITEMS, view.getUint8(offset), 'kart.pendingItem'); offset += 1;
  kart.surface = enumValue(SURFACES, view.getUint8(offset), 'kart.surface'); offset += 1;
  kart.itemUses = view.getUint8(offset); offset += 1;
  kart.heldCount = view.getUint8(offset); offset += 1;
  kart.lap = view.getUint8(offset); offset += 1;
  kart.rank = view.getUint8(offset); offset += 1;
  kart.spinDirection = view.getInt8(offset); offset += 1;
  if (kart.spinDirection < -1 || kart.spinDirection > 1) fail('integer_invalid', 'Kart spin direction is invalid.');
  if (view.getUint8(offset) !== 0) fail('reserved_invalid', 'Kart reserved byte must be zero.');
  offset += 1;

  for (const field of KART_FLOAT_FIELDS) {
    const value = view.getFloat32(offset, true); offset += 4;
    if (!Number.isFinite(value)) fail('number_invalid', `kart.${field} is not finite.`);
    kart[field] = value;
  }
  for (const field of KART_ANGLE_FIELDS) {
    kart[field] = int16ToAngle(view.getInt16(offset, true)); offset += 2;
  }
  for (const field of KART_Q12_FIELDS) {
    kart[field] = view.getInt16(offset, true) / Q12_SCALE; offset += 2;
  }
  for (const field of KART_TIMER_FIELDS) {
    kart[field] = uint16ToSeconds(view.getUint16(offset, true)); offset += 2;
  }
  for (const field of KART_TIME_FIELDS) {
    kart[field] = uint32ToSeconds(view.getUint32(offset, true), { nullable: field === 'bestLap' });
    offset += 4;
  }
  kart.controls = {
    throttle: view.getUint16(offset, true) / 65535,
    brake: view.getUint16(offset + 2, true) / 65535,
    steer: view.getInt16(offset + 4, true) / 32767,
    drift: Boolean(flags & (1 << 4)),
    lookBack: Boolean(flags & (1 << 5)),
  };
  offset += 6;
  if (offset - start !== KART_RECORD_BYTES) fail('codec_internal', 'Kart record size is inconsistent.');
  return { kart, offset };
}

function writeProjectile(writer, entity) {
  writer.u32(uint(entity.id, 0xffffffff, 'projectile.id'));
  writer.u8(enumCode(ITEMS, entity.kind, 'projectile.kind', 'green_shell'));
  writer.i8(sint(entity.ownerIndex, -1, 7, 'projectile.ownerIndex', -1));
  writer.u8(uint(entity.bounces, 255, 'projectile.bounces'));
  writer.i8(sint(entity.targetIndex, -1, 7, 'projectile.targetIndex', -1));
  let flags = 0;
  if (entity.straight) flags |= 1 << 0;
  if (entity.diving) flags |= 1 << 1;
  if (entity.armed) flags |= 1 << 2;
  writer.u8(flags);
  writer.u8(0);
  for (const field of PROJECTILE_FLOAT_FIELDS) writer.f32(finite(entity[field], `projectile.${field}`));
  writer.i16(angleToInt16(entity.yaw, 'projectile.yaw'));
}

function readProjectile(view, offset) {
  const start = offset;
  const entity = {
    id: view.getUint32(offset, true),
    kind: enumValue(ITEMS, view.getUint8(offset + 4), 'projectile.kind'),
    ownerIndex: view.getInt8(offset + 5),
    bounces: view.getUint8(offset + 6),
    targetIndex: view.getInt8(offset + 7),
  };
  offset += 8;
  if (entity.ownerIndex < -1 || entity.ownerIndex >= MAX_KARTS
    || entity.targetIndex < -1 || entity.targetIndex >= MAX_KARTS) {
    fail('entity_index_invalid', 'Projectile kart index is invalid.');
  }
  const flags = view.getUint8(offset); offset += 1;
  if (flags & ~0x07) fail('flags_invalid', 'Projectile flags contain unsupported bits.');
  if (view.getUint8(offset) !== 0) fail('reserved_invalid', 'Projectile reserved byte must be zero.');
  offset += 1;
  entity.straight = Boolean(flags & 1);
  entity.diving = Boolean(flags & 2);
  entity.armed = Boolean(flags & 4);
  for (const field of PROJECTILE_FLOAT_FIELDS) {
    const value = view.getFloat32(offset, true); offset += 4;
    if (!Number.isFinite(value)) fail('number_invalid', `projectile.${field} is not finite.`);
    entity[field] = value;
  }
  entity.yaw = int16ToAngle(view.getInt16(offset, true)); offset += 2;
  if (offset - start !== PROJECTILE_RECORD_BYTES) fail('codec_internal', 'Projectile record size is inconsistent.');
  return { entity, offset };
}

function writeHazard(writer, entity) {
  writer.u32(uint(entity.id, 0xffffffff, 'hazard.id'));
  writer.u8(enumCode(ITEMS, entity.kind, 'hazard.kind', 'banana'));
  writer.i8(sint(entity.ownerIndex, -1, 7, 'hazard.ownerIndex', -1));
  let flags = 0;
  if (entity.armed) flags |= 1 << 0;
  if (entity.dead) flags |= 1 << 1;
  writer.u8(flags);
  writer.u8(0);
  for (const field of HAZARD_FLOAT_FIELDS) writer.f32(finite(entity[field], `hazard.${field}`));
  writer.i16(angleToInt16(entity.yaw, 'hazard.yaw'));
  writer.u16(secondsToUint16(entity.fuse, 'hazard.fuse', { nullable: true }));
}

function readHazard(view, offset) {
  const start = offset;
  const entity = {
    id: view.getUint32(offset, true),
    kind: enumValue(ITEMS, view.getUint8(offset + 4), 'hazard.kind'),
    ownerIndex: view.getInt8(offset + 5),
  };
  offset += 6;
  if (entity.ownerIndex < -1 || entity.ownerIndex >= MAX_KARTS) {
    fail('entity_index_invalid', 'Hazard kart index is invalid.');
  }
  const flags = view.getUint8(offset); offset += 1;
  if (flags & ~0x03) fail('flags_invalid', 'Hazard flags contain unsupported bits.');
  if (view.getUint8(offset) !== 0) fail('reserved_invalid', 'Hazard reserved byte must be zero.');
  offset += 1;
  entity.armed = Boolean(flags & 1);
  entity.dead = Boolean(flags & 2);
  for (const field of HAZARD_FLOAT_FIELDS) {
    const value = view.getFloat32(offset, true); offset += 4;
    if (!Number.isFinite(value)) fail('number_invalid', `hazard.${field} is not finite.`);
    entity[field] = value;
  }
  entity.yaw = int16ToAngle(view.getInt16(offset, true)); offset += 2;
  entity.fuse = uint16ToSeconds(view.getUint16(offset, true), { nullable: true }); offset += 2;
  if (offset - start !== HAZARD_RECORD_BYTES) fail('codec_internal', 'Hazard record size is inconsistent.');
  return { entity, offset };
}

export function encodeSnapshotPacket(snapshot, writer = new BinaryPacketWriter()) {
  const karts = Array.isArray(snapshot?.karts) ? snapshot.karts : [];
  const projectiles = Array.isArray(snapshot?.projectiles) ? snapshot.projectiles : [];
  const hazards = Array.isArray(snapshot?.hazards) ? snapshot.hazards : [];
  const itemBoxes = Array.isArray(snapshot?.itemBoxes) ? snapshot.itemBoxes : [];
  const acks = Array.isArray(snapshot?.acks) ? snapshot.acks : [];
  if (karts.length > MAX_KARTS) fail('count_invalid', 'Snapshot contains too many karts.');
  if (projectiles.length > MAX_ENTITIES) fail('count_invalid', 'Snapshot contains too many projectiles.');
  if (hazards.length > MAX_ENTITIES) fail('count_invalid', 'Snapshot contains too many hazards.');
  if (itemBoxes.length > MAX_ITEM_BOXES) fail('count_invalid', 'Snapshot contains too many item boxes.');
  if (acks.length > MAX_KARTS) fail('count_invalid', 'Snapshot contains too many ACKs.');

  writer.reset(BINARY_PACKET_TYPES.SNAPSHOT);
  writer.u32(uint(snapshot.wireRaceId, 0xffffffff, 'snapshot.wireRaceId'));
  if (snapshot.wireRaceId === 0) fail('race_invalid', 'wireRaceId must be non-zero.');
  writer.u32(uint(snapshot.tick, 0xffffffff, 'snapshot.tick'));
  writer.f64(finite(snapshot.serverTime, 'snapshot.serverTime'));
  writer.u16(secondsToUint16(snapshot.countdown, 'snapshot.countdown', { nullable: true }));
  writer.u8(uint(snapshot.laps, 255, 'snapshot.laps', 1));
  writer.u8(enumCode(RACE_STATES, snapshot.state, 'snapshot.state', 'countdown'));
  writer.u32(secondsToUint32(snapshot.elapsed, 'snapshot.elapsed'));
  writer.u8(karts.length);
  writer.u8(projectiles.length);
  writer.u8(hazards.length);
  writer.u8(itemBoxes.length);
  writer.u8(acks.length);
  writer.u8(0);
  writer.u16(0);
  if (writer.offset !== SNAPSHOT_HEADER_BYTES) fail('codec_internal', 'Snapshot header size is inconsistent.');

  for (const kart of karts) writeKart(writer, kart, snapshot.controllerKinds);
  for (const entity of projectiles) writeProjectile(writer, entity);
  for (const entity of hazards) writeHazard(writer, entity);

  const activeBytes = Math.ceil(itemBoxes.length / 8);
  const activeOffset = writer.offset;
  for (let index = 0; index < activeBytes; index++) writer.u8(0);
  for (let index = 0; index < itemBoxes.length; index++) {
    const box = itemBoxes[index];
    const active = Array.isArray(box) ? Boolean(box[0]) : Boolean(box?.active);
    const respawnAt = Array.isArray(box) ? box[1] : box?.respawnAt;
    if (active) writer.bytes[activeOffset + (index >> 3)] |= 1 << (index & 7);
    writer.u32(secondsToUint32(respawnAt, `itemBoxes[${index}].respawnAt`, { nullable: true }));
  }

  for (let index = 0; index < acks.length; index++) {
    const ack = acks[index];
    if (!Array.isArray(ack) || ack.length < 3) fail('ack_invalid', `acks[${index}] is invalid.`);
    writer.u8(uint(ack[0], MAX_KARTS - 1, `acks[${index}].kartIndex`));
    writer.i32(sint(ack[1], -1, 0x7fffffff, `acks[${index}].inputSeq`, -1));
    writer.u32(uint(ack[2], 0xffffffff, `acks[${index}].useItemSeq`));
  }
  return writer.finish();
}

export function decodeSnapshotPacket(data) {
  const { bytes, view } = readPreamble(data, BINARY_PACKET_TYPES.SNAPSHOT);
  if (bytes.byteLength < SNAPSHOT_HEADER_BYTES) fail('packet_truncated', 'Snapshot header is truncated.');
  let offset = PREAMBLE_BYTES;
  const wireRaceId = view.getUint32(offset, true); offset += 4;
  if (wireRaceId === 0) fail('race_invalid', 'wireRaceId must be non-zero.');
  const tick = view.getUint32(offset, true); offset += 4;
  const serverTime = view.getFloat64(offset, true); offset += 8;
  if (!Number.isFinite(serverTime)) fail('number_invalid', 'snapshot.serverTime is not finite.');
  const countdown = uint16ToSeconds(view.getUint16(offset, true), { nullable: true }); offset += 2;
  const laps = view.getUint8(offset); offset += 1;
  const state = enumValue(RACE_STATES, view.getUint8(offset), 'snapshot.state'); offset += 1;
  const elapsed = uint32ToSeconds(view.getUint32(offset, true)); offset += 4;
  const kartCount = view.getUint8(offset); offset += 1;
  const projectileCount = view.getUint8(offset); offset += 1;
  const hazardCount = view.getUint8(offset); offset += 1;
  const itemBoxCount = view.getUint8(offset); offset += 1;
  const ackCount = view.getUint8(offset); offset += 1;
  if (view.getUint8(offset) !== 0 || view.getUint16(offset + 1, true) !== 0) {
    fail('reserved_invalid', 'Snapshot reserved bytes must be zero.');
  }
  offset += 3;
  if (kartCount > MAX_KARTS || projectileCount > MAX_ENTITIES || hazardCount > MAX_ENTITIES
    || itemBoxCount > MAX_ITEM_BOXES || ackCount > MAX_KARTS) {
    fail('count_invalid', 'Snapshot count exceeds a protocol limit.');
  }
  const required = SNAPSHOT_HEADER_BYTES
    + kartCount * KART_RECORD_BYTES
    + projectileCount * PROJECTILE_RECORD_BYTES
    + hazardCount * HAZARD_RECORD_BYTES
    + Math.ceil(itemBoxCount / 8)
    + itemBoxCount * 4
    + ackCount * 9;
  if (required !== bytes.byteLength) fail('packet_length_invalid', 'Snapshot sections do not match packet length.');

  const karts = [];
  const seenKarts = new Set();
  for (let index = 0; index < kartCount; index++) {
    const decoded = readKart(view, offset);
    offset = decoded.offset;
    if (seenKarts.has(decoded.kart.index)) fail('kart_index_invalid', 'Snapshot contains duplicate kart indices.');
    seenKarts.add(decoded.kart.index);
    karts.push(decoded.kart);
  }
  const projectiles = [];
  for (let index = 0; index < projectileCount; index++) {
    const decoded = readProjectile(view, offset);
    offset = decoded.offset;
    projectiles.push(decoded.entity);
  }
  const hazards = [];
  for (let index = 0; index < hazardCount; index++) {
    const decoded = readHazard(view, offset);
    offset = decoded.offset;
    hazards.push(decoded.entity);
  }

  const activeBytes = Math.ceil(itemBoxCount / 8);
  const activeOffset = offset;
  offset += activeBytes;
  const itemBoxes = [];
  for (let index = 0; index < itemBoxCount; index++) {
    const active = Boolean(bytes[activeOffset + (index >> 3)] & (1 << (index & 7)));
    const respawnAt = uint32ToSeconds(view.getUint32(offset, true), { nullable: true });
    offset += 4;
    itemBoxes.push([active, respawnAt]);
  }

  const acks = [];
  for (let index = 0; index < ackCount; index++) {
    const kartIndex = view.getUint8(offset); offset += 1;
    if (kartIndex >= MAX_KARTS) fail('ack_invalid', 'ACK kart index is invalid.');
    const inputSeq = view.getInt32(offset, true); offset += 4;
    if (inputSeq < -1) fail('ack_invalid', 'ACK input sequence is invalid.');
    const useItemSeq = view.getUint32(offset, true); offset += 4;
    acks.push([kartIndex, inputSeq, useItemSeq]);
  }
  if (offset !== bytes.byteLength) fail('packet_length_invalid', 'Snapshot has trailing bytes.');
  return {
    v: PROTOCOL_VERSION,
    type: 'snapshot',
    wireRaceId,
    tick,
    serverTime,
    state,
    countdown,
    elapsed,
    laps,
    karts,
    projectiles,
    hazards,
    itemBoxes,
    acks,
  };
}

export function encodeInputPacket(input) {
  const buffer = new ArrayBuffer(BINARY_INPUT_PACKET_BYTES);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes.set(MAGIC, 0);
  view.setUint8(4, RACE_BINARY_CODEC_VERSION);
  view.setUint8(5, BINARY_PACKET_TYPES.INPUT);
  view.setUint16(6, BINARY_INPUT_PACKET_BYTES, true);
  const wireRaceId = uint(input?.wireRaceId, 0xffffffff, 'input.wireRaceId');
  if (wireRaceId === 0) fail('race_invalid', 'wireRaceId must be non-zero.');
  view.setUint32(8, wireRaceId, true);
  view.setUint32(12, uint(input?.seq, 0xffffffff, 'input.seq'), true);
  view.setUint32(16, uint(input?.useItemSeq, 0xffffffff, 'input.useItemSeq'), true);
  view.setUint16(20, normalizedToUint16(input?.throttle ?? 0, 'input.throttle'), true);
  view.setUint16(22, normalizedToUint16(input?.brake ?? 0, 'input.brake'), true);
  view.setInt16(24, signedNormalizedToInt16(input?.steer ?? 0, 'input.steer'), true);
  let flags = 0;
  if (input?.drift) flags |= 1 << 0;
  if (input?.lookBack) flags |= 1 << 1;
  view.setUint8(26, flags);
  view.setUint8(27, 0);
  return bytes;
}

export function decodeInputPacket(data) {
  const { bytes, view } = readPreamble(data, BINARY_PACKET_TYPES.INPUT);
  if (bytes.byteLength !== BINARY_INPUT_PACKET_BYTES) {
    fail('packet_length_invalid', 'Input packet must be exactly 28 bytes.');
  }
  const wireRaceId = view.getUint32(8, true);
  if (wireRaceId === 0) fail('race_invalid', 'wireRaceId must be non-zero.');
  const flags = view.getUint8(26);
  if (flags & ~0x03) fail('flags_invalid', 'Input flags contain unsupported bits.');
  if (view.getUint8(27) !== 0) fail('reserved_invalid', 'Input reserved byte must be zero.');
  return {
    v: PROTOCOL_VERSION,
    type: 'input',
    wireRaceId,
    seq: view.getUint32(12, true),
    useItemSeq: view.getUint32(16, true),
    throttle: view.getUint16(20, true) / 65535,
    brake: view.getUint16(22, true) / 65535,
    steer: view.getInt16(24, true) / 32767,
    drift: Boolean(flags & 1),
    lookBack: Boolean(flags & 2),
  };
}

export function binaryPacketType(data) {
  const bytes = viewOf(data);
  if (bytes.byteLength < PREAMBLE_BYTES) return null;
  for (let index = 0; index < MAGIC.length; index++) {
    if (bytes[index] !== MAGIC[index]) return null;
  }
  return bytes[5] ?? null;
}

export function binaryPacketHex(data) {
  const bytes = viewOf(data);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}
