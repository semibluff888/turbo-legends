import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasReturnedToOnlineRoom,
  invitationRoomCode,
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

test('resumed catch-up only acknowledges loading races', () => {
  const resumed = { raceId: 'race-id-1234', resumed: true };
  assert.equal(shouldAcknowledgeRaceLoaded(resumed, { state: 'loading' }), true);
  assert.equal(shouldAcknowledgeRaceLoaded(resumed, { state: 'countdown' }), false);
  assert.equal(shouldAcknowledgeRaceLoaded(resumed, { state: 'racing' }), false);
  assert.equal(shouldAcknowledgeRaceLoaded(resumed, { state: 'results' }), false);
  assert.equal(shouldAcknowledgeRaceLoaded({ raceId: 'race-id-1234' }, { state: 'waiting' }), true);
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
    onlineErrorMessage({ code: 'password_invalid', message: 'server-specific prose' }),
    'Incorrect room password.',
  );
  assert.equal(
    onlineErrorMessage({ code: 'no_matching_room' }),
    'No available public rooms were found.',
  );
  assert.equal(onlineErrorMessage({ code: 'future_error', message: 'Future failure.' }), 'Future failure.');
});
