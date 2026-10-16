#!/usr/bin/env node
/**
 * ML DAILY PASS — movement, not verdicts. (2026-08-25)
 *
 * Every other automated job in this shop asks "is there an edge?" and answers fresh each night.
 * This one asks a different question: WHAT MOVED SINCE YESTERDAY, and is the move bigger than the
 * noise in the estimate? Most days the honest answer is "nothing moved outside its error bar," and
 * printing that plainly is the point — a shop that reports a new number every night eventually
 * reports one that looks like progress purely because it resampled.
 *
 * Everything here reads the canonical ledger through lib/reconcile.js. No source selection, no
 * private filters. See that file's header for why that rule exists (the same quantity was reported
 * three times on 2026-08-24 and was wrong twice, both times because analysis code picked its own
 * source).
 *
 * FOUR THINGS THIS IS CAREFUL ABOUT
 *
 * 1. EFFECTIVE N IS SESSIONS, NOT TICKETS. Every t-statistic here is computed on per-session
 *    quantities and reports the session count next to it. This shop has been burned three times by
 *    effective-N inflation — a congressional-trade t=12 that went to zero de-overlapped, a vendor's
 *    904 "wins" drawn from 688 signals, and twelve correlated alt-coins closing at exactly +2.00R in
 *    one session. reconcile.deClusteredEdge() is reported alongside, because episodes are stricter
 *    than sessions where a single basket spans days.
 *
 * 2. THE NULL IS PERMUTATION, WITHIN DAYS. A model is graded against labels shuffled inside each
 *    session, which destroys any prediction-outcome association while preserving the day structure
 *    and the day-size imbalance. If the fitted model does not beat its own shuffled twin, it is
 *    noise and this file says so in those words.
 *
 * 3. COVERAGE IS CONDITIONED ON CLASS. Short interest, dark-pool share, insider flow, earnings dates
 *    and single-name skew are UNDEFINED for BTC and for /ES. Reporting them as "8.9% covered" across
 *    a ledger that is 56% non-equity understates them and points the fix at the wrong place. They
 *    are reported per class, and the denominator is stated.
 *
 * 4. NOTHING HERE IS ENFORCED. The improvement attempt in section 5 is graded as a SHADOW against
 *    the live book and written to alpha-hunt-queue.json as a proposal with a bar fixed BEFORE the
 *    evidence is read. This file proposes; the operator registers.
 *
 * writes: data/ml-daily.json (full state) · data/ml-scorecard.jsonl (one line per run, append-only)
 */
const fs = require("fs"), path = require("path");
const RC = require("./lib/reconcile.js");
const L2 = require("./lib/gbm.js");
const MLF = require("./lib/ml-features.js");   // 2026-09-01: per-ticket feature pruning, outcome-blind
const IMPROVE = require("./lib/ml-improve.js");     // MLI-1, retired 2026-08-26 — kept for the record
const IMPROVE2 = require("./lib/ml-improve2.js");   // MLI-2, retired 2026-08-28 — kept for the record
const IMPROVE3 = require("./lib/ml-improve3.js");   // MLI-3, this run's attempt

const D = (f) => path.join(__dirname, "data", f);
const OUT = D("ml-daily.json"), CARD = D("ml-scorecard.jsonl"), QUEUE = D("alpha-hunt-queue.json");
const et = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(4));
const r2 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(2));

