import * as THREE from 'three';
import { ITEM, ITEM_PHYSICS, RACE_STATE } from '../core/constants.js';
import {
  findKartByIndex,
  findRaceLeader,
  findRedShellTarget,
  predictBombTrajectory,
} from '../game/items.js';

const GUIDE_DISTANCE = 15;
const GUIDE_SEGMENTS = 5;
const TARGET_HEIGHT = 1.75;
const CANDIDATE_CUE_DELAY = 0.15;
const NEAR_ETA = 1.2;
const CRITICAL_ETA = 0.55;
const NEAR_WARNING_INTERVAL = 0.6;
const CRITICAL_WARNING_INTERVAL = 0.25;

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function activeRace(player, race) {
  return !!player && !!race && !player.finished && race.state === RACE_STATE.RACING;
}

/** Straight shell preview; wall bounces intentionally remain a player skill. */
export function buildStraightAimGuide(kart, track, { back = false } = {}) {
  if (!kart || !track || typeof track.sampleWorld !== 'function') return [];
  const direction = back ? -1 : 1;
  const startOffset = back ? ITEM_PHYSICS.trailOffset : ITEM_PHYSICS.launchOffset;
  let hintS = kart.s;
  const points = [];
  for (let index = 0; index <= GUIDE_SEGMENTS; index++) {
    const distance = startOffset + GUIDE_DISTANCE * index / GUIDE_SEGMENTS;
    const x = kart.x + kart.forwardX * distance * direction;
    const z = kart.z + kart.forwardZ * distance * direction;
    const sample = track.sampleWorld(x, z, hintS, {}, kart.y);
    hintS = sample.s;
    points.push({ x, y: sample.height + 0.45, z });
  }
  return points;
}

export function selectIncomingThreat(player, projectiles) {
  if (!player || player.invulnerable || !Array.isArray(projectiles)) return null;
  let best = null;
  for (const projectile of projectiles) {
    if (!projectile || projectile.targetIndex !== player.index) continue;
    if (projectile.kind !== ITEM.RED_SHELL && projectile.kind !== ITEM.BLUE_SHELL) continue;
    const dx = finite(projectile.x) - finite(player.x);
    const dz = finite(projectile.z) - finite(player.z);
    const distance = Math.hypot(dx, dz);
    const fallbackSpeed = projectile.kind === ITEM.BLUE_SHELL
      ? ITEM_PHYSICS.blueShellSpeed : ITEM_PHYSICS.shellSpeed;
    const speed = Math.max(1, Math.hypot(finite(projectile.vx), finite(projectile.vz)) || fallbackSpeed);
    const eta = distance / speed;
    if (!best || eta < best.eta) best = { projectile, distance, eta };
  }
  if (!best) return null;
  const severity = best.eta <= CRITICAL_ETA
    ? 'critical' : best.eta <= NEAR_ETA ? 'near' : 'far';
  return { ...best, severity };
}

function newestConfirmedRed(player, projectiles) {
  let newest = null;
  for (const projectile of projectiles || []) {
    if (projectile.kind !== ITEM.RED_SHELL
      || projectile.ownerIndex !== player.index
      || projectile.straight
      || projectile.targetIndex < 0) continue;
    if (!newest || finite(projectile.age, Infinity) < finite(newest.age, Infinity)) newest = projectile;
  }
  return newest;
}

