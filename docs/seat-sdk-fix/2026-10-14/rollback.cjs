#!/usr/bin/env node
"use strict";
/**
 * SEAT-SDK FIX (2026-10-14, option B) — ROLLBACK: put the three live files back to their base bytes, byte for byte (base/ here holds a
 * copy of each as it was when the package was built; deploy.cjs FILES pins their sha256).
 *
 *   node docs/seat-sdk-fix/2026-10-14/rollback.cjs --plan     READ-ONLY: each file's state and what would be put back
 *   node docs/seat-sdk-fix/2026-10-14/rollback.cjs --apply    the write mode (the same fences as deploy.cjs: not while the seat wave
 *                                                             runs, not 16:05-18:30 MT on a trading weekday)
 * A file that reads applied gets its base bytes (temp file + rename, read back by sha256, node --check); a file that reads base is left
 * alone; a file that reads DRIFT (neither base nor staged) refuses the whole rollback: it was changed since, so restore it by hand from
 * base/ after reading the change. Done = every file is its pinned base sha256 again ("byte for byte"); anything else exits 1.
 *
 * THE QUICK WAY BACK IS NOT THIS FILE. To take every seat off the SDK path at once, one command, no file written here:
 *     node automation/seat-sdk/set-provider.cjs cli
 * After a rollback the runner is the one of 2026-10-12 again: its start-of-session check wants bypassPermissions, which the launcher
 * never reports while CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is set, so an SDK seat would stop at its start again (as on 2026-10-13).
 * WHAT ROLLBACK DOES NOT UNDO: ledger rows already written, seat rows in the wave's history, claims sealed, credit spent, the switch.
 * Exit 0 back to the base bytes / nothing to do · 1 failed or not byte-exact · 2 refused or usage.
 */
const fs = require("fs"), path = require("path");
const D = require("./deploy.cjs");

/** after a rollback: is every file its pinned base sha256? -> { exact, lines } — one line for EVERY file (a file that differs does not hide the rest) */
function byteExact({ repo = D.REPO } = {}) {
  const lines = [], each = D.FILES.map((f) => { let s = null; try { s = D.sha(fs.readFileSync(path.join(repo, ...f.rel.split("/")))); } catch { s = null; } const ok = s === f.baseSha; lines.push(`  ${ok ? "base " : "NOT  "} ${f.rel}   sha256 ${s == null ? "(missing)" : s.slice(0, 12)}${ok ? "" : ` (base is ${f.baseSha.slice(0, 12)})`}`); return ok; });
  return { exact: each.length === D.FILES.length && each.every(Boolean), lines };
}
module.exports = { byteExact };

if (require.main === module) {
  const args = process.argv.slice(2), MODE = args.length === 1 && (args[0] === "--plan" || args[0] === "--apply") ? args[0] : null;
  if (!MODE) { console.log("usage: node docs/seat-sdk-fix/2026-10-14/rollback.cjs --plan | --apply\nNothing was done."); process.exit(2); }
  const P = D.plan({ forRollback: true });
  console.log(`ROLLBACK ${MODE === "--plan" ? "PLAN (nothing is written)" : ""} — seat-SDK fix, option B — ${D.mtWords(Date.now())} MT`);
  for (const x of P.files) console.log(`  ${x.rel}   ${x.state}${x.state === "applied" ? " -> base (" + x.baseSha.slice(0, 12) + ")" : x.state === "base" ? " (nothing to put back)" : ""}${x.problem && !/staged copy/.test(x.problem) ? "   PROBLEM: " + x.problem : ""}`);
  if (P.problems.length) console.log(`  the write mode would be REFUSED:\n    - ${P.problems.join("\n    - ")}`);
  if (MODE === "--plan") { let fz; try { fz = D.fences(); } catch (e) { fz = [`the fences could not be read (${e.message})`]; } console.log(`  fences now: ${fz.length ? "the write mode would be REFUSED:\n    - " + fz.join("\n    - ") : "clear"}\n  nothing was written.`); process.exit(0); }
  const r = D.make().writeUnit({ to: "base" });
  if (r.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${r.why.join("\n  - ")}`); process.exit(2); }
  if (r.result === "failed") { console.error(`ROLLBACK FAILED: ${r.why.join("; ")}${r.restored ? " — the files are as they were before this run" : " — NOT RESTORED: " + (r.notRestored || []).join("; ")}`); process.exit(1); }
  const b = byteExact();
  for (const l of b.lines) console.log(l);
  console.log(b.exact ? "ROLLED BACK: every file is byte for byte its base copy. Nothing to restart. The switch is what it was: to take the seats off the SDK path, node automation/seat-sdk/set-provider.cjs cli"
    : "NOT A CLEAN ROLLBACK: a file is not its base bytes (read the lines above; restore it by hand from base/).");
  process.exit(b.exact ? 0 : 1);
}
