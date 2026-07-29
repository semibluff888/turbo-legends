// AiDriver — the computer racer.
//
// Reads the world, writes `kart.controls` (plus `kart.aiSpeedMul`) and nothing
// else. Pure simulation: no THREE, no DOM, all randomness through the injected
// per-driver Rng so headless races replay exactly without cross-driver coupling.
//
// Driving model:
//   steering — pure pursuit toward a point on the racing line ahead, nudged by
//              a per-driver lateral bias + slow sine wander, pushed sideways by
//              hazards/projectiles/karts blocking the lane.
//   throttle — full unless curvature ahead demands a lower corner speed
//              (v = sqrt(a_lat / |k|)); then lift or brake.
//   drift    — hold through sustained corners, release at a skill-scaled
//              mini-turbo tier or when the corner ends.
//   items    — position-aware usage behind a humanising cooldown.
//   pacing   — rubber-band vs an explicit race-provided progress reference.

import { KART, RACE, ITEM, KART_STATE, RACE_STATE, DRIFT_TIERS } from '../core/constants.js';
import { clamp, angleDelta, loopDelta } from '../core/mathx.js';

// AI-only tuning. constants.js has no AI section (frozen), so the driver's
// private knobs live here; everything shared still comes from constants.js.
const AI = {
  // Pure pursuit
  steerGain: 2.2,
  lookAheadSpeedMul: 0.55,
  lookAheadMin: 6,
  lookAheadMax: 22,
  lookJitter: [-1.5, 2.5],       // per-driver, drawn once
  edgeMargin: 1.2,               // keep the target this far inside the road edge
  biasFrac: 0.35,                // lateral bias, fraction of base half-width
  noiseFreq: [0.22, 0.45],       // rad/s of the slow wander sine
  noiseAmp: [0.35, 0.9],

  // Corner speed / braking
  brakeLookaheadMul: 0.8,        // brake probe distance = speed * this
  maxLatAccelBase: 20,           // * aiSkill => lateral accel budget (m/s^2)
  latAccelJitter: [0.92, 1.08],
  brakeMargin: 1.12,             // brake when speed > curveSpeed * this
  liftMargin: 0.97,              // lift when speed > curveSpeed * this
  liftThrottle: 0.35,
  bigErrorAngle: 1.1,            // heading error beyond which we ease off
  bigErrorThrottle: 0.5,

  // Hazard / projectile avoidance
  hazardAheadRange: 26,
  hazardLateralRange: 2.2,
  hazardDodge: 2.6,
  inboundBehindRange: 18,
  inboundLateralRange: 3.5,

  // Kart avoidance / bumping
  kartAheadRange: 11,
  kartLateralRange: 2.0,
  kartDodge: 2.3,
  bumpAggression: 0.68,          // aggression above this tries to bump instead
  bumpSpeedAdvantage: 2.5,

  // Wall-stick recovery
  stuckSpeed: 1.0,
  stuckTime: 1.2,
  reverseTime: 0.8,
  reverseSteer: 0.8,

  // U-turn recovery (pursuit is ambiguous facing ~backwards: err ≈ ±π flips
  // sign every step, steering cancels out, and the kart drives on, wrong way).
  uturnEnter: 2.4,
  uturnExit: 0.9,

  // Drift. A drift is a committed turn in this physics model (neutral steer
  // still yaws inward at full base lock), so the AI only drifts corners tight
  // enough that the drift's minimum turn radius fits inside them.
  driftStartCurv: 0.045,         // radius < ~22m — only genuinely tight corners
  driftEndCurv: 0.016,
  driftCornerTime: 0.35,         // sustained-corner seconds before initiating
  driftSpeedMargin: 4,           // above KART.driftMinSpeed
  driftCooldown: 1.4,            // also throttles hop spam (hops cut steering)
  driftThrottleFloor: 0.85,
  driftOverRotate: 0.55,         // release when steering fights the drift this hard

  // Mistakes
  mistakeWindow: 4,              // seconds between mistake rolls (jittered)
  mistakeRateScale: 0.6,         // mistakeRate = (1 - aiSkill) * this
  mistakeDuration: [0.35, 0.7],
  oversteerMul: 1.7,
  understeerMul: 0.45,
  lateBrakeCurveSpeedBonus: 7,   // pretend the corner allows this much more speed

  // Items
  itemCooldown: [0.6, 2.0],      // after the roulette lands
  itemRetry: 0.45,               // hesitation after a failed gate roll
  itemUseCooldown: [0.6, 1.4],   // between uses (triple mushroom etc.)
  itemDriveBase: 0.35,           // gate = itemAggression * (base + span*personality)
  itemDriveSpan: 0.85,
  itemDriveMin: 0.12,
  shellRange: 30,
  shellAngle: 10 * (Math.PI / 180),
  behindCloseRange: 8,
  redShellGap: 45,
  mushroomMaxCurv: 0.012,
  bananaCornerCurv: 0.025,
  clusterRange: [8, 34],
  starPanicRank: 4,
  comebackRank: 5,
  blueShellMinRank: 3,

  // Rubber band. rubberUp must comfortably exceed the worst character speed
  // deficit (0.92) at full difficulty.rubberBand, or slow characters fall off
  // the back of the pack and time out instead of finishing.
  rubberInterval: 0.5,
  rubberGapRange: 90,            // progress gap (m) for full effect
  rubberUp: 0.24,
  rubberDown: 0.10,
  rubberClamp: [0.85, 1.18],

  // Start
  startPressBase: 0.13,          // aim: press this long before GO (rocket window)
  startPressWobbleBase: 0.05,
  startPressWobbleSkill: 0.28,   // * (1 - aiSkill)
  startPressClamp: [0.03, 0.55],
};

