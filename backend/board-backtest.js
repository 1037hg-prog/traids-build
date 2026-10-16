#!/usr/bin/env node
/**
 * TRAIDS — Board Backtest (historical replay of the REAL board signals)
 *
 * Replays the exact board strategy functions — Trend, Breakout, Mean-Reversion (copied
 * verbatim from src/App.jsx) — across ~2 years of daily bars, and settles every signal
 * the same way Settle day does: entry = signal-day close, ATR(14)×1.5 stop, 2R target,
 * scored against the NEXT session's high/low (conservative stop-first). Aggregates win
 * rate, expectancy, profit factor, the confidence calibration, and by-strategy results
 * over thousands of signals — the large-sample gut-check the 4-day forward test can't give.
 *
 * The 7-model Ensemble is NOT replayed here (it was only 3 of the forward trades); this
 * covers the three archetypes that generate the vast majority of board signals.
 *
 * HONEST BIASES — read before trusting the numbers:
 *  • Survivorship: this tests TODAY's liquid names over history. Failed/illiquid names
 *    that the board would NOT scan today are excluded → results are flattered.
 *  • In-sample-ish: the thresholds (55-day, 20/50-MA, ADX≥20, 1.5×vol, 2σ) are standard
 *    but were chosen with hindsight of what generally works.
 *  • Backtests flatter live: perfect fills, no real slippage, no missed days.
 *  • A good backtest is NECESSARY, not sufficient. It cannot replace the forward test on
 *    unseen future data. A BAD backtest, though, is a real red flag.
 *
 * Usage:  node backend/board-backtest.js            (needs ALPACA keys in backend/.env)
 *         DAYS=750 COST_BPS=5 node backend/board-backtest.js
 */
const fs = require("fs");
const path = require("path");

function loadEnv() { try { const txt = fs.readFileSync(path.join(__dirname, ".env"), "utf8"); for (const line of txt.split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} }
loadEnv();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
if (!KEY || !SEC || /your_|xxx|changeme/i.test(KEY)) { console.error("\n  No real ALPACA keys in backend/.env.\n"); process.exit(1); }
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };
const DAYS = parseInt(process.env.DAYS || "750");
const COST_BPS = parseFloat(process.env.COST_BPS || "5");   // per-side, applied to the %-return
const MIN_CONF = parseFloat(process.env.MIN_CONF || "0.6"); // board default
const RR = 2, ATR_MULT = 1.5;
const INVERT = process.env.INVERT === "1";   // flip every signal's direction ("do the opposite" test)

const UNIVERSE = [
  "AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","JPM","V","UNH","XOM","JNJ","WMT","PG","MA",
  "HD","CVX","ABBV","KO","PEP","COST","MRK","AVGO","LLY","BAC","ADBE","CRM","NFLX","AMD","DIS",
  "INTC","QCOM","TXN","HON","UNP","LOW","CAT","GS","BKNG","NKE","MS","BA","T","PFE","C",
];

