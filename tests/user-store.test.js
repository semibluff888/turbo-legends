import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UserStore, levelProgress, levelThreshold } from '../server/user-store.js';

function createUser(store, displayName) {
  return store.createOrResumeSession({ displayName });
}

test('level thresholds use the triangular progression curve', () => {
  assert.equal(levelThreshold(1), 0);
  assert.equal(levelThreshold(2), 100);
  assert.equal(levelThreshold(3), 300);
  assert.deepEqual(levelProgress(299), { level: 2, currentLevelXp: 199, nextLevelXp: 200 });
  assert.deepEqual(levelProgress(300), { level: 3, currentLevelXp: 0, nextLevelXp: 300 });
});

test('guest sessions restore profiles and nickname changes persist', () => {
  const store = new UserStore({ trackIds: ['sunset-circuit'] });
  try {
    const created = createUser(store, 'Driver');
    assert.equal(created.created, true);
    assert.equal(created.profile.user.displayName, 'Driver');
    const storedSession = store.db.prepare('SELECT session_hash FROM user_sessions').get();
    assert.equal(storedSession.session_hash.length, 64);
    assert.notEqual(storedSession.session_hash, created.token);
    const resumed = store.createOrResumeSession({ token: created.token, displayName: 'Ignored' });
    assert.equal(resumed.created, false);
    assert.equal(resumed.userId, created.userId);
    assert.equal(store.updateDisplayName(created.userId, 'Renamed').user.displayName, 'Renamed');
  } finally {
    store.close();
  }
});

test('expired or deleted guest sessions create a fresh user on the next multiplayer entry', () => {
  let now = 1_000;
  const store = new UserStore({ now: () => now, sessionTtlMs: 100 });
  try {
    const first = createUser(store, 'First Guest');
    now += 101;
    assert.equal(store.resolveSession(first.token), null);
    const afterExpiry = store.createOrResumeSession({
      token: first.token,
      displayName: 'After Expiry',
    });
    assert.notEqual(afterExpiry.userId, first.userId);

    store.db.prepare('DELETE FROM users WHERE user_id = ?').run(afterExpiry.userId);
    const afterDelete = store.createOrResumeSession({
      token: afterExpiry.token,
      displayName: 'After Delete',
    });
    assert.notEqual(afterDelete.userId, afterExpiry.userId);
    assert.equal(afterDelete.profile.user.displayName, 'After Delete');
  } finally {
    store.close();
  }
});

