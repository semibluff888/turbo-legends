import test from 'node:test';
import assert from 'node:assert/strict';

import { RoomManager } from '../server/room-manager.js';
import { ScryptQueue, ScryptQueueFullError } from '../server/scrypt-queue.js';

test('scrypt queue enforces its active and waiting bounds', async () => {
  const releases = [];
  const queue = new ScryptQueue({
    concurrency: 1,
    queueLimit: 1,
    scrypt: () => new Promise((resolve) => releases.push(resolve)),
  });
  const first = queue.run('one', Buffer.alloc(1), 32);
  await Promise.resolve();
  const second = queue.run('two', Buffer.alloc(1), 32);
  await assert.rejects(
    queue.run('three', Buffer.alloc(1), 32),
    error => error instanceof ScryptQueueFullError,
  );

  releases.shift()(Buffer.alloc(32, 1));
  assert.equal((await first).length, 32);
  await Promise.resolve();
  await Promise.resolve();
  releases.shift()(Buffer.alloc(32, 2));
  assert.equal((await second)[0], 2);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(queue.active, 0);
  assert.equal(queue.waiting.length, 0);
});

test('private room authentication returns stable server_busy when the queue is full', async () => {
  let release;
  const queue = new ScryptQueue({
    concurrency: 1,
    queueLimit: 0,
    scrypt: () => new Promise((resolve) => { release = resolve; }),
  });
  const blocker = queue.run('blocker', Buffer.alloc(1), 32);
  await Promise.resolve();
  const manager = new RoomManager({ scryptQueue: queue });
  await assert.rejects(manager.createRoom({
    displayName: 'Host', roomName: 'Private', roomType: 'private', maxPlayers: 2,
    password: 'Secret7',
  }), error => error.code === 'server_busy' && error.message === 'The server is busy. Try again shortly.');

  release(Buffer.alloc(32));
  await blocker;
  manager.close();
});
