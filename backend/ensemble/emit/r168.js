#!/usr/bin/env node
"use strict";
/**
 * EMITTER R168 — TURN_OF_MONTH: long SPY over the turn-of-month window (last 3 sessions of m-1 + first 3 of m), cash otherwise. READ-ONLY.
 *
 * backend/hunt/TURN_OF_MONTH.js guards its main with `if (require.main === module)` (line 302) and exports its machinery (line 300),
 * so the rule is IMPORTED: unitsForWindow (fail-closed unit formation), summarise (NW t lag 3), validateDays, checkCoverage, DISC, HOLD,
 * RULE. fetchSpy (lines 129-136) is not exported and is COPIED here (with etDate, lines 89-90), same fetch parameters.
 *
 * Daily series: for every unit (discovery 2017-01..2021-12 and holdout 2022-01..2026-08, exactly the sealed units), the 6 TOM-window
 * SPY close-to-close returns are booked on their dates; the 0.02% round trip is charged 0.01% on the first TOM day and 0.01% on the
 * last. The sealed statistic (TOM mean daily return minus same-month non-TOM mean) is a difference of means, not a traded leg; the
 * traded leg is the TOM long (the script's own `tomWindowNet` context). Reproduction: summarise(units).tNW for both windows.
 */
const { unitsForWindow, summarise, validateDays, checkCoverage, DISC, HOLD, RULE, Refuse } = require("../../hunt/TURN_OF_MONTH.js");
const { writeEntry } = require("../lib-entry.js");

// ---- copied from backend/hunt/TURN_OF_MONTH.js lines 89-90, 129-136 ----
const etFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const etDate = (iso) => { const p = Object.fromEntries(etFmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; };
async function fetchSpy(win) {
  const { fetchBars } = require("../../lib/alpaca-bars.js");
  const { bars } = await fetchBars([RULE.symbol], { start: win.fetchStart, end: win.fetchEnd, timeframe: "1Day", feed: "sip", adjustment: "all", quiet: true, requireAll: false });
  const { days } = validateDays((bars[RULE.symbol] || []).map((b) => ({ d: etDate(b.t), c: +b.c })), win);
  const probs = checkCoverage(days, win); if (probs) throw new Refuse(`SPY coverage incomplete for ${win.from}..${win.to}: ${probs.join("; ")}`);
  return days;
}
// ---- end copy ----

(async () => {
  const daysD = await fetchSpy(DISC), UD = unitsForWindow(daysD, DISC), sD = summarise(UD);
  const daysH = await fetchSpy(HOLD), UH = unitsForWindow(daysH, HOLD), sH = summarise(UH);
  const half = RULE.costRoundTrip / 2, series = [];
  for (const u of [...UD, ...UH]) {
    if (u.tomDates.length !== u.tom.length) throw new Error(`unit ${u.ym}: dates/returns mismatch`);
    u.tom.forEach((r, k) => series.push({ d: u.tomDates[k], r: r - (k === 0 ? half : 0) - (k === u.tom.length - 1 ? half : 0) }));
  }
  series.sort((a, b) => (a.d < b.d ? -1 : 1));
  for (let i = 1; i < series.length; i++) if (series[i].d === series[i - 1].d) throw new Error(`overlapping TOM windows on ${series[i].d}`);
  // window: first TOM day of the first unit .. the last non-TOM session of the last unit's month (d_{N-3}); after that the next
  // window (unit 2026-09) was never formed in the sealed test.
  const lastYm = UH[UH.length - 1].ym, lastMonthDays = daysH.filter((x) => x.d.startsWith(lastYm)), winEnd = lastMonthDays[lastMonthDays.length - 1 - RULE.preDays].d;
  const eH = +sH.raw.tNW.toFixed(3), eD = +sD.raw.tNW.toFixed(3), sealH = 0.71, sealD = -0.166, tol = 0.02;
  console.log(`R168: discovery ${UD.length} units tNW ${sD.raw.tNW} · holdout ${UH.length} units tNW ${sH.raw.tNW} · ${series.length} TOM days · window end ${winEnd}`);
  writeEntry({
    id: "R168", name: "Turn of month SPY", registryId: "R168", script: "backend/hunt/TURN_OF_MONTH.js", emitter: "backend/ensemble/emit/r168.js",
    unit: "daily", net: true, costModel: "0.02% round trip per month on SPY: 0.01% on the first TOM day, 0.01% on the last",
    window: [series[0].d, winEnd], calendar: "us-equity", series,
    reproduction: { statistic: "holdout NW t (lag 3) of monthly net (TOM mean - non-TOM mean daily return)", sealed: sealH, emitted: eH, tolerance: tol, match: Math.abs(eH - sealH) <= tol && Math.abs(eD - sealD) <= tol,
      discovery: { sealed: sealD, emitted: eD, match: Math.abs(eD - sealD) <= tol } },
    construction: "Long SPY (SIP adjustment=all) from the close of the 4th-to-last session of month m-1 to the close of the 3rd session of month m, for every sealed unit month (2017-01..2026-08); each of the 6 window sessions' close-to-close return is booked on its date, 1 bp off the first and last; cash otherwise.",
    notes: `${UD.length + UH.length} units. The sealed statistic is a difference of mean daily returns (TOM minus non-TOM) — the series is the traded TOM long, whose sign need not match the statistic's.`,
  });
})().catch((e) => { console.error("R168 emitter FAILED:", e.message); process.exit(1); });
