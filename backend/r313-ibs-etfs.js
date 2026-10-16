#!/usr/bin/env node
/**
 * R313 — IBS DIP-BUY on 20 ETFs the reel did not show (Quantified Strategies "RSI & ADX + IBS" carousel, slide 3 rules 1+2;
 * registered 2026-10-02). The frozen spec is the R313 entry of data/test-registry.json (preregistered). This runner implements that
 * entry and nothing else. Harness pattern copied from r310-qs-rsi5.js (R310, sealed sibling): selftest -> controls run -> one --read.
 *
 *   UNIVERSE (gated, fixed, 20) SPY IWM DIA MDY XLK XLF XLE XLV XLY XLP XLI XLU XLB EFA EEM EWJ EWG EWU EWC EWA.
 *            QQQ (the reel's own instrument, seen before registration) is fetched and appears ONLY in the reported block.
 *   DATA     Schwab marketdata/v1/pricehistory, daily, one call per ETF (lib/schwab.js token, read-only GET), split-adjusted price
 *            only (no dividends). Requested 1999-01-01 .. 2026-10-01 (endDate 2026-10-01T23:59:59Z); every bar dated after
 *            2026-10-01 is dropped (forming-bar guard) and counted. Cached ONCE under data/training/r313/ so the controls run and the
 *            read use byte-identical inputs; the cache sha256 is written into both outputs and the read refuses on a mismatch.
 *   WINDOW   entries dated 2000-01-01 .. 2026-09-30; each ETF from Jan 1 of its first FULL calendar year of data (a year is full when
 *            the first bar is dated on or before Jan 4 of that year — the latest possible first session of a year).
 *   RULE     IBS = (close - low) / (high - low); undefined when high <= low (no entry, no exit that day). ENTRY at the close of t
 *            when IBS[t] < 0.1 (strict). EXIT at the close of the first u > t with IBS[u] > 0.9 (strict). One position per ETF; a
 *            signal while long is ignored; no stop, no time cap. Trades still open at the last bar are reported, not counted.
 *            net = exit/entry - 1 - 0.0006 (0.06% round trip).
 *   STAT     calendar month of entry (YYYY-MM); per month the mean net of trades entered that month (ETFs pooled); headline
 *            Newey-West t, lag 1 (Bartlett weight 0.5: v += sum(d_i d_{i-1}) / n) — R310's nwT. Win rate beside it.
 *   GATES    (registry decisionRule.pass) >= 100 trades over >= 36 months, mean > 0, t_NW >= bar (READ FROM THE REGISTRY), corrected
 *            placebo paired t >= bar, drift-kept floor (mean > floor p95 AND t of (series - floor p50) >= bar), both halves > 0,
 *            mean at 0.12% round trip > 0, leak test + positive control passed. CANNOT MEASURE if < 100 trades or < 36 months, or
 *            the leak test / positive control fails.
 *   CONTROLS leak test (drift-free shuffle seeds 1, 2: t_NW < 2), positive control (own-winners look-ahead: t_NW >= 3), and the
 *            WHOLE decision rule's false-pass rate on 60 drift-KEPT (+ 20 drift-free) no-edge scrambles, each gate reported; the
 *            registry holds the read when the whole-rule false pass exceeds 5%.
 *   REPAIR   2026-10-02 (pre-read review; rule, bar and population unchanged):
 *            - weekend rows of the feed (2007-01-06 Sat on 16 ETFs, 2007-01-07 Sun on XLK XLB EWC EWA — copies of 2007-01-05) are
 *              dropped at unpack (the cache file and its sha256 are unchanged); counted in coverage.
 *            - REPORTED ONLY: where the real placebo paired t and floor t sit in the controls run's own no-edge distributions (the
 *              timing gates at 1.66 are stricter than 5%: ~1.5% each; their no-edge 95th percentile is ~0.9-1.3); a post-decimalisation block
 *              (entries from 2001-02-01); trades spanning a missing session or the end of an additive price adjustment.
 *            - one OPTIONAL pre-read token (RUNNER_GATES) judges the two timing t statistics at their no-edge 95th percentile;
 *              honoured only via a preEvidence registry amendment AND a controls run showing that gate set's whole-rule false
 *              pass <= 5%. Absent the amendment the registered gates are in force, unchanged.
 *
 *   node backend/r313-ibs-etfs.js --selftest | (no flag: controls run, prints READY / NOT READY) | --read
 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const ID = "R313", STEM = "r313-ibs-etfs", READ = process.argv.includes("--read"), SELFTEST_ONLY = process.argv.includes("--selftest");
const OUT = D(`${STEM}.json`), CTRL = D(`${STEM}-controls.json`);
const CACHE_DIR = path.join(__dirname, "data", "training", "r313"), CACHE = path.join(CACHE_DIR, "bars-schwab-daily-19990101-20261001.json");
const CACHE_REL = "backend/data/training/r313/bars-schwab-daily-19990101-20261001.json";
const FETCH_START = "1999-01-01", LAST_BAR = "2026-10-01", START_MS = Date.parse("1999-01-01T00:00:00Z"), END_MS = Date.parse("2026-10-01T23:59:59Z");
const ENTRY_FROM = "2000-01-01", ENTRY_TO = "2026-09-30", POST_PUB_FROM = "2014-01-01";
const COST = 0.0006, COST_2X = 0.0012, MIN_TRADES = 100, MIN_MONTHS = 36, PLACEBO_DRAWS = 500, PLACEBO_SEED = 313;
const FLOOR_SEEDS = 60, FREE_SEEDS = 20, MAX_WHOLE_RULE_FALSE_PASS = 0.05;
const IBS_ENTRY = 0.1, IBS_EXIT = 0.9, IBS_HALF = 0.5;
const UNIVERSE = ["SPY", "IWM", "DIA", "MDY", "XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLU", "XLB", "EFA", "EEM", "EWJ", "EWG", "EWU", "EWC", "EWA"];
const REPORTED_ONLY = ["QQQ"];
// Pre-read amendment tokens this runner honours (registry R313 entry: amendments[] { date, preEvidence: true, field, was, becomes,
// why, runnerGates: [...] }). With no runnerGates amendment the REGISTERED gates are in force (whole-rule false pass <= 5%, so no
// amendment is required). One optional token is defined: the operator may adopt it BEFORE the read. Any other token, or the token
// without a controls run showing its gate set's whole-rule false pass <= 5%, REFUSES the read (fail closed).
const TIMING_BAR_NULL_P95 = 1.30;
const TIMING_TOKEN = "timing:null-p95-1.30";
const RUNNER_GATES = {
  [TIMING_TOKEN]: `corrected placebo paired t >= ${TIMING_BAR_NULL_P95} AND drift-floor t vs p50 >= ${TIMING_BAR_NULL_P95}: each timing t judged at (rounded up from) its own no-edge 95th percentile instead of the NW-t-on-noise bar (repair audit 2026-10-02 on this runner, 400 fresh drift-kept scrambles + 400 real-path nulls: placebo t p95 1.18 / 1.07, floor t p95 1.29 / 0.88; reported again by every controls run); core t_NW >= the registered bar, floor mean > p95 and every other gate unchanged; the registered-gate verdict is reported beside it`,
};
const fin = Number.isFinite, dateOf = (t) => String(t).slice(0, 10);
const r4 = (x) => (x == null || !fin(x) ? null : +x.toFixed(4)), r3 = (x) => (x == null || !fin(x) ? null : +x.toFixed(3)), r1 = (x) => (x == null || !fin(x) ? null : +x.toFixed(1));

// ── the rule ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const ibsOf = (b) => (fin(b.h) && fin(b.l) && fin(b.c) && b.h > b.l ? (b.c - b.l) / (b.h - b.l) : NaN);
// Jan 1 of the first full calendar year of data, never before 2000-01-01. A year is full when the first bar is on/before Jan 4.
function entryFromOf(firstBar) { const y = +firstBar.slice(0, 4), full = firstBar.slice(5) <= "01-04" ? y : y + 1, f = `${full}-01-01`; return f > ENTRY_FROM ? f : ENTRY_FROM; }
function prep(bars, { from = ENTRY_FROM, to = ENTRY_TO } = {}) {
  const n = bars.length, d = bars.map((b) => dateOf(b.t)), o = bars.map((b) => b.o), h = bars.map((b) => b.h), l = bars.map((b) => b.l), c = bars.map((b) => b.c);
  const ibs = bars.map(ibsOf), sig = ibs.map((x) => fin(x) && x < IBS_ENTRY), ex = ibs.map((x) => fin(x) && x > IBS_EXIT);
  // synthetic halt fills (v = 0, O = H = L = C) — flagged, never altered (R310); placebo windows never use one
  const synth = bars.map((b) => b.v === 0 && b.o === b.h && b.h === b.l && b.l === b.c), synthCum = new Array(n);
  for (let i = 0, k = 0; i < n; i++) { if (synth[i]) k++; synthCum[i] = k; }
  return { n, d, o, h, l, c, ibs, sig, ex, synth, synthCum, from, to };
}
function mkTrade(P, sym, t, u) {
  const last = P.n - 1, x = u === null ? last : u;
  return { sym, t, u, entryDate: P.d[t], exitDate: u === null ? null : P.d[u], month: P.d[t].slice(0, 7), entry: P.c[t], exit: u === null ? null : P.c[u],
    hold: x - t, gross: P.c[x] / P.c[t] - 1, ...(u === null ? { markDate: P.d[last], mark: P.c[last] } : {}) };
}
// Flat at the start; one position per ETF; a signal while long is ignored (counted when inside the window); exits may fall after ENTRY_TO.
function simulate(P, sym) {
  const { n, d, sig, ex, from, to } = P, closed = [], open = []; let pos = null, ignored = 0;
  const inWin = (i) => d[i] >= from && d[i] <= to;
  for (let i = 0; i < n; i++) {
    if (pos !== null) {
      if (ex[i]) { closed.push(mkTrade(P, sym, pos, i)); pos = null; }
      else if (sig[i] && inWin(i)) ignored++;
      continue;                                                    // an exit day has IBS > 0.9, so it can never also be an entry
    }
    if (sig[i] && inWin(i)) pos = i;
  }
  if (pos !== null) open.push(mkTrade(P, sym, pos, null));
  return { closed, open, ignored };
}
// Partial-exit variant (slide 3 rules 3+4, REPORTED): the same entries and final exits; half sold at the close of the first day in
// (t, u) with IBS > 0.5 (all such days have IBS <= 0.9 by construction of u); the round-trip cost is charged once (two half round trips).
function partialGross(P, x) {
  for (let k = x.t + 1; k < x.u; k++) if (fin(P.ibs[k]) && P.ibs[k] > IBS_HALF) return { halfIdx: k, gross: 0.5 * (P.c[k] / P.c[x.t] - 1) + 0.5 * (P.c[x.u] / P.c[x.t] - 1) };
  return { halfIdx: null, gross: P.c[x.u] / P.c[x.t] - 1 };
}
// Next-open execution (REPORTED): the same signals, entry at o[t+1], exit at o[u+1]; no u (still open) or no u+1 bar -> open trade.
function nextOpenOf(P, x) {
  const e = x.t + 1;
  if (e > P.n - 1) return { open: true, sym: x.sym, t: x.t, signalMonth: x.month };
  if (x.u === null || x.u + 1 > P.n - 1) return { open: true, sym: x.sym, t: x.t, entryIdx: e, entry: P.o[e], signalMonth: x.month };
  const exitIdx = x.u + 1;
  return { open: false, sym: x.sym, t: x.t, u: x.u, entryIdx: e, exitIdx, entry: P.o[e], exit: P.o[exitIdx], gross: P.o[exitIdx] / P.o[e] - 1, month: P.d[e].slice(0, 7), signalMonth: x.month };
}

// ── R150 RSI-2 overlap (REPORTED; copied from r310-qs-rsi5.js) ───────────────────────────────────────────────────────────
function sma(a, n) { const o = new Array(a.length).fill(NaN); for (let i = n - 1; i < a.length; i++) { let s = 0; for (let k = i - n + 1; k <= i; k++) s += a[k]; o[i] = s / n; } return o; }
function rmaSeeded(a, n, first) { const o = new Array(a.length).fill(NaN); if (a.length < first + n) return o; let s = 0; for (let i = first; i < first + n; i++) s += a[i]; o[first + n - 1] = s / n; for (let i = first + n; i < a.length; i++) o[i] = (a[i] + (n - 1) * o[i - 1]) / n; return o; }
function rsiWilder(c, n) {
  const N = c.length, up = new Array(N).fill(NaN), dn = new Array(N).fill(NaN), out = new Array(N).fill(NaN);
  for (let i = 1; i < N; i++) { const ch = c[i] - c[i - 1]; up[i] = Math.max(ch, 0); dn[i] = Math.max(-ch, 0); }
  const ru = rmaSeeded(up, n, 1), rd = rmaSeeded(dn, n, 1);
  for (let i = 0; i < N; i++) { const u = ru[i], d = rd[i]; if (fin(u) && fin(d)) out[i] = d === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / d); }
  return out;
}
// R150's RSI-2 long rule close-to-close over the whole series: entry when flat and close > SMA200, close < SMA5, RSI(2) < 10; exit at
// the first later close > SMA5. cover[i] = 1 when an RSI-2 entry fires on day i or an RSI-2 position is held into day i's close.
function rsi2Coverage(c) {
  const n = c.length, s200 = sma(c, 200), r2 = rsiWilder(c, 2), s5 = sma(c, 5), fires = new Uint8Array(n), cover = new Uint8Array(n), raw = new Uint8Array(n), trades = [];
  const cond = (i) => fin(c[i]) && fin(s5[i]) && fin(s200[i]) && fin(r2[i]) && c[i] > s200[i] && c[i] < s5[i] && r2[i] < 10;
  let pos = null;
  for (let i = 0; i < n; i++) {
    if (cond(i)) raw[i] = 1;
    if (pos !== null) {
      if (fin(c[i]) && fin(s5[i]) && c[i] > s5[i]) { for (let k = pos; k < i; k++) cover[k] = 1; trades.push({ t: pos, u: i }); pos = null; }
      else continue;
    }
    if (cond(i)) { pos = i; fires[i] = 1; }
  }
  if (pos !== null) { for (let k = pos; k < n; k++) cover[k] = 1; trades.push({ t: pos, u: null }); }
  return { fires, cover, raw, trades };
}

// ── statistics (R310) ────────────────────────────────────────────────────────────────────────────────────────────────────
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a) { const n = a.length; if (n < 3) return null; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n, c = 0; for (let i = 1; i < n; i++) c += d[i] * d[i - 1]; v += c / n; return v > 0 ? m / Math.sqrt(v / n) : null; }
function monthlySeries(items, monthOf, valOf) { const by = new Map(); for (const x of items) { const k = monthOf(x); (by.get(k) || by.set(k, []).get(k)).push(valOf(x)); } const keys = [...by.keys()].sort(); return { keys, series: keys.map((k) => mean(by.get(k))) }; }
function summarise(items, { netOf = (x) => x.net, monthOf = (x) => x.month } = {}) {
  if (!items.length) return { trades: 0, months: 0, meanNet: null, meanNetPctPerMonth: null, tNet: null, tNetRaw: null, winRate: null, winRatePct: null, meanPerTradePct: null, halves: null };
  const { keys, series } = monthlySeries(items, monthOf, netOf), h = Math.floor(series.length / 2), nets = items.map(netOf), m = mean(series), t = nwT(series), w = nets.filter((x) => x > 0).length / nets.length;
  const half = (s, k) => (s.length ? { meanNet: mean(s), meanNetPctPerMonth: r4(100 * mean(s)), months: s.length, from: k[0], to: k[k.length - 1] } : { meanNet: null, meanNetPctPerMonth: null, months: 0 });
  return { trades: items.length, months: keys.length, meanNet: m, meanNetPctPerMonth: r4(100 * m), tNet: r4(t), tNetRaw: t, winRate: w, winRatePct: r1(100 * w), meanPerTradePct: r4(100 * mean(nets)),
    halves: { first: half(series.slice(0, h), keys.slice(0, h)), second: half(series.slice(h), keys.slice(h)) }, _keys: keys, _series: series };
}
const strip = (s) => { if (!s) return s; const { _keys, _series, ...rest } = s; return rest; };
const slim = (s) => ({ trades: s.trades, months: s.months, meanNetPctPerMonth: s.meanNetPctPerMonth, tNW: s.tNet });
function nearestRank(sorted, q) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] : null; }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hash = (s) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);
// R150's scramble, verbatim (via R310): shuffle (gap, high/open, low/open, close/open, volume) within the symbol; demean = drift-free.
// Each bar's IBS is a function of (h/o, l/o, c/o) only, so every scramble keeps each ETF's IBS distribution and destroys its timing.
function scramble(bars, seed, key, demean = false) {
  const rng = mulberry(seed * 1000003 + hash(key)), p = [];
  for (let i = 1; i < bars.length; i++) { const x = bars[i]; p.push([x.o / bars[i - 1].c, x.h / x.o, x.l / x.o, x.c / x.o, x.v]); }
  if (demean && p.length) { const mu = p.reduce((s, x) => s + Math.log(x[0] * x[3]), 0) / p.length, k = Math.exp(-mu); for (const x of p) x[0] *= k; }
  for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  const out = [{ ...bars[0] }]; let c = bars[0].c;
  for (let i = 1; i < bars.length; i++) { const [go, gh, gl, gc, v] = p[i - 1], o = c * go; c = o * gc; out.push({ ...bars[i], o, h: o * gh, l: o * gl, c, v }); }
  return out;
}

// ── CORRECTED matched placebo (registered gate; R310's amended design, adapted: R313 has no SMA200 condition) ───────────────
// Per real trade: a random day i of the SAME ETF in the SAME calendar month (widened to month-1..month+1 when none qualifies), inside
// that ETF's entry window, not an entry-signal day (IBS < 0.1), not a synthetic halt day; the window [i, i+H] DISJOINT from the real
// trade's [t-3, u] and spanning no synthetic bar; H drawn from the holds of OTHER ETFs' real trades; same 0.06% cost; 500 draws.
// Gate: NW t (lag 1) over months of (real monthly mean minus the placebo monthly mean averaged over draws) >= bar.
const shiftMonth = (ym, k) => { let y = +ym.slice(0, 4), m = +ym.slice(5, 7) + k; while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; } return `${y}-${String(m).padStart(2, "0")}`; };
function placeboPrepC(trades, PS) {
  const elig = new Map();
  const eligOf = (sym) => {
    if (elig.has(sym)) return elig.get(sym);
    const P = PS[sym], m = new Map();
    for (let i = 0; i < P.n; i++) {
      if (P.d[i] < P.from || P.d[i] > P.to || P.sig[i] || P.synth[i]) continue;
      const k = P.d[i].slice(0, 7); (m.get(k) || m.set(k, []).get(k)).push(i);
    }
    elig.set(sym, m); return m;
  };
  const slots = trades.map((x) => { const m = eligOf(x.sym); return { sym: x.sym, month: x.month, t: x.t, u: x.u, same: m.get(x.month) || [],
    wide: [shiftMonth(x.month, -1), x.month, shiftMonth(x.month, 1)].flatMap((k) => m.get(k) || []) }; });
  return { slots, holdPool: trades.map((x) => [x.sym, x.hold]), symbolsInPool: new Set(trades.map((x) => x.sym)).size };
}
// Same draws as R310's filter-then-index (one rng() for each hold try, one for the pick), counted without allocating.
function placeboRunC(pp, PS, { draws, seed, cost, record = null }) {
  const rng = mulberry(seed), keys = [...new Set(pp.slots.map((s) => s.month))].sort(), M = keys.length, mi = new Map(keys.map((k, i) => [k, i]));
  const stat = [], acc = new Float64Array(M), accN = new Uint32Array(M), slotMi = pp.slots.map((s) => mi.get(s.month)); let widened = 0, dropped = 0;
  for (let k = 0; k < draws; k++) {
    const s = new Float64Array(M), n = new Uint32Array(M);
    for (let q = 0; q < pp.slots.length; q++) {
      const sl = pp.slots[q], P = PS[sl.sym]; let H;
      if (pp.symbolsInPool >= 2) do { const h = pp.holdPool[Math.floor(rng() * pp.holdPool.length)]; if (h[0] !== sl.sym) H = h[1]; } while (H === undefined);
      if (H === undefined) { dropped++; continue; }                                   // a one-ETF pool has no independent hold
      const last = P.n - 1, lo = sl.t - 3, hi = sl.u, sc = P.synthCum;
      const ok = (i) => i + H <= last && (i + H < lo || i > hi) && sc[i + H] === sc[i];
      let arr = sl.same, cnt = 0, wide = false;
      for (const i of arr) if (ok(i)) cnt++;
      if (!cnt) { arr = sl.wide; wide = true; for (const i of arr) if (ok(i)) cnt++; }
      if (!cnt) { dropped++; continue; }
      if (wide) widened++;
      let j = Math.floor(rng() * cnt), i = -1;
      for (const x of arr) if (ok(x)) { if (j === 0) { i = x; break; } j--; }
      const v = P.c[i + H] / P.c[i] - 1 - cost, mq = slotMi[q];
      s[mq] += v; n[mq]++; if (record) record(sl, i, H, v, wide);
    }
    let tot = 0, m = 0; for (let i = 0; i < M; i++) if (n[i]) { const mm = s[i] / n[i]; tot += mm; m++; acc[i] += mm; accN[i]++; }
    stat.push(m ? tot / m : NaN);
  }
  const sorted = stat.filter(fin).sort((a, b) => a - b);
  return { draws, seed, months: M, p95: sorted.length ? sorted[Math.floor(0.95 * sorted.length)] : null, p50: sorted.length ? sorted[Math.floor(0.5 * sorted.length)] : null,
    p05: sorted.length ? sorted[Math.floor(0.05 * sorted.length)] : null, meanOfDraws: sorted.length ? mean(sorted) : null, monthKeys: keys,
    monthPlaceboMean: Array.from(acc, (x, i) => (accN[i] ? x / accN[i] : NaN)), widenedPerDraw: widened / draws, droppedPerDraw: dropped / draws, slots: pp.slots.length };
}
function pairedDiffs(S, pl) { if (!S._keys) return []; const byM = new Map(S._keys.map((k, i) => [k, S._series[i]])); return pl.monthKeys.map((k, i) => byM.get(k) - pl.monthPlaceboMean[i]).filter(fin); }
// R150's drift-kept floor as a gate (R310 verbatim): mean > floor p95 AND NW t of (real monthly series minus floor p50) >= bar
function floorGate(S, fl, bar) {
  const t = S._series && fl && fin(fl.p50) ? nwT(S._series.map((x) => x - fl.p50)) : null;
  const meanAboveP95 = S.meanNet != null && fl && fin(fl.p95) && S.meanNet > fl.p95, tOk = t != null && t >= bar;
  return { p50: fl ? fl.p50 : null, p95: fl ? fl.p95 : null, p50PctPerMonth: fl ? r4(100 * fl.p50) : null, p95PctPerMonth: fl ? r4(100 * fl.p95) : null, meanAboveP95: !!meanAboveP95, tVsP50: r4(t), tVsP50Raw: t, tVsP50AtLeastBar: tOk, clears: !!meanAboveP95 && tOk };
}
// THE DECISION RULE (registry R313 decisionRule.pass / cannotMeasure), one pure function used by the calibration and by the read.
// timingBar defaults to the registered bar; it differs only under the optional pre-read token (the placebo t compared here, the floor
// t compared by the caller's floorGate(..., timingBar)).
function decide({ trades, months, meanNet, tNW, halfFirst, halfSecond, meanNet2x, placeboPairedT, floorMeanAboveP95, floorTVsP50AtLeastBar, leakPass, positivePass, bar, timingBar = bar }) {
  const gates = {
    tradesAtLeast100: trades >= MIN_TRADES, monthsAtLeast36: months >= MIN_MONTHS, meanNetPositive: meanNet != null && meanNet > 0, tAtLeastBar: tNW != null && tNW >= bar,
    correctedPlaceboPairedTAtLeastBar: placeboPairedT != null && placeboPairedT >= timingBar, floorMeanAboveP95: !!floorMeanAboveP95, floorTVsP50AtLeastBar: !!floorTVsP50AtLeastBar,
    bothHalvesPositive: halfFirst != null && halfSecond != null && halfFirst > 0 && halfSecond > 0, cost2xMeanPositive: meanNet2x != null && meanNet2x > 0,
    leakTestPassed: !!leakPass, positiveControlPassed: !!positivePass };
  const why = [];
  if (!gates.tradesAtLeast100) why.push(`${trades} trades < ${MIN_TRADES}`); if (!gates.monthsAtLeast36) why.push(`${months} months < ${MIN_MONTHS}`);
  if (!gates.leakTestPassed) why.push("leak test failed"); if (!gates.positiveControlPassed) why.push("positive control failed");
  const failed = Object.keys(gates).filter((k) => !gates[k]);
  return { gates, failed, verdictScript: why.length ? `CANNOT MEASURE — ${why.join("; ")}` : failed.length ? "DID NOT PASS" : "PASS" };
}
// Pre-read amendments, from the R313 registry entry. No amendment -> the registered gates. Any runnerGates amendment must be
// preEvidence and use only tokens this runner defines (TIMING_TOKEN) — otherwise the read is held. An empty runnerGates list is a
// no-op amendment and is refused too (it says nothing the registered gates do not).
function preReadDecision(entry) {
  const am = (entry && Array.isArray(entry.amendments) ? entry.amendments : []).filter((a) => a && Array.isArray(a.runnerGates));
  if (!am.length) return { decided: true, registered: true, tokens: [], timingBar: null, meaning: ["registered decisionRule.pass as written (corrected placebo paired t + drift-kept floor are registered gates)"] };
  if (am.some((a) => a.preEvidence !== true)) return { decided: false, why: "a runnerGates amendment is not marked preEvidence: true" };
  const tokens = [...new Set(am.flatMap((a) => a.runnerGates))], unknown = tokens.filter((g) => !Object.prototype.hasOwnProperty.call(RUNNER_GATES, g));
  if (!tokens.length) return { decided: false, why: "a runnerGates amendment lists no token" };
  if (unknown.length) return { decided: false, why: `unknown runnerGates ${JSON.stringify(unknown)} — this runner defines only ${JSON.stringify(Object.keys(RUNNER_GATES))}` };
  return { decided: true, registered: false, tokens, timingBar: tokens.includes(TIMING_TOKEN) ? TIMING_BAR_NULL_P95 : null, dates: am.map((a) => a.date || null), meaning: tokens.map((g) => `${g}: ${RUNNER_GATES[g]}`) };
}
// The register's bar method at a given n (NW lag-1 t on uniform noise, seed 313, 50k trials; iid nullBar beside it) — reported only
function barAtN(n) {
  const rng = mulberry(313), T = 50000, mx = [];
  for (let t = 0; t < T; t++) { const s = []; for (let i = 0; i < n; i++) s.push(rng() * 2 - 1); mx.push(nwT(s)); }
  mx.sort((a, b) => a - b);
  const { nullBar } = require("./lib/null-bar.js"), iid = nullBar({ variants: 1, n, trials: 20000, rng: mulberry(313) }).p95, nw = mx[Math.floor(0.95 * T)];
  return { n, nwSim: r3(nw), iid: r3(iid), bar: r3(Math.max(nw, iid)) };
}

// ── data: Schwab daily, one call per ETF, cached once, hashed ────────────────────────────────────────────────────────────
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const NY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
// Schwab daily candles are stamped at local midnight (00:00 ET or 00:00 CT = 01:00 ET). Any other stamp could shift the date -> throw.
function schwabDate(ms) {
  const p = Object.fromEntries(NY.formatToParts(new Date(ms)).map((x) => [x.type, x.value])), hr = +p.hour;
  if (!(hr >= 0 && hr <= 1)) throw new Error(`candle stamped ${new Date(ms).toISOString()} (${hr}:00 ET) — not a midnight daily stamp; refusing to guess its date`);
  return `${p.year}-${p.month}-${p.day}`;
}
function packRows(sym, candles) {
  const bars = candles.map((x) => ({ d: schwabDate(x.datetime), o: x.open, h: x.high, l: x.low, c: x.close, v: x.volume }));
  let prev = "", droppedAfterLastBar = 0, droppedBeforeStart = 0; const rows = [], flags = { highBelowLow: 0, closeOutsideRange: 0, openOutsideRange: 0, highEqualsLow: 0, zeroVolume: 0, synthetic: 0, weekend: 0 };
  for (const b of bars) {
    if (![b.o, b.h, b.l, b.c].every((x) => fin(x) && x > 0)) throw new Error(`${sym}: non-finite or non-positive price on ${b.d}`);
    if (b.d <= prev) throw new Error(`${sym}: dates not strictly increasing at ${b.d}`);
    prev = b.d;
    if (b.d < FETCH_START) { droppedBeforeStart++; continue; }                        // Schwab returns the 1998-12-31 session for a 1999-01-01 start
    if (b.d > LAST_BAR) { droppedAfterLastBar++; continue; }                         // forming-bar guard: never past the last complete bar
    if (b.h < b.l) flags.highBelowLow++; if (b.h === b.l) flags.highEqualsLow++; if (b.c > b.h || b.c < b.l) flags.closeOutsideRange++; if (b.o > b.h || b.o < b.l) flags.openOutsideRange++;
    if (!(b.v > 0)) flags.zeroVolume++; if (b.v === 0 && b.o === b.h && b.h === b.l && b.l === b.c) flags.synthetic++; if (isWeekend(b.d)) flags.weekend++;
    rows.push([b.d, b.o, b.h, b.l, b.c, fin(b.v) ? b.v : null]);
  }
  return { rows, droppedAfterLastBar, droppedBeforeStart, flags };
}
// The feed carries weekend rows (2007-01-06 Sat on 16 gated ETFs, 2007-01-07 Sun on XLK XLB EWC EWA) that copy the 2007-01-05 bar
// (EWC's Sunday low 24.13 vs 24.1356). They are not sessions: dropped here, so the rule, the placebo and every scramble see sessions
// only. The cache file (and its sha256) is unchanged; coverageSummary counts them.
const isWeekend = (d) => { const g = new Date(String(d).slice(0, 10) + "T12:00:00Z").getUTCDay(); return g === 0 || g === 6; };
const unpack = (rows) => rows.filter(([t]) => !isWeekend(t)).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
async function fetchDaily(sym, tok) {
  const u = `https://api.schwabapi.com/marketdata/v1/pricehistory?symbol=${encodeURIComponent(sym)}&periodType=year&period=20&frequencyType=daily&frequency=1&startDate=${START_MS}&endDate=${END_MS}&needExtendedHoursData=false`;
  for (let a = 0; a < 4; a++) {
    const r = await fetch(u, { headers: { Authorization: "Bearer " + tok }, signal: AbortSignal.timeout(60000) });
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 15000 * (a + 1))); continue; }
    if (!r.ok) throw new Error(`${sym} pricehistory HTTP ${r.status}`);
    const j = await r.json();
    if (!Array.isArray(j.candles) || !j.candles.length) throw new Error(`${sym} pricehistory returned no candles`);
    return j.candles;
  }
  throw new Error(`${sym} pricehistory rate-limited 4 times`);
}
async function loadOrFetch(allowFetch) {
  if (fs.existsSync(CACHE)) {
    const buf = fs.readFileSync(CACHE), j = JSON.parse(buf.toString("utf8"));
    if (j.spec !== "r313-bars-cache-v1" || j.start !== FETCH_START || j.lastCompleteBar !== LAST_BAR || JSON.stringify(j.universe) !== JSON.stringify(UNIVERSE)) throw new Error("cache metadata does not match the R313 spec — refusing to use it");
    return { cache: j, sha: sha256(buf), fetched: false };
  }
  if (!allowFetch) throw new Error(`bar cache missing (${CACHE_REL}) — the controls run creates it; the read never refetches`);
  const schwab = require("./lib/schwab.js"), tok = await schwab.token();      // loaded only here: the selftest never touches the network or .env
  const rows = {}, coverage = {}, missing = [];
  for (const sym of [...UNIVERSE, ...REPORTED_ONLY]) {
    try {
      const pk = packRows(sym, await fetchDaily(sym, tok));
      if (!pk.rows.length) throw new Error("no bars on or before the last complete bar");
      rows[sym] = pk.rows;
      const firstBar = pk.rows[0][0], lastBar = pk.rows[pk.rows.length - 1][0];
      coverage[sym] = { firstBar, lastBar, bars: pk.rows.length, entryFrom: entryFromOf(firstBar), droppedAfterLastBar: pk.droppedAfterLastBar, droppedBeforeStart: pk.droppedBeforeStart, flags: pk.flags };
      console.log(`  ${sym} ${pk.rows.length} bars ${firstBar} .. ${lastBar} (entries from ${coverage[sym].entryFrom})${pk.droppedAfterLastBar ? ` · ${pk.droppedAfterLastBar} after ${LAST_BAR} dropped` : ""}`);
    } catch (e) { missing.push({ sym, error: e.message }); console.log(`  ${sym} MISSING — ${e.message}`); }
  }
  const gatedMissing = missing.filter((m) => UNIVERSE.includes(m.sym));       // fail closed: a partial gated universe is never cached
  if (gatedMissing.length) throw new Error(`gated ETFs not priced: ${gatedMissing.map((m) => m.sym).join(" ")} — nothing cached`);
  const obj = { spec: "r313-bars-cache-v1", id: ID, fetchedAt: new Date().toISOString(), source: "Schwab marketdata/v1/pricehistory (lib/schwab.js token; read-only GET), daily, split-adjusted, price only",
    request: { periodType: "year", period: 20, frequencyType: "daily", frequency: 1, startDate: START_MS, endDate: END_MS, needExtendedHoursData: false },
    start: FETCH_START, lastCompleteBar: LAST_BAR, universe: UNIVERSE, reportedOnly: REPORTED_ONLY, returned: Object.keys(rows), missing, coverage,
    rowsFormat: "[date (America/New_York), o, h, l, c, v]", rows };
  fs.mkdirSync(CACHE_DIR, { recursive: true }); writeJsonAtomic(CACHE, obj, { pretty: 0 });
  const buf = fs.readFileSync(CACHE);
  return { cache: JSON.parse(buf.toString("utf8")), sha: sha256(buf), fetched: true };
}
// ── data diagnostics (REPORTED; no price is ever altered) ──────────────────────────────────────────────────────────────────
// Missing sessions: the reference calendar is every weekday on which more than half of the gated ETFs priced on that date have a bar.
function sessionDiagnostics(rowsBySym) {
  const syms = Object.keys(rowsBySym), count = new Map(), spans = syms.map((s) => [rowsBySym[s][0][0], rowsBySym[s][rowsBySym[s].length - 1][0]]);
  for (const s of syms) for (const x of rowsBySym[s]) if (!isWeekend(x[0])) count.set(x[0], (count.get(x[0]) || 0) + 1);
  const ref = [...count.keys()].filter((d) => 2 * count.get(d) > spans.filter(([f, l]) => f <= d && l >= d).length).sort();
  const missingSessions = {}, weekendRows = {};
  for (const s of syms) {
    const r = rowsBySym[s], have = new Set(r.map((x) => x[0])), f = r[0][0], l = r[r.length - 1][0];
    const miss = ref.filter((d) => d >= f && d <= l && !have.has(d)); if (miss.length) missingSessions[s] = miss;
    const wk = r.filter((x) => isWeekend(x[0])).map((x) => x[0]); if (wk.length) weekendRows[s] = wk;
  }
  return { referenceSessions: ref.length, missingSessions, weekendRows };
}
// End of an additive price adjustment: before it every close carries one constant sub-half-cent tail (a single offset subtracted
// from all earlier prices); from it on, a different tail or none. Mode-based (>= 90% of the 60 closes before and of the 20 from it),
// so a lone off-grid raw price is not a break. IBS is unaffected (the shift cancels); the return across the boundary is not.
const tailOf = (p) => Math.round(p * 1e6) % 5000;
function modeShare(a) { const m = new Map(); let best = null, n = 0; for (const x of a) { const k = (m.get(x) || 0) + 1; m.set(x, k); if (k > n) { n = k; best = x; } } return { r: best, share: a.length ? n / a.length : 0 }; }
function additiveBreaksOf(rows, before = 60, after = 20) {
  const r = rows.filter((x) => !isWeekend(x[0])), c = r.map((x) => tailOf(x[4])), out = [];
  for (let i = before; i + after <= r.length; i++) {
    if (c[i] === c[i - 1]) continue;
    const A = modeShare(c.slice(i - before, i)), B = modeShare(c.slice(i, i + after));
    if (A.share >= 0.9 && B.share >= 0.9 && A.r !== B.r && c[i - 1] === A.r && c[i] === B.r) out.push({ lastOffsetBar: r[i - 1][0], nextBar: r[i][0], tailBefore: A.r, tailAfter: B.r, closeRet: +(r[i][4] / r[i - 1][4] - 1).toFixed(5) });
  }
  return out;
}
function coverageSummary(cache) {
  const gatedMissing = UNIVERSE.filter((s) => !cache.rows[s]), stale = UNIVERSE.filter((s) => cache.rows[s] && cache.coverage[s].lastBar !== LAST_BAR);
  const late = UNIVERSE.filter((s) => cache.rows[s] && cache.coverage[s].entryFrom > ENTRY_FROM).map((s) => `${s} ${cache.coverage[s].firstBar} -> entries from ${cache.coverage[s].entryFrom}`);
  const flags = {}; for (const s of Object.keys(cache.coverage)) for (const [k, v] of Object.entries(cache.coverage[s].flags)) if (v) (flags[s] || (flags[s] = {}))[k] = v;
  const gatedRows = Object.fromEntries(UNIVERSE.filter((s) => cache.rows[s]).map((s) => [s, cache.rows[s]])), sd = sessionDiagnostics(gatedRows);
  const additiveBreaks = {}; for (const s of Object.keys(gatedRows)) { const b = additiveBreaksOf(gatedRows[s]); if (b.length) additiveBreaks[s] = b; }
  return { gated: UNIVERSE.length, priced: UNIVERSE.length - gatedMissing.length, gatedMissing, lastBarNot20261001: stale, lateEntryStart: late, reportedOnly: REPORTED_ONLY.map((s) => (cache.rows[s] ? `${s} ${cache.coverage[s].firstBar}..${cache.coverage[s].lastBar}` : `${s} missing`)),
    droppedAfterLastBar: Object.fromEntries(Object.entries(cache.coverage).map(([s, v]) => [s, v.droppedAfterLastBar])), barFlags: flags,
    weekendRowsDropped: sd.weekendRows, missingSessions: sd.missingSessions, referenceSessions: sd.referenceSessions, additiveBreaks,
    diagnosticsNote: "weekend rows are dropped at unpack; missing sessions merge two days into one bar (a signal or exit can be missed); an additive-adjustment boundary carries the whole offset in one bar's return. Trades spanning either are reported by the read, never removed.",
    ok: gatedMissing.length === 0 && stale.length === 0 };
}
const prepSym = (cache, s, bars) => prep(bars || unpack(cache.rows[s]), { from: cache.coverage[s].entryFrom, to: ENTRY_TO });
function registryEntry() { const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")); return [...(reg.preregistered || []), ...(reg.tests || [])].find((x) => x.id === ID) || null; }

// ── calibration on no-edge scrambles (controls run only) ─────────────────────────────────────────────────────────────────
function scrambleRun(cache, seed, demean) {
  const PS = {}, tr = [];
  for (const s of UNIVERSE) { const P = prepSym(cache, s, scramble(unpack(cache.rows[s]), seed, s, demean)); PS[s] = P; for (const x of simulate(P, s).closed) tr.push({ ...x, net: x.gross - COST }); }
  const S = summarise(tr), S2 = summarise(tr, { netOf: (x) => x.gross - COST_2X });
  const pl = placeboRunC(placeboPrepC(tr, PS), PS, { draws: PLACEBO_DRAWS, seed: PLACEBO_SEED, cost: COST }), dC = pairedDiffs(S, pl);
  return { seed, demean, trades: S.trades, months: S.months, meanNet: S.meanNet, tNW: S.tNetRaw, halfFirst: S.halves && S.halves.first.meanNet, halfSecond: S.halves && S.halves.second.meanNet,
    meanNet2x: S2.meanNet, placeboPairedT: nwT(dC), placeboPairedDiff: dC.length ? mean(dC) : null, placeboP95: pl.p95, placeboP95Beaten: S.meanNet != null && pl.p95 != null && S.meanNet > pl.p95,
    widenedPerDraw: pl.widenedPerDraw, droppedPerDraw: pl.droppedPerDraw, _series: S._series };
}
const srt = (a) => a.filter(fin).sort((x, y) => x - y);
const floorOf = (vals) => { const s = srt(vals); return { seeds: s.length, p50: nearestRank(s, 0.5), p95: nearestRank(s, 0.95), min: s[0], max: s[s.length - 1],
  p50PctPerMonth: r4(100 * nearestRank(s, 0.5)), p95PctPerMonth: r4(100 * nearestRank(s, 0.95)), minPctPerMonth: r4(100 * s[0]), maxPctPerMonth: r4(100 * s[s.length - 1]) }; };
// apply the full decision rule to one scramble; leak + positive control are data-level controls, taken as passed (they gate nothing more).
// timingBar = bar is the registered rule; timingBar = TIMING_BAR_NULL_P95 is the optional token's gate set. The floor t is returned too.
function judgeScramble(r, fl, bar, timingBar = bar) {
  const fg = floorGate({ meanNet: r.meanNet, _series: r._series }, fl, timingBar);
  const J = decide({ trades: r.trades, months: r.months, meanNet: r.meanNet, tNW: r.tNW, halfFirst: r.halfFirst, halfSecond: r.halfSecond, meanNet2x: r.meanNet2x,
    placeboPairedT: r.placeboPairedT, floorMeanAboveP95: fg.meanAboveP95, floorTVsP50AtLeastBar: fg.tVsP50AtLeastBar, leakPass: true, positivePass: true, bar, timingBar });
  return { ...J, floorTVsP50: fg.tVsP50Raw };
}
// share of a no-edge sample strictly below x (where a real statistic sits in its own null); null when x or the sample is missing
const nullRank = (vals, x) => { const v = vals.filter(fin); return x == null || !fin(x) || !v.length ? null : r3(v.filter((y) => y < x).length / v.length); };
function calibrate(kept, free, bar) {
  const share = (rows, f) => (rows.length ? rows.filter(f).length / rows.length : null);
  const dist = (a, k = (x) => x) => { const s = srt(a); return s.length ? { n: s.length, min: k(s[0]), p05: k(nearestRank(s, 0.05)), p50: k(nearestRank(s, 0.5)), p95: k(nearestRank(s, 0.95)), max: k(s[s.length - 1]) } : null; };
  const floor = floorOf(kept.map((r) => r.meanNet));
  // leave-one-out: each drift-kept scramble is judged against the floor of the OTHER 59 seeds; drift-free ones against all 60
  const looFloor = (j) => floorOf(kept.filter((_, i) => i !== j).map((r) => r.meanNet));
  const loo = kept.map((_, j) => looFloor(j));
  const jk = kept.map((r, j) => judgeScramble(r, loo[j], bar)), jf = free.map((r) => judgeScramble(r, floor, bar));
  const tk = kept.map((r, j) => judgeScramble(r, loo[j], bar, TIMING_BAR_NULL_P95)), tf = free.map((r) => judgeScramble(r, floor, bar, TIMING_BAR_NULL_P95));
  const gateNames = Object.keys(jk[0].gates).filter((g) => g !== "leakTestPassed" && g !== "positiveControlPassed");
  const perGate = (J) => Object.fromEntries(gateNames.map((g) => [g, share(J, (x) => x.gates[g])]));
  const timing = ["correctedPlaceboPairedTAtLeastBar", "floorMeanAboveP95", "floorTVsP50AtLeastBar"], coreOnly = gateNames.filter((g) => !timing.includes(g));
  const subset = (J, names) => share(J, (x) => names.every((g) => x.gates[g]));
  const wholeK = share(jk, (x) => x.verdictScript === "PASS"), wholeF = share(jf, (x) => x.verdictScript === "PASS");
  const row = (r, J, T) => ({ seed: r.seed, trades: r.trades, months: r.months, meanNetPctPerMonth: r4(100 * r.meanNet), tNW: r3(r.tNW), halvesPctPerMonth: [r4(100 * r.halfFirst), r4(100 * r.halfSecond)],
    meanNet2xPctPerMonth: r4(100 * r.meanNet2x), placeboPairedDiffPctPerMonth: r4(100 * r.placeboPairedDiff), placeboPairedT: r3(r.placeboPairedT), floorTVsP50: r3(J.floorTVsP50), placeboP95PctPerMonth: r4(100 * r.placeboP95),
    placeboP95Beaten: r.placeboP95Beaten, widenedPerDraw: r3(r.widenedPerDraw), droppedPerDraw: r3(r.droppedPerDraw), verdict: J.verdictScript, failed: J.failed, verdictTimingToken: T.verdictScript });
  const ok = kept.length === FLOOR_SEEDS && free.length === FREE_SEEDS && kept.every((r) => fin(r.placeboPairedT) && fin(r.meanNet)) && floor.seeds === FLOOR_SEEDS;
  // where the two timing t statistics sit on no-edge data: the registered bar is the 95th percentile of an NW t on noise, but these
  // statistics are centred below 0 with SD < 1 here, so at the registered bar each gate's size is far under 5% (REPORTED)
  const plK = kept.map((r) => r.placeboPairedT), ftK = jk.map((x) => x.floorTVsP50), plF = free.map((r) => r.placeboPairedT), ftF = jf.map((x) => x.floorTVsP50);
  const sd = (a) => { const v = a.filter(fin), m = mean(v); return v.length > 1 ? Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1)) : null; };
  const nullStat = (vk, vf) => ({ driftKept: { ...dist(vk, r3), mean: r3(mean(vk.filter(fin))), sd: r3(sd(vk)), atRegisteredBar: share(vk, (x) => fin(x) && x >= bar), atNullP95Bar: share(vk, (x) => fin(x) && x >= TIMING_BAR_NULL_P95) },
    driftFree: { ...dist(vf, r3), atRegisteredBar: share(vf, (x) => fin(x) && x >= bar), atNullP95Bar: share(vf, (x) => fin(x) && x >= TIMING_BAR_NULL_P95) } });
  const wholeTK = share(tk, (x) => x.verdictScript === "PASS"), wholeTF = share(tf, (x) => x.verdictScript === "PASS");
  return { ok, bar, asOfNote: "scrambles only — no timing edge by construction; every rate below is a FALSE-pass rate",
    wholeRule: { driftKeptFalsePass: wholeK, driftKeptPasses: jk.filter((x) => x.verdictScript === "PASS").length, driftKeptSeeds: kept.length,
      driftFreeFalsePass: wholeF, driftFreePasses: jf.filter((x) => x.verdictScript === "PASS").length, driftFreeSeeds: free.length,
      limit: MAX_WHOLE_RULE_FALSE_PASS, calibrated: wholeK != null && wholeK <= MAX_WHOLE_RULE_FALSE_PASS,
      note: "the full registered decision rule (leak + positive control taken as passed); drift-kept seeds judged against a leave-one-out floor" },
    timingNull: { placeboPairedT: nullStat(plK, plF), floorTVsP50: nullStat(ftK, ftF), registeredBar: bar, nullP95Bar: TIMING_BAR_NULL_P95,
      note: `REPORTED ONLY. Share of no-edge scrambles at or above each bar. The registered gates use ${bar}; the repair audit (2026-10-02, this runner; 400 fresh drift-kept scrambles judged against this floor + 400 real-path nulls) found 1.5% of each family at or above 1.66 for the placebo t (floor t 1.5% / 0.3%), no-edge p95 placebo t 1.18 / 1.07 and floor t 1.29 / 0.88: at ${bar} each gate's size is ~1.5%, under 5% (conservative, not anti-conservative). drift-kept floor t is judged against the leave-one-out floor.` },
    timingTokenGateSet: { token: TIMING_TOKEN, timingBar: TIMING_BAR_NULL_P95, driftKeptFalsePass: wholeTK, driftKeptPasses: tk.filter((x) => x.verdictScript === "PASS").length, driftKeptSeeds: kept.length,
      driftFreeFalsePass: wholeTF, driftFreePasses: tf.filter((x) => x.verdictScript === "PASS").length, driftFreeSeeds: free.length,
      perGateDriftKept: Object.fromEntries(gateNames.map((g) => [g, share(tk, (x) => x.gates[g])])), limit: MAX_WHOLE_RULE_FALSE_PASS,
      calibrated: wholeTK != null && wholeTK <= MAX_WHOLE_RULE_FALSE_PASS && wholeTF != null && wholeTF <= MAX_WHOLE_RULE_FALSE_PASS,
      note: "NOT IN FORCE unless the registry R313 entry carries a preEvidence runnerGates amendment naming the token (operator's decision, before the read). Whole rule with both timing t gates at the bar above, core t_NW at the registered bar, everything else unchanged." },
    perGateDriftKept: perGate(jk), perGateDriftFree: perGate(jf),
    gateSets: { coreOnlyDriftKept: subset(jk, coreOnly), corePlusPlaceboDriftKept: subset(jk, [...coreOnly, "correctedPlaceboPairedTAtLeastBar"]), corePlusFloorDriftKept: subset(jk, [...coreOnly, "floorMeanAboveP95", "floorTVsP50AtLeastBar"]),
      coreOnlyDriftFree: subset(jf, coreOnly), coreGates: coreOnly, note: "what the two timing gates (corrected placebo, drift-kept floor) add over the core gates" },
    floor: { all: floor, method: `R150 scramble with drift KEPT (demean=false), seeds 1..${FLOOR_SEEDS}, the R313 rule unchanged, 0.06% cost; floor = p50 / p95 (nearest rank) of the per-seed mean of monthly means` },
    distributions: { driftKept: { tNW: dist(kept.map((r) => r.tNW), r3), meanNetPctPerMonth: dist(kept.map((r) => r.meanNet), (x) => r4(100 * x)), placeboPairedT: dist(kept.map((r) => r.placeboPairedT), r3),
      placeboPairedDiffPctPerMonth: dist(kept.map((r) => r.placeboPairedDiff), (x) => r4(100 * x)), trades: dist(kept.map((r) => r.trades)), months: dist(kept.map((r) => r.months)) },
      driftFree: { tNW: dist(free.map((r) => r.tNW), r3), placeboPairedT: dist(free.map((r) => r.placeboPairedT), r3), meanNetPctPerMonth: dist(free.map((r) => r.meanNet), (x) => r4(100 * x)) } },
    placeboP95Form: { driftKeptShareBeaten: share(kept, (r) => r.placeboP95Beaten), driftFreeShareBeaten: share(free, (r) => r.placeboP95Beaten), note: "the p95 form is REPORTED ONLY, never a gate (R310: anti-conservative)" },
    driftKept: kept.map((r, j) => row(r, jk[j], tk[j])), driftFree: free.map((r, j) => row(r, jf[j], tf[j])) };
}

// ── known-answer selftest (runs before any fetch, in every mode) ─────────────────────────────────────────────────────────
function selftest() {
  const checks = {}, detail = {}, day0 = Date.UTC(2000, 0, 3);
  const dayStr = (i, start = day0) => new Date(start + i * 864e5).toISOString().slice(0, 10);
  // integer-priced bars: l = base, h = base + 10, c = base + k  ->  IBS = k / 10 exactly (k/10 is the same double as the literal)
  const bar = (i, base, k, start) => (k === "flat" ? { t: dayStr(i, start), o: base, h: base, l: base, c: base, v: 1e6 } : { t: dayStr(i, start), o: base + 5, h: base + 10, l: base, c: base + k, v: 1e6 });
  const K = [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 0, 0, 9, 10, 5, 1, 5, "flat", 5, 5, 0, "flat", 4, 6, 10, 5, 5, 0, 9, 5];
  const mk = (ks, start) => ks.map((k, i) => bar(i, 100 + i, k, start)), B = mk(K), P = prep(B), sim = simulate(P, "X"), c = P.c;
  // (a) IBS: exact k/10, strict thresholds, high = low undefined
  checks.a_ibsExactAndUndefinedWhenFlat = P.ibs[10] === 0 && P.ibs[15] === 0.1 && P.ibs[12] === 0.9 && P.ibs[13] === 1 && !fin(P.ibs[17]) && !fin(P.ibs[21]) && ibsOf({ h: 10, l: 10, c: 10 }) !== ibsOf({ h: 10, l: 10, c: 10 })
    && !fin(ibsOf({ h: 9, l: 10, c: 9.5 })) && Math.abs(ibsOf({ h: 12, l: 10, c: 11.5 }) - 0.75) < 1e-15;
  checks.a_strictThresholds = P.sig.filter(Boolean).length === 4 && [10, 11, 20, 27].every((i) => P.sig[i]) && !P.sig[15] && !P.sig[17] && P.ex.filter(Boolean).length === 2 && P.ex[13] && P.ex[24] && !P.ex[12] && !P.ex[28];
  // (b) entries 10 and 20 close; 11 ignored while long; 15 (IBS = 0.1) and 17 (flat) never enter; 27 open at the last bar
  const t1 = sim.closed[0], t2 = sim.closed[1];
  checks.b_tradesExact = sim.closed.length === 2 && t1.t === 10 && t1.u === 13 && t1.hold === 3 && t1.entry === c[10] && t1.exit === c[13] && t1.gross === c[13] / c[10] - 1 && Math.abs(t1.gross - (123 / 110 - 1)) < 1e-15
    && t2.t === 20 && t2.u === 24 && t2.hold === 4 && Math.abs(t2.gross - (134 / 120 - 1)) < 1e-15 && t1.month === "2000-01" && t1.entryDate === "2000-01-13";
  checks.b_signalWhileLongIgnoredAndOpenAtLastBar = sim.ignored === 1 && sim.open.length === 1 && sim.open[0].t === 27 && sim.open[0].u === null && sim.open[0].hold === 2 && sim.open[0].mark === c[29] && sim.open[0].month === "2000-01" && P.d[29] === "2000-02-01";   // month = ENTRY month, also when marked in the next
  checks.b_flatDayNeitherEntersNorExits = !P.sig[21] && !P.ex[21] && t2.u === 24;
  // (c) entry window: from inside the long -> the second signal becomes the entry; to before the exit -> exit still taken; later entries excluded
  { const sF = simulate(prep(B, { from: dayStr(11) }), "X"), sT = simulate(prep(B, { to: dayStr(10) }), "X"), sL = simulate(prep(B, { from: dayStr(22) }), "X");
    checks.c_entryWindowEnforced = sF.closed.length === 2 && sF.closed[0].t === 11 && sF.closed[0].u === 13 && sF.ignored === 0 && sT.closed.length === 1 && sT.closed[0].u === 13 && sT.open.length === 0 && sT.ignored === 0
      && sL.closed.length === 0 && sL.open.length === 1 && sL.open[0].t === 27; }
  // (d) first full year
  checks.d_entryFromFirstFullYear = entryFromOf("1993-01-29") === "2000-01-01" && entryFromOf("1999-01-04") === "2000-01-01" && entryFromOf("2000-05-26") === "2001-01-01" && entryFromOf("2003-04-14") === "2004-01-01"
    && entryFromOf("2001-01-02") === "2001-01-01" && entryFromOf("2001-01-05") === "2002-01-01" && entryFromOf("1999-12-31") === "2000-01-01";
  // (e) partial exit: trade 1 halves at 12 (IBS 0.9 is > 0.5 and not an exit), trade 2 skips the flat day 21 and IBS 0.4 at 22, halves at 23
  { const p1 = partialGross(P, t1), p2 = partialGross(P, t2);
    checks.e_partialExitKnownAnswer = p1.halfIdx === 12 && Math.abs(p1.gross - (0.5 * (121 / 110 - 1) + 0.5 * (123 / 110 - 1))) < 1e-15 && p2.halfIdx === 23 && Math.abs(p2.gross - (0.5 * (129 / 120 - 1) + 0.5 * (134 / 120 - 1))) < 1e-15
      && partialGross(P, { t: 12, u: 13 }).halfIdx === null; }
  // (f) next open: o[t+1] / o[u+1]; open when there is no u+1 bar or no u
  { const no = nextOpenOf(P, t1), P2 = prep(B.slice(0, 14)), s2 = simulate(P2, "X"), no2 = nextOpenOf(P2, s2.closed[0]), no3 = nextOpenOf(P, sim.open[0]);
    checks.f_nextOpenFills = !no.open && no.entryIdx === 11 && no.exitIdx === 14 && no.entry === 116 && no.exit === 119 && no.gross === 119 / 116 - 1 && s2.closed.length === 1 && s2.closed[0].u === 13 && no2.open === true && no3.open === true; }
  // (g) monthly statistic: unsorted items -> sorted months, mean of monthly means, halves split, win rate
  { const S = summarise([{ month: "2000-03", net: 0.02 }, { month: "2000-01", net: 0.01 }, { month: "2000-02", net: -0.01 }, { month: "2000-01", net: 0.03 }, { month: "2000-04", net: 0.04 }]);
    checks.g_monthlySummaryKnownAnswer = S.trades === 5 && S.months === 4 && JSON.stringify(S._keys) === '["2000-01","2000-02","2000-03","2000-04"]' && Math.abs(S.meanNet - 0.0175) < 1e-15
      && Math.abs(S.halves.first.meanNet - 0.005) < 1e-15 && Math.abs(S.halves.second.meanNet - 0.03) < 1e-15 && S.winRate === 0.8; }
  // (h) nwT by hand: [1.5,.5,1.5,.5,1] -> t 10; [2,2,0,0,1] -> sqrt(5); n < 3 -> null
  checks.h_nwTHandComputed = Math.abs(nwT([1.5, 0.5, 1.5, 0.5, 1.0]) - 10) < 1e-9 && Math.abs(nwT([2, 2, 0, 0, 1]) - Math.sqrt(5)) < 1e-9 && nwT([1, 2]) === null;
  // (i) scramble: drift-free ends where it started, drift-kept ends at the real last close, deterministic, IBS multiset preserved
  { const g = mulberry(5), bars = [{ t: dayStr(0), o: 100, h: 101, l: 99, c: 100, v: 1 }];
    for (let i = 1; i < 300; i++) { const pc = bars[i - 1].c, o = pc * (1 + (g() - 0.5) * 0.01), cl = o * (1 + (g() - 0.48) * 0.03); bars.push({ t: dayStr(i), o, h: Math.max(o, cl) * (1 + g() * 0.01), l: Math.min(o, cl) * (1 - g() * 0.01), c: cl, v: 1 }); }
    const f1 = scramble(bars, 1, "X", true), f1b = scramble(bars, 1, "X", true), k1 = scramble(bars, 1, "X", false), ib = (a) => a.slice(1).map(ibsOf).sort((x, y) => x - y);
    const ibA = ib(bars), ibK = ib(k1);
    checks.i_scrambleDriftAndIbsPreserved = Math.abs(f1[f1.length - 1].c / f1[0].c - 1) < 1e-9 && Math.abs(k1[k1.length - 1].c / bars[bars.length - 1].c - 1) < 1e-9 && f1.every((b, i) => b.c === f1b[i].c)
      && k1.some((b, i) => Math.abs(b.c - bars[i].c) > 1e-6) && ibA.every((x, i) => Math.abs(x - ibK[i]) < 1e-9) && k1.every((b, i) => b.t === bars[i].t); }
  // (j) corrected placebo: every draw eligible (in the ETF's window, not a signal day, not synthetic), window disjoint from [t-3, u], no synthetic
  //     bar spanned, H another ETF's hold, value exact, same month or flagged +-1; the dropped and widened slots are dropped / widened every draw
  { const g = mulberry(11), ks = (n) => Array.from({ length: n }, (_, i) => (i % 7 === 3 ? 0 : 1 + Math.floor(g() * 9)));
    const bX = mk(ks(125)), bY = mk(ks(125)), bZ = mk(ks(125)); bZ[110] = { ...bZ[110], o: bZ[109].c, h: bZ[109].c, l: bZ[109].c, c: bZ[109].c, v: 0 };
    const PS = { X: prep(bX), Y: prep(bY, { from: dayStr(53) }), Z: prep(bZ) };
    const trades = [{ sym: "X", month: "2000-02", t: 40, u: 45, hold: 5 }, { sym: "Y", month: "2000-02", t: 55, u: 57, hold: 2 }, { sym: "Z", month: "2000-04", t: 95, u: 99, hold: 4 }, { sym: "Z", month: "1999-06", t: 5, u: 8, hold: 3 }];
    let ok = true, nRec = 0; const seen = { X: new Set(), Y: new Set(), Z: new Set() }, wideBy = {};
    const pl = placeboRunC(placeboPrepC(trades, PS), PS, { draws: 300, seed: 7, cost: COST, record: (sl, i, H, v, wide) => { nRec++; const Q = PS[sl.sym], dm = Q.d[i].slice(0, 7);
      if (Q.sig[i] || Q.synth[i] || Q.synthCum[i + H] !== Q.synthCum[i]) ok = false; if (Q.d[i] < Q.from || Q.d[i] > Q.to) ok = false;
      if (!(i + H <= Q.n - 1) || !(i + H < sl.t - 3 || i > sl.u)) ok = false;
      if (!trades.filter((x) => x.sym !== sl.sym).map((x) => x.hold).includes(H)) ok = false;
      if (Math.abs(v - (Q.c[i + H] / Q.c[i] - 1 - COST)) > 1e-15) ok = false;
      if (!wide && dm !== sl.month) ok = false; if (wide && ![shiftMonth(sl.month, -1), sl.month, shiftMonth(sl.month, 1)].includes(dm)) ok = false;
      seen[sl.sym].add(i); if (wide) wideBy[sl.sym + sl.month] = (wideBy[sl.sym + sl.month] || 0) + 1; } });
    const zNear = [...seen.Z].filter((i) => i >= 105 && i <= 110);   // 109 spans 110 for every H; 110 is the synthetic bar itself
    checks.j_correctedPlaceboEligibleDisjointIndependentHold = ok && nRec === 300 * 3 && PS.Z.synth[110] && seen.X.size >= 8 && ![40, 45, 37].some((i) => seen.X.has(i)) && [...seen.X].every((i) => !PS.X.sig[i])
      && pl.droppedPerDraw === 1 && pl.widenedPerDraw === 1 && wideBy["Y2000-02"] === 300 && Object.keys(wideBy).length === 1 && [...seen.Y].every((i) => PS.Y.d[i].startsWith("2000-03"))
      && fin(pl.p95) && pl.monthKeys.length === 3 && !fin(pl.monthPlaceboMean[0]) && !seen.Z.has(109) && !seen.Z.has(110) && zNear.length >= 1 && [...seen.Z].some((i) => i > 110);
    const one = placeboRunC(placeboPrepC([trades[0]], { X: PS.X }), { X: PS.X }, { draws: 5, seed: 1, cost: COST });
    checks.j_onePoolDropsNotLoops = one.droppedPerDraw === 1 && one.p95 === null;
    // equivalence with R310's filter-then-index draw: same seed -> same picks
    const pp = placeboPrepC(trades, PS), rng = mulberry(7); let same = true; const mine = [];
    placeboRunC(pp, PS, { draws: 20, seed: 7, cost: COST, record: (sl, i, H) => mine.push([sl.sym, i, H]) });
    const ref = []; for (let k = 0; k < 20; k++) for (const sl of pp.slots) { const Q = PS[sl.sym]; let H; do { const h = pp.holdPool[Math.floor(rng() * pp.holdPool.length)]; if (h[0] !== sl.sym) H = h[1]; } while (H === undefined);
      const okf = (i) => i + H <= Q.n - 1 && (i + H < sl.t - 3 || i > sl.u) && Q.synthCum[i + H] === Q.synthCum[i]; let cc = sl.same.filter(okf); if (!cc.length) cc = sl.wide.filter(okf); if (!cc.length) continue; ref.push([sl.sym, cc[Math.floor(rng() * cc.length)], H]); }
    same = JSON.stringify(ref) === JSON.stringify(mine) && mine.length === 60;
    checks.j_drawsIdenticalToR310FilterForm = same; }
  // (k) floor gate by hand (R310 q)
  { const S = { meanNet: 1, _series: [1.5, 0.5, 1.5, 0.5, 1.0] }, a = floorGate(S, { p50: 0, p95: 0.9 }, 1.66), b = floorGate(S, { p50: 1, p95: 0.9 }, 1.66), cc = floorGate(S, { p50: 0, p95: 1 }, 1.66);
    checks.k_floorGateHandComputed = a.clears && Math.abs(a.tVsP50Raw - 10) < 1e-9 && !b.clears && b.meanAboveP95 && Math.abs(b.tVsP50Raw) < 1e-12 && !cc.clears && !cc.meanAboveP95; }
  // (l) decision rule: all gates -> PASS; t exactly at the bar passes; one timing gate -> DID NOT PASS; < 100 trades / leak fail -> CANNOT MEASURE
  { const base = { trades: 500, months: 300, meanNet: 0.002, tNW: 1.66, halfFirst: 0.001, halfSecond: 0.003, meanNet2x: 0.001, placeboPairedT: 2.1, floorMeanAboveP95: true, floorTVsP50AtLeastBar: true, leakPass: true, positivePass: true, bar: 1.66 };
    const v = (o) => decide({ ...base, ...o });
    checks.l_decisionRule = v({}).verdictScript === "PASS" && Object.keys(v({}).gates).length === 11 && v({ placeboPairedT: 1.6599 }).verdictScript === "DID NOT PASS" && JSON.stringify(v({ placeboPairedT: 1.6599 }).failed) === '["correctedPlaceboPairedTAtLeastBar"]'
      && v({ meanNet2x: 0 }).verdictScript === "DID NOT PASS" && v({ halfFirst: -0.0001 }).verdictScript === "DID NOT PASS" && v({ floorMeanAboveP95: false }).verdictScript === "DID NOT PASS"
      && v({ trades: 99 }).verdictScript.startsWith("CANNOT MEASURE") && v({ months: 35 }).verdictScript.startsWith("CANNOT MEASURE") && v({ leakPass: false }).verdictScript === "CANNOT MEASURE — leak test failed"
      && v({ positivePass: false }).verdictScript.startsWith("CANNOT MEASURE") && v({ tNW: null }).verdictScript === "DID NOT PASS" && v({ placeboPairedT: null }).verdictScript === "DID NOT PASS";
    // timingBar moves ONLY the placebo comparison; core t stays at the bar
    checks.l_decisionRuleTimingBar = v({ placeboPairedT: 1.2 }).verdictScript === "DID NOT PASS" && v({ placeboPairedT: 1.2, timingBar: 1.1 }).verdictScript === "PASS" && v({ placeboPairedT: 1.0999, timingBar: 1.1 }).verdictScript === "DID NOT PASS"
      && v({ placeboPairedT: 1.1, timingBar: 1.1 }).verdictScript === "PASS" && v({ tNW: 1.2, timingBar: 1.1 }).verdictScript === "DID NOT PASS" && JSON.stringify(v({ tNW: 1.2, timingBar: 1.1 }).failed) === '["tAtLeastBar"]'; }
  // (m) pre-read decision: none -> registered; the one defined token -> decided with its bar; unknown token / empty list / not preEvidence -> held
  { const A = preReadDecision({}), B2 = preReadDecision({ amendments: [{ field: "x", preEvidence: true }] }), C = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: ["placebo:corrected-paired-t"] }] }), E = preReadDecision({ amendments: [{ preEvidence: false, runnerGates: [] }] });
    const T = preReadDecision({ amendments: [{ field: "x", preEvidence: true }, { date: "2026-10-03", preEvidence: true, runnerGates: [TIMING_TOKEN] }] }), TN = preReadDecision({ amendments: [{ preEvidence: false, runnerGates: [TIMING_TOKEN] }] });
    const TU = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: [TIMING_TOKEN, "timing:null-p95-1.00"] }] }), Z = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: [] }] });
    checks.m_preReadDecisionParser = A.decided && A.registered && A.timingBar === null && B2.decided && B2.registered && !C.decided && !E.decided
      && T.decided && !T.registered && T.timingBar === TIMING_BAR_NULL_P95 && JSON.stringify(T.tokens) === JSON.stringify([TIMING_TOKEN]) && !TN.decided && !TU.decided && !Z.decided && Object.keys(RUNNER_GATES).length === 1; }
  // (n) Schwab dates: midnight ET / midnight CT stamps map to the ET date; a mid-day stamp throws; packRows drops bars after the last complete bar
  { let threw = false; try { schwabDate(Date.parse("2026-10-01T15:00:00Z")); } catch (e) { threw = true; }
    const cnd = (iso, px) => ({ datetime: Date.parse(iso), open: px, high: px + 1, low: px - 1, close: px, volume: 10 });
    const pk = packRows("T", [cnd("1998-12-31T06:00:00Z", 9), cnd("2026-09-30T04:00:00Z", 10), cnd("2026-10-01T05:00:00Z", 11), cnd("2026-10-02T04:00:00Z", 12)]);
    let dupThrew = false; try { packRows("T", [cnd("2026-09-30T04:00:00Z", 10), cnd("2026-09-30T05:00:00Z", 10)]); } catch (e) { dupThrew = true; }
    checks.n_schwabDatesAndFormingBarGuard = schwabDate(Date.parse("2026-10-01T04:00:00Z")) === "2026-10-01" && schwabDate(Date.parse("2026-10-01T05:00:00Z")) === "2026-10-01" && schwabDate(Date.parse("2000-01-03T05:00:00Z")) === "2000-01-03"
      && threw && pk.rows.length === 2 && pk.droppedAfterLastBar === 1 && pk.droppedBeforeStart === 1 && pk.rows[0][0] === "2026-09-30" && pk.rows[1][0] === "2026-10-01" && dupThrew; }
  // (o) RSI-2 overlap simulator: R150's own known-answer series -> one RSI-2 trade 250 -> 254, coverage 250..253 (R310 j)
  { const cJ = [...Array.from({ length: 250 }, (_, i) => 50 + 0.2 * i), 96, 93, 90, 92, 97, 99], cv = rsi2Coverage(cJ);
    checks.o_rsi2OverlapKnownAnswer = cv.trades.length === 1 && cv.trades[0].t === 250 && cv.trades[0].u === 254 && cv.fires[250] === 1 && [250, 251, 252, 253].every((i) => cv.cover[i] === 1) && cv.cover[254] === 0 && cv.cover[249] === 0; }
  // (p) whole-rule calibration plumbing on fabricated scramble rows: LOO floor, per-gate shares, whole-rule share
  //     seed 59 (j=58): core t 2 and placebo t between the token bar and 1.66 -> fails the registered rule, passes the token gate set;
  //     seed 60 (j=59): placebo t 2 but core t 1 -> fails both
  { const rows = Array.from({ length: 60 }, (_, j) => ({ seed: j + 1, trades: 500, months: 300, meanNet: 0.001 + j * 1e-5, tNW: j === 58 ? 2 : 1, halfFirst: 0.001, halfSecond: 0.001, meanNet2x: 0.0005, placeboPairedT: j === 59 ? 2 : j === 58 ? (TIMING_BAR_NULL_P95 + 1.66) / 2 : 0.5,
      placeboPairedDiff: 0, placeboP95: 0, placeboP95Beaten: false, widenedPerDraw: 0, droppedPerDraw: 0, _series: Array.from({ length: 300 }, (_, i) => 0.001 + j * 1e-5 + (i % 2 ? 0.002 : -0.002)) }));
    const free = rows.slice(0, 20).map((r) => ({ ...r }));
    const cal = calibrate(rows, free, 1.66), tg = cal.timingTokenGateSet, tn = cal.timingNull;
    checks.p_calibrationPlumbing = cal.ok && cal.floor.all.seeds === 60 && Math.abs(cal.floor.all.p50 - (0.001 + 29 * 1e-5)) < 1e-15 && Math.abs(cal.floor.all.p95 - (0.001 + 56 * 1e-5)) < 1e-15
      && Math.abs(cal.perGateDriftKept.tAtLeastBar - 1 / 60) < 1e-15 && Math.abs(cal.perGateDriftKept.correctedPlaceboPairedTAtLeastBar - 1 / 60) < 1e-15 && cal.perGateDriftKept.meanNetPositive === 1 && cal.wholeRule.driftKeptFalsePass === 0
      && cal.wholeRule.calibrated === true && cal.perGateDriftKept.floorMeanAboveP95 === 3 / 60; detail.p_floorMeanAboveP95 = cal.perGateDriftKept.floorMeanAboveP95;
    checks.p_timingTokenCalibrationPlumbing = tg.driftKeptPasses === 1 && Math.abs(tg.driftKeptFalsePass - 1 / 60) < 1e-15 && tg.driftFreePasses === 0 && tg.calibrated === true && tg.timingBar === TIMING_BAR_NULL_P95
      && Math.abs(tg.perGateDriftKept.correctedPlaceboPairedTAtLeastBar - 2 / 60) < 1e-15 && cal.driftKept[58].verdict === "DID NOT PASS" && cal.driftKept[58].verdictTimingToken === "PASS" && cal.driftKept[59].verdictTimingToken === "DID NOT PASS"
      && Math.abs(tn.placeboPairedT.driftKept.atRegisteredBar - 1 / 60) < 1e-15 && Math.abs(tn.placeboPairedT.driftKept.atNullP95Bar - 2 / 60) < 1e-15 && tn.placeboPairedT.driftKept.p95 === 0.5
      && cal.driftKept.every((r) => fin(r.floorTVsP50)) && cal.driftKept[59].floorTVsP50 > 1.66 && cal.driftKept[0].floorTVsP50 < 0; detail.p_floorT = [cal.driftKept[0].floorTVsP50, cal.driftKept[59].floorTVsP50]; }
  // (q) weekend rows dropped at unpack; packRows counts them
  { const row = (d, c) => [d, c, c + 1, c - 1, c, 100], u = unpack([row("2007-01-05", 10), row("2007-01-06", 10), row("2007-01-07", 10), row("2007-01-08", 11)]);
    const cnd = (iso, px) => ({ datetime: Date.parse(iso), open: px, high: px + 1, low: px - 1, close: px, volume: 10 }), pk = packRows("T", [cnd("2026-09-25T04:00:00Z", 10), cnd("2026-09-26T04:00:00Z", 10), cnd("2026-09-28T04:00:00Z", 11)]);
    checks.q_weekendRowsDropped = isWeekend("2007-01-06") && isWeekend("2007-01-07") && !isWeekend("2007-01-05") && !isWeekend("2007-01-08") && !isWeekend("2026-10-01") && isWeekend("2026-09-26")
      && u.length === 2 && u[0].t === "2007-01-05" && u[1].t === "2007-01-08" && u[1].c === 11 && pk.flags.weekend === 1 && pk.rows.length === 3; }
  // (r) additive-adjustment end: two offsets then clean; a lone off-grid raw price inside an offset run is not a break
  { const px = (k, tail) => (10000000 + k * 10000 + tail) / 1e6, wd = [], rows = [];
    for (let i = 0; wd.length < 190; i++) { const d = dayStr(i); if (!isWeekend(d)) wd.push(d); }
    for (let k = 0; k < 190; k++) rows.push([wd[k], 0, 0, 0, px(k, k < 100 ? (k === 70 ? 3441 + 2500 : 3441) : k < 160 ? 2731 : 0), 1]);
    const br = additiveBreaksOf(rows);
    checks.r_additiveBreaksKnownAnswer = rows.length === 190 && br.length === 2 && br[0].tailBefore === 3441 && br[0].tailAfter === 2731 && br[0].lastOffsetBar === wd[99] && br[0].nextBar === wd[100]
      && br[1].tailBefore === 2731 && br[1].tailAfter === 0 && br[1].lastOffsetBar === wd[159] && br[1].nextBar === wd[160] && Math.abs(br[1].closeRet - +(px(160, 0) / px(159, 2731) - 1).toFixed(5)) < 1e-12
      && additiveBreaksOf(rows.slice(0, 100)).length === 0 && additiveBreaksOf(rows.map((x, k) => [x[0], 0, 0, 0, px(k, 0), 1])).length === 0; detail.r_breaks = br; }
  // (s) missing sessions against the majority weekday calendar; weekend rows listed, never part of the calendar
  { const days = Array.from({ length: 14 }, (_, i) => dayStr(i)).filter((d) => !isWeekend(d)), mkR = (ds) => ds.map((d) => [d, 1, 1, 1, 1, 1]);
    const sat = Array.from({ length: 14 }, (_, i) => dayStr(i)).find((d) => isWeekend(d)), gone = days[6];
    const sdg = sessionDiagnostics({ A: mkR(days), B: mkR(days.filter((d) => d !== gone)), C: mkR([...days, sat].sort()) });
    checks.s_sessionDiagnosticsKnownAnswer = days.length === 10 && sdg.referenceSessions === 10 && JSON.stringify(sdg.missingSessions) === JSON.stringify({ B: [gone] }) && JSON.stringify(sdg.weekendRows) === JSON.stringify({ C: [sat] }); }
  // (t) null percentile = share strictly below
  checks.t_nullRank = nullRank([0, 1, 2, 3], 2.5) === 0.75 && nullRank([0, 1, 2, 3], 0) === 0 && nullRank([3, 1, NaN, 0, 2], 3.5) === 1 && nullRank([], 1) === null && nullRank([1, 2], null) === null && nullRank([1, 2], NaN) === null;
  return { pass: Object.values(checks).every(Boolean), checks, detail };
}

// ── the read computation, pure (main writes OUT once); never run on the real cache except by --read ─────────────────────
function computeRead({ cache, sha, ctrl, entry, dec, bar }) {
  const cal = ctrl.calibration, PS = {}, closed = [], opens = [], noAll = [], noOpen = [], perEtf = {}; let ignored = 0, symbolSessions = 0, heldSessions = 0;
  for (const s of UNIVERSE) {
    const P = prepSym(cache, s); PS[s] = P;
    const sim = simulate(P, s), cv = rsi2Coverage(P.c); ignored += sim.ignored;
    for (const x of sim.closed) { const pg = partialGross(P, x); closed.push({ ...x, net: x.gross - COST, partialNet: pg.gross - COST, rsi2Fires: !!cv.fires[x.t], rsi2Raw: !!cv.raw[x.t], rsi2Cover: !!cv.cover[x.t] }); heldSessions += x.hold; }
    for (const x of sim.open) { opens.push({ ...x, markNet: x.gross - COST }); heldSessions += x.hold; }
    for (const x of [...sim.closed, ...sim.open]) { const no = nextOpenOf(P, x); if (no.open) noOpen.push(no); else noAll.push({ ...no, net: no.gross - COST }); }
    symbolSessions += P.d.filter((d) => d >= P.from && d <= ENTRY_TO).length;
  }
  const head = summarise(closed), S2 = summarise(closed, { netOf: (x) => x.gross - COST_2X });
  const ppC = placeboPrepC(closed, PS), plC = placeboRunC(ppC, PS, { draws: PLACEBO_DRAWS, seed: PLACEBO_SEED, cost: COST }), dC = pairedDiffs(head, plC), tC = nwT(dC);
  // gates in force: the registered bar for the timing t gates unless the pre-read token was recorded (then its bar; the registered
  // verdict is computed and reported beside it either way)
  const tokenInForce = !!(dec && dec.timingBar != null), timingBar = tokenInForce ? dec.timingBar : bar;
  // where the real timing statistics sit among the controls run's 60 drift-kept no-edge scrambles (REPORTED ONLY)
  const keptPl = cal.driftKept.map((r) => r.placeboPairedT), keptFt = cal.driftKept.map((r) => r.floorTVsP50);
  const sortedPl = keptPl.filter(fin).sort((a, b) => a - b), sortedFt = keptFt.filter(fin).sort((a, b) => a - b), tn = cal.timingNull;
  const placebo = { form: "corrected matched placebo, paired NW t (registered gate)", draws: PLACEBO_DRAWS, seed: PLACEBO_SEED, slots: plC.slots, months: plC.months,
    pairedDiffMean: dC.length ? mean(dC) : null, pairedDiffMeanPctPerMonth: dC.length ? r4(100 * mean(dC)) : null, pairedDiffT: r4(tC), pairedDiffTRaw: tC, pairedMonths: dC.length, pairedTAtLeastBar: tC != null && tC >= bar,
    pairedTAtLeastTimingBarInForce: tC != null && tC >= timingBar, timingBarInForce: timingBar,
    nullPercentileDriftKept: nullRank(keptPl, tC), nullP95DriftKept: nearestRank(sortedPl, 0.95),
    sizeNote: `REPORTED ONLY: on this controls run ${r1(100 * tn.placeboPairedT.driftKept.atRegisteredBar)}% of no-edge drift-kept scrambles reach the registered ${bar} and ${r1(100 * tn.placeboPairedT.driftKept.atNullP95Bar)}% reach ${TIMING_BAR_NULL_P95}; repair audit 2026-10-02 on this runner (400 fresh drift-kept scrambles / 400 real-path nulls): 1.5% / 1.5% at 1.66, 4.0% / 2.8% at 1.30, no-edge p95 1.18 / 1.07 — the registered gate is conservative (size ~1.5%, not 5%)`,
    p95: plC.p95, observed: head.meanNet, beats: head.meanNet != null && plC.p95 != null && head.meanNet > plC.p95, p95PctPerMonth: r4(100 * plC.p95), observedPctPerMonth: head.meanNetPctPerMonth,
    p50: plC.p50, p05: plC.p05, meanOfDraws: plC.meanOfDraws, meanPctPerMonth: r4(100 * plC.meanOfDraws), widenedPerDraw: r3(plC.widenedPerDraw), droppedPerDraw: r3(plC.droppedPerDraw),
    p95Note: `REPORTED ONLY, never a gate: the p95 form is beaten by ${r1(100 * cal.placeboP95Form.driftKeptShareBeaten)}% of no-edge drift-kept scrambles`,
    calibration: { pairedTAtLeastBarDriftKept: cal.perGateDriftKept.correctedPlaceboPairedTAtLeastBar, pairedTAtLeastBarDriftFree: cal.perGateDriftFree.correctedPlaceboPairedTAtLeastBar, pairedTDriftKept: cal.distributions.driftKept.placeboPairedT },
    method: "per real trade: a random day of the same ETF in the same calendar month (+-1 month if none), inside that ETF's entry window, not an entry-signal day (IBS < 0.1), not a synthetic halt day; the window [i, i+H] disjoint from the real trade's [t-3, u] and spanning no synthetic bar; H drawn from the holds of OTHER ETFs' real trades; 0.06% cost; 500 draws seed 313. Paired diff = real monthly mean minus the placebo monthly mean averaged over draws; NW t (lag 1) over months." };
  const fl = cal.floor.all, fg0 = floorGate(head, fl, bar), fgT = floorGate(head, fl, timingBar);
  const floor = { ...fg0, tVsP50AtLeastTimingBarInForce: fgT.tVsP50AtLeastBar, clearsAtTimingBarInForce: fgT.clears, timingBarInForce: timingBar, seeds: fl.seeds, method: cal.floor.method,
    nullPercentileDriftKept: nullRank(keptFt, fg0.tVsP50Raw), nullP95DriftKept: nearestRank(sortedFt, 0.95),
    sizeNote: `REPORTED ONLY: the t vs p50 part reaches the registered ${bar} on ${r1(100 * tn.floorTVsP50.driftKept.atRegisteredBar)}% of no-edge drift-kept scrambles (leave-one-out floor) and ${TIMING_BAR_NULL_P95} on ${r1(100 * tn.floorTVsP50.driftKept.atNullP95Bar)}%; repair audit 2026-10-02 (400 drift-kept / 400 real-path nulls): 1.5% / 0.3% at 1.66, 5.0% / 1.8% at 1.30, no-edge p95 1.29 / 0.88; it divides by the real series' full NW error, which carries month-level market variance the floor has already removed` };
  const halves = { first: head.halves ? head.halves.first : { meanNet: null, months: 0 }, second: head.halves ? head.halves.second : { meanNet: null, months: 0 } };
  const controls = { leakPass: !!ctrl.leakTest.pass, positivePass: !!ctrl.positiveControl.pass, leakT: [ctrl.leakTest.seed1.tNW, ctrl.leakTest.seed2.tNW], positiveT: ctrl.positiveControl.result.tNW,
    wholeRuleFalsePassDriftKept: cal.wholeRule.driftKeptFalsePass, timingTokenWholeRuleFalsePassDriftKept: cal.timingTokenGateSet.driftKeptFalsePass, file: `backend/data/${path.basename(CTRL)}`, asOf: ctrl.asOf };
  const core = { trades: head.trades, months: head.months, meanNet: head.meanNet, tNW: head.tNetRaw, halfFirst: halves.first.meanNet, halfSecond: halves.second.meanNet, meanNet2x: S2.meanNet,
    placeboPairedT: tC, floorMeanAboveP95: fg0.meanAboveP95, leakPass: controls.leakPass, positivePass: controls.positivePass, bar };
  const Dreg = decide({ ...core, floorTVsP50AtLeastBar: fg0.tVsP50AtLeastBar });                                       // the registered gates
  const D0 = tokenInForce ? decide({ ...core, floorTVsP50AtLeastBar: fgT.tVsP50AtLeastBar, timingBar }) : Dreg;           // the gates in force
  const { gates, verdictScript } = D0;

  // reported (never gated)
  const sumOf = (items, o) => strip(summarise(items, o));
  const qq = cache.rows.QQQ ? (() => { const P = prepSym(cache, "QQQ"), sm = simulate(P, "QQQ"); return { note: "IN-SAMPLE — QQQ is the reel's own instrument, examined before registration; never gated", ...sumOf(sm.closed.map((x) => ({ ...x, net: x.gross - COST }))), openTrades: sm.open.length }; })() : { note: "QQQ missing from the cache" };
  const holds = closed.map((x) => x.hold).sort((a, b) => a - b), inc = closed.filter((x) => !x.rsi2Cover);
  for (const s of UNIVERSE) perEtf[s] = { entryFrom: cache.coverage[s].entryFrom, ...slim(summarise(closed.filter((x) => x.sym === s))), winRatePct: summarise(closed.filter((x) => x.sym === s)).winRatePct, openAtLastBar: opens.filter((x) => x.sym === s).length };
  const perYear = {}; for (const [i, k] of (head._keys || []).entries()) { const y = k.slice(0, 4); (perYear[y] || (perYear[y] = { months: [], trades: [] })).months.push(head._series[i]); }
  for (const x of closed) perYear[x.month.slice(0, 4)].trades.push(x.net);
  const noS = summarise(noAll), noSig = summarise(noAll, { monthOf: (x) => x.signalMonth });
  const openMarkedIn = summarise([...closed, ...opens.map((x) => ({ ...x, net: x.markNet }))]);
  const barCheck = head.months >= 3 ? { registered: bar, registeredForN: entry.nExpected, observedN: head.months, ...barAtN(head.months) } : { registered: bar, observedN: head.months };
  barCheck.borderline = barCheck.bar != null && head.tNetRaw != null && head.tNetRaw >= bar && head.tNetRaw < barCheck.bar;
  // data-quality sensitivity (REPORTED): trades whose hold crosses a missing session or the end of an additive price adjustment
  const cov = coverageSummary(cache), tradeRow = (x) => ({ sym: x.sym, entryDate: x.entryDate, exitDate: x.exitDate, hold: x.hold, netPct: r4(100 * x.net) });
  const spanBrk = closed.filter((x) => (cov.additiveBreaks[x.sym] || []).some((b) => x.entryDate < b.nextBar && b.nextBar <= x.exitDate));
  const spanGap = closed.filter((x) => (cov.missingSessions[x.sym] || []).some((d) => x.entryDate < d && d < x.exitDate));
  const byMonth = new Map((head._keys || []).map((k, i) => [k, head._series[i]]));
  const postDecPaired = plC.monthKeys.map((k, i) => (k >= "2001-02" ? byMonth.get(k) - plC.monthPlaceboMean[i] : NaN)).filter(fin);
  const reported = {
    postDecimal: { note: "entries from 2001-02-01 (AMEX ETF decimalisation 2001-01-29; earlier closes sit on a 1/16 grid — 0.3-0.65% ticks on EWA/EWC, where IBS < 0.1 / > 0.9 is a bid / ask print, a bounce the 0.06% cost does not charge). The placebo paired t uses the full-sample placebo restricted to these months.",
      ...sumOf(closed.filter((x) => x.entryDate >= "2001-02-01")), placeboPairedT: r4(nwT(postDecPaired)), placeboPairedMonths: postDecPaired.length },
    dataQuality: {
      spanningAdditiveBreak: { note: "hold crosses the last bar of an additive price adjustment (that bar's return carries the whole offset)", count: spanBrk.length, trades: spanBrk.map(tradeRow), breaks: cov.additiveBreaks },
      spanningMissingSession: { note: "hold crosses a session missing from that ETF's feed (two days merged into one bar)", count: spanGap.length, trades: spanGap.map(tradeRow), ...(spanGap.length ? { meanPerTradePct: r4(100 * mean(spanGap.map((x) => x.net))) } : {}) },
      weekendRowsDropped: cov.weekendRowsDropped },
    partialExit: { note: "slide 3 rules 3+4: same entries and final exits; 50% sold at the close of the first day with IBS > 0.5, the rest at IBS > 0.9; 0.06% once", ...sumOf(closed, { netOf: (x) => x.partialNet }) },
    qqqInSample: qq,
    nextOpen: { note: "same signals filled at o[t+1], exited at o[u+1]; grouped by the fill month (signal-month grouping beside it)", ...strip(noS), openTrades: noOpen.length, bySignalMonth: { meanNetPctPerMonth: noSig.meanNetPctPerMonth, months: noSig.months, tNet: noSig.tNet } },
    perEtf,
    post2014: { note: `entries from ${POST_PUB_FROM} (after the IBS publications, 2013-14)`, ...sumOf(closed.filter((x) => x.entryDate >= POST_PUB_FROM)) },
    pre2014: { note: `entries before ${POST_PUB_FROM}`, ...sumOf(closed.filter((x) => x.entryDate < POST_PUB_FROM)) },
    cost2x: { note: "same trades at 0.12% round trip (gated: mean > 0)", ...strip(S2) },
    inMarket: { heldSessions, symbolSessions, share: symbolSessions ? r4(heldSessions / symbolSessions) : null, note: "sessions held (u - t per trade, open trades to the last bar) / gated ETF-sessions inside each ETF's entry window" },
    rsi2Overlap: { note: "R150's RSI-2 long rule (close > SMA200, close < SMA5, RSI(2) Wilder < 10; exit first close > SMA5), simulated close-to-close per ETF over the whole series",
      r313Entries: closed.length, shareRsi2EntryFiresSameDay: closed.length ? r4(closed.filter((x) => x.rsi2Fires).length / closed.length) : null,
      shareRsi2ConditionTrueSameDay: closed.length ? r4(closed.filter((x) => x.rsi2Raw).length / closed.length) : null,
      shareRsi2FiresOrPositionOpen: closed.length ? r4(closed.filter((x) => x.rsi2Cover).length / closed.length) : null,
      increment: { note: "R313 trades entered on an ETF-day with no RSI-2 entry and no RSI-2 position open", ...sumOf(inc) } },
    holdDays: { unit: "trading days (u - t)", median: nearestRank(holds, 0.5), p90: nearestRank(holds, 0.9), max: holds.length ? holds[holds.length - 1] : null, mean: holds.length ? r3(mean(holds)) : null, method: "nearest rank" },
    perYear: Object.fromEntries(Object.entries(perYear).sort().map(([y, v]) => [y, { months: v.months.length, meanNetPctPerMonth: r4(100 * mean(v.months)), trades: v.trades.length, meanPerTradePct: r4(100 * mean(v.trades)), winRatePct: r1(100 * v.trades.filter((x) => x > 0).length / v.trades.length) }])),
    openMarkedIn: { note: "open trades marked to the last close and COUNTED (sensitivity; one-sided censoring)", ...slim(openMarkedIn) },
    barCheck: { ...barCheck, note: "The registered bar applies unchanged. A t in [registered bar, the same method's bar at the observed n) is flagged borderline for the seal note." },
  };
  const out = {
    id: ID, spec: "r313-read-v1", read: true, asOf: new Date().toISOString(), unit: "months", n: head.months, months: head.months, trades: head.trades,
    tNet: head.tNet, tNetRaw: head.tNetRaw, meanNet: head.meanNet, meanNetPctPerMonth: head.meanNetPctPerMonth, winRate: head.winRate, winRatePct: head.winRatePct, meanPerTradePct: head.meanPerTradePct,
    placebo, floor, halves, cost2x: { meanNet: S2.meanNet, meanNetPctPerMonth: S2.meanNetPctPerMonth }, controls, bar, barSource: "test-registry.json R313 bar.tRequired", preReadDecision: dec,
    timingBarInForce: timingBar, gatesInForce: tokenInForce ? `pre-read amendment ${JSON.stringify(dec.tokens)}` : "registered",
    gates, failedGates: D0.failed, verdictScript,
    ...(tokenInForce ? { registeredGates: { gates: Dreg.gates, failedGates: Dreg.failed, verdictScript: Dreg.verdictScript, note: "the registered decisionRule.pass (timing t gates at the registered bar), reported beside the amended verdict" } } : {}),
    openAtLastBar: { count: opens.length, marks: opens.map((x) => ({ sym: x.sym, entryDate: x.entryDate, entry: x.entry, markDate: x.markDate, mark: x.mark, markNetPct: r4(100 * x.markNet), sessionsHeld: x.hold })) },
    ignoredSignalsWhileLong: ignored, reported,
    cache: { file: CACHE_REL, sha256: sha }, coverage: cov,
    implementationNotes: [
      "Each ETF enters from Jan 1 of its first full calendar year of data (first bar on/before Jan 4), never before 2000-01-01; position state starts flat.",
      "IBS undefined when high <= low: no entry and no exit that day. Thresholds strict (< 0.1, > 0.9).",
      "Placebo candidate days exclude entry-signal days (IBS < 0.1) and synthetic halt days and stay inside each ETF's entry window (R310's corrected design; R313 has no SMA200 condition).",
      `Bars dated after ${LAST_BAR} are dropped (forming-bar guard); trades still open at ${LAST_BAR} are reported, not counted.`,
      "Schwab daily history is split-adjusted price only (no dividends).",
      "Weekend rows of the feed (2007-01-06/07 copies of 2007-01-05) are dropped at unpack; the cache file is unchanged.",
      "Some ETFs carry one additive adjustment on every price before a boundary (XLE/XLV 2019-12-27, EEM 2019-12-13, EWG 2020-12-11 and 2021-12-29): IBS is unaffected, the boundary bar's return carries the whole offset. Detected and reported (reported.dataQuality), never altered.",
    ],
  };
  const lines = [
    `R313 READ — ${verdictScript} (bar t_NW >= ${bar}; timing t gates >= ${timingBar}${tokenInForce ? ` by pre-read amendment; registered-gate verdict ${Dreg.verdictScript}` : ", registered"})`,
    `  trades ${head.trades} · months ${head.months} · net %/month ${head.meanNetPctPerMonth} · t_NW ${head.tNet} · win ${head.winRatePct}% · per trade ${head.meanPerTradePct}%`,
    `  corrected placebo paired diff ${placebo.pairedDiffMeanPctPerMonth}%/month t ${placebo.pairedDiffT} (${placebo.pairedTAtLeastTimingBarInForce ? ">=" : "<"} ${timingBar}) · p95 form ${placebo.p95PctPerMonth} (reported only)`,
    `  drift-kept floor p50 ${floor.p50PctPerMonth} / p95 ${floor.p95PctPerMonth} -> mean > p95 ${floor.meanAboveP95} · t vs p50 ${floor.tVsP50} ${floor.clearsAtTimingBarInForce ? "CLEARS" : "does not clear"} (at ${timingBar})`,
    `  null percentile among the ${sortedPl.length} drift-kept no-edge scrambles (reported only): placebo t ${placebo.nullPercentileDriftKept} (their p95 ${r3(placebo.nullP95DriftKept)}) · floor t ${floor.nullPercentileDriftKept} (their p95 ${r3(floor.nullP95DriftKept)})`,
    `  halves ${halves.first.meanNetPctPerMonth}/${halves.second.meanNetPctPerMonth} · 2x cost ${S2.meanNetPctPerMonth}%/month · open at last bar ${opens.length} · bar at n=${barCheck.observedN} ${barCheck.bar}${barCheck.borderline ? " — BORDERLINE" : ""}`,
    `  post-decimal (from 2001-02) ${reported.postDecimal.meanNetPctPerMonth}%/month t ${reported.postDecimal.tNet} placebo t ${reported.postDecimal.placeboPairedT} · spanning an adjustment break ${spanBrk.length} · spanning a missing session ${spanGap.length} trades`,
    `  gates ${JSON.stringify(gates)}`,
  ];
  return { out, lines };
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  let st; try { st = selftest(); } catch (e) { st = { pass: false, checks: {}, detail: { threw: e.message } }; }      // a throwing selftest is a FAIL, never a pass
  console.log(`R313 selftest ${st.pass ? "PASS" : "FAIL"} ${JSON.stringify(st.checks)}`);
  if (!st.pass) { console.log(`  detail ${JSON.stringify(st.detail)}`); process.exit(1); }
  if (SELFTEST_ONLY) return;

  if (!READ) {
    // CONTROLS RUN — summarises ONLY scrambles (drift-free and drift-kept) and the winners-only look-ahead subset of real trades;
    // no unfiltered real statistic is computed or written.
    const { cache, sha, fetched } = await loadOrFetch(true), cov = coverageSummary(cache);
    console.log(`R313 bars ${fetched ? "fetched + cached" : "from cache"} — ${cov.priced}/${cov.gated} gated ETFs priced; sha256 ${sha}`);
    const entry = registryEntry(), bar = entry && entry.bar ? Number(entry.bar.tRequired) : NaN;
    if (!fin(bar)) { console.error(`${ID} registry entry missing or has no numeric bar.tRequired — refusing`); process.exit(2); }
    if (!cov.ok) { console.error(`${ID} coverage incomplete — missing ${JSON.stringify(cov.gatedMissing)}, stale ${JSON.stringify(cov.lastBarNot20261001)}; R313 NOT READY`); process.exit(2); }
    // REGISTERED leak test (seeds 1, 2, drift-free) — a null t is unmeasured, so it FAILS (fail closed)
    const leak = [1, 2].map((seed) => { const tr = []; for (const s of UNIVERSE) { const P = prepSym(cache, s, scramble(unpack(cache.rows[s]), seed, s, true)); for (const x of simulate(P, s).closed) tr.push({ ...x, net: x.gross - COST }); } return summarise(tr); });
    const winners = [];
    for (const s of UNIVERSE) for (const x of simulate(prepSym(cache, s), s).closed) { const net = x.gross - COST; if (net > 0) winners.push({ ...x, net }); }   // filtered at once
    const peek = summarise(winners);
    const leakOk = leak.every((a) => a.tNetRaw != null && a.tNetRaw < 2), peekOk = peek.tNetRaw != null && peek.tNetRaw >= 3;
    console.log(`R313 calibrating the WHOLE decision rule on ${FLOOR_SEEDS} drift-kept + ${FREE_SEEDS} drift-free scrambles (placebo ${PLACEBO_DRAWS} draws each) ...`);
    const t0 = Date.now(), kept = [], free = [];
    for (let s = 1; s <= FLOOR_SEEDS; s++) { kept.push(scrambleRun(cache, s, false)); if (s % 10 === 0) console.log(`  drift-kept ${s}/${FLOOR_SEEDS} (${((Date.now() - t0) / 1000).toFixed(0)} s)`); }
    for (let s = 1; s <= FREE_SEEDS; s++) free.push(scrambleRun(cache, s, true));
    const calibration = calibrate(kept, free, bar), decision = preReadDecision(entry);
    const pass = leakOk && peekOk && cov.ok, ready = pass && calibration.ok && calibration.wholeRule.calibrated && decision.decided;
    const holdWhy = !cov.ok ? "coverage incomplete" : !calibration.ok ? "calibration incomplete" : !calibration.wholeRule.calibrated ? `whole-rule false pass ${calibration.wholeRule.driftKeptFalsePass} > ${MAX_WHOLE_RULE_FALSE_PASS} on drift-kept scrambles — the read is held for a pre-evidence amendment` : !decision.decided ? `pre-read decision invalid (${decision.why})` : null;
    writeJsonAtomic(CTRL, { spec: "r313-controls-v1", id: ID, asOf: new Date().toISOString(), runner: { file: `backend/${path.basename(__filename)}`, sha256: sha256(fs.readFileSync(__filename)) },
      cache: { file: CACHE_REL, sha256: sha, fetchedAt: cache.fetchedAt, source: cache.source }, coverage: cov,
      etfs: UNIVERSE.filter((s) => cache.rows[s]).map((s) => ({ symbol: s, firstBar: cache.coverage[s].firstBar, lastBar: cache.coverage[s].lastBar, bars: cache.coverage[s].bars, entryFrom: cache.coverage[s].entryFrom })), selftest: st,
      leakTest: { method: "drift-free bar shuffle within each ETF (R150 scramble, demean=true), seeds 1, 2; the R313 rule run unchanged on the scrambles", requirement: "t_NW < 2 on both seeds (a null t fails)", pass: leakOk, seed1: slim(leak[0]), seed2: slim(leak[1]),
        diagnostic20Seeds: calibration.distributions.driftFree.tNW },
      positiveControl: { method: "R313 trades whose own realised net (after 0.06%) is positive — outcome look-ahead", requirement: "t_NW >= 3", pass: peekOk, result: slim(peek) },
      pass, calibration, preReadDecision: decision, ready, holdWhy,
      operatorOption: { status: "NOT RECORDED — the registered gates are calibrated (whole-rule false pass <= 5%) and are in force; this is an optional power fix, the operator's decision, and only valid BEFORE the read",
        where: "backend/data/test-registry.json, the R313 entry: append to amendments[] (create it) BEFORE the read, plus a dated change-registry entry",
        shape: { date: "YYYY-MM-DD", preEvidence: true, field: "controls.placebo / controls.driftFloor / decisionRule.pass (timing t bars)", was: `corrected placebo paired t >= ${bar}; drift-floor t vs p50 >= ${bar}`, becomes: `corrected placebo paired t >= ${TIMING_BAR_NULL_P95}; drift-floor t vs p50 >= ${TIMING_BAR_NULL_P95}; t_NW >= ${bar} and every other gate unchanged`, why: "...", runnerGates: [TIMING_TOKEN] },
        tokens: RUNNER_GATES, tokenGateSetCalibrated: calibration.timingTokenGateSet.calibrated },
      note: "Only scrambles (drift-free and drift-kept) and the winners-only look-ahead subset of real trades are summarised; no unfiltered real statistic is computed or written." });
    const c = calibration, pc = (x) => (x == null ? null : +(100 * x).toFixed(1));
    console.log(`R313 controls — leak ${leakOk ? "PASS" : "FAIL"} seed 1 ${JSON.stringify(slim(leak[0]))} · seed 2 ${JSON.stringify(slim(leak[1]))}`);
    console.log(`  20-seed drift-free t ${JSON.stringify(c.distributions.driftFree.tNW)}`);
    console.log(`  positive control ${peekOk ? "PASS" : "FAIL"} ${JSON.stringify(slim(peek))}`);
    console.log(`  drift-kept floor p50 ${c.floor.all.p50PctPerMonth} / p95 ${c.floor.all.p95PctPerMonth} %/month (min ${c.floor.all.minPctPerMonth}, max ${c.floor.all.maxPctPerMonth})`);
    console.log(`  per-gate false pass, drift-kept: ${JSON.stringify(Object.fromEntries(Object.entries(c.perGateDriftKept).map(([k, v]) => [k, pc(v)])))}`);
    console.log(`  per-gate false pass, drift-free: ${JSON.stringify(Object.fromEntries(Object.entries(c.perGateDriftFree).map(([k, v]) => [k, pc(v)])))}`);
    console.log(`  gate sets (drift-kept): core only ${pc(c.gateSets.coreOnlyDriftKept)}% · core + placebo ${pc(c.gateSets.corePlusPlaceboDriftKept)}% · core + floor ${pc(c.gateSets.corePlusFloorDriftKept)}%`);
    console.log(`  WHOLE RULE false pass: drift-kept ${c.wholeRule.driftKeptPasses}/${c.wholeRule.driftKeptSeeds} = ${pc(c.wholeRule.driftKeptFalsePass)}% · drift-free ${c.wholeRule.driftFreePasses}/${c.wholeRule.driftFreeSeeds} = ${pc(c.wholeRule.driftFreeFalsePass)}% (limit ${pc(MAX_WHOLE_RULE_FALSE_PASS)}%)`);
    const tnP = c.timingNull.placeboPairedT.driftKept, tnF = c.timingNull.floorTVsP50.driftKept, tg = c.timingTokenGateSet;
    console.log(`  timing nulls (reported): placebo t mean ${tnP.mean} sd ${tnP.sd} p95 ${tnP.p95} · >= ${bar} ${pc(tnP.atRegisteredBar)}% · >= ${TIMING_BAR_NULL_P95} ${pc(tnP.atNullP95Bar)}% | floor t mean ${tnF.mean} sd ${tnF.sd} p95 ${tnF.p95} · >= ${bar} ${pc(tnF.atRegisteredBar)}% · >= ${TIMING_BAR_NULL_P95} ${pc(tnF.atNullP95Bar)}%`);
    console.log(`  optional token ${TIMING_TOKEN} (NOT in force without a pre-read amendment): whole rule drift-kept ${tg.driftKeptPasses}/${tg.driftKeptSeeds} = ${pc(tg.driftKeptFalsePass)}% · drift-free ${tg.driftFreePasses}/${tg.driftFreeSeeds} = ${pc(tg.driftFreeFalsePass)}% · calibrated ${tg.calibrated}`);
    console.log(`  placebo p95 form (reported only) beaten ${pc(c.placeboP95Form.driftKeptShareBeaten)}% drift-kept / ${pc(c.placeboP95Form.driftFreeShareBeaten)}% drift-free · scramble t_NW drift-kept ${JSON.stringify(c.distributions.driftKept.tNW)}`);
    console.log(`  coverage: late entry start ${JSON.stringify(cov.lateEntryStart)} · dropped after ${LAST_BAR} ${JSON.stringify(cov.droppedAfterLastBar)} · bar flags ${JSON.stringify(cov.barFlags)}`);
    console.log(`  data diagnostics: weekend rows dropped ${JSON.stringify(cov.weekendRowsDropped)} · missing sessions ${JSON.stringify(Object.fromEntries(Object.entries(cov.missingSessions).map(([s, v]) => [s, v.length])))} · additive-adjustment ends ${JSON.stringify(Object.fromEntries(Object.entries(cov.additiveBreaks).map(([s, v]) => [s, v.map((b) => b.lastOffsetBar)])))}`);
    console.log(`  pre-read decision: ${decision.decided ? (decision.registered ? "registered gates (no amendment)" : JSON.stringify(decision.tokens)) : `INVALID — ${decision.why}`} · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    console.log(ready ? `R313 READY — the one read is: node backend/${path.basename(__filename)} --read` : `R313 NOT READY — ${!pass ? "a registered control or coverage failed" : holdWhy}`);
    return;
  }

  // ── THE READ (once) ──
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests && seals.tests[ID]) { console.error(`${ID} already sealed — refusing`); process.exit(2); }
  if (fs.existsSync(OUT) && JSON.parse(fs.readFileSync(OUT, "utf8")).read) { console.error(`${ID} already read — seal it, do not re-read`); process.exit(2); }
  const entry = registryEntry();
  if (!entry) { console.error(`${ID} not registered`); process.exit(2); }
  const ctrl = fs.existsSync(CTRL) ? JSON.parse(fs.readFileSync(CTRL, "utf8")) : null;
  if (!ctrl || ctrl.spec !== "r313-controls-v1" || !ctrl.pass) { console.error(`${ID} controls have not passed (or no controls file)`); process.exit(2); }
  if (!ctrl.calibration || !ctrl.calibration.ok) { console.error(`${ID} controls file has no complete calibration — re-run the controls`); process.exit(2); }
  const runnerSha = sha256(fs.readFileSync(__filename));
  if (!ctrl.runner || ctrl.runner.sha256 !== runnerSha) { console.error(`${ID} controls were produced by a different runner (${ctrl.runner && ctrl.runner.sha256} vs ${runnerSha}) — re-run the controls`); process.exit(2); }
  const bar = Number(entry.bar && entry.bar.tRequired); if (!fin(bar)) { console.error(`${ID} registry entry has no numeric bar.tRequired`); process.exit(2); }
  if (ctrl.calibration.bar !== bar) { console.error(`${ID} controls calibrated at bar ${ctrl.calibration.bar}, registry says ${bar} — re-run the controls`); process.exit(2); }
  const dec = preReadDecision(entry);
  if (!dec.decided) { console.error(`${ID} read HELD — ${dec.why}`); process.exit(2); }
  if (!ctrl.calibration.wholeRule.calibrated) { console.error(`${ID} read HELD — the whole decision rule false-passes ${ctrl.calibration.wholeRule.driftKeptFalsePass} of drift-kept no-edge scrambles (> ${MAX_WHOLE_RULE_FALSE_PASS}); a pre-evidence amendment is required`); process.exit(2); }
  if (dec.timingBar != null && !(ctrl.calibration.timingTokenGateSet && ctrl.calibration.timingTokenGateSet.calibrated && ctrl.calibration.timingTokenGateSet.timingBar === dec.timingBar)) {
    console.error(`${ID} read HELD — ${TIMING_TOKEN} is recorded but the controls run does not show that gate set calibrated (whole-rule false pass <= ${MAX_WHOLE_RULE_FALSE_PASS} at ${dec.timingBar}) — re-run the controls`); process.exit(2); }
  const { cache, sha } = await loadOrFetch(false);
  if (!ctrl.cache || ctrl.cache.sha256 !== sha) { console.error(`${ID} bar cache sha256 ${sha} differs from the controls run's ${ctrl.cache && ctrl.cache.sha256} — refusing`); process.exit(2); }
  const { out, lines } = computeRead({ cache, sha, ctrl, entry, dec, bar });
  writeJsonAtomic(OUT, out);
  for (const l of lines) console.log(l);
}
// Run only when invoked directly. A require() gets the pure functions and never reaches main: no fetch, no write.
if (require.main === module) main().catch((e) => { console.error("R313 FAILED:", e.message); process.exit(1); });
else module.exports = { ibsOf, entryFromOf, prep, simulate, partialGross, nextOpenOf, rsi2Coverage, summarise, nwT, mean, scramble, unpack, isWeekend, placeboPrepC, placeboRunC, pairedDiffs, floorGate, decide,
  preReadDecision, calibrate, judgeScramble, nullRank, scrambleRun, barAtN, computeRead, schwabDate, packRows, coverageSummary, sessionDiagnostics, additiveBreaksOf, selftest, mulberry, shiftMonth,
  RUNNER_GATES, TIMING_TOKEN, TIMING_BAR_NULL_P95, UNIVERSE, CACHE, COST, COST_2X, ENTRY_FROM, ENTRY_TO, PLACEBO_DRAWS, PLACEBO_SEED, fin };
