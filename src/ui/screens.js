// Menu screens: title, character select, track select, difficulty, pause,
// results. DOM-only, built once into the roots provided by index.html.
//
// Navigation is EXTERNALLY driven — main.js feeds `moveFocus`/`confirm` from
// the InputManager's edge-triggered menu state, so keyboard and gamepad share
// one path. Mouse/touch work natively: hover focuses, click confirms.
//
// No DOM access at module import time (Node syntax-check imports this file).

import { CHARACTER_STAT_RANGE, DIFFICULTY } from '../core/constants.js';

const cssColor = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0');

function fmtClock(t) {
  if (!Number.isFinite(t) || t <= 0) return '—';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}

/** el('div', 'card', parent) — tiny builder to keep card assembly readable. */
function el(tag, className, parent, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
}

const STAT_ROWS = [
  ['speed', 'Speed'],
  ['accel', 'Accel'],
  ['handling', 'Turn'],
  ['weight', 'Weight'],
];

/** Written here (not in constants) — pure menu flavor text. */
const DIFFICULTY_FLAVOR = {
  easy: { icon: '🌤️', desc: 'Relaxed rivals, gentle items. A sunny Sunday drive.' },
  normal: { icon: '🏁', desc: 'A proper race. The pack fights back — so should you.' },
  hard: { icon: '🔥', desc: 'Ruthless AI, maximum rubber-band. Bring mushrooms.' },
};

const MEDALS = ['🥇', '🥈', '🥉'];
const ORDINALS = ['0th', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];

/**
 * Normalize a track def's control points into a 100x60 viewBox polygon
 * points string (north-up: +z renders toward the top).
 */
function outlinePoints(points) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  const pad = 6;
  const w = 100 - pad * 2;
  const h = 60 - pad * 2;
  const k = Math.min(w / Math.max(1e-6, maxX - minX), h / Math.max(1e-6, maxZ - minZ));
  const ox = (100 - (maxX - minX) * k) / 2;
  const oy = (60 - (maxZ - minZ) * k) / 2;
  return points
    .map((p) => `${(ox + (p.x - minX) * k).toFixed(1)},${(60 - oy - (p.z - minZ) * k).toFixed(1)}`)
    .join(' ');
}

export class Screens {
  /**
   * @param {object} roots section elements — accepts either short keys
   *   ({title, character, track, difficulty, pause, results}) or the raw
   *   element ids ({'screen-title': …}).
   * @param {{onCharacter:(id:string)=>void, onTrack:(id:string)=>void,
   *          onDifficulty:(key:string)=>void, onStart:()=>void,
   *          onResume:()=>void, onRestart:()=>void, onQuit:()=>void,
   *          onResultsDone:()=>void}} callbacks
   */
  constructor(roots, callbacks) {
    const pick = (...keys) => {
      for (const k of keys) if (roots[k]) return roots[k];
      return null;
    };
    this.roots = {
      title: pick('title', 'screen-title', 'screenTitle'),
      character: pick('character', 'screen-character', 'screenCharacter'),
      track: pick('track', 'screen-track', 'screenTrack'),
      difficulty: pick('difficulty', 'screen-difficulty', 'screenDifficulty'),
      pause: pick('pause', 'screen-pause', 'screenPause'),
      results: pick('results', 'screen-results', 'screenResults'),
    };
    this.callbacks = callbacks || {};

    /** @type {string|null} currently visible primary screen */
    this._screen = null;
    /** Selectable options of the active screen: [{el, value}] */
    this._items = [];
    this._focus = 0;
    this._cols = 1;
    /** Remembered focus per screen so re-entry restores the last choice. */
    this._memory = { difficulty: 1 };
    this._builtCharacters = null;
    this._builtTracks = null;

    this._buildTitle();
    this._buildDifficulty();
    this._buildPause();
    this._buildResultsShell();
  }

  // ---------------------------------------------------------------------------
  // Static screens (built once in the constructor)
  // ---------------------------------------------------------------------------

