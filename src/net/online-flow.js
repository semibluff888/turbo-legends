// Pure routing decisions shared by main.js and online integration tests.

import {
  ERROR_CODES,
  ROOM_STATES,
  isValidRoomCode,
  normalizeRoomCode,
} from './protocol.js';

const CONNECTION_ERROR_CODES = new Set([
  'websocket_unavailable',
  'socket_error',
  'invalid_server_message',
  'protocol_mismatch',
  ERROR_CODES.UNSUPPORTED_VERSION,
]);

const ERROR_COPY = Object.freeze({
  [ERROR_CODES.ROOM_NAME_INVALID]: 'Room name must contain 1 to 32 visible characters.',
  [ERROR_CODES.ROOM_TYPE_INVALID]: 'Choose a valid room type.',
  [ERROR_CODES.ROOM_CAPACITY_INVALID]: 'Room size must be between 2 and 8 racers.',
  [ERROR_CODES.PASSWORD_REQUIRED]: 'Enter the room password.',
  [ERROR_CODES.PASSWORD_INVALID]: 'Incorrect room password.',
  [ERROR_CODES.NO_MATCHING_ROOM]: 'No available public rooms were found.',
  [ERROR_CODES.NAME_INVALID]: 'Nickname must contain 1 to 20 visible characters.',
  [ERROR_CODES.ROOM_CODE_INVALID]: 'The invite link has an invalid room code. Room codes must be exactly 6 valid characters.',
  [ERROR_CODES.ROOM_NOT_FOUND]: 'That room is no longer available.',
  [ERROR_CODES.ROOM_FULL]: 'That room is full.',
  [ERROR_CODES.ROOM_LOCKED]: 'That room cannot be joined while a race is in progress.',
  [ERROR_CODES.CHARACTER_TAKEN]: 'That racer is already selected.',
  [ERROR_CODES.PAINT_INVALID]: 'Choose a valid paint theme.',
  [ERROR_CODES.AVATAR_INVALID]: 'Choose a valid avatar.',
  [ERROR_CODES.NOT_READY]: 'Every connected racer must be ready.',
  [ERROR_CODES.NOT_ENOUGH_PLAYERS]: 'At least two racers are required to start.',
  [ERROR_CODES.SESSION_EXPIRED]: 'The reconnect window expired. Join the room again.',
});

export function onlineRoomPhase(roomState) {
  return String(roomState?.phase || roomState?.state || ROOM_STATES.WAITING);
}

export function invitationRoomRequest(search) {
  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  if (!params.has('room')) return { present: false, valid: false, code: '' };
  const code = normalizeRoomCode(params.get('room'));
  const valid = isValidRoomCode(code);
  return { present: true, valid, code: valid ? code : '' };
}

export function invitationRoomCode(search) {
  return invitationRoomRequest(search).code;
}

export function shouldResumeOnlineRoomSession({
  search = '', roomCode = '', participantId = '', resumeToken = '',
} = {}) {
  const sessionCode = normalizeRoomCode(roomCode);
  const inviteCode = invitationRoomCode(search);
  const invitationMatchesRoom = !inviteCode || inviteCode === sessionCode;
  return invitationMatchesRoom && Boolean(sessionCode && participantId && resumeToken);
}

/**
 * A fresh prepare always needs a load acknowledgement. Catch-up prepares only
 * need one when the authoritative room is still loading; countdown/racing/
 * results resumes must not send race_loaded into a non-loading room.
 */
export function shouldAcknowledgeRaceLoaded(prepareMessage, roomState) {
  if (!prepareMessage?.raceId) return false;
  if (!prepareMessage.resumed) return true;
  return onlineRoomPhase(roomState) === 'loading';
}

export function hasReturnedToOnlineRoom(roomState, participantId) {
  if (onlineRoomPhase(roomState) !== ROOM_STATES.RESULTS || !participantId) return false;
  const members = roomState?.members || roomState?.participants || roomState?.players || [];
  const local = Array.isArray(members)
    ? members.find((member) => String(member?.participantId || member?.id || '') === String(participantId))
    : null;
  return local?.postRaceState === 'room';
}

/** Non-waiting state must not replace a race that prepare_race already mounted. */
export function shouldPresentOnlineRoom(
  roomState,
  hasMountedOnlineRace = false,
  localParticipantId = '',
) {
  const phase = onlineRoomPhase(roomState);
  if (phase === ROOM_STATES.WAITING) return true;
  if (hasReturnedToOnlineRoom(roomState, localParticipantId)) return true;
  return phase === ROOM_STATES.LOADING && !hasMountedOnlineRace;
}

export function shouldUpdateOnlineRaceBehindPanel({ mode, paused, raceKind } = {}) {
  return raceKind === 'online'
    && paused === true
    && (mode === 'settings' || mode === 'help');
}

/** Business-rule errors do not imply that the WebSocket connection is down. */
export function isOnlineConnectionError(message) {
  return CONNECTION_ERROR_CODES.has(String(message?.code || ''));
}

/** Prefer stable protocol codes over server-authored prose in the UI. */
export function onlineErrorMessage(message, fallback = 'Online request failed.') {
  if (typeof message === 'string' && message) return message;
  const code = String(message?.code || '');
  return ERROR_COPY[code] || String(message?.message || fallback);
}
