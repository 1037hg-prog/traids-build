#!/usr/bin/env node
"use strict";
/**
 * DEPLOY — filing wording collector (backlog row 25), 2026-10-16. Run by the operator from the repo root, at home.
 *
 * WHAT IT SHIPS: THREE NEW FILES. Nothing that exists today is changed, which is why base/ is empty (base/EMPTY.md says so): the
 * base state of every file in this package is ABSENT.
 *     backend/lib/filing-sections.js        the parse layer  (pure: sections, words, cosine)
 *     backend/lib/sec-fetch.js              the fetch layer  (injected fetcher, SEC's 10-a-second limit, declared User-Agent)
 *     backend/filing-wording-collector.js   the collector    (per-filing, per-section score against the previous filing)
 * It registers no test, writes no registry and no seal, installs no unit or task, places no order, and starts nothing. The only
 * thing a run of the collector ever writes is backend/data/filing-wording/<CIK>.json, through backend/lib/atomic-write.js.
 *
 *   node docs/wording-change/2026-10-16/deploy.cjs --plan     READ-ONLY. For each file: the sha256 this package holds, the sha256
 *                                                             at home now, and its state — absent (to create) · applied (home
 *                                                             already holds these bytes) · DRIFT (home holds something else:
 *                                                             refused). Nothing is written and no network is touched.
 *   node docs/wording-change/2026-10-16/deploy.cjs --apply    the write mode. In order:
 *       1. every staged copy hashes to the sha256 recorded below, and every target is absent or already applied (DRIFT refuses
 *          and nothing is written);
 *       2. the package selftest must end "ALL <n> CHECKS PASSED";
 *       3. each file is written by temp-file-and-rename, read back by sha256, then node --check. A failure puts back exactly what
 *          this run had changed (an absent file is removed again) and says so.
 *   node docs/wording-change/2026-10-16/deploy.cjs --restage  recompute the sha256 block below from staged/ (after editing staged)
 *   node docs/wording-change/2026-10-16/deploy.cjs --selftest the pure parts of this file (no repo is touched)
 * Exit 0 applied or nothing to do · 1 the write failed · 2 refused, or the arguments were wrong (nothing was done).
 *
 * THE UNDO is rollback.cjs: it removes the three files again, refusing any file whose bytes are not the ones this package wrote.
 */
