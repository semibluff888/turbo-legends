import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildInviteUrl,
  buildLobbyView,
  buildOnlineResultsView,
  buildRoomView,
  formatOnlineTime,
  isValidRoomPassword,
  normalizeDisplayName,
  normalizeRoomCode,
  normalizeRoomName,
  roomCodeFromSearch,
} from '../src/ui/online-screens.js';

test('online input helpers normalize display fields and room codes', () => {
  assert.equal(normalizeDisplayName('  Turbo\n  Racer  '), 'Turbo Racer');
  assert.equal(normalizeDisplayName('🚗🏎️🚙', 2), '🚗🏎');
  assert.equal(normalizeRoomName('  Friday\n Night   Race  '), 'Friday Night Race');
  assert.equal(normalizeRoomName('x'.repeat(40)).length, 32);
  assert.equal(normalizeRoomCode('io-01 abc234-more'), 'ABC234');
  assert.equal(roomCodeFromSearch('?campaign=summer&room=jkm567'), 'JKM567');
  assert.equal(isValidRoomPassword('Pit7'), true);
  assert.equal(isValidRoomPassword('pit'), false);
  assert.equal(isValidRoomPassword('    '), false);
  assert.equal(isValidRoomPassword(' Pit7'), false);
  assert.equal(isValidRoomPassword('Pit7\u202e'), false);
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

test('lobby view normalizes room types, status and joinability', () => {
  const view = buildLobbyView({
    rooms: [
      {
        roomCode: 'GHJ456', roomName: 'Tiny Grid', roomType: 'public',
        playerCount: 2, maxPlayers: 2, hostDisplayName: 'Max', status: 'waiting',
      },
      {
        roomCode: 'KMN567', roomName: 'Final Lap', roomType: 'public',
        playerCount: 3, maxPlayers: 8, hostDisplayName: 'Nova', status: 'racing',
      },
      {
        roomCode: 'DEF345', roomName: 'Friends Cup', roomType: 'private',
        playerCount: 1, maxPlayers: 4, hostDisplayName: 'Pip', status: 'waiting',
      },
      {
        roomCode: 'ABC234', roomName: 'Sunset Sprint', roomType: 'public',
        playerCount: 2, maxPlayers: 8, hostDisplayName: 'Alex', status: 'WAITING',
      },
    ],
  });

  assert.deepEqual(view.rooms.map((room) => room.roomCode), [
    'DEF345', 'ABC234', 'GHJ456', 'KMN567',
  ]);
  assert.equal(view.rooms[0].requiresPassword, true);
  assert.equal(view.rooms[0].joinable, true);
  assert.equal(view.rooms[2].status, 'full');
  assert.equal(view.rooms[2].joinable, false);
  assert.equal(view.rooms[3].status, 'in_game');
  assert.equal(view.rooms[3].joinable, false);
  assert.equal(view.joinableRooms, 2);
});

test('lobby search matches room, host and code without case sensitivity', () => {
  const lobby = {
    rooms: [
      {
        roomCode: 'ABC234', roomName: 'Sunset Sprint', roomType: 'public',
        playerCount: 1, maxPlayers: 8, hostDisplayName: 'TurboFox', status: 'waiting',
      },
      {
        roomCode: 'DEF345', roomName: 'Harbor Crew', roomType: 'private',
        playerCount: 2, maxPlayers: 6, hostDisplayName: 'Night Owl', status: 'waiting',
      },
    ],
  };

  assert.deepEqual(
    buildLobbyView(lobby, { search: 'turbofox' }).rooms.map((room) => room.roomCode),
    ['ABC234'],
  );
  assert.deepEqual(
    buildLobbyView(lobby, { search: 'HARBOR' }).rooms.map((room) => room.roomCode),
    ['DEF345'],
  );
  assert.deepEqual(
    buildLobbyView(lobby, { search: 'def345' }).rooms.map((room) => room.roomCode),
    ['DEF345'],
  );
});

test('an invited room stays locatable even when the current search does not match', () => {
  const view = buildLobbyView({
    rooms: [
      {
        roomCode: 'QRS789', roomName: 'Invite Only', roomType: 'private',
        playerCount: 3, maxPlayers: 4, hostDisplayName: 'Host', status: 'waiting',
      },
    ],
  }, { search: 'different room', inviteRoomCode: 'qrs789' });

  assert.equal(view.invitedRoom.roomCode, 'QRS789');
  assert.equal(view.invitedRoom.isInvited, true);
  assert.equal(view.rooms.length, 1);
  assert.equal(view.invitedRoomMissing, false);

  const missing = buildLobbyView({ rooms: [] }, { inviteRoomCode: 'QRS789' });
  assert.equal(missing.invitedRoomMissing, true);
});

test('room view uses custom capacity and participant ids with duplicate nicknames', () => {
  const room = {
    roomCode: 'QRS789',
    roomName: 'Duplicate Derby',
    roomType: 'private',
    maxPlayers: 4,
    phase: 'waiting',
    hostParticipantId: 'p1',
    settings: { trackId: 'harbor-loop', difficulty: 'hard' },
    members: [
      { participantId: 'p1', displayName: 'Turbo', characterId: 'nova', ready: true, connected: true },
      { participantId: 'p2', displayName: 'Turbo', characterId: 'pip', ready: true, connected: true },
    ],
  };

  const hostView = buildRoomView(room, 'p1');
  const guestView = buildRoomView(room, 'p2');
  assert.equal(hostView.roomName, 'Duplicate Derby');
  assert.equal(hostView.roomType, 'private');
  assert.equal(hostView.maxPlayers, 4);
  assert.equal(hostView.capacity, 4);
  assert.equal(hostView.playerCount, 2);
  assert.equal(hostView.canStart, true);
  assert.deepEqual(hostView.occupiedCharacterIds, ['nova', 'pip']);
  assert.equal(guestView.localMember.participantId, 'p2');
  assert.equal(guestView.localMember.displayName, 'Turbo');
  assert.equal(guestView.isHost, false);
  assert.equal(guestView.canStart, false);
});

test('room start remains unavailable while a reserved member is offline', () => {
  const view = buildRoomView({
    roomCode: 'QRS789',
    hostParticipantId: 'host',
    maxPlayers: 6,
    members: [
      { participantId: 'host', displayName: 'Same', ready: true, connected: true },
      { participantId: 'guest', displayName: 'Same', ready: true, connected: false },
    ],
  }, 'host');

  assert.equal(view.playerCount, 2);
  assert.equal(view.onlineCount, 1);
  assert.equal(view.everyoneReady, false);
  assert.equal(view.canStart, false);
});

test('authoritative results use participant ids and do not invent times', () => {
  const view = buildOnlineResultsView({
    trackName: 'Summit Raceway',
    standings: [
      { participantId: 'p2', name: 'Turbo', rank: 2, finishTime: 72.5, bestLap: 34.25 },
      { participantId: 'p1', name: 'Turbo', rank: 1, finishTime: 70, bestLap: 33 },
      { participantId: 'ai-1', name: 'Gearbox', rank: 3, finished: false, finishTime: null, bestLap: null },
    ],
  }, 'p2');

  assert.equal(view.standings[0].displayName, 'Turbo');
  assert.equal(view.standings[0].isLocal, false);
  assert.equal(view.standings[1].isLocal, true);
  assert.equal(view.standings[2].finished, false);
  assert.equal(formatOnlineTime(view.standings[0].finishTime), '1:10.00');
  assert.equal(formatOnlineTime(view.standings[2].bestLap), '—');
});
