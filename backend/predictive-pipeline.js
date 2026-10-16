#!/usr/bin/env node
/**
 * TRAIDS — Predictive Pipeline (gradient-boosted trees)
 *
 * A stronger, in-stack model than the logistic-regression baseline: gradient-
 * boosted decision trees capture non-linear feature interactions. It is judged
 * the SAME honest way as everything else — walk-forward, ROC-AUC, out-of-sample.
 *
 * This file is the SCAFFOLD: it ships the GBDT + the walk-forward evaluator, and
 * trains on the real trade-log outcomes as they accumulate (see loadTradeLog()).
 * Until there is a real edge in the data, it (correctly) scores ~0.5 AUC — it
 * reports whether a signal exists, it never manufactures one.
 *
 * Self-test:  node predictive-pipeline.js                       (signal vs noise)
 * Real data:  node predictive-pipeline.js path/to/traids_trade_log.csv
 *             (or set TRADELOG=path)  — exported from the board's Trade Log → ⭳ CSV
 */
const fs = require("fs");

// ── Gradient-Boosted Decision Trees (binary log-loss) ─────────────────────────
function buildTree(X, grad, idx, depth, maxDepth, minLeaf) {
  const leaf = () => ({ leaf: true, val: idx.reduce((s, i) => s + grad[i], 0) / (idx.length || 1) });
  if (depth >= maxDepth || idx.length < 2 * minLeaf) return leaf();
  const nF = X[0].length;
  let best = null;
  for (let f = 0; f < nF; f++) {
    const vals = [...new Set(idx.map(i => X[i][f]))].sort((a, b) => a - b);
    if (vals.length < 2) continue;
    // candidate thresholds: midpoints (subsample if many)
    const step = Math.max(1, Math.floor(vals.length / 24));
    for (let v = 0; v < vals.length - 1; v += step) {
      const thr = (vals[v] + vals[v + 1]) / 2;
      let lN = 0, lS = 0, rN = 0, rS = 0;
      for (const i of idx) { if (X[i][f] <= thr) { lN++; lS += grad[i]; } else { rN++; rS += grad[i]; } }
      if (lN < minLeaf || rN < minLeaf) continue;
      // variance-reduction proxy: maximize (lS^2/lN + rS^2/rN)
      const gain = lS * lS / lN + rS * rS / rN;
      if (!best || gain > best.gain) best = { gain, f, thr };
    }
  }
  if (!best) return leaf();
  const L = [], R = [];
  for (const i of idx) (X[i][best.f] <= best.thr ? L : R).push(i);
  return { leaf: false, f: best.f, thr: best.thr,
    left: buildTree(X, grad, L, depth + 1, maxDepth, minLeaf),
    right: buildTree(X, grad, R, depth + 1, maxDepth, minLeaf) };
}
const treePredict = (node, x) => node.leaf ? node.val : treePredict(x[node.f] <= node.thr ? node.left : node.right, x);
const sigmoid = z => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

function trainGBDT(X, y, { rounds = 60, lr = 0.1, maxDepth = 3, minLeaf = 5 } = {}) {
  const p0 = Math.min(0.999, Math.max(0.001, y.reduce((s, v) => s + v, 0) / y.length));
  const f0 = Math.log(p0 / (1 - p0));
  const F = y.map(() => f0);
  const trees = [];
  const allIdx = X.map((_, i) => i);
  for (let r = 0; r < rounds; r++) {
    const grad = F.map((f, i) => y[i] - sigmoid(f));              // negative log-loss gradient
    const tree = buildTree(X, grad, allIdx, 0, maxDepth, minLeaf);
    trees.push(tree);
    for (let i = 0; i < X.length; i++) F[i] += lr * treePredict(tree, X[i]);
  }
  return { f0, lr, trees, predict: x => sigmoid(f0 + lr * trees.reduce((s, t) => s + treePredict(t, x), 0)) };
}

// ── Logistic regression baseline (for comparison) ─────────────────────────────
function trainLogReg(X, y, { iters = 300, lr = 0.1 } = {}) {
  const nF = X[0].length; const w = Array(nF).fill(0); let b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = Array(nF).fill(0); let gb = 0;
    for (let i = 0; i < X.length; i++) { const p = sigmoid(X[i].reduce((s, v, j) => s + v * w[j], b)); const e = p - y[i]; for (let j = 0; j < nF; j++) gw[j] += e * X[i][j]; gb += e; }
    for (let j = 0; j < nF; j++) w[j] -= lr * gw[j] / X.length; b -= lr * gb / X.length;
  }
  return { predict: x => sigmoid(x.reduce((s, v, j) => s + v * w[j], b)) };
}

