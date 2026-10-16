#!/usr/bin/env node
"use strict";
/**
 * INSIDER CLUSTERS (2026-10-16) — DEPLOY the SEC Form 4 collector and the cluster finder.
 *
 * WHAT IT SHIPS: six NEW files, from staged/. It replaces nothing, so base/ holds no bytes — every file's `baseSha` is null, which
 * means "not at home yet", and a rollback REMOVES exactly these six and leaves the tree as it was. NOTES.md says what they do and how
 * they were proven; selftest.cjs proves them on saved fixture filings with no network.
 *
 *   backend/lib/sec-fetch.js             the only way this desk asks sec.gov for anything: an INJECTED fetcher, a REQUIRED declared
 *                                        User-Agent, ten requests a second at most (the SEC's own limit), retries with backoff and
 *                                        Retry-After, an SEC-hosts-only allowlist
 *   backend/lib/form4-parse.js           a filing's text -> its officer / director open-market purchases (code P, acquired,
 *                                        non-derivative, common stock, priced)
 *   backend/lib/insider-buys-lib.js      the company-day record and the dated JSONL it lives in; merging keyed by accession
 *   backend/lib/insider-cluster-lib.js   the trading-day calendar and the cluster rule
 *   backend/insider-buys-collect.js      the server's daily run: one dated JSONL per filing day
 *   backend/insider-clusters.js          three or more distinct insiders inside ten trading days -> one dated JSON
 *
 *   node docs/insider-clusters/2026-10-16/deploy.cjs --plan     READ-ONLY. Each file's sha256 at home NOW and STAGED, its state
 *                                                              (absent = to create · applied · DRIFT = a file of that name holding
 *                                                              other bytes: refused), and the fences now (the clock and the node
 *                                                              process list, both read-only). Nothing is written.
 *   node docs/insider-clusters/2026-10-16/deploy.cjs --apply    the write mode — the main session's command. In order:
 *     1. every file reads absent or applied (DRIFT -> refused, nothing written); the package's staged copies are the reviewed bytes
 *     2. the fences (any one refuses, nothing written): not 05:30-16:00 MT on a trading weekday (the session and the pre-open
 *        runners own those hours); not while backend/insider-buys-collect.js or backend/insider-clusters.js is running; a process
 *        list that cannot be read refuses (fail-closed)
 *     3. this package's selftest must end "ALL ... CHECKS PASSED"; then the fences are asked again
 *     4. each file is written from staged (temp file + rename), read back by sha256, then node --check; any failure puts the tree
 *        back to what it was (the files this run created are removed again)
 *
 * It schedules nothing, restarts nothing, writes no data file and no registry row (record.cjs does that), and it never runs the
 * collector: the operator starts it at home, with SEC_USER_AGENT set there. No test is registered by this package — that happens at
 * home, before any of this data is read.
 * Exit 0 applied (or nothing to apply) · 1 failed (the headline says what holds) · 2 refused or usage.
 */
