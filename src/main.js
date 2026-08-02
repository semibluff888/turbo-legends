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
import { prewarmRaceRenderer } from './net/online-race-loader.js';
import { ERROR_CODES } from './net/protocol.js';
import {
  invitationRoomCode,
  invitationRoomRequest,
  hasReturnedToOnlineRoom,
  isOnlineConnectionError,
  onlineErrorMessage,
  onlineRoomPhase,
  shouldAcknowledgeRaceLoaded,
  shouldPresentOnlineRoom,
  shouldResumeOnlineRoomSession,
  shouldUpdateOnlineRaceBehindPanel,
} from './net/online-flow.js';
import { makeControls, resetControls } from './game/kart.js';
import { createRenderer, buildScene } from './render/scene.js';
import { buildTrackMesh } from './render/trackMesh.js';
import { KartVisual } from './render/kartMesh.js';
import { KartShowroom } from './render/kart-showroom.js';
import { Effects } from './render/effects.js';
import { ChaseCamera, FinishCameraDirector } from './render/camera.js';
import { Hud } from './ui/hud.js';
import { NetworkStatus } from './ui/network-status.js';
import { Screens } from './ui/screens.js';
import { buildInviteUrl, buildLobbyUrl, OnlineScreens } from './ui/online-screens.js';
import { UI_COPY } from './ui/copy.js';
import {
  loadOnlineDisplayName,
  saveOnlineDisplayName,
} from './ui/online-nickname.js';
import { loadOnlineLoadout, saveOnlineLoadout } from './ui/online-loadout-store.js';
import { loadSettings, resetSettings, saveSettings } from './ui/settings-store.js';
import { AudioManager } from './audio/audio.js';
import { InputManager } from './input/input.js?v=20260731-standings';

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

const canvas = document.getElementById('game-canvas');
const finishCinematicSkip = document.getElementById('finish-cinematic-skip');
const { renderer, resize } = createRenderer(canvas);
const camera = new THREE.PerspectiveCamera(
  CAMERA.fov, window.innerWidth / window.innerHeight, CAMERA.near, CAMERA.far);

const input = new InputManager(window);
const audio = new AudioManager();
const loadoutShowroom = new KartShowroom();
let gameSettings = loadSettings();
audio.applySettings(gameSettings);

const hud = new Hud(document.getElementById('hud'), document.getElementById('minimap'));
const networkStatus = new NetworkStatus(document.getElementById('network-status-overlay'));
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
/** Where an auxiliary page returns: title, pause, Lobby, or Room. */
let panelReturn = 'title';

/** Everything belonging to the current race; null between races. */
let race = null;
let onlineLobbyState = null;
let onlineRoomState = null;
let onlineResultsState = null;
let pendingOnlineError = null;
let onlineDisplayName = '';
let onlineLoadout = loadOnlineLoadout();
let handledInviteRoomCode = '';
let pendingInviteJoinCode = '';
let localRoomReconnecting = false;
let reconnectFailurePending = false;
let onlineLoadGeneration = 0;

const playerControls = makeControls();

