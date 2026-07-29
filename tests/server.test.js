import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';

import { createStaticServer } from '../server.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

async function withServer(run) {
  const server = createStaticServer(PROJECT_ROOT);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    await run(server.address().port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function getResponse(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      agent: false,
      headers: { Connection: 'close' },
    }, res => {
      res.resume();
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

function getBodyResponse(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function get(port, path) {
  return (await getResponse(port, path)).statusCode;
}

test('malformed URL encoding returns 400 without stopping the server', async () => {
  await withServer(async port => {
    assert.equal(await get(port, '/%E0%A4%A'), 400);
    assert.equal(await get(port, '/'), 200);
  });
});

test('only browser assets are exposed by the static server', async () => {
  await withServer(async port => {
    assert.equal(await get(port, '/src/main.js'), 200);
    assert.equal(await get(port, '/vendor/three.module.js'), 200);
    assert.equal(await get(port, '/package.json'), 404);
    assert.equal(await get(port, '/.git/HEAD'), 404);
    assert.equal(await get(port, '/.claude/settings.local.json'), 404);
  });
});

test('MP3 sound assets are public and served with an audio MIME type', async () => {
  await withServer(async port => {
    const response = await getResponse(
      port, '/sound/Rainbow%20Kart%20Parade%20(0.90x).mp3');
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'audio/mpeg');
  });
});

test('health provider exposes aggregate counts without exposing room data', async () => {
  const server = createStaticServer(PROJECT_ROOT, {
    healthProvider: () => ({ uptimeSeconds: 12, rooms: 2, races: 1, connections: 3 }),
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const response = await getBodyResponse(server.address().port, '/healthz');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), {
      status: 'ok', uptimeSeconds: 12, rooms: 2, races: 1, connections: 3,
    });
    assert.equal(response.body.includes('roomCode'), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
