#!/usr/bin/env node
/**
 * R150 — THE TRADINGVIEW CLASSICS (2026-09-23). Operator: "register the classics as R150", after the all-time top-50 by boosts
 * (docs/TradingView_Top50_2026-09-23.md). Seven rule-bearing classics, each translated from the published open-source code at its
 * DEFAULT inputs — the author's own strategy version where one exists — and run on DAILY bars of the 100 names in data/r147-universe.json:
 *
 *   SQUEEZE     "Strategy based on Squeeze Momentum Indicator [LazyBear]" (03.freeman) — BB(14, 2) inside KC(16, 1.5 x TR) squeeze;
 *               long when the squeeze releases (aqua) with momentum lime, close on green; short mirror (red / maroon). The #1 script
 *               (LazyBear's indicator, 116k boosts) defines no trades; this is its most-boosted strategy form. Its default 2018-only
 *               backtest window is a date filter, not a rule, and is not applied.
 *   UT-BOT      "UT Bot Alerts" (QuantNomad, 58.7k) — ATR(10) x 1 trailing stop; its own UT Long / UT Short alerts, stop-and-reverse
 *   PPST        "Pivot Point SuperTrend [Backtest]" (LonesomeTheBlue) — pivots (2, 2), centre line, ATR(10) x 3; reverse on trend change
 *   ALPHATREND  "AlphaTrend Strategy" (KivancOzbilgic) — period 14, multiplier 1, MFI >= 50 selects the up-line; AT crosses AT[2]
 *   RSI-2       "CM RSI-2 Strategy Lower Indicator" (ChrisMoody, Connors) — long: close > SMA200, close < SMA5, RSI(2) < 10;
 *               short: close < SMA200, close > SMA5, RSI(2) > 90; exit when the close crosses back over SMA5 (Connors' exit)
 *   OTT         "Optimized Trend Tracker STRATEGY & SCREENER" (KivancOzbilgic) — VAR(2), 1.4%; MAvg crosses OTT[2], stop-and-reverse
 *   TURTLE      "Turtle Trade Channels Indicator TUTCI" (KivancOzbilgic) — 20-bar breakout entries, 10-bar exits, as its signals
 *
 * LazyBear's WaveTrend (#5) is NOT a member: its code plots lines and no signals, and its most-boosted strategy form (Noro's) is
 * unpublished — testing it would mean inventing the trade.
 *
 * EXECUTION and STATISTIC as R149: TradingView broker-emulator semantics (signal at the close, market fill at the next open);
 * 0.10% round trip; unit = calendar MONTH of entry, mean net % per trade entered that month, Newey-West lag 1.
 * CONTROLS (R149's amended design, from the start): leak test on DRIFT-FREE scrambles (no member t_NW >= 2); floor from drift-KEPT
 * scrambles (the real mean must beat it); positive control = trades whose own realised net return is positive (t_NW >= 3).
 *
 *   node backend/r150-classics.js --selftest | (controls) | --read
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { fetchBars } = require("./lib/alpaca-bars.js");
const D = (f) => path.join(__dirname, "data", f);
const READ = process.argv.includes("--read"), OUT = D("r150-classics.json"), CTRL = D("r150-controls.json");
const START = "2016-01-01", END = "2026-09-22T21:00:00Z", MIN_TRADES = 100, MIN_MONTHS = 36, COST = 0.0010;
const MEMBERS = ["SQUEEZE", "UT-BOT", "PPST", "ALPHATREND", "RSI-2", "OTT", "TURTLE"];

// ── indicators (TradingView semantics; same definitions as R149) ─────────────────────────────────────────────────────────
const sma = (a, n) => { const o = new Array(a.length).fill(NaN); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; } return o; };
const rma = (a, n) => { const o = new Array(a.length).fill(NaN); let s = 0; for (let i = 0; i < a.length; i++) { if (i < n) { s += a[i]; if (i === n - 1) o[i] = s / n; } else o[i] = (a[i] + (n - 1) * o[i - 1]) / n; } return o; };
const stdevPop = (a, n) => { const o = new Array(a.length).fill(NaN); for (let i = n - 1; i < a.length; i++) { let m = 0; for (let k = 0; k < n; k++) m += a[i - k]; m /= n; let v = 0; for (let k = 0; k < n; k++) v += (a[i - k] - m) ** 2; o[i] = Math.sqrt(v / n); } return o; };
const trueRange = (b) => b.map((x, i) => i ? Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c)) : x.h - x.l);
const highest = (a, n, i) => { let m = -Infinity; for (let k = 0; k < n && i - k >= 0; k++) m = Math.max(m, a[i - k]); return m; };
const lowest = (a, n, i) => { let m = Infinity; for (let k = 0; k < n && i - k >= 0; k++) m = Math.min(m, a[i - k]); return m; };
function linreg(a, n) { const o = new Array(a.length).fill(NaN); for (let i = n - 1; i < a.length; i++) { let sx = 0, sy = 0, sxy = 0, sxx = 0; for (let k = 0; k < n; k++) { const x = k, y = a[i - n + 1 + k]; sx += x; sy += y; sxy += x * y; sxx += x * x; } const sl = (n * sxy - sx * sy) / (n * sxx - sx * sx), ic = (sy - sl * sx) / n; o[i] = ic + sl * (n - 1); } return o; }
const cross = (a, b, i) => i > 0 && a[i] > b[i] && a[i - 1] <= b[i - 1];

// ── runner: signal at bar close -> fill at the next open; dir +1/-1 enter/reverse, 0 = flat (close) ──────────────────────────
function run(bars, member, sym, sigAt) {
  const out = []; let pos = null, pending = null;
  for (let i = 0; i < bars.length; i++) {
    if (pending !== null) {
      if (pos && (pending === 0 || pending !== pos.dir)) { out.push({ member, sym, dir: pos.dir, entryIdx: pos.i, entryT: bars[pos.i].t, exitT: bars[i].t, entry: pos.px, exit: bars[i].o }); pos = null; }
      if (pending !== 0 && !pos) pos = { dir: pending, px: bars[i].o, i };
      pending = null;
    }
    const s = sigAt(i, pos); if (s !== null && s !== undefined && i + 1 < bars.length) pending = s;
  }
  return out;
}

// ── members ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
function SQUEEZE(b, sym) {
  const c = b.map((x) => x.c), h = b.map((x) => x.h), l = b.map((x) => x.l), tr = trueRange(b), n = b.length;
  const basis = sma(c, 14), dev = stdevPop(c, 14).map((d) => 2 * d), ma = sma(c, 16), rng = sma(tr, 16), sm16 = sma(c, 16);
  const x = c.map((v, i) => i >= 15 ? v - ((highest(h, 16, i) + lowest(l, 16, i)) / 2 + sm16[i]) / 2 : NaN), val = linreg(x, 16);
  const off = (i) => (basis[i] - dev[i]) < (ma[i] - rng[i] * 1.5) && (basis[i] + dev[i]) > (ma[i] + rng[i] * 1.5);
  const bcol = (i) => val[i] > 0 ? (val[i] > (isNaN(val[i - 1]) ? 0 : val[i - 1]) ? "lime" : "green") : (val[i] < (isNaN(val[i - 1]) ? 0 : val[i - 1]) ? "red" : "maroon");
  return run(b, "SQUEEZE", sym, (i, pos) => {
    if (i < 40 || isNaN(val[i])) return null;
    const release = !off(i - 1) && off(i), bc = bcol(i);
    if (release && bc === "lime") return 1; if (release && bc === "red") return -1;
    if (pos && pos.dir > 0 && bc === "green") return 0; if (pos && pos.dir < 0 && bc === "maroon") return 0; return null;
  });
}
function UTBOT(b, sym) {
  const src = b.map((x) => x.c), atr = rma(trueRange(b), 10), n = b.length, ts = new Array(n).fill(0);
  for (let i = 1; i < n; i++) { const nl = 1 * (isNaN(atr[i]) ? 0 : atr[i]), p = ts[i - 1];
    ts[i] = src[i] > p && src[i - 1] > p ? Math.max(p, src[i] - nl) : src[i] < p && src[i - 1] < p ? Math.min(p, src[i] + nl) : src[i] > p ? src[i] - nl : src[i] + nl; }
  return run(b, "UT-BOT", sym, (i) => { if (i < 12 || isNaN(atr[i])) return null; const above = src[i] > ts[i] && src[i - 1] <= ts[i - 1], below = ts[i] > src[i] && ts[i - 1] <= src[i - 1];
    if (above && src[i] > ts[i]) return 1; if (below && src[i] < ts[i]) return -1; return null; });
}
function PPST(b, sym) {
  const n = b.length, atr = rma(trueRange(b), 10), c = b.map((x) => x.c); let center = NaN, tup = NaN, tdn = NaN, trend = 1; const tr = new Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    const j = i - 2; let pp = NaN;
    if (j >= 2) { const hi = b[j].h, lo = b[j].l; if ([1, 2].every((k) => b[j - k].h < hi && b[j + k].h < hi)) pp = hi; else if ([1, 2].every((k) => b[j - k].l > lo && b[j + k].l > lo)) pp = lo; }
    if (!isNaN(pp)) center = isNaN(center) ? pp : (center * 2 + pp) / 3;
    const up = center - 3 * atr[i], dn = center + 3 * atr[i];
    const ntup = i > 0 && c[i - 1] > tup ? Math.max(up, tup) : up, ntdn = i > 0 && c[i - 1] < tdn ? Math.min(dn, tdn) : dn;
    const t = c[i] > tdn ? 1 : c[i] < tup ? -1 : trend; tup = ntup; tdn = ntdn; trend = isNaN(t) ? trend : t; tr[i] = trend;
  }
  return run(b, "PPST", sym, (i) => (i > 20 && !isNaN(atr[i]) && tr[i] !== tr[i - 1]) ? tr[i] : null);
}
function ALPHATREND(b, sym) {
  const n = b.length, atr = sma(trueRange(b), 14), tp = b.map((x) => (x.h + x.l + x.c) / 3), at = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    let up = 0, dn = 0; for (let k = 0; k < 14 && i - k >= 1; k++) { const d = tp[i - k] - tp[i - k - 1], mf = tp[i - k] * b[i - k].v; if (d > 0) up += mf; else if (d < 0) dn += mf; }
    const mfi = dn === 0 ? 100 : 100 - 100 / (1 + up / dn), upT = b[i].l - atr[i], dnT = b[i].h + atr[i], p = at[i - 1];
    at[i] = isNaN(atr[i]) ? 0 : mfi >= 50 ? (upT < p ? p : upT) : (dnT > p ? p : dnT);
  }
  return run(b, "ALPHATREND", sym, (i, pos) => { if (i < 20) return null;
    if (at[i] > at[i - 2] && at[i - 1] <= at[i - 3]) return pos && pos.dir > 0 ? null : 1;
    if (at[i] < at[i - 2] && at[i - 1] >= at[i - 3]) return pos && pos.dir < 0 ? null : -1; return null; });
}
function RSI2(b, sym) {
  const c = b.map((x) => x.c), ch = c.map((v, i) => i ? v - c[i - 1] : 0), up = rma(ch.map((x) => Math.max(x, 0)), 2), dn = rma(ch.map((x) => -Math.min(x, 0)), 2);
  const rsi = up.map((u, i) => dn[i] === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / dn[i])), m5 = sma(c, 5), m200 = sma(c, 200);
  return run(b, "RSI-2", sym, (i, pos) => { if (isNaN(m200[i])) return null;
    if (pos && pos.dir > 0 && c[i] > m5[i]) return 0; if (pos && pos.dir < 0 && c[i] < m5[i]) return 0;
    if (!pos && c[i] > m200[i] && c[i] < m5[i] && rsi[i] < 10) return 1; if (!pos && c[i] < m200[i] && c[i] > m5[i] && rsi[i] > 90) return -1; return null; });
}
function OTT(b, sym) {
  const src = b.map((x) => x.c), n = b.length, len = 2, pct = 1.4, al = 2 / (len + 1), mav = new Array(n).fill(0), ott = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) { let u = 0, d = 0; for (let k = 0; k < 9 && i - k >= 1; k++) { const x = src[i - k] - src[i - k - 1]; if (x > 0) u += x; else d -= x; }
    const cmo = u + d === 0 ? 0 : (u - d) / (u + d); mav[i] = al * Math.abs(cmo) * src[i] + (1 - al * Math.abs(cmo)) * (i ? mav[i - 1] : 0); }
  let ls = NaN, ss = NaN, dir = 1;
  for (let i = 0; i < n; i++) { const f = mav[i] * pct * 0.01; let l = mav[i] - f; const lp = isNaN(ls) ? l : ls; l = mav[i] > lp ? Math.max(l, lp) : l;
    let s = mav[i] + f; const sp = isNaN(ss) ? s : ss; s = mav[i] < sp ? Math.min(s, sp) : s; dir = dir === -1 && mav[i] > sp ? 1 : dir === 1 && mav[i] < lp ? -1 : dir; ls = l; ss = s;
    const mt = dir === 1 ? l : s; ott[i] = mav[i] > mt ? mt * (200 + pct) / 200 : mt * (200 - pct) / 200; }
  return run(b, "OTT", sym, (i) => { if (i < 30) return null; const o2 = ott[i - 2], o3 = ott[i - 3];
    if (mav[i] > o2 && mav[i - 1] <= o3) return 1; if (mav[i] < o2 && mav[i - 1] >= o3) return -1; return null; });
}
function TURTLE(b, sym) {
  const h = b.map((x) => x.h), l = b.map((x) => x.l);
  return run(b, "TURTLE", sym, (i, pos) => { if (i < 21) return null;
    const up1 = highest(h, 20, i - 1), dn1 = lowest(l, 20, i - 1), sdn1 = lowest(l, 10, i - 1), sup1 = highest(h, 10, i - 1);
    const buy = h[i] >= up1, sell = l[i] <= dn1, bx = l[i] <= sdn1, sx = h[i] >= sup1;
    if (pos && pos.dir > 0) return sell ? -1 : bx ? 0 : null; if (pos && pos.dir < 0) return buy ? 1 : sx ? 0 : null;
    return buy ? 1 : sell ? -1 : null; });
}
const RUN = { SQUEEZE, "UT-BOT": UTBOT, PPST, ALPHATREND, "RSI-2": RSI2, OTT, TURTLE };

// ── statistics / scramble (as R149 v2) ────────────────────────────────────────────────────────────────────────────────────
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a) { const n = a.length; if (n < 3) return null; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n, c = 0; for (let i = 1; i < n; i++) c += d[i] * d[i - 1]; v += c / n; return v > 0 ? m / Math.sqrt(v / n) : null; }
function summarise(trades) { const res = {}; for (const m of MEMBERS) { const tr = trades.filter((x) => x.member === m), byM = new Map();
  for (const x of tr) { const k = String(x.entryT).slice(0, 7); (byM.get(k) || byM.set(k, []).get(k)).push(x.net); }
  const ks = [...byM.keys()].sort(), s = ks.map((k) => mean(byM.get(k))), h = Math.floor(s.length / 2);
  res[m] = { trades: tr.length, months: ks.length, meanNetPctPerMonth: s.length ? +(100 * mean(s)).toFixed(4) : null, tNW: s.length > 2 ? +nwT(s).toFixed(3) : null,
    firstHalfPct: h ? +(100 * mean(s.slice(0, h))).toFixed(4) : null, secondHalfPct: h ? +(100 * mean(s.slice(h))).toFixed(4) : null,
    meanNetPctPerTrade: tr.length ? +(100 * mean(tr.map((x) => x.net))).toFixed(4) : null, winRatePct: tr.length ? +(100 * tr.filter((x) => x.net > 0).length / tr.length).toFixed(1) : null }; } return res; }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hash = (s) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);
function scramble(bars, seed, key, demean = false) {
  const rng = mulberry(seed * 1000003 + hash(key)), p = [];
  for (let i = 1; i < bars.length; i++) { const x = bars[i]; p.push([x.o / bars[i - 1].c, x.h / x.o, x.l / x.o, x.c / x.o, x.v]); }
  if (demean && p.length) { const mu = p.reduce((s, x) => s + Math.log(x[0] * x[3]), 0) / p.length, k = Math.exp(-mu); for (const x of p) x[0] *= k; }
  for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  const out = [{ ...bars[0] }]; let c = bars[0].c;
  for (let i = 1; i < bars.length; i++) { const [go, gh, gl, gc, v] = p[i - 1], o = c * go; c = o * gc; out.push({ ...bars[i], o, h: o * gh, l: o * gl, c, v }); }
  return out;
}

// ── known-answer selftest ────────────────────────────────────────────────────────────────────────────────────────────────
function selftest() {
  const checks = {}, mk = (px, i) => ({ t: new Date(Date.UTC(2017, 0, 1) + i * 864e5).toISOString(), o: px, h: px * 1.004, l: px * 0.996, c: px, v: 1e6 });
  const rf = []; for (let i = 0; i < 700; i++) rf.push(mk(i < 300 ? 50 + i * 0.1 : i < 500 ? 80 - (i - 300) * 0.1 : 60 + (i - 500) * 0.1, i));
  const ut = UTBOT(rf, "X"); checks.utBotGoesShortInTheFallAndReversesOnTheRise = ut.some((t) => t.dir === -1 && t.entryIdx > 295 && t.entryIdx < 330 && t.exit < t.entry);
  const tt = TURTLE(rf, "X"); checks.turtleShortsTheTwentyDayLowBreak = tt.some((t) => t.dir === -1 && t.entryIdx > 300 && t.entryIdx < 340);
  // RSI-2: 250-bar uptrend, then three sharp down closes (RSI2 < 10, close below SMA5, above SMA200), then a rebound above SMA5
  const r = []; for (let i = 0; i < 250; i++) r.push(mk(50 + i * 0.2, i)); for (const px of [96, 93, 90, 92, 97, 99]) r.push(mk(px, r.length));
  const rt = RSI2(r, "X"); checks.rsi2BuysTheDipAboveTheSma200AndExitsAboveTheSma5 = rt.length === 1 && rt[0].dir === 1 && rt[0].exit > rt[0].entry;
  return { pass: Object.values(checks).every(Boolean), checks };
}

async function pass(transforms) {
  const uni = JSON.parse(fs.readFileSync(D("r147-universe.json"), "utf8")).names, res = transforms.map(() => ({ trades: [], priced: 0 }));
  for (let i = 0; i < uni.length; i += 25) {
    const { bars } = await fetchBars(uni.slice(i, i + 25), { start: START, end: END, feed: "sip", requireAll: false, quiet: true });
    for (const [s, b0] of Object.entries(bars)) { if (b0.length < 250) continue;
      transforms.forEach((tf, k) => { const b = tf(b0, s), r = res[k]; r.priced++;
        for (const m of MEMBERS) for (const x of RUN[m](b, s)) { x.net = x.dir * (x.exit / x.entry - 1) - COST; x.peekOk = x.net > 0; r.trades.push(x); } }); }
    process.stdout.write(`  R150 ${Math.min(i + 25, uni.length)}/${uni.length}\r`);
  }
  process.stdout.write("\n"); return res;
}

(async () => {
  const st = selftest(); console.log(`R150 selftest ${st.pass ? "PASS" : "FAIL"} ${JSON.stringify(st.checks)}`); if (!st.pass) process.exit(1);
  if (process.argv.includes("--selftest")) return;
  const slim = (v) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, { trades: x.trades, months: x.months, meanNetPctPerMonth: x.meanNetPctPerMonth, tNW: x.tNW }]));
  if (!READ) {
    const [f1, f2, z1, z2, real] = await pass([(b, k) => scramble(b, 1, k), (b, k) => scramble(b, 2, k), (b, k) => scramble(b, 1, k, true), (b, k) => scramble(b, 2, k, true), (b) => b]);
    const a1 = summarise(f1.trades), a2 = summarise(f2.trades), n1 = summarise(z1.trades), n2 = summarise(z2.trades), ap = summarise(real.trades.filter((x) => x.peekOk));
    const leakOk = [n1, n2].every((a) => Object.values(a).every((x) => x.tNW == null || x.tNW < 2)), peekOk = Object.values(ap).every((x) => x.tNW != null && x.tNW >= 3);
    const floor = Object.fromEntries(MEMBERS.map((k) => [k, +(((a1[k].meanNetPctPerMonth ?? 0) + (a2[k].meanNetPctPerMonth ?? 0)) / 2).toFixed(4)]));
    writeJsonAtomic(CTRL, { spec: "r150-controls-v1", asOf: new Date().toISOString(), priced: real.priced, selftest: st,
      leakTest: { method: "drift-free bar shuffle within each symbol (seeds 1, 2)", requirement: "no member t_NW >= 2", pass: leakOk, seed1: slim(n1), seed2: slim(n2), driftKeptFloorRuns: { seed1: slim(a1), seed2: slim(a2) }, noiseFloorPctPerMonth: floor },
      positiveControl: { method: "trades whose realised net is positive (outcome look-ahead)", requirement: "t_NW >= 3 for every member", pass: peekOk, result: slim(ap) }, pass: leakOk && peekOk,
      note: "Only the winners-only look-ahead subset of real trades is summarised; no unfiltered real statistic is computed or written." });
    console.log(`R150 controls — leak ${leakOk ? "PASS" : "FAIL"} ${JSON.stringify(slim(n1))}`); console.log(`  seed 2 ${JSON.stringify(slim(n2))}`);
    console.log(`  look-ahead ${peekOk ? "PASS" : "FAIL"} ${JSON.stringify(slim(ap))}`); console.log(`  floor (drift kept) ${JSON.stringify(floor)}`);
    console.log(leakOk && peekOk ? "R150 READY — the one read is: node backend/r150-classics.js --read" : "R150 NOT READY — a control failed; the read is refused until it is understood");
    return;
  }
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R150) { console.error("R150 already sealed — refusing"); process.exit(2); }
  if (fs.existsSync(OUT) && JSON.parse(fs.readFileSync(OUT, "utf8")).read) { console.error("R150 already read — seal it, do not re-read"); process.exit(2); }
  const ctrl = fs.existsSync(CTRL) ? JSON.parse(fs.readFileSync(CTRL, "utf8")) : null; if (!ctrl || !ctrl.pass) { console.error("R150 controls have not passed"); process.exit(2); }
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R150"); if (!t) { console.error("R150 not registered"); process.exit(2); }
  const [real] = await pass([(b) => b]), v = summarise(real.trades), bar = t.bar.tRequired, floor = ctrl.leakTest.noiseFloorPctPerMonth;
  for (const [k, x] of Object.entries(v)) x.clears = x.trades >= MIN_TRADES && x.months >= MIN_MONTHS && x.meanNetPctPerMonth > 0 && x.meanNetPctPerMonth > floor[k] && x.tNW >= bar && x.firstHalfPct > 0 && x.secondHalfPct > 0;
  const verdict = Object.values(v).some((x) => x.clears) ? "PASS" : "DID NOT PASS";
  writeJsonAtomic(OUT, { spec: "r150-read-v1", read: true, asOf: new Date().toISOString(), bar, priced: real.priced, noiseFloor: floor, members: v, verdict });
  console.log(`R150 READ — ${verdict} (bar t_NW >= ${bar})`);
  for (const [k, x] of Object.entries(v)) console.log(`  ${k.padEnd(11)} trades ${x.trades} · months ${x.months} · net %/month ${x.meanNetPctPerMonth} (floor ${floor[k]}) · t_NW ${x.tNW} · halves ${x.firstHalfPct}/${x.secondHalfPct} · per trade ${x.meanNetPctPerTrade}% · win ${x.winRatePct}%${x.clears ? " · CLEARS" : ""}`);
})().catch((e) => { console.error("R150 FAILED:", e.message); process.exit(1); });