finishCinematicSkip?.addEventListener('click', () => requestFinishCinematicSkip());

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
    networkStatus.showDetails();
    screens.showCharacter(CHARACTERS);
    playUi('confirm');
  },
  onMultiplayer() {
    playUi('confirm');
    openOnlineLobby();
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
    if (race?.session.kind === 'online') {
      leaveCurrentOnlineRoom();
      return;
    }
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
  lobby: document.getElementById('screen-online-lobby'),
  room: document.getElementById('screen-online-room'),
  results: document.getElementById('screen-online-results'),
}, {
  onBackToTitle() {
    clearOnlineRoomUrl();
    goToTitle();
  },
  onOpenSettings() { openPanel('settings'); },
  onOpenHelp() { openPanel('help'); },
  onNicknameChange({ displayName }) {
    acceptOnlineDisplayName(displayName);
  },
  onCreateRoom({ displayName, roomName, roomType, maxPlayers, trackId, password }) {
    const savedName = acceptOnlineDisplayName(displayName);
    if (!savedName) return;
    clearOnlineRoomUrl();
    pendingOnlineError = null;
    onlineScreens.setBusy(true);
    onlineClient.createRoom({
      displayName: savedName,
      roomName,
      roomType,
      maxPlayers,
      trackId,
      ...onlineLoadout,
      ...(password !== undefined ? { password } : {}),
    });
  },
  onJoinRoom({ displayName, roomCode, password }) {
    const savedName = acceptOnlineDisplayName(displayName);
    if (!savedName) return;
    const inviteCode = invitationRoomCode(window.location.search);
    if (inviteCode && inviteCode === String(roomCode || '').toUpperCase()) {
      pendingInviteJoinCode = inviteCode;
    } else {
      clearOnlineRoomUrl();
    }
    pendingOnlineError = null;
    onlineScreens.setBusy(true);
    onlineClient.joinRoom({
      roomCode,
      displayName: savedName,
      ...onlineLoadout,
      ...(password !== undefined ? { password } : {}),
    });
  },
  onQuickMatch({ displayName }) {
    const savedName = acceptOnlineDisplayName(displayName);
    if (!savedName) return;
    clearOnlineRoomUrl();
    pendingOnlineError = null;
    onlineScreens.setBusy(true);
    onlineClient.quickMatch({ displayName: savedName, ...onlineLoadout });
  },
  onSelectCharacter({ characterId }) {
    onlineClient.selectCharacter(characterId);
  },
  onSetLoadout(loadout) {
    return onlineClient.setLoadout(loadout);
  },
  onLoadoutCommitted(loadout) {
    onlineLoadout = saveOnlineLoadout(loadout);
  },
  onLoadoutPreviewMount({ host, loadout }) {
    loadoutShowroom.attach(host);
    loadoutShowroom.setLoadout(loadout);
  },
  onLoadoutPreviewChange({ loadout }) {
    loadoutShowroom.setLoadout(loadout);
  },
  onLoadoutPreviewDetach() {
    loadoutShowroom.detach();
  },
  onSetRoom(settings) {
    onlineClient.setRoom(settings);
  },
  onReadyChange({ ready }) {
    onlineClient.setReady(ready);
  },
  onKickPlayer({ participantId }) {
    onlineClient.kickPlayer(participantId);
  },
  onStartRace() {
    onlineClient.startRace();
  },
  onLeaveRoom() {
    leaveCurrentOnlineRoom();
  },
  onReturnRoom() {
    onlineClient.returnRoom();
  },
});

wireOnlineClient();
onlineClient.startTelemetry();
void networkStatus.loadVersion();

function ensureOnlineDisplayName() {
  if (!onlineDisplayName) onlineDisplayName = loadOnlineDisplayName();
  return onlineDisplayName;
}

function acceptOnlineDisplayName(value) {
  const saved = saveOnlineDisplayName(value);
  if (!saved) {
    reportOnlineError({ code: 'name_invalid' });
    return '';
  }
  onlineDisplayName = saved;
  return saved;
}

function replaceOnlineRoomUrl(roomCode = '') {
  const nextUrl = roomCode
    ? buildInviteUrl(roomCode, window.location)
    : buildLobbyUrl(window.location);
  if (!nextUrl || nextUrl === window.location.href) return;
  window.history.replaceState(window.history.state, '', nextUrl);
}

function clearOnlineRoomUrl() {
  handledInviteRoomCode = '';
  pendingInviteJoinCode = '';
  replaceOnlineRoomUrl();
  if (onlineScreens.activeScreen === 'lobby') {
    onlineScreens.updateLobby(onlineLobbyState || { rooms: [] }, { inviteRoomCode: '' });
  }
}

function openOnlineLobby({ tryResume = true } = {}) {
  const inviteRequest = invitationRoomRequest(window.location.search);
  const invalidInviteError = inviteRequest.present && !inviteRequest.valid
    ? { code: ERROR_CODES.ROOM_CODE_INVALID }
    : null;
  if (invalidInviteError) {
    pendingOnlineError = null;
    clearOnlineRoomUrl();
  }
  const inviteCode = inviteRequest.code;
  const displayName = ensureOnlineDisplayName();
  mode = 'online-lobby';
  networkStatus.showDetails();
  screens.hideAll();
  hud.hide();
  audio.setGameplaySfxPaused(true);
  audio.playMenuMusic();
  onlineScreens.showLobby(onlineLobbyState || { rooms: [] }, {
    displayName,
    inviteRoomCode: inviteCode,
    ...(invalidInviteError ? {
      error: invalidInviteError,
      errorContext: { action: 'join' },
    } : {}),
  });
  if (tryResume && shouldResumeOnlineRoomSession({
    search: window.location.search,
    roomCode: onlineClient.room?.code,
    participantId: onlineClient.selfId,
    resumeToken: onlineClient.resumeToken,
  })) {
    onlineScreens.setBusy(true);
    onlineClient.resumeRoomSession();
  } else {
    onlineClient.enterLobby({ discardRoomSession: true });
  }
}

