#!/usr/bin/env node
/** Registers R187 (the five crypto TradingView scripts that top AlphaInsider's 1-year board, tested outside the window they were picked on)
 *  and R188 (does AlphaInsider performance persist, ranked against each strategy's own asset?). 2026-09-24, operator: "yes register and start
 *  both". Seen before registration: the 2026-09-24 1-year board and each top-10 strategy's traded symbol and trade count; nothing about any
 *  strategy's behaviour outside that one year, and no persistence statistic. Refuses if either id exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const { nullBar } = require("./lib/null-bar.js");
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => ["R187", "R188"].includes(t.id))) { console.error("R187/R188 exists — refusing"); process.exit(2); }
const BAR187 = +nullBar({ variants: 5, n: 900, trials: 20000 }).p95.toFixed(3), BAR188 = +nullBar({ variants: 4, n: 18, trials: 20000 }).p95.toFixed(3);
const common = { registered: "2026-09-24", parent: "Operator 2026-09-24: 'need to look at like the top 10' -> 'yes register and start both'. Data: backend/alphainsider-record.js (official API, read-only).", ip: "Public TradingView scripts: translate for private testing only; never republish their code (TradingView House Rules). AlphaInsider data via the official API under the operator's key.", interimKill: "n/a (historical)" };
reg.preregistered.push({ ...common,
  id: "R187", name: "AlphaInsider's top crypto TradingView scripts — translated, verified against their trade logs, tested outside the year they were ranked on",
  evidenceStart: "each script's TradingView publication date .. 2025-09-23 (everything post-publication and BEFORE the 1-year window the 2026-09-24 ranking selected on); historical",
  status: "REGISTERED 2026-09-24 — translation and read pending", script: "backend/r187-ai-crypto-scripts.js",
  multiplicityFamily: "AI-CRYPTO-5 — Multi-Oscillator Divergence (Craig_Claussen, BTC), Triple Threat (alexjnelson, BTC), DMI with DPO Guard (BTC), Stealthy 7 Linear Regression Channel (stealthy7, ETH), [LunaOwl] LOHAS PriceChannel (ETH): the five crypto strategies in AlphaInsider's 1-year top 10 on 2026-09-24. Best-of-5 bar.",
  rule: "For each script: read the public TradingView source (one page per script, no bulk collection) and translate it; take chart timeframe, inputs, direction (long/short), sizing and commission exactly as AlphaInsider's TradingViewTracker runs it (from the strategy description and its trade log). KNOWN-ANSWER GATE: replay the translation over AlphaInsider's tracked period and match its recorded trades (data/alphainsider/timelines/<id>.jsonl) — >= 80% of recorded trades matched in side and within one bar; a script that fails is EXCLUDED as untranslatable (reported, not a verdict). Then run the verified translation on the OOS window above on Coinbase candles for its asset. Cost: 10 bps per side.",
  statistic: "Per script: daily net strategy return regressed on the asset's daily return (buy-and-hold); the intercept (alpha, annualised) with a Newey-West (lag 5) t over days. Also reported: total return vs buy-and-hold, max drawdown, trade count, and the same statistic on AlphaInsider's own window for context.",
  bar: { fixedInAdvance: true, unit: "days in the OOS window (~900+)", tRequired: BAR187, variants: 5, source: `nullBar({variants:5, n:900}).p95 = ${BAR187}` },
  controls: { randomEntry: "same number of trades and holding periods placed at random dates in the OOS window (200 draws): the script's alpha must beat the 95th percentile", peek: "a perfect-foresight version of the same signal frequency must clear the bar", leak: "signals computed on closed bars only; fills at the next bar open" },
  decisionRule: { pass: "A verified script with OOS alpha t >= bar and above the random-entry 95th percentile: register a forward paper test (BTC/ETH via the Alpaca paper mirror).", fail: "Its AlphaInsider year was the lucky draw among hundreds of tracked crypto scripts." },
  readCondition: "one read per script after its translation passes the known-answer gate",
  expectation: "LOW-MED: crypto trend-timing can beat buy-and-hold in down years (sitting out or shorting), but best-of-hundreds selection on one bad year for BTC/ETH is a strong luck filter.",
  knownWeaknesses: ["Some scripts may repaint or use lookahead features; the translation uses closed bars only and says so.", "Short windows for scripts published recently (2025) — little OOS data; those are reported as 'cannot tell'.", "AlphaInsider's own execution conventions (fill timing, fees) may differ from the TradingView strategy tester."],
  writerExists: false });
reg.preregistered.push({ ...common,
  id: "R188", name: "AlphaInsider persistence — do strategies that beat their own asset keep beating it?",
  evidenceStart: "historical reconstruction from the timelines (single-asset strategies) + forward from 2026-09-24 (our dated daily values for every strategy)",
  status: "REGISTERED 2026-09-24 — historical leg after the timeline backfill completes; forward leg accruing", script: "backend/r188-ai-persistence.js",
  multiplicityFamily: "AI-PERSIST-4 — ranking {asset-relative, raw} x formation {3 months, 6 months}; holding 1 month. Primary: asset-relative, 6-month formation.",
  rule: "Universe each month-end: AlphaInsider public strategies with >= the formation period of history and at least one trade. HISTORICAL LEG: single-symbol strategies only, marked to market daily from their timestamped trades (holdings from new_holdings, prices from Alpaca SIP daily for stocks and Coinbase daily for crypto), so values exist between trades; strategies created later enter when they have enough history (no look-ahead: a strategy's inclusion uses only its creation date and trades up to the formation end). ASSET-RELATIVE score = the strategy's formation return minus buy-and-hold of the symbol it trades over the same months. RAW score = formation return (what the marketplace shows). FORWARD LEG: every strategy, from our own dated daily values (values-<day>.json), same scores once 6 months accrue.",
  statistic: "Each month: top decile minus bottom decile of the NEXT month's asset-relative return (for both rankings, so the raw ranking is judged on the same outcome); t over months (Newey-West lag 1 for the 6-month formation overlap). Also: top decile's next-month asset-relative return alone.",
  bar: { fixedInAdvance: true, unit: "months (historical ~18 with enough breadth)", tRequired: BAR188, variants: 4, source: `nullBar({variants:4, n:18}).p95 = ${BAR188}` },
  controls: { shuffle: "scores shuffled within month (200 draws): |t| < 2", peek: "rank by the next month's return: must clear the bar", survivorship: "AlphaInsider shows only strategies that still exist; deleted strategies are invisible — disclosed; the forward leg removes this bias going forward" },
  decisionRule: { pass: "Winners persist relative to their asset: register a forward paper follow-book of the top decile (Alpaca paper mirror / our own records), operator's word.", fail: "Past AlphaInsider performance does not predict next month once the asset's own move is removed — the leaderboard is noise to follow." },
  readCondition: "historical leg: once the timeline backfill covers every single-symbol strategy (~1 week); forward leg: at 12 months of forward data",
  expectation: "LOW: marketplace-performance persistence is usually weak, and asset-relative ranking removes the 'assigned a hot stock' effect that dominates the raw board.",
  knownWeaknesses: ["Survivorship: deleted strategies are missing from the historical leg.", "Single-symbol restriction for the historical leg (multi-symbol strategies only in the forward leg).", "Timeline-based marking assumes AlphaInsider's recorded holdings are complete."],
  writerExists: false });
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-24", area: "R187 AI crypto scripts + R188 AI persistence — registered", category: "registration", breaksComparability: false, change: `R187 best-of-5 bar ${BAR187}; R188 best-of-4 bar ${BAR188}.`, why: "Operator: 'yes register and start both'.", doesNotEstablish: "Anything until the reads.", operator: "Josh 2026-09-24" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R187", "R188"], detail: `AI crypto scripts bar ${BAR187}; AI persistence bar ${BAR188}` }) + "\n");
console.log(`R187 registered · bar ${BAR187}\nR188 registered · bar ${BAR188}`);
