#!/usr/bin/env node
/**
 * TRAIDS — ML on the 2-Year Backtest ("what worked and what didn't")
 *
 * The live log is too small for ML (~90 trades). The 2-year board replay generates ~8,000
 * labeled signals — enough to actually learn from. For every historical signal this records
 * a feature vector + outcome (win = rMult > 0), then trains the SAME GBDT (from
 * predictive-pipeline.js), walk-forward, and reports:
 *   1) out-of-sample ROC-AUC — can it rank winners above losers?  (0.50 = no learnable edge)
 *   2) FEATURE IMPORTANCE — which inputs the model leaned on (what "worked").
 *
 * Features per signal: confidence, vote magnitude, direction, strategy (Trend/Breakout/
 * MeanRev), regime alignment (does the trade agree with SPY's 50-day trend), RVOL,
 * 5-day reversal, volatility-squeeze. Honest by construction: walk-forward, big sample.
 * Survivorship + in-sample-threshold biases still FLATTER it — a weak AUC is a ceiling.
 *
 * Usage:  node backend/ml-backtest.js
 */
const fs = require("fs"), path = require("path");
const { trainGBDT, trainLogReg, walkForward, auc } = require("./predictive-pipeline");
function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} }
loadEnv();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
if (!KEY || !SEC) { console.error("\n  Missing ALPACA keys.\n"); process.exit(1); }
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };
const DAYS = parseInt(process.env.DAYS || "750"), MIN_CONF = 0.6, ATR_MULT = 1.5, RR = 2;
const UNIVERSE = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","JPM","V","UNH","XOM","JNJ","WMT","PG","MA","HD","CVX","ABBV","KO","PEP","COST","MRK","AVGO","LLY","BAC","ADBE","CRM","NFLX","AMD","DIS","INTC","QCOM","TXN","HON","UNP","LOW","CAT","GS","BKNG","NKE","MS","BA","T","PFE","C"];
const BENCH = "SPY";

