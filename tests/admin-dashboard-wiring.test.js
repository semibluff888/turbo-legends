import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/admin/admin.js', import.meta.url), 'utf8');

test('admin dashboard displays room and active-race values from public server stats', () => {
  assert.match(source, /Promise\.all\(\[\s*[\s\S]*api\('\/api\/stats'\)[\s\S]*\]\)/u);
  assert.match(source, /\['在线房间', number\(serverStats\.rooms\)\]/u);
  assert.match(source, /\['进行中比赛', number\(serverStats\.activeRaces\)\]/u);
  assert.match(source, /renderMetrics\(dashboard, serverStats\)/u);
});

test('admin dashboard persists the Bot ready-timeout setting independently', () => {
  assert.match(source, /botRoomReadyTimeoutSeconds/u);
  assert.match(source, /botRoomReadyTimeoutSave\.addEventListener\('click'/u);
  assert.match(source, /body: \{ botRoomReadyTimeoutSeconds: requested \}/u);
});
