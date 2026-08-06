// In-race HUD: item slot, lap/position readouts, lap timers, speed, the
// announcer layer (countdown / banners / wrong-way), and the minimap canvas.
//
// Presentation-only — reads kart/race state every frame but never mutates it.
// Every DOM write is guarded by a cached last-value so a frame where nothing
// changed touches zero layout. The minimap track image is rendered once per
// track onto an offscreen canvas; the per-frame cost is one blit plus dots.
//
// No DOM access at module import time (Node syntax-check imports this file).

import { ITEM_INFO, RACE, RACE_STATE } from '../core/constants.js';
import {
  formatCopy,
  formatOrdinal,
  formatOrdinalParts,
  getUiCopy,
  sanitizeLanguage,
} from './copy.js';

/** Sim speed (units/s) → displayed km/h. Pure flavor for the readout. */
const SPEED_KMH = 5.4;
/** Padding inside the minimap canvas, in CSS pixels. */
const MAP_PAD = 16;

/** Pure status mapping shared by the HUD and its contract tests. */
export function standingsStatus(kart, raceState, language) {
  const labels = getUiCopy(language).hud.statuses;
  const presenceState = kart?.presenceState
    || (kart?.connected === false ? 'reconnecting' : 'connected');
  let key = 'racing';
  if (presenceState === 'left') key = 'left';
  else if (presenceState === 'disconnected') key = 'disconnected';
  else if (presenceState === 'reconnecting') key = 'reconnecting';
  else if (kart?.finished) key = 'finished';
  else if (kart?.controllerKind === 'takeover-ai') key = 'takeover';
  else if (kart?.controllerKind === 'ai') key = 'ai';
  else if (raceState === RACE_STATE.COUNTDOWN) key = 'ready';
  return { key, label: labels[key] };
}

/** Seconds left after the first finisher before the race resolves globally. */
export function postRaceSecondsRemaining(race) {
  if (!race || race.state !== RACE_STATE.RACING) return null;
  const racers = Array.isArray(race.karts)
    ? race.karts
    : (Array.isArray(race.standings) ? race.standings : []);
  let firstFinishTime = Infinity;
  for (const racer of racers) {
    if (!racer?.finished || !Number.isFinite(racer.finishTime)) continue;
    firstFinishTime = Math.min(firstFinishTime, racer.finishTime);
  }
  if (!Number.isFinite(firstFinishTime)) return null;

  const elapsed = Math.max(firstFinishTime, Number(race.elapsed) || 0);
  const remaining = RACE.postRaceTimeout - (elapsed - firstFinishTime);
  return Math.ceil(Math.max(0, remaining));
}

const cssColor = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0');

function fmtClock(t) {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}

/** Restart a CSS animation class from frame zero. */
function repop(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth; // style flush so the same class re-triggers
  el.classList.add(cls);
}

