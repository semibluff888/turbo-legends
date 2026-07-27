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
 * @property {'light'|'medium'|'heavy'} weightClass
 * @property {number} color primary body colour
 * @property {number} accentColor trim / helmet colour
 * @property {{speed:number, accel:number, handling:number, weight:number}} stats
 */

/** @type {Character[]} */
export const CHARACTERS = [
  {
    id: 'pip',
    name: 'Pip',
    blurb: 'Tiny, fearless, corners like a hovercraft.',
    weightClass: 'light',
    color: 0x36d6a0,
    accentColor: 0xfff3b0,
    stats: { speed: 0.94, accel: 1.16, handling: 1.15, weight: 0.82 },
  },
  {
    id: 'nova',
    name: 'Nova',
    blurb: 'Rocket engineer. Launches out of every corner.',
    weightClass: 'light',
    color: 0xff5fa2,
    accentColor: 0x2b1b4a,
    stats: { speed: 0.97, accel: 1.12, handling: 1.10, weight: 0.88 },
  },
  {
    id: 'kit',
    name: 'Kit',
    blurb: 'Street racer. No weaknesses, no excuses.',
    weightClass: 'medium',
    color: 0x4aa8ff,
    accentColor: 0xffffff,
    stats: { speed: 1.00, accel: 1.00, handling: 1.02, weight: 1.00 },
  },
  {
    id: 'roscoe',
    name: 'Roscoe',
    blurb: 'Retired stunt driver. Still owns the drift record.',
    weightClass: 'medium',
    color: 0xffb340,
    accentColor: 0x5a2d0c,
    stats: { speed: 1.02, accel: 0.98, handling: 1.06, weight: 1.05 },
  },
  {
    id: 'mirage',
    name: 'Mirage',
    blurb: 'Desert drifter. Reads a corner three turns early.',
    weightClass: 'medium',
    color: 0xb47cff,
    accentColor: 0x241040,
    stats: { speed: 1.04, accel: 0.96, handling: 1.00, weight: 1.02 },
  },
  {
    id: 'brick',
    name: 'Brick',
    blurb: 'Demolition specialist. Considers contact a strategy.',
    weightClass: 'heavy',
    color: 0xe8442e,
    accentColor: 0x2a2a2a,
    stats: { speed: 1.06, accel: 0.90, handling: 0.92, weight: 1.24 },
  },
  {
    id: 'tundra',
    name: 'Tundra',
    blurb: 'Ice hauler. Unstoppable once she is rolling.',
    weightClass: 'heavy',
    color: 0x7fe3ff,
    accentColor: 0x0d3c56,
    stats: { speed: 1.08, accel: 0.88, handling: 0.90, weight: 1.28 },
  },
  {
    id: 'gearbox',
    name: 'Gearbox',
    blurb: 'Built himself. Mostly out of spare engines.',
    weightClass: 'heavy',
    color: 0x9aa4b0,
    accentColor: 0xffcc33,
    stats: { speed: 1.09, accel: 0.86, handling: 0.88, weight: 1.30 },
  },
];

export const CHARACTERS_BY_ID = Object.fromEntries(CHARACTERS.map((c) => [c.id, c]));

export function getCharacter(id) {
  return CHARACTERS_BY_ID[id] || CHARACTERS[2];
}

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
    for (const [key, [lo, hi]] of Object.entries(CHARACTER_STAT_RANGE)) {
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
