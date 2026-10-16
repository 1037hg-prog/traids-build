#!/usr/bin/env node
"use strict";
/**
 * KELLY COLUMN (2026-10-16) — ROLLBACK: home goes back to what it was before the apply, byte for byte.
 *   backend/progress-tests.js   written back from the BASE copy kept in this package (base/backend/progress-tests.js)
 *   backend/lib/kelly.js        REMOVED — this package created it, and nothing else requires it once the printer is back on base
 *
 *   node docs/kelly-column/2026-10-16/rollback.cjs --plan    READ-ONLY: each file's sha256 now / base / staged and what would go back
 *   node docs/kelly-column/2026-10-16/rollback.cjs --apply   the write mode — the operator's command at home
 *
 * A file that reads `applied` goes back (temp file + rename, read back by sha256, node --check; the new file is unlinked and the
 * unlink read back). A file that already reads base, or a new file that is already absent, is left alone. DRIFT (neither base nor
 * staged) refuses: someone changed the file after the apply, and copying over it would lose that change — read it first. Only the
 * base copy must be intact: a changed staged copy does not stop a rollback, a changed base copy does. The same fences as the apply
 * (deploy.cjs): not 05:30-16:00 MT on a trading weekday, not while tonight's close chain is due or running, not while the close
 * chain or the progress email runs, not when the process list cannot be read. If any step fails, every file written in that run is
 * put back to the bytes it had.
 * WHAT A ROLLBACK DOES NOT UNDO: an email already sent with the column in it (it was descriptive: no verdict, bar, sample or
 * statistic in it came from the column), and the record.cjs rows (rows are never removed: a rollback after a record is said in a
 * NEW change-registry row). AFTER A ROLLBACK the sealed-read table has three columns again. No restart either way.
 * Exit 0 rolled back (or nothing to roll back) · 1 failed (the headline says what holds) · 2 refused or usage.
 */
const D = require("./deploy.cjs");

function printPlan(P, fz) {
  console.log(`ROLLBACK PLAN — kelly column — ${new Date().toISOString().slice(0, 16)}Z (${D.mtWords(Date.now())} MT) — read-only, nothing is written`);
  for (const x of P.files) console.log(`  ${x.rel.padEnd(28)} home ${String(x.home).slice(0, 12)}  base ${x.isNew ? "(none: new file)" : String(x.baseSha).slice(0, 12)}  staged ${x.stagedSha.slice(0, 12)}  ${x.state === "applied" ? (x.isNew ? "applied -> the file is removed again" : "applied -> goes back to the base bytes") : x.state === "base" || x.state === "new" ? `${x.state} — nothing to do` : x.state}${x.problem && !/staged copy/.test(x.problem) ? "   PROBLEM: " + x.problem : ""}`);
  console.log(`  unit: ${P.problems.length ? "REFUSED by the write mode:\n    - " + P.problems.join("\n    - ") : P.files.some((x) => x.state === "applied") ? "the write mode would put home back as it was" : "nothing to put back"}`);
  console.log(`  fences now: ${fz.length ? "the write mode would be REFUSED:\n    - " + fz.join("\n    - ") : "clear"}`);
}
/** rollback on injected dependencies (the selftest gives a scratch repo) */
const rollback = (deps) => D.make(deps).writeUnit({ to: "base" });
module.exports = { rollback };

if (require.main === module) {
  const args = process.argv.slice(2), MODE = args.length === 1 && ["--plan", "--apply"].includes(args[0]) ? args[0] : null;
  if (!MODE) { console.log("usage: node docs/kelly-column/2026-10-16/rollback.cjs --plan | --apply\nNothing was done."); process.exit(2); }
  if (MODE === "--plan") { let fz; try { fz = D.make().fences(); } catch (e) { fz = [`the fences could not be read (${e.message})`]; } printPlan(D.plan({ forRollback: true }), fz); process.exit(0); }
  console.log(`ROLLBACK — kelly column — ${new Date().toISOString().slice(0, 16)}Z (${D.mtWords(Date.now())} MT)`);
  const r = rollback({});
  if (r.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${r.why.join("\n  - ")}`); process.exit(2); }
  if (r.result === "failed") { console.error(`ROLLBACK FAILED: ${r.why.join("; ")}`); console.error(r.restored ? "  home's files are as they were before this run (the staged bytes)" : `  NOT RESTORED: ${(r.notRestored || []).join("; ")} — copy ${D.PKG_REL}/base/backend/progress-tests.js over it and delete backend/lib/kelly.js by hand`); process.exit(1); }
  console.log(`\nROLLED BACK: home ${r.written.length ? "is as it was before the apply (" + r.written.join(", ") + ")" : "already was as it was before the apply"}. Nothing to restart.`);
  console.log("  The sealed-read table has three columns again. Say so in a change-registry row if record.cjs had recorded the change.");
  process.exit(0);
}