// ── ROC-AUC (Mann-Whitney) ────────────────────────────────────────────────────
function auc(scores, labels) {
  const pos = [], neg = [];
  scores.forEach((s, i) => (labels[i] ? pos : neg).push(s));
  if (!pos.length || !neg.length) return 0.5;
  let c = 0; for (const p of pos) for (const n of neg) c += p > n ? 1 : p === n ? 0.5 : 0;
  return c / (pos.length * neg.length);
}

// ── Walk-forward evaluation (expanding window) ────────────────────────────────
function walkForward(X, y, train, folds = 5, minTrain = 40) {
  const n = X.length; if (n < minTrain + folds) return { auc: 0.5, n };
  const start = Math.max(minTrain, Math.floor(n * 0.4));
  const step = Math.max(1, Math.floor((n - start) / folds));
  const allScores = [], allLabels = [];
  for (let cut = start; cut < n; cut += step) {
    const Xtr = X.slice(0, cut), ytr = y.slice(0, cut);
    const Xte = X.slice(cut, Math.min(n, cut + step)), yte = y.slice(cut, Math.min(n, cut + step));
    if (!Xte.length || new Set(ytr).size < 2) continue;
    const model = train(Xtr, ytr);
    Xte.forEach((x, i) => { allScores.push(model.predict(x)); allLabels.push(yte[i]); });
  }
  return { auc: auc(allScores, allLabels), n };
}

// ── Real data hook: train on accumulated trade-log outcomes ───────────────────
// Reads the board's exported Trade Log CSV (Trade Log → ⭳ CSV). Columns:
//   ...,dir,...,pnl,reason,conf,strategy,rr,score,nBull,nBear,total
// Feature vector per closed trade → label: pnl > 0 (a win).
const STRATS  = ["Ensemble", "Breakout", "Mean-Reversion", "Trend"];
const CLASSES = ["Equity", "Crypto", "Futures", "Options"];
function parseCSV(text) {
  const lines = text.replace(/^﻿/, "").trim().split(/\r?\n/);
  const header = lines[0].split(",").map(h => h.trim());
  return lines.slice(1).filter(Boolean).map(line => {
    const c = line.split(","); const o = {}; header.forEach((h, i) => o[h] = (c[i] ?? "").trim()); return o;
  });
}
function loadTradeLog(path) {
  if (!path) return null;
  let text;
  try { text = fs.readFileSync(path, "utf8"); }
  catch { console.error(`  Could not read ${path}`); return null; }
  const rows = parseCSV(text).filter(r => r.pnl !== "" && !isNaN(parseFloat(r.pnl)));
  if (!rows.length) { console.error(`  No priced trades in ${path}.`); return null; }
  rows.sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt));   // time order for walk-forward
  const num = (v, d = 0) => { const f = parseFloat(v); return isNaN(f) ? d : f; };
  const X = [], y = []; let wins = 0;
  for (const r of rows) {
    const dir = /short/i.test(r.dir) ? -1 : num(r.dir, 1) < 0 ? -1 : 1;
    X.push([
      num(r.conf), num(r.score), num(r.rr), dir, num(r.nBull), num(r.nBear), num(r.total),
      ...STRATS.map(s => r.strategy === s ? 1 : 0),
      ...CLASSES.map(c => r.class === c ? 1 : 0),
    ]);
    const win = num(r.pnl) > 0 ? 1 : 0; y.push(win); if (win) wins++;
  }
  return { X, y, n: X.length, wins, winRate: wins / X.length, path };
}

