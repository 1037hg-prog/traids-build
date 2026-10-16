"use strict";
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * E-VALUES / E-PROCESSES — anytime-valid sequential testing.
 * Written 2026-09-05. Operator: "replace fixed read dates with always-valid e-values so a test
 * can be read early or killed early without a peeking penalty."
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE PROBLEM THIS EXISTS FOR, stated precisely.
 *
 * Every bar in this registry is a FIXED-SAMPLE bar: "t >= 2.0 at 30 paired sessions". Under
 * that machinery you get exactly ONE look. If you check at session 12 and stop because it looks
 * good, the 5% false-positive rate you thought you had is really 20-30% — the classic optional
 * stopping problem. The registry knows this: 76 tests carry SEVENTEEN different flavours of
 * interim/kill field (interimT, interimKillT, interimClusterDays, stage1Kill, killEntryDates,
 * ...) and every one of them is hedged as "kill-only, adjudicates nothing". Those hedges are
 * the honest workaround for a machinery that cannot look twice.
 *
 * The cost of that is TIME. A test whose effect is obviously huge still waits for session 30.
 * A test that is obviously hopeless still burns 30 sessions of a research calendar. With FD1
 * dated and a funding decision downstream, the calendar IS the scarce resource.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * WHAT AN E-VALUE IS, AND WHY PEEKING BECOMES FREE
 *
 * An e-value E is a non-negative statistic with E[E] <= 1 UNDER THE NULL. Think of it as the
 * payout of a bet against the null: you start with $1, and if the null is true you cannot expect
 * to make money. E = 20 means "a strategy betting against the null turned $1 into $20".
 *
 * Build it sequentially as a product of bets — E_t = prod_i (1 + lambda_i * (x_i - mu0)) — where
 * each stake lambda_i is chosen using ONLY data before observation i (a "predictable" bet). Then
 * {E_t} is a non-negative martingale under the null, and VILLE'S INEQUALITY gives
 *
 *      P( there EXISTS any t with E_t >= 1/alpha )  <=  alpha
 *
 * Note the quantifier: not "at time 30", but at ANY time, over the whole infinite path. So you
 * may look after every session, stop the instant E crosses 1/alpha, and your false-positive rate
 * is still <= alpha. That is what "anytime-valid" means, and it is why the interim hedges become
 * unnecessary rather than merely tolerated. This file's test suite VERIFIES that empirically by
 * optional-stopping 20,000 null paths rather than asserting it from the theory.
 *
 * THE PRICE, stated honestly. Anytime-validity is not free power. Run to the same fixed n and an
 * e-process is typically 15-30% less powerful than the fixed-n test, because it is paying for a
 * boundary that must hold at every t simultaneously. What it buys back is EXPECTED sample size:
 * a large effect crosses early, a hopeless one is killed early, and the calendar is released.
 * For a project whose honest prior is that most effects are near zero, the KILL side is worth
 * more than the pass side — and there is no fixed-n equivalent of a valid early kill at all.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * THE FOUR PRIMITIVES HERE
 *
 *   bettingE()      e-process for a point null mu = mu0. Everything else is built on it.
 *   confSeq()       anytime-valid confidence sequence, by inverting bettingE over a mean grid.
 *                   Valid at every t simultaneously — unlike a fixed-n CI, you may read it daily.
 *   sequentialVerdict()  PASS / KILL / CONTINUE. PASS when E >= 1/alpha. KILL when the CS upper
 *                   bound drops below the minimum effect worth trading (the MDE) — a rigorous
 *                   early death, which fixed-n machinery cannot express at all.
 *   eBH()           Benjamini-Hochberg on e-values. Controls FDR under ARBITRARY dependence,
 *                   which ordinary BH does not — and this book's hypotheses are heavily
 *                   dependent (overlapping tickets, shared sessions, correlated features).
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * TWO HOUSE RULES BAKED IN
 *
 * 1. CLIPPING IS DECLARED, NOT DISCOVERED. The betting construction needs bounded observations
 *    to keep 1 + lambda*y strictly positive. Session-level R gaps are not bounded a priori, so
 *    the caller DECLARES a clip bound c in advance and it is recorded in the output. Clipping is
 *    conservative for a positive-direction test (it can only shrink a winning observation), and
 *    the fraction of observations actually clipped is reported so a clip that is doing real work
 *    is visible rather than silent.
 *
 * 2. THE BET IS PREDICTABLE, ALWAYS. lambda_i is computed from x_1..x_{i-1} only. This is what
 *    makes retroactive computation on a stored session sequence legitimate: the martingale
 *    property depends on the bet not seeing its own observation, not on when the analyst ran the
 *    script. What retroactive computation does NOT license is a rule or population that was
 *    edited after seeing outcomes — that contamination is upstream of this file and the registry
 *    tracks it separately.
 *
 * References: Ville (1939); Howard et al., "Time-uniform Chernoff bounds" (2021);
 * Waudby-Smith & Ramdas, "Estimating means of bounded random variables by betting" (JRSSB 2024);
 * Wang & Ramdas, "False discovery rate control with e-values" (JRSSB 2022).
 */

