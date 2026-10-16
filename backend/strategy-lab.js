#!/usr/bin/env node
/**
 * TRAIDS — Strategy Lab  (OFFLINE candidate-strategy validation)
 *
 * Same honest methodology as hypothesis-harness.js: grid-search each strategy's
 * parameters on a TRAIN window, lock the single best combo, then judge it ONLY on
 * a held-out TEST window — net of transaction costs. A strategy "survives" only if
 * it clears the bar OUT-OF-SAMPLE. Most won't. That null result is the point.
 *
 * Candidates added here (price-only, buildable now):
 *   ★ Market-regime filter   — trend, but longs only when SPY > its MA, shorts only
 *                              when SPY < its MA. Reported HEAD-TO-HEAD vs the same
 *                              trend WITHOUT the gate, so the gate's value is explicit.
 *     Cross-sectional momentum — long top-quintile N-day return, short bottom. Market-neutral.
 *     Short-term reversal      — long biggest k-day losers, short biggest winners. Market-neutral.
 *     Volatility-squeeze break — Bollinger band-width at a multi-month low → trade the break.
 *
 * This is VALIDATION ONLY. It does not touch the live board or the running paper test.
 *
 * Usage:  node backend/strategy-lab.js              (needs the data backend on :3001)
 *         COST_BPS=10 DAYS=1000 node backend/strategy-lab.js
 */
const BACKEND   = process.env.BACKEND || "http://localhost:3001";
const DAYS      = parseInt(process.env.DAYS || "1000");
const COST_BPS  = parseFloat(process.env.COST_BPS || "10");   // cost per unit |Δposition|, basis points
const TRAIN_FRAC = 0.6;
const ANN = 252;

const UNIVERSE = [
  "AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","JPM","V","UNH",
  "XOM","JNJ","WMT","PG","MA","HD","CVX","ABBV","KO","PEP",
  "COST","MRK","AVGO","LLY","BAC","ADBE","CRM","NFLX","AMD","DIS",
];
const BENCH = "SPY";   // market proxy for the regime gate + buy-hold benchmark

// ── indicators ────────────────────────────────────────────────────────────────
const sma = (a, p, i) => { if (i < p - 1) return null; let s = 0; for (let k = i - p + 1; k <= i; k++) s += a[k]; return s / p; };
const std = (a, p, i) => { if (i < p - 1) return null; const m = sma(a, p, i); let s = 0; for (let k = i - p + 1; k <= i; k++) s += (a[k] - m) ** 2; return Math.sqrt(s / p); };

// ── per-symbol backtest of a position series over [lo,hi); net of costs ─────────
function evalReturns(closes, pos, lo, hi) {
  const rets = [];
  for (let i = lo + 1; i < hi; i++) {
    const r = (closes[i] - closes[i - 1]) / closes[i - 1];
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
const buyHold = (closes, lo, hi) => stats(evalReturns(closes, Array(closes.length).fill(1), lo, hi));

// Vol-matched twin (report-only, registered 2026-08-10): the same closes held at a FIXED weight
// w = vol(strategy)/vol(buy-hold), cash at 0% — "same risk, zero skill". A directional strategy
// below its twin is a worse way to own the market it trades, whatever its absolute return; the
// 0% cash leg flatters the STRATEGY (a real twin also earns bill yield). Report-only: the
// survival bar is unchanged — swapping bars would re-grade every prior run (see change registry).
function twinRet(closes, stratRets, lo, hi) {
  const bh = evalReturns(closes, Array(closes.length).fill(1), lo, hi);
  const sd = (a) => { const m = a.reduce((s, x) => s + x, 0) / (a.length || 1); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length || 1)); };
  const w = sd(bh) > 0 ? sd(stratRets) / sd(bh) : 0;
  return stats(bh.map(r => r * w)).totalRet;
}