/** Pure state derivation used by DOM presentation and tests. */
export function deriveItemAimState(player, race, { lookBack = false } = {}) {
  const none = { mode: 'none', threat: null };
  if (!activeRace(player, race)) return none;
  const karts = race.karts || [];
  const projectiles = race.items?.projectiles || [];
  const threat = selectIncomingThreat(player, projectiles);
  const confirmed = newestConfirmedRed(player, projectiles);
  if (confirmed) {
    const target = findKartByIndex(karts, confirmed.targetIndex);
    if (target && !target.finished) {
      return {
        mode: 'target', phase: 'confirmed', item: ITEM.RED_SHELL,
        target, targetIndex: target.index, projectile: confirmed, threat,
      };
    }
  }

  if (player.rouletteTimer > 0 || player.item === ITEM.NONE || player.incapacitated) {
    return { ...none, threat };
  }
  if (player.item === ITEM.GREEN_SHELL || (player.item === ITEM.RED_SHELL && lookBack)) {
    return {
      mode: 'straight', item: player.item, back: lookBack,
      points: buildStraightAimGuide(player, race.track, { back: lookBack }), threat,
    };
  }
  if (player.item === ITEM.RED_SHELL) {
    const target = findRedShellTarget(player, karts);
    return target
      ? { mode: 'target', phase: 'candidate', item: ITEM.RED_SHELL, target, targetIndex: target.index, threat }
      : { mode: 'status', status: 'noTarget', item: ITEM.RED_SHELL, threat };
  }
  if (player.item === ITEM.BOMB) {
    const trajectory = predictBombTrajectory(player, race.track, { back: lookBack });
    return trajectory
      ? { mode: trajectory.mode, item: ITEM.BOMB, ...trajectory, threat }
      : { ...none, threat };
  }
  if (player.item === ITEM.BLUE_SHELL) {
    const target = findRaceLeader(karts);
    if (!target) return { mode: 'status', status: 'noTarget', item: ITEM.BLUE_SHELL, threat };
    return {
      mode: target.index === player.index ? 'status' : 'target',
      status: target.index === player.index ? 'selfTarget' : undefined,
      phase: 'leader', item: ITEM.BLUE_SHELL,
      target, targetIndex: target.index, threat,
    };
  }
  return { ...none, threat };
}

export class ItemAimAssist {
  constructor(root, { copy = null, onCue = null } = {}) {
    this.root = root;
    this.copy = copy;
    this.onCue = typeof onCue === 'function' ? onCue : () => {};
    root.insertAdjacentHTML('beforeend', `
      <div class="hud-item-aim">
        <svg class="hud-item-aim-path" preserveAspectRatio="none" aria-hidden="true">
          <polyline class="hud-item-aim-line"></polyline>
        </svg>
        <div class="hud-item-target" aria-hidden="true" hidden><span class="hud-item-target-label"></span></div>
        <div class="hud-item-edge" aria-hidden="true" hidden><span class="hud-item-edge-arrow">➤</span><span class="hud-item-edge-label"></span></div>
        <div class="hud-item-impact" aria-hidden="true" hidden><span class="hud-item-impact-label"></span></div>
        <div class="hud-item-aim-status" aria-hidden="true" hidden></div>
        <div class="hud-item-incoming" role="status" aria-live="assertive" aria-atomic="true" hidden>
          <span class="hud-item-incoming-icon">⚠</span>
          <span class="hud-item-incoming-label"></span>
        </div>
      </div>
    `);
    const q = (selector) => root.querySelector(selector);
    this.layer = q('.hud-item-aim');
    this.svg = q('.hud-item-aim-path');
    this.line = q('.hud-item-aim-line');
    this.target = q('.hud-item-target');
    this.targetLabel = q('.hud-item-target-label');
    this.edge = q('.hud-item-edge');
    this.edgeArrow = q('.hud-item-edge-arrow');
    this.edgeLabel = q('.hud-item-edge-label');
    this.impact = q('.hud-item-impact');
    this.impactLabel = q('.hud-item-impact-label');
    this.status = q('.hud-item-aim-status');
    this.incoming = q('.hud-item-incoming');
    this.incomingLabel = q('.hud-item-incoming-label');
    this._world = new THREE.Vector3();
    this._ndc = new THREE.Vector3();
    this._cameraSpace = new THREE.Vector3();
    this.reset();
  }

  setCopy(copy) {
    this.copy = copy;
  }

  reset() {
    this._candidateIndex = -1;
    this._candidateTime = 0;
    this._candidateCued = false;
    this._threatId = null;
    this._threatSeverity = null;
    this._warningTimer = 0;
    if (!this.layer) return;
    this.line.setAttribute('points', '');
    this.line.removeAttribute('data-item');
    this.target.hidden = true;
    this.edge.hidden = true;
    this.impact.hidden = true;
    this.status.hidden = true;
    this.incoming.hidden = true;
    this.incomingLabel.textContent = '';
  }

