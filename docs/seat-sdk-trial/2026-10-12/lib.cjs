"use strict";
/**
 * SEAT-SDK TRIAL, 2026-10-12 (work order 4.31; operator: "build it for a trial period") — shared library of deploy / rollback / verify-live /
 * selftest. A module: nothing happens on load. Clocks come from node's Intl (America/Denver), never the shell.
 *
 *   THE EDIT   ONE anchored edit to ONE live file, automation/seat-wave.cjs. staged/anchor.txt holds two neighbouring lines of the wave's
 *              loop exactly as they are in the live file; staged/insert.txt holds the lines that go BETWEEN them. No existing line is
 *              changed or removed: the edited file minus the inserted lines is the file as it was.
 *                  old block = the two anchor lines        new block = anchor line 1 + the inserted lines + anchor line 2
 *              "base" = the old block is in the file exactly once and the new block nowhere; "applied" = the new block exactly once and the
 *              old block nowhere; anything else is DRIFT and nothing is written. Neither block holds the other, so the two blocks alone tell
 *              every state apart, and apply and revert are exact inverses on the bytes. No whole copy of the file is staged: a change
 *              elsewhere in the wave by another package is not drift (the plan says the file moved since staging).
 *   FENCES     the write modes refuse on a trading weekday 05:30-16:00 MT, and while the seat wave is running: a node process running
 *              automation/seat-wave.cjs or the SDK runner, the wave's launcher (seat-wave.bat), or a wave start in automation/seat-wave.log
 *              with no end line in the last 90 minutes. A process list that cannot be read is a refusal.
 *   NEVER      this package never touches backend/data, a registry file, the chain file, a switch, a .bat or a scheduled task; it makes no
 *              network call and starts no seat.
 */
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto"), cp = require("child_process");
const PKG_NAME = "seat-sdk-trial-2026-10-12", PKG = __dirname, REPO = path.resolve(PKG, "..", "..", "..");
const PKG_REL = path.relative(REPO, PKG).replace(/\\/g, "/");
const TARGET = "automation/seat-wave.cjs", EDIT_ID = "seat-wave-reads-the-switch";
const STAGED_DIR = path.join(PKG, "staged"), STATE_FILE = path.join(PKG, "deploy-state.json"), BACKUP_DIR = path.join(PKG, "backups");
/** the live file on the day the edit was staged (the plan says when the file has moved since; the anchor decides, not this) */
const STAGED_BASE = { sha256: "435b8c8cb22ffc339c755e41e2add77dfd639f75bf2d1cb9b8166e530db5b818", bytes: 14824, on: "2026-10-12" };
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const atomic = () => require(path.join(REPO, "backend", "lib", "atomic-write.js"));

// ───────────────────────────────────────────────────────────── the edit ─────────────────────────────────────────────────────────────
/** the rules the staged edit must meet -> the edit { id, file, old, new, anchor: [line1, line2], insert } (throws with the reason) */
function makeEdit(anchorText, insertText) {
  for (const [n, t] of [["anchor.txt", anchorText], ["insert.txt", insertText]]) {
    if (typeof t !== "string" || !t.trim()) throw new Error(`staged/${n} is empty`);
    if (t.includes("\r")) throw new Error(`staged/${n} has CR line endings: the blocks are LF text`);
    if (!t.endsWith("\n")) throw new Error(`staged/${n} does not end with a newline: the blocks are whole lines`);
  }
  const lines = anchorText.slice(0, -1).split("\n");
  if (lines.length !== 2 || lines.some((l) => !l.trim())) throw new Error("staged/anchor.txt must be exactly two non-empty lines");
  const e = { id: EDIT_ID, file: TARGET, anchor: lines, insert: insertText, old: anchorText, new: lines[0] + "\n" + insertText + lines[1] + "\n" };
  if (count(e.new, e.old) > 0 || count(e.old, e.new) > 0) throw new Error("one block sits inside the other: base and applied could not be told apart");
  if (insertText.includes(lines[0] + "\n") || insertText.includes(lines[1] + "\n")) throw new Error("the inserted lines repeat an anchor line");
  return e;
}
const loadEdit = (dir = STAGED_DIR) => makeEdit(fs.readFileSync(path.join(dir, "anchor.txt"), "utf8"), fs.readFileSync(path.join(dir, "insert.txt"), "utf8"));

