// stepKartPhysics / resolveKartCollisions / updateDrafting contract tests.
// Deterministic: fixed timestep, no Rng needed (physics itself is random-free).
// Karts drive on a synthetic circle track via a tiny pure-pursuit helper so no
// AI module is involved. Pure Node — no THREE, no DOM.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FIXED_DT, KART, KART_STATE, SURFACE, BOOST, BOUNDS, DRIFT_TIERS,
} from '../src/core/constants.js';
import { Track } from '../src/track/track.js';
import { Kart } from '../src/game/kart.js';
import { CHARACTERS_BY_ID } from '../src/game/characters.js';
import { clamp, angleDelta, pmod, loopDelta } from '../src/core/mathx.js';
import { stepKartPhysics, resolveKartCollisions, updateDrafting } from '../src/game/physics.js';

const DT = FIXED_DT;

// --- Fixtures ---------------------------------------------------------------

/** Circle track, radius 40 (right-turning in the yaw convention), width 20. */
function circleDef(extra = {}) {
  const R = 40;
  const N = 16;
  const points = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    points.push({ x: R * Math.sin(a), z: R * Math.cos(a) });
  }
  return { id: 'test-circle', name: 'Test Circle', width: 20, laps: 3, spacing: 1, points, ...extra };
}

const track = new Track(circleDef());
const padTrack = new Track(circleDef({
  id: 'test-circle-pad',
  boostPads: [{ s: 30, lateral: 0, width: 12, length: 8 }],
}));
const iceTrack = new Track(circleDef({
  id: 'test-circle-ice',
  gripZones: [{ startFrac: 0, endFrac: 1, grip: 0.70, driftGrip: 0.88 }],
}));

const NEUTRAL = {
  id: 'neutral', name: 'Neutral', color: 0xffffff,
  stats: { speed: 1, accel: 1, handling: 1, weight: 1 },
};

function makeKart(index = 0, character = NEUTRAL) {
  return new Kart({ index, character });
}

/** Place a kart on the track at (s, lateral), facing along the track. */
function place(kart, trk, s, lateral = 0) {
  const w = trk.toWorld(s, lateral, {});
  kart.x = w.x; kart.y = w.y; kart.z = w.z;
  kart.prevX = w.x; kart.prevZ = w.z;
  kart.yaw = w.heading;
  kart.s = pmod(s, trk.length);
  kart.lateral = lateral;
  return kart;
}

/** Pure-pursuit steer input toward a lookahead point at `targetLateral`. */
function pursue(kart, trk, targetLateral = 0, lookahead = 7) {
  const aim = trk.toWorld(kart.s + lookahead, targetLateral, {});
  const desired = Math.atan2(aim.x - kart.x, aim.z - kart.z);
  return clamp(angleDelta(kart.yaw, desired) * 3, -1, 1);
}

/** Step `seconds` of physics; `fill(controls, t, i)` sets the inputs each step. */
function drive(kart, trk, seconds, fill) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    const c = kart.controls;
    c.throttle = 0; c.brake = 0; c.steer = 0;
    c.drift = false; c.useItem = false; c.lookBack = false;
    fill(c, i * DT, i);
    stepKartPhysics(kart, trk, DT);
  }
}

const eventTypes = (kart) => kart.events.map((e) => e.type);

// --- Longitudinal -------------------------------------------------------------

test('full throttle accelerates at KART.accel and tops out at maxSpeed', () => {
  const kart = place(makeKart(), track, 0);

  drive(kart, track, 0.5, (c) => {
    c.throttle = 1;
    c.steer = pursue(kart, track);
  });
  assert.ok(Math.abs(kart.speed - KART.accel * 0.5) < 0.3,
    `speed after 0.5s = ${kart.speed.toFixed(2)}, expected ~${(KART.accel * 0.5).toFixed(1)}`);

  drive(kart, track, 3.5, (c) => {
    c.throttle = 1;
    c.steer = pursue(kart, track);
  });
  assert.ok(kart.speed > kart.maxSpeed - 0.05, `top speed ${kart.speed.toFixed(2)}`);
  assert.ok(kart.speed <= kart.maxSpeed + 1e-6, 'no boost: never exceeds maxSpeed');
  assert.equal(kart.surface, SURFACE.ROAD, 'pure pursuit kept the kart on the road');
  assert.ok(kart.s > 50, `kart advanced along the track (s=${kart.s.toFixed(1)})`);
});

