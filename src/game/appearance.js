// Shared online racer appearance catalog. Gameplay stats continue to come from
// characters.js; paints and avatars are presentation-only and are safe to use
// from both the browser and the authoritative Node server.

import { isPlayableCharacterId } from './characters.js';

export const PAINT_THEMES = Object.freeze([
  { id: 'turbo-blue', name: 'Turbo Blue', color: 0x4aa8ff, accentColor: 0xffffff },
  { id: 'sunset-pop', name: 'Sunset Pop', color: 0xff5fa2, accentColor: 0x2b1b4a },
  { id: 'mint-rush', name: 'Mint Rush', color: 0x36d6a0, accentColor: 0xfff3b0 },
  { id: 'orange-flare', name: 'Orange Flare', color: 0xff9d2e, accentColor: 0x5a2d0c },
  { id: 'solar-gold', name: 'Solar Gold', color: 0xffd23f, accentColor: 0x3b2a04 },
  { id: 'violet-volt', name: 'Violet Volt', color: 0xb47cff, accentColor: 0x241040 },
  { id: 'ice-cyan', name: 'Ice Cyan', color: 0x7fe3ff, accentColor: 0x0d3c56 },
  { id: 'crimson-heat', name: 'Crimson Heat', color: 0xe8442e, accentColor: 0x2a0b08 },
  { id: 'lime-strike', name: 'Lime Strike', color: 0xa9e34b, accentColor: 0x203608 },
  { id: 'midnight-neon', name: 'Midnight Neon', color: 0x252a44, accentColor: 0x7fe3ff },
  { id: 'pearl-flash', name: 'Pearl Flash', color: 0xf2f4f8, accentColor: 0x4aa8ff },
  { id: 'graphite-gold', name: 'Graphite Gold', color: 0x666d78, accentColor: 0xffcc33 },
]);

export const AVATARS = Object.freeze([
  {
    id: 'cat', name: 'Cat', glyph: '\u{1F431}', kind: 'cat',
    headColor: 0xf2a65a, muzzleColor: 0xffdfb8, detailColor: 0x3a2419,
  },
  {
    id: 'dog', name: 'Dog', glyph: '\u{1F436}', kind: 'dog',
    headColor: 0xb87946, muzzleColor: 0xefd0a6, detailColor: 0x352116,
  },
  {
    id: 'rabbit', name: 'Rabbit', glyph: '\u{1F430}', kind: 'rabbit',
    headColor: 0xf3f1ee, muzzleColor: 0xffffff, detailColor: 0xff8faf,
  },
  {
    id: 'fox', name: 'Fox', glyph: '\u{1F98A}', kind: 'fox',
    headColor: 0xe86f28, muzzleColor: 0xffead2, detailColor: 0x3b2418,
  },
  {
    id: 'bear', name: 'Bear', glyph: '\u{1F43B}', kind: 'bear',
    headColor: 0x8b5e3c, muzzleColor: 0xd4a373, detailColor: 0x2d1b12,
  },
  {
    id: 'panda', name: 'Panda', glyph: '\u{1F43C}', kind: 'panda',
    headColor: 0xf4f4f4, muzzleColor: 0xffffff, detailColor: 0x202126,
  },
  {
    id: 'tiger', name: 'Tiger', glyph: '\u{1F42F}', kind: 'tiger',
    headColor: 0xf6a623, muzzleColor: 0xffdfae, detailColor: 0x2a1a0c,
  },
  {
    id: 'raccoon', name: 'Raccoon', glyph: '\u{1F99D}', kind: 'raccoon',
    headColor: 0x8b929c, muzzleColor: 0xd9dde2, detailColor: 0x2c3138,
  },
]);

export const PAINT_THEMES_BY_ID = Object.freeze(
  Object.fromEntries(PAINT_THEMES.map((paint) => [paint.id, paint])),
);
export const AVATARS_BY_ID = Object.freeze(
  Object.fromEntries(AVATARS.map((avatar) => [avatar.id, avatar])),
);

export const DEFAULT_ONLINE_LOADOUT = Object.freeze({
  characterId: 'kit',
  paintId: 'turbo-blue',
  avatarId: 'cat',
});

