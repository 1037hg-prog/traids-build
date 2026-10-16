#!/usr/bin/env node
/**
 * INTRADAY_MOM — INTRADAY-ONLY MOMENTUM, pre-registered with a sealed holdout (alpha hunt, 2026-09-23).
 *
 * HYPOTHESIS. Cross-sectional momentum lives in the intraday (open -> close) component of past returns, not the overnight one:
 * stocks whose cumulative INTRADAY return over months t-12..t-2 (skip the most recent month) was highest outperform those whose was
 * lowest over month t+1. Overnight-only momentum (close_{d-1} -> open_d) is computed beside it as the paper's control, REPORT ONLY.
 * SOURCE. Barardehi, Bogousslavsky & Muravyev, "What Drives Momentum and Reversal? Evidence from Day and Night Signals",
 * Review of Financial Studies (2026; SSRN working paper 2022). Background: Lou, Polk & Skouras, "A Tug of War: Overnight versus
 * Intraday Expected Returns", JFE 2019; Jegadeesh & Titman, JF 1993 (12-1 momentum).
 *
 * DATA. data/anomaly-cache-v2 (backend/anomaly-data-v2.js): every US common stock listed at any point 2016-2026 incl. delisted names,
 * Alpaca SIP daily adjusted (adjustment=all) open/close/volume, dense Float32 [symbol][day] matrices, 0 or NaN = no bar. v2 keeps a
 * name with a >+300% one-day jump up to the day BEFORE its first such jump (meta.info[i].truncatedBefore) instead of dropping it
 * from the whole panel (v1's drop used future knowledge to decide 2017 membership).
 *
 * EXACT MECHANICAL RULE (single variant, fixed before any computation):
 *   Formation at each month-end t (index me[mi]); only data up to and including that close is used.
 *   Universe (split-invariant liquidity screen, fixes 2026-09-23): >= 252 days with a close among the last 260 trading days,
 *   >= 40 days of dollar volume among the last 60, MEDIAN 60-day dollar volume (close x volume, both adjusted, so the product is
 *   invariant to later splits) >= $5,000,000, then top 1,500 by 60-day mean dollar volume. NO price floor: the panel is
 *   adjustment=all, so a price level at t depends on splits after t (a look-ahead); R161's close >= $5 floor is removed.
 *   Signal window: trading days d with me[mi-12] < d <= me[mi-1], i.e. months t-11..t-1 of R161's MOM12_1 (= the paper's months
 *   t-12..t-2 relative to the holding month t+1 ... the most recent formation month is skipped). Requires mi >= 12.
 *     INTRA  = prod_d (C_d / O_d) - 1                over days with O_d > 0 and C_d > 0
 *     OVER   = prod_d (O_d / C_{d-1}) - 1            over days with C_{d-1} > 0 and O_d > 0 (report only)
 *   Data hygiene (declared in advance): a daily factor outside [1/3, 3] is treated as a bad print and skipped; a stock needs >= 180
 *   valid daily factors in the window, else it has no signal that month.
 *   Portfolio: quintiles on the signal among universe names with a finite signal (>= 100 names needed); LONG the top quintile,
 *   SHORT the bottom quintile, equal weight; hold close me[mi] -> close me[mi+1]; a stock that stops trading is held at its last
 *   close (the delisting loss counts).
 * STATISTIC. Monthly long-short spread series; net = gross - cost; Newey-West t (lag 3) on the net monthly series. Reported: net mean,
 *   NW t, first-half and second-half net means, gross mean and gross NW t, mean turnover, names per leg.
 * COST MODEL. 0.25% x (long-leg turnover + short-leg turnover) per month, turnover = fraction of each leg's names new this month
 *   (first month = 2), exactly as R161.
 * WINDOWS. DISCOVERY = holding months 2017-01..2021-12 (first computable month 2017-02: signal needs 12 prior month-ends from
 *   2016-01-04); HOLDOUT = holding months 2022-01..2026-09 (panel ends 2026-09-22, so 2026-09 is a partial month).
 * PROTOCOL.
 *   --selftest   synthetic known-answer checks only (no real data). Prints PASS/FAIL, exits 1 on FAIL.
 *   --controls   on the panel TRUNCATED at 2021-12-31: (a) leak test = iid BOOTSTRAP null (each stock's daily (overnight, intraday)
 *                factor pairs redrawn with replacement from days <= 2021-12-31 ONLY, drift estimated from those days only,
 *                open/close paths rebuilt) must give
 *                |GROSS NW t| < 2 for INTRA and OVER over the discovery window; (b) positive control = signal is the realised
 *                holding return (peek) must give GROSS NW t >= 5. Writes data/hunt/INTRADAY_MOM-controls.json.
 *   --discovery  refuses unless controls passed AND data/test-registry.json has a preregistered entry whose script is
 *                "backend/hunt/INTRADAY_MOM.js". Panel TRUNCATED at 2021-12-31. Writes data/hunt/INTRADAY_MOM-discovery.json once.
 *                Discovery is informational; it does not change the frozen rule and does not gate the holdout read.
 *   --holdout    refuses unless discovery exists (and registration + controls). Computes the frozen rule on holdout months once,
 *                writes data/hunt/INTRADAY_MOM-holdout.json, refuses to overwrite.
 *                PASS (primary INTRA only): net mean > 0 AND NW t >= 1.70 AND both holdout halves' net means > 0. OVER is context.
 *   --status     which files exist.
 * The holdout months are unreachable outside --holdout: every other mode loads the panel truncated at 2021-12-31, and run() refuses
 * a window reaching 2022-01 unless the holdout branch unlocked it.
 * FIXES 2026-09-23: every PASS/bar comparison reads UNROUNDED values (summary.raw; rounding is display only); main runs only when
 * executed directly (require() never runs a mode); v2 panel; dollar-volume screen replaces the $5 floor; bootstrap pool <= 2021-12-31.
 */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("../lib/atomic-write.js");
