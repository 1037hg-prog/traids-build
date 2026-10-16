"use strict";
/**
 * WORST-DAY NIGHTLY MODEL — the one thing the sealed ledger needs: a number for TOMORROW, computable from bars that are already on
 * disk at the close of today, with nothing in it that is not known at that moment.
 *
 * WHAT IT IS, AND WHAT IT IS NOT. run.js's model reads fifteen inputs (VIX and VIX3M from FRED, HYG-LQD credit, sector breadth, the
 * FOMC / month-end / opex calendars). Those are four more files, each with its own stamp, and the nightly job must be able to say
 * exactly what it read before the open. This model is the PRICE-ONLY SUBSET of that feature list — the seven inputs that come from the
 * SPY bar series alone, built exactly as dataset.js builds them, so a row can be reproduced from one file:
 *
 *     lnRv5 lnRv20 lnRv60   log of the 5 / 20 / 60-session realised volatility of total return, annualised, in points
 *     ret1 ret5              the 1 and 5-session total return, in percent
 *     dist50 dist200         100 x log(close / its own 50 / 200-session mean of raw closes)
 *
 * It is therefore a WEAKER model than run.js's, on purpose, and the ledger says so in every row (model.id, model.features). What the
 * ledger is evidence about is the forecast it actually made, not the best forecast that could have been made.
 *
 * THE LABEL, unchanged from dataset.js and verify.js: tomorrow is a worst-5% day when its close-to-close total return is at or below
 * the nearest-rank 5th percentile of the trailing WIN sessions' returns ending at today (the 63rd smallest of 1,260). The threshold is
 * computed at today's close and written INTO the row, so grading needs no re-derivation and can be checked against the row.
 *
 * THE FIT is lib.js's ridge logistic (lambda 10), refit on every session that has a label and is known today — an expanding window
 * ending at today. run.js refits each January; a nightly job has no reason to wait, and a row states its own nTrain.
 *
 * THE STORM STATE is two flags, both causal, neither tuned here:
 *     flagModel  the model's own probability is at or above the 90th percentile of its TRAINING probabilities (wf.js's causal
 *                threshold, the same top-decile rule run.js scores)
 *     flagRule   run.js's rule of thumb (a): today's close is below its 200-session mean AND 20-session realised vol is at or above
 *                the 80th percentile of its own trailing WIN sessions (dataset.js flagA, verify.js ruleA)
 *     storm = both -> "storm";  one -> "watch";  neither -> "calm"
 * Three states out of two binary flags is the only choice made here, and it is made before any of it was graded.
 *
 * NOTHING AFTER `asOf` IS READ. Every loop below is bounded by the index of asOf. nightlyLookAheadProof() scrambles every bar after
 * asOf and asserts the forecast is unchanged, which the selftest runs as a known answer.
 *
 * Read-only; no network.
 */
const L = require("./lib.js");
const SL = require("./sealed-ledger.js");                    // for stormStateOf only: the state's definition lives with the row's shape
const fin = Number.isFinite;

const MODEL_ID = "worst-day-nightly-price-v1";
const FEATURES = ["lnRv5", "lnRv20", "lnRv60", "ret1", "ret5", "dist50", "dist200"];
const WIN = 1260;              // the trailing window the 5% threshold is taken from (dataset.js WIN)
const TAIL = 0.05;             // the tail that defines a worst day (dataset.js TAIL)
const MIN_HISTORY = 200;       // no feature row before this index: dist200 needs 200 closes (dataset.js i >= 200)
const LAMBDA = 10;             // lib.js logitFit's ridge, run.js's value
const TOP_DECILE = 0.10;       // the causal flag's share, wf.js THR
const RULE_VOL_Q = 0.80;       // rule of thumb (a)'s vol percentile, dataset.js flagA
const MIN_TRAIN = 30;          // below this there is nothing to fit: the forecaster refuses rather than state a number

/** bars from a file: either a Yahoo cache ({rows:[{date,close,adjClose}]}) or a plain list ([{d,c,a}]). Sessions only, strictly
 *  increasing dates, positive prices — the same filter lib.js loadYahoo applies, so the two read a file the same way. */
