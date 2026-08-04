// Kart physics — one 120 Hz fixed step per kart, kart-kart collisions, and
// slipstream drafting.
//
// Pure simulation: no THREE, no DOM, no Math.random. Everything shared lives
// in constants.js; the handful of shaping values that exist only here (curve
// gains, event rate limits, visual lambdas) are gathered in TUNE so nothing is
// buried in the code.
//
// Yaw convention (frozen): yaw = atan2(dx, dz), forward = (sin yaw, 0, cos yaw),
// right = (cos yaw, 0, -sin yaw). Increasing yaw steers RIGHT.
//
// Velocity model: `kart.speed` is the canonical signed forward speed, and the
// world velocity (vx, vz) additionally carries a lateral slide component.
// Every step we decompose (vx, vz) in the kart frame, damp the lateral part by
// the active grip, rebuild the world velocity from `speed` + slide, and
// integrate. Yawing the kart while grip is low (drifting) naturally converts
// forward velocity into slide — no special "drift force" is needed.

import {
  GRAVITY, KART, KART_STATE, SURFACE, BOOST, BOUNDS, DRIFT_TIERS, ITEM_PHYSICS,
} from '../core/constants.js';
import {
  TAU, DEG, clamp, clamp01, lerp, sign, damp, dampAngle, moveTowards,
  smoothstep, easeOutCubic, wrapAngle,
} from '../core/mathx.js';

// Local shaping values — no equivalent exists in constants.js (see rule:
// "no magic numbers where a constant exists"; these are physics-internal).
const TUNE = {
  // Steering → yaw. yawGain is rad/s of yaw per radian of steering at full
  // authority; yawSpeedRef is the speed where steering reaches full effect
  // (prevents pirouetting in place, and its sign flip reverses steering when
  // backing up, like a real car).
  yawGain: 3.8,
  yawSpeedRef: 6.0,
  driftSteerRateMul: 1.6,   // steering ramps faster mid-slide so the kart can catch it
  driftKeepFrac: 0.72,      // drift dies below driftMinSpeed * this (hysteresis)
  driftSteerMin: 0.1,       // minimum |steer| that counts as "a steer direction"
  hopDriftWindow: 0.55,     // seconds after the hop in which a drift can engage
  reverseEngageSpeed: 0.6,  // braking below this forward speed starts reversing
  airGripFrac: 0.25,        // lateral grip fraction while airborne

  // Recovery / bounds.
  recoverInvuln: 0.8,       // i-frames after spin/squash/respawn recovery
  respawnMargin: 8,         // beyond offroadExtent + this => respawn
  fallY: -12,               // below this height => respawn

  // Event rate limits (events are per-step otherwise — 120/s of spam).
  wallEventCd: 0.3,
  wallEventMinImpact: 2.0,
  collideEventCd: 0.25,
  collideMinImpact: 1.2,
  offroadEventPeriod: 0.3,
  offroadEventMinSpeed: 2.0,

  // Kart-kart collision response.
  collisionRestitution: 0.3,
  collideMaxDy: 1.6,        // vertical separation beyond which karts don't touch
  starMassMul: 2.5,         // star/bullet karts shove like they're much heavier
  minScaleMass: 0.4,        // shrunk karts stay at least this fraction of mass

  // Bullet autopilot.
  bulletCenterGain: 0.10,   // rad of heading correction per unit of lateral
  bulletMaxCorrection: 0.9,
  bulletTurnLambda: 5.0,

  // Visual-only shaping.
  spinTurns: 2,             // full body turns during a spin-out
  squashScale: 0.42,
  scaleLambda: 9,
  leanLambda: 10,
  rollLambda: 8,
  pitchLambda: 7,
  rollGain: 0.22,
  driftRollExtra: 0.08,
  airPitchGain: 0.04,
  maxAirPitch: 0.32,
  slopeSampleDist: 2.5,
  wheelRadius: 0.34,
};

const DRAFT_COS = Math.cos(BOOST.draftConeDeg * DEG);

// Module-level scratch (karts are stepped sequentially — safe to share).
const _sw = {};
const _rp = {};

