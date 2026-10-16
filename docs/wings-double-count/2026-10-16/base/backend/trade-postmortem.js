#!/usr/bin/env node
/**
 * TRAIDS — Trade Post-Mortem: what actually happened in our own trades, and what
 * (if anything) would have made them better — using ONLY counterfactuals we logged
 * at the time (no hindsight rules invented after seeing outcomes).
 *
 * Sections:
 *   1. ERA SPLIT       — pre-fix (contaminated, context only) vs clean record
 *   2. EXIT ANATOMY    — where R actually comes from: target / stop / close / manual
 *   3. EXIT-RULE A/B   — the PRE-REGISTERED counterfactual we logged per trade:
 *                        rMult (ride to 2R) vs rMultTP (take profit at 1R)
 *   4. WHO/WHAT        — class × direction (beta decomposition), strategy, conf deciles
 *   5. CLUSTERING      — day concentration: how few independent bets were these?
 *   6. vs MARKET       — trades with a logged SPY benchmark: did we beat the day?
 *
 * HONEST FRAME: pre-fix data is biased toward losses (resurrection bug), everything
 * is gross of commissions/slippage, and n is small. This is DIAGNOSIS, not evidence.
 * The clean-era rerun of this script (weekly) is the actual improvement loop.
 *
 * Usage: node backend/trade-postmortem.js
 */
const fs = require("fs"), path = require("path");
const CLEAN_EPOCH = new Date("2026-07-10T00:00:00").getTime();
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "trade_log.json"), "utf8"));
const all = (Array.isArray(raw) ? raw : raw.log || []).filter(t => Number.isFinite(t.rMult));
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const pad = (s, n) => String(s).padEnd(n);
const stat = (set, lbl) => {
  if (!set.length) { console.log("    " + pad(lbl, 26) + "n 0"); return; }
  const r = set.map(t => t.rMult);
  console.log("    " + pad(lbl, 26) + pad("n " + r.length, 8) + pad("win " + (r.filter(v => v > 0).length / r.length * 100).toFixed(0) + "%", 10)
    + pad("avg " + (mean(r) >= 0 ? "+" : "") + mean(r).toFixed(3) + "R", 13) + "tot " + (r.reduce((s, v) => s + v, 0) >= 0 ? "+" : "") + r.reduce((s, v) => s + v, 0).toFixed(1) + "R");
};

console.log(`\n  TRAIDS — Trade Post-Mortem · ${all.length} priced trades on file\n`);

// 1. era split
console.log("  1) ERA SPLIT  (pre-fix outcomes are loss-biased by the resurrection bug — context, not evidence)");
const clean = all.filter(t => t.closedAt >= CLEAN_EPOCH), dirty = all.filter(t => t.closedAt < CLEAN_EPOCH);
stat(dirty, "pre-fix (contaminated)"); stat(clean, "CLEAN record");
console.log("");

// 2. exit anatomy
console.log("  2) EXIT ANATOMY — where the R actually came from");
const reasons = [...new Set(all.map(t => t.reason || "?"))];
for (const rs of reasons.sort()) stat(all.filter(t => (t.reason || "?") === rs), rs);
// 2026-08-30: the live ratchet ended reason "target"; targetTouched + ratchet reasons are the successors
const targets = all.filter(t => t.targetTouched || t.reason === "target" || t.reason === "ratchet" || t.reason === "gap-ratchet"), stops = all.filter(t => t.reason === "stop");
console.log(`    → targets ${targets.length} vs stops ${stops.length}: hit-rate ratio ${(targets.length / Math.max(1, targets.length + stops.length) * 100).toFixed(0)}% of decided trades reached 2R first`);
console.log("");

// 3. exit-rule A/B (pre-registered counterfactual logged at settle time)
const ab = all.filter(t => Number.isFinite(t.rMultTP));
if (ab.length) {
  console.log("  3) EXIT-RULE A/B — same trades, two exits we logged in parallel");
  stat(ab, "ride to 2R (as traded)");
  console.log("    " + pad("take-profit at 1R", 26) + pad("n " + ab.length, 8) + pad("win " + (ab.filter(t => t.rMultTP > 0).length / ab.length * 100).toFixed(0) + "%", 10)
    + pad("avg " + (mean(ab.map(t => t.rMultTP)) >= 0 ? "+" : "") + mean(ab.map(t => t.rMultTP)).toFixed(3) + "R", 13) + "tot " + (ab.map(t => t.rMultTP).reduce((s, v) => s + v, 0) >= 0 ? "+" : "") + ab.map(t => t.rMultTP).reduce((s, v) => s + v, 0).toFixed(1) + "R");
  const diff = mean(ab.map(t => t.rMultTP - t.rMult));
  console.log(`    → 1R-TP ${diff >= 0 ? "beats" : "loses to"} 2R-ride by ${Math.abs(diff).toFixed(3)}R/trade on this sample (paired, same trades)`);
  console.log("");
}

