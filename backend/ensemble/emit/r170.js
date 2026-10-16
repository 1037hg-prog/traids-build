#!/usr/bin/env node
"use strict";
/**
 * EMITTER — R170 salience-theory (ST) quintile long-short (backend/hunt/SALIENCE.js) -> library entry R170.
 *
 * SALIENCE.js is require()-safe (main guarded by `require.main === module`, line 263; header line 52); prepare / formAt / holdReturn /
 * monthEnds / summarize are imported. loadPanel (lines 80-84) is copied (not exported). run() (lines 145-164) is re-driven below so the leg
 * memberships are visible; its holdout-token guard is replaced by running the two sealed windows separately, exactly as --discovery and
 * --holdout did on the full panel (each window's first month pays the full build, turnover 2, as sealed).
 *
 * DAILY series (fixed formation weights, buy-and-hold within the month): LONG lowest-ST quintile, SHORT highest, equal weight at formation t;
 * each name enters at its first open after t (holdReturn) and its value path is v_k = lastClose_k / entryOpen (1 before entry; a name that
 * stops trading is held at its last close). Day k's P&L on $1 of capital = mean_L(v_k - v_{k-1}) - mean_S(v_k - v_{k-1}), so the month's
 * daily sum = the sealed gross spread exactly. Cost 0.25% x turnover is booked on day t+1 (the entry open).
 */
const fs = require("fs"), path = require("path");
const SAL = require("../../hunt/SALIENCE.js");
const { writeEntry } = require("../lib-entry.js");
const DATA = path.join(__dirname, "..", "..", "data"), DIR = path.join(DATA, "anomaly-cache-v2");
const COST = 0.0025, DISC = ["2017-01", "2021-12"], HOLD = ["2022-01", "2026-09"];   // lines 60-61
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function loadPanel() {   // lines 80-84
  const meta = JSON.parse(fs.readFileSync(path.join(DIR, "meta.json"), "utf8")), T = meta.dates.length, N = meta.symbols.length;
  const rd = (f) => { const b = fs.readFileSync(path.join(DIR, f)); return new Float32Array(b.buffer, b.byteOffset, N * T); };
  return { meta, T, N, C: rd("close.f32"), O: rd("open.f32"), V: rd("vol.f32"), real: true };
}

