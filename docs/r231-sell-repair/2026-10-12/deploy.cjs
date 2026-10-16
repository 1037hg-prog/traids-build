#!/usr/bin/env node
"use strict";
/**
 * R231 SELL REPAIR (2026-10-12; operator: "repair") — DEPLOY the staged edits (edits.json) to ONE file:
 *   backend/r231-crypto-vote-sized-forward.js
 *
 *   node docs/r231-sell-repair/2026-10-12/deploy.cjs --plan     READ-ONLY: every edit's state on the live file (base / applied / DRIFT), what
 *                                                               the write mode would do, and whether it would be refused right now.
 *   node docs/r231-sell-repair/2026-10-12/deploy.cjs --apply    the write mode — the main session's command, never run by the build. In
 *                                                               order (lib.cjs deployApply):
 *     1. every edit must read base or applied on the live file (DRIFT -> refused, nothing written: read the change, then make-edits.cjs)
 *     2. fences: not 05:30-16:00 MT on a trading weekday; not 13:50-15:50 MT on any day; the close chain on record as FINISHED for the last
 *        session (backend/data/chain-status.json); the runner not running — judged by what a process LOADS (a node whose script is the
 *        runner, the close chain or the sleeve package's deploy.cjs; a cmd.exe running automation\daily-close.bat), never by a word in a
 *        command line; an unreadable process list is a refusal
 *     3. the selftest (selftest.cjs) must end ALL ... PASSED
 *     4. the new text is built and passes node --check in memory; the fences and the live sha are checked again; a byte-exact backup goes to
 *        backups/ here; the file is written (temp file + rename) and verified by sha. A failed write restores it.
 *     5. node --check of the written file, then verify-live.cjs: a FAIL puts every edit back; an UNKNOWN is printed and left to read. The
 *        put-back obeys the same fences; if one has closed by then it is REFUSED and this script says so under its own headline —
 *        "APPLIED AND STILL APPLIED", the file named, the way out — never "undone".
 * Exit 0 applied / nothing to do · 1 failed, undone, or applied and NOT undone (the headline says which) · 2 refused or usage. It never
 * restarts anything, never touches backend/data, a registry file, the chain file or a switch; makes no ssh call; sends no order; asks the
 * broker nothing; never requires automation/close-chain.cjs. The counts are NOT restated by this script: restate.cjs, after the apply.
 * State and log: deploy-state.json here (backend/lib/atomic-write.js).
 */
