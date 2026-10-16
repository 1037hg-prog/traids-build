#!/usr/bin/env node
/** Registers R202 — the "G Street Trades" one-candle exhaustion short (reel, screen recording 2026-09-24 17:31, operator: "yes register and
 *  run it"). Frozen before any bar is fetched. Refuses if R202 exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const { nullBar } = require("./lib/null-bar.js");
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R202")) { console.error("R202 already exists — refusing"); process.exit(2); }
const BAR = +nullBar({ variants: 4, n: 600, trials: 20000 }).p95.toFixed(3);
const UNIVERSE = ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "AMD", "AVGO", "NFLX", "JPM", "BAC", "XOM", "CVX", "UNH", "LLY", "COST", "WMT", "HD", "V", "MA", "ORCL", "CRM", "ADBE", "INTC", "CSCO", "PEP", "KO", "DIS", "BA"];
reg.preregistered.push({
  id: "R202", name: "G Street Trades one-candle exhaustion — shooting star after a stretched run, short the break, stop over the wick, 2R",
  registered: "2026-09-24", evidenceStart: "2018-01-02..2026-08-31, historical; primary read on the HOLDOUT 2022-01-01..2026-08-31",
  source: "Facebook/Instagram reel by 'G Street Trades' ('This ONE candlestick will LITERALLY retire your family'), 59 s, operator screen recording C:/Users/joshc/Videos/Screen Recordings/Screen Recording 2026-09-24 173152.mp4. Shows '$3.4 MILLION' prop-firm payout certificates and only winning examples; funnel to his 'EMT' programme.",
  status: "REGISTERED 2026-09-24 — historical read pending", script: "backend/r202-one-candle.js",
  parent: "Operator 2026-09-24: 'yes register and run it'. Close cousin R148 (exhaustion-gap fade) DID NOT PASS.",
  multiplicityFamily: "ONE-CANDLE-4 — timeframe {15-minute, 1-hour} x side {short after a stretched rally (the reel), mirrored long after a stretched flush}. Primary: 15-minute shorts. Best-of-4 bar.",
  rule: [
    `Universe (fixed, current large caps + index ETFs — survivorship disclosed): ${UNIVERSE.join(", ")}. Alpaca SIP bars, regular session only, 2018-01-02..2026-08-31; 15-minute bars fetched directly (timeframe 15Min), 1-hour bars aggregated from them on the clock hour.`,
    "Indicators per timeframe: session-anchored VWAP (typical price x volume from 09:30), EMA(9) of closes (continuous across sessions), ATR(14).",
    "STEP 1 acceleration: bar s's high is at least 2.0 x ATR(14) above BOTH that bar's VWAP and EMA(9), and is the highest high of the last 10 bars.",
    "STEP 2 the candle: bar s is a shooting star — upper wick >= 2 x |body|, upper wick >= 50% of the bar's range, lower wick <= 25% of the range.",
    "STEP 3 trapped buyers: bar s's volume >= 1.5 x the mean volume of the prior 20 bars.",
    "EXECUTION: a sell-stop one cent below bar s's low, live for the next 3 bars; fills at the stop, or at a bar's open if it gaps below. Stop: one cent above bar s's high. Target: entry - 2R (R = stop - entry). Stop and target tested on later bars (stop first if one bar touches both); flat at 15:55 ET if neither. One open trade per symbol. Mirror long: all conditions reflected (low stretched below VWAP and EMA9, hammer with lower wick >= 2 x body, buy-stop above the high).",
    "Costs per trade: $0.02 per share round trip plus 0.03% of price per side for stop-order slippage, expressed in R.",
  ],
  statistic: "Net R per trade; per ET session the mean net R of that session's trades; t over sessions (Newey-West lag 1). Discovery 2018-2021 inspected only for pipeline sanity; the verdict is the holdout. Reported: 3R target variant, win rate, trades per month, gross.",
  bar: { fixedInAdvance: true, unit: "holdout sessions with a trade (~600)", tRequired: BAR, variants: 4, source: `nullBar({variants:4, n:600, trials:20000}).p95 = ${BAR}`, alsoRequired: "beat the RANDOM-CANDLE control — the same Step 1 stretch condition and the same execution, entering on a random bar that meets Step 1 but NOT the shooting-star shape (matched count per symbol-month, 200 draws) — at its 95th percentile: isolates whether the candle adds anything beyond 'fade stretched moves'" },
  controls: { randomCandle: "as in bar.alsoRequired", bootstrap: "drift-free iid bootstrap of gross per-session R: |t| < 2", peek: "keep only trades whose target is hit first: must clear the bar", leak: "all conditions use bar s and earlier; entry only on later bars" },
  interimKill: "n/a (historical)",
  decisionRule: { pass: "Register a forward paper test (Alpaca paper, the 15-minute rule on the ETFs).", fail: "The one-candle setup is not an edge beyond chance net of costs; the reel's winners were selected." },
  readCondition: "one historical read after the controls pass",
  expectation: "LOW: R148 (exhaustion fade) sat at its random floor; candle-shape filters rarely add information over the stretch itself.",
  knownWeaknesses: ["Current-large-cap universe (survivorship).", "15-minute bars cannot order the high and low within a bar; stop-first is conservative.", "The reel's discretion (which candle, which timeframe) replaced by fixed thresholds.", "Futures (his likely instrument) excluded: our 5-minute futures history starts 2026-03."],
  ip: "Public social-media content; rule text ours.", writerExists: false,
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-24", area: "R202 G Street one-candle — registered", category: "registration", breaksComparability: false, change: `Frozen shooting-star exhaustion short (15m/1h x short/mirror long) on 33 liquid names 2018-2026, holdout 2022+; best-of-4 bar ${BAR} + random-candle control.`, why: "Operator: 'yes register and run it'.", doesNotEstablish: "Anything until the read.", operator: "Josh 2026-09-24" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R202"], detail: `G Street one-candle, bar ${BAR}` }) + "\n");
console.log(`R202 registered · bar ${BAR}`);
