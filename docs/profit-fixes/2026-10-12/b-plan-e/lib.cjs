"use strict";
/**
 * PROFIT FIXES B (Plan E), 2026-10-12 — shared library for make-edits / make-fixture / deploy / rollback / selftest / verify-live / evidence.
 * A module: nothing happens on load. Clocks come from node's Intl (America/Denver, America/New_York), never the shell.
 *
 *   EDITS      the staged change is a list of ANCHORED whole-line replacements (edits.json, written by make-edits.cjs). Per edit, against a
 *              file's text: "base" = the old block is there exactly once and the new block nowhere; "applied" = the new block exactly once and
 *              the old block nowhere else; anything else is DRIFT and nothing is written. Apply and revert are exact inverses on the bytes.
 *   FENCES     the write modes refuse on a trading weekday 05:30-16:00 MT, inside 13:50-15:50 MT when a registry or chain file is in the unit,
 *              and while a file of the unit (or a script that loads one) is running. An unreadable process list is a refusal.
 *   HARNESS    the selftest / evidence run the REAL text of the live files (base and staged) offline: an API emulator for Coinbase candles and
 *              the Alpaca calendar serves a recorded series, a stub serves recorded bars, the clock is fixed. Nothing reaches the network.
 */
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto"), cp = require("child_process");
const PKG_NAME = "b-plan-e", PKG = __dirname, REPO = path.resolve(PKG, "..", "..", "..", "..");
const EDITS_FILE = path.join(PKG, "edits.json"), FIXTURE_FILE = path.join(PKG, "fixtures", "inputs.json"), STATE_FILE = path.join(PKG, "deploy-state.json"), BACKUP_DIR = path.join(PKG, "backups");
const PKG_REL = path.relative(REPO, PKG).replace(/\\/g, "/");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const atomic = () => require(path.join(REPO, "backend", "lib", "atomic-write.js"));
const DAY = 864e5, iso = (ms) => new Date(ms).toISOString().slice(0, 10);

// ───────────────────────────────────────────────────────────── the unit ─────────────────────────────────────────────────────────────
/** files this package may never edit, whatever edits.json says */
const FORBIDDEN = [/(^|\/)\.env/i, /LIVE-ARMED/i, /^backend\/marks-live-watcher\.js$/, /^backend\/data\//, /^backend\/(planE-tasty|tasty-[\w-]+)\.js$/, /^backend\/lib\/tasty-broker\.js$/, /(^|\/)node_modules\//, /^automation\/close-chain\.cjs$/];
const forbidden = (rel) => FORBIDDEN.some((re) => re.test(rel));
/** registry and chain files: no write 13:50-15:50 MT on a trading day (AGENTS.md section 2) */
const isRegistryOrChain = (rel) => /^automation\/close-chain\.cjs$|^backend\/data\/(test-registry|read-seals|change-registry)\.json$|^backend\/data\/agent-ledger\.jsonl$/.test(rel);
/** the rules every edit list must meet (loadEdits and make-edits.cjs both go through it) */
function validateEdits(E) {
  if (!E || !Array.isArray(E.edits) || !E.edits.length) throw new Error("edits.json holds no edits");
  for (const e of E.edits) {
    if (!e.id || !e.file || typeof e.old !== "string" || typeof e.new !== "string") throw new Error(`edit ${e.id || "?"}: needs id, file, old, new`);
    if (forbidden(e.file)) throw new Error(`edit ${e.id}: ${e.file} is a file this package may never edit`);
    if (!e.old.endsWith("\n") || !e.new.endsWith("\n") || e.old === e.new || !e.old.trim()) throw new Error(`edit ${e.id}: old and new must be different whole-line blocks`);
    if (e.old.includes("\r") || e.new.includes("\r")) throw new Error(`edit ${e.id}: blocks are LF text`);
    if (count(e.old, e.new) > 0) throw new Error(`edit ${e.id}: the new block sits inside the old one — states could not be told apart`);
  }
  if (new Set(E.edits.map((e) => e.id)).size !== E.edits.length) throw new Error("edits.json: an id is used twice");
  return E;
}
const loadEdits = (file = EDITS_FILE) => validateEdits(JSON.parse(fs.readFileSync(file, "utf8")));
const filesOf = (E) => [...new Set(E.edits.map((e) => e.file))];
const editsFor = (E, rel) => E.edits.filter((e) => e.file === rel);

// ───────────────────────────────────────────────────────── the edit engine (pure) ─────────────────────────────────────────────────────────
/** occurrences of a whole-line block: it must start at a line start (the blocks end with a newline themselves) */
function count(text, block) { let n = 0; for (let i = text.indexOf(block); i >= 0; i = text.indexOf(block, i + block.length)) if (i === 0 || text[i - 1] === "\n") n++; return n; }
function at(text, block) { for (let i = text.indexOf(block); i >= 0; i = text.indexOf(block, i + 1)) if (i === 0 || text[i - 1] === "\n") return i; return -1; }
function editState(text, e) {
  const nNew = count(text, e.new), nOld = count(text, e.old), oldInNew = count(e.new, e.old);
  if (nNew === 1 && nOld === oldInNew) return "applied";
  if (nNew === 0 && nOld === 1) return "base";
  return "drift";
}
function fileState(text, edits) {
  const states = edits.map((e) => ({ id: e.id, state: editState(text, e) }));
  const s = new Set(states.map((x) => x.state));
  return { states, state: s.has("drift") ? "drift" : s.size === 1 ? [...s][0] : "mixed" };
}
function applyText(text, edits) {
  let t = text;
  for (const e of edits) { const st = editState(t, e); if (st === "applied") continue; if (st !== "base") throw new Error(`edit ${e.id}: DRIFT (neither the base nor the applied text is there exactly once)`); const i = at(t, e.old); t = t.slice(0, i) + e.new + t.slice(i + e.old.length); }
  const bad = edits.filter((e) => editState(t, e) !== "applied"); if (bad.length) throw new Error(`after applying, edit(s) ${bad.map((e) => e.id).join(", ")} do not read as applied — the edits overlap`);
  return t;
}
function revertText(text, edits) {
  let t = text;
  for (const e of [...edits].reverse()) { const st = editState(t, e); if (st === "base") continue; if (st !== "applied") throw new Error(`edit ${e.id}: DRIFT (neither the base nor the applied text is there exactly once)`); const i = at(t, e.new); t = t.slice(0, i) + e.old + t.slice(i + e.new.length); }
  const bad = edits.filter((e) => editState(t, e) !== "base"); if (bad.length) throw new Error(`after reverting, edit(s) ${bad.map((e) => e.id).join(", ")} do not read as base`);
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
/** base and staged text of every file of the unit, whatever state the tree at `root` is in (base or applied; drift throws) */
function texts(E, root = REPO) {
  const out = {};
  for (const rel of filesOf(E)) {
    const { text, sha } = readText(path.join(root, rel)), ed = editsFor(E, rel), st = fileState(text, ed);
    if (st.state === "drift") throw new Error(`${rel}: DRIFT on ${st.states.filter((x) => x.state === "drift").map((x) => x.id).join(", ")}`);
    out[rel] = { live: text, liveSha: sha, state: st.state, base: revertText(text, ed), staged: applyText(text, ed) };
  }
  return out;
}
function plan(E, root = REPO) {
  return filesOf(E).map((rel) => {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) return { rel, missing: true, state: "drift", states: [], problem: "file missing" };
    try { const { text, sha } = readText(file), st = fileState(text, editsFor(E, rel)); return { rel, sha, bytes: Buffer.byteLength(text), ...st }; }
    catch (e) { return { rel, state: "drift", states: [], problem: e.message }; }
  });
}
const writeExact = (dest, buf) => { const tmp = `${dest}.pfb-tmp-${process.pid}`; const fd = fs.openSync(tmp, "w"); try { fs.writeFileSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } try { fs.renameSync(tmp, dest); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; } };
function nodeCheckText(text, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pfb-check-")), f = path.join(dir, path.basename(name));
  try { fs.writeFileSync(f, text); const r = cp.spawnSync(process.execPath, ["--check", f], { encoding: "utf8", windowsHide: true }); return r.status === 0 ? null : String(r.stderr || "node --check failed").trim().split("\n").slice(0, 4).join(" | "); }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}

// ───────────────────────────────────────────────────────────── fences ─────────────────────────────────────────────────────────────
function parts(tz, ms = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hour12: false }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, dow: p.weekday, mins: (+p.hour % 24) * 60 + +p.minute, hms: `${String(+p.hour % 24).padStart(2, "0")}:${p.minute}:${p.second}` };
}
const mtNow = (ms) => parts("America/Denver", ms), etNow = (ms) => parts("America/New_York", ms);
/** the house holiday table (backend/lib/run-window.js marketHoliday): the holiday's name, or null. It throws when the table cannot be loaded. */
const liveHoliday = (date) => require(path.join(REPO, "backend", "lib", "run-window.js")).marketHoliday(date);
/** Mon-Fri and not a full market holiday. A holiday table that cannot be read counts as a trading day (the stricter reading: the weekday window then refuses
 *  on every weekday, holidays included). The lookup is injectable so the selftest can make it fail. */
