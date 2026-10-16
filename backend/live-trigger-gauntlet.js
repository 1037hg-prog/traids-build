#!/usr/bin/env node
/**
 * TRAIDS — Live-Trigger Breakout: THE GAUNTLET
 *
 * The intraday live-trigger survived slippage (the only result all session to do so). This puts it
 * through the full kill-test the rest never reached:
 *   • LONG HISTORY 2018-2026 incl. the 2022 bear (uses the daily-bar approximation of the live
 *     trigger — detect the intraday cross via the daily HIGH/LOW — because 5-min history can't
 *     reach 2022).
 *   • The 1.5× VOLUME filter (the board's actual breakout rule), not bare price crosses.
 *   • A REALISTIC FILL MODEL: if the day GAPS through the level at the open, you fill at the OPEN
 *     (you chase) — you do NOT magically get the level; otherwise you fill at level + 10bps slip.
 *   • A BIGGER UNIVERSE (~70 liquid names).
 *   • An OUT-OF-SAMPLE split (first 60% of dates vs last 40%) AND a by-year breakdown (2022!).
 *
 * Close-trigger (enter at the close, daily settle) is the baseline. Conservative stop-first, 2R,
 * net of cost. If live's edge holds OUT-OF-SAMPLE and THROUGH 2022, it's real. If it only shines
 * in-sample / recent, it was multiple-comparisons noise — same as the other 21.
 *
 * Usage:  node backend/live-trigger-gauntlet.js
 */
const fs = require("fs"), path = require("path");
function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} }
loadEnv();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
if (!KEY || !SEC) { console.error("\n  Missing ALPACA keys.\n"); process.exit(1); }
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };
const DAYS = parseInt(process.env.DAYS || "2600"), LB = 55, RR = 2, COST_BPS = 5, ATR_MULT = 1.5, MAXHOLD = 20;
const SLIP_BPS = parseFloat(process.env.SLIP_BPS || "10"), VOL_MULT = parseFloat(process.env.VOL_MULT || "1.5");
const UNIVERSE = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AMD","NFLX","JPM","BAC","GS","V","MA","UNH","LLY","XOM","CVX","HD","COST","WMT","DIS","NKE","QCOM","INTC","MU","CRM","ORCL","ADBE","AVGO","BA","CAT","GE","F","GM","T","VZ","PG","KO","PEP","MRK","PFE","ABBV","TMO","ABT","DHR","HON","UNP","LOW","SBUX","MCD","CMCSA","TXN","AMAT","MS","C","WFC","SCHW","BLK","AXP","COF","TGT","CVS","UPS","DE","MMM","GILD","AMGN","BKNG","ISRG"];

