import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

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
    'onlineClient.disconnect()',
  ];
  for (const call of requiredCalls) {
    assert.equal(source.includes(call), true, `missing main.js wiring: ${call}`);
  }
});

test('main subscribes to the room, race, result and reconnect event stream', () => {
  for (const event of [
    'connection', 'lobby_state', 'room_state', 'prepare_race', 'race_results', 'error', 'reconnect_expired',
  ]) {
    assert.match(source, new RegExp(`onlineClient\\.on\\('${event}'`));
  }
  assert.match(source, /onlineScreens\.updateResults\(message,/);
  assert.match(source, /onlineScreens\.activeScreen === 'lobby'[\s\S]*onlineScreens\.updateLobby/);
  assert.match(source, /onlineScreens\.activeScreen === 'room'[\s\S]*onlineScreens\.updateRoom/);
  assert.match(source, /if \(isOnlineConnectionError\(message\)\) onlineScreens\.setConnectionState\('error'\);/);
});

test('main protects prepare/loading ordering and resumed load acknowledgements', () => {
  assert.match(source, /shouldPresentOnlineRoom\([\s\S]*roomState,[\s\S]*race\?\.session\.kind === 'online',[\s\S]*onlineClient\.selfId/);
  assert.match(source, /hasReturnedToOnlineRoom\(roomState, onlineClient\.selfId\)/);
  assert.match(
    source,
    /if \(shouldAcknowledgeRaceLoaded\(message, onlineRoomState\)\) \{\s*onlineClient\.markRaceLoaded\(message\.raceId\);/,
  );
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
