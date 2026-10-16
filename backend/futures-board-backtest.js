#!/usr/bin/env node
/**
 * TRAIDS — Futures Board Backtest (the validation the futures signals never had)
 *
 * Every prior backtest (board-backtest.js et al.) covered EQUITIES only. The board's futures
 * signals were wired live (Massive continuous data) but NEVER settled against history. This
 * fixes that: it replays the exact board archetypes — Trend, Breakout, Mean-Reversion (verbatim
 * from src/App.jsx) — across ~2 years of CME continuous daily bars (Massive, with volume), and
 * settles each signal the same way Settle day does: entry = signal-day close, ATR(14)×1.5 stop,
 * 2R target, scored against the NEXT session's high/low (conservative stop-first). Reports win
 * rate, expectancy, profit factor, calibration, by-strategy and by-root — the large-sample
 * gut-check for futures that a 5-position mid-morning mark can't give.
 *
 * READ BEFORE TRUSTING:
 *  • The board's futures signal is a 1-DAY hold. This is NOT the CTA/trend premium (that's the
 *    MULTI-WEEK time-series momentum in futures-trend-test.js, the one real futures edge). A 1-day
 *    MA/breakout signal in futures is a coin flip in any regime — and futures is where the most
 *    sophisticated systematic money (CTAs) competes, so the bar for a simple rule is HIGHER.
 *  • Only ~2yr of history (Massive futures plan ceiling) and ~16 liquid roots → SMALLER sample
 *    and lower power than the equity backtest. Wide error bars; a weak result is not "almost there".
 *  • Continuous series stitch front-month by max volume → small roll gaps a few times a year add
 *    noise (mostly washes out over the next-session settle). Costs are a flat %-of-notional proxy.
 *  • Backtests flatter live (perfect fills, no slippage on the roll). A ~0 result here is a real
 *    red flag; a positive one is a CEILING.
 *
 * Usage:  node backend/futures-board-backtest.js          (2026-10-02: reads data/futures-daily — backend/futures-daily-cache.js)
 *         COST_BPS=3 MIN_CONF=0.6 node backend/futures-board-backtest.js
 */
const { buildContinuous } = require("./lib/futures-daily.js");   // 2026-10-02 Massive exit: Schwab continuous daily from the nightly cache (data/futures-daily), same {c,h,l,v} rows
const COST_BPS = parseFloat(process.env.COST_BPS || "3");   // per-side, % of notional proxy (futures spreads are tight)
const MIN_CONF = parseFloat(process.env.MIN_CONF || "0.6");
const RR = 2, ATR_MULT = 1.5;

// liquid CME/CBOT/NYMEX/COMEX roots (Massive returns continuous daily bars w/ volume)
const ROOTS = ["ES", "NQ", "YM", "RTY", "CL", "NG", "GC", "SI", "HG", "ZN", "ZB", "ZF", "6E", "6J", "6B", "6A", "6C", "ZC", "ZS", "ZW"];

