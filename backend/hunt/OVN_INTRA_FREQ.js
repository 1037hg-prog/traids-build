#!/usr/bin/env node
"use strict";
/**
 * OVN_INTRA_FREQ — OVERNIGHT-UP / INTRADAY-DOWN FREQUENCY ("daily tug of war"), replicated with a sealed holdout. Paper only.
 *
 * SOURCE. Akbas, Boehmer, Jiang & Koch (2022), "Overnight returns, daytime reversals, and future stock returns",
 * Journal of Financial Economics 145(3), 850-875, doi:10.1016/j.jfineco.2021.09.019. Abstract (verified 2026-09-23 via web search):
 * a higher monthly frequency of positive overnight returns followed by negative trading-day reversals (a more intense tug of war
 * between overnight noise traders and daytime arbitrageurs) predicts HIGHER future returns in the cross section. => SIGN = +1
 * (long the HIGH-frequency quintile, short the LOW-frequency quintile).
 *
 * HYPOTHESIS. In the survivorship-reduced US common-stock panel (data/anomaly-cache-v2), the equal-weight quintile long-short on the
 * month-t frequency of {overnight > 0 AND intraday < 0} days earns a positive NET return in month t+1.
 *
 * EXACT MECHANICAL RULE (one variant, frozen before any evidence):
 *   Data: data/anomaly-cache-v2 — Alpaca SIP daily bars, adjustment=all, dense Float32 [symbol][day] close/open/vol, incl. delisted
 *     names; v2 TRUNCATES a name at its first +300% one-day jump (meta.info[i].truncatedBefore) instead of dropping it (point-in-time).
 *   Formation at each month-end t (last trading day of calendar month m; only data up to and including t's close is used):
 *     eligibility (split-invariant; NO price floor — adjustment=all price levels depend on later splits, so a $5 screen is look-ahead):
 *       close_t > 0; >= 252 closes in the last 260 trading days; >= 40 valid days of dollar volume in the last 60; 60-day MEDIAN
 *       dollar volume (close x volume, both adjusted, so the product is split-invariant) >= $5,000,000; then the top 1,500 by 60-day
 *       mean dollar volume.
 *     signal: for every trading day k of month m (k in (t_prev, t]) with close_{k-1} > 0, open_k > 0, close_k > 0:
 *       overnight_k = open_k / close_{k-1} - 1, intraday_k = close_k / open_k - 1; a HIT is overnight_k > 0 AND intraday_k < 0.
 *       FREQ = hits / valid days; requires >= 15 valid days in the month, else the stock is dropped that month.
 *     sort ascending by FREQ (ties broken by a fixed per-symbol hash, never by size or return); q = floor(n/5);
 *     LONG = top q (highest FREQ), SHORT = bottom q (lowest FREQ); requires n >= 100.
 *   Holding: equal weight, close t -> close of the next month-end t1; a stock that stops trading is held at its last close (the
 *     delisting loss counts). Monthly spread = mean(LONG) - mean(SHORT).
 * COST MODEL (identical to R161): 0.25% x (long-leg turnover + short-leg turnover) per month; turnover = share of names new to a leg;
 *   the first month of each window pays a full build (turnover 2). No borrow cost modelled.
 * STATISTIC: Newey-West t (lag 3) of the monthly NET spread series; also reported: mean net and gross %/month, gross NW t, both-halves
 *   means (series split at floor(n/2)), mean turnover, names per leg.
 * WINDOWS: DISCOVERY holding months 2017-01..2021-12 (60). HOLDOUT holding months 2022-01..2026-09 (last cache day 2026-09-22; the
 *   final month is partial). The holdout is computed ONLY by --holdout, ONCE; run() throws on any window reaching 2022-01 unless the
 *   holdout mode passes allowHoldout.
 * PROTOCOL: --selftest (synthetic known answers) -> --controls (panel TRUNCATED at 2021-12-31, so the iid-bootstrap null draws its
 *   (overnight, intraday) day-pairs and estimates its drift from days <= 2021-12-31 ONLY; every stock's day-pairs drawn WITH
 *   replacement, arithmetic drift removed, open/close paths rebuilt; discovery-window GROSS |NW t| < 2 required; positive
 *   control that peeks at next month's return as the signal must give GROSS t >= 5) -> registration in backend/data/test-registry.json
 *   (preregistered entry with script "backend/hunt/OVN_INTRA_FREQ.js") -> --discovery (sealed once, descriptive; the rule is frozen, no
 *   carry-forward screen) -> --holdout (sealed once).
 * HOLDOUT PASS (must match the spec): net mean > 0 AND NW t >= 1.70 (single variant) AND both holdout halves' net means > 0.
 *
 *   (--discovery also loads the panel truncated at 2021-12-31.)
 * FIXES 2026-09-23: every PASS/bar comparison reads UNROUNDED values (summary.raw; rounding is display only); main runs only when
 *   executed directly (require() never runs a mode); v2 panel; split-invariant median-dollar-volume screen replaces the $5 floor;
 *   bootstrap null pool and drift restricted to data <= 2021-12-31 for the discovery-window controls.
 *
 *   node backend/hunt/OVN_INTRA_FREQ.js --selftest | --controls | --discovery | --holdout | --status
 */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("../lib/atomic-write.js");