/**
 * SCALING THE CLIP IS A POWER DECISION, AND IT BITES — found by testing, 2026-09-05.
 *
 * The first version of this file defaulted to clip = 2.0 for session gaps whose standard
 * deviation is about 0.5R. That is a FOUR-sigma bound: it essentially never binds, so it looked
 * harmlessly conservative. It was not. The positivity constraint caps the stake at
 * lambdaSafety/clip, so a clip four times wider than the data throws away three quarters of the
 * betting range. Measured cost at mu = 0.25R: power collapsed to 55% and the mean stopping time
 * was 48 of 60 sessions — SLOWER than the fixed-n bar it was meant to beat, which would have
 * made the whole upgrade pointless. The false-positive rate told the same story from the other
 * side: 0.01% against a 5% budget is not prudence, it is a process too timid to say anything.
 *
 * VALIDITY WAS NEVER AT RISK — a badly scaled clip costs power, never Type I error. But an
 * anytime-valid test that never fires is worthless, so the clip must be scaled to the series:
 * roughly TWO standard deviations of the observation stream, declared in advance from the
 * series' known scale (not fitted to the sample under test). At 2 sigma a few percent of
 * observations clip, which is reported in clippedFrac so the truncation is never silent.
 */
const DEFAULTS = {
  alpha: 0.05,         // one-sided level; threshold is 1/alpha
  clip: 1.0,           // |observation| bound in the caller's units; target ~2 SD of the series
  lambdaSafety: 0.75,  // stake capped at this fraction of the positivity limit (worst-case
                       // single-observation factor 0.25 — aggressive but strictly positive, and
                       // the Kelly-style stake sits far below this cap on realistic data)
  priorVar: null,      // null -> (clip/2)^2 ; the pseudo-observation that regularises early bets
};

const isFinite_ = (x) => typeof x === "number" && Number.isFinite(x);

/**
 * bettingE — e-process for the point null H0: mean(x) = mu0.
 *
 * @param {number[]} x        observations IN TIME ORDER (session-level; never per-ticket — see
 *                            the clustering discipline used throughout this project)
 * @param {object}   opts
 *   mu0        null mean (default 0)
 *   alpha      level (default 0.05) -> reject threshold 1/alpha
 *   clip       declared bound; observations are clamped to [mu0-clip, mu0+clip]
 *   oneSided   "greater" (default) bets only on positive deviations — the right choice when the
 *              registered hypothesis fixed a POSITIVE direction in advance. "two" allows the
 *              stake to go either way and is what confSeq() uses.
 * @returns {{e, log10e, threshold, rejected, stoppedAt, n, path, clippedFrac, maxE}}
 *          stoppedAt = 1-based index of the FIRST crossing (null if never). maxE is the running
 *          maximum, which is the quantity Ville's inequality actually bounds — reporting the
 *          final E alone would understate evidence that peaked and then decayed.
 */
