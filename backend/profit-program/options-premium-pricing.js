#!/usr/bin/env node
"use strict";
/**
 * IS THERE ANY PREMIUM LEFT AFTER COSTS? (read-only; exploratory beyond the layer table)
 * For each R25 wing (live ledger rows) and each archive wing (R116's frozen 501-session replay, backend/data/r116-zero-dte-replay-wings.json):
 *   gross premium   = (credit at MID  - intrinsic paid at expiry) x 100          what the seller earns before touching a spread
 *   after crossing  = (credit at CROSS - intrinsic) x 100                         what the booked fill gives up
 *   after fees      = after crossing - $0.65 x 2 legs                             the ledger pnl, per contract
 * per underlying, with a session-clustered t on the per-session sum. Also: implied loss probability (mean |short delta|) against the
 * realised frequency of finishing in the money, and credit/width (the break-even loss severity) against realised mean intrinsic/width.
 * Archive caveat (R116's own): history has trade prints, no quotes, so its crossing is BORROWED from R25's live record, not measured;
 * the archive "credit" is a trade-print credit, used here as the mid layer. Live rows measure creditMid and creditCross directly.
 *   node backend/profit-program/options-premium-pricing.js
 * Writes backend/data/profit-program/options-premium-pricing.json
 */
const fs = require("fs"), path = require("path");
const C = require("./_opt-common.js");
const { $, f } = C;
const FEE_PER_CONTRACT = 1.3;        // $0.65 x 2 legs, the ledger's own commission at entry (options-settle.js)
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const L = C.ledger();

