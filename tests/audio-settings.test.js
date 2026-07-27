import test from 'node:test';
import assert from 'node:assert/strict';

import { AudioManager } from '../src/audio/audio.js';
import { AUDIO } from '../src/core/constants.js';

class FakeParam {
  constructor(value = 0) {
    this.value = value;
    this.targets = [];
  }
  cancelScheduledValues() {}
  setValueAtTime(value) { this.value = value; }
  linearRampToValueAtTime(value) {
    this.value = value;
    this.targets.push(value);
  }
}

function attachFakeGraph(audio) {
  audio.ctx = { currentTime: 10 };
  audio.master = { gain: new FakeParam() };
  audio.musicGain = { gain: new FakeParam() };
  audio.sfxGain = { gain: new FakeParam() };
}

test('audio settings can be recorded before AudioContext initialization', () => {
  const audio = new AudioManager();
  audio.applySettings({
    muted: true,
    master: 0.5,
    musicEnabled: false,
    music: 0.25,
    sfx: 0.75,
  });

  assert.equal(audio.muted, true);
  assert.equal(audio._masterVolume, 0.5);
  assert.equal(audio._musicEnabled, false);
  assert.equal(audio._musicVolume, 0.25);
  assert.equal(audio._sfxVolume, 0.75);
});

test('audio settings scale the tuned master, music and sfx baselines', () => {
  const audio = new AudioManager();
  attachFakeGraph(audio);
  audio.applySettings({ master: 0.5, music: 0.25, sfx: 0.75, musicEnabled: true, muted: false });

  assert.equal(audio.master.gain.value, AUDIO.masterVolume * 0.5);
  assert.equal(audio.musicGain.gain.value, AUDIO.musicVolume * 0.25);
  assert.equal(audio.sfxGain.gain.value, AUDIO.sfxVolume * 0.75);
});

test('music disable and master mute preserve their underlying volume values', () => {
  const audio = new AudioManager();
  attachFakeGraph(audio);
  audio.applySettings({ master: 0.4, music: 0.6, sfx: 0.8, musicEnabled: false, muted: true });
  assert.equal(audio.master.gain.value, 0);
  assert.equal(audio.musicGain.gain.value, 0);

  audio.applySettings({ musicEnabled: true, muted: false });
  assert.equal(audio.master.gain.value, AUDIO.masterVolume * 0.4);
  assert.equal(audio.musicGain.gain.value, AUDIO.musicVolume * 0.6);
  assert.equal(audio.sfxGain.gain.value, AUDIO.sfxVolume * 0.8);
});

test('toggleMuted returns the new state and respects master scaling', () => {
  const audio = new AudioManager();
  attachFakeGraph(audio);
  audio.applySettings({ master: 0.3, muted: false });
  assert.equal(audio.toggleMuted(), true);
  assert.equal(audio.master.gain.value, 0);
  assert.equal(audio.toggleMuted(), false);
  assert.equal(audio.master.gain.value, AUDIO.masterVolume * 0.3);
});
