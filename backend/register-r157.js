#!/usr/bin/env node
/** Registers R157 — AI SuperTrend x Pivot Percentile (PresentTrading), the author's defaults out of sample on BTC 6h. 2026-09-23,
 *  operator: "AI SuperTrend then 1-3". Filed after the selftest and BEFORE any control or out-of-sample trade. Refuses if R157 exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R157")) { console.error("R157 already exists — refusing"); process.exit(2); }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a) { const n = a.length, m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n, c = 0; for (let i = 1; i < n; i++) c += d[i] * d[i - 1]; v += c / n; return m / Math.sqrt(v / n); }
const rng = mulberry(157), T = 50000, N = 33, xs = []; for (let t = 0; t < T; t++) { const s = []; for (let i = 0; i < N; i++) s.push(rng() * 2 - 1); xs.push(nwT(s)); }
xs.sort((a, b) => a - b); const BAR = +xs[Math.floor(0.95 * T)].toFixed(3);
reg.preregistered.push({
  id: "R157", name: "AI SuperTrend x Pivot Percentile (PresentTrading) — the author's defaults out of sample on BTC 6h",
  registered: "2026-09-23", evidenceStart: "2024-01-27",
  evidenceNote: "Historical but out of sample for the configuration: report BITFINEX:BTCUSD 6h 2013-05..2024-01, published 2024-01-27. Evaluation: trades entered 2024-01-27..2026-09-22 on Bitfinex's own public candles (6h/12h/1D). Registered after the selftest (134 in-sample trades vs TradingView's 139), before any control or out-of-sample trade. One read, sealed.",
  status: "REGISTERED 2026-09-23 — controls, then one read", script: "backend/r157-aist-oos.js",
  parent: "R153 third verification (backend/r153-aist-verify.js, Bitfinex candles): 114/139 of the author's trades reproduce — 91 exact (entry within one 6h bar, exit within 12h and 2%) and 23 with the same exit and an entry shifted <= 48h (the KNN's unanimity test is price-sensitive); 20 extra trades of ours. Excluded from R152 as too large; now checked.",
  source: "TradingView /script/eC3qAYNQ/",
  multiplicityFamily: "AIST-OOS-1 — one member, the author's own defaults; the higher-timeframe mapping (last completed 12h/1D bar) is a translation detail fixed by the R153 match (91 vs 63 exact), not a searched parameter.",
  rule: "As published (see backend/r153-aist-verify.js header): long when both AI SuperTrends point up with unanimous KNN labels, the daily ADX > 20 with +DI > -DI, and the pivot-percentile trend value > 0; short mirrored; entries reverse; exits by a stop at SuperTrend -/+ 3.5 ATR re-set each bar where the exit condition holds. Signal at the 6h close, fill at the next open.",
  statistic: "Monthly return = sum over trades exiting in the month of (direction x price return - 0.20% round trip, the author's 0.1% per side); 33 months 2024-01..2026-09; Newey-West lag 1; unit exposure.",
  bar: { fixedInAdvance: true, unit: "months", statistic: "Newey-West t, lag 1", variants: 1, tRequired: BAR, minTrades: 15,
    memberBar: "bar + max(0, mean t on 10 arithmetic drift-free scrambles of the 6h bars)",
    source: `simulated in register-r157.js: NW(lag 1) t on zero-mean iid noise, n=33, 50,000 trials, seed 157, p95 = ${BAR}` },
  controls: { leakTest: "10 arithmetic drift-free scrambles of the 6h bars (12h/1D re-aggregated): mean noise t < 2", floor: "drift-kept scrambles (seeds 1, 2)", positiveControl: "winners-only subset t >= member bar" },
  interimKill: "none — one read over a fixed sample",
  decisionRule: { pass: "trades >= 15, monthly mean > 0 and above the floor, t >= member bar, both halves positive. Adopts nothing: post-read audit, then only if it survives a forward paper test.", fail: "DID NOT PASS: the published report did not carry forward; closed on these data." },
  readCondition: "Immediately after the controls print READY: node backend/r157-aist-oos.js --read, then node backend/seal-r157.js.",
  expectation: "I expect DID NOT PASS; ~35 trades over 33 months is low power, and R155/R156 collapsed out of sample.",
  knownWeaknesses: ["LOW POWER: about 35 out-of-sample trades over 33 months.", "Translation reproduces 114/139 in sample, not all; the KNN unanimity test flips on small price differences.", "Bitfinex candles fetched in 2026 may differ slightly from what TradingView held in 2024."],
  ip: "TradingView House Rules forbid republishing the code; our re-implementation stays in this repo.", writerExists: true,
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-23", area: "R157 AI SuperTrend out of sample — registered", category: "registration", breaksComparability: false, change: `R157 registered after the selftest, before any control or OOS trade: the author's defaults on Bitfinex BTC 6h 2024-01-27..2026-09-22; NW bar ${BAR}.`, why: "Operator: 'AI SuperTrend then 1-3'; translation reproduces 114/139 (R153).", doesNotEstablish: "Anything about other settings or assets.", operator: "Josh 2026-09-23" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R157"], detail: `AI SuperTrend OOS, NW bar ${BAR}` }) + "\n");
console.log(`R157 registered · bar t_NW >= ${BAR}`);
