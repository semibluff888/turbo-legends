// Deterministic pseudo-random number generation.
// A seeded RNG keeps races reproducible, which is what makes the headless
// simulation tests meaningful — the same seed must always produce the same race.

/** mulberry32: small, fast, good enough statistical quality for gameplay. */
export function makeRng(seed = 0x9e3779b9) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash a string into a 32-bit seed so tracks/characters can seed by name. */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Deterministically derive an independent 32-bit child seed from a race seed
 * and a stable namespace. Consumers that use different namespaces cannot
 * perturb one another by drawing a different number of random values.
 */
export function deriveSeed(seed, namespace) {
  const base = typeof seed === 'string' ? seed : String(seed >>> 0);
  return hashSeed(`${base}\u0000${String(namespace)}`);
}

/** Create an independent named RNG stream derived from a parent seed. */
export function deriveRng(seed, namespace) {
  return new Rng(deriveSeed(seed, namespace));
}

/**
 * Wraps a raw `next()` function with the sampling helpers gameplay code wants.
 * Every consumer should take one of these rather than calling Math.random(),
 * so that a race can be replayed exactly.
 */
export class Rng {
  constructor(seed = 12345) {
    this.seed = typeof seed === 'string' ? hashSeed(seed) : seed >>> 0;
    this._next = makeRng(this.seed);
  }

  /** Uniform float in [0,1). */
  float() {
    return this._next();
  }

  /** Uniform float in [min,max). */
  range(min, max) {
    return min + this._next() * (max - min);
  }

  /** Uniform integer in [min,max] inclusive. */
  int(min, max) {
    return Math.floor(min + this._next() * (max - min + 1));
  }

  /** True with probability p. */
  chance(p) {
    return this._next() < p;
  }

  /** Uniformly pick one element. Returns undefined for an empty array. */
  pick(arr) {
    if (!arr || arr.length === 0) return undefined;
    return arr[Math.floor(this._next() * arr.length)];
  }

  /**
   * Weighted pick. `entries` is an array of [value, weight] pairs, or an
   * object mapping value -> weight. Non-positive weights are skipped.
   * Returns null when nothing has positive weight.
   */
  weighted(entries) {
    const pairs = Array.isArray(entries) ? entries : Object.entries(entries);
    let total = 0;
    for (const [, w] of pairs) if (w > 0) total += w;
    if (total <= 0) return null;
    let r = this._next() * total;
    for (const [value, w] of pairs) {
      if (w <= 0) continue;
      r -= w;
      if (r <= 0) return value;
    }
    // Floating point drift — return the last positively-weighted entry.
    for (let i = pairs.length - 1; i >= 0; i--) if (pairs[i][1] > 0) return pairs[i][0];
    return null;
  }

  /** In-place Fisher-Yates shuffle. Returns the same array. */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this._next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** Restart the sequence from the original seed. */
  reset() {
    this._next = makeRng(this.seed);
  }
}
