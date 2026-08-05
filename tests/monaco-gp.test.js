import test from 'node:test';
import assert from 'node:assert/strict';

import { FIXED_DT, RACE, RACE_STATE } from '../src/core/constants.js';
import { RaceDirector } from '../src/game/race.js';
import { Track } from '../src/track/track.js';
import { TRACKS, getTrackDef } from '../src/track/tracks.js';
import { resolveRaceBgm } from '../src/audio/bgm.js';

test('Monaco Grand Prix is registered as the 5th track in TRACKS roster', () => {
  assert.equal(TRACKS[4].id, 'monaco-gp');
  assert.equal(TRACKS[4].name, 'Monaco Grand Prix');
  assert.equal(TRACKS[4].theme.scenery, 'monaco');
});

test('Monaco Grand Prix exposes authored tunnel structure and pickup layout', () => {
  const trackDef = getTrackDef('monaco-gp');
  assert.equal(trackDef.id, 'monaco-gp');
  const track = new Track(trackDef);
  assert.ok(track.length > 800, `length=${track.length.toFixed(2)}`);
  assert.equal(track.structures.length, 2);
  assert.equal(track.structures[0].kind, 'tunnel');
  assert.equal(track.structures[1].kind, 'tunnel');
  assert.equal(track.boostPads.length, 4);
  assert.equal(track.itemBoxes.length, 30);
});

test('Monaco Grand Prix defaults to harbor-loop race music (rainbow-kart-parade)', () => {
  const bgm = resolveRaceBgm('default', 'monaco-gp');
  assert.equal(bgm.id, 'rainbow-kart-parade');
  assert.equal(bgm.id, resolveRaceBgm('default', 'harbor-loop').id);
});

const MAX_SIM_SECONDS = 8 * 60;

function runMonacoRace(difficulty) {
  const race = new RaceDirector(new Track(getTrackDef('monaco-gp')), {
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
  test(`Monaco Grand Prix ${difficulty} AI field completes the F1 street circuit`, {
    timeout: 20_000,
  }, () => {
    const race = runMonacoRace(difficulty);
    assert.equal(race.state, RACE_STATE.RESULTS);
    assert.equal(race.karts.length, RACE.totalKarts);
    assert.ok(race.elapsed > 60 && race.elapsed < 360,
      `elapsed=${race.elapsed.toFixed(2)}`);
    for (const kart of race.karts) {
      assert.ok(kart.finished, `${kart.name} did not finish`);
      assert.ok(kart.lapTimes.length >= 1, `${kart.name} lapTimes=${kart.lapTimes.length}`);
    }
  });
}
