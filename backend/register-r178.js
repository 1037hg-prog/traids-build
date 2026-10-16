#!/usr/bin/env node
/** Registers R178 — the "Swift Trades" LVN pullback rule (Facebook reel, screen recording 2026-09-24 13:26, operator: "yes test the LVN rule").
 *  Reel's method, verbatim in spirit: mark the last swing low->high (or high->low), draw a volume profile over just that swing, find the
 *  low-volume node, wait for price to pull back to it, enter with the higher-timeframe bias; stop just beyond the node, target the swing
 *  extreme; "any pair, any time frame". Frozen here before any bar is fetched. Refuses if R178 exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const { nullBar } = require("./lib/null-bar.js");
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R178")) { console.error("R178 already exists — refusing"); process.exit(2); }
const BAR = +nullBar({ variants: 4, n: 800, trials: 20000 }).p95.toFixed(3);
reg.preregistered.push({
  id: "R178", name: "Swift Trades LVN pullback — volume profile over the last swing, enter at the low-volume node with the 1-hour trend",
  registered: "2026-09-24", evidenceStart: "2026-09-24 (historical; no bar fetched before this registration)",
  source: "Facebook reel by 'Swift Trades' ('how much easier can i make this #daytrading'), 23 s, operator screen recording C:/Users/joshc/Videos/Screen Recordings/Screen Recording 2026-09-24 132609.mp4. Four hand-picked winning examples, no statistics. Funnel: 'follow me, comment LVN'.",
  status: "REGISTERED 2026-09-24 — historical read pending", script: "backend/r178-lvn.js",
  parent: "Operator 2026-09-24: 'yes test the LVN rule'.",
  multiplicityFamily: "LVN-4 — swing size k in {3, 5} x ATR(14) on 5-minute bars, x venue {US index ETFs pooled (SPY, QQQ, IWM), BTC/USD}. Primary: k=3 on the ETF pool.",
  rule: [
    "Bars: 5-minute. ETFs: Alpaca SIP, regular session only, 2018-01-02..2026-08-31. BTC/USD: Coinbase 5-minute candles, 24h, 2021-01-01..2026-08-31.",
    "Swing: a ZigZag on 5-minute closes with reversal threshold k x ATR(14). The CURRENT swing runs from the last confirmed pivot A to the running extreme B since A, and is live once |B - A| >= k x ATR at B.",
    "Profile: every bar from A to B spreads its volume evenly across its high-low range into 24 equal price bins over [min(A,B), max(A,B)].",
    "LVN: among the bins between 20% and 80% of the swing, the one with the least volume, and only if that volume is below half the median bin. No qualifying bin, no trade.",
    "Entry: a resting limit at the LVN bin's midpoint, placed at the bar that sets B. It fills when a later bar trades through it, at the limit, or at that bar's open if the bar gaps past it. Direction = the swing's direction (up-swing -> long).",
    "HTF bias: longs only if the last completed 1-hour close is above its 50-period EMA; shorts only if below.",
    "Cancel: a new extreme beyond B (the swing extends; recompute), a confirmed reversal pivot, or 15:30 ET for ETFs.",
    "Stop: the LVN bin's far edge minus 1 x ATR(14) for a long (mirror for a short). Target: B. Both tested on later bars; if a bar touches both, the stop wins.",
    "Exit: stop, target, or flat at 15:55 ET for ETFs (no overnight holds); BTC has a 24-hour time exit. One open trade per instrument.",
    "Costs: ETFs $0.02 per share round trip plus half the typical spread (1 cent) each side, in R. BTC 10 bps per side.",
  ],
  statistic: "Net R per trade. Per SESSION (ET date; the ETF pool sums its three instruments), the mean net R of that day's trades; t over sessions. Split: discovery 2018-2022 (ETF) / 2021-2022 (BTC); primary read on the HOLDOUT 2023-01-01..2026-08-31.",
  bar: { fixedInAdvance: true, unit: "holdout sessions", tRequired: BAR, variants: 4, source: `nullBar({variants:4, n:800, trials:20000}).p95 = ${BAR}`, alsoRequired: "the LVN must beat a RANDOM-LEVEL control — the same swings, filters, stops and targets with the entry at a random bin in the 20-80% band (200 draws) — at its 95th percentile; that is the reel's actual claim (the LVN is special), not merely 'buy pullbacks in a trend'" },
  controls: { randomLevel: "entry bin drawn uniformly from the 20-80% band, 200 draws", fixedFib: "entry at the 50% retracement (reported, not a gate)", bootstrap: "drift-free iid bootstrap of gross per-session R: |t| < 2", peek: "keep only trades whose target is hit first: must clear the bar", leak: "every level uses bars up to the bar that sets B; fills only on later bars" },
  interimKill: "n/a (historical)",
  decisionRule: { pass: "Holdout net t >= bar on the primary AND above the random-level 95th percentile: register a forward paper test on SPY/QQQ via the Alpaca mirror.", fail: "DID NOT PASS: the reel's LVN is not better than a random pullback level, net of costs." },
  readCondition: "one read, after the discovery split is inspected only for pipeline sanity and the controls pass; seal only then",
  expectation: "I expect DID NOT PASS: pullback entries in a trend earn roughly the trend's drift, and the random-level control will sit close to the LVN.",
  knownWeaknesses: ["The reel's discretion (which swing, which node) is replaced by a ZigZag and a fixed bin count.", "5-minute bars cannot order the high and low within a bar; stop-first is conservative.", "BTC Coinbase volume is one venue.", "Futures (NQ/ES) are excluded: our 5-minute history only starts 2025-12."],
  ip: "Public social-media content; the rule text is ours.", writerExists: false,
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-24", area: "R178 Swift Trades LVN rule — registered", category: "registration", breaksComparability: false, change: `Frozen LVN pullback rule; ETF pool + BTC; holdout 2023-2026; best-of-4 bar ${BAR} plus a random-level control.`, why: "Operator: 'yes test the LVN rule'.", doesNotEstablish: "Anything until the read.", operator: "Josh 2026-09-24" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R178"], detail: `Swift Trades LVN, bar ${BAR}` }) + "\n");
console.log(`R178 registered · bar ${BAR}`);
