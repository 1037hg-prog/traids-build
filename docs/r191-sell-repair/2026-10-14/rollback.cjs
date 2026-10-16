#!/usr/bin/env node
"use strict";
/**
 * R191 SELL REPAIR (2026-10-14) — ROLLBACK: the base bytes back, byte for byte.
 *   node docs/r191-sell-repair/2026-10-14/rollback.cjs --plan     READ-ONLY: what would be put back
 *   node docs/r191-sell-repair/2026-10-14/rollback.cjs --apply    the write mode (the same fences as deploy.cjs --apply)
 * Only when the live file IS the staged copy, byte for byte: it is replaced by the base copy (base/backend/r191-crypto-trend-forward.js, the
 * byte copy of the runner this repair was cut on), checked by sha before and after. The base copy already: nothing to do. Anything else is
 * DRIFT: refused whole (another hand changed the file since the apply; compare it with base/ and backups/ and put it back by hand).
 * WHAT ROLLBACK DOES NOT UNDO: the restate of the count (restate.cjs: a change-registry row and its own backup of the state; the old runner
 * works on a net count as well — it then asks to sell the net count), the note (note.cjs: registry rows are never removed), ledger rows already
 * written (sell-not-sent; fee, flat, writtenOff on a fill), a pending order's `close` note (the old runner ignores it), and orders that went.
 * AFTER A ROLLBACK the old behaviour is back: a buy is counted at its filled quantity again, and a FULL sell asks for the count whatever the
 * account holds — the broker refuses it when the account holds less, or it takes another sleeve's coins when the account holds them.
 * Exit 0 the file is the base copy again / nothing to do · 1 failed · 2 refused or usage.
 */
const cp = require("child_process"), path = require("path");
const L = require("./lib.cjs"), RL = L.RL;
const args = process.argv.slice(2), MODE = args.length === 1 && (args[0] === "--plan" || args[0] === "--apply") ? args[0] : null;
if (!MODE) { console.log("usage: node docs/r191-sell-repair/2026-10-14/rollback.cjs --plan | --apply\nNothing was done."); process.exit(2); }
const U = L.unit(), P = L.plan({ U }), rec = (L.readState().applied || {}).files || {}, mt = RL.mtNow();
console.log(`ROLLBACK ${MODE === "--plan" ? "PLAN (nothing is written)" : ""} — R191 sell repair — ${mt.dow} ${mt.date} ${mt.hms} MT`);
console.log(`  ${L.R191.padEnd(42)} sha ${P.sha ? P.sha.slice(0, 12) : "-"}   ${P.state === "drift" ? "DRIFT — " + P.problem : P.state}${P.state === "applied" ? ` -> base (the base copy, sha ${U.baseSha.slice(0, 12)}${rec[L.R191] ? `; recorded before the apply ${rec[L.R191].before.slice(0, 12)}` : "; no record of the apply here"})` : ""}`);
if (P.state === "applied") console.log("  NOTE: after a rollback a FULL sell asks for the count again, whatever the account holds. The restate and the note, if they were run, are not undone by this.");
if (MODE === "--plan") { const fz = L.fences(); console.log(`  fences now: ${fz.length ? "the write mode would be REFUSED:\n    - " + fz.join("\n    - ") : "clear"}\n  nothing was written.`); process.exit(P.state === "drift" ? 1 : 0); }
const r = L.rollbackFile({ U });
if (r.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${r.why.join("\n  - ")}`); L.logRow({ script: "rollback", result: "refused", why: r.why }); process.exit(2); }
if (r.result === "noop") { console.log("nothing to roll back."); L.logRow({ script: "rollback", result: "noop" }); process.exit(0); }
if (r.result !== "rolled-back") { console.error(`ROLLBACK FAILED: ${r.why.join("; ")}${r.restored ? " — the file is as it was before this run" : " — NOT RESTORED: put it back from base/ or backups/ by hand"}`); L.logRow({ script: "rollback", result: "failed", why: r.why }); process.exit(1); }
const f = r.files[L.R191], c = cp.spawnSync(process.execPath, ["--check", path.join(L.REPO, ...L.R191.split("/"))], { encoding: "utf8", windowsHide: true });
L.logRow({ script: "rollback", result: f.byteExact && c.status === 0 ? "rolled-back" : "rolled-back-with-problems", files: r.files });
console.log(`  restored ${L.R191.padEnd(42)} sha ${f.now.slice(0, 12)}   byte-exact (the base copy): ${f.byteExact ? "yes" : "NO"}${f.recordedBefore ? `   the sha recorded before the apply: ${f.matchesRecord ? "the same" : "NOT the same (" + f.recordedBefore.slice(0, 12) + ")"}` : ""}${c.status !== 0 ? "   node --check FAILED" : ""}`);
console.log(f.byteExact && c.status === 0 ? "ROLLED BACK: the file is byte for byte the base copy, the runner as it was before the apply. Nothing to restart. The old behaviour is back: a full sell asks for the count, whatever the account holds." : "NOT a clean rollback: read the line above.");
process.exit(f.byteExact && c.status === 0 ? 0 : 1);
