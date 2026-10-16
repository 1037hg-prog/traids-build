#!/usr/bin/env node
/**
 * PROFIT FIXES A (booking correctness) — DEPLOY. 2026-10-12 (docs/profit-fixes/2026-10-12/a-booking). STAGED, applied by the main loop
 * after the close; the builder of this package never ran the apply.
 *
 *   node docs/profit-fixes/2026-10-12/a-booking/deploy.cjs --plan                 read-only: each file's state (base / applied / drift),
 *                                                                                  what would change, and whether an apply would pass now
 *   node docs/profit-fixes/2026-10-12/a-booking/deploy.cjs --apply                apply every file that reads base
 *   node docs/profit-fixes/2026-10-12/a-booking/deploy.cjs --apply --only 4.1,4.3 only the files of the named fixes (4.1 4.2 4.3 4.7;
 *                                                                                  backend/options-settle.js carries 4.2 and 4.7 together)
 *
 * The seven files and their fixes are listed in lib.cjs (ENTRIES); the edits themselves are staged/<path>.edits — anchored one-line or
 * block replacements, never a whole copy of a file. In order (any refusal before the first write changes NOTHING, exit 2):
 *   1. every selected file is read; one that is neither base nor applied is DRIFT and refuses the run; an applied file is skipped
 *   2. every new text is built in memory and checked: it must read as applied, revert to the original bytes, and pass node --check
 *   3. the fences (lib.cjs): a trading weekday 05:30-16:00 MT; 13:50-15:50 MT for a registry or chain file; a .bat outside :20-:50
 *      unless 18:00 MT or later; a running process that runs or launches a file being edited (an unreadable process list refuses);
 *      backend/options-settle.js while any of the twelve expired spreads is still open (the one-time settle goes first);
 *      and the close chain's own record (backend/data/chain-status.json): a process the Task Scheduler launched shows no command line
 *      here, so the two files the chain runs are refused until that record shows the chain of the most recent session finished, and
 *      every other file that has a runner is refused when a process cannot be read unless the record shows the same. --plan prints
 *      how many node/cmd processes could not be read and what the record says
 *   4. a byte-exact copy of each file is taken (backups/<stamp>-apply/), the files and the fences are checked once more, then each file
 *      is written (temp file + rename), verified by sha, and node --check'ed; a failure puts every written file back (exit 1)
 *   5. deploy-state.json records each file's sha before and after; deploy-log.jsonl gets one row
 * It prints what it did. It starts, stops and restarts nothing, places no order, sends no message, writes no JSON except its own state
 * (through backend/lib/atomic-write.js), and never loads automation/close-chain.cjs.
 */
"use strict";
const L = require("./lib.cjs");
const argv = process.argv.slice(2);
const usage = (why) => { console.error(`${why ? why + "\n" : ""}usage: deploy.cjs --plan | --apply [--only 4.1,4.2,4.3,4.7]`); process.exit(2); };
let mode = null, only = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--plan" || a === "--apply") { if (mode) usage("give --plan or --apply, once"); mode = a.slice(2); }
  else if (a === "--only") { only = String(argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean); if (!only.length) usage("--only needs fix numbers"); }
  else usage(`unknown argument ${a}`);
}
if (!mode) { console.log("no mode given — showing the plan (read-only). The apply is --apply."); mode = "plan"; }
const r = L.deploy({ mode, only });
process.exit(r.exit);