/** Sign of v with a deadzone, falling back to `fb` when ~zero. */
function sgnOr(v, fb) {
  return v > 1e-3 ? 1 : v < -1e-3 ? -1 : fb;
}

export class AiDriver {
  /**
   * @param {import('./kart.js').Kart} kart the kart this driver controls
   * @param {import('../track/track.js').Track} track
   * @param {import('../core/rng.js').Rng} rng independent seeded RNG for this driver
   * @param {{aiSpeed:number, aiSkill:number, rubberBand:number, itemAggression:number}} difficulty
   *        one of the DIFFICULTY presets
   * @param {number} personality 0..1 aggression
   */
  constructor(kart, track, rng, difficulty, personality = 0.5) {
    this.kart = kart;
    this.track = track;
    this.rng = rng;
    this.difficulty = difficulty;
    this.aggression = clamp(personality, 0, 1);

    // --- Per-driver flavour, drawn ONCE so the whole race is deterministic --
    this.lateralBias = rng.range(-AI.biasFrac, AI.biasFrac) * track.baseHalfWidth;
    this._lookJitter = rng.range(AI.lookJitter[0], AI.lookJitter[1]);
    this._noisePhase = rng.range(0, Math.PI * 2);
    this._noiseFreq = rng.range(AI.noiseFreq[0], AI.noiseFreq[1]);
    this._noiseAmp = rng.range(AI.noiseAmp[0], AI.noiseAmp[1]);
    this.mistakeRate = (1 - difficulty.aiSkill) * AI.mistakeRateScale;
    this._maxLatAccel = AI.maxLatAccelBase * difficulty.aiSkill
      * rng.range(AI.latAccelJitter[0], AI.latAccelJitter[1]);

    // Rocket-start attempt: press the throttle this long before GO. Low skill
    // wobbles further outside RACE.rocketStartWindow (jump starts happen).
    const wobble = AI.startPressWobbleBase + (1 - difficulty.aiSkill) * AI.startPressWobbleSkill;
    this._startPressAt = clamp(
      AI.startPressBase + rng.range(-wobble, wobble),
      AI.startPressClamp[0], AI.startPressClamp[1],
    );

    // Drift ambition: low skill releases at tier 0/1, high skill waits for 2.
    const skillRoll = difficulty.aiSkill + rng.range(-0.05, 0.05);
    this._targetTier = Math.min(
      skillRoll >= 0.86 ? 2 : skillRoll >= 0.64 ? 1 : 0,
      DRIFT_TIERS.length - 1,
    );
    this.canDrift = rng.chance(clamp(difficulty.aiSkill * 1.25 - 0.18, 0, 1));

    this._itemDrive = clamp(
      difficulty.itemAggression * (AI.itemDriveBase + AI.itemDriveSpan * this.aggression),
      AI.itemDriveMin, 1,
    );

    // --- Mutable driver state ----------------------------------------------
    this._time = 0;
    this._blockedTime = 0;
    this._reverseTimer = 0;
    this._driftHold = false;
    this._driftSign = 0;
    this._driftCooldown = 0;
    this._cornerTime = 0;
    this._mistakeTimer = rng.range(1, AI.mistakeWindow);
    this._mistakeLeft = 0;
    this._mistakeKind = 0;
    this._itemCooldown = 0;
    this._uturnSign = 0;           // latched turn direction while recovering
    this._prevItem = ITEM.NONE;
    this._rubberTimer = rng.range(0, AI.rubberInterval); // stagger recomputes
    this._steerErr = 0;

    // Curvature probes (refreshed each update).
    this._curvMid = 0;
    this._curvFar = 0;
    this._curvBrakeAbs = 0;

    // World-scan results (refreshed each update).
    this._aheadKart = null;
    this._aheadDs = Infinity;
    this._behindClose = false;
    this._clusterCount = 0;
    this._shellAim = false;
    this._projectileInbound = false;

    // Scratch objects — zero per-update allocation.
    this._pt = { x: 0, y: 0, z: 0, heading: 0 };
    this._sw = {};
    this._cs = {};
  }