const fs = require("fs"), path = require("path"), cp = require("child_process");
const L = require("./lib.cjs");
const args = process.argv.slice(2), MODE = args.length === 1 && (args[0] === "--plan" || args[0] === "--apply") ? args[0] : null;
if (!MODE) { console.log("usage: node docs/r231-sell-repair/2026-10-12/deploy.cjs --plan | --apply\n  --plan   read-only: the state of every staged edit on the live file\n  --apply  the write mode (refused 05:30-16:00 MT on a trading weekday, 13:50-15:50 MT on any day, while the close chain is not on record as finished for the last session, and while the runner is running)\nNothing was done."); process.exit(2); }
let E; try { E = L.loadEdits(); } catch (e) { console.error(`edits.json does not load: ${e.message}`); process.exit(MODE === "--plan" ? 1 : 2); }
const mt = L.mtNow(), P = L.plan(E);
// The sleeve package's copy step is NOT per runner: it sends the code of EVERY unit of the cell to the server's real tree and its shadow tree,
// and that package's deploy.cjs with no argument runs the copy step among its others. Said in the plan and after an apply, in the same words.
const COPY_WARNING = "That copy step is NOT per runner: it copies EVERY unit's code, and the sleeve package's deploy.cjs with NO argument runs it too. From the apply until R191's state and the board mirror's two files reach BOTH server data folders, do not run either, for any reason (NOTES.md, 'On the server').";
console.log(`${MODE === "--plan" ? "PLAN" : "APPLY"} — R231 sell repair (a buy counted net of its fee; a sell never asks for more than the account has for this book), staged ${E.stagedAt} — ${E.edits.length} anchored edits on 1 file — ${mt.dow} ${mt.date} ${mt.hms} MT`);
for (const f of P) {
  const moved = f.sha && E.base[f.rel] && f.sha !== E.base[f.rel].sha256 && f.state === "base";
  console.log(`\n  ${f.rel}   sha ${f.sha ? f.sha.slice(0, 12) : "-"}   ${f.problem ? "PROBLEM: " + f.problem : f.state === "drift" ? "DRIFT" : f.state}${moved ? "   (the file changed elsewhere since staging; every anchor still matches)" : ""}`);
  for (const e of L.editsFor(E, f.rel)) { const row = (f.states || []).find((x) => x.id === e.id) || {}, st = row.state || "?"; console.log(`      ${e.id.padEnd(18)} ${(st === "drift" ? "DRIFT" : st).padEnd(8)} ${e.why}${row.why ? `\n      ${"".padEnd(18)} DRIFT because ${row.why}` : ""}`); }
}
const drift = P.filter((f) => f.state === "drift"), todo = P.filter((f) => f.state !== "applied");
console.log(`\n  unit: ${drift.length ? "DRIFT — the write mode refuses; read the change in the live file, then make-edits.cjs, selftest.cjs, deploy.cjs --plan" : !todo.length ? "every edit is applied — nothing to apply" : `every edit reads ${P.every((f) => f.state === "base") ? "base" : "base or applied"}; the write mode would change ${L.R231} (${E.base[L.R231].sha256.slice(0, 12)} -> ${E.staged[L.R231].sha256.slice(0, 12)})`}`);
{ // the unit this file was cut on top of, and the copies other places hold
  let ps = "its record cannot be read"; try { const st = JSON.parse(fs.readFileSync(path.join(L.REPO, "docs", "pause-switches", "2026-10-12", "deploy-state.json"), "utf8")); ps = st.applied && !st.rolledBack ? `applied ${st.applied.at}` : "NOT in force (this unit was cut on the runner with it applied: its line is not touched, and the two roll back in either order)"; } catch { /* said above */ }
  console.log(`  order: docs/pause-switches/2026-10-12 (R231 sells under a pause) — ${ps}`);
  let srv = "the sleeve package's record cannot be read"; try { const w3 = JSON.parse(fs.readFileSync(path.join(L.REPO, "docs", "server", "wave3-sleeves", "deploy-state.json"), "utf8")), c = (w3.steps || {}).copy || {}, sha = (c.real || {})[L.R231]; srv = sha ? `it copied ${sha.slice(0, 12)} to the server at ${c.at}; the live file is ${P[0].sha ? P[0].sha.slice(0, 12) : "?"} — ${sha === P[0].sha ? "the same" : "NOT the same"}` : "its record names no copy of this runner"; } catch { /* said above */ }
  console.log(`  server: the sleeve package (docs/server/wave3-sleeves) keeps no staged copy of this runner; ${srv}. After the apply the server's two copies are stale until   node docs/server/wave3-sleeves/deploy.cjs --step copy   (the operator's command; it makes ssh calls)`);
  console.log(`          ${COPY_WARNING}`);
  console.log(`  switch backend/data/r231-OFF: ${fs.existsSync(path.join(L.REPO, "backend", "data", "r231-OFF")) ? "SET (buys withheld; sells under the rule go)" : "not set"}`);
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
const res = L.deployApply({ E, ...L.deployChildren({ run: child }) });
L.logRow({ script: "deploy", result: res.result, why: res.why, files: res.files, verify: res.verify, rollback: res.rollback, rollbackWhy: res.rollbackWhy, stillApplied: res.stillApplied });
if (res.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${res.why.join("\n  - ")}`); process.exit(2); }
if (res.result === "noop") { console.log("nothing to apply."); process.exit(0); }
if (res.result === "failed") { console.error(`APPLY FAILED: ${res.why.join("; ")}\n  ${res.restored ? "the file was put back" : "NOT RESTORED: " + res.notRestored.join(", ") + " — restore from backups/ by hand"}`); process.exit(1); }
if (res.result === "undone" || res.result === "applied-verify-failed") { console.error(L.undoWords(res)); process.exit(1); }
console.log(`\nR231 SELL REPAIR APPLIED (${L.R231}).${res.verify === "unknowns" ? " verify-live has UNKNOWN lines: read them, then run it again." : ""}`);
console.log("  NEXT (NOTES.md, 'The order to apply'), in this order:");
console.log(`    1. the counts are still the filled quantities. See them net of the fee, without writing:   node ${L.PKG_REL}/restate.cjs`);
console.log("       (it reads the broker's fee rows: GETs only). When it ends DRY with BCH and DOGE \"THE SAME, to the last digit\", its write mode restates them.");
console.log("    2. nothing to restart: the close chain loads the runner from disk at its next run (14:15 MT on a trading day).");
console.log("    3. the SERVER still holds the old runner (its real tree and its shadow tree), and has to keep it for now. On the server the");
console.log("       repaired runner must also be able to read R191's state and the board mirror's two files, or it sends no sell: its shadow");
console.log("       would print NO SELL and exit 1 every evening a sell is due, page, and leave no clean session for w3-r231's compare.");
console.log(`       ${COPY_WARNING}`);
console.log("       Once the three files are there, before any cutover of w3-r231 — the operator's command, it makes ssh calls:");
console.log("         node docs/server/wave3-sleeves/deploy.cjs --step copy");
console.log("    4. the registrar's dated note for R231 (wording in NOTES.md, 'For the registrar').");
process.exit(0);
