#!/usr/bin/env node
/** Registers R207 — "cross, retest, hold" (break-and-retest) across four levels as ONE family. 2026-09-24, operator: "cross retest hold" ->
 *  "all four as one family". Frozen before any bar is fetched. Refuses if R207 exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const { nullBar } = require("./lib/null-bar.js");
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R207")) { console.error("R207 already exists — refusing"); process.exit(2); }
const BAR = +nullBar({ variants: 4, n: 900, trials: 20000 }).p95.toFixed(3);
const UNIVERSE = ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "AMD", "AVGO", "NFLX", "JPM", "BAC", "XOM", "CVX", "UNH", "LLY", "COST", "WMT", "HD", "V", "MA", "ORCL", "CRM", "ADBE", "INTC", "CSCO", "PEP", "KO", "DIS", "BA"];
reg.preregistered.push({
  id: "R207", name: "Cross, retest, hold — break-and-retest entries at four levels (VWAP, 20-EMA, prior-day high/low, 30-minute opening range)",
  registered: "2026-09-24", evidenceStart: "2018-01-02..2026-08-31, historical; primary read on the HOLDOUT 2022-01-01..2026-08-31",
  status: "REGISTERED 2026-09-24 — historical read pending", script: "backend/r207-cross-retest-hold.js",
  parent: "Operator 2026-09-24: 'cross retest hold' -> 'all four as one family'. The operator's shorthand for the common day-trading break-and-retest entry; no specific creator's rules were supplied, so the textbook form is frozen here.",
  multiplicityFamily: "CRH-4 — level L in {session VWAP, 20-period EMA of 5-minute closes, prior session's high (longs) / low (shorts), 30-minute opening range high (longs) / low (shorts, range set 09:30-10:00)}; each level pools longs and mirrored shorts. Best-of-4 bar.",
  rule: [
    `Universe (fixed, current large caps + index ETFs, survivorship disclosed): ${UNIVERSE.join(", ")}. Alpaca SIP 5-minute bars, regular session, 2018-01-02..2026-08-31 (reuse backend/data/training/r178 for SPY/QQQ/IWM where present). ATR(14) on 5-minute bars.`,
    "CROSS (long): bar c closes above L while bar c-1 closed at or below L (L evaluated at each bar; opening-range crosses only after 10:00; prior-day levels from the prior session's regular-hours high/low).",
    "RETEST: within the next 12 bars after c, the first bar r whose low comes within 0.10 x ATR of L (low <= L + 0.10 x ATR). If any bar between c and r closes below L, the setup is void.",
    "HOLD: bar r itself closes at or above L (if r closes below L the setup is void).",
    "ENTRY: the open of bar r+1. STOP: bar r's low minus 0.05 x ATR. TARGET: entry + 2R. Stop and target tested on later bars (stop first if one bar touches both); flat at 15:55 ET. No new entries after 15:00 ET. One open trade per symbol per level. SHORTS mirror everything (cross below, retest from below, hold below).",
    "Costs per trade: $0.02 per share round trip plus 0.02% of price per side, in R.",
  ],
  statistic: "Per level: net R per trade; per ET session the mean net R of that session's trades (longs and shorts pooled); t over sessions (Newey-West lag 1). Discovery 2018-2021 for pipeline sanity only; the verdict is the holdout. Reported per level: long and short separately, gross, win rate, trades per month, 1R and 3R targets.",
  bar: { fixedInAdvance: true, unit: "holdout sessions with a trade (~900)", tRequired: BAR, variants: 4, source: `nullBar({variants:4, n:900, trials:20000}).p95 = ${BAR}`, alsoRequired: "beat the RANDOM-ENTRY control — entries at random 5-minute bars in the same symbol-months (matched count, direction and time-of-day bucket) with the same stop distance in ATR units and the same target/exit rules, 200 draws — at its 95th percentile" },
  controls: { randomEntry: "as in bar.alsoRequired", bootstrap: "drift-free iid bootstrap of gross per-session R: |t| < 2", peek: "target-hit-first trades only: must clear the bar", leak: "all conditions use bars up to r; entry at r+1's open" },
  interimKill: "n/a (historical)",
  decisionRule: { pass: "Register a forward paper test of the passing level on SPY/QQQ via the Alpaca paper account.", fail: "Break-and-retest at these levels is not an edge beyond random entries net of costs." },
  readCondition: "one historical read after the controls pass",
  expectation: "LOW: break-and-retest is among the most taught setups; R178 (LVN) and R202's family show intraday level-based entries rarely beat random after costs.",
  knownWeaknesses: ["Textbook thresholds (12-bar retest window, 0.10 ATR proximity, 2R) stand in for any particular trader's discretion.", "Current-large-cap universe.", "5-minute bars cannot order intrabar highs/lows; stop-first is conservative."],
  ip: "none", writerExists: false,
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-24", area: "R207 cross-retest-hold — registered", category: "registration", breaksComparability: false, change: `Break-and-retest at VWAP / EMA20 / prior-day H-L / 30m OR, 33 names, 5-minute, holdout 2022+; best-of-4 bar ${BAR} + random-entry control.`, why: "Operator: 'all four as one family'.", doesNotEstablish: "Anything until the read.", operator: "Josh 2026-09-24" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R207"], detail: `cross-retest-hold x4 levels, bar ${BAR}` }) + "\n");
console.log(`R207 registered · bar ${BAR}`);
