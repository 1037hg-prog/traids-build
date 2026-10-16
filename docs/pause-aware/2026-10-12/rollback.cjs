#!/usr/bin/env node
"use strict";
/**
 * PAUSE-AWARE SERVER AND MONITORS (2026-10-12) — ROLLBACK: put every applied edit back, byte-exact.
 *   node docs/pause-aware/2026-10-12/rollback.cjs --plan     READ-ONLY: what would be put back
 *   node docs/pause-aware/2026-10-12/rollback.cjs --apply    the write mode (same fences as deploy.cjs)
 * Each edit's new block is replaced by its old block, each found exactly once (anything else is DRIFT: refused whole; restore that file by
 * hand from backups/). A line changed INSIDE a block this unit inserted is drift too (the engine's marks, lib.cjs): the rollback refuses,
 * it never reports "rolled back" while part of this unit is still in a file. With nothing else changed since the apply every file returns
 * to the sha recorded before it (printed as "byte-exact: yes"). When another package has edited a different part of a file since, that edit
 * is kept and the file returns to what it would be without this unit — it is then NOT its recorded bytes: the file is named, the last line
 * says "NOT BYTE-EXACT", and the run ends exit 1 (never a quiet pass). deploy/server/own.cjs and W1's staged copy go back together, so
 * W1's own judge keeps reading them as a pair.
 * What rollback does NOT undo: nothing else was written by this unit (no data file, no registry row, no switch, nothing on the server).
 * After it the guard is gone: a paused sleeve can again be moved to the server un-paused.
 * Exit 0 every file back to its recorded bytes / nothing to do · 1 failed, or rolled back but a file is NOT its recorded bytes or does not
 * parse · 2 refused or usage · 3 rolled back but there was no record of the apply to compare with (not confirmed).
 */
const cp = require("child_process"), path = require("path");
const L = require("./lib.cjs");
const args = process.argv.slice(2), MODE = args.length === 1 && (args[0] === "--plan" || args[0] === "--apply") ? args[0] : null;
if (!MODE) { console.log("usage: node docs/pause-aware/2026-10-12/rollback.cjs --plan | --apply\nNothing was done."); process.exit(2); }
const E = L.loadEdits(), files = L.filesOf(E), P = L.plan(E), rec = (L.readState().applied || {}).files || {};
console.log(`ROLLBACK ${MODE === "--plan" ? "PLAN (nothing is written)" : ""} — pause-aware server and monitors — ${L.mtNow().dow} ${L.mtNow().date} ${L.mtNow().hms} MT`);
for (const f of P) console.log(`  ${f.rel.padEnd(44)} ${f.problem ? "PROBLEM: " + f.problem : f.state === "drift" ? "DRIFT (" + f.states.filter((x) => x.state === "drift").map((x) => x.id).join(", ") + ")" : f.state}${f.state === "applied" || f.state === "mixed" ? ` -> base${rec[f.rel] ? ` (recorded sha before the apply ${rec[f.rel].before.slice(0, 12)})` : ""}` : ""}`);
if (MODE === "--plan") { const fz = L.fences({ files }); console.log(`  fences now: ${fz.length ? "the write mode would be REFUSED:\n    - " + fz.join("\n    - ") : "clear"}\n  nothing was written.`); process.exit(0); }
const r = L.rollbackAll({ E });
if (r.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${r.why.join("\n  - ")}`); L.logRow({ script: "rollback", result: "refused", why: r.why }); process.exit(2); }
if (r.result === "noop") { console.log("nothing to roll back."); L.logRow({ script: "rollback", result: "noop" }); process.exit(0); }
if (r.result !== "rolled-back") { console.error(`ROLLBACK FAILED: ${r.why.join("; ")}${r.restored ? " — the files are as they were before this run" : " — NOT RESTORED: " + r.notRestored.join(", ")}`); L.logRow({ script: "rollback", result: "failed", why: r.why }); process.exit(1); }
// A rollback is DONE only when every file is back to the bytes recorded before the apply (lib.cjs rollbackReport). A file that is not is said
// by name and the run ends non-zero — never a quiet "rolled back".
const rep = L.rollbackReport(r.files); let bad = 0;
for (const x of rep.rows) { const c = L.isCode(x.rel) ? cp.spawnSync(process.execPath, ["--check", path.join(L.REPO, x.rel)], { encoding: "utf8", windowsHide: true }) : { status: 0 }; if (c.status !== 0) bad++; console.log(`  restored ${x.rel.padEnd(44)} sha ${x.sha.slice(0, 12)}   byte-exact: ${x.exact === "yes" ? "yes" : x.exact === "NO" ? `NO — NOT the bytes recorded before the apply (${String(x.recordedBefore).slice(0, 12)}): something else changed this file since the apply, and that change is kept` : "NOT CONFIRMED — no record of the apply to compare with"}${c.status !== 0 ? "   node --check FAILED" : ""}`); }
{ const tw = L.twinIssues(); if (tw.length) { bad++; console.log("  " + tw.join("; ")); } }
L.logRow({ script: "rollback", result: bad ? "rolled-back-with-problems" : rep.code === 0 ? "rolled-back" : rep.code === 1 ? "rolled-back-not-byte-exact" : "rolled-back-not-confirmed", notExact: rep.notExact, noRecord: rep.noRecord, files: r.files });
if (bad) console.log("ROLLED BACK, but a file does not parse or the own.cjs pair differs — inspect it.");
console.log(rep.last);
console.log(`${!bad && rep.code === 0 ? "Nothing to restart." : `NOT a clean rollback (exit ${bad ? 1 : rep.code}): read the line(s) above.`} The cutover guard is gone again: do not cut over a paused sleeve.`);
process.exit(bad ? 1 : rep.code);