// ── indicators + signals (verbatim from src/App.jsx / board-backtest.js) ──
const sma = (p, per) => p.map((_, i) => i < per - 1 ? null : p.slice(i - per + 1, i + 1).reduce((a, b) => a + b, 0) / per);
function atr(h, l, c, period = 14) { const trs = c.map((_, i) => i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))); const r = new Array(c.length).fill(null); r[period - 1] = trs.slice(0, period).reduce((a, b) => a + b, 0) / period; for (let i = period; i < c.length; i++) r[i] = (r[i - 1] * (period - 1) + trs[i]) / period; return r; }
function adx(h, l, c, period = 14) { const n = c.length, r = new Array(n).fill(null), dmP = new Array(n).fill(0), dmM = new Array(n).fill(0); const tr = c.map((_, i) => i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))); for (let i = 1; i < n; i++) { const up = h[i] - h[i - 1], dn = l[i - 1] - l[i]; dmP[i] = up > dn && up > 0 ? up : 0; dmM[i] = dn > up && dn > 0 ? dn : 0; } let sT = tr.slice(1, period + 1).reduce((a, b) => a + b, 0), sP = dmP.slice(1, period + 1).reduce((a, b) => a + b, 0), sM = dmM.slice(1, period + 1).reduce((a, b) => a + b, 0); for (let i = period; i < n; i++) { if (i > period) { sT += tr[i] - sT / period; sP += dmP[i] - sP / period; sM += dmM[i] - sM / period; } const diP = sT > 0 ? 100 * sP / sT : 0, diM = sT > 0 ? 100 * sM / sT : 0, dx = diP + diM > 0 ? 100 * Math.abs(diP - diM) / (diP + diM) : 0; if (i === 2 * period - 1) r[i] = dx; else if (i > 2 * period - 1 && r[i - 1] !== null) r[i] = (r[i - 1] * (period - 1) + dx) / period; } return r; }
function breakoutSignal(d, i, lb = 55) { if (i < lb + 5) return { vote: 0, confidence: 0 }; const w = d.slice(i - lb, i); const hi = Math.max(...w.map(x => x.high ?? x.close)), lo = Math.min(...w.map(x => x.low ?? x.close)); const c = d[i].close, pc = d[i - 1].close, range = (hi - lo) || c * 0.02; const vols = w.map(x => x.volume || 0), av = vols.reduce((s, v) => s + v, 0) / (vols.length || 1); if (!(av > 0)) return { vote: 0, confidence: 0 }; const vr = (d[i].volume || 0) / av; if (vr < 1.5) return { vote: 0, confidence: 0 }; let vote = 0, mag = 0; if (c > hi && pc <= hi) { mag = Math.min(1, (c - hi) / (range * 0.15)); vote = 0.65 + 0.35 * mag; } else if (c < lo && pc >= lo) { mag = Math.min(1, (lo - c) / (range * 0.15)); vote = -(0.65 + 0.35 * mag); } else return { vote: 0, confidence: 0 }; const vb = Math.min(0.22, (vr - 1.5) * 0.12); return { vote, confidence: Math.max(0, Math.min(0.96, 0.50 + 0.18 * mag + vb)), strat: "Breakout" }; }
function meanRevSignal(d, i, lb = 20) { if (i < lb + 30) return { vote: 0, confidence: 0 }; const w = d.slice(i - lb + 1, i + 1).map(x => x.close); const ma = w.reduce((s, v) => s + v, 0) / w.length, sd = Math.sqrt(w.reduce((s, v) => s + (v - ma) ** 2, 0) / w.length) || ma * 0.01; const c = d[i].close, z = (c - ma) / sd; if (Math.abs(z) < 2) return { vote: 0, confidence: 0 }; const lw = d.slice(i - 50, i + 1).map(x => x.close), lma = lw.reduce((s, v) => s + v, 0) / lw.length; let vote = 0; if (z <= -2) { if (c < lma * 0.92) return { vote: 0, confidence: 0 }; vote = Math.min(1, 0.6 + (Math.abs(z) - 2) * 0.2); } else { if (c > lma * 1.08) return { vote: 0, confidence: 0 }; vote = -Math.min(1, 0.6 + (Math.abs(z) - 2) * 0.2); } return { vote, confidence: Math.max(0, Math.min(0.95, 0.55 + (Math.abs(z) - 2) * 0.12)), strat: "Mean-Reversion" }; }
function trendSignal(d, i, fast = 20, slow = 50) { if (i < slow + 12) return { vote: 0, confidence: 0 }; const cl = d.slice(0, i + 1).map(x => x.close), hh = d.slice(0, i + 1).map(x => x.high ?? x.close), ll = d.slice(0, i + 1).map(x => x.low ?? x.close); const mF = sma(cl, fast), mS = sma(cl, slow), f = mF[i], s = mS[i], fp = mF[i - 10]; if (f == null || s == null || fp == null) return { vote: 0, confidence: 0 }; const px = cl[i], slope = (f - fp) / fp, up = px > f && f > s && slope > 0, dn = px < f && f < s && slope < 0; if (!up && !dn) return { vote: 0, confidence: 0 }; const dir = up ? 1 : -1, av = adx(hh, ll, cl, 14)[i] || 0; if (av < 20) return { vote: 0, confidence: 0 }; const sep = Math.abs(f - s) / s; return { vote: dir * Math.min(1, 0.5 + (av - 20) / 60 + Math.min(0.3, sep * 8)), confidence: Math.max(0, Math.min(0.95, 0.5 + (av - 20) / 100 + Math.min(0.2, sep * 6))), strat: "Trend" }; }

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;

