import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AVATARS,
  DEFAULT_ONLINE_LOADOUT,
  PAINT_THEMES,
  defaultLoadoutForCharacter,
  resolveKartAppearance,
} from '../src/game/appearance.js';
import { getCharacter } from '../src/game/characters.js';
import { Kart } from '../src/game/kart.js';
import { makeKartPreview } from '../src/render/kartMesh.js';
import {
  ONLINE_LOADOUT_STORAGE_KEY,
  loadOnlineLoadout,
  saveOnlineLoadout,
} from '../src/ui/online-loadout-store.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

test('online appearance catalogs expose the planned paints, avatars and defaults', () => {
  assert.equal(PAINT_THEMES.length, 12);
  assert.equal(new Set(PAINT_THEMES.map((paint) => paint.id)).size, 12);
  assert.equal(AVATARS.length, 8);
  assert.deepEqual(AVATARS.map((avatar) => avatar.id), [
    'cat', 'dog', 'rabbit', 'fox', 'bear', 'panda', 'tiger', 'raccoon',
  ]);
  assert.deepEqual(DEFAULT_ONLINE_LOADOUT, {
    characterId: 'kit', paintId: 'turbo-blue', avatarId: 'cat',
  });
  assert.deepEqual(defaultLoadoutForCharacter('tundra'), {
    characterId: 'tundra', paintId: 'ice-cyan', avatarId: 'panda',
  });
});

test('Kart appearance is cosmetic and preserves character stats', () => {
  const character = getCharacter('kit');
  const appearance = resolveKartAppearance(character, {
    paintId: 'crimson-heat', avatarId: 'dog',
  });
  const kart = new Kart({
    index: 0, character, paintId: 'crimson-heat', avatarId: 'dog',
  });
  assert.equal(kart.color, appearance.color);
  assert.equal(kart.accentColor, appearance.accentColor);
  assert.equal(kart.avatarId, 'dog');
  assert.equal(kart.statSpeed, character.stats.speed);
  assert.equal(kart.statHandling, character.stats.handling);
});

test('every online avatar builds a disposable procedural kart preview', () => {
  const character = getCharacter('kit');
  for (const avatar of AVATARS) {
    const preview = makeKartPreview(character, {
      paintId: 'turbo-blue', avatarId: avatar.id,
    });
    let meshes = 0;
    preview.group.traverse((object) => { if (object.isMesh) meshes += 1; });
    assert.equal(preview.appearance.avatarId, avatar.id);
    assert.ok(meshes > 20, `${avatar.id} should add a complete kart and driver`);
    preview.dispose();
  }
});

test('online loadout storage sanitizes invalid values and persists valid choices', () => {
  const storage = new MemoryStorage();
  storage.setItem(ONLINE_LOADOUT_STORAGE_KEY, JSON.stringify({
    characterId: 'missing', paintId: 'missing', avatarId: 'missing',
  }));
  assert.deepEqual(loadOnlineLoadout(storage), DEFAULT_ONLINE_LOADOUT);

  const saved = saveOnlineLoadout({
    characterId: 'nova', paintId: 'sunset-pop', avatarId: 'fox',
  }, storage);
  assert.deepEqual(saved, {
    characterId: 'nova', paintId: 'sunset-pop', avatarId: 'fox',
  });
  assert.deepEqual(loadOnlineLoadout(storage), saved);
});

