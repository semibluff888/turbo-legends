import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { createGameServer } from '../server.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

function httpRequest(port, path, {
  method = 'GET', cookie = '', body = null, headers: extraHeaders = {},
} = {}) {
  return new Promise((resolve, reject) => {
    const serialized = body === null ? null : JSON.stringify(body);
    const headers = { ...extraHeaders };
    if (cookie) headers.Cookie = cookie;
    if (serialized !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(serialized);
    }
    const req = request({ host: '127.0.0.1', port, path, method, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: text ? JSON.parse(text) : null,
        });
      });
    });
    req.on('error', reject);
    req.end(serialized ?? undefined);
  });
}

test('multiplayer guest session, profile read and nickname update use an HttpOnly cookie', async () => {
  const server = await createGameServer({ root: PROJECT_ROOT, logger: { info() {}, warn() {}, error() {} } });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const port = server.address().port;
    const created = await httpRequest(port, '/api/user/session', {
      method: 'POST', body: { displayName: 'Guest Driver' },
    });
    assert.equal(created.statusCode, 200);
    assert.equal(created.body.user.displayName, 'Guest Driver');
    const setCookie = created.headers['set-cookie']?.[0] || '';
    assert.match(setCookie, /turbo_legends_user=/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const cookie = setCookie.split(';')[0];

    const profile = await httpRequest(port, '/api/me', { cookie });
    assert.equal(profile.statusCode, 200);
    assert.equal(profile.body.user.rating, 1000);
    assert.equal(profile.body.stats.escapeRate, 0);

    const updated = await httpRequest(port, '/api/me', {
      method: 'PATCH', cookie, body: { displayName: 'Renamed Driver' },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.body.user.displayName, 'Renamed Driver');

    const resumed = await httpRequest(port, '/api/user/session', {
      method: 'POST', cookie, body: { displayName: 'Ignored Name' },
    });
    assert.equal(resumed.body.user.displayName, 'Renamed Driver');
    assert.equal(resumed.headers['set-cookie'], undefined);
  } finally {
    await server.shutdown();
  }
});

test('profile endpoints reject missing sessions and invalid nicknames', async () => {
  const server = await createGameServer({ root: PROJECT_ROOT, logger: { info() {}, warn() {}, error() {} } });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const port = server.address().port;
    assert.equal((await httpRequest(port, '/api/me')).statusCode, 401);
    const invalid = await httpRequest(port, '/api/user/session', {
      method: 'POST', body: { displayName: '' },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.body.error.code, 'name_invalid');
  } finally {
    await server.shutdown();
  }
});

test('guest creation is rate limited per IP while valid sessions can still resume', async () => {
  const server = await createGameServer({
    root: PROJECT_ROOT,
    guestCreationLimit: 2,
    logger: { info() {}, warn() {}, error() {} },
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const port = server.address().port;
    const first = await httpRequest(port, '/api/user/session', {
      method: 'POST', body: { displayName: 'Guest 1' },
    });
    const second = await httpRequest(port, '/api/user/session', {
      method: 'POST', body: { displayName: 'Guest 2' },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);

    const limited = await httpRequest(port, '/api/user/session', {
      method: 'POST', body: { displayName: 'Guest 3' },
    });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.body.error.code, 'rate_limited');

    const resumed = await httpRequest(port, '/api/user/session', {
      method: 'POST',
      cookie: first.headers['set-cookie'][0].split(';')[0],
      body: { displayName: 'Ignored' },
    });
    assert.equal(resumed.statusCode, 200);
    assert.equal(resumed.body.user.displayName, 'Guest 1');
  } finally {
    await server.shutdown();
  }
});

test('guest creation rate limit is disabled by default', async () => {
  const server = await createGameServer({
    root: PROJECT_ROOT,
    logger: { info() {}, warn() {}, error() {} },
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const port = server.address().port;
    for (let index = 0; index < 35; index++) {
      const created = await httpRequest(port, '/api/user/session', {
        method: 'POST', body: { displayName: `Guest ${index}` },
      });
      assert.equal(created.statusCode, 200);
    }
  } finally {
    await server.shutdown();
  }
});

test('trusted HTTPS forwarding adds Secure to the guest cookie', async () => {
  const server = await createGameServer({
    root: PROJECT_ROOT,
    trustProxy: true,
    logger: { info() {}, warn() {}, error() {} },
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const response = await httpRequest(server.address().port, '/api/user/session', {
      method: 'POST',
      headers: { 'X-Forwarded-Proto': 'https' },
      body: { displayName: 'Secure Guest' },
    });
    assert.match(response.headers['set-cookie']?.[0] || '', /; Secure(?:;|$)/);
  } finally {
    await server.shutdown();
  }
});

test('leaderboard API returns one public cached snapshot with ETag revalidation', async () => {
  const server = await createGameServer({
    root: PROJECT_ROOT,
    leaderboardCacheTtlMs: 40,
    logger: { info() {}, warn() {}, error() {} },
  });
  const created = server.userStore.createOrResumeSession({ displayName: 'Ranked Driver' });
  server.userStore.db.prepare(`
    UPDATE users SET races = 3, xp = 300, rating = 1234, firsts = 2 WHERE user_id = ?
  `).run(created.userId);
  let queryCount = 0;
  const getLeaderboards = server.userStore.getLeaderboards.bind(server.userStore);
  server.userStore.getLeaderboards = (...args) => {
    queryCount++;
    return getLeaderboards(...args);
  };
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const port = server.address().port;
    const first = await httpRequest(port, '/api/leaderboards');
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.ttlMs, 40);
    assert.equal(first.body.rating[0].displayName, 'Ranked Driver');
    assert.deepEqual(Object.keys(first.body.rating[0]), [
      'position', 'displayName', 'level', 'rating',
    ]);
    assert.equal(first.body.speed.length, 6);
    assert.equal(JSON.stringify(first.body).includes('userId'), false);
    assert.match(first.headers['cache-control'], /^public, max-age=/u);
    assert.match(first.headers.etag, /^"[A-Za-z0-9_-]+"$/u);
    assert.equal(queryCount, 1);

    const cached = await httpRequest(port, '/api/leaderboards');
    assert.equal(cached.statusCode, 200);
    assert.deepEqual(cached.body, first.body);
    assert.equal(queryCount, 1);

    const notModified = await httpRequest(port, '/api/leaderboards', {
      headers: { 'If-None-Match': first.headers.etag },
    });
    assert.equal(notModified.statusCode, 304);
    assert.equal(notModified.body, null);
    assert.equal(queryCount, 1);

    await delay(60);
    const refreshed = await httpRequest(port, '/api/leaderboards');
    assert.equal(refreshed.statusCode, 200);
    assert.equal(queryCount, 2);
    assert.ok(refreshed.body.generatedAt >= first.body.generatedAt);
  } finally {
    await server.shutdown();
  }
});

test('default leaderboard cache advertises a sixty-second browser lifetime', async () => {
  const server = await createGameServer({
    root: PROJECT_ROOT,
    logger: { info() {}, warn() {}, error() {} },
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const response = await httpRequest(server.address().port, '/api/leaderboards');
    assert.equal(response.body.ttlMs, 60_000);
    assert.match(response.headers['cache-control'], /max-age=60/u);
    assert.deepEqual(response.body.rating, []);
    assert.deepEqual(response.body.champions, []);
    assert.deepEqual(response.body.level, []);
  } finally {
    await server.shutdown();
  }
});
