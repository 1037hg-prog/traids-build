#!/usr/bin/env node
"use strict";
/**
 * EMITTER R192 — month-end index-extension demand on AGG/LQD/MUB (R180's rule, equal-weight of the three). READ-ONLY.
 *
 * The sealed script backend/r192-bond-month-end.js has an unguarded main that seals, so its logic is COPIED: data fetch (line 17:
 * SIP, adjustment=all, 1Day default, 2015-12-01..2026-09-01), the per-symbol per-month return lists (line 19, months 2016-01..2026-08),
 * the month filter (line 21: every PRIMARY symbol has >= 15 returns), excessAt (line 20) and the primary series (lines 22-24).
 * Dates are carried alongside the returns (the script drops them) so the window days can be dated.
 *
 * Daily series: in each qualifying month, over the last 5 returns of the month, an equal-weight buy-and-hold portfolio of AGG, LQD,
 * MUB (1/3 each at the close of session -6, no intra-window rebalancing, so the 5 days compound to exactly the mean of the three
 * window returns — the script's primary). The script's COST 0.0004 round trip is charged 0.0002 on the first window day and 0.0002
 * on the last. Reproduction: t of the script's primary monthly series (window excess minus 5x the non-window mean minus COST).
 */
const { fetchBars } = require("../../lib/alpaca-bars.js");
const { writeEntry } = require("../lib-entry.js");

const PRIMARY = ["AGG", "LQD", "MUB"], COST = 0.0004;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length, sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); }, tOf = (a) => mean(a) / (sd(a) / Math.sqrt(a.length));

(async () => {
  const { bars } = await fetchBars(PRIMARY, { start: "2015-12-01", end: "2026-09-01", feed: "sip", adjustment: "all", quiet: true });
  const byM = {}, dM = {};   // sym -> month -> [daily returns] / [dates]
  for (const s of PRIMARY) { byM[s] = {}; dM[s] = {}; const b = bars[s]; for (let i = 1; i < b.length; i++) { const d = b[i].t.slice(0, 10), m = d.slice(0, 7); if (m < "2016-01" || m > "2026-08") continue; (byM[s][m] = byM[s][m] || []).push(b[i].c / b[i - 1].c - 1); (dM[s][m] = dM[s][m] || []).push(d); } }
  const excessAt = (a, start) => { const w = a.slice(start, start + 5), o = [...a.slice(0, start), ...a.slice(start + 5)]; return w.reduce((p, x) => p * (1 + x), 1) - 1 - 5 * mean(o) - COST; };
  const months = Object.keys(byM.AGG).filter((m) => PRIMARY.every((s) => (byM[s][m] || []).length >= 15)).sort();
  const lastStart = (a) => a.length - 5;
  const primary = months.map((m) => mean(PRIMARY.map((s) => excessAt(byM[s][m], lastStart(byM[s][m])))));
  const t = tOf(primary);

  const series = []; let maxDiff = 0, dateMismatch = 0;
  for (const m of months) {
    const ws = PRIMARY.map((s) => ({ r: byM[s][m].slice(-5), d: dM[s][m].slice(-5) }));
    if (!ws.every((w) => JSON.stringify(w.d) === JSON.stringify(ws[0].d))) { dateMismatch++; throw new Error(`window dates differ across ETFs in ${m}`); }
    const V = PRIMARY.map(() => 1 / 3); let prev = 1, cum = 1;
    for (let k = 0; k < 5; k++) {
      for (let j = 0; j < PRIMARY.length; j++) V[j] *= 1 + ws[j].r[k];
      const tot = V.reduce((a, b) => a + b, 0), r = tot / prev - 1; prev = tot;
      const rNet = r - (k === 0 ? COST / 2 : 0) - (k === 4 ? COST / 2 : 0);
      series.push({ d: ws[0].d[k], r: rNet }); cum *= 1 + rNet;
    }
    const scriptNet = mean(PRIMARY.map((s) => byM[s][m].slice(-5).reduce((p, x) => p * (1 + x), 1) - 1)) - COST;
    maxDiff = Math.max(maxDiff, Math.abs(cum - 1 - scriptNet));
  }
  console.log(`R192: ${months.length} months ${months[0]}..${months[months.length - 1]}, t ${t.toFixed(4)}, max |compounded - script window net| ${maxDiff.toExponential(2)}`);
  const firstDate = dM.AGG[months[0]][0];
  const sealed = 2.5, tol = 0.02, emitted = +t.toFixed(3);
  writeEntry({
    id: "R192", name: "Month-end bonds AGG/LQD/MUB", registryId: "R192", script: "backend/r192-bond-month-end.js", emitter: "backend/ensemble/emit/r192.js",
    unit: "daily", net: true, costModel: "0.04% round trip per month (script COST 0.0004): 0.02% on the first window day, 0.02% on the last",
    window: [firstDate, "2026-08-31"], calendar: "us-equity", series,
    reproduction: { statistic: "primary t (equal-weight AGG/LQD/MUB window excess over 5x non-window mean, net of COST, t over months)", sealed, emitted, tolerance: tol, match: Math.abs(emitted - sealed) <= tol },
    construction: "Each month, 1/3 each in AGG, LQD, MUB (SIP adjustment=all) held buy-and-hold over the month's last 5 sessions (close of session -6 to the last close); the portfolio's daily close-to-close return is booked on each window day, 2 bps off the first and last window days; cash otherwise.",
    notes: `${months.length} months (all three ETFs have >= 15 returns). Buy-and-hold within the window compounds to the mean of the three window returns the script averages (max diff ${maxDiff.toExponential(1)} after cost compounding). The sealed t subtracts a non-window drift term that is a statistic, not a traded leg.`,
  });
})().catch((e) => { console.error("R192 emitter FAILED:", e.message); process.exit(1); });
