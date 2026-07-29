import test from 'node:test';
import assert from 'node:assert/strict';

import { FIXED_DT } from '../src/core/constants.js';
import { Track } from '../src/track/track.js';
import { getTrackDef } from '../src/track/tracks.js';
import { LocalRaceSession } from '../src/session/local-race-session.js';

test('LocalRaceSession exposes the presentation-facing race contract', () => {
  const track = new Track(getTrackDef('sunset-circuit'));
  const session = new LocalRaceSession(track, {
    playerCharacterId: 'kit',
    difficulty: 'normal',
    seed: 42,
  });

  assert.equal(session.kind, 'local');
  assert.equal(session.track, track);
  assert.equal(session.karts.length, 8);
  assert.equal(session.player.character.id, 'kit');
  assert.equal(session.items, session.director.items);
  assert.equal(session.laps, track.laps);
  assert.equal(session.standings.length, 8);

  const before = session.countdown;
  session.update(FIXED_DT, null);
  assert.ok(session.countdown < before);
});
