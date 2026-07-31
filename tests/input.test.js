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
    let prevented = false;
    this.listeners.get(type)?.({
      code,
      repeat: false,
      target: null,
      preventDefault() { prevented = true; },
    });
    return prevented;
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

test('Tab standings are held only in gameplay context and clear on release or blur', () => {
  const target = new FakeTarget();
  const input = new InputManager(target);

  input.setStandingsContext(false);
  assert.equal(target.key('keydown', 'Tab'), false);
  assert.equal(input.standingsHeld, false);
  target.key('keyup', 'Tab');

  input.setStandingsContext(true);
  assert.equal(target.key('keydown', 'Tab'), true);
  assert.equal(input.standingsHeld, true);
  target.key('keyup', 'Tab');
  assert.equal(input.standingsHeld, false);

  target.key('keydown', 'Tab');
  input._onBlur();
  assert.equal(input.standingsHeld, false);

  target.key('keydown', 'Tab');
  input.setStandingsContext(false);
  assert.equal(input.standingsHeld, false);
  input.dispose();
});

test('touch race controls expose brake and an edge-triggered pause action', () => {
  const target = new FakeTarget();
  const input = new InputManager(target);
  const controls = emptyControls();
  const event = { preventDefault() {} };

  input._lastKind = 'touch';
  input._touchEnabled = true;
  input._onBrakeDown(event);
  input.readControls(controls);
  assert.equal(controls.throttle, 0, 'braking releases touch auto-accelerate so reverse can engage');
  assert.equal(controls.brake, 1, 'brake button maps to full braking');

  input._onBrakeUp();
  input.readControls(controls);
  assert.equal(controls.throttle, 1, 'touch auto-accelerate resumes after releasing the brake');
  assert.equal(controls.brake, 0);

  input._onPauseDown(event);
  input._onPauseUp();
  input.update();
  assert.equal(input.menu.pause, true, 'a quick touch pause tap survives until the next update');
  input.update();
  assert.equal(input.menu.pause, false, 'touch pause is an edge, not a held action');

  input.dispose();
});
