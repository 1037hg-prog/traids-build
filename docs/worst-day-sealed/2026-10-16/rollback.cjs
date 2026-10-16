#!/usr/bin/env node
"use strict";
/**
 * WORST-DAY SEALED FORECAST LEDGER (2026-10-16) — ROLLBACK: the base state back, byte for byte.
 *
 * The base state of every file this package ships is ABSENT — they are all new (base/README.md). So the byte-exact inverse of an
 * apply is to REMOVE them, and that is all this does:
 *   - only a file whose live bytes are still byte for byte this package's staged copy is removed; anything else is DRIFT and the
 *     whole run is REFUSED (another hand changed it after the apply: compare it with staged/ and decide by hand)
 *   - a file that is already gone is nothing to do
 *   - the same fence as the apply: not 13:50-15:50 MT on a trading day
 *
 *   node docs/worst-day-sealed/2026-10-16/rollback.cjs --plan    READ-ONLY: what would be removed
 *   node docs/worst-day-sealed/2026-10-16/rollback.cjs --apply   remove them
 *
 * WHAT A ROLLBACK DOES NOT UNDO: rows already written into backend/data/worst-day/sealed-forecasts.jsonl and its tip file, and
 * backend/data/worst-day/sealed-grade.json. Those are DATA, not code; a sealed ledger is append-only and this never touches it. If
 * the job was scheduled, UNSCHEDULE IT FIRST — with the code gone the scheduled run would fail every night. The record written by
 * record.cjs is not undone either: registry rows are never removed.
 * Exit 0 removed / nothing to do · 1 failed · 2 refused or usage.
 */
const fs = require("fs"), path = require("path");
const L = require("./lib.cjs");

const args = process.argv.slice(2), MODE = args.length === 1 && (args[0] === "--plan" || args[0] === "--apply") ? args[0] : null;
if (!MODE) { console.log(`usage: node ${L.PKG_REL}/rollback.cjs --plan | --apply\nNothing was done.`); process.exit(2); }

let U, P;
try { U = L.unit(); P = L.plan({ U }); } catch (e) { console.error(`the package's staged copies cannot be read: ${e.message}`); process.exit(2); }
const mt = L.mtNow(), rec = ((L.readState().applied || {}).files) || {};
console.log(`ROLLBACK ${MODE === "--plan" ? "PLAN (nothing is written)" : ""} — worst-day sealed forecast ledger — ${mt.dow} ${mt.date} ${mt.hms} MT`);
for (const f of P.files) console.log(`  ${f.rel.padEnd(42)} ${(f.state === "drift" ? "DRIFT" : f.state).padEnd(8)}${f.state === "applied" ? " -> removed (its base state is absent)" : f.state === "absent" ? " -> nothing to do" : ` -> REFUSED: ${f.problem}`}${rec[f.rel] ? "   this package recorded writing it" : "   this package has no record of writing it"}`);
console.log("  the ledger itself (backend/data/worst-day/sealed-forecasts.jsonl, its tip and sealed-grade.json) is DATA and is never touched here.");
console.log("  if the nightly job was scheduled, unschedule it before removing the code.");

const toRemove = P.files.filter((f) => f.state === "applied");
const why = [];
if (P.drift.length) why.push(...P.drift.map((d) => `DRIFT: ${d.problem}`));
const fz = L.fences({ P }).filter((w) => !/^DRIFT:/.test(w));
why.push(...fz);

if (MODE === "--plan") {
  console.log(`  fences now: ${why.length ? "the write mode would be REFUSED:\n    - " + why.join("\n    - ") : "clear"}`);
  console.log(`  ${toRemove.length ? `${toRemove.length} file(s) would be removed` : "nothing to roll back"}; nothing was written.`);
  process.exit(P.drift.length ? 1 : 0);
}
if (why.length) { console.error(`REFUSED — nothing changed:\n  - ${why.join("\n  - ")}`); L.logRow({ script: "rollback", result: "refused", why }); process.exit(2); }
if (!toRemove.length) { console.log("nothing to roll back."); L.logRow({ script: "rollback", result: "noop" }); process.exit(0); }

const removed = [], left = [];
for (const f of toRemove) {
  const p = L.livePath(f.rel), b = L.readOrNull(p);
  if (!b || L.sha(b) !== f.stagedSha) { left.push(`${f.rel} (it changed while this ran)`); continue; }
  try { fs.unlinkSync(p); removed.push(f.rel); } catch (e) { left.push(`${f.rel} (${e.code || e.message})`); }
}
for (const rel of removed) console.log(`  removed ${rel}`);
L.writeState({ ...L.readState(), rolledBack: { at: new Date().toISOString(), by: `${L.PKG_REL}/rollback.cjs`, removed, left } });
L.logRow({ script: "rollback", result: left.length ? "rolled-back-with-problems" : "rolled-back", removed, left });
if (left.length) { console.error(`NOT A CLEAN ROLLBACK — still on disk: ${left.join(", ")}`); process.exit(1); }
console.log(`ROLLED BACK — ${removed.length} file(s) removed; backend/worst-day is as it was before the apply. Nothing to restart.`);
process.exit(0);
