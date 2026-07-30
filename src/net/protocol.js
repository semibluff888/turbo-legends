// Turbo Legends multiplayer protocol v2.
//
// This module is intentionally browser-safe: both the Node server and the
// native browser WebSocket client import the same message names and input
// validator, preventing the two sides from silently drifting apart.

export const PROTOCOL_VERSION = 2;
export const MAX_CLIENT_MESSAGE_BYTES = 16 * 1024;
export const MAX_CLIENT_MESSAGES_PER_SECOND = 90;

export const CLIENT_MESSAGE_TYPES = Object.freeze({
  ENTER_LOBBY: 'enter_lobby',
  CREATE_ROOM: 'create_room',
  JOIN_ROOM: 'join_room',
  QUICK_MATCH: 'quick_match',
  RESUME: 'resume',
  SELECT_CHARACTER: 'select_character',
  SET_ROOM: 'set_room',
  SET_READY: 'set_ready',
  START_RACE: 'start_race',
  RACE_LOADED: 'race_loaded',
  INPUT: 'input',
  RETURN_ROOM: 'return_room',
  LEAVE_ROOM: 'leave_room',
  PING: 'ping',
});

export const SERVER_MESSAGE_TYPES = Object.freeze({
  WELCOME: 'welcome',
  LOBBY_STATE: 'lobby_state',
  ROOM_STATE: 'room_state',
  PREPARE_RACE: 'prepare_race',
  SNAPSHOT: 'snapshot',
  RACE_EVENTS: 'race_events',
  RACE_RESULTS: 'race_results',
  ERROR: 'error',
  PONG: 'pong',
});

// Short aliases are useful to UI code while the longer names remain the
// canonical public exports documented by the multiplayer plan.
export const CLIENT_MESSAGES = CLIENT_MESSAGE_TYPES;
export const SERVER_MESSAGES = SERVER_MESSAGE_TYPES;

export const ROOM_STATES = Object.freeze({
  WAITING: 'waiting',
  LOADING: 'loading',
  COUNTDOWN: 'countdown',
  RACING: 'racing',
  RESULTS: 'results',
});

export const ROOM_TYPES = Object.freeze({
  PUBLIC: 'public',
  PRIVATE: 'private',
});

export const CONTROLLER_KINDS = Object.freeze({
  HUMAN: 'human',
  AI: 'ai',
  TAKEOVER_AI: 'takeover-ai',
});

export const ERROR_CODES = Object.freeze({
  INVALID_JSON: 'invalid_json',
  INVALID_MESSAGE: 'invalid_message',
  UNSUPPORTED_VERSION: 'unsupported_version',
  UNKNOWN_MESSAGE: 'unknown_message',
  NOT_IN_ROOM: 'not_in_room',
  ALREADY_IN_ROOM: 'already_in_room',
  ROOM_NOT_FOUND: 'room_not_found',
  ROOM_FULL: 'room_full',
  ROOM_LOCKED: 'room_locked',
  ROOM_NAME_INVALID: 'room_name_invalid',
  ROOM_TYPE_INVALID: 'room_type_invalid',
  ROOM_CAPACITY_INVALID: 'room_capacity_invalid',
  PASSWORD_REQUIRED: 'password_required',
  PASSWORD_INVALID: 'password_invalid',
  NO_MATCHING_ROOM: 'no_matching_room',
  NAME_INVALID: 'name_invalid',
  CHARACTER_INVALID: 'character_invalid',
  CHARACTER_TAKEN: 'character_taken',
  FORBIDDEN: 'forbidden',
  INVALID_STATE: 'invalid_state',
  INVALID_SETTING: 'invalid_setting',
  NOT_READY: 'not_ready',
  NOT_ENOUGH_PLAYERS: 'not_enough_players',
  SESSION_NOT_FOUND: 'session_not_found',
  SESSION_EXPIRED: 'session_expired',
  RACE_MISMATCH: 'race_mismatch',
  RATE_LIMITED: 'rate_limited',
  SERVER_BUSY: 'server_busy',
  INTERNAL_ERROR: 'internal_error',
});

const CLIENT_TYPE_SET = new Set(Object.values(CLIENT_MESSAGE_TYPES));
const ROOM_TYPE_SET = new Set(Object.values(ROOM_TYPES));
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{12,128}$/;
const ROOM_CODE_PATTERN = /^[A-HJ-KM-NP-Z2-9]{6}$/;

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function optionalId(value) {
  return value === undefined || (typeof value === 'string' && ID_PATTERN.test(value));
}

export function normalizeRoomCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

export function isValidRoomCode(value) {
  return ROOM_CODE_PATTERN.test(normalizeRoomCode(value));
}

export function normalizeDisplayName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/gu, ' ');
}

export function normalizeRoomName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/gu, ' ');
}

