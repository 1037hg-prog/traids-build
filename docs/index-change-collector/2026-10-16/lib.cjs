"use strict";
/**
 * INDEX CHANGE COLLECTOR (2026-10-16) — the package's shared machinery, used by deploy.cjs,
 * rollback.cjs and record.cjs. It does not run anything on its own.
 *
 * WHAT MAKES THIS PACKAGE UNUSUAL: every file it ships is NEW. Nothing live changes, so `base/` holds
 * no file copies — the base state of each path is ABSENT, and that is what rollback.cjs restores. The
 * file table below says so explicitly (`baseSha: null`), and the four states a path can be in are:
 *
 *   absent     the path is not at home: --apply would create it (this is `base`)
 *   applied    the path holds the staged bytes
 *   DRIFT      the path exists and holds something else: refused whole, by deploy AND by rollback
 *   (there is no "unchanged": a file that does not exist cannot already be current)
 *
 * NO FENCE IS NEEDED and none is pretended. Nothing at home reads these paths yet: no existing file
 * requires them, no scheduler entry runs them, and the collector only runs when a person types it. So
 * there is no window in which an apply could land under a running process, and no unit to restart.
 * NOTES.md says what the operator must do before anything calls this code.
 */
const fs = require("fs"), path = require("path"), cp = require("child_process"), crypto = require("crypto");

const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", "..");
const PKG_REL = "docs/index-change-collector/2026-10-16";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

/**
 * The files this package ships. `baseSha: null` means "absent at home is the base state": each one is
 * NEW. `stagedSha` is the sha256 of the bytes that were reviewed and that selftest.cjs proved; a staged
 * copy that does not match it means the package has been edited since, and every mode refuses.
 */
const FILES = Object.freeze([
  Object.freeze({ rel: "backend/lib/index-changes.js", staged: "staged/backend/lib/index-changes.js", baseSha: null, stagedSha: /*STAGED_SHA*/"371a703a39918ae55258bb3f524c94ef95be5506b2617e565714eae79db282fb"/*END*/, what: "the parse layer: saved page text -> rows. No fs, no network, no clock." }),
  Object.freeze({ rel: "backend/lib/index-changes-fetch.js", staged: "staged/backend/lib/index-changes-fetch.js", baseSha: null, stagedSha: /*STAGED_SHA*/"c6b6ddf4c96d7e16aeaeb43f7378f9f250cb84cd4dc9b93917f3daf150231983"/*END*/, what: "the fetch layer: an INJECTED fetcher only; it holds no network client." }),
  Object.freeze({ rel: "backend/index-change-collector.js", staged: "staged/backend/index-change-collector.js", baseSha: null, stagedSha: /*STAGED_SHA*/"9da88a738f71d59a7b158db64707786fd4506a351a5f2456d5ebcd6665999d5a"/*END*/, what: "the wiring: builds a fetcher, writes the dated JSONL, prints the plan. The only file that can open a socket, and only under --network." }),
]);

/** the live files the staged code requires and does NOT change: their presence is a precondition */
const LIVE_DEPS = Object.freeze(["backend/lib/atomic-write.js"]);
/** where the collector writes. Never touched by deploy or rollback: data is not this package's to move. */
const DATA_DIR = "backend/data/index-changes";

const isCode = (rel) => /\.(c?js|mjs)$/.test(rel);
const read = (p) => { try { return fs.readFileSync(p); } catch { return null; } };

/** one path's state: what is at home now, what the package holds, and what that means */
function fileState(f, { repo = REPO, pkg = PKG } = {}) {
  const home = read(path.join(repo, ...f.rel.split("/"))), staged = read(path.join(pkg, ...f.staged.split("/")));
  const r = { rel: f.rel, what: f.what, home: home ? sha(home) : null, staged: staged ? sha(staged) : null, stagedSha: f.stagedSha, baseSha: f.baseSha, problem: null, state: null };
  if (r.staged !== f.stagedSha) r.problem = `the package's staged copy ${f.staged} is ${r.staged ? "not the bytes that were reviewed (sha256 " + r.staged.slice(0, 12) + ", expected " + f.stagedSha.slice(0, 12) + ")" : "missing"}`;
  if (!home) r.state = "absent";
  else if (r.home === f.stagedSha) r.state = "applied";
  else r.state = "DRIFT";
  return r;
}

/**
 * The plan of the whole package. `problems` are refusals: the write modes do nothing while any is there.
 * forRollback relaxes nothing about DRIFT (a path that holds someone else's bytes is never removed).
 */
function plan({ repo = REPO, pkg = PKG, forRollback = false } = {}) {
  const files = FILES.map((f) => fileState(f, { repo, pkg })), problems = [];
  for (const x of files) {
    if (x.problem) problems.push(`${x.rel}: ${x.problem}`);
    if (x.state === "DRIFT") problems.push(`${x.rel} exists at home with other bytes (sha256 ${String(x.home).slice(0, 12)}, the staged copy is ${x.stagedSha.slice(0, 12)}): this package ships it as a NEW file, so something else wrote that path — read it, then decide by hand`);
  }
  for (const rel of LIVE_DEPS) if (!read(path.join(repo, ...rel.split("/")))) problems.push(`${rel} is not at home, and the staged code requires it`);
  return {
    files, problems,
    toCreate: files.filter((x) => x.state === "absent"),
    toRemove: files.filter((x) => x.state === "applied"),
    applied: files.every((x) => x.state === "applied"),
    absent: files.every((x) => x.state === "absent"),
    forRollback,
  };
}

