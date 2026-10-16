#!/usr/bin/env node
"use strict";
/**
 * EMITTER — R152 TradingView most-boosted strategies (11 members) -> strategy library entries R152-<MEMBER>.
 *
 * backend/r152-tv-top-strategies.js is NOT require()-safe (its async main runs at load; non --read modes run controls and write files),
 * so the indicator, member and runner code below is COPIED VERBATIM from it (line ranges cited) and driven here on the same data:
 * Alpaca SIP daily bars (adjustment default "all"), START 2016-01-01, END 2026-09-22T21:00:00Z, the 100 names of r147-universe.json in
 * batches of 25 (members except DAVIN) and the 15 ETFs (DAVIN only), symbols with < 250 bars skipped, COST 0.0010 round trip.
 *
 * Daily series = the script's own addDays() (lines 203-208): each trade's daily position returns, half the round-trip cost on the entry
 * day and half on the exit day; the day's value = mean across that member's position-rows that day (sum/cnt) — exactly the quantity
 * summariseD() sums into its monthly statistic. Reproduction = summariseD's tNW over the 129 calendar months 2016-01..2026-09.
 * Bars are cached under backend/data/strategy-library/_cache/R152/ (read-only after the first fetch).
 */
const fs = require("fs"), path = require("path");
const { fetchBars } = require("../../lib/alpaca-bars.js");
const { writeEntry, writeUnavailable } = require("../lib-entry.js");
const DATA = path.join(__dirname, "..", "..", "data");
const CACHE = path.join(DATA, "strategy-library", "_cache", "R152");
const { writeJsonAtomic } = require("../../lib/atomic-write.js");
if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true });

// ── constants: r152-tv-top-strategies.js lines 38-40 ─────────────────────────────────────────────────────────────────────
const START = "2016-01-01", END = "2026-09-22T21:00:00Z", COST = 0.0010, THRU = 0.0001;
const MEMBERS = ["SUPERTREND", "RSI-DIV", "BBRSI-LONG", "TOTT", "MACD-STOCH", "MACD-RELOAD", "STOCH-RSI", "BB-RSI", "ICHI-TK", "CUM-RSI", "DAVIN"];
const ETFS = ["SPY", "QQQ", "IWM", "DIA", "XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLU", "XLB", "XLRE", "XLC"];

