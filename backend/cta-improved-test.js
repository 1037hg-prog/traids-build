#!/usr/bin/env node
/**
 * TRAIDS — Improving the CTA Trend Edge (the one real thing)
 *
 * Takes the diversified trend-following premium that SURVIVED every test and stacks the three
 * ROBUST, non-curve-fit improvements real managed-futures shops use, measuring the honest
 * Sharpe lift from each — net of cost, across ~2021→now (so it spans the 2022 bear). Configs:
 *
 *   1. Financials only (equity/bond/FX), single 12-mo momentum   ← the narrow baseline
 *   2. + COMMODITIES added                                       ← breadth (the biggest, safest gain)
 *   3. + MULTI-HORIZON blend (1 / 3 / 12-mo signals averaged)    ← speed diversification
 *   4. + PORTFOLIO VOL-TARGETING (scale book to ~10% ann. vol)   ← risk consistency
 *
 * Each market is inverse-vol weighted (equal risk). Reports Sharpe, vol, maxDD, correlation to
 * SPY, and the 2022 return for EVERY config — because the point of CTA isn't beating stocks,
 * it's a modest Sharpe with low/negative SPY correlation and positive returns in equity bears.
 *
 * HONEST GUARDRAILS: breadth + multi-horizon are STRUCTURAL (robust); vol-targeting is mostly
 * risk consistency, not free Sharpe. Survivorship (today's ETFs over history) flatters all of it.
 * This is a diversifier sleeve, ~0.5–0.9 Sharpe — buyable as DBMF/KMLM. Test, don't worship.
 *
 * Usage:  node backend/cta-improved-test.js        (ALPACA keys; DAYS=2000 default)
 */
const fs = require("fs"), path = require("path");
function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} }
loadEnv();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
if (!KEY || !SEC) { console.error("\n  Missing ALPACA keys.\n"); process.exit(1); }
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };
const DAYS = parseInt(process.env.DAYS || "2000");
const COST_BPS = parseFloat(process.env.COST_BPS || "2");   // per unit |Δweight| turnover
const VOL_LB = 60, LEV_CAP = 3, TARGET_VOL = parseFloat(process.env.TARGET_VOL || "0.10");

const FINANCIALS = ["SPY", "QQQ", "IWM", "EFA", "EEM", "TLT", "IEF", "SHY", "LQD", "HYG", "UUP", "FXE", "VNQ"];
const COMMODITIES = ["GLD", "SLV", "DBC", "USO", "DBA"];
const BASKET = [...FINANCIALS, ...COMMODITIES];

