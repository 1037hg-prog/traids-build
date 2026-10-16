#!/usr/bin/env node
/**
 * TRAIDS — Movers Backtest (CHASE-the-FOMO vs FADE-the-spike)
 *
 * Tests the idea behind a "big movers" radar: each day, rank every name in the universe by
 * its daily % move, take the top-K gainers (the FOMO names everyone sees on the movers list)
 * and the top-K losers, then settle two opposite plays over several holding horizons:
 *
 *   CHASE  — you saw it rip, so you BUY the gainer at that day's close and hold H days.
 *   FADE   — you SHORT the gainer instead (the short-term-reversal play).
 *   DIP    — you BUY the biggest loser (catch the falling knife) and hold H days.
 *
 * Entry is always the MOVER DAY's close — you can't act until the move has already printed,
 * which is exactly the real-world FOMO disadvantage. Everything is net of cost. Two readouts:
 *   1) pooled per-trade averages (lots of obs, but cross-sectionally correlated → inflated N)
 *   2) a daily equal-weight PORTFOLIO t-stat across trading days — the honest significance test,
 *      because all of a day's movers move together, so the real sample size is ~#days, not #trades.
 *
 * HONEST BIASES — read before trusting anything:
 *  • Selection/survivorship: the universe is today's liquid, high-beta names (the ones that
 *    move). Delisted blowups and names that stopped trading are excluded → flatters results.
 *  • Daily bars only: this answers the DAY→days horizon. The "catch it in the hour/minute"
 *    version needs intraday bars (a separate, heavier fetch) — phase 2, not this file.
 *  • Entry at the signal-day CLOSE assumes a perfect close fill with no slippage on names that
 *    just moved hard (slippage is worst exactly here) → real fills are worse than shown.
 *  • A flat/negative result here is a real red flag for the radar-as-a-trading-tool. A positive
 *    one is a CEILING (biases all point up), not a green light.
 *
 * Usage:  node backend/movers-backtest.js                 (needs ALPACA keys in backend/.env)
 *         DAYS=750 TOPK=10 MOVE_MIN=3 RVOL_MIN=1.5 COST_BPS=5 node backend/movers-backtest.js
 */
const fs = require("fs");
const path = require("path");

function loadEnv() { try { const txt = fs.readFileSync(path.join(__dirname, ".env"), "utf8"); for (const line of txt.split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} }
loadEnv();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
if (!KEY || !SEC || /your_|xxx|changeme/i.test(KEY)) { console.error("\n  No real ALPACA keys in backend/.env.\n"); process.exit(1); }
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };

const DAYS = parseInt(process.env.DAYS || "750");
const COST_BPS = parseFloat(process.env.COST_BPS || "5");        // per side, applied to the %-return
const TOPK = parseInt(process.env.TOPK || "10");                 // movers taken per day, each side
const MOVE_MIN = parseFloat(process.env.MOVE_MIN || "3");        // a "mover" must move at least this % (abs)
const RVOL_MIN = parseFloat(process.env.RVOL_MIN || "1");        // and have at least this relative volume (1 = off)
const HORIZONS = (process.env.HORIZONS || "1,2,3,5,10").split(",").map(s => parseInt(s.trim())).filter(Boolean);
const COST_RT = COST_BPS * 2 / 100;                             // round-trip cost in percentage points

// High-beta + mega-cap liquid universe — the names that actually populate a movers list.
// (Selection bias acknowledged above: these are today's survivors that move.)
const UNIVERSE = [
  "AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AMD","NFLX","CRM","ADBE","AVGO","INTC","QCOM","MU",
  "TXN","ORCL","CSCO","IBM","NOW","SNOW","PLTR","SHOP","UBER","ABNB","COIN","SQ","PYPL","ROKU","ZM",
  "DOCU","DDOG","NET","CRWD","ZS","OKTA","MDB","TWLO","TEAM","WDAY","PANW","FTNT","MRVL","ON","SMCI",
  "ARM","DELL","HPQ","WDC","STX","ANET","KLAC","LRCX","AMAT","ASML","TSM","SOFI","HOOD","AFRM","UPST",
  "RIVN","LCID","NIO","XPEV","LI","F","GM","BA","CAT","DE","GE","HON","UNP","JPM","BAC","GS","MS","C",
  "WFC","SCHW","V","MA","AXP","COF","BLK","LLY","UNH","JNJ","PFE","MRK","ABBV","BMY","MRNA","BNTX","REGN",
  "VRTX","GILD","AMGN","ISRG","DXCM","XOM","CVX","COP","OXY","SLB","HAL","MPC","WMT","COST","TGT","HD",
  "LOW","NKE","SBUX","MCD","DIS","CMCSA","T","VZ","PG","KO","PEP","MARA","RIOT","CLSK","MSTR","DKNG",
  "CVNA","CHWY","RBLX","U","DASH","PINS","SNAP","SPOT","TTD","ENPH","FSLR","PLUG","BABA","JD","PDD",
];

