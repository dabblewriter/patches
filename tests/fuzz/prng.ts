/**
 * Deterministic seeded PRNG (mulberry32) for the convergence fuzz suite.
 *
 * Every random decision in a fuzz run flows through one PRNG instance seeded from the
 * test's seed, so a given seed always produces the byte-identical action script.
 * `Math.random` and unseeded `Date.now` are never used (the suite runs under fake
 * timers and advances the clock from this PRNG).
 */
export class PRNG {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
    if (this.s === 0) this.s = 0x9e3779b9;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [0, maxExclusive). */
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  /** Integer in [min, max] (inclusive). */
  intBetween(min: number, max: number): number {
    return min + this.int(max - min + 1);
  }

  /** Pick a random element from a non-empty array. */
  pick<T>(items: T[]): T {
    return items[this.int(items.length)];
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /**
   * Pick an index from a weight table. Weights are relative (not normalized).
   * Returns the index of the chosen weight.
   */
  weighted(weights: number[]): number {
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      roll -= weights[i];
      if (roll < 0) return i;
    }
    return weights.length - 1;
  }
}
