"use strict";
/**
 * PART C shared engine (2026-10-02). Design analysis of known allocation tools — NOT a registered test, no registry writes,
 * no orders. A daily NAV simulator with explicit cost on traded notional, metrics, and a correlation-aware best-of-N bar.
 */
const fs = require("fs");

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => { const s = sd(a); return s > 0 ? mean(a) / (s / Math.sqrt(a.length)) : 0; };
const corr = (a, b) => { const n = Math.min(a.length, b.length); if (n < 3) return null; const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n)); let c = 0, da = 0, db = 0; for (let i = 0; i < n; i++) { c += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return da > 0 && db > 0 ? c / Math.sqrt(da * db) : null; };
const r4 = (x, k = 4) => (x == null || !isFinite(x) ? null : +x.toFixed(k));
const pct = (x, k = 2) => (x == null || !isFinite(x) ? null : +(100 * x).toFixed(k));

function mulberry32(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** FRED DTB3 (3-month T-bill, % annual) -> daily simple rate per trading date, carried forward over missing prints. */
function tbillSeries(file, dates) {
  const rows = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(",")).filter(([, v]) => v && v !== ".").map(([d, v]) => [d, +v]);
  let j = 0, last = rows[0][1]; const out = new Float64Array(dates.length);
  for (let i = 0; i < dates.length; i++) { while (j < rows.length && rows[j][0] <= dates[i]) { last = rows[j][1]; j++; } out[i] = last / 100 / 252; }
  return out;
}

/** Last trading index of each calendar month in `dates` (ascending). Returns [{ym, t}]. */
function monthEnds(dates) { const out = []; for (let i = 0; i < dates.length; i++) if (i === dates.length - 1 || dates[i + 1].slice(0, 7) !== dates[i].slice(0, 7)) out.push({ ym: dates[i].slice(0, 7), t: i }); return out; }

/**
 * Daily NAV simulator. plan: Map<tExec, {w: {asset: weight}}> — weights of NAV at the CLOSE of tExec (after that day's return);
 * 1 - sum(w) sits in cash at the T-bill. price(a, t) -> close or NaN; a NaN keeps the position at its last valid price (0% that day);
 * a name that never prints again (delisting / panel truncation) stays at its last close as 0%-yield value until the next rebalance.
 * Cost = costBps/1e4 x sum|w_target - w_drifted| (every side of every trade, on traded notional), taken out of NAV on tExec.
 * The initial build at t0 is not charged (every sleeve pays it once; excluded so turnover reads as ongoing turnover).
 * Returns daily returns for t in (t0, t1].
 */
function simulate({ price, plan, costBps, rf, t0, t1, lastValid }) {
  let cash = 1, hold = new Map(), navPrev = 1, turnover = 0, costSum = 0, nReb = 0; const ret = [], rebs = [];
  for (let t = t0; t <= t1; t++) {
    if (t > t0) { cash *= 1 + rf[t]; for (const [a, h] of hold) { const p = price(a, t); if (p > 0) { h.v *= p / h.p; h.p = p; } } }
    let nav = cash; for (const h of hold.values()) nav += h.v;
    const step = plan.get(t);
    if (step) {
      const tgt = step.w, assets = new Set([...hold.keys(), ...Object.keys(tgt)]); let to = 0;
      for (const a of assets) to += Math.abs((tgt[a] || 0) - (hold.has(a) ? hold.get(a).v / nav : 0));
      const initial = t === t0, c = initial ? 0 : (costBps / 1e4) * to;
      nav *= 1 - c; if (!initial) { turnover += to; costSum += c; nReb++; rebs.push({ t, to, c }); }
      const nh = new Map(); let inv = 0;
      for (const [a, w] of Object.entries(tgt)) { if (!(w > 0)) continue; let p = price(a, t); if (!(p > 0)) p = lastValid(a, t); if (!(p > 0)) continue; nh.set(a, { v: w * nav, p }); inv += w; }
      hold = nh; cash = (1 - inv) * nav;
    }
    if (t > t0) ret.push(nav / navPrev - 1);
    navPrev = nav;
  }
  return { ret, turnover, costSum, nReb, rebs };
}

/** Calendar-month compounded returns from a daily series aligned to dates[t0+1..t1]. */
function monthly(ret, dates, t0) { const m = new Map(); for (let i = 0; i < ret.length; i++) { const ym = dates[t0 + 1 + i].slice(0, 7); m.set(ym, (m.get(ym) ?? 1) * (1 + ret[i])); } return [...m.entries()].map(([ym, g]) => ({ ym, r: g - 1 })); }

function drawdown(ret, dates, t0) { let v = 1, pk = 1, pkI = -1, dd = 0, a = -1, b = -1; for (let i = 0; i < ret.length; i++) { v *= 1 + ret[i]; if (v > pk) { pk = v; pkI = i; } const x = v / pk - 1; if (x < dd) { dd = x; a = pkI; b = i; } } return { maxDD: dd, peak: a < 0 ? dates[t0] : dates[t0 + 1 + a], trough: b < 0 ? null : dates[t0 + 1 + b] }; }

function rolling(ret, dates, t0, n = 252) { const lg = ret.map((x) => Math.log(1 + x)); let s = 0, worst = Infinity, wEnd = null, best = -Infinity; for (let i = 0; i < lg.length; i++) { s += lg[i]; if (i >= n) s -= lg[i - n]; if (i >= n - 1) { if (s < worst) { worst = s; wEnd = dates[t0 + 1 + i]; } if (s > best) best = s; } } return { worst: Math.exp(worst) - 1, worstEnd: wEnd, best: Math.exp(best) - 1 }; }

