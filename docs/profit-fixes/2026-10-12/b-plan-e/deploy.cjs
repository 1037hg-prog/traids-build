#!/usr/bin/env node
"use strict";
/**
 * PROFIT FIXES B (Plan E) — DEPLOY the staged edits (edits.json) to the four live files as one unit:
 *   backend/risk-manager.js · backend/planE-paper-scoreboard.js · backend/all-activity-per-day.js · backend/profit-program/planE-model.js
 *
 *   node docs/profit-fixes/2026-10-12/b-plan-e/deploy.cjs --plan     READ-ONLY: every edit's state on the live files (base / applied / DRIFT), what the
 *                                                                    write mode would do, and whether it would be refused right now. Writes nothing.
 *   node docs/profit-fixes/2026-10-12/b-plan-e/deploy.cjs --apply    the write mode — the main loop's command, after the close. In order (lib.cjs deployApply):
 *     1. every edit must read base or applied on the live file (DRIFT -> refused, nothing written: read the change, make-edits.cjs --restage); and the shell
 *        must carry none of the harness's switches (a PFB_* variable): with one set the write mode is refused, nothing written — clear it and run again
 *     2. fences: not 05:30-16:00 MT on a trading weekday; not 13:50-15:50 MT for a registry or chain file; no file of the unit running (nor the
 *        close chain, the progress email or a Plan E analysis script, which load them); an unreadable process list is a refusal
 *     3. the selftest (selftest.cjs) must end ALL ... PASSED. It and verify-live.cjs (step 5) are started through lib.cjs gateRun: the package's own scripts, in an
 *        environment WITHOUT the harness's switches (every PFB_* variable is taken out — PFB_SELFTEST_EDITS and PFB_VERIFY_ROOT would point them at another edit
 *        list or at a temp copy of the tree), so a variable left in the shell cannot move either gate
 *     4. every new text is built and passes node --check in memory; fences and the live shas are checked again; a byte-exact backup of each file
 *        goes to backups/ here; the files are written (temp file + rename), each verified by sha. A failed write restores what was written.
 *     5. node --check on each written file, then verify-live.cjs: a FAIL puts every edit back; an UNKNOWN (the nightly run has not run yet) is
 *        printed and left for the morning.
 * Exit 0 applied / nothing to do · 1 failed or undone · 2 refused or usage. Never restarts anything, never touches data/, the registry, the chain
 * file or a switch; never requires automation/close-chain.cjs. State and log: deploy-state.json here (backend/lib/atomic-write.js).
 */
const fs = require("fs"), path = require("path");
const L = require("./lib.cjs");
const args = process.argv.slice(2), MODE = args.length === 1 && (args[0] === "--plan" || args[0] === "--apply") ? args[0] : null;
if (!MODE) { console.log("usage: node docs/profit-fixes/2026-10-12/b-plan-e/deploy.cjs --plan | --apply\n  --plan   read-only: the state of every staged edit on the live files\n  --apply  the write mode (refused 05:30-16:00 MT on a trading weekday, and while a file of the unit is running)\nNothing was done."); process.exit(2); }
let E; try { E = L.loadEdits(); } catch (e) { console.error(`edits.json does not load: ${e.message}`); process.exit(MODE === "--plan" ? 1 : 2); }
const files = L.filesOf(E), mt = L.mtNow();

const P = L.plan(E);
console.log(`${MODE === "--plan" ? "PLAN" : "APPLY"} — profit fixes B (Plan E), staged ${E.stagedAt} — ${E.edits.length} anchored edits on ${files.length} files — ${mt.dow} ${mt.date} ${mt.hms} MT`);
for (const f of P) {
  const moved = f.sha && E.base[f.rel] && f.sha !== E.base[f.rel].sha256 && f.state === "base";
  console.log(`\n  ${f.rel}   sha ${f.sha ? f.sha.slice(0, 12) : "-"}   ${f.problem ? "PROBLEM: " + f.problem : f.state === "drift" ? "DRIFT" : f.state}${moved ? "   (the file changed elsewhere since staging; every anchor still matches)" : ""}`);
  for (const e of L.editsFor(E, f.rel)) { const st = ((f.states || []).find((x) => x.id === e.id) || {}).state || "?"; console.log(`      ${e.id.padEnd(18)} [${e.fix}]  ${(st === "drift" ? "DRIFT" : st).padEnd(8)} ${e.why}`); }
}
const drift = P.filter((f) => f.state === "drift"), todo = P.filter((f) => f.state !== "applied");
{ const set = L.gateVars(); if (set.length) console.log(`\n  note: ${set.join(", ")} ${set.length > 1 ? "are" : "is"} set in this shell — the write mode's selftest and verify-live do not read ${set.length > 1 ? "them" : "it"}: they run on the package's own edits.json and the real tree. The write mode itself REFUSES to start until the shell is clear of ${set.length > 1 ? "them" : "it"}`); }
console.log(`\n  unit: ${drift.length ? `DRIFT on ${drift.map((f) => f.rel).join(", ")} — the write mode refuses; read the change in the live file, then make-edits.cjs --restage, selftest.cjs, deploy.cjs --plan` : !todo.length ? "every edit is applied — nothing to apply" : `the write mode would change ${todo.length} file(s): ${todo.map((f) => f.rel).join(", ")}`}`);