export function validateRoomName(value) {
  const roomName = normalizeRoomName(value);
  const length = Array.from(roomName).length;
  if (length < 1 || length > 32 || CONTROL_OR_BIDI.test(roomName)) {
    return fail(ERROR_CODES.ROOM_NAME_INVALID, 'Room name must contain 1 to 32 visible characters.');
  }
  return { ok: true, value: roomName };
}

export function normalizeRoomType(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function validateRoomType(value) {
  const roomType = normalizeRoomType(value);
  if (!ROOM_TYPE_SET.has(roomType)) {
    return fail(ERROR_CODES.ROOM_TYPE_INVALID, 'Room type must be public or private.');
  }
  return { ok: true, value: roomType };
}

export function validateRoomCapacity(value) {
  if (!Number.isSafeInteger(value) || value < 2 || value > 8) {
    return fail(ERROR_CODES.ROOM_CAPACITY_INVALID, 'Room capacity must be an integer from 2 to 8.');
  }
  return { ok: true, value };
}

export function validateRoomPassword(value, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    return required
      ? fail(ERROR_CODES.PASSWORD_REQUIRED, 'A password is required for a private room.')
      : { ok: true, value: undefined };
  }
  if (typeof value !== 'string') {
    return fail(ERROR_CODES.PASSWORD_INVALID, 'Password must contain 4 to 20 visible characters.');
  }
  const length = Array.from(value).length;
  if (length < 4 || length > 20 || value.trim() !== value || CONTROL_OR_BIDI.test(value)) {
    return fail(ERROR_CODES.PASSWORD_INVALID, 'Password must contain 4 to 20 visible characters.');
  }
  return { ok: true, value };
}

export function validateDisplayName(value) {
  const displayName = normalizeDisplayName(value);
  const length = Array.from(displayName).length;
  if (length < 1 || length > 20 || CONTROL_OR_BIDI.test(displayName)) {
    return fail(ERROR_CODES.NAME_INVALID, 'Nickname must contain 1 to 20 visible characters.');
  }
  return { ok: true, value: displayName };
}

export function parseClientMessage(data) {
  let value;
  try {
    value = JSON.parse(typeof data === 'string' ? data : String(data));
  } catch {
    return fail(ERROR_CODES.INVALID_JSON, 'Message must be valid JSON.');
  }
  return validateClientMessage(value);
}

/**
 * Validate and normalize a client message. Unknown extra fields are ignored;
 * the returned value is a fresh object containing only protocol fields.
 */
