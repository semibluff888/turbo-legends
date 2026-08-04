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
  const aurora = world.scene.getObjectByName('aurora');
  assert.ok(aurora);
  assert.ok(world.scene.getObjectByName('snowfall'));
  const icicles = world.scene.getObjectByName('waterfall-icicles');
  assert.ok(icicles instanceof THREE.InstancedMesh);
  assert.equal(icicles.count, 6);

  for (const name of [
    'mirror-lake-surface', 'mirror-lake-cracks', 'waterfall-cascade',
    'waterfall-icicles', 'waterfall-mist',
  ]) {
    const object = world.scene.getObjectByName(name);
    assert.ok(object, `${name} should exist`);
    assert.equal(object.material.depthWrite, false, `${name} should not write transparent depth`);
  }

  const baseRotations = aurora.children.map((child) => child.userData.baseRotationY);
  assert.deepEqual(baseRotations, [0.15, -0.38, 0.52]);
  assert.doesNotThrow(() => world.animate(1 / 60, 0));
  for (let i = 0; i < aurora.children.length; i++) {
    const expected = baseRotations[i] + Math.sin(i * 1.5) * 0.08;
    assert.ok(Math.abs(aurora.children[i].rotation.y - expected) < 1e-9,
      `aurora layer ${i} lost its authored rotation`);
  }

  disposeTree(trackMesh);
  disposeTree(world.scene);
});

test('Aurora snowfall horizontal motion is independent of render refresh rate', () => {
  installCanvasStub();
  const world30 = buildScene(new Track(getTrackDef('aurora-icefall')));
  const world120 = buildScene(new Track(getTrackDef('aurora-icefall')));

  for (let frame = 1; frame <= 300; frame++) world30.animate(1 / 30, frame / 30);
  for (let frame = 1; frame <= 1200; frame++) world120.animate(1 / 120, frame / 120);

  const snow30 = world30.scene.getObjectByName('snowfall').geometry.getAttribute('position');
  const snow120 = world120.scene.getObjectByName('snowfall').geometry.getAttribute('position');
  assert.equal(snow30.count, snow120.count);
  for (let i = 0; i < snow30.count; i++) {
    assert.ok(Math.abs(snow30.getX(i) - snow120.getX(i)) < 1e-5,
      `snowflake ${i} drifted differently across refresh rates`);
  }

  disposeTree(world30.scene);
  disposeTree(world120.scene);
});
