import test from 'node:test';
import assert from 'node:assert/strict';

import { RACE_STATE } from '../src/core/constants.js';
import { usesOfflineNameBadge } from '../src/render/kartMesh.js';
import { standingsStatus } from '../src/ui/hud.js';

test('live standings status follows offline, finish and controller priority', () => {
  assert.deepEqual(
    standingsStatus({ connected: false, finished: true, controllerKind: 'takeover-ai' }, RACE_STATE.RACING),
    { key: 'offline', label: 'OFFLINE' },
  );
  assert.deepEqual(
    standingsStatus({ connected: true, finished: true, controllerKind: 'human' }, RACE_STATE.RACING),
    { key: 'finished', label: 'FINISHED' },
  );
  assert.deepEqual(
    standingsStatus({ connected: true, controllerKind: 'takeover-ai' }, RACE_STATE.RACING),
    { key: 'takeover', label: 'AI TAKEOVER' },
  );
  assert.deepEqual(
    standingsStatus({ controllerKind: 'ai' }, RACE_STATE.RACING),
    { key: 'ai', label: 'AI RACER' },
  );
  assert.deepEqual(
    standingsStatus({ controllerKind: 'human' }, RACE_STATE.COUNTDOWN),
    { key: 'ready', label: 'READY' },
  );
  assert.deepEqual(
    standingsStatus({ controllerKind: 'human' }, RACE_STATE.RACING),
    { key: 'racing', label: 'RACING' },
  );
});

test('only disconnected human seats receive the OFFLINE name badge', () => {
  assert.equal(usesOfflineNameBadge({ connected: false, controllerKind: 'takeover-ai' }), true);
  assert.equal(usesOfflineNameBadge({ connected: true, controllerKind: 'takeover-ai' }), false);
  assert.equal(usesOfflineNameBadge({ connected: false, controllerKind: 'ai' }), false);
});
