import test from 'node:test';
import assert from 'node:assert/strict';

import {
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
  assert.match(resolveRaceBgm('default', 'harbor-loop').url,
    /Rainbow%20Kart%20Parade%20\(0\.90x\)\.mp3$/);
});
