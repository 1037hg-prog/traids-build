#!/usr/bin/env node
"use strict";
/**
 * Library emitter — R196 pre-FOMC drift (SPY 14:00 ET prior session -> 13:55 ET statement day). READ-ONLY.
 *
 * Source: backend/r196-pre-fomc.js is NOT require()-safe (main runs on load and can seal) and is never executed here. Its persisted
 * output backend/data/r196-pre-fomc.json holds the exact meeting list the sealed statistic used: meetings[] = {date, prior, grossBps,
 * netBps, quarterBaselineBps, adjBps} (script line 152). netBps = window gross - 2 x 1bp is the TRADED return; the sealed statistic
 * subtracts the quarter baseline (adjBps = netBps - quarterBaselineBps), which is a benchmark adjustment, not a trade.
 *
 * Series: the traded net return, booked on the statement date (= the exit date; the hold spans two sessions with no daily mark in
 * the script, so per the library contract it is booked on exit). Reproduction: plain one-sample t (script lines 77-78) over the
 * meetings of (netBps - quarterBaselineBps), recomputed from the same rows.
 */
const fs = require("fs"), path = require("path");
const { writeEntry } = require("../lib-entry.js");
const OUT = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "data", "r196-pre-fomc.json"), "utf8"));

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };   // line 77
const tstat = (a) => mean(a) / (sd(a) / Math.sqrt(a.length));                                                         // line 78

const M = OUT.meetings;
const adj = M.map((m) => m.netBps - m.quarterBaselineBps);
const maxAdjDiff = Math.max(...M.map((m, i) => Math.abs(adj[i] - m.adjBps)));
const tEmitted = +tstat(adj).toFixed(3);
const series = M.map((m) => ({ d: m.date, r: m.netBps / 1e4 }));
const tRaw = +tstat(M.map((m) => m.netBps)).toFixed(3);

writeEntry({
  id: "R196", name: "Pre-FOMC drift, SPY 14:00 -> 13:55", registryId: "R196",
  script: "backend/r196-pre-fomc.js", emitter: "backend/ensemble/emit/r196.js", unit: "per-event", net: true,
  costModel: "1 bp per side (2 bps round trip), as sealed",
  window: [OUT.coverage.firstMinuteData, OUT.window[1]], calendar: "us-equity", series,
  reproduction: { statistic: "net window return minus quarter 24h-window baseline, plain t over meetings", sealed: OUT.primary.t, emitted: tEmitted, tolerance: 0.02,
    match: Math.abs(tEmitted - OUT.primary.t) <= 0.02 && M.length === OUT.primary.n },
  construction: "Each covered scheduled FOMC statement: long SPY from 14:00 ET on the prior session to 13:55 ET on statement day, 1bp/side; "
    + "the traded net return (not the baseline-adjusted statistic) is booked on the statement date (exit). All other days are cash.",
  notes: `${M.length} meetings 2016-01..2026-07. Window starts ${OUT.coverage.firstMinuteData} (first SIP minute data): the four 2015 meetings in the registered span `
    + `were uncovered (no minute data) so zeros before that date are not meaningful. The library series is the RAW traded net (mean ${+mean(M.map((m) => m.netBps)).toFixed(3)} bps, `
    + `raw t ${tRaw}); the sealed statistic subtracts each quarter's mean 24h-window return (adj mean ${+mean(adj).toFixed(3)} bps). `
    + `Recomputed adj vs persisted adjBps max |diff| ${maxAdjDiff.toFixed(4)} bp (rounding). The ~24h overnight hold is booked as one event on the exit date.`,
});
