#!/usr/bin/env node
/**
 * TRAIDS — Batch Hypothesis-Testing Harness
 *
 * Honest strategy screening. For each strategy family we grid-search parameters
 * on a TRAIN window, lock the single best combo, then judge it ONLY on a held-out
 * TEST window — net of transaction costs — and compare to buy-and-hold. A strategy
 * "survives" only if it clears the bar OUT-OF-SAMPLE. The expected (honest) result
 * is that most strategies do NOT survive once costs and out-of-sample testing are
 * applied. That null result is the point: it stops you trading noise.
 *
 * Usage:  node hypothesis-harness.js            (needs the data backend on :3001)
 *         COST_BPS=10 DAYS=1000 node hypothesis-harness.js
 */
const BACKEND = process.env.BACKEND || "http://localhost:3001";
const DAYS    = parseInt(process.env.DAYS || "1000");
const COST_BPS = parseFloat(process.env.COST_BPS || "10");   // round-trip cost per unit turnover, basis points
const TRAIN_FRAC = 0.6;
const ANN = 252;

const UNIVERSE = [
  "AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","JPM","V","UNH",
  "XOM","JNJ","WMT","PG","MA","HD","CVX","ABBV","KO","PEP",
  "COST","MRK","AVGO","LLY","BAC","ADBE","CRM","NFLX","AMD","DIS",
];

// ── indicators ────────────────────────────────────────────────────────────────
const sma = (a, p, i) => { if (i < p - 1) return null; let s = 0; for (let k = i - p + 1; k <= i; k++) s += a[k]; return s / p; };
function rsiSeries(closes, p = 14) {
  const out = Array(closes.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= p; l /= p; out[p] = 100 - 100 / (1 + (l === 0 ? 100 : g / l));
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (p - 1) + (d > 0 ? d : 0)) / p;
    l = (l * (p - 1) + (d < 0 ? -d : 0)) / p;
    out[i] = 100 - 100 / (1 + (l === 0 ? 100 : g / l));
  }
  return out;
}
const rollHigh = (highs, p, i) => { if (i < p) return null; let m = -Infinity; for (let k = i - p; k < i; k++) m = Math.max(m, highs[k]); return m; };
const rollLow  = (lows,  p, i) => { if (i < p) return null; let m =  Infinity; for (let k = i - p; k < i; k++) m = Math.min(m, lows[k]);  return m; };

// ── strategies: each returns a position series (+1 long / 0 flat / -1 short) ───
const STRATEGIES = {
  "SMA cross (long/short)": {
    grid: [[10,50],[20,100],[50,200],[20,50],[10,100]].map(([f,s]) => ({ fast:f, slow:s })),
    pos: (bars, pr) => {
      const c = bars.map(b => b.c); const out = Array(c.length).fill(0);
      for (let i = 0; i < c.length; i++) { const f = sma(c, pr.fast, i), s = sma(c, pr.slow, i); if (f != null && s != null) out[i] = f > s ? 1 : -1; }
      return out;
    },
  },
  "RSI mean-reversion (long)": {
    grid: [[25,55],[30,55],[30,60],[35,60],[25,50]].map(([b,s]) => ({ buy:b, sell:s })),
    pos: (bars, pr) => {
      const c = bars.map(b => b.c); const r = rsiSeries(c, 14); const out = Array(c.length).fill(0); let inPos = 0;
      for (let i = 0; i < c.length; i++) { if (r[i] == null) { out[i] = 0; continue; } if (inPos && r[i] >= pr.sell) inPos = 0; else if (!inPos && r[i] <= pr.buy) inPos = 1; out[i] = inPos; }
      return out;
    },
  },
  "Donchian breakout (long)": {
    grid: [[20,10],[40,20],[55,20],[20,5],[55,10]].map(([e,x]) => ({ entry:e, exit:x })),
    pos: (bars, pr) => {
      const hi = bars.map(b => b.h), lo = bars.map(b => b.l), c = bars.map(b => b.c); const out = Array(c.length).fill(0); let inPos = 0;
      for (let i = 0; i < c.length; i++) { const eH = rollHigh(hi, pr.entry, i), xL = rollLow(lo, pr.exit, i); if (inPos && xL != null && c[i] < xL) inPos = 0; else if (!inPos && eH != null && c[i] > eH) inPos = 1; out[i] = inPos; }
      return out;
    },
  },
};

// ── backtest a position series over a [lo,hi) slice; net of costs ─────────────
function evalReturns(bars, pos, lo, hi) {
  const rets = [];
  for (let i = lo + 1; i < hi; i++) {
    const r = (bars[i].c - bars[i - 1].c) / bars[i - 1].c;
    const turn = Math.abs((pos[i - 1] || 0) - (pos[i - 2] || 0));
    rets.push((pos[i - 1] || 0) * r - turn * (COST_BPS / 10000));
  }
  return rets;
}
function stats(rets) {
  const n = rets.length || 1;
  const mean = rets.reduce((s, r) => s + r, 0) / n;
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / n) || 1e-9;
  let eq = 1, peak = 1, mdd = 0;
  for (const r of rets) { eq *= 1 + r; peak = Math.max(peak, eq); mdd = Math.min(mdd, eq / peak - 1); }
  return { annRet: mean * ANN, sharpe: (mean / sd) * Math.sqrt(ANN), totalRet: eq - 1, maxDD: mdd };
}
const buyHold = (bars, lo, hi) => stats(evalReturns(bars, Array(bars.length).fill(1), lo, hi));

