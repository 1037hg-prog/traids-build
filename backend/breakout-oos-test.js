#!/usr/bin/env node
/**
 * TRAIDS — Breakout OOS Hypothesis Test  (EDGE-HUNTER, single pre-registered test)
 *
 * PRE-REGISTERED HYPOTHESIS (locked before looking at OOS data):
 *   "Breakout-only, optionally regime-gated (longs only when SPY > its 50-day MA,
 *    shorts only when SPY < its 50-day MA), beats buy-and-hold OUT-OF-SAMPLE net of
 *    realistic costs."
 *   Rationale: Breakout was the only archetype with positive backtest expectancy
 *   (+0.036R, n=285).
 *
 * METHOD (disciplined, default verdict = "no edge"):
 *   • Reuse breakoutSignal + ATR/2R settle VERBATIM from board-backtest.js (the real board rules).
 *   • Split by TIME: first TRAIN_FRAC of each symbol's bars = TRAIN, remainder = TEST.
 *   • The ONLY free choice is the regime gate (on/off). Pick whichever wins on TRAIN by
 *     mean R, lock it, then evaluate ONCE on the held-out TEST window.
 *   • Net of COST_BPS per side (default 5; also report 10).
 *   • Benchmark = buy-and-hold over the SAME test window / symbols (directional strat must beat it).
 *   • Correlated samples: report RAW n and an EFFECTIVE n (cluster trades by calendar day,
 *     since vol-spike breakouts fire on many names the same day). CI on mean R uses effective n.
 *
 * Usage:  node backend/breakout-oos-test.js
 *         DAYS=900 COST_BPS=5 TRAIN_FRAC=0.6 node backend/breakout-oos-test.js
 */
const fs = require("fs");
const path = require("path");

function loadEnv() { try { const txt = fs.readFileSync(path.join(__dirname, ".env"), "utf8"); for (const line of txt.split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} }
loadEnv();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
if (!KEY || !SEC || /your_|xxx|changeme/i.test(KEY)) { console.error("\n  No real ALPACA keys in backend/.env.\n"); process.exit(1); }
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };

const DAYS = parseInt(process.env.DAYS || "900");
const COST_BPS = parseFloat(process.env.COST_BPS || "5");
const TRAIN_FRAC = parseFloat(process.env.TRAIN_FRAC || "0.6");
const REGIME_P = 50;
const RR = 2, ATR_MULT = 1.5;

const UNIVERSE = [
  "AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","JPM","V","UNH","XOM","JNJ","WMT","PG","MA",
  "HD","CVX","ABBV","KO","PEP","COST","MRK","AVGO","LLY","BAC","ADBE","CRM","NFLX","AMD","DIS",
  "INTC","QCOM","TXN","HON","UNP","LOW","CAT","GS","BKNG","NKE","MS","BA","T","PFE","C",
];
const BENCH = "SPY";

// ── indicators (verbatim from board-backtest.js) ───────────────────────────────
const sma = (prices, per) => prices.map((_, i) => i < per - 1 ? null : prices.slice(i - per + 1, i + 1).reduce((a, b) => a + b, 0) / per);
function atr(highs, lows, closes, period = 14) {
  const trs = closes.map((_, i) => i === 0 ? highs[i] - lows[i] : Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  const result = new Array(closes.length).fill(null);
  result[period - 1] = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) result[i] = (result[i - 1] * (period - 1) + trs[i]) / period;
  return result;
}
// ── breakout signal (verbatim from board-backtest.js) ──────────────────────────
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