if (MODE === "--plan") {
  const fz = L.fences({ files });
  console.log(`  fences now: ${fz.length ? "the write mode would be REFUSED:\n    - " + fz.join("\n    - ") : "clear"}`);
  try { const w5 = JSON.parse(fs.readFileSync(path.join(L.REPO, "docs", "server", "wave5-board", "deploy-state.json"), "utf8")), rec = (((w5.steps || {}).copy || {}).real || {})["backend/risk-manager.js"], live = L.sha256(fs.readFileSync(path.join(L.REPO, "backend", "risk-manager.js")));
    if (rec) console.log(`  other package: the board package (docs/server/wave5-board) copied backend/risk-manager.js to the server (sha ${rec.slice(0, 12)}); the live file is ${live === rec ? "that same file — after the apply it will differ, and W5's copy step is owed (NOTES)" : "NOT that file — W5's copy step is owed (NOTES)"}`); }
  catch { console.log("  other package: docs/server/wave5-board/deploy-state.json not read (NOTES names what it holds)"); }
  console.log("  nothing was written.");
  process.exit(0);
}

// ───────────────────────────────────────────────────────────── --apply ─────────────────────────────────────────────────────────────
const res = L.deployApply({ E, shellVars: L.gateVars(),
  runSelftest: () => { console.log("\nselftest ..."); const r = L.gateRun("selftest.cjs"), last = String(r.stdout || "").trim().split("\n").pop() || ""; return { ok: r.status === 0 && /^ALL \d+ CHECKS PASSED/.test(last), last, lines: [...String(r.stdout || "").split("\n").filter((l) => /^FAIL/.test(l)).slice(0, 12), String(r.stderr || "").slice(0, 300)].filter(Boolean) }; },
  runVerify: () => { console.log("verify-live ..."); const r = L.gateRun("verify-live.cjs"); return { status: r.status, text: String(r.stdout || "").trim().split("\n").map((l) => "  " + l).join("\n") }; } });
L.logRow({ script: "deploy", result: res.result, why: res.why, files: res.files, verify: res.verify, rollback: res.rollback });
if (res.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${res.why.join("\n  - ")}`); process.exit(2); }
if (res.result === "noop") { console.log("nothing to apply."); process.exit(0); }
if (res.result === "failed") { console.error(`APPLY FAILED: ${res.why.join("; ")}\n  ${res.restored ? "every file written was put back" : "NOT RESTORED: " + res.notRestored.join(", ") + " — restore from backups/ by hand"}`); process.exit(1); }
if (res.result === "undone") { console.error(`APPLIED THEN UNDONE: ${res.why.join("; ")}\n  rollback: ${res.rollback}${res.rollbackWhy.length ? " — " + res.rollbackWhy.join("; ") : ""}${res.rollback === "rolled-back" ? " (every file is back to its bytes from before the apply)" : " — restore from backups/ by hand"}`); process.exit(1); }
console.log(`\nPROFIT FIXES B APPLIED (${Object.keys(res.files).length} files).${res.verify === "unknowns" ? " verify-live has UNKNOWN lines: run it again after tonight's close chain." : ""}`);
console.log("  NEXT (NOTES.md, 'After the apply'): nothing to restart — the close chain runs risk-manager.js and the scoreboard from disk at its next run;");
console.log("        record the dated note in R270's registry entry (outside 13:50-15:50 MT); re-run the board package's copy step so the server's shadow copy is the fixed file;");
console.log("        the morning after: node docs/profit-fixes/2026-10-12/b-plan-e/verify-live.cjs");
process.exit(0);
