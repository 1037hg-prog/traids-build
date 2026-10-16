#!/usr/bin/env node
/** PRE-EVIDENCE amendment to R271 (2026-09-27, same session as registration, before any flow data was fetched).
 *  Trigger: the operator sent LuxAlgo's open-source Whale Options page; probing Alpaca showed historical option TRADES carry
 *  exchange + sale-condition codes (S/b/d = intermarket sweep, f..m = multi-leg), which fixes two registered weaknesses
 *  (spread legs, no sweep detection). Adds variant B and moves the bar to best-of-2. Refuses if already amended. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const { nullBar } = require("./lib/null-bar.js");
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
const t = reg.preregistered.find((x) => x.id === "R271"); if (!t) { console.error("R271 missing"); process.exit(2); }
if ((t.amendments || []).some((a) => a.id === "R271-A1")) { console.error("already amended"); process.exit(2); }
const BAR = +nullBar({ variants: 2, n: 400, trials: 20000 }).p95.toFixed(3);
t.amendments = t.amendments || [];
t.amendments.push({ id: "R271-A1", date: "2026-09-27", preEvidence: true, before: { bar: t.bar.tRequired, variants: 1 },
  change: "Adds VARIANT B (clean sweeps). Primary A unchanged. Both graded; bar is now best-of-2.",
  variantB: [
    "Start from variant A's qualifying contract-days (same filters).",
    "Fetch that contract's trades for day d (Alpaca /v1beta1/options/trades). Drop multi-leg trades (conditions f,g,h,i,j,l,m and any later multi-leg code) and cancelled/late-cancel prints (A,C,E,G).",
    "Recompute volume and premium from the remaining single-leg trades; the contract-day must still clear volume >= 500 and premium >= $500,000.",
    "Sweep share = single-leg volume that is ISO-flagged (S, b, d) OR part of a sweep cluster (same contract, >= 2 exchanges, trades within 500 ms of each other, LuxAlgo's definition) / single-leg volume. Qualifies only if sweep share >= 0.5.",
    "Direction, net premium per name-day, trade, statistic and control exactly as variant A (single-leg premium).",
  ],
  why: "Multi-leg spreads and non-urgent prints are the two largest non-directional sources in variant A; sweeps are the classic 'someone in a hurry' print. Still no buyer/seller side (Alpaca has no historical option quotes).",
  barAfter: `nullBar({variants:2, n:400, trials:20000}).p95 = ${BAR}` });
t.bar = { ...t.bar, tRequired: BAR, variants: 2, source: `nullBar({variants:2, n:400, trials:20000}).p95 = ${BAR} (R271-A1)` };
t.knownWeaknesses.push("Variant B tick-free: sweep share says urgency, not side. A sweep SELLING calls still reads bullish.");
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-27", area: "R271-A1 pre-evidence amendment — variant B clean sweeps", category: "amendment", breaksComparability: false, change: `variant B (single-leg, sweep share >= 0.5); bar ${t.amendments.at(-1).before.bar} -> ${BAR} best-of-2`, why: "Alpaca trade condition codes identify sweeps and spread legs; no flow data read yet.", doesNotEstablish: "Anything until the read.", operator: "Josh 2026-09-27 (LuxAlgo page)" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "amend-pre-evidence", tests: ["R271"], detail: `R271-A1 variant B sweeps, bar ${BAR}` }) + "\n");
console.log(`R271-A1 · bar ${BAR} (best-of-2)`);
