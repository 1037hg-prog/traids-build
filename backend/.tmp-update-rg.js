const fs = require("fs");
const P = "data/risk-governor.json";
const g = JSON.parse(fs.readFileSync(P, "utf8"));

const nowIso = new Date().toISOString();

g.asOf = nowIso;
g.forSession = "2026-10-08";
g.status = "HALT_NEW_TICKETS";

g.bindingConstraint = "risk-policy.json hardCeiling ($20,000/20% worstCaseOpen, close-of-day proxy): BREACHED at close tonight (2026-10-07) -- closed $20,921 (20.92%), $921/0.921pp OVER, ending a 9-session clean-close streak that ran 2026-09-24 through 2026-10-06 (the last breach-at-close was 2026-09-23, $20,358/+0.36pp). Current-epoch exposure ceiling (total-book worstCaseOpen proxy, $25,000/25%): closed $20,921, $4,079 headroom, NOT breached at close. Daily realized-loss rule (-$2,000): closed +$1,247 (positive -- the session's best realized print since 2026-10-05's +$998), nowhere near the floor; session minimum was only -$363 intraday (13:41Z), far short of -$2,000. HALT_NEW_TICKETS because the one limit that is both independently registered (risk-policy.json, not a runtime constant) and the most historically discriminating of the three (binds 13/36 close-of-day sessions, 36.1%) is in breach RIGHT NOW, at the moment new-ticket admission is being decided for 2026-10-08 -- opening more tickets only widens an already-open breach of the entire drawdown budget. The realized-P&L picture is unambiguously healthy (today was a de-risking, P&L-positive session: 143 tickets at 13:41Z down to 97 by 20:40Z, realizedToday climbing from -$363 to +$1,247) -- this is an EXPOSURE call, not a P&L-distress call.";

g.dataRead = {
  "portfolio-risk.jsonl": {
    path: "backend/data/portfolio-risk.jsonl",
    uniqueSessionsFound: 36,
    todayDate: "2026-10-07",
    close: {
      at: "2026-10-07T20:40:26.008Z",
      openTickets: 97,
      gross1R: 20921,
      gross1RPct: 20.92,
      worstCaseOpen: 20921,
      netDirectional: -515,
      realizedToday: 1247
    },
    intradayPeak_worstCaseOpen: {
      at: "2026-10-07T13:41:34.908Z",
      worstCaseOpen: 31992,
      worstCaseOpenPct: 31.99,
      openTickets: 143
    },
    intradayMin_realizedToday: -363,
    note: "Session 2026-10-07 opened at $31,992 (31.99%, 143 tickets) -- 59.96% over the $20,000 hard ceiling -- and the legacy per-snapshot halted field fired true at 13:41:34.908Z and 14:11:00.037Z, clearing by 14:40:56.695Z as the book de-risked. Unlike the prior 9 sessions (09-24 through 10-06), tonight's close did NOT fall back under the $20,000 hard ceiling: it bottomed out at $20,921 (20.92%) by 20:40:26.008Z, 97 tickets, realizedToday finishing +$1,247 (recovered steadily all session from an intraday low of only -$363 -- never a loss-distress session, purely an exposure one). Threshold backtest (worstCaseOpen>=20000 at close) across all 36 session-dates on file: 13/36 bind (36.1%), the FIRST new close-of-day bind since 2026-09-23 (prior count was 12/35)."
  },
  "circuit-breaker.json": {
    mode: "observe",
    topLevelHaltedFlag_today: false,
    refusedToday: 0,
    wouldRefuseToday: 0,
    note: "events[] has no 2026-10-07 entry (last logged event remains 2026-10-05) despite portfolio-risk.jsonl recording a $31,992 intraday peak, 28.0% over the breaker's own 25% epoch ceiling and 59.96% over the 20% hard ceiling -- now a 2-session-and-counting logging gap (10-06, 10-07), carried forward from the identical gap noted every recent run. mode=observe: nothing is enforced; this governor's recommendation does not depend on the breaker's own flag."
  },
  "risk-policy.json": {
    hardCeiling: 0.2,
    reviewTrigger: 0.1,
    note: "Unchanged since prior run. worstCaseOpenCapPct (25%) and dailyLossHaltDollars (-$2,000) remain runtime constants inside circuit-breaker.json / backend/lib/risk-policy.js, not registered fields of risk-policy.json -- same standing governance gap as every prior run."
  },
  "pooling-audit.json": {
    asOf: "2026-10-07T20:25:23.940Z",
    aggregatesChecked: 14,
    flagged: 9,
    note: "class:Options, class:Equity, class:Crypto, class:FX, class:Futures and 4 of 5 strategy aggregates carry CONCENTRATION/SIGN-SPLIT/PAYOFF-SPLIT/STRUCTURE-SPLIT flags (unchanged in kind from prior runs). Crypto: top 17 of 332 tickets (5%) carry 271% of net P&L, SIGN-SPLIT between Breakout (+27413) and Mean-Reversion (-13352) -- so Crypto net P&L is not a single-number-safe quantity and is not used as such here. No pooled mean or win-rate from this file is used anywhere in tonight's allow/halt decision -- that decision rests entirely on portfolio-risk.jsonl's dollar exposure sums (worstCaseOpen, realizedToday), which are not flagged aggregates."
  }
};

