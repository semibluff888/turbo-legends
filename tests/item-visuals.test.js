import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { ITEM } from '../src/core/constants.js';
import { ItemVisualManager } from '../src/render/item-visuals.js';

function projectile(id, kind = ITEM.GREEN_SHELL) {
  return {
    id, kind, x: id, y: 0.45, z: -id, yaw: 0.4,
    vx: 28, vy: 0, vz: 12, age: 0.1,
    ownerIndex: 0, targetIndex: -1,
  };
}

test('item visuals pool and reuse projectile and hazard meshes', () => {
  const scene = new THREE.Scene();
  const visuals = new ItemVisualManager(scene);
  visuals.sync({
    projectiles: [projectile(1), projectile(2, ITEM.RED_SHELL)],
    hazards: [{ id: 3, kind: ITEM.BANANA, x: 0, y: 0.35, z: 0, age: 1 }],
  }, 1 / 60, 1);
  assert.equal(visuals.activeCount, 3);
  assert.equal(visuals.createdCount, 3);

  visuals.sync({ projectiles: [], hazards: [] }, 1 / 60, 2);
  assert.equal(visuals.activeCount, 0);
  assert.equal(visuals.pooledCount(), 3);

  visuals.sync({
    projectiles: [projectile(4), projectile(5, ITEM.RED_SHELL)],
    hazards: [{ id: 6, kind: ITEM.BANANA, x: 1, y: 0.35, z: 1, age: 2 }],
  }, 1 / 60, 3);
  assert.equal(visuals.activeCount, 3);
  assert.equal(visuals.createdCount, 3, 'matching kinds reuse the existing objects');
  visuals.dispose();
  assert.equal(scene.getObjectByName('item-visuals'), undefined);
});

test('item visuals handle the simulation entity caps without per-frame recreation', () => {
  const scene = new THREE.Scene();
  const visuals = new ItemVisualManager(scene);
  const projectiles = Array.from({ length: 64 }, (_, index) => projectile(index + 1));
  const hazards = Array.from({ length: 64 }, (_, index) => ({
    id: index + 100, kind: ITEM.BOMB, x: index, y: 0.35, z: 0, age: 1, armed: true,
  }));
  visuals.sync({ projectiles, hazards }, 1 / 60, 1);
  assert.equal(visuals.activeCount, 128);
  assert.equal(visuals.createdCount, 128);
  visuals.sync({ projectiles, hazards }, 1 / 60, 2);
  assert.equal(visuals.createdCount, 128);
  visuals.dispose();
});
