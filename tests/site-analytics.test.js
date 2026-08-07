import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { anonymizedNetwork } from '../server/http-request-utils.js';
import {
  ANALYTICS_RETENTION_DAYS,
  SiteAnalytics,
  VISITOR_COOKIE,
} from '../server/site-analytics.js';

function request({ cookie = '', address = '203.0.113.49', headers = {} } = {}) {
  return {
    headers: { cookie, ...headers },
    socket: { remoteAddress: address },
  };
}

test('IP addresses are reduced to anonymous IPv4 /24 and IPv6 /64 networks', () => {
  assert.equal(anonymizedNetwork('203.0.113.49'), '203.0.113.0/24');
  assert.equal(anonymizedNetwork('::ffff:192.0.2.44'), '192.0.2.0/24');
  assert.equal(anonymizedNetwork('2001:db8:abcd:12:1:2:3:4'), '2001:db8:abcd:12::/64');
  assert.equal(anonymizedNetwork('not-an-address'), 'unknown');
});

test('page views batch into SQLite while daily visitors deduplicate by cookie', () => {
  let now = Date.UTC(2026, 7, 7, 2, 10);
  const db = new DatabaseSync(':memory:');
  const analytics = new SiteAnalytics({
    db,
    now: () => now,
    visitorTokenFactory: () => 'visitor_token_1234567890',
    autoFlush: false,
    logger: { error() {} },
  });
  try {
    const setCookie = analytics.recordPageView(request());
    assert.match(setCookie, new RegExp(`^${VISITOR_COOKIE}=`));
    const cookie = setCookie.split(';')[0];
    analytics.recordPageView(request({ cookie }));
    analytics.recordOnlineCount(3);
    assert.equal(db.prepare('SELECT page_views FROM admin_analytics_totals').get().page_views, 0);

    const dashboard = analytics.getDashboard('24h', { userCount: 7, currentOnline: 2 });
    assert.equal(dashboard.traffic.totalPageViews, 2);
    assert.equal(dashboard.traffic.todayPageViews, 2);
    assert.equal(dashboard.traffic.todayUniqueVisitors, 1);
    assert.equal(dashboard.traffic.currentOnline, 2);
    assert.equal(dashboard.traffic.peakOnline, 3);
    assert.equal(dashboard.traffic.networks[0].network, '203.0.113.0/24');
    assert.equal(dashboard.traffic.networks[0].pageViews, 2);
    assert.equal(dashboard.users.total, 7);

    now += 24 * 60 * 60 * 1000;
    analytics.recordPageView(request({ cookie }));
    assert.equal(analytics.getDashboard('24h').traffic.todayUniqueVisitors, 1);
    assert.equal(analytics.getDashboard('24h').traffic.totalPageViews, 3);
  } finally {
    analytics.close();
    db.close();
  }
});

test('race statistics start empty, record exact new races, and ignore duplicate finishes', () => {
  let now = 1000;
  const db = new DatabaseSync(':memory:');
  const analytics = new SiteAnalytics({ db, now: () => now, autoFlush: false, logger: { error() {} } });
  try {
    assert.equal(analytics.getDashboard('24h').races.total, 0);
    assert.equal(analytics.recordRaceStart({ raceId: 'race-1', humanCount: 4 }), true);
    now = 21_000;
    analytics.recordRaceFinish({ raceId: 'race-1', durationMs: 20_000 });
    analytics.recordRaceFinish({ raceId: 'race-1', durationMs: 99_000 });
    const races = analytics.getDashboard('24h').races;
    assert.equal(races.total, 1);
    assert.equal(races.completed, 1);
    assert.equal(races.averagePlayers, 4);
    assert.equal(races.averageDurationMs, 20_000);
  } finally {
    analytics.close();
    db.close();
  }
});

test('ninety-day cleanup removes detail rows but preserves cumulative totals', () => {
  let now = Date.UTC(2026, 0, 1);
  const db = new DatabaseSync(':memory:');
  const analytics = new SiteAnalytics({
    db,
    now: () => now,
    visitorTokenFactory: () => 'visitor_token_1234567890',
    autoFlush: false,
    logger: { error() {} },
  });
  try {
    analytics.recordPageView(request());
    analytics.flush();
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM admin_traffic_buckets').get().count, 1);
    now += (ANALYTICS_RETENTION_DAYS + 2) * 24 * 60 * 60 * 1000;
    analytics.flush();
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM admin_traffic_buckets').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM admin_daily_visitors').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM admin_network_buckets').get().count, 0);
    assert.equal(db.prepare('SELECT page_views FROM admin_analytics_totals').get().page_views, 1);
  } finally {
    analytics.close();
    db.close();
  }
});
