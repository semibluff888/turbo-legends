// ItemSystem contract tests: weight tables, roulette, useItem edge detection,
// shells, bananas, item boxes. Deterministic via seeded Rng. Pure Node.
//
// Notes on fixtures: the ItemSystem edge-detects controls.useItem internally
// (race.js never calls onUseItem), so tests toggle the flag and call update().
// Red-shell targeting reads kart.progress / kart.rank, which race.js normally
// maintains — fixtures set them manually.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FIXED_DT, ITEM, ITEM_INFO, ITEM_WEIGHTS_BY_RANK, ITEM_PHYSICS, ITEM_BOX_RESPAWN,
  KART_STATE, BOOST,
} from '../src/core/constants.js';
import { Track } from '../src/track/track.js';
import { Kart } from '../src/game/kart.js';
import { Rng } from '../src/core/rng.js';
import { ItemSystem } from '../src/game/items.js';
import { pmod } from '../src/core/mathx.js';

const DT = FIXED_DT;

// --- Fixtures ---------------------------------------------------------------

/** Circle track, radius 40, width 20, with a small row of item boxes. */
function circleDef() {
  const R = 40;
  const N = 16;
  const points = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    points.push({ x: R * Math.sin(a), z: R * Math.cos(a) });
  }
  return {
    id: 'items-circle', name: 'Items Circle', width: 20, laps: 3, spacing: 1,
    points,
    itemBoxes: [{ s: 20, lateral: 0 }, { s: 20, lateral: 3 }],
  };
}

const NEUTRAL = {
  id: 'neutral', name: 'Neutral', color: 0xffffff,
  stats: { speed: 1, accel: 1, handling: 1, weight: 1 },
};

/** Fresh world: track + ItemSystem + n stationary karts placed on the line. */
function makeWorld(seed = 1234, kartCount = 2) {
  const track = new Track(circleDef());
  const sys = new ItemSystem(track, new Rng(seed));
  const karts = [];
  for (let i = 0; i < kartCount; i++) {
    const kart = new Kart({ index: i, character: NEUTRAL });
    placeAt(kart, track, 0);
    kart.rank = i + 1;
    karts.push(kart);
  }
  return { track, sys, karts };
}

function placeAt(kart, track, s, lateral = 0) {
  const w = track.toWorld(s, lateral, {});
  kart.x = w.x; kart.y = w.y; kart.z = w.z;
  kart.yaw = w.heading;
  kart.s = pmod(s, track.length);
  kart.lateral = lateral;
  // Ranking fields the item system reads; callers override as needed.
  kart.progress = kart.s;
  return kart;
}

/** Step the item system `seconds` forward from `t0`. Returns the new race time. */
function run(sys, karts, seconds, t0 = 0, each = null) {
  const steps = Math.round(seconds / DT);
  let t = t0;
  for (let i = 0; i < steps; i++) {
    t += DT;
    sys.update(DT, karts, t);
    if (each) each(t, i);
  }
  return t;
}

// --- Weight tables ------------------------------------------------------------

test('ITEM_WEIGHTS_BY_RANK: 5 rows of valid items with positive total weight', () => {
  const validItems = new Set(Object.values(ITEM));
  assert.equal(ITEM_WEIGHTS_BY_RANK.length, 5);
  for (const [r, row] of ITEM_WEIGHTS_BY_RANK.entries()) {
    const entries = Object.entries(row);
    assert.ok(entries.length > 0, `row ${r} is empty`);
    let sum = 0;
    for (const [item, w] of entries) {
      assert.ok(validItems.has(item), `row ${r} has unknown item ${item}`);
      assert.ok(item !== ITEM.NONE, `row ${r} can roll NONE`);
      assert.ok(Number.isFinite(w) && w > 0, `row ${r} weight ${item}=${w}`);
      assert.ok(ITEM_INFO[item], `row ${r} item ${item} lacks ITEM_INFO`);
      sum += w;
    }
    assert.ok(sum > 0, `row ${r} total weight ${sum}`);
  }
  // Rubber-band shape: the leader can never roll the comeback bombs.
  assert.ok(!(ITEM.BULLET in ITEM_WEIGHTS_BY_RANK[0]));
  assert.ok(!(ITEM.BLUE_SHELL in ITEM_WEIGHTS_BY_RANK[0]));
  assert.ok(ITEM.BULLET in ITEM_WEIGHTS_BY_RANK[4]);
});