// ───────────────────────────────────────────────────────── the edit engine (pure) ─────────────────────────────────────────────────────────
/** occurrences of a whole-line block: it must start at a line start (the blocks end with a newline themselves) */
function count(text, block) { let n = 0; for (let i = text.indexOf(block); i >= 0; i = text.indexOf(block, i + 1)) if (i === 0 || text[i - 1] === "\n") n++; return n; }
function at(text, block) { for (let i = text.indexOf(block); i >= 0; i = text.indexOf(block, i + 1)) if (i === 0 || text[i - 1] === "\n") return i; return -1; }
function editState(text, e) {
  const nNew = count(text, e.new), nOld = count(text, e.old);
  if (nNew === 1 && nOld === 0) return "applied";
  if (nNew === 0 && nOld === 1) return "base";
  return "drift";
}
/** why the edit reads drift, in words */
function driftWords(text, e) {
  const nNew = count(text, e.new), nOld = count(text, e.old);
  if (nNew > 1) return `its new block is in the file ${nNew} times`;
  if (nNew === 1) return `its new block is there and so is its old block (${nOld} time${nOld === 1 ? "" : "s"})`;
  if (nOld > 1) return `its anchor is in the file ${nOld} times`;
  if (count(text, e.anchor[0] + "\n") === 1 && count(text, e.anchor[1] + "\n") >= 1) return "both anchor lines are in the file but what is between them is neither nothing nor the staged lines: the inserted lines were changed, or something else was put there";
  return "an anchor line is no longer in the file as staged: a line of it was changed";
}
function applyText(text, e) {
  const st = editState(text, e);
  if (st === "applied") return text;
  if (st !== "base") throw new Error(`DRIFT (${driftWords(text, e)})`);
  const i = at(text, e.old), t = text.slice(0, i) + e.new + text.slice(i + e.old.length);
  if (editState(t, e) !== "applied") throw new Error("after applying, the edit does not read as applied");
  return t;
}
function revertText(text, e) {
  const st = editState(text, e);
  if (st === "base") return text;
  if (st !== "applied") throw new Error(`DRIFT (${driftWords(text, e)})`);
  const i = at(text, e.new), t = text.slice(0, i) + e.old + text.slice(i + e.new.length);
  if (editState(t, e) !== "base") throw new Error("after reverting, the edit does not read as base");
  return t;
}
/** a live file as text; refuses a file that is not LF UTF-8 without a BOM (the blocks are LF text and the bytes must round-trip) */
function readText(file) {
  const buf = fs.readFileSync(file), text = buf.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buf)) throw new Error(`${file}: not valid UTF-8 — refusing`);
  if (text.charCodeAt(0) === 0xfeff) throw new Error(`${file}: starts with a BOM — refusing`);
  if (text.includes("\r")) throw new Error(`${file}: has CR line endings — the staged blocks are LF; refusing`);
  return { buf, text, sha: sha256(buf) };
}
const targetOf = (root = REPO) => path.join(root, ...TARGET.split("/"));
/** the state of the edit on the tree at `root` -> { rel, state: "base" | "applied" | "drift", sha, bytes, why, problem, movedSinceStaging } */
function plan(e = loadEdit(), root = REPO) {
  const file = targetOf(root);
  if (!fs.existsSync(file)) return { rel: TARGET, state: "drift", problem: "file missing" };
  try {
    const { text, sha, buf } = readText(file), state = editState(text, e);
    const baseSha = state === "applied" ? sha256(Buffer.from(revertText(text, e), "utf8")) : state === "base" ? sha : null;
    return { rel: TARGET, state, sha, bytes: buf.length, ...(state === "drift" ? { why: driftWords(text, e) } : {}), baseSha, movedSinceStaging: baseSha != null && baseSha !== STAGED_BASE.sha256 };
  } catch (err) { return { rel: TARGET, state: "drift", problem: err.message }; }
}
const writeExact = (dest, buf) => { const tmp = `${dest}.sst-tmp-${process.pid}`; const fd = fs.openSync(tmp, "w"); try { fs.writeFileSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } try { fs.renameSync(tmp, dest); } catch (err) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw err; } };
function nodeCheckText(text, name = "seat-wave.cjs") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sst-check-")), f = path.join(dir, path.basename(name));
  try { fs.writeFileSync(f, text); const r = cp.spawnSync(process.execPath, ["--check", f], { encoding: "utf8", windowsHide: true }); return r.status === 0 ? null : String(r.stderr || "node --check failed").trim().split("\n").slice(0, 4).join(" | "); }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } }
}

