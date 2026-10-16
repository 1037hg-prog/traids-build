#!/usr/bin/env node
"use strict";
/**
 * KELLY COLUMN (2026-10-16, backlog row 23) — DEPLOY. Two files:
 *   backend/lib/kelly.js        NEW. kellyLine(returns per clustering unit) -> full and half Kelly (mean over variance, capped at
 *                               1.0, floored at 0) and the same on the lower end of the mean's 80% confidence interval. Pure, no
 *                               I/O, never throws on bad input.
 *   backend/progress-tests.js   CHANGED. The shared read printer: the sealed-read table gets ONE EXTRA COLUMN that prints that
 *                               line. Nothing else moves — no verdict, bar, sample or statistic is computed from it or changed by
 *                               it, and the three existing cells of every row are byte for byte what they were (selftest.cjs C).
 *
 *   node docs/kelly-column/2026-10-16/deploy.cjs --plan    READ-ONLY. Each file's sha256 at home NOW, the one this package was BUILT
 *                                                          AGAINST (base; for the new file: it must not exist) and the STAGED one,
 *                                                          its state (base / new = to write · applied · DRIFT = neither: refused),
 *                                                          and the fences now (the clock, chain-status.json and the node process
 *                                                          list, all read-only). Nothing is written.
 *   node docs/kelly-column/2026-10-16/deploy.cjs --apply   the write mode — the operator's command at home. In order:
 *     1. each file reads base (or, for the new one, is absent) or applied; DRIFT -> refused, nothing written. The package's own
 *        base and staged copies must be the bytes it was built with
 *     2. the fences (any one refuses, nothing written): a trading weekday (Mon-Fri, not a market holiday) between 05:30 and 16:00
 *        MT; tonight's close chain due or running; a node process running the close chain or the progress report; a process list
 *        that cannot be read (fail-closed)
 *     3. this package's selftest must end "ALL ... CHECKS PASSED"; then the fences are asked again
 *     4. each file is written from staged (temp file + rename), read back by sha256, then node --check. Any failure puts every
 *        file back to the bytes it had (a file that did not exist is removed again)
 * It restarts nothing (the progress email builds in a new process each night), writes no state file (home's bytes are the state)
 * and writes neither change-registry.json nor agent-ledger.jsonl (record.cjs does that).
 * Exit 0 applied (or nothing to apply) · 1 failed (the headline says what holds) · 2 refused or usage.
 */