// --- Roulette ------------------------------------------------------------------

test('roulette runs ~1.1s, cycles faces, and resolves to an item from the rank row', () => {
  const { sys, karts } = makeWorld(99);
  const kart = karts[0];

  sys.startRoulette(kart, 8, 8); // back of the pack -> row 4
  assert.ok(kart.rouletteTimer > 1.0 && kart.rouletteTimer <= 1.2,
    `roulette duration ${kart.rouletteTimer}`);

  const faces = new Set();
  run(sys, karts, 0.6, 0, () => faces.add(kart.rouletteFace));
  assert.equal(kart.item, ITEM.NONE, 'no item while the roulette is spinning');
  assert.ok(kart.rouletteTimer > 0);
  assert.ok(faces.size > 1, 'the spinner visibly cycles faces');

  run(sys, karts, 0.7, 0.6);
  assert.equal(kart.rouletteTimer, 0);
  assert.notEqual(kart.item, ITEM.NONE, 'roulette resolved');
  assert.ok(kart.item in ITEM_WEIGHTS_BY_RANK[4],
    `rank-8 item ${kart.item} must come from the last row`);
  assert.equal(kart.rouletteFace, kart.item, 'HUD face lands on the item won');
  assert.equal(kart.itemUses, ITEM_INFO[kart.item].uses);
  assert.ok(kart.events.some((e) => e.type === 'item_get'));
});

test('roulette is deterministic per seed', () => {
  const results = [1, 2].map(() => {
    const { sys, karts } = makeWorld(555);
    sys.startRoulette(karts[0], 5, 8);
    run(sys, karts, 1.3);
    return karts[0].item;
  });
  assert.notEqual(results[0], ITEM.NONE);
  assert.equal(results[0], results[1], 'same seed must resolve the same item');
});

// --- useItem edge detection -------------------------------------------------------

test('holding useItem consumes exactly one use; a fresh edge consumes the next', () => {
  const { sys, karts } = makeWorld();
  const kart = karts[0];
  kart.giveItem(ITEM.TRIPLE_MUSHROOM);
  assert.equal(kart.itemUses, 3);

  kart.controls.useItem = true;
  run(sys, karts, 0.3); // held down for ~36 steps
  assert.equal(kart.itemUses, 2, 'one rising edge, one use');
  assert.equal(kart.item, ITEM.TRIPLE_MUSHROOM);
  assert.equal(kart.boostSource, 'mushroom');
  assert.equal(kart.boostPower, BOOST.mushroomPower);

  kart.controls.useItem = false;
  run(sys, karts, 0.05, 0.3);
  kart.controls.useItem = true;
  run(sys, karts, 0.05, 0.35);
  assert.equal(kart.itemUses, 1, 'second edge, second use');

  kart.controls.useItem = false;
  run(sys, karts, 0.05, 0.4);
  kart.controls.useItem = true;
  run(sys, karts, 0.05, 0.45);
  assert.equal(kart.itemUses, 0);
  assert.equal(kart.item, ITEM.NONE, 'slot clears when uses run out');
});

