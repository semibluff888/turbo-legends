import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

test('main switches from chase camera to the finish director exactly once', () => {
  assert.match(main, /new FinishCameraDirector\(camera, track\)/);
  assert.match(
    main,
    /function updateRaceFrame\(dt\) \{[\s\S]*const online = session\.kind === 'online';[\s\S]*const hasAuthoritativeState = !online \|\| session\.hasSnapshot;/,
  );
  assert.match(
    main,
    /if \(player\.finished && !race\.finishedAnnounced\) \{[\s\S]*race\.finishedAnnounced = true;[\s\S]*finishCamera\.begin\(player\);[\s\S]*setFinishCinematic\(true\);/,
  );
  assert.match(
    main,
    /if \(finishCamera\.active\) \{[\s\S]*finishCamera\.update\(dt,[\s\S]*\} else \{\s*chase\.update\(/,
  );
});

test('offroad particle selection reads the mounted race track', () => {
  assert.match(
    main,
    /function updateRaceFrame\(dt\) \{\s*const \{ track, session, visuals, effects, chase, finishCamera, world \} = race;/,
  );
  assert.match(
    main,
    /kart\.surface === 'offroad'[\s\S]*track\.theme\?\.scenery === 'glacier'[\s\S]*effects\.snowSpray[\s\S]*effects\.dust/,
  );
});

test('results wait for the intro while an explicit skip completes it early', () => {
  assert.match(
    main,
    /session\.state === RACE_STATE\.RESULTS[\s\S]*\(!finishCamera\.active \|\| finishCamera\.introComplete\)[\s\S]*presentRaceResults\(\)/,
  );
  assert.match(
    main,
    /function requestFinishCinematicSkip\(\)[\s\S]*finishCamera\.canSkip[\s\S]*finishCamera\.skipIntro\(\)[\s\S]*race\.finishSkipped = true/,
  );
  assert.match(
    main,
    /function presentRaceResults\(\)[\s\S]*setFinishCinematic\(false\);[\s\S]*finishCamera\.reset\(\);[\s\S]*audio\.stopEngine\(\);/,
  );
});

test('finish cinematic UI provides letterbox treatment, HUD declutter and touch skip', () => {
  assert.match(html, /id="finish-cinematic"/);
  assert.match(html, /id="finish-cinematic-skip"[\s\S]*finish-skip-touch/);
  assert.match(css, /body\.finish-cinematic #finish-cinematic \{ opacity: 1; \}/);
  assert.match(css, /body\.finish-cinematic #hud \.hud-slot,[\s\S]*#minimap,[\s\S]*\.hud-standings/);
  assert.match(css, /body\.touch #finish-cinematic-skip/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration: 0\.001s/);
});