const fs = require("fs"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", ".."), PKG_REL = "docs/kelly-column/2026-10-16";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
let HOLIDAYS = {}; try { HOLIDAYS = require(path.join(REPO, "backend", "lib", "run-window.js")).MARKET_HOLIDAYS || {}; } catch { HOLIDAYS = {}; }

/**
 * The unit. `baseSha: null` means the file is NEW: home must not have it, base/ holds no copy, and a rollback removes it again.
 * The shas are what this package was built with; sync-shas.cjs rewrites the staged ones when a staged file is edited.
 */
const FILES = Object.freeze([
  Object.freeze({ rel: "backend/lib/kelly.js", base: null, staged: "staged/backend/lib/kelly.js",
    baseSha: null, stagedSha: /*SHA backend/lib/kelly.js*/"c7bfb0298207fdab22a5fdc2ffce8d85ce2cd30f3e28ed0b4d087f4b8964d225"/*END*/ }),
  Object.freeze({ rel: "backend/progress-tests.js", base: "base/backend/progress-tests.js", staged: "staged/backend/progress-tests.js",
    baseSha: "00aac7f6409e6890e3e318531ff8fe8feb902229ee783b9c2492386302e250e4", stagedSha: /*SHA backend/progress-tests.js*/"a25adea6a74265ef346be461dc13abf2215c85e406efe6f0d9c49e3ebbaa2476"/*END*/ }),
]);
const isCode = (rel) => /\.(c?m?js)$/.test(rel);
const P = (root, rel) => path.join(root, ...rel.split("/"));

/** one file's state: home now, the package's base and staged copies, and what they say */
function fileState(f, { repo = REPO, pkg = PKG } = {}) {
  const read = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
  const home = read(P(repo, f.rel)), base = f.base ? read(P(pkg, f.base)) : null, staged = read(P(pkg, f.staged));
  const r = { rel: f.rel, isNew: f.baseSha === null, home: home ? sha(home) : null, base: base ? sha(base) : null, staged: staged ? sha(staged) : null,
    baseSha: f.baseSha, stagedSha: f.stagedSha, problem: null, state: null };
  if (f.base && r.base !== f.baseSha) r.problem = `the package's base copy ${f.base} is ${r.base ? "not the bytes it was built against" : "missing"}`;
  else if (!f.base && f.baseSha !== null) r.problem = `${f.rel} has a baseSha but no base copy in the package`;
  else if (r.staged !== f.stagedSha) r.problem = `the package's staged copy ${f.staged} is ${r.staged ? "not the bytes that were reviewed" : "missing"}`;
  r.state = r.home === f.stagedSha ? "applied"
    : r.isNew ? (home ? "DRIFT" : "new")
      : !home ? "absent" : r.home === f.baseSha ? "base" : "DRIFT";
  return r;
}
/** the plan: the file states and whether a write mode could go on (problems = refusals). forRollback: a changed STAGED copy does not stop it */
function plan({ repo = REPO, pkg = PKG, forRollback = false } = {}) {
  const files = FILES.map((f) => fileState(f, { repo, pkg })), problems = [];
  for (const x of files) {
    if (x.problem && !(forRollback && /staged copy/.test(x.problem))) problems.push(`${x.rel}: ${x.problem}`);
    if (x.state === "DRIFT") problems.push(x.isNew
      ? `${x.rel} is DRIFT at home: this package creates that file, and home already has one (sha256 ${String(x.home).slice(0, 12)}, not the staged ${x.stagedSha.slice(0, 12)}) — read it, then rebuild the package`
      : `${x.rel} is DRIFT at home: its sha256 ${String(x.home).slice(0, 12)} is neither the base ${String(x.baseSha).slice(0, 12)} nor the staged ${x.stagedSha.slice(0, 12)} — someone changed it since this package was built: read the change, then rebuild the package`);
    if (x.state === "absent") problems.push(`${x.rel} is missing at home`);
  }
  const todo = files.filter((x) => x.state === "base" || x.state === "new");
  return { files, problems, todo, applied: files.every((x) => x.state === "applied") };
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
  return tradingDay(z, holidays) && z.hm >= 5 * 60 + 30 && z.hm < 16 * 60 ? `it is ${z.date} ${z.hhmm} MT, a trading day, inside 05:30-16:00 MT — run it after 16:00 MT, once tonight's close chain has finished` : null;
}
/** tonight's chain due: a session day (ET) past 16:00 ET whose chain-status.json is not a FINISHED run started on that ET date */
function chainFence(nowMs, chainStatus, holidays = HOLIDAYS) {
  const z = zoneParts(nowMs, "America/New_York"); if (!tradingDay(z, holidays) || z.hm < 16 * 60) return null;
  const s = chainStatus && Date.parse(chainStatus.started), d = Number.isFinite(s) ? zoneParts(s, "America/New_York").date : null;
  if (d === z.date && chainStatus.finished) return null;
  return `tonight's close chain is due or running: ${z.date} is a session day, it is ${z.hhmm} ET, and chain-status.json ${d === z.date ? "has no finished stamp yet" : `is from ${d || "no readable run"}`} — run it once the chain has finished`;
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
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** does this command line run <rel> of THIS repo? (the repo's absolute path + rel, or rel as a word of its own) */
function runsRepoScript(cmd, rel, repo = REPO) { const c = norm(cmd), r = norm(rel); return c.includes(`${norm(repo)}/${r}`) || new RegExp(`(^|[\\s"'])(\\./)?${escRe(r)}($|[\\s"'])`).test(c); }
/** the progress email builds progress-tests.js into itself: these must not be running while the file changes under them */
const READERS = Object.freeze(["automation/close-chain.cjs", "backend/progress-tests.js", "backend/mail-reports.js"]);
function procFence(listProcs, repo = REPO) {
  let procs; try { procs = listProcs(); } catch (e) { return [`the node process list could not be read (${String(e.message).slice(0, 200)}) — nothing is assumed about the close chain or the progress email: refused`]; }
  const out = [];
  for (const rel of READERS) {
    const hit = procs.filter((p) => p.pid !== process.pid && runsRepoScript(p.cmd, rel, repo));
    if (hit.length) out.push(`${rel} is running (node pid ${hit.map((p) => p.pid).join(", ")}) — these files must not change under a run`);
  }
  return out;
}
const readChainStatus = (repo = REPO) => { try { return JSON.parse(fs.readFileSync(path.join(repo, "backend", "data", "chain-status.json"), "utf8")); } catch { return null; } };

/** write bytes so that the file is either the old one or the new one, never half (temp file + rename), then read back by sha256 */
function writeExact(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-kelly-${process.pid}`, fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  if (sha(fs.readFileSync(file)) !== sha(buf)) throw new Error(`${file} does not read back as written`);
}
/** put a file back to what it was: bytes, or absent (buf === null) */
function restoreOne(file, buf) { if (buf === null) { try { fs.unlinkSync(file); } catch (e) { if (e.code !== "ENOENT") throw e; } } else writeExact(file, buf); }

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
    const ch = chainFence(n, d.chainStatus(), d.holidays); if (ch) out.push(ch);
    out.push(...procFence(d.listProcs, d.repo));
    return out;
  }
  /** the write mode of deploy (to = "staged") and of rollback (to = "base") */
  function writeUnit({ to, gate = null }) {
    const wantBase = to === "base", Pl = plan({ repo: d.repo, pkg: d.pkg, forRollback: wantBase }), lines = [], say = (s) => { lines.push(s); d.log(s); };
    const refuse = (why) => ({ result: "refused", why, lines, written: [] });
    if (Pl.problems.length) return refuse(Pl.problems);
    const todo = Pl.files.filter((x) => (wantBase ? x.state === "applied" : x.state === "base" || x.state === "new"));
    let fz = fences(); if (fz.length) return refuse(fz);
    if (gate && todo.length) { say(`  gate: ${gate.what} …`); const g = gate.run(); if (!g.ok) return refuse([`${gate.what} did not pass: ${g.why}`]); say(`  gate: ${g.line}`); fz = fences(); if (fz.length) return refuse(fz); }
    const before = new Map(), written = [];
    const putBack = () => { const bad = []; for (const [rel, buf] of before) { try { restoreOne(P(d.repo, rel), buf); } catch (e) { bad.push(`${rel}: ${e.message}`); } } return bad; };
    for (const x of todo) {
      const f = FILES.find((y) => y.rel === x.rel), file = P(d.repo, x.rel);
      const now = fs.existsSync(file) ? fs.readFileSync(file) : null;
      if ((now ? sha(now) : null) !== x.home) { const bad = putBack(); return { result: "failed", why: [`${x.rel} changed while this ran`], lines, restored: !bad.length, notRestored: bad, written }; }
      before.set(x.rel, now);
      // rollback of a file this package created removes it again; every other write puts bytes there
      const remove = wantBase && x.isNew;
      try {
        if (remove) { fs.unlinkSync(file); if (fs.existsSync(file)) throw new Error("still there after the unlink"); }
        else writeExact(file, fs.readFileSync(P(d.pkg, wantBase ? f.base : f.staged)));
      } catch (e) { const bad = putBack(); return { result: "failed", why: [`${remove ? "removing" : "writing"} ${x.rel}: ${e.message}`], lines, restored: !bad.length, notRestored: bad, written }; }
      written.push(x.rel);
      if (!remove && isCode(x.rel)) { const c = cp.spawnSync(process.execPath, ["--check", file], { encoding: "utf8", windowsHide: true }); if (c.status !== 0) { const bad = putBack(); return { result: "failed", why: [`${x.rel} does not parse after the write: ${String(c.stderr).trim().split("\n")[0]}`], lines, restored: !bad.length, notRestored: bad, written }; } }
      say(remove ? `  removed ${x.rel} (this package created it)` : `  wrote ${x.rel}  sha256 ${(wantBase ? f.baseSha : f.stagedSha).slice(0, 12)} (${wantBase ? "the base bytes" : "the staged bytes"}), read back and node --check ok`);
    }
    if (!todo.length) say(`  home: nothing to write (every file already reads ${wantBase ? "base" : "applied"})`);
    return { result: "done", written, lines };
  }
  /** the package's selftest as the gate (its last line must say ALL ... CHECKS PASSED) */
  const selftestGate = { what: "this package's selftest (selftest.cjs)", run: () => { const r = d.run([path.join(PKG_REL, "selftest.cjs")], 1800000), last = String(r.out).trim().split("\n").pop() || ""; return { ok: r.status === 0 && /^ALL \d+ CHECKS PASSED/.test(last), line: last, why: last || `exit ${r.status}` }; } };
  return { d, fences, writeUnit, selftestGate };
}

function printPlan(Pl, fz) {
  console.log(`PLAN — kelly column (backend/lib/kelly.js NEW, backend/progress-tests.js) — ${new Date().toISOString().slice(0, 16)}Z (${mtWords(Date.now())} MT) — read-only, nothing is written`);
  for (const x of Pl.files) {
    console.log(`\n  ${x.rel}${x.isNew ? "   (new file: this package creates it)" : ""}`);
    console.log(`      home now   ${x.home || "(absent)"}`);
    console.log(`      base       ${x.isNew ? "(none: the file does not exist at home yet)" : `${x.baseSha}${x.base === x.baseSha ? "" : "   PACKAGE COPY DIFFERS: " + (x.base || "missing")}   (what this package was built against)`}`);
    console.log(`      staged     ${x.stagedSha}${x.staged === x.stagedSha ? "" : "   PACKAGE COPY DIFFERS: " + (x.staged || "missing")}`);
    console.log(`      state      ${x.state === "base" ? "base — the write mode would write the staged bytes" : x.state === "new" ? "new — the write mode would create it from the staged bytes" : x.state === "applied" ? "applied — home already holds the staged bytes" : x.state}${x.problem ? "   PROBLEM: " + x.problem : ""}`);
  }
  console.log(`\n  unit: ${Pl.problems.length ? "REFUSED by the write mode:\n    - " + Pl.problems.join("\n    - ") : Pl.todo.length ? `the write mode would write ${Pl.todo.map((x) => x.rel).join(", ")} (after the selftest gate)` : "home already holds the staged bytes — the write mode would write nothing"}`);
  console.log(`  fences now: ${fz.length ? "the write mode would be REFUSED:\n    - " + fz.join("\n    - ") : "clear (the clock, chain-status.json and the node process list)"}`);
  console.log("  the column is descriptive: no verdict, bar, sample or statistic changes, and the other three cells of every row stay byte for byte (selftest.cjs C).");
  console.log("  no restart is needed or done; change-registry.json and agent-ledger.jsonl are written only by record.cjs.");
}

module.exports = { PKG, REPO, PKG_REL, FILES, sha, fileState, plan, zoneParts, tradingDay, clockFence, chainFence, listNodeProcs, runsRepoScript, procFence, READERS, readChainStatus, writeExact, restoreOne, make, mtWords, isCode, P, HOLIDAYS };

if (require.main === module) {
  const args = process.argv.slice(2), MODE = args.length === 1 && ["--plan", "--apply"].includes(args[0]) ? args[0] : null;
  if (!MODE) { console.log("usage: node docs/kelly-column/2026-10-16/deploy.cjs --plan | --apply\n  --plan   read-only: each file's sha256 now / base / staged, its state, the fences now\n  --apply  the write mode (refused on a trading weekday 05:30-16:00 MT, while the close chain is due or running, while a reader runs)\nNothing was done."); process.exit(2); }
  const Pl = plan();
  if (MODE === "--plan") { const M = make(); let fz; try { fz = M.fences(); } catch (e) { fz = [`the fences could not be read (${e.message})`]; } printPlan(Pl, fz); process.exit(0); }
  console.log(`APPLY — kelly column — ${new Date().toISOString().slice(0, 16)}Z (${mtWords(Date.now())} MT)`);
  const M = make(), r = M.writeUnit({ to: "staged", gate: M.selftestGate });
  if (r.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${r.why.join("\n  - ")}`); process.exit(2); }
  if (r.result === "failed") { console.error(`APPLY FAILED: ${r.why.join("; ")}`); console.error(r.restored ? "  home's files are back to the bytes they had before this run" : `  NOT RESTORED: ${(r.notRestored || []).join("; ")} — restore by hand: node ${PKG_REL}/rollback.cjs --apply`); process.exit(1); }
  console.log(`\nAPPLIED: home ${r.written.length ? "now holds the staged " + r.written.join(", ") : "already held the staged bytes"}. No restart: the progress email builds in a new process each night.`);
  console.log(`  NEXT: node ${PKG_REL}/record.cjs --dry, then without --dry (outside 13:50-15:50 MT on a trading day)`);
  process.exit(0);
}
