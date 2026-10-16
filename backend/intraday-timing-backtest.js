#!/usr/bin/env node
/**
 * TRAIDS — Intraday Timing Backtest (time-of-day entry × exit map)
 *
 * Answers two linked questions the daily board can't:
 *   1) Does the CLOCK TIME you enter/exit a board signal change its expectancy? (a grid of
 *      entry ∈ {open, +1h, +2h} × exit ∈ {+1h, +2h, +3h, close})
 *   2) The give-back curve from the open — is there a "+2-3h peak then fade" worth harvesting,
 *      i.e. should you trade only the first few hours instead of holding to the close?
 *
 * Method: the REAL board signal (Trend/Breakout/Mean-Reversion, verbatim from src/App.jsx) is
 * computed on DAILY bars through day i's close — so it is known BEFORE day i+1 opens (no look-
 * ahead). We then enter on day i+1 at the chosen session time and exit at the chosen later time,
 * pricing off 5-minute intraday bars. Every cell is NET of a round-trip cost.
 *
 * WHY THIS IS A HARD TEST (read before hoping):
 *  • The daily signal itself is ~0 expectancy (board-backtest.js: +0.007R, PF 0.89). We're hunting
 *    an intraday TIMING effect layered on a zero-edge signal — a tall order.
 *  • MULTIPLE COMPARISONS: ~12 (entry,exit) cells are tested. With 12 looks, one will show a
 *    "nice" number by chance. A cell is only interesting if it clears a Bonferroni-ish bar
 *    (|t| ≳ 3, not 2) AND the story is monotonic (the give-back curve is smooth, not one lucky cell).
 *  • Re-scanning the daily board intraday does NOT create new signals (daily indicators move
 *    slowly — see signal-turnover.js). Genuinely new intraday signals need an intraday engine,
 *    which we tested separately (intraday-lab.js opening-range: 0/2 OOS).
 *  • Costs/slippage are worst intraday and the t-stats below are POOLED (cross-sectionally
 *    correlated within a day) → real significance is lower than printed. Treat positives as a ceiling.
 *
 * Usage:  node backend/intraday-timing-backtest.js
 *         DAYS=300 COST_BPS=5 MIN_CONF=0.6 node backend/intraday-timing-backtest.js
 */
const fs = require("fs"), path = require("path");
function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} }
loadEnv();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
if (!KEY || !SEC || /your_|xxx|changeme/i.test(KEY)) { console.error("\n  No real ALPACA keys in backend/.env.\n"); process.exit(1); }
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };
const DAYS = parseInt(process.env.DAYS || "300");
const COST_BPS = parseFloat(process.env.COST_BPS || "5");
const MIN_CONF = parseFloat(process.env.MIN_CONF || "0.6");
const COST_RT = COST_BPS * 2 / 100;   // round-trip cost in percentage points

const UNIVERSE = [
  "AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AMD","NFLX","JPM","BAC","GS","V","MA","UNH",
  "LLY","XOM","CVX","HD","COST","WMT","DIS","NKE","QCOM","INTC","MU","CRM","ORCL","ADBE","AVGO",
];

