const fs = require('fs');
const path = require('path');
const RP = require('./backend/lib/risk-policy.js');
const rc = require('./backend/lib/reconcile.js');

const nowISO = new Date().toISOString();
const L = rc.cleanEraLedger();
const jlag = rc.journalLag();

const positions = JSON.parse(fs.readFileSync('backend/data/board_positions.json','utf8'));
const tradeLog = JSON.parse(fs.readFileSync('backend/data/trade_log.json','utf8'));
const agg = RP.aggregate(positions, tradeLog, Date.now());

const eq = JSON.parse(fs.readFileSync('scratch_equity_curve.json','utf8'));

const prior = JSON.parse(fs.readFileSync('backend/data/risk-governor.json','utf8'));

const poolAudit = JSON.parse(fs.readFileSync('backend/data/pooling-audit.json','utf8'));

const clusterLedger = JSON.parse(fs.readFileSync('backend/data/cluster-pnl-ledger.json','utf8'));

const preflight = JSON.parse(fs.readFileSync('backend/data/preflight-status.json','utf8'));

const r53 = JSON.parse(fs.readFileSync('backend/data/r53-factor-cap.json','utf8'));

const bearLive = JSON.parse(fs.readFileSync('backend/data/bear-gauge-live.json','utf8'));

const floorAtCeiling = eq.finalPeak * 0.8;
const ddBudgetUSD = eq.finalEquity - floorAtCeiling;
const worstCaseOpen = agg.worstCaseOpen;
const stressDD_full = (eq.finalPeak - (eq.finalEquity - worstCaseOpen)) / eq.finalPeak * 100;
const repeat0820Loss = 20182.02;
const ddIf0820RepeatToday = (eq.finalPeak - (eq.finalEquity - repeat0820Loss)) / eq.finalPeak * 100;

