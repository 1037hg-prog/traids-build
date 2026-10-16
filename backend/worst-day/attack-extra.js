#!/usr/bin/env node
"use strict";
/**
 * WORST-DAY ATTACK, part 4: discrimination with the two crises removed, and pooled-versus-causal cut-offs. Read-only; writes
 * backend/data/worst-day/attack-extra.json (atomic).   node backend/worst-day/attack-extra.js
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const L = require("./lib.js"), W = require("./wf.js");
const OUT = path.join(__dirname, "..", "data", "worst-day", "attack-extra.json");
const r2 = (x) => (Number.isFinite(x) ? +x.toFixed(2) : null);
const ctx = W.makeCtx(), { D, O, K } = ctx, Y = W.labelsO(ctx, D.y), tYear = ctx.tYear;
const base = W.walk(ctx, D.X, ctx.yArr);
const absR = new Float64Array(D.n).fill(NaN); for (let i = 1; i < D.n; i++) absR[i] = Math.abs(D.r[i]);
const F = { a: Uint8Array.from(O, (i) => (D.flagA[i] === 1 ? 1 : 0)) };
for (const m of ["b", "c", "v"]) F[m] = Uint8Array.from(O, (i, k) => (base.scoreO[m][k] >= base.THR[m][tYear(i)] ? 1 : 0));
F.w = Uint8Array.from(O, (i) => { const w = []; for (let k = i - 1259; k <= i; k++) w.push(absR[k]); return absR[i] >= L.qHigh(w, 0.10) ? 1 : 0; });
const P = {}; for (const m of ["b", "c", "v"]) P[m] = W.evalScore(ctx, base.scoreO[m], Y).flag;     // headline pooled top-decile flags
const tgtDate = O.map((i) => D.d[i + 1]);
const subsets = {
  all: () => true,
  "ex 2008 and March 2020": (k) => !(tgtDate[k].startsWith("2008") || tgtDate[k].startsWith("2020-03")),
  "ex calendar 2008 and 2020": (k) => !(tgtDate[k].startsWith("2008") || tgtDate[k].startsWith("2020")),
  "2008 and March 2020 only": (k) => tgtDate[k].startsWith("2008") || tgtDate[k].startsWith("2020-03"),
};
const out = { spec: "worst-day-attack-extra-v1", asOf: new Date().toISOString(), command: "node backend/worst-day/attack-extra.js", status: "IN-SAMPLE / WALK-FORWARD EXPLORATORY", causalFlagsDiscrimination: {}, pooledTopDecileDiscrimination: {} };
function tab(flagMap, label, target) {
  for (const [sn, keep] of Object.entries(subsets)) {
    const row = {};
    for (const [m, f] of Object.entries(flagMap)) { let N = 0, Wd = 0, Fl = 0, C = 0; for (let k = 0; k < K; k++) { if (!keep(k)) continue; N++; if (Y[k]) Wd++; if (f[k]) { Fl++; if (Y[k]) C++; } } row[m] = { days: N, worstDays: Wd, flagged: Fl, caught: C, flaggedPct: r2(100 * Fl / N), sharePct: r2(100 * C / Wd), hitPct: r2(100 * C / Fl), baseRatePct: r2(100 * Wd / N) }; }
    target[sn] = row;
  }
  console.log(label); for (const [sn, row] of Object.entries(target)) console.log("  " + sn.padEnd(28), Object.entries(row).map(([m, v]) => `${m}: ${v.sharePct}/${v.hitPct} (fl ${v.flaggedPct}%, W${v.worstDays})`).join("  "));
}
tab(F, "CAUSAL flags (rule a; b/c/v = January training cutoff; w = |r| top decile): share caught / hit", out.causalFlagsDiscrimination);
tab(P, "POOLED top-decile flags (the headline convention): share caught / hit", out.pooledTopDecileDiscrimination);
writeJsonAtomic(OUT, out); console.log("wrote", OUT);
