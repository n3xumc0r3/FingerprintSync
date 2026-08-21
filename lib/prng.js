/**
 * Seeded PRNG — Mulberry32
 * Deterministic: same seed → same sequence every time.
 * This is the foundation of all fingerprint spoofing.
 */
class SeededPRNG {
  constructor(seed) {
    this._seed = seed | 0;
    this._state = this._seed;
  }

  /** Returns float in [0, 1) */
  next() {
    let t = (this._state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Returns integer in [min, max] inclusive */
  nextInt(min, max) {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Pick random element from array (deterministic) */
  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Shuffle array (Fisher-Yates, deterministic) */
  shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** Returns boolean with given probability */
  chance(probability) {
    return this.next() < probability;
  }

  /** Reset to initial seed */
  reset() {
    this._state = this._seed;
  }
}

// Export for both module and non-module contexts
if (typeof globalThis !== 'undefined') {
  globalThis.SeededPRNG = SeededPRNG;
}