function readBars(file) {
  const fs = require("fs");
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const src = Array.isArray(j) ? j : Array.isArray(j.rows) ? j.rows : null;
  if (!src) throw new Error(`${file} holds neither a list of bars nor { rows: [...] }`);
  return normaliseBars(src);
}
function normaliseBars(src) {
  const out = []; let prev = "";
  for (const x of src) {
    const d = x.d || x.date, c = Number(x.c !== undefined ? x.c : x.close), a = Number(x.a !== undefined ? x.a : x.adjClose);
    if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (!fin(c) || !fin(a) || !(c > 0) || !(a > 0)) continue;
    const g = new Date(d + "T12:00:00Z").getUTCDay(); if (g === 0 || g === 6) continue;
    if (d <= prev) continue;
    prev = d; out.push({ d, c, a });
  }
  return out;
}

/** every series the model needs, computed once over the whole bar list. Index i is bar i; nothing at i reads a bar after i. */
function series(bars) {
  const n = bars.length, d = bars.map((x) => x.d);
  const close = Float64Array.from(bars, (x) => x.c), adj = Float64Array.from(bars, (x) => x.a);
  const r = new Float64Array(n).fill(NaN); for (let i = 1; i < n; i++) r[i] = adj[i] / adj[i - 1] - 1;
  const rv = (k) => { const o = new Float64Array(n).fill(NaN); for (let i = k; i < n; i++) o[i] = L.sd(Array.from(r.subarray(i - k + 1, i + 1))) * Math.sqrt(252) * 100; return o; };
  const sma = (k) => { const o = new Float64Array(n).fill(NaN); let s = 0; for (let i = 0; i < n; i++) { s += close[i]; if (i >= k) s -= close[i - k]; if (i >= k - 1) o[i] = s / k; } return o; };
  return { n, d, close, adj, r, rv5: rv(5), rv20: rv(20), rv60: rv(60), sma50: sma(50), sma200: sma(200) };
}
/** the feature row at i, in FEATURES order. NaN where a window is not full yet; lib.js logitFit puts a training mean in its place. */
function featureRow(S, i, { minHistory = MIN_HISTORY } = {}) {
  const row = new Array(FEATURES.length).fill(NaN);
  if (i < minHistory) return row;
  const ln = Math.log;
  row[0] = ln(S.rv5[i]); row[1] = ln(S.rv20[i]); row[2] = ln(S.rv60[i]);
  row[3] = 100 * S.r[i]; row[4] = 100 * (S.adj[i] / S.adj[i - 5] - 1);
  row[5] = 100 * ln(S.close[i] / S.sma50[i]); row[6] = 100 * ln(S.close[i] / S.sma200[i]);
  return row;
}
/** the point-in-time worst-day threshold at i: the nearest-rank TAIL quantile of the WIN returns ending at i. NaN before i >= win. */
function thresholdAt(S, i, { win = WIN, tail = TAIL } = {}) {
  if (i < win) return NaN;
  return L.qLow(Array.from(S.r.subarray(i - win + 1, i + 1)), tail);
}
/** rule of thumb (a) at i: below the 200-session mean AND 20-session vol in its own trailing top fifth. -1 when it cannot be read. */
function ruleFlagAt(S, i, { win = WIN, volQ = RULE_VOL_Q } = {}) {
  if (i < win || !fin(S.rv20[i]) || !fin(S.sma200[i])) return -1;
  const rw = []; for (let k = i - win + 1; k <= i; k++) if (fin(S.rv20[k])) rw.push(S.rv20[k]);
  if (rw.length < win - 25) return -1;
  return S.close[i] < S.sma200[i] && S.rv20[i] >= L.qLow(rw, volQ) ? 1 : 0;
}

/**
 * The forecast made at the close of bar `t` for bar t+1 — using bars 0..t and nothing else.
 *   bars   normalised bars (normaliseBars / readBars)
 *   asOf   the decision session's date (default: the last bar). It must BE a bar.
 * Returns { asOfDate, asOfAdj, p, score, stormThr, flagModel, flagRule, storm, thr, model } or throws with why it cannot.
 */
