#!/usr/bin/env node
/**
 * TRAIDS — Medium "15 best day-trading strategies" leftovers
 *
 * Closes out the two mechanizable rules from the daytradingtoolkit list that weren't already
 * one of our tested archetypes:
 *
 *   A) RSI DIVERGENCE reversal (#10) — price makes a lower low (vs the prior swing low in a
 *      lookback window) while RSI(14) makes a HIGHER low → bullish divergence, go long; mirror
 *      for bearish. The classic "momentum isn't confirming the new price extreme" reversal.
 *
 *   B) VIX-REGIME SWITCH (#14) — run MEAN-REVERSION in high-volatility regimes and TREND in
 *      low-volatility regimes, switching by SPY's trailing 20-day realized vol vs its own rolling
 *      median (a clean, point-in-time proxy for "high VIX / low VIX"). Compared against running
 *      each strategy UNCONDITIONALLY, to see if the switch adds anything over two ~0-edge rules.
 *
 * Both settle exactly like Settle day: entry = signal-day close, ATR(14)×1.5 stop, 2R target,
 * scored vs the NEXT session's high/low (stop-first if both touched), net of cost.
 *
 * HONEST PRIOR: RSI divergence is a reversion signal, and our reversion archetype already failed
 * OOS; a regime switch between two ~0 strategies rarely manufactures edge from two zeros. Expect
 * ~0. Survivorship + in-sample threshold choices flatter both → treat any positive as a ceiling.
 *
 * Usage:  node backend/medium15-tests.js          (needs ALPACA keys in backend/.env)
 *         DAYS=750 COST_BPS=5 node backend/medium15-tests.js
 */
const fs = require("fs"), path = require("path");
function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} }
loadEnv();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
if (!KEY || !SEC || /your_|xxx|changeme/i.test(KEY)) { console.error("\n  No real ALPACA keys in backend/.env.\n"); process.exit(1); }
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };
const DAYS = parseInt(process.env.DAYS || "750");
const COST_BPS = parseFloat(process.env.COST_BPS || "5"), COST_RT = COST_BPS * 2 / 100;
const MIN_CONF = parseFloat(process.env.MIN_CONF || "0.6");
const RR = 2, ATR_MULT = 1.5, DIV_LB = 20;

const UNIVERSE = [
  "AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","JPM","V","UNH","XOM","JNJ","WMT","PG","MA",
  "HD","CVX","ABBV","KO","PEP","COST","MRK","AVGO","LLY","BAC","ADBE","CRM","NFLX","AMD","DIS",
  "INTC","QCOM","TXN","HON","UNP","LOW","CAT","GS","BKNG","NKE","MS","BA","T","PFE","C",
];

