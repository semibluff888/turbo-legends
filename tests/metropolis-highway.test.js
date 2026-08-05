import test from 'node:test';
import assert from 'node:assert/strict';

import { FIXED_DT, RACE, RACE_STATE } from '../src/core/constants.js';
import { RaceDirector } from '../src/game/race.js';
import { Track } from '../src/track/track.js';
import { getTrackDef } from '../src/track/tracks.js';

const MAX_SIM_SECONDS = 9 * 60;

function runMetropolisRace(difficulty) {
  const race = new RaceDirector(new Track(getTrackDef('metropolis-highway')), {
    playerCharacterId: 'kit',
    difficulty,
    seed: 42,
    autopilot: true,
  });
  const maxSteps = Math.ceil((MAX_SIM_SECONDS + RACE.countdownDuration) / FIXED_DT);
  let steps = 0;
  while (!race.isRaceOver && steps < maxSteps) {
    race.update(FIXED_DT, null);
    for (const kart of race.karts) kart.clearEvents();
    steps++;
  }
  return race;
}

for (const difficulty of ['normal', 'hard']) {
  test(`Metropolis Highway ${difficulty} AI field completes the technical layout`, {
    timeout: 20_000,
  }, () => {
    const race = runMetropolisRace(difficulty);
    assert.equal(race.state, RACE_STATE.RESULTS);
    assert.equal(race.karts.length, RACE.totalKarts);
    assert.ok(race.elapsed > 100 && race.elapsed < MAX_SIM_SECONDS,
      `elapsed=${race.elapsed.toFixed(2)}`);
    for (const kart of race.karts) {
      assert.ok(kart.finished, `${kart.name} did not finish`);
      assert.equal(kart.lap, race.laps, `${kart.name} lap=${kart.lap}`);
      assert.equal(kart.lapTimes.length, race.laps);
    }
  });
}