test('brakes at brakeDecel, then reverses up to reverseMaxSpeed', () => {
  const kart = place(makeKart(), track, 0);
  kart.speed = KART.maxSpeed;

  drive(kart, track, 0.5, (c) => { c.brake = 1; });
  assert.ok(Math.abs(kart.speed - (KART.maxSpeed - KART.brakeDecel * 0.5)) < 0.3,
    `speed after 0.5s braking = ${kart.speed.toFixed(2)}`);

  drive(kart, track, 1.5, (c) => { c.brake = 1; });
  assert.ok(Math.abs(kart.speed + KART.reverseMaxSpeed) < 1e-6,
    `holding brake reverses to -reverseMaxSpeed, got ${kart.speed.toFixed(3)}`);
});

test('coasting decays speed toward zero', () => {
  const kart = place(makeKart(), track, 0);
  kart.speed = 10;
  drive(kart, track, 1.5, () => {});
  assert.ok(Math.abs(kart.speed) < 0.01, `coasted to ${kart.speed.toFixed(3)}`);
});

test('steering: +steer yaws right, -steer yaws left (at speed)', () => {
  for (const dir of [1, -1]) {
    const kart = place(makeKart(), track, 0);
    kart.speed = 15;
    const yaw0 = kart.yaw;
    drive(kart, track, 0.5, (c) => { c.throttle = 1; c.steer = dir; });
    const turned = angleDelta(yaw0, kart.yaw);
    assert.ok(turned * dir > 0.2, `steer=${dir} turned ${turned.toFixed(3)} rad`);
    assert.ok(turned * dir < Math.PI, 'turn stays under half a revolution in 0.5s');
  }
});

test('start penalty locks the throttle at zero until it expires', () => {
  const kart = place(makeKart(), track, 0);
  kart.startPenaltyTimer = 0.5;
  drive(kart, track, 0.4, (c) => { c.throttle = 1; });
  assert.equal(kart.speed, 0, 'no movement while penalized');
  assert.ok(kart.startPenaltyTimer > 0);
  drive(kart, track, 1.0, (c) => { c.throttle = 1; });
  assert.ok(kart.speed > 5, `accelerates after the penalty (speed ${kart.speed.toFixed(2)})`);
});

// --- Drift ---------------------------------------------------------------------

test('drift: hop + steer charges through all tiers and boosts on release', () => {
  const kart = place(makeKart(), track, 0);
  kart.speed = KART.maxSpeed;

  let pressed = false;
  const driftDrive = (seconds) => drive(kart, track, seconds, (c) => {
    c.throttle = 1;
    c.drift = true;
    // Pin the steer direction for the press step, then let pursuit balance it.
    c.steer = pressed ? pursue(kart, track) : 1;
    pressed = true;
  });

  driftDrive(0.1);
  assert.equal(kart.drifting, true, 'drift engaged from hop + steer');
  assert.equal(kart.driftDirection, 1);
  assert.ok(eventTypes(kart).includes('hop'));
  assert.ok(eventTypes(kart).includes('drift_start'));

  driftDrive(1.1); // ~1.2s held > blue chargeTime 0.85
  assert.ok(kart.driftTier >= 0, `blue tier by 1.2s (tier=${kart.driftTier})`);
  driftDrive(1.0); // ~2.2s > orange 1.85
  assert.ok(kart.driftTier >= 1, `orange tier by 2.2s (tier=${kart.driftTier})`);
  driftDrive(1.3); // ~3.5s > purple 3.10
  assert.equal(kart.driftTier, 2, 'purple tier by 3.5s');
  assert.equal(kart.drifting, true, 'drift survived the whole charge');
  assert.ok(eventTypes(kart).includes('land'), 'hop landed during the drift');

  // Release: purple mini-turbo cashes in.
  drive(kart, track, 0.05, (c) => {
    c.throttle = 1;
    c.steer = pursue(kart, track);
  });
  assert.equal(kart.drifting, false);
  assert.equal(kart.driftTier, -1, 'cancelDrift cleared the tier');
  assert.equal(kart.boostSource, 'drift');
  assert.equal(kart.boostPower, DRIFT_TIERS[2].boostPower);
  assert.ok(kart.boostTimer > 0);
  const boostEv = kart.events.find((e) => e.type === 'drift_boost');
  assert.ok(boostEv && boostEv.tier === 2, 'drift_boost event carries the tier');

  drive(kart, track, 0.5, (c) => {
    c.throttle = 1;
    c.steer = pursue(kart, track);
  });
  assert.ok(kart.speed > KART.maxSpeed + 2,
    `mini-turbo pushes past maxSpeed (${kart.speed.toFixed(2)})`);
});

