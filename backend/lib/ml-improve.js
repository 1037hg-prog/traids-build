/**
 * ML IMPROVE — the one change attempted per daily pass, graded as a SHADOW.
 *
 * ATTEMPT #1 (2026-08-25): AN EQUITY-ONLY FIT, SO THE STRUCTURAL DIALS ARE ACTUALLY IN THE MODEL.
 *
 * The standing bake-off (backend/model-bakeoff.js) pools Equity, Crypto, Futures and FX into one
 * design matrix and then keeps only features present on ≥30% of rows. That bar is applied to the
 * POOLED denominator, and the pooled denominator is 56% instruments for which the structural
 * observers cannot exist. Short interest, dark-pool share, insider filings, earnings dates and
 * single-name option skew are not MISSING for BTC — they are undefined. Averaging a defined
 * observer over undefined rows manufactures a coverage failure that no amount of plumbing can fix.
 *
 * Measured on the canonical ledger, 2026-08-25:
 *     observer        equity rows      all rows      30% bar on equity
 *     svrZ               88.6%          39.2%              PASS
 *     shortPct           86.6%          38.3%              PASS
 *     atsPct             49.8%          22.1%              PASS
 *     newsScore          37.8%          16.7%              PASS
 * Four dials that the pooled fit discards are available the moment the fit is restricted to the
 * class they describe. This attempt asks whether they carry anything.
 *
 * WHAT THIS IS NOT. It is not a claim that an equity-only model is better. It is a shadow: fitted
 * walk-forward, scored out-of-sample, graded against labels shuffled within sessions, and compared
 * against the pooled model restricted to the SAME equity rows so the comparison is like for like.
 * It never touches the live board, and it never enforces anything.
 *
 * THE BAR IS FIXED HERE, IN CODE, BEFORE THE EVIDENCE IS READ. All three must hold:
 *   (a) within-day permutation p < 0.05 on the day-clustered correlation
 *   (b) the top-half-by-prediction equity book beats the whole equity book on mean R
 *   (c) at least 10 scored sessions
 * Two of three is not a pass. If it passes, it becomes a PROPOSAL in alpha-hunt-queue.json for the
 * operator to register — not a registered test, and not a change to the board.
 */
const BAR = {
  permutationP: 0.05,
  topHalfMustBeatBookMeanR: true,
  minScoredSessions: 10,
  fixedAt: "2026-08-25, before any result was computed",
  statedAs: "all three, jointly. Two of three is a fail.",
};

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(4));
const r2 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(2));
const corr = (a, b) => {
  const n = a.length; if (n < 3) return null;
  const ma = mean(a), mb = mean(b);
  let s = 0, sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; }
  return sa && sb ? s / Math.sqrt(sa * sb) : null;
};

/** day-clustered mean correlation and its t. The unit is the SESSION; n rides along, always. */
function dayCorr(p, labels, byDay) {
  const cs = [];
  for (const ids of Object.values(byDay)) {
    if (ids.length < 5) continue;                        // a 2-ticket session cannot carry a correlation
    const c = corr(ids.map((i) => p[i]), ids.map((i) => labels[i]));
    if (c != null) cs.push(c);
  }
  if (cs.length < 2) return { t: null, n: cs.length, mean: null };
  const s = sd(cs), se = s / Math.sqrt(cs.length);
  return { t: se > 0 ? mean(cs) / se : null, n: cs.length, mean: mean(cs) };
}

/**
 * @param rows      model-eligible rows (already filtered to clean era, obs present, non-Options)
 * @param et        ms -> ET calendar day
 * @param L2        lib/gbm.js
 * @param pooledPred  the pooled model's out-of-sample predictions, indexed like `rows`, so the
 *                    equity-only fit can be compared against it on the identical row subset
 */
