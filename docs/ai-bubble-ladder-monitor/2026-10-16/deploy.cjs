#!/usr/bin/env node
"use strict";
/**
 * AI-BUBBLE LADDER MONITOR (2026-10-16) — DEPLOY. Puts the two NEW files of the package in place, as one unit.
 *
 * WHAT IT SHIPS — two files that do not exist at home yet, each copied whole from staged/ (so base/ holds nothing:
 * the bytes this package starts from are "the file is not there", and the rollback is to remove them again):
 *   backend/ai-bubble-ladder.js            the B1 and B2 rungs as arithmetic over stored daily closes; reads series
 *                                          files, computes, writes nothing
 *   backend/ai-bubble-ladder-monitor.js    the daily reading: prints a plain summary, and with --write puts the day's
 *                                          status in backend/data/ai-bubble-ladder-status.json and nothing else
 * It adds nothing to the close chain, no switch, no scheduled run and no registry row: after the apply the monitor
 * exists and is run by hand (NOTES.md, "After the apply"). record.cjs writes the change-registry row, later.
 *
 *   node docs/ai-bubble-ladder-monitor/2026-10-16/deploy.cjs --plan    READ-ONLY. For each file: its sha256 live NOW
 *                                                                     and the STAGED one, and its state — absent (to
 *                                                                     create) · applied · DRIFT (there, and not the
 *                                                                     staged bytes: refused). The fences now. Nothing
 *                                                                     is written.
 *   node docs/ai-bubble-ladder-monitor/2026-10-16/deploy.cjs --apply   the write mode — the main session's command:
 *     1. every file reads absent or applied, and the package's own staged copies are the bytes pinned below (DRIFT, or
 *        a staged copy that is not its pin -> refused, nothing written)
 *     2. the fences (any one refuses, nothing written): 13:50-15:50 MT on a trading weekday (the close chain owns
 *        backend/ then); either file of the unit, or automation/close-chain.cjs, running in the process list; a
 *        process list that cannot be read (fail-closed)
 *     3. this package's selftest must EXIT 0 with "ALL <n> CHECKS PASSED" as the last line of its STDOUT (its stderr
 *        is shown, never judged); the fences are asked again
 *     4. each file is written from staged/ (temp file + rename), read back by sha256 and node --check'ed. Any failure
 *        removes every file this run created — there is nothing else to put back, because there was no file before.
 * It never touches backend/data, the registry, the chain file, a switch or the server; it makes no network call and no
 * broker call; it never requires automation/close-chain.cjs (node --check only, and not even that: it only looks for
 * it in the process list). The live bytes are the whole state — this package keeps no state file.
 * Exit 0 applied / nothing to do · 1 failed · 2 refused or usage.
 */
const fs = require("fs"), path = require("path"), cp = require("child_process"), crypto = require("crypto");

const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", ".."), PKG_REL = "docs/ai-bubble-ladder-monitor/2026-10-16";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

/** the files this package creates. base is null: each one does not exist at home before the apply. */
const FILES = Object.freeze([
  Object.freeze({ rel: "backend/ai-bubble-ladder.js", staged: "staged/backend/ai-bubble-ladder.js",
    stagedSha: /*PIN ladder*/"70443023c9d7054419d7eb771de56469e3e634a25d4d1e345a563ef31be70aa3"/*END*/ }),
  Object.freeze({ rel: "backend/ai-bubble-ladder-monitor.js", staged: "staged/backend/ai-bubble-ladder-monitor.js",
    stagedSha: /*PIN monitor*/"1db9d554e8793f826263cafd65c602c49c67049ce6fa8008667887a40b309d66"/*END*/ }),
]);
/** the one file the monitor itself writes at home. This package never writes it, and the rollback never removes it. */
const DATA_REL = "backend/data/ai-bubble-ladder-status.json";
/** the close chain's window: no apply and no rollback from 13:50 to 15:50 MT on a trading weekday */
const WINDOW = Object.freeze({ from: 13 * 60 + 50, to: 15 * 60 + 50 });
/** the process names that must not be running while backend/ is written */
const BUSY = Object.freeze([/ai-bubble-ladder(-monitor)?\.js/, /automation[\\/]close-chain\.cjs/]);
const RESULT_LINE = /^ALL \d+ CHECKS PASSED/;
const isCode = (rel) => /\.(c?js|mjs)$/.test(rel);