test('drift release below the first tier grants no boost', () => {
  const kart = place(makeKart(), track, 0);
  kart.speed = KART.maxSpeed;
  let pressed = false;
  drive(kart, track, 0.5, (c) => { // < blue chargeTime 0.85
    c.throttle = 1;
    c.drift = true;
    c.steer = pressed ? pursue(kart, track) : 1;
    pressed = true;
  });
  assert.equal(kart.drifting, true);
  drive(kart, track, 0.2, (c) => { c.throttle = 1; c.steer = pursue(kart, track); });
  assert.equal(kart.drifting, false);
  assert.equal(kart.boostTimer, 0, 'no mini-turbo below tier 0');
  assert.ok(!eventTypes(kart).includes('drift_boost'));
});

test('steering after the hop window closes never engages a drift', () => {
  const kart = place(makeKart(), track, 0);
  kart.speed = KART.maxSpeed;
  // Hop with zero steer, hold drift past hopDriftWindow (0.55s)...
  drive(kart, track, 0.7, (c) => { c.throttle = 1; c.drift = true; c.steer = 0; });
  assert.equal(kart.drifting, false);
  // ...then steer hard while still holding: too late.
  drive(kart, track, 0.6, (c) => { c.throttle = 1; c.drift = true; c.steer = 1; });
  assert.equal(kart.drifting, false, 'drift must not engage after the hop window');
  assert.ok(!eventTypes(kart).includes('drift_start'));
});

// --- Surfaces --------------------------------------------------------------------

test('offroad: cap lags one step behind the surface, then drags speed down', () => {
  const kart = place(makeKart(), track, 80, -15); // 5m past the road edge
  kart.speed = KART.maxSpeed;
  assert.equal(kart.surface, SURFACE.ROAD, 'fixture: previous-step surface is road');

  drive(kart, track, DT, (c) => { c.throttle = 1; c.steer = pursue(kart, track, -15); });
  assert.equal(kart.surface, SURFACE.OFFROAD, 'projection now reports offroad');
  assert.ok(Math.abs(kart.speed - KART.maxSpeed) < 1e-9,
    'first step on offroad is uncapped (surface was road last step)');

  drive(kart, track, 1.5, (c) => { c.throttle = 1; c.steer = pursue(kart, track, -15); });
  const offroadCap = KART.maxSpeed * KART.offroadMaxSpeedMul;
  assert.equal(kart.surface, SURFACE.OFFROAD);
  assert.ok(kart.offTrackDepth > 0);
  assert.ok(Math.abs(kart.speed - offroadCap) < 0.2,
    `offroad settles at the cap: ${kart.speed.toFixed(2)} vs ${offroadCap.toFixed(2)}`);
});

test('an active boost powers through offroad; expiry hands it back to the drag', () => {
  const kart = place(makeKart(), track, 80, -15);
  kart.surface = SURFACE.OFFROAD; // already offroad last step
  kart.speed = KART.maxSpeed * KART.offroadMaxSpeedMul;
  kart.applyBoost(BOOST.mushroomPower, 2.0, 'mushroom');

  drive(kart, track, 1.2, (c) => { c.throttle = 1; c.steer = pursue(kart, track, -15); });
  assert.equal(kart.surface, SURFACE.OFFROAD, 'still offroad while boosting');
  assert.ok(kart.speed > KART.maxSpeed,
    `boost ignores the offroad cap (speed ${kart.speed.toFixed(2)})`);
  assert.ok(kart.boostTimer > 0);

  drive(kart, track, 2.3, (c) => { c.throttle = 1; c.steer = pursue(kart, track, -15); });
  assert.equal(kart.boostTimer, 0);
  assert.ok(kart.speed < KART.maxSpeed * KART.offroadMaxSpeedMul + 0.5,
    `offroad drag reclaims the kart after expiry (speed ${kart.speed.toFixed(2)})`);
});

test('ice lowers lateral grip without changing the road surface enum', () => {
  const roadKart = place(makeKart(), track, 20);
  const iceKart = place(makeKart(), iceTrack, 20);
  for (const kart of [roadKart, iceKart]) {
    const rightX = Math.cos(kart.yaw);
    const rightZ = -Math.sin(kart.yaw);
    kart.vx = rightX * 7;
    kart.vz = rightZ * 7;
    kart.speed = 0;
  }

  stepKartPhysics(roadKart, track, DT);
  stepKartPhysics(iceKart, iceTrack, DT);
  const roadSlide = Math.hypot(roadKart.vx, roadKart.vz);
  const iceSlide = Math.hypot(iceKart.vx, iceKart.vz);
  assert.equal(iceKart.surface, SURFACE.ROAD);
  assert.ok(iceSlide > roadSlide,
    `ice slide ${iceSlide.toFixed(3)} should exceed road ${roadSlide.toFixed(3)}`);
});