function tradingWeekday(ms = Date.now(), holiday = liveHoliday) {
  const mt = mtNow(ms); if (mt.dow === "Sat" || mt.dow === "Sun") return false;
  try { return !holiday(mt.date); } catch { return true; }
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
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** the arguments of a Windows command line: double quotes group, and are dropped */
const argsOf = (cmd) => (String(cmd).match(/"[^"]*"|\S+/g) || []).map((a) => a.replace(/"/g, ""));
/** a node process that runs a file of the unit, or a script that loads one: the close chain (it runs risk-manager.js and the scoreboard), the
 *  progress email (it loads the scoreboard), any Plan E analysis script (they load planE-model.js). cmd.exe: the chain's and the email's launchers.
 *    node  the repo path of such a file anywhere on the command line (backend\risk-manager.js, C:\...\backend\risk-manager.js)
 *    arg   a run started from INSIDE the tree names its file by a relative path: every tail of the repo path (risk-manager.js, profit-program/planE-model.js),
 *          as a WHOLE argument with at most ./ or ../ in front. An absolute path elsewhere (the harness's temp copies, "...\be\risk-manager.js") is not one. */
function busyPatterns(files) {
  const esc = (rel) => reEsc(rel).replace(/\//g, "[\\\\/]"), unit = files.map(esc), analysis = "(?:planE|skeptic-planE)[\\w-]*\\.js";
  const tails = [...new Set([...files, "automation/close-chain.cjs", "backend/progress-report.js"].flatMap((rel) => { const p = rel.split("/"); return p.slice(1).map((_, i) => p.slice(i + 1).join("/")); }))].map(esc);
  return { node: new RegExp(`(${[...unit, "automation[\\\\/]close-chain\\.cjs", "backend[\\\\/]progress-report\\.js", `backend[\\\\/]profit-program[\\\\/]${analysis}`].join("|")})`, "i"),
    arg: new RegExp(`^(?:\\.{1,2}[\\\\/])*(?:${[...tails, `(?:profit-program[\\\\/])?${analysis}`].join("|")})$`, "i"), cmd: /(close-chain|progress-email\.bat)/i };
}
const WIN = { applyFrom: 5 * 60 + 30, applyTo: 16 * 60, chainFrom: 13 * 60 + 50, chainTo: 15 * 60 + 50 };
/** [] when a write may go ahead, else the reasons. `procList` and the holiday lookup are injectable (the selftest); by default the real ones are read. */
function fences({ ms = Date.now(), files, procList, self = process.pid, holiday } = {}) {
  const why = [], mt = mtNow(ms), td = tradingWeekday(ms, holiday);
  if (td && mt.mins >= WIN.applyFrom && mt.mins < WIN.applyTo) why.push(`${mt.hms} MT ${mt.dow} ${mt.date} is inside 05:30-16:00 MT on a trading weekday — apply after 16:00 MT or before 05:30 MT`);
  const rc = (files || []).filter(isRegistryOrChain);
  if (td && rc.length && mt.mins >= WIN.chainFrom && mt.mins < WIN.chainTo) why.push(`${mt.hms} MT is inside 13:50-15:50 MT on a trading day and the unit holds registry or chain file(s): ${rc.join(", ")} — the close chain owns that window`);
  try {
    const list = typeof procList === "function" ? procList() : procList || procs(), B = busyPatterns(files || []);
    const hit = list.filter((p) => p.pid !== self && ((p.name === "node.exe" && (B.node.test(p.cmd) || argsOf(p.cmd).some((a) => B.arg.test(a)))) || (p.name === "cmd.exe" && B.cmd.test(p.cmd))));
    if (hit.length) why.push(`a file of the unit is running, or a script that loads one: ${hit.map((p) => `pid ${p.pid} ${p.cmd.replace(/\s+/g, " ").slice(0, 120)}`).join(" | ")}`);
  } catch (e) { why.push(`the process list cannot be read (${String(e.message).slice(0, 120)}) — refusing to replace files that may be running`); }
  return why;
}

// ───────────────────────────────────────────────────────── apply / rollback ─────────────────────────────────────────────────────────
function readState(file = STATE_FILE) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { package: PKG_NAME, log: [] }; } }
function writeState(st, file = STATE_FILE) { st.log = (st.log || []).slice(-200); atomic().writeJsonAtomic(file, st); }
function logRow(row, { stateful = true, stateFile = STATE_FILE } = {}) { if (!stateful) return; try { const st = readState(stateFile); (st.log = st.log || []).push({ at: new Date().toISOString(), mt: mtNow().hms, ...row }); writeState(st, stateFile); } catch (e) { console.error(`deploy-state.json could not be written: ${e.message}`); } }
/**
 * Apply every edit that is still base. All-or-nothing: every new text is built and syntax-checked in memory first; a failed write restores the
 * files already written from the bytes read at the start. `root` and the fence inputs are injectable so the selftest runs it on a temp copy.
 * Returns { result: "applied" | "noop" | "refused", ... } — it never throws for a refusal.
 */