let HOLIDAYS = null;
const holidayTable = () => { if (HOLIDAYS) return HOLIDAYS;
  try { HOLIDAYS = require(path.join(REPO, "backend", "lib", "run-window.js")).MARKET_HOLIDAYS || {}; } catch { HOLIDAYS = {}; }
  return HOLIDAYS; };

/** the Mountain-time clock: { date, dow, hms, mins, tradingWeekday } */
function mtNow(nowMs = Date.now(), holidays = null) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", hourCycle: "h23",
    weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(nowMs)).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`, hh = +p.hour % 24, H = holidays || holidayTable();
  const dow = new Date(date + "T12:00:00Z").getUTCDay();
  return { date, dow: p.weekday, hms: `${String(hh).padStart(2, "0")}:${p.minute}:${p.second}`, mins: hh * 60 + +p.minute,
    tradingWeekday: dow >= 1 && dow <= 5 && !H[date] };
}
/** the live process list as [{ pid, cmd }]. Throws when it cannot be read — the caller treats that as a refusal. */
function procs() {
  const win = process.platform === "win32";
  const r = win
    ? cp.spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"], { encoding: "utf8", timeout: 60000, windowsHide: true })
    : cp.spawnSync("ps", ["-eo", "pid=,command="], { encoding: "utf8", timeout: 60000 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`the process list could not be read (exit ${r.status}): ${String(r.stderr || "").trim().slice(0, 160)}`);
  return String(r.stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^(\d+)[\t\s]+(.*)$/);
    return m ? { pid: +m[1], cmd: m[2] } : null;
  }).filter(Boolean);
}

/** one file's state: live now, the package's staged copy, and what the two say */
function fileState(f, { repo = REPO, pkg = PKG } = {}) {
  const read = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
  const live = read(path.join(repo, ...f.rel.split("/"))), staged = read(path.join(pkg, ...f.staged.split("/")));
  const r = { rel: f.rel, live: live ? sha(live) : null, staged: staged ? sha(staged) : null, stagedSha: f.stagedSha, problem: null, state: null };
  if (r.staged !== f.stagedSha) r.problem = `the package's staged copy ${f.staged} is ${r.staged ? "not the bytes that were reviewed" : "missing"}`;
  r.state = !live ? "absent" : r.live === f.stagedSha ? "applied" : "DRIFT";
  return r;
}
/** the plan: every file's state and the refusals that come from the files themselves */
function plan({ repo = REPO, pkg = PKG } = {}) {
  const files = FILES.map((f) => fileState(f, { repo, pkg })), problems = [];
  for (const x of files) {
    if (x.problem) problems.push(`${x.rel}: ${x.problem}`);
    if (x.state === "DRIFT") problems.push(`${x.rel} is DRIFT: it is already there with sha256 ${String(x.live).slice(0, 12)}, which is not the staged ${x.stagedSha.slice(0, 12)} — this package creates that file, so something else wrote it: read it, then rebuild the package`);
  }
  return { files, problems, toCreate: files.filter((x) => x.state === "absent"), created: files.filter((x) => x.state === "applied"),
    allApplied: files.every((x) => x.state === "applied"), allAbsent: files.every((x) => x.state === "absent") };
}

/** THE FENCES -> [] or the refusals. o: { now, procList, holidays, self } */
function fences({ now = Date.now(), procList, holidays, self = process.pid } = {}) {
  const why = [], mt = mtNow(now, holidays);
  if (mt.tradingWeekday && mt.mins >= WINDOW.from && mt.mins < WINDOW.to)
    why.push(`${mt.hms} MT ${mt.dow} ${mt.date} is inside 13:50-15:50 MT on a trading weekday (the close chain owns backend/ then) — run it before 13:50 or after 15:50 MT`);
  try {
    const list = typeof procList === "function" ? procList() : procList || procs();
    const hit = list.filter((p) => p.pid !== self && BUSY.some((re) => re.test(String(p.cmd))));
    if (hit.length) why.push(`a process of this unit is running: ${hit.map((p) => `pid ${p.pid} ${String(p.cmd).replace(/\s+/g, " ").slice(0, 120)}`).join(" | ")}`);
  } catch (e) { why.push(`the process list cannot be read (${String((e && e.message) || e).slice(0, 120)}) — refusing to write into backend/ without knowing what is running`); }
  return why;
}

