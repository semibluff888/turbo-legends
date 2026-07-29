import test from 'node:test';
import assert from 'node:assert/strict';

import { Hud } from '../src/ui/hud.js';

function classList() {
  const values = new Set();
  return {
    add(value) { values.add(value); },
    remove(value) { values.delete(value); },
    has(value) { return values.has(value); },
  };
}

test('finish announcement keeps place and waiting copy visible without a timer', () => {
  const hud = Object.create(Hud.prototype);
  hud._banner = { hidden: true, className: '', classList: classList(), offsetWidth: 0 };
  hud._bannerPrimary = { textContent: '' };
  hud._bannerSecondary = { textContent: '', hidden: true };
  hud._bannerTimer = null;

  hud.finish(2);

  assert.equal(hud._banner.hidden, false);
  assert.equal(hud._bannerPrimary.textContent, 'FINISHED! 2nd');
  assert.equal(hud._bannerSecondary.textContent, 'WAITING FOR OTHER RACERS TO FINISH...');
  assert.equal(hud._bannerSecondary.hidden, false);
  assert.equal(hud._banner.classList.has('banner-in'), true);
  assert.equal(hud._bannerTimer, null);
});
