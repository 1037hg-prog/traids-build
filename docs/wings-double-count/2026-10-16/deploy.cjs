#!/usr/bin/env node
"use strict";
/**
 * WINGS DOUBLE COUNT (2026-10-16) — DEPLOY.
 *
 * WHAT IT SHIPS. Five files under backend/, every one of them read-only analysis or reporting code:
 *   backend/lib/ticket-rows.js        NEW — the one definition of which row IS a ticket
 *   backend/lib/reconcile.js          the canonical read collapses to one row per ticket id first
 *   backend/daily-postmortem.js       the daily report collapses first
 *   backend/options-news-shadow.js    keyed on the ticket id instead of on arrival order
 *   backend/integrity-audit.js        reports duplicate ticket ids; the tripwire counts tickets
 *
 * WHY. Six R21 weekly wings have TWO ledger rows under ONE ticket id (loss-cap close voided for
 * evidence, restored on the board under the same id, settled at expiry by a prepend that left the
 * voided row in place). Every reader that summed rows counted each of those wings twice. The
 * append-only journal is keyed on the ticket id and did not, which is how the two came to disagree.
 * NOTES.md has the arithmetic and the whole list of readers this reaches.
 *
 *   node docs/wings-double-count/2026-10-16/deploy.cjs --plan     READ-ONLY. Per file: its sha256 at home
 *       NOW, the sha256 this package was BUILT AGAINST (base) and the STAGED one, its state — base (to
 *       apply) · new · applied · unchanged · DRIFT (refused) — and why it changes. Nothing is written.
 *   node docs/wings-double-count/2026-10-16/deploy.cjs --apply    the write mode, in order:
 *     1. every file reads base (or is absent and NEW) or already reads applied; DRIFT refuses and
 *        nothing is written. The package's own base and staged copies must be the bytes it was built with.
 *     2. this package's selftest must end "ALL <n> CHECKS PASSED" (known-answer tests on fixtures)
 *     3. home's files are written from staged (temp file + rename), each read back by sha256, then
 *        node --check. Any failure puts every file this run touched back as it was.
 *   It never writes a ledger, a registry, a seal or a JSON store, never calls a broker, and keeps no
 *   state file: home's bytes are the state. Exit 0 applied (or nothing to apply) · 1 failed · 2 refused.
 *
 * AFTER APPLYING, the numbers these five report CHANGE wherever a duplicate ticket id existed. That is
 * the point of the change and it BREAKS COMPARABILITY with anything quoted from them before today.
 * record.cjs --dry shows the change-registry entry that says so; the operator writes it.
 */
const L = require("./lib.cjs");

if (require.main === module) {
  const args = process.argv.slice(2), MODE = args.length === 1 && ["--plan", "--apply"].includes(args[0]) ? args[0] : null;
  if (!MODE) {
    console.log(`usage: node ${L.PKG_REL}/deploy.cjs --plan | --apply
  --plan   read-only: every file's sha256 now / base / staged, its state, why it changes, the refusals
  --apply  the write mode: drift refusal, then the selftest gate, then the writes (each read back + node --check)
Nothing was done.`);
    process.exit(2);
  }
  const P = L.plan();
  if (MODE === "--plan") { L.printPlan(P, { title: "PLAN — wings double count: one row per ticket", mode: "apply" }); process.exit(0); }

  console.log(`APPLY — wings double count — ${new Date().toISOString().slice(0, 16)}Z (${L.mtWords(Date.now())} MT)`);
  const M = L.make(), r = M.writeUnit({ to: "staged", gate: M.selftestGate });
  if (r.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${r.why.join("\n  - ")}`); process.exit(2); }
  if (r.result === "failed") {
    console.error(`APPLY FAILED: ${r.why.join("; ")}`);
    console.error(r.restored ? "  every file this run touched is back as it was." : `  NOT RESTORED: ${(r.notRestored || []).join("; ")} — put them back by hand from ${L.PKG_REL}/base/ (node ${L.PKG_REL}/rollback.cjs --apply)`);
    process.exit(1);
  }
  console.log(`\nAPPLIED: ${r.written.length ? "home now holds the staged " + r.written.join(", ") : "home already held the staged bytes"}.`);
  console.log("  Nothing was restarted and nothing needs to be: these five files are read by scripts that start a new process each run.");
  console.log("  WHAT MOVES: every number that came through lib.reconcile cleanEraLedger() — the profit-program printers, pp-board-legs,");
  console.log("  pp-concentration, options-lane-baseline and the other options printers, ml-daily, pooling-audit, risk-model-fit,");
  console.log("  cluster-pnl-ledger, progress-top10, r146 — plus daily-postmortem, integrity-audit and options-news-shadow directly.");
  console.log("  A ticket that had one row is unchanged. A ticket that had two now counts once. BREAKS COMPARABILITY: see NOTES.md.");
  console.log(`  NEXT: node backend/lib/reconcile.js            (the canonical figures, with the new tickets line)`);
  console.log(`        node backend/integrity-audit.js         (section 2b names every duplicate ticket id at home)`);
  console.log(`        node ${L.PKG_REL}/record.cjs --dry, then without --dry once the output has been read`);
  process.exit(0);
}
