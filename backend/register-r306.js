#!/usr/bin/env node
/** Registers R306 — Coinbase Research's volume-weighted pivot level model, rebuilt from its published description and tested on BTC/ETH
 *  (operator 2026-10-01: "yes"). Written BEFORE any candle is pulled. Source: Coinbase One weekly "Stalled at the Wall" (2026-10-01), chart
 *  notes: strength = pivot-bar volume within +/-0.3% (near term) / distributed across +/-1% bands (key levels), boosted until first
 *  retest, decayed (halved every four days). Their primer was not read; every unstated parameter is fixed here once. Coinbase prohibits
 *  reproduction of the report: nothing of its text or charts is published; the rule text below is ours. Refuses if the id exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { nullBar } = require("./lib/null-bar.js");
const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
const ID = "R306", TODAY = "2026-10-01", CELLS = 2, N = 600;
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === ID)) { console.error(`${ID} exists — refusing`); process.exit(2); }
const b = +nullBar({ variants: CELLS, n: N, trials: 20000 }).p95.toFixed(3);
reg.preregistered.push({
  id: ID, registered: TODAY, name: "Volume-weighted pivot levels (Coinbase Research's support/resistance model, rebuilt): does BTC/ETH reverse at the strongest untouched level, or continue once it breaks?",
  status: `REGISTERED ${TODAY} — historical, read once; builder assigned`, script: "backend/r306-cb-levels.js",
  parent: "Operator 2026-10-01 after the Coinbase One weekly 'Stalled at the Wall' (Colin Basco): levels from a model that 'weights past turning points by the volume traded at them'; chart notes give the band, the first-touch boost and the decay. Prior house tests of level ideas (R178/R185 LVN pullback, R294 composite volume profile) all DID NOT PASS, but used volume profiles, not volume-weighted pivots with freshness and decay.",
  multiplicityFamily: "CB-LEVELS — R306 alone; 2 cells (REV first-touch fade, BRK break continuation), horizon 24 h, BTC+ETH pooled.",
  evidenceStart: "historical: Coinbase Exchange hourly candles 2021-01-01..2026-09-30 (registered window); 2018-2020 discovery reported only",
  rule: [
    "DATA: Coinbase Exchange public hourly candles (api.exchange.coinbase.com/products/{BTC-USD,ETH-USD}/candles, granularity 3600; open/high/low/close/base volume), UTC hours; gaps left as gaps.",
    "PIVOTS: an hourly bar is a pivot HIGH if its high is the highest of the 24 bars before and the 24 after (pivot LOW likewise with lows); a pivot becomes KNOWN only 24 bars after it (no look-ahead). Pivot weight = that bar's base volume divided by the asset's trailing 30-day median hourly volume (so regimes are comparable).",
    "STRENGTH PROFILE at hour t (built only from pivots known by t-1): price bins of 0.1%; each pivot adds its weight to every bin within +/-1% of its price (overlap summed); weight x 2 while the pivot is UNTESTED (price has not traded through the pivot price since it became known), x 1 after the first touch; exponential decay with a 4-day half-life from the pivot time. Normalised by the maximum bin within +/-10% of the prior close.",
    "LEVEL = a local maximum of the profile with normalised strength >= 0.5. The REFERENCE resistance (support) at t = the strongest level above (below) the prior close within 5%.",
    "CELL REV (levels hold): the first hour whose high reaches the reference resistance (low reaches the reference support) since that level became the reference -> FADE from the level price: short at a resistance, long at a support; exit at the close 24 hours later. One event per level per UTC day.",
    "CELL BRK (breaks continue): the first hourly CLOSE more than 0.25% beyond the reference level -> enter at that close in the break direction; exit at the close 24 hours later. One event per level per UTC day.",
    "COST: 0.20% round trip per event (taker-like spot cost on Coinbase), no funding (spot).",
  ].join(" "),
  statistic: "Per UTC day with events: mean net event return (BTC and ETH pooled). One-sample t over days, registered window 2021-01..2026-09; best-of-2 cells.",
  unit: "days", nExpected: N,
  controls: {
    placebo: "RANDOM LEVELS: the same event logic on levels at random prices with the same distance-from-price distribution (strength ignored); 500 draws of the whole event set; the observed cell mean must beat the placebo p95.",
    volumeShuffle: "pivot volumes permuted across pivots (levels keep their prices): reported, shows whether the volume weighting adds anything over plain pivots.",
    halves: "first and second half of the registered window, reported; both must be positive.",
    perAsset: "BTC and ETH reported separately; per-year means reported.",
  },
  bar: { fixedInAdvance: true, unit: "days", tRequired: b, variants: CELLS, source: `nullBar({variants:${CELLS}, n:${N}, trials:20000}).p95 = ${b}` },
  interimKill: "none (single historical read)",
  decisionRule: {
    pass: "PASS only if the better cell's net t >= bar AND the random-level placebo is beaten AND both halves are positive. A PASS proposes a forward paper test on Alpaca crypto (operator's call); nothing is adopted or funded.",
    fail: "DID NOT PASS: recorded with the numbers; Coinbase's level calls carry no edge we can measure; the card closes.",
    cannotMeasure: "CANNOT MEASURE if Coinbase candles cannot be pulled for >= 90% of registered-window hours, or fewer than 300 days with events.",
  },
  knownWeaknesses: [
    "Their exact pivot definition, band handling, boost size and normalisation are not published; the parameters here (24-bar pivots, x2 untested boost, 4-day half-life, 0.5 strength floor, 5% reference window) are our reading, fixed once. A miss here does not prove their production model has no edge — it proves this faithful reading does not.",
    "REV fills at the level price assume a limit order at the level fills when touched; real touches can be adverse-selection fills (price goes through). This flatters REV.",
    "Coinbase volume is one venue's volume, the same venue the report uses; consolidated volume could rank pivots differently.",
    "Crypto trades 24/7; day clustering treats weekend days like weekdays.",
    "Two cells answer two opposite claims (levels hold vs breaks continue); the bar is best-of-2.",
  ],
  readCondition: "read once after --selftest passes its known answers; the builder pulls candles, builds levels and events, then computes returns once.",
  writerExists: false, writerNote: "runner written by a builder agent on 2026-10-01; CANNOT MEASURE is a legitimate outcome, never a silent substitution",
  ip: "method described in a Coinbase One report (reproduction prohibited without Coinbase's approval): the rule text is ours, nothing of the report is published; internal measurement only.",
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: TODAY, area: "registry — R306 Coinbase volume-weighted pivot levels", category: "registration", breaksComparability: false, change: `Registered R306 before any candle: Coinbase Research's level model rebuilt (24-bar pivots, volume-weighted, +/-1% bands, x2 until first touch, 4-day half-life), cells REV (first-touch fade) and BRK (break continuation), 24 h, BTC+ETH, day-clustered t, bar ${b} (best-of-2, n ${N}), random-level placebo + halves.`, why: "Operator 2026-10-01: 'yes'.", doesNotEstablish: "Any result.", operator: "Josh 2026-10-01" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "register", tests: [ID], family: "CB-LEVELS" }) + "\n");
console.log(`${ID} registered · bar ${b} (days, best-of-${CELLS}) · ${reg.preregistered.length} preregistered`);
