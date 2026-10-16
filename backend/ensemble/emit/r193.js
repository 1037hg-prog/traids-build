#!/usr/bin/env node
"use strict";
/**
 * Library emitter — R193 market intraday momentum (SPY/QQQ first half-hour sign -> last half hour). READ-ONLY.
 *
 * Source: the sealed script backend/r193-intraday-momentum.js is NOT require()-safe (its main runs on load and can seal), so it is
 * never executed here. Its persisted output backend/data/r193-intraday-momentum.json already holds the exact per-day event list
 * the sealed statistic was computed from: daily[] = {date, netBps, pos:[SPY,QQQ]} (prim.vals, lines 107 & 199 of the script), where
 * netBps = equal-weight mean of the SPY and QQQ legs, each leg = pos x (P16/P1530 - 1) - 2 x 1bp (0 and no cost when pos = 0).
 * The trade is 15:30 -> 16:00 ET the same session (intraday), so each day's net is booked on its own date (the exit date).
 *
 * Reproduction: Newey-West lag-1 t (Bartlett 1/2, divisor n) over ALL priced days, copied verbatim from lines 60-64 of the script.
 */
const fs = require("fs"), path = require("path");
const { writeEntry } = require("../lib-entry.js");
const OUT = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "data", "r193-intraday-momentum.json"), "utf8"));

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function nwT(a) {                                               // verbatim, r193-intraday-momentum.js lines 60-64
  const n = a.length, m = mean(a); let g0 = 0, g1 = 0;
  for (let i = 0; i < n; i++) { const e = a[i] - m; g0 += e * e; if (i) g1 += e * (a[i - 1] - m); }
  g0 /= n; g1 /= n; return m / Math.sqrt((g0 + g1) / n);
}

const rows = OUT.daily;
const tEmitted = +nwT(rows.map((x) => x.netBps)).toFixed(3);
const meanBps = +mean(rows.map((x) => x.netBps)).toFixed(3);
const series = rows.filter((x) => x.pos.some((p) => p !== 0)).map((x) => ({ d: x.date, r: x.netBps / 1e4 }));
const flat = rows.length - series.length;

writeEntry({
  id: "R193", name: "Intraday momentum SPY/QQQ (first half-hour -> last half-hour)", registryId: "R193",
  script: "backend/r193-intraday-momentum.js", emitter: "backend/ensemble/emit/r193.js", unit: "daily", net: true,
  costModel: "1 bp per side per leg (2 bps round trip per traded leg), as sealed",
  window: OUT.window, calendar: "us-equity", series,
  reproduction: { statistic: "pooled net last-half-hour return, Newey-West lag-1 t over days", sealed: OUT.primary.tNW, emitted: tEmitted, tolerance: 0.02,
    match: Math.abs(tEmitted - OUT.primary.tNW) <= 0.02 && rows.length === OUT.primary.n },
  construction: "Each full session: 15:30->16:00 ET position in SPY and QQQ (each by the sign of its own prior-close->10:00 return), equal weight, "
    + "1bp/side; the day's pooled net return is booked on that session's date. Days where both legs are flat (and half-days / the 2 unpriced sessions) are cash.",
  notes: `Built from the sealed script's persisted per-day rows (netBps rounded to 0.001 bp in the output file). ${rows.length} priced days, mean ${meanBps} bps/day `
    + `(sealed ${OUT.primary.meanNetBpsPerDay}); ${flat} priced days had both legs flat and are omitted as cash (r=0). Window = the registered sample span.`,
});
