import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildInviteUrl,
  buildLobbyView,
  buildOnlineResultsView,
  formatOnlineTime,
  normalizeDisplayName,
  normalizeRoomCode,
  roomCodeFromSearch,
} from '../src/ui/online-screens.js';

test('online entry helpers normalize nicknames and unambiguous room codes', () => {
  assert.equal(normalizeDisplayName('  Turbo\n  Racer  '), 'Turbo Racer');
  assert.equal(normalizeDisplayName('🚗🚕🚙', 2), '🚗🚕');
  assert.equal(normalizeRoomCode('io-01 abc234-more'), 'ABC234');
  assert.equal(roomCodeFromSearch('?campaign=summer&room=jkm567'), 'JKM567');
});

test('invite links preserve only the same-page room query', () => {
  const link = buildInviteUrl('abc234', {
    href: 'https://racing.example/game/index.html?old=1#secret',
    origin: 'https://racing.example',
    pathname: '/game/index.html',
  });
  assert.equal(link, 'https://racing.example/game/index.html?room=ABC234');
  assert.equal(link.includes('token'), false);
});

test('lobby view derives host controls, readiness and character locks', () => {
  const room = {
    code: 'abc234',
    phase: 'lobby',
    hostParticipantId: 'p1',
    settings: { trackId: 'harbor-loop', difficulty: 'hard' },
    members: [
      { participantId: 'p1', displayName: 'NovaFan', characterId: 'nova', ready: true, status: 'online' },
      { participantId: 'p2', displayName: 'PipFan', characterId: 'pip', ready: true, connected: true },
    ],
  };
  const view = buildLobbyView(room, 'p1');
  assert.equal(view.roomCode, 'ABC234');
  assert.equal(view.capacity, 8);
  assert.equal(view.isHost, true);
  assert.equal(view.everyoneReady, true);
  assert.equal(view.canStart, true);
  assert.equal(view.trackId, 'harbor-loop');
  assert.equal(view.difficulty, 'hard');
  assert.deepEqual(view.occupiedCharacterIds, ['nova', 'pip']);
  assert.equal(view.localMember.displayName, 'NovaFan');
});

test('lobby start remains unavailable to guests and while a member is offline', () => {
  const room = {
    roomCode: 'QRS789',
    hostId: 'host',
    canStart: true,
    members: [
      { id: 'host', name: 'Host', ready: true, connected: true },
      { id: 'guest', name: 'Guest', ready: true, connected: false },
    ],
  };
  const hostView = buildLobbyView({ ...room, canStart: undefined }, 'host');
  assert.equal(hostView.everyoneReady, false);
  assert.equal(hostView.canStart, false);
  assert.equal(hostView.onlineCount, 1);

  const guestView = buildLobbyView(room, 'guest');
  assert.equal(guestView.isHost, false);
  assert.equal(guestView.canStart, false);
});

test('returned racers can manage the lobby while other racers remain in game', () => {
  const view = buildLobbyView({
    roomCode: 'QRS789',
    state: 'results',
    hostParticipantId: 'host',
    members: [
      {
        participantId: 'host', displayName: 'Host', characterId: 'nova', connected: true,
        ready: true, postRaceState: 'lobby', activityState: 'lobby',
      },
      {
        participantId: 'guest', displayName: 'Guest', characterId: 'pip', connected: true,
        ready: false, postRaceState: 'results', activityState: 'in_game',
      },
    ],
  }, 'host');

  assert.equal(view.canManageLobby, true);
  assert.equal(view.canStart, false);
  assert.equal(view.localMember.ready, true);
  assert.equal(view.members[1].activityState, 'in_game');
});

test('authoritative results are sorted and formatted without inventing times', () => {
  const view = buildOnlineResultsView({
    hostParticipantId: 'p1',
    trackName: 'Summit Raceway',
    standings: [
      { participantId: 'p2', name: 'Second', rank: 2, finishTime: 72.5, bestLap: 34.25 },
      { participantId: 'p1', name: 'Winner', rank: 1, finishTime: 70, bestLap: 33 },
      { participantId: 'ai-1', name: 'Gearbox', rank: 3, finished: false, finishTime: null, bestLap: null },
    ],
  }, 'p1');

  assert.equal(view.isHost, true);
  assert.equal(view.standings[0].displayName, 'Winner');
  assert.equal(view.standings[0].isLocal, true);
  assert.equal(view.standings[2].finished, false);
  assert.equal(formatOnlineTime(view.standings[0].finishTime), '1:10.00');
  assert.equal(formatOnlineTime(view.standings[2].bestLap), '—');
});