/** Lazily attach physics-private scratch fields to a kart instance. */
function initScratch(kart) {
  if (kart._physInit) return;
  kart._physInit = true;
  kart._driftHeld = false;
  kart._onPad = false;
  kart._offroadPulse = 0;
  kart._wallCd = 0;
}

/** Highest drift tier reached for a given charge, or -1. */
function tierForCharge(charge) {
  for (let i = DRIFT_TIERS.length - 1; i >= 0; i--) {
    if (charge >= DRIFT_TIERS[i].chargeTime) return i;
  }
  return -1;
}

/**
 * Advance one fixed simulation step (dt = FIXED_DT) for one kart.
 * Controls are read from kart.controls — the caller zeroes them when the kart
 * has no control (pre-GO, incapacitated); timers still advance regardless.
 */
export function stepKartPhysics(kart, track, dt) {
  initScratch(kart);

  // --- Timers that always tick -------------------------------------------
  if (kart.hopTimer > 0) kart.hopTimer = Math.max(0, kart.hopTimer - dt);
  if (kart.invulnTimer > 0) kart.invulnTimer = Math.max(0, kart.invulnTimer - dt);
  if (kart.starTimer > 0) kart.starTimer = Math.max(0, kart.starTimer - dt);
  if (kart.shrinkTimer > 0) kart.shrinkTimer = Math.max(0, kart.shrinkTimer - dt);
  if (kart.startPenaltyTimer > 0) kart.startPenaltyTimer = Math.max(0, kart.startPenaltyTimer - dt);
  if (kart._wallCd > 0) kart._wallCd -= dt;
  if (kart.boostTimer > 0) {
    kart.boostTimer -= dt;
    if (kart.boostTimer <= 0) {
      kart.boostTimer = 0;
      kart.boostPower = 1;
      kart.boostSource = '';
    }
  }
  // speedMul chases the active boost multiplier: hard attack, soft decay.
  const mulTarget = kart.boostTimer > 0 ? kart.boostPower : 1;
  kart.speedMul = damp(
    kart.speedMul, mulTarget,
    mulTarget > kart.speedMul ? BOOST.attackRate : BOOST.decayRate, dt,
  );

  // --- State machine -------------------------------------------------------
  if (kart.state === KART_STATE.RESPAWNING) {
    kart.stateTimer -= dt;
    if (kart.stateTimer <= 0) {
      completeRespawn(kart, track);
    } else {
      // Frozen in place; let the body relax back to neutral.
      kart.visualScale = damp(kart.visualScale, 1, TUNE.scaleLambda, dt);
      kart.visualYawOffset = damp(kart.visualYawOffset, 0, TUNE.leanLambda, dt);
      kart.visualRoll = damp(kart.visualRoll, 0, TUNE.rollLambda, dt);
    }
    return;
  }

  if (kart.state === KART_STATE.BULLET) {
    kart.stateTimer -= dt;
    if (kart.stateTimer <= 0) {
      kart.state = KART_STATE.NORMAL;
      kart.stateTimer = 0;
      // Small exit boost so leaving the bullet doesn't feel like a wall.
      kart.applyBoost(BOOST.padPower, BOOST.padDuration, 'bullet');
    } else {
      stepBullet(kart, track, dt);
      return;
    }
  }

  if (kart.state === KART_STATE.SPINNING || kart.state === KART_STATE.SQUASHED) {
    kart.stateTimer -= dt;
    if (kart.stateTimer <= 0) {
      kart.state = KART_STATE.NORMAL;
      kart.stateTimer = 0;
      kart.invulnTimer = TUNE.recoverInvuln;
      kart.visualYawOffset = 0; // spin animation ends on a full turn
    }
  }

  // --- Controls -------------------------------------------------------------
  const c = kart.controls;
  const disabled = kart.incapacitated;
  let throttle = disabled ? 0 : c.throttle;
  const brake = disabled ? 0 : c.brake;
  const steer = disabled ? 0 : c.steer;
  if (kart.startPenaltyTimer > 0) throttle = 0; // jumped the start

  // --- Drift state machine ---------------------------------------------------
  const driftHeld = !disabled && !!c.drift;
  const driftPressed = driftHeld && !kart._driftHeld;
  kart._driftHeld = driftHeld;

  if (driftPressed && !kart.airborne) {
    // Hop. The drift itself engages below once a steer direction exists.
    kart.vy = KART.hopVelocity;
    kart.airborne = true;
    kart.hopTimer = TUNE.hopDriftWindow;
    kart.emit('hop');
  }

  if (!kart.drifting && driftHeld && kart.hopTimer > 0
      && Math.abs(kart.speed) > KART.driftMinSpeed
      && Math.abs(steer) > TUNE.driftSteerMin) {
    kart.drifting = true;
    kart.driftDirection = sign(steer);
    kart.driftCharge = 0;
    kart.driftTier = -1;
    kart.emit('drift_start', { direction: kart.driftDirection });
  }

  if (kart.drifting) {
    if (!driftHeld) {
      // Release: cash in the mini-turbo.
      if (kart.driftTier >= 0) {
        const tier = DRIFT_TIERS[kart.driftTier];
        kart.applyBoost(tier.boostPower, tier.boostDuration, 'drift');
        kart.emit('drift_boost', { tier: kart.driftTier });
      }
      kart.cancelDrift();
    } else if (Math.abs(kart.speed) < KART.driftMinSpeed * TUNE.driftKeepFrac) {
      kart.cancelDrift(); // scrubbed too much speed — slide dies, no boost
    } else {
      kart.driftCharge += dt;
      const tier = tierForCharge(kart.driftCharge);
      if (tier > kart.driftTier) {
        kart.driftTier = tier;
        kart.emit('drift_tier', { tier });
      }
    }
  }

  // --- Steering ---------------------------------------------------------------
  let steerTarget;
  if (kart.drifting) {
    // Remap so the kart always holds the slide: full counter-steer still turns
    // into the drift at (2 - driftSteerBoost), full inside steer reaches
    // driftSteerBoost times normal lock.
    const d = kart.driftDirection;
    const into = (steer * d + 1) * 0.5; // 0 = counter-steer, 1 = full inside
    steerTarget = d * lerp(2 - KART.driftSteerBoost, KART.driftSteerBoost, into) * KART.maxSteerAngle;
  } else {
    steerTarget = steer * KART.maxSteerAngle;
  }
  const steerRate = KART.steerRate * kart.statHandling
    * (kart.drifting ? TUNE.driftSteerRateMul : 1);
  kart.steerAngle = moveTowards(kart.steerAngle, steerTarget, steerRate * dt);

  // Authority: full below steerSpeedFalloff of max speed, easing down to
  // steerMinAuthority at (and beyond) max speed.
  const maxV = kart.maxSpeed;
  const speedRatio = Math.abs(kart.speed) / (maxV || 1);
  let authority = lerp(1, KART.steerMinAuthority,
    smoothstep(KART.steerSpeedFalloff, 1, speedRatio));
  if (kart.airborne) authority *= KART.airControl;
  // clamp(speed/ref) scales turning down near standstill and flips it in reverse.
  const speedFactor = clamp(kart.speed / TUNE.yawSpeedRef, -1, 1);
  kart.yaw = wrapAngle(kart.yaw + kart.steerAngle * authority * speedFactor * TUNE.yawGain * dt);

  // --- Longitudinal -------------------------------------------------------------
  // Surface from the previous step's projection (one-step lag is fine at 120 Hz).
  const wasOffroad = kart.surface === SURFACE.OFFROAD;
  const boosting = kart.boostTimer > 0;
  // A live boost powers through offroad (the classic mushroom shortcut).
  const offroadMul = wasOffroad && !boosting ? KART.offroadMaxSpeedMul : 1;
  const cap = maxV * kart.speedMul * kart.aiSpeedMul * offroadMul;

  if (!kart.airborne) {
    // Boosts push even with the throttle released — but the brake must win,
    // or a boosted kart physically cannot slow for a hairpin. Braking restores
    // normal throttle semantics and burns the boost timer down 3x faster.
    const braking = brake > 0;
    if (braking && kart.boostTimer > 0) {
      kart.boostTimer = Math.max(0, kart.boostTimer - 2 * dt);
    }
    const boostPushing = boosting && !braking;
    const effThrottle = boostPushing ? Math.max(throttle, 1) : throttle;
    if (effThrottle > 0 && kart.speed < cap) {
      const accel = boostPushing
        ? Math.max(KART.accel * kart.statAccel, BOOST.attackRate)
        : KART.accel * kart.statAccel;
      kart.speed = Math.min(cap, kart.speed + accel * effThrottle * dt);
    }
    if (brake > 0) {
      if (kart.speed > TUNE.reverseEngageSpeed) {
        kart.speed = Math.max(0, kart.speed - KART.brakeDecel * brake * dt);
      } else if (throttle <= 0) {
        kart.speed = moveTowards(kart.speed, -KART.reverseMaxSpeed,
          KART.accel * kart.statAccel * brake * dt);
      }
    }
    if (effThrottle <= 0 && brake <= 0) {
      kart.speed = moveTowards(kart.speed, 0, KART.coastDecel * dt);
    }
    if (kart.speed > cap) {
      // Over the cap (boost expired, entered offroad, got shrunk): bleed down.
      const decel = wasOffroad ? KART.offroadDrag : BOOST.decayRate;
      kart.speed = Math.max(cap, kart.speed - decel * dt);
    }
    if (kart.speed < -KART.reverseMaxSpeed) {
      kart.speed = Math.min(-KART.reverseMaxSpeed, kart.speed + KART.brakeDecel * dt);
    }
  }

  // --- Compose velocity: forward + damped lateral slide ------------------------
  const fx = Math.sin(kart.yaw);
  const fz = Math.cos(kart.yaw);
  const rx = fz;  // cos(yaw)
  const rz = -fx; // -sin(yaw)
  let lat = kart.vx * rx + kart.vz * rz;
  const baseGrip = kart.drifting ? KART.driftGrip
    : wasOffroad ? KART.offroadGrip : KART.grip;
  const grip = baseGrip * (wasOffroad ? 1 : track.gripAt(kart.s, kart.drifting));
  lat = damp(lat, 0, kart.airborne ? grip * TUNE.airGripFrac : grip, dt);
  kart.vx = fx * kart.speed + rx * lat;
  kart.vz = fz * kart.speed + rz * lat;

  kart.prevX = kart.x;
  kart.prevZ = kart.z;
  kart.x += kart.vx * dt;
  kart.z += kart.vz * dt;

  if (kart.airborne) {
    kart.vy -= GRAVITY * dt;
    kart.y += kart.vy * dt;
  }

  // --- Track projection ----------------------------------------------------------
  const sw = track.sampleWorld(kart.x, kart.z, kart.s, _sw);
  kart.s = sw.s;
  kart.lateral = sw.lateral;
  kart.surface = sw.surface;
  kart.offTrackDepth = sw.offTrackDepth;

  if (!kart.airborne) {
    kart.y = sw.height; // ground is sticky — only hops leave it
  } else if (kart.y <= sw.height && kart.vy <= 0) {
    kart.y = sw.height;
    kart.vy = 0;
    kart.airborne = false;
    kart.emit('land', { speed: Math.abs(kart.speed) });
  }

  // Boost pad: trigger on entering the pad (grounded).
  const onPad = !kart.airborne && sw.surface === SURFACE.BOOST;
  if (onPad && !kart._onPad) kart.applyBoost(BOOST.padPower, BOOST.padDuration, 'pad');
  kart._onPad = onPad;

  // Offroad rumble event, rate-limited.
  if (sw.surface === SURFACE.OFFROAD && !kart.airborne
      && Math.abs(kart.speed) > TUNE.offroadEventMinSpeed) {
    kart._offroadPulse -= dt;
    if (kart._offroadPulse <= 0) {
      kart.emit('offroad', { depth: sw.offTrackDepth });
      kart._offroadPulse = TUNE.offroadEventPeriod;
    }
  } else {
    kart._offroadPulse = 0;
  }

  // --- Soft wall / respawn ----------------------------------------------------------
  const limit = sw.halfWidth + sw.runoff;
  const absLat = Math.abs(sw.lateral);
  if (absLat > limit + TUNE.respawnMargin || kart.y < TUNE.fallY) {
    beginRespawn(kart);
    return;
  }
  if (absLat > limit) {
    const side = sign(sw.lateral);
    // Track frame at the projection foot.
    const hx = Math.sin(sw.heading);
    const hz = Math.cos(sw.heading);
    const wrx = hz;  // right of track direction
    const wrz = -hx;
    // Project back onto the boundary.
    kart.x = sw.cx + wrx * side * limit;
    kart.z = sw.cz + wrz * side * limit;
    kart.lateral = side * limit;
    kart.offTrackDepth = limit - sw.halfWidth;
    // Reflect the outward velocity component, keep most of the tangent.
    let vt = kart.vx * hx + kart.vz * hz;
    let vl = kart.vx * wrx + kart.vz * wrz;
    const outward = vl * side;
    if (outward > 0) {
      vl = -vl * BOUNDS.wallRestitution;
      vt *= BOUNDS.wallTangentKeep;
      kart.vx = hx * vt + wrx * vl;
      kart.vz = hz * vt + wrz * vl;
      kart.speed = kart.vx * fx + kart.vz * fz;
      if (outward > TUNE.wallEventMinImpact && kart._wallCd <= 0) {
        kart.emit('wall_hit', { impact: outward });
        kart._wallCd = TUNE.wallEventCd;
      }
    }
  }

  // (Wrong-way detection lives in race.js — single owner, progress-based.)

  updateVisuals(kart, track, dt);
}

