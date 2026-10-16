#!/usr/bin/env node
/** Registers R141 — the R13 fade on the untouched holdout. 2026-09-21, operator: "go". Refuses if R141 exists. Filed while the holdout NEWS
 *  crawl runs (headlines only) and BEFORE any holdout price, quote or outcome is fetched. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R141")) { console.error("R141 already exists — refusing"); process.exit(2); }
const entry = {
  id: "R141",
  name: "Fade the pre-market-news gappers (R13 reversed) on the untouched holdout, at an executable entry and a measured cost",
  registered: "2026-09-21",
  evidenceStart: "2025-03-03",
  evidenceNote: "Historical holdout 2025-03-03..2026-09-18. R13's news crawl stopped at 2025-02-26 (6000-page cap); nothing after that date has been read for this question. Registered before any holdout price, quote or outcome was fetched; one read, sealed.",
  status: "REGISTERED 2026-09-21 — news crawl running; leak test, then one read",
  script: "backend/r141-r13-fade.js",
  parent: "R13 (STAGNANT 2026-08-03): buying the gappers LOST 0.508pp gross vs SPY per trade (t -4.20) over 290 days 2024-01..2025-02. Screen of the 29 'reliable losers' (corpus read) on 2026-09-21: R13 is the only one whose PRE-cost loss exceeds the round-trip cost.",
  multiplicityFamily: "FADE-R13 — two entry timings (09:35, the open). The direction is fixed by R13's in-sample result; the holdout has never been read.",
  rule: "Event: a 1-5 letter symbol tagged on >= 1 Alpaca news article created 04:00-09:25 ET on day d, whose SIP daily open is >= 1.02 x the prior SIP close and >= $5. PRIMARY '0935': short at the open of the 09:35 SIP 1-minute bar, cover at the SIP daily close; SPY hedged over the same interval. SECOND 'open': short at the SIP daily open, cover at the close (R13's timing, which selects on the price it enters at). Fade excess = -[(exit/entry-1) - (SPY exit/SPY entry-1)] x 100 pp. Cost per event = half the SIP quoted spread at entry + half at exit (median over 09:35:00-09:35:30 [09:30:30-09:31:00 for 'open'] and 15:59:00-15:59:30) + 0.05pp fees/slippage + 0.10pp one-day borrow; no two-sided quote = 1.00pp + borrow.",
  statistic: "Per trading DAY the mean net fade excess over that day's events; mean and t across days. Unit: trading day.",
  bar: { fixedInAdvance: true, unit: "trading days", minDays: 200, tRequired: 2.0, variants: 2, source: "lib/null-bar.js nullBar({variants:2, n:380, trials:20000}).p95 = 1.964, floored at the house 2.0" },
  leakTest: { plan: "Before the real read: the same selection with each event's open->close replaced by the same symbol's open->close on a random other holdout day (seeds 1, 2, 3). Must show |t| < 2 on the gross fade; otherwise the pipeline, not the market, is producing the result and the read is not taken." },
  interimKill: "none — one run over a fixed holdout",
  decisionRule: {
    pass: "A variant with >= 200 days, net mean > 0, t >= 2.0, and net mean > 0 in BOTH halves by date. PASS adopts NOTHING: the missing piece is the real borrow cost and availability of these names, which a quote feed cannot show; a PASS routes to the operator as a candidate for a short-side paper test at a broker that reports borrow (fees and locate), registered separately.",
    fail: "Otherwise DID NOT PASS: R13's losing pattern does not survive as a tradeable fade at an executable entry and measured cost; the R13 line is closed and no other gap threshold, window or filter is to be run on the holdout.",
  },
  readCondition: "After the news crawl completes and the leak test passes: node backend/r141-r13-fade.js (refuses unless R141 is registered).",
  expectation: "I expect it not to pass: the likely reasons R13's loss looked large (a thin opening print; entering at the price that defined the event) are exactly what flatter a fade, and the rule removes both.",
  knownWeaknesses: [
    "BORROW: 0.10pp per day is a flat guess. Hard-to-borrow gappers can cost far more, or be unshortable; a PASS does not show they could be shorted.",
    "SHORT-SIDE EXECUTION: shorting into a morning gap risks halts, squeezes and locate failures that a bar test does not see.",
    "NEWS TAGGING: Alpaca's symbol tags are the vendor's; an article can tag a symbol it barely mentions. Same as R13.",
    "ADJUSTMENT: daily bars are adjustment=all (splits and dividends); ex-dividend days inside the window shift the open/close comparison slightly.",
    "THE 09:35 ENTRY changes R13's population timing: part of any R13 effect may occur in the first five minutes and is deliberately given up.",
  ],
  ip: "Our own rule on public news headlines and prices; no third-party material.",
  writerExists: true,
};
reg.preregistered.push(entry); reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-21", area: "R141 R13 fade — registered", category: "registration", breaksComparability: false, change: "R141 registered before any holdout price was read: fade R13's pre-market-news gappers at 09:35 (primary) and at the open, SIP prices, measured SIP spreads, 0.10pp borrow; bar t >= 2.0, both halves positive.", why: "Operator asked for the best of the worst to fade; R13 is the only reliable loser whose pre-cost loss exceeds the round-trip cost.", doesNotEstablish: "That the names could actually be borrowed.", operator: "Josh: 'go' 2026-09-21" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R141"], detail: "R13 fade on holdout 2025-03..2026-09, t>=2.0, expectation: not to pass" }) + "\n");
console.log("R141 registered");
