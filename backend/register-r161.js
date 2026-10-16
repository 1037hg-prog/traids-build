#!/usr/bin/env node
/** Registers R161 — 19 published price anomalies replicated on a survivorship-reduced panel, discovery 2017-2021, sealed holdout
 *  2022-2026. 2026-09-23, operator's ordered list item #1. Filed BEFORE any control, discovery or holdout statistic. Refuses if exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R161")) { console.error("R161 already exists — refusing"); process.exit(2); }
reg.preregistered.push({
  id: "R161", name: "Published price anomalies (19) — survivorship-reduced US panel, discovery 2017-2021, sealed holdout 2022-2026",
  registered: "2026-09-23", evidenceStart: "2017-01 (discovery); 2022-01 (holdout, sealed)",
  evidenceNote: "Historical. Panel: data/anomaly-cache (backend/anomaly-data.js) — every US common stock in Alpha Vantage LISTING_STATUS active + delisted-since-2016, Alpaca SIP daily adjusted bars, each listing clipped to its own dates, names with a >+300% one-day jump dropped. Registered before any statistic. The holdout months are computed only by --holdout, once, for the list sealed by --discovery.",
  status: "REGISTERED 2026-09-23 — controls, discovery (sealed), then one holdout read", script: "backend/r161-anomalies.js",
  parent: "Operator 2026-09-23: 'then this in your order' — item #1 of the four-part alpha plan: replicate documented anomalies on a proper holdout instead of mining popular scripts.",
  multiplicityFamily: "PRICE-ANOMALIES-19 at discovery (lenient screen, not a claim); holdout family = the k carried forward, bar = best-of-k NW t at n=57, simulated at discovery time and sealed with the list.",
  rule: "Monthly formation at month-end t using data through t's close; eligible: close >= $5, >= 252 days of history, top 1,500 by 60-day mean dollar volume; equal-weight quintiles; long-short in the literature's direction (see the script header for all 19 signals and signs); held month t+1 close-to-close, delisted names held at their last close; cost 0.25% x (long + short turnover) per month. Market factor = the panel's equal-weight daily return (SPY is not in a common-stock panel).",
  statistic: "Per anomaly: net long-short monthly spread; Newey-West t, lag 3.",
  bar: { fixedInAdvance: true, unit: "months", discoveryScreen: "net mean > 0 AND NW t >= 1.0 (2017-01..2021-12)", holdout: "net mean > 0, NW t >= best-of-k bar (n=57), both holdout halves positive", statistic: "Newey-West t, lag 3", tRequired: "set at discovery: best-of-k p95, n=57 — recorded in data/r161-discovery.json before the holdout is computed" },
  controls: { leakTest: "drift-free scrambled panel (each stock's daily returns permuted): every anomaly's discovery |t| < 2", positiveControl: "signal = next month's return: t >= 5" },
  interimKill: "none",
  decisionRule: { pass: "An anomaly that clears the holdout earns a forward paper test (a monthly rebalanced long-short or long-only sleeve on Alpaca paper) — nothing is funded on a backtest.", fail: "DID NOT PASS: the documented anomalies do not survive 2022-2026 net of cost in liquid US stocks; that is itself the answer to 'which still work'." },
  readCondition: "node backend/r161-anomalies.js --controls; then --discovery (seals the carried list and the bar); then --holdout once.",
  expectation: "I expect a few to survive discovery (low-vol/beta, 52-week high, short-term reversal are the usual survivors) and at most one to clear the holdout; post-publication decay (McLean-Pontiff) predicts roughly a third of the published premium, much of it eaten by cost in liquid names.",
  knownWeaknesses: ["Survivorship reduced, not removed: AV's delisted list misses some failures (see R158).", "Equal-weight portfolios in the top 1,500 by liquidity; the literature often uses value weights and all stocks — results can differ.", "No industry classification: industry momentum and industry-adjusted signals are not tested.", "No fundamentals: accounting anomalies (value, profitability, accruals) are out of scope.", "Discovery window 2017-2021 includes the 2020-21 speculative boom; holdout 2022-2026 a different regime — a genuine but harsh out-of-sample."],
  writerExists: true,
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-23", area: "R161 anomaly replication — registered", category: "registration", breaksComparability: false, change: "R161 registered before any statistic: 19 published price anomalies, discovery 2017-2021 (lenient screen), sealed holdout 2022-2026 with a best-of-k bar fixed at discovery.", why: "Operator's ordered plan, item #1.", doesNotEstablish: "Anything about accounting anomalies or other markets.", operator: "Josh 2026-09-23" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R161"], detail: "19 price anomalies, discovery + sealed holdout" }) + "\n");
console.log("R161 registered");
