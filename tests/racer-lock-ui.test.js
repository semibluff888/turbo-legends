import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const screens = readFileSync(new URL('../src/ui/screens.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

test('single-player locked Racer cards are visible but excluded from selection', () => {
  assert.match(screens, /ch\.availability === 'locked'/);
  assert.match(screens, /locked \? 'COMING SOON'/);
  assert.match(screens, /if \(!locked\) this\._wireOption/);
  assert.match(screens, /racer-secret-silhouette/);
  assert.match(styles, /\.char-card\.is-locked/);
  assert.match(styles, /\.stat-fill\.is-overcap/);
  assert.match(main, /if \(!isPlayableCharacterId\(id\)\) return/);
  assert.match(main, /if \(isPlayableCharacterId\(q\.get\('char'\)\)\)/);
});
