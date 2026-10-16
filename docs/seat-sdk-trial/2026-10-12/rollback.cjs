#!/usr/bin/env node
"use strict";
/**
 * SEAT-SDK TRIAL (2026-10-12) — ROLLBACK: take the inserted lines out of automation/seat-wave.cjs again, byte-exact.
 *   node docs/seat-sdk-trial/2026-10-12/rollback.cjs --plan     READ-ONLY: what would be put back
 *   node docs/seat-sdk-trial/2026-10-12/rollback.cjs --apply    the write mode (the same fences as deploy.cjs)
 * The new block is replaced by the old block, found exactly once (anything else is DRIFT: refused whole; restore the file by hand from
 * backups/). With nothing else changed since the apply the file returns to the sha recorded before it ("byte for byte"). When another
 * package has edited a different part of the wave since, that edit is kept and the file returns to what it would be without this
 * package — it is then NOT its recorded bytes: the last line says "NOT BYTE-EXACT" and the run ends exit 1 (never a quiet pass).
 *
 * THE QUICK WAY BACK IS NOT THIS FILE. To put every seat back on the command line, one command, no file edit:
 *     node automation/seat-sdk/set-provider.cjs cli
 * A rollback is for taking the staged lines themselves out of the wave. AFTER A ROLLBACK the wave no longer reads the switch at all:
 * every seat runs on the command line whatever backend/data/seat-provider.json says (the file is left where it is; it is the
 * operator's). WHAT ROLLBACK DOES NOT UNDO: ledger rows already written (backend/data/seat-sdk-ledger.jsonl), seat rows already in
 * the wave's history, claims already sealed, credit already spent.
 * Exit 0 back to the recorded bytes / nothing to do · 1 failed, or rolled back but NOT the recorded bytes or the file does not parse ·
 * 2 refused or usage · 3 rolled back but there was no record of the apply to compare with.
 */
const cp = require("child_process");
const L = require("./lib.cjs");
const args = process.argv.slice(2), MODE = args.length === 1 && (args[0] === "--plan" || args[0] === "--apply") ? args[0] : null;
if (!MODE) { console.log("usage: node docs/seat-sdk-trial/2026-10-12/rollback.cjs --plan | --apply\nNothing was done."); process.exit(2); }
let E; try { E = L.loadEdit(); } catch (e) { console.error(`the staged edit does not load: ${e.message}`); process.exit(MODE === "--plan" ? 1 : 2); }
const P = L.plan(E), rec = (L.readState().applied || {}).before || null, mt = L.mtNow();
console.log(`ROLLBACK ${MODE === "--plan" ? "PLAN (nothing is written)" : ""} — seat-SDK trial — ${mt.dow} ${mt.date} ${mt.hms} MT`);
console.log(`  ${P.rel}   ${P.problem ? "PROBLEM: " + P.problem : P.state === "drift" ? "DRIFT (" + P.why + ")" : P.state}${P.state === "applied" ? ` -> base${rec ? ` (recorded sha before the apply ${rec.slice(0, 12)})` : " (no record of the apply: the result cannot be confirmed byte-exact)"}` : ""}`);
if (P.state === "applied") console.log("  NOTE: after a rollback the wave no longer reads backend/data/seat-provider.json: every seat runs on the command line. To only switch seats back, use: node automation/seat-sdk/set-provider.cjs cli");
if (MODE === "--plan") { const fz = L.fences(); console.log(`  fences now: ${fz.length ? "the write mode would be REFUSED:\n    - " + fz.join("\n    - ") : "clear"}\n  nothing was written.`); process.exit(0); }
const r = L.rollbackAll({ e: E });
if (r.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${r.why.join("\n  - ")}`); L.logRow({ script: "rollback", result: "refused", why: r.why }); process.exit(2); }
if (r.result === "noop") { console.log("nothing to roll back."); L.logRow({ script: "rollback", result: "noop" }); process.exit(0); }
if (r.result !== "rolled-back") { console.error(`ROLLBACK FAILED: ${r.why.join("; ")}${r.restored ? " — the file is as it was before this run" : " — NOT RESTORED: compare " + L.TARGET + " with its copy in backups/"}`); L.logRow({ script: "rollback", result: "failed", why: r.why }); process.exit(1); }
// A rollback is DONE only when the file is back to the bytes recorded before the apply (lib.cjs rollbackReport), and still parses.
const rep = L.rollbackReport(r), c = cp.spawnSync(process.execPath, ["--check", L.targetOf()], { encoding: "utf8", windowsHide: true }), bad = c.status !== 0;
console.log(`  restored ${L.TARGET}   sha ${r.now.slice(0, 12)}   byte-exact: ${r.byteExact === true ? "yes" : r.byteExact === false ? "NO" : "unknown (no record of the apply)"}${bad ? "   node --check FAILED" : ""}`);
L.logRow({ script: "rollback", result: bad ? "rolled-back-does-not-parse" : rep.code === 0 ? "rolled-back" : rep.code === 1 ? "rolled-back-not-byte-exact" : "rolled-back-not-confirmed", now: r.now, recordedBefore: r.recordedBefore });
console.log(rep.last);
console.log(`${!bad && rep.code === 0 ? "Nothing to restart." : `NOT a clean rollback (exit ${bad ? 1 : rep.code}): read the line(s) above.`} The wave no longer reads the switch: every seat runs on the command line.`);
process.exit(bad ? 1 : rep.code);
