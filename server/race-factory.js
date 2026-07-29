import { Track } from '../src/track/track.js';

let raceSimulationModulePromise = null;

async function loadRaceSimulation() {
  raceSimulationModulePromise ??= import('../src/game/race-simulation.js');
  const module = await raceSimulationModulePromise;
  const RaceSimulation = module.RaceSimulation ?? module.default;
  if (typeof RaceSimulation !== 'function') {
    throw new TypeError('src/game/race-simulation.js must export RaceSimulation.');
  }
  return RaceSimulation;
}

/**
 * Build the production authoritative-race factory used by RoomManager.
 * The dynamic import keeps the static file server independently importable,
 * even while the multiplayer simulation refactor is developed in parallel.
 */
export function createDefaultRaceFactory() {
  return async ({ trackDef, difficulty, laps, seed, roster }) => {
    const RaceSimulation = await loadRaceSimulation();
    const track = new Track(trackDef);
    return new RaceSimulation(track, {
      roster,
      difficulty,
      laps,
      seed,
      mode: 'online',
    });
  };
}
