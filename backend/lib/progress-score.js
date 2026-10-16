/**
 * PROGRESS SCORES — 0 to 100 on each of the three questions. 2026-09-08, operator: "we need a better scale than this;
 * 1-100 or something similar", replacing the words calmer / improving / negative.
 *
 * ═══ THE DANGER, AND WHAT IS DONE ABOUT IT ═══
 *
 * A 0-100 score is the easiest way in the world to invent precision. Three rules keep this one honest:
 *
 *   1. 50 IS NEUTRAL AND MEANS EXACTLY ONE THING — the measurement sits on zero: no calmer, no better than the coin flip,
 *      no money per ticket. Above 50 is better, below is worse. There is no curve, no weighting, no committee.
 *
 *   2. THE SCALE CONSTANT IS DECLARED, NOT TUNED. Each dimension is score = 50 + 50 · tanh(effect / scale), where `scale`
 *      is a size fixed in advance and written below with the reason it was chosen. tanh is used because it is bounded,
 *      smooth and symmetric: one scale unit of improvement is 88, two is 96, and no single session can pin it at 100.
 *      Changing a scale constant later is a registered change, not a tuning knob.
 *
 *   3. EVERY SCORE CARRIES ITS OWN UNCERTAINTY. The score is computed again at both ends of the effect's 95% interval,
 *      and the band is published beside it. A band that straddles 50 means the dimension is UNDECIDED however pleasing
 *      the point estimate looks, and the report says so in those words. This is the part that stops a score from lying:
 *      a 62 built on four sessions and a 62 built on forty are different claims, and the band is what tells them apart.
 *
 * The three dimensions, their effect, and why the scale is what it is:
 *
 *   BETTER (discipline)   effect = the fall in daily P&L volatility against the previous window, as a fraction.
 *                         scale 0.5 — halving the daily swing is a decisive improvement in steadiness, so it scores 88.
 *   SMARTER (learning)    effect = the t on the signal-minus-control session gap.
 *                         scale 2.0 — this shop's own significance bar. Clearing it scores 88; sitting at chance scores 50.
 *   PROFITABLE (money)    effect = mean net R per ticket over the window.
 *                         scale 0.05R — a book earning a twentieth of an R per ticket net of cost is genuinely good, and
 *                         is roughly the size of the measured equity cost per ticket, so it is a real hurdle, not a wish.
 *
 * Nothing here is a forecast and nothing here adjudicates a registered test. It is a reading of the last window against
 * the one before it, on the canonical ledger, in one frame.
 */
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const score = (effect, scale) => (effect == null || !Number.isFinite(effect) ? null : Math.round(clamp(50 + 50 * Math.tanh(effect / scale), 0, 100)));

/** mean, sd and the 95% interval of an array — the band every score is published with */
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
function ci95(a) {
  if (!a || a.length < 2) return null;
  const m = mean(a), s = sd(a); if (!(s > 0)) return { lo: m, hi: m };
  const se = s / Math.sqrt(a.length);
  return { lo: m - 1.96 * se, hi: m + 1.96 * se, se, mean: m, n: a.length };
}

const SCALES = { better: 0.5, smarter: 2.0, profitable: 0.05 };

/**
 * @param {object} W   this window  { dailySd, gap, gapT, gapSessions, avgR, n, sessionGaps?, sessionR? }
 * @param {object} Wp  the window before it
 * @param {number[]} sessionGaps  per-session signal-minus-control gaps in W (for the smarter band)
 * @param {number[]} sessionR     per-session mean R in W (for the profitable band)
 */
/**
 * ROBUST SWING. The first build used the standard deviation of daily P&L and scored BETTER at 97/100 — because the previous
 * window contained the 2026-08-24 session of +$18,780 and the current one did not. That is an outlier leaving the window, not
 * the desk becoming disciplined, and a score that moves 47 points on one day rolling off is a score that lies. The median
 * absolute daily P&L is used instead: it cannot be moved by a single session however large, which is exactly the property
 * wanted from a measure of steadiness. The band comes from resampling sessions, so the score reports its own instability.
 */
const median = (a) => { if (!a || !a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const swingOf = (daily) => median((daily || []).map(Math.abs));
function bootstrapBand(now, prev, scale, trials = 400) {
  if (!now || !prev || now.length < 3 || prev.length < 3) return null;
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const vals = [];
  for (let i = 0; i < trials; i++) {
    const a = Array.from({ length: now.length }, () => pick(now)), b = Array.from({ length: prev.length }, () => pick(prev));
    const sa = swingOf(a), sb = swingOf(b);
    if (sb > 0) vals.push(score((sb - sa) / sb, scale));
  }
  if (vals.length < 20) return null;
  vals.sort((x, y) => x - y);
  return { lo: vals[Math.floor(0.025 * vals.length)], hi: vals[Math.floor(0.975 * vals.length)] };
}

function build(W, Wp, sessionGaps, sessionR, dailyNow, dailyPrev) {
  const out = {};

  // BETTER — the fractional fall in the ROBUST daily swing. Positive = calmer.
  const sNow = swingOf(dailyNow), sPrev = swingOf(dailyPrev);
  const calm = (sNow != null && sPrev > 0) ? (sPrev - sNow) / sPrev : null;
  out.better = { score: score(calm, SCALES.better), effect: calm, unit: "fall in the median daily P&L swing vs the previous window",
    detail: sNow == null ? "" : `typical day ${Math.round(sNow)} vs ${Math.round(sPrev ?? 0)}`,
    band: bootstrapBand(dailyNow, dailyPrev, SCALES.better), scale: SCALES.better };

  // SMARTER — the t on the session gap, with the band taken from the gap's own interval re-expressed as a t
  const gc = ci95(sessionGaps || []);
  out.smarter = { score: score(W.gapT, SCALES.smarter), effect: W.gapT, unit: "t on the signal-minus-control session gap",
    detail: W.gap == null ? "" : `gap ${W.gap >= 0 ? "+" : ""}${W.gap.toFixed(3)}R over ${W.gapSessions ?? 0} sessions`,
    band: gc && gc.se > 0 ? { lo: score(gc.lo / gc.se, SCALES.smarter), hi: score(gc.hi / gc.se, SCALES.smarter) } : null,
    scale: SCALES.smarter };

  // PROFITABLE — mean net R per ticket, band from the per-session means (sessions are the unit, never tickets)
  const pc = ci95(sessionR || []);
  out.profitable = { score: score(W.avgR, SCALES.profitable), effect: W.avgR, unit: "mean net R per ticket",
    detail: W.avgR == null ? "" : `${W.avgR >= 0 ? "+" : ""}${W.avgR.toFixed(3)}R per ticket on ${W.n} tickets`,
    band: pc ? { lo: score(pc.lo, SCALES.profitable), hi: score(pc.hi, SCALES.profitable) } : null,
    scale: SCALES.profitable };

  // a band that straddles 50 is undecided, whatever the point estimate reads
  for (const k of Object.keys(out)) {
    const b = out[k].band;
    out[k].undecided = !!(b && b.lo != null && b.hi != null && b.lo <= 50 && b.hi >= 50);
  }
  out.overall = (() => {
    const v = ["better", "smarter", "profitable"].map((k) => out[k].score).filter((x) => x != null);
    return v.length ? Math.round(mean(v)) : null;   // a plain average; no weighting anyone would have to defend
  })();
  return out;
}

module.exports = { build, score, ci95, SCALES };