/** t on a set of per-session quantities. The unit IS the session; n is returned so it is never lost. */
function tstat(xs) {
  const a = xs.filter(Number.isFinite);
  if (a.length < 2) return { t: null, n: a.length, mean: a.length ? r4(mean(a)) : null, se: null };
  const s = sd(a), se = s / Math.sqrt(a.length);
  return { t: se > 0 ? r2(mean(a) / se) : null, n: a.length, mean: r4(mean(a)), se: r4(se) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 0. CANONICAL READ
// ─────────────────────────────────────────────────────────────────────────────
const LED = RC.cleanEraLedger();
const DECL = RC.deClusteredEdge();
const JLAG = RC.journalLag();

const ALL = [...LED.signals, ...LED.controls];
// SETTLEMENT session — these are realized outcomes, so "the last 5 sessions" means the last 5
// sessions in which money was actually booked, not the last 5 in which a trade was opened.
const closeDay = (t) => et(t.closedAt);
const openDay = (t) => et(t.openedAt);
const closeSessions = [...new Set(ALL.map(closeDay))].sort();

/** win rate / mean R / P&L over the signal arm, restricted to the last k settlement sessions. */
function window_(k) {
  const days = k == null ? closeSessions : closeSessions.slice(-k);
  const set = new Set(days);
  const sig = LED.signals.filter((t) => set.has(closeDay(t)));
  const ctl = LED.controls.filter((t) => set.has(closeDay(t)));
  const R = sig.map((t) => t.rMult), P = sig.map((t) => t.pnl).filter(Number.isFinite);
  const wins = sig.filter((t) => t.rMult > 0).length;
  // per-session means: the honest unit for a t, and what the error bars below are built from
  const bySess = {};
  for (const t of sig) (bySess[closeDay(t)] ||= []).push(t.rMult);
  const sessMeanR = Object.values(bySess).map(mean);
  const sessWin = Object.values(bySess).map((rs) => (rs.filter((x) => x > 0).length / rs.length) * 100);
  /**
   * P&L ERROR BAR (added 2026-09-04). The daily move in CUMULATIVE P&L was the one headline figure
   * printed with no bar beside it, so every night it read as a bald dollar number and invited being
   * treated as a result. The delta is approximately ONE new session's contribution, so the
   * honest bar is the SD of a single session's P&L — NOT the SE of the mean, which would be
   * sqrt(n) too tight and would flag ordinary days as movement.
   */
  const bySessP = {};
  for (const t of sig) if (Number.isFinite(t.pnl)) (bySessP[closeDay(t)] ||= []).push(t.pnl);
  const sessPnl = Object.values(bySessP).map((ps) => ps.reduce((s2, x) => s2 + x, 0));
  return {
    sessions: days.length, tickets: sig.length, controlTickets: ctl.length,
    winRatePct: sig.length ? r2((wins / sig.length) * 100) : null,
    meanR: r4(mean(R)), totalPnl: P.length ? +P.reduce((s, x) => s + x, 0).toFixed(2) : null,
    // error bars on the SESSION unit, so a 20-session window is treated as ~20 observations
    seMeanR_session: sessMeanR.length > 1 ? r4(sd(sessMeanR) / Math.sqrt(sessMeanR.length)) : null,
    seWinPct_session: sessWin.length > 1 ? r2(sd(sessWin) / Math.sqrt(sessWin.length)) : null,
    sdPnl_session: sessPnl.length > 1 ? r2(sd(sessPnl)) : null,
    tMeanR_session: tstat(sessMeanR).t, sessionsScored: sessMeanR.length,
  };
}

/**
 * SIGNAL-MINUS-CONTROL EDGE, two ways.
 *   pooled        — mean(signal) - mean(control) over every ticket. The board's headline figure.
 *   day-clustered — the same difference computed WITHIN each session that carries both arms, then
 *                   averaged across sessions with a t on the per-session differences. Effective N is
 *                   the number of such sessions, and it is reported next to the t every time.
 * Clustering is on the OPEN day: a control is created alongside its signal at decision time, so the
 * open day is the unit on which the two arms are actually comparable.
 */
function edge(rows) {
  const sig = rows.filter((t) => !t.ctrl), ctl = rows.filter((t) => t.ctrl);
  const sm = mean(sig.map((t) => t.rMult)), cm = mean(ctl.map((t) => t.rMult));
  const bySess = {};
  for (const t of rows) ((bySess[openDay(t)] ||= { s: [], c: [] })[t.ctrl ? "c" : "s"]).push(t.rMult);
  const diffs = [], paired = [];
  for (const [d, o] of Object.entries(bySess)) {
    if (!o.s.length || !o.c.length) continue;
    diffs.push(mean(o.s) - mean(o.c));
    paired.push({ day: d, nSig: o.s.length, nCtl: o.c.length, diffR: r4(mean(o.s) - mean(o.c)) });
  }
  const T = tstat(diffs);
  /**
   * THIN-SESSION GUARD (added 2026-09-02). The day-clustered mean gives every session equal
   * weight, so a session whose control arm holds two tickets counts as much as one holding 84.
   * On 2026-09-02 that produced a false alarm: a partial, still-settling session (6 signals,
   * 2 controls, diffR -1.11) moved the 28-session mean by -0.09R and tripped the "outside its
   * error bar" flag on the headline. Every guard from 3 per side upward reads flat.
   *
   * The guard is REPORTED ALONGSIDE, never in place of, the unguarded figure — seven prior
   * scorecard lines carry the unguarded statistic and silently redefining it would break the
   * only series this file exists to produce. The floor is 3 per side, chosen a priori as the
   * smallest arm on which a mean is not dominated by one ticket, NOT scoped on the outcome;
   * the whole ladder is emitted so the choice can be checked rather than trusted.
   */
  const GUARD = 3;
  const guardedRows = paired.filter((p) => p.nSig >= GUARD && p.nCtl >= GUARD);
  const G = tstat(guardedRows.map((p) => p.diffR));
  const ladder = [3, 5, 8, 10, 15].map((k) => {
    const t = tstat(paired.filter((p) => p.nSig >= k && p.nCtl >= k).map((p) => p.diffR));
    return { minArmPerSide: k, edgeR: t.mean, t: t.t, sessions: t.n };
  });
  return {
    pooledEdgeR: sm == null || cm == null ? null : r4(sm - cm),
    pooledTickets: { signals: sig.length, controls: ctl.length },
    dayClusteredEdgeR: T.mean, dayClusteredT: T.t, sessionsWithBothArms: T.n, seDayClustered: T.se,
    guarded: {
      minArmPerSide: GUARD,
      dayClusteredEdgeR: G.mean, dayClusteredT: G.t, sessionsWithBothArms: G.n, seDayClustered: G.se,
      sessionsDroppedThin: T.n - G.n,
      thinSessions: paired.filter((p) => p.nSig < GUARD || p.nCtl < GUARD).map((p) => ({ day: p.day, nSig: p.nSig, nCtl: p.nCtl, diffR: p.diffR })),
      ladder,
      note: "reported alongside the unguarded figure, which remains the series of record",
    },
    sessionsTotal: Object.keys(bySess).length,
    sessionsMissingAnArm: Object.keys(bySess).length - T.n,
    perSession: paired.sort((a, b) => (a.day < b.day ? -1 : 1)),
  };
}

const windows = { last5: window_(5), last20: window_(20), allClean: window_(null) };
const edges = {
  allClean: edge(ALL),
  last20: (() => { const s = new Set(closeSessions.slice(-20)); return edge(ALL.filter((t) => s.has(closeDay(t)))); })(),
  last5: (() => { const s = new Set(closeSessions.slice(-5)); return edge(ALL.filter((t) => s.has(closeDay(t)))); })(),
};

/**
 * REAL RECONCILIATION. edge() above recomputes the pooled signal-minus-control figure from scratch
 * over the same rows, with its own grouping and its own means. If that independent path disagrees
 * with lib/reconcile.js by more than a rounding step, this file must not print a number — that is
 * precisely the failure mode of 2026-08-24, where three readers of one quantity gave three answers.
 * A self-comparison would satisfy the call and check nothing, so the two paths are kept separate.
 */
RC.assertReconciled("pooled signal-minus-control edge (independent recompute)", edges.allClean.pooledEdgeR, LED.pooledEdgeR, { tolerance: 1e-4, log: false });
RC.assertReconciled("signal ticket count", edges.allClean.pooledTickets.signals, LED.n, { log: false });
RC.assertReconciled("control ticket count", edges.allClean.pooledTickets.controls, LED.controlN, { log: false });
RC.assertReconciled("win rate, all clean era", windows.allClean.winRatePct, LED.winRatePct, { tolerance: 0.05, log: false });

// ─────────────────────────────────────────────────────────────────────────────
// 1. COVERAGE — per observer, per class, with the denominator stated
// ─────────────────────────────────────────────────────────────────────────────
const STRUCTURAL = ["svrZ", "shortPct", "atsPct", "newsScore", "insiderNet90", "erDays", "skewRR", "insiderXP"];
// These eight are EQUITY-DEFINED. Short interest, dark-pool share, insider filings, earnings dates
// and single-name option skew do not exist for BTC, /ES or EURUSD. Measuring them against a ledger
// that is 56% non-equity is not a coverage number, it is a class-mix number wearing one's clothes.
const EQUITY_ONLY = new Set(STRUCTURAL);
const rowsWithObs = ALL.filter((t) => t.obs);
const eq = rowsWithObs.filter((t) => t.cls === "Equity");

function coverage(rows) {
  const cov = {};
  for (const t of rows) for (const [k, v] of Object.entries(t.obs)) if (Number.isFinite(v)) cov[k] = (cov[k] || 0) + 1;
  return cov;
}
const covAll = coverage(rowsWithObs), covEq = coverage(eq);
const BAKEOFF_BAR = 0.30;   // model-bakeoff.js FEATS filter — n >= rows.length * 0.3

const coverageReport = {};
for (const k of STRUCTURAL) {
  const nA = covAll[k] || 0, nE = covEq[k] || 0;
  coverageReport[k] = {
    allRowsPct: r2((100 * nA) / rowsWithObs.length), allRowsN: nA, allRowsDenom: rowsWithObs.length,
    equityPct: r2((100 * nE) / eq.length), equityN: nE, equityDenom: eq.length,
    clearsBakeoffBar_allRows: nA / rowsWithObs.length >= BAKEOFF_BAR,
    clearsBakeoffBar_equityOnly: nE / eq.length >= BAKEOFF_BAR,
  };
}
// the joint question: how often are all eight present at once?
const all8All = rowsWithObs.filter((t) => STRUCTURAL.every((k) => Number.isFinite(t.obs[k]))).length;
const all8Eq = eq.filter((t) => STRUCTURAL.every((k) => Number.isFinite(t.obs[k]))).length;

// per-open-session equity stamp rate — this is how a stamp regression becomes visible as a DATE
const stampByDay = {};
for (const t of eq) {
  const d = openDay(t);
  const o = (stampByDay[d] ||= { equityRows: 0 });
  o.equityRows++;
  for (const k of STRUCTURAL) if (Number.isFinite(t.obs[k])) o[k] = (o[k] || 0) + 1;
}
const classMix = {};
for (const t of ALL) classMix[t.cls || "?"] = (classMix[t.cls || "?"] || 0) + 1;

// ─────────────────────────────────────────────────────────────────────────────
// 2. MODEL — walk-forward, day-clustered, against a within-day permutation null
// ─────────────────────────────────────────────────────────────────────────────
/**
 * The fit mirrors model-bakeoff.js exactly (same row filter, same purge, same learners) so the two
 * cannot drift and report different skill for the same models. What is ADDED here is the null:
 * model-bakeoff compares the better of two models to a variance-based bar; this permutes the labels
 * within each session 400 times and asks how often shuffled labels produce a day-corr t at least as
 * large. A model that cannot beat its own shuffled twin is noise, and it is named as such.
 */
const log = JSON.parse(fs.readFileSync(D("trade_log.json"), "utf8"));
const mrows = log.filter((t) => Number.isFinite(t.rMult) && t.openedAt && et(t.openedAt) >= "2026-07-20" && t.obs && t.cls !== "Options" && !/r2[145]/.test(t.id || "") && t.sleeve !== "R24-v1");
const EXCLUDE = /^(modelScore|modelRank|wComposite|bakeoff)/;
const mcov = {}; for (const t of mrows) for (const [k, v] of Object.entries(t.obs)) if (Number.isFinite(v) && !EXCLUDE.test(k)) mcov[k] = (mcov[k] || 0) + 1;
// 2026-09-24 (weekly audit 2026-09-23, ml lens): same guard as model-bakeoff.js — lib/feature-manifest.js refuses the post-entry news-stamp family.
const FM = require("./lib/feature-manifest.js");
const ADMIT = FM.admitBoardObs(Object.entries(mcov).filter(([, n]) => n >= mrows.length * BAKEOFF_BAR).map(([k]) => k).sort());
const FEATS = ADMIT.keep; FM.assertBoardObsAdmissible(FEATS);
const CLS = ["Equity", "Crypto", "Futures", "FX"];
const vec = (t) => [...FEATS.map((k) => (Number.isFinite(t.obs[k]) ? t.obs[k] : NaN)), t.dir > 0 ? 1 : -1, t.ctrl ? 1 : 0, ...CLS.map((c) => (t.cls === c ? 1 : 0))];
const X = mrows.map(vec), y = mrows.map((t) => t.rMult), mday = mrows.map((t) => et(t.openedAt));
/**
 * PRUNED FEATURE SET — 2026-09-01. lib/ml-features.js keeps only observers that VARY WITHIN A
 * SESSION (variance share >= 0.5, >= 2 distinct values per session). Tonight that drops 22 of 43:
 * every market-level field (vix, y10, curve, breadth50, regimeId ...) carries one value per session,
 * i.e. 28 data points dressed as 2,177 rows. The selection reads no outcome. Both sets are fitted
 * and reported side by side: `ridge`/`gbm` (full, unchanged, comparable to every prior night) and
 * `ridgeTicket`/`gbmTicket` (pruned). Neither is trusted until it beats its own null.
 */
const PRUNE = MLF.perTicket(mrows, FEATS, (t) => et(t.openedAt));
const FEATS_T = PRUNE.keep; FM.assertBoardObsAdmissible(FEATS_T);
const vecT = (t) => [...FEATS_T.map((k) => (Number.isFinite(t.obs[k]) ? t.obs[k] : NaN)), t.dir > 0 ? 1 : -1, t.ctrl ? 1 : 0, ...CLS.map((c) => (t.cls === c ? 1 : 0))];
const XT = mrows.map(vecT);
// DIRECTION IS A MODEL FEATURE (see vec above), so it must also be a NULL STRATUM. See the note on
// permutation strata in modelMetrics() for why a day-only shuffle credits long/short asymmetry as skill.
const mdir = mrows.map((t) => (t.dir > 0 ? 1 : -1));
const msessions = [...new Set(mday)].sort(), sIdx = Object.fromEntries(msessions.map((s, i) => [s, i]));
const PURGE = 1, MIN_TRAIN = 8;

const pred = { ridge: new Array(mrows.length).fill(null), gbm: new Array(mrows.length).fill(null), ridgeT: new Array(mrows.length).fill(null), gbmT: new Array(mrows.length).fill(null) };
let folds = 0;
for (let k = MIN_TRAIN; k < msessions.length; k++) {
  const train = mrows.map((_, i) => i).filter((i) => sIdx[mday[i]] <= k - 1 - PURGE);
  const test = mrows.map((_, i) => i).filter((i) => sIdx[mday[i]] === k);
  if (train.length < 100 || !test.length) continue;
  const rm = L2.ridgeFit(X, y, train), gm = L2.gbmFit(X, y, train, { rounds: 60, lr: 0.1, depth: 2 });
  const rmT = L2.ridgeFit(XT, y, train), gmT = L2.gbmFit(XT, y, train, { rounds: 60, lr: 0.1, depth: 2 });
  for (const i of test) {
    pred.ridge[i] = L2.ridgePredict(rm, X[i]); pred.gbm[i] = L2.gbmPredict(gm, X[i]);
    pred.ridgeT[i] = L2.ridgePredict(rmT, XT[i]); pred.gbmT[i] = L2.gbmPredict(gmT, XT[i]);
  }
  folds++;
}
const corr = (a, b) => { const n = a.length; if (n < 3) return null; const ma = mean(a), mb = mean(b); let s = 0, sa = 0, sb = 0; for (let i = 0; i < n; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; } return sa && sb ? s / Math.sqrt(sa * sb) : null; };

/** day-corr t on a prediction vector against an arbitrary label vector (used for real AND shuffled) */
function dayCorrT(p, labels, idx, byDay) {
  const cs = [];
  for (const ids of Object.values(byDay)) {
    if (ids.length < 5) continue;
    const c = corr(ids.map((i) => p[i]), ids.map((i) => labels[i]));
    if (c != null) cs.push(c);
  }
  if (cs.length < 2) return { t: null, n: cs.length, mean: null };
  const s = sd(cs), se = s / Math.sqrt(cs.length);
  return { t: se > 0 ? mean(cs) / se : null, n: cs.length, mean: mean(cs) };
}

function modelMetrics(p, name) {
  const idx = mrows.map((_, i) => i).filter((i) => p[i] != null);
  if (idx.length < 30) return { model: name, n: idx.length, note: "too few forward predictions" };
  const byDay = {}; for (const i of idx) (byDay[mday[i]] ||= []).push(i);
  const real = dayCorrT(p, y, idx, byDay);
  // 2026-09-04 (ML lens): the pooled figure borrows precision from CONTROL rows (they double each day cell); no gate acts on a control.
  // Tonight: pooled t -1.63 over 22 sessions, signals-only t -0.60 over 18. Both are reported; the pooled series stays the series of record.
  const idxS = idx.filter((i) => !mrows[i].ctrl); const byDayS = {}; for (const i of idxS) (byDayS[mday[i]] ||= []).push(i);
  const realS = idxS.length >= 30 ? dayCorrT(p, y, idxS, byDayS) : { t: null, n: idxS.length, mean: null };
  const ord = [...idx].sort((a, b) => p[a] - p[b]); const dec = Math.max(1, Math.floor(ord.length / 10));
  const top = mean(ord.slice(-dec).map((i) => y[i])), bot = mean(ord.slice(0, dec).map((i) => y[i]));
  // ── permutation null, shuffled within DAY x DIRECTION (corrected 2026-08-26) ──
  /**
   * WHY THE STRATUM IS DAY x DIRECTION AND NOT DAY ALONE.
   *
   * `dir` is an explicit column of the design matrix (see vec()). Measured on today's model rows,
   * longs average +0.0548R and shorts -0.0930R, and the within-day long-minus-short gap is +0.1735R
   * (t 1.72 over 22 sessions) — and every one of the 22 scored sessions carries BOTH directions.
   * A null that shuffles labels within a day only DESTROYS that asymmetry in the labels while the
   * model keeps it in its predictions. The model is then scored against a world in which the one
   * relationship it has actually learned does not exist, and a fit that has learned nothing beyond
   * "long beat short this era" reads as forward skill.
   *
   * This shop has already been burned by exactly this: a day-only null certified 0.61 of an AUC that
   * was pure long/short asymmetry. Shuffling within day x direction preserves the asymmetry in the
   * null, so the model is credited only for ranking tickets WITHIN a direction on a day — which is
   * the only thing a live board could act on that direction alone does not already give it.
   *
   * THE TEST IS ALSO ONE-SIDED NOW. The prior build compared |t| to |t|, so a model whose forward
   * day-correlation was NEGATIVE could be reported as beating its null: on 2026-08-26 the GBM was
   * written to the scorecard with dayCorrT -1.85, p 0.0474 and beatsNull TRUE. A reliably
   * anti-predictive model is a finding, but it is not skill, and the field a reader scans must not
   * say it is. Credit requires t > 0 and an upper-tail p; the two-sided figure is kept alongside.
   */
  const TRIALS = 400;
  let geOne = 0, geTwo = 0; const nullTs = [];
  // a deterministic LCG: the null must be reproducible run to run, or its bar moves under us
  let seed = 20260825;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const strata = {};
  for (const i of idx) (strata[mday[i] + "|" + mdir[i] + "|" + (mrows[i].ctrl ? 1 : 0) + "|" + (mrows[i].cls || "?")] ||= []).push(i);   // 2026-09-04 (ML lens): isCtrl and the class dummies are design columns too — the argument above for dir applies verbatim (p 0.0499 -> 0.0324 tonight; tighter, not looser)
  const stratumSizes = Object.values(strata).map((s) => s.length);
  for (let tr = 0; tr < TRIALS; tr++) {
    const sh = y.slice();
    for (const ids of Object.values(strata)) {           // shuffle within DAY x DIRECTION
      const vals = ids.map((i) => y[i]);
      for (let i = vals.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [vals[i], vals[j]] = [vals[j], vals[i]]; }
      ids.forEach((i, k2) => { sh[i] = vals[k2]; });
    }
    const nt = dayCorrT(p, sh, idx, byDay).t;
    if (nt != null) {
      nullTs.push(nt);
      if (nt >= (real.t ?? 0)) geOne++;                  // upper tail: skill has a sign
      if (Math.abs(nt) >= Math.abs(real.t ?? 0)) geTwo++;
    }
  }
  const sorted = [...nullTs].sort((a, b) => a - b);
  const q = (arr, f) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * f))] : null);
  const t95 = q(sorted, 0.95);                           // upper-tail bar matching the one-sided p
  const absT95 = q([...nullTs.map(Math.abs)].sort((a, b) => a - b), 0.95);
  const pval = nullTs.length ? (geOne + 1) / (nullTs.length + 1) : null;
  const pTwo = nullTs.length ? (geTwo + 1) / (nullTs.length + 1) : null;
  const beats = pval != null && pval < 0.05 && (real.t ?? 0) > 0;
  return {
    model: name, forwardTickets: idx.length, forwardSessions: Object.keys(byDay).length,
    r: r4(corr(idx.map((i) => p[i]), idx.map((i) => y[i]))),
    decileSpreadR: r4(top - bot),
    dayCorrMean: r4(real.mean), dayCorrT: r2(real.t), daysScored: real.n,
    dayCorrMean_signalsOnly: r4(realS.mean), dayCorrT_signalsOnly: r2(realS.t), daysScored_signalsOnly: realS.n,
    nullShuffle: "day x direction x ctrl x class",
    nullStrata: Object.keys(strata).length,
    nullMedianStratum: stratumSizes.length ? stratumSizes.sort((a, b) => a - b)[Math.floor(stratumSizes.length / 2)] : null,
    nullTrials: nullTs.length, nullT95: r2(t95), nullAbsT95: r2(absT95),
    permutationP: r4(pval), permutationP_twoSided: r4(pTwo), permutationSided: "one (upper tail)",
    beatsNull: beats,
    // said in words, because this is the sentence that matters
    read: pval == null ? "null not computable"
      : beats ? `beats its day x direction permutation null (one-sided p=${r4(pval)}, ${real.n} sessions)`
      : (real.t ?? 0) <= 0 ? `DOES NOT beat its own null — day-corr t ${r2(real.t)} is NEGATIVE, so there is no skill to credit whatever the two-sided p says (two-sided p=${r4(pTwo)}, one-sided p=${r4(pval)}, ${real.n} sessions). A reliably anti-predictive model is a finding, not forward skill.`
      : `DOES NOT beat its own null — day-corr t ${r2(real.t)} vs shuffled t 95th pctl ${r2(t95)}, one-sided p=${r4(pval)} over ${real.n} sessions. This is noise; a model that only matches shuffled labels has no forward skill.`,
  };
}
const models = { ridge: modelMetrics(pred.ridge, "ridge"), gbm: modelMetrics(pred.gbm, "gbm"),
  ridgeTicket: modelMetrics(pred.ridgeT, "ridgeTicket"), gbmTicket: modelMetrics(pred.gbmT, "gbmTicket") };