function forecastAsOf(bars, { asOf = null, win = WIN, tail = TAIL, minHistory = MIN_HISTORY, lambda = LAMBDA, topDecile = TOP_DECILE, volQ = RULE_VOL_Q, minTrain = MIN_TRAIN } = {}) {
  if (!Array.isArray(bars) || bars.length === 0) throw new Error("no bars");
  const S = series(bars);
  const t = asOf === null ? S.n - 1 : S.d.indexOf(asOf);
  if (t < 0) throw new Error(`${asOf} is not one of the ${S.n} bars (they run ${S.d[0]} .. ${S.d[S.n - 1]})`);
  const need = Math.max(minHistory, win);
  if (t < need) throw new Error(`the decision bar ${S.d[t]} is bar ${t}; a forecast needs at least ${need} bars before it (${win} for the threshold, ${minHistory} for the 200-session mean)`);
  const thr = thresholdAt(S, t, { win, tail });
  if (!fin(thr)) throw new Error(`the ${tail} threshold at ${S.d[t]} cannot be computed`);

  // training rows: every i whose label is known at t (i + 1 <= t) and whose own threshold and features exist
  const X = new Array(t + 1), y = new Float64Array(t + 1), train = [];
  for (let i = 0; i <= t; i++) {
    X[i] = featureRow(S, i, { minHistory });
    if (i < need || i + 1 > t) continue;
    const th = thresholdAt(S, i, { win, tail });
    if (!fin(th) || !fin(S.r[i + 1])) continue;
    y[i] = S.r[i + 1] <= th ? 1 : 0;
    train.push(i);
  }
  if (train.length < minTrain) throw new Error(`only ${train.length} labelled session(s) are known at ${S.d[t]}; ${minTrain} are needed before a number is stated`);
  const m = L.logitFit(X, y, train, { lambda });
  const p = L.logitPredict(m, X[t]);
  const stormThr = L.qHigh(train.map((i) => L.logitPredict(m, X[i])), topDecile);
  const flagModel = p >= stormThr ? 1 : 0;
  const rf = ruleFlagAt(S, t, { win, volQ });
  const flagRule = rf === 1 ? 1 : 0;
  return {
    asOfDate: S.d[t], asOfAdj: S.adj[t], p, score: p, stormThr, flagModel, flagRule, storm: SL.stormStateOf(flagModel, flagRule), thr,
    ruleReadable: rf !== -1,
    model: { id: MODEL_ID, features: FEATURES.slice(), win, tail, lambda, minHistory, nTrain: train.length, nBars: t + 1 },
  };
}

/** the realised return of bar i (close-to-close total return against bar i-1), NaN at the first bar */
function realisedReturn(bars, date) {
  const S = series(bars), i = S.d.indexOf(date);
  if (i <= 0) return { i, r: NaN, adj: i === 0 ? S.adj[0] : NaN };
  return { i, r: S.r[i], adj: S.adj[i] };
}

/** the next session after `date`: the next weekday that is not a market holiday */
function nextSessionAfter(date, holidays = {}) {
  const [y, m, d] = date.split("-").map(Number);
  let ms = Date.UTC(y, m - 1, d, 12);
  for (let k = 0; k < 30; k++) {
    ms += 86400000;
    const s = new Date(ms).toISOString().slice(0, 10), g = new Date(ms).getUTCDay();
    if (g === 0 || g === 6) continue;
    if (holidays[s]) continue;
    return s;
  }
  throw new Error(`no session found within 30 days of ${date}`);
}

/**
 * THE LOOK-AHEAD PROOF. Scramble every bar strictly after asOf and the forecast must not move by one bit. Returns
 * { same, a, b } so a caller can print both. This is the same device dataset.js offers as opts.perturbAfter.
 */
function lookAheadProof(bars, opts = {}) {
  const asOf = opts.asOf || bars[bars.length - 2].d;
  const a = forecastAsOf(bars, { ...opts, asOf });
  const keys = ["asOfDate", "asOfAdj", "p", "score", "stormThr", "flagModel", "flagRule", "storm", "thr"];
  // Every bar after asOf is moved by at least 40%, alternating up and down, so every future RETURN moves too (a scramble that can
  // land near zero, as dataset.js's sine does at some indices, would prove nothing). It is then run the other way round as well:
  // one direction can leave a label the same by luck, and the two together cannot.
  const runs = [false, true].map((flip) => {
    const scrambled = bars.map((x, i) => { if (!(x.d > asOf)) return x; const f = (i % 2 === 0) !== flip ? 0.6 : 1.6; return { d: x.d, c: x.c * f, a: x.a * f }; });
    return forecastAsOf(scrambled, { ...opts, asOf });
  });
  const differs = runs.flatMap((b, j) => keys.filter((k) => !Object.is(a[k], b[k])).map((k) => `${k} (scramble ${j + 1}): ${a[k]} -> ${b[k]}`));
  return { same: differs.length === 0, a, b: runs[0], runs, keys, differs };
}

module.exports = {
  MODEL_ID, FEATURES, WIN, TAIL, MIN_HISTORY, LAMBDA, TOP_DECILE, RULE_VOL_Q, MIN_TRAIN,
  readBars, normaliseBars, series, featureRow, thresholdAt, ruleFlagAt, forecastAsOf, realisedReturn, nextSessionAfter, lookAheadProof,
};