/** write bytes so the path is either absent or complete, never half: temp file + rename, then read back */
function writeExact(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-icc-${process.pid}`, fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  if (sha(fs.readFileSync(file)) !== sha(buf)) throw new Error(`${file} does not read back as written`);
}

const mtWords = (ms) => new Date(ms).toLocaleString("en-US", { timeZone: "America/Denver", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

/**
 * The write unit, shared by deploy (`to: "staged"`) and rollback (`to: "absent"`), on injected parts so
 * the package's own checks drive it against a scratch tree:
 *   repo, pkg, log, run(args) -> { status, out }
 *
 * The order is the same both ways: refuse on any plan problem; run the gate (the selftest) when there
 * is work to do; then change the paths one at a time, each read back by sha256 and, for code, put
 * through `node --check`. The first failure puts every path back the way this run found it.
 */
function make(deps = {}) {
  const d = { repo: REPO, pkg: PKG, log: (s) => console.log(s), run: null, ...deps };
  if (!d.run) d.run = (args, timeoutMs = 900000) => { const r = cp.spawnSync(process.execPath, args, { cwd: d.repo, encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 64 << 20 }); return { status: r.status, out: String(r.stdout || "") + String(r.stderr || "") }; };

  /** this package's selftest must end "ALL n CHECKS PASSED" */
  const selftestGate = {
    what: "this package's selftest (selftest.cjs, on the staged bytes in a scratch tree)",
    run: () => { const r = d.run([path.join(d.pkg, "selftest.cjs")]), last = String(r.out).trim().split("\n").pop() || ""; return { ok: r.status === 0 && /^ALL \d+ CHECKS PASSED$/.test(last), line: last, why: last || `exit ${r.status}` }; },
  };

  /** put the paths back to the bytes (or the absence) this run found */
  function putBack(before) {
    const bad = [];
    for (const [rel, buf] of Object.entries(before)) {
      const file = path.join(d.repo, ...rel.split("/"));
      try { if (buf === null) { if (fs.existsSync(file)) fs.unlinkSync(file); } else writeExact(file, buf); }
      catch (e) { bad.push(`${rel}: ${e.message}`); }
    }
    return bad;
  }

  function writeUnit({ to, gate = null }) {
    const wantAbsent = to === "absent";
    const P = plan({ repo: d.repo, pkg: d.pkg, forRollback: wantAbsent }), lines = [], say = (s) => { lines.push(s); d.log(s); };
    if (P.problems.length) return { result: "refused", why: P.problems, lines };
    const todo = wantAbsent ? P.toRemove : P.toCreate;
    if (!todo.length) return { result: "noop", why: [wantAbsent ? "every path is already absent" : "every path already holds the staged bytes"], lines };
    if (gate) {
      say(`  gate: ${gate.what} …`);
      const g = gate.run();
      if (!g.ok) return { result: "refused", why: [`${gate.what} did not pass: ${g.why}`], lines };
      say(`  gate: ${g.line}`);
    }
    const before = {}, done = [];
    for (const x of todo) {
      const f = FILES.find((y) => y.rel === x.rel), file = path.join(d.repo, ...x.rel.split("/"));
      const now = read(file);
      if ((now ? sha(now) : null) !== x.home) { putBack(before); return { result: "failed", why: [`${x.rel} changed while this ran`], lines, restored: true }; }
      before[x.rel] = now;
      try {
        if (wantAbsent) { fs.unlinkSync(file); if (fs.existsSync(file)) throw new Error("the file is still there after being removed"); }
        else writeExact(file, fs.readFileSync(path.join(d.pkg, ...f.staged.split("/"))));
      } catch (e) {
        const bad = putBack(before);
        return { result: "failed", why: [`${wantAbsent ? "removing" : "writing"} ${x.rel}: ${e.message}`], lines, restored: !bad.length, notRestored: bad };
      }
      if (!wantAbsent && isCode(x.rel)) {
        const c = cp.spawnSync(process.execPath, ["--check", file], { encoding: "utf8", windowsHide: true });
        if (c.status !== 0) { const bad = putBack(before); return { result: "failed", why: [`${x.rel} does not parse after the write: ${String(c.stderr).trim().split("\n")[0]}`], lines, restored: !bad.length, notRestored: bad }; }
      }
      done.push(x.rel);
      say(wantAbsent ? `  removed ${x.rel}` : `  wrote   ${x.rel}  sha256 ${x.stagedSha.slice(0, 12)}, read back and node --check ok`);
    }
    return { result: "done", done, lines };
  }

  return { d, writeUnit, selftestGate, putBack };
}

module.exports = { PKG, REPO, PKG_REL, FILES, LIVE_DEPS, DATA_DIR, sha, read, isCode, fileState, plan, writeExact, make, mtWords };
