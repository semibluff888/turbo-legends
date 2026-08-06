import test from 'node:test';
import assert from 'node:assert/strict';

import { RACE, RACE_STATE } from '../src/core/constants.js';
import { Hud, postRaceSecondsRemaining } from '../src/ui/hud.js';
import { getUiCopy } from '../src/ui/copy.js';

function classList() {
  const values = new Set();
  return {
    add(value) { values.add(value); },
    remove(value) { values.delete(value); },
    has(value) { return values.has(value); },
  };
}

function createHud(language = 'en') {
  const hud = Object.create(Hud.prototype);
  hud._banner = { hidden: true, className: '', classList: classList(), offsetWidth: 0 };
  hud._bannerPrimary = { textContent: '' };
  hud._bannerSecondary = { textContent: '', hidden: true };
  hud._bannerTimer = null;
  hud._postRaceSecondsShown = null;
  hud.language = language;
  hud.copy = getUiCopy(language);
  return hud;
}

test('post-race countdown starts at the first finisher and rounds up for display', () => {
  const race = {
    state: RACE_STATE.RACING,
    elapsed: 100,
    karts: [
      { finished: true, finishTime: 100 },
      { finished: false, finishTime: 0 },
    ],
  };

  assert.equal(postRaceSecondsRemaining(race), RACE.postRaceTimeout);
  race.elapsed = 100.01;
  assert.equal(postRaceSecondsRemaining(race), RACE.postRaceTimeout);
  race.elapsed = 101;
  assert.equal(postRaceSecondsRemaining(race), RACE.postRaceTimeout - 1);
  race.state = RACE_STATE.RESULTS;
  assert.equal(postRaceSecondsRemaining(race), null);
});

test('post-race countdown keeps an explicit first-finish anchor after that kart leaves view', () => {
  const race = {
    state: RACE_STATE.RACING,
    elapsed: 112,
    firstFinishTime: 100,
    karts: [
      { finished: true, finishTime: 112 },
      { finished: false, finishTime: 0 },
    ],
  };

  assert.equal(postRaceSecondsRemaining(race), RACE.postRaceTimeout - 12);
});

test('finish announcement keeps place and remaining time visible', () => {
  const hud = createHud('en');

  hud.finish(2, 17);

  assert.equal(hud._banner.hidden, false);
  assert.equal(hud._bannerPrimary.textContent, 'FINISHED! 2nd');
  assert.equal(hud._bannerSecondary.textContent, 'WAITING FOR OTHER RACERS TO FINISH... 17s REMAINING');
  assert.equal(hud._bannerSecondary.hidden, false);
  assert.equal(hud._banner.classList.has('banner-in'), true);
  assert.equal(hud._bannerTimer, null);

  hud.language = 'zh-CN';
  hud.copy = getUiCopy('zh-CN');
  hud.finish(2, 17);
  assert.equal(hud._bannerPrimary.textContent, '完成比赛！第2名');
  assert.equal(hud._bannerSecondary.textContent, '正在等待其他车手完成比赛… 剩余 17 秒');
});

test('unfinished racer sees the race-ending countdown in the center banner', () => {
  const hud = createHud('zh-CN');

  hud.raceEnding(9);

  assert.equal(hud._banner.hidden, false);
  assert.equal(hud._banner.className.includes('race-ending'), true);
  assert.equal(hud._bannerPrimary.textContent, '比赛将在 9 秒后结束');
  assert.equal(hud._bannerSecondary.hidden, true);
  assert.equal(hud._bannerTimer, null);
});