const KEY = "INTRADAY_MOM", SCRIPT = "backend/hunt/INTRADAY_MOM.js";
const DATA = path.join(__dirname, "..", "data"), DIR = path.join(DATA, "anomaly-cache-v2"), HD = path.join(DATA, "hunt");
const CTRL = path.join(HD, `${KEY}-controls.json`), OUTD = path.join(HD, `${KEY}-discovery.json`), OUTH = path.join(HD, `${KEY}-holdout.json`);
const COST = 0.0025, TOPN = 1500, MIN_MED_DV = 5e6, MINDAYS = 180, FMIN = 1 / 3, FMAX = 3, BAR_T = 1.70, NW_LAG = 3;
const DISC = ["2017-01", "2021-12"], HOLD = ["2022-01", "2026-09"], DISC_END_DATE = "2021-12-31";
const VERSIONS = { INTRA: 1, OVER: 1 };           // sign +1 = long the high quintile; INTRA is the primary, OVER is report-only
let HOLDOUT_UNLOCKED = false;

const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
function nwT(a, L = NW_LAG) { const n = a.length; if (n < 6) return null; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n; for (let k = 1; k <= L; k++) { let c = 0; for (let i = k; i < n; i++) c += d[i] * d[i - k]; v += 2 * (1 - k / (L + 1)) * c / n; } return v > 0 ? m / Math.sqrt(v / n) : null; }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r3 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(3));

// maxDate: keep only dates <= maxDate (holdout physically absent from the arrays outside --holdout)
function loadPanel(maxDate) {
  const meta = JSON.parse(fs.readFileSync(path.join(DIR, "meta.json"), "utf8")), T0 = meta.dates.length, N = meta.symbols.length;
  const T = maxDate ? meta.dates.filter((d) => d <= maxDate).length : T0;
  const rd = (f) => { const b = fs.readFileSync(path.join(DIR, f)), full = new Float32Array(b.buffer, b.byteOffset, N * T0); if (T === T0) return full;
    const out = new Float32Array(N * T); for (let s = 0; s < N; s++) out.set(full.subarray(s * T0, s * T0 + T), s * T); return out; };
  return { meta: { ...meta, dates: meta.dates.slice(0, T) }, T, N, C: rd("close.f32"), O: rd("open.f32"), V: rd("vol.f32") };
}

