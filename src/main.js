// Turbo Kart — boot, screen flow, and the fixed-step game loop.
// This is the only module that imports everything; it owns the frame.

import * as THREE from 'three';
import { FIXED_DT, MAX_FRAME_TIME, RACE_STATE, CAMERA, RACE } from './core/constants.js';
import { Track } from './track/track.js';
import { TRACKS, getTrackDef } from './track/tracks.js';
import { CHARACTERS } from './game/characters.js';
import { RaceDirector } from './game/race.js';
import { makeControls, resetControls } from './game/kart.js';
import { createRenderer, buildScene } from './render/scene.js';
import { buildTrackMesh } from './render/trackMesh.js';
import { KartVisual } from './render/kartMesh.js';
import { Effects } from './render/effects.js';
import { ChaseCamera } from './render/camera.js';
import { Hud } from './ui/hud.js';
import { Screens } from './ui/screens.js';
import { loadSettings, resetSettings, saveSettings } from './ui/settings-store.js';
import { AudioManager } from './audio/audio.js';
import { InputManager } from './input/input.js?v=20260726-steering-fix';

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

const canvas = document.getElementById('game-canvas');
const { renderer, resize } = createRenderer(canvas);
const camera = new THREE.PerspectiveCamera(
  CAMERA.fov, window.innerWidth / window.innerHeight, CAMERA.near, CAMERA.far);

const input = new InputManager(window);
const audio = new AudioManager();
let gameSettings = loadSettings();
audio.applySettings(gameSettings);

const hud = new Hud(document.getElementById('hud'), document.getElementById('minimap'));

/** Player selections, persisted across races in this session. */
const selection = {
  characterId: CHARACTERS[2].id,
  trackId: TRACKS[0].id,
  difficulty: 'normal',
};

/** 'title' | 'settings' | 'help' | 'character' | 'track' | 'difficulty' | 'race' | 'results' */
let mode = 'title';
let paused = false;
/** Where an auxiliary page returns: the title menu or the in-race pause menu. */
let panelReturn = 'title';

/** Everything belonging to the current race; null between races. */
let race = null;

const playerControls = makeControls();

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

const screens = new Screens({
  title: document.getElementById('screen-title'),
  character: document.getElementById('screen-character'),
  track: document.getElementById('screen-track'),
  difficulty: document.getElementById('screen-difficulty'),
  settings: document.getElementById('screen-settings'),
  help: document.getElementById('screen-help'),
  pause: document.getElementById('screen-pause'),
  results: document.getElementById('screen-results'),
}, {
  onCharacter(id) {
    selection.characterId = id;
    mode = 'track';
    screens.showTrack(TRACKS);
    playUi('confirm');
  },
  onTrack(id) {
    selection.trackId = id;
    mode = 'difficulty';
    screens.showDifficulty();
    playUi('confirm');
  },
  onDifficulty(key) {
    selection.difficulty = key;
    playUi('confirm');
    startRace();
  },
  onSinglePlayer() {
    mode = 'character';
    screens.showCharacter(CHARACTERS);
    playUi('confirm');
  },
  onMultiplayer() { playUi('confirm'); },
  onOpenSettings() { openPanel('settings'); },
  onOpenHelp() { openPanel('help'); },
  onSettingsChange(key, value) {
    ensureAudio();
    gameSettings = saveSettings({ ...gameSettings, [key]: value });
    audio.applySettings(gameSettings);
    screens.updateSettings(gameSettings);
    audio.ui('move');
  },
  onSettingsReset() {
    ensureAudio();
    gameSettings = resetSettings();
    audio.applySettings(gameSettings);
    screens.updateSettings(gameSettings);
    audio.ui('confirm');
  },
  onClosePanel() { closePanel(); },
  onResume() { setPaused(false); },
  onRestart() {
    startRace();
  },
  onQuit() {
    paused = false;
    endRace();
    goToTitle();
  },
  onResultsDone() {
    endRace();
    goToTitle();
  },
});

function goToTitle() {
  mode = 'title';
  paused = false;
  panelReturn = 'title';
  screens.showTitle();
  hud.hide();
  audio.setGameplaySfxPaused(true);
  audio.playMenuMusic();
  buildAttract();
}

function ensureAudio() {
  if (!audio.ctx) {
    audio.init();
    audio.applySettings(gameSettings);
  } else {
    audio.resume();
  }
}

function playUi(kind) {
  ensureAudio();
  audio.ui(kind);
}