async function fetchBars(sym) {
  const start = new Date(Date.now() - DAYS * 86_400_000).toISOString().split("T")[0];
  const out = []; let pageToken = null;
  do {
    const params = new URLSearchParams({ symbols: sym, timeframe: "1Day", start, limit: "10000", adjustment: "all", feed: FEED });
    if (pageToken) params.set("page_token", pageToken);
    const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${params}`, { headers });
    if (!r.ok) break;
    const j = await r.json();
    for (const b of (j.bars?.[sym] || [])) out.push({ t: (b.t || "").slice(0, 10), close: b.c, high: b.h, low: b.l, volume: b.v || 0 });
    pageToken = j.next_page_token || null;
  } while (pageToken);
  return out;
}

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };

(async () => {
  console.log(`\n  TRAIDS — Movers Backtest · CHASE vs FADE · ${UNIVERSE.length} names · ~${DAYS}d`);
  console.log(`  mover = |move| ≥ ${MOVE_MIN}%${RVOL_MIN > 1 ? ` & RVOL ≥ ${RVOL_MIN}` : ""} · top ${TOPK}/side/day · entry = mover-day close · cost ${COST_BPS}bps/side\n`);

  // 1) fetch every name, keep date so we can rank cross-sectionally
  const bySym = {};
  process.stdout.write("  fetching");
  for (const sym of UNIVERSE) { const d = await fetchBars(sym); process.stdout.write("."); if (d.length > 60) bySym[sym] = d; }
  console.log(` ${Object.keys(bySym).length} names with history\n`);

  // 2) per-symbol: date-indexed close/vol + precomputed daily return & RVOL(20)
  const idx = {}, ret = {}, rvol = {}, closeAt = {};
  for (const [sym, d] of Object.entries(bySym)) {
    const ix = {}, rt = {}, rv = {}, cl = {};
    for (let i = 0; i < d.length; i++) {
      ix[d[i].t] = i; cl[d[i].t] = d[i].close;
      if (i >= 1 && d[i - 1].close > 0) rt[d[i].t] = d[i].close / d[i - 1].close - 1;
      if (i >= 20) { const av = mean(d.slice(i - 20, i).map(b => b.volume)); rv[d[i].t] = av > 0 ? d[i].volume / av : 0; }
    }
    idx[sym] = ix; ret[sym] = rt; rvol[sym] = rv; closeAt[sym] = cl;
  }
  // 3) master date axis
  const allDates = [...new Set(Object.values(bySym).flatMap(d => Array.isArray(d) ? d.map(b => b.t) : []))].filter(Boolean).sort();

  // accumulators:  bucket -> horizon -> [perTradeReturns]   and  bucket -> horizon -> [dailyPortfolioReturns]
  const maxH = Math.max(...HORIZONS);
  const trade = { chase: {}, fade: {}, dip: {}, kick: {} }, daily = { chase: {}, fade: {}, dip: {}, kick: {} };
  for (const b of ["chase", "fade", "dip", "kick"]) for (const h of HORIZONS) { trade[b][h] = []; daily[b][h] = []; }
  const baseFwd = {}; for (const h of HORIZONS) baseFwd[h] = [];   // universe-wide forward return (drift baseline)

  const fwdRet = (sym, t, H) => { const i = idx[sym][t]; const bars = bySym[sym]; if (i == null || i + H >= bars.length) return null; const e = bars[i].close, x = bars[i + H].close; return e > 0 ? x / e - 1 : null; };

  for (const t of allDates) {
    // every name that has a same-day move & RVOL reading on this date
    const movers = [];
    for (const sym of UNIVERSE) {
      if (ret[sym]?.[t] == null) continue;
      const rv = rvol[sym]?.[t] ?? 0;
      movers.push({ sym, ret: ret[sym][t], rv });
      // universe drift baseline: forward return of ALL names (equal weight), H=each
      for (const h of HORIZONS) { const f = fwdRet(sym, t, h); if (f != null) baseFwd[h].push(f); }
    }
    if (movers.length < TOPK * 2) continue;

    const elig = movers.filter(m => Math.abs(m.ret) * 100 >= MOVE_MIN && m.rv >= RVOL_MIN);
    const gainers = elig.filter(m => m.ret > 0).sort((a, b) => b.ret - a.ret).slice(0, TOPK);
    const losers  = elig.filter(m => m.ret < 0).sort((a, b) => a.ret - b.ret).slice(0, TOPK);

    for (const h of HORIZONS) {
      const cg = [], fg = [], dl = [], kk = [];   // this-day portfolio legs
      for (const g of gainers) { const f = fwdRet(g.sym, t, h); if (f == null) continue; const c = f * 100 - COST_RT; trade.chase[h].push(c); cg.push(c); const fa = -f * 100 - COST_RT; trade.fade[h].push(fa); fg.push(fa); }
      for (const l of losers)  { const f = fwdRet(l.sym, t, h); if (f == null) continue; const d = f * 100 - COST_RT; trade.dip[h].push(d); dl.push(d); const k = -f * 100 - COST_RT; trade.kick[h].push(k); kk.push(k); }   // DIP = buy the loser · KICK = short it (downside momentum)
      if (cg.length) daily.chase[h].push(mean(cg));
      if (fg.length) daily.fade[h].push(mean(fg));
      if (dl.length) daily.dip[h].push(mean(dl));
      if (kk.length) daily.kick[h].push(mean(kk));
    }
  }

  const pad = (s, n) => String(s).padEnd(n);
  const winPct = a => a.length ? a.filter(x => x > 0).length / a.length * 100 : 0;
  // daily-portfolio significance: t = mean/(sd/sqrt(n)); annualized Sharpe scaled by horizon overlap is rough → report t-stat
  const tstat = a => { if (a.length < 5) return 0; const s = sd(a); return s > 0 ? mean(a) / (s / Math.sqrt(a.length)) : 0; };

  const block = (label, bucket, note) => {
    console.log(`  ${label}   ${note}`);
    console.log("    " + pad("hold", 7) + pad("trades", 9) + pad("win%", 8) + pad("avg ret", 11) + pad("vs drift", 11) + pad("days", 7) + pad("daily avg", 12) + "t-stat");
    for (const h of HORIZONS) {
      const tr = trade[bucket][h], dy = daily[bucket][h];
      const drift = mean(baseFwd[h]) * 100;
      const alpha = mean(tr) - ((bucket === "fade" || bucket === "kick") ? -drift : drift);   // chase/dip are long → subtract drift; fade/kick are short → add it back
      const t = tstat(dy);
      console.log("    " + pad(h + "d", 7) + pad(tr.length, 9) + pad(winPct(tr).toFixed(0), 8) +
        pad((mean(tr) >= 0 ? "+" : "") + mean(tr).toFixed(2) + "%", 11) +
        pad((alpha >= 0 ? "+" : "") + alpha.toFixed(2) + "%", 11) +
        pad(dy.length, 7) + pad((mean(dy) >= 0 ? "+" : "") + mean(dy).toFixed(3) + "%", 12) +
        (t >= 0 ? "+" : "") + t.toFixed(2));
    }
    console.log("");
  };

  console.log("  ── BIGGEST GAINERS (the FOMO names — up hard today) ──\n");
  block("CHASE gainers (BUY the rip)", "chase", "");
  block("FADE  gainers (SHORT the rip)", "fade", "");
  console.log("  ── BIGGEST LOSERS (down hard today) ──\n");
  block("DIP   buy the loser (catch the knife)", "dip", "");
  block("KICK  short the loser (ride it down)", "kick", "");

  console.log("  HOW TO READ:");
  console.log("   • 'avg ret' = mean per-trade % return over the hold, net of cost. 'vs drift' nets out the");
  console.log("     universe's own forward drift, so it's the edge from the MOVE itself, not from being long stocks.");
  console.log("   • 't-stat' is the honest one: daily equal-weight portfolio return across days (handles the fact");
  console.log("     that all of a day's movers are correlated). |t| < ~2 = indistinguishable from noise.");
  console.log("   • If CHASE ≤ 0 and FADE ≥ 0 → the radar is a FADE tool, not a FOMO tool. If both ~0 after cost,");
  console.log("     it's a dashboard, not a strategy. Biases flatter everything → treat positives as a ceiling.\n");
})().catch(e => { console.error("\n  Movers backtest error:", e.message, "\n"); process.exit(1); });
