import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';

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

function getBodyResponse(port, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers, agent: false }, res => {
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

function getBufferResponse(port, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
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

test('root invite links serve the application entry page', async () => {
  await withServer(async port => {
    const response = await getBodyResponse(port, '/?room=ZGM94X');
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'], /^text\/html/);
    assert.match(response.body, /<html\b/i);
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

test('metadata endpoint exposes only the configured version without caching', async () => {
  const server = createStaticServer(PROJECT_ROOT, {
    metadataProvider: () => ({ version: '9.8.7' }),
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const response = await getBodyResponse(server.address().port, '/api/meta');
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(response.body), { version: '9.8.7' });
    assert.equal(response.body.includes('dependencies'), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('public stats endpoint exposes aggregate capacity data with short caching', async () => {
  const server = createStaticServer(PROJECT_ROOT, {
    statsProvider: () => ({
      version: '1.2.3', serverTime: 1234, onlineCount: 7, rooms: 3, activeRaces: 2,
    }),
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const response = await getBodyResponse(server.address().port, '/api/stats');
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'public, max-age=5, stale-while-revalidate=10');
    assert.deepEqual(JSON.parse(response.body), {
      version: '1.2.3', serverTime: 1234, onlineCount: 7, rooms: 3, activeRaces: 2,
    });
    for (const sensitive of ['roomCode', 'displayName', 'ip', 'resumeToken']) {
      assert.equal(response.body.includes(sensitive), false);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('metrics endpoint is disabled without a token and protected when enabled', async () => {
  const disabled = createStaticServer(PROJECT_ROOT, {
    metricsProvider: () => ({ tick: { count: 1 } }),
  });
  await new Promise((resolve, reject) => {
    disabled.once('error', reject);
    disabled.listen(0, '127.0.0.1', resolve);
  });
  try {
    assert.equal((await getBodyResponse(disabled.address().port, '/api/metrics')).statusCode, 404);
  } finally {
    await new Promise(resolve => disabled.close(resolve));
  }

  const enabled = createStaticServer(PROJECT_ROOT, {
    metricsProvider: () => ({ tick: { count: 1 } }),
    metricsToken: 'test-secret',
  });
  await new Promise((resolve, reject) => {
    enabled.once('error', reject);
    enabled.listen(0, '127.0.0.1', resolve);
  });
  try {
    const unauthorized = await getBodyResponse(enabled.address().port, '/api/metrics');
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(unauthorized.headers['cache-control'], 'no-store');
    const response = await getBodyResponse(enabled.address().port, '/api/metrics', {
      headers: { Authorization: 'Bearer test-secret' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(response.body), { tick: { count: 1 } });
  } finally {
    await new Promise(resolve => enabled.close(resolve));
  }
});

test('static files support validators, HEAD, compression and cache policy', async () => {
  await withServer(async port => {
    const source = await readFile(new URL('../src/main.js', import.meta.url));
    const first = await getBufferResponse(port, '/src/main.js');
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers['cache-control'], 'public, max-age=0, must-revalidate');
    assert.match(first.headers.etag, /^W\//);
    assert.ok(first.headers['last-modified']);
    assert.equal(first.headers['accept-ranges'], 'bytes');
    assert.equal(first.headers.vary, 'Accept-Encoding');
    assert.deepEqual(first.body, source);

    const notModified = await getBufferResponse(port, '/src/main.js', {
      headers: { 'If-None-Match': first.headers.etag },
    });
    assert.equal(notModified.statusCode, 304);
    assert.equal(notModified.body.length, 0);

    const etagPrecedence = await getBufferResponse(port, '/src/main.js', {
      headers: {
        'If-None-Match': 'W/"does-not-match"',
        'If-Modified-Since': new Date(Date.now() + 86_400_000).toUTCString(),
      },
    });
    assert.equal(etagPrecedence.statusCode, 200);

    const head = await getBufferResponse(port, '/src/main.js', { method: 'HEAD' });
    assert.equal(head.statusCode, 200);
    assert.equal(Number(head.headers['content-length']), source.length);
    assert.equal(head.body.length, 0);

    const brotli = await getBufferResponse(port, '/src/main.js', {
      headers: { 'Accept-Encoding': 'gzip, br' },
    });
    assert.equal(brotli.statusCode, 200);
    assert.equal(brotli.headers['content-encoding'], 'br');
    assert.deepEqual(brotliDecompressSync(brotli.body), source);

    const gzipped = await getBufferResponse(port, '/src/main.js', {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    assert.equal(gzipped.headers['content-encoding'], 'gzip');
    assert.deepEqual(gunzipSync(gzipped.body), source);

    const index = await getBufferResponse(port, '/');
    assert.equal(index.headers['cache-control'], 'no-cache');
  });
});

test('static files support one raw byte range, If-Range, and 416 responses', async () => {
  await withServer(async port => {
    const source = await readFile(new URL('../src/main.js', import.meta.url));
    const full = await getBufferResponse(port, '/src/main.js');
    const range = await getBufferResponse(port, '/src/main.js', {
      headers: { Range: 'bytes=10-29', 'Accept-Encoding': 'br' },
    });
    assert.equal(range.statusCode, 206);
    assert.equal(range.headers['content-range'], `bytes 10-29/${source.length}`);
    assert.equal(range.headers['content-encoding'], undefined);
    assert.deepEqual(range.body, source.subarray(10, 30));

    const matchingIfRange = await getBufferResponse(port, '/src/main.js', {
      headers: { Range: 'bytes=-12', 'If-Range': full.headers.etag },
    });
    assert.equal(matchingIfRange.statusCode, 206);
    assert.deepEqual(matchingIfRange.body, source.subarray(source.length - 12));

    const staleIfRange = await getBufferResponse(port, '/src/main.js', {
      headers: { Range: 'bytes=0-9', 'If-Range': 'W/"stale"' },
    });
    assert.equal(staleIfRange.statusCode, 200);
    assert.deepEqual(staleIfRange.body, source);

    for (const invalidRange of [`bytes=${source.length}-`, 'bytes=0-1,4-5']) {
      const response = await getBufferResponse(port, '/src/main.js', {
        headers: { Range: invalidRange },
      });
      assert.equal(response.statusCode, 416);
      assert.equal(response.headers['content-range'], `bytes */${source.length}`);
    }
  });
});
