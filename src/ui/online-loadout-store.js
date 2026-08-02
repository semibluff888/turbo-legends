import {
  AVATARS,
  DEFAULT_ONLINE_LOADOUT,
  PAINT_THEMES,
  isAvatarId,
  isPaintId,
} from '../game/appearance.js';
import { CHARACTERS_BY_ID } from '../game/characters.js';

export const ONLINE_LOADOUT_STORAGE_KEY = 'turbo-kart.online-loadout.v1';

function storageOrDefault(storage) {
  if (storage !== undefined) return storage;
  try { return globalThis.localStorage || null; } catch { return null; }
}

function randomCatalogId(entries, random, fallback) {
  let sample = 0;
  try { sample = Number(random()); } catch { sample = 0; }
  const index = Number.isFinite(sample)
    ? Math.min(entries.length - 1, Math.max(0, Math.floor(sample * entries.length)))
    : 0;
  return entries[index]?.id || fallback;
}

export function sanitizeStoredOnlineLoadout(value, random = Math.random) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    characterId: Object.hasOwn(CHARACTERS_BY_ID, source.characterId)
      ? source.characterId : DEFAULT_ONLINE_LOADOUT.characterId,
    paintId: isPaintId(source.paintId)
      ? source.paintId
      : randomCatalogId(PAINT_THEMES, random, DEFAULT_ONLINE_LOADOUT.paintId),
    avatarId: isAvatarId(source.avatarId)
      ? source.avatarId
      : randomCatalogId(AVATARS, random, DEFAULT_ONLINE_LOADOUT.avatarId),
  };
}

export function loadOnlineLoadout(storage, random = Math.random) {
  const target = storageOrDefault(storage);
  if (!target || typeof target.getItem !== 'function') {
    return sanitizeStoredOnlineLoadout(null, random);
  }
  try {
    const raw = target.getItem(ONLINE_LOADOUT_STORAGE_KEY);
    return sanitizeStoredOnlineLoadout(raw ? JSON.parse(raw) : null, random);
  } catch {
    return sanitizeStoredOnlineLoadout(null, random);
  }
}

export function saveOnlineLoadout(loadout, storage, random = Math.random) {
  const next = sanitizeStoredOnlineLoadout(loadout, random);
  const target = storageOrDefault(storage);
  if (target && typeof target.setItem === 'function') {
    try { target.setItem(ONLINE_LOADOUT_STORAGE_KEY, JSON.stringify(next)); } catch {}
  }
  return next;
}
