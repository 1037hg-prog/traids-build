#!/usr/bin/env node
/**
 * ALPHA HUNT — THE BOARD-IMPROVEMENT QUESTION, 2026-08-27.
 *
 * NOT A REGISTERED TEST. Everything this script computes is a MOTIVATING SAMPLE and is excluded
 * from evidence by the house rule. It exists so the question below has a reproducible answer that
 * someone else can re-run and disagree with — the S8 lesson (that candidate was run from a
 * scratchpad, was never committed, and its numbers are now unauditable).
 *
 * THE QUESTION. backend/trade-autopsy.js reports DIRECTION BEFORE COST +47.78R against cost paid
 * -58.11R (run 2026-08-27, identityHolds true, over the 978 of 981 rows carrying a cost estimate).
 * The signals are not the problem. So the selection question is NOT "which tickets made money" —
 * that quantity is dominated by what it cost to trade them, which the observer cannot see and does
 * not control. The question is:
 *
 *     Do the board's own observers separate HIGH-DIRECTION from LOW-DIRECTION tickets
 *     out-of-sample — where direction is the autopsy's directionR, the signal's own output
 *     before the cost of expressing it?
 *
 * WHY directionR AND NOT rMult. Ranking on net R asks the observer to predict the spread as well as
 * the move. Any apparent skill then reads as cost composition: the observer would be rewarded for
 * picking Equity over Crypto, which is a class decision, not a signal decision. Splitting the two
 * is the entire point of the autopsy's identity, so the selection test should respect it.
 *
 * TWO ARMS, both pre-declared here before any statistic was read:
 *   A  observers only        momPctile, revRet5, squeeze, dir     — does the observer know anything
 *   B  observers + class     the same, plus class dummies         — or is it only the class mix
 * If B beats its null and A does not, the finding is a composition finding and belongs to
 * portfolio construction, not to signal selection.
 *
 * METHOD, per the house rules:
 *   split       CHRONOLOGICAL by day, first 70% of distinct sessions train / last 30% test
 *   model       ridge on standardised features, fit on train only, frozen before the test read
 *   statistic   OOS AUC of directionR>0, and top-tercile minus bottom-tercile mean directionR
 *   null        the label permuted WITHIN (day x direction) strata — day alone is not enough. A
 *               day-only null once certified an AUC of 0.61 here that was pure long/short
 *               asymmetry, so direction is held fixed as well.
 *   errors      day-clustered on the tercile gap
 */
const fs = require("fs"), path = require("path");
const { cleanEraLedger } = require("./lib/reconcile.js");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);

const OBS = ["momPctile", "revRet5", "squeeze"];
const TRAIN_FRAC = 0.7, NPERM = 2000, RIDGE = 1.0;

// ---- deterministic RNG so the permutation null is reproducible (Math.random is not) --------------
let _s = 20260827 >>> 0;
const rnd = () => ((_s = (_s * 1664525 + 1013904223) >>> 0) / 4294967296);

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

/** OLS/ridge via Gaussian elimination on the normal equations. Tiny system; no dependency needed. */
function ridgeFit(X, y, lam) {
  const p = X[0].length, A = Array.from({ length: p }, () => new Array(p + 1).fill(0));
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) { let s = 0; for (let k = 0; k < X.length; k++) s += X[k][i] * X[k][j]; A[i][j] = s + (i === j && i > 0 ? lam : 0); }
    let s = 0; for (let k = 0; k < X.length; k++) s += X[k][i] * y[k]; A[i][p] = s;
  }
  for (let c = 0; c < p; c++) {
    let piv = c; for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    if (Math.abs(A[c][c]) < 1e-12) continue;
    for (let r = 0; r < p; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; for (let k = c; k <= p; k++) A[r][k] -= f * A[c][k]; }
  }
  return A.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[p] / row[i]));
}