function showOnlineLobby(message) {
  onlineLobbyState = message || { rooms: [] };
  mode = 'online-lobby';
  networkStatus.showDetails();
  screens.hideAll();
  hud.hide();
  onlineScreens.setBusy(false);
  const error = pendingOnlineError;
  pendingOnlineError = null;
  const renderLobby = onlineScreens.activeScreen === 'lobby'
    ? onlineScreens.updateLobby.bind(onlineScreens)
    : onlineScreens.showLobby.bind(onlineScreens);
  const lobbyView = renderLobby(onlineLobbyState, {
    displayName: ensureOnlineDisplayName(),
    inviteRoomCode: invitationRoomCode(window.location.search),
    ...(error ? { error: error.message, errorContext: error.context } : {}),
  });
  attemptInviteJoin(lobbyView);
  audio.setGameplaySfxPaused(true);
  audio.playMenuMusic();
  if (!race) buildAttract();
}

function attemptInviteJoin(lobbyView) {
  const inviteCode = invitationRoomCode(window.location.search);
  if (!inviteCode || inviteCode === handledInviteRoomCode) return;
  handledInviteRoomCode = inviteCode;

  const invitedRoom = lobbyView?.invitedRoom;
  if (!invitedRoom) {
    rejectInviteJoin(ERROR_CODES.ROOM_NOT_FOUND);
    return;
  }
  if (!invitedRoom.joinable) {
    rejectInviteJoin(invitedRoom.status === 'full'
      ? ERROR_CODES.ROOM_FULL
      : ERROR_CODES.ROOM_LOCKED);
    return;
  }
  if (!onlineScreens.joinInvitedRoom(inviteCode)) {
    rejectInviteJoin(ERROR_CODES.ROOM_NOT_FOUND);
  }
}

function rejectInviteJoin(code) {
  clearOnlineRoomUrl();
  onlineScreens.setBusy(false);
  onlineScreens.presentError({ code }, { action: 'join' });
}

function showOnlineRoom(message, { preservePanel = false } = {}) {
  const roomState = message?.room || message || {};
  onlineRoomState = roomState;
  const roomCode = roomState.roomCode || roomState.code || onlineClient.room?.code;
  if (roomCode) {
    pendingInviteJoinCode = '';
    handledInviteRoomCode = String(roomCode).toUpperCase();
    replaceOnlineRoomUrl(roomCode);
  }
  const phase = onlineRoomPhase(roomState);
  const returnedFromResults = hasReturnedToOnlineRoom(roomState, onlineClient.selfId);
  if ((phase === 'waiting' || returnedFromResults) && race?.session.kind === 'online') {
    endRace();
    buildAttract();
  }
  if (!shouldPresentOnlineRoom(
    roomState,
    race?.session.kind === 'online',
    onlineClient.selfId,
  )) return;

  if (!race) destroyAttract();

  networkStatus.showDetails();
  hud.hide();
  onlineScreens.setBusy(false);
  const error = pendingOnlineError;
  pendingOnlineError = null;
  if (preservePanel) {
    onlineScreens.updateRoom(roomState, {
      localParticipantId: onlineClient.selfId,
      ...(error ? { error: error.message, errorContext: error.context } : {}),
    });
    return;
  }
  mode = 'online-room';
  screens.hideAll();
  const renderRoom = onlineScreens.activeScreen === 'room'
    ? onlineScreens.updateRoom.bind(onlineScreens)
    : onlineScreens.showRoom.bind(onlineScreens);
  renderRoom(roomState, {
    localParticipantId: onlineClient.selfId,
    ...(error ? { error: error.message, errorContext: error.context } : {}),
  });
  audio.setGameplaySfxPaused(true);
  audio.playMenuMusic();
}

