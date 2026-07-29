// Turbo Legends — boot, screen flow, and the fixed-step game loop.
// This is the only module that imports everything; it owns the frame.

import * as THREE from 'three';
import { FIXED_DT, MAX_FRAME_TIME, RACE_STATE, CAMERA, RACE } from './core/constants.js';
import { Track } from './track/track.js';
import { TRACKS, TRACKS_BY_ID, getTrackDef } from './track/tracks.js';
import { CHARACTERS } from './game/characters.js';
import { LocalRaceSession } from './session/local-race-session.js';
import { OnlineClient } from './net/online-client.js';
import { OnlineRaceSession } from './net/online-race-session.js';
import {
  invitationRoomCode,
  hasReturnedToOnlineLobby,
  isOnlineConnectionError,
  onlineRoomPhase,
  shouldAcknowledgeRaceLoaded,
  shouldPresentOnlineLobby,
  shouldResumeStoredOnlineSession,
  shouldUpdateOnlineRaceBehindPanel,
} from './net/online-flow.js';
import { makeControls, resetControls } from './game/kart.js';
import { createRenderer, buildScene } from './render/scene.js';
import { buildTrackMesh } from './render/trackMesh.js';
import { KartVisual } from './render/kartMesh.js';
import { Effects } from './render/effects.js';
import { ChaseCamera } from './render/camera.js';
import { Hud } from './ui/hud.js';
import { Screens } from './ui/screens.js';
import { OnlineScreens } from './ui/online-screens.js';
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
const onlineClient = new OnlineClient();

/** Player selections, persisted across races in this session. */
const selection = {
  characterId: CHARACTERS[2].id,
  trackId: TRACKS[0].id,
  difficulty: 'normal',
};

/** App route: title/selection/panels, online entry/lobby, race, or results. */
let mode = 'title';
let paused = false;
/** Where an auxiliary page returns: the title menu or the in-race pause menu. */
let panelReturn = 'title';

/** Everything belonging to the current race; null between races. */
let race = null;
let onlineRoomState = null;
let onlineResultsState = null;
let pendingOnlineError = '';

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
  onMultiplayer() {
    playUi('confirm');
    openOnlineEntry();
  },
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
    if (race?.session.kind === 'online') onlineClient.leave();
    paused = false;
    endRace();
    goToTitle();
  },
  onResultsDone() {
    endRace();
    goToTitle();
  },
});

const onlineScreens = new OnlineScreens({
  entry: document.getElementById('screen-online-entry'),
  lobby: document.getElementById('screen-online-lobby'),
  results: document.getElementById('screen-online-results'),
}, {
  onBackToTitle() {
    onlineClient.leave();
    onlineRoomState = null;
    goToTitle();
  },
  onCreateRoom({ displayName }) {
    saveOnlineDisplayName(displayName);
    pendingOnlineError = '';
    onlineScreens.setBusy(true);
    onlineScreens.clearError();
    onlineClient.createRoom(displayName);
  },
  onJoinRoom({ displayName, roomCode }) {
    saveOnlineDisplayName(displayName);
    pendingOnlineError = '';
    onlineScreens.setBusy(true);
    onlineScreens.clearError();
    onlineClient.joinRoom(roomCode, displayName);
  },
  onSelectCharacter({ characterId }) {
    onlineScreens.clearError();
    onlineClient.selectCharacter(characterId);
  },
  onSetRoom(settings) {
    onlineScreens.clearError();
    onlineClient.setRoom(settings);
  },
  onReadyChange({ ready }) {
    onlineScreens.clearError();
    onlineClient.setReady(ready);
  },
  onStartRace() {
    onlineScreens.clearError();
    onlineClient.startRace();
  },
  onLeaveRoom() {
    onlineClient.leave();
    onlineRoomState = null;
    if (race) endRace();
    goToTitle();
  },
  onReturnLobby() {
    onlineScreens.clearError();
    onlineClient.returnLobby();
  },
});

wireOnlineClient();

const ONLINE_NAME_KEY = 'turbo-legends.online-name.v1';

