#!/usr/bin/env node
/** Registers R189 — a crypto strategy MODELED on AlphaInsider's top crypto scripts: the ensemble of R187's verified translations.
 *  2026-09-24, operator: "model a crypto strategy from them". Filed before any R187 translation exists. Judged against a plain textbook
 *  trend rule so the test answers whether "their" logic adds anything beyond generic crypto trend-following. Refuses if R189 exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const { nullBar } = require("./lib/null-bar.js");
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R189")) { console.error("R189 already exists — refusing"); process.exit(2); }
const BAR = +nullBar({ variants: 2, n: 900, trials: 20000 }).p95.toFixed(3);
reg.preregistered.push({
  id: "R189", name: "AlphaInsider crypto ensemble — the verified top-crypto scripts combined, vs a textbook trend rule",
  registered: "2026-09-24", evidenceStart: "2021-01-01..2025-09-23 (before the 1-year window the scripts were selected on), historical; BTC-USD and ETH-USD Coinbase daily + each script's own timeframe",
  status: "REGISTERED 2026-09-24 — waits for R187's translations to pass their known-answer gate", script: "backend/r189-ai-crypto-ensemble.js (reuses R187's verified translations unchanged)",
  parent: "Operator 2026-09-24: 'model a crypto strategy from them'. Built only from R187 scripts that pass R187's >= 80% trade-log match; excluded scripts are left out, never re-fitted.",
  multiplicityFamily: "AI-CRYPTO-ENSEMBLE-2 — {E1 equal-weight portfolio of the verified scripts, each on its own asset with 1/n of capital; E2 majority vote per asset: long when most of that asset's verified scripts are long, flat otherwise}. Separate family from R187 (a combination, disclosed as built on the same five).",
  rule: "E1: capital split equally across the verified scripts, each trading its own asset exactly as translated (shorts allowed only if the script shorts). E2: per asset (BTC, ETH), long 100% of that asset's half of capital when a strict majority of its verified scripts is long at the bar close, else cash; rebalanced at the next open. Cost 10 bps per side on every position change. BENCHMARKS: (a) 50/50 BTC/ETH buy-and-hold, rebalanced monthly; (b) TEXTBOOK TREND: per asset, long when the daily close is above its 100-day simple average, else cash, same costs.",
  statistic: "Primary: daily net return of each ensemble minus the TEXTBOOK TREND benchmark's daily net return (does their logic beat the generic rule?), Newey-West lag 5 t over days. Also reported: alpha vs 50/50 buy-and-hold (regression intercept), CAGR, max drawdown, Sharpe, time in market, for ensembles and both benchmarks.",
  bar: { fixedInAdvance: true, unit: "days (~1,730)", tRequired: BAR, variants: 2, source: `nullBar({variants:2, n:900}).p95 = ${BAR}` },
  controls: { randomTiming: "each verified script's trades replaced by the same count and holding lengths at random dates (200 draws), ensembles rebuilt: the true ensemble must beat the 95th percentile", peek: "perfect-foresight long/flat on the same assets must clear the bar" },
  interimKill: "n/a (historical)",
  decisionRule: { pass: "An ensemble beats the textbook trend rule out of sample: register a forward paper test (Alpaca paper crypto), operator's word.", fail: "Their scripts add nothing beyond generic crypto trend-following; if the TEXTBOOK rule itself shows a strong drawdown advantage over buy-and-hold, that is reported as the actionable finding (not a pass of R189)." },
  readCondition: "one read, after R187's translations are verified (needs >= 2 verified scripts; with fewer, reported as 'cannot build')",
  expectation: "LOW-MED: crypto trend filters usually cut drawdowns and lag in bull years; beating a generic 100-day rule is the harder, more honest bar.",
  knownWeaknesses: ["Built from scripts selected on 2025-26 performance — the OOS window guards the evaluation, not the choice of scripts.", "2021-2025 contains one full crypto boom-bust cycle; few independent regimes.", "Scripts on different timeframes combined on daily marks."],
  ip: "Translations of public TradingView scripts for private testing only; never republished.", writerExists: false,
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-24", area: "R189 AI crypto ensemble — registered", category: "registration", breaksComparability: false, change: `Ensemble of R187-verified scripts vs a textbook 100-day trend rule, 2021-2025; best-of-2 bar ${BAR}.`, why: "Operator: 'model a crypto strategy from them'.", doesNotEstablish: "Anything until the read.", operator: "Josh 2026-09-24" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R189"], detail: `AI crypto ensemble vs textbook trend, bar ${BAR}` }) + "\n");
console.log(`R189 registered · bar ${BAR}`);