  _buildTitle() {
    const root = this.roots.title;
    if (!root) return;
    root.innerHTML = `
      <div class="title-wrap">
        <h1 class="logo" aria-label="Turbo Kart">
          <span class="logo-line logo-turbo">TURBO</span>
          <span class="logo-line logo-kart">KART</span>
        </h1>
        <div class="title-start menu-option" data-value="start">Press <kbd>Enter</kbd> / Tap to start</div>
        <footer class="title-help">
          <span>WASD / Arrows drive</span><i>·</i>
          <span>Space drift</span><i>·</i>
          <span>Ctrl item</span><i>·</i>
          <span>Esc pause</span>
        </footer>
      </div>`;
    // The whole title screen is one big start button.
    root.addEventListener('click', () => {
      if (this._screen === 'title') this.confirm();
    });
  }

  _buildDifficulty() {
    const root = this.roots.difficulty;
    if (!root) return;
    root.innerHTML = '<h2 class="screen-heading">DIFFICULTY</h2>';
    const row = el('div', 'card-row diff-row', root);
    for (const key of Object.keys(DIFFICULTY)) {
      const d = DIFFICULTY[key];
      const f = DIFFICULTY_FLAVOR[key] || { icon: '🏁', desc: '' };
      const card = el('button', `card diff-card diff-${key} menu-option`, row);
      card.type = 'button';
      card.dataset.value = key;
      el('div', 'diff-icon', card, f.icon);
      el('div', 'diff-name', card, d.label);
      el('p', 'diff-desc', card, f.desc);
      this._wireOption(card, 'difficulty');
    }
    el('p', 'screen-hint', root, 'Enter to race · Esc to go back');
  }

  _buildPause() {
    const root = this.roots.pause;
    if (!root) return;
    root.innerHTML = '<div class="pause-panel"><h2 class="pause-heading">PAUSED</h2></div>';
    const panel = root.firstElementChild;
    const list = el('div', 'pause-list', panel);
    for (const [value, label] of [['resume', 'RESUME'], ['restart', 'RESTART'], ['quit', 'QUIT']]) {
      const btn = el('button', 'pause-option menu-option', list, label);
      btn.type = 'button';
      btn.dataset.value = value;
      this._wireOption(btn, 'pause');
    }
  }

  _buildResultsShell() {
    const root = this.roots.results;
    if (!root) return;
    root.innerHTML = `
      <div class="results-panel">
        <h2 class="results-heading">RACE RESULTS</h2>
        <p class="results-track"></p>
        <table class="results-table">
          <thead><tr><th></th><th class="th-name">Racer</th><th>Time</th><th>Best Lap</th></tr></thead>
          <tbody></tbody>
        </table>
        <div class="results-continue menu-option" data-value="done">Press <kbd>Enter</kbd> to continue</div>
      </div>`;
    const cont = root.querySelector('.results-continue');
    this._wireOption(cont, 'results');
  }

  // ---------------------------------------------------------------------------
  // Data-driven screens (built lazily on first show, cached by data identity)
  // ---------------------------------------------------------------------------

  /** @param {import('../game/characters.js').Character[]} characters */
  _buildCharacters(characters) {
    if (this._builtCharacters === characters) return;
    this._builtCharacters = characters;
    const root = this.roots.character;
    if (!root) return;
    root.innerHTML = '<h2 class="screen-heading">PICK YOUR RACER</h2>';
    const grid = el('div', 'char-grid', root);
    for (const ch of characters) {
      const card = el('button', 'card char-card menu-option', grid);
      card.type = 'button';
      card.dataset.value = ch.id;
      const swatch = el('div', 'char-swatch', card);
      swatch.style.background =
        `linear-gradient(135deg, ${cssColor(ch.color)}, ${cssColor(ch.accentColor ?? ch.color)})`;
      el('span', 'char-helmet', swatch, '🏎️');
      const body = el('div', 'char-body', card);
      const nameRow = el('div', 'char-name-row', body);
      el('span', 'char-name', nameRow, ch.name);
      el('span', `chip chip-${ch.weightClass}`, nameRow, ch.weightClass);
      el('p', 'char-blurb', body, ch.blurb);
      const stats = el('div', 'char-stats', body);
      for (const [key, label] of STAT_ROWS) {
        const row = el('div', 'stat-row', stats);
        el('span', 'stat-label', row, label);
        const bar = el('div', 'stat-bar', row);
        const fill = el('div', 'stat-fill', bar);
        const [lo, hi] = CHARACTER_STAT_RANGE[key];
        const pct = Math.max(8, Math.min(100, ((ch.stats[key] - lo) / (hi - lo)) * 100));
        fill.style.width = pct.toFixed(0) + '%';
      }
      this._wireOption(card, 'character');
    }
    el('p', 'screen-hint', root, 'Arrows to browse · Enter to pick');
  }

