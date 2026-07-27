// Small, dependency-free math helpers shared by simulation and rendering.
// Everything here is pure: no THREE, no DOM. Safe to import from Node tests.

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

/** Inverse lerp, clamped to [0,1]. Returns 0 when the range is degenerate. */
export function invLerp(a, b, v) {
  if (a === b) return 0;
  return clamp01((v - a) / (b - a));
}

/** Remap v from [inA,inB] to [outA,outB], clamped. */
export function remap(v, inA, inB, outA, outB) {
  return lerp(outA, outB, invLerp(inA, inB, v));
}

/**
 * Frame-rate independent exponential smoothing.
 * `lambda` is the rate constant: higher converges faster. dt in seconds.
 */
export function damp(current, target, lambda, dt) {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/** Move `current` toward `target` by at most `maxDelta`. */
export function moveTowards(current, target, maxDelta) {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

export function smoothstep(edge0, edge1, x) {
  const t = invLerp(edge0, edge1, x);
  return t * t * (3 - 2 * t);
}

export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t) => t * t * t;
export const easeOutBack = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Shortest signed angular difference from `from` to `to`, in (-PI, PI]. */
export function angleDelta(from, to) {
  return wrapAngle(to - from);
}

/** Angle interpolation along the shortest arc. */
export function lerpAngle(a, b, t) {
  return a + angleDelta(a, b) * t;
}

/** Frame-rate independent angle smoothing along the shortest arc. */
export function dampAngle(current, target, lambda, dt) {
  return current + angleDelta(current, target) * (1 - Math.exp(-lambda * dt));
}

/** Positive modulo: result always in [0, m). */
export function pmod(v, m) {
  const r = v % m;
  return r < 0 ? r + m : r;
}

/**
 * Signed shortest difference between two positions on a loop of length `m`.
 * Result is in (-m/2, m/2]. Useful for comparing arc-length positions on a
 * closed track without worrying about the wrap at the start/finish line.
 */
export function loopDelta(from, to, m) {
  let d = pmod(to - from, m);
  if (d > m * 0.5) d -= m;
  return d;
}

/** Format seconds as M:SS.mmm — used by the HUD and results screen. */
export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--.---';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/** Ordinal suffix for race positions: 1st, 2nd, 3rd, 4th... */
export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
