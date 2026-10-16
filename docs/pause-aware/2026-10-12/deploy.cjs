#!/usr/bin/env node
"use strict";
/**
 * PAUSE-AWARE SERVER AND MONITORS (2026-10-12) — DEPLOY the staged edits (edits.json) to the ten files of the unit, as ONE unit:
 *   docs/server/wave3-sleeves/{deploy.cjs, compare.cjs, manifests.cjs, NOTES.md} · deploy/server/own.cjs and its staged twin
 *   docs/server/wave1-crypto/own.cjs · backend/{ops-health.js, decay-monitor.js, all-activity-per-day.js, console.js}
 *
 *   node docs/pause-aware/2026-10-12/deploy.cjs --plan     READ-ONLY: every edit's state on the live files (base / applied / DRIFT), WHERE it
 *                                                          sits by line number (its anchor now and the lines its block takes once applied;
 *                                                          read from the file each time, so NOTES names the edit and this prints the line),
 *                                                          what the write mode would do, and whether it would be refused right now. Writes nothing.
 *   node docs/pause-aware/2026-10-12/deploy.cjs --apply    the write mode — the main session's command, after the close, and after profit fixes A
 *                                                          and B. In order (lib.cjs deployApply):
 *     1. every edit must read base or applied on the live file (DRIFT -> refused, nothing written: read the change, make-edits.cjs --restage).
 *        A file that carries part of a block this unit inserts, but not the whole block (a line inside it was changed after an apply), is
 *        DRIFT too — it is never read as "base", so a block is never put in twice (the marks, lib.cjs)
 *     2. fences: not 05:30-16:00 MT on a trading weekday; not 13:50-15:50 MT for the files the close chain runs (ops-health.js,
 *        decay-monitor.js); no file of the unit running, nor the close chain, the Console's launchers or a server package script (they load
 *        them); an unreadable process list is a refusal
 *     3. the selftest (selftest.cjs) must end ALL ... PASSED
 *     4. every new text is built and passes node --check in memory; deploy/server/own.cjs and W1's staged copy must come out equal; fences
 *        and the live shas are checked again; a byte-exact backup of each file goes to backups/ here; the files are written (temp file +
 *        rename), each verified by sha. A failed write restores what was written.
 *     5. node --check on each written code file, then verify-live.cjs: a FAIL puts every edit back; an UNKNOWN is printed and left to read.
 *        If that undo is itself REFUSED (a file of the unit started running in between, or the clock moved into a window) or fails, the
 *        files are STILL the applied text and the last lines say so — "APPLIED — VERIFY FAILED — UNDO REFUSED" — never "undone": run
 *        rollback.cjs once the named process has ended.
 * Exit 0 applied / nothing to do · 1 failed, undone, or applied and NOT undone · 2 refused or usage. Never restarts anything, never touches backend/data, the registry,
 * the chain file or a switch; makes no ssh call; never requires automation/close-chain.cjs. State and log: deploy-state.json here
 * (backend/lib/atomic-write.js).
 */
const fs = require("fs"), path = require("path"), cp = require("child_process");
const L = require("./lib.cjs");
const args = process.argv.slice(2), MODE = args.length === 1 && (args[0] === "--plan" || args[0] === "--apply") ? args[0] : null;
if (!MODE) { console.log("usage: node docs/pause-aware/2026-10-12/deploy.cjs --plan | --apply\n  --plan   read-only: the state of every staged edit on the live files\n  --apply  the write mode (refused 05:30-16:00 MT on a trading weekday, and while a file of the unit is running)\nNothing was done."); process.exit(2); }
let E; try { E = L.loadEdits(); } catch (e) { console.error(`edits.json does not load: ${e.message}`); process.exit(MODE === "--plan" ? 1 : 2); }
const files = L.filesOf(E), mt = L.mtNow();
const CHANGES = { 1: "cutover guard", 2: "compare names the pause", 3: "comment and notes", 4: "ops-health", 5: "decay-monitor", 6: "all-activity", 7: "console" };