const fs = require("fs"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", ".."), PKG_REL = "docs/insider-clusters/2026-10-16";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
let HOLIDAYS = {};
try { HOLIDAYS = require(path.join(REPO, "backend", "lib", "run-window.js")).MARKET_HOLIDAYS || {}; } catch { HOLIDAYS = {}; }

/** every file this package adds. baseSha null = NEW: there is nothing at home to start from, and a rollback removes it again. */
const FILES = Object.freeze([
  Object.freeze({ rel: "backend/lib/sec-fetch.js", staged: "staged/backend/lib/sec-fetch.js", baseSha: null, stagedSha: /*STAGED_SHA*/"1b94a25c17a651970810f3a82d66c641eefddf2ffce6ab029177896381e58094"/*END*/ }),
  Object.freeze({ rel: "backend/lib/form4-parse.js", staged: "staged/backend/lib/form4-parse.js", baseSha: null, stagedSha: /*STAGED_SHA*/"2f801235269d5d0b9af6e8450e7bd45e18e5435eec243348cb971fa2bda4adcc"/*END*/ }),
  Object.freeze({ rel: "backend/lib/insider-buys-lib.js", staged: "staged/backend/lib/insider-buys-lib.js", baseSha: null, stagedSha: /*STAGED_SHA*/"094e9daa24b533460547c037db34809a5d946d70a970c5acb0f734f4cef2e042"/*END*/ }),
  Object.freeze({ rel: "backend/lib/insider-cluster-lib.js", staged: "staged/backend/lib/insider-cluster-lib.js", baseSha: null, stagedSha: /*STAGED_SHA*/"6121943d6587ce747fbe4c8ad08d4f38d0b1ed39f22d0b6a5b2eaae895d138f8"/*END*/ }),
  Object.freeze({ rel: "backend/insider-buys-collect.js", staged: "staged/backend/insider-buys-collect.js", baseSha: null, stagedSha: /*STAGED_SHA*/"7cd34b2a81facf332a94eefdd8c1c800d9c1e44d128544f70e0ba2933d02fb97"/*END*/ }),
  Object.freeze({ rel: "backend/insider-clusters.js", staged: "staged/backend/insider-clusters.js", baseSha: null, stagedSha: /*STAGED_SHA*/"c3e7e4b58b0e850eaf4a240e47270d0082663a8472cf113ab7b7508e91384c3d"/*END*/ }),
]);
const isCode = (rel) => /\.(c?js)$/.test(rel);
const P = (root, rel) => path.join(root, ...rel.split("/"));

/** one file's state: home now, the package's staged copy, and what they say */
function fileState(f, { repo = REPO, pkg = PKG } = {}) {
  const read = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
  const home = read(P(repo, f.rel)), staged = read(P(pkg, f.staged));
  const r = { rel: f.rel, home: home ? sha(home) : null, staged: staged ? sha(staged) : null, baseSha: f.baseSha, stagedSha: f.stagedSha, problem: null, state: null };
  if (r.staged !== f.stagedSha) r.problem = `the package's staged copy ${f.staged} is ${r.staged ? "not the bytes that were reviewed" : "missing"}`;
  r.state = !home ? "absent" : r.home === f.stagedSha ? "applied" : "DRIFT";
  return r;
}
/**
 * the plan: the file states and whether a write mode could go on (problems = refusals).
 * forRollback: a changed STAGED copy does not stop a rollback (a rollback only removes what the staged sha says is ours), but a
 * file holding other bytes still does.
 */
function plan({ repo = REPO, pkg = PKG, forRollback = false } = {}) {
  const files = FILES.map((f) => fileState(f, { repo, pkg })), problems = [];
  for (const x of files) {
    if (x.problem && !forRollback) problems.push(`${x.rel}: ${x.problem}`);
    if (x.state === "DRIFT") problems.push(`${x.rel} is DRIFT at home: a file of that name is already there holding other bytes (sha256 ${String(x.home).slice(0, 12)}, not the staged ${x.stagedSha.slice(0, 12)}). This package creates that path — read what is there before anything is written or removed.`);
  }
  return { files, problems, todo: files.filter((x) => x.state === "absent"), applied: files.every((x) => x.state === "applied"), toRemove: files.filter((x) => x.state === "applied") };
}

// ── the clocks (node Intl only; the shell's date is never used) ───────────────────────────────────────────────────────────────
function zoneParts(ms, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`, hh = +p.hour % 24, mm = +p.minute;
  return { date, hh, mm, hm: hh * 60 + mm, hhmm: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`, dow: new Date(date + "T12:00:00Z").getUTCDay() };
}
const tradingDay = (z, holidays) => z.dow >= 1 && z.dow <= 5 && !holidays[z.date];
const mtWords = (ms) => { const z = zoneParts(ms, "America/Denver"); return `${z.date} ${z.hhmm}`; };
/** no write 05:30-16:00 MT on a trading weekday (the session, the pre-open runners and the close chain's own hour) */
function clockFence(nowMs, holidays = HOLIDAYS) {
  const z = zoneParts(nowMs, "America/Denver");
  return tradingDay(z, holidays) && z.hm >= 5 * 60 + 30 && z.hm < 16 * 60
    ? `it is ${z.date} ${z.hhmm} MT, a trading day, inside 05:30-16:00 MT — run it after 16:00 MT`
    : null;
}
/** the node processes now -> [{ pid, cmd }] (read-only); THROWS when the list cannot be read */
function listNodeProcs() {
  const win = process.platform === "win32";
  const r = win
    ? cp.spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { [string]$_.ProcessId + \"`t\" + [string]$_.CommandLine }"], { encoding: "utf8", windowsHide: true, timeout: 60000 })
    : cp.spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8", timeout: 30000 });
  if (r.error || r.status !== 0) throw new Error(`${win ? "Get-CimInstance Win32_Process" : "ps"} ${r.error ? r.error.message : `exit ${r.status}: ${String(r.stderr || "").trim().slice(0, 160)}`}`);
  return String(r.stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const m = win ? /^(\d+)\t?(.*)$/.exec(l) : /^(\d+)\s+(.*)$/.exec(l); return m ? { pid: +m[1], cmd: m[2] } : null; }).filter(Boolean);
}
const norm = (s) => String(s || "").replace(/\\/g, "/").toLowerCase();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** does this command line run <rel> of THIS repo? (its absolute path + rel, or rel as a word of its own) */
function runsRepoScript(cmd, rel, repo = REPO) { const c = norm(cmd), r = norm(rel); return c.includes(`${norm(repo)}/${r}`) || new RegExp(`(^|[\\s"'])(\\./)?${esc(r)}($|[\\s"'])`).test(c); }
/** the two entry points this package ships must not change under a run */
function procFence(listProcs, repo = REPO) {
  let procs;
  try { procs = listProcs(); } catch (e) { return [`the node process list could not be read (${String(e.message).slice(0, 200)}) — nothing is assumed about what is running: refused`]; }
  const out = [];
  for (const rel of ["backend/insider-buys-collect.js", "backend/insider-clusters.js"]) {
    const hit = procs.filter((p) => p.pid !== process.pid && runsRepoScript(p.cmd, rel, repo));
    if (hit.length) out.push(`${rel} is running (node pid ${hit.map((p) => p.pid).join(", ")}) — the file must not change under a run`);
  }
  return out;
}

