#!/usr/bin/env node
/**
 * TRAIDS — Diversified Trend-Following Test (the real thing)
 *
 * Today's backtest proved the trend edge lives in the HOLD HORIZON, not the 1-day board.
 * This tests trend-following the way it's actually meant to work — the managed-futures /
 * CTA approach, the thing DBMF packages:
 *   • a DIVERSIFIED basket across asset classes (equities, bonds, commodities, FX, RE) via
 *     liquid ETF proxies for the futures a CTA would trade;
 *   • TIME-SERIES MOMENTUM: long if the trailing N-month return is positive, short if
 *     negative — held until the trend flips (weeks-to-months), rebalanced daily;
 *   • INVERSE-VOL weighting so each market contributes equal RISK (a CTA staple);
 *   • net of costs, across ~2021→now so it spans the 2022 bear (trend-following's home turf).
 *
 * The point of managed futures isn't beating stocks — it's a modest standalone return with
 * LOW correlation to stocks (and "crisis alpha" in equity bears). So we report Sharpe, max
 * drawdown, correlation to SPY, AND calendar-year returns vs SPY. Multiple lookbacks are
 * shown (no cherry-picking). Survivorship caveat: today's ETFs over history flatters it.
 *
 * Usage:  node backend/trend-following-test.js        (needs ALPACA keys; DAYS=2000 default)
 */
const fs = require("fs"), path = require("path");
function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} }
loadEnv();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
if (!KEY || !SEC) { console.error("\n  Missing ALPACA keys.\n"); process.exit(1); }
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };
const DAYS = parseInt(process.env.DAYS || "2000");
const COST_BPS = parseFloat(process.env.COST_BPS || "2");   // per unit |Δweight| turnover
const VOL_LB = 60;                                          // inverse-vol lookback
// Diversified basket (ETF proxies for a CTA's futures markets)
const BASKET = ["SPY","QQQ","IWM","EFA","EEM","TLT","IEF","SHY","LQD","HYG","GLD","SLV","DBC","USO","DBA","UUP","FXE","VNQ"];
const LOOKBACKS = [["3-mo", 63], ["6-mo", 126], ["12-mo", 252]];

