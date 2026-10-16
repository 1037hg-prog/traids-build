#!/usr/bin/env node
/** Registers R211 — can a LUCK-ADJUSTED skill score predict a leaderboard's next winners better than the raw leaderboard? 2026-09-24,
 *  operator: "we need to predict the selection luck" -> "yes register it and build the luck tool". Applied to AlphaInsider (3,667 public
 *  strategies, backend/alphainsider-record.js). Filed before the timeline backfill is complete and before any skill score exists.
 *  Refuses if R211 exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const { nullBar } = require("./lib/null-bar.js");
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R211")) { console.error("R211 already exists — refusing"); process.exit(2); }
const BAR = +nullBar({ variants: 2, n: 18, trials: 20000 }).p95.toFixed(3);
reg.preregistered.push({
  id: "R211", name: "Selection-luck filter — does a luck-adjusted skill score pick AlphaInsider's next-3-month winners better than the raw leaderboard?",
  registered: "2026-09-24", evidenceStart: "HISTORICAL leg: months reconstructable from the timelines once R188's backfill gate is met (~11 nights); FORWARD leg: from 2026-09-24 on our dated daily values",
  status: "REGISTERED 2026-09-24 — tool build in progress; historical leg waits for the backfill gate", script: "backend/r211-luck-filter.js (uses backend/lib/selection-luck.js and R188's reconstruction in backend/r188-ai-persistence.js)",
  parent: "Operator 2026-09-24. Motivation: AlphaInsider's +200-300% one-year leaders were single-stock or single-coin bets (AMD, INTC, TTMI, BTC/ETH timing); the question is whether luck can be separated from skill IN ADVANCE.",
  multiplicityFamily: "LUCK-2 — the historical leg and the forward leg are read separately at their own conditions; one scoring rule, no variants. Related: R188 (raw persistence on the same data).",
  rule: [
    "Universe at each month-end t: AlphaInsider strategies with >= 6 months of history at t (historical leg: single-symbol strategies reconstructed exactly as R188 does, with R188's drift gate; forward leg: every strategy with dated values).",
    "SKILL SCORE: over the 6 months to t, the strategy's return minus buy-and-hold of the asset it trades (asset-relative return A). LUCK NULL for that strategy: 500 random-timing paths on the SAME asset over the SAME 6 months with the SAME fraction of days in the market and the SAME number of position changes (seeded). pLuck = share of null paths with asset-relative return >= A. Skill score z = probit(1 - pLuck), capped at +/-3.5. Strategies are then ranked by z; Storey q-values across the month's universe are reported.",
    "RAW SCORE: the 6-month raw return to t (what the marketplace leaderboard shows).",
    "OUTCOME: each strategy's asset-relative return over the NEXT 3 months (t to t+3).",
  ],
  statistic: "Per month-end: mean outcome of the top decile by SKILL SCORE minus mean outcome of the top decile by RAW SCORE; t over months with Newey-West lag 2 (3-month outcomes overlap). Reported: each top decile vs the month's universe mean, the leaderboard 'luck line' (expected best raw 6-month return among N zero-skill strategies from the pooled null) against the observed best, and the share of strategies with q < 0.10.",
  bar: { fixedInAdvance: true, unit: "month-ends (historical ~18 with breadth >= 50)", tRequired: BAR, variants: 2, source: `nullBar({variants:2, n:18, trials:20000}).p95 = ${BAR}` },
  controls: { shuffle: "skill scores shuffled within month (200 draws): median |t| < 2", peek: "rank by the realised next-3-month outcome: must clear the bar", nullCalibration: "on a synthetic zero-skill universe the skill score's pLuck must be ~uniform (KS p > 0.05) — proves the null is calibrated before any real read" },
  interimKill: "n/a",
  decisionRule: { pass: "The luck filter predicts: adopt it as the standard screen for any external leaderboard (AlphaInsider, Collective2, TradingView) and register a forward paper follow-book of the top skill decile (operator's word).", fail: "Neither luck-adjusted nor raw ranking predicts: leaderboards are noise to follow; external strategy marketplaces are evaluated only by translation + out-of-sample test (the R187 route)." },
  readCondition: "historical leg: node backend/r211-luck-filter.js --read when R188's backfill gate is met and >= 12 month-ends have breadth >= 50 (fewer -> INCONCLUSIVE, sealed as such); forward leg: --read-forward after 12 forward month-ends",
  expectation: "LOW-MED: removing the asset's own move and scoring against a same-asset random-timing null should strip the 'assigned a hot stock' luck; whether any skill remains is open.",
  knownWeaknesses: ["Survivorship: deleted strategies are invisible (historical leg).", "Breadth is concentrated in bulk-created BTC/ETH TradingView-tracker strategies that move together.", "Random-timing null preserves time-in-market and switch count but not the timing autocorrelation of real rules."],
  ip: "AlphaInsider data via the official API under the operator's key; strategies' code not ours.", writerExists: false,
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-24", area: "R211 selection-luck filter — registered", category: "registration", breaksComparability: false, change: `Luck-adjusted skill score (same-asset random-timing null) vs raw leaderboard for AlphaInsider next-3-month winners; bar ${BAR}; historical + forward legs.`, why: "Operator: 'yes register it and build the luck tool'.", doesNotEstablish: "Anything until the reads.", operator: "Josh 2026-09-24" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R211"], detail: `selection-luck filter, bar ${BAR}` }) + "\n");
console.log(`R211 registered · bar ${BAR}`);
