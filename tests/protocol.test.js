import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_SEND_INTERVAL_MS,
  CLIENT_MESSAGE_TYPES,
  CLIENT_UPDATE_CLOSE_CODE,
  ERROR_CODES,
  MAX_CLIENT_BYTES_PER_SECOND,
  MAX_CLIENT_BYTE_BURST,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_CHAT_MESSAGE_LENGTH,
  PROTOCOL_VERSION,
  ROOM_STATES,
  ROOM_TYPES,
  SERVER_MESSAGE_TYPES,
  decodeKartSnapshot,
  encodeKartSnapshot,
  normalizeRoomCode,
  validateChatContent,
  validateClientMessage,
} from '../src/net/protocol.js';

test('protocol v5 exports Lobby, Room, progression, loading ACK, and matchmaking message names', () => {
  assert.equal(PROTOCOL_VERSION, 5);
  assert.equal(CLIENT_UPDATE_CLOSE_CODE, 4006);
  assert.equal(CLIENT_MESSAGE_TYPES.ENTER_LOBBY, 'enter_lobby');
  assert.equal(CLIENT_MESSAGE_TYPES.CREATE_ROOM, 'create_room');
  assert.equal(CLIENT_MESSAGE_TYPES.QUICK_MATCH, 'quick_match');
  assert.equal(CLIENT_MESSAGE_TYPES.SET_LOADOUT, 'set_loadout');
  assert.equal(CLIENT_MESSAGE_TYPES.SEND_CHAT, 'send_chat');
  assert.equal(CLIENT_MESSAGE_TYPES.RETURN_ROOM, 'return_room');
  assert.equal(CLIENT_MESSAGE_TYPES.LEAVE_ROOM, 'leave_room');
  assert.equal(CLIENT_MESSAGE_TYPES.KICK_PLAYER, 'kick_player');
  assert.equal(SERVER_MESSAGE_TYPES.LOBBY_STATE, 'lobby_state');
  assert.equal(SERVER_MESSAGE_TYPES.ROOM_CHAT, 'room_chat');
  assert.equal(SERVER_MESSAGE_TYPES.KICKED, 'kicked');
  assert.equal(SERVER_MESSAGE_TYPES.PREPARE_RACE, 'prepare_race');
  assert.equal(SERVER_MESSAGE_TYPES.RACE_LOADED_ACK, 'race_loaded_ack');
  assert.equal(SERVER_MESSAGE_TYPES.SERVER_STATS, 'server_stats');
  assert.equal(SERVER_MESSAGE_TYPES.USER_PROGRESSION, 'user_progression');
  assert.equal(ROOM_STATES.WAITING, 'waiting');
  assert.equal(ROOM_TYPES.PUBLIC, 'public');
  assert.equal(ROOM_TYPES.PRIVATE, 'private');
  assert.equal(MAX_CLIENT_MESSAGE_BYTES, 2 * 1024);
  assert.equal(MAX_CLIENT_BYTES_PER_SECOND, 64 * 1024);
  assert.equal(MAX_CLIENT_BYTE_BURST, 128 * 1024);
  assert.equal(CHAT_SEND_INTERVAL_MS, 3_000);
  assert.equal(MAX_CHAT_MESSAGE_LENGTH, 200);
});

test('room chat validation trims visible content and enforces its bounded text shape', () => {
  assert.deepEqual(validateClientMessage({
    type: 'send_chat', v: PROTOCOL_VERSION, content: '  Final lap!  ', ignored: true,
  }), {
    ok: true,
    value: { type: 'send_chat', v: PROTOCOL_VERSION, content: 'Final lap!' },
  });
  assert.deepEqual(validateChatContent('🏁 Go!'), { ok: true, value: '🏁 Go!' });
  assert.equal(validateChatContent('   ').error.code, ERROR_CODES.INVALID_MESSAGE);
  assert.equal(validateChatContent('bad\u202etext').error.code, ERROR_CODES.INVALID_MESSAGE);
  assert.equal(
    validateChatContent('x'.repeat(MAX_CHAT_MESSAGE_LENGTH + 1)).error.code,
    ERROR_CODES.INVALID_MESSAGE,
  );
});

test('online loadouts validate atomically and can accompany room entry', () => {
  assert.deepEqual(validateClientMessage({
    type: 'set_loadout', v: PROTOCOL_VERSION,
    characterId: 'kit', paintId: 'turbo-blue', avatarId: 'cat', ignored: true,
  }), {
    ok: true,
    value: {
      type: 'set_loadout', v: PROTOCOL_VERSION,
      characterId: 'kit', paintId: 'turbo-blue', avatarId: 'cat',
    },
  });
  assert.equal(validateClientMessage({
    type: 'set_loadout', v: PROTOCOL_VERSION,
    characterId: 'kit', paintId: 'unknown', avatarId: 'cat',
  }).error.code, ERROR_CODES.PAINT_INVALID);
  assert.equal(validateClientMessage({
    type: 'set_loadout', v: PROTOCOL_VERSION,
    characterId: 'kit', paintId: 'turbo-blue', avatarId: 'unknown',
  }).error.code, ERROR_CODES.AVATAR_INVALID);

  const join = validateClientMessage({
    type: 'join_room', v: PROTOCOL_VERSION, roomCode: 'ABC234', displayName: 'Kit',
    characterId: 'kit', paintId: 'pearl-flash', avatarId: 'rabbit',
  });
  assert.equal(join.ok, true);
  assert.deepEqual(join.value, {
    type: 'join_room', v: PROTOCOL_VERSION, roomCode: 'ABC234',
    characterId: 'kit', paintId: 'pearl-flash', avatarId: 'rabbit',
  });
});

