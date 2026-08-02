import test from 'node:test';
import assert from 'node:assert/strict';

import { FIXED_DT, RACE_STATE } from '../src/core/constants.js';
import { CHARACTERS } from '../src/game/characters.js';
import {
  RaceSimulation,
  CONTROLLER_KIND,
  shuffleRosterForGrid,
} from '../src/game/race-simulation.js';
import { Track } from '../src/track/track.js';
import { getTrackDef } from '../src/track/tracks.js';

function makeRoster(kinds = []) {
  return CHARACTERS.map((character, index) => ({
    participantId: `participant-${index}`,
    displayName: `Racer ${index}`,
    characterId: character.id,
    controllerKind: kinds[index] || CONTROLLER_KIND.AI,
  }));
}

function makeSimulation({ kinds, seed = 123, mode = 'local', difficulty = 'normal' } = {}) {
  return new RaceSimulation(new Track(getTrackDef('sunset-circuit')), {
    roster: makeRoster(kinds),
    seed,
    mode,
    difficulty,
  });
}

test('seeded grid helper is deterministic and simulation preserves announced kart indices', () => {
  const source = makeRoster();
  const orderedA = shuffleRosterForGrid(source, 771);
  const orderedB = shuffleRosterForGrid(source, 771);
  const orderedC = shuffleRosterForGrid(source, 772);
  const orderA = orderedA.map((entry) => entry.participantId);
  const orderB = orderedB.map((entry) => entry.participantId);
  const orderC = orderedC.map((entry) => entry.participantId);
  assert.deepEqual(orderA, orderB);
  assert.notDeepEqual(orderA, orderC);

  const a = new RaceSimulation(new Track(getTrackDef('sunset-circuit')), {
    roster: orderedA,
    seed: 771,
    mode: 'online',
  });

  for (let i = 0; i < a.karts.length; i++) {
    assert.equal(a.roster[i].participantId, orderedA[i].participantId);
    assert.equal(a.karts[i].participantId, a.roster[i].participantId);
    assert.equal(a.karts[i].displayName, a.roster[i].displayName);
    assert.equal(a.getKartIndexByParticipantId(a.roster[i].participantId), i);
  }
});

test('authoritative simulation supports dynamic rosters from two to eight karts', () => {
  const track = new Track(getTrackDef('sunset-circuit'));
  const twoKartRoster = makeRoster([
    CONTROLLER_KIND.HUMAN,
    CONTROLLER_KIND.HUMAN,
  ]).slice(0, 2);
  const simulation = new RaceSimulation(track, {
    roster: twoKartRoster,
    seed: 772,
    mode: 'online',
  });

  assert.equal(simulation.roster.length, 2);
  assert.equal(simulation.karts.length, 2);
  assert.deepEqual(simulation.karts.map((kart) => kart.rank), [1, 2]);
  simulation.update(FIXED_DT, [
    { throttle: 1, brake: 0, steer: 0, drift: false, useItem: false, lookBack: false },
    { throttle: 1, brake: 0, steer: 0, drift: false, useItem: false, lookBack: false },
  ]);
  assert.equal(simulation.state, RACE_STATE.COUNTDOWN);
});

test('human controls are isolated by kart index and missing input resets only that seat', () => {
  const simulation = makeSimulation({
    kinds: [CONTROLLER_KIND.HUMAN, CONTROLLER_KIND.HUMAN],
  });

  simulation.update(FIXED_DT, {
    0: { throttle: 2, brake: -1, steer: -2, drift: true, useItem: true },
    1: { throttle: 0.25, brake: 0.5, steer: 0.75, lookBack: true },
  });

  assert.deepEqual(simulation.karts[0].controls, {
    throttle: 1,
    brake: 0,
    steer: -1,
    drift: true,
    useItem: true,
    lookBack: false,
  });
  assert.deepEqual(simulation.karts[1].controls, {
    throttle: 0.25,
    brake: 0.5,
    steer: 0.75,
    drift: false,
    useItem: false,
    lookBack: true,
  });

  simulation.update(FIXED_DT, { 0: { throttle: 0.8 } });
  assert.equal(simulation.karts[0].controls.throttle, 0.8);
  assert.deepEqual(simulation.karts[1].controls, {
    throttle: 0,
    brake: 0,
    steer: 0,
    drift: false,
    useItem: false,
    lookBack: false,
  });
});

test('controller ownership switches without replacing the pre-created AI driver', () => {
  const simulation = makeSimulation({ kinds: [CONTROLLER_KIND.HUMAN] });
  const driver = simulation._drivers[0];
  simulation.karts[0].controls.throttle = 1;

  simulation.setController(0, CONTROLLER_KIND.TAKEOVER_AI);
  assert.equal(simulation.getController(0), CONTROLLER_KIND.TAKEOVER_AI);
  assert.equal(simulation.karts[0].controllerKind, CONTROLLER_KIND.TAKEOVER_AI);
  assert.equal(simulation._drivers[0], driver);
  assert.equal(simulation._rubberBandEligible[0], false);
  assert.equal(simulation.karts[0].controls.throttle, 0);

  simulation.setController(0, CONTROLLER_KIND.HUMAN);
  assert.equal(simulation.getController(0), CONTROLLER_KIND.HUMAN);
  assert.equal(simulation._drivers[0], driver);
});