function leaveCurrentOnlineRoom() {
  onlineClient.leaveRoom();
  clearOnlineRoomUrl();
  onlineRoomState = null;
  onlineResultsState = null;
  paused = false;
  if (race) endRace();
  buildAttract();
  showOnlineLobby(onlineLobbyState || { rooms: [] });
}

function onlineHostId(roomState = onlineRoomState) {
  return roomState?.hostParticipantId
    || roomState?.hostId
    || roomState?.ownerId
    || null;
}

function hasRoomReconnectUiContext() {
  return mode === 'online-room'
    || ((mode === 'settings' || mode === 'help') && panelReturn === 'online-room');
}

function beginLocalRoomReconnect() {
  if (reconnectFailurePending
    || onlineClient.scope !== 'room'
    || !hasRoomReconnectUiContext()) return false;
  localRoomReconnecting = true;
  onlineScreens.setRoomReconnecting(true);
  return true;
}

function finishLocalRoomReconnect({ restoreFocus = true } = {}) {
  if (!localRoomReconnecting) return false;
  localRoomReconnecting = false;
  onlineScreens.setRoomReconnecting(false, { restoreFocus });
  return true;
}

function returnToLobbyAfterReconnectFailure() {
  if (!reconnectFailurePending) return;
  reconnectFailurePending = false;
  if (race?.session.kind === 'online') endRace();
  paused = false;
  buildAttract();
  openOnlineLobby({ tryResume: false });
}

function presentRoomReconnectFailure(event) {
  finishLocalRoomReconnect({ restoreFocus: false });
  reconnectFailurePending = true;
  pendingOnlineError = null;
  if (race?.session.kind === 'online') {
    paused = true;
    resetControls(playerControls);
    audio.setGameplaySfxPaused(true);
  }
  clearOnlineRoomUrl();
  onlineRoomState = null;
  onlineScreens.setBusy(false);
  buildAttract();
  onlineScreens.showAlert(
    onlineErrorMessage(event, event?.code === 'session_replaced'
      ? 'This room session was resumed in another window.'
      : 'The reconnect window expired. Join the room again.'),
    {
      title: UI_COPY.online.alerts.reconnectExpiredTitle,
      buttonLabel: UI_COPY.online.alerts.returnLobby,
      restoreFocus: null,
      onConfirm: returnToLobbyAfterReconnectFailure,
    },
  );
}

