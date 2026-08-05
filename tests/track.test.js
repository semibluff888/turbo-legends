// Track contract tests: all shipped tracks build, width/runoff tables stay inside
// authored bounds, surface classification (road / offroad / boost pads), item
// box and grid slot placement, and the racing line. Pure Node — no THREE, no DOM.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Track } from '../src/track/track.js';
import { TRACKS } from '../src/track/tracks.js';
import { SURFACE, RACE } from '../src/core/constants.js';
import { loopDelta, pmod } from '../src/core/mathx.js';

const tracks = TRACKS.map((def) => new Track(def));

test('all 6 shipped tracks build with sane basics', () => {
  assert.equal(TRACKS.length, 6);
  const ids = new Set(tracks.map((t) => t.id));
  assert.equal(ids.size, TRACKS.length, 'track ids must be unique');

  for (const track of tracks) {
    assert.ok(track.name.length > 0);
    assert.ok(track.length > 400, `${track.id} length=${track.length.toFixed(1)}`);
    assert.ok(track.laps >= 1);
    assert.equal(track.baseHalfWidth, track.def.width / 2);
    assert.ok(track.runoffAt(0) > 0);
    assert.ok(Math.abs(track.spline.count * track.spline.spacing - track.length) < 1e-9);
    assert.equal(track.itemBoxes.length, track.def.itemBoxes.length);
    assert.equal(track.boostPads.length, track.def.boostPads.length);
    for (const box of track.itemBoxes) {
      assert.equal(box.active, true, `${track.id} box ${box.id} starts active`);
      assert.equal(box.respawnAt, 0);
    }
  }
});

test('Metropolis Highway exposes authored structures and pickup layout', () => {
  const track = tracks.find((candidate) => candidate.id === 'metropolis-highway');
  assert.ok(track);
  assert.ok(track.length > 1000, `length=${track.length.toFixed(2)}`);
  assert.equal(track.gripZones.length, 0);
  assert.equal(track.structures.length, 2);
  assert.equal(track.boostPads.length, 5);
  assert.equal(track.itemBoxes.length, 30);

  const fourthRow = track.itemBoxes.slice(18, 24);
  assert.ok(fourthRow.every((box) => Math.abs(box.s / track.length - 0.74) < 1e-9));
});

test('Aurora Icefall exposes authored ice, structures, and vertical crossover clearance', () => {
  const track = tracks.find((candidate) => candidate.id === 'aurora-icefall');
  assert.ok(track);
  assert.ok(Math.abs(track.length - 955.8) < 0.2, `length=${track.length.toFixed(2)}`);
  assert.equal(track.gripZones.length, 3);
  assert.equal(track.structures.length, 2);
  assert.equal(track.gripAt(track.length * 0.15), 0.70);
  assert.equal(track.gripAt(track.length * 0.15, true), 0.88);
  assert.equal(track.gripAt(track.length * 0.30), 1);
  assert.ok(track.runoffAt(track.length * 0.72) < 2.3);

  const lowerS = track.length * 0.31;
  const upperS = track.length * 0.7165;
  const lower = track.toWorld(lowerS, 0, {});
  const upper = track.toWorld(upperS, 0, {});
  assert.ok(Math.hypot(lower.x - upper.x, lower.z - upper.z) < 1.0,
    'bridge and tunnel should cross in the XZ plane');
  assert.ok(upper.y - lower.y >= 12,
    `vertical clearance=${(upper.y - lower.y).toFixed(2)}`);

  const lowerProjection = track.sampleWorld(lower.x, lower.z, lowerS, {});
  const upperProjection = track.sampleWorld(upper.x, upper.z, upperS, {});
  assert.ok(Math.abs(loopDelta(lowerS, lowerProjection.s, track.length)) < 2);
  assert.ok(Math.abs(loopDelta(upperS, upperProjection.s, track.length)) < 2);

  const lowerByHeight = track.sampleWorld(lower.x, lower.z, null, {}, lower.y);
  const upperByHeight = track.sampleWorld(upper.x, upper.z, null, {}, upper.y);
  assert.ok(Math.abs(loopDelta(lowerS, lowerByHeight.s, track.length)) < 2,
    'height-only projection should select the tunnel deck');
  assert.ok(Math.abs(loopDelta(upperS, upperByHeight.s, track.length)) < 2,
    'height-only projection should select the bridge deck');
});

