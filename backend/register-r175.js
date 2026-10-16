#!/usr/bin/env node
/** Registers R175 — the Payne replica rule. 2026-09-24, operator: "yes test the payne replica rule". Parameters are frozen from the
 *  DESCRIPTIVE profile of his 541 checkable entries (2021-2026: 12m +43% median, 83% above the 200-day, ~11% below the 52-week high,
 *  39% after a +5% day, RSI ~57, winners out near +14%, no stop) — the rule's own outcomes have not been computed. Refuses if R175 exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const { nullBar } = require("./lib/null-bar.js");
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R175")) { console.error("R175 already exists — refusing"); process.exit(2); }
const BAR = +nullBar({ variants: 1, n: 115, trials: 20000 }).p95.toFixed(3);
reg.preregistered.push({
  id: "R175", name: "Payne replica rule — momentum leaders on a post-earnings pause, +15% take-profit, no stop (historical, 2017-2026)",
  registered: "2026-09-24", evidenceStart: "2026-09-24 (historical; the rule's outcomes computed only after this registration)",
  evidenceNote: "Parameters come from the profile of Payne's published entries/exits (data/payne-model-portfolio.json + payne-record-audit.json, 2026-09-24), not from any run of this rule. The 2017-2020 span was never used to derive anything (his checkable-feature trades are 2021+), so it is the clean out-of-sample leg; 2021-2026 overlaps the period the profile came from and is reported separately.",
  status: "REGISTERED 2026-09-24 — historical read pending", script: "backend/r175-payne-replica.js",
  parent: "Operator 2026-09-24: 'what's his algo' -> profile of 541 trades -> 'yes test the payne replica rule'. Related: R147 (earnings-beat momentum, his ebook), R159 (his picks forward).",
  multiplicityFamily: "PAYNE-REPLICA-1 — one frozen rule; no parameter search. Controls are not variants.",
  rule: "Panel data/anomaly-cache-v2 (adjusted daily close/open/volume, look-ahead-safe truncation). Universe on day t: >= 260 prior closes and 20-day median dollar volume >= $25M. Signal at close t: (a) 12-1 month return (close[t-21]/close[t-252]-1) in the top 30% of the day's universe; (b) close above both its 50- and 200-day averages; (c) close 5%-20% below its 252-day highest close; (d) at least one close-to-close gain >= +5% in the last 10 sessions; (e) RSI(14) between 45 and 70. Selection: on the first trading day of each week, up to 3 new names from the prior session's signals, highest 12-1 return first, not already held; entry at that day's open; max 40 open positions. Exit: the first close >= entry x 1.15 -> sell at the next open; else 365 calendar days -> next open; a name leaving the panel is sold at its last close. No stop. Book: 40 equal slots (1/40 of equity each at entry, cash otherwise); costs 10 bps per side.",
  statistic: "Primary: the book's daily-return regression on SPY — annualised alpha after beta, t over days (HAC not needed at daily frequency for a one-lag check; reported both plain and Newey-West lag 5). Report: CAGR, max drawdown, beta, per-trade excess over SPY (same window) clustered by entry month, and — 2021-2026 only — the correlation of the replica's daily returns with Payne's own equal-weight book.",
  bar: { fixedInAdvance: true, unit: "daily alpha t (Newey-West lag 5) over the full 2017-01..2026-08 window", tRequired: BAR, variants: 1, source: `nullBar({variants:1, n:115, trials:20000}).p95 = ${BAR} (n = months, the conservative clustering)`, alsoRequired: "alpha above the 95th percentile of the RANDOM-SELECTION control (same universe filters, same pace and exits, 3 random universe names a week, 200 runs) — so the momentum filters, not the exit rule or the market, carry it" },
  controls: { randomSelection: "200 runs: same weekly pace, universe, exits and costs; names drawn at random from the day's universe", peek: "rank by the next 60 sessions' return instead of 12-1 momentum: must produce a large positive alpha (the pipeline can see an edge)", leakCheck: "every signal input uses closes up to t; entry is t+1 open" },
  interimKill: "n/a (historical)",
  decisionRule: { pass: "The rule captures his edge mechanically: register a forward paper test (Alpaca mirror) and tell the operator the subscription's picks are reproducible for free.", fail: "DID NOT PASS: the replica is high-beta momentum with no alpha — the same verdict as his own book; the subscription buys market-plus beta." },
  readCondition: "one read, historical, once the controls pass",
  expectation: "I expect beta > 1 and alpha near zero after beta, like his own record; the random-selection control will show how much of the return is just the exit rule plus a rising market.",
  knownWeaknesses: ["Adjusted prices: the +15% target and 52-week high read adjusted closes (dividend adjustment shifts levels slightly); dollar-volume screen is split-invariant.", "No intraday highs in the panel: the take-profit triggers on a close and fills next open, which lags his limit/alert exits.", "No earnings calendar: the +5% day in 10 sessions is a proxy for a post-earnings pop.", "His discretion (fundamentals, themes, news) is not replicable; the rule tests only the price-visible part.", "Point-in-time universe from AV listing status (delisted names included) — survivorship-safe as far as that list is complete."],
  ip: "Derived from Payne's PUBLISHED record (public web page); the rule is ours.", writerExists: true,
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-24", area: "R175 Payne replica rule — registered", category: "registration", breaksComparability: false, change: `Frozen replica of Payne's price-visible behaviour; historical 2017-2026 read; bar ${BAR} + random-selection control.`, why: "Operator: 'yes test the payne replica rule'.", doesNotEstablish: "Anything until the read.", operator: "Josh 2026-09-24" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R175"], detail: `Payne replica rule, bar ${BAR}` }) + "\n");
console.log(`R175 registered · bar ${BAR}`);
