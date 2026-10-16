#!/usr/bin/env node
/** Registers R219 — month-end Treasuries on 10-year note FUTURES at ~5x, quote-priced paper (operator 2026-09-24: "so do 5x for 5 days a
 *  month"). The same edge as R180/R186 (NOT independent evidence), sized with leverage on ZN. Motivation (exploratory, disclosed):
 *  backend/futures-month-end.js — ZN 2003-2026 t 3.5, 5x book CAGR 9.9% incl. T-bills, max drawdown -28%. Refuses if R219 exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const { nullBar } = require("./lib/null-bar.js");
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R219")) { console.error("R219 already exists — refusing"); process.exit(2); }
const BAR = +nullBar({ variants: 1, n: 12, trials: 20000 }).p95.toFixed(3);
reg.preregistered.push({
  id: "R219", name: "Month-end Treasuries on 10-year note futures (ZN), 2 contracts on a $50,000 book (~4-5x), quote-priced paper",
  registered: "2026-09-24", evidenceStart: "2026-10 window (entry 2026-10-23, exit 2026-10-30)", status: "REGISTERED 2026-09-24 — writer wired; first window October 2026", script: "backend/r219-zn-month-end.js",
  parent: "R180 (sealed PASS) / R186 (IEF forward). Operator 2026-09-24.", multiplicityFamily: "R180-FORWARD-2 — the levered futures leg of R180; runs beside R186 on the same windows, so the two are one edge, not two.",
  rule: [
    "Windows: entry on the 6th-to-last NYSE session of each month, exit on the last session (R186's calendar, Alpaca /v2/calendar).",
    "At 15:35-15:48 ET on the entry session: BUY 2 ZN contracts at Schwab's live ASK. At the same time on the exit session: SELL 2 at the live BID. Contract = the first quarterly ZN contract (H/M/U/Z) whose delivery month is at least two calendar months after the window month (so the position never touches first notice day).",
    "Quote must be two-sided, uncrossed and <= 10 s old (three tries); an entry with no valid quote opens nothing (row logged); an exit with no valid quote is retried in the close chain (~16:15 ET, ZN still trading) and marked late.",
    "Fees ASSUMED $2.50 per contract per side (commission + exchange), recorded separately from gross. Record type: quote-priced-paper, venue none — NOT a broker fill. OFF switch data/r219-OFF.",
  ],
  statistic: "Per window: net P&L / $50,000; t over windows. Reported: gross vs net, spread paid in ticks, the same window on R186's IEF fills (tracking), and the book's leverage at entry (contract notional x 2 / $50,000). T-bill interest on the idle $50,000 is NOT included in the statistic.",
  bar: { fixedInAdvance: true, unit: "monthly windows", minWindows: 12, tRequired: BAR, variants: 1, source: `nullBar({variants:1, n:12, trials:20000}).p95 = ${BAR} (R186's bar, same unit)` },
  controls: { tracking: "window P&L must correlate > 0.8 with R186's IEF window return (else the futures leg is measuring something else)" },
  interimKill: "none (paper); the operator sees each window in the close-chain report", readCondition: "read once after 12 windows (~2027-09-30)",
  decisionRule: { pass: "The levered month-end Treasury leg works on quote-priced futures fills: real-money sizing is the operator's decision (and needs a futures account).", fail: "Futures execution or the forward period does not carry the edge; stay with R186 (unlevered IEF) or stop." },
  expectation: "MED: the edge is audited (raw IEF 2003-2026 t 4.48); 12 forward windows are few, so a miss is weak evidence against it.",
  knownWeaknesses: ["Same edge as R186 — not independent.", "Quote-priced, not broker-filled: no queue, partial fill or broker behaviour.", "2 contracts is lumpy: leverage drifts with price (~4.2x at 104.7).", "Fees are assumed."],
  ip: "rule ours (published mechanism: Hartley & Schwarz)", writerExists: false,
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-24", area: "R219 month-end Treasuries on ZN futures (~5x, quote-priced paper) — registered", category: "registration", breaksComparability: false, change: `2 ZN on $50k, R186 windows, Schwab bid/ask; bar ${BAR} at 12 windows`, why: "Operator: 'so do 5x for 5 days a month'.", doesNotEstablish: "Anything until the read; not independent of R186.", operator: "Josh 2026-09-24" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R219"], detail: `ZN month-end ~5x quote-priced paper, bar ${BAR}` }) + "\n");
console.log(`R219 registered · bar ${BAR}`);
