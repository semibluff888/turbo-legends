import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PUBLIC_STATS_INTERVAL_MS,
  PublicServerStatsPoller,
} from '../src/net/public-server-stats.js';

test('public stats poll immediately reports HTTP RTT and repeats every 15 seconds', async () => {
  let now = 100;
  const timers = [];
  const updates = [];
  const poller = new PublicServerStatsPoller({
    now: () => now,
    fetchImpl: async (url) => {
      assert.equal(url, '/api/stats');
      now = 137;
      return { ok: true, json: async () => ({ version: '1.0.0', onlineCount: 9 }) };
    },
    setTimeoutImpl(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutImpl() {},
    onUpdate(update) { updates.push(update); },
  });

  poller.start();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(updates, [{
    available: true, latencyMs: 37, onlineCount: 9, version: '1.0.0',
  }]);
  assert.equal(timers[0].ms, PUBLIC_STATS_INTERVAL_MS);
  poller.stop();
});

test('public stats failures report offline and stopped requests cannot update the UI', async () => {
  const updates = [];
  let resolveFetch;
  const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });
  const poller = new PublicServerStatsPoller({
    fetchImpl: () => fetchPromise,
    setTimeoutImpl() { return 1; },
    clearTimeoutImpl() {},
    onUpdate(update) { updates.push(update); },
  });
  poller.start();
  poller.stop();
  resolveFetch({ ok: false, json: async () => ({}) });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(updates, []);

  const offline = new PublicServerStatsPoller({
    fetchImpl: async () => { throw new Error('offline'); },
    setTimeoutImpl() { return 1; },
    clearTimeoutImpl() {},
    onUpdate(update) { updates.push(update); },
  });
  offline.start();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(updates.at(-1), {
    available: false, latencyMs: null, onlineCount: null, version: null,
  });
  offline.stop();
});