function wireOnlineClient() {
  onlineClient.on('connection', ({ state }) => {
    const viewState = state === 'idle' ? 'disconnected' : state;
    networkStatus.setConnectionState(viewState);
    if (state === 'disconnected' || state === 'reconnecting') beginLocalRoomReconnect();
  });
  onlineClient.on('telemetry', (metrics) => networkStatus.setMetrics(metrics));
  onlineClient.on('lobby_state', (message) => {
    onlineLobbyState = message || { rooms: [] };
    if (mode === 'online-lobby') showOnlineLobby(onlineLobbyState);
    else if ((mode === 'settings' || mode === 'help') && panelReturn === 'online-lobby') {
      onlineScreens.updateLobby(onlineLobbyState, {
        displayName: ensureOnlineDisplayName(),
        inviteRoomCode: invitationRoomCode(window.location.search),
      });
    }
  });
  onlineClient.on('room_state', (message) => {
    finishLocalRoomReconnect();
    showOnlineRoom(message, {
      preservePanel: (mode === 'settings' || mode === 'help') && panelReturn === 'online-room',
    });
    updateOnlineLoadingOverlay();
  });
  onlineClient.on('kicked', (message) => {
    finishLocalRoomReconnect({ restoreFocus: false });
    pendingOnlineError = null;
    clearOnlineRoomUrl();
    onlineRoomState = null;
    onlineResultsState = null;
    paused = false;
    if (race) endRace();
    buildAttract();
    showOnlineLobby(onlineLobbyState || { rooms: [] });
    onlineScreens.showAlert(message?.message || UI_COPY.online.room.kickedMessage, {
      title: UI_COPY.online.alerts.kickedTitle,
      restoreFocus: null,
    });
  });
  onlineClient.on('prepare_race', (message) => {
    Promise.resolve(startOnlineRace(message)).catch((error) => {
      if (race?.session.kind === 'online' && race.session.raceId === message?.raceId) endRace();
      onlineScreens.setBusy(false);
      reportOnlineError(error?.message || 'Unable to start the online race.', { action: 'start' });
    });
  });
  onlineClient.on('race_loaded_ack', (message) => {
    if (race?.session.kind !== 'online' || race.session.raceId !== message?.raceId) return;
    race.loadAcknowledged = true;
    if (race.loadReady) startOnlineRaceMusic(race);
    activateOnlineRaceIfReady(race);
  });
  onlineClient.on('snapshot', (message) => {
    if (race?.session.kind !== 'online'
      || race.session.raceId !== message?.raceId
      || !Array.isArray(message?.karts)) return;
    race.hasAuthoritativeSnapshot = true;
    activateOnlineRaceIfReady(race);
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
    const connectionError = isOnlineConnectionError(message);
    if (connectionError) {
      networkStatus.setConnectionState('error');
    }
    if (reconnectFailurePending) return;
    if (connectionError && beginLocalRoomReconnect()) return;
    if (localRoomReconnecting && [
      ERROR_CODES.SESSION_NOT_FOUND,
      ERROR_CODES.SESSION_EXPIRED,
      'session_replaced',
    ].includes(String(message?.code || ''))) return;
    if (pendingInviteJoinCode) clearOnlineRoomUrl();
    reportOnlineError(message, { connectionError });
  });
  onlineClient.on('reconnect_expired', (event) => {
    if (hasRoomReconnectUiContext()
      || localRoomReconnecting
      || race?.session.kind === 'online') {
      presentRoomReconnectFailure(event);
      return;
    }
    pendingOnlineError = null;
    clearOnlineRoomUrl();
    if (race?.session.kind === 'online') endRace();
    onlineRoomState = null;
    buildAttract();
    openOnlineLobby({ tryResume: false });
    onlineScreens.setBusy(false);
    onlineScreens.presentError({
      ...event,
      message: onlineErrorMessage(event, event?.code === 'session_replaced'
        ? 'This room session was resumed in another window.'
        : 'The reconnect window expired. Join the room again.'),
    }, { action: 'join' });
  });
}

function reportOnlineError(message, context = {}) {
  if (onlineScreens.activeScreen) onlineScreens.presentError(message, context);
  else pendingOnlineError = { message, context };
}