  /** @param {Array<object>} tracks track defs (tracks.js shape, with .points) */
  _buildTracks(tracks) {
    if (this._builtTracks === tracks) return;
    this._builtTracks = tracks;
    const root = this.roots.track;
    if (!root) return;
    root.innerHTML = '<h2 class="screen-heading">CHOOSE A TRACK</h2>';
    const row = el('div', 'card-row track-row', root);
    for (const t of tracks) {
      const card = el('button', 'card track-card menu-option', row);
      card.type = 'button';
      card.dataset.value = t.id;
      const theme = t.theme || {};
      const road = theme.road != null ? cssColor(theme.road) : '#3a3f4a';
      const sky = theme.sky != null ? cssColor(theme.sky) : '#4aa8ff';
      const map = el('div', 'track-map', card);
      map.style.background =
        `linear-gradient(180deg, ${sky}cc, ${theme.offroad != null ? cssColor(theme.offroad) : '#557755'}cc)`;
      // Inline SVG outline from the raw control points (100x60 viewBox).
      const pts = outlinePoints(t.points || []);
      map.innerHTML =
        `<svg viewBox="0 0 100 60" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
           <polygon points="${pts}" fill="none" stroke="rgba(255,255,255,0.9)" stroke-width="7"
             stroke-linejoin="round" stroke-linecap="round"/>
           <polygon points="${pts}" fill="none" stroke="${road}" stroke-width="4.5"
             stroke-linejoin="round" stroke-linecap="round"/>
         </svg>`;
      const body = el('div', 'track-body', card);
      el('div', 'track-name', body, t.name);
      el('p', 'track-subtitle', body, t.subtitle || '');
      el('span', 'chip chip-laps', body, `${t.laps ?? 3} LAPS`);
      this._wireOption(card, 'track');
    }
    el('p', 'screen-hint', root, 'Enter to select · Esc to go back');
  }

  // ---------------------------------------------------------------------------
  // Show / hide
  // ---------------------------------------------------------------------------

  _show(name, cols = 1) {
    this.hideAll();
    const root = this.roots[name];
    if (!root) return;
    root.hidden = false;
    this._screen = name;
    this._cols = cols;
    this._items = Array.from(root.querySelectorAll('.menu-option'))
      .map((node) => ({ el: node, value: node.dataset.value }));
    const remembered = this._memory[name] ?? 0;
    this._setFocus(Math.min(remembered, Math.max(0, this._items.length - 1)));
  }

  showTitle() { this._show('title'); }

  showCharacter(characters) {
    this._buildCharacters(characters);
    this._show('character', 4);
  }

  showTrack(tracks) {
    this._buildTracks(tracks);
    this._show('track');
  }

  showDifficulty() { this._show('difficulty'); }

  /** Pause overlays the HUD; it does not clear which screen came before. */
  showPause() {
    const root = this.roots.pause;
    if (!root) return;
    root.hidden = false;
    this._screen = 'pause';
    this._cols = 1;
    this._items = Array.from(root.querySelectorAll('.menu-option'))
      .map((node) => ({ el: node, value: node.dataset.value }));
    this._setFocus(0);
  }

  hidePause() {
    const root = this.roots.pause;
    if (root) root.hidden = true;
    if (this._screen === 'pause') {
      this._screen = null;
      this._items = [];
    }
  }

