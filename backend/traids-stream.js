// ═══════════════════════════════════════════════════════════════════════════════
// RETIRED 2026-08-28 — NOT MOUNTED. Do not re-mount without a deliberate decision.
// The server no longer requires this file; the Stream UI tab was removed the same day.
// Retained for history, not for use. See defect D42: startSyntheticFeed() fabricated
// 1-minute bars from Math.random() off a hardcoded 2024 price table whenever broker
// credentials were absent, and those bars fed downstream. If this is ever revived,
// that path must be deleted first, not merely guarded.
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * TRAIDS — High-Frequency Streaming Engine
 * ─────────────────────────────────────────────────────────────────────────────
 * Enables 100+ trades/hour via:
 *   1. Alpaca WebSocket market data (real-time 1-min bars + quotes)
 *   2. Continuous signal engine (ensemble on rolling 200-bar window)
 *   3. Automated order execution with pre-flight risk checks
 *   4. Pairs trading at intraday frequency (z-score on 5-min bars)
 *   5. Execution quality tracking (actual vs model slippage)
 *
 * Mount onto traids-server-v2.js:
 *   const stream = require('./traids-stream');
 *   stream.init(app, wss, alpaca);
 *
 * Or run standalone:
 *   ALPACA_KEY_ID=xxx ALPACA_SECRET_KEY=yyy node traids-stream.js
 *
 * Required env:
 *   ALPACA_KEY_ID, ALPACA_SECRET_KEY
 *   ALPACA_PAPER=true          (false for live trading — be careful)
 *   STREAM_SYMBOLS=AAPL,MSFT,NVDA,SPY,QQQ   (override default universe)
 *   MAX_TRADES_PER_HOUR=100
 *   MAX_DAILY_LOSS_PCT=2
 *   PAPER_CAPITAL=100000       (paper-only: starting capital)
 */

"use strict";
require("dotenv").config();

// ── Dependencies ──────────────────────────────────────────────────────────────
const WebSocket = require("ws");

// ── Configuration ─────────────────────────────────────────────────────────────
const CONFIG = {
  maxTradesPerHour:  parseInt(process.env.MAX_TRADES_PER_HOUR  || "100"),
  maxDailyLossPct:   parseFloat(process.env.MAX_DAILY_LOSS_PCT  || "2"),
  paperCapital:      parseFloat(process.env.PAPER_CAPITAL       || "100000"),
  isPaper:           process.env.ALPACA_PAPER !== "false",
  feed:              process.env.ALPACA_FEED || "iex",   // iex (free) or sip (paid)
  // Signal thresholds
  signalMinConf:     0.55,   // min ensemble confidence to fire
  signalMinVote:     0.30,   // min |vote| to fire
  pairsEntryZ:       2.0,    // z-score to enter pair
  pairsExitZ:        0.4,    // z-score to exit pair
  pairsLookback:     60,     // bars for z-score rolling window
  barSize:           "1Min", // 1Min | 5Min | 15Min
  ringBufferSize:    210,    // bars kept in memory per symbol
};

// ── Symbol universe ───────────────────────────────────────────────────────────
const DEFAULT_SYMBOLS = [
  "AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA",
  "JPM","GS","BAC","V","MA","XOM","CVX","SPY","QQQ",
];
const SYMBOLS = (process.env.STREAM_SYMBOLS || "")
  .split(",").map(s => s.trim().toUpperCase()).filter(Boolean)
  .concat(DEFAULT_SYMBOLS)
  .filter((v,i,a) => a.indexOf(v) === i)
  .slice(0, 30);

// ── Pairs to trade at intraday frequency ─────────────────────────────────────
const INTRADAY_PAIRS = [
  { a:"XOM",  b:"CVX",  sector:"Energy"   },
  { a:"JPM",  b:"GS",   sector:"Finance"  },
  { a:"V",    b:"MA",   sector:"Payments" },
  { a:"SPY",  b:"QQQ",  sector:"ETF"      },
  { a:"AAPL", b:"MSFT", sector:"Tech"     },
  { a:"NVDA", b:"AMD",  sector:"Semis"    },
];

// ─────────────────────────────────────────────────────────────────────────────
// RING BUFFER — fixed-size circular buffer for price bars
// ─────────────────────────────────────────────────────────────────────────────
class RingBuffer {
  constructor(size) {
    this.size   = size;
    this.buffer = new Array(size).fill(null);
    this.head   = 0;
    this.count  = 0;
  }
  push(val) {
    this.buffer[this.head] = val;
    this.head = (this.head + 1) % this.size;
    if (this.count < this.size) this.count++;
  }
  toArray() {
    if (this.count < this.size) return this.buffer.slice(0, this.count).filter(Boolean);
    const tail = this.buffer.slice(this.head).filter(Boolean);
    const head = this.buffer.slice(0, this.head).filter(Boolean);
    return [...tail, ...head];
  }
  get length() { return this.count; }
  last() { return this.buffer[(this.head - 1 + this.size) % this.size]; }
}

