#!/usr/bin/env node
/**
 * R8b — POST-EARNINGS DRIFT, THE READ. 2026-08-10.
 *
 * REGISTERED (2026-07-30): after a large earnings gap (|raw gap| >= 5%), does price drift in
 * the gap's direction? Endpoints: post-gap close → +1/+5/+20 TRADING days, signed by gap
 * direction, MARKET-RELATIVE (minus SPY), day-clustered by PRINT DATE (an earnings-cluster
 * night is ONE observation, not twenty).
 * BAR: +5d PRIMARY — day-clustered t >= 2.0 at >= 30 gaps across >= 10 print dates.
 *      +1d/+20d secondary at Šidák |t| >= 2.39.
 * Prior: WEAK YES (Ball & Brown 1968; Bernard & Thomas 1989). If the bar is met the next step
 * is a PAPER SLEEVE with entry at the post-gap close — never a live wire from one clearing.
 *
 * This script computes whatever has ELAPSED and refuses to adjudicate below the registered
 * sample — reading half a test early is how bars get renegotiated. Endpoints that have not
 * elapsed are counted as pending, never filled with the latest close.
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const { fetchBarsWithBenchmark } = require("./lib/alpaca-bars");

const shadow = JSON.parse(fs.readFileSync(D("r8-earnings-shadow.json"), "utf8"));
const gaps = Object.values(shadow.settledGaps || {})
  .filter(g => Number.isFinite(g.rawGap) && Math.abs(g.rawGap) >= 5 && g.window && g.window[1]);

const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const sd = (a) => a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1)) : 0;
const tOf = (a) => { const s = sd(a); return a.length > 1 && s > 0 ? mean(a) / (s / Math.sqrt(a.length)) : null; };

(async () => {
  console.log(`R8b READ — ${gaps.length} large gaps (|raw| >= 5%) across ${new Set(gaps.map(g => g.printDate)).size} print dates`);
  console.log(`Bar: +5d day-clustered t >= 2.0 at >= 30 gaps across >= 10 print dates.\n`);
  if (!gaps.length) { console.log("nothing to compute."); return; }

  const syms = [...new Set(gaps.map(g => g.sym))];
  const { bars } = await fetchBarsWithBenchmark("SPY", syms, { start: "2026-07-20", end: new Date().toISOString().slice(0, 10), timeframe: "1Day", minBars: 5, quiet: true });
  const series = (s) => (bars[s] || []).map(b => ({ d: String(b.t).slice(0, 10), c: b.c }));
  const spy = series("SPY");
  const idx = (arr, date) => arr.findIndex(b => b.d >= date);

  const out = { d1: [], d5: [] };
  let pend5 = 0, noBars = 0;
  for (const g of gaps) {
    const s = series(g.sym);
    if (!s.length) { noBars++; continue; }
    const i0 = idx(s, g.window[1]);                     // post-gap close
    const j0 = idx(spy, g.window[1]);
    if (i0 < 0 || j0 < 0) { noBars++; continue; }
    const sign = Math.sign(g.rawGap);
    const rel = (i1, j1) => sign * (100 * (s[i1].c / s[i0].c - 1) - 100 * (spy[j1].c / spy[j0].c - 1));
    if (i0 + 1 < s.length && j0 + 1 < spy.length) out.d1.push({ date: g.printDate, v: rel(i0 + 1, j0 + 1) });
    if (i0 + 5 < s.length && j0 + 5 < spy.length) out.d5.push({ date: g.printDate, v: rel(i0 + 5, j0 + 5) });
    else pend5++;
  }

  const clustered = (rows) => {
    const by = {};
    for (const r of rows) (by[r.date] ||= []).push(r.v);
    const daily = Object.values(by).map(mean);
    return { n: rows.length, dates: daily.length, mean: mean(rows.map(r => r.v)), t: tOf(daily) };
  };
  const d1 = clustered(out.d1), d5 = clustered(out.d5);
  const f = (x) => x == null ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(3);

  console.log(`  +1d (secondary, Šidák 2.39): n=${d1.n} over ${d1.dates} dates · signed drift ${f(d1.mean)}pp · t ${d1.t == null ? "n/a" : d1.t.toFixed(2)}`);
  console.log(`  +5d (PRIMARY,   bar 2.00):  n=${d5.n} over ${d5.dates} dates · signed drift ${f(d5.mean)}pp · t ${d5.t == null ? "n/a" : d5.t.toFixed(2)}`);
  console.log(`  pending +5d (window not yet elapsed): ${pend5} · unpriceable: ${noBars}\n`);

  const sampleMet = d5.n >= 30 && d5.dates >= 10;
  if (!sampleMet) {
    console.log(`VERDICT: SAMPLE NOT MET — ${d5.n}/30 gaps · ${d5.dates}/10 print dates with an elapsed +5d window.`);
    console.log(`Nothing is adjudicated. The number above is a progress reading, not a result — the`);
    console.log(`registered bar is untouched and the shadow keeps accruing (this earnings season is`);
    console.log(`producing ~${Math.round(gaps.length / Math.max(1, new Set(gaps.map(g => g.printDate)).size))} big gaps per print date).`);
  } else {
    const clears = d5.t != null && d5.t >= 2.0 && d5.mean > 0;
    console.log(`VERDICT: ${clears ? "CLEARS — next step is the registered PAPER SLEEVE (entry at post-gap close), never a live wire." : "DOES NOT CLEAR at the registered bar."}`);
  }

  fs.writeFileSync(D("r8b-read.json"), JSON.stringify({ readAt: new Date().toISOString(), bigGaps: gaps.length, d1, d5, pending5d: pend5, sampleMet, bar: { t: 2.0, minGaps: 30, minDates: 10 } }, null, 1));
  console.log(`\nwritten: r8b-read.json`);
})();