// ── directional strategies (position series +1/0/-1) ───────────────────────────
function trendPos(closes, { fast, slow }) {
  const out = Array(closes.length).fill(0);
  for (let i = 0; i < closes.length; i++) { const f = sma(closes, fast, i), s = sma(closes, slow, i); if (f != null && s != null) out[i] = f > s ? 1 : -1; }
  return out;
}
// Gate a position series by market regime: longs only when SPY > SPY-MA, shorts only when SPY < SPY-MA.
function regimeGate(pos, spyCloses, regimeP) {
  const out = pos.slice();
  for (let i = 0; i < out.length; i++) {
    const m = sma(spyCloses, regimeP, i);
    if (m == null) { out[i] = 0; continue; }
    const bull = spyCloses[i] > m;
    if (out[i] > 0 && !bull) out[i] = 0;   // no longs in a downtrend
    if (out[i] < 0 && bull)  out[i] = 0;   // no shorts in an uptrend
  }
  return out;
}
// Volatility-squeeze breakout: band-width at a `look`-day low → trade the break of the bands.
function squeezePos(closes, { bb, look }) {
  const n = closes.length, out = Array(n).fill(0);
  const width = Array(n).fill(null), up = Array(n).fill(null), lo = Array(n).fill(null), mid = Array(n).fill(null);
  for (let i = 0; i < n; i++) { const m = sma(closes, bb, i), s = std(closes, bb, i); if (m != null && s != null) { mid[i] = m; up[i] = m + 2 * s; lo[i] = m - 2 * s; width[i] = (up[i] - lo[i]) / m; } }
  let inPos = 0;
  for (let i = 0; i < n; i++) {
    if (width[i] == null) { out[i] = 0; continue; }
    // squeeze = current band-width is the lowest over the trailing `look` window
    let squeeze = false;
    if (i >= look) { let mn = Infinity; for (let k = i - look; k < i; k++) if (width[k] != null) mn = Math.min(mn, width[k]); squeeze = width[i] <= mn; }
    if (inPos > 0 && closes[i] < mid[i]) inPos = 0;
    else if (inPos < 0 && closes[i] > mid[i]) inPos = 0;
    if (!inPos && squeeze) { if (closes[i] > up[i]) inPos = 1; else if (closes[i] < lo[i]) inPos = -1; }
    out[i] = inPos;
  }
  return out;
}

// Relative-volume (RVOL) spike: on a day whose volume >> its 20-day average, ride the
// day's direction for `hold` days. Needs real volume → equities only. Per-symbol.
function rvolPos(bars, { mult, hold }) {
  const c = bars.map(b => b.c), v = bars.map(b => b.v || 0);
  const n = c.length, out = Array(n).fill(0);
  let holdLeft = 0, dir = 0;
  for (let i = 0; i < n; i++) {
    if (holdLeft > 0) { out[i] = dir; holdLeft--; continue; }
    out[i] = 0;
    const av = sma(v, 20, i - 1);
    if (av && av > 0 && v[i] > mult * av && i > 0) {
      const r = (c[i] - c[i - 1]) / c[i - 1];
      if (r > 0) { dir = 1; out[i] = 1; holdLeft = hold - 1; }
      else if (r < 0) { dir = -1; out[i] = -1; holdLeft = hold - 1; }
    }
  }
  return out;
}

// ── cross-sectional engine (market-neutral long/short quintiles) ────────────────
// mat: [{sym, c:[...]}] all the SAME length L (end-aligned). signalAt(c,t) ranks names.
// Returns a per-day portfolio-return array (length L; NaN until warmup), net of turnover cost.
function crossSectional(mat, warmup, signalAt, qFrac = 0.2) {
  const N = mat.length, L = mat[0].c.length;
  const rets = Array(L).fill(NaN);
  let prevW = Array(N).fill(0);
  for (let t = warmup; t < L - 1; t++) {
    const sig = mat.map((m, idx) => ({ idx, s: signalAt(m.c, t) })).filter(o => o.s != null && isFinite(o.s));
    const w = Array(N).fill(0);
    if (sig.length >= 6) {
      sig.sort((a, b) => b.s - a.s);
      const k = Math.max(1, Math.floor(sig.length * qFrac));
      const longs = sig.slice(0, k), shorts = sig.slice(sig.length - k);
      for (const o of longs)  w[o.idx] =  1 / k;
      for (const o of shorts) w[o.idx] = -1 / k;
    }
    let turn = 0; for (let j = 0; j < N; j++) turn += Math.abs(w[j] - prevW[j]);
    let pr = 0; for (let j = 0; j < N; j++) { const r = (mat[j].c[t + 1] - mat[j].c[t]) / mat[j].c[t]; pr += w[j] * r; }
    rets[t + 1] = pr - turn * (COST_BPS / 10000);
    prevW = w;
  }
  return rets;
}
const sliceStats = (rets, lo, hi) => stats(rets.slice(lo, hi).filter(r => !isNaN(r)));

