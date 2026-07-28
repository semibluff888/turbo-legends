import test from 'node:test';
import assert from 'node:assert/strict';

import { RACE_BGM_CHOICES } from '../src/audio/bgm.js';
import { Screens } from '../src/ui/screens.js';

function makeChoiceScreen(value, options = RACE_BGM_CHOICES) {
  const changes = [];
  const screen = Object.create(Screens.prototype);
  screen._settings = { raceBgm: value };
  screen._settingDefs = new Map([
    ['raceBgm', { key: 'raceBgm', kind: 'choice', options }],
  ]);
  screen.callbacks = { onSettingsChange: (key, next) => changes.push([key, next]) };
  screen._syncSettings = () => {};
  return { screen, changes, node: { dataset: { value: 'raceBgm' } } };
}

test('choice settings cycle in both directions and wrap around', () => {
  const { screen, changes, node } = makeChoiceScreen('default');
  assert.equal(screen._cycleChoice(node, -1), true);
  assert.equal(screen._settings.raceBgm, 'rainbow-kart-dash');
  assert.equal(screen._cycleChoice(node, 1), true);
  assert.equal(screen._settings.raceBgm, 'default');
  assert.deepEqual(changes, [
    ['raceBgm', 'rainbow-kart-dash'],
    ['raceBgm', 'default'],
  ]);
});

test('a one-option choice is displayed but cannot change', () => {
  const { screen, changes, node } = makeChoiceScreen('rainbow-drift', [
    { value: 'rainbow-drift', label: 'Rainbow Drift' },
  ]);
  assert.equal(screen._cycleChoice(node, 1), false);
  assert.equal(screen._settings.raceBgm, 'rainbow-drift');
  assert.deepEqual(changes, []);
});
