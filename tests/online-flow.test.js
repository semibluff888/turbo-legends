import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasReturnedToOnlineRoom,
  invitationRoomCode,
  invitationRoomRequest,
  isOnlineConnectionError,
  onlineErrorMessage,
  shouldAcknowledgeRaceLoaded,
  shouldPresentOnlineRoom,
  shouldResumeOnlineRoomSession,
  shouldUpdateOnlineRaceBehindPanel,
} from '../src/net/online-flow.js';

test('an invite link wins over unrelated in-memory reconnect credentials', () => {
  assert.equal(invitationRoomCode('?room=FAST22'), 'FAST22');
  assert.equal(shouldResumeOnlineRoomSession({
    search: '?room=FAST22',
    roomCode: 'OLD234',
    participantId: 'participant',
    resumeToken: 'token',
  }), false);
  assert.equal(shouldResumeOnlineRoomSession({
    roomCode: 'OLD234',
    participantId: 'participant',
    resumeToken: 'token',
  }), true);
  assert.equal(shouldResumeOnlineRoomSession({
    search: '?room=OLD234',
    roomCode: 'old234',
    participantId: 'participant',
    resumeToken: 'token',
  }), true);
});

test('invalid invite parameters are distinguishable from a missing room parameter', () => {
  assert.deepEqual(invitationRoomRequest(''), {
    present: false, valid: false, code: '',
  });
  assert.deepEqual(invitationRoomRequest('?room=FAST22'), {
    present: true, valid: true, code: 'FAST22',
  });
  for (const search of ['?room=', '?room=FAST2', '?room=FAST222', '?room=ABC01I']) {
    assert.deepEqual(invitationRoomRequest(search), {
      present: true, valid: false, code: '',
    });
    assert.equal(invitationRoomCode(search), '');
  }
});

test('loading Room state cannot replace a race already mounted from prepare_race', () => {
  assert.equal(shouldPresentOnlineRoom({ state: 'loading' }, false), true);
  assert.equal(shouldPresentOnlineRoom({ state: 'loading' }, true), false);
  assert.equal(shouldPresentOnlineRoom({ state: 'countdown' }, true), false);
  assert.equal(shouldPresentOnlineRoom({ state: 'racing' }, true), false);
  assert.equal(shouldPresentOnlineRoom({ state: 'waiting' }, true), true);
});

test('a participant who returned from results is routed to the Room independently', () => {
  const room = {
    state: 'results',
    members: [
      { participantId: 'host', postRaceState: 'room' },
      { participantId: 'guest', postRaceState: 'results' },
    ],
  };
  assert.equal(hasReturnedToOnlineRoom(room, 'host'), true);
  assert.equal(hasReturnedToOnlineRoom(room, 'guest'), false);
  assert.equal(shouldPresentOnlineRoom(room, true, 'host'), true);
  assert.equal(shouldPresentOnlineRoom(room, true, 'guest'), false);
});

test('a warmed scene submits race_loaded unless the v3 ACK is already cached', () => {
  const prepare = { raceId: 'race-id-1234', resumed: true };
  assert.equal(shouldAcknowledgeRaceLoaded(prepare, false), true);
  assert.equal(shouldAcknowledgeRaceLoaded(prepare, null), true);
  assert.equal(shouldAcknowledgeRaceLoaded(prepare, true), false);
  assert.equal(shouldAcknowledgeRaceLoaded(prepare, { raceId: prepare.raceId }), false);
  assert.equal(shouldAcknowledgeRaceLoaded({}, false), false);
});

test('online races keep updating behind paused settings and help panels', () => {
  assert.equal(shouldUpdateOnlineRaceBehindPanel({ mode: 'settings', paused: true, raceKind: 'online' }), true);
  assert.equal(shouldUpdateOnlineRaceBehindPanel({ mode: 'help', paused: true, raceKind: 'online' }), true);
  assert.equal(shouldUpdateOnlineRaceBehindPanel({ mode: 'settings', paused: true, raceKind: 'local' }), false);
  assert.equal(shouldUpdateOnlineRaceBehindPanel({ mode: 'settings', paused: false, raceKind: 'online' }), false);
});

test('business-rule errors preserve a healthy connection indicator', () => {
  assert.equal(isOnlineConnectionError({ code: 'character_taken' }), false);
  assert.equal(isOnlineConnectionError({ code: 'not_ready' }), false);
  assert.equal(isOnlineConnectionError({ code: 'socket_error' }), true);
  assert.equal(isOnlineConnectionError({ code: 'protocol_mismatch' }), true);
});

test('stable protocol codes drive Lobby and Room error copy', () => {
  assert.equal(
    onlineErrorMessage({ code: 'room_code_invalid' }),
    'The invite link has an invalid room code. Room codes must be exactly 6 valid characters.',
  );
  assert.equal(
    onlineErrorMessage({ code: 'password_invalid', message: 'server-specific prose' }),
    'Incorrect room password.',
  );
  assert.equal(
    onlineErrorMessage({ code: 'no_matching_room' }),
    'No available public rooms were found.',
  );
  assert.equal(onlineErrorMessage({ code: 'future_error', message: 'Future failure.' }), 'Future failure.');
});
