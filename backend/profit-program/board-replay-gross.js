#!/usr/bin/env node
"use strict";
/**
 * REPLAY GROSS CHECK (profit program, sanity for lever 1/2). READ-ONLY printer. EXPLORATORY.
 * The board replay (backend/data/board-replay, built 2026-09-24 by board-replay.js: the board's own scan re-run over 2024-2026 SIP bars; entry = 09:40
 * price, GROSS of cost, today's roster applied to the past = SURVIVORSHIP, declared) is a larger gross sample than the live ledger. It answers one
 * question only: is there a gross edge per strategy that is bigger than the ~0.06R round-trip spread (board-cost.js)? Not a registered result.
 * r = the ticket's R on the live exit path; rClose = same-day last 5m close. t is cluster-robust by session (the replay date d).
 *   node backend/profit-program/board-replay-gross.js
 */
const fs = require("fs"), path = require("path");
const C = require("./_common.js");
const { f, pad, lpad, mean, sum, clusterT } = C;
const DIR = path.join(__dirname, "..", "data", "board-replay");
const rows = [];
for (const y of [2024, 2025, 2026]) {
  for (const ln of fs.readFileSync(path.join(DIR, `replay-${y}.jsonl`), "utf8").split(String.fromCharCode(10))) {
    if (!ln) continue;
    try { const r = JSON.parse(ln); if (Number.isFinite(r.r) && r.pitLiquid) rows.push({ _day: r.d, y, st: r.st, dir: r.dir, r: r.r, rClose: r.rClose, stopPct: r.stopPct }); } catch {}
  }
}
const meta = JSON.parse(fs.readFileSync(path.join(DIR, "replay-meta.json"), "utf8"));
console.log(`REPLAY GROSS CHECK — ${rows.length} point-in-time-liquid replay tickets 2024-01..2026-09 (meta: ${meta.tickets} tickets, ${meta.sessions} sessions; ${String(meta.settle).slice(0, 120)}...)`);
console.log("SURVIVORSHIP: today's roster applied to the past. GROSS: no spread in r. Compare every mean to the equity round-trip spread of about 0.06R per ticket (board-cost.js).");
console.log(`${lpad("", 26)} ${pad("n", 6)} ${pad("sessions", 8)} ${pad("mean r", 8)} ${pad("t", 6)}   ${pad("mean rClose", 11)}`);
const cell = (lab, a) => { if (a.length < 30) return; const tt = clusterT(a, (t) => t.r), tc = clusterT(a.filter((t) => Number.isFinite(t.rClose)), (t) => t.rClose); console.log(`${lpad(lab, 26)} ${pad(a.length, 6)} ${pad(tt.G, 8)} ${pad(f(tt.mean, 4), 8)} ${pad(f(tt.t, 2), 6)}   ${pad(f(tc.mean, 4), 11)}`); };
cell("ALL", rows);
for (const st of [...new Set(rows.map((r) => r.st))].sort()) {
  cell(st, rows.filter((r) => r.st === st));
  for (const y of [2024, 2025, 2026]) cell("   " + y, rows.filter((r) => r.st === st && r.y === y));
  cell("   long", rows.filter((r) => r.st === st && r.dir === 1)); cell("   short", rows.filter((r) => r.st === st && r.dir === -1));
}
console.log("\nreading: a strategy is worth running only if its gross mean r exceeds its cost R; the live ledger's equity cost is 0.063R per ticket (board-cost.js [3]). 8 strategy cells x years printed once; |t| < 2.5 is noise.");