// ── daily indicators + signals (verbatim from src/App.jsx / board-backtest.js) ──
const sma = (p, per) => p.map((_, i) => i < per - 1 ? null : p.slice(i - per + 1, i + 1).reduce((a, b) => a + b, 0) / per);
function atr(h, l, c, period = 14) { const trs = c.map((_, i) => i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))); const r = new Array(c.length).fill(null); r[period - 1] = trs.slice(0, period).reduce((a, b) => a + b, 0) / period; for (let i = period; i < c.length; i++) r[i] = (r[i - 1] * (period - 1) + trs[i]) / period; return r; }
function adx(h, l, c, period = 14) { const n = c.length, r = new Array(n).fill(null), dmP = new Array(n).fill(0), dmM = new Array(n).fill(0); const tr = c.map((_, i) => i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))); for (let i = 1; i < n; i++) { const up = h[i] - h[i - 1], dn = l[i - 1] - l[i]; dmP[i] = up > dn && up > 0 ? up : 0; dmM[i] = dn > up && dn > 0 ? dn : 0; } let sT = tr.slice(1, period + 1).reduce((a, b) => a + b, 0), sP = dmP.slice(1, period + 1).reduce((a, b) => a + b, 0), sM = dmM.slice(1, period + 1).reduce((a, b) => a + b, 0); for (let i = period; i < n; i++) { if (i > period) { sT += tr[i] - sT / period; sP += dmP[i] - sP / period; sM += dmM[i] - sM / period; } const diP = sT > 0 ? 100 * sP / sT : 0, diM = sT > 0 ? 100 * sM / sT : 0, dx = diP + diM > 0 ? 100 * Math.abs(diP - diM) / (diP + diM) : 0; if (i === 2 * period - 1) r[i] = dx; else if (i > 2 * period - 1 && r[i - 1] !== null) r[i] = (r[i - 1] * (period - 1) + dx) / period; } return r; }
function breakoutSignal(d, i, lb = 55) { if (i < lb + 5) return { vote: 0, confidence: 0 }; const w = d.slice(i - lb, i); const hi = Math.max(...w.map(x => x.high ?? x.close)), lo = Math.min(...w.map(x => x.low ?? x.close)); const c = d[i].close, pc = d[i - 1].close, range = (hi - lo) || c * 0.02; const vols = w.map(x => x.volume || 0), av = vols.reduce((s, v) => s + v, 0) / (vols.length || 1); if (!(av > 0)) return { vote: 0, confidence: 0 }; const vr = (d[i].volume || 0) / av; if (vr < 1.5) return { vote: 0, confidence: 0 }; let vote = 0, mag = 0; if (c > hi && pc <= hi) { mag = Math.min(1, (c - hi) / (range * 0.15)); vote = 0.65 + 0.35 * mag; } else if (c < lo && pc >= lo) { mag = Math.min(1, (lo - c) / (range * 0.15)); vote = -(0.65 + 0.35 * mag); } else return { vote: 0, confidence: 0 }; const vb = Math.min(0.22, (vr - 1.5) * 0.12); return { vote, confidence: Math.max(0, Math.min(0.96, 0.50 + 0.18 * mag + vb)), strat: "Breakout" }; }
function meanRevSignal(d, i, lb = 20) { if (i < lb + 30) return { vote: 0, confidence: 0 }; const w = d.slice(i - lb + 1, i + 1).map(x => x.close); const ma = w.reduce((s, v) => s + v, 0) / w.length, sd = Math.sqrt(w.reduce((s, v) => s + (v - ma) ** 2, 0) / w.length) || ma * 0.01; const c = d[i].close, z = (c - ma) / sd; if (Math.abs(z) < 2) return { vote: 0, confidence: 0 }; const lw = d.slice(i - 50, i + 1).map(x => x.close), lma = lw.reduce((s, v) => s + v, 0) / lw.length; let vote = 0; if (z <= -2) { if (c < lma * 0.92) return { vote: 0, confidence: 0 }; vote = Math.min(1, 0.6 + (Math.abs(z) - 2) * 0.2); } else { if (c > lma * 1.08) return { vote: 0, confidence: 0 }; vote = -Math.min(1, 0.6 + (Math.abs(z) - 2) * 0.2); } return { vote, confidence: Math.max(0, Math.min(0.95, 0.55 + (Math.abs(z) - 2) * 0.12)), strat: "Mean-Reversion" }; }
function trendSignal(d, i, fast = 20, slow = 50) { if (i < slow + 12) return { vote: 0, confidence: 0 }; const cl = d.slice(0, i + 1).map(x => x.close), hh = d.slice(0, i + 1).map(x => x.high ?? x.close), ll = d.slice(0, i + 1).map(x => x.low ?? x.close); const mF = sma(cl, fast), mS = sma(cl, slow), f = mF[i], s = mS[i], fp = mF[i - 10]; if (f == null || s == null || fp == null) return { vote: 0, confidence: 0 }; const px = cl[i], slope = (f - fp) / fp, up = px > f && f > s && slope > 0, dn = px < f && f < s && slope < 0; if (!up && !dn) return { vote: 0, confidence: 0 }; const dir = up ? 1 : -1, av = adx(hh, ll, cl, 14)[i] || 0; if (av < 20) return { vote: 0, confidence: 0 }; const sep = Math.abs(f - s) / s; return { vote: dir * Math.min(1, 0.5 + (av - 20) / 60 + Math.min(0.3, sep * 8)), confidence: Math.max(0, Math.min(0.95, 0.5 + (av - 20) / 100 + Math.min(0.2, sep * 6))), strat: "Trend" }; }

