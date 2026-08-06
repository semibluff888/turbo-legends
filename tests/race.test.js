// Full headless race through RaceDirector: 8 karts, every one AI-driven
// (autopilot gives the player kart an AiDriver too). This is the integration
// test for the whole simulation stack — physics, AI, items, laps, ranking.

import test from 'node:test';
import assert from 'node:assert/strict';

import { FIXED_DT, RACE, RACE_STATE } from '../src/core/constants.js';
import { AVATARS_BY_ID, PAINT_THEMES_BY_ID } from '../src/game/appearance.js';
import { Track } from '../src/track/track.js';
import { getTrackDef } from '../src/track/tracks.js';
import { RaceDirector } from '../src/game/race.js';

const SEED = 42;
const TRACK_ID = 'sunset-circuit';
const MAX_SIM_SECONDS = 6 * 60;

/** Run one full race headlessly. Returns the director plus step statistics. */
function runRace(seed = SEED) {
  const track = new Track(getTrackDef(TRACK_ID));
  const race = new RaceDirector(track, {
    playerCharacterId: 'kit',
    difficulty: 'normal',
    seed,
    autopilot: true,
  });
  const maxSteps = Math.ceil((MAX_SIM_SECONDS + RACE.countdownDuration) / FIXED_DT);
  let steps = 0;
  while (!race.isRaceOver && steps < maxSteps) {
    race.update(FIXED_DT, null);
    // Events accumulate forever unless the frame loop clears them; do it here
    // so a 6-minute race doesn't build million-entry arrays.
    for (const kart of race.karts) kart.clearEvents();
    steps++;
  }
  return { race, steps, simSeconds: steps * FIXED_DT };
}

// One shared race for the state assertions, a second for determinism.
const runA = runRace();
const runB = runRace();

test('race completes: RESULTS state within the time limit', () => {
  const { race, simSeconds } = runA;
  assert.equal(race.state, RACE_STATE.RESULTS, `state=${race.state} after ${simSeconds.toFixed(1)}s`);
  assert.ok(race.isRaceOver);
  assert.ok(race.elapsed > 0 && race.elapsed <= MAX_SIM_SECONDS,
    `elapsed=${race.elapsed.toFixed(2)}s`);
});

test('every kart finished with the full lap count', () => {
  const { race } = runA;
  assert.equal(race.karts.length, RACE.totalKarts);
  for (const kart of race.karts) {
    assert.ok(kart.finished, `${kart.name} did not finish`);
    assert.equal(kart.lap, race.laps, `${kart.name} lap=${kart.lap}`);
    assert.equal(kart.lapTimes.length, race.laps,
      `${kart.name} recorded ${kart.lapTimes.length} lap times`);
    assert.ok(kart.finishTime > 0, `${kart.name} finishTime=${kart.finishTime}`);
  }
});

test('ranks are a permutation of 1..8 and match the standings order', () => {
  const { race } = runA;
  const ranks = race.karts.map((k) => k.rank).sort((a, b) => a - b);
  assert.deepEqual(ranks, [1, 2, 3, 4, 5, 6, 7, 8]);

  const standings = race.standings;
  assert.equal(standings.length, RACE.totalKarts);
  for (let i = 0; i < standings.length; i++) {
    assert.equal(standings[i].rank, i + 1, `standings[${i}] has rank ${standings[i].rank}`);
  }
  // Finish times must be non-decreasing down the standings.
  for (let i = 1; i < standings.length; i++) {
    assert.ok(standings[i].finishTime >= standings[i - 1].finishTime - 1e-9,
      `finishTime order broken at rank ${i + 1}`);
  }
});

test('lap times are sane (each > 15s, best <= all)', () => {
  const { race } = runA;
  for (const kart of race.karts) {
    for (const [i, t] of kart.lapTimes.entries()) {
      assert.ok(t > 15, `${kart.name} lap ${i + 1} = ${t.toFixed(2)}s`);
    }
    assert.ok(Number.isFinite(kart.bestLap));
    assert.equal(kart.bestLap, Math.min(...kart.lapTimes));
    const sum = kart.lapTimes.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - kart.finishTime) < 1e-6,
      `${kart.name} lap times sum ${sum.toFixed(3)} != finish ${kart.finishTime.toFixed(3)}`);
  }
});

