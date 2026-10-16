#!/usr/bin/env node
"use strict";
/**
 * PM SUMMARY MEMORY (2026-10-14) — ROLLBACK: home's files go back to the BASE copies kept in this package, byte for byte, then W7's
 * copy step sends them to the VPS (and runs the recorder's selftest there), exactly as deploy.cjs sends the staged ones.
 *
 *   node docs/pm-summary-memory/2026-10-14/rollback.cjs --plan    READ-ONLY: each file's sha256 now / base / staged and what would go back
 *   node docs/pm-summary-memory/2026-10-14/rollback.cjs --apply   the write mode — the main session's command
 *
 * A file that reads `applied` (home holds the staged bytes) is written back from base/ (temp file + rename, read back by sha256,
 * node --check). A file that reads base or unchanged is left alone. A file that is DRIFT (neither) refuses the whole rollback: it was
 * changed by someone else after the apply, and copying the base over it would lose that change — read it first. The same fences as
 * the apply: not 00:20-01:20 UTC, not while traids-pm-nightly.service is active on the VPS (read over ssh, fail-closed). Only the
 * base copies must be intact for a rollback (a changed staged copy does not stop it; a changed base copy does).
 * IF W7's COPY STEP FAILS: home KEEPS the base bytes (the copy step uploads before its selftest, so the VPS may hold them already:
 * putting the staged recorder back at home and copying it again would undo the part that landed). The copy step runs once more with
 * home's base bytes; green, the rollback is done; red again, it fails saying "home is base; the VPS may hold either; re-run".
 * WHAT A ROLLBACK DOES NOT UNDO: a summary file the bounded code wrote on the VPS (data/pm-book/summary/<day>.json: its content is the
 * one the old code would have written, so nothing needs undoing), and the record.cjs rows (rows are never removed: a rollback after a
 * record is said in a NEW change-registry row). AFTER A ROLLBACK the nightly summary is the old code again: on a full day it runs out
 * of memory at about 500 MB, as on 2026-10-13. No restart either way.
 * Exit 0 rolled back (or nothing to roll back) and the copy step green · 1 failed (the headline says what holds) · 2 refused or usage.
 */
const D = require("./deploy.cjs");

function printPlan(P, fz) {
  console.log(`ROLLBACK PLAN — pm summary memory — ${new Date().toISOString().slice(0, 16)}Z (${D.mtWords(Date.now())} MT) — read-only, nothing is written`);
  for (const x of P.files) console.log(`  ${x.rel.padEnd(30)} home ${String(x.home).slice(0, 12)}  base ${x.baseSha.slice(0, 12)}  staged ${x.stagedSha.slice(0, 12)}  ${x.state === "applied" ? "applied -> goes back to the base bytes" : x.state === "base" ? "base — nothing to do" : x.state === "unchanged" ? "unchanged — nothing to do" : x.state}${x.problem && !/staged copy/.test(x.problem) ? "   PROBLEM: " + x.problem : ""}`);
  console.log(`  unit: ${P.problems.length ? "REFUSED by the write mode:\n    - " + P.problems.join("\n    - ") : P.files.some((x) => x.state === "applied") ? "the write mode would put the base bytes back and then run W7's copy step" : "nothing to put back at home — the write mode would only run W7's copy step (it sends home's bytes if the VPS differs)"}`);
  console.log(`  fences now: ${fz.length ? "the write mode would be REFUSED:\n    - " + fz.join("\n    - ") : "the clock is clear (outside 00:20-01:20 UTC)"}; the write mode also reads ${D.NIGHTLY}'s state on the VPS over ssh and refuses while it is active`);
}

/** the words for a rollback that did not end done (the selftest gives them known answers) */
function failText(r) {
  const head = `ROLLBACK FAILED: ${r.why.join("; ")}`;
  // the copy step failed twice: home was KEPT at the base bytes (a rollback never puts the staged recorder back)
  if (r.homeKept === "base") return [head, `  home is base: home's files hold the base bytes${r.written && r.written.length ? ` (${r.written.join(", ")} written by this run)` : " (they did before this run)"} and are kept so — the staged recorder was NOT put back.`,
    `  the VPS may hold either the base or the staged recorder (W7's copy step uploads before its selftest). Re-run: node ${D.PKG_REL}/rollback.cjs --apply`,
    "  (it writes nothing at home and runs the copy step again); look: node docs/server/wave7-pm/deploy.cjs --status"];
  // a failure BEFORE the copy step (a write, a parse, a file changed while this ran): home was put back to what it was before this run
  return [head, r.restored ? `  home's files are as they were before this run (the STAGED bytes); nothing reached the VPS from this run` : `  NOT RESTORED: ${(r.notRestored || []).join("; ")} — copy the files from ${D.PKG_REL}/base/ by hand`];
}

module.exports = { rollback: (deps) => D.make(deps).writeUnit({ to: "base" }), failText };

if (require.main === module) {
  const args = process.argv.slice(2), MODE = args.length === 1 && ["--plan", "--apply"].includes(args[0]) ? args[0] : null;
  if (!MODE) { console.log("usage: node docs/pm-summary-memory/2026-10-14/rollback.cjs --plan | --apply\nNothing was done."); process.exit(2); }
  if (MODE === "--plan") { const u = D.utcFence(Date.now()); printPlan(D.plan({ forRollback: true }), u ? [u] : []); process.exit(0); }
  console.log(`ROLLBACK — pm summary memory — ${new Date().toISOString().slice(0, 16)}Z (${D.mtWords(Date.now())} MT)`);
  const r = module.exports.rollback({});
  if (r.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${r.why.join("\n  - ")}`); process.exit(2); }
  if (r.result === "failed") { for (const l of failText(r)) console.error(l); process.exit(1); }
  console.log(`\nROLLED BACK: home ${r.written.length ? "holds the base bytes of " + r.written.join(", ") + " again" : "already held the base bytes"}; W7's copy step sent them to the VPS and the recorder's selftest is green there${r.retried ? ` (its first run failed, exit ${r.firstCopy}; home kept the base bytes and the second run was green)` : ""}. Nothing to restart.`);
  console.log("  The nightly summary is the OLD code again: on a full day it runs out of memory. Say so in a change-registry row if record.cjs had recorded the repair.");
  process.exit(0);
}