const KEY = "OVN_INTRA_FREQ", SCRIPT = "backend/hunt/OVN_INTRA_FREQ.js";
const DATA = path.join(__dirname, "..", "data"), DIR = path.join(DATA, "anomaly-cache-v2"), HD = path.join(DATA, "hunt");
const F = (s) => path.join(HD, `${KEY}-${s}.json`), CTRL = F("controls"), OUTD = F("discovery"), OUTH = F("holdout");
const COST = 0.0025, TOPN = 1500, MIN_MED_DV = 5e6, MIN_DAYS = 15, MIN_XS = 100, SIGN = +1, BAR = 1.70, NW_LAG = 3;
const DISC = ["2017-01", "2021-12"], HOLD = ["2022-01", "2026-09"], DISC_END_DATE = "2021-12-31";

// Keep only dates <= maxDate: the later days are physically absent, so nothing built on the result (incl. the bootstrap null's
// draw pool and drift) can read them.
function truncatePanel(P, maxDate) {
  const T = P.meta.dates.filter((d) => d <= maxDate).length; if (T === P.T) return P;
  const cut = (A) => { const out = new Float32Array(P.N * T); for (let s = 0; s < P.N; s++) out.set(A.subarray(s * P.T, s * P.T + T), s * T); return out; };
  return { ...P, meta: { ...P.meta, dates: P.meta.dates.slice(0, T) }, T, C: cut(P.C), O: cut(P.O), V: cut(P.V) };
}
function loadPanel(maxDate) {
  const meta = JSON.parse(fs.readFileSync(path.join(DIR, "meta.json"), "utf8")), T = meta.dates.length, N = meta.symbols.length;
  const rd = (f) => { const b = fs.readFileSync(path.join(DIR, f)); if (b.length !== 4 * N * T) throw new Error(`${f}: ${b.length} bytes, expected ${4 * N * T}`); return new Float32Array(b.buffer, b.byteOffset, N * T); };
  const P = { meta, T, N, C: rd("close.f32"), O: rd("open.f32"), V: rd("vol.f32") };
  return maxDate ? truncatePanel(P, maxDate) : P;
}
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const median = (a) => { const b = Float64Array.from(a).sort(), n = b.length; return n ? (n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2) : NaN; };
function nwT(a, L = NW_LAG) { const n = a.length; if (n < 6) return null; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n; for (let k = 1; k <= L; k++) { let c = 0; for (let i = k; i < n; i++) c += d[i] * d[i - k]; v += 2 * (1 - k / (L + 1)) * c / n; } return v > 0 ? m / Math.sqrt(v / n) : null; }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const tieKey = (s) => { let h = Math.imul((s + 1) ^ 0x9E3779B9, 0x85EBCA6B) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xC2B2AE35) >>> 0; return (h ^ (h >>> 16)) >>> 0; };
const monthEnds = (dates) => { const e = []; for (let t = 0; t < dates.length; t++) if (t === dates.length - 1 || dates[t + 1].slice(0, 7) !== dates[t].slice(0, 7)) e.push(t); return e; };

