import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

test('main maps every online screen action to the transport client', () => {
  const requiredCalls = [
    'onlineClient.createRoom(displayName)',
    'onlineClient.joinRoom(roomCode, displayName)',
    'onlineClient.selectCharacter(characterId)',
    'onlineClient.setRoom(settings)',
    'onlineClient.setReady(ready)',
    'onlineClient.startRace()',
    'onlineClient.leave()',
    'onlineClient.returnLobby()',
  ];
  for (const call of requiredCalls) {
    assert.equal(source.includes(call), true, `missing main.js wiring: ${call}`);
  }
});

test('main subscribes to the room, race, result and reconnect event stream', () => {
  for (const event of [
    'connection', 'room_state', 'prepare_race', 'race_results', 'error', 'reconnect_expired',
  ]) {
    assert.match(source, new RegExp(`onlineClient\\.on\\('${event}'`));
  }
  assert.match(source, /onlineScreens\.updateResults\(message,/);
  assert.match(source, /if \(isOnlineConnectionError\(message\)\) onlineScreens\.setConnectionState\('error'\);/);
});

test('main protects prepare/loading ordering and resumed load acknowledgements', () => {
  assert.match(source, /shouldPresentOnlineLobby\(roomState, race\?\.session\.kind === 'online'\)/);
  assert.match(
    source,
    /if \(shouldAcknowledgeRaceLoaded\(message, onlineRoomState\)\) \{\s*onlineClient\.markRaceLoaded\(message\.raceId\);/,
  );
});

test('main keeps paused online panels alive and neutralizes hidden-page controls', () => {
  assert.match(source, /shouldUpdateOnlineRaceBehindPanel\(\{/);
  assert.match(source, /updateMenus\(\);\s*updateRaceFrame\(dt\);\s*renderer\.render\(race\.world\.scene, camera\);/);
  assert.match(
    source,
    /visibilitychange[\s\S]*race\?\.session\.kind === 'online'[\s\S]*race\.session\.sendNeutralInput\?\.\(\)/,
  );
});