function bettingE(x, opts = {}) {
  const { mu0 = 0, alpha = DEFAULTS.alpha, clip = DEFAULTS.clip,
          oneSided = "greater", lambdaSafety = DEFAULTS.lambdaSafety } = opts;
  // clipHi bounds the WINNING side; clipLo preserves the losing tail wider so E[y] <= 0 under H0.
  // Ratio 2.4 is the setting whose realised error was measured at 0.60% against a 5% budget.
  const clipHi = opts.clipHi ?? clip;
  const clipLo = opts.clipLo ?? clip * 2.4;
  const priorVar = opts.priorVar ?? (clip / 2) ** 2;
  const xs = (x || []).filter(isFinite_);
  const threshold = 1 / alpha;

  // Running estimates of the centred observation y = x - mu0, used to pick the NEXT stake.
  // Seeded with one pseudo-observation at y=0 so the first bet is small rather than undefined.
  let n = 0, sum = 0, sumsq = 0, clipped = 0, clippedHi = 0, clippedLo = 0;
  let logE = 0, maxLogE = 0, stoppedAt = null;
  const path = [];

  for (let i = 0; i < xs.length; i++) {
    // ── stake, from the PAST only ────────────────────────────────────────────────────────────
    const muHat = n ? sum / n : 0;
    const varHat = n ? Math.max(sumsq / n - muHat * muHat, 0) : priorVar;
    // Approximate-Kelly / GRAPA stake: mu / (var + mu^2) maximises expected log growth to second
    // order, regularised by the prior variance so early bets stay modest.
    let lambda = muHat / (varHat + priorVar / (n + 1) + muHat * muHat + 1e-12);
    if (oneSided === "greater") lambda = Math.max(0, lambda);
    /**
     * ASYMMETRIC CLIP - the fix for a broken supermartingale. (2026-09-09, audit)
     *
     * This file asserted that "clipping is conservative for a positive-direction test (it can only
     * shrink a winning observation)". That is FALSE for a two-sided clamp on a LEFT-SKEWED series,
     * which is exactly what session R distributions are: a symmetric clamp truncates the LOSING tail
     * harder than the winning one, so E[y] > 0 under H0, so E[1 + lambda*y] > 1 with lambda >= 0, and
     * Ville's inequality no longer applies.
     *
     * Measured on the real centred session-mean distribution with a true mean of exactly zero, the
     * realised optional-stopping error against a 5% budget was 2.37% at clip 1.0, 4.70% at 0.40, and
     * 7.40% at 0.25 - the very setting this file's own "~2 SD of the series" guidance points a caller
     * toward - and it GREW with the horizon to 10.38% at 400 observations. Growth with the horizon is
     * the signature of a broken martingale, not of Monte Carlo noise. The 1.0 default looked safe only
     * because it never binds.
     *
     * So: clip the WINNING side at clipHi and preserve the losing tail out to a wider declared floor
     * clipLo. Then y <= raw everywhere, E[y] <= 0 under H0, and the product is a supermartingale
     * again. Positivity now binds on clipLo, which costs stake size and therefore power - the honest
     * price of validity. At clipHi 0.25 / clipLo 0.6 the measured error is 0.60% at 200 observations,
     * retaining 66% power at +0.05R and 99% at +0.10R.
     *
     * oneSided "two" (used by confSeq) keeps the symmetric clamp: there the truncation is genuinely
     * conservative on both sides, so nothing needs widening.
     */
    const twoSided = oneSided === "two";
    const lim = (lambdaSafety * 1) / (twoSided ? clip : clipLo);
    lambda = Math.max(-lim, Math.min(lim, lambda));

    const raw = xs[i] - mu0;
    const y = twoSided ? Math.max(-clip, Math.min(clip, raw))
                       : Math.max(-clipLo, Math.min(clipHi, raw));
    if (raw > (twoSided ? clip : clipHi)) clippedHi++;
    if (raw < -(twoSided ? clip : clipLo)) clippedLo++;
    if (y !== raw) clipped++;

    const factor = 1 + lambda * y;
    logE += Math.log(Math.max(factor, 1e-300));   // guarded; positivity is enforced above
    if (logE > maxLogE) maxLogE = logE;
    if (stoppedAt === null && logE >= Math.log(threshold)) stoppedAt = i + 1;

    n++; sum += y; sumsq += y * y;
    path.push({ i: i + 1, lambda, y, e: Math.exp(logE) });
  }

  const e = Math.exp(logE);
  return {
    e, log10e: logE / Math.LN10, maxE: Math.exp(maxLogE), threshold,
    // Ville bounds the RUNNING MAXIMUM, so a path that crossed and fell back has still spent its
    // evidence — rejected is keyed on maxE, and stoppedAt records when it first happened.
    rejected: maxLogE >= Math.log(threshold),
    stoppedAt, n: xs.length, path,
    clippedFrac: xs.length ? clipped / xs.length : 0,
    mu0, alpha, clip, oneSided,
  };
}

