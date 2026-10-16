#!/usr/bin/env node
/**
 * ETF_TSMOM — CROSS-ASSET TIME-SERIES MOMENTUM ON 16 ETFs, TIMING ONLY (sign vs always-long), sealed holdout. Registered 2026-09-23.
 *
 * HYPOTHESIS. The sign of an asset's own trailing 12-month return predicts its next-month return (time-series momentum), so a
 * vol-scaled portfolio that is long assets with positive 12-month returns and SHORT assets with negative ones beats the SAME
 * vol-scaled portfolio held always-long. Subtracting the always-long twin removes the asset-class exposure: what is left is the
 * timing (the sign) alone. Algebraically the spread is  (1/N) * sum_i (sign_i - 1) * scale_i * r_i  = -2 x the vol-scaled return of
 * the assets currently flagged negative, i.e. "does shorting this month's downtrend names beat holding them?"
 *
 * SOURCES. Moskowitz, Ooi & Pedersen (2012) "Time series momentum", JFE 104(2) — 12-month lookback, 1-month hold, 40%-vol scaling
 *   per instrument (here 10% portfolio-style target per ETF, the AQR TSMOM index convention). Hurst, Ooi & Pedersen (2017) "A century
 *   of evidence on trend-following investing", AQR. SKEPTICAL: Huang, Li, Wang & Zhou (2020) "Time series momentum: Is it there?",
 *   JFE 135(3) — the pooled TSMOM t-stat is largely the cross-sectional mean-return spread, not own-asset time-series predictability;
 *   asset-by-asset predictive regressions are weak. This test is built to answer exactly their point: the always-long vol-scaled
 *   benchmark absorbs the pooled mean return, so only sign-timing can pay.
 *
 * UNIVERSE. SPY QQQ IWM EFA EEM TLT IEF LQD HYG GLD SLV DBC USO UNG VNQ UUP. Alpaca SIP daily bars, adjustment=all (total return;
 *   both legs use the same adjusted series, so the adjustment cannot favour either). Alpaca's SIP history floor is 2016-01-04 for every
 *   symbol, so the brief's "data from 2015" drop rule is applied as "first bar on or before 2016-01-31" (all 16 qualify; see spec).
 *
 * EXACT MECHANICAL RULE (frozen before any statistic):
 *   Formation at every month-end trading day t (close). For each ETF i with the needed history:
 *     ret12_i  = close(t) / close(month-end 12 months earlier) - 1           (needs that month-end close to exist)
 *     sigma_i  = sample sd of the last 60 daily close-to-close returns ending at t (>= 40 valid), x sqrt(252)
 *     scale_i  = min(2, 0.10 / sigma_i)                                       (10% annualized target vol, capped at 2x)
 *     sign_i   = +1 if ret12_i > 0, -1 if < 0, 0 if exactly 0
 *     TSMOM weight  w_i = sign_i * scale_i / N ;  BENCHMARK weight b_i = scale_i / N   (N = ETFs valid at t; 1/N average)
 *   Execution: enter at the OPEN of the next session (t+1); hold to the OPEN of the session after the next month-end (the next
 *   rebalance). The last period of a window exits at the window's last close (discovery: 2021-12-31 close; holdout: 2026-09-22 close),
 *   so no price after a window's end is ever read. Holding-month label = the month of the entry session.
 *   MEMBERSHIP (fixes2026_09_23 E1): N = ETFs valid at formation t from data known at t only. An ETF with a missing FUTURE price is
 *   NOT dropped; it is held at its last available price (delisting-style). Fallbacks: entry open(t+1) -> close(t+1) -> close(t);
 *   exit open(x) -> close(x-1) -> latest close after entry -> entry price (return 0). See holdReturn() and the spec's priceFallback.
 *   VERDICT (F1): every bar comparison reads unrounded values (rawStats/holdoutVerdict); rounding is display only.
 *   COST: 0.05% x sum_i |w_i(now) - w_i(prev)| per rebalance, charged to each leg on its own weights (prev = 0 at first formation).
 *   MONTHLY STATISTIC: spread_net = (TSMOM gross - TSMOM cost) - (BENCH gross - BENCH cost). Gross spread = TSMOM gross - BENCH gross.
 *
 * STATISTIC. Newey-West t (lag 3) of the monthly net spread; report mean, t, both-halves means (split at floor(n/2)), gross and net,
 *   plus the two legs separately as weightless context.
 *
 * WINDOWS. DISCOVERY 2017-01-01..2021-12-31 (first formable month is Feb 2017: the 12-month lookback needs the 2016-01-29 month-end;
 *   59 months). HOLDOUT 2022-01-01..2026-09-22 (57 months, Sep 2026 partial to 09-22). Discovery mode physically truncates the panel at
 *   2021-12-31, so no holdout price is loaded into any computation outside --holdout.
 *
 * PROTOCOL.
 *   --selftest   synthetic known-answer checks only (no real data). PASS/FAIL, exit 1 on FAIL.
 *   --build      fetch + cache the daily panel to data/hunt/ETF_TSMOM-bars.json (prints counts only). Run implicitly by --controls.
 *   --controls   (discovery-truncated panel only) LEAK: iid BOOTSTRAP null — each synthetic day draws one real day WITH replacement
 *                (the same drawn day for all 16 ETFs, so cross-correlation is kept), each ETF's arithmetic drift removed; the GROSS spread
 *                must give |NW t| < 2 on the designated seed AND the |t|>=2 rate over 200 bootstrap panels must be <= 0.125 (NW size check).
 *                POSITIVE: sign = sign of the ETF's own realized hold-period return (peeks at the outcome); gross t >= 5. -> -controls.json
 *   --discovery  refuses unless controls passed AND backend/data/test-registry.json has a preregistered entry with
 *                script === "backend/hunt/ETF_TSMOM.js"; computes discovery statistics only; writes -discovery.json ONCE.
 *                Discovery is descriptive: a single frozen rule has nothing to select, so it does not gate the holdout.
 *   --holdout    refuses unless discovery exists (and registry entry); computes the holdout statistic ONCE; writes -holdout.json once.
 *                PASS iff net mean > 0 AND NW t >= barTRequired (1.70, single variant, read from the spec) AND both halves' net means > 0.
 *   --status
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const KEY = "ETF_TSMOM", SCRIPT_REL = "backend/hunt/ETF_TSMOM.js";
const DATA = path.join(__dirname, "..", "data"), HD = path.join(DATA, "hunt");
const F = (s) => path.join(HD, `${KEY}-${s}.json`);
const CACHE = F("bars"), CTRL = F("controls"), OUTD = F("discovery"), OUTH = F("holdout"), SPEC = F("spec"), REG = path.join(DATA, "test-registry.json");
const ETFS = ["SPY", "QQQ", "IWM", "EFA", "EEM", "TLT", "IEF", "LQD", "HYG", "GLD", "SLV", "DBC", "USO", "UNG", "VNQ", "UUP"];
const DISC = ["2017-01-01", "2021-12-31"], HOLD = ["2022-01-01", "2026-09-22"], FETCH_START = "2015-01-01", FIRST_BAR_BY = "2016-01-31";
const COST = 0.0005, TGT = 0.10, CAP = 2, LB_M = 12, VOLN = 60, VOLMIN = 40, NWL = 3, NULL_SEED = 20260923, NULL_REPS = 200, NULL_RATE_MAX = 0.125;

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a, L = NWL) { const n = a.length; if (n < 6) return null; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n; for (let k = 1; k <= L; k++) { let c = 0; for (let i = k; i < n; i++) c += d[i] * d[i - k]; v += 2 * (1 - k / (L + 1)) * c / n; } return v > 0 ? m / Math.sqrt(v / n) : null; }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = (rng) => { let u = 0; while (u === 0) u = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); };
const r5 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(5)), r3 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(3));

// ── panel: { syms, dates[T], O[i][T], C[i][T] } (NaN where absent) ────────────────────────────────────────────────────────────────
function truncate(P, lastDate) { const T = P.dates.filter((d) => d <= lastDate).length; return { syms: P.syms, dates: P.dates.slice(0, T), O: P.O.map((a) => a.slice(0, T)), C: P.C.map((a) => a.slice(0, T)) }; }
const monthEnds = (dates) => { const e = []; for (let t = 0; t < dates.length; t++) if (t === dates.length - 1 || dates[t + 1].slice(0, 7) !== dates[t].slice(0, 7)) e.push(t); return e; };

// signal + vol scale for every ETF at formation month-end index mi (t = me[mi]); uses only closes at indices <= t
function weightsAt(P, me, mi) {
  const t = me[mi], out = new Map(); if (mi < LB_M) return out;
  const t12 = me[mi - LB_M];
  for (let i = 0; i < P.syms.length; i++) {
    const C = P.C[i], c1 = C[t], c0 = C[t12]; if (!(c1 > 0 && c0 > 0)) continue;
    const rs = []; for (let k = t - VOLN + 1; k <= t; k++) { if (k < 1) continue; const a = C[k - 1], b = C[k]; if (a > 0 && b > 0) rs.push(b / a - 1); }
    if (rs.length < VOLMIN) continue;
    const m = mean(rs), sd = Math.sqrt(rs.reduce((s, x) => s + (x - m) ** 2, 0) / (rs.length - 1)), sig = sd * Math.sqrt(252);
    const scale = sig > 0 ? Math.min(CAP, TGT / sig) : CAP, ret12 = c1 / c0 - 1;
    out.set(i, { sign: ret12 > 0 ? 1 : ret12 < 0 ? -1 : 0, scale, ret12, sig });
  }
  return out;
}
// entry at the open of t+1; exit at the open of the session after the next month-end, or the panel's last close if that is past the end.
// Membership is decided at formation (weightsAt: the ETF has a close at t), so this NEVER returns NaN for a member — a missing future
// price is filled delisting-style from the last price available, never by dropping the ETF (fixes2026_09_23 E1). Price-fallback rules:
//   ENTRY: open(t+1); else close(t+1); else close(t) (the formation close, the last known price -> held flat until a price reappears).
//   EXIT : x = session after the next month-end. If x is inside the panel: open(x); else close(x-1); else the latest close in
//          [t+1, x-1]; else the entry price (return 0: held at its last available price). If x is past the panel's end: close(T-1);
//          else the latest close in [t+1, T-1]; else the entry price.
// `info` (optional) receives { entrySrc, exitSrc } so fallbacks can be counted and disclosed.
function holdReturn(P, i, t, tNextMe, info) {
  const T = P.dates.length, O = P.O[i], C = P.C[i], e = t + 1;
  let entry, entrySrc;
  if (e <= T - 1 && O[e] > 0) { entry = O[e]; entrySrc = "open"; }
  else if (e <= T - 1 && C[e] > 0) { entry = C[e]; entrySrc = "close"; }
  else if (C[t] > 0) { entry = C[t]; entrySrc = "formationClose"; }
  else { if (info) { info.entrySrc = "none"; info.exitSrc = "none"; } return NaN; }   // not a member (weightsAt requires C[t] > 0)
  const x = tNextMe + 1, lastIx = Math.min(x, T) - 1; let exit, exitSrc;
  if (x <= T - 1 && O[x] > 0) { exit = O[x]; exitSrc = "open"; }
  else if (C[lastIx] > 0 && lastIx >= e) { exit = C[lastIx]; exitSrc = x <= T - 1 ? "prevClose" : "lastClose"; }
  else { for (let k = lastIx - 1; k >= e; k--) if (C[k] > 0) { exit = C[k]; exitSrc = "lastAvailableClose"; break; }
    if (!(exit > 0)) { exit = entry; exitSrc = "heldAtEntry"; } }
  if (info) { info.entrySrc = entrySrc; info.exitSrc = exitSrc; }
  return exit / entry - 1;
}

// monthly series for holding months whose label falls in [fromYm, toYm]. peek = sign from the realized outcome (positive control only)
function run(P, fromYm, toYm, peek = false) {
  const me = monthEnds(P.dates), T = P.dates.length, series = []; let prevW = new Map(), prevB = new Map();
  for (let mi = 0; mi < me.length; mi++) {
    const t = me[mi]; if (t + 1 > T - 1) break;
    const ym = P.dates[t + 1].slice(0, 7); if (ym > toYm) break;
    const W = weightsAt(P, me, mi); if (!W.size) continue;
    const tNext = mi + 1 < me.length ? me[mi + 1] : T - 1;
    const inWin = ym >= fromYm;
    // membership = ETFs valid at formation t ONLY (weightsAt reads closes <= t). The 1/N weights never depend on whether a FUTURE
    // price exists: holdReturn fills a missing future price from the last available price (fixes2026_09_23 E1).
    const rets = new Map(); let nFallback = 0;
    if (inWin) for (const i of W.keys()) { const info = {}; rets.set(i, holdReturn(P, i, t, tNext, info)); if (info.entrySrc !== "open" || !(info.exitSrc === "open" || info.exitSrc === "lastClose")) nFallback++; }
    const valid = [...W.keys()], N = valid.length; if (!N) continue;
    const w = new Map(), b = new Map();
    for (const i of valid) { const x = W.get(i), sg = peek && inWin ? Math.sign(rets.get(i)) : x.sign; w.set(i, sg * x.scale / N); b.set(i, x.scale / N); }
    const turn = (cur, prev) => { let s = 0; const ks = new Set([...cur.keys(), ...prev.keys()]); for (const k of ks) s += Math.abs((cur.get(k) || 0) - (prev.get(k) || 0)); return s; };
    const turnW = turn(w, prevW), turnB = turn(b, prevB); prevW = w; prevB = b;
    if (!inWin) continue;
    let gW = 0, gB = 0; for (const i of valid) { const r = rets.get(i); gW += w.get(i) * r; gB += b.get(i) * r; }
    const nW = gW - COST * turnW, nB = gB - COST * turnB;
    series.push({ ym, n: N, nFallback, nShort: valid.filter((i) => w.get(i) < 0).length, grossTS: gW, grossBM: gB, netTS: nW, netBM: nB, gross: gW - gB, net: nW - nB, turnTS: turnW, turnBM: turnB });
  }
  return series;
}
// UNROUNDED statistics — every bar comparison reads these (fixes2026_09_23 F1). Fractions per month, not %.
function rawStats(s) {
  const net = s.map((x) => x.net), g = s.map((x) => x.gross), h = Math.floor(net.length / 2);
  return { netMean: mean(net), tNW: nwT(net), grossMean: mean(g), tGrossNW: nwT(g), firstHalfNetMean: mean(net.slice(0, h)), secondHalfNetMean: mean(net.slice(h)) };
}
// the registered PASS rule, on RAW values only: a raw t of 1.6995 fails a 1.70 bar even though it displays as 1.7
function holdoutVerdict(raw, bar) {
  const clears = Number.isFinite(raw.netMean) && raw.netMean > 0 && raw.tNW != null && Number.isFinite(raw.tNW) && raw.tNW >= bar
    && Number.isFinite(raw.firstHalfNetMean) && raw.firstHalfNetMean > 0 && Number.isFinite(raw.secondHalfNetMean) && raw.secondHalfNetMean > 0;
  return clears ? "PASS" : "DID NOT PASS";
}
// display summary (rounded) + the raw values it was rounded from
function summarize(s) {
  const raw = rawStats(s);
  return { months: s.length, first: s[0] && s[0].ym, last: s.length ? s[s.length - 1].ym : null,
    netPctPerMonth: r3(100 * raw.netMean), tNW: r3(raw.tNW), grossPctPerMonth: r3(100 * raw.grossMean), tGrossNW: r3(raw.tGrossNW),
    firstHalfNetPct: r3(100 * raw.firstHalfNetMean), secondHalfNetPct: r3(100 * raw.secondHalfNetMean),
    context: { tsmomNetPctPerMonth: r3(100 * mean(s.map((x) => x.netTS))), benchNetPctPerMonth: r3(100 * mean(s.map((x) => x.netBM))),
      meanTurnoverTS: r3(mean(s.map((x) => x.turnTS))), meanTurnoverBM: r3(mean(s.map((x) => x.turnBM))), meanShortCount: r3(mean(s.map((x) => x.nShort))),
      monthsWithPriceFallback: s.filter((x) => x.nFallback > 0).length, etfMonthsWithPriceFallback: s.reduce((a, x) => a + (x.nFallback || 0), 0) },
    raw };
}

// iid bootstrap null: synthetic day k draws one real day j (same j for every ETF); each ETF's close ratio divided by its own mean ratio
// (drift removed); the open keeps the drawn day's open/close relation. Past and future are independent by construction.
function bootstrapPanel(P, seed) {
  const rng = mulberry(seed), T = P.dates.length, S = P.syms.length, pool = [];
  for (let k = 1; k < T; k++) { let ok = true; for (let i = 0; i < S; i++) if (!(P.C[i][k] > 0 && P.C[i][k - 1] > 0 && P.O[i][k] > 0)) { ok = false; break; } if (ok) pool.push(k); }
  const mu = P.C.map((C) => mean(pool.map((k) => C[k] / C[k - 1])));
  const O = P.C.map(() => new Array(T).fill(NaN)), C = P.C.map(() => new Array(T).fill(NaN));
  for (let i = 0; i < S; i++) { C[i][0] = P.C[i][0] > 0 ? P.C[i][0] : 100; O[i][0] = C[i][0]; }
  for (let k = 1; k < T; k++) { const j = pool[Math.floor(rng() * pool.length)];
    for (let i = 0; i < S; i++) { C[i][k] = C[i][k - 1] * (P.C[i][j] / P.C[i][j - 1]) / mu[i]; O[i][k] = C[i][k] * (P.O[i][j] / P.C[i][j]); } }
  return { syms: P.syms, dates: P.dates, O, C };
}

// ── data ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function build() {
  if (fs.existsSync(CACHE)) { console.log(`${KEY} cache exists`); return; }
  const { fetchBars } = require("../lib/alpaca-bars.js");
  const { bars } = await fetchBars(ETFS, { start: FETCH_START, end: "2026-09-22T21:00:00Z", timeframe: "1Day", feed: "sip", adjustment: "all", quiet: true, requireAll: false });
  const keep = ETFS.filter((s) => bars[s] && bars[s].length && bars[s][0].t.slice(0, 10) <= FIRST_BAR_BY), dropped = ETFS.filter((s) => !keep.includes(s));
  const dates = [...new Set(keep.flatMap((s) => bars[s].map((b) => b.t.slice(0, 10))))].filter((d) => d <= HOLD[1]).sort();
  const ix = new Map(dates.map((d, k) => [d, k])), O = {}, C = {};
  for (const s of keep) { O[s] = new Array(dates.length).fill(null); C[s] = new Array(dates.length).fill(null);
    for (const b of bars[s]) { const k = ix.get(b.t.slice(0, 10)); if (k == null) continue; O[s][k] = b.o; C[s][k] = b.c; } }
  fs.mkdirSync(HD, { recursive: true });
  writeJsonAtomic(CACHE, { spec: `${KEY}-bars-v1`, builtAt: new Date().toISOString(), source: "alpaca sip 1Day adjustment=all", syms: keep, dropped, dates, O, C }, { pretty: 0 });
  console.log(`${KEY} cache: ${keep.length} ETFs x ${dates.length} days (${dates[0]}..${dates[dates.length - 1]}); dropped ${dropped.join(",") || "none"}`);
}
function loadPanel() {
  const j = JSON.parse(fs.readFileSync(CACHE, "utf8")), nz = (a) => a.map((x) => (x == null ? NaN : x));
  return { syms: j.syms, dates: j.dates, O: j.syms.map((s) => nz(j.O[s])), C: j.syms.map((s) => nz(j.C[s])) };
}
const registered = () => { try { const r = JSON.parse(fs.readFileSync(REG, "utf8")); return (r.preregistered || []).find((x) => x && x.script === SCRIPT_REL) || null; } catch { return null; } };
const ymOf = (d) => d.slice(0, 7);

// ── selftest (synthetic only) ────────────────────────────────────────────────────────────────────────────────────────────────────────
function synthDates(from = "2016-01-04", to = "2026-09-22") { const out = []; for (let d = new Date(from + "T12:00:00Z"); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) { const w = d.getUTCDay(); if (w && w < 6) out.push(d.toISOString().slice(0, 10)); } return out; }
function synthPanel(S, dates, retFn) { const T = dates.length, O = [], C = []; for (let i = 0; i < S; i++) { const o = new Array(T), c = new Array(T); c[0] = 100; o[0] = 100; for (let k = 1; k < T; k++) { const { gap, intra } = retFn(i, k); o[k] = c[k - 1] * (1 + gap); c[k] = o[k] * (1 + intra); } O.push(o); C.push(c); } return { syms: Array.from({ length: S }, (_, i) => `S${i}`), dates, O, C }; }
function selftest() {
  const checks = [], ok = (name, pass, detail) => { checks.push({ name, pass }); console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); };
  const dates = synthDates();
  // 1. hand-computed known answer: A alternates +1%/-0.5% (uptrend), B alternates -1%/+0.5% (downtrend); returns land at the open (gap), intraday flat
  { const P = synthPanel(2, dates, (i, k) => ({ gap: (i === 0 ? (k % 2 ? 0.01 : -0.005) : (k % 2 ? -0.01 : 0.005)), intra: 0 }));
    const s = run(P, "2017-01", "2021-12"), me = monthEnds(P.dates), sd = 0.0075 * Math.sqrt(60 / 59), scale = Math.min(CAP, TGT / (sd * Math.sqrt(252)));
    const row = s.find((x) => x.ym === "2019-06"), mi = me.findIndex((t) => P.dates[t + 1].slice(0, 7) === "2019-06"), t = me[mi], x = me[mi + 1] + 1;
    const rB = P.O[1][x] / P.O[1][t + 1] - 1, rA = P.O[0][x] / P.O[0][t + 1] - 1, W = weightsAt(P, me, mi);
    const expGross = (1 / 2) * (-2) * scale * rB, expTS = 0.5 * scale * rA - 0.5 * scale * rB;
    ok("known-answer signs (+1 uptrend, -1 downtrend)", W.get(0).sign === 1 && W.get(1).sign === -1);
    ok("known-answer vol scale = 0.10/(sd*sqrt252)", Math.abs(W.get(0).scale - scale) < 1e-12 && Math.abs(W.get(1).scale - scale) < 1e-12, `scale ${scale.toFixed(6)}`);
    ok("known-answer gross spread = -2*(1/N)*scale*r_short (open->open)", Math.abs(row.gross - expGross) < 1e-12 && Math.abs(row.grossTS - expTS) < 1e-12, `${row.gross.toExponential(4)} vs ${expGross.toExponential(4)}`);
    ok("steady-state cost: constant weights -> net = gross", Math.abs(row.net - row.gross) < 1e-15);
    ok("first month pays entry cost 0.05% x sum|w|", Math.abs(s[0].netTS - (s[0].grossTS - COST * s[0].turnTS)) < 1e-15 && Math.abs(s[0].turnTS - scale) < 1e-12);
    ok("first formable holding month is Feb 2017 (12 month-ends of history)", s[0].ym === "2017-02", s[0].ym); }
  // 2. no look-ahead: perturbing every price after formation day t leaves the weights at t unchanged
  { const rng = mulberry(7), P = synthPanel(4, dates, () => ({ gap: 0.002 * gauss(rng), intra: 0.01 * gauss(rng) })), me = monthEnds(P.dates), mi = 40, t = me[mi], W0 = weightsAt(P, me, mi);
    const Q = { ...P, O: P.O.map((a) => a.map((v, k) => (k > t ? v * (1 + rng()) : v))), C: P.C.map((a) => a.map((v, k) => (k > t ? v * (1 + rng()) : v))) }, W1 = weightsAt(Q, me, mi);
    ok("no look-ahead: weights at t ignore every price after t", [...W0.keys()].every((i) => W0.get(i).sign === W1.get(i).sign && W0.get(i).scale === W1.get(i).scale)); }
  // 3. window truncation: discovery panel ends 2021-12-31; no holding month >= 2022 exists; last month exits at the last close
  { const rng = mulberry(8), P = synthPanel(3, dates, () => ({ gap: 0, intra: 0.01 * gauss(rng) })), D = truncate(P, DISC[1]), s = run(D, ymOf(DISC[0]), ymOf(HOLD[1]));
    ok("discovery truncation: no date > 2021-12-31, no month >= 2022-01", D.dates[D.dates.length - 1] <= DISC[1] && s.every((x) => x.ym <= "2021-12") && s[s.length - 1].ym === "2021-12"); }
  // 4. planted trend: persistent regime drifts (flip ~every 2 years) -> TSMOM beats always-long, t >= 3
  { const rng = mulberry(11), S = 16, reg = Array.from({ length: S }, () => (rng() < 0.5 ? 1 : -1));
    const P = synthPanel(S, dates, (i, k) => { if (i === 0 && k > 0) for (let j = 0; j < S; j++) if (rng() < 1 / 500) reg[j] = -reg[j]; return { gap: 0, intra: 0.0008 * reg[i] + 0.01 * gauss(rng) }; });
    const sm = summarize(run(P, "2017-01", "2021-12")); ok("planted trend detected (net t >= 3)", sm.raw.tNW >= 3, `net ${sm.netPctPerMonth}%/mo t ${sm.tNW}`); }
  // 5. null calibration: iid zero-drift panels -> |t|>=2 rate <= 0.15, mean t near 0
  { let rej = 0; const ts = []; for (let r = 0; r < 100; r++) { const rng = mulberry(1000 + r), P = synthPanel(16, dates.filter((d) => d <= DISC[1]), () => ({ gap: 0.002 * gauss(rng), intra: 0.01 * gauss(rng) })), t = nwT(run(P, "2017-01", "2021-12").map((x) => x.gross)); ts.push(t); if (Math.abs(t) >= 2) rej++; }
    ok("iid null: |t|>=2 rate <= 0.15 and |mean t| < 0.4", rej / 100 <= 0.15 && Math.abs(mean(ts)) < 0.4, `rate ${rej / 100}, mean t ${mean(ts).toFixed(3)}`); }
  // 6. bootstrap null on a trending synthetic panel removes the planted edge (the null machine itself works)
  { const rng = mulberry(12), S = 16, reg = Array.from({ length: S }, () => (rng() < 0.5 ? 1 : -1));
    const P = truncate(synthPanel(S, dates, (i, k) => { if (i === 0 && k > 0) for (let j = 0; j < S; j++) if (rng() < 1 / 500) reg[j] = -reg[j]; return { gap: 0.001 * gauss(rng), intra: 0.0008 * reg[i] + 0.01 * gauss(rng) }; }), DISC[1]);
    const t = nwT(run(bootstrapPanel(P, 5), "2017-01", "2021-12").map((x) => x.gross)); ok("bootstrap of a trending panel: |gross t| < 2", Math.abs(t) < 2, `t ${r3(t)}`); }
  // 7. positive control machinery: peeking at the outcome gives t >= 5
  { const rng = mulberry(13), P = synthPanel(16, dates.filter((d) => d <= DISC[1]), () => ({ gap: 0.002 * gauss(rng), intra: 0.01 * gauss(rng) })), t = nwT(run(P, "2017-01", "2021-12", true).map((x) => x.gross));
    ok("positive control (peek) t >= 5", t >= 5, `t ${r3(t)}`); }
  // 8. F1: verdict reads UNROUNDED values — raw t 1.6995 displays as 1.7 but must FAIL a 1.70 bar; tiny positive halves still count
  { const base = { netMean: 0.004, tNW: 1.70, firstHalfNetMean: 0.003, secondHalfNetMean: 0.005 };
    ok("F1: raw t 1.6995 FAILS a 1.70 bar (display would read 1.7)", holdoutVerdict({ ...base, tNW: 1.6995 }, 1.70) === "DID NOT PASS" && r3(1.6995) >= 1.699, `display ${r3(1.6995)}`);
    ok("F1: raw t exactly 1.70 PASSES; t null FAILS", holdoutVerdict(base, 1.70) === "PASS" && holdoutVerdict({ ...base, tNW: null }, 1.70) === "DID NOT PASS");
    ok("F1: half mean +1e-9 (displays 0) still counts as > 0; -1e-9 (displays -0/0) fails", holdoutVerdict({ ...base, firstHalfNetMean: 1e-9 }, 1.70) === "PASS" && holdoutVerdict({ ...base, secondHalfNetMean: -1e-9 }, 1.70) === "DID NOT PASS" && r3(100 * 1e-9) === 0);
    const rng = mulberry(21), P = synthPanel(4, dates.filter((d) => d <= DISC[1]), () => ({ gap: 0.002 * gauss(rng), intra: 0.01 * gauss(rng) })), s = run(P, "2017-01", "2021-12"), sm = summarize(s), raw = rawStats(s);
    ok("F1: summarize carries the raw values it rounds (raw.tNW === nwT(net))", sm.raw.tNW === nwT(s.map((x) => x.net)) && sm.raw.netMean === raw.netMean && sm.tNW === r3(raw.tNW)); }
  // 9. E1: an ETF whose FUTURE prices are missing (delisted mid-hold) is still a 1/N member for that month, held at its last price
  { const rng = mulberry(31), P = synthPanel(3, dates.filter((d) => d <= DISC[1]), () => ({ gap: 0.002 * gauss(rng), intra: 0.01 * gauss(rng) })), me = monthEnds(P.dates);
    const mi = me.findIndex((t) => P.dates[t + 1].slice(0, 7) === "2019-06"), t = me[mi], k = t + 5;   // last price 4 sessions into the hold
    const Q = { ...P, O: P.O.map((a, i) => (i === 0 ? a.map((v, j) => (j > k ? NaN : v)) : a.slice())), C: P.C.map((a, i) => (i === 0 ? a.map((v, j) => (j > k ? NaN : v)) : a.slice())) };
    const sP = run(P, "2017-01", "2021-12"), sQ = run(Q, "2017-01", "2021-12"), rowP = sP.find((x) => x.ym === "2019-06"), rowQ = sQ.find((x) => x.ym === "2019-06");
    const info = {}, r0 = holdReturn(Q, 0, t, me[mi + 1], info), exp0 = Q.C[0][k] / Q.O[0][t + 1] - 1;
    ok("E1: delisted-mid-hold ETF return = last close / entry open - 1 (not NaN)", Math.abs(r0 - exp0) < 1e-15 && info.exitSrc === "lastAvailableClose", `${info.entrySrc}->${info.exitSrc}`);
    ok("E1: 1/N membership unchanged by the missing future (n 3 in both panels)", rowP.n === 3 && rowQ.n === 3 && rowQ.nFallback === 1 && rowP.nFallback === 0);
    const W = weightsAt(Q, me, mi); let gB = 0; for (const i of W.keys()) gB += (W.get(i).scale / 3) * holdReturn(Q, i, t, me[mi + 1]);
    ok("E1: benchmark gross = sum over ALL formation members of (scale/N) * held return", Math.abs(rowQ.grossBM - gB) < 1e-15);
    ok("E1: the next formation (no close at t) drops the ETF from data known at formation", sQ.find((x) => x.ym === "2019-07").n === 2);
    const info2 = {}, r2 = holdReturn(Q, 0, me[mi + 1], me[mi + 2], info2);
    ok("E1: a non-member (no close at its formation t) is excluded by weightsAt; holdReturn refuses it (NaN)", Number.isNaN(r2) && info2.entrySrc === "none" && !weightsAt(Q, me, mi + 1).has(0));
    const R = { ...P, O: P.O.map((a, i) => (i === 0 ? a.map((v, j) => (j > t ? NaN : v)) : a.slice())), C: P.C.map((a, i) => (i === 0 ? a.map((v, j) => (j > t ? NaN : v)) : a.slice())) }, info3 = {};
    ok("E1: no price after formation t -> entry at close(t), held flat (return 0), still a member", holdReturn(R, 0, t, me[mi + 1], info3) === 0 && info3.entrySrc === "formationClose" && info3.exitSrc === "heldAtEntry" && run(R, "2019-06", "2019-06")[0].n === 3); }
  // 10. F2: require() of the script runs no mode (child process: no output, exit 0) and exposes the machinery
  { const cp = require("child_process").spawnSync(process.execPath, ["-e", `const m=require(${JSON.stringify(__filename)});if(typeof m.run!=="function"||typeof m.holdoutVerdict!=="function")process.exit(3)`], { encoding: "utf8" });
    ok("F2: require() runs nothing (no stdout, exit 0) and exports run/holdoutVerdict", cp.status === 0 && !cp.stdout && !cp.stderr, `exit ${cp.status}${cp.stdout ? " stdout " + JSON.stringify(cp.stdout.slice(0, 80)) : ""}`); }
  const pass = checks.every((c) => c.pass); console.log(`${KEY} SELFTEST ${pass ? "PASS" : "FAIL"} (${checks.filter((c) => c.pass).length}/${checks.length})`); return pass;
}

module.exports = { KEY, run, weightsAt, holdReturn, rawStats, summarize, holdoutVerdict, nwT, monthEnds, truncate, bootstrapPanel, selftest };

// ── main ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// house rule: never require a runner — a mode runs ONLY when this file is the entry point (fixes2026_09_23 F2)
if (require.main === module) (async () => {
  const mode = ["--selftest", "--build", "--controls", "--discovery", "--holdout", "--status"].find((m) => process.argv.includes(m)) || "--status";
  if (mode === "--selftest") { process.exit(selftest() ? 0 : 1); }
  if (mode === "--status") { console.log(`${KEY}: cache ${fs.existsSync(CACHE) ? "built" : "pending"} · controls ${fs.existsSync(CTRL) ? "done" : "pending"} · registered ${registered() ? "yes" : "no"} · discovery ${fs.existsSync(OUTD) ? "sealed" : "pending"} · holdout ${fs.existsSync(OUTH) ? "READ" : "sealed/unopened"}`); return; }
  fs.mkdirSync(HD, { recursive: true });
  if (mode === "--build") { await build(); return; }
  if (mode === "--controls") {
    if (!fs.existsSync(CACHE)) await build();
    const P = truncate(loadPanel(), DISC[1]), from = ymOf(DISC[0]), to = ymOf(DISC[1]);   // holdout prices never enter the controls
    const tSeed = nwT(run(bootstrapPanel(P, NULL_SEED), from, to).map((x) => x.gross));
    let rej = 0; for (let r = 1; r <= NULL_REPS; r++) { const t = nwT(run(bootstrapPanel(P, NULL_SEED + r), from, to).map((x) => x.gross)); if (t != null && Math.abs(t) >= 2) rej++; }
    const leakOk = tSeed != null && rej / NULL_REPS <= NULL_RATE_MAX;   // AMENDED 2026-09-24 (pre-discovery, R169): judged on the 200-panel rejection rate; the single designated seed (t -2.064 in v1) is recorded, not gating — a one-seed |t|<2 rule fails ~5% of the time on a perfect null
    const peekT = nwT(run(P, from, to, true).map((x) => x.gross)), peekOk = peekT != null && peekT >= 5;
    writeJsonAtomic(CTRL, { spec: `${KEY}-controls-v1`, asOf: new Date().toISOString(), window: DISC, leakBootstrapGrossT: r3(tSeed), nullRejectRate: rej / NULL_REPS, nullReps: NULL_REPS, nullRateMax: NULL_RATE_MAX, leakOk, peekGrossT: r3(peekT), peekOk, pass: leakOk && peekOk });
    console.log(`${KEY} controls — bootstrap null gross t ${r3(tSeed)} (|t|>=2 rate ${rej / NULL_REPS} over ${NULL_REPS}) ${leakOk ? "PASS" : "FAIL"} · positive control t ${r3(peekT)} ${peekOk ? "PASS" : "FAIL"}`);
    if (!(leakOk && peekOk)) process.exit(1); return;
  }
  if (mode === "--discovery") {
    if (fs.existsSync(OUTD)) { console.error("discovery already sealed — refusing"); process.exit(2); }
    const ctrl = fs.existsSync(CTRL) ? JSON.parse(fs.readFileSync(CTRL, "utf8")) : null; if (!ctrl || !ctrl.pass) { console.error("controls have not passed — refusing"); process.exit(2); }
    const reg = registered(); if (!reg) { console.error(`no preregistered entry with script === "${SCRIPT_REL}" — refusing`); process.exit(2); }
    const spec = JSON.parse(fs.readFileSync(SPEC, "utf8"));
    const P = truncate(loadPanel(), DISC[1]), s = run(P, ymOf(DISC[0]), ymOf(DISC[1])), sm = summarize(s);
    writeJsonAtomic(OUTD, { spec: `${KEY}-discovery-v1`, sealedAt: new Date().toISOString(), registryId: reg.id || null, window: DISC, barTRequired: spec.barTRequired, result: sm, series: s.map((x) => ({ ym: x.ym, net: r5(x.net), gross: r5(x.gross) })) });
    console.log(`${KEY} DISCOVERY ${DISC.join("..")} (sealed) — net ${sm.netPctPerMonth}%/mo (gross ${sm.grossPctPerMonth}) · NW t ${sm.tNW} (gross t ${sm.tGrossNW}) · halves ${sm.firstHalfNetPct}/${sm.secondHalfNetPct} · ${sm.months} months · legs TSMOM ${sm.context.tsmomNetPctPerMonth} / bench ${sm.context.benchNetPctPerMonth}`);
    return;
  }
  if (mode === "--holdout") {
    if (fs.existsSync(OUTH)) { console.error("holdout already read — refusing"); process.exit(2); }
    if (!fs.existsSync(OUTD)) { console.error("discovery not sealed — refusing"); process.exit(2); }
    const reg = registered(); if (!reg) { console.error(`no preregistered entry with script === "${SCRIPT_REL}" — refusing`); process.exit(2); }
    const disc = JSON.parse(fs.readFileSync(OUTD, "utf8")), spec = JSON.parse(fs.readFileSync(SPEC, "utf8")), bar = spec.barTRequired;
    if (!(bar > 0) || bar !== disc.barTRequired) { console.error(`bar mismatch (spec ${bar}, discovery ${disc.barTRequired}) — refusing`); process.exit(2); }
    const P = truncate(loadPanel(), HOLD[1]), s = run(P, ymOf(HOLD[0]), ymOf(HOLD[1])), sm = summarize(s);
    const verdict = holdoutVerdict(sm.raw, bar);   // UNROUNDED values only (F1); the rounded fields are display
    writeJsonAtomic(OUTH, { spec: `${KEY}-holdout-v1`, read: true, asOf: new Date().toISOString(), registryId: reg.id || null, window: HOLD, bar, result: sm, verdict, series: s.map((x) => ({ ym: x.ym, net: r5(x.net), gross: r5(x.gross) })) });
    console.log(`${KEY} HOLDOUT ${HOLD.join("..")} — ${verdict} (bar t >= ${bar}) · net ${sm.netPctPerMonth}%/mo (gross ${sm.grossPctPerMonth}) · NW t ${sm.tNW} · halves ${sm.firstHalfNetPct}/${sm.secondHalfNetPct} · ${sm.months} months`);
  }
})().catch((e) => { console.error(`${KEY} FAILED:`, e.message); process.exit(1); });
