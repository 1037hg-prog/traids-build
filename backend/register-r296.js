#!/usr/bin/env node
/** Registers R296 — cumulative-delta divergence at a new session extreme, SPY and QQQ (operator 2026-09-30: "do both a and b", from an
 *  order-flow reel: heat map / volume profile / GEX / delta / bid trades / footprint). Written BEFORE any trade data is fetched. Refuses if
 *  R296 exists. The rule is the textbook "delta divergence" setup (price makes a new high, cumulative delta does not), written by us. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { nullBar } = require("./lib/null-bar.js");
const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R296")) { console.error("R296 exists — refusing"); process.exit(2); }
const n = 300, bar = +nullBar({ variants: 2, n, trials: 20000 }).p95.toFixed(3);
reg.preregistered.push({
  id: "R296", name: "Cumulative-delta divergence at a new session extreme (order flow) — fade new highs/lows that buying/selling pressure does not confirm, SPY and QQQ",
  registered: "2026-09-30", evidenceStart: "2024-10-01..2026-09-29 (historical, read once); fallback declared below",
  status: "REGISTERED 2026-09-30 — historical, read once (--selftest, then --read); builder assigned the same day",
  script: "backend/r296-delta-divergence.js", parent: "Operator 2026-09-30 ('do both a and b') after an order-flow reel (Delta / Bid trades / Footprint panels). Nearest tests: R178/R185/R294 volume profile (DID NOT PASS), R289 gamma-proxy fade (DID NOT PASS); no TRAIDS test has used trade-signed (aggressor) volume.",
  multiplicityFamily: "DELTA-0930 — 2 cells: {SPY, QQQ}, sides pooled; best-of-2 bar at each symbol's session count. The control arm and placebos are falsifiers, not family members.",
  rule: [
    "DATA: Alpaca SIP historical TRADES (older than 15 minutes, so allowed on our plan) for SPY and QQQ, regular hours 09:30:00-15:59:59 ET. Trades carrying SIP condition codes for out-of-sequence, extended-hours/form-T, derivatively-priced, or average-price prints are excluded; the builder fixes and lists the exact codes in the script header before the read.",
    "SIGNING (tick rule, trades only; no quotes): a trade above the last different price is a buy (+size), below it a sell (-size), equal = the previous sign; the first trade of the day is unsigned.",
    "CUMULATIVE DELTA CD(t) = sum of signed size since 09:30. 5-minute bars (OHLC) are built from the same trades.",
    "SIGNAL (bearish divergence): at the close of a 5-minute bar ending between 10:00 and 15:00 ET whose HIGH exceeds every earlier high of the session, if CD at this bar's close is BELOW CD at the close of the bar that set the previous session high -> SHORT at the next bar's open. Mirror (bullish divergence): new session LOW with CD ABOVE its value at the previous session low -> LONG at the next bar's open. At most one signal per side per session (the first).",
    "EXIT: the close of the 6th bar after entry (30 minutes) or the 15:55 ET price, whichever comes first. No stop, no target.",
    "COST: $0.01 per share per side (spread + fees) charged on every entry and exit.",
    "WINDOW FALLBACK (declared now): if fetching the full two years of trades would take more than 3 hours, the read uses the most recent 250 sessions ending 2026-09-29; the builder says which was used.",
  ].join(" "),
  statistic: "Per-session net return of that session's divergence trades (sessions with >= 1 signal), one-sample t over SESSIONS, per symbol.",
  unit: "sessions", nExpected: n,
  bar: { fixedInAdvance: true, unit: "sessions", tRequired: bar, variants: 2, source: `nullBar({variants:2, n:${n}, trials:20000}).p95 = ${bar}` },
  controls: {
    control: "SAME rule WITHOUT the delta condition: fade the first new session high/low after 10:00 regardless of CD. The divergence arm's mean must EXCEED the control's mean, or the delta adds nothing.",
    placebo: "Delta labels shuffled across the session's new-extreme events (>= 500 draws): the true divergence mean must beat the placebo's 95th percentile.",
    halves: "first/second half of the window must share the sign.",
  },
  decisionRule: { pass: "PASS only if t >= bar AND the divergence mean beats the no-delta control AND the placebo p95 AND both halves share the sign. A PASS proposes a forward paper test (Alpaca paper, same rule) — operator's call.", fail: "DID NOT PASS: aggressor-signed delta adds nothing tradeable at this horizon on the index ETFs; recorded with the control comparison." },
  interimKill: "none (single historical read)", readCondition: "read once after --selftest passes its known answers (tick-rule signing on a hand-made trade tape; CD and bar construction; a no-signal day gives zero trades).",
  expectation: "LOW: order-flow imbalance is mostly contemporaneous in the literature (Cont, Kukanov & Stoikov 2014); a 30-minute fade after a delta divergence is a practitioner claim with no out-of-sample record we know of.",
  knownWeaknesses: [
    "Tick-rule signing without quotes misclassifies a meaningful share of trades (roughly 20-30% versus quote-based Lee-Ready in the literature) and cannot see hidden or midpoint liquidity.",
    "Retail platforms compute delta from futures (ES/NQ) exchange data with the aggressor flag; ETF SIP trades aggregate many venues and dark prints, so this is a proxy for the reel's panels, not a replica.",
    "Two years, two highly correlated symbols: effective independence is less than the cell count suggests.",
  ],
  ip: "ours (textbook setup; rule text ours)", writerExists: false, writerNote: "runner written by the builder agent on 2026-09-30",
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-30", area: "registry — R296 delta divergence", category: "registration", breaksComparability: false, change: `Registered R296 before any trade data: cumulative-delta divergence fade at new session extremes, SPY and QQQ, Alpaca SIP trades 2024-10..2026-09, tick-rule signing; bar ${bar} (best-of-2); no-delta control + label-shuffle placebo + halves.`, why: "Operator: do both a and b (order-flow reel).", doesNotEstablish: "Any result.", operator: "Josh 2026-09-30" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "register", tests: ["R296"], detail: "delta divergence, bar " + bar }) + "\n");
console.log("R296 registered · bar", bar);