(async () => {
  console.log(`\n  TRAIDS — Futures Board Backtest · ${ROOTS.length} CME roots · ~2yr Schwab continuous daily from the nightly cache (w/ volume) · Trend/Breakout/Mean-Rev verbatim\n`);
  const trades = [];   // { strat, dir, conf, rMult, retPct, root }
  let rootCount = 0;
  process.stdout.write("  building continuous + replaying");
  for (const root of ROOTS) {
    let bars = [];
    try { bars = await buildContinuous(root); } catch {}
    process.stdout.write(bars.length ? "." : "x");
    if (!bars || bars.length < 120) continue;
    rootCount++;
    const data = bars.map(b => ({ close: b.c, high: b.h, low: b.l, volume: b.v || 0 }));
    const H = data.map(d => d.high), L = data.map(d => d.low), Cl = data.map(d => d.close);
    const aArr = atr(H, L, Cl, 14);
    for (let i = 70; i < data.length - 1; i++) {
      const cands = [trendSignal(data, i), breakoutSignal(data, i), meanRevSignal(data, i)].filter(s => s.confidence >= MIN_CONF && Math.abs(s.vote) >= 0.4);
      if (!cands.length) continue;
      cands.sort((a, b) => (b.confidence * Math.abs(b.vote)) - (a.confidence * Math.abs(a.vote)));
      const sig = cands[0], dir = sig.vote > 0 ? 1 : -1;
      const entry = data[i].close, aVal = aArr[i] || entry * 0.02;
      const stopDist = aVal * ATR_MULT, stop = entry - dir * stopDist, target = entry + dir * stopDist * RR;
      const b = data[i + 1], long = dir > 0;
      const hitStop = long ? b.low <= stop : b.high >= stop, hitTgt = long ? b.high >= target : b.low <= target;
      const exit = hitStop ? stop : hitTgt ? target : b.close;   // conservative: stop checked first
      const rMult = ((exit - entry) * dir) / stopDist;
      const retPct = ((exit - entry) / entry) * dir * 100 - COST_BPS * 2 / 100;
      trades.push({ strat: sig.strat, dir, conf: sig.confidence, rMult, retPct, root });
    }
  }
  console.log(`\n\n  ${rootCount} roots, ${trades.length} futures signals replayed (net of ${COST_BPS}bps/side).\n`);
  if (!trades.length) { console.error("  No signals (check the data/futures-daily cache).\n"); process.exit(1); }

  const stats = (set) => { const w = set.filter(t => t.rMult > 0).length; const gW = set.filter(t => t.retPct > 0).reduce((s, t) => s + t.retPct, 0), gL = Math.abs(set.filter(t => t.retPct <= 0).reduce((s, t) => s + t.retPct, 0)); return { n: set.length, win: set.length ? w / set.length * 100 : 0, expR: mean(set.map(t => t.rMult)), avgRet: mean(set.map(t => t.retPct)), pf: gL ? gW / gL : 0 }; };
  const pad = (s, n) => String(s).padEnd(n);
  const all = stats(trades);
  console.log("  OVERALL");
  console.log(`    signals ${all.n} · win ${all.win.toFixed(1)}% · expectancy ${all.expR >= 0 ? "+" : ""}${all.expR.toFixed(3)}R · avg ret/trade ${all.avgRet >= 0 ? "+" : ""}${all.avgRet.toFixed(3)}% · profit factor ${all.pf.toFixed(2)}\n`);

  console.log("  BY STRATEGY");
  console.log("    " + pad("strategy", 18) + pad("n", 8) + pad("win%", 8) + pad("exp R", 9) + "avg ret");
  for (const st of ["Trend", "Breakout", "Mean-Reversion"]) { const s = stats(trades.filter(t => t.strat === st)); if (s.n) console.log("    " + pad(st, 18) + pad(s.n, 8) + pad(s.win.toFixed(0), 8) + pad((s.expR >= 0 ? "+" : "") + s.expR.toFixed(3), 9) + (s.avgRet >= 0 ? "+" : "") + s.avgRet.toFixed(3) + "%"); }

  console.log("\n  BY ROOT (per-market sample is small — wide error bars)");
  console.log("    " + pad("root", 8) + pad("n", 7) + pad("win%", 8) + "exp R");
  const byRoot = {}; for (const t of trades) (byRoot[t.root] ||= []).push(t);
  for (const r of Object.keys(byRoot).sort((a, b) => byRoot[b].length - byRoot[a].length)) { const s = stats(byRoot[r]); console.log("    " + pad(r, 8) + pad(s.n, 7) + pad(s.win.toFixed(0), 8) + (s.expR >= 0 ? "+" : "") + s.expR.toFixed(3)); }

  console.log("\n  CALIBRATION (does higher confidence win more?)");
  console.log("    " + pad("band", 12) + pad("n", 8) + pad("win%", 8) + "exp R");
  for (const [lo, hi, lab] of [[0.9, 1.01, "90-100%"], [0.8, 0.9, "80-90%"], [0.7, 0.8, "70-80%"], [0.6, 0.7, "60-70%"]]) { const s = stats(trades.filter(t => t.conf >= lo && t.conf < hi)); if (s.n) console.log("    " + pad(lab, 12) + pad(s.n, 8) + pad(s.win.toFixed(0), 8) + (s.expR >= 0 ? "+" : "") + s.expR.toFixed(3)); }

  console.log(`\n  READ: expectancy near 0 / PF < 1 = the 1-day futures signal has no edge over the hold (after cost),`);
  console.log(`  matching the equity result. The REAL futures edge is multi-week trend (futures-trend-test.js), not this.`);
  console.log(`  Small N + survivorship + backtest-flattering all push the TRUE number BELOW what's printed here.\n`);
})().catch(e => { console.error("\n  Futures backtest error:", e.message, "\n"); process.exit(1); });