const Q = SAL.prepare(loadPanel()), dates = Q.meta.dates, me = SAL.monthEnds(dates), day = new Float64Array(Q.T), touched = new Uint8Array(Q.T);
function legPath(s, t0, t1, w) {   // mirrors holdReturn (lines 136-142, real-panel branch)
  const o = s * Q.T; let entry = NaN, k0 = t0;
  for (let k = t0 + 1; k <= t1; k++) if (Q.O[o + k] > 0) { entry = Q.O[o + k]; k0 = k - 1; break; }
  let last = NaN, prev = 1;
  for (let k = k0 + 1; k <= t1; k++) { const x = Q.Cx[o + k]; if (x > 0) last = x; const v = last > 0 ? last / entry : 1; day[k] += w * (v - prev); prev = v; touched[k] = 1; }
}
function runWindow(fromYm, toYm) {   // run() lines 148-162 with the legs exposed
  const rows = []; let prev = null;
  for (let mi = 0; mi < me.length - 1; mi++) {
    const t = me[mi], t1 = me[mi + 1], ym = dates[t1].slice(0, 7); if (ym < fromYm || ym > toYm) continue;
    const U = SAL.formAt(Q, t), fwd = new Map(U.map((u) => [u.s, SAL.holdReturn(Q, u.s, t, t1)]));
    const xs = U.filter((u) => Number.isFinite(fwd.get(u.s)) && Number.isFinite(u.st)).map((u) => ({ s: u.s, v: u.st }));
    if (xs.length < 100) continue;
    xs.sort((a, b) => a.v - b.v); const q = Math.floor(xs.length / 5), L = xs.slice(0, q), S = xs.slice(xs.length - q);
    const avg = (g) => mean(g.map((x) => fwd.get(x.s))), gross = avg(L) - avg(S);
    const turn = prev ? (L.filter((x) => !prev.L.has(x.s)).length / L.length + S.filter((x) => !prev.S.has(x.s)).length / S.length) : 2;
    prev = { L: new Set(L.map((x) => x.s)), S: new Set(S.map((x) => x.s)) };
    rows.push({ ym, gross, net: gross - COST * turn, turn, n: xs.length, t, t1 });
    for (const x of L) legPath(x.s, t, t1, 1 / L.length); for (const x of S) legPath(x.s, t, t1, -1 / S.length);
    day[t + 1] -= COST * turn; touched[t + 1] = 1;
    process.stdout.write(`  R170 ${ym}\r`);
  }
  return rows;
}
const rowsD = runWindow(...DISC), rowsH = runWindow(...HOLD); process.stdout.write("\n");
const sD = SAL.summarize(rowsD), sH = SAL.summarize(rowsH);
const sealD = JSON.parse(fs.readFileSync(path.join(DATA, "hunt", "SALIENCE-discovery.json"), "utf8")).result.raw;
const sealH = JSON.parse(fs.readFileSync(path.join(DATA, "hunt", "SALIENCE-holdout.json"), "utf8")).result.raw;
let maxGap = 0; for (const r of [...rowsD, ...rowsH]) { let s = 0; for (let k = r.t + 1; k <= r.t1; k++) s += day[k]; maxGap = Math.max(maxGap, Math.abs(s - r.net)); }
const series = []; for (let k = 0; k < Q.T; k++) if (touched[k]) series.push({ d: dates[k], r: day[k] });
const emitted = +sH.raw.tNet.toFixed(3), sealed = +sealH.tNet.toFixed(3), eD = +sD.raw.tNet.toFixed(3), sdd = +sealD.tNet.toFixed(3);
const match = Math.abs(emitted - sealed) <= 0.02 && Math.abs(eD - sdd) <= 0.02;
console.log(`  R170 holdout tNW ${emitted} (sealed ${sealed}) · discovery ${eD} (sealed ${sdd}) · months ${rowsD.length}+${rowsH.length} · max |month daily-sum - net| ${maxGap.toExponential(2)}`);

writeEntry({
  id: "R170", name: "Salience-theory value quintile long-short", registryId: "R170", script: "backend/hunt/SALIENCE.js", emitter: "backend/ensemble/emit/r170.js",
  unit: "daily", net: true, costModel: "0.25% x (long-leg turnover + short-leg turnover) per month, booked on the first session of the holding month (entry at the open); first month of each sealed window pays a full build (turnover 2); no borrow cost",
  window: [series[0].d, series[series.length - 1].d], calendar: "us-equity", series,
  reproduction: { statistic: "holdout Newey-West t (lag 3) of the monthly NET long-short spread, 57 months 2022-01..2026-09", sealed, emitted, tolerance: 0.02, match,
    discovery: { statistic: "discovery NW t (lag 3), 60 months 2017-01..2021-12", sealed: sdd, emitted: eD } },
  construction: "Monthly EW quintile legs (long lowest ST, short highest ST, top-1,500 liquid names of anomaly-cache-v2) formed at each month-end close, each name entered at its next open and held buy-and-hold to the next month-end close; day r = mean over long names of the change in (lastClose/entryOpen) minus the same for the short leg ($1 long + $1 short per $1 capital, P&L on the month's initial capital), with 0.25% x turnover charged on the entry day.",
  notes: `Two sealed windows run separately as the script did, so the 2022-01 holdout month pays a full rebuild (turnover 2). Monthly daily-sum vs sealed net max gap ${maxGap.toExponential(2)}. Holdout net ${(100 * sH.raw.net).toFixed(3)}%/month (sealed ${(100 * sealH.net).toFixed(3)}). Verdict DID NOT PASS.`,
});
