#!/usr/bin/env node
"use strict";
/**
 * Emitter — R189 AlphaInsider crypto ensemble -> R189-E1 (equal-capital sleeves at 1x) and R189-E2 (per-asset majority vote, long/cash).
 * backend/r189-ai-crypto-ensemble.js is NOT require-safe (top-level async main seals), so the pieces used are COPIED verbatim:
 *   FROM/TO/COST (line 39), nwMeanT (lines 42-43), sideAtClose (lines 51-55), the body lines 67-93 (candles, sleeves, days, textbook
 *   trend, build(), real, primary). The controls/B&H/seal code is not copied. R187's module (require-safe, `require.main` guard at its
 *   line 293) is imported exactly as R189 imports it. The textbook trend comparator is NOT emitted (it is a benchmark, not an arm).
 */
const fs = require("fs"), path = require("path");
const { writeEntry } = require("../lib-entry.js");
const DATA = path.join(__dirname, "..", "..", "data"), D = (f) => path.join(DATA, f);
for (const f of ["r187-eth-coinbase-hourly.json", "r187-btc-coinbase-hourly-ext.json", "r153-btc-coinbase-hourly.json", "r155-btc-coinbase-hourly-ext.json"]) if (!fs.existsSync(D(f))) throw new Error(`missing ${f} — refusing (the module would fetch)`);
const R = require("../../r187-ai-crypto-scripts.js");
// ---- copied from backend/r189-ai-crypto-ensemble.js line 39 (FROM, TO, COST) ----
const FROM = "2021-01-01", TO = "2025-09-23", COST = R.COST;
// ---- copied lines 42-43 ----
function nwMeanT(a, lag = 5) { const n = a.length, m = a.reduce((s, x) => s + x, 0) / n, d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n;
  for (let l = 1; l <= lag; l++) { let c = 0; for (let i = l; i < n; i++) c += d[i] * d[i - l]; v += 2 * (1 - l / (lag + 1)) * c / n; } return v > 0 ? m / Math.sqrt(v / n) : 0; }
// ---- copied lines 51-55 ----
function sideAtClose(bars, events, days, startSide = 0) {
  const es = [...events].sort((a, b) => a.i - b.i), out = new Map(); let k = 0, s = startSide;
  for (const d of days) { const lim = Date.parse(d) / 1000 + 86400; while (k < es.length && bars[es[k].i].ts <= lim) s = es[k++].side; out.set(d, s); }
  return out;
}

