#!/usr/bin/env node
"use strict";
/**
 * R275 + R192 FORWARD SHADOWS (2026-10-16) — DEPLOY the three new files that record, each session, what the two
 * sealed rules would have done. They place no order of any kind, hold no position and seal nothing.
 *
 * WHAT IT SHIPS: THREE NEW files from staged/ —
 *   backend/lib/shadow-ledger.js         the append-only per-session record (one row per kind+key, never rewritten)
 *   backend/r275-release-shadow.js       R275's release-day filter, forward
 *   backend/r192-month-end-shadow.js     R192's month-end rule, forward
 * All three are NEW, so base/ holds no bytes for them: `base` for each file is ABSENT at home, and a rollback puts
 * that back by deleting the file. A file that is already there and is not the staged one is DRIFT and refuses.
 * NOTES.md says what the rules are and where they came from; selftest.cjs proves the package on fixtures.
 *
 *   node docs/r275-r192-shadows/2026-10-16/deploy.cjs --plan    READ-ONLY. Each file's sha256 at home NOW and the
 *                                                               STAGED one, its state (absent = to create · applied ·
 *                                                               DRIFT = refused), the fences now (the clock and the
 *                                                               node process list, both read-only), and whether the
 *                                                               nightly chain already calls the two runners. Nothing
 *                                                               is written.
 *   node docs/r275-r192-shadows/2026-10-16/deploy.cjs --apply    the write mode — the main session's command. In order:
 *     1. every file reads absent or applied (DRIFT -> refused, nothing written); the package's staged copies are the
 *        bytes that were reviewed (sha256 pinned below)
 *     2. the fences (either one refuses, nothing written): a trading weekday (Mon-Fri, not a market holiday) between
 *        05:30 and 16:00 MT; a node process running automation/close-chain.cjs; a process list that cannot be read
 *        (fail-closed)
 *     3. this package's selftest must end "ALL ... CHECKS PASSED"; then the fences are asked again
 *     4. each file is written from staged (temp file + rename), read back by sha256, then node --check; any failure
 *        puts every file back the way it was
 * It never restarts anything, never schedules anything, and NEVER WIRES THE RUNNERS INTO THE NIGHTLY CHAIN: adding
 * the two lines to automation/close-chain.cjs is the operator's own edit (NOTES.md, "Wiring"). Until that edit the
 * three files sit there doing nothing, which is the safe state. It writes no change-registry row and no ledger line
 * (record.cjs does that, after the first live run).
 * Exit 0 applied (or nothing to apply) · 1 failed (the headline says what holds) · 2 refused or usage.
 */
