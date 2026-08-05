import {
  DEFAULT_MENU_BGM,
  DEFAULT_RACE_BGM,
  sanitizeMenuBgm,
  sanitizeRaceBgm,
} from '../audio/bgm.js';
import { DEFAULT_LANGUAGE, sanitizeLanguage } from './copy.js';

export const SETTINGS_STORAGE_KEY = 'turbo-kart.settings.v1';

export const DEFAULT_SETTINGS = Object.freeze({
  language: DEFAULT_LANGUAGE,
  muted: false,
  master: 1,
  musicEnabled: true,
  music: 1,
  sfx: 1,
  menuBgm: DEFAULT_MENU_BGM,
  raceBgm: DEFAULT_RACE_BGM,
});

function clampUnit(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

export function sanitizeSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    language: sanitizeLanguage(source.language),
    muted: typeof source.muted === 'boolean' ? source.muted : DEFAULT_SETTINGS.muted,
    master: clampUnit(source.master, DEFAULT_SETTINGS.master),
    musicEnabled: typeof source.musicEnabled === 'boolean'
      ? source.musicEnabled : DEFAULT_SETTINGS.musicEnabled,
    music: clampUnit(source.music, DEFAULT_SETTINGS.music),
    sfx: clampUnit(source.sfx, DEFAULT_SETTINGS.sfx),
    menuBgm: sanitizeMenuBgm(source.menuBgm),
    raceBgm: sanitizeRaceBgm(source.raceBgm),
  };
}

function getStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function loadSettings(storage) {
  const target = getStorage(storage);
  if (!target || typeof target.getItem !== 'function') return sanitizeSettings(null);
  try {
    const raw = target.getItem(SETTINGS_STORAGE_KEY);
    return raw ? sanitizeSettings(JSON.parse(raw)) : sanitizeSettings(null);
  } catch {
    return sanitizeSettings(null);
  }
}

export function saveSettings(settings, storage) {
  const next = sanitizeSettings(settings);
  const target = getStorage(storage);
  if (target && typeof target.setItem === 'function') {
    try {
      target.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Private browsing and storage quotas must never block the game.
    }
  }
  return next;
}

export function resetSettings(storage) {
  return saveSettings(DEFAULT_SETTINGS, storage);
}
