import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const marker = '/* Phone portrait menu layout';
const mobileMenus = css.slice(css.indexOf(marker));

test('phone portrait menu overrides are scoped away from desktop layouts', () => {
  assert.notEqual(css.indexOf(marker), -1);
  assert.match(mobileMenus, /@media \(orientation: portrait\) and \(max-width: 640px\)/);
  assert.match(mobileMenus, /#screen-title,[\s\S]*?#screen-online-room \{[\s\S]*?height: 100dvh;/);
  assert.match(mobileMenus, /#screen-online-lobby \.online-directory-panel,[\s\S]*?height: 100%;/);
  assert.match(mobileMenus, /#screen-online-room \.online-room-grid \{[\s\S]*?overflow-y: auto;/);
});

test('phone portrait menus use safe scrolling and keep telemetry clear of controls', () => {
  assert.match(mobileMenus, /overscroll-behavior: contain;/);
  assert.match(mobileMenus, /env\(safe-area-inset-top/);
  assert.match(mobileMenus, /#screen-title:not\(\[hidden\]\) ~ #network-status-overlay[\s\S]*?bottom: max\(10px,/);
  assert.match(mobileMenus, /#screen-character:not\(\[hidden\]\) ~ #network-status-overlay/);
  assert.match(mobileMenus, /#screen-track:not\(\[hidden\]\) ~ #network-status-overlay/);
  assert.match(mobileMenus, /#screen-difficulty:not\(\[hidden\]\) ~ #network-status-overlay/);
  assert.match(mobileMenus, /#screen-online-lobby:not\(\[hidden\]\) ~ #network-status-overlay/);
  assert.match(mobileMenus, /#screen-settings:not\(\[hidden\]\) ~ #network-status-overlay/);
  assert.match(mobileMenus, /padding-bottom: 42px;/);
});

test('phone lobby sections stay in document flow without overlapping', () => {
  assert.match(mobileMenus, /#screen-online-lobby \.online-lobby-layout \{[\s\S]*?display: flex;[\s\S]*?flex-direction: column;/);
  assert.match(mobileMenus, /#screen-online-lobby \.online-lobby-sidebar \{[\s\S]*?flex: 0 0 auto;/);
  assert.match(mobileMenus, /#screen-online-lobby \.online-room-browser \{[\s\S]*?flex: 0 0 auto;/);
});

test('phone lobby keeps navigation on top with the account controls at the right', () => {
  assert.match(mobileMenus, /#screen-online-lobby \.online-lobby-brand \{[\s\S]*?grid-column: 1 \/ -1;[\s\S]*?grid-row: 2;/);
  assert.match(mobileMenus, /#screen-online-lobby \.online-lobby-account \{[\s\S]*?grid-column: 2;[\s\S]*?grid-row: 1;[\s\S]*?justify-self: end;/);
});

test('the lobby identity card has compact sizing and visible edit affordance', () => {
  assert.match(mobileMenus, /#screen-online-lobby .online-identity-card \{ border-width: 1\.5px; \}/);
  assert.match(mobileMenus, /#screen-online-lobby .online-profile-mark \{ width: 26px; height: 26px;/);
  assert.match(mobileMenus, /#screen-online-lobby .online-identity-stats \{ font-size: 8px;/);
});

test('phone portrait menu overrides do not modify in-race UI selectors', () => {
  assert.doesNotMatch(mobileMenus, /#hud|#touch-controls|#touch-steer-zone|finish-cinematic/);
});