function applyAll({ E = loadEdits(), root = REPO, ms, procList, holiday, backups = root === REPO, stateful = root === REPO, backupDir = BACKUP_DIR, stateFile = STATE_FILE, check = true, between } = {}) {
  const files = filesOf(E), P = plan(E, root), bad = P.filter((f) => f.state === "drift");
  if (bad.length) return { result: "refused", why: bad.map((f) => `${f.rel}: ${f.problem || "DRIFT — " + f.states.filter((x) => x.state === "drift").map((x) => x.id).join(", ") + " is neither base nor applied; re-stage (make-edits.cjs) after reading the change"}`) };
  if (P.every((f) => f.state === "applied")) return { result: "noop", why: ["every edit is already applied"] };
  let fz = fences({ ms, files, procList, holiday }); if (fz.length) return { result: "refused", why: fz };
  const work = [];
  for (const f of P) {
    const file = path.join(root, f.rel), { buf, text, sha } = readText(file), next = applyText(text, editsFor(E, f.rel));
    if (check && /\.c?js$/.test(f.rel)) { const err = nodeCheckText(next, f.rel); if (err) return { result: "refused", why: [`${f.rel}: the staged text fails node --check (${err})`] }; }
    work.push({ rel: f.rel, file, before: buf, beforeSha: sha, after: Buffer.from(next, "utf8"), afterSha: sha256(Buffer.from(next, "utf8")), was: f.state });
  }
  if (typeof between === "function") { const stop = between(work); if (stop) return { result: "refused", why: [].concat(stop) }; }
  fz = fences({ ms, files, procList, holiday }); if (fz.length) return { result: "refused", why: fz };
  for (const w of work) if (sha256(fs.readFileSync(w.file)) !== w.beforeSha) return { result: "refused", why: [`${w.rel} changed while this was running — nothing written`] };
  if (backups) { fs.mkdirSync(backupDir, { recursive: true }); for (const w of work) { const b = path.join(backupDir, `${w.rel.replace(/[\\/]/g, "__")}.pre-${PKG_NAME}-${w.beforeSha.slice(0, 12)}`); if (!fs.existsSync(b)) fs.copyFileSync(w.file, b); if (sha256(fs.readFileSync(b)) !== w.beforeSha) return { result: "refused", why: [`the backup of ${w.rel} does not verify — nothing written`] }; w.backup = (backupDir === BACKUP_DIR ? path.relative(REPO, b) : b).replace(/\\/g, "/"); } }
  const done = [];
  try {
    for (const w of work) { if (w.before.equals(w.after)) continue; writeExact(w.file, w.after); done.push(w); if (sha256(fs.readFileSync(w.file)) !== w.afterSha) throw new Error(`${w.rel} does not verify after the write`); }
  } catch (e) {
    const left = []; for (const w of done.reverse()) { try { writeExact(w.file, w.before); if (sha256(fs.readFileSync(w.file)) !== w.beforeSha) left.push(w.rel); } catch { left.push(w.rel); } }
    return { result: "failed", why: [e.message], restored: !left.length, notRestored: left };
  }
  const rec = { at: new Date().toISOString(), files: Object.fromEntries(work.map((w) => [w.rel, { before: w.beforeSha, after: w.afterSha, was: w.was, backup: w.backup || null }])) };
  if (stateful) { const st = readState(stateFile); st.applied = rec; delete st.rolledBack; writeState(st, stateFile); }
  return { result: "applied", files: rec.files };
}
/** Put every applied edit back. Byte-exact: with nothing else changed since the apply each file returns to the sha recorded before it. */
function rollbackAll({ E = loadEdits(), root = REPO, ms, procList, holiday, stateful = root === REPO, stateFile = STATE_FILE, recorded } = {}) {
  const files = filesOf(E), P = plan(E, root), bad = P.filter((f) => f.state === "drift");
  if (bad.length) return { result: "refused", why: bad.map((f) => `${f.rel}: ${f.problem || "DRIFT — " + f.states.filter((x) => x.state === "drift").map((x) => x.id).join(", ") + " changed after the apply; put it back by hand from the backup"}`) };
  if (P.every((f) => f.state === "base")) return { result: "noop", why: ["no edit is applied"] };
  const fz = fences({ ms, files, procList, holiday }); if (fz.length) return { result: "refused", why: fz };
  const rec = recorded || (stateful ? (readState(stateFile).applied || {}).files : null) || {}, work = [];
  for (const f of P) { const file = path.join(root, f.rel), { buf, text, sha } = readText(file), prev = revertText(text, editsFor(E, f.rel)); work.push({ rel: f.rel, file, before: buf, beforeSha: sha, after: Buffer.from(prev, "utf8"), afterSha: sha256(Buffer.from(prev, "utf8")) }); }
  const done = [];
  try { for (const w of work) { if (w.before.equals(w.after)) continue; writeExact(w.file, w.after); done.push(w); if (sha256(fs.readFileSync(w.file)) !== w.afterSha) throw new Error(`${w.rel} does not verify after the write`); } }
  catch (e) { const left = []; for (const w of done.reverse()) { try { writeExact(w.file, w.before); } catch { left.push(w.rel); } } return { result: "failed", why: [e.message], restored: !left.length, notRestored: left }; }
  const out = Object.fromEntries(work.map((w) => [w.rel, { now: w.afterSha, recordedBefore: (rec[w.rel] || {}).before || null, byteExact: rec[w.rel] ? rec[w.rel].before === w.afterSha : null }]));
  if (stateful) { const st = readState(stateFile); st.rolledBack = { at: new Date().toISOString(), files: out }; writeState(st, stateFile); }
  return { result: "rolled-back", files: out };
}
/**
 * The write mode of deploy.cjs, start to finish, with its two child runs injectable (deploy.cjs passes the real selftest and verify-live; the
 * selftest drives this on a temp copy with stand-ins). Returns { code, result, why } — code 0 applied / nothing to do, 1 failed or undone,
 * 2 refused. Order: drift -> a harness switch in the shell (`shellVars`: deploy.cjs passes gateVars(); refused) -> fences -> the selftest -> applyAll (its own second
 * fence check, backups, atomic writes) -> node --check on each written file -> verify (exit 1 or anything unexpected: every edit is put back; exit 3 = UNKNOWN lines:
 * applied, to be re-run). `shellVars` is a parameter, not read from the environment here, because the selftest drives this function from inside the harness.
 */
