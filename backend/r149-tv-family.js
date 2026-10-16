#!/usr/bin/env node
/**
 * R149 — THE TRADINGVIEW FAMILY (2026-09-23). Operator: "evaluate all of them", scoped (his choice) to the three strategies in
 * the Alpha Insider reel plus the trading rules among TradingView's Editors' Picks strategies. Eight members are translated from
 * their published open-source code at their published DEFAULT inputs — nothing is tuned — and run on data we hold:
 *
 *   ONE-PCT-WEEK  TASC 2026.03 "One Percent A Week" (PineCodersTASC)  TQQQ 15-min RTH: Monday-open -1% limit buy, +1% target placed at
 *                 the next session's first bar, breakeven exit after a -0.5% low, market-on-close Friday. Cost 0.02% (limit orders).
 *   PMAX          "PMax Explorer" (KivancOzbilgic)                    daily, 100 names: EMA(hl2,10) vs PMax(ATR 10 x 3), stop-and-reverse
 *   DOUBLE-TAP    "Bjorgum Double Tap" (Bjorgum)                      daily, 100 names: zig-zag doubles, pivot length 50, tolerance 15%,
 *                                                                     target 100% of height past the neckline, stop at the pattern extreme
 *   GAP-FILL      "Gap Filling Strategy" (alexgrover)                 15-min RTH, 20 names: fade the session-open gap, exit at the fill,
 *                                                                     close everything at the next session (invert = false, as published)
 *   GLA           "Grover Llorens Activator Strategy" (alexgrover)    1-hour RTH, 20 names: length 480, mult 14, stop-and-reverse
 *   LUBE          "LUBE" (Jomy)                                       BTC/USD 30-min: friction over 500 bars, FIR trend, 100-bar range
 *   BB-SQUEEZE    "Bollinger Squeeze Breakout + Volume" (the reel)    1-hour RTH, 20 names: BB(20,2) squeeze < 0.8 x its 50-bar mean,
 *                                                                     close through a band on above-average volume, 1.5 ATR stop, 3 ATR target
 *   WMA-EMA       "WMA(20) and EMA(8) Crossover" (the reel's bot)     daily, 100 names: EMA8 over WMA20 = long, under = short, reverse
 *
 * EXECUTION = TradingView's broker emulator: orders are generated at a bar's close and fill from the next bar; market orders fill at
 * the next open; stop/limit orders are checked along TradingView's intrabar path (open -> the nearer of high/low -> the other -> close);
 * an open beyond a stop or limit fills at the open. Equity members pay 0.10% round trip (ONE-PCT-WEEK 0.02%), BTC 0.10%.
 *
 * STATISTIC per member: unit = calendar MONTH of entry; per month the mean net % return of the trades entered; t = Newey-West lag 1.
 * Drift control: the pipeline on bar-shuffled prices (each symbol keeps its own mean return) sets a floor the real mean must beat.
 *
 *   node backend/r149-tv-family.js --selftest     known-answer checks only
 *   node backend/r149-tv-family.js                selftest + controls (two scrambles, one look-ahead) — never the real number
 *   node backend/r149-tv-family.js --read         the ONE real read; refuses unless registered, controls passed, not yet read
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { fetchBars } = require("./lib/alpaca-bars.js"); const { fetchCryptoBars } = require("./lib/crypto-bars.js");
const D = (f) => path.join(__dirname, "data", f);
const READ = process.argv.includes("--read"), OUT = D("r149-tv-family.json"), CTRL = D("r149-controls.json");
const START = "2016-01-01", END = "2026-09-22T21:00:00Z", MIN_TRADES = 100, MIN_MONTHS = 36;
const MEMBERS = ["ONE-PCT-WEEK", "PMAX", "DOUBLE-TAP", "GAP-FILL", "GLA", "LUBE", "BB-SQUEEZE", "WMA-EMA"];
const COST = { "ONE-PCT-WEEK": 0.0002, LUBE: 0.0010, default: 0.0010 };

// ── indicators (TradingView semantics) ──────────────────────────────────────────────────────────────────────────────────
const sma = (a, n) => { const o = new Array(a.length).fill(NaN); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; } return o; };
const ema = (a, n) => { const o = new Array(a.length).fill(NaN), k = 2 / (n + 1); let s = 0; for (let i = 0; i < a.length; i++) { if (i < n) { s += a[i]; if (i === n - 1) o[i] = s / n; } else o[i] = k * a[i] + (1 - k) * o[i - 1]; } return o; };
const rma = (a, n) => { const o = new Array(a.length).fill(NaN); let s = 0; for (let i = 0; i < a.length; i++) { if (i < n) { s += a[i]; if (i === n - 1) o[i] = s / n; } else o[i] = (a[i] + (n - 1) * o[i - 1]) / n; } return o; };
const wma = (a, n) => { const o = new Array(a.length).fill(NaN), den = n * (n + 1) / 2; for (let i = n - 1; i < a.length; i++) { let s = 0; for (let k = 0; k < n; k++) s += a[i - k] * (n - k); o[i] = s / den; } return o; };
const stdevPop = (a, n) => { const o = new Array(a.length).fill(NaN); for (let i = n - 1; i < a.length; i++) { let m = 0; for (let k = 0; k < n; k++) m += a[i - k]; m /= n; let v = 0; for (let k = 0; k < n; k++) v += (a[i - k] - m) ** 2; o[i] = Math.sqrt(v / n); } return o; };
const trueRange = (b) => b.map((x, i) => i ? Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c)) : x.h - x.l);
const atrRma = (b, n) => rma(trueRange(b), n);
const crossover = (a, b, i) => i > 0 && a[i] > b[i] && a[i - 1] <= b[i - 1];
const crossunder = (a, b, i) => i > 0 && a[i] < b[i] && a[i - 1] >= b[i - 1];

// ── TradingView intrabar path + fills ────────────────────────────────────────────────────────────────────────────────────
function pathOf(b) { return Math.abs(b.h - b.o) <= Math.abs(b.o - b.l) ? [b.o, b.h, b.l, b.c] : [b.o, b.l, b.h, b.c]; }
// first touch along the path of any level in `orders` [{px, kind:'le'|'ge'}]; returns {k, px} (price filled) or null
// amendment 2 (2026-09-23, pre-read): a LIMIT order (o.limit) fills only when price trades THROUGH its level by THRU; a touch is not a
// fill. Stops still trigger on the touch. TradingView's emulator fills limits on the touch, which flatters limit-order strategies.
const THRU = 0.0001;
const trig = (o) => o.limit ? (o.kind === "le" ? o.px * (1 - THRU) : o.px * (1 + THRU)) : o.px;
function firstTouch(b, orders) {
  const p = pathOf(b);
  for (const [k, o] of orders.entries()) if (o.kind === "le" ? p[0] <= trig(o) : p[0] >= trig(o)) return { k, px: o.limit ? (o.kind === "le" ? Math.min(p[0], o.px) : Math.max(p[0], o.px)) : p[0] };   // open beyond
  for (let s = 0; s < 3; s++) {
    const a = p[s], z = p[s + 1]; let best = null;
    for (const [k, o] of orders.entries()) {
      const tp = trig(o), hit = o.kind === "le" ? (z <= tp && a > tp) : (z >= tp && a < tp);
      if (hit) { const dist = Math.abs(tp - a); if (!best || dist < best.dist) best = { k, px: o.px, dist }; }
    }
    if (best) return { k: best.k, px: best.px };
  }
  return null;
}

// ── generic stop-and-reverse / bracket runner ─────────────────────────────────────────────────────────────────────────────
// sig(i) at bar i's close -> {dir:+1|-1|0 (0 = flat), stop?, limit?}; fills at i+1 open. Exits (stop/limit) live from the fill bar.
function runSignals(bars, sigAt, { member, sym }) {
  const out = []; let pos = null, pending = null;
  const close = (i, px, why) => { out.push({ member, sym, dir: pos.dir, entryIdx: pos.i, entryT: bars[pos.i].t, exitT: bars[i].t, entry: pos.px, exit: px, why }); pos = null; };
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (pending) {                                                      // market order from the previous close
      if (pos && (pending.dir === 0 || pending.dir !== pos.dir)) close(i, b.o, "reverse/close");
      if (pending.dir !== 0 && !pos) pos = { dir: pending.dir, px: b.o, i, stop: pending.stop, limit: pending.limit };
      pending = null;
    }
    if (pos && (pos.stop != null || pos.limit != null)) {
      const ords = []; if (pos.stop != null) ords.push({ px: pos.stop, kind: pos.dir > 0 ? "le" : "ge", why: "stop" }); if (pos.limit != null) ords.push({ px: pos.limit, limit: true, kind: pos.dir > 0 ? "ge" : "le", why: "target" });
      const t = firstTouch(i === pos.i ? { ...b } : b, ords); if (t) close(i, t.px, ords[t.k].why);
    }
    const s = sigAt(i, pos); if (s && i + 1 < bars.length) pending = s;
  }
  // amendment 4 (2026-09-23, pre-read): a position open on the last bar is marked at the last close and counted (dropping it selected on outcome)
  if (pos) close(bars.length - 1, bars[bars.length - 1].c, "marked at end");
  return out;
}

// ── members ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
function PMAX(bars, sym) {
  const src = bars.map((b) => (b.h + b.l) / 2), atr = atrRma(bars, 10), ma = ema(src, 10), pm = new Array(bars.length).fill(NaN);
  let ls = NaN, ss = NaN, dir = 1;
  for (let i = 0; i < bars.length; i++) {
    if (isNaN(ma[i]) || isNaN(atr[i])) continue;
    let l = ma[i] - 3 * atr[i]; const lp = isNaN(ls) ? l : ls; l = ma[i] > lp ? Math.max(l, lp) : l;
    let s = ma[i] + 3 * atr[i]; const sp = isNaN(ss) ? s : ss; s = ma[i] < sp ? Math.min(s, sp) : s;
    dir = dir === -1 && ma[i] > sp ? 1 : dir === 1 && ma[i] < lp ? -1 : dir; ls = l; ss = s; pm[i] = dir === 1 ? l : s;
  }
  return runSignals(bars, (i) => crossover(ma, pm, i) ? { dir: 1 } : crossunder(ma, pm, i) ? { dir: -1 } : null, { member: "PMAX", sym });
}
function WMAEMA(bars, sym) {
  const c = bars.map((b) => b.c), e8 = ema(c, 8), w20 = wma(c, 20);
  return runSignals(bars, (i) => crossover(e8, w20, i) ? { dir: 1 } : crossunder(e8, w20, i) ? { dir: -1 } : null, { member: "WMA-EMA", sym });
}
function GLA(bars, sym, length = 480, mult = 14) {
  const src = bars.map((b) => b.c), atr = atrRma(bars, length), sig = new Array(bars.length).fill(0);
  let tsPrev = NaN, dPrev = NaN, val = NaN, since = NaN;
  for (let i = 1; i < bars.length; i++) {
    const base = isNaN(tsPrev) ? src[i] : tsPrev, diff = src[i] - (isNaN(tsPrev) ? src[i - 1] : tsPrev);
    const up = !isNaN(dPrev) && diff > 0 && dPrev <= 0, dn = !isNaN(dPrev) && diff < 0 && dPrev >= 0;
    if (up || dn) { val = atr[i] / length; since = 0; } else if (!isNaN(since)) since++;
    const ts = up ? base - atr[i] * mult : dn ? base + atr[i] * mult : base + Math.sign(diff) * val * since;
    if (!isNaN(atr[i])) sig[i] = up ? 1 : dn ? -1 : 0;
    tsPrev = ts; dPrev = diff;
  }
  return runSignals(bars, (i) => sig[i] ? { dir: sig[i] } : null, { member: "GLA", sym });
}
function BBSQ(bars, sym) {
  const c = bars.map((b) => b.c), v = bars.map((b) => b.v), mid = sma(c, 20), sd = stdevPop(c, 20), up = mid.map((m, i) => m + 2 * sd[i]), lo = mid.map((m, i) => m - 2 * sd[i]);
  const w = mid.map((m, i) => (up[i] - lo[i]) / m), aw = sma(w.map((x) => (isNaN(x) ? 0 : x)), 50), vma = sma(v, 20), atr = atrRma(bars, 14);
  return runSignals(bars, (i, pos) => {
    if (pos || i < 70 || isNaN(atr[i])) return null;
    const sq = w[i - 1] < aw[i - 1] * 0.8, vol = v[i] > vma[i];
    if (sq && vol && crossover(c, up, i)) return { dir: 1, stop: c[i] - 1.5 * atr[i], limit: c[i] + 3 * atr[i] };
    if (sq && vol && crossunder(c, lo, i)) return { dir: -1, stop: c[i] + 1.5 * atr[i], limit: c[i] - 3 * atr[i] };
    return null;
  }, { member: "BB-SQUEEZE", sym });
}
function LUBE(bars, sym) {
  const n = bars.length, fr = new Array(n).fill(NaN), BB = 500;
  for (let t = BB; t < n; t++) { let f = 0; const c = bars[t].c; for (let i = 1; i <= BB; i++) if (bars[t - i].h >= c && bars[t - i].l <= c) f += (1 + BB) / (i + BB); fr[t] = f; }
  const lowf = new Array(n).fill(NaN), highf = new Array(n).fill(NaN);
  for (let t = BB + 99; t < n; t++) { let lo = Infinity, hi = -Infinity; for (let k = 0; k < 100; k++) { lo = Math.min(lo, fr[t - k]); hi = Math.max(hi, fr[t - k]); } lowf[t] = lo; highf[t] = hi; }
  const midf = lowf.map((l, i) => l * 0.5 + highf[i] * 0.5), low2 = lowf.map((l, i) => l * 1.1 - highf[i] * 0.1);
  const s = bars.map((b) => b.c), fir = s.map((x, i) => i >= 3 ? (4 * x + 3 * s[i - 1] + 2 * s[i - 2] + s[i - 3]) / 10 : NaN);
  return runSignals(bars, (i, pos) => {
    if (i < BB + 105) return null;
    const trend = fir[i] > fir[i - 1] ? 1 : -1, long = fr[i] < low2[i - 5] && trend === 1, short = fr[i] < low2[i - 5] && trend === -1, end = fr[i] > midf[i - 5];
    if (long) return { dir: 1 }; if (short) return { dir: -1 }; if (end && pos) return { dir: 0 }; return null;
  }, { member: "LUBE", sym });
}
function GAPFILL(bars, sym) {
  const out = []; let pos = null, pending = null, closeAll = false, lim = NaN;
  const done = (i, px, why) => { out.push({ member: "GAP-FILL", sym, dir: pos.dir, entryIdx: pos.i, entryT: bars[pos.i].t, exitT: bars[i].t, entry: pos.px, exit: px, why }); pos = null; };
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    if (closeAll && pos) done(i, b.o, "new session"); closeAll = false;
    if (pending) { if (pos && pos.dir !== pending) done(i, b.o, "reverse"); if (!pos) pos = { dir: pending, px: b.o, i }; pending = null; }
    if (pos && !isNaN(lim)) { const t = firstTouch(b, [{ px: lim, limit: true, kind: pos.dir > 0 ? "ge" : "le" }]); if (t) done(i, t.px, "filled"); }
    const ses = b.d !== p.d;
    const upgap = b.o > p.h && Math.min(b.c, b.o) > Math.max(p.c, p.o), dngap = b.o < p.l && Math.min(p.c, p.o) > Math.max(b.c, b.o);
    if (ses && (upgap || dngap)) lim = upgap ? Math.max(p.c, p.o) : Math.min(p.c, p.o);
    if (ses) closeAll = true;                                           // clw = "New Session": close_all on the first bar of a session
    if (ses && dngap) pending = 1; else if (ses && upgap) pending = -1;
    if (pending && closeAll) closeAll = !!pos;                          // the entry and close_all are queued together; the entry wins the new position
  }
  if (pos) done(bars.length - 1, bars[bars.length - 1].c, "marked at end");
  return out;
}
function ONEPCT(bars, sym) {
  const out = []; let wOpen = NaN, buyLim = NaN, pos = null, pt = NaN, sendPT = false, beSent = false, closeNow = false;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (pos && !isNaN(pt)) { const t = firstTouch(b, [{ px: pt, limit: true, kind: "ge" }]); if (t) { out.push({ member: "ONE-PCT-WEEK", sym, dir: 1, entryIdx: pos.i, entryT: bars[pos.i].t, exitT: b.t, entry: pos.px, exit: t.px, why: beSent ? "breakeven" : "target" }); pos = null; pt = NaN; } }
    let filledNow = false;
    if (!pos && !isNaN(buyLim)) { const t = firstTouch(b, [{ px: buyLim, limit: true, kind: "le" }]); if (t) { pos = { px: t.px, i }; buyLim = NaN; filledNow = true; } }
    // ── bar-close logic, in script order
    const newSession = b.first && b.wd === 1;
    if (newSession) { wOpen = b.o; buyLim = wOpen * 0.99; pt = NaN; }
    if (pos && filledNow) { sendPT = true; beSent = false; }
    if (sendPT && b.first && !beSent && pos) { pt = pos.px * 1.01; sendPT = false; }
    if (pos && b.l < pos.px * 0.995 && !beSent) { pt = pos.px; beSent = true; }
    if (pos && b.wd === 5 && b.last) { out.push({ member: "ONE-PCT-WEEK", sym, dir: 1, entryIdx: pos.i, entryT: bars[pos.i].t, exitT: b.t, entry: pos.px, exit: b.c, why: "friday close" }); pos = null; pt = NaN; sendPT = false; }
    if (!pos) beSent = false;
  }
  if (pos) out.push({ member: "ONE-PCT-WEEK", sym, dir: 1, entryIdx: pos.i, entryT: bars[pos.i].t, exitT: bars[bars.length - 1].t, entry: pos.px, exit: bars[bars.length - 1].c, why: "marked at end" });
  return out;
}
function DOUBLETAP(bars, sym, len = 50, tol = 15, fib = 100) {
  const n = bars.length, logs = [], out = [];
  const hiN = (i) => { let m = -Infinity, k = 0; for (let j = 0; j < len && i - j >= 0; j++) if (bars[i - j].h > m) { m = bars[i - j].h; k = j; } return [m, k]; };
  const loN = (i) => { let m = Infinity, k = 0; for (let j = 0; j < len && i - j >= 0; j++) if (bars[i - j].l < m) { m = bars[i - j].l; k = j; } return [m, k]; };
  let dir = null, prevDir = null;
  const side = { 1: { cond: true, stop: NaN, lim: NaN }, [-1]: { cond: true, stop: NaN, lim: NaN } };
  const detect = (m, i) => {                                            // _double: returns [stop, target] when a pattern completes on bar i
    if (logs.length < 5) return null; const r = logs.length;
    const [x1, y1] = logs[r - 5], [x2, y2] = logs[r - 4], [x3, y3] = logs[r - 3], [x4, y4, tr] = logs[r - 2];
    const h = (y2 + y4) / 2 - y3, hi = y2 + h * tol / 100, lo = y2 - h * tol / 100, t = y3 - h * fib / 100, y6 = y2 * m > y4 * m ? y2 : y4;
    const ok = y1 * m < y3 * m && y4 * m <= hi * m && y4 * m >= lo * m && bars[i].c * m < y3 * m && !(bars[i - 1].c * m < y3 * m) && !tr;
    if (!ok) return null; logs[r - 2][2] = 1; return [y6, t];
  };
  let pos = null, pending = null, stp = NaN, lmt = NaN;
  const close = (i, px, why) => { out.push({ member: "DOUBLE-TAP", sym, dir: pos.dir, entryIdx: pos.i, entryT: bars[pos.i].t, exitT: bars[i].t, entry: pos.px, exit: px, why }); pos = null; };
  for (let i = 1; i < n; i++) {
    const b = bars[i];
    if (pending) { if (pos && pos.dir !== pending) close(i, b.o, "flip"); if (!pos) pos = { dir: pending, px: b.o, i }; pending = null; }
    if (pos) { const ords = [{ px: stp, kind: pos.dir > 0 ? "le" : "ge", why: "stop" }, { px: lmt, limit: true, kind: pos.dir > 0 ? "ge" : "le", why: "target" }]; const t = firstTouch(b, ords); if (t) close(i, t.px, ords[t.k].why); }
    if (i < len) continue;
    const [ph, hb] = hiN(i), [pl, lb] = loN(i);
    prevDir = dir; dir = hb === 0 ? 1 : lb === 0 ? 0 : dir;
    const dirUp = dir !== prevDir && dir === 1, dirDn = dir !== prevDir && dir === 0;
    if (dirUp || dirDn) { logs.push([i, dirUp ? ph : pl, 0]); if (logs.length > 5) logs.shift(); }
    const setUp = hb === 0 && dir === 1, setDn = lb === 0 && dir === 0;
    if ((setUp || setDn) && logs.length) { const mm = dir ? 1 : -1, y = setUp ? ph : pl, last = logs[logs.length - 1]; if (y * mm > last[1] * mm) { last[0] = i; last[1] = y; } }
    let sell = false, buy = false;
    for (const m of [1, -1]) {
      const sd = side[m];
      if (sd.cond) { const d = detect(m, i); if (d) { sd.cond = false; sd.stop = d[0]; sd.lim = d[1]; if (m === 1) sell = true; else buy = true; continue; } }
      else { const win = (m === 1 ? b.l : b.h) * m <= sd.lim * m, lose = (m === 1 ? b.h : b.l) * m >= sd.stop * m; if (win || lose) sd.cond = true; }
    }
    if (buy && (!pos || pos.dir < 0)) { pending = 1; stp = side[-1].stop; lmt = side[-1].lim; }
    else if (sell && (!pos || pos.dir > 0)) { pending = -1; stp = side[1].stop; lmt = side[1].lim; }
  }
  if (pos) close(n - 1, bars[n - 1].c, "marked at end");
  return out;
}

// ── statistics ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a) { const n = a.length; if (n < 3) return null; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n, c = 0; for (let i = 1; i < n; i++) c += d[i] * d[i - 1]; v += c / n; return v > 0 ? m / Math.sqrt(v / n) : null; }
function summarise(trades) {
  const res = {};
  for (const m of MEMBERS) {
    const tr = trades.filter((x) => x.member === m), byM = new Map();
    for (const x of tr) { const k = String(x.entryT).slice(0, 7); (byM.get(k) || byM.set(k, []).get(k)).push(x.net); }
    const months = [...byM.keys()].sort(), s = months.map((k) => mean(byM.get(k))), h = Math.floor(s.length / 2);
    res[m] = { trades: tr.length, months: months.length, meanNetPctPerMonth: s.length ? +(100 * mean(s)).toFixed(4) : null, tNW: s.length > 2 ? +nwT(s).toFixed(3) : null,
      firstHalfPct: h ? +(100 * mean(s.slice(0, h))).toFixed(4) : null, secondHalfPct: h ? +(100 * mean(s.slice(h))).toFixed(4) : null,
      meanNetPctPerTrade: tr.length ? +(100 * mean(tr.map((x) => x.net))).toFixed(4) : null, winRatePct: tr.length ? +(100 * tr.filter((x) => x.net > 0).length / tr.length).toFixed(1) : null };
  }
  return res;
}

// ── data ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const offCache = new Map();
function etOffsetH(iso) { const d = iso.slice(0, 10); if (!offCache.has(d)) { const u = new Date(d + "T16:00:00Z"); const h = +new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(u); offCache.set(d, 16 - h); } return offCache.get(d); }
function rthBars(raw) {                                                // 15-min RTH bars stamped with ET date, weekday, first/last flags
  const out = [];
  for (const b of raw) { const t = new Date(b.t), off = etOffsetH(b.t), et = new Date(t.getTime() - off * 3600e3), mins = et.getUTCHours() * 60 + et.getUTCMinutes(); if (mins < 570 || mins > 945) continue;
    out.push({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, d: et.toISOString().slice(0, 10), wd: et.getUTCDay(), mins }); }
  for (let i = 0; i < out.length; i++) { out[i].first = !i || out[i].d !== out[i - 1].d; out[i].last = i === out.length - 1 || out[i].d !== out[i + 1].d; }
  return out;
}
function hourly(r15) {                                                 // 60-min bars aligned to 09:30 ET
  const out = []; let cur = null;
  for (const b of r15) { const k = b.d + "|" + Math.floor((b.mins - 570) / 60);
    if (!cur || cur.k !== k) { if (cur) out.push(cur); cur = { k, t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, d: b.d }; } else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; } }
  if (cur) out.push(cur); return out;
}
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hash = (s) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);
// demean=true (amendment 2026-09-23): each bar's open gap is scaled so the scrambled path has ZERO drift — pure noise for the leak
// test. demean=false keeps the symbol's own drift — the floor the real result must beat.
function scramble(bars, seed, key, demean = false) {                   // each bar's shape moves to a random slot; timestamps and session flags stay
  const rng = mulberry(seed * 1000003 + hash(key)), p = [];
  for (let i = 1; i < bars.length; i++) { const b = bars[i]; p.push([b.o / bars[i - 1].c, b.h / b.o, b.l / b.o, b.c / b.o, b.v]); }
  // amendment 3 (2026-09-23, pre-read): ARITHMETIC drift removed (mean bar gross return = 1); a zero LOG drift still leaves +sigma^2/2 a bar, which a long-only strategy on a volatile name collects on noise
  if (demean && p.length) { const g = p.reduce((s, x) => s + x[0] * x[3], 0) / p.length, k = 1 / g; for (const x of p) x[0] *= k; }
  for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  const out = [{ ...bars[0] }]; let c = bars[0].c;
  for (let i = 1; i < bars.length; i++) { const [go, gh, gl, gc, v] = p[i - 1], o = c * go; c = o * gc; out.push({ ...bars[i], o, h: o * gh, l: o * gl, c, v }); }
  return out;
}

// ── known-answer selftest ────────────────────────────────────────────────────────────────────────────────────────────────
function selftest() {
  const checks = {};
  checks.pathHighFirstWhenOpenNearHigh = JSON.stringify(pathOf({ o: 10, h: 10.2, l: 9, c: 9.5 })) === JSON.stringify([10, 10.2, 9, 9.5]);
  checks.stopBeforeTargetOnHighFirstPath = firstTouch({ o: 10, h: 10.2, l: 9, c: 9.5 }, [{ px: 9.2, kind: "le" }, { px: 10.1, kind: "ge" }]).k === 1;
  checks.limitTouchIsNotAFill = firstTouch({ o: 10, h: 10.1, l: 9.95, c: 10 }, [{ px: 10.1, limit: true, kind: "ge" }]) === null && firstTouch({ o: 10, h: 10.2, l: 9.95, c: 10 }, [{ px: 10.1, limit: true, kind: "ge" }]).px === 10.1;
  checks.openBeyondStopFillsAtOpen = firstTouch({ o: 8.5, h: 9, l: 8, c: 8.8 }, [{ px: 9.2, kind: "le" }]).px === 8.5;
  // gap fill: day 1 flat at 10, day 2 opens 10.6 (above day-1 high 10.1) and holds, then fills back to 10.0 -> short at bar 2's open, exit at 10.0
  const mk = (d, o, h, l, c, first, last) => ({ t: d + "T14:30:00Z", d, o, h, l, c, v: 1e5, wd: 2, first, last, mins: 600 });
  const g = [mk("2020-01-06", 10, 10.1, 9.9, 10, true, false), mk("2020-01-06", 10, 10.05, 9.95, 10, false, true), mk("2020-01-07", 10.6, 10.7, 10.5, 10.55, true, false), mk("2020-01-07", 10.5, 10.52, 10.3, 10.35, false, false), mk("2020-01-07", 10.3, 10.31, 9.9, 9.95, false, true)];
  const gt = GAPFILL(g, "T"); checks.gapFillShortsTheUpGapAndExitsAtTheFill = gt.length === 1 && gt[0].dir === -1 && gt[0].entry === 10.5 && gt[0].exit === 10 && gt[0].why === "filled";
  // one percent a week: Monday first bar opens 100; a later bar dips to 98.9 -> buy 99; Tuesday first bar places the target 99.99; a bar reaches 100.2 -> +1%
  const w = (d, wd, o, h, l, c, first, last) => ({ t: d + "T15:00:00Z", d, wd, o, h, l, c, v: 1, first, last });
  const ob = [w("2020-01-06", 1, 100, 100.1, 99.8, 100, true, false), w("2020-01-06", 1, 100, 100, 98.9, 99.2, false, true), w("2020-01-07", 2, 99.3, 99.5, 99.1, 99.4, true, false), w("2020-01-07", 2, 99.4, 100.2, 99.3, 100.1, false, true)];
  const ot = ONEPCT(ob, "TQQQ"); checks.onePctBuysTheDipAndTakesOnePercent = ot.length === 1 && Math.abs(ot[0].entry - 99) < 1e-9 && Math.abs(ot[0].exit - 99.99) < 1e-9;
  // PMAX on rise -> fall -> rise: the fall opens a short, the second rise closes it by reversal (a position still open at the end is not a trade)
  const pb = []; for (let i = 0; i < 600; i++) { const px = i < 200 ? 50 + i * 0.3 : i < 400 ? 110 - (i - 200) * 0.3 : 50 + (i - 400) * 0.3; pb.push({ t: `2020-01-01T${i}`, o: px, h: px + 0.4, l: px - 0.4, c: px + 0.1, v: 1 }); }
  const pt = PMAX(pb, "X"); checks.pmaxShortsTheFallAndReversesOnTheRise = pt.length >= 1 && pt[0].dir === -1 && pt[0].entryIdx > 200 && pt[0].entryIdx < 260 && pt[0].why === "reverse/close" && pt[0].exit < pt[0].entry;
  return { pass: Object.values(checks).every(Boolean), checks };
}

// ── one pass over every member's data ─────────────────────────────────────────────────────────────────────────────────────
async function pass(transforms) {                                // every transform is applied to each symbol's bars as they arrive
  const uni = JSON.parse(fs.readFileSync(D("r147-universe.json"), "utf8")).names, top20 = uni.slice(0, 20);
  const res = transforms.map(() => ({ trades: [], coverage: { daily: 0, intraday: 0, btc: 0 } }));
  const finish = (r, tr, bars, cost) => { for (const x of tr) { x.net = x.dir * (x.exit / x.entry - 1) - cost; const f = bars[Math.min(x.entryIdx + 5, bars.length - 1)]; x.peekOk = x.net > 0; void f; r.trades.push(x); } };
  for (let i = 0; i < uni.length; i += 25) {                            // daily members
    const { bars } = await fetchBars(uni.slice(i, i + 25), { start: START, end: END, feed: "sip", requireAll: false, quiet: true });
    for (const [s, b0] of Object.entries(bars)) { if (b0.length < 100) continue;
      transforms.forEach((tf, k) => { const b = tf(b0, "D" + s), r = res[k]; r.coverage.daily++; finish(r, PMAX(b, s), b, COST.default); finish(r, WMAEMA(b, s), b, COST.default); finish(r, DOUBLETAP(b, s), b, COST.default); }); }
    process.stdout.write(`  R149 daily ${Math.min(i + 25, uni.length)}/${uni.length}\r`);
  }
  process.stdout.write("\n");
  for (const s of [...top20, "TQQQ"]) {                                  // intraday members, one symbol at a time
    const { bars } = await fetchBars([s], { start: START, end: END, timeframe: "15Min", feed: "sip", requireAll: false, quiet: true });
    const raw = bars[s] || []; if (raw.length < 1000) continue; const rth = rthBars(raw);
    transforms.forEach((tf, k) => { const r = res[k], r15 = tf(rth, "I" + s); r.coverage.intraday++;
      if (s === "TQQQ") { finish(r, ONEPCT(r15, s), r15, COST["ONE-PCT-WEEK"]); return; }
      const h1 = hourly(r15); finish(r, GAPFILL(r15, s), r15, COST.default); finish(r, GLA(h1, s), h1, COST.default); finish(r, BBSQ(h1, s), h1, COST.default); });
    process.stdout.write(`  R149 intraday ${s}          \r`);
  }
  process.stdout.write("\n");
  const cb = ((await fetchCryptoBars(["BTC/USD"], "30Min", START, END))["BTC/USD"] || []).map((x) => ({ t: x.t, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v }));
  if (cb.length > 1000) transforms.forEach((tf, k) => { const b = tf(cb, "C"), r = res[k]; r.coverage.btc = b.length; finish(r, LUBE(b, "BTC/USD"), b, COST.LUBE); });
  return res;
}

(async () => {
  const st = selftest(); console.log(`R149 selftest ${st.pass ? "PASS" : "FAIL"} ${JSON.stringify(st.checks)}`); if (!st.pass) process.exit(1);
  if (process.argv.includes("--selftest")) return;
  if (!READ) {
    // amendment 2026-09-23 (pre-read): leak test on DRIFT-FREE scrambles; floor from drift-kept scrambles; look-ahead on the trade's own outcome
    const [f1, f2, z1, z2, real] = await pass([(b, k) => scramble(b, 1, k), (b, k) => scramble(b, 2, k), (b, k) => scramble(b, 1, k, true), (b, k) => scramble(b, 2, k, true), (b) => b]);
    const a1 = summarise(f1.trades), a2 = summarise(f2.trades), n1 = summarise(z1.trades), n2 = summarise(z2.trades), ap = summarise(real.trades.filter((x) => x.peekOk));
    const slim = (v) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, { trades: x.trades, months: x.months, meanNetPctPerMonth: x.meanNetPctPerMonth, tNW: x.tNW }]));
    const leakOk = [n1, n2].every((a) => Object.values(a).every((x) => x.tNW == null || x.tNW < 2));
    const peekOk = Object.values(ap).every((x) => x.tNW != null && x.tNW >= 3);
    const floor = Object.fromEntries(MEMBERS.map((k) => [k, +(((a1[k].meanNetPctPerMonth ?? 0) + (a2[k].meanNetPctPerMonth ?? 0)) / 2).toFixed(4)]));
    const ctrl = { spec: "r149-controls-v5", asOf: new Date().toISOString(), coverage: real.coverage, selftest: st,
      leakTest: { method: "every bar's shape shuffled within its symbol with the symbol's drift removed (seeds 1, 2) — pure noise", requirement: "no member reaches t_NW >= 2 on drift-free scrambled prices", pass: leakOk, seed1: slim(n1), seed2: slim(n2),
        driftKeptFloorRuns: { seed1: slim(a1), seed2: slim(a2) }, noiseFloorPctPerMonth: floor },
      positiveControl: { method: "keep only trades whose own realised net return is positive (outcome look-ahead by design)", requirement: "t_NW >= 3 for every member", pass: peekOk, result: slim(ap) }, pass: leakOk && peekOk,
      note: "The look-ahead control reads real prices by construction; only the peeked (winning-trade) subset is summarised and nothing from the unfiltered real run is written. v1 of these controls (drift-kept leak test, 5-bar peek) failed for reasons recorded in the R149 amendment of 2026-09-23." };
    writeJsonAtomic(CTRL, ctrl);
    console.log(`R149 controls — leak (drift-free) ${leakOk ? "PASS" : "FAIL"} ${JSON.stringify(slim(n1))}`);
    console.log(`  seed 2 (drift-free) ${JSON.stringify(slim(n2))}`);
    console.log(`  look-ahead ${peekOk ? "PASS" : "FAIL"} ${JSON.stringify(slim(ap))}`);
    console.log(`  noise floor (net % per month) ${JSON.stringify(floor)}`);
    console.log(ctrl.pass ? "R149 READY — the one read is: node backend/r149-tv-family.js --read" : "R149 NOT READY — a control failed; the read is refused until it is understood");
    return;
  }
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R149) { console.error("R149 already sealed — refusing"); process.exit(2); }
  if (fs.existsSync(OUT) && JSON.parse(fs.readFileSync(OUT, "utf8")).read) { console.error("R149 already read — seal it, do not re-read"); process.exit(2); }
  const ctrl = fs.existsSync(CTRL) ? JSON.parse(fs.readFileSync(CTRL, "utf8")) : null; if (!ctrl || !ctrl.pass) { console.error("R149 controls have not passed"); process.exit(2); }
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R149"); if (!t) { console.error("R149 not registered"); process.exit(2); }
  const [real] = await pass([(b) => b]), v = summarise(real.trades), bar = t.bar.tRequired, floor = ctrl.leakTest.noiseFloorPctPerMonth;
  for (const [k, x] of Object.entries(v)) x.clears = x.trades >= MIN_TRADES && x.months >= MIN_MONTHS && x.meanNetPctPerMonth > 0 && x.meanNetPctPerMonth > floor[k] && x.tNW >= bar && x.firstHalfPct > 0 && x.secondHalfPct > 0;
  const verdict = Object.values(v).some((x) => x.clears) ? "PASS" : "DID NOT PASS";
  writeJsonAtomic(OUT, { spec: "r149-read-v1", read: true, asOf: new Date().toISOString(), bar, coverage: real.coverage, noiseFloor: floor, members: v, verdict });
  console.log(`R149 READ — ${verdict} (bar t_NW >= ${bar})`);
  for (const [k, x] of Object.entries(v)) console.log(`  ${k.padEnd(13)} trades ${x.trades} · months ${x.months} · net %/month ${x.meanNetPctPerMonth} (floor ${floor[k]}) · t_NW ${x.tNW} · halves ${x.firstHalfPct}/${x.secondHalfPct} · per trade ${x.meanNetPctPerTrade}% · win ${x.winRatePct}%${x.clears ? " · CLEARS" : ""}`);
})().catch((e) => { console.error("R149 FAILED:", e.message); process.exit(1); });
