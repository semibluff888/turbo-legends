import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLIENT_MESSAGE_TYPES,
  ERROR_CODES,
  PROTOCOL_VERSION,
  ROOM_STATES,
  ROOM_TYPES,
  SERVER_MESSAGE_TYPES,
  normalizeRoomCode,
  validateClientMessage,
} from '../src/net/protocol.js';

test('protocol v2 exports Lobby, Room, and matchmaking message names', () => {
  assert.equal(PROTOCOL_VERSION, 2);
  assert.equal(CLIENT_MESSAGE_TYPES.ENTER_LOBBY, 'enter_lobby');
  assert.equal(CLIENT_MESSAGE_TYPES.CREATE_ROOM, 'create_room');
  assert.equal(CLIENT_MESSAGE_TYPES.QUICK_MATCH, 'quick_match');
  assert.equal(CLIENT_MESSAGE_TYPES.SET_LOADOUT, 'set_loadout');
  assert.equal(CLIENT_MESSAGE_TYPES.RETURN_ROOM, 'return_room');
  assert.equal(CLIENT_MESSAGE_TYPES.LEAVE_ROOM, 'leave_room');
  assert.equal(CLIENT_MESSAGE_TYPES.KICK_PLAYER, 'kick_player');
  assert.equal(SERVER_MESSAGE_TYPES.LOBBY_STATE, 'lobby_state');
  assert.equal(SERVER_MESSAGE_TYPES.KICKED, 'kicked');
  assert.equal(SERVER_MESSAGE_TYPES.PREPARE_RACE, 'prepare_race');
  assert.equal(SERVER_MESSAGE_TYPES.SERVER_STATS, 'server_stats');
  assert.equal(ROOM_STATES.WAITING, 'waiting');
  assert.equal(ROOM_TYPES.PUBLIC, 'public');
  assert.equal(ROOM_TYPES.PRIVATE, 'private');
});

test('online loadouts validate atomically and can accompany room entry', () => {
  assert.deepEqual(validateClientMessage({
    type: 'set_loadout', v: 2,
    characterId: 'kit', paintId: 'turbo-blue', avatarId: 'cat', ignored: true,
  }), {
    ok: true,
    value: {
      type: 'set_loadout', v: 2,
      characterId: 'kit', paintId: 'turbo-blue', avatarId: 'cat',
    },
  });
  assert.equal(validateClientMessage({
    type: 'set_loadout', v: 2,
    characterId: 'kit', paintId: 'unknown', avatarId: 'cat',
  }).error.code, ERROR_CODES.PAINT_INVALID);
  assert.equal(validateClientMessage({
    type: 'set_loadout', v: 2,
    characterId: 'kit', paintId: 'turbo-blue', avatarId: 'unknown',
  }).error.code, ERROR_CODES.AVATAR_INVALID);

  const join = validateClientMessage({
    type: 'join_room', v: 2, roomCode: 'ABC234', displayName: 'Kit',
    characterId: 'kit', paintId: 'pearl-flash', avatarId: 'rabbit',
  });
  assert.equal(join.ok, true);
  assert.deepEqual(join.value, {
    type: 'join_room', v: 2, roomCode: 'ABC234', displayName: 'Kit',
    characterId: 'kit', paintId: 'pearl-flash', avatarId: 'rabbit',
  });
});

test('room settings accept AI auto-fill and kick-player validates its target id', () => {
  assert.deepEqual(validateClientMessage({
    type: 'set_room', v: 2, autoFillAi: false,
  }), {
    ok: true,
    value: { type: 'set_room', v: 2, autoFillAi: false },
  });
  assert.equal(
    validateClientMessage({ type: 'set_room', v: 2, autoFillAi: 'yes' }).error.code,
    ERROR_CODES.INVALID_SETTING,
  );
  assert.deepEqual(validateClientMessage({
    type: 'kick_player', v: 2, participantId: 'participant_002', ignored: true,
  }), {
    ok: true,
    value: { type: 'kick_player', v: 2, participantId: 'participant_002' },
  });
  assert.equal(
    validateClientMessage({ type: 'kick_player', v: 2, participantId: 'short' }).error.code,
    ERROR_CODES.INVALID_MESSAGE,
  );
});

test('create-room validation normalizes metadata and keeps a private password case-sensitive', () => {
  const result = validateClientMessage({
    type: 'create_room',
    v: 2,
    displayName: '  Nova  ',
    roomName: '  Nova   Night  ',
    roomType: 'PRIVATE',
    maxPlayers: 6,
    password: 'PitLane9',
    ignored: 'not public protocol data',
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      type: 'create_room',
      v: 2,
      displayName: 'Nova',
      roomName: 'Nova Night',
      roomType: 'private',
      maxPlayers: 6,
      password: 'PitLane9',
    },
  });
});

test('create-room validation rejects invalid names, types, capacities, and private passwords', () => {
  const base = {
    type: 'create_room', v: 2, displayName: 'Pip', roomName: 'Sprint',
    roomType: 'public', maxPlayers: 8,
  };
  assert.equal(
    validateClientMessage({ ...base, roomName: 'A\u202eB' }).error.code,
    ERROR_CODES.ROOM_NAME_INVALID,
  );
  assert.equal(
    validateClientMessage({ ...base, roomType: 'ranked' }).error.code,
    ERROR_CODES.ROOM_TYPE_INVALID,
  );
  assert.equal(
    validateClientMessage({ ...base, maxPlayers: 9 }).error.code,
    ERROR_CODES.ROOM_CAPACITY_INVALID,
  );
  assert.equal(
    validateClientMessage({ ...base, roomType: 'private' }).error.code,
    ERROR_CODES.PASSWORD_REQUIRED,
  );
  assert.equal(
    validateClientMessage({ ...base, roomType: 'private', password: 'ab' }).error.code,
    ERROR_CODES.PASSWORD_INVALID,
  );
  assert.equal(
    validateClientMessage({ ...base, roomType: 'private', password: 'abc' }).ok,
    true,
  );
});

test('input validation clamps finite axes and preserves independent sequences', () => {
  const result = validateClientMessage({
    type: 'input',
    v: 2,
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
    v: 2,
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
    v: 2,
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

test('protocol rejects old versions, invalid names, and ambiguous room codes', () => {
  assert.equal(normalizeRoomCode(' abC234 '), 'ABC234');

  const badVersion = validateClientMessage({ type: 'ping', v: 1 });
  assert.equal(badVersion.ok, false);
  assert.equal(badVersion.error.code, ERROR_CODES.UNSUPPORTED_VERSION);

  const badName = validateClientMessage({
    type: 'quick_match', v: 2, displayName: 'A\u202eB',
  });
  assert.equal(badName.ok, false);
  assert.equal(badName.error.code, ERROR_CODES.NAME_INVALID);

  const badCode = validateClientMessage({
    type: 'join_room', v: 2, roomCode: 'OI10LL', displayName: 'Pip',
  });
  assert.equal(badCode.ok, false);
  assert.equal(badCode.error.code, ERROR_CODES.ROOM_NOT_FOUND);
});

test('join validation accepts nickname/code aliases and an optional password', () => {
  const result = validateClientMessage({
    type: 'join_room', v: 2, code: 'abc234', nickname: '  Nova  ', password: 'PitLane9',
  });
  assert.deepEqual(result, {
    ok: true,
    value: {
      type: 'join_room',
      v: 2,
      roomCode: 'ABC234',
      password: 'PitLane9',
      displayName: 'Nova',
    },
  });
});
