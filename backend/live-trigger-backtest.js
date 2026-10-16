#!/usr/bin/env node
/**
 * TRAIDS — Live-Trigger vs Close-Trigger Backtest (+ SLIPPAGE KILL-TEST)
 *
 * Close-trigger fires only if price CLOSES beyond a 55-day breakout level (enter at the close).
 * Live-trigger fires the moment price crosses the level INTRADAY (enter at the level), settling
 * through the rest of the day's 5-min bars then the daily bars — so failed breakouts pay whipsaw.
 *
 * Idealized, live-trigger tested BETTER (more signals, higher expectancy) — but its whole edge is
 * the assumption you fill EXACTLY at the level. A breakout is a fast move THROUGH the level, so a
 * real fill is level + slippage (you buy into momentum). This sweeps slippage on the live fill and
 * shows at what level the live advantage collapses to the close-trigger baseline. Same ATR×1.5
 * stop / 2R target / net cost; the stop/target stay anchored at the LEVEL (your bracket is set off
 * the signal, not your slipped fill — so slippage both raises risk and shrinks reward, as in reality).
 *
 * Usage:  node backend/live-trigger-backtest.js
 */
const fs = require("fs"), path = require("path");
function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} }
loadEnv();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
if (!KEY || !SEC) { console.error("\n  Missing ALPACA keys.\n"); process.exit(1); }
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };
const DAYS = parseInt(process.env.DAYS || "400"), LB = 55, RR = 2, COST_BPS = 5, ATR_MULT = 1.5, MAXHOLD = 20;
const SLIPS = [0, 3, 5, 10, 15, 20];   // bps of price added to the live fill (the momentum-through-the-level cost)
const UNIVERSE = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AMD","NFLX","JPM","BAC","GS","V","MA","UNH","XOM","CVX","HD","COST","WMT","QCOM","INTC","MU","CRM","AVGO"];

async function fetchDaily(sym) { const start = new Date(Date.now() - DAYS * 86400000).toISOString().split("T")[0]; const out = []; let tok = null; do { const pr = new URLSearchParams({ symbols: sym, timeframe: "1Day", start, limit: "10000", adjustment: "all", feed: FEED }); if (tok) pr.set("page_token", tok); const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${pr}`, { headers }); if (!r.ok) break; const j = await r.json(); for (const b of (j.bars?.[sym] || [])) out.push({ t: (b.t || "").slice(0, 10), h: b.h, l: b.l, c: b.c }); tok = j.next_page_token || null; } while (tok); return out; }
async function fetchIntraday(sym) { const start = new Date(Date.now() - DAYS * 86400000).toISOString(); const out = []; let tok = null; do { const pr = new URLSearchParams({ symbols: sym, timeframe: "5Min", start, limit: "10000", feed: FEED, adjustment: "raw" }); if (tok) pr.set("page_token", tok); const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${pr}`, { headers }); if (!r.ok) break; const j = await r.json(); for (const b of (j.bars?.[sym] || [])) out.push(b); tok = j.next_page_token || null; } while (tok); return out; }
const etFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
function etParts(iso) { const p = {}; for (const o of etFmt.formatToParts(new Date(iso))) if (o.type !== "literal") p[o.type] = o.value; let h = parseInt(p.hour); if (h === 24) h = 0; return { day: `${p.year}-${p.month}-${p.day}`, min: h * 60 + parseInt(p.minute) }; }
function sessionize(bars) { const d = {}; for (const b of bars) { const { day, min } = etParts(b.t); if (min < 570 || min >= 960) continue; (d[day] ||= []).push({ h: b.h, l: b.l, c: b.c }); } return d; }
function atr(h, l, c, p = 14) { const tr = c.map((_, i) => i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))); const r = new Array(c.length).fill(null); r[p - 1] = tr.slice(0, p).reduce((a, b) => a + b, 0) / p; for (let i = p; i < c.length; i++) r[i] = (r[i - 1] * (p - 1) + tr[i]) / p; return r; }
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
function settle(entry, stop, target, dir, bars) { const sd = Math.abs(entry - stop) || entry * 0.01; for (const b of bars) { if (dir > 0 ? b.l <= stop : b.h >= stop) return mk(entry, stop, dir, sd); if (dir > 0 ? b.h >= target : b.l <= target) return mk(entry, target, dir, sd); } const last = bars.length ? (bars[bars.length - 1].c ?? entry) : entry; return mk(entry, last, dir, sd); }
const mk = (entry, exit, dir, sd) => ({ rMult: ((exit - entry) * dir) / sd, retPct: ((exit - entry) / entry) * dir * 100 - COST_BPS * 2 / 100 });
const stat = (set) => { if (!set.length) return null; const w = set.filter(t => t.rMult > 0).length; const gW = set.filter(t => t.retPct > 0).reduce((s, t) => s + t.retPct, 0), gL = Math.abs(set.filter(t => t.retPct <= 0).reduce((s, t) => s + t.retPct, 0)); return { n: set.length, win: w / set.length * 100, expR: mean(set.map(t => t.rMult)), avgRet: mean(set.map(t => t.retPct)), pf: gL ? gW / gL : 0 }; };

