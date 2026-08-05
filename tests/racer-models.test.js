import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';

import {
  CHARACTERS,
  PLAYABLE_CHARACTERS,
  isPlayableCharacterId,
  validateRoster,
} from '../src/game/characters.js';
import { defaultLoadoutForCharacter, resolveKartAppearance } from '../src/game/appearance.js';
import { Kart } from '../src/game/kart.js';
import { KartVisual } from '../src/render/kartMesh.js';
import { buildRacerModel, RACER_MODEL_IDS } from '../src/render/racer-models.js';

test('Racer catalog preserves ids, maps the six production models and locks two prototypes', () => {
  assert.deepEqual(CHARACTERS.map((character) => character.id), [
    'pip', 'nova', 'kit', 'roscoe', 'mirage', 'brick', 'tundra', 'gearbox',
  ]);
  assert.deepEqual(PLAYABLE_CHARACTERS.map((character) => character.modelId), [
    'cyber', 'chibi', 'f1', 'quantum', 'offroad', 'breeze',
  ]);
  assert.deepEqual(RACER_MODEL_IDS, ['cyber', 'chibi', 'f1', 'quantum', 'offroad', 'breeze']);
  assert.equal(isPlayableCharacterId('tundra'), false);
  assert.equal(isPlayableCharacterId('gearbox'), false);
  assert.equal(CHARACTERS[6].modelId, null);
  assert.equal(CHARACTERS[7].modelId, null);
  assert.ok(CHARACTERS[6].stats.handling > 1.16);
  assert.ok(CHARACTERS[7].stats.weight > 1.30);
  assert.deepEqual(validateRoster(), []);
});

test('each available Racer builds the live render contract within production budgets', () => {
  for (const character of PLAYABLE_CHARACTERS) {
    const appearance = resolveKartAppearance(character, defaultLoadoutForCharacter(character.id));
    const model = buildRacerModel(character, appearance, { quality: 'race' });
    assert.equal(model.refs.frontPivots.length, 2, `${character.id} front pivots`);
    assert.equal(model.refs.spinGroups.length, 4, `${character.id} wheel groups`);
    assert.ok(model.refs.flames.length >= 2, `${character.id} boost flames`);
    assert.ok(model.refs.driverMount?.isObject3D, `${character.id} driver mount`);
    assert.deepEqual(model.refs.brakeMaterials, [],
      `${character.id} must not receive a synthetic floating brake strip`);
    assert.ok(model.refs.anchorL?.isObject3D && model.refs.anchorR?.isObject3D);
    assert.ok(model.bounds.min.y >= -1e-6, `${character.id} should sit on the ground`);
    assert.ok(model.bounds.max.z - model.bounds.min.z >= 2.5, `${character.id} visual length`);
    let physicalMaterials = 0;
    model.group.traverse((object) => {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) if (material?.isMeshPhysicalMaterial) physicalMaterials += 1;
    });
    assert.equal(physicalMaterials, 0, `${character.id} race materials should be lightweight`);
    model.update(1, 1 / 60);
    model.dispose();

    const loadout = defaultLoadoutForCharacter(character.id);
    const kart = new Kart({
      index: 0,
      character,
      isPlayer: true,
      paintId: loadout.paintId,
      avatarId: loadout.avatarId,
    });
    const scene = new THREE.Scene();
    const visual = new KartVisual(kart, scene);
    assert.ok(visual._refs.metrics.drawNodes <= 70,
      `${character.id} draw nodes with driver: ${visual._refs.metrics.drawNodes}`);
    assert.ok(visual._refs.metrics.triangles <= 12000,
      `${character.id} triangles with driver: ${visual._refs.metrics.triangles}`);

    const starBaseline = visual._starMats.map(({ m, emissive, intensity }) => ({
      m, emissive: emissive.clone(), intensity,
    }));
    kart.wheelSpin = 1.25;
    kart.steerAngle = -0.22;
    kart.boostTimer = 1;
    kart.boostPower = 1.4;
    kart.controls.brake = 1;
    kart.starTimer = 1;
    visual.sync(new THREE.Vector3(0, 3, 5));
    assert.ok(visual._refs.spinGroups.every((wheel) => wheel.rotation.x === 1.25));
    assert.ok(visual._refs.frontPivots.every((pivot) => pivot.rotation.y === -0.22));
    assert.ok(visual._refs.flames.every((flame) => flame.visible));
    assert.deepEqual(visual._refs.brakeMaterials, []);
    assert.ok(visual._starMats.every(({ m }) => m.emissiveIntensity === 0.85));
    assert.ok(Number.isFinite(visual.getSparkAnchor(-1).x));

    kart.boostTimer = 0;
    kart.controls.brake = 0;
    kart.starTimer = 0;
    visual.sync(new THREE.Vector3(0, 3, 5));
    assert.ok(visual._refs.flames.every((flame) => !flame.visible));
    for (let index = 0; index < starBaseline.length; index++) {
      assert.ok(visual._starMats[index].m.emissive.equals(starBaseline[index].emissive));
      assert.equal(visual._starMats[index].m.emissiveIntensity, starBaseline[index].intensity);
    }
    visual.dispose();
    assert.equal(scene.children.includes(visual.group), false);
  }
});

test('production owns the shared model builders and the Demo reuses them', () => {
  const adapterSource = readFileSync(new URL('../src/render/racer-models.js', import.meta.url), 'utf8');
  const demoSource = readFileSync(new URL('../demo/car-models.js', import.meta.url), 'utf8');
  assert.doesNotMatch(adapterSource, /demo\/car-models/);
  assert.match(adapterSource, /\.\/racer-model-builders\.js/);
  assert.match(demoSource, /\.\.\/src\/render\/racer-model-builders\.js/);
});

test('locked prototypes have no production 3D model', () => {
  const locked = CHARACTERS.find((character) => character.id === 'tundra');
  assert.throws(() => buildRacerModel(locked, {
    color: locked.color,
    accentColor: locked.accentColor,
    avatarId: 'panda',
  }), /No production model/);
});
