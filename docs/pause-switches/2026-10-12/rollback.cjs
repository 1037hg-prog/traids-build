#!/usr/bin/env node
"use strict";
/**
 * PAUSE SWITCHES (2026-10-12) — ROLLBACK: put every applied edit back, byte-exact.
 *   node docs/pause-switches/2026-10-12/rollback.cjs --plan     READ-ONLY: what would be put back
 *   node docs/pause-switches/2026-10-12/rollback.cjs --apply    the write mode (the same fences as deploy.cjs)
 * Each edit's new block is replaced by its old block, each found exactly once (anything else is DRIFT: refused whole; restore that file by
 * hand from backups/). With nothing else changed since the apply every file returns to the sha recorded before it (printed as
 * "byte-exact: yes"). When another package has edited a different part of a file since, that edit is kept and the file returns to what it
 * would be without this unit — it is then NOT its recorded bytes: the file is named, the last line says "NOT BYTE-EXACT", and the run ends
 * exit 1 (never a quiet pass). The pairs go back together, and the sleeve package's pin goes back with its runner, so that package's own
 * judge keeps reading them as it did.
 * WHAT ROLLBACK DOES NOT UNDO: a switch file (backend/data/r231-OFF, r237-OFF: the operator's; never removed here), ledger rows already
 * written (buy-withheld-pause, entry-withheld-pause), and orders that already went. AFTER A ROLLBACK the old behaviour is back: while
 * r231-OFF is set R231 sends NO order, sells included (a held coin is not sold when its trend ends), and r237-OFF does NOTHING (R237's new
 * entries are queued and sent again). Say so to the operator before rolling back with either switch set.
 * Exit 0 every file back to its recorded bytes / nothing to do · 1 failed, or rolled back but a file is NOT its recorded bytes or does not
 * parse · 2 refused or usage · 3 rolled back but there was no record of the apply to compare with (not confirmed).
 */
const fs = require("fs"), cp = require("child_process"), path = require("path");
const L = require("./lib.cjs");
const args = process.argv.slice(2), MODE = args.length === 1 && (args[0] === "--plan" || args[0] === "--apply") ? args[0] : null;
if (!MODE) { console.log("usage: node docs/pause-switches/2026-10-12/rollback.cjs --plan | --apply\nNothing was done."); process.exit(2); }
const E = L.loadEdits(), P = L.plan(E), rec = (L.readState().applied || {}).files || {};
console.log(`ROLLBACK ${MODE === "--plan" ? "PLAN (nothing is written)" : ""} — pause switches — ${L.mtNow().dow} ${L.mtNow().date} ${L.mtNow().hms} MT`);
for (const f of P) console.log(`  ${f.rel.padEnd(62)} ${f.problem ? "PROBLEM: " + f.problem : f.state === "drift" ? "DRIFT (" + f.states.filter((x) => x.state === "drift").map((x) => x.id).join(", ") + ")" : f.state}${f.state === "applied" || f.state === "mixed" ? ` -> base${rec[f.rel] ? ` (recorded sha before the apply ${rec[f.rel].before.slice(0, 12)})` : " (no record of the apply: the result cannot be confirmed byte-exact)"}` : ""}`);
const set = ["r231-OFF", "r237-OFF"].filter((s) => fs.existsSync(path.join(L.REPO, "backend", "data", s)));
if (set.length && !P.every((f) => f.state === "base")) console.log(`  NOTE: ${set.join(" and ")} ${set.length > 1 ? "are" : "is"} set. After a rollback${set.includes("r231-OFF") ? " R231 sends no order at all while r231-OFF is set (a held coin is not sold when its trend ends)" : ""}${set.length > 1 ? ", and" : ""}${set.includes("r237-OFF") ? " r237-OFF does nothing (R237's new entries are queued and sent again)" : ""}.`);
if (MODE === "--plan") { const fz = L.fences(); console.log(`  fences now: ${fz.length ? "the write mode would be REFUSED:\n    - " + fz.join("\n    - ") : "clear"}\n  nothing was written.`); process.exit(0); }
const r = L.rollbackAll({ E });
if (r.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${r.why.join("\n  - ")}`); L.logRow({ script: "rollback", result: "refused", why: r.why }); process.exit(2); }
if (r.result === "noop") { console.log("nothing to roll back."); L.logRow({ script: "rollback", result: "noop" }); process.exit(0); }
if (r.result !== "rolled-back") { console.error(`ROLLBACK FAILED: ${r.why.join("; ")}${r.restored ? " — the files are as they were before this run" : " — NOT RESTORED: " + r.notRestored.join(", ")}`); L.logRow({ script: "rollback", result: "failed", why: r.why }); process.exit(1); }
// A rollback is DONE only when every file is back to the bytes recorded before the apply (lib.cjs rollbackReport). A file that is not is said
// by name and the run ends non-zero — never a quiet "rolled back".
const rep = L.rollbackReport(r.files); let bad = 0;
for (const x of rep.rows) { const c = L.isCode(x.rel) ? cp.spawnSync(process.execPath, ["--check", path.join(L.REPO, ...x.rel.split("/"))], { encoding: "utf8", windowsHide: true }) : { status: 0 }; if (c.status !== 0) bad++; console.log(`  restored ${x.rel.padEnd(62)} sha ${x.sha.slice(0, 12)}   byte-exact: ${x.exact === "yes" ? "yes" : x.exact === "NO" ? `NO (recorded before the apply: ${x.recordedBefore.slice(0, 12)})` : "unknown (no record of the apply)"}${c.status !== 0 ? "   node --check FAILED" : ""}`); }
{ const tw = L.twinIssues(); if (tw.length) { bad++; console.log("  " + tw.join("; ")); } }
L.logRow({ script: "rollback", result: bad ? "rolled-back-with-problems" : rep.code === 0 ? "rolled-back" : rep.code === 1 ? "rolled-back-not-byte-exact" : "rolled-back-not-confirmed", notExact: rep.notExact, noRecord: rep.noRecord, files: r.files });
if (bad) console.log("ROLLED BACK, but a file does not parse or a pair differs — inspect it.");
console.log(rep.last);
console.log(`${!bad && rep.code === 0 ? "Nothing to restart." : `NOT a clean rollback (exit ${bad ? 1 : rep.code}): read the line(s) above.`} The old behaviour is back: r231-OFF stops R231's sells too, and r237-OFF does nothing.`);
process.exit(bad ? 1 : rep.code);
