#!/usr/bin/env node
/**
 * TRAIDS — Volume-Spike test: is unusual VOLUME itself a signal?
 *
 * The movers matrix (all 4 quadrants dead) conditioned on PRICE moves. This tests the
 * volume dimension directly — including the one untested cell: a volume SPIKE with a
 * SMALL price move ("stealth accumulation/distribution"), the setup behind the
 * documented-but-old Gervais/Kaniel/Mingelgrin high-volume return premium (2001).
 * Registered prior: decayed to ~nothing net of costs; the quiet-spike cell is the only
 * one with a chance, and it will be small if it exists at all.
 *
 * Buckets (signal day t, entry at t's close, long unless noted, net of cost):
 *   QUIET SPIKE UP    — RVOL ≥ 3 · move in (0, +1.5%)      "someone's buying quietly"
 *   QUIET SPIKE DOWN  — RVOL ≥ 3 · move in (−1.5%, 0)      "someone's selling quietly"
 *   LOUD SPIKE UP     — RVOL ≥ 3 · move ≥ +3%              volume-confirmed breakout day
 *   LOUD SPIKE DOWN   — RVOL ≥ 3 · move ≤ −3%              volume-confirmed break down
 *   DEAD VOLUME       — RVOL ≤ 0.5 (any move)              nobody-home control bucket
 * Readouts: pooled per-trade + daily-portfolio t (the honest one), vs universe drift.
 * Same biases as the movers harness (survivor universe, close fills) → positives = ceiling.
 *
 * Usage: node backend/volume-spike-test.js     (env: DAYS=750 RVOL_SPIKE=3 COST_BPS=5)
 */
const fs = require("fs"), path = require("path");
(function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} })();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
if (!KEY || !SEC) { console.error("\n  No ALPACA keys.\n"); process.exit(1); }
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };
const DAYS = parseInt(process.env.DAYS || "750");
const RVOL_SPIKE = parseFloat(process.env.RVOL_SPIKE || "3");
const QUIET = 1.5, LOUD = 3;                                   // % move thresholds
const COST_BPS = parseFloat(process.env.COST_BPS || "5"), COST_RT = COST_BPS * 2 / 100;
const HORIZONS = [1, 3, 5, 10, 20];
const UNIVERSE = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AMD","NFLX","CRM","ADBE","AVGO","INTC","QCOM","MU","TXN","ORCL","CSCO","IBM","NOW","SNOW","PLTR","SHOP","UBER","ABNB","COIN","SQ","PYPL","ROKU","ZM","DOCU","DDOG","NET","CRWD","ZS","OKTA","MDB","TWLO","TEAM","WDAY","PANW","FTNT","MRVL","ON","SMCI","ARM","DELL","HPQ","WDC","STX","ANET","KLAC","LRCX","AMAT","ASML","TSM","SOFI","HOOD","AFRM","UPST","RIVN","LCID","NIO","XPEV","LI","F","GM","BA","CAT","DE","GE","HON","UNP","JPM","BAC","GS","MS","C","WFC","SCHW","V","MA","AXP","COF","BLK","LLY","UNH","JNJ","PFE","MRK","ABBV","BMY","MRNA","BNTX","REGN","VRTX","GILD","AMGN","ISRG","DXCM","XOM","CVX","COP","OXY","SLB","HAL","MPC","WMT","COST","TGT","HD","LOW","NKE","SBUX","MCD","DIS","CMCSA","T","VZ","PG","KO","PEP","MARA","RIOT","CLSK","MSTR","DKNG","CVNA","CHWY","RBLX","U","DASH","PINS","SNAP","SPOT","TTD","ENPH","FSLR","PLUG","BABA","JD","PDD"];

