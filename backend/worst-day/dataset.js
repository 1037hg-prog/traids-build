"use strict";
/**
 * WORST-DAY PREDICTOR, the dataset: one row per SPY session t with every input known at the 16:00 ET close of t, and the label for the
 * close-to-close return of the NEXT session.
 *
 * INPUT STAMPS (last tick that can enter the row, against the decision at the 16:00 ET close of t)
 *   rv5 / rv20 / rv60   SPY total-return closes up to t                      last tick 16:00 t         == decision, admitted
 *   ret1, ret5          SPY closes up to t                                   16:00 t                   admitted
 *   dist50, dist200     SPY raw close vs its own 50/200-session mean of raw closes, up to t   16:00 t  admitted
 *   VIX level, change, VIX/VIX3M   FRED VIXCLS / VXVCLS of the PRIOR session (t-1)     16:15 t-1       admitted. The same-day print (16:15 t)
 *                                       is 15 minutes AFTER the decision and the FRED file carries no intraday stamp, so it is NOT used
 *                                       (it appears only in the one labelled diagnostic variant)
 *   credit20            HYG minus LQD 20-session total return, up to t       16:00 t                   admitted
 *   breadth50           % of the 9 SPDR sector ETFs above their own 50-session mean, up to t   16:00 t  admitted
 *   fomcTomorrow, monthEndTomorrow, opexTomorrow   exchange / Fed calendars published in advance        admitted
 *   CPI / NFP tomorrow  DROPPED: the repo's calendar holds CPI from 2021 and NFP from 2024 only (macro-calendar.json says "never inferred")
 *
 * TARGET   y[t] = 1 when SPY total return on session t+1 <= the 5th percentile (nearest rank, 63rd smallest of 1,260) of the 1,260 sessions
 *          ending at t. The threshold at t uses nothing after t.
 */
const L = require("./lib.js");
const { fin } = L;

const FEATURES = ["lnRv5", "lnRv20", "lnRv60", "ret1", "ret5", "dist50", "dist200", "lnVixPrev", "dLnVixPrev", "lnVixRatioPrev", "credit20", "breadth50", "fomcTomorrow", "monthEndTomorrow", "opexTomorrow"];
const DIAG_SAMEDAY = { lnVixPrev: "lnVixToday", dLnVixPrev: "dLnVixToday", lnVixRatioPrev: "lnVixRatioToday" };
const WIN = 1260, TAIL = 0.05;
const SECTORS = ["XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLU", "XLB"];

function thirdFridayExpirations(dates) {
  const set = new Set(dates), out = new Set(); const months = new Set(dates.map((d) => d.slice(0, 7)));
  for (const ym of months) {
    const [y, m] = ym.split("-").map(Number); let cnt = 0, F = null;
    for (let day = 1; day <= 31; day++) { const dt = new Date(Date.UTC(y, m - 1, day, 12)); if (dt.getUTCMonth() !== m - 1) break; if (dt.getUTCDay() === 5 && ++cnt === 3) { F = dt.toISOString().slice(0, 10); break; } }
    if (!F) continue;
    if (set.has(F)) { out.add(F); continue; }
    let prev = null; for (const d of dates) { if (d < F && d.slice(0, 7) === ym) prev = d; else if (d >= F) break; }   // holiday Friday: the session before
    if (prev) out.add(prev);
  }
  return out;
}

