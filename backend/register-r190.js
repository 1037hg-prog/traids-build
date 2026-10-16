#!/usr/bin/env node
/** Registers R190 — the crypto trend filter (hold above the N-day average, else cash) tested on coins OTHER than ETH. 2026-09-24, operator:
 *  "yes register and run R190". Origin, disclosed: on ETH (2017-05..2025-09) the main session tried N = 50/100/200 (+1.5x) and SMA50 read
 *  alpha t 2.11 — a best-of-4 pick. ETH is therefore EXCLUDED here; the other coins' histories have not been run with this rule (BTC/ETH ran
 *  only inside R189's 2021-2025 100-day benchmark, which is disclosed). Refuses if R190 exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const { nullBar } = require("./lib/null-bar.js");
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R190")) { console.error("R190 already exists — refusing"); process.exit(2); }
const BAR = +nullBar({ variants: 3, n: 2800, trials: 20000 }).p95.toFixed(3);
const COINS = ["BTC", "LTC", "BCH", "ETC", "LINK", "XLM", "ADA", "SOL", "DOGE", "AVAX", "DOT", "ATOM", "UNI", "AAVE", "XTZ", "ALGO"];
reg.preregistered.push({
  id: "R190", name: "Crypto trend filter across coins (not ETH) — hold above the N-day average, else cash",
  registered: "2026-09-24", evidenceStart: "2018-01-01..2025-09-23, historical (Coinbase daily candles)",
  status: "REGISTERED 2026-09-24 — historical read pending", script: "backend/r190-crypto-trend.js",
  parent: "Operator 2026-09-24: 'why not trade the 50-day ETH trend rule' -> 'yes register and run R190'. Discovery (ETH, best-of-4) disclosed above; ETH excluded.",
  multiplicityFamily: "CRYPTO-TREND-3 — N in {50, 100, 200} days. Best-of-3 bar.",
  rule: `Coins: ${COINS.join(", ")} (Coinbase USD pairs; a coin enters once it has N+1 daily closes on Coinbase and remains while it trades there). Each day per coin: long at the next day's open... simplified to close-to-close: position for day d+1 = 1 if the close on day d is above the N-day simple average of closes through day d, else 0 (cash earns 0). Cost 25 bps per side on every switch (conservative retail); 10 bps reported. Portfolio: equal weight across the coins trading that day, rebalanced daily; benchmark: equal-weight buy-and-hold of the same coins, same rebalancing.`,
  statistic: "Primary: daily portfolio net return regressed on the benchmark's daily return; the intercept (alpha, annualised) with a Newey-West lag-5 t over days. Must ALSO hold: portfolio max drawdown at least 15 percentage points smaller than the benchmark's. Reported: CAGR, max drawdown, Sharpe, time in market, per-coin alpha and drawdown, and by year.",
  bar: { fixedInAdvance: true, unit: "days (~2,800)", tRequired: BAR, variants: 3, source: `nullBar({variants:3, n:2800}).p95 = ${BAR}`, alsoRequired: "max-drawdown reduction >= 15 points vs the benchmark" },
  controls: { randomTiming: "per coin, the same fraction of days in the market placed as random blocks of the same average length (200 draws): the true alpha must beat the 95th percentile", peek: "perfect-foresight long/flat (position = sign of the next day's return) must clear the bar" },
  interimKill: "n/a (historical)",
  decisionRule: { pass: "Register a forward paper test of the passing N on BTC and ETH via the Alpaca paper crypto account, operator's word.", fail: "The trend filter's ETH result was specific to ETH's history; report the drawdown effect separately if it holds without the alpha." },
  readCondition: "one historical read",
  expectation: "MED: crypto time-series momentum is documented; the drawdown reduction is likely, positive alpha after 25 bps costs is less certain.",
  knownWeaknesses: ["Survivorship: coins still listed on Coinbase today; delisted coins (e.g. XRP 2021-23 gap) are not in the list.", "Crypto returns are highly correlated across coins — the effective sample is closer to one or two market cycles.", "Close-to-close with the signal on the same close is an idealisation; next-open fills are reported as a sensitivity."],
  ip: "none", writerExists: false,
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-24", area: "R190 crypto trend filter (ex-ETH) — registered", category: "registration", breaksComparability: false, change: `N 50/100/200 on ${COINS.length} coins, 2018-2025, 25 bps a side; best-of-3 bar ${BAR} + drawdown gate.`, why: "Operator: 'yes register and run R190'.", doesNotEstablish: "Anything until the read.", operator: "Josh 2026-09-24" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R190"], detail: `crypto trend ex-ETH, bar ${BAR}` }) + "\n");
console.log(`R190 registered · bar ${BAR}`);
