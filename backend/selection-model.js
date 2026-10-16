#!/usr/bin/env node
/**
 * TRAIDS — SELECTION MODEL (2026-07-25)
 *
 * Trains a model to RANK candidate trades by expected excess return, on the historical dataset
 * built by training-data-gen.js. This is the selection engine — the model is asked which
 * candidates are best, not merely which are worst.
 *
 * WHAT IS BEING PREDICTED: whether a trade beats the market over the next 5 sessions
 * (fwdExc5 > 0), measured from the next bar's open. Excess, not raw: a long in a rising market
 * is beta, and a model trained on raw returns learns beta and reports it as skill.
 *
 * FIVE THINGS THAT MAKE THE RESULT MEAN SOMETHING
 *
 * 1. ONE ROW PER EPISODE. State-based signals re-fire every bar of a move, so the raw file has
 *    ~3.9 rows per distinct bet. Only the first firing of each episode is used. Training on all
 *    rows would inflate the sample ~4× and leak the same episode across the split.
 * 2. WALK-FORWARD BY YEAR. Train on everything up to year Y, test on Y+1, never the reverse.
 *    No random splits: a random split lets the model learn from the future of its own test set.
 * 3. BINS FIT ON TRAIN ONLY. Quantile edges come from the training fold. Fitting them on the
 *    full dataset would leak the test distribution into the model's representation.
 * 4. TWO CONTROLS. A shuffled-label run (must land at AUC≈0.5 — if it does not, the harness
 *    itself is broken) and a per-strategy breakdown so one archetype cannot carry the rest.
 * 5. ECONOMIC READOUT. AUC is not money. The decile table reports realised excess return and
 *    net R for the trades the model actually ranks highest, which is the only thing that pays.
 *
 * WHY A SECOND GRADIENT-BOOSTING IMPLEMENTATION: predictive-pipeline.js exists and is reused
 * where it fits, but its split search rebuilds a sorted unique-value set per feature per node —
 * fine at the ~200 records it was written for, several hours at 155k. This file pre-bins each
 * feature into quantiles once, making split search a histogram scan. `--selftest` trains both
 * on the same synthetic data and asserts they agree, so the fast path is verified against the
 * existing one rather than trusted.
 *
 * INHERITED BIAS, stated because every number below carries it: the dataset excludes 62
 * delisted or acquired instruments, whose absence flatters results. See the manifest.
 *
 * Usage
 *   node backend/selection-model.js                 train and evaluate walk-forward
 *   node backend/selection-model.js --selftest      verify the fast trainer against the existing one
 *   node backend/selection-model.js --rounds 60 --depth 4
 */
const fs = require("fs"), path = require("path"), readline = require("readline");

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i > -1 ? +args[i + 1] : d; };
const ROUNDS = argOf("--rounds", 50), DEPTH = argOf("--depth", 4), LR = 0.08, BINS = 32, MINLEAF = 40;
// Horizon family. The 5-session target produced AUC 0.5013 against a 0.4979 control — no skill.
// Before concluding the features are uninformative, the other horizons are tested. They are
// declared as a FAMILY of 5 and all five are reported: picking the best of five after the fact
// and quoting it alone is the error this whole platform exists to prevent. With 5 tests, a
// nominal 0.05 threshold becomes 0.01, and AUC must clear its own shuffled control by more
// than the spread between controls to mean anything at all.
const HORIZONS = [1, 3, 5, 10, 20];
const HORIZON = argOf("--horizon", 0);   // 0 = run the whole family
const DATA = path.join(__dirname, "data", "training", "dataset.jsonl");
const OUTDIR = path.join(__dirname, "data", "training");

// ════════════════════════════════════════════════════════════════════════════
// Histogram gradient-boosted trees
// ════════════════════════════════════════════════════════════════════════════
const sigmoid = z => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/** Quantile bin edges from TRAINING values only. NaN is excluded and gets its own bin later. */
function fitBins(col, nBins) {
  const v = col.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length < nBins * 2) return v.length ? [v[Math.floor(v.length / 2)]] : [0];
  const edges = [];
  for (let q = 1; q < nBins; q++) edges.push(v[Math.floor(v.length * q / nBins)]);
  return [...new Set(edges)];
}
/** Missing maps to bin 0 and every real value shifts up by one, so "absent" is its own
 *  category the tree can split on rather than being silently lumped with small values. */
