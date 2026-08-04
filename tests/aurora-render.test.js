import test from 'node:test';
import assert from 'node:assert/strict';

import * as THREE from 'three';
import { buildScene } from '../src/render/scene.js';
import { buildTrackMesh } from '../src/render/trackMesh.js';
import { Track } from '../src/track/track.js';
import { getTrackDef } from '../src/track/tracks.js';

function installCanvasStub() {
  const gradient = { addColorStop() {} };
  const context = {
    fillRect() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
    closePath() {}, fill() {}, stroke() {}, strokeText() {}, fillText() {},
    createLinearGradient() { return gradient; },
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt',
    font: '', textAlign: 'left', textBaseline: 'alphabetic',
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

test('Aurora Icefall builds its procedural structures and glacier scene headlessly', () => {
  installCanvasStub();
  const track = new Track(getTrackDef('aurora-icefall'));
  const trackMesh = buildTrackMesh(track);
  const world = buildScene(track);

  const trackNames = new Set();
  let tunnelLights = 0;
  trackMesh.traverse((object) => {
    if (object.name) trackNames.add(object.name);
    if (object instanceof THREE.PointLight) tunnelLights++;
  });
  assert.ok([...trackNames].some((name) => name.startsWith('ice@')));
  assert.ok([...trackNames].some((name) => name.startsWith('tunnel-shell@')));
  assert.ok(trackNames.has('bridge-underdeck'));
  assert.ok(trackNames.has('bridge-hangers'));
  assert.ok(tunnelLights >= 2);

  assert.ok(world.scene.getObjectByName('mirror-lake'));
  assert.ok(world.scene.getObjectByName('frozen-waterfall'));
  assert.ok(world.scene.getObjectByName('aurora'));
  assert.ok(world.scene.getObjectByName('snowfall'));
  assert.doesNotThrow(() => world.animate(1 / 60, 12.5));

  disposeTree(trackMesh);
  disposeTree(world.scene);
});
