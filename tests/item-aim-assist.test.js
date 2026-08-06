import test from 'node:test';
import assert from 'node:assert/strict';

import { ITEM, ITEM_PHYSICS, RACE_STATE } from '../src/core/constants.js';
import { Kart } from '../src/game/kart.js';
import { findRedShellTarget, predictBombTrajectory } from '../src/game/items.js';
import {
  buildStraightAimGuide,
  deriveItemAimState,
  selectIncomingThreat,
} from '../src/ui/item-aim-assist.js';
import { Track } from '../src/track/track.js';

const CHARACTER = {
  id: 'test', name: 'Test', color: 0xffffff,
  stats: { speed: 1, accel: 1, handling: 1, weight: 1 },
};

function trackDef() {
  const points = [];
  for (let index = 0; index < 16; index++) {
    const angle = index / 16 * Math.PI * 2;
    points.push({ x: Math.sin(angle) * 40, z: Math.cos(angle) * 40 });
  }
  return { id: 'aim-test', name: 'Aim Test', width: 20, laps: 3, spacing: 1, points };
}

function place(kart, track, s, lateral = 0) {
  const world = track.toWorld(s, lateral, {});
  kart.x = world.x;
  kart.y = world.y;
  kart.z = world.z;
  kart.yaw = world.heading;
  kart.s = s;
  kart.progress = s;
  kart.lateral = lateral;
}

function fixture() {
  const track = new Track(trackDef());
  const karts = Array.from({ length: 3 }, (_, index) => new Kart({ index, character: CHARACTER }));
  place(karts[0], track, 0);
  place(karts[1], track, 25);
  place(karts[2], track, 70);
  karts[0].isPlayer = true;
  karts[0].rank = 3;
  karts[1].rank = 2;
  karts[2].rank = 1;
  const race = {
    state: RACE_STATE.RACING,
    track,
    karts,
    items: { projectiles: [], hazards: [] },
  };
  return { track, karts, race, player: karts[0] };
}

test('red shell targeting and HUD candidate use the nearest eligible kart ahead', () => {
  const { karts, race, player } = fixture();
  player.giveItem(ITEM.RED_SHELL);
  assert.equal(findRedShellTarget(player, karts), karts[1]);
  const state = deriveItemAimState(player, race);
  assert.equal(state.mode, 'target');
  assert.equal(state.phase, 'candidate');
  assert.equal(state.targetIndex, karts[1].index);

  karts[1].finished = true;
  assert.equal(findRedShellTarget(player, karts), karts[2]);
  karts[2].progress = ITEM_PHYSICS.redShellLockRange + 1;
  assert.equal(deriveItemAimState(player, race).status, 'noTarget');
});

test('authoritative red projectile confirmation overrides the held-item preview', () => {
  const { karts, race, player } = fixture();
  player.giveItem(ITEM.GREEN_SHELL);
  race.items.projectiles.push({
    id: 9, kind: ITEM.RED_SHELL, ownerIndex: player.index,
    targetIndex: karts[2].index, straight: false, age: 0.2,
    x: player.x, y: player.y, z: player.z, vx: 10, vz: 0,
  });
  const state = deriveItemAimState(player, race);
  assert.equal(state.mode, 'target');
  assert.equal(state.phase, 'confirmed');
  assert.equal(state.targetIndex, karts[2].index);
});

test('green and rear-fired red shells produce directional straight guides', () => {
  const { track, race, player } = fixture();
  player.giveItem(ITEM.GREEN_SHELL);
  const forward = deriveItemAimState(player, race, { lookBack: false });
  const backward = deriveItemAimState(player, race, { lookBack: true });
  assert.equal(forward.mode, 'straight');
  assert.equal(backward.mode, 'straight');
  const forwardDelta = (forward.points.at(-1).x - player.x) * player.forwardX
    + (forward.points.at(-1).z - player.z) * player.forwardZ;
  const backwardDelta = (backward.points.at(-1).x - player.x) * player.forwardX
    + (backward.points.at(-1).z - player.z) * player.forwardZ;
  assert.ok(forwardDelta > 14);
  assert.ok(backwardDelta < -14);

  player.giveItem(ITEM.RED_SHELL);
  const rearRed = deriveItemAimState(player, race, { lookBack: true });
  assert.equal(rearRed.mode, 'straight');
  assert.equal(rearRed.item, ITEM.RED_SHELL);
  assert.equal(buildStraightAimGuide(player, track).length, 6);
});

test('bomb preview shares launch physics and distinguishes lob from rear placement', () => {
  const { track, race, player } = fixture();
  player.speed = 18;
  player.giveItem(ITEM.BOMB);
  const lob = predictBombTrajectory(player, track);
  assert.equal(lob.mode, 'lob');
  assert.ok(lob.points.length >= 3);
  assert.ok(Number.isFinite(lob.impact.x));
  assert.ok(Number.isFinite(lob.impact.y));
  assert.equal(deriveItemAimState(player, race).mode, 'lob');

  const plant = predictBombTrajectory(player, track, { back: true });
  assert.equal(plant.mode, 'plant');
  const behind = (plant.impact.x - player.x) * player.forwardX
    + (plant.impact.z - player.z) * player.forwardZ;
  assert.ok(behind < 0);
  assert.equal(deriveItemAimState(player, race, { lookBack: true }).mode, 'plant');
});

test('incoming threat selection chooses the shortest ETA and suppresses invulnerable warnings', () => {
  const { player } = fixture();
  const projectiles = [
    { id: 1, kind: ITEM.RED_SHELL, targetIndex: player.index, x: player.x + 64, z: player.z, vx: -32, vz: 0 },
    { id: 2, kind: ITEM.BLUE_SHELL, targetIndex: player.index, x: player.x + 20, z: player.z, vx: -46, vz: 0 },
  ];
  const threat = selectIncomingThreat(player, projectiles);
  assert.equal(threat.projectile.id, 2);
  assert.equal(threat.severity, 'critical');
  player.starTimer = 1;
  assert.equal(selectIncomingThreat(player, projectiles), null);
});

test('blue shell preview names the leader and warns when the holder is first', () => {
  const { karts, race, player } = fixture();
  player.giveItem(ITEM.BLUE_SHELL);
  let state = deriveItemAimState(player, race);
  assert.equal(state.mode, 'target');
  assert.equal(state.phase, 'leader');
  assert.equal(state.targetIndex, karts[2].index);

  player.rank = 1;
  karts[2].rank = 2;
  state = deriveItemAimState(player, race);
  assert.equal(state.mode, 'status');
  assert.equal(state.status, 'selfTarget');
});
