import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildInviteUrl,
  buildLobbyUrl,
  buildLobbyView,
  buildOnlineResultsView,
  buildRoomView,
  formatOnlineTime,
  isValidRoomPassword,
  normalizeDisplayName,
  normalizeRoomCode,
  normalizeRoomName,
  OnlineScreens,
  roomCodeFromSearch,
  roomStatusMessage,
} from '../src/ui/online-screens.js';

const onlineScreensSource = readFileSync(new URL('../src/ui/online-screens.js', import.meta.url), 'utf8');

test('online input helpers normalize display fields and room codes', () => {
  assert.equal(normalizeDisplayName('  Turbo\n  Racer  '), 'Turbo Racer');
  assert.equal(normalizeDisplayName('🚗🏎️🚙', 2), '🚗🏎');
  assert.equal(normalizeRoomName('  Friday\n Night   Race  '), 'Friday Night Race');
  assert.equal(normalizeRoomName('x'.repeat(40)).length, 32);
  assert.equal(normalizeRoomCode('io-01 abc234-more'), 'ABC234');
  assert.equal(roomCodeFromSearch('?campaign=summer&room=jkm567'), 'JKM567');
  assert.equal(isValidRoomPassword('Pit7'), true);
  assert.equal(isValidRoomPassword('pit'), true);
  assert.equal(isValidRoomPassword('pi'), false);
  assert.equal(isValidRoomPassword('    '), false);
  assert.equal(isValidRoomPassword(' Pit7'), false);
  assert.equal(isValidRoomPassword('Pit7\u202e'), false);
});

test('invite links preserve only the same-page room query', () => {
  const location = {
    href: 'https://racing.example/game/index.html?old=1#secret',
    origin: 'https://racing.example',
    pathname: '/game/index.html',
  };
  const link = buildInviteUrl('abc234', location);
  assert.equal(link, 'https://racing.example/game/index.html?room=ABC234');
  assert.equal(link.includes('token'), false);
  assert.equal(buildLobbyUrl(location), 'https://racing.example/game/index.html');
});

test('invited public rooms join immediately while private rooms request a password', () => {
  const calls = [];
  const screen = {
    _busy: false,
    _lobbyRoomByCode: new Map([
      ['ABC234', { roomCode: 'ABC234', joinable: true, requiresPassword: false }],
      ['DEF345', { roomCode: 'DEF345', joinable: true, requiresPassword: true }],
      ['GHJ456', { roomCode: 'GHJ456', joinable: false, requiresPassword: false }],
    ]),
    _submitJoinRoom(room) { calls.push(['join', room.roomCode]); },
    _openJoinDialog(room, opener) { calls.push(['password', room.roomCode, opener]); },
  };

  assert.equal(OnlineScreens.prototype.joinInvitedRoom.call(screen, 'abc234'), true);
  assert.equal(OnlineScreens.prototype.joinInvitedRoom.call(screen, 'def345'), true);
  assert.equal(OnlineScreens.prototype.joinInvitedRoom.call(screen, 'ghj456'), false);
  assert.equal(OnlineScreens.prototype.joinInvitedRoom.call(screen, 'missing'), false);
  assert.deepEqual(calls, [
    ['join', 'ABC234'],
    ['password', 'DEF345', null],
  ]);
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
        roomCode: 'DEF345', roomName: 'Private Cup', roomType: 'private',
        playerCount: 1, maxPlayers: 4, hostDisplayName: 'Pip', status: 'waiting',
      },
      {
        roomCode: 'ABC234', roomName: 'Sunset Sprint', roomType: 'public',
        playerCount: 2, maxPlayers: 8, hostDisplayName: 'Alex', status: 'WAITING',
        trackId: 'harbor-loop',
      },
    ],
  });

  assert.deepEqual(view.rooms.map((room) => room.roomCode), [
    'DEF345', 'ABC234', 'GHJ456', 'KMN567',
  ]);
  assert.equal(view.rooms[0].requiresPassword, true);
  assert.equal(view.rooms[1].trackName, 'Harbor Loop');
  assert.equal(view.rooms[0].joinable, true);
  assert.equal(view.rooms[2].status, 'full');
  assert.equal(view.rooms[2].joinable, false);
  assert.equal(view.rooms[3].status, 'in_game');
  assert.equal(view.rooms[3].joinable, false);
  assert.equal(view.joinableRooms, 2);
});