function toBin(x, edges) {
  if (!Number.isFinite(x)) return 0;
  let lo = 0, hi = edges.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (x <= edges[m]) hi = m; else lo = m + 1; }
  return lo + 1;
}

function buildHistTree(bins, grad, idx, nF, nBinsArr, depth, maxDepth, minLeaf) {
  const sum = (a) => { let s = 0; for (const i of a) s += grad[i]; return s; };
  const leafOf = () => ({ leaf: true, val: idx.length ? sum(idx) / idx.length : 0 });
  if (depth >= maxDepth || idx.length < 2 * minLeaf) return leafOf();

  let best = null;
  for (let f = 0; f < nF; f++) {
    const nb = nBinsArr[f];
    const cnt = new Float64Array(nb), gsum = new Float64Array(nb);
    const col = bins[f];
    for (const i of idx) { const b = col[i]; cnt[b]++; gsum[b] += grad[i]; }
    let lN = 0, lS = 0;
    const totN = idx.length, totS = sum(idx);
    for (let b = 0; b < nb - 1; b++) {
      lN += cnt[b]; lS += gsum[b];
      const rN = totN - lN, rS = totS - lS;
      if (lN < minLeaf || rN < minLeaf) continue;
      const gain = lS * lS / lN + rS * rS / rN;
      if (!best || gain > best.gain) best = { gain, f, b };
    }
  }
  if (!best) return leafOf();
  const L = [], R = [];
  const col = bins[best.f];
  for (const i of idx) (col[i] <= best.b ? L : R).push(i);
  if (!L.length || !R.length) return leafOf();
  return { leaf: false, f: best.f, b: best.b,
    left: buildHistTree(bins, grad, L, nF, nBinsArr, depth + 1, maxDepth, minLeaf),
    right: buildHistTree(bins, grad, R, nF, nBinsArr, depth + 1, maxDepth, minLeaf) };
}
const predTree = (node, row) => node.leaf ? node.val : predTree(row[node.f] <= node.b ? node.left : node.right, row);

function trainHistGBDT(bins, y, nF, nBinsArr, { rounds = ROUNDS, lr = LR, maxDepth = DEPTH, minLeaf = MINLEAF } = {}) {
  const n = y.length;
  const p0 = Math.min(0.999, Math.max(0.001, y.reduce((s, v) => s + v, 0) / n));
  const f0 = Math.log(p0 / (1 - p0));
  const F = new Float64Array(n).fill(f0);
  const grad = new Float64Array(n);
  const allIdx = Array.from({ length: n }, (_, i) => i);
  const trees = [];
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < n; i++) grad[i] = y[i] - sigmoid(F[i]);
    const t = buildHistTree(bins, grad, allIdx, nF, nBinsArr, 0, maxDepth, minLeaf);
    trees.push(t);
    for (let i = 0; i < n; i++) {
      const row = []; for (let f = 0; f < nF; f++) row.push(bins[f][i]);
      F[i] += lr * predTree(t, row);
    }
  }
  return { f0, lr, trees, nF,
    scoreBinned: (row) => sigmoid(f0 + lr * trees.reduce((s, t) => s + predTree(t, row), 0)) };
}

/** Mann-Whitney AUC via ranking — O(n log n). The pairwise version in predictive-pipeline.js
 *  is O(pos×neg), which at this scale is ~10^10 comparisons and never returns. */
function fastAuc(scores, labels) {
  const n = scores.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => scores[a] - scores[b]);
  const rank = new Float64Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && scores[order[j + 1]] === scores[order[i]]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) rank[order[k]] = avg;
    i = j + 1;
  }
  let nPos = 0, sumPos = 0;
  for (let k = 0; k < n; k++) if (labels[k]) { nPos++; sumPos += rank[k]; }
  const nNeg = n - nPos;
  if (!nPos || !nNeg) return 0.5;
  return (sumPos - nPos * (nPos + 1) / 2) / (nPos * nNeg);
}