function deployApply({ E = loadEdits(), root = REPO, ms, procList, holiday, runSelftest, runVerify, backups, stateful, backupDir, stateFile, shellVars = [], out = console.log } = {}) {
  const files = filesOf(E), P = plan(E, root), drift = P.filter((f) => f.state === "drift");
  if (drift.length) return { code: 2, result: "refused", why: drift.map((f) => `${f.rel}: ${f.problem || "DRIFT — " + f.states.filter((x) => x.state === "drift").map((x) => x.id).join(", ") + " is neither base nor applied; read the change, then make-edits.cjs --restage"}`) };
  if (P.every((f) => f.state === "applied")) return { code: 0, result: "noop", why: ["every edit is already applied"] };
  if (shellVars.length) return { code: 2, result: "refused", why: [`${shellVars.join(", ")} ${shellVars.length > 1 ? "are" : "is"} set in this shell — a switch of this package's test harness (another edit list, a temp copy of the tree, another clock). The two gates would not read ${shellVars.length > 1 ? "them" : "it"}, but the write mode does not start from a shell that carries one: clear ${shellVars.length > 1 ? "them" : "it"} and run it again`] };
  const fz = fences({ ms, files, procList, holiday }); if (fz.length) return { code: 2, result: "refused", why: fz };
  const st = runSelftest(); if (!st || !st.ok) return { code: 2, result: "refused", why: ["the selftest did not pass:", ...((st && st.lines) || [])] };
  out(`  ${st.last}`);
  const r = applyAll({ E, root, ms, procList, holiday, ...(backups === undefined ? {} : { backups }), ...(stateful === undefined ? {} : { stateful }), ...(backupDir ? { backupDir } : {}), ...(stateFile ? { stateFile } : {}) });
  if (r.result === "refused") return { code: 2, result: "refused", why: r.why };
  if (r.result === "noop") return { code: 0, result: "noop", why: r.why };
  if (r.result !== "applied") return { code: 1, result: "failed", why: r.why, restored: r.restored, notRestored: r.notRestored || [] };
  for (const [rel, f] of Object.entries(r.files)) out(`  written ${rel.padEnd(42)} ${f.before.slice(0, 12)} -> ${f.after.slice(0, 12)}${f.backup ? "   backup " + f.backup : ""}`);
  const undo = (why) => { const b = rollbackAll({ E, root, ms, procList, holiday, recorded: r.files, ...(stateful === undefined ? {} : { stateful }), ...(stateFile ? { stateFile } : {}) }); return { code: 1, result: "undone", why: [why], rollback: b.result, rollbackWhy: b.why || [], files: r.files }; };
  for (const rel of Object.keys(r.files)) { const c = cp.spawnSync(process.execPath, ["--check", path.join(root, rel)], { encoding: "utf8", windowsHide: true }); if (c.status !== 0) return undo(`node --check ${rel}: ${String(c.stderr).trim().split("\n")[0]}`); }
  const v = runVerify(); if (v && v.text) out(v.text);
  if (!v || (v.status !== 0 && v.status !== 3)) return undo(`verify-live.cjs ended ${v && v.status === 1 ? "with a FAIL" : "abnormally (exit " + (v && v.status) + ")"}`);
  return { code: 0, result: "applied", files: r.files, verify: v.status === 0 ? "pass" : "unknowns" };
}
/** The harness's own switches (PFB_SELFTEST_EDITS: another edit list; PFB_VERIFY_ROOT: a temp copy of the tree; PFB_LIB_MUTANT, PFB_SCENARIO) never reach the two gates of
 *  the write mode: every PFB_* variable is taken out of the environment a gate runs in, whatever its case (Windows reads names without case). And the write mode itself
 *  does not start while the shell carries one (deployApply's `shellVars`): the read-only modes name what they find, the write mode refuses. */
const gateVars = (env = process.env) => Object.keys(env).filter((k) => /^PFB_/i.test(k)).sort();
const gateEnv = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([k]) => !/^PFB_/i.test(k)));
/** one gate of deploy.cjs's write mode (selftest.cjs, verify-live.cjs) as a child process: the package's own script, in an environment without the harness's switches */
function gateRun(script, { env = process.env, spawn = cp.spawnSync } = {}) { return spawn(process.execPath, [path.resolve(PKG, script)], { encoding: "utf8", timeout: 900000, cwd: REPO, env: gateEnv(env), windowsHide: true, maxBuffer: 64 << 20 }); }

// ───────────────────────────────────────────── what the nightly run stored since the apply (verify-live check 7) ─────────────────────────────────────────────
/** The sessions whose nightly run fell after the apply and is over by `nowMs`: trading weekdays d whose 13:50 MT (the close chain's window opens; the risk manager runs
 *  inside it) is at or after the apply and whose 16:00 MT is at or before now. It throws when the holiday table cannot be read. */
function sessionsSince(appliedAt, nowMs = Date.now(), holiday = liveHoliday) {
  const out = [], mtAt = (d, mins) => { for (const off of [6, 7]) { const ms = Date.parse(`${d}T00:00:00Z`) + (off * 60 + mins) * 60000, p = mtNow(ms); if (p.date === d && p.mins === mins) return ms; } throw new Error(`${d}: no minute ${mins} MT`); };
  for (let t = Date.parse(`${mtNow(appliedAt).date}T00:00:00Z`); t <= Date.parse(`${mtNow(nowMs).date}T00:00:00Z`); t += DAY) { const d = iso(t), dow = new Date(t).getUTCDay(); if (dow === 0 || dow === 6 || holiday(d)) continue; if (mtAt(d, WIN.chainFrom) >= appliedAt && mtAt(d, WIN.applyTo) <= nowMs) out.push(d); }
  return out;
}
/**
 * What risk-manager.js has stored since the apply, read from the two files it writes. Lines { verdict: PASS | FAIL | UNKNOWN | INFO, what, detail }.
 *   the snapshot      a run that ended UNKNOWN since the apply is said FIRST: the failure handler keeps the last good snapshot's generatedAt, so that field cannot
 *                     tell whether a run happened. generatedAt is read only for a snapshot whose status is OK. No status at all = written by the file from before the fix.
 *   the forward file  every session whose nightly run fell after the apply must have its row; a session without one is NAMED (the writer appends only the last
 *                     bar's day, so a later healthy night does not fill the hole). And the day an OK snapshot is for must have its row too, whether or not the
 *                     calendar counts that day as due yet: a snapshot without its row (a --preview run writes none) is UNKNOWN, never taken for accrual.
 * `appliedIso` is the apply's time from deploy-state.json (null: no apply on record); `stated` is the model's output-file rate (a number, or not one when unreadable).
 */
