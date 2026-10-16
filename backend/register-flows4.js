#!/usr/bin/env node
/** Registers R197-R200 — mining round 4, FORCED FLOWS (operator 2026-09-24: "option 1 more forced flows"). Family FLOWS-4, best-of-4 bar
 *  per test at its own n. Filed before any data for these rules is fetched. Refuses if any id exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const { nullBar } = require("./lib/null-bar.js");
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")); const ids = ["R197", "R198", "R199", "R200"];
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => ids.includes(t.id))) { console.error("an R197-R200 id exists — refusing"); process.exit(2); }
const bar = (n) => +nullBar({ variants: 4, n, trials: 20000 }).p95.toFixed(3);
const FAM = "FLOWS-4 — R197 S&P 500 inclusion/deletion reversal, R198 leveraged-ETF close rebalancing on big days, R199 quarter-end window dressing, R200 crypto monthly-expiry. Best-of-4 bar per test.";
const common = { registered: "2026-09-24", multiplicityFamily: FAM, parent: "Operator 2026-09-24: 'option 1 more forced flows' (after R180, the only clean pass, came from a forced flow).", ip: "published research; rule text ours", writerExists: false, interimKill: "n/a (historical)", status: "REGISTERED 2026-09-24 — historical read pending" };
const T = [
  { id: "R197", name: "S&P 500 index changes — added stocks give back and deleted stocks rebound after the effective-date close",
    evidenceStart: "2016-01-01..2026-08-31, historical", script: "backend/r197-sp500-changes.js", n: 300,
    rule: "Changes: the 'Selected changes to the list of S&P 500 components' table (Wikipedia, page version recorded in the script; cross-checked where possible). Event = effective date E (the date index funds trade at the close). Position: from the close of E, SHORT each added stock and LONG each deleted stock (deleted names still trading on Alpaca SIP, delisted ones included while they trade), held 10 trading days, each measured against SPY over the same days. Cost 10 bps per side. Spin-off and merger-driven changes with no independent close on E are excluded (listed).",
    statistic: "Per event date: mean over that date's positions of the directional excess return (short adds, long deletes); t over event dates (Newey-West lag 1 for overlapping windows). Reported: adds and deletes separately; the pre-effective run-up (announcement ~5 days before E to E) for context; 5- and 20-day horizons.",
    controls: { placebo: "each event shifted to a random non-event date in the same month (200 draws): the true mean must beat the 95th percentile", peek: "sign of the realised excess must clear the bar" },
    decisionRule: { pass: "Register a forward paper test on the next index changes.", fail: "The post-inclusion reversal is not tradeable post-2016 at our costs." },
    readCondition: "one historical read", expectation: "LOW-MED: the inclusion effect has shrunk as announcements lengthened and arbitrageurs front-run; deletions rebound is the stronger literature leg.", knownWeaknesses: ["Wikipedia's change table is a secondary source.", "Deleted names may be hard to borrow/trade after deletion.", "Adds and deletes on the same date are correlated (one flow)."] },
  { id: "R198", name: "Leveraged-ETF close rebalancing — on big days the last half-hour continues the day's move (SPY/QQQ)",
    evidenceStart: "2016-01-01..2026-08-31 (SPY; QQQ from 2018-08 in the existing cache), historical", script: "backend/r198-letf-rebalance.js", n: 400,
    rule: "Alpaca SIP 1-minute (reuse backend/data/training/mine3 cache and backend/lib/mine3-minute.js). Day's move m = return from the prior close to 15:30 ET. On days with |m| >= 1.0% only: at 15:30 take the direction of m in SPY and QQQ (equal weight), exit at the close (15:59 bar close, as R193). Cost 1 bp per side. Full sessions only.",
    statistic: "Per qualifying day, the pooled net last-half-hour return in the direction of m; t over qualifying days. Reported: thresholds 0.5% and 2.0%, and the unconditional (all days) version for contrast with R193.",
    controls: { signShuffle: "direction signs shuffled across qualifying days (200 draws): the true mean must beat the 95th percentile", peek: "sign of the last half-hour itself must clear the bar" },
    decisionRule: { pass: "Register a forward paper test (market-on-close exits).", fail: "Leveraged-ETF rebalancing flow is not visible net of costs." },
    readCondition: "one historical read", expectation: "LOW-MED: R193 found no half-hour continuation in general; conditioning on big days is where the LETF mechanism should bite.", knownWeaknesses: ["LETF AUM varies over time; the rule does not scale by AUM.", "Big days cluster in crises (few independent regimes)."] },
  { id: "R199", name: "Quarter-end window dressing — the quarter's winners outperform into quarter-end and give it back early next quarter",
    evidenceStart: "2016-Q1..2026-Q2 on the v2 panel, historical", script: "backend/r199-window-dressing.js", n: 42,
    rule: "Panel data/anomaly-cache-v2, universe: 20-day median dollar volume >= $25M. At the close 6 trading days before each quarter-end: rank by quarter-to-date return (quarter start to that close). Leg A (into quarter-end): long top decile minus bottom decile over the last 5 trading days of the quarter. Leg B (unwind): short top decile minus bottom decile over the first 5 trading days of the next quarter. Equal weight; cost 20 bps per side per leg.",
    statistic: "Primary: per quarter, Leg A + Leg B net (the full dress-and-unwind round trip); t over quarters. Reported: each leg alone, and the same rule at non-quarter month-ends as a placebo.",
    controls: { placebo: "the identical rule at non-quarter month-ends (the mechanism predicts no effect there)", bootstrap: "drift-free bootstrap of gross returns: |t| < 2" },
    decisionRule: { pass: "Register a forward paper test at the next quarter-end.", fail: "Window dressing is not a tradeable flow post-2016." },
    readCondition: "one historical read", expectation: "LOW: ~42 quarters; the effect is documented mostly for small caps and older samples.", knownWeaknesses: ["~42 quarters is little data.", "Shorts assume borrow.", "Adjusted panel; dollar-volume screen only."] },
  { id: "R200", name: "Crypto monthly expiry — BTC/ETH around the last-Friday 08:00 UTC options/futures expiry (dealer-hedge unwind)",
    evidenceStart: "2020-01..2026-08, historical (Coinbase hourly)", script: "backend/r200-crypto-expiry.js", n: 80,
    rule: "Expiry = the last Friday of each month, 08:00 UTC (Deribit monthly; CME monthly futures settle the same day). Pre-window: 72 hours before expiry to expiry. Post-window: expiry to 72 hours after. Hypothesis (hedge unwind): the post-window reverses the pre-window. Position: at expiry, take the OPPOSITE direction of the pre-window's BTC and ETH moves, hold 72 hours. Coinbase hourly candles. Cost 10 bps per side.",
    statistic: "Per expiry, the pooled (BTC, ETH equal weight) net post-window return in the reversal direction; t over expiries. Reported: each coin alone, quarterly expiries (Mar/Jun/Sep/Dec, larger open interest) alone, and the continuation sign.",
    controls: { placebo: "the same rule anchored on a random non-expiry Friday 08:00 UTC in the same month (200 draws): the true mean must beat the 95th percentile" },
    decisionRule: { pass: "Register a forward paper test on the Alpaca paper crypto account.", fail: "Monthly expiry carries no tradeable reversal." },
    readCondition: "one historical read", expectation: "LOW: max-pain / expiry-pinning stories are popular and rarely survive testing.", knownWeaknesses: ["~80 expiries.", "Deribit expiry time is exact; our hourly bars bracket it."] },
];
for (const t of T) { const { n, ...rest } = t; reg.preregistered.push({ ...common, ...rest, bar: { fixedInAdvance: true, unit: `events (~${n})`, tRequired: bar(n), variants: 4, source: `nullBar({variants:4, n:${n}, trials:20000}).p95` } }); }
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-24", area: "R197-R200 forced flows round 4 — registered", category: "registration", breaksComparability: false, change: T.map((t) => `${t.id} n~${t.n} bar ${bar(t.n)}`).join(", "), why: "Operator: 'option 1 more forced flows'.", doesNotEstablish: "Anything until the reads.", operator: "Josh 2026-09-24" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ids, detail: "forced flows round 4, family FLOWS-4 best-of-4" }) + "\n");
const reg2 = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
console.log(ids.map((id) => { const e = reg2.preregistered.find((x) => x.id === id); return `${id} · bar ${e.bar.tRequired} · ${e.name.slice(0, 70)}`; }).join("\n"));