function windowRet(ret, dates, t0, a, b) { let g = 1, n = 0; for (let i = 0; i < ret.length; i++) { const d = dates[t0 + 1 + i]; if (d > a && d <= b) { g *= 1 + ret[i]; n++; } } return n ? g - 1 : null; }

/** Full metric block. bench: {name: dailyRet[]} aligned to the same window. */
function metrics(ret, dates, t0, rf, benches = {}, extra = {}) {
  const n = ret.length, yrs = n / 252, g = ret.reduce((p, x) => p * (1 + x), 1), ex = ret.map((x, i) => x - rf[t0 + 1 + i]);
  const mon = monthly(ret, dates, t0), mr = mon.map((x) => x.r), dd = drawdown(ret, dates, t0), roll = rolling(ret, dates, t0);
  const years = {}; for (let i = 0; i < n; i++) { const y = dates[t0 + 1 + i].slice(0, 4); years[y] = (years[y] ?? 1) * (1 + ret[i]); }
  const out = {
    days: n, years: r4(yrs, 2), cagrPct: pct(g ** (1 / yrs) - 1), volPct: pct(sd(ret) * Math.sqrt(252)), sharpe: r4((mean(ex) / sd(ret)) * Math.sqrt(252), 2),
    maxDDPct: pct(dd.maxDD), ddPeak: dd.peak, ddTrough: dd.trough, worst12mPct: pct(roll.worst), worst12mEnd: roll.worstEnd, best12mPct: pct(roll.best),
    months: mr.length, meanMonthPct: pct(mean(mr), 3), monthWinRatePct: pct(mr.filter((x) => x > 0).length / mr.length, 1), worstMonthPct: pct(Math.min(...mr)),
    calendarYearsPct: Object.fromEntries(Object.entries(years).map(([y, v]) => [y, pct(v - 1, 1)])), ...extra, vs: {},
  };
  for (const [bn, br] of Object.entries(benches)) {
    const bm = monthly(br, dates, t0), exm = mr.map((x, i) => x - bm[i].r), bg = br.reduce((p, x) => p * (1 + x), 1);
    const bvar = sd(br) ** 2, cov = (() => { const ma = mean(ret), mb = mean(br); let c = 0; for (let i = 0; i < n; i++) c += (ret[i] - ma) * (br[i] - mb); return c / (n - 1); })();
    const te = sd(exm) * Math.sqrt(12);
    out.vs[bn] = { cagrDiffPct: pct(g ** (1 / yrs) - bg ** (1 / yrs)), meanMonthlyExcessPct: pct(mean(exm), 3), tMonthlyExcess: r4(tOf(exm), 2), monthsBeatPct: pct(exm.filter((x) => x > 0).length / exm.length, 1),
      trackingErrorPct: pct(te), infoRatio: r4((mean(exm) * 12) / te, 2), betaDaily: r4(cov / bvar, 2), corrDaily: r4(corr(ret, br), 2), corrMonthly: r4(corr(mr, bm.map((x) => x.r)), 2), worst12mExcessPct: pct(rolling(ret.map((x, i) => (1 + x) / (1 + br[i]) - 1), dates, t0).worst) };
  }
  return out;
}

/**
 * Correlation-aware best-of-N bar (stationary bootstrap, Politis-Romano, recentered — the White reality-check construction):
 * resample MONTHS jointly across all variants (so their correlation is kept), recentre each variant's mean to zero, and record the
 * max t across variants. p95 of that max is the bar the best observed t must clear. series: {name: monthlyExcess[] (same months)}.
 */
function realityCheck(series, { draws = 4000, meanBlock = 3, seed = 20261002 } = {}) {
  const names = Object.keys(series), n = series[names[0]].length, rng = mulberry32(seed), p = 1 / meanBlock;
  const mu = Object.fromEntries(names.map((k) => [k, mean(series[k])])), obsT = Object.fromEntries(names.map((k) => [k, tOf(series[k])]));
  const maxes = [];
  for (let d = 0; d < draws; d++) {
    const idx = new Array(n); let j = Math.floor(rng() * n); for (let i = 0; i < n; i++) { if (i > 0) j = rng() < p ? Math.floor(rng() * n) : (j + 1) % n; idx[i] = j; }
    let best = -Infinity; for (const k of names) { const s = series[k], x = idx.map((q) => s[q] - mu[k]); const tv = tOf(x); if (tv > best) best = tv; }
    maxes.push(best);
  }
  maxes.sort((a, b) => a - b); const q = (z) => maxes[Math.min(maxes.length - 1, Math.floor(z * maxes.length))];
  const bestName = names.reduce((a, b) => (obsT[a] >= obsT[b] ? a : b));
  return { variants: names.length, months: n, draws, meanBlockMonths: meanBlock, barP95: r4(q(0.95), 3), barP90: r4(q(0.9), 3), best: bestName, bestT: r4(obsT[bestName], 3),
    familyPValue: r4(maxes.filter((x) => x >= obsT[bestName]).length / maxes.length, 4), singleTestBar: 1.98, observedT: Object.fromEntries(names.map((k) => [k, r4(obsT[k], 2)])) };
}

module.exports = { mean, sd, tOf, corr, r4, pct, mulberry32, tbillSeries, monthEnds, simulate, monthly, drawdown, rolling, windowRet, metrics, realityCheck };
