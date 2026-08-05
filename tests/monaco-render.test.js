import test from 'node:test';
import assert from 'node:assert/strict';

import * as THREE from 'three';
import { buildScene } from '../src/render/scene.js';
import { Track } from '../src/track/track.js';
import { getTrackDef } from '../src/track/tracks.js';

function installCanvasStub() {
  const gradient = { addColorStop() {} };
  const context = {
    fillRect() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
    closePath() {}, fill() {}, stroke() {}, strokeText() {}, fillText() {},
    createLinearGradient() { return gradient; },
  };
  globalThis.document = {
    createElement() {
      return { width: 0, height: 0, getContext: () => context };
    },
  };
}

function minimumDrivableClearance(root, track) {
  root.updateWorldMatrix(true, true);
  const point = new THREE.Vector3();
  let minimum = Infinity;

  root.traverse((object) => {
    if (!object.isMesh || !object.geometry) return;
    object.geometry.computeBoundingBox();
    const bounds = object.geometry.boundingBox;
    for (let ix = 0; ix <= 4; ix++) {
      for (let iz = 0; iz <= 4; iz++) {
        point.set(
          bounds.min.x + (bounds.max.x - bounds.min.x) * ix / 4,
          bounds.min.y,
          bounds.min.z + (bounds.max.z - bounds.min.z) * iz / 4,
        ).applyMatrix4(object.matrixWorld);
        const sample = track.sampleWorld(point.x, point.z, null, {}, point.y);
        minimum = Math.min(
          minimum,
          Math.abs(sample.lateral) - sample.halfWidth - sample.runoff,
        );
      }
    }
  });
  return minimum;
}

function disposeTree(root) {
  root.traverse((object) => {
    object.geometry?.dispose?.();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) material?.dispose?.();
  });
}

test('Monaco harbor, casino, and grandstands keep their authored scene clearances', () => {
  installCanvasStub();
  const track = new Track(getTrackDef('monaco-gp'));
  const world = buildScene(track);

  const ground = world.scene.getObjectByName('ground');
  const water = world.scene.getObjectByName('monaco-harbor-water');
  assert.ok(ground);
  assert.ok(water);
  assert.equal(ground.geometry.type, 'ShapeGeometry');
  assert.equal(ground.geometry.parameters.shapes.holes.length, 1);
  assert.ok(water.position.y < ground.position.y, 'harbor water should sit below the cut-out ground');

  const casino = world.scene.getObjectByName('monaco-casino');
  const casinoBounds = new THREE.Box3().setFromObject(casino);
  assert.ok(Math.abs(casinoBounds.min.y) < 1e-6, `casino base y=${casinoBounds.min.y}`);

  for (const name of [
    'sainte-devote', 'casino-square', 'coastal-promenade', 'swimming-pool',
  ]) {
    const stand = world.scene.getObjectByName(`monaco-grandstand-${name}`);
    const clearance = minimumDrivableClearance(stand, track);
    assert.ok(clearance > 0, `${name} grandstand enters runoff by ${(-clearance).toFixed(2)}m`);
  }

  assert.doesNotThrow(() => world.animate(1 / 60, 0));
  disposeTree(world.scene);
});
