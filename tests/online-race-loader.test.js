import test from 'node:test';
import assert from 'node:assert/strict';

import { prewarmRaceRenderer } from '../src/net/online-race-loader.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('async GPU compile and first-frame wait both complete before the barrier resolves', async () => {
  const compile = deferred();
  const frame = deferred();
  const calls = [];
  const renderer = {
    compileAsync() { calls.push('compile'); return compile.promise; },
    render() { calls.push('render'); },
  };
  const task = prewarmRaceRenderer({
    renderer,
    scene: {},
    camera: {},
    nextFrame() { calls.push('frame'); return frame.promise; },
  });

  assert.deepEqual(calls, ['compile']);
  compile.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ['compile', 'render', 'frame']);
  let settled = false;
  task.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  frame.resolve();
  assert.equal(await task, true);
});

test('sync compile is the fallback when compileAsync is unavailable', async () => {
  const calls = [];
  assert.equal(await prewarmRaceRenderer({
    renderer: {
      compile() { calls.push('compile'); },
      render() { calls.push('render'); },
    },
    scene: {},
    camera: {},
    nextFrame() { calls.push('frame'); return Promise.resolve(); },
  }), true);
  assert.deepEqual(calls, ['compile', 'render', 'frame']);
});

test('an expired load generation stops before pre-render and never reaches submission readiness', async () => {
  const compile = deferred();
  const calls = [];
  let current = true;
  const task = prewarmRaceRenderer({
    renderer: {
      compileAsync() { calls.push('compile'); return compile.promise; },
      render() { calls.push('render'); },
    },
    scene: {},
    camera: {},
    isCurrent: () => current,
    nextFrame() { calls.push('frame'); return Promise.resolve(); },
  });

  current = false;
  compile.resolve();
  assert.equal(await task, false);
  assert.deepEqual(calls, ['compile']);
});
