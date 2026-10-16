#!/usr/bin/env node
/** Registers R304 — does the board circuit breaker earn enforcement? (operator 2026-10-01: "yes check why the breaker halted" ->
 *  "yes run it" -> "yes register it"). A 17-halt-day preview (2026-08-25..09-25) was SEEN before this registration: signal tickets
 *  opened after the day's would-halt averaged -0.031R (t -0.89, -$2,192) vs +0.028R for time-matched tickets on non-halt days. It is
 *  disclosed as weightless motivation; the test is FORWARD from 2026-10-02. Bar = nullBar({variants:1, n:30}).p95, one-sided negative.
 *  Refuses if the id exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { nullBar } = require("./lib/null-bar.js");
const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
const ID = "R304", TODAY = "2026-10-01", N = 30;
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === ID)) { console.error(`${ID} exists — refusing`); process.exit(2); }
const b = +nullBar({ variants: 1, n: N, trials: 20000 }).p95.toFixed(3);
reg.preregistered.push({
  id: ID, registered: TODAY, name: "Circuit-breaker enforcement value: do the signal tickets opened after the day's first would-halt lose?",
  status: `REGISTERED ${TODAY} — forward from 2026-10-02; writer live (close chain)`, script: "backend/r304-breaker-enforce.js",
  parent: "Operator 2026-10-01. Preflight showed 'CIRCUIT BREAKER HALTED'; it was an observe-mode WOULD-HALT (capped exposure $29,071 >= $25,000 at 09:50 ET). The breaker would-halted on 12 of the last 15 sessions; enforcing it refuses every new board ticket for the rest of the day.",
  multiplicityFamily: "BREAKER — R304 alone; one cell (the breaker as configured).",
  evidenceStart: "2026-10-02",
  rule: "Breaker as configured at registration: lib/risk-policy.js breakerMode 'observe'; capped-exposure ceiling $25,000 (25% of the $100k book); realized day loss -$2,000. HALT DAY = an ET session with a HALT/WOULD-HALT event in data/circuit-breaker.json; halt time = the day's FIRST event. REFUSED-IF-ENFORCED tickets = canonical SIGNAL tickets (lib/reconcile.js cleanEraLedger().signals, assertReconciled) opened that day at or after the halt time. A day enters once it is 7 calendar days old (about 5 sessions, so its tickets have settled); days with no such ticket are counted separately and carry no value.",
  statistic: "A_d = mean rMult of the refused-if-enforced signal tickets on halt day d. One-sample t of A_d over halt days (unit: halt days). One-sided: enforcement is warranted only by NEGATIVE values.",
  unit: "halt days", nExpected: N,
  controls: { timeMatched: "signal tickets opened >= 09:45 ET on non-halt days (per-day means) — separates the breaker condition from time of day", sameDay: "tickets opened before the halt on the same day", marketDay: "CONTROL tickets after the halt (the market-day effect; if they lose as much, the loss is the day, not the signals)", dollars: "refused-ticket P&L in dollars beside R" },
  bar: { fixedInAdvance: true, unit: "halt days", tRequired: b, oneSided: "negative: verdict ENFORCE WARRANTED needs t <= -tRequired", variants: 1, source: `nullBar({variants:1, n:${N}, trials:20000}).p95 = ${b}` },
  interimKill: "none (observation only; it refuses nothing and costs nothing)",
  configGuard: "A halt event naming another ceiling or loss threshold, or breakerMode other than 'observe', freezes the day count at the first night the change is seen (persisted). The read is then taken on the days before it, or the operator mints a successor.",
  decisionRule: {
    pass: "ENFORCE WARRANTED: t <= -bar over the first 30 halt days. Recommends switching breakerMode to 'enforce' — the operator's call (it also cuts the board's evidence by the refused share).",
    fail: "NOT WARRANTED: observe mode stays; the breaker remains a reported risk flag. The operator may still enforce on risk grounds — this test only answers whether the refused tickets lose.",
  },
  knownWeaknesses: [
    "The preview (17 halt days, mean -0.031R, t -0.89) was seen before registration and motivated it; it is weightless and excluded (evidence from 2026-10-02).",
    "Equity rMult is gross of cost (2026-09-30 audit settle#3): refused equity tickets look better than they are, which biases AGAINST 'enforce warranted'.",
    "Tickets still open after 7 days (long R14-style holds) are not in A_d; if losers are held longer, A_d is flattered. The output reports per-day counts.",
    "Enforcing would also refuse CONTROL tickets, cutting every board test's sample; that cost is not in this statistic and belongs to the operator's decision.",
    "Halts cluster on high-exposure days that may be bad market days in general; the control-tickets diagnostic is reported to separate that.",
  ],
  readCondition: "--read once at 30 halt days with refused tickets (about 7-8 weeks at the recent rate); seals in read-seals.json.",
  writerExists: true, writerNote: "backend/r304-breaker-enforce.js written and selftested 2026-10-01 (6 known answers); nightly in the close chain; first row written at registration (0 evidence days).",
  ip: "ours",
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: TODAY, area: "registry — R304 circuit-breaker enforcement value", category: "registration", breaksComparability: false, change: `Registered R304 forward from 2026-10-02: signal tickets opened after the day's first would-halt, mean R per halt day, one-sided t <= -${b} over 30 halt days (nullBar n ${N}). Writer backend/r304-breaker-enforce.js in the close chain. Preview 08-25..09-25 disclosed as weightless.`, why: "Operator 2026-10-01: 'yes register it'.", doesNotEstablish: "Any result; the breaker stays in observe mode.", operator: "Josh 2026-10-01" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "register", tests: [ID], family: "BREAKER" }) + "\n");
console.log(`${ID} registered · bar t <= -${b} (halt days, one-sided) · ${reg.preregistered.length} preregistered`);
