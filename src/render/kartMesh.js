// KartVisual: chunky, toy-like kart built from THREE primitives.
// Reads kart state every frame (sync) and never writes back — presentation only.
// No DOM/THREE object creation at module import time: all shared assets are
// built lazily on first construction.

import * as THREE from 'three';
import { KART, ITEM_PHYSICS } from '../core/constants.js';
import { TAU, clamp, damp, smoothstep } from '../core/mathx.js';
import { resolveKartAppearance } from '../game/appearance.js';

// --- Visual layout (design values, derived from the physics body dims) ------
const BODY_L = KART.bodyLength;
const BODY_W = KART.bodyWidth;
const BODY_H = KART.bodyHeight;
const WHEEL_R = 0.31;
const WHEEL_W = 0.24;
const WHEEL_X = BODY_W * 0.5 + 0.10;
const WHEEL_Z = BODY_L * 0.37;
const BADGE_Y = 2.05;
const BADGE_FADE_NEAR = 16;
const BADGE_FADE_FAR = 48;
const SHRINK_LAMBDA = 8;    // how fast the lightning shrink eases in/out
const SCALE_LAMBDA = 18;    // squash/stretch tracking

// Shared (immutable) geometry + material singletons, created lazily so the
// module can be imported under Node without touching THREE object state.
let _shared = null;