test('lobby search matches room, track, host and code without case sensitivity', () => {
  const lobby = {
    rooms: [
      {
        roomCode: 'ABC234', roomName: 'Sunset Sprint', roomType: 'public',
        playerCount: 1, maxPlayers: 8, hostDisplayName: 'TurboFox', status: 'waiting',
        trackId: 'summit-raceway',
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
  assert.deepEqual(
    buildLobbyView(lobby, { search: 'summit' }).rooms.map((room) => room.roomCode),
    ['ABC234'],
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
    settings: { trackId: 'harbor-loop', difficulty: 'hard', autoFillAi: false },
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
  assert.equal(hostView.autoFillAi, false);
  assert.equal(hostView.members[0].paintId, 'turbo-blue');
  assert.equal(hostView.members[0].avatarId, 'cat');
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
  assert.equal(view.reconnectingCount, 1);
  assert.deepEqual(view.reconnectingMembers.map((member) => member.participantId), ['guest']);
  assert.equal(view.everyoneReady, false);
  assert.equal(view.canStart, false);
  assert.equal(roomStatusMessage(view), 'Waiting for Same to reconnect.');
});

test('Room status summarizes multiple reconnecting racers before readiness', () => {
  const view = buildRoomView({
    roomCode: 'QRS789',
    hostParticipantId: 'host',
    members: [
      { participantId: 'host', displayName: 'Host', ready: true, connected: true },
      { participantId: 'guest-1', displayName: 'Nova', ready: true, connected: false },
      { participantId: 'guest-2', displayName: 'Pip', ready: false, connected: false },
    ],
  }, 'host');

  assert.equal(view.reconnectingCount, 2);
  assert.equal(roomStatusMessage(view), 'Waiting for 2 racers to reconnect.');
});

test('Room reconnect overlay is idempotent, blocks content, and restores focus', () => {
  const attributes = new Map();
  const previous = { isConnected: true, focusCalls: 0, focus() { this.focusCalls += 1; } };
  const content = {
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
  };
  const panel = { focusCalls: 0, focus() { this.focusCalls += 1; } };
  const backdrop = {
    hidden: true,
    querySelector(selector) { return selector === '.online-room-reconnect' ? panel : null; },
  };
  const root = {
    querySelector(selector) {
      if (selector === '[data-room-content]') return content;
      if (selector === '[data-room-reconnect]') return backdrop;
      return null;
    },
  };
  const screen = Object.assign(Object.create(OnlineScreens.prototype), {
    roots: { room: root },
    doc: { activeElement: previous },
    _screen: 'room',
    _roomReconnectFocus: null,
    closeMenu() {},
  });

  assert.equal(screen.setRoomReconnecting(true), true);
  assert.equal(screen.setRoomReconnecting(true), false);
  assert.equal(backdrop.hidden, false);
  assert.equal(attributes.has('inert'), true);
  assert.equal(attributes.get('aria-hidden'), 'true');
  assert.equal(panel.focusCalls, 1);

  assert.equal(screen.setRoomReconnecting(false), true);
  assert.equal(backdrop.hidden, true);
  assert.equal(attributes.has('inert'), false);
  assert.equal(attributes.has('aria-hidden'), false);
  assert.equal(previous.focusCalls, 1);
});

test('Room reconnect overlay keeps keyboard focus inside the blocking state', () => {
  const panel = { focusCalls: 0, focus() { this.focusCalls += 1; } };
  const backdrop = {
    hidden: false,
    querySelector(selector) { return selector === '.online-room-reconnect' ? panel : null; },
  };
  const screen = Object.assign(Object.create(OnlineScreens.prototype), {
    roots: {
      room: {
        querySelector(selector) { return selector === '[data-room-reconnect]' ? backdrop : null; },
      },
    },
    _activeMenu: null,
    _activeDialog: null,
  });
  const event = {
    key: 'Tab',
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  };

  screen._handleScreenKeydown(event);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.equal(panel.focusCalls, 1);
});

test('alert confirmation runs its action once while programmatic dismissal stays passive', () => {
  let confirmations = 0;
  const screen = Object.assign(Object.create(OnlineScreens.prototype), {
    _activeAlert: {
      node: { hidden: false },
      restoreFocus: null,
      suspendedDialog: null,
      onConfirm() { confirmations += 1; },
    },
  });

  screen.dismissAlert(false);
  assert.equal(confirmations, 0);

  screen._activeAlert = {
    node: { hidden: false },
    restoreFocus: null,
    suspendedDialog: null,
    onConfirm() { confirmations += 1; },
  };
  screen.confirmAlert();
  screen.confirmAlert();
  assert.equal(confirmations, 1);
});

test('alert cancellation stays separate from confirmation', () => {
  let confirmations = 0;
  let cancellations = 0;
  const screen = Object.assign(Object.create(OnlineScreens.prototype), {
    _activeAlert: {
      node: { hidden: false },
      restoreFocus: null,
      suspendedDialog: null,
      onConfirm() { confirmations += 1; },
      onCancel() { cancellations += 1; },
      isConfirm: true,
    },
  });

  screen.cancelAlert();
  screen.cancelAlert();
  assert.equal(confirmations, 0);
  assert.equal(cancellations, 1);
});

test('authoritative results use participant ids and do not invent times', () => {
  const view = buildOnlineResultsView({
    trackName: 'Summit Raceway',
    standings: [
      { participantId: 'p2', name: 'Turbo', rank: 2, finishTime: 72.5, bestLap: 34.25, paintId: 'crimson-heat', avatarId: 'dog' },
      { participantId: 'p1', name: 'Turbo', rank: 1, finishTime: 70, bestLap: 33, paintId: 'turbo-blue', avatarId: 'cat' },
      { participantId: 'ai-1', name: 'Gearbox', rank: 3, finished: false, finishTime: null, bestLap: null },
    ],
  }, 'p2');

  assert.equal(view.standings[0].displayName, 'Turbo');
  assert.equal(view.standings[0].isLocal, false);
  assert.equal(view.standings[1].isLocal, true);
  assert.equal(view.standings[1].paintId, 'crimson-heat');
  assert.equal(view.standings[1].avatarId, 'dog');
  assert.equal(view.standings[2].finished, false);
  assert.equal(formatOnlineTime(view.standings[0].finishTime), '1:10.00');
  assert.equal(formatOnlineTime(view.standings[2].bestLap), '—');
});

test('Lobby and Room use field feedback, direct page actions, and persistent room state', () => {
  const lobbyStart = onlineScreensSource.indexOf('  _buildLobby() {');
  const roomStart = onlineScreensSource.indexOf('  _buildRoom() {');
  const resultsStart = onlineScreensSource.indexOf('  _buildResults() {');
  const lobbySource = onlineScreensSource.slice(lobbyStart, roomStart);
  const roomSource = onlineScreensSource.slice(roomStart, resultsStart);

  assert.doesNotMatch(lobbySource, /data-online-(?:status|error)/);
  assert.doesNotMatch(roomSource, /data-online-(?:status|error)/);
  assert.match(lobbySource, /data-field-error="nickname"/);
  assert.match(lobbySource, /data-field-error="create-room-name"/);
  assert.match(lobbySource, /data-create-track-preview/);
  assert.match(lobbySource, /data-field-error="join-password"/);
  assert.match(lobbySource, /data-room-count/);
  assert.match(roomSource, /data-room-status/);
  assert.match(roomSource, /data-room-reconnect/);
  assert.match(roomSource, /copy\.reconnecting/);
  assert.match(roomSource, /data-room-setting="autoFillAi"/);
  assert.match(roomSource, /data-action="kick-player"/);
  assert.match(roomSource, /copy\.kickMessage/);
  assert.match(onlineScreensSource, /member\.connected && member\.ready/);
  assert.match(onlineScreensSource, /is-reconnecting/);
  assert.match(onlineScreensSource, /waitingForReconnect/);
  assert.match(lobbySource, /_wirePageActions\(root\)/);
  assert.match(roomSource, /_wirePageActions\(root\)/);
  assert.doesNotMatch(lobbySource, /copy\.(?:eyebrow|subtitle|availableRooms)/);
  assert.doesNotMatch(roomSource, /copy\.eyebrow/);
  assert.match(lobbySource, /minlength="3"/);
  assert.doesNotMatch(lobbySource, /quickMatchHint/);
  assert.match(onlineScreensSource, /viewBox="0 0 100 60" preserveAspectRatio="xMidYMid meet"/);
  assert.match(onlineScreensSource, /<polygon points=/);
  assert.doesNotMatch(onlineScreensSource, /preserveAspectRatio="xMidYMid slice"/);
});

test('password failures stay inline while quick-match failures use the shared alert', () => {
  const passwordScreen = Object.assign(Object.create(OnlineScreens.prototype), {
    _pendingAction: { kind: 'join' },
    _activeDialog: { name: 'join' },
    doc: { activeElement: null },
    _errorText: () => 'Incorrect room password.',
    showFieldError(field, message, options) {
      this.fieldCall = { field, message, options };
      return true;
    },
    showAlert() { this.alerted = true; },
  });
  const passwordResult = passwordScreen.presentError({ code: 'password_invalid' });
  assert.equal(passwordResult, 'field');
  assert.deepEqual(passwordScreen.fieldCall, {
    field: 'join-password',
    message: 'Incorrect room password.',
    options: { focus: true },
  });
  assert.equal(passwordScreen.alerted, undefined);
  assert.equal(passwordScreen._activeDialog.name, 'join');

  const quickScreen = Object.assign(Object.create(OnlineScreens.prototype), {
    _pendingAction: { kind: 'quick' },
    _activeDialog: null,
    doc: { activeElement: null },
    _errorText: () => 'No available public rooms were found.',
    showAlert(message, options) { this.alertCall = { message, options }; },
  });
  const quickResult = quickScreen.presentError({ code: 'no_matching_room' });
  assert.equal(quickResult, 'alert');
  assert.equal(quickScreen.alertCall.message, 'No available public rooms were found.');
  assert.equal(quickScreen.alertCall.options.title, 'QUICK START UNAVAILABLE');
});

test('create and private-join submissions remain open until the server responds', () => {
  const createStart = onlineScreensSource.indexOf('  _submitCreateRoom() {');
  const quickStart = onlineScreensSource.indexOf('  _submitQuickMatch() {');
  const joinStart = onlineScreensSource.indexOf('  _submitJoinRoom(room, password) {');
  const openDialogStart = onlineScreensSource.indexOf('  _openDialog(name, opener, room = null) {');
  const createSource = onlineScreensSource.slice(createStart, quickStart);
  const joinSource = onlineScreensSource.slice(joinStart, openDialogStart);
  assert.doesNotMatch(createSource, /_closeDialog/);
  assert.doesNotMatch(joinSource, /_closeDialog/);
  assert.match(createSource, /_pendingAction = \{ kind: 'create' \}/);
  assert.match(joinSource, /_pendingAction = \{ kind: 'join'/);
});

test('Room loadout UI uses a staged three-tab dialog and no taken-racer lock', () => {
  assert.match(onlineScreensSource, /data-loadout-preview-host="room"/);
  assert.match(onlineScreensSource, /data-dialog="loadout"/);
  assert.match(onlineScreensSource, /data-loadout-tab="racer"/);
  assert.match(onlineScreensSource, /data-loadout-tab="paint"/);
  assert.match(onlineScreensSource, /data-loadout-tab="avatar"/);
  assert.match(onlineScreensSource, /_pendingLoadout = \{ \.\.\.this\._loadoutDraft \}/);
  assert.match(onlineScreensSource, /onSetLoadout/);
  assert.doesNotMatch(onlineScreensSource, /occupiedByOther|online-character-lock/);
});
