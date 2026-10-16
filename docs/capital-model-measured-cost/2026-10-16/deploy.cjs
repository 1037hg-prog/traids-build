#!/usr/bin/env node
"use strict";
/**
 * CAPITAL MODEL — MEASURED COST (2026-10-16, work order 4.13) — DEPLOY the measured-cost mode of Plan E's capital model.
 *
 * WHAT IT SHIPS: TWO files, from staged/ (base/ holds the bytes they replace):
 *   backend/profit-program/planE-model.js     + ASSUMED_COSTS and the measured-cost reader / re-pricer / table (additive only)
 *   backend/profit-program/planE-baseline.js  + the --measured-costs <file> switch and the block it prints
 * With no --measured-costs the baseline prints the same bytes and writes the same planE-baseline.json as before — selftest.cjs proves
 * it by running the base script and the staged script side by side on a synthetic fixture and comparing both, byte for byte.
 * NOTES.md says what changed, what is assumed, and what this clean copy is missing.
 *
 *   node docs/capital-model-measured-cost/2026-10-16/deploy.cjs --plan    READ-ONLY. For each file: its sha256 at home NOW, the sha256
 *                                                                        this package was BUILT AGAINST (base) and the STAGED one, and
 *                                                                        its state — base (to apply) · applied · DRIFT (neither:
 *                                                                        refused). The fences now (the clock, the node process list and
 *                                                                        chain-status.json, all read-only). Nothing is written.
 *   node docs/capital-model-measured-cost/2026-10-16/deploy.cjs --apply   the write mode — the operator's command. In order:
 *     1. both files read base or applied (DRIFT -> refused, nothing written); the package's base and staged copies are the bytes it was
 *        built with (a changed copy refuses as well)
 *     2. the fences, any one of which refuses: a trading weekday (Mon-Fri, not a market holiday) between 05:30 and 16:00 MT; a node
 *        process running either file, any other script of backend/profit-program (they all require planE-model.js) or the close chain;
 *        a process list that cannot be read (fail-closed); tonight's close chain started and not finished
 *     3. this package's selftest must end "ALL ... CHECKS PASSED"; then the fences are asked again
 *     4. each file is written from staged (temp file + rename), read back by sha256, then node --check; any failure puts back the bytes
 *        that were there before this run
 * It restarts nothing (every reader of these files is a script started by hand or by the chain, which loads them fresh), writes no data
 * file, never writes change-registry.json or agent-ledger.jsonl (record.cjs does that, after the operator has re-run the baseline), and
 * keeps no state file: home's bytes are the state.
 * Exit 0 applied (or nothing to apply) · 1 failed (the headline says what holds) · 2 refused or usage.
 */
