#!/usr/bin/env node
"use strict";
/**
 * CAPITAL MODEL — MEASURED COST (2026-10-16) — ROLLBACK: backend/profit-program/planE-model.js and planE-baseline.js go back to the BASE
 * copies kept in this package, byte for byte.
 *
 *   node docs/capital-model-measured-cost/2026-10-16/rollback.cjs --plan    READ-ONLY: each file's sha256 now / base / staged and what
 *                                                                          would go back; the fences now. Nothing is written.
 *   node docs/capital-model-measured-cost/2026-10-16/rollback.cjs --apply   the write mode — the operator's command.
 *
 * A file that reads `applied` (home holds the staged bytes) is written back from base/ (temp file + rename, read back by sha256, then
 * node --check). A file that already reads base is left alone. DRIFT (neither) refuses: someone changed the file after the apply, and
 * copying the base over it would lose that change — read it first. The two files are one unit: if they are in different states the
 * rollback refuses and says so. The same fences as the apply (deploy.cjs): not 05:30-16:00 MT on a trading weekday, not while the close
 * chain or any backend/profit-program script runs, not when the process list cannot be read. Only the BASE copies must be intact (a
 * changed staged copy does not stop a rollback).
 * WHAT A ROLLBACK DOES NOT UNDO: a planE-baseline.json written by a measured run keeps its extra measuredCosts key until the baseline is
 * run again (every other key is the same either way, and risk-manager.js reads py.E, which a measured run does not touch). Rolling back
 * after record.cjs has written its row is said in a NEW change-registry row, never by removing one. Nothing is restarted either way.
 * Exit 0 rolled back (or nothing to roll back) · 1 failed (the headline says what holds) · 2 refused or usage.
 */
const D = require("./deploy.cjs");

function printPlan(P, fz) {
  console.log(`ROLLBACK PLAN — capital model measured cost — ${new Date().toISOString().slice(0, 16)}Z (${D.mtWords(Date.now())} MT) — read-only, nothing is written`);
  for (const x of P.files) console.log(`  ${x.rel.padEnd(42)} home ${String(x.home).slice(0, 12)}  base ${x.baseSha.slice(0, 12)}  staged ${x.stagedSha.slice(0, 12)}  ${x.state === "applied" ? "applied -> goes back to the base bytes" : x.state === "base" ? "base — nothing to do" : x.state}${x.problem && !/staged copy/.test(x.problem) ? "   PROBLEM: " + x.problem : ""}`);
  console.log(`  unit: ${P.problems.length ? "REFUSED by the write mode:\n    - " + P.problems.join("\n    - ") : P.files.some((x) => x.state === "applied") ? "the write mode would put the base bytes back" : "nothing to put back"}`);
  console.log(`  fences now: ${fz.length ? "the write mode would be REFUSED:\n    - " + fz.join("\n    - ") : "clear"}`);
  console.log("  after a rollback the model prices trading cost from its assumed rates only, and --measured-costs is not a switch any more.");
}
/** rollback on injected dependencies (the selftest gives a scratch repo) */
const rollback = (deps) => D.make(deps).writeUnit({ to: "base" });
module.exports = { rollback };

if (require.main === module) {
  const args = process.argv.slice(2), MODE = args.length === 1 && ["--plan", "--apply"].includes(args[0]) ? args[0] : null;
  if (!MODE) { console.log(`usage: node ${D.PKG_REL}/rollback.cjs --plan | --apply\nNothing was done.`); process.exit(2); }
  if (MODE === "--plan") { let fz; try { fz = D.make().fences(); } catch (e) { fz = [`the fences could not be read (${e.message})`]; } printPlan(D.plan({ forRollback: true }), fz); process.exit(0); }
  console.log(`ROLLBACK — capital model measured cost — ${new Date().toISOString().slice(0, 16)}Z (${D.mtWords(Date.now())} MT)`);
  const r = rollback({});
  if (r.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${r.why.join("\n  - ")}`); process.exit(2); }
  if (r.result === "failed") { console.error(`ROLLBACK FAILED: ${r.why.join("; ")}`); console.error(r.restored ? "  home's files are as they were before this run (the staged bytes)" : `  NOT RESTORED: ${(r.notRestored || []).join("; ")} — copy ${D.PKG_REL}/base/backend/profit-program/*.js over them by hand`); process.exit(1); }
  console.log(`\nROLLED BACK: home ${r.written.length ? "holds the base bytes of " + r.written.join(" and ") + " again" : "already held the base bytes"}. Nothing to restart.`);
  console.log("  Re-run node backend/profit-program/planE-baseline.js to rewrite planE-baseline.json without the measuredCosts key. If record.cjs had");
  console.log("  written its row, say the rollback in a NEW change-registry row; rows are never removed.");
  process.exit(0);
}