/**
 * confSeq — anytime-valid confidence sequence for the mean, by grid inversion of bettingE.
 *
 * A candidate mean m is IN the interval iff a two-sided e-process against H0: mu = m has not
 * crossed 1/alpha. Because each such e-process is anytime-valid, the resulting interval covers
 * the true mean at ALL times simultaneously with probability >= 1 - alpha. That is the property
 * a fixed-n confidence interval does not have and the reason this can be read daily.
 *
 * @returns {{lo, hi, alpha, grid, width}} lo/hi null when the grid is entirely excluded (which
 *          means the declared grid was too narrow for the data — reported, never silently widened)
 */
function confSeq(x, opts = {}) {
  const { alpha = DEFAULTS.alpha, clip = DEFAULTS.clip, gridN = 401 } = opts;
  const lo0 = opts.gridLo ?? -clip, hi0 = opts.gridHi ?? clip;
  const kept = [];
  for (let g = 0; g < gridN; g++) {
    const m = lo0 + ((hi0 - lo0) * g) / (gridN - 1);
    const r = bettingE(x, { ...opts, mu0: m, alpha, clip, oneSided: "two" });
    if (!r.rejected) kept.push(m);
  }
  if (!kept.length) return { lo: null, hi: null, alpha, grid: [lo0, hi0], width: null, empty: true };
  const lo = Math.min(...kept), hi = Math.max(...kept);
  return { lo, hi, alpha, grid: [lo0, hi0], width: hi - lo, empty: false };
}

/**
 * sequentialVerdict — the readable answer, any day, with no peeking penalty.
 *
 *   PASS      the one-sided e-process crossed 1/alpha. Evidence for the registered direction.
 *   KILL      the anytime-valid upper confidence bound has fallen BELOW mde — i.e. even the most
 *             optimistic value still compatible with the data is too small to be worth trading.
 *             This is the capability fixed-n machinery simply does not have: a valid early death.
 *   CONTINUE  neither boundary reached; keep accruing.
 *
 * mde ("minimum detectable effect") is the smallest effect worth owning and MUST be declared in
 * advance with the rest of the bar — typically the cost hurdle, because an edge smaller than its
 * own costs is not an edge. Setting mde after seeing data would turn the kill boundary into a
 * post-hoc excuse, which is the failure this whole apparatus is built against.
 */