test('width table stays inside authored bounds and tapers smoothly', () => {
  for (const track of tracks) {
    const overrides = track.def.points.filter((p) => p.w != null).map((p) => p.w / 2);
    const lo = Math.min(track.baseHalfWidth, ...(overrides.length ? overrides : [track.baseHalfWidth]));
    const hi = Math.max(track.baseHalfWidth, ...(overrides.length ? overrides : [track.baseHalfWidth]));

    let prev = track.halfWidthAt(0);
    let minSeen = prev;
    let maxSeen = prev;
    for (let s = 1; s <= track.length; s += 1) {
      const hw = track.halfWidthAt(s);
      assert.ok(hw >= lo - 1e-6 && hw <= hi + 1e-6,
        `${track.id} halfWidth ${hw.toFixed(3)} outside [${lo}, ${hi}] at s=${s}`);
      assert.ok(Math.abs(hw - prev) < 0.35,
        `${track.id} width steps by ${(hw - prev).toFixed(3)} at s=${s}`);
      if (hw < minSeen) minSeen = hw;
      if (hw > maxSeen) maxSeen = hw;
      prev = hw;
    }

    if (overrides.length === 0) {
      // sunset-circuit: constant width everywhere.
      assert.ok(Math.abs(minSeen - track.baseHalfWidth) < 1e-9);
      assert.ok(Math.abs(maxSeen - track.baseHalfWidth) < 1e-9);
    }
  }

  // The authored narrow/wide sections must actually take effect.
  const harbor = tracks.find((t) => t.id === 'harbor-loop');
  let harborMin = Infinity;
  for (let s = 0; s < harbor.length; s += 1) harborMin = Math.min(harborMin, harbor.halfWidthAt(s));
  assert.ok(harborMin < harbor.baseHalfWidth - 1,
    `harbor dock section did not narrow (min half ${harborMin.toFixed(2)})`);

  const summit = tracks.find((t) => t.id === 'summit-raceway');
  let summitMax = -Infinity;
  for (let s = 0; s < summit.length; s += 1) summitMax = Math.max(summitMax, summit.halfWidthAt(s));
  assert.ok(summitMax > summit.baseHalfWidth + 1,
    `summit hairpin did not widen (max half ${summitMax.toFixed(2)})`);
});

test('centreline is always drivable: ROAD (or BOOST on a pad), never offroad', () => {
  for (const track of tracks) {
    for (let s = 0; s < track.length; s += 5) {
      const w = track.toWorld(s, 0, {});
      const sw = track.sampleWorld(w.x, w.z, s, {});
      assert.equal(sw.offTrackDepth, 0, `${track.id} centreline offroad at s=${s}`);
      assert.ok(Math.abs(sw.lateral) < 0.6, `${track.id} lateral ${sw.lateral.toFixed(3)} at s=${s}`);
      assert.ok([SURFACE.ROAD, SURFACE.BOOST].includes(sw.surface),
        `${track.id} surface=${sw.surface} at s=${s}`);
      assert.ok(Math.abs(loopDelta(s, sw.s, track.length)) < 1.5,
        `${track.id} s round-trip ${sw.s.toFixed(1)} vs ${s}`);
    }
  }
});

test('points past the road edge classify as OFFROAD with the right depth', () => {
  const DEPTH = 3;
  for (const track of tracks) {
    for (let s = 0; s < track.length; s += 10) {
      const sm = track.spline.sampleAt(s, {});
      const hw = track.halfWidthAt(s);
      // Test on the OUTSIDE of the corner so the projection is unambiguous
      // (the inside of a hairpin can be closer to the opposite leg).
      const side = sm.curvature > 0 ? -1 : 1;
      const w = track.toWorld(s, side * (hw + DEPTH), {});
      const sw = track.sampleWorld(w.x, w.z, s, {});
      assert.equal(sw.surface, SURFACE.OFFROAD,
        `${track.id} expected offroad at s=${s} (depth ${sw.offTrackDepth.toFixed(2)})`);
      assert.ok(Math.abs(sw.offTrackDepth - DEPTH) < 1.5,
        `${track.id} offTrackDepth ${sw.offTrackDepth.toFixed(2)} at s=${s}`);
    }
  }
});

test('hinted projection stays continuous just beyond both road edges', () => {
  const EDGE_DEPTH = 0.25;
  for (const track of tracks) {
    for (let s = 0; s < track.length; s += 2) {
      const hw = track.halfWidthAt(s);
      for (const side of [-1, 1]) {
        const w = track.toWorld(s, side * (hw + EDGE_DEPTH), {});
        const sw = track.sampleWorld(w.x, w.z, s, {}, w.y);
        const jump = Math.abs(loopDelta(s, sw.s, track.length));
        assert.ok(jump < 2,
          `${track.id} ${side < 0 ? 'left' : 'right'} edge jumped ${jump.toFixed(2)}m at s=${s}`);
      }
    }
  }
});

test('boost pads sit fully on the road and classify as BOOST surface', () => {
  for (const track of tracks) {
    assert.ok(track.boostPads.length > 0);
    for (const pad of track.boostPads) {
      // Pad footprint stays inside the road.
      assert.ok(Math.abs(pad.lateral) + pad.halfWidth <= track.halfWidthAt(pad.s) + 1e-6,
        `${track.id} pad ${pad.id} sticks off the road`);
      // Dead centre of the pad is BOOST.
      assert.equal(track.isOnBoostPad(pad.s, pad.lateral), true);
      const w = track.toWorld(pad.s, pad.lateral, {});
      const sw = track.sampleWorld(w.x, w.z, pad.s, {});
      assert.equal(sw.surface, SURFACE.BOOST, `${track.id} pad ${pad.id} surface=${sw.surface}`);
      // Well past the pad along the track it is no longer a pad.
      assert.equal(track.isOnBoostPad(pad.s + pad.halfLength + 6, pad.lateral), false,
        `${track.id} pad ${pad.id} leaks along s`);
    }
  }
});

