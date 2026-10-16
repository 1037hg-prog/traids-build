#!/usr/bin/env node
/**
 * R178 — SWIFT TRADES LVN PULLBACK (registered 2026-09-24 before this file existed; rule frozen in data/test-registry.json,
 * preregistered[id=R178]). Volume profile over the current ZigZag swing; a resting limit at the low-volume node (LVN) in the
 * 20-80% band, with the 1-hour trend; stop beyond the node's far edge by 1 ATR, target the swing extreme B.
 *
 * Family LVN-4: k in {3,5} x ATR(14) on 5-minute bars, x venue {ETF pool SPY+QQQ+IWM, BTC/USD}. Primary: k=3, ETF pool.
 * Statistic: per ET session, the mean net R of that session's trades (the ETF pool combines its three instruments); t over
 * sessions. Discovery 2018-01-02..2022-12-31 (ETF) / 2021-01-01..2022-12-31 (BTC); holdout 2023-01-01..2026-08-31 for both.
 * Bar: holdout net t >= 2.234 on the primary AND the LVN above the random-level control's 95th percentile.
 *
 * USAGE
 *   node backend/r178-lvn.js --fetch       download + cache raw bars under data/training/r178 (resumable, idempotent)
 *   node backend/r178-lvn.js --discovery   pipeline sanity on the DISCOVERY split only (no holdout number is computed/printed)
 *   node backend/r178-lvn.js --read        THE one read: family, random-level (200 draws), fib, bootstrap, peek, leak; writes
 *                                          data/r178-lvn.json; seals ONLY if the bootstrap, peek and leak controls pass
 *
 * DATA. ETFs: Alpaca SIP 5Min, adjustment "split", fetched 2017-10-01..2026-08-31 (Oct-Dec 2017 is ATR/ZigZag/EMA warm-up only,
 * no trade before 2018-01-02 is scored), regular session only: bar start in [open, close) ET per the exchange calendar
 * (Alpaca /v2/calendar, cached) — 09:30-16:00, or 09:30-13:00 on the 19 early-close days (PIPELINE FIX 2026-09-24, found in the
 * discovery coverage check before any holdout number existed: a clock-only 09:30-16:00 filter kept post-close bars on half days).
 * BTC/USD: Coinbase Exchange public
 * 5-minute candles, 2020-11-01..2026-08-31 (Nov-Dec 2020 warm-up only).
 *
 * IMPLEMENTATION NOTES (literal readings of the rule text, fixed before any result was seen):
 *  N1  Series. ETFs run on the RTH-only 5-minute series, continuous across sessions: ATR(14) and the ZigZag carry over the
 *      night (the first bar's true range includes the overnight gap). BTC runs 24h continuously.
 *  N2  ATR(14) is Wilder's: seed = mean of the first 14 true ranges, then (13*prev + TR)/14.
 *  N3  ZigZag on CLOSES. Up-swing: a close above B is a new extreme; a close <= B - k*ATR(14) OF THE CURRENT BAR confirms B as the
 *      reversal pivot, the swing flips and the current bar is the new swing's first B. Start-up: running max/min close since the
 *      first ATR bar; the first move of k*ATR from either confirms the first pivot. A and B are CLOSE prices.
 *  N4  "Live" uses ATR at the B bar: |B - A| >= k*ATR(B).
 *  N5  Profile: bars iA..iB inclusive; each bar's volume is spread uniformly over [low, high] and the part inside
 *      [min(A,B), max(A,B)] is credited to the 24 equal bins by overlap (volume outside the range is dropped). A zero-range bar puts
 *      all its volume in the bin containing its price (if inside the range).
 *  N6  20-80% band = bins 5..18 (0-based, 24 bins): exactly the bins lying wholly inside [20%, 80%], equivalently the bins whose
 *      midpoint lies inside it. The band is symmetric, so orientation (from A or from B) does not matter.
 *  N7  "half the median bin" = half the median of ALL 24 bins (mean of the 12th and 13th). Strictly below.
 *  N8  Minimum-volume ties (e.g. several empty bins after a gap) are broken by a seeded random key (hash of instrument, k, bar
 *      index), never by bin order. Bins within a relative 1e-9 of the minimum count as tied (identical true volumes can differ
 *      only by float rounding of the overlap arithmetic, which would otherwise pick a bin arbitrarily).
 *  N9  Entry: the limit is placed at the CLOSE of the bar that sets B and can first fill on the next bar. "Trades through" is read
 *      strictly: long fills if a later bar's low < limit (at the limit) or its open < limit (at the open); short mirrored.
 *  N10 Within a bar the resting order is tested for a fill BEFORE the close-based cancels (new extreme / reversal are only knowable
 *      at the close, while the limit rests through the bar).
 *  N11 15:30 cancel: a bar starting at or after 15:30 ET cannot fill an ETF order, and an ETF order never survives its session.
 *      Every live B bar re-places (after a cancel on a new extreme, the new B's own profile/LVN is the "recompute").
 *  N12 HTF bias is evaluated at placement (the B bar): the last clock-hour bar whose end <= the B bar's end; hourly close = close of
 *      the last 5-minute bar in that hour; EMA50 seeded with the SMA of the first 50 hourly closes. ETF hours come from the RTH
 *      series (09:30-10:00 is a partial clock hour). Close == EMA gives no side. Clock hours are identical in UTC and ET.
 *  N13 Stop = far edge (the bin edge farther from B) -/+ 1 x ATR(14) at the B bar. Target = B.
 *  N14 "Both tested on later bars" = bars AFTER the fill bar. Exits at the level, or at the bar's open if the bar opens beyond it
 *      (same gap convention as the entry). Stop is checked first, so a bar touching both is a stop.
 *      Sensitivity (reported, not a gate): stop also tested on the fill bar (the stop is below the limit, so if the fill bar's
 *      low reaches it, the stop came after the fill with certainty).
 *  N15 ETF time exit: flat at the close of the 15:50 bar (= 15:55 ET) after that bar's stop/target test; on a shortened session,
 *      flat at the close of the session's last bar. BTC: flat at the close of the first bar ending >= 24h after the fill bar's end.
 *  N16 One open trade per instrument: while a position is open no order is placed. The ZigZag keeps running.
 *  N17 R unit = the PLANNED risk |limit - stop|, fixed when the order is placed (size is decided then; this also keeps R finite
 *      when an open gaps through the whole bracket). ETF cost = ($0.02 round trip + $0.01 per side) = $0.04/share / risk.
 *      BTC cost = 0.001*(entry + exit) / risk.
 *  N18 A trade belongs to the ET session of its FILL bar (lib/session.js open-session rule). Session t uses sessions with >= 1
 *      trade. Trades per session is also reported over all trading sessions in the window.
 *  N19 Random-level control: identical pipeline and identical qualifying swings (LVN exists, same HTF filter, same timing); only
 *      the entry bin is drawn uniformly from bins 5..18 and the stop RULE is applied to the drawn bin (a fixed LVN stop could sit
 *      above a deeper random entry). 200 seeded draws. Compared on the registered statistic (holdout net t); mean net R reported.
 *  N20 50% retracement (report only): same qualifying swings; entry at lo + 0.5*(hi-lo); its "bin" is the half-bin-width either
 *      side of the 50% level, so stop = entry -/+ (w/2 + ATR).
 *  N21 Bootstrap: demean the gross per-session R series, 2000 seeded iid resamples of the same n, t of each; passes if the
 *      median |t| < 2 (the fraction with |t| >= 2 is reported). Peek: target-exit trades only; must reach t >= 2.234.
 *      Both are gated on the HOLDOUT of all four family members.
 *  N22 Leak: (a) asserted per order — every level (A, B, ATR, profile bars, hourly bar end) indexes <= the B bar and the fill
 *      index > the B bar; (b) truncation test — the whole instrument pipeline is rebuilt on data cut at seeded random points and
 *      every event at or before the cut must be identical.
 *
 * Paper only; no orders; this file never touches the broker or the server.
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const CACHE = path.join(__dirname, "data", "training", "r178");
const ETFS = ["SPY", "QQQ", "IWM"];
const KS = [3, 5];
const BAR5 = 300000, HOUR = 3600000, DAY24 = 86400000;
const WIN = {
  etf: { disc: ["2018-01-02", "2022-12-31"], hold: ["2023-01-01", "2026-08-31"] },
  btc: { disc: ["2021-01-01", "2022-12-31"], hold: ["2023-01-01", "2026-08-31"] },
};
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

// ── seeded randomness ─────────────────────────────────────────────────────────────────────────────
function fnv(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ── ET time (offset memoised per UTC hour; US DST switches on UTC hour boundaries) ────────────────
const FMT = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const offCache = new Map();
function etOffsetMs(ms) {
  const hk = Math.floor(ms / HOUR);
  let o = offCache.get(hk);
  if (o === undefined) {
    const p = Object.fromEntries(FMT.formatToParts(new Date(hk * HOUR)).map((x) => [x.type, x.value]));
    o = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - hk * HOUR;
    offCache.set(hk, o);
  }
  return o;
}
function etOf(ms) { const d = new Date(ms + etOffsetMs(ms)); return { date: d.toISOString().slice(0, 10), mod: d.getUTCHours() * 60 + d.getUTCMinutes() }; }

// ══ FETCH ══════════════════════════════════════════════════════════════════════════════════════════
async function fetchEtfs() {
  const { fetchBars } = require("./lib/alpaca-bars.js");
  fs.mkdirSync(CACHE, { recursive: true });
  for (const sym of ETFS) {
    for (let y = 2017; y <= 2026; y++) {
      const f = path.join(CACHE, `etf-${sym}-${y}.json`);
      if (fs.existsSync(f)) continue;
      const start = y === 2017 ? "2017-10-01T00:00:00Z" : `${y}-01-01T00:00:00Z`;
      const end = y === 2026 ? "2026-08-31T23:59:59Z" : `${y}-12-31T23:59:59Z`;
      const r = await fetchBars([sym], { start, end, timeframe: "5Min", feed: "sip", adjustment: "split", requireAll: true, quiet: true });
      const rows = (r.bars[sym] || []).map((b) => [Date.parse(b.t), b.o, b.h, b.l, b.c, b.v]);
      writeJsonAtomic(f, { source: "alpaca sip 5Min adjustment=split", sym, start, end, fetchedAt: new Date().toISOString(), pages: r.pages, rows }, { pretty: 0 });
      console.log(`  ${sym} ${y}: ${rows.length} raw bars (${r.pages} pages)`);
    }
  }
}
async function fetchCalendar() {
  const f = path.join(CACHE, "calendar.json");
  if (fs.existsSync(f)) return;
  require("dotenv").config({ path: path.join(__dirname, ".env") });
  const r = await fetch("https://paper-api.alpaca.markets/v2/calendar?start=2017-10-01&end=2026-08-31",
    { headers: { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, Accept: "application/json" } });
  if (!r.ok) throw new Error("alpaca calendar " + r.status);
  const days = (await r.json()).map((d) => ({ date: d.date, open: d.open, close: d.close }));
  writeJsonAtomic(f, { source: "alpaca /v2/calendar (read-only GET)", fetchedAt: new Date().toISOString(), days });
  console.log(`  calendar: ${days.length} sessions, ${days.filter((d) => d.close !== "16:00").length} early closes`);
}
async function cbGet(url) {
  for (let attempt = 0; attempt <= 7; attempt++) {
    let r;
    try {
      r = await fetch(url, { headers: { "User-Agent": "traids-r178-research", Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
    } catch (e) { if (attempt === 7) throw e; await nap(Math.min(30000, 1000 * 2 ** attempt)); continue; }
    if (r.ok) { const j = await r.json(); if (!Array.isArray(j)) throw new Error("coinbase non-array: " + JSON.stringify(j).slice(0, 200)); return j; }
    if (r.status === 429 || r.status >= 500) { if (attempt === 7) throw new Error("coinbase " + r.status + " after retries"); await nap(Math.min(30000, 1000 * 2 ** attempt)); continue; }
    throw new Error("coinbase " + r.status + " " + (await r.text()).slice(0, 200));
  }
}
async function fetchBtc() {
  fs.mkdirSync(CACHE, { recursive: true });
  const months = [];                                                  // [year, month0] from 2020-11 to 2026-08
  for (let y = 2020, m0 = 10; y * 12 + m0 <= 2026 * 12 + 7; m0++) { if (m0 === 12) { m0 = 0; y++; } months.push([y, m0]); }
  for (const [y, m0] of months) {
    const tag = `${y}-${String(m0 + 1).padStart(2, "0")}`;
    const f = path.join(CACHE, `btc-${tag}.json`);
    if (fs.existsSync(f)) continue;
    const ms0 = Date.UTC(y, m0, 1), ms1 = Date.UTC(y, m0 + 1, 1);
    const seen = new Map();
    for (let s = ms0; s < ms1; s += 300 * BAR5) {
      const e = Math.min(s + 299 * BAR5, ms1 - BAR5);
      const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=300&start=${new Date(s).toISOString()}&end=${new Date(e).toISOString()}`;
      const j = await cbGet(url);
      for (const c of j) { const t = c[0] * 1000; if (t >= ms0 && t < ms1) seen.set(t, [t, c[3], c[2], c[1], c[4], c[5]]); } // [time, low, high, open, close, volume]
      await nap(260);
    }
    const rows = [...seen.values()].sort((a, b) => a[0] - b[0]);
    writeJsonAtomic(f, { source: "coinbase exchange BTC-USD granularity=300", month: tag, fetchedAt: new Date().toISOString(), rows }, { pretty: 0 });
    console.log(`  BTC ${tag}: ${rows.length} bars (of ${(ms1 - ms0) / BAR5} slots)`);
  }
}

// ══ LOAD ═══════════════════════════════════════════════════════════════════════════════════════════
function loadRows(prefix) {
  const files = fs.readdirSync(CACHE).filter((f) => f.startsWith(prefix) && f.endsWith(".json")).sort();
  if (!files.length) throw new Error(`no cached bars for ${prefix} — run --fetch`);
  const m = new Map();
  for (const f of files) for (const r of JSON.parse(fs.readFileSync(path.join(CACHE, f), "utf8")).rows) m.set(r[0], r);
  return [...m.values()].sort((a, b) => a[0] - b[0]);
}
let CAL = null;
function calendar() {
  if (CAL) return CAL;
  const f = path.join(CACHE, "calendar.json");
  if (!fs.existsSync(f)) throw new Error("no calendar cached — run --fetch");
  const hm = (x) => +x.slice(0, 2) * 60 + +x.slice(3, 5);
  CAL = new Map(JSON.parse(fs.readFileSync(f, "utf8")).days.map((d) => [d.date, [hm(d.open), hm(d.close)]]));
  return CAL;
}
function loadEtf(sym) {
  const cal = calendar();
  return loadRows(`etf-${sym}-`).filter((r) => { const { date, mod } = etOf(r[0]); const oc = cal.get(date); return oc && mod >= oc[0] && mod < oc[1]; });
}
function loadBtc() { return loadRows("btc-").filter((r) => r[5] >= 0 && r[2] >= r[3]); }

// ══ INSTRUMENT PIPELINE (everything knowable bar-by-bar; used for the real run and the truncation test) ═══
function buildInstrument(name, rows, isEtf) {
  const N = rows.length;
  const t = new Float64Array(N), o = new Float64Array(N), h = new Float64Array(N), l = new Float64Array(N), c = new Float64Array(N), v = new Float64Array(N);
  const mod = new Int16Array(N), sess = new Array(N), last = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const r = rows[i]; t[i] = r[0]; o[i] = r[1]; h[i] = r[2]; l[i] = r[3]; c[i] = r[4]; v[i] = r[5];
    const e = etOf(r[0]); mod[i] = e.mod; sess[i] = e.date;
  }
  for (let i = 0; i < N; i++) last[i] = i === N - 1 || sess[i + 1] !== sess[i] ? 1 : 0;
  // ATR(14), Wilder
  const atr = new Float64Array(N).fill(NaN);
  let acc = 0;
  for (let i = 0; i < N; i++) {
    const tr = i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    if (i < 14) { acc += tr; if (i === 13) atr[i] = acc / 14; } else atr[i] = (atr[i - 1] * 13 + tr) / 14;
  }
  // hourly closes (clock hours) + EMA50, and the HTF sign at each bar's END
  const hEnd = [], hClose = [];
  for (let i = 0; i < N; i++) {
    const hs = Math.floor(t[i] / HOUR) * HOUR;
    if (hEnd.length && hEnd[hEnd.length - 1] === hs + HOUR) hClose[hClose.length - 1] = c[i];
    else { hEnd.push(hs + HOUR); hClose.push(c[i]); }
  }
  const hEma = new Float64Array(hEnd.length).fill(NaN);
  { let s = 0; for (let j = 0; j < hEnd.length; j++) { if (j < 50) { s += hClose[j]; if (j === 49) hEma[j] = s / 50; } else hEma[j] = hEma[j - 1] + (2 / 51) * (hClose[j] - hEma[j - 1]); } }
  const htf = new Int8Array(N), htfEnd = new Float64Array(N).fill(NaN);
  { let p = -1; for (let i = 0; i < N; i++) { const be = t[i] + BAR5; while (p + 1 < hEnd.length && hEnd[p + 1] <= be) p++; if (p >= 0 && Number.isFinite(hEma[p])) { htf[i] = hClose[p] > hEma[p] ? 1 : hClose[p] < hEma[p] ? -1 : 0; htfEnd[i] = hEnd[p]; } } }
  return { name, isEtf, N, t, o, h, l, c, v, mod, sess, last, atr, htf, htfEnd };
}

// ZigZag + per-B-bar profile/LVN. ev[i]: 0 none, 1 new extreme, 2 reversal (both "set B" and cancel a resting order).
function buildEvents(I, k) {
  const { N, c, h, l, v, atr, htf, htfEnd, t } = I;
  const ev = new Int8Array(N), evAt = new Int32Array(N).fill(-1), events = [];
  let dir = 0, iA = -1, iB = -1, maxI = -1, minI = -1;
  const bins = new Float64Array(24);
  for (let i = 0; i < N; i++) {
    if (!Number.isFinite(atr[i])) continue;
    const th = k * atr[i], ci = c[i];
    if (dir === 0) {
      if (maxI < 0 || ci > c[maxI]) maxI = i;
      if (minI < 0 || ci < c[minI]) minI = i;
      if (ci - c[minI] >= th) { dir = 1; iA = minI; iB = i; ev[i] = 2; }
      else if (c[maxI] - ci >= th) { dir = -1; iA = maxI; iB = i; ev[i] = 2; }
    } else if (dir === 1) {
      if (ci > c[iB]) { iB = i; ev[i] = 1; } else if (c[iB] - ci >= th) { iA = iB; iB = i; dir = -1; ev[i] = 2; }
    } else {
      if (ci < c[iB]) { iB = i; ev[i] = 1; } else if (ci - c[iB] >= th) { iA = iB; iB = i; dir = 1; ev[i] = 2; }
    }
    if (!ev[i]) continue;
    const A = c[iA], B = ci;
    if (!(Math.abs(B - A) >= k * atr[i])) continue;                   // N4: not live
    const lo = Math.min(A, B), hi = Math.max(A, B), w = (hi - lo) / 24;
    bins.fill(0);
    let maxUsed = -1;
    for (let j = iA; j <= i; j++) {                                   // N5: bars iA..iB only
      maxUsed = j;
      const bl = l[j], bh = h[j], vol = v[j];
      if (!(vol > 0)) continue;
      if (bh > bl) {
        const dens = vol / (bh - bl);
        const a = Math.max(bl, lo), b = Math.min(bh, hi);
        if (b <= a) continue;
        const j0 = Math.max(0, Math.min(23, Math.floor((a - lo) / w))), j1 = Math.max(0, Math.min(23, Math.floor((b - lo) / w)));
        for (let q = j0; q <= j1; q++) { const ov = Math.min(b, lo + (q + 1) * w) - Math.max(a, lo + q * w); if (ov > 0) bins[q] += dens * ov; }
      } else if (bl >= lo && bl <= hi) bins[Math.min(23, Math.floor((bl - lo) / w))] += vol;
    }
    let mn = Infinity; for (let q = 5; q <= 18; q++) if (bins[q] < mn) mn = bins[q];
    const tol = Math.abs(mn) * 1e-9 + 1e-9;                           // equal true volumes differ only by float rounding: a tie
    const ties = []; for (let q = 5; q <= 18; q++) if (bins[q] - mn <= tol) ties.push(q);
    let lvnJ = ties[0];
    if (ties.length > 1) { const r = mulberry32(fnv(`${I.name}|${k}|${t[i]}`)); const keyed = ties.map((q) => [r(), q]).sort((x, y) => x[0] - y[0]); lvnJ = keyed[0][1]; }
    const sorted = Array.from(bins).sort((x, y) => x - y), median = (sorted[11] + sorted[12]) / 2;
    const qualifies = mn < 0.5 * median;
    evAt[i] = events.length;
    events.push({ i, iA, dir: B > A ? 1 : -1, A, B, lo, w, atrB: atr[i], htf: htf[i], htfEnd: htfEnd[i], barEnd: t[i] + BAR5, maxUsed, lvnJ: qualifies ? lvnJ : -1, minBin: mn, median });
  }
  return { ev, evAt, events };
}

// ══ SIMULATOR ═════════════════════════════════════════════════════════════════════════════════════
function levelFromBin(e, j) {
  const mid = e.lo + (j + 0.5) * e.w;
  const far = e.dir === 1 ? e.lo + j * e.w : e.lo + (j + 1) * e.w;
  return { limit: mid, stop: e.dir === 1 ? far - e.atrB : far + e.atrB, target: e.B, bin: j };
}
const CHOOSERS = {
  lvn: () => (e) => (e.lvnJ >= 0 ? levelFromBin(e, e.lvnJ) : null),
  random: (rng) => (e) => (e.lvnJ >= 0 ? levelFromBin(e, 5 + Math.floor(rng() * 14)) : null),
  fib: () => (e) => {
    if (e.lvnJ < 0) return null;
    const lim = e.lo + 12 * e.w;                                     // 50% of [lo, hi]
    return { limit: lim, stop: e.dir === 1 ? lim - e.w / 2 - e.atrB : lim + e.w / 2 + e.atrB, target: e.B, bin: 11.5 };
  },
};
function simulate(I, E, choose, { stopOnFillBar = false, leakCheck = false } = {}) {
  const { N, t, o, h, l, c, mod, sess, last, isEtf } = I;
  const { ev, evAt, events } = E;
  const trades = [];
  let pend = null, pos = null;
  const close = (i, px, reason) => {
    const d = pos.dir, risk = pos.risk;
    const gross = d * (px - pos.entry) / risk;
    const cost = isEtf ? 0.04 / risk : 0.001 * (pos.entry + px) / risk;
    trades.push({ sess: sess[pos.fi], dir: d, entry: pos.entry, exit: px, reason, gross, net: gross - cost, risk, pi: pos.pi, fi: pos.fi, xi: i });
    pos = null;
  };
  const testLevels = (i) => {
    const d = pos.dir;
    if (d === 1) {
      if (o[i] <= pos.stop) return close(i, o[i], "stop");
      if (l[i] <= pos.stop) return close(i, pos.stop, "stop");
      if (o[i] >= pos.target) return close(i, o[i], "target");
      if (h[i] >= pos.target) return close(i, pos.target, "target");
    } else {
      if (o[i] >= pos.stop) return close(i, o[i], "stop");
      if (h[i] >= pos.stop) return close(i, pos.stop, "stop");
      if (o[i] <= pos.target) return close(i, o[i], "target");
      if (l[i] <= pos.target) return close(i, pos.target, "target");
    }
  };
  const timeExit = (i) => {
    if (!pos) return;
    if (isEtf) { if (mod[i] >= 950 || last[i]) close(i, c[i], "time"); }
    else if (t[i] + BAR5 >= pos.fillEnd + DAY24) close(i, c[i], "time");
  };
  for (let i = 0; i < N; i++) {
    if (pos && i > pos.fi) testLevels(i);
    timeExit(i);
    if (pend && !pos) {
      if (isEtf && (mod[i] >= 930 || sess[i] !== pend.sess)) pend = null;
      else if (i > pend.pi) {
        let fill = null;
        if (pend.dir === 1) { if (o[i] < pend.limit) fill = o[i]; else if (l[i] < pend.limit) fill = pend.limit; }
        else { if (o[i] > pend.limit) fill = o[i]; else if (h[i] > pend.limit) fill = pend.limit; }
        if (fill !== null) {
          if (leakCheck && !(i > pend.pi && pend.maxUsed <= pend.pi && pend.iA <= pend.pi && pend.htfEnd <= t[pend.pi] + BAR5)) throw new Error(`LEAK ${I.name} fill ${i} placed ${pend.pi}`);
          pos = { dir: pend.dir, entry: fill, stop: pend.stop, target: pend.target, risk: Math.abs(pend.limit - pend.stop), fi: i, pi: pend.pi, fillEnd: t[i] + BAR5 };
          pend = null;
          if (stopOnFillBar) { const d = pos.dir; if ((d === 1 && l[i] <= pos.stop) || (d === -1 && h[i] >= pos.stop)) close(i, pos.stop, "stop"); }
          timeExit(i);
        }
      }
    }
    if (ev[i]) {
      pend = null;                                                    // new extreme or reversal cancels a resting order
      const k = evAt[i];
      if (k >= 0 && !pos) {
        const e = events[k];
        if (e.htf === e.dir) {
          const lv = choose(e);
          if (lv) pend = { ...lv, dir: e.dir, pi: i, sess: sess[i], maxUsed: e.maxUsed, iA: e.iA, htfEnd: e.htfEnd };
        }
      }
    }
  }
  return trades;
}

// ══ STATISTICS ═══════════════════════════════════════════════════════════════════════════════════
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
function tOf(a) { const n = a.length; if (n < 3) return NaN; const m = mean(a); const s = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (n - 1)); return s > 0 ? m / (s / Math.sqrt(n)) : NaN; }
const r4 = (x) => (Number.isFinite(x) ? +x.toFixed(4) : null), r3 = (x) => (Number.isFinite(x) ? +x.toFixed(3) : null);
const inWin = (s, w) => s >= w[0] && s <= w[1];
function perSession(trades, key = "net") {
  const m = new Map();
  for (const tr of trades) { const a = m.get(tr.sess); if (a) a.push(tr[key]); else m.set(tr.sess, [tr[key]]); }
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([s, a]) => ({ s, x: mean(a) }));
}
function summarize(trades, win, totalSessions) {
  const tr = trades.filter((x) => inWin(x.sess, win));
  const net = perSession(tr, "net").map((z) => z.x), gross = perSession(tr, "gross").map((z) => z.x);
  const reasons = {}; for (const x of tr) reasons[x.reason] = (reasons[x.reason] || 0) + 1;
  return {
    window: win, trades: tr.length, sessionsWithTrades: net.length, sessionsInWindow: totalSessions,
    tradesPerSession: r4(tr.length / totalSessions), tradesPerActiveSession: r4(tr.length / net.length),
    winRate: r4(tr.filter((x) => x.net > 0).length / tr.length),
    meanGrossR: r4(mean(tr.map((x) => x.gross))), meanNetR: r4(mean(tr.map((x) => x.net))),
    sessionMeanGrossR: r4(mean(gross)), sessionMeanNetR: r4(mean(net)),
    tGross: r3(tOf(gross)), tNet: r3(tOf(net)), exits: reasons,
  };
}
const pct = (arr, p) => { const s = [...arr].filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };

// ══ MAIN ══════════════════════════════════════════════════════════════════════════════════════════
async function main() {
  const mode = process.argv[2];
  if (mode === "--fetch") { await fetchEtfs(); await fetchCalendar(); await fetchBtc(); console.log("fetch complete"); return; }
  if (mode !== "--discovery" && mode !== "--read") { console.error("usage: --fetch | --discovery | --read"); process.exit(1); }
  const READ = mode === "--read";

  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
  const ENTRY = reg.preregistered.find((x) => x.id === "R178");
  if (!ENTRY) throw new Error("R178 not in registry");
  const BAR = ENTRY.bar.tRequired;
  if (BAR !== 2.234) throw new Error("registered bar changed: " + BAR);
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8"));
  if (READ && seals.tests.R178) { console.error("R178 already sealed — refusing"); process.exit(2); }

  // ── data + coverage ──
  const inst = {}, coverage = {};
  for (const s of ETFS) {
    const rows = loadEtf(s);
    inst[s] = buildInstrument(s, rows, true);
    const byS = new Map(); for (const r of rows) { const d = etOf(r[0]).date; byS.set(d, (byS.get(d) || 0) + 1); }
    const scored = [...byS.keys()].filter((d) => d >= "2018-01-02");
    coverage[s] = { rthBars: rows.length, first: etOf(rows[0][0]).date, last: etOf(rows[rows.length - 1][0]).date, sessions: byS.size, scoredSessions: scored.length,
      sessionsUnder78Bars: scored.filter((d) => byS.get(d) < 78).length, sessionsUnder70Bars: scored.filter((d) => byS.get(d) < 70).length };
  }
  {
    const rows = loadBtc();
    inst.BTC = buildInstrument("BTC", rows, false);
    const t0 = rows[0][0], t1 = rows[rows.length - 1][0];
    let gaps = 0, maxGap = 0; for (let i = 1; i < rows.length; i++) { const g = (rows[i][0] - rows[i - 1][0]) / BAR5 - 1; if (g > 0) { gaps++; if (g > maxGap) maxGap = g; } }
    coverage.BTC = { bars: rows.length, first: new Date(t0).toISOString(), last: new Date(t1).toISOString(), expectedSlots: (t1 - t0) / BAR5 + 1, missingSlots: (t1 - t0) / BAR5 + 1 - rows.length, gapRuns: gaps, longestGapBars: maxGap, zeroVolumeBars: rows.filter((r) => r[5] === 0).length };
  }
  console.log("coverage", JSON.stringify(coverage));
  const etfSessions = {}; for (const w of ["disc", "hold"]) { const set = new Set(); for (const s of ETFS) for (const d of inst[s].sess) if (inWin(d, WIN.etf[w])) set.add(d); etfSessions[w] = set.size; }
  const btcSessions = {}; for (const w of ["disc", "hold"]) { const set = new Set(); for (const d of inst.BTC.sess) if (inWin(d, WIN.btc[w])) set.add(d); btcSessions[w] = set.size; }

  // ── events per k ──
  const EV = {};
  for (const k of KS) { EV[k] = {}; for (const n of Object.keys(inst)) EV[k][n] = buildEvents(inst[n], k); }

  // ── leak (b): truncation test ──
  let leakTrunc = { cuts: 0, eventsCompared: 0, mismatches: 0 };
  {
    const rng = mulberry32(178001);
    const cmp = (a, b) => a.i === b.i && a.iA === b.iA && a.dir === b.dir && a.A === b.A && a.B === b.B && a.lo === b.lo && a.w === b.w && a.atrB === b.atrB && a.htf === b.htf && a.lvnJ === b.lvnJ;
    for (const n of ["SPY", "BTC"]) {
      const rows = n === "BTC" ? loadBtc() : loadEtf(n);
      for (let q = 0; q < 4; q++) {
        const cut = Math.floor(rows.length * (0.2 + 0.7 * rng()));
        const Ic = buildInstrument(n, rows.slice(0, cut + 1), n !== "BTC");
        for (const k of KS) {
          const Ec = buildEvents(Ic, k), full = EV[k][n].events.filter((e) => e.i <= cut);
          leakTrunc.cuts++;
          if (Ec.events.length !== full.length) leakTrunc.mismatches++;
          for (let z = 0; z < Math.min(Ec.events.length, full.length); z++) { leakTrunc.eventsCompared++; if (!cmp(Ec.events[z], full[z])) leakTrunc.mismatches++; }
        }
      }
    }
  }
  // leak (a): static per-event assertion
  let leakStatic = 0;
  for (const k of KS) for (const n of Object.keys(inst)) for (const e of EV[k][n].events) { leakStatic++; if (!(e.maxUsed <= e.i && e.iA < e.i && !(e.htfEnd > e.barEnd))) throw new Error(`LEAK event ${n} k${k} ${e.i}`); }
  const leakOk = leakTrunc.mismatches === 0;
  console.log(`leak: ${leakStatic} events asserted; truncation ${JSON.stringify(leakTrunc)} -> ${leakOk ? "PASS" : "FAIL"}`);

  // ── family runs ──
  const venues = { ETF: ETFS, BTC: ["BTC"] };
  const runMember = (k, venue, chooserFor, opts = {}) => { const out = []; for (const n of venues[venue]) out.push(...simulate(inst[n], EV[k][n], chooserFor(n), opts)); return out; };
  const winOf = (venue, w) => (venue === "ETF" ? WIN.etf[w] : WIN.btc[w]);
  const sessOf = (venue, w) => (venue === "ETF" ? etfSessions[w] : btcSessions[w]);
  const members = []; for (const k of KS) for (const venue of ["ETF", "BTC"]) members.push({ id: `k${k}-${venue}`, k, venue, primary: k === 3 && venue === "ETF" });
  const splits = READ ? ["disc", "hold"] : ["disc"];

  const family = {}, trades = {}, eventStats = {};
  for (const m of members) {
    const tr = runMember(m.k, m.venue, () => CHOOSERS.lvn(), { leakCheck: true });
    trades[m.id] = tr;
    family[m.id] = { k: m.k, venue: m.venue, primary: m.primary };
    for (const w of splits) family[m.id][w] = summarize(tr, winOf(m.venue, w), sessOf(m.venue, w));
    let live = 0, qual = 0, qualHtf = 0;
    for (const n of venues[m.venue]) for (const e of EV[m.k][n].events) { live++; if (e.lvnJ >= 0) { qual++; if (e.htf === e.dir) qualHtf++; } }
    eventStats[m.id] = { liveBsettingBars: live, lvnQualifies: qual, lvnAndHtfAligned: qualHtf };
  }
  console.log("events", JSON.stringify(eventStats));
  for (const m of members) for (const w of splits) console.log(`${m.id}${m.primary ? " (PRIMARY)" : ""} ${w}: ${JSON.stringify(family[m.id][w])}`);

  // sensitivity: stop also tested on the fill bar (report only)
  const sensitivity = {};
  for (const m of members) { const tr = runMember(m.k, m.venue, () => CHOOSERS.lvn(), { stopOnFillBar: true }); sensitivity[m.id] = {}; for (const w of splits) { const s = summarize(tr, winOf(m.venue, w), sessOf(m.venue, w)); sensitivity[m.id][w] = { trades: s.trades, meanNetR: s.meanNetR, tNet: s.tNet }; } }
  // 50% retracement (report only)
  const fib = {};
  for (const m of members) { const tr = runMember(m.k, m.venue, () => CHOOSERS.fib()); fib[m.id] = {}; for (const w of splits) fib[m.id][w] = summarize(tr, winOf(m.venue, w), sessOf(m.venue, w)); }
  console.log("fib50", JSON.stringify(Object.fromEntries(Object.entries(fib).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([w, s]) => [w, { trades: s.trades, meanNetR: s.meanNetR, tNet: s.tNet }]))]))));

  // ── controls: bootstrap + peek ──
  const ctrlSplit = READ ? "hold" : "disc";
  const bootstrap = {}, peek = {};
  for (const m of members) {
    const w = winOf(m.venue, ctrlSplit);
    const g = perSession(trades[m.id].filter((x) => inWin(x.sess, w)), "gross").map((z) => z.x);
    const mu = mean(g), z = g.map((x) => x - mu), rng = mulberry32(fnv("R178-boot-" + m.id)), ts = [];
    for (let b = 0; b < 2000; b++) { const s = new Array(z.length); for (let q = 0; q < z.length; q++) s[q] = z[Math.floor(rng() * z.length)]; ts.push(Math.abs(tOf(s))); }
    const medAbsT = pct(ts, 0.5);
    bootstrap[m.id] = { split: ctrlSplit, sessions: g.length, draws: 2000, medianAbsT: r3(medAbsT), p95AbsT: r3(pct(ts, 0.95)), fracAbsTge2: r4(ts.filter((x) => x >= 2).length / ts.length), pass: medAbsT < 2 };
    const pk = summarize(trades[m.id].filter((x) => x.reason === "target"), w, sessOf(m.venue, ctrlSplit));
    peek[m.id] = { split: ctrlSplit, trades: pk.trades, sessions: pk.sessionsWithTrades, meanNetR: pk.meanNetR, tNet: pk.tNet, pass: pk.tNet >= BAR };
  }
  const bootOk = Object.values(bootstrap).every((x) => x.pass), peekOk = Object.values(peek).every((x) => x.pass);
  console.log("bootstrap", JSON.stringify(bootstrap), bootOk ? "PASS" : "FAIL");
  console.log("peek", JSON.stringify(peek), peekOk ? "PASS" : "FAIL");

  if (!READ) { console.log(`DISCOVERY sanity only. Controls on discovery: leak ${leakOk}, bootstrap ${bootOk}, peek ${peekOk}. The one read: node backend/r178-lvn.js --read`); return; }

  // ── random-level control: 200 draws ──
  const DRAWS = 200, rand = {};
  for (const m of members) rand[m.id] = { holdT: [], holdMean: [], discT: [], discMean: [] };
  for (let d = 0; d < DRAWS; d++) {
    for (const m of members) {
      const tr = runMember(m.k, m.venue, (n) => CHOOSERS.random(mulberry32(fnv(`R178-rand|${d}|${m.k}|${n}`))));
      const h = summarize(tr, winOf(m.venue, "hold"), sessOf(m.venue, "hold")), s = summarize(tr, winOf(m.venue, "disc"), sessOf(m.venue, "disc"));
      rand[m.id].holdT.push(h.tNet); rand[m.id].holdMean.push(h.sessionMeanNetR); rand[m.id].discT.push(s.tNet); rand[m.id].discMean.push(s.sessionMeanNetR);
    }
    if ((d + 1) % 20 === 0) process.stdout.write(`  random-level ${d + 1}/${DRAWS}\r`);
  }
  process.stdout.write("\n");
  const randomLevel = {};
  for (const m of members) {
    const R = rand[m.id], L = family[m.id];
    const rk = (arr, x) => r4(arr.filter((y) => y < x).length / arr.length);
    randomLevel[m.id] = {
      draws: DRAWS,
      hold: { lvnTNet: L.hold.tNet, randomTNetP50: r3(pct(R.holdT, 0.5)), randomTNetP95: r3(pct(R.holdT, 0.95)), lvnPercentileT: rk(R.holdT, L.hold.tNet),
        lvnSessionMeanNetR: L.hold.sessionMeanNetR, randomMeanP50: r4(pct(R.holdMean, 0.5)), randomMeanP95: r4(pct(R.holdMean, 0.95)), lvnPercentileMean: rk(R.holdMean, L.hold.sessionMeanNetR),
        beatsP95: L.hold.tNet > pct(R.holdT, 0.95) },
      disc: { lvnTNet: L.disc.tNet, randomTNetP50: r3(pct(R.discT, 0.5)), randomTNetP95: r3(pct(R.discT, 0.95)), lvnPercentileT: rk(R.discT, L.disc.tNet),
        lvnSessionMeanNetR: L.disc.sessionMeanNetR, randomMeanP50: r4(pct(R.discMean, 0.5)), randomMeanP95: r4(pct(R.discMean, 0.95)), lvnPercentileMean: rk(R.discMean, L.disc.sessionMeanNetR) },
    };
  }
  console.log("randomLevel", JSON.stringify(randomLevel));

  // ── verdict ──
  const P = family["k3-ETF"].hold, RL = randomLevel["k3-ETF"].hold;
  const controlsPass = leakOk && bootOk && peekOk;
  const passes = P.tNet >= BAR && RL.beatsP95;
  const verdict = (passes ? "PASS" : "DID NOT PASS") + ` — primary k3 ETF pool holdout net t ${P.tNet} vs bar ${BAR} (mean net ${P.sessionMeanNetR}R/session, ${P.trades} trades); `
    + `random-level p95 t ${RL.randomTNetP95}, LVN at pct ${RL.lvnPercentileT}`;
  const today = etOf(Date.now()).date;
  const out = {
    spec: "r178-lvn-v1", test: "R178", asOf: new Date().toISOString(), script: "backend/r178-lvn.js", bar: BAR,
    windows: WIN, coverage, sessions: { etf: etfSessions, btc: btcSessions }, eventStats, family, randomLevel,
    fib50: fib, sensitivityStopOnFillBar: sensitivity,
    controls: { leak: { staticEventsAsserted: leakStatic, truncation: leakTrunc, perOrderAssertion: "every fill asserted (maxUsed, iA, hourly end <= B bar; fill index > B bar)", pass: leakOk },
      bootstrap: { members: bootstrap, pass: bootOk }, peek: { members: peek, bar: BAR, pass: peekOk }, pass: controlsPass },
    verdict, sealed: false,
  };
  if (!controlsPass) {
    out.notSealedBecause = `control failed: leak ${leakOk}, bootstrap ${bootOk}, peek ${peekOk}`;
    writeJsonAtomic(D("r178-lvn.json"), out);
    console.log("CONTROLS FAILED — r178-lvn.json written, NOT sealed:", out.notSealedBecause);
    console.log("verdict (unsealed):", verdict);
    return;
  }
  out.sealed = true;
  writeJsonAtomic(D("r178-lvn.json"), out);
  const seals2 = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8"));
  if (seals2.tests.R178) throw new Error("R178 sealed concurrently — refusing");
  seals2.tests.R178 = { sealedOn: today, unit: "holdout sessions (ET; ETF pool = mean net R of the day's SPY+QQQ+IWM trades)", verdict };
  seals2.lastRun = new Date().toISOString();
  writeJsonAtomic(D("read-seals.json"), seals2);
  const reg2 = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E2 = reg2.preregistered.find((x) => x.id === "R178");
  E2.status = `READ ${today} — ${verdict}`; reg2.asOf = new Date().toISOString();
  writeJsonAtomic(D("test-registry.json"), reg2);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R178", verdict }) + "\n");
  console.log("SEALED:", verdict);
}
if (require.main === module) main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
module.exports = { buildInstrument, buildEvents, simulate, CHOOSERS, levelFromBin, summarize };