test('online AI pacing reference is the median progress of current human seats', () => {
  const simulation = makeSimulation({
    kinds: [CONTROLLER_KIND.HUMAN, CONTROLLER_KIND.HUMAN, CONTROLLER_KIND.HUMAN],
  });
  simulation.karts[0].progress = 10;
  simulation.karts[1].progress = 80;
  simulation.karts[2].progress = 30;

  // Presentation ownership must not influence simulation pacing.
  simulation.karts[0].isPlayer = false;
  simulation.karts[5].isPlayer = true;
  assert.equal(simulation.rubberBandTargetProgress, 30);

  simulation.setController(2, CONTROLLER_KIND.TAKEOVER_AI);
  assert.equal(simulation.rubberBandTargetProgress, 45);
});

test('regular AI uses the human median while takeover AI receives no rubber-band bonus', () => {
  const simulation = makeSimulation({
    kinds: [CONTROLLER_KIND.HUMAN, CONTROLLER_KIND.TAKEOVER_AI],
  });
  simulation.karts[0].progress = 120;
  simulation.karts[1].progress = -120;
  simulation.karts[2].progress = -120;
  simulation.karts[2].isPlayer = true;
  simulation.state = RACE_STATE.RACING;
  simulation._syncWorld();

  simulation._drivers[1]._rubberTimer = 0;
  simulation._drivers[2]._rubberTimer = 0;
  simulation._drivers[1]._updateRubberBand(FIXED_DT, simulation._world);
  simulation._drivers[2]._updateRubberBand(FIXED_DT, simulation._world);

  assert.equal(simulation.karts[1].aiSpeedMul, simulation.difficulty.aiSpeed);
  assert.ok(simulation.karts[2].aiSpeedMul > 1);
});

test('AI activity cannot consume item or another kart AI random streams', () => {
  const a = makeSimulation({ kinds: [CONTROLLER_KIND.HUMAN], seed: 9876 });
  const b = makeSimulation({ kinds: [CONTROLLER_KIND.HUMAN], seed: 9876 });
  a.setController(0, CONTROLLER_KIND.TAKEOVER_AI);
  a.state = RACE_STATE.RACING;
  a._syncWorld();

  for (let i = 0; i < 20; i++) {
    a._drivers[0]._updateMistakes(1);
  }

  assert.equal(a.itemRng.float(), b.itemRng.float(), 'AI consumed the item RNG stream');
  assert.equal(a._aiRngs[4].float(), b._aiRngs[4].float(), 'one AI consumed another AI stream');
});

test('authoritative race state remains racing after one finisher and only ends globally', () => {
  const simulation = makeSimulation();
  simulation.state = RACE_STATE.RACING;
  simulation.elapsed = 42;

  simulation._finishKart(simulation.karts[0], false);
  simulation._updateStateMachine();
  assert.equal(simulation.state, RACE_STATE.RACING);

  for (let i = 1; i < simulation.karts.length; i++) {
    simulation._finishKart(simulation.karts[i], false);
  }
  simulation._updateStateMachine();
  assert.equal(simulation.state, RACE_STATE.RESULTS);
});

test('a finished kart releases controls and coasts to a stop', () => {
  const simulation = makeSimulation({ kinds: CHARACTERS.map(() => CONTROLLER_KIND.HUMAN) });
  const kart = simulation.karts[0];
  simulation.state = RACE_STATE.RACING;
  kart.speed = 20;
  kart.boostTimer = 2;
  kart.boostPower = 1.5;
  kart.speedMul = 1.5;
  kart.controls.throttle = 1;
  kart.controls.steer = 1;
  simulation._finishKart(kart, false);

  assert.equal(kart.boostTimer, 0);
  assert.equal(kart.controls.throttle, 0);
  assert.equal(kart.controls.steer, 0);
  for (let i = 0; i < 120; i++) simulation.update(FIXED_DT, []);
  assert.ok(kart.speed > 0 && kart.speed < 20);
  for (let i = 0; i < 240; i++) simulation.update(FIXED_DT, []);
  assert.equal(kart.speed, 0);
});

test('roster validation allows duplicate racers but rejects duplicate participants', () => {
  const track = new Track(getTrackDef('sunset-circuit'));
  assert.throws(() => new RaceSimulation(track, { roster: makeRoster().slice(0, 1) }), /2 to 8/);
  assert.throws(() => new RaceSimulation(track, {
    roster: [...makeRoster(), { ...makeRoster()[0], participantId: 'participant-extra' }],
  }), /2 to 8/);

  const duplicateCharacter = makeRoster();
  duplicateCharacter[1].characterId = duplicateCharacter[0].characterId;
  const duplicateRacerSimulation = new RaceSimulation(track, { roster: duplicateCharacter });
  assert.equal(duplicateRacerSimulation.karts[0].character.id, duplicateRacerSimulation.karts[1].character.id);

  const duplicateParticipant = makeRoster();
  duplicateParticipant[1].participantId = duplicateParticipant[0].participantId;
  assert.throws(() => new RaceSimulation(track, { roster: duplicateParticipant }), /duplicate participantId/);

  const simulation = makeSimulation();
  assert.throws(() => simulation.setController(8, CONTROLLER_KIND.AI), /invalid kart index/);
  assert.throws(() => simulation.setController(0, 'remote'), /invalid controllerKind/);
});