test('useItem edge is ignored while spinning out or mid-roulette', () => {
  const { sys, karts } = makeWorld();
  const kart = karts[0];

  kart.giveItem(ITEM.MUSHROOM);
  kart.state = KART_STATE.SPINNING;
  kart.stateTimer = 1;
  kart.controls.useItem = true;
  run(sys, karts, 0.1);
  assert.equal(kart.item, ITEM.MUSHROOM, 'incapacitated karts cannot use items');
  kart.controls.useItem = false;
  kart.state = KART_STATE.NORMAL;
  kart.stateTimer = 0;
  kart.clearItem();

  sys.startRoulette(kart, 1, 8);
  kart.controls.useItem = true;
  run(sys, karts, 0.2, 0.1);
  assert.ok(kart.rouletteTimer > 0, 'roulette still spinning');
  // The press mid-roulette must not fire once the roulette lands either
  // (edge tracking already saw the press).
  run(sys, karts, 1.2, 0.3);
  assert.notEqual(kart.item, ITEM.NONE, 'roulette item still held, not auto-used');
});

// --- Shells ------------------------------------------------------------------------

test('green shell flies straight and spins out the kart it hits', () => {
  const { sys, karts } = makeWorld(7, 2);
  const [shooter, target] = karts;
  // Target parked 12m dead ahead of the shooter in world space.
  target.x = shooter.x + shooter.forwardX * 12;
  target.z = shooter.z + shooter.forwardZ * 12;
  target.progress = shooter.progress + 12;
  shooter.giveItem(ITEM.GREEN_SHELL);

  shooter.controls.useItem = true;
  run(sys, karts, DT);
  assert.equal(sys.projectiles.length, 1);
  const p = sys.projectiles[0];
  assert.equal(p.kind, ITEM.GREEN_SHELL);
  assert.equal(p.ownerIndex, shooter.index);
  assert.ok(Math.abs(Math.hypot(p.vx, p.vz) - ITEM_PHYSICS.shellSpeed) < 1e-6,
    'moving shells expose their real velocity for online presentation');
  assert.equal(shooter.item, ITEM.NONE, 'shell left the slot');

  run(sys, karts, 1.0, DT);
  assert.equal(target.state, KART_STATE.SPINNING, 'shell hit spins the target');
  const ev = target.events.find((e) => e.type === 'spinout');
  assert.equal(ev.cause, ITEM.GREEN_SHELL);
  assert.equal(shooter.state, KART_STATE.NORMAL, 'owner unharmed');
  assert.equal(sys.projectiles.length, 0, 'shell is spent');
  assert.ok(sys.drainVfx().some((v) => v.type === 'shell_break'));
});

test('green shell bounces off the soft wall and stays near the road', () => {
  const { track, sys, karts } = makeWorld(7, 1);
  const kart = karts[0];
  // Fire perpendicular to the track, straight at the outer wall.
  kart.yaw = track.spline.sampleAt(0, {}).heading - Math.PI / 2;
  kart.giveItem(ITEM.GREEN_SHELL);
  kart.controls.useItem = true;
  run(sys, karts, DT);
  assert.equal(sys.projectiles.length, 1);
  // The ricochet comes straight back across the road — move the shooter off
  // the return path (owner immunity only lasts 0.35s, so a parked owner WILL
  // be hit by their own rebound; that is by design).
  placeAt(kart, track, 100);

  const limit = track.baseHalfWidth + 1.0; // SHELL_WALL_MARGIN
  let sawBounce = false;
  run(sys, karts, 2.0, DT, () => {
    const p = sys.projectiles[0];
    if (p && p.bounces > 0) sawBounce = true;
  });
  assert.ok(sawBounce, 'shell bounced at least once');
  assert.equal(sys.projectiles.length, 1, 'bounced shell survives');
  const ws = track.sampleWorld(sys.projectiles[0].x, sys.projectiles[0].z, sys.projectiles[0].s, {});
  assert.ok(Math.abs(ws.lateral) <= limit + 0.5,
    `shell held inside the wall (lateral ${ws.lateral.toFixed(2)})`);
});