function openPanel(name) {
  panelReturn = race && paused ? 'pause' : 'title';
  mode = name;
  if (name === 'settings') screens.showSettings(gameSettings);
  else screens.showHelp('controls');
  playUi('confirm');
}

function closePanel() {
  playUi('back');
  if (panelReturn === 'pause' && race) {
    mode = 'race';
    paused = true;
    screens.showPause();
  } else {
    goToTitle();
  }
}

// ---------------------------------------------------------------------------
// Attract mode: an empty track slowly orbited behind the title menus.
// ---------------------------------------------------------------------------

let attract = null;

function disposeSceneDeep(scene) {
  scene.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
        m.dispose();
      }
    }
  });
}

function buildAttract() {
  if (race) return; // race scene doubles as the backdrop
  if (attract) return;
  const def = getTrackDef(selection.trackId);
  const track = new Track(def);
  const world = buildScene(track);
  world.scene.add(buildTrackMesh(track));
  attract = { track, world, angle: 0 };
}

function destroyAttract() {
  if (!attract) return;
  disposeSceneDeep(attract.world.scene);
  attract = null;
}

// ---------------------------------------------------------------------------
// Race lifecycle
// ---------------------------------------------------------------------------

function startRace() {
  destroyAttract();
  if (race) endRace();

  const def = getTrackDef(selection.trackId);
  const track = new Track(def);
  const director = new RaceDirector(track, {
    playerCharacterId: selection.characterId,
    difficulty: selection.difficulty,
    seed: (Date.now() & 0xffffff) ^ 0x5eed,
  });

  const world = buildScene(track);
  world.scene.add(buildTrackMesh(track));

  const visuals = director.karts.map((k) => new KartVisual(k, world.scene));
  const effects = new Effects(world.scene);
  const chase = new ChaseCamera(camera);
  if (chase.setTrack) chase.setTrack(track);
  chase.snapTo(director.player);

  race = {
    track, director, world, visuals, effects, chase,
    accumulator: 0,
    finalLapAnnounced: false,
    finishedAnnounced: false,
    resultsShown: false,
    lastCountdownBeep: -1,
  };

  mode = 'race';
  paused = false;
  screens.hideAll();
  hud.showRace(director);
  audio.setGameplaySfxPaused(false);
  audio.playRaceMusic(def.id, { restart: true });
  audio.setFinalLap(false);
  audio.startEngine();
  resetControls(playerControls);
}

function endRace() {
  if (!race) return;
  audio.stopEngine();
  hud.hide();
  disposeSceneDeep(race.world.scene);
  race = null;
}

function setPaused(p) {
  if (!race || race.director.state === RACE_STATE.RESULTS) return;
  paused = p;
  audio.setGameplaySfxPaused(p);
  if (p) {
    screens.showPause();
    audio.ui('back');
  } else {
    mode = 'race';
    screens.hideAll();
  }
}

// ---------------------------------------------------------------------------
// Per-frame race handling
// ---------------------------------------------------------------------------

function consumeRaceEvents() {
  const { director, effects, chase } = race;
  for (const kart of director.karts) {
    for (const ev of kart.events) {
      switch (ev.type) {
        case 'collide':
          if (kart.isPlayer) chase.addShake(Math.min(0.5, (ev.impactSpeed || 6) * 0.04));
          effects.burst(kart.x, kart.y + 0.6, kart.z, 0xffffff, 6);
          break;
        case 'spinout':
        case 'squash':
          if (kart.isPlayer) chase.addShake(0.7);
          effects.burst(kart.x, kart.y + 0.8, kart.z, 0xffd23f, 14);
          break;
        case 'itembox':
          effects.shatter(kart.x, kart.y + 1.0, kart.z);
          break;
        case 'drift_boost':
        case 'boost':
          if (kart.isPlayer) chase.addShake(0.18);
          break;
        case 'finish':
          effects.confettiBurst(kart.x, kart.y + 3, kart.z);
          break;
        case 'lap':
          // The HUD shows its own FINAL LAP banner; we only speed up the music.
          if (kart.isPlayer && ev.isFinal && !race.finalLapAnnounced) {
            race.finalLapAnnounced = true;
            audio.setFinalLap(true);
          }
          break;
      }
    }
  }
  // Item system one-shot world VFX.
  if (director.items && director.items.drainVfx) {
    for (const v of director.items.drainVfx()) {
      if (v.type === 'explosion') {
        effects.explosion(v.x, v.y, v.z);
        chase.addShake(0.4);
      } else if (v.type === 'shell_break') {
        effects.burst(v.x, v.y, v.z, 0x99ff99, 10);
      } else {
        effects.burst(v.x, v.y, v.z, 0xffe14d, 8);
      }
    }
  }
}