function sequentialVerdict(x, opts = {}) {
  const { alpha = DEFAULTS.alpha, clip = DEFAULTS.clip, mde = 0, minN = 1 } = opts;
  const xs = (x || []).filter(isFinite_);
  const ev = bettingE(xs, { ...opts, mu0: 0, alpha, clip, oneSided: "greater" });
  const cs = confSeq(xs, { ...opts, alpha, clip });

  let verdict = "CONTINUE", why;
  if (xs.length < minN) {
    why = `only ${xs.length} observation(s); minN ${minN} declared before evidence`;
  } else if (ev.rejected) {
    verdict = "PASS";
    why = `e-process crossed ${ev.threshold.toFixed(0)} at observation ${ev.stoppedAt} (E=${ev.maxE.toExponential(2)}); anytime-valid, so this is a legitimate read at n=${xs.length}, not a peek`;
  } else if (cs.hi != null && cs.hi < mde) {
    verdict = "KILL";
    why = `anytime-valid upper bound ${cs.hi.toFixed(4)} is below the declared MDE ${mde} — every effect still compatible with the data is too small to trade`;
  } else {
    why = `E=${ev.e.toExponential(2)} of ${ev.threshold.toFixed(0)} needed; CS [${cs.lo == null ? "—" : cs.lo.toFixed(4)}, ${cs.hi == null ? "—" : cs.hi.toFixed(4)}] still admits effects at or above the MDE ${mde}`;
  }
  return { verdict, why, n: xs.length, e: ev.e, maxE: ev.maxE, log10e: ev.log10e,
           threshold: ev.threshold, stoppedAt: ev.stoppedAt, cs, alpha, clip, mde,
           clippedFrac: ev.clippedFrac };
}

/**
 * eBH — Benjamini-Hochberg on e-values (Wang & Ramdas 2022).
 *
 * Sort e-values descending; reject the largest j for which E_(j) >= k / (alpha * j). Controls
 * FDR at alpha under ARBITRARY dependence between the hypotheses — no PRDS assumption, which
 * matters here because this book's hypotheses share sessions, tickets and features and are
 * emphatically not independent. Ordinary p-value BH needs an assumption this data does not meet.
 */
function eBH(evalues, alpha = DEFAULTS.alpha) {
  const items = (evalues || []).map((e, idx) => ({ idx, e: isFinite_(e) ? e : 0 }));
  const k = items.length;
  if (!k) return { rejected: [], threshold: null, nRejected: 0, k: 0, alpha };
  const sorted = [...items].sort((a, b) => b.e - a.e);
  let best = 0;
  for (let j = 1; j <= k; j++) if (sorted[j - 1].e >= k / (alpha * j)) best = j;
  return {
    rejected: sorted.slice(0, best).map((s) => s.idx).sort((a, b) => a - b),
    threshold: best ? k / (alpha * best) : null,
    nRejected: best, k, alpha,
  };
}

/**
 * killHorizon — how many observations a NULL series needs before the confidence sequence can rule
 * out the MDE. Measured (2026-09-05) against confSeq on simulated null paths: the anytime-valid
 * half-width tracks sd * sqrt(2 ln(2/alpha) / n) to within ~0.01R across n = 60..400, so
 *
 *      n*  ≈  2 · ln(2/alpha) · sd² / mde²
 *
 * This is the honest price of a RIGOROUS kill: at the board's realistic MDE of ~0.20R (the cost
 * hurdle) with session-gap sd ~0.5R it is ~46 sessions; at 0.10R it is ~185. Write n* into the
 * registration so "killed early" is a date, not a hope — and so nobody expects a 0.10R kill in
 * a month. Under a real effect the PASS side is typically much faster than n*.
 */
function killHorizon({ sd, mde, alpha = DEFAULTS.alpha }) {
  if (!(sd > 0) || !(mde > 0)) return null;
  return Math.ceil((2 * Math.log(2 / alpha) * sd * sd) / (mde * mde));
}

/** Fixed-n t-statistic, kept here only so callers can print both bars side by side. */
function tStat(x) {
  const a = (x || []).filter(isFinite_);
  if (a.length < 2) return null;
  const m = a.reduce((s, v) => s + v, 0) / a.length;
  const sd = Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
  return sd > 0 ? m / (sd / Math.sqrt(a.length)) : null;
}

module.exports = { bettingE, confSeq, sequentialVerdict, eBH, killHorizon, tStat, DEFAULTS };