const fs = require("fs"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", ".."), PKG_REL = "docs/wording-change/2026-10-16";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

/** the files this package creates, and the sha256 of each staged copy (--restage rewrites the hashes) */
const FILES = Object.freeze(/*SHAS*/[
  {
    "rel": "backend/lib/filing-sections.js",
    "staged": "staged/backend/lib/filing-sections.js",
    "stagedSha": "c817d48888fb08b3443baa030f07ee9b0bcfa5fb983c5ce2e505620b69c6f8ec",
    "what": "the parse layer: standard sections of a 10-K / 10-Q, word counts, cosine"
  },
  {
    "rel": "backend/lib/sec-fetch.js",
    "staged": "staged/backend/lib/sec-fetch.js",
    "stagedSha": "102f160e7512927a5bfada84141bb7a731dbc7145a8dcb903cf4a827c765f79e",
    "what": "the fetch layer: an injected fetcher under SEC's 10-a-second fair-access limit"
  },
  {
    "rel": "backend/filing-wording-collector.js",
    "staged": "staged/backend/filing-wording-collector.js",
    "stagedSha": "f16b22b6f8f0557947a1c10801ec2bc20aa07653a0061dae770f28283a905d16",
    "what": "the collector: per filing, per section, the cosine against the previous filing of the same form"
  }
]/*END*/);

const readOrNull = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
const abs = (root, rel) => path.join(root, ...rel.split("/"));

/**
 * One file's state.
 *   absent   home does not have it — the write mode creates it
 *   applied  home already holds exactly these bytes — the write mode leaves it alone
 *   DRIFT    home holds something else — refused: read what is there before this package goes anywhere near it
 * `problem` is set when the package's own staged copy is not the reviewed bytes.
 */
function fileState(f, { repo = REPO, pkg = PKG } = {}) {
  const home = readOrNull(abs(repo, f.rel)), staged = readOrNull(path.join(pkg, ...f.staged.split("/")));
  const r = { rel: f.rel, what: f.what, homeSha: home ? sha(home) : null, stagedSha: f.stagedSha, stagedNow: staged ? sha(staged) : null, problem: null, state: null };
  if (!staged) r.problem = `the package's staged copy ${f.staged} is missing`;
  else if (r.stagedNow !== f.stagedSha) r.problem = `the package's staged copy ${f.staged} is not the bytes that were reviewed (it hashes to ${r.stagedNow.slice(0, 12)}, the record says ${f.stagedSha.slice(0, 12)}) — re-run --restage after reviewing the change`;
  r.state = !home ? "absent" : r.homeSha === f.stagedSha ? "applied" : "DRIFT";
  return r;
}
/** the whole package's state, and the refusals the write mode would raise */
function plan({ repo = REPO, pkg = PKG, files = FILES } = {}) {
  const states = files.map((f) => fileState(f, { repo, pkg })), problems = [];
  for (const s of states) {
    if (s.problem) problems.push(`${s.rel}: ${s.problem}`);
    if (s.state === "DRIFT") problems.push(`${s.rel} already exists at home with different bytes (sha256 ${String(s.homeSha).slice(0, 12)}, this package stages ${s.stagedSha.slice(0, 12)}). This package only CREATES files, so it will not overwrite one: read what is there, then decide — REFUSED`);
  }
  return { states, problems, todo: states.filter((s) => s.state === "absent"), applied: states.every((s) => s.state === "applied") };
}
/** write bytes so that the file is either absent, the old one, or the new one — never half of anything */
function writeExact(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-wording-${process.pid}`;
  const fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  if (sha(fs.readFileSync(file)) !== sha(buf)) throw new Error(`${file} does not read back as written`);
}

/**
 * The write mode, on injected dependencies so the selftest can run the whole thing against a scratch repo.
 *   apply({ repo, pkg, files, gate, log }) -> { result: "done" | "refused" | "failed", wrote, why, lines }
 * `gate` is { what, run: () => ({ ok, line, why }) }; pass null to skip it (only the selftest does, and it says so).
 */
function apply({ repo = REPO, pkg = PKG, files = FILES, gate = null, log = console.log } = {}) {
  const lines = [], say = (s) => { lines.push(s); log(s); };
  const P = plan({ repo, pkg, files });
  if (P.problems.length) return { result: "refused", why: P.problems, lines, wrote: [] };
  if (!P.todo.length) { say("  home already holds all three files — nothing to write"); return { result: "done", wrote: [], lines }; }
  if (gate) {
    say(`  gate: ${gate.what} …`);
    const g = gate.run();
    if (!g.ok) return { result: "refused", why: [`${gate.what} did not pass: ${g.why}`], lines, wrote: [] };
    say(`  gate: ${g.line}`);
    const again = plan({ repo, pkg, files });
    if (again.problems.length) return { result: "refused", why: again.problems.concat("(the files changed while the gate ran)"), lines, wrote: [] };
  }
  const wrote = [];
  const undo = () => { const bad = []; for (const rel of wrote) { try { fs.unlinkSync(abs(repo, rel)); } catch (e) { bad.push(`${rel}: ${e.message}`); } } return bad; };
  for (const s of P.todo) {
    const f = files.find((x) => x.rel === s.rel), file = abs(repo, s.rel);
    if (fs.existsSync(file)) { const bad = undo(); return { result: "failed", why: [`${s.rel} appeared while this ran`], lines, wrote, restored: !bad.length, notRestored: bad }; }
    const buf = fs.readFileSync(path.join(pkg, ...f.staged.split("/")));
    try { writeExact(file, buf); } catch (e) { const bad = undo(); return { result: "failed", why: [`writing ${s.rel}: ${e.message}`], lines, wrote, restored: !bad.length, notRestored: bad }; }
    wrote.push(s.rel);
    const c = cp.spawnSync(process.execPath, ["--check", file], { encoding: "utf8", windowsHide: true });
    if (c.status !== 0) { const bad = undo(); return { result: "failed", why: [`${s.rel} does not parse after the write: ${String(c.stderr).trim().split("\n")[0]}`], lines, wrote, restored: !bad.length, notRestored: bad }; }
    say(`  created ${s.rel}  sha256 ${sha(buf).slice(0, 12)}, read back and node --check ok`);
  }
  return { result: "done", wrote, lines };
}

/** the package selftest as the gate: its last line must say ALL <n> CHECKS PASSED */
const selftestGate = (repo = REPO) => ({
  what: "this package's selftest (selftest.cjs)",
  run: () => {
    const r = cp.spawnSync(process.execPath, [path.join(PKG_REL, "selftest.cjs")], { cwd: repo, encoding: "utf8", timeout: 600000, windowsHide: true, maxBuffer: 64 << 20 });
    const last = String(String(r.stdout || "") + String(r.stderr || "")).trim().split("\n").pop() || "";
    return { ok: r.status === 0 && /^ALL \d+ CHECKS PASSED/.test(last), line: last, why: last || `exit ${r.status}` };
  },
});

function printPlan(P) {
  console.log(`PLAN — filing wording collector (backlog row 25) — ${new Date().toISOString().slice(0, 16)}Z — read-only, nothing is written`);
  console.log("  base/ is empty: all three files are NEW, so the base state of each one is ABSENT.");
  for (const s of P.states) {
    console.log(`\n  ${s.rel}`);
    console.log(`      ${s.what}`);
    console.log(`      staged     ${s.stagedSha}${s.stagedNow === s.stagedSha ? "" : "   PACKAGE COPY DIFFERS: " + (s.stagedNow || "missing")}`);
    console.log(`      home now   ${s.homeSha || "(absent)"}`);
    console.log(`      state      ${s.state === "absent" ? "absent — --apply would create it" : s.state === "applied" ? "applied — home already holds these bytes" : "DRIFT — home holds different bytes; --apply is REFUSED"}${s.problem ? "   PROBLEM: " + s.problem : ""}`);
  }
  console.log(`\n  unit: ${P.problems.length ? "REFUSED by --apply:\n    - " + P.problems.join("\n    - ") : P.todo.length ? `--apply would create ${P.todo.length} file(s): ${P.todo.map((s) => s.rel).join(", ")}, after the package selftest passes` : "home already holds all three files — --apply would write nothing"}`);
  console.log("  nothing else is touched: no registry, no seal, no unit, no task, no order, no restart. The collector itself writes only");
  console.log("  backend/data/filing-wording/<CIK>.json, through backend/lib/atomic-write.js.");
  console.log(`  undo: node ${PKG_REL}/rollback.cjs --plan | --apply`);
}

/** rewrite the sha256 block above from the staged files */
function restage() {
  const next = FILES.map((f) => {
    const b = fs.readFileSync(path.join(PKG, ...f.staged.split("/")));
    return { rel: f.rel, staged: f.staged, stagedSha: sha(b), what: f.what };
  });
  const src = fs.readFileSync(__filename, "utf8");
  const block = JSON.stringify(next, null, 2).split("\n").map((l, i) => (i === 0 ? l : "" + l)).join("\n");
  if (!/\/\*SHAS\*\/[\s\S]*?\/\*END\*\//.test(src)) throw new Error("the sha256 block markers were not found in deploy.cjs");
  const out = src.replace(/\/\*SHAS\*\/[\s\S]*?\/\*END\*\//, "/*SHAS*/" + block + "/*END*/");
  for (const f of next) console.log(`  ${f.stagedSha}  ${f.rel}`);
  // out === src means the recorded hashes were already the staged ones: that is the normal state, not a failure
  if (out === src) { console.log(`restage: deploy.cjs already records these ${next.length} sha256(s) — nothing to rewrite`); return; }
  const tmp = __filename + ".tmp-restage-" + process.pid;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, __filename);
  console.log(`restage: deploy.cjs now records ${next.length} staged sha256(s)`);
}

function parseArgs(argv) {
  const modes = argv.filter((a) => ["--plan", "--apply", "--restage", "--selftest"].includes(a));
  if (argv.length !== 1 || modes.length !== 1) throw new Error(`usage: node ${PKG_REL}/deploy.cjs --plan | --apply | --restage | --selftest  (one at a time) — nothing was done`);
  return modes[0].slice(2);
}

// ── selftest (the pure parts; the package selftest exercises a whole apply and rollback in a scratch tree) ─────────────────
function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d === undefined ? "" : " — " + d)); } };
  const threw = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };
  ok("the arguments: one mode at a time, and nothing else is accepted",
    parseArgs(["--plan"]) === "plan" && parseArgs(["--apply"]) === "apply" && threw(() => parseArgs([]), /usage/) && threw(() => parseArgs(["--plan", "--apply"]), /usage/) && threw(() => parseArgs(["--force"]), /usage/));
  ok("this package creates three files and changes none", FILES.length === 3 && FILES.every((f) => f.staged === "staged/" + f.rel));
  ok("every staged copy is the sha256 recorded in this file", FILES.every((f) => { const b = readOrNull(path.join(PKG, ...f.staged.split("/"))); return b && sha(b) === f.stagedSha; }),
    FILES.map((f) => `${f.rel}: ${(readOrNull(path.join(PKG, ...f.staged.split("/"))) ? sha(readOrNull(path.join(PKG, ...f.staged.split("/")))) : "missing").slice(0, 12)} vs ${f.stagedSha.slice(0, 12)}`).join("; "));
  ok("base/ holds no copy of a live file, because every file here is new", !fs.existsSync(path.join(PKG, "base")) || fs.readdirSync(path.join(PKG, "base")).every((n) => n === "EMPTY.md"));
  // the states, against a scratch tree
  {
    const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "wording-deploy-"));
    try {
      const f = FILES[0], target = abs(tmp, f.rel);
      ok("a target that is not there reads absent", fileState(f, { repo: tmp }).state === "absent");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(PKG, ...f.staged.split("/")), target);
      ok("a target that already holds the staged bytes reads applied, and --apply would write nothing for it", fileState(f, { repo: tmp }).state === "applied");
      fs.writeFileSync(target, "// someone else's file\n");
      const d = fileState(f, { repo: tmp });
      ok("a target that holds anything else reads DRIFT, and the plan refuses", d.state === "DRIFT" && plan({ repo: tmp, files: [f] }).problems.some((p) => /DRIFT|different bytes/.test(p)));
      ok("a refused plan writes nothing: the file on disk is untouched", fs.readFileSync(target, "utf8") === "// someone else's file\n");
      const r = apply({ repo: tmp, files: [f], gate: null, log: () => { } });
      ok("--apply on a drifted tree is refused and creates nothing", r.result === "refused" && r.wrote.length === 0 && fs.readFileSync(target, "utf8") === "// someone else's file\n");
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  console.log(`deploy selftest: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASSED" : "FAILED"}`);
  return fail === 0;
}

module.exports = { PKG, REPO, PKG_REL, FILES, sha, abs, readOrNull, fileState, plan, apply, writeExact, selftestGate, parseArgs, selftest };

if (require.main === module) {
  let mode = null;
  try { mode = parseArgs(process.argv.slice(2)); } catch (e) { console.error("deploy: " + e.message); process.exitCode = 2; }
  if (mode === "selftest") process.exitCode = selftest() ? 0 : 1;
  else if (mode === "restage") { try { restage(); process.exitCode = 0; } catch (e) { console.error("deploy --restage: " + e.message); process.exitCode = 1; } }
  else if (mode === "plan") { printPlan(plan()); process.exitCode = 0; }
  else if (mode === "apply") {
    console.log(`APPLY — filing wording collector — ${new Date().toISOString().slice(0, 16)}Z`);
    const r = apply({ gate: selftestGate() });
    if (r.result === "refused") { console.error(`REFUSED — nothing was written:\n  - ${r.why.join("\n  - ")}`); process.exitCode = 2; }
    else if (r.result === "failed") {
      console.error(`APPLY FAILED: ${r.why.join("; ")}`);
      console.error(r.restored ? "  every file this run created has been removed again; home is as it was." : `  NOT UNDONE: ${(r.notRestored || []).join("; ")} — remove those files by hand (node ${PKG_REL}/rollback.cjs --plan shows them)`);
      process.exitCode = 1;
    } else {
      console.log(`\nAPPLIED: ${r.wrote.length ? "created " + r.wrote.join(", ") : "nothing to create"}.`);
      console.log("  Nothing was registered, started or restarted. Next, on the server, when you want it:");
      console.log("    node backend/filing-wording-collector.js --from-dir <folder of saved filings> --dry     the parse layer, no network");
      console.log("    SEC_USER_AGENT=... node backend/filing-wording-collector.js --fetch <CIK> --limit 4 --dry   the fetch layer");
      console.log(`  undo: node ${PKG_REL}/rollback.cjs --apply`);
      process.exitCode = 0;
    }
  }
}
