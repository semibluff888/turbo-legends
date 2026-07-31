import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

test('mobile race controls provide visible steer, drift, item, brake, and pause affordances', () => {
  assert.match(html, /class="touch-steer-pad"/);
  assert.match(html, /class="btn btn-drift"/);
  assert.match(html, /class="btn btn-item"/);
  assert.match(html, /class="btn btn-brake"/);
  assert.match(html, /class="btn btn-pause"/);
  assert.match(html, /aria-label="Brake or reverse"/);
  assert.match(html, /aria-label="Pause race"/);
});

test('mobile race controls are gated to an active HUD and respect device safe areas', () => {
  assert.match(css, /body\.touch #hud:not\(\[hidden\]\) ~ #touch-controls/);
  assert.match(css, /body\.touch #hud:not\(\[hidden\]\) ~ #touch-steer-zone/);
  assert.match(css, /env\(safe-area-inset-right/);
  assert.match(css, /env\(safe-area-inset-bottom/);
  assert.match(css, /\.touch-action-cluster/);
  assert.match(css, /\.touch-steer-knob/);
});
