#!/usr/bin/env node
"use strict";
/**
 * EMITTER — R167 overnight-up/intraday-down frequency quintile long-short (backend/hunt/OVN_INTRA_FREQ.js) -> library entry R167.
 *
 * OVN_INTRA_FREQ.js is require()-safe (main guarded by `require.main === module`, line 285); prepare / signalsAt / holdReturn / monthEnds /
 * summarize are imported. loadPanel (lines 66-71) is copied (not exported). The monthly loop below is run() (lines 122-140) re-driven so the
 * leg memberships are visible; the holdout guard is replaced by running the two sealed windows separately, exactly as --discovery and
 * --holdout did (each window's first month pays the full build, turnover 2, as sealed).
 *
 * DAILY series (fixed formation weights, buy-and-hold within the month): each leg is equal-weight at the formation close t; a name's value
 * path is v_k = lastClose_k / close_t (a name that stops trading is held at its last close, as holdReturn). Day k's P&L on $1 of capital =
 * mean_L(v_k - v_{k-1}) - mean_S(v_k - v_{k-1}) — additive on the month's initial capital, so the month's daily sum = the sealed gross
 * spread exactly. Cost 0.25% x turnover is booked on the formation day t (the entry close).
 */
const fs = require("fs"), path = require("path");
const OVN = require("../../hunt/OVN_INTRA_FREQ.js");
const { writeEntry } = require("../lib-entry.js");
const DATA = path.join(__dirname, "..", "..", "data"), DIR = path.join(DATA, "anomaly-cache-v2");
const COST = 0.0025, MIN_XS = 100, SIGN = +1, DISC = ["2017-01", "2021-12"], HOLD = ["2022-01", "2026-09"];   // lines 56-57
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const tieKey = (s) => { let h = Math.imul((s + 1) ^ 0x9E3779B9, 0x85EBCA6B) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xC2B2AE35) >>> 0; return (h ^ (h >>> 16)) >>> 0; };   // line 76
function loadPanel() {   // lines 66-71 (no truncation: formation reads only <= t and holding only t..t1, so discovery rows are identical)
  const meta = JSON.parse(fs.readFileSync(path.join(DIR, "meta.json"), "utf8")), T = meta.dates.length, N = meta.symbols.length;
  const rd = (f) => { const b = fs.readFileSync(path.join(DIR, f)); if (b.length !== 4 * N * T) throw new Error(`${f}: ${b.length} bytes, expected ${4 * N * T}`); return new Float32Array(b.buffer, b.byteOffset, N * T); };
  return { meta, T, N, C: rd("close.f32"), O: rd("open.f32"), V: rd("vol.f32") };
}