(async () => {
  console.log(`\n  TRAIDS — Live vs Close Trigger + SLIPPAGE KILL-TEST  ·  ${UNIVERSE.length} names · ~${DAYS}d · ${LB}-day breakout\n`);
  const closeT = [], liveRaw = [];   // liveRaw: { lvl, dir, sd, fwd } so we can re-settle at each slippage
  process.stdout.write("  fetching + replaying");
  for (const sym of UNIVERSE) {
    const d = await fetchDaily(sym); process.stdout.write(".");
    if (d.length < LB + 30) continue;
    const sess = sessionize(await fetchIntraday(sym)); process.stdout.write(".");
    const H = d.map(x => x.h), L = d.map(x => x.l), Cl = d.map(x => x.c), aArr = atr(H, L, Cl, 14);
    for (let i = LB; i < d.length - 1; i++) {
      const sd = (aArr[i - 1] || Cl[i - 1] * 0.02) * ATR_MULT; if (!(sd > 0)) continue;
      const dailyFwd = []; for (let k = i + 1; k < Math.min(d.length, i + 1 + MAXHOLD); k++) dailyFwd.push({ h: d[k].h, l: d[k].l, c: d[k].c });
      const sb = sess[d[i].t];
      const lvlUp = Math.max(...H.slice(i - LB, i));
      if (d[i - 1].c <= lvlUp) {
        if (sb && sb.length) { const j = sb.findIndex(b => b.h >= lvlUp); if (j >= 0) liveRaw.push({ lvl: lvlUp, dir: 1, sd, fwd: sb.slice(j + 1).concat(dailyFwd) }); }
        if (d[i].c > lvlUp) closeT.push(settle(d[i].c, d[i].c - sd, d[i].c + sd * RR, 1, dailyFwd));
      }
      const lvlDn = Math.min(...L.slice(i - LB, i));
      if (d[i - 1].c >= lvlDn) {
        if (sb && sb.length) { const j = sb.findIndex(b => b.l <= lvlDn); if (j >= 0) liveRaw.push({ lvl: lvlDn, dir: -1, sd, fwd: sb.slice(j + 1).concat(dailyFwd) }); }
        if (d[i].c < lvlDn) closeT.push(settle(d[i].c, d[i].c + sd, d[i].c - sd * RR, -1, dailyFwd));
      }
    }
  }
  console.log("\n");
  const pad = (s, n) => String(s).padEnd(n);
  const cs = stat(closeT);
  console.log("  BASELINE");
  console.log("  " + pad("CLOSE-trigger", 22) + pad("n " + cs.n, 10) + pad("win " + cs.win.toFixed(0) + "%", 10) + pad("exp " + cs.expR.toFixed(3) + "R", 12) + "PF " + cs.pf.toFixed(2));
  console.log(`\n  LIVE-trigger as slippage on the level-fill rises (does the edge survive real fills?):`);
  console.log("  " + pad("live slippage", 16) + pad("n", 8) + pad("win%", 8) + pad("exp R", 11) + pad("avg ret", 11) + pad("PF", 8) + "vs close");
  console.log("  " + "─".repeat(70));
  for (const slip of SLIPS) {
    const settled = liveRaw.map(r => { const entry = r.lvl + r.dir * r.lvl * slip / 10000; return settle(entry, r.lvl - r.dir * r.sd, r.lvl + r.dir * r.sd * RR, r.dir, r.fwd); });
    const s = stat(settled); const beats = s.expR > cs.expR;
    console.log("  " + pad(slip + " bps", 16) + pad(s.n, 8) + pad(s.win.toFixed(0), 8) + pad((s.expR >= 0 ? "+" : "") + s.expR.toFixed(3), 11) + pad((s.avgRet >= 0 ? "+" : "") + s.avgRet.toFixed(3) + "%", 11) + pad(s.pf.toFixed(2), 8) + (beats ? "BEATS close" : "≤ close"));
  }
  console.log(`\n  READ: find the slippage where LIVE drops to "≤ close". For a 55-day breakout (a fast move`);
  console.log(`  through a level everyone watches), real slippage on a momentum fill is easily 5-20+ bps.`);
  console.log(`  If the edge dies in that range, "live" was a fill-assumption mirage. If it survives 15-20`);
  console.log(`  bps, it's the first genuinely interesting result — then: bigger sample + out-of-sample next.\n`);
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