// DV = dollar volume on real closes (eligibility input, as R161). Cx/Ox = price paths used for signals and holding returns;
// with scrambleSeed they are rebuilt from an iid bootstrap of each stock's own (overnight, intraday) factor pairs, drift removed.
// P3 (2026-09-23): the bootstrap POOL (the factor pairs drawn from and the drift estimate) uses only days dated <= poolMaxDate
// (default DISC_END_DATE), so the discovery-window null can never draw returns from after 2021-12-31 even if handed a longer panel.
// Days after poolMaxDate (if any) are still rebuilt, by draws from that same pre-cutoff pool.
function prepare(P, scrambleSeed = 0, { poolMaxDate = DISC_END_DATE } = {}) {
  const { T, N, C, O, V } = P, DV = new Float32Array(N * T).fill(NaN);
  for (let s = 0; s < N; s++) { const o = s * T; for (let t = 0; t < T; t++) { const b = C[o + t]; if (b > 0 && V[o + t] >= 0) DV[o + t] = b * V[o + t]; } }
  let Cx = C, Ox = O;
  if (scrambleSeed) {
    const rng = mulberry(scrambleSeed); Cx = new Float32Array(C); Ox = new Float32Array(O);
    const dates = P.meta.dates; let tPool = -1; for (let t = 0; t < T; t++) if (dates[t] <= poolMaxDate) tPool = t;   // last poolable day
    for (let s = 0; s < N; s++) {
      const o = s * T, idx = [], gon = [], gid = [];
      for (let t = 1; t < T; t++) if (C[o + t - 1] > 0 && C[o + t] > 0 && O[o + t] > 0) idx.push(t);
      for (const t of idx) if (t <= tPool) { gon.push(O[o + t] / C[o + t - 1]); gid.push(C[o + t] / O[o + t]); }
      if (gon.length < 20) continue;
      const mu = mean(gon.map((x, i) => x * gid[i]));          // close-to-close drift (pool days only) removed from the overnight leg
      const pick = new Map(); for (const t of idx) pick.set(t, Math.floor(rng() * gon.length));
      const first = idx[0] - 1; let px = C[o + first];
      for (let t = first + 1; t < T; t++) {
        if (!(C[o + t] > 0)) continue;
        if (pick.has(t)) { const k = pick.get(t), op = px * gon[k] / mu, cl = op * gid[k]; Ox[o + t] = op; Cx[o + t] = cl; px = cl; }
        else { Ox[o + t] = px; Cx[o + t] = px; }               // a close after a gap carries the path flat, never the real price
      }
    }
  }
  return { ...P, DV, Cx, Ox };
}
const monthEnds = (dates) => { const e = []; for (let t = 0; t < dates.length; t++) if (t === dates.length - 1 || dates[t + 1].slice(0, 7) !== dates[t].slice(0, 7)) e.push(t); return e; };

// cumulative intraday / overnight return of stock s over days a < d <= b (data through b only)
function dayNightSignal(Q, s, a, b) {
  const { T, Cx, Ox } = Q, o = s * T; let li = 0, ni = 0, lo = 0, no = 0;
  for (let d = a + 1; d <= b; d++) {
    const c = Cx[o + d], op = Ox[o + d];
    if (op > 0 && c > 0) { const g = c / op; if (g >= FMIN && g <= FMAX) { li += Math.log(g); ni++; } }
    const pc = d > 0 ? Cx[o + d - 1] : 0;
    if (pc > 0 && op > 0) { const g = op / pc; if (g >= FMIN && g <= FMAX) { lo += Math.log(g); no++; } }
  }
  return { INTRA: ni >= MINDAYS ? Math.exp(li) - 1 : NaN, OVER: no >= MINDAYS ? Math.exp(lo) - 1 : NaN, ni, no };
}

// Eligibility (P2, 2026-09-23): history + split-invariant liquidity; NO price-level screen (adjusted prices at t depend on later splits).
// A name must trade at t (Cx[t] > 0), have >= 252 closes in the last 260 days, >= 40 dollar-volume days in the last 60, and a 60-day
// MEDIAN dollar volume (over the days with a print) >= $5M; ranked by 60-day MEAN dollar volume, top topN kept.
function universeAt(Q, t, topN = TOPN) {
  const { T, N, DV, Cx } = Q, out = [];
  for (let s = 0; s < N; s++) {
    const o = s * T; if (!(Cx[o + t] > 0)) continue;
    let hist = 0; for (let k = t; k >= 0 && k > t - 260; k--) if (Cx[o + k] > 0) hist++; if (hist < 252) continue;
    const xs = []; for (let k = Math.max(0, t - 59); k <= t; k++) { const x = DV[o + k]; if (x >= 0) xs.push(x); } if (xs.length < 40) continue;
    xs.sort((a, b) => a - b); const h = xs.length >> 1, med = xs.length % 2 ? xs[h] : (xs[h - 1] + xs[h]) / 2; if (!(med >= MIN_MED_DV)) continue;
    out.push({ s, dv: mean(xs), med });
  }
  out.sort((a, b) => b.dv - a.dv); return out.slice(0, topN);
}
function holdReturn(Q, s, t0, t1) { const { T, Cx } = Q, o = s * T, a = Cx[o + t0]; if (!(a > 0)) return NaN; let last = a; for (let k = t0 + 1; k <= t1; k++) { const x = Cx[o + k]; if (x > 0) last = x; } return last / a - 1; }

