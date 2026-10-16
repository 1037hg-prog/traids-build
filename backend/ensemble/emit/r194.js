#!/usr/bin/env node
"use strict";
/**
 * Library emitter — R194 short-term momentum in high-turnover stocks (Medhat & Schmeling 2022). READ-ONLY.
 *
 * Source: backend/r194-turnover-momentum.js is NOT require()-safe (all top-level: seal check, then writes the sealed output, seals, the
 * registry and the ledger) and is never executed here. Copied VERBATIM: constants and helpers (lines 47-57), month-ends (60-63), per-month
 * dollar-volume sums (65-66), median20/formation/holdRet (67-82), the formation loop F (84-91), legSeries/summ (99-108). The bootstrap
 * control and the seal are not run.
 *
 * Daily series: each holding month the high-turnover-decile long (top 1-month-return tenth) and short (bottom tenth) legs are buy-and-hold
 * from the month-end close me[m] to me[m+1], equal formation weights (a name with no later bar is held at its last finite close, as
 * holdRet). Day return = change in long-leg value minus change in short-leg value on the month's starting capital (the month's days sum
 * exactly to the sealed gross). Cost 0.8%/month (20 bps per side per leg, full turnover) = 0.4% on the first holding session (entry) and
 * 0.4% on the last (exit).
 *
 * Reproduction: plain t over months (tOf, verbatim) of the monthly sums of the emitted daily series, primary window 2020-01..2026-08.
 */
const fs = require("fs"), path = require("path");
const { writeEntry } = require("../lib-entry.js");
const D = (f) => path.join(__dirname, "..", "..", "data", f), PANEL = D("anomaly-cache-v2");
const SEALED = JSON.parse(fs.readFileSync(D("r194-turnover-momentum.json"), "utf8"));

// ── verbatim lines 47-57 ─────────────────────────────────────────────────────────────────────────────────────────────────
const meta = JSON.parse(fs.readFileSync(path.join(PANEL, "meta.json"), "utf8")), DATES = meta.dates, SYMS = meta.symbols, T = DATES.length, N = SYMS.length;
const rd = (f) => { const b = fs.readFileSync(path.join(PANEL, f)); return new Float32Array(b.buffer, b.byteOffset, N * T); };
const C = rd("close.f32"), V = rd("vol.f32");
const c = (s, t) => C[s * T + t];
const MIN_DV = 25e6, COST_LS = 4 * 0.002, LAST_HOLD = "2026-08", FIRST_HOLD = "2017-01", PRIMARY = ["2020-01", "2026-08"], PAPER = ["2017-01", "2019-12"];
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length > 2 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : NaN);
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function sortKeyed(items, val, seed) { const rng = mulberry(seed); const k = items.map((x) => ({ x, v: val(x), r: rng() })); k.sort((a, b) => a.v - b.v || a.r - b.r); return k.map((z) => z.x); }