function loadOnlineDisplayName() {
  try {
    return String(globalThis.localStorage?.getItem(ONLINE_NAME_KEY) || 'Racer');
  } catch {
    return 'Racer';
  }
}

function saveOnlineDisplayName(value) {
  try {
    globalThis.localStorage?.setItem(ONLINE_NAME_KEY, String(value || '').trim());
  } catch {
    // A blocked localStorage must not prevent anonymous online play.
  }
}

function openOnlineEntry({ tryResume = true } = {}) {
  const inviteCode = invitationRoomCode(window.location.search);
  mode = 'online-entry';
  screens.hideAll();
  hud.hide();
  audio.setGameplaySfxPaused(true);
  audio.playMenuMusic();
  onlineScreens.showEntry({
    displayName: loadOnlineDisplayName(),
    roomCode: inviteCode,
    connectionState: onlineClient.state === 'idle' ? 'disconnected' : onlineClient.state,
  });
  if (tryResume && shouldResumeStoredOnlineSession({
    search: window.location.search,
    roomCode: onlineClient.room?.code,
    participantId: onlineClient.selfId,
    resumeToken: onlineClient.resumeToken,
  })) {
    onlineScreens.setBusy(true);
    onlineClient.resumeStored();
  }
}

function showOnlineLobby(message) {
  const roomState = message?.room || message || {};
  onlineRoomState = roomState;
  const phase = onlineRoomPhase(roomState);
  const returnedFromResults = hasReturnedToOnlineLobby(roomState, onlineClient.selfId);
  if ((phase === 'lobby' || returnedFromResults) && race?.session.kind === 'online') {
    endRace();
    buildAttract();
  }
  if (!shouldPresentOnlineLobby(
    roomState,
    race?.session.kind === 'online',
    onlineClient.selfId,
  )) return;

  mode = 'online-lobby';
  screens.hideAll();
  hud.hide();
  onlineScreens.setBusy(false);
  const error = pendingOnlineError;
  pendingOnlineError = '';
  onlineScreens.showLobby(roomState, {
    localParticipantId: onlineClient.selfId,
    ...(error ? { error } : { clearError: true }),
  });
  audio.setGameplaySfxPaused(true);
  audio.playMenuMusic();
}

function onlineHostId(roomState = onlineRoomState) {
  return roomState?.hostParticipantId
    || roomState?.hostId
    || roomState?.ownerId
    || null;
}

function wireOnlineClient() {
  onlineClient.on('connection', ({ state, reason }) => {
    const viewState = state === 'idle' ? 'disconnected' : state;
    onlineScreens.setConnectionState(viewState, reason || '');
  });
  onlineClient.on('room_state', showOnlineLobby);
  onlineClient.on('prepare_race', (message) => {
    try {
      startOnlineRace(message);
    } catch (error) {
      onlineScreens.setBusy(false);
      reportOnlineError(error?.message || 'Unable to start the online race.');
    }
  });
  onlineClient.on('race_results', (message) => {
    onlineResultsState = message;
    if (mode === 'online-results' && race?.session.kind === 'online') {
      onlineScreens.updateResults(message, {
        localParticipantId: onlineClient.selfId,
        isHost: onlineHostId() === onlineClient.selfId,
        trackName: race.track.name,
      });
    }
  });
  onlineClient.on('error', (message) => {
    onlineScreens.setBusy(false);
    if (isOnlineConnectionError(message)) onlineScreens.setConnectionState('error');
    reportOnlineError(message?.message || 'Online request failed.');
  });
  onlineClient.on('reconnect_expired', (event) => {
    pendingOnlineError = '';
    if (race?.session.kind === 'online') endRace();
    openOnlineEntry({ tryResume: false });
    onlineScreens.setBusy(false);
    onlineScreens.showError(event?.code === 'session_replaced'
      ? 'This room session was resumed in another window.'
      : 'The reconnect window expired. Join the room again.');
  });
}

function reportOnlineError(message) {
  const text = String(message || 'Online request failed.');
  if (onlineScreens.activeScreen) onlineScreens.showError(text);
  else pendingOnlineError = text;
}

