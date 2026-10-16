#!/usr/bin/env node
/**
 * TRAIDS — SMC / ICT Backtest (the "smart money" / Inner-Circle-Trader price-action setups)
 *
 * Products like QuantVue sell closed indicators built on SMC/ICT concepts. Those concepts are
 * PUBLIC, so we don't need a $197/mo subscription to test them — we implement the two signature,
 * mechanizable setups and settle them honestly, net of cost, on real daily bars:
 *
 *   1) FAIR VALUE GAP (FVG / imbalance) retracement — a 3-candle gap (low[i] > high[i-2] for
 *      bullish). Enter when price retraces into the gap top; stop the far side of the gap; 2R target.
 *      Invalidated if price closes through the gap before the retrace fills.
 *   2) LIQUIDITY SWEEP / stop-hunt reversal — price takes out a recent swing low (sweeps liquidity)
 *      but CLOSES back above it (failed breakdown). Enter the reversal at the close; stop below the
 *      sweep; 2R target. Bearish mirrors both.
 *
 * Settled like Settle day: scan forward, conservative stop-first, max-hold cap, net of cost. We
 * report win%, expectancy (R), avg net return, and profit factor per setup. HONEST PRIOR: these are
 * chart-pattern NARRATIVES, not documented edges; expect ~0. Daily timeframe here (intraday futures
 * is ICT's native habitat — a heavier phase-2 fetch — but a pattern with no edge on daily is telling).
 * Survivorship + in-sample pattern choice flatter results → a weak number is the ceiling.
 *
 * Usage:  node backend/smc-ict-test.js        (ALPACA keys; DAYS=2000, RR=2, COST_BPS=5)
 */
const fs = require("fs"), path = require("path");
function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} }
loadEnv();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
if (!KEY || !SEC) { console.error("\n  Missing ALPACA keys.\n"); process.exit(1); }
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };
const DAYS = parseInt(process.env.DAYS || "2000"), RR = parseFloat(process.env.RR || "2"), COST_BPS = parseFloat(process.env.COST_BPS || "5");
const ENTRY_WIN = 10, MAXHOLD = 30, SWING_LB = 10;

const UNIVERSE = ["SPY","QQQ","IWM","DIA","AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AMD","NFLX","JPM","BAC","GS","V","MA","UNH","LLY","XOM","CVX","HD","COST","WMT","DIS","NKE","QCOM","INTC","MU","CRM","ORCL","ADBE","AVGO","BA","CAT","GE","F","COIN","PLTR","SHOP","UBER","C","WFC","MS"];

