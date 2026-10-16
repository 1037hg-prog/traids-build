#!/usr/bin/env node
"use strict";
/**
 * EMITTER R313 — IBS dip-buy on 20 ETFs (SEALED PASS 2026-10-03, t_NW 6.8281 over 321 months, 8754 trades).
 * ensemble-architect 2026-10-07. READ-ONLY: reads the sealed bar cache
 * backend/data/training/r313/bars-schwab-daily-19990101-20261001.json (sha256 checked against the sealed output's own
 * cache.sha256) and writes ONLY backend/data/strategy-library/R313.json via lib-entry. It never touches r313-ibs-etfs.json,
 * the controls file or any seal, and it never fetches.
 *
 * The sealed script backend/r313-ibs-etfs.js is not require()-safe, so its rule pieces are COPIED verbatim: ibsOf (line 67),
 * entryFromOf (70), prep (71-77), mkTrade (79-83), simulate (85-99), isWeekend/unpack (296-297), mean/nwT (143-144).
 *
 * DAILY SERIES. The sealed statistic pools trades by entry month; it defines no portfolio, so the library convention applies:
 * on each session, equal weight across the positions open that session (1/k each). A position's daily mark is its ETF's
 * close-to-close return; the 0.06% round trip is charged as 0.03% on the entry day and 0.03% on the exit day, at that day's
 * weight. Days with no position open are absent (cash at 0%). Open-at-last-bar trades are EXCLUDED, exactly as the sealed read
 * excluded them.
 * REPRODUCTION: trades / months / meanNet / t_NW / win% recomputed from the same trade list the series is built from, against
 * the sealed read's own numbers.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { writeEntry } = require("../lib-entry.js");

const CACHE = path.join(__dirname, "..", "..", "data", "training", "r313", "bars-schwab-daily-19990101-20261001.json");
const SEALED_OUT = path.join(__dirname, "..", "..", "data", "r313-ibs-etfs.json");
const UNIVERSE = ["SPY", "IWM", "DIA", "MDY", "XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLU", "XLB", "EFA", "EEM", "EWJ", "EWG", "EWU", "EWC", "EWA"];
const ENTRY_FROM = "2000-01-01", ENTRY_TO = "2026-09-30", COST = 0.0006, IBS_ENTRY = 0.1, IBS_EXIT = 0.9;
const fin = Number.isFinite, dateOf = (t) => String(t).slice(0, 10);

// ---- copied from backend/r313-ibs-etfs.js ----
const ibsOf = (b) => (fin(b.h) && fin(b.l) && fin(b.c) && b.h > b.l ? (b.c - b.l) / (b.h - b.l) : NaN);
function entryFromOf(firstBar) { const y = +firstBar.slice(0, 4), full = firstBar.slice(5) <= "01-04" ? y : y + 1, f = `${full}-01-01`; return f > ENTRY_FROM ? f : ENTRY_FROM; }
function prep(bars, { from = ENTRY_FROM, to = ENTRY_TO } = {}) {
  const n = bars.length, d = bars.map((b) => dateOf(b.t)), o = bars.map((b) => b.o), h = bars.map((b) => b.h), l = bars.map((b) => b.l), c = bars.map((b) => b.c);
  const ibs = bars.map(ibsOf), sig = ibs.map((x) => fin(x) && x < IBS_ENTRY), ex = ibs.map((x) => fin(x) && x > IBS_EXIT);
  const synth = bars.map((b) => b.v === 0 && b.o === b.h && b.h === b.l && b.l === b.c), synthCum = new Array(n);
  for (let i = 0, k = 0; i < n; i++) { if (synth[i]) k++; synthCum[i] = k; }
  return { n, d, o, h, l, c, ibs, sig, ex, synth, synthCum, from, to };
}
function mkTrade(P, sym, t, u) {
  const last = P.n - 1, x = u === null ? last : u;
  return { sym, t, u, entryDate: P.d[t], exitDate: u === null ? null : P.d[u], month: P.d[t].slice(0, 7), entry: P.c[t], exit: u === null ? null : P.c[u],
    hold: x - t, gross: P.c[x] / P.c[t] - 1, ...(u === null ? { markDate: P.d[last], mark: P.c[last] } : {}) };
}
function simulate(P, sym) {
  const { n, d, sig, ex, from, to } = P, closed = [], open = []; let pos = null, ignored = 0;
  const inWin = (i) => d[i] >= from && d[i] <= to;
  for (let i = 0; i < n; i++) {
    if (pos !== null) {
      if (ex[i]) { closed.push(mkTrade(P, sym, pos, i)); pos = null; }
      else if (sig[i] && inWin(i)) ignored++;
      continue;
    }
    if (sig[i] && inWin(i)) pos = i;
  }
  if (pos !== null) open.push(mkTrade(P, sym, pos, null));
  return { closed, open, ignored };
}
const isWeekend = (d) => { const g = new Date(String(d).slice(0, 10) + "T12:00:00Z").getUTCDay(); return g === 0 || g === 6; };
const unpack = (rows) => rows.filter(([t]) => !isWeekend(t)).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a) { const n = a.length; if (n < 3) return null; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n, c = 0; for (let i = 1; i < n; i++) c += d[i] * d[i - 1]; v += c / n; return v > 0 ? m / Math.sqrt(v / n) : null; }
// ---- end copied ----

function main() {
  const buf = fs.readFileSync(CACHE), sha = crypto.createHash("sha256").update(buf).digest("hex");
  const sealed = JSON.parse(fs.readFileSync(SEALED_OUT, "utf8"));
  if (sealed.cache && sealed.cache.sha256 && sealed.cache.sha256 !== sha) throw new Error(`cache sha256 ${sha} != the sealed read's ${sealed.cache.sha256} — refusing`);
  const cache = JSON.parse(buf.toString("utf8"));

  const trades = [], byDate = new Map();                            // date -> [{ sym, r, costShare }]
  let openCount = 0;
  for (const sym of UNIVERSE) {
    const bars = unpack(cache.rows[sym]);
    const P = prep(bars, { from: entryFromOf(dateOf(bars[0].t)), to: ENTRY_TO });
    const { closed, open } = simulate(P, sym);
    openCount += open.length;
    for (const x of closed) {
      x.net = x.gross - COST;
      trades.push(x);
      for (let i = x.t + 1; i <= x.u; i++) {
        const d = P.d[i], r = P.c[i] / P.c[i - 1] - 1, cost = (i === x.t + 1 ? COST / 2 : 0) + (i === x.u ? COST / 2 : 0);
        if (!byDate.has(d)) byDate.set(d, []);
        byDate.get(d).push({ sym, r: r - cost });
      }
    }
  }
  // reproduction on the trade list the series is built from
  const byMonth = new Map();
  for (const x of trades) { const k = x.month; if (!byMonth.has(k)) byMonth.set(k, []); byMonth.get(k).push(x.net); }
  const keys = [...byMonth.keys()].sort(), monthly = keys.map((k) => mean(byMonth.get(k)));
  const got = { trades: trades.length, months: keys.length, meanNet: +mean(monthly).toFixed(4), tNet: +nwT(monthly).toFixed(4), winRatePct: +(100 * trades.filter((x) => x.net > 0).length / trades.length).toFixed(1) };
  const want = { trades: sealed.trades, months: sealed.months, meanNet: sealed.meanNet, tNet: +Number(sealed.tNet).toFixed(4), winRatePct: sealed.winRatePct };
  const match = got.trades === want.trades && got.months === want.months && Math.abs(got.meanNet - want.meanNet) <= 0.0001 && Math.abs(got.tNet - want.tNet) <= 0.01 && Math.abs(got.winRatePct - want.winRatePct) <= 0.1;

  const dates = [...byDate.keys()].sort();
  const series = dates.map((d) => { const legs = byDate.get(d); return { d, r: mean(legs.map((x) => x.r)) }; });
  const conc = dates.map((d) => byDate.get(d).length);
  console.log(`R313 reproduction: emitted ${JSON.stringify(got)}  sealed ${JSON.stringify(want)} -> ${match ? "MATCH" : "NO MATCH"}`);
  console.log(`  ${series.length} active sessions ${series[0].d}..${series[series.length - 1].d}; mean concurrent positions ${(mean(conc)).toFixed(2)}, max ${Math.max(...conc)}; ${openCount} open-at-last-bar trade(s) excluded`);

  writeEntry({
    id: "R313", name: "IBS dip-buy on 20 ETFs (buy the close when IBS < 0.1, sell the close when IBS > 0.9)",
    registryId: "R313", script: "backend/r313-ibs-etfs.js", emitter: "backend/ensemble/emit/r313.js",
    unit: "daily", net: true, costModel: "0.06% round trip per trade (the sealed script's COST), booked 0.03% on the entry day and 0.03% on the exit day at that day's portfolio weight",
    window: [series[0].d, series[series.length - 1].d], calendar: "us-equity", series,
    reproduction: { statistic: "trades / months / meanNet (per-entry-month mean of trade nets) / t_NW lag 1 / win%", sealed: `${want.trades} / ${want.months} / ${want.meanNet} / ${want.tNet} / ${want.winRatePct}`, emitted: `${got.trades} / ${got.months} / ${got.meanNet} / ${got.tNet} / ${got.winRatePct}`, tolerance: "exact / exact / 0.0001 / 0.01 / 0.1", match },
    construction: "Per ETF: entry at the close when IBS < 0.1 (strict), exit at the close of the first later session with IBS > 0.9 (strict), one position per ETF, a signal while long ignored, no stop and no time cap; entries from Jan 1 of each ETF's first full calendar year (never before 2000-01-01) through 2026-09-30; feed weekend rows dropped. Each session's portfolio return = the equal-weighted mean over the positions open that session (library convention; the sealed statistic pools trades and defines no portfolio). Sessions with nothing open are absent = cash at 0%.",
    notes: `Mean ${mean(conc).toFixed(2)} concurrent positions, max ${Math.max(...conc)} — the equal-weight-across-open-positions convention means the stream is a 1x-NAV long-only dip book, not 20 independent sleeves. ${openCount} trade(s) open at the last bar excluded, as in the sealed read. Capacity note: 8754 trades over 321 months on 20 large ETFs; the binding cost assumption is 6 bps round trip, and the sealed read also cleared at 12 bps.`,
  });
}
main();
