"use strict";
/**
 * NULL BAR — the house best-of-N bar (backend/lib/null-bar.js nullBar + tOf, 2026-08-14), ported VERBATIM in its arithmetic for the
 * research server, where backend/ is not visible to the factory. 2026-10-09 (docs/server/wave6-agents). The selftest proves this copy
 * returns exactly what the home file returns for the same seeded rng (the package selftest loads both), so the F bar is the R bar.
 * The only addition is a seeded rng (mulberry32), so a registration's bar is reproducible from its registration alone.
 */
function tOf(a) {
  const n = a.length;
  if (n < 2) return 0;
  const m = a.reduce((s, x) => s + x, 0) / n;
  const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(v);
  return sd > 0 ? m / (sd / Math.sqrt(n)) : 0;
}
function nullBar({ variants = 1, n = 20, trials = 5000, rng = Math.random } = {}) {
  if (!(variants >= 1) || !(n >= 3)) throw new Error("nullBar needs variants>=1 and n>=3");
  const maxes = new Array(trials);
  for (let t = 0; t < trials; t++) {
    let best = -Infinity;
    for (let v = 0; v < variants; v++) {
      const sample = new Array(n);
      for (let i = 0; i < n; i++) sample[i] = rng() * 2 - 1;
      const tv = tOf(sample);
      if (tv > best) best = tv;
    }
    maxes[t] = best;
  }
  maxes.sort((a, b) => a - b);
  const q = (p) => maxes[Math.min(maxes.length - 1, Math.floor(p * maxes.length))];
  return { variants, n, trials, median: q(0.50), p90: q(0.90), p95: q(0.95), p99: q(0.99), _sorted: maxes };
}
/** mulberry32: a small seeded PRNG in [0,1) */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/**
 * The F registration bar: max(2.0, the best-of-V p95) — 2.0 is the house's naive floor for ONE pre-specified test, the p95 of the max
 * over V variants is the honest bar for a search (R313 pattern). Seeded and fixed n so the same registration always gets the same bar.
 */
function fBar(variants, { n = 60, trials = 20000, seed = 20261009 } = {}) {
  const b = nullBar({ variants, n, trials, rng: mulberry32(seed + variants) });
  return { bar: +Math.max(2.0, b.p95).toFixed(3), p95: +b.p95.toFixed(4), variants, n, trials, seed: seed + variants, method: "max(2.0, nullBar p95 best-of-variants; seeded mulberry32) — backend/lib/null-bar.js arithmetic" };
}
module.exports = { tOf, nullBar, mulberry32, fBar };
