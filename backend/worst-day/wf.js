"use strict";
/**
 * WORST-DAY ATTACK, shared walk-forward harness. A line-for-line reuse of run.js's walk (same labels, same folds, same learners, same
 * defaults) with the feature matrix and the training labels passed in, so each attack changes exactly one thing. Read-only; no network.
 * Check: walk(ctx, ctx.D.X, ctx.yArr) must reproduce run.js's pooled top-decile numbers (37.13 / 18.43 logistic, 34.19 / 16.97 vol alone).
 */
const L = require("./lib.js"), DS = require("./dataset.js");
const { gbmFit, gbmPredict } = require("../lib/gbm.js");

function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function makeCtx(D = DS.build()) {
  const n = D.n, WIN = DS.WIN, Y0 = 2005, Y1 = 2026;
  const tYear = (i) => +D.d[i + 1].slice(0, 4);
  const valid = []; for (let i = WIN; i < n - 1; i++) if (D.y[i] >= 0) valid.push(i);
  const yArr = Float64Array.from(D.y, (v) => (v >= 0 ? v : 0));
  const O = valid.filter((i) => tYear(i) >= Y0 && tYear(i) <= Y1);
  return { D, n, WIN, Y0, Y1, tYear, valid, yArr, O, K: O.length };
}

/** X = feature matrix (rows indexed like D), yTrain = label vector used for FITTING (indexed like D). Returns scores aligned with ctx.O. */
function walk(ctx, X, yTrain, { gbm = true, logit = true, volCol = 1, lambda = 10 } = {}) {
  const { valid, tYear, O, Y0, Y1, D } = ctx, S = { b: new Float64Array(ctx.n).fill(NaN), c: new Float64Array(ctx.n).fill(NaN), v: new Float64Array(ctx.n).fill(NaN) };
  const THR = { b: {}, c: {}, v: {} }, fit = [];
  for (let Y = Y0; Y <= Y1; Y++) {
    const train = valid.filter((i) => tYear(i) < Y), test = valid.filter((i) => tYear(i) === Y);
    if (!test.length) continue;
    if (!(D.d[Math.max(...train) + 1] < `${Y}-01-01`)) throw new Error(`LEAK: ${Y}`);
    let mb = null, mg = null;
    if (logit) mb = L.logitFit(X, yTrain, train, { lambda });
    if (gbm) mg = gbmFit(X, yTrain, train, { rounds: 80, lr: 0.1, depth: 2 });
    if (logit) THR.b[Y] = L.qHigh(train.map((i) => L.logitPredict(mb, X[i])), 0.10);
    if (gbm) THR.c[Y] = L.qHigh(train.map((i) => gbmPredict(mg, X[i])), 0.10);
    THR.v[Y] = L.qHigh(train.map((i) => X[i][volCol]), 0.10);
    for (const i of test) { if (logit) S.b[i] = L.logitPredict(mb, X[i]); if (gbm) S.c[i] = gbmPredict(mg, X[i]); S.v[i] = X[i][volCol]; }
    fit.push({ Y, mb, mg, nTrain: train.length });
  }
  const pick = (a) => Float64Array.from(O, (i) => a[i]);
  return { scoreO: { b: pick(S.b), c: pick(S.c), v: pick(S.v) }, THR, fit };
}

/** capture statistics of a score vector aligned with ctx.O against labels Yv (Int8Array aligned with ctx.O) */
function evalScore(ctx, score, Yv, share = 0.10) {
  const K = ctx.K, allK = [...Array(K).keys()], ord = allK.slice().sort((a, b) => score[b] - score[a]), f = new Uint8Array(K);
  for (let j = 0; j < Math.ceil(share * K); j++) f[ord[j]] = 1;
  let W = 0, F = 0, C = 0; for (let k = 0; k < K; k++) { if (Yv[k]) W++; if (f[k]) { F++; if (Yv[k]) C++; } }
  // AUC by rank sum (ties averaged)
  const asc = allK.slice().sort((a, b) => score[a] - score[b]); let rs = 0, j = 0;
  while (j < K) { let e = j; while (e + 1 < K && score[asc[e + 1]] === score[asc[j]]) e++; const rank = (j + e) / 2 + 1; for (let m = j; m <= e; m++) if (Yv[asc[m]]) rs += rank; j = e + 1; }
  const auc = (rs - W * (W + 1) / 2) / (W * (K - W));
  return { flag: f, W, F, C, share: 100 * C / W, hit: 100 * C / F, auc };
}
const labelsO = (ctx, yvec) => Int8Array.from(ctx.O, (i) => yvec[i]);

module.exports = { mulberry, makeCtx, walk, evalScore, labelsO };
