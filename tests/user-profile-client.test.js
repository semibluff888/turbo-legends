import test from 'node:test';
import assert from 'node:assert/strict';

import { UserProfileClient } from '../src/net/user-profile-client.js';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, async json() { return body; } };
}

test('user profile client bootstraps, loads, and renames the current guest profile', async () => {
  const calls = [];
  const profiles = [
    { user: { displayName: 'Migrated' } },
    { user: { displayName: 'Migrated', rating: 1000 } },
    { user: { displayName: 'Renamed', rating: 1000 } },
  ];
  const client = new UserProfileClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return jsonResponse(profiles[calls.length - 1]);
    },
  });

  assert.equal((await client.bootstrap('Migrated')).user.displayName, 'Migrated');
  await client.load();
  assert.equal((await client.updateDisplayName('Renamed')).user.displayName, 'Renamed');
  assert.deepEqual(calls.map((call) => [call.url, call.options.method || 'GET']), [
    ['/api/user/session', 'POST'],
    ['/api/me', 'GET'],
    ['/api/me', 'PATCH'],
  ]);
  assert.equal(JSON.parse(calls[0].options.body).displayName, 'Migrated');
  assert.equal(JSON.parse(calls[2].options.body).displayName, 'Renamed');
  assert.equal(calls.every((call) => call.options.credentials === 'same-origin'), true);
});

test('user profile client preserves structured API error details', async () => {
  const client = new UserProfileClient({
    fetchImpl: async () => jsonResponse({
      error: { code: 'authentication_required', message: 'Enter multiplayer again.' },
    }, { ok: false, status: 401 }),
  });
  await assert.rejects(
    client.load(),
    (error) => error.code === 'authentication_required'
      && error.status === 401
      && error.message === 'Enter multiplayer again.',
  );
});
