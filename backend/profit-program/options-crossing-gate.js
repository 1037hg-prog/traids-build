#!/usr/bin/env node
"use strict";
/**
 * CROSSING-SHARE GATE — would a tighter cap on (mid credit - cross credit) / mid credit than the sleeves' 35% have helped? (read-only,
 * EXPLORATORY, live ledger rows only: the archive's crossing is borrowed so it cannot say anything about this.) Net $ per contract-wing
 * by the share of the mid credit given up crossing, R25 (245 wings) and R21 held to expiry (581 wings), session-clustered difference vs rest.
 * 5 buckets per sleeve, 10 cells; best-of-20 null bar printed. A cell is only believed if it clears the bar.
 *   node backend/profit-program/options-crossing-gate.js
 * Writes backend/data/profit-program/options-crossing-gate.json
 */
const C = require("./_opt-common.js");
const { nullBar } = require("../lib/null-bar.js");
const { $, f } = C;
const L = C.ledger();
const edges = [0.05, 0.10, 0.15, 0.25], lab = ["<5%", "5-10%", "10-15%", "15-25%", ">=25%"];
const out = { note: "exploratory", sleeves: {} };
let maxAbs = 0, nCells = 0, sessMin = Infinity;
for (const [name, T] of [["R25 (all 245 wings)", L.signals.filter(C.isR25)], ["R21 held to expiry (581 wings)", L.signals.filter((t) => C.isR21(t) && t.reason === "expiry")]]) {
  const rows = T.map((t) => ({ day: C.etDay(t.openedAt), cs: (t.obs.creditMid - t.obs.creditCross) / t.obs.creditMid, mid: t.obs.creditMid, y: t.pnl / (t.contracts || 1) }));
  const bk = (r) => (r.cs < edges[0] ? 0 : r.cs < edges[1] ? 1 : r.cs < edges[2] ? 2 : r.cs < edges[3] ? 3 : 4);
  console.log(`\n== ${name}: crossing as a share of the mid credit`);
  console.log(`${"bucket".padEnd(8)} ${"n".padStart(4)} ${"net $/wing".padStart(11)} ${"vs rest".padStart(8)} ${"t".padStart(6)} ${"mean mid cr".padStart(12)}`);
  out.sleeves[name] = [];
  sessMin = Math.min(sessMin, new Set(rows.map((r) => r.day)).size);
  for (let b = 0; b < 5; b++) {
    const B_ = rows.filter((r) => bk(r) === b); if (!B_.length) continue;
    const d = C.clusterDiff(rows, (r) => bk(r) === b, (r) => r.y, (r) => r.day);
    console.log(`${lab[b].padEnd(8)} ${String(B_.length).padStart(4)} ${$(C.mean(B_.map((r) => r.y))).padStart(11)} ${$(d.diff).padStart(8)} ${f(d.t).padStart(6)} ${f(C.mean(B_.map((r) => r.mid)), 3).padStart(12)}`);
    out.sleeves[name].push({ bucket: lab[b], n: B_.length, mean: C.mean(B_.map((r) => r.y)), vsRest: d.diff, t: d.t }); nCells++; if (Number.isFinite(d.t)) maxAbs = Math.max(maxAbs, Math.abs(d.t));
  }
}
const bar = nullBar({ variants: 2 * nCells, n: sessMin, trials: 20000 });
console.log(`\nmultiplicity: ${nCells} cells, two-sided -> best-of-${2 * nCells} bar at n=${sessMin} sessions p95 ${f(bar.p95)}; largest |t| ${f(maxAbs)} -> ${maxAbs > bar.p95 ? "a cell clears" : "no cell clears: the sleeves' 35% cap is not demonstrably wrong"}`);
out.multiplicity = { cells: nCells, p95: bar.p95, maxAbsT: maxAbs };
console.log("wrote " + C.writeOut("options-crossing-gate.json", out));