// ───────────────────────────────────────────────────────────── fences ─────────────────────────────────────────────────────────────
function parts(tz, ms = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hour12: false }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, dow: p.weekday, mins: (+p.hour % 24) * 60 + +p.minute, hms: `${String(+p.hour % 24).padStart(2, "0")}:${p.minute}:${p.second}` };
}
const mtNow = (ms) => parts("America/Denver", ms);
/** Mon-Fri and not a full market holiday (backend/lib/run-window.js). A holiday table that cannot be read counts as a trading day (the
 *  stricter reading). `holidays` is injectable: a table { "YYYY-MM-DD": name } or a loader (date) => truthy on a holiday, which may throw. */
function tradingWeekday(ms = Date.now(), holidays) {
  const mt = mtNow(ms); if (mt.dow === "Sat" || mt.dow === "Sun") return false;
  if (holidays && typeof holidays !== "function") return !holidays[mt.date];
  const loader = holidays || ((date) => require(path.join(REPO, "backend", "lib", "run-window.js")).marketHoliday(date));
  try { return !loader(mt.date); } catch { return true; }
}
/** node.exe / cmd.exe processes with their command lines (a read-only CIM query). Throws when the list cannot be read or does not hold this process. */
function procs() {
  const ps = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='cmd.exe'\" | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 2";
  const out = cp.execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 60000, windowsHide: true, maxBuffer: 32 << 20 });
  const j = JSON.parse(String(out || "").trim() || "[]");
  const rows = (Array.isArray(j) ? j : [j]).filter(Boolean).map((p) => ({ pid: Number(p.ProcessId), ppid: Number(p.ParentProcessId), name: String(p.Name || "").toLowerCase(), cmd: String(p.CommandLine || "") }));
  if (!rows.some((p) => p.pid === process.pid)) throw new Error("the process list does not contain this process — not trusted");
  return rows;
}
/** "the seat wave is running": node running the wave or the SDK runner; cmd.exe running the wave's launcher (it waits for the chain, then runs the wave) */
const BUSY = { node: /(automation[\\/]seat-wave\.cjs|automation[\\/]seat-sdk[\\/]run-seat\.cjs)/i, cmd: /seat-wave\.bat/i };
const WIN = { applyFrom: 5 * 60 + 30, applyTo: 16 * 60 }, WAVE_LOG_MINUTES = 90;
/** from the wave's own log: a start line with no end line after it, younger than 90 minutes (the wave caps itself at 85) -> the start line, or null */
function waveOpenInLog(logText, ms = Date.now()) {
  let start = null;
  for (const l of String(logText || "").split(/\r?\n/)) {
    const m = /^\[(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\] (SEAT WAVE |WAVE DONE)/.exec(l); if (!m) continue;
    start = m[2] === "SEAT WAVE " ? { at: Date.parse(m[1]), line: l.slice(0, 140) } : null;
  }
  return start && Number.isFinite(start.at) && ms - start.at >= 0 && ms - start.at < WAVE_LOG_MINUTES * 60000 ? start : null;
}
const readWaveLog = (root = REPO) => { const f = path.join(root, "automation", "seat-wave.log"); const st = fs.statSync(f), n = Math.min(st.size, 256 * 1024), fd = fs.openSync(f, "r"); try { const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, st.size - n); return b.toString("utf8"); } finally { fs.closeSync(fd); } };
/** [] when a write may go ahead, else the reasons. `ms`, `procList`, `holidays` and `logText` are injectable (the selftest); by default the real ones are read. */
function fences({ ms = Date.now(), procList, self = process.pid, holidays, logText, root = REPO } = {}) {
  const why = [], mt = mtNow(ms), td = tradingWeekday(ms, holidays);
  if (td && mt.mins >= WIN.applyFrom && mt.mins < WIN.applyTo) why.push(`${mt.hms} MT ${mt.dow} ${mt.date} is inside 05:30-16:00 MT on a trading weekday — apply after 16:00 MT or before 05:30 MT`);
  try {
    const list = typeof procList === "function" ? procList() : procList || procs();
    const hit = list.filter((p) => p.pid !== self && ((p.name === "node.exe" && BUSY.node.test(p.cmd)) || (p.name === "cmd.exe" && BUSY.cmd.test(p.cmd))));
    if (hit.length) why.push(`the seat wave is running: ${hit.map((p) => `pid ${p.pid} ${p.cmd.replace(/\s+/g, " ").slice(0, 120)}`).join(" | ")}`);
  } catch (e) { why.push(`the process list cannot be read (${String(e.message).slice(0, 120)}) — refusing to replace a file that may be running`); }
  try {
    const open = waveOpenInLog(logText !== undefined ? logText : readWaveLog(root), ms);
    if (open) why.push(`the seat wave's log shows a wave that started and has not ended (${open.line}) — refused for ${WAVE_LOG_MINUTES} minutes from its start`);
  } catch (e) { if (!(e && e.code === "ENOENT")) why.push(`the seat wave's log cannot be read (${String((e && (e.code || e.message)) || e).slice(0, 80)}) — refusing`); }
  return why;
}