// ─────────────────────────────────────────────────────────────────────────────
// 3. DELTAS — against the previous run, not against a fresh verdict
// ─────────────────────────────────────────────────────────────────────────────
/**
 * The baseline is the last run from an EARLIER DAY, never an earlier run today. Re-running the pass
 * on the same afternoon must not manufacture a row of zero deltas that reads as "nothing moved" —
 * nothing moved because nothing settled in between, which is a different statement and a useless one.
 */
let prev = null, priorLines = [];
try {
  priorLines = fs.readFileSync(CARD, "utf8").trim().split("\n").filter(Boolean);
  const today = et(Date.now());
  for (let i = priorLines.length - 1; i >= 0; i--) {
    try { const r = JSON.parse(priorLines[i]); if (r.runDay !== today) { prev = r; break; } } catch {}
  }
} catch {}

/**
 * A delta is INSIDE ITS ERROR BAR when it is smaller than one standard error of the current
 * estimate — i.e. the two runs are not distinguishable and the move is resampling, not progress.
 * Most daily moves will land here. Saying so is the honest report, not a failed one.
 */
function delta(now, before, se) {
  if (before == null || now == null) return { now, prev: before ?? null, delta: null, insideErrorBar: null, note: "no prior run" };
  const d = +(now - before).toFixed(4);
  return { now, prev: before, delta: d, se: se ?? null, insideErrorBar: se != null && Number.isFinite(se) ? Math.abs(d) <= se : null };
}
const movement = {
  winRatePct: delta(windows.allClean.winRatePct, prev?.allClean?.winRatePct, windows.allClean.seWinPct_session),
  meanR: delta(windows.allClean.meanR, prev?.allClean?.meanR, windows.allClean.seMeanR_session),
  totalPnl: delta(windows.allClean.totalPnl, prev?.allClean?.totalPnl, windows.allClean.sdPnl_session),
  pooledEdgeR: delta(edges.allClean.pooledEdgeR, prev?.edgeAllClean?.pooledEdgeR, edges.allClean.seDayClustered),
  dayClusteredEdgeR: delta(edges.allClean.dayClusteredEdgeR, prev?.edgeAllClean?.dayClusteredEdgeR, edges.allClean.seDayClustered),
  // the same move with thin sessions excluded. Where these two disagree, the disagreement IS the
  // finding: an unguarded move that vanishes under the guard was one under-populated session, not
  // a change in the book. Reads null until a prior run has written the guarded figure.
  dayClusteredEdgeR_guarded: delta(edges.allClean.guarded.dayClusteredEdgeR, prev?.edgeAllClean?.guardedEdgeR, edges.allClean.guarded.seDayClustered),
  settledRows: delta(LED.settled, prev?.settled, null),
  ridgeDayCorrT: delta(models.ridge.dayCorrT, prev?.models?.ridge?.dayCorrT, null),
  coverage: Object.fromEntries(STRUCTURAL.map((k) => [k, delta(coverageReport[k].equityPct, prev?.coverage?.[k]?.equityPct, null)])),
};
// a feature that crossed the bar since the last run is the one thing here that changes what can be MODELLED
// on the FIRST run there is no baseline, so nothing has "crossed" — an empty list is the honest
// report. Without this guard every passing feature reads as a fresh win on day one.
const crossedBar = !prev ? [] : STRUCTURAL.filter((k) => coverageReport[k].clearsBakeoffBar_equityOnly && !(prev?.coverage?.[k]?.clearsBakeoffBar_equityOnly));
const fellBelowBar = !prev ? [] : STRUCTURAL.filter((k) => !coverageReport[k].clearsBakeoffBar_equityOnly && prev?.coverage?.[k]?.clearsBakeoffBar_equityOnly);

