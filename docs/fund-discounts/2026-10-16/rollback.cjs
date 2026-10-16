#!/usr/bin/env node
"use strict";
/**
 * R354 FUND DISCOUNTS (2026-10-16) — ROLLBACK: the three files go back to the state base/ holds, which for this package is ABSENCE.
 * All three are NEW files (deploy.cjs, "base is absence"), so rolling back means REMOVING exactly the bytes this package wrote.
 *
 *   node docs/fund-discounts/2026-10-16/rollback.cjs --plan     READ-ONLY: each file's sha256 now, and what would be removed
 *   node docs/fund-discounts/2026-10-16/rollback.cjs --apply    the write mode: removes each file that holds the STAGED bytes
 *
 * A file that is already absent is left alone. A file that holds anything but the staged bytes is DRIFT and REFUSES the whole
 * rollback: someone changed it after the apply, and deleting it would lose that change — read it first.
 * WHAT A ROLLBACK DOES NOT UNDO: anything already written under backend/data/ by a --controls run (r354-controls.json,
 * r354-units.json) or by the nightly recorder (backend/data/fund-nav/*.jsonl). Those are records, not code: they are never removed
 * here, and a rollback after a record.cjs row is said in a NEW change-registry row. No read is undone either — a read that happened
 * is a fact (and in this tree no read can happen: the read condition refuses).
 * Exit 0 rolled back (or nothing to roll back) · 1 failed · 2 refused or usage.
 */
const fs = require("fs"), path = require("path");
const D = require("./deploy.cjs");

/** what a rollback would do, per file: remove (it holds the staged bytes) · absent · DRIFT (refuses everything) */
function rollbackPlan({ repo = D.REPO, pkg = D.PKG } = {}) {
  const P = D.plan({ repo, pkg }), problems = [];
  for (const x of P.files) {
    if (x.problem) problems.push(`${x.rel}: ${x.problem}`);
    if (x.state === "DRIFT") problems.push(`${x.rel} is DRIFT at home (sha256 ${String(x.home).slice(0, 12)}): it is not the bytes this package wrote, so a rollback would lose someone else's change — read it first`);
  }
  return { files: P.files, problems, todo: P.files.filter((x) => x.state === "applied") };
}
function rollback({ repo = D.REPO, pkg = D.PKG, log = console.log } = {}) {
  const P = rollbackPlan({ repo, pkg });
  if (P.problems.length) return { result: "refused", why: P.problems };
  const removed = [];
  for (const x of P.todo) {
    const file = path.join(repo, ...x.rel.split("/"));
    try { fs.unlinkSync(file); } catch (e) { return { result: "failed", why: [`removing ${x.rel}: ${e.message}`], removed }; }
    removed.push(x.rel);
    log(`  removed ${x.rel} (it held the staged bytes ${x.stagedSha.slice(0, 12)}; base for this package is absence)`);
  }
  if (!removed.length) log("  nothing to remove: no file holds this package's staged bytes.");
  return { result: "done", removed };
}

module.exports = { rollbackPlan, rollback };

if (require.main === module) {
  const a = process.argv.slice(2), MODE = a.length === 1 && ["--plan", "--apply"].includes(a[0]) ? a[0] : null;
  if (!MODE) { console.log(`usage: node ${D.PKG_REL}/rollback.cjs --plan | --apply\nNothing was done.`); process.exit(2); }
  const P = rollbackPlan();
  if (MODE === "--plan") {
    console.log(`ROLLBACK PLAN — R354 fund discounts — ${new Date().toISOString().slice(0, 16)}Z — read-only, nothing is written`);
    for (const x of P.files) console.log(`  ${x.rel.padEnd(32)} home ${String(x.home || "absent").slice(0, 12)}  staged ${x.stagedSha.slice(0, 12)}  ${x.state === "applied" ? "applied -> would be REMOVED (base is absence)" : x.state === "new" ? "absent — nothing to do" : x.state}`);
    console.log(`  unit: ${P.problems.length ? "REFUSED:\n    - " + P.problems.join("\n    - ") : P.todo.length ? `the write mode would remove ${P.todo.map((x) => x.rel).join(", ")}` : "nothing to remove"}`);
    console.log("  it never removes anything under backend/data/ (a --controls file, a read, a recorder's JSONL): those are records.");
    process.exit(0);
  }
  console.log(`ROLLBACK — R354 fund discounts — ${new Date().toISOString().slice(0, 16)}Z`);
  const r = rollback({});
  if (r.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${r.why.join("\n  - ")}`); process.exit(2); }
  if (r.result === "failed") { console.error(`ROLLBACK FAILED: ${r.why.join("; ")}\n  removed so far: ${r.removed.join(", ") || "none"} — finish by hand or re-run`); process.exit(1); }
  console.log(`\nROLLED BACK: ${r.removed.length ? r.removed.join(", ") + " removed; the live tree is as it was before the apply" : "nothing was there to remove"}. Nothing to restart.`);
  process.exit(0);
}