test('red shell homes on the next kart ahead by progress and spins them', () => {
  const { track, sys, karts } = makeWorld(11, 3);
  const [shooter, ahead, far] = karts;
  placeAt(shooter, track, 0);
  placeAt(ahead, track, 30);
  placeAt(far, track, 60);
  shooter.rank = 3; shooter.progress = 0;
  ahead.rank = 2; ahead.progress = 30;
  far.rank = 1; far.progress = 60;

  shooter.giveItem(ITEM.RED_SHELL);
  shooter.controls.useItem = true;
  run(sys, karts, DT);
  assert.equal(sys.projectiles.length, 1);
  const p = sys.projectiles[0];
  assert.equal(p.kind, ITEM.RED_SHELL);
  assert.equal(p.targetIndex, ahead.index, 'locked the NEAREST kart ahead, not the leader');

  run(sys, karts, 3.0, DT);
  assert.equal(ahead.state, KART_STATE.SPINNING, 'red shell caught its target');
  const ev = ahead.events.find((e) => e.type === 'spinout');
  assert.equal(ev.cause, ITEM.RED_SHELL);
  assert.equal(far.state, KART_STATE.NORMAL);
  assert.equal(shooter.state, KART_STATE.NORMAL);
  assert.equal(sys.projectiles.length, 0);
});

test('red shell catches a moving target weaving across the full road', () => {
  const { track, sys, karts } = makeWorld(12, 2);
  const [shooter, target] = karts;
  placeAt(shooter, track, 0);
  let targetS = 24;
  placeAt(target, track, targetS);
  shooter.progress = 0;
  target.progress = targetS;
  shooter.rank = 2;
  target.rank = 1;
  shooter.giveItem(ITEM.RED_SHELL);
  shooter.controls.useItem = true;

  let previousX = target.x;
  let previousZ = target.z;
  for (let step = 0; step < Math.round(6 / DT) && target.state === KART_STATE.NORMAL; step++) {
    sys.update(DT, karts, (step + 1) * DT);
    targetS += 17 * DT;
    const lateral = Math.sin(step * DT * 2.6) * (track.baseHalfWidth - 2);
    placeAt(target, track, targetS, lateral);
    target.vx = (target.x - previousX) / DT;
    target.vz = (target.z - previousZ) / DT;
    previousX = target.x;
    previousZ = target.z;
  }
  assert.equal(target.state, KART_STATE.SPINNING,
    'ordinary full-lane weaving cannot shake a locked red shell');
});

test('red shell remains counterable by a dropped banana and star invulnerability', () => {
  {
    const { track, sys, karts } = makeWorld(13, 2);
    const [shooter, defender] = karts;
    placeAt(shooter, track, 0);
    placeAt(defender, track, 24);
    shooter.progress = 0;
    defender.progress = 24;
    shooter.giveItem(ITEM.RED_SHELL);
    defender.giveItem(ITEM.BANANA);
    shooter.controls.useItem = true;
    defender.controls.useItem = true;
    run(sys, karts, 2);
    assert.equal(defender.state, KART_STATE.NORMAL);
    assert.equal(sys.projectiles.length, 0, 'banana absorbs the incoming shell');
    assert.equal(sys.hazards.length, 0, 'the blocking banana is consumed');
  }
  {
    const { track, sys, karts } = makeWorld(14, 2);
    const [shooter, defender] = karts;
    placeAt(shooter, track, 0);
    placeAt(defender, track, 18);
    shooter.progress = 0;
    defender.progress = 18;
    defender.starTimer = 3;
    shooter.giveItem(ITEM.RED_SHELL);
    shooter.controls.useItem = true;
    run(sys, karts, 2);
    assert.equal(defender.state, KART_STATE.NORMAL);
    assert.equal(sys.projectiles.length, 0, 'star kart smashes the shell harmlessly');
  }
});

test('red shell fired with no one ahead just cruises the racing line', () => {
  const { sys, karts } = makeWorld(11, 2);
  const [shooter, behind] = karts;
  shooter.progress = 100;
  behind.progress = 0;
  shooter.rank = 1;
  behind.rank = 2;
  shooter.giveItem(ITEM.RED_SHELL);
  shooter.controls.useItem = true;
  run(sys, karts, 1.0);
  assert.equal(sys.projectiles.length, 1, 'no target, but the shell still flies');
  assert.equal(sys.projectiles[0].targetIndex, -1);
  assert.equal(behind.state, KART_STATE.NORMAL, 'karts behind are never homed on');
});

