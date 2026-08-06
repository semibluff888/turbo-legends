import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
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

test('guest creation has no per-IP account limit', async () => {
  const server = await createGameServer({ root: PROJECT_ROOT, logger: { info() {}, warn() {}, error() {} } });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const port = server.address().port;
    const cookies = new Set();
    for (let index = 0; index < 21; index++) {
      const response = await httpRequest(port, '/api/user/session', {
        method: 'POST', body: { displayName: `Guest ${index + 1}` },
      });
      assert.equal(response.statusCode, 200);
      cookies.add(response.headers['set-cookie']?.[0].split(';')[0]);
    }
    assert.equal(cookies.size, 21);
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
