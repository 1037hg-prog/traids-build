#!/usr/bin/env node
/** Registers R309 — BTC/ETH surge, hold 48 hours, FORWARD on Alpaca paper (operator 2026-10-01: "fo sho"). The rule was FOUND post hoc:
 *  in R308's reported-only BTC+ETH subset, R307 surge entries held 48 h made +0.71%/day net (t 2.58, 386 trades, 283 days, 54% win) while
 *  an exploratory random-hour 48 h hold on the same coins and years made -0.27%/day (2,097 days) — so the entry seems to add something
 *  beyond drift. None of that is evidence: R309 is forward only, one fixed rule, so the bar is single-variant. Refuses if the id exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { nullBar } = require("./lib/null-bar.js");
const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
const ID = "R309", TODAY = "2026-10-01", N = 40;
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === ID)) { console.error(`${ID} exists — refusing`); process.exit(2); }
const b = +nullBar({ variants: 1, n: N, trials: 20000 }).p95.toFixed(3);
reg.preregistered.push({
  id: ID, registered: TODAY, name: "BTC/ETH surge, hold 48 hours — forward on Alpaca paper with a random-hour twin",
  status: `REGISTERED ${TODAY} — forward; evidence starts the day the runner first runs hourly on the always-on host (dated note at that moment); builder assigned`, script: "backend/r309-surge-hold48.js",
  parent: "Post-hoc lead from R308's reported-only subset (sealed DID NOT PASS 2026-10-01): BTC+ETH R307 surges held 48 h +0.71%/day net t 2.58 (283 days, 386 trades). Exploratory baseline the same evening: random-hour 48 h holds on BTC+ETH 2021-2026 -0.27%/day net (2,097 days; by year 2021 +0.30, 2022 -0.94, 2023 +0.01, 2024 -0.10, 2025 -0.45, 2026 -0.49). Operator 2026-10-01: 'fo sho'.",
  multiplicityFamily: "SURGE48 — R309 alone; one fixed forward rule (the post-hoc search happened on past data; the forward evidence is new).",
  evidenceStart: "the first UTC day the runner completes 24 consecutive hourly cycles on the always-on TRAIDS host (expected early October 2026); recorded as a dated note in this entry when it happens; nothing earlier counts",
  rule: [
    "SIGNAL (R307's surge rule, unchanged), evaluated at each hour's close on Coinbase Exchange hourly candles for BTC-USD and ETH-USD: hourly return >= 3 x the trailing 168-hour hourly return standard deviation AND hourly volume >= 3 x the trailing 168-hour median hourly volume AND the close above the prior 24-hour high; at most one entry per coin per 24 hours.",
    "TRADE: within 10 minutes of the surge hour's close, a MARKET BUY of $2,000 notional of BTC/USD or ETH/USD on the Alpaca PAPER account (client ids r309-*); SELL the exact filled quantity at market 48 hours after the entry fill. No stop, no target. Fills from the broker; return = (exit fill / entry fill - 1) - 0.50% (the registered Alpaca taker cost, also applied if paper charges nothing; actual paper fees recorded).",
    "RANDOM-HOUR TWIN (no orders, quote-priced): for every real entry, a twin entry at a uniformly random hour of the same coin within the 72 hours before the signal that did NOT meet the surge rule, priced at Coinbase hourly closes, held 48 h, charged the same 0.50%.",
    "MISSED HOURS: an hour the runner did not evaluate is logged as a gap (never back-filled as a trade).",
  ].join(" "),
  statistic: "Per UTC day with entries: mean net trade return. One-sample t over entry days; read at 40 entry days. Paired control: per-day mean (real - twin), reported and gated (mean > 0).",
  unit: "entry days", nExpected: N,
  controls: { twin: "random-hour twin as above; the real must beat it (mean paired difference > 0)", drift: "BTC/ETH buy-and-hold over the same window reported", fills: "entry slippage vs the surge-hour close reported" },
  bar: { fixedInAdvance: true, unit: "entry days", tRequired: b, variants: 1, source: `nullBar({variants:1, n:${N}, trials:20000}).p95 = ${b}` },
  interimKill: "At 20 entry days: net t <= -2.0 -> stop (kill only).",
  decisionRule: {
    pass: "PASS if net t >= bar at 40 entry days AND the mean paired difference vs the random-hour twin is > 0. A PASS proposes a small live allocation — the operator's call; nothing is funded automatically.",
    fail: "DID NOT PASS: the post-hoc lead did not survive new data; closed.",
  },
  knownWeaknesses: [
    "The rule was selected after looking at many subsets and exits on the same history (R307/R308); only the forward evidence counts.",
    "Slow: about 70 BTC/ETH surges a year historically, so 40 entry days is roughly 6-8 months.",
    "Correlated: BTC and ETH often surge on the same day; day clustering handles it, but effective N is days, not trades.",
    "Paper fills on Alpaca crypto may be kinder than live; the 0.50% charge is applied regardless.",
    "Depends on the always-on host: crypto surges happen 24/7 and the home PC sleeps.",
  ],
  readCondition: "--read once at 40 entry days; seals in read-seals.json.",
  writerExists: false, writerNote: "runner written by a builder agent on 2026-10-01 with --selftest and a dry mode; it goes live hourly when the always-on host is up",
  ip: "ours",
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: TODAY, area: "registry — R309 BTC/ETH surge hold-48 forward", category: "registration", breaksComparability: false, change: `Registered R309 forward: R307 surge rule on BTC/ETH, $2,000 paper market buy, sell at 48 h, 0.50% cost, random-hour twin, read at 40 entry days, bar ${b} (single forward rule), interim kill at 20 days. Disclosed as a post-hoc lead (R308 subset +0.71%/day t 2.58; random-hour baseline -0.27%/day).`, why: "Operator 2026-10-01: 'fo sho'.", doesNotEstablish: "Any result.", operator: "Josh 2026-10-01" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "register", tests: [ID], family: "SURGE48" }) + "\n");
console.log(`${ID} registered · bar ${b} (entry days, single forward rule) · ${reg.preregistered.length} preregistered`);
