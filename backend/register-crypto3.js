#!/usr/bin/env node
/** Registers R208-R210 — crypto round (operator 2026-09-24: "yes register the crypto tests"). Family CRYPTO-3 (bar computed at 4 variants
 *  because R208 is read two-sided). The fourth candidate (spot-BTC-ETF flow days) is NOT registered: no public API history of daily ETF
 *  flows is available to us without scraping web tables. Filed before any data for these rules is fetched. Refuses if any id exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const { nullBar } = require("./lib/null-bar.js");
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")); const ids = ["R208", "R209", "R210"];
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => ids.includes(t.id))) { console.error("an R208-R210 id exists — refusing"); process.exit(2); }
const bar = (n) => +nullBar({ variants: 4, n, trials: 20000 }).p95.toFixed(3);
const FAM = "CRYPTO-3 — R208 weekend vs weekday (two-sided), R209 BTC-leads-altcoins lag, R210 stablecoin-supply growth. Bar at 4 variants (R208 two-sided counts twice). Spot-ETF flow days not registered (no API history).";
const common = { registered: "2026-09-24", multiplicityFamily: FAM, parent: "Operator 2026-09-24: 'can you mine bitcoin or any other coins' -> 'yes register the crypto tests'.", ip: "none", writerExists: false, interimKill: "n/a (historical)", status: "REGISTERED 2026-09-24 — historical read pending", readCondition: "one historical read" };
const T = [
  { id: "R208", name: "Crypto weekend effect — BTC/ETH returns while US markets are shut vs matched weekday windows (two-sided)", n: 340,
    evidenceStart: "2020-01..2026-08, historical", script: "backend/r208-crypto-weekend.js",
    rule: "Coinbase hourly candles (reuse backend/data/training/flows4/coinbase-{BTC,ETH}-USD-1h.json). WEEKEND window: Friday 20:00 UTC to Monday 13:00 UTC (65 hours; US cash equities closed). WEEKDAY comparison: the same 65-hour length starting Monday 20:00 UTC (to Thursday 13:00 UTC) of the SAME week. Pooled BTC/ETH equal weight.",
    statistic: "Per week: weekend-window return minus the weekday-window return; t over weeks, read two-sided (|t| vs the bar). A tradeable form (long or short over weekends vs weekdays) is reported with 10 bps per side per switch.",
    bar: { unitWord: "weeks" },
    controls: { placebo: "the 65-hour weekend window replaced by a random 65-hour window starting Tue-Thu of the same week (200 draws): |true t| must exceed the placebo's 95th percentile of |t|" },
    decisionRule: { pass: "Register a forward paper test of the tradeable form (Alpaca paper crypto).", fail: "No weekend/weekday asymmetry beyond noise." },
    expectation: "LOW-MED: several papers report lower weekend volatility and some return asymmetry since spot ETFs; ~340 weeks.",
    knownWeaknesses: ["Coinbase spot only.", "Holidays not excluded (disclosed)."] },
  { id: "R209", name: "BTC leads altcoins — after a large 1-hour BTC move, do altcoins catch up over the next 2 hours?", n: 600,
    evidenceStart: "2021-06..2026-08, historical", script: "backend/r209-btc-lead-alts.js",
    rule: "Coinbase hourly candles for BTC and the alt basket ETH, SOL, LTC, LINK, DOGE, ADA, AVAX, DOT (equal weight, coins present that hour). Event: a completed hour where |BTC return| >= 1.5%. Position at that hour's close: the alt basket in the direction of BTC's move, hedged by an equal-dollar opposite BTC position (so the bet is the alts' catch-up, not BTC's continuation), held 2 hours. Cost: 10 bps per side on each leg (40 bps round trip total). Events within 3 hours of a prior event are skipped.",
    statistic: "Per event: net 2-hour hedged return; t over events clustered by UTC day (mean per day, t over days).",
    bar: { unitWord: "event-days" },
    controls: { placebo: "events at random hours with |BTC| < 0.3% (matched count per month), same position rule (200 draws): the true mean must beat the 95th percentile", peek: "sign of the realised hedged return must clear the bar" },
    decisionRule: { pass: "Register a forward paper test.", fail: "Altcoins do not lag BTC by enough to trade net of costs." },
    expectation: "LOW: lead-lag among liquid coins is arbitraged within minutes; hourly resolution and 40 bps costs are hard hurdles.",
    knownWeaknesses: ["Hourly resolution misses faster catch-up.", "Basket composition fixed to coins still listed (survivorship)."] },
  { id: "R210", name: "Stablecoin supply growth — do fresh dollars entering crypto predict BTC over the next week?", n: 330,
    evidenceStart: "2020-01..2026-08, historical", script: "backend/r210-stablecoin-flow.js",
    rule: "Total stablecoin circulating supply (USD-pegged), daily, from DefiLlama's public stablecoin API (stablecoins.llama.fi). Signal each UTC day d: 7-day supply growth ranked against the trailing 180 days; HIGH = top 20%. Position: long BTC (Coinbase daily close) from the close of d for 7 days on HIGH days; otherwise cash (0%). Cost 10 bps per side per switch.",
    statistic: "Per non-overlapping 7-day block starting on a HIGH day: BTC return minus BTC's mean 7-day return over the sample (the drift); t over blocks (Newey-West lag 1). Reported: the LOW (bottom 20%) mirror, and the version as a long/cash strategy vs buy-and-hold (alpha, drawdown).",
    bar: { unitWord: "7-day blocks" },
    controls: { placebo: "HIGH days replaced by random days (same count per quarter), 200 draws: the true mean must beat the 95th percentile" },
    decisionRule: { pass: "Register a forward paper test (Alpaca paper crypto).", fail: "Stablecoin issuance is not a timing signal net of drift." },
    expectation: "LOW-MED: issuance tends to follow price (it is partly the result of rallies, not a cause).",
    knownWeaknesses: ["DefiLlama's aggregation and revisions (point-in-time vintage unknown — disclosed).", "Supply growth trends with the market (the drift adjustment addresses part of it)."] },
];
for (const t of T) { const { n, bar: b, ...rest } = t; reg.preregistered.push({ ...common, ...rest, bar: { fixedInAdvance: true, unit: `${b.unitWord} (~${n})`, tRequired: bar(n), variants: 4, source: `nullBar({variants:4, n:${n}, trials:20000}).p95` } }); }
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-24", area: "R208-R210 crypto round — registered", category: "registration", breaksComparability: false, change: T.map((t) => `${t.id} n~${t.n} bar ${bar(t.n)}`).join(", ") + "; spot-ETF flow days not registered (no API history)", why: "Operator: 'yes register the crypto tests'.", doesNotEstablish: "Anything until the reads.", operator: "Josh 2026-09-24" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ids, detail: "crypto round, family CRYPTO-3" }) + "\n");
const r2 = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
console.log(ids.map((id) => { const e = r2.preregistered.find((x) => x.id === id); return `${id} · bar ${e.bar.tRequired} · ${e.name.slice(0, 70)}`; }).join("\n"));