const fs = require("fs"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", ".."), PKG_REL = "docs/capital-model-measured-cost/2026-10-16";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
let HOLIDAYS = {}; try { HOLIDAYS = require(path.join(REPO, "backend", "lib", "run-window.js")).MARKET_HOLIDAYS || {}; } catch { HOLIDAYS = {}; }
/** the two files: the sha256 each was BUILT AGAINST (home's bytes on 2026-10-16) and the staged one */
const FILES = Object.freeze([
  Object.freeze({ rel: "backend/profit-program/planE-model.js", base: "base/backend/profit-program/planE-model.js", staged: "staged/backend/profit-program/planE-model.js",
    baseSha: "d654607668857df95f8d7b40d93e6657410719f11b14b8aa1a471d91b3390ae5", stagedSha: /*STAGED_SHA_MODEL*/"3445144182293482261d48875847aef79ddae9ca2bf026cedec811b22abd8cf0"/*END*/ }),
  Object.freeze({ rel: "backend/profit-program/planE-baseline.js", base: "base/backend/profit-program/planE-baseline.js", staged: "staged/backend/profit-program/planE-baseline.js",
    baseSha: "caaa50ce4471602569c3c0811b8f0f96bdbbaa92416734f22f7365cbeb98e515", stagedSha: /*STAGED_SHA_BASELINE*/"a1d274f8bd9c4d294614a5cb531701a6d966e1e9896aa7ec2df34b5886bb51c0"/*END*/ }),
]);
const isCode = (rel) => /\.(c?js)$/.test(rel);
const P = (root, rel) => path.join(root, ...rel.split("/"));

/** one file's state: home now, the package's base and staged copies, and what they say */
function fileState(f, { repo = REPO, pkg = PKG } = {}) {
  const read = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
  const home = read(P(repo, f.rel)), base = read(P(pkg, f.base)), staged = read(P(pkg, f.staged));
  const r = { rel: f.rel, home: home ? sha(home) : null, base: base ? sha(base) : null, staged: staged ? sha(staged) : null, baseSha: f.baseSha, stagedSha: f.stagedSha, problem: null, state: null };
  if (r.base !== f.baseSha) r.problem = `the package's base copy ${f.base} is ${r.base ? "not the bytes it was built against" : "missing"}`;
  else if (r.staged !== f.stagedSha) r.problem = `the package's staged copy ${f.staged} is ${r.staged ? "not the bytes that were reviewed" : "missing"}`;
  r.state = !home ? "absent" : r.home === f.stagedSha ? "applied" : r.home === f.baseSha ? "base" : "DRIFT";
  return r;
}
/** the plan of the unit: both files' states and whether a write mode could go on (problems = refusals). forRollback: a changed STAGED copy does not stop it */
function plan({ repo = REPO, pkg = PKG, forRollback = false } = {}) {
  const files = FILES.map((f) => fileState(f, { repo, pkg })), problems = [];
  for (const x of files) {
    if (x.problem && !(forRollback && /staged copy/.test(x.problem))) problems.push(`${x.rel}: ${x.problem}`);
    if (x.state === "DRIFT") problems.push(`${x.rel} is DRIFT at home: its sha256 ${String(x.home).slice(0, 12)} is neither the base ${x.baseSha.slice(0, 12)} nor the staged ${x.stagedSha.slice(0, 12)} — someone changed it since this package was built: read the change, then rebuild the package`);
    if (x.state === "absent") problems.push(`${x.rel} is missing at home`);
  }
  const mixed = new Set(files.map((x) => x.state));
  if (!problems.length && mixed.size > 1) problems.push(`the two files are in different states (${files.map((x) => `${x.rel} ${x.state}`).join(", ")}) — this package is one unit: put them both back with rollback.cjs --apply, or read what happened`);
  return { files, problems, todo: files.filter((x) => x.state === "base"), applied: files.every((x) => x.state === "applied") };
}

// ── the clocks (node Intl only; the shell's date is never used) ───────────────────────────────────────────────────────────────
function zoneParts(ms, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`, hh = +p.hour % 24, mm = +p.minute;
  return { date, hh, mm, hm: hh * 60 + mm, hhmm: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`, dow: new Date(date + "T12:00:00Z").getUTCDay() };
}
const tradingDay = (z, holidays) => z.dow >= 1 && z.dow <= 5 && !holidays[z.date];
const mtWords = (ms) => { const z = zoneParts(ms, "America/Denver"); return `${z.date} ${z.hhmm}`; };
/** no write 05:30-16:00 MT on a trading weekday (the session and the runners' hours; these scripts are read by hand around the close) */
function clockFence(nowMs, holidays = HOLIDAYS) {
  const z = zoneParts(nowMs, "America/Denver");
  return tradingDay(z, holidays) && z.hm >= 5 * 60 + 30 && z.hm < 16 * 60 ? `it is ${z.date} ${z.hhmm} MT, a trading day, inside 05:30-16:00 MT — run it after 16:00 MT` : null;
}
/** tonight's chain RUNNING: chain-status.json says a run started today (ET) and has no finished stamp. A status file that cannot be read is
 *  NOT a refusal here (neither file is loaded by the chain) — the process fence below is the fail-closed one. */
