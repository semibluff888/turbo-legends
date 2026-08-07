import { createHash, randomBytes } from 'node:crypto';

import { parseCookies } from './user-store.js';
import {
  anonymizedNetwork,
  clientAddress,
  requestIsSecure,
} from './http-request-utils.js';

export const ANALYTICS_FLUSH_INTERVAL_MS = 30_000;
export const ANALYTICS_RETENTION_DAYS = 90;
export const ANALYTICS_BUCKET_MS = 5 * 60 * 1000;
export const VISITOR_COOKIE = 'turbo_legends_visitor';

const VISITOR_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const RANGE_CONFIG = Object.freeze({
  '24h': { durationMs: 24 * 60 * 60 * 1000, groupMs: ANALYTICS_BUCKET_MS },
  '7d': { durationMs: 7 * 24 * 60 * 60 * 1000, groupMs: 60 * 60 * 1000 },
  '30d': { durationMs: 30 * 24 * 60 * 60 * 1000, groupMs: 6 * 60 * 60 * 1000 },
  '90d': { durationMs: 90 * 24 * 60 * 60 * 1000, groupMs: 24 * 60 * 60 * 1000 },
});

function utcDayKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function utcDayStart(timestamp) {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function bucketStart(timestamp) {
  return Math.floor(timestamp / ANALYTICS_BUCKET_MS) * ANALYTICS_BUCKET_MS;
}

function finiteNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
}

