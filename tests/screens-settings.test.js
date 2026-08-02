import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { RACE_BGM_CHOICES } from '../src/audio/bgm.js';
import { Screens } from '../src/ui/screens.js';

const stylesSource = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

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

test('main menu labels stay centered between symmetrical icon and action columns', () => {
  assert.match(stylesSource, /\.main-menu-option \{[\s\S]*?grid-template-columns: 48px minmax\(0, 1fr\) 48px;/);
  assert.match(stylesSource, /\.main-menu-copy \{[\s\S]*?text-align: center;/);
  assert.match(stylesSource, /\.main-menu-option \{ grid-template-columns: 38px minmax\(0, 1fr\) 38px; gap: 9px; \}/);
});
