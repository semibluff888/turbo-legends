// Imports every module under src/ so syntax errors, bad import paths, and
// import-time crashes fail fast in CI/tests — no browser needed.
// Presentation modules must not touch the DOM at import time (see
// ARCHITECTURE.md); the tiny stubs below only paper over property *reads*.

import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

// --- Minimal browser-shaped globals (reads only, never behavior) -----------
const noop = () => {};
const fakeEl = () => ({
  addEventListener: noop, removeEventListener: noop, appendChild: noop,
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  style: {}, dataset: {}, setAttribute: noop, getAttribute: () => null,
  querySelector: () => null, querySelectorAll: () => [],
  getContext: () => null, width: 0, height: 0, innerHTML: '', textContent: '',
});
if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    addEventListener: noop, removeEventListener: noop,
    innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
    location: { href: 'http://localhost/' },
    requestAnimationFrame: noop, cancelAnimationFrame: noop,
  };
}
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    getElementById: () => null, createElement: fakeEl,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, removeEventListener: noop,
    body: fakeEl(), documentElement: fakeEl(),
    hidden: false, visibilityState: 'visible',
  };
}
if (typeof globalThis.navigator === 'undefined') {
  globalThis.navigator = { getGamepads: () => [], userAgent: 'node' };
}
globalThis.requestAnimationFrame ??= noop;

// --- Collect targets: explicit file args, or walk all of src/ ---------------
async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith('.js')) yield full;
  }
}

const args = process.argv.slice(2);
const targets = [];
if (args.length > 0) {
  for (const a of args) targets.push(join(ROOT, a));
} else {
  for await (const f of walk(SRC)) {
    // main.js is the boot entry point — it touches the DOM at import time by
    // design and only runs in a real browser.
    if (relative(SRC, f).replaceAll('\\', '/') === 'main.js') continue;
    targets.push(f);
  }
}

let failures = 0;
let count = 0;
for (const file of targets) {
  const rel = relative(ROOT, file).replaceAll('\\', '/');
  count++;
  try {
    await import(pathToFileURL(file).href);
    console.log(`  ok   ${rel}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${rel}`);
    console.error(`       ${err.constructor.name}: ${err.message.split('\n')[0]}`);
  }
}

console.log(failures === 0
  ? `\nAll ${count} modules imported cleanly.`
  : `\n${failures}/${count} modules failed to import.`);
process.exit(failures === 0 ? 0 : 1);
