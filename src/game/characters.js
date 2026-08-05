// Racer roster. Original characters — the genre is "kart racer", the cast is ours.
//
// Stats are multipliers on the KART baseline and must stay inside
// CHARACTER_STAT_RANGE. The classic design rule applies: every racer trades
// something. Heavy racers win collisions and hold top speed but accelerate
// slowly and turn wide; light racers are nimble but get shoved around.

import { CHARACTER_STAT_RANGE } from '../core/constants.js';

/**
 * @typedef {object} Character
 * @property {string} id
 * @property {string} name
 * @property {string} blurb
 * @property {'cyber'|'chibi'|'f1'|'quantum'|'offroad'|'breeze'|null} modelId
 * @property {'available'|'locked'} availability
 * @property {'light'|'medium'|'heavy'} weightClass
 * @property {number} color primary body colour
 * @property {number} accentColor trim / helmet colour
 * @property {{speed:number, accel:number, handling:number, weight:number}} stats
 */

/** @type {Character[]} */
export const CHARACTERS = [
  {
    id: 'pip',
    name: 'NEON RAZOR',
    blurb: 'Low-slung cyber hardware built for ruthless straight-line speed.',
    modelId: 'cyber',
    availability: 'available',
    weightClass: 'medium',
    color: 0x36d6a0,
    accentColor: 0xfff3b0,
    stats: { speed: 1.09, accel: 0.90, handling: 0.94, weight: 1.02 },
  },
  {
    id: 'nova',
    name: 'SUGAR SPARK',
    blurb: 'A candy-coated featherweight that launches hard and turns instantly.',
    modelId: 'chibi',
    availability: 'available',
    weightClass: 'light',
    color: 0xff5fa2,
    accentColor: 0x2b1b4a,
    stats: { speed: 0.92, accel: 1.18, handling: 1.16, weight: 0.80 },
  },
  {
    id: 'kit',
    name: 'APEX R-1',
    blurb: 'Open-wheel precision: fast, sharp, and unforgiving in contact.',
    modelId: 'f1',
    availability: 'available',
    weightClass: 'medium',
    color: 0x4aa8ff,
    accentColor: 0xffffff,
    stats: { speed: 1.07, accel: 0.96, handling: 1.10, weight: 0.88 },
  },
  {
    id: 'roscoe',
    name: 'PHASE WRAITH',
    blurb: 'Crystal propulsion delivers explosive launches with almost no mass.',
    modelId: 'quantum',
    availability: 'available',
    weightClass: 'light',
    color: 0xffb340,
    accentColor: 0x5a2d0c,
    stats: { speed: 1.02, accel: 1.14, handling: 0.96, weight: 0.84 },
  },
  {
    id: 'mirage',
    name: 'THUNDERHAUL',
    blurb: 'Steel cage, long-travel suspension, and collision-winning mass.',
    modelId: 'offroad',
    availability: 'available',
    weightClass: 'heavy',
    color: 0xb47cff,
    accentColor: 0x241040,
    stats: { speed: 1.05, accel: 0.86, handling: 0.88, weight: 1.30 },
  },
  {
    id: 'brick',
    name: 'BREEZE RUNNER',
    blurb: 'A light classic kart tuned for recovery and surgical cornering.',
    modelId: 'breeze',
    availability: 'available',
    weightClass: 'light',
    color: 0xe8442e,
    accentColor: 0x2a2a2a,
    stats: { speed: 0.97, accel: 1.08, handling: 1.14, weight: 0.92 },
  },
  {
    id: 'tundra',
    name: 'GLACIER X',
    blurb: 'A classified cryo-drive prototype projected beyond the current grip limit.',
    modelId: null,
    availability: 'locked',
    weightClass: 'medium',
    color: 0x7fe3ff,
    accentColor: 0x0d3c56,
    stats: { speed: 1.11, accel: 1.20, handling: 1.20, weight: 1.04 },
  },
  {
    id: 'gearbox',
    name: 'TITAN ZERO',
    blurb: 'An unreleased power unit with league-breaking speed and impact figures.',
    modelId: null,
    availability: 'locked',
    weightClass: 'heavy',
    color: 0x9aa4b0,
    accentColor: 0xffcc33,
    stats: { speed: 1.14, accel: 1.04, handling: 0.94, weight: 1.38 },
  },
];

export const CHARACTERS_BY_ID = Object.fromEntries(CHARACTERS.map((c) => [c.id, c]));
export const PLAYABLE_CHARACTERS = Object.freeze(
  CHARACTERS.filter((character) => character.availability === 'available'),
);

export function isPlayableCharacterId(id) {
  return CHARACTERS_BY_ID[id]?.availability === 'available';
}

export function getCharacter(id) {
  return CHARACTERS_BY_ID[id] || CHARACTERS[2];
}

export function getPlayableCharacter(id) {
  return isPlayableCharacterId(id) ? CHARACTERS_BY_ID[id] : CHARACTERS_BY_ID.kit;
}

const LOCKED_CHARACTER_STAT_RANGE = {
  speed: [CHARACTER_STAT_RANGE.speed[0], 1.14],
  accel: [CHARACTER_STAT_RANGE.accel[0], 1.20],
  handling: [CHARACTER_STAT_RANGE.handling[0], 1.20],
  weight: [CHARACTER_STAT_RANGE.weight[0], 1.38],
};

/**
 * Validate that every character's stats sit inside the sanctioned range.
 * Exported so the test suite can assert the roster stays balanced.
 * @returns {string[]} list of problems (empty when the roster is valid)
 */
export function validateRoster(roster = CHARACTERS) {
  const problems = [];
  const seen = new Set();
  for (const c of roster) {
    if (seen.has(c.id)) problems.push(`duplicate character id: ${c.id}`);
    seen.add(c.id);
    const range = c.availability === 'locked'
      ? LOCKED_CHARACTER_STAT_RANGE : CHARACTER_STAT_RANGE;
    if (c.availability === 'available' && !c.modelId) {
      problems.push(`${c.id}.modelId is required for an available Racer`);
    }
    for (const [key, [lo, hi]] of Object.entries(range)) {
      const v = c.stats[key];
      if (typeof v !== 'number' || Number.isNaN(v)) {
        problems.push(`${c.id}.${key} is not a number`);
      } else if (v < lo || v > hi) {
        problems.push(`${c.id}.${key}=${v} outside [${lo}, ${hi}]`);
      }
    }
  }
  return problems;
}