// ─────────────────────────────────────────────────────────────────────────────
// 5. ONE IMPROVEMENT ATTEMPT — shadow only, bar fixed in code before the evidence
// ─────────────────────────────────────────────────────────────────────────────
/**
 * MLI-1 is RETIRED as the standing attempt (2026-08-26). It failed twice with a NEGATIVE day-corr t
 * (-1.79 on 08-25, -1.71 on 08-26) across a window in which the ledger gained no new settled rows,
 * and a third identical read of unchanged data is not an attempt. Its module and its bar are left
 * untouched in lib/ml-improve.js so the record of what was fixed, and when, survives.
 */
const RETIRED_MLI1 = {
  id: "MLI-1-equity-structural-ridge",
  status: "RETIRED 2026-08-26 — never cleared, never proposed, never enforced",
  reason: "failed twice with a negative day-corr t (-1.79, -1.71) on a ledger that gained no settled rows between the two reads",
  defectFoundOnReview: "its condition (a) compared |t| to |t|, so a NEGATIVE day-correlation could in principle have satisfied it. It never did (both p > 0.09), so nothing was ever proposed off that path. The bar was NOT retro-fitted — moving a bar after the evidence is the failure this apparatus exists to prevent.",
};
/**
 * MLI-2 is RETIRED as the standing attempt (2026-08-28). Unlike MLI-1 it was read three times
 * against genuinely NEW settlement (08-26, 08-27, 08-28) rather than against unchanged data, and it
 * failed on every read — the latest at day-corr t 0.30, one-sided p 0.3541, per-session lift t 0.54.
 * Three honest failures on three different books is a verdict, not a stall. Its module and its bar
 * stay untouched in lib/ml-improve2.js.
 */