// Dollar volume from the real panel (eligibility). With a seed: iid BOOTSTRAP null — each stock's (overnight, intraday) day-pairs are
// drawn WITH replacement (a permutation would fix each stock's total and force past/future dependence; see R161 controls v1/v2), the
// arithmetic drift is removed (mean close-to-close gross = 1), and the open/close path is rebuilt from the draws. A day with a close but
// no valid pair (after a gap) carries the path flat — it never falls back to the real price.
function prepare(P, seed = 0) {
  const { T, N, C, O, V } = P, DV = new Float32Array(N * T).fill(NaN);
  for (let s = 0; s < N; s++) { const o = s * T; for (let t = 0; t < T; t++) { const b = C[o + t]; if (b > 0 && V[o + t] >= 0) DV[o + t] = b * V[o + t]; } }
  if (!seed) return { ...P, DV, Cx: C, Ox: O };
  const rng = mulberry(seed), Cx = new Float32Array(C), Ox = new Float32Array(O), valid = new Uint8Array(T);
  for (let s = 0; s < N; s++) {
    const o = s * T, idx = [], on = [], id = [];
    for (let t = 1; t < T; t++) { const a = C[o + t - 1], op = O[o + t], b = C[o + t]; if (a > 0 && op > 0 && b > 0) { idx.push(t); on.push(op / a - 1); id.push(b / op - 1); } }
    if (idx.length < 20) continue;
    let mu = 0; for (let i = 0; i < idx.length; i++) mu += (1 + on[i]) * (1 + id[i]); mu /= idx.length;
    const onA = on.map((x) => (1 + x) / mu - 1), n = idx.length;
    valid.fill(0); for (const t of idx) valid[t] = 1;
    const first = idx[0] - 1; let px = C[o + first];
    for (let t = first + 1; t < T; t++) {
      if (!(C[o + t] > 0)) continue;
      if (valid[t]) { const j = Math.floor(rng() * n), op = px * (1 + onA[j]); px = op * (1 + id[j]); Ox[o + t] = op; Cx[o + t] = px; }
      else { Ox[o + t] = px; Cx[o + t] = px; }
    }
  }
  return { ...P, DV, Cx, Ox };
}

// Eligible universe and FREQ signal at formation month-end t (month = trading days in (tPrev, t]); nothing after t's close is read.
function signalsAt(Q, t, tPrev) {
  const { T, N, DV, Cx, Ox } = Q, out = [];
  for (let s = 0; s < N; s++) {
    const o = s * T, px = Cx[o + t]; if (!(px > 0)) continue;     // no price floor: adjusted price levels are not point-in-time
    let hist = 0; for (let k = t; k >= 0 && k > t - 260; k--) if (Cx[o + k] > 0) hist++; if (hist < 252) continue;
    const dvs = []; for (let k = Math.max(0, t - 59); k <= t; k++) { const x = DV[o + k]; if (x >= 0) dvs.push(x); } if (dvs.length < 40) continue;
    if (!(median(dvs) >= MIN_MED_DV)) continue;                 // split-invariant liquidity screen (adjusted close x adjusted volume)
    const dv = dvs.reduce((a, x) => a + x, 0), nd = dvs.length;
    let hits = 0, days = 0;
    for (let k = tPrev + 1; k <= t; k++) { const a = Cx[o + k - 1], op = Ox[o + k], b = Cx[o + k]; if (a > 0 && op > 0 && b > 0) { days++; if (op > a && b < op) hits++; } }
    out.push({ s, dv: dv / nd, v: days >= MIN_DAYS ? hits / days : NaN, days, hits });
  }
  out.sort((a, b) => b.dv - a.dv); return out.slice(0, TOPN);
}
function holdReturn(Q, s, t0, t1) { const { T, Cx } = Q, o = s * T, a = Cx[o + t0]; if (!(a > 0)) return NaN; let last = a; for (let k = t0 + 1; k <= t1; k++) { const x = Cx[o + k]; if (x > 0) last = x; } return last / a - 1; }

