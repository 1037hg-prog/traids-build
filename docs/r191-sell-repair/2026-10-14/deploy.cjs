#!/usr/bin/env node
"use strict";
/**
 * R191 SELL REPAIR (2026-10-14; operator 2026-10-13 08:39 MT: "repair R191") — DEPLOY the staged copy of ONE file:
 *   backend/r191-crypto-trend-forward.js
 *
 *   node docs/r191-sell-repair/2026-10-14/deploy.cjs --plan     READ-ONLY: the sha of the base copy, the staged copy and the live file; the
 *                                                               staged change as anchored edits, each found exactly once (its old block in
 *                                                               the base copy, its new block in the staged copy) and its state on the live
 *                                                               file; whether the write mode would be refused right now. Exit 0, or 1 when the
 *                                                               live file is neither copy (DRIFT: the write mode refuses).
 *   node docs/r191-sell-repair/2026-10-14/deploy.cjs --apply    the write mode — the main session's command, never run by the build. In order
 *                                                               (lib.cjs deployApply):
 *     1. the live file must BE the base copy byte for byte (the staged copy already: nothing to do; anything else: DRIFT, refused)
 *     2. fences: not 05:30-16:00 MT on a trading weekday; not 13:50-15:50 MT on any day; the close chain on record as FINISHED for the last
 *        session (backend/data/chain-status.json); R191's runner not running — judged by what a process LOADS, never by a word in a command
 *        line; an unreadable process list is a refusal
 *     3. the selftest (selftest.cjs) must end ALL ... PASSED
 *     4. the staged copy passes node --check; the fences and the live sha are read again; a byte-exact backup goes to backups/ here; the staged
 *        bytes are written (temp file + rename) and verified by sha. A failed write is put back.
 *     5. node --check of the written file, then verify-live.cjs: a FAIL puts the base bytes back; an UNKNOWN is printed and left to read. The
 *        put-back obeys the same fences; if one has closed it is REFUSED and this script says so — "APPLIED AND STILL APPLIED" — never "undone".
 * Exit 0 applied / nothing to do · 1 failed, undone, or applied and NOT undone (the headline says which) · 2 refused or usage. It never
 * restarts anything, never writes backend/data, a registry file, the chain file or a switch; makes no ssh call; sends no order; asks the broker
 * nothing; never requires automation/close-chain.cjs. The count is NOT restated here (restate.cjs), and the note is not written here (note.cjs).
 */
const fs = require("fs"), path = require("path"), cp = require("child_process");
const L = require("./lib.cjs"), RL = L.RL;
const args = process.argv.slice(2), MODE = args.length === 1 && (args[0] === "--plan" || args[0] === "--apply") ? args[0] : null;
if (!MODE) { console.log("usage: node docs/r191-sell-repair/2026-10-14/deploy.cjs --plan | --apply\n  --plan   read-only: the base, staged and live sha and every anchored edit's state on the live file\n  --apply  the write mode (refused 05:30-16:00 MT on a trading weekday, 13:50-15:50 MT on any day, while the close chain is not on record as finished for the last session, and while R191's runner is running)\nNothing was done."); process.exit(2); }
let U, P; try { U = L.unit(); P = L.plan({ U }); } catch (e) { console.error(`the package's two copies cannot be read: ${e.message}`); process.exit(MODE === "--plan" ? 1 : 2); }
const mt = RL.mtNow(), rel = (f) => path.relative(L.REPO, f).replace(/\\/g, "/");
/** the sleeve package's copy step sends EVERY unit's code to the server; the HARD RULE of work order 4.34 stands until the carry job lands */
const SERVER = "The server keeps its OLD copy of this runner: w3-r191 is held at home (work order item 2), and the HARD RULE of work order 4.34 stands — do NOT run node docs/server/wave3-sleeves/deploy.cjs --step copy, nor that script with no argument, for any sleeve, until R191's and R231's files reach both server data folders (NOTES.md, 'On the server'). That copy step is not per runner: it copies every unit's code.";
console.log(`${MODE === "--plan" ? "PLAN" : "APPLY"} — R191 sell repair (a buy counted net of its fee; a sell never asks for more than the account has for R191) — ${P.edits.length} anchored edits on 1 file — ${mt.dow} ${mt.date} ${mt.hms} MT`);
console.log(`\n  base    ${rel(L.BASE_COPY).padEnd(62)} sha ${U.baseSha.slice(0, 12)}`);
console.log(`  staged  ${rel(L.STAGED_COPY).padEnd(62)} sha ${U.stagedSha.slice(0, 12)}`);
console.log(`  live    ${L.R191.padEnd(62)} sha ${P.sha ? P.sha.slice(0, 12) : "-"}   ${P.state === "drift" ? "DRIFT — " + P.problem : P.state}`);
console.log("\n  the staged change, as anchored edits (each old block is in the base copy exactly once, each new block in the staged copy exactly once):");
for (const e of P.edits) { const s = (P.states.find((x) => x.id === e.id) || {}).state || "?", w = (P.states.find((x) => x.id === e.id) || {}).why; console.log(`      ${e.id.padEnd(16)} ${(s === "drift" ? "DRIFT" : s).padEnd(8)} base line ${String(e.baseLine).padStart(3)}: ${e.old.split("\n").length - 1} line(s) -> ${e.new.split("\n").length - 1}   ${e.why}${w ? `\n      ${"".padEnd(16)} DRIFT because ${w}` : ""}`); }
console.log(`\n  unit: ${P.state === "drift" ? "DRIFT — the write mode REFUSES: the live file is neither the base copy nor the staged copy. Read the change in the live file, then cut base/ and staged/ again, selftest.cjs, deploy.cjs --plan" : P.state === "applied" ? "the live file is the staged copy — nothing to apply" : `the live file is the base copy, byte for byte; the write mode would copy the staged bytes over it (${U.baseSha.slice(0, 12)} -> ${U.stagedSha.slice(0, 12)})`}`);
{ let srv = "the sleeve package's record cannot be read"; try { const w3 = JSON.parse(fs.readFileSync(path.join(L.REPO, "docs", "server", "wave3-sleeves", "deploy-state.json"), "utf8")), c = (w3.steps || {}).copy || {}, sha = (c.real || {})[L.R191]; srv = sha ? `its last copy step (${c.at}) sent ${sha.slice(0, 12)} of this runner to the server; the live file is ${P.sha ? P.sha.slice(0, 12) : "?"} — ${sha === P.sha ? "the same" : "NOT the same"}` : "its record names no copy of this runner"; } catch { /* said */ }
  console.log(`  server: the sleeve package (docs/server/wave3-sleeves) keeps no staged copy of this runner; ${srv}.`);
  console.log(`          ${SERVER}`);
  console.log(`  switch backend/data/r191-OFF: ${fs.existsSync(path.join(L.REPO, "backend", "data", "r191-OFF")) ? "SET (buys withheld)" : "not set"}`); }