function visitorCookie(token, secure) {
  return [
    `${VISITOR_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${VISITOR_COOKIE_MAX_AGE_SECONDS}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export class SiteAnalytics {
  constructor({
    db,
    trustProxy = false,
    logger = console,
    now = () => Date.now(),
    visitorTokenFactory = () => randomBytes(18).toString('base64url'),
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    autoFlush = true,
  } = {}) {
    if (!db) throw new TypeError('db is required.');
    this.db = db;
    this.trustProxy = trustProxy;
    this.logger = logger;
    this.now = now;
    this.visitorTokenFactory = visitorTokenFactory;
    this.clearIntervalImpl = clearIntervalImpl;
    this.pendingTotalPageViews = 0;
    this.pendingPeakOnline = 0;
    this.pendingBuckets = new Map();
    this.pendingVisitors = new Set();
    this.pendingNetworks = new Map();
    this.currentOnline = 0;
    this.lastCleanupDay = '';
    this._closed = false;
    this._migrate();
    this._cleanup(this.now());
    this.flushTimer = autoFlush ? setIntervalImpl(() => this.flush(), ANALYTICS_FLUSH_INTERVAL_MS) : null;
    this.flushTimer?.unref?.();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS admin_analytics_totals (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        page_views INTEGER NOT NULL DEFAULT 0,
        peak_online INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO admin_analytics_totals
        (singleton, page_views, peak_online, updated_at)
      VALUES (1, 0, 0, 0);
      CREATE TABLE IF NOT EXISTS admin_traffic_buckets (
        bucket_start INTEGER PRIMARY KEY,
        page_views INTEGER NOT NULL DEFAULT 0,
        peak_online INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS admin_daily_visitors (
        day_key TEXT NOT NULL,
        visitor_hash TEXT NOT NULL,
        PRIMARY KEY (day_key, visitor_hash)
      );
      CREATE TABLE IF NOT EXISTS admin_network_buckets (
        bucket_start INTEGER NOT NULL,
        network TEXT NOT NULL,
        page_views INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (bucket_start, network)
      );
      CREATE TABLE IF NOT EXISTS admin_races (
        race_id TEXT PRIMARY KEY,
        human_count INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        duration_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS admin_races_started_at_idx
        ON admin_races(started_at DESC);
    `);
  }

  recordPageView(request) {
    if (this._closed) return null;
    const now = this.now();
    const cookies = parseCookies(request?.headers?.cookie);
    let token = cookies.get(VISITOR_COOKIE) || '';
    let setCookie = null;
    if (!/^[A-Za-z0-9_-]{16,128}$/u.test(token)) {
      token = this.visitorTokenFactory();
      setCookie = visitorCookie(token, requestIsSecure(request, this.trustProxy));
    }
    const day = utcDayKey(now);
    const visitorHash = createHash('sha256').update(token).digest('hex');
    const network = anonymizedNetwork(clientAddress(request, this.trustProxy));
    const start = bucketStart(now);
    const bucket = this.pendingBuckets.get(start) ?? { pageViews: 0, peakOnline: 0 };
    bucket.pageViews++;
    bucket.peakOnline = Math.max(bucket.peakOnline, this.currentOnline);
    this.pendingBuckets.set(start, bucket);
    this.pendingTotalPageViews++;
    this.pendingVisitors.add(`${day}\0${visitorHash}`);
    const networkKey = `${start}\0${network}`;
    this.pendingNetworks.set(networkKey, (this.pendingNetworks.get(networkKey) ?? 0) + 1);
    return setCookie;
  }

  recordOnlineCount(value) {
    if (this._closed) return;
    const online = finiteNonNegativeInteger(value);
    this.currentOnline = online;
    this.pendingPeakOnline = Math.max(this.pendingPeakOnline, online);
    const start = bucketStart(this.now());
    const bucket = this.pendingBuckets.get(start) ?? { pageViews: 0, peakOnline: 0 };
    bucket.peakOnline = Math.max(bucket.peakOnline, online);
    this.pendingBuckets.set(start, bucket);
  }

  recordRaceStart({ raceId, humanCount } = {}) {
    if (this._closed || !raceId) return false;
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO admin_races (race_id, human_count, started_at)
      VALUES (?, ?, ?)
    `).run(String(raceId), finiteNonNegativeInteger(humanCount), this.now());
    return result.changes > 0;
  }

  recordRaceFinish({ raceId, durationMs } = {}) {
    if (this._closed || !raceId) return false;
    const result = this.db.prepare(`
      UPDATE admin_races
      SET finished_at = COALESCE(finished_at, ?),
          duration_ms = COALESCE(duration_ms, ?)
      WHERE race_id = ?
    `).run(this.now(), finiteNonNegativeInteger(durationMs), String(raceId));
    return result.changes > 0;
  }

  flush() {
    if (this._closed && !this.pendingTotalPageViews && !this.pendingBuckets.size
      && !this.pendingVisitors.size && !this.pendingNetworks.size) return true;
    const now = this.now();
    const hasPending = this.pendingTotalPageViews > 0
      || this.pendingPeakOnline > 0
      || this.pendingBuckets.size > 0
      || this.pendingVisitors.size > 0
      || this.pendingNetworks.size > 0;
    if (!hasPending) {
      this._cleanup(now);
      return true;
    }

    const totalPageViews = this.pendingTotalPageViews;
    const peakOnline = this.pendingPeakOnline;
    const buckets = [...this.pendingBuckets];
    const visitors = [...this.pendingVisitors];
    const networks = [...this.pendingNetworks];
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.prepare(`
        UPDATE admin_analytics_totals
        SET page_views = page_views + ?,
            peak_online = MAX(peak_online, ?),
            updated_at = ?
        WHERE singleton = 1
      `).run(totalPageViews, peakOnline, now);
      const bucketStatement = this.db.prepare(`
        INSERT INTO admin_traffic_buckets (bucket_start, page_views, peak_online)
        VALUES (?, ?, ?)
        ON CONFLICT(bucket_start) DO UPDATE SET
          page_views = page_views + excluded.page_views,
          peak_online = MAX(peak_online, excluded.peak_online)
      `);
      for (const [start, value] of buckets) {
        bucketStatement.run(start, value.pageViews, value.peakOnline);
      }
      const visitorStatement = this.db.prepare(`
        INSERT OR IGNORE INTO admin_daily_visitors (day_key, visitor_hash) VALUES (?, ?)
      `);
      for (const key of visitors) visitorStatement.run(...key.split('\0'));
      const networkStatement = this.db.prepare(`
        INSERT INTO admin_network_buckets (bucket_start, network, page_views)
        VALUES (?, ?, ?)
        ON CONFLICT(bucket_start, network) DO UPDATE SET
          page_views = page_views + excluded.page_views
      `);
      for (const [key, pageViews] of networks) {
        const [start, network] = key.split('\0');
        networkStatement.run(Number(start), network, pageViews);
      }
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      this.logger.error?.('[analytics] flush failed', error);
      return false;
    }

    this.pendingTotalPageViews -= totalPageViews;
    this.pendingPeakOnline = this.pendingPeakOnline === peakOnline ? 0 : this.pendingPeakOnline;
    for (const [key] of buckets) this.pendingBuckets.delete(key);
    for (const key of visitors) this.pendingVisitors.delete(key);
    for (const [key] of networks) this.pendingNetworks.delete(key);
    this._cleanup(now);
    return true;
  }

  _cleanup(now) {
    const day = utcDayKey(now);
    if (this.lastCleanupDay === day) return;
    const cutoff = now - ANALYTICS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const cutoffDay = utcDayKey(cutoff);
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.prepare('DELETE FROM admin_traffic_buckets WHERE bucket_start < ?').run(cutoff);
      this.db.prepare('DELETE FROM admin_daily_visitors WHERE day_key < ?').run(cutoffDay);
      this.db.prepare('DELETE FROM admin_network_buckets WHERE bucket_start < ?').run(cutoff);
      this.db.exec('COMMIT;');
      this.lastCleanupDay = day;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      this.logger.error?.('[analytics] cleanup failed', error);
    }
  }

  getDashboard(range = '24h', { userCount = 0, currentOnline = this.currentOnline } = {}) {
    const config = RANGE_CONFIG[range];
    if (!config) return null;
    this.flush();
    const now = this.now();
    const cutoff = now - config.durationMs;
    const today = utcDayKey(now);
    const todayStart = utcDayStart(now);
    const totals = this.db.prepare(`
      SELECT page_views, peak_online FROM admin_analytics_totals WHERE singleton = 1
    `).get();
    const todayPageViews = this.db.prepare(`
      SELECT COALESCE(SUM(page_views), 0) AS value
      FROM admin_traffic_buckets WHERE bucket_start >= ?
    `).get(todayStart).value;
    const todayUniqueVisitors = this.db.prepare(`
      SELECT COUNT(*) AS value FROM admin_daily_visitors WHERE day_key = ?
    `).get(today).value;
    const rangePeakOnline = this.db.prepare(`
      SELECT COALESCE(MAX(peak_online), 0) AS value
      FROM admin_traffic_buckets WHERE bucket_start >= ?
    `).get(cutoff).value;
    const series = this.db.prepare(`
      SELECT
        CAST(bucket_start / ? AS INTEGER) * ? AS at,
        SUM(page_views) AS page_views,
        MAX(peak_online) AS peak_online
      FROM admin_traffic_buckets
      WHERE bucket_start >= ?
      GROUP BY at
      ORDER BY at ASC
    `).all(config.groupMs, config.groupMs, cutoff).map((row) => ({
      at: row.at,
      pageViews: row.page_views,
      peakOnline: row.peak_online,
    }));
    const networkRows = this.db.prepare(`
      SELECT network, SUM(page_views) AS page_views
      FROM admin_network_buckets
      WHERE bucket_start >= ?
      GROUP BY network
      ORDER BY page_views DESC, network ASC
      LIMIT 20
    `).all(cutoff);
    const networkTotal = this.db.prepare(`
      SELECT COALESCE(SUM(page_views), 0) AS value
      FROM admin_network_buckets WHERE bucket_start >= ?
    `).get(cutoff).value;
    const raceStats = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        COUNT(duration_ms) AS completed,
        COALESCE(AVG(human_count), 0) AS average_players,
        COALESCE(AVG(duration_ms), 0) AS average_duration_ms
      FROM admin_races
    `).get();
    return {
      generatedAt: now,
      range,
      traffic: {
        totalPageViews: totals.page_views,
        todayPageViews,
        todayUniqueVisitors,
        currentOnline: finiteNonNegativeInteger(currentOnline),
        rangePeakOnline,
        peakOnline: totals.peak_online,
        series,
        networks: networkRows.map((row) => ({
          network: row.network,
          pageViews: row.page_views,
          share: networkTotal > 0 ? row.page_views / networkTotal : 0,
        })),
      },
      races: {
        total: raceStats.total,
        completed: raceStats.completed,
        averagePlayers: raceStats.average_players,
        averageDurationMs: raceStats.average_duration_ms,
      },
      users: { total: finiteNonNegativeInteger(userCount) },
    };
  }

  close() {
    if (this._closed) return;
    if (this.flushTimer) this.clearIntervalImpl(this.flushTimer);
    this.flushTimer = null;
    this.flush();
    this._closed = true;
  }
}