test('same seed twice: identical finish order and times', () => {
  const a = runA.race;
  const b = runB.race;
  const orderA = a.standings.map((k) => k.character.id);
  const orderB = b.standings.map((k) => k.character.id);
  assert.deepEqual(orderA, orderB, 'finish order diverged');
  for (let i = 0; i < a.standings.length; i++) {
    const ka = a.standings[i];
    const kb = b.standings[i];
    assert.ok(Math.abs(ka.finishTime - kb.finishTime) < 1e-9,
      `finishTime diverged at rank ${i + 1}: ${ka.finishTime} vs ${kb.finishTime}`);
    for (let l = 0; l < ka.lapTimes.length; l++) {
      assert.ok(Math.abs(ka.lapTimes[l] - kb.lapTimes[l]) < 1e-9,
        `lap ${l + 1} time diverged at rank ${i + 1}`);
    }
  }
});

test('roster: player uses the Racer default look while AI appearances are seeded random', () => {
  const { race } = runA;
  assert.equal(race.player.character.id, 'kit');
  assert.equal(race.player.index, RACE.totalKarts - 1);
  assert.equal(race.player.paintId, 'turbo-blue');
  assert.equal(race.player.avatarId, 'cat');
  assert.deepEqual(
    race.karts.filter((kart) => !kart.isPlayer).map((kart) => kart.name),
    Array.from({ length: RACE.totalKarts - 1 }, (_, index) => `AI player ${index + 1}`),
  );
  assert.equal(race.player.name, race.player.character.name);
  const ids = new Set(race.karts.map((k) => k.character.id));
  assert.equal(ids.size, 6, 'only the six available Racers should enter the field');
  for (const kart of race.karts.filter((candidate) => !candidate.isPlayer)) {
    assert.ok(PAINT_THEMES_BY_ID[kart.paintId], `${kart.name} has an invalid paint`);
    assert.ok(AVATARS_BY_ID[kart.avatarId], `${kart.name} has an invalid avatar`);
  }
  for (const characterId of ids) {
    const repeated = race.karts.filter((kart) => kart.character.id === characterId);
    const looks = repeated.map((kart) => `${kart.paintId}:${kart.avatarId}`);
    assert.equal(new Set(looks).size, looks.length,
      `${characterId} duplicates should have distinct appearances`);
  }
  assert.deepEqual(
    runA.race.karts.map(({ paintId, avatarId }) => ({ paintId, avatarId })),
    runB.race.karts.map(({ paintId, avatarId }) => ({ paintId, avatarId })),
    'the same race seed should reproduce AI appearances',
  );

  const alternateRace = new RaceDirector(
    new Track(getTrackDef(TRACK_ID)),
    { playerCharacterId: 'kit', difficulty: 'normal', seed: SEED + 1 },
  );
  const aiLooks = (director) => director.karts
    .filter((kart) => !kart.isPlayer)
    .map(({ character, paintId, avatarId }) => ({
      characterId: character.id, paintId, avatarId,
    }))
    .sort((a, b) => a.characterId.localeCompare(b.characterId));
  assert.notDeepEqual(
    aiLooks(alternateRace),
    aiLooks(race),
    'a different race seed should produce a different set of AI appearances',
  );
});

test('reset() rewinds to a countdown grid and replays identically', () => {
  const { race } = runA;
  const firstOrder = race.standings.map((k) => k.character.id);
  const firstTimes = race.standings.map((k) => k.finishTime);

  race.reset();
  assert.equal(race.state, RACE_STATE.COUNTDOWN);
  assert.equal(race.countdown, RACE.countdownDuration);
  assert.equal(race.elapsed, 0);
  for (const kart of race.karts) {
    assert.equal(kart.finished, false);
    assert.equal(kart.lap, 1);
    assert.ok(kart.progress < 0, `${kart.name} progress should start behind the line`);
  }

  const maxSteps = Math.ceil((MAX_SIM_SECONDS + RACE.countdownDuration) / FIXED_DT);
  let steps = 0;
  while (!race.isRaceOver && steps < maxSteps) {
    race.update(FIXED_DT, null);
    for (const kart of race.karts) kart.clearEvents();
    steps++;
  }
  assert.equal(race.state, RACE_STATE.RESULTS, 'reset race did not complete');
  const secondOrder = race.standings.map((k) => k.character.id);
  const secondTimes = race.standings.map((k) => k.finishTime);
  assert.deepEqual(secondOrder, firstOrder, 'reset race finish order diverged');
  for (let i = 0; i < firstTimes.length; i++) {
    assert.ok(Math.abs(firstTimes[i] - secondTimes[i]) < 1e-9,
      `reset race finishTime diverged at rank ${i + 1}`);
  }
});
