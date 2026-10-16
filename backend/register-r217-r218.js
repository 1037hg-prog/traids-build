#!/usr/bin/env node
/** Registers R217 + R218 — the dollar short-term reversal, operator 2026-09-24 ("1" = the FRED check and the UUP forward test).
 *  Motivation (disclosed): R216 sealed PASS out of sample (spot FX 2006-05..2015-12) and its exploratory audit showed the effect is not
 *  month-end-specific — the basket's last 2-3 weeks partly reverse over the next 3 sessions. R217 tests that ROLLING form on Federal
 *  Reserve H.10 data 1974..2006-04, which no TRAIDS test has touched. R218 runs it forward on Alpaca paper. Both specs are frozen here,
 *  before R217 is read. Refuses if either id exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const { nullBar } = require("./lib/null-bar.js");
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")); const ids = ["R217", "R218"];
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => ids.includes(t.id))) { console.error("R217/R218 exists — refusing"); process.exit(2); }
const BAR17 = +nullBar({ variants: 3, n: 388, trials: 20000 }).p95.toFixed(3), BAR18 = +nullBar({ variants: 1, n: 24, trials: 20000 }).p95.toFixed(3);
const FAM = "DOLLAR-REV — R216 (sealed PASS, month-end form) -> R217 rolling form on 1974-2006 Fed data (best-of-3 lookbacks) -> R218 forward on UUP (one fixed spec).";
reg.preregistered.push({
  id: "R217", name: "Dollar short-term reversal, rolling form — out of sample on Federal Reserve H.10 rates 1974-2006: does the dollar's last 2-4 weeks partly reverse over the next 3 sessions?",
  registered: "2026-09-24", evidenceStart: "historical: 1974-01-02..2006-04-30 (never examined; R216 began 2006-05)", status: "REGISTERED 2026-09-24 — historical read pending", script: "backend/r217-dollar-reversal-fred.js",
  parent: "R216 audit 2026-09-24 (not month-end-specific). Operator '1' 2026-09-24 approved the FRED fetch.", multiplicityFamily: FAM,
  rule: [
    "Data: FRED daily series DEXJPUS, DEXSZUS, DEXCAUS (foreign per dollar: + = dollar up), DEXUSUK, DEXUSAL (dollars per foreign: sign flipped), DEXGEUS through 1998-12-31 then DEXUSEU (sign flipped) from 1999-01-04. Downloaded as CSV from fred.stlouisfed.org (no key). Missing values ('.') are skipped per series.",
    "BASKET daily change = equal-weight mean of the available series' daily dollar log changes on dates where at least 4 series have a value on both the day and the prior valid day.",
    "Every 3rd basket date (from the first date with a full lookback), signal = the basket's cumulative change over the previous L dates. Position AGAINST the signal over the next 3 dates. L in {10, 15, 20}. Cost 1 bp a side, 2 bps per block (charged every block, flip or not).",
    "Bad-tick guard as R216's amendment: a series change > 5% that reverses >= 80% the next day is dropped (both changes) for that series.",
  ],
  statistic: "Per calendar month, the sum of the net block returns entered in that month; t over months (~388). Best of the three L values against a best-of-3 bar. Reported: each L; R216's month-end rule on the same data; 1974-1989 vs 1990-2006; 2006-05+ on FRED (in-sample context).",
  bar: { fixedInAdvance: true, unit: "months (~388)", tRequired: BAR17, variants: 3, source: `nullBar({variants:3, n:388, trials:20000}).p95 = ${BAR17}` },
  controls: { placebo: "random position signs (200 draws) on the best L: the true t must beat p95" },
  interimKill: "n/a (historical)", readCondition: "one historical read",
  decisionRule: { pass: "The rolling dollar reversal has 50 years of out-of-sample support: R218's forward result becomes the deciding evidence.", fail: "The 2006-2026 reversal is a recent-period effect; R218 continues (already registered) but with a low prior." },
  expectation: "MED: short-horizon currency reversal is documented; whether a 3-session hold clears 2 bps a block is open.",
  knownWeaknesses: ["H.10 are noon New York buying rates, not closes.", "1974-1998 uses DEM for EUR.", "The lookback grid (10/15/20) was chosen after seeing R216's audit window scan (L-4..L-13 month-to-date lengths)."],
  ip: "public Federal Reserve data; rule ours", writerExists: false,
});
reg.preregistered.push({
  id: "R218", name: "Dollar short-term reversal FORWARD — UUP on Alpaca paper, fading its own 15-session move, 3-session holds",
  registered: "2026-09-24", evidenceStart: "2026-09-28 (first rebalance session)", status: "REGISTERED 2026-09-24 — writer build pending", script: "backend/r218-dollar-reversal-forward.js",
  parent: "R216/R217 line. Operator '1' 2026-09-24.", multiplicityFamily: FAM,
  rule: [
    "Rebalance sessions: every 3rd NYSE session counted from 2026-09-28 (session 0).",
    "At about 15:45 ET on a rebalance session: signal = UUP's last trade divided by UUP's close 15 sessions earlier, minus 1. Target = -sign(signal) x $10,000 of UUP (SHORT if UUP rose, LONG if it fell; UUP is easy to borrow on Alpaca). A zero signal keeps the current position.",
    "Orders: market-on-close for the difference between the current UUP position and the target, submitted before the 15:50 ET MOC cutoff; client_order_id prefix r218-. OFF switch: data/r218-OFF. Paper only.",
  ],
  statistic: "Per calendar month: realised + marked P&L of the R218 UUP position (broker fills and closes) divided by $10,000; t over months. Reported: hit rate per block, P&L vs a same-schedule random-sign book, and the historical expectation from R217.",
  bar: { fixedInAdvance: true, unit: "months (24)", tRequired: BAR18, variants: 1, source: `nullBar({variants:1, n:24, trials:20000}).p95 = ${BAR18}; L=15 fixed a priori (the middle of R217's grid), before R217 is read` },
  controls: { placebo: "random-sign books on the same schedule and prices (200 draws): the true t must beat p95" },
  interimKill: "none (paper); monthly status only", readCondition: "read once after 24 complete months (~2028-09-30)",
  decisionRule: { pass: "A forward-verified dollar edge: operator decides on a real-money sleeve (funding is the operator's).", fail: "The dollar reversal does not survive real fills; the line is closed." },
  expectation: "LOW-MED: forward 24 months is under-powered for a ~17 bp/block effect; the read is a go/no-go on direction and costs, not a precise estimate.",
  knownWeaknesses: ["UUP tracks the ICE dollar index (EUR ~58%), not the six-pair basket.", "24 months is short.", "MOC fills on a thin ETF may cost more than 1 bp a side."],
  ip: "rule ours", writerExists: false,
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-24", area: "R217 (FRED 1974-2006) + R218 (UUP forward) — registered", category: "registration", breaksComparability: false, change: `R217 bar ${BAR17} (best-of-3 L); R218 bar ${BAR18} at 24 months, L=15 fixed`, why: "Operator: '1'.", doesNotEstablish: "Anything until the reads.", operator: "Josh 2026-09-24" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ids, detail: `dollar reversal: R217 FRED bar ${BAR17}; R218 UUP forward bar ${BAR18}` }) + "\n");
console.log(`R217 bar ${BAR17} · R218 bar ${BAR18}`);