async function fetchBars(sym) { const start = new Date(Date.now() - DAYS * 86400000).toISOString().split("T")[0]; const out = []; let tok = null; do { const pr = new URLSearchParams({ symbols: sym, timeframe: "1Day", start, limit: "10000", adjustment: "all", feed: FEED }); if (tok) pr.set("page_token", tok); const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${pr}`, { headers }); if (!r.ok) break; const j = await r.json(); for (const b of (j.bars?.[sym] || [])) out.push({ d: (b.t || "").slice(0, 10), c: b.c }); tok = j.next_page_token || null; } while (tok); return out; }

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const std = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
function perf(rets) { const m = mean(rets), v = std(rets); let eq = 1, pk = 1, dd = 0; for (const r of rets) { eq *= 1 + r; pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1); } return { annRet: m * 252, vol: v * Math.sqrt(252), sharpe: v > 0 ? (m / v) * Math.sqrt(252) : 0, total: eq - 1, maxDD: dd }; }
const corr = (a, b) => { const n = Math.min(a.length, b.length); if (n < 3) return 0; const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n)); let sab = 0, sa = 0, sb = 0; for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; sa += da * da; sb += db * db; } return (sa && sb) ? sab / Math.sqrt(sa * sb) : 0; };

(async () => {
  console.log(`\n  TRAIDS — Diversified Trend-Following (CTA-style)  ·  ${BASKET.length} markets · ~${DAYS}d · inverse-vol · ${COST_BPS}bps/turnover\n`);
  process.stdout.write("  fetching");
  const raw = {}; for (const s of BASKET) { raw[s] = await fetchBars(s); process.stdout.write("."); }
  console.log("");
  // align to SPY's date axis
  const master = raw["SPY"].map(b => b.d);
  const idx = {}; master.forEach((d, i) => idx[d] = i);
  const close = {};   // sym -> aligned close array (null where missing)
  const keep = [];
  for (const s of BASKET) { const m = {}; raw[s].forEach(b => m[b.d] = b.c); const arr = master.map(d => m[d] ?? null); const cov = arr.filter(x => x != null).length / arr.length; if (cov > 0.9) { close[s] = arr; keep.push(s); } }
  console.log(`  ${keep.length}/${BASKET.length} markets with full history (${master[0]} → ${master[master.length - 1]})\n`);
  const N = master.length;
  // daily simple returns per market
  const ret = {}; for (const s of keep) { const r = new Array(N).fill(null); for (let i = 1; i < N; i++) if (close[s][i] != null && close[s][i - 1] != null && close[s][i - 1] > 0) r[i] = close[s][i] / close[s][i - 1] - 1; ret[s] = r; }
  const spyRet = ret["SPY"];

  const pad = (s, n) => String(s).padEnd(n);
  console.log("  " + pad("lookback", 10) + pad("ann.ret", 10) + pad("vol", 9) + pad("Sharpe", 9) + pad("maxDD", 9) + "corr→SPY");
  console.log("  " + "─".repeat(60));
  const byLB = {};
  for (const [lbl, LB] of LOOKBACKS) {
    const warm = LB + VOL_LB + 1;
    const port = new Array(N).fill(null);
    const dates = [];
    let prevW = {};
    for (let i = warm; i < N - 1; i++) {
      // signal + inverse-vol weight per market
      const w = {}; let invSum = 0;
      for (const s of keep) {
        if (close[s][i] == null || close[s][i - LB] == null) continue;
        const sig = close[s][i] / close[s][i - LB] - 1 >= 0 ? 1 : -1;
        const vol = std(ret[s].slice(i - VOL_LB, i).filter(x => x != null)) || 1e-6;
        const iv = 1 / vol; invSum += iv; w[s] = { sig, iv };
      }
      if (invSum <= 0) continue;
      let turn = 0, pr = 0;
      const curW = {};
      for (const s of keep) {
        const ww = w[s] ? (w[s].sig * w[s].iv / invSum) : 0;   // signed, risk-weighted, sums |.| ~1
        curW[s] = ww;
        turn += Math.abs(ww - (prevW[s] || 0));
        if (ret[s][i + 1] != null) pr += ww * ret[s][i + 1];
      }
      port[i + 1] = pr - turn * (COST_BPS / 10000);
      dates[i + 1] = master[i + 1];
      prevW = curW;
    }
    const series = []; const sDates = []; const spyAligned = [];
    for (let i = 0; i < N; i++) if (port[i] != null) { series.push(port[i]); sDates.push(dates[i]); spyAligned.push(spyRet[i] ?? 0); }
    const p = perf(series); const c = corr(series, spyAligned);
    byLB[lbl] = { series, dates: sDates };
    console.log("  " + pad(lbl, 10) + pad((p.annRet >= 0 ? "+" : "") + (p.annRet * 100).toFixed(1) + "%", 10) + pad((p.vol * 100).toFixed(1) + "%", 9) + pad(p.sharpe.toFixed(2), 9) + pad((p.maxDD * 100).toFixed(1) + "%", 9) + (c >= 0 ? "+" : "") + c.toFixed(2));
  }

  // calendar-year: the 12-mo strategy vs SPY (the diversification / crisis-alpha view)
  const ref = byLB["12-mo"];
  if (ref) {
    const yrRet = {}, yrSpy = {};
    for (let k = 0; k < ref.series.length; k++) { const y = (ref.dates[k] || "").slice(0, 4); (yrRet[y] ||= []).push(ref.series[k]); }
    // SPY by year over the same master axis
    for (let i = 1; i < N; i++) { const y = (master[i] || "").slice(0, 4); if (spyRet[i] != null) (yrSpy[y] ||= []).push(spyRet[i]); }
    const comp = a => a.reduce((s, r) => s * (1 + r), 1) - 1;
    console.log("\n  CALENDAR YEAR — 12-mo trend strategy vs SPY (the diversification test):");
    console.log("  " + pad("year", 8) + pad("trend", 12) + pad("SPY", 12) + "note");
    for (const y of Object.keys(yrRet).sort()) {
      const t = comp(yrRet[y]) * 100, sp = comp(yrSpy[y] || []) * 100;
      const note = (sp < 0 && t > 0) ? "← made money while SPY fell (crisis alpha)" : "";
      console.log("  " + pad(y, 8) + pad((t >= 0 ? "+" : "") + t.toFixed(1) + "%", 12) + pad((sp >= 0 ? "+" : "") + sp.toFixed(1) + "%", 12) + note);
    }
  }
  console.log(`\n  Read: managed futures isn't meant to BEAT stocks — it's a modest Sharpe with LOW/negative SPY`);
  console.log(`  correlation and positive returns in equity bears (2022). If you see that shape, it's the real,`);
  console.log(`  documented CTA premium — which you can simply BUY as DBMF/KMLM rather than run yourself.\n`);
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