/** write bytes so the file is either the old one or the new one, never half (temp file + rename), then read back by sha256 */
function writeExact(file, buf) {
  const tmp = `${file}.tmp-ic-${process.pid}`, fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  if (sha(fs.readFileSync(file)) !== sha(buf)) throw new Error(`${file} does not read back as written`);
}

/**
 * The write steps, on injected dependencies (the selftest gives a scratch repo, a fake clock, a fake process list, a fake gate):
 * repo, pkg, now, log, listProcs() -> [{ pid, cmd }] (throws when unreadable), holidays, run(args) -> { status, out }.
 */
function make(deps = {}) {
  const d = { repo: REPO, pkg: PKG, now: () => Date.now(), log: (s) => console.log(s), listProcs: listNodeProcs, holidays: HOLIDAYS, run: null, ...deps };
  if (!d.run) d.run = (args, timeoutMs = 1800000) => { const r = cp.spawnSync(process.execPath, args, { cwd: d.repo, encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 256 << 20 }); return { status: r.status, out: String(r.stdout || "") + String(r.stderr || "") }; };
  /** the fences, now: [] or the refusals */
  function fences() {
    const out = [], c = clockFence(d.now(), d.holidays);
    if (c) out.push(c);
    out.push(...procFence(d.listProcs, d.repo));
    return out;
  }
  /**
   * the write mode of deploy (to = "staged": create each absent file) and of rollback (to = "base": remove each applied file,
   * because base/ holds no bytes — these six paths did not exist before this package).
   */
  function writeUnit({ to, gate = null }) {
    const wantBase = to === "base", Pl = plan({ repo: d.repo, pkg: d.pkg, forRollback: wantBase }), lines = [], say = (s) => { lines.push(s); d.log(s); };
    const refuse = (why) => ({ result: "refused", why, lines, written: [] });
    if (Pl.problems.length) return refuse(Pl.problems);
    const todo = wantBase ? Pl.toRemove : Pl.todo;
    let fz = fences();
    if (fz.length) return refuse(fz);
    if (gate && todo.length) {
      say(`  gate: ${gate.what} …`);
      const g = gate.run();
      if (!g.ok) return refuse([`${gate.what} did not pass: ${g.why}`]);
      say(`  gate: ${g.line}`);
      fz = fences();
      if (fz.length) return refuse(fz);
    }
    const created = [], written = [];
    const putBack = () => { const bad = []; for (const rel of created) { try { fs.unlinkSync(P(d.repo, rel)); } catch (e) { if (e.code !== "ENOENT") bad.push(`${rel}: ${e.message}`); } } return bad; };
    for (const x of todo) {
      const f = FILES.find((y) => y.rel === x.rel), file = P(d.repo, x.rel);
      if (wantBase) {
        const now = fs.existsSync(file) ? sha(fs.readFileSync(file)) : null;
        if (now !== f.stagedSha) { return { result: "failed", why: [`${x.rel} changed while this ran (sha256 ${String(now).slice(0, 12)}) — it is NOT removed`], lines, restored: true, written }; }
        fs.unlinkSync(file);
        written.push(x.rel);
        say(`  removed ${x.rel} (it held the staged bytes; this package created it)`);
        continue;
      }
      if (fs.existsSync(file)) { const bad = putBack(); return { result: "failed", why: [`${x.rel} appeared while this ran`], lines, restored: !bad.length, notRestored: bad, written }; }
      const buf = fs.readFileSync(P(d.pkg, f.staged));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try { writeExact(file, buf); } catch (e) { const bad = putBack(); return { result: "failed", why: [`writing ${x.rel}: ${e.message}`], lines, restored: !bad.length, notRestored: bad, written }; }
      created.push(x.rel); written.push(x.rel);
      if (isCode(x.rel)) {
        const c = cp.spawnSync(process.execPath, ["--check", file], { encoding: "utf8", windowsHide: true });
        if (c.status !== 0) { const bad = putBack(); return { result: "failed", why: [`${x.rel} does not parse after the write: ${String(c.stderr).trim().split("\n")[0]}`], lines, restored: !bad.length, notRestored: bad, written }; }
      }
      say(`  wrote ${x.rel}  sha256 ${sha(buf).slice(0, 12)} (new file), read back and node --check ok`);
    }
    if (!todo.length) say(`  home: nothing to ${wantBase ? "remove (none of the six is there)" : "write (all six are already the staged bytes)"}`);
    return { result: "done", written, lines };
  }
  /** the package's selftest as the gate (its last line must say ALL ... CHECKS PASSED) */
  const selftestGate = {
    what: "this package's selftest (selftest.cjs)",
    run: () => { const r = d.run([path.join(PKG_REL, "selftest.cjs")], 1800000), last = String(r.out).trim().split("\n").pop() || ""; return { ok: r.status === 0 && /^ALL \d+ CHECKS PASSED/.test(last), line: last, why: last || `exit ${r.status}` }; },
  };
  return { d, fences, writeUnit, selftestGate };
}

