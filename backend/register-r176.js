#!/usr/bin/env node
/** Registers R176 — can entry-time features pick Payne's winners? (a meta-label filter on his published trades). 2026-09-24, operator:
 *  "can we predict winners only of chucks trades". Filed before any feature-vs-outcome split of his trades was computed (the earlier profile
 *  compared his entries with random dates; winners vs losers were compared only on exit gain / hold, never on entry features). */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const { nullBar } = require("./lib/null-bar.js");
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R176")) { console.error("R176 already exists — refusing"); process.exit(2); }
const BAR = +nullBar({ variants: 4, n: 50, trials: 20000 }).p95.toFixed(3);
reg.preregistered.push({
  id: "R176", name: "Payne meta-filter — entry-time features ranking his trades (take the predicted winners only)",
  registered: "2026-09-24", evidenceStart: "2026-09-24 (historical; walk-forward, computed after this registration)",
  status: "REGISTERED 2026-09-24 — historical read pending", script: "backend/r176-payne-meta.js",
  parent: "Operator 2026-09-24: 'can we predict winners only of chucks trades'. Inputs: data/payne-model-portfolio.json (his trades) and data/r175-payne-replica.json's rule (the replica's trades, a larger mechanical sample).",
  multiplicityFamily: "PAYNE-META-4 — {ridge, small GBM} x {his published trades 2021-2026, replica-rule trades 2017-2026}. Primary: ridge on his trades.",
  rule: "Features at the entry close before his entry date, from split-adjusted daily closes only: 5/20/60/252-day returns, distance below the 252-day high, above 50/200-day averages, RSI(14), a +5% day in the prior 10 sessions, a -5% day in the prior 10, 20-day realised volatility, SPY above its 200-day, SPY 20-day return. Target: the trade's return minus SPY over the same dates (his own entry/exit; open positions marked at the last close and included, flagged). Walk-forward by calendar year: train on trades whose EXIT precedes the test year, test on trades ENTERED in that year (2022..2026 for his trades; 2019..2026 for the replica).",
  statistic: "Per entry month in the test years: mean excess of the model's top half minus its bottom half (months with >= 4 scored trades); t over months. Also reported: 'winners only' book — the top half alone vs all his trades (mean excess, win rate).",
  bar: { fixedInAdvance: true, unit: "entry months", tRequired: BAR, variants: 4, source: `nullBar({variants:4, n:50, trials:20000}).p95 = ${BAR}` },
  controls: { leak: "labels shuffled within entry month, same pipeline: |t| < 2 for all four", peek: "rank by the realised excess itself: must clear the bar" },
  interimKill: "n/a (historical)",
  decisionRule: { pass: "A filter on his picks is worth something: register it forward on R159's picks (his new alerts), taking only the predicted top half.", fail: "DID NOT PASS: nothing visible at entry separates his winners from his losers; filtering his alerts is noise." },
  readCondition: "one read, once the controls pass",
  expectation: "I expect DID NOT PASS: ~540 of his trades over ~55 test months gives an MDE of several % per trade, and the replica showed his filters barely beat random names.",
  knownWeaknesses: ["Small sample: his checkable trades start 2021 (260 days of history needed), leaving ~4 test years.", "His exits are discretionary; the target inherits them.", "Open positions are marked, not closed; they are the most recent and mostly losing.", "No fundamentals, earnings dates or news — price-visible features only."],
  ip: "His published record (public web page); the model is ours.", writerExists: true,
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-24", area: "R176 Payne meta-filter — registered", category: "registration", breaksComparability: false, change: `Walk-forward ridge/GBM on entry-time price features to rank his trades; best-of-4 bar ${BAR}.`, why: "Operator: 'can we predict winners only of chucks trades'.", doesNotEstablish: "Anything until the read.", operator: "Josh 2026-09-24" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R176"], detail: `Payne meta-filter, bar ${BAR}` }) + "\n");
console.log(`R176 registered · bar ${BAR}`);