  update(player, race, dt, { camera = null, lookBack = false } = {}) {
    const state = deriveItemAimState(player, race, { lookBack });
    const width = Math.max(1, this.root.clientWidth || globalThis.innerWidth || 1);
    const height = Math.max(1, this.root.clientHeight || globalThis.innerHeight || 1);
    this.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    this._renderAim(state, camera, width, height);
    this._renderThreat(state.threat, camera, width, height);
    this._updateCues(state, Math.max(0, finite(dt)));
    return state;
  }

  _labels() {
    return this.copy?.hud?.itemAim || {};
  }

  _renderAim(state, camera, width, height) {
    this.line.setAttribute('points', '');
    this.line.removeAttribute('data-item');
    this.target.hidden = true;
    this.edge.hidden = true;
    this.impact.hidden = true;
    this.status.hidden = true;
    const labels = this._labels();

    if (state.mode === 'target' && state.target && camera) {
      const label = state.phase === 'confirmed' ? labels.locked
        : state.phase === 'leader' ? labels.leaderTarget : labels.canLock;
      this._placeTracked(state.target, label, state.item, state.phase, camera, width, height);
      return;
    }
    if (state.mode === 'straight' && camera) {
      this._renderPath(state.points, state.item, camera, width, height);
      this._showStatus(labels.straightShot, state.item);
      return;
    }
    if ((state.mode === 'lob' || state.mode === 'plant') && camera) {
      if (state.mode === 'lob') this._renderPath(state.points, ITEM.BOMB, camera, width, height);
      const label = state.mode === 'plant' ? labels.plantBehind : labels.bombLanding;
      this._placeImpact(state.impact, label, state.mode, camera, width, height);
      return;
    }
    if (state.mode === 'status') {
      this._showStatus(labels[state.status] || '', state.item);
    }
  }

  _project(point, camera, width, height, yOffset = 0) {
    this._world.set(finite(point.x), finite(point.y) + yOffset, finite(point.z));
    this._cameraSpace.copy(this._world).applyMatrix4(camera.matrixWorldInverse);
    this._ndc.copy(this._world).project(camera);
    const behind = this._cameraSpace.z >= -camera.near;
    const x = (this._ndc.x * 0.5 + 0.5) * width;
    const y = (-this._ndc.y * 0.5 + 0.5) * height;
    const visible = !behind && this._ndc.z >= -1 && this._ndc.z <= 1
      && this._ndc.x >= -0.92 && this._ndc.x <= 0.92
      && this._ndc.y >= -0.86 && this._ndc.y <= 0.86;
    return { x, y, visible, behind, ndcX: this._ndc.x, ndcY: this._ndc.y };
  }

  _placeTracked(target, label, item, phase, camera, width, height) {
    const projected = this._project(target, camera, width, height, TARGET_HEIGHT);
    if (projected.visible) {
      this.target.hidden = false;
      this.target.style.left = `${projected.x}px`;
      this.target.style.top = `${projected.y}px`;
      this.target.dataset.item = item;
      this.target.dataset.phase = phase;
      this.targetLabel.textContent = label || '';
      return;
    }
    this._placeEdge(projected, label, item, phase, width, height);
  }

  _placeEdge(projected, label, item, phase, width, height) {
    let dx = finite(projected.ndcX);
    let dy = -finite(projected.ndcY);
    if (projected.behind) { dx = -dx; dy = -dy; }
    if (Math.abs(dx) + Math.abs(dy) < 0.001) dy = -1;
    const halfW = width * 0.39;
    const halfH = height * 0.34;
    const scale = Math.min(halfW / Math.max(Math.abs(dx), 0.001), halfH / Math.max(Math.abs(dy), 0.001));
    const x = width * 0.5 + dx * scale;
    const y = height * 0.5 + dy * scale;
    this.edge.hidden = false;
    this.edge.style.left = `${x}px`;
    this.edge.style.top = `${y}px`;
    this.edge.dataset.item = item;
    this.edge.dataset.phase = phase;
    this.edgeArrow.style.transform = `rotate(${Math.atan2(dy, dx) * 180 / Math.PI}deg)`;
    this.edgeLabel.textContent = label || '';
  }

