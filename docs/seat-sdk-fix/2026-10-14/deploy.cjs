#!/usr/bin/env node
"use strict";
/**
 * SEAT-SDK FIX (2026-10-14, option B) — DEPLOY the launcher fix of the seat-SDK trial: the runner keeps CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1
 * (the key stays out of the seats' commands), the launcher runs in the mode Claude Code allows with it ("default"), and the runner
 * answers every permission question itself, allowing exactly each seat's own tools (NOTES.md, "Option B").
 *
 * WHAT IT SHIPS — three files, each copied whole from staged/ over the live file (FILES below; base/ holds a byte copy of each live
 * file as it was when the package was built, and is the rollback):
 *   automation/seat-sdk/run-seat.cjs                           the runner: its permission gate and its stricter start-of-session check
 *   docs/seat-sdk-trial/2026-10-12/selftest.cjs                the trial's selftest: five cases that asserted the old instrument now
 *                                                              assert the new one, one case added (no case removed; NOTES.md lists each edit)
 *   docs/seat-sdk-trial/2026-10-12/harness/fake-sdk-core.cjs   the trial's fake SDK: it reports what the real launcher reports (key
 *                                                              source ANTHROPIC_API_KEY, "default" with the scrub on) and knows canUseTool
 *
 *   node docs/seat-sdk-fix/2026-10-14/deploy.cjs --plan    READ-ONLY. For each file: its sha256 live NOW, the base and the staged sha256,
 *                                                           and its state: base (to apply) · applied · DRIFT (neither: refused). The
 *                                                           fences now. Nothing is written.
 *   node docs/seat-sdk-fix/2026-10-14/deploy.cjs --apply   the write mode — the main session's command. In order:
 *     1. every file reads base or applied, and the package's own base and staged copies are the bytes pinned below (DRIFT or a
 *        package copy that is not its pin -> refused, nothing written)
 *     2. fences: not while the seat wave is running (a node process running automation/seat-wave.cjs or the SDK runner, the wave's
 *        launcher seat-wave.bat, or a wave start in automation/seat-wave.log with no end in the last 90 minutes; a process list that
 *        cannot be read is a refusal), and not between 16:05 and 18:30 MT on a trading weekday (the wave starts 16:15 MT)
 *     3. this package's selftest must EXIT 0 and the last line of its STDOUT must read "ALL ... CHECKS PASSED" (its stderr — the SDK's
 *        advisory process warning lands there — is shown, never judged: selftestVerdict); the fences are asked again
 *     4. each file still to write is read again (it must be what the plan read), written from staged/ (temp file + rename), read back
 *        by sha256 and node --check'ed; any failure puts every file this run wrote back to the bytes it had before
 *     5. verify-live.cjs: a FAIL (or a run that does not end) puts the base bytes back; an UNKNOWN is printed and left to read
 * It NEVER touches backend/data/seat-provider.json (the switch stays what it is: no seat changes launcher by this apply), never starts a
 * seat, never restarts anything, never writes a registry file (record.cjs does, later), and keeps no state file: the live bytes are
 * the state, base/ is the backup.
 * Exit 0 applied / nothing to apply · 1 failed or undone (the headline says what holds) · 2 refused or usage.
 */
