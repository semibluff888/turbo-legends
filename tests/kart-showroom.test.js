import test from 'node:test';
import assert from 'node:assert/strict';

import { buildShowroomGarage } from '../src/render/kart-showroom.js';

test('online kart showroom builds a clear garage with only tires and a tool cabinet as props', () => {
  const garage = buildShowroomGarage();
  const names = [];
  garage.traverse((object) => names.push(object.name));

  assert.equal(garage.name, 'showroom-garage');
  assert.ok(names.includes('garage-floor'));
  assert.ok(names.includes('garage-roller-door'));
  assert.equal(names.filter((name) => name === 'garage-roller-slat').length, 18);
  const shutter = garage.getObjectByName('garage-roller-door');
  assert.equal(shutter.children.length, 22);
  assert.equal(shutter.children.some((object) => object.castShadow || object.receiveShadow), false);
  const garageShadowCasters = [];
  garage.traverse((object) => { if (object.castShadow) garageShadowCasters.push(object); });
  assert.equal(garageShadowCasters.length, 0);
  assert.ok(names.includes('garage-tool-cabinet'));
  assert.ok(names.includes('garage-tire-stack'));
  assert.equal(names.includes('garage-display-platform'), false);
  assert.equal(names.includes('garage-trophy-bay'), false);
  assert.equal(names.includes('garage-trophy'), false);

  garage.traverse((object) => {
    object.geometry?.dispose?.();
    if (Array.isArray(object.material)) {
      for (const material of object.material) material.dispose?.();
    } else {
      object.material?.dispose?.();
    }
  });
});