// Pairs / stat-arb (market-neutral): z-score the log-ratio of correlated pairs over a
// rolling window; short the spread when z>entry, long when z<-entry, flat near 0. Each
// pair is gross ~1 (half long / half short). Returns a per-day portfolio-return array.
const PAIRS = [["V","MA"],["JPM","BAC"],["AAPL","MSFT"],["GOOGL","META"],["XOM","CVX"],
               ["KO","PEP"],["NVDA","AMD"],["LLY","MRK"],["HD","WMT"],["COST","PG"]];
function pairsReturns(closesBySym, present, L, { win, entry, exit }) {
  const perDay = Array(L).fill(NaN);
  const state = present.map(() => 0);   // +1 long spread (+A −B), −1 short spread, 0 flat
  for (let t = win; t < L - 1; t++) {
    let dayRet = 0, dayTurn = 0;
    present.forEach(([a, b], pi) => {
      const ca = closesBySym[a], cb = closesBySym[b];
      let m = 0; for (let k = t - win + 1; k <= t; k++) m += Math.log(ca[k] / cb[k]); m /= win;
      let sd = 0; for (let k = t - win + 1; k <= t; k++) sd += (Math.log(ca[k] / cb[k]) - m) ** 2; sd = Math.sqrt(sd / win) || 1e-9;
      const z = (Math.log(ca[t] / cb[t]) - m) / sd;
      const prev = state[pi];
      let st = prev;
      if (st !== 0 && Math.abs(z) < exit) st = 0;
      else if (st === 0 && z > entry) st = -1;
      else if (st === 0 && z < -entry) st = 1;
      state[pi] = st;
      const rA = (ca[t + 1] - ca[t]) / ca[t], rB = (cb[t + 1] - cb[t]) / cb[t];
      dayRet += st * (rA - rB) / 2;
      dayTurn += Math.abs(st - prev);
    });
    const denom = present.length || 1;
    perDay[t + 1] = dayRet / denom - (dayTurn / denom) * (COST_BPS / 10000);
  }
  return perDay;
}

// ── data ────────────────────────────────────────────────────────────────────────
async function fetchBars(symbols) {
  const r = await fetch(`${BACKEND}/api/equities/bars`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbols, days: DAYS }),
  });
  if (!r.ok) throw new Error(`bars endpoint ${r.status} — is the backend on :3001 with Alpaca keys? (start.bat)`);
  const j = await r.json();
  return j.data || {};
}
// end-align two close arrays to equal length (US equities trade the same sessions)
function alignTail(a, b) { const L = Math.min(a.length, b.length); return [a.slice(a.length - L), b.slice(b.length - L)]; }