// ── indicators (verbatim from src/App.jsx) ────────────────────────────────────
const sma = (prices, per) => prices.map((_, i) => i < per - 1 ? null : prices.slice(i - per + 1, i + 1).reduce((a, b) => a + b, 0) / per);
function atr(highs, lows, closes, period = 14) {
  const trs = closes.map((_, i) => i === 0 ? highs[i] - lows[i] : Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  const result = new Array(closes.length).fill(null);
  result[period - 1] = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) result[i] = (result[i - 1] * (period - 1) + trs[i]) / period;
  return result;
}
function adx(highs, lows, closes, period = 14) {
  const n = closes.length, result = new Array(n).fill(null);
  const dmPlus = new Array(n).fill(0), dmMinus = new Array(n).fill(0);
  const trArr = closes.map((_, i) => i === 0 ? highs[i] - lows[i] : Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  for (let i = 1; i < n; i++) { const upMove = highs[i] - highs[i - 1], downMove = lows[i - 1] - lows[i]; dmPlus[i] = upMove > downMove && upMove > 0 ? upMove : 0; dmMinus[i] = downMove > upMove && downMove > 0 ? downMove : 0; }
  let smTR = trArr.slice(1, period + 1).reduce((a, b) => a + b, 0), smDMP = dmPlus.slice(1, period + 1).reduce((a, b) => a + b, 0), smDMM = dmMinus.slice(1, period + 1).reduce((a, b) => a + b, 0);
  for (let i = period; i < n; i++) {
    if (i > period) { smTR = smTR - smTR / period + trArr[i]; smDMP = smDMP - smDMP / period + dmPlus[i]; smDMM = smDMM - smDMM / period + dmMinus[i]; }
    const diP = smTR > 0 ? 100 * smDMP / smTR : 0, diM = smTR > 0 ? 100 * smDMM / smTR : 0;
    const dx = diP + diM > 0 ? 100 * Math.abs(diP - diM) / (diP + diM) : 0;
    if (i === 2 * period - 1) result[i] = dx; else if (i > 2 * period - 1 && result[i - 1] !== null) result[i] = (result[i - 1] * (period - 1) + dx) / period;
  }
  return result;
}

// ── signals (verbatim from src/App.jsx) ───────────────────────────────────────
function breakoutSignal(data, i, lb = 55) {
  if (i < lb + 5) return { vote: 0, confidence: 0 };
  const win = data.slice(i - lb, i);
  const hi = Math.max(...win.map(d => d.high ?? d.close)), lo = Math.min(...win.map(d => d.low ?? d.close));
  const c = data[i].close, pc = data[i - 1].close, range = (hi - lo) || c * 0.02;
  const vols = win.map(d => d.volume || 0), avgVol = vols.reduce((s, v) => s + v, 0) / (vols.length || 1);
  if (!(avgVol > 0)) return { vote: 0, confidence: 0 };
  const volRatio = (data[i].volume || 0) / avgVol;
  if (volRatio < 1.5) return { vote: 0, confidence: 0 };
  let vote = 0, mag = 0;
  if (c > hi && pc <= hi) { mag = Math.min(1, (c - hi) / (range * 0.15)); vote = (0.65 + 0.35 * mag); }
  else if (c < lo && pc >= lo) { mag = Math.min(1, (lo - c) / (range * 0.15)); vote = -(0.65 + 0.35 * mag); }
  else return { vote: 0, confidence: 0 };
  const volBoost = Math.min(0.22, (volRatio - 1.5) * 0.12);
  const confidence = Math.max(0, Math.min(0.96, 0.50 + 0.18 * mag + volBoost));
  return { vote, confidence, strat: "Breakout" };
}
function meanRevSignal(data, i, lb = 20) {
  if (i < lb + 30) return { vote: 0, confidence: 0 };
  const win = data.slice(i - lb + 1, i + 1).map(d => d.close);
  const ma = win.reduce((s, v) => s + v, 0) / win.length;
  const sd = Math.sqrt(win.reduce((s, v) => s + (v - ma) ** 2, 0) / win.length) || ma * 0.01;
  const c = data[i].close, z = (c - ma) / sd;
  if (Math.abs(z) < 2) return { vote: 0, confidence: 0 };
  const longWin = data.slice(i - 50, i + 1).map(d => d.close), longMA = longWin.reduce((s, v) => s + v, 0) / longWin.length;
  let vote = 0;
  if (z <= -2) { if (c < longMA * 0.92) return { vote: 0, confidence: 0 }; vote = Math.min(1, 0.6 + (Math.abs(z) - 2) * 0.2); }
  else { if (c > longMA * 1.08) return { vote: 0, confidence: 0 }; vote = -Math.min(1, 0.6 + (Math.abs(z) - 2) * 0.2); }
  const confidence = Math.max(0, Math.min(0.95, 0.55 + (Math.abs(z) - 2) * 0.12));
  return { vote, confidence, strat: "Mean-Reversion" };
}
function trendSignal(data, i, fast = 20, slow = 50) {
  if (i < slow + 12) return { vote: 0, confidence: 0 };
  const closes = data.slice(0, i + 1).map(d => d.close), highs = data.slice(0, i + 1).map(d => d.high ?? d.close), lows = data.slice(0, i + 1).map(d => d.low ?? d.close);
  const maF = sma(closes, fast), maS = sma(closes, slow);
  const f = maF[i], s = maS[i], fPrev = maF[i - 10];
  if (f == null || s == null || fPrev == null) return { vote: 0, confidence: 0 };
  const px = closes[i], slope = (f - fPrev) / fPrev;
  const up = px > f && f > s && slope > 0, down = px < f && f < s && slope < 0;
  if (!up && !down) return { vote: 0, confidence: 0 };
  const dir = up ? 1 : -1;
  const adxVal = adx(highs, lows, closes, 14)[i] || 0;
  if (adxVal < 20) return { vote: 0, confidence: 0 };
  const sep = Math.abs(f - s) / s;
  const confidence = Math.max(0, Math.min(0.95, 0.5 + (adxVal - 20) / 100 + Math.min(0.2, sep * 6)));
  const vote = dir * Math.min(1, 0.5 + (adxVal - 20) / 60 + Math.min(0.3, sep * 8));
  return { vote, confidence, strat: "Trend" };
}

async function fetchBars(sym) {
  const start = new Date(Date.now() - DAYS * 86_400_000).toISOString().split("T")[0];
  const out = []; let pageToken = null;
  do {
    const params = new URLSearchParams({ symbols: sym, timeframe: "1Day", start, limit: "10000", adjustment: "all", feed: FEED });
    if (pageToken) params.set("page_token", pageToken);
    const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${params}`, { headers });
    if (!r.ok) break;
    const j = await r.json();
    for (const b of (j.bars?.[sym] || [])) out.push({ close: b.c, high: b.h, low: b.l, volume: b.v || 0 });
    pageToken = j.next_page_token || null;
  } while (pageToken);
  return out;
}

(async () => {
  console.log(`\n  TRAIDS — Board Backtest  ·  ${UNIVERSE.length} liquid names · ~${DAYS}d · Trend/Breakout/Mean-Reversion replayed verbatim${INVERT ? "  ·  *** INVERTED (do-the-opposite) ***" : ""}\n`);
  const trades = [];   // { strat, dir, conf, rMult, retPct }
  let nameCount = 0;
  process.stdout.write("  fetching + replaying");
  for (const sym of UNIVERSE) {
    const data = await fetchBars(sym);
    process.stdout.write(".");
    if (data.length < 120) continue;
    nameCount++;
    for (let i = 70; i < data.length - 1; i++) {
      const cands = [trendSignal(data, i), breakoutSignal(data, i), meanRevSignal(data, i)]
        .filter(s => s.confidence >= MIN_CONF && Math.abs(s.vote) >= 0.4);
      if (!cands.length) continue;
      cands.sort((a, b) => (b.confidence * Math.abs(b.vote)) - (a.confidence * Math.abs(a.vote)));
      const sig = cands[0]; let dir = sig.vote > 0 ? 1 : -1; if (INVERT) dir = -dir;
      const entry = data[i].close, aVal = atr(data.map(d => d.high), data.map(d => d.low), data.map(d => d.close), 14)[i] || entry * 0.02;
      const stopDist = aVal * ATR_MULT, stop = entry - dir * stopDist, target = entry + dir * stopDist * RR;
      const b = data[i + 1]; const long = dir > 0;
      const hitStop = long ? b.low <= stop : b.high >= stop, hitTgt = long ? b.high >= target : b.low <= target;
      const exit = hitStop ? stop : hitTgt ? target : b.close;
      const rMult = ((exit - entry) * dir) / stopDist;
      const retPct = ((exit - entry) / entry) * dir * 100 - COST_BPS * 2 / 100;
      trades.push({ strat: sig.strat, dir, conf: sig.confidence, rMult, retPct });
    }
  }
  console.log(`\n\n  ${nameCount} names, ${trades.length} signals replayed (net of ${COST_BPS}bps/side).\n`);
  if (!trades.length) { console.error("  No signals.\n"); process.exit(1); }

  const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
  const stats = (set) => {
    const w = set.filter(t => t.rMult > 0).length;
    const gW = set.filter(t => t.retPct > 0).reduce((s, t) => s + t.retPct, 0), gL = Math.abs(set.filter(t => t.retPct <= 0).reduce((s, t) => s + t.retPct, 0));
    return { n: set.length, win: set.length ? w / set.length * 100 : 0, expR: mean(set.map(t => t.rMult)), avgRet: mean(set.map(t => t.retPct)), pf: gL ? gW / gL : 0 };
  };
  const pad = (s, n) => String(s).padEnd(n);
  const all = stats(trades);
  console.log("  OVERALL");
  console.log(`    signals ${all.n} · win ${all.win.toFixed(1)}% · expectancy ${all.expR >= 0 ? "+" : ""}${all.expR.toFixed(3)}R · avg ret/trade ${all.avgRet >= 0 ? "+" : ""}${all.avgRet.toFixed(3)}% · profit factor ${all.pf.toFixed(2)}\n`);

  console.log("  BY STRATEGY");
  console.log("    " + pad("strategy", 18) + pad("n", 8) + pad("win%", 8) + pad("exp R", 9) + "avg ret");
  for (const st of ["Trend", "Breakout", "Mean-Reversion"]) { const s = stats(trades.filter(t => t.strat === st)); console.log("    " + pad(st, 18) + pad(s.n, 8) + pad(s.win.toFixed(0), 8) + pad((s.expR >= 0 ? "+" : "") + s.expR.toFixed(3), 9) + (s.avgRet >= 0 ? "+" : "") + s.avgRet.toFixed(3) + "%"); }

  console.log("\n  CONFIDENCE CALIBRATION  (does higher confidence actually win more?)");
  console.log("    " + pad("band", 12) + pad("n", 8) + pad("win%", 8) + pad("exp R", 9) + "avg ret");
  for (const [lo, hi, lab] of [[0.9, 1.01, "90-100%"], [0.8, 0.9, "80-90%"], [0.7, 0.8, "70-80%"], [0.6, 0.7, "60-70%"]]) {
    const s = stats(trades.filter(t => t.conf >= lo && t.conf < hi));
    if (s.n) console.log("    " + pad(lab, 12) + pad(s.n, 8) + pad(s.win.toFixed(0), 8) + pad((s.expR >= 0 ? "+" : "") + s.expR.toFixed(3), 9) + (s.avgRet >= 0 ? "+" : "") + s.avgRet.toFixed(3) + "%");
  }
  console.log(`\n  Read: expectancy near 0 = the rules don't add edge over the 1-day hold (after costs). A monotonic`);
  console.log(`  calibration (win% rising with the band) would mean the confidence score is real. Survivorship +`);
  console.log(`  in-sample biases FLATTER these numbers — treat a weak result as a ceiling, not a floor.\n`);
})().catch(e => { console.error("\n  Backtest error:", e.message, "\n"); process.exit(1); });