/** AUC of score against a binary label, by rank. */
function auc(score, label) {
  const idx = score.map((s, i) => i).sort((a, b) => score[a] - score[b]);
  const rank = new Array(score.length);
  for (let i = 0; i < idx.length;) {   // average ranks within ties
    let j = i; while (j + 1 < idx.length && score[idx[j + 1]] === score[idx[i]]) j++;
    const r = (i + j) / 2 + 1; for (let k = i; k <= j; k++) rank[idx[k]] = r; i = j + 1;
  }
  const pos = label.reduce((s, x) => s + (x ? 1 : 0), 0), neg = label.length - pos;
  if (!pos || !neg) return null;
  let sr = 0; for (let i = 0; i < label.length; i++) if (label[i]) sr += rank[i];
  return (sr - (pos * (pos + 1)) / 2) / (pos * neg);
}

/** Top-tercile minus bottom-tercile mean, with a day-clustered standard error on the gap. */
function tercileGap(score, y, day) {
  const ord = score.map((s, i) => i).sort((a, b) => score[a] - score[b]);
  const n = ord.length, lo = new Set(ord.slice(0, Math.floor(n / 3))), hi = new Set(ord.slice(n - Math.floor(n / 3)));
  const contrib = new Map();   // per-day contribution to (hi mean - lo mean)
  const nh = hi.size, nl = lo.size;
  for (let i = 0; i < n; i++) {
    const w = hi.has(i) ? 1 / nh : lo.has(i) ? -1 / nl : 0;
    if (!w) continue;
    contrib.set(day[i], (contrib.get(day[i]) || 0) + w * y[i]);
  }
  const v = [...contrib.values()], g = v.reduce((s, x) => s + x, 0), m = g / v.length;
  const se = v.length > 1 ? Math.sqrt(v.reduce((s, x) => s + (x - m) * (x - m), 0) / (v.length - 1) * v.length) : null;
  return { gap: g, se, days: v.length, t: se ? g / se : null };
}

