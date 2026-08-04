// Effects: every particle system in the game, fully pooled.
// All buffers are preallocated in the constructor; spawning and updating
// never allocate. Dead particles are compacted with swap-with-last so the
// draw range / instance count is always a tight prefix.
//
// No THREE object creation at module import time — everything (including the
// shared round-sprite CanvasTexture) is built lazily inside the constructor.

import * as THREE from 'three';
import { GRAVITY } from '../core/constants.js';
import { TAU } from '../core/mathx.js';

// Pool capacities.
const SPARK_CAP = 500;
const DUST_CAP = 320;
const CONFETTI_CAP = 500;
const SHARD_CAP = 256;
const SMOKE_CAP = 28;
const FIREBALL_CAP = 8;
const RING_CAP = 8;

const CONFETTI_COLORS = [0xff4f6d, 0xffd23b, 0x3bd66f, 0x3fa8ff, 0xc46bff, 0xff8c3b, 0xffffff];
const SHARD_COLORS = [0xffd23b, 0x3fa8ff, 0xff4f6d, 0x7fffd4, 0xffffff];

let _dotTexture = null;

/** Soft round sprite used by every Points pool. Lazily built once. */
function getDotTexture() {
  if (_dotTexture) return _dotTexture;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.85)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  _dotTexture = new THREE.CanvasTexture(canvas);
  return _dotTexture;
}

// ---------------------------------------------------------------------------
// PointPool: THREE.Points with per-particle position/color, velocity, life.
// Color fades to black over life (with additive blending that reads as a
// clean alpha fade without needing a per-particle opacity attribute).
// ---------------------------------------------------------------------------