// ── indicators: lines 43-54 (verbatim) ───────────────────────────────────────────────────────────────────────────────────
const sma = (a, n) => { const o = new Array(a.length).fill(NaN); let s = 0, bad = 0; for (let i = 0; i < a.length; i++) { const v = a[i]; if (isNaN(v)) bad++; else s += v; if (i >= n) { const u = a[i - n]; if (isNaN(u)) bad--; else s -= u; } if (i >= n - 1 && !bad) o[i] = s / n; } return o; };
const ema = (a, n) => { const o = new Array(a.length).fill(NaN), k = 2 / (n + 1); let s = 0, c = 0, st = -1; for (let i = 0; i < a.length; i++) { if (isNaN(a[i])) continue; if (st < 0) { s += a[i]; c++; if (c === n) { o[i] = s / n; st = i; } } else o[i] = k * a[i] + (1 - k) * o[i - 1]; } return o; };
const rma = (a, n) => { const o = new Array(a.length).fill(NaN); let s = 0, c = 0, st = -1; for (let i = 0; i < a.length; i++) { if (isNaN(a[i])) continue; if (st < 0) { s += a[i]; c++; if (c === n) { o[i] = s / n; st = i; } } else o[i] = (a[i] + (n - 1) * o[i - 1]) / n; } return o; };
const stdevPop = (a, n) => { const o = new Array(a.length).fill(NaN); for (let i = n - 1; i < a.length; i++) { let m = 0; for (let k = 0; k < n; k++) m += a[i - k]; m /= n; let v = 0; for (let k = 0; k < n; k++) v += (a[i - k] - m) ** 2; o[i] = Math.sqrt(v / n); } return o; };
const trueRange = (b) => b.map((x, i) => i ? Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c)) : x.h - x.l);
const rsiOf = (c, n) => { const ch = c.map((v, i) => i ? v - c[i - 1] : NaN), up = rma(ch.map((x) => isNaN(x) ? NaN : Math.max(x, 0)), n), dn = rma(ch.map((x) => isNaN(x) ? NaN : -Math.min(x, 0)), n); return up.map((u, i) => isNaN(u) || isNaN(dn[i]) ? NaN : dn[i] === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / dn[i])); };
const hi = (a, n, i) => { let m = -Infinity; for (let k = 0; k < n && i - k >= 0; k++) m = Math.max(m, a[i - k]); return m; };
const lo = (a, n, i) => { let m = Infinity; for (let k = 0; k < n && i - k >= 0; k++) m = Math.min(m, a[i - k]); return m; };
const xo = (a, b, i) => i > 0 && a[i] > (Array.isArray(b) ? b[i] : b) && a[i - 1] <= (Array.isArray(b) ? b[i - 1] : b);
const xu = (a, b, i) => i > 0 && a[i] < (Array.isArray(b) ? b[i] : b) && a[i - 1] >= (Array.isArray(b) ? b[i - 1] : b);
function varMA(src, len) { const n = src.length, al = 2 / (len + 1), o = new Array(n).fill(0); for (let i = 0; i < n; i++) { let u = 0, d = 0; for (let k = 0; k < 9 && i - k >= 1; k++) { const x = src[i - k] - src[i - k - 1]; if (x > 0) u += x; else d -= x; } const cmo = u + d === 0 ? 0 : (u - d) / (u + d); o[i] = al * Math.abs(cmo) * src[i] + (1 - al * Math.abs(cmo)) * (i ? o[i - 1] : 0); } return o; }
function stochK(b, n, smooth) { const raw = b.map((x, i) => { if (i < n - 1) return NaN; let h = -Infinity, l = Infinity; for (let k = 0; k < n; k++) { h = Math.max(h, b[i - k].h); l = Math.min(l, b[i - k].l); } return h === l ? 0 : 100 * (x.c - l) / (h - l); }); return sma(raw, smooth); }

// ── runner: lines 57-78 (verbatim) ───────────────────────────────────────────────────────────────────────────────────────
function run(bars, member, sym, sigAt, { onClose = false, pyramid = 1 } = {}) {
  const out = []; let lots = [], pending = null;
  const closeAll = (i, px) => { for (const l of lots) out.push({ member, sym, dir: l.dir, entryIdx: l.i, exitIdx: i, entryT: bars[l.i].t, entry: l.px, exit: px, entryAtClose: onClose }); lots = []; };
  const act = (s, i, px) => {
    if (s.dir === 0) { if (lots.length) closeAll(i, px); return; }
    if (lots.length && lots[0].dir !== s.dir) closeAll(i, px);
    if (lots.length < pyramid && (!lots.length || lots[0].dir === s.dir)) lots.push({ dir: s.dir, px, i });
  };
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (pending) { const s = pending; pending = null;
      if (s.stop != null) { const trig = s.dir > 0 ? s.stop * (1 + THRU) : s.stop * (1 - THRU);
        if (s.dir > 0 ? b.o >= trig : b.o <= trig) act(s, i, b.o); else if (s.dir > 0 ? b.h >= trig : b.l <= trig) act(s, i, s.stop); }
      else act(s, i, b.o); }
    const s = sigAt(i, lots); if (!s) continue;
    if (onClose) act(s, i, b.c); else if (i + 1 < bars.length) pending = s;
  }
  if (lots.length) { const n0 = out.length; closeAll(bars.length - 1, bars[bars.length - 1].c); for (let j = n0; j < out.length; j++) out[j].markedAtEnd = true; }
  return out;
}