// ── indicators (verbatim from board) ─────────────────────────────────────────
const sma = (p, per) => p.map((_, i) => i < per - 1 ? null : p.slice(i - per + 1, i + 1).reduce((a, b) => a + b, 0) / per);
const std = (a, p, i) => { if (i < p - 1) return null; let m = 0; for (let k = i - p + 1; k <= i; k++) m += a[k]; m /= p; let v = 0; for (let k = i - p + 1; k <= i; k++) v += (a[k] - m) ** 2; return Math.sqrt(v / p); };
function atr(h, l, c, period = 14) { const tr = c.map((_, i) => i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))); const r = new Array(c.length).fill(null); r[period - 1] = tr.slice(0, period).reduce((a, b) => a + b, 0) / period; for (let i = period; i < c.length; i++) r[i] = (r[i - 1] * (period - 1) + tr[i]) / period; return r; }
function adx(h, l, c, period = 14) { const n = c.length, r = new Array(n).fill(null), dp = new Array(n).fill(0), dm = new Array(n).fill(0); const tr = c.map((_, i) => i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))); for (let i = 1; i < n; i++) { const up = h[i] - h[i - 1], dn = l[i - 1] - l[i]; dp[i] = up > dn && up > 0 ? up : 0; dm[i] = dn > up && dn > 0 ? dn : 0; } let sT = tr.slice(1, period + 1).reduce((a, b) => a + b, 0), sP = dp.slice(1, period + 1).reduce((a, b) => a + b, 0), sM = dm.slice(1, period + 1).reduce((a, b) => a + b, 0); for (let i = period; i < n; i++) { if (i > period) { sT = sT - sT / period + tr[i]; sP = sP - sP / period + dp[i]; sM = sM - sM / period + dm[i]; } const diP = sT > 0 ? 100 * sP / sT : 0, diM = sT > 0 ? 100 * sM / sT : 0; const dx = diP + diM > 0 ? 100 * Math.abs(diP - diM) / (diP + diM) : 0; if (i === 2 * period - 1) r[i] = dx; else if (i > 2 * period - 1 && r[i - 1] !== null) r[i] = (r[i - 1] * (period - 1) + dx) / period; } return r; }
// signals (verbatim)
function breakoutSignal(d, i, lb = 55) { if (i < lb + 5) return { vote: 0, confidence: 0 }; const w = d.slice(i - lb, i); const hi = Math.max(...w.map(x => x.high)), lo = Math.min(...w.map(x => x.low)); const c = d[i].close, pc = d[i - 1].close, rng = (hi - lo) || c * 0.02; const av = w.map(x => x.volume).reduce((s, v) => s + v, 0) / w.length; if (!(av > 0)) return { vote: 0, confidence: 0 }; const vr = d[i].volume / av; if (vr < 1.5) return { vote: 0, confidence: 0 }; let vote = 0, mag = 0; if (c > hi && pc <= hi) { mag = Math.min(1, (c - hi) / (rng * 0.15)); vote = 0.65 + 0.35 * mag; } else if (c < lo && pc >= lo) { mag = Math.min(1, (lo - c) / (rng * 0.15)); vote = -(0.65 + 0.35 * mag); } else return { vote: 0, confidence: 0 }; return { vote, confidence: Math.max(0, Math.min(0.96, 0.5 + 0.18 * mag + Math.min(0.22, (vr - 1.5) * 0.12))), strat: "Breakout" }; }
function meanRevSignal(d, i, lb = 20) { if (i < lb + 30) return { vote: 0, confidence: 0 }; const w = d.slice(i - lb + 1, i + 1).map(x => x.close); const ma = w.reduce((s, v) => s + v, 0) / w.length; const sd = Math.sqrt(w.reduce((s, v) => s + (v - ma) ** 2, 0) / w.length) || ma * 0.01; const c = d[i].close, z = (c - ma) / sd; if (Math.abs(z) < 2) return { vote: 0, confidence: 0 }; const lw = d.slice(i - 50, i + 1).map(x => x.close), lma = lw.reduce((s, v) => s + v, 0) / lw.length; let vote = 0; if (z <= -2) { if (c < lma * 0.92) return { vote: 0, confidence: 0 }; vote = Math.min(1, 0.6 + (Math.abs(z) - 2) * 0.2); } else { if (c > lma * 1.08) return { vote: 0, confidence: 0 }; vote = -Math.min(1, 0.6 + (Math.abs(z) - 2) * 0.2); } return { vote, confidence: Math.max(0, Math.min(0.95, 0.55 + (Math.abs(z) - 2) * 0.12)), strat: "Mean-Reversion" }; }
function trendSignal(d, i, fast = 20, slow = 50) { if (i < slow + 12) return { vote: 0, confidence: 0 }; const c = d.slice(0, i + 1).map(x => x.close), h = d.slice(0, i + 1).map(x => x.high), l = d.slice(0, i + 1).map(x => x.low); const mF = sma(c, fast), mS = sma(c, slow); const f = mF[i], s = mS[i], fp = mF[i - 10]; if (f == null || s == null || fp == null) return { vote: 0, confidence: 0 }; const px = c[i], slope = (f - fp) / fp, up = px > f && f > s && slope > 0, dn = px < f && f < s && slope < 0; if (!up && !dn) return { vote: 0, confidence: 0 }; const dir = up ? 1 : -1, a = adx(h, l, c, 14)[i] || 0; if (a < 20) return { vote: 0, confidence: 0 }; const sep = Math.abs(f - s) / s; return { vote: dir * Math.min(1, 0.5 + (a - 20) / 60 + Math.min(0.3, sep * 8)), confidence: Math.max(0, Math.min(0.95, 0.5 + (a - 20) / 100 + Math.min(0.2, sep * 6))), strat: "Trend" }; }

