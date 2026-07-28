// Menu screens: main menu, settings, help, character/track/difficulty select,
// pause and results. DOM-only, built into roots supplied by index.html.
//
// Navigation is externally driven by main.js so keyboard and gamepad share
// one path. Mouse and touch use the same focus/confirm methods through events.
// No DOM access occurs at module import time.

import { CHARACTER_STAT_RANGE, DIFFICULTY, ITEM_INFO } from '../core/constants.js';
import {
  HELP_CONTROLS,
  HELP_GAMEPLAY,
  HELP_ITEM_DESCRIPTIONS,
  HELP_ITEM_ORDER,
  UI_COPY,
} from './copy.js';

const cssColor = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0');
const SETTING_STEP = 0.05;

function fmtClock(t) {
  if (!Number.isFinite(t) || t <= 0) return '—';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}

function clampUnit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** el('div', 'card', parent, text) — tiny DOM builder. */
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

const MEDALS = ['🥇', '🥈', '🥉'];
const ORDINALS = ['0th', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];

/** Normalize a track definition into a 100x60 SVG polygon. */
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
      settings: pick('settings', 'screen-settings', 'screenSettings'),
      help: pick('help', 'screen-help', 'screenHelp'),
      pause: pick('pause', 'screen-pause', 'screenPause'),
      results: pick('results', 'screen-results', 'screenResults'),
    };
    this.callbacks = callbacks || {};

    this._screen = null;
    this._items = [];
    this._focus = 0;
    this._cols = 1;
    this._memory = { difficulty: 1 };
    this._builtCharacters = null;
    this._builtTracks = null;
    this._settings = {};
    this._settingDefs = new Map(UI_COPY.settings.rows.map((def) => [def.key, def]));
    this._helpTab = 'controls';
    this._toastTimer = null;

    this._buildTitle();
    this._buildDifficulty();
    this._buildSettings();
    this._buildHelp();
    this._buildPause();
    this._buildResultsShell();
  }

  // -------------------------------------------------------------------------
  // Static screens
  // -------------------------------------------------------------------------

  _buildTitle() {
    const root = this.roots.title;
    if (!root) return;
    const menu = UI_COPY.title.items.map((item) => `
      <button class="main-menu-option menu-option main-menu-${item.value}"
        type="button" data-value="${item.value}">
        <span class="main-menu-icon" aria-hidden="true">${item.icon}</span>
        <span class="main-menu-copy">
          <span class="main-menu-label">${item.label}</span>
          <span class="main-menu-desc">${item.desc}</span>
        </span>
        ${item.badge ? `<span class="main-menu-badge">${item.badge}</span>` : '<span class="main-menu-arrow">›</span>'}
      </button>`).join('');

    root.innerHTML = `
      <div class="title-layout">
        <div class="title-brand">
          <h1 class="logo" aria-label="Turbo Kart">
            <span class="logo-line logo-turbo">TURBO</span>
            <span class="logo-line logo-kart">KART</span>
          </h1>
          <p class="title-tagline">START YOUR ENGINES</p>
        </div>
        <div class="main-menu-panel">
          <h2 class="main-menu-heading">${UI_COPY.title.heading}</h2>
          <div class="main-menu-list">${menu}</div>
        </div>
      </div>
      <footer class="title-help">${UI_COPY.title.hint}</footer>
      <div class="menu-status" role="status" aria-live="polite" hidden></div>`;

    for (const node of root.querySelectorAll('.main-menu-option')) {
      this._wireOption(node, 'title');
    }
  }

  _buildDifficulty() {
    const root = this.roots.difficulty;
    if (!root) return;
    root.innerHTML = `<h2 class="screen-heading">${UI_COPY.difficulty.heading}</h2>`;
    const row = el('div', 'card-row diff-row', root);
    for (const key of Object.keys(DIFFICULTY)) {
      const d = DIFFICULTY[key];
      const f = UI_COPY.difficulty.flavor[key] || { icon: '🏁', desc: '' };
      const card = el('button', `card diff-card diff-${key} menu-option`, row);
      card.type = 'button';
      card.dataset.value = key;
      el('div', 'diff-icon', card, f.icon);
      el('div', 'diff-name', card, d.label);
      el('p', 'diff-desc', card, f.desc);
      this._wireOption(card, 'difficulty');
    }
    el('p', 'screen-hint', root, UI_COPY.difficulty.hint);
  }

  _buildSettings() {
    const root = this.roots.settings;
    if (!root) return;
    root.innerHTML = `
      <div class="settings-panel">
        <h2 class="panel-heading">${UI_COPY.settings.heading}</h2>
        <div class="settings-list"></div>
        <div class="panel-actions">
          <button type="button" class="panel-action menu-option" data-value="reset">${UI_COPY.settings.reset}</button>
          <button type="button" class="panel-action panel-action-primary menu-option" data-value="back">${UI_COPY.settings.back}</button>
        </div>
        <p class="panel-hint">${UI_COPY.settings.hint}</p>
      </div>`;

    const list = root.querySelector('.settings-list');
    for (const def of UI_COPY.settings.rows) {
      const row = el('div', `setting-row menu-option setting-${def.kind}`, list);
      row.dataset.value = def.key;
      row.dataset.kind = def.kind;
      row.setAttribute('tabindex', '-1');
      row.setAttribute('role', def.kind === 'toggle'
        ? 'switch' : def.kind === 'choice' ? 'spinbutton' : 'slider');
      if (def.kind === 'volume') {
        row.setAttribute('aria-valuemin', '0');
        row.setAttribute('aria-valuemax', '100');
      } else if (def.kind === 'choice') {
        row.setAttribute('aria-valuemin', '0');
        row.setAttribute('aria-valuemax', String(Math.max(0, def.options.length - 1)));
      }
      const copy = el('span', 'setting-copy', row);
      el('span', 'setting-label', copy, def.label);
      el('span', 'setting-desc', copy, def.desc);
      const control = el('span', 'setting-control', row);
      if (def.kind === 'volume') {
        const meter = el('span', 'setting-meter', control);
        el('span', 'setting-meter-fill', meter);
        el('span', 'setting-value', control);
      } else if (def.kind === 'toggle') {
        const toggle = el('span', 'setting-switch', control);
        el('span', 'setting-switch-knob', toggle);
        el('span', 'setting-value', control);
      } else {
        control.classList.add('setting-choice');
        const previous = el('button', 'setting-choice-arrow setting-choice-previous', control, '‹');
        previous.type = 'button';
        previous.tabIndex = -1;
        previous.dataset.direction = '-1';
        previous.setAttribute('aria-label', `Previous ${def.label}`);
        el('span', 'setting-value', control);
        const next = el('button', 'setting-choice-arrow setting-choice-next', control, '›');
        next.type = 'button';
        next.tabIndex = -1;
        next.dataset.direction = '1';
        next.setAttribute('aria-label', `Next ${def.label}`);
      }
      this._wireSettingRow(row);
    }

    for (const node of root.querySelectorAll('.panel-action')) {
      this._wireOption(node, 'settings');
    }
  }

  _buildHelp() {
    const root = this.roots.help;
    if (!root) return;
    root.innerHTML = `
      <div class="help-panel">
        <h2 class="panel-heading">${UI_COPY.help.heading}</h2>
        <div class="help-tabs" role="tablist"></div>
        <div class="help-content" role="tabpanel"></div>
        <div class="help-footer">
          <button type="button" class="panel-action panel-action-primary menu-option" data-value="back">${UI_COPY.help.back}</button>
          <p class="panel-hint">${UI_COPY.help.hint}</p>
        </div>
      </div>`;
    const tabs = root.querySelector('.help-tabs');
    for (const tab of UI_COPY.help.tabs) {
      const button = el('button', 'help-tab', tabs, tab.label);
      button.type = 'button';
      button.dataset.value = tab.value;
      button.setAttribute('role', 'tab');
      button.addEventListener('click', () => this._setHelpTab(tab.value));
    }
    this._wireOption(root.querySelector('[data-value="back"]'), 'help');
    this._renderHelp();
  }

  _buildPause() {
    const root = this.roots.pause;
    if (!root) return;
    root.innerHTML = `<div class="pause-panel"><h2 class="pause-heading">${UI_COPY.pause.heading}</h2></div>`;
    const panel = root.firstElementChild;
    const list = el('div', 'pause-list', panel);
    for (const [value, label] of UI_COPY.pause.items) {
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
        <h2 class="results-heading">${UI_COPY.results.heading}</h2>
        <p class="results-track"></p>
        <table class="results-table">
          <thead><tr><th></th><th class="th-name">${UI_COPY.results.racer}</th><th>${UI_COPY.results.time}</th><th>${UI_COPY.results.bestLap}</th></tr></thead>
          <tbody></tbody>
        </table>
        <div class="results-continue menu-option" data-value="done">${UI_COPY.results.continue}</div>
      </div>`;
    this._wireOption(root.querySelector('.results-continue'), 'results');
  }

  // -------------------------------------------------------------------------
  // Data-driven screens
  // -------------------------------------------------------------------------

  _buildCharacters(characters) {
    if (this._builtCharacters === characters) return;
    this._builtCharacters = characters;
    const root = this.roots.character;
    if (!root) return;
    root.innerHTML = `<h2 class="screen-heading">${UI_COPY.character.heading}</h2>`;
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
        const stat = el('div', 'stat-row', stats);
        el('span', 'stat-label', stat, label);
        const bar = el('div', 'stat-bar', stat);
        const fill = el('div', 'stat-fill', bar);
        const [lo, hi] = CHARACTER_STAT_RANGE[key];
        const pct = Math.max(8, Math.min(100, ((ch.stats[key] - lo) / (hi - lo)) * 100));
        fill.style.width = pct.toFixed(0) + '%';
      }
      this._wireOption(card, 'character');
    }
    el('p', 'screen-hint', root, UI_COPY.character.hint);
  }

  _buildTracks(tracks) {
    if (this._builtTracks === tracks) return;
    this._builtTracks = tracks;
    const root = this.roots.track;
    if (!root) return;
    root.innerHTML = `<h2 class="screen-heading">${UI_COPY.track.heading}</h2>`;
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
    el('p', 'screen-hint', root, UI_COPY.track.hint);
  }

  // -------------------------------------------------------------------------
  // Show / hide
  // -------------------------------------------------------------------------

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

  showTitle() {
    this._hideStatus();
    this._show('title');
  }

  showCharacter(characters) {
    this._buildCharacters(characters);
    this._show('character', 4);
  }

  showTrack(tracks) {
    this._buildTracks(tracks);
    this._show('track');
  }

  showDifficulty() { this._show('difficulty'); }

  showSettings(settings) {
    this.updateSettings(settings);
    this._show('settings');
  }

  showHelp(tab = this._helpTab) {
    this._setHelpTab(tab);
    this._show('help');
  }

  showPause() {
    this.hideAll();
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
      if (rank <= 3) el('span', 'medal', tdRank, MEDALS[rank - 1]);
      else tdRank.textContent = ORDINALS[rank] || `${rank}th`;
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

  // -------------------------------------------------------------------------
  // Settings + help behavior
  // -------------------------------------------------------------------------

  updateSettings(settings) {
    this._settings = { ...this._settings, ...(settings || {}) };
    this._syncSettings();
  }

  _syncSettings() {
    const root = this.roots.settings;
    if (!root) return;
    for (const row of root.querySelectorAll('.setting-row')) {
      const key = row.dataset.value;
      const kind = row.dataset.kind;
      const valueNode = row.querySelector('.setting-value');
      if (kind === 'toggle') {
        const on = !!this._settings[key];
        row.classList.toggle('is-on', on);
        row.setAttribute('aria-checked', String(on));
        if (valueNode) valueNode.textContent = on ? 'ON' : 'OFF';
      } else if (kind === 'volume') {
        const value = clampUnit(this._settings[key]);
        const pct = Math.round(value * 100);
        const fill = row.querySelector('.setting-meter-fill');
        if (fill) fill.style.width = `${pct}%`;
        if (valueNode) valueNode.textContent = `${pct}%`;
        row.setAttribute('aria-valuenow', String(pct));
        row.setAttribute('aria-valuetext', `${pct} percent`);
      } else {
        const options = this._settingDefs.get(key)?.options || [];
        let index = options.findIndex((option) => option.value === this._settings[key]);
        if (index < 0) index = 0;
        const option = options[index];
        if (valueNode) valueNode.textContent = option?.label || '';
        row.setAttribute('aria-valuenow', String(index));
        row.setAttribute('aria-valuetext', option?.label || '');
      }
      const musicSetting = key === 'music' || key === 'menuBgm' || key === 'raceBgm';
      row.classList.toggle('is-inactive', musicSetting && !this._settings.musicEnabled);
    }
  }

  _changeSetting(key, value) {
    const kind = this._settingDefs.get(key)?.kind;
    let next;
    if (kind === 'toggle') next = !!value;
    else if (kind === 'choice') next = value;
    else next = clampUnit(value);
    if (this._settings[key] === next) return;
    this._settings[key] = next;
    this._syncSettings();
    this.callbacks.onSettingsChange?.(key, next);
  }

  adjustFocused(dir) {
    if (this._screen !== 'settings' || this._items.length === 0) return false;
    const item = this._items[this._focus];
    const node = item?.el;
    if (!node || !node.classList.contains('setting-row')) return false;
    const key = node.dataset.value;
    if (node.dataset.kind === 'toggle') {
      this._changeSetting(key, dir > 0);
    } else if (node.dataset.kind === 'choice') {
      this._cycleChoice(node, dir);
    } else {
      const value = clampUnit(this._settings[key]) + Math.sign(dir) * SETTING_STEP;
      this._changeSetting(key, Math.round(clampUnit(value) / SETTING_STEP) * SETTING_STEP);
    }
    return true;
  }

  _cycleChoice(node, dir) {
    const key = node.dataset.value;
    const options = this._settingDefs.get(key)?.options || [];
    if (options.length <= 1) return false;
    let index = options.findIndex((option) => option.value === this._settings[key]);
    if (index < 0) index = 0;
    index = (index + Math.sign(dir) + options.length) % options.length;
    this._changeSetting(key, options[index].value);
    return true;
  }

  cycleHelpTab(dir) {
    if (this._screen !== 'help') return;
    const tabs = UI_COPY.help.tabs;
    const current = Math.max(0, tabs.findIndex((tab) => tab.value === this._helpTab));
    const next = (current + Math.sign(dir) + tabs.length) % tabs.length;
    this._setHelpTab(tabs[next].value);
  }

  scrollHelp(dir) {
    if (this._screen !== 'help') return;
    const content = this.roots.help?.querySelector('.help-content');
    if (!content) return;
    const top = Math.sign(dir) * Math.max(90, content.clientHeight * 0.32);
    if (typeof content.scrollBy === 'function') content.scrollBy({ top, behavior: 'smooth' });
    else content.scrollTop += top;
  }

  _setHelpTab(value) {
    if (!UI_COPY.help.tabs.some((tab) => tab.value === value)) value = 'controls';
    this._helpTab = value;
    const root = this.roots.help;
    if (!root) return;
    for (const tab of root.querySelectorAll('.help-tab')) {
      const active = tab.dataset.value === value;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.setAttribute('tabindex', active ? '0' : '-1');
    }
    this._renderHelp();
  }

  _renderHelp() {
    const content = this.roots.help?.querySelector('.help-content');
    if (!content) return;
    content.innerHTML = '';

    if (this._helpTab === 'controls') {
      const grid = el('div', 'help-controls-grid', content);
      for (const group of HELP_CONTROLS) {
        const card = el('section', 'help-section help-controls-card', grid);
        el('h3', 'help-section-title', card, group.title);
        const rows = el('div', 'help-control-rows', card);
        for (const [action, binding] of group.rows) {
          const row = el('div', 'help-control-row', rows);
          el('span', 'help-control-action', row, action);
          el('span', 'help-control-binding', row, binding);
        }
      }
    } else if (this._helpTab === 'items') {
      const grid = el('div', 'help-items-grid', content);
      for (const item of HELP_ITEM_ORDER) {
        const info = ITEM_INFO[item];
        if (!info) continue;
        const card = el('article', 'help-item-card', grid);
        el('span', 'help-item-glyph', card, info.glyph);
        const copy = el('span', 'help-item-copy', card);
        el('h3', 'help-item-name', copy, info.label);
        el('p', 'help-item-desc', copy, HELP_ITEM_DESCRIPTIONS[item] || '');
      }
    } else {
      const grid = el('div', 'help-gameplay-grid', content);
      for (const tip of HELP_GAMEPLAY) {
        const card = el('article', 'help-gameplay-card', grid);
        el('span', 'help-gameplay-icon', card, tip.icon);
        const copy = el('span', 'help-gameplay-copy', card);
        el('h3', 'help-gameplay-title', copy, tip.title);
        el('p', 'help-gameplay-text', copy, tip.text);
      }
    }
    content.scrollTop = 0;
  }

  showStatus(message) {
    const node = this.roots.title?.querySelector('.menu-status');
    if (!node) return;
    if (this._toastTimer) clearTimeout(this._toastTimer);
    node.textContent = message;
    node.hidden = false;
    node.classList.remove('is-showing');
    void node.offsetWidth;
    node.classList.add('is-showing');
    this._toastTimer = setTimeout(() => this._hideStatus(), 2000);
  }

  _hideStatus() {
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = null;
    const node = this.roots.title?.querySelector('.menu-status');
    if (!node) return;
    node.hidden = true;
    node.classList.remove('is-showing');
  }

  // -------------------------------------------------------------------------
  // Focus + confirm
  // -------------------------------------------------------------------------

  _setFocus(i) {
    if (this._items.length === 0) return;
    const n = this._items.length;
    this._focus = ((i % n) + n) % n;
    if (this._screen) this._memory[this._screen] = this._focus;
    for (let j = 0; j < n; j++) {
      this._items[j].el.classList.toggle('is-focused', j === this._focus);
    }
  }

  moveFocus(dir) {
    if (this._items.length === 0) return;
    const step = Math.abs(dir) >= 10 ? Math.sign(dir) * this._cols : dir;
    this._setFocus(this._focus + step);
  }

  getFocused() {
    if (!this._screen || this._items.length === 0) return null;
    return { screen: this._screen, value: this._items[this._focus]?.value };
  }

  confirm() {
    const focused = this.getFocused();
    if (!focused) return null;
    const cb = this.callbacks;
    const { screen, value } = focused;
    switch (screen) {
      case 'title':
        if (value === 'single') cb.onSinglePlayer?.();
        else if (value === 'multiplayer') {
          this.showStatus(UI_COPY.title.multiplayerToast);
          cb.onMultiplayer?.();
        } else if (value === 'settings') cb.onOpenSettings?.();
        else if (value === 'help') cb.onOpenHelp?.();
        break;
      case 'character': cb.onCharacter?.(value); break;
      case 'track': cb.onTrack?.(value); break;
      case 'difficulty': cb.onDifficulty?.(value); break;
      case 'settings': {
        const node = this._items[this._focus]?.el;
        if (node?.classList.contains('setting-row') && node.dataset.kind === 'toggle') {
          this._changeSetting(value, !this._settings[value]);
        } else if (value === 'reset') cb.onSettingsReset?.();
        else if (value === 'back') cb.onClosePanel?.();
        break;
      }
      case 'help': cb.onClosePanel?.(); break;
      case 'pause':
        if (value === 'resume') cb.onResume?.();
        else if (value === 'settings') cb.onOpenSettings?.();
        else if (value === 'help') cb.onOpenHelp?.();
        else if (value === 'restart') cb.onRestart?.();
        else cb.onQuit?.();
        break;
      case 'results': cb.onResultsDone?.(); break;
    }
    return focused;
  }

  _wireOption(node, screen) {
    if (!node) return;
    node.addEventListener('mouseenter', () => {
      if (this._screen !== screen) return;
      const i = this._items.findIndex((it) => it.el === node);
      if (i >= 0 && i !== this._focus) this._setFocus(i);
    });
    node.addEventListener('click', (ev) => {
      if (this._screen !== screen) return;
      ev.stopPropagation();
      const i = this._items.findIndex((it) => it.el === node);
      if (i >= 0) this._setFocus(i);
      this.confirm();
    });
  }

  _wireSettingRow(node) {
    node.addEventListener('mouseenter', () => {
      if (this._screen !== 'settings') return;
      const i = this._items.findIndex((it) => it.el === node);
      if (i >= 0 && i !== this._focus) this._setFocus(i);
    });
    node.addEventListener('click', (ev) => {
      if (this._screen !== 'settings') return;
      ev.stopPropagation();
      const i = this._items.findIndex((it) => it.el === node);
      if (i >= 0) this._setFocus(i);

      if (node.dataset.kind === 'toggle') {
        this.confirm();
        return;
      }
      if (node.dataset.kind === 'choice') {
        const arrow = ev.target?.closest?.('.setting-choice-arrow');
        this._cycleChoice(node, Number(arrow?.dataset.direction) || 1);
        return;
      }
      const meter = ev.target?.closest?.('.setting-meter');
      if (!meter) return;
      const rect = meter.getBoundingClientRect();
      if (!rect.width) return;
      const raw = clampUnit((ev.clientX - rect.left) / rect.width);
      const stepped = Math.round(raw / SETTING_STEP) * SETTING_STEP;
      this._changeSetting(node.dataset.value, stepped);
    });
  }
}