function printPlan(Pl, fz) {
  console.log(`PLAN — insider clusters (${FILES.length} NEW files) — ${new Date().toISOString().slice(0, 16)}Z (${mtWords(Date.now())} MT) — read-only, nothing is written`);
  for (const x of Pl.files) {
    console.log(`\n  ${x.rel}`);
    console.log(`      home now   ${x.home || "(not there — this package creates it)"}`);
    console.log(`      staged     ${x.stagedSha}${x.staged === x.stagedSha ? "" : "   PACKAGE COPY DIFFERS: " + (x.staged || "missing")}`);
    console.log(`      state      ${x.state === "absent" ? "absent — the write mode would create it" : x.state === "applied" ? "applied — home already holds the staged bytes" : x.state}${x.problem ? "   PROBLEM: " + x.problem : ""}`);
  }
  console.log(`\n  unit: ${Pl.problems.length ? "REFUSED by the write mode:\n    - " + Pl.problems.join("\n    - ") : Pl.todo.length ? `the write mode would create ${Pl.todo.map((x) => x.rel).join(", ")} (after the selftest gate)` : "home already holds all six staged files — the write mode would write nothing"}`);
  console.log(`  fences now: ${fz.length ? "the write mode would be REFUSED:\n    - " + fz.join("\n    - ") : "clear (the clock and the node process list)"}`);
  console.log(`  base/ holds no bytes: all six paths are new, so a rollback REMOVES them (node ${PKG_REL}/rollback.cjs --plan).`);
  console.log("  nothing is scheduled, restarted or registered here; the operator starts the collector at home with SEC_USER_AGENT set there.");
}