  /**
   * One fixed step of decision making. Writes kart.controls (+ aiSpeedMul).
   * @param {number} dt
   * @param {{
   *   karts: Array,
   *   items: object,
   *   raceState: string,
   *   elapsed: number,
   *   rubberBandTargetProgress?: number|null,
   *   rubberBandEligible?: boolean[],
   *   aiBaseSpeedEligible?: boolean[],
   * }} world
   */
  update(dt, world) {
    const kart = this.kart;
    const c = kart.controls;
    this._time += dt;
    c.useItem = false;
    c.lookBack = false;

    if (world.raceState === RACE_STATE.COUNTDOWN) {
      this._updateCountdown(world, c);
      return;
    }

    if (kart.finished) {
      kart.aiSpeedMul = 1;
      this._updateFinished(c);
      return;
    }

    this._updateRubberBand(dt, world);

    if (kart.incapacitated || kart.state === KART_STATE.BULLET) {
      c.throttle = 0;
      c.brake = 0;
      c.steer = 0;
      c.drift = false;
      this._blockedTime = 0;
      this._reverseTimer = 0;
      this._driftHold = false;
      return;
    }

    this._sampleCurvature();
    this._updateMistakes(dt);

    let steer = this._computeSteer(world);

    // --- Wall-stick recovery: back out with reversed steering ---------------
    if (this._reverseTimer > 0) {
      this._reverseTimer -= dt;
      c.throttle = 0;
      c.brake = 1; // brake at ~zero speed = reverse
      c.steer = clamp(-steer, -1, 1) * AI.reverseSteer;
      c.drift = false;
      this._driftHold = false;
      return;
    }
    if (kart.speed < AI.stuckSpeed && !kart.airborne) {
      this._blockedTime += dt;
      if (this._blockedTime > AI.stuckTime) {
        this._reverseTimer = AI.reverseTime;
        this._blockedTime = 0;
      }
    } else {
      this._blockedTime = 0;
    }

    // U-turn latch: facing away from the target, the pursuit error sits near
    // ±π and its sign chatters — commit to one direction until mostly aligned.
    const absErr = Math.abs(this._steerErr);
    if (this._uturnSign === 0 && absErr > AI.uturnEnter) {
      this._uturnSign = this._steerErr >= 0 ? 1 : -1;
    } else if (this._uturnSign !== 0 && absErr < AI.uturnExit) {
      this._uturnSign = 0;
    }
    if (this._uturnSign !== 0) {
      c.steer = this._uturnSign;
      c.throttle = 0.55;      // tight, controlled turnaround
      c.brake = 0;
      c.drift = false;
      this._driftHold = false;
      this._updateItems(dt, c);
      return;
    }

    // Apply steering mistakes (over/understeer) after the clean solution.
    if (this._mistakeLeft > 0) {
      if (this._mistakeKind === 0) steer *= AI.oversteerMul;
      else if (this._mistakeKind === 1) steer *= AI.understeerMul;
    }
    c.steer = clamp(steer, -1, 1);

    // --- Throttle / brake from the corner-speed budget -----------------------
    let curveSpeed = Math.sqrt(this._maxLatAccel / Math.max(this._curvBrakeAbs, 1e-4));
    if (this._mistakeLeft > 0 && this._mistakeKind === 2) {
      curveSpeed += AI.lateBrakeCurveSpeedBonus; // late braker
    }
    let throttle = 1;
    let brake = 0;
    if (kart.speed > curveSpeed * AI.brakeMargin) {
      throttle = 0;
      brake = 1;
    } else if (kart.speed > curveSpeed * AI.liftMargin) {
      throttle = AI.liftThrottle;
    }
    if (Math.abs(this._steerErr) > AI.bigErrorAngle) {
      throttle = Math.min(throttle, AI.bigErrorThrottle);
    }

    // --- Drift management -----------------------------------------------------
    this._updateDrift(dt, c);
    if (this._driftHold) {
      // A mini-turbo needs sustained speed; never brake mid-drift.
      brake = 0;
      throttle = Math.max(throttle, AI.driftThrottleFloor);
    }
    c.throttle = throttle;
    c.brake = brake;

    // --- Items ------------------------------------------------------------------
    this._updateItems(dt, c);
  }

