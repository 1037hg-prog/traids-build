"use strict";
/**
 * WORST-DAY SEALED LEDGER — THE SYNTHETIC BARS. The only input the known answers use, made here from a seeded generator so the
 * tests need no market data, no file and no network. It requires NOTHING, so a fixture can be written or read without loading any
 * of the code under test.
 *
 * THE SERIES. `n` consecutive weekdays from `start`. The last `stormLast` sessions carry four times the volatility and a downward
 * drift; everything before them is calm with a small upward drift. close and adjClose are the same number (a fixture pays no
 * dividend). Two shapes are used by the tests: the default, whose last bar is in a drawdown deep enough and volatile enough to trip
 * both storm flags, and `calmOnly: true`, whose last bar trips neither.
 *
 * THESE ARE NOT PRICES. Nothing here is SPY, nothing here is a real session, and no number in it came from a market. It exists so a
 * known answer can be written down and checked, and for no other purpose.
 */
const DAY = 86400000;

/** the small deterministic generator the repo already uses in wf.js */
function mulberry32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
/** Box-Muller, one draw per call (two uniforms each), so the series depends only on the seed */
function gauss(rng) { const u = Math.max(rng(), 1e-12), v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
/** n consecutive weekdays from `start` */
function weekdaysFrom(start, n) {
  const out = []; let ms = Date.parse(start + "T12:00:00Z");
  while (out.length < n) { const g = new Date(ms).getUTCDay(); if (g !== 0 && g !== 6) out.push(new Date(ms).toISOString().slice(0, 10)); ms += DAY; }
  return out;
}
function syntheticBars({ n = 340, seed = 19, start = "2025-02-24", stormLast = 40, calmOnly = false } = {}) {
  const rng = mulberry32(seed), d = weekdaysFrom(start, n), out = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const stormy = !calmOnly && i >= n - stormLast;
    const vol = stormy ? 0.024 : 0.006, drift = stormy ? -0.0035 : 0.00045;
    px *= Math.exp(drift + vol * gauss(rng));
    out.push({ d: d[i], c: +px.toFixed(6), a: +px.toFixed(6) });
  }
  return out;
}

module.exports = { mulberry32, gauss, weekdaysFrom, syntheticBars };