function run(Q, fromYm, toYm, { peek = false, topN = TOPN, quiet = false } = {}) {
  if (toYm >= HOLD[0] && !HOLDOUT_UNLOCKED) throw new Error(`holdout months are sealed — refusing window ${fromYm}..${toYm}`);
  const dates = Q.meta.dates, me = monthEnds(dates), series = Object.fromEntries(Object.keys(VERSIONS).map((k) => [k, []])), prev = {};
  for (let mi = 12; mi < me.length - 1; mi++) {
    const t = me[mi], t1 = me[mi + 1], ymHold = dates[t1].slice(0, 7); if (ymHold < fromYm || ymHold > toYm) continue;
    const U = universeAt(Q, t, topN).map((u) => ({ ...u, sig: dayNightSignal(Q, u.s, me[mi - 12], me[mi - 1]) }));
    const fwd = new Map(U.map((u) => [u.s, holdReturn(Q, u.s, t, t1)]));
    for (const [k, sign] of Object.entries(VERSIONS)) {
      const xs = U.map((u) => ({ s: u.s, v: peek ? fwd.get(u.s) : u.sig[k] })).filter((x) => Number.isFinite(x.v)); if (xs.length < 100) continue;
      xs.sort((a, b) => a.v - b.v); const q = Math.floor(xs.length / 5), lo = xs.slice(0, q), hi = xs.slice(xs.length - q), L = sign > 0 ? hi : lo, S = sign > 0 ? lo : hi;
      const avg = (g) => mean(g.map((x) => fwd.get(x.s)).filter(Number.isFinite)), gross = avg(L) - avg(S); if (!Number.isFinite(gross)) continue;
      const p = prev[k], turn = p ? (L.filter((x) => !p.L.has(x.s)).length / L.length + S.filter((x) => !p.S.has(x.s)).length / S.length) : 2;
      prev[k] = { L: new Set(L.map((x) => x.s)), S: new Set(S.map((x) => x.s)) };
      series[k].push({ ym: ymHold, gross, net: gross - COST * turn, turn, n: q });
    }
    if (!quiet) process.stdout.write(`  ${KEY} ${ymHold}\r`);
  }
  if (!quiet) process.stdout.write("\n");
  return Object.fromEntries(Object.entries(series).map(([k, a]) => [k, summarize(a)]));
}
// F1 (2026-09-23): `raw` holds the UNROUNDED statistics; every PASS/bar decision reads raw. The r3 fields are display only.
function summarize(a) {
  const net = a.map((x) => x.net), g = a.map((x) => x.gross), h = Math.floor(net.length / 2);
  const fin = (x) => (x == null || !Number.isFinite(x) ? null : x);
  const raw = { net: fin(mean(net)), tNW: fin(nwT(net)), firstHalf: fin(mean(net.slice(0, h))), secondHalf: fin(mean(net.slice(h))), gross: fin(mean(g)), tGrossNW: fin(nwT(g)) };
  return { months: a.length, firstMonth: a[0] ? a[0].ym : null, lastMonth: a.length ? a[a.length - 1].ym : null,
    netPctPerMonth: r3(100 * mean(net)), tNW: r3(raw.tNW), firstHalfPct: r3(100 * mean(net.slice(0, h))), secondHalfPct: r3(100 * mean(net.slice(h))),
    grossPctPerMonth: r3(100 * mean(g)), tGrossNW: r3(raw.tGrossNW), meanTurnover: r3(mean(a.map((x) => x.turn))), meanNamesPerLeg: r3(mean(a.map((x) => x.n))),
    raw, series: a.map((x) => ({ ym: x.ym, gross: +x.gross.toFixed(5), net: +x.net.toFixed(5), turn: +x.turn.toFixed(3) })) };
}
// Decisions on UNROUNDED inputs only (callers pass summary.raw values, never the r3 display fields).
const holdoutClears = (raw) => raw != null && raw.net != null && raw.net > 0 && raw.tNW != null && raw.tNW >= BAR_T && raw.firstHalf != null && raw.firstHalf > 0 && raw.secondHalf != null && raw.secondHalf > 0;
const leakOkT = (t) => t != null && Number.isFinite(t) && Math.abs(t) < 2;
const peekOkT = (t) => t != null && Number.isFinite(t) && t >= 5;
const strip = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { ...v, series: undefined }]));
const readJ = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null);
function registered() { const reg = readJ(path.join(DATA, "test-registry.json")); return reg && (reg.preregistered || []).find((x) => x && x.script === SCRIPT); }

