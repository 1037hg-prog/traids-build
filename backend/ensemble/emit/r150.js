#!/usr/bin/env node
"use strict";
/**
 * Library emitter — R150 TradingView classics (seven members). READ-ONLY.
 *
 * Source: backend/r150-classics.js is NOT require()-safe (its IIFE runs controls on load and overwrites r150-controls.json) and is
 * never executed here. The indicators, run() and the seven member functions are copied VERBATIM (source lines 36-130), as are
 * mean/nwT/summarise (lines 133-140) and the real-bars part of pass() (lines 165-175): r147-universe.json names, Alpaca SIP daily
 * bars 2016-01-01 .. 2026-09-22T21:00Z (fetchBars default adjustment), names with < 250 bars skipped, net = dir x (exit/entry - 1) - 0.10%.
 *
 * Daily series (per member), CLOSE-MARKED: a trade enters at bar ei's open and exits at bar xi's open (xi > ei always). Its daily
 * returns are: entry day dir x (close_ei / entry - 1) - 0.05%; each day in between dir x (close_d / close_{d-1} - 1); exit day
 * dir x (exit_open / close_{xi-1} - 1) - 0.05%. The member's day return = the equal-weight mean over every trade holding capital that
 * day, long and short together (R158 addDays model). Positions still open at the data end are dropped, exactly as the sealed run()
 * drops them (the known "dropped-open-position" defect, weightless sensitivity in data/r150-mark-at-end-sensitivity.json).
 *
 * Reproduction: summarise() verbatim — month of entry, mean net per trade entered that month, Newey-West lag 1 t.
 */
const fs = require("fs"), path = require("path");
const { fetchBars } = require("../../lib/alpaca-bars.js");
const { writeEntry } = require("../lib-entry.js");
const D = (f) => path.join(__dirname, "..", "..", "data", f);
const START = "2016-01-01", END = "2026-09-22T21:00:00Z", COST = 0.0010;
const MEMBERS = ["SQUEEZE", "UT-BOT", "PPST", "ALPHATREND", "RSI-2", "OTT", "TURTLE"];

// ── verbatim r150-classics.js lines 37-44 ────────────────────────────────────────────────────────────────────────────────
const sma = (a, n) => { const o = new Array(a.length).fill(NaN); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; } return o; };
const rma = (a, n) => { const o = new Array(a.length).fill(NaN); let s = 0; for (let i = 0; i < a.length; i++) { if (i < n) { s += a[i]; if (i === n - 1) o[i] = s / n; } else o[i] = (a[i] + (n - 1) * o[i - 1]) / n; } return o; };
const stdevPop = (a, n) => { const o = new Array(a.length).fill(NaN); for (let i = n - 1; i < a.length; i++) { let m = 0; for (let k = 0; k < n; k++) m += a[i - k]; m /= n; let v = 0; for (let k = 0; k < n; k++) v += (a[i - k] - m) ** 2; o[i] = Math.sqrt(v / n); } return o; };
const trueRange = (b) => b.map((x, i) => i ? Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c)) : x.h - x.l);
const highest = (a, n, i) => { let m = -Infinity; for (let k = 0; k < n && i - k >= 0; k++) m = Math.max(m, a[i - k]); return m; };
const lowest = (a, n, i) => { let m = Infinity; for (let k = 0; k < n && i - k >= 0; k++) m = Math.min(m, a[i - k]); return m; };
function linreg(a, n) { const o = new Array(a.length).fill(NaN); for (let i = n - 1; i < a.length; i++) { let sx = 0, sy = 0, sxy = 0, sxx = 0; for (let k = 0; k < n; k++) { const x = k, y = a[i - n + 1 + k]; sx += x; sy += y; sxy += x * y; sxx += x * x; } const sl = (n * sxy - sx * sy) / (n * sxx - sx * sx), ic = (sy - sl * sx) / n; o[i] = ic + sl * (n - 1); } return o; }
const cross = (a, b, i) => i > 0 && a[i] > b[i] && a[i - 1] <= b[i - 1];

// ── verbatim lines 47-58 ─────────────────────────────────────────────────────────────────────────────────────────────────
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

// ── verbatim lines 61-130 ────────────────────────────────────────────────────────────────────────────────────────────────
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

// ── verbatim lines 133-140 ───────────────────────────────────────────────────────────────────────────────────────────────
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a) { const n = a.length; if (n < 3) return null; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n, c = 0; for (let i = 1; i < n; i++) c += d[i] * d[i - 1]; v += c / n; return v > 0 ? m / Math.sqrt(v / n) : null; }
function summarise(trades) { const res = {}; for (const m of MEMBERS) { const tr = trades.filter((x) => x.member === m), byM = new Map();
  for (const x of tr) { const k = String(x.entryT).slice(0, 7); (byM.get(k) || byM.set(k, []).get(k)).push(x.net); }
  const ks = [...byM.keys()].sort(), s = ks.map((k) => mean(byM.get(k))), h = Math.floor(s.length / 2);
  res[m] = { trades: tr.length, months: ks.length, meanNetPctPerMonth: s.length ? +(100 * mean(s)).toFixed(4) : null, tNW: s.length > 2 ? +nwT(s).toFixed(3) : null,
    firstHalfPct: h ? +(100 * mean(s.slice(0, h))).toFixed(4) : null, secondHalfPct: h ? +(100 * mean(s.slice(h))).toFixed(4) : null,
    meanNetPctPerTrade: tr.length ? +(100 * mean(tr.map((x) => x.net))).toFixed(4) : null, winRatePct: tr.length ? +(100 * tr.filter((x) => x.net > 0).length / tr.length).toFixed(1) : null }; } return res; }