const P = L.plan(E);
console.log(`${MODE === "--plan" ? "PLAN" : "APPLY"} — pause-aware server and monitors, staged ${E.stagedAt} — ${E.edits.length} anchored edits on ${files.length} files — ${mt.dow} ${mt.date} ${mt.hms} MT`);
for (const f of P) {
  const moved = f.sha && E.base[f.rel] && f.sha !== E.base[f.rel].sha256 && f.state === "base";
  console.log(`\n  ${f.rel}   sha ${f.sha ? f.sha.slice(0, 12) : "-"}   ${f.problem ? "PROBLEM: " + f.problem : f.state === "drift" ? "DRIFT" : f.state}${moved ? "   (the file changed elsewhere since staging; every anchor still matches)" : ""}`);
  // WHERE each edit sits, by line number in the file as it is NOW (read each time, never typed): its anchor while base and the lines its block will take; the block's lines once applied
  let text = null; try { text = L.readText(path.join(L.REPO, ...f.rel.split("/"))).text; } catch { text = null; }
  for (const e of L.editsFor(E, f.rel)) { const row = (f.states || []).find((x) => x.id === e.id) || {}, st = row.state || "?", ln = text ? L.editLines(text, e, L.editsFor(E, f.rel)) : null;
    const where = !ln || !ln.now ? "@ line ?" : st === "applied" ? `@ ${L.spanWords(ln.now)}` : `@ ${L.spanWords(ln.now)} now -> ${L.spanWords(ln.after)} once applied`;
    console.log(`      ${e.id.padEnd(26)} [${e.change} ${CHANGES[e.change] || "?"}]  ${(st === "drift" ? "DRIFT" : st).padEnd(8)} ${where} · ${e.why}${e.testEdit ? "   << TEST EDIT" : ""}${row.why ? `\n      ${"".padEnd(26)} DRIFT because ${row.why}` : ""}`); }
}
const drift = P.filter((f) => f.state === "drift"), todo = P.filter((f) => f.state !== "applied");
console.log(`\n  unit: ${drift.length ? `DRIFT on ${drift.map((f) => f.rel).join(", ")} — the write mode refuses; read the change in the live file, then make-edits.cjs --restage, selftest.cjs, deploy.cjs --plan` : !todo.length ? "every edit is applied — nothing to apply" : `every edit reads ${P.every((f) => f.state === "base") ? "base" : "base or applied"}; the write mode would change ${todo.length} file(s): ${todo.map((f) => f.rel).join(", ")}`}`);
{ const tw = L.twinIssues(); console.log(`  twins: deploy/server/own.cjs and docs/server/wave1-crypto/own.cjs (W1's staged copy) are ${tw.length ? "NOT EQUAL — " + tw.join("; ") : "equal now, and take the same edits"}`); }

if (MODE === "--plan") {
  const fz = L.fences({ files });
  console.log(`  fences now: ${fz.length ? "the write mode would be REFUSED:\n    - " + fz.join("\n    - ") : "clear"}`);
  for (const [name, rel] of [["profit fixes A", "docs/profit-fixes/2026-10-12/a-booking/deploy-state.json"], ["profit fixes B", "docs/profit-fixes/2026-10-12/b-plan-e/deploy-state.json"]]) {
    let st = null; try { st = JSON.parse(fs.readFileSync(path.join(L.REPO, ...rel.split("/")), "utf8")); } catch { st = null; }
    console.log(`  order: ${name} is to be applied BEFORE this unit — its record (${rel}) ${st && st.applied && !st.rolledBack ? `shows an apply at ${st.applied.at}` : st ? "shows no apply in force" : "is not there yet (not applied, or it keeps no such record)"}`);
  }
  console.log("  nothing was written.");
  process.exit(0);
}

// ───────────────────────────────────────────────────────────── --apply ─────────────────────────────────────────────────────────────
const child = (script) => cp.spawnSync(process.execPath, [path.join(L.PKG, script)], { encoding: "utf8", timeout: 1800000, cwd: L.REPO, windowsHide: true, maxBuffer: 256 << 20 });
const res = L.deployApply({ E,
  runSelftest: () => { console.log("\nselftest (about two and a half minutes) ..."); const r = child("selftest.cjs"), last = String(r.stdout || "").trim().split("\n").pop() || ""; return { ok: r.status === 0 && /^ALL \d+ CHECKS PASSED/.test(last), last, lines: [...String(r.stdout || "").split("\n").filter((l) => /^FAIL/.test(l)).slice(0, 12), String(r.stderr || "").slice(0, 300)].filter(Boolean) }; },
  runVerify: () => { console.log("verify-live ..."); const r = child("verify-live.cjs"); return { status: r.status, text: String(r.stdout || "").trim().split("\n").map((l) => "  " + l).join("\n") }; } });
L.logRow({ script: "deploy", result: res.result, why: res.why, files: res.files, verify: res.verify, rollback: res.rollback });
if (res.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${res.why.join("\n  - ")}`); process.exit(2); }
if (res.result === "noop") { console.log("nothing to apply."); process.exit(0); }
if (res.result === "failed") { console.error(`APPLY FAILED: ${res.why.join("; ")}\n  ${res.restored ? "every file written was put back" : "NOT RESTORED: " + res.notRestored.join(", ") + " — restore from backups/ by hand"}`); process.exit(1); }
if (res.result === "undone") { console.error(`APPLIED THEN UNDONE: ${res.why.join("; ")}\n  rollback: ${res.rollback} (every file is back to its bytes from before the apply)`); process.exit(1); }
if (res.result === "applied-not-undone") { console.error(L.notUndoneWords(res, Object.keys(res.files || {}).length)); process.exit(1); }
console.log(`\nPAUSE-AWARE UNIT APPLIED (${Object.keys(res.files).length} files).${res.verify === "unknowns" ? " verify-live has UNKNOWN lines: read them, then run it again." : ""}`);
console.log("  NEXT (NOTES.md, 'After the apply'): nothing to restart and nothing to re-copy to the server (no file of the unit runs there).");
console.log("        The close chain runs ops-health.js and decay-monitor.js from disk at its next run; decay-monitor's config sha changes once.");
console.log("        Before any cutover of w3-r218: its switch in the server's real tree first (the cutover now refuses without it).");
process.exit(0);
