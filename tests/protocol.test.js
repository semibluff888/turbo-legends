import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLIENT_MESSAGE_TYPES,
  ERROR_CODES,
  PROTOCOL_VERSION,
  SERVER_MESSAGE_TYPES,
  normalizeRoomCode,
  validateClientMessage,
} from '../src/net/protocol.js';

test('protocol v1 exports the documented client and server message names', () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(CLIENT_MESSAGE_TYPES.CREATE_ROOM, 'create_room');
  assert.equal(CLIENT_MESSAGE_TYPES.INPUT, 'input');
  assert.equal(SERVER_MESSAGE_TYPES.PREPARE_RACE, 'prepare_race');
  assert.equal(SERVER_MESSAGE_TYPES.RACE_RESULTS, 'race_results');
});

test('input validation clamps finite axes and preserves independent sequences', () => {
  const result = validateClientMessage({
    type: 'input',
    v: 1,
    raceId: 'race_identifier_123',
    seq: 9,
    useItemSeq: 4,
    throttle: 2,
    brake: -1,
    steer: -3,
    drift: true,
    lookBack: false,
    ignored: 'client-authoritative position',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    type: 'input',
    v: 1,
    raceId: 'race_identifier_123',
    seq: 9,
    useItemSeq: 4,
    throttle: 1,
    brake: 0,
    steer: -1,
    drift: true,
    lookBack: false,
  });
});

test('input validation rejects non-boolean button fields', () => {
  const result = validateClientMessage({
    type: 'input',
    v: 1,
    raceId: 'race_identifier_123',
    seq: 1,
    useItemSeq: 0,
    throttle: 1,
    brake: 0,
    steer: 0,
    drift: 1,
    lookBack: false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, ERROR_CODES.INVALID_MESSAGE);
});

test('protocol rejects bad versions, invalid names, and ambiguous room codes', () => {
  assert.equal(normalizeRoomCode(' abC234 '), 'ABC234');

  const badVersion = validateClientMessage({ type: 'ping', v: 2 });
  assert.equal(badVersion.ok, false);
  assert.equal(badVersion.error.code, ERROR_CODES.UNSUPPORTED_VERSION);

  const badName = validateClientMessage({ type: 'create_room', v: 1, displayName: 'A\u202eB' });
  assert.equal(badName.ok, false);
  assert.equal(badName.error.code, ERROR_CODES.NAME_INVALID);

  const badCode = validateClientMessage({
    type: 'join_room', v: 1, roomCode: 'OI10LL', displayName: 'Pip',
  });
  assert.equal(badCode.ok, false);
  assert.equal(badCode.error.code, ERROR_CODES.ROOM_NOT_FOUND);
});

test('entry validation accepts the browser client nickname/code aliases', () => {
  const result = validateClientMessage({
    type: 'join_room', v: 1, code: 'abc234', nickname: '  Nova  ',
  });
  assert.deepEqual(result, {
    ok: true,
    value: { type: 'join_room', v: 1, roomCode: 'ABC234', displayName: 'Nova' },
  });
});