function run(Q, fromYm, toYm, { peek = false, allowHoldout = false } = {}) {
  if (!allowHoldout && (toYm >= HOLD[0] || fromYm >= HOLD[0])) throw new Error(`holdout months (${HOLD[0]}+) are reachable only from --holdout`);
  const dates = Q.meta.dates, me = monthEnds(dates), a = []; let prev = null;
  for (let mi = 1; mi < me.length - 1; mi++) {
    const t = me[mi], t1 = me[mi + 1], ym = dates[t1].slice(0, 7); if (ym < fromYm || ym > toYm) continue;
    const U = signalsAt(Q, t, me[mi - 1]), fwd = new Map(U.map((u) => [u.s, holdReturn(Q, u.s, t, t1)]));
    const xs = U.map((u) => ({ s: u.s, v: peek ? fwd.get(u.s) : u.v })).filter((x) => Number.isFinite(x.v) && Number.isFinite(fwd.get(x.s)));
    if (xs.length < MIN_XS) continue;
    xs.sort((p, q) => p.v - q.v || tieKey(p.s) - tieKey(q.s));
    const q = Math.floor(xs.length / 5), lo = xs.slice(0, q), hi = xs.slice(xs.length - q), L = SIGN > 0 ? hi : lo, S = SIGN > 0 ? lo : hi;
    const avg = (g) => mean(g.map((x) => fwd.get(x.s))), gL = avg(L), gS = avg(S), gross = gL - gS;
    const turn = prev ? (L.filter((x) => !prev.L.has(x.s)).length / L.length + S.filter((x) => !prev.S.has(x.s)).length / S.length) : 2;
    prev = { L: new Set(L.map((x) => x.s)), S: new Set(S.map((x) => x.s)) };
    a.push({ ym, gross, net: gross - COST * turn, turn, perLeg: q, longPct: gL, shortPct: gS });
    if (process.stdout.isTTY) process.stdout.write(`  ${KEY} ${ym}\r`);
  }
  if (process.stdout.isTTY) process.stdout.write("\n");
  return summarize(a);
}
function summarize(a) {
  const r = (x, d = 3) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(d)), net = a.map((x) => x.net), g = a.map((x) => x.gross), h = Math.floor(a.length / 2);
  const pct = (xs) => (xs.length ? r(100 * mean(xs)) : null), m = (xs) => (xs.length ? mean(xs) : null);
  // raw = UNROUNDED values (fractions, not %); every PASS/bar comparison reads these. The rounded fields are display only.
  const raw = { net: m(net), tNW: nwT(net), gross: m(g), tGrossNW: nwT(g), firstHalfNet: m(net.slice(0, h)), secondHalfNet: m(net.slice(h)) };
  return { months: a.length, netPctPerMonth: pct(net), tNW: r(nwT(net)), grossPctPerMonth: pct(g), tGrossNW: r(nwT(g)),
    firstHalfNetPct: pct(net.slice(0, h)), secondHalfNetPct: pct(net.slice(h)), firstHalfGrossPct: pct(g.slice(0, h)), secondHalfGrossPct: pct(g.slice(h)),
    meanTurnover: a.length ? r(mean(a.map((x) => x.turn)), 2) : null, meanNamesPerLeg: a.length ? r(mean(a.map((x) => x.perLeg)), 1) : null,
    raw, series: a.map((x) => ({ ym: x.ym, gross: r(x.gross, 5), net: r(x.net, 5), turn: r(x.turn, 3), perLeg: x.perLeg })) };
}
const fin = (x) => x != null && Number.isFinite(x);
// Bar decisions on UNROUNDED values only (a raw t of 1.6995 fails the 1.70 bar even though it displays as 1.70).
const holdoutClears = (raw) => fin(raw.net) && raw.net > 0 && fin(raw.tNW) && raw.tNW >= BAR && fin(raw.firstHalfNet) && raw.firstHalfNet > 0 && fin(raw.secondHalfNet) && raw.secondHalfNet > 0;
const leakPasses = (raw) => fin(raw.tGrossNW) && Math.abs(raw.tGrossNW) < 2;
const peekPasses = (raw) => fin(raw.tGrossNW) && raw.tGrossNW >= 5;
function registered() {
  const reg = JSON.parse(fs.readFileSync(path.join(DATA, "test-registry.json"), "utf8"));
  return (reg.preregistered || []).find((x) => x && x.script === SCRIPT) || null;
}
const readJ = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null);

