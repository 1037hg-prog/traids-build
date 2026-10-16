#!/usr/bin/env node
/**
 * POST-SEAL AUDIT (not a registered test, seals nothing, changes no verdict): R227/R228's own read script had a key-
 * format bug in its secondary IEF-correlation diagnostic (year keys like "2016" never matched IEF's "YYYY-MM" series,
 * so it silently printed null instead of a number). This recomputes that one diagnostic independently, on the
 * overlapping 2016-2025 years (Alpaca SIP, the project's canonical source), against R227/R228's OWN sealed per-year
 * pair returns (rebuilt here from the same Yahoo history the sealed read used, for the same years — not re-deriving
 * the verdict, just the correlation number the house rule requires before calling anything a new edge).
 *   node backend/r227-r228-ief-audit.js
 */
const path = require("path");
const { fetchBars } = require("./lib/alpaca-bars.js");
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const corr = (a, b) => { const ma = mean(a), mb = mean(b); let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return sab / Math.sqrt(saa * sbb); };
const r3 = (x) => +x.toFixed(3);

async function yahooHistory(sym) {
  const r = await fetch(`http://localhost:3002/api/yahoo/${sym}/history?days=20000&interval=1d`);
  const j = await r.json();
  return j.bars.filter((b) => b.adjClose != null).map((b) => ({ d: b.date, c: b.adjClose })).sort((a, b) => (a.d < b.d ? -1 : 1));
}
function lastFridayOfMonth(y, m) { const last = new Date(Date.UTC(y, m, 0)); let d = last.getUTCDate(); while (new Date(Date.UTC(y, m - 1, d)).getUTCDay() !== 5) d--; return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10); }

(async () => {
  const { bars } = await fetchBars(["IEF"], { start: "2015-11-01", end: "2026-08-31", feed: "sip", adjustment: "all", quiet: true });
  const IEF = bars.IEF.map((b) => ({ d: b.t.slice(0, 10), c: b.c }));
  const byMonth = {}; for (const b of IEF) if (b.d >= "2016-01-01" && b.d <= "2026-08-31") (byMonth[b.d.slice(0, 7)] = byMonth[b.d.slice(0, 7)] || []).push(b);
  const giIEF = new Map(IEF.map((b, i) => [b.d, i])), iefSeries = {};
  for (const ym of Object.keys(byMonth)) { const days = byMonth[ym]; if (days.length < 6) continue; const L = days.length, entry = days[L - 6], exit = days[L - 1];
    const gE = giIEF.get(entry.d); if (!gE) continue; iefSeries[ym] = IEF[giIEF.get(exit.d)].c / IEF[gE - 1].c - 1; }

  const yIWM = await yahooHistory("IWM"), ySPY = await yahooHistory("SPY");
  const idxIWM = new Map(yIWM.map((b, i) => [b.d, i])), idxSPY = new Map(ySPY.map((b, i) => [b.d, i]));
  function sessionOnOrBefore(arr, dateStr) { let last = null; for (const b of arr) { if (b.d <= dateStr) last = b; else break; } return last; }

  const overlapYears = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
  const r227 = [], r228 = [], iefJune = [];
  for (const y of overlapYears) {
    const target = lastFridayOfMonth(y, 6);
    const effIWM = sessionOnOrBefore(yIWM, target); if (!effIWM) continue;
    const gI = idxIWM.get(effIWM.d);
    // R227: entry gI-5 -> exit gI
    const eIdx = gI - 5, xIdx = gI;
    const entryD = yIWM[eIdx].d, exitD = yIWM[xIdx].d, eS = idxSPY.get(entryD), xS = idxSPY.get(exitD);
    const net227 = (yIWM[xIdx].c / yIWM[eIdx].c - 1) - (ySPY[xS].c / ySPY[eS].c - 1) - 0.0008;
    // R228: entry gI -> exit gI+5
    const xIdx2 = gI + 5; const entryD2 = yIWM[gI].d, exitD2 = yIWM[xIdx2].d, eS2 = idxSPY.get(entryD2), xS2 = idxSPY.get(exitD2);
    const net228 = (ySPY[xS2].c / ySPY[eS2].c - 1) - (yIWM[xIdx2].c / yIWM[gI].c - 1) - 0.0008;
    const junKey = `${y}-06`;
    if (iefSeries[junKey] === undefined) { console.log(`  ${y}: no IEF June observation, skipped`); continue; }
    r227.push(net227); r228.push(net228); iefJune.push(iefSeries[junKey]);
    console.log(`  ${y}: R227 net ${r3(100 * net227)}% · R228 net ${r3(100 * net228)}% · IEF June month-end ${r3(100 * iefSeries[junKey])}%`);
  }
  console.log(`\nn=${r227.length} overlap years (2016-2025, Alpaca SIP for IEF; Yahoo for IWM/SPY as in the sealed read)`);
  console.log(`corr(R227, IEF June month-end) = ${r3(corr(r227, iefJune))}`);
  console.log(`corr(R228, IEF June month-end) = ${r3(corr(r228, iefJune))}`);
})().catch((e) => { console.error("FAILED:", e.stack); process.exit(1); });