export class Hud {
  /**
   * @param {HTMLElement} hudRoot #hud container (already holds #minimap)
   * @param {HTMLCanvasElement} minimapCanvas
   */
  constructor(hudRoot, minimapCanvas, options = {}) {
    this.root = hudRoot;
    this.canvas = minimapCanvas;
    this.language = sanitizeLanguage(options.language);
    this.copy = getUiCopy(this.language);

    hudRoot.insertAdjacentHTML('beforeend', `
      <div class="hud-slot">
        <div class="hud-slot-frame">
          <span class="hud-item-glyph"></span>
          <span class="hud-item-count" hidden></span>
        </div>
      </div>
      <div class="hud-race-info">
        <div class="hud-rank" data-rank="n">
          <span class="hud-rank-prefix"></span><span class="hud-rank-num"></span><span class="hud-rank-suffix"></span>
        </div>
        <div class="hud-lap">LAP <span class="hud-lap-now">1</span><span class="hud-lap-sep">/</span><span class="hud-lap-total">3</span></div>
      </div>
      <div class="hud-times">
        <div class="hud-time-row"><span class="hud-time-label">TIME</span><span class="hud-time-val">0:00.00</span></div>
        <div class="hud-time-row hud-best"><span class="hud-time-label">BEST</span><span class="hud-best-val">—</span></div>
      </div>
      <div class="hud-speed"><span class="hud-speed-val">0</span><span class="hud-speed-unit">km/h</span></div>
      <div class="hud-announcer">
        <div class="hud-loading" role="status" aria-live="polite" hidden>
          <span class="hud-loading-stage"></span>
          <span class="hud-loading-detail"></span>
        </div>
        <div class="hud-banner" hidden>
          <span class="hud-banner-primary"></span>
          <span class="hud-banner-secondary" hidden></span>
        </div>
        <div class="hud-countdown" hidden></div>
        <div class="hud-wrongway" hidden>WRONG WAY ⚠</div>
      </div>
      <section class="hud-standings" aria-hidden="true" hidden>
        <div class="hud-standings-title">LIVE STANDINGS</div>
        <div class="hud-standings-head" aria-hidden="true">
          <span>POS</span><span>RACER</span><span>LAP</span><span>STATUS</span>
        </div>
        <div class="hud-standings-body"></div>
        <div class="hud-standings-hint">HOLD TAB</div>
      </section>
    `);

    const q = (sel) => hudRoot.querySelector(sel);
    this._slot = q('.hud-slot-frame');
    this._glyph = q('.hud-item-glyph');
    this._count = q('.hud-item-count');
    this._rankEl = q('.hud-rank');
    this._rankPrefix = q('.hud-rank-prefix');
    this._rankNum = q('.hud-rank-num');
    this._rankSuf = q('.hud-rank-suffix');
    this._lapNow = q('.hud-lap-now');
    this._lapTotal = q('.hud-lap-total');
    this._timeVal = q('.hud-time-val');
    this._bestVal = q('.hud-best-val');
    this._speedVal = q('.hud-speed-val');
    this._loading = q('.hud-loading');
    this._loadingStage = q('.hud-loading-stage');
    this._loadingDetail = q('.hud-loading-detail');
    this._banner = q('.hud-banner');
    this._bannerPrimary = q('.hud-banner-primary');
    this._bannerSecondary = q('.hud-banner-secondary');
    this._cd = q('.hud-countdown');
    this._wrong = q('.hud-wrongway');
    this._standings = q('.hud-standings');
    this._standingsBody = q('.hud-standings-body');
    this._standingRows = [];
    this._standingsVisible = false;
    this._applyStaticCopy();

    // --- Minimap: HiDPI backing store; CSS controls the display size. ------
    const size = minimapCanvas.width || 220;
    const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    this._size = size;
    this._dpr = dpr;
    minimapCanvas.width = minimapCanvas.height = Math.round(size * dpr);
    this._ctx = minimapCanvas.getContext('2d');
    if (this._ctx) this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._map = document.createElement('canvas');
    this._map.width = this._map.height = Math.round(size * dpr);
    this._mapTrack = null;
    this._k = 1; this._minX = 0; this._minZ = 0; this._offX = 0; this._offY = 0;

    this._time = 0;
    this._raceRef = null;
    this._cdTimer = 0;
    this._bannerTimer = 0;
    this._colorCache = Object.create(null);
    this._resetState();
  }

  setLanguage(language) {
    const next = sanitizeLanguage(language);
    if (next === this.language) return false;
    this.language = next;
    this.copy = getUiCopy(next);
    this._applyStaticCopy();
    for (const row of this._standingRows) {
      row.you.textContent = this.copy.common.you;
      if (row.cache.status) row.status.textContent = this.copy.hud.statuses[row.cache.status] || '';
    }
    if (this._c.rank > 0) this._setRankCopy(this._c.rank);
    if (this._cdShown === 'go') this._cd.textContent = this.copy.hud.go;
    if (this._banner.className.includes('final-lap')) this._bannerPrimary.textContent = this.copy.hud.finalLap;
    if (this._banner.className.includes('finish') && this._c.rank > 0) {
      this._bannerPrimary.textContent = formatCopy(this.copy.hud.finished, {
        place: formatOrdinal(this._c.rank, this.language),
      });
      this._bannerSecondary.textContent = Number.isFinite(this._postRaceSecondsShown)
        ? formatCopy(this.copy.hud.waitingFinishCountdown, {
          seconds: this._postRaceSecondsShown,
        })
        : this.copy.hud.waitingFinish;
    }
    if (this._banner.className.includes('race-ending')
        && Number.isFinite(this._postRaceSecondsShown)) {
      this._bannerPrimary.textContent = formatCopy(this.copy.hud.raceEnding, {
        seconds: this._postRaceSecondsShown,
      });
    }
    return true;
  }