  // ---------------------------------------------------------------------------
  // Phases
  // ---------------------------------------------------------------------------

  _updateCountdown(world, c) {
    c.steer = 0;
    c.brake = 0;
    c.drift = false;
    // Prefer an explicit countdown field when the director provides one;
    // otherwise infer time-to-GO from elapsed.
    const remaining = world.countdown != null
      ? world.countdown
      : RACE.countdownDuration - (world.elapsed ?? 0);
    c.throttle = remaining <= this._startPressAt ? 1 : 0;
  }

  /** Post-finish: release the controls and let engine braking stop the kart. */
  _updateFinished(c) {
    c.steer = 0;
    c.throttle = 0;
    c.brake = 0;
    c.drift = false;
    c.useItem = false;
    c.lookBack = false;
  }

  // ---------------------------------------------------------------------------
  // Steering
  // ---------------------------------------------------------------------------

  /** Probe curvature ahead; feeds braking and drift decisions. */
  _sampleCurvature() {
    const kart = this.kart;
    const spline = this.track.spline;
    const d = clamp(kart.speed * AI.brakeLookaheadMul, 5, 24);
    const near = spline.sampleAt(kart.s + 4, this._cs).curvature;
    const mid = spline.sampleAt(kart.s + d * 0.7, this._cs).curvature;
    const far = spline.sampleAt(kart.s + d * 1.25, this._cs).curvature;
    // Keep the signed value with the larger magnitude for drift direction.
    this._curvMid = Math.abs(near) > Math.abs(mid) ? near : mid;
    this._curvFar = far;
    // Braking uses a probe fan: a short-apex corner must not slip between two
    // sparse probes at speed, or the kart arrives 10 too fast and runs wide.
    let brakeAbs = Math.abs(near);
    for (let f = 0.35; f <= 1.3; f += 0.235) {
      const c = spline.sampleAt(kart.s + d * f, this._cs).curvature;
      const a = Math.abs(c);
      if (a > brakeAbs) brakeAbs = a;
    }
    this._curvBrakeAbs = brakeAbs;
  }

