// Turbo Legends multiplayer protocol v5.
//
// This module is intentionally browser-safe: both the Node server and the
// native browser WebSocket client import the same message names and input
// validator, preventing the two sides from silently drifting apart.

import { isAvatarId, isPaintId } from '../game/appearance.js';

export const PROTOCOL_VERSION = 5;
export const CLIENT_UPDATE_CLOSE_CODE = 4006;
export const MAX_CLIENT_MESSAGE_BYTES = 2 * 1024;
export const MAX_CLIENT_MESSAGES_PER_SECOND = 120;
export const MAX_CLIENT_MESSAGE_BURST = 180;
export const MAX_CLIENT_BYTES_PER_SECOND = 64 * 1024;
export const MAX_CLIENT_BYTE_BURST = 128 * 1024;

export const CLIENT_MESSAGE_TYPES = Object.freeze({
  ENTER_LOBBY: 'enter_lobby',
  CREATE_ROOM: 'create_room',
  JOIN_ROOM: 'join_room',
  QUICK_MATCH: 'quick_match',
  RESUME: 'resume',
  SELECT_CHARACTER: 'select_character',
  SET_LOADOUT: 'set_loadout',
  SET_ROOM: 'set_room',
  SET_READY: 'set_ready',
  KICK_PLAYER: 'kick_player',
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
  KICKED: 'kicked',
  PREPARE_RACE: 'prepare_race',
  RACE_LOADED_ACK: 'race_loaded_ack',
  SNAPSHOT: 'snapshot',
  RACE_EVENTS: 'race_events',
  RACE_RESULTS: 'race_results',
  USER_PROGRESSION: 'user_progression',
  ERROR: 'error',
  PONG: 'pong',
  SERVER_STATS: 'server_stats',
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

// Legacy compact Kart helpers remain available for simulation fixtures and
// low-level compatibility tests. Protocol v4 race traffic uses the shared
// binary codec in binary-race-codec.js.
// The announced prepare_race roster remains the source of static identity and
// appearance data; snapshots only carry fields that can change during a race.
export const SNAPSHOT_KART_FIELDS = Object.freeze([
  'x', 'y', 'z', 'yaw', 'vx', 'vy', 'vz', 'speed', 'airborne',
  'visualYawOffset', 'visualRoll', 'visualPitch', 'visualScale', 'wheelSpin',
  'steerAngle', 'drifting', 'driftDirection', 'driftCharge', 'driftTier', 'hopTimer',
  'boostTimer', 'boostPower', 'boostSource', 'speedMul', 'draftCharge',
  'state', 'stateTimer', 'aiSpeedMul', 'startPenaltyTimer', 'invulnTimer',
  'starTimer', 'shrinkTimer', 'spinDirection',
  'item', 'itemUses', 'rouletteTimer', 'rouletteFace', 'pendingItem', 'heldCount',
  's', 'lateral', 'surface', 'offTrackDepth', 'progress', 'lap', 'rank',
  'finished', 'finishTime', 'currentLapStart', 'bestLap', 'wrongWay', 'prevX', 'prevZ',
]);

export const SNAPSHOT_CONTROL_FIELDS = Object.freeze([
  'throttle', 'brake', 'steer', 'drift', 'lookBack',
]);

function snapshotValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return value === undefined ? null : value;
}

/** Encode one authoritative Kart into the legacy compact fixture shape. */
export function encodeKartSnapshot(kart, controllerKind = kart?.controllerKind) {
  const controls = kart?.controls || {};
  return [
    Number.isInteger(kart?.index) ? kart.index : null,
    controllerKind ?? null,
    SNAPSHOT_KART_FIELDS.map((field) => snapshotValue(kart?.[field])),
    SNAPSHOT_CONTROL_FIELDS.map((field) => snapshotValue(controls[field])),
  ];
}

/** Decode one compact Kart snapshot for the existing Kart-shaped client view. */
export function decodeKartSnapshot(encoded) {
  if (!Array.isArray(encoded)) {
    return encoded && typeof encoded === 'object' ? encoded : null;
  }
  const [index, controllerKind, fields, controls] = encoded;
  if (!Number.isInteger(index) || !Array.isArray(fields)) return null;
  const decoded = { index };
  if (controllerKind !== null && controllerKind !== undefined) {
    decoded.controllerKind = controllerKind;
  }
  for (let i = 0; i < SNAPSHOT_KART_FIELDS.length; i++) {
    if (i < fields.length) decoded[SNAPSHOT_KART_FIELDS[i]] = fields[i];
  }
  if (Array.isArray(controls)) {
    decoded.controls = {};
    for (let i = 0; i < SNAPSHOT_CONTROL_FIELDS.length; i++) {
      if (i < controls.length) decoded.controls[SNAPSHOT_CONTROL_FIELDS[i]] = controls[i];
    }
  }
  return decoded;
}

export const ERROR_CODES = Object.freeze({
  INVALID_JSON: 'invalid_json',
  INVALID_MESSAGE: 'invalid_message',
  UNSUPPORTED_VERSION: 'unsupported_version',
  UNKNOWN_MESSAGE: 'unknown_message',
  NOT_IN_ROOM: 'not_in_room',
  ALREADY_IN_ROOM: 'already_in_room',
  ROOM_CODE_INVALID: 'room_code_invalid',
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
  CHARACTER_LOCKED: 'character_locked',
  CHARACTER_TAKEN: 'character_taken',
  PAINT_INVALID: 'paint_invalid',
  AVATAR_INVALID: 'avatar_invalid',
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
  CLIENT_UPDATE_REQUIRED: 'client_update_required',
  AUTHENTICATION_REQUIRED: 'authentication_required',
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
    return fail(ERROR_CODES.PASSWORD_INVALID, 'Password must contain 3 to 20 visible characters.');
  }
  const length = Array.from(value).length;
  if (length < 3 || length > 20 || value.trim() !== value || CONTROL_OR_BIDI.test(value)) {
    return fail(ERROR_CODES.PASSWORD_INVALID, 'Password must contain 3 to 20 visible characters.');
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
      if (!optionalId(message.characterId)) {
        return fail(ERROR_CODES.CHARACTER_INVALID, 'Invalid character id.');
      }
      if (message.paintId !== undefined && !isPaintId(message.paintId)) {
        return fail(ERROR_CODES.PAINT_INVALID, 'Invalid paint id.');
      }
      if (message.avatarId !== undefined && !isAvatarId(message.avatarId)) {
        return fail(ERROR_CODES.AVATAR_INVALID, 'Invalid avatar id.');
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
        if (!optionalId(message.trackId)) {
          return fail(ERROR_CODES.INVALID_SETTING, 'Invalid track id.');
        }
        if (message.trackId !== undefined) base.trackId = message.trackId;
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
      if (message.characterId !== undefined) base.characterId = message.characterId;
      if (message.paintId !== undefined) base.paintId = message.paintId;
      if (message.avatarId !== undefined) base.avatarId = message.avatarId;
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

    case CLIENT_MESSAGE_TYPES.SET_LOADOUT:
      if (typeof message.characterId !== 'string' || !ID_PATTERN.test(message.characterId)) {
        return fail(ERROR_CODES.CHARACTER_INVALID, 'Invalid character id.');
      }
      if (!isPaintId(message.paintId)) {
        return fail(ERROR_CODES.PAINT_INVALID, 'Invalid paint id.');
      }
      if (!isAvatarId(message.avatarId)) {
        return fail(ERROR_CODES.AVATAR_INVALID, 'Invalid avatar id.');
      }
      return {
        ok: true,
        value: {
          ...base,
          characterId: message.characterId,
          paintId: message.paintId,
          avatarId: message.avatarId,
        },
      };

    case CLIENT_MESSAGE_TYPES.SET_ROOM: {
      if (message.trackId === undefined
        && message.difficulty === undefined
        && message.autoFillAi === undefined) {
        return fail(ERROR_CODES.INVALID_SETTING, 'A room setting is required.');
      }
      if (!optionalId(message.trackId)
        || !optionalId(message.difficulty)
        || (message.autoFillAi !== undefined && typeof message.autoFillAi !== 'boolean')) {
        return fail(ERROR_CODES.INVALID_SETTING, 'Invalid room setting.');
      }
      const value = { ...base };
      if (message.trackId !== undefined) value.trackId = message.trackId;
      if (message.difficulty !== undefined) value.difficulty = message.difficulty;
      if (message.autoFillAi !== undefined) value.autoFillAi = message.autoFillAi;
      return { ok: true, value };
    }

    case CLIENT_MESSAGE_TYPES.KICK_PLAYER:
      if (typeof message.participantId !== 'string'
        || !OPAQUE_ID_PATTERN.test(message.participantId)) {
        return fail(ERROR_CODES.INVALID_MESSAGE, 'A valid participant id is required.');
      }
      return { ok: true, value: { ...base, participantId: message.participantId } };

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
