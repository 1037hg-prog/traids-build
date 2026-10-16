#!/usr/bin/env node
/** Registers R216 — month-end DOLLAR REVERSAL on spot FX before 2016 (out of sample). Motivation (disclosed, weightless): the R212 audit
 *  2026-09-24 (data/r212-r214-audit.json) found R212's pass carried by the dollar's own month-to-date move, not the equity-hedge signal
 *  (UUP 2016-2026, exploratory t 4.88). Spot FX before 2016 has not been examined by any TRAIDS test. Filed before any FX data is
 *  fetched. Refuses if R216 exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const { nullBar } = require("./lib/null-bar.js");
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R216")) { console.error("R216 already exists — refusing"); process.exit(2); }
const BAR = +nullBar({ variants: 2, n: 150, trials: 20000 }).p95.toFixed(3);
reg.preregistered.push({
  id: "R216", name: "Month-end dollar reversal — out of sample on spot FX before 2016: does the dollar give back its month-to-date move in the month's last sessions?",
  registered: "2026-09-24", evidenceStart: "historical: earliest Alpha Vantage FX_DAILY date through 2015-12 (never examined); 2016-2026 reported as in-sample context only",
  status: "REGISTERED 2026-09-24 — historical read pending", script: "backend/r216-usd-month-end.js",
  parent: "R212 audit 2026-09-24 (exploratory lead, weightless). Operator: 'keep mining'.",
  multiplicityFamily: "MINE-6b — one rule, two exit variants (best-of-2). Descends from MINE-6 R212; the lead was found in-sample on UUP 2016-2026, so only pre-2016 data can confirm it.",
  rule: [
    "Data: Alpha Vantage FX_DAILY (outputsize full) for EUR, GBP, JPY, CHF, AUD and CAD against USD. USD BASKET daily change = the equal-weight mean of the six daily log changes of the dollar's value (sign flipped for pairs quoted foreign-per-dollar vs dollar-per-foreign so that + = dollar up).",
    "Months = calendar months; sessions = the dates present in the data (weekdays). L = sessions in the month.",
    "SIGNAL: the basket's cumulative change from the prior month's last session to the close of session L-4 (known at entry).",
    "POSITION: AGAINST the signal — short the dollar basket if it rose month-to-date, long if it fell. Enter at the close of L-4.",
    "EXIT variant A (primary): close of L-2 (before the last day's London fix). Variant B: close of L-1 (includes the fix day).",
    "Cost 1 bp a side.",
  ],
  statistic: "Per month: signed window change minus sign x (window sessions) x the basket's mean daily change on the month's other sessions, minus cost; t over months, pre-2016 only. Best of the two exit variants against a best-of-2 bar. Reported: each pair alone; 2016-2026 on the same FX data (in-sample context); a skip-a-day signal (to L-5); the rule at mid-month windows.",
  bar: { fixedInAdvance: true, unit: "months (~150 pre-2016, depending on AV history depth)", tRequired: BAR, variants: 2, source: `nullBar({variants:2, n:150, trials:20000}).p95 = ${BAR}` },
  controls: { placebo: "random position signs (200 draws): the true t must beat p95", falsifier: "the same rule at a mid-month window (entry close of session 6) is reported; a comparable t there means it is generic dollar mean reversion, not a month-end flow" },
  interimKill: "n/a (historical)", readCondition: "one historical read; fewer than 60 pre-2016 months -> INCONCLUSIVE, sealed as such",
  decisionRule: { pass: "The month-end dollar reversal is out-of-sample real: register a forward paper test on UUP at month-ends (UUP is an exchange-traded fund, not the FX board class OP8 turned off) — operator's word.", fail: "The UUP 2016-2026 pattern was in-sample luck; month-end dollar ideas are closed." },
  expectation: "LOW-MED: month-end dollar demand around the fix is documented; a reversal conditioned on month-to-date is a narrower claim.",
  knownWeaknesses: ["The lead came from searching the R212 audit (window positions, a regression) on 2016-2026; only pre-2016 is clean.", "AV FX closes may not be at a fixed New York time.", "Six pairs co-move strongly; the basket is one bet, so months (not pairs) are the unit."],
  ip: "public FX data via Alpha Vantage; rule ours", writerExists: false,
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-24", area: "R216 month-end dollar reversal (pre-2016 FX) — registered", category: "registration", breaksComparability: false, change: `Out-of-sample check of the R212 audit lead; bar ${BAR}.`, why: "Operator: 'keep mining'.", doesNotEstablish: "Anything until the read.", operator: "Josh 2026-09-24" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R216"], detail: `month-end dollar reversal, pre-2016 FX, bar ${BAR}` }) + "\n");
console.log(`R216 registered · bar ${BAR}`);