// ── Per-symbol state ──────────────────────────────────────────────────────────
const symbolState = {};
function getState(sym) {
  if (!symbolState[sym]) {
    symbolState[sym] = {
      bars:       new RingBuffer(CONFIG.ringBufferSize),  // 1-min OHLCV
      bid:        null,
      ask:        null,
      lastSignal: null,   // { vote, conf, ts }
      prevVote:   0,
      position:   null,   // { qty, side, entryPrice, entryTs }
    };
  }
  return symbolState[sym];
}

// ─────────────────────────────────────────────────────────────────────────────
// TECHNICAL INDICATORS  (array-based, fast)
// ─────────────────────────────────────────────────────────────────────────────
function closes(bars) { return bars.map(b => b.c); }

function ema(arr, n) {
  const k = 2 / (n + 1), res = new Array(arr.length).fill(null);
  res[n - 1] = arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < arr.length; i++) res[i] = arr[i] * k + res[i-1] * (1 - k);
  return res;
}

function sma(arr, n) {
  return arr.map((_, i) => i < n - 1 ? null : arr.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n);
}

function rsi(arr, n = 14) {
  const res = new Array(arr.length).fill(null);
  for (let i = n; i < arr.length; i++) {
    let g = 0, l = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const d = arr[j] - arr[j-1]; d > 0 ? g += d : l -= d;
    }
    const ag = g / n, al = l / n;
    res[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return res;
}

function macdLine(arr) {
  const fast = ema(arr, 12), slow = ema(arr, 26);
  const macd = arr.map((_, i) => fast[i] !== null && slow[i] !== null ? fast[i] - slow[i] : null);
  const fv = macd.findIndex(v => v !== null);
  const sig = new Array(arr.length).fill(null);
  if (fv >= 0 && fv + 9 < arr.length) {
    sig[fv + 8] = macd.slice(fv, fv + 9).reduce((a, b) => a + b, 0) / 9;
    const k = 2 / 10;
    for (let i = fv + 9; i < arr.length; i++)
      if (macd[i] !== null && sig[i-1] !== null) sig[i] = macd[i] * k + sig[i-1] * (1 - k);
  }
  return { macd, sig };
}

function bb(arr, n = 20, m = 2) {
  const mid = sma(arr, n);
  return arr.map((_, i) => {
    if (mid[i] === null) return { pct: null };
    const sl = arr.slice(i - n + 1, i + 1);
    const sd = Math.sqrt(sl.reduce((s, v) => s + (v - mid[i]) ** 2, 0) / n);
    return { pct: (arr[i] - (mid[i] - m * sd)) / (2 * m * sd || 1) };
  });
}

function roc(arr, n = 10) {
  return arr.map((_, i) => i < n ? null : (arr[i] - arr[i-n]) / arr[i-n] * 100);
}

// ── GARCH(1,1) for intraday vol estimate ──────────────────────────────────────
function garchDailyVol(arr, alpha = 0.09, beta = 0.90) {
  if (arr.length < 30) return 0.015;
  const rets = arr.slice(1).map((v, i) => Math.log(v / arr[i]));
  const mu   = rets.reduce((s, r) => s + r, 0) / rets.length;
  const sv   = rets.reduce((s, r) => s + (r - mu) ** 2, 0) / rets.length;
  const a = Math.min(alpha, 0.15), b2 = Math.min(beta, 0.94), w = sv * (1 - a - b2);
  let v = sv;
  for (const r of rets) v = w + a * r ** 2 + b2 * v;
  return Math.sqrt(Math.max(v, 1e-10));
}

// ─────────────────────────────────────────────────────────────────────────────
// 7-MODEL ENSEMBLE SIGNAL  (adapted for intraday bars)
// ─────────────────────────────────────────────────────────────────────────────
const MW = { macd:1.4, bb:1.2, rsi:1.3, ema:1.0, mom:0.9, trend:1.1, mr:1.0 };

// Regime-aware weights (injected from regime engine)
let activeRegimeWeights = { ...MW };
function setRegimeWeights(w) { activeRegimeWeights = { ...MW, ...w }; }

function computeEnsemble(barsArr) {
  if (barsArr.length < 55) return { vote: 0, conf: 0, nBull: 0, nBear: 0 };
  const cl = closes(barsArr), n = cl.length, W = activeRegimeWeights;
  const signals = {}; let wSum = 0, wTotal = 0;

  try {
    const { macd: ml, sig: sl } = macdLine(cl);
    if (ml[n-1]!==null&&sl[n-1]!==null&&ml[n-2]!==null&&sl[n-2]!==null) {
      const v = ml[n-1]>sl[n-1] ? (ml[n-2]<=sl[n-2]?1.5:0.5) : (ml[n-2]>=sl[n-2]?-1.5:-0.5);
      signals.macd=v; wSum+=v*W.macd; wTotal+=W.macd; }
  } catch(_) {}

  try {
    const bands = bb(cl); const cur = bands[n-1], prev = bands[n-2];
    if (cur?.pct!=null) {
      let v=0;
      if(cur.pct<0.1&&prev?.pct>=0.1)v=1.5; else if(cur.pct<0.2)v=0.6;
      else if(cur.pct>0.9&&prev?.pct<=0.9)v=-1.5; else if(cur.pct>0.8)v=-0.6;
      signals.bb=v; wSum+=v*W.bb; wTotal+=W.bb; }
  } catch(_) {}

  try {
    const r=rsi(cl); if(r[n-1]!==null) {
      let v=0;
      if(r[n-1]<30&&r[n-2]>=30)v=1.5; else if(r[n-1]<40)v=0.6;
      else if(r[n-1]>70&&r[n-2]<=70)v=-1.5; else if(r[n-1]>60)v=-0.6;
      signals.rsi=v; wSum+=v*W.rsi; wTotal+=W.rsi; }
  } catch(_) {}

  try {
    const e9=ema(cl,9),e21=ema(cl,21),e50=ema(cl,Math.min(50,n-1));
    if(e9[n-1]&&e21[n-1]&&e50[n-1]) {
      const v=e9[n-1]>e21[n-1]&&e21[n-1]>e50[n-1]?1.0:e9[n-1]<e21[n-1]&&e21[n-1]<e50[n-1]?-1.0:0;
      signals.ema=v; wSum+=v*W.ema; wTotal+=W.ema; }
  } catch(_) {}

  try {
    const r10=roc(cl,10),r5=roc(cl,5);
    if(r10[n-1]!==null&&r5[n-1]!==null) {
      const v=r10[n-1]>2&&r5[n-1]>1?1.0:r10[n-1]<-2&&r5[n-1]<-1?-1.0:r10[n-1]>0?0.3:-0.3;
      signals.mom=v; wSum+=v*W.mom; wTotal+=W.mom; }
  } catch(_) {}

  try {
    const dir=cl[n-1]>cl[n-Math.min(5,n-1)]?1:-1;
    const v=0.6*dir; signals.trend=v; wSum+=v*W.trend; wTotal+=W.trend;
  } catch(_) {}

  try {
    const r=rsi(cl,14), bands=bb(cl,20,2.5);
    if(r[n-1]!==null&&bands[n-1]?.pct!=null) {
      const v=r[n-1]<35&&bands[n-1].pct<0.15?1.2:r[n-1]>65&&bands[n-1].pct>0.85?-1.2:0;
      signals.mr=v; wSum+=v*W.mr; wTotal+=W.mr; }
  } catch(_) {}

  const vote = Math.max(-1, Math.min(1, wTotal > 0 ? wSum / wTotal : 0));
  const vals  = Object.values(signals).filter(Boolean);
  const nBull = vals.filter(v=>v>0).length, nBear = vals.filter(v=>v<0).length;
  const conf  = Math.abs(nBull-nBear) / (vals.length || 1);
  return { vote: parseFloat(vote.toFixed(3)), conf: parseFloat(conf.toFixed(2)), nBull, nBear };
}

// ─────────────────────────────────────────────────────────────────────────────
// PAIRS ENGINE  (intraday z-score on 1-min bars)
// ─────────────────────────────────────────────────────────────────────────────
const pairsState = {};

function getPairKey(a, b) { return `${a}|${b}`; }

function computePairSignal(pair) {
  const stA = symbolState[pair.a], stB = symbolState[pair.b];
  if (!stA || !stB) return null;
  const barsA = stA.bars.toArray(), barsB = stB.bars.toArray();
  const n = Math.min(barsA.length, barsB.length);
  if (n < CONFIG.pairsLookback + 10) return null;

  const pA = closes(barsA.slice(-n)), pB = closes(barsB.slice(-n));

  // OLS hedge ratio
  const mA = pA.reduce((s,v)=>s+v,0)/n, mB = pB.reduce((s,v)=>s+v,0)/n;
  let cov=0, varB=0;
  for(let i=0;i<n;i++){cov+=(pA[i]-mA)*(pB[i]-mB); varB+=(pB[i]-mB)**2;}
  const beta = varB>0 ? cov/varB : 1;

  // Spread and z-score
  const spread = pA.map((a,i) => a - beta * pB[i]);
  const win    = CONFIG.pairsLookback;
  const sl     = spread.slice(-win);
  const mu     = sl.reduce((s,v)=>s+v,0)/win;
  const sd     = Math.sqrt(sl.reduce((s,v)=>s+(v-mu)**2,0)/win);
  const curZ   = sd > 0 ? (spread[spread.length-1]-mu)/sd : 0;

  return {
    pair, beta: parseFloat(beta.toFixed(4)),
    curZ:     parseFloat(curZ.toFixed(3)),
    spread:   parseFloat(spread[spread.length-1].toFixed(4)),
    priceA:   pA[pA.length-1], priceB: pB[pB.length-1],
    signal:   curZ < -CONFIG.pairsEntryZ ? "long_A_short_B"
            : curZ >  CONFIG.pairsEntryZ ? "short_A_long_B"
            : Math.abs(curZ) < CONFIG.pairsExitZ ? "exit" : "hold",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RISK ENGINE  (intraday, pre-computed)
// ─────────────────────────────────────────────────────────────────────────────
const riskState = {
  dayStartEquity: CONFIG.paperCapital,
  currentEquity:  CONFIG.paperCapital,
  tradesThisHour: 0,
  tradesThisDay:  0,
  hourStart:      Date.now(),
  dayStart:       Date.now(),
  halted:         false,
  haltReason:     "",
  positions:      {},   // sym → { qty, side, entryPrice, entryTs, entrySlip }
  orders:         [],   // recent order log
  execLog:        [],   // execution quality log
};

function resetHourlyCounter() {
  riskState.tradesThisHour = 0;
  riskState.hourStart      = Date.now();
}

function isMarketOpen() {
  const et   = new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  const day  = et.getDay();
  if (day===0||day===6) return false;
  const mins = et.getHours()*60+et.getMinutes();
  return mins >= 570 && mins < 960;
}

function checkRisk(side, sym, qty, price) {
  const errors = [];

  if (riskState.halted)
    return { ok:false, errors:[`Halted: ${riskState.haltReason}`] };

  if (!isMarketOpen())
    return { ok:false, errors:["Market is closed"] };

  // Hourly trade limit
  if (Date.now() - riskState.hourStart > 3_600_000) resetHourlyCounter();
  if (riskState.tradesThisHour >= CONFIG.maxTradesPerHour)
    errors.push(`Hourly trade limit reached (${CONFIG.maxTradesPerHour}/hr)`);

  // Daily loss limit
  const drawdown = (riskState.dayStartEquity - riskState.currentEquity) / riskState.dayStartEquity * 100;
  if (drawdown >= CONFIG.maxDailyLossPct)
    errors.push(`Daily loss limit hit: -${drawdown.toFixed(2)}% (max ${CONFIG.maxDailyLossPct}%)`);

  // Position check for sells
  if (side === "sell" || side === "short") {
    if (!riskState.positions[sym])
      errors.push(`No position in ${sym} to ${side}`);
  }

  return { ok: errors.length === 0, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// ORDER ENGINE
// ─────────────────────────────────────────────────────────────────────────────
let alpacaClient = null;
let wssRef       = null;

function broadcast(data) {
  if (!wssRef) return;
  const msg = JSON.stringify(data);
  wssRef.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

function calcExecQuality(fillPrice, signalPrice, side) {
  const slipBps = Math.abs(fillPrice - signalPrice) / Math.max(signalPrice, 0.01) * 10000
                  * (side === "buy" ? 1 : -1);
  const volEst  = 2.0; // model bps (2bps = typical large-cap market order)
  const score   = Math.max(0, Math.round(100 - Math.max(0, Math.abs(slipBps) - volEst) * 2));
  return { slipBps: parseFloat(slipBps.toFixed(2)), modelBps: volEst, score };
}

async function placeOrder(params) {
  const { sym, side, qty, signalPrice, reason, strategyType } = params;
  const risk = checkRisk(side, sym, qty, signalPrice);
  if (!risk.ok) {
    console.warn(`[Risk] Blocked ${side} ${sym}:`, risk.errors);
    broadcast({ type: "order_blocked", sym, side, qty, reason: risk.errors });
    return null;
  }

  try {
    let fill;
    if (CONFIG.isPaper || !alpacaClient) {
      // Paper fill simulation — fill at signal price ± small noise
      const noise   = (Math.random() - 0.5) * 0.001 * signalPrice;
      const fillPx  = parseFloat((signalPrice + noise).toFixed(4));
      fill = { id: `paper_${Date.now()}`, symbol: sym, side, qty,
               filled_avg_price: fillPx, status: "filled",
               filled_at: new Date().toISOString(), client_order_id: `traids_${Date.now()}` };
    } else {
      // Live Alpaca order
      const order = await alpacaClient.createOrder({
        symbol: sym.replace("/",""),
        qty,
        side,
        type:         "market",
        time_in_force: "day",
        client_order_id: `traids_${Date.now()}`,
        extended_hours: false,
      });
      // Wait for fill (up to 3 seconds)
      let filled = null;
      for (let i = 0; i < 6 && !filled; i++) {
        await new Promise(r => setTimeout(r, 500));
        const o = await alpacaClient.getOrder(order.id);
        if (o.status === "filled") filled = o;
      }
      fill = filled || order;
    }

    const fillPrice  = parseFloat(fill.filled_avg_price || signalPrice);
    const execQuality = calcExecQuality(fillPrice, signalPrice, side);
    const ts         = new Date().toISOString();

    // Update risk state
    riskState.tradesThisHour++;
    riskState.tradesThisDay++;
    const cost = qty * fillPrice * (side === "sell" ? -1 : 1);
    riskState.currentEquity -= cost;

    // Update position state
    if (side === "buy" || side === "short") {
      riskState.positions[sym] = { qty, side, entryPrice: fillPrice, entryTs: ts, signalPrice };
    } else {
      delete riskState.positions[sym];
    }

    const rec = { ...fill, sym, qty, side, fillPrice, signalPrice,
      strategyType, reason, execQuality, ts };
    riskState.orders.unshift(rec);
    if (riskState.orders.length > 500) riskState.orders.pop();
    riskState.execLog.unshift({ ts, sym, side, qty, fillPrice, signalPrice, ...execQuality, strategyType });
    if (riskState.execLog.length > 1000) riskState.execLog.pop();

    console.log(`[Order] ${side.toUpperCase()} ${qty} ${sym} @ $${fillPrice} | Score: ${execQuality.score}/100 | ${reason}`);
    broadcast({ type: "order_filled", ...rec });
    return rec;
  } catch (err) {
    console.error(`[Order] Failed ${side} ${sym}:`, err.message);
    broadcast({ type: "order_error", sym, side, error: err.message });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL PROCESSOR — runs after each new bar arrives
// ─────────────────────────────────────────────────────────────────────────────
const POSITION_SIZE_USD = 2000;    // $2,000 per directional trade

async function processSignal(sym) {
  const st = getState(sym);
  if (st.bars.length < 60) return;  // need warmup

  const barsArr = st.bars.toArray();
  const { vote, conf, nBull, nBear } = computeEnsemble(barsArr);
  const price  = barsArr[barsArr.length - 1].c;
  const vol    = garchDailyVol(closes(barsArr).slice(-60));
  const qty    = Math.max(1, Math.floor(POSITION_SIZE_USD / price));

  // Detect flip
  const prevVote  = st.prevVote;
  const flipped   = prevVote !== undefined &&
    ((prevVote <= CONFIG.signalMinVote && vote > CONFIG.signalMinVote) ||
     (prevVote >= -CONFIG.signalMinVote && vote < -CONFIG.signalMinVote));
  st.prevVote = vote;

  const sig = { sym, vote, conf, nBull, nBear, price, vol, ts: new Date().toISOString(), flipped };
  st.lastSignal = sig;

  // Broadcast signal update to UI
  broadcast({ type: "signal_update", ...sig });

  // ── Auto-execute if signal fires ──────────────────────────────────────────
  if (conf < CONFIG.signalMinConf || Math.abs(vote) < CONFIG.signalMinVote) return;
  if (!flipped) return;  // only trade on fresh signal flips

  const existingPos = riskState.positions[sym];

  if (vote > CONFIG.signalMinVote && !existingPos) {
    // BUY signal — no existing position
    await placeOrder({ sym, side:"buy", qty, signalPrice:price,
      reason:`Ensemble flip → BULLISH (vote:${vote}, conf:${conf})`,
      strategyType:"ensemble_directional" });
  } else if (vote < -CONFIG.signalMinVote && !existingPos) {
    // SHORT signal (paper only / hedge via inverse ETF logic)
    await placeOrder({ sym, side:"sell", qty, signalPrice:price,
      reason:`Ensemble flip → BEARISH (vote:${vote}, conf:${conf})`,
      strategyType:"ensemble_directional" });
  } else if (existingPos) {
    // Signal reversed — close existing position
    const closeSide = existingPos.side === "buy" ? "sell" : "buy";
    await placeOrder({ sym, side:closeSide, qty:existingPos.qty, signalPrice:price,
      reason:`Signal reversal — closing ${existingPos.side} position`,
      strategyType:"ensemble_close" });
  }
}

async function processPairs() {
  for (const pair of INTRADAY_PAIRS) {
    const ps    = computePairSignal(pair);
    if (!ps) continue;

    const key   = getPairKey(pair.a, pair.b);
    const prev  = pairsState[key] || { signal:"hold" };
    pairsState[key] = ps;

    broadcast({ type: "pairs_update", ...ps });

    if (!isMarketOpen()) continue;
    const qtyA = Math.max(1, Math.floor(POSITION_SIZE_USD / ps.priceA));
    const qtyB = Math.max(1, Math.floor((POSITION_SIZE_USD * ps.beta) / ps.priceB));

    if (ps.signal === "long_A_short_B" && prev.signal !== "long_A_short_B") {
      // Open: long A, short B (buy A, sell B in paper/hedge context)
      await placeOrder({ sym:pair.a, side:"buy",  qty:qtyA, signalPrice:ps.priceA,
        reason:`Pairs z=${ps.curZ.toFixed(2)}σ → long ${pair.a} / short ${pair.b}`,
        strategyType:"pairs" });
      await placeOrder({ sym:pair.b, side:"sell", qty:qtyB, signalPrice:ps.priceB,
        reason:`Pairs z=${ps.curZ.toFixed(2)}σ → short leg`,
        strategyType:"pairs" });
    } else if (ps.signal === "short_A_long_B" && prev.signal !== "short_A_long_B") {
      await placeOrder({ sym:pair.a, side:"sell", qty:qtyA, signalPrice:ps.priceA,
        reason:`Pairs z=${ps.curZ.toFixed(2)}σ → short ${pair.a} / long ${pair.b}`,
        strategyType:"pairs" });
      await placeOrder({ sym:pair.b, side:"buy",  qty:qtyB, signalPrice:ps.priceB,
        reason:`Pairs z=${ps.curZ.toFixed(2)}σ → long leg`,
        strategyType:"pairs" });
    } else if (ps.signal === "exit") {
      // Close any pair positions
      for (const sym of [pair.a, pair.b]) {
        const pos = riskState.positions[sym];
        if (pos) {
          const closePrice = sym===pair.a ? ps.priceA : ps.priceB;
          const closeSide  = pos.side === "buy" ? "sell" : "buy";
          await placeOrder({ sym, side:closeSide, qty:pos.qty, signalPrice:closePrice,
            reason:`Pairs exit: z=${ps.curZ.toFixed(2)}σ inside ±${CONFIG.pairsExitZ}`,
            strategyType:"pairs_close" });
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ALPACA MARKET DATA WEBSOCKET
// ─────────────────────────────────────────────────────────────────────────────
let dataSocket   = null;
let reconnecting = false;

function connectAlpacaStream() {
  if (!process.env.ALPACA_KEY_ID || !process.env.ALPACA_SECRET_KEY) {
    /**
     * FAIL CLOSED (2026-07-30, D42). This used to start a Math.random() bar generator seeded
     * from a hardcoded 2024 price table — and those synthetic bars fed processSignal(), the
     * same signal path the real feed uses. A stream consumer had no way to tell a fabricated
     * tick from a real one; only the mode flag in a connect message distinguished them.
     *
     * A missing key is a CONFIGURATION FAILURE, not a cue to invent a market. The stream now
     * stays dark and says why, exactly like the alerts scanner (D36) and the futures panel.
     */
    console.error("[Stream] ALPACA_KEY_ID / ALPACA_SECRET_KEY not set — STREAM DISABLED. " +
      "No synthetic fallback: fabricated bars would flow into processSignal() indistinguishably from real ones.");
    broadcast({ type: "stream_unavailable", reason: "broker credentials not configured", ts: new Date().toISOString() });
    return;
  }

  const baseUrl = CONFIG.isPaper
    ? "wss://stream.data.alpaca.markets/v2/iex"
    : `wss://stream.data.alpaca.markets/v2/${CONFIG.feed}`;

  console.log(`[Stream] Connecting to Alpaca market data: ${baseUrl}`);
  dataSocket = new WebSocket(baseUrl);

  dataSocket.on("open", () => {
    console.log("[Stream] WebSocket open — authenticating");
    dataSocket.send(JSON.stringify({
      action: "auth",
      key:    process.env.ALPACA_KEY_ID,
      secret: process.env.ALPACA_SECRET_KEY,
    }));
  });

  dataSocket.on("message", async (raw) => {
    let messages;
    try { messages = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(messages)) messages = [messages];

    for (const msg of messages) {
      // Auth response
      if (msg.T === "success" && msg.msg === "authenticated") {
        console.log("[Stream] Authenticated — subscribing to", SYMBOLS.length, "symbols");
        dataSocket.send(JSON.stringify({
          action: "subscribe",
          bars:   SYMBOLS,
          quotes: SYMBOLS.slice(0, 10),  // quotes for top 10 (rate limit friendly)
        }));
        broadcast({ type: "stream_connected", symbols: SYMBOLS });
      }

      // 1-minute bar
      if (msg.T === "b") {
        const sym = msg.S;
        const st  = getState(sym);
        const bar = { t:msg.t, o:msg.o, h:msg.h, l:msg.l, c:msg.c, v:msg.v };
        st.bars.push(bar);
        broadcast({ type: "bar", sym, bar, bufferLen: st.bars.length });
        await processSignal(sym);
        await processPairs();
      }

      // Real-time quote (bid/ask for execution quality)
      if (msg.T === "q") {
        const st = getState(msg.S);
        st.bid = msg.bp; st.ask = msg.ap;
      }

      // Error
      if (msg.T === "error") {
        console.error("[Stream] Alpaca error:", msg.msg, msg.code);
      }
    }
  });

  dataSocket.on("close", (code, reason) => {
    console.warn(`[Stream] Disconnected (${code}): ${reason} — reconnecting in 5s`);
    broadcast({ type: "stream_disconnected", code, reason: reason.toString() });
    if (!reconnecting) {
      reconnecting = true;
      setTimeout(() => { reconnecting = false; connectAlpacaStream(); }, 5000);
    }
  });

  dataSocket.on("error", (err) => {
    console.error("[Stream] WebSocket error:", err.message);
  });
}

// ── Synthetic bar feed: REMOVED 2026-07-30 (D42) ─────────────────────────────
// The generator that lived here produced Math.random() bars from a hardcoded 2024 price
// table and fed them into processSignal() — the same path real bars use. Deleted rather
// than disabled, so no future edit can re-enable a fabricated feed by flipping a flag.
// If the broker keys are missing the stream stays dark and broadcasts stream_unavailable.

// ─────────────────────────────────────────────────────────────────────────────
// REST API ROUTES
// ─────────────────────────────────────────────────────────────────────────────
function init(app, wss, alpaca) {
  wssRef        = wss;
  alpacaClient  = alpaca;

  const router = require("express").Router();

  // ── Stream status ────────────────────────────────────────────────────────
  router.get("/api/stream/status", (req, res) => res.json({
    connected:    dataSocket?.readyState === 1 || !process.env.ALPACA_KEY_ID,
    mode:         process.env.ALPACA_KEY_ID ? "live" : "synthetic",
    symbols:      SYMBOLS,
    bars:         Object.fromEntries(SYMBOLS.map(s => [s, getState(s).bars.length])),
    lastSignals:  Object.fromEntries(SYMBOLS.map(s => [s, getState(s).lastSignal])),
    isMarketOpen: isMarketOpen(),
    barSize:      CONFIG.barSize,
  }));

  // ── Live signals ─────────────────────────────────────────────────────────
  router.get("/api/stream/signals", (req, res) => {
    const signals = SYMBOLS.map(sym => {
      const st = getState(sym);
      return st.lastSignal ? { ...st.lastSignal, bufLen: st.bars.length } : { sym, vote: 0, conf: 0 };
    }).sort((a,b) => Math.abs(b.vote)*b.conf - Math.abs(a.vote)*a.conf);
    res.json(signals);
  });

  // ── Pairs signals ─────────────────────────────────────────────────────────
  router.get("/api/stream/pairs", (req, res) => {
    const pairs = INTRADAY_PAIRS.map(p => ({
      ...p, ...(pairsState[getPairKey(p.a, p.b)] || { curZ: null, signal: "waiting" })
    }));
    res.json(pairs);
  });

  // ── Risk state ───────────────────────────────────────────────────────────
  router.get("/api/stream/risk", (req, res) => res.json({
    halted:           riskState.halted,
    haltReason:       riskState.haltReason,
    tradesThisHour:   riskState.tradesThisHour,
    tradesThisDay:    riskState.tradesThisDay,
    maxTradesPerHour: CONFIG.maxTradesPerHour,
    dailyLossPct:     ((riskState.dayStartEquity - riskState.currentEquity) / riskState.dayStartEquity * 100).toFixed(2),
    maxDailyLossPct:  CONFIG.maxDailyLossPct,
    positions:        riskState.positions,
    currentEquity:    riskState.currentEquity.toFixed(2),
    dayStartEquity:   riskState.dayStartEquity.toFixed(2),
  }));

  // ── Execution quality ─────────────────────────────────────────────────────
  router.get("/api/stream/execlog", (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || 50), 500);
    const log   = riskState.execLog.slice(0, limit);
    const avgScore = log.length ? Math.round(log.reduce((s,t)=>s+t.score,0)/log.length) : null;
    const avgSlip  = log.length ? parseFloat((log.reduce((s,t)=>s+Math.abs(t.slipBps),0)/log.length).toFixed(2)) : null;
    res.json({ log, avgScore, avgSlip, totalFills: riskState.execLog.length });
  });

  // ── Order history ─────────────────────────────────────────────────────────
  router.get("/api/stream/orders", (req, res) => {
    res.json(riskState.orders.slice(0, 100));
  });

  // ── Manual order (force a trade) ─────────────────────────────────────────
  router.post("/api/stream/order", async (req, res) => {
    const { sym, side, qty, reason } = req.body;
    if (!sym || !side || !qty) return res.status(400).json({ error: "sym, side, qty required" });
    const price = getState(sym).bars.last()?.c || 0;
    const result = await placeOrder({ sym, side, qty: parseInt(qty), signalPrice: price,
      reason: reason || "manual", strategyType: "manual" });
    res.json({ ok: !!result, result });
  });

  // ── Risk override ─────────────────────────────────────────────────────────
  router.post("/api/stream/halt", (req, res) => {
    const { action, reason } = req.body;
    if (action === "halt") {
      riskState.halted = true;
      riskState.haltReason = reason || "Manual halt";
      broadcast({ type: "risk_halt", reason: riskState.haltReason });
      res.json({ ok: true, halted: true });
    } else if (action === "resume") {
      riskState.halted = false;
      riskState.haltReason = "";
      broadcast({ type: "risk_resume" });
      res.json({ ok: true, halted: false });
    } else {
      res.status(400).json({ error: "action must be halt|resume" });
    }
  });

  // ── Config ────────────────────────────────────────────────────────────────
  router.get("/api/stream/config", (req, res) => res.json(CONFIG));
  router.patch("/api/stream/config", (req, res) => {
    const allowed = ["maxTradesPerHour","maxDailyLossPct","signalMinConf","signalMinVote","pairsEntryZ","pairsExitZ"];
    allowed.forEach(k => { if (req.body[k] !== undefined) CONFIG[k] = parseFloat(req.body[k]); });
    res.json(CONFIG);
  });

  // ── Regime weights ────────────────────────────────────────────────────────
  router.post("/api/stream/regime-weights", (req, res) => {
    setRegimeWeights(req.body);
    res.json({ ok: true, weights: activeRegimeWeights });
  });

  app.use(router);
  connectAlpacaStream();

  // Reset hourly counter every hour
  setInterval(resetHourlyCounter, 3_600_000);

  // Reset daily counters at 4pm ET
  setInterval(() => {
    const et = new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
    if (et.getHours() === 16 && et.getMinutes() === 0) {
      riskState.dayStartEquity = riskState.currentEquity;
      riskState.tradesThisDay  = 0;
      riskState.dayStart       = Date.now();
      console.log("[Risk] Daily counters reset at market close");
    }
  }, 60_000);

  console.log(`
  ┌─────────────────────────────────────────────────────────────┐
  │  TRAIDS Streaming Engine                                    │
  ├─────────────────────────────────────────────────────────────┤
  │  GET  /api/stream/status        Stream + bar buffer status  │
  │  GET  /api/stream/signals       Live ensemble signals       │
  │  GET  /api/stream/pairs         Intraday pairs z-scores     │
  │  GET  /api/stream/risk          Risk state + positions      │
  │  GET  /api/stream/execlog       Execution quality log       │
  │  GET  /api/stream/orders        Order history               │
  │  POST /api/stream/order         Manual order entry          │
  │  POST /api/stream/halt          Emergency halt / resume     │
  │  GET  /api/stream/config        Current parameters          │
  │  PATCH /api/stream/config       Update parameters live      │
  │  POST /api/stream/regime-weights  Push regime weights       │
  └─────────────────────────────────────────────────────────────┘
  `);
}

// ── Standalone ────────────────────────────────────────────────────────────────
if (require.main === module) {
  const express = require("express");
  const cors    = require("cors");
  const http2   = require("http");
  const wss2    = require("ws");
  const app2    = express();
  const server2 = http2.createServer(app2);
  const wsServer = new wss2.Server({ server: server2, path: "/ws" });
  const PORT2   = parseInt(process.env.STREAM_PORT || "3004");

  app2.use(cors()); app2.use(express.json());
  init(app2, wsServer, null);
  server2.listen(PORT2, () =>
    console.log(`\n  TRAIDS Stream Engine → http://localhost:${PORT2}\n`));
}

module.exports = { init, computeEnsemble, computePairSignal, setRegimeWeights, riskState, CONFIG };
