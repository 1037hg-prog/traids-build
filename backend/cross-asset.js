#!/usr/bin/env node
/**
 * CROSS-ASSET REGIME — measure the relationships, then let them EARN signal status.
 *
 * THE OPERATOR'S ASK (2026-07-30): "how do we measure historically and provide signal for the
 * relationship of equities, crypto, options, forex, futures movements."
 *
 * MEASUREMENT (this file, nightly): the market tape back to 1988 plus BTC gives every pairwise
 * relationship a HISTORY, so today's correlation is reported as a PERCENTILE of its own past
 * rather than a bare number — corr(SPX,TLT) of +0.3 means nothing until you know it sits in
 * the 92nd percentile of 38 years (a 2022-style regime where diversification fails).
 *
 * SIGNAL (not this file): three of these relationships are stamped per-ticket as observers
 * (sbCorr already; btcCorr20 and hygSpy20 added 2026-07-30) and flow into the weighted board
 * at WEIGHT ZERO like every other contributor. They become signal the day their paired
 * within-session gap clears the bar, and not one day earlier. This file never scores tickets.
 *
 * Note on scope: "options" have no row here because options are not an asset class — an
 * option is equity direction (delta) + volatility (the VIX row) + time. "Futures" are their
 * underlyings (ES=SPX, CL=oil, GC=gold) and are covered by those rows.
 *
 * Writes backend/data/cross-asset.json; the combined daily report folds in the summary.
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const YAHOO = "http://localhost:3002/api/yahoo";
const PAIRS = [["tlt", "stocks-bonds"], ["hyg", "stocks-credit"], ["gld", "stocks-gold"], ["dxy", "stocks-dollar"], ["btc", "stocks-crypto"]];

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const corr = (x, y) => {
  const mx = mean(x), my = mean(y); let n = 0, dx = 0, dy = 0;
  for (let i = 0; i < x.length; i++) { n += (x[i] - mx) * (y[i] - my); dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2; }
  return dx > 0 && dy > 0 ? n / Math.sqrt(dx * dy) : null;
};

(async () => {
  console.log(`\n  CROSS-ASSET REGIME — history first, percentile second, signal only when earned\n`);
  const tape = JSON.parse(fs.readFileSync(D("market-tape.json"), "utf8"));
  const days = Object.keys(tape.days).sort();

  // BTC joins from the yahoo proxy (the tape predates crypto; fail closed if unavailable)
  let btcBySym = {};
  try {
    const r = await fetch(`${YAHOO}/BTC-USD/history?days=3000&interval=1d`, { signal: AbortSignal.timeout(60000) });
    if (r.ok) for (const b of ((await r.json()).bars || [])) if (Number.isFinite(b.close)) btcBySym[b.date] = b.close;
  } catch { }
  const btcDays = Object.keys(btcBySym).sort();
  const btcRet = {}; for (let i = 1; i < btcDays.length; i++) btcRet[btcDays[i]] = btcBySym[btcDays[i]] / btcBySym[btcDays[i - 1]] - 1;

  const series = (f) => days.map(d => ({ d, v: f === "btc" ? (btcRet[d] ?? null) : (tape.days[d][f] ?? null) }));
  const spx = series("spx");

  // rolling 20d correlation of a pair over its full joint history
  const rolling = (a, b, win = 20) => {
    const out = [];
    const joint = a.map((r, i) => [r.d, r.v, b[i].v]).filter(r => Number.isFinite(r[1]) && Number.isFinite(r[2]));
    for (let i = win; i <= joint.length; i++) {
      const w = joint.slice(i - win, i);
      const c = corr(w.map(r => r[1]), w.map(r => r[2]));
      if (c != null) out.push({ d: joint[i - 1][0], c });
    }
    return out;
  };

  const out = { generated: new Date().toISOString(), tapeDays: days.length, btcDays: btcDays.length, pairs: [], divergences: [], caveats: [
    "Correlations are 20d rolling daily-return correlations; percentile is against the pair's own full joint history.",
    "BTC history starts ~2014 via Yahoo — its percentile rests on one decade, not four.",
    "Options are intentionally absent: delta is the equity row, vega is the VIX row. Futures are their underlyings.",
    "These are REGIME DESCRIPTORS. None is a trade signal until its stamped observer earns board weight.",
  ] };

  console.log(`  pair            corr20    pctile of own history      regime read`);
  for (const [f, name] of PAIRS) {
    const roll = rolling(spx, series(f));
    if (roll.length < 100) { console.log(`  ${name.padEnd(15)} — insufficient joint history (${roll.length})`); continue; }
    const cur = roll[roll.length - 1];
    const hist = roll.map(r => r.c);
    const pct = +(100 * hist.filter(c => c < cur.c).length / hist.length).toFixed(0);
    const read = pct >= 85 ? "HIGH vs history" : pct <= 15 ? "LOW vs history" : "normal range";
    out.pairs.push({ pair: name, asOf: cur.d, corr20: +cur.c.toFixed(2), pctile: pct, historyN: hist.length, read });
    console.log(`  ${name.padEnd(15)} ${(cur.c >= 0 ? "+" : "") + cur.c.toFixed(2)}     ${String(pct).padStart(3)}th of ${hist.length}          ${read}`);
  }

  // divergence flags — 20-session return gaps that historically precede regime turns
  const ret20 = (f) => {
    const s = series(f).filter(r => Number.isFinite(r.v));
    if (s.length < 21) return null;
    let acc = 1; for (const r of s.slice(-20)) acc *= (1 + r.v);
    return (acc - 1) * 100;
  };
  const lvl20 = (f) => { // for level series (breadth)
    const s = days.map(d => tape.days[d][f]).filter(Number.isFinite);
    return s.length >= 21 ? s[s.length - 1] - s[s.length - 21] : null;
  };
  const dv = (name, val, note) => { if (val != null) { out.divergences.push({ name, value: +val.toFixed(2), note }); console.log(`  ${name.padEnd(22)} ${(val >= 0 ? "+" : "") + val.toFixed(2)}  ${note}`); } };
  console.log(`\n  divergences (20-session gaps):`);
  const s20 = ret20("spx");
  if (s20 != null) {
    const h20 = ret20("hyg"); if (h20 != null) dv("credit vs stocks", h20 - s20, "credit refusing to confirm an equity move has led turns");
    const r20 = ret20("rut"); if (r20 != null) dv("small vs large", r20 - s20, "narrow leadership when deeply negative");
  }
  dv("breadth 20d change", lvl20("breadth"), "participation moving with or against the index");

  fs.writeFileSync(D("cross-asset.json"), JSON.stringify(out, null, 1));
  console.log(`\n  written: backend/data/cross-asset.json`);
})().catch(e => { console.error("  cross-asset failed:", e.message); process.exit(1); });
