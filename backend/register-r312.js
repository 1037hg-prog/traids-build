#!/usr/bin/env node
/** Registers R312 — US-vs-Europe interest-rate carry with a trend filter (operator 2026-10-02: "how do we capitalize on the interest rate
 *  disparity between the us and european countries" -> "test it"). Written BEFORE any carry statistic was computed for this design.
 *  DISCLOSED: S6 (2026-07-28, STAGNANT) — a cross-sectional carry basket of 6 developed currencies 2007-2026 lost (-0.19%/mo at zero
 *  cost); today's spot and policy rates were looked up (US 4.00, ECB 2.50, CH ~0; EUR/USD 1.18 -> 1.14 and USD/CHF 0.79 -> 0.83 over the
 *  past year), which is why Europe was asked about. One fixed rule from the literature (time-series carry, 12-month trend filter) ->
 *  single-variant bar. Refuses if R312 exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { nullBar } = require("./lib/null-bar.js");
const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
const ID = "R312", TODAY = "2026-10-02", N = 314;
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === ID)) { console.error(`${ID} exists — refusing`); process.exit(2); }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a) { const n = a.length, m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n, c = 0; for (let i = 1; i < n; i++) c += d[i] * d[i - 1]; v += c / n; return m / Math.sqrt(v / n); }
const rng = mulberry(312), T = 50000, mx = []; for (let k = 0; k < T; k++) { const s = []; for (let i = 0; i < N; i++) s.push(rng() * 2 - 1); mx.push(nwT(s)); }
mx.sort((a, b) => a - b); const nwBar = +mx[Math.floor(0.95 * T)].toFixed(3), iidBar = +nullBar({ variants: 1, n: N, trials: 20000 }).p95.toFixed(3), BAR = Math.max(nwBar, iidBar);
reg.preregistered.push({
  id: ID, registered: TODAY,
  name: "US-vs-Europe rate carry with a 12-month trend filter — EUR, GBP, CHF against the dollar, monthly, 2000-2026 (+ a quote-priced futures record forward)",
  status: `REGISTERED ${TODAY} — historical read once + forward futures record; builder assigned`, script: "backend/r312-europe-carry.js",
  parent: "Operator 2026-10-02 asked how to capitalize on the US-Europe rate gap; answer: (1) hedged European holdings in the core (a building block, not tested), (2) a carry trade via CME FX futures, measured first. Prior: S6 (2026-07-28) cross-sectional DM carry 2007-2026 STAGNANT/DEAD; R212/R216/R218 month-end dollar effects void (scoring artifact).",
  multiplicityFamily: "CARRY-EU — R312 alone; one rule (time-series carry with the Moskowitz-Ooi-Pedersen 12-month trend filter), parameters taken from the literature, not searched. Primary = the European trio pooled; every other cut is reported only.",
  evidenceStart: "historical: positions decided at each month end from the first month all three currencies have spot and 3-month rates plus 12 months of history (expected 2000-07) through 2026-09; FORWARD record (reported, weightless) from the 2026-10 month-end decision",
  rule: [
    "DATA (FRED): spot DEXUSEU (USD per EUR), DEXUSUK (USD per GBP), DEXSZUS (CHF per USD, inverted to USD per CHF); 3-month interbank rates IR3TIB01USM156N, IR3TIB01EZM156N, IR3TIB01GBM156N, IR3TIB01CHM156N (OECD, monthly averages). Month-end spot = last available daily fixing of the month. For months after a rate series ends, the last value is carried forward SHIFTED by the change in the same country's daily policy/overnight rate since then (US DTB3, EUR ECBDFR, GBP SONIA IUDSOIA if available else carried flat, CHF carried flat) — disclosed per month.",
    "RETURN of holding 1 unit of USD-vs-foreign exposure for month m (excess return, covered interest parity, i.e. what an FX forward/future earns): short foreign (long USD) = (S[m-1]/S[m]) * (1 + rUS[m-1]/1200) / (1 + rF[m-1]/1200) - 1; long foreign = the reciprocal minus 1; S in USD per foreign unit; rates are the PREVIOUS month's values (known at the decision).",
    "DIRECTION (carry): at month end m-1, gap = rUS - rF. gap > 0 -> candidate SHORT foreign; gap < 0 -> candidate LONG foreign; |gap| < 0.25 pt -> flat.",
    "TREND FILTER (Moskowitz, Ooi & Pedersen 2012, 12-month): hold the candidate only if that same position's cumulative excess return over months m-12..m-1 is > 0; otherwise flat.",
    "PORTFOLIO: the three currencies equally weighted (a flat leg contributes 0); monthly rebalance at month end. COST: 0.03% per unit traded at each position change + 0.01% per held leg-month (futures roll and spread).",
  ].join(" "),
  statistic: "Unit: calendar MONTH. Per month the portfolio net excess return (mean of the three legs). Headline t = Newey-West (lag 1) over months.",
  unit: "months", nExpected: N,
  controls: {
    placebo: "RANDOM DIRECTION: the same legs active in the same months with the direction drawn at random (1,000 draws, seeded); the observed mean must beat the placebo p95.",
    carryAdds: "CARRY vs TREND-ONLY: the same legs with direction from the 12-month trend alone (no rate gate). Paired monthly difference (R312 minus trend-only) must have mean > 0 — evidence that the RATE GAP, not trend alone, carries the result.",
    halves: "first and second half of the months; both must be positive.",
    post2008: "months 2009-01 onward (the zero-rate era where S6 found DM carry dead) must have mean > 0.",
    reported: "each currency alone; unfiltered carry (no trend filter); the 6-currency G10 pool (+ JPY, CAD, AUD from cached FRED spot + OECD rates) as context; worst month and worst 12 months (crash risk: CHF 2015-01, GBP 2016-06, 2008); cost at 2x; share of months active; the rate-fill months listed.",
    forwardRecord: "From the 2026-10 month-end decision: the rule's positions marked daily on CME futures quotes (6E, 6B, 6S front month via Schwab; micro M6E/M6B/MSF notional; no orders), rolled on a fixed schedule; reported against the synthetic CIP return each month — measures the real futures carry capture and cost. Weightless; no gate.",
  },
  bar: { fixedInAdvance: true, unit: "months", tRequired: BAR, variants: 1, statistic: "Newey-West t, lag 1",
    source: `max of NW(lag 1) t on iid noise n=${N}, 50,000 trials, seed 312 (p95 ${nwBar}) and nullBar({variants:1, n:${N}}).p95 (${iidBar})` },
  interimKill: "none (single historical read); the forward record has no kill — it is a measurement, not a test",
  decisionRule: {
    pass: `PASS only if >= 240 months AND mean net monthly excess return > 0 AND t_NW >= ${BAR} AND the random-direction placebo p95 is beaten AND carry adds over trend-only (mean paired difference > 0) AND both halves are positive AND the post-2008 mean is > 0. A PASS proposes a small paper futures sleeve (micro FX futures on tastytrade, quote-priced first) — the operator's call; nothing is funded.`,
    fail: "DID NOT PASS: US-Europe rate carry, even trend-filtered, is not a measurable premium after costs on 2000-2026 data; the answer to the operator's question becomes 'take it through currency-hedged holdings only'. Closed — no re-run with other filters, lookbacks or currencies on these data.",
    cannotMeasure: "CANNOT MEASURE if fewer than 240 months, or any currency's rate is filled (not observed) in more than 10% of its months.",
  },
  knownWeaknesses: [
    "Europe was chosen because today's gap is wide (US 4.00 vs ECB 2.50, CH ~0) and the dollar rose over the last year; the 26-year history is the test, but the question itself is conditioned on the present.",
    "S6 (seen) found a cross-sectional developed-currency carry basket lost 2007-2026; R312 is time-series (per currency vs USD) with a trend filter — different, but overlapping data.",
    "Synthetic returns via covered interest parity on OECD monthly-average 3-month rates; real forwards/futures differ by the CIP basis (tens of bp a year for EUR and CHF since 2008, in the direction that FLATTERS a long-USD carry) — the forward futures record measures it.",
    "Monthly-average rates lag the true month-end rate by about half a month; the daily rates were observable in real time, so this is noise, not look-ahead — but it is noise in the carry sign near zero gap (hence the 0.25 pt dead zone).",
    "Carry crashes are rare and large (CHF +20% in a day on 2015-01-15); 26 years holds few of them, so the t-stat understates tail risk; worst month and worst 12 months are reported.",
    "Trend and carry often point the same way; the carry-adds control is the only thing separating them.",
  ],
  readCondition: "--read once after --selftest passes (CIP arithmetic, inversion of DEXSZUS, direction/filter timing, no look-ahead) and a leak test (spot returns shuffled across months within each currency: |t| < 2) is clean; seals in read-seals.json.",
  writerExists: false, writerNote: "runner + forward futures recorder written by a builder agent 2026-10-02",
  ip: "Ours: public data, textbook rule.",
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: TODAY, area: "registry — R312 US-Europe rate carry", category: "registration", breaksComparability: false, change: `Registered R312 before any carry statistic: EUR/GBP/CHF vs USD, CIP synthetic monthly excess returns from FRED spot + OECD 3-month rates, carry direction with a 12-month trend filter, 2000-2026, NW t bar ${BAR} (single rule); gates: random-direction placebo, carry-adds-over-trend, halves, post-2008; forward quote-priced futures record (weightless).`, why: "Operator 2026-10-02: 'test it'.", doesNotEstablish: "Any result.", operator: "Josh 2026-10-02" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: [ID], family: "CARRY-EU" }) + "\n");
console.log(`${ID} registered · bar t_NW >= ${BAR} (NW ${nwBar}, iid ${iidBar}; months, single rule) · ${reg.preregistered.length} preregistered`);
