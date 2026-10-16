#!/usr/bin/env node
"use strict";
/**
 * Library emitter — R166 intraday-only momentum (12-2 cumulative open->close return), long-short quintiles, stock panel. READ-ONLY.
 *
 * Source: backend/hunt/INTRADAY_MOM.js. VERIFIED require()-safe: main is wrapped in `if (require.main === module)` (line 258) and
 * module.exports (line 257) exposes loadPanel, prepare, monthEnds, dayNightSignal, universeAt, holdReturn, summarize, nwT. Its run()
 * is NOT exported (and refuses holdout months unless a module-private flag is set), so the monthly loop is COPIED here verbatim from
 * lines 139-158 (INTRA only — the report-only OVER leg is dropped), then extended to mark each month's legs to market daily.
 *
 * Portfolio (the script's own): at month-end close t0 = me[mi], LONG the top INTRA quintile / SHORT the bottom quintile of the
 * top-1500 liquid universe, equal weight at t0, buy-and-hold to the next month-end close t1 (a name that stops trading is held at
 * its last close). Monthly gross = avg hold return(L) - avg hold return(S); net = gross - 0.25% x (long turnover + short turnover).
 *
 * DAILY construction: V_L(k) = mean over L of lastClose_s(k) / C_s(t0) (lastClose carried forward exactly as holdReturn does);
 * same for S. Day k in (t0, t1]: r_k = [V_L(k) - V_L(k-1)] - [V_S(k) - V_S(k-1)] on $1 long + $1 short per $1 of capital (P&L
 * relative to month-start capital, so the month's daily r sum EXACTLY to the sealed monthly gross). The rebalance cost 0.25% x
 * turnover is booked on the rebalance date t0 (the close at which the trades happen). Months are run as the sealed read ran them:
 * discovery holding months 2017-01..2021-12 and holdout 2022-01..2026-09 as two separate runs (turnover resets to 2 in each first
 * month, exactly as sealed). Panel: data/anomaly-cache-v2 (full, through 2026-09-22) — discovery months use only data <= their t1,
 * so the untruncated panel gives the identical discovery months (verified by the reproduction below).
 */
const path = require("path");
const { writeEntry } = require("../lib-entry.js");
const H = require("../../hunt/INTRADAY_MOM.js");
const { loadPanel, prepare, monthEnds, dayNightSignal, universeAt, holdReturn, summarize } = H;
const COST = 0.0025, TOPN = 1500;                                          // script line 61
const DISC = ["2017-01", "2021-12"], HOLD = ["2022-01", "2026-09"];       // script line 62
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

const P = loadPanel(null), Q = prepare(P), dates = Q.meta.dates, me = monthEnds(dates), T = Q.T;
console.log(`R166 panel ${Q.N} symbols x ${T} days ${dates[0]}..${dates[T - 1]}`);

// run(): copied from INTRADAY_MOM.js lines 139-158 (INTRA, sign +1), plus the daily mark-to-market of the same L / S sets.
function run(fromYm, toYm, daily) {
  const series = []; let prev = null;
  for (let mi = 12; mi < me.length - 1; mi++) {
    const t = me[mi], t1 = me[mi + 1], ymHold = dates[t1].slice(0, 7); if (ymHold < fromYm || ymHold > toYm) continue;
    const U = universeAt(Q, t, TOPN).map((u) => ({ ...u, sig: dayNightSignal(Q, u.s, me[mi - 12], me[mi - 1]) }));
    const fwd = new Map(U.map((u) => [u.s, holdReturn(Q, u.s, t, t1)]));
    const xs = U.map((u) => ({ s: u.s, v: u.sig.INTRA })).filter((x) => Number.isFinite(x.v)); if (xs.length < 100) continue;
    xs.sort((a, b) => a.v - b.v); const q = Math.floor(xs.length / 5), lo = xs.slice(0, q), hi = xs.slice(xs.length - q), L = hi, S = lo;
    const avg = (g) => mean(g.map((x) => fwd.get(x.s)).filter(Number.isFinite)), gross = avg(L) - avg(S); if (!Number.isFinite(gross)) continue;
    const turn = prev ? (L.filter((x) => !prev.L.has(x.s)).length / L.length + S.filter((x) => !prev.S.has(x.s)).length / S.length) : 2;
    prev = { L: new Set(L.map((x) => x.s)), S: new Set(S.map((x) => x.s)) };
    series.push({ ym: ymHold, gross, net: gross - COST * turn, turn, n: q });
    // ---- daily marks (emitter extension) ----
    const legPath = (g) => {                                              // V(k) for k = t..t1, names with a finite hold return only
      const names = g.filter((x) => Number.isFinite(fwd.get(x.s))).map((x) => x.s), V = new Float64Array(t1 - t + 1);
      for (const s of names) { const o = s * T, a = Q.Cx[o + t]; let last = a; V[0] += 1; for (let k = t + 1; k <= t1; k++) { const x = Q.Cx[o + k]; if (x > 0) last = x; V[k - t] += last / a; } }
      for (let k = 0; k < V.length; k++) V[k] /= names.length; return V;
    };
    const VL = legPath(L), VS = legPath(S);
    let sum = 0;
    daily.add(dates[t], -COST * turn);
    for (let k = t + 1; k <= t1; k++) { const r = (VL[k - t] - VL[k - t - 1]) - (VS[k - t] - VS[k - t - 1]); sum += r; daily.add(dates[k], r); }
    daily.check.push(Math.abs(sum - gross));
    process.stdout.write(`  R166 ${ymHold}\r`);
  }
  process.stdout.write("\n");
  return summarize(series);
}

