#!/usr/bin/env node
"use strict";
/**
 * PLAN E - ETF sub-book rebalance rule and what it costs in dollars. READ-ONLY on the repo; offline (cache).
 *   node backend/profit-program/planE-rebalance.js
 *
 * The sub-book is the BOOK's: QQQ 15, SPY 15, EFA 10, GLD 10 (10-month trend; OUT -> parked in SGOV), DBMF 15, JAAA 8 of a $100k Plan E (= $73k), SGOV the cash pool.
 * Window 2020-10-20..2026-10-09 (JAAA's history). Returns = SIP adjusted closes (total return). Trades are assumed at the decision close (the repo model's
 * convention; the live BOOK fills at the next open). Policies:
 *   LIVE      month-end: every sleeve to target; other days: any sleeve outside max(10% of target, $500) goes back to target     (book-etf-rebalancer.js)
 *   FLIPONLY  month-end: only sleeves whose 10-month signal FLIPPED trade; other days: the same 10% / $500 band                   (RECOMMENDATION.md, +0.09 %/yr on record)
 *   BANDONLY  never reset on month-end except for flips... identical to FLIPONLY here; kept out. (see note)
 * Funding rule as live: sells go first into the SGOV pool; buys are limited to the pool (pro rata) - RECOMMENDATION.md's "known limit".
 * Cost: c bps per $ traded on every non-SGOV leg; the SGOV leg at 1 bp. c = 0 / 5 / 10 (bracketing the 6.1 / 9.6 bp break-evens in RECOMMENDATION.md).
 * NOT modelled: whole-share rounding, next-open fills.
 */
const path = require("path");
const M = require("./planE-model.js");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const usd = (x) => (x < 0 ? "-$" : "+$") + Math.abs(Math.round(x)).toLocaleString("en-US");

const inp = M.loadInputs();
const SYMS = ["QQQ", "SPY", "EFA", "GLD", "DBMF", "JAAA", "SGOV"], W = { QQQ: 15 / 73, SPY: 15 / 73, EFA: 10 / 73, GLD: 10 / 73, DBMF: 15 / 73, JAAA: 8 / 73 }, TREND = ["QQQ", "SPY", "EFA", "GLD"];
const close = {}; for (const s of SYMS) close[s] = new Map(inp.bars[s].map((b) => [b.t.slice(0, 10), b.c]));
const days = inp.bars.SPY.map((b) => b.t.slice(0, 10)).filter((d) => d >= "2020-10-19");
const me = {}; for (const s of TREND) { me[s] = {}; for (const b of inp.bars[s]) me[s][b.t.slice(0, 7)] = b.c; }
function signalAt(s, ym) { const ms = Object.keys(me[s]).filter((m) => m <= ym).sort(); if (ms.length < 10) return null; const last = ms.slice(-10).map((m) => me[s][m]); return last[last.length - 1] > M.mean(last); }

function run(policy, cBps) {
  const hold = { QQQ: 0, SPY: 0, EFA: 0, GLD: 0, DBMF: 0, JAAA: 0, SGOV: 0 }; let nav = 73000, traded = 0, orders = 0, costs = 0, flips = 0;
  const sig = {}; for (const s of TREND) sig[s] = signalAt(s, "2020-09");
  const target = (n) => { const T = {}; let park = 0; for (const s of Object.keys(W)) { if (TREND.includes(s) && !sig[s]) { T[s] = 0; park += W[s]; } else T[s] = W[s] * n; } T.SGOV = park * n; return T; };
  { const T = target(nav); for (const s of Object.keys(T)) hold[s] = T[s]; }
  const dayRet = []; let prevNav = nav;
  const pay = (amt) => { costs += amt; hold.SGOV -= amt; };
  for (let i = 1; i < days.length; i++) {
    const d = days[i], p = days[i - 1];
    for (const s of SYMS) { const a = close[s].get(d), b = close[s].get(p); if (a != null && b != null) hold[s] *= a / b; }
    nav = Object.values(hold).reduce((x, y) => x + y, 0);
    const isME = i === days.length - 1 || days[i + 1].slice(0, 7) !== d.slice(0, 7);
    const flipped = [];
    if (isME) for (const s of TREND) { const ns = signalAt(s, d.slice(0, 7)); if (ns !== sig[s]) { flipped.push(s); flips++; } sig[s] = ns; }
    const T = target(nav), want = [];
    for (const s of Object.keys(W)) {
      let go = false;
      if (isME && policy === "LIVE") go = true;
      else if (isME && flipped.includes(s)) go = true;
      else { const band = Math.max(0.10 * T[s], 500); go = Math.abs(hold[s] - T[s]) > band; }
      if (go && Math.abs(T[s] - hold[s]) > 1e-6) want.push(s);
    }
    // sells first (into the SGOV pool), then buys limited to the pool
    for (const s of want) { const dlt = T[s] - hold[s]; if (dlt < 0) { hold[s] += dlt; hold.SGOV -= dlt; traded += -dlt; orders++; pay(-dlt * cBps / 1e4 + -dlt / 1e4); } }
    const buys = want.filter((s) => T[s] - hold[s] > 0), need = buys.reduce((x, s) => x + (T[s] - hold[s]), 0), pool = Math.max(0, hold.SGOV), k = need > pool ? pool / need : 1;
    for (const s of buys) { const dlt = (T[s] - hold[s]) * k; if (dlt < 1e-6) continue; hold[s] += dlt; hold.SGOV -= dlt; traded += dlt; orders++; pay(dlt * cBps / 1e4 + dlt / 1e4); }
    nav = Object.values(hold).reduce((x, y) => x + y, 0);
    dayRet.push({ d, r: nav / prevNav - 1 }); prevNav = nav;
  }
  const yrs = dayRet.length / 252, st = M.dailyStats(dayRet);
  return { policy, cBps, cagrPct: st.cagrPct, maxDDPct: st.maxDDdailyPct, turnoverPctPerYr: +(100 * traded / 73000 / yrs).toFixed(0), ordersPerYr: +(orders / yrs).toFixed(1), flipsPerYr: +(flips / yrs).toFixed(1), costsUsdPerYr: +(costs / yrs).toFixed(0), endNav: Math.round(nav) };
}

