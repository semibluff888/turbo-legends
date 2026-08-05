import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const loaderSource = readFileSync(new URL('../src/net/online-race-loader.js', import.meta.url), 'utf8');
const onlineScreensSource = readFileSync(new URL('../src/ui/online-screens.js', import.meta.url), 'utf8');

test('main maps every online screen action to the transport client', () => {
  const requiredCalls = [
    'onlineClient.enterLobby({ discardRoomSession: true })',
    'onlineClient.createRoom({',
    'onlineClient.joinRoom({',
    'onlineClient.quickMatch({ displayName: savedName, ...onlineLoadout })',
    'onlineClient.selectCharacter(characterId)',
    'onlineClient.setLoadout(loadout)',
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
    'connection', 'telemetry', 'lobby_state', 'room_state', 'prepare_race', 'race_loaded_ack',
    'snapshot', 'race_results', 'error', 'reconnect_expired',
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
    /function presentRoomReconnectFailure[\s\S]*buttonLabel: appCopy\.online\.alerts\.returnLobby[\s\S]*onConfirm: returnToLobbyAfterReconnectFailure/,
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
  assert.match(
    source,
    /onlineClient\.on\('kicked',[\s\S]*showAlert\(appCopy\.online\.room\.kickedMessage/,
  );
  assert.doesNotMatch(
    source,
    /onlineClient\.on\('kicked',[\s\S]*showAlert\(message\?\.message/,
  );
  assert.match(source, /onKickPlayer\(\{ participantId \}\)[\s\S]*onlineClient\.kickPlayer\(participantId\)/);
});

test('title and single-player show only the version without keeping a Lobby WebSocket alive', () => {
  assert.match(source, /onBackToTitle\(\) \{\s*clearOnlineRoomUrl\(\);\s*goToTitle\(\);\s*\}/);
  assert.match(
    source,
    /onlineClient\.on\('lobby_state',[\s\S]*onlineLobbyState = message \|\| \{ rooms: \[\] \};[\s\S]*if \(mode === 'online-lobby'\) showOnlineLobby\(onlineLobbyState\);/,
  );
  assert.match(source, /onSinglePlayer\(\) \{[\s\S]*networkStatus\.showVersion\(\);[\s\S]*screens\.showCharacter/);
  assert.match(source, /function goToTitle\(\)[\s\S]*networkStatus\.showVersion\(\);[\s\S]*onlineClient\.disconnect\(\);/);
  assert.match(source, /function openOnlineLobby[\s\S]*onlineClient\.startTelemetry\(\)/);
  assert.doesNotMatch(source, /function goToTitle\(\)[\s\S]*onlineClient\.enterLobby\(\)/);
  assert.doesNotMatch(source, /PublicServerStatsPoller|publicStatsPoller/);
});

test('network telemetry is limited to online screens and online races', () => {
  assert.match(source, /function openOnlineLobby[\s\S]*networkStatus\.showDetails\(\)/);
  assert.match(source, /function showOnlineRoom[\s\S]*networkStatus\.showDetails\(\)/);
  assert.match(source, /function mountRace[\s\S]*if \(session\.kind === 'online'\) networkStatus\.showRace\(\);[\s\S]*else networkStatus\.hide\(\);/);
  assert.match(source, /function presentRaceResults[\s\S]*if \(online\) \{\s*networkStatus\.showDetails\(\);[\s\S]*\} else \{\s*networkStatus\.showVersion\(\);/);
  assert.match(source, /void networkStatus\.loadVersion\(\)/);
});

test('network recovery retries pending BGM playback', () => {
  assert.match(source, /window\.addEventListener\('online', \(\) => audio\.resume\(\)\)/);
});

test('online screens do not render duplicate connection badges', () => {
  assert.doesNotMatch(onlineScreensSource, /data-online-connection/);
});

test('main protects prepare/loading ordering with cancellable GPU warmup and ACK caching', () => {
  assert.match(source, /shouldPresentOnlineRoom\([\s\S]*roomState,[\s\S]*race\?\.session\.kind === 'online',[\s\S]*onlineClient\.selfId/);
  assert.match(source, /hasReturnedToOnlineRoom\(roomState, onlineClient\.selfId\)/);
  assert.match(
    source,
    /async function prewarmOnlineRace[\s\S]*await prewarmRaceRenderer\([\s\S]*if \(!ready\) return false;[\s\S]*submitOnlineRaceLoaded/,
  );
  assert.match(loaderSource, /await renderer\.compileAsync\([\s\S]*renderer\.compile\?\.\([\s\S]*renderer\.render\([\s\S]*await nextFrame\(\)/);
  assert.match(
    source,
    /function submitOnlineRaceLoaded[\s\S]*shouldAcknowledgeRaceLoaded\([\s\S]*onlineClient\.markRaceLoaded\(raceId\)[\s\S]*startOnlineRaceMusic/,
  );
  assert.match(
    source,
    /function activateOnlineRaceIfReady[\s\S]*loadReady[\s\S]*loadAcknowledged[\s\S]*hasAuthoritativeSnapshot[\s\S]*hud\.hideLoading\(\)[\s\S]*audio\.startEngine\(\)/,
  );
  assert.match(
    source,
    /mountedSession\?\.kind === 'online'[\s\S]*mountedSession\.raceId === message\?\.raceId[\s\S]*resumeFromPrepare/,
  );
  assert.match(source, /new OnlineRaceSession\(\{[\s\S]*roomState: onlineRoomState/);
  assert.match(source, /function endRace\(\)[\s\S]*onlineLoadGeneration\+\+[\s\S]*disposeSceneDeep\(race\.world\.scene\)/);
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
  assert.match(source, /if \(paused\) session\.flushPausedInput\?\.\(dt\);\s*else session\.flushInput\?\.\(playerControls\);/);
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