function goToTitle() {
  mode = 'title';
  paused = false;
  panelReturn = 'title';
  onlineScreens.hideAll();
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
    screens.showPause({ online: race.session.kind === 'online' });
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
  const session = new LocalRaceSession(track, {
    playerCharacterId: selection.characterId,
    difficulty: selection.difficulty,
    seed: (Date.now() & 0xffffff) ^ 0x5eed,
  });
  mountRace(track, session, def);
}

function startOnlineRace(message) {
  destroyAttract();
  if (race) endRace();

  const trackId = message.trackId || message.settings?.trackId || message.track?.id;
  const def = TRACKS_BY_ID[trackId];
  if (!def) throw new Error('The server selected an unknown track.');
  if (typeof message.raceId !== 'string' || !message.raceId) {
    throw new Error('The server sent an invalid race id.');
  }
  const roster = message.roster || message.participants;
  if (!Array.isArray(roster) || roster.length === 0) {
    throw new Error('The server sent an invalid race roster.');
  }
  const track = new Track(def);
  const session = new OnlineRaceSession({
    client: onlineClient,
    track,
    raceId: message.raceId,
    roster,
    localParticipantId: onlineClient.selfId,
  });
  onlineResultsState = null;
  mountRace(track, session, def);
  onlineScreens.hideAll();
  if (shouldAcknowledgeRaceLoaded(message, onlineRoomState)) {
    onlineClient.markRaceLoaded(message.raceId);
  }
}

function mountRace(track, session, def) {
  const world = buildScene(track);
  world.scene.add(buildTrackMesh(track));

  const visuals = session.karts.map((k) => new KartVisual(k, world.scene));
  const effects = new Effects(world.scene);
  const chase = new ChaseCamera(camera);
  if (chase.setTrack) chase.setTrack(track);
  chase.snapTo(session.player);

  race = {
    track, session, world, visuals, effects, chase,
    online: session.kind === 'online',
    accumulator: 0,
    finalLapAnnounced: false,
    finishedAnnounced: false,
    resultsShown: false,
    lastCountdownBeep: -1,
    sawCountdown: false,
  };

  mode = 'race';
  paused = false;
  screens.hideAll();
  onlineScreens.hideAll();
  hud.showRace(session);
  audio.setGameplaySfxPaused(false);
  audio.playRaceMusic(def.id, { restart: true });
  audio.setFinalLap(false);
  audio.startEngine();
  resetControls(playerControls);
}

function endRace() {
  if (!race) return;
  race.session.dispose?.();
  audio.stopEngine();
  hud.hide();
  disposeSceneDeep(race.world.scene);
  race = null;
}

