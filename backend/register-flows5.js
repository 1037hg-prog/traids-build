#!/usr/bin/env node
/** Registers R203-R206 — mining round 5, big forced flows in deep markets (operator 2026-09-24: "keep mining"). Family FLOWS-5, best-of-4
 *  bar per test at its own n. The two bond tests are judged on the part NOT explained by US Treasuries (a second, independent edge or not).
 *  Filed before any data for these rules is fetched. Refuses if any id exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const { nullBar } = require("./lib/null-bar.js");
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")); const ids = ["R203", "R204", "R205", "R206"];
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => ids.includes(t.id))) { console.error("an R203-R206 id exists — refusing"); process.exit(2); }
const bar = (n) => +nullBar({ variants: 4, n, trials: 20000 }).p95.toFixed(3);
const FAM = "FLOWS-5 — R203 international-bond month-end (independent of US Treasuries), R204 TIPS month-end (independent), R205 quarter-end dollar squeeze, R206 mid-month coupon-reinvestment window. Best-of-4 bar per test.";
const common = { registered: "2026-09-24", multiplicityFamily: FAM, parent: "Operator 2026-09-24: 'keep mining' — after R180 (Treasury month-end) passed and R192 showed other US bond funds only carry the same Treasury move.", ip: "published research / market structure; rule text ours", writerExists: false, interimKill: "n/a (historical)", status: "REGISTERED 2026-09-24 — historical read pending", script: "backend/r203-r206-flows5.js" };
const MONTHEND = "R180's window: the last 5 trading days' total return (Alpaca SIP daily, adjustment=all) minus 5 x the month's other-day mean, 2 bps a side.";
const T = [
  { id: "R203", name: "International bond month-end (BNDX) — the part independent of the US Treasury month-end move", n: 128,
    evidenceStart: "2016-01..2026-08, historical",
    rule: `${MONTHEND} On BNDX (Vanguard Total International Bond, USD-hedged). INDEPENDENT PART: each month's BNDX window excess minus beta x IEF's window excess, beta estimated on the PRIOR 36 months only (point in time; first 36 months use the expanding sample from 2016, disclosed).`,
    statistic: "Primary: the monthly independent part; t over months. Reported: BNDX raw window excess and t, full-sample beta and correlation with IEF's window.",
    decisionRule: { pass: "A second, independent month-end edge: add BNDX as a leg to the R186 forward test (operator's word).", fail: "International month-end demand is the US Treasury move (or absent)." },
    expectation: "LOW-MED: global aggregate indices also extend duration at month-end; hedged BNDX tracks local rates, which co-move with US rates." },
  { id: "R204", name: "TIPS month-end (TIP) — the part independent of the nominal Treasury month-end move", n: 128,
    evidenceStart: "2016-01..2026-08, historical",
    rule: `${MONTHEND} On TIP (iShares TIPS). INDEPENDENT PART as R203 (beta on IEF's window, prior 36 months).`,
    statistic: "Primary: the monthly independent part; t over months. Reported: TIP raw window excess and t.",
    decisionRule: { pass: "Add TIP as a leg to the R186 forward test.", fail: "TIPS month-end is the nominal Treasury move." },
    expectation: "LOW: the TIPS index extends at month-end too, but TIPS co-move tightly with nominals." },
  { id: "R205", name: "Quarter-end dollar squeeze — UUP into quarter-end, reversal after (bank balance-sheet window dressing)", n: 42,
    evidenceStart: "2016-Q1..2026-Q2, historical",
    rule: "UUP (Invesco DB US Dollar Index Bullish), Alpaca SIP daily adjustment=all. Leg A: long UUP over the last 5 trading days of each calendar quarter. Leg B: short UUP over the first 5 trading days of the next quarter. Each leg measured as its window return minus 5 x UUP's mean daily return over the quarter's other days. 2 bps a side per leg.",
    statistic: "Primary: per quarter, Leg A + Leg B; t over quarters. Reported: each leg alone, and the same rule at non-quarter month-ends (the mechanism predicts no effect there).",
    decisionRule: { pass: "Register a forward paper test on UUP at quarter-ends.", fail: "The quarter-end dollar funding squeeze is not visible in the dollar index net of costs." },
    expectation: "LOW-MED: documented in cross-currency basis and repo rates; whether it moves the spot dollar index is the question." },
  { id: "R206", name: "Mid-month coupon-reinvestment window — IEF over the 3 trading days ending on the first trading day on/after the 15th", n: 128,
    evidenceStart: "2016-01..2026-08, historical",
    rule: "IEF, Alpaca SIP daily adjustment=all. Window: the 3 trading days ending on the first trading day on or after the 15th of each month (Treasury note coupon/maturity date). Window return minus 3 x the month's mean daily return on days outside both this window and R180's month-end window. 2 bps a side.",
    statistic: "Per month, the window excess; t over months. Reported: the 15th-anchored window on TLT.",
    decisionRule: { pass: "Add the mid-month window to the R186 forward test.", fail: "Coupon reinvestment is too small to move prices." },
    expectation: "LOW: coupon cash is modest relative to month-end index extension." },
];
for (const t of T) { const { n, ...rest } = t; reg.preregistered.push({ ...common, ...rest, bar: { fixedInAdvance: true, unit: `months/quarters (~${n})`, tRequired: bar(n), variants: 4, source: `nullBar({variants:4, n:${n}, trials:20000}).p95` }, controls: { placebo: "the same window length placed at random positions inside each period (200 draws): the true t must beat the 95th percentile" }, readCondition: "one historical read", knownWeaknesses: ["ETF proxies, not the index flows themselves.", "~128 months / 42 quarters.", "Month-end and mid-month windows are separate by construction; month-end overlap with R180 is intended for R203/R204 and removed by the independence adjustment."] }); }
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-24", area: "R203-R206 forced flows round 5 — registered", category: "registration", breaksComparability: false, change: T.map((t) => `${t.id} n~${t.n} bar ${bar(t.n)}`).join(", "), why: "Operator: 'keep mining'.", doesNotEstablish: "Anything until the reads.", operator: "Josh 2026-09-24" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ids, detail: "forced flows round 5, family FLOWS-5 best-of-4" }) + "\n");
const r2 = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
console.log(ids.map((id) => { const e = r2.preregistered.find((x) => x.id === id); return `${id} · bar ${e.bar.tRequired} · ${e.name.slice(0, 70)}`; }).join("\n"));