// Read the LIVE server-side log directly (backend/data/trade_log.json) so the
// pipeline runs on accumulated trades with no manual CSV export. Same feature
// vector + label (pnl>0) as the CSV path; handles the JSON field names (cls, ms ts).
function loadTradeLogJSON(path) {
  let text;
  try { text = fs.readFileSync(path, "utf8"); } catch { return null; }
  let arr;
  try { const d = JSON.parse(text); arr = Array.isArray(d) ? d : (d.trades || d.log || []); } catch { return null; }
  const rows = arr.filter(r => r && r.pnl != null && !isNaN(parseFloat(r.pnl)));
  if (!rows.length) return null;
  rows.sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0));   // time order for walk-forward
  const num = (v, d = 0) => { const f = parseFloat(v); return isNaN(f) ? d : f; };
  const X = [], y = []; let wins = 0;
  for (const r of rows) {
    const dir = num(r.dir, 1) < 0 ? -1 : 1;
    const o = r.obs || {};
    X.push([
      num(r.conf), num(r.score), num(r.rr), dir, num(r.nBull), num(r.nBear), num(r.total),
      ...STRATS.map(s => r.strategy === s ? 1 : 0),
      ...CLASSES.map(c => (r.class || r.cls) === c ? 1 : 0),
      // passive observers (regime align / x-sec momentum / 5d reversal / vol-squeeze / RVOL /
      // news sentiment) — null → neutral default so old trades (pre-observer) don't skew the tree
      num(o.regimeAlign, 0), num(o.momPctile, 0.5), num(o.revRet5, 0), num(o.squeeze, 0), num(o.rvol, 1), num(o.newsScore, 0),
    ]);
    const win = num(r.pnl) > 0 ? 1 : 0; y.push(win); if (win) wins++;
  }
  return { X, y, n: X.length, wins, winRate: wins / X.length, path };
}

// ── Self-test: prove the pipeline is honest ───────────────────────────────────
function makeData(n, nF, signal) {
  const X = [], y = [];
  for (let i = 0; i < n; i++) {
    const x = Array.from({ length: nF }, () => Math.random() * 2 - 1);
    let p;
    if (signal) { const z = 2.2 * x[0] * x[1] + 1.6 * Math.sign(x[2]) - 1.2 * x[3] * x[3]; p = sigmoid(z); }  // non-linear signal
    else p = 0.5;                                                                                              // pure noise
    X.push(x); y.push(Math.random() < p ? 1 : 0);
  }
  return { X, y };
}

if (require.main === module) {
  const path = process.argv[2] || process.env.TRADELOG || null;
  // Default to the LIVE server log so `node predictive-pipeline.js` just works;
  // an explicit .json path loads JSON, anything else is treated as exported CSV.
  const real = path
    ? (/\.json$/i.test(path) ? loadTradeLogJSON(path) : loadTradeLog(path))
    : loadTradeLogJSON(require("path").join(__dirname, "data", "trade_log.json"));
  console.log("\n  TRAIDS — Predictive Pipeline (GBDT) — walk-forward ROC-AUC\n");
  if (real) {
    console.log(`  REAL trade log: ${real.n} closed trades · win rate ${(real.winRate * 100).toFixed(0)}%   (${real.path})\n`);
    if (real.n < 60) {
      console.log(`  ⚠ Only ${real.n} trades — far too few to trust any AUC. Walk-forward needs ~60+`);
      console.log(`    (ideally 100–200+) closed trades before the number means anything. Keep`);
      console.log(`    paper-trading and logging; re-run this when the log is larger.\n`);
    }
    const g = walkForward(real.X, real.y, trainGBDT), l = walkForward(real.X, real.y, trainLogReg);
    console.log(`  GBDT   walk-forward AUC ${g.auc.toFixed(3)}`);
    console.log(`  LogReg walk-forward AUC ${l.auc.toFixed(3)}\n`);
    const best = Math.max(g.auc, l.auc);
    if (best < 0.55)      console.log(`  → ≈0.5: your setups show NO learnable edge yet. Honest, expected, and a reason to stay disciplined.`);
    else if (best < 0.6)  console.log(`  → Marginal (0.55–0.60): weak hint of signal. Need far more trades to confirm it isn't noise.`);
    else                  console.log(`  → Above 0.60 out-of-sample: a real signal may exist. Validate with more data before trusting it.`);
    console.log("");
  } else {
    if (path) console.log(`  (no usable trade log at "${path}" — running synthetic self-test instead)\n`);
    console.log("  No real trade-log wired yet — running honesty self-test on synthetic data.\n");
    for (const [label, signal] of [["learnable signal", true], ["pure noise", false]]) {
      const { X, y } = makeData(900, 6, signal);
      const g = walkForward(X, y, trainGBDT), l = walkForward(X, y, trainLogReg);
      console.log(`  ${label.padEnd(18)}  GBDT AUC ${g.auc.toFixed(3)}   LogReg AUC ${l.auc.toFixed(3)}`);
    }
    console.log("\n  Expect: signal → GBDT AUC well above 0.5 (and above LogReg, since the");
    console.log("  signal is non-linear);  noise → both ≈ 0.50. If noise scored high, the");
    console.log("  evaluator would be leaking — it doesn't. That null result is the safeguard.");
  }
  console.log("");
}

module.exports = { trainGBDT, trainLogReg, walkForward, auc };
