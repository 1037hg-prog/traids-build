"use strict";
// draft-tradeable-book-bar.cjs  (fund discounts, tradeable-book draft, 2026-10-12)
//
// The bar table for docs/fund-discounts/2026-10-12/draft-tradeable-book.md. READS NO DATA: it simulates noise only.
// It is taken ONCE. A second run prints the saved table and draws nothing: re-drawing a bar until it comes out lower is
// loosening it (docs/procedures/register-a-test.md, step 4).
//
// For each family size (variants 1..4) and each month count the draft uses, three numbers and their maximum:
//   a  the house call exactly as the procedure gives it: nullBar({ variants, n }).p95        (no seed, 5,000 trials)
//   b  the same function with a fixed seed, so anyone can reproduce it: nullBar({ variants, n, trials: 20000, rng })
//   c  the 95th percentile of the best-of-`variants` NEWEY-WEST lag-3 t on the same uniform noise (fixed seed, 50,000 trials),
//      because the draft's statistic is a Newey-West lag-3 t over calendar months and that t has slightly fatter tails than a plain t
//   bar = the largest of the three, rounded UP to three decimals.
//
// Run (Git Bash or PowerShell, from the repo root):   node docs/fund-discounts/2026-10-12/draft-tradeable-book-bar.cjs
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..", "..", "..");
const { nullBar } = require(path.join(ROOT, "backend", "lib", "null-bar.js"));
const { writeJsonAtomic } = require(path.join(ROOT, "backend", "lib", "atomic-write.js"));
const OUT = path.join(__dirname, "draft-tradeable-book-bar.json");

function show(t) {
  console.log(`bar table taken ${t.takenAt} (seed ${t.seed}); statistic: ${t.statistic}`);
  console.log("span              months  variants   a nullBar   b seeded   c NW-lag3   BAR");
  for (const r of t.rows) console.log(`${r.span.padEnd(17)} ${String(r.n).padStart(6)}  ${String(r.variants).padStart(8)}   ${r.a.toFixed(3).padStart(9)}  ${r.b.toFixed(3).padStart(9)}  ${r.c.toFixed(3).padStart(9)}   ${r.bar.toFixed(3)}`);
}
if (fs.existsSync(OUT)) {
  console.log("ALREADY TAKEN - nothing drawn. The saved table:");
  show(JSON.parse(fs.readFileSync(OUT, "utf8")));
  process.exit(0);
}

function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
/** Newey-West t of a mean, Bartlett weights, lag L (L = 1 reproduces backend/r313-ibs-etfs.js nwT). */
function nwT(a, L) {
  const n = a.length; let m = 0; for (let i = 0; i < n; i++) m += a[i]; m /= n;
  let g0 = 0; for (let i = 0; i < n; i++) g0 += (a[i] - m) * (a[i] - m); g0 /= n;
  let v = g0;
  for (let l = 1; l <= L; l++) { let c = 0; for (let i = l; i < n; i++) c += (a[i] - m) * (a[i - l] - m); v += 2 * (1 - l / (L + 1)) * c / n; }
  if (!(v > 0)) v = g0;
  return v > 0 ? m / Math.sqrt(v / n) : 0;
}
const SEED = 20261012, LAG = 3, MAXV = 4, NW_TRIALS = 50000, SEEDED_TRIALS = 20000;
const SPANS = [["holdout", 177], ["discovery", 108], ["pooled (report)", 285]];
const up3 = (x) => Math.ceil(x * 1000 - 1e-9) / 1000;
const rows = [];
for (const [span, n] of SPANS) {
  // c: one stream of trials; variant v's bar is the p95 of the max over the first v samples of each trial
  const rng = mulberry32(SEED + n), maxes = Array.from({ length: MAXV }, () => new Float64Array(NW_TRIALS)), s = new Float64Array(n);
  for (let t = 0; t < NW_TRIALS; t++) {
    let best = -Infinity;
    for (let v = 0; v < MAXV; v++) { for (let i = 0; i < n; i++) s[i] = rng() * 2 - 1; const tv = nwT(s, LAG); if (tv > best) best = tv; maxes[v][t] = best; }
  }
  for (let v = 1; v <= MAXV; v++) {
    const sorted = Array.from(maxes[v - 1]).sort((x, y) => x - y), c = sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))];
    const a = nullBar({ variants: v, n }).p95;
    const b = nullBar({ variants: v, n, trials: SEEDED_TRIALS, rng: mulberry32(SEED + 1000 * v + n) }).p95;
    rows.push({ span, n, variants: v, a: +a.toFixed(4), b: +b.toFixed(4), c: +c.toFixed(4), bar: up3(Math.max(a, b, c)) });
  }
}
const table = { what: "Bar table for the tradeable-book fund-discount draft. Noise simulation only; no data read.", takenAt: new Date().toISOString(), seed: SEED,
  statistic: `Newey-West t, Bartlett weights, lag ${LAG}, over calendar months`, unit: "months",
  columns: { a: "nullBar({variants,n}).p95, the house call, unseeded, 5,000 trials", b: `nullBar({variants,n,trials:${SEEDED_TRIALS},rng}).p95, seeded`, c: `best-of-variants Newey-West lag-${LAG} t on uniform noise, p95, ${NW_TRIALS} trials, seeded`, bar: "max(a,b,c) rounded up to 3 decimals" },
  rows };
writeJsonAtomic(OUT, table);
show(table);
