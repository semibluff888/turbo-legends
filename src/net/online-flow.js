// Pure routing decisions shared by main.js and online integration tests.

import { isValidRoomCode, normalizeRoomCode } from './protocol.js';

const CONNECTION_ERROR_CODES = new Set([
  'websocket_unavailable',
  'socket_error',
  'invalid_server_message',
  'protocol_mismatch',
]);

export function onlineRoomPhase(roomState) {
  return String(roomState?.phase || roomState?.state || 'lobby');
}

export function invitationRoomCode(search) {
  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const code = normalizeRoomCode(params.get('room'));
  return isValidRoomCode(code) ? code : '';
}

export function shouldResumeStoredOnlineSession({
  search = '', roomCode = '', participantId = '', resumeToken = '',
} = {}) {
  const storedCode = normalizeRoomCode(roomCode);
  const inviteCode = invitationRoomCode(search);
  const invitationMatchesStoredRoom = !inviteCode || inviteCode === storedCode;
  return invitationMatchesStoredRoom && Boolean(storedCode && participantId && resumeToken);
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

/** Non-lobby state must not replace a race that prepare_race already mounted. */
export function shouldPresentOnlineLobby(roomState, hasMountedOnlineRace = false) {
  const phase = onlineRoomPhase(roomState);
  if (phase === 'lobby') return true;
  return phase === 'loading' && !hasMountedOnlineRace;
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