/** write bytes so the file is either absent, the old one, or the new one — never half (temp file + rename) */
function writeExact(file, buf) {
  const tmp = `${file}.tmp-ladder-${process.pid}`, fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
  if (sha(fs.readFileSync(file)) !== sha(buf)) throw new Error(`${file} does not read back as written`);
}

/** the last non-empty line of a text ("" when there is none) */
const lastLine = (t) => String(t == null ? "" : t).trim().split(/\r?\n/).pop() || "";
const textLines = (t) => String(t == null ? "" : t).split(/\r?\n/).filter((l) => l.trim());
/** a child's stderr as one short note: it is shown, never judged */
const stderrShown = (e) => { const L = textLines(e); return L.length ? `its stderr (${L.length} line(s); shown, never judged): ${L[0].trim().slice(0, 300)}${L.length > 1 ? ` … ${L[L.length - 1].trim().slice(0, 300)}` : ""}` : ""; };
/** THE GATE'S VERDICT on a run of the selftest: exit 0 AND "ALL n CHECKS PASSED" as the last line of its STDOUT */
function selftestVerdict(r) {
  const x = r || {}, line = lastLine(x.stdout), ok = x.status === 0 && RESULT_LINE.test(line), shown = stderrShown(x.stderr);
  if (ok) return { ok, line, why: "", note: shown };
  const fails = textLines(x.stdout).filter((l) => /^FAIL/.test(l)).slice(0, 8);
  return { ok, line, note: shown,
    why: [`exit ${x.status}`, line ? `the last line of its stdout: ${line.slice(0, 300)}` : "nothing on its stdout", ...fails, x.error ? `the run: ${String(x.error).slice(0, 200)}` : "", shown].filter(Boolean).join("; ") };
}

/**
 * the write modes on injected dependencies (the selftest gives a scratch repo and fake children):
 *   { repo, pkg, now, procList, holidays, log, run(args) -> { status, stdout, stderr, error }, write(file, buf), remove(file) }
 */