  /** Pure pursuit + avoidance. Returns the raw steer command (pre-mistake). */
  _computeSteer(world) {
    const kart = this.kart;
    const track = this.track;

    const lookAhead = clamp(
      kart.speed * AI.lookAheadSpeedMul, AI.lookAheadMin, AI.lookAheadMax,
    ) + this._lookJitter;
    const aheadS = kart.s + lookAhead;

    let targetLat = track.racingLineLateral(aheadS)
      + this.lateralBias
      + Math.sin(this._time * this._noiseFreq + this._noisePhase) * this._noiseAmp;

    targetLat = this._scanKarts(world, targetLat);
    const items = world.items;
    if (items) {
      this._projectileInbound = false;
      targetLat = this._avoidList(items.hazards, targetLat, false);
      targetLat = this._avoidList(items.projectiles, targetLat, true);
    } else {
      this._projectileInbound = false;
    }

    const maxLat = Math.max(0, track.halfWidthAt(aheadS) - AI.edgeMargin);
    targetLat = clamp(targetLat, -maxLat, maxLat);

    track.toWorld(aheadS, targetLat, this._pt);
    const desired = Math.atan2(this._pt.x - kart.x, this._pt.z - kart.z);
    const err = angleDelta(kart.yaw, desired);
    this._steerErr = err;
    return clamp(err * AI.steerGain, -1, 1);
  }

  /**
   * One pass over the other karts: gathers item intel (nearest ahead, close
   * behind, cluster, shell aim) and adjusts the lateral target to dodge — or,
   * for aggressive drivers with a speed advantage, to bump.
   */
  _scanKarts(world, targetLat) {
    const kart = this.kart;
    const len = this.track.length;
    this._aheadKart = null;
    this._aheadDs = Infinity;
    this._behindClose = false;
    this._clusterCount = 0;
    this._shellAim = false;

    const karts = world.karts;
    if (!karts) return targetLat;
    for (let i = 0; i < karts.length; i++) {
      const o = karts[i];
      if (o === kart) continue;
      const ds = loopDelta(kart.s, o.s, len);

      if (ds > 0 && ds < this._aheadDs) {
        this._aheadDs = ds;
        this._aheadKart = o;
      }
      if (ds < -1 && ds > -AI.behindCloseRange) this._behindClose = true;
      if (ds >= AI.clusterRange[0] && ds <= AI.clusterRange[1]) this._clusterCount++;

      // Green-shell aim: near, ahead, and within a narrow forward cone.
      if (ds > 1 && ds < AI.shellRange + 6 && !this._shellAim) {
        const dx = o.x - kart.x;
        const dz = o.z - kart.z;
        if (dx * dx + dz * dz < AI.shellRange * AI.shellRange) {
          const ang = angleDelta(kart.yaw, Math.atan2(dx, dz));
          if (Math.abs(ang) < AI.shellAngle) this._shellAim = true;
        }
      }

      // Lane conflict directly ahead.
      if (ds > 0 && ds < AI.kartAheadRange
        && Math.abs(o.lateral - kart.lateral) < AI.kartLateralRange) {
        const dangerous = o.starTimer > 0 || o.state === KART_STATE.BULLET;
        const canBump = !dangerous
          && this.aggression > AI.bumpAggression
          && kart.speed > o.speed + AI.bumpSpeedAdvantage;
        if (canBump) {
          targetLat = o.lateral; // line up the shove
        } else {
          const dir = sgnOr(targetLat - o.lateral,
            sgnOr(kart.lateral - o.lateral, o.lateral > 0 ? -1 : 1));
          targetLat = o.lateral + dir * AI.kartDodge;
        }
      }
    }
    return targetLat;
  }

