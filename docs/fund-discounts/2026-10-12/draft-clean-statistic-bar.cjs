#!/usr/bin/env node
// draft-clean-statistic-bar.cjs — the bar and the unit conversions quoted in draft-clean-statistic.md.
//
// It reads NO market data and makes NO network request. It does three things:
//   1. calls the house bar function backend/lib/null-bar.js ONCE per (family size, cluster count) and saves what it printed.
//      nullBar has no fixed seed, so a second call would print a slightly different number; choosing among runs would be
//      choosing the bar. So: if draft-clean-statistic-bar.json already exists this script NEVER calls nullBar again. It prints
//      the saved numbers and only re-checks the seeded parts (2 and 3), which are deterministic.
//   2. simulates the null distribution of the Newey-West (Bartlett, lag 4) t of a mean on zero-edge noise with a FIXED seed,
//      because the registered statistic is a Newey-West t and its null tail is fatter than a plain t's. Same idea as R313's bar
//      ("max(NW lag-1 sim n=320 seed 313 p95, nullBar n=320 p95)"). The NW formula is the house one (backend/lib/tv-pit-panel.js nwT).
//   3. converts published costs into dollars a month for a 12-month hold (inputs are the literature scout's, cited there).
//
// Run:   node docs/fund-discounts/2026-10-12/draft-clean-statistic-bar.cjs          (first run mints the JSON; later runs only print and re-check)
//        node docs/fund-discounts/2026-10-12/draft-clean-statistic-bar.cjs --dry    (seeded parts only; never touches nullBar or the JSON)
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..", "..", "..");
const OUT = path.join(__dirname, "draft-clean-statistic-bar.json");
const DRY = process.argv.includes("--dry");

// ---- frozen inputs ------------------------------------------------------------------------------------------------------
const SPANS = {
  discovery: { returnMonths: "2001-01..2011-12", monthsInSpan: 132, minMonthsT1: 120, minMonthsAnyGate: 100 },
  holdout: { returnMonths: "2012-01..2026-09", monthsInSpan: 177, minMonthsT1: 160, minMonthsAnyGate: 140 },
};
const FAMILY_SIZES = [1, 2, 3, 4];           // 1 is this draft's own claim; 2-4 are there so a registrar who mints several arms need not re-roll
const NW_LAG = 4, NW_SEED = 20261012, NW_TRIALS = 50000;
const lagRule = (n) => Math.floor(4 * Math.pow(n / 100, 2 / 9));   // Newey-West plug-in rule of thumb

// ---- helpers --------------------------------------------------------------------------------------------------------------
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
/** Newey-West (Bartlett) t of the mean — the formula of backend/lib/tv-pit-panel.js nwT(a, L). */
function nwT(a, L) {
  const n = a.length; if (n < 3) return null;
  let m = 0; for (let i = 0; i < n; i++) m += a[i]; m /= n;
  const d = new Array(n); for (let i = 0; i < n; i++) d[i] = a[i] - m;
  let v = 0; for (let i = 0; i < n; i++) v += d[i] * d[i]; v /= n;
  for (let l = 1; l <= L; l++) { let g = 0; for (let i = l; i < n; i++) g += d[i] * d[i - l]; v += 2 * (1 - l / (L + 1)) * g / n; }
  return v > 0 ? m / Math.sqrt(v / n) : null;
}
const up3 = (x) => Math.ceil(x * 1000 - 1e-9) / 1000;
const r3 = (x) => Math.round(x * 1000) / 1000;

// known answers for nwT, checked on every run (hand arithmetic in the comments)
(function selfcheck() {
  // a = [1,2,3,4]: m 2.5; d = [-1.5,-.5,.5,1.5]; g0 = 5/4 = 1.25; lag 0 -> t = 2.5 / sqrt(1.25/4) = 4.47214
  const t0 = nwT([1, 2, 3, 4], 0); if (Math.abs(t0 - 4.472136) > 1e-5) throw new Error("nwT lag-0 known answer failed: " + t0);
  // lag 1: g1 = (-.5*-1.5 + .5*-.5 + 1.5*.5)/4 = (0.75 - 0.25 + 0.75)/4 = 0.3125; v = 1.25 + 2*(1/2)*0.3125 = 1.5625; t = 2.5 / sqrt(1.5625/4) = 4.0
  const t1 = nwT([1, 2, 3, 4], 1); if (Math.abs(t1 - 4.0) > 1e-9) throw new Error("nwT lag-1 known answer failed: " + t1);
  for (const k of Object.keys(SPANS)) if (lagRule(SPANS[k].minMonthsAnyGate) !== NW_LAG || lagRule(SPANS[k].monthsInSpan) !== NW_LAG) throw new Error("lag rule does not give " + NW_LAG + " for " + k);
})();