(async () => {
  const r187 = JSON.parse(fs.readFileSync(D("r187-ai-crypto-scripts.json"), "utf8")), persisted = JSON.parse(fs.readFileSync(D("r189-ai-crypto-ensemble.json"), "utf8"));
  const ver = r187.scripts.filter((s) => s.gate.pass);
  // ---- copied lines 67-93 ----
  const H = { BTC: await R.hourly("BTC"), ETH: await R.hourly("ETH") }, daily = { BTC: R.agg(H.BTC, 24), ETH: R.agg(H.ETH, 24) };
  const ad = { BTC: R.assetDays(daily.BTC, FROM, TO), ETH: R.assetDays(daily.ETH, FROM, TO) };
  const sleeves = ver.map((v) => { const S = R.SCRIPTS.find((x) => x.id === v.id), bars = R.agg(H[S.asset], R.TF[v.gate.timeframe]), ev = S.run(bars); return { id: v.id, name: S.name, asset: S.asset, tf: v.gate.timeframe, bars, ev }; });
  const days = [...ad.BTC.keys()].filter((d) => ad.ETH.has(d)).sort();
  const trendPos = (asset) => { const b = daily[asset], c = b.map((x) => x.c), m = new Map(); for (let i = 100; i < b.length; i++) { let s = 0; for (let k = 0; k < 100; k++) s += c[i - k]; m.set(R.dayOf(b[i].ts + 86400), c[i] > s / 100 ? 1 : 0); } return m; };
  const tp = { BTC: trendPos("BTC"), ETH: trendPos("ETH") };
  const longCash = (posMap, asset) => { let prev = null; return days.map((d) => { const p = posMap.get(d) ?? 0, c = prev == null ? 0 : COST * Math.abs(p - prev); prev = p; return p * ad[asset].get(d) - c; }); };
  const trendR = { BTC: longCash(tp.BTC, "BTC"), ETH: longCash(tp.ETH, "ETH") }, trend = days.map((d, i) => 0.5 * trendR.BTC[i] + 0.5 * trendR.ETH[i]);
  const build = (evs, startSides) => {
    const sl = sleeves.map((s, k) => { const dm = R.account(s.bars, evs[k], 1, FROM, TO, startSides ? startSides[k] : null); return days.map((d) => dm.get(d) ?? 0); });
    const e1 = days.map((d, i) => sl.reduce((a, r) => a + r[i], 0) / sl.length);
    const sides = sleeves.map((s, k) => sideAtClose(s.bars, evs[k], ["2020-12-31", ...days], startSides ? startSides[k] : 0));
    const vote = (asset) => { const idx = sleeves.map((s, k) => (s.asset === asset ? k : -1)).filter((k) => k >= 0), m = new Map(); if (!idx.length) return null;
      ["2020-12-31", ...days].forEach((d) => { const longs = idx.filter((k) => sides[k].get(d) === 1).length; m.set(R.dayOf(Date.parse(d) / 1000 + 86400), longs * 2 > idx.length ? 1 : 0); }); return m; };
    const vB = vote("BTC"), vE = vote("ETH"), assets = [vB && "BTC", vE && "ETH"].filter(Boolean);
    const e2parts = { BTC: vB && longCash(vB, "BTC"), ETH: vE && longCash(vE, "ETH") }, e2 = days.map((d, i) => assets.reduce((a, x) => a + e2parts[x][i], 0) / assets.length);
    const e1Expo = days.map((d) => sides.reduce((a, s) => a + Math.abs(s.get(R.dayOf(Date.parse(d) / 1000 - 86400)) ?? 0), 0) / sides.length);
    const e2Expo = days.map((d) => assets.reduce((a, x) => a + ((x === "BTC" ? vB : vE).get(d) ?? 0), 0) / assets.length);
    return { e1, e2, e1Expo, e2Expo };
  };
  const real = build(sleeves.map((s) => s.ev), null);
  const primary = (r) => nwMeanT(r.map((x, i) => x - trend[i]));
  // ---- end of copied block ----
  const base = { registryId: "R189", script: "backend/r189-ai-crypto-ensemble.js", emitter: "backend/ensemble/emit/r189.js", unit: "daily", net: true, calendar: "crypto-24x7", window: [days[0], days[days.length - 1]] };
  const arms = [
    { k: "E1", r: real.e1, x: real.e1Expo, name: "AlphaInsider crypto ensemble E1 (5 scripts, equal capital, 1x)",
      cost: "10 bps per side on each sleeve's traded notional at 1x (a reversal pays 2x), inside each sleeve's bar accounting",
      how: `Mean of the ${sleeves.length} verified R187 sleeves' daily net returns (R187 account() at 1.0x, window ${FROM}..${TO}, positions carried in from warm-up), equal capital rebalanced daily. Days with no exposure and r exactly 0 omitted.` },
    { k: "E2", r: real.e2, x: real.e2Expo, name: "AlphaInsider crypto ensemble E2 (majority vote per asset, long/cash)",
      cost: "10 bps per side on each position change of each asset half (long<->cash), charged on the change day",
      how: "Per asset, long 100% of that asset's half on day d+1 (UTC close-to-close) when a strict majority of its verified scripts are long at the day-d close (BTC 3 scripts, ETH 2), else cash; daily return = mean of the BTC and ETH halves. Days with both halves in cash and no switch cost omitted." },
  ];
  for (const a of arms) {
    const ser = days.map((d, i) => ({ d, r: a.r[i], on: a.x[i] > 0 || a.r[i] !== 0 })).filter((z) => z.on).map(({ d, r }) => ({ d, r }));
    const m = new Map(ser.map((z) => [z.d, z.r])), rebuilt = days.map((d) => m.get(d) ?? 0);
    const emitted = +primary(rebuilt).toFixed(3), direct = +primary(a.r).toFixed(3); if (emitted !== direct) throw new Error(`${a.k}: sparse series does not rebuild (${emitted} vs ${direct})`);
    const sealed = persisted.results[a.k].vsTrend.tNW;
    writeEntry({ ...base, id: `R189-${a.k}`, name: a.name, costModel: a.cost, series: ser,
      reproduction: { statistic: `NW t (Bartlett lag 5) of daily (${a.k} - textbook trend SMA100 50/50) net return, ${FROM}..${TO}`, sealed, emitted, tolerance: 0.02, match: Math.abs(emitted - sealed) <= 0.02 },
      construction: a.how,
      notes: `The sealed statistic is relative to the textbook trend benchmark (built here exactly as in the script, not emitted); the series itself is the ensemble's own net return. ${days.length} days in the window. Two sleeves (DMI/DPO 2021-05-02, Triple Threat 2022-03-15) were published inside the window, so their earlier days are in-sample for the author (disclosed in the script N1).` });
  }
})().catch((e) => { console.error("R189 emitter FAILED:", e.stack || e.message); process.exit(1); });