// ---------------------------------------------------------------- SELFTEST (synthetic only; never touches the real panel)
function synthPanel(seed, k, N = 600) {
  const dates = []; for (let d = Date.UTC(2016, 0, 4); d <= Date.UTC(2019, 11, 31); d += 864e5) { const w = new Date(d).getUTCDay(); if (w > 0 && w < 6) dates.push(new Date(d).toISOString().slice(0, 10)); }
  const T = dates.length, C = new Float32Array(N * T), O = new Float32Array(N * T), V = new Float32Array(N * T).fill(1e6);
  const rng = mulberry(seed), gauss = () => Math.sqrt(-2 * Math.log(Math.max(rng(), 1e-12))) * Math.cos(2 * Math.PI * rng());
  for (let s = 0; s < N; s++) {
    const o = s * T; let px = 50, drift = 0, hits = 0, nd = 0; C[o] = O[o] = px;
    for (let t = 1; t < T; t++) {
      if (dates[t].slice(0, 7) !== dates[t - 1].slice(0, 7)) { drift = k * ((nd ? hits / nd : 0.25) - 0.25); hits = 0; nd = 0; }   // planted: month m+1 drift from month m FREQ
      const on = 0.008 * gauss(), id = 0.012 * gauss() + drift, op = px * (1 + on); px = op * (1 + id); O[o + t] = op; C[o + t] = px; nd++; if (on > 0 && id < 0) hits++;
    }
  }
  return { meta: { dates, symbols: Array.from({ length: N }, (_, i) => "S" + i), info: [] }, T, N, C, O, V };
}
function selftest() {
  const W = ["2017-01", "2019-12"], res = []; const check = (name, ok, detail) => { res.push({ name, ok }); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`); };
  // A. signal known answer: stock 0, June 2017 — 7 hits, 3 up/up, 3 down/down, rest down/up, one missing close (drops that day and the next)
  { const P = synthPanel(11, 0), { T, meta } = P, me = monthEnds(meta.dates), mi = me.findIndex((t) => meta.dates[t].startsWith("2017-06")), t = me[mi], tPrev = me[mi - 1], o = 0;
    let j = 0; for (let kk = tPrev + 1; kk <= t; kk++, j++) { const prevC = P.C[o + kk - 1] > 0 ? P.C[o + kk - 1] : P.C[o + kk - 2]; const [f1, f2] = j < 7 ? [1.02, 0.98] : j < 10 ? [1.02, 1.02] : j < 13 ? [0.98, 0.98] : [0.98, 1.02]; P.O[o + kk] = prevC * f1; P.C[o + kk] = P.O[o + kk] * f2; if (j === 15) P.C[o + kk] = 0; }
    const D = t - tPrev, u = signalsAt(prepare(P), t, tPrev).find((x) => x.s === 0);
    check("A signal known answer", !!u && u.hits === 7 && u.days === D - 2 && Math.abs(u.v - 7 / (D - 2)) < 1e-12, `hits ${u && u.hits}/${u && u.days} (expected 7/${D - 2})`); }
  // B. no look-ahead: scrambling every price after t leaves the formation (universe, FREQ, dollar volume) unchanged
  { const P = synthPanel(12, 0.004), me = monthEnds(P.meta.dates), mi = me.findIndex((t) => P.meta.dates[t].startsWith("2018-03")), t = me[mi], tPrev = me[mi - 1];
    const a = JSON.stringify(signalsAt(prepare(P), t, tPrev)), P2 = { ...P, C: new Float32Array(P.C), O: new Float32Array(P.O) }, rng = mulberry(5);
    for (let s = 0; s < P.N; s++) for (let k = t + 1; k < P.T; k++) { const z = rng() < 0.05 ? 0 : 5 + 100 * rng(); P2.C[s * P.T + k] = z; P2.O[s * P.T + k] = z * (0.9 + 0.2 * rng()); }
    check("B formation uses nothing after t", a === JSON.stringify(signalsAt(prepare(P2), t, tPrev)), "signalsAt identical after scrambling the future"); }
  // C/D. planted effect recovered with the right sign; E. no effect -> no signal
  const Rp = run(prepare(synthPanel(21, 0.004)), W[0], W[1]); check("C planted +effect found (long high FREQ)", Rp.raw.tGrossNW >= 5 && Rp.raw.gross > 0, `gross ${Rp.grossPctPerMonth}%/mo t ${Rp.tGrossNW}, ${Rp.months} months`);
  const Rn = run(prepare(synthPanel(22, -0.004)), W[0], W[1]); check("D planted -effect gives negative t", Rn.raw.tGrossNW <= -5, `gross ${Rn.grossPctPerMonth}%/mo t ${Rn.tGrossNW}`);
  // E is a calibration check over 20 no-effect panels (a single draw is a coin with a ~5% tail): mean t near 0, |t|>=2 rare, net < gross
  { const ts = [], nets = []; for (let sd = 300; sd < 320; sd++) { const R0 = run(prepare(synthPanel(sd, 0)), W[0], W[1]); ts.push(R0.raw.tGrossNW); nets.push(R0.raw.net < R0.raw.gross); }
    const mt = mean(ts), fr = ts.filter((x) => Math.abs(x) >= 2).length / ts.length;
    check("E null panels calibrated (20 seeds)", Math.abs(mt) < 0.6 && fr <= 0.2 && nets.every(Boolean), `mean gross t ${mt.toFixed(3)}, share |t|>=2 ${fr.toFixed(2)}, net<gross in all`); }
  // F. the iid bootstrap null destroys a planted effect (the --controls leak test's mechanism)
  const Rb = run(prepare(synthPanel(21, 0.004), 161), W[0], W[1]); check("F bootstrap kills planted effect", Math.abs(Rb.raw.tGrossNW) < 2.5, `gross t ${Rb.tGrossNW} (planted panel was ${Rp.tGrossNW})`);
  // G. positive control (peek at the outcome) must be enormous
  const Rk = run(prepare(synthPanel(23, 0)), W[0], W[1], { peek: true }); check("G peek positive control t >= 5", peekPasses(Rk.raw), `t ${Rk.tGrossNW}`);
  // H. holdout months unreachable without the holdout flag
  { let threw = false; try { run(prepare(synthPanel(24, 0, 120)), HOLD[0], HOLD[1]); } catch (e) { threw = /holdout/.test(e.message); } check("H holdout window locked", threw, "run() throws for 2022-01+ without allowHoldout"); }
  // I. delisting: a stock that stops trading mid-month is held at its last close
  { const P = synthPanel(25, 0, 120), me = monthEnds(P.meta.dates), t = me[20], t1 = me[21], d = t + 7, o = 3 * P.T; for (let k = d + 1; k < P.T; k++) { P.C[o + k] = 0; P.O[o + k] = 0; }
    const Q = prepare(P), got = holdReturn(Q, 3, t, t1), exp = P.C[o + d] / P.C[o + t] - 1; check("I delisted name held at last close", Math.abs(got - exp) < 1e-12, `${got.toFixed(6)} vs ${exp.toFixed(6)}`); }
  // J. cost arithmetic: net = gross - 0.25% x turnover, first month full build
  { const s0 = Rp.series[0], s1 = Rp.series[1]; check("J cost model", s0.turn === 2 && Math.abs(s0.net - (s0.gross - 0.005)) < 2e-5 && Math.abs(s1.net - (s1.gross - COST * s1.turn)) < 2e-5, `m1 turn ${s0.turn}, m2 turn ${s1.turn}`); }
  // K (fix F1). bar decisions read UNROUNDED values: t 1.6995 displays "1.700" but FAILS the 1.70 bar; a half of +4e-7 displays 0.000% but is > 0
  { const base = { net: 0.004, tNW: 2.1, firstHalfNet: 0.003, secondHalfNet: 0.005 }, rr = (x) => +x.toFixed(3);
    const cases = [
      [holdoutClears({ ...base, tNW: 1.6995 }) === false && rr(1.6995) === 1.7, "t 1.6995 (shows 1.700) fails"],
      [holdoutClears({ ...base, tNW: 1.69996 }) === false, "t 1.69996 fails"],
      [holdoutClears({ ...base, tNW: 1.70 }) === true, "t 1.70 clears"],
      [holdoutClears({ ...base, firstHalfNet: 4e-7 }) === true && rr(100 * 4e-7) === 0, "half +4e-7 (shows 0.000%) counts as > 0"],
      [holdoutClears({ ...base, net: -4e-7 }) === false, "net -4e-7 (shows -0.000%) fails"],
      [holdoutClears({ ...base, tNW: null }) === false, "null t fails closed"],
      [leakPasses({ tGrossNW: 1.9996 }) === true && leakPasses({ tGrossNW: -2.0 }) === false && leakPasses({ tGrossNW: null }) === false, "leak |t|<2 on raw"],
      [peekPasses({ tGrossNW: 4.9996 }) === false && peekPasses({ tGrossNW: 5 }) === true, "peek 4.9996 (shows 5.000) fails"]];
    const gs = [0.013, -0.004, 0.021, 0.002, -0.011, 0.017, 0.008, -0.002], S = summarize(gs.map((g, i) => ({ ym: `2017-0${i + 1}`, gross: g, net: g - 0.001, turn: 0.4, perLeg: 30 })));
    const rawOk = S.raw.tNW === nwT(gs.map((g) => g - 0.001)) && S.raw.tNW !== S.tNW;
    const bad = cases.filter((c) => !c[0]).map((c) => c[1]);
    check("K verdicts on unrounded values", !bad.length && rawOk, bad.length ? `failed: ${bad.join("; ")}` : `${cases.length} bar cases + summary.raw is the unrounded NW t (${S.raw.tNW} vs display ${S.tNW})`); }
  // L (fix P2). no price floor; split-invariant 60-day MEDIAN dollar-volume screen >= $5M, then top 1,500 by mean dollar volume
  { const P = synthPanel(31, 0, 150), { T, meta } = P, me = monthEnds(meta.dates), mi = me.findIndex((t) => meta.dates[t].startsWith("2017-06")), t = me[mi], tPrev = me[mi - 1];
    for (let s = 0; s < P.N; s++) for (let k = 0; k < T; k++) P.V[s * T + k] = 1e7 / P.C[s * T + k];              // every name: DV = $10M/day
    for (let k = 0; k < T; k++) { P.V[9 * T + k] = 4e6 / P.C[9 * T + k]; P.V[10 * T + k] = 6e6 / P.C[10 * T + k]; }
    P.V[9 * T + t - 5] = 1e12 / P.C[9 * T + t - 5];                                                            // one huge spike: mean >> $5M, median $4M
    const P2 = { ...P, C: new Float32Array(P.C), O: new Float32Array(P.O), V: new Float32Array(P.V) };
    for (let k = 0; k < T; k++) { const i = 7 * T + k; P2.C[i] = P.C[i] / 20; P2.O[i] = P.O[i] / 20; P2.V[i] = P.V[i] * 20; }  // a later 20:1 split rescales the adjusted history
    const U1 = signalsAt(prepare(P), t, tPrev), U2 = signalsAt(prepare(P2), t, tPrev), has = (U, s) => U.some((u) => u.s === s);
    const u1 = U1.find((u) => u.s === 7), u2 = U2.find((u) => u.s === 7), px7 = P2.C[7 * T + t];
    const ids = (U) => U.map((u) => u.s).sort((a, b) => a - b).join(",");   // membership (order among ~equal $10M names is float noise)
    const same = ids(U1) === ids(U2) && !!u1 && !!u2 && Math.abs(u2.dv / u1.dv - 1) < 1e-5 && u1.v === u2.v;
    const ok = same && px7 < 5 && has(U2, 7) && !has(U1, 9) && has(U1, 10);
    check("L split-invariant median-DV screen, no $5 floor", ok, `rescaled name at $${px7.toFixed(2)} kept with identical dv/FREQ: ${same && has(U2, 7)}; spike name (median $4M) excluded: ${!has(U1, 9)}; $6M name kept: ${has(U1, 10)}; universe ${U1.length}`); }
  // M (fix P3). the controls' bootstrap null sees no day after the cut: truncated layout is exact, and scrambling everything after the
  // cut leaves the bootstrap paths (draw pool + drift) bit-identical
  { const X = "2018-12-31", P = synthPanel(41, 0.004, 120), Pt = truncatePanel(P, X), Tt = Pt.T;
    const P2 = { ...P, C: new Float32Array(P.C), O: new Float32Array(P.O) }, rng = mulberry(9);
    for (let s = 0; s < P.N; s++) for (let k = Tt; k < P.T; k++) { const z = 1 + 500 * rng(); P2.C[s * P.T + k] = z; P2.O[s * P.T + k] = z * (0.5 + rng()); }
    let layout = Pt.meta.dates[Tt - 1] <= X && P.meta.dates[Tt] > X; for (let s = 0; s < P.N && layout; s++) for (let k = 0; k < Tt; k++) if (Pt.C[s * Tt + k] !== P.C[s * P.T + k] || Pt.V[s * Tt + k] !== P.V[s * P.T + k]) { layout = false; break; }
    const B1 = prepare(Pt, 1601), B2 = prepare(truncatePanel(P2, X), 1601), ident = B1.Cx.length === B2.Cx.length && B1.Cx.every((x, i) => x === B2.Cx[i]) && B1.Ox.every((x, i) => x === B2.Ox[i]);
    const Rt = run(B1, "2017-01", "2018-12");
    check("M bootstrap pool restricted to <= cut date", layout && ident && Rt.months > 0, `panel ends ${Pt.meta.dates[Tt - 1]}; layout exact ${layout}; bootstrap identical after scrambling post-cut data ${ident}; ${Rt.months} months computable`); }
  // N (fix F2). require() never runs a mode: a child that only require()s this file with --status in argv prints nothing
  { const cp = require("child_process").spawnSync(process.execPath, ["-e", `const m = require(${JSON.stringify(__filename)}); if (typeof m.run !== "function") process.exit(3);`, "--", "--status"], { encoding: "utf8", timeout: 60000 });
    check("N require() runs no mode", cp.status === 0 && !cp.stdout.trim() && !cp.stderr.trim(), `exit ${cp.status}, stdout ${JSON.stringify(cp.stdout.trim().slice(0, 80))}`); }
  const ok = res.every((x) => x.ok); console.log(`${KEY} SELFTEST ${ok ? "PASS" : "FAIL"} (${res.filter((x) => x.ok).length}/${res.length})`); return ok;
}

async function main() {
  const mode = ["--selftest", "--controls", "--discovery", "--holdout", "--status"].find((m) => process.argv.includes(m)) || "--status";
  if (mode === "--selftest") { process.exit(selftest() ? 0 : 1); }
  if (mode === "--status") { console.log(`${KEY}: registered ${registered() ? "yes" : "no"} · controls ${fs.existsSync(CTRL) ? (readJ(CTRL).pass ? "PASS" : "FAIL") : "pending"} · discovery ${fs.existsSync(OUTD) ? "sealed" : "pending"} · holdout ${fs.existsSync(OUTH) ? "READ" : "sealed/unopened"}`); return; }
  fs.mkdirSync(HD, { recursive: true });
  if (mode === "--controls") {   // the leak test reads GROSS spreads: on noise the net spread is negative by exactly its cost
    const P = loadPanel(DISC_END_DATE); console.log(`panel ${P.N} symbols x ${P.T} days (truncated at ${DISC_END_DATE}: bootstrap pool and drift from these days only)`);
    const scr = run(prepare(P, 1601), DISC[0], DISC[1]), pk = run(prepare(P), DISC[0], DISC[1], { peek: true });
    const leakOk = leakPasses(scr.raw), peekOk = peekPasses(pk.raw);
    writeJsonAtomic(CTRL, { spec: `${KEY}-controls-v2`, asOf: new Date().toISOString(), window: DISC, panel: "anomaly-cache-v2", panelThrough: P.meta.dates[P.T - 1], bootstrapSeed: 1601, bootstrapPoolThrough: DISC_END_DATE, leakBootstrapGrossT: scr.tGrossNW, leakBootstrapGrossTRaw: scr.raw.tGrossNW, leakBootstrapMonths: scr.months, leakOk, peekGrossT: pk.tGrossNW, peekGrossTRaw: pk.raw.tGrossNW, peekOk, pass: leakOk && peekOk });
    console.log(`${KEY} controls — iid-bootstrap null |gross t| < 2: ${leakOk ? "PASS" : "FAIL"} (t ${scr.tGrossNW}, ${scr.months} mo) · positive control t ${pk.tGrossNW} ${peekOk ? "PASS" : "FAIL"}`);
    return;
  }
  if (mode === "--discovery") {
    if (fs.existsSync(OUTD)) { console.error("discovery already sealed — refusing"); process.exit(2); }
    const ctrl = readJ(CTRL); if (!ctrl || !ctrl.pass || ctrl.spec !== `${KEY}-controls-v2`) { console.error("controls (v2) have not passed — refusing"); process.exit(2); }
    const reg = registered(); if (!reg) { console.error(`no preregistered entry with script "${SCRIPT}" in test-registry.json — refusing`); process.exit(2); }
    const P = loadPanel(DISC_END_DATE); console.log(`panel ${P.N} symbols x ${P.T} days (truncated at ${DISC_END_DATE})`);
    const r = run(prepare(P), DISC[0], DISC[1]);
    writeJsonAtomic(OUTD, { spec: `${KEY}-discovery-v2`, panel: "anomaly-cache-v2", sealedAt: new Date().toISOString(), registryId: reg.id || null, window: DISC, rule: "long top-FREQ quintile, short bottom-FREQ quintile, EW, 1 month", holdoutBar: BAR, result: r });
    console.log(`${KEY} DISCOVERY ${DISC.join("..")} (sealed) — net ${r.netPctPerMonth}%/mo · NW t ${r.tNW} · gross ${r.grossPctPerMonth}%/mo (t ${r.tGrossNW}) · halves ${r.firstHalfNetPct}/${r.secondHalfNetPct} · turnover ${r.meanTurnover} · ${r.months} months · ${r.meanNamesPerLeg} names/leg`);
    return;
  }
  if (mode === "--holdout") {
    if (fs.existsSync(OUTH)) { console.error("holdout already read — refusing"); process.exit(2); }
    const disc = readJ(OUTD); if (!disc) { console.error("discovery not sealed — refusing"); process.exit(2); }
    const ctrl = readJ(CTRL); if (!ctrl || !ctrl.pass || ctrl.spec !== `${KEY}-controls-v2`) { console.error("controls (v2) have not passed — refusing"); process.exit(2); }
    if (!registered()) { console.error("not registered — refusing"); process.exit(2); }
    const P = loadPanel(); console.log(`panel ${P.N} symbols x ${P.T} days`);
    const r = run(prepare(P), HOLD[0], HOLD[1], { allowHoldout: true });
    const clears = holdoutClears(r.raw);   // UNROUNDED values only
    const verdict = clears ? "PASS" : "DID NOT PASS";
    writeJsonAtomic(OUTH, { spec: `${KEY}-holdout-v2`, read: true, asOf: new Date().toISOString(), window: HOLD, panel: "anomaly-cache-v2", bar: BAR, passRule: "net mean > 0 AND NW t >= 1.70 AND both holdout halves net > 0 (all on unrounded values)", result: r, verdict });
    console.log(`${KEY} HOLDOUT ${HOLD.join("..")} — ${verdict} (bar t >= ${BAR}) · net ${r.netPctPerMonth}%/mo · NW t ${r.tNW} · gross ${r.grossPctPerMonth}%/mo · halves ${r.firstHalfNetPct}/${r.secondHalfNetPct} · ${r.months} months`);
  }
}
if (require.main === module) main().catch((e) => { console.error(`${KEY} FAILED:`, e.message); process.exit(1); });

module.exports = { prepare, signalsAt, run, synthPanel, holdReturn, monthEnds, nwT, summarize, truncatePanel, holdoutClears, leakPasses, peekPasses, median };
