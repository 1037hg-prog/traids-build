#!/usr/bin/env node
"use strict";
/**
 * WINGS DOUBLE COUNT (2026-10-16) — ROLLBACK. Puts home back to base, byte for byte.
 *
 * The four changed files are written from base/. backend/lib/ticket-rows.js is DELETED: it does not
 * exist at base, so deleting it is restoring it byte for byte. Nothing else requires it once the other
 * four are back at base — and that is checked, not assumed: after the writes, every restored file is
 * read back by sha256 and node --check'd, and `--plan` tells you which files would move.
 *
 * A rollback restores the DOUBLE COUNT. That is what rolling back this package means: a revoided ticket
 * goes back to counting twice in every reader on lib/reconcile.js, and daily-postmortem, integrity-audit
 * and options-news-shadow go back to counting rows. Do it to get out of trouble, not to settle an argument.
 *
 *   node docs/wings-double-count/2026-10-16/rollback.cjs --plan     READ-ONLY: what would move, and the refusals
 *   node docs/wings-double-count/2026-10-16/rollback.cjs --apply    write base over applied; refuses on DRIFT
 *
 * DRIFT refuses here too: a file at home that is neither base nor staged has been changed since this
 * package was built, and this rollback has no idea what that change was. Read it first.
 * The selftest gate is NOT run for a rollback: the point of a rollback is to get back to base whether or
 * not the staged code passes. The drift refusal and the per-file read-back are the safety here.
 * Exit 0 rolled back (or nothing to roll back) · 1 failed · 2 refused.
 */
const L = require("./lib.cjs");

if (require.main === module) {
  const args = process.argv.slice(2), MODE = args.length === 1 && ["--plan", "--apply"].includes(args[0]) ? args[0] : null;
  if (!MODE) {
    console.log(`usage: node ${L.PKG_REL}/rollback.cjs --plan | --apply
  --plan   read-only: every file's sha256 now / base / staged, its state, the refusals
  --apply  write base over applied (and DELETE the new file, which is its base state); refuses on DRIFT
Nothing was done.`);
    process.exit(2);
  }
  const P = L.plan({ forRollback: true });
  if (MODE === "--plan") { L.printPlan(P, { title: "PLAN — ROLLBACK of the wings double count (home back to base)", mode: "rollback" }); process.exit(0); }

  console.log(`ROLLBACK — wings double count — ${new Date().toISOString().slice(0, 16)}Z (${L.mtWords(Date.now())} MT)`);
  const M = L.make(), r = M.writeUnit({ to: "base" });
  if (r.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${r.why.join("\n  - ")}`); process.exit(2); }
  if (r.result === "failed") {
    console.error(`ROLLBACK FAILED: ${r.why.join("; ")}`);
    console.error(r.restored ? "  every file this run touched is back as it was before the rollback started." : `  NOT RESTORED: ${(r.notRestored || []).join("; ")} — put them back by hand from ${L.PKG_REL}/base/ and delete backend/lib/ticket-rows.js`);
    process.exit(1);
  }
  console.log(`\nROLLED BACK: ${r.written.length ? "home is back at base for " + r.written.join(", ") : "home already read base"}.`);
  console.log("  The double count is back with it: a ticket with two rows counts twice again. Say so wherever a number from today was quoted.");
  process.exit(0);
}
