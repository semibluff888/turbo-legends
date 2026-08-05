import test from 'node:test';
import assert from 'node:assert/strict';

import { RACE_STATE } from '../src/core/constants.js';
import { standingsStatus } from '../src/ui/hud.js';

test('live standings status follows presence, finish, AI and race-state priority', () => {
  assert.deepEqual(
    standingsStatus({ presenceState: 'left', finished: true }, RACE_STATE.RACING, 'en'),
    { key: 'left', label: 'LEFT ROOM' },
  );
  assert.deepEqual(
    standingsStatus({ presenceState: 'disconnected', finished: true }, RACE_STATE.RACING, 'en'),
    { key: 'disconnected', label: 'DISCONNECTED' },
  );
  assert.deepEqual(
    standingsStatus({ presenceState: 'reconnecting', controllerKind: 'takeover-ai' }, RACE_STATE.RACING, 'en'),
    { key: 'reconnecting', label: 'RECONNECTING' },
  );
  assert.deepEqual(
    standingsStatus({ connected: true, finished: true, controllerKind: 'human' }, RACE_STATE.RACING, 'en'),
    { key: 'finished', label: 'FINISHED' },
  );
  assert.deepEqual(
    standingsStatus({ controllerKind: 'takeover-ai' }, RACE_STATE.RACING, 'en'),
    { key: 'takeover', label: 'AI TAKE OVER' },
  );
  assert.deepEqual(
    standingsStatus({ controllerKind: 'ai' }, RACE_STATE.RACING, 'en'),
    { key: 'ai', label: 'AI RACER' },
  );
  assert.deepEqual(
    standingsStatus({ controllerKind: 'human' }, RACE_STATE.COUNTDOWN, 'en'),
    { key: 'ready', label: 'READY' },
  );
  assert.deepEqual(
    standingsStatus({ controllerKind: 'human' }, RACE_STATE.RACING, 'en'),
    { key: 'racing', label: 'RACING' },
  );
  assert.deepEqual(
    standingsStatus({ connected: false, controllerKind: 'takeover-ai' }, RACE_STATE.RACING, 'en'),
    { key: 'reconnecting', label: 'RECONNECTING' },
  );
  assert.deepEqual(
    standingsStatus({ presenceState: 'left' }, RACE_STATE.RACING, 'zh-CN'),
    { key: 'left', label: '已离开房间' },
  );
});
