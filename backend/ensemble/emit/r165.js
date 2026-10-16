#!/usr/bin/env node
"use strict";
/**
 * EMITTER — R165 FOMC statement-day SPY hold (backend/hunt/FOMC_DAYS.js) -> strategy library entry R165.
 *
 * FOMC_DAYS.js is require()-safe (main guarded by `require.main === module`, line 186; exports computeMeetings/summarize/meetingsIn/SCHEDULED).
 * Data = the script's own SPY cache backend/data/hunt/FOMC_DAYS-spy-daily.json (Alpaca SIP 1Day adjustment=all, ET-dated), read-only;
 * toDays() is copied from FOMC_DAYS.js line 105 (not exported).
 *
 * Capital series: the strategy holds SPY close(t-1) -> close(t) on each scheduled statement day t and is in cash otherwise, so the day's
 * net return on capital is rF - 0.0002 (the script's 2 bp round trip per meeting), booked on t. The sealed statistic is on the EXCESS
 * rF - base(20 prior non-event days) - cost; it is recomputed from the same meeting rows for the reproduction.
 */
const fs = require("fs"), path = require("path");
const { computeMeetings, summarize, meetingsIn } = require("../../hunt/FOMC_DAYS.js");
const { writeEntry } = require("../lib-entry.js");
const DATA = path.join(__dirname, "..", "..", "data");
const COST = 0.0002, DISC = ["2017-01-01", "2021-12-31"], HOLD = ["2022-01-01", "2026-09-22"];   // FOMC_DAYS.js line 58
const toDays = (bars) => bars.map((b, i) => ({ d: b.d, r: i > 0 && bars[i - 1].c > 0 && b.c > 0 ? b.c / bars[i - 1].c - 1 : NaN }));   // line 105

const bars = JSON.parse(fs.readFileSync(path.join(DATA, "hunt", "FOMC_DAYS-spy-daily.json"), "utf8")).bars;
const days = toDays(bars.filter((b) => b.d <= HOLD[1]));
// discovery: the script truncates at the discovery end before computing (loadSpy cutoff); baselines only look back, so the rows are identical
const rowsD = computeMeetings(toDays(bars.filter((b) => b.d <= DISC[1])), meetingsIn(DISC)), rowsH = computeMeetings(days, meetingsIn(HOLD));
const sD = summarize(rowsD), sH = summarize(rowsH);
const sealH = JSON.parse(fs.readFileSync(path.join(DATA, "hunt", "FOMC_DAYS-holdout.json"), "utf8")).summary;
const sealD = JSON.parse(fs.readFileSync(path.join(DATA, "hunt", "FOMC_DAYS-discovery.json"), "utf8")).summary;
const series = [...rowsD, ...rowsH].map((x) => ({ d: x.d, r: x.rF - COST }));
const matchH = Math.abs(sH.tPlain - sealH.tPlain) <= 0.02, matchD = Math.abs(sD.tPlain - sealD.tPlain) <= 0.02;
console.log(`  R165 holdout t ${sH.tPlain} (sealed ${sealH.tPlain}) · discovery t ${sD.tPlain} (sealed ${sealD.tPlain}) · meetings ${rowsD.length}+${rowsH.length}`);

writeEntry({
  id: "R165", name: "FOMC statement-day SPY hold", registryId: "R165", script: "backend/hunt/FOMC_DAYS.js", emitter: "backend/ensemble/emit/r165.js",
  unit: "per-event", net: true, costModel: "0.02% (2 bps) round trip per meeting, charged on the statement day",
  window: ["2017-01-03", HOLD[1]], calendar: "us-equity", series,
  reproduction: { statistic: "holdout plain t of per-meeting net excess (rF - 20-day non-event baseline - 0.0002), 38 meetings 2022-01..2026-09", sealed: sealH.tPlain, emitted: sH.tPlain, tolerance: 0.02, match: matchH && matchD,
    discovery: { statistic: "discovery plain t, 39 meetings 2017-2021", sealed: sealD.tPlain, emitted: sD.tPlain, match: matchD } },
  construction: "One row per scheduled FOMC statement day (39 discovery + 38 holdout): r = SPY adjusted close(t)/close(t-1) - 1 - 0.0002, booked on t; every other session in the window is cash (0).",
  notes: `Series is the CAPITAL return (rF - cost), not the sealed excess-over-baseline statistic (which subtracts the mean of the 20 prior non-event days); the baseline is a benchmark, not a position. Holdout netMean (excess) emitted ${sH.netMean} vs sealed ${sealH.netMean}; raw FOMC-day mean holdout ${sH.rawFomcDayMean}. Window is discovery start through holdout end (2017-01-03..2026-09-22). Verdict DID NOT PASS.`,
});