const fs = require("fs"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", ".."), PKG_REL = "docs/seat-sdk-fix/2026-10-14";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const TRIAL_LIB = () => require(path.join(REPO, "docs", "seat-sdk-trial", "2026-10-12", "lib.cjs"));   // the trial's own fences (procs, holidays, the wave's log): read, never edited
/** the files: the sha256 each was BUILT AGAINST (the live bytes on 2026-10-14) and the staged one */
const FILES = Object.freeze([
  Object.freeze({ rel: "automation/seat-sdk/run-seat.cjs", base: "base/automation/seat-sdk/run-seat.cjs", staged: "staged/automation/seat-sdk/run-seat.cjs",
    baseSha: "c98e79b87c9face11d039292fd1d2e61e70a206c365ed11e9617284b452dc7dd", stagedSha: /*PIN run-seat*/"6ffb315ffc48c312de3576fdb50251bbca7ff360c90d9ee9d882fdb241f81ded"/*END*/ }),
  Object.freeze({ rel: "docs/seat-sdk-trial/2026-10-12/selftest.cjs", base: "base/docs/seat-sdk-trial/2026-10-12/selftest.cjs", staged: "staged/docs/seat-sdk-trial/2026-10-12/selftest.cjs",
    baseSha: "73abceb399667e6caffb5a93f682dec586b2a8b23db1824a13ddb3dc457b118c", stagedSha: /*PIN trial-selftest*/"a15ebb494b2ec4f1366202ca90a0c207ffee5f40dc4c28d947ded2a63530ae7e"/*END*/ }),
  Object.freeze({ rel: "docs/seat-sdk-trial/2026-10-12/harness/fake-sdk-core.cjs", base: "base/docs/seat-sdk-trial/2026-10-12/harness/fake-sdk-core.cjs", staged: "staged/docs/seat-sdk-trial/2026-10-12/harness/fake-sdk-core.cjs",
    baseSha: "3716f7d55aec2ceeab17540724a0f8f8d2c9888bc1a459e9c66b9bc2e08f73ec", stagedSha: /*PIN fake-core*/"7b6ad86b2542b9812552aa43b3e2a370072036d8f00b4e14c523d436971109e7"/*END*/ }),
]);
/** the one file of the trial this package must never write (the operator's switch) */
const SWITCH_REL = "backend/data/seat-provider.json";
/** the wave's window: no apply and no rollback from 16:05 to 18:30 MT on a trading weekday (the wave starts at 16:15 MT) */
const WINDOW = Object.freeze({ from: 16 * 60 + 5, to: 18 * 60 + 30 });
const isCode = (rel) => /\.(c?js|mjs)$/.test(rel);

// ── a child's result: its exit code and its STDOUT; its stderr is shown, never judged (gate repair, 2026-10-15) ──────────────────────
/** the last non-empty line of a child's text, trailing white space taken off ("" when there is none). A result line is read from STDOUT only. */
const lastLine = (text) => String(text == null ? "" : text).trim().split(/\r?\n/).pop() || "";
/** the non-empty lines of a text, as they are */
const textLines = (text) => String(text == null ? "" : text).split(/\r?\n/).filter((l) => l.trim());
/** the package selftest's result line (selftest.cjs prints it last on its stdout) */
const RESULT_LINE = /^ALL \d+ CHECKS PASSED/;
/** a stderr line that says WHY a child failed: an error's own line ("Error: …", "TypeError: …", "AssertionError [ERR_…]: …") or a FAIL line */
const WHY_LINE = /^\s*(\w*Error|FAIL)\b/;
/**
 * a child's stderr as one short text for a message ("" when it printed nothing there): how many non-empty lines, the first, the FIRST
 * LINE BETWEEN THEM THAT SAYS WHY (WHY_LINE), and the last — each cut at 300 characters, so at most about 1000 in all. (review
 * 2026-10-15, cycle 1: an uncaught throw's stderr starts with its "file:line" and ends with "Node.js vX"; the error's own text sits
 * between, and a refusal that showed the first and the last alone did not say why.) It is a message only: no verdict reads it.
 */
const stderrShown = (stderr) => {
  const e = textLines(stderr); if (!e.length) return "";
  const why = e.slice(1, -1).find((l) => WHY_LINE.test(l));
  return `its stderr (${e.length} line(s); shown, never judged): ${e[0].trim().slice(0, 300)}${why ? ` … ${why.trim().slice(0, 300)}` : ""}${e.length > 1 ? ` … ${e[e.length - 1].trim().slice(0, 300)}` : ""}`;
};
/**
 * THE GATE'S VERDICT on a run of the package selftest, { status, stdout, stderr, error } -> { ok, line, why, note }. It passes only when
 * the child EXITED 0 AND the last non-empty line of its STDOUT reads "ALL n CHECKS PASSED". Its STDERR never decides, either way: the
 * probes the selftest runs make the SDK print an advisory process warning there ("(node:…) [CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] Warning:
 * canUseTool will not be invoked: …"; advisory: sdk.mjs line 109, processControlRequest, asks canUseTool for every can_use_tool
 * request whatever the mode), and on 2026-10-15 10:41 MT the gate, reading the last line of stdout + stderr, read that warning and
 * refused a selftest that had passed. stderr is kept for the message: in `why` when the gate fails, in `note` (printed) when it passes.
 */
function selftestVerdict(r) {
  const x = r || {}, line = lastLine(x.stdout), ok = x.status === 0 && RESULT_LINE.test(line), shown = stderrShown(x.stderr);
  if (ok) return { ok, line, why: "", note: shown };
  const why = [`exit ${x.status}`, line ? `the last line of its stdout: ${line.slice(0, 300)}` : "nothing on its stdout", x.error ? `the run: ${String(x.error).slice(0, 200)}` : "", shown].filter(Boolean).join("; ");
  return { ok, line, why, note: shown };
}

/** one file's state: live now, the package's base and staged copies, and what they say */
function fileState(f, { repo = REPO, pkg = PKG } = {}) {
  const read = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
  const live = read(path.join(repo, ...f.rel.split("/"))), base = read(path.join(pkg, ...f.base.split("/"))), staged = read(path.join(pkg, ...f.staged.split("/")));
  const r = { rel: f.rel, live: live ? sha(live) : null, base: base ? sha(base) : null, staged: staged ? sha(staged) : null, baseSha: f.baseSha, stagedSha: f.stagedSha, problem: null, state: null };
  if (r.base !== f.baseSha) r.problem = `the package's base copy ${f.base} is ${r.base ? "not the bytes it was built against" : "missing"}`;
  else if (r.staged !== f.stagedSha) r.problem = `the package's staged copy ${f.staged} is ${r.staged ? "not the bytes that were reviewed" : "missing"}`;
  r.state = !live ? "absent" : r.live === f.stagedSha ? "applied" : r.live === f.baseSha ? "base" : "DRIFT";
  return r;
}
/** the plan: every file's state, and the refusals of the write modes (problems). forRollback: a staged copy that is not its pin does not stop a rollback (it writes base bytes only) */
function plan({ repo = REPO, pkg = PKG, forRollback = false } = {}) {
  const files = FILES.map((f) => fileState(f, { repo, pkg })), problems = [];
  for (const x of files) {
    if (x.problem && !(forRollback && /staged copy/.test(x.problem))) problems.push(`${x.rel}: ${x.problem}`);
    if (x.state === "DRIFT") problems.push(`${x.rel} is DRIFT: its sha256 ${String(x.live).slice(0, 12)} is neither the base ${x.baseSha.slice(0, 12)} nor the staged ${x.stagedSha.slice(0, 12)} — it was changed since this package was built: read the change, then rebuild the package`);
    if (x.state === "absent") problems.push(`${x.rel} is missing`);
  }
  return { files, problems, toApply: files.filter((x) => x.state === "base"), toRollBack: files.filter((x) => x.state === "applied"), applied: files.every((x) => x.state === "applied"), base: files.every((x) => x.state === "base") };
}
const mtWords = (ms) => new Date(ms).toLocaleString("en-US", { timeZone: "America/Denver", hour12: false, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
/**
 * THE FENCES -> [] or the refusals. o: { now, procList (a list or a function; default: the live process list), logText (default: the
 * wave's own log), holidays (a table or a loader; default: the house's), self (this process id), repo }
 */
function fences({ now = Date.now(), procList, logText, holidays, self = process.pid, repo = REPO } = {}) {
  const L = TRIAL_LIB(), why = [], mt = L.mtNow(now);
  if (L.tradingWeekday(now, holidays) && mt.mins >= WINDOW.from && mt.mins < WINDOW.to) why.push(`${mt.hms} MT ${mt.dow} ${mt.date} is inside 16:05-18:30 MT on a trading weekday (the seat wave starts 16:15 MT) — run it before 16:05 or after 18:30 MT`);
  try {
    const list = typeof procList === "function" ? procList() : procList || L.procs();
    const hit = list.filter((p) => p.pid !== self && ((p.name === "node.exe" && L.BUSY.node.test(p.cmd)) || (p.name === "cmd.exe" && L.BUSY.cmd.test(p.cmd))));
    if (hit.length) why.push(`the seat wave is running: ${hit.map((p) => `pid ${p.pid} ${String(p.cmd).replace(/\s+/g, " ").slice(0, 120)}`).join(" | ")}`);
  } catch (e) { why.push(`the process list cannot be read (${String((e && e.message) || e).slice(0, 120)}) — refusing to replace a file that may be running`); }
  try {
    const open = L.waveOpenInLog(logText !== undefined ? logText : L.readWaveLog(repo), now);
    if (open) why.push(`the seat wave's log shows a wave that started and has not ended (${open.line}) — refused for ${L.WAVE_LOG_MINUTES} minutes from its start`);
  } catch (e) { if (!(e && e.code === "ENOENT")) why.push(`the seat wave's log cannot be read (${String((e && (e.code || e.message)) || e).slice(0, 80)}) — refusing`); }
  return why;
}
/** write bytes so that the file is either the old one or the new one, never half (temp file + rename), then read back by sha256 */
function writeExact(file, buf) {
  const tmp = `${file}.tmp-sdkfix-${process.pid}`, fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
  if (sha(fs.readFileSync(file)) !== sha(buf)) throw new Error(`${file} does not read back as written`);
}

/**
 * The write modes on injected dependencies (the selftest gives a scratch repo and fake children):
 *   { repo, pkg, now, procList, logText, holidays, log, run(args, timeoutMs) -> { status, stdout, stderr, error }, write(file, buf) }
 * run hands back the child's two streams APART: a child's result is its exit code and its stdout; its stderr is shown, never judged.
 */
function make(deps = {}) {
  const d = { repo: REPO, pkg: PKG, now: () => Date.now(), log: (s) => console.log(s), write: writeExact, procList: undefined, logText: undefined, holidays: undefined, run: null, ...deps };
  if (!d.run) d.run = (args, timeoutMs = 1800000) => { const r = cp.spawnSync(process.execPath, args, { cwd: d.repo, encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 256 << 20, env: TRIAL_LIB().cleanEnv() }); return { status: r.status, stdout: String(r.stdout || ""), stderr: String(r.stderr || ""), error: r.error ? String(r.error.message || r.error) : null }; };
  const fz = () => fences({ now: d.now(), procList: d.procList, logText: d.logText, holidays: d.holidays, repo: d.repo });
  /** put files back to the given bytes */
  const putBack = (before) => { const bad = []; for (const [rel, buf] of Object.entries(before)) { try { writeExact(path.join(d.repo, ...rel.split("/")), buf); } catch (e) { bad.push(`${rel}: ${e.message}`); } } return bad; };
  /** the package's selftest as the gate of the apply: it must exit 0 and the last line of its STDOUT must say ALL ... CHECKS PASSED (selftestVerdict) */
  const selftestGate = { what: "this package's selftest (selftest.cjs)", run: () => selftestVerdict(d.run([path.join(PKG_REL, "selftest.cjs")])) };
  /** verify-live after the apply: its exit code as it is (0 pass · 3 unknowns · 1 fail · anything else: it did not end as it should); both its streams are printed */
  const verify = () => { const r = d.run([path.join(PKG_REL, "verify-live.cjs")]) || {}; return { status: r.status, stdout: String(r.stdout == null ? "" : r.stdout), stderr: String(r.stderr == null ? "" : r.stderr) }; };
  /**
   * to "staged" (deploy) or "base" (rollback). gate: { what, run } before the write (deploy: the selftest) · after: run verify-live and
   * put the base bytes back on a FAIL (deploy only).
   */
  function writeUnit({ to, gate = null, after = false }) {
    const P = plan({ repo: d.repo, pkg: d.pkg, forRollback: to === "base" }), lines = [], say = (s) => { lines.push(s); d.log(s); };
    const refuse = (why) => ({ result: "refused", why, lines });
    if (P.problems.length) return refuse(P.problems);
    const wantBase = to === "base", todo = wantBase ? P.toRollBack : P.toApply;
    if (!todo.length) { say(`  nothing to write: every file already reads ${wantBase ? "base" : "applied"}`); return { result: "noop", lines, written: [] }; }
    let f = fz(); if (f.length) return refuse(f);
    if (gate) { say(`  gate: ${gate.what} …`); const g = gate.run(); if (!g || !g.ok) return refuse([`${gate.what} did not pass: ${g ? g.why : "no answer"}`]); say(`  gate: ${g.line}`); if (g.note) say(`  gate: ${g.note}`); f = fz(); if (f.length) return refuse(f); }
    const before = {}, written = [];
    for (const x of todo) {
      const spec = FILES.find((y) => y.rel === x.rel), file = path.join(d.repo, ...x.rel.split("/")), now = fs.readFileSync(file);
      if (sha(now) !== x.live) { const bad = putBack(before); return { result: "failed", why: [`${x.rel} changed while this ran — nothing more written`], lines, restored: !bad.length, notRestored: bad, written }; }
      before[x.rel] = now;
      const buf = fs.readFileSync(path.join(d.pkg, ...(wantBase ? spec.base : spec.staged).split("/")));
      try { d.write(file, buf); if (sha(fs.readFileSync(file)) !== sha(buf)) throw new Error("it does not read back as written"); }
      catch (e) { const bad = putBack(before); return { result: "failed", why: [`writing ${x.rel}: ${e.message}`], lines, restored: !bad.length, notRestored: bad, written }; }
      if (isCode(x.rel)) { const c = cp.spawnSync(process.execPath, ["--check", file], { encoding: "utf8", windowsHide: true }); if (c.status !== 0) { const bad = putBack(before); return { result: "failed", why: [`${x.rel} does not parse after the write: ${String(c.stderr).trim().split("\n")[0]}`], lines, restored: !bad.length, notRestored: bad, written }; } }
      written.push(x.rel);
      say(`  wrote ${x.rel}  sha256 ${sha(buf).slice(0, 12)} (${wantBase ? "the base bytes" : "the staged bytes"}), read back, node --check ok`);
    }
    if (!after) return { result: "done", lines, written };
    say("  verify-live …");
    const v = verify();
    for (const l of textLines(v.stdout)) say("    | " + l);
    for (const l of textLines(v.stderr)) say("    | stderr: " + l);
    if (v.status === 0 || v.status === 3) return { result: "done", lines, written, verify: v.status === 0 ? "pass" : "unknowns" };
    const bad = putBack(before);
    return { result: "undone", why: [`verify-live.cjs ended ${v.status === 1 ? "with a FAIL" : `abnormally (exit ${v.status})`}`], lines, restored: !bad.length, notRestored: bad, written };
  }
  return { d, fences: fz, writeUnit, selftestGate, verify };
}

function printPlan(P, fz) {
  console.log(`PLAN — seat-SDK fix, option B (the runner's permission gate; the key stays scrubbed) — ${mtWords(Date.now())} MT — read-only, nothing is written`);
  for (const x of P.files) {
    console.log(`\n  ${x.rel}`);
    console.log(`      live now   ${x.live || "(missing)"}`);
    console.log(`      base       ${x.baseSha}${x.base === x.baseSha ? "" : "   PACKAGE COPY DIFFERS: " + (x.base || "missing")}   (what this package was built against; base/ holds it)`);
    console.log(`      staged     ${x.stagedSha}${x.staged === x.stagedSha ? "" : "   PACKAGE COPY DIFFERS: " + (x.staged || "missing")}`);
    console.log(`      state      ${x.state === "base" ? "base — the write mode would write the staged bytes" : x.state === "applied" ? "applied — the live file holds the staged bytes" : x.state === "DRIFT" ? "DRIFT — neither base nor staged: the write mode REFUSES" : x.state}${x.problem ? "   PROBLEM: " + x.problem : ""}`);
  }
  console.log(`\n  unit: ${P.problems.length ? "REFUSED by the write mode:\n    - " + P.problems.join("\n    - ") : P.toApply.length ? `the write mode would write ${P.toApply.map((x) => x.rel).join(", ")}` : "every file holds the staged bytes — nothing to apply"}`);
  console.log(`  fences now: ${fz.length ? "the write mode would be REFUSED:\n    - " + fz.join("\n    - ") : "clear"}`);
  console.log(`  ${SWITCH_REL} is never written by this package; no seat changes launcher by the apply.`);
  console.log("  nothing was written.");
}

module.exports = { PKG, REPO, PKG_REL, FILES, SWITCH_REL, WINDOW, sha, fileState, plan, fences, writeExact, make, isCode, mtWords, lastLine, textLines, RESULT_LINE, WHY_LINE, stderrShown, selftestVerdict };

if (require.main === module) {
  const args = process.argv.slice(2), MODE = args.length === 1 && ["--plan", "--apply"].includes(args[0]) ? args[0] : null;
  if (!MODE) { console.log("usage: node docs/seat-sdk-fix/2026-10-14/deploy.cjs --plan | --apply\n  --plan   read-only: every file's sha256 live / base / staged, its state, the fences now\n  --apply  the write mode (refused while the seat wave runs and 16:05-18:30 MT on a trading weekday)\nNothing was done."); process.exit(2); }
  const P = plan();
  if (MODE === "--plan") { let fz; try { fz = fences(); } catch (e) { fz = [`the fences could not be read (${e.message})`]; } printPlan(P, fz); process.exit(0); }
  console.log(`APPLY — seat-SDK fix, option B — ${mtWords(Date.now())} MT`);
  const M = make(), r = M.writeUnit({ to: "staged", gate: M.selftestGate, after: true });
  if (r.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${r.why.join("\n  - ")}`); process.exit(2); }
  if (r.result === "noop") { console.log("nothing to apply: the live files hold the staged bytes."); process.exit(0); }
  if (r.result === "failed" || r.result === "undone") {
    console.error(`${r.result === "undone" ? "APPLIED THEN UNDONE" : "APPLY FAILED"}: ${r.why.join("; ")}`);
    console.error(r.restored ? "  every file this run wrote is back to the bytes it had before (base)" : `  NOT RESTORED: ${(r.notRestored || []).join("; ")} — put the base bytes back with: node ${PKG_REL}/rollback.cjs --apply`);
    process.exit(1);
  }
  console.log(`\nAPPLIED: ${r.written.join(", ")} hold the staged bytes; verify-live ${r.verify === "pass" ? "passed" : "has UNKNOWN lines: read them, then run it again"}.`);
  console.log("  No seat changes launcher by this: the switch backend/data/seat-provider.json is what it was. NEXT (NOTES.md, 'Option B — the commands'):");
  console.log(`    node ${PKG_REL}/verify-live.cjs`);
  console.log("    then ONE real news-trader night, set before the 16:15 MT wave:   node automation/seat-sdk/set-provider.cjs sdk --seats news-trader --note \"option B first night\"");
  console.log(`    node ${PKG_REL}/record.cjs --dry, then without --dry (outside 13:50-15:50 MT on a trading weekday)`);
  console.log(`    back: node automation/seat-sdk/set-provider.cjs cli (every seat on the command line), or the files themselves: node ${PKG_REL}/rollback.cjs --apply`);
  process.exit(0);
}