test('item boxes are authored on the road and world positions match track space', () => {
  for (const track of tracks) {
    const boxesByPosition = new Map();
    for (const box of track.itemBoxes) {
      const row = boxesByPosition.get(box.s) || [];
      row.push(box);
      boxesByPosition.set(box.s, row);
    }
    for (const boxes of boxesByPosition.values()) {
      assert.equal(boxes.length, 6, `${track.id} item-box row should contain 6 boxes`);
      const outerLateral = Math.max(...boxes.map((box) => Math.abs(box.lateral)));
      const edgeClearance = track.halfWidthAt(boxes[0].s) - outerLateral;
      assert.ok(edgeClearance <= 1.1,
        `${track.id} outer item boxes are ${edgeClearance.toFixed(2)} from the road edge`);
    }
    for (const box of track.itemBoxes) {
      const hw = track.halfWidthAt(box.s);
      assert.ok(Math.abs(box.lateral) < hw - 0.5,
        `${track.id} box ${box.id} lateral ${box.lateral} vs halfWidth ${hw.toFixed(2)}`);
      const sw = track.sampleWorld(box.x, box.z, box.s, {});
      assert.equal(sw.offTrackDepth, 0, `${track.id} box ${box.id} is offroad`);
      assert.ok(Math.abs(loopDelta(box.s, sw.s, track.length)) < 1.5,
        `${track.id} box ${box.id} world position projects to s=${sw.s.toFixed(1)} not ${box.s.toFixed(1)}`);
      // Boxes hover 1.1 above the road surface at their arc position.
      assert.ok(Math.abs(box.y - (track.spline.heightAt(box.s) + 1.1)) < 1e-9,
        `${track.id} box ${box.id} y=${box.y}`);
    }
  }
});

test('grid slots land on the road behind the start line, alternating columns', () => {
  for (const track of tracks) {
    for (let i = 0; i < RACE.totalKarts; i++) {
      const slot = track.gridSlot(i, RACE.totalKarts, RACE.gridRowSpacing, RACE.gridColumnOffset, {});
      const sw = track.sampleWorld(slot.x, slot.z, slot.s, {});
      assert.equal(sw.offTrackDepth, 0, `${track.id} slot ${i} is offroad`);
      assert.ok(Math.abs(loopDelta(slot.s, sw.s, track.length)) < 1.5,
        `${track.id} slot ${i} projects to s=${sw.s.toFixed(1)}`);

      // Behind the line: the start line is 6..~20m ahead of every slot.
      const toLine = loopDelta(slot.s, 0, track.length);
      assert.ok(toLine > 0 && toLine < 25,
        `${track.id} slot ${i} is ${toLine.toFixed(1)}m from the line`);

      // Columns alternate left/right of the centreline.
      const expectedLat = (i % 2 === 0 ? -1 : 1) * RACE.gridColumnOffset;
      assert.ok(Math.abs(sw.lateral - expectedLat) < 0.5,
        `${track.id} slot ${i} lateral ${sw.lateral.toFixed(2)} expected ${expectedLat}`);
    }
  }
});

test('racing line stays well inside the drivable road', () => {
  for (const track of tracks) {
    for (let s = 0; s < track.length; s += 3) {
      const rl = track.racingLineLateral(s);
      const hw = track.halfWidthAt(s);
      assert.ok(Number.isFinite(rl));
      assert.ok(Math.abs(rl) <= hw * 0.55 + 1e-9,
        `${track.id} racing line ${rl.toFixed(2)} vs halfWidth ${hw.toFixed(2)} at s=${s}`);
      assert.ok(Math.abs(rl) < hw - 1, `${track.id} racing line touches the edge at s=${s}`);
    }
  }
});

test('respawnPoint returns an on-road centreline position slightly behind s', () => {
  for (const track of tracks) {
    for (let s = 0; s < track.length; s += 97) {
      const rp = track.respawnPoint(s, {});
      const back = pmod(s - 3, track.length);
      const sw = track.sampleWorld(rp.x, rp.z, back, {});
      assert.equal(sw.offTrackDepth, 0, `${track.id} respawn at s=${s} is offroad`);
      assert.ok(Math.abs(loopDelta(back, sw.s, track.length)) < 1.5,
        `${track.id} respawn for s=${s} landed at s=${sw.s.toFixed(1)}`);
      assert.ok(Math.abs(sw.lateral) < 0.6, `${track.id} respawn lateral ${sw.lateral.toFixed(2)}`);
    }
  }
});
