#!/usr/bin/env node
"use strict";
/**
 * R354 FUND DISCOUNTS (2026-10-16) — DEPLOY the runner, its engine and the nightly recorder.
 *
 * WHAT IT SHIPS. THREE NEW FILES, none of which exists in the live tree, so no live behaviour changes when they land:
 *   backend/lib/fund-discount.js        R354's engine (pure functions; no file, no network, no clock, no environment variable)
 *   backend/r354-fund-discounts.js      R354's runner: --selftest, --status, --controls, --read, --dollar-table
 *   backend/fund-nav-record.js          the nightly price + published-NAV recorder (R354.openOperatorItems[0]); belongs to no test
 * NOTHING ELSE IS TOUCHED: no registry, no cron, no chain, no existing file. base/ therefore holds NO copies — the state each file
 * starts from is ABSENCE, and that is what a rollback restores (NOTES.md, "base is absence").
 *
 *   node docs/fund-discounts/2026-10-16/deploy.cjs --plan     READ-ONLY. Each file: its sha256 at home now, the staged sha256, and
 *                                                             its state — new (to write) · applied · DRIFT (refused). Nothing written.
 *   node docs/fund-discounts/2026-10-16/deploy.cjs --apply    the write mode. In order: 1) every file reads new or applied (DRIFT
 *                                                             refuses the whole package, nothing written); 2) the package's own
 *                                                             staged copies hash to the bytes that were reviewed; 3) this package's
 *                                                             selftest must end "ALL n CHECKS PASSED"; 4) the files are written
 *                                                             (temp file + rename), read back by sha256, then node --check.
 * IT NEVER: restarts or schedules anything, writes test-registry.json / change-registry.json / agent-ledger.jsonl (record.cjs does
 * that, after a verify at home), runs a READ of R354 (interimKill: --read is in the build loop's forbidden list), or touches
 * backend/data. A cloud session builds and tests this package; the operator runs --apply at home.
 * Exit 0 applied (or already applied) · 1 failed · 2 refused or usage.
 */
