import test from 'node:test';
import assert from 'node:assert/strict';

import { RuntimeMetrics } from '../server/runtime-metrics.js';

test('runtime metrics retain aggregate counters and rolling percentiles without labels', () => {
  let now = 1_000;
  const metrics = new RuntimeMetrics({
    now: () => now,
    logger: { info() {} },
    logIntervalMs: 0,
    sampleIntervalMs: 60_000,
  });
  try {
    metrics.recordTraffic('inbound', 'input', 20);
    metrics.recordTraffic('outbound', 'snapshot', 100);
    metrics.recordTick({ durationMs: 4, catchUpSteps: 2, catchUpCapped: true, roomErrors: 1 });
    metrics.recordTick({ durationMs: 8 });
    metrics.recordSnapshot({ bytes: 100, sent: 2 });
    metrics.increment('snapshot', 'backpressureSkipped');
    metrics.increment('lobby', 'broadcasts');
    metrics.increment('auth', 'attempts');
    metrics.recordScrypt(12);
    metrics.recordSnapshotEncoding({ bytes: 1_173, durationMs: 0.4 });
    metrics.recordInputDecode(0.08);
    metrics.recordCodecError({ oversized: true, invalidBinary: true });
    metrics.recordProtocolV3Rejected();

    const snapshot = metrics.snapshot();
    assert.equal(snapshot.windowMs, 60_000);
    assert.deepEqual(snapshot.traffic.inbound.byType.input, { count: 1, bytes: 20 });
    assert.deepEqual(snapshot.traffic.outbound.byType.snapshot, { count: 1, bytes: 100 });
    assert.equal(snapshot.tick.count, 2);
    assert.equal(snapshot.tick.catchUpSteps, 2);
    assert.equal(snapshot.tick.catchUpCapped, 1);
    assert.equal(snapshot.tick.roomErrors, 1);
    assert.equal(snapshot.tick.durationMs.p50, 4);
    assert.equal(snapshot.tick.durationMs.p99, 8);
    assert.equal(snapshot.snapshot.built, 1);
    assert.equal(snapshot.snapshot.sent, 2);
    assert.equal(snapshot.snapshot.bytes, 200);
    assert.equal(snapshot.backpressure.snapshotSkipped, 1);
    assert.equal(snapshot.auth.scryptDurationMs.p95, 12);
    assert.equal(snapshot.codec.snapshotEncoded, 1);
    assert.equal(snapshot.codec.inputDecoded, 1);
    assert.equal(snapshot.codec.errors, 1);
    assert.equal(snapshot.codec.oversized, 1);
    assert.equal(snapshot.codec.invalidBinary, 1);
    assert.equal(snapshot.codec.v3Rejected, 1);
    assert.equal(snapshot.codec.snapshotEncodeDurationMs.p95, 0.4);
    assert.equal(snapshot.codec.inputDecodeDurationMs.p95, 0.08);
    assert.ok(snapshot.process.memory.rss > 0);

    const serialized = JSON.stringify(snapshot);
    for (const sensitive of ['roomCode', 'displayName', 'resumeToken']) {
      assert.equal(serialized.includes(sensitive), false);
    }

    now += 60_001;
    assert.equal(metrics.snapshot().tick.durationMs.count, 0);
  } finally {
    metrics.close();
  }
});
