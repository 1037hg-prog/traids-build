#!/usr/bin/env node
"use strict";
/**
 * W5 MD CHECK FIX (2026-10-15) — ROLLBACK: the live docs/server/wave5-board/deploy.cjs goes back to base/deploy.cjs, BYTE FOR BYTE.
 *
 *   node docs/w5-md-check-fix/2026-10-15/rollback.cjs --plan    READ-ONLY: the live file's state and what --apply would do
 *   node docs/w5-md-check-fix/2026-10-15/rollback.cjs --apply   the write mode — the main session's command
 *   ... [--root <dir>]                                          act on <dir> as the repo root (a scratch copy — the selftest's use)
 *
 * applied (the live file is the staged copy) -> the base bytes are written back (temp file + rename) and read back: sha256 = the pinned
 *   base; then node --check, and the live `deploy.cjs --selftest` is run and reported (nothing is undone on its answer).
 * base -> nothing to do (exit 0). DRIFT (neither) or missing -> REFUSED: someone changed the file after the apply, and copying the base
 *   over it would lose that change — read it first. Only the base copy must be intact for a rollback (base/deploy.cjs = BASE_SHA); a
 *   changed staged copy does not stop it. REFUSED too while a docs/server/wave5-board/deploy.cjs process runs (the same guard as the
 *   apply, deploy.cjs procGuard, for this root: any relative path ending in wave5-board/deploy(.cjs), this root's own file by absolute
 *   path, a bare deploy.cjs; another tree's copy that is there does not refuse; a failed process scan refuses). It looks once, right before
 *   the write (only a file read lies between). W5MD_SELFTEST_PROCS stands in for the scan on a scratch --root only.
 * WHAT A ROLLBACK DOES NOT UNDO: a W5 cutover that the fixed check let through (the units stay server-owned: their way back is
 *   `node docs/server/wave5-board/rollback.cjs --cutover`), and the record.cjs rows (rows are never removed: a rollback after a record is
 *   said in a NEW change-registry row). AFTER A ROLLBACK `--cutover w5` refuses again with "not installed in this tree" (unless
 *   --without-schwab is given, and then its message says again that the Schwab steps will be refused).
 * Exit 0 rolled back / nothing to roll back / plan · 1 a write did not read back as the base · 2 refused or usage.
 */
const fs = require("fs"), path = require("path");
const D = require("./deploy.cjs");

/** READ-ONLY -> { P, problems, todo: "restore" | "nothing" } — the rollback's view (the staged copy's integrity does not matter here) */
function rollbackPlan({ root = D.REPO, pkg = D.PKG } = {}) {
  const P = D.plan({ root, pkg }), problems = [];
  if (P.baseSha !== D.BASE_SHA) problems.push(...P.problems.filter((x) => /base\/deploy\.cjs/.test(x)));
  if (P.state === "drift" || P.state === "missing") problems.push(...P.problems.filter((x) => /^DRIFT|is missing under/.test(x)));
  return { P, problems, todo: P.state === "applied" ? "restore" : "nothing" };
}
/** --apply -> { code, result, lines } (never throws on a refusal). selftestAfter / writeExact: the selftest injects stand-ins (as for the apply);
 *  the defaults are the real ones (D.deploySelftest, D.writeExact) */
