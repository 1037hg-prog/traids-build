#!/usr/bin/env node
/** Registers R324 — country-ETF momentum (operator 2026-10-05: "test it", after a "Top 15 technology ETFs by YTD" graphic whose real
 *  story was the 2026 Korea/semiconductor run; ties to the operator's foreign-markets goal). Written BEFORE any country-ETF return series
 *  was computed for this rule (R313 cached some of these ETFs' daily bars for an unrelated IBS rule; no momentum statistic was computed).
 *  One rule taken from the literature (12-1 momentum, top tercile, monthly) -> single-variant bar. Refuses if R324 exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { nullBar } = require("./lib/null-bar.js");
const D = (f) => path.join(__dirname, "data", f), TODAY = "2026-10-05", N = 309;
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R324")) { console.error("R324 exists — refusing"); process.exit(2); }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a, L) { const n = a.length, m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n; for (let l = 1; l <= L; l++) { let c = 0; for (let i = l; i < n; i++) c += d[i] * d[i - l]; v += 2 * (1 - l / (L + 1)) * c / n; } return m / Math.sqrt(v / n); }
const rng = mulberry(324), T = 50000, mx = []; for (let k = 0; k < T; k++) { const s = []; for (let i = 0; i < N; i++) s.push(rng() * 2 - 1); mx.push(nwT(s, 3)); }
mx.sort((a, b) => a - b); const nw = +mx[Math.floor(0.95 * T)].toFixed(3), iid = +nullBar({ variants: 1, n: N, trials: 20000 }).p95.toFixed(3), BAR = Math.max(nw, iid);
const U = "EWJ EWG EWU EWQ EWI EWP EWL EWN EWD EWK EWO EWC EWA EWH EWS EWT EWY EWM EWZ EWW EZA";
reg.preregistered.push({
  id: "R324", registered: TODAY,
  name: "Country-ETF momentum — hold the top third of 21 single-country ETFs by 12-1 month return, monthly, vs the equal-weight country basket, 2001-2026",
  status: `REGISTERED ${TODAY} — historical, read once; builder assigned`, script: "backend/r324-country-momentum.js",
  parent: "Operator 2026-10-05: 'test it' after a 'Top 15 technology ETFs by YTD' graphic (actual 2026 YTD: EWY +97%, KORU +153%, MU +277%; BERZ was mislabelled). Literature: Asness, Moskowitz & Pedersen (2013) 'Value and Momentum Everywhere' (country equity index momentum). Ties to the operator's foreign-markets goal (traids-foreign-markets-r312). Priors: stock momentum not established in the core-model work (t 1.75 vs 2.09); sector rotation rejected.",
  multiplicityFamily: "COUNTRY-MOM — R324 alone; one rule (12-1, top tercile, equal weight, monthly) from the literature; long-short, 6-1 and quintile versions reported only.",
  evidenceStart: "historical: month-end positions from 2001-01 (decided at the 2000-12 close) through the 2026-09 month end; data from 1999 for the lookback",
  rule: `UNIVERSE (fixed today): ${U} — each eligible from the first month-end with 13 month-ends of history. DATA: Schwab pricehistory daily, split-adjusted, price only (no dividends, for every ETF and the benchmark alike). SIGNAL at month-end m: MOM = close(m-1) / close(m-12) - 1 (12 months, skipping the most recent month). PORTFOLIO: the top third of eligible ETFs by MOM (floor(n/3), at least 3), equal weight, bought at the month-end-m close and held to the month-end-(m+1) close. BENCHMARK: all eligible ETFs equal weight over the same month. COST 0.10% per unit of one-way turnover (both portfolio and benchmark rebalanced; the benchmark's own drift rebalance charged too).`,
  statistic: "Unit: MONTH. Monthly net excess return (top-third portfolio minus equal-weight benchmark); mean and Newey-West t (lag 3).", unit: "months", nExpected: N,
  controls: {
    placebo: "RANDOM SELECTION: each month the same NUMBER of eligible ETFs drawn at random (seeded), equal weight, same costs; 1,000 draws; observed mean excess must beat the placebo p95.",
    halves: "2001-2013 and 2014-2026 mean excess both > 0.",
    post2009: "months from 2009-07 (after the 2009 momentum crash) mean excess > 0.",
    calibration: "Before the read the runner calibrates the WHOLE decision rule on >= 60 no-edge constructions (each ETF's monthly returns shuffled across months, cross-section kept per month) — whole-rule false pass must be <= 5%, else the read is held for a dated pre-evidence amendment.",
    positiveControl: "selection by the NEXT month's realised return (look-ahead): t >= 3.",
    reported: "long-short (top minus bottom third); 6-1 lookback; quintiles; vs EFA and vs SPY; worst month and worst 12 months (momentum crashes, 2009); turnover; holdings by year; at 0.20% cost.",
  },
  bar: { fixedInAdvance: true, unit: "months", tRequired: BAR, variants: 1, statistic: "Newey-West t, lag 3", source: `max(NW lag-3 sim n=${N} seed 324 p95 ${nw}, nullBar n=${N} p95 ${iid})` },
  interimKill: "none (single historical read)",
  decisionRule: {
    pass: `PASS only if >= 240 months AND mean net excess > 0 AND NW t >= ${BAR} AND the random-selection p95 is beaten AND both halves > 0 AND the post-2009 mean > 0 AND the calibration and positive control passed. A PASS proposes a forward paper country-momentum sleeve (DAY orders on Alpaca paper, monthly) — the operator's call; nothing funded.`,
    fail: "DID NOT PASS: country-ETF momentum does not beat an equal-weight country basket after costs on 2001-2026; closed — no re-run with other lookbacks or universes on these data.",
    cannotMeasure: "CANNOT MEASURE if fewer than 15 of the 21 ETFs have Schwab daily history from 2000, or < 240 months.",
  },
  knownWeaknesses: [
    "Price-only data (no dividends): country dividend yields differ (e.g. Australia, UK higher), which biases toward low-yield countries slightly; disclosed, symmetric across portfolio and benchmark only on average.",
    "Universe is today's list of surviving country ETFs (survivorship is mild for country funds but not zero).",
    "Momentum crashes (2009) are rare and large; 309 months hold few of them.",
    "Published 2013; post-publication months are partly out of sample (halves/post-2009 gates).",
    "The operator's prompt was a 2026 Korea run; the test covers 2001-2026, not the recent winner.",
  ],
  readCondition: "--read once after selftest and calibration.",
  writerExists: false, writerNote: "runner built by a reviewed workflow 2026-10-05",
  ip: "Ours: textbook factor on public data.",
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: TODAY, area: "registry — R324 country-ETF momentum", category: "registration", breaksComparability: false, change: `Registered R324 before any momentum statistic: 21 single-country ETFs, 12-1 momentum, top third equal weight monthly vs the equal-weight basket, 0.10%/turnover, NW lag-3 t bar ${BAR}; random-selection placebo, halves, post-2009, calibration, positive control.`, why: "Operator 2026-10-05: 'test it'.", doesNotEstablish: "Any result.", operator: "Josh 2026-10-05" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R324"], family: "COUNTRY-MOM" }) + "\n");
console.log(`R324 registered · bar ${BAR} (NW ${nw}, iid ${iid})`);
