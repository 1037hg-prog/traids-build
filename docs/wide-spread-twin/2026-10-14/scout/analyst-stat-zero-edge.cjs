#!/usr/bin/env node
"use strict";
/**
 * WIDE-SPREAD TWIN — SCOUT (2026-10-14). READ-ONLY, no network, writes nothing.
 * Question: why does the profit program's ANALYST statistic for B1 "pass with zero edge"?
 * The analyst statistic (backend/profit-program/board-cost.js section [6], lines 97-103) is the session-clustered t of
 *     netR = (pnl - costFull) / risk,  costFull = obs.spreadBps / 1e4 * notional
 * over the REFUSED set (stamped equity signals with spread > T). A strongly negative t reads as "refusing these adds money".
 * Here the same statistic is recomputed on the 10-10 population with the gross P&L REPLACED by zero-edge versions:
 *   Z0  gross = 0 on every ticket (pure cost term)
 *   Z1  gross R drawn from the WHOLE stamped pool within the same session (no link between spread and gross), 2,000 draws
 *   Z2  gross R = each ticket's own R minus the pool's mean R (the book's drift removed, spread link kept)
 * and the actual one, at T = 30 (the B1 line) and the other analyst thresholds.
 *   node docs/wide-spread-twin/2026-10-14/scout/analyst-stat-zero-edge.cjs
 */
const path = require("path");
const ROOT = path.join(__dirname, "..", "..", "..", "..");
const C = require(path.join(ROOT, "backend", "profit-program", "_common.js"));
const { clusterT, mean, sum } = C;
const ASOF = Date.parse("2026-10-10T20:10:04.420Z");   // board-cost.json asOf: the population the analyst saw
const B = C.laneBoard();
const reg = B.sig.filter((t) => t._day >= C.REGIME_START && t.closedAt <= ASOF);
const eq = reg.filter((t) => t.cls === "Equity" && Number.isFinite(t._notional) && Number.isFinite(t._risk));
const stm = eq.filter((t) => t.obs && Number.isFinite(t.obs.spreadBps));
for (const t of stm) { t._spr = t.obs.spreadBps; t._cost = t._spr / 1e4 * t._notional; }
console.log(`population (closed <= board-cost asOf): equity ${eq.length} (board-cost.json says 445), stamped ${stm.length} (says 350), sessions ${new Set(stm.map((t) => t._day)).size}`);
const meanR = mean(stm.map((t) => t.pnl / t._risk));
let seed = 424242; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const byDay = new Map(); for (const t of stm) { if (!byDay.has(t._day)) byDay.set(t._day, []); byDay.get(t._day).push(t); }
for (const T of [30, 100, 60, 40, 20, 10]) {
  const W = stm.filter((t) => t._spr > T); if (W.length < 3) continue;
  const act = clusterT(W, (t) => (t.pnl - t._cost) / t._risk);
  const z0 = clusterT(W, (t) => (0 - t._cost) / t._risk);
  const z2 = clusterT(W, (t) => (t.pnl - meanR * t._risk - t._cost) / t._risk);
  const ts = [];
  for (let i = 0; i < 2000; i++) {
    const g = new Map();
    for (const t of W) { const pool = byDay.get(t._day); const q = pool[Math.floor(rnd() * pool.length)]; g.set(t, q.pnl / q._risk); }
    ts.push(clusterT(W, (t) => g.get(t) - t._cost / t._risk).t);
  }
  ts.sort((a, b) => a - b);
  const grossOnly = clusterT(W, (t) => t.pnl / t._risk);
  console.log(`T>${String(T).padStart(3)}: n ${String(W.length).padStart(3)} G ${String(act.G).padStart(2)} | ACTUAL netR ${act.mean.toFixed(4)} t ${act.t.toFixed(2)} | gross R alone ${grossOnly.mean.toFixed(4)} t ${grossOnly.t.toFixed(2)} | Z0 cost only ${z0.mean.toFixed(4)} t ${z0.t.toFixed(2)} | Z2 drift removed t ${z2.t.toFixed(2)} | Z1 within-session gross shuffle: median t ${ts[1000].toFixed(2)}, share t <= -2: ${(ts.filter((v) => v <= -2).length / ts.length * 100).toFixed(1)}%`);
}
console.log(`pool mean gross R per ticket ${meanR.toFixed(4)}; mean cost in R on the >30 set ${mean(stm.filter((t) => t._spr > 30).map((t) => t._cost / t._risk)).toFixed(4)}`);
