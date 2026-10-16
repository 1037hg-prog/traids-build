#!/usr/bin/env node
/**
 * TEST #52 — STRUCTURAL SELECTION MODEL: does order-flow disclosure predict where chart
 * shapes did not?
 *
 * PRE-REGISTERED 2026-07-28, WRITTEN BEFORE THE DATASET FINISHED BUILDING. The specification
 * below was fixed while the generator was still fetching, precisely so it could not be tuned
 * to whatever the data turned out to look like.
 *
 * THE HYPOTHESIS, and why it is not just #39 again. Test #39 trained a gradient-boosted model
 * on 150,316 episodes with 19 features and returned AUC 0.5013 against a shuffled control of
 * 0.4979 — no skill. Every feature it used was a price or volume pattern. Cross-tabbing this
 * project's 48 tests on 2026-07-28 showed price-pattern hypotheses run 0-for-35 once #7 and #18
 * are re-measured, while structural hypotheses — ones naming a counterparty with a motive — run
 * 12-for-12. #39 tested the losing category and correctly reported the losing category's answer.
 *
 * This asks the same question of the winning category: FINRA daily short-volume disclosure.
 * Test #35 already established that one feature from this family (the 20-day z of the ratio)
 * survives Bonferroni AND out-of-sample at t 3.32 / 3.09. It was shelved for COST at daily
 * turnover, not for absence of signal. Two things differ here: several features combined by a
 * model rather than one z alone, and a 20-session horizon where the same per-trade cost is
 * amortised over 20x the holding period.
 *
 * ── PRE-REGISTERED DESIGN ──────────────────────────────────────────────────────────────────
 * MODEL: logistic regression on standardised features, predicting P(forward excess > 0).
 *   Deliberately NOT a gradient-boosted tree. #39 already used one and the question here is
 *   whether the INFORMATION is present, not whether a flexible learner can find structure in
 *   noise. A linear model with 7 features on ~100k rows cannot overfit its way to a result, so
 *   a positive answer would be about the data rather than the learner.
 *
 * SPLIT: CHRONOLOGICAL, 70/30 by entry date. Never random — a random split puts adjacent
 *   sessions of the same name on both sides and leaks.
 *
 * CONTROL: the identical pipeline on SHUFFLED labels, same split, same features. This is the
 *   only thing that distinguishes "the model found signal" from "the pipeline manufactures AUC".
 *   #39's control read 0.4979 and that is what made its null credible.
 *
 * CLUSTERING: standard errors on the excess return are clustered BY SESSION. Hundreds of names
 *   share each day's market move, so a per-row t is inflated by roughly sqrt(names-per-day).
 *
 * DECISION RULE — fixed before any result
 *   SIGNAL   if test AUC >= 0.52 AND exceeds the shuffled control by >= 0.015 at the primary
 *            20-session horizon, AND the top-minus-bottom decile spread is positive with a
 *            session-clustered t >= 2.5 (Bonferroni over the 3 horizons tested).
 *   NO SKILL if test AUC is within 0.01 of the shuffled control.
 *   Otherwise NOT-ESTABLISHED.
 *
 * EXPECTED OUTCOME, ON THE RECORD: I expect a small but real edge at the 20-day horizon —
 * AUC around 0.51-0.53 — because #35 already found this family survives correction, and a
 * longer horizon should hurt it less than the daily turnover that shelved it. I expect the
 * 1-day horizon to look best on AUC and be worthless after cost, which is exactly the trap
 * #35 fell into. If the 20-day horizon shows nothing, the structural category has failed its
 * first honest test in this project and that is a genuine update.
 *
 * WHAT THIS CANNOT SETTLE. AUC is not money. A positive result here licenses a cost-and-
 * capacity study, not a trade. Test #35's whole lesson was that a real signal can be
 * unharvestable, and nothing in this file measures fills.
 *
 * Usage: node backend/structural-model.js
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const IN = D("structural-dataset.json");
const HORIZONS = [1, 5, 20], PRIMARY = 20;
const AUC_BAR = 0.52, CONTROL_MARGIN = 0.015, T_BAR = 2.5;   // Bonferroni over 3 horizons
const FEATS = ["svr", "svrZ", "svrPctile", "svrChg5", "svrVol20", "exemptRatio", "volPctile"];

const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };

/** Deterministic PRNG so the shuffled control is reproducible. */
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function shuffled(arr, seed) { const a = arr.slice(), r = rng(seed); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/** AUC via the rank identity — O(n log n), and exact rather than trapezoid-approximated. */
function auc(scores, labels) {
  const idx = scores.map((s, i) => [s, labels[i]]).sort((a, b) => a[0] - b[0]);
  let rankSum = 0, nPos = 0, nNeg = 0, i = 0;
  while (i < idx.length) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) { if (idx[k][1] === 1) { rankSum += avgRank; nPos++; } else nNeg++; }
    i = j + 1;
  }
  return (nPos === 0 || nNeg === 0) ? 0.5 : (rankSum - nPos * (nPos + 1) / 2) / (nPos * nNeg);
}

