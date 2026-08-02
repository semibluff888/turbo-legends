import {
  DEFAULT_ONLINE_LOADOUT,
  sanitizeOnlineLoadout,
} from '../game/appearance.js';
import { CHARACTERS_BY_ID } from '../game/characters.js';

export const ONLINE_LOADOUT_STORAGE_KEY = 'turbo-kart.online-loadout.v1';

function storageOrDefault(storage) {
  if (storage !== undefined) return storage;
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function sanitizeStoredOnlineLoadout(value) {
  const sanitized = sanitizeOnlineLoadout(value);
  return {
    ...sanitized,
    characterId: Object.hasOwn(CHARACTERS_BY_ID, sanitized.characterId)
      ? sanitized.characterId : DEFAULT_ONLINE_LOADOUT.characterId,
  };
}

export function loadOnlineLoadout(storage) {
  const target = storageOrDefault(storage);
  if (!target || typeof target.getItem !== 'function') {
    return sanitizeStoredOnlineLoadout(null);
  }
  try {
    const raw = target.getItem(ONLINE_LOADOUT_STORAGE_KEY);
    return sanitizeStoredOnlineLoadout(raw ? JSON.parse(raw) : null);
  } catch {
    return sanitizeStoredOnlineLoadout(null);
  }
}

export function saveOnlineLoadout(loadout, storage) {
  const next = sanitizeStoredOnlineLoadout(loadout);
  const target = storageOrDefault(storage);
  if (target && typeof target.setItem === 'function') {
    try { target.setItem(ONLINE_LOADOUT_STORAGE_KEY, JSON.stringify(next)); } catch {}
  }
  return next;
}