async function fetchBars(sym) { const start = new Date(Date.now() - DAYS * 86400000).toISOString().split("T")[0]; const out = []; let tok = null; do { const pr = new URLSearchParams({ symbols: sym, timeframe: "1Day", start, limit: "10000", adjustment: "all", feed: FEED }); if (tok) pr.set("page_token", tok); const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${pr}`, { headers }); if (!r.ok) break; const j = await r.json(); for (const b of (j.bars?.[sym] || [])) out.push({ close: b.c, high: b.h, low: b.l, volume: b.v || 0 }); tok = j.next_page_token || null; } while (tok); return out; }

const FEATS = ["confidence", "voteMag", "dir", "isTrend", "isBreakout", "isMeanRev", "regimeAlign", "rvol", "rev5", "squeeze"];

(async () => {
  console.log(`\n  TRAIDS — ML on the 2-Year Backtest  ·  ${UNIVERSE.length} names + SPY · ~${DAYS}d\n`);
  process.stdout.write("  fetching");
  const data = {}; for (const s of [...UNIVERSE, BENCH]) { data[s] = await fetchBars(s); process.stdout.write("."); }
  console.log("");
  const spyC = data[BENCH].map(b => b.close), spy50 = sma(spyC, 50);

  const rows = [];   // { idx, x:[...feats], y }
  for (const sym of UNIVERSE) {
    const d = data[sym]; if (d.length < 120) continue;
    const c = d.map(b => b.close), v = d.map(b => b.volume);
    const off = spyC.length - d.length;   // end-align SPY to this symbol
    const aArr = atr(d.map(b => b.high), d.map(b => b.low), c, 14);
    for (let i = 70; i < d.length - 1; i++) {
      const cands = [trendSignal(d, i), breakoutSignal(d, i), meanRevSignal(d, i)].filter(s => s.confidence >= MIN_CONF && Math.abs(s.vote) >= 0.4);
      if (!cands.length) continue;
      cands.sort((a, b) => b.confidence * Math.abs(b.vote) - a.confidence * Math.abs(a.vote));
      const sig = cands[0], dir = sig.vote > 0 ? 1 : -1;
      const entry = c[i], sd = (aArr[i] || entry * 0.02) * ATR_MULT, stop = entry - dir * sd, tgt = entry + dir * sd * RR;
      const b = d[i + 1], long = dir > 0;
      const exit = (long ? b.low <= stop : b.high >= stop) ? stop : (long ? b.high >= tgt : b.low <= tgt) ? tgt : b.close;
      const y = ((exit - entry) * dir) / sd > 0 ? 1 : 0;
      // observer features at i
      const si = i + off; const spyBull = (si >= 0 && spy50[si] != null) ? spyC[si] > spy50[si] : null;
      const regimeAlign = spyBull == null ? 0 : ((dir > 0) === spyBull ? 1 : -1);
      let av = 0; for (let k = i - 20; k < i; k++) av += v[k]; av /= 20; const rvol = av > 0 ? v[i] / av : 1;
      const rev5 = c[i - 5] > 0 ? c[i] / c[i - 5] - 1 : 0;
      let squeeze = 0; if (i >= 130) { const bw = z => { const m = sma(c.slice(z - 19, z + 1), 20)[19], s = std(c, 20, z); return s != null ? 4 * s / m : 0; }; const cur = bw(i); let mn = Infinity; for (let z = i - 120; z < i; z++) mn = Math.min(mn, bw(z)); squeeze = cur <= mn ? 1 : 0; }
      rows.push({ idx: i, x: [sig.confidence, Math.abs(sig.vote), dir, sig.strat === "Trend" ? 1 : 0, sig.strat === "Breakout" ? 1 : 0, sig.strat === "Mean-Reversion" ? 1 : 0, regimeAlign, rvol, rev5, squeeze], y });
    }
  }
  rows.sort((a, b) => a.idx - b.idx);   // chronological-ish (end-aligned index ≈ time)
  const X = rows.map(r => r.x), Y = rows.map(r => r.y);
  console.log(`\n  ${X.length} signals labeled (win rate ${(Y.reduce((s, v) => s + v, 0) / Y.length * 100).toFixed(1)}%)\n`);

  const g = walkForward(X, Y, trainGBDT), lr = walkForward(X, Y, trainLogReg);
  console.log("  WALK-FORWARD (out-of-sample):");
  console.log(`    GBDT   AUC ${g.auc.toFixed(3)}`);
  console.log(`    LogReg AUC ${lr.auc.toFixed(3)}`);
  console.log(`    ${Math.max(g.auc, lr.auc) < 0.55 ? "=> <0.55: NO learnable edge — the features don't separate winners from losers." : Math.max(g.auc, lr.auc) < 0.6 ? "=> 0.55-0.60: marginal hint. Needs confirmation; likely noise." : "=> >0.60 OOS: a real learnable signal may exist. Validate hard before trusting."}\n`);

  // feature importance: split-frequency across a GBDT trained on the train slice
  const cut = Math.floor(X.length * 0.6);
  const model = trainGBDT(X.slice(0, cut), Y.slice(0, cut));
  const imp = new Array(FEATS.length).fill(0);
  const walk = n => { if (!n || n.leaf) return; imp[n.f]++; walk(n.left); walk(n.right); };
  for (const t of model.trees) walk(t);
  const tot = imp.reduce((s, v) => s + v, 0) || 1;
  const ranked = FEATS.map((f, i) => [f, imp[i] / tot]).sort((a, b) => b[1] - a[1]);
  console.log("  FEATURE IMPORTANCE (what the model leaned on — % of tree splits):");
  for (const [f, p] of ranked) console.log("    " + f.padEnd(14) + (p * 100).toFixed(1) + "%  " + "█".repeat(Math.round(p * 50)));
  console.log(`\n  Caveat: if AUC ≈ 0.50, this importance is the model grasping at NOISE — which feature it`);
  console.log(`  splits on most is meaningless when none of them actually predict the outcome. Read AUC first.\n`);
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
