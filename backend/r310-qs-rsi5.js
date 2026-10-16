#!/usr/bin/env node
/**
 * R310 — QUANTIFIED STRATEGIES' RSI(5) DIP-BUY (registered 2026-10-02; Facebook carousel slides 2-3; operator: "test it").
 * The frozen spec is the R310 entry of data/test-registry.json (preregistered). This runner implements that entry and nothing else.
 * Harness pattern copied from r150-classics.js (R150, sealed sibling): selftest -> controls run -> one --read.
 *
 *   UNIVERSE (gated, 114) data/r147-universe.json (100 names) + QQQ IWM DIA XLK XLF XLE XLV XLY XLP XLI XLU XLB XLRE XLC.
 *            SPY is fetched separately and appears ONLY in the reported block (it was previewed before registration).
 *   DATA     Alpaca SIP daily bars (lib/alpaca-bars.js fetchBars), adjustment "all", requested 2015-01-01 .. 2026-10-01 — the
 *            feed's history starts 2016-01-04, so the first SMA200 (and first possible entry) is ~2016-10-17 (the last complete
 *            bar — the request ends 2026-10-01T21:00Z so no forming bar can arrive). Cached ONCE under data/training/r310/ so the
 *            controls run and the read use byte-identical inputs; the sha256 of the cache file is written into both outputs and
 *            the read refuses on a mismatch. The read never refetches.
 *   RULE     RSI(5) Wilder as TradingView ta.rsi (rma seeded with the simple mean of the first 5 changes); SMA200 on closes.
 *            ENTRY at the close of t, t dated 2016-01-01..2026-09-30, when RSI5[t] < 30 AND RSI5[t] < RSI5[t-1] < RSI5[t-2] <
 *            RSI5[t-3] AND RSI5[t-3] < 60 AND close[t] > SMA200[t], every input finite. One position per symbol; a signal while
 *            long is ignored. EXIT at the close of the first u > t with RSI5[u] > 50 AND RSI5[u-1] <= 50. No stop, no cap.
 *            Trades open at the last bar are reported (count, symbols, mark), not counted. net = exit/entry - 1 - 0.0010.
 *   STAT     month of entry (YYYY-MM); per month the mean net of trades entered that month; headline Newey-West t, lag 1
 *            (Bartlett weight 0.5 at lag 1: v += sum(d_i d_{i-1}) / n), the nwT of register-r310.js / r150-classics.js.
 *   GATES    (registry decisionRule) >= 100 trades over >= 36 months, mean > 0, t_NW >= bar (read from the registry), matched
 *            random-entry placebo p95 beaten (500 draws), both halves > 0, next-open mean > 0, leak test + positive control.
 *
 *   REPAIR 2026-10-02 (two reviewers; scrambles only, no real-trade statistic computed). The REGISTERED placebo cannot fail: its
 *   same-month draws sit on the slide that produced the entry and its hold is the real trade's path-dependent exit, so on 60/60
 *   drift-kept and 20/20 drift-free no-edge scrambles the observed mean beats the placebo p95, and the FULL registered decision rule
 *   returns PASS on 60/60 drift-kept scrambles (nothing in it removes per-symbol drift or survivorship). The rule, bar and population
 *   are unchanged here. What changed: (1) the controls run calibrates the registered placebo, a CORRECTED placebo and R150's
 *   drift-kept floor on 60 drift-kept + 20 drift-free scrambles; (2) the read is HELD until the R310 registry entry records a
 *   pre-read decision (amendments[] with preEvidence:true and runnerGates — see RUNNER_GATES); (3) corrected placebo, floor, open-
 *   trade marks, synthetic-halt spans and the bar at the observed n are reported beside the headline; (4) a null leak t fails closed.
 *
 *   node backend/r310-qs-rsi5.js --selftest | (no flag: controls run, prints READY / NOT READY) | --read
 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const ID = "R310", READ = process.argv.includes("--read"), SELFTEST_ONLY = process.argv.includes("--selftest");
const OUT = D("r310-qs-rsi5.json"), CTRL = D("r310-controls.json");
const CACHE_DIR = path.join(__dirname, "data", "training", "r310"), CACHE = path.join(CACHE_DIR, "bars-sip-all-20150101-20261001.json");
const CACHE_REL = "backend/data/training/r310/bars-sip-all-20150101-20261001.json";
const FETCH_START = "2015-01-01", FETCH_END = "2026-10-01T21:00:00Z", LAST_BAR = "2026-10-01";
const ENTRY_FROM = "2016-01-01", ENTRY_TO = "2026-09-30";
const COST = 0.0010, COST_HI = 0.0020, MIN_TRADES = 100, MIN_MONTHS = 36, PLACEBO_DRAWS = 500, PLACEBO_SEED = 310;
const FLOOR_SEEDS = 60, LEAK_DIAG_SEEDS = 20;               // drift-kept scrambles 1..60 (floor + calibration), drift-free 1..20 (leak diagnostic)
// Pre-read decision tokens the runner understands (R310 registry entry: amendments[] { date, preEvidence: true, field, was, becomes,
// why, runnerGates: [...] }). Exactly one placebo:* token; the others optional. Unknown token -> the read is refused (fail closed).
const RUNNER_GATES = {
  "placebo:registered": "keep the registered matched-placebo p95 gate as written (acknowledged uncalibrated: cleared by every no-edge scramble); corrected placebo + floor reported only",
  "placebo:corrected-paired-t": "placebo gate = NW t of the monthly paired difference (real minus CORRECTED placebo) >= bar",
  "placebo:reported-only": "no placebo gate; registered and corrected placebos reported only",
  "floor:drift-kept": "add R150's drift-kept floor: real mean/month > floor p95 AND NW t of (real monthly series minus floor p50) >= bar",
  "trades:exclude-halt-spanning": "trades whose hold spans a synthetic halt bar (v=0, O=H=L=C) are reported, not counted (headline, gates, placebos, floor)",
};
const ETFS = ["QQQ", "IWM", "DIA", "XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLU", "XLB", "XLRE", "XLC"];
const fin = Number.isFinite, dateOf = (t) => String(t).slice(0, 10);
const r4 = (x) => (x == null || !fin(x) ? null : +x.toFixed(4)), r3 = (x) => (x == null || !fin(x) ? null : +x.toFixed(3)), r1 = (x) => (x == null || !fin(x) ? null : +x.toFixed(1));

// ── indicators ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// SMA over a fresh window sum: a NaN anywhere in the window gives NaN for that bar only (never a poisoned running sum).
function sma(a, n) { const o = new Array(a.length).fill(NaN); for (let i = n - 1; i < a.length; i++) { let s = 0; for (let k = i - n + 1; k <= i; k++) s += a[k]; o[i] = s / n; } return o; }
// TradingView ta.rma on a series whose first defined value sits at index `first`: seed = simple mean of the first n values.
function rmaSeeded(a, n, first) { const o = new Array(a.length).fill(NaN); if (a.length < first + n) return o; let s = 0; for (let i = first; i < first + n; i++) s += a[i]; o[first + n - 1] = s / n; for (let i = first + n; i < a.length; i++) o[i] = (a[i] + (n - 1) * o[i - 1]) / n; return o; }
// TradingView ta.rsi: change = ta.change(close) (na at bar 0); up/down = rma of max(change,0) / -min(change,0); down==0 -> 100, up==0 -> 0.
function rsiWilder(c, n) {
  const N = c.length, up = new Array(N).fill(NaN), dn = new Array(N).fill(NaN), out = new Array(N).fill(NaN);
  for (let i = 1; i < N; i++) { const ch = c[i] - c[i - 1]; up[i] = Math.max(ch, 0); dn[i] = Math.max(-ch, 0); }
  const ru = rmaSeeded(up, n, 1), rd = rmaSeeded(dn, n, 1);
  for (let i = 0; i < N; i++) { const u = ru[i], d = rd[i]; if (fin(u) && fin(d)) out[i] = d === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / d); }
  return out;
}

// ── the rule ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
function signalAt(c, r, s200, t) {
  if (t < 3) return false;
  const v = [r[t], r[t - 1], r[t - 2], r[t - 3], c[t], s200[t]];
  if (!v.every(fin)) return false;                                     // a NaN comparison can never pass
  const [r0, r1, r2, r3, ct, st] = v;
  return r0 < 30 && r0 < r1 && r1 < r2 && r2 < r3 && r3 < 60 && ct > st;
}
const crossUp50 = (r, u) => u >= 1 && fin(r[u]) && fin(r[u - 1]) && r[u] > 50 && r[u - 1] <= 50;
function prep(bars) {
  const c = bars.map((b) => b.c), o = bars.map((b) => b.o), d = bars.map((b) => dateOf(b.t));
  const r = rsiWilder(c, 5), s200 = sma(c, 200), sig = c.map((_, i) => signalAt(c, r, s200, i));
  // Alpaca fills halts / OTC gaps with SYNTHETIC bars: v = 0 and O = H = L = C (= the previous close). In this cache all 995 zero-volume
  // bars are of that kind (NBIS 622, SMCI 349, VRT 22, XLRE 2). FLAGGED, never altered: the registered rule runs on the bars as served;
  // the flag drives the halt-span sensitivity line, the corrected placebo's eligibility, and the optional trades:exclude-halt-spanning.
  const synth = bars.map((b) => b.v === 0 && b.o === b.h && b.h === b.l && b.l === b.c), synthCum = new Array(bars.length);
  for (let i = 0, k = 0; i < bars.length; i++) { if (synth[i]) k++; synthCum[i] = k; }
  return { n: bars.length, c, o, d, r, s200, sig, synth, synthCum };
}
// synthetic bars in [a, b] (clamped); a trade's hold window is (t, u] — (t, last] while open
const synthIn = (P, a, b) => { a = Math.max(0, a); b = Math.min(P.n - 1, b); return b < a ? 0 : P.synthCum[b] - (a > 0 ? P.synthCum[a - 1] : 0); };
const haltBarsIn = (P, x) => synthIn(P, x.t + 1, x.u === null ? P.n - 1 : x.u);
function mkTrade(P, sym, t, u) {
  const last = P.n - 1, x = u === null ? last : u;
  return { sym, t, u, entryDate: P.d[t], exitDate: u === null ? null : P.d[u], month: P.d[t].slice(0, 7), entry: P.c[t], exit: u === null ? null : P.c[u],
    hold: x - t, gross: P.c[x] / P.c[t] - 1, ...(u === null ? { markDate: P.d[last], mark: P.c[last] } : {}) };
}
// Flat at the start of the entry window (no pre-2016 entry is simulated); one position per symbol; a signal while long is ignored.
function simulate(P, sym, { from = ENTRY_FROM, to = ENTRY_TO } = {}) {
  const { n, d, r, sig } = P, closed = [], open = []; let pos = null, ignored = 0;
  const inWin = (i) => d[i] >= from && d[i] <= to;
  for (let i = 0; i < n; i++) {
    if (pos !== null) {
      if (crossUp50(r, i)) { closed.push(mkTrade(P, sym, pos, i)); pos = null; }
      else { if (sig[i] && inWin(i)) ignored++; continue; }
    }
    if (sig[i] && inWin(i)) pos = i;
  }
  if (pos !== null) open.push(mkTrade(P, sym, pos, null));
  return { closed, open, ignored };
}
// Next-open execution: the same signals, entry at o[t+1], exit at o[u+1]; no u (still open) or no u+1 bar -> open trade.
function nextOpenOf(P, x) {
  const e = x.t + 1;
  if (e > P.n - 1) return { open: true, sym: x.sym, t: x.t, signalMonth: x.month };
  if (x.u === null || x.u + 1 > P.n - 1) return { open: true, sym: x.sym, t: x.t, entryIdx: e, entry: P.o[e], signalMonth: x.month };
  const exitIdx = x.u + 1;
  return { open: false, sym: x.sym, t: x.t, u: x.u, entryIdx: e, exitIdx, entry: P.o[e], exit: P.o[exitIdx], gross: P.o[exitIdx] / P.o[e] - 1,
    month: P.d[e].slice(0, 7), signalMonth: x.month };
}
// R150's RSI-2 long rule, simulated close-to-close per symbol over the whole series (for the reported overlap only):
// entry at the close when flat and close > SMA200, close < SMA5, RSI(2) Wilder < 10; exit at the first later close > SMA5.
// cover[i] = 1 when an RSI-2 entry fires on day i or an RSI-2 position is held into day i's close (entry day .. day before exit).
function rsi2Coverage(P) {
  const { n, c, s200 } = P, r2 = rsiWilder(c, 2), s5 = sma(c, 5), fires = new Uint8Array(n), cover = new Uint8Array(n), raw = new Uint8Array(n), trades = [];
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

// ── statistics ───────────────────────────────────────────────────────────────────────────────────────────────────────────
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
// R150's scramble, verbatim: shuffle (gap, high/open, low/open, close/open, volume) within the symbol; demean = drift-free.
function scramble(bars, seed, key, demean = false) {
  const rng = mulberry(seed * 1000003 + hash(key)), p = [];
  for (let i = 1; i < bars.length; i++) { const x = bars[i]; p.push([x.o / bars[i - 1].c, x.h / x.o, x.l / x.o, x.c / x.o, x.v]); }
  if (demean && p.length) { const mu = p.reduce((s, x) => s + Math.log(x[0] * x[3]), 0) / p.length, k = Math.exp(-mu); for (const x of p) x[0] *= k; }
  for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  const out = [{ ...bars[0] }]; let c = bars[0].c;
  for (let i = 1; i < bars.length; i++) { const [go, gh, gl, gc, v] = p[i - 1], o = c * go; c = o * gc; out.push({ ...bars[i], o, h: o * gh, l: o * gl, c, v }); }
  return out;
}

// ── matched random-entry placebo (AS REGISTERED — kept verbatim; see the corrected form below) ─────────────────────────────
// KNOWN DEFECT (in the registered design, not the code): (a) the candidate month is the one that contains the dip, so same-month
// days before the entry carry the slide forward (drift-free scramble: -3.1%/trade before entry vs -0.4% after); (b) the hold is the
// real trade's own path-dependent exit (long H = sustained slide). Both push the placebo DOWN; it cannot fail on no-edge data.
const shiftMonth = (ym, k) => { let y = +ym.slice(0, 4), m = +ym.slice(5, 7) + k; while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; } return `${y}-${String(m).padStart(2, "0")}`; };
// Eligible placebo days: inside the entry window, close > SMA200 (both finite), and NOT a raw entry-signal day. For each real trade
// (symbol, month, hold H): the eligible days of that symbol in that month with d + H <= last bar; if none, widen to month-1..month+1
// (counted as widened); if still none, the trade is dropped from every draw (its candidate set is fixed, so the drop is the same).
function placeboPrep(trades, PS, { from = ENTRY_FROM, to = ENTRY_TO } = {}) {
  const elig = new Map();
  const eligOf = (sym) => {
    if (elig.has(sym)) return elig.get(sym);
    const P = PS[sym], m = new Map();
    for (let i = 0; i < P.n; i++) {
      if (P.d[i] < from || P.d[i] > to || P.sig[i]) continue;
      if (!(fin(P.c[i]) && fin(P.s200[i]) && P.c[i] > P.s200[i])) continue;
      const k = P.d[i].slice(0, 7); (m.get(k) || m.set(k, []).get(k)).push(i);
    }
    elig.set(sym, m); return m;
  };
  const slots = [], dropped = []; let widened = 0;
  for (const x of trades) {
    const P = PS[x.sym], m = eligOf(x.sym), H = x.hold, ok = (i) => i + H <= P.n - 1;
    let cands = (m.get(x.month) || []).filter(ok), wide = false;
    if (!cands.length) { wide = true; cands = [shiftMonth(x.month, -1), x.month, shiftMonth(x.month, 1)].flatMap((k) => m.get(k) || []).filter(ok); }
    if (!cands.length) { dropped.push({ sym: x.sym, month: x.month, entryDate: x.entryDate, hold: H }); continue; }
    if (wide) widened++;
    slots.push({ sym: x.sym, month: x.month, hold: H, wide, cands, gross: cands.map((i) => P.c[i + H] / P.c[i] - 1) });
  }
  return { slots, widened, dropped };
}
function placeboRun(pp, { draws, seed, cost, record = null }) {
  const rng = mulberry(seed), keys = [...new Set(pp.slots.map((s) => s.month))].sort(), M = keys.length, mi = new Map(keys.map((k, i) => [k, i]));
  const stat = [], monthAcc = new Float64Array(M), slotMi = pp.slots.map((s) => mi.get(s.month));
  for (let k = 0; k < draws; k++) {
    const s = new Float64Array(M), n = new Uint32Array(M);
    pp.slots.forEach((sl, q) => { const j = Math.floor(rng() * sl.cands.length), v = sl.gross[j] - cost; s[slotMi[q]] += v; n[slotMi[q]]++; if (record) record(sl, sl.cands[j], v); });
    let tot = 0; for (let i = 0; i < M; i++) { const mm = s[i] / n[i]; tot += mm; monthAcc[i] += mm; }      // every month has >= 1 slot by construction
    stat.push(M ? tot / M : NaN);
  }
  const sorted = [...stat].sort((a, b) => a - b);
  return { draws, seed, months: M, stats: stat, p95: sorted[Math.floor(0.95 * draws)], p50: sorted[Math.floor(0.5 * draws)], p05: sorted[Math.floor(0.05 * draws)], meanOfDraws: mean(stat),
    monthKeys: keys, monthPlaceboMean: Array.from(monthAcc, (x) => x / draws) };
}

// ── CORRECTED placebo (reported always; a gate only under the pre-read token placebo:corrected-paired-t) ─────────────────────
// The registered draw (same symbol, same calendar month, close > SMA200, not a signal day; +-1 month if none) with three changes:
//   (1) the placebo window [i, i+H] must be DISJOINT from the real trade's own dip and hold [t-3, u];
//   (2) H is drawn from the holds of OTHER symbols' real trades, so it carries no information about this symbol's path;
//   (3) synthetic halt days are never eligible, and no placebo window spans one.
// Calibration (60 drift-kept scrambles): as a p95 gate it is ANTI-conservative (observed > p95 on 15%: the draws re-use one month of
// a fixed path, so the p95 omits the path-level noise the disjoint real windows carry). As a PAIRED test — NW t over months of
// (real monthly mean minus the placebo monthly mean averaged over draws) — the real data's own variance enters and the false-pass rate
// at the bar is ~8% drift-kept, 0% drift-free. Only the paired-t form is offered as a gate.
function placeboPrepC(trades, PS, { from = ENTRY_FROM, to = ENTRY_TO } = {}) {
  const elig = new Map();
  const eligOf = (sym) => {
    if (elig.has(sym)) return elig.get(sym);
    const P = PS[sym], m = new Map();
    for (let i = 0; i < P.n; i++) {
      if (P.d[i] < from || P.d[i] > to || P.sig[i] || P.synth[i]) continue;
      if (!(fin(P.c[i]) && fin(P.s200[i]) && P.c[i] > P.s200[i])) continue;
      const k = P.d[i].slice(0, 7); (m.get(k) || m.set(k, []).get(k)).push(i);
    }
    elig.set(sym, m); return m;
  };
  const slots = trades.map((x) => { const m = eligOf(x.sym); return { sym: x.sym, month: x.month, t: x.t, u: x.u, same: m.get(x.month) || [],
    wide: [shiftMonth(x.month, -1), x.month, shiftMonth(x.month, 1)].flatMap((k) => m.get(k) || []) }; });
  return { slots, holdPool: trades.map((x) => [x.sym, x.hold]), symbolsInPool: new Set(trades.map((x) => x.sym)).size };
}
function placeboRunC(pp, PS, { draws, seed, cost, record = null }) {
  const rng = mulberry(seed), keys = [...new Set(pp.slots.map((s) => s.month))].sort(), M = keys.length, mi = new Map(keys.map((k, i) => [k, i]));
  const stat = [], acc = new Float64Array(M), accN = new Uint32Array(M); let widened = 0, dropped = 0;
  for (let k = 0; k < draws; k++) {
    const s = new Float64Array(M), n = new Uint32Array(M);
    for (const sl of pp.slots) {
      const P = PS[sl.sym]; let H;
      if (pp.symbolsInPool >= 2) do { const h = pp.holdPool[Math.floor(rng() * pp.holdPool.length)]; if (h[0] !== sl.sym) H = h[1]; } while (H === undefined);
      if (H === undefined) { dropped++; continue; }                                   // a one-symbol pool has no independent hold
      const ok = (i) => i + H <= P.n - 1 && (i + H < sl.t - 3 || i > sl.u) && P.synthCum[i + H] === P.synthCum[i];
      let c = sl.same.filter(ok), wide = false;
      if (!c.length) { c = sl.wide.filter(ok); wide = true; }
      if (!c.length) { dropped++; continue; }
      if (wide) widened++;
      const i = c[Math.floor(rng() * c.length)], q = mi.get(sl.month), v = P.c[i + H] / P.c[i] - 1 - cost;
      s[q] += v; n[q]++; if (record) record(sl, i, H, v, wide);
    }
    let tot = 0, m = 0; for (let i = 0; i < M; i++) if (n[i]) { const mm = s[i] / n[i]; tot += mm; m++; acc[i] += mm; accN[i]++; }
    stat.push(m ? tot / m : NaN);
  }
  const sorted = stat.filter(fin).sort((a, b) => a - b);
  return { draws, seed, months: M, p95: sorted.length ? sorted[Math.floor(0.95 * sorted.length)] : null, p50: sorted.length ? sorted[Math.floor(0.5 * sorted.length)] : null,
    p05: sorted.length ? sorted[Math.floor(0.05 * sorted.length)] : null, meanOfDraws: sorted.length ? mean(sorted) : null, monthKeys: keys,
    monthPlaceboMean: Array.from(acc, (x, i) => (accN[i] ? x / accN[i] : NaN)), widenedPerDraw: widened / draws, droppedPerDraw: dropped / draws, slots: pp.slots.length };
}
// real monthly mean minus the placebo's monthly mean (averaged over draws), over the months both have
function pairedDiffs(S, pl) { if (!S._keys) return []; const byM = new Map(S._keys.map((k, i) => [k, S._series[i]])); return pl.monthKeys.map((k, i) => byM.get(k) - pl.monthPlaceboMean[i]).filter(fin); }
// the registered gates that do not involve a placebo (leak / positive control are applied separately)
function coreGates(S, NO, bar) {
  return { tradesAtLeast100: S.trades >= MIN_TRADES, monthsAtLeast36: S.months >= MIN_MONTHS, meanNetPositive: S.meanNet != null && S.meanNet > 0, tAtLeastBar: S.tNetRaw != null && S.tNetRaw >= bar,
    bothHalvesPositive: !!(S.halves && S.halves.first.meanNet != null && S.halves.second.meanNet != null && S.halves.first.meanNet > 0 && S.halves.second.meanNet > 0),
    nextOpenPositive: NO ? NO.meanNet != null && NO.meanNet > 0 : null };
}
// R150's drift-kept floor as a gate: the mean must beat the floor's p95 AND the real monthly series must clear the bar against the floor's p50
function floorGate(S, fl, bar) {
  const t = S._series && fl && fin(fl.p50) ? nwT(S._series.map((x) => x - fl.p50)) : null;
  const meanAboveP95 = S.meanNet != null && fl && fin(fl.p95) && S.meanNet > fl.p95, tOk = t != null && t >= bar;
  return { p50: fl ? fl.p50 : null, p95: fl ? fl.p95 : null, p50PctPerMonth: fl ? r4(100 * fl.p50) : null, p95PctPerMonth: fl ? r4(100 * fl.p95) : null, meanAboveP95, tVsP50: r4(t), tVsP50Raw: t, tVsP50AtLeastBar: tOk, clears: meanAboveP95 && tOk };
}
// The pre-read decision, from the R310 registry entry. Never inferred: absent, ambiguous or unknown -> not decided -> the read is held.
function preReadDecision(entry) {
  const am = (entry && Array.isArray(entry.amendments) ? entry.amendments : []).filter((a) => a && Array.isArray(a.runnerGates));
  if (!am.length) return { decided: false, why: "the R310 registry entry has no amendments[] item carrying runnerGates" };
  const notPre = am.filter((a) => a.preEvidence !== true); if (notPre.length) return { decided: false, why: "a runnerGates amendment is not marked preEvidence: true" };
  const tokens = [...new Set(am.flatMap((a) => a.runnerGates))], unknown = tokens.filter((g) => !Object.prototype.hasOwnProperty.call(RUNNER_GATES, g));
  if (unknown.length) return { decided: false, why: `unknown runnerGates ${JSON.stringify(unknown)}` };
  const pl = tokens.filter((g) => g.startsWith("placebo:")); if (pl.length !== 1) return { decided: false, why: `exactly one placebo:* token required, found ${pl.length}` };
  return { decided: true, tokens, dates: am.map((a) => a.date || null), placebo: pl[0].slice(8), floor: tokens.includes("floor:drift-kept"), excludeHalt: tokens.includes("trades:exclude-halt-spanning"),
    meaning: tokens.map((g) => `${g}: ${RUNNER_GATES[g]}`) };
}
// The register's own bar method (NW lag-1 t on uniform noise, seed 310, 50k trials; iid nullBar beside it, seeded) at a given n
function barAtN(n) {
  const rng = mulberry(310), T = 50000, mx = [];
  for (let t = 0; t < T; t++) { const s = []; for (let i = 0; i < n; i++) s.push(rng() * 2 - 1); mx.push(nwT(s)); }
  mx.sort((a, b) => a - b);
  const { nullBar } = require("./lib/null-bar.js"), iid = nullBar({ variants: 1, n, trials: 20000, rng: mulberry(310) }).p95, nw = mx[Math.floor(0.95 * T)];
  return { n, nwSim: r3(nw), iid: r3(iid), bar: r3(Math.max(nw, iid)) };
}

// ── known-answer selftest (runs before any fetch, in every mode) ─────────────────────────────────────────────────────────
function rsiIndependent(c, n) {           // straightforward loop form, written separately from rsiWilder (check.cjs style)
  const out = new Array(c.length).fill(NaN); let ag = 0, al = 0;
  for (let i = 1; i < c.length; i++) {
    const ch = c[i] - c[i - 1], g = ch > 0 ? ch : 0, l = ch < 0 ? -ch : 0;
    if (i <= n) { ag += g; al += l; if (i === n) { ag /= n; al /= n; out[i] = al === 0 ? 100 : 100 * ag / (ag + al); } continue; }
    ag += (g - ag) / n; al += (l - al) / n; out[i] = al === 0 ? 100 : 100 * ag / (ag + al);
  }
  return out;
}
function selftest() {
  const checks = {}, detail = {}, day0 = Date.UTC(2016, 0, 1);
  const mkSeries = (closes, startMs = day0) => closes.map((c, i) => { const o = i ? closes[i - 1] + 0.05 : c; return { t: new Date(startMs + i * 864e5).toISOString(), o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c, v: 1e6 }; });
  const walk = (base, deltas) => { const out = [...base]; for (const dlt of deltas) out.push(out[out.length - 1] + dlt); return out; };
  const UP = Array.from({ length: 260 }, (_, i) => 50 + 0.2 * i), tail = Array(20).fill(0.2);
  // (a) RSI Wilder vs an independent implementation; 100 on an all-up series; first value at index n (seeded by the first n changes)
  { const g = mulberry(42), rw = [100]; for (let i = 1; i < 500; i++) rw.push(rw[i - 1] * (1 + (g() - 0.5) * 0.05));
    let maxDiff = 0, nanAgree = true;
    for (const n of [2, 5, 14]) { const a = rsiWilder(rw, n), b = rsiIndependent(rw, n); for (let i = 0; i < rw.length; i++) { if (fin(a[i]) !== fin(b[i])) nanAgree = false; else if (fin(a[i])) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i])); } if (fin(a[n - 1]) || !fin(a[n])) nanAgree = false; }
    const allUp = rsiWilder(Array.from({ length: 60 }, (_, i) => 10 + 0.5 * i), 5);
    checks.a_rsiMatchesIndependentTo1e9 = nanAgree && maxDiff < 1e-9; checks.a_rsiIs100OnAllUpSeries = allUp.slice(5).every((x) => x === 100) && allUp.slice(0, 5).every((x) => !fin(x)); detail.a_maxAbsDiff = maxDiff; }
  // (b) 260-bar uptrend, 4-close slide (t-3 .. t), small up, big up: exactly ONE entry at 263, exit at the first cross above 50 = 265
  const cB = walk(UP, [-0.9, -0.9, -0.9, -0.9, 0.3, 3.0, ...tail]), PB = prep(mkSeries(cB)), simB = simulate(PB, "X");
  { const r = PB.r;
    checks.b_engineeredRsiPath = r[263] < 30 && r[263] < r[262] && r[262] < r[261] && r[261] < r[260] && r[260] < 60 && r[259] >= 60 && r[264] <= 50 && r[265] > 50 && PB.c[263] > PB.s200[263];
    checks.b_exactlyOneEntryAt263 = simB.closed.length === 1 && simB.open.length === 0 && simB.closed[0].t === 263 && PB.sig.filter(Boolean).length === 1 && PB.sig[263];
    checks.b_exitAtFirstCrossAbove50At265 = simB.closed.length === 1 && simB.closed[0].u === 265 && simB.closed[0].hold === 2 && simB.closed[0].exit === cB[265] && simB.closed[0].entry === cB[263] && Math.abs(simB.closed[0].gross - (cB[265] / cB[263] - 1)) < 1e-15;
    checks.b_crossAbove50PredicateExact = crossUp50([40, 60], 1) && crossUp50([50, 50.0001], 1) && !crossUp50([60, 70], 1) && !crossUp50([50, 50], 1) && !crossUp50([NaN, 60], 1) && !crossUp50([60], 0);
    detail.b_rsi = [259, 260, 261, 262, 263, 264, 265].map((i) => +r[i].toFixed(3)); }
  // (c) the same slide with the price BELOW SMA200 (a high plateau first): RSI conditions hold at 263, no entry
  { const cC = walk([...Array(150).fill(200), ...Array.from({ length: 110 }, (_, i) => 50 + 0.2 * i)], [-0.9, -0.9, -0.9, -0.9, 0.3, 3.0, ...tail]), P = prep(mkSeries(cC)), s = simulate(P, "X"), r = P.r;
    checks.c_belowSma200NoEntry = r[263] < 30 && r[263] < r[262] && r[262] < r[261] && r[261] < r[260] && r[260] < 60 && P.c[263] < P.s200[263] && s.closed.length === 0 && s.open.length === 0; }
  // (d) only two RSI declines before RSI < 30 (t-2 is an up close): no entry anywhere
  { const cD = walk(UP, [-0.9, -0.9, 0.05, -0.9, -0.9, 3.0, ...tail]), P = prep(mkSeries(cD)), s = simulate(P, "X"), r = P.r;
    checks.d_twoDeclinesNoEntry = r[264] < 30 && r[264] < r[263] && r[263] < r[262] && !(r[262] < r[261]) && r[261] < 60 && P.c[264] > P.s200[264] && s.closed.length === 0 && s.open.length === 0; }
  // (e) a second qualifying signal while long (267) is ignored; one trade 263 -> 268
  const cE = walk(UP, [-0.9, -0.9, -0.9, -0.9, 0.3, -0.5, -0.5, -0.5, 3.0, ...tail]), PE = prep(mkSeries(cE)), simE = simulate(PE, "X");
  checks.e_secondSignalWhileLongIgnored = PE.sig[263] && PE.sig[267] && PE.sig.filter(Boolean).length === 2 && simE.closed.length === 1 && simE.closed[0].t === 263 && simE.closed[0].u === 268 && simE.ignored === 1;
  // (f) next-open fills use o[t+1] and o[u+1]; no u+1 bar -> open
  { const no = nextOpenOf(PB, simB.closed[0]);
    const P2 = prep(mkSeries(cB.slice(0, 266))), s2 = simulate(P2, "X"), no2 = s2.closed.length ? nextOpenOf(P2, s2.closed[0]) : null;
    checks.f_nextOpenUsesOpenTplus1AndUplus1 = !no.open && no.entryIdx === 264 && no.exitIdx === 266 && no.entry === PB.o[264] && no.exit === PB.o[266] && PB.o[264] !== PB.c[263] && Math.abs(no.gross - (PB.o[266] / PB.o[264] - 1)) < 1e-15;
    checks.f_nextOpenOpenWhenNoUplus1Bar = s2.closed.length === 1 && s2.closed[0].u === 265 && no2 && no2.open === true; }
  // (g) placebo: never a signal day, always close > SMA200, same symbol, same month (or flagged widened, within +-1 month), same hold
  { const cZ = [...Array.from({ length: 250 }, (_, i) => 50 + 0.2 * i), ...Array(10).fill(60), ...Array.from({ length: 40 }, (_, i) => 100 + 0.2 * i)];
    const PS = { X: PE, Z: prep(mkSeries(cZ)), Y: prep(mkSeries(cB.slice(0, 280))) };
    const trades = [{ ...simE.closed[0] }, { sym: "Z", month: "2016-09", hold: 3, entryDate: "2016-09-20" }, { sym: "Y", month: "2016-10", hold: 10, entryDate: "2016-10-03" }, { sym: "Y", month: "2016-10", hold: 200, entryDate: "2016-10-03" }];
    const pp = placeboPrep(trades, PS); let ok = true, nRec = 0; const seenX = new Set(), seenZ = new Set();
    placeboRun(pp, { draws: 300, seed: 7, cost: COST, record: (sl, d, v) => { nRec++; const P = PS[sl.sym], dm = P.d[d].slice(0, 7);
      if (P.sig[d]) ok = false; if (!(fin(P.c[d]) && fin(P.s200[d]) && P.c[d] > P.s200[d])) ok = false; if (!(d + sl.hold <= P.n - 1)) ok = false;
      if (Math.abs(v - (P.c[d + sl.hold] / P.c[d] - 1 - COST)) > 1e-15) ok = false;
      if (!sl.wide && dm !== sl.month) ok = false; if (sl.wide && ![shiftMonth(sl.month, -1), sl.month, shiftMonth(sl.month, 1)].includes(dm)) ok = false;
      if (sl.sym === "X") seenX.add(d); if (sl.sym === "Z") seenZ.add(d); } });
    const zBelow = [...Array(PS.Z.n).keys()].filter((i) => PS.Z.d[i].startsWith("2016-09") && PS.Z.c[i] < PS.Z.s200[i]);
    checks.g_placeboDrawsMatchedAndNeverSignalDays = ok && nRec === 300 * 3 && PE.d[263].startsWith("2016-09") && PE.d[267].startsWith("2016-09") && !seenX.has(263) && !seenX.has(267) && seenX.size >= 15 && zBelow.length === 10 && zBelow.every((i) => !seenZ.has(i)) && seenZ.size >= 10;
    checks.g_placeboWidenedAndDroppedRecorded = pp.widened === 1 && pp.dropped.length === 1 && pp.dropped[0].hold === 200 && pp.slots.length === 3 && pp.slots.filter((s) => s.wide).length === 1 && pp.slots.find((s) => s.wide).sym === "Y" && pp.slots[0].hold === 5; }
  // (h) NaN inputs never produce a signal
  { const base = signalAt(PB.c, PB.r, PB.s200, 263); let allFalse = true;
    for (const [arr, idx] of [["r", 263], ["r", 262], ["r", 261], ["r", 260], ["c", 263], ["s200", 263]]) { const c = [...PB.c], r = [...PB.r], s = [...PB.s200], m = { c, r, s200: s }; m[arr][idx] = NaN; if (signalAt(c, r, s, 263)) allFalse = false; }
    const short = simulate(prep(mkSeries(cB.slice(100))), "X");                 // < 200 bars before the slide: SMA200 is NaN there
    checks.h_nanNeverSignals = base === true && allFalse && short.closed.length === 0 && short.open.length === 0 && !signalAt(PB.c, PB.r, PB.s200, 2); }
  // (i) nwT on known vectors, by hand: [1.5,.5,1.5,.5,1] -> m 1, g0 .2, g1 -.15, v .05, t = 1/sqrt(.01) = 10;
  //     [2,2,0,0,1] -> m 1, g0 .8, g1 .2, v 1, t = 1/sqrt(1/5) = sqrt(5)
  checks.i_nwTHandComputed = Math.abs(nwT([1.5, 0.5, 1.5, 0.5, 1.0]) - 10) < 1e-9 && Math.abs(nwT([2, 2, 0, 0, 1]) - Math.sqrt(5)) < 1e-9 && nwT([1, 2]) === null;
  // (j) RSI-2 overlap simulator: R150's own known-answer series -> one RSI-2 trade 250 -> 254, coverage 250..253
  { const cJ = [...Array.from({ length: 250 }, (_, i) => 50 + 0.2 * i), 96, 93, 90, 92, 97, 99], cv = rsi2Coverage(prep(mkSeries(cJ)));
    checks.j_rsi2OverlapKnownAnswer = cv.trades.length === 1 && cv.trades[0].t === 250 && cv.trades[0].u === 254 && cv.fires[250] === 1 && [250, 251, 252, 253].every((i) => cv.cover[i] === 1) && cv.cover[254] === 0 && cv.cover[249] === 0; }
  // (k) entry window: the same pattern dated 2015 or after 2026-09-30 produces no entry; (l) open at the last bar is open, not closed
  { const s15 = simulate(prep(mkSeries(cB, Date.UTC(2015, 0, 1))), "X"), sLate = simulate(prep(mkSeries(cB, Date.UTC(2026, 9, 1) - 263 * 864e5)), "X");
    checks.k_entryWindowEnforced = s15.closed.length + s15.open.length === 0 && sLate.closed.length + sLate.open.length === 0;
    const sOpen = simulate(prep(mkSeries(cB.slice(0, 265))), "X");
    checks.l_openAtLastBarNotCounted = sOpen.closed.length === 0 && sOpen.open.length === 1 && sOpen.open[0].t === 263 && sOpen.open[0].u === null && sOpen.open[0].hold === 1; }
  // (m) the leak-test scramble is drift-free (product of shuffled close-to-close ratios = 1) and deterministic
  { const bars = mkSeries(cE), s1 = scramble(bars, 1, "X", true), s1b = scramble(bars, 1, "X", true);
    checks.m_scrambleDriftFreeAndDeterministic = Math.abs(s1[s1.length - 1].c / s1[0].c - 1) < 1e-9 && s1.every((b, i) => b.c === s1b[i].c) && s1.some((b, i) => Math.abs(b.c - bars[i].c) > 1e-6); }
  // (n) synthetic halt bar (v=0, O=H=L=C=prev close) inside the B trade's hold: flagged; RSI frozen across it; same trade 263 -> 265
  //     spans exactly one halt bar; an open trade counts halt bars to the last bar; an ordinary trade spans none
  { const cH = [...cB]; cH[264] = cH[263]; const bars = mkSeries(cH); bars[264] = { ...bars[264], o: cH[263], h: cH[263], l: cH[263], c: cH[263], v: 0 };
    const P = prep(bars), s = simulate(P, "H"), Po = prep(bars.slice(0, 265)), so = simulate(Po, "H");
    checks.n_syntheticHaltFlaggedAndSpanCounted = P.synth[264] && P.synth.filter(Boolean).length === 1 && PB.synth.every((x) => !x) && Math.abs(P.r[264] - P.r[263]) < 1e-9 && !P.sig[264]
      && s.closed.length === 1 && s.closed[0].t === 263 && s.closed[0].u === 265 && haltBarsIn(P, s.closed[0]) === 1 && haltBarsIn(PB, simB.closed[0]) === 0
      && so.open.length === 1 && haltBarsIn(Po, so.open[0]) === 1 && synthIn(P, 0, P.n - 1) === 1 && synthIn(P, 265, 400) === 0
      && haltBarsIn(P, { t: 264, u: 266 }) === 0 && haltBarsIn(P, { t: 262, u: 263 }) === 0 && haltBarsIn(P, { t: 263, u: 264 }) === 1; }   // window is (t, u]
  // (o) CORRECTED placebo: every draw is eligible (not a signal day, not synthetic, close > SMA200, same month or flagged +-1), its window
  //     [i, i+H] is disjoint from the real [t-3, u] and spans no synthetic bar, H is another symbol's real hold, the value is exact;
  //     a slot with no eligible day anywhere is dropped every draw; a slot whose month is covered by its own hold is widened every draw
  { const cZ = [...Array.from({ length: 250 }, (_, i) => 50 + 0.2 * i), ...Array(10).fill(60), ...Array.from({ length: 40 }, (_, i) => 100 + 0.2 * i)];
    const bZ = mkSeries(cZ); bZ[270] = { ...bZ[270], o: bZ[269].c, h: bZ[269].c, l: bZ[269].c, c: bZ[269].c, v: 0 };
    const PS = { X: PE, Z: prep(bZ), Y: prep(mkSeries(cB.slice(0, 280))) };
    const trades = [{ ...simE.closed[0] }, { sym: "Z", month: "2016-09", t: 262, u: 265, hold: 3 }, { sym: "Z", month: "2016-01", t: 10, u: 14, hold: 4 }, { sym: "Y", month: "2016-10", t: 277, u: 279, hold: 2 }];
    let ok = true, nRec = 0; const seenX = new Set(), wideBy = {};
    const pl = placeboRunC(placeboPrepC(trades, PS), PS, { draws: 300, seed: 7, cost: COST, record: (sl, i, H, v, wide) => { nRec++; const P = PS[sl.sym], dm = P.d[i].slice(0, 7);
      if (P.sig[i] || P.synth[i] || synthIn(P, i + 1, i + H) !== 0) ok = false; if (!(fin(P.c[i]) && fin(P.s200[i]) && P.c[i] > P.s200[i])) ok = false;
      if (!(i + H <= P.n - 1) || !(i + H < sl.t - 3 || i > sl.u)) ok = false; if (P.d[i] < ENTRY_FROM || P.d[i] > ENTRY_TO) ok = false;
      if (!trades.filter((x) => x.sym !== sl.sym).map((x) => x.hold).includes(H)) ok = false;
      if (Math.abs(v - (P.c[i + H] / P.c[i] - 1 - COST)) > 1e-15) ok = false;
      if (!wide && dm !== sl.month) ok = false; if (wide && ![shiftMonth(sl.month, -1), sl.month, shiftMonth(sl.month, 1)].includes(dm)) ok = false;
      if (sl.sym === "X") seenX.add(i); if (wide) wideBy[sl.sym + sl.month] = (wideBy[sl.sym + sl.month] || 0) + 1; } });
    checks.o_correctedPlaceboDisjointIndependentHoldNoSynth = ok && nRec === 300 * 3 && PS.Z.synth[270] && seenX.size >= 5 && !seenX.has(263) && !seenX.has(267)
      && pl.droppedPerDraw === 1 && pl.widenedPerDraw === 1 && wideBy["Y2016-10"] === 300 && Object.keys(wideBy).length === 1 && fin(pl.p95) && pl.monthKeys.length === 3 && !fin(pl.monthPlaceboMean[0]);
    const one = placeboRunC(placeboPrepC([{ ...simE.closed[0] }], { X: PE }), { X: PE }, { draws: 5, seed: 1, cost: COST });
    checks.o_correctedPlaceboOneSymbolPoolDropsNotLoops = one.droppedPerDraw === 1 && one.p95 === null; }
  // (p) the pre-read decision parser: absent / not pre-evidence / unknown token / two placebo tokens -> not decided; union across amendments
  { const D0 = preReadDecision({}), D1 = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: ["placebo:corrected-paired-t", "floor:drift-kept"] }] });
    const D2 = preReadDecision({ amendments: [{ preEvidence: false, runnerGates: ["placebo:registered"] }] }), D3 = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: ["placebo:corrected-p95"] }] });
    const D4 = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: ["placebo:registered", "placebo:reported-only"] }] });
    const D5 = preReadDecision({ amendments: [{ field: "x", preEvidence: true }, { preEvidence: true, runnerGates: ["placebo:registered"] }, { preEvidence: true, runnerGates: ["trades:exclude-halt-spanning"] }] });
    checks.p_preReadDecisionParser = !D0.decided && D1.decided && D1.placebo === "corrected-paired-t" && D1.floor && !D1.excludeHalt && !D2.decided && !D3.decided && !D4.decided
      && D5.decided && D5.placebo === "registered" && D5.excludeHalt && !D5.floor; }
  // (q) floor gate by hand: series [1.5,.5,1.5,.5,1] (t 10 vs 0, from (i)) clears p50 0 / p95 .9; against p50 1 the t is 0 -> fails
  { const S = { meanNet: 1, _series: [1.5, 0.5, 1.5, 0.5, 1.0] }, a = floorGate(S, { p50: 0, p95: 0.9 }, 1.682), b = floorGate(S, { p50: 1, p95: 0.9 }, 1.682), c = floorGate(S, { p50: 0, p95: 1 }, 1.682);
    checks.q_floorGateHandComputed = a.clears && Math.abs(a.tVsP50Raw - 10) < 1e-9 && !b.clears && b.meanAboveP95 && Math.abs(b.tVsP50Raw) < 1e-12 && !c.clears && !c.meanAboveP95; }
  return { pass: Object.values(checks).every(Boolean), checks, detail };
}

// ── data: fetch once, cache, hash ────────────────────────────────────────────────────────────────────────────────────────
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
function gatedUniverse() {
  const names = JSON.parse(fs.readFileSync(D("r147-universe.json"), "utf8")).names;
  if (!Array.isArray(names) || names.length !== 100) throw new Error(`r147-universe.json names: expected 100, got ${names && names.length}`);
  const g = [...names, ...ETFS];
  if (new Set(g).size !== 114 || g.includes("SPY")) throw new Error("gated universe must be 114 unique symbols without SPY");
  return g;
}
function packRows(sym, rows) {
  let prev = "";
  for (const b of rows) {
    const d = dateOf(b.t);
    if (![b.o, b.h, b.l, b.c].every((x) => fin(x) && x > 0)) throw new Error(`${sym}: non-finite or non-positive price on ${d}`);
    if (d <= prev) throw new Error(`${sym}: dates not strictly increasing at ${d}`);
    if (d > LAST_BAR) throw new Error(`${sym}: bar dated ${d} after the last complete bar ${LAST_BAR} (forming-bar guard)`);
    if (d < FETCH_START) throw new Error(`${sym}: bar dated ${d} before ${FETCH_START}`);
    prev = d;
  }
  return rows.map((b) => [b.t, b.o, b.h, b.l, b.c, b.v]);
}
const unpack = (rows) => rows.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
async function loadOrFetch(allowFetch) {
  if (fs.existsSync(CACHE)) {
    const buf = fs.readFileSync(CACHE), j = JSON.parse(buf.toString("utf8"));
    if (j.spec !== "r310-bars-cache-v1" || j.feed !== "sip" || j.adjustment !== "all" || j.start !== FETCH_START || j.end !== FETCH_END) throw new Error("cache metadata does not match the R310 spec — refusing to use it");
    return { cache: j, sha: sha256(buf), fetched: false };
  }
  if (!allowFetch) throw new Error(`bar cache missing (${CACHE_REL}) — the controls run creates it; the read never refetches`);
  const { fetchBars } = require("./lib/alpaca-bars.js");                     // loaded only here: the selftest never touches the network or .env
  const gated = gatedUniverse();
  console.log(`R310 fetching ${gated.length} gated symbols — SIP, adjustment all, ${FETCH_START} .. ${LAST_BAR}`);
  const g = await fetchBars(gated, { start: FETCH_START, end: FETCH_END, feed: "sip", adjustment: "all", requireAll: false, quiet: true });
  console.log(`  gated: ${Object.keys(g.bars).length}/${gated.length} returned, ${g.pages} pages`);
  const s = await fetchBars(["SPY"], { start: FETCH_START, end: FETCH_END, feed: "sip", adjustment: "all", requireAll: true, quiet: true });
  const returned = gated.filter((x) => g.bars[x] && g.bars[x].length), missing = gated.filter((x) => !returned.includes(x)), gatedRows = {}, coverage = {};
  for (const x of returned) { gatedRows[x] = packRows(x, g.bars[x]); coverage[x] = { firstBar: dateOf(g.bars[x][0].t), lastBar: dateOf(g.bars[x][g.bars[x].length - 1].t), bars: g.bars[x].length }; }
  const spyRows = packRows("SPY", s.bars.SPY);
  const obj = { spec: "r310-bars-cache-v1", id: ID, fetchedAt: new Date().toISOString(), source: "lib/alpaca-bars.js fetchBars", feed: "sip", adjustment: "all", start: FETCH_START, end: FETCH_END, lastCompleteBar: LAST_BAR,
    rows: "[t, o, h, l, c, v] as returned by Alpaca", gatedRequested: gated, returned, missing, truncatedStart: g.truncatedStart || [], coverage,
    spy: { symbol: "SPY", note: "REPORTED ONLY (previewed before registration); never in the gated statistics", firstBar: dateOf(s.bars.SPY[0].t), lastBar: dateOf(s.bars.SPY[s.bars.SPY.length - 1].t), bars: spyRows.length, rows: spyRows },
    gated: gatedRows };
  fs.mkdirSync(CACHE_DIR, { recursive: true }); writeJsonAtomic(CACHE, obj, { pretty: 0 });
  const buf = fs.readFileSync(CACHE);
  return { cache: JSON.parse(buf.toString("utf8")), sha: sha256(buf), fetched: true };
}
function coverageSummary(cache) {
  const late = Object.entries(cache.coverage).filter(([, v]) => v.firstBar > "2015-01-31").map(([k, v]) => `${k} ${v.firstBar}`);
  const stale = Object.entries(cache.coverage).filter(([, v]) => v.lastBar < LAST_BAR).map(([k, v]) => `${k} ${v.lastBar}`);
  // The registry asks for bars from 2015-01-01 (200-day warm-up before 2016). Alpaca's SIP history starts 2016-01-04 on this account
  // (fetchBars returns what exists; it cannot be honoured), so the first finite SMA200 — and the first possible entry — is the 200th bar.
  const firstSma = cache.returned.filter((x) => cache.coverage[x].bars >= 200).map((x) => dateOf(cache.gated[x][199][0])).sort();
  return { requested: cache.gatedRequested.length, priced: cache.returned.length, missing: cache.missing, lateStart: late, lastBarBefore20261001: stale,
    withSma200: firstSma.length, earliestFirstBar: Object.values(cache.coverage).map((v) => v.firstBar).sort()[0] || null, earliestSma200Bar: firstSma[0] || null,
    warmupNote: "requested 2015-01-01; bars before the earliest first bar do not exist in the feed, so no entry is possible before earliestSma200Bar (registered nExpected 129 months assumed 2016-01 entries)" };
}

// ── calibration on no-edge scrambles (controls run only) ─────────────────────────────────────────────────────────────────
function registryEntry() { const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")); return [...(reg.preregistered || []), ...(reg.tests || [])].find((x) => x.id === ID) || null; }
// One scramble: the R310 rule unchanged, both placebos (500 draws, seed 310), next-open, and the registered decision rule as written.
function scrambleRun(cache, syms, seed, demean, bar) {
  const PS = {}, tr = [], noC = [];
  for (const s of syms) {
    const P = prep(scramble(unpack(cache.gated[s]), seed, s, demean)); PS[s] = P; const sim = simulate(P, s);
    for (const x of sim.closed) tr.push({ ...x, net: x.gross - COST, haltBars: haltBarsIn(P, x) });
    for (const x of [...sim.closed, ...sim.open]) { const no = nextOpenOf(P, x); if (!no.open) noC.push({ ...no, net: no.gross - COST }); }
  }
  const S = summarise(tr), SX = summarise(tr.filter((x) => !x.haltBars)), NO = summarise(noC);
  const pl = placeboRun(placeboPrep(tr, PS), { draws: PLACEBO_DRAWS, seed: PLACEBO_SEED, cost: COST }), plC = placeboRunC(placeboPrepC(tr, PS), PS, { draws: PLACEBO_DRAWS, seed: PLACEBO_SEED, cost: COST });
  const dReg = pairedDiffs(S, pl), dC = pairedDiffs(S, plC), core = coreGates(S, NO, bar), corePass = Object.values(core).every(Boolean);
  return { seed, demean, trades: S.trades, months: S.months, meanNet: S.meanNet, tNW: S.tNetRaw, meanNetExclHalt: SX.meanNet, haltSpanning: tr.length - SX.trades, _series: S._series, _seriesExclHalt: SX._series,
    regP95: pl.p95, regBeats: S.meanNet != null && S.meanNet > pl.p95, regPairedDiff: dReg.length ? mean(dReg) : null, regPairedDiffT: nwT(dReg),
    corrP95: plC.p95, corrMean: plC.meanOfDraws, corrP95Beaten: S.meanNet != null && plC.p95 != null && S.meanNet > plC.p95, corrPairedDiff: dC.length ? mean(dC) : null, corrPairedDiffT: nwT(dC),
    corrWidenedPerDraw: plC.widenedPerDraw, corrDroppedPerDraw: plC.droppedPerDraw, corePass, registeredVerdictPass: corePass && S.meanNet > pl.p95 };
}
function calibrate(kept, free, bar) {
  const srt = (a) => a.filter(fin).sort((x, y) => x - y), share = (rows, f) => (rows.length ? rows.filter(f).length / rows.length : null);
  const dist = (a, k = (x) => x) => { const s = srt(a); return s.length ? { n: s.length, min: k(s[0]), p05: k(nearestRank(s, 0.05)), p50: k(nearestRank(s, 0.5)), p95: k(nearestRank(s, 0.95)), max: k(s[s.length - 1]) } : null; };
  const pctD = (rows, key) => dist(rows.map((r) => r[key]), (x) => r4(100 * x)), tD = (rows, key) => dist(rows.map((r) => r[key]), r3);
  const floorOf = (key) => { const s = srt(kept.map((r) => r[key])); return { seeds: s.length, p50: nearestRank(s, 0.5), p95: nearestRank(s, 0.95), min: s[0], max: s[s.length - 1],
    p50PctPerMonth: r4(100 * nearestRank(s, 0.5)), p95PctPerMonth: r4(100 * nearestRank(s, 0.95)), minPctPerMonth: r4(100 * s[0]), maxPctPerMonth: r4(100 * s[s.length - 1]) }; };
  // leave-one-out: each drift-kept scramble judged against the floor of the OTHER seeds (its own run never sets its own floor)
  const looFloor = (j) => { const s = srt(kept.filter((_, i) => i !== j).map((r) => r.meanNet)); return { p50: nearestRank(s, 0.5), p95: nearestRank(s, 0.95) }; };
  const floorPass = kept.map((r, j) => floorGate({ meanNet: r.meanNet, _series: r._series }, looFloor(j), bar).clears);
  const corrPass = kept.map((r) => r.corrPairedDiffT != null && r.corrPairedDiffT >= bar);
  const slimRow = (r) => ({ seed: r.seed, trades: r.trades, months: r.months, meanNetPctPerMonth: r4(100 * r.meanNet), tNW: r3(r.tNW), haltSpanning: r.haltSpanning,
    registeredP95PctPerMonth: r4(100 * r.regP95), registeredBeaten: r.regBeats, registeredPairedDiffPctPerMonth: r4(100 * r.regPairedDiff), registeredPairedDiffT: r3(r.regPairedDiffT),
    correctedP95PctPerMonth: r4(100 * r.corrP95), correctedMeanPctPerMonth: r4(100 * r.corrMean), correctedP95Beaten: r.corrP95Beaten, correctedPairedDiffPctPerMonth: r4(100 * r.corrPairedDiff), correctedPairedDiffT: r3(r.corrPairedDiffT),
    correctedWidenedPerDraw: r3(r.corrWidenedPerDraw), correctedDroppedPerDraw: r3(r.corrDroppedPerDraw), registeredDecisionRulePass: r.registeredVerdictPass });
  const placeboBlock = (rows, kind) => kind === "registered"
    ? { seeds: rows.length, shareBeaten: share(rows, (r) => r.regBeats), pairedDiffPctPerMonth: pctD(rows, "regPairedDiff"), pairedDiffT: tD(rows, "regPairedDiffT") }
    : { seeds: rows.length, shareP95Beaten: share(rows, (r) => r.corrP95Beaten), sharePairedTAtLeastBar: share(rows, (r) => r.corrPairedDiffT != null && r.corrPairedDiffT >= bar),
        sharePairedTAtMostMinusBar: share(rows, (r) => r.corrPairedDiffT != null && r.corrPairedDiffT <= -bar), pairedDiffPctPerMonth: pctD(rows, "corrPairedDiff"), pairedDiffT: tD(rows, "corrPairedDiffT"),
        widenedPerDraw: dist(rows.map((r) => r.corrWidenedPerDraw), r1), droppedPerDraw: dist(rows.map((r) => r.corrDroppedPerDraw), r1) };
  const floor = { all: floorOf("meanNet"), exclHalt: floorOf("meanNetExclHalt"), looFalsePass: share(kept, (_, j) => floorPass[j]),
    method: `R150 scramble with drift KEPT (demean=false), seeds 1..${kept.length}, the R310 rule unchanged, 0.10% cost; floor = p50 / p95 (nearest rank) of the per-seed mean of monthly means` };
  const ok = floor.all.seeds === kept.length && floor.exclHalt.seeds === kept.length && kept.length === FLOOR_SEEDS && free.length === LEAK_DIAG_SEEDS && kept.every((r) => fin(r.corrPairedDiffT) && fin(r.regPairedDiffT));
  return { ok, bar, asOfNote: "scrambles only — no-edge by construction; every rate below is a false-pass rate",
    registeredPlacebo: { driftKept: placeboBlock(kept, "registered"), driftFree: placeboBlock(free, "registered"),
      reading: "the registered placebo is beaten by every no-edge scramble and its paired diff is ~+3.4%/month at t ~30-45 on no-edge data: neither the gate nor the paired diff carries information" },
    correctedPlacebo: { driftKept: placeboBlock(kept, "corrected"), driftFree: placeboBlock(free, "corrected"),
      reading: "p95 form anti-conservative (draws re-use one month of a fixed path); paired NW t form near nominal on drift-kept, conservative on drift-free" },
    floor,
    registeredDecisionRule: { driftKeptSharePass: share(kept, (r) => r.registeredVerdictPass), driftFreeSharePass: share(free, (r) => r.registeredVerdictPass), driftKeptRuleT: tD(kept, "tNW"),
      note: "all registered gates except leak/positive control (both pass on real data), applied to each scramble's own trades" },
    recommendedSet: { tokens: ["placebo:corrected-paired-t", "floor:drift-kept"], looFalsePass: share(kept, (r, j) => r.corePass && corrPass[j] && floorPass[j]),
      correctedPairedTOnlyFalsePass: share(kept, (r, j) => r.corePass && corrPass[j]), floorOnlyFalsePass: share(kept, (r, j) => r.corePass && floorPass[j]) },
    leakDiagnostic: { seeds: free.length, tNW: tD(free, "tNW"), shareTAtLeastBar: share(free, (r) => r.tNW != null && r.tNW >= bar), shareTAtLeast2: share(free, (r) => r.tNW != null && r.tNW >= 2),
      note: "R150's demean is in LOG terms; arithmetic drift (Jensen, ~+0.04%/day) remains, so the drift-free t is centred slightly above 0. Seeds 1-2 are the registered test; this is context only." },
    driftKept: kept.map(slimRow), driftFree: free.map(slimRow) };
}

// The read computation, pure: no file is written here (main writes OUT once). Factored out so it can be dry-run on SCRAMBLED
// caches (scratch checks) — it is never run on the real cache except by --read.
function computeRead({ cache, sha, ctrl, entry, dec, bar }) {
  const cal = ctrl.calibration, lines = [];

  const syms = cache.returned, PS = {}, all = [], opens = [], noAll = [], noOpen = []; let ignored = 0, symbolSessions = 0, heldSessions = 0;
  for (const s of syms) {
    const P = prep(unpack(cache.gated[s])); PS[s] = P;
    const sim = simulate(P, s), cv = rsi2Coverage(P); ignored += sim.ignored;
    for (const x of sim.closed) { all.push({ ...x, net: x.gross - COST, rsi2Fires: !!cv.fires[x.t], rsi2Raw: !!cv.raw[x.t], rsi2Cover: !!cv.cover[x.t], haltBars: haltBarsIn(P, x), sma200WindowSynth: synthIn(P, x.t - 199, x.t) }); heldSessions += x.hold; }
    for (const x of sim.open) { opens.push({ ...x, markNet: x.gross - COST, haltBars: haltBarsIn(P, x) }); heldSessions += x.hold; }
    for (const x of [...sim.closed, ...sim.open]) { const no = nextOpenOf(P, x); if (no.open) noOpen.push(no); else noAll.push({ ...no, net: no.gross - COST, haltBars: haltBarsIn(P, x) }); }
    symbolSessions += P.d.filter((d) => d >= ENTRY_FROM).length;
  }
  // trades:exclude-halt-spanning (pre-read token only): a trade carried through synthetic halt bars is reported, not counted
  const counted = (x) => !(dec.excludeHalt && x.haltBars > 0);
  const closed = all.filter(counted), noClosed = noAll.filter(counted), haltSpanning = all.filter((x) => x.haltBars > 0);
  const head = summarise(closed);

  // registered placebo (computed exactly as registered; a gate only under placebo:registered)
  const pp = placeboPrep(closed, PS), pl = placeboRun(pp, { draws: PLACEBO_DRAWS, seed: PLACEBO_SEED, cost: COST }), diffs = pairedDiffs(head, pl), regNull = cal.registeredPlacebo.driftKept;
  const placebo = { draws: PLACEBO_DRAWS, seed: PLACEBO_SEED, p95: pl.p95, observed: head.meanNet, beats: head.meanNet != null && pl.p95 != null && head.meanNet > pl.p95,
    widened: pp.widened, dropped: pp.dropped.length, droppedTrades: pp.dropped.slice(0, 100), slots: pp.slots.length, monthsInPlacebo: pl.months,
    meanOfDraws: pl.meanOfDraws, p50: pl.p50, p05: pl.p05, p95PctPerMonth: r4(100 * pl.p95), observedPctPerMonth: head.meanNetPctPerMonth,
    pairedDiffMean: diffs.length ? mean(diffs) : null, pairedDiffMeanPctPerMonth: diffs.length ? r4(100 * mean(diffs)) : null, pairedDiffT: r4(nwT(diffs)), pairedMonths: diffs.length,
    pairedDiffNullDriftKept: { pctPerMonth: regNull.pairedDiffPctPerMonth, t: regNull.pairedDiffT, seeds: regNull.seeds },
    pairedDiffExcessOverNullPctPerMonth: diffs.length && regNull.pairedDiffPctPerMonth ? r4(100 * mean(diffs) - regNull.pairedDiffPctPerMonth.p50) : null,
    pairedDiffNote: "NOT evidence: on no-edge drift-kept scrambles this paired diff is itself ~+3.3%/month at t ~30-45. Only its excess over that null means anything; prefer placebo.corrected.",
    calibrationOnScrambles: { shareBeatenDriftKept: regNull.shareBeaten, shareBeatenDriftFree: cal.registeredPlacebo.driftFree.shareBeaten, registeredDecisionRulePassShareDriftKept: cal.registeredDecisionRule.driftKeptSharePass },
    gateInForce: dec.placebo === "registered",
    method: "AS REGISTERED — per real trade: a random day of the same symbol in the same calendar month (inside the entry window), close > SMA200, not an entry-signal day, with >= hold bars after it (else +-1 month = widened; else dropped); held the same number of trading days close to close, 0.10% cost; monthly series by the real trade's month; statistic = mean of monthly means; p95 = sorted[floor(0.95*draws)]. Paired diff = real monthly mean minus the placebo monthly mean averaged over draws, NW t over months." };
  const ppC = placeboPrepC(closed, PS), plC = placeboRunC(ppC, PS, { draws: PLACEBO_DRAWS, seed: PLACEBO_SEED, cost: COST }), dC = pairedDiffs(head, plC), tC = nwT(dC);
  placebo.corrected = { draws: PLACEBO_DRAWS, seed: PLACEBO_SEED, slots: plC.slots, months: plC.months, widenedPerDraw: r3(plC.widenedPerDraw), droppedPerDraw: r3(plC.droppedPerDraw),
    pairedDiffMean: dC.length ? mean(dC) : null, pairedDiffMeanPctPerMonth: dC.length ? r4(100 * mean(dC)) : null, pairedDiffT: r4(tC), pairedDiffTRaw: tC, pairedMonths: dC.length, pairedTAtLeastBar: tC != null && tC >= bar,
    p95: plC.p95, p50: plC.p50, p05: plC.p05, meanOfDraws: plC.meanOfDraws, p95PctPerMonth: r4(100 * plC.p95), meanPctPerMonth: r4(100 * plC.meanOfDraws), beatsP95: head.meanNet != null && plC.p95 != null && head.meanNet > plC.p95,
    p95Note: `REPORTED ONLY, never a gate: the p95 form is beaten by ${r1(100 * cal.correctedPlacebo.driftKept.shareP95Beaten)}% of no-edge drift-kept scrambles`,
    calibration: { pairedTAtLeastBarDriftKept: cal.correctedPlacebo.driftKept.sharePairedTAtLeastBar, pairedTAtLeastBarDriftFree: cal.correctedPlacebo.driftFree.sharePairedTAtLeastBar, pairedTDriftKept: cal.correctedPlacebo.driftKept.pairedDiffT },
    gateInForce: dec.placebo === "corrected-paired-t",
    method: "per real trade: a random day of the same symbol in the same calendar month (+-1 month if none), close > SMA200, not a signal day, not a synthetic halt day; the window [i, i+H] disjoint from the real trade's [t-3, u] and spanning no synthetic bar; H drawn from the holds of OTHER symbols' real trades; 0.10% cost; 500 draws seed 310. Paired diff = real monthly mean minus the placebo monthly mean averaged over draws; NW t over months." };
  const noS = summarise(noClosed), noSig = summarise(noClosed, { monthOf: (x) => x.signalMonth });
  const nextOpen = { meanNet: noS.meanNet, meanNetPctPerMonth: noS.meanNetPctPerMonth, positive: noS.meanNet != null && noS.meanNet > 0, trades: noS.trades, months: noS.months, tNet: noS.tNet, winRatePct: noS.winRatePct, meanPerTradePct: noS.meanPerTradePct,
    openTrades: noOpen.length, monthKey: "calendar month of the fill (t+1)", bySignalMonth: { meanNetPctPerMonth: noSig.meanNetPctPerMonth, months: noSig.months, tNet: noSig.tNet } };
  const halves = { first: head.halves ? head.halves.first : { meanNet: null, months: 0 }, second: head.halves ? head.halves.second : { meanNet: null, months: 0 } };
  const controls = { leakPass: !!ctrl.leakTest.pass, positivePass: !!ctrl.positiveControl.pass, leakT: [ctrl.leakTest.seed1.tNW, ctrl.leakTest.seed2.tNW], positiveT: ctrl.positiveControl.result.tNW, file: "backend/data/r310-controls.json", asOf: ctrl.asOf };
  const fl = cal.floor[dec.excludeHalt ? "exclHalt" : "all"];
  const floor = { ...floorGate(head, fl, bar), basis: dec.excludeHalt ? "drift-kept floor with halt-spanning trades excluded" : "drift-kept floor, all trades", seeds: fl.seeds, looFalsePassOnScrambles: cal.floor.looFalsePass, gateInForce: dec.floor, method: cal.floor.method };

  // gates in force = the registered gates, with the placebo / floor / halt choices of the pre-read decision
  const gates = { tradesAtLeast100: head.trades >= MIN_TRADES, monthsAtLeast36: head.months >= MIN_MONTHS, meanNetPositive: head.meanNet != null && head.meanNet > 0, tAtLeastBar: head.tNetRaw != null && head.tNetRaw >= bar };
  if (dec.placebo === "registered") gates.placeboP95Beaten = placebo.beats;
  if (dec.placebo === "corrected-paired-t") gates.correctedPlaceboPairedTAtLeastBar = placebo.corrected.pairedTAtLeastBar;
  gates.bothHalvesPositive = halves.first.meanNet != null && halves.second.meanNet != null && halves.first.meanNet > 0 && halves.second.meanNet > 0;
  gates.nextOpenPositive = nextOpen.positive;
  if (dec.floor) { gates.floorMeanAboveP95 = floor.meanAboveP95; gates.floorTVsP50AtLeastBar = floor.tVsP50AtLeastBar; }
  gates.leakTestPassed = controls.leakPass; gates.positiveControlPassed = controls.positivePass;
  const why = []; if (!gates.tradesAtLeast100) why.push(`${head.trades} trades < ${MIN_TRADES}`); if (!gates.monthsAtLeast36) why.push(`${head.months} months < ${MIN_MONTHS}`);
  if (!gates.leakTestPassed) why.push("leak test failed"); if (!gates.positiveControlPassed) why.push("positive control failed");
  const verdictScript = why.length ? `CANNOT MEASURE — ${why.join("; ")}` : Object.values(gates).every(Boolean) ? "PASS" : "DID NOT PASS";
  // What a PASS may be called: "beats random above-200-day entry" only when BOTH calibrated timing checks clear, gated or not.
  const timingMiss = [!placebo.corrected.pairedTAtLeastBar && "corrected placebo paired t below the bar", !floor.clears && "drift-kept floor not cleared"].filter(Boolean);
  const verdictReading = verdictScript !== "PASS" ? verdictScript
    : !timingMiss.length ? "PASS — and the dip timing beats both calibrated nulls (corrected placebo paired t, drift-kept floor)"
    : `PASS on the gates in force (${dec.tokens.join(", ")}) — NOT evidence that the dip timing beats random above-200-day entry: ${timingMiss.join("; ")}`;

  // sensitivity lines (reported; flag any gate that flips)
  const variant = (trades, note) => {
    const S = summarise(trades), fg = floorGate(S, fl, bar), g = { tradesAtLeast100: S.trades >= MIN_TRADES, monthsAtLeast36: S.months >= MIN_MONTHS, meanNetPositive: S.meanNet != null && S.meanNet > 0, tAtLeastBar: S.tNetRaw != null && S.tNetRaw >= bar,
      bothHalvesPositive: !!(S.halves && S.halves.first.meanNet > 0 && S.halves.second.meanNet > 0), ...(dec.floor ? { floorMeanAboveP95: fg.meanAboveP95, floorTVsP50AtLeastBar: fg.tVsP50AtLeastBar } : {}) };
    return { note, ...strip(S), floorTVsP50: fg.tVsP50, gates: g, gatesThatFlip: Object.keys(g).filter((k) => g[k] !== gates[k]), notRecomputed: "placebo and next-open gates are not recomputed for a sensitivity variant" };
  };
  const openMarkedIn = variant([...closed, ...opens.filter(counted).map((x) => ({ ...x, net: x.markNet }))], "open trades marked to the last close and COUNTED — the censoring is one-sided (an open trade is a dip that has not recovered: RSI5 has not crossed 50)");
  const haltSpan = { count: haltSpanning.length, counted: !dec.excludeHalt, openSpanning: opens.filter((x) => x.haltBars > 0).length, sma200WindowWithSynthetic: all.filter((x) => x.sma200WindowSynth > 0).length,
    trades: haltSpanning.map((x) => ({ sym: x.sym, entryDate: x.entryDate, exitDate: x.exitDate, hold: x.hold, haltBars: x.haltBars, netPct: r4(100 * x.net) })),
    variant: dec.excludeHalt ? variant(all, "halt-spanning trades INCLUDED (bars as served)") : variant(all.filter((x) => !x.haltBars), "halt-spanning trades EXCLUDED"),
    note: "Alpaca synthetic halt fills (v=0, O=H=L=C = previous close): RSI freezes and SMA200 drifts toward the halt price, and the trade exits on the relisting gap — a path no one could have traded." };
  const barCheck = head.months >= 3 ? { registered: bar, registeredForN: entry.nExpected, observedN: head.months, ...barAtN(head.months) } : { registered: bar, observedN: head.months };
  barCheck.borderline = barCheck.bar != null && head.tNetRaw != null && head.tNetRaw >= bar && head.tNetRaw < barCheck.bar;
  barCheck.note = "The registered bar applies unchanged. It was simulated at nExpected; a t in [registered bar, the same method's bar at the observed n) is flagged borderline for the seal note.";

  // reported (not gated)
  const spyP = prep(unpack(cache.spy.rows)), spySim = simulate(spyP, "SPY"), spyS = summarise(spySim.closed.map((x) => ({ ...x, net: x.gross - COST })));
  const holds = closed.map((x) => x.hold).sort((a, b) => a - b), inc = closed.filter((x) => !x.rsi2Cover);
  const perYear = {}; for (const [i, k] of head._keys.entries()) { const y = k.slice(0, 4); (perYear[y] || (perYear[y] = { months: [], trades: [] })).months.push(head._series[i]); }
  for (const x of closed) perYear[x.month.slice(0, 4)].trades.push(x.net);
  const reported = {
    etfOnly: { note: "14 ETFs only — the survivorship-free subset", ...strip(summarise(closed.filter((x) => ETFS.includes(x.sym)))) },
    spy2016: { note: "IN-SAMPLE / PREVIEWED — SPY was examined before registration; never gated", ...strip(spyS), openTrades: spySim.open.length },
    cost020: { note: "same trades at 0.20% round trip", ...strip(summarise(closed, { netOf: (x) => x.gross - COST_HI })) },
    rsi2Overlap: { note: "R150's RSI-2 long rule (close > SMA200, close < SMA5, RSI(2) Wilder < 10; exit first close > SMA5), simulated close-to-close per symbol over the whole series",
      r310Entries: closed.length, shareRsi2EntryFiresSameDay: closed.length ? r4(closed.filter((x) => x.rsi2Fires).length / closed.length) : null,
      shareRsi2ConditionTrueSameDay: closed.length ? r4(closed.filter((x) => x.rsi2Raw).length / closed.length) : null,
      shareRsi2FiresOrPositionOpen: closed.length ? r4(closed.filter((x) => x.rsi2Cover).length / closed.length) : null,
      increment: { note: "R310 trades entered on a symbol-day with no RSI-2 entry and no RSI-2 position open", ...strip(summarise(inc)) } },
    holdDays: { unit: "trading days (u - t)", median: nearestRank(holds, 0.5), p90: nearestRank(holds, 0.9), max: holds.length ? holds[holds.length - 1] : null, mean: holds.length ? r3(mean(holds)) : null, method: "nearest rank" },
    inMarket: { heldSessions, symbolSessions, share: symbolSessions ? r4(heldSessions / symbolSessions) : null, note: "sessions held (u - t per trade, open trades to the last bar) / gated symbol-sessions dated 2016-01-01 onward" },
    perYear: Object.fromEntries(Object.entries(perYear).sort().map(([y, v]) => [y, { months: v.months.length, meanNetPctPerMonth: r4(100 * mean(v.months)), trades: v.trades.length, meanPerTradePct: r4(100 * mean(v.trades)), winRatePct: r1(100 * v.trades.filter((x) => x > 0).length / v.trades.length) }])),
    openMarkedIn, haltSpanning: haltSpan, barCheck,
  };
  const out = {
    id: ID, spec: "r310-read-v2", read: true, asOf: new Date().toISOString(), unit: "months", n: head.months, months: head.months, trades: head.trades,
    tNet: head.tNet, tNetRaw: head.tNetRaw, meanNet: head.meanNet, meanNetPctPerMonth: head.meanNetPctPerMonth, winRate: head.winRate, winRatePct: head.winRatePct, meanPerTradePct: head.meanPerTradePct,
    placebo, floor, nextOpen, halves, controls, bar, barSource: "test-registry.json R310 bar.tRequired", preReadDecision: dec, gates, verdictScript, verdictReading,
    openAtLastBar: { count: opens.length, symbols: [...new Set(opens.map((x) => x.sym))], marks: opens.map((x) => ({ sym: x.sym, entryDate: x.entryDate, entry: x.entry, markDate: x.markDate, mark: x.mark, markNetPct: r4(100 * x.markNet), sessionsHeld: x.hold, haltBars: x.haltBars })) },
    ignoredSignalsWhileLong: ignored, reported,
    cache: { file: CACHE_REL, sha256: sha }, symbolsPriced: { count: syms.length, symbols: syms, missing: cache.missing, coverage: coverageSummary(cache) },
    implementationNotes: [
      ((cv) => cv.earliestSma200Bar && cv.earliestSma200Bar > ENTRY_FROM
        ? `Alpaca SIP history begins ${cv.earliestFirstBar} (requested ${FETCH_START}); the first finite SMA200 is ${cv.earliestSma200Bar}, so no entry precedes it and fewer entry months exist than the registered nExpected 129.`
        : `Warm-up satisfied: history begins ${cv.earliestFirstBar}, first finite SMA200 ${cv.earliestSma200Bar}.`)(coverageSummary(cache)),
      "Position state starts flat on 2016-01-01: no pre-2016 entry is simulated, so none blocks an early-2016 signal.",
      "Next-open gate groups trades by the calendar month of the fill (t+1); the signal-month grouping is reported beside it.",
      "Placebo candidate days are restricted to the entry window (2016-01-01..2026-09-30), including when widened to +-1 month.",
      "RSI-2 overlap uses the TradingView-seeded Wilder RSI(2) (R150 seeded its rma with a zero first change; identical after the 200-bar warm-up).",
      "The REGISTERED placebo is biased DOWN by two look-aheads in its design: same-month draws before the entry carry the dip forward, and the matched hold is the real trade's path-dependent exit (both channels; fixing the hold alone leaves the gate free). Every no-edge scramble beats it (controls calibration). placebo.corrected removes both (window disjoint from [t-3, u], hold from other symbols, no synthetic days); its p95 form is anti-conservative and never a gate; its paired NW t is the calibrated form. The gates in force are the pre-read decision recorded in the registry (preReadDecision).",
      "Synthetic halt bars (v=0, O=H=L=C) are part of the Alpaca bars as served; they are flagged, never altered. reported.haltSpanning lists the trades carried through them and the headline with them excluded (or included, under trades:exclude-halt-spanning).",
    ],
  };
  lines.push(`R310 READ — ${verdictScript} (bar t_NW >= ${bar}; gates in force ${JSON.stringify(dec.tokens)})`);
  lines.push(`  ${verdictReading}`);
  lines.push(`  trades ${head.trades} · months ${head.months} · net %/month ${head.meanNetPctPerMonth} · t_NW ${head.tNet} · win ${head.winRatePct}% · per trade ${head.meanPerTradePct}%`);
  lines.push(`  registered placebo p95 ${placebo.p95PctPerMonth}%/month vs observed ${placebo.observedPctPerMonth} -> ${placebo.beats ? "BEATEN" : "not beaten"}${placebo.gateInForce ? "" : " (reported)"} · paired diff ${placebo.pairedDiffMeanPctPerMonth}%/month t ${placebo.pairedDiffT} — no-edge null ${regNull.pairedDiffPctPerMonth.p50}, excess ${placebo.pairedDiffExcessOverNullPctPerMonth}`);
  lines.push(`  corrected placebo paired diff ${placebo.corrected.pairedDiffMeanPctPerMonth}%/month t ${placebo.corrected.pairedDiffT} (${placebo.corrected.pairedTAtLeastBar ? ">=" : "<"} bar)${placebo.corrected.gateInForce ? "" : " (reported)"} · p95 form ${placebo.corrected.p95PctPerMonth} (reported only) · widened ${placebo.corrected.widenedPerDraw}/draw · dropped ${placebo.corrected.droppedPerDraw}/draw`);
  lines.push(`  drift-kept floor p50 ${floor.p50PctPerMonth} / p95 ${floor.p95PctPerMonth} -> mean > p95 ${floor.meanAboveP95} · t vs p50 ${floor.tVsP50} ${floor.clears ? "CLEARS" : "does not clear"}${dec.floor ? "" : " (reported)"}`);
  lines.push(`  next-open ${nextOpen.meanNetPctPerMonth}%/month (${nextOpen.positive ? "> 0" : "not > 0"}) · halves ${halves.first.meanNetPctPerMonth}/${halves.second.meanNetPctPerMonth} · open at last bar ${opens.length}`);
  lines.push(`  sensitivity — open marked in: t ${openMarkedIn.tNet}, flips ${JSON.stringify(openMarkedIn.gatesThatFlip)} · halt-spanning ${haltSpan.count} (${haltSpan.counted ? "counted" : "excluded"}): variant flips ${JSON.stringify(haltSpan.variant.gatesThatFlip)} · bar at n=${barCheck.observedN} ${barCheck.bar}${barCheck.borderline ? " — BORDERLINE" : ""}`);
  lines.push(`  gates ${JSON.stringify(gates)}`);
  return { out, lines };
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const st = selftest();
  console.log(`R310 selftest ${st.pass ? "PASS" : "FAIL"} ${JSON.stringify(st.checks)}`);
  if (!st.pass) { console.log(`  detail ${JSON.stringify(st.detail)}`); process.exit(1); }
  if (SELFTEST_ONLY) return;

  if (!READ) {
    // CONTROLS RUN — summarises ONLY scrambles (drift-free and drift-kept, as R150) and the winners-only look-ahead subset of real
    // trades; no unfiltered real statistic is computed or written.
    const { cache, sha, fetched } = await loadOrFetch(true), syms = cache.returned, cov = coverageSummary(cache);
    console.log(`R310 bars ${fetched ? "fetched + cached" : "from cache"} — ${cov.priced}/${cov.requested} gated symbols priced; sha256 ${sha}`);
    const entry = registryEntry(), bar = entry && entry.bar ? Number(entry.bar.tRequired) : NaN;
    if (!fin(bar)) { console.error(`${ID} registry entry missing or has no numeric bar.tRequired — refusing`); process.exit(2); }
    // REGISTERED leak test (seeds 1, 2, drift-free) — a null t is unmeasured, so it FAILS (fail closed), never passes
    const leak = [1, 2].map((seed) => { const tr = []; for (const s of syms) { const P = prep(scramble(unpack(cache.gated[s]), seed, s, true)); for (const x of simulate(P, s).closed) tr.push({ ...x, net: x.gross - COST }); } return summarise(tr); });
    const winners = [];
    for (const s of syms) { for (const x of simulate(prep(unpack(cache.gated[s])), s).closed) { const net = x.gross - COST; if (net > 0) winners.push({ ...x, net }); } }   // filtered at once
    const peek = summarise(winners);
    const leakOk = leak.every((a) => a.tNetRaw != null && a.tNetRaw < 2), peekOk = peek.tNetRaw != null && peek.tNetRaw >= 3;
    // CALIBRATION on no-edge scrambles (drift-kept 1..60: per-symbol drift and survivorship kept, timing destroyed; drift-free 1..20)
    console.log(`R310 calibrating on ${FLOOR_SEEDS} drift-kept + ${LEAK_DIAG_SEEDS} drift-free scrambles (placebos ${PLACEBO_DRAWS} draws each) ...`);
    const kept = [], free = [];
    for (let s = 1; s <= FLOOR_SEEDS; s++) kept.push(scrambleRun(cache, syms, s, false, bar));
    for (let s = 1; s <= LEAK_DIAG_SEEDS; s++) free.push(scrambleRun(cache, syms, s, true, bar));
    const calibration = calibrate(kept, free, bar);
    const decision = preReadDecision(entry), pass = leakOk && peekOk, ready = pass && calibration.ok && decision.decided;
    const holdWhy = !calibration.ok ? "calibration incomplete" : !decision.decided ? `pre-read decision pending (${decision.why})` : null;
    writeJsonAtomic(CTRL, { spec: "r310-controls-v2", id: ID, asOf: new Date().toISOString(), runner: { file: "backend/r310-qs-rsi5.js", sha256: sha256(fs.readFileSync(__filename)) }, cache: { file: CACHE_REL, sha256: sha, fetchedAt: cache.fetchedAt }, coverage: cov,
      symbolsPriced: syms.map((x) => ({ symbol: x, firstBar: cache.coverage[x].firstBar, lastBar: cache.coverage[x].lastBar, bars: cache.coverage[x].bars })), selftest: st,
      leakTest: { method: "drift-free bar shuffle within each symbol (R150 scramble, demean=true), seeds 1, 2; the R310 rule run unchanged on the scrambles", requirement: "t_NW < 2 on both seeds (a null t fails)", pass: leakOk, seed1: slim(leak[0]), seed2: slim(leak[1]),
        diagnostic20Seeds: calibration.leakDiagnostic },
      positiveControl: { method: "R310 trades whose own realised net (after 0.10%) is positive — outcome look-ahead", requirement: "t_NW >= 3", pass: peekOk, result: slim(peek) },
      pass, calibration, preReadDecision: decision, ready, holdWhy,
      howToRecordTheDecision: { where: "backend/data/test-registry.json, the R310 entry: append to amendments[] (create it) BEFORE the read, plus a dated change-registry entry", shape: { date: "YYYY-MM-DD", preEvidence: true, field: "controls.placebo / decisionRule.pass", was: "...", becomes: "...", why: "...", runnerGates: ["placebo:corrected-paired-t", "floor:drift-kept"] },
        exampleIsTheCalibratedSet: "placebo:corrected-paired-t + floor:drift-kept: 1.7% false pass on 60 drift-kept no-edge scrambles (leave-one-out) vs 100% for the registered gates; add trades:exclude-halt-spanning to drop the synthetic-halt trades",
        tokens: RUNNER_GATES, rule: "exactly one placebo:* token; floor:drift-kept and trades:exclude-halt-spanning optional; unknown tokens refuse the read" },
      note: "Only scrambles (drift-free and drift-kept) and the winners-only look-ahead subset of real trades are summarised; no unfiltered real statistic is computed or written." });
    const c = calibration, pc = (x) => (x == null ? null : +(100 * x).toFixed(1));
    console.log(`R310 controls — leak ${leakOk ? "PASS" : "FAIL"} seed 1 ${JSON.stringify(slim(leak[0]))}`);
    console.log(`  seed 2 ${JSON.stringify(slim(leak[1]))} · 20-seed drift-free t p50 ${c.leakDiagnostic.tNW.p50}, share >= 2 ${pc(c.leakDiagnostic.shareTAtLeast2)}%`);
    console.log(`  look-ahead ${peekOk ? "PASS" : "FAIL"} ${JSON.stringify(slim(peek))}`);
    console.log(`  registered placebo: beaten on ${pc(c.registeredPlacebo.driftKept.shareBeaten)}% drift-kept / ${pc(c.registeredPlacebo.driftFree.shareBeaten)}% drift-free no-edge scrambles · registered decision rule PASS on ${pc(c.registeredDecisionRule.driftKeptSharePass)}% drift-kept`);
    console.log(`  registered paired diff null (drift-kept) p50 ${c.registeredPlacebo.driftKept.pairedDiffPctPerMonth.p50}%/month, t ${c.registeredPlacebo.driftKept.pairedDiffT.min}..${c.registeredPlacebo.driftKept.pairedDiffT.max} — not evidence of anything`);
    console.log(`  corrected placebo: p95 form beaten ${pc(c.correctedPlacebo.driftKept.shareP95Beaten)}% (anti-conservative) · paired t >= bar ${pc(c.correctedPlacebo.driftKept.sharePairedTAtLeastBar)}% drift-kept, ${pc(c.correctedPlacebo.driftFree.sharePairedTAtLeastBar)}% drift-free (paired t p50 ${c.correctedPlacebo.driftKept.pairedDiffT.p50} / ${c.correctedPlacebo.driftFree.pairedDiffT.p50})`);
    console.log(`  drift-kept floor p50 ${c.floor.all.p50PctPerMonth} / p95 ${c.floor.all.p95PctPerMonth} %/month (excl. halt-spanning ${c.floor.exclHalt.p50PctPerMonth} / ${c.floor.exclHalt.p95PctPerMonth}) · floor gate false pass (leave-one-out) ${pc(c.floor.looFalsePass)}% · recommended set false pass ${pc(c.recommendedSet.looFalsePass)}%`);
    console.log(`  pre-read decision: ${decision.decided ? JSON.stringify(decision.tokens) : `NONE — ${decision.why}`}`);
    console.log(`  missing ${JSON.stringify(cov.missing)} · earliest first bar ${cov.earliestFirstBar} (requested ${FETCH_START}) · first SMA200 ${cov.earliestSma200Bar} · with SMA200 ${cov.withSma200} · last bar before ${LAST_BAR}: ${JSON.stringify(cov.lastBarBefore20261001)}`);
    console.log(ready ? "R310 READY — the one read is: node backend/r310-qs-rsi5.js --read"
      : !pass ? "R310 NOT READY — a registered control failed; the read is refused until it is understood"
      : `R310 NOT READY — registered controls PASS (leak, positive control); the read is HELD: ${holdWhy}. The registered placebo gate is cleared by every no-edge scramble, so the operator records a pre-read choice of gates first (see howToRecordTheDecision in ${path.basename(CTRL)}).`);
    return;
  }

  // ── THE READ (once) ──
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests && seals.tests[ID]) { console.error(`${ID} already sealed — refusing`); process.exit(2); }
  if (fs.existsSync(OUT) && JSON.parse(fs.readFileSync(OUT, "utf8")).read) { console.error(`${ID} already read — seal it, do not re-read`); process.exit(2); }
  const ctrl = fs.existsSync(CTRL) ? JSON.parse(fs.readFileSync(CTRL, "utf8")) : null; if (!ctrl || !ctrl.pass) { console.error(`${ID} controls have not passed`); process.exit(2); }
  if (ctrl.spec !== "r310-controls-v2" || !ctrl.calibration || !ctrl.calibration.ok) { console.error(`${ID} controls file has no complete calibration (spec ${ctrl.spec}) — re-run the controls`); process.exit(2); }
  const entry = registryEntry();
  if (!entry) { console.error(`${ID} not registered`); process.exit(2); }
  const bar = Number(entry.bar && entry.bar.tRequired); if (!fin(bar)) { console.error(`${ID} registry entry has no numeric bar.tRequired`); process.exit(2); }
  // The gates in force come from the REGISTRY at read time (not from the controls file): absent / ambiguous / unknown -> held.
  const dec = preReadDecision(entry);
  if (!dec.decided) { console.error(`${ID} read HELD — no pre-read gate decision (${dec.why}). The registered placebo is cleared by every no-edge scramble; record amendments[].runnerGates in the R310 entry first (see howToRecordTheDecision in ${path.basename(CTRL)}).`); process.exit(2); }
  const { cache, sha } = await loadOrFetch(false);
  if (!ctrl.cache || ctrl.cache.sha256 !== sha) { console.error(`${ID} bar cache sha256 ${sha} differs from the controls run's ${ctrl.cache && ctrl.cache.sha256} — refusing`); process.exit(2); }
  const runnerSha = sha256(fs.readFileSync(__filename));   // the floor/calibration in the controls file must come from THIS runner (final review 2026-10-02)
  if (!ctrl.runner || ctrl.runner.sha256 !== runnerSha) { console.error(`${ID} controls were produced by a different runner (${ctrl.runner && ctrl.runner.sha256} vs ${runnerSha}) — re-run the controls`); process.exit(2); }
  const { out, lines } = computeRead({ cache, sha, ctrl, entry, dec, bar });
  writeJsonAtomic(OUT, out);
  for (const l of lines) console.log(l);
}
// Run only when invoked directly. A require() (tests, scratch checks) gets the pure functions and never reaches main: no fetch, no write.
if (require.main === module) main().catch((e) => { console.error("R310 FAILED:", e.message); process.exit(1); });
else module.exports = { prep, simulate, summarise, nwT, mean, scramble, unpack, placeboPrep, placeboRun, placeboPrepC, placeboRunC, pairedDiffs, coreGates, floorGate, preReadDecision, haltBarsIn, synthIn, barAtN, computeRead, nextOpenOf, selftest, mulberry, shiftMonth, RUNNER_GATES, CACHE, COST, ENTRY_FROM, ENTRY_TO, PLACEBO_DRAWS, PLACEBO_SEED, fin };