// ── verbatim lines 60-91 ─────────────────────────────────────────────────────────────────────────────────────────────────
const monthOf = (t) => DATES[t].slice(0, 7), MONTHS = [], ME = [];
for (let t = 0; t < T; t++) { const m = monthOf(t); if (t === T - 1 || monthOf(t + 1) !== m) { if (m <= LAST_HOLD) { MONTHS.push(m); ME.push(t); } } }
const MS = [0]; for (let i = 0; i < ME.length - 1; i++) MS.push(ME[i] + 1);    // first session index of each month
const NM = MONTHS.length;
const dvSum = new Float64Array(N * NM), dvCnt = new Int32Array(N * NM);
for (let s = 0; s < N; s++) for (let mi = 0; mi < NM; mi++) { let S = 0, K = 0; for (let t = MS[mi]; t <= ME[mi]; t++) { const x = c(s, t) * V[s * T + t]; if (c(s, t) > 0 && Number.isFinite(x)) { S += x; K++; } } dvSum[s * NM + mi] = S; dvCnt[s * NM + mi] = K; }
function median20(s, t) { const a = []; for (let k = t - 19; k <= t; k++) { if (k < 0) continue; const cl = c(s, k), x = cl * V[s * T + k]; if (cl > 0 && Number.isFinite(x)) a.push(x); } if (a.length < 15) return NaN; a.sort((x, y) => x - y); return a[a.length >> 1]; }
function formation(mi) {
  const t = ME[mi], out = [];
  for (let s = 0; s < N; s++) {
    const c1 = c(s, t), c0 = c(s, ME[mi - 1]); if (!(c1 > 0) || !(c0 > 0)) continue;
    if (!(median20(s, t) >= MIN_DV)) continue;
    const cm = dvCnt[s * NM + mi]; if (cm < 15) continue;
    let S = 0, K = 0; for (let j = Math.max(0, mi - 12); j < mi; j++) { S += dvSum[s * NM + j]; K += dvCnt[s * NM + j]; }
    if (K < 200 || !(S > 0)) continue;
    out.push({ s, turn: (dvSum[s * NM + mi] / cm) / (S / K), r1: c1 / c0 - 1 });
  }
  return out;
}
function holdRet(s, mi) { const p0 = c(s, ME[mi]); let last = p0, cut = false; for (let t = ME[mi] + 1; t <= ME[mi + 1]; t++) { const x = c(s, t); if (x > 0) last = x; else cut = true; } const end = c(s, ME[mi + 1]); return { r: (end > 0 ? end : last) / p0 - 1, cut: !(end > 0) || cut }; }
const firstF = MONTHS.indexOf(FIRST_HOLD) - 1;
const F = []; for (let mi = firstF; mi < NM - 1; mi++) {
  const U = formation(mi), n = U.length, dec = Math.floor(n / 10);
  const byTurn = sortKeyed(U, (x) => x.turn, 194000 + mi);
  const hi = byTurn.slice(n - dec), lo = byTurn.slice(0, dec);
  const legs = (grp, seed) => { const k = grp.length, q = Math.floor(k / 10), srt = sortKeyed(grp, (x) => x.r1, seed); return { k, q, long: srt.slice(k - q).map((x) => x.s), short: srt.slice(0, q).map((x) => x.s) }; };
  F.push({ mi, hold: MONTHS[mi + 1], n, U, hi: legs(hi, 195000 + mi), lo: legs(lo, 196000 + mi), hiSet: hi.map((x) => x.s), loSet: lo.map((x) => x.s) });
}
// ── verbatim lines 99-108 ────────────────────────────────────────────────────────────────────────────────────────────────
let cutCount = 0, holdCount = 0;
function legSeries(which) {
  return F.map((f) => { const L = f[which]; const rl = L.long.map((s) => holdRet(s, f.mi)), rs = L.short.map((s) => holdRet(s, f.mi));
    if (which === "hi") { holdCount += rl.length + rs.length; cutCount += rl.filter((x) => x.cut).length + rs.filter((x) => x.cut).length; }
    const Rl = mean(rl.map((x) => x.r)), Rs = mean(rs.map((x) => x.r)); return { hold: f.hold, long: Rl, short: Rs, gross: Rl - Rs, net: Rl - Rs - COST_LS, q: L.q }; });
}
const inW = (w) => (x) => x.hold >= w[0] && x.hold <= w[1];
function summ(rows) { const net = rows.map((x) => x.net), gross = rows.map((x) => x.gross);
  return { months: rows.length, window: [rows[0].hold, rows[rows.length - 1].hold], netMeanPct: +(100 * mean(net)).toFixed(3), netT: +tOf(net).toFixed(3), grossMeanPct: +(100 * mean(gross)).toFixed(3), grossT: +tOf(gross).toFixed(3),
    longMeanPct: +(100 * mean(rows.map((x) => x.long))).toFixed(3), shortMeanPct: +(100 * mean(rows.map((x) => x.short))).toFixed(3), netWinPct: +(100 * net.filter((x) => x > 0).length / net.length).toFixed(1), meanNamesPerLeg: +mean(rows.map((x) => x.q)).toFixed(1) }; }
