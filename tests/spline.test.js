// ClosedSpline contract tests: closure, uniform resampling, projection
// round-trips, tangent normalization, and hint-based disambiguation where the
// track passes near itself. Pure Node — no THREE, no DOM.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ClosedSpline } from '../src/track/spline.js';
import { loopDelta } from '../src/core/mathx.js';

// Square-ish loop, 100x100. Edge midpoints keep the centripetal Catmull-Rom
// from bulging at the corners (a bare 4-corner square measures ~5% long), so
// the hand-estimate "perimeter = 400" stays meaningful.
const SQUARE_POINTS = [
  { x: 0, z: 0 }, { x: 50, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 50 },
  { x: 100, z: 100 }, { x: 50, z: 100 }, { x: 0, z: 100 }, { x: 0, z: 50 },
];
const HAND_ESTIMATE = 400;

const square = new ClosedSpline(SQUARE_POINTS, { spacing: 1 });

test('length is within 5% of the hand-estimated perimeter', () => {
  const err = Math.abs(square.length - HAND_ESTIMATE) / HAND_ESTIMATE;
  assert.ok(
    err < 0.05,
    `length ${square.length.toFixed(2)} deviates ${(err * 100).toFixed(2)}% from ${HAND_ESTIMATE}`,
  );
  // Internal consistency: length is exactly count * spacing.
  assert.ok(Math.abs(square.count * square.spacing - square.length) < 1e-9);
});

test('loop closes: sampleAt(0) coincides with sampleAt(length)', () => {
  const a = square.sampleAt(0, {});
  const b = square.sampleAt(square.length, {});
  const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  assert.ok(d < 1e-6, `closure gap ${d}`);
});

test('resampling is uniform: adjacent sample distance stddev < 2% of mean', () => {
  const ds = [];
  let prev = square.positionAt(0, {});
  for (let i = 1; i <= square.count; i++) {
    const cur = square.positionAt(i * square.spacing, {});
    ds.push(Math.hypot(cur.x - prev.x, cur.y - prev.y, cur.z - prev.z));
    prev = { ...cur };
  }
  const mean = ds.reduce((s, v) => s + v, 0) / ds.length;
  const variance = ds.reduce((s, v) => s + (v - mean) ** 2, 0) / ds.length;
  const rel = Math.sqrt(variance) / mean;
  assert.ok(rel < 0.02, `spacing stddev/mean = ${rel.toFixed(5)}`);
});

test('project() of on-line points: |lateral| < 0.05 and s round-trips within 0.1', () => {
  const out = {};
  const pos = {};
  for (let i = 0; i < 64; i++) {
    const s = (i / 64) * square.length;
    square.positionAt(s, pos);
    square.project(pos.x, pos.z, out);
    assert.ok(Math.abs(out.lateral) < 0.05, `lateral ${out.lateral} at s=${s.toFixed(1)}`);
    const ds = Math.abs(loopDelta(s, out.s, square.length));
    assert.ok(ds < 0.1, `s round-trip error ${ds.toFixed(4)} at s=${s.toFixed(1)}`);
    assert.ok(out.dist < 0.05, `projection dist ${out.dist} at s=${s.toFixed(1)}`);
  }
});

test('tangents are unit length everywhere sampled', () => {
  const out = {};
  for (let i = 0; i < 97; i++) {
    const s = (i / 97) * square.length;
    square.sampleAt(s, out);
    const len = Math.hypot(out.tx, out.ty, out.tz);
    assert.ok(Math.abs(len - 1) < 1e-6, `|tangent| = ${len} at s=${s.toFixed(1)}`);
    // Right vector is unit on the ground plane too.
    const rlen = Math.hypot(out.rx, out.rz);
    assert.ok(Math.abs(rlen - 1) < 1e-6, `|right| = ${rlen} at s=${s.toFixed(1)}`);
  }
});

test('hintS disambiguates a tight U (two parallel straights 8 apart)', () => {
  // Two straights along z, at x = 0 (leg A) and x = 8 (leg B).
  const u = new ClosedSpline([
    { x: 0, z: 0 }, { x: 0, z: 50 }, { x: 0, z: 100 },
    { x: 8, z: 100 }, { x: 8, z: 50 }, { x: 8, z: 0 },
  ], { spacing: 1 });

  // Anchor arc-lengths on each leg via control points that the curve passes through.
  const onA = u.project(0, 50, {});
  const onB = u.project(8, 50, {});
  assert.ok(Math.abs(onA.cx - 0) < 2, `leg A anchor cx=${onA.cx}`);
  assert.ok(Math.abs(onB.cx - 8) < 2, `leg B anchor cx=${onB.cx}`);
  assert.ok(
    Math.abs(loopDelta(onA.s, onB.s, u.length)) > 30,
    'the two legs must be far apart in arc length',
  );

  // A point exactly midway between the legs is ambiguous without a hint.
  const withHintA = u.project(4, 50, {}, onA.s);
  const withHintB = u.project(4, 50, {}, onB.s);

  assert.ok(Math.abs(withHintA.cx - 0) < 2, `hint on A resolved to cx=${withHintA.cx}`);
  assert.ok(
    Math.abs(loopDelta(withHintA.s, onA.s, u.length)) < 10,
    `hint on A resolved to s=${withHintA.s.toFixed(1)}, expected near ${onA.s.toFixed(1)}`,
  );
  assert.ok(Math.abs(withHintB.cx - 8) < 2, `hint on B resolved to cx=${withHintB.cx}`);
  assert.ok(
    Math.abs(loopDelta(withHintB.s, onB.s, u.length)) < 10,
    `hint on B resolved to s=${withHintB.s.toFixed(1)}, expected near ${onB.s.toFixed(1)}`,
  );

  // Without a hint it must still return one of the two legs, not something between.
  const noHint = u.project(4, 50, {});
  const nearA = Math.abs(noHint.cx - 0) < 2.5;
  const nearB = Math.abs(noHint.cx - 8) < 2.5;
  assert.ok(nearA || nearB, `hintless projection landed at cx=${noHint.cx}`);
});