async function fetchBars(sym) {
  const start = new Date(Date.now() - DAYS * 86_400_000).toISOString().split("T")[0];
  const out = []; let tok = null;
  do {
    const p = new URLSearchParams({ symbols: sym, timeframe: "1Day", start, limit: "10000", adjustment: "all", feed: FEED });
    if (tok) p.set("page_token", tok);
    const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${p}`, { headers });
    if (!r.ok) break;
    const j = await r.json();
    for (const b of (j.bars?.[sym] || [])) out.push({ t: (b.t || "").slice(0, 10), close: b.c, volume: b.v || 0 });
    tok = j.next_page_token || null;
  } while (tok);
  return out;
}
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };

(async () => {
  console.log(`\n  TRAIDS — Volume-Spike test · RVOL(20) spike ≥ ${RVOL_SPIKE}× · quiet <${QUIET}% · loud ≥${LOUD}% · ${UNIVERSE.length} names · ~${DAYS}d · ${COST_BPS}bps/side\n`);
  const bySym = {};
  process.stdout.write("  fetching");
  for (const sym of UNIVERSE) { const d = await fetchBars(sym); process.stdout.write("."); if (d.length > 80) bySym[sym] = d; }
  console.log(` ${Object.keys(bySym).length} names\n`);

  const idx = {}, ret = {}, rvol = {};
  for (const [sym, d] of Object.entries(bySym)) {
    const ix = {}, rt = {}, rv = {};
    for (let i = 0; i < d.length; i++) {
      ix[d[i].t] = i;
      if (i >= 1 && d[i - 1].close > 0) rt[d[i].t] = d[i].close / d[i - 1].close - 1;
      if (i >= 20) { const av = mean(d.slice(i - 20, i).map(b => b.volume)); rv[d[i].t] = av > 0 ? d[i].volume / av : 0; }
    }
    idx[sym] = ix; ret[sym] = rt; rvol[sym] = rv;
  }
  const allDates = [...new Set(Object.values(bySym).flatMap(d => d.map(b => b.t)))].sort();
  const fwd = (sym, t, H) => { const i = idx[sym][t]; const d = bySym[sym]; if (i == null || i + H >= d.length) return null; return d[i].close > 0 ? d[i + H].close / d[i].close - 1 : null; };

  const BUCKETS = ["quietUp", "quietDn", "loudUp", "loudDn", "dead"];
  const trade = {}, daily = {}, baseFwd = {};
  for (const b of BUCKETS) { trade[b] = {}; daily[b] = {}; for (const h of HORIZONS) { trade[b][h] = []; daily[b][h] = []; } }
  for (const h of HORIZONS) baseFwd[h] = [];

  for (const t of allDates) {
    const legs = { quietUp: [], quietDn: [], loudUp: [], loudDn: [], dead: [] };
    for (const sym of Object.keys(bySym)) {
      const r = ret[sym]?.[t], rv = rvol[sym]?.[t];
      if (r == null || rv == null) continue;
      for (const h of HORIZONS) { const f = fwd(sym, t, h); if (f != null) baseFwd[h].push(f); }
      const mv = r * 100;
      let b = null;
      if (rv >= RVOL_SPIKE) {
        if (mv > 0 && mv < QUIET) b = "quietUp";
        else if (mv < 0 && mv > -QUIET) b = "quietDn";
        else if (mv >= LOUD) b = "loudUp";
        else if (mv <= -LOUD) b = "loudDn";
      } else if (rv > 0 && rv <= 0.5) b = "dead";
      if (b) legs[b].push(sym);
    }
    for (const b of BUCKETS) {
      if (!legs[b].length) continue;
      for (const h of HORIZONS) {
        const rets = [];
        for (const sym of legs[b]) { const f = fwd(sym, t, h); if (f != null) rets.push(f * 100 - COST_RT); }
        if (rets.length) { trade[b][h].push(...rets); daily[b][h].push(mean(rets)); }
      }
    }
  }

  const pad = (s, n) => String(s).padEnd(n);
  const tstat = a => { if (a.length < 5) return 0; const s = sd(a); return s > 0 ? mean(a) / (s / Math.sqrt(a.length)) : 0; };
  const LBL = { quietUp: "QUIET SPIKE UP   (stealth buy?)", quietDn: "QUIET SPIKE DOWN (stealth sell?)", loudUp: "LOUD SPIKE UP    (confirmed rip)", loudDn: "LOUD SPIKE DOWN  (confirmed dump)", dead: "DEAD VOLUME      (control)" };
  for (const b of BUCKETS) {
    console.log(`  ${LBL[b]}  — long from signal-day close`);
    console.log("    " + pad("hold", 7) + pad("trades", 9) + pad("win%", 7) + pad("avg ret", 11) + pad("vs drift", 11) + pad("days", 7) + "t-stat(daily)");
    for (const h of HORIZONS) {
      const tr = trade[b][h], dy = daily[b][h];
      if (!tr.length) { console.log("    " + pad(h + "d", 7) + "none"); continue; }
      const drift = mean(baseFwd[h]) * 100;
      const alpha = mean(tr) - drift;
      console.log("    " + pad(h + "d", 7) + pad(tr.length, 9) + pad((tr.filter(x => x > 0).length / tr.length * 100).toFixed(0), 7) +
        pad((mean(tr) >= 0 ? "+" : "") + mean(tr).toFixed(2) + "%", 11) + pad((alpha >= 0 ? "+" : "") + alpha.toFixed(2) + "%", 11) +
        pad(dy.length, 7) + (tstat(dy) >= 0 ? "+" : "") + tstat(dy).toFixed(2));
    }
    console.log("");
  }
  console.log(`  READ: the interesting cell is QUIET SPIKE UP — the old "high-volume premium." It's real only if`);
  console.log(`  'vs drift' is positive with daily t ≥ ~2 and survives the usual discounts (survivor universe,`);
  console.log(`  perfect close fills). LOUD cells re-test the movers finding with volume conditioning — expect ~0.`);
  console.log(`  DEAD VOLUME is the control: it should look like drift. Registered prior: decayed-to-nothing.\n`);
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
