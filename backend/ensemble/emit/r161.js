#!/usr/bin/env node
"use strict";
/**
 * Library emitter — R161 published price anomalies (19 quintile long-short portfolios). READ-ONLY.
 *
 * Source: backend/r161-anomalies.js is NOT require()-safe (its IIFE dispatches on argv and defaults to --status; --discovery/--holdout
 * write sealed files) and is never executed here. Copied VERBATIM: constants (line 32-34), loadPanel (36-40), mean/nwT/mulberry (41-43),
 * prepare (46-66, only the scrambleSeed = 0 path is used), monthEnds (67), signalsAt (69-98), holdReturn (99). run() (101-119) is copied
 * verbatim with EMITTER ADDITIONS (marked) that record each month's long/short membership, formation day t and holding end t1.
 * As sealed, the discovery window (2017-01..2021-12) and the holdout window (2022-01..2026-09) are two SEPARATE runs, so turnover
 * restarts at 2 (full) in each window's first month — the costs are exactly the sealed ones.
 *
 * Daily series: within each holding month the portfolio is buy-and-hold from the formation close t with the month's fixed formation
 * weights (1/|L| per long name, 1/|S| per short name, $1 long and $1 short per $1 of capital). Name value on day d = its last finite close
 * up to d / close at t (holdReturn's convention: a name that stops trading is held at its last close). Day return = change in the long
 * leg's value minus change in the short leg's value, on the month's starting capital, so the month's days sum EXACTLY to the sealed gross
 * spread; the month's cost 0.25% x (long turnover + short turnover) is charged on the first holding day.
 *
 * Reproduction: nwT (lag 3, verbatim) of the monthly sums of the emitted daily series, per window, vs the sealed discovery tNW
 * (data/r161-discovery.json) and holdout tNW (data/r161-holdout.json: carried[MOM6_1] and contextAll[*]).
 */
const fs = require("fs"), path = require("path");
const { writeEntry } = require("../lib-entry.js");
const D = (f) => path.join(__dirname, "..", "..", "data", f), DIR = D("anomaly-cache");
// ── verbatim lines 33-34 ─────────────────────────────────────────────────────────────────────────────────────────────────
const COST = 0.0025, TOPN = 1500, MINPX = 5, DISC = ["2017-01", "2021-12"], HOLD = ["2022-01", "2026-09"];
const SIGNALS = { MOM12_1: 1, MOM6_1: 1, MOM12_7: 1, CHMOM: 1, RESMOM: 1, STREV1M: -1, STREV1W: -1, LTREV: -1, HI52: 1, MAX: -1, IVOL: -1, VOL12: -1, BETA: -1, DBETA: 1, SKEW1M: -1, AMIHUD: 1, ABVOL: 1, SEAS: 1, AGE: 1 };