function rollback({ root = D.REPO, pkg = D.PKG, procs, log = (s) => console.log(s), selftestAfter = D.deploySelftest, writeExact: write = D.writeExact } = {}) {
  const lines = [], say = (s) => { lines.push(s); log(s); };
  const R = rollbackPlan({ root, pkg });
  say(`ROLLBACK — W5 md check fix — ${new Date().toISOString().slice(0, 16)}Z (${D.mtWords(Date.now())} MT) — root ${root}`);
  say(`  ${D.LIVE_REL}: ${R.P.state} (live ${String(R.P.liveSha).slice(0, 12)} · base ${D.BASE_SHA.slice(0, 12)} · staged ${D.STAGED_SHA.slice(0, 12)})`);
  if (R.problems.length) { say(`REFUSED — nothing written:\n  - ${R.problems.join("\n  - ")}`); return { code: 2, result: "refused", lines }; }
  if (R.todo === "nothing") { say("NOTHING TO ROLL BACK — the live file is the base copy already; nothing written"); return { code: 0, result: "nothing", lines }; }
  const g = D.procGuard(D.procsNow(procs), { root }); if (g) { say(`REFUSED — nothing written: ${g}`); return { code: 2, result: "refused", lines }; }   // one look is enough here: only a file read lies between it and the write
  const base = fs.readFileSync(path.join(pkg, "base", "deploy.cjs"));
  if (D.sha(base) !== D.BASE_SHA) { say("REFUSED — nothing written: base/deploy.cjs changed while this ran"); return { code: 2, result: "refused", lines }; }
  const got = write(R.P.liveFile, base), now = fs.readFileSync(R.P.liveFile), same = now.equals(base);   // the writer's read-back sha AND the bytes read again here: both must be the base
  if (got !== D.BASE_SHA || !same) { say(`FAILED: the live file read back ${String(same ? got : D.sha(now)).slice(0, 12)}, not the base — copy ${D.PKG_REL}/base/deploy.cjs over ${D.LIVE_REL} by hand`); return { code: 1, result: "failed", lines }; }
  say(`  written: ${D.LIVE_REL} = base/deploy.cjs, byte for byte (read back ${got.slice(0, 12)})`);
  const c = require("child_process").spawnSync(process.execPath, ["--check", R.P.liveFile], { encoding: "utf8", windowsHide: true });
  const st = selftestAfter(root);
  say(`  node --check ${c.status === 0 ? "ok" : "FAILED"} · the live deploy.cjs --selftest: ${st.passed == null ? `no result line (exit ${st.status})` : `${st.passed} passed, ${st.failed} failed`}`);
  say("ROLLED BACK. --cutover w5 now refuses again with \"not installed in this tree\". If record.cjs had recorded the fix, say the rollback in a NEW change-registry row.");
  return { code: 0, result: "rolled-back", lines };
}
module.exports = { rollbackPlan, rollback };

if (require.main === module) {
  const a = process.argv.slice(2); let root = D.REPO, mode = null, bad = null;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--plan" || a[i] === "--apply") { if (mode) bad = "give --plan or --apply once"; mode = a[i]; }
    else if (a[i] === "--root") { const v = a[++i]; if (!v || !fs.existsSync(path.join(v, ...D.LIVE_REL.split("/")))) bad = `--root needs a folder holding ${D.LIVE_REL}`; else root = path.resolve(v); }
    else bad = `unknown argument ${JSON.stringify(a[i])}`;
  }
  if (!mode || bad) { console.log(`${bad ? bad + "\n" : ""}usage: node ${D.PKG_REL}/rollback.cjs --plan | --apply [--root <scratch repo>]\nNothing was done.`); process.exit(2); }
  if (mode === "--plan") {
    const R = rollbackPlan({ root });
    console.log(`ROLLBACK PLAN — W5 md check fix — read-only, nothing is written\n  root ${root}\n  ${D.LIVE_REL}: ${R.P.state.toUpperCase()} (live ${String(R.P.liveSha).slice(0, 12)} · base ${D.BASE_SHA.slice(0, 12)} · staged ${D.STAGED_SHA.slice(0, 12)})`);
    console.log(R.problems.length ? `  REFUSED:\n    - ${R.problems.join("\n    - ")}` : R.todo === "restore" ? "  --apply would write base/deploy.cjs back over the live file, byte for byte" : "  nothing to roll back: the live file is the base copy");
    process.exit(R.problems.length ? 2 : 0);
  }
  const procs = D.cliProcs(root); if (procs !== undefined) console.log(`(the process list comes from ${process.env.W5MD_SELFTEST_PROCS}, W5MD_SELFTEST_PROCS: a scratch root only — the real repo always gets the real scan)`);
  let r; try { r = rollback({ root, procs }); } catch (e) { console.error(`ROLLBACK FAILED: ${e && e.stack ? e.stack : e}`); process.exit(1); }
  process.exit(r.code);
}