function nightlyState({ snapshotFile, forwardFile, appliedIso = null, stated, nowMs = Date.now(), holiday = liveHoliday }) {
  const out = [], say = (verdict, what, detail = "") => out.push({ verdict, what, detail }), appliedAt = appliedIso ? Date.parse(appliedIso) : null, since = appliedAt ? ` (${appliedIso})` : "";
  let snap = null, ranFor = null; try { snap = JSON.parse(fs.readFileSync(snapshotFile, "utf8")); if (!snap || typeof snap !== "object") throw new Error("not an object"); } catch (e) { snap = null; say("UNKNOWN", "risk-manager.json", `cannot be read (${String(e.message).slice(0, 100)})`); }
  if (snap) {
    const u = snap.unknown || {}, unkAt = Date.parse(u.at || ""), gen = Date.parse(snap.generatedAt || "");
    if (snap.status === "UNKNOWN" && !(unkAt < appliedAt)) say("UNKNOWN", "risk-manager.json", `the last nightly run ended UNKNOWN at ${u.at || "?"}: ${u.why || "no reason stored"} (the numbers kept are from ${u.lastGoodAsOf || "no earlier day"}) — no forward row was written for that night; node backend/risk-manager.js run again the same evening recovers it (NOTES, 'A night that ends UNKNOWN')`);
    else if (snap.status !== "OK" || (appliedAt && !(gen >= appliedAt))) say("UNKNOWN", "risk-manager.json", `written ${snap.generatedAt || "?"} for ${snap.asOf || "?"}${snap.status === "UNKNOWN" ? `, marked UNKNOWN at ${u.at} (before the apply)` : ""} — the nightly run has not run since the apply${since}; run this again after the next close chain`);
    else { ranFor = typeof snap.asOf === "string" ? snap.asOf : null;   // a run of the fixed file that ended OK since the apply: the same run appends that day's forward row (checked below)
      const good = !!snap.planE && (typeof stated !== "number" ? snap.planE.status === "UNKNOWN" : snap.planE.annualReturnPct === stated) && !!snap.preview && typeof snap.preview.basis === "string";
      say(good ? "PASS" : "FAIL", `risk-manager.json for ${snap.asOf}: status OK, the stated return ${snap.planE && snap.planE.annualReturnPct}% from the model's output, the preview labelled as the proxy book`, good ? "" : JSON.stringify({ status: snap.status, planE: snap.planE }).slice(0, 240)); }
  }
  let rows = null; try { rows = fs.readFileSync(forwardFile, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); if (!rows.length) throw new Error("no rows"); } catch (e) { rows = null; say("UNKNOWN", "risk-manager-forward.jsonl", `cannot be read (${String(e.message).slice(0, 100)})`); }
  if (rows) {
    say("INFO", `risk-manager-forward.jsonl: ${rows.length} rows ${rows[0].d}..${rows[rows.length - 1].d}; ${appliedAt ? "rows written before the apply carry the window defect (NOTES)" : "no apply on record"}`);
    const have = new Set(rows.map((r) => r.d)); let named = [];
    if (appliedAt) { let due = null; try { due = sessionsSince(appliedAt, nowMs, holiday); } catch (e) { say("UNKNOWN", "risk-manager-forward.jsonl", `the holiday table cannot be read (${String(e.message).slice(0, 80)}) — the sessions since the apply cannot be listed, so a missing row cannot be ruled out`); }
      if (due) { const missing = due.filter((d) => !have.has(d)); named = missing;
        if (!due.length) say("INFO", `risk-manager-forward.jsonl: no nightly run was due between the apply${since} and now`);
        else if (missing.length) say("UNKNOWN", "risk-manager-forward.jsonl", `${missing.length} of the ${due.length} session(s) since the apply have NO row: ${missing.join(", ")} — a night that ended UNKNOWN or did not run. The writer appends only the last bar's day, so a later night does not fill it: R270's read must name each (NOTES, 'A night that ends UNKNOWN')`);
        else say("PASS", `risk-manager-forward.jsonl: a row for each of the ${due.length} session(s) since the apply (${due[0]}..${due[due.length - 1]})`); } }
    // Accrual, tied to the snapshot itself: the run that stores an OK snapshot for a day appends that day's forward row right after it. An OK snapshot whose day has no row
    // (a run made with --preview writes none; so does a run whose append did not happen) is never read as "the forward file is accruing" — whatever the calendar above says.
    if (ranFor && !have.has(ranFor) && !named.includes(ranFor)) say("UNKNOWN", "risk-manager-forward.jsonl", `the stored snapshot is OK for ${ranFor}, but the forward file holds NO row for ${ranFor} — the run that wrote the snapshot wrote no row (a run with --preview writes none), so no forward row is shown for the day the snapshot is for. That day's nightly run writes it: run this again after its close chain (NOTES, 'A night that ends UNKNOWN')`);
  }
  return out;
}

// ───────────────────────────────────────────────────────────── harness ─────────────────────────────────────────────────────────────
const loadFixture = () => JSON.parse(fs.readFileSync(FIXTURE_FILE, "utf8"));
function fakeDate(nowMs) { const R = Date; return class FakeDate extends R { constructor(...a) { if (a.length === 0) super(nowMs); else super(...a); } static now() { return nowMs; } }; }
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => { if (body instanceof Error) throw body; return body; } });
const looksLikeSignal = (s) => !!s && typeof s === "object" && typeof s.aborted === "boolean" && typeof s.addEventListener === "function";
/** A request that never answers. It settles only when the caller's own signal aborts it, the way fetch does (it rejects with the signal's reason). With no signal it never
 *  settles and holds the event loop open, as a socket that never answers would — so it is for child-process runs only (harness/preload.cjs carries the watchdog). */
const hang = (init) => new Promise((_, reject) => { const s = init && init.signal, keep = setInterval(() => {}, 1 << 30), stop = () => { clearInterval(keep); reject(s.reason); };
  if (looksLikeSignal(s)) { if (s.aborted) stop(); else s.addEventListener("abort", stop, { once: true }); } });