// ── verbatim lines 36-43 ─────────────────────────────────────────────────────────────────────────────────────────────────
function loadPanel() {
  const meta = JSON.parse(fs.readFileSync(path.join(DIR, "meta.json"), "utf8")), T = meta.dates.length, N = meta.symbols.length;
  const rd = (f) => { const b = fs.readFileSync(path.join(DIR, f)); return new Float32Array(b.buffer, b.byteOffset, N * T); };
  return { meta, T, N, C: rd("close.f32"), V: rd("vol.f32") };
}
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a, L = 3) { const n = a.length; if (n < 6) return null; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n; for (let k = 1; k <= L; k++) { let c = 0; for (let i = k; i < n; i++) c += d[i] * d[i - k]; v += 2 * (1 - k / (L + 1)) * c / n; } return v > 0 ? m / Math.sqrt(v / n) : null; }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ── verbatim lines 46-67 ─────────────────────────────────────────────────────────────────────────────────────────────────
function prepare(P, scrambleSeed = 0) {
  const { T, N, C, V, meta } = P, R = new Float32Array(N * T).fill(NaN), DV = new Float32Array(N * T).fill(NaN);
  for (let s = 0; s < N; s++) { const o = s * T; for (let t = 1; t < T; t++) { const a = C[o + t - 1], b = C[o + t]; if (a > 0 && b > 0) R[o + t] = b / a - 1; if (b > 0 && V[o + t] >= 0) DV[o + t] = b * V[o + t]; } }
  let Cx = C;
  if (scrambleSeed) {                              // drift-free permutation of each stock's own returns inside its listed span; closes rebuilt
    const rng = mulberry(scrambleSeed); Cx = new Float32Array(C);
    for (let s = 0; s < N; s++) { const o = s * T, idx = []; for (let t = 1; t < T; t++) if (!isNaN(R[o + t])) idx.push(t); if (idx.length < 20) continue;
      const g = idx.map((t) => 1 + R[o + t]), mu = mean(g); const vals = g.map((x) => x / mu - 1);
      const draw = idx.map(() => vals[Math.floor(rng() * vals.length)]);
      idx.forEach((t, k) => { R[o + t] = draw[k]; });
      let first = idx[0] - 1; let px = C[o + first]; for (let t = first + 1; t < T; t++) { if (!(C[o + t] > 0)) continue; if (!isNaN(R[o + t])) px = px * (1 + R[o + t]); Cx[o + t] = px; } }
  }
  const spyI = meta.symbols.indexOf("SPY"); let M;
  if (spyI >= 0) M = Array.from({ length: T }, (_, t) => R[spyI * T + t]);
  else { M = new Array(T).fill(NaN); for (let t = 1; t < T; t++) { let s = 0, n = 0; for (let i = 0; i < N; i++) { const r = R[i * T + t]; if (!isNaN(r) && Math.abs(r) < 0.5) { s += r; n++; } } M[t] = n ? s / n : NaN; } }
  return { ...P, R, DV, Cx, M };
}
const monthEnds = (dates) => { const e = []; for (let t = 0; t < dates.length; t++) if (t === dates.length - 1 || dates[t + 1].slice(0, 7) !== dates[t].slice(0, 7)) e.push(t); return e; };

