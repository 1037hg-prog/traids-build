#!/usr/bin/env node
"use strict";
/**
 * R231 SELL REPAIR (2026-10-12) — ROLLBACK: put every applied edit back, byte-exact.
 *   node docs/r231-sell-repair/2026-10-12/rollback.cjs --plan     READ-ONLY: what would be put back
 *   node docs/r231-sell-repair/2026-10-12/rollback.cjs --apply    the write mode (the same fences as deploy.cjs)
 * Each edit's new block is replaced by its old block, each found exactly once (anything else is DRIFT: refused whole; restore the file by
 * hand from backups/). With nothing else changed since the apply the file returns to the sha recorded before it ("byte-exact: yes"). When
 * another package has edited a different part of the file since, that edit is kept and the file returns to what it would be without this
 * unit — it is then NOT its recorded bytes: the last line says "NOT BYTE-EXACT" and the run ends exit 1 (never a quiet pass).
 * WHAT ROLLBACK DOES NOT UNDO: the restate of the counts (restate.cjs: a change-registry row and its own backup of the state; the old
 * runner works on net counts as well as on gross ones — it then asks to sell the net count, which the account holds unless another sleeve's
 * sell took part of it), ledger rows already written (sell-not-sent; fee, flat, writtenOff on a fill), a pending order's `close` note (the
 * old runner ignores it), and orders that already went. AFTER A ROLLBACK the old behaviour is back: a buy is counted at its filled quantity
 * again, and a FULL sell asks for the count whatever the account holds — the broker refuses it when the account holds less.
 * Exit 0 the file back to its recorded bytes / nothing to do · 1 failed, or rolled back but NOT its recorded bytes or it does not parse ·
 * 2 refused or usage · 3 rolled back but there was no record of the apply to compare with (not confirmed).
 */
const cp = require("child_process"), path = require("path");
const L = require("./lib.cjs");
const args = process.argv.slice(2), MODE = args.length === 1 && (args[0] === "--plan" || args[0] === "--apply") ? args[0] : null;
if (!MODE) { console.log("usage: node docs/r231-sell-repair/2026-10-12/rollback.cjs --plan | --apply\nNothing was done."); process.exit(2); }
const E = L.loadEdits(), P = L.plan(E), rec = (L.readState().applied || {}).files || {};
console.log(`ROLLBACK ${MODE === "--plan" ? "PLAN (nothing is written)" : ""} — R231 sell repair — ${L.mtNow().dow} ${L.mtNow().date} ${L.mtNow().hms} MT`);
for (const f of P) console.log(`  ${f.rel.padEnd(50)} ${f.problem ? "PROBLEM: " + f.problem : f.state === "drift" ? "DRIFT (" + f.states.filter((x) => x.state === "drift").map((x) => x.id).join(", ") + ")" : f.state}${f.state === "applied" || f.state === "mixed" ? ` -> base${rec[f.rel] ? ` (recorded sha before the apply ${rec[f.rel].before.slice(0, 12)})` : " (no record of the apply: the result cannot be confirmed byte-exact)"}` : ""}`);
if (!P.every((f) => f.state === "base")) console.log("  NOTE: after a rollback a FULL sell asks for the count again, whatever the account holds. The restate of the counts, if it was run, is not undone by this.");
if (MODE === "--plan") { const fz = L.fences(); console.log(`  fences now: ${fz.length ? "the write mode would be REFUSED:\n    - " + fz.join("\n    - ") : "clear"}\n  nothing was written.`); process.exit(0); }
const r = L.rollbackAll({ E });
if (r.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${r.why.join("\n  - ")}`); L.logRow({ script: "rollback", result: "refused", why: r.why }); process.exit(2); }
if (r.result === "noop") { console.log("nothing to roll back."); L.logRow({ script: "rollback", result: "noop" }); process.exit(0); }
if (r.result !== "rolled-back") { console.error(`ROLLBACK FAILED: ${r.why.join("; ")}${r.restored ? " — the file is as it was before this run" : " — NOT RESTORED: " + r.notRestored.join(", ")}`); L.logRow({ script: "rollback", result: "failed", why: r.why }); process.exit(1); }
// A rollback is DONE only when the file is back to the bytes recorded before the apply (lib.cjs rollbackReport); otherwise the run ends non-zero.
const rep = L.rollbackReport(r.files); let bad = 0;
for (const x of rep.rows) { const c = L.isCode(x.rel) ? cp.spawnSync(process.execPath, ["--check", path.join(L.REPO, ...x.rel.split("/"))], { encoding: "utf8", windowsHide: true }) : { status: 0 }; if (c.status !== 0) bad++; console.log(`  restored ${x.rel.padEnd(50)} sha ${x.sha.slice(0, 12)}   byte-exact: ${x.exact === "yes" ? "yes" : x.exact === "NO" ? `NO (recorded before the apply: ${x.recordedBefore.slice(0, 12)})` : "unknown (no record of the apply)"}${c.status !== 0 ? "   node --check FAILED" : ""}`); }
L.logRow({ script: "rollback", result: bad ? "rolled-back-with-problems" : rep.code === 0 ? "rolled-back" : rep.code === 1 ? "rolled-back-not-byte-exact" : "rolled-back-not-confirmed", notExact: rep.notExact, noRecord: rep.noRecord, files: r.files });
if (bad) console.log("ROLLED BACK, but the file does not parse — inspect it.");
console.log(rep.last);
console.log(`${!bad && rep.code === 0 ? "Nothing to restart." : `NOT a clean rollback (exit ${bad ? 1 : rep.code}): read the line(s) above.`} The old behaviour is back: a full sell asks for the count, whatever the account holds.`);
process.exit(bad ? 1 : rep.code);