const out = {
  spec: "risk-governor pre-open verdict",
  asOf: nowISO,
  judgedFor: "2026-08-31 (PRE-OPEN, ~08:47-09:00 ET) -- Monday after a weekend of overnight crypto/FX settles; last full session Friday 2026-08-28",
  status: "ALLOW_WITH_REDUCED_BUDGET",

  reconciliation: {
    canonicalSource: "data/trade_log.json",
    epoch: "2026-07-20T00:00:00 local (registered)",
    signalsN: L.n,
    controlN: L.controlN,
    pooledEdgeR: L.pooledEdgeR,
    journalLag: jlag.exists ? { missing: jlag.missing, note: jlag.note } : { exists: false },
    boardAggregateSource: "backend/lib/risk-policy.js aggregate(), run live against board_positions.json + trade_log.json at asOf -- reproduces the current row of data/portfolio-risk.jsonl exactly (verified: openTickets 100, gross1R 22057, worstCaseOpen 13245 match the 2026-08-31T12:45:20Z snapshot).",
    note: "Ledger read only through backend/lib/reconcile.js cleanEraLedger(); journal is current (0 rows missing). Board risk figures computed fresh in this run, not read from circuit-breaker.json (which is stale -- still shows date 2026-08-29)."
  },

  METHODOLOGY_CORRECTION_THIS_RUN: {
    severity: "MAJOR -- changes the answer to question 4 and the whole book's drawdown history",
    whatWasWrong: "The 2026-08-28 risk-governor.json computed 'currentPeakEquityUSD'/'currentEquityUSD'/'maxRealizedDrawdownEverPct' from backend/lib/reconcile.js cleanEraLedger().signals ONLY -- i.e. it excluded every real, capital-consuming CONTROL ticket (t.ctrl && !t.vetoShadow) from the equity curve. That population choice is correct for the RESEARCH EDGE (signal-vs-control comparison, which is what cleanEraLedger exists to serve) but wrong for portfolio-wide DRAWDOWN, because control tickets are NOT hypothetical: board_positions.json shows they carry real riskDollars and sizeLabel fields identical in structure to signal tickets (verified directly, e.g. a currently-open CRUS control position sized at $250 risk / $5,463 notional), and backend/lib/risk-policy.js's OWN aggregate() function -- the literal code that produces every number in data/portfolio-risk.jsonl and drives the live circuit breaker -- includes ctrl tickets in gross1R, worstCaseOpen and realizedToday, excluding only isSleeve and vetoShadow rows. In other words: every 'gross1R'/'worstCaseOpen' figure this whole apparatus has been reporting for 11 days ALREADY blends real signal and real control risk into one number. The prior drawdown read used a narrower, inconsistent population for the one figure (drawdown) that is supposed to be the hardest ceiling of all.",
    populationUsed: "signals (!ctrl) UNION real controls (ctrl && !vetoShadow), excluding sleeves (own book) and vetoShadow (refused, never opened), closedAt >= clean epoch 2026-07-20, finite pnl and rMult -- same filter risk-policy.js aggregate() applies to realizedToday, just extended across the full history instead of one day.",
    verifiedAgainstTaskFraming: "2026-08-20 in this population: 53 real rows, -$20,182. The narrower signals-only population (cleanEraLedger) gives exactly 37 rows / -$12,183 / -17.13R for that day -- an EXACT match to the figures already quoted in this task's framing and in correlation-cartographer's cluster ledger nuanceCheck. Both populations are internally consistent and independently reproducible; the disagreement is which one the 20% DRAWDOWN CEILING should be measured against, and the server's own risk aggregate answers that question by already including controls everywhere else.",
    priorFigures_SUPERSEDED_NOT_DELETED: { currentPeakEquityUSD: 104277, currentEquityUSD: 103692, currentDrawdownFromPeakPct: 0.56, maxRealizedDrawdownEverPct: 18.89281323784807, maxRealizedDrawdownDate: "2026-08-20" },
    correctedFigures: { currentPeakEquityUSD: +eq.finalPeak.toFixed(2), currentEquityUSD: +eq.finalEquity.toFixed(2), currentDrawdownFromPeakPct: +eq.currentDD.toFixed(2), maxRealizedDrawdownEverPct: +eq.maxDD.toFixed(2), maxRealizedDrawdownDate: eq.maxDDday },
    consequence: "The prior read called 2026-08-20 a 'DRAWDOWN-NEAR-MISS ... 1.11 percentage points of margin.' Correctly measured (server's own population), 2026-08-20 was an actual BREACH of the 20% hard ceiling by 7.38 percentage points -- undetected at the time and unrecorded until this run, because no drawdown-tracking or drawdown-halt code exists anywhere in the repo (grep for hardCeiling/risk-policy.json across backend/*.js: read only by 7 offline backtest scripts grading THEIR OWN historical test verdicts -- e.g. vix-term-carry-test.js -- never by traids-server-v2.js or risk-policy.js's live aggregate/breaker). The 20% number in risk-policy.json is a standard with zero runtime enforcement."
  },

  bindingConstraint: {
    name: "20% peak-to-trough drawdown ceiling (risk-policy.json hardCeiling), measured on the corrected all-time realized equity curve -- NOT the current-epoch exposure sub-cap that was named binding on 2026-08-28",
    registered: true,
    enforced: false,
    mode: "NO LIVE ENFORCEMENT CODE EXISTS -- descriptive standard only, read by offline backtest scripts, never by the running server",
    currentDrawdownPct: +eq.currentDD.toFixed(2),
    ceilingPct: 20,
    headroomPctPoints: +(20 - eq.currentDD).toFixed(2),
    headroomUSD: +ddBudgetUSD.toFixed(2),
    reasonNamedBinding: "It is the ONLY limit in this book with a confirmed REAL historical breach (2026-08-20, 27.38% vs the 20% ceiling -- see METHODOLOGY_CORRECTION above) and, of every limit examined this run, it now carries the LEAST headroom relative to the size of the loss that has already happened once: today's remaining budget to the ceiling ($9,628, 9.54 points) is less than half of what 2026-08-20 alone consumed (17.5 points that single session). The current-epoch exposure sub-cap ($15,000, 61.1% utilised, $5,833 headroom) is tighter in dollar terms today but has never itself preceded a loss (its 3 historical binds -- 08-25, 08-26, 08-27 -- all resolved flat-to-mildly-negative, per the unchanged finding below). Named binding on the strength of realized history, not proximity alone.",
    bindCountCaveat: "Back-tested (see question2) at exactly 1 of 28 clean-era sessions (3.6%) -- rare, real, and NOT decorative. A naive stress overlay (today's equity minus ALL open worst-case-open resolving adverse simultaneously, vs the same ceiling) was ALSO tested and rejected as a candidate gate: it binds on 8 of 8 available days (2026-08-21 through today) -- an always-fires artifact of running ~100 concurrent 0.5R-capped tickets, structurally similar to the external 8%-gross-cap example this role is warned against. That overlay is reported below for transparency but is NOT proposed as a threshold."
  },

  question1_mayOpenTicket: {
    answer: "ALLOW_WITH_REDUCED_BUDGET -- no REGISTERED/enforced gate is breached today, but the corrected drawdown accounting shows materially less headroom than previously reported, and no code exists to stop a repeat of the one session (2026-08-20) that already spent it.",
    realizedTodayUSD_boardDefinition: agg.realizedToday,
    realizedTodayRows_boardDefinition: agg.realizedRows,
    realizedTodayCOMPOSITION: "Both of today's 2 settled rows (the ones behind portfolio-risk.jsonl's realizedToday:+$75) are CONTROL tickets (WIF/USD -$75, XMR/USD +$150), closedAt stamped 2026-08-31T20:00:00Z (a forward/EOD-style settle timestamp, ahead of the current ~08:50 ET read). Zero real SIGNAL tickets have settled today. The board-definition realized figure (which the circuit breaker actually reads) is control-only right now; this does not change the halt decision (nowhere near -$2,000 either way) but is recorded because a bare 'realizedToday: +$75' would misdescribe today as 'the strategy made money' when in fact zero strategy tickets have settled.",
    realizedHaltThresholdUSD: -2000,
    worstCaseOpenTotalUSD: agg.worstCaseOpen,
    worstCaseOpenPctOfAccount: agg.worstCaseOpenPct,
    worstCaseOpenPctOfCurrentPeakEquity: +((agg.worstCaseOpen / eq.finalPeak) * 100).toFixed(2),
    worstCaseOpenCurrentEpochUSD: agg.worstCaseOpenCurrentEpoch,
    worstCaseOpenLegacyUSD: agg.worstCaseOpenLegacy,
    exposureCeilingUSD: agg.exposureCeiling,
    exposureCeilingPctUtilised: +((agg.worstCaseOpenCurrentEpoch / agg.exposureCeiling) * 100).toFixed(1),
    exposureCeilingHeadroomUSD: agg.exposureCeiling - agg.worstCaseOpenCurrentEpoch,
    gross1RUSD: agg.gross1R,
    gross1RPct: agg.gross1RPct,
    netDirectionalUSD: agg.netDirectional,
    netDirectionalPct: agg.netDirectionalPct,
    openTickets: agg.openTickets,
    currentEpochTickets: agg.currentEpochTickets,
    legacyTickets: agg.legacyTickets,
    classConcentrationUSD: Object.fromEntries(Object.entries(agg.byClass).map(([k,v]) => [k, v.long$ + v.short$])),
    classConcentrationPctOfGross1R: Object.fromEntries(Object.entries(agg.byClass).map(([k,v]) => [k, +(((v.long$ + v.short$) / agg.gross1R) * 100).toFixed(1)])),
    classConcentrationPoolingCaveat: "Equity carries the largest share of today's gross planned risk (n=60, ~68%) and pooling-audit.json flags class:Equity SIGN-SPLIT: its 4 strategy sub-populations split 2 profitable / 2 unprofitable (Trend -$4,725, Mean-Reversion +$2,908, Ensemble +$5,243, Breakout -$1,418) with a top-22-of-440-tickets (5%) CONCENTRATION carrying 140% of the class's net P&L. class:Crypto (7.5% of today's gross1R) is flagged CONCENTRATION even harder: top 15 of 288 tickets (5%) carry 274% of net P&L. A bare 'Equity/Crypto P&L' figure would misdescribe both classes; neither is one coherent behaviour.",
    clusterConcentration: {
      source: "backend/data/cluster-pnl-ledger.json, correlation-cartographer, asOf 2026-08-28T20:32:16.860Z (Friday's close -- the instructed source; no fresher cluster read exists as of this pre-open, weekend settles have not been re-clustered)",
      unionClustered: { n: clusterLedger.broadestClusteredVsIndependent.unionClustered.n, ofTotal: L.n, pct: +((clusterLedger.broadestClusteredVsIndependent.unionClustered.n / L.n) * 100).toFixed(1), R: clusterLedger.broadestClusteredVsIndependent.unionClustered.R },
      trulyIndependent: { n: clusterLedger.broadestClusteredVsIndependent.trulyIndependent.n, ofTotal: L.n, pct: +((clusterLedger.broadestClusteredVsIndependent.trulyIndependent.n / L.n) * 100).toFixed(1), R: clusterLedger.broadestClusteredVsIndependent.trulyIndependent.R },
      temporalEpisodeOnly: clusterLedger.broadestClusteredVsIndependent.temporalEpisodeOnly_n,
      factorGroupOnly: clusterLedger.broadestClusteredVsIndependent.factorGroupOnly_n,
      bothTypes: clusterLedger.broadestClusteredVsIndependent.bothTypes_n,
      largestClusterEver: { size: clusterLedger.population.largestClusterSize, id: "FG-0062", driver: "crypto:alt", totalR: 2.9309, note: "biggest by MEMBER COUNT (53); near-flat in total R (+2.93R). Not the same cluster as the biggest by IMPACT below." },
      biggestByImpact: {
        worst: { id: "EP-0048", type: "temporal-episode", n: 12, totalR: -12.3264, driver: "same-instant Crypto SHORT basket, opened 2026-08-21T13:35:40.238Z" },
        best: { id: "EP-0046", type: "temporal-episode", n: 20, totalR: 27.096, driver: "same-instant Crypto LONG basket, opened 2026-08-21T13:35:40.238Z" },
        fieldNameCaveat: "cluster-pnl-ledger.json's own 'realizedAggregateR' field is actually the MEAN R per cluster member, not a sum, despite its name (verified against backend/cluster-pnl-ledger.js:255, r4(mean(rMults))). totalR above is independently recomputed as n x meanR and cross-checked: EP-0046's 20 x 1.3548 = 27.096, matching the +27.10R figure this book has quoted before. Reported corrected here so the field's name is not taken at face value again."
      },
      reading: ((clusterLedger.broadestClusteredVsIndependent.unionClustered.n / L.n) * 100).toFixed(1) + "% of the settled book has never been an independent draw. The single opening instant 2026-08-21T13:35:40Z alone produced a -12.33R short basket and a +27.10R long basket from the SAME crypto universe -- almost 40R of swing from one decision moment. A per-ticket view of today's 100 open positions materially understates true concentration for this reason."
    },
    regime: {
      rowForToday: "ABSENT -- market-regime-archivist has not written a 2026-08-31 row as of this read (regime-archive.jsonl has exactly 2 rows total, dated 2026-08-27 and 2026-08-28; nothing for the weekend or today).",
      mostRecentFormedLabel: { date: "2026-08-28", label: "score 2/4 (CLOUDS) -- trend intact . vol calm . breadth NARROW . credit DIVERGING", formedFromBar: "2026-08-27 RTH close", regimeStatus: "STABLE (per that row's own rule: trend/vol/credit unchanged from 08-27, only breadth flipped, and breadth's median episode length is 1 session historically -- not read as a persistent state)" },
      liveIntradayProvisional: { file: "backend/data/bear-gauge-live.json", etTime: bearLive.etTime, computedAt: bearLive.computedAt, score: bearLive.score, components: bearLive.components, note: "Score 0 (all 4 components clear) as of 08:45 ET pre-open today -- ONE POINT BELOW Friday's nightly score of 2. NOT used as the primary label per the file's own documented convention; shown for transparency only. No stress-regime transition is indicated by either the nightly row or this provisional read." }
    }
  },

  question2_bindingFrequency: {
    note: "Every limit below, with how often it would have bound, back-tested fresh this run against the corrected population (see METHODOLOGY_CORRECTION). Realized-loss and drawdown-ceiling gates are now backtested on the SAME 28-day, real-capital-inclusive daily series (2026-07-20 through 2026-08-31, weekends/holidays skipped as non-settlement days) -- both use the identical population risk-policy.js's own live aggregate() uses, so this is a faithful backtest, not a proxy.",
    registered: [
      {
        limit: "realized day P&L <= -$2,000 (2% of $100k)",
        registered: true, enforced: false, mode: "observe",
        backtestPopulation: "28 clean-era settlement days, full real-capital population (signals + real controls)",
        boundCount: eq.dailyLossBinds.length, ofSessions: eq.nDays,
        bindRatePct: +((eq.dailyLossBinds.length / eq.nDays) * 100).toFixed(1),
        boundSessions: eq.dailyLossBinds,
        verdict: "A meaningful, frequent minority (28.6% of sessions) -- higher than any prior read found, because this run is the first to backtest it against the SAME population the live circuit breaker actually sums (previous reads mixed a narrower signals-only proxy with a partial intraday series). Not decorative, not a shutdown -- exactly the calibration this role is supposed to look for."
      },
      {
        limit: "current-epoch capped exposure >= $15,000 (15% of $100k)",
        registered: true, enforced: false, mode: "observe",
        backtestPopulation: "Eligible sessions since effectiveFrom 2026-08-24: 08-24, 08-25, 08-26, 08-27, 08-28, 08-31 (weekend has no new board activity, current-epoch value only falls from settles)",
        boundSessions: ["2026-08-25 ($15,919)", "2026-08-26 ($15,544)", "2026-08-27 ($18,581)"],
        boundCount: 3, ofSessions: 6, bindRatePct: 50,
        notBound: ["2026-08-24 (epoch too new)", "2026-08-28 ($10,594, 70.6% of ceiling)", "2026-08-31 today ($9,167, 61.1% of ceiling)"],
        verdict: "Binds half the time it has been eligible to. Still the most frequently-binding EXPOSURE-side gate, but see bindingConstraint above: its 3 historical binds all resolved flat-to-mild, none preceded a real loss, unlike the drawdown ceiling's one bind."
      },
      {
        limit: "maxConcurrentTickets = 400 (safety rail, not a target)",
        registered: true, observedMaxOpenTickets: 186,
        boundCount: 0, ofSessions: "full portfolio-risk.jsonl history (2026-08-21 to today)",
        verdict: "NEVER bound. Pure decoration at 400 -- observed max (2026-08-27) is 186, under half the cap."
      },
      {
        limit: "R53 factor-exposure cap (one factor is one bet) -- ENFORCED at entry POST since 2026-08-27",
        registered: true,
        statisticalReadStatus: r53.verdict,
        liveRefusalsRecorded: r53.population.refusedShadows,
        asOf: r53.asOf,
        verdict: "Unchanged from the prior read: enforced in code but has refused ZERO live tickets since wiring (2/15 required sessions, 0/20 required episodes -- still far too early to grade, per its own registered bar)."
      },
      {
        limit: "20% peak-to-trough drawdown ceiling (risk-policy.json hardCeiling) -- NEWLY BACKTESTED THIS RUN, NOT REGISTERED AS A LIVE GATE ANYWHERE",
        registered: "descriptive only (risk-policy.json); no enforcement code exists in traids-server-v2.js or risk-policy.js's aggregate()/breaker",
        backtestPopulation: "28 clean-era settlement days, full real-capital population",
        boundSessions: eq.ddHaltBinds,
        boundCount: eq.ddHaltBinds.length, ofSessions: eq.nDays,
        bindRatePct: +((eq.ddHaltBinds.length / eq.nDays) * 100).toFixed(1),
        verdict: "Binds on exactly 1 of 28 sessions (3.6%, 2026-08-20 at 27.38%) -- well-calibrated: rare enough to be meaningful, not decorative, and it is the ONLY limit examined this run with a confirmed real breach behind it. RECOMMENDATION (not adopted by this file, per rules): the operator should consider registering a live version of this gate. It currently exists only as a number in risk-policy.json that no running code reads."
      }
    ],
    proposedNotAdopted: [
      {
        limit: "full worst-case-open resolved adverse today, stress-tested against the 20% drawdown ceiling",
        registered: false,
        backtestPopulation: "8 days with both an equity-curve reading and a worstCaseOpen reading (2026-08-21 through 2026-08-31)",
        boundCount: 8, ofSessions: 8, bindRatePct: 100,
        verdict: "REJECTED as a candidate gate on its own back-test: it fires on EVERY available day, the same always-fires failure mode this role is warned against (the external 8%-gross-cap example). It is structurally guaranteed to fire whenever the book runs ~100+ concurrent 0.5R-capped tickets, regardless of whether they are actually correlated. Reported for transparency (today's reading: 23.59%, i.e. 3.59 points OVER the ceiling if every open ticket hit its cap simultaneously) but explicitly NOT proposed -- an always-firing threshold is not a limit.",
        todayReading: { stressDDPct: +stressDD_full.toFixed(2), overCeilingByPctPoints: +(stressDD_full - 20).toFixed(2) }
      },
      {
        limit: "gross planned risk (gross1RPct) ceiling",
        registered: false,
        backtestPopulation: "portfolio-risk.jsonl, 2026-08-21 through today (11 calendar days)",
        observedRange: "22.06% (today, lowest on record) to 49.08% (2026-08-21, highest on record)",
        comparisonAt8pct: { verdict: "shuts down every session -- confirmed again." },
        comparisonAt20pct: { verdict: "ALSO shuts down every session -- gross risk has never been observed below 22.06%. A 20% cap on gross PLANNED risk (a different quantity from the 20% DRAWDOWN ceiling) would be a permanent halt." },
        dataGapWarning: "2026-08-20 (the worst realized session) predates this log entirely -- no exposure snapshot exists for the one day a gross-risk threshold would most need to defend."
      },
      {
        limit: "largest single cluster size cap, e.g. >=15 tickets",
        registered: false,
        backtestPopulation: "correlation-cartographer's cluster ledger, per-episode",
        counterexample: "EP-0046 (the BEST cluster on record, +27.10R, 20 members) and EP-0048 (a WORST cluster, -12.33R, 12 members) share the SAME opening instant (2026-08-21T13:35:40Z) and the SAME underlying crypto universe -- a size cap set to catch one catches both, with opposite signs.",
        verdict: "Unchanged structural finding: no single-cluster-SIZE threshold can defend a loss without also suppressing the largest win it sits beside. Not proposed."
      }
    ]
  },

  question3_wouldHaltHaveHelped: {
    methodologyNote: "Measuring both sides: sessions a halt would have SAVED and sessions it would have COST, for both the realized-loss halt (registered, unenforced) and the drawdown-ceiling gate (not even registered as a live check, backtested for the first time this run).",
    theHardCase_2026_08_20_vs_08_24: {
      fact_0820: "2026-08-20 lost $12,183 signals-only / -17.13R (correlation-cartographer's population) or $20,182 on the full real-capital population used in this run's drawdown correction. 35 of 37 signal tickets clustered same-day.",
      fact_0824: "2026-08-24 was simultaneously the BEST P&L day on record (+$18,780 signals-only / +13.57R) on the SAME mechanism -- the 20-ticket same-instant crypto basket EP-0046 (see question1), +27.10R alone.",
      realizedLossHalt_wouldItHaveFiredOn0824: "NO. 08-24's day P&L was positive in every population measured (+$15,199 full, +$18,780 signals-only). A P&L-LEVEL halt (fires on realized <= -$2,000) is direction-selective by construction and does not touch a winning day, however large the correlated basket behind it.",
      ddCeilingGate_wouldItHaveFiredOn0824: "NO, and the reason is worth stating precisely: the gate is a LEVEL condition (current DD >= 20%), not a rate-of-change condition. Drawdown entering 08-24 (i.e. at the close of 08-21) was 19.63% -- under 20% -- so the gate would NOT have been active at the start of 08-24, and since 08-24 only IMPROVED equity, it never would have crossed 20% intraday either. The gate would have sat correctly UNarmed through the book's best day.",
      bestAvailableArgument: "Both a realized-loss halt and a drawdown-ceiling gate pass this test cleanly: neither is a cluster-SHAPE gate, so neither penalises a winning basket for structurally resembling a losing one. A cluster-size or cluster-presence gate fails this test (see question2's rejected proposal) because EP-0046 and EP-0048 are the same shape.",
      openQuestion_0820_couldTheGateHaveInterveningTimeToAct: "Genuinely unresolved, stated honestly: 35 of 37 tickets that day were entered in temporal-episode baskets, meaning many of them likely opened within the SAME batch, before any of them had settled to reveal the loss. A realized-P&L-based halt (either the $2,000 line or a live DD-ceiling check) can only act on SETTLED information; if the basket that caused the loss was placed before enough of it had settled to trip either gate, the gate's only real value is blocking FURTHER new tickets for the rest of that session, not the basket itself. 2026-08-20 predates portfolio-risk.jsonl (starts 08-21), so the exact intraday sequence -- and therefore exactly how much of that day's loss came before vs after either threshold would have crossed -- is unrecoverable. This is argued, not proven, same honest caveat as the prior read."
    },
    neutralBindOn0827_carriedForwardUnchanged: "2026-08-27: intraday low -$2,267 (crossed the realized-loss line), day SETTLED at -$585 to -$2,287 depending on population. Open-ticket count fell from 185 to 106 that session (a de-risking event, not new entries), suggesting the recovery came from EXITS the halt would not have touched (haltsAlterExits=false). Read as a NEUTRAL bind, not a clear save -- unchanged from the 2026-08-28 finding.",
    loggingGapCarriedForward: "circuit-breaker.json's event log only records the FIRST breaker condition to fire each day; a second condition crossing later the same session leaves no independent audit trail entry. Any bind-count read that trusts circuit-breaker.json's events[] alone will undercount. This run's bind counts are computed directly from portfolio-risk.jsonl / trade_log.json, not from circuit-breaker.json's events[].",
    conclusion: "Verdict strengthened, not reversed, by this run's corrected accounting: the realized-loss halt and the (currently nonexistent) drawdown-ceiling gate both survive the 08-20-vs-08-24 test that a cluster-shape gate fails, and 08-20 is now known to have been a REAL breach of the standing ceiling rather than a near-miss. That raises the value of registering a live drawdown check above where the 2026-08-28 read left it -- but the honest count remains: one clearly bad day (08-20, now confirmed a real breach), one neutral bind (08-27), and 8 of 28 days where the CHEAPER realized-loss line alone would have bound. Enough to keep both gates in observe/proposed status and keep counting; not yet enough to claim either is proven at 'enforce' strength."
  },

  question4_drawdownCeilingReachability: {
    hardCeilingPct: 20,
    source: "backend/data/risk-policy.json",
    enforcementStatus: "NONE -- see METHODOLOGY_CORRECTION and bindingConstraint above. This is a standard, not a running check.",
    currentPeakEquityUSD: +eq.finalPeak.toFixed(2),
    currentEquityUSD: +eq.finalEquity.toFixed(2),
    currentDrawdownFromPeakPct: +eq.currentDD.toFixed(2),
    maxRealizedDrawdownEverPct: +eq.maxDD.toFixed(2),
    maxRealizedDrawdownDate: eq.maxDDday,
    maxDrawdownWasARealBreach: true,
    marginToCeilingTodayPctPoints: +(20 - eq.currentDD).toFixed(2),
    marginToCeilingTodayUSD: +ddBudgetUSD.toFixed(2),
    worstCaseOpenNowUSD: worstCaseOpen,
    stressTest_fullWorstCaseOpenResolvedAdverseToday_Pct: +stressDD_full.toFixed(2),
    stressTest_verdict: "This specific overlay is rejected as a gate (see question2 proposedNotAdopted -- fires 8/8 available days) but its READING is still informative context: today's stress figure (23.59%) is OVER the ceiling, meaning current open worst-case risk alone, fully realized, is not a comfortable margin under 20% -- it is a small overshoot. It should not be read as 'the book will breach the ceiling' (the overlay always reads this way, by construction) -- it should be read as 'there is no slack in reserve if the realized side (not just the open side) also moves against the book the same day.'",
    ddIfAnother0820ShapedSessionHappenedToday_Pct: +ddIf0820RepeatToday.toFixed(2),
    ddIfAnother0820ShapedSessionHappenedToday_note: "A dollar-for-dollar repeat of 2026-08-20's realized loss ($20,182, full real-capital population) landing today would produce a 30.46% drawdown from the all-time peak -- 10.46 points OVER the ceiling. This is not a hypothetical extreme: it is the actual worst session already on this book's own record, replayed against today's thinner cushion.",
    verdict: "REACHABLE, and already reached once. Corrected finding, materially different from the 2026-08-28 read: today's drawdown (10.46%) is NOT currently breached and sits under the ceiling with 9.54 points ($9,628) of nominal headroom, but (a) that headroom is under HALF of what 2026-08-20 alone consumed in one session, (b) the ceiling was ALREADY breached once (27.38% on 08-20, corrected from a previously-reported 18.89% near-miss), and (c) zero code anywhere enforces it, so nothing would have stopped that breach and nothing stops a repeat today. Clustering, not per-ticket sizing, is what moves this number: the same 2026-08-21T13:35:40Z opening instant produced both the book's best cluster (+27.10R) and one of its worst (-12.33R)."
  },

  question5_gapStressExposure: {
    source: "backend/data/trade-autopsy.jsonl, recomputed fresh this run by exit reason (1038 rows, signals-only population, matches cleanEraLedger n exactly)",
    byExit: { close: { n: 781, R: 3.27 }, "gap-stop": { n: 18, R: -26.39, pnlUSD: -16079 }, expiry: { n: 145, R: 1.78 }, target: { n: 19, R: 38.99 }, stop: { n: 44, R: -44.62, pnlUSD: -33134 }, manual: { n: 27, R: 6.84 }, time: { n: 4, R: 1.53 } },
    gapStopR: -26.39, gapStopN: 18, stopR: -44.62, stopN: 44,
    combinedStopTailR: -71.01,
    gapStopShareOfCombinedTailPct: 37.2,
    changeFromPriorRead: "Updated from the 2026-08-28 read (17 gap-stops, -22.24R, 33.3% share) -- one additional gap-stop settled since, share moved to 37.2%. Direction of the finding is unchanged and slightly worse.",
    poolingAuditNote: "byExit is not one of the 12 aggregates pooling-audit.js checks (class:*/strategy:* only), so it carries no pooling flag, but has not been independently sign-split tested either -- treated as directionally reliable, not pooling-cleared.",
    verdict: "Unchanged conclusion, strengthened by the update: gap-stops (18 trades, <2% of the settled book) carry over a third of the combined stop-tail's R because they open beyond the stop level. No stop-width tuning reaches them (R54 still accruing). Neither the realized-loss halt nor the exposure ceiling nor the (unenforced) drawdown ceiling sizes specifically for overnight/weekend gap risk -- all three act on aggregate exposure or realized P&L only, after the gap has already happened. Only position SIZE going into a close/open changes gap-stop dollar exposure, and this is directly relevant today: it is Monday, and roughly half of this book's settles occur outside RTH (overnight crypto/FX), so weekend gap risk on Friday's close-to-Monday's-open carry is exactly the exposure this gate cannot see."
  },

  poolingAuditCaveats: {
    asOf: poolAudit.asOf,
    flaggedOf: poolAudit.flagged + " of " + poolAudit.aggregatesChecked + " aggregates",
    rule: "Every class:* and strategy:* mean in this book is flagged. No bare class-level or strategy-level P&L mean is quoted anywhere in this report without stating its flag in the same breath.",
    concentrationHighlights: [
      "class:Crypto -- top 15 of 288 tickets (5%) carry 274% of net P&L (CONCENTRATION), 4 sub-strategies SIGN-SPLIT 2 profitable/2 not",
      "class:Equity -- top 22 of 440 tickets (5%) carry 140% of net P&L (CONCENTRATION); today's book carries the largest share of its gross planned risk in this class",
      "strategy:Ensemble -- top 15 of 290 tickets (5%) carry 971% of net P&L (CONCENTRATION)",
      "class:Options -- top 8 of 148 tickets (5%) carry 150% of net P&L (CONCENTRATION); win-rate breakeven ranges 73.3%-83.7% across its own sub-strategies (PAYOFF-SPLIT) -- the pooled 81.8% win rate cannot be judged against either bar alone"
    ]
  },

  correlationCartographerLedger: {
    found: true,
    file: 'backend/data/cluster-pnl-ledger.json',
    asOf: clusterLedger.asOf,
    note: "This is Friday's close read, per instruction ('the cluster ledger correlation-cartographer wrote at Friday's close'). No fresher cluster read exists as of this pre-open; weekend settles (today's 2 control-ticket settles) have not been through a re-cluster pass.",
    reconciledEdge: "pooledEdgeR " + clusterLedger.reconciled.pooledEdgeR + " was reconciled inside the ledger's own build (Friday); this run's fresh cleanEraLedger() read gives " + L.pooledEdgeR + " -- the difference reflects settles between the ledger's build time and now, both are internally reconciled at their own asOf."
  },

  preflightStatus: {
    ranAt: preflight.ranAt, verdict: preflight.verdict, critical: preflight.critical, warnings: preflight.warnings,
    ledgerIntegrity: "PASS this run (2429 rows re-derived, 0 arithmetic mismatches, 0 impossible values) -- IMPROVED from 2026-08-28's FAIL. Does not force DATA_INTEGRITY_HALT.",
    openIssue: "nightly chain: 2 of 106 steps failed, backup/git-snapshot Windows path error -- an ops issue (backup/snapshot pipeline), not a ledger-correctness issue. Unrelated to any of today's binding risk inputs. STANDING-UNRESOLVED, carried forward from 2026-08-27/28; still not force-halting because it does not touch realizedToday, worstCaseOpen, gross1R, netDirectional or openTickets.",
    marksWatcher: "pre-window (08:45 ET) -- starts 09:45, not yet live at this read; not a data-integrity concern pre-open."
  },

  breachHistory: [
    ...prior.breachHistory,
    {
      at: nowISO,
      type: "BREACH-CORRECTED (RETROACTIVE RECLASSIFICATION -- prior row below is NOT edited, this is a new append-only entry superseding its conclusion)",
      limit: "risk-policy.json hardCeiling 20% peak-to-trough",
      supersedes: "the 2026-08-20 'DRAWDOWN-NEAR-MISS' row above (18.89%, 1.11pp margin), which used an incomplete population (signals-only, excluding real control-ticket P&L)",
      valueEquityDrawdownPct: +eq.maxDD.toFixed(2),
      ceilingPct: 20,
      overCeilingByPctPoints: +(eq.maxDD - 20).toFixed(2),
      population: "signals + real (non-vetoShadow) controls, ex-sleeve, clean epoch -- matches backend/lib/risk-policy.js aggregate()'s own definition of 'the book' used everywhere else in portfolio-risk.jsonl",
      source: "derived this run from data/trade_log.json via the same filter risk-policy.js aggregate() applies, extended across full history; see METHODOLOGY_CORRECTION_THIS_RUN above for full derivation",
      note: "This WAS a real breach of the standing hard ceiling, not a near-miss. It went undetected at the time and unrecorded until this read because no drawdown-tracking or drawdown-halt code exists anywhere in the running server."
    },
    {
      at: nowISO,
      type: "OBSERVATION (not a breach)",
      limit: "current-epoch capped exposure (worstCaseOpenCapPct 15%)",
      valueUSD: agg.worstCaseOpenCurrentEpoch,
      ceilingUSD: agg.exposureCeiling,
      pctOfCeiling: +((agg.worstCaseOpenCurrentEpoch / agg.exposureCeiling) * 100).toFixed(1),
      mode: "observe",
      note: "Not bound today (61.1% of ceiling). Recorded for continuity of the daily series."
    }
  ],

  preflightEscalation: {
    type: "STANDING-UNRESOLVED, carried forward",
    items: ["nightly chain (backup + git snapshot, Windows path error, ops-only)"],
    resolvedSinceLastRun: ["ledger integrity (13 options rows friction-marking gap, 2 impossible-MFE rows) -- PASSES cleanly this run, 0 mismatches. Whatever fixed this between 08-28 and 08-31 is not identified by this read; noted as resolved, not investigated further (outside this role's scope)."],
    governorPosition: "Does not force DATA_INTEGRITY_HALT -- the one remaining open item is an ops/backup pipeline issue, not a ledger-correctness issue, and does not touch any of today's binding inputs."
  },

  rulesFollowedThisRun: [
    "Never place/cancel/size/modify an order -- this file proposes a status only; adoption is the operator's.",
    "Never edited risk-policy.json or test-registry.json -- read-only against both. The drawdown-gate recommendation is a RECOMMENDATION to register an epoch, not a self-adopted change.",
    "Ledger read only through backend/lib/reconcile.js cleanEraLedger(); journalLag() checked (0 missing) before trusting any figure.",
    "Every bare class/strategy aggregate cross-checked against pooling-audit.json and its flag stated in the same breath.",
    "pooling-audit.json read BEFORE citing any aggregate, per standing instruction.",
    "Concentration figures are shares of ABSOLUTE R (cluster-pnl-ledger.json fourViews / totalR recomputed from meanR x n) or explicitly labelled net-P&L shares (pooling-audit.json's own convention) -- never conflated.",
    "Every threshold examined states its bind count and denominator; the always-fires stress overlay was tested, found uncalibrated, and explicitly NOT proposed.",
    "Status is the registered five-value enum (ALLOW / ALLOW_WITH_REDUCED_BUDGET / HALT_NEW_TICKETS / DATA_INTEGRITY_HALT / MANUAL_REVIEW_REQUIRED).",
    "breachHistory is append-only -- the 2026-08-20 near-miss row from the 08-28 read is left untouched; the correction is a new row that supersedes its conclusion rather than editing it.",
    "Wrote this JSON via node fs.writeFileSync, not PowerShell or a bash heredoc."
  ]
};

fs.writeFileSync('backend/data/risk-governor.json', JSON.stringify(out, null, 1) + '\n', 'utf8');
console.log('WROTE backend/data/risk-governor.json');
console.log('status:', out.status);
console.log('bindingConstraint:', out.bindingConstraint.name);