async function fetchDaily(sym) { const start = new Date(Date.now() - DAYS * 86400000).toISOString().split("T")[0]; const out = []; let tok = null; do { const pr = new URLSearchParams({ symbols: sym, timeframe: "1Day", start, limit: "10000", adjustment: "all", feed: FEED }); if (tok) pr.set("page_token", tok); const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${pr}`, { headers }); if (!r.ok) break; const j = await r.json(); for (const b of (j.bars?.[sym] || [])) out.push({ t: (b.t || "").slice(0, 10), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 }); tok = j.next_page_token || null; } while (tok); return out; }
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
function atr(h, l, c, p = 14) { const tr = c.map((_, i) => i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))); const r = new Array(c.length).fill(null); r[p - 1] = tr.slice(0, p).reduce((a, b) => a + b, 0) / p; for (let i = p; i < c.length; i++) r[i] = (r[i - 1] * (p - 1) + tr[i]) / p; return r; }
function settle(entry, stop, target, dir, bars) { const sd = Math.abs(entry - stop) || entry * 0.01; for (const b of bars) { if (dir > 0 ? b.l <= stop : b.h >= stop) return mk(entry, stop, dir, sd); if (dir > 0 ? b.h >= target : b.l <= target) return mk(entry, target, dir, sd); } return mk(entry, bars.length ? bars[bars.length - 1].c : entry, dir, sd); }
const mk = (entry, exit, dir, sd) => ({ rMult: ((exit - entry) * dir) / sd, retPct: ((exit - entry) / entry) * dir * 100 - COST_BPS * 2 / 100 });
const stat = (set) => { if (!set.length) return null; const w = set.filter(t => t.rMult > 0).length; const gW = set.filter(t => t.retPct > 0).reduce((s, t) => s + t.retPct, 0), gL = Math.abs(set.filter(t => t.retPct <= 0).reduce((s, t) => s + t.retPct, 0)); return { n: set.length, win: w / set.length * 100, expR: mean(set.map(t => t.rMult)), avgRet: mean(set.map(t => t.retPct)), pf: gL ? gW / gL : 0 }; };

(async () => {
  console.log(`\n  TRAIDS — Live-Trigger Breakout GAUNTLET  ·  ${UNIVERSE.length} names · ~${DAYS}d · ${LB}d breakout · ${VOL_MULT}× vol · ${SLIP_BPS}bps slip · gap→open fill\n`);
  const closeT = [], liveT = [];
  process.stdout.write("  fetching + replaying");
  for (const sym of UNIVERSE) {
    const d = await fetchDaily(sym); process.stdout.write(".");
    if (d.length < LB + 30) continue;
    const H = d.map(x => x.h), L = d.map(x => x.l), Cl = d.map(x => x.c), aArr = atr(H, L, Cl, 14);
    for (let i = LB; i < d.length - 1; i++) {
      const sd = (aArr[i - 1] || Cl[i - 1] * 0.02) * ATR_MULT; if (!(sd > 0)) continue;
      const avgVol = mean(d.slice(i - LB, i).map(x => x.v)); if (!(avgVol > 0) || d[i].v < VOL_MULT * avgVol) continue;   // 1.5× volume required
      const fwd = []; for (let k = i; k < Math.min(d.length, i + 1 + MAXHOLD); k++) fwd.push({ h: d[k].h, l: d[k].l, c: d[k].c });   // include entry day i (its low/high = same-day reversal)
      // UP breakout
      const lvlUp = Math.max(...H.slice(i - LB, i));
      if (d[i - 1].c <= lvlUp && d[i].h >= lvlUp) {
        const fill = d[i].o >= lvlUp ? d[i].o : lvlUp + lvlUp * SLIP_BPS / 10000;   // gap-up → chase the open; else level + slip
        liveT.push({ t: d[i].t, ...settle(fill, lvlUp - sd, lvlUp + sd * RR, 1, fwd.slice(1)) });   // settle forward from i+1 (entry intraday day i)
        if (d[i].c > lvlUp) closeT.push({ t: d[i].t, ...settle(d[i].c, d[i].c - sd, d[i].c + sd * RR, 1, fwd.slice(1)) });
      }
      // DOWN breakdown
      const lvlDn = Math.min(...L.slice(i - LB, i));
      if (d[i - 1].c >= lvlDn && d[i].l <= lvlDn) {
        const fill = d[i].o <= lvlDn ? d[i].o : lvlDn - lvlDn * SLIP_BPS / 10000;
        liveT.push({ t: d[i].t, ...settle(fill, lvlDn + sd, lvlDn - sd * RR, -1, fwd.slice(1)) });
        if (d[i].c < lvlDn) closeT.push({ t: d[i].t, ...settle(d[i].c, d[i].c + sd, d[i].c - sd * RR, -1, fwd.slice(1)) });
      }
    }
  }
  console.log("\n");
  // OOS split: first 60% of dates = in-sample, last 40% = out-of-sample
  const dates = [...new Set([...liveT, ...closeT].map(t => t.t))].sort();
  const cut = dates[Math.floor(dates.length * 0.6)] || "9999";
  const pad = (s, n) => String(s).padEnd(n);
  const row = (lbl, s) => console.log("    " + pad(lbl, 22) + (s ? pad("n " + s.n, 9) + pad("win " + s.win.toFixed(0) + "%", 9) + pad("exp " + (s.expR >= 0 ? "+" : "") + s.expR.toFixed(3) + "R", 12) + "PF " + s.pf.toFixed(2) : "no trades"));

  console.log("  OVERALL (2018-2026, with 1.5× vol + realistic fills)");
  row("CLOSE-trigger", stat(closeT)); row("LIVE-trigger", stat(liveT));
  console.log("\n  OUT-OF-SAMPLE SPLIT  (the real test — does it hold on unseen data?)");
  row("CLOSE in-sample", stat(closeT.filter(t => t.t < cut))); row("CLOSE out-of-sample", stat(closeT.filter(t => t.t >= cut)));
  row("LIVE in-sample", stat(liveT.filter(t => t.t < cut))); row("LIVE out-of-sample", stat(liveT.filter(t => t.t >= cut)));
  console.log("\n  LIVE-trigger BY YEAR  (2022 = the bear)");
  const yrs = [...new Set(liveT.map(t => t.t.slice(0, 4)))].sort();
  for (const y of yrs) { const s = stat(liveT.filter(t => t.t.slice(0, 4) === y)); console.log("    " + pad(y, 8) + (s ? pad("n " + s.n, 9) + pad("win " + s.win.toFixed(0) + "%", 9) + "exp " + (s.expR >= 0 ? "+" : "") + s.expR.toFixed(3) + "R" : "") + (y === "2022" ? "  ← bear" : "")); }

  console.log(`\n  VERDICT: real edge = LIVE-trigger stays clearly positive OUT-OF-SAMPLE and isn't carried by`);
  console.log(`  one or two years. If OOS collapses to ~close (or ~0), the earlier result was the recent-window,`);
  console.log(`  multiple-comparisons mirage — and it joins the other 21. Survivorship still flatters everything.\n`);
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
