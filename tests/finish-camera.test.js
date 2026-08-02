import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { FinishCameraDirector } from '../src/render/camera.js';
import { Track } from '../src/track/track.js';
import { getTrackDef } from '../src/track/tracks.js';

function makeKart(track, {
  s = 0,
  index = 0,
  progress = 0,
  finished = false,
} = {}) {
  const p = track.toWorld(s, 0, {});
  const yaw = p.heading;
  return {
    index,
    x: p.x,
    y: p.y,
    z: p.z,
    yaw,
    s,
    progress,
    finished,
    forwardX: Math.sin(yaw),
    forwardZ: Math.cos(yaw),
    rightX: Math.cos(yaw),
    rightZ: -Math.sin(yaw),
  };
}

function advance(director, seconds, context) {
  let remaining = seconds;
  while (remaining > 1e-9) {
    const dt = Math.min(1 / 60, remaining);
    director.update(dt, context);
    remaining -= dt;
  }
}

function makeCamera(player) {
  const camera = new THREE.PerspectiveCamera(68, 16 / 9, 0.3, 900);
  camera.position.set(player.x, player.y + 3.5, player.z - 7);
  camera.lookAt(player.x, player.y + 1, player.z + 3);
  return camera;
}

test('finish camera runs the three hero shots then targets the leading unfinished racer', () => {
  const track = new Track(getTrackDef('sunset-circuit'));
  const laps = 3;
  const player = makeKart(track, {
    s: 3,
    index: 0,
    progress: laps * track.length,
    finished: true,
  });
  const leader = makeKart(track, {
    s: track.length - 28,
    index: 1,
    progress: laps * track.length - 28,
  });
  const chaser = makeKart(track, {
    s: track.length - 90,
    index: 2,
    progress: laps * track.length - 90,
  });
  const standings = [player, leader, chaser];
  const context = { player, standings, laps };
  const camera = makeCamera(player);
  const director = new FinishCameraDirector(camera, track, { reducedMotion: false });

  assert.equal(director.begin(player), true);
  assert.equal(director.begin(player), false, 'begin must be idempotent');
  assert.equal(director._shot, 'hero-rear');

  advance(director, 1.05, context);
  assert.equal(director._shot, 'hero-front');
  advance(director, 1.0, context);
  assert.equal(director._shot, 'hero-crane');
  advance(director, 1.0, context);
  assert.equal(director.introComplete, true);
  assert.equal(director._shot, 'coverage-finish');
  assert.equal(director._target, leader);

  for (const value of [camera.position.x, camera.position.y, camera.position.z, camera.fov]) {
    assert.equal(Number.isFinite(value), true);
  }
  const ground = track.sampleWorld(camera.position.x, camera.position.z, null, {});
  assert.ok(camera.position.y >= ground.height + 1.2 - 1e-9);

  leader.finished = true;
  advance(director, 3.0, context);
  assert.equal(director._shot, 'coverage-wide');
  assert.equal(director._target, chaser, 'target changes only on the next coverage cut');
});

test('finish camera skip is gated for 1.5 seconds and jumps into coverage', () => {
  const track = new Track(getTrackDef('harbor-loop'));
  const player = makeKart(track, {
    s: 2,
    progress: 3 * track.length,
    finished: true,
  });
  const rival = makeKart(track, {
    s: track.length - 80,
    index: 1,
    progress: 3 * track.length - 80,
  });
  const context = { player, standings: [player, rival], laps: 3 };
  const director = new FinishCameraDirector(makeCamera(player), track, { reducedMotion: false });

  director.begin(player);
  advance(director, 1.4, context);
  assert.equal(director.canSkip, false);
  assert.equal(director.skipIntro(), false);
  advance(director, 0.11, context);
  assert.equal(director.canSkip, true);
  assert.equal(director.skipIntro(), true);
  assert.equal(director.introComplete, true);
  advance(director, 1 / 60, context);
  assert.equal(director._shot, 'coverage-follow');
  assert.equal(director._target, rival);
});

test('reduced-motion mode holds stable shot families instead of cycling cuts', () => {
  const track = new Track(getTrackDef('summit-raceway'));
  const player = makeKart(track, {
    s: 2,
    progress: 3 * track.length,
    finished: true,
  });
  const rival = makeKart(track, {
    s: track.length - 100,
    index: 1,
    progress: 3 * track.length - 100,
  });
  const context = { player, standings: [player, rival], laps: 3 };
  const director = new FinishCameraDirector(makeCamera(player), track, { reducedMotion: true });

  director.begin(player);
  advance(director, 2.9, context);
  assert.equal(director._shot, 'reduced-hero');
  advance(director, 0.2, context);
  assert.equal(director._shot, 'reduced-coverage');
  assert.equal(director._target, rival);
  advance(director, 7, context);
  assert.equal(director._shot, 'reduced-coverage');
});
