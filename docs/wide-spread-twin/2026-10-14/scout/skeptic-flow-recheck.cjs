#!/usr/bin/env node
"use strict";
/**
 * WIDE-SPREAD TWIN — SCOUT (2026-10-14). READ-ONLY, no network, writes nothing.
 * Re-prints, on the population the profit program saw (closed <= board-cost.json asOf 2026-10-10T20:10Z), the skeptic's
 * section [B] decomposition (backend/profit-program/skeptic-board.js lines 76-89) and section [F] flow (lines 144-148) for the > 30 bps set,
 * and the same split at 30-100 (excluding > 100, which R49 already refuses), so the draft can see where "$750/month" and "85%" come from.
 *   node docs/wide-spread-twin/2026-10-14/scout/skeptic-flow-recheck.cjs
 */
const path = require("path");
const ROOT = path.join(__dirname, "..", "..", "..", "..");
const C = require(path.join(ROOT, "backend", "profit-program", "_common.js"));
const { $, sum } = C;
const ASOF = Date.parse("2026-10-10T20:10:04.420Z"), MONTH = 21;
const B = C.laneBoard();
const eq = B.sig.filter((t) => t._day >= C.REGIME_START && t.closedAt <= ASOF && t.cls === "Equity" && Number.isFinite(t._notional) && Number.isFinite(t._risk));
const stm = eq.filter((t) => t.obs && Number.isFinite(t.obs.spreadBps)); for (const t of stm) { t._spr = t.obs.spreadBps; t._c = t._spr / 1e4 * t._notional; }
const decomp = (lab, pool, inW) => {
  const W = pool.filter(inW), k = W.length / pool.length, sl = new Set(pool.map((t) => t._day)).size;
  const gW = sum(W.map((t) => t.pnl)), cW = sum(W.map((t) => t._c)), gA = sum(pool.map((t) => t.pnl)), cA = sum(pool.map((t) => t._c));
  const costEx = cW - k * cA, grossEx = -(gW - k * gA);
  console.log(`${lab}: pool ${pool.length}/${sl} sessions, refused ${W.length}; excess over random ${$(costEx + grossEx)} = cost part ${$(costEx)} (${(costEx / (costEx + grossEx) * 100).toFixed(0)}%) + gross part ${$(grossEx)}; per month: excess ${$((costEx + grossEx) / sl * MONTH)}, cost avoided full ${$(cW / sl * MONTH)}, half ${$(cW / 2 / sl * MONTH)}, gross avoided ${$(-gW / sl * MONTH)}`);
};
for (const [lab, inW] of [["> 30 bps", (t) => t._spr > 30], ["30-100 bps", (t) => t._spr >= 30 && t._spr <= 100]]) {
  console.log(`\n== ${lab}`);
  decomp("  regime window (closed >= 2026-08-25)", stm, inW);
  decomp("  after cost-aware sizing (closed >= 2026-09-04)", stm.filter((t) => t._day >= "2026-09-04"), inW);
  decomp("  current policy mix (closed >= 2026-09-25)", stm.filter((t) => t._day >= "2026-09-25"), inW);
  for (const d0 of ["2026-08-25", "2026-09-04", "2026-09-25", "2026-10-05"]) {
    const all = eq.filter((t) => t._day >= d0), W = all.filter((t) => t.obs && Number.isFinite(t.obs.spreadBps) && inW(t)), sl = new Set(all.map((t) => t._day)).size;
    console.log(`  [F] closed >= ${d0}: ${all.length} equity / ${sl} sessions; in band ${W.length} (${(W.length / sl).toFixed(2)}/session -> ${Math.ceil(150 / (W.length / sl))} sessions to 150): cost full/month ${$(sum(W.map((t) => t._c)) / sl * MONTH)}, half ${$(sum(W.map((t) => t._c)) / 2 / sl * MONTH)}, gross avoided/month ${$(-sum(W.map((t) => t.pnl)) / sl * MONTH)}`);
  }
}