// ── verbatim lines 69-99 ─────────────────────────────────────────────────────────────────────────────────────────────────
function signalsAt(Q, t, me, mi) {           // all signals for all eligible stocks at formation day t (= me[mi])
  const { T, N, R, DV, Cx, M, meta } = Q, out = [], dates = meta.dates;
  const tm = (k) => me[mi - k];              // month-end index k months back
  for (let s = 0; s < N; s++) {
    const o = s * T, px = Cx[o + t]; if (!(px >= MINPX)) continue;
    let hist = 0; for (let k = t; k >= 0 && k > t - 260; k--) if (Cx[o + k] > 0) hist++; if (hist < 252) continue;
    let dv = 0, nd = 0; for (let k = t - 59; k <= t; k++) { const x = DV[o + k]; if (x >= 0) { dv += x; nd++; } } if (nd < 40) continue;
    const ret = (a, b) => { const x = Cx[o + a], y = Cx[o + b]; return x > 0 && y > 0 ? y / x - 1 : NaN; };
    const sig = {};
    if (mi >= 12) { sig.MOM12_1 = ret(tm(12), tm(1)); sig.MOM12_7 = ret(tm(12), tm(7)); }
    if (mi >= 6) sig.MOM6_1 = ret(tm(6), tm(1));
    if (mi >= 12) sig.CHMOM = ret(tm(6), tm(1)) - ret(tm(12), tm(7));
    if (mi >= 36) sig.LTREV = ret(tm(36), tm(13));
    sig.STREV1M = ret(tm(1), t); sig.STREV1W = ret(t - 5, t);
    let mx = -Infinity; for (let k = t - 251; k <= t; k++) { const x = Cx[o + k]; if (x > mx) mx = x; } sig.HI52 = px / mx;
    let m1 = [], r1 = []; for (let k = t - 20; k <= t; k++) { const r = R[o + k], m = M[k]; if (!isNaN(r) && !isNaN(m)) { r1.push(r); m1.push(m); } }
    if (r1.length >= 15) { sig.MAX = Math.max(...r1); const mr = mean(r1), mm = mean(m1); let cov = 0, vm = 0, vr = 0, s3 = 0; for (let i = 0; i < r1.length; i++) { cov += (r1[i] - mr) * (m1[i] - mm); vm += (m1[i] - mm) ** 2; vr += (r1[i] - mr) ** 2; } const b = vm > 0 ? cov / vm : 0; sig.IVOL = Math.sqrt(Math.max(0, (vr - b * b * vm) / r1.length)); const sd = Math.sqrt(vr / r1.length); for (const x of r1) s3 += ((x - mr) / (sd || 1)) ** 3; sig.SKEW1M = sd > 0 ? s3 / r1.length : 0; }
    let r12 = [], m12 = []; for (let k = t - 251; k <= t; k++) { const r = R[o + k], m = M[k]; if (!isNaN(r) && !isNaN(m)) { r12.push(r); m12.push(m); } }
    if (r12.length >= 200) { const mr = mean(r12), mm = mean(m12); let cov = 0, vm = 0, vr = 0, dc = 0, dv2 = 0, n2 = 0; for (let i = 0; i < r12.length; i++) { cov += (r12[i] - mr) * (m12[i] - mm); vm += (m12[i] - mm) ** 2; vr += (r12[i] - mr) ** 2; if (m12[i] < mm) { dc += (r12[i] - mr) * (m12[i] - mm); dv2 += (m12[i] - mm) ** 2; n2++; } }
      sig.VOL12 = Math.sqrt(vr / r12.length); sig.BETA = vm > 0 ? cov / vm : NaN; sig.DBETA = dv2 > 0 ? dc / dv2 : NaN;
      if (mi >= 12) { const b = sig.BETA; let res = 0; for (let k = tm(12) + 1; k <= tm(1); k++) { const r = R[o + k], m = M[k]; if (!isNaN(r) && !isNaN(m)) res += r - b * m; } sig.RESMOM = res; } }
    let am = 0, na = 0; for (let k = t - 251; k <= t; k++) { const r = R[o + k], d = DV[o + k]; if (!isNaN(r) && d > 0) { am += Math.abs(r) / d; na++; } } if (na >= 200) sig.AMIHUD = am / na;
    let d21 = 0, n21 = 0, d252 = 0, n252 = 0; for (let k = t - 251; k <= t; k++) { const d = DV[o + k]; if (d >= 0) { d252 += d; n252++; if (k > t - 21) { d21 += d; n21++; } } } if (n21 >= 15 && n252 >= 200 && d252 > 0) sig.ABVOL = (d21 / n21) / (d252 / n252);
    const mon = dates[t].slice(5, 7); let sr = [], y = 1; while (mi - 12 * y + 1 >= 1) { const a = me[mi - 12 * y], b = me[mi - 12 * y + 1]; const r = ret(a, b); if (!isNaN(r)) sr.push(r); y++; } if (sr.length >= 1) sig.SEAS = mean(sr);   // month t+1's own calendar month in prior years
    const lst = meta.info[s].listings.map((w) => w.ipo).filter(Boolean).sort()[0]; if (lst) sig.AGE = (Date.parse(dates[t]) - Date.parse(lst)) / (365.25 * 864e5);
    out.push({ s, dv: dv / nd, sig });
  }
  out.sort((a, b) => b.dv - a.dv); return out.slice(0, TOPN);
}
function holdReturn(Q, s, t0, t1) { const { T, Cx } = Q, o = s * T, a = Cx[o + t0]; if (!(a > 0)) return NaN; let last = a; for (let k = t0 + 1; k <= t1; k++) { const x = Cx[o + k]; if (x > 0) last = x; } return last / a - 1; }

