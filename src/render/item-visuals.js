import * as THREE from 'three';
import { ITEM } from '../core/constants.js';

const POSITION_LAMBDA = 24;
const MAX_EXTRAPOLATION = 0.08;

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function material(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.46, metalness: 0.08, ...extra });
}

function mesh(geometry, mat, parent, { position = null, rotation = null, scale = null } = {}) {
  const result = new THREE.Mesh(geometry, mat);
  if (position) result.position.set(...position);
  if (rotation) result.rotation.set(...rotation);
  if (scale) result.scale.set(...scale);
  result.castShadow = true;
  result.receiveShadow = true;
  parent.add(result);
  return result;
}

export class ItemVisualManager {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'item-visuals';
    scene.add(this.root);
    this.active = new Map();
    this.pools = new Map();
    this.createdCount = 0;
    this._geometries = {
      shell: new THREE.SphereGeometry(0.62, 14, 10),
      shellBelly: new THREE.CylinderGeometry(0.45, 0.52, 0.22, 14),
      shellRim: new THREE.TorusGeometry(0.53, 0.09, 7, 18),
      spike: new THREE.ConeGeometry(0.13, 0.36, 7),
      bomb: new THREE.SphereGeometry(0.56, 14, 10),
      cap: new THREE.CylinderGeometry(0.19, 0.24, 0.22, 10),
      fuse: new THREE.CylinderGeometry(0.045, 0.045, 0.52, 7),
      ember: new THREE.SphereGeometry(0.1, 8, 6),
      banana: new THREE.TorusGeometry(0.43, 0.12, 8, 18, Math.PI * 1.25),
      stem: new THREE.CylinderGeometry(0.05, 0.075, 0.28, 7),
    };
    this._materials = {
      green: material(0x35d85a, { emissive: 0x082b10, emissiveIntensity: 0.5 }),
      red: material(0xf03b50, { emissive: 0x33060b, emissiveIntensity: 0.58 }),
      blue: material(0x347cff, { emissive: 0x071a4d, emissiveIntensity: 0.72, metalness: 0.18 }),
      rim: material(0xf8f2d8),
      belly: material(0xf4d78a),
      spike: material(0xf0f5ff, { metalness: 0.3 }),
      bomb: material(0x1d2130, { metalness: 0.38, roughness: 0.32 }),
      cap: material(0x6f7788, { metalness: 0.58, roughness: 0.28 }),
      fuse: material(0x5b3925, { roughness: 0.9 }),
      ember: material(0xff7a2f, { emissive: 0xff3a08, emissiveIntensity: 2.4 }),
      banana: material(0xffdc38, { emissive: 0x4a2e00, emissiveIntensity: 0.35 }),
      stem: material(0x6f4a20, { roughness: 0.9 }),
    };
  }

  get activeCount() { return this.active.size; }

  pooledCount(kind = null) {
    if (kind) return this.pools.get(kind)?.length || 0;
    let total = 0;
    for (const pool of this.pools.values()) total += pool.length;
    return total;
  }

  sync(items, dt, time = 0) {
    const seen = new Set();
    for (const projectile of items?.projectiles || []) {
      this._syncEntity(`p:${projectile.id}`, projectile, Math.max(0, finite(dt)), time, seen);
    }
    for (const hazard of items?.hazards || []) {
      if (hazard.dead) continue;
      this._syncEntity(`h:${hazard.id}`, hazard, Math.max(0, finite(dt)), time, seen);
    }
    for (const [key, entry] of this.active) {
      if (!seen.has(key)) this._release(key, entry);
    }
  }

  _syncEntity(key, entity, dt, time, seen) {
    seen.add(key);
    let entry = this.active.get(key);
    if (!entry || entry.kind !== entity.kind) {
      if (entry) this._release(key, entry);
      entry = this._acquire(entity.kind);
      this.active.set(key, entry);
      entry.initialized = false;
    }

    const changed = entity.x !== entry.lastX || entity.y !== entry.lastY
      || entity.z !== entry.lastZ || entity.age !== entry.lastAge;
    entry.snapshotAge = changed ? 0 : Math.min(MAX_EXTRAPOLATION, entry.snapshotAge + dt);
    entry.lastX = entity.x;
    entry.lastY = entity.y;
    entry.lastZ = entity.z;
    entry.lastAge = entity.age;
    const targetX = finite(entity.x) + finite(entity.vx) * entry.snapshotAge;
    const targetY = finite(entity.y) + finite(entity.vy) * entry.snapshotAge;
    const targetZ = finite(entity.z) + finite(entity.vz) * entry.snapshotAge;
    if (!entry.initialized) {
      entry.group.position.set(targetX, targetY, targetZ);
      entry.group.rotation.y = finite(entity.yaw);
      entry.initialized = true;
    } else {
      const alpha = 1 - Math.exp(-POSITION_LAMBDA * dt);
      entry.group.position.x += (targetX - entry.group.position.x) * alpha;
      entry.group.position.y += (targetY - entry.group.position.y) * alpha;
      entry.group.position.z += (targetZ - entry.group.position.z) * alpha;
      const yawDelta = Math.atan2(
        Math.sin(finite(entity.yaw) - entry.group.rotation.y),
        Math.cos(finite(entity.yaw) - entry.group.rotation.y),
      );
      entry.group.rotation.y += yawDelta * alpha;
    }

    if (entry.spinner) entry.spinner.rotation.y += dt * entry.spinRate;
    if (entry.kind === ITEM.BOMB) {
      entry.spinner.rotation.x += dt * (entity.armed ? 1.4 : 4.5);
      if (entry.ember) {
        const pulse = 0.76 + Math.sin(time * 18 + finite(entity.id)) * 0.24;
        entry.ember.scale.setScalar(pulse);
        entry.ember.visible = entity.armed !== false;
      }
    } else if (entry.kind === ITEM.BANANA) {
      entry.group.rotation.z = Math.sin(time * 2.5 + finite(entity.id)) * 0.08;
    }
  }

  _acquire(kind) {
    const pool = this.pools.get(kind) || [];
    this.pools.set(kind, pool);
    const entry = pool.pop() || this._create(kind);
    entry.group.visible = true;
    entry.snapshotAge = 0;
    entry.lastX = NaN;
    entry.lastY = NaN;
    entry.lastZ = NaN;
    entry.lastAge = NaN;
    this.root.add(entry.group);
    return entry;
  }

  _release(key, entry) {
    this.active.delete(key);
    entry.group.visible = false;
    entry.initialized = false;
    const pool = this.pools.get(entry.kind) || [];
    this.pools.set(entry.kind, pool);
    pool.push(entry);
  }

  _create(kind) {
    this.createdCount++;
    if (kind === ITEM.BANANA) return this._createBanana();
    if (kind === ITEM.BOMB) return this._createBomb();
    return this._createShell(kind);
  }

  _createShell(kind) {
    const group = new THREE.Group();
    group.name = `item-${kind}`;
    const spinner = new THREE.Group();
    group.add(spinner);
    const shellMat = kind === ITEM.RED_SHELL ? this._materials.red
      : kind === ITEM.BLUE_SHELL ? this._materials.blue : this._materials.green;
    mesh(this._geometries.shell, shellMat, spinner, { scale: [1, 0.56, 1] });
    mesh(this._geometries.shellBelly, this._materials.belly, spinner, { position: [0, -0.24, 0] });
    mesh(this._geometries.shellRim, this._materials.rim, spinner, { rotation: [Math.PI / 2, 0, 0] });
    if (kind === ITEM.BLUE_SHELL) {
      for (let index = 0; index < 8; index++) {
        const angle = index / 8 * Math.PI * 2;
        const spike = mesh(this._geometries.spike, this._materials.spike, spinner, {
          position: [Math.sin(angle) * 0.48, 0.16, Math.cos(angle) * 0.48],
        });
        spike.rotation.z = -Math.sin(angle) * 0.85;
        spike.rotation.x = Math.cos(angle) * 0.85;
      }
      mesh(this._geometries.spike, this._materials.spike, spinner, { position: [0, 0.5, 0] });
    }
    return {
      kind, group, spinner, ember: null,
      spinRate: kind === ITEM.BLUE_SHELL ? 9 : 13,
      initialized: false, snapshotAge: 0,
    };
  }

  _createBomb() {
    const group = new THREE.Group();
    group.name = 'item-bomb';
    const spinner = new THREE.Group();
    group.add(spinner);
    mesh(this._geometries.bomb, this._materials.bomb, spinner);
    mesh(this._geometries.cap, this._materials.cap, spinner, { position: [0, 0.53, 0] });
    mesh(this._geometries.fuse, this._materials.fuse, spinner, {
      position: [0.14, 0.8, 0], rotation: [0, 0, -0.48],
    });
    const ember = mesh(this._geometries.ember, this._materials.ember, spinner, { position: [0.27, 1.02, 0] });
    return {
      kind: ITEM.BOMB, group, spinner, ember, spinRate: 2.4,
      initialized: false, snapshotAge: 0,
    };
  }

  _createBanana() {
    const group = new THREE.Group();
    group.name = 'item-banana';
    const spinner = new THREE.Group();
    group.add(spinner);
    for (const rotation of [-0.42, 0, 0.42]) {
      mesh(this._geometries.banana, this._materials.banana, spinner, {
        position: [0, 0.18, 0], rotation: [Math.PI / 2, rotation, -0.62], scale: [0.82, 0.82, 0.82],
      });
    }
    mesh(this._geometries.stem, this._materials.stem, spinner, { position: [0, 0.57, 0] });
    return {
      kind: ITEM.BANANA, group, spinner, ember: null, spinRate: 0,
      initialized: false, snapshotAge: 0,
    };
  }

  dispose() {
    this.active.clear();
    this.pools.clear();
    this.scene?.remove(this.root);
    this.root.clear();
    for (const geometry of Object.values(this._geometries)) geometry.dispose();
    for (const mat of Object.values(this._materials)) mat.dispose();
  }
}
