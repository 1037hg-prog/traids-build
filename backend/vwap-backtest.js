#!/usr/bin/env node
/**
 * TRAIDS — VWAP Backtest (the one famous rule we hadn't run by name)
 *
 * The canonical VWAP day-trade: long when price is ABOVE the session volume-weighted average
 * price, short when BELOW. This tests it as a standalone intraday signal on EVERY session (it
 * doesn't need the board) across the liquid universe: at a decision time once VWAP is established,
 * take the side price is on, enter at that price, hold to the close, net of a round-trip cost.
 * Stats are DAY-CLUSTERED (all names on a day are one correlated draw → the honest sample is #days).
 *
 * Three decision times are tested (+30m / +1h / +2h) — a small multiple-comparisons surface, so a
 * cell is only interesting at |t| ≳ 3, not 2. VWAP uses the typical price (H+L+C)/3 × volume,
 * accumulated from the 9:30 open.
 *
 * HONEST PRIOR (stated up front): VWAP is just another INTRADAY DIRECTIONAL signal, and
 * intraday-timing-backtest.js already showed every intraday directional hold on these names is
 * net-NEGATIVE after cost. VWAP is widely taught → widely arbitraged. Expect ~0. Survivorship
 * (today's liquid survivors) + thin IEX + perfect fills all flatter the result → treat any
 * positive as a ceiling. A flat/negative result is the expected, honest outcome.
 *
 * Usage:  node backend/vwap-backtest.js
 *         DAYS=300 COST_BPS=5 node backend/vwap-backtest.js
 */
const fs = require("fs"), path = require("path");
function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} }
loadEnv();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
if (!KEY || !SEC || /your_|xxx|changeme/i.test(KEY)) { console.error("\n  No real ALPACA keys in backend/.env.\n"); process.exit(1); }
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };
const DAYS = parseInt(process.env.DAYS || "300");
const COST_BPS = parseFloat(process.env.COST_BPS || "5");
const COST_RT = COST_BPS * 2 / 100;

const UNIVERSE = [
  "AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AMD","NFLX","JPM","BAC","GS","V","MA","UNH",
  "LLY","XOM","CVX","HD","COST","WMT","DIS","NKE","QCOM","INTC","MU","CRM","ORCL","ADBE","AVGO",
];

const etFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
function etParts(iso) { const p = {}; for (const o of etFmt.formatToParts(new Date(iso))) if (o.type !== "literal") p[o.type] = o.value; let h = parseInt(p.hour); if (h === 24) h = 0; return { day: `${p.year}-${p.month}-${p.day}`, min: h * 60 + parseInt(p.minute) }; }
const OPEN = 570, CLOSE = 960;
async function fetchIntraday(sym) { const start = new Date(Date.now() - DAYS * 86_400_000).toISOString(); const out = []; let tok = null; do { const pr = new URLSearchParams({ symbols: sym, timeframe: "5Min", start, limit: "10000", feed: FEED, adjustment: "raw" }); if (tok) pr.set("page_token", tok); const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${pr}`, { headers }); if (!r.ok) break; const j = await r.json(); for (const b of (j.bars?.[sym] || [])) out.push(b); tok = j.next_page_token || null; } while (tok); return out; }
function sessionize(bars) { const d = {}; for (const b of bars) { const { day, min } = etParts(b.t); if (min < OPEN || min >= CLOSE) continue; (d[day] ||= []).push({ min, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 }); } for (const k in d) d[k].sort((a, b) => a.min - b.min); return d; }

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };

(async () => {
  console.log(`\n  TRAIDS — VWAP Backtest · ${UNIVERSE.length} liquid names · ~${DAYS}d · long>VWAP / short<VWAP, hold to close (net ${COST_BPS}bps/side)\n`);
  const DECIDE = [["+30m", 30], ["+1h", 60], ["+2h", 120]];
  // decision label -> { day -> [net ret%] }   (trend interpretation: side = price vs VWAP)
  const trend = {}; DECIDE.forEach(([l]) => trend[l] = {});
  const revn  = {}; DECIDE.forEach(([l]) => revn[l] = {});   // reference: the FADE (reversion) interpretation
  let nSess = 0;

  process.stdout.write("  fetching + replaying");
  for (const sym of UNIVERSE) {
    const sess = sessionize(await fetchIntraday(sym)); process.stdout.write(".");
    for (const day of Object.keys(sess)) {
      const bars = sess[day]; if (bars.length < 12) continue;
      nSess++;
      // running VWAP across the session
      let cumPV = 0, cumV = 0; const vwap = [];
      for (const b of bars) { const tp = (b.h + b.l + b.c) / 3; cumPV += tp * b.v; cumV += b.v; vwap.push(cumV > 0 ? cumPV / cumV : b.c); }
      const closePx = bars[bars.length - 1].c;
      for (const [lbl, dm] of DECIDE) {
        const t = OPEN + dm; let di = -1; for (let i = 0; i < bars.length; i++) { if (bars[i].min <= t) di = i; else break; }
        if (di < 1) continue;                       // need VWAP established
        const px = bars[di].c, vw = vwap[di];
        if (!(px > 0) || !(vw > 0)) continue;
        const dir = px > vw ? 1 : -1;               // trend: trade the side price is on
        const ret = ((closePx - px) / px) * dir * 100 - COST_RT;
        (trend[lbl][day] ||= []).push(ret);
        (revn[lbl][day]  ||= []).push(((closePx - px) / px) * (-dir) * 100 - COST_RT);   // the opposite side
      }
    }
  }
  console.log(`\n\n  ${nSess} session-days replayed.\n`);
  if (!nSess) { console.error("  No sessions.\n"); process.exit(1); }

  const pad = (s, n) => String(s).padEnd(n);
  const dayStat = (byDay) => { const perDay = Object.values(byDay).map(a => mean(a)); const n = perDay.length; if (n < 5) return { n, win: NaN, m: NaN, t: NaN }; const flat = Object.values(byDay).flat(); const win = flat.filter(x => x > 0).length / flat.length * 100; const m = mean(perDay), se = sd(perDay) / Math.sqrt(n); return { n, win, m, t: se > 0 ? m / se : 0, trades: flat.length }; };

  const report = (label, store) => {
    console.log(`  ${label}`);
    console.log("    " + pad("decision", 10) + pad("trades", 9) + pad("days", 7) + pad("win%", 8) + pad("mean net %/trade", 18) + "day-clustered t");
    for (const [lbl] of DECIDE) {
      const s = dayStat(store[lbl]);
      if (isNaN(s.m)) { console.log("    " + pad(lbl, 10) + "too few"); continue; }
      console.log("    " + pad(lbl, 10) + pad(s.trades, 9) + pad(s.n, 7) + pad(s.win.toFixed(1), 8) + pad((s.m >= 0 ? "+" : "") + s.m.toFixed(4) + "%", 18) + (s.t >= 0 ? "+" : "") + s.t.toFixed(2));
    }
    console.log("");
  };

  report("VWAP TREND  (long above / short below — the page's rule):", trend);
  report("VWAP FADE   (reference: the opposite side):", revn);

  console.log("  READ:");
  console.log("   • A real VWAP edge = mean net > 0 with day-clustered |t| ≳ 3 (3 decision times tested).");
  console.log("   • TREND and FADE are mirror images minus 2× cost, so BOTH being ≤ 0 = the cost eats it either way.");
  console.log("   • Compare to intraday-timing-backtest.js: every intraday directional hold was net-negative. VWAP");
  console.log("     is the same family. Survivorship + thin IEX flatter this → treat any positive as a ceiling.\n");
})().catch(e => { console.error("\n  VWAP backtest error:", e.message, "\n"); process.exit(1); });