// ── run(): verbatim lines 101-119 with EMITTER ADDITIONS (books[]) and the progress line removed ─────────────────────────────
function run(Q, fromYm, toYm, peek = false) {
  const dates = Q.meta.dates, me = monthEnds(dates), series = Object.fromEntries(Object.keys(SIGNALS).map((k) => [k, []])), prev = {};
  const books = Object.fromEntries(Object.keys(SIGNALS).map((k) => [k, []]));                                   // EMITTER ADDITION
  for (let mi = 0; mi < me.length - 1; mi++) {
    const t = me[mi], t1 = me[mi + 1], ymHold = dates[t1].slice(0, 7); if (ymHold < fromYm || ymHold > toYm) continue;
    const U = signalsAt(Q, t, me, mi); const fwd = new Map(U.map((u) => [u.s, holdReturn(Q, u.s, t, t1)]));
    for (const [k, sign] of Object.entries(SIGNALS)) {
      const xs = U.filter((u) => Number.isFinite(peek ? fwd.get(u.s) : u.sig[k])).map((u) => ({ s: u.s, v: peek ? fwd.get(u.s) : u.sig[k] })); if (xs.length < 100) continue;
      xs.sort((a, b) => a.v - b.v); const q = Math.floor(xs.length / 5), lo = xs.slice(0, q), hi = xs.slice(xs.length - q), L = sign > 0 ? hi : lo, S = sign > 0 ? lo : hi;
      const avg = (g) => mean(g.map((x) => fwd.get(x.s)).filter(Number.isFinite)), gross = avg(L) - avg(S);
      const setL = new Set(L.map((x) => x.s)), setS = new Set(S.map((x) => x.s)), p = prev[k];
      const turn = p ? (L.filter((x) => !p.L.has(x.s)).length / L.length + S.filter((x) => !p.S.has(x.s)).length / S.length) : 2;
      prev[k] = { L: setL, S: setS }; series[k].push({ ym: ymHold, gross, net: gross - COST * turn, turn });
      books[k].push({ ym: ymHold, t, t1, L: L.map((x) => x.s).filter((s) => Number.isFinite(fwd.get(s))), S: S.map((x) => x.s).filter((s) => Number.isFinite(fwd.get(s))), gross, turn });   // EMITTER ADDITION
    }
    process.stdout.write(`  R161 emit ${ymHold}\r`);
  }
  process.stdout.write("\n");
  const summary = Object.fromEntries(Object.entries(series).map(([k, a]) => { const net = a.map((x) => x.net), h = Math.floor(net.length / 2);
    const g = a.map((x) => x.gross); return [k, { months: a.length, tGrossNW: nwT(g) == null ? null : +nwT(g).toFixed(3), grossPctPerMonth: +(100 * mean(a.map((x) => x.gross))).toFixed(3), netPctPerMonth: +(100 * mean(net)).toFixed(3), tNW: nwT(net) == null ? null : +nwT(net).toFixed(3), firstHalfPct: +(100 * mean(net.slice(0, h))).toFixed(3), secondHalfPct: +(100 * mean(net.slice(h))).toFixed(3), meanTurnover: +mean(a.map((x) => x.turn)).toFixed(2), series: a.map((x) => ({ ym: x.ym, net: +x.net.toFixed(5) })) }]; }));
  return { summary, books };                                                                                    // EMITTER ADDITION (was: return summary)
}

// ── emitter: buy-and-hold daily book per holding month ────────────────────────────────────────────────────────────────────
function dailyOfMonth(Q, b) {
  const { T, Cx } = Q, dates = Q.meta.dates, legVal = (grp) => { const last = grp.map((s) => Cx[s * T + b.t]), base = last.slice(), out = [];
    for (let d = b.t + 1; d <= b.t1; d++) { let v = 0; for (let i = 0; i < grp.length; i++) { const x = Cx[grp[i] * T + d]; if (x > 0) last[i] = x; v += last[i] / base[i]; } out.push(v / grp.length); } return out; };
  const gl = legVal(b.L), gs = legVal(b.S), rows = [];
  for (let j = 0; j < gl.length; j++) { const pl = j ? gl[j - 1] : 1, ps = j ? gs[j - 1] : 1; rows.push({ d: dates[b.t + 1 + j], r: (gl[j] - pl) - (gs[j] - ps) - (j === 0 ? COST * b.turn : 0) }); }
  return rows;
}