test('boost pad triggers a pad boost and pushes past maxSpeed', () => {
  const kart = place(makeKart(), padTrack, 0);
  let maxSeen = 0;
  drive(kart, padTrack, 3, (c) => {
    c.throttle = 1;
    c.steer = pursue(kart, padTrack);
    maxSeen = Math.max(maxSeen, kart.speed);
  });
  const padBoost = kart.events.find((e) => e.type === 'boost' && e.source === 'pad');
  assert.ok(padBoost, 'crossing the pad emitted a pad boost');
  assert.ok(maxSeen > KART.maxSpeed * 1.15,
    `pad boost exceeded maxSpeed (peak ${maxSeen.toFixed(2)})`);
});

test('boost decay: over-cap speed bleeds back to maxSpeed after expiry', () => {
  const kart = place(makeKart(), track, 0);
  kart.speed = KART.maxSpeed;
  kart.applyBoost(BOOST.padPower, 0.6, 'pad');
  let maxSeen = 0;
  drive(kart, track, 0.6, (c) => {
    c.throttle = 1;
    c.steer = pursue(kart, track);
    maxSeen = Math.max(maxSeen, kart.speed);
  });
  assert.ok(maxSeen > KART.maxSpeed * 1.2, `boost peak ${maxSeen.toFixed(2)}`);

  drive(kart, track, 2.5, (c) => {
    c.throttle = 1;
    c.steer = pursue(kart, track);
  });
  assert.equal(kart.boostTimer, 0);
  assert.equal(kart.boostSource, '', 'source cleared with the timer');
  assert.ok(kart.speed <= KART.maxSpeed + 0.05,
    `decayed back to maxSpeed (${kart.speed.toFixed(2)})`);
  assert.ok(kart.speedMul < 1.02, `speedMul relaxed to 1 (${kart.speedMul.toFixed(3)})`);
});

// --- Bounds ------------------------------------------------------------------------

test('soft wall keeps the kart inside halfWidth + offroadExtent', () => {
  const kart = place(makeKart(), track, 50, 0);
  kart.yaw = track.spline.sampleAt(50, {}).heading - Math.PI / 2; // straight outward
  const limit = track.halfWidthAt(50) + BOUNDS.offroadExtent;
  let maxLat = 0;
  drive(kart, track, 3, (c) => {
    c.throttle = 1;
    maxLat = Math.max(maxLat, Math.abs(kart.lateral));
  });
  assert.ok(maxLat > track.halfWidthAt(50), 'the kart did reach the offroad strip');
  assert.ok(maxLat <= limit + 0.6, `never beyond the wall: ${maxLat.toFixed(2)} vs ${limit}`);
  assert.equal(kart.state, KART_STATE.NORMAL, 'wall handled it — no respawn');
  assert.ok(eventTypes(kart).includes('wall_hit'));
});

test('far beyond the wall margin triggers a full respawn onto the centreline', () => {
  const kart = place(makeKart(), track, 80, -(track.halfWidthAt(80) + BOUNDS.offroadExtent + 9));
  drive(kart, track, DT, () => {});
  assert.equal(kart.state, KART_STATE.RESPAWNING);
  assert.ok(eventTypes(kart).includes('respawn'));
  assert.equal(kart.speed, 0);

  drive(kart, track, KART.respawnDuration + 0.1, () => {});
  assert.equal(kart.state, KART_STATE.NORMAL);
  assert.ok(Math.abs(kart.lateral) < 0.5, `respawned on centreline (lateral ${kart.lateral.toFixed(2)})`);
  assert.ok(Math.abs(loopDelta(pmod(80 - 3, track.length), kart.s, track.length)) < 3,
    `respawned slightly behind (s=${kart.s.toFixed(1)})`);
  assert.ok(kart.invulnTimer > 0, 'i-frames after respawn');
});

// --- Status timers ------------------------------------------------------------------

