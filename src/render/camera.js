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
      const g = this.track.sampleWorld(cam.position.x, cam.position.z, this._hintS, this._ground);
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