/** Bullet Bill autopilot: rails along the centreline, invulnerable. */
function stepBullet(kart, track, dt) {
  if (kart.drifting) kart.cancelDrift();
  const sw = track.sampleWorld(kart.x, kart.z, kart.s, _sw);

  const targetSpeed = KART.maxSpeed * BOOST.bulletPower;
  kart.speed = moveTowards(kart.speed, targetSpeed, BOOST.attackRate * dt);

  // Steer toward the centreline: aim off the track heading against lateral.
  const correction = clamp(sw.lateral * TUNE.bulletCenterGain,
    -TUNE.bulletMaxCorrection, TUNE.bulletMaxCorrection);
  kart.yaw = dampAngle(kart.yaw, sw.heading - correction, TUNE.bulletTurnLambda, dt);
  kart.steerAngle = moveTowards(kart.steerAngle, 0, KART.steerRate * dt);

  const fx = Math.sin(kart.yaw);
  const fz = Math.cos(kart.yaw);
  kart.vx = fx * kart.speed;
  kart.vz = fz * kart.speed;
  kart.vy = 0;
  kart.airborne = false;
  kart.prevX = kart.x;
  kart.prevZ = kart.z;
  kart.x += kart.vx * dt;
  kart.z += kart.vz * dt;

  const sw2 = track.sampleWorld(kart.x, kart.z, kart.s, _sw);
  kart.s = sw2.s;
  kart.lateral = sw2.lateral;
  kart.surface = sw2.surface;
  kart.offTrackDepth = sw2.offTrackDepth;
  kart.y = sw2.height;
  kart.wrongWay = false;
  kart._wrongWayTimer = 0;

  updateVisuals(kart, track, dt);
}

