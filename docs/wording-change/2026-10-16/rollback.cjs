#!/usr/bin/env node
"use strict";
/**
 * ROLLBACK — filing wording collector (backlog row 25), 2026-10-16. The undo of deploy.cjs.
 *
 * Every file this package ships is NEW, so the base state of each one is ABSENT and rolling back means removing it again — byte for
 * byte the state home was in before --apply. It removes a file ONLY when that file is, to the byte, what this package staged: a
 * file someone has since edited is DRIFT and is left exactly where it is, with the refusal saying so, because this package is not
 * the author of those bytes and must not throw them away.
 *
 *   node docs/wording-change/2026-10-16/rollback.cjs --plan     READ-ONLY: each file's sha256 at home, and what --apply would do
 *   node docs/wording-change/2026-10-16/rollback.cjs --apply    remove the files this package created (DRIFT refuses, nothing removed)
 *   node docs/wording-change/2026-10-16/rollback.cjs --selftest the pure parts, against a scratch tree
 *
 * WHAT IT NEVER TOUCHES: backend/data/filing-wording/ — the records a run of the collector wrote. They are data, they took real
 * reading to make, and removing the code that wrote them is not a reason to delete them. --plan says whether any are there.
 * Exit 0 removed, or nothing to remove · 1 a removal failed · 2 refused, or the arguments were wrong (nothing was done).
 */
const fs = require("fs"), path = require("path");
const D = require(path.join(__dirname, "deploy.cjs"));
const { PKG, REPO, PKG_REL, FILES, sha, abs, readOrNull } = D;

/** what rollback would do to one file: remove · gone · DRIFT (leave it) */
function rollbackState(f, { repo = REPO } = {}) {
  const home = readOrNull(abs(repo, f.rel));
  if (!home) return { rel: f.rel, homeSha: null, state: "gone" };
  const h = sha(home);
  return { rel: f.rel, homeSha: h, state: h === f.stagedSha ? "remove" : "DRIFT" };
}
function rollbackPlan({ repo = REPO, files = FILES } = {}) {
  const states = files.map((f) => rollbackState(f, { repo }));
  const problems = states.filter((s) => s.state === "DRIFT").map((s) => `${s.rel} is not the file this package created (sha256 ${String(s.homeSha).slice(0, 12)}, this package staged ${files.find((f) => f.rel === s.rel).stagedSha.slice(0, 12)}): someone has edited it. It is LEFT ALONE — read the change, then remove it by hand if that is what you mean to do. REFUSED`);
  return { states, problems, todo: states.filter((s) => s.state === "remove") };
}
/** the store a run of the collector may have written — reported, never removed */
function storeFiles(repo = REPO) {
  const dir = path.join(repo, "backend", "data", "filing-wording");
  try { return fs.readdirSync(dir).filter((n) => /\.json$/.test(n)).map((n) => path.join("backend/data/filing-wording", n)); } catch { return []; }
}
/**
 * Remove the files this package created. Refuses as a whole on any DRIFT: a partial rollback would leave the collector requiring a
 * library that is no longer there.
 */
function rollbackApply({ repo = REPO, files = FILES, log = console.log } = {}) {
  const P = rollbackPlan({ repo, files });
  if (P.problems.length) return { result: "refused", why: P.problems, removed: [] };
  const removed = [], failed = [];
  for (const s of P.todo) {
    try { fs.unlinkSync(abs(repo, s.rel)); removed.push(s.rel); log(`  removed ${s.rel}`); }
    catch (e) { failed.push(`${s.rel}: ${e.message}`); }
  }
  // the two library files live in backend/lib, which held other files before this package: it is never removed
  if (failed.length) return { result: "failed", why: failed, removed };
  if (!removed.length) log("  nothing to remove — none of the three files is at home");
  return { result: "done", removed };
}

function printPlan(P, repo = REPO) {
  console.log(`ROLLBACK PLAN — filing wording collector — ${new Date().toISOString().slice(0, 16)}Z — read-only, nothing is removed`);
  for (const s of P.states) {
    const f = FILES.find((x) => x.rel === s.rel);
    console.log(`\n  ${s.rel}`);
    console.log(`      home now   ${s.homeSha || "(absent)"}`);
    console.log(`      staged     ${f.stagedSha}`);
    console.log(`      state      ${s.state === "remove" ? "--apply would REMOVE it (it is exactly what this package created)" : s.state === "gone" ? "already absent — nothing to do" : "DRIFT — someone edited it; --apply is REFUSED and the file is left alone"}`);
  }
  const data = storeFiles(repo);
  console.log(`\n  records written by the collector: ${data.length ? data.join(", ") + " — LEFT ALONE (rollback never removes data)" : "none at backend/data/filing-wording/"}`);
  console.log(`  unit: ${P.problems.length ? "REFUSED:\n    - " + P.problems.join("\n    - ") : P.todo.length ? `--apply would remove ${P.todo.length} file(s)` : "nothing to remove"}`);
}