function updateRaceFrame(dt) {
  const { director, visuals, effects, chase, world } = race;

  // --- Simulation at fixed timestep ---------------------------------------
  if (!paused) {
    input.readControls(playerControls);
    race.accumulator = Math.min(race.accumulator + dt, MAX_FRAME_TIME);
    while (race.accumulator >= FIXED_DT) {
      director.update(FIXED_DT, playerControls);
      race.accumulator -= FIXED_DT;
    }
  }

  // --- Presentation ---------------------------------------------------------
  const player = director.player;

  // Countdown beeps (audio keyed to the integer countdown value).
  if (director.state === RACE_STATE.COUNTDOWN) {
    const n = Math.ceil(director.countdown);
    if (n !== race.lastCountdownBeep && n <= 3) {
      race.lastCountdownBeep = n;
      audio.countdownBeep(n);
      hud.countdown(n);
    }
  } else if (race.lastCountdownBeep !== 0) {
    race.lastCountdownBeep = 0;
    audio.countdownBeep(0);
    hud.countdown('go');
  }

  for (const v of visuals) v.sync(camera.position);

  // Continuous particle sources.
  for (const kart of director.karts) {
    if (kart.drifting && kart.driftTier >= 0 && !kart.airborne) {
      const tier = kart.driftTierInfo;
      effects.driftSparks(
        kart.x - kart.forwardX * 0.9, kart.y + 0.15, kart.z - kart.forwardZ * 0.9,
        tier ? tier.color : 0x4fc3ff);
    }
    if (kart.surface === 'offroad' && kart.speedRatio > 0.25 && !kart.airborne) {
      effects.dust(kart.x, kart.y + 0.2, kart.z);
    }
  }

  consumeRaceEvents();
  audio.consume(director.karts, director);
  audio.update(dt, player, director);
  for (const kart of director.karts) kart.clearEvents();

  effects.update(dt);
  chase.update(dt, player, playerControls.lookBack);
  world.animate(dt, director.elapsed);
  hud.update(player, director, dt);

  // Finish / results flow (the HUD shows its own FINISHED banner).
  if (player.finished && !race.finishedAnnounced) {
    race.finishedAnnounced = true;
    audio.setFinalLap(false);
  }
  if (director.state === RACE_STATE.RESULTS && !race.resultsShown) {
    race.resultsShown = true;
    race.resultsShownAt = performance.now() / 1000;
    mode = 'results';
    hud.hide(); // the results panel owns the screen now
    screens.showResults(director.standings, player, race.track.name);
    audio.setFinalLap(false);
  }
}

// ---------------------------------------------------------------------------
// Menu input routing
// ---------------------------------------------------------------------------