  _applyStaticCopy() {
    const set = (selector, value) => {
      const node = this.root.querySelector(selector);
      if (node) node.textContent = value;
    };
    const currentLap = this._lapNow?.textContent || '1';
    const totalLaps = this._lapTotal?.textContent || '3';
    set('.hud-lap', '');
    const lap = this.root.querySelector('.hud-lap');
    if (lap) lap.innerHTML = `${this.copy.hud.lap} <span class="hud-lap-now">${currentLap}</span><span class="hud-lap-sep">/</span><span class="hud-lap-total">${totalLaps}</span>`;
    this._lapNow = this.root.querySelector('.hud-lap-now');
    this._lapTotal = this.root.querySelector('.hud-lap-total');
    set('.hud-time-row:not(.hud-best) .hud-time-label', this.copy.hud.time);
    set('.hud-best .hud-time-label', this.copy.hud.best);
    set('.hud-wrongway', this.copy.hud.wrongWay);
    set('.hud-standings-title', this.copy.hud.liveStandings);
    const heads = this.root.querySelectorAll('.hud-standings-head > span');
    heads.forEach((node, index) => { node.textContent = this.copy.hud.standingsHead[index] || ''; });
    set('.hud-standings-hint', this.copy.hud.holdTab);
  }

  _setRankCopy(rank) {
    const parts = formatOrdinalParts(rank, this.language);
    this._rankPrefix.textContent = parts.prefix;
    this._rankNum.textContent = parts.number;
    this._rankSuf.textContent = parts.suffix;
  }

  /** Clear all cached values + latches; next update() repaints everything. */
  _resetState() {
    this._c = {
      glyph: '\u0000', rolling: null, uses: -1,
      lapNow: -1, lapTotal: -1, rank: -1,
      speed: -1, curCs: -1, best: -1, wrong: null,
    };
    this._finalLapShown = false;
    this._finishShown = false;
    this._postRaceSecondsShown = null;
    this._lastElapsed = 0;
    this._cdShown = null;
    clearTimeout(this._cdTimer);
    clearTimeout(this._bannerTimer);
    this._cd.hidden = true;
    this._banner.hidden = true;
    this._wrong.hidden = true;
    this._setStandingsVisible(false);
  }

  showRace() {
    this.root.hidden = false;
    this.hideLoading();
    this._resetState();
  }

  hide() {
    this.hideLoading();
    this.root.hidden = true;
  }

  showLoading(stage, detail = '') {
    this._loadingStage.textContent = String(stage || this.copy.hud.loadingRace);
    this._loadingDetail.textContent = String(detail || '');
    this._loadingDetail.hidden = !detail;
    this._loading.hidden = false;
  }

  hideLoading() {
    this._loading.hidden = true;
  }

