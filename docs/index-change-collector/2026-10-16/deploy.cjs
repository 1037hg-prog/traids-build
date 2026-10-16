#!/usr/bin/env node
"use strict";
/**
 * INDEX CHANGE COLLECTOR (2026-10-16) — DEPLOY. Backlog row 14, the first forced-flow collector.
 *
 * WHAT IT SHIPS: three NEW files and no change to any existing one.
 *   backend/lib/index-changes.js         the parse layer (no fs, no network, no clock)
 *   backend/lib/index-changes-fetch.js   the fetch layer (an injected fetcher only)
 *   backend/index-change-collector.js    the wiring and the dated JSONL writer
 * Nothing existing is edited, so there are no anchored edits and `base/` holds no file copies: the base
 * state of each path is ABSENT, which is what rollback.cjs restores. NOTES.md says what it does and
 * what it deliberately does not do.
 *
 *   node docs/index-change-collector/2026-10-16/deploy.cjs --plan
 *       READ-ONLY. For each path: its sha256 at home now, the staged one, and its state —
 *       absent (would be created) · applied · DRIFT (refused). Nothing is written, nothing is run.
 *
 *   node docs/index-change-collector/2026-10-16/deploy.cjs --apply
 *       the write mode — the operator's command at home. In order:
 *         1. every path reads absent or applied (DRIFT -> refused, nothing written), the staged copies
 *            are the bytes that were reviewed (sha256), and backend/lib/atomic-write.js is at home
 *         2. this package's selftest must end "ALL n CHECKS PASSED"
 *         3. the paths are written from staged/ (temp file + rename), each read back by sha256, then
 *            node --check. The first failure puts every path back the way this run found it.
 *
 * NO FENCE, and none pretended: nothing at home reads these paths yet — no existing file requires them,
 * no scheduler entry runs them, and the collector runs only when a person types it. There is no window
 * in which this could land under a running process, and nothing to restart.
 *
 * IT NEVER: reaches the network (the collector does that, only under --network, only when run),
 * writes backend/data/** (the collector does that when the operator runs it), writes
 * test-registry.json, change-registry.json or agent-ledger.jsonl (record.cjs, later), registers a test
 * (backlog row 14 is collection only), or keeps a state file — home's bytes are the state.
 *
 * Exit 0 applied, or nothing to apply · 1 failed (the headline says what holds) · 2 refused or usage.
 */
const L = require("./lib.cjs");

const USAGE = `usage: node ${L.PKG_REL}/deploy.cjs --plan | --apply
  --plan   read-only: every path's sha256 now and staged, its state, and what the write mode would do
  --apply  the write mode: the selftest gate, then the three new files
Nothing was done.`;

function printPlan(P) {
  console.log(`PLAN — index change collector (backlog row 14) — ${new Date().toISOString().slice(0, 16)}Z (${L.mtWords(Date.now())} MT) — read-only, nothing is written`);
  for (const x of P.files) {
    console.log(`\n  ${x.rel}`);
    console.log(`      ${x.what}`);
    console.log(`      home now   ${x.home || "(absent — this package ships it as a NEW file)"}`);
    console.log(`      staged     ${x.stagedSha}${x.staged === x.stagedSha ? "" : "   PACKAGE COPY DIFFERS: " + (x.staged || "missing")}`);
    console.log(`      state      ${x.state === "absent" ? "absent — the write mode would create it" : x.state === "applied" ? "applied — home already holds the staged bytes" : "DRIFT — home holds OTHER bytes at this path"}${x.problem ? "   PROBLEM: " + x.problem : ""}`);
  }
  console.log(`\n  live files the staged code requires and does not change: ${L.LIVE_DEPS.join(", ")} — ${L.LIVE_DEPS.every((r) => L.read(require("path").join(L.REPO, ...r.split("/")))) ? "present" : "MISSING"}`);
  console.log(`  it writes to ${L.DATA_DIR}/ only when the operator RUNS the collector; deploy and rollback never touch data.`);
  console.log(`\n  unit: ${P.problems.length ? "REFUSED by the write mode:\n    - " + P.problems.join("\n    - ") : P.toCreate.length ? `the write mode would create ${P.toCreate.map((x) => x.rel).join(", ")}` : "home already holds all three staged files — the write mode would write nothing"}`);
  console.log("  fences: none, and none is needed — nothing at home reads these paths yet (no require, no scheduler entry); nothing to restart.");
  console.log(`  gate: ${L.PKG_REL}/selftest.cjs must end "ALL n CHECKS PASSED" before anything is written.`);
}

module.exports = { printPlan };

if (require.main === module) {
  const args = process.argv.slice(2), MODE = args.length === 1 && ["--plan", "--apply"].includes(args[0]) ? args[0] : null;
  if (!MODE) { console.log(USAGE); process.exit(2); }
  const P = L.plan();
  if (MODE === "--plan") { printPlan(P); process.exit(P.problems.length ? 1 : 0); }

  console.log(`APPLY — index change collector (backlog row 14) — ${new Date().toISOString().slice(0, 16)}Z (${L.mtWords(Date.now())} MT)`);
  const M = L.make(), r = M.writeUnit({ to: "staged", gate: M.selftestGate });
  if (r.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${r.why.join("\n  - ")}`); process.exit(2); }
  if (r.result === "noop") { console.log(`nothing to apply: ${r.why.join("; ")}.`); process.exit(0); }
  if (r.result === "failed") {
    console.error(`APPLY FAILED: ${r.why.join("; ")}`);
    console.error(r.restored ? "  every path is back the way this run found it (the files this run created are gone again)." : `  NOT RESTORED: ${(r.notRestored || []).join("; ")} — remove those paths by hand (node ${L.PKG_REL}/rollback.cjs --plan shows what holds).`);
    process.exit(1);
  }
  console.log(`\nAPPLIED: home now holds ${r.done.join(", ")}.`);
  console.log("  Nothing runs by itself. The collector is a command, not a step in any chain:");
  console.log("    node backend/index-change-collector.js --dir <saved pages> --dry     read-only, no network");
  console.log("    node backend/index-change-collector.js --network --dry               fetches the public pages, writes nothing");
  console.log("    node backend/index-change-collector.js --network                     writes backend/data/index-changes/index-changes-<today>.jsonl");
  console.log("    node backend/index-change-collector.js --audit                       checks the announcement/effective separation on what was written");
  console.log("    node backend/index-change-collector.js --selftest                    known answers, in-process");
  console.log(`  NEXT: node ${L.PKG_REL}/record.cjs --dry   (the change-registry row this change would write; it registers NO test)`);
  process.exit(0);
}