// ───────────────────────────────────────────────────────── apply / rollback ─────────────────────────────────────────────────────────
function readState(file = STATE_FILE) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { package: PKG_NAME, log: [] }; } }
function writeState(st, file = STATE_FILE) { st.log = (st.log || []).slice(-200); atomic().writeJsonAtomic(file, st); }
function logRow(row, { stateFile = STATE_FILE } = {}) { try { const st = readState(stateFile); (st.log = st.log || []).push({ at: new Date().toISOString(), mt: mtNow().hms, ...row }); writeState(st, stateFile); } catch (e) { console.error(`deploy-state.json could not be written: ${e.message}`); } }
const driftWhy = (p, tail) => `${p.rel}: ${p.problem || "DRIFT — " + p.why + "; " + tail}`;
/**
 * Apply the edit when it is still base. The new text is built and syntax-checked in memory first; the fences and the live sha are checked
 * again right before the write; a byte-exact backup is taken; the write is a temp file and a rename, verified by sha. `root` and the fence
 * inputs are injectable so the selftest runs it on a temp copy; `write` is for the selftest only (deploy.cjs never passes it).
 * -> { result: "applied" | "noop" | "refused" | "failed", ... } — never throws for a refusal.
 */
function applyAll({ e = loadEdit(), root = REPO, ms, procList, holidays, logText, backups = root === REPO, stateful = root === REPO, backupDir = BACKUP_DIR, stateFile = STATE_FILE, check = true, write = writeExact } = {}) {
  const p = plan(e, root);
  if (p.state === "drift") return { result: "refused", why: [driftWhy(p, "read the change in the live file before staging again")] };
  if (p.state === "applied") return { result: "noop", why: ["the edit is already applied"] };
  const fz = () => fences({ ms, procList, holidays, logText, root });
  let f = fz(); if (f.length) return { result: "refused", why: f };
  const file = targetOf(root), { buf, text, sha } = readText(file), next = applyText(text, e), after = Buffer.from(next, "utf8"), afterSha = sha256(after);
  if (check) { const err = nodeCheckText(next); if (err) return { result: "refused", why: [`the edited text fails node --check (${err})`] }; }
  f = fz(); if (f.length) return { result: "refused", why: f };
  if (sha256(fs.readFileSync(file)) !== sha) return { result: "refused", why: [`${TARGET} changed while this was running — nothing written`] };
  let backup = null;
  if (backups) {
    fs.mkdirSync(backupDir, { recursive: true });
    const b = path.join(backupDir, `${TARGET.replace(/[\\/]/g, "__")}.pre-${PKG_NAME}-${sha.slice(0, 12)}`);
    if (!fs.existsSync(b)) fs.copyFileSync(file, b);
    if (sha256(fs.readFileSync(b)) !== sha) return { result: "refused", why: [`the backup of ${TARGET} does not verify — nothing written`] };
    backup = (backupDir === BACKUP_DIR ? path.relative(REPO, b) : b).replace(/\\/g, "/");
  }
  try { write(file, after); if (sha256(fs.readFileSync(file)) !== afterSha) throw new Error(`${TARGET} does not verify after the write`); }
  catch (err) { let restored = true; try { writeExact(file, buf); if (sha256(fs.readFileSync(file)) !== sha) restored = false; } catch { restored = false; } return { result: "failed", why: [err.message], restored }; }
  const rec = { at: new Date().toISOString(), file: TARGET, before: sha, after: afterSha, backup };
  if (stateful) { const st = readState(stateFile); st.applied = rec; delete st.rolledBack; writeState(st, stateFile); }
  return { result: "applied", ...rec };
}
/** Put the edit back. Byte-exact: with nothing else changed since the apply the file returns to the sha recorded before it. */
function rollbackAll({ e = loadEdit(), root = REPO, ms, procList, holidays, logText, stateful = root === REPO, stateFile = STATE_FILE, recordedBefore, write = writeExact } = {}) {
  const p = plan(e, root);
  if (p.state === "drift") return { result: "refused", why: [driftWhy(p, "put the file back by hand from the backup")] };
  if (p.state === "base") return { result: "noop", why: ["the edit is not applied"] };
  const f = fences({ ms, procList, holidays, logText, root }); if (f.length) return { result: "refused", why: f };
  const file = targetOf(root), { buf, text, sha } = readText(file), prev = Buffer.from(revertText(text, e), "utf8"), prevSha = sha256(prev);
  try { write(file, prev); if (sha256(fs.readFileSync(file)) !== prevSha) throw new Error(`${TARGET} does not verify after the write`); }
  catch (err) { let restored = true; try { writeExact(file, buf); if (sha256(fs.readFileSync(file)) !== sha) restored = false; } catch { restored = false; } return { result: "failed", why: [err.message], restored }; }
  const rec = recordedBefore !== undefined ? recordedBefore : stateful ? ((readState(stateFile).applied || {}).before || null) : null;
  const out = { result: "rolled-back", file: TARGET, now: prevSha, recordedBefore: rec, byteExact: rec ? rec === prevSha : null };
  if (stateful) { const st = readState(stateFile); st.rolledBack = { at: new Date().toISOString(), now: prevSha, recordedBefore: rec, byteExact: out.byteExact }; writeState(st, stateFile); }
  return out;
}
/** what rollback.cjs says about a finished rollback (pure). Code 0 only when the file is back to the bytes recorded before the apply. */
function rollbackReport(r) {
  if (r.byteExact === true) return { code: 0, last: `ROLLED BACK: ${TARGET} is byte for byte what it was before the apply (sha ${r.now.slice(0, 12)}).` };
  if (r.byteExact === false) return { code: 1, last: `ROLLED BACK, BUT NOT BYTE-EXACT: ${TARGET} is sha ${r.now.slice(0, 12)}, and before the apply it was ${String(r.recordedBefore).slice(0, 12)}. The inserted lines are out; what differs was changed elsewhere in the file since the apply, and was kept. Compare it with its copy in backups/ before relying on it.` };
  return { code: 3, last: `ROLLED BACK, NOT CONFIRMED: there is no record of the apply to compare ${TARGET} with (sha now ${r.now.slice(0, 12)}; the file as staged on ${STAGED_BASE.on} was ${STAGED_BASE.sha256.slice(0, 12)}).` };
}
/**
 * The write mode of deploy.cjs, start to finish, with its two child runs injectable. -> { code, result, why }: code 0 applied / nothing
 * to do, 1 failed or undone, 2 refused. Order: drift -> fences -> the selftest -> applyAll (its own second fence check, backup, atomic
 * write) -> node --check on the written file -> verify-live (exit 1 or anything unexpected: the edit is put back; exit 3 = UNKNOWN lines:
 * applied, to be read).
 */
