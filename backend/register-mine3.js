#!/usr/bin/env node
/** Registers R192-R196 — mining round 3 (operator 2026-09-24: "keep mining"), chosen for forced-flow / market-structure mechanisms after
 *  R180 (the only clean pass) came from one. Family MINE-3: best-of-5 bar per test at its own n. Filed before any data for these rules is
 *  fetched. Refuses if any id exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const { nullBar } = require("./lib/null-bar.js");
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")); const ids = ["R192", "R193", "R194", "R195", "R196"];
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => ids.includes(t.id))) { console.error("an R192-R196 id exists — refusing"); process.exit(2); }
const bar = (n) => +nullBar({ variants: 5, n, trials: 20000 }).p95.toFixed(3);
const FAM = "MINE-3 — R192 bond month-end beyond Treasuries, R193 market intraday momentum, R194 high-turnover short-term momentum, R195 crypto funding extremes, R196 pre-FOMC drift. Best-of-5 bar per test.";
const common = { registered: "2026-09-24", multiplicityFamily: FAM, parent: "Operator 2026-09-24: 'keep mining'. Mechanism-first selection after R180's pass.", ip: "published research; rule text ours", writerExists: false, interimKill: "n/a (historical)", status: "REGISTERED 2026-09-24 — historical read pending" };
const T = [
  { id: "R192", name: "Month-end index-extension demand beyond Treasuries — AGG, LQD, MUB over the last 5 trading days (R180's mechanism, new assets)",
    evidenceStart: "2016-01-01..2026-08-31, historical (these assets were never run with the rule)", script: "backend/r192-bond-month-end.js",
    rule: "Exactly R180's rule and statistic (last 5 trading days' total return minus 5 x the month's other-day mean, 2 bps a side) on AGG, LQD and MUB (Alpaca SIP daily, adjustment=all). Primary: the equal-weight average of the three per month. Reported: each alone, and HYG as a contrast (high yield, less index-extension-driven).",
    statistic: "Per month, the pooled window excess; t over months. Placebo as R180 (random 5-day windows, 200 draws).",
    bar: { fixedInAdvance: true, unit: "months (~128)", tRequired: bar(128), variants: 5 },
    decisionRule: { pass: "The mechanism generalises: add the passing bond ETFs as optional legs to the R186 forward test (operator's word).", fail: "The month-end effect is Treasury-specific." },
    readCondition: "one historical read", expectation: "MED: index-extension buying applies to all index-tracked investment-grade bonds; munis least.", knownWeaknesses: ["Overlaps R180 in time (Treasuries are ~40% of AGG) — AGG is not independent of R180; LQD and MUB are the clean evidence.", "~128 months."] },
  { id: "R193", name: "Market intraday momentum — SPY/QQQ first half-hour return predicts the last half-hour (Gao, Han, Li & Zhou, JFE 2018)",
    evidenceStart: "2018-09-01..2026-08-31 (post-publication), historical", script: "backend/r193-intraday-momentum.js",
    rule: "Alpaca SIP 1-minute bars, regular sessions (half-days excluded). Signal: return from the prior close to 10:00 ET. Trade: at 15:30 ET take the signal's direction in SPY and QQQ (equal weight), exit at the 16:00 close. Cost: 1 bp per side (SPY/QQQ spreads ~1 cent) — also reported at 2 bps.",
    statistic: "Per day, the pooled net last-half-hour return in the signal's direction; t over days (Newey-West lag 1). Reported: the 12:00-15:30 'second-to-last half hour' version and the paper's regression slope.",
    bar: { fixedInAdvance: true, unit: "days (~2,000)", tRequired: bar(2000), variants: 5 },
    controls: { signShuffle: "signal signs shuffled across days (200 draws): the true mean must beat the 95th percentile", peek: "sign of the last half-hour itself must clear the bar" },
    decisionRule: { pass: "Register a forward paper test (Alpaca paper, market-on-close exits).", fail: "The published intraday momentum has not survived post-publication at our costs." },
    readCondition: "one historical read", expectation: "LOW-MED: several replications report decay after 2018.", knownWeaknesses: ["1-minute bar closes, not auction prices, at 15:30 and 16:00 (the close uses the official closing print where available).", "SPY and QQQ are highly correlated (little diversification)."] },
  { id: "R194", name: "Short-term momentum in high-turnover stocks — 1-month winners minus losers within the top turnover decile (Medhat & Schmeling, RFS 2022)",
    evidenceStart: "2017-01..2026-08 on the v2 panel (paper sample ends 2019; 2020-2026 is the clean out-of-sample leg, 2017-2019 reported separately)", script: "backend/r194-turnover-momentum.js",
    rule: "Panel data/anomaly-cache-v2, universe: 20-day median dollar volume >= $25M. Month-end: turnover proxy = the month's dollar volume / its trailing 12-month average dollar volume (shares outstanding are not point-in-time in our data — disclosed). Within the top turnover decile: long the top 1-month-return decile, short the bottom, equal weight, one month. Cost 20 bps per side per leg.",
    statistic: "Monthly net long-short return; t over months, primary on 2020-01..2026-08.",
    bar: { fixedInAdvance: true, unit: "months (~80)", tRequired: bar(80), variants: 5 },
    controls: { bootstrap: "drift-free iid bootstrap of gross monthly returns: |t| < 2", lowTurnover: "the same sort in the LOW turnover decile (the paper predicts reversal there) reported" },
    decisionRule: { pass: "Register a forward paper test.", fail: "The effect did not survive post-publication at our costs." },
    readCondition: "one historical read", expectation: "LOW-MED: short-term momentum lives in costly, high-turnover names.", knownWeaknesses: ["Turnover proxy (relative dollar volume) instead of shares turnover.", "Shorts assume borrow."] },
  { id: "R195", name: "Crypto funding extremes — do extreme Hyperliquid perp funding rates predict BTC/ETH reversals?",
    evidenceStart: "Hyperliquid funding history from its start (~2023) .. 2026-08-31, historical", script: "backend/r195-funding-extremes.js",
    rule: "Hyperliquid public API (info type fundingHistory) hourly funding for BTC and ETH; daily mean funding. Signal day d: funding in the top 10% of its trailing 180-day distribution -> short-bias, bottom 10% -> long-bias (contrarian); no position otherwise. Return: the coin's next 3-day return (Coinbase daily close to close) in the signal's direction; cost 10 bps per side.",
    statistic: "Per signal day, the directional net 3-day return; t over signal days with Newey-West lag 2 (overlap). Reported: 1-day and 7-day horizons, and the momentum (non-contrarian) sign.",
    bar: { fixedInAdvance: true, unit: "signal days (~200)", tRequired: bar(200), variants: 5 },
    controls: { placebo: "signal days shifted to random days in the same months (200 draws): the true mean must beat the 95th percentile" },
    decisionRule: { pass: "Register a forward paper test on the Alpaca paper crypto account.", fail: "Funding extremes carry no tradeable directional information." },
    readCondition: "one historical read", expectation: "LOW-MED: the 09-24 scout flagged one 'funding predicts returns' paper as a trap (it predicts volatility).", knownWeaknesses: ["Short history (~3 years).", "Hyperliquid funding is one venue."] },
  { id: "R196", name: "Pre-FOMC drift — SPY from 14:00 ET the day before an FOMC statement to 13:55 on statement day (Lucca & Moench 2015)",
    evidenceStart: "2015-07-01..2026-08-31 (post-publication), historical", script: "backend/r196-pre-fomc.js",
    rule: "Scheduled FOMC statement days (Federal Reserve calendar; unscheduled meetings excluded). Long SPY from 14:00 ET on the prior trading day to 13:55 ET on statement day (Alpaca SIP 1-minute). Cost 1 bp per side.",
    statistic: "Per meeting, the net window return minus SPY's average return over all other 24-hour 14:00-to-13:55 windows in the same quarter; t over meetings.",
    bar: { fixedInAdvance: true, unit: "meetings (~90)", tRequired: bar(90), variants: 5 },
    controls: { placebo: "the same window on random non-FOMC days (200 draws): the true mean must beat the 95th percentile" },
    decisionRule: { pass: "Register a forward paper test.", fail: "The pre-FOMC drift is gone post-publication (as several follow-ups report)." },
    readCondition: "one historical read", expectation: "LOW: Kurov and others find the drift largely disappeared after 2015.", knownWeaknesses: ["~90 meetings.", "Distinct from R165 (statement-day close-to-close), which DID NOT PASS."] },
];
for (const t of T) reg.preregistered.push({ ...common, ...t, bar: { ...t.bar, source: `nullBar({variants:5, n:${t.bar.unit.match(/~([\d,]+)/)[1].replace(/,/g, "")}}).p95` } });
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-24", area: "R192-R196 mining round 3 — registered", category: "registration", breaksComparability: false, change: T.map((t) => `${t.id} bar ${t.bar.tRequired}`).join(", "), why: "Operator: 'keep mining'.", doesNotEstablish: "Anything until the reads.", operator: "Josh 2026-09-24" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ids, detail: "mining round 3, family MINE-3 best-of-5" }) + "\n");
console.log(T.map((t) => `${t.id} · bar ${t.bar.tRequired} · ${t.name.slice(0, 70)}`).join("\n"));