g.reconciliation = {
  assertReconciled: "invoked via backend/lib/reconcile.js CLI this run",
  result: "RECONCILED -- journal lag check: journalRows 9391, settledInCanon 9388, MISSING 0 (journal current). Canonical pooled edge -0.014R (n=2139 signals, n=6489 controls) read but NOT used in tonight's decision -- see poolingAuditCompliance_note.",
  note: "backend/lib/reconcile.js exists and is the required path for any ledger-derived figure. Run tonight to confirm data integrity (no DATA_INTEGRITY_HALT warranted); the halt/allow decision itself still rests entirely on portfolio-risk.jsonl's own pre-aggregated worstCaseOpen/realizedToday exposure snapshots, not on ledger-derived P&L."
};

g.limits = [
  {
    name: "hardCeiling (20% drawdown budget, worstCaseOpen close-of-day proxy)",
    file: "risk-policy.json",
    currentValue: 0.2,
    currentValueDollars: 20000,
    sessionsBound_atClose: "13/36 (36.1%)",
    sessionsBound_intraday: "26/36 (72.2%)",
    currentlyBound_atClose: true,
    currentlyBound_intraday: true,
    overageUSD_atClose: 921,
    overagePctPoints_atClose: 0.921,
    note: "BOUND at close tonight -- $921/0.92pp OVER, ending a 9-session clean streak (09-24 through 10-06). Most historically discriminating of the three limits at 36.1% of close-of-day sessions across 36 sessions (up from 34.3%/12-of-35 last night) -- binds sometimes, not always/never, and tonight it bound."
  },
  {
    name: "worstCaseOpenCapPct (current-epoch exposure ceiling, total-book proxy)",
    file: "circuit-breaker.json (runtime constant; not present in risk-policy.json)",
    currentValue: 25,
    currentValueDollars: 25000,
    sessionsBound_atClose: "6/36 (16.7%)",
    currentlyBound_atClose: false,
    currentlyBound_intraday: true,
    lastCloseValue: 20921,
    lastIntradayMax: 31992,
    note: "NOT bound at close tonight ($20,921 vs $25,000 -- $4,079 headroom). Bound intraday ($31,992, 28.0% over). Looser than the hard ceiling; not tonight's binding constraint at close, though it is closer than most prior clean nights."
  },
  {
    name: "dailyLossHaltDollars",
    file: "circuit-breaker.json (runtime constant; not present in risk-policy.json)",
    currentValue: -2000,
    sessionsBound_atClose: "3/36 (8.3%)",
    sessionsBound_intraday: "5/36 (13.9%)",
    currentlyBound_atClose: false,
    intradayTripToday: false,
    lastCloseValue: 1247,
    intradayMinToday: -363,
    note: "Not bound at close or intraday tonight -- realizedToday never worse than -$363 and finished +$1,247, the healthiest realized print since 10-05. Confirms tonight's HALT is an exposure call, not a P&L-distress call: the book is losing nothing today, it is simply carrying more worst-case risk than the entire drawdown budget allows."
  }
];

g.todaysNumbers = {
  date: "2026-10-07",
  closeSnapshotAt: "2026-10-07T20:40:26.008Z",
  openTickets: 97,
  gross1R: 20921,
  gross1RPct: 20.92,
  worstCaseOpen_close: 20921,
  worstCaseOpen_intradayMax: 31992,
  openTickets_intradayMax: 143,
  exposureCeiling_epoch: 25000,
  hardDrawdownBudget: 20000,
  overHardCeiling_atClose_USD: 921,
  overHardCeiling_atClose_PctPoints: 0.921,
  headroomVsEpochCeiling_atClose_USD: 4079,
  overHardCeiling_intradayMax_USD: 11992,
  overHardCeiling_intradayMax_PctOfCeiling: 59.96,
  overEpochCeiling_intradayMax_USD: 6992,
  overEpochCeiling_intradayMax_PctOfCeiling: 28.0,
  netDirectional: -515,
  realizedToday_close: 1247,
  realizedToday_intradayMin: -363,
  byClass_close: {
    Options: { n: 8 },
    Crypto: { n: 24 },
    Equity: { n: 48 },
    FX: { n: 16 },
    Futures: { n: 1 }
  }
};