async function fetchBars(sym) { const start = new Date(Date.now() - DAYS * 86400000).toISOString().split("T")[0]; const out = []; let tok = null; do { const pr = new URLSearchParams({ symbols: sym, timeframe: "1Day", start, limit: "10000", adjustment: "all", feed: FEED }); if (tok) pr.set("page_token", tok); const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${pr}`, { headers }); if (!r.ok) break; const j = await r.json(); for (const b of (j.bars?.[sym] || [])) out.push({ o: b.o, h: b.h, l: b.l, c: b.c }); tok = j.next_page_token || null; } while (tok); return out; }
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;

// settle a trade from entryIdx (entry already triggered at `entry`), conservative stop-first
function settle(d, entryIdx, entry, stop, target, dir) {
  const stopDist = Math.abs(entry - stop) || entry * 0.01;
  for (let k = entryIdx; k < Math.min(d.length, entryIdx + MAXHOLD); k++) {
    const hitStop = dir > 0 ? d[k].l <= stop : d[k].h >= stop;
    const hitTgt = dir > 0 ? d[k].h >= target : d[k].l <= target;
    if (hitStop) return mk(entry, stop, dir, stopDist);
    if (hitTgt) return mk(entry, target, dir, stopDist);
  }
  const last = d[Math.min(d.length - 1, entryIdx + MAXHOLD - 1)].c;
  return mk(entry, last, dir, stopDist);
}
const mk = (entry, exit, dir, stopDist) => ({ rMult: ((exit - entry) * dir) / stopDist, retPct: ((exit - entry) / entry) * dir * 100 - COST_BPS * 2 / 100 });

(async () => {
  console.log(`\n  TRAIDS — SMC / ICT Backtest  ·  ${UNIVERSE.length} names · ~${DAYS}d daily · FVG + liquidity sweep · ${RR}R · net ${COST_BPS}bps\n`);
  const trades = { "FVG-bull": [], "FVG-bear": [], "Sweep-bull": [], "Sweep-bear": [] };
  process.stdout.write("  fetching + scanning");
  for (const sym of UNIVERSE) {
    const d = await fetchBars(sym); process.stdout.write("."); if (d.length < 120) continue;
    for (let i = 2; i < d.length - 2; i++) {
      // ── Fair Value Gap (bullish): low[i] > high[i-2] ──
      if (d[i].l > d[i - 2].h) {
        const entry = d[i].l, stop = d[i - 2].h, target = entry + RR * (entry - stop);   // enter at gap top, stop at gap bottom
        for (let j = i + 1; j <= Math.min(d.length - 1, i + ENTRY_WIN); j++) {
          if (d[j].c < stop) break;                 // closed through the gap → invalidated
          if (d[j].l <= entry) { trades["FVG-bull"].push(settle(d, j, entry, stop, target, 1)); break; }
        }
      }
      // ── Fair Value Gap (bearish): high[i] < low[i-2] ──
      if (d[i].h < d[i - 2].l) {
        const entry = d[i].h, stop = d[i - 2].l, target = entry - RR * (stop - entry);
        for (let j = i + 1; j <= Math.min(d.length - 1, i + ENTRY_WIN); j++) {
          if (d[j].c > stop) break;
          if (d[j].h >= entry) { trades["FVG-bear"].push(settle(d, j, entry, stop, target, -1)); break; }
        }
      }
      // ── Liquidity sweep (bullish): take out swing low, close back above ──
      if (i > SWING_LB) {
        let swingLow = Infinity; for (let k = i - SWING_LB; k < i; k++) swingLow = Math.min(swingLow, d[k].l);
        if (d[i].l < swingLow && d[i].c > swingLow) { const entry = d[i].c, stop = d[i].l, target = entry + RR * (entry - stop); if (entry > stop) trades["Sweep-bull"].push(settle(d, i + 1, entry, stop, target, 1)); }
        let swingHigh = -Infinity; for (let k = i - SWING_LB; k < i; k++) swingHigh = Math.max(swingHigh, d[k].h);
        if (d[i].h > swingHigh && d[i].c < swingHigh) { const entry = d[i].c, stop = d[i].h, target = entry - RR * (stop - entry); if (stop > entry) trades["Sweep-bear"].push(settle(d, i + 1, entry, stop, target, -1)); }
      }
    }
  }
  console.log("\n");

  const pad = (s, n) => String(s).padEnd(n);
  const stat = (set) => { if (!set.length) return null; const w = set.filter(t => t.rMult > 0).length; const gW = set.filter(t => t.retPct > 0).reduce((s, t) => s + t.retPct, 0), gL = Math.abs(set.filter(t => t.retPct <= 0).reduce((s, t) => s + t.retPct, 0)); return { n: set.length, win: w / set.length * 100, expR: mean(set.map(t => t.rMult)), avgRet: mean(set.map(t => t.retPct)), pf: gL ? gW / gL : 0 }; };
  console.log("  " + pad("setup", 14) + pad("n", 8) + pad("win%", 8) + pad("exp R", 10) + pad("avg ret", 11) + "profit factor");
  console.log("  " + "─".repeat(62));
  const allT = [];
  for (const k of Object.keys(trades)) { const s = stat(trades[k]); allT.push(...trades[k]); if (!s) { console.log("  " + pad(k, 14) + "no setups"); continue; } console.log("  " + pad(k, 14) + pad(s.n, 8) + pad(s.win.toFixed(0), 8) + pad((s.expR >= 0 ? "+" : "") + s.expR.toFixed(3), 10) + pad((s.avgRet >= 0 ? "+" : "") + s.avgRet.toFixed(3) + "%", 11) + s.pf.toFixed(2)); }
  const all = stat(allT);
  if (all) { console.log("  " + "─".repeat(62)); console.log("  " + pad("ALL", 14) + pad(all.n, 8) + pad(all.win.toFixed(0), 8) + pad((all.expR >= 0 ? "+" : "") + all.expR.toFixed(3), 10) + pad((all.avgRet >= 0 ? "+" : "") + all.avgRet.toFixed(3) + "%", 11) + all.pf.toFixed(2)); }

  console.log(`\n  READ: expectancy near 0 / PF < 1 = the SMC/ICT setups don't beat the 2R settle after cost —`);
  console.log(`  i.e. the same verdict as every other technical pattern. This is what QuantVue's closed`);
  console.log(`  indicators are built on; you just tested the public version for $0 instead of $197/mo.\n`);
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