const bentCandle = (as, t, c) => { const B = { "close-null": [t, c, c, c, null, 1], "close-zero": [t, c, c, c, 0, 1], "close-text": [t, c, c, c, "abc", 1], "time-text": ["abc", c, c, c, c, 1], short: [t, c], object: { time: t, close: c } }; if (!(as in B)) throw new Error(`unknown bend: ${as}`); return B[as]; };
/**
 * Coinbase Exchange daily candles, emulated on a recorded series { BTC: { "YYYY-MM-DD": close } }: a candle is returned when its 00:00 UTC time is
 * inside [start, end]; more than 300 candles in one request is the exchange's 400. `fault` breaks it on purpose:
 *   { at: k, kind: "rate-limit" | "http500" | "not-json" | "not-list" }
 *                                                            the k-th request (1-based, per coin; a request is its start..end range) fails that way EVERY time it is
 *                                                            asked, so a runner that asks again meets the fault again. `at` may be a list of requests.
 *                                                            not-list: HTTP 200 with a JSON body that is not a candle list.
 *   { ..., times: n }                                        the fault lifts once the request has failed n times (times: 1 = a passing fault: the next ask is answered)
 *   { drop: ["YYYY-MM-DD", ...] }                            those days are left out of every answer (a partial list)
 *   { staleAfter: "YYYY-MM-DD" }                             nothing after that day is served (a stale feed)
 *   { bend: { day: "YYYY-MM-DD", as: "close-null" | "close-zero" | "close-text" | "time-text" | "short" | "object" } }   that day's candle is served malformed
 *   { at: k, kind: "hang" }                                  the k-th request never answers (see hang(): child-process runs only); `times` applies as above
 * With `coin` set, the at / staleAfter / bend faults hit that coin only. Every call is recorded: k (which request), attempt (how many times that request has been
 * asked so far) and whether it carried an abort signal (hasSignal).
 */
function coinbaseServer(series, fault = {}) {
  const calls = [], asked = {}, mine = (coin) => !fault.coin || fault.coin === coin, hits = (k) => (Array.isArray(fault.at) ? fault.at.includes(k) : fault.at === k);
  const handle = (url, init) => {
    const m = /products\/([A-Z]+)-USD\/candles\?granularity=86400&start=([^&]+)&end=([^&]+)/.exec(url); if (!m) return resp(404, { message: "NotFound" });
    const coin = m[1], s = Date.parse(decodeURIComponent(m[2])), e = Date.parse(decodeURIComponent(m[3])), A = (asked[coin] = asked[coin] || new Map()), key = `${s}..${e}`; if (!A.has(key)) A.set(key, { k: A.size + 1, n: 0 });
    const q = A.get(key), k = q.k, attempt = ++q.n; calls.push({ coin, s, e, k, attempt, hasSignal: looksLikeSignal(init && init.signal) });
    if (hits(k) && mine(coin) && attempt <= (fault.times || Infinity)) { if (fault.kind === "hang") return hang(init); if (fault.kind === "rate-limit") return resp(429, { message: "Public rate limit exceeded" }); if (fault.kind === "http500") return resp(500, { message: "Internal server error" }); if (fault.kind === "not-json") return resp(200, new SyntaxError("Unexpected token < in JSON")); if (fault.kind === "not-list") return resp(200, { message: "NotFound" }); }
    const first = Math.ceil(s / DAY) * DAY, n = e >= first ? Math.floor((e - first) / DAY) + 1 : 0;
    if (n > 300) return resp(400, { message: "granularity too small for the requested time range. Count of aggregations requested exceeds 300" });
    const out = [], ser = series[coin] || {}, bend = fault.bend && mine(coin) ? fault.bend : null;
    for (let t = first; t <= e; t += DAY) { const d = iso(t); if (!(d in ser)) continue; if (fault.drop && fault.drop.includes(d)) continue; if (fault.staleAfter && d > fault.staleAfter && mine(coin)) continue; const c = ser[d]; out.push(bend && bend.day === d ? bentCandle(bend.as, t / 1000, c) : [t / 1000, c, c, c, c, 1]); }
    return resp(200, out.reverse());
  };
  return { handle, calls };
}
/** Alpaca GET /v2/calendar emulated on { "YYYY-MM": [session dates] }. fault: { status: 401 } | { notList: true } | { without: "YYYY-MM-DD" } |
 *  { add: [rows] } (rows appended to the answer exactly as given: a row with no date, a date outside the range, a row that is not an object) | { until: "YYYY-MM-DD" }
 *  (a CUT answer: well formed, but no session after that day is listed) | { hang: true } (never
 *  answers — child-process runs only). Every call is recorded, with whether it carried the key headers (hasKeys) and an abort signal (hasSignal). */
