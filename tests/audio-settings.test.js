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
  audio.gameplaySfxGain = { gain: new FakeParam(1) };
  audio.uiSfxGain = { gain: new FakeParam(1) };
}

class FakeMedia {
  constructor() {
    this.src = '';
    this.currentTime = 0;
    this.playbackRate = 1;
    this.paused = true;
    this.loop = false;
    this.preload = '';
    this.volume = 1;
    this.loadCalls = 0;
    this.playCalls = 0;
  }

  load() { this.loadCalls++; }
  play() { this.playCalls++; this.paused = false; return Promise.resolve(); }
}

function attachFakeMedia(audio, media = new FakeMedia()) {
  audio.ctx = { currentTime: 10 };
  audio._bgmElement = media;
  return media;
}

test('BGM media is looped and routed through the music gain', () => {
  const media = new FakeMedia();
  const musicGain = {};
  let connectedTo = null;
  const audio = new AudioManager({ createMediaElement: () => media });
  audio.musicGain = musicGain;
  audio._initBgmMedia({
    state: 'running',
    createMediaElementSource(node) {
      assert.equal(node, media);
      return { connect(destination) { connectedTo = destination; } };
    },
  });

  assert.equal(media.loop, true);
  assert.equal(media.preload, 'auto');
  assert.equal(media.volume, 1);
  assert.equal(connectedTo, musicGain);
});

test('BGM can start before WebAudio unlock and uses effective direct volume', () => {
  const media = new FakeMedia();
  const audio = new AudioManager({ createMediaElement: () => media });
  audio.applySettings({ master: 0.5, music: 0.75, musicEnabled: true, muted: false });

  audio.playMenuMusic();
  assert.equal(media.playCalls, 1);
  assert.equal(media.paused, false);
  assert.equal(media.volume, AUDIO.masterVolume * 0.5 * AUDIO.musicVolume * 0.75);
});

test('audio settings can be recorded before AudioContext initialization', () => {
  const audio = new AudioManager();
  audio.applySettings({
    muted: true,
    master: 0.5,
    musicEnabled: false,
    music: 0.25,
    sfx: 0.75,
    menuBgm: 'rainbow-drift',
    raceBgm: 'rainbow-kart-dash',
  });

  assert.equal(audio.muted, true);
  assert.equal(audio._masterVolume, 0.5);
  assert.equal(audio._musicEnabled, false);
  assert.equal(audio._musicVolume, 0.25);
  assert.equal(audio._sfxVolume, 0.75);
  assert.equal(audio._menuBgm, 'rainbow-drift');
  assert.equal(audio._raceBgm, 'rainbow-kart-dash');
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

test('menu and race BGM preserve position unless a restart is requested', () => {
  const audio = new AudioManager();
  const media = attachFakeMedia(audio);

  audio.playMenuMusic();
  assert.match(media.src, /Rainbow%20Drift\.mp3$/);
  assert.equal(media.currentTime, 0);
  assert.equal(media.loadCalls, 1);

  media.currentTime = 18;
  audio.playMenuMusic();
  assert.equal(media.currentTime, 18);
  assert.equal(media.loadCalls, 1);

  audio.playRaceMusic('harbor-loop', { restart: true });
  assert.match(media.src, /Rainbow%20Kart%20Parade%20\(0\.90x\)\.mp3$/);
  assert.equal(media.currentTime, 0);

  media.currentTime = 24;
  audio.playRaceMusic('harbor-loop');
  assert.equal(media.currentTime, 24);
  audio.playRaceMusic('harbor-loop', { restart: true });
  assert.equal(media.currentTime, 0);
});

test('resume retries a pending or paused BGM without restarting it', () => {
  const audio = new AudioManager();
  const media = new FakeMedia();
  media.src = 'test.mp3';
  media.currentTime = 19;
  audio.ctx = { state: 'running' };
  audio._bgmElement = media;
  audio._bgmPlayPending = true;

  audio.resume();
  assert.equal(media.playCalls, 1);
  assert.equal(media.currentTime, 19);
  assert.equal(media.paused, false);
});

test('race BGM setting changes switch the active race immediately', () => {
  const audio = new AudioManager();
  attachFakeGraph(audio);
  const media = new FakeMedia();
  audio._bgmElement = media;
  audio.playRaceMusic('summit-raceway', { restart: true });
  assert.match(media.src, /Rainbow%20Kart%20Dash\.mp3$/);

  media.currentTime = 12;
  audio.applySettings({ raceBgm: 'rainbow-lap-rush' });
  assert.match(media.src, /Rainbow%20Lap%20Rush\.mp3$/);
  assert.equal(media.currentTime, 0);
});

test('random menu BGM picks once on entry and keeps looping that track', () => {
  const audio = new AudioManager({
    createMediaElement: () => new FakeMedia(),
    random: () => 0,
  });
  audio.applySettings({ menuBgm: 'random' });
  audio.playMenuMusic();

  const media = audio._bgmElement;
  assert.equal(media.loop, true);
  assert.match(media.src, /Rainbow%20Drift\.mp3$/);

  media.currentTime = 20;
  audio.playMenuMusic();
  assert.match(media.src, /Rainbow%20Drift\.mp3$/);
  assert.equal(media.currentTime, 20);
  assert.equal(media.loadCalls, 1);
});

test('each fresh race selects one random BGM and loops it', () => {
  const samples = [0, 0.5];
  const audio = new AudioManager({
    createMediaElement: () => new FakeMedia(),
    random: () => samples.shift(),
  });
  audio.applySettings({ raceBgm: 'random' });
  audio.playRaceMusic('sunset-circuit', { restart: true });

  const media = audio._bgmElement;
  assert.equal(media.loop, true);
  assert.match(media.src, /Rainbow%20Lap%20Rush\.mp3$/);

  audio.playRaceMusic('harbor-loop', { restart: true });
  assert.match(media.src, /Rainbow%20Kart%20Parade%20\(0\.90x\)\.mp3$/);
});

test('final lap changes BGM playback rate and resets for a fresh race', () => {
  const audio = new AudioManager();
  const media = attachFakeMedia(audio);
  audio.playRaceMusic('sunset-circuit', { restart: true });
  audio.setFinalLap(true);
  assert.equal(media.playbackRate, 1.12);
  audio.playRaceMusic('sunset-circuit', { restart: true });
  assert.equal(media.playbackRate, 1);
});

test('pause mutes only gameplay SFX and preserves UI and user SFX gains', () => {
  const audio = new AudioManager();
  attachFakeGraph(audio);
  audio.applySettings({ sfx: 0.6 });
  const userGain = AUDIO.sfxVolume * 0.6;

  audio.setGameplaySfxPaused(true);
  assert.equal(audio.gameplaySfxGain.gain.value, 0);
  assert.equal(audio.uiSfxGain.gain.value, 1);
  assert.equal(audio.sfxGain.gain.value, userGain);

  audio.setGameplaySfxPaused(false);
  assert.equal(audio.gameplaySfxGain.gain.value, 1);
  assert.equal(audio.sfxGain.gain.value, userGain);
});
