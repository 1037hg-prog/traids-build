#!/usr/bin/env node
/** Registers R212-R215 — mining round 6 (operator 2026-09-24: "keep mining"). Family MINE-6, best-of-4 bar per test at its own n.
 *  Mechanisms not yet touched by R164-R210: the FX hedge-rebalancing flow at month-end, the FOMC-cycle even weeks, gold's overnight
 *  drift, and the pre-holiday effect. Filed before any data for these rules is fetched. Refuses if any id exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const { nullBar } = require("./lib/null-bar.js");
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")); const ids = ["R212", "R213", "R214", "R215"];
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => ids.includes(t.id))) { console.error("an R212-R215 id exists — refusing"); process.exit(2); }
const bar = (n) => +nullBar({ variants: 4, n, trials: 20000 }).p95.toFixed(3);
const FAM = "MINE-6 — R212 FX month-end hedge rebalancing (UUP), R213 FOMC-cycle even weeks (SPY), R214 gold overnight drift (GLD), R215 pre-holiday effect (SPY). Best-of-4 bar per test.";
const common = { registered: "2026-09-24", multiplicityFamily: FAM, parent: "Operator 2026-09-24: 'keep mining' — round 6, mechanisms not covered by R164-R210.", ip: "published research; rule text ours", writerExists: false, interimKill: "n/a (historical)", status: "REGISTERED 2026-09-24 — historical read pending", script: "backend/r212-r215-mine6.js", readCondition: "one historical read, 2016-01..2026-08, Alpaca SIP daily adjustment=all" };
const T = [
  { id: "R212", name: "FX month-end hedge rebalancing — the dollar moves against whichever equity market outperformed that month (Melvin & Prins 2015)", n: 128, unit: "months",
    evidenceStart: "2016-01..2026-08, historical",
    rule: "Signal S = SPY month-to-date return minus EFA month-to-date return, both measured to the close of the 4th-to-last trading day of the month (known at entry). Position: SHORT UUP if S > 0 (foreign holders of hedged US equity must sell more dollars forward), LONG UUP if S < 0. Enter at that close, exit at the OPEN of the month's last trading day (before the 11:00 ET London 4pm fix). 2 bps a side.",
    statistic: "Per month: signed window return minus sign x (window length in sessions) x UUP's mean daily return over the month's other days; t over months. Reported: |S| top-half months only; the unconditional UUP window drift; the reversal from the last-day open to the close.",
    controls: { placebo: "random signal signs (200 draws): true t must beat p95", falsifier: "the same signed rule at a mid-month window (sessions 8-10) must be ~0" },
    decisionRule: { pass: "Register a forward paper test on UUP at month-ends (operator's word).", fail: "The hedge-rebalancing flow does not show in the daily dollar index net of cost." },
    expectation: "LOW-MED: documented at the 4pm fix in intraday FX data; the ETF at daily resolution may be too coarse." },
  { id: "R213", name: "FOMC-cycle even weeks — equity returns concentrate in weeks 0, 2, 4 and 6 of the FOMC cycle (Cieslak, Morse & Vissing-Jorgensen 2019)", n: 85, unit: "FOMC cycles",
    evidenceStart: "2016-01..2026-08, historical (post-publication 2019+ reported separately)",
    rule: "Day 0 = scheduled FOMC statement day (the dates hard-coded in r196-pre-fomc.js from federalreserve.gov). Cycle trading-day k counts from day 0 until the next statement. Week w = floor((k + 1) / 5), so week 0 = days -1..3 (day -1 belongs to the previous cycle's tail and is assigned to week 0 of the new cycle, as in the paper). EVEN weeks = w in {0,2,4,6}. Long SPY close-to-close on even-week days, cash on odd-week days.",
    statistic: "Per cycle: mean daily SPY return on even-week days minus mean on odd-week days, x 5 (a weekly figure); t over cycles. Cost: 2 bps a side per switch, charged on the even leg. Reported: 2019-06+ only (post-publication); the long-only even-week strategy's Sharpe vs buy-and-hold.",
    controls: { placebo: "cycle phase shifted by a random 1-9 trading days (200 draws): true t must beat p95" },
    decisionRule: { pass: "Register a forward paper test (long SPY even weeks) — operator's word.", fail: "The FOMC-cycle pattern did not survive publication." },
    expectation: "LOW: published 2019; post-publication replications report weakening." },
  { id: "R214", name: "Gold overnight drift — GLD earns its return while New York is shut (close to next open)", n: 128, unit: "months",
    evidenceStart: "2016-01..2026-08, historical",
    rule: "Long GLD from each session's close to the next session's open, flat intraday. 1 bp a side (2 bps per night).",
    statistic: "Per month: sum of nightly net returns; t over months. Reported: gross; the intraday (open-to-close) leg; overnight minus intraday; SLV and SPY overnight for comparison (SPY's is the known equity overnight premium — the gold claim is separate).",
    controls: { placebo: "each night's return replaced by a coin-flip choice between that day's overnight and intraday legs (200 draws): true t must beat p95" },
    decisionRule: { pass: "Register a forward paper test (GLD overnight, market-on-close / market-on-open) — operator's word.", fail: "No net gold overnight edge at ETF cost." },
    expectation: "LOW-MED: the gross split is widely reported; 2 bps a night (~5%/yr) is a heavy cost hurdle." },
  { id: "R215", name: "Pre-holiday effect — SPY on the trading day before a market holiday (Ariel 1990; Lakonishok & Smidt 1988)", n: 105, unit: "holiday events",
    evidenceStart: "2016-01..2026-08, historical",
    rule: "Pre-holiday day = a trading day whose next weekday is not a trading day (from SPY's own bar calendar; weekday closures only). Long SPY close-to-close over that day. 2 bps a side.",
    statistic: "Per event: the day's net return minus SPY's mean daily return over the same calendar year; t over events. Reported: the day after the holiday; long-weekend holidays vs mid-week.",
    controls: { placebo: "the same number of random non-holiday days per year (200 draws): true t must beat p95" },
    decisionRule: { pass: "Register a forward paper test (buy SPY at the close two days before a holiday, sell at the pre-holiday close) — operator's word.", fail: "The pre-holiday effect is gone." },
    expectation: "LOW: one of the oldest calendar anomalies; most studies find it faded after the 1990s." },
];
for (const t of T) { const { n, unit, ...rest } = t; reg.preregistered.push({ ...common, ...rest, bar: { fixedInAdvance: true, unit: `${unit} (~${n})`, tRequired: bar(n), variants: 4, source: `nullBar({variants:4, n:${n}, trials:20000}).p95` }, knownWeaknesses: ["Daily ETF proxies; the flows themselves are not observed.", "~85-128 clustering units, so only a large effect clears the bar.", "Whole-window single read (no split holdout); the bar is best-of-4 across the round."] }); }
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-24", area: "R212-R215 mining round 6 — registered", category: "registration", breaksComparability: false, change: T.map((t) => `${t.id} n~${t.n} bar ${bar(t.n)}`).join(", "), why: "Operator: 'keep mining'.", doesNotEstablish: "Anything until the reads.", operator: "Josh 2026-09-24" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ids, detail: "mining round 6, family MINE-6 best-of-4" }) + "\n");
const r2 = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
console.log(ids.map((id) => { const e = r2.preregistered.find((x) => x.id === id); return `${id} · bar ${e.bar.tRequired} · ${e.name.slice(0, 80)}`; }).join("\n"));