// ── data ──────────────────────────────────────────────────────────────────────
async function fetchBars() {
  const r = await fetch(`${BACKEND}/api/equities/bars`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbols: UNIVERSE, days: DAYS }),
  });
  if (!r.ok) throw new Error(`bars endpoint ${r.status} — is the backend on :3001 with Alpaca keys?`);
  const j = await r.json();
  return j.data || {};
}

(async () => {
  console.log(`\n  TRAIDS — Batch Hypothesis Harness`);
  console.log(`  universe ${UNIVERSE.length} names · ${DAYS}d history · ${COST_BPS}bps round-trip cost · ${(TRAIN_FRAC*100)|0}/${100-(TRAIN_FRAC*100)|0} train/test\n`);
  const data = await fetchBars();
  const symbols = UNIVERSE.filter(s => Array.isArray(data[s]) && data[s].length > 200);
  if (!symbols.length) { console.error("  No symbols with enough data."); process.exit(1); }
  console.log(`  ${symbols.length}/${UNIVERSE.length} names returned sufficient real data.\n`);

  // buy-and-hold benchmark on the TEST window (pooled average)
  let bhRet = 0, bhSharpe = 0;
  for (const s of symbols) { const b = data[s]; const split = Math.floor(b.length * TRAIN_FRAC); const st = buyHold(b, split, b.length); bhRet += st.totalRet; bhSharpe += st.sharpe; }
  bhRet /= symbols.length; bhSharpe /= symbols.length;

  const results = [];
  for (const [name, strat] of Object.entries(STRATEGIES)) {
    // grid-search on TRAIN (pooled avg Sharpe), lock best combo
    let best = null;
    for (const pr of strat.grid) {
      let tr = 0, cnt = 0;
      for (const s of symbols) { const b = data[s]; const split = Math.floor(b.length * TRAIN_FRAC); const st = stats(evalReturns(b, strat.pos(b, pr), 0, split)); tr += st.sharpe; cnt++; }
      const trainSharpe = tr / cnt;
      if (!best || trainSharpe > best.trainSharpe) best = { pr, trainSharpe };
    }
    // evaluate the locked combo OUT-OF-SAMPLE (test window)
    let teRet = 0, teSharpe = 0, teDD = 0;
    for (const s of symbols) { const b = data[s]; const split = Math.floor(b.length * TRAIN_FRAC); const st = stats(evalReturns(b, strat.pos(b, best.pr), split, b.length)); teRet += st.totalRet; teSharpe += st.sharpe; teDD += st.maxDD; }
    teRet /= symbols.length; teSharpe /= symbols.length; teDD /= symbols.length;
    const survives = teSharpe > 0.5 && teRet > bhRet && teRet > 0;
    results.push({ name, params: JSON.stringify(best.pr), trainSharpe: best.trainSharpe, teSharpe, teRet, teDD, survives });
  }

  results.sort((a, b) => b.teSharpe - a.teSharpe);
  const pad = (s, n) => String(s).padEnd(n);
  console.log("  BENCHMARK (buy & hold, test window):  avg total " + (bhRet*100).toFixed(1) + "%   avg Sharpe " + bhSharpe.toFixed(2) + "\n");
  console.log("  " + pad("Strategy", 28) + pad("Best params", 22) + pad("Train Sh", 10) + pad("OOS Sh", 9) + pad("OOS ret", 10) + pad("OOS DD", 9) + "Survives?");
  console.log("  " + "─".repeat(96));
  for (const r of results)
    console.log("  " + pad(r.name, 28) + pad(r.params, 22) + pad(r.trainSharpe.toFixed(2), 10) + pad(r.teSharpe.toFixed(2), 9) + pad((r.teRet*100).toFixed(1)+"%", 10) + pad((r.teDD*100).toFixed(1)+"%", 9) + (r.survives ? "✅ YES" : "❌ no"));
  const survivors = results.filter(r => r.survives).length;
  console.log("\n  " + survivors + " of " + results.length + " strategies survived out-of-sample, net of costs, beating buy-and-hold.");
  if (survivors === 0) console.log("  → The honest outcome: none cleared the bar. Don't trade these. Sitting out IS the edge.");
  else console.log("  → Survivors are candidates for paper-forward validation — NOT a green light to fund. Re-test live.");
  console.log("");
})().catch(e => { console.error("\n  Harness error:", e.message, "\n"); process.exit(1); });