g.reasoning = [
  "Q1 (may the book open another ticket for 2026-10-08?): HALT_NEW_TICKETS. Worst-case-open closed tonight at $20,921 (20.92%), $921/0.92pp OVER the $20,000 hard ceiling -- the entire drawdown budget is already spoken for by open positions alone, before any new ticket is added. realizedToday closed +$1,247 (healthy, never worse than -$363 intraday), so this is an exposure constraint, not a loss-distress constraint. New tickets would widen an already-open breach.",
  "Q2 (which limit binds, how often, across 36 sessions): hardCeiling ($20,000/20%) remains most discriminating at close -- 13/36 (36.1%), UP from 12/35 last night because tonight is a fresh bind. The epoch ceiling ($25,000/25%, 6/36=16.7%) and the daily-loss rule (-$2,000, 3/36=8.3%) are both slacker and both idle tonight. All three bind sometimes and none is decorative; tonight the hardCeiling is the one doing all the work.",
  "Q3 (would a halt have helped?): grading seq 99 (direction=allow, falsifier realizedToday<=-2000 for 2026-10-07): actual close +$1,247, NOT FALSIFIED -- the allow call for today survives comfortably (today's intraday low was only -$363). But today's own close is itself the new breach this governor must act on for tomorrow: a close-of-day exposure reading, not a realized-loss reading, is what is now binding. The 2026-08-24 lesson (a halt would have cut short a +$18,785 day) is NOT in play here -- nothing about tonight's HALT recommendation rests on today's P&L, which was good.",
  "Q4 (is the 20% drawdown ceiling reachable from current exposure?): YES, and it is not merely reachable -- it is ALREADY BREACHED at tonight's close. 13 of 36 sessions (36.1%) have now closed with worstCaseOpen alone >= the entire $20,000 hard ceiling, and tonight is one of them ($20,921, $921 over). One fully-adverse resolution of the open book, with zero new tickets, already exceeds the entire registered peak-to-trough drawdown budget.",
  "Q5 (gap-stress exposure): not re-measured tonight (out of scope for the single sealed question); carried forward from prior reads at ~33% of the tail with no stop-width reach -- unchanged input, not re-verified this session."
];

g.wouldHaltHaveHelped_note = "Grading seq 99 (prior sealed claim, window closed 2026-10-07T20:05:00Z, direction=allow, falsifier: realizedToday_close <= -2000): actual 2026-10-07 close realizedToday=+$1,247 -- NOT <= -$2,000, so the claim is NOT FALSIFIED. Today's intraday realized P&L minimum was -$363 (at the session's 13:41:34.908Z worst-case-open peak of $31,992/31.99%, 59.96% over the hard ceiling) -- even an INTRADAY version of the -$2,000 daily-loss halt would not have fired today. The allow call for 2026-10-07 survives both the close-only test it was sealed against and a stricter intraday read. None of this bears on tonight's HALT_NEW_TICKETS call for 2026-10-08, which is driven by the close-of-day EXPOSURE breach, not by any realized-loss signal.";

g.gapStressExposure_note = "Not re-measured tonight (out of scope for the single sealed question); prior reads stand at ~33% of the tail with no stop-width reach -- unchanged input, not re-verified this session.";

g.poolingAuditCompliance_note = "class:Crypto, class:Equity, class:Options, class:FX, class:Futures and 4 of 5 strategy aggregates all carry CONCENTRATION/SIGN-SPLIT/PAYOFF-SPLIT/STRUCTURE-SPLIT flags, quoted above WITH their flags attached, not bare. No pooled mean or win-rate from pooling-audit.json is used anywhere in the halt/allow decision itself -- that decision rests entirely on portfolio-risk.jsonl's dollar exposure sums. Concentration figures quoted are shares of ABSOLUTE net P&L, never re-based to net R, per standing rule.";