function chainFence(nowMs, chainStatus) {
  if (!chainStatus) return null;
  const z = zoneParts(nowMs, "America/New_York"), s = Date.parse(chainStatus.started), d = Number.isFinite(s) ? zoneParts(s, "America/New_York").date : null;
  return d === z.date && !chainStatus.finished ? `chain-status.json says tonight's close chain started ${chainStatus.started} and has not finished — run it once the chain has finished` : null;
}
/** the node processes now -> [{ pid, cmd }] (read-only: Win32_Process on Windows, ps elsewhere); throws when the list cannot be read */
function listNodeProcs() {
  const win = process.platform === "win32";
  const r = win ? cp.spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { [string]$_.ProcessId + \"`t\" + [string]$_.CommandLine }"], { encoding: "utf8", windowsHide: true, timeout: 60000 })
    : cp.spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8", timeout: 30000 });
  if (r.error || r.status !== 0) throw new Error(`${win ? "Get-CimInstance Win32_Process" : "ps"} ${r.error ? r.error.message : `exit ${r.status}: ${String(r.stderr || "").trim().slice(0, 160)}`}`);
  return String(r.stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const m = win ? /^(\d+)\t?(.*)$/.exec(l) : /^(\d+)\s+(.*)$/.exec(l); return m ? { pid: +m[1], cmd: m[2] } : null; }).filter(Boolean);
}
const norm = (s) => String(s || "").replace(/\\/g, "/").toLowerCase();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** does this command line run <rel> of THIS repo? (the repo's absolute path + rel, or rel as a word of its own) */
function runsRepoScript(cmd, rel, repo = REPO) { const c = norm(cmd), r = norm(rel); return c.includes(`${norm(repo)}/${r}`) || new RegExp(`(^|[\\s"'])(\\./)?${esc(r)}($|[\\s"'])`).test(c); }
/** every script of backend/profit-program requires planE-model.js, so none of them may be running while it is replaced */
function runsProfitProgram(cmd, repo = REPO) { const c = norm(cmd); return c.includes(`${norm(repo)}/backend/profit-program/`) || /(^|[\s"'])(\.\/)?backend\/profit-program\/[\w.-]+\.(c?m?js)($|[\s"'])/.test(c); }
function procFence(listProcs, repo = REPO) {
  let procs; try { procs = listProcs(); } catch (e) { return [`the node process list could not be read (${String(e.message).slice(0, 200)}) — nothing is assumed about what is running: refused`]; }
  const out = [], mine = process.pid;
  const chain = procs.filter((p) => p.pid !== mine && runsRepoScript(p.cmd, "automation/close-chain.cjs", repo));
  const pp = procs.filter((p) => p.pid !== mine && runsProfitProgram(p.cmd, repo));
  if (chain.length) out.push(`the close chain is running (node pid ${chain.map((p) => p.pid).join(", ")}) — run it when the chain has finished`);
  if (pp.length) out.push(`a backend/profit-program script is running (node pid ${pp.map((p) => p.pid).join(", ")}) — every one of them requires planE-model.js, which must not change under a run`);
  return out;
}
const readChainStatus = (repo = REPO) => { try { return JSON.parse(fs.readFileSync(path.join(repo, "backend", "data", "chain-status.json"), "utf8")); } catch { return null; } };

/** write bytes so that the file is either the old one or the new one, never half (temp file + rename), then read back by sha256 */
function writeExact(file, buf) {
  const tmp = `${file}.tmp-cmmc-${process.pid}`, fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  if (sha(fs.readFileSync(file)) !== sha(buf)) throw new Error(`${file} does not read back as written`);
}

/**
 * The write steps, on injected dependencies (the selftest gives a scratch repo, a fake clock, a fake process list, a fake gate):
 * repo, pkg, now, log, listProcs() -> [{ pid, cmd }] (throws when unreadable), chainStatus() -> object | null, holidays, run(args) -> { status, out }.
 */
function make(deps = {}) {
  const d = { repo: REPO, pkg: PKG, now: () => Date.now(), log: (s) => console.log(s), listProcs: listNodeProcs, chainStatus: null, holidays: HOLIDAYS, run: null, ...deps };
  if (!d.chainStatus) d.chainStatus = () => readChainStatus(d.repo);
  if (!d.run) d.run = (args, timeoutMs = 1800000) => { const r = cp.spawnSync(process.execPath, args, { cwd: d.repo, encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 256 << 20 }); return { status: r.status, out: String(r.stdout || "") + String(r.stderr || "") }; };
  /** the fences, now: [] or the refusals */
  function fences() {
    const out = [], n = d.now(), c = clockFence(n, d.holidays); if (c) out.push(c);
    const ch = chainFence(n, d.chainStatus()); if (ch) out.push(ch);
    out.push(...procFence(d.listProcs, d.repo));
    return out;
  }
  /** the write mode of deploy (to = "staged") and of rollback (to = "base"): both files or neither */
  function writeUnit({ to, gate = null }) {
    const wantBase = to === "base", Pl = plan({ repo: d.repo, pkg: d.pkg, forRollback: wantBase }), lines = [], say = (s) => { lines.push(s); d.log(s); };
    const refuse = (why) => ({ result: "refused", why, lines, written: [] });
    if (Pl.problems.length) return refuse(Pl.problems);
    const todo = Pl.files.filter((x) => (wantBase ? x.state === "applied" : x.state === "base"));
    let fz = fences(); if (fz.length) return refuse(fz);
    if (gate && todo.length) { say(`  gate: ${gate.what} …`); const g = gate.run(); if (!g.ok) return refuse([`${gate.what} did not pass: ${g.why}`]); say(`  gate: ${g.line}`); fz = fences(); if (fz.length) return refuse(fz); }
    const before = {}, written = [];
    const putBack = () => { const bad = []; for (const [rel, buf] of Object.entries(before)) { try { writeExact(P(d.repo, rel), buf); } catch (e) { bad.push(`${rel}: ${e.message}`); } } return bad; };
    for (const x of todo) {
      const f = FILES.find((y) => y.rel === x.rel), file = P(d.repo, x.rel), now = fs.readFileSync(file);
      if (sha(now) !== x.home) { const bad = putBack(); return { result: "failed", why: [`${x.rel} changed while this ran`], lines, restored: !bad.length, notRestored: bad, written }; }
      before[x.rel] = now;
      const buf = fs.readFileSync(P(d.pkg, wantBase ? f.base : f.staged));
      try { writeExact(file, buf); } catch (e) { const bad = putBack(); return { result: "failed", why: [`writing ${x.rel}: ${e.message}`], lines, restored: !bad.length, notRestored: bad, written }; }
      written.push(x.rel);
      if (isCode(x.rel)) { const c = cp.spawnSync(process.execPath, ["--check", file], { encoding: "utf8", windowsHide: true }); if (c.status !== 0) { const bad = putBack(); return { result: "failed", why: [`${x.rel} does not parse after the write: ${String(c.stderr).trim().split("\n")[0]}`], lines, restored: !bad.length, notRestored: bad, written }; } }
      say(`  wrote ${x.rel}  sha256 ${sha(buf).slice(0, 12)} (${wantBase ? "the base bytes" : "the staged bytes"}), read back and node --check ok`);
    }
    if (!todo.length) say(`  home: nothing to write (both files already read ${wantBase ? "base" : "applied"})`);
    return { result: "done", written, lines };
  }
  /** the package's selftest as the gate (its last line must say ALL ... CHECKS PASSED) */
  const selftestGate = { what: "this package's selftest (selftest.cjs)", run: () => { const r = d.run([path.join(PKG_REL, "selftest.cjs")], 1800000), last = String(r.out).trim().split("\n").pop() || ""; return { ok: r.status === 0 && /^ALL \d+ CHECKS PASSED/.test(last), line: last, why: last || `exit ${r.status}` }; } };
  return { d, fences, writeUnit, selftestGate };
}

function printPlan(Pl, fz) {
  console.log(`PLAN — capital model measured cost (work order 4.13) — ${new Date().toISOString().slice(0, 16)}Z (${mtWords(Date.now())} MT) — read-only, nothing is written`);
  for (const x of Pl.files) {
    console.log(`\n  ${x.rel}`);
    console.log(`      home now   ${x.home || "(missing)"}`);
    console.log(`      base       ${x.baseSha}${x.base === x.baseSha ? "" : "   PACKAGE COPY DIFFERS: " + (x.base || "missing")}   (what this package was built against)`);
    console.log(`      staged     ${x.stagedSha}${x.staged === x.stagedSha ? "" : "   PACKAGE COPY DIFFERS: " + (x.staged || "missing")}`);
    console.log(`      state      ${x.state === "base" ? "base — the write mode would write the staged bytes" : x.state === "applied" ? "applied — home already holds the staged bytes" : x.state}${x.problem ? "   PROBLEM: " + x.problem : ""}`);
  }
  console.log(`\n  unit: ${Pl.problems.length ? "REFUSED by the write mode:\n    - " + Pl.problems.join("\n    - ") : Pl.todo.length ? `the write mode would write ${Pl.todo.map((x) => x.rel).join(" and ")} (after the selftest gate)` : "home already holds the staged bytes — the write mode would write nothing"}`);
  console.log(`  fences now: ${fz.length ? "the write mode would be REFUSED:\n    - " + fz.join("\n    - ") : "clear (the clock, the node process list and chain-status.json)"}`);
  console.log("  nothing is restarted and no data file is written; the default run of planE-baseline.js stays byte-identical (selftest.cjs proves it).");
  console.log(`  after an apply: node backend/profit-program/planE-baseline.js  (the same numbers as before, and the same planE-baseline.json),`);
  console.log(`                  node backend/profit-program/planE-baseline.js --measured-costs <file>  (the new block), then node ${PKG_REL}/record.cjs --dry`);
}

module.exports = { PKG, REPO, PKG_REL, FILES, sha, fileState, plan, zoneParts, tradingDay, clockFence, chainFence, listNodeProcs, runsRepoScript, runsProfitProgram, procFence, readChainStatus, writeExact, make, mtWords, isCode, HOLIDAYS };

if (require.main === module) {
  const args = process.argv.slice(2), MODE = args.length === 1 && ["--plan", "--apply"].includes(args[0]) ? args[0] : null;
  if (!MODE) { console.log(`usage: node ${PKG_REL}/deploy.cjs --plan | --apply\n  --plan   read-only: each file's sha256 now / base / staged, its state, the fences now\n  --apply  the write mode (refused on a trading weekday 05:30-16:00 MT, while the chain or any profit-program script runs)\nNothing was done.`); process.exit(2); }
  const Pl = plan();
  if (MODE === "--plan") { const M = make(); let fz; try { fz = M.fences(); } catch (e) { fz = [`the fences could not be read (${e.message})`]; } printPlan(Pl, fz); process.exit(0); }
  console.log(`APPLY — capital model measured cost — ${new Date().toISOString().slice(0, 16)}Z (${mtWords(Date.now())} MT)`);
  const M = make(), r = M.writeUnit({ to: "staged", gate: M.selftestGate });
  if (r.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${r.why.join("\n  - ")}`); process.exit(2); }
  if (r.result === "failed") { console.error(`APPLY FAILED: ${r.why.join("; ")}`); console.error(r.restored ? "  home's files are back to the bytes they had before this run" : `  NOT RESTORED: ${(r.notRestored || []).join("; ")} — restore by hand: node ${PKG_REL}/rollback.cjs --apply`); process.exit(1); }
  console.log(`\nAPPLIED: home ${r.written.length ? "now holds the staged " + r.written.join(" and ") : "already held the staged bytes"}. Nothing to restart.`);
  console.log(`  NEXT: node backend/profit-program/planE-baseline.js   (it must print what it printed before, to the byte, and rewrite the same planE-baseline.json)`);
  console.log(`        node backend/profit-program/planE-baseline.js --measured-costs <file>   (the measured block; ${PKG_REL}/example-measured-costs.json shows the shape)`);
  console.log(`        node ${PKG_REL}/record.cjs --dry, then without --dry`);
  process.exit(0);
}