function equityStructuralShadow(rows, et, L2, pooledPred) {
  const EXCLUDE = /^(modelScore|modelRank|wComposite|bakeoff)/;
  const idxEq = rows.map((_, i) => i).filter((i) => rows[i].cls === "Equity");
  const eq = idxEq.map((i) => rows[i]);
  if (eq.length < 200) return { attempted: false, reason: `only ${eq.length} equity model rows — below the 200 needed to fit anything` };

  // coverage bar re-applied on the EQUITY denominator, which is the whole point of the attempt
  const cov = {};
  for (const t of eq) for (const [k, v] of Object.entries(t.obs)) if (Number.isFinite(v) && !EXCLUDE.test(k)) cov[k] = (cov[k] || 0) + 1;
  const FEATS = Object.entries(cov).filter(([, n]) => n >= eq.length * 0.30).map(([k]) => k).sort();
  const STRUCTURAL = ["svrZ", "shortPct", "atsPct", "newsScore", "insiderNet90", "erDays", "skewRR", "insiderXP"];
  const structuralIn = STRUCTURAL.filter((k) => FEATS.includes(k));
  // the pooled fit's feature set, for the diff that motivates this whole attempt
  const covPooled = {};
  for (const t of rows) for (const [k, v] of Object.entries(t.obs)) if (Number.isFinite(v) && !EXCLUDE.test(k)) covPooled[k] = (covPooled[k] || 0) + 1;
  const POOLED_FEATS = Object.entries(covPooled).filter(([, n]) => n >= rows.length * 0.30).map(([k]) => k).sort();
  const gained = FEATS.filter((k) => !POOLED_FEATS.includes(k));

  const vec = (t) => [...FEATS.map((k) => (Number.isFinite(t.obs[k]) ? t.obs[k] : NaN)), t.dir > 0 ? 1 : -1, t.ctrl ? 1 : 0];
  const X = eq.map(vec), y = eq.map((t) => t.rMult), day = eq.map((t) => et(t.openedAt));
  const sessions = [...new Set(day)].sort(), sIdx = Object.fromEntries(sessions.map((s, i) => [s, i]));
  const PURGE = 1, MIN_TRAIN = 8;

  const pred = new Array(eq.length).fill(null);
  let folds = 0;
  for (let k = MIN_TRAIN; k < sessions.length; k++) {
    const train = eq.map((_, i) => i).filter((i) => sIdx[day[i]] <= k - 1 - PURGE);
    const test = eq.map((_, i) => i).filter((i) => sIdx[day[i]] === k);
    if (train.length < 100 || !test.length) continue;
    // ridge only: the GBM needs more rows per fold than an equity-only slice provides, and fitting
    // two learners here would need a best-of-2 correction on top of the permutation null
    const rm = L2.ridgeFit(X, y, train);
    for (const i of test) pred[i] = L2.ridgePredict(rm, X[i]);
    folds++;
  }
  const scored = eq.map((_, i) => i).filter((i) => pred[i] != null);
  if (scored.length < 50) return { attempted: true, cleared: false, reason: `only ${scored.length} out-of-sample equity predictions`, features: FEATS.length, structuralIn, gained };

  const byDay = {}; for (const i of scored) (byDay[day[i]] ||= []).push(i);
  const real = dayCorr(pred, y, byDay);

  // ── within-day permutation null, deterministic seed so the bar does not drift between runs ──
  let seed = 20260825, ge = 0; const nullTs = [];
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let tr = 0; tr < 400; tr++) {
    const sh = y.slice();
    for (const ids of Object.values(byDay)) {
      const vals = ids.map((i) => y[i]);
      for (let i = vals.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [vals[i], vals[j]] = [vals[j], vals[i]]; }
      ids.forEach((i, k2) => { sh[i] = vals[k2]; });
    }
    const nt = dayCorr(pred, sh, byDay).t;
    if (nt != null) { nullTs.push(nt); if (Math.abs(nt) >= Math.abs(real.t ?? 0)) ge++; }
  }
  const pval = nullTs.length ? (ge + 1) / (nullTs.length + 1) : null;

  // ── the shadow book: what would taking only the top half by prediction have produced? ──
  // Selection is WITHIN each session, so the rule is one a live board could actually run — it never
  // needs tomorrow's cross-section to decide today's trade.
  const keep = new Set();
  for (const ids of Object.values(byDay)) {
    const ord = [...ids].sort((a, b) => pred[b] - pred[a]);
    for (const i of ord.slice(0, Math.max(1, Math.floor(ord.length / 2)))) keep.add(i);
  }
  const bookR = scored.map((i) => y[i]);
  const topR = [...keep].map((i) => y[i]);
  const winPct = (a) => (a.length ? (a.filter((x) => x > 0).length / a.length) * 100 : null);
  // per-session difference (top half minus that session's whole book) — the honest unit again
  const perSessDiff = Object.values(byDay).map((ids) => {
    const k2 = ids.filter((i) => keep.has(i));
    return k2.length && ids.length ? mean(k2.map((i) => y[i])) - mean(ids.map((i) => y[i])) : null;
  }).filter(Number.isFinite);
  const dsd = sd(perSessDiff), dse = dsd != null ? dsd / Math.sqrt(perSessDiff.length) : null;

  const shadow = {
    bookTickets: scored.length, bookMeanR: r4(mean(bookR)), bookWinPct: r2(winPct(bookR)),
    topHalfTickets: keep.size, topHalfMeanR: r4(mean(topR)), topHalfWinPct: r2(winPct(topR)),
    meanRLift: r4(mean(topR) - mean(bookR)), winPctLift: r2(winPct(topR) - winPct(bookR)),
    liftPerSessionMean: r4(mean(perSessDiff)), liftPerSessionSe: r4(dse),
    liftT: dse > 0 ? r2(mean(perSessDiff) / dse) : null, liftSessions: perSessDiff.length,
  };

  const conds = {
    a_permutationP: { need: `< ${BAR.permutationP}`, got: r4(pval), pass: pval != null && pval < BAR.permutationP },
    b_topHalfBeatsBook: { need: "> 0", got: shadow.meanRLift, pass: Number.isFinite(shadow.meanRLift) && shadow.meanRLift > 0 },
    c_scoredSessions: { need: `>= ${BAR.minScoredSessions}`, got: real.n, pass: real.n >= BAR.minScoredSessions },
  };
  const cleared = Object.values(conds).every((c) => c.pass);

  return {
    attempted: true, id: "MLI-1-equity-structural-ridge", bar: BAR, cleared, conditions: conds,
    equityRows: eq.length, sessions: sessions.length, folds,
    features: FEATS.length, structuralInModel: structuralIn,
    featuresGainedVsPooled: gained,
    pooledFeatureCount: POOLED_FEATS.length,
    dayCorrMean: r4(real.mean), dayCorrT: r2(real.t), scoredSessions: real.n,
    permutationP: r4(pval), nullAbsT95: nullTs.length ? r2(Math.abs(nullTs.sort((a, b) => a - b)[Math.floor(nullTs.length * 0.975)])) : null,
    shadow,
    // the pooled model on the identical rows, so "equity-only helped" is a comparison and not a vibe
    pooledOnSameRows: (() => {
      if (!pooledPred) return null;
      const pp = scored.map((i) => pooledPred[idxEq[i]]).map((v) => (v == null ? NaN : v));
      const ok = scored.filter((_, k2) => Number.isFinite(pp[k2]));
      if (ok.length < 50) return { note: "pooled model scored too few of the same rows to compare" };
      const bd = {}; scored.forEach((i, k2) => { if (Number.isFinite(pp[k2])) (bd[day[i]] ||= []).push(k2); });
      const pv = {}; scored.forEach((i, k2) => { pv[k2] = pp[k2]; });
      const yv = {}; scored.forEach((i, k2) => { yv[k2] = y[i]; });
      const dc = dayCorr(pv, yv, bd);
      return { dayCorrT: r2(dc.t), dayCorrMean: r4(dc.mean), scoredSessions: dc.n };
    })(),
    read: cleared
      ? `CLEARS the pre-set bar — proposal written to alpha-hunt-queue.json for the operator to register. Not enforced, not registered, and one clean-era sample is a MOTIVATING SAMPLE, not a validated edge.`
      : `DOES NOT clear. ${Object.entries(conds).filter(([, c]) => !c.pass).map(([k]) => k).join(", ")} failed. Recorded so the attempt is not silently repeated.`,
  };
}

module.exports = { equityStructuralShadow, BAR };