  _renderPath(points, item, camera, width, height) {
    const screenPoints = [];
    for (const point of points || []) {
      const projected = this._project(point, camera, width, height);
      if (!projected.behind && Number.isFinite(projected.x) && Number.isFinite(projected.y)) {
        screenPoints.push(`${projected.x.toFixed(1)},${projected.y.toFixed(1)}`);
      }
    }
    if (screenPoints.length >= 2) {
      this.line.dataset.item = item;
      this.line.setAttribute('points', screenPoints.join(' '));
    }
  }

  _placeImpact(point, label, mode, camera, width, height) {
    if (!point) return;
    const projected = this._project(point, camera, width, height, 0.12);
    if (!projected.visible) return;
    this.impact.hidden = false;
    this.impact.style.left = `${projected.x}px`;
    this.impact.style.top = `${projected.y}px`;
    this.impact.dataset.mode = mode;
    this.impactLabel.textContent = label || '';
  }

  _showStatus(label, item) {
    if (!label) return;
    this.status.hidden = false;
    this.status.textContent = label;
    this.status.dataset.item = item || ITEM.NONE;
  }

  _renderThreat(threat, camera, width, height) {
    if (!threat) {
      this.incoming.hidden = true;
      this.incomingLabel.textContent = '';
      return;
    }
    const labels = this._labels();
    this.incoming.hidden = false;
    this.incoming.dataset.kind = threat.projectile.kind;
    this.incoming.dataset.severity = threat.severity;
    this.incomingLabel.textContent = threat.projectile.kind === ITEM.BLUE_SHELL
      ? labels.incomingBlue : labels.incomingRed;
    if (camera) {
      const projected = this._project(threat.projectile, camera, width, height);
      let dx = finite(projected.ndcX);
      let dy = -finite(projected.ndcY);
      if (projected.behind) { dx = -dx; dy = -dy; }
      if (Math.abs(dx) + Math.abs(dy) < 0.001) dy = 1;
      this.incoming.style.setProperty('--incoming-angle', `${Math.atan2(dy, dx) * 180 / Math.PI}deg`);
    }
  }

  _updateCues(state, dt) {
    if (state.mode === 'target' && state.phase === 'candidate') {
      if (state.targetIndex !== this._candidateIndex) {
        this._candidateIndex = state.targetIndex;
        this._candidateTime = 0;
        this._candidateCued = false;
      } else if (!this._candidateCued) {
        this._candidateTime += dt;
        if (this._candidateTime >= CANDIDATE_CUE_DELAY) {
          this._candidateCued = true;
          this.onCue({ type: 'target-acquired' });
        }
      }
    } else {
      this._candidateIndex = -1;
      this._candidateTime = 0;
      this._candidateCued = false;
    }

    const threat = state.threat;
    if (!threat) {
      this._threatId = null;
      this._threatSeverity = null;
      this._warningTimer = 0;
      return;
    }
    const threatId = `${threat.projectile.kind}:${threat.projectile.id}`;
    if (threatId !== this._threatId) {
      this._threatId = threatId;
      this._threatSeverity = threat.severity;
      this._warningTimer = threat.severity === 'critical'
        ? CRITICAL_WARNING_INTERVAL : NEAR_WARNING_INTERVAL;
      this.onCue({ type: 'incoming', kind: threat.projectile.kind, severity: threat.severity });
      return;
    }
    if (threat.severity !== this._threatSeverity) {
      this._threatSeverity = threat.severity;
      this._warningTimer = threat.severity === 'critical'
        ? CRITICAL_WARNING_INTERVAL : NEAR_WARNING_INTERVAL;
      this.onCue({ type: 'incoming', kind: threat.projectile.kind, severity: threat.severity });
      return;
    }
    if (threat.severity === 'far') return;
    this._warningTimer -= dt;
    if (this._warningTimer <= 0) {
      this.onCue({ type: 'incoming', kind: threat.projectile.kind, severity: threat.severity });
      this._warningTimer = threat.severity === 'critical'
        ? CRITICAL_WARNING_INTERVAL : NEAR_WARNING_INTERVAL;
    }
  }
}