test('rear-fired red shell stays straight and never acquires a target', () => {
  const { track, sys, karts } = makeWorld(11, 2);
  const [shooter, ahead] = karts;
  placeAt(shooter, track, 0);
  placeAt(ahead, track, 30);
  shooter.progress = 0;
  ahead.progress = 30;
  shooter.controls.lookBack = true;
  shooter.giveItem(ITEM.RED_SHELL);
  shooter.controls.useItem = true;
  run(sys, karts, DT);
  const shell = sys.projectiles[0];
  assert.equal(shell.straight, true);
  assert.equal(shell.targetIndex, -1);
  const dot = shell.vx * shooter.forwardX + shell.vz * shooter.forwardZ;
  assert.ok(dot < 0, 'rear shell velocity points behind the shooter');
});

test('blue shell publishes and updates the current leader targetIndex', () => {
  const { track, sys, karts } = makeWorld(19, 3);
  const [shooter, firstLeader, nextLeader] = karts;
  placeAt(shooter, track, 0);
  placeAt(firstLeader, track, 80);
  placeAt(nextLeader, track, 120);
  shooter.rank = 3;
  firstLeader.rank = 1;
  nextLeader.rank = 2;
  shooter.giveItem(ITEM.BLUE_SHELL);
  shooter.controls.useItem = true;
  run(sys, karts, DT);
  assert.equal(sys.projectiles[0].targetIndex, firstLeader.index);
  assert.ok(Math.abs(Math.hypot(sys.projectiles[0].vx, sys.projectiles[0].vz)
    - ITEM_PHYSICS.blueShellSpeed) < 1e-6);

  firstLeader.rank = 2;
  nextLeader.rank = 1;
  run(sys, karts, DT, DT);
  assert.equal(sys.projectiles[0].targetIndex, nextLeader.index);
});

// --- Bananas -------------------------------------------------------------------------

test('banana drops behind the kart and spins out whoever drives over it', () => {
  const { sys, karts } = makeWorld(3, 2);
  const [owner, victim] = karts;
  owner.giveItem(ITEM.BANANA);
  owner.controls.useItem = true;
  run(sys, karts, DT);

  assert.equal(sys.hazards.length, 1);
  const h = sys.hazards[0];
  assert.equal(h.kind, ITEM.BANANA);
  assert.equal(h.armed, true, 'bananas are live immediately');
  assert.equal(h.ownerIndex, owner.index);
  // Sits trailOffset behind the owner, on the road surface.
  const dx = owner.x - h.x;
  const dz = owner.z - h.z;
  assert.ok(Math.abs(Math.hypot(dx, dz) - ITEM_PHYSICS.trailOffset) < 0.1,
    `banana ${Math.hypot(dx, dz).toFixed(2)}m behind, expected ${ITEM_PHYSICS.trailOffset}`);
  assert.equal(owner.state, KART_STATE.NORMAL, 'owner does not slip on their own drop');

  // Victim parks on top of it.
  victim.x = h.x; victim.z = h.z; victim.y = 0;
  run(sys, karts, DT, DT);
  assert.equal(victim.state, KART_STATE.SPINNING);
  const ev = victim.events.find((e) => e.type === 'spinout');
  assert.equal(ev.cause, 'banana');
  assert.equal(sys.hazards.length, 0, 'banana is spent on the hit');
  assert.ok(sys.drainVfx().some((v) => v.type === 'banana_gone'));
});

test('star karts wipe bananas without spinning out', () => {
  const { sys, karts } = makeWorld(3, 2);
  const [owner, star] = karts;
  owner.giveItem(ITEM.BANANA);
  owner.controls.useItem = true;
  run(sys, karts, DT);
  const h = sys.hazards[0];
  star.starTimer = 5;
  star.x = h.x; star.z = h.z;
  run(sys, karts, DT, DT);
  assert.equal(star.state, KART_STATE.NORMAL);
  assert.equal(sys.hazards.length, 0, 'banana destroyed by the star kart');
});

