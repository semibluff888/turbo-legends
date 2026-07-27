import test from 'node:test';
import assert from 'node:assert/strict';

import { InputManager } from '../src/input/input.js';

class FakeTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  key(type, code) {
    this.listeners.get(type)?.({
      code,
      repeat: false,
      target: null,
      preventDefault() {},
    });
  }
}

function emptyControls() {
  return {
    throttle: 0,
    brake: 0,
    steer: 0,
    drift: false,
    useItem: false,
    lookBack: false,
  };
}

test('driving controls map screen direction through the chase-camera convention', () => {
  const target = new FakeTarget();
  const input = new InputManager(target);
  const controls = emptyControls();

  target.key('keydown', 'ArrowLeft');
  input.readControls(controls);
  assert.equal(controls.steer, 1, 'left key maps to the sim yaw shown on screen-left');

  target.key('keyup', 'ArrowLeft');
  target.key('keydown', 'ArrowRight');
  input.readControls(controls);
  assert.equal(controls.steer, -1, 'right key maps to the sim yaw shown on screen-right');

  target.key('keyup', 'ArrowRight');
  input._padSteer = -0.5;
  input.readControls(controls);
  assert.equal(controls.steer, 0.5, 'gamepad left maps to screen-left steering');

  input._padSteer = 0;
  input._touchSteer = 0.75;
  input.readControls(controls);
  assert.equal(controls.steer, -0.75, 'touch drag right maps to screen-right steering');

  input.dispose();
});