const sma = (p, per) => p.map((_, i) => i < per - 1 ? null : p.slice(i - per + 1, i + 1).reduce((a, b) => a + b, 0) / per);
function atr(h, l, c, period = 14) { const trs = c.map((_, i) => i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))); const r = new Array(c.length).fill(null); r[period - 1] = trs.slice(0, period).reduce((a, b) => a + b, 0) / period; for (let i = period; i < c.length; i++) r[i] = (r[i - 1] * (period - 1) + trs[i]) / period; return r; }
function adx(h, l, c, period = 14) { const n = c.length, r = new Array(n).fill(null), dmP = new Array(n).fill(0), dmM = new Array(n).fill(0); const tr = c.map((_, i) => i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))); for (let i = 1; i < n; i++) { const up = h[i] - h[i - 1], dn = l[i - 1] - l[i]; dmP[i] = up > dn && up > 0 ? up : 0; dmM[i] = dn > up && dn > 0 ? dn : 0; } let sT = tr.slice(1, period + 1).reduce((a, b) => a + b, 0), sP = dmP.slice(1, period + 1).reduce((a, b) => a + b, 0), sM = dmM.slice(1, period + 1).reduce((a, b) => a + b, 0); for (let i = period; i < n; i++) { if (i > period) { sT += tr[i] - sT / period; sP += dmP[i] - sP / period; sM += dmM[i] - sM / period; } const diP = sT > 0 ? 100 * sP / sT : 0, diM = sT > 0 ? 100 * sM / sT : 0, dx = diP + diM > 0 ? 100 * Math.abs(diP - diM) / (diP + diM) : 0; if (i === 2 * period - 1) r[i] = dx; else if (i > 2 * period - 1 && r[i - 1] !== null) r[i] = (r[i - 1] * (period - 1) + dx) / period; } return r; }
function rsi(c, period = 14) { const r = new Array(c.length).fill(null); if (c.length <= period) return r; let g = 0, l = 0; for (let i = 1; i <= period; i++) { const ch = c[i] - c[i - 1]; if (ch > 0) g += ch; else l -= ch; } g /= period; l /= period; r[period] = l === 0 ? 100 : 100 - 100 / (1 + g / l); for (let i = period + 1; i < c.length; i++) { const ch = c[i] - c[i - 1], gg = ch > 0 ? ch : 0, ll = ch < 0 ? -ch : 0; g = (g * (period - 1) + gg) / period; l = (l * (period - 1) + ll) / period; r[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } return r; }

// the board's two archetypes used by the regime switch (verbatim shape)
function meanRevSignal(d, i, lb = 20) { if (i < lb + 30) return { vote: 0, confidence: 0 }; const w = d.slice(i - lb + 1, i + 1).map(x => x.close); const ma = w.reduce((s, v) => s + v, 0) / w.length, sd = Math.sqrt(w.reduce((s, v) => s + (v - ma) ** 2, 0) / w.length) || ma * 0.01; const c = d[i].close, z = (c - ma) / sd; if (Math.abs(z) < 2) return { vote: 0, confidence: 0 }; const lw = d.slice(i - 50, i + 1).map(x => x.close), lma = lw.reduce((s, v) => s + v, 0) / lw.length; let vote = 0; if (z <= -2) { if (c < lma * 0.92) return { vote: 0, confidence: 0 }; vote = Math.min(1, 0.6 + (Math.abs(z) - 2) * 0.2); } else { if (c > lma * 1.08) return { vote: 0, confidence: 0 }; vote = -Math.min(1, 0.6 + (Math.abs(z) - 2) * 0.2); } return { vote, confidence: Math.max(0, Math.min(0.95, 0.55 + (Math.abs(z) - 2) * 0.12)) }; }
function trendSignal(d, i, fast = 20, slow = 50) { if (i < slow + 12) return { vote: 0, confidence: 0 }; const cl = d.slice(0, i + 1).map(x => x.close), hh = d.slice(0, i + 1).map(x => x.high), ll = d.slice(0, i + 1).map(x => x.low); const mF = sma(cl, fast), mS = sma(cl, slow), f = mF[i], s = mS[i], fp = mF[i - 10]; if (f == null || s == null || fp == null) return { vote: 0, confidence: 0 }; const px = cl[i], slope = (f - fp) / fp, up = px > f && f > s && slope > 0, dn = px < f && f < s && slope < 0; if (!up && !dn) return { vote: 0, confidence: 0 }; const dir = up ? 1 : -1, av = adx(hh, ll, cl, 14)[i] || 0; if (av < 20) return { vote: 0, confidence: 0 }; const sep = Math.abs(f - s) / s; return { vote: dir * Math.min(1, 0.5 + (av - 20) / 60 + Math.min(0.3, sep * 8)), confidence: Math.max(0, Math.min(0.95, 0.5 + (av - 20) / 100 + Math.min(0.2, sep * 6))) }; }

// RSI regular divergence vs the prior swing extreme in the lookback window
function rsiDivSignal(d, rsiArr, i, lb = DIV_LB) {
  if (i < lb + 16 || rsiArr[i] == null) return 0;
  let loIdx = i - lb, hiIdx = i - lb;
  for (let j = i - lb; j < i; j++) { if (d[j].close < d[loIdx].close) loIdx = j; if (d[j].close > d[hiIdx].close) hiIdx = j; }
  // bullish: today a lower low than the prior swing low, but RSI higher than it was there
  if (d[i].close < d[loIdx].close && rsiArr[loIdx] != null && rsiArr[i] > rsiArr[loIdx] + 2 && rsiArr[i] < 50) return 1;
  // bearish: today a higher high than the prior swing high, but RSI lower than it was there
  if (d[i].close > d[hiIdx].close && rsiArr[hiIdx] != null && rsiArr[i] < rsiArr[hiIdx] - 2 && rsiArr[i] > 50) return -1;
  return 0;
}

async function fetchBars(sym) { const start = new Date(Date.now() - DAYS * 86_400_000).toISOString().split("T")[0]; const out = []; let tok = null; do { const pr = new URLSearchParams({ symbols: sym, timeframe: "1Day", start, limit: "10000", adjustment: "all", feed: FEED }); if (tok) pr.set("page_token", tok); const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${pr}`, { headers }); if (!r.ok) break; const j = await r.json(); for (const b of (j.bars?.[sym] || [])) out.push({ t: (b.t || "").slice(0, 10), close: b.c, high: b.h, low: b.l, volume: b.v || 0 }); tok = j.next_page_token || null; } while (tok); return out; }

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
function settle(data, aArr, i, dir) { const entry = data[i].close, aVal = aArr[i] || entry * 0.02, stopDist = aVal * ATR_MULT, stop = entry - dir * stopDist, target = entry + dir * stopDist * RR, b = data[i + 1], long = dir > 0; const hitStop = long ? b.low <= stop : b.high >= stop, hitTgt = long ? b.high >= target : b.low <= target; const exit = hitStop ? stop : hitTgt ? target : b.close; return { rMult: ((exit - entry) * dir) / stopDist, retPct: ((exit - entry) / entry) * dir * 100 - COST_RT }; }
const stats = (set) => { if (!set.length) return { n: 0 }; const w = set.filter(t => t.rMult > 0).length; const gW = set.filter(t => t.retPct > 0).reduce((s, t) => s + t.retPct, 0), gL = Math.abs(set.filter(t => t.retPct <= 0).reduce((s, t) => s + t.retPct, 0)); return { n: set.length, win: w / set.length * 100, expR: mean(set.map(t => t.rMult)), avgRet: mean(set.map(t => t.retPct)), pf: gL ? gW / gL : 0 }; };
const line = (lab, s) => console.log("    " + String(lab).padEnd(22) + (s.n ? `n ${String(s.n).padEnd(6)} win ${s.win.toFixed(1).padStart(5)}%  exp ${(s.expR >= 0 ? "+" : "") + s.expR.toFixed(3)}R  avg ${(s.avgRet >= 0 ? "+" : "") + s.avgRet.toFixed(3)}%  PF ${s.pf.toFixed(2)}` : "no signals"));

(async () => {
  console.log(`\n  TRAIDS — Medium-15 leftovers (RSI divergence + VIX-regime switch) · ${UNIVERSE.length} names · ~${DAYS}d · net ${COST_BPS}bps/side\n`);

  // SPY realized-vol regime (point-in-time): high-vol if 20d realized vol > trailing 252d median
  process.stdout.write("  fetching SPY regime");
  const spy = await fetchBars("SPY");
  const spyRet = spy.map((b, i) => i ? Math.log(b.close / spy[i - 1].close) : 0);
  const rvol = spy.map((_, i) => i < 20 ? null : Math.sqrt(spyRet.slice(i - 19, i + 1).reduce((s, x) => s + x * x, 0) / 20) * Math.sqrt(252));
  const regimeByDate = {};
  for (let i = 0; i < spy.length; i++) { const hist = rvol.slice(Math.max(0, i - 252), i).filter(v => v != null); const med = median(hist); regimeByDate[spy[i].t] = (rvol[i] != null && med != null) ? (rvol[i] > med ? "high" : "low") : null; }

  const div = [];                 // RSI divergence trades
  const sw = [], allTrend = [], allMR = [];   // VIX-switch + unconditional baselines
  let names = 0;
  process.stdout.write(" · fetching universe");
  for (const sym of UNIVERSE) {
    const data = await fetchBars(sym); process.stdout.write(".");
    if (data.length < 120) continue;
    names++;
    const aArr = atr(data.map(d => d.high), data.map(d => d.low), data.map(d => d.close), 14);
    const rsiArr = rsi(data.map(d => d.close), 14);
    for (let i = 70; i < data.length - 1; i++) {
      // A) RSI divergence
      const dv = rsiDivSignal(data, rsiArr, i); if (dv !== 0) div.push({ ...settle(data, aArr, i, dv), dir: dv });
      // B) regime switch + baselines (only count when a signal clears the board's bar)
      const reg = regimeByDate[data[i].t];
      const tr = trendSignal(data, i), mr = meanRevSignal(data, i);
      const trOn = tr.confidence >= MIN_CONF && Math.abs(tr.vote) >= 0.4;
      const mrOn = mr.confidence >= MIN_CONF && Math.abs(mr.vote) >= 0.4;
      if (trOn) allTrend.push(settle(data, aArr, i, tr.vote > 0 ? 1 : -1));
      if (mrOn) allMR.push(settle(data, aArr, i, mr.vote > 0 ? 1 : -1));
      if (reg === "low" && trOn) sw.push(settle(data, aArr, i, tr.vote > 0 ? 1 : -1));
      else if (reg === "high" && mrOn) sw.push(settle(data, aArr, i, mr.vote > 0 ? 1 : -1));
    }
  }
  console.log(`\n\n  ${names} names replayed.\n`);

  console.log("  A) RSI DIVERGENCE reversal (#10)");
  line("all", stats(div));
  line("bullish (long)", stats(div.filter(t => t.dir > 0)));
  line("bearish (short)", stats(div.filter(t => t.dir < 0)));

  console.log("\n  B) VIX-REGIME SWITCH (#14) — mean-rev in high vol / trend in low vol");
  line("REGIME SWITCH", stats(sw));
  console.log("    — baselines (run unconditionally, every regime):");
  line("  always Trend", stats(allTrend));
  line("  always Mean-Rev", stats(allMR));

  console.log("\n  READ: edge = exp R clearly > 0 AND PF > 1 on a real sample. For the switch to be worth");
  console.log("  anything it must BEAT both unconditional baselines — otherwise the regime gate adds nothing.");
  console.log("  Survivorship + in-sample thresholds flatter all of these → a ~0 result is really negative.\n");
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