function build(opts = {}) {
  // opts.perturbAfter = a date: every series value strictly after it is scrambled, to PROVE no row at or before it reads the future (look-ahead test)
  const T = opts.perturbAfter || null;
  const pert = (rows, keys) => (T ? rows.map((x, i) => (x.d > T ? { ...x, ...Object.fromEntries(keys.map((k) => [k, x[k] * (1 + 0.25 * Math.sin(i * 1.7 + 3))])) } : x)) : rows);
  const spy = pert(L.loadYahoo("SPY"), ["c", "a"]), n = spy.length;
  const d = spy.map((x) => x.d), close = Float64Array.from(spy, (x) => x.c), adj = Float64Array.from(spy, (x) => x.a);
  const r = new Float64Array(n).fill(NaN); for (let i = 1; i < n; i++) r[i] = adj[i] / adj[i - 1] - 1;
  const rRaw = new Float64Array(n).fill(NaN); for (let i = 1; i < n; i++) rRaw[i] = close[i] / close[i - 1] - 1;

  // rolling stats
  const rv = (k) => { const o = new Float64Array(n).fill(NaN); for (let i = k; i < n; i++) o[i] = L.sd(Array.from(r.subarray(i - k + 1, i + 1))) * Math.sqrt(252) * 100; return o; };
  const rv5 = rv(5), rv20 = rv(20), rv60 = rv(60);
  const sma = (k) => { const o = new Float64Array(n).fill(NaN); let s = 0; for (let i = 0; i < n; i++) { s += close[i]; if (i >= k) s -= close[i - k]; if (i >= k - 1) o[i] = s / k; } return o; };
  const sma50 = sma(50), sma200 = sma(200);

  // VIX (FRED, prior session) and 3-month VIX
  const vix = pert(L.loadFred("VIXCLS").map((x) => ({ d: x.d, v: x.v })), ["v"]), vxv = pert(L.loadFred("VXVCLS"), ["v"]), vixMap = new Map(vix.map((x) => [x.d, x.v])), vxvMap = new Map(vxv.map((x) => [x.d, x.v]));
  const vixDates = vix.map((x) => x.d);
  const prevObs = (date, k) => { // the k-th observation strictly before `date` (k=1 latest)
    let lo = 0, hi = vixDates.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (vixDates[mid] < date) lo = mid + 1; else hi = mid; }
    const idx = lo - k; return idx >= 0 ? vixDates[idx] : null;
  };
  const upToObs = (date, k) => { // the k-th observation on or before `date` (k=1: date itself if present)
    let lo = 0, hi = vixDates.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (vixDates[mid] <= date) lo = mid + 1; else hi = mid; }
    const idx = lo - k; return idx >= 0 ? vixDates[idx] : null;
  };

  // credit: HYG - LQD 20-session total return on the SPY calendar
  const hyg = new Map(pert(L.loadYahoo("HYG"), ["a"]).map((x) => [x.d, x.a])), lqd = new Map(pert(L.loadYahoo("LQD"), ["a"]).map((x) => [x.d, x.a]));
  const credit20 = new Float64Array(n).fill(NaN);
  for (let i = 20; i < n; i++) { const h1 = hyg.get(d[i]), h0 = hyg.get(d[i - 20]), q1 = lqd.get(d[i]), q0 = lqd.get(d[i - 20]); if ([h1, h0, q1, q0].every(fin)) credit20[i] = 100 * ((h1 / h0 - 1) - (q1 / q0 - 1)); }

  // breadth: 9 sector ETFs (Schwab r313 cache, price only), share above own 50-session mean
  const secInfo = SECTORS.map((s) => { const bars = pert(L.loadSchwab313(s), ["c"]), m = new Map(); let sum = 0; for (let i = 0; i < bars.length; i++) { sum += bars[i].c; if (i >= 50) sum -= bars[i - 50].c; if (i >= 49) m.set(bars[i].d, bars[i].c > sum / 50 ? 1 : 0); } return m; });
  const breadth50 = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) { let a = 0, c = 0; for (const m of secInfo) { const v = m.get(d[i]); if (v !== undefined) { a += v; c++; } } if (c === SECTORS.length) breadth50[i] = 100 * a / c; }

  // calendar
  const fomc = L.fomcDates(), fset = new Set(fomc.all), opex = thirdFridayExpirations(d);
  const FOMC_START = "2005-01-01";

  const FN = FEATURES.length, X = new Array(n), Xsame = new Array(n);
  const ln = Math.log;
  for (let i = 0; i < n; i++) {
    const row = new Array(FN).fill(NaN), same = new Array(3).fill(NaN);
    if (i >= 200) {
      row[0] = ln(rv5[i]); row[1] = ln(rv20[i]); row[2] = ln(rv60[i]);
      row[3] = 100 * r[i]; row[4] = 100 * (adj[i] / adj[i - 5] - 1);
      row[5] = 100 * ln(close[i] / sma50[i]); row[6] = 100 * ln(close[i] / sma200[i]);
      const p1 = prevObs(d[i], 1), p2 = prevObs(d[i], 2);
      if (p1 && p2) {
        row[7] = ln(vixMap.get(p1)); row[8] = ln(vixMap.get(p1) / vixMap.get(p2));
        if (vxvMap.has(p1)) row[9] = ln(vixMap.get(p1) / vxvMap.get(p1));
      }
      const s1 = upToObs(d[i], 1), s2 = upToObs(d[i], 2);       // same-day print, DIAGNOSTIC ONLY (16:15 t is after the decision)
      if (s1 === d[i] && s2) { same[0] = ln(vixMap.get(s1)); same[1] = ln(vixMap.get(s1) / vixMap.get(s2)); if (vxvMap.has(s1)) same[2] = ln(vixMap.get(s1) / vxvMap.get(s1)); }
      row[10] = credit20[i]; row[11] = breadth50[i];
      if (i + 1 < n) {
        row[12] = d[i + 1] >= FOMC_START ? (fset.has(d[i + 1]) ? 1 : 0) : NaN;
        row[13] = i + 2 < n ? (d[i + 2].slice(0, 7) !== d[i + 1].slice(0, 7) ? 1 : 0) : NaN;
        row[14] = opex.has(d[i + 1]) ? 1 : 0;
      }
    }
    X[i] = row; Xsame[i] = same;
  }

  // labels
  const thr = new Float64Array(n).fill(NaN), thrBest = new Float64Array(n).fill(NaN);
  const y = new Int8Array(n).fill(-1), yb = new Int8Array(n).fill(-1);
  const flagA = new Int8Array(n).fill(-1);                // model (a) rule of thumb
  for (let i = WIN; i < n; i++) {
    const w = Array.from(r.subarray(i - WIN + 1, i + 1));
    thr[i] = L.qLow(w, TAIL); thrBest[i] = L.qHigh(w, TAIL);
    if (i + 1 < n) { y[i] = r[i + 1] <= thr[i] ? 1 : 0; yb[i] = r[i + 1] >= thrBest[i] ? 1 : 0; }
    const rw = []; for (let k = i - WIN + 1; k <= i; k++) if (fin(rv20[k])) rw.push(rv20[k]);
    if (fin(rv20[i]) && fin(sma200[i]) && rw.length >= WIN - 25) flagA[i] = (close[i] < sma200[i] && rv20[i] >= L.qLow(rw, 0.80)) ? 1 : 0;
  }
  return { n, d, close, adj, r, rRaw, rv5, rv20, rv60, sma50, sma200, X, Xsame, thr, thrBest, y, yb, flagA, FEATURES, FOMC: fomc, opexCount: opex.size, SECTORS };
}
module.exports = { build, FEATURES, DIAG_SAMEDAY, WIN, TAIL };