// ---- 2. seeded Newey-West null -----------------------------------------------------------------------------------------------
function nwNull(n) {
  const rng = mulberry(NW_SEED + n), maxV = Math.max(...FAMILY_SIZES);
  const best = FAMILY_SIZES.map(() => new Float64Array(NW_TRIALS));
  const s = new Array(n);
  for (let t = 0; t < NW_TRIALS; t++) {
    let run = -Infinity;
    for (let v = 1; v <= maxV; v++) {
      for (let i = 0; i < n; i++) s[i] = rng() * 2 - 1;
      const tv = nwT(s, NW_LAG); if (tv > run) run = tv;
      const k = FAMILY_SIZES.indexOf(v); if (k >= 0) best[k][t] = run;
    }
  }
  const out = {};
  FAMILY_SIZES.forEach((v, k) => { const a = Array.from(best[k]).sort((x, y) => x - y); out[v] = { p95: r3(a[Math.floor(0.95 * NW_TRIALS)]), p99: r3(a[Math.floor(0.99 * NW_TRIALS)]) }; });
  return out;
}

// ---- 3. unit conversions on published costs (no data) -----------------------------------------------------------------------
const CSS_ONE_WAY_PCT = { MUNI: 0.40, TAXABLE_BOND: 0.54, US_EQ: 0.51, FOREIGN_EQ: 0.68 };   // Cherkes, Sagi and Stanton 2009, Table 2 panel c (via scout-literature.md)
const HOLD_MONTHS = 12, ACCOUNT = 100000;
const costs = {};
for (const g of Object.keys(CSS_ONE_WAY_PCT)) {
  const rt = 2 * CSS_ONE_WAY_PCT[g];
  costs[g] = { oneWayPct: CSS_ONE_WAY_PCT[g], roundTripPct: r3(rt), dragPctPerMonthAt12mHold: r3(rt / HOLD_MONTHS), dragUsdPerMonthPer100k: Math.round(ACCOUNT * rt / 100 / HOLD_MONTHS) };
}
const published = { thompsonEqualWeighted: 2.37, thompsonDiscountWeighted: 4.12, patroLongFifthMinusMarket: 9.3 };   // % a year, GROSS, other people's samples
const pubUsd = {}; for (const k of Object.keys(published)) pubUsd[k] = { pctPerYear: published[k], usdPerMonthPer100k: Math.round(ACCOUNT * published[k] / 100 / 12) };

// ---- run ---------------------------------------------------------------------------------------------------------------------
const nwBy = {}; for (const k of Object.keys(SPANS)) nwBy[k] = nwNull(SPANS[k].minMonthsAnyGate);

let saved = null;
if (fs.existsSync(OUT)) saved = JSON.parse(fs.readFileSync(OUT, "utf8"));

if (DRY) {
  console.log("DRY: seeded parts only (nullBar not called, nothing written)");
  console.log(JSON.stringify({ nwLag: NW_LAG, nwSeed: NW_SEED, nwTrials: NW_TRIALS, nwBy, costs, pubUsd }, null, 1));
  process.exit(0);
}

