#!/usr/bin/env node
/** Registers R271 (options-whale prints, HISTORICAL, Alpaca option daily bars 2024-02..2026-09) and R272 (options-whale prints,
 *  FORWARD, volume vs open interest from a daily Schwab chain record). Operator 2026-09-27: "yes register and build both".
 *  Written BEFORE any option-flow data was fetched; the only probe was one AMD contract list + two bars to confirm the API works.
 *  Refuses if either id exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const { nullBar } = require("./lib/null-bar.js");
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
const all = [...(reg.tests || []), ...(reg.preregistered || [])];
for (const id of ["R271", "R272"]) if (all.some((t) => t.id === id)) { console.error(`${id} exists — refusing`); process.exit(2); }
const BAR271 = +nullBar({ variants: 1, n: 400, trials: 20000 }).p95.toFixed(3);
const BAR272 = +nullBar({ variants: 1, n: 60, trials: 20000 }).p95.toFixed(3);

const COMMON_SIGNAL = [
  "Universe: the 80 names in data/r147-earnings (built for R147, not chosen for this test).",
  "Contract filter on signal day d: DTE 1..45 calendar days; OTM by at least 2% of the underlying's RAW close on d (call strike >= 1.02 x close, put strike <= 0.98 x close) and at most 25%.",
  "Size filter: contract volume on d >= 500 AND premium = volume x price x 100 >= $500,000.",
  "Direction per name-day: net premium = sum(call whale premium) - sum(put whale premium) over qualifying contracts; > 0 bullish (long), < 0 bearish (short). One signal per name-day.",
  "Trade: enter the underlying at the OPEN of d+1, exit at the CLOSE of the 5th trading day counted from d+1 (d+5 close). Signed raw return (long for bullish, short for bearish), split-adjusted prices, minus 20 bps round trip.",
];
const STAT = "Clustering unit = SIGNAL DATE: per date, the equal-weighted mean of signed net returns over every name signalling that date; one-sample t over dates. RAW signed P&L is reported first (no drift subtraction).";
const CONTROL = "Timing control (direction held): for each signal (name, direction), a random non-signal trading day of the SAME name with the SAME direction; 1,000 draws of the whole date-clustered mean. PASS needs t >= bar AND the observed mean above the control's 95th percentile.";

reg.preregistered.push({
  id: "R271", name: "Options whale prints (HISTORICAL) — does unusually large OTM option volume predict the underlying's next 5 days?",
  registered: "2026-09-27", evidenceStart: "2024-02-01", status: "REGISTERED 2026-09-27 — historical, read once after the collection completes; no flow data fetched before registration", script: "backend/r271-options-whale-hist.js",
  parent: "Operator 2026-09-27: 'do we have an options whale tracker' → 'yes register and build both'. Services like Unusual Whales sell this signal.",
  multiplicityFamily: "OPTFLOW-1 — R271 (historical, own-history volume spike) and R272 (forward, volume vs open interest). One primary each.",
  rule: [...COMMON_SIGNAL,
    "Unusual (R271 version, no open-interest history on Alpaca): volume on d >= 5 x the contract's mean daily volume over the 10 prior trading days (days with no bar count as 0) AND the contract has at least 3 prior trading days of bars. Price = the bar's volume-weighted price (vw).",
    "Collection: contracts from Alpaca /v2/options/contracts (status inactive + active), expirations 2024-02-01..2026-09-25, strikes within +/-30% of the underlying's raw close 45 calendar days before expiry (or its first available close); daily bars from /v1beta1/options/bars. Signals on d <= 2026-09-17 (so every exit has printed)."],
  statistic: STAT, controls: { timing: CONTROL },
  bar: { fixedInAdvance: true, unit: "signal dates", tRequired: BAR271, variants: 1, source: `nullBar({variants:1, n:400, trials:20000}).p95 = ${BAR271}` },
  secondary: "Reported, not graded: 1-day and 20-day horizons; bullish and bearish sides separately; stress cost 50 bps; share of signals within 3 trading days of an earnings report (from data/r147-earnings) and the result with those excluded.",
  interimKill: "none (single historical read)", readCondition: "read once, after --collect finishes for all 80 names (collection logged with counts of contracts and requests).",
  decisionRule: { pass: "Candidate for the forward book: R272's forward record decides whether it is traded (operator's call).", fail: "The public-bar version of 'follow the whales' is closed; R272 still records (open interest is information R271 lacks)." },
  expectation: "LOW: the academic result (Pan & Poteshman 2006) needed signed opening-buyer volume, which public prints do not carry; much of the flagged volume is hedging, closing, or spread legs. Earnings-week volume will dominate.",
  knownWeaknesses: ["No buyer/seller side: a large call print can be a covered-call SALE (bearish-neutral) and a large put print a cash-secured put SALE (bullish).", "No open-interest history, so 'opening' volume cannot be separated from closing volume.", "Multi-leg spreads print as separate large legs and can cancel or mislead the net premium.", "Strike window fixed at 45 days before expiry; an underlying that moved >30% can leave qualifying strikes unfetched (symmetric, undirected).", "Universe is today's list (survivorship: names that exist and are liquid now).", "Alpaca daily option bars are trades on the consolidated tape; vw is the day's volume-weighted trade price, not a mid."],
  ip: "ours", writerExists: false,
});
reg.preregistered.push({
  id: "R272", name: "Options whale prints (FORWARD) — volume far above open interest on OTM contracts, next 5 days of the underlying",
  registered: "2026-09-27", evidenceStart: "2026-09-28", status: "REGISTERED 2026-09-27 — forward; recorder backend/options-flow-record.js (intraday 15:30-15:55 ET) + grader backend/r272-options-flow-forward.js (close chain)", script: "backend/r272-options-flow-forward.js",
  parent: "Operator 2026-09-27 (as R271). The classic retail 'unusual options activity' definition: today's volume several times the open interest.",
  multiplicityFamily: "OPTFLOW-1 (see R271).",
  rule: [...COMMON_SIGNAL,
    "Unusual (R272 version): volume on d >= 5 x open interest (Schwab's open interest in the same snapshot = the prior session's settled OI) AND open interest >= 1 (new strikes with zero OI are counted when volume >= 500 by treating OI as 100).",
    "Snapshot: Schwab /marketdata/v1/chains per name, taken once between 15:30 and 15:55 ET (the near-close intraday fire); volume is the day's total to that moment; price = the snapshot mid ((bid+ask)/2), falling back to last if the mid is missing.",
    "Signals are graded only for sessions with a complete snapshot (>= 90% of names recorded); an incomplete day is logged and excluded, never back-filled."],
  statistic: STAT, controls: { timing: CONTROL + " Drawn from the recorded forward days only." },
  bar: { fixedInAdvance: true, unit: "signal dates", minDates: 60, tRequired: BAR272, variants: 1, source: `nullBar({variants:1, n:60, trials:20000}).p95 = ${BAR272}` },
  secondary: "As R271, plus the R271 own-history definition run on the same forward record once 10 prior snapshots exist.",
  interimKill: "none", readCondition: "read once at >= 60 signal dates AND >= 90 calendar days from 2026-09-28 (~early 2027).",
  decisionRule: { pass: "Operator decides whether a small paper sleeve trades it; any live use is his call.", fail: "The options-whale idea is closed for public data; the recorder stops." },
  expectation: "LOW (as R271). Open interest removes one confound (closing trades cannot exceed prior OI by 5x), which is why this version is recorded forward.",
  knownWeaknesses: ["The 15:30-15:55 snapshot misses the last minutes of volume.", "Still no buyer/seller side.", "A missed intraday fire loses the day (no reconstruction: Schwab has no historical chains).", "Schwab chain depth per name is capped by strikeCount; far-OTM strikes beyond it are not seen."],
  ip: "ours", writerExists: false,
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-27", area: "R271/R272 options whale prints — registered", category: "registration", breaksComparability: false, change: `R271 historical (Alpaca option bars, own-history spike, bar ${BAR271}); R272 forward (Schwab chain volume vs OI, bar ${BAR272} at >= 60 signal dates)`, why: "Operator: register and build an options whale tracker.", doesNotEstablish: "Anything until the reads.", operator: "Josh 2026-09-27" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R271", "R272"], detail: `options whale prints: hist bar ${BAR271}, forward bar ${BAR272}` }) + "\n");
console.log(`R271 registered · bar ${BAR271}\nR272 registered · bar ${BAR272}`);
