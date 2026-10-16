#!/usr/bin/env node
// attack-stats-cost-arith.cjs — every number quoted in attack-stats-cost.md that is not copied from a draft or a scout file.
//
// It reads NO market data and makes NO network request. It does NOT call backend/lib/null-bar.js (a bar is never re-rolled here).
// Everything is arithmetic or a simulation on MADE series with fixed seeds, so every run prints the same numbers.
//
// Run (Git Bash or PowerShell, from the repo root):   node docs/fund-discounts/2026-10-12/attack-stats-cost-arith.cjs
"use strict";

// ---- helpers -------------------------------------------------------------------------------------------------------------
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gaussOf(rng) { let spare = null; return () => { if (spare !== null) { const s = spare; spare = null; return s; } let u = 0, v = 0; while (u === 0) u = rng(); v = rng(); const r = Math.sqrt(-2 * Math.log(u)), th = 2 * Math.PI * v; spare = r * Math.sin(th); return r * Math.cos(th); }; }
/** Newey-West (Bartlett) t of a mean: the formula of backend/lib/tv-pit-panel.js nwT(a, L), copied. */
function nwT(a, L) {
  const n = a.length; if (n < 3) return null;
  let m = 0; for (let i = 0; i < n; i++) m += a[i]; m /= n;
  let v = 0; for (let i = 0; i < n; i++) v += (a[i] - m) * (a[i] - m); v /= n;
  for (let l = 1; l <= L; l++) { let g = 0; for (let i = l; i < n; i++) g += (a[i] - m) * (a[i - l] - m); v += 2 * (1 - l / (L + 1)) * g / n; }
  return v > 0 ? m / Math.sqrt(v / n) : null;
}
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function Phi(x) { // standard normal CDF (Abramowitz-Stegun 7.1.26 on erf)
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
function binomCdf(n, k, p) { let s = 0, c = 1; for (let i = 0; i <= k; i++) { if (i > 0) c = c * (n - i + 1) / i; s += c * Math.pow(p, i) * Math.pow(1 - p, n - i); } return s; }
const f = (x, d = 3) => (x == null ? "n/a" : x.toFixed(d));
const pct = (x, d = 1) => (100 * x).toFixed(d) + "%";
// known answers, checked on every run
(function selfcheck() {
  if (Math.abs(nwT([1, 2, 3, 4], 0) - 4.472136) > 1e-5 || Math.abs(nwT([1, 2, 3, 4], 1) - 4.0) > 1e-9) throw new Error("nwT known answer failed");
  if (Math.abs(Phi(1.96) - 0.975) > 1e-3 || Math.abs(binomCdf(2, 1, 0.5) - 0.75) > 1e-12) throw new Error("Phi or binomCdf known answer failed");
})();

// ---- 1. gates that fail (or pass) by chance alone -----------------------------------------------------------------------------
console.log("1. GATES AND CHANCE (arithmetic)");
console.log("   tradeable-book C1 sanity gate ('t under the bar in at least 18 of 20 draws', each draw over the bar 5% of the time by construction):");
console.log("      chance it fails with nothing wrong = P(3 or more of 20) = " + pct(1 - binomCdf(20, 2, 0.05)));
console.log("   clean-statistic V2 (two scrambles, each T2 t must be under 2): chance it fails with nothing wrong = " + pct(1 - Math.pow(Phi(2), 2)));
console.log("   tradeable-book gate 5 (headline t and C3 t under 2 on two seeds = four tests, taken as independent): " + pct(1 - Math.pow(Phi(2), 4)));
console.log("   tradeable-book gate 5 ('at most 5% of 60 worlds' = at most 3 passes): chance it fails when the true false-pass rate is 5%: " + pct(1 - binomCdf(60, 3, 0.05)) + " | 2%: " + pct(1 - binomCdf(60, 3, 0.02)));
console.log("   clean-statistic V4 ('at most 5% of 200 scrambles' = at most 10 passes): chance it still PASSES when the true false-pass rate is 3%: " + pct(binomCdf(200, 10, 0.03)) + " | 5%: " + pct(binomCdf(200, 10, 0.05)) + " | 8%: " + pct(binomCdf(200, 10, 0.08)));
console.log("      (three independent 5% t-gates alone would pass by chance " + pct(Math.pow(0.05, 3), 4) + " of the time; the 5% line is far looser than the rule it checks)");
console.log("   the replacements proposed in attack-stats-cost.md:");
console.log("      'at most 3 of 20 over the bar': fails with nothing wrong " + pct(1 - binomCdf(20, 3, 0.05)) + " | still passes when the true rate is 20%: " + pct(binomCdf(20, 3, 0.20)));
console.log("      'one t-gate passes on at most 16 of 200 no-edge worlds': fails with nothing wrong " + pct(1 - binomCdf(200, 16, 0.05)) + " | still passes when the true rate is 10%: " + pct(binomCdf(200, 16, 0.10)));
console.log("      'one t-gate passes on at most 6 of 60 no-edge worlds': fails with nothing wrong " + pct(1 - binomCdf(60, 6, 0.05)) + " | still passes when the true rate is 15%: " + pct(binomCdf(60, 6, 0.15)));

// ---- 2. power: one gate against the whole chain -----------------------------------------------------------------------------
console.log("\n2. POWER (arithmetic; an illustration of the structure, not a measurement)");
const barB = 1.684, z80 = 0.8416;
console.log("   tradeable-book gate 9 defines 'smallest visible effect' as bar x sigma / sqrt(months): that effect is found 50% of the time.");
console.log("      the effect found four times in five is (bar + 0.8416) x sigma / sqrt(months) = " + f((barB + z80) / barB, 3) + " times larger");
console.log("   clean-statistic chain, if the true effect is exactly the size ONE t-gate finds four times in five:");
console.log("      one gate 80.0% | three t-gates if independent " + pct(Math.pow(0.8, 3)) + " | discovery AND holdout, three gates each: between " + pct(Math.pow(0.8, 6)) + " (independent) and " + pct(0.8 * 0.8) + " (gates move as one)");
for (const [name, bar] of [["discovery 1.721", 1.721], ["holdout 1.727", 1.727]]) {
  const et = bar + z80, half = et / Math.SQRT2;
  console.log("      " + name + ": expected t at that effect " + f(et, 2) + "; a half-span has expected t " + f(half, 2) + ", so 'both halves above 0' (G8) holds " + pct(Math.pow(Phi(half), 2)) + " of the time");
}
console.log("      a sign gate on a series 4 times noisier than the gated one (T4 on raw fund-against-fund pairs, an assumed ratio): above 0 only " + pct(Phi((1.727 + z80) / 4)) + " of the time");

// ---- 3. the extra yield of buying below asset value, against the registered cost ------------------------------------------------
console.log("\n3. EXTRA YIELD OF A DISCOUNT BUYER (arithmetic): y x (1/(1 - discount) - 1), percent a year on the money invested");
for (const y of [0.06, 0.08]) for (const dsc of [0.05, 0.10, 0.15]) console.log("   payout " + pct(y, 0) + " of asset value, bought " + pct(dsc, 0) + " below: " + pct(y * (1 / (1 - dsc) - 1), 2) + " a year = $" + Math.round(100000 * y * (1 / (1 - dsc) - 1) / 12) + " a month per $100,000");
console.log("   registered round-trip cost at one round trip a year: 0.80% to 1.36% a year = $67 to $113 a month per $100,000 (draft-clean-statistic-bar.cjs)");
console.log("   difference in extra yield between a book bought 12% below and a placebo bought 6% below, payout 8%: " + pct(0.08 * (1 / 0.88 - 1 / 0.94), 2) + " a year = $" + Math.round(100000 * 0.08 * (1 / 0.88 - 1 / 0.94) / 12) + " a month per $100,000 invested (assumed levels, for the sign of the bias only)");

// ---- 4. what shuffling each fund by itself does to the noise of a book ---------------------------------------------------------
console.log("\n4. NOISE OF AN EQUAL-WEIGHT BOOK WHEN FUNDS MOVE TOGETHER (arithmetic): sd of the mean of N positions with pairwise correlation rho,");
console.log("   as a multiple of the sd when the funds are independent (which is what a fund-by-fund shuffle produces). rho is ASSUMED; nobody has measured it.");
for (const N of [20, 100]) console.log("   N = " + String(N).padStart(3) + ": " + [0.1, 0.3, 0.5].map((rho) => "rho " + rho + " -> " + f(Math.sqrt(1 / N + rho * (1 - 1 / N)) / Math.sqrt(1 / N), 1) + "x").join(" | "));

// ---- 5. the bar against months that are lopsided, not uniform -------------------------------------------------------------------
// The registered bars come from uniform noise (symmetric, thin tails). Monthly results of a book that is long gaps which blow out
// fast and heal slowly are likely to have a few very bad months. This shows what that does to the top 5% of a Newey-West t when
// the true mean is zero. The shape below is MADE UP (nobody has looked at the real months); it shows the direction and rough size only.
console.log("\n5. THE 95th PERCENTILE OF A NEWEY-WEST t UNDER NO EDGE, BY THE SHAPE OF THE MONTHS (simulation, 40,000 trials each, fixed seeds)");
function shapeNull(label, n, L, bar, draw, seed, T = 40000) {
  const rng = mulberry(seed), g = gaussOf(rng), ts = new Float64Array(T), s = new Array(n);
  let m1 = 0, m2 = 0, m3 = 0; const big = 400000; for (let i = 0; i < big; i++) { const x = draw(rng, g); m1 += x; m2 += x * x; m3 += x * x * x; } m1 /= big; m2 /= big; m3 /= big;
  const sd = Math.sqrt(m2 - m1 * m1), skew = (m3 - 3 * m1 * m2 + 2 * m1 * m1 * m1) / (sd * sd * sd);
  let over = 0; for (let t = 0; t < T; t++) { for (let i = 0; i < n; i++) s[i] = draw(rng, g) - m1; const tv = nwT(s, L); ts[t] = tv; if (tv >= bar) over++; }
  const a = Array.from(ts).sort((x, y) => x - y);
  console.log("   " + label.padEnd(58) + " n " + n + " lag " + L + " | skew " + f(skew, 2).padStart(6) + " | p95 " + f(a[Math.floor(0.95 * T)]) + " | passes the registered " + bar + " by chance " + pct(over / T, 2));
}
const uniform = (rng) => rng() * 2 - 1;
const crashLeft = (rng, g) => (rng() < 0.04 ? -5 + 2 * g() : g());      // 4 months in 100 are a blow-out
const crashRight = (rng, g) => (rng() < 0.04 ? 5 + 2 * g() : g());      // the mirror: 4 months in 100 are a snap-back
for (const [n, L, bar, tag] of [[140, 4, 1.727, "clean-statistic holdout"], [100, 4, 1.721, "clean-statistic discovery"], [177, 3, 1.684, "tradeable-book holdout"]]) {
  shapeNull(tag + ": uniform noise (what the bar assumes)", n, L, bar, uniform, 5100 + n);
  shapeNull(tag + ": 4% blow-out months (long left tail)", n, L, bar, crashLeft, 5200 + n);
  shapeNull(tag + ": 4% snap-back months (long right tail)", n, L, bar, crashRight, 5300 + n);
}
console.log("   5b. how exactly is a simulated bar known? The same uniform-noise null again, 200,000 trials, other seeds (a check of the drafts' third decimal, not a new bar):");
for (const [n, L, bar, tag] of [[100, 4, 1.721, "clean-statistic discovery"], [140, 4, 1.727, "clean-statistic holdout"], [108, 3, 1.708, "tradeable-book discovery"], [177, 3, 1.684, "tradeable-book holdout"]]) shapeNull(tag + ": uniform noise, 200,000 trials", n, L, bar, uniform, 5500 + n, 200000);
console.log("       one standard error of a 95th percentile is about 0.032 at 5,000 trials (the house call), 0.010 at 50,000, 0.005 at 200,000");

// ---- 6. toy: what a same-month, per-dollar twin can and cannot see ----------------------------------------------------------------
// MADE monthly worlds, no real series. 120 funds, 312 months. A fund's log(price / asset value) = -0.06 + common + own; no walls.
// A "blow-out" is a drop of 6 points that arrives in 3 months of 100.
//   COMMON world:  every fund blows out TOGETHER and heals together (the common part loses a tenth of its distance each month); own part is a small random walk.
//   OWN world:     each fund blows out BY ITSELF and heals by itself; no common part.
//   NO-EDGE world: jumps of 6 points up or down, together, that never heal (a random walk); own part is a small random walk.
// Rule (monthly stand-in for the drafts' daily rule): z from the 12 months before; signal when z < -2 and d < 0 and the fund is not held;
// bought one month later, held 12 months; a month's result = change in (1 + d), i.e. price return minus asset-value return, no cost, no payout.
//   T1  = mean over months (5 or more positions) of the equal-weight result of the open positions                 (clean-statistic T1, gross)
//   T2  = the same months, real minus the pooled random-date placebo ON THE SAME FUNDS IN THE SAME MONTH, per dollar (clean-statistic T2)
//   G$  = every month, SUM over open real positions minus the average placebo book's SUM (dollars, real exposure)   (tradeable-book C3 'gap part', gross)
console.log("\n6. TOY WORLDS (made monthly series, 40 seeds each): share of seeds in which each statistic clears t >= 1.727");
function world(kind, seed) {
  const rng = mulberry(seed), g = gaussOf(rng), N = 120, T = 312, HOLD = 12, BOOKS = 100;
  const d = Array.from({ length: N }, () => new Float64Array(T));
  let c = 0; const own = new Float64Array(N), JUMP = 0.06, PJ = 0.03;
  for (let t = 0; t < T; t++) {
    if (kind === "COMMON") c = 0.90 * c + 0.004 * g() - (rng() < PJ ? JUMP : 0);
    else if (kind === "NO-EDGE") { const u = rng(); c = c + 0.004 * g() + (u < PJ / 2 ? -JUMP : u < PJ ? JUMP : 0); }
    else c = 0;
    for (let i = 0; i < N; i++) {
      if (kind === "OWN") own[i] = 0.90 * own[i] + 0.004 * g() - (rng() < PJ ? JUMP : 0); else own[i] = own[i] + 0.004 * g();
      d[i][t] = Math.exp(-0.06 + c + own[i]) - 1;
    }
  }
  const ce = (i, m) => (1 + d[i][m]) / (1 + d[i][m - 1]) - 1;
  const sumReal = new Float64Array(T), cntReal = new Int32Array(T), sumPl = new Float64Array(T), cntPl = new Int32Array(T);
  let positions = 0;
  for (let i = 0; i < N; i++) {
    const elig = []; let n = 0, freeFrom = 0;
    for (let t = 12; t + 1 + HOLD < T; t++) {
      if (!(d[i][t] < 0)) continue;
      let m = 0; for (let k = t - 12; k < t; k++) m += d[i][k]; m /= 12;
      let v = 0; for (let k = t - 12; k < t; k++) v += (d[i][k] - m) * (d[i][k] - m); const sd = Math.sqrt(v / 11);
      if (!(sd > 0)) continue;
      elig.push(t);
      if ((d[i][t] - m) / sd < -2 && t >= freeFrom) { n++; freeFrom = t + 1 + HOLD + 1; for (let mm = t + 2; mm <= t + 1 + HOLD; mm++) { sumReal[mm] += ce(i, mm); cntReal[mm]++; } }
    }
    positions += n;
    if (n && elig.length) for (let b = 0; b < BOOKS; b++) for (let k = 0; k < n; k++) { const t = elig[Math.floor(rng() * elig.length)]; for (let mm = t + 2; mm <= t + 1 + HOLD; mm++) { sumPl[mm] += ce(i, mm); cntPl[mm]++; } }
  }
  const x1 = [], x2 = [], gd = [];
  for (let m = 14; m < T; m++) {
    gd.push(sumReal[m] - sumPl[m] / BOOKS);
    if (cntReal[m] >= 5) { const xr = sumReal[m] / cntReal[m]; x1.push(xr); if (cntPl[m] > 0) x2.push(xr - sumPl[m] / cntPl[m]); }
  }
  return { positions, months: x1.length, t1: nwT(x1, 4), t2: x2.length >= 3 ? nwT(x2, 4) : null, tg: nwT(gd, 4), m1: x1.length ? mean(x1) : 0, m2: x2.length ? mean(x2) : 0 };
}
for (const kind of ["COMMON", "OWN", "NO-EDGE"]) {
  let p1 = 0, p2 = 0, pg = 0, pos = 0, mo = 0, s1 = 0, s2 = 0; const S = 40;
  for (let s = 1; s <= S; s++) { const w = world(kind, 6000 + s + (kind === "COMMON" ? 0 : kind === "OWN" ? 100 : 200)); pos += w.positions; mo += w.months; s1 += w.m1; s2 += w.m2; if (w.t1 != null && w.t1 >= 1.727) p1++; if (w.t2 != null && w.t2 >= 1.727) p2++; if (w.tg != null && w.tg >= 1.727) pg++; }
  console.log("   " + kind.padEnd(8) + " positions/seed " + String(Math.round(pos / S)).padStart(4) + " | counted months/seed " + String(Math.round(mo / S)).padStart(3) + " | T1 clears " + String(p1).padStart(2) + "/40 (mean " + pct(s1 / S, 2) + " a month) | same-month per-dollar twin T2 clears " + String(p2).padStart(2) + "/40 (mean " + pct(s2 / S, 2) + ") | gap dollars against the placebo book G$ clears " + String(pg).padStart(2) + "/40");
}
console.log("   Reading: when gaps blow out and heal TOGETHER, T1 does not see it (every counted month weighs the same, whether 5 positions are open or 120, so the");
console.log("   book's average month is the average month) and the same-month per-dollar twin does not see it (that month the placebo holds the same funds).");
console.log("   The dollar version, which keeps the book's real exposure through time, sees it in about half the seeds. When each fund heals by itself, all three see it.");
console.log("   The jump size, its frequency and the healing speed are INVENTED. The toy shows which statistic can see which kind of effect, and nothing about real funds.");

// ---- 7. span edges: the half of the cost that is never charged ------------------------------------------------------------------
console.log("\n7. SPAN EDGES IN THE CLEAN-STATISTIC DRAFT (arithmetic; signals taken as evenly spread, which they are not)");
console.log("   discovery: signal window 2000-01..2011-12 = 144 months; return months start 2001-01, so the entry half of positions signalled in 2000 falls in an unread month: 12/144 = " + pct(12 / 144));
console.log("              positions signalled in 2011 leave after 2011-12, so their exit half falls in an unread month: 12/144 = " + pct(12 / 144));
console.log("   holdout:   signal window 2012-01..2026-09 = 177 months; positions signalled in the last 12 months leave after 2026-09: 12/177 = " + pct(12 / 177));

// ---- 8. the published healing speed in market days (for the planted-effect world proposed in the attack) ---------------------------
console.log("\n8. PUBLISHED HALF-LIFE IN MARKET DAYS (arithmetic): 7.7 months x 21 market days = " + Math.round(7.7 * 21) + " days; daily pull toward the mean = 1 - 0.5^(1/" + Math.round(7.7 * 21) + ") = " + pct(1 - Math.pow(0.5, 1 / Math.round(7.7 * 21)), 3) + " of the distance");
