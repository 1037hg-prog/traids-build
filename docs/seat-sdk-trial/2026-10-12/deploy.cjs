#!/usr/bin/env node
"use strict";
/**
 * SEAT-SDK TRIAL (2026-10-12; work order 4.31; operator: "build it for a trial period") — DEPLOY the ONE staged edit to automation/seat-wave.cjs:
 * eleven lines inserted between two lines of the wave's loop, so that the wave asks backend/data/seat-provider.json, once per seat, which
 * launcher runs that seat. With that file absent the edited wave does exactly what the wave does today.
 *
 *   node docs/seat-sdk-trial/2026-10-12/deploy.cjs --plan     READ-ONLY: the state of the edit on the live file (base / applied / DRIFT), the
 *                                                              lines it inserts, and whether the write mode would be refused right now.
 *   node docs/seat-sdk-trial/2026-10-12/deploy.cjs --apply    the write mode — the main session's command, in the evening. In order
 *                                                              (lib.cjs deployApply):
 *     1. the edit must read base (applied: nothing to do; DRIFT: refused, nothing written)
 *     2. fences: not 05:30-16:00 MT on a trading weekday; not while the seat wave is running (its process, its launcher, or an open wave
 *        in its log); a process list that cannot be read is a refusal
 *     3. the selftest (selftest.cjs) must end ALL ... PASSED
 *     4. the new text is built and passes node --check in memory; the fences and the live sha are checked again; a byte-exact backup goes
 *        to backups/ here; the file is written (temp file + rename) and verified by sha. A failed write restores the file.
 *     5. node --check on the written file, then verify-live.cjs: a FAIL puts the edit back; an UNKNOWN is printed and left to read.
 * Exit 0 applied / nothing to do · 1 failed or undone · 2 refused or usage.
 *
 * WHAT THE APPLY DOES NOT DO: it does not switch any seat. Every seat stays on the command line until backend/data/seat-provider.json is
 * written by `node automation/seat-sdk/set-provider.cjs sdk --seats <one seat>` — the operator's own step (NOTES.md). It never restarts
 * anything, never touches backend/data, a registry file, the chain file, a .bat or a scheduled task, makes no network call and starts no
 * seat. State and log: deploy-state.json here (backend/lib/atomic-write.js).
 */
const path = require("path"), cp = require("child_process");
const L = require("./lib.cjs");
const args = process.argv.slice(2), MODE = args.length === 1 && (args[0] === "--plan" || args[0] === "--apply") ? args[0] : null;
if (!MODE) { console.log("usage: node docs/seat-sdk-trial/2026-10-12/deploy.cjs --plan | --apply\n  --plan   read-only: the state of the staged edit on the live seat wave\n  --apply  the write mode (refused 05:30-16:00 MT on a trading weekday and while the seat wave is running)\nNothing was done."); process.exit(2); }
let E; try { E = L.loadEdit(); } catch (e) { console.error(`the staged edit does not load: ${e.message}`); process.exit(MODE === "--plan" ? 1 : 2); }
const mt = L.mtNow(), P = L.plan(E);