function calendarServer(byMonth, fault = {}) {
  const calls = [], all = Object.values(byMonth).flat().sort();
  const handle = (url, init) => {
    const m = /\/v2\/calendar\?start=(\d{4}-\d{2}-\d{2})&end=(\d{4}-\d{2}-\d{2})/.exec(url); if (!m) return resp(404, { message: "not found" });
    calls.push({ start: m[1], end: m[2], hasKeys: !!(init && init.headers && init.headers["APCA-API-KEY-ID"]), hasSignal: looksLikeSignal(init && init.signal) });
    if (fault.hang) return hang(init);
    if (fault.status) return resp(fault.status, { message: "forbidden" }); if (fault.notList) return resp(200, { message: "unexpected" });
    if (!byMonth[m[1].slice(0, 7)]) return resp(200, []);
    return resp(200, all.filter((d) => d >= m[1] && d <= m[2] && d !== fault.without && !(fault.until && d > fault.until)).map((date) => ({ date, open: "09:30", close: "16:00" })).concat(fault.add || []));
  };
  return { handle, calls };
}
/** the only `fetch` the code under test gets: the two emulators, and a loud refusal for anything else */
function makeFetch({ coinbase, calendar }) {
  return async (url, init) => { const u = String(url);
    if (/^https:\/\/api\.exchange\.coinbase\.com\//.test(u) && coinbase) return coinbase.handle(u, init);
    if (/^https:\/\/paper-api\.alpaca\.markets\/v2\/calendar\?/.test(u) && calendar) return calendar.handle(u, init);
    throw new Error(`NETWORK BLOCKED in the offline harness: ${u.split("?")[0]}`); };
}
/** The session calendar the emulator serves. The months Alpaca's calendar was recorded for (fix.calendar: whole months, sessions still to come included) and, for every
 *  FINISHED month before the last bar's month, the days SPY has a bar (a session is a day SPY traded). So year ends, leap Februaries and months that end on a holiday
 *  can be asked for, not only the two recorded months. The last bar's own month is never cut from bars: it is not finished. */
function sessionsByMonth(fix) {
  const by = {}, lastYm = fix.bars.SPY[fix.bars.SPY.length - 1][0].slice(0, 7);
  for (const [d] of fix.bars.SPY) if (d.slice(0, 7) < lastYm) (by[d.slice(0, 7)] = by[d.slice(0, 7)] || []).push(d);
  return { ...by, ...fix.calendar };
}
const barsOf = (fix, asOf) => { const bars = {}; for (const [s, rows] of Object.entries(fix.bars)) bars[s] = rows.filter((r) => r[0] <= asOf).map((r) => ({ t: `${r[0]}T04:00:00Z`, c: r[1] })); return bars; };
const cryptoUpTo = (fix, lastDay) => Object.fromEntries(Object.entries(fix.crypto).map(([c, m]) => [c, Object.fromEntries(Object.entries(m).filter(([d]) => d <= lastDay))]));
const dtb3Csv = (fix) => "observation_date,DTB3\n" + Object.keys(fix.dtb3).sort().map((ym) => `${ym}-28,${fix.dtb3[ym]}`).join("\n") + "\n";
/** the functions of risk-manager.js, taken from its own text (the slice "const W = {" .. "function summary(") and run with injected I/O */
function rmApi(text, { fetch, fetchBars, nowMs, dtb3File }) {
  const a = text.indexOf("const W = {"), b = text.indexOf("function summary("); if (a < 0 || b < 0) throw new Error("risk-manager.js moved: the slice const W .. function summary( is not there");
  const D = (f) => (f === "training/fred/DTB3.csv" ? dtb3File : path.join(os.tmpdir(), "pfb-no-such-dir", f));
  const fn = new Function("fs", "D", "fetchBars", "fetch", "process", "Date", "setTimeout", "AbortSignal", text.slice(a, b) + "\nreturn { buildBook, manage, riskShares, coinbase, sessionsToCome: typeof sessionsToCome === 'function' ? sessionsToCome : null, W, ZN_LEV, ZN_BETA, RULE };");
  // AbortSignal: the timeout each request asks for is recorded (api.timeouts). In-process nothing hangs, so the signal handed back is a real one that never fires.
  // setTimeout: every sleep the code asks for is recorded as asked (api.sleeps: the 350 ms politeness pause, the retry back-offs) and passes at once.
  const timeouts = [], sleeps = [], api = fn(fs, D, fetchBars, fetch, { env: { ALPACA_KEY_ID: "offline-harness", ALPACA_SECRET_KEY: "offline-harness" }, argv: [] }, fakeDate(nowMs), (f, ms) => { sleeps.push(ms); f(); return 0; }, { timeout: (ms) => { timeouts.push(ms); return new AbortController().signal; } });
  api.timeouts = timeouts; api.sleeps = sleeps; return api;
}
/** one night of buildBook on the recorded inputs: the last bar is `asOf`, the clock says that evening (20:33 UTC), the candle of the day is in progress */
async function nightRows(text, fix, asOf, { dtb3File, coinbaseFault, calendarFault, nowMs } = {}) {
  const now = nowMs || Date.parse(`${asOf}T20:33:00Z`), cb = coinbaseServer(cryptoUpTo(fix, iso(now)), coinbaseFault), cal = calendarServer(sessionsByMonth(fix), calendarFault);
  const api = rmApi(text, { fetch: makeFetch({ coinbase: cb, calendar: cal }), fetchBars: async () => ({ bars: barsOf(fix, asOf), truncatedStart: [] }), nowMs: now, dtb3File });
  const rows = await api.buildBook("2019-06-03"); return { rows, api, cb, cal };
}
/** a temp tree shaped like backend/ (named "be" so no command line of the harness looks like a live runner) */
function tempRoot(tag = "t") { const root = fs.mkdtempSync(path.join(os.tmpdir(), `pfb-${tag}-`)), be = path.join(root, "be"); fs.mkdirSync(path.join(be, "lib"), { recursive: true }); fs.mkdirSync(path.join(be, "data", "training", "fred"), { recursive: true }); fs.mkdirSync(path.join(be, "data", "profit-program"), { recursive: true }); return { root, be, rm: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} } }; }
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
/**
 * risk-manager.js end to end as a child process on a temp tree: the real file text, the real atomic-write.js, a stub alpaca-bars.js, and
 * harness/preload.cjs (fixed clock, the emulators as `fetch`, nothing else reachable). Returns exit code, output, snapshot, forward rows and `calls`: every request
 * the child made of the two emulators (with hasSignal), every timeout it asked AbortSignal for, in milliseconds, and every sleep it asked for (calls.sleeps). scenario.timeoutScale shrinks those timeouts in
 * the child (0.005: 20 s becomes 100 ms) so a request that never answers is ended by the runner's own timeout at once; scenario.watchdogMs ends a run that is still
 * waiting after that long with exit 97 (a runner with no timeout would otherwise wait for ever). scenario.barsError makes the stub's fetchBars throw an error with that
 * message (a failure with a reason of any length, for the check on what the run leaves at the END of its stderr).
 */