export function validateClientMessage(message) {
  if (!isRecord(message) || typeof message.type !== 'string') {
    return fail(ERROR_CODES.INVALID_MESSAGE, 'Message must be a JSON object with a type.');
  }
  if (message.v !== PROTOCOL_VERSION) {
    return fail(ERROR_CODES.UNSUPPORTED_VERSION, `Protocol version ${PROTOCOL_VERSION} is required.`);
  }
  if (!CLIENT_TYPE_SET.has(message.type)) {
    return fail(ERROR_CODES.UNKNOWN_MESSAGE, 'Unknown message type.');
  }

  const base = { type: message.type, v: PROTOCOL_VERSION };
  switch (message.type) {
    case CLIENT_MESSAGE_TYPES.CREATE_ROOM:
    case CLIENT_MESSAGE_TYPES.JOIN_ROOM:
    case CLIENT_MESSAGE_TYPES.QUICK_MATCH: {
      const name = validateDisplayName(message.displayName ?? message.nickname);
      if (!name.ok) return name;
      if (!optionalId(message.characterId)) {
        return fail(ERROR_CODES.CHARACTER_INVALID, 'Invalid character id.');
      }
      if (message.type === CLIENT_MESSAGE_TYPES.CREATE_ROOM) {
        const roomName = validateRoomName(message.roomName);
        if (!roomName.ok) return roomName;
        const roomType = validateRoomType(message.roomType);
        if (!roomType.ok) return roomType;
        const capacity = validateRoomCapacity(message.maxPlayers);
        if (!capacity.ok) return capacity;
        const password = validateRoomPassword(message.password, {
          required: roomType.value === ROOM_TYPES.PRIVATE,
        });
        if (!password.ok) return password;
        base.roomName = roomName.value;
        base.roomType = roomType.value;
        base.maxPlayers = capacity.value;
        if (roomType.value === ROOM_TYPES.PRIVATE) base.password = password.value;
      } else if (message.type === CLIENT_MESSAGE_TYPES.JOIN_ROOM) {
        const roomCode = normalizeRoomCode(message.roomCode ?? message.code);
        if (!ROOM_CODE_PATTERN.test(roomCode)) {
          return fail(ERROR_CODES.ROOM_NOT_FOUND, 'Invalid room code.');
        }
        base.roomCode = roomCode;
        const password = validateRoomPassword(message.password);
        if (!password.ok) return password;
        if (password.value !== undefined) base.password = password.value;
      }
      base.displayName = name.value;
      if (message.characterId !== undefined) base.characterId = message.characterId;
      return { ok: true, value: base };
    }

    case CLIENT_MESSAGE_TYPES.RESUME: {
      const roomCode = normalizeRoomCode(message.roomCode ?? message.code);
      if (!ROOM_CODE_PATTERN.test(roomCode)
        || typeof message.participantId !== 'string'
        || !OPAQUE_ID_PATTERN.test(message.participantId)
        || typeof message.resumeToken !== 'string'
        || !OPAQUE_ID_PATTERN.test(message.resumeToken)) {
        return fail(ERROR_CODES.SESSION_NOT_FOUND, 'Invalid resume credentials.');
      }
      return {
        ok: true,
        value: { ...base, roomCode, participantId: message.participantId, resumeToken: message.resumeToken },
      };
    }

    case CLIENT_MESSAGE_TYPES.SELECT_CHARACTER:
      if (typeof message.characterId !== 'string' || !ID_PATTERN.test(message.characterId)) {
        return fail(ERROR_CODES.CHARACTER_INVALID, 'Invalid character id.');
      }
      return { ok: true, value: { ...base, characterId: message.characterId } };

    case CLIENT_MESSAGE_TYPES.SET_ROOM: {
      if (message.trackId === undefined && message.difficulty === undefined) {
        return fail(ERROR_CODES.INVALID_SETTING, 'A track or difficulty is required.');
      }
      if (!optionalId(message.trackId) || !optionalId(message.difficulty)) {
        return fail(ERROR_CODES.INVALID_SETTING, 'Invalid room setting.');
      }
      const value = { ...base };
      if (message.trackId !== undefined) value.trackId = message.trackId;
      if (message.difficulty !== undefined) value.difficulty = message.difficulty;
      return { ok: true, value };
    }

    case CLIENT_MESSAGE_TYPES.SET_READY:
      if (typeof message.ready !== 'boolean') {
        return fail(ERROR_CODES.INVALID_MESSAGE, 'Ready must be a boolean.');
      }
      return { ok: true, value: { ...base, ready: message.ready } };

    case CLIENT_MESSAGE_TYPES.RACE_LOADED:
      if (typeof message.raceId !== 'string' || !OPAQUE_ID_PATTERN.test(message.raceId)) {
        return fail(ERROR_CODES.RACE_MISMATCH, 'Invalid race id.');
      }
      return { ok: true, value: { ...base, raceId: message.raceId } };

    case CLIENT_MESSAGE_TYPES.INPUT: {
      if (typeof message.raceId !== 'string' || !OPAQUE_ID_PATTERN.test(message.raceId)) {
        return fail(ERROR_CODES.RACE_MISMATCH, 'Invalid race id.');
      }
      if (!nonNegativeInteger(message.seq) || !nonNegativeInteger(message.useItemSeq)
        || !finiteNumber(message.throttle) || !finiteNumber(message.brake)
        || !finiteNumber(message.steer)) {
        return fail(ERROR_CODES.INVALID_MESSAGE, 'Input sequence and axes must be finite numbers.');
      }
      if (typeof message.drift !== 'boolean' || typeof message.lookBack !== 'boolean') {
        return fail(ERROR_CODES.INVALID_MESSAGE, 'Input buttons must be booleans.');
      }
      return {
        ok: true,
        value: {
          ...base,
          raceId: message.raceId,
          seq: message.seq,
          useItemSeq: message.useItemSeq,
          throttle: Math.max(0, Math.min(1, message.throttle)),
          brake: Math.max(0, Math.min(1, message.brake)),
          steer: Math.max(-1, Math.min(1, message.steer)),
          drift: message.drift,
          lookBack: message.lookBack,
        },
      };
    }

    case CLIENT_MESSAGE_TYPES.PING:
      if (message.clientTime !== undefined && !finiteNumber(message.clientTime)) {
        return fail(ERROR_CODES.INVALID_MESSAGE, 'clientTime must be finite.');
      }
      return {
        ok: true,
        value: message.clientTime === undefined ? base : { ...base, clientTime: message.clientTime },
      };

    case CLIENT_MESSAGE_TYPES.ENTER_LOBBY:
    case CLIENT_MESSAGE_TYPES.START_RACE:
    case CLIENT_MESSAGE_TYPES.RETURN_ROOM:
    case CLIENT_MESSAGE_TYPES.LEAVE_ROOM:
      return { ok: true, value: base };

    default:
      return fail(ERROR_CODES.UNKNOWN_MESSAGE, 'Unknown message type.');
  }
}

export function serverMessage(type, fields = {}) {
  return { type, v: PROTOCOL_VERSION, ...fields };
}
