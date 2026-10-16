#!/usr/bin/env node
"use strict";
/**
 * WORST-DAY SEALED FORECAST LEDGER (2026-10-16) — DEPLOY. It adds SEVEN NEW FILES under backend/worst-day/ and changes none:
 *
 *   backend/worst-day/sealed-ledger.js      backend/worst-day/nightly-model.js      backend/worst-day/sealed-grade.js
 *   backend/worst-day/sealed-check.js       backend/worst-day/nightly-forecast.js   backend/worst-day/sealed-fixtures.js
 *   backend/worst-day/sealed-selftest.js
 *
 * Nothing that runs today loads any of them. Landing them changes no behaviour at all: the nightly job runs when the operator
 * schedules it, and until then these files sit on disk. NOTES.md says what each one does and what it is worth.
 *
 *   node docs/worst-day-sealed/2026-10-16/deploy.cjs --plan    READ-ONLY. Each file: the sha of the staged copy, what is at the live
 *                                                              path now, and its state — absent (to write) · applied · DRIFT
 *                                                              (something else is already there: refused whole). The fences now.
 *                                                              Nothing is written. Exit 0, or 1 on DRIFT.
 *   node docs/worst-day-sealed/2026-10-16/deploy.cjs --apply   the write mode — the operator's command, never run by the build.
 *     1. every file reads absent or applied; one DRIFT refuses the whole run and nothing is written
 *     2. fences: not 13:50-15:50 MT on a trading day (the close chain owns backend/ then)
 *     3. selftest.cjs must end ALL n CHECKS PASSED
 *     4. every staged file passes node --check; the fences and the live paths are read again
 *     5. each file is written (temp file + rename) and verified by sha; a failure removes every file this run wrote
 *     6. node --check of each written file, then the written sealed-selftest.js is run FROM THE LIVE TREE and must pass; a failure
 *        removes every file this run wrote
 *     7. deploy-state.json records what was written; deploy-log.jsonl gets one row
 *
 * Exit 0 applied / nothing to do · 1 failed (the headline says whether it was undone) · 2 refused or usage.
 * It never writes backend/data, a registry file, the chain file or a switch; makes no ssh call; sends no order; starts, stops and
 * restarts nothing; and never requires automation/close-chain.cjs.
 */
const fs = require("fs"), path = require("path"), cp = require("child_process");
const L = require("./lib.cjs");

const args = process.argv.slice(2), MODE = args.length === 1 && (args[0] === "--plan" || args[0] === "--apply") ? args[0] : null;
if (!MODE) { console.log(`usage: node ${L.PKG_REL}/deploy.cjs --plan | --apply\n  --plan   read-only: each file's state and whether an apply would be refused\n  --apply  the write mode (refused 13:50-15:50 MT on a trading day, and on any DRIFT)\nNothing was done.`); process.exit(2); }

let U, P;
try { U = L.unit(); P = L.plan({ U }); } catch (e) { console.error(`the package's staged copies cannot be read: ${e.message}`); process.exit(MODE === "--plan" ? 1 : 2); }
const mt = L.mtNow();
console.log(`${MODE === "--plan" ? "PLAN" : "APPLY"} — worst-day sealed forecast ledger — ${L.FILES.length} NEW files, 0 changed — ${mt.dow} ${mt.date} ${mt.hms} MT`);
for (const f of P.files) {
  console.log(`  ${f.rel.padEnd(42)} ${(f.state === "drift" ? "DRIFT" : f.state).padEnd(8)} staged ${f.stagedSha.slice(0, 12)} (${String(f.bytes).padStart(6)} bytes)${f.liveSha ? `   live ${f.liveSha.slice(0, 12)}` : ""}`);
  console.log(`  ${"".padEnd(42)}          ${f.why}`);
  if (f.problem) console.log(`  ${"".padEnd(42)}          ${f.problem}`);
}
console.log(`\n  base/ holds no copies: every file above is NEW, so its base state is 'absent'. Rollback removes exactly the files this package wrote.`);
console.log(`  unit: ${P.state === "drift" ? `DRIFT — the write mode REFUSES. Read what is at ${P.drift.map((d) => d.rel).join(", ")} before anything is written.` : P.state === "applied" ? "every file is already this package's copy — nothing to apply" : `${P.todo.length} file(s) would be written, ${P.files.length - P.todo.length} already there`}`);

const fz = L.fences({ P });
if (MODE === "--plan") {
  console.log(`  fences now: ${fz.length ? "the write mode would be REFUSED:\n    - " + fz.join("\n    - ") : "clear"}`);
  console.log("  nothing was written.");
  process.exit(P.state === "drift" ? 1 : 0);
}

// ───────────────────────────────────────────────────────── --apply ─────────────────────────────────────────────────────────
const child = (file, argv = []) => cp.spawnSync(process.execPath, [file, ...argv], { encoding: "utf8", cwd: L.REPO, timeout: 1800000, windowsHide: true, maxBuffer: 64 << 20 });
const refuse = (why) => { console.error(`REFUSED — nothing changed:\n  - ${why.join("\n  - ")}`); L.logRow({ script: "deploy", result: "refused", why }); process.exit(2); };
if (fz.length) refuse(fz);
if (P.state === "applied") { console.log("nothing to apply."); L.logRow({ script: "deploy", result: "noop" }); process.exit(0); }