(async () => {
  console.log(`\n  TRAIDS — Strategy Lab  (offline validation, does NOT touch the live test)`);
  console.log(`  universe ${UNIVERSE.length} names + ${BENCH} · ${DAYS}d · ${COST_BPS}bps/unit turnover · ${(TRAIN_FRAC*100)|0}/${100-((TRAIN_FRAC*100)|0)} train/test\n`);

  const data = await fetchBars([...UNIVERSE, BENCH]);
  const spy = (data[BENCH] || []).map(b => b.c);
  if (spy.length < 250) throw new Error(`${BENCH} returned ${spy.length} bars — need it for the regime gate.`);
  const symbols = UNIVERSE.filter(s => Array.isArray(data[s]) && data[s].length > 250);
  if (!symbols.length) throw new Error("No symbols with enough data.");
  console.log(`  ${symbols.length}/${UNIVERSE.length} names + ${BENCH} returned sufficient real data.\n`);

  // buy-and-hold benchmark (pooled avg over the per-symbol test windows)
  let bhRet = 0, bhSh = 0;
  for (const s of symbols) { const c = data[s].map(b => b.c); const split = Math.floor(c.length * TRAIN_FRAC); const st = buyHold(c, split, c.length); bhRet += st.totalRet; bhSh += st.sharpe; }
  bhRet /= symbols.length; bhSh /= symbols.length;

  const rows = [];   // {name, params, trainSh, teSh, teRet, teDD, neutral, survives}

  // ── 1) TREND ± REGIME GATE (head-to-head, pooled over symbols) ────────────────
  const TREND_GRID = [[10,50],[20,50],[20,100],[50,200]].map(([f,s]) => ({ fast:f, slow:s }));
  const REGIME_P = 50;
  for (const gated of [false, true]) {
    let best = null;
    for (const pr of TREND_GRID) {
      let tr = 0, cnt = 0;
      for (const s of symbols) {
        const [c, sp] = alignTail(data[s].map(b => b.c), spy);
        let pos = trendPos(c, pr); if (gated) pos = regimeGate(pos, sp, REGIME_P);
        const split = Math.floor(c.length * TRAIN_FRAC);
        tr += stats(evalReturns(c, pos, 0, split)).sharpe; cnt++;
      }
      const trainSh = tr / cnt; if (!best || trainSh > best.trainSh) best = { pr, trainSh };
    }
    let teRet = 0, teSh = 0, teDD = 0, teTw = 0;
    for (const s of symbols) {
      const [c, sp] = alignTail(data[s].map(b => b.c), spy);
      let pos = trendPos(c, best.pr); if (gated) pos = regimeGate(pos, sp, REGIME_P);
      const split = Math.floor(c.length * TRAIN_FRAC);
      const rets = evalReturns(c, pos, split, c.length);
      const st = stats(rets); teRet += st.totalRet; teSh += st.sharpe; teDD += st.maxDD;
      teTw += twinRet(c, rets, split, c.length);
    }
    teRet /= symbols.length; teSh /= symbols.length; teDD /= symbols.length; teTw /= symbols.length;
    rows.push({ name: gated ? `★ Trend + regime gate (SPY>${REGIME_P}MA)` : "Trend (no gate, baseline)",
      params: JSON.stringify(best.pr), trainSh: best.trainSh, teSh, teRet, teDD, twin: teTw, neutral: false,
      survives: teSh > 0.5 && teRet > bhRet && teRet > 0 });
  }

  // ── 2) VOLATILITY-SQUEEZE BREAKOUT (pooled over symbols) ──────────────────────
  {
    const GRID = [[20,120],[20,200],[20,60]].map(([bb,look]) => ({ bb, look }));
    let best = null;
    for (const pr of GRID) {
      let tr = 0, cnt = 0;
      for (const s of symbols) { const c = data[s].map(b => b.c); const split = Math.floor(c.length * TRAIN_FRAC); tr += stats(evalReturns(c, squeezePos(c, pr), 0, split)).sharpe; cnt++; }
      const trainSh = tr / cnt; if (!best || trainSh > best.trainSh) best = { pr, trainSh };
    }
    let teRet = 0, teSh = 0, teDD = 0, teTw = 0;
    for (const s of symbols) { const c = data[s].map(b => b.c); const split = Math.floor(c.length * TRAIN_FRAC); const rets = evalReturns(c, squeezePos(c, best.pr), split, c.length); const st = stats(rets); teRet += st.totalRet; teSh += st.sharpe; teDD += st.maxDD; teTw += twinRet(c, rets, split, c.length); }
    teRet /= symbols.length; teSh /= symbols.length; teDD /= symbols.length; teTw /= symbols.length;
    rows.push({ name: "Volatility-squeeze breakout", params: JSON.stringify(best.pr), trainSh: best.trainSh, teSh, teRet, teDD, twin: teTw, neutral: false, survives: teSh > 0.5 && teRet > bhRet && teRet > 0 });
  }

  // ── 2b) RELATIVE-VOLUME (RVOL) SPIKE (directional, needs volume → equities) ────
  {
    const GRID = [[2,3],[2.5,5],[3,5],[2,10]].map(([mult,hold]) => ({ mult, hold }));
    let best = null;
    for (const pr of GRID) {
      let tr = 0, cnt = 0;
      for (const s of symbols) { const c = data[s].map(b => b.c); const split = Math.floor(c.length * TRAIN_FRAC); tr += stats(evalReturns(c, rvolPos(data[s], pr), 0, split)).sharpe; cnt++; }
      const trainSh = tr / cnt; if (!best || trainSh > best.trainSh) best = { pr, trainSh };
    }
    let teRet = 0, teSh = 0, teDD = 0, teTw = 0;
    for (const s of symbols) { const c = data[s].map(b => b.c); const split = Math.floor(c.length * TRAIN_FRAC); const rets = evalReturns(c, rvolPos(data[s], best.pr), split, c.length); const st = stats(rets); teRet += st.totalRet; teSh += st.sharpe; teDD += st.maxDD; teTw += twinRet(c, rets, split, c.length); }
    teRet /= symbols.length; teSh /= symbols.length; teDD /= symbols.length; teTw /= symbols.length;
    rows.push({ name: "Relative-volume (RVOL) spike", params: JSON.stringify(best.pr), trainSh: best.trainSh, teSh, teRet, teDD, twin: teTw, neutral: false, survives: teSh > 0.5 && teRet > bhRet && teRet > 0 });
  }

  // ── 3) CROSS-SECTIONAL MOMENTUM & 4) SHORT-TERM REVERSAL (market-neutral) ──────
  // build an end-aligned matrix of closes across all symbols
  const minLen = Math.min(...symbols.map(s => data[s].length));
  const mat = symbols.map(s => ({ sym: s, c: data[s].map(b => b.c).slice(-minLen) }));
  const splitX = Math.floor(minLen * TRAIN_FRAC);
  const csFamilies = [
    { name: "Cross-sectional momentum", grid: [20, 60, 120], warmup: 120,
      sig: (lb) => (c, t) => (t >= lb && c[t - lb] > 0) ? (c[t] / c[t - lb] - 1) : null },
    { name: "Short-term reversal", grid: [1, 3, 5], warmup: 5,
      sig: (k) => (c, t) => (t >= k && c[t - k] > 0) ? -(c[t] / c[t - k] - 1) : null },   // long losers → negate
  ];
  for (const fam of csFamilies) {
    let best = null;
    for (const g of fam.grid) {
      const rets = crossSectional(mat, fam.warmup, fam.sig(g));
      const trainSh = sliceStats(rets, 0, splitX).sharpe;
      if (!best || trainSh > best.trainSh) best = { g, trainSh, rets };
    }
    const st = sliceStats(best.rets, splitX, minLen);
    rows.push({ name: fam.name, params: `lookback=${best.g}`, trainSh: best.trainSh, teSh: st.sharpe, teRet: st.totalRet, teDD: st.maxDD,
      neutral: true, survives: st.sharpe > 0.5 && st.totalRet > 0 });   // market-neutral: bar is >0 net of costs, not beating buy-hold
  }

  // ── 5) PAIRS / STAT-ARB (market-neutral) ──────────────────────────────────────
  {
    const closesBySym = Object.fromEntries(mat.map(m => [m.sym, m.c]));
    const present = PAIRS.filter(([a, b]) => closesBySym[a] && closesBySym[b]);
    if (present.length) {
      const GRID = [{ win: 30, entry: 2, exit: 0.5 }, { win: 60, entry: 2, exit: 0.5 }, { win: 30, entry: 2.5, exit: 0.75 }];
      let best = null;
      for (const pr of GRID) {
        const rets = pairsReturns(closesBySym, present, minLen, pr);
        const trainSh = sliceStats(rets, 0, splitX).sharpe;
        if (!best || trainSh > best.trainSh) best = { pr, trainSh, rets };
      }
      const st = sliceStats(best.rets, splitX, minLen);
      rows.push({ name: `Pairs / stat-arb (${present.length} pairs)`, params: `win=${best.pr.win},z=${best.pr.entry}`, trainSh: best.trainSh, teSh: st.sharpe, teRet: st.totalRet, teDD: st.maxDD,
        neutral: true, survives: st.sharpe > 0.5 && st.totalRet > 0 });
    }
  }

  // ── report ────────────────────────────────────────────────────────────────────
  const pad = (s, n) => String(s).padEnd(n);
  console.log("  BENCHMARK (buy & hold, test window):  avg total " + (bhRet*100).toFixed(1) + "%   avg Sharpe " + bhSh.toFixed(2));
  console.log("  (directional strategies must beat buy-hold; market-neutral [N] just need >0 net of costs)");
  console.log("  (Twin = same stocks at a fixed vol-matched weight, cash at 0% — \"same risk, zero skill\". Report-only, not part of the bar.)\n");
  console.log("  " + pad("Strategy", 36) + pad("Best params", 20) + pad("Train Sh", 10) + pad("OOS Sh", 9) + pad("OOS ret", 10) + pad("Twin ret", 10) + pad("OOS DD", 9) + "Survives?");
  console.log("  " + "─".repeat(118));
  for (const r of rows)
    console.log("  " + pad(r.name + (r.neutral ? " [N]" : ""), 36) + pad(r.params, 20) + pad(r.trainSh.toFixed(2), 10) + pad(r.teSh.toFixed(2), 9) + pad((r.teRet*100).toFixed(1)+"%", 10) + pad(r.twin == null ? "—" : (r.twin*100).toFixed(1)+"%" + (r.teRet > r.twin ? " ✓" : ""), 10) + pad((r.teDD*100).toFixed(1)+"%", 9) + (r.survives ? "✅ YES" : "❌ no"));
  const beatTwin = rows.filter(r => r.twin != null && r.teRet > r.twin);
  console.log("\n  Twin check: " + beatTwin.length + " of " + rows.filter(r => r.twin != null).length + " directional strategies beat their vol-matched twin" + (beatTwin.length ? " (" + beatTwin.map(r => r.name).join(", ") + ")." : " — every one is a worse way to own the market it trades."));
  const survivors = rows.filter(r => r.survives);
  console.log("\n  " + survivors.length + " of " + rows.length + " candidates survived out-of-sample, net of costs.");
  // explicit head-to-head verdict on the regime gate
  const base = rows.find(r => r.name.startsWith("Trend (no gate")), gate = rows.find(r => r.name.startsWith("★"));
  if (base && gate) {
    console.log(`\n  ★ Regime-gate verdict:  baseline OOS Sharpe ${base.teSh.toFixed(2)} (DD ${(base.teDD*100).toFixed(1)}%)  →  gated ${gate.teSh.toFixed(2)} (DD ${(gate.teDD*100).toFixed(1)}%)`);
    const better = gate.teSh > base.teSh, shallower = gate.teDD > base.teDD;
    console.log(`     The gate ${better ? "IMPROVED" : "did NOT improve"} risk-adjusted return` + (shallower ? " and reduced drawdown." : ".") + "  (Beta-vs-edge: does filtering by market trend actually help?)");
  }
  if (!survivors.length) console.log("\n  → Honest outcome: none cleared the bar. These don't go on the board. Sitting out IS the edge.");
  else console.log("\n  → Survivors are candidates for PAPER-FORWARD validation after the current month — NOT a green light to fund or to add mid-test.");
  console.log("");
})().catch(e => { console.error("\n  Strategy Lab error:", e.message, "\n"); process.exit(1); });