function make(deps = {}) {
  const d = { repo: REPO, pkg: PKG, now: () => Date.now(), log: (s) => console.log(s), write: writeExact,
    remove: (f) => { try { fs.unlinkSync(f); return true; } catch (e) { return e.code === "ENOENT"; } },
    procList: undefined, holidays: undefined, run: null, ...deps };
  if (!d.run) d.run = (args) => {
    // the gate's child never inherits the selftest's one override: the gate always judges the package's own staged/
    const env = { ...process.env }; delete env.AI_BUBBLE_LADDER_SELFTEST_STAGED;
    const r = cp.spawnSync(process.execPath, args, { cwd: d.repo, encoding: "utf8", timeout: 1800000, windowsHide: true, maxBuffer: 256 << 20, env });
    return { status: r.status, stdout: String(r.stdout || ""), stderr: String(r.stderr || ""), error: r.error ? String(r.error.message || r.error) : null }; };
  const fz = () => fences({ now: d.now(), procList: d.procList, holidays: d.holidays, repo: d.repo });
  /** the selftest as the gate of the apply: AI_BUBBLE_LADDER_SELFTEST_STAGED is never set, so it runs on staged/ */
  const selftestGate = { what: "this package's selftest (selftest.cjs) on the staged bytes", run: () => selftestVerdict(d.run([path.join(PKG_REL, "selftest.cjs")])) };

  /** --apply: create the files. Any failure removes every file this run created. */
  function apply({ gate = selftestGate } = {}) {
    const lines = [], say = (s) => { lines.push(s); d.log(s); };
    const P = plan({ repo: d.repo, pkg: d.pkg });
    if (P.problems.length) return { result: "refused", why: P.problems, lines, created: [] };
    if (!P.toCreate.length) { say("  nothing to apply: both files are already the staged bytes"); return { result: "noop", lines, created: [] }; }
    let f = fz(); if (f.length) return { result: "refused", why: f, lines, created: [] };
    if (gate) {
      say(`  gate: ${gate.what} …`);
      const g = gate.run();
      if (!g || !g.ok) return { result: "refused", why: [`${gate.what} did not pass: ${g ? g.why : "no answer"}`], lines, created: [] };
      say(`  gate: ${g.line}`); if (g.note) say(`  gate: ${g.note}`);
      f = fz(); if (f.length) return { result: "refused", why: f, lines, created: [] };
    }
    const created = [];
    const undo = () => { const bad = []; for (const rel of created) if (!d.remove(path.join(d.repo, ...rel.split("/")))) bad.push(rel); return bad; };
    for (const x of P.toCreate) {
      const spec = FILES.find((y) => y.rel === x.rel), file = path.join(d.repo, ...x.rel.split("/"));
      if (fs.existsSync(file)) { const bad = undo(); return { result: "failed", why: [`${x.rel} appeared while this ran — nothing more written`], lines, created, undone: !bad.length, notUndone: bad }; }
      const buf = fs.readFileSync(path.join(d.pkg, ...spec.staged.split("/")));
      try { d.write(file, buf); if (sha(fs.readFileSync(file)) !== sha(buf)) throw new Error("it does not read back as written"); }
      catch (e) { const bad = undo(); return { result: "failed", why: [`writing ${x.rel}: ${e.message}`], lines, created, undone: !bad.length, notUndone: bad }; }
      created.push(x.rel);
      if (isCode(x.rel)) { const c = cp.spawnSync(process.execPath, ["--check", file], { encoding: "utf8", windowsHide: true });
        if (c.status !== 0) { const bad = undo(); return { result: "failed", why: [`${x.rel} does not parse after the write: ${String(c.stderr).trim().split("\n")[0]}`], lines, created, undone: !bad.length, notUndone: bad }; } }
      say(`  created ${x.rel}  sha256 ${sha(buf).slice(0, 12)} (the staged bytes), read back, node --check ok`);
    }
    return { result: "applied", lines, created };
  }

  /** --rollback: remove the files this package created, and nothing else. A DRIFT file is never removed. */
  function rollback() {
    const lines = [], say = (s) => { lines.push(s); d.log(s); };
    const P = plan({ repo: d.repo, pkg: d.pkg });
    const drift = P.files.filter((x) => x.state === "DRIFT");
    if (drift.length) return { result: "refused", lines, removed: [],
      why: drift.map((x) => `${x.rel} is DRIFT: it is not the bytes this package wrote (${String(x.live).slice(0, 12)} vs ${x.stagedSha.slice(0, 12)}) — it was changed after the apply, and this rollback never deletes a file it does not recognise. Read the change first.`) };
    if (!P.created.length) { say("  nothing to roll back: neither file is there"); return { result: "noop", lines, removed: [] }; }
    const f = fz(); if (f.length) return { result: "refused", why: f, lines, removed: [] };
    const removed = [], bad = [];
    for (const x of P.created) { const file = path.join(d.repo, ...x.rel.split("/"));
      if (d.remove(file)) { removed.push(x.rel); say(`  removed ${x.rel} (it did not exist before the apply, so this is its base)`); }
      else bad.push(x.rel); }
    if (bad.length) return { result: "failed", why: [`could not remove ${bad.join(", ")}`], lines, removed };
    say(`  ${DATA_REL} is NOT touched: it is the monitor's own record at home, not part of this package.`);
    return { result: "rolled-back", lines, removed };
  }

  return { d, fences: fz, plan: () => plan({ repo: d.repo, pkg: d.pkg }), selftestGate, apply, rollback };
}

const mtWords = (ms) => { const m = mtNow(ms); return `${m.dow} ${m.date} ${m.hms} MT`; };