// ---------------------------------------------------------------- selftest: synthetic panels only
function synthPanel({ N = 600, seed = 1, muSd = 0.001, idSd = 0.015, onSd = 0.008, end = DISC_END_DATE } = {}) {
  const dates = []; for (let d = new Date(Date.UTC(2016, 0, 4)); d.toISOString().slice(0, 10) <= end; d.setUTCDate(d.getUTCDate() + 1)) { const w = d.getUTCDay(); if (w > 0 && w < 6) dates.push(d.toISOString().slice(0, 10)); }
  const T = dates.length, rng = mulberry(seed), gauss = () => { let u = 0, v = 0; while (u === 0) u = rng(); v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const C = new Float32Array(N * T), O = new Float32Array(N * T), V = new Float32Array(N * T).fill(1e6), mu = [];
  for (let s = 0; s < N; s++) { const m = muSd * gauss(); mu.push(m); let px = 500; C[s * T] = O[s * T] = px;
    for (let t = 1; t < T; t++) { const op = px * Math.exp(onSd * gauss() - onSd * onSd / 2), cl = op * Math.exp(m + idSd * gauss() - idSd * idSd / 2); O[s * T + t] = op; C[s * T + t] = cl; px = cl; } }
  return { meta: { dates, symbols: Array.from({ length: N }, (_, i) => `S${i}`), info: [] }, T, N, C, O, V, mu };
}
function selftest() {
  const checks = [], ok = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail }); console.log(`  ${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`); };
  // 1. NW t known answer (L = 0 reduces to mean / sqrt(popvar / n))
  const t0 = nwT([1, 2, 3, 4, 5, 6, 7, 8], 0); ok("nwT known answer", Math.abs(t0 - 4.5 / Math.sqrt(5.25 / 8)) < 1e-9, `t ${t0.toFixed(4)} vs ${(4.5 / Math.sqrt(5.25 / 8)).toFixed(4)}`);
  // 2. signal arithmetic on a hand panel: 3 days, opens/closes known
  { const Q = { T: 4, Cx: new Float32Array([10, 11, 12, 12]), Ox: new Float32Array([10, 10, 11.5, 13]) };
    const li = (11 / 10) * (12 / 11.5) * (12 / 13) - 1, lo = (10 / 10) * (11.5 / 11) * (13 / 12) - 1;
    const g = dayNightSignalLoose(Q, 0, 0, 3);
    ok("intraday/overnight product arithmetic", Math.abs(g.INTRA - li) < 1e-5 && Math.abs(g.OVER - lo) < 1e-5 && Math.abs((1 + g.INTRA) * (1 + g.OVER) - 12 / 10) < 1e-5, `INTRA ${g.INTRA.toFixed(6)} (want ${li.toFixed(6)}) OVER ${g.OVER.toFixed(6)} (want ${lo.toFixed(6)}); product = close-to-close`); }
  // 3. delisting: held at last close
  { const Q = { T: 6, Cx: new Float32Array([10, 11, 9, 0, 0, 0]) }; const r = holdReturn(Q, 0, 0, 5); ok("delisted name held at last close", Math.abs(r - (-0.1)) < 1e-6, `hold ${r.toFixed(4)} (want -0.1000)`); }
  // 4. look-ahead: mutating any price after the window end leaves the signal unchanged; mutating inside changes it
  const P = synthPanel({ seed: 7 }), Q = prepare(P), me = monthEnds(P.meta.dates), mi = 30, a = me[mi - 12], b = me[mi - 1];
  { const before = dayNightSignal(Q, 5, a, b), Cm = new Float32Array(Q.Cx), Om = new Float32Array(Q.Ox); for (let t = b + 1; t < P.T; t++) { Cm[5 * P.T + t] *= 1.7; Om[5 * P.T + t] *= 0.6; }
    const after = dayNightSignal({ ...Q, Cx: Cm, Ox: Om }, 5, a, b); Om[5 * P.T + b] *= 1.2; const inside = dayNightSignal({ ...Q, Cx: Cm, Ox: Om }, 5, a, b);
    ok("no look-ahead past the skip month", before.INTRA === after.INTRA && before.OVER === after.OVER && inside.INTRA !== before.INTRA, `window days ${before.ni}; post-window mutation Δ ${after.INTRA - before.INTRA}; in-window mutation Δ ${(inside.INTRA - before.INTRA).toFixed(4)}`); }
  // 5. holdout seal
  { let threw = false; try { run(Q, "2021-06", "2022-03", { quiet: true }); } catch (e) { threw = /sealed/.test(e.message); } ok("holdout window refused outside --holdout", threw, threw ? "run() threw 'sealed'" : "run() did NOT refuse"); }
  // 6. known answer: persistent intraday drift, zero overnight drift -> INTRA spread strongly positive, OVER spread ~ noise
  const R = run(Q, DISC[0], DISC[1], { quiet: true });
  ok("known answer: planted intraday momentum found", R.INTRA.raw.tGrossNW >= 5 && R.INTRA.raw.net > 0, `INTRA gross t ${R.INTRA.tGrossNW}, net ${R.INTRA.netPctPerMonth}%/mo over ${R.INTRA.months} months`);
  ok("known answer: overnight control is noise", Math.abs(R.OVER.raw.tGrossNW) < 3, `OVER gross t ${R.OVER.tGrossNW}`);
  // 7. the iid bootstrap null destroys the planted effect (the leak test machinery) and preserves the panel shape
  { const S = prepare(P, 4242); let shapeOk = true; for (let i = 0; i < P.N * P.T; i++) if ((P.C[i] > 0) !== (S.Cx[i] > 0) || (S.Cx[i] > 0 && !(S.Ox[i] > 0))) { shapeOk = false; break; }
    const Rn = run(S, DISC[0], DISC[1], { quiet: true }); ok("bootstrap null: |gross t| < 2 on a panel WITH a planted effect", shapeOk && leakOkT(Rn.INTRA.raw.tGrossNW) && leakOkT(Rn.OVER.raw.tGrossNW), `shape ${shapeOk ? "kept" : "BROKEN"}; INTRA t ${Rn.INTRA.tGrossNW}, OVER t ${Rn.OVER.tGrossNW}`); }
  // 8. positive control (peek) clears t >= 5
  { const Rp = run(Q, DISC[0], DISC[1], { quiet: true, peek: true }); ok("positive control (peek) t >= 5", peekOkT(Rp.INTRA.raw.tGrossNW), `peek gross t ${Rp.INTRA.tGrossNW}`); }
  // 9. cost arithmetic: first month turnover 2 -> net = gross - 0.5%
  { const s0 = R.INTRA.series[0]; ok("cost model 0.25% x turnover", s0.turn === 2 && Math.abs(s0.gross - s0.net - 0.005) < 1e-4, `first month turn ${s0.turn}, gross-net ${(s0.gross - s0.net).toFixed(5)}`); }
  // 10. F1: bar decisions read UNROUNDED values. raw t 1.6995 and 1.69996 must FAIL the 1.70 bar although 1.69996 displays as 1.7;
  //     a half of -4e-7 (display -0.000) fails; leak |t| 1.99996 (display 2) passes; peek 4.99996 (display 5) fails.
  { const base = { net: 0.004, firstHalf: 0.003, secondHalf: 0.005 };
    const f1 = holdoutClears({ ...base, tNW: 1.6995 }), f1b = holdoutClears({ ...base, tNW: 1.69996 }), f2 = holdoutClears({ ...base, tNW: 1.70 }), f3 = holdoutClears({ ...base, tNW: 1.9, secondHalf: -0.0000004 });
    ok("F1 unrounded bars: t 1.6995 / 1.69996 FAIL 1.70, t 1.70 passes, a -4e-7 half fails", !f1 && !f1b && f2 && !f3 && r3(1.69996) === 1.7 && leakOkT(1.99996) && !peekOkT(4.99996),
      `holdout(1.6995)=${f1}, holdout(1.69996)=${f1b} (display ${r3(1.69996)}), holdout(1.70)=${f2}, tiny-negative-half=${f3}, leak(1.99996)=${leakOkT(1.99996)} (display ${r3(1.99996)}), peek(4.99996)=${peekOkT(4.99996)} (display ${r3(4.99996)})`); }
  // 11. P2: no price floor; split-invariant liquidity screen (median dollar volume >= $5M over the last 60 days)
  { const dates = P.meta.dates.slice(0, 300), T = 300, N = 4, C = new Float32Array(N * T), O = new Float32Array(N * T), V = new Float32Array(N * T);
    for (let t = 0; t < T; t++) {
      C[t] = O[t] = 1; V[t] = 6e6;                                       // s0: $1 stock, $6M/day -> eligible (no $5 floor)
      C[T + t] = O[T + t] = 100; V[T + t] = 40000;                         // s1: $100 x 40k = $4M/day -> median fails
      C[2 * T + t] = O[2 * T + t] = 100; V[2 * T + t] = t % 10 === 0 ? 3e6 : 30000;  // s2: mean ~$32.7M but median $3M -> fails
      C[3 * T + t] = O[3 * T + t] = 20; V[3 * T + t] = 300000;             // s3: $20 x 300k = $6M/day -> eligible
    }
    const mk = (Cc, Vv) => prepare({ meta: { dates }, T, N, C: Cc, O, V: Vv }), t = T - 1;
    const u = universeAt(mk(C, V), t).map((x) => x.s).sort();
    const C2 = new Float32Array(C), V2 = new Float32Array(V); for (let k = 0; k < T; k++) { C2[3 * T + k] /= 8; V2[3 * T + k] *= 8; C2[k] *= 40; V2[k] /= 40; }   // a later split re-adjusts history
    const u2 = universeAt(mk(C2, V2), t).map((x) => x.s).sort();
    ok("P2 liquidity screen: $1 stock kept, median < $5M dropped, split-invariant", JSON.stringify(u) === "[0,3]" && JSON.stringify(u2) === JSON.stringify(u),
      `eligible ${JSON.stringify(u)} (want [0,3]); after back-adjusting splits ${JSON.stringify(u2)}`); }
  // 12. P3: the bootstrap pool stops at DISC_END_DATE even on a longer panel — pre-cutoff null paths do not depend on post-cutoff data
  { const PL = synthPanel({ N: 40, seed: 11, end: "2022-06-30" }), tc = PL.meta.dates.filter((d) => d <= DISC_END_DATE).length;
    const S1 = prepare(PL, 99), CL = new Float32Array(PL.C), OL = new Float32Array(PL.O);
    for (let s = 0; s < PL.N; s++) for (let t = tc; t < PL.T; t++) { CL[s * PL.T + t] *= 3.1; OL[s * PL.T + t] *= 0.45; }
    const S2 = prepare({ ...PL, C: CL, O: OL }, 99); let same = true, drewPost = false;
    for (let s = 0; s < PL.N && same; s++) for (let t = 0; t < tc; t++) if (S1.Cx[s * PL.T + t] !== S2.Cx[s * PL.T + t] || S1.Ox[s * PL.T + t] !== S2.Ox[s * PL.T + t]) { same = false; break; }
    const S3 = prepare({ ...PL, C: CL, O: OL }, 99, { poolMaxDate: "2099-12-31" });   // unrestricted pool DOES see the mutation
    for (let s = 0; s < PL.N && !drewPost; s++) for (let t = 0; t < tc; t++) if (S3.Cx[s * PL.T + t] !== S1.Cx[s * PL.T + t]) { drewPost = true; break; }
    ok("P3 bootstrap pool <= 2021-12-31", same && drewPost, `pre-cutoff null paths ${same ? "identical" : "CHANGED"} after mutating ${PL.T - tc} post-cutoff days; unrestricted pool ${drewPost ? "does" : "does NOT"} see them (sensitivity check)`); }
  // 13. F2: require() never runs a mode
  { const { spawnSync } = require("child_process"), r = spawnSync(process.execPath, ["-e", `const m = require(${JSON.stringify(__filename)}); process.stdout.write("EXPORTS " + Object.keys(m).join(","));`], { encoding: "utf8", timeout: 60000 });
    const out = (r.stdout || "").trim(); ok("F2 require() runs no mode", r.status === 0 && /^EXPORTS /.test(out) && !/INTRADAY_MOM:|SELFTEST|panel/.test(out), `exit ${r.status}; stdout "${out.slice(0, 120)}"`); }
  const pass = checks.every((c) => c.pass); console.log(`${KEY} SELFTEST ${pass ? "PASS" : "FAIL"} (${checks.filter((c) => c.pass).length}/${checks.length})`); return pass;
}
function dayNightSignalLoose(Q, s, a, b) {      // selftest helper: same arithmetic as dayNightSignal with the day minimum lifted
  const { T, Cx, Ox } = Q, o = s * T; let li = 0, lo = 0;
  for (let d = a + 1; d <= b; d++) { const c = Cx[o + d], op = Ox[o + d]; if (op > 0 && c > 0) { const g = c / op; if (g >= FMIN && g <= FMAX) li += Math.log(g); }
    const pc = d > 0 ? Cx[o + d - 1] : 0; if (pc > 0 && op > 0) { const g = op / pc; if (g >= FMIN && g <= FMAX) lo += Math.log(g); } }
  return { INTRA: Math.exp(li) - 1, OVER: Math.exp(lo) - 1 };
}

