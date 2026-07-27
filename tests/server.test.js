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

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      agent: false,
      headers: { Connection: 'close' },
    }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
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
