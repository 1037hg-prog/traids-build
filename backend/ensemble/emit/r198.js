#!/usr/bin/env node
"use strict";
/**
 * Library emitter — R198 leveraged-ETF close rebalancing on big days (SPY/QQQ). READ-ONLY.
 *
 * Source: backend/r198-letf-rebalance.js is NOT require()-safe (main runs on load and can seal) and is never executed here. Its
 * persisted output backend/data/r198-letf-rebalance.json holds the exact qualifying-day list the sealed statistic used:
 * daily[] = {date, netBps, pos:{SPY[,QQQ]}} (prim.vals, script lines 93 & 196). Day value = equal-weight mean over the legs AVAILABLE
 * that day (inactive leg = 0 return, no cost); leg net = pos x (P_close/P_1530 - 1) - 2 x 1bp. The trade is 15:30 -> close the same
 * session (intraday), booked on that date.
 *
 * Reproduction: plain one-sample t over qualifying days (script line 62, verbatim) — the registered primary statistic.
 */
const fs = require("fs"), path = require("path");
const { writeEntry } = require("../lib-entry.js");
const OUT = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "data", "r198-letf-rebalance.json"), "utf8"));

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function tPlain(a) { const n = a.length, m = mean(a); const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1); return m / Math.sqrt(v / n); }   // line 62

const rows = OUT.daily;
const tEmitted = +tPlain(rows.map((x) => x.netBps)).toFixed(3);
const series = rows.map((x) => ({ d: x.date, r: x.netBps / 1e4 }));
const twoLeg = rows.filter((x) => "QQQ" in x.pos).length;

writeEntry({
  id: "R198", name: "Leveraged-ETF close rebalancing, SPY/QQQ |move| >= 1%", registryId: "R198",
  script: "backend/r198-letf-rebalance.js", emitter: "backend/ensemble/emit/r198.js", unit: "daily", net: true,
  costModel: "1 bp per side per active leg, as sealed",
  window: OUT.window, calendar: "us-equity", series,
  reproduction: { statistic: "pooled net last-half-hour return on qualifying days, plain t over qualifying days", sealed: OUT.primary.t, emitted: tEmitted, tolerance: 0.02,
    match: Math.abs(tEmitted - OUT.primary.t) <= 0.02 && rows.length === OUT.primary.n },
  construction: "On each full session where a leg's own prior-close->15:30 move is >= 1% in size, that leg goes 15:30->close in the move's direction (1bp/side); "
    + "the day's return is the equal-weight mean over the legs available that day (SPY alone before 2018-08-02, SPY+QQQ after; an inactive leg holds cash) and is booked on that date.",
  notes: `Built from the sealed script's persisted per-day rows (netBps rounded to 0.001 bp). ${rows.length} qualifying days (${rows.length - twoLeg} SPY-only era, ${twoLeg} two-leg era). `
    + "Because an inactive leg is cash inside the day's mean, on a two-leg-era day with one active leg only half the capital is at risk — this is the sealed portfolio definition.",
});
