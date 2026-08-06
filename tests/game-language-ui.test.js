import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MENU_BGM_CHOICES, RACE_BGM_CHOICES } from '../src/audio/bgm.js';
import { ITEM, ITEM_INFO } from '../src/core/constants.js';
import { PAINT_THEMES, AVATARS } from '../src/game/appearance.js';
import { CHARACTERS } from '../src/game/characters.js';
import { ERROR_CODES } from '../src/net/protocol.js';
import { TRACKS } from '../src/track/tracks.js';
import {
  DEFAULT_LANGUAGE,
  applyDocumentLanguage,
  formatCopy,
  formatOrdinal,
  getUiCopy,
  localizeAvatar,
  localizeCharacter,
  localizeItem,
  localizePaint,
  localizeTrack,
  sanitizeLanguage,
} from '../src/ui/copy.js';
import { OnlineScreens } from '../src/ui/online-screens.js';

const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

function catalogPaths(value, prefix = '', output = []) {
  if (!value || typeof value !== 'object') return output;
  for (const key of Object.keys(value).sort()) {
    const path = prefix ? `${prefix}.${key}` : key;
    output.push(path);
    catalogPaths(value[key], path, output);
  }
  return output;
}

function placeholders(value) {
  return [...String(value).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1]).sort();
}

function assertMatchingPlaceholders(left, right, path = '') {
  if (typeof left === 'string' || typeof right === 'string') {
    assert.deepEqual(placeholders(left), placeholders(right), path);
    return;
  }
  if (!left || typeof left !== 'object') return;
  for (const key of Object.keys(left)) {
    assertMatchingPlaceholders(left[key], right[key], path ? `${path}.${key}` : key);
  }
}

test('language catalog defaults to Simplified Chinese and formats both locales', () => {
  assert.equal(DEFAULT_LANGUAGE, 'zh-CN');
  assert.equal(sanitizeLanguage('en'), 'en');
  assert.equal(sanitizeLanguage('fr'), 'zh-CN');
  assert.equal(getUiCopy().settings.rows[0].key, 'language');
  assert.deepEqual(getUiCopy('en').settings.rows[0].options.map((option) => option.label), ['简体中文', 'English']);
  assert.equal(formatCopy('{ready}/{total}', { ready: 2, total: 4 }), '2/4');
  assert.equal(formatOrdinal(2, 'en'), '2nd');
  assert.equal(formatOrdinal(2, 'zh-CN'), '第2名');
});

test('language catalogs have matching structure, placeholders, and protocol error coverage', () => {
  const zh = getUiCopy('zh-CN');
  const en = getUiCopy('en');
  assert.deepEqual(catalogPaths(zh), catalogPaths(en));
  assertMatchingPlaceholders(zh, en);
  for (const key of Object.keys(ERROR_CODES)) {
    assert.equal(typeof zh.online.errors[key], 'string', `missing zh-CN error: ${key}`);
    assert.equal(typeof en.online.errors[key], 'string', `missing en error: ${key}`);
  }
});

test('music names remain unchanged across languages', () => {
  const zhRows = new Map(getUiCopy('zh-CN').settings.rows.map((row) => [row.key, row]));
  const enRows = new Map(getUiCopy('en').settings.rows.map((row) => [row.key, row]));
  for (const [key, sourceChoices] of [['menuBgm', MENU_BGM_CHOICES], ['raceBgm', RACE_BGM_CHOICES]]) {
    const zhOptions = new Map(zhRows.get(key).options.map((option) => [option.value, option.label]));
    const enOptions = new Map(enRows.get(key).options.map((option) => [option.value, option.label]));
    for (const choice of sourceChoices) {
      if (choice.value === 'random' || choice.value === 'default') continue;
      assert.equal(zhOptions.get(choice.value), choice.label);
      assert.equal(enOptions.get(choice.value), choice.label);
    }
  }
});

test('the main menu tagline remains English in both languages', () => {
  assert.equal(getUiCopy('zh-CN').title.tagline, 'START YOUR ENGINES');
  assert.equal(getUiCopy('en').title.tagline, 'START YOUR ENGINES');
});

test('racer identity distinguishes its kart from human racer labels', () => {
  const zh = getUiCopy('zh-CN');
  const en = getUiCopy('en');
  assert.equal(zh.character.heading, '选择你的赛车');
  assert.equal(en.character.heading, 'PICK YOUR KART');
  assert.equal(zh.online.room.yourRacer, '你的车手');
  assert.equal(en.online.room.yourRacer, 'YOUR RACER');
  assert.equal(zh.online.room.racerTab, '赛车');
  assert.equal(en.online.room.racerTab, 'KART');
  assert.equal(zh.online.room.racers, '车手');
  assert.equal(en.online.room.racers, 'RACERS');
  assert.match(zh.online.errors.CHARACTER_INVALID, /赛车/);
  assert.match(en.online.errors.CHARACTER_INVALID, /kart/i);
});

