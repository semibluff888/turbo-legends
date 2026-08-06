import test from 'node:test';
import assert from 'node:assert/strict';

import { LeaderboardClient } from '../src/net/leaderboard-client.js';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, async json() { return body; } };
}

test('leaderboard client coalesces requests and reuses fresh snapshots', async () => {
  let now = 1_000;
  let resolveFetch;
  const calls = [];
  const client = new LeaderboardClient({
    now: () => now,
    fetchImpl: (url, options) => {
      calls.push({ url, options });
      return new Promise((resolve) => { resolveFetch = resolve; });
    },
  });
  const first = client.load();
  const concurrent = client.load();
  assert.equal(first, concurrent);
  assert.equal(calls.length, 1);
  resolveFetch(jsonResponse({ generatedAt: 1_000, ttlMs: 60, rating: [] }));
  const snapshot = await first;
  assert.equal(snapshot.generatedAt, 1_000);

  now = 1_050;
  assert.equal(await client.load(), snapshot);
  assert.equal(calls.length, 1);

  now = 1_061;
  const refreshed = client.load();
  assert.equal(calls.length, 2);
  resolveFetch(jsonResponse({ generatedAt: 1_061, ttlMs: 60, rating: [{ position: 1 }] }));
  assert.equal((await refreshed).rating.length, 1);
  assert.equal(calls.every((call) => call.url === '/api/leaderboards'), true);
  assert.equal(calls.every((call) => call.options.credentials === 'same-origin'), true);
});

test('leaderboard client keeps stale data after refresh failures and force reload bypasses caches', async () => {
  let call = 0;
  const snapshot = { generatedAt: 1, ttlMs: 60_000, rating: [] };
  const client = new LeaderboardClient({
    now: () => 1,
    fetchImpl: async (_url, options) => {
      call++;
      if (call === 1) return jsonResponse(snapshot);
      assert.equal(options.cache, 'reload');
      return jsonResponse({
        error: { code: 'leaderboard_unavailable', message: 'Try again later.' },
      }, { ok: false, status: 503 });
    },
  });
  assert.equal(await client.load(), snapshot);
  await assert.rejects(
    client.load({ force: true }),
    (error) => error.code === 'leaderboard_unavailable'
      && error.status === 503
      && error.message === 'Try again later.',
  );
  assert.equal(client.snapshot, snapshot);
  assert.equal(client.request, null);
});
