#!/usr/bin/env node
// final-arith.cjs — every number quoted in SUMMARY.md, RUNNER-SPEC.md and DEFECTS-RESOLVED.md that is not a published figure.
//
// Reads ONE data file, the data scout's scout-universe.json (counts and dates only), and the two drafts' saved bar files.
// No network, no price, no NAV, no discount, no return, no registry. It calls backend/lib/null-bar.js with the SAME fixed seeds
// the registration script uses, so the bar printed here is the bar that script will compute (it is not typed anywhere).
//
// Run from the repo root:  node docs/fund-discounts/2026-10-12/final-arith.cjs
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const REPO = path.join(__dirname, "..", "..", "..");
const { nullBar } = require(path.join(REPO, "backend", "lib", "null-bar.js"));
const usd = (n) => (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString("en-US");

// ---- the universe, by cost group (the frozen list) ----
const raw = fs.readFileSync(path.join(__dirname, "scout-universe.json")), U = JSON.parse(raw);
const GROUPS = {
  MUNI: ["Municipal", "Municipal-CA", "Municipal-NY", "Municipal-Single State"],
  TAXABLE_BOND: ["Investment Grade", "High Yield", "Senior Loans", "Limited Duration", "Multi-Sector", "Preferreds", "Convertibles", "Taxable Muni", "Global Income", "Emerging Market Income"],
  US_EQ: ["US Equity", "Sector Equity", "Covered Call", "US Allocation", "Real Estate", "MLP"],
  FOREIGN_EQ: ["Asia Equity", "Emerging Market Equity", "Single Country Equity", "Global Equity", "Global Allocation"],
};
const CLASS_COST_PCT = { MUNI: 0.80, TAXABLE_BOND: 1.08, US_EQ: 1.02, FOREIGN_EQ: 1.36 };
const FOREIGN_CLOCK = ["Asia Equity", "Emerging Market Equity", "Single Country Equity", "Global Equity", "Global Allocation", "Global Income", "Emerging Market Income"];
const groupOf = (c) => Object.keys(GROUPS).find((g) => GROUPS[g].includes(c)) || null;
const base = U.funds.filter((f) => f.bothRows > 0 && !f.navSymbolRejected && !f.termFund);
const tally = {}; for (const f of base) { const g = groupOf(f.assetClassIfKnown); if (!g) throw new Error("class with no cost group: " + f.assetClassIfKnown); tally[g] = (tally[g] || 0) + 1; }
console.log("1. UNIVERSE  file sha256", crypto.createHash("sha256").update(raw).digest("hex"));
console.log("   funds on the list", U.funds.length, "| both series, no term date:", base.length, "|", JSON.stringify(tally), "| foreign-clock classes", base.filter((f) => FOREIGN_CLOCK.includes(f.assetClassIfKnown)).length);

// ---- the book and its cost ----
const ACCOUNT = 100000, PLACES = 24, STAKE = 4000, INVESTED = PLACES * STAKE;
const wCost = Object.keys(tally).reduce((s, g) => s + tally[g] * CLASS_COST_PCT[g], 0) / base.length;
console.log("\n2. THE BOOK  ", PLACES, "places x", usd(STAKE), "=", usd(INVESTED), "at most at work on a", usd(ACCOUNT), "account; one new position each half-month = 24 a year, each held 252 market days");
console.log("   class cost a round trip, weighted by the universe's mix:", wCost.toFixed(4) + "%");
for (const [label, mult] of [["at the class cost (own spreads recorded and no wider)", 1], ["at 1.5 x class cost (no spread table)", 1.5], ["at 2 x class cost", 2], ["at 3 x class cost", 3]]) {
  const perYear = INVESTED * wCost / 100 * mult;
  console.log("   one round trip a year on a full book,", label + ":", usd(perYear), "a year =", usd(perYear / 12), "a month per $100,000");
}
console.log("   per position: from", usd(STAKE * 0.80 / 100), "(municipal) to", usd(STAKE * 1.36 / 100), "(foreign equity) a round trip; x1.5:", usd(STAKE * 1.2 / 100), "to", usd(STAKE * 2.04 / 100));
console.log("   one position against the liquidity floor:", (100 * STAKE / 400000).toFixed(2) + "% of a $400,000 day");

// ---- what the published sizes would be worth on this book (other people's samples, BEFORE costs; an illustration, not a forecast) ----
console.log("\n3. IF A PUBLISHED SIZE HELD on", usd(INVESTED), "at work (gross, then after one round trip a year at 1x and at 1.5x class cost), dollars a month per $100,000 account:");
const PUBLISHED = [
  ["Thompson 1978, equal-weighted discount funds, 1940-75: 2.37% a year", 2.37],
  ["Thompson 1978, discount-weighted: 4.12% a year", 4.12],
  ["Pontiff 1995, a fund 20 points below asset value: 6% a year", 6.0],
  ["Patro, Piccotti and Wu, cheapest fifth over the market, 1998-2011: 9.3% a year", 9.3],
  ["the same after the average post-publication fall of stock predictors (58%, McLean and Pontiff 2016): 3.906% a year", 9.3 * 0.42],
];
const c1 = INVESTED * wCost / 100 / 12, c15 = c1 * 1.5;
for (const [what, pct] of PUBLISHED) { const g = INVESTED * pct / 100 / 12; console.log("   " + what + ":  gross", usd(g), "| net", usd(g - c1), "| net at 1.5x cost", usd(g - c15)); }
console.log("   the operator's catalogue line (6% a year on $100,000) is $500 a month");

// ---- the bar, with the registration script's own seeds (nothing typed) ----
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
function nwT(a, L) { const n = a.length; let m = 0; for (const x of a) m += x; m /= n; const d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n; for (let l = 1; l <= L; l++) { let g = 0; for (let i = l; i < n; i++) g += d[i] * d[i - l]; v += 2 * (1 - l / (L + 1)) * g / n; } return v > 0 ? m / Math.sqrt(v / n) : 0; }
const BAR_SEED = 20261012, NW_LAG = 4, HOUSE_TRIALS = 20000, FINE_TRIALS = 400000, NW_TRIALS = 50000;
const ceil3 = (x) => Math.ceil(x * 1000 - 1e-9) / 1000;
const cj = JSON.parse(fs.readFileSync(path.join(__dirname, "draft-clean-statistic-bar.json"), "utf8")), bj = JSON.parse(fs.readFileSync(path.join(__dirname, "draft-tradeable-book-bar.json"), "utf8"));
function barFor(span, n) {
  const house = nullBar({ variants: 1, n, trials: HOUSE_TRIALS, rng: mulberry(BAR_SEED + n) }).p95;
  const fine = nullBar({ variants: 1, n, trials: FINE_TRIALS, rng: mulberry(BAR_SEED + 100000 + n) }).p95;
  const r = mulberry(BAR_SEED + 200000 + n), ts = new Array(NW_TRIALS), s = new Array(n);
  for (let t = 0; t < NW_TRIALS; t++) { for (let i = 0; i < n; i++) s[i] = r() * 2 - 1; ts[t] = nwT(s, NW_LAG); }
  ts.sort((a, b) => a - b); const nw = ts[Math.floor(0.95 * NW_TRIALS)];
  const floor = Math.max(cj.spans[span].byFamilySize["1"].bar, bj.rows.find((x) => x.span === span && x.variants === 1).bar);
  return { house, fine, nw, floor, t: ceil3(Math.max(house, fine, nw, floor)) };
}
console.log("\n4. THE BAR (one variant; unit months; the largest of four numbers, rounded up to 3 decimals; fixed seeds, so this reproduces)");
const BARS = {};
for (const [span, n] of [["holdout", 177], ["discovery", 108]]) {
  const b = BARS[span] = barFor(span, n);
  console.log("   " + span + " (" + n + " months): nullBar 20,000 trials " + b.house.toFixed(4) + " | nullBar 400,000 trials " + b.fine.toFixed(4) + " | Newey-West lag-4 null 50,000 trials " + b.nw.toFixed(4) + " | the higher of the two drafts' saved bars " + b.floor + "  ->  BAR " + b.t.toFixed(3) + (span === "discovery" ? "  (reported only; discovery gates on sign)" : "  (the one deciding t)"));
}
const B = BARS.holdout.t, mde80 = (B + 0.8416) / Math.sqrt(177), mde50 = B / Math.sqrt(177);
console.log("   smallest effect the single t finds four times in five: (" + B.toFixed(3) + " + 0.8416) / sqrt(177) = " + mde80.toFixed(3) + " of the monthly standard deviation of G (half the time: " + mde50.toFixed(3) + ")");
for (const sd of [300, 500, 800]) console.log("   if that standard deviation were " + usd(sd) + " a month (NOT known before the controls run): " + usd(mde80 * sd) + " a month");

// ---- chance arithmetic for the count thresholds of the validity gates (binomial) ----
function binomTail(n, p, kMin) { let s = 0, c = 1; for (let k = 0; k <= n; k++) { if (k > 0) c = c * (n - k + 1) / k; if (k >= kMin) s += c * Math.pow(p, k) * Math.pow(1 - p, n - k); } return s; }
console.log("\n5. COUNT THRESHOLDS  (chance of a spurious failure when nothing is wrong)");
console.log("   'the deciding t is at or above the bar in at most 16 of 200 no-edge worlds': fails by chance " + (100 * binomTail(200, 0.05, 17)).toFixed(1) + "% at a true 5%; a true 10% slips through " + (100 * (1 - binomTail(200, 0.10, 17))).toFixed(1) + "%");
console.log("   'one placebo draw against the others is over the bar in at most 3 of 20': fails by chance " + (100 * binomTail(20, 0.05, 4)).toFixed(1) + "%");
console.log("   four sign gates that were independent coin flips would all hold " + (100 * Math.pow(0.5, 4)).toFixed(2) + "% of the time; with the 5% t-gate, " + (100 * 0.05 * Math.pow(0.5, 4)).toFixed(2) + "% (they are not independent of the t; the no-edge worlds measure the true rate)");

// ---- calendar facts the entry states ----
const mkt = ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14"];
console.log("\n6. CALENDAR  the 10th market day after 2026-09-30 is " + mkt[9] + " (weekdays; no NYSE holiday in that stretch), so the cache is fetched on or after 2026-10-15");
console.log("   return months: discovery 2003-01..2011-12 = " + (9 * 12) + "; holdout 2012-01..2026-09 = " + (14 * 12 + 9));
console.log("   half-months: discovery " + (108 * 2) + " (less 8 in the seen window of 2008), holdout " + (177 * 2) + " (less 6 in the seen window of 2020): at most " + (216 - 8) + " and " + (354 - 6) + " positions");
const early = base.filter((f) => f.overlapFirst && f.overlapFirst <= "1999-12-31"), by2001 = base.filter((f) => f.overlapFirst && f.overlapFirst <= "2000-12-31");
console.log("   why discovery starts 2003-01-02: universe funds whose two series both exist by the end of 1999: " + early.length + " (by the end of 2000: " + by2001.length + "); 756 market days is three years, so the 1998-1999 load can signal by January 2003 and not much before");
for (const d of ["2003-01-02", "2007-01-03", "2012-01-03", "2018-01-02", "2026-09-30"]) { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() - 1096); const cut = t.toISOString().slice(0, 10); console.log("   universe funds with both series for three calendar years before " + d + " (before the liquidity floor and the screens, which only lower it): " + base.filter((f) => f.overlapFirst && f.overlapFirst <= cut).length); }
console.log("   half-life 7.7 months in market days: " + (7.7 * 21).toFixed(0) + "; daily pull 1 - 0.5^(1/162) = " + (1 - Math.pow(0.5, 1 / 162)).toFixed(5));
