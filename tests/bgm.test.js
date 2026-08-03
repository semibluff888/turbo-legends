import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BGM_ASSET_VERSION,
  MENU_BGM_CHOICES,
  RACE_BGM_CHOICES,
  resolveMenuBgm,
  resolveRaceBgm,
  sanitizeMenuBgm,
  sanitizeRaceBgm,
} from '../src/audio/bgm.js';

test('default race BGM follows the selected track', () => {
  assert.equal(resolveRaceBgm('default', 'sunset-circuit').id, 'rainbow-lap-rush');
  assert.equal(resolveRaceBgm('default', 'harbor-loop').id, 'rainbow-kart-parade');
  assert.equal(resolveRaceBgm('default', 'summit-raceway').id, 'rainbow-kart-dash');
});

test('an explicit race BGM overrides every track', () => {
  for (const trackId of ['sunset-circuit', 'harbor-loop', 'summit-raceway']) {
    assert.equal(resolveRaceBgm('rainbow-kart-dash', trackId).id, 'rainbow-kart-dash');
  }
});

test('BGM preferences sanitize invalid values and expose encoded asset URLs', () => {
  assert.equal(sanitizeMenuBgm('bad'), 'rainbow-drift');
  assert.equal(sanitizeRaceBgm('bad'), 'default');
  assert.equal(resolveMenuBgm('bad').id, 'rainbow-drift');
  const url = new URL(resolveRaceBgm('default', 'harbor-loop').url);
  assert.match(url.pathname, /Rainbow%20Kart%20Parade%20\(0\.90x\)\.mp3$/);
  assert.equal(url.searchParams.get('v'), BGM_ASSET_VERSION);
});

test('menu BGM choices include Neon Kart Groove', () => {
  assert.deepEqual(
    MENU_BGM_CHOICES.find((choice) => choice.value === 'neon-kart-groove'),
    { value: 'neon-kart-groove', label: 'Neon Kart Groove' },
  );
  assert.equal(sanitizeMenuBgm('neon-kart-groove'), 'neon-kart-groove');
  assert.equal(resolveMenuBgm('neon-kart-groove').id, 'neon-kart-groove');
  assert.match(resolveMenuBgm('neon-kart-groove').url, /Neon%20Kart%20Groove\.mp3\?v=/);
});

test('menu and race BGM choices expose random playback modes', () => {
  assert.deepEqual(MENU_BGM_CHOICES[0], { value: 'random', label: 'Random' });
  assert.deepEqual(RACE_BGM_CHOICES[1], { value: 'random', label: 'Random' });
  assert.equal(sanitizeMenuBgm('random'), 'random');
  assert.equal(sanitizeRaceBgm('random'), 'random');
});

test('random BGM selection uses the tracks available for each scene', () => {
  const firstMenu = resolveMenuBgm('random', { random: () => 0 });
  const lastMenu = resolveMenuBgm('random', { random: () => 0.999 });
  assert.equal(firstMenu.id, 'rainbow-drift');
  assert.equal(lastMenu.id, 'neon-kart-groove');

  const firstRace = resolveRaceBgm('random', 'sunset-circuit', { random: () => 0 });
  const lastRace = resolveRaceBgm('random', 'sunset-circuit', { random: () => 0.999 });
  assert.equal(firstRace.id, 'rainbow-lap-rush');
  assert.equal(lastRace.id, 'rainbow-kart-dash');
});