class PointPool {
  constructor(scene, capacity, { size, blending, opacity = 1, gravity = 0, drag = 0 }) {
    this.capacity = capacity;
    this.alive = 0;
    this.gravity = gravity;
    this.drag = drag;

    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.baseCol = new Float32Array(capacity * 3);

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    this.colAttr = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    geo.setDrawRange(0, 0);

    const mat = new THREE.PointsMaterial({
      size,
      map: getDotTexture(),
      vertexColors: true,
      transparent: true,
      opacity,
      blending,
      depthWrite: false,
      sizeAttenuation: true,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  /** @returns particle index, or -1 when the pool is saturated. */
  spawn(x, y, z, vx, vy, vz, r, g, b, life) {
    if (this.alive >= this.capacity) return -1;
    const i = this.alive++;
    const i3 = i * 3;
    const pos = this.posAttr.array;
    pos[i3] = x; pos[i3 + 1] = y; pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.baseCol[i3] = r; this.baseCol[i3 + 1] = g; this.baseCol[i3 + 2] = b;
    this.life[i] = life;
    this.maxLife[i] = life;
    return i;
  }

  update(dt) {
    if (this.alive === 0) return;
    const pos = this.posAttr.array;
    const col = this.colAttr.array;
    const { vel, life, maxLife, baseCol } = this;
    const dragMul = this.drag > 0 ? Math.exp(-this.drag * dt) : 1;
    const gdt = this.gravity * dt;

    for (let i = 0; i < this.alive; i++) {
      life[i] -= dt;
      if (life[i] <= 0) {
        // Swap-with-last compaction.
        const last = --this.alive;
        if (i !== last) {
          const a = i * 3, b = last * 3;
          pos[a] = pos[b]; pos[a + 1] = pos[b + 1]; pos[a + 2] = pos[b + 2];
          vel[a] = vel[b]; vel[a + 1] = vel[b + 1]; vel[a + 2] = vel[b + 2];
          baseCol[a] = baseCol[b]; baseCol[a + 1] = baseCol[b + 1]; baseCol[a + 2] = baseCol[b + 2];
          life[i] = life[last];
          maxLife[i] = maxLife[last];
          i--;
        }
        continue;
      }
      const i3 = i * 3;
      vel[i3] *= dragMul;
      vel[i3 + 1] = vel[i3 + 1] * dragMul - gdt;
      vel[i3 + 2] *= dragMul;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;
      const fade = life[i] / maxLife[i];
      col[i3] = baseCol[i3] * fade;
      col[i3 + 1] = baseCol[i3 + 1] * fade;
      col[i3 + 2] = baseCol[i3 + 2] * fade;
    }

    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.points.geometry.setDrawRange(0, this.alive);
  }
}

// ---------------------------------------------------------------------------
// InstancedPool: tumbling solid bits (item box shards, confetti quads).
// ---------------------------------------------------------------------------

class InstancedPool {
  constructor(scene, capacity, geometry, material, { gravity, drag = 0, shrinkTail = 0.3 }) {
    this.capacity = capacity;
    this.alive = 0;
    this.gravity = gravity;
    this.drag = drag;
    this.shrinkTail = shrinkTail; // fraction of life over which scale → 0

    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.rot = new Float32Array(capacity * 3);
    this.angVel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.size = new Float32Array(capacity);

    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.count = 0;
    // Force allocation of the per-instance color buffer.
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));

    this._dummy = new THREE.Object3D();
    scene.add(this.mesh);
  }

  spawn(x, y, z, vx, vy, vz, colorHex, size, life, scratchColor) {
    if (this.alive >= this.capacity) return;
    const i = this.alive++;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.rot[i3] = Math.random() * TAU;
    this.rot[i3 + 1] = Math.random() * TAU;
    this.rot[i3 + 2] = Math.random() * TAU;
    this.angVel[i3] = (Math.random() - 0.5) * 12;
    this.angVel[i3 + 1] = (Math.random() - 0.5) * 12;
    this.angVel[i3 + 2] = (Math.random() - 0.5) * 12;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    scratchColor.setHex(colorHex);
    this.mesh.setColorAt(i, scratchColor);
    this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt) {
    if (this.alive === 0) {
      if (this.mesh.count !== 0) this.mesh.count = 0;
      return;
    }
    const { pos, vel, rot, angVel, life, maxLife, size } = this;
    const colArr = this.mesh.instanceColor.array;
    const dragMul = this.drag > 0 ? Math.exp(-this.drag * dt) : 1;
    const gdt = this.gravity * dt;
    const dummy = this._dummy;

    for (let i = 0; i < this.alive; i++) {
      life[i] -= dt;
      if (life[i] <= 0) {
        const last = --this.alive;
        if (i !== last) {
          const a = i * 3, b = last * 3;
          for (let k = 0; k < 3; k++) {
            pos[a + k] = pos[b + k];
            vel[a + k] = vel[b + k];
            rot[a + k] = rot[b + k];
            angVel[a + k] = angVel[b + k];
            colArr[a + k] = colArr[b + k];
          }
          life[i] = life[last];
          maxLife[i] = maxLife[last];
          size[i] = size[last];
          this.mesh.instanceColor.needsUpdate = true;
          i--;
        }
        continue;
      }
      const i3 = i * 3;
      vel[i3] *= dragMul;
      vel[i3 + 1] = vel[i3 + 1] * dragMul - gdt;
      vel[i3 + 2] *= dragMul;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;
      rot[i3] += angVel[i3] * dt;
      rot[i3 + 1] += angVel[i3 + 1] * dt;
      rot[i3 + 2] += angVel[i3 + 2] * dt;

      const t = life[i] / maxLife[i];
      const s = size[i] * (t < this.shrinkTail ? t / this.shrinkTail : 1);
      dummy.position.set(pos[i3], pos[i3 + 1], pos[i3 + 2]);
      dummy.rotation.set(rot[i3], rot[i3 + 1], rot[i3 + 2]);
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      this.mesh.setMatrixAt(i, dummy.matrix);
    }

    this.mesh.count = this.alive;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// FlarePool: a handful of reusable sprites/meshes that scale up and fade out
// (fireball flashes, smoke puffs, shockwave rings). Each slot owns its
// material so opacity is independent.
// ---------------------------------------------------------------------------

class FlarePool {
  /**
   * @param {(i:number) => THREE.Object3D} makeSlot builds one slot object
   *   (added to the scene, starts invisible, material must be transparent)
   */
  constructor(scene, capacity, makeSlot, behavior) {
    this.capacity = capacity;
    this.alive = 0;
    this.behavior = behavior; // {startScale, endScale, startOpacity, riseSpeed}
    this.slots = [];
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    for (let i = 0; i < capacity; i++) {
      const obj = makeSlot(i);
      obj.visible = false;
      scene.add(obj);
      this.slots.push(obj);
    }
    this._cursor = 0;
  }

  spawn(x, y, z, life, scaleMul = 1) {
    // Round-robin: recycle the oldest slot when saturated.
    const i = this._cursor;
    this._cursor = (this._cursor + 1) % this.capacity;
    const obj = this.slots[i];
    obj.visible = true;
    obj.position.set(x, y, z);
    obj.userData.scaleMul = scaleMul;
    this.life[i] = life;
    this.maxLife[i] = life;
  }

  update(dt) {
    const b = this.behavior;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const obj = this.slots[i];
      if (this.life[i] <= 0) {
        obj.visible = false;
        continue;
      }
      const t = 1 - this.life[i] / this.maxLife[i]; // 0 → 1 over life
      const mul = obj.userData.scaleMul || 1;
      const scale = (b.startScale + (b.endScale - b.startScale) * t) * mul;
      obj.scale.setScalar(scale);
      obj.material.opacity = b.startOpacity * (1 - t) * (1 - t);
      if (b.riseSpeed) obj.position.y += b.riseSpeed * dt;
    }
  }
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

export class Effects {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this.scene = scene;
    this._color = new THREE.Color();

    // Sparks: drift trails + impact bursts. Bright, additive, gravity-bound.
    this.sparks = new PointPool(scene, SPARK_CAP, {
      size: 0.22, blending: THREE.AdditiveBlending, gravity: GRAVITY * 0.55, drag: 1.2,
    });

    // Dust: soft offroad haze. Additive at low intensity so death needs no alpha pop.
    this.dustPool = new PointPool(scene, DUST_CAP, {
      size: 1.1, blending: THREE.AdditiveBlending, opacity: 0.5, gravity: -0.4, drag: 2.2,
    });

    // Item box shards: little glass boxes.
    this.shards = new InstancedPool(
      scene, SHARD_CAP,
      new THREE.BoxGeometry(0.16, 0.16, 0.16),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9 }),
      { gravity: GRAVITY * 0.8, drag: 0.4, shrinkTail: 0.35 },
    );

    // Confetti: falling coloured quads.
    this.confetti = new InstancedPool(
      scene, CONFETTI_CAP,
      new THREE.PlaneGeometry(0.16, 0.24),
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
      { gravity: 3.2, drag: 1.6, shrinkTail: 0.18 },
    );

    // One-shot flares.
    const dot = getDotTexture();
    this.fireballs = new FlarePool(scene, FIREBALL_CAP, () => {
      const mat = new THREE.SpriteMaterial({
        map: dot, color: 0xffb347, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      return new THREE.Sprite(mat);
    }, { startScale: 1.6, endScale: 7.5, startOpacity: 1, riseSpeed: 0 });

    this.smoke = new FlarePool(scene, SMOKE_CAP, () => {
      const mat = new THREE.SpriteMaterial({
        map: dot, color: 0x55504c, transparent: true, depthWrite: false,
      });
      return new THREE.Sprite(mat);
    }, { startScale: 1.1, endScale: 3.6, startOpacity: 0.55, riseSpeed: 1.4 });

    const ringGeo = new THREE.RingGeometry(0.72, 1.0, 40);
    this.rings = new FlarePool(scene, RING_CAP, () => {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffd9a0, transparent: true, side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const mesh = new THREE.Mesh(ringGeo, mat);
      mesh.rotation.x = -Math.PI / 2;
      return mesh;
    }, { startScale: 0.6, endScale: 9.5, startOpacity: 0.85, riseSpeed: 0 });
  }

  // -------------------------------------------------------------------------
  // Emitters (names + signatures frozen — called by main.js)
  // -------------------------------------------------------------------------

  /** Continuous drift spark emitter; call once per frame per active anchor. */
  driftSparks(x, y, z, color) {
    const c = this._color.setHex(color);
    for (let n = 0; n < 2; n++) {
      const a = Math.random() * TAU;
      const spread = 1.4 + Math.random() * 2.2;
      this.sparks.spawn(
        x, y + 0.05, z,
        Math.cos(a) * spread,
        1.8 + Math.random() * 2.6,
        Math.sin(a) * spread,
        c.r * 1.6, c.g * 1.6, c.b * 1.6, // overbright for additive pop
        0.22 + Math.random() * 0.2,
      );
    }
  }

  /** Offroad dust; call once per frame while a kart is kicking up dirt. */
  dust(x, y, z) {
    const a = Math.random() * TAU;
    const spread = 0.5 + Math.random() * 0.9;
    // Deliberately dim: additive haze, not glow.
    this.dustPool.spawn(
      x + Math.cos(a) * 0.4, y + 0.1, z + Math.sin(a) * 0.4,
      Math.cos(a) * spread, 0.7 + Math.random() * 0.8, Math.sin(a) * spread,
      0.16, 0.13, 0.10,
      0.5 + Math.random() * 0.45,
    );
  }

  /** Blue-white offroad spray for snow themes. */
  snowSpray(x, y, z) {
    const a = Math.random() * TAU;
    const spread = 0.65 + Math.random() * 1.05;
    this.dustPool.spawn(
      x + Math.cos(a) * 0.42, y + 0.12, z + Math.sin(a) * 0.42,
      Math.cos(a) * spread, 0.85 + Math.random() * 1.0, Math.sin(a) * spread,
      0.34, 0.48, 0.58,
      0.5 + Math.random() * 0.45,
    );
  }

  /** Radial impact burst (collisions, shell hits). */
  burst(x, y, z, color, count = 12) {
    const c = this._color.setHex(color);
    for (let n = 0; n < count; n++) {
      const a = Math.random() * TAU;
      const el = Math.random() * 0.9;
      const speed = 3.5 + Math.random() * 5.5;
      const horiz = Math.cos(el) * speed;
      this.sparks.spawn(
        x, y + 0.3, z,
        Math.cos(a) * horiz,
        Math.sin(el) * speed + 1.5,
        Math.sin(a) * horiz,
        c.r * 1.5, c.g * 1.5, c.b * 1.5,
        0.3 + Math.random() * 0.35,
      );
    }
  }

  /** Bomb / blue shell: fireball flash + smoke puffs + shockwave ring + sparks. */
  explosion(x, y, z) {
    this.fireballs.spawn(x, y + 1.2, z, 0.4);
    this.rings.spawn(x, y + 0.15, z, 0.55);
    for (let n = 0; n < 7; n++) {
      const a = (n / 7) * TAU + Math.random() * 0.7;
      const r = 0.4 + Math.random() * 1.1;
      this.smoke.spawn(
        x + Math.cos(a) * r,
        y + 0.6 + Math.random() * 1.2,
        z + Math.sin(a) * r,
        1.1 + Math.random() * 0.6,
        0.8 + Math.random() * 0.5,
      );
    }
    this.burst(x, y + 0.6, z, 0xffa040, 22);
  }

  /** Item box pickup: coloured shards + a small glint. */
  shatter(x, y, z) {
    for (let n = 0; n < 14; n++) {
      const a = Math.random() * TAU;
      const speed = 2.0 + Math.random() * 3.6;
      this.shards.spawn(
        x, y, z,
        Math.cos(a) * speed,
        2.2 + Math.random() * 4.0,
        Math.sin(a) * speed,
        SHARD_COLORS[(Math.random() * SHARD_COLORS.length) | 0],
        0.7 + Math.random() * 0.6,
        0.8 + Math.random() * 0.5,
        this._color,
      );
    }
    this.burst(x, y, z, 0xbfe8ff, 6);
  }

  /** Finish-line celebration: a fountain of tumbling quads. */
  confettiBurst(x, y, z) {
    for (let n = 0; n < 90; n++) {
      const a = Math.random() * TAU;
      const spread = Math.random() * 3.2;
      this.confetti.spawn(
        x + Math.cos(a) * spread * 0.4,
        y + Math.random() * 1.5,
        z + Math.sin(a) * spread * 0.4,
        Math.cos(a) * spread,
        5.5 + Math.random() * 5.0,
        Math.sin(a) * spread,
        CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
        0.9 + Math.random() * 0.5,
        2.4 + Math.random() * 1.4,
        this._color,
      );
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Advance every pool. Zero allocation.
   * @param {number} dt seconds
   * @param {THREE.Camera} [camera] unused today; kept for API stability
   */
  update(dt, camera) {
    dt = Math.min(dt, 0.1); // a tab-switch shouldn't teleport particles
    this.sparks.update(dt);
    this.dustPool.update(dt);
    this.shards.update(dt);
    this.confetti.update(dt);
    this.fireballs.update(dt);
    this.smoke.update(dt);
    this.rings.update(dt);
  }

  /** Total live particles across all pools — for debug overlays. */
  get aliveCount() {
    return this.sparks.alive + this.dustPool.alive + this.shards.alive
      + this.confetti.alive;
  }
}