function deployApply({ e = loadEdit(), root = REPO, ms, procList, holidays, logText, runSelftest, runVerify, backups, stateful, backupDir, stateFile, out = console.log } = {}) {
  const p = plan(e, root);
  if (p.state === "drift") return { code: 2, result: "refused", why: [driftWhy(p, "read the change in the live file before staging again")] };
  if (p.state === "applied") return { code: 0, result: "noop", why: ["the edit is already applied"] };
  const f = fences({ ms, procList, holidays, logText, root }); if (f.length) return { code: 2, result: "refused", why: f };
  const st = runSelftest(); if (!st || !st.ok) return { code: 2, result: "refused", why: ["the selftest did not pass:", ...((st && st.lines) || [])] };
  out(`  ${st.last}`);
  const opt = { e, root, ms, procList, holidays, logText, ...(backups === undefined ? {} : { backups }), ...(stateful === undefined ? {} : { stateful }), ...(backupDir ? { backupDir } : {}), ...(stateFile ? { stateFile } : {}) };
  const r = applyAll(opt);
  if (r.result === "refused") return { code: 2, result: "refused", why: r.why };
  if (r.result === "noop") return { code: 0, result: "noop", why: r.why };
  if (r.result !== "applied") return { code: 1, result: "failed", why: r.why, restored: r.restored };
  out(`  written ${TARGET}   ${r.before.slice(0, 12)} -> ${r.after.slice(0, 12)}${r.backup ? "   backup " + r.backup : ""}`);
  const undo = (why) => { const b = rollbackAll({ e, root, ms, procList, holidays, logText, recordedBefore: r.before, ...(stateful === undefined ? {} : { stateful }), ...(stateFile ? { stateFile } : {}) }); return { code: 1, result: "undone", why: [why], rollback: b.result, rollbackWhy: b.why || [], byteExact: b.byteExact === true, before: r.before, after: r.after }; };
  const c = cp.spawnSync(process.execPath, ["--check", targetOf(root)], { encoding: "utf8", windowsHide: true });
  if (c.status !== 0) return undo(`node --check ${TARGET}: ${String(c.stderr).trim().split("\n")[0]}`);
  const v = runVerify(); if (v && v.text) out(v.text);
  if (!v || (v.status !== 0 && v.status !== 3)) return undo(`verify-live.cjs ended ${v && v.status === 1 ? "with a FAIL" : "abnormally (exit " + (v && v.status) + ")"}`);
  return { code: 0, result: "applied", before: r.before, after: r.after, backup: r.backup, verify: v.status === 0 ? "pass" : "unknowns" };
}
/** deploy.cjs's READING of its two child runs, kept here as pure functions so the selftest types their answers */
function selftestVerdict(status, stdout, stderr) {
  const out = String(stdout || ""), last = out.trim().split("\n").pop() || "";
  return { ok: status === 0 && /^ALL \d+ CHECKS PASSED/.test(last), last, lines: [...out.split("\n").filter((l) => /^\s+FAIL/.test(l)).slice(0, 12), String(stderr || "").slice(0, 300)].filter(Boolean) };
}
function verifyVerdict(status, stdout) { return { status, text: String(stdout || "").trim().split("\n").map((l) => "  " + l).join("\n") }; }
function deployChildren({ run, out = console.log }) {
  return {
    runSelftest: () => { out("\nselftest ..."); const r = run("selftest.cjs") || {}; return selftestVerdict(r.status, r.stdout, r.stderr); },
    runVerify: () => { out("verify-live ..."); const r = run("verify-live.cjs") || {}; return verifyVerdict(r.status, r.stdout); },
  };
}

