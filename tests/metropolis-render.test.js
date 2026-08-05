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

function disposeTree(root) {
  root.traverse((object) => {
    object.geometry?.dispose?.();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material) continue;
      for (const value of Object.values(material)) value?.isTexture && value.dispose();
      material.dispose?.();
    }
  });
}

function minimumDrivableClearance(mesh, track) {
  mesh.geometry.computeBoundingBox();
  const bounds = mesh.geometry.boundingBox;
  const matrix = new THREE.Matrix4();
  const point = new THREE.Vector3();
  let minimum = Infinity;

  for (let instance = 0; instance < mesh.count; instance++) {
    mesh.getMatrixAt(instance, matrix);
    for (let ix = 0; ix <= 4; ix++) {
      for (let iz = 0; iz <= 4; iz++) {
        point.set(
          bounds.min.x + (bounds.max.x - bounds.min.x) * ix / 4,
          0,
          bounds.min.z + (bounds.max.z - bounds.min.z) * iz / 4,
        ).applyMatrix4(matrix);
        const sample = track.sampleWorld(point.x, point.z, null, {}, 0);
        minimum = Math.min(
          minimum,
          Math.abs(sample.lateral) - sample.halfWidth - sample.runoff,
        );
      }
    }
  }
  return minimum;
}

test('Metropolis scenery keeps full building footprints outside the drivable ribbon', () => {
  installCanvasStub();
  const track = new Track(getTrackDef('metropolis-highway'));
  const world = buildScene(track);
  const scenery = world.scene.getObjectByName('scenery');
  const buildings = scenery.children.filter((object) => object.isInstancedMesh);

  assert.deepEqual(buildings.map((mesh) => mesh.count), [48, 48, 40]);
  for (const mesh of buildings) {
    const clearance = minimumDrivableClearance(mesh, track);
    assert.ok(clearance > 0, `building footprint enters runoff by ${(-clearance).toFixed(2)}m`);
  }

  const landmark = world.scene.getObjectByName('city-overpass');
  const pillar = world.scene.getObjectByName('city-overpass-pillar');
  assert.ok(landmark);
  assert.ok(pillar);
  const sample = track.sampleWorld(landmark.position.x, landmark.position.z, null, {}, 0);
  assert.ok(Math.abs(sample.lateral) - sample.halfWidth - sample.runoff > 24);
  assert.doesNotThrow(() => world.animate(1 / 60, 0));

  disposeTree(world.scene);
});
