#!/usr/bin/env node
/**
 * PROFIT FIXES A (booking correctness) — ROLLBACK, byte-exact. 2026-10-12 (docs/profit-fixes/2026-10-12/a-booking).
 *
 *   node docs/profit-fixes/2026-10-12/a-booking/rollback.cjs --plan                 read-only: what would be put back, and whether now
 *   node docs/profit-fixes/2026-10-12/a-booking/rollback.cjs --apply                put every applied file back
 *   node docs/profit-fixes/2026-10-12/a-booking/rollback.cjs --apply --only 4.3     only the files of the named fixes
 *
 * HOW IT IS BYTE-EXACT. Nothing is restored from a copy. Each replacement this package put in is found in the live file (it must be
 * there exactly once) and the anchor line(s) it replaced are put back in its place, with the line ending that was there. Before
 * anything is written the result is checked: it must read as base, re-applying to it must give back the current bytes, and it must pass
 * node --check. When the file is still exactly what the apply wrote, the result must also be the file recorded before the apply, sha
 * for sha (deploy-state.json), or the rollback refuses. When something else has edited OTHER lines of the file since the apply (the
 * board package's home step edits backend/zero-dte-sleeve.js), that edit is kept and said.
 * A file that is neither base nor applied is drift: refused, named, nothing written (its pre-apply copy is under backups/).
 * The fences are the deploy's (a trading weekday 05:30-16:00 MT, the registry / .bat windows, a running process, and the close chain's
 * own record in backend/data/chain-status.json — before 05:30 MT the session that counts is the previous one, so a package applied in
 * the evening can be taken back before the next session). A copy of each file as it is now goes to backups/<stamp>-rollback/ first.
 *
 * NOT UNDONE, by design: the one-time settle of the twelve spreads (data, with its own change-registry row); a ticket the stamp gate
 * already refused stays a shadow; a list already recorded as killed keeps its record (the old runner ignores it and books the list
 * again); new fields already written on rows and stores stay. After a rollback of backend/lib/enforcement-gates.js the board server
 * keeps the fixed gate until its next restart; the change-registry row of fix 4.3 (record-stamp-gate-row.cjs), if it was written,
 * stays, and the day the old gate is loaded again is a second change that needs its own row.
 */
"use strict";
const L = require("./lib.cjs");
const argv = process.argv.slice(2);
const usage = (why) => { console.error(`${why ? why + "\n" : ""}usage: rollback.cjs --plan | --apply [--only 4.1,4.2,4.3,4.7]`); process.exit(2); };
let mode = null, only = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--plan" || a === "--apply") { if (mode) usage("give --plan or --apply, once"); mode = a.slice(2); }
  else if (a === "--only") { only = String(argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean); if (!only.length) usage("--only needs fix numbers"); }
  else usage(`unknown argument ${a}`);
}
if (!mode) { console.log("no mode given — showing the plan (read-only). The rollback is --apply."); mode = "plan"; }
const r = L.rollback({ mode, only });
process.exit(r.exit);
