#!/usr/bin/env node
/**
 * TRAIDS — Dip-Reversion Kill-Test (the honest version)
 *
 * movers-backtest.js found ONE flicker: buying the day's biggest LOSERS and holding ~a week
 * showed positive alpha — but in a bull-only 750-day window, with overlapping holds and
 * generous costs. This script tries to KILL that result with the three things that usually do:
 *
 *   1) REGIME SPLIT  — tag every day by SPY vs its 200-day MA (bull / bear) and report the dip
 *      play separately. "Buy the biggest loser" always shines in a bull; the question is what it
 *      does in 2022's falling-knife tape. So we extend the window to cover the 2022 bear.
 *   2) NON-OVERLAPPING HOLDS — the daily-portfolio t-stat in v1 was inflated because 10-day holds
 *      overlap 10x. Here significance is computed on NON-overlapping cohorts (step = horizon), so
 *      each observation is independent and the t-stat is honest.
 *   3) MOVE-SCALED SLIPPAGE — a name that just dumped 8% is the worst thing to fill at the close.
 *      Per-side cost = COST_BPS + SLIP_PER_MOVE × |move%|, so big movers pay realistic friction.
 *
 * Long DIP only (buy the biggest losers); chase/fade printed as a one-line reference. Entry =
 * mover-day close, hold H sessions, exit at close. A play that survives the bear regime AND the
 * non-overlap t-stat AND the realistic slippage is worth building. One that doesn't is a dashboard.
 *
 * HONEST BIASES (still present, all flatter results): selection/survivorship (today's liquid
 * high-beta survivors), perfect close fills beyond the slippage model, daily bars only.
 *
 * Usage:  node backend/movers-dip-regime.js
 *         DAYS=1600 TOPK=10 MOVE_MIN=4 COST_BPS=5 SLIP_PER_MOVE=3 HORIZONS=3,5,10 node backend/movers-dip-regime.js
 */
const fs = require("fs");
const path = require("path");

function loadEnv() { try { const txt = fs.readFileSync(path.join(__dirname, ".env"), "utf8"); for (const line of txt.split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} }
loadEnv();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
if (!KEY || !SEC || /your_|xxx|changeme/i.test(KEY)) { console.error("\n  No real ALPACA keys in backend/.env.\n"); process.exit(1); }
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };

const DAYS = parseInt(process.env.DAYS || "1600");               // ~6.5y back → covers the 2022 bear
const COST_BPS = parseFloat(process.env.COST_BPS || "5");        // base per-side cost
const SLIP_PER_MOVE = parseFloat(process.env.SLIP_PER_MOVE || "3"); // extra bps/side per 1% of the day's move
const TOPK = parseInt(process.env.TOPK || "10");
const MOVE_MIN = parseFloat(process.env.MOVE_MIN || "4");        // a "loser" must be down at least this %
const RVOL_MIN = parseFloat(process.env.RVOL_MIN || "1");
const HORIZONS = (process.env.HORIZONS || "3,5,10").split(",").map(s => parseInt(s.trim())).filter(Boolean);

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
const sma = (arr, per, i) => i < per - 1 ? null : mean(arr.slice(i - per + 1, i + 1));