const Q = OVN.prepare(loadPanel()), dates = Q.meta.dates, me = OVN.monthEnds(dates), day = new Float64Array(Q.T), touched = new Uint8Array(Q.T);
function legPath(s, t0, t1, w) {   // adds w * (v_k - v_{k-1}) for k in (t0, t1]; mirrors holdReturn (line 120)
  const o = s * Q.T, a = Q.Cx[o + t0]; let last = a, prev = 1;
  for (let k = t0 + 1; k <= t1; k++) { const x = Q.Cx[o + k]; if (x > 0) last = x; const v = last / a; day[k] += w * (v - prev); prev = v; touched[k] = 1; }
}
function runWindow(fromYm, toYm) {   // run() lines 124-139, with the legs exposed
  const a = []; let prev = null;
  for (let mi = 1; mi < me.length - 1; mi++) {
    const t = me[mi], t1 = me[mi + 1], ym = dates[t1].slice(0, 7); if (ym < fromYm || ym > toYm) continue;
    const U = OVN.signalsAt(Q, t, me[mi - 1]), fwd = new Map(U.map((u) => [u.s, OVN.holdReturn(Q, u.s, t, t1)]));
    const xs = U.map((u) => ({ s: u.s, v: u.v })).filter((x) => Number.isFinite(x.v) && Number.isFinite(fwd.get(x.s)));
    if (xs.length < MIN_XS) continue;
    xs.sort((p, q) => p.v - q.v || tieKey(p.s) - tieKey(q.s));
    const q = Math.floor(xs.length / 5), lo = xs.slice(0, q), hi = xs.slice(xs.length - q), L = SIGN > 0 ? hi : lo, S = SIGN > 0 ? lo : hi;
    const avg = (g) => mean(g.map((x) => fwd.get(x.s))), gL = avg(L), gS = avg(S), gross = gL - gS;
    const turn = prev ? (L.filter((x) => !prev.L.has(x.s)).length / L.length + S.filter((x) => !prev.S.has(x.s)).length / S.length) : 2;
    prev = { L: new Set(L.map((x) => x.s)), S: new Set(S.map((x) => x.s)) };
    a.push({ ym, gross, net: gross - COST * turn, turn, perLeg: q, longPct: gL, shortPct: gS, t, t1 });
    for (const x of L) legPath(x.s, t, t1, 1 / L.length); for (const x of S) legPath(x.s, t, t1, -1 / S.length);
    day[t] -= COST * turn; touched[t] = 1;
    process.stdout.write(`  R167 ${ym}\r`);
  }
  return a;
}
const rowsD = runWindow(...DISC), rowsH = runWindow(...HOLD); process.stdout.write("\n");
const sD = OVN.summarize(rowsD), sH = OVN.summarize(rowsH);
const sealD = JSON.parse(fs.readFileSync(path.join(DATA, "hunt", "OVN_INTRA_FREQ-discovery.json"), "utf8")).result.raw;
const sealH = JSON.parse(fs.readFileSync(path.join(DATA, "hunt", "OVN_INTRA_FREQ-holdout.json"), "utf8")).result.raw;
// internal check: each month's daily P&L sums to its gross (cost booked separately on t)
let maxGap = 0; for (const r of [...rowsD, ...rowsH]) { let s = 0; for (let k = r.t + 1; k <= r.t1; k++) s += day[k]; const costNext = [...rowsD, ...rowsH].find((z) => z.t === r.t1); s += costNext ? COST * costNext.turn : 0; maxGap = Math.max(maxGap, Math.abs(s - r.gross)); }
const series = []; for (let k = 0; k < Q.T; k++) if (touched[k]) series.push({ d: dates[k], r: day[k] });
const emitted = +sH.raw.tNW.toFixed(3), sealed = +sealH.tNW.toFixed(3), eD = +sD.raw.tNW.toFixed(3), sdd = +sealD.tNW.toFixed(3);
const match = Math.abs(emitted - sealed) <= 0.02 && Math.abs(eD - sdd) <= 0.02;
console.log(`  R167 holdout tNW ${emitted} (sealed ${sealed}) · discovery ${eD} (sealed ${sdd}) · months ${rowsD.length}+${rowsH.length} · max |daily-sum - gross| ${maxGap.toExponential(2)}`);

writeEntry({
  id: "R167", name: "Overnight-up/intraday-down frequency quintile long-short", registryId: "R167", script: "backend/hunt/OVN_INTRA_FREQ.js", emitter: "backend/ensemble/emit/r167.js",
  unit: "daily", net: true, costModel: "0.25% x (long-leg turnover + short-leg turnover) per month, booked on the formation close; first month of each sealed window pays a full build (turnover 2); no borrow cost",
  window: [series[0].d, series[series.length - 1].d], calendar: "us-equity", series,
  reproduction: { statistic: "holdout Newey-West t (lag 3) of the monthly NET long-short spread, 57 months 2022-01..2026-09", sealed, emitted, tolerance: 0.02, match,
    discovery: { statistic: "discovery NW t (lag 3), 60 months 2017-01..2021-12", sealed: sdd, emitted: eD } },
  construction: "Monthly EW quintile legs (long high FREQ, short low FREQ, top-1,500 liquid names of anomaly-cache-v2) formed at each month-end close and held buy-and-hold to the next month-end; day r = mean over long names of the change in (lastClose/formationClose) minus the same for the short leg ($1 long + $1 short per $1 capital, P&L on the month's initial capital), with 0.25% x turnover charged on the formation day.",
  notes: `Two sealed windows run separately as the script did, so the 2022-01 holdout month pays a full rebuild (turnover 2) on 2021-12-31. Monthly daily-sum vs sealed gross max gap ${maxGap.toExponential(2)}. Holdout net ${(100 * sH.raw.net).toFixed(3)}%/month (sealed ${(100 * sealH.net).toFixed(3)}). Verdict DID NOT PASS.`,
});
