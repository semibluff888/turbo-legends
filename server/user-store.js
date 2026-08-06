import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const USER_SESSION_COOKIE = 'turbo_legends_user';
export const DEFAULT_USER_SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
export const DEFAULT_RATING = 1000;
export const RATING_K = 32;

function opaqueId(bytes) {
  return randomBytes(bytes).toString('base64url');
}

export function sessionTokenHash(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

export function parseCookies(header = '') {
  const cookies = new Map();
  for (const chunk of String(header || '').split(';')) {
    const index = chunk.indexOf('=');
    if (index <= 0) continue;
    const name = chunk.slice(0, index).trim();
    const value = chunk.slice(index + 1).trim();
    if (!name) continue;
    try { cookies.set(name, decodeURIComponent(value)); } catch { cookies.set(name, value); }
  }
  return cookies;
}

export function sessionTokenFromRequest(request) {
  return parseCookies(request?.headers?.cookie).get(USER_SESSION_COOKIE) || '';
}

export function levelThreshold(level) {
  const normalized = Math.max(1, Math.trunc(Number(level) || 1));
  return 50 * (normalized - 1) * normalized;
}

export function levelProgress(xpValue) {
  const xp = Math.max(0, Math.trunc(Number(xpValue) || 0));
  let level = Math.max(1, Math.floor((1 + Math.sqrt(1 + xp * 0.08)) / 2));
  while (levelThreshold(level + 1) <= xp) level++;
  while (level > 1 && levelThreshold(level) > xp) level--;
  const currentStart = levelThreshold(level);
  const nextStart = levelThreshold(level + 1);
  return {
    level,
    currentLevelXp: xp - currentStart,
    nextLevelXp: nextStart - currentStart,
  };
}

function finiteInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function normalizedFinishTimeMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function placementXp(rank) {
  if (rank === 1) return 30;
  if (rank === 2) return 20;
  if (rank === 3) return 10;
  return 0;
}

function computeRatingDeltas(participants, ratings) {
  const eligible = participants
    .filter((participant) => !participant.escaped)
    .slice()
    .sort((a, b) => (a.officialRank - b.officialRank)
      || (a.kartIndex - b.kartIndex)
      || a.userId.localeCompare(b.userId));
  const deltas = new Map(eligible.map((participant) => [participant.userId, 0]));
  if (eligible.length < 2) return { eligible, deltas };

  for (let index = 0; index < eligible.length; index++) {
    const current = eligible[index];
    const currentRating = ratings.get(current.userId) ?? DEFAULT_RATING;
    let score = 0;
    for (let opponentIndex = 0; opponentIndex < eligible.length; opponentIndex++) {
      if (opponentIndex === index) continue;
      const opponent = eligible[opponentIndex];
      const opponentRating = ratings.get(opponent.userId) ?? DEFAULT_RATING;
      const expected = 1 / (1 + 10 ** ((opponentRating - currentRating) / 400));
      const actual = current.officialRank < opponent.officialRank
        ? 1
        : current.officialRank > opponent.officialRank ? 0 : 0.5;
      score += actual - expected;
    }
    deltas.set(current.userId, Math.round(RATING_K * score / (eligible.length - 1)));
  }
  return { eligible, deltas };
}

export class UserStore {
  constructor({
    path = ':memory:',
    now = () => Date.now(),
    sessionTtlMs = DEFAULT_USER_SESSION_TTL_MS,
    userIdFactory = () => opaqueId(16),
    sessionTokenFactory = () => opaqueId(32),
    trackIds = [],
  } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.path = path;
    this.now = now;
    this.sessionTtlMs = sessionTtlMs;
    this.userIdFactory = userIdFactory;
    this.sessionTokenFactory = sessionTokenFactory;
    this.trackIds = [...new Set(trackIds.map(String))];
    this.db = new DatabaseSync(path);
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
    `);
    if (this.path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version || 0);
    if (version > 3) throw new Error(`Unsupported user database version: ${version}`);
    if (version === 0) this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE users (
        user_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        xp INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
        rating INTEGER NOT NULL DEFAULT 1000 CHECK (rating >= 0),
        races INTEGER NOT NULL DEFAULT 0 CHECK (races >= 0),
        finishes INTEGER NOT NULL DEFAULT 0 CHECK (finishes >= 0),
        escapes INTEGER NOT NULL DEFAULT 0 CHECK (escapes >= 0),
        firsts INTEGER NOT NULL DEFAULT 0 CHECK (firsts >= 0),
        seconds INTEGER NOT NULL DEFAULT 0 CHECK (seconds >= 0),
        thirds INTEGER NOT NULL DEFAULT 0 CHECK (thirds >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE user_sessions (
        session_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX user_sessions_expires_at_idx ON user_sessions(expires_at);
      CREATE TABLE races (
        race_id TEXT PRIMARY KEY,
        track_id TEXT NOT NULL,
        room_type TEXT NOT NULL,
        human_count INTEGER NOT NULL,
        settled_at INTEGER NOT NULL
      );
      CREATE TABLE race_user_results (
        race_id TEXT NOT NULL REFERENCES races(race_id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        participant_id TEXT,
        official_rank INTEGER NOT NULL,
        human_rank INTEGER,
        completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
        escaped INTEGER NOT NULL CHECK (escaped IN (0, 1)),
        finish_time_ms INTEGER,
        xp_before INTEGER NOT NULL,
        xp_delta INTEGER NOT NULL,
        rating_before INTEGER NOT NULL,
        rating_delta INTEGER NOT NULL,
        best_time_updated INTEGER NOT NULL CHECK (best_time_updated IN (0, 1)),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (race_id, user_id)
      );
      CREATE INDEX race_user_results_user_idx ON race_user_results(user_id, created_at DESC);
      CREATE TABLE user_track_records (
        user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        track_id TEXT NOT NULL,
        best_finish_time_ms INTEGER NOT NULL,
        race_id TEXT REFERENCES races(race_id) ON DELETE SET NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, track_id)
      );
      PRAGMA user_version = 1;
      COMMIT;
    `);
    const currentVersion = Number(this.db.prepare('PRAGMA user_version').get()?.user_version || 0);
    if (currentVersion < 2) this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE race_user_starts (
        race_id TEXT NOT NULL REFERENCES races(race_id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        participant_id TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (race_id, user_id)
      );
      CREATE INDEX race_user_starts_user_idx ON race_user_starts(user_id, created_at DESC);
      PRAGMA user_version = 2;
      COMMIT;
    `);
    const leaderboardVersion = Number(
      this.db.prepare('PRAGMA user_version').get()?.user_version || 0,
    );
    if (leaderboardVersion < 3) this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE INDEX users_rating_leaderboard_idx
        ON users(rating DESC, firsts DESC, xp DESC, user_id ASC)
        WHERE races > 0;
      CREATE INDEX users_champions_leaderboard_idx
        ON users(firsts DESC, rating DESC, xp DESC, user_id ASC)
        WHERE firsts > 0;
      CREATE INDEX users_level_leaderboard_idx
        ON users(xp DESC, rating DESC, firsts DESC, user_id ASC)
        WHERE races > 0;
      CREATE INDEX user_track_records_leaderboard_idx
        ON user_track_records(track_id, best_finish_time_ms ASC, updated_at ASC, user_id ASC);
      PRAGMA user_version = 3;
      COMMIT;
    `);
  }

  close() {
    this.db.close();
  }

  deleteExpiredSessions(now = this.now()) {
    return this.db.prepare('DELETE FROM user_sessions WHERE expires_at <= ?').run(now).changes;
  }

  resolveSession(token, { touch = true } = {}) {
    if (!token) return null;
    const hash = sessionTokenHash(token);
    const now = this.now();
    const row = this.db.prepare(`
      SELECT s.user_id, s.expires_at
      FROM user_sessions s
      JOIN users u ON u.user_id = s.user_id
      WHERE s.session_hash = ?
    `).get(hash);
    if (!row || row.expires_at <= now) {
      if (row) this.db.prepare('DELETE FROM user_sessions WHERE session_hash = ?').run(hash);
      return null;
    }
    if (touch) {
      this.db.prepare('UPDATE user_sessions SET last_seen_at = ? WHERE session_hash = ?')
        .run(now, hash);
    }
    return { userId: row.user_id, profile: this.getProfile(row.user_id) };
  }

  createOrResumeSession({ token = '', displayName = 'Racer' } = {}) {
    const existing = this.resolveSession(token);
    if (existing) return { ...existing, created: false, token: null };

    const now = this.now();
    const userId = this.userIdFactory();
    const sessionToken = this.sessionTokenFactory();
    const sessionHash = sessionTokenHash(sessionToken);
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.prepare(`
        INSERT INTO users (user_id, display_name, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(userId, displayName, now, now);
      this.db.prepare(`
        INSERT INTO user_sessions (session_hash, user_id, created_at, last_seen_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(sessionHash, userId, now, now, now + this.sessionTtlMs);
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
    return {
      userId,
      created: true,
      token: sessionToken,
      profile: this.getProfile(userId),
    };
  }

  updateDisplayName(userId, displayName) {
    const result = this.db.prepare(`
      UPDATE users SET display_name = ?, updated_at = ? WHERE user_id = ?
    `).run(displayName, this.now(), userId);
    return result.changes ? this.getProfile(userId) : null;
  }

  getProfile(userId) {
    const row = this.db.prepare(`
      SELECT display_name, xp, rating, races, finishes, escapes, firsts, seconds, thirds
      FROM users WHERE user_id = ?
    `).get(userId);
    if (!row) return null;
    const xp = finiteInteger(row.xp);
    const progress = levelProgress(xp);
    const races = finiteInteger(row.races);
    const records = new Map(this.db.prepare(`
      SELECT track_id, best_finish_time_ms FROM user_track_records WHERE user_id = ?
    `).all(userId).map((record) => [record.track_id, finiteInteger(record.best_finish_time_ms)]));
    return {
      user: {
        displayName: row.display_name,
        level: progress.level,
        xp,
        currentLevelXp: progress.currentLevelXp,
        nextLevelXp: progress.nextLevelXp,
        rating: finiteInteger(row.rating, DEFAULT_RATING),
      },
      stats: {
        races,
        finishes: finiteInteger(row.finishes),
        completionRate: races > 0 ? finiteInteger(row.finishes) / races : 0,
        escapes: finiteInteger(row.escapes),
        escapeRate: races > 0 ? finiteInteger(row.escapes) / races : 0,
        firsts: finiteInteger(row.firsts),
        seconds: finiteInteger(row.seconds),
        thirds: finiteInteger(row.thirds),
      },
      trackBestTimes: this.trackIds.map((trackId) => ({
        trackId,
        finishTimeMs: records.get(trackId) ?? null,
      })),
    };
  }

  getLeaderboards(limitValue = 10) {
    const limit = Math.max(1, Math.min(10, finiteInteger(limitValue, 10)));
    const rankedUsers = (rows, fields) => rows.map((row, index) => {
      const entry = {
        position: index + 1,
        displayName: row.display_name,
      };
      if (fields.includes('level')) entry.level = levelProgress(row.xp).level;
      if (fields.includes('rating')) entry.rating = finiteInteger(row.rating, DEFAULT_RATING);
      if (fields.includes('firsts')) entry.firsts = finiteInteger(row.firsts);
      return entry;
    });

    const rating = rankedUsers(this.db.prepare(`
      SELECT display_name, xp, rating
      FROM users
      WHERE races > 0
      ORDER BY rating DESC, firsts DESC, xp DESC, user_id ASC
      LIMIT ?
    `).all(limit), ['level', 'rating']);
    const champions = rankedUsers(this.db.prepare(`
      SELECT display_name, xp, firsts
      FROM users
      WHERE firsts > 0
      ORDER BY firsts DESC, rating DESC, xp DESC, user_id ASC
      LIMIT ?
    `).all(limit), ['level', 'firsts']);
    const level = rankedUsers(this.db.prepare(`
      SELECT display_name, xp
      FROM users
      WHERE races > 0
      ORDER BY xp DESC, rating DESC, firsts DESC, user_id ASC
      LIMIT ?
    `).all(limit), ['level']);

    const trackIds = this.trackIds.slice(0, limit);
    let fastestByTrack = new Map();
    if (trackIds.length) {
      const placeholders = trackIds.map(() => '?').join(', ');
      const rows = this.db.prepare(`
        WITH ranked_records AS (
          SELECT
            r.track_id,
            u.display_name,
            r.best_finish_time_ms,
            ROW_NUMBER() OVER (
              PARTITION BY r.track_id
              ORDER BY r.best_finish_time_ms ASC, r.updated_at ASC, r.user_id ASC
            ) AS record_position
          FROM user_track_records r
          JOIN users u ON u.user_id = r.user_id
          WHERE r.track_id IN (${placeholders})
        )
        SELECT track_id, display_name, best_finish_time_ms
        FROM ranked_records
        WHERE record_position = 1
      `).all(...trackIds);
      fastestByTrack = new Map(rows.map((row) => [row.track_id, row]));
    }
    const speed = trackIds.map((trackId) => {
      const row = fastestByTrack.get(trackId);
      return {
        trackId,
        displayName: row?.display_name ?? null,
        finishTimeMs: row ? finiteInteger(row.best_finish_time_ms) : null,
      };
    });

    return { rating, champions, level, speed };
  }

  _existingSettlement(raceId) {
    const rows = this.db.prepare(`
      SELECT user_id, xp_before, xp_delta, rating_before, rating_delta, best_time_updated
      FROM race_user_results WHERE race_id = ?
    `).all(raceId);
    if (!rows.length) return null;
    const updates = new Map();
    for (const row of rows) {
      const xpBefore = finiteInteger(row.xp_before);
      const xpDelta = finiteInteger(row.xp_delta);
      updates.set(row.user_id, {
        xpDelta,
        ratingDelta: finiteInteger(row.rating_delta),
        levelBefore: levelProgress(xpBefore).level,
        levelAfter: levelProgress(xpBefore + xpDelta).level,
        bestTimeUpdated: Boolean(row.best_time_updated),
        profile: this.getProfile(row.user_id),
      });
    }
    return updates;
  }

  startRace({ raceId, trackId, roomType, participants = [] }) {
    const unique = new Map();
    for (const raw of participants) {
      if (!raw?.userId || unique.has(raw.userId)) continue;
      unique.set(raw.userId, {
        userId: String(raw.userId),
        participantId: raw.participantId ? String(raw.participantId) : null,
      });
    }
    const ordered = [...unique.values()];
    if (!ordered.length) return 0;
    const now = this.now();
    let added = 0;
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO races (race_id, track_id, room_type, human_count, settled_at)
        VALUES (?, ?, ?, ?, 0)
      `).run(raceId, trackId, roomType, ordered.length);
      for (const participant of ordered) {
        const result = this.db.prepare(`
          INSERT OR IGNORE INTO race_user_starts (race_id, user_id, participant_id, created_at)
          VALUES (?, ?, ?, ?)
        `).run(raceId, participant.userId, participant.participantId, now);
        if (!result.changes) continue;
        const updated = this.db.prepare(`
          UPDATE users SET races = races + 1, updated_at = ? WHERE user_id = ?
        `).run(now, participant.userId);
        if (!updated.changes) throw new Error(`Cannot start race for missing user ${participant.userId}`);
        added++;
      }
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
    return added;
  }

  settleRace({ raceId, trackId, roomType, participants = [] }) {
    const existing = this._existingSettlement(raceId);
    if (existing) return existing;
    const unique = new Map();
    for (const raw of participants) {
      if (!raw?.userId || unique.has(raw.userId)) continue;
      const escaped = Boolean(raw.escaped);
      const completed = !escaped && Boolean(raw.completed);
      unique.set(raw.userId, {
        userId: String(raw.userId),
        participantId: raw.participantId ? String(raw.participantId) : null,
        officialRank: Math.max(1, finiteInteger(raw.officialRank, 1)),
        kartIndex: Math.max(0, finiteInteger(raw.kartIndex, 0)),
        completed,
        escaped,
        finishTimeMs: completed ? normalizedFinishTimeMs(raw.finishTimeMs) : null,
      });
    }
    const ordered = [...unique.values()];
    if (!ordered.length) return new Map();

    const users = new Map();
    for (const participant of ordered) {
      const row = this.db.prepare('SELECT xp, rating FROM users WHERE user_id = ?')
        .get(participant.userId);
      if (!row) throw new Error(`Cannot settle race for missing user ${participant.userId}`);
      users.set(participant.userId, {
        xp: finiteInteger(row.xp),
        rating: finiteInteger(row.rating, DEFAULT_RATING),
      });
    }
    const ratings = new Map([...users].map(([userId, value]) => [userId, value.rating]));
    const { eligible, deltas } = computeRatingDeltas(ordered, ratings);
    const humanRanks = new Map(eligible.map((participant, index) => [participant.userId, index + 1]));
    const now = this.now();
    const updates = new Map();

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO races (race_id, track_id, room_type, human_count, settled_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(raceId, trackId, roomType, ordered.length, now);
      this.db.prepare(`
        UPDATE races SET track_id = ?, room_type = ?, human_count = ?, settled_at = ?
        WHERE race_id = ?
      `).run(trackId, roomType, ordered.length, now, raceId);

      for (const participant of ordered) {
        const before = users.get(participant.userId);
        const xpDelta = participant.escaped
          ? 0
          : 20 + (participant.completed ? 10 : 0) + placementXp(participant.officialRank);
        const requestedRatingDelta = participant.escaped ? 0 : (deltas.get(participant.userId) ?? 0);
        const ratingAfter = Math.max(0, before.rating + requestedRatingDelta);
        const ratingDelta = ratingAfter - before.rating;
        const finishIncrement = participant.completed && !participant.escaped ? 1 : 0;
        const firstIncrement = !participant.escaped && participant.officialRank === 1 ? 1 : 0;
        const secondIncrement = !participant.escaped && participant.officialRank === 2 ? 1 : 0;
        const thirdIncrement = !participant.escaped && participant.officialRank === 3 ? 1 : 0;
        let bestTimeUpdated = false;
        const raceStart = this.db.prepare(`
          INSERT OR IGNORE INTO race_user_starts (race_id, user_id, participant_id, created_at)
          VALUES (?, ?, ?, ?)
        `).run(raceId, participant.userId, participant.participantId, now);

        this.db.prepare(`
          UPDATE users SET
            xp = xp + ?, rating = ?, races = races + ?,
            finishes = finishes + ?, escapes = escapes + ?,
            firsts = firsts + ?, seconds = seconds + ?, thirds = thirds + ?, updated_at = ?
          WHERE user_id = ?
        `).run(
          xpDelta,
          ratingAfter,
          raceStart.changes ? 1 : 0,
          finishIncrement,
          participant.escaped ? 1 : 0,
          firstIncrement,
          secondIncrement,
          thirdIncrement,
          now,
          participant.userId,
        );

        if (!participant.escaped && participant.completed && participant.finishTimeMs !== null) {
          const recordResult = this.db.prepare(`
            INSERT INTO user_track_records
              (user_id, track_id, best_finish_time_ms, race_id, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id, track_id) DO UPDATE SET
              best_finish_time_ms = excluded.best_finish_time_ms,
              race_id = excluded.race_id,
              updated_at = excluded.updated_at
            WHERE excluded.best_finish_time_ms < user_track_records.best_finish_time_ms
          `).run(participant.userId, trackId, participant.finishTimeMs, raceId, now);
          bestTimeUpdated = recordResult.changes > 0;
        }

        this.db.prepare(`
          INSERT INTO race_user_results (
            race_id, user_id, participant_id, official_rank, human_rank,
            completed, escaped, finish_time_ms, xp_before, xp_delta,
            rating_before, rating_delta, best_time_updated, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          raceId,
          participant.userId,
          participant.participantId,
          participant.officialRank,
          humanRanks.get(participant.userId) ?? null,
          participant.completed ? 1 : 0,
          participant.escaped ? 1 : 0,
          participant.completed ? participant.finishTimeMs : null,
          before.xp,
          xpDelta,
          before.rating,
          ratingDelta,
          bestTimeUpdated ? 1 : 0,
          now,
        );
        updates.set(participant.userId, {
          xpDelta,
          ratingDelta,
          levelBefore: levelProgress(before.xp).level,
          levelAfter: levelProgress(before.xp + xpDelta).level,
          bestTimeUpdated,
        });
      }
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }

    for (const [userId, update] of updates) update.profile = this.getProfile(userId);
    return updates;
  }
}