if (!saved) {
  const { nullBar } = require(path.join(ROOT, "backend", "lib", "null-bar.js"));
  const { writeJsonAtomic } = require(path.join(ROOT, "backend", "lib", "atomic-write.js"));
  const spans = {};
  for (const k of Object.keys(SPANS)) {
    const n = SPANS[k].minMonthsAnyGate, byFamily = {};
    for (const v of FAMILY_SIZES) {
      const b = nullBar({ variants: v, n });                         // the procedure's call, default trials, no seed: ONCE
      const nb = { variants: b.variants, n: b.n, trials: b.trials, median: r3(b.median), p90: r3(b.p90), p95: b.p95, p99: r3(b.p99) };
      const bar = up3(Math.max(b.p95, nwBy[k][v].p95));
      byFamily[v] = { nullBar: nb, neweyWestNull: nwBy[k][v], bar, mdeInSdAt80pctPower: r3((bar + 0.8416) / Math.sqrt(n)) };
    }
    spans[k] = { ...SPANS[k], barComputedAtN: n, byFamilySize: byFamily };
  }
  saved = {
    what: "Bar for draft-clean-statistic.md: per span, max(nullBar p95, seeded Newey-West lag-4 null p95) at the SMALLEST month count any t-gate may have, rounded up to 3 decimals. nullBar was called once per cell; this file is never re-minted.",
    mintedAt: new Date().toISOString(), mintedAtDenver: new Date().toLocaleString("en-US", { timeZone: "America/Denver" }),
    command: "node docs/fund-discounts/2026-10-12/draft-clean-statistic-bar.cjs",
    nullBarSource: "backend/lib/null-bar.js nullBar({ variants, n }) default trials 5000, Math.random (no seed)",
    neweyWest: { lag: NW_LAG, lagRule: "floor(4 x (n/100)^(2/9))", seed: NW_SEED, seedPerSpan: "seed + n", trials: NW_TRIALS, noise: "uniform(-1, 1), independent", formula: "backend/lib/tv-pit-panel.js nwT(a, L)" },
    spans, costs, publishedGrossForScaleOnly: pubUsd,
  };
  writeJsonAtomic(OUT, saved);
  console.log("MINTED " + path.basename(OUT) + " (nullBar called once per cell)");
} else {
  // never re-roll: check the deterministic parts still reproduce
  for (const k of Object.keys(SPANS)) for (const v of FAMILY_SIZES) {
    const a = saved.spans[k].byFamilySize[v].neweyWestNull, b = nwBy[k][v];
    if (a.p95 !== b.p95 || a.p99 !== b.p99) throw new Error(`seeded Newey-West null does not reproduce for ${k} family ${v}: saved ${JSON.stringify(a)} now ${JSON.stringify(b)}`);
  }
  if (JSON.stringify(saved.costs) !== JSON.stringify(costs)) throw new Error("cost conversions do not reproduce");
  console.log("SAVED " + path.basename(OUT) + " minted " + saved.mintedAt + " — nullBar NOT called again; seeded parts reproduce");
}

for (const k of Object.keys(saved.spans)) {
  const s = saved.spans[k];
  console.log(`\n${k.toUpperCase()}  return months ${s.returnMonths} (${s.monthsInSpan} in span; T1 needs >= ${s.minMonthsT1}; any t-gate needs >= ${s.minMonthsAnyGate}); bar computed at n = ${s.barComputedAtN}`);
  for (const v of Object.keys(s.byFamilySize)) {
    const c = s.byFamilySize[v];
    console.log(`   family size ${v}: nullBar p95 ${c.nullBar.p95.toFixed(4)} (median ${c.nullBar.median}, p99 ${c.nullBar.p99}, trials ${c.nullBar.trials}) | Newey-West lag-${saved.neweyWest.lag} null p95 ${c.neweyWestNull.p95} (p99 ${c.neweyWestNull.p99}) | BAR ${c.bar.toFixed(3)} | smallest effect seen 80% of the time: ${c.mdeInSdAt80pctPower} x the monthly standard deviation`);
  }
}
console.log("\nCOST, registered, per fund group (Cherkes, Sagi and Stanton 2009, one-way x 2), and its drag at one round trip per 12 months:");
for (const g of Object.keys(saved.costs)) { const c = saved.costs[g]; console.log(`   ${g.padEnd(13)} one-way ${c.oneWayPct.toFixed(2)}%  round trip ${c.roundTripPct.toFixed(2)}%  = ${c.dragPctPerMonthAt12mHold.toFixed(3)}% a month = $${c.dragUsdPerMonthPer100k} a month per $100,000 held`); }
console.log("\nFOR SCALE ONLY — published GROSS figures from other people's samples (no house number, no forecast):");
for (const k of Object.keys(saved.publishedGrossForScaleOnly)) { const p = saved.publishedGrossForScaleOnly[k]; console.log(`   ${k}: ${p.pctPerYear}% a year = $${p.usdPerMonthPer100k} a month per $100,000`); }