function goToTitle() {
  mode = 'title';
  paused = false;
  panelReturn = 'title';
  onlineScreens.hideAll();
  screens.showTitle();
  hud.hide();
  networkStatus.showDetails();
  audio.setGameplaySfxPaused(true);
  audio.playMenuMusic();
  buildAttract();
  if (onlineClient.scope === 'none') onlineClient.enterLobby();
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
  panelReturn = mode === 'online-lobby' || mode === 'online-room'
    ? mode
    : race && paused ? 'pause' : 'title';
  mode = name;
  if (panelReturn !== 'pause') networkStatus.showDetails();
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
  } else if (panelReturn === 'online-lobby' || panelReturn === 'online-room') {
    screens.hideAll();
    mode = panelReturn;
    networkStatus.showDetails();
    onlineScreens.focusPageAction(panelReturn === 'online-lobby' ? 'lobby' : 'room');
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

function onlineLoadedCountText(roomState = onlineRoomState) {
  const members = roomState?.members || roomState?.participants || roomState?.players || [];
  if (!Array.isArray(members) || members.length === 0) return 'PREPARING LOCAL RESOURCES';
  const loaded = members.filter((member) => member?.loaded === true).length;
  return `${loaded}/${members.length} PLAYERS LOADED`;
}

function updateOnlineLoadingOverlay(stage = race?.loadingStage) {
  if (race?.session.kind !== 'online' || race.onlineActivated) return;
  hud.showLoading(stage || 'BUILDING RACE...', onlineLoadedCountText());
}

function isCurrentOnlineLoad(mountedRace, token) {
  return race === mountedRace
    && mountedRace?.session.kind === 'online'
    && mountedRace.loadToken === token
    && token === onlineLoadGeneration;
}

function startOnlineRaceMusic(mountedRace) {
  if (!mountedRace || mountedRace.musicStarted) return;
  mountedRace.musicStarted = true;
  audio.playRaceMusic(mountedRace.track.id, { restart: true });
}

function submitOnlineRaceLoaded(mountedRace) {
  if (!mountedRace || race !== mountedRace || mountedRace.session.kind !== 'online') return false;
  const raceId = mountedRace.session.raceId;
  const acknowledged = onlineClient.hasRaceLoadedAck(raceId);
  mountedRace.loadAcknowledged = acknowledged;
  if (!shouldAcknowledgeRaceLoaded({ raceId }, acknowledged)) {
    startOnlineRaceMusic(mountedRace);
    return true;
  }
  if (!onlineClient.markRaceLoaded(raceId)) {
    mountedRace.loadingStage = 'WAITING FOR CONNECTION...';
    updateOnlineLoadingOverlay(mountedRace.loadingStage);
    return false;
  }
  mountedRace.loadSubmitted = true;
  mountedRace.loadingStage = 'SYNCING RACE...';
  updateOnlineLoadingOverlay(mountedRace.loadingStage);
  startOnlineRaceMusic(mountedRace);
  return true;
}

function activateOnlineRaceIfReady(mountedRace) {
  if (!mountedRace
    || race !== mountedRace
    || mountedRace.onlineActivated
    || !mountedRace.loadReady
    || !mountedRace.loadAcknowledged
    || !mountedRace.hasAuthoritativeSnapshot) return false;
  mountedRace.onlineActivated = true;
  hud.hideLoading();
  audio.setGameplaySfxPaused(false);
  audio.startEngine();
  return true;
}

async function prewarmOnlineRace(mountedRace, token) {
  const ready = await prewarmRaceRenderer({
    renderer,
    scene: mountedRace.world.scene,
    camera,
    isCurrent: () => isCurrentOnlineLoad(mountedRace, token),
    onStage: (stage) => {
      mountedRace.loadingStage = stage === 'compile'
        ? 'WARMING UP GPU...'
        : 'PREPARING FIRST FRAME...';
      updateOnlineLoadingOverlay(mountedRace.loadingStage);
    },
  });
  if (!ready) return false;

  mountedRace.loadReady = true;
  submitOnlineRaceLoaded(mountedRace);
  activateOnlineRaceIfReady(mountedRace);
  return true;
}

function startOnlineRace(message) {
  const mountedSession = race?.session;
  if (mountedSession?.kind === 'online' && mountedSession.raceId === message?.raceId) {
    mountedSession.resumeFromPrepare?.(message);
    if (race.loadReady) submitOnlineRaceLoaded(race);
    return race.loadTask;
  }

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
    roomState: onlineRoomState,
  });
  onlineResultsState = null;
  const token = ++onlineLoadGeneration;
  const mountedRace = mountRace(track, session, def, {
    onlineLoading: true,
    loadToken: token,
  });
  onlineScreens.hideAll();
  mountedRace.loadTask = prewarmOnlineRace(mountedRace, token);
  return mountedRace.loadTask;
}

function mountRace(track, session, def, { onlineLoading = false, loadToken = null } = {}) {
  const world = buildScene(track);
  world.scene.add(buildTrackMesh(track));

  const visuals = session.karts.map((k) => new KartVisual(k, world.scene));
  const effects = new Effects(world.scene);
  const chase = new ChaseCamera(camera);
  if (chase.setTrack) chase.setTrack(track);
  chase.snapTo(session.player);
  const finishCamera = new FinishCameraDirector(camera, track);

  race = {
    track, session, world, visuals, effects, chase, finishCamera,
    online: session.kind === 'online',
    accumulator: 0,
    finalLapAnnounced: false,
    finishedAnnounced: false,
    resultsShown: false,
    finishSkipped: false,
    lastCountdownBeep: -1,
    sawCountdown: false,
    loadToken,
    loadTask: null,
    loadReady: !onlineLoading,
    loadSubmitted: false,
    loadAcknowledged: !onlineLoading,
    hasAuthoritativeSnapshot: !onlineLoading,
    onlineActivated: !onlineLoading,
    loadingStage: onlineLoading ? 'BUILDING RACE...' : '',
    musicStarted: !onlineLoading,
  };

  mode = 'race';
  paused = false;
  screens.hideAll();
  onlineScreens.hideAll();
  hud.showRace(session);
  networkStatus.showRace();
  audio.setGameplaySfxPaused(onlineLoading);
  if (onlineLoading) {
    audio.stopEngine();
    updateOnlineLoadingOverlay(race.loadingStage);
  } else {
    audio.playRaceMusic(def.id, { restart: true });
    audio.startEngine();
  }
  audio.setFinalLap(false);
  resetControls(playerControls);
  return race;
}

