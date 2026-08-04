// ChaseCamera: damped third-person follow with speed-FOV, boost pull-back,
// look-back flip, impact shake and a subtle speed bob. All per-frame math on
// preallocated vectors — zero allocation.

import * as THREE from 'three';
import { CAMERA } from '../core/constants.js';
import { clamp, clamp01, damp, TAU } from '../core/mathx.js';

const CAMERA_MIN_CLEARANCE = 1.2;  // keep the lens this far above the track
const SHAKE_MAX = 1.0;
const SHAKE_FREQ = 31.0;           // hash-noise sample rate (Hz-ish)
const BOB_AMPLITUDE = 0.045;
const BOB_FREQ = 9.0;

const FINISH_MIN_CLEARANCE = 1.2;
const FINISH_ENTRY_BLEND = 0.55;
const FINISH_CUT_BLEND = 0.18;
const FINISH_HERO_SHOT_DURATION = 1.0;
const FINISH_INTRO_DURATION = FINISH_HERO_SHOT_DURATION * 3;
const FINISH_SKIP_DELAY = 1.5;
const FINISH_COVERAGE_SHOT_DURATION = 3.0;
const FINISH_LINE_CAMERA_DISTANCE = 55.0;

/** Cheap deterministic hash → [-1, 1). No allocation, no Math.random. */
function hashNoise(n) {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

export class ChaseCamera {
  /** @param {THREE.PerspectiveCamera} camera */
  constructor(camera) {
    this.camera = camera;
    this.camera.fov = CAMERA.fov;
    this.camera.near = CAMERA.near;
    this.camera.far = CAMERA.far;
    this.camera.updateProjectionMatrix();

    this.track = null;

    this._pos = new THREE.Vector3();       // damped camera position
    this._look = new THREE.Vector3();      // damped look target
    this._desired = new THREE.Vector3();   // scratch: desired position
    this._desiredLook = new THREE.Vector3();
    this._fov = CAMERA.fov;
    this._appliedFov = CAMERA.fov;

    this._shake = 0;
    this._noiseT = 0;                       // advances only while shaking/moving
    this._lookBackSmooth = 0;               // 0 = forward, 1 = flipped

    // Scratch for track height queries (sampleWorld writes into it).
    this._ground = {};
    this._hintS = null;
  }

  /** Give the camera the track so it can stay above the road surface. */
  setTrack(track) {
    this.track = track;
    this._hintS = null;
  }

  /** Accumulate camera shake (impacts, explosions). Amount ~0.1..1. */
  addShake(amount) {
    this._shake = Math.min(SHAKE_MAX, this._shake + amount);
  }

  /** Remove transient gameplay motion before presenting a stable overlay. */
  settle() {
    this._shake = 0;
    this._lookBackSmooth = 0;
    this._apply();
  }

  /** Jump straight to the ideal pose for `kart` — call on spawn/respawn/reset. */
  snapTo(kart) {
    const fx = kart.forwardX;
    const fz = kart.forwardZ;
    this._pos.set(
      kart.x - fx * CAMERA.distance,
      kart.y + CAMERA.height,
      kart.z - fz * CAMERA.distance,
    );
    this._look.set(
      kart.x + fx * CAMERA.lookAhead,
      kart.y + CAMERA.lookHeight,
      kart.z + fz * CAMERA.lookAhead,
    );
    this._fov = CAMERA.fov;
    this._appliedFov = CAMERA.fov;
    this._shake = 0;
    this._lookBackSmooth = 0;
    this.camera.fov = CAMERA.fov;
    this.camera.updateProjectionMatrix();
    this._apply();
  }

  /**
   * @param {number} dt frame delta (seconds)
   * @param {import('../game/kart.js').Kart} kart
   * @param {boolean} [lookBack]
   */
  update(dt, kart, lookBack = false) {
    dt = clamp(dt, 0, 0.1);

    // Look-back: smooth the 180° flip so it snaps fast but not instantly.
    this._lookBackSmooth = damp(this._lookBackSmooth, lookBack ? 1 : 0, 18, dt);
    const flip = this._lookBackSmooth > 0.5 ? -1 : 1;

    const fx = kart.forwardX * flip;
    const fz = kart.forwardZ * flip;

    // Desired position: behind the kart, pulled further back while boosting.
    const boostFrac = kart.boostTimer > 0
      ? clamp01(kart.boostTimer / 0.5) * clamp01((kart.boostPower - 1) / 0.5)
      : 0;
    const dist = CAMERA.distance * (1 + (CAMERA.boostPullback - 1) * boostFrac);
    this._desired.set(
      kart.x - fx * dist,
      kart.y + CAMERA.height,
      kart.z - fz * dist,
    );

    // Damp position (frame-rate independent).
    const pk = 1 - Math.exp(-CAMERA.positionLambda * dt);
    this._pos.lerp(this._desired, pk);

    // Desired look target: ahead of the kart.
    this._desiredLook.set(
      kart.x + fx * CAMERA.lookAhead,
      kart.y + CAMERA.lookHeight,
      kart.z + fz * CAMERA.lookAhead,
    );
    const rk = 1 - Math.exp(-CAMERA.rotationLambda * dt);
    this._look.lerp(this._desiredLook, rk);

    // FOV: widens near top speed, extra kick while boosting.
    const speedKick = CAMERA.fovSpeedBoost
      * clamp(kart.speedRatio - 0.55, 0, 0.45) / 0.45;
    const boostKick = 6 * boostFrac;
    const targetFov = CAMERA.fov + speedKick + boostKick;
    this._fov = damp(this._fov, targetFov, CAMERA.fovLambda, dt);
    if (Math.abs(this._fov - this._appliedFov) > 0.01) {
      this._appliedFov = this._fov;
      this.camera.fov = this._fov;
      this.camera.updateProjectionMatrix();
    }

    // Shake decay + idle speed bob.
    this._shake = Math.max(0, this._shake - this._shake * CAMERA.shakeDecay * dt);
    if (this._shake < 0.002) this._shake = 0;
    this._noiseT += dt * SHAKE_FREQ;

    this._apply(kart);
  }

  /** Write pos/lookAt (plus shake/bob/ground clamp) into the THREE camera. */
  _apply(kart = null) {
    const cam = this.camera;
    cam.position.copy(this._pos);

    // Ground clamp: never dip the lens below track height + clearance.
    if (this.track) {
      const g = this.track.sampleWorld(
        cam.position.x, cam.position.z, this._hintS, this._ground, cam.position.y,
      );
      this._hintS = g.s;
      const minY = g.height + CAMERA_MIN_CLEARANCE;
      if (cam.position.y < minY) cam.position.y = minY;
    }

    // Shake: hash-noise offsets, three decorrelated channels.
    if (this._shake > 0) {
      const t = this._noiseT;
      const a = this._shake * 0.28;
      cam.position.x += hashNoise(t) * a;
      cam.position.y += hashNoise(t + 57.1) * a * 0.7;
      cam.position.z += hashNoise(t + 113.7) * a;
    }

    // Tiny vertical bob at high speed — sells velocity without nausea.
    if (kart && !kart.airborne) {
      const bob = clamp01((kart.speedRatio - 0.6) / 0.4);
      if (bob > 0) {
        cam.position.y += Math.sin((this._noiseT / SHAKE_FREQ) * BOB_FREQ * TAU)
          * BOB_AMPLITUDE * bob;
      }
    }

    cam.lookAt(this._look);
  }
}

/**
 * Presentation-only camera director used after the local player crosses the
 * finish line. It never mutates karts or race state.
 */
export class FinishCameraDirector {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {import('../track/track.js').Track} track
   * @param {{reducedMotion?: boolean}} [options]
   */
  constructor(camera, track, options = {}) {
    this.camera = camera;
    this.track = track;
    this.reducedMotion = options.reducedMotion ?? Boolean(
      typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    );

    this.active = false;
    this.elapsed = 0;
    this.introComplete = false;

    this._player = null;
    this._target = null;
    this._shot = '';
    this._coverageShot = -1;
    this._coverageMode = '';
    this._blendElapsed = 0;
    this._blendDuration = FINISH_ENTRY_BLEND;

    this._pos = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._desiredLook = new THREE.Vector3();
    this._fromPos = new THREE.Vector3();
    this._fromLook = new THREE.Vector3();
    this._forward = new THREE.Vector3();
    this._finishLine = {};
    this._ground = {};
    this._hintS = null;

    this._fov = camera.fov;
    this._fromFov = camera.fov;
  }

  get canSkip() {
    return this.active && !this.introComplete && this.elapsed >= FINISH_SKIP_DELAY;
  }

  /** Capture the live chase-camera pose and begin the hero sequence once. */
  begin(player) {
    if (this.active || !player) return false;
    this.active = true;
    this.elapsed = 0;
    this.introComplete = false;
    this._player = player;
    this._target = player;
    this._shot = '';
    this._coverageShot = -1;
    this._coverageMode = '';
    this._hintS = Number.isFinite(player.s) ? player.s : null;

    this._pos.copy(this.camera.position);
    this.camera.getWorldDirection(this._forward);
    this._look.copy(this.camera.position).addScaledVector(this._forward, 10);
    this._fov = this.camera.fov;
    this._switchShot(this.reducedMotion ? 'reduced-hero' : 'hero-rear', FINISH_ENTRY_BLEND);
    return true;
  }

  /** Skip only the hero intro; results remain gated by authoritative race state. */
  skipIntro() {
    if (!this.canSkip) return false;
    this.elapsed = Math.max(this.elapsed, FINISH_INTRO_DURATION);
    this.introComplete = true;
    this._coverageShot = -1;
    this._coverageMode = '';
    return true;
  }

  /**
   * @param {number} dt seconds
   * @param {{player: Object, standings: Object[], laps: number}} context
   */
  update(dt, { player, standings, laps }) {
    if (!this.active) return;
    dt = clamp(dt, 0, 0.1);
    const previousElapsed = this.elapsed;
    this.elapsed += dt;
    if (!this.introComplete && this.elapsed >= FINISH_INTRO_DURATION) {
      this.introComplete = true;
    }

    this._player = player || this._player;
    const rows = Array.isArray(standings) ? standings : [];
    const shot = this._resolveShot(previousElapsed, rows, laps);
    if (shot !== this._shot) {
      const blend = this.reducedMotion ? 1.0 : FINISH_CUT_BLEND;
      this._switchShot(shot, this._shot ? blend : FINISH_ENTRY_BLEND);
    }

    this._composeShot(shot, rows, laps);
    this._apply(dt);
  }

  /** Clear director state without moving the current camera pose. */
  reset() {
    this.active = false;
    this.elapsed = 0;
    this.introComplete = false;
    this._player = null;
    this._target = null;
    this._shot = '';
    this._coverageShot = -1;
    this._coverageMode = '';
    this._blendElapsed = 0;
    this._hintS = null;
  }

  _resolveShot(previousElapsed, standings, laps) {
    if (this.reducedMotion) {
      if (!this.introComplete) return 'reduced-hero';
      if (this._shot !== 'reduced-coverage') this._target = this._selectTarget(standings);
      else if (!this._target || this._target.finished) this._target = this._selectTarget(standings);
      if (Number.isFinite(this._target?.s)) this._hintS = this._target.s;
      return 'reduced-coverage';
    }

    if (!this.introComplete) {
      if (this.elapsed < FINISH_HERO_SHOT_DURATION) return 'hero-rear';
      if (this.elapsed < FINISH_HERO_SHOT_DURATION * 2) return 'hero-front';
      return 'hero-crane';
    }

    const coverageElapsed = Math.max(0, this.elapsed - FINISH_INTRO_DURATION);
    const coverageShot = Math.floor(coverageElapsed / FINISH_COVERAGE_SHOT_DURATION);
    if (coverageShot !== this._coverageShot || previousElapsed < FINISH_INTRO_DURATION) {
      this._coverageShot = coverageShot;
      this._target = this._selectTarget(standings);
      if (Number.isFinite(this._target?.s)) this._hintS = this._target.s;
      if (!this._target || this._target === this._player && this._target.finished) {
        this._coverageMode = 'hero-hold';
      } else if (coverageShot % 2 === 1) {
        this._coverageMode = 'coverage-wide';
      } else {
        this._coverageMode = this._remainingDistance(this._target, laps) <= FINISH_LINE_CAMERA_DISTANCE
          ? 'coverage-finish'
          : 'coverage-follow';
      }
    }
    return this._coverageMode;
  }

  _selectTarget(standings) {
    for (const kart of standings) {
      if (kart && !kart.finished) return kart;
    }
    return this._player;
  }

  _remainingDistance(kart, laps) {
    if (!kart || !Number.isFinite(kart.progress) || !Number.isFinite(laps)) return Infinity;
    return Math.max(0, laps * this.track.length - kart.progress);
  }

  _switchShot(shot, duration) {
    this._fromPos.copy(this.camera.position);
    this._fromLook.copy(this._look);
    this._fromFov = this.camera.fov;
    this._blendElapsed = 0;
    this._blendDuration = Math.max(0.001, duration);
    this._shot = shot;
  }

  _composeShot(shot) {
    const kart = shot.startsWith('hero') || shot === 'reduced-hero'
      ? this._player
      : (this._target || this._player);
    if (!kart) return;

    const fx = Number.isFinite(kart.forwardX) ? kart.forwardX : Math.sin(kart.yaw || 0);
    const fz = Number.isFinite(kart.forwardZ) ? kart.forwardZ : Math.cos(kart.yaw || 0);
    const rx = Number.isFinite(kart.rightX) ? kart.rightX : fz;
    const rz = Number.isFinite(kart.rightZ) ? kart.rightZ : -fx;
    const side = (kart.index ?? 0) % 2 === 0 ? 1 : -1;

    if (shot === 'hero-rear') {
      this._setLocalPose(kart, fx, fz, rx, rz, -8.4, side * 3.1, 2.65, 3.4, 1.05, 58);
      return;
    }
    if (shot === 'hero-front') {
      this._setLocalPose(kart, fx, fz, rx, rz, 9.2, -side * 3.8, 2.25, 0.8, 1.0, 50);
      return;
    }
    if (shot === 'hero-crane' || shot === 'hero-hold') {
      const p = shot === 'hero-hold' ? 1 : clamp01(
        (this.elapsed - FINISH_HERO_SHOT_DURATION * 2) / FINISH_HERO_SHOT_DURATION,
      );
      const angle = -0.78 + p * 1.56;
      const radius = 10.8;
      const along = -Math.cos(angle) * radius;
      const lateral = Math.sin(angle) * radius * side;
      this._setLocalPose(kart, fx, fz, rx, rz, along, lateral,
        6.8 + Math.sin(p * Math.PI) * 1.5, 1.8, 1.15, 55);
      return;
    }
    if (shot === 'coverage-finish') {
      const lateral = side * (this.track.halfWidthAt(0) + 5.5);
      this.track.toWorld(0, lateral, this._finishLine);
      this._desired.set(this._finishLine.x, this._finishLine.y + 3.2, this._finishLine.z);
      this._desiredLook.set(kart.x + fx * 1.2, kart.y + 1.05, kart.z + fz * 1.2);
      this._desiredFov = 46;
      this._clampDesiredToGround();
      return;
    }
    if (shot === 'coverage-wide') {
      this._setLocalPose(kart, fx, fz, rx, rz, -14.0, -side * 7.2, 9.4, 3.2, 1.1, 56);
      return;
    }

    // coverage-follow and both reduced-motion shots use stable elevated angles.
    const reduced = shot.startsWith('reduced');
    this._setLocalPose(kart, fx, fz, rx, rz,
      reduced ? -10.5 : -10.2,
      side * (reduced ? 4.2 : 5.0),
      reduced ? 5.0 : 3.2,
      reduced ? 2.2 : 3.8,
      1.1,
      reduced ? 56 : 48);
  }

  _setLocalPose(kart, fx, fz, rx, rz, along, lateral, height, lookAhead, lookHeight, fov) {
    this._desired.set(
      kart.x + fx * along + rx * lateral,
      kart.y + height,
      kart.z + fz * along + rz * lateral,
    );
    this._desiredLook.set(
      kart.x + fx * lookAhead,
      kart.y + lookHeight,
      kart.z + fz * lookAhead,
    );
    this._desiredFov = fov;
    this._clampDesiredToGround();
  }

  _clampDesiredToGround() {
    if (!this.track) return;
    const g = this.track.sampleWorld(
      this._desired.x, this._desired.z, this._hintS, this._ground, this._desired.y,
    );
    this._hintS = g.s;
    this._desired.y = Math.max(this._desired.y, g.height + FINISH_MIN_CLEARANCE);
  }

  _apply(dt) {
    this._blendElapsed += dt;
    const raw = clamp01(this._blendElapsed / this._blendDuration);
    const blend = raw * raw * (3 - 2 * raw);

    if (raw < 1) {
      this._pos.lerpVectors(this._fromPos, this._desired, blend);
      this._look.lerpVectors(this._fromLook, this._desiredLook, blend);
      this._fov = this._fromFov + (this._desiredFov - this._fromFov) * blend;
    } else {
      const lambda = this.reducedMotion ? 3.2 : 6.0;
      const k = 1 - Math.exp(-lambda * dt);
      this._pos.lerp(this._desired, k);
      this._look.lerp(this._desiredLook, k);
      this._fov = damp(this._fov, this._desiredFov, 5.0, dt);
    }

    if (this.track) {
      const g = this.track.sampleWorld(
        this._pos.x, this._pos.z, this._hintS, this._ground, this._pos.y,
      );
      this._hintS = g.s;
      this._pos.y = Math.max(this._pos.y, g.height + FINISH_MIN_CLEARANCE);
    }

    this.camera.position.copy(this._pos);
    this.camera.lookAt(this._look);
    if (Math.abs(this.camera.fov - this._fov) > 0.01) {
      this.camera.fov = this._fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
