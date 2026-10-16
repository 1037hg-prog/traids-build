#!/usr/bin/env node
"use strict";
/**
 * R275 + R192 FORWARD SHADOWS (2026-10-16) — ROLLBACK: the three files this package added go away again, which is
 * what `base` is for all three of them — ABSENT. Nothing else in the tree is touched.
 *
 *   node docs/r275-r192-shadows/2026-10-16/rollback.cjs --plan    READ-ONLY: each file's sha256 now / staged and what would go
 *   node docs/r275-r192-shadows/2026-10-16/rollback.cjs --apply   the write mode — the main session's command
 *
 * A file that reads `applied` (home holds the staged bytes) is removed. A file that is already absent is left alone.
 * DRIFT (present, and not the staged bytes) refuses: someone changed it after the apply, and deleting it would lose
 * that change — read it first. The same fences as the apply (deploy.cjs): not 05:30-16:00 MT on a trading weekday,
 * not while the close chain is running, not when the process list cannot be read.
 *
 * BEFORE ROLLING BACK, UNWIRE. If the two runners are named in automation/close-chain.cjs, remove those lines FIRST:
 * a chain line calling a file that is gone fails the chain. This script reports the wiring and refuses while either
 * runner is still named there (it never edits that file itself — the chain's own text is the operator's).
 * WHAT A ROLLBACK DOES NOT UNDO: the records the shadows already wrote — data/r275-release-shadow.jsonl,
 * data/r192-month-end-shadow.jsonl and the two JSON read-outs beside them. Those are evidence and are never deleted
 * here; they simply stop growing. Nothing else moved: the shadows place no order, hold no position, write no ledger
 * row and seal nothing, so there is no trade, no seal and no registry entry to put back.
 * Exit 0 rolled back (or nothing to roll back) · 1 failed (the headline says what holds) · 2 refused or usage.
 */
const D = require("./deploy.cjs");

/** the records the shadows wrote: reported, never removed */
const RECORDS = ["backend/data/r275-release-shadow.jsonl", "backend/data/r275-release-shadow.json", "backend/data/r192-month-end-shadow.jsonl", "backend/data/r192-month-end-shadow.json"];

/** the chain must not still call a file that is about to be removed */
function wiringFence(W) {
  if (!W.chainPresent) return [];
  const still = D.RUNNERS.filter((r) => W.wired[r]);
  return still.length ? [`${still.join(" and ")} ${still.length > 1 ? "are" : "is"} still named in ${D.CHAIN_REL} — remove those lines first, or tonight's chain calls a file that is gone`] : [];
}

function printPlan(P, fz, W) {
  console.log(`ROLLBACK PLAN — R275 + R192 forward shadows — ${new Date().toISOString().slice(0, 16)}Z (${D.mtWords(Date.now())} MT) — read-only, nothing is written`);
  for (const x of P.files) console.log(`  ${x.rel.padEnd(34)} home ${String(x.home).slice(0, 12)}  staged ${x.stagedSha.slice(0, 12)}  ${x.state === "applied" ? "applied -> removed (base is absent)" : x.state === "absent" ? "absent — nothing to do" : x.state}${x.problem ? "   PROBLEM: " + x.problem : ""}`);
  console.log(`  unit: ${P.problems.length ? "REFUSED by the write mode:\n    - " + P.problems.join("\n    - ") : P.files.some((x) => x.state === "applied") ? "the write mode would remove the files this package added" : "nothing to remove"}`);
  console.log(`  fences now: ${fz.length ? "the write mode would be REFUSED:\n    - " + fz.join("\n    - ") : "clear"}`);
  console.log(`  records kept (never removed here): ${RECORDS.join(", ")}`);
}

/** rollback on injected dependencies (the selftest gives a scratch repo) */
function rollback(deps = {}) {
  const M = D.make(deps), W = D.wiring(M.d.repo), wf = wiringFence(W);
  if (wf.length) return { result: "refused", why: wf, lines: [], written: [] };
  return M.writeUnit({ to: "base" });
}
module.exports = { rollback, wiringFence, RECORDS };

if (require.main === module) {
  const args = process.argv.slice(2), MODE = args.length === 1 && ["--plan", "--apply"].includes(args[0]) ? args[0] : null;
  if (!MODE) { console.log("usage: node docs/r275-r192-shadows/2026-10-16/rollback.cjs --plan | --apply\nNothing was done."); process.exit(2); }
  const W = D.wiring();
  if (MODE === "--plan") { let fz; try { fz = [...D.make().fences(), ...wiringFence(W)]; } catch (e) { fz = [`the fences could not be read (${e.message})`]; } printPlan(D.plan(), fz, W); process.exit(0); }
  console.log(`ROLLBACK — R275 + R192 forward shadows — ${new Date().toISOString().slice(0, 16)}Z (${D.mtWords(Date.now())} MT)`);
  const r = rollback({});
  if (r.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${r.why.join("\n  - ")}`); process.exit(2); }
  if (r.result === "failed") { console.error(`ROLLBACK FAILED: ${r.why.join("; ")}`); console.error(r.restored ? "  home is as it was before this run" : `  NOT RESTORED: ${(r.notRestored || []).join("; ")} — remove the file by hand`); process.exit(1); }
  console.log(`\nROLLED BACK: ${r.written.length ? "removed " + r.written.join(", ") : "the files were already absent"}. Nothing to restart.`);
  console.log(`  The two shadows stop recording. Their records are kept and are not removed: ${RECORDS.join(", ")}.`);
  process.exit(0);
}
