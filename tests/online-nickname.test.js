import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEGACY_ONLINE_NAME_STORAGE_KEY,
  ONLINE_NAME_STORAGE_KEY,
  ONLINE_NICKNAME_CANDIDATES,
  isValidOnlineDisplayName,
  loadOnlineDisplayName,
  randomOnlineDisplayName,
  saveOnlineDisplayName,
} from '../src/ui/online-nickname.js';

class MemoryStorage {
  constructor() { this.data = new Map(); }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}

test('a first-time player receives and persists a deterministic random nickname', () => {
  const storage = new MemoryStorage();
  const name = loadOnlineDisplayName({ storage, random: () => 0 });

  assert.equal(name, ONLINE_NICKNAME_CANDIDATES[0]);
  assert.equal(storage.getItem(ONLINE_NAME_STORAGE_KEY), name);
  assert.equal(loadOnlineDisplayName({ storage, random: () => 0.99 }), name);
});

test('a valid custom v1 nickname migrates while the old Racer placeholder does not', () => {
  const customStorage = new MemoryStorage();
  customStorage.setItem(LEGACY_ONLINE_NAME_STORAGE_KEY, '  Nova   Fan  ');
  assert.equal(loadOnlineDisplayName({ storage: customStorage, random: () => 0 }), 'Nova Fan');
  assert.equal(customStorage.getItem(ONLINE_NAME_STORAGE_KEY), 'Nova Fan');
  assert.equal(customStorage.getItem(LEGACY_ONLINE_NAME_STORAGE_KEY), null);

  const defaultStorage = new MemoryStorage();
  defaultStorage.setItem(LEGACY_ONLINE_NAME_STORAGE_KEY, 'Racer');
  const generated = loadOnlineDisplayName({ storage: defaultStorage, random: () => 0.5 });
  assert.equal(generated, randomOnlineDisplayName(() => 0.5));
  assert.notEqual(generated, 'Racer');

  const v2DefaultStorage = new MemoryStorage();
  v2DefaultStorage.setItem(ONLINE_NAME_STORAGE_KEY, 'Racer');
  const v2Generated = loadOnlineDisplayName({ storage: v2DefaultStorage, random: () => 0.25 });
  assert.equal(v2Generated, 'Racer');
  assert.equal(v2DefaultStorage.getItem(ONLINE_NAME_STORAGE_KEY), 'Racer');
});

test('manual nickname edits normalize and persist without uniqueness checks', () => {
  const storage = new MemoryStorage();
  assert.equal(saveOnlineDisplayName('  Same   Name ', { storage }), 'Same Name');
  assert.equal(saveOnlineDisplayName('Same Name', { storage }), 'Same Name');
  assert.equal(storage.getItem(ONLINE_NAME_STORAGE_KEY), 'Same Name');
});

test('invalid manual nicknames are rejected and do not replace the saved value', () => {
  const storage = new MemoryStorage();
  saveOnlineDisplayName('Grid Fox', { storage });

  assert.equal(saveOnlineDisplayName('', { storage }), '');
  assert.equal(saveOnlineDisplayName('A'.repeat(21), { storage }), '');
  assert.equal(saveOnlineDisplayName('Bad\u202eName', { storage }), '');
  assert.equal(storage.getItem(ONLINE_NAME_STORAGE_KEY), 'Grid Fox');
  assert.equal(isValidOnlineDisplayName('Drift Comet'), true);
  assert.equal(isValidOnlineDisplayName(''), false);
});

test('random nickname selection clamps hostile random values', () => {
  assert.equal(randomOnlineDisplayName(() => -5), ONLINE_NICKNAME_CANDIDATES[0]);
  assert.equal(randomOnlineDisplayName(() => 5), ONLINE_NICKNAME_CANDIDATES.at(-1));
  assert.equal(randomOnlineDisplayName(() => Number.NaN), ONLINE_NICKNAME_CANDIDATES[0]);
});