module.exports = { PKG, REPO, PKG_REL, FILES, sha, fileState, plan, zoneParts, tradingDay, clockFence, listNodeProcs, runsRepoScript, procFence, writeExact, make, mtWords, isCode, HOLIDAYS, P };

if (require.main === module) {
  const args = process.argv.slice(2), MODE = args.length === 1 && ["--plan", "--apply"].includes(args[0]) ? args[0] : null;
  if (!MODE) {
    console.log(`usage: node ${PKG_REL}/deploy.cjs --plan | --apply\n  --plan   read-only: each file's sha256 now / staged, its state, the fences now\n  --apply  the write mode (refused on a trading weekday 05:30-16:00 MT, or while either entry point is running)\nNothing was done.`);
    process.exit(2);
  }
  const Pl = plan();
  if (MODE === "--plan") {
    const M = make();
    let fz;
    try { fz = M.fences(); } catch (e) { fz = [`the fences could not be read (${e.message})`]; }
    printPlan(Pl, fz);
    process.exit(0);
  }
  console.log(`APPLY — insider clusters — ${new Date().toISOString().slice(0, 16)}Z (${mtWords(Date.now())} MT)`);
  const M = make(), r = M.writeUnit({ to: "staged", gate: M.selftestGate });
  if (r.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${r.why.join("\n  - ")}`); process.exit(2); }
  if (r.result === "failed") {
    console.error(`APPLY FAILED: ${r.why.join("; ")}`);
    console.error(r.restored ? "  the tree is back to what it was before this run (the files this run created were removed again)" : `  NOT RESTORED: ${(r.notRestored || []).join("; ")} — remove by hand: node ${PKG_REL}/rollback.cjs --apply`);
    process.exit(1);
  }
  console.log(`\nAPPLIED: ${r.written.length ? "home now holds " + r.written.join(", ") : "home already held all six staged files"}. Nothing is scheduled or restarted.`);
  console.log(`  NEXT: set SEC_USER_AGENT at home (a product name and a way to reach the operator — the SEC asks every caller to declare itself), then`);
  console.log(`        node backend/insider-buys-collect.js --date <a filing day> --dry      (reads sec.gov, writes nothing)`);
  console.log(`        node backend/insider-clusters.js --dry                                 (reads files only)`);
  console.log(`        node ${PKG_REL}/record.cjs --dry, then without --dry (outside 13:50-15:50 MT on a trading day)`);
  process.exit(0);
}