const fs = require("fs"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", ".."), PKG_REL = "docs/fund-discounts/2026-10-16";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
/** the three files, with the sha256 of the staged bytes that were reviewed (base is absence: baseSha null) */
const FILES = Object.freeze([
  Object.freeze({ rel: "backend/lib/fund-discount.js", staged: "staged/backend/lib/fund-discount.js", baseSha: null, stagedSha: /*S1*/"9de3a09d982ac592214a16bbcf055cb7be4c67279586bb691f58a620d1fa18cb"/*E1*/ }),
  Object.freeze({ rel: "backend/r354-fund-discounts.js", staged: "staged/backend/r354-fund-discounts.js", baseSha: null, stagedSha: /*S2*/"0513e75c278399421d9ebae4ab104a1364bf0865ca3287e91d2b53fa7a8019a1"/*E2*/ }),
  Object.freeze({ rel: "backend/fund-nav-record.js", staged: "staged/backend/fund-nav-record.js", baseSha: null, stagedSha: /*S3*/"23a8713ca6e6587eaf78f4892566e2fbae54b158c1a17e04ab019e9302844434"/*E3*/ }),
]);
const read = (p) => { try { return fs.readFileSync(p); } catch { return null; } };

/**
 * ONE FILE'S STATE.
 *   new      home does not have it: --apply writes the staged bytes (this is the whole package)
 *   applied  home holds exactly the staged bytes: --apply writes nothing
 *   DRIFT    home holds something else: REFUSED — someone else wrote this path since the package was built; read it first
 */
function fileState(f, { repo = REPO, pkg = PKG } = {}) {
  const home = read(path.join(repo, ...f.rel.split("/"))), staged = read(path.join(pkg, ...f.staged.split("/")));
  const r = { rel: f.rel, home: home ? sha(home) : null, staged: staged ? sha(staged) : null, stagedSha: f.stagedSha, baseSha: f.baseSha, problem: null, state: null };
  if (r.staged !== f.stagedSha) r.problem = `the package's staged copy ${f.staged} is ${r.staged ? "not the bytes that were reviewed" : "missing"}`;
  r.state = !home ? "new" : r.home === f.stagedSha ? "applied" : "DRIFT";
  return r;
}
/** the plan of the whole package; problems are refusals */
function plan({ repo = REPO, pkg = PKG } = {}) {
  const files = FILES.map((f) => fileState(f, { repo, pkg })), problems = [];
  for (const x of files) {
    if (x.problem) problems.push(`${x.rel}: ${x.problem}`);
    if (x.state === "DRIFT") problems.push(`${x.rel} is DRIFT at home: its sha256 ${String(x.home).slice(0, 12)} is neither absent (what this package was built against) nor the staged ${x.stagedSha.slice(0, 12)} — someone wrote that path since this package was built: read the change, then rebuild the package`);
  }
  return { files, problems, todo: files.filter((x) => x.state === "new"), applied: files.every((x) => x.state === "applied") };
}
/** write bytes so that the file is either absent, the old one or the new one, never half (temp file + rename), then read back */
function writeExact(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-r354-${process.pid}`, fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  if (sha(fs.readFileSync(file)) !== sha(buf)) throw new Error(`${file} does not read back as written`);
}
/** the package's own selftest as the gate before any write */
function selftestGate({ repo = REPO } = {}) {
  const r = cp.spawnSync(process.execPath, [path.join(PKG_REL, "selftest.cjs")], { cwd: repo, encoding: "utf8", timeout: 1800000, maxBuffer: 256 << 20 });
  const last = String(String(r.stdout || "") + String(r.stderr || "")).trim().split("\n").pop() || "";
  return { ok: r.status === 0 && /^ALL \d+ CHECKS PASSED/.test(last), line: last };
}
/** --apply: refuse, gate, then write. It returns what it did and never throws on a refusal. */
function apply({ repo = REPO, pkg = PKG, log = console.log, gate = selftestGate } = {}) {
  const P = plan({ repo, pkg });
  if (P.problems.length) return { result: "refused", why: P.problems };
  if (P.applied) { log("  home already holds the staged bytes of all three files: nothing to write."); return { result: "done", written: [] }; }
  log(`  gate: this package's selftest (node ${PKG_REL}/selftest.cjs) …`);
  const g = gate({ repo });
  if (!g.ok) return { result: "refused", why: [`the package's selftest did not end "ALL n CHECKS PASSED": ${g.line || "(no output)"}`] };
  log(`  gate: ${g.line}`);
  const written = [];
  for (const x of P.todo) {
    const f = FILES.find((y) => y.rel === x.rel), file = path.join(repo, ...x.rel.split("/"));
    const buf = fs.readFileSync(path.join(pkg, ...f.staged.split("/")));
    try { writeExact(file, buf); } catch (e) {
      for (const done of written) { try { fs.unlinkSync(path.join(repo, ...done.split("/"))); } catch { /* already gone */ } }
      return { result: "failed", why: [`writing ${x.rel}: ${e.message}`], restored: true, written: [] };
    }
    written.push(x.rel);
    const c = cp.spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (c.status !== 0) {
      for (const done of written) { try { fs.unlinkSync(path.join(repo, ...done.split("/"))); } catch { /* already gone */ } }
      return { result: "failed", why: [`${x.rel} does not parse after the write: ${String(c.stderr).trim().split("\n")[0]}`], restored: true, written: [] };
    }
    log(`  wrote ${x.rel}  sha256 ${sha(buf).slice(0, 12)} (new file), read back and node --check ok`);
  }
  return { result: "done", written };
}
function printPlan(P) {
  console.log(`PLAN — R354 fund discounts (the runner, its engine and the nightly recorder) — ${new Date().toISOString().slice(0, 16)}Z — read-only, nothing is written`);
  for (const x of P.files) {
    console.log(`\n  ${x.rel}`);
    console.log(`      home now   ${x.home || "(absent — this is a new file)"}`);
    console.log(`      base       (absence: the file does not exist in the live tree; a rollback removes it again)`);
    console.log(`      staged     ${x.stagedSha}${x.staged === x.stagedSha ? "" : "   PACKAGE COPY DIFFERS: " + (x.staged || "missing")}`);
    console.log(`      state      ${x.state === "new" ? "new — the write mode would write the staged bytes" : x.state === "applied" ? "applied — home already holds them" : x.state}${x.problem ? "   PROBLEM: " + x.problem : ""}`);
  }
  console.log(`\n  unit: ${P.problems.length ? "REFUSED by the write mode:\n    - " + P.problems.join("\n    - ") : P.todo.length ? `the write mode would write ${P.todo.map((x) => x.rel).join(", ")} after this package's selftest passes` : "home already holds the staged bytes — the write mode would write nothing"}`);
  console.log("  nothing else changes: no registry, no cron, no chain, no data file. --apply NEVER runs a read of R354.");
}

module.exports = { PKG, REPO, PKG_REL, FILES, sha, fileState, plan, writeExact, apply, selftestGate, printPlan };

if (require.main === module) {
  const a = process.argv.slice(2), MODE = a.length === 1 && ["--plan", "--apply"].includes(a[0]) ? a[0] : null;
  if (!MODE) { console.log(`usage: node ${PKG_REL}/deploy.cjs --plan | --apply\nNothing was done.`); process.exit(2); }
  if (MODE === "--plan") { printPlan(plan()); process.exit(0); }
  console.log(`APPLY — R354 fund discounts — ${new Date().toISOString().slice(0, 16)}Z`);
  const r = apply({});
  if (r.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${r.why.join("\n  - ")}`); process.exit(2); }
  if (r.result === "failed") { console.error(`APPLY FAILED: ${r.why.join("; ")}\n  ${r.restored ? "every file this run wrote was removed again: home is as it was" : "NOT RESTORED — remove the files by hand"}`); process.exit(1); }
  console.log(`\nAPPLIED: ${r.written.length ? "home now holds " + r.written.join(", ") : "home already held the staged bytes"}. Nothing to restart: the three files are new and nothing calls them yet.`);
  console.log(`  NEXT, at home: node backend/r354-fund-discounts.js --selftest   (must end "ALL n PASSED")`);
  console.log(`                 node backend/r354-fund-discounts.js --status     (the read condition: it refuses until the cache is fetched and frozen)`);
  console.log(`                 node backend/fund-nav-record.js --dry            (one look at the real endpoints, writing nothing)`);
  console.log(`                 node ${PKG_REL}/record.cjs --dry                 (the governance records this package owes)`);
  process.exit(0);
}