// ── data ──
async function fetchDaily(sym) { const start = new Date(Date.now() - DAYS * 86_400_000).toISOString().split("T")[0]; const out = []; let tok = null; do { const pr = new URLSearchParams({ symbols: sym, timeframe: "1Day", start, limit: "10000", adjustment: "all", feed: FEED }); if (tok) pr.set("page_token", tok); const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${pr}`, { headers }); if (!r.ok) break; const j = await r.json(); for (const b of (j.bars?.[sym] || [])) out.push({ t: (b.t || "").slice(0, 10), o: b.o, high: b.h, low: b.l, close: b.c, volume: b.v || 0 }); tok = j.next_page_token || null; } while (tok); return out; }
const etFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
function etParts(iso) { const p = {}; for (const o of etFmt.formatToParts(new Date(iso))) if (o.type !== "literal") p[o.type] = o.value; let h = parseInt(p.hour); if (h === 24) h = 0; return { day: `${p.year}-${p.month}-${p.day}`, min: h * 60 + parseInt(p.minute) }; }
const OPEN = 570, CLOSE = 960;
async function fetchIntraday(sym) { const start = new Date(Date.now() - DAYS * 86_400_000).toISOString(); const out = []; let tok = null; do { const pr = new URLSearchParams({ symbols: sym, timeframe: "5Min", start, limit: "10000", feed: FEED, adjustment: "raw" }); if (tok) pr.set("page_token", tok); const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${pr}`, { headers }); if (!r.ok) break; const j = await r.json(); for (const b of (j.bars?.[sym] || [])) out.push(b); tok = j.next_page_token || null; } while (tok); return out; }
function sessionize(bars) { const d = {}; for (const b of bars) { const { day, min } = etParts(b.t); if (min < OPEN || min >= CLOSE) continue; (d[day] ||= []).push({ min, o: b.o, c: b.c }); } for (const k in d) d[k].sort((a, b) => a.min - b.min); return d; }
function priceAt(bars, m) { if (!bars || !bars.length) return null; if (m === 0) return bars[0].o; const t = OPEN + m; let px = null; for (const b of bars) { if (b.min <= t) px = b.c; else break; } return px != null ? px : bars[bars.length - 1].c; }

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };

