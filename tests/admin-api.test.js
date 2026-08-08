import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';

import { createGameServer } from '../server.mjs';
import { USER_SESSION_COOKIE } from '../server/user-store.js';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ADMIN_KEY = 'correct-admin-key-123456';

function httpRequest(port, path, {
  method = 'GET', cookie = '', body, headers: extraHeaders = {}, origin = true,
} = {}) {
  return new Promise((resolve, reject) => {
    const serialized = body === undefined ? null : JSON.stringify(body);
    const headers = { ...extraHeaders };
    if (cookie) headers.Cookie = cookie;
    if (origin) headers.Origin = `http://127.0.0.1:${port}`;
    if (serialized !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(serialized);
    }
    const req = request({ host: '127.0.0.1', port, path, method, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(serialized ?? undefined);
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

test('admin routes stay hidden when ADMIN_KEY is disabled', async () => {
  const server = await createGameServer({ root: PROJECT_ROOT, logger: { info() {}, warn() {}, error() {} } });
  const port = await listen(server);
  try {
    assert.equal((await httpRequest(port, '/admin')).statusCode, 404);
    assert.equal((await httpRequest(port, '/src/admin/index.html')).statusCode, 404);
    assert.equal((await httpRequest(port, '/api/admin/dashboard')).statusCode, 404);
  } finally {
    await server.shutdown();
  }
});

test('admin login protects dashboards and user deletion while analytics begin at zero', async () => {
  const server = await createGameServer({
    root: PROJECT_ROOT,
    adminKey: ADMIN_KEY,
    logger: { info() {}, warn() {}, error() {} },
  });
  const created = server.userStore.createOrResumeSession({ displayName: 'Managed Driver' });
  server.userStore.db.prepare(`
    UPDATE users SET races = 3, rating = 1400, xp = 500 WHERE user_id = ?
  `).run(created.userId);
  const port = await listen(server);
  try {
    const page = await httpRequest(port, '/admin');
    assert.equal(page.statusCode, 200);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/u);
    assert.match(page.body, /BOT_ROOM_ENABLED/u);
    assert.match(page.body, /id="bot-room-enabled"/u);
    assert.match(page.body, /BOT_ROOM_READY_TIMEOUT_SECONDS/u);
    assert.match(page.body, /id="bot-room-ready-timeout"/u);

    const root = await httpRequest(port, '/', { origin: false });
    assert.equal(root.statusCode, 200);
    assert.match(root.headers['set-cookie']?.[0] || '', /turbo_legends_visitor=/u);

    const blockedLogin = await httpRequest(port, '/api/admin/login', {
      method: 'POST', body: { key: ADMIN_KEY }, origin: false,
    });
    assert.equal(blockedLogin.statusCode, 403);

    const login = await httpRequest(port, '/api/admin/login', {
      method: 'POST', body: { key: ADMIN_KEY },
    });
    assert.equal(login.statusCode, 200);
    const setCookie = login.headers['set-cookie']?.[0] || '';
    assert.match(setCookie, /turbo_legends_admin=/u);
    assert.match(setCookie, /HttpOnly/u);
    assert.match(setCookie, /SameSite=Strict/u);
    const cookie = setCookie.split(';')[0];

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: {
        Origin: `http://127.0.0.1:${port}`,
        Cookie: `${USER_SESSION_COOKIE}=${encodeURIComponent(created.token)}`,
      },
    });
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    const dashboard = await httpRequest(port, '/api/admin/dashboard?range=24h', { cookie });
    assert.equal(dashboard.statusCode, 200);
    assert.equal(dashboard.body.traffic.totalPageViews, 1);
    assert.equal(dashboard.body.traffic.todayUniqueVisitors, 1);
    assert.equal(dashboard.body.races.total, 0);
    assert.equal(dashboard.body.users.total, 1);
    assert.equal(dashboard.body.traffic.currentOnline, 1);
    assert.equal(dashboard.body.traffic.peakOnline, 1);

    const users = await httpRequest(port, '/api/admin/users?q=Managed', { cookie });
    assert.equal(users.body.total, 1);
    assert.equal(users.body.items[0].userId, created.userId);
    assert.equal(JSON.stringify(users.body).includes('session_hash'), false);

    const detail = await httpRequest(port, `/api/admin/users/${encodeURIComponent(created.userId)}`, { cookie });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.body.displayName, 'Managed Driver');
    assert.equal(JSON.stringify(detail.body).includes(created.token), false);

    const leaderboard = await httpRequest(port, '/api/leaderboards', { origin: false });
    assert.equal(leaderboard.body.rating[0].displayName, 'Managed Driver');

    const activeDelete = await httpRequest(port, `/api/admin/users/${encodeURIComponent(created.userId)}`, {
      method: 'DELETE', cookie, body: {},
    });
    assert.equal(activeDelete.statusCode, 409);
    assert.equal(activeDelete.body.error.code, 'user_active');

    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.close();
    await closed;
    const deleted = await httpRequest(port, `/api/admin/users/${encodeURIComponent(created.userId)}`, {
      method: 'DELETE', cookie, body: {},
    });
    assert.equal(deleted.statusCode, 200);
    assert.equal(server.userStore.getProfile(created.userId), null);
    const refreshedLeaderboard = await httpRequest(port, '/api/leaderboards', { origin: false });
    assert.deepEqual(refreshedLeaderboard.body.rating, []);
  } finally {
    await server.shutdown();
  }
});

test('failed admin logins are rate limited and trusted HTTPS adds Secure', async () => {
  const server = await createGameServer({
    root: PROJECT_ROOT,
    adminKey: ADMIN_KEY,
    trustProxy: true,
    logger: { info() {}, warn() {}, error() {} },
  });
  const port = await listen(server);
  try {
    for (let index = 0; index < 5; index++) {
      const failed = await httpRequest(port, '/api/admin/login', {
        method: 'POST', body: { key: 'wrong-key-value-123456' },
      });
      assert.equal(failed.statusCode, 401);
    }
    const limited = await httpRequest(port, '/api/admin/login', {
      method: 'POST', body: { key: ADMIN_KEY },
    });
    assert.equal(limited.statusCode, 429);

    const secureServer = await createGameServer({
      root: PROJECT_ROOT,
      adminKey: 'another-admin-key-123456',
      trustProxy: true,
      logger: { info() {}, warn() {}, error() {} },
    });
    const securePort = await listen(secureServer);
    try {
      const login = await httpRequest(securePort, '/api/admin/login', {
        method: 'POST',
        body: { key: 'another-admin-key-123456' },
        headers: { 'X-Forwarded-Proto': 'https' },
      });
      assert.match(login.headers['set-cookie']?.[0] || '', /; Secure(?:;|$)/u);
    } finally {
      await secureServer.shutdown();
    }
  } finally {
    await server.shutdown();
  }
});

test('same-origin browser fetch metadata is accepted when Origin is omitted', async () => {
  const server = await createGameServer({
    root: PROJECT_ROOT,
    adminKey: ADMIN_KEY,
    logger: { info() {}, warn() {}, error() {} },
  });
  const port = await listen(server);
  try {
    const login = await httpRequest(port, '/api/admin/login', {
      method: 'POST',
      body: { key: ADMIN_KEY },
      origin: false,
      headers: { 'Sec-Fetch-Site': 'same-origin' },
    });
    assert.equal(login.statusCode, 200);
    assert.match(login.headers['set-cookie']?.[0] || '', /turbo_legends_admin=/u);
  } finally {
    await server.shutdown();
  }
});

test('admin Bot-room setting is authenticated, strict, immediate and persistent', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'turbo-legends-settings-'));
  const databasePath = join(directory, 'users.sqlite');
  const logger = { info() {}, warn() {}, error() {} };
  let server = await createGameServer({
    root: PROJECT_ROOT,
    adminKey: ADMIN_KEY,
    botRoomEnabled: false,
    userDbPath: databasePath,
    logger,
  });
  let port = await listen(server);
  try {
    assert.equal(server.roomManager.botRoomsEnabled, false);
    assert.equal(server.roomManager.rooms.size, 0);
    assert.equal((await httpRequest(port, '/api/admin/settings')).statusCode, 401);

    const login = await httpRequest(port, '/api/admin/login', {
      method: 'POST', body: { key: ADMIN_KEY },
    });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const initial = await httpRequest(port, '/api/admin/settings', { cookie });
    assert.deepEqual(initial.body, {
      botRoomEnabled: false,
      source: 'environment',
      updatedAt: null,
      botRoomReadyTimeoutSeconds: 30,
      botRoomReadyTimeoutSource: 'default',
      botRoomReadyTimeoutUpdatedAt: null,
    });

    const crossOrigin = await httpRequest(port, '/api/admin/settings', {
      method: 'PATCH', cookie, body: { botRoomEnabled: true }, origin: false,
    });
    assert.equal(crossOrigin.statusCode, 403);
    const invalid = await httpRequest(port, '/api/admin/settings', {
      method: 'PATCH', cookie, body: { botRoomEnabled: 'true' },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.body.error.code, 'settings_invalid');
    const extra = await httpRequest(port, '/api/admin/settings', {
      method: 'PATCH', cookie, body: { botRoomEnabled: true, extra: false },
    });
    assert.equal(extra.statusCode, 400);
    for (const value of [9, 601, 30.5, '30']) {
      const invalidTimeout = await httpRequest(port, '/api/admin/settings', {
        method: 'PATCH', cookie, body: { botRoomReadyTimeoutSeconds: value },
      });
      assert.equal(invalidTimeout.statusCode, 400);
      assert.equal(invalidTimeout.body.error.code, 'settings_invalid');
    }

    const timeout = await httpRequest(port, '/api/admin/settings', {
      method: 'PATCH', cookie, body: { botRoomReadyTimeoutSeconds: 45 },
    });
    assert.equal(timeout.statusCode, 200);
    assert.equal(timeout.body.botRoomReadyTimeoutSeconds, 45);
    assert.equal(timeout.body.botRoomReadyTimeoutSource, 'database');
    assert.equal(server.roomManager.botReadyTimeoutMs, 45_000);

    const enabled = await httpRequest(port, '/api/admin/settings', {
      method: 'PATCH', cookie, body: { botRoomEnabled: true },
    });
    assert.equal(enabled.statusCode, 200);
    assert.equal(enabled.body.botRoomEnabled, true);
    assert.equal(enabled.body.source, 'database');
    assert.equal(server.roomManager.botRoomsEnabled, true);
    assert.equal([...server.roomManager.rooms.values()].some((room) => room.botManaged), true);

    const disabled = await httpRequest(port, '/api/admin/settings', {
      method: 'PATCH', cookie, body: { botRoomEnabled: false },
    });
    assert.equal(disabled.statusCode, 200);
    assert.equal(server.roomManager.rooms.size, 0);
  } finally {
    await server.shutdown();
  }

  server = await createGameServer({
    root: PROJECT_ROOT,
    adminKey: ADMIN_KEY,
    botRoomEnabled: true,
    botRoomReadyTimeoutSeconds: 60,
    userDbPath: databasePath,
    logger,
  });
  port = await listen(server);
  try {
    assert.equal(server.roomManager.botRoomsEnabled, false);
    assert.equal(server.roomManager.rooms.size, 0);
    const login = await httpRequest(port, '/api/admin/login', {
      method: 'POST', body: { key: ADMIN_KEY },
    });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const persisted = await httpRequest(port, '/api/admin/settings', { cookie });
    assert.equal(persisted.body.botRoomEnabled, false);
    assert.equal(persisted.body.source, 'database');
    assert.equal(persisted.body.botRoomReadyTimeoutSeconds, 45);
    assert.equal(persisted.body.botRoomReadyTimeoutSource, 'database');
    assert.equal(server.roomManager.botReadyTimeoutMs, 45_000);
  } finally {
    await server.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('invalid explicit Bot ready-timeout configuration prevents startup', async () => {
  await assert.rejects(
    createGameServer({
      root: PROJECT_ROOT,
      botRoomReadyTimeoutSeconds: 9,
      logger: { info() {}, warn() {}, error() {} },
    }),
    /BOT_ROOM_READY_TIMEOUT_SECONDS must be an integer between 10 and 600 seconds/u,
  );
});
