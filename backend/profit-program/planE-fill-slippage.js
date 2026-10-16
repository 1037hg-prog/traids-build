#!/usr/bin/env node
"use strict";
/**
 * PLAN E - what the BOOK's paper fills cost against the price the decision was made on. READ-ONLY; offline (scoreboard JSON + cache).
 *   node backend/profit-program/planE-fill-slippage.js
 * For every broker-fill [F] ETF order in the scoreboard trade log: fill price vs (a) the decision close (the prior session's close = the price the
 * model assumes) and (b) that day's SIP official-open print. Signed so a positive number is a COST (buys filled above, sells filled below).
 * Paper fills are simulated by Alpaca; this measures the paper gap, not a live-account gap. n is tiny (the BOOK started 2026-09-30): context only.
 * Prices are RAW (adjustment=raw, one small GET) because the fills are raw prices; the model cache is dividend-adjusted and would show SGOV's monthly dividend as slippage.
 */
const { fetchBars } = require("../lib/alpaca-bars.js");
const fs = require("fs"), path = require("path");
const M = require("./planE-model.js");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const sb = JSON.parse(fs.readFileSync(path.join(M.BACKEND, "data", "planE-paper-scoreboard.json"), "utf8"));
let RAW = {};
const bar = (s, d) => (RAW[s] || []).find((b) => b.t.slice(0, 10) === d), prevBar = (s, d) => { const a = RAW[s] || [], i = a.findIndex((b) => b.t.slice(0, 10) === d); return i > 0 ? a[i - 1] : null; };
const rows = [];
async function main() {
  RAW = (await fetchBars(["QQQ", "SPY", "EFA", "GLD", "DBMF", "JAAA", "SGOV"], { start: "2026-09-24", end: new Date(Date.now() - 20 * 60e3).toISOString(), feed: "sip", adjustment: "raw", quiet: true, requireAll: false })).bars;
  run();
}
function add(t, side, e) { if (!e || e.tag !== "F") return; const b = bar(t.sym, e.date), pb = prevBar(t.sym, e.date); if (!b || !pb) return; const sgn = side === "buy" ? 1 : -1; rows.push({ sym: t.sym, side, date: e.date, time: e.time, qty: t.qty, fill: e.px, prevClose: pb.c, open: b.o, costVsCloseBps: +(sgn * 1e4 * (e.px / pb.c - 1)).toFixed(1), costVsOpenBps: +(sgn * 1e4 * (e.px / b.o - 1)).toFixed(1), notional: +(t.qty * e.px).toFixed(0), costVsCloseUsd: +(sgn * t.qty * (e.px - pb.c)).toFixed(2), costVsOpenUsd: +(sgn * t.qty * (e.px - b.o)).toFixed(2) }); }
function run() {
for (const t of sb.trades) if (t.leg === "etf") { add(t, "buy", t.entry); add(t, "sell", t.exit); }
console.log("PLAN E ETF paper fills vs the decision close and vs the SIP open (positive = cost)");
console.log("sym   side  date        time   qty   fill      prev close   SIP open   vs close bp   vs open bp   notional");
for (const r of rows) console.log(`${r.sym.padEnd(5)} ${r.side.padEnd(4)}  ${r.date}  ${r.time}  ${String(+r.qty.toFixed(2)).padStart(4)}  ${String(r.fill).padStart(8)}  ${String(r.prevClose).padStart(10)}  ${String(r.open).padStart(9)}   ${String(r.costVsCloseBps).padStart(8)}     ${String(r.costVsOpenBps).padStart(8)}    $${r.notional.toLocaleString()}`);
const nt = rows.reduce((s, r) => s + r.notional, 0), wc = rows.reduce((s, r) => s + r.costVsCloseBps * r.notional, 0) / nt, wo = rows.reduce((s, r) => s + r.costVsOpenBps * r.notional, 0) / nt;
console.log(`notional-weighted: vs decision close ${wc.toFixed(1)} bp, vs SIP open ${wo.toFixed(1)} bp over ${rows.length} fills / $${nt.toLocaleString()} traded (decision-close gap is overnight drift + open slippage; the model assumes 0 and 5 bp per trade)`);
console.log(`dollars: vs close ${rows.reduce((s, r) => s + r.costVsCloseUsd, 0).toFixed(2)}, vs open ${rows.reduce((s, r) => s + r.costVsOpenUsd, 0).toFixed(2)}`);
writeJsonAtomic(path.join(M.BACKEND, "data", "profit-program", "planE-fill-slippage.json"), { spec: "planE-fill-slippage-v1", rows, weightedVsCloseBps: +wc.toFixed(2), weightedVsOpenBps: +wo.toFixed(2) });
}
main().catch((e) => { console.error("planE-fill-slippage FAILED:", e.message); process.exit(1); });
