#!/usr/bin/env node
"use strict";
/**
 * OPTIONS-VANISHED-SETTLES (2026-10-16) — ROLLBACK: backend/options-settle.js goes back to the BASE copy kept in this package, byte for byte.
 *
 *   node docs/options-vanished-settles/2026-10-16/rollback.cjs --plan    READ-ONLY: the file's sha256 now / base / staged and what would go back
 *   node docs/options-vanished-settles/2026-10-16/rollback.cjs --apply   the write mode — the operator's command
 *
 * A file that reads `applied` (home holds the staged bytes) is written back from base/ (temp file + rename, read back by sha256 against the
 * base sha256, node --check). A file that reads base is left alone. DRIFT (neither) refuses: someone changed the file after the apply, and
 * copying the base over it would lose that change — read it first. The same fences as the apply (deploy.cjs): not 05:30-16:00 MT on a trading
 * weekday, not while tonight's close chain is due or running, not while backend/options-settle.js runs, not when the process list cannot be
 * read. Only the base copy must be intact (a changed staged copy does not stop a rollback; a changed base copy does).
 *
 * WHAT A ROLLBACK DOES NOT UNDO, and must be read before it is run:
 *   · ledger rows the new rule has already written (reason "expiry-vanished", obs.settleTag "vanished-legs-2026-10-16"). They stay, and the
 *     positions they closed stay off the board and in board_tombstones.json. The rows are tagged precisely so they can be found and, if the
 *     operator decides against the rule, retired through the normal retire path with a change-registry tag — never deleted by hand.
 *   · a vanishedUnknown flag already written onto a board position. It is inert to every other reader; take it off with a node script if it
 *     is not wanted (JSON is written only through backend/lib/atomic-write.js).
 *   · backend/data/options-mirror-expired.json. It is this sweep's own record and nothing else reads it; delete it if it is not wanted.
 *   · a record.cjs row in change-registry.json. Rows are never removed: a rollback after a record is said in a NEW row.
 * AFTER A ROLLBACK the old defect is back: an expired spread the other rules cannot price sits open on the board for good, and a mirror order
 * still shown as "sent" past its expiry stays "sent". No restart is needed either way.
 * Exit 0 rolled back (or nothing to roll back) · 1 failed (the headline says what holds) · 2 refused or usage.
 */
const D = require("./deploy.cjs");

function printPlan(P, fz) {
  console.log(`ROLLBACK PLAN — options-vanished-settles — ${new Date().toISOString().slice(0, 16)}Z (${D.mtWords(Date.now())} MT) — read-only, nothing is written`);
  for (const x of P.files) console.log(`  ${x.rel.padEnd(28)} home ${String(x.home).slice(0, 12)}  base ${x.baseSha.slice(0, 12)}  staged ${x.stagedSha.slice(0, 12)}  ${x.state === "applied" ? "applied -> goes back to the base bytes" : x.state === "base" ? "base — nothing to do" : x.state}${x.problem && !/staged copy/.test(x.problem) ? "   PROBLEM: " + x.problem : ""}`);
  console.log(`  unit: ${P.problems.length ? "REFUSED by the write mode:\n    - " + P.problems.join("\n    - ") : P.files.some((x) => x.state === "applied") ? "the write mode would put the base bytes back" : "nothing to put back"}`);
  console.log(`  fences now: ${fz.length ? "the write mode would be REFUSED:\n    - " + fz.join("\n    - ") : "clear"}`);
  console.log("  rows the new rule has already written are NOT undone by this (see the head of this file).");
}
/** rollback on injected dependencies (the selftest gives a scratch repo) */
const rollback = (deps) => D.make(deps).writeUnit({ to: "base" });
module.exports = { rollback };

if (require.main === module) {
  const args = process.argv.slice(2), MODE = args.length === 1 && ["--plan", "--apply"].includes(args[0]) ? args[0] : null;
  if (!MODE) { console.log(`usage: node ${D.PKG_REL}/rollback.cjs --plan | --apply\nNothing was done.`); process.exit(2); }
  if (MODE === "--plan") { let fz; try { fz = D.make().fences(); } catch (e) { fz = [`the fences could not be read (${e.message})`]; } printPlan(D.plan({ forRollback: true }), fz); process.exit(0); }
  console.log(`ROLLBACK — options-vanished-settles — ${new Date().toISOString().slice(0, 16)}Z (${D.mtWords(Date.now())} MT)`);
  const r = rollback({});
  if (r.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${r.why.join("\n  - ")}`); process.exit(2); }
  if (r.result === "failed") { console.error(`ROLLBACK FAILED: ${r.why.join("; ")}`); console.error(r.restored ? "  home's file is as it was before this run (the staged bytes)" : `  NOT RESTORED: ${(r.notRestored || []).join("; ")} — copy ${D.PKG_REL}/base/backend/options-settle.js over it by hand`); process.exit(1); }
  console.log(`\nROLLED BACK: home ${r.written.length ? "holds the base bytes of " + r.written.join(", ") + " again" : "already held the base bytes"}. Nothing to restart.`);
  console.log("  The old defect is back: an expired spread the other rules cannot price sits open for good, and a mirror order still shown as \"sent\" past expiry stays \"sent\".");
  console.log("  Rows already written keep their tag (vanished-legs-2026-10-16). Say the rollback in a NEW change-registry row if record.cjs had recorded the change.");
  process.exit(0);
}