  /**
   * Steer the lateral target away from hazards/projectiles in the lane ahead.
   * Also flags inbound projectiles (for defensive star use).
   */
  _avoidList(list, targetLat, isProjectiles) {
    if (!list || list.length === 0) return targetLat;
    const kart = this.kart;
    const track = this.track;
    const len = track.length;

    for (let i = 0; i < list.length; i++) {
      const h = list[i];
      if (isProjectiles && h.kind === ITEM.BLUE_SHELL) continue; // flies high, undodgeable
      let hs;
      let hl;
      if (h.s != null && h.lateral != null) {
        hs = h.s;
        hl = h.lateral;
      } else {
        const sw = track.sampleWorld(h.x, h.z, kart.s, this._sw);
        hs = sw.s;
        hl = sw.lateral;
      }
      const ds = loopDelta(kart.s, hs, len);

      if (isProjectiles && h.ownerIndex !== kart.index
        && ds < -0.5 && ds > -AI.inboundBehindRange
        && Math.abs(hl - kart.lateral) < AI.inboundLateralRange) {
        this._projectileInbound = true;
      }

      if (ds < -1 || ds > AI.hazardAheadRange) continue;
      if (Math.abs(hl - targetLat) > AI.hazardLateralRange) continue;
      const dir = sgnOr(targetLat - hl,
        sgnOr(kart.lateral - hl, hl > 0 ? -1 : 1));
      targetLat = hl + dir * AI.hazardDodge;
    }
    return targetLat;
  }

  // ---------------------------------------------------------------------------
  // Drift
  // ---------------------------------------------------------------------------

  _updateDrift(dt, c) {
    const kart = this.kart;
    if (this._driftCooldown > 0) this._driftCooldown -= dt;

    // Sustained-corner timer: how long has the road ahead been bendy?
    if (Math.abs(this._curvMid) > AI.driftStartCurv) this._cornerTime += dt;
    else this._cornerTime = 0;

    if (!this._driftHold) {
      if (this.canDrift
        && this._driftCooldown <= 0
        && this._cornerTime > AI.driftCornerTime
        && kart.speed > KART.driftMinSpeed + AI.driftSpeedMargin) {
        this._driftHold = true;
        this._driftSign = this._curvMid > 0 ? 1 : -1;
      }
    } else {
      const curv = this._curvMid;
      const mag = Math.abs(curv);
      const ended = mag < AI.driftEndCurv && Math.abs(this._curvFar) < AI.driftEndCurv;
      const flipped = mag > AI.driftEndCurv && (curv > 0 ? 1 : -1) !== this._driftSign;
      // Don't cash the mini-turbo mid-corner: the release boost would launch
      // the kart straight at the outside edge. Wait until the road opens up.
      const roadOpening = Math.abs(this._curvFar) < AI.driftEndCurv * 1.6;
      const tierReached = kart.driftTier >= this._targetTier && roadOpening;
      const tooSlow = kart.speed < KART.driftMinSpeed;
      // Over-rotation guard: pursuit is counter-steering hard against the
      // slide — the drift is now pushing us off line; bail before the grass.
      const overRotated = this._steerErr * this._driftSign < -AI.driftOverRotate;
      if (ended || flipped || tierReached || tooSlow || overRotated) {
        this._driftHold = false;
        this._driftCooldown = AI.driftCooldown;
      }
    }
    c.drift = this._driftHold;
  }

  // ---------------------------------------------------------------------------
  // Mistakes
  // ---------------------------------------------------------------------------

  _updateMistakes(dt) {
    this._mistakeTimer -= dt;
    if (this._mistakeTimer <= 0) {
      this._mistakeTimer = AI.mistakeWindow * this.rng.range(0.75, 1.25);
      if (this.rng.chance(this.mistakeRate)) {
        this._mistakeKind = this.rng.int(0, 2); // 0 oversteer, 1 understeer, 2 late brake
        this._mistakeLeft = this.rng.range(AI.mistakeDuration[0], AI.mistakeDuration[1]);
      }
    }
    if (this._mistakeLeft > 0) this._mistakeLeft -= dt;
  }

  // ---------------------------------------------------------------------------
  // Items
  // ---------------------------------------------------------------------------