const RETIRED_MLI2 = {
  id: "MLI-2-within-direction-rank",
  status: "RETIRED 2026-08-28 — never cleared, never proposed, never enforced",
  reason: "failed three reads against three genuinely different books (08-26, 08-27, 08-28); final read day-corr t 0.30, one-sided p 0.3541, per-session lift t 0.54 — the standing ridge does not rank tickets within a session once direction is held fixed",
};

/**
 * MLI-3 needs the autopsy's per-ticket cost attribution, joined by id. The cost model lives in ONE
 * place (trade-autopsy.js -> trade-autopsy.jsonl) and is read here rather than re-derived.
 */
const costById = new Map();
try {
  for (const line of fs.readFileSync(D("trade-autopsy.jsonl"), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (r && r.id && Number.isFinite(r.costR)) costById.set(r.id, { costR: r.costR, bps: r.spreadBps, stamped: r.spreadSource === "stamped" });
  }
} catch {}
const improvement = IMPROVE3.costRatioScreenShadow(LED.signals, et, costById);

/**
 * A cleared attempt becomes a PROPOSAL, never a registered test and never a board change. The queue
 * entry carries the bar that was fixed before the evidence, so the operator can see the bar was not
 * moved to fit the result. A proposal is re-stated (not duplicated) on each run that still clears.
 */
// declared here, ABOVE its first use. It was previously declared in section 4 and referenced inside
// this block — a temporal-dead-zone ReferenceError that never fired only because no attempt had ever
// cleared. The first clearing attempt would have crashed the pass at the moment it had good news.
const runAt = new Date().toISOString();

let queued = null;
if (improvement.attempted && improvement.cleared && improvement.proposalEligible !== false) {
  let q = [];
  try { const raw = JSON.parse(fs.readFileSync(QUEUE, "utf8")); q = Array.isArray(raw) ? raw : (raw.proposals || []); } catch {}
  const existing = q.findIndex((x) => x && x.id === improvement.id);
  const entry = {
    id: improvement.id,
    proposedBy: "ml-improve-daily", firstProposed: existing >= 0 ? q[existing].firstProposed : runAt, lastSeen: runAt,
    timesCleared: existing >= 0 ? (q[existing].timesCleared || 0) + 1 : 1,
    status: "PROPOSAL — awaiting operator registration. NOT enforced, NOT registered, NOT on the board.",
    claim: "Holding DIRECTION fixed, the standing pooled ridge ranks tickets within a session: dropping the bottom half by predicted R inside each (session, direction) raises mean R over the whole book. Direction itself is held constant, so this is skill the board does not already have from its direction call.",
    barFixedBeforeEvidence: improvement.bar,
    evidence: { dayCorrT: improvement.dayCorrT, permutationP: improvement.permutationP, permutationSided: improvement.permutationSided, nullShuffle: improvement.bar.nullShuffle, scoredSessions: improvement.scoredSessions, shadow: improvement.shadow },
    effectiveN: improvement.effectiveN,
    caveats: [
      "MOTIVATING SAMPLE. One clean era, one walk-forward pass, and the attempt was chosen after seeing that a within-day long/short gap existed — in-sample of the idea, even where it is out-of-sample of the fit.",
      "The rule only removes tickets, so it adds no crossing cost, but the shadow does NOT model the cost of the tickets it KEEPS. Declared round-trip cost is 0.21R.",
      "Half the book is dropped, so the kept book has half the tickets and no more sessions — the sample gets smaller, not larger, and its error bars widen accordingly.",
      "universe-expanded.json is current membership; nothing here reads it, but any downstream study over it inherits survivorship bias.",
    ],
    toRegister: "Operator says register it; then it accrues forward with the bar above unchanged.",
  };
  if (existing >= 0) q[existing] = entry; else q.push(entry);
  /**
   * PRESERVE THE GOVERNANCE FILE (fixed 2026-08-27, review finding).
   * alpha-hunt-queue.json is an OBJECT owned by the alpha-hunt agent — spec, admissionRule,
   * bannedFamilies, candidates, notProposed, screenedButBlocked — and it has no `proposals`
   * key, so the read above resolves to []. Writing the bare array back replaced the whole
   * governance file with one proposal. This block only became reachable when the temporal
   * dead-zone bug on runAt was fixed in the same change, so it had never actually fired —
   * merge into the existing object instead, and never write a bare array over it.
   */
  let doc = {}; try { const rawDoc = JSON.parse(fs.readFileSync(QUEUE, "utf8")); if (rawDoc && !Array.isArray(rawDoc)) doc = rawDoc; } catch { }
  doc.proposals = q;
  fs.writeFileSync(QUEUE, JSON.stringify(doc, null, 2));
  queued = entry.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. WRITE
// ─────────────────────────────────────────────────────────────────────────────
const state = {
  runAt, runDay: et(Date.now()), isFirstRun: !prev,
  canonical: {
    source: LED.source, epoch: LED.epoch, rowsInFile: LED.rowsInFile, settled: LED.settled,
    signals: LED.n, controls: LED.controlN, meanR: LED.meanR, controlMeanR: LED.controlMeanR,
    winRatePct: LED.winRatePct, pooledEdgeR: LED.pooledEdgeR,
  },
  effectiveN: {
    settlementSessions: closeSessions.length,
    openSessions: [...new Set(ALL.map(openDay))].length,
    episodes: DECL.episodes, ticketToEpisodeInflation: DECL.effectiveNInflation,
    episodePooledEdgeR: DECL.episodes.pooledEdgeR, tEpisodesSignals: DECL.tEpisodesSignals, tTicketsSignals: DECL.tTicketsSignals,
    largestClusters: DECL.largestClusters,
    note: "Independent observations are SESSIONS; where a basket spans days, EPISODES are stricter still. A ticket count is never a sample size.",
  },
  windows, edges, coverage: coverageReport,
  coverageJoint: { allEight_allRows: all8All, allEight_equity: all8Eq, equityRows: eq.length, rowsWithObs: rowsWithObs.length },
  classMix, stampByDay,
  models, modelFeatures: FEATS.length, modelRows: mrows.length, modelSessions: msessions.length, modelFolds: folds,
  featureStructure: { asOf: new Date().toISOString(), full: FEATS.length, perTicket: FEATS_T.length, heldOut: PRUNE.heldOut, kept: FEATS_T, rule: PRUNE.rule, refusedPostEntry: ADMIT.removed, featureGuard: ADMIT.guardVersion,
    perFeature: PRUNE.structure,
    note: "Outcome-blind: selection uses within-session variance share and distinct values per session only. Held-out fields are MARKET-LEVEL (one value per session) and belong to a session-level model that 28 sessions cannot fit; they are not deleted." },
  movement, crossedBar, fellBelowBar, improvement, retiredAttempts: [RETIRED_MLI1, RETIRED_MLI2], queuedProposal: queued,
  journalLag: { missing: JLAG.missing ?? null, note: JLAG.note },
  survivorshipNote: "universe-expanded.json is CURRENT MEMBERSHIP — any historical study over it inherits survivorship bias. Nothing in this file reads it; the ledger is the source.",
};
fs.writeFileSync(OUT, JSON.stringify(state, null, 2));

// one compact line per run — the movement series, so tomorrow reads it instead of re-deriving it
const card = {
  runAt, runDay: state.runDay, settled: LED.settled, signals: LED.n, controls: LED.controlN,
  allClean: windows.allClean, last20: windows.last20, last5: windows.last5,
  edgeAllClean: { pooledEdgeR: edges.allClean.pooledEdgeR, dayClusteredEdgeR: edges.allClean.dayClusteredEdgeR, dayClusteredT: edges.allClean.dayClusteredT, sessionsWithBothArms: edges.allClean.sessionsWithBothArms,
    guardedEdgeR: edges.allClean.guarded.dayClusteredEdgeR, guardedT: edges.allClean.guarded.dayClusteredT, guardedSessions: edges.allClean.guarded.sessionsWithBothArms, guardMinArmPerSide: edges.allClean.guarded.minArmPerSide },
  edgeLast20: { pooledEdgeR: edges.last20.pooledEdgeR, dayClusteredEdgeR: edges.last20.dayClusteredEdgeR, dayClusteredT: edges.last20.dayClusteredT, sessionsWithBothArms: edges.last20.sessionsWithBothArms,
    guardedEdgeR: edges.last20.guarded.dayClusteredEdgeR, guardedT: edges.last20.guarded.dayClusteredT, guardedSessions: edges.last20.guarded.sessionsWithBothArms },
  episodes: DECL.episodes.signals, episodeEdgeR: DECL.episodes.pooledEdgeR,
  coverage: Object.fromEntries(STRUCTURAL.map((k) => [k, { equityPct: coverageReport[k].equityPct, allRowsPct: coverageReport[k].allRowsPct, clearsBakeoffBar_equityOnly: coverageReport[k].clearsBakeoffBar_equityOnly }])),
  improvement: { id: improvement.id || null, cleared: !!improvement.cleared, dayCorrT: improvement.dayCorrT ?? null, permutationP: improvement.permutationP ?? null, meanRLift: improvement.shadow ? improvement.shadow.meanRLift : null, liftT: improvement.shadow ? improvement.shadow.liftT : null },
  // nullShuffle rides on every row so a reader can see WHERE the definition changed rather than
  // reading a p-value series that silently switched nulls between 2026-08-26 and 2026-08-26.
  nullShuffle: "day x direction", permutationSided: "one (upper tail)",
  models: { ridge: { dayCorrT: models.ridge.dayCorrT, permutationP: models.ridge.permutationP, permutationP_twoSided: models.ridge.permutationP_twoSided, beatsNull: models.ridge.beatsNull }, gbm: { dayCorrT: models.gbm.dayCorrT, permutationP: models.gbm.permutationP, permutationP_twoSided: models.gbm.permutationP_twoSided, beatsNull: models.gbm.beatsNull } },
};
// one line per RUN DAY: a re-run replaces todays line rather than appending beside it, so the
// series stays one row per session and a delta always spans real settlement, not a repeated read.
const kept = priorLines.filter((l) => { try { return JSON.parse(l).runDay !== state.runDay; } catch { return true; } });
fs.writeFileSync(CARD, [...kept, JSON.stringify(card)].join(String.fromCharCode(10)) + String.fromCharCode(10));

// ─────────────────────────────────────────────────────────────────────────────
// 5. PRINT — first line is the movement
// ─────────────────────────────────────────────────────────────────────────────
const sgn = (x) => (x == null ? "n/a" : (x >= 0 ? "+" : "") + x);
const bar = (m) => (m.delta == null ? "first run — no baseline" : m.insideErrorBar === true ? "INSIDE its error bar" : m.insideErrorBar === false ? "OUTSIDE its error bar" : "no error bar available");
console.log("=".repeat(100));
if (!prev) {
  console.log(`MOVEMENT — FIRST RUN, no baseline. Win ${windows.allClean.winRatePct}% · mean ${windows.allClean.meanR}R · P&L $${windows.allClean.totalPnl} over ${closeSessions.length} settlement sessions. Deltas begin tomorrow.`);
} else {
  console.log(`MOVEMENT — win ${windows.allClean.winRatePct}% (${sgn(movement.winRatePct.delta)}, ${bar(movement.winRatePct)}) · mean ${windows.allClean.meanR}R (${sgn(movement.meanR.delta)}, ${bar(movement.meanR)}) · P&L ${windows.allClean.totalPnl} (${sgn(movement.totalPnl.delta)}, ${bar(movement.totalPnl)})`);
}
console.log("=".repeat(100));
console.log(`CANONICAL  ${LED.source} · epoch ${LED.epoch}`);
console.log(`  settled ${LED.settled} · signals ${LED.n} · controls ${LED.controlN} · pooled edge ${sgn(LED.pooledEdgeR)}R`);
console.log(`  EFFECTIVE N: ${closeSessions.length} settlement sessions · ${state.effectiveN.openSessions} open sessions · ${DECL.episodes.signals} signal episodes (ticket inflation ${DECL.effectiveNInflation}x)`);
for (const [k, w] of Object.entries(windows)) {
  console.log(`  ${k.padEnd(9)} ${String(w.sessions).padStart(3)} sess · ${String(w.tickets).padStart(4)} tickets · win ${w.winRatePct}% (±${w.seWinPct_session ?? "n/a"}) · mean ${w.meanR}R (±${w.seMeanR_session ?? "n/a"}) · P&L $${w.totalPnl} · t ${w.tMeanR_session ?? "n/a"} on ${w.sessionsScored} sessions`);
}
for (const [k, e] of Object.entries(edges)) {
  console.log(`  EDGE ${k.padEnd(9)} pooled ${sgn(e.pooledEdgeR)}R · DAY-CLUSTERED ${sgn(e.dayClusteredEdgeR)}R t ${e.dayClusteredT ?? "n/a"} on ${e.sessionsWithBothArms} sessions with both arms (${e.sessionsMissingAnArm} sessions had only one)`);
  const g = e.guarded;
  console.log(`       ${"".padEnd(9)} guarded (>=${g.minArmPerSide}/side) ${sgn(g.dayClusteredEdgeR)}R t ${g.dayClusteredT ?? "n/a"} on ${g.sessionsWithBothArms} sessions · ${g.sessionsDroppedThin} thin session(s) dropped${g.thinSessions.length ? ": " + g.thinSessions.map((s) => `${s.day} ${s.nSig}v${s.nCtl} ${sgn(s.diffR)}R`).join(", ") : ""}`);
}
console.log(`\nCOVERAGE — structural observers. Denominator matters: ${eq.length} equity rows of ${rowsWithObs.length} with obs (${r2((100 * eq.length) / rowsWithObs.length)}%).`);
console.log(`  ${"observer".padEnd(14)} ${"equity".padStart(8)} ${"all rows".padStart(9)}   bar(eq)  Δequity`);
for (const k of STRUCTURAL) {
  const c = coverageReport[k], d = movement.coverage[k];
  console.log(`  ${k.padEnd(14)} ${(c.equityPct + "%").padStart(8)} ${(c.allRowsPct + "%").padStart(9)}   ${(c.clearsBakeoffBar_equityOnly ? "PASS" : "fail").padEnd(7)} ${d.delta == null ? "—" : sgn(d.delta)}`);
}
console.log(`  all eight simultaneously: ${all8Eq} of ${eq.length} equity rows`);
if (crossedBar.length) console.log(`  CROSSED THE 30% BAR since last run: ${crossedBar.join(", ")} — now usable by model-bakeoff on an equity-only fit`);
if (fellBelowBar.length) console.log(`  FELL BELOW THE BAR: ${fellBelowBar.join(", ")}`);
console.log(`\nMODEL — walk-forward by session, purge ${PURGE}, ${folds} folds, ${FEATS.length} features (${FEATS_T.length} per-ticket after pruning; ${PRUNE.heldOut.length} market-level held out) over ${mrows.length} rows / ${msessions.length} sessions`);
for (const m of ["ridge", "gbm"]) console.log(`  ${m.padEnd(6)} day-corr t ${models[m].dayCorrT ?? "n/a"} · decile spread ${models[m].decileSpreadR ?? "n/a"}R · ${models[m].read}`);
const I = improvement;
console.log(`\nRETIRED — ${RETIRED_MLI1.id}: ${RETIRED_MLI1.reason}.`);
console.log(`  on review: ${RETIRED_MLI1.defectFoundOnReview}`);
console.log(`RETIRED — ${RETIRED_MLI2.id}: ${RETIRED_MLI2.reason}.`);
console.log(`\nIMPROVEMENT ATTEMPT — ${I.id || "(none)"} · SHADOW ONLY, never enforced`);
if (!I.attempted) console.log(`  not attempted: ${I.reason}`);
else {
  console.log(`  rule: ${I.rule}`);
  console.log(`  population: ${I.population.rowsSurvivingR49} rows survive R49 carrying a formable costR, across ${I.population.sessions} open sessions`);
  console.log(`    ${"thr".padStart(5)} ${"refused".padStart(8)} ${"refusedR".padStart(9)} ${"lift/sess".padStart(10)} ${"t".padStart(6)} ${"sessions".padStart(9)}`);
  for (const g of I.grid) console.log(`    ${String(g.thr).padStart(5)} ${String(g.refusedTickets).padStart(8)} ${String(g.refusedR).padStart(9)} ${String(g.liftPerSessionMean).padStart(10)} ${String(g.liftT).padStart(6)} ${String(g.liftSessions).padStart(9)}${g.thr === I.chosen.thr ? "   <- GRADED (fixed at 0.10, not chosen by outcome)" : ""}`);
  console.log(`  MEASURED-SPREAD SUBSET: ${I.stamped.rows} rows over ${I.stamped.sessions} sessions — ${I.stamped.decidable ? `lift t ${I.stamped.liftT} on ${I.stamped.liftSessions} sessions` : "NOT YET DECIDABLE"}`);
  for (const [k, c] of Object.entries(I.conditions || {})) console.log(`    ${c.pass ? "PASS" : "FAIL"}  ${k}: need ${c.need}, got ${c.got}`);
  console.log(`  EFFECTIVE N: ${I.effectiveN}`);
  console.log(`  QUEUEABLE: ${I.proposalEligible ? "yes" : "NO — " + I.bar.proposalIneligibleBecause}`);
  console.log(`  ${I.read}`);
  if (queued) console.log(`  written to alpha-hunt-queue.json as ${queued} — PROPOSAL, awaiting operator registration`);
}

console.log(`\nJOURNAL ${JLAG.note}`);
console.log("=".repeat(100));