function beginRespawn(kart) {
  kart.state = KART_STATE.RESPAWNING;
  kart.stateTimer = KART.respawnDuration;
  kart.vx = 0; kart.vy = 0; kart.vz = 0;
  kart.speed = 0;
  kart.airborne = false;
  kart.cancelDrift();
  kart.boostTimer = 0;
  kart.boostPower = 1;
  kart.emit('respawn');
}

function completeRespawn(kart, track) {
  const rp = track.respawnPoint(kart.s, _rp);
  kart.x = rp.x;
  kart.y = rp.y;
  kart.z = rp.z;
  kart.yaw = rp.heading;
  kart.prevX = rp.x;
  kart.prevZ = rp.z;
  kart.vx = 0; kart.vy = 0; kart.vz = 0;
  kart.speed = 0;
  kart.steerAngle = 0;
  kart.airborne = false;
  kart.visualYawOffset = 0;
  kart.state = KART_STATE.NORMAL;
  kart.stateTimer = 0;
  kart.invulnTimer = TUNE.recoverInvuln;
  kart.wrongWay = false;
  kart._wrongWayTimer = 0;
  const sw = track.sampleWorld(kart.x, kart.z, kart.s, _sw);
  kart.s = sw.s;
  kart.lateral = sw.lateral;
  kart.surface = sw.surface;
  kart.offTrackDepth = sw.offTrackDepth;
}