// ════════════════════════════════════════════════════════════════════════════
// Self-test: fast trainer vs. the existing implementation
// ════════════════════════════════════════════════════════════════════════════
if (args.includes("--selftest")) {
  const { trainGBDT, auc } = require("./predictive-pipeline");
  const N = 1200, NF = 5;
  const X = [], y = [];
  let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < N; i++) {
    const x = Array.from({ length: NF }, () => rnd() * 2 - 1);
    X.push(x);
    y.push(sigmoid(2.5 * x[0] - 1.8 * x[1] + 0.6 * x[2]) > rnd() ? 1 : 0);
  }
  const cut = Math.floor(N * 0.7);
  const slow = trainGBDT(X.slice(0, cut), y.slice(0, cut), { rounds: 40, lr: 0.1, maxDepth: 3, minLeaf: 10 });
  const slowScores = X.slice(cut).map(x => slow.predict(x));
  const slowAuc = auc(slowScores, y.slice(cut));

  const cols = Array.from({ length: NF }, (_, f) => X.slice(0, cut).map(r => r[f]));
  const edges = cols.map(c => fitBins(c, BINS));
  const binsTr = edges.map((e, f) => Int32Array.from(X.slice(0, cut).map(r => toBin(r[f], e))));
  const nBinsArr = edges.map(e => e.length + 2);
  const fast = trainHistGBDT(binsTr, y.slice(0, cut), NF, nBinsArr, { rounds: 40, lr: 0.1, maxDepth: 3, minLeaf: 10 });
  const fastScores = X.slice(cut).map(r => fast.scoreBinned(edges.map((e, f) => toBin(r[f], e))));
  const fastAucV = fastAuc(fastScores, y.slice(cut));
  const aucAgree = fastAuc(slowScores, y.slice(cut));

  console.log(`\n  SELF-TEST — fast histogram trainer vs. existing implementation\n`);
  console.log(`  existing trainGBDT      AUC ${slowAuc.toFixed(4)}`);
  console.log(`  fast histogram GBDT     AUC ${fastAucV.toFixed(4)}`);
  console.log(`  fastAuc on same scores  AUC ${aucAgree.toFixed(4)}  (must equal the first line — validates the AUC rewrite)`);
  const aucOk = Math.abs(aucAgree - slowAuc) < 1e-9;
  const modelOk = Math.abs(fastAucV - slowAuc) < 0.06;
  console.log(`\n  ${aucOk ? "✓" : "✗"} fast AUC reproduces the pairwise AUC exactly`);
  console.log(`  ${modelOk ? "✓" : "✗"} binned trainer within 0.06 AUC of the exact-split trainer on known signal`);
  process.exit(aucOk && modelOk ? 0 : 1);
}

