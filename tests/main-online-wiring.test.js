import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const onlineScreensSource = readFileSync(new URL('../src/ui/online-screens.js', import.meta.url), 'utf8');

test('main maps every online screen action to the transport client', () => {
  const requiredCalls = [
    'onlineClient.enterLobby({ discardRoomSession: true })',
    'onlineClient.createRoom({',
    'onlineClient.joinRoom({',
    'onlineClient.quickMatch({ displayName: savedName })',
    'onlineClient.selectCharacter(characterId)',
    'onlineClient.setRoom(settings)',
    'onlineClient.setReady(ready)',
    'onlineClient.startRace()',
    'onlineClient.leaveRoom()',
    'onlineClient.returnRoom()',
    'onlineClient.startTelemetry()',
  ];
  for (const call of requiredCalls) {
    assert.equal(source.includes(call), true, `missing main.js wiring: ${call}`);
  }
});

test('main subscribes to the room, race, result and reconnect event stream', () => {
  for (const event of [
    'connection', 'telemetry', 'lobby_state', 'room_state', 'prepare_race', 'race_results', 'error',
    'reconnect_expired',
  ]) {
    assert.match(source, new RegExp(`onlineClient\\.on\\('${event}'`));
  }
  assert.match(source, /onlineScreens\.updateResults\(message,/);
  assert.match(source, /onlineScreens\.activeScreen === 'lobby'[\s\S]*onlineScreens\.updateLobby/);
  assert.match(source, /onlineScreens\.activeScreen === 'room'[\s\S]*onlineScreens\.updateRoom/);
  assert.match(
    source,
    /const connectionError = isOnlineConnectionError\(message\);[\s\S]*if \(connectionError\) \{[\s\S]*networkStatus\.setConnectionState\('error'\);/,
  );
});

test('Room reconnects use a blocking overlay and defer Lobby navigation until confirmation', () => {
  assert.match(
    source,
    /state === 'disconnected' \|\| state === 'reconnecting'\) beginLocalRoomReconnect\(\)/,
  );
  assert.match(
    source,
    /onlineClient\.on\('room_state',[\s\S]*finishLocalRoomReconnect\(\);[\s\S]*showOnlineRoom\(/,
  );
  assert.match(
    source,
    /if \(connectionError && beginLocalRoomReconnect\(\)\) return;/,
  );
  assert.match(
    source,
    /function presentRoomReconnectFailure[\s\S]*buttonLabel: UI_COPY\.online\.alerts\.returnLobby[\s\S]*onConfirm: returnToLobbyAfterReconnectFailure/,
  );
  assert.match(
    source,
    /function returnToLobbyAfterReconnectFailure[\s\S]*if \(race\?\.session\.kind === 'online'\) endRace\(\);[\s\S]*openOnlineLobby\(\{ tryResume: false \}\)/,
  );
  assert.match(
    source,
    /function presentRoomReconnectFailure[\s\S]*race\?\.session\.kind === 'online'[\s\S]*paused = true;[\s\S]*showAlert/,
  );
  assert.match(
    source,
    /onlineClient\.on\('reconnect_expired',[\s\S]*race\?\.session\.kind === 'online'[\s\S]*presentRoomReconnectFailure\(event\)/,
  );
  assert.match(
    onlineScreensSource,
    /showAlert\(message,[\s\S]*onConfirm = null[\s\S]*confirmAlert\(\)/,
  );
});

test('kicked players return to the Lobby and receive an information alert', () => {
  assert.match(
    source,
    /onlineClient\.on\('kicked',[\s\S]*showOnlineLobby\([\s\S]*onlineScreens\.showAlert\([\s\S]*kickedTitle/,
  );
  assert.match(source, /onKickPlayer\(\{ participantId \}\)[\s\S]*onlineClient\.kickPlayer\(participantId\)/);
});

test('title telemetry keeps the Lobby transport alive without navigating on background updates', () => {
  assert.match(source, /onBackToTitle\(\) \{\s*clearOnlineRoomUrl\(\);\s*goToTitle\(\);\s*\}/);
  assert.doesNotMatch(source, /onBackToTitle\(\)[\s\S]{0,120}onlineClient\.disconnect\(\)/);
  assert.match(
    source,
    /onlineClient\.on\('lobby_state',[\s\S]*onlineLobbyState = message \|\| \{ rooms: \[\] \};[\s\S]*if \(mode === 'online-lobby'\) showOnlineLobby\(onlineLobbyState\);/,
  );
  assert.match(source, /function goToTitle\(\)[\s\S]*networkStatus\.showDetails\(\);[\s\S]*if \(onlineClient\.scope === 'none'\) onlineClient\.enterLobby\(\);/);
});

test('network telemetry shows full details off-track and compact details during races', () => {
  assert.match(source, /function openOnlineLobby[\s\S]*networkStatus\.showDetails\(\)/);
  assert.match(source, /function showOnlineRoom[\s\S]*networkStatus\.showDetails\(\)/);
  assert.match(source, /function mountRace[\s\S]*networkStatus\.showRace\(\)/);
  assert.match(source, /session\.state === RACE_STATE\.RESULTS[\s\S]*networkStatus\.showDetails\(\)/);
  assert.match(source, /void networkStatus\.loadVersion\(\)/);
});

test('online screens do not render duplicate connection badges', () => {
  assert.doesNotMatch(onlineScreensSource, /data-online-connection/);
});

test('main protects prepare/loading ordering and resumed load acknowledgements', () => {
  assert.match(source, /shouldPresentOnlineRoom\([\s\S]*roomState,[\s\S]*race\?\.session\.kind === 'online',[\s\S]*onlineClient\.selfId/);
  assert.match(source, /hasReturnedToOnlineRoom\(roomState, onlineClient\.selfId\)/);
  assert.match(
    source,
    /if \(shouldAcknowledgeRaceLoaded\(message, onlineRoomState\)\) \{\s*onlineClient\.markRaceLoaded\(message\.raceId\);/,
  );
  assert.match(
    source,
    /mountedSession\?\.kind === 'online'[\s\S]*mountedSession\.raceId === message\?\.raceId[\s\S]*resumeFromPrepare/,
  );
  assert.match(source, /new OnlineRaceSession\(\{[\s\S]*roomState: onlineRoomState/);
});

test('main persists v2 nicknames and routes Room exits back to the Lobby', () => {
  assert.match(source, /let onlineDisplayName = '';/);
  assert.match(source, /function ensureOnlineDisplayName\(\)[\s\S]*loadOnlineDisplayName\(\)/);
  assert.match(source, /function openOnlineLobby[\s\S]*ensureOnlineDisplayName\(\)/);
  assert.match(source, /onNicknameChange\(\{ displayName \}\)[\s\S]*acceptOnlineDisplayName\(displayName\)/);
  assert.match(source, /function acceptOnlineDisplayName\(value\)[\s\S]*saveOnlineDisplayName\(value\)[\s\S]*code: 'name_invalid'/);
  assert.match(source, /function leaveCurrentOnlineRoom\(\)[\s\S]*onlineClient\.leaveRoom\(\)[\s\S]*showOnlineLobby\(/);
  assert.match(source, /onQuit\(\)[\s\S]*race\?\.session\.kind === 'online'[\s\S]*leaveCurrentOnlineRoom\(\)/);
});

test('invite links auto-join available rooms and keep the address bar in sync', () => {
  assert.match(source, /function attemptInviteJoin\(lobbyView\)[\s\S]*onlineScreens\.joinInvitedRoom\(inviteCode\)/);
  assert.match(source, /ROOM_NOT_FOUND[\s\S]*ROOM_FULL[\s\S]*ROOM_LOCKED/);
  assert.match(source, /function showOnlineRoom\(message, \{ preservePanel = false \} = \{\}\)[\s\S]*replaceOnlineRoomUrl\(roomCode\)/);
  assert.match(source, /function leaveCurrentOnlineRoom\(\)[\s\S]*clearOnlineRoomUrl\(\)/);
  assert.match(source, /pendingInviteJoinCode[\s\S]*onlineClient\.on\('error'[\s\S]*clearOnlineRoomUrl\(\)/);
  assert.match(source, /function clearOnlineRoomUrl\(\)[\s\S]*updateLobby\([\s\S]*inviteRoomCode: ''/);
  assert.match(onlineScreensSource, /joinInvitedRoom\(roomCode\)[\s\S]*requiresPassword[\s\S]*_openJoinDialog/);
});

test('invalid invite codes report an error and rewrite the URL before entering Lobby', () => {
  assert.match(source, /invitationRoomRequest\(window\.location\.search\)/);
  assert.match(source, /inviteRequest\.present && !inviteRequest\.valid[\s\S]*ROOM_CODE_INVALID/);
  assert.match(source, /if \(invalidInviteError\) \{[\s\S]*clearOnlineRoomUrl\(\);/);
  assert.match(source, /else if \(!devScreen && q\.has\('room'\)\)/);
});

test('results use a settled presentation loop and stop continuous engine audio', () => {
  assert.match(source, /race\.chase\.settle\?\.\(\);\s*audio\.stopEngine\(\);/);
  assert.match(source, /function updateResultsFrame\(dt\)/);
  assert.doesNotMatch(source, /if \(mode === 'online-results'\)[\s\S]*?updateRaceFrame\(dt\);/);
});

test('main keeps paused online panels alive and neutralizes hidden-page controls', () => {
  assert.match(source, /shouldUpdateOnlineRaceBehindPanel\(\{/);
  assert.match(source, /updateMenus\(\);\s*updateRaceFrame\(dt\);\s*renderer\.render\(race\.world\.scene, camera\);/);
  assert.match(
    source,
    /visibilitychange[\s\S]*race\?\.session\.kind === 'online'[\s\S]*race\.session\.sendNeutralInput\?\.\(\)/,
  );
});

test('settings and help return to online screens while their live state keeps updating', () => {
  assert.match(
    source,
    /panelReturn = mode === 'online-lobby' \|\| mode === 'online-room'[\s\S]*\? mode/,
  );
  assert.match(
    source,
    /panelReturn === 'online-lobby' \|\| panelReturn === 'online-room'[\s\S]*onlineScreens\.focusPageAction/,
  );
  assert.match(
    source,
    /panelReturn === 'online-lobby'[\s\S]*onlineScreens\.updateLobby/,
  );
  assert.match(
    source,
    /preservePanel: \(mode === 'settings' \|\| mode === 'help'\) && panelReturn === 'online-room'/,
  );
});