/** Purely cosmetic fields — lean, spin animation, squash, wheels, pitch. */
function updateVisuals(kart, track, dt) {
  if (kart.state === KART_STATE.SPINNING) {
    // Whole-body pirouette that finishes exactly on a full turn.
    const p = clamp01(1 - kart.stateTimer / KART.spinOutDuration);
    kart.visualYawOffset = kart.spinDirection * TAU * TUNE.spinTurns * easeOutCubic(p);
  } else {
    const lean = kart.drifting ? kart.driftDirection * KART.driftYawBias : 0;
    kart.visualYawOffset = damp(kart.visualYawOffset, lean, TUNE.leanLambda, dt);
  }

  const scaleTarget = kart.state === KART_STATE.SQUASHED ? TUNE.squashScale
    : kart.shrinkTimer > 0 ? ITEM_PHYSICS.lightningScale : 1;
  kart.visualScale = damp(kart.visualScale, scaleTarget, TUNE.scaleLambda, dt);

  const ratio = clamp01(Math.abs(kart.speed) / (kart.maxSpeed || 1));
  const rollTarget = kart.steerAngle * TUNE.rollGain * ratio
    + (kart.drifting ? kart.driftDirection * TUNE.driftRollExtra : 0);
  kart.visualRoll = damp(kart.visualRoll, rollTarget, TUNE.rollLambda, dt);

  let pitchTarget;
  if (kart.airborne) {
    pitchTarget = clamp(kart.vy * TUNE.airPitchGain, -TUNE.maxAirPitch, TUNE.maxAirPitch);
  } else {
    const d = TUNE.slopeSampleDist;
    const rise = track.spline.heightAt(kart.s + d) - track.spline.heightAt(kart.s - d);
    pitchTarget = Math.atan2(rise, d * 2);
  }
  kart.visualPitch = damp(kart.visualPitch, pitchTarget, TUNE.pitchLambda, dt);

  kart.wheelSpin += (kart.speed * dt) / TUNE.wheelRadius;
}