async function fetchBars(sym) { const start = new Date(Date.now() - DAYS * 86400000).toISOString().split("T")[0]; const out = []; let tok = null; do { const pr = new URLSearchParams({ symbols: sym, timeframe: "1Day", start, limit: "10000", adjustment: "all", feed: FEED }); if (tok) pr.set("page_token", tok); const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${pr}`, { headers }); if (!r.ok) break; const j = await r.json(); for (const b of (j.bars?.[sym] || [])) out.push({ d: (b.t || "").slice(0, 10), c: b.c }); tok = j.next_page_token || null; } while (tok); return out; }

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const std = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
function perf(rets) { const m = mean(rets), v = std(rets); let eq = 1, pk = 1, dd = 0; for (const r of rets) { eq *= 1 + r; pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1); } return { annRet: m * 252, vol: v * Math.sqrt(252), sharpe: v > 0 ? (m / v) * Math.sqrt(252) : 0, total: eq - 1, maxDD: dd }; }
const corr = (a, b) => { const n = Math.min(a.length, b.length); if (n < 3) return 0; const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n)); let sab = 0, sa = 0, sb = 0; for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; sa += da * da; sb += db * db; } return (sa && sb) ? sab / Math.sqrt(sa * sb) : 0; };
const comp = a => a.reduce((s, r) => s * (1 + r), 1) - 1;

(async () => {
  console.log(`\n  TRAIDS — Improving the CTA Trend Edge  ·  ${BASKET.length} markets · ~${DAYS}d · inverse-vol · ${COST_BPS}bps/turnover\n`);
  process.stdout.write("  fetching");
  const raw = {}; for (const s of BASKET) { raw[s] = await fetchBars(s); process.stdout.write("."); }
  console.log("");
  const master = raw["SPY"].map(b => b.d); const N = master.length;
  const close = {}, keepSet = new Set();
  for (const s of BASKET) { const m = {}; raw[s].forEach(b => m[b.d] = b.c); const arr = master.map(d => m[d] ?? null); if (arr.filter(x => x != null).length / arr.length > 0.9) { close[s] = arr; keepSet.add(s); } }
  const ret = {}; for (const s of keepSet) { const r = new Array(N).fill(null); for (let i = 1; i < N; i++) if (close[s][i] != null && close[s][i - 1] != null && close[s][i - 1] > 0) r[i] = close[s][i] / close[s][i - 1] - 1; ret[s] = r; }
  const spyRet = ret["SPY"];
  console.log(`  ${keepSet.size}/${BASKET.length} markets with full history (${master[0]} → ${master[master.length - 1]})\n`);

  // run one configuration → { series, dates, spy }
  function run(markets, horizons, volTarget) {
    const mk = markets.filter(s => keepSet.has(s));
    const maxLB = Math.max(...horizons), warm = maxLB + VOL_LB + 1;
    const port = new Array(N).fill(null), dates = []; let prevW = {}; const baseRets = [];
    for (let i = warm; i < N - 1; i++) {
      const w = {}; let invSum = 0;
      for (const s of mk) {
        if (close[s][i] == null) continue;
        let sigSum = 0, sigN = 0;
        for (const h of horizons) if (close[s][i - h] != null) { sigSum += (close[s][i] / close[s][i - h] - 1 >= 0 ? 1 : -1); sigN++; }
        if (!sigN) continue;
        const vol = std(ret[s].slice(i - VOL_LB, i).filter(x => x != null)) || 1e-6;
        const iv = 1 / vol; invSum += iv; w[s] = { sig: sigSum / sigN, iv };   // sig in [-1,1] (blended)
      }
      if (invSum <= 0) continue;
      const base = {}; for (const s of mk) base[s] = w[s] ? (w[s].sig * w[s].iv / invSum) : 0;
      let prBase = 0; for (const s of mk) if (ret[s][i + 1] != null) prBase += base[s] * ret[s][i + 1];
      // portfolio vol-target: scale the whole book toward TARGET_VOL using trailing base vol
      let scale = 1;
      if (volTarget && baseRets.length >= 40) { const tv = std(baseRets.slice(-60)) * Math.sqrt(252); scale = tv > 0 ? Math.min(LEV_CAP, TARGET_VOL / tv) : 1; }
      let turn = 0; const curW = {};
      for (const s of mk) { const ww = base[s] * scale; curW[s] = ww; turn += Math.abs(ww - (prevW[s] || 0)); }
      port[i + 1] = prBase * scale - turn * (COST_BPS / 10000); dates[i + 1] = master[i + 1];
      prevW = curW; baseRets.push(prBase);
    }
    const series = [], sDates = [], spy = [];
    for (let i = 0; i < N; i++) if (port[i] != null) { series.push(port[i]); sDates.push(dates[i]); spy.push(spyRet[i] ?? 0); }
    return { series, dates: sDates, spy };
  }
  const yearRet = (r) => { const ys = {}; for (let k = 0; k < r.series.length; k++) (ys[(r.dates[k] || "").slice(0, 4)] ||= []).push(r.series[k]); return ys; };

  const configs = [
    { name: "1. Financials only · 12-mo",     markets: FINANCIALS, horizons: [252] },
    { name: "2. + Commodities · 12-mo",        markets: BASKET,     horizons: [252] },
    { name: "3. + Multi-horizon 1/3/12-mo",    markets: BASKET,     horizons: [21, 63, 252] },
    { name: "4. + Vol-target ~10%",            markets: BASKET,     horizons: [21, 63, 252], volTarget: true },
  ];

  const pad = (s, n) => String(s).padEnd(n);
  console.log("  " + pad("configuration", 28) + pad("Sharpe", 8) + pad("ann", 8) + pad("vol", 8) + pad("maxDD", 9) + pad("corr→SPY", 10) + "2022");
  console.log("  " + "─".repeat(78));
  let best = null;
  for (const cfg of configs) {
    const r = run(cfg.markets, cfg.horizons, !!cfg.volTarget);
    const p = perf(r.series), c = corr(r.series, r.spy);
    const y2022 = yearRet(r)["2022"]; const r22 = y2022 ? comp(y2022) * 100 : null;
    console.log("  " + pad(cfg.name, 28) + pad(p.sharpe.toFixed(2), 8) + pad((p.annRet >= 0 ? "+" : "") + (p.annRet * 100).toFixed(1) + "%", 8) + pad((p.vol * 100).toFixed(1) + "%", 8) + pad((p.maxDD * 100).toFixed(1) + "%", 9) + pad((c >= 0 ? "+" : "") + c.toFixed(2), 10) + (r22 == null ? "n/a" : (r22 >= 0 ? "+" : "") + r22.toFixed(1) + "%"));
    best = { cfg, r };
  }

  // calendar-year for the final (best-stacked) config vs SPY
  const ys = yearRet(best.r), yspy = {};
  for (let i = 1; i < N; i++) { const y = (master[i] || "").slice(0, 4); if (spyRet[i] != null) (yspy[y] ||= []).push(spyRet[i]); }
  console.log(`\n  CALENDAR YEAR — "${best.cfg.name}" vs SPY (the diversification / crisis-alpha view):`);
  console.log("  " + pad("year", 8) + pad("CTA", 12) + pad("SPY", 12) + "note");
  for (const y of Object.keys(ys).sort()) { const t = comp(ys[y]) * 100, sp = comp(yspy[y] || []) * 100; console.log("  " + pad(y, 8) + pad((t >= 0 ? "+" : "") + t.toFixed(1) + "%", 12) + pad((sp >= 0 ? "+" : "") + sp.toFixed(1) + "%", 12) + (sp < 0 && t > 0 ? "← crisis alpha (made money while SPY fell)" : "")); }

  console.log(`\n  READ: Sharpe should RISE 1→2 (commodities = more independent bets) and 2→3 (speed diversification`);
  console.log(`  smooths whipsaw). 3→4 mostly steadies vol/maxDD — vol-targeting is risk consistency, not free Sharpe.`);
  console.log(`  Even improved this is a ~0.5–0.9 Sharpe DIVERSIFIER with low SPY correlation + 2022 crisis alpha —`);
  console.log(`  the real CTA premium, and still buyable off-the-shelf as DBMF/KMLM. Survivorship flatters all rows.\n`);
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
