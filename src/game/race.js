// RaceDirector is the backward-compatible single-player adapter around the
// generic RaceSimulation. Existing browser and headless callers keep using:
//
//   new RaceDirector(track, options)
//   director.update(dt, playerControls)

// while multiplayer/server code can import RaceSimulation directly.

import { RACE } from '../core/constants.js';
import { deriveRng } from '../core/rng.js';
import {
  AVATARS,
  PAINT_THEMES,
  defaultLoadoutForCharacter,
} from './appearance.js';
import { CHARACTERS, getCharacter } from './characters.js';
import { RaceSimulation, CONTROLLER_KIND } from './race-simulation.js';

function randomAiAppearance(characterId, seed) {
  const appearanceRng = deriveRng(seed, `local-appearance:${characterId}`);
  return {
    paintId: appearanceRng.pick(PAINT_THEMES)?.id,
    avatarId: appearanceRng.pick(AVATARS)?.id,
  };
}

function makeSinglePlayerRoster(playerCharacterId, seed, autopilot) {
  const playerCharacter = getCharacter(playerCharacterId);
  const rosterRng = deriveRng(seed, 'roster-grid');
  const aiCharacters = CHARACTERS.filter((character) => character.id !== playerCharacter.id);
  rosterRng.shuffle(aiCharacters);

  const roster = aiCharacters.slice(0, RACE.totalKarts - 1).map((character) => ({
    participantId: `ai:${character.id}`,
    displayName: character.name,
    characterId: character.id,
    ...randomAiAppearance(character.id, seed),
    controllerKind: CONTROLLER_KIND.AI,
  }));

  // The classic local player starts in the final grid slot. Autopilot uses the
  // pre-created AI driver but remains ineligible for rubber-band pacing.
  roster.push({
    participantId: 'local-player',
    displayName: playerCharacter.name,
    characterId: playerCharacter.id,
    ...defaultLoadoutForCharacter(playerCharacter.id),
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
   */
  constructor(track, {
    playerCharacterId,
    difficulty = 'normal',
    laps = track.laps,
    seed = 12345,
    autopilot = false,
  } = {}) {
    const roster = makeSinglePlayerRoster(playerCharacterId, seed, autopilot);
    super(track, { roster, difficulty, laps, seed, mode: 'local' });

    this.autopilot = autopilot;
    this._playerCharacter = getCharacter(playerCharacterId);
    this._player = this.karts[RACE.totalKarts - 1];
    this._singlePlayerControls = new Array(RACE.totalKarts).fill(null);
  }

  get player() { return this._player; }

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