// ════════════════════════════════════════════════════════════════════════════
// Load — one row per episode
// ════════════════════════════════════════════════════════════════════════════
(async () => {
  if (!fs.existsSync(DATA)) { console.log(`\n  no dataset at ${DATA} — run training-data-gen.js first\n`); process.exit(1); }
  const manifest = JSON.parse(fs.readFileSync(path.join(OUTDIR, "manifest.json"), "utf8"));
  const FEATS = manifest.features;
  console.log(`\n  TRAIDS — SELECTION MODEL`);
  console.log(`  target: beats the market over 5 sessions (fwdExc5 > 0), entry at next bar's open`);
  console.log(`  ${FEATS.length} features · one row per episode · walk-forward by year\n`);

  const rows = [];
  const rl = readline.createInterface({ input: fs.createReadStream(DATA), crlfDelay: Infinity });
  let seen = 0, skippedNoLabel = 0;
  for await (const line of rl) {
    if (!line) continue;
    seen++;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.episodeBar !== 0) continue;                  // first firing of each episode only
    const exc = {};
    for (const h of HORIZONS) { const v = r[`fwdExc${h}`]; exc[h] = Number.isFinite(v) ? v : null; }
    if (HORIZONS.every(h => exc[h] == null)) { skippedNoLabel++; continue; }
    rows.push({
      year: +r.date.slice(0, 4), strategy: r.strategy, dir: r.dir, sym: r.sym,
      x: FEATS.map(k => { const v = r.f[k]; return Number.isFinite(v) ? v : NaN; }),
      exc, rNet: Number.isFinite(r.rMultNet) ? r.rMultNet : null,
    });
  }
  console.log(`  read ${seen.toLocaleString()} rows → ${rows.length.toLocaleString()} episodes (${skippedNoLabel.toLocaleString()} dropped for no label)`);
  const years = [...new Set(rows.map(r => r.year))].sort();
  console.log(`  years: ${years.join(", ")}\n`);

  // ── walk-forward, once per horizon in the declared family ─────────────────
  const NF = FEATS.length;
  const family = [];
  const targets = HORIZON ? [HORIZON] : HORIZONS;
  for (const H of targets) {
  const folds = [];
  for (let k = 2; k < years.length; k++) {           // need ≥2 years of history to train
    const testYear = years[k];
    const has = (r) => r.exc[H] != null;
    const tr = rows.filter(r => r.year < testYear && has(r)), te = rows.filter(r => r.year === testYear && has(r));
    if (tr.length < 5000 || te.length < 500) continue;

    const cols = Array.from({ length: NF }, (_, f) => tr.map(r => r.x[f]));
    const edges = cols.map(c => fitBins(c, BINS));            // TRAIN-ONLY bin edges
    const nBinsArr = edges.map(e => e.length + 2);
    const binsTr = edges.map((e, f) => Int32Array.from(tr.map(r => toBin(r.x[f], e))));
    const ytr = tr.map(r => r.exc[H] > 0 ? 1 : 0);
    const yte = te.map(r => r.exc[H] > 0 ? 1 : 0);

    const t0 = Date.now();
    const model = trainHistGBDT(binsTr, ytr, NF, nBinsArr);
    const scores = te.map(r => model.scoreBinned(edges.map((e, f) => toBin(r.x[f], e))));
    const a = fastAuc(scores, yte);

    // control: same pipeline, labels shuffled. Must land at ~0.5 or the harness is broken.
    let s2 = 7; const rnd = () => (s2 = (s2 * 1103515245 + 12345) % 2147483648) / 2147483648;
    const shuf = ytr.slice();
    for (let i = shuf.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [shuf[i], shuf[j]] = [shuf[j], shuf[i]]; }
    const ctrl = trainHistGBDT(binsTr, shuf, NF, nBinsArr, { rounds: Math.min(20, ROUNDS) });
    const ctrlAuc = fastAuc(te.map(r => ctrl.scoreBinned(edges.map((e, f) => toBin(r.x[f], e)))), yte);

    // economic readout — top decile by score
    const ord = te.map((r, i) => ({ r, s: scores[i] })).sort((a, b) => b.s - a.s);
    const topN = Math.max(1, Math.floor(ord.length / 10));
    const meanOf = (arr, get) => { const v = arr.map(get).filter(Number.isFinite); return v.length ? v.reduce((x, z) => x + z, 0) / v.length : null; };
    // MEDIAN for raw excess return, not mean. Raw forward returns ignore the stop: a short on a
    // stock that triples records −300%, an outcome the system's own settle convention makes
    // impossible because the position would have been stopped at −1R. The mean of that column
    // is dominated by losses that could never occur, which is what produced a nonsensical
    // −277% "top-decile edge" at the 20-day horizon. rMultNet respects the stop and is the
    // metric that actually corresponds to a tradable outcome, so it leads.
    const medOf = (arr, get) => { const v = arr.map(get).filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
    const topExc = medOf(ord.slice(0, topN), o => o.r.exc[H]), allExc = medOf(ord, o => o.r.exc[H]);
    const topR = meanOf(ord.slice(0, topN), o => o.r.rNet), allR = meanOf(ord, o => o.r.rNet);

    folds.push({ testYear, nTrain: tr.length, nTest: te.length, auc: a, ctrlAuc, topExc, allExc, topR, allR, secs: (Date.now() - t0) / 1000, model, edges });
    console.log(`  h=${String(H).padStart(2)}d  ${testYear}  train ${tr.length.toLocaleString().padStart(7)} → test ${te.length.toLocaleString().padStart(6)} · AUC ${a.toFixed(4)} · control ${ctrlAuc.toFixed(4)} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }

  if (!folds.length) { console.log(`  h=${H}: not enough data for a walk-forward split`); continue; }

  // ── report ────────────────────────────────────────────────────────────────
  const mAuc = folds.reduce((s, f) => s + f.auc, 0) / folds.length;
  const mCtrl = folds.reduce((s, f) => s + f.ctrlAuc, 0) / folds.length;
  console.log(`\n  ── RANKING SKILL (out-of-sample, by year) ──`);
  console.log(`  mean AUC ${mAuc.toFixed(4)} across ${folds.length} held-out years · shuffled-label control ${mCtrl.toFixed(4)}`);
  console.log(`  0.500 = no ranking skill. The control must sit at ~0.500; if it does not, the harness leaks.`);

  console.log(`\n  ── ECONOMIC READOUT (does the top decile actually pay?) ──`);
  console.log(`  year    top-decile excess   all-signal excess   edge     top-decile net R   all net R`);
  console.log(`  ─────────────────────────────────────────────────────────────────────────────────────`);
  const pc = (v) => v == null ? "     —" : (v * 100).toFixed(3) + "%";
  for (const f of folds) {
    const edge = (f.topExc != null && f.allExc != null) ? f.topExc - f.allExc : null;
    console.log(`  ${f.testYear}   ${pc(f.topExc).padStart(15)}   ${pc(f.allExc).padStart(17)}   ${pc(edge).padStart(7)}   ${(f.topR == null ? "—" : f.topR.toFixed(3)).padStart(15)}   ${(f.allR == null ? "—" : f.allR.toFixed(3)).padStart(9)}`);
  }
  const mTop = folds.map(f => f.topExc).filter(Number.isFinite), mAll = folds.map(f => f.allExc).filter(Number.isFinite);
  const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const edgeAvg = (avg(mTop) != null && avg(mAll) != null) ? avg(mTop) - avg(mAll) : null;
  const yearsPositive = folds.filter(f => f.topExc != null && f.allExc != null && f.topExc > f.allExc).length;
  console.log(`  ─────────────────────────────────────────────────────────────────────────────────────`);
  console.log(`  mean    ${pc(avg(mTop)).padStart(15)}   ${pc(avg(mAll)).padStart(17)}   ${pc(edgeAvg).padStart(7)}`);
  console.log(`\n  top decile beat the full signal set in ${yearsPositive} of ${folds.length} held-out years.`);

  // per-strategy, so one archetype cannot carry the aggregate
  const last = folds[folds.length - 1];
  const byStrat = {};
  const teLast = rows.filter(r => r.year === last.testYear && r.exc[H] != null);
  for (const st of [...new Set(teLast.map(r => r.strategy))]) {
    const sub = teLast.filter(r => r.strategy === st);
    if (sub.length < 100) continue;
    const sc = sub.map(r => last.model.scoreBinned(last.edges.map((e, f) => toBin(r.x[f], e))));
    byStrat[st] = { n: sub.length, auc: +fastAuc(sc, sub.map(r => r.exc[H] > 0 ? 1 : 0)).toFixed(4) };
  }
  console.log(`  h=${H}d summary: mean AUC ${mAuc.toFixed(4)} · control ${mCtrl.toFixed(4)} · top decile beat all in ${yearsPositive}/${folds.length} years\n`);

  family.push({ horizon: H, meanAuc: +mAuc.toFixed(4), meanCtrlAuc: +mCtrl.toFixed(4), edgeAvg, yearsPositive, nFolds: folds.length, byStrat,
    folds: folds.map(f => ({ testYear: f.testYear, nTrain: f.nTrain, nTest: f.nTest, auc: +f.auc.toFixed(4), shuffledControlAuc: +f.ctrlAuc.toFixed(4), topDecileExcess: f.topExc, allExcess: f.allExc, topDecileNetR: f.topR, allNetR: f.allR })) });
  }   // end horizon loop

  // ── FAMILY REPORT ─────────────────────────────────────────────────────────
  // All five horizons, reported together. The best member of a family of five is not a
  // finding — the family is. A skill claim must clear its own shuffled control by more than
  // the controls vary among themselves, otherwise it is measuring the harness, not the market.
  const pcf = (v) => v == null ? "     —" : (v * 100).toFixed(3) + "%";
  console.log(`  ══ HORIZON FAMILY (all ${family.length} tested, all reported) ══`);
  console.log(`  horizon   mean AUC   control   AUC − control   median edge   top-decile net R   years top>all`);
  console.log(`  ────────────────────────────────────────────────────────────────────────────────────────────`);
  for (const f of family) {
    const gap = f.meanAuc - f.meanCtrlAuc;
    const tR = f.folds.map(x => x.topDecileNetR).filter(Number.isFinite);
    const avgTopR = tR.length ? tR.reduce((a, b) => a + b, 0) / tR.length : null;
    console.log(`  ${(f.horizon + "d").padEnd(9)} ${f.meanAuc.toFixed(4).padStart(8)}   ${f.meanCtrlAuc.toFixed(4).padStart(7)}   ${((gap >= 0 ? "+" : "") + gap.toFixed(4)).padStart(13)}   ${pcf(f.edgeAvg).padStart(11)}   ${(avgTopR == null ? "—" : avgTopR.toFixed(3)).padStart(16)}   ${String(f.yearsPositive + "/" + f.nFolds).padStart(13)}`);
  }
  const ctrlSpread = Math.max(...family.map(f => f.meanCtrlAuc)) - Math.min(...family.map(f => f.meanCtrlAuc));
  const bestGap = Math.max(...family.map(f => f.meanAuc - f.meanCtrlAuc));
  console.log(`  ─────────────────────────────────────────────────────────────────────────────`);
  console.log(`  spread among the shuffled controls alone: ${ctrlSpread.toFixed(4)} — the noise floor of this harness.`);
  console.log(`  best horizon's edge over its own control:  ${bestGap.toFixed(4)}`);
  console.log(`\n  VERDICT: ${bestGap > ctrlSpread * 1.5
    ? "the best horizon clears the noise floor — worth a pre-registered follow-up, NOT a conclusion"
    : "no horizon clears the noise floor of its own control. These 19 price/volume features carry\n           no usable information about forward excess return for these signals."}`);

  fs.writeFileSync(path.join(OUTDIR, "selection-model-report.json"), JSON.stringify({
    generated: new Date().toISOString(),
    target: "fwdExc{h} > 0 (beats benchmark over h sessions), entry next bar open",
    familyTested: HORIZONS, familySize: HORIZONS.length,
    multiplicityNote: "Five horizons were declared and all five are reported. Selecting the best after the fact and quoting it alone would be the exact error this platform exists to prevent.",
    features: FEATS, rounds: ROUNDS, depth: DEPTH, lr: LR, bins: BINS, episodes: rows.length,
    results: family,
    controlSpread: +ctrlSpread.toFixed(4), bestGapOverControl: +bestGap.toFixed(4),
    verdict: bestGap > ctrlSpread * 1.5 ? "candidate — pre-register a follow-up" : "no ranking skill detected at any horizon",
    inheritedBias: manifest.survivorshipWarning || null,
    caveat: "Out-of-sample by year, one row per episode, bin edges fit on the training fold only. AUC is ranking skill, not money.",
  }, null, 1));
  console.log(`\n  written: backend/data/training/selection-model-report.json`);
  if (manifest.survivorshipWarning) console.log(`  ▲ every number above inherits the dataset's survivorship bias (62 delisted instruments absent).`);
  console.log("");
})();