const fs = require("fs"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", ".."), PKG_REL = "docs/r275-r192-shadows/2026-10-16";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
let HOLIDAYS = {}; try { HOLIDAYS = require(path.join(REPO, "backend", "lib", "run-window.js")).MARKET_HOLIDAYS || {}; } catch { HOLIDAYS = {}; }

/** the three files. baseSha null = this file does not exist at home before the change (all three are new). */
const FILES = Object.freeze([
  Object.freeze({ rel: "backend/lib/shadow-ledger.js", staged: "staged/backend/lib/shadow-ledger.js", baseSha: null,
    stagedSha: /*STAGED_SHA*/"d831a7272c792b3c526af183a022973897acdd8b739c8fa00f80408e3e1b7b98"/*END*/ }),
  Object.freeze({ rel: "backend/r275-release-shadow.js", staged: "staged/backend/r275-release-shadow.js", baseSha: null,
    stagedSha: /*STAGED_SHA*/"524075a639f4ecfc9ecbe2978f04adc768b55c2bd4e17f8f68e0a596ebaac140"/*END*/ }),
  Object.freeze({ rel: "backend/r192-month-end-shadow.js", staged: "staged/backend/r192-month-end-shadow.js", baseSha: null,
    stagedSha: /*STAGED_SHA*/"abe7d7b1da9bc8d34836dd5e18f3eee373881308220d75b7adc3d8decadb5c37"/*END*/ }),
]);
/** the runners the operator wires into the nightly chain (deploy only REPORTS whether they are wired) */
const RUNNERS = Object.freeze(["backend/r275-release-shadow.js", "backend/r192-month-end-shadow.js"]);
const CHAIN_REL = "automation/close-chain.cjs";
const isCode = (rel) => /\.(c?js)$/.test(rel);
const P = (root, rel) => path.join(root, ...rel.split("/"));

/** one file's state: home now and the package's staged copy, and what they say */
function fileState(f, { repo = REPO, pkg = PKG } = {}) {
  const read = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
  const home = read(P(repo, f.rel)), staged = read(P(pkg, f.staged));
  const r = { rel: f.rel, home: home ? sha(home) : null, staged: staged ? sha(staged) : null, baseSha: f.baseSha, stagedSha: f.stagedSha, problem: null, state: null };
  if (r.staged !== f.stagedSha) r.problem = `the package's staged copy ${f.staged} is ${r.staged ? "not the bytes that were reviewed" : "missing"}`;
  r.state = !home ? "absent" : r.home === f.stagedSha ? "applied" : "DRIFT";
  return r;
}
/** the plan: the file states and whether a write mode could go on (problems = refusals) */
function plan({ repo = REPO, pkg = PKG } = {}) {
  const files = FILES.map((f) => fileState(f, { repo, pkg })), problems = [];
  for (const x of files) {
    if (x.problem) problems.push(`${x.rel}: ${x.problem}`);
    if (x.state === "DRIFT") problems.push(`${x.rel} is DRIFT at home: this package adds it as a NEW file, and a file is already there whose sha256 ${String(x.home).slice(0, 12)} is not the staged ${x.stagedSha.slice(0, 12)} — read what is there before anything is written`);
  }
  return { files, problems, todo: files.filter((x) => x.state === "absent"), applied: files.every((x) => x.state === "applied") };
}

// ── the clocks (node Intl only; the shell's date is never used) ───────────────────────────────────────────────
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
  return tradingDay(z, holidays) && z.hm >= 5 * 60 + 30 && z.hm < 16 * 60 ? `it is ${z.date} ${z.hhmm} MT, a trading day, inside 05:30-16:00 MT — run it after 16:00 MT, once tonight's close chain has finished` : null;
}
/** the node processes now -> [{ pid, cmd }] (read-only: Win32_Process on Windows, ps elsewhere); throws when unreadable */
function listNodeProcs() {
  const win = process.platform === "win32";
  const r = win ? cp.spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { [string]$_.ProcessId + \"`t\" + [string]$_.CommandLine }"], { encoding: "utf8", windowsHide: true, timeout: 60000 })
    : cp.spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8", timeout: 30000 });
  if (r.error || r.status !== 0) throw new Error(`${win ? "Get-CimInstance Win32_Process" : "ps"} ${r.error ? r.error.message : `exit ${r.status}: ${String(r.stderr || "").trim().slice(0, 160)}`}`);
  return String(r.stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const m = win ? /^(\d+)\t?(.*)$/.exec(l) : /^(\d+)\s+(.*)$/.exec(l); return m ? { pid: +m[1], cmd: m[2] } : null; }).filter(Boolean);
}
const norm = (s) => String(s || "").replace(/\\/g, "/").toLowerCase();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** does this command line run <rel> of THIS repo? */
function runsRepoScript(cmd, rel, repo = REPO) { const c = norm(cmd), r = norm(rel); return c.includes(`${norm(repo)}/${r}`) || new RegExp(`(^|[\\s"'])(\\./)?${esc(r)}($|[\\s"'])`).test(c); }
/** the close chain must not be mid-run while new files land beside it; an unreadable list is fail-closed */
function procFence(listProcs, repo = REPO) {
  let procs; try { procs = listProcs(); } catch (e) { return [`the node process list could not be read (${String(e.message).slice(0, 200)}) — nothing is assumed about the close chain: refused`]; }
  const chain = procs.filter((p) => p.pid !== process.pid && runsRepoScript(p.cmd, CHAIN_REL, repo));
  return chain.length ? [`the close chain is running (node pid ${chain.map((p) => p.pid).join(", ")}) — run it when the chain has finished`] : [];
}
/**
 * is the nightly chain already calling the two runners? READ AS TEXT, never required: automation/close-chain.cjs
 * runs the whole nightly chain on require (AGENTS.md). Reporting only — this package never edits that file.
 */
function wiring(repo = REPO) {
  let txt; try { txt = fs.readFileSync(P(repo, CHAIN_REL), "utf8"); } catch (e) { return { chainPresent: false, why: `${CHAIN_REL} is not in this tree (${e.code || e.message})`, wired: {} }; }
  return { chainPresent: true, wired: Object.fromEntries(RUNNERS.map((r) => [r, txt.includes(path.basename(r))])) };
}