  _updateItems(dt, c) {
    const kart = this.kart;

    // New pickup: humanising delay before the AI even considers using it.
    if (kart.item !== ITEM.NONE && this._prevItem === ITEM.NONE) {
      this._itemCooldown = this.rng.range(AI.itemCooldown[0], AI.itemCooldown[1]);
    }
    this._prevItem = kart.item;

    if (this._itemCooldown > 0) {
      this._itemCooldown -= dt;
      return;
    }
    if (kart.item === ITEM.NONE || kart.rouletteTimer > 0) return;

    let want = false;
    let urgent = false;
    switch (kart.item) {
      case ITEM.MUSHROOM:
      case ITEM.TRIPLE_MUSHROOM:
        // Burn boosts on straights.
        want = this._curvBrakeAbs < AI.mushroomMaxCurv;
        break;
      case ITEM.GREEN_SHELL:
        // Someone in the firing cone ahead, or drop back at a tailgater.
        want = this._shellAim || this._behindClose;
        break;
      case ITEM.RED_SHELL:
        // Only when there is someone to home on within range.
        want = kart.rank > 1 && this._aheadDs < AI.redShellGap;
        break;
      case ITEM.BANANA:
        // Lay traps before corners, defend the lead, or shake a tailgater.
        want = kart.rank === 1
          || this._behindClose
          || Math.abs(this._curvMid) > AI.bananaCornerCurv;
        break;
      case ITEM.BOMB:
        // Toss into a cluster ahead.
        want = this._clusterCount >= 2
          || (this._clusterCount >= 1 && this.aggression > 0.5);
        break;
      case ITEM.STAR:
        want = kart.rank >= AI.starPanicRank || this._projectileInbound;
        urgent = this._projectileInbound;
        break;
      case ITEM.LIGHTNING:
        want = kart.rank >= AI.comebackRank; // never waste it near the front
        urgent = want;
        break;
      case ITEM.BULLET:
        want = kart.rank >= AI.comebackRank;
        urgent = want;
        break;
      case ITEM.BLUE_SHELL:
        want = kart.rank >= AI.blueShellMinRank; // never when leading
        break;
      default:
        break;
    }
    if (!want) return;

    // Aggression gate: hesitant drivers sit on items longer.
    if (!urgent && !this.rng.chance(this._itemDrive)) {
      this._itemCooldown = AI.itemRetry;
      return;
    }
    c.useItem = true; // single-tick rising edge; ItemSystem detects it
    this._itemCooldown = this.rng.range(AI.itemUseCooldown[0], AI.itemUseCooldown[1]);
  }

  // ---------------------------------------------------------------------------
  // Rubber band
  // ---------------------------------------------------------------------------

  _updateRubberBand(dt, world) {
    this._rubberTimer -= dt;
    if (this._rubberTimer > 0) return;
    this._rubberTimer = AI.rubberInterval;

    const kart = this.kart;
    const baseSpeed = world.aiBaseSpeedEligible?.[kart.index] === false
      ? 1
      : this.difficulty.aiSpeed;
    if (world.rubberBandEligible?.[kart.index] === false) {
      // Human-seat takeover keeps the difficulty's base AI pace but receives
      // no gap-based catch-up. Local autopilot can explicitly opt out of both.
      kart.aiSpeedMul = clamp(baseSpeed, AI.rubberClamp[0], AI.rubberClamp[1]);
      return;
    }

    let mul = baseSpeed;
    const target = world.rubberBandTargetProgress;
    if (Number.isFinite(target)) {
      const gap = target - kart.progress; // > 0: we're behind
      const t = clamp(gap / AI.rubberGapRange, -1, 1);
      const rb = this.difficulty.rubberBand;
      mul = t >= 0
        ? 1 + AI.rubberUp * rb * t
        : 1 - AI.rubberDown * rb * -t;
      mul *= baseSpeed;
    }
    kart.aiSpeedMul = clamp(mul, AI.rubberClamp[0], AI.rubberClamp[1]);
  }
}