const out = { spec: "planE-rebalance-v1", inputsFetchedAt: inp.fetchedAt, window: [days[1], days[days.length - 1]], rows: [] };
console.log(`PLAN E ETF SUB-BOOK ($73,000), ${days[1]}..${days[days.length - 1]} (${((days.length - 1) / 252).toFixed(2)} years): rebalance rule vs cost`);
console.log("policy      cost/side  net CAGR%  max DD%   turnover %/yr  orders/yr  flips/yr  fees+spread $/yr on the $73k   end NAV from $73,000");
for (const policy of ["LIVE", "FLIPONLY"]) for (const c of [0, 5, 10]) { const r = run(policy, c); out.rows.push(r); console.log(`${policy.padEnd(10)} ${String(c).padStart(5)} bp   ${String(r.cagrPct).padStart(7)}   ${String(r.maxDDPct).padStart(7)}   ${String(r.turnoverPctPerYr).padStart(10)}     ${String(r.ordersPerYr).padStart(6)}    ${String(r.flipsPerYr).padStart(6)}      ${("$" + r.costsUsdPerYr).padStart(10)}                   $${r.endNav.toLocaleString()}`); }
const g = (p, c) => out.rows.find((r) => r.policy === p && r.cBps === c);
console.log("\nFLIPONLY minus LIVE (net CAGR; on the sub-book, then x0.73 for the share of a $100k Plan E):");
for (const c of [0, 5, 10]) { const d = g("FLIPONLY", c).cagrPct - g("LIVE", c).cagrPct; console.log(`   at ${String(c).padStart(2)} bp/side: ${d >= 0 ? "+" : ""}${d.toFixed(2)} pt on the sub-book = ${d >= 0 ? "+" : ""}${(0.73 * d).toFixed(2)} pt of Plan E = ${usd(100000 * 0.73 * d / 100 / 12)}/month per $100k  (turnover ${g("LIVE", c).turnoverPctPerYr}% -> ${g("FLIPONLY", c).turnoverPctPerYr}%/yr; ${g("LIVE", c).ordersPerYr} -> ${g("FLIPONLY", c).ordersPerYr} orders/yr)`); out["flipMinusLive_" + c] = +d.toFixed(3); }
const cost5 = g("LIVE", 5).costsUsdPerYr, cost10 = g("LIVE", 10).costsUsdPerYr;
console.log(`   what the monthly rebalance costs in total: LIVE pays ~$${cost5}/yr at 5 bp and ~$${cost10}/yr at 10 bp on the $73k (= ${usd(cost5 / 12)}/month and ${usd(cost10 / 12)}/month)`);
console.log("   RECOMMENDATION.md on record (B, 2007-2026, 5 bp, trend-only book): flip-only +0.09 %/yr (t 1.72); orders 16.5/yr vs 60.4/yr.");
writeJsonAtomic(path.join(M.BACKEND, "data", "profit-program", "planE-rebalance.json"), out);
console.log("wrote backend/data/profit-program/planE-rebalance.json");