// ─────────────────────────────────────────── the launcher's executable against the command line's (verify-live) ───────────────────────────────────────────
/** sha256 of a file, read in pieces (the executables are about 290 MB) */
function fileSha256(file) { const x = crypto.createHash("sha256"), fd = fs.openSync(file, "r"), b = Buffer.alloc(8 << 20); try { for (let n; (n = fs.readSync(fd, b, 0, b.length, null)) > 0;) x.update(b.subarray(0, n)); } finally { fs.closeSync(fd); } return x.digest("hex"); }
/** where the pinned SDK keeps its own launcher executable (its platform package) */
const sdkExeOf = (sdkDir = path.join(REPO, "automation", "seat-sdk")) => path.join(sdkDir, "node_modules", "@anthropic-ai", `claude-agent-sdk-${process.platform}-${process.arch}`, process.platform === "win32" ? "claude.exe" : "claude");
/**
 * THE SDK'S LAUNCHER EXECUTABLE AGAINST THE ONE THE COMMAND-LINE PATH RUNS. The command line does not run a fixed file: each night the
 * seat wave's own resolver (claudeExe() in automation/seat-wave.cjs) picks one — the desktop app's versioned claude-code folders
 * FIRST, the newest version in them, and only then four fixed places, ~/.local/bin among them. On the record the first real night
 * (2026-09-10) ran the desktop app's folder and every night since ran ~/.local/bin. So the comparison is made with what that resolver
 * picks NOW — through automation/claude-bin.cjs find(), the house's copy of the same search, which its own selftest holds to the
 * wave's claudeExe() — and the line names the file it compared. Never a fixed path.
 *   sdkExe: the SDK's executable · repo: the tree whose automation/claude-bin.cjs is asked · findOpts: its options ({ platform, env,
 *   homedir }; the selftest's temp folders) · hash: the file hash (the selftest counts its calls)
 * -> [verdict, detail]: INFO whenever the comparison could be made or there is nothing to compare with (this line informs; it gates
 *    nothing); UNKNOWN when the SDK's own executable is not installed. A resolver that cannot be loaded THROWS: the caller's check
 *    reads that as UNKNOWN, never as a pass.
 */