  /**
   * @param {Array<object>} standings karts sorted by finish rank
   * @param {object} player the player's kart
   * @param {string} trackName
   */
  showResults(standings, player, trackName) {
    const root = this.roots.results;
    if (!root) return;
    root.querySelector('.results-track').textContent = trackName || '';
    const tbody = root.querySelector('tbody');
    tbody.innerHTML = '';
    standings.forEach((k, i) => {
      const rank = k.rank || i + 1;
      const tr = document.createElement('tr');
      if (k === player) tr.className = 'is-player';
      tr.style.setProperty('--row-i', i);
      const tdRank = el('td', 'td-rank', tr);
      if (rank <= 3) {
        el('span', 'medal', tdRank, MEDALS[rank - 1]);
      } else {
        tdRank.textContent = ORDINALS[rank] || `${rank}th`;
      }
      const tdName = el('td', 'td-name', tr);
      const dot = el('span', 'name-dot', tdName);
      dot.style.background = cssColor(k.color);
      el('span', 'name-text', tdName, k.name);
      if (k === player) el('span', 'chip chip-you', tdName, 'YOU');
      el('td', 'td-time', tr, k.finished ? fmtClock(k.finishTime) : 'DNF');
      el('td', 'td-best', tr, fmtClock(k.bestLap));
      tbody.appendChild(tr);
    });
    this._show('results');
  }

  hideAll() {
    for (const key of Object.keys(this.roots)) {
      const root = this.roots[key];
      if (root) root.hidden = true;
    }
    this._screen = null;
    this._items = [];
  }

  // ---------------------------------------------------------------------------
  // Focus + confirm (driven externally by main.js / InputManager)
  // ---------------------------------------------------------------------------

  _setFocus(i) {
    if (this._items.length === 0) return;
    const n = this._items.length;
    this._focus = ((i % n) + n) % n;
    if (this._screen) this._memory[this._screen] = this._focus;
    for (let j = 0; j < n; j++) {
      this._items[j].el.classList.toggle('is-focused', j === this._focus);
    }
  }

  /**
   * @param {number} dir -1/+1 steps, -10/+10 jumps a grid row
   */
  moveFocus(dir) {
    if (this._items.length === 0) return;
    const step = Math.abs(dir) >= 10 ? Math.sign(dir) * this._cols : dir;
    this._setFocus(this._focus + step);
  }

  /** @returns {{screen:string, value:*}|null} the focused option */
  getFocused() {
    if (!this._screen || this._items.length === 0) return null;
    return { screen: this._screen, value: this._items[this._focus]?.value };
  }

  /**
   * Activate the focused option: fires the matching callback and returns
   * `{screen, value}` (or null when nothing is focused).
   */
  confirm() {
    const focused = this.getFocused();
    if (!focused) return null;
    const cb = this.callbacks;
    const { screen, value } = focused;
    switch (screen) {
      case 'title': cb.onStart?.(); break;
      case 'character': cb.onCharacter?.(value); break;
      case 'track': cb.onTrack?.(value); break;
      case 'difficulty': cb.onDifficulty?.(value); break;
      case 'pause':
        if (value === 'resume') cb.onResume?.();
        else if (value === 'restart') cb.onRestart?.();
        else cb.onQuit?.();
        break;
      case 'results': cb.onResultsDone?.(); break;
    }
    return focused;
  }

  /** Hover focuses; click focuses then confirms. */
  _wireOption(node, screen) {
    node.addEventListener('mouseenter', () => {
      if (this._screen !== screen) return;
      const i = this._items.findIndex((it) => it.el === node);
      if (i >= 0 && i !== this._focus) this._setFocus(i);
    });
    node.addEventListener('click', (ev) => {
      if (this._screen !== screen) return;
      ev.stopPropagation(); // keep the title screen's whole-screen handler out
      const i = this._items.findIndex((it) => it.el === node);
      if (i >= 0) this._setFocus(i);
      this.confirm();
    });
  }
}
