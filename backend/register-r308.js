#!/usr/bin/env node
/** Registers R308 — a crest predictor (operator 2026-10-01: "if you predict the crest you would never lose" -> "try it"). A walk-forward
 *  model, trained only on the past, estimates at each hour of an open R307 surge trade whether the 48-hour crest has already passed; the
 *  trade exits when it says so. DISCLOSED: R307's trades and its result (all mechanical exits lose after costs) were seen before this
 *  registration; R308 keeps R307's entry rule, universe, data, 48 h cap and cost verbatim and adds only the exit model. Bar =
 *  nullBar({variants:2, n:1000}).p95. Refuses if the id exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { nullBar } = require("./lib/null-bar.js");
const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
const ID = "R308", TODAY = "2026-10-01", CELLS = 2, N = 1000;
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === ID)) { console.error(`${ID} exists — refusing`); process.exit(2); }
const b = +nullBar({ variants: CELLS, n: N, trials: 20000 }).p95.toFixed(3);
reg.preregistered.push({
  id: ID, registered: TODAY, name: "Crest predictor — a walk-forward model decides when an R307 crypto surge trade has peaked, and exits",
  status: `REGISTERED ${TODAY} — historical, read once; builder assigned`, script: "backend/r308-crest-predictor.js",
  parent: "R307 (sealed DID NOT PASS 2026-10-01: surge entries with TRAIL/FADE/T6 exits all lose after 0.50% round trip, t -6.1 to -7.0; gross roughly flat; exits bail at 5-7 h, before the 48 h peak on most trades). Operator: 'if you predict the crest you would never lose' -> 'try it'.",
  multiplicityFamily: "CREST — R308 alone; 2 cells (LOGIT, GBM), exit threshold fixed at 0.5.",
  evidenceStart: "historical, walk-forward: models trained on surge trades before each test year, tested on 2021..2026-09 (out of sample only); 2019-2020 is training only",
  rule: [
    "TRADES: exactly R307's surge entries (same 32 coins, Coinbase hourly candles, same surge rule, one per coin per 24 h, long at the surge hour's close, 48 h hard cap, 0.50% round trip) — reuse backend/r307-ride-the-wave.js's entry logic and candle cache.",
    "LABEL (training only): at each hour h = 1..47 of a trade, y = 1 if no later close inside the 48 h window exceeds the close at h (the crest has passed), else 0.",
    "FEATURES at hour h, all from bars <= h: return since entry; drawdown from the highest close since entry; hours since entry; hours since that highest close; hour-h volume / 7-day median hourly volume; mean volume of the last 3 hours / the entry hour's volume; std of the last 6 hourly returns / the 7-day hourly std; close / mean close of the last 24 h - 1; hourly RSI(14); BTC's return since entry (BTC's own trades use ETH); the surge hour's return in sigma units; UTC hour of day; weekday. Standardised with training-set statistics only.",
    "MODELS (the 2 cells): LOGIT = L2-regularised logistic regression (lambda 1.0); GBM = gradient-boosted depth-2 trees, 200 rounds, learning rate 0.05, min 50 rows per leaf. Both implemented in plain Node (no Python on this host).",
    "WALK-FORWARD: for each test year Y in 2021..2026, train on every trade whose 48 h window closed before Jan 1 of Y (expanding window from 2019), then freeze the model for all of Y.",
    "POLICY: from h = 1, exit at the close of the first hour whose predicted probability of 'crest passed' is >= 0.5; otherwise at the 48 h cap.",
  ].join(" "),
  statistic: "Per UTC day with entries: mean net trade return under the model's exits (day clustering, as R307). One-sample t over days 2021-01..2026-09; best-of-2 cells.",
  unit: "days", nExpected: N,
  controls: {
    learnedNothing: "SHUFFLED LABELS: the same pipeline with labels permuted within each trade before training (>= 50 permutations); the observed cell mean must beat the shuffled p95 — proves the model learned something real about crests.",
    vsR307: "paired per-day difference against R307's best mechanical exit (FADE) on the same trades — reported; the model must also beat it (mean positive).",
    leakTest: "BEFORE the real read: the full pipeline on synthetic paths (each coin's hourly returns randomly permuted, destroying structure) must show no edge (|t| < 2 for both cells and the model-vs-FADE gap) — else the pipeline leaks and the read is CANNOT MEASURE.",
    halves: "first and second half of the out-of-sample days; both must be positive.",
    reported: "BTC+ETH only; a maker-fee scenario at 0.30% round trip (Alpaca maker 0.15%/side) — reported, not gated; per year; model calibration (predicted vs realised crest rate); feature importance.",
  },
  bar: { fixedInAdvance: true, unit: "days", tRequired: b, variants: CELLS, source: `nullBar({variants:${CELLS}, n:${N}, trials:20000}).p95 = ${b}` },
  interimKill: "none (single historical read)",
  decisionRule: {
    pass: "PASS only if the better cell's net t >= bar AND it beats the shuffled-label p95 AND it beats FADE on the paired difference (mean > 0) AND both halves are positive AND the leak test was clean. A PASS proposes a forward paper test (operator's call).",
    fail: "DID NOT PASS: recorded with the numbers; the crest is not predictable from these features well enough to beat costs.",
    cannotMeasure: "CANNOT MEASURE if the leak test fails, or fewer than 300 out-of-sample days with trades.",
  },
  knownWeaknesses: [
    "R307's trades and result were seen before registration; the entry rule is R307's verbatim and every model setting is fixed here, but the idea itself was prompted by that result.",
    "R307's survivorship (today's coin list) carries over and flatters any long-surge result.",
    "No funding rates or order-book features: they are not available historically here; the forward recorders could add them later.",
    "Entries are R307's, which lose before any exit decision on 13% of trades (never closed above entry within 48 h); the model can only cut losses, not fix entries.",
    "Two model families and a fixed 0.5 threshold; no tuning on the test years.",
  ],
  readCondition: "read once after --selftest passes and the synthetic leak test is clean.",
  writerExists: false, writerNote: "runner written by a builder agent on 2026-10-01; CANNOT MEASURE is a legitimate outcome, never a silent substitution",
  ip: "ours",
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: TODAY, area: "registry — R308 crest predictor", category: "registration", breaksComparability: false, change: `Registered R308: walk-forward LOGIT/GBM exit models on R307's surge trades (crest-passed label, 13 features known at each hour, exit at p >= 0.5, 48 h cap, 0.50% round trip), day-clustered t, bar ${b} (best-of-2, n ${N}); gates: shuffled-label placebo, paired vs FADE, halves, synthetic leak test.`, why: "Operator 2026-10-01: 'try it'.", doesNotEstablish: "Any result.", operator: "Josh 2026-10-01" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "register", tests: [ID], family: "CREST" }) + "\n");
console.log(`${ID} registered · bar ${b} (days, best-of-${CELLS}) · ${reg.preregistered.length} preregistered`);