// ---------------------------------------------------------------- main (F2: runs only when executed directly; require() runs nothing)
module.exports = { KEY, SCRIPT, loadPanel, prepare, monthEnds, dayNightSignal, universeAt, holdReturn, summarize, holdoutClears, leakOkT, peekOkT, nwT, selftest };
if (require.main === module) (async () => {
  const mode = ["--selftest", "--controls", "--discovery", "--holdout", "--status"].find((m) => process.argv.includes(m)) || "--status";
  if (mode === "--selftest") { process.exit(selftest() ? 0 : 1); }
  if (mode === "--status") { console.log(`${KEY}: registered ${registered() ? "yes" : "NO"} · controls ${fs.existsSync(CTRL) ? (readJ(CTRL).pass ? "PASSED" : "FAILED") : "pending"} · discovery ${fs.existsSync(OUTD) ? "sealed" : "pending"} · holdout ${fs.existsSync(OUTH) ? "READ" : "sealed/unopened"}`); return; }
  fs.mkdirSync(HD, { recursive: true });
  if (mode === "--controls") {   // leak test reads GROSS spreads: on noise, net spreads are negative by exactly their cost
    const P = loadPanel(DISC_END_DATE); console.log(`panel ${P.N} symbols x ${P.T} days (truncated at ${DISC_END_DATE})`);
    if (P.meta.dates[P.T - 1] > DISC_END_DATE) throw new Error(`controls panel reaches ${P.meta.dates[P.T - 1]} — refusing (must end <= ${DISC_END_DATE})`);
    const scr = run(prepare(P, 1717, { poolMaxDate: DISC_END_DATE }), DISC[0], DISC[1]), pk = run(prepare(P), DISC[0], DISC[1], { peek: true });
    const leakRaw = { INTRA: scr.INTRA.raw.tGrossNW, OVER: scr.OVER.raw.tGrossNW }, leakOk = Object.values(leakRaw).every(leakOkT);
    const peekRaw = pk.INTRA.raw.tGrossNW, peekOk = peekOkT(peekRaw);
    const leak = { INTRA: r3(leakRaw.INTRA), OVER: r3(leakRaw.OVER) }, peekT = r3(peekRaw);
    writeJsonAtomic(CTRL, { spec: `${KEY}-controls-v2`, asOf: new Date().toISOString(), panel: "anomaly-cache-v2", window: DISC, bootstrapSeed: 1717, bootstrapPoolMaxDate: DISC_END_DATE,
      leakBootstrapGrossT: leak, leakBootstrapGrossTRaw: leakRaw, leakOk, peekGrossT: peekT, peekGrossTRaw: peekRaw, peekOk, pass: leakOk && peekOk });
    console.log(`${KEY} controls — iid-bootstrap |gross t| < 2: ${leakOk ? "PASS" : "FAIL"} ${JSON.stringify(leak)} · positive control t ${peekT} ${peekOk ? "PASS" : "FAIL"}`);
    return;
  }
  const reg = registered(); if (!reg) { console.error(`${KEY}: no preregistered entry with script "${SCRIPT}" in data/test-registry.json — refusing`); process.exit(2); }
  const ctrl = readJ(CTRL); if (!ctrl || !ctrl.pass) { console.error(`${KEY}: controls have not passed — refusing`); process.exit(2); }
  if (mode === "--discovery") {
    if (fs.existsSync(OUTD)) { console.error("discovery already sealed — refusing"); process.exit(2); }
    const P = loadPanel(DISC_END_DATE); console.log(`panel ${P.N} symbols x ${P.T} days (truncated at ${DISC_END_DATE})`);
    const r = run(prepare(P), DISC[0], DISC[1]);
    writeJsonAtomic(OUTD, { spec: `${KEY}-discovery-v2`, panel: "anomaly-cache-v2", sealedAt: new Date().toISOString(), registryId: reg.id || null, window: DISC, primary: "INTRA", reportOnly: ["OVER"], holdoutBarT: BAR_T, results: r });
    console.log(`${KEY} DISCOVERY ${DISC.join("..")} (sealed; informational — the rule is frozen and the holdout is the verdict)`);
    for (const [k, v] of Object.entries(r)) console.log(`  ${k.padEnd(5)}${k === "INTRA" ? " (primary)" : " (report) "} net ${v.netPctPerMonth}%/mo · NW t ${v.tNW} · halves ${v.firstHalfPct}/${v.secondHalfPct} · gross ${v.grossPctPerMonth}%/mo (t ${v.tGrossNW}) · turnover ${v.meanTurnover} · ${v.meanNamesPerLeg}/leg · ${v.months} mo`);
    return;
  }
  if (mode === "--holdout") {
    if (fs.existsSync(OUTH)) { console.error("holdout already read — refusing"); process.exit(2); }
    if (!fs.existsSync(OUTD)) { console.error("discovery not sealed — refusing"); process.exit(2); }
    HOLDOUT_UNLOCKED = true;
    const P = loadPanel(null); console.log(`panel ${P.N} symbols x ${P.T} days`);
    const r = run(prepare(P), HOLD[0], HOLD[1]), v = r.INTRA;
    const clears = holdoutClears(v.raw), verdict = clears ? "PASS" : "DID NOT PASS";   // F1: unrounded values only
    writeJsonAtomic(OUTH, { spec: `${KEY}-holdout-v2`, panel: "anomaly-cache-v2", read: true, asOf: new Date().toISOString(), registryId: reg.id || null, window: HOLD, barT: BAR_T,
      rule: "INTRA net mean > 0 AND NW t (lag 3) >= 1.70 AND both holdout halves net > 0", primary: v, reportOnlyOvernight: r.OVER, verdict });
    console.log(`${KEY} HOLDOUT ${HOLD.join("..")} — ${verdict} (bar t >= ${BAR_T})`);
    for (const [k, x] of Object.entries(r)) console.log(`  ${k.padEnd(5)}${k === "INTRA" ? " (primary)" : " (report) "} net ${x.netPctPerMonth}%/mo · NW t ${x.tNW} · halves ${x.firstHalfPct}/${x.secondHalfPct} · gross ${x.grossPctPerMonth}%/mo (t ${x.tGrossNW}) · turnover ${x.meanTurnover} · ${x.months} mo`);
  }
})().catch((e) => { console.error(`${KEY} FAILED:`, e.message); process.exit(1); });