function printPlan(P, fz, { title = "DEPLOY" } = {}) {
  const back = title === "ROLLBACK";
  console.log(`${title} PLAN — AI-bubble ladder monitor (two NEW files) — ${mtWords(Date.now())} — read-only, nothing is written`);
  for (const x of P.files) {
    const says = x.state === "absent" ? (back ? "absent — nothing to remove (this IS its base)" : "absent — --apply would create it")
      : x.state === "applied" ? (back ? "applied — --apply would remove it" : "applied — the live file holds the staged bytes")
      : "DRIFT — it is there and is NOT the staged bytes: the write modes REFUSE";
    console.log(`\n  ${x.rel}`);
    console.log(`      live now   ${x.live || "(not there — this package creates it)"}`);
    console.log(`      staged     ${x.stagedSha}${x.staged === x.stagedSha ? "" : `   PACKAGE COPY DIFFERS: ${x.staged || "missing"}`}`);
    console.log(`      state      ${says}${x.problem ? `   PROBLEM: ${x.problem}` : ""}`);
  }
  if (!back) console.log(`\n  unit: ${P.problems.length ? `REFUSED by the write mode:\n    - ${P.problems.join("\n    - ")}` : P.toCreate.length ? `--apply would create ${P.toCreate.map((x) => x.rel).join(", ")}` : "both files hold the staged bytes — nothing to apply"}`);
  console.log(`  fences now: ${fz.length ? `the write mode would be REFUSED:\n    - ${fz.join("\n    - ")}` : "clear"}`);
  console.log(`  ${DATA_REL} is never written by this package (the monitor writes it, with --write, when the operator runs it).`);
  if (!back) console.log("  Nothing is added to the close chain, no switch is set, no registry row is written (record.cjs does that, later).");
  console.log("  nothing was written.");
}

module.exports = { PKG, REPO, PKG_REL, FILES, DATA_REL, WINDOW, BUSY, RESULT_LINE, sha, mtNow, procs, fileState, plan,
  fences, writeExact, lastLine, textLines, stderrShown, selftestVerdict, make, printPlan, mtWords, isCode };

if (require.main === module) {
  const args = process.argv.slice(2), MODE = args.length === 1 && ["--plan", "--apply"].includes(args[0]) ? args[0] : null;
  if (!MODE) {
    console.log(`usage: node ${PKG_REL}/deploy.cjs --plan | --apply
  --plan   read-only: each file's sha256 live and staged, its state (absent / applied / DRIFT), and the fences now
  --apply  the write mode: creates the two files after the selftest passes (refused 13:50-15:50 MT on a trading
           weekday, while a process of the unit or the close chain is running, or if the process list cannot be read)
Nothing was done.`);
    process.exit(2);
  }
  const P = plan();
  if (MODE === "--plan") { let fz; try { fz = fences(); } catch (e) { fz = [`the fences could not be read (${e.message})`]; } printPlan(P, fz); process.exit(0); }
  console.log(`APPLY — AI-bubble ladder monitor — ${mtWords(Date.now())}`);
  const r = make().apply();
  if (r.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${r.why.join("\n  - ")}`); process.exit(2); }
  if (r.result === "noop") { console.log("nothing to apply: both files already hold the staged bytes."); process.exit(0); }
  if (r.result === "failed") {
    console.error(`APPLY FAILED: ${r.why.join("; ")}`);
    console.error(r.undone ? "  every file this run created has been removed — the repository is as it was" : `  NOT UNDONE: ${(r.notUndone || []).join(", ")} — remove by hand, or: node ${PKG_REL}/rollback.cjs --apply`);
    process.exit(1);
  }
  console.log(`\nAPPLIED: ${r.created.join(", ")} now hold the staged bytes.`);
  console.log("  Nothing to restart: no running program loads these files, and nothing schedules them.");
  console.log("  NEXT (NOTES.md, 'After the apply'):");
  console.log("    node backend/ai-bubble-ladder-monitor.js                 the reading, writing nothing");
  console.log("    node backend/ai-bubble-ladder-monitor.js --write         the same, and the day's status in backend/data/");
  console.log(`    node ${PKG_REL}/record.cjs --dry, then without --dry`);
  console.log(`    back: node ${PKG_REL}/rollback.cjs --apply (it removes the two files and leaves ${DATA_REL} alone)`);
  process.exit(0);
}