if (MODE === "--plan") {
  const fz = L.fences();
  console.log(`  fences now: ${fz.length ? "the write mode would be REFUSED:\n    - " + fz.join("\n    - ") : "clear"}`);
  console.log("  nothing was written.");
  process.exit(P.state === "drift" ? 1 : 0);
}

// ───────────────────────────────────────────────────────────── --apply ─────────────────────────────────────────────────────────────
// This file keeps NO reading of its own of the two child runs: RL.deployChildren builds them from the one spawner below and reads each with
// RL.selftestVerdict / RL.verifyVerdict, whose answers the selftest types.
const child = (script) => cp.spawnSync(process.execPath, [path.join(L.PKG, script)], { encoding: "utf8", timeout: 1800000, cwd: L.REPO, windowsHide: true, maxBuffer: 256 << 20, env: RL.cleanEnv() });
const res = L.deployApply({ U, ...RL.deployChildren({ run: child }) });
L.logRow({ script: "deploy", result: res.result, why: res.why, files: res.files, verify: res.verify, rollback: res.rollback, rollbackWhy: res.rollbackWhy, stillApplied: res.stillApplied });
if (res.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${res.why.join("\n  - ")}`); process.exit(2); }
if (res.result === "noop") { console.log("nothing to apply."); process.exit(0); }
if (res.result === "failed") { console.error(`APPLY FAILED: ${res.why.join("; ")}\n  ${res.restored ? "the file was put back" : "NOT RESTORED — restore it from backups/ by hand"}`); process.exit(1); }
if (res.result === "undone" || res.result === "applied-verify-failed") { console.error(L.undoWords(res)); process.exit(1); }
console.log(`\nR191 SELL REPAIR APPLIED (${L.R191}).${res.verify === "unknowns" ? " verify-live has UNKNOWN lines: read them, then run it again." : ""}`);
console.log("  NEXT (NOTES.md, 'The order to apply'), in this order:");
console.log(`    1. the count is still the filled quantity. See it net of the fee, without writing:   node ${L.PKG_REL}/restate.cjs --dry`);
console.log(`       then its write mode (the same fences as this apply):   node ${L.PKG_REL}/restate.cjs --apply`);
console.log(`    2. the registrar's dated note:   node ${L.PKG_REL}/note.cjs --dry   then   node ${L.PKG_REL}/note.cjs --apply   (not 13:50-15:50 MT on a trading weekday)`);
console.log("    3. nothing to restart: the close chain loads the runner from disk at its next run (14:15 MT on a trading day).");
console.log(`    4. ${SERVER}`);
process.exit(0);