// ── members: lines 81-152 (verbatim) ─────────────────────────────────────────────────────────────────────────────────────
function SUPERTREND(b, sym) {
  const src = b.map((x) => (x.h + x.l) / 2), c = b.map((x) => x.c), atr = rma(trueRange(b), 10), n = b.length, tr = new Array(n).fill(1);
  let up1 = NaN, dn1 = NaN, trend = 1;
  for (let i = 0; i < n; i++) { if (isNaN(atr[i])) continue; let up = src[i] - 3 * atr[i], dn = src[i] + 3 * atr[i]; const u1 = isNaN(up1) ? up : up1, d1 = isNaN(dn1) ? dn : dn1;
    up = i > 0 && c[i - 1] > u1 ? Math.max(up, u1) : up; dn = i > 0 && c[i - 1] < d1 ? Math.min(dn, d1) : dn;
    trend = trend === -1 && c[i] > d1 ? 1 : trend === 1 && c[i] < u1 ? -1 : trend; tr[i] = trend; up1 = up; dn1 = dn; }
  return run(b, "SUPERTREND", sym, (i) => i > 11 && tr[i] !== tr[i - 1] ? { dir: tr[i] } : null);
}
function RSIDIV(b, sym) {
  const c = b.map((x) => x.c), osc = rsiOf(c, 9), n = b.length, L = 1, R = 3;
  const isPL = (j) => j - L >= 0 && j + R < n && !isNaN(osc[j]) && [...Array(L).keys()].every((k) => osc[j - k - 1] > osc[j]) && [...Array(R).keys()].every((k) => osc[j + k + 1] > osc[j]);
  const isPH = (j) => j - L >= 0 && j + R < n && !isNaN(osc[j]) && [...Array(L).keys()].every((k) => osc[j - k - 1] < osc[j]) && [...Array(R).keys()].every((k) => osc[j + k + 1] < osc[j]);
  const pl = [], ph = []; const sig = new Array(n).fill(null);
  for (let i = R; i < n; i++) { const j = i - R;
    let bull = false, hid = false, bear = false;
    if (isPL(j)) { const prev = pl[pl.length - 1]; if (prev != null) { const bars_ = j - prev; if (bars_ >= 5 && bars_ <= 60) { bull = osc[j] > osc[prev] && b[j].l < b[prev].l; hid = osc[j] < osc[prev] && b[j].l > b[prev].l; } } pl.push(j); }
    if (isPH(j)) { const prev = ph[ph.length - 1]; if (prev != null) { const bars_ = j - prev; if (bars_ >= 5 && bars_ <= 60) bear = osc[j] < osc[prev] && b[j].h > b[prev].h; } ph.push(j); }
    sig[i] = { long: bull || hid, close: xo(osc, 80, i) || bear };
  }
  return run(b, "RSI-DIV", sym, (i, lots) => { const s = sig[i]; if (!s) return null; if (lots.length && s.close) return { dir: 0 }; if (s.long) return { dir: 1 }; return null; }, { pyramid: 2 });
}
function BBRSI_LONG(b, sym) {
  const c = b.map((x) => x.c), r = rsiOf(c, 6), mid = sma(c, 200), sd = stdevPop(c, 200), lower = mid.map((m, i) => m - 2 * sd[i]), upper = mid.map((m, i) => m + 2 * sd[i]);
  return run(b, "BBRSI-LONG", sym, (i, lots) => { if (isNaN(r[i]) || isNaN(mid[i])) return null;
    if (lots.length && xu(r, 50, i) && xu(c, upper, i)) return { dir: 0 };
    if (xo(r, 50, i) && xo(c, lower, i)) return { dir: 1, stop: lower[i] }; return null; });
}
function TOTT(b, sym) {
  const src = b.map((x) => x.c), n = b.length, mav = varMA(src, 40), pct = 1, coeff = 0.001, up = new Array(n).fill(NaN), dnv = new Array(n).fill(NaN);
  let ls = NaN, ss = NaN, dir = 1;
  for (let i = 0; i < n; i++) { const f = mav[i] * pct * 0.01; let l = mav[i] - f; const lp = isNaN(ls) ? l : ls; l = mav[i] > lp ? Math.max(l, lp) : l;
    let s = mav[i] + f; const sp = isNaN(ss) ? s : ss; s = mav[i] < sp ? Math.min(s, sp) : s; dir = dir === -1 && mav[i] > sp ? 1 : dir === 1 && mav[i] < lp ? -1 : dir; ls = l; ss = s;
    const mt = dir === 1 ? l : s, ott = mav[i] > mt ? mt * (200 + pct) / 200 : mt * (200 - pct) / 200; up[i] = ott * (1 + coeff); dnv[i] = ott * (1 - coeff); }
  return run(b, "TOTT", sym, (i) => { if (i < 60) return null; if (mav[i] > up[i - 2] && mav[i - 1] <= up[i - 3]) return { dir: 1 }; if (mav[i] < dnv[i - 2] && mav[i - 1] >= dnv[i - 3]) return { dir: -1 }; return null; });
}
function MACDSTOCH(b, sym) {
  const c = b.map((x) => x.c), e26 = ema(c, 26), m = ema(c, 12).map((v, i) => v - e26[i]), sig = ema(m, 9), delta = m.map((v, i) => v - sig[i]), k = stochK(b, 14, 3), d = sma(k, 2);
  return run(b, "MACD-STOCH", sym, (i) => { if (isNaN(k[i]) || isNaN(d[i]) || isNaN(delta[i])) return null;
    if (xo(k, d, i) && k[i] < 29 && xo(delta, 0, i)) return { dir: 1 }; if (xu(k, d, i) && k[i] > 71 && xu(delta, 0, i)) return { dir: -1 }; return null; });
}
function MACDRELOAD(b, sym) {
  const c = b.map((x) => x.c), a = varMA(c, 12), z = varMA(c, 26), s2 = a.map((v, i) => v - z[i]), trig = varMA(s2, 9), hist = s2.map((v, i) => v - trig[i]);
  return run(b, "MACD-RELOAD", sym, (i) => { if (i < 40) return null; if (xo(hist, 0, i)) return { dir: 1 }; if (xu(hist, 0, i)) return { dir: -1 }; return null; });
}
function STOCHRSI(b, sym) {
  const c = b.map((x) => x.c), k = stochK(b, 14, 3), d = sma(k, 3), r = rsiOf(c, 14);
  return run(b, "STOCH-RSI", sym, (i) => { if (isNaN(k[i]) || isNaN(d[i]) || isNaN(r[i])) return null;
    if (xo(k, d, i) && k[i] < 20 && xo(r, 30, i)) return { dir: 1 }; if (xu(k, d, i) && k[i] > 80 && xu(r, 70, i)) return { dir: -1 }; return null; });
}
function BBRSI(b, sym) {
  const c = b.map((x) => x.c), r = rsiOf(c, 16), mid = sma(c, 20), sd = stdevPop(c, 20), lower = mid.map((m, i) => m - 2 * sd[i]), upper = mid.map((m, i) => m + 2 * sd[i]);
  return run(b, "BB-RSI", sym, (i) => { if (isNaN(r[i]) || isNaN(mid[i])) return null;
    if (xo(r, 45, i) && xo(c, lower, i)) return { dir: 1, stop: lower[i] }; if (xu(r, 55, i) && xu(c, upper, i)) return { dir: -1, stop: upper[i] }; return null; });
}
function ICHITK(b, sym) {
  const c = b.map((x) => x.c), h = b.map((x) => x.h), l = b.map((x) => x.l), e200 = ema(c, 200);
  const don = (n, i) => (hi(h, n, i) + lo(l, n, i)) / 2;
  return run(b, "ICHI-TK", sym, (i, lots) => { if (i < 200 || isNaN(e200[i])) return null; const conv = don(20, i), base = don(60, i);
    if (lots.length && conv < base) return { dir: 0 }; if (!lots.length && conv > base && c[i] > e200[i]) return { dir: 1 }; return null; });
}
function CUMRSI(b, sym) {
  const c = b.map((x) => x.c), r = rsiOf(c, 3), cum = r.map((v, i) => i >= 2 && !isNaN(r[i - 2]) ? v + r[i - 1] + r[i - 2] : NaN);
  return run(b, "CUM-RSI", sym, (i, lots) => { if (isNaN(cum[i - 1])) return null; if (lots.length && xo(cum, 282, i)) return { dir: 0 }; if (!lots.length && xo(cum, 60, i)) return { dir: 1 }; return null; }, { onClose: true });
}
function DAVIN(b, sym) {
  const c = b.map((x) => x.c), m200 = sma(c, 200), m10 = sma(c, 10), h = b.map((x) => x.h); let buyPrice = NaN;
  return run(b, "DAVIN", sym, (i, lots) => { if (isNaN(m200[i])) return null;
    if (lots.length && isNaN(buyPrice)) buyPrice = b[lots[0].i].o;
    if (lots.length) { const stop = (buyPrice - c[i]) / c[i] > 0.15, sell = c[i] > m10[i] && c[i] < b[i - 1].l; if (stop || sell) { buyPrice = NaN; return { dir: 0 }; } return null; }
    const dd = (hi(h, 52, i) - c[i]) / hi(h, 52, i) * 100; if ((c[i] > m200[i] && c[i] < m10[i]) || dd > 14) return { dir: 1 }; return null; });
}
const RUN = { SUPERTREND, "RSI-DIV": RSIDIV, "BBRSI-LONG": BBRSI_LONG, TOTT, "MACD-STOCH": MACDSTOCH, "MACD-RELOAD": MACDRELOAD, "STOCH-RSI": STOCHRSI, "BB-RSI": BBRSI, "ICHI-TK": ICHITK, "CUM-RSI": CUMRSI };