console.log(`${MODE === "--plan" ? "PLAN" : "APPLY"} — seat-SDK trial: the seat wave reads the switch — ONE anchored edit on ${L.TARGET}, staged ${L.STAGED_BASE.on} — ${mt.dow} ${mt.date} ${mt.hms} MT`);
console.log(`\n  ${P.rel}   sha ${P.sha ? P.sha.slice(0, 12) : "-"}   ${P.problem ? "PROBLEM: " + P.problem : P.state === "drift" ? "DRIFT" : P.state}${P.movedSinceStaging ? "   (the file changed elsewhere since staging; the anchor still matches)" : ""}`);
console.log(`      ${L.EDIT_ID}   ${P.state === "drift" ? "DRIFT because " + (P.why || P.problem) : P.state}   — ${E.insert.split("\n").length - 1} lines inserted between two lines of the wave's loop; no existing line is changed or removed`);
console.log(`      staged against sha ${L.STAGED_BASE.sha256.slice(0, 12)} (${L.STAGED_BASE.bytes} bytes); the live file without this edit is sha ${P.baseSha ? P.baseSha.slice(0, 12) : "?"}`);
console.log("\n  the two anchor lines (unchanged) and, between them, what is inserted:");
console.log(`      ${E.anchor[0].trim().slice(0, 150)}${E.anchor[0].trim().length > 150 ? " ..." : ""}`);
for (const l of E.insert.slice(0, -1).split("\n")) console.log(`    + ${l.length > 170 ? l.slice(0, 170) + " ..." : l}`);
console.log(`      ${E.anchor[1].trim()}`);
console.log(`\n  unit: ${P.state === "drift" ? "DRIFT — the write mode refuses; read the change in the live file" : P.state === "applied" ? "the edit is applied — nothing to apply" : "the edit reads base; the write mode would change 1 file: " + L.TARGET}`);
{
  const R = require(path.join(L.REPO, "automation", "seat-sdk", "provider.cjs")).read(L.REPO);
  console.log(`  switch: backend/data/seat-provider.json is ${R.state === "absent" ? "ABSENT: with the edit applied the wave still does exactly what it does today" : R.state === "unreadable" ? `UNREADABLE (${R.why}): every seat stays on the command line` : `provider "${R.provider}"${R.seats ? ", seats " + R.seats.join(", ") : ""}`}`);
}

if (MODE === "--plan") {
  const fz = L.fences();
  console.log(`  fences now: ${fz.length ? "the write mode would be REFUSED:\n    - " + fz.join("\n    - ") : "clear"}`);
  console.log("  nothing was written.");
  process.exit(0);
}

// ───────────────────────────────────────────────────────────── --apply ─────────────────────────────────────────────────────────────
// This file keeps NO reading of its own of the two child runs: lib.cjs deployChildren builds them from the one spawner below, and reads each
// with selftestVerdict / verifyVerdict, whose answers the selftest types. A change here must stay a spawner and nothing else.
const child = (script) => cp.spawnSync(process.execPath, [path.join(L.PKG, script)], { encoding: "utf8", timeout: 1800000, cwd: L.REPO, windowsHide: true, maxBuffer: 256 << 20, env: L.cleanEnv() });
const res = L.deployApply({ e: E, ...L.deployChildren({ run: child }) });
L.logRow({ script: "deploy", result: res.result, why: res.why, before: res.before, after: res.after, verify: res.verify, rollback: res.rollback });
if (res.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${res.why.join("\n  - ")}`); process.exit(2); }
if (res.result === "noop") { console.log("nothing to apply."); process.exit(0); }
if (res.result === "failed") { console.error(`APPLY FAILED: ${res.why.join("; ")}\n  ${res.restored ? "the file was put back" : "NOT RESTORED — restore " + L.TARGET + " from backups/ by hand"}`); process.exit(1); }
if (res.result === "undone") { console.error(`APPLIED THEN UNDONE: ${res.why.join("; ")}\n  rollback: ${res.rollback}${res.rollbackWhy.length ? " — " + res.rollbackWhy.join("; ") : ""}${res.rollback === "rolled-back" && res.byteExact ? " (the file is back to its bytes from before the apply)" : " — compare the file with its copy in backups/"}`); process.exit(1); }
console.log(`\nSEAT-SDK EDIT APPLIED (${L.TARGET}).${res.verify === "unknowns" ? " verify-live has UNKNOWN lines: read them, then run it again." : ""}`);
console.log("  Nothing has changed for tonight's seats: no seat is on the SDK until the switch is written. NEXT (NOTES.md, 'The first night'):");
console.log("    1. record the dated note on the seat tests (NOTES.md, 'The note for the seat tests') — the main session, outside 13:50-15:50 MT");
console.log("    2. the operator's step, when he is ready for the first night (ONE seat: news-trader, the cheapest on the record and escrowed):   node automation/seat-sdk/set-provider.cjs sdk --seats news-trader --note \"first night\"");
console.log("    3. the morning after: the billing page (the promotional balance moved, the purchased balance did not), then all six:   node automation/seat-sdk/set-provider.cjs sdk");
console.log("    back to the command line at any time, one command:   node automation/seat-sdk/set-provider.cjs cli");
process.exit(0);