function setPaused(p) {
  if (!race || race.session.state === RACE_STATE.RESULTS) return;
  paused = p;
  if (p && race.session.kind === 'online') {
    resetControls(playerControls);
    race.session.sendNeutralInput?.();
  }
  audio.setGameplaySfxPaused(p);
  if (p) {
    screens.showPause({ online: race.session.kind === 'online' });
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
  const { session, effects, chase } = race;
  for (const kart of session.karts) {
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
  if (session.items && session.items.drainVfx) {
    for (const v of session.items.drainVfx()) {
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
  const { session, visuals, effects, chase, world } = race;
  const online = session.kind === 'online';

  // --- Simulation at fixed timestep ---------------------------------------
  if (!paused || online) {
    if (paused) resetControls(playerControls);
    else input.readControls(playerControls);
    race.accumulator = Math.min(race.accumulator + dt, MAX_FRAME_TIME);
    while (race.accumulator >= FIXED_DT) {
      session.update(FIXED_DT, playerControls);
      race.accumulator -= FIXED_DT;
    }
  }

  // --- Presentation ---------------------------------------------------------
  const player = session.player;

  // Countdown beeps (audio keyed to the integer countdown value).
  const hasAuthoritativeState = !online || session.hasSnapshot;
  if (hasAuthoritativeState && session.state === RACE_STATE.COUNTDOWN) {
    const n = Math.ceil(session.countdown);
    if (n !== race.lastCountdownBeep && n <= 3) {
      race.lastCountdownBeep = n;
      race.sawCountdown = true;
      audio.countdownBeep(n);
      hud.countdown(n);
    }
  } else if (hasAuthoritativeState && race.sawCountdown && race.lastCountdownBeep !== 0) {
    race.lastCountdownBeep = 0;
    audio.countdownBeep(0);
    hud.countdown('go');
  }

  for (const v of visuals) v.sync(camera.position);

  // Continuous particle sources.
  for (const kart of session.karts) {
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
  audio.consume(session.karts, session);
  audio.update(dt, player, session);
  for (const kart of session.karts) kart.clearEvents();

  effects.update(dt);
  chase.update(dt, player, playerControls.lookBack);
  world.animate(dt, session.elapsed);
  hud.update(player, session, dt);

  // Finish / results flow (the HUD shows its own FINISHED banner).
  if (player.finished && !race.finishedAnnounced) {
    race.finishedAnnounced = true;
    audio.setFinalLap(false);
  }
  if (session.state === RACE_STATE.RESULTS && !race.resultsShown) {
    race.resultsShown = true;
    race.resultsShownAt = performance.now() / 1000;
    hud.hide(); // the results panel owns the screen now
    if (online) {
      mode = 'online-results';
      screens.hideAll();
      const fallback = {
        raceId: session.raceId,
        trackName: race.track.name,
        standings: session.standings.map((kart) => ({
          kartIndex: kart.index,
          participantId: kart.participantId,
          displayName: kart.name,
          characterId: kart.character.id,
          rank: kart.rank,
          finished: kart.finished,
          finishTime: kart.finishTime,
          bestLap: kart.bestLap,
          lapTimes: kart.lapTimes,
        })),
      };
      const error = pendingOnlineError;
      pendingOnlineError = '';
      onlineScreens.showResults(onlineResultsState || fallback, {
        localParticipantId: onlineClient.selfId,
        isHost: onlineHostId() === onlineClient.selfId,
        trackName: race.track.name,
        ...(error ? { error } : {}),
      });
    } else {
      mode = 'results';
      screens.showResults(session.standings, player, race.track.name);
    }
    resetControls(playerControls);
    race.accumulator = 0;
    race.chase.settle?.();
    audio.stopEngine();
    audio.setFinalLap(false);
  }
}

function updateResultsFrame(dt) {
  if (!race) return;
  const { session, visuals, effects, world } = race;
  session.update(Math.min(dt, MAX_FRAME_TIME), playerControls);
  for (const visual of visuals) visual.sync(camera.position);
  effects.update(dt);
  world.animate(dt, session.elapsed);
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

  if (shouldUpdateOnlineRaceBehindPanel({
    mode,
    paused,
    raceKind: race?.session.kind,
  })) {
    updateMenus();
    updateRaceFrame(dt);
    renderer.render(race.world.scene, camera);
    return;
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
    updateRaceFrame(paused && race.session.kind !== 'online' ? 0 : dt);
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
      updateResultsFrame(dt);
      renderer.render(race.world.scene, camera);
    }
    return;
  }

  if (mode === 'online-results') {
    if (race) {
      updateResultsFrame(dt);
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
  if (!document.hidden || mode !== 'race' || paused) return;
  if (race?.session.kind === 'online') {
    resetControls(playerControls);
    race.session.sendNeutralInput?.();
  } else {
    setPaused(true);
  }
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
        race.session.update(FIXED_DT, playerControls);
      }
      for (const kart of race.session.karts) kart.clearEvents();
      race.chase.snapTo(race.session.player);
    }
    if (q.get('results') && race) {
      // Fast-forward until the results screen (autopilot drives everyone).
      for (let i = 0; i < 300 * 120 && race.session.state !== RACE_STATE.RESULTS; i++) {
        race.session.update(FIXED_DT, playerControls);
      }
      for (const kart of race.session.karts) kart.clearEvents();
    }
  } else if (!devScreen && (q.get('room')
    || (onlineClient.room?.code && onlineClient.selfId && onlineClient.resumeToken))) {
    openOnlineEntry();
  }
}

requestAnimationFrame(frame);