// ── statistic: lines 155-165 (verbatim nwT / MONTHS; summariseD reduced to the fields reproduced) ──────────────────────
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a) { const n = a.length; if (n < 3) return null; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n, c = 0; for (let i = 1; i < n; i++) c += d[i] * d[i - 1]; v += c / n; return v > 0 ? m / Math.sqrt(v / n) : null; }
const MONTHS = (() => { const o = []; for (let y = 2016; y <= 2026; y++) for (let m = 1; m <= 12; m++) { const k = y + "-" + String(m).padStart(2, "0"); if (k <= "2026-09") o.push(k); } return o; })();

// ── data (cached) ────────────────────────────────────────────────────────────────────────────────────────────────────────
async function cachedFetch(tag, syms) {
  const f = path.join(CACHE, `bars-${tag}.json`);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  const { bars } = await fetchBars(syms, { start: START, end: END, feed: "sip", requireAll: false, quiet: true });
  const slim = {}; for (const [s, b] of Object.entries(bars)) slim[s] = b.map((x) => ({ t: x.t, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v }));
  writeJsonAtomic(f, slim, { pretty: 0 }); return slim;
}

(async () => {
  const uni = JSON.parse(fs.readFileSync(path.join(DATA, "r147-universe.json"), "utf8")).names;
  const res = { trades: [], priced: 0, days: {} };
  // addDays: lines 203-208 (verbatim); feed: line 209 minus the peek (look-ahead control) branch
  const addDays = (map, x, bars, cost) => { const m = (map[x.member] ||= new Map()), put = (d, v) => { const k = bars[d].t.slice(0, 10), e = m.get(k) || [0, 0]; e[0] += v; e[1]++; m.set(k, e); };
    const ei = x.entryIdx, xi = x.exitIdx;
    if (xi === ei) { put(ei, x.dir * (x.exit / x.entry - 1) - cost); return; }
    put(ei, (x.entryAtClose ? 0 : x.dir * (bars[ei].c / x.entry - 1)) - cost / 2);
    for (let d = ei + 1; d < xi; d++) put(d, x.dir * (bars[d].c / bars[d - 1].c - 1));
    put(xi, x.dir * (x.exit / bars[xi - 1].c - 1) - cost / 2); };
  const feed = (r, tr, bars, cost = COST) => { for (const x of tr) { x.net = x.dir * (x.exit / x.entry - 1) - cost; r.trades.push(x); addDays(r.days, x, bars, cost); } };
  let firstBar = "9999", lastBar = "";
  const seen = (b) => { const a = b[0].t.slice(0, 10), z = b[b.length - 1].t.slice(0, 10); if (a < firstBar) firstBar = a; if (z > lastBar) lastBar = z; };
  for (let i = 0; i < uni.length; i += 25) {
    const bars = await cachedFetch(`uni-${i}`, uni.slice(i, i + 25));
    for (const [s, b] of Object.entries(bars)) { if (b.length < 250) continue; res.priced++; seen(b); for (const m of Object.keys(RUN)) feed(res, RUN[m](b, s), b); }
    process.stdout.write(`  R152 ${Math.min(i + 25, uni.length)}/${uni.length}\r`);
  }
  const eb = await cachedFetch("etfs", ETFS);
  for (const [s, b] of Object.entries(eb)) { if (b.length < 250) continue; seen(b); feed(res, DAVIN(b, s), b); }
  process.stdout.write("\n");
  console.log(`  priced ${res.priced} universe names (sealed: 97); bars ${firstBar}..${lastBar}`);

  const sealed = JSON.parse(fs.readFileSync(path.join(DATA, "r152-tv-top-strategies.json"), "utf8")).members;
  const window = [firstBar, lastBar];
  for (const m of MEMBERS) {
    const id = `R152-${m}`, name = `R152 TradingView ${m} (default inputs, daily)`;
    const dm = res.days[m];
    if (!dm || !dm.size) { writeUnavailable({ id, name, registryId: "R152", script: "backend/r152-tv-top-strategies.js", emitter: "backend/ensemble/emit/r152.js", reason: "no trades regenerated" }); continue; }
    const series = [...dm.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, [sum, cnt]]) => ({ d, r: sum / cnt }));
    // reproduction: summariseD (lines 158-165) from the SAME day map
    const mm = new Map(MONTHS.map((k) => [k, 0])), exp = new Set();
    for (const [d, [sum, cnt]] of dm) { const k = d.slice(0, 7); mm.set(k, (mm.get(k) || 0) + sum / cnt); exp.add(k); }
    const s = MONTHS.map((k) => mm.get(k)), t = nwT(s), tr = res.trades.filter((x) => x.member === m);
    const emitted = +t.toFixed(3), sealedT = sealed[m].tNW, match = Math.abs(emitted - sealedT) <= 0.02;
    const pm = +(100 * mean(s)).toFixed(4);
    writeEntry({
      id, name, registryId: "R152", script: "backend/r152-tv-top-strategies.js", emitter: "backend/ensemble/emit/r152.js",
      unit: "daily", net: true, costModel: "0.10% round trip per trade (COST 0.0010), half charged on the entry day and half on the exit day; stop entries fill only on a 1 bp trade-through",
      window, calendar: "us-equity", series,
      reproduction: { statistic: "tNW (Newey-West lag 1 on 129 monthly sums of daily mean-across-positions net returns, 2016-01..2026-09)", sealed: sealedT, emitted, tolerance: 0.02, match },
      construction: "The script's own addDays(): every trade marked close-to-close on Alpaca SIP daily bars (entry fill->close, close->close, prior close->exit fill), half the 0.10% round trip on entry and exit days; each day's r = mean across all of the member's position-rows that day (equal weight across open positions, as the script's monthly statistic). Positions open on 2026-09-22 are marked at that close (script amendment).",
      notes: `Regenerated ${tr.length} trades (sealed ${sealed[m].trades}), ${exp.size} exposed months (sealed ${sealed[m].months}), mean net ${pm}%/month (sealed ${sealed[m].meanNetPctPerMonth}). Sealed member ${sealed[m].clears ? "CLEARS" : "does not clear"} its member bar (verdict PASS is carried by DAVIN; RSI-DIV was the best t but under its scrambled floor 2.5904). Universe members use 100 r147 names (97 priced), DAVIN the 15 ETFs. Adjustment=all (total-return bars) as the sealed script.`,
    });
  }
})().catch((e) => { console.error("R152 emitter FAILED:", e.message); process.exit(1); });
