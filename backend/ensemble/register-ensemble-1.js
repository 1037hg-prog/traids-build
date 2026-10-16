#!/usr/bin/env node
/**
 * Registers ENSEMBLE-1 — the first combination test from the strategy return library (ensemble-architect, 2026-09-24).
 * Operator 2026-09-24: "create an agent to evaluate our existing strategies and look at the possibilities of joining them together
 * with other strategies; like medallion in a way".
 *
 * Written and run BEFORE any combination has been evaluated and before the library is complete: the selection rule, weights,
 * statistic, bar, controls and holdout are frozen here and READ at run time by backend/ensemble/read-ensemble-1.js.
 * Takes the next free R-number (both registry arrays, and the seals); refuses if an entry with ensembleSpec "ensemble-combo-v1" exists.
 *   node backend/ensemble/register-ensemble-1.js
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const { nullBar } = require("../lib/null-bar.js");
const D = (f) => path.join(__dirname, "..", "data", f);
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8"));
const all = [...(reg.tests || []), ...(reg.preregistered || [])];
if (all.some((t) => t.ensembleSpec === "ensemble-combo-v1")) { console.error("ENSEMBLE-1 already registered — refusing"); process.exit(2); }
const used = new Set([...all.map((t) => String(t.id)), ...Object.keys(seals.tests || {})]);
let n = Math.max(...[...used].map((s) => (/^R(\d+)$/.exec(s) || [])[1]).filter(Boolean).map(Number)) + 1;
if (n < 201) n = 201;                                        // R197–R200 are taken (operator note)
while (used.has("R" + n)) n++;
const ID = "R" + n;

const SEED = n;                                              // every random draw in the read is seeded from the R-number
const BAR_N = 900, VARIANTS = 2;
const BAR = +nullBar({ variants: VARIANTS, n: BAR_N, trials: 20000, rng: mulberry(SEED) }).p95.toFixed(3);

// Mechanism table — written before any pre-2023 or holdout statistic of any library stream was computed. A strategy has a STATED
// MECHANISM iff its registered source is published finance research naming a flow, risk-premium or behavioural channel. TradingView
// scripts, vendor rules (Payne, Swift Trades, AlphaInsider) and practitioner chart patterns do not. Unlisted ids default to NOT stated.
const MECHANISM = {
  R180: "index-extension duration demand at month end (Hartley & Schwarz 2019)",
  R192: "index-extension demand at month end beyond Treasuries (R180's bet)",
  R164: "pension-fund rebalancing flows at month end",
  R168: "turn-of-month cash-flow demand (Ogden 1990; Etula et al. 2020)",
  R169: "time-series momentum (Moskowitz, Ooi & Pedersen 2012)",
  R184: "Treasury auction supply / dealer inventory (Lou, Yan & Zhang 2013)",
  R193: "market intraday momentum (Gao, Han, Li & Zhou 2018)",
  R196: "pre-FOMC announcement drift (Lucca & Moench 2015)",
  R198: "leveraged-ETF close rebalancing flows (Cheng & Madhavan 2009)",
  R166: "intraday-only momentum clientele (Lou, Polk & Skouras 2019)",
  R182: "liquidity provision under stress (Nagel 2012)",
  R194: "short-term momentum in high-turnover stocks (Medhat & Schmeling 2022)",
  R195: "perpetual-funding crowding / positioning reversal",
  R200: "derivatives-expiry hedging flows in crypto",
  R165: "macro-announcement premium on FOMC days (Savor & Wilson 2013)",
  R167: "overnight/intraday clientele tug of war (Lou, Polk & Skouras 2019)",
  R170: "salience theory of choice (Bordalo, Gennaioli & Shleifer; Cosemans & Frehen 2021)",
  "R190-*": "crypto time-series momentum (Liu & Tsyvinski 2021)",
  "R161-*": "published cross-sectional anomaly, one citation per signal (see backend/r161-anomalies.js header)",
  "R163-INTRAMOM": "intraday momentum (Gao, Han, Li & Zhou 2018)",
  "R163-INTRAMOM_SPY": "intraday momentum (Gao, Han, Li & Zhou 2018)",
  "R163-PERIODICITY": "intraday return periodicity (Heston, Korajczyk & Sadka 2010)",
};
const NOT_STATED = ["R150-*", "R152-*", "R158-*", "R175", "R178*", "R187-*", "R189-*", "R163-ORB30", "R163-VWAPREV", "R163-GAPFADE"];
const DECLARED_CLUSTERS = [
  { name: "month-end duration demand", members: ["R180", "R192"], why: "R192 is R180's rule on other bond ETFs (charter: 'R192 is R180')" },
  { name: "crypto trend N-variants", members: ["R190-*"], why: "one rule, three lookbacks" },
  { name: "IPO reversal hold variants", members: ["R158-*"], why: "one rule, two holding periods" },
  { name: "AlphaInsider crypto scripts", members: ["R187-*", "R189-*"], why: "R189 is built from R187's verified translations" },
];

const spec = {
  library: "backend/data/strategy-library/*.json (status 'ok'); series convention in backend/ensemble/lib-entry.js — dates absent inside `window` are 0 (cash)",
  selectionData: "every date <= 2022-12-31",
  holdout: "2023-01-01 .. the latest window end among the selected components (at most the library's last date)",
  eligibility: [
    "status 'ok' and reproduction.match === true (the emitter reproduced the sealed script's own headline statistic)",
    "a STATED MECHANISM per the table `mechanism` (unlisted ids = not stated)",
    "own net t >= 1.0 on selection data: Newey-West (lag 5) t of the mean daily net return over the strategy's own calendar dates inside window ∩ [.., 2022-12-31], flat days = 0; us-equity calendar = SPY's Alpaca SIP daily bar dates, crypto calendar = every UTC day; needs >= 250 such dates",
    "window end >= 2023-12-31 (at least one year of holdout)",
  ],
  duplicates: "Declared clusters (below) plus single-linkage merging of any two eligible strategies whose RESIDUAL correlation > 0.8 on selection data (residual = OLS residual on SPY and BTC daily returns over each strategy's own pre-2023 window dates, flat days 0; correlation over dates inside both windows, >= 250 common dates). One component per cluster: the member with the highest pre-2023 own net t; exact ties broken by a mulberry32 key seeded with the R-number, never by row order.",
  weights: {
    ER: "equal risk (PRIMARY): w_i(d) ∝ 1/σ_i(d), σ_i(d) = sample sd of component i's last 60 ACTIVE-day returns strictly before d (active = a date listed in its series), needs >= 20 such days else w_i = 0; normalised to sum 1 over components live on d (d inside its window) with finite σ. Point-in-time: uses only returns dated before d.",
    EW: "equal weight (beside it): w_i = 1/k over components live on d.",
  },
  combination: "calendar = union of the selected components' calendars over the holdout (a us-equity component is 0 on non-session dates); r_c(d) = Σ w_i(d) r_i(d). Capital assigned to an event strategy on a flat day earns 0.",
  statistic: "ALPHA t: Newey-West (lag 5) t of the intercept of OLS r_c(d) = α + b1·SPY(d) + b2·BTC(d) + e over every holdout date of the combination calendar. SPY = Alpaca SIP daily adjustment=all close-to-close (0 on non-session dates); BTC = Coinbase BTC-USD daily close-to-close (UTC). Clustering unit: days (NW lag 5). Reported beside it (context): raw net mean t, CAGR, Sharpe, max drawdown, betas.",
  bar: `t >= ${BAR} = nullBar({variants:${VARIANTS}, n:${BAR_N}}).p95 (seeded) — the family counts the two weighting variants ER and EW; the verdict variant is the better of the two against this best-of-2 bar`,
  controls: {
    shuffle: "component labels shuffled across dates: on every holdout date each of the k component slots is filled by a distinct library strategy ('ok', live on that date) drawn at random; same weighting (a slot's σ is the drawn strategy's own point-in-time σ) and same alpha t. 200 seeded draws; the verdict variant's true t must be strictly greater than the draws' 95th percentile.",
    randomComponent: "k distinct library strategies ('ok', window covering >= 1 year of the holdout) drawn at random once per draw and held for the whole holdout; same weighting and alpha t. 200 seeded draws; true t must be strictly greater than the 95th percentile.",
    peek: "positive control: the selected components with every daily return replaced by max(r, 0) (outcome look-ahead), same weights; alpha t must be >= 3 or the pipeline is not trusted (validity gate).",
  },
  validity: "Seal only if: k >= 2 components selected; SPY and BTC regressors present on every holdout date they should be; both control distributions hold 200 finite draws; peek t >= 3. k < 2 = VOID (reported, not sealed, the registration stays open for a larger library).",
  verdict: "PASS iff max(t_ER, t_EW) >= bar AND that variant's t beats BOTH the shuffle and the random-component 95th percentiles. Otherwise DID NOT PASS.",
  mechanism: MECHANISM, mechanismNotStated: NOT_STATED, declaredClusters: DECLARED_CLUSTERS, seed: SEED,
};

reg.preregistered.push({
  id: ID, ensembleSpec: "ensemble-combo-v1",
  name: "ENSEMBLE-1 — the Medallion method on our own library: mechanism-backed strategies with pre-2023 net t >= 1.0, one per duplicate cluster, equal-risk combined, judged on 2023+ alpha",
  registered: "2026-09-24",
  evidenceStart: "2023-01-01..latest library date (historical holdout the selection rule never sees), selection on <= 2022-12-31",
  status: "REGISTERED 2026-09-24 — historical read pending (library v1 building)",
  script: "backend/ensemble/read-ensemble-1.js",
  parent: "Operator 2026-09-24: 'evaluate our existing strategies and look at the possibilities of joining them together with other strategies; like medallion in a way'. First run of the ensemble-architect (charter .claude/agents/ensemble-architect.md).",
  multiplicityFamily: `ENSEMBLE-1 — {ER equal-risk (primary), EW equal-weight}. Best-of-${VARIANTS} bar. One combination rule; no other combination has been evaluated before this registration.`,
  rule: `Components = every strategy-library entry that (a) reproduced its sealed statistic, (b) has a stated economic mechanism per the frozen table, (c) has own net Newey-West t >= 1.0 on its daily series dated <= 2022-12-31 (>= 250 dates), (d) has at least one year of holdout window — one per duplicate cluster (declared clusters + residual correlation > 0.8 on pre-2023 data; the cluster's highest pre-2023 t represents it, seeded tie-break). Weights: equal risk (trailing 60 active-day inverse vol, point-in-time) and equal weight. Combined daily; evaluated only on 2023-01-01..latest. Full frozen spec in ensembleSpecDetail.`,
  statistic: spec.statistic,
  bar: { fixedInAdvance: true, unit: "days (holdout days of the combination calendar, NW lag 5; ~930 sessions, more with a crypto component)", tRequired: BAR, variants: VARIANTS, source: `nullBar({variants:${VARIANTS}, n:${BAR_N}, trials:20000, rng: mulberry32(${SEED})}).p95` },
  controls: spec.controls,
  interimKill: "n/a (historical)",
  decisionRule: {
    pass: "The combination earns holdout alpha no single component was selected for: propose a FORWARD paper test of the same frozen combination (Alpaca paper) to the operator. No live sizing, no funding — the operator decides anything that trades.",
    fail: "Our weak edges do not add up to detectable 2023+ alpha at this library size. Keep the library growing (R197/R199 and the unlisted sealed tests next), re-register a new combination only with a NEW rule and a new holdout (forward paper), never by re-reading this one.",
  },
  readCondition: "one historical read by backend/ensemble/read-ensemble-1.js after library v1 is built; seals only if the validity controls compute (see ensembleSpecDetail.validity).",
  expectation: "LOW: of the library's sealed tests only R150 RSI-2, R152, R180/R192 and R187 cleared a bar, most without a stated mechanism; a mechanism-backed pre-2023 t >= 1.0 set may be only two or three bets.",
  knownWeaknesses: [
    "Every component's FULL-SAMPLE sealed result (including 2023+) was public before this registration: the holdout guards the selection RULE, not the researcher's knowledge. The rule was written to avoid discretion (a mechanism table fixed in advance, a numeric t threshold on pre-2023 data, a seeded tie-break), but the mechanism table itself was written by someone who had read the sealed verdicts.",
    "Library streams are regenerated by emitters, not by the sealed scripts themselves; a stream whose reproduction check fails is excluded by rule (c), which may drop a real edge.",
    "Event strategies (month-end, FOMC, expiry) are active a few days a month; equal risk sizes them by their active-day volatility, so a combination can hold much idle cash. That is a real feature of the book, not a flaw of the test.",
    "US-equity and crypto calendars are mixed; crypto dates are UTC days, SPY dates are sessions — the regressors are slightly asynchronous.",
    "Alpha betas are estimated on the holdout itself (standard for an alpha test, but the betas are not point-in-time).",
    "The t >= 1.0 threshold is permissive by design (weak edges are the point); the protection is the holdout, the best-of-2 bar and two library-based controls.",
    "Holdout 2023-2026 is one regime (a strong equity bull market with a 2025 tariff shock); few independent regimes.",
  ],
  ip: "Our own combination of our own library. Components that touch vendor material (R150/R152 TradingView scripts, R158/R175 Payne, R178 Swift Trades, R187/R189 AlphaInsider) are excluded by the mechanism rule; nothing here republishes their code.",
  writerExists: true,
  ensembleSpecDetail: spec,
});
reg.asOf = new Date().toISOString();
writeJsonAtomic(D("test-registry.json"), reg);

const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-24", area: `${ID} ENSEMBLE-1 — registered`, category: "registration", breaksComparability: false, change: `First combination test from the strategy return library: mechanism + pre-2023 net t >= 1.0 + one per duplicate cluster, equal-risk and equal-weight, alpha t on 2023+ holdout; best-of-2 bar ${BAR}; shuffle, random-component and peek controls.`, why: "Operator: 'joining them together with other strategies; like medallion in a way'.", doesNotEstablish: "Anything until the read.", operator: "Josh 2026-09-24 (ensemble-architect first run)" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "ensemble-architect", action: "register", tests: [ID], detail: `ENSEMBLE-1 combination rule frozen before any combination evaluated; bar ${BAR} (best-of-2)` }) + "\n");
console.log(`${ID} registered (ENSEMBLE-1) · bar ${BAR} · seed ${SEED}`);