// --- Item boxes ----------------------------------------------------------------------

test('item box pickup: consume, roulette starts, box respawns after the delay', () => {
  const { track, sys, karts } = makeWorld(21, 2);
  const kart = karts[0];
  const box = track.itemBoxes[0];
  kart.x = box.x; kart.y = box.y - 1.1; kart.z = box.z;
  kart.s = box.s;
  kart.rank = 1;

  let t = run(sys, karts, DT);
  assert.equal(box.active, false, 'box consumed');
  assert.ok(Math.abs(box.respawnAt - (t + ITEM_BOX_RESPAWN)) < 1e-9,
    `respawnAt=${box.respawnAt.toFixed(2)}`);
  assert.ok(kart.rouletteTimer > 0, 'pickup starts the roulette');
  assert.ok(kart.events.some((e) => e.type === 'itembox'));

  // Second kart arriving one step later cannot take the same box.
  const other = karts[1];
  other.x = box.x; other.y = box.y - 1.1; other.z = box.z;
  t = run(sys, karts, DT, t);
  assert.equal(other.rouletteTimer, 0, 'inactive box gives nothing');

  // Move both karts away, run past the respawn delay.
  placeAt(kart, track, 100);
  placeAt(other, track, 100, 3);
  run(sys, karts, ITEM_BOX_RESPAWN + 0.2, t);
  assert.equal(box.active, true, 'box respawned after ITEM_BOX_RESPAWN');
});

test('item boxes cannot be collected from a different overlapping track segment', () => {
  const { track, sys, karts } = makeWorld(21, 2);
  const kart = karts[0];
  const box = track.itemBoxes[0];
  kart.x = box.x;
  kart.y = box.y - 1.1;
  kart.z = box.z;
  kart.s = pmod(box.s + track.length / 2, track.length);

  run(sys, karts, DT);
  assert.equal(box.active, true);
  assert.equal(kart.rouletteTimer, 0);

  kart.s = box.s;
  run(sys, karts, DT, DT);
  assert.equal(box.active, false);
  assert.ok(kart.rouletteTimer > 0);
});

test('a kart already holding an item drives through boxes without consuming them', () => {
  const { track, sys, karts } = makeWorld(21, 1);
  const kart = karts[0];
  const box = track.itemBoxes[0];
  kart.giveItem(ITEM.BANANA);
  kart.x = box.x; kart.y = box.y - 1.1; kart.z = box.z;
  kart.s = box.s;
  run(sys, karts, 0.2);
  assert.equal(box.active, true, 'held item blocks pickup');
  assert.equal(kart.rouletteTimer, 0);
});

// --- Lightning -----------------------------------------------------------------------

test('lightning squashes and shrinks every kart ahead, leader longest', () => {
  const { track, sys, karts } = makeWorld(31, 4);
  const [user, mid, leader, behind] = karts;
  placeAt(user, track, 10); user.progress = 10; user.rank = 3;
  placeAt(mid, track, 50); mid.progress = 50; mid.rank = 2;
  placeAt(leader, track, 90); leader.progress = 90; leader.rank = 1;
  placeAt(behind, track, 0); behind.progress = 0; behind.rank = 4;

  user.giveItem(ITEM.LIGHTNING);
  user.controls.useItem = true;
  run(sys, karts, DT);

  assert.equal(user.state, KART_STATE.NORMAL);
  assert.equal(behind.state, KART_STATE.NORMAL, 'karts behind are spared');
  assert.equal(mid.state, KART_STATE.SQUASHED);
  assert.equal(leader.state, KART_STATE.SQUASHED);
  assert.ok(mid.shrinkTimer > 0 && leader.shrinkTimer > 0);
  assert.ok(leader.shrinkTimer > mid.shrinkTimer,
    `leader shrinks longest (${leader.shrinkTimer.toFixed(2)} vs ${mid.shrinkTimer.toFixed(2)})`);
});
