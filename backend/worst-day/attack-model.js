#!/usr/bin/env node
"use strict";
/**
 * WORST-DAY ATTACK, part 1: the predictor itself. Read-only; writes backend/data/worst-day/attack-model.json (atomic).
 *   node backend/worst-day/attack-model.js
 * (1) scrambled target (within year, within month, global; fit-on-scrambled/test-on-real)   (2) inputs shifted one day later / earlier
 * (4) threshold causality   (5) refit boundary: scramble everything dated in the predicted year or later and compare the fitted models
 * (6) volatility clustering: one-line rules, leave-one-feature-out, paired against them
 * Every run uses run.js's folds, labels, learners and defaults (wf.js reproduces run.js's headline to the digit before any attack).
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const L = require("./lib.js"), DS = require("./dataset.js"), W = require("./wf.js");
const OUT = path.join(__dirname, "..", "data", "worst-day", "attack-model.json");
const r2 = (x) => (Number.isFinite(x) ? +x.toFixed(2) : null), r3 = (x) => (Number.isFinite(x) ? +x.toFixed(3) : null);
const t0 = Date.now(), log = (...a) => console.log(...a);
const ctx = W.makeCtx(), { D, K, O } = ctx, Yreal = W.labelsO(ctx, D.y), YB = Int8Array.from(O, (i) => D.yb[i]);
const out = { spec: "worst-day-attack-model-v1", asOf: new Date().toISOString(), command: "node backend/worst-day/attack-model.js", status: "IN-SAMPLE / WALK-FORWARD EXPLORATORY attack on backend/worst-day" };
const stat = (a) => { const m = L.mean(a), s = L.sd(a); return { mean: r2(m), sd: r2(s), min: r2(Math.min(...a)), max: r2(Math.max(...a)), n: a.length }; };

// ── 0. reproduce ───────────────────────────────────────────────────────────────────────────────────────────────────
const base = W.walk(ctx, D.X, ctx.yArr);
const baseEval = {}; for (const m of ["b", "c", "v"]) { const e = W.evalScore(ctx, base.scoreO[m], Yreal); baseEval[m] = { share: r2(e.share), hit: r2(e.hit), auc: r3(e.auc) }; }
out.reproduction = { note: "wf.js reproduces run.js: logistic 37.13/18.43, boosted 33.46/16.61, vol alone 34.19/16.97", ...baseEval };
log("0. reproduction", JSON.stringify(baseEval));

// ── 1. scrambled target ────────────────────────────────────────────────────────────────────────────────────────────
function shuffled(groupKey, seed) {
  const rng = W.mulberry(seed), y2 = Float64Array.from(ctx.yArr), groups = new Map();
  for (const i of ctx.valid) { const k = groupKey(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); }
  for (const idxs of groups.values()) { const v = idxs.map((i) => ctx.yArr[i]); for (let j = v.length - 1; j > 0; j--) { const m = Math.floor(rng() * (j + 1)); [v[j], v[m]] = [v[m], v[j]]; } idxs.forEach((i, j) => (y2[i] = v[j])); }
  return y2;
}
const keyYear = (i) => ctx.tYear(i), keyMonth = (i) => D.d[i + 1].slice(0, 7), keyAll = () => "all";
const SEEDS = 30, GSEEDS = 8;
const scr = {};
for (const [lab, key] of [["withinYear", keyYear], ["withinMonth", keyMonth], ["global", keyAll]]) {
  const A = { b: [], v: [], bHit: [], bAuc: [] }, B = { b: [], bAuc: [] }, G = { c: [], cHit: [] };
  for (let s = 0; s < SEEDS; s++) {
    const y2 = shuffled(key, 1000 + s), Y2 = W.labelsO(ctx, y2);
    const r = W.walk(ctx, D.X, y2, { gbm: false });
    const eb = W.evalScore(ctx, r.scoreO.b, Y2), ev = W.evalScore(ctx, r.scoreO.v, Y2);       // A: everything scrambled, scored on scrambled test labels
    A.b.push(eb.share); A.v.push(ev.share); A.bHit.push(eb.hit); A.bAuc.push(eb.auc);
    const eb2 = W.evalScore(ctx, r.scoreO.b, Yreal); B.b.push(eb2.share); B.bAuc.push(eb2.auc);   // B: trained on scrambled labels, scored on the REAL labels
    if (s < GSEEDS) { const g = W.walk(ctx, D.X, y2, { logit: false }); const ec = W.evalScore(ctx, g.scoreO.c, Y2); G.c.push(ec.share); G.cHit.push(ec.hit); }
  }
  scr[lab] = { seeds: SEEDS, A_scrambledTrainAndTest_logisticShare: stat(A.b), A_logisticHit: stat(A.bHit), A_logisticAuc: { mean: r3(L.mean(A.bAuc)) }, A_volAloneShare: stat(A.v),
    B_trainScrambled_testReal_logisticShare: stat(B.b), B_logisticAuc: { mean: r3(L.mean(B.bAuc)) }, A_boostedShare_8seeds: stat(G.c), A_boostedHit_8seeds: stat(G.cHit) };
  log("1.", lab, JSON.stringify(scr[lab].A_scrambledTrainAndTest_logisticShare), "vol", JSON.stringify(scr[lab].A_volAloneShare), "| train-scr/test-real", JSON.stringify(scr[lab].B_trainScrambled_testReal_logisticShare), "| boosted", JSON.stringify(scr[lab].A_boostedShare_8seeds));
}
out.scrambledTarget = { expectation: "about 10% (no skill) when the target is unrelated to the inputs", ...scr };
// what share of days would a flag pick up by chance, per year: the expected capture of a year-level-only signal (oracle for 'which years are stormy')
{
  const byYear = new Map(); for (let k = 0; k < K; k++) { const y = ctx.tYear(O[k]); const o = byYear.get(y) || { n: 0, w: 0 }; o.n++; o.w += Yreal[k]; byYear.set(y, o); }
  const sc = Float64Array.from(O, (i) => { const o = byYear.get(ctx.tYear(i)); return o.w / o.n + 1e-9 * Math.sin(i); });     // score = the realised worst-day rate of the target's own year (an oracle for year-level storminess)
  const e = W.evalScore(ctx, sc, Yreal); out.yearLevelOracle = { what: "flag the 10% of days that sit in the years with the highest realised worst-day rate (oracle on the year, nothing on the day)", share: r2(e.share), hit: r2(e.hit) };
  log("1. year-level oracle (flag by the year's own realised rate)", JSON.stringify(out.yearLevelOracle));
}

// ── 2. shifted inputs ──────────────────────────────────────────────────────────────────────────────────────────────
const NF = D.FEATURES.length, nanRow = () => new Array(NF).fill(NaN);
const shiftedX = (s) => D.X.map((_, i) => (D.X[i + s] ? D.X[i + s] : nanRow()));
out.shift = { definition: "row i of the feature matrix is replaced by row i+s (s=+1: inputs from the NEXT day, i.e. the target day's own close; s=-1: inputs one day stale). Same labels, same folds, same learners.", rows: {} };
for (const s of [1, 0, -1, -2, -5]) {
  const Xs = shiftedX(s), r = W.walk(ctx, Xs, ctx.yArr), row = {};
  for (const m of ["b", "c", "v"]) { const e = W.evalScore(ctx, r.scoreO[m], Yreal); row[m] = { share: r2(e.share), hit: r2(e.hit), auc: r3(e.auc) }; }
  // rule (a) shifted
  const fa = Uint8Array.from(O, (i) => (D.flagA[i + s] === 1 ? 1 : 0)); let Fc = 0, Cc = 0, Wc = 0; for (let k = 0; k < K; k++) { if (Yreal[k]) Wc++; if (fa[k]) { Fc++; if (Yreal[k]) Cc++; } }
  row.ruleA = { share: r2(100 * Cc / Wc), hit: r2(100 * Cc / Fc), flaggedPct: r2(100 * Fc / K) };
  out.shift.rows[s] = row; log("2. shift", s, JSON.stringify(row));
}

// ── 4/5. thresholds and refit boundary ─────────────────────────────────────────────────────────────────────────────
{
  // 4. label threshold: recomputed with plain loops, and shown independent of the future by scrambling the series after a date
  let bad = 0, checked = 0; const T = "2012-06-29", P = DS.build({ perturbAfter: T });
  for (let i = DS.WIN; i < D.n - 1; i++) { const w = []; for (let k = i - 1259; k <= i; k++) w.push(D.r[k]); w.sort((a, b) => a - b); const thr = w[62]; checked++; if (Math.abs(thr - D.thr[i]) > 1e-15) bad++; if (D.y[i] !== (D.r[i + 1] <= thr ? 1 : 0)) bad++; }
  let movedBefore = 0, movedAfter = 0; for (let i = DS.WIN; i < D.n - 1; i++) { const changed = D.thr[i] !== P.thr[i] || D.y[i] !== P.y[i]; if (D.d[i + 1] <= T) { if (changed) movedBefore++; } else if (changed) movedAfter++; }
  out.labelThreshold = { rowsRecomputedByPlainLoops: checked, mismatches: bad, scrambledAfter: T, labelRowsWithTargetOnOrBeforeThatMovedWhenFutureScrambled: movedBefore, labelRowsAfterThatMoved: movedAfter };
  log("4. label threshold: mismatches", bad, "of", checked, "| moved when the future is scrambled (should be 0):", movedBefore, "| rows after that moved:", movedAfter);
  // pooled top-decile cut vs the causal cut
  const pooled = {}; for (const m of ["b", "c", "v"]) { const sc = base.scoreO[m], cut = L.qHigh(Array.from(sc), 0.10); const perYearCut = {}; pooled[m] = { pooledOosCutoff: +cut.toPrecision(5), note: "headline top-decile uses ONE cutoff taken over all 5,477 out-of-sample scores (it sees the future distribution); the causal cutoff is each January's in-sample training quantile" }; }
  out.poolingNote = pooled;
}
{
  // 5. refit boundary: scramble EVERY series from Jan 1 of the predicted year on; the model that predicts that year must not move
  const res = [];
  for (const Y of [2008, 2015, 2020, 2026]) {
    const Pd = DS.build({ perturbAfter: `${Y - 1}-12-31` }), Pc = W.makeCtx(Pd);
    const train = ctx.valid.filter((i) => ctx.tYear(i) < Y);
    const m1 = L.logitFit(D.X, ctx.yArr, train), m2 = L.logitFit(Pd.X, Pc.yArr, train);
    const g1 = require("../lib/gbm.js").gbmFit(D.X, ctx.yArr, train, { rounds: 80, lr: 0.1, depth: 2 }), g2 = require("../lib/gbm.js").gbmFit(Pd.X, Pc.yArr, train, { rounds: 80, lr: 0.1, depth: 2 });
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const testMoved = ctx.valid.filter((i) => ctx.tYear(i) === Y).some((i) => D.X[i][1] !== Pd.X[i][1]);
    res.push({ predictedYear: Y, trainRows: train.length, lastTrainTarget: D.d[Math.max(...train) + 1], logisticWeightsIdentical: same(m1.w, m2.w) && same(m1.mu, m2.mu) && same(m1.sg, m2.sg), boostedTreesIdentical: same(g1, g2), testRowFeaturesDidMove: testMoved });
    log("5. refit", Y, JSON.stringify(res[res.length - 1]));
  }
  out.refitBoundary = { what: "every price/VIX/credit/sector series scrambled (+-25%) from Jan 1 of the predicted year on; the model fitted to predict that year is compared byte for byte with the unscrambled one", years: res };
}

// ── 6. volatility clustering: one-line rules, simple predictors, ablations ─────────────────────────────────────────
const absR = new Float64Array(D.n).fill(NaN); for (let i = 1; i < D.n; i++) absR[i] = Math.abs(D.r[i]);
const ewma = new Float64Array(D.n).fill(NaN); { let v = NaN; for (let i = 1; i < D.n; i++) { v = Number.isFinite(v) ? 0.94 * v + 0.06 * D.r[i] ** 2 : D.r[i] ** 2; ewma[i] = Math.sqrt(v * 252) * 100; } }
const vixPrev = Float64Array.from(D.X, (x) => x[7]);
const simple = {
  absRet1: Float64Array.from(O, (i) => absR[i]),
  retDown: Float64Array.from(O, (i) => -D.r[i]),
  rv5: Float64Array.from(O, (i) => D.rv5[i]), rv20: Float64Array.from(O, (i) => D.rv20[i]), rv60: Float64Array.from(O, (i) => D.rv60[i]),
  ewma94: Float64Array.from(O, (i) => ewma[i]), vixPrev: Float64Array.from(O, (i) => vixPrev[i]),
};
// causal 'yesterday's absolute return in its top decile' flag: |r_t| >= 90th percentile of |r| over the 1,260 sessions ending at t
const flagAbsCausal = Uint8Array.from(O, (i) => { const w = []; for (let k = i - 1259; k <= i; k++) w.push(absR[k]); return absR[i] >= L.qHigh(w, 0.10) ? 1 : 0; });
const flagDownCausal = Uint8Array.from(O, (i) => (D.r[i] <= D.thr[i] ? 1 : 0));          // yesterday was itself a worst day
const cnt = (flag, Yv = Yreal) => { let Fc = 0, Cc = 0, Wc = 0; for (let k = 0; k < K; k++) { if (Yv[k]) Wc++; if (flag[k]) { Fc++; if (Yv[k]) Cc++; } } return { flaggedPct: r2(100 * Fc / K), share: r2(100 * Cc / Wc), hit: r2(100 * Cc / Fc), bestShare: null }; };
const years = [...new Set(O.map((i) => ctx.tYear(i)))], yrOf = O.map((i) => ctx.tYear(i));
function pairedBoot(fa, fb, seed, B = 2000) {      // share-caught difference fa - fb, years resampled with replacement
  const per = years.map((y) => { let Wc = 0, Ca = 0, Cb = 0; for (let k = 0; k < K; k++) if (yrOf[k] === y) { if (Yreal[k]) { Wc++; if (fa[k]) Ca++; if (fb[k]) Cb++; } } return { Wc, Ca, Cb }; });
  const rng = W.mulberry(seed), d = []; for (let b = 0; b < B; b++) { let Wc = 0, Ca = 0, Cb = 0; for (let j = 0; j < years.length; j++) { const p = per[Math.floor(rng() * years.length)]; Wc += p.Wc; Ca += p.Ca; Cb += p.Cb; } if (Wc) d.push(100 * (Ca - Cb) / Wc); }
  d.sort((x, y) => x - y); let Wt = 0, Ct = 0, Cu = 0; for (let k = 0; k < K; k++) if (Yreal[k]) { Wt++; if (fa[k]) Ct++; if (fb[k]) Cu++; }
  return { point: r2(100 * (Ct - Cu) / Wt), ci90: [r2(d[Math.floor(0.05 * (d.length - 1))]), r2(d[Math.floor(0.95 * (d.length - 1))])], shareOfBootstrapsAboveZero: r2(100 * d.filter((x) => x > 0).length / d.length) };
}
const six = { note: "all flags at the pooled top 10% of days unless stated; the two 'causal' rows use a past-only cutoff", simpleScores: {} };
for (const [k, sc] of Object.entries(simple)) { const e = W.evalScore(ctx, sc, Yreal); six.simpleScores[k] = { share: r2(e.share), hit: r2(e.hit), auc: r3(e.auc) }; }
six.logisticTop10 = { share: baseEval.b.share, hit: baseEval.b.hit, auc: baseEval.b.auc };
six.boostedTop10 = { share: baseEval.c.share, hit: baseEval.c.hit, auc: baseEval.c.auc };
six.oneLineRuleCausal_yesterdayAbsReturnTopDecile = cnt(flagAbsCausal);
six.oneLineRuleCausal_yesterdayWasItselfAWorstDay = cnt(flagDownCausal);
const fLog = W.evalScore(ctx, base.scoreO.b, Yreal).flag, fAbs = W.evalScore(ctx, simple.absRet1, Yreal).flag, fVol = W.evalScore(ctx, simple.rv20, Yreal).flag, fEw = W.evalScore(ctx, simple.ewma94, Yreal).flag, fVix = W.evalScore(ctx, simple.vixPrev, Yreal).flag;
six.pairedLogisticMinus = { absRetTop10Pooled: pairedBoot(fLog, fAbs, 11), absRetCausal: pairedBoot(fLog, flagAbsCausal, 12), rv20: pairedBoot(fLog, fVol, 13), ewma94: pairedBoot(fLog, fEw, 14), vixPrev: pairedBoot(fLog, fVix, 15) };
// at the flagged share of rule (a) (15.7%)
{ const shareA = Math.round(0.1572 * K) / K, res = {}; for (const [k, sc] of Object.entries({ logistic: base.scoreO.b, boosted: base.scoreO.c, ...simple })) { const e = W.evalScore(ctx, sc, Yreal, shareA); res[k] = { share: r2(e.share), hit: r2(e.hit) }; } six.atRuleAFlaggedShare15p7 = res; }
out.volatilityClustering = six;
log("6. simple scores", JSON.stringify(six.simpleScores));
log("6. causal |r| top-decile rule", JSON.stringify(six.oneLineRuleCausal_yesterdayAbsReturnTopDecile), "| yesterday a worst day", JSON.stringify(six.oneLineRuleCausal_yesterdayWasItselfAWorstDay));
log("6. paired logistic minus", JSON.stringify(six.pairedLogisticMinus));
log("6. at 15.7% flagged", JSON.stringify(six.atRuleAFlaggedShare15p7));

// ablations (logistic, nothing else changes)
{
  const names = D.FEATURES, res = {}, run = (drop) => { const keep = names.map((_, f) => f).filter((f) => !drop.includes(f)); const Xk = D.X.map((row) => keep.map((f) => row[f])); const r = W.walk(ctx, Xk, ctx.yArr, { gbm: false, volCol: Math.max(0, keep.indexOf(1)) }); const e = W.evalScore(ctx, r.scoreO.b, Yreal); return { share: r2(e.share), hit: r2(e.hit), auc: r3(e.auc) }; };
  res.all15 = run([]);
  names.forEach((nm, f) => { res["without_" + nm] = run([f]); });
  res.withoutAllVix = run([7, 8, 9]); res.withoutCalendar = run([12, 13, 14]); res.withoutCreditBreadth = run([10, 11]); res.withoutVixCreditBreadthCalendar = run([7, 8, 9, 10, 11, 12, 13, 14]);
  res.volOnlyBlock_rv5_rv20_rv60_ret1_ret5 = run([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  res.priceOnly_noVix_noCredit_noBreadth_noCal = run([7, 8, 9, 10, 11, 12, 13, 14]);
  out.ablation = res; for (const [k, v] of Object.entries(res)) log("abl", k.padEnd(40), JSON.stringify(v));
}

out.elapsedSec = r2((Date.now() - t0) / 1000);
writeJsonAtomic(OUT, out);
log("wrote", OUT, "elapsed", out.elapsedSec);