async function fetchBars(sym) {
  const start = new Date(Date.now() - DAYS * 86_400_000).toISOString().split("T")[0];
  const out = []; let pageToken = null;
  do {
    const params = new URLSearchParams({ symbols: sym, timeframe: "1Day", start, limit: "10000", adjustment: "all", feed: FEED });
    if (pageToken) params.set("page_token", pageToken);
    const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${params}`, { headers });
    if (!r.ok) break;
    const j = await r.json();
    for (const b of (j.bars?.[sym] || [])) out.push({ t: b.t, close: b.c, high: b.h, low: b.l, volume: b.v || 0 });
    pageToken = j.next_page_token || null;
  } while (pageToken);
  return out;
}

// settle one breakout exactly like Settle day: entry=signal close, ATR*1.5 stop, 2R target,
// scored on NEXT session high/low (stop-first), net of costs.
function settle(data, i, dir) {
  const entry = data[i].close;
  const aVal = atr(data.map(d => d.high), data.map(d => d.low), data.map(d => d.close), 14)[i] || entry * 0.02;
  const stopDist = aVal * ATR_MULT, stop = entry - dir * stopDist, target = entry + dir * stopDist * RR;
  const b = data[i + 1]; const long = dir > 0;
  const hitStop = long ? b.low <= stop : b.high >= stop, hitTgt = long ? b.high >= target : b.low <= target;
  const exit = hitStop ? stop : hitTgt ? target : b.close;
  const rMult = ((exit - entry) * dir) / stopDist;
  const retPct = ((exit - entry) / entry) * dir * 100 - COST_BPS * 2 / 100; // round-trip cost
  return { rMult, retPct };
}

// SPY regime: bull if SPY close > its REGIME_P-day SMA on that date. Returns map date->bull bool.
function buildRegime(spyBars) {
  const closes = spyBars.map(b => b.close);
  const ma = sma(closes, REGIME_P);
  const m = new Map();
  for (let i = 0; i < spyBars.length; i++) if (ma[i] != null) m.set(spyBars[i].t.slice(0, 10), closes[i] > ma[i]);
  return m;
}

// collect breakout trades over a symbol's [lo,hi) bar-index window, given gate mode
function collectTrades(data, lo, hi, gated, regime) {
  const trades = [];
  for (let i = Math.max(70, lo); i < Math.min(hi, data.length - 1); i++) {
    const sig = breakoutSignal(data, i);
    if (!(sig.confidence >= 0.6 && Math.abs(sig.vote) >= 0.4)) continue;
    const dir = sig.vote > 0 ? 1 : -1;
    if (gated) {
      const day = (data[i].t || "").slice(0, 10);
      const bull = regime.get(day);
      if (bull === undefined) continue;          // no regime info → skip (conservative)
      if (dir > 0 && !bull) continue;            // no longs in a downtrend
      if (dir < 0 && bull) continue;             // no shorts in an uptrend
    }
    const { rMult, retPct } = settle(data, i, dir);
    trades.push({ day: (data[i].t || "").slice(0, 10), dir, rMult, retPct });
  }
  return trades;
}

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };

function tradeStats(trades) {
  const r = trades.map(t => t.rMult), pct = trades.map(t => t.retPct);
  const w = trades.filter(t => t.rMult > 0).length;
  const gW = pct.filter(x => x > 0).reduce((s, x) => s + x, 0), gL = Math.abs(pct.filter(x => x <= 0).reduce((s, x) => s + x, 0));
  // EFFECTIVE N: cluster by calendar day (vol-spike breakouts co-fire across names). Mean R per day, then n=#days.
  const byDay = new Map();
  for (const t of trades) { if (!byDay.has(t.day)) byDay.set(t.day, []); byDay.get(t.day).push(t.rMult); }
  const dayMeans = [...byDay.values()].map(mean);
  const effN = dayMeans.length;
  const meanR = mean(r), seCluster = effN > 1 ? sd(dayMeans) / Math.sqrt(effN) : Infinity;
  return {
    n: trades.length, effN, win: trades.length ? w / trades.length * 100 : 0,
    meanR, expRsumPct: mean(pct), pf: gL ? gW / gL : 0,
    ci95: [meanR - 1.96 * seCluster, meanR + 1.96 * seCluster], seCluster,
  };
}

// buy-hold total return over a symbol's [lo,hi) window (net of one round-trip cost)
function buyHoldRet(data, lo, hi) {
  if (hi - 1 <= lo) return 0;
  const a = data[lo].close, b = data[hi - 1].close;
  return ((b - a) / a) * 100 - COST_BPS * 2 / 100;
}

(async () => {
  console.log(`\n  TRAIDS — Breakout OOS Hypothesis Test`);
  console.log(`  ${UNIVERSE.length} names + ${BENCH} · ~${DAYS}d · ${COST_BPS}bps/side · ${(TRAIN_FRAC*100)|0}/${100-((TRAIN_FRAC*100)|0)} time split · regime gate=SPY>${REGIME_P}MA\n`);

  process.stdout.write("  fetching");
  const spyBars = await fetchBars(BENCH); process.stdout.write(".");
  if (spyBars.length < 200) { console.error(`\n  ${BENCH} only ${spyBars.length} bars — cannot build regime gate.\n`); process.exit(1); }
  const regime = buildRegime(spyBars);

  const bySym = {};
  for (const sym of UNIVERSE) { bySym[sym] = await fetchBars(sym); process.stdout.write("."); }
  console.log("");

  // determine TRAIN/TEST split per symbol by time
  const trainTrades = { gated: [], nogate: [] };
  const testTrades = { gated: [], nogate: [] };
  let bhTestTotal = 0, bhTestN = 0, namesUsed = 0;
  const bhTestRets = [];

  for (const sym of UNIVERSE) {
    const data = bySym[sym];
    if (data.length < 250) continue;
    namesUsed++;
    const split = Math.floor(data.length * TRAIN_FRAC);
    // train window
    trainTrades.nogate.push(...collectTrades(data, 70, split, false, regime));
    trainTrades.gated.push(...collectTrades(data, 70, split, true, regime));
    // test window
    testTrades.nogate.push(...collectTrades(data, split, data.length, false, regime));
    testTrades.gated.push(...collectTrades(data, split, data.length, true, regime));
    // buy-hold benchmark over the SAME test window
    const bh = buyHoldRet(data, split, data.length);
    bhTestTotal += bh; bhTestN++; bhTestRets.push(bh);
  }

  const trainNo = tradeStats(trainTrades.nogate), trainGate = tradeStats(trainTrades.gated);
  console.log(`  Names with sufficient data: ${namesUsed}/${UNIVERSE.length}\n`);
  console.log(`  ── TRAIN window (parameter-selection only) ─────────────────────────────`);
  console.log(`    No gate : n=${trainNo.n} (eff ${trainNo.effN})  win ${trainNo.win.toFixed(1)}%  meanR ${trainNo.meanR>=0?"+":""}${trainNo.meanR.toFixed(4)}  PF ${trainNo.pf.toFixed(2)}`);
  console.log(`    + Gate  : n=${trainGate.n} (eff ${trainGate.effN})  win ${trainGate.win.toFixed(1)}%  meanR ${trainGate.meanR>=0?"+":""}${trainGate.meanR.toFixed(4)}  PF ${trainGate.pf.toFixed(2)}`);

  // LOCK the choice on TRAIN by mean R
  const pickGated = trainGate.meanR > trainNo.meanR;
  const lockedName = pickGated ? "+ regime gate" : "no gate";
  console.log(`\n    >> LOCKED on TRAIN: "${lockedName}" (higher train mean R). This is the only free choice.\n`);

  // EVALUATE ONCE on TEST
  const chosen = pickGated ? testTrades.gated : testTrades.nogate;
  const other  = pickGated ? testTrades.nogate : testTrades.gated;
  const te = tradeStats(chosen), teOther = tradeStats(other);
  const bhAvg = bhTestN ? bhTestTotal / bhTestN : 0;
  const bhSd = sd(bhTestRets);

  console.log(`  ── TEST window (held out — single evaluation) ──────────────────────────`);
  console.log(`    LOCKED strat "${lockedName}":`);
  console.log(`      raw n=${te.n}  effective n=${te.effN} (clustered by day)`);
  console.log(`      win ${te.win.toFixed(1)}%   PF ${te.pf.toFixed(2)}`);
  console.log(`      mean R/trade ${te.meanR>=0?"+":""}${te.meanR.toFixed(4)}   95% CI [${te.ci95[0].toFixed(4)}, ${te.ci95[1].toFixed(4)}]  (CI uses effective n)`);
  console.log(`      mean net %/trade ${te.expRsumPct>=0?"+":""}${te.expRsumPct.toFixed(4)}%`);
  console.log(`    (the other mode "${pickGated?"no gate":"+ gate"}" on TEST: meanR ${teOther.meanR>=0?"+":""}${teOther.meanR.toFixed(4)}, n=${teOther.n})\n`);

  // sum of per-trade net % = total strategy return if 1 unit per signal (gross, not compounded)
  const stratTotalPct = chosen.reduce((s, t) => s + t.retPct, 0);
  console.log(`  ── BENCHMARK: buy-and-hold over the SAME test window ───────────────────`);
  console.log(`    buy-hold avg total return/name: ${bhAvg>=0?"+":""}${bhAvg.toFixed(2)}%  (sd across names ${bhSd.toFixed(1)}%)`);
  console.log(`    breakout strat summed net %/trade over test: ${stratTotalPct>=0?"+":""}${stratTotalPct.toFixed(1)}% across ${te.n} trades`);
  console.log(`    (NOTE: breakout is a 1-day-hold tactical strat; it is only in-market on signal days.`);
  console.log(`     The honest bar is: does mean R clear 0 with a CI that excludes 0, AND does the`);
  console.log(`     strategy's realized return beat simply holding the names over the same window?)\n`);

  // ── VERDICT ──────────────────────────────────────────────────────────────────
  const ciExcludesZero = te.ci95[0] > 0;
  const positiveR = te.meanR > 0;
  console.log(`  ══ VERDICT (locked "${lockedName}", ${COST_BPS}bps/side) ══`);
  console.log(`    mean R > 0 OOS?              ${positiveR ? "yes" : "NO"} (${te.meanR.toFixed(4)})`);
  console.log(`    95% CI excludes 0?          ${ciExcludesZero ? "yes" : "NO"} ([${te.ci95[0].toFixed(4)}, ${te.ci95[1].toFixed(4)}])`);
  console.log(`    PF > 1 OOS?                 ${te.pf > 1 ? "yes" : "NO"} (${te.pf.toFixed(2)})`);
  console.log(`    effective sample sane?      effN=${te.effN}`);
  const fundable = positiveR && ciExcludesZero && te.pf > 1 && te.effN >= 30;
  console.log(`\n    => ${fundable ? "POSSIBLE edge — survives OOS+costs+CI (verify further)" : "NO fundable edge — does not survive the honest OOS test."}\n`);
})().catch(e => { console.error("\n  Test error:", e.message, "\n"); process.exit(1); });