export const DEFAULT_CHARACTER_LOADOUTS = Object.freeze({
  pip: Object.freeze({ paintId: 'mint-rush', avatarId: 'rabbit' }),
  nova: Object.freeze({ paintId: 'sunset-pop', avatarId: 'fox' }),
  kit: Object.freeze({ paintId: 'turbo-blue', avatarId: 'cat' }),
  roscoe: Object.freeze({ paintId: 'orange-flare', avatarId: 'dog' }),
  mirage: Object.freeze({ paintId: 'violet-volt', avatarId: 'raccoon' }),
  brick: Object.freeze({ paintId: 'crimson-heat', avatarId: 'bear' }),
  tundra: Object.freeze({ paintId: 'ice-cyan', avatarId: 'panda' }),
  gearbox: Object.freeze({ paintId: 'graphite-gold', avatarId: 'tiger' }),
});

export function isPaintId(value) {
  return typeof value === 'string' && Object.hasOwn(PAINT_THEMES_BY_ID, value);
}

export function isAvatarId(value) {
  return typeof value === 'string' && Object.hasOwn(AVATARS_BY_ID, value);
}

export function getPaintTheme(id) {
  return PAINT_THEMES_BY_ID[id] || PAINT_THEMES_BY_ID[DEFAULT_ONLINE_LOADOUT.paintId];
}

export function getAvatar(id) {
  return AVATARS_BY_ID[id] || AVATARS_BY_ID[DEFAULT_ONLINE_LOADOUT.avatarId];
}

/** Pick a deterministic cosmetic pair that stays distinct for repeated bodies. */
export function pickDistinctAppearance(
  rng,
  usedAppearances = [],
  paints = PAINT_THEMES,
  avatars = AVATARS,
) {
  if (!paints.length || !avatars.length) {
    return {
      paintId: paints[0]?.id || DEFAULT_ONLINE_LOADOUT.paintId,
      avatarId: avatars[0]?.id || DEFAULT_ONLINE_LOADOUT.avatarId,
    };
  }

  const total = paints.length * avatars.length;
  const start = typeof rng?.int === 'function' ? rng.int(0, total - 1) : 0;
  const usedPairs = new Set(usedAppearances.map(({ paintId, avatarId }) => `${paintId}:${avatarId}`));
  const usedPaints = new Set(usedAppearances.map(({ paintId }) => paintId));
  const usedAvatars = new Set(usedAppearances.map(({ avatarId }) => avatarId));
  let pairFallback = null;

  for (let offset = 0; offset < total; offset++) {
    const index = (start + offset) % total;
    const paintId = paints[index % paints.length].id;
    const avatarId = avatars[Math.floor(index / paints.length) % avatars.length].id;
    const candidate = { paintId, avatarId };
    if (!usedPairs.has(`${paintId}:${avatarId}`) && !pairFallback) pairFallback = candidate;
    if (!usedPaints.has(paintId) && !usedAvatars.has(avatarId)) return candidate;
  }

  return pairFallback || {
    paintId: paints[start % paints.length].id,
    avatarId: avatars[Math.floor(start / paints.length) % avatars.length].id,
  };
}

export function defaultLoadoutForCharacter(characterId) {
  const playableCharacterId = isPlayableCharacterId(characterId)
    ? characterId : DEFAULT_ONLINE_LOADOUT.characterId;
  const defaults = DEFAULT_CHARACTER_LOADOUTS[playableCharacterId]
    || DEFAULT_CHARACTER_LOADOUTS[DEFAULT_ONLINE_LOADOUT.characterId];
  return {
    characterId: playableCharacterId,
    paintId: defaults.paintId,
    avatarId: defaults.avatarId,
  };
}

/** Sanitize a locally stored complete online loadout. */
export function sanitizeOnlineLoadout(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    characterId: isPlayableCharacterId(source.characterId)
      ? source.characterId : DEFAULT_ONLINE_LOADOUT.characterId,
    paintId: isPaintId(source.paintId) ? source.paintId : DEFAULT_ONLINE_LOADOUT.paintId,
    avatarId: isAvatarId(source.avatarId) ? source.avatarId : DEFAULT_ONLINE_LOADOUT.avatarId,
  };
}

/** Resolve render colours and avatar without changing the supplied character. */
export function resolveKartAppearance(character, loadout = {}) {
  const paint = isPaintId(loadout.paintId) ? PAINT_THEMES_BY_ID[loadout.paintId] : null;
  const avatar = isAvatarId(loadout.avatarId) ? AVATARS_BY_ID[loadout.avatarId] : null;
  return {
    paintId: paint?.id ?? null,
    avatarId: avatar?.id ?? null,
    color: paint?.color ?? character.color,
    accentColor: paint?.accentColor ?? character.accentColor,
    avatar,
  };
}