test('spinOut: control lost for spinOutDuration, then i-frames', () => {
  const kart = place(makeKart(), track, 0);
  kart.speed = 20;
  assert.equal(kart.spinOut('shell'), true);
  assert.equal(kart.state, KART_STATE.SPINNING);
  assert.ok(Math.abs(kart.speed - 20 * KART.spinOutSpeedMul) < 1e-9, 'spin scrubs speed');

  drive(kart, track, 1.0, (c) => { c.throttle = 1; });
  assert.equal(kart.state, KART_STATE.SPINNING, 'still spinning at 1.0s (duration 1.35)');
  assert.ok(kart.speed < 1, 'throttle is dead while incapacitated');

  drive(kart, track, 0.5, (c) => { c.throttle = 1; });
  assert.equal(kart.state, KART_STATE.NORMAL);
  assert.ok(kart.invulnTimer > 0 && kart.invulnerable, 'recovery i-frames');
  assert.equal(kart.spinOut('shell'), false, 'i-frames reject a second hit');
});

test('squash: dead stop, shrinks visually, recovers after squashDuration', () => {
  const kart = place(makeKart(), track, 0);
  kart.speed = 20;
  assert.equal(kart.squash('bomb'), true);
  assert.equal(kart.state, KART_STATE.SQUASHED);
  assert.equal(kart.speed, 0);

  drive(kart, track, 0.8, (c) => { c.throttle = 1; });
  assert.equal(kart.state, KART_STATE.SQUASHED, 'still flat at 0.8s (duration 1.6)');
  assert.ok(kart.visualScale < 0.7, `body squashed (scale ${kart.visualScale.toFixed(2)})`);

  drive(kart, track, 1.0, (c) => { c.throttle = 1; });
  assert.equal(kart.state, KART_STATE.NORMAL);
  assert.ok(kart.invulnTimer > 0);
});

// --- Multi-kart ------------------------------------------------------------------------

test('collisions push overlapping karts apart; the light kart moves more', () => {
  const light = makeKart(0, CHARACTERS_BY_ID.pip);      // weight 0.82
  const heavy = makeKart(1, CHARACTERS_BY_ID.gearbox);  // weight 1.30
  light.x = 0; light.z = 0; light.vx = 5;
  heavy.x = 1; heavy.z = 0; heavy.vx = -5;
  const karts = [light, heavy];

  resolveKartCollisions(karts, DT);

  const minDist = KART.collisionRadius * 2;
  const dist = Math.hypot(heavy.x - light.x, heavy.z - light.z);
  assert.ok(dist >= minDist - 1e-9, `separated to ${dist.toFixed(3)} (min ${minDist})`);
  assert.ok(Math.abs(light.x - 0) > Math.abs(heavy.x - 1),
    'inverse-mass push: light kart displaced further');
  assert.ok(light.vx < 5 && heavy.vx > -5, 'velocity exchanged along the normal');
  const evA = light.events.find((e) => e.type === 'collide');
  const evB = heavy.events.find((e) => e.type === 'collide');
  assert.ok(evA && evB, 'both karts emit collide');
  assert.ok(evA.impactSpeed > 1.2);
});

test('star contact spins out the normal kart, never the star kart', () => {
  const star = makeKart(0, CHARACTERS_BY_ID.pip);
  const victim = makeKart(1, CHARACTERS_BY_ID.gearbox);
  star.starTimer = 5;
  star.x = 0; star.z = 0;
  victim.x = 1; victim.z = 0;
  resolveKartCollisions([star, victim], DT);
  assert.equal(victim.state, KART_STATE.SPINNING);
  assert.equal(star.state, KART_STATE.NORMAL);
  const ev = victim.events.find((e) => e.type === 'spinout');
  assert.equal(ev.cause, 'star');
});

test('drafting: tailing a kart for draftChargeTime grants the draft boost', () => {
  const ahead = makeKart(0);
  const behind = makeKart(1);
  ahead.x = 0; ahead.z = 6; ahead.yaw = 0; ahead.speed = 25;
  behind.x = 0; behind.z = 0; behind.yaw = 0; behind.speed = 25;
  const karts = [ahead, behind];

  const steps = Math.ceil((BOOST.draftChargeTime + 0.1) / DT);
  for (let i = 0; i < steps; i++) updateDrafting(karts, DT);

  assert.equal(behind.boostSource, 'draft');
  assert.ok(behind.boostTimer > 0);
  // Charge resets when the boost fires, then re-accumulates for the extra 0.1s.
  assert.ok(behind.draftCharge < 0.15,
    `charge reset on boost (now ${behind.draftCharge.toFixed(3)})`);
  assert.equal(ahead.boostTimer, 0, 'no one ahead of the leader');
  assert.equal(ahead.draftCharge, 0);
});