// ---- build the joined sample ---------------------------------------------------------------------
const L = cleanEraLedger();
const aut = new Map(fs.readFileSync(D("trade-autopsy.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((r) => [r.id, r]));

const all = [];
for (const s of L.signals) {
  const a = aut.get(s.id);
  if (!a || !Number.isFinite(a.directionR)) continue;
  const o = s.obs || {};
  if (!OBS.every((f) => Number.isFinite(o[f]))) continue;   // complete case, declared before reading
  all.push({ id: s.id, day: a.day, dir: s.dir, cls: a.cls, y: a.directionR, net: a.rMult, cost: a.costR, f: OBS.map((k) => o[k]) });
}
all.sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0));

const days = [...new Set(all.map((r) => r.day))].sort();
const cut = days[Math.floor(days.length * TRAIN_FRAC) - 1];
const tr = all.filter((r) => r.day <= cut), te = all.filter((r) => r.day > cut);
const CLASSES = [...new Set(all.map((r) => r.cls))].sort();

function design(rows, withClass) {
  return rows.map((r) => [1, ...r.f, r.dir, ...(withClass ? CLASSES.slice(1).map((c) => (r.cls === c ? 1 : 0)) : [])]);
}

function runArm(name, withClass) {
  const Xtr = design(tr, withClass), Xte = design(te, withClass);
  const p = Xtr[0].length;
  const mu = new Array(p).fill(0), sd = new Array(p).fill(1);
  for (let j = 1; j < p; j++) {
    mu[j] = mean(Xtr.map((r) => r[j]));
    const v = mean(Xtr.map((r) => (r[j] - mu[j]) ** 2));
    sd[j] = v > 1e-12 ? Math.sqrt(v) : 1;
  }
  const z = (X) => X.map((r) => r.map((v, j) => (j ? (v - mu[j]) / sd[j] : 1)));
  const beta = ridgeFit(z(Xtr), tr.map((r) => r.y), RIDGE);
  const score = z(Xte).map((r) => r.reduce((s, v, j) => s + v * beta[j], 0));

  const y = te.map((r) => r.y), day = te.map((r) => r.day), dir = te.map((r) => r.dir);
  const obsAuc = auc(score, y.map((v) => v > 0));
  const obsGap = tercileGap(score, y, day);

  // NULL — permute y within (day x dir). The model score is held fixed; only the labels move.
  const strata = new Map();
  te.forEach((r, i) => { const k = r.day + "|" + r.dir; if (!strata.has(k)) strata.set(k, []); strata.get(k).push(i); });
  const nullAuc = [], nullGap = [];
  for (let b = 0; b < NPERM; b++) {
    const yp = y.slice();
    for (const ix of strata.values()) {
      const vals = ix.map((i) => y[i]);
      for (let i = vals.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [vals[i], vals[j]] = [vals[j], vals[i]]; }
      ix.forEach((i, k) => (yp[i] = vals[k]));
    }
    const a = auc(score, yp.map((v) => v > 0)); if (a !== null) nullAuc.push(a);
    nullGap.push(tercileGap(score, yp, day).gap);
  }
  const pOf = (obs, dist) => (dist.filter((v) => v >= obs).length + 1) / (dist.length + 1);
  const q = (dist, x) => { const s = dist.slice().sort((a, b) => a - b); return s[Math.floor(x * s.length)]; };

  return {
    arm: name, features: [...OBS, "dir", ...(withClass ? CLASSES.slice(1).map((c) => "cls=" + c) : [])],
    trainRows: tr.length, testRows: te.length,
    oosAuc: obsAuc === null ? null : +obsAuc.toFixed(4),
    nullAucMean: +mean(nullAuc).toFixed(4), nullAuc95: +q(nullAuc, 0.95).toFixed(4), pAuc: +pOf(obsAuc, nullAuc).toFixed(4),
    oosTercileGapR: +obsGap.gap.toFixed(4), tercileT: obsGap.t === null ? null : +obsGap.t.toFixed(3), testDays: obsGap.days,
    nullGapMean: +mean(nullGap).toFixed(4), nullGap95: +q(nullGap, 0.95).toFixed(4), pGap: +pOf(obsGap.gap, nullGap).toFixed(4),
  };
}

const arms = [runArm("A observers only", false), runArm("B observers + class", true)];

// Descriptive: is direction correlated with cost? If the expensive tickets are also the good ones,
// a cost filter throws the alpha out with the cost. Reported as a dependency, not a claim.
const cr = (() => {
  const x = all.map((r) => r.cost), y = all.map((r) => r.y);
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return +(sxy / Math.sqrt(sxx * syy)).toFixed(4);
})();

const out = {
  spec: "alpha-hunt-selection-v1",
  ranAt: new Date().toISOString(),
  NOT_EVIDENCE: "MOTIVATING SAMPLE. Computed while searching, therefore excluded from evidence by the house rule. Registering anything from it requires a fresh forward window.",
  question: "Do the board's observers separate high-direction from low-direction tickets out-of-sample, where direction is the autopsy's directionR (before cost)?",
  sample: { joined: all.length, days: days.length, trainCut: cut, trainRows: tr.length, testRows: te.length,
    droppedForIncompleteObs: L.signals.length - all.length,
    coverageNote: "complete-case on momPctile/revRet5/squeeze. regimeAlign and rvol were EXCLUDED at 43% coverage, newsScore at 16%, erDays at 8% - including them would have halved the sample and the choice was made before any statistic was read." },
  arms,
  costDirectionCorr: cr,
  costDirectionNote: "Pearson r between per-ticket costR and directionR over the joined sample. CAVEAT: 461 of 981 rows carry a class-model cost rather than a measured one (trade-autopsy spreadSource), so part of any dependency is class composition by construction, not a discovered relationship.",
};
writeJsonAtomic(D("alpha-hunt-selection.json"), out);

console.log(`\nSELECTION READ — MOTIVATING SAMPLE, NOT EVIDENCE`);
console.log(`  joined ${all.length} rows over ${days.length} sessions · train <= ${cut} (${tr.length}) · test (${te.length})`);
for (const a of arms) {
  console.log(`\n  ${a.arm}  [${a.features.join(", ")}]`);
  console.log(`    OOS AUC        ${a.oosAuc}   null mean ${a.nullAucMean}, null 95th ${a.nullAuc95}  ->  p ${a.pAuc}`);
  console.log(`    tercile gap    ${a.oosTercileGapR}R  day-clustered t ${a.tercileT} on ${a.testDays} test days`);
  console.log(`    vs null gap    mean ${a.nullGapMean}, 95th ${a.nullGap95}  ->  p ${a.pGap}`);
}
console.log(`\n  cost/direction correlation r = ${cr}  (see caveat in the JSON)`);
console.log(`\nwritten: alpha-hunt-selection.json`);