function updateMenus() {
  const m = input.menu;

  if (mode === 'settings') {
    if (m.up) { screens.moveFocus(-1); audio.ui('move'); }
    if (m.down) { screens.moveFocus(1); audio.ui('move'); }
    if (m.left) screens.adjustFocused(-1);
    if (m.right) screens.adjustFocused(1);
    if (m.confirm) screens.confirm();
    if (m.back) closePanel();
    return;
  }

  if (mode === 'help') {
    if (m.left) { screens.cycleHelpTab(-1); audio.ui('move'); }
    if (m.right) { screens.cycleHelpTab(1); audio.ui('move'); }
    if (m.up) screens.scrollHelp(-1);
    if (m.down) screens.scrollHelp(1);
    if (m.confirm || m.back) closePanel();
    return;
  }

  if (m.up) { screens.moveFocus(-10); audio.ui('move'); }
  if (m.down) { screens.moveFocus(10); audio.ui('move'); }
  if (m.left) { screens.moveFocus(-1); audio.ui('move'); }
  if (m.right) { screens.moveFocus(1); audio.ui('move'); }
  if (m.confirm) screens.confirm();
  if (m.back && mode !== 'title') {
    audio.ui('back');
    if (mode === 'character') goToTitle();
    else if (mode === 'track') { mode = 'character'; screens.showCharacter(CHARACTERS); }
    else if (mode === 'difficulty') { mode = 'track'; screens.showTrack(TRACKS); }
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let lastTime = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastTime) / 1000, MAX_FRAME_TIME);
  lastTime = now;

  input.update();

  // Fallback retry for gamepad/touch inputs that bypass the native listeners.
  if (input.anyKey) ensureAudio();
  if (input.muteToggle) {
    ensureAudio();
    gameSettings = saveSettings({ ...gameSettings, muted: !gameSettings.muted });
    audio.applySettings(gameSettings);
    screens.updateSettings(gameSettings);
  }

  if (mode === 'race') {
    // Esc raises both `pause` and `back` edges — the else-if keeps one press
    // from toggling the menu open and instantly closed in the same frame.
    if (input.menu.pause) {
      setPaused(!paused);
    } else if (paused) {
      const m = input.menu;
      if (m.up) { screens.moveFocus(-10); audio.ui('move'); }
      if (m.down) { screens.moveFocus(10); audio.ui('move'); }
      if (m.confirm) screens.confirm();
      if (m.back) setPaused(false);
    }
    updateRaceFrame(paused ? 0 : dt);
    renderer.render(race.world.scene, camera);
    return;
  }

  if (mode === 'results') {
    const m = input.menu;
    // Grace period so a player still holding throttle can't skip the podium.
    const ready = race && race.resultsShownAt != null
      && now / 1000 - race.resultsShownAt > RACE.resultsInputDelay;
    if (ready && (m.confirm || input.anyKey)) screens.confirm();
    if (race) {
      updateRaceFrame(dt); // let the field keep driving behind the results panel
      renderer.render(race.world.scene, camera);
    }
    return;
  }

  // Menu modes — orbit the attract track.
  updateMenus();
  if (attract) {
    attract.angle += dt * 0.06;
    const t = attract.track;
    const s = (attract.angle * 30) % t.length;
    const p = t.toWorld(s, 0);
    camera.position.set(
      p.x + Math.sin(attract.angle) * 46,
      26 + Math.sin(attract.angle * 0.6) * 6,
      p.z + Math.cos(attract.angle) * 46);
    camera.lookAt(p.x, p.y, p.z);
    attract.world.animate(dt, attract.angle);
    renderer.render(attract.world.scene, camera);
  } else if (race) {
    renderer.render(race.world.scene, camera);
  }
}

// ---------------------------------------------------------------------------
// Global events + boot
// ---------------------------------------------------------------------------

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  resize(window.innerWidth, window.innerHeight);
});
resize(window.innerWidth, window.innerHeight);

document.addEventListener('visibilitychange', () => {
  if (document.hidden && mode === 'race' && !paused) setPaused(true);
});

// Attempt autoplay immediately, then retry directly inside trusted input
// events so browsers can unlock a suspended AudioContext on the first gesture.
window.addEventListener('pointerdown', ensureAudio, { capture: true });
window.addEventListener('touchstart', ensureAudio, { capture: true, passive: true });
window.addEventListener('keydown', ensureAudio, { capture: true });

goToTitle();
ensureAudio();

// Dev hook: ?autostart=1&track=harbor-loop&char=nova&diff=hard&seed=42&t=12
// jumps straight into a race (and optionally fast-forwards t seconds of sim).
{
  const q = new URLSearchParams(window.location.search);
  const devScreen = q.get('screen');
  if (devScreen === 'character') { mode = 'character'; screens.showCharacter(CHARACTERS); }
  else if (devScreen === 'track') { mode = 'track'; screens.showTrack(TRACKS); }
  else if (devScreen === 'difficulty') { mode = 'difficulty'; screens.showDifficulty(); }
  else if (devScreen === 'settings') { mode = 'settings'; screens.showSettings(gameSettings); }
  else if (devScreen === 'help') { mode = 'help'; screens.showHelp(); }
  if (q.get('autostart')) {
    if (q.get('char')) selection.characterId = q.get('char');
    if (q.get('track')) selection.trackId = q.get('track');
    if (q.get('diff')) selection.difficulty = q.get('diff');
    startRace();
    const ff = Number(q.get('t')) || 0;
    if (ff > 0 && race) {
      for (let i = 0; i < Math.min(ff, 120) * 120; i++) {
        race.director.update(FIXED_DT, playerControls);
      }
      for (const kart of race.director.karts) kart.clearEvents();
      race.chase.snapTo(race.director.player);
    }
    if (q.get('results') && race) {
      // Fast-forward until the results screen (autopilot drives everyone).
      for (let i = 0; i < 300 * 120 && race.director.state !== RACE_STATE.RESULTS; i++) {
        race.director.update(FIXED_DT, playerControls);
      }
      for (const kart of race.director.karts) kart.clearEvents();
    }
  }
}

requestAnimationFrame(frame);