/** Logistic regression, batch gradient descent with L2. Small and legible on purpose. */
function fitLogit(X, y, { iters = 400, lr = 0.5, l2 = 1e-3 } = {}) {
  const n = X.length, p = X[0].length;
  let w = new Array(p).fill(0), b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(p).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b; for (let k = 0; k < p; k++) z += w[k] * X[i][k];
      const err = 1 / (1 + Math.exp(-z)) - y[i];
      for (let k = 0; k < p; k++) gw[k] += err * X[i][k];
      gb += err;
    }
    for (let k = 0; k < p; k++) w[k] -= lr * (gw[k] / n + l2 * w[k]);
    b -= lr * (gb / n);
  }
  return { w, b };
}
const score = (m, x) => { let z = m.b; for (let k = 0; k < x.length; k++) z += m.w[k] * x[k]; return z; };

/** t-stat on the decile spread, CLUSTERED BY SESSION. */
function clusteredT(rows, scores, h) {
  const byDay = new Map();
  rows.forEach((r, i) => { const a = byDay.get(r.entryDate) || []; a.push({ s: scores[i], y: r["fwd" + h] }); byDay.set(r.entryDate, a); });
  const perDay = [];
  for (const [, arr] of byDay) {
    if (arr.length < 20) continue;                       // need a real cross-section to form deciles
    arr.sort((a, b) => a.s - b.s);
    const k = Math.max(1, Math.floor(arr.length / 10));
    perDay.push(mean(arr.slice(-k).map(x => x.y)) - mean(arr.slice(0, k).map(x => x.y)));
  }
  if (perDay.length < 10) return { spread: null, t: null, days: perDay.length };
  const m = mean(perDay), s = sd(perDay);
  return { spread: m, t: s > 0 ? m / (s / Math.sqrt(perDay.length)) : null, days: perDay.length };
}