const HI = legSeries("hi"), prim = summ(HI.filter(inW(PRIMARY))), paper = summ(HI.filter(inW(PAPER)));

// ── emitter: buy-and-hold daily book per holding month ────────────────────────────────────────────────────────────────────
const series = [], byHold = new Map();
for (const f of F) {
  const t0 = ME[f.mi], t1 = ME[f.mi + 1], L = f.hi.long, S = f.hi.short;
  const legVal = (grp) => { const base = grp.map((s) => c(s, t0)), last = base.slice(), out = [];
    for (let d = t0 + 1; d <= t1; d++) { let val = 0; for (let i = 0; i < grp.length; i++) { const x = c(grp[i], d); if (x > 0) last[i] = x; val += last[i] / base[i]; } out.push(val / grp.length); } return out; };
  const gl = legVal(L), gs = legVal(S), nd = gl.length; let sum = 0;
  for (let j = 0; j < nd; j++) { let r = (gl[j] - (j ? gl[j - 1] : 1)) - (gs[j] - (j ? gs[j - 1] : 1)); if (j === 0) r -= COST_LS / 2; if (j === nd - 1) r -= COST_LS / 2; series.push({ d: DATES[t0 + 1 + j], r }); sum += r; }
  byHold.set(f.hold, sum);
}
const netIn = (w) => [...byHold.entries()].filter(([h]) => h >= w[0] && h <= w[1]).map(([, v]) => v);
const ePrim = netIn(PRIMARY), ePaper = netIn(PAPER), tPrim = +tOf(ePrim).toFixed(3), tPaper = +tOf(ePaper).toFixed(3);
const maxDiff = Math.max(...HI.map((x) => Math.abs(x.net - byHold.get(x.hold))));
const sP = SEALED.primary, sPa = SEALED.paperSample2017_2019;
const match = Math.abs(tPrim - sP.netT) <= 0.02 && ePrim.length === sP.months;
writeEntry({
  id: "R194", name: "Short-term momentum in high-turnover stocks (1-month winners minus losers, top turnover decile)", registryId: "R194",
  script: "backend/r194-turnover-momentum.js", emitter: "backend/ensemble/emit/r194.js", unit: "daily", net: true,
  costModel: "20 bps per side per leg, full turnover every month (0.8%/month on the long-short): 0.4% on the first holding session, 0.4% on the last, as sealed",
  window: [DATES[ME[F[0].mi] + 1], DATES[ME[F[F.length - 1].mi + 1]]], calendar: "us-equity", series,
  reproduction: { statistic: "plain t over months of net long-short, primary window 2020-01..2026-08 (netT)", sealed: sP.netT, emitted: tPrim, tolerance: 0.02, match },
  construction: "Each month-end the top turnover decile (formation-month mean daily $vol / trailing-12-month mean) is split by 1-month return; the top tenth is bought and the bottom tenth "
    + "shorted at the close, equal weight, buy-and-hold to the next month-end close; the day's return is the long leg's value change minus the short leg's on the month's starting "
    + "capital, with half the 0.8% monthly round trip on the first and half on the last holding session.",
  notes: `Primary 2020-01..2026-08: ${ePrim.length} months, emitted net t ${tPrim} (sealed ${sP.netT}), mean ${(100 * mean(ePrim)).toFixed(3)}%/mo (sealed ${sP.netMeanPct}). `
    + `Paper sample 2017-01..2019-12 (reported, not in the verdict): emitted t ${tPaper} (sealed ${sPa.netT}). Verbatim-legSeries recompute: primary t ${prim.netT}, paper t ${paper.netT}; `
    + `max |monthly net - sum of emitted days| ${maxDiff.toExponential(2)}. The series covers all ${F.length} sealed holding months (2017-01..2026-08); the verdict read only the primary 80. `
    + `${cutCount} of ${holdCount} holdings were cut short (no bar at month-end) and held at their last close, as sealed. Daily returns are on the month's starting capital.`,
});
