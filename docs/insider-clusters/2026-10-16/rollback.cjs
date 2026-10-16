#!/usr/bin/env node
"use strict";
/**
 * INSIDER CLUSTERS (2026-10-16) — ROLLBACK: the six files this package created are REMOVED, and the tree is what it was before.
 *
 *   node docs/insider-clusters/2026-10-16/rollback.cjs --plan     READ-ONLY: each file's sha256 now / staged and what would go
 *   node docs/insider-clusters/2026-10-16/rollback.cjs --apply    the write mode — the main session's command
 *
 * base/ holds no bytes because this package replaces nothing: all six paths are new, so "back to base" means they are not there.
 * A file that reads `applied` (its sha256 is the staged one) is removed. A file that is already absent is left alone. A file that is
 * DRIFT — that path exists holding OTHER bytes — refuses the whole rollback and is never removed: someone wrote their own file at
 * that path after the apply, and deleting it would lose their work. The same fences as the apply: not 05:30-16:00 MT on a trading
 * weekday, and not while backend/insider-buys-collect.js or backend/insider-clusters.js is running (a process list that cannot be
 * read refuses).
 *
 * WHAT A ROLLBACK DOES NOT UNDO, by design:
 *   - the dated files the collector already wrote (backend/data/insider-buys/insider-buys-<day>.jsonl) and any
 *     backend/data/insider-clusters-<day>.json. Those are a RECORD of what the SEC published; removing the code that reads the SEC
 *     is no reason to destroy the record, and nothing else writes those paths. Delete them by hand if that is really wanted.
 *   - the record.cjs rows. A row is never removed: a rollback after a record is said in a NEW change-registry row.
 * Nothing is restarted either way: the collector is started by the operator, not by a unit this package installs.
 * Exit 0 rolled back (or nothing to roll back) · 1 failed · 2 refused or usage.
 */
const D = require("./deploy.cjs");

function printPlan(Pl, fz) {
  console.log(`ROLLBACK PLAN — insider clusters — ${new Date().toISOString().slice(0, 16)}Z (${D.mtWords(Date.now())} MT) — read-only, nothing is written`);
  for (const x of Pl.files) {
    console.log(`  ${x.rel.padEnd(36)} home ${String(x.home || "(absent)").slice(0, 12).padEnd(12)}  staged ${x.stagedSha.slice(0, 12)}  ${x.state === "applied" ? "applied -> would be REMOVED (this package created it)" : x.state === "absent" ? "absent — nothing to do" : x.state}`);
  }
  console.log(`  unit: ${Pl.problems.length ? "REFUSED by the write mode:\n    - " + Pl.problems.join("\n    - ") : Pl.toRemove.length ? `the write mode would remove ${Pl.toRemove.length} file(s)` : "none of the six is at home — the write mode would do nothing"}`);
  console.log(`  fences now: ${fz.length ? "the write mode would be REFUSED:\n    - " + fz.join("\n    - ") : "clear (the clock and the node process list)"}`);
  console.log("  it does NOT remove the dated files the collector already wrote, nor the record.cjs rows (a row is never removed; a rollback after a record is said in a new row).");
}

if (require.main === module) {
  const args = process.argv.slice(2), MODE = args.length === 1 && ["--plan", "--apply"].includes(args[0]) ? args[0] : null;
  if (!MODE) {
    console.log(`usage: node ${D.PKG_REL}/rollback.cjs --plan | --apply\n  --plan   read-only: what is at home and what would be removed\n  --apply  the write mode (the same fences as the apply; a DRIFT file is never removed)\nNothing was done.`);
    process.exit(2);
  }
  const Pl = D.plan({ forRollback: true });
  if (MODE === "--plan") {
    const M = D.make();
    let fz;
    try { fz = M.fences(); } catch (e) { fz = [`the fences could not be read (${e.message})`]; }
    printPlan(Pl, fz);
    process.exit(0);
  }
  console.log(`ROLLBACK — insider clusters — ${new Date().toISOString().slice(0, 16)}Z (${D.mtWords(Date.now())} MT)`);
  const r = D.make().writeUnit({ to: "base" });
  if (r.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${r.why.join("\n  - ")}`); process.exit(2); }
  if (r.result === "failed") { console.error(`ROLLBACK FAILED: ${r.why.join("; ")}\n  the file named above was NOT removed; the ones already removed are listed as written: ${(r.written || []).join(", ") || "none"}`); process.exit(1); }
  console.log(`\nROLLED BACK: ${r.written.length ? "removed " + r.written.join(", ") : "none of the six was at home"}. The dated files the collector wrote are untouched.`);
  process.exit(0);
}

module.exports = { printPlan };