(async () => {
  const P = loadPanel(), Q = prepare(P); console.log(`panel ${P.N} symbols x ${P.T} days`);
  const disc = run(Q, DISC[0], DISC[1]), hold = run(Q, HOLD[0], HOLD[1]);
  const sealedD = JSON.parse(fs.readFileSync(D("r161-discovery.json"), "utf8")), sealedH = JSON.parse(fs.readFileSync(D("r161-holdout.json"), "utf8"));
  const lastDate = P.meta.dates[P.T - 1];
  const order = ["MOM6_1", ...Object.keys(SIGNALS).filter((k) => k !== "MOM6_1")];
  for (const k of order) {
    const bks = [...disc.books[k], ...hold.books[k]], series = [];
    for (const b of bks) series.push(...dailyOfMonth(Q, b));
    const byYm = new Map(); for (const x of series) { const ym = x.d.slice(0, 7); byYm.set(ym, (byYm.get(ym) || 0) + x.r); }
    const tOf = (w) => { const a = [...byYm.entries()].filter(([ym]) => ym >= w[0] && ym <= w[1]).sort().map(([, v]) => v); const t = nwT(a); return { n: a.length, t: t == null ? null : +t.toFixed(3) }; };
    const eD = tOf(DISC), eH = tOf(HOLD), sD = sealedD.results[k], sH = k === "MOM6_1" ? sealedH.carried[k] : sealedH.contextAll[k];
    // the verbatim monthly net (from run's own summary) vs the monthly sums of the daily series — must agree to float precision
    const verb = [...disc.summary[k].series, ...hold.summary[k].series], maxDiff = Math.max(...verb.map((x) => Math.abs(x.net - (byYm.get(x.ym) ?? NaN))));
    const matchD = eD.t != null && Math.abs(eD.t - sD.tNW) <= 0.02 && eD.n === sD.months, matchH = eH.t != null && Math.abs(eH.t - sH.tNW) <= 0.02;
    writeEntry({
      id: `R161-${k}`, name: `Published anomaly ${k} (quintile long-short, monthly)${k === "MOM6_1" ? " — carried to holdout" : ""}`, registryId: "R161",
      script: "backend/r161-anomalies.js", emitter: "backend/ensemble/emit/r161.js", unit: "daily", net: true,
      costModel: "0.25% x (long-leg turnover + short-leg turnover) per holding month, charged on the month's first session; turnover restarts at 2 in each window's first month (2017-01 discovery, 2022-01 holdout), as sealed",
      window: [series[0].d, lastDate], calendar: "us-equity", series,
      reproduction: { statistic: "holdout 2022-01..2026-09 net long-short Newey-West lag-3 t (tNW)", sealed: sH.tNW, emitted: eH.t, tolerance: 0.02, match: matchD && matchH },
      construction: "Each month-end the sealed quintile long-short is formed (top 1,500 by $vol, >= $5, >= 252 days); over the next month each leg is buy-and-hold with "
        + "equal formation weights (a name that stops trading is held at its last close), the day's return is the change in long-leg value minus the change in short-leg value "
        + "on the month's starting capital (so the month's days sum to the sealed gross spread), and the month's turnover cost is charged on its first session.",
      notes: `Discovery 2017-01..2021-12: emitted t ${eD.t} over ${eD.n} months vs sealed ${sD.tNW} over ${sD.months} (${matchD ? "match" : "NO MATCH"}); holdout: emitted t ${eH.t} over ${eH.n} months vs sealed ${sH.tNW}. `
        + `Max |monthly net (verbatim run) - sum of emitted days| = ${maxDiff.toExponential(2)}. `
        + (k === "MOM6_1" ? "MOM6_1 is the only anomaly carried to the holdout (discovery screen net > 0 and t >= 1.0); holdout bar 1.797 not met. " : `Not carried to the holdout by the discovery screen; its holdout numbers are the sealed file's weightless contextAll. `)
        + `Panel data/anomaly-cache (v1, read as sealed; ends ${lastDate}, so 2026-09 is a partial month to that date). Daily returns are on the month's starting capital (not compounded within the month).`,
    });
  }
})().catch((e) => { console.error("R161 emit FAILED:", e.stack); process.exit(1); });
