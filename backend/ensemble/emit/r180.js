#!/usr/bin/env node
"use strict";
/**
 * EMITTER R180 — month-end Treasury duration demand (IEF, last 5 sessions of each month). READ-ONLY regeneration of the daily net
 * return series for the strategy return library. Never writes anything but backend/data/strategy-library/R180.json (via lib-entry).
 *
 * The sealed script backend/r180-month-end-treasury.js is NOT require()-safe (unguarded main that seals), so the pieces used are
 * COPIED verbatim: toMonths (lines 70-77), monthStat (79-84), evaluate (86-97), mean/sd/tstat (53-55). Data exactly as the script:
 * IEF Alpaca SIP 1Day adjustment=all, 2019-07-01..2026-08-31 (line 113-115).
 *
 * Daily series: on each of the month's 5 window sessions (the last 5 returns of the month; entry at the close of session -6, exit at
 * the close of the last session) r = IEF close-to-close return; 2 bps (entry side) charged on the first window day, 2 bps (exit side)
 * on the last. Every other session = cash (0).
 * Reproduction: the script's primary statistic tAdj (net, drift-adjusted, plain t over months) from the same months/windows.
 */
const path = require("path");
const { fetchBars } = require("../../lib/alpaca-bars.js");
const { writeEntry } = require("../lib-entry.js");

const START = "2019-07-01", END = "2026-08-31", COST_SIDE = 0.0002, WIN = 5;
// ---- copied from backend/r180-month-end-treasury.js lines 53-55 ----
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const tstat = (a) => mean(a) / (sd(a) / Math.sqrt(a.length));
const r3 = (x) => (x == null || !Number.isFinite(x) ? x : +x.toFixed(3));
// ---- copied from lines 70-97 ----
function toMonths(series) {
  const byM = new Map();
  for (let i = 0; i < series.length; i++) {
    const ym = series[i].d.slice(0, 7), r = i === 0 ? null : series[i].c / series[i - 1].c - 1;
    if (!byM.has(ym)) byM.set(ym, []); byM.get(ym).push({ d: series[i].d, r });
  }
  return [...byM.entries()].map(([ym, days]) => ({ ym, days }));
}
function monthStat(rs, a, b, cost = 2 * COST_SIDE) {
  let g = 1; for (let i = a; i < b; i++) g *= 1 + rs[i]; g -= 1;
  const non = rs.filter((_, i) => i < a || i >= b);
  const drift = non.length ? WIN * mean(non) : 0;
  return { gross: g, net: g - cost, adj: g - cost - drift, nonDays: non.length };
}
function evaluate(months, shift = 0, cost = 2 * COST_SIDE) {
  const rows = [];
  for (const m of months) {
    const rs = m.days.filter((x) => x.r != null).map((x) => x.r);
    const lastIdx = m.days.length - 1;
    if (m.days[lastIdx].r == null || rs.length < WIN + shift) continue;
    const b = rs.length - shift, a = b - WIN, s = monthStat(rs, a, b, cost);
    rows.push({ ym: m.ym, ...s });
  }
  const adj = rows.map((x) => x.adj), gross = rows.map((x) => x.gross);
  return { n: rows.length, meanAdjPct: r3(100 * mean(adj)), tAdj: r3(tstat(adj)), tAdjRaw: tstat(adj), meanGrossPct: r3(100 * mean(gross)), tGross: r3(tstat(gross)), rows };
}

(async () => {
  const { bars } = await fetchBars(["IEF"], { start: START, end: END + "T23:59:59Z", feed: "sip", adjustment: "all", timeframe: "1Day", requireAll: true, quiet: true });
  const IEF = bars.IEF.map((b) => ({ d: b.t.slice(0, 10), c: b.c })).filter((x) => x.d >= START && x.d <= END);
  const months = toMonths(IEF), prim = evaluate(months, 0);

  // daily series from the SAME months/windows evaluate() used (window = last WIN days-with-returns of each qualifying month)
  const series = [];
  const used = new Set(prim.rows.map((x) => x.ym));
  for (const m of months) {
    if (!used.has(m.ym)) continue;
    const days = m.days.filter((x) => x.r != null), w = days.slice(days.length - WIN);
    w.forEach((x, k) => series.push({ d: x.d, r: x.r - (k === 0 ? COST_SIDE : 0) - (k === WIN - 1 ? COST_SIDE : 0) }));
  }
  // consistency: the window days compound to the script's gross (net differs only by compounding of the 2 bps charges)
  let maxDiff = 0;
  for (const row of prim.rows) { const ds = series.filter((x) => x.d.startsWith(row.ym)); const g = ds.reduce((p, x) => p * (1 + x.r), 1) - 1; maxDiff = Math.max(maxDiff, Math.abs(g - row.net)); }
  console.log(`R180: ${prim.n} months, tAdj ${prim.tAdj} (raw ${prim.tAdjRaw}), series max |compounded - script net| ${maxDiff.toExponential(2)}`);

  const sealed = 3.053, tol = 0.02;
  writeEntry({
    id: "R180", name: "Month-end Treasuries (IEF)", registryId: "R180", script: "backend/r180-month-end-treasury.js", emitter: "backend/ensemble/emit/r180.js",
    unit: "daily", net: true, costModel: "2 bps per side on IEF (0.02% entry on the first window day, 0.02% exit on the last window day)",
    window: [START, END], calendar: "us-equity", series,
    reproduction: { statistic: "primary tAdj (net drift-adjusted window return, plain t over months)", sealed, emitted: prim.tAdj, tolerance: tol, match: Math.abs(prim.tAdj - sealed) <= tol },
    construction: "Long IEF over the last 5 sessions of each month (close of session -6 to close of the last session); each window session's IEF close-to-close SIP adjustment=all return is booked on its date, with 2 bps subtracted on the first and on the last window day; all other sessions cash.",
    notes: `${prim.n} months; the sealed statistic subtracts 5x the month's non-window mean return (a drift adjustment that is a statistic, not a traded leg) — the series is the traded long-IEF window return. Daily series compounds to the script's per-month net within ${maxDiff.toExponential(1)}.`,
  });
})().catch((e) => { console.error("R180 emitter FAILED:", e.message); process.exit(1); });
