#!/usr/bin/env node
"use strict";
/**
 * EMITTER R169 — ETF_TSMOM: 16-ETF time-series momentum, TIMING ONLY (vol-scaled sign portfolio minus the same portfolio always-long).
 * READ-ONLY.
 *
 * backend/hunt/ETF_TSMOM.js guards its main (`if (require.main === module)`, line 272) and exports run/weightsAt/holdReturn/monthEnds/
 * truncate/nwT (line 268), so the rule is IMPORTED. loadPanel (lines 194-197) is not exported and is COPIED; it reads the script's own
 * sealed daily panel cache backend/data/hunt/ETF_TSMOM-bars.json (read-only), exactly as --discovery / --holdout did.
 *
 * Daily series: per holding month the spread position is d_i = w_i - b_i = (sign_i - 1) * scale_i / N (only the ETFs flagged negative
 * carry weight, -2 * scale_i / N), entered at the OPEN of the session after formation and held to the OPEN of the session after the next
 * month-end (the window's last close for the final period) — the script's own weights and hold. Marked daily on unit starting capital:
 * entry day open->close, then close->close, exit day prior close->open; the spread's rebalance cost COST*(turnTS - turnBM) (the
 * script's net-leg difference) is charged on the entry day. Each day's P&L is divided by the period's running capital so a period's
 * days compound exactly to the script's monthly net; the exit (overnight) and the next entry (intraday) share a date and are chained.
 */
const fs = require("fs"), path = require("path");
const { run, weightsAt, holdReturn, monthEnds, truncate, nwT } = require("../../hunt/ETF_TSMOM.js");
const { writeEntry } = require("../lib-entry.js");

const COST = 0.0005;   // ETF_TSMOM.js line 69
const DISC = ["2017-01-01", "2021-12-31"], HOLD = ["2022-01-01", "2026-09-22"];   // line 68
// ---- copied from backend/hunt/ETF_TSMOM.js lines 194-197 ----
const CACHE = path.join(__dirname, "..", "..", "data", "hunt", "ETF_TSMOM-bars.json");
function loadPanel() {
  const j = JSON.parse(fs.readFileSync(CACHE, "utf8")), nz = (a) => a.map((x) => (x == null ? NaN : x));
  return { syms: j.syms, dates: j.dates, O: j.syms.map((s) => nz(j.O[s])), C: j.syms.map((s) => nz(j.C[s])) };
}
// ---- end copy ----

// daily pieces for one window, mirroring run()'s loop (lines 120-143) to recover the formation index of every holding month
function dailyFor(P, fromYm, toYm) {
  const rows = run(P, fromYm, toYm), byYm = new Map(rows.map((x) => [x.ym, x]));
  const me = monthEnds(P.dates), T = P.dates.length, pieces = [], periodCheck = []; let fallbacks = 0;
  for (let mi = 0; mi < me.length; mi++) {
    const t = me[mi]; if (t + 1 > T - 1) break;
    const ym = P.dates[t + 1].slice(0, 7); if (ym > toYm) break;
    const W = weightsAt(P, me, mi); if (!W.size) continue;
    if (ym < fromYm) continue;
    const row = byYm.get(ym); if (!row) throw new Error(`run() has no row for ${ym}`);
    const tNext = mi + 1 < me.length ? me[mi + 1] : T - 1, N = W.size, e = t + 1, x = tNext + 1;
    const d = new Map(); for (const [i, v] of W) d.set(i, (v.sign - 1) * v.scale / N);
    for (const i of W.keys()) { const info = {}; holdReturn(P, i, t, tNext, info); if (info.entrySrc !== "open" || !(info.exitSrc === "open" || info.exitSrc === "lastClose")) fallbacks++; }
    const O = (i, k) => P.O[i][k], C = (i, k) => P.C[i][k];
    const pnl = (fn) => { let s = 0; for (const [i, w] of d) if (w) s += w * fn(i); return s; };
    const cost = COST * (row.turnTS - row.turnBM);
    const lastK = x <= T - 1 ? x - 1 : T - 1;
    const steps = [{ k: e, p: pnl((i) => C(i, e) / O(i, e) - 1) - cost }];
    for (let k = e + 1; k <= lastK; k++) steps.push({ k, p: pnl((i) => (C(i, k) - C(i, k - 1)) / O(i, e)) });
    if (x <= T - 1) steps.push({ k: x, p: pnl((i) => (O(i, x) - C(i, x - 1)) / O(i, e)) });
    let cap = 1; const active = [...d.values()].some((w) => w !== 0);
    for (const s of steps) { const r = s.p / cap; cap += s.p; if (active || s.p !== 0) pieces.push({ d: P.dates[s.k], r }); }
    periodCheck.push(Math.abs((cap - 1) - row.net));
  }
  return { rows, pieces, maxDiff: Math.max(...periodCheck), fallbacks };
}

(() => {
  const full = loadPanel();
  const D = dailyFor(truncate(full, DISC[1]), DISC[0].slice(0, 7), DISC[1].slice(0, 7));
  const H = dailyFor(truncate(full, HOLD[1]), HOLD[0].slice(0, 7), HOLD[1].slice(0, 7));
  const tD = nwT(D.rows.map((x) => x.net)), tH = nwT(H.rows.map((x) => x.net));
  const byD = new Map(); for (const p of [...D.pieces, ...H.pieces]) byD.set(p.d, byD.has(p.d) ? (1 + byD.get(p.d)) * (1 + p.r) - 1 : p.r);
  const series = [...byD.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, r]) => ({ d, r }));
  console.log(`R169: discovery ${D.rows.length} months tNW ${tD} · holdout ${H.rows.length} months tNW ${tH} · per-period |compound - script net| max ${Math.max(D.maxDiff, H.maxDiff).toExponential(2)} · fallbacks ${D.fallbacks + H.fallbacks} · ${series.length} days`);
  const eH = +tH.toFixed(3), eD = +tD.toFixed(3), sealH = -0.425, sealD = -1.328, tol = 0.02;
  writeEntry({
    id: "R169", name: "ETF time-series momentum (timing)", registryId: "R169", script: "backend/hunt/ETF_TSMOM.js", emitter: "backend/ensemble/emit/r169.js",
    unit: "daily", net: true, costModel: "0.05% x turnover per monthly rebalance on each leg; spread cost = 0.05% x (TSMOM turnover - benchmark turnover), charged on the entry day",
    window: [series[0].d, HOLD[1]], calendar: "us-equity", series,
    reproduction: { statistic: "holdout net NW t (lag 3) of the monthly TSMOM-minus-always-long spread", sealed: sealH, emitted: eH, tolerance: tol, match: Math.abs(eH - sealH) <= tol && Math.abs(eD - sealD) <= tol,
      discovery: { sealed: sealD, emitted: eD, match: Math.abs(eD - sealD) <= tol } },
    construction: "Each month the spread holds -2*scale_i/N in every ETF whose 12-month return is negative (TSMOM weights minus always-long weights), open(t+1) to the open after the next month-end, marked daily on the period's capital (open->close, close->close, close->open) with the net rebalance-cost difference on the entry day; discovery (2017-02..2021-12) and holdout (2022-01..2026-09-22) periods from the sealed panel, chained.",
    notes: `Series is the timing spread (a net-short book in downtrend ETFs), not the TSMOM portfolio. Each period's days compound to the script's monthly net within ${Math.max(D.maxDiff, H.maxDiff).toExponential(1)}. Price fallbacks used: ${D.fallbacks + H.fallbacks}. Cost difference can be a small credit in months where benchmark turnover exceeds TSMOM turnover (script definition).`,
  });
})();
