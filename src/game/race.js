// RaceDirector is the backward-compatible single-player adapter around the
// generic RaceSimulation. Existing browser and headless callers keep using:
//
//   new RaceDirector(track, options)
//   director.update(dt, playerControls)

// while multiplayer/server code can import RaceSimulation directly.

import { RACE } from '../core/constants.js';
import { deriveRng } from '../core/rng.js';
import {
  defaultLoadoutForCharacter,
  pickDistinctAppearance,
} from './appearance.js';
import { PLAYABLE_CHARACTERS, getPlayableCharacter } from './characters.js';
import { RaceSimulation, CONTROLLER_KIND } from './race-simulation.js';

function randomAiAppearance(characterId, seed, slot, usedByCharacter) {
  const appearanceRng = deriveRng(seed, `local-appearance:${slot}:${characterId}`);
  const used = usedByCharacter.get(characterId) || [];
  const appearance = pickDistinctAppearance(appearanceRng, used);
  used.push(appearance);
  usedByCharacter.set(characterId, used);
  return appearance;
}

function aiDisplayName(label, number) {
  return `${String(label || 'AI player').trim() || 'AI player'} ${number}`;
}

function makeSinglePlayerRoster(playerCharacterId, seed, autopilot, aiPlayerLabel) {
  const playerCharacter = getPlayableCharacter(playerCharacterId);
  const playerLoadout = defaultLoadoutForCharacter(playerCharacter.id);
  const usedAppearances = new Map([
    [playerCharacter.id, [{
      paintId: playerLoadout.paintId,
      avatarId: playerLoadout.avatarId,
    }]],
  ]);
  const aiCharacters = [];
  let cycle = 0;
  while (aiCharacters.length < RACE.totalKarts - 1) {
    const pool = PLAYABLE_CHARACTERS
      .filter((character) => cycle > 0 || character.id !== playerCharacter.id)
      .slice();
    deriveRng(seed, `local-roster-cycle:${cycle}`).shuffle(pool);
    for (const character of pool) {
      if (aiCharacters.length >= RACE.totalKarts - 1) break;
      aiCharacters.push(character);
    }
    cycle += 1;
  }

  const roster = aiCharacters.map((character, index) => ({
    participantId: `ai:${index}:${character.id}`,
    displayName: aiDisplayName(aiPlayerLabel, index + 1),
    aiPlayerNumber: index + 1,
    characterId: character.id,
    ...randomAiAppearance(character.id, seed, index, usedAppearances),
    controllerKind: CONTROLLER_KIND.AI,
  }));

  // The classic local player starts in the final grid slot. Autopilot uses the
  // pre-created AI driver but remains ineligible for rubber-band pacing.
  roster.push({
    participantId: 'local-player',
    displayName: playerCharacter.name,
    characterId: playerCharacter.id,
    ...playerLoadout,
    controllerKind: autopilot ? CONTROLLER_KIND.AI : CONTROLLER_KIND.HUMAN,
    rubberBandEligible: false,
    aiBaseSpeedEligible: false,
    isPlayer: true,
  });
  return roster;
}

export class RaceDirector extends RaceSimulation {
  /**
   * @param {import('../track/track.js').Track} track
   * @param {object} [opts]
   * @param {string} [opts.playerCharacterId]
   * @param {string|object} [opts.difficulty]
   * @param {number} [opts.laps]
   * @param {number|string} [opts.seed]
   * @param {boolean} [opts.autopilot]
   * @param {string} [opts.aiPlayerLabel]
   */
  constructor(track, {
    playerCharacterId,
    difficulty = 'normal',
    laps = track.laps,
    seed = 12345,
    autopilot = false,
    aiPlayerLabel = 'AI player',
  } = {}) {
    const roster = makeSinglePlayerRoster(
      playerCharacterId, seed, autopilot, aiPlayerLabel,
    );
    super(track, { roster, difficulty, laps, seed, mode: 'local' });

    this.autopilot = autopilot;
    this._playerCharacter = getPlayableCharacter(playerCharacterId);
    this._player = this.karts[RACE.totalKarts - 1];
    this._singlePlayerControls = new Array(RACE.totalKarts).fill(null);
  }

  get player() { return this._player; }

  setAiPlayerLabel(label) {
    for (let index = 0; index < this._roster.length; index++) {
      const entry = this._roster[index];
      if (!Number.isInteger(entry.aiPlayerNumber) || entry.aiPlayerNumber < 1) continue;
      const displayName = aiDisplayName(label, entry.aiPlayerNumber);
      entry.displayName = displayName;
      this._karts[index].displayName = displayName;
      this._karts[index].name = displayName;
    }
  }

  /** Preserve the legacy one-controls-object update contract. */
  update(dt, playerControls = null) {
    this._singlePlayerControls[this._player.index] = playerControls;
    return super.update(dt, this._singlePlayerControls);
  }

  /** Local AI continue to pace against the local player, including autopilot. */
  _getRubberBandTargetProgress() {
    return this._player ? this._player.progress : null;
  }
}

export {
  RaceSimulation,
  CONTROLLER_KIND,
  shuffleRosterForGrid,
} from './race-simulation.js';
