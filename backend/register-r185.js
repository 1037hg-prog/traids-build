#!/usr/bin/env node
/** Registers R185 — the R178 LVN rule on index FUTURES with a futures cost model. 2026-09-24, operator: "test the LVN on futures with lower
 *  costs". POST-HOC ORIGIN, disclosed: R178 showed a gross edge on SPY/QQQ/IWM (t ~2.0-2.1 in both splits) that its $0.04/share cost
 *  erased; this test was chosen after seeing that. Its data (NQ/ES futures, Schwab 5-minute bars from 2025-12-17) was never used by R178,
 *  and the rule is R178's primary unchanged (k=3), so nothing is re-tuned — only the venue and its cost model differ. Refuses if R185 exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const { nullBar } = require("./lib/null-bar.js");
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R185")) { console.error("R185 already exists — refusing"); process.exit(2); }
const BAR = +nullBar({ variants: 1, n: 180, trials: 20000 }).p95.toFixed(3);
reg.preregistered.push({
  id: "R185", name: "LVN pullback on index futures (NQ, ES) — R178's primary rule with a futures cost model",
  registered: "2026-09-24", evidenceStart: "2025-12-17..2026-09-23 (all available Schwab 5-minute futures history), historical",
  evidenceNote: "Post-hoc venue choice after R178 (gross edge on ETFs, erased by cost). Same rule, parameters and code path as R178's primary (k=3, 24 bins, 20-80% band, half-median LVN threshold, 1-hour EMA50 bias, stop = LVN far edge -/+ 1 ATR, target = B, 15:30 ET cancel, 15:55 ET flat); only the instruments and costs change. Breakeven arithmetic seen before registration: R178 primary gross +0.049R/trade; at its cost 0.08R/trade -> breakeven about 60% of the ETF cost assumption.",
  status: "REGISTERED 2026-09-24 — historical read pending", script: "backend/r185-lvn-futures.js (reuses backend/r178-lvn.js internals)",
  parent: "Operator 2026-09-24: 'test the LVN on futures with lower costs'. Parent test: R178 (sealed DID NOT PASS).",
  multiplicityFamily: "LVN-FUT-1 — one rule, two contracts pooled per session (NQ and ES front months). Separate family from LVN-4 (different data, disclosed post-hoc origin).",
  rule: "Bars: Schwab pricehistory 5-minute for /NQ and /ES continuous front month, regular session 09:30-16:00 ET only (13:00 on early-close days), 2025-12-17..2026-09-23; volume as reported. Rule exactly as R178's primary (k=3). Costs per contract per round trip: $4.50 commissions and fees; entry and target fills are limit orders (no spread); a stop exit or a 15:55 flat pays 1 tick of slippage (NQ 0.25 pt = $5, ES 0.25 pt = $12.50). R = |limit - stop| in points x point value.",
  statistic: "Net R per trade; per ET session the mean net R of that day's trades across both contracts; t over sessions. Also reported: gross, per-contract split, the R178-style random-level control (200 draws), and the same rule on QQQ/SPY over the same dates with R178's cost for a like-for-like comparison.",
  bar: { fixedInAdvance: true, unit: "sessions (~180)", tRequired: BAR, variants: 1, source: `nullBar({variants:1, n:180, trials:20000}).p95 = ${BAR}`, alsoRequired: "LVN above the random-level 95th percentile on the same data" },
  controls: { randomLevel: "as R178", bootstrap: "drift-free iid bootstrap of gross per-session R: |t| < 2", peek: "target-hit-first trades only: must clear the bar", leak: "as R178" },
  interimKill: "n/a (historical)",
  decisionRule: { pass: "Register a forward test on the quote-priced MNQ book (backend/mnq-quote-paper.js pattern), operator's word.", fail: "Futures costs do not rescue the LVN gross edge on ~9 months of data; the forward ETF test with real limit-order fills is the remaining route." },
  readCondition: "one historical read",
  expectation: "LOW: ~180 sessions is little data; R178's gross effect (t ~2 over ~900 sessions) would show t ~0.9 here even if intact.",
  knownWeaknesses: ["Only ~9 months of 5-minute futures history (Schwab limit) — heavily underpowered; a DID NOT PASS means 'cannot tell' unless the point estimate is negative.", "Continuous front-month rolls: Schwab's continuous series may jump at rolls; trades spanning a roll are excluded.", "Futures volume at a 5-minute resolution differs from ETF volume profiles.", "Post-hoc venue choice (disclosed)."],
  ip: "Public social-media content; rule text is ours.", writerExists: false,
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-24", area: "R185 LVN on futures — registered", category: "registration", breaksComparability: false, change: `R178 primary rule on NQ/ES 5-minute (Schwab, 2025-12..2026-09) with a futures cost model; bar ${BAR}; post-hoc origin disclosed.`, why: "Operator: 'test the LVN on futures with lower costs'.", doesNotEstablish: "Anything until the read; underpowered by design.", operator: "Josh 2026-09-24" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R185"], detail: `LVN on NQ/ES futures, bar ${BAR}` }) + "\n");
console.log(`R185 registered · bar ${BAR}`);