/**
 * Pairwise kart-kart collision: circle push-out weighted by inverse mass,
 * partial velocity exchange along the contact normal, star knock-outs,
 * rate-limited 'collide' events on both karts.
 */
export function resolveKartCollisions(karts, dt) {
  const n = karts.length;
  // Per-pair event cooldowns live on the karts (allocated once).
  for (let i = 0; i < n; i++) {
    const k = karts[i];
    let cd = k._pairCd;
    if (!cd || cd.length !== n) {
      cd = new Array(n).fill(0);
      k._pairCd = cd;
    }
    for (let j = 0; j < n; j++) if (cd[j] > 0) cd[j] -= dt;
  }

  for (let i = 0; i < n; i++) {
    const a = karts[i];
    if (a.finished || a.state === KART_STATE.RESPAWNING) continue;
    for (let j = i + 1; j < n; j++) {
      const b = karts[j];
      if (b.finished || b.state === KART_STATE.RESPAWNING) continue;
      if (Math.abs(a.y - b.y) > TUNE.collideMaxDy) continue;

      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const minDist = KART.collisionRadius * (a.visualScale + b.visualScale);
      const d2 = dx * dx + dz * dz;
      if (d2 >= minDist * minDist) continue;

      const dist = Math.sqrt(d2);
      let nx, nz;
      if (dist > 1e-6) {
        nx = dx / dist;
        nz = dz / dist;
      } else {
        // Perfect overlap: push apart along a's right vector (deterministic).
        nx = Math.cos(a.yaw);
        nz = -Math.sin(a.yaw);
      }

      let ma = a.statWeight * Math.max(TUNE.minScaleMass, a.visualScale);
      let mb = b.statWeight * Math.max(TUNE.minScaleMass, b.visualScale);
      const aRampaging = a.starTimer > 0 || a.state === KART_STATE.BULLET;
      const bRampaging = b.starTimer > 0 || b.state === KART_STATE.BULLET;
      if (aRampaging) ma *= TUNE.starMassMul;
      if (bRampaging) mb *= TUNE.starMassMul;
      const invA = 1 / ma;
      const invB = 1 / mb;
      const invSum = invA + invB;

      // Positional separation proportional to inverse mass.
      const overlap = minDist - dist;
      a.x -= nx * overlap * (invA / invSum);
      a.z -= nz * overlap * (invA / invSum);
      b.x += nx * overlap * (invB / invSum);
      b.z += nz * overlap * (invB / invSum);

      // Exchange a bit of velocity along the normal when approaching.
      const rel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
      let impact = 0;
      if (rel < 0) {
        impact = -rel;
        const jmag = (1 + TUNE.collisionRestitution) * impact / invSum;
        a.vx -= nx * jmag * invA;
        a.vz -= nz * jmag * invA;
        b.vx += nx * jmag * invB;
        b.vz += nz * jmag * invB;
        a.speed = a.vx * a.forwardX + a.vz * a.forwardZ;
        b.speed = b.vx * b.forwardX + b.vz * b.forwardZ;
      }

      // Star (and bullet) contact knocks the other kart out.
      if (aRampaging && !bRampaging) b.spinOut(a.starTimer > 0 ? 'star' : 'bullet');
      else if (bRampaging && !aRampaging) a.spinOut(b.starTimer > 0 ? 'star' : 'bullet');

      if (impact > TUNE.collideMinImpact && a._pairCd[j] <= 0) {
        a.emit('collide', { impactSpeed: impact, otherIndex: b.index });
        b.emit('collide', { impactSpeed: impact, otherIndex: a.index });
        a._pairCd[j] = TUNE.collideEventCd;
        b._pairCd[i] = TUNE.collideEventCd;
      }
    }
  }
}