function runRiskManager(text, fix, scenario) {
  const T = tempRoot("rm");
  try {
    put(path.join(T.be, "risk-manager.js"), text);
    fs.copyFileSync(path.join(REPO, "backend", "lib", "atomic-write.js"), path.join(T.be, "lib", "atomic-write.js"));
    put(path.join(T.be, "lib", "alpaca-bars.js"), '"use strict";\nmodule.exports = { fetchBars: async () => globalThis.__PFB.fetchBars() };\n');
    put(path.join(T.be, "data", "training", "fred", "DTB3.csv"), dtb3Csv(fix));
    if (scenario.baseline !== undefined && scenario.baseline !== null) put(path.join(T.be, "data", "profit-program", "planE-baseline.json"), typeof scenario.baseline === "string" ? scenario.baseline : JSON.stringify(scenario.baseline));
    if (scenario.prevSnapshot) put(path.join(T.be, "data", "risk-manager.json"), JSON.stringify(scenario.prevSnapshot));
    if (scenario.prevForward) put(path.join(T.be, "data", "risk-manager-forward.jsonl"), scenario.prevForward);
    const scen = path.join(T.root, "scenario.json"); put(scen, JSON.stringify({ lib: __filename, fixture: FIXTURE_FILE, asOf: scenario.asOf, nowMs: scenario.nowMs || Date.parse(`${scenario.asOf}T20:33:00Z`), coinbaseFault: scenario.coinbaseFault || {}, calendarFault: scenario.calendarFault || {}, barsError: scenario.barsError || null, callsFile: path.join(T.root, "calls.json"), timeoutScale: scenario.timeoutScale || 1, watchdogMs: scenario.watchdogMs || 0 }));
    const env = { PATH: process.env.PATH || "", SystemRoot: process.env.SystemRoot || "", TEMP: os.tmpdir(), TMP: os.tmpdir(), PFB_SCENARIO: scen, ALPACA_KEY_ID: "offline-harness", ALPACA_SECRET_KEY: "offline-harness" };
    const r = cp.spawnSync(process.execPath, ["-r", path.join(PKG, "harness", "preload.cjs"), path.join(T.be, "risk-manager.js"), ...(scenario.args || [])], { encoding: "utf8", env, cwd: T.root, timeout: 120000, windowsHide: true, maxBuffer: 32 << 20 });
    const rd = (f) => { try { return fs.readFileSync(path.join(T.be, "data", f), "utf8"); } catch { return null; } }, snap = rd("risk-manager.json"), fw = rd("risk-manager-forward.jsonl");
    let calls = null; try { calls = JSON.parse(fs.readFileSync(path.join(T.root, "calls.json"), "utf8")); } catch {}
    return { calls, status: r.status, stdout: String(r.stdout || ""), stderr: String(r.stderr || ""), snapshot: snap ? JSON.parse(snap) : null, forward: fw ? fw.trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [], tmpLeft: fs.readdirSync(path.join(T.be, "data")).filter((f) => /\.tmp-/.test(f)) };
  } finally { T.rm(); }
}

// ───────────────────────────────────────────── the model's yearly rate, from its own inputs ─────────────────────────────────────────────
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
/**
 * Plan E's STATED model (the refereed monthly family of backend/profit-program/planE-model.js pyBuild / run / monthlyStats, written out again
 * here on the frozen inputs): trend sleeves on the 10-month rule with 5 bps per flip, DBMF held, BTC + ETH on the 50-day rule with 25 bps per
 * switch, the REAL ten-year-note month-end window at 4.2x, idle weight at the T-bill. 2019-06..2026-09. Returns the yearly rate in percent.
 */
function statedRate(fix, cryptoSeries = fix.crypto, { asOf = "2026-09-30", lo = "2019-06", hi = "2026-09" } = {}) {
  const TBY = Object.fromEntries(Object.entries(fix.dtb3).map(([m, v]) => [m, v / 100]));
  const monthEnds = (rows) => { const me = {}; for (const [d, c] of rows) if (d <= asOf) me[d.slice(0, 7)] = c; return me; };
  const trend = (me) => { const ms = Object.keys(me).sort(), out = {}; let prevOn = null; for (let i = 10; i < ms.length; i++) { const on = me[ms[i - 1]] > mean(ms.slice(i - 10, i).map((m) => me[m])); out[ms[i]] = (on ? me[ms[i]] / me[ms[i - 1]] - 1 : (TBY[ms[i]] || 0) / 12) - (prevOn !== null && on !== prevOn ? 0.0005 : 0); prevOn = on; } return out; };
  const hold = (me) => { const ms = Object.keys(me).sort(), out = {}; for (let i = 1; i < ms.length; i++) out[ms[i]] = me[ms[i]] / me[ms[i - 1]] - 1; return out; };
  const cDaily = (m0) => { const m = Object.fromEntries(Object.entries(m0).filter(([d]) => d <= asOf)), ds = Object.keys(m).sort(), out = new Map(); let pos = 0; for (let i = 50; i < ds.length; i++) { const r = m[ds[i]] / m[ds[i - 1]] - 1; let v = pos ? r : (TBY[ds[i].slice(0, 7)] || 0) / 365; const on = m[ds[i]] > mean(ds.slice(i - 49, i + 1).map((d) => m[d])) ? 1 : 0; if (on !== pos) v -= 0.0025; out.set(ds[i], v); pos = on; } return out; };
  const Q = trend(monthEnds(fix.bars.QQQ)), S = trend(monthEnds(fix.bars.SPY)), G = trend(monthEnds(fix.bars.GLD)), EF = trend(monthEnds(fix.bars.EFA)), DB = hold(monthEnds(fix.bars.DBMF));
  const cb = cDaily(cryptoSeries.BTC), ce = cDaily(cryptoSeries.ETH), C = {}; for (const [d, x] of cb) { if (!ce.has(d)) continue; const m = d.slice(0, 7); C[m] = (C[m] || 1) * (1 + 0.5 * x + 0.5 * ce.get(d)); } for (const m in C) C[m] -= 1;
  const TR = new Map(fix.znRows.map((r) => [r.m, r])), w = { L: 4.2, q: 0.15, s: 0.15, c: 0.15, g: 0.10, e: 0.10, db: 0.15 }, inv = w.q + w.s + w.c + w.g + w.e + w.db;
  const ms = Object.keys(C).filter((m) => m >= lo && m <= hi && TR.has(m) && Q[m] != null && S[m] != null && G[m] != null && EF[m] != null && DB[m] != null).sort();
  let v = 1; for (const m of ms) { const t = TR.get(m); v *= 1 + w.L * t.tre + w.q * Q[m] + w.s * S[m] + w.e * EF[m] + w.g * G[m] + w.db * DB[m] + w.c * C[m] + Math.max(0, 1 - inv) * t.tb; }
  return { months: ms.length, from: ms[0], to: ms[ms.length - 1], annualReturnPct: 100 * (v ** (12 / ms.length) - 1) };
}
const usdYear = (pct) => 1000 * pct, usdDay = (pct) => (1000 * pct) / 252;   // on $100,000, 252 trading days

module.exports = { PKG_NAME, PKG, PKG_REL, REPO, EDITS_FILE, FIXTURE_FILE, STATE_FILE, BACKUP_DIR, DAY, iso, sha256, atomic, FORBIDDEN, forbidden, isRegistryOrChain, validateEdits, loadEdits, filesOf, editsFor,
  count, at, editState, fileState, applyText, revertText, readText, texts, plan, writeExact, nodeCheckText, parts, mtNow, etNow, liveHoliday, tradingWeekday, procs, argsOf, busyPatterns, WIN, fences,
  readState, writeState, logRow, applyAll, rollbackAll, deployApply, gateVars, gateEnv, gateRun, sessionsSince, nightlyState, loadFixture, fakeDate, looksLikeSignal, coinbaseServer, calendarServer, makeFetch, sessionsByMonth, barsOf, cryptoUpTo, dtb3Csv, rmApi, nightRows, tempRoot, put, runRiskManager,
  mean, statedRate, usdYear, usdDay };