function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d === undefined ? "" : " — " + d)); } };
  const os = require("os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wording-rollback-"));
  try {
    ok("with nothing at home there is nothing to remove, and no refusal", rollbackPlan({ repo: tmp }).todo.length === 0 && rollbackPlan({ repo: tmp }).problems.length === 0 && rollbackPlan({ repo: tmp }).states.every((s) => s.state === "gone"));
    const r0 = D.apply({ repo: tmp, gate: null, log: () => { } });
    ok("a full apply into a scratch tree creates all three files", r0.result === "done" && r0.wrote.length === 3 && FILES.every((f) => fs.existsSync(abs(tmp, f.rel))), JSON.stringify(r0.why || r0.wrote));
    ok("and the plan then reads applied for every one of them", D.plan({ repo: tmp }).states.every((s) => s.state === "applied") && D.plan({ repo: tmp }).todo.length === 0);
    ok("a second apply is idempotent: it writes nothing and reports nothing to do", (() => { const r = D.apply({ repo: tmp, gate: null, log: () => { } }); return r.result === "done" && r.wrote.length === 0; })());
    // data must survive a rollback
    fs.mkdirSync(path.join(tmp, "backend", "data", "filing-wording"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "backend", "data", "filing-wording", "0000000001.json"), "{}\n");
    const r1 = rollbackApply({ repo: tmp, log: () => { } });
    ok("rollback removes exactly the three files it created", r1.result === "done" && r1.removed.length === 3 && FILES.every((f) => !fs.existsSync(abs(tmp, f.rel))), JSON.stringify(r1));
    ok("rollback leaves the records the collector wrote where they are", fs.existsSync(path.join(tmp, "backend", "data", "filing-wording", "0000000001.json")) && storeFiles(tmp).length === 1);
    ok("rolling back twice is harmless", rollbackApply({ repo: tmp, log: () => { } }).result === "done");
    // drift
    D.apply({ repo: tmp, gate: null, log: () => { } });
    fs.appendFileSync(abs(tmp, FILES[1].rel), "\n// edited at home\n");
    const r2 = rollbackApply({ repo: tmp, log: () => { } });
    ok("an edited file is DRIFT: the whole rollback is refused and NOTHING is removed, not even the untouched files",
      r2.result === "refused" && /someone has edited it/.test(r2.why.join(" ")) && FILES.every((f) => fs.existsSync(abs(tmp, f.rel))), JSON.stringify(r2.why));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`rollback selftest: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASSED" : "FAILED"}`);
  return fail === 0;
}

module.exports = { rollbackState, rollbackPlan, rollbackApply, storeFiles, selftest };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const modes = argv.filter((a) => ["--plan", "--apply", "--selftest"].includes(a));
  if (argv.length !== 1 || modes.length !== 1) { console.error(`usage: node ${PKG_REL}/rollback.cjs --plan | --apply | --selftest  (one at a time) — nothing was done`); process.exitCode = 2; }
  else if (modes[0] === "--selftest") process.exitCode = selftest() ? 0 : 1;
  else if (modes[0] === "--plan") { printPlan(rollbackPlan()); process.exitCode = 0; }
  else {
    console.log(`ROLLBACK — filing wording collector — ${new Date().toISOString().slice(0, 16)}Z`);
    const r = rollbackApply({});
    if (r.result === "refused") { console.error(`REFUSED — nothing was removed:\n  - ${r.why.join("\n  - ")}`); process.exitCode = 2; }
    else if (r.result === "failed") { console.error(`ROLLBACK FAILED: ${r.why.join("; ")}\n  removed so far: ${r.removed.join(", ") || "none"}`); process.exitCode = 1; }
    else { console.log(`\nROLLED BACK: ${r.removed.length ? "removed " + r.removed.join(", ") : "nothing was there to remove"}. Records at backend/data/filing-wording/ were left alone.`); process.exitCode = 0; }
  }
}