/** write bytes so that the file is either absent, the old one or the new one, never half (temp file + rename) */
function writeExact(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-shadows-${process.pid}`, fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  if (sha(fs.readFileSync(file)) !== sha(buf)) throw new Error(`${file} does not read back as written`);
}

/**
 * The write steps, on injected dependencies (the selftest gives a scratch repo, a fake clock, a fake process list,
 * a fake gate): repo, pkg, now, log, listProcs() -> [{ pid, cmd }] (throws when unreadable), holidays, run(args).
 */
function make(deps = {}) {
  const d = { repo: REPO, pkg: PKG, now: () => Date.now(), log: (s) => console.log(s), listProcs: listNodeProcs, holidays: HOLIDAYS, run: null, ...deps };
  if (!d.run) d.run = (args, timeoutMs = 1800000) => { const r = cp.spawnSync(process.execPath, args, { cwd: d.repo, encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 256 << 20 }); return { status: r.status, out: String(r.stdout || "") + String(r.stderr || "") }; };
  /** the fences, now: [] or the refusals */
  function fences() {
    const out = [], c = clockFence(d.now(), d.holidays); if (c) out.push(c);
    out.push(...procFence(d.listProcs, d.repo));
    return out;
  }
  /** the write mode of deploy (to = "staged": create the files) and of rollback (to = "base": delete them again) */
  function writeUnit({ to, gate = null }) {
    const wantBase = to === "base", Pl = plan({ repo: d.repo, pkg: d.pkg }), lines = [], say = (s) => { lines.push(s); d.log(s); };
    const refuse = (why) => ({ result: "refused", why, lines, written: [] });
    if (Pl.problems.length) return refuse(Pl.problems);
    const todo = Pl.files.filter((x) => (wantBase ? x.state === "applied" : x.state === "absent"));
    let fz = fences(); if (fz.length) return refuse(fz);
    if (gate && todo.length) { say(`  gate: ${gate.what} …`); const g = gate.run(); if (!g.ok) return refuse([`${gate.what} did not pass: ${g.why}`]); say(`  gate: ${g.line}`); fz = fences(); if (fz.length) return refuse(fz); }
    const created = [], written = [];
    const putBack = () => { const bad = []; for (const rel of created) { try { fs.unlinkSync(P(d.repo, rel)); } catch (e) { if (e.code !== "ENOENT") bad.push(`${rel}: ${e.message}`); } } return bad; };
    for (const x of todo) {
      const f = FILES.find((y) => y.rel === x.rel), file = P(d.repo, x.rel);
      if (wantBase) {
        const now = fs.readFileSync(file); if (sha(now) !== x.home) return { result: "failed", why: [`${x.rel} changed while this ran`], lines, restored: true, written };
        try { fs.unlinkSync(file); } catch (e) { return { result: "failed", why: [`removing ${x.rel}: ${e.message}`], lines, restored: false, notRestored: [x.rel], written }; }
        written.push(x.rel); say(`  removed ${x.rel} (this package added it; base is ABSENT)`);
        continue;
      }
      if (fs.existsSync(file)) { const bad = putBack(); return { result: "failed", why: [`${x.rel} appeared while this ran`], lines, restored: !bad.length, notRestored: bad, written }; }
      const buf = fs.readFileSync(P(d.pkg, f.staged));
      try { writeExact(file, buf); created.push(x.rel); } catch (e) { const bad = putBack(); return { result: "failed", why: [`writing ${x.rel}: ${e.message}`], lines, restored: !bad.length, notRestored: bad, written }; }
      written.push(x.rel);
      if (isCode(x.rel)) { const c = cp.spawnSync(process.execPath, ["--check", file], { encoding: "utf8", windowsHide: true }); if (c.status !== 0) { const bad = putBack(); return { result: "failed", why: [`${x.rel} does not parse after the write: ${String(c.stderr).trim().split("\n")[0]}`], lines, restored: !bad.length, notRestored: bad, written }; } }
      say(`  wrote ${x.rel}  sha256 ${sha(buf).slice(0, 12)} (the staged bytes), read back and node --check ok`);
    }
    if (!todo.length) say(`  home: nothing to write (every file already reads ${wantBase ? "absent" : "applied"})`);
    return { result: "done", written, lines };
  }
  /** the package's selftest as the gate (its last line must say ALL ... CHECKS PASSED) */
  const selftestGate = { what: "this package's selftest (selftest.cjs)", run: () => { const r = d.run([path.join(PKG_REL, "selftest.cjs")], 1800000), last = String(r.out).trim().split("\n").pop() || ""; return { ok: r.status === 0 && /^ALL \d+ CHECKS PASSED/.test(last), line: last, why: last || `exit ${r.status}` }; } };
  return { d, fences, writeUnit, selftestGate };
}

function printPlan(Pl, fz, W) {
  console.log(`PLAN — R275 + R192 forward shadows — ${new Date().toISOString().slice(0, 16)}Z (${mtWords(Date.now())} MT) — read-only, nothing is written`);
  for (const x of Pl.files) {
    console.log(`\n  ${x.rel}`);
    console.log(`      home now   ${x.home || "(absent — this package adds it)"}`);
    console.log(`      base       (absent: a new file)`);
    console.log(`      staged     ${x.stagedSha}${x.staged === x.stagedSha ? "" : "   PACKAGE COPY DIFFERS: " + (x.staged || "missing")}`);
    console.log(`      state      ${x.state === "absent" ? "absent — the write mode would create it from staged" : x.state === "applied" ? "applied — home already holds the staged bytes" : x.state}${x.problem ? "   PROBLEM: " + x.problem : ""}`);
  }
  console.log(`\n  unit: ${Pl.problems.length ? "REFUSED by the write mode:\n    - " + Pl.problems.join("\n    - ") : Pl.todo.length ? `the write mode would create ${Pl.todo.map((x) => x.rel).join(", ")} (after the selftest gate)` : "home already holds the staged bytes — the write mode would write nothing"}`);
  console.log(`  fences now: ${fz.length ? "the write mode would be REFUSED:\n    - " + fz.join("\n    - ") : "clear (the clock and the node process list)"}`);
  console.log(`\n  wiring (reported only — this package never edits the chain):`);
  if (!W.chainPresent) console.log(`      ${W.why} — add the two lines by hand where the nightly chain runs (NOTES.md, "Wiring")`);
  else for (const r of RUNNERS) console.log(`      ${r}  ${W.wired[r] ? "already named in " + CHAIN_REL : "NOT in " + CHAIN_REL + " — until it is, this runner records nothing"}`);
  console.log(`\n  The three files place no order of any kind and seal nothing; they only write their own JSONL and the JSON beside it.`);
}

module.exports = { PKG, REPO, PKG_REL, FILES, RUNNERS, CHAIN_REL, sha, fileState, plan, zoneParts, tradingDay, clockFence, listNodeProcs, runsRepoScript, procFence, wiring, writeExact, make, mtWords, isCode, HOLIDAYS };

if (require.main === module) {
  const args = process.argv.slice(2), MODE = args.length === 1 && ["--plan", "--apply"].includes(args[0]) ? args[0] : null;
  if (!MODE) { console.log("usage: node docs/r275-r192-shadows/2026-10-16/deploy.cjs --plan | --apply\n  --plan   read-only: each file's sha256 now / staged, its state, the fences now, and whether the chain calls the runners\n  --apply  the write mode (refused on a trading weekday 05:30-16:00 MT, and while the close chain is running)\nNothing was done."); process.exit(2); }
  const Pl = plan();
  if (MODE === "--plan") { const M = make(); let fz; try { fz = M.fences(); } catch (e) { fz = [`the fences could not be read (${e.message})`]; } printPlan(Pl, fz, wiring()); process.exit(0); }
  console.log(`APPLY — R275 + R192 forward shadows — ${new Date().toISOString().slice(0, 16)}Z (${mtWords(Date.now())} MT)`);
  const M = make(), r = M.writeUnit({ to: "staged", gate: M.selftestGate });
  if (r.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${r.why.join("\n  - ")}`); process.exit(2); }
  if (r.result === "failed") { console.error(`APPLY FAILED: ${r.why.join("; ")}`); console.error(r.restored ? "  home is back the way it was before this run" : `  NOT RESTORED: ${(r.notRestored || []).join("; ")} — remove by hand: node ${PKG_REL}/rollback.cjs --apply`); process.exit(1); }
  console.log(`\nAPPLIED: ${r.written.length ? "home now holds " + r.written.join(", ") : "home already held the staged bytes"}. Nothing restarted, nothing scheduled.`);
  const W = wiring();
  console.log(`  NEXT: wire the two runners into the nightly chain by hand (NOTES.md, "Wiring") — ${W.chainPresent ? RUNNERS.filter((x) => !W.wired[x]).join(", ") || "both are already named there" : W.why}`);
  console.log(`        then, after the first night: node ${PKG_REL}/record.cjs --dry, then without --dry`);
  process.exit(0);
}