(async () => {
  console.log(`\n  TRAIDS — Dip-Reversion Kill-Test · ${UNIVERSE.length} names · ~${DAYS}d (through the 2022 bear)`);
  console.log(`  DIP = buy names down ≥ ${MOVE_MIN}%${RVOL_MIN > 1 ? ` & RVOL ≥ ${RVOL_MIN}` : ""} · top ${TOPK}/day · cost ${COST_BPS}bps + ${SLIP_PER_MOVE}bps×|move%| · NON-overlapping holds\n`);

  // SPY regime: bull = SPY close > its 200-day MA
  process.stdout.write("  fetching SPY regime + universe");
  const spy = await fetchBars("SPY");
  const spyClose = spy.map(b => b.close);
  const regime = {};   // date -> 'bull' | 'bear'
  for (let i = 0; i < spy.length; i++) { const ma = sma(spyClose, 200, i); if (ma != null) regime[spy[i].t] = spy[i].close > ma ? "bull" : "bear"; }

  const bySym = {};
  for (const sym of UNIVERSE) { const d = await fetchBars(sym); process.stdout.write("."); if (d.length > 60) bySym[sym] = d; }
  console.log(`  ${Object.keys(bySym).length} names\n`);

  const idx = {}, ret = {}, rvol = {};
  for (const [sym, d] of Object.entries(bySym)) {
    const ix = {}, rt = {}, rv = {};
    for (let i = 0; i < d.length; i++) { ix[d[i].t] = i; if (i >= 1 && d[i - 1].close > 0) rt[d[i].t] = d[i].close / d[i - 1].close - 1; if (i >= 20) { const av = mean(d.slice(i - 20, i).map(b => b.volume)); rv[d[i].t] = av > 0 ? d[i].volume / av : 0; } }
    idx[sym] = ix; ret[sym] = rt; rvol[sym] = rv;
  }
  const fwdRet = (sym, t, H) => { const i = idx[sym][t]; const bars = bySym[sym]; if (i == null || i + H >= bars.length) return null; const e = bars[i].close, x = bars[i + H].close; return e > 0 ? x / e - 1 : null; };
  const slip = movePct => 2 * (COST_BPS + SLIP_PER_MOVE * Math.abs(movePct)) / 100;   // ROUND-TRIP cost in percentage points (bps→%)

  const allDates = [...new Set(Object.values(bySym).flatMap(d => d.map(b => b.t)))].filter(Boolean).sort();
  const bullDays = allDates.filter(t => regime[t] === "bull").length, bearDays = allDates.filter(t => regime[t] === "bear").length;
  console.log(`  regime coverage: ${bullDays} bull days · ${bearDays} bear days (SPY vs 200-MA)\n`);

  // For each horizon, collect NON-overlapping daily-portfolio returns, split by regime.
  // Non-overlap: walk the date axis in steps of H so cohort holds never overlap.
  const out = {};   // h -> { all:[], bull:[], bear:[], chase:[], fade:[], nTrades, bearTrades }
  for (const h of HORIZONS) {
    const series = { all: [], bull: [], bear: [], chase: [], fade: [] };
    let nTrades = 0, bearTrades = 0;
    for (let di = 0; di < allDates.length; di += h) {
      const t = allDates[di]; const reg = regime[t]; if (!reg) continue;
      const movers = [];
      for (const sym of UNIVERSE) { if (ret[sym]?.[t] == null) continue; movers.push({ sym, ret: ret[sym][t], rv: rvol[sym]?.[t] ?? 0 }); }
      if (movers.length < TOPK * 2) continue;
      const elig = movers.filter(m => Math.abs(m.ret) * 100 >= MOVE_MIN && m.rv >= RVOL_MIN);
      const losers  = elig.filter(m => m.ret < 0).sort((a, b) => a.ret - b.ret).slice(0, TOPK);
      const gainers = elig.filter(m => m.ret > 0).sort((a, b) => b.ret - a.ret).slice(0, TOPK);
      // DIP portfolio (this cohort)
      const dipLeg = [];
      for (const l of losers) { const f = fwdRet(l.sym, t, h); if (f == null) continue; dipLeg.push(f * 100 - slip(l.ret * 100)); nTrades++; if (reg === "bear") bearTrades++; }
      if (dipLeg.length) { const r = mean(dipLeg); series.all.push(r); series[reg].push(r); }
      // chase/fade reference (gainers)
      const cg = [], fg = [];
      for (const g of gainers) { const f = fwdRet(g.sym, t, h); if (f == null) continue; cg.push(f * 100 - slip(g.ret * 100)); fg.push(-f * 100 - slip(g.ret * 100)); }
      if (cg.length) series.chase.push(mean(cg));
      if (fg.length) series.fade.push(mean(fg));
    }
    out[h] = { series, nTrades, bearTrades };
  }

  const tstat = a => { if (a.length < 5) return 0; const s = sd(a); return s > 0 ? mean(a) / (s / Math.sqrt(a.length)) : 0; };
  const pad = (s, n) => String(s).padEnd(n);
  const cell = (a) => a.length < 3 ? pad("—", 22) : pad(`${(mean(a) >= 0 ? "+" : "") + mean(a).toFixed(2)}% (t ${(tstat(a) >= 0 ? "+" : "") + tstat(a).toFixed(2)}, n${a.length})`, 22);

  console.log("  DIP (buy biggest losers) — NON-overlapping cohort returns, by regime:");
  console.log("    " + pad("hold", 7) + pad("ALL regimes", 22) + pad("BULL only", 22) + "BEAR only");
  for (const h of HORIZONS) { const s = out[h].series; console.log("    " + pad(h + "d", 7) + cell(s.all) + cell(s.bull) + cell(s.bear)); }

  console.log("\n  Reference — gainers (non-overlapping, same slippage):");
  console.log("    " + pad("hold", 7) + pad("CHASE (buy rip)", 22) + "FADE (short rip)");
  for (const h of HORIZONS) { const s = out[h].series; console.log("    " + pad(h + "d", 7) + cell(s.chase) + cell(s.fade)); }

  console.log("\n  VERDICT GUIDE:");
  console.log("   • The dip survives ONLY if BEAR-only stays positive with |t| ≳ 2. Bull-only positive is");
  console.log("     expected and proves nothing (buying weakness always works while the tape rises).");
  console.log("   • These t-stats are now de-overlapped (independent cohorts) and slippage-loaded, so they're");
  console.log("     the honest ones. If BEAR is negative or noisy → the dip is a bull-regime artifact = dashboard.");
  console.log("   • Survivorship still flatters everything → a borderline BEAR result is really a fail.\n");
})().catch(e => { console.error("\n  Kill-test error:", e.message, "\n"); process.exit(1); });