(async () => {
  if (!fs.existsSync(IN)) { console.error(`\n  ${IN} not found — run backend/structural-data-gen.js first.\n`); process.exit(1); }
  const ds = JSON.parse(fs.readFileSync(IN, "utf8"));
  const rows = ds.rows;
  console.log(`\n  TEST #52 — STRUCTURAL SELECTION MODEL`);
  console.log(`  pre-registered 2026-07-28, before the dataset finished building`);
  console.log(`  ${rows.length.toLocaleString()} rows · features: ${FEATS.join(" · ")}`);
  console.log(`  labels are MARKET-ADJUSTED (excess of SPY over the identical window)\n`);

  const dates = [...new Set(rows.map(r => r.entryDate))].sort();
  const cut = dates[Math.floor(dates.length * 0.70)];
  const tr = rows.filter(r => r.entryDate <= cut), te = rows.filter(r => r.entryDate > cut);
  console.log(`  chronological split at ${cut}:  train ${tr.length.toLocaleString()} · test ${te.length.toLocaleString()}`);
  console.log(`  train ${dates[0]} → ${cut}   test ${cut} → ${dates[dates.length - 1]}\n`);

  // standardise on TRAIN statistics only — using test moments would leak
  const mu = {}, sg = {};
  for (const f of FEATS) { const v = tr.map(r => r[f]); mu[f] = mean(v); sg[f] = sd(v) || 1; }
  const mat = (rs) => rs.map(r => FEATS.map(f => (r[f] - mu[f]) / sg[f]));
  const Xtr = mat(tr), Xte = mat(te);

  console.log(`  horizon   test AUC   shuffled control   gap      decile spread   clustered t   sessions`);
  console.log(`  ${"".padEnd(88, "─")}`);
  const results = {};
  for (const h of HORIZONS) {
    const ytr = tr.map(r => r["fwd" + h] > 0 ? 1 : 0);
    const yte = te.map(r => r["fwd" + h] > 0 ? 1 : 0);
    const m = fitLogit(Xtr, ytr);
    const sTe = Xte.map(x => score(m, x));
    const a = auc(sTe, yte);

    // control: identical pipeline, labels shuffled WITHIN the training set
    const mc = fitLogit(Xtr, shuffled(ytr, 20260728));
    const aC = auc(Xte.map(x => score(mc, x)), yte);

    const c = clusteredT(te, sTe, h);
    results[h] = { auc: a, control: aC, gap: a - aC, ...c };
    console.log(`  ${String(h).padStart(4)}d     ${a.toFixed(4)}     ${aC.toFixed(4)}        ${(a - aC >= 0 ? "+" : "") + (a - aC).toFixed(4)}   ${c.spread == null ? "     —" : ((c.spread >= 0 ? "+" : "") + (100 * c.spread).toFixed(3) + "%").padStart(9)}   ${(c.t == null ? "—" : c.t.toFixed(2)).padStart(8)}      ${c.days}`);
  }

  const P = results[PRIMARY];
  const gates = {
    auc: P.auc >= AUC_BAR,
    control: P.gap >= CONTROL_MARGIN,
    spread: P.spread != null && P.spread > 0 && P.t != null && P.t >= T_BAR,
  };
  console.log(`\n  ══ ADJUDICATION at the ${PRIMARY}-session primary horizon ══`);
  console.log(`  ${gates.auc ? "✓" : "✗"} test AUC ≥ ${AUC_BAR}                    ${P.auc.toFixed(4)}`);
  console.log(`  ${gates.control ? "✓" : "✗"} beats shuffled control by ≥ ${CONTROL_MARGIN}   ${(P.gap >= 0 ? "+" : "") + P.gap.toFixed(4)}`);
  console.log(`  ${gates.spread ? "✓" : "✗"} decile spread > 0 with t ≥ ${T_BAR}       ${P.spread == null ? "—" : (100 * P.spread).toFixed(3) + "%, t " + (P.t == null ? "—" : P.t.toFixed(2))}`);

  const verdict = Math.abs(P.gap) < 0.01 ? `NO SKILL — test AUC ${P.auc.toFixed(4)} is within 0.01 of the shuffled control ${P.control.toFixed(4)}. Order-flow disclosure predicts no better than chart shapes did in #39, and the structural category has failed its first honest predictive test here.`
    : Object.values(gates).every(Boolean) ? `SIGNAL — clears every pre-registered gate. This licenses a COST AND CAPACITY study, not a trade: #35 proved a real signal in this exact family can still be unharvestable, and nothing here measures a fill.`
      : `NOT-ESTABLISHED — ${Object.entries(gates).filter(([, v]) => !v).map(([k]) => k).join(", ")} gate(s) failed.`;
  console.log(`\n  VERDICT: ${verdict}\n`);

  fs.writeFileSync(D("structural-model-52.json"), JSON.stringify({
    generated: new Date().toISOString(), test: 52,
    preRegistered: "2026-07-28, written while structural-data-gen.js was still fetching so the spec could not be tuned to the data.",
    contrastWith39: "#39 used 19 PRICE/VOLUME features and returned AUC 0.5013 vs a 0.4979 control. This uses 7 ORDER-FLOW DISCLOSURE features on the same kind of pipeline.",
    model: "logistic regression, standardised on train moments only — deliberately linear so a positive result is about the data, not the learner",
    split: { type: "chronological", cut, trainRows: tr.length, testRows: te.length },
    features: FEATS, horizons: HORIZONS, primary: PRIMARY,
    bars: { auc: AUC_BAR, controlMargin: CONTROL_MARGIN, t: T_BAR },
    results, gates, verdict,
    caveats: [
      "AUC is not money. A positive result licenses a cost/capacity study, never a trade.",
      "FINRA short volume covers consolidated-tape prints; it is not the same as short INTEREST and it says nothing about position size or holding period.",
      "The universe is 220 liquid large caps and excludes ETFs — capacity and borrow behaviour differ elsewhere.",
      "Publication lag is honoured at t+1, but intraday-lag effects within that session are not modelled.",
    ],
  }, null, 1));
  console.log(`  written: backend/data/structural-model-52.json\n`);
})();