test('file-backed SQLite profiles and sessions survive a store restart with WAL enabled', () => {
  const directory = mkdtempSync(join(tmpdir(), 'turbo-legends-users-'));
  const path = join(directory, 'users.sqlite');
  let created;
  try {
    const firstStore = new UserStore({ path, trackIds: ['sunset-circuit'] });
    try {
      created = createUser(firstStore, 'Persistent Driver');
      firstStore.updateDisplayName(created.userId, 'Persistent Rename');
      assert.equal(firstStore.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
      assert.equal(firstStore.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
      assert.equal(firstStore.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
    } finally {
      firstStore.close();
    }

    const restarted = new UserStore({ path, trackIds: ['sunset-circuit'] });
    try {
      const restored = restarted.resolveSession(created.token);
      assert.equal(restored.userId, created.userId);
      assert.equal(restored.profile.user.displayName, 'Persistent Rename');
    } finally {
      restarted.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('schema version 1 migrates to race-start persistence without losing users or sessions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'turbo-legends-users-v1-'));
  const path = join(directory, 'users.sqlite');
  let created;
  try {
    const legacy = new UserStore({ path });
    try {
      created = createUser(legacy, 'Legacy Driver');
      legacy.db.exec(`
        DROP INDEX race_user_starts_user_idx;
        DROP TABLE race_user_starts;
        PRAGMA user_version = 1;
      `);
    } finally {
      legacy.close();
    }

    const migrated = new UserStore({ path });
    try {
      assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, 2);
      const table = migrated.db.prepare(`
        SELECT count(*) AS count FROM sqlite_master
        WHERE type = 'table' AND name = 'race_user_starts'
      `).get();
      assert.equal(table.count, 1);
      assert.equal(migrated.resolveSession(created.token).userId, created.userId);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('race settlement applies XP, podium stats, Elo and fastest finish atomically', () => {
  const store = new UserStore({ trackIds: ['sunset-circuit'] });
  try {
    const first = createUser(store, 'First');
    const second = createUser(store, 'Second');
    const settlement = {
      raceId: 'race-one',
      trackId: 'sunset-circuit',
      roomType: 'public',
      participants: [
        { userId: first.userId, participantId: 'p1', officialRank: 1, kartIndex: 0, completed: true, finishTimeMs: 90000, escaped: false },
        { userId: second.userId, participantId: 'p2', officialRank: 3, kartIndex: 1, completed: false, finishTimeMs: null, escaped: false },
      ],
    };
    assert.equal(store.startRace(settlement), 2);
    assert.equal(store.startRace(settlement), 0);
    assert.equal(store.getProfile(first.userId).stats.races, 1);
    const updates = store.settleRace(settlement);
    assert.equal(updates.get(first.userId).xpDelta, 60);
    assert.equal(updates.get(first.userId).ratingDelta, 16);
    assert.equal(updates.get(second.userId).xpDelta, 30);
    assert.equal(updates.get(second.userId).ratingDelta, -16);
    assert.equal(updates.get(first.userId).bestTimeUpdated, true);

    const firstProfile = store.getProfile(first.userId);
    assert.deepEqual(firstProfile.stats, {
      races: 1, finishes: 1, completionRate: 1, escapes: 0, escapeRate: 0,
      firsts: 1, seconds: 0, thirds: 0,
    });
    assert.equal(firstProfile.trackBestTimes[0].finishTimeMs, 90000);
    const secondProfile = store.getProfile(second.userId);
    assert.equal(secondProfile.stats.races, 1);
    assert.equal(secondProfile.stats.finishes, 0);
    assert.equal(secondProfile.stats.thirds, 1);

    store.settleRace(settlement);
    assert.equal(store.getProfile(first.userId).stats.races, 1);
    assert.equal(store.getProfile(first.userId).user.xp, 60);
  } finally {
    store.close();
  }
});

test('escaped racers count a race and escape but are excluded from rewards and Elo', () => {
  const store = new UserStore({ trackIds: ['sunset-circuit'] });
  try {
    const finisher = createUser(store, 'Finisher');
    const escaped = createUser(store, 'Escaped');
    const updates = store.settleRace({
      raceId: 'race-escape',
      trackId: 'sunset-circuit',
      roomType: 'private',
      participants: [
        { userId: finisher.userId, participantId: 'p1', officialRank: 2, kartIndex: 0, completed: true, finishTimeMs: 100000, escaped: false },
        { userId: escaped.userId, participantId: 'p2', officialRank: 1, kartIndex: 1, completed: true, finishTimeMs: 90000, escaped: true },
      ],
    });
    assert.equal(updates.get(finisher.userId).ratingDelta, 0);
    assert.equal(updates.get(escaped.userId).xpDelta, 0);
    const escapedProfile = store.getProfile(escaped.userId);
    assert.equal(escapedProfile.stats.races, 1);
    assert.equal(escapedProfile.stats.escapes, 1);
    assert.equal(escapedProfile.stats.escapeRate, 1);
    assert.equal(escapedProfile.stats.finishes, 0);
    assert.equal(escapedProfile.stats.firsts, 0);
    assert.equal(escapedProfile.trackBestTimes[0].finishTimeMs, null);
    const storedResult = store.db.prepare(`
      SELECT completed, finish_time_ms FROM race_user_results
      WHERE race_id = ? AND user_id = ?
    `).get('race-escape', escaped.userId);
    assert.equal(storedResult.completed, 0);
    assert.equal(storedResult.finish_time_ms, null);
  } finally {
    store.close();
  }
});

test('track records only replace slower natural finishes', () => {
  const store = new UserStore({ trackIds: ['sunset-circuit'] });
  try {
    const user = createUser(store, 'Record');
    for (const [raceId, finishTimeMs] of [['r1', 100000], ['r2', 105000], ['r3', 95000]]) {
      store.settleRace({
        raceId,
        trackId: 'sunset-circuit',
        roomType: 'public',
        participants: [{
          userId: user.userId, participantId: 'p1', officialRank: 1, kartIndex: 0,
          completed: true, finishTimeMs, escaped: false,
        }],
      });
    }
    assert.equal(store.getProfile(user.userId).trackBestTimes[0].finishTimeMs, 95000);
  } finally {
    store.close();
  }
});

test('Rating uses current opponent strength and never drops below zero', () => {
  const store = new UserStore();
  try {
    const loser = createUser(store, 'Low Rated');
    const winner = createUser(store, 'Lower Rated');
    store.db.prepare('UPDATE users SET rating = 5 WHERE user_id = ?').run(loser.userId);
    store.db.prepare('UPDATE users SET rating = 0 WHERE user_id = ?').run(winner.userId);

    const updates = store.settleRace({
      raceId: 'rating-floor', trackId: 'sunset-circuit', roomType: 'public',
      participants: [
        { userId: winner.userId, participantId: 'p1', officialRank: 1, kartIndex: 0, completed: true, finishTimeMs: 1000, escaped: false },
        { userId: loser.userId, participantId: 'p2', officialRank: 2, kartIndex: 1, completed: true, finishTimeMs: 1100, escaped: false },
      ],
    });
    assert.equal(updates.get(loser.userId).ratingDelta, -5);
    assert.equal(store.getProfile(loser.userId).user.rating, 0);
  } finally {
    store.close();
  }
});

test('deleting a user cascades sessions, results and track records', () => {
  const store = new UserStore({ trackIds: ['sunset-circuit'] });
  try {
    const user = createUser(store, 'Delete Me');
    store.settleRace({
      raceId: 'delete-race', trackId: 'sunset-circuit', roomType: 'public',
      participants: [{
        userId: user.userId, participantId: 'p1', officialRank: 1, kartIndex: 0,
        completed: true, finishTimeMs: 1000, escaped: false,
      }],
    });
    store.db.prepare('DELETE FROM users WHERE user_id = ?').run(user.userId);
    assert.equal(store.db.prepare('SELECT count(*) AS count FROM user_sessions').get().count, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS count FROM race_user_results').get().count, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS count FROM race_user_starts').get().count, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS count FROM user_track_records').get().count, 0);
  } finally {
    store.close();
  }
});