function getShared() {
  if (_shared) return _shared;

  const flameOuter = new THREE.ConeGeometry(0.13, 0.62, 10);
  flameOuter.translate(0, 0.31, 0); // base at origin so scaling stretches backward
  const flameInner = new THREE.ConeGeometry(0.075, 0.40, 8);
  flameInner.translate(0, 0.20, 0);

  _shared = {
    geo: {
      chassis: new THREE.BoxGeometry(BODY_W * 0.78, BODY_H * 0.50, BODY_L * 0.74),
      nose: new THREE.BoxGeometry(BODY_W * 0.58, BODY_H * 0.36, BODY_L * 0.46),
      cowl: new THREE.BoxGeometry(BODY_W * 0.66, BODY_H * 0.44, BODY_L * 0.30),
      bumperF: new THREE.BoxGeometry(BODY_W * 0.72, BODY_H * 0.16, 0.12),
      bumperR: new THREE.BoxGeometry(BODY_W * 0.84, BODY_H * 0.18, 0.10),
      sidePod: new THREE.BoxGeometry(0.10, BODY_H * 0.22, BODY_L * 0.52),
      tire: new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, WHEEL_W, 14),
      hub: new THREE.CylinderGeometry(0.13, 0.13, WHEEL_W + 0.04, 8),
      head: new THREE.SphereGeometry(0.20, 14, 10),
      helmet: new THREE.SphereGeometry(0.245, 14, 10, 0, TAU, 0, Math.PI * 0.58),
      visor: new THREE.BoxGeometry(0.30, 0.11, 0.08),
      avatarMuzzle: new THREE.SphereGeometry(0.12, 12, 8),
      avatarEye: new THREE.SphereGeometry(0.035, 8, 6),
      avatarNose: new THREE.SphereGeometry(0.045, 8, 6),
      avatarEarRound: new THREE.SphereGeometry(0.09, 10, 8),
      avatarEarPoint: new THREE.ConeGeometry(0.10, 0.25, 4),
      avatarStripe: new THREE.BoxGeometry(0.025, 0.12, 0.025),
      avatarWhisker: new THREE.CylinderGeometry(0.008, 0.008, 0.19, 5),
      torso: new THREE.BoxGeometry(0.44, 0.32, 0.30),
      exhaust: new THREE.CylinderGeometry(0.06, 0.085, 0.34, 8),
      flameOuter,
      flameInner,
      brake: new THREE.BoxGeometry(BODY_W * 0.56, 0.10, 0.06),
    },
    mat: {
      tire: new THREE.MeshStandardMaterial({ color: 0x1a1a1e, roughness: 0.92, metalness: 0.05 }),
      hub: new THREE.MeshStandardMaterial({ color: 0xd9dade, roughness: 0.35, metalness: 0.65 }),
      skin: new THREE.MeshStandardMaterial({ color: 0xf2c79b, roughness: 0.7, metalness: 0.0 }),
      visor: new THREE.MeshStandardMaterial({ color: 0x18202c, roughness: 0.2, metalness: 0.35 }),
      exhaust: new THREE.MeshStandardMaterial({ color: 0x8f969e, roughness: 0.4, metalness: 0.8 }),
      flameOuter: new THREE.MeshBasicMaterial({
        color: 0xffa63b, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
      flameInner: new THREE.MeshBasicMaterial({
        color: 0xfff3bd, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    },
  };
  return _shared;
}

function addMesh(parent, geo, mat, x, y, z) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function addScaledMesh(parent, geo, mat, x, y, z, sx = 1, sy = sx, sz = sx) {
  const mesh = addMesh(parent, geo, mat, x, y, z);
  mesh.scale.set(sx, sy, sz);
  return mesh;
}

function buildAnimalDriver(parent, S, avatar, headY, headZ) {
  const headMat = new THREE.MeshStandardMaterial({
    color: avatar.headColor, roughness: 0.72, metalness: 0,
  });
  const muzzleMat = new THREE.MeshStandardMaterial({
    color: avatar.muzzleColor, roughness: 0.76, metalness: 0,
  });
  const detailMat = new THREE.MeshStandardMaterial({
    color: avatar.detailColor, roughness: 0.68, metalness: 0,
  });
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0x12131a, roughness: 0.42, metalness: 0.05,
  });
  const group = new THREE.Group();
  group.position.set(0, headY, headZ);
  parent.add(group);

  const head = addScaledMesh(group, S.geo.head, headMat, 0, 0, 0, 1.12, 1.02, 1.02);
  head.rotation.x = -0.03;

  const pointEars = ['cat', 'fox', 'tiger'].includes(avatar.kind);
  const roundEars = ['bear', 'panda', 'raccoon'].includes(avatar.kind);
  if (pointEars) {
    const spread = avatar.kind === 'fox' ? 0.155 : 0.14;
    const scale = avatar.kind === 'fox' ? 1.16 : 1;
    for (const side of [-1, 1]) {
      const ear = addScaledMesh(
        group, S.geo.avatarEarPoint, headMat,
        side * spread, 0.205, -0.005, 0.9 * scale, scale, 0.82 * scale,
      );
      ear.rotation.y = Math.PI / 4;
      ear.rotation.z = side * -0.08;
      addScaledMesh(
        group, S.geo.avatarEarPoint, muzzleMat,
        side * spread, 0.195, 0.018, 0.48 * scale, 0.58 * scale, 0.4 * scale,
      ).rotation.y = Math.PI / 4;
    }
  } else if (roundEars) {
    const earMaterial = avatar.kind === 'panda' ? detailMat : headMat;
    for (const side of [-1, 1]) {
      addScaledMesh(group, S.geo.avatarEarRound, earMaterial, side * 0.175, 0.15, -0.005, 0.95, 1, 0.72);
    }
  } else if (avatar.kind === 'rabbit') {
    for (const side of [-1, 1]) {
      addScaledMesh(group, S.geo.avatarEarRound, headMat, side * 0.09, 0.30, -0.015, 0.62, 1.75, 0.52);
      addScaledMesh(group, S.geo.avatarEarRound, detailMat, side * 0.09, 0.31, 0.035, 0.28, 1.25, 0.22);
    }
  } else if (avatar.kind === 'dog') {
    for (const side of [-1, 1]) {
      const ear = addScaledMesh(
        group, S.geo.avatarEarRound, detailMat,
        side * 0.205, 0.035, -0.015, 0.7, 1.45, 0.52,
      );
      ear.rotation.z = side * 0.32;
    }
  }

  if (avatar.kind === 'panda' || avatar.kind === 'raccoon') {
    for (const side of [-1, 1]) {
      const patch = addScaledMesh(
        group, S.geo.avatarMuzzle, detailMat,
        side * 0.073, 0.035, 0.172, 0.52, avatar.kind === 'raccoon' ? 0.58 : 0.72, 0.22,
      );
      patch.rotation.z = side * 0.18;
    }
  }

  addScaledMesh(group, S.geo.avatarMuzzle, muzzleMat, 0, -0.075, 0.17, 1.06, 0.72, 0.62);
  for (const side of [-1, 1]) {
    addMesh(group, S.geo.avatarEye, eyeMat, side * 0.073, 0.04, 0.202);
  }
  addScaledMesh(group, S.geo.avatarNose, detailMat, 0, -0.045, 0.247, 1, 0.72, 0.72);

  if (avatar.kind === 'tiger') {
    for (const [x, angle] of [[-0.075, -0.22], [0, 0], [0.075, 0.22]]) {
      const stripe = addMesh(group, S.geo.avatarStripe, detailMat, x, 0.14, 0.196);
      stripe.rotation.z = angle;
    }
  }

  if (['cat', 'fox', 'tiger', 'raccoon'].includes(avatar.kind)) {
    for (const side of [-1, 1]) {
      for (const y of [-0.055, -0.095]) {
        const whisker = addMesh(group, S.geo.avatarWhisker, detailMat, side * 0.13, y, 0.205);
        whisker.rotation.z = Math.PI / 2 + side * (y < -0.07 ? -0.12 : 0.12);
      }
    }
  }

  return [headMat, muzzleMat, detailMat, eyeMat];
}

/**
 * Build the kart group for one character. Shared by the in-race visual and
 * the character-select preview.
 * @returns {{group: THREE.Group, refs: object}}
 */
function buildKart(character, loadout = {}) {
  const S = getShared();
  const group = new THREE.Group();
  group.rotation.order = 'YXZ';
  const appearance = resolveKartAppearance(character, loadout);

  // Per-kart materials (star mode mutates these, so they cannot be shared).
  const bodyMat = new THREE.MeshStandardMaterial({
    color: appearance.color, metalness: 0.25, roughness: 0.55,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: appearance.accentColor, metalness: 0.25, roughness: 0.55,
  });
  const brakeMat = new THREE.MeshStandardMaterial({
    color: 0x3a0508, emissive: 0xff2a2a, emissiveIntensity: 0.15, roughness: 0.4,
  });

  // Body: main box + sloped nose + rear cowl.
  addMesh(group, S.geo.chassis, bodyMat, 0, BODY_H * 0.42, -BODY_L * 0.04);
  const nose = addMesh(group, S.geo.nose, bodyMat, 0, BODY_H * 0.40, BODY_L * 0.40);
  nose.rotation.x = 0.20;
  addMesh(group, S.geo.cowl, bodyMat, 0, BODY_H * 0.66, -BODY_L * 0.33);

  // Trim in the accent colour.
  addMesh(group, S.geo.bumperF, accentMat, 0, BODY_H * 0.26, BODY_L * 0.56);
  addMesh(group, S.geo.bumperR, accentMat, 0, BODY_H * 0.30, -BODY_L * 0.51);
  addMesh(group, S.geo.sidePod, accentMat, BODY_W * 0.44, BODY_H * 0.30, 0.02);
  addMesh(group, S.geo.sidePod, accentMat, -BODY_W * 0.44, BODY_H * 0.30, 0.02);

  // Brake light strip.
  addMesh(group, S.geo.brake, brakeMat, 0, BODY_H * 0.52, -BODY_L * 0.50);

  // Wheels: pivot (steering, front only) -> spin group (rolling) -> tire+hub.
  const frontPivots = [];
  const spinGroups = [];
  for (const [wx, wz] of [
    [-WHEEL_X, WHEEL_Z], [WHEEL_X, WHEEL_Z],
    [-WHEEL_X, -WHEEL_Z], [WHEEL_X, -WHEEL_Z],
  ]) {
    const pivot = new THREE.Group();
    pivot.position.set(wx, WHEEL_R, wz);
    group.add(pivot);
    const spin = new THREE.Group();
    pivot.add(spin);
    const tire = new THREE.Mesh(S.geo.tire, S.mat.tire);
    tire.rotation.z = Math.PI / 2;
    spin.add(tire);
    const hub = new THREE.Mesh(S.geo.hub, S.mat.hub);
    hub.rotation.z = Math.PI / 2;
    spin.add(hub);
    spinGroups.push(spin);
    if (wz > 0) frontPivots.push(pivot);
  }

  // Driver: single-player keeps the classic helmet, while online loadouts can
  // replace it with a procedural animal head.
  const headY = BODY_H * 0.72 + 0.34;
  addMesh(group, S.geo.torso, accentMat, 0, BODY_H * 0.72, -BODY_L * 0.10);
  const avatarMats = [];
  if (appearance.avatar) {
    avatarMats.push(...buildAnimalDriver(
      group, S, appearance.avatar, headY, -BODY_L * 0.10,
    ));
  } else {
    addMesh(group, S.geo.head, S.mat.skin, 0, headY, -BODY_L * 0.10);
    addMesh(group, S.geo.helmet, bodyMat, 0, headY + 0.015, -BODY_L * 0.10);
    addMesh(group, S.geo.visor, S.mat.visor, 0, headY + 0.02, -BODY_L * 0.10 + 0.17);
  }

  // Twin exhausts + boost flames (hidden until boosting).
  const flames = [];
  for (const ex of [-0.21, 0.21]) {
    const pipe = addMesh(group, S.geo.exhaust, S.mat.exhaust, ex, BODY_H * 0.74, -BODY_L * 0.46);
    pipe.rotation.x = Math.PI / 2 + 0.22;
    const flame = new THREE.Group();
    flame.position.set(ex, BODY_H * 0.74, -BODY_L * 0.54);
    flame.rotation.x = -Math.PI / 2 + 0.15; // cone apex points backward
    const outer = new THREE.Mesh(S.geo.flameOuter, S.mat.flameOuter);
    const inner = new THREE.Mesh(S.geo.flameInner, S.mat.flameInner);
    flame.add(outer, inner);
    flame.visible = false;
    group.add(flame);
    flames.push(flame);
  }

  // Drift spark anchors just outside the rear wheels, near the ground.
  const anchorL = new THREE.Object3D();
  anchorL.position.set(-(WHEEL_X + 0.12), 0.10, -BODY_L * 0.40);
  const anchorR = new THREE.Object3D();
  anchorR.position.set(WHEEL_X + 0.12, 0.10, -BODY_L * 0.40);
  group.add(anchorL, anchorR);

  group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  for (const f of flames) f.traverse((o) => { o.castShadow = false; });

  return {
    group,
    refs: {
      bodyMat, accentMat, brakeMat, avatarMats, appearance,
      frontPivots, spinGroups, flames, anchorL, anchorR,
    },
  };
}

// --- Name badge --------------------------------------------------------------

function roundedRectPath(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawNameBadge(ctx, name, accentHex) {
  const { width: w, height: h } = ctx.canvas;
  const accent = `#${(accentHex >>> 0).toString(16).padStart(6, '0')}`;
  ctx.clearRect(0, 0, w, h);
  ctx.beginPath();
  roundedRectPath(ctx, 5, 5, w - 10, h - 10, (h - 10) * 0.45);
  ctx.fillStyle = 'rgba(10, 14, 24, 0.72)';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = accent;
  ctx.stroke();
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${Math.floor(h * 0.48)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(name, w / 2, h / 2 + 2, w - 30);
}

function makeNameBadge(name, accentHex) {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 72;
  const ctx = canvas.getContext('2d');
  drawNameBadge(ctx, name, accentHex);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.center.set(0.5, 0);
  sprite.scale.set(2.8, 0.63, 1);
  sprite.castShadow = false;
  sprite.userData.nameBadge = { ctx, texture: tex, name: String(name), accentHex };
  return sprite;
}

function syncNameBadge(sprite, name, accentHex) {
  const badge = sprite?.userData?.nameBadge;
  if (!badge) return;
  const nextName = String(name || 'Racer');
  if (badge.name === nextName && badge.accentHex === accentHex) return;
  badge.name = nextName;
  badge.accentHex = accentHex;
  drawNameBadge(badge.ctx, nextName, accentHex);
  badge.texture.needsUpdate = true;
}

// --- KartVisual ----------------------------------------------------------------

export class KartVisual {
  /**
   * @param {import('../game/kart.js').Kart} kart
   * @param {THREE.Scene} scene
   */
  constructor(kart, scene) {
    this.kart = kart;
    this.scene = scene;

    const { group, refs } = buildKart(kart.character, {
      paintId: kart.paintId,
      avatarId: kart.avatarId,
    });
    this.group = group;
    this._refs = refs;

    // Star mode caches the original emissive so it can be restored exactly.
    this._starMats = [refs.bodyMat, refs.accentMat].map((m) => ({
      m,
      emissive: m.emissive.clone(),
      intensity: m.emissiveIntensity,
    }));
    this._starActive = false;

    // Floating name badge — every non-local kart, faded by camera distance.
    this.badge = null;
    if (!kart.isPlayer) {
      this.badge = makeNameBadge(kart.name, kart.accentColor);
      this.badge.position.y = BADGE_Y;
      group.add(this.badge);
    }

    this._time = 0;
    this._lastNow = 0;
    this._scale = 1;      // tracks kart.visualScale (squash)
    this._shrink = 1;     // tracks lightning shrink
    this._sparkOut = new THREE.Vector3(); // fallback scratch

    scene.add(group);
    this.snap();
  }

  /** Place the group at the kart transform without smoothing (spawn/reset). */
  snap() {
    const k = this.kart;
    this.group.position.set(k.x, k.y, k.z);
    this.group.rotation.set(k.visualPitch, k.yaw + k.visualYawOffset, k.visualRoll);
    this._scale = k.visualScale;
    this._shrink = k.shrinkTimer > 0 ? ITEM_PHYSICS.lightningScale : 1;
    this.group.scale.setScalar(this._scale * this._shrink);
  }

  /**
   * World position of a rear-wheel drift spark anchor.
   * @param {number} side -1 (or any negative) = left, otherwise right
   * @param {THREE.Vector3} outVec3
   */
  getSparkAnchor(side, outVec3 = this._sparkOut) {
    const anchor = side < 0 ? this._refs.anchorL : this._refs.anchorR;
    return anchor.getWorldPosition(outVec3);
  }

  /**
   * Per-frame sync from kart state. Accepts either `sync(cameraPos)` or the
   * ARCHITECTURE-listed `sync(kart, cameraPos)` — the kart passed must be the
   * one given at construction.
   * @param {object} [a] cameraPos {x,y,z} — or the kart itself
   * @param {object} [b] cameraPos when `a` is the kart
   */
  sync(a, b) {
    const isKartFirst = !!(a && a.controls);
    const kart = isKartFirst ? a : this.kart;
    const cameraPos = isKartFirst ? b : a;
    const g = this.group;
    const refs = this._refs;

    // Internal clock (sync gets no dt) — smoothing must stay framerate-safe.
    const now = (typeof performance !== 'undefined' && performance.now
      ? performance.now() : Date.now()) / 1000;
    const dt = this._lastNow > 0 ? clamp(now - this._lastNow, 0, 0.1) : 1 / 60;
    this._lastNow = now;
    this._time += dt;

    // Transform. Rotation order YXZ: yaw first, then pitch, then roll.
    g.position.set(kart.x, kart.y, kart.z);
    g.rotation.y = kart.yaw + kart.visualYawOffset;
    g.rotation.x = kart.visualPitch;
    g.rotation.z = kart.visualRoll;

    // Scale: squash (physics-driven) x lightning shrink (eased here).
    this._scale = damp(this._scale, kart.visualScale, SCALE_LAMBDA, dt);
    this._shrink = damp(
      this._shrink,
      kart.shrinkTimer > 0 ? ITEM_PHYSICS.lightningScale : 1,
      SHRINK_LAMBDA, dt,
    );
    g.scale.setScalar(this._scale * this._shrink);

    // Wheels.
    for (const spin of refs.spinGroups) spin.rotation.x = kart.wheelSpin;
    for (const pivot of refs.frontPivots) pivot.rotation.y = kart.steerAngle;

    // Boost flames: visible while boosting, flickering scale pulse.
    const boosting = kart.boostTimer > 0;
    if (boosting) {
      const pulse = 1
        + 0.22 * Math.sin(this._time * 42)
        + 0.10 * Math.sin(this._time * 71 + 1.7);
      const len = (0.8 + 0.45 * pulse) * (1 + 0.35 * Math.max(0, kart.boostPower - 1));
      for (const flame of refs.flames) {
        flame.visible = true;
        flame.scale.set(pulse, len, pulse);
      }
    } else if (refs.flames[0].visible) {
      for (const flame of refs.flames) flame.visible = false;
    }

    // Brake light.
    refs.brakeMat.emissiveIntensity = kart.controls.brake > 0 ? 2.4 : 0.15;

    // Star mode: fast HSL rainbow on the body materials, restored exactly after.
    if (kart.starTimer > 0) {
      this._starActive = true;
      const hue = (this._time * 2.6) % 1;
      for (let i = 0; i < this._starMats.length; i++) {
        const sm = this._starMats[i];
        sm.m.emissive.setHSL((hue + i * 0.15) % 1, 1, 0.5);
        sm.m.emissiveIntensity = 0.85;
      }
    } else if (this._starActive) {
      this._starActive = false;
      for (const sm of this._starMats) {
        sm.m.emissive.copy(sm.emissive);
        sm.m.emissiveIntensity = sm.intensity;
      }
    }

    // Post-hit invulnerability flicker (skipped while starring — star glows).
    g.visible = !(kart.invulnTimer > 0 && kart.starTimer <= 0)
      || Math.sin(this._time * 24 * Math.PI) > -0.35;

    // Name badge distance fade.
    if (this.badge && cameraPos) {
      syncNameBadge(this.badge, kart.name, kart.accentColor);
      const dx = cameraPos.x - kart.x;
      const dy = cameraPos.y - kart.y;
      const dz = cameraPos.z - kart.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const op = 1 - smoothstep(BADGE_FADE_NEAR, BADGE_FADE_FAR, dist);
      this.badge.material.opacity = op;
      this.badge.visible = op > 0.02;
    }
  }

  /** Remove from scene and free per-kart GPU resources (shared assets stay). */
  dispose() {
    this.scene.remove(this.group);
    this._refs.bodyMat.dispose();
    this._refs.accentMat.dispose();
    this._refs.brakeMat.dispose();
    for (const material of this._refs.avatarMats) material.dispose();
    if (this.badge) {
      this.badge.material.map?.dispose();
      this.badge.material.dispose();
    }
  }
}

/**
 * Static-pose kart for the character select screen. No Kart instance needed.
 * @param {object} character entry from characters.js
 * @returns {{group: THREE.Group}}
 */
export function makeKartPreview(character, loadout = {}) {
  const { group, refs } = buildKart(character, loadout);
  // A little showroom personality: wheels turned, hidden flames.
  for (const pivot of refs.frontPivots) pivot.rotation.y = 0.30;
  for (const spin of refs.spinGroups) spin.rotation.x = 0.7;
  for (const flame of refs.flames) flame.visible = false;
  return {
    group,
    appearance: refs.appearance,
    dispose() {
      refs.bodyMat.dispose();
      refs.accentMat.dispose();
      refs.brakeMat.dispose();
      for (const material of refs.avatarMats) material.dispose();
    },
  };
}
