// Persistent, non-unique display names for online play.
//
// A nickname is presentation only; participantId remains the sole identity.

import { validateDisplayName } from '../net/protocol.js';

export const ONLINE_NAME_STORAGE_KEY = 'turbo-legends.online-name.v2';
export const LEGACY_ONLINE_NAME_STORAGE_KEY = 'turbo-legends.online-name.v1';

function combineNicknameParts(prefixes, suffixes) {
  return prefixes.flatMap(prefix => suffixes.map(suffix => `${prefix}${suffix}`));
}

const RACING_NICKNAMES = combineNicknameParts(
  ['疾风', '闪电', '烈焰', '极夜', '涡轮', '弯道', '氮气', '追风'],
  ['车神', '领航员', '追逐者', '小旋风', '漂移王', '飞车手'],
);

const EVERYDAY_NICKNAMES = combineNicknameParts(
  ['爱吃的', '不想回家的', '正在摸鱼的', '总在迟到的', '周末赖床的', '奶茶续杯的', '今天超困的', '好运爆棚的'],
  ['喵酱', '嘟嘟', '团子', '布丁', '小熊', '橘子', '泡芙', '豆包'],
);

const HERO_NICKNAMES = combineNicknameParts(
  ['超神', '王牌', '无敌', '幸运', '神秘', '快乐'],
  ['卡尔', '阿洛', '小满', '可乐', '米粒', '多多'],
);

export const ONLINE_NICKNAME_CANDIDATES = Object.freeze([
  ...RACING_NICKNAMES,
  ...EVERYDAY_NICKNAMES,
  ...HERO_NICKNAMES,
]);

function validName(value) {
  const result = validateDisplayName(value);
  return result.ok ? result.value : '';
}

function read(storage, key) {
  try { return storage?.getItem(key); } catch { return null; }
}

function write(storage, key, value) {
  try {
    storage?.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function remove(storage, key) {
  try { storage?.removeItem(key); } catch {}
}

export function randomOnlineDisplayName(
  random = Math.random,
  candidates = ONLINE_NICKNAME_CANDIDATES,
) {
  const names = Array.isArray(candidates)
    ? candidates.map(validName).filter(Boolean)
    : [];
  if (names.length === 0) return '疾风车手';
  const roll = Number(random?.());
  const unit = Number.isFinite(roll) ? Math.max(0, Math.min(0.999999999999, roll)) : 0;
  return names[Math.floor(unit * names.length)];
}

/**
 * Load the v2 nickname, migrate a valid v1 custom nickname, or generate one.
 * The old built-in placeholder "Racer" is intentionally not migrated.
 */
export function loadOnlineDisplayName({
  storage = globalThis.localStorage,
  random = Math.random,
} = {}) {
  const current = validName(read(storage, ONLINE_NAME_STORAGE_KEY));
  if (current) {
    write(storage, ONLINE_NAME_STORAGE_KEY, current);
    return current;
  }
  remove(storage, ONLINE_NAME_STORAGE_KEY);

  const legacy = validName(read(storage, LEGACY_ONLINE_NAME_STORAGE_KEY));
  remove(storage, LEGACY_ONLINE_NAME_STORAGE_KEY);
  if (legacy && legacy !== 'Racer') {
    write(storage, ONLINE_NAME_STORAGE_KEY, legacy);
    return legacy;
  }

  const generated = randomOnlineDisplayName(random);
  write(storage, ONLINE_NAME_STORAGE_KEY, generated);
  return generated;
}

/** Save and return the normalized nickname, or return an empty string. */
export function saveOnlineDisplayName(
  value,
  { storage = globalThis.localStorage } = {},
) {
  const displayName = validName(value);
  if (!displayName) return '';
  write(storage, ONLINE_NAME_STORAGE_KEY, displayName);
  remove(storage, LEGACY_ONLINE_NAME_STORAGE_KEY);
  return displayName;
}

export function isValidOnlineDisplayName(value) {
  return Boolean(validName(value));
}