{ const bad = P.files.filter((f) => cp.spawnSync(process.execPath, ["--check", L.stagedPath(f.rel)], { encoding: "utf8", windowsHide: true }).status !== 0);
  if (bad.length) refuse(bad.map((f) => `the staged ${f.rel} does not pass node --check`)); }

{ const r = child(path.join(L.PKG, "selftest.cjs"));
  const out = String(r.stdout || "") + String(r.stderr || ""), last = (out.trim().split(/\r?\n/).slice(-1)[0] || "").slice(0, 160);
  if (r.status !== 0 || !/^ALL \d+ CHECKS PASSED/.test(last)) refuse([`the package's selftest does not pass (exit ${r.status}): ${last}`]);
  console.log(`  selftest: ${last}`); }

// read everything once more, then write
const P2 = L.plan({ U }), fz2 = L.fences({ P: P2 });
if (fz2.length) refuse(fz2);
const written = [];
let failure = null;
for (const f of P2.todo) {
  const dst = L.livePath(f.rel), tmp = dst + ".tmp-" + process.pid;
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (fs.existsSync(dst)) throw new Error("it appeared at the live path while this run was going");
    const fd = fs.openSync(tmp, "wx");
    try { fs.writeFileSync(fd, U[f.rel].staged); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, dst);
    const back = L.readOrNull(dst);
    if (!back || L.sha(back) !== f.stagedSha) throw new Error(`it does not read back as the staged copy (${back ? L.sha(back).slice(0, 12) : "missing"})`);
    const c = cp.spawnSync(process.execPath, ["--check", dst], { encoding: "utf8" });
    if (c.status !== 0) throw new Error(`node --check of the written file failed: ${String(c.stderr || "").trim().split("\n")[0]}`);
    written.push(f.rel);
    console.log(`  written ${f.rel.padEnd(42)} ${f.stagedSha.slice(0, 12)}`);
  } catch (e) { try { fs.unlinkSync(tmp); } catch { /* not there */ } failure = `${f.rel}: ${e.message}`; break; }
}
/** remove exactly what this run wrote, and only while each is still byte for byte the staged copy */
function undo() {
  const left = [];
  for (const rel of written.slice().reverse()) {
    const b = L.readOrNull(L.livePath(rel));
    if (b && L.sha(b) === U[rel].stagedSha) { try { fs.unlinkSync(L.livePath(rel)); } catch (e) { left.push(`${rel} (${e.code || e.message})`); } }
    else left.push(`${rel} (it is no longer this package's copy)`);
  }
  return left;
}
if (failure) {
  const left = undo();
  console.error(`APPLY FAILED: ${failure}\n  ${left.length ? `NOT FULLY UNDONE — still on disk: ${left.join(", ")} — remove them by hand` : "every file this run wrote was removed"}`);
  L.logRow({ script: "deploy", result: "failed", why: [failure], written, stillThere: left });
  process.exit(1);
}
// the written tree must prove itself from where it now lives
{ const r = child(L.livePath("backend/worst-day/sealed-selftest.js"));
  const out = String(r.stdout || "") + String(r.stderr || ""), last = (out.trim().split(/\r?\n/).slice(-1)[0] || "").slice(0, 160);
  if (r.status !== 0 || !/^ALL \d+ CHECKS PASSED/.test(last)) {
    const left = undo();
    console.error(`APPLIED, THEN THE LIVE SELFTEST FAILED (exit ${r.status}): ${last}\n  ${left.length ? `NOT FULLY UNDONE — still on disk: ${left.join(", ")}` : "every file this run wrote was removed"}`);
    L.logRow({ script: "deploy", result: "applied-verify-failed", why: [last], written, stillThere: left });
    process.exit(1);
  }
  console.log(`  live selftest: ${last}`); }

L.writeState({ ...L.readState(), applied: { at: new Date().toISOString(), by: `${L.PKG_REL}/deploy.cjs`, files: Object.fromEntries(written.map((rel) => [rel, { sha: U[rel].stagedSha, wasAbsent: true }])) } });
L.logRow({ script: "deploy", result: "applied", written });
console.log(`\nSEALED FORECAST LEDGER APPLIED — ${written.length} new file(s). Nothing changed behaviour: no live code loads them yet.`);
console.log("  NEXT (NOTES.md, 'The order to apply'), in this order:");
console.log(`    1. the record:   node ${L.PKG_REL}/record.cjs --dry   then   node ${L.PKG_REL}/record.cjs`);
console.log("    2. the first row, dry:   node backend/worst-day/nightly-forecast.js --plan");
console.log("    3. when it reads right, schedule it in the evening chain:   node backend/worst-day/nightly-forecast.js --write");
console.log("    4. the checker, any time:   node backend/worst-day/sealed-check.js   (the grader needs matured rows: node backend/worst-day/sealed-grade.js --dry)");
console.log(`  Rollback: node ${L.PKG_REL}/rollback.cjs --plan, then --apply (it removes exactly these files).`);
process.exit(0);