  /**
   * Per-frame refresh. Cheap: every write is guarded by a cached last-value.
   * @param {import('../game/kart.js').Kart} kart the player kart
   * @param {object} race RaceDirector (read-only)
   * @param {number} dt frame delta seconds (drives the minimap pulse)
   * @param {{showStandings?:boolean}} [presentation]
   */
  update(kart, race, dt, { showStandings = false } = {}) {
    if (!kart || !race) return;
    this._time += dt || 0;

    // Restart detection: a new director, or elapsed time rewound.
    if (race !== this._raceRef || (race.elapsed || 0) + 0.5 < this._lastElapsed) {
      this._raceRef = race;
      this._resetState();
    }
    this._lastElapsed = race.elapsed || 0;

    this._setStandingsVisible(showStandings);
    if (this._standingsVisible) this._updateStandings(race);

    const c = this._c;
    const track = race.track;

    // --- Item slot ----------------------------------------------------------
    const rolling = kart.rouletteTimer > 0;
    const info = rolling ? ITEM_INFO[kart.rouletteFace] : kart.itemInfo;
    const glyph = info ? info.glyph : '';
    if (rolling !== c.rolling) {
      c.rolling = rolling;
      this._slot.classList.toggle('is-rolling', rolling);
    }
    if (glyph !== c.glyph) {
      c.glyph = glyph;
      this._glyph.textContent = glyph;
      this._slot.classList.toggle('has-item', glyph !== '');
      if (!rolling && glyph) repop(this._glyph, 'pop');
    }
    const uses = !rolling && kart.itemUses > 1 ? kart.itemUses : 0;
    if (uses !== c.uses) {
      c.uses = uses;
      this._count.hidden = uses === 0;
      if (uses) this._count.textContent = '×' + uses;
    }

    // --- Lap / position -----------------------------------------------------
    // race.js writes kart.lap already 1-based (current lap, clamped to laps).
    const lapTotal = (track && track.laps) || 3;
    const lapNow = Math.max(1, Math.min(kart.lap || 1, lapTotal));
    if (lapTotal !== c.lapTotal) { c.lapTotal = lapTotal; this._lapTotal.textContent = lapTotal; }
    if (lapNow !== c.lapNow) { c.lapNow = lapNow; this._lapNow.textContent = lapNow; }

    const rank = kart.rank | 0;
    if (rank !== c.rank) {
      c.rank = rank;
      this._setRankCopy(rank);
      this._rankEl.setAttribute('data-rank', rank >= 1 && rank <= 3 ? String(rank) : 'n');
      repop(this._rankEl, 'rank-pop');
    }

    // --- Timers (freeze the running clock once finished) ---------------------
    if (!kart.finished) {
      const cur = Math.max(0, (race.elapsed || 0) - (kart.currentLapStart || 0));
      const cs = Math.floor(cur * 100);
      if (cs !== c.curCs) { c.curCs = cs; this._timeVal.textContent = fmtClock(cur); }
    }
    const bestKey = Number.isFinite(kart.bestLap) ? Math.floor(kart.bestLap * 100) : 0;
    if (bestKey !== c.best) {
      c.best = bestKey;
      this._bestVal.textContent = bestKey ? fmtClock(kart.bestLap) : '—';
    }

    // --- Speed readout --------------------------------------------------------
    const spd = Math.round(Math.abs(kart.speed || 0) * SPEED_KMH);
    if (spd !== c.speed) { c.speed = spd; this._speedVal.textContent = spd; }

    // --- Announcer (state-driven; the public API below stays idempotent) -----
    this.wrongWay(!!kart.wrongWay && !kart.finished && race.state === RACE_STATE.RACING);

    if (!this._finalLapShown && kart.lap > 0 && lapNow === lapTotal
        && !kart.finished && race.state === RACE_STATE.RACING) {
      this._finalLapShown = true;
      this.banner(this.copy.hud.finalLap, 2600, 'final-lap');
    }
    const postRaceSeconds = postRaceSecondsRemaining(race);
    if (!this._finishShown && kart.finished) {
      this._finishShown = true;
      this.finish(rank || kart.rank, postRaceSeconds);
    } else if (kart.finished && postRaceSeconds !== null
        && (postRaceSeconds !== this._postRaceSecondsShown
          || !this._banner.className.includes('finish'))) {
      this.finish(rank || kart.rank, postRaceSeconds);
    } else if (!kart.finished && postRaceSeconds !== null
        && (postRaceSeconds !== this._postRaceSecondsShown
          || !this._banner.className.includes('race-ending'))) {
      this.raceEnding(postRaceSeconds);
    }
    // If countdown numbers were shown but GO never arrived, fire it when the
    // director flips to racing so the layer always cleans itself up.
    if (this._cdShown != null && this._cdShown !== 'go' && race.state === RACE_STATE.RACING) {
      this.countdown('go');
    }

    this._drawMinimap(kart, race, track);
  }