g.breachHistory.push({
  at: "2026-10-07T13:41:34.908Z",
  forSession: "2026-10-07",
  type: "EXPOSURE_CEILING_BREACH (intraday, both ceilings, day's opening snapshot IS the high-water mark, PARTIALLY resolved by close)",
  detail: "Total-book worst-case-open opened the session at $31,992 (31.99% of capital) at 13:41:34.908Z -- 28.0% over the $25,000/25% current-epoch ceiling and 59.96% over the $20,000/20% hard drawdown ceiling, on 143 open tickets. The board's own legacy per-snapshot halted field fired true at this instant and again at 14:11:00.037Z, clearing by 14:40:56.695Z. No corresponding circuit-breaker.json event was logged for this date (events[] still ends 2026-10-05) -- a 2-session-and-counting breaker-logging gap, confirmed independently from portfolio-risk.jsonl. De-risked to 97 tickets / $20,921 by 20:40:26.008Z close, realizedToday improving from -$363 to +$1,247 over the session.",
  totalWorstCaseOpen_intradayMax: 31992,
  openTicketsAtPeak: 143,
  ceiling_epoch: 25000,
  ceiling_hard: 20000,
  resolved: "PARTIALLY -- epoch ceiling cleared by close ($20,921 < $25,000), hard ceiling was NOT (see next entry)",
  source: "backend/data/portfolio-risk.jsonl rows for 2026-10-07; no corresponding circuit-breaker.json event found for this date (gap noted, now 2 consecutive sessions unlogged by the breaker)"
});

g.breachHistory.push({
  at: "2026-10-07T20:40:26.008Z",
  forSession: "2026-10-07",
  type: "HARD_CEILING_BREACH_AT_CLOSE (fresh breach, ends a 9-session clean-close streak: 09-24, 09-25, 09-28, 09-29, 09-30, 10-01, 10-02, 10-05, 10-06)",
  detail: "Book closed the 2026-10-07 session at $20,921 worst-case-open (20.92% of the $100k book) against the risk-policy.json hardCeiling of $20,000 (20%) -- $921 / 0.921 percentage points OVER, AT CLOSE. This is the first close-of-day breach since 2026-09-23 ($20,358/+0.36pp), breaking a 9-session clean streak that included two sessions closing within roughly $1,000 of the line (10-02: $997 headroom; 10-06: $1,574 headroom) without crossing it. The current-epoch exposure ceiling ($25,000/25%) was NOT breached at close ($20,921 < $25,000, $4,079 headroom), consistent with the standing pattern: the registered risk-policy.json limit breaches independently of the looser circuit-breaker.json runtime ceiling. realizedToday closed strongly positive (+$1,247), so this breach does not coincide with a losing session -- it is a pure exposure reading.",
  worstCaseOpen_close: 20921,
  ceiling_hard: 20000,
  overCeilingByUSD: 921,
  overCeilingByPctPoints: 0.921,
  ceiling_epoch: 25000,
  epochHeadroomUSD: 4079,
  realizedToday_close: 1247,
  worstCaseOpen_intradayMax: 31992,
  openTickets_intradayMax: 143,
  openTickets_close: 97,
  streakSessionsEnded: 9,
  resolved: false,
  note: "Not resolved as of this write. This governor's sealed claim for 2026-10-08 is direction=halt on the strength of this open, unresolved, fresh breach.",
  source: "backend/data/portfolio-risk.jsonl (close snapshot, last row for 2026-10-07, 2026-10-07T20:40:26.008Z)"
});

g.breachHistory.push({
  at: nowIso,
  forSession: "2026-10-07 (grading a PRIOR claim's window, which closed tonight)",
  type: "CLAIM_OUTCOME (grading the seq-99 sealed claim: forSession 2026-10-07, window closed 2026-10-07T20:05:00.000Z)",
  detail: "Sealed claim seq 99 (kind=halt, direction=allow, magnitude=1574, sealed 2026-10-06) stated falsifier: realized P&L at or below -2000 dollars for the 2026-10-07 session. Tonight's actual close: realizedToday = +$1,247, which is NOT <= -$2,000. By its own literal wording the claim is NOT FALSIFIED -- it survives. The session did carry meaningful intraday exposure (worst-case-open peaked at $31,992/31.99%, 143 tickets, 59.96% over the hard ceiling) but the realized-P&L leg the claim tested never came close to the -$2,000 line (intraday minimum only -$363).",
  claimSeq: 99,
  claimDirection: "allow",
  falsifierCondition: "realizedToday_close <= -2000",
  realizedToday_close_actual: 1247,
  worstCaseOpen_close_actual: 20921,
  graded: "NOT FALSIFIED",
  resolved: true,
  note: "This grading does NOT change tonight's HALT_NEW_TICKETS recommendation for 2026-10-08 -- that recommendation is a fresh, independent reading off tonight's own close (a hard-ceiling breach), not a re-assertion of the seq-99 claim.",
  source: "backend/data/seat-claims.jsonl (seq 99) cross-checked against backend/data/portfolio-risk.jsonl close-of-day rows for 2026-10-07"
});

fs.writeFileSync(P, JSON.stringify(g, null, 1) + "\n");
console.log("wrote", P, "breachHistory length now", g.breachHistory.length);
