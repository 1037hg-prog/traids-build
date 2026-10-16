#!/usr/bin/env node
/** Registers R154 — TradingView's next most-boosted open-source strategies (12 at default inputs). 2026-09-23, operator: "kweep mining".
 *  Filed after the known-answer selftest and BEFORE any control or real trade was computed. Refuses if R154 exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R154")) { console.error("R154 already exists — refusing"); process.exit(2); }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a) { const n = a.length, m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n, c = 0; for (let i = 1; i < n; i++) c += d[i] * d[i - 1]; v += c / n; return m / Math.sqrt(v / n); }
const rng = mulberry(154), T = 50000, N = 129, V = 12, mx = [];
for (let t = 0; t < T; t++) { let b = -Infinity; for (let v = 0; v < V; v++) { const s = []; for (let i = 0; i < N; i++) s.push(rng() * 2 - 1); b = Math.max(b, nwT(s)); } mx.push(b); }
mx.sort((a, b) => a - b); const BAR = +mx[Math.floor(0.95 * T)].toFixed(3);
reg.preregistered.push({
  id: "R154", name: "TradingView's next most-boosted open-source strategies — twelve at their default inputs, daily",
  registered: "2026-09-23", evidenceStart: "2016-01-01",
  evidenceNote: "Historical. Daily Alpaca SIP bars (adjustment=all) 2016-01-01..2026-09-22 for the 100 names of data/r147-universe.json. Registered after the known-answer selftest and before any control or real trade. One read, sealed.",
  status: "REGISTERED 2026-09-23 — controls, then one historical read", script: "backend/r154-tv-next-strategies.js",
  parent: "Operator: 'keep mining trading view' / 'kweep mining' (after R149/R150/R152). Candidates = the next 17 most-boosted script_type=strategy results below R152's eleven in the same 2026-09-23 search set; 5 excluded before any computation because they depend on execution features not reproduced faithfully (tick trailing stops, bar magnifier, partial exits, intraday session logic).",
  sources: { "EMA-SLOPE": "lukescream", "3X-ST": "mel0n", "FRAMA-ST": "03.freeman", "EMA-CROSS": "gregoirejohnb", NR7ID: "ChartArt", "RSI-PRIME": "ChartPrime", "BEST-ST": "Daveatt", "HMA-ST": "Gustav_Rex", "TEMA-QQE": "tradedots", "EMA-LONG": "coingrabber", "ICHI-CLOUD": "Yo_adriiiiaan", "HA-OPT": "markontie" },
  multiplicityFamily: "TRADINGVIEW-NEXT-STRATEGIES-12 — one variant per script at DEFAULT inputs. A separate family from R149 (8), R150 (7), R152 (11); across the four TradingView families 38 scripts have now been examined, each family paying its own best-of-N bar. With four families read, about 0.2 false family passes are expected at 5% each — disclosed, not corrected (two passes so far: R150 RSI-2, R152 DAVIN; DAVIN audited to market exposure).",
  rule: "Each member as its published code at default inputs; see the header of backend/r154-tv-next-strategies.js. TradingView broker-emulator semantics (signal at the close, market fill at the next open; RSI-PRIME fills at the signal close per its process_orders_on_close; limits fill only on a trade-through; stops on a touch; an open beyond a level fills at the open). Positions open on the last bar are marked at its close and counted.",
  statistic: "Per member. Daily strategy-return series (mean across open positions each day), summed per calendar month, 0 when flat, 129 months 2016-01..2026-09; 0.10% round trip charged half at entry, half at exit. Headline t = Newey-West lag 1.",
  bar: { fixedInAdvance: true, unit: "months", minMonths: 36, minTrades: 100, tRequired: BAR, variants: 12, statistic: "Newey-West t, lag 1",
    memberBar: "family bar + max(0, member's mean t on 10 arithmetic drift-free scrambles) — R152's empirical null, adopted from the start",
    source: `simulated in register-r154.js: best of 12 NW(lag 1) t on zero-mean iid noise, n=129, 50,000 trials, seed 154, p95 = ${BAR}` },
  controls: {
    knownAnswer: { done: "2026-09-23, before registration", result: "PASS: ta.supertrend is up on the rise and down on the fall; EMA-CROSS shorts the fall and reverses; FRAMA runs on completed weekly data; every open position is marked at the end" },
    leakTest: { planned: "before the read", method: "10 bar shuffles per symbol with ARITHMETIC drift removed", requirement: "every member's mean noise t < 2" },
    floor: "drift-kept bar shuffle (seeds 1, 2): the real monthly mean must beat it",
    positiveControl: { planned: "same run", method: "trades whose own realised net is positive (outcome look-ahead)", requirement: "t_NW >= 3 for every member" },
  },
  interimKill: "none — one historical read over a fixed sample",
  decisionRule: {
    pass: `A member with >= 100 trades over >= 36 exposed months, mean net % per month > 0 AND above its drift-kept floor, t_NW >= its member bar (family ${BAR} + noise mean), both halves positive. A PASS adopts nothing: it earns a post-read audit (side split, buy-and-hold and random-entry comparison, cost, concentration) and, only if it survives, a forward paper test like R151.`,
    fail: "Otherwise DID NOT PASS: these twelve at their defaults are closed on these data; no member is re-run with other inputs, timeframes or universes on these data.",
  },
  readCondition: "Immediately after the controls print READY: node backend/r154-tv-next-strategies.js --read, then node backend/seal-r154.js.",
  expectation: "I expect none to pass after the floor. Most are trend followers of the kind that failed in R149/R150/R152 once long exposure to rising survivors is netted out; the long-only members (NR7ID, EMA-LONG, HA-OPT) will look positive raw and must beat their drift-kept floor.",
  knownWeaknesses: [
    "TRANSLATION RISK: Pine re-implemented in JavaScript; four known-answer checks; none matched to TradingView's own trade lists (that is R153's job).",
    "3X-ST enters with a stop order at a SuperTrend line that is usually already through the market, so it fills at the next open; if the line is on the far side the entry waits for a touch within that one bar only — an interpretation of a pending strategy.entry(stop=).",
    "TEMA-QQE's stop is 120 pips; on a stock with mintick 0.01 that is $1.20 regardless of price — a faithful translation of a forex-oriented script, not a sensible stock stop.",
    "FRAMA-ST uses weekly data from completed weeks only (lookahead off); the current week's value is used on its last session, matching Pine's non-repainting behaviour on historical bars.",
    "SURVIVORSHIP: today's most-traded 100 names; the drift-kept floor keeps each name's own drift.",
    "COST 0.10% flat round trip.",
  ],
  ip: "TradingView House Rules forbid republishing the code; our re-implementations stay in this repo.", writerExists: true,
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-23", area: "R154 TradingView next strategies — registered", category: "registration", breaksComparability: false, change: `R154 registered after a passing selftest, before any control or real trade: 12 next most-boosted open-source strategies at default inputs; NW t family bar ${BAR} (best of 12, n=129) plus per-member empirical null.`, why: "Operator: 'kweep mining'.", doesNotEstablish: "Anything about tuned versions or the five excluded scripts.", operator: "Josh 2026-09-23" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R154"], detail: `TradingView next strategies x12, NW bar ${BAR}` }) + "\n");
console.log(`R154 registered · bar t_NW >= ${BAR}`);