// 4. who/what
console.log("  4) CLASS × DIRECTION (the beta decomposition)");
for (const cls of [...new Set(all.map(t => t.cls))].sort())
  for (const d of [1, -1]) stat(all.filter(t => t.cls === cls && t.dir === d), `${cls} ${d > 0 ? "LONG" : "SHORT"}`);
console.log("\n  4b) STRATEGY");
for (const st of [...new Set(all.map(t => t.strategy || "?"))].sort()) stat(all.filter(t => (t.strategy || "?") === st), st);
console.log("\n  4c) CONFIDENCE (quartiles of logged conf)");
const withConf = all.filter(t => t.conf != null).map(t => ({ ...t, cp: t.conf <= 1 ? t.conf * 100 : t.conf })).sort((a, b) => a.cp - b.cp);
for (let q = 0; q < 4; q++) {
  const seg = withConf.slice(Math.floor(q * withConf.length / 4), Math.floor((q + 1) * withConf.length / 4));
  if (seg.length) stat(seg, `Q${q + 1} (conf ${seg[0].cp.toFixed(0)}–${seg[seg.length - 1].cp.toFixed(0)}%)`);
}
console.log("");

// 5. clustering
console.log("  5) DAY CLUSTERING — how few independent bets were these really?");
const byDay = {};
for (const t of all) (byDay[new Date(t.closedAt).toDateString()] = byDay[new Date(t.closedAt).toDateString()] || []).push(t.rMult);
const days = Object.entries(byDay).map(([d, rs]) => ({ d, n: rs.length, tot: rs.reduce((s, v) => s + v, 0) })).sort((a, b) => a.tot - b.tot);
console.log(`    ${all.length} trades settled on ${days.length} days (avg ${(all.length / days.length).toFixed(1)}/day — same-day trades are correlated)`);
console.log("    worst days: " + days.slice(0, 3).map(x => `${x.d.slice(4, 10)} ${x.tot.toFixed(1)}R(n${x.n})`).join(" · "));
console.log("    best days:  " + days.slice(-3).map(x => `${x.d.slice(4, 10)} +${x.tot.toFixed(1)}R(n${x.n})`).join(" · "));
const totR = all.reduce((s, t) => s + t.rMult, 0);
console.log(`    → the 3 worst days sum ${days.slice(0, 3).reduce((s, x) => s + x.tot, 0).toFixed(1)}R of a ${totR.toFixed(1)}R total — a handful of correlated days IS the track record`);
console.log("");

// 6. vs market benchmark where logged
const bench = all.filter(t => t.mktRet != null);
if (bench.length) {
  console.log("  6) vs THE MARKET (trades with a logged same-day SPY return)");
  const alpha = bench.map(t => (t.rMult * (t.stopDist && t.entry ? t.stopDist / t.entry : 0.014) * 100 * t.dir * t.dir) - t.mktRet * t.dir);
  const longs = bench.filter(t => t.dir > 0), shorts = bench.filter(t => t.dir < 0);
  console.log(`    n ${bench.length} · avg SPY on settle days ${mean(bench.map(t => t.mktRet)).toFixed(2)}% · long trades ${longs.length} avg ${mean(longs.map(t => t.rMult)).toFixed(2)}R · short ${shorts.length} avg ${mean(shorts.map(t => t.rMult)).toFixed(2)}R`);
  console.log(`    → if longs win when SPY is up and shorts lose, the book is expressing BETA, not selection`);
}

console.log(`\n  WHAT THIS FEEDS: rerun weekly on the CLEAN era. Improvement = changing ONE pre-registered thing`);
console.log(`  at a time (exit rule, threshold, class mix) when the paired A/B or the ledger's CI says so —`);
console.log(`  never rewriting rules to fit last week's table. The ML loop retrains on the same clean data`);
console.log(`  (walk-forward, judged OOS) once a few hundred observer-tagged trades exist.\n`);
