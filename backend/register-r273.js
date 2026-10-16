#!/usr/bin/env node
/** Registers R273 — Gayed & Bilello's published intermarket rotation signals, tested ONLY on data after publication (2014–2015 papers;
 *  Alpaca SIP history starts 2016). Operator 2026-09-27: "yes register Gayed's signals". Written before any signal or return was computed;
 *  the only data touched was an availability probe (lumber futures on the Yahoo proxy: LBR=F from 2022-08-05; the old LBS contract is gone).
 *  Refuses if R273 exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const { nullBar } = require("./lib/null-bar.js");
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R273")) { console.error("R273 exists — refusing"); process.exit(2); }
const BAR = +nullBar({ variants: 3, n: 500, trials: 20000 }).p95.toFixed(3);
reg.preregistered.push({
  id: "R273", name: "Gayed/Bilello intermarket rotations (Lead-Lag Report) — post-publication out-of-sample: utilities, 10y-vs-30y Treasuries, lumber-vs-gold",
  registered: "2026-09-27", evidenceStart: "2016-02-01", status: "REGISTERED 2026-09-27 — historical, read once; runner backend/r273-gayed-rotations.js", script: "backend/r273-gayed-rotations.js",
  parent: "Operator 2026-09-27 after the Seeking Alpha Investing Groups review: test The Lead-Lag Report's published signals ourselves instead of taking the trial.",
  sources: ["Gayed & Bilello 2014, 'An Intermarket Approach to Beta Rotation: The Strategy, Signal and Power of Utilities' (Charles H. Dow Award)", "Gayed & Bilello 2014, 'An Intermarket Approach to Tactical Risk Rotation: Using the Signaling Power of Treasuries' (SSRN 2431022)", "Bilello & Gayed 2015, 'Lumber: Worth Its Weight in Gold' (NAAIM Wagner Award)"],
  multiplicityFamily: "GAYED-1 — three variants, one rule each, parameters taken verbatim from the papers (nothing searched); best-of-3 bar.",
  rule: [
    "Weekly. Signal from closes up to the LAST session of each week; position held from the NEXT session's OPEN to the open of the session after the following week's last session (open-to-open). Alpaca SIP daily bars, adjustment=all (total return).",
    "V1 UTILITIES: if XLU's return over the prior 20 sessions (4 weeks) > SPY's -> hold XLU next week; else SPY.",
    "V2 TREASURIES: if IEF's (10y proxy) return over the prior 20 sessions (the prior month) > TLT's (30y proxy) -> hold SPY next week; else hold IEF.",
    "V3 LUMBER/GOLD: if lumber futures (Yahoo LBR=F continuous, close) return over the prior 65 sessions (13 weeks) > GLD's -> hold SPY next week; else hold IEF. Window starts when 65 sessions of LBR=F exist (from ~2022-11).",
    "Costs: 5 bps per side on every switch (10 bps round trip).",
  ],
  statistic: "Per variant: weekly ACTIVE return = strategy minus a static mix holding the two assets at the variant's own average time-in-each (rebalanced weekly, no switching cost); one-sample t over weeks. Raw strategy CAGR/maxDD/Sharpe reported first beside SPY buy-and-hold and the static mix.",
  controls: { timing: "Circular shifts of the variant's own weekly signal sequence (1,000 random offsets): same time in each asset, same switch count, same run structure, wrong timing. PASS needs t >= bar AND mean active > shift p95." },
  bar: { fixedInAdvance: true, unit: "weeks", tRequired: BAR, variants: 3, source: `nullBar({variants:3, n:500, trials:20000}).p95 = ${BAR}` },
  secondary: "Reported, not graded: TLT instead of IEF as the defensive asset (V2, V3); IWM instead of SPY as offense (V3, as the paper suggests small caps); 2016-2021 vs 2022-2026 halves (V1, V2); share of weeks agreeing with our 10-month trend state on SPY (redundancy check).",
  interimKill: "none (single historical read)", readCondition: "read once, immediately after registration and the runner's self-check.",
  decisionRule: { pass: "Candidate overlay for Plan E's equity sleeves; forward paper test and any use are the operator's call.", fail: "Gayed's published signals are closed; no Lead-Lag Report trial." },
  expectation: "LOW-MED: published intermarket signals often decay after publication; the utilities rule also overlaps simple trend/low-vol timing.",
  knownWeaknesses: ["Proxies: IEF/TLT for 10y/30y Treasuries; GLD for gold; LBR=F (new contract since 2022-08) for lumber — the old LBS series is not available free, so V3 has only ~4 years.", "Weekly open-to-open execution is our choice; the papers used close-to-close.", "The defensive asset for V2/V3 is frozen as IEF; the papers say 'Treasuries' without our exact fund.", "2016–2026 contains one long bull market with two short crashes; rotation strategies are judged mostly on those few episodes."],
  ip: "ours (public papers)", writerExists: true,
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-27", area: "R273 Gayed/Bilello rotations — registered", category: "registration", breaksComparability: false, change: `3 published rules (utilities, 10y/30y, lumber/gold), post-publication 2016-2026, best-of-3 bar ${BAR}`, why: "Operator: test the Lead-Lag Report's signals ourselves.", doesNotEstablish: "Anything until the read.", operator: "Josh 2026-09-27" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R273"], detail: `Gayed rotations, bar ${BAR}` }) + "\n");
console.log(`R273 registered · bar ${BAR}`);
