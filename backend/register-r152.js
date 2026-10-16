#!/usr/bin/env node
/** Registers R152 — TradingView's most-boosted open-source strategies (11 at default inputs). 2026-09-23, operator: "keep mining trading
 *  view". Filed after the known-answer selftest and BEFORE any control or real trade was computed. Refuses if R152 exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R152")) { console.error("R152 already exists — refusing"); process.exit(2); }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a) { const n = a.length, m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n, c = 0; for (let i = 1; i < n; i++) c += d[i] * d[i - 1]; v += c / n; return m / Math.sqrt(v / n); }
const rng = mulberry(152), T = 50000, N = 120, V = 11, mx = [];
for (let t = 0; t < T; t++) { let b = -Infinity; for (let v = 0; v < V; v++) { const s = []; for (let i = 0; i < N; i++) s.push(rng() * 2 - 1); b = Math.max(b, nwT(s)); } mx.push(b); }
mx.sort((a, b) => a - b); const BAR = +mx[Math.floor(0.95 * T)].toFixed(3);
reg.preregistered.push({
  id: "R152", name: "TradingView's most-boosted open-source strategies — eleven at their default inputs, daily",
  registered: "2026-09-23", evidenceStart: "2016-01-01",
  evidenceNote: "Historical. Daily Alpaca SIP bars (adjustment=all) 2016-01-01..2026-09-22: the 100 names of data/r147-universe.json for ten members; DAVIN (written for SPY) on 15 ETFs. Registered after the known-answer selftest and before any control or real trade. One read, sealed.",
  status: "REGISTERED 2026-09-23 — controls, then one historical read", script: "backend/r152-tv-top-strategies.js",
  parent: "Operator: 'keep mining trading view' (after R149/R150; he chose this over pausing). Candidates = the most-boosted script_type=strategy results of 30 searches on 2026-09-23 (361 strategies). Taken in boost order, skipping templates/tools, strategies already tested, and three too large to verify a translation (Delta-RSI 17,918 chars, QQE MOD+SSL Hybrid+WAE 23,306, AI SuperTrend x Pivot Percentile 21,837 kNN).",
  sources: { SUPERTREND: "/script/P5Gu6F8k/", "RSI-DIV": "/script/qSLcZSyw/", "BBRSI-LONG": "/script/HDSdFMa3/", TOTT: "/script/eENf7NpJ/", "MACD-STOCH": "/script/G5ro3y87/", "MACD-RELOAD": "/script/VO6DY8s1/", "STOCH-RSI": "/script/IGJPEi7L/", "BB-RSI": "/script/zopumZ8a/", "ICHI-TK": "/script/88TwdvFZ/", "CUM-RSI": "/script/nI9Csm8g/", DAVIN: "/script/Gkib6KgL/" },
  multiplicityFamily: "TRADINGVIEW-TOP-STRATEGIES-11 — one variant per script at DEFAULT inputs. A separate family from R149 (8) and R150 (7); across the three TradingView families 26 scripts have now been examined, and each family pays its own best-of-N bar.",
  rule: "Each member as its published code at default inputs; see the header of backend/r152-tv-top-strategies.js. TradingView broker-emulator semantics (signal at the close, market fill at the next open; CUM-RSI fills at the signal close as its process_orders_on_close setting specifies; stop-entry orders fill only on a trade-through of the level). Positions open on 2026-09-22 are not counted.",
  statistic: "Per member. Unit: calendar MONTH of entry; per month the mean net % return of trades entered (0.10% round trip). Headline t = Newey-West lag 1.",
  bar: { fixedInAdvance: true, unit: "months", minMonths: 36, minTrades: 100, tRequired: BAR, variants: 11, statistic: "Newey-West t, lag 1",
    source: `simulated in register-r152.js: best of 11 NW(lag 1) t on zero-mean iid noise, n=120, 50,000 trials, seed 152, p95 = ${BAR}` },
  controls: {
    knownAnswer: { done: "2026-09-23, before registration", result: "PASS: SuperTrend shorts the fall and reverses; a stop entry gapped through fills at the open; a stop touch is not a fill; Cumulative RSI fills at the signal close" },
    leakTest: { planned: "before the read", method: "bar shuffle within each symbol with ARITHMETIC drift removed (R149's corrected null), seeds 1 and 2", requirement: "no member t_NW >= 2" },
    floor: "drift-kept bar shuffle (seeds 1, 2): the real monthly mean must beat it",
    positiveControl: { planned: "same run", method: "trades whose own realised net is positive (outcome look-ahead)", requirement: "t_NW >= 3 for every member" },
  },
  interimKill: "none — one historical read over a fixed sample",
  decisionRule: {
    pass: `A member with >= 100 trades over >= 36 months, mean net % per month > 0 AND above its drift-kept floor, t_NW >= ${BAR}, both halves positive. A PASS adopts nothing: it earns a post-read audit (side split, cost, survivorship, matched placebo) and, if it survives, a forward paper test like R151.`,
    fail: "Otherwise DID NOT PASS: these eleven at their defaults are closed on these data; no member is to be re-run with other inputs, timeframes or universes on these data.",
  },
  readCondition: "Immediately after the controls print READY: node backend/r152-tv-top-strategies.js --read, then node backend/seal-r152.js.",
  expectation: "I expect none to pass. Several are trend followers of the family that failed in R149/R150; the ChartArt double strategies require two rare crosses on the same bar; the two short-term mean-reversion members (CUM-RSI, DAVIN) are the likeliest, being cousins of R150's RSI-2.",
  knownWeaknesses: [
    "TRANSLATION RISK: Pine re-implemented in JavaScript; four known-answer checks; RSI-DIV's pivot/valuewhen logic and the VAR-based members are translated line by line but not matched to TradingView's trade lists.",
    "ICHI-TK was written for crypto; it runs here on daily US large caps. DAVIN was written for SPY and runs on 15 ETFs.",
    "SURVIVORSHIP: today's most-traded 100 names; the drift-kept floor keeps each name's own drift.",
    "RSI-DIV pyramids to 2 lots as published; each lot counts as a trade.",
    "COST 0.10% flat; CUM-RSI's own settings assume a per-share commission and 1 tick of slippage, which 0.10% covers for liquid names.",
  ],
  ip: "TradingView House Rules forbid republishing the code; our re-implementations stay in this repo.", writerExists: true,
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-23", area: "R152 TradingView top strategies — registered", category: "registration", breaksComparability: false, change: `R152 registered after a passing selftest, before any control or real trade: 11 most-boosted open-source strategies at default inputs; NW t bar ${BAR} (best of 11).`, why: "Operator: 'keep mining trading view'.", doesNotEstablish: "Anything about tuned versions or the excluded large scripts.", operator: "Josh 2026-09-23" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R152"], detail: `TradingView top strategies x11, NW bar ${BAR}` }) + "\n");
console.log(`R152 registered · bar t_NW >= ${BAR}`);
