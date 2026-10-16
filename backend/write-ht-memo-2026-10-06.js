#!/usr/bin/env node
// One-shot writer for data/ht-memo-seal.json, session 2026-10-06. Every figure below was read
// from its source file during this run (see sourcesRead). Writes nothing else.
const fs = require("fs"), path = require("path");
const OUT = path.join(__dirname, "data", "ht-memo-seal.json");

const memo = {
  session: "2026-10-06",
  forSession: "2026-10-07",
  sealedAt: new Date().toISOString(),

  header: {
    authority: "LIVE on the $100,000 paper AGENT BOOK only (operator directive 2026-08-28). No authority over the measurement book, no order path, no registered test touched.",
    graded: "HT1 (ht1-grade.json, asOf 2026-10-06T21:22:01.002Z): 11 of 20 graded memo-days, mean D +0.0396, t 0.712 against a 1.736 bar; void rate 45% (9/20) against a 20% void ceiling. ACCRUING. This seat decides nothing for any other seat tonight and says so.",
    directiveStanding: "NONE. directives[] is empty by design — lib/seat-authority.js consumes it live at the entry POST, and a t of 0.712 is not standing to veto or tilt another seat's entries.",
    poolingDisciplineRead_first: "data/pooling-audit.json asOf 2026-10-06T20:25:56.064Z — 14 aggregates checked, 9 FLAGGED. Every class-level and 4 of 5 strategy-level aggregates carry CONCENTRATION / SIGN-SPLIT / PAYOFF-SPLIT / STRUCTURE-SPLIT. No flagged pooled mean, win rate or class net is quoted bare anywhere in this memo."
  },

  dayInOneSentence: "Session 2026-10-06 settled 13 rows in the HT1 main-book population at mean -0.1212R (26 rows at -0.1236R and -$598.33 across the full signal population, 13 winners) against 210 control rows at -0.1064R — a broadly negative tape in which the book's selection was indistinguishable from its own controls, while intraday exposure touched the largest worst-case-open reading on file ($33,140, 33.14%, 146 tickets, 13:41:35Z) before closing at $18,426 and -$1,608 realized.",

  convergence: [
    {
      claim: "The binding problem tonight is SIZE, not selection — three seats reach it independently.",
      evidence: [
        "risk-governor.json (asOf 2026-10-06T21:41:47.119Z): ALLOW_WITH_REDUCED_BUDGET for 2026-10-07; close gross1R $18,426 (18.43%) leaves $1,574 under the $20,000 hard ceiling, thinner than 2026-10-05's $1,725; realizedToday -$1,608 sits $392 above the -$2,000 floor.",
        "portfolio-constructor sealed 2026-10-06T21:45:32.184Z: cut gross1R from 18.43% to 10% of capital, each class capped at 30% of gross1R, each class's net/gross directional skew capped at 20%.",
        "trade-autopsy.json (asOf 2026-10-06T20:28:20.235Z): 2,117 trades over 52 sessions, totalR -28.91, -$213; clusteredTrades 1,713 carry -38.14R while independent trades carry +9.23R, largestCluster 20. Its own reading: 'a large negative here is a SIZING failure, not a signal failure.'"
      ]
    },
    {
      claim: "CMI is the one instrument four seats are simultaneously on, which is why it is tonight's named name.",
      evidence: [
        "board_positions.json: one open CMI short, ticket 1791293985844-Equity-CMI-kmz0, Trend, entry 529.19, stop 548.3040378569177, $250 risk.",
        "stop-manager sealed 2026-10-06T21:48:44.992Z on that exact ticket id under the R54 1.5x-stop-width twin.",
        "agent-book.json: my own open head-trader ticket 1791238209623-Equity-CMI-ck2n, CMI short, entry 523.10, stop 542.4361, $250 risk, opened 2026-10-05, STANDALONE.",
        "ht1-grade.json: last night's CMI memo-day GRADED — A_d 0.0003, B_d -0.1212, D_d +0.1215, nNamed 1, nAllSettled 13."
      ]
    },
    {
      claim: "Data hygiene is clean tonight on the surfaces that would poison this memo.",
      evidence: [
        "claim-drift.json (asOf 2026-10-06T20:25:56.295Z): 60 files scanned, 11 claims registered, 3 checked, drifted 0, unresolvable 0, bySeverity WRONG 0 / VOLATILE 0. Caveat stated rather than buried: only 3 of 11 registered claims were actually matched and checked, so 'drifted 0' covers 3 claims, not 11.",
        "event-watch.json (asOf 2026-10-06T21:10:40.809Z): 267 open tickets, 83 events in a 14-day horizon, 10 carrying exposure, blindSources 0, riskUnknownFor 0. Largest single exposure: CPI 2026-10-14, market-wide, 267 tickets, $45,773 of risk dollars, 8 days out."
      ]
    }
  ],

  conflicts: [
    {
      name: "A CLEARED governor and the largest exposure breach on record are the same session, measured on different clocks.",
      detail: "risk-governor.json returns ALLOW_WITH_REDUCED_BUDGET on close-of-day proxies — $18,426 (18.43%) against a $20,000 hard ceiling, -$1,608 against a -$2,000 floor. The same file records worstCaseOpen peaking at $33,140 (33.14%, 146 tickets) at 13:41:35Z, 65.7% over the hard ceiling and its largest overage on file, and realizedToday bottoming near -$2,971 at 13:40:57Z, which would have tripped the -$2,000 rule had it been measured intraday. circuit-breaker.json is mode=observe with refusedToday 0 and wouldRefuseToday 0 — it logged no WOULD-HALT for any of it.",
      whyItMatters: "The registered rule is a close-of-day rule and the close was inside it, so the governor is not wrong. But 'nothing bound today' and 'the worst exposure day in the file' are both true of 2026-10-06, and anyone reading only the CLEARED line gets the wrong book. This is a measurement-clock gap, carried forward, not a new discovery.",
      owner: "risk-governor (to keep reporting both clocks); the observe-to-enforce flip is R304 and operator-gated, not mine."
    },
    {
      name: "My own CMI ticket is the tight-stop arm of a disagreement my own exit seat sealed the other side of.",
      detail: "My head-trader ticket 1791238209623-Equity-CMI-ck2n runs a 1.5x-ATR20 stop at 542.4361 — tighter than the board's own CMI stop. stop-manager sealed tonight that on ticket 1791293985844-Equity-CMI-kmz0 the R54 twin at 557.861 (+1.5x the board's 19.114-point distance, i.e. WIDER) beats the board's realized R by at least 0.0215R.",
      whyItMatters: "Both cannot be the better stop policy for CMI shorts. Neither has standing: R54's own interim figure is tClustered 1.335 on 178 episodes against a 1.68 bar. I am not resolving it tonight and I am not quietly sizing as if it were resolved.",
      owner: "stop-manager (R54 accrual); unresolved."
    },
    {
      name: "The agent book's headline beat is 85% hedge tickets.",
      detail: "agent-book-status.json: 85 settled over 25 sessions, +$702.95, meanR +0.0444, win 54.1%, day-clustered t 0.842; main book over the same sessions 418 tickets, -$2,507.24, meanR -0.0083, win 51.4%. Attribution: HEDGE 72 tickets ($303.05), STANDALONE 13 ($399.90). The file's own line: 'STANDALONE is the only arm that can carry an alpha claim.'",
      whyItMatters: "A hedge book can print a positive number by cancelling the main book's losses rather than by selecting anything. The alpha-capable arm is 13 tickets.",
      owner: "head-trader (this seat)."
    },
    {
      name: "The only large positive aggregate in the audit is not sayable as a sentence.",
      detail: "pooling-audit.json flags strategy:Breakout (n=38, +$26,152) SIGN-SPLIT: Crypto +$27,413 on 21 tickets, Equity -$1,418 on 16, Futures +$157 on 1. class:Crypto is separately flagged — top 17 of 329 tickets (5%) carry 268% of net P&L, and SIGN-SPLIT between Breakout (+$27,413) and Mean-Reversion (-$13,352).",
      whyItMatters: "'Breakout works' and 'crypto is the profitable class' are the same ~17 tickets said twice. Neither enters a decision here.",
      owner: "meta-analyst / portfolio-constructor."
    },
    {
      name: "news-trader is short a name into its own heavily positive news read.",
      detail: "news-trader sealed 2026-10-06T21:47:26.658Z: ACN open-to-close short, magnitude -0.5, for session 2026-10-07, with newsN 150, 102 positive / 9 negative, newsAvg +0.526, falsified by a positive open-to-close return. Links R13, R85.",
      whyItMatters: "It is a fade of its own signal's sign. That is a legitimate contrarian claim and it is sealed as one — but it is a shadow, not authority, and it sits beside last night's news-trader seal in which the R85 shadow-gate REFUSED an open CPT short.",
      owner: "news-trader."
    }
  ],

  decision: {
    one: "Tomorrow (2026-10-07) the TRAIDS book constructs at <=10% gross1R with the 30%-per-class and 20%-skew caps portfolio-constructor sealed tonight, instead of tonight's 18.43%.",
    evidence: [
      "trade-autopsy.json: clustered trades -38.14R vs independent +9.23R over 1,713 of 2,117 trades, 52 sessions — the loss is charged through repeat-sizing of single decisions.",
      "risk-governor.json: intraday worstCaseOpen $33,140 (33.14%) against a $20,000 hard ceiling on a day the governor cleared at close, with circuit-breaker mode=observe logging wouldRefuseToday 0.",
      "risk-governor.json limits: the hard ceiling binds at close on 12 of 35 sessions (34.3%) — it discriminates, it is not a formality."
    ],
    owner: "portfolio-constructor sets the cap (its own sealed claim, falsifiable 2026-10-13); risk-governor verifies it at the 2026-10-07 close.",
    notMine: "I issue no directive to enforce it. directives[] is empty: HT1 is t 0.712 against a 1.736 bar, and this seat has no graded standing to constrain another seat's entries."
  },

  wouldDo: {
    kind: "would-do",
    status: "HELD, not newly opened. I have live authority on the agent book and I am exercising it by holding the existing STANDALONE ticket rather than adding risk — opening new size on the night I name 'cut gross risk' as the one decision would be incoherent.",
    instrument: "CMI",
    direction: "short",
    riskDollars: 250,
    magnitudeUnit: "risk dollars — 0.25% of the $100,000 paper agent book, Equity base stake, sizeMult 1, inside the 0.5R cap; identical policy to the main book so the comparison stays apples to apples.",
    dated: "2026-10-07",
    hold: "1 session (the graded window). The agent book's own time cap governs settlement of the ticket itself.",
    ticketId: "1791238209623-Equity-CMI-ck2n",
    entryRef: 523.1,
    stopRef: 542.4361,
    qty: 12.929184,
    newTicketOpened: false,
    claim: "D_d = A_d - B_d > 0 on 2026-10-07: CMI's settled main-book rows beat the mean settled signal row that day.",
    falsifier: "D_d fails the HT1 bar — CMI's settled main-book rows on 2026-10-07 do not beat that day's mean settled signal row (D_d <= 0), or the memo-day fails to grade at all.",
    whyThisName: "Gradeability first, and said plainly: CMI appears in the HT1 graded population on 18 of 27 sessions since evidenceStart and 7 of the last 10 — the highest availability of any single name — and the 45% void rate against a 20% ceiling is the live threat to this seat's record, bigger than any edge question. Second, convergence: CMI is the one instrument the board, stop-manager, the agent book and HT1 are all on tonight.",
    whatIAmNotClaiming: "No edge. CMI's own measured mean in the HT1 population is +0.0142R over n=22 — indistinguishable from zero — and the sub-population it leans on sits inside pooling-audit's flagged class:Equity / strategy:Trend SIGN-SPLIT, which I therefore do not quote as a net. I named the most gradeable name with the most independent corroboration, not the most promising one.",
    differenceFromLastNight: "Last night's seal described the R54 twin as 'tighter' than my stop. Tonight's stop-manager seal makes it explicit that the R54 1.5x twin is WIDER (557.861 vs the board's 548.304). The correction is recorded rather than overwritten; it is named as conflict #2 above."
  },

  agentBookAction: {
    taken: "NONE this run. No open(), no close().",
    state: "agent-book.json: $100,000 capital, 15 open (trade-ranker 8, portfolio-manager 6, head-trader 1), 85 settled over 25 sessions, +$702.95, meanR +0.0444, win 54.1%, day-clustered t 0.842. Per seat: head-trader n=7 +$544.32 (71.4%), trade-ranker n=46 +$388.42 (54.3%), portfolio-manager n=32 -$229.79 (50%).",
    why: "The one decision tonight is to carry less gross risk, not more. My ledger entry for this session is MEASUREMENT.",
    peerShadowNoted: "portfolio-manager sealed a second SLV long top-up ($125, cluster risk 25) as the first agent-book ticket for 2026-10-07. That is its seat's call inside its own charter and enters here labelled as what it is — a peer seat's sealed shadow, not authority, and not something I endorse or block."
  },

  refusedToConclude: [
    {
      temptingRead: "'The agents beat the book they replaced' — +$702.95 and meanR +0.0444 against the main book's -$2,507.24 and -0.0083 over the same 25 sessions.",
      whyRefused: "Day-clustered t is 0.842 on 25 sessions, and 72 of 85 settled tickets are HEDGE ($303.05) against 13 STANDALONE ($399.90). A hedge book earns by cancelling the main book's losses, not by selecting; the arm that could carry an alpha claim is 13 tickets. The status file's own verdict is WATCHING, 'no verdict before the sample', and I am not stepping past it because the sign is flattering."
    },
    {
      temptingRead: "'Today should have halted, so the governor failed.'",
      whyRefused: "The registered rule is close-of-day and the close was inside it on all three limits ($1,574 of ceiling headroom, $392 of loss-rule headroom). Calling that a governor failure would be regrading a frozen rule against an unregistered clock. The honest statement is narrower and is the one I made: the limit as written did not bind, and the limit as experienced did."
    },
    {
      temptingRead: "'My CMI call is working' — last night's memo-day graded D_d +0.1215.",
      whyRefused: "One memo-day. HT1's mean D over 11 graded days is +0.0396 at t 0.712 against a 1.736 bar, and the 45% void rate means nearly half the record is not evidence at all. A single positive day in an ACCRUING series is a data point, not a result."
    }
  ],

  directives: [],
  directiveBasis: "No directive issued. lib/seat-authority.js consumes this array live at the entry POST; with HT1 at t 0.712 / 11 graded memo-days and a 45% void rate against a 20% ceiling, this seat has no graded standing to constrain any other seat's entries, and no operator is present to grant one.",

  sourcesRead: [
    { file: "data/pooling-audit.json", asOf: "2026-10-06T20:25:56.064Z", used: "read FIRST; 14 aggregates checked, 9 flagged — gates what may be quoted as a single number" },
    { file: "data/risk-governor.json", asOf: "2026-10-06T21:41:47.119Z", used: "ALLOW_WITH_REDUCED_BUDGET, close/intraday exposure and loss figures, limit bind rates" },
    { file: "data/seat-claims.jsonl", used: "tonight's sealed claims from risk-governor, portfolio-constructor, news-trader, stop-manager, portfolio-manager (103 rows on file)" },
    { file: "data/portfolio-manager-plans.jsonl", used: "PM lane cross-check against its sealed SLV claim" },
    { file: "data/agent-book.json + data/agent-book-status.json", asOf: "status written this run", used: "book and per-seat P&L, attribution split, main-book benchmark" },
    { file: "data/ht1-grade.json", asOf: "2026-10-06T21:22:01.002Z", used: "this seat's own graded record and last night's memo-day result" },
    { file: "data/r49-r53-gate-read.json + data/r49-spread-gate.json + data/r53-factor-cap.json", asOf: "2026-10-06T20:28:22Z", used: "R49 SEALED PASS (cost 0.1406R -> 0.0598R, D 0.07852R/day, t 6.705, 20 entry days; refused tail not distinguishable on gross rMult, t -0.095); R53 SEALED DID NOT PASS (-0.01875R/session, t -0.679 vs 1.72, 15 sessions)" },
    { file: "data/trade-autopsy.json", asOf: "2026-10-06T20:28:20.235Z", used: "clustering decomposition behind tonight's one decision" },
    { file: "data/event-watch.json", asOf: "2026-10-06T21:10:40.809Z", used: "event exposure, CPI 2026-10-14" },
    { file: "data/claim-drift.json", asOf: "2026-10-06T20:25:56.295Z", used: "drift check and its coverage caveat" },
    { file: "data/board_positions.json (read-only)", used: "open CMI ticket id, entry, stop, risk" },
    { file: "backend/lib/reconcile.js cleanEraLedger()", used: "settled-ledger day figures for 2026-10-06; HT1 population filter !ctrlRand && !vetoShadow && !sleeve" }
  ],

  standing: "Paper only. No orders placed. board_positions.json and trade_log.json untouched. No registered test, bar, population or read date altered."
};

fs.writeFileSync(OUT, JSON.stringify(memo, null, 2));
console.log("wrote", OUT, "session", memo.session, "forSession", memo.forSession);
console.log("wouldDo:", memo.wouldDo.direction, memo.wouldDo.instrument, "$" + memo.wouldDo.riskDollars, "| directives:", memo.directives.length);
