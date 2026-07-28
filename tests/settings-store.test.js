import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  loadSettings,
  resetSettings,
  sanitizeSettings,
  saveSettings,
} from '../src/ui/settings-store.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

test('settings sanitize partial values and clamp volume ranges', () => {
  assert.deepEqual(sanitizeSettings({
    muted: true,
    master: 2,
    musicEnabled: false,
    music: -0.4,
    sfx: '0.35',
    menuBgm: 'bad-menu',
    raceBgm: 'rainbow-kart-dash',
  }), {
    muted: true,
    master: 1,
    musicEnabled: false,
    music: 0,
    sfx: 0.35,
    menuBgm: 'rainbow-drift',
    raceBgm: 'rainbow-kart-dash',
  });

  assert.deepEqual(sanitizeSettings({ master: 'bad' }), DEFAULT_SETTINGS);
});

test('settings save and load a versioned local record', () => {
  const storage = new MemoryStorage();
  const saved = saveSettings({ ...DEFAULT_SETTINGS, master: 0.65, muted: true }, storage);
  assert.equal(saved.master, 0.65);
  assert.equal(saved.muted, true);
  assert.deepEqual(loadSettings(storage), saved);
  assert.ok(storage.getItem(SETTINGS_STORAGE_KEY));
});

test('old settings records gain the new BGM defaults', () => {
  const storage = new MemoryStorage();
  storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ master: 0.65, sfx: 0.4 }));
  const loaded = loadSettings(storage);
  assert.equal(loaded.master, 0.65);
  assert.equal(loaded.sfx, 0.4);
  assert.equal(loaded.menuBgm, 'rainbow-drift');
  assert.equal(loaded.raceBgm, 'default');
});

test('invalid or unavailable storage falls back without throwing', () => {
  const corrupt = new MemoryStorage();
  corrupt.setItem(SETTINGS_STORAGE_KEY, '{broken json');
  assert.deepEqual(loadSettings(corrupt), DEFAULT_SETTINGS);

  const blocked = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  };
  assert.deepEqual(loadSettings(blocked), DEFAULT_SETTINGS);
  assert.doesNotThrow(() => saveSettings({ master: 0.5 }, blocked));
});

test('reset restores every default and persists it', () => {
  const storage = new MemoryStorage();
  saveSettings({ muted: true, master: 0, musicEnabled: false, music: 0, sfx: 0 }, storage);
  const reset = resetSettings(storage);
  assert.deepEqual(reset, DEFAULT_SETTINGS);
  assert.deepEqual(loadSettings(storage), DEFAULT_SETTINGS);
});