(async () => {
  console.log(`\n  TRAIDS — Intraday Timing Backtest · ${UNIVERSE.length} liquid names · ~${DAYS}d · entry/exit clock-time map (net ${COST_BPS}bps/side)\n`);
  const ENTRIES = [["open", 0], ["+1h", 60], ["+2h", 120]];
  const EXITS   = [["+1h", 60], ["+2h", 120], ["+3h", 180], ["close", 999]];
  // cell key "entry>exit" -> [net ret%]   (day-keyed for clustering)
  const cells = {}; for (const [el] of ENTRIES) for (const [xl, xm] of EXITS) cells[`${el}>${xl}`] = {};
  // give-back trajectory from open: open->+30/+60/.../close gross %
  const traj = { 30: [], 60: [], 90: [], 120: [], 150: [], 180: [], close: [] };
  let nSig = 0;

  process.stdout.write("  fetching + replaying");
  for (const sym of UNIVERSE) {
    const daily = await fetchDaily(sym); process.stdout.write(".");
    if (daily.length < 120) continue;
    const sess = sessionize(await fetchIntraday(sym)); process.stdout.write(".");
    const dateIdx = {}; daily.forEach((b, k) => dateIdx[b.t] = k);
    for (let i = 70; i < daily.length - 1; i++) {
      const cands = [trendSignal(daily, i), breakoutSignal(daily, i), meanRevSignal(daily, i)].filter(s => s.confidence >= MIN_CONF && Math.abs(s.vote) >= 0.4);
      if (!cands.length) continue;
      cands.sort((a, b) => (b.confidence * Math.abs(b.vote)) - (a.confidence * Math.abs(a.vote)));
      const dir = cands[0].vote > 0 ? 1 : -1;
      const entryDay = daily[i + 1].t; const bars = sess[entryDay];
      if (!bars || bars.length < 6) continue;
      nSig++;
      // entry×exit grid (net of round-trip cost)
      for (const [el, em] of ENTRIES) {
        const pe = priceAt(bars, em); if (pe == null || pe <= 0) continue;
        for (const [xl, xm] of EXITS) {
          if (xm !== 999 && xm <= em) continue;   // exit must be after entry
          const px = xm === 999 ? bars[bars.length - 1].c : priceAt(bars, xm); if (px == null) continue;
          const ret = ((px - pe) / pe) * dir * 100 - COST_RT;
          (cells[`${el}>${xl}`][entryDay] ||= []).push(ret);
        }
      }
      // give-back curve from the OPEN (gross — same single round-trip at every mark)
      const pOpen = priceAt(bars, 0); if (pOpen > 0) {
        for (const m of [30, 60, 90, 120, 150, 180]) { const p = priceAt(bars, m); if (p != null) traj[m].push(((p - pOpen) / pOpen) * dir * 100); }
        traj.close.push(((bars[bars.length - 1].c - pOpen) / pOpen) * dir * 100);
      }
    }
  }
  console.log(`\n\n  ${nSig} board signals replayed on intraday bars.\n`);
  if (!nSig) { console.error("  No signals.\n"); process.exit(1); }

  const pad = (s, n) => String(s).padEnd(n);
  // day-clustered stats: average within day, then across days
  const dayStat = (byDay) => { const perDay = Object.values(byDay).map(a => mean(a)); const n = perDay.length; if (n < 3) return { n, m: NaN, t: NaN }; const m = mean(perDay), se = sd(perDay) / Math.sqrt(n); return { n, m, t: se > 0 ? m / se : 0 }; };

  console.log("  TIME-OF-DAY MAP — mean NET %/trade (day-clustered t in parens). entry ↓ / exit →");
  console.log("    " + pad("entry", 8) + EXITS.map(([xl]) => pad(xl, 17)).join(""));
  for (const [el] of ENTRIES) {
    let row = "    " + pad(el, 8);
    for (const [xl, xm] of EXITS) {
      const k = `${el}>${xl}`; const has = Object.keys(cells[k]).length;
      if (!has) { row += pad("—", 17); continue; }
      const st = dayStat(cells[k]);
      row += pad(isNaN(st.m) ? `n${st.n} thin` : `${st.m >= 0 ? "+" : ""}${st.m.toFixed(3)} (t${st.t >= 0 ? "+" : ""}${st.t.toFixed(1)})`, 17);
    }
    console.log(row);
  }

  console.log("\n  GIVE-BACK CURVE from the open (gross %, the 'trade the first hours' view):");
  console.log("    " + ["+30m", "+1h", "+90m", "+2h", "+2.5h", "+3h", "close"].map(s => pad(s, 9)).join(""));
  console.log("    " + [traj[30], traj[60], traj[90], traj[120], traj[150], traj[180], traj.close].map(a => pad((mean(a) >= 0 ? "+" : "") + mean(a).toFixed(3), 9)).join(""));
  console.log("    " + ["n=" + traj[60].length].map(s => pad(s, 9)).join(""));

  console.log("\n  READ:");
  console.log("   • A real intraday-timing edge = a SMOOTH give-back curve (rises to a peak, fades) AND the");
  console.log("     matching map cell clearing |t| ≳ 3 (Bonferroni for ~10 cells), not one lucky cell at t≈2.");
  console.log("   • 'close' exit ≈ the daily board's own ~0 result — that's the baseline to beat.");
  console.log("   • Costs are per round-trip; trading the first hours then RE-signaling multiplies cost by the");
  console.log("     number of round-trips/day, so an early-exit cell must beat 'close' by MORE than one extra cost.");
  console.log("   • Pooled-within-day t is still optimistic (survivorship + thin IEX) → treat any positive as a ceiling.\n");
})().catch(e => { console.error("\n  Intraday timing backtest error:", e.message, "\n"); process.exit(1); });