const acc = new Map(), daily = { add: (d, r) => acc.set(d, (acc.get(d) || 0) + r), check: [] };
const disc = run(DISC[0], DISC[1], daily), hold = run(HOLD[0], HOLD[1], daily);
const series = [...acc.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, r]) => ({ d, r }));
const maxRecon = Math.max(...daily.check);
console.log(`  discovery ${disc.months} mo t ${disc.raw.tNW} · holdout ${hold.months} mo t ${hold.raw.tNW} · max |sum(daily) - monthly gross| ${maxRecon.toExponential(2)}`);

const SEALED_HOLD_RAW = 1.524782697233606, SEALED_DISC_RAW = 0.25118908607185736;   // data/hunt/INTRADAY_MOM-{holdout,discovery}.json raw.tNW
const tol = 0.02, mH = Math.abs(hold.raw.tNW - SEALED_HOLD_RAW) <= tol, mD = Math.abs(disc.raw.tNW - SEALED_DISC_RAW) <= tol;

writeEntry({
  id: "R166", name: "Intraday-only momentum, long-short quintiles (stock panel)", registryId: "R166",
  script: "backend/hunt/INTRADAY_MOM.js", emitter: "backend/ensemble/emit/r166.js", unit: "daily", net: true,
  costModel: "0.25% x (long-leg turnover + short-leg turnover) per monthly rebalance (first month of each sealed run = turnover 2), as sealed",
  window: [series[0].d, series[series.length - 1].d], calendar: "us-equity", series,
  reproduction: { statistic: "holdout net monthly long-short spread, Newey-West t (lag 3)", sealed: 1.525, emitted: +hold.raw.tNW.toFixed(3), tolerance: tol, match: mH && mD },
  construction: "Monthly: long top / short bottom INTRA quintile of the top-1500 liquid names, equal weight at the month-end close, buy-and-hold to the next month-end; "
    + "each day's r = change in the long leg's value minus change in the short leg's value per $1 a side (sums exactly to the sealed monthly gross), "
    + "rebalance cost booked on the month-end rebalance date.",
  notes: `Two runs as sealed: discovery ${disc.firstMonth}..${disc.lastMonth} (${disc.months} mo, NW t ${disc.raw.tNW.toFixed(3)} vs sealed 0.251) and holdout `
    + `${hold.firstMonth}..${hold.lastMonth} (${hold.months} mo, NW t ${hold.raw.tNW.toFixed(3)} vs sealed 1.525); match requires both. Daily r are P&L on month-start `
    + `capital (not compounded within the month); max |sum of a month's daily r - its monthly gross| = ${maxRecon.toExponential(2)}. The holdout's first month (2022-01) `
    + `carries the sealed turnover-2 cost (0.5%) although a continuous book would have turned over ~0.5 — kept for fidelity to the sealed trade list. `
    + `Last month 2026-09 is partial (panel ends ${dates[T - 1]}). Returns are on the adjustment=all Alpaca panel (dividends included).`,
});