function launcherExeLine({ sdkExe = sdkExeOf(), repo = REPO, findOpts, hash = fileSha256 } = {}) {
  if (!fs.existsSync(sdkExe)) return ["UNKNOWN", "the SDK's platform package is not installed: run `npm ci` in automation/seat-sdk"];
  const CB = require(path.join(repo, "automation", "claude-bin.cjs"));
  let found;
  try { found = CB.find(findOpts); }
  catch (e) { if (e && e.refusal === true) return ["INFO", "the seat wave's own resolver finds no command-line executable on this machine: nothing to compare with"]; throw e; }
  // the picked file as the line names it: under the home folder as ~/..., anything else by its whole path
  const home = (findOpts && findOpts.homedir) || os.homedir(), rel = path.relative(home, found.path), under = !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  const shown = (under ? "~/" + rel : found.path).replace(/\\/g, "/");
  const picked = `${shown} — what the seat wave's resolver picks now (${found.how})`;
  if (fs.statSync(sdkExe).size !== fs.statSync(found.path).size) return ["INFO", `NOT the same build: it differs in size from ${picked}. The SDK path keeps its pinned build; the command line runs that other one`];
  const a = hash(sdkExe), b = hash(found.path);
  return ["INFO", a === b ? `byte for byte the same file as ${picked}; sha256 ${a.slice(0, 16)}…` : `NOT the same build: the same size as ${picked}, different bytes`];
}

// ───────────────────────────────────────────────────── temp trees and case counting (the selftest) ─────────────────────────────────────────────────────
function tempDir(tag = "t") { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sst-${tag}-`)); return { dir, rm: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } } }; }
const put = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
/** an environment without any credential name (children of the selftest and of deploy never inherit one from this process) */
const cleanEnv = (extra = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/KEY|SECRET|TOKEN|PASSWORD|ALPACA|SCHWAB|TASTY|TELEGRAM|SMTP|ANTHROPIC|CLAUDE|NODE_OPTIONS/i.test(k))), ...extra });
/** count the "ok" / "FAIL" case lines of a house selftest's output (one line per case) */
function parseCases(status, stdout, stderr) {
  const out = String(stdout || ""), okNames = [], failNames = [];
  for (const l of out.split(/\r?\n/)) { const m = /^\s*(ok|FAIL)\s+(.*)$/.exec(l); if (m) (m[1] === "ok" ? okNames : failNames).push(m[2]); }
  return { status, out, err: String(stderr || ""), ok: okNames.length, fail: failNames.length, okNames, failNames };
}

module.exports = { PKG_NAME, PKG, PKG_REL, REPO, TARGET, EDIT_ID, STAGED_DIR, STATE_FILE, BACKUP_DIR, STAGED_BASE, sha256, atomic, makeEdit, loadEdit, count, at, editState, driftWords, applyText, revertText, readText, targetOf, plan,
  writeExact, nodeCheckText, parts, mtNow, tradingWeekday, procs, BUSY, WIN, WAVE_LOG_MINUTES, waveOpenInLog, readWaveLog, fences, readState, writeState, logRow, applyAll, rollbackAll, rollbackReport, deployApply, selftestVerdict,
  verifyVerdict, deployChildren, fileSha256, sdkExeOf, launcherExeLine, tempDir, put, cleanEnv, parseCases };