test('room settings accept AI auto-fill and kick-player validates its target id', () => {
  assert.deepEqual(validateClientMessage({
    type: 'set_room', v: PROTOCOL_VERSION, autoFillAi: false,
  }), {
    ok: true,
    value: { type: 'set_room', v: PROTOCOL_VERSION, autoFillAi: false },
  });
  assert.equal(
    validateClientMessage({ type: 'set_room', v: PROTOCOL_VERSION, autoFillAi: 'yes' }).error.code,
    ERROR_CODES.INVALID_SETTING,
  );
  assert.deepEqual(validateClientMessage({
    type: 'kick_player', v: PROTOCOL_VERSION, participantId: 'participant_002', ignored: true,
  }), {
    ok: true,
    value: { type: 'kick_player', v: PROTOCOL_VERSION, participantId: 'participant_002' },
  });
  assert.equal(
    validateClientMessage({ type: 'kick_player', v: PROTOCOL_VERSION, participantId: 'short' }).error.code,
    ERROR_CODES.INVALID_MESSAGE,
  );
});

test('create-room validation normalizes metadata and keeps a private password case-sensitive', () => {
  const result = validateClientMessage({
    type: 'create_room',
    v: PROTOCOL_VERSION,
    displayName: '  Nova  ',
    roomName: '  Nova   Night  ',
    roomType: 'PRIVATE',
    maxPlayers: 6,
    trackId: 'harbor-loop',
    password: 'PitLane9',
    ignored: 'not public protocol data',
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      type: 'create_room',
      v: PROTOCOL_VERSION,
      roomName: 'Nova Night',
      roomType: 'private',
      maxPlayers: 6,
      trackId: 'harbor-loop',
      password: 'PitLane9',
    },
  });
});

test('create-room validation rejects invalid names, types, capacities, and private passwords', () => {
  const base = {
    type: 'create_room', v: PROTOCOL_VERSION, displayName: 'Pip', roomName: 'Sprint',
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
    validateClientMessage({ ...base, trackId: 'Not A Track' }).error.code,
    ERROR_CODES.INVALID_SETTING,
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
    v: PROTOCOL_VERSION,
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
    v: PROTOCOL_VERSION,
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
    v: PROTOCOL_VERSION,
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

test('protocol rejects old versions and ambiguous room codes while ignoring client names', () => {
  assert.equal(normalizeRoomCode(' abC234 '), 'ABC234');

  const badVersion = validateClientMessage({ type: 'ping', v: 1 });
  assert.equal(badVersion.ok, false);
  assert.equal(badVersion.error.code, ERROR_CODES.UNSUPPORTED_VERSION);

  const ignoredName = validateClientMessage({
    type: 'quick_match', v: PROTOCOL_VERSION, displayName: 'A\u202eB',
  });
  assert.deepEqual(ignoredName, {
    ok: true,
    value: { type: 'quick_match', v: PROTOCOL_VERSION },
  });

  const badCode = validateClientMessage({
    type: 'join_room', v: PROTOCOL_VERSION, roomCode: 'OI10LL', displayName: 'Pip',
  });
  assert.equal(badCode.ok, false);
  assert.equal(badCode.error.code, ERROR_CODES.ROOM_NOT_FOUND);
});

test('join validation accepts a code alias and optional password while ignoring nickname aliases', () => {
  const result = validateClientMessage({
    type: 'join_room', v: PROTOCOL_VERSION, code: 'abc234', nickname: '  Nova  ', password: 'PitLane9',
  });
  assert.deepEqual(result, {
    ok: true,
    value: {
      type: 'join_room',
      v: PROTOCOL_VERSION,
      roomCode: 'ABC234',
      password: 'PitLane9',
    },
  });
});

test('compact kart snapshots round-trip dynamic state without static roster fields', () => {
  const encoded = encodeKartSnapshot({
    index: 3,
    participantId: 'participant_003',
    displayName: 'Nova',
    characterId: 'nova',
    lapTimes: [12.5],
    x: 10.25,
    speed: 23,
    drifting: true,
    boostTimer: 0.5,
    item: 'shell',
    lap: 2,
    rank: 1,
    bestLap: 12.5,
    controls: { throttle: 1, brake: 0, steer: -0.5, drift: true, lookBack: false },
  }, 'takeover-ai');
  const decoded = decodeKartSnapshot(encoded);

  assert.equal(decoded.index, 3);
  assert.equal(decoded.controllerKind, 'takeover-ai');
  assert.equal(decoded.x, 10.25);
  assert.equal(decoded.speed, 23);
  assert.equal(decoded.drifting, true);
  assert.equal(decoded.boostTimer, 0.5);
  assert.equal(decoded.item, 'shell');
  assert.equal(decoded.lap, 2);
  assert.equal(decoded.rank, 1);
  assert.equal(decoded.bestLap, 12.5);
  assert.deepEqual(decoded.controls, {
    throttle: 1, brake: 0, steer: -0.5, drift: true, lookBack: false,
  });
  assert.equal(Object.hasOwn(decoded, 'participantId'), false);
  assert.equal(Object.hasOwn(decoded, 'displayName'), false);
  assert.equal(Object.hasOwn(decoded, 'characterId'), false);
  assert.equal(Object.hasOwn(decoded, 'lapTimes'), false);
});
