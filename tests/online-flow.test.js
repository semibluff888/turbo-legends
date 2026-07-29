import test from 'node:test';
import assert from 'node:assert/strict';

import {
  invitationRoomCode,
  isOnlineConnectionError,
  shouldAcknowledgeRaceLoaded,
  shouldPresentOnlineLobby,
  shouldResumeStoredOnlineSession,
  shouldUpdateOnlineRaceBehindPanel,
} from '../src/net/online-flow.js';

test('an invite link wins over unrelated stored reconnect credentials', () => {
  assert.equal(invitationRoomCode('?room=FAST22'), 'FAST22');
  assert.equal(shouldResumeStoredOnlineSession({
    search: '?room=FAST22',
    roomCode: 'OLD234',
    participantId: 'participant',
    resumeToken: 'token',
  }), false);
  assert.equal(shouldResumeStoredOnlineSession({
    roomCode: 'OLD234',
    participantId: 'participant',
    resumeToken: 'token',
  }), true);
  assert.equal(shouldResumeStoredOnlineSession({
    search: '?room=OLD234',
    roomCode: 'old234',
    participantId: 'participant',
    resumeToken: 'token',
  }), true);
});

test('loading room state cannot replace a race already mounted from prepare_race', () => {
  assert.equal(shouldPresentOnlineLobby({ state: 'loading' }, false), true);
  assert.equal(shouldPresentOnlineLobby({ state: 'loading' }, true), false);
  assert.equal(shouldPresentOnlineLobby({ state: 'countdown' }, true), false);
  assert.equal(shouldPresentOnlineLobby({ state: 'racing' }, true), false);
  assert.equal(shouldPresentOnlineLobby({ state: 'lobby' }, true), true);
});

test('resumed catch-up only acknowledges loading races', () => {
  const resumed = { raceId: 'race-id-1234', resumed: true };
  assert.equal(shouldAcknowledgeRaceLoaded(resumed, { state: 'loading' }), true);
  assert.equal(shouldAcknowledgeRaceLoaded(resumed, { state: 'countdown' }), false);
  assert.equal(shouldAcknowledgeRaceLoaded(resumed, { state: 'racing' }), false);
  assert.equal(shouldAcknowledgeRaceLoaded(resumed, { state: 'results' }), false);
  assert.equal(shouldAcknowledgeRaceLoaded({ raceId: 'race-id-1234' }, { state: 'lobby' }), true);
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