test('track names and descriptive entity copy localize while racer names stay unchanged', () => {
  const character = localizeCharacter(CHARACTERS[0], 'zh-CN');
  const track = localizeTrack(TRACKS[0], 'zh-CN');
  const paint = localizePaint(PAINT_THEMES[0], 'zh-CN');
  const avatar = localizeAvatar(AVATARS[0], 'zh-CN');
  const item = localizeItem(ITEM.BANANA, ITEM_INFO[ITEM.BANANA], 'zh-CN');

  assert.equal(character.name, CHARACTERS[0].name);
  assert.notEqual(character.blurb, CHARACTERS[0].blurb);
  assert.equal(track.name, '落日环道');
  assert.notEqual(track.subtitle, TRACKS[0].subtitle);
  assert.deepEqual(
    TRACKS.map((candidate) => localizeTrack(candidate, 'zh-CN').name),
    ['落日环道', '港湾环线', '巅峰赛道', '极光冰瀑', '摩纳哥大奖赛', '都会高速'],
  );
  assert.deepEqual(
    TRACKS.map((candidate) => localizeTrack(candidate, 'en').name),
    TRACKS.map((candidate) => candidate.name),
  );
  assert.equal(paint.name, '极速蓝');
  assert.equal(avatar.name, '猫');
  assert.equal(item.label, '香蕉皮');
});

test('document language updates static touch and finish controls without changing the brand', () => {
  const nodes = new Map();
  const node = () => ({ textContent: '', attributes: new Map(), setAttribute(key, value) { this.attributes.set(key, value); } });
  for (const selector of [
    '#finish-cinematic-skip', '.finish-skip-desktop', '.finish-skip-touch', '#touch-steer-zone',
    '.touch-steer-label', '#touch-controls', '.btn-pause', '.btn-item', '.btn-item .touch-action-label',
    '.btn-brake', '.btn-brake .touch-action-label', '.btn-drift', '.btn-drift .touch-action-label',
    '.noscript-warning',
  ]) nodes.set(selector, node());
  const doc = {
    documentElement: { lang: '' },
    querySelector(selector) { return nodes.get(selector) || null; },
  };

  applyDocumentLanguage(doc, 'en');
  assert.equal(doc.documentElement.lang, 'en');
  assert.equal(nodes.get('.finish-skip-touch').textContent, 'SKIP');
  assert.equal(nodes.get('.btn-item .touch-action-label').textContent, 'ITEM');
  applyDocumentLanguage(doc, 'zh-CN');
  assert.equal(doc.documentElement.lang, 'zh-CN');
  assert.equal(nodes.get('.finish-skip-touch').textContent, '跳过');
  assert.equal(nodes.get('.btn-item .touch-action-label').textContent, '道具');
});

test('Lobby and Room page actions are icon-only with localized hover and accessible text', () => {
  const screen = Object.assign(Object.create(OnlineScreens.prototype), { copy: getUiCopy('zh-CN') });
  const zh = screen._pageActionsMarkup();
  assert.match(zh, /aria-label="游戏设置" title="游戏设置"/);
  assert.match(zh, /aria-label="游戏帮助" title="游戏帮助"/);
  assert.doesNotMatch(zh, /<span>游戏设置<\/span>|<span>游戏帮助<\/span>/);

  screen.copy = getUiCopy('en');
  const en = screen._pageActionsMarkup();
  assert.match(en, /aria-label="SETTINGS" title="SETTINGS"/);
  assert.match(en, /aria-label="HELP" title="HELP"/);
  assert.doesNotMatch(en, /<span>SETTINGS<\/span>|<span>HELP<\/span>/);
});

test('main applies a language change to every presentation component without reconnecting', () => {
  assert.match(mainSource, /function applyLanguage\(language\)[\s\S]*screens\.setLanguage\(language\)[\s\S]*onlineScreens\.setLanguage\(language\)[\s\S]*hud\.setLanguage\(language\)[\s\S]*networkStatus\.setLanguage\(language\)/);
  const applyLanguageSource = mainSource.slice(
    mainSource.indexOf('function applyLanguage(language)'),
    mainSource.indexOf('function localizedOnlineError'),
  );
  assert.doesNotMatch(applyLanguageSource, /onlineClient\.(?:connect|disconnect|enterLobby)/);
});