/**
 * Slipstream: following another kart closely (within draftRange, inside the
 * draft cone of your forward vector, both near top speed) charges draftCharge;
 * a full charge grants the draft boost and resets.
 */
export function updateDrafting(karts, dt) {
  const minFrac = 0.6;
  for (let i = 0; i < karts.length; i++) {
    const k = karts[i];
    if (k.incapacitated || k.state === KART_STATE.BULLET || k.airborne
        || Math.abs(k.speed) < k.maxSpeed * minFrac) {
      k.draftCharge = Math.max(0, k.draftCharge - dt * 2);
      continue;
    }
    const fx = Math.sin(k.yaw);
    const fz = Math.cos(k.yaw);
    let found = false;
    for (let j = 0; j < karts.length; j++) {
      if (j === i) continue;
      const o = karts[j];
      if (o.incapacitated || Math.abs(o.speed) < o.maxSpeed * minFrac) continue;
      const dx = o.x - k.x;
      const dz = o.z - k.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > BOOST.draftRange * BOOST.draftRange || d2 < 1e-6) continue;
      const dist = Math.sqrt(d2);
      if ((dx * fx + dz * fz) / dist < DRAFT_COS) continue; // not ahead in the cone
      found = true;
      break;
    }
    if (found) {
      k.draftCharge += dt;
      if (k.draftCharge >= BOOST.draftChargeTime) {
        k.applyBoost(BOOST.draftPower, BOOST.draftDuration, 'draft');
        k.draftCharge = 0;
      }
    } else {
      k.draftCharge = Math.max(0, k.draftCharge - dt * 2);
    }
  }
}
