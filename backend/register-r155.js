#!/usr/bin/env node
/** Registers R155 — Delta-RSI out of sample (the first large TradingView script with a VERIFIED translation, R153). 2026-09-23, operator:
 *  "keep mining". Filed after the selftest and BEFORE any control or real out-of-sample trade was computed. Refuses if R155 exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R155")) { console.error("R155 already exists — refusing"); process.exit(2); }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a) { const n = a.length, m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n, c = 0; for (let i = 1; i < n; i++) c += d[i] * d[i - 1]; v += c / n; return m / Math.sqrt(v / n); }
// best of 3 with the members' own sample sizes (BTC 67 months, stocks 129 + 129); one bar for the family, applied to every member
const rng = mulberry(155), T = 50000, NS = [67, 129, 129], mx = [];
for (let t = 0; t < T; t++) { let b = -Infinity; for (const N of NS) { const s = []; for (let i = 0; i < N; i++) s.push(rng() * 2 - 1); b = Math.max(b, nwT(s)); } mx.push(b); }
mx.sort((a, b) => a - b); const BAR = +mx[Math.floor(0.95 * T)].toFixed(3);
reg.preregistered.push({
  id: "R155", name: "Delta-RSI (tbiktag) — the author's published configuration out of sample on BTC, and on 100 stocks (published + default settings)",
  registered: "2026-09-23", evidenceStart: "2021-03-22",
  evidenceNote: "Historical, but BTC-PUB is genuinely out of sample for the configuration: the author's report ends 2021-03-19 and was published 2021-03-19/22; trades entered 2021-03-22..2026-09-22 were never seen by the author. BTC bars: OANDA-style 5-day 17:00 New York sessions rebuilt from Coinbase hourly candles (the calendar R153 showed the report used). Stock members: daily Alpaca SIP 2016-01..2026-09 on data/r147-universe.json (not seen by the author either, but the configuration was chosen on BTC). Registered after the selftest, before any control or real trade in the evaluation windows. One read, sealed.",
  status: "REGISTERED 2026-09-23 — controls, then one read", script: "backend/r155-delta-rsi-oos.js",
  parent: "R153 (translation verification: our code reproduces TradingView's own report, 14/18 trades within +-2 days and 3%, no logic difference). Excluded from R152 as 'too large to verify'; now verified.",
  source: "TradingView /script/0OdCms2T/ 'Delta-RSI Strategy (with filters)' by tbiktag; report OANDA:BTCUSD 1D 2017-01..2021-03, +474.58%, 13/17 winners, PF 8.667",
  multiplicityFamily: "DELTA-RSI-OOS-3 — BTC-PUB, STOCKS-PUB, STOCKS-DEF. One family bar (best of 3 at the members' own sample sizes). A fifth TradingView family after R149/R150/R152/R154.",
  rule: "Delta-RSI = first derivative at the current bar of a least-squares cubic fitted to the last 50 values of RSI(21); signal line = EMA(9) of it. PUB (the author's published report configuration): long only; enter on a crossover of the signal line and exit on a crossunder, each only when ATR(5) > ATR(30); 20% trailing stop from the close (stop fills at the level, or at the open if gapped through). DEF (code defaults): long and short, signal-line crossing, no filters, no stop — in effect stop-and-reverse. Signals at the close, fills at the next open; open positions marked at the last close.",
  statistic: "Per member: daily strategy-return series (mean across open positions each day), summed per calendar month, 0 when flat; BTC-PUB 67 months 2021-03..2026-09, stock members 129 months 2016-01..2026-09; 0.10% round trip. Headline t = Newey-West lag 1.",
  bar: { fixedInAdvance: true, unit: "months", statistic: "Newey-West t, lag 1", variants: 3,
    tRequired: { "BTC-PUB": BAR, "STOCKS-PUB": BAR, "STOCKS-DEF": BAR },
    minimums: { "BTC-PUB": { trades: 15, months: 24 }, "STOCKS-PUB": { trades: 100, months: 36 }, "STOCKS-DEF": { trades: 100, months: 36 } },
    memberBar: "family bar + max(0, member's mean t on 10 arithmetic drift-free scrambles) — R152/R154 empirical null",
    source: `simulated in register-r155.js: best of 3 NW(lag 1) t on zero-mean iid noise at n = 67, 129, 129; 50,000 trials, seed 155, p95 = ${BAR}` },
  controls: {
    knownAnswer: { done: "2026-09-23, before registration", result: "PASS: the engine reproduces the R153 in-sample entries (>= 16 of 18 within 2 days); defaults alternate long/short; the out-of-sample filter keeps only entries from 2021-03-22" },
    leakTest: { planned: "before the read", method: "10 bar shuffles per symbol with ARITHMETIC drift removed", requirement: "every member's mean noise t < 2" },
    floor: "drift-kept bar shuffle (seeds 1, 2): the real monthly mean must beat it — for BTC this is the 'is it just being long bitcoin' check",
    positiveControl: { planned: "same run", method: "trades whose own realised net is positive", requirement: "t_NW >= 3 for every member" },
  },
  interimKill: "none — one read over fixed samples",
  decisionRule: {
    pass: "A member meeting its minimums with mean net % per month > 0 AND above its drift-kept floor, t_NW >= its member bar, both halves positive. A PASS adopts nothing: post-read audit (buy-and-hold comparison, random-entry comparison, cost), then only if it survives a forward paper test like R151.",
    fail: "DID NOT PASS: Delta-RSI at these configurations is closed on these data; the published report is then an in-sample showcase that did not carry forward.",
  },
  readCondition: "Immediately after the controls print READY: node backend/r155-delta-rsi-oos.js --read, then node backend/seal-r155.js.",
  expectation: "I expect BTC-PUB to be positive in raw terms (BTC rose ~3x from 2021-03 with deep drawdowns) and the question to be whether it beats its drift-kept floor; I expect both stock members to sit near their floors like every trend follower so far.",
  knownWeaknesses: [
    "BTC-PUB has ~20-30 trades over 67 months: low power; a real edge could miss.",
    "BTC bars are Coinbase prices on OANDA's session calendar, not OANDA's own CFD quotes; R153 showed this reproduces 14/18 of the author's trades, so some trade-level differences remain.",
    "The published configuration (ATR filter, 20% trailing stop) was chosen by the author on BTC 2017-2021 — in-sample there, out of sample everywhere here.",
    "STOCKS-DEF reproduces the code's endshort typo in its practical effect (stop-and-reverse), not bar-for-bar.",
    "SURVIVORSHIP on the stock universe; the drift-kept floor keeps each name's own drift.",
  ],
  ip: "TradingView House Rules forbid republishing the code; our re-implementation stays in this repo.", writerExists: true,
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-23", area: "R155 Delta-RSI out of sample — registered", category: "registration", breaksComparability: false, change: `R155 registered after a passing selftest, before any control or real trade: Delta-RSI's published configuration out of sample on BTC 2021-03..2026-09 plus 100 stocks (published + defaults); family NW bar ${BAR} (best of 3).`, why: "Operator: 'keep mining'. First large script with a verified translation (R153).", doesNotEstablish: "Anything about other Delta-RSI settings or other assets.", operator: "Josh 2026-09-23" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R155"], detail: `Delta-RSI OOS x3, NW bar ${BAR}` }) + "\n");
console.log(`R155 registered · family bar t_NW >= ${BAR}`);
