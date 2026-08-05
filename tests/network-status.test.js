import test from 'node:test';
import assert from 'node:assert/strict';

import { latencyLevel, NetworkStatus } from '../src/ui/network-status.js';

function node() {
  return { dataset: {}, hidden: false, textContent: '' };
}

function makeRoot() {
  const nodes = new Map([
    ['.network-summary', node()],
    ['[data-network-connection]', node()],
    ['[data-network-state]', node()],
    ['[data-network-online]', node()],
    ['[data-network-online-separator]', node()],
    ['[data-network-latency]', node()],
    ['[data-game-version]', node()],
  ]);
  return {
    hidden: true,
    dataset: {},
    innerHTML: '',
    querySelector(selector) { return nodes.get(selector) || null; },
    nodes,
  };
}

test('latency levels use the requested inclusive boundaries', () => {
  assert.equal(latencyLevel(0), 'good');
  assert.equal(latencyLevel(200), 'good');
  assert.equal(latencyLevel(201), 'warning');
  assert.equal(latencyLevel(800), 'warning');
  assert.equal(latencyLevel(801), 'bad');
  assert.equal(latencyLevel(null), 'unknown');
  assert.equal(latencyLevel(-1), 'unknown');
  assert.equal(latencyLevel('invalid'), 'unknown');
});

test('network status switches detailed and race fields without retaining stale metrics', () => {
  const root = makeRoot();
  const view = new NetworkStatus(root, { language: 'en' });
  const online = root.nodes.get('[data-network-online]');
  const summary = root.nodes.get('.network-summary');
  const separator = root.nodes.get('[data-network-online-separator]');
  const latency = root.nodes.get('[data-network-latency]');
  const version = root.nodes.get('[data-game-version]');

  view.setConnectionState('connected');
  view.setMetrics({ latencyMs: 43.4, onlineCount: 12 });
  view.setVersion('1.2.3');
  view.showDetails();
  assert.equal(root.dataset.context, 'details');
  assert.ok(
    root.innerHTML.indexOf('data-network-online') < root.innerHTML.indexOf('data-network-connection'),
    'online player count should appear before the network connection state',
  );
  assert.equal(online.textContent, 'ONLINE PLAYERS 12');
  assert.equal(latency.textContent, '43 ms');
  assert.equal(latency.dataset.level, 'good');
  assert.equal(version.textContent, 'VERSION 1.2.3');

  view.setLanguage('zh-CN');
  assert.equal(online.textContent, '在线玩家 12');
  assert.equal(version.textContent, '版本 1.2.3');
  view.setLanguage('en');

  view.showVersion();
  assert.equal(root.dataset.context, 'version');
  assert.equal(root.hidden, false);
  assert.equal(summary.hidden, true);
  assert.equal(version.hidden, false);

  view.showDetails();
  assert.equal(summary.hidden, false);

  view.setMetrics({ latencyMs: null, onlineCount: null });
  assert.equal(online.textContent, 'ONLINE PLAYERS —');
  assert.equal(latency.textContent, '— ms');
  assert.equal(latency.dataset.level, 'unknown');
  view.setMetrics({ latencyMs: 43.4, onlineCount: 12 });

  view.showRace();
  assert.equal(root.dataset.context, 'race');
  assert.equal(online.hidden, true);
  assert.equal(separator.hidden, true);
  assert.equal(version.hidden, true);

  view.setConnectionState('reconnecting');
  assert.equal(online.textContent, 'ONLINE PLAYERS —');
  assert.equal(latency.textContent, '— ms');
  assert.equal(latency.dataset.level, 'unknown');
});

test('version loader uses only server metadata and preserves the unknown fallback', async () => {
  const root = makeRoot();
  const view = new NetworkStatus(root, { language: 'en' });
  const version = root.nodes.get('[data-game-version]');

  const loaded = await view.loadVersion(async (url, options) => {
    assert.equal(url, '/api/meta');
    assert.deepEqual(options, { cache: 'no-store' });
    return { ok: true, async json() { return { version: '2.4.6', private: true }; } };
  });
  assert.equal(loaded, '2.4.6');
  assert.equal(version.textContent, 'VERSION 2.4.6');

  const failed = await view.loadVersion(async () => ({ ok: false }));
  assert.equal(failed, null);
  assert.equal(version.textContent, 'VERSION —');
});