function endRace() {
  if (!race) return;
  onlineLoadGeneration++;
  setFinishCinematic(false);
  race.finishCamera.reset();
  camera.fov = CAMERA.fov;
  camera.updateProjectionMatrix();
  race.session.dispose?.();
  audio.stopEngine();
  hud.hide();
  networkStatus.hide();
  disposeSceneDeep(race.world.scene);
  race = null;
}

function setFinishCinematic(active) {
  document.body.classList.toggle('finish-cinematic', Boolean(active));
  if (finishCinematicSkip) {
    finishCinematicSkip.hidden = true;
    finishCinematicSkip.disabled = true;
  }
}

function updateFinishCinematicUi() {
  if (!finishCinematicSkip || !race?.finishCamera.active) return;
  const showSkip = race.finishCamera.canSkip && !race.finishSkipped;
  finishCinematicSkip.hidden = !showSkip;
  finishCinematicSkip.disabled = !showSkip;
}

function requestFinishCinematicSkip() {
  if (!race?.finishCamera.canSkip || race.finishSkipped) return false;
  if (!race.finishCamera.skipIntro()) return false;
  race.finishSkipped = true;
  updateFinishCinematicUi();
  return true;
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
  const { session, visuals, effects, chase, finishCamera, world } = race;
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

  // The player's finish is a presentation transition only. Simulation and
  // online snapshot flow continue normally while the camera director takes over.
  if (player.finished && !race.finishedAnnounced) {
    race.finishedAnnounced = true;
    audio.setFinalLap(false);
    finishCamera.begin(player);
    setFinishCinematic(true);
  }
  if (finishCamera.active) {
    if (input.menu.confirm) requestFinishCinematicSkip();
    finishCamera.update(dt, {
      player,
      standings: session.standings,
      laps: session.laps,
    });
  } else {
    chase.update(dt, player, playerControls.lookBack);
  }
  world.animate(dt, session.elapsed);
  hud.update(player, session, dt, {
    showStandings: input.standingsHeld,
  });
  updateFinishCinematicUi();

  // Authoritative results may arrive before the three-second hero sequence ends.
  // A deliberate skip completes the intro early; otherwise results wait.
  if (session.state === RACE_STATE.RESULTS && !race.resultsShown
      && (!finishCamera.active || finishCamera.introComplete)) {
    presentRaceResults();
  }
}

function presentRaceResults() {
  if (!race || race.resultsShown) return;
  const { session, finishCamera } = race;
  const online = session.kind === 'online';
  const hadFinishCamera = finishCamera.active;

  race.resultsShown = true;
  race.resultsShownAt = performance.now() / 1000;
  setFinishCinematic(false);
  finishCamera.reset();
  hud.hide(); // the results panel owns the screen now
  networkStatus.showDetails();
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
    pendingOnlineError = null;
    onlineScreens.showResults(onlineResultsState || fallback, {
      localParticipantId: onlineClient.selfId,
      isHost: onlineHostId() === onlineClient.selfId,
      trackName: race.track.name,
      ...(error ? { error: error.message } : {}),
    });
  } else {
    mode = 'results';
    screens.showResults(session.standings, session.player, race.track.name);
  }
  resetControls(playerControls);
  race.accumulator = 0;
  if (!hadFinishCamera) race.chase.settle?.();
  audio.stopEngine();
  audio.setFinalLap(false);
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

  if (mode === 'online-room'
    || ((mode === 'settings' || mode === 'help') && panelReturn === 'online-room')) {
    loadoutShowroom.update(dt);
  }

  input.setStandingsContext(mode === 'race' && !paused);
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
  if (devScreen) networkStatus.showDetails();
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
  } else if (!devScreen && q.has('room')) {
    openOnlineLobby();
  }
}

requestAnimationFrame(frame);