// ── emitter: daily close-marked book per member (R158 addDays model, direction-aware) ─────────────────────────────────────
const days = Object.fromEntries(MEMBERS.map((m) => [m, new Map()]));
function addDays(x, bars) {
  const m = days[x.member], put = (d, v) => { const k = bars[d].t.slice(0, 10), e = m.get(k) || [0, 0]; e[0] += v; e[1]++; m.set(k, e); };
  const ei = x.entryIdx, xi = bars.findIndex((b) => b.t === x.exitT), dir = x.dir;
  if (!(xi > ei)) throw new Error(`exit index ${xi} not after entry ${ei} for ${x.sym}`);
  put(ei, dir * (bars[ei].c / x.entry - 1) - COST / 2);
  for (let d = ei + 1; d < xi; d++) put(d, dir * (bars[d].c / bars[d - 1].c - 1));
  put(xi, dir * (x.exit / bars[xi - 1].c - 1) - COST / 2);
}

(async () => {
  const uni = JSON.parse(fs.readFileSync(D("r147-universe.json"), "utf8")).names, trades = []; let priced = 0, first = "9999", last = "0000";
  for (let i = 0; i < uni.length; i += 25) {
    const { bars } = await fetchBars(uni.slice(i, i + 25), { start: START, end: END, feed: "sip", requireAll: false, quiet: true });
    for (const [s, b] of Object.entries(bars)) { if (b.length < 250) continue; priced++;
      if (b[0].t.slice(0, 10) < first) first = b[0].t.slice(0, 10); if (b[b.length - 1].t.slice(0, 10) > last) last = b[b.length - 1].t.slice(0, 10);
      for (const m of MEMBERS) for (const x of RUN[m](b, s)) { x.net = x.dir * (x.exit / x.entry - 1) - COST; trades.push(x); addDays(x, b); } }
    process.stdout.write(`  R150 emit ${Math.min(i + 25, uni.length)}/${uni.length}\r`);
  }
  process.stdout.write("\n");
  const v = summarise(trades), sealed = JSON.parse(fs.readFileSync(D("r150-classics.json"), "utf8")).members;
  console.log(`priced ${priced} (sealed ${JSON.parse(fs.readFileSync(D("r150-classics.json"), "utf8")).priced})`);
  const ID = { SQUEEZE: "R150-SQUEEZE", "UT-BOT": "R150-UTBOT", PPST: "R150-PPST", ALPHATREND: "R150-ALPHATREND", "RSI-2": "R150-RSI2", OTT: "R150-OTT", TURTLE: "R150-TURTLE" };
  for (const m of MEMBERS) {
    const e = v[m], s = sealed[m], series = [...days[m].entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, [sum, cnt]]) => ({ d, r: sum / cnt }));
    const match = Math.abs(e.tNW - s.tNW) <= 0.02;   // the registered statistic within tolerance; trade/month counts are reported in notes
    const longs = trades.filter((x) => x.member === m && x.dir > 0).length;
    writeEntry({
      id: ID[m], name: `TradingView classic: ${m} (daily, 100 names)`, registryId: "R150",
      script: "backend/r150-classics.js", emitter: "backend/ensemble/emit/r150.js", unit: "daily", net: true,
      costModel: "0.10% round trip per trade (0.05% on the entry day, 0.05% on the exit day), as sealed",
      window: [first, last], calendar: "us-equity", series,
      reproduction: { statistic: "Newey-West lag-1 t of mean net per trade by month of entry (tNW)", sealed: s.tNW, emitted: e.tNW, tolerance: 0.02, match },
      construction: "Each trade (signal at the close, fill at the next open, exit at a later open) is marked daily on closes: entry day open->close, "
        + "close->close in between, exit day prior close->exit open, times its direction (short = -1), with half the 0.10% round trip on each end; "
        + "the day's return is the equal-weight mean over all of this member's trades open that day across the 100 names, long and short together.",
      notes: `Trades ${e.trades} (sealed ${s.trades}; ${longs} long / ${e.trades - longs} short), months ${e.months} (sealed ${s.months}), mean net %/month ${e.meanNetPctPerMonth} (sealed ${s.meanNetPctPerMonth}). `
        + (e.trades !== s.trades || e.months !== s.months ? `COUNT DRIFT: ${e.trades - s.trades > 0 ? "+" : ""}${e.trades - s.trades} trade(s) vs the seal. fetchBars uses adjustment=all (total-return series), so every dividend declared since the 2026-09-23 read restates the whole adjusted history; the other members moved by <=0.003 in t with identical trade counts (prices moved), so the extra trade is most likely one marginal threshold crossing flipped by that restatement (not traced trade-by-trade: the seal persisted no trade list). `  : "")
        + "Daily marks are close-to-close (not open-to-open); a short's daily mark is dir x simple return on the entry notional, so compounding the days differs from the trade's single-period return by the usual short-rebalancing term. "
        + "Open positions at the data end are dropped as in the sealed run() (weightless sensitivity: data/r150-mark-at-end-sensitivity.json). Bars re-fetched from Alpaca SIP on emit day; any vendor restatement would show up as a trade-count or t mismatch here.",
    });
  }
})().catch((e) => { console.error("R150 emit FAILED:", e.stack); process.exit(1); });