function liveRows(pred = C.isR25) {
  const out = []; let bad = 0;
  for (const t of L.signals.filter(pred)) {
    if (t.reason !== "expiry") continue;   // wing-cap rows have no settle-based intrinsic (they are graded elsewhere)
    const o = t.obs, n = t.contracts || 1, S = o.settleUnder, K = +o.shortK, W = o.width;
    if (!(Number.isFinite(S) && Number.isFinite(K) && W > 0)) continue;
    const intr = o.optCall ? clamp(S - K, 0, W) : clamp(K - S, 0, W);
    const pnlPer = t.pnl / n, check = (t.entry - intr) * 100 - FEE_PER_CONTRACT;
    if (Math.abs(pnlPer - check) > 0.011) bad++;
    out.push({ day: C.etDay(t.openedAt), sym: t.sym, right: o.optCall ? "C" : "P", mid: o.creditMid, cross: t.entry, intr, width: W, delta: Math.abs(o.shortDelta), spot: null, K,
      gross: (o.creditMid - intr) * 100, afterCross: (t.entry - intr) * 100, net: pnlPer, itm: intr > 0, full: intr >= 0.999 * W });
  }
  return { rows: out, knownAnswerMismatches: bad };
}
function archiveRows() {
  const A = JSON.parse(fs.readFileSync(path.join(C.DATA, "r116-zero-dte-replay-wings.json"), "utf8")); let bad = 0;
  const out = [];
  for (const w of A) {
    const W = w.width, K = w.shortStrike, S = w.settle; if (!(W > 0 && Number.isFinite(S))) continue;
    const intr = w.right === "C" ? clamp(S - K, 0, W) : clamp(K - S, 0, W);
    const check = (w.creditCross - intr) * 100 - FEE_PER_CONTRACT;
    if (Math.abs(w.pnl - check) > 0.011) bad++;
    out.push({ day: w.day, sym: w.u, right: w.right, mid: w.credit, cross: w.creditCross, intr, width: W, delta: Math.abs(w.shortDelta), spot: w.spot, K,
      gross: (w.credit - intr) * 100, afterCross: (w.creditCross - intr) * 100, net: w.pnl, itm: intr > 0, full: intr >= 0.999 * W, capped: w.capped });
  }
  return { rows: out, knownAnswerMismatches: bad };
}
function layer(R, key) { const s = C.bySession(R, (r) => r[key], (r) => r.day); return { mean: C.mean(R.map((r) => r[key])), perSession: s.meanPerSession, t: s.t }; }
function table(title, R, bySym = true) {
  console.log(`\n== ${title}`);
  console.log(`${"".padEnd(8)} ${"wings".padStart(5)} ${"sess".padStart(4)} | ${"mid cr".padStart(6)} ${"cross cr".padStart(8)} ${"E[intr]".padStart(7)} | ${"GROSS $/ct".padStart(10)} ${"t".padStart(5)} | ${"after cross".padStart(11)} ${"t".padStart(5)} | ${"NET $/ct".padStart(9)} ${"t".padStart(5)} | ${"impl P(ITM)".padStart(11)} ${"real ITM".padStart(8)} ${"real full".padStart(9)} | ${"cr/width".padStart(8)} ${"E[intr]/w".padStart(9)}`);
  const res = {};
  const groups = bySym ? [...new Set(R.map((r) => r.sym))].sort() : [];
  for (const g of ["ALL", ...groups]) {
    const G = g === "ALL" ? R : R.filter((r) => r.sym === g); if (G.length < 5) continue;
    const gl = layer(G, "gross"), ac = layer(G, "afterCross"), nl = layer(G, "net");
    const row = { wings: G.length, sessions: new Set(G.map((r) => r.day)).size, meanMid: C.mean(G.map((r) => r.mid)), meanCross: C.mean(G.map((r) => r.cross)), meanIntr: C.mean(G.map((r) => r.intr)),
      gross: gl, afterCross: ac, net: nl, impliedItm: C.mean(G.map((r) => r.delta)), realItm: G.filter((r) => r.itm).length / G.length, realFull: G.filter((r) => r.full).length / G.length,
      creditOverWidth: C.mean(G.map((r) => r.cross / r.width)), intrOverWidth: C.mean(G.map((r) => r.intr / r.width)) };
    res[g] = row;
    console.log(`${g.padEnd(8)} ${String(row.wings).padStart(5)} ${String(row.sessions).padStart(4)} | ${f(row.meanMid, 3).padStart(6)} ${f(row.meanCross, 3).padStart(8)} ${f(row.meanIntr, 3).padStart(7)} | ${$(gl.mean).padStart(10)} ${f(gl.t).padStart(5)} | ${$(ac.mean).padStart(11)} ${f(ac.t).padStart(5)} | ${$(nl.mean).padStart(9)} ${f(nl.t).padStart(5)} | ${(f(100 * row.impliedItm, 1) + "%").padStart(11)} ${(f(100 * row.realItm, 1) + "%").padStart(8)} ${(f(100 * row.realFull, 1) + "%").padStart(9)} | ${f(row.creditOverWidth, 3).padStart(8)} ${f(row.intrOverWidth, 3).padStart(9)}`);
  }
  return res;
}
const out = { note: "exploratory; archive crossing is borrowed (R116), live crossing is measured" };
const live = liveRows(), arch = archiveRows();
console.log(`known-answer: live rows recomputed (credit - intrinsic) x 100 - $1.30 = ledger pnl per contract: ${live.rows.length - live.knownAnswerMismatches} of ${live.rows.length} agree to the cent; archive: ${arch.rows.length - arch.knownAnswerMismatches} of ${arch.rows.length}`);
out.knownAnswer = { live: [live.rows.length, live.knownAnswerMismatches], archive: [arch.rows.length, arch.knownAnswerMismatches] };
out.live = table(`LIVE R25 wings (ledger), ${live.rows.length} wings, per CONTRACT; credit and intrinsic in $ per share`, live.rows);
out.liveSince0914 = table("LIVE R25 wings since 2026-09-14 (4-contract era; includes DIA/GLD/TLT)", live.rows.filter((r) => r.day >= "2026-09-14"));
out.archive = table(`ARCHIVE (R116 frozen replay, 2024-08-19..2026-08-18), ${arch.rows.length} wings, per CONTRACT`, arch.rows);
// R21 weekly wings (live ledger, held to expiry only): the same layers, so the friction share is comparable
{
  const r21 = liveRows(C.isR21).rows;
  const etf = r21.filter((r) => ["SPY", "QQQ", "IWM"].includes(r.sym)), oth = r21.filter((r) => !["SPY", "QQQ", "IWM"].includes(r.sym));
  out.r21Etf = table(`R21 weekly wings on SPY/QQQ/IWM (live, held to expiry, 1 contract; ${etf.length} wings)`, etf);
  out.r21Other = table(`R21 weekly wings on single names and other ETFs (live, held to expiry, 1 contract; ${oth.length} wings)`, oth, false);
}
// archive by calendar half-year, to see whether the aggregate is regime-driven
const byHalf = (r) => r.day.slice(0, 4) + (r.day.slice(5, 7) <= "06" ? "H1" : "H2");
console.log("\n== ARCHIVE by half-year (all underlyings)");
console.log(`${"".padEnd(8)} ${"wings".padStart(5)} ${"sess".padStart(4)} | ${"GROSS $/ct".padStart(10)} ${"t".padStart(5)} | ${"NET $/ct".padStart(9)} ${"t".padStart(5)} | real ITM`);
out.archiveHalves = {};
for (const h of [...new Set(arch.rows.map(byHalf))].sort()) {
  const G = arch.rows.filter((r) => byHalf(r) === h), gl = layer(G, "gross"), nl = layer(G, "net");
  out.archiveHalves[h] = { wings: G.length, gross: gl, net: nl };
  console.log(`${h.padEnd(8)} ${String(G.length).padStart(5)} ${String(new Set(G.map((r) => r.day)).size).padStart(4)} | ${$(gl.mean).padStart(10)} ${f(gl.t).padStart(5)} | ${$(nl.mean).padStart(9)} ${f(nl.t).padStart(5)} | ${f(100 * G.filter((r) => r.itm).length / G.length, 1)}%`);
}
// the friction budget in dollars at today's size (4 contracts, ~7.8 wings a session, 21 sessions a month), from the live rows
const lv = live.rows.filter((r) => r.day >= "2026-09-14"), perSess = lv.length / new Set(lv.map((r) => r.day)).size;
const gM = C.mean(lv.map((r) => r.gross)), xM = C.mean(lv.map((r) => r.gross - r.afterCross)), fM = FEE_PER_CONTRACT, nM = C.mean(lv.map((r) => r.net));
console.log(`\nFRICTION BUDGET at 4 contracts, ${perSess.toFixed(2)} wings a session, 21 sessions a month (live rows since 09-14, ${lv.length} wings):`);
const d2 = (v) => (v < 0 ? "-$" : "+$") + Math.abs(v).toFixed(2);
console.log(`  gross premium at mid ${d2(gM)} per contract-wing x 4 x ${perSess.toFixed(2)} x 21 = ${$(gM * 4 * perSess * 21)}/month`);
console.log(`  paid away crossing   ${d2(-xM)} per contract-wing -> ${$(-xM * 4 * perSess * 21)}/month`);
console.log(`  commissions (model)  ${d2(-fM)} per contract-wing -> ${$(-fM * 4 * perSess * 21)}/month`);
console.log(`  net                  ${d2(nM)} per contract-wing -> ${$(nM * 4 * perSess * 21)}/month   (check gross - crossing - fee: ${d2(gM - xM - fM)})`);
out.frictionBudget = { wingsPerSession: perSess, grossPerCt: gM, crossingPerCt: -xM, feePerCt: -fM, netPerCt: nM, grossPerMonth: gM * 4 * perSess * 21, crossingPerMonth: -xM * 4 * perSess * 21, feePerMonth: -fM * 4 * perSess * 21, netPerMonth: nM * 4 * perSess * 21 };
console.log("\nwrote " + C.writeOut("options-premium-pricing.json", out));