  _setStandingsVisible(visible) {
    const next = Boolean(visible);
    if (next === this._standingsVisible) return;
    this._standingsVisible = next;
    this._standings.hidden = !next;
    this._standings.setAttribute('aria-hidden', String(!next));
  }

  _ensureStandingRows(count) {
    while (this._standingRows.length < count) {
      const row = document.createElement('div');
      row.className = 'hud-standing-row';
      row.innerHTML = `
        <span class="hud-standing-pos"></span>
        <span class="hud-standing-racer"><span class="hud-standing-name"></span><span class="hud-standing-you" hidden>${this.copy.common.you}</span></span>
        <span class="hud-standing-lap"></span>
        <span class="hud-standing-status"></span>
      `;
      this._standingsBody.appendChild(row);
      this._standingRows.push({
        root: row,
        pos: row.querySelector('.hud-standing-pos'),
        name: row.querySelector('.hud-standing-name'),
        you: row.querySelector('.hud-standing-you'),
        lap: row.querySelector('.hud-standing-lap'),
        status: row.querySelector('.hud-standing-status'),
        cache: { pos: '', name: '', lap: '', status: '', local: null },
      });
    }
  }

  _updateStandings(race) {
    const currentStandings = race.standings;
    const standings = Array.isArray(currentStandings) ? currentStandings : [];
    this._ensureStandingRows(standings.length);
    const lapTotal = Math.max(1, Number(race.laps || race.track?.laps) || 3);

    for (let index = 0; index < this._standingRows.length; index++) {
      const row = this._standingRows[index];
      const racer = standings[index];
      row.root.hidden = !racer;
      if (!racer) continue;

      const place = Math.max(1, Number(racer.rank) || index + 1);
      const pos = String(place).padStart(2, '0');
      const name = String(racer.name || racer.displayName || formatCopy(this.copy.common.racerFallback, { rank: place }));
      const lap = `${Math.max(1, Math.min(Number(racer.lap) || 1, lapTotal))}/${lapTotal}`;
      const state = standingsStatus(racer, race.state, this.language);
      const local = Boolean(racer.isPlayer);
      const cache = row.cache;

      if (pos !== cache.pos) { cache.pos = pos; row.pos.textContent = pos; }
      if (name !== cache.name) { cache.name = name; row.name.textContent = name; }
      if (lap !== cache.lap) { cache.lap = lap; row.lap.textContent = lap; }
      if (state.key !== cache.status) {
        cache.status = state.key;
        row.status.textContent = state.label;
        row.status.dataset.state = state.key;
      }
      if (local !== cache.local) {
        cache.local = local;
        row.root.classList.toggle('is-local', local);
        row.you.hidden = !local;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Announcer API (idempotent — calling with the same value twice is free)
  // ---------------------------------------------------------------------------

  /** @param {number|'go'} v countdown face: 3, 2, 1 or 'go' */
  countdown(v) {
    const key = (v === 'go' || v === 'GO' || v === 0) ? 'go' : v;
    if (key === this._cdShown) return;
    this._cdShown = key;
    const el = this._cd;
    el.hidden = false;
    el.textContent = key === 'go' ? this.copy.hud.go : String(key);
    el.classList.toggle('is-go', key === 'go');
    repop(el, 'cd-pop');
    clearTimeout(this._cdTimer);
    if (key === 'go') {
      this._cdTimer = setTimeout(() => { el.hidden = true; }, 850);
    }
  }

  /**
   * Show a center banner for `ms` milliseconds.
   * @param {string} text
   * @param {number} [ms]
   * @param {string} [kind] extra CSS class ('final-lap' | 'finish' | '')
   */
  banner(text, ms = 2400, kind = '') {
    const el = this._banner;
    if (!el.hidden && this._bannerPrimary.textContent === text
      && this._bannerSecondary.hidden) return;
    el.className = 'hud-banner' + (kind ? ' ' + kind : '');
    this._bannerPrimary.textContent = text;
    this._bannerSecondary.textContent = '';
    this._bannerSecondary.hidden = true;
    el.hidden = false;
    repop(el, 'banner-in');
    clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  /** Keep the finishing place and wait hint visible until the results screen. */
  finish(rank, secondsRemaining = null) {
    const copy = this.copy || getUiCopy(this.language);
    const el = this._banner;
    const alreadyVisible = !el.hidden && el.className.includes('finish');
    const seconds = Number.isFinite(secondsRemaining)
      ? Math.max(0, Math.ceil(secondsRemaining))
      : null;
    this._postRaceSecondsShown = seconds;
    el.className = 'hud-banner finish';
    this._bannerPrimary.textContent = formatCopy(copy.hud.finished, {
      place: formatOrdinal(rank, this.language),
    });
    this._bannerSecondary.textContent = seconds === null
      ? copy.hud.waitingFinish
      : formatCopy(copy.hud.waitingFinishCountdown, { seconds });
    this._bannerSecondary.hidden = false;
    el.hidden = false;
    if (!alreadyVisible) repop(el, 'banner-in');
    clearTimeout(this._bannerTimer);
    this._bannerTimer = null;
  }

  /** Warn unfinished racers how long remains before the race resolves. */
  raceEnding(secondsRemaining) {
    const copy = this.copy || getUiCopy(this.language);
    const el = this._banner;
    const alreadyVisible = !el.hidden && el.className.includes('race-ending');
    const seconds = Math.max(0, Math.ceil(Number(secondsRemaining) || 0));
    this._postRaceSecondsShown = seconds;
    el.className = 'hud-banner race-ending';
    this._bannerPrimary.textContent = formatCopy(copy.hud.raceEnding, { seconds });
    this._bannerSecondary.textContent = '';
    this._bannerSecondary.hidden = true;
    el.hidden = false;
    if (!alreadyVisible) repop(el, 'banner-in');
    clearTimeout(this._bannerTimer);
    this._bannerTimer = null;
  }

  /** @param {boolean} on */
  wrongWay(on) {
    if (on === this._c.wrong) return;
    this._c.wrong = on;
    this._wrong.hidden = !on;
  }

  // ---------------------------------------------------------------------------
  // Minimap
  // ---------------------------------------------------------------------------

  _mx(x) { return (x - this._minX) * this._k + this._offX; }
  /** North-up, +z points up the screen. */
  _my(z) { return this._size - ((z - this._minZ) * this._k + this._offY); }

  /** Pre-render the track ribbon once per Track instance. */
  _ensureMap(track) {
    if (!track || track === this._mapTrack) return;
    this._mapTrack = track;
    const sp = track.spline;
    const S = this._size;

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < sp.count; i++) {
      const x = sp.px[i], z = sp.pz[i];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const spanX = Math.max(1e-6, maxX - minX);
    const spanZ = Math.max(1e-6, maxZ - minZ);
    const k = Math.min((S - MAP_PAD * 2) / spanX, (S - MAP_PAD * 2) / spanZ);
    this._k = k;
    this._minX = minX;
    this._minZ = minZ;
    this._offX = (S - spanX * k) / 2;
    this._offY = (S - spanZ * k) / 2;

    const g = this._map.getContext('2d');
    if (!g) return;
    g.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    g.clearRect(0, 0, S, S);

    // Closed centreline path, decimated — this runs once so precision wins.
    const step = Math.max(1, Math.floor(sp.count / 720));
    g.beginPath();
    g.moveTo(this._mx(sp.px[0]), this._my(sp.pz[0]));
    for (let i = step; i < sp.count; i += step) {
      g.lineTo(this._mx(sp.px[i]), this._my(sp.pz[i]));
    }
    g.closePath();
    g.lineJoin = 'round';
    g.lineCap = 'round';

    const theme = track.theme || {};
    const roadW = Math.max(5, Math.min(11, (track.baseHalfWidth || 10) * 2 * k));
    g.strokeStyle = 'rgba(255,255,255,0.88)';
    g.lineWidth = roadW + 3.5;
    g.stroke();
    g.strokeStyle = theme.road != null ? cssColor(theme.road) : '#3a3f4a';
    g.lineWidth = roadW;
    g.stroke();

    // Vertical structure cues: tunnels read as dark/dashed, bridges as bright
    // solid spans so a 2D minimap still explains the authored crossover.
    const drawStructureArc = (structure, strokeStyle, width, dash = []) => {
      const start = Math.floor((structure.startFrac ?? 0) * sp.count);
      const end = Math.ceil((structure.endFrac ?? 0) * sp.count);
      if (end <= start) return;
      g.beginPath();
      g.moveTo(this._mx(sp.px[start % sp.count]), this._my(sp.pz[start % sp.count]));
      for (let i = start + step; i <= end; i += step) {
        const index = i % sp.count;
        g.lineTo(this._mx(sp.px[index]), this._my(sp.pz[index]));
      }
      const finalIndex = end % sp.count;
      g.lineTo(this._mx(sp.px[finalIndex]), this._my(sp.pz[finalIndex]));
      g.setLineDash(dash);
      g.strokeStyle = strokeStyle;
      g.lineWidth = width;
      g.stroke();
      g.setLineDash([]);
    };
    for (const structure of track.structures || []) {
      if (structure.kind === 'tunnel') {
        drawStructureArc(structure, 'rgba(8,24,42,0.9)', Math.max(2.5, roadW * 0.62), [4, 3]);
      } else if (structure.kind === 'bridge') {
        drawStructureArc(structure, 'rgba(5,22,38,0.9)', roadW + 2.2);
        drawStructureArc(structure, '#9befff', Math.max(3.5, roadW * 0.72));
      }
    }

    // Start/finish notch across the road at s = 0.
    const w = (track.baseHalfWidth || 10) + 1.5;
    g.beginPath();
    g.moveTo(this._mx(sp.px[0] - sp.rx[0] * w), this._my(sp.pz[0] - sp.rz[0] * w));
    g.lineTo(this._mx(sp.px[0] + sp.rx[0] * w), this._my(sp.pz[0] + sp.rz[0] * w));
    g.strokeStyle = '#ffffff';
    g.lineWidth = 3;
    g.stroke();
  }

  _kartColor(k) {
    const key = k.color >>> 0;
    return this._colorCache[key] || (this._colorCache[key] = cssColor(key));
  }

  _drawMinimap(playerKart, race, track) {
    const ctx = this._ctx;
    if (!ctx || !track || !track.spline) return;
    this._ensureMap(track);

    const S = this._size;
    ctx.clearRect(0, 0, S, S);
    ctx.drawImage(this._map, 0, 0, S, S);

    // Active item boxes — tiny amber dots.
    const boxes = track.itemBoxes;
    if (boxes) {
      ctx.fillStyle = '#ffd54a';
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (!b.active) continue;
        ctx.beginPath();
        ctx.arc(this._mx(b.x), this._my(b.z), 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Hazards sitting on the road (bananas, bombs).
    const hazards = race.items && race.items.hazards;
    if (hazards) {
      for (let i = 0; i < hazards.length; i++) {
        const h = hazards[i];
        ctx.fillStyle = h.kind === 'bomb' ? '#ff5544' : '#ffe14d';
        ctx.beginPath();
        ctx.arc(this._mx(h.x), this._my(h.z), 2.1, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Karts — rivals first, player last so it sits on top.
    const karts = race.karts || [];
    for (let i = 0; i < karts.length; i++) {
      const k = karts[i];
      if (k === playerKart) continue;
      ctx.fillStyle = this._kartColor(k);
      ctx.beginPath();
      ctx.arc(this._mx(k.x), this._my(k.z), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    const px = this._mx(playerKart.x);
    const py = this._my(playerKart.z);
    const pr = 3.5 + Math.sin(this._time * 5) * 0.5; // gentle pulse
    ctx.fillStyle = this._kartColor(playerKart);
    ctx.beginPath();
    ctx.arc(px, py, pr, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(px, py, pr + 1.2, 0, Math.PI * 2);
    ctx.stroke();
  }
}
