#!/usr/bin/env node
"use strict";
/**
 * SIZING — what the SAME R25 tickets earn and risk at other contract counts (read-only; linear rescale of each ticket's per-contract
 * ledger pnl, which is exact because the $1.30 entry commission and the credit both scale with contracts; no change in fill quality
 * with size is modelled — at 0DTE ETF size this is optimistic for crossing above ~10 contracts and irrelevant at 1-6).
 * Reports $ over the sample, $/session, the session-clustered t (size-invariant), a 95% interval on $/session, worst day, 5th-percentile day,
 * max drawdown of the daily series, and the structural one-side worst case against the $2,000 daily halt (lib/risk-policy.js).
 *   node backend/profit-program/options-sizing.js
 * Writes backend/data/profit-program/options-sizing.json
 */
const C = require("./_opt-common.js");
const { $, f } = C;
const L = C.ledger();
const T = L.signals.filter(C.isR25).map((t) => ({ day: C.etDay(t.openedAt), n: t.contracts || 1, per: t.pnl / (t.contracts || 1), right: t.obs.optCall ? "C" : "P",
  maxLossPerCt: (t.obs.width - t.entry) * 100 + 1.3, sym: t.sym }));
const HALT = 2000;
function run(label, R) {
  const days = [...new Set(R.map((r) => r.day))].sort();
  console.log(`\n== ${label}: ${R.length} wings, ${days.length} sessions, ${(R.length / days.length).toFixed(2)} wings/session`);
  console.log(`${"contracts".padEnd(9)} ${"total".padStart(8)} ${"$/sess".padStart(7)} ${"95% CI $/sess".padStart(17)} ${"t".padStart(5)} ${"$/month".padStart(8)} ${"worst day".padStart(9)} ${"5th pct".padStart(8)} ${"max DD".padStart(8)} ${"1-side worst".padStart(12)} ${"vs $2k halt".padStart(11)}`);
  const rows = [];
  for (const c of [1, 2, 3, 4, 5, 6, 8]) {
    const day = days.map((d) => C.sum(R.filter((r) => r.day === d).map((r) => r.per * c)));
    const m = C.mean(day), se = C.sd(day) / Math.sqrt(day.length), t = C.tOf(day);
    let cum = 0, peak = 0, dd = 0; for (const x of day) { cum += x; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
    const sorted = [...day].sort((a, b) => a - b), p5 = sorted[Math.floor(0.05 * sorted.length)];
    const oneSide = Math.max(...days.map((d) => ["P", "C"].map((s) => C.sum(R.filter((r) => r.day === d && r.right === s).map((r) => r.maxLossPerCt * c))).reduce((a, b) => Math.max(a, b), 0)));
    const row = { c, total: C.sum(day), perSession: m, ciLo: m - 1.96 * se, ciHi: m + 1.96 * se, t, perMonth: m * 21, worst: Math.min(...day), p5, maxDD: dd, oneSideWorst: oneSide };
    rows.push(row);
    console.log(`${String(c).padEnd(9)} ${$(row.total).padStart(8)} ${$(m).padStart(7)} ${("[" + $(row.ciLo) + ", " + $(row.ciHi) + "]").padStart(17)} ${f(t).padStart(5)} ${$(row.perMonth).padStart(8)} ${$(row.worst).padStart(9)} ${$(p5).padStart(8)} ${$(-dd).padStart(8)} ${("-$" + Math.round(oneSide)).padStart(12)} ${(oneSide >= HALT ? "ABOVE" : "inside").padStart(11)}`);
  }
  return { sessions: days.length, wings: R.length, rows };
}
console.log("R25 SIZING — same tickets, other contract counts (per-contract ledger pnl x c)");
const out = { all: run("all 35 sessions (mixed 1/3/4 contracts rescaled)", T), fourCtEra: run("4-contract era only (09-14 onward)", T.filter((r) => r.day >= "2026-09-14")) };
console.log("\nreading: size scales dollars AND the worst day by the same factor; the t does not move. If the edge is zero, a larger size is a larger variance; if it is the sample's +$/ct, it is the same sign at every size.");
console.log("wrote " + C.writeOut("options-sizing.json", out));
