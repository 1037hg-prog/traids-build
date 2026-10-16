#!/usr/bin/env node
"use strict";
/**
 * WIDE-SPREAD TWIN — SCOUT (2026-10-14). READ-ONLY, no network, writes nothing.
 * (a) the 30-100 bps flow per entry session at the mirror, recent windows, and direction mix by bucket (current era);
 * (b) candidate null bars from backend/lib/null-bar.js at a few family sizes and session counts (house form: mulberry-seeded, 20,000 trials).
 * Needs spread-buckets.out.json from: node docs/wide-spread-twin/2026-10-14/scout/spread-buckets.cjs --out
 *   node docs/wide-spread-twin/2026-10-14/scout/bars-and-flow.cjs
 */
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..", "..", "..", "..");
const { nullBar } = require(path.join(ROOT, "backend", "lib", "null-bar.js"));
const o = JSON.parse(fs.readFileSync(path.join(__dirname, "spread-buckets.out.json"), "utf8"));
const sessions = o.stampRows.filter((r) => r.signals > 0).map((r) => r.d);
console.log(`(a) 30-100 bps board signals and mirrored tickets per entry session (scout output asOf ${o.asOf})`);
console.log("   " + sessions.map((d) => `${d.slice(5)}:${o.stampRows.find((r) => r.d === d)["30-100"]}/${o.rows.filter((r) => r.d === d && r.b === "30-100").length}`).join("  ") + "   (board signals / mirrored)");
for (const from of ["2026-10-05", "2026-10-08"]) {
  const S = sessions.filter((d) => d >= from), n = sum(S.map((d) => o.stampRows.find((r) => r.d === d)["30-100"])), any = S.filter((d) => o.stampRows.find((r) => r.d === d)["30-100"] > 0).length;
  console.log(`   from ${from}: ${S.length} sessions, ${n} board signals in 30-100 (${(n / S.length).toFixed(2)}/session -> ${n ? Math.ceil(150 / (n / S.length)) : "inf"} sessions to 150); sessions with >= 1 such ticket: ${any} of ${S.length}`);
}
const dirs = {}; for (const r of o.rows.filter((x) => x.era === "current")) { const k = r.b; dirs[k] = dirs[k] || { long: 0, short: 0 }; dirs[k][r.dir > 0 ? "long" : "short"]++; }
console.log(`   current-era mirrored tickets by bucket and direction: ${JSON.stringify(dirs)}`);
function sum(a) { return a.reduce((s, v) => s + v, 0); }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
console.log(`\n(b) candidate bars: lib/null-bar.js nullBar({variants, n, trials:20000, rng:mulberry(seed)}).p95 (seed shown; a registration would fix its own seed)`);
for (const [v, why] of [[1, "one frozen band, forward data only"], [2, "two graded contrasts (e.g. 30-100 vs <30, and 30-100 alone)"], [6, "the six refusal thresholds board-cost.js tried in-sample (R86 precedent: the family is the search that produced the rule)"], [11, "six thresholds + five bucket rows of board-cost.js [4]"]]) {
  const line = [20, 30, 40, 60, 80, 100].map((n) => `n${n} ${nullBar({ variants: v, n, trials: 20000, rng: mulberry(355000 + v * 1000 + n) }).p95.toFixed(3)}`).join("  ");
  console.log(`   variants ${String(v).padStart(2)} (${why}):\n      ${line}`);
}
