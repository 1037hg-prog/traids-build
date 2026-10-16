"use strict";
/**
 * PAUSE-AWARE SERVER AND MONITORS, 2026-10-12 — shared library for make-edits / deploy / rollback / selftest / verify-live.
 * A module: nothing happens on load. Clocks come from node's Intl (America/Denver), never the shell.
 *
 *   EDITS    the staged change is a list of ANCHORED whole-line replacements (edits.json, written by make-edits.cjs from today's files).
 *            Per edit, against a file's text: "base" = the old block is there exactly once and the new block nowhere; "applied" = the new
 *            block exactly once and the old block nowhere else; anything else is DRIFT and nothing is written. Apply and revert are exact
 *            inverses on the bytes. No whole staged copy of any file is kept: an edit elsewhere in a file by another package is not drift.
 *   MARKS    26 of the 53 edits are INSERTS: the staged block is put above or below an anchor line that stays, so the new block holds the
 *            old one. For those the two blocks alone cannot tell "base" from "applied, and a line inside the inserted block was changed
 *            since" (the anchor is still there once, the whole new block is not). So every insert carries MARKS (edits.json `marks`, cut by
 *            make-edits.cjs): short pieces of each line it adds that are nowhere in the base file and in no other edit's block. "base" also
 *            requires that no mark is in the file; a mark in a file whose new block is not there whole is DRIFT (refused, nothing written).
 *   FENCES   the write modes refuse on a trading weekday 05:30-16:00 MT, inside 13:50-15:50 MT for the files the close chain runs, and
 *            while a file of the unit (or a script that loads one) is running. An unreadable process list is a refusal.
 *   OVERLAY  the existing selftests of the touched files are run on the PATCHED text without writing the repo: the patched files are
 *            written to a temp folder and harness/overlay.cjs (a preload) serves each in place of its real file to that process tree.
 */
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto"), cp = require("child_process");
const PKG_NAME = "pause-aware-2026-10-12", PKG = __dirname, REPO = path.resolve(PKG, "..", "..", "..");
const EDITS_FILE = path.join(PKG, "edits.json"), STATE_FILE = path.join(PKG, "deploy-state.json"), BACKUP_DIR = path.join(PKG, "backups");
const PKG_REL = path.relative(REPO, PKG).replace(/\\/g, "/");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const atomic = () => require(path.join(REPO, "backend", "lib", "atomic-write.js"));

// ───────────────────────────────────────────────────────────── the unit ─────────────────────────────────────────────────────────────
/** the ten files of the unit (edits.json may name these and no other) */
const UNIT = [
  "docs/server/wave3-sleeves/deploy.cjs", "docs/server/wave3-sleeves/compare.cjs", "docs/server/wave3-sleeves/manifests.cjs", "docs/server/wave3-sleeves/NOTES.md",
  "deploy/server/own.cjs", "docs/server/wave1-crypto/own.cjs",
  "backend/ops-health.js", "backend/decay-monitor.js", "backend/all-activity-per-day.js", "backend/console.js",
];
/** deploy/server/own.cjs is the INSTALLED copy of W1's staged docs/server/wave1-crypto/own.cjs (W1's home patch judges the pair byte for byte,
 *  and W1c-2a's, W2b's and the R309 fold's prechecks refuse when it reads drift): the two carry the same edits and must stay equal */
const TWINS = [["deploy/server/own.cjs", "docs/server/wave1-crypto/own.cjs"]];
/** the files of the unit the close chain runs as steps (automation/close-chain.cjs, read as text 2026-10-12: "ops health", "decay monitor") */
const CHAIN_RUN = ["backend/ops-health.js", "backend/decay-monitor.js"];
/** files this package may never edit, whatever edits.json says */
const FORBIDDEN = [/(^|\/)\.env/i, /LIVE-ARMED/i, /^backend\/marks-live-watcher\.js$/, /^backend\/data\//, /(^|\/)node_modules\//, /^automation\/close-chain\.cjs$/, /(^|\/)marks-|(^|\/)cl-/, /-OFF$|-HALT(\.json)?$|TRAIDS_STOP$/, /\.json$/];
const forbidden = (rel) => FORBIDDEN.some((re) => re.test(rel));
/** the rules every edit list must meet (loadEdits and make-edits.cjs both go through it) */
function validateEdits(E) {
  if (!E || !Array.isArray(E.edits) || !E.edits.length) throw new Error("edits.json holds no edits");
  for (const e of E.edits) {
    if (!e.id || !e.file || typeof e.old !== "string" || typeof e.new !== "string") throw new Error(`edit ${e.id || "?"}: needs id, file, old, new`);
    if (forbidden(e.file)) throw new Error(`edit ${e.id}: ${e.file} is a file this package may never edit`);
    if (!UNIT.includes(e.file)) throw new Error(`edit ${e.id}: ${e.file} is not a file of this unit`);
    if (!e.old.endsWith("\n") || !e.new.endsWith("\n") || e.old === e.new || !e.old.trim()) throw new Error(`edit ${e.id}: old and new must be different whole-line blocks`);
    if (e.old.includes("\r") || e.new.includes("\r")) throw new Error(`edit ${e.id}: blocks are LF text`);
    if (count(e.old, e.new) > 0) throw new Error(`edit ${e.id}: the new block sits inside the old one — states could not be told apart`);
    if (isInsert(e)) { if (!Array.isArray(e.marks) || !e.marks.length || e.marks.some((m) => typeof m !== "string" || m.length < MARK_LEN || m.includes("\n") || !e.new.includes(m) || e.old.includes(m))) throw new Error(`edit ${e.id}: an insert (its new block holds its old block) needs marks — pieces of the lines it adds, in its new block and not in its old one — or a change inside the inserted block could not be told from "base"; run make-edits.cjs`); }
    else if (e.marks !== undefined && (!Array.isArray(e.marks) || e.marks.length)) throw new Error(`edit ${e.id}: a replacement carries no marks`);
  }
  if (new Set(E.edits.map((e) => e.id)).size !== E.edits.length) throw new Error("edits.json: an id is used twice");
  return E;
}
const loadEdits = (file = EDITS_FILE) => validateEdits(JSON.parse(fs.readFileSync(file, "utf8")));
const filesOf = (E) => [...new Set(E.edits.map((e) => e.file))];
const editsFor = (E, rel) => E.edits.filter((e) => e.file === rel);

// ───────────────────────────────────────────────────────── the edit engine (pure) ─────────────────────────────────────────────────────────
/** occurrences of a whole-line block: it must start at a line start (the blocks end with a newline themselves) */
function count(text, block) { let n = 0; for (let i = text.indexOf(block); i >= 0; i = text.indexOf(block, i + 1)) if (i === 0 || text[i - 1] === "\n") n++; return n; }
function at(text, block) { for (let i = text.indexOf(block); i >= 0; i = text.indexOf(block, i + 1)) if (i === 0 || text[i - 1] === "\n") return i; return -1; }
/** an INSERT: the new block holds the old one (the staged block sits above or below its anchor line, which stays) */
const isInsert = (e) => count(e.new, e.old) > 0;
const MARK_LEN = 16;
/**
 * The MARKS of an insert, cut when the edits are staged: for every line the edit adds (a line of its new block that is not a line of its old
 * block), up to three 16-character pieces of it — the ones nearest its start, its middle and its end that occur NOWHERE in the base text of
 * the file and in no other block that will be in that file (`others`: the new blocks of the unit's other edits on the file, and of another
 * package's edits that are applied first). So no mark is in a base file, whichever other edits are in it, and every mark is in an applied one.
 * Pieces, not whole lines: one changed character spoils at most one piece of its line, so a changed line still shows its other pieces (and
 * every other line of the block shows all of its own). [] for a replacement: there "neither block is there" already reads drift.
 */
function marksOf(e, baseText, others = []) {
  if (!isInsert(e)) return [];
  const oldLines = new Set(e.old.split("\n")), out = new Set(), free = (p) => !baseText.includes(p) && others.every((o) => !o.new.includes(p));
  for (const line of e.new.split("\n")) {
    const s = line.trim(), last = s.length - MARK_LEN; if (oldLines.has(line) || last < 0) continue;
    for (const want of [0, last >> 1, last]) {   // the free piece nearest the start, the middle, the end of the line
      for (let d = 0; d <= last; d++) { const i = [want + d, want - d].find((k) => k >= 0 && k <= last && free(s.substr(k, MARK_LEN))); if (i !== undefined) { out.add(s.substr(i, MARK_LEN)); break; } }
    }
  }
  return [...out];
}
/** another package's edits on the same file, as blocks for marksOf's `others`: BOTH sides of each (its old block is in the file before that package is applied, its new
 *  block after), so the marks cut are the same in either state */
const bothBlocks = (theirs) => (theirs || []).flatMap((x) => [{ new: x.new }, { new: x.old }]);
const marksIn = (text, e) => (e.marks || []).filter((m) => text.includes(m));
const anyMark = (text, e) => (e.marks || []).some((m) => text.includes(m));
function editState(text, e) {
  const nNew = count(text, e.new), nOld = count(text, e.old), oldInNew = count(e.new, e.old);
  if (nNew === 1 && nOld === oldInNew) return "applied";
  if (nNew === 0 && nOld === 1) return anyMark(text, e) ? "drift" : "base";   // an insert whose block was changed after the apply still shows its marks: never "base"
  return "drift";
}
/** why an edit reads drift, in words (for the plan and the refusals) */
function driftWords(text, e) {
  const nNew = count(text, e.new), nOld = count(text, e.old), k = marksIn(text, e).length;
  if (nNew > 1) return `its new block is in the file ${nNew} times`;
  if (nNew === 1) return "its new block is there, with a stray extra copy of its old block";
  if (nOld > 1) return `its anchor is in the file ${nOld} times`;
  if (nOld === 1) return `its anchor is there and so are ${k} of the ${(e.marks || []).length} marks of the block this unit inserts beside it, but not the whole block: a line inside the inserted block was changed or removed after an apply, or part of the block was put into the file by hand`;
  return "neither its old nor its new block is in the file: a line of it was changed";
}
function fileState(text, edits) {
  const states = edits.map((e) => { const state = editState(text, e); return state === "drift" ? { id: e.id, state, why: driftWords(text, e) } : { id: e.id, state }; });
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
/** the 1-based first and last line of a whole-line block in a text, or null when it is not there */
function span(text, block) { const i = at(text, block); if (i < 0) return null; const a = text.slice(0, i).split("\n").length; return [a, a + block.split("\n").length - 2]; }
/**
 * WHERE an edit sits, by line number, so that a claim in NOTES can be checked against the file (pure; `edits` = every edit of that file).
 *   now    the lines its block occupies in `text` as it is: the old block (the anchor) while it reads base, the new block once applied; null on drift
 *   after  the lines its new block occupies once every edit of the file is applied (in a base file: where the block WILL be)
 * Line numbers move when another package edits the same file first; they are read from the file each time, never typed.
 */
function editLines(text, e, edits = [e]) {
  const st = editState(text, e), now = st === "base" ? span(text, e.old) : st === "applied" ? span(text, e.new) : null;
  let after = null; try { after = span(applyText(text, edits), e.new); } catch { after = null; }
  return { state: st, now, after };
}
const spanWords = (s) => (!s ? "?" : s[0] === s[1] ? `line ${s[0]}` : `lines ${s[0]}-${s[1]}`);
function plan(E, root = REPO) {
  return filesOf(E).map((rel) => {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) return { rel, missing: true, state: "drift", states: [], problem: "file missing" };
    try { const { text, sha } = readText(file), st = fileState(text, editsFor(E, rel)); return { rel, sha, bytes: Buffer.byteLength(text), ...st }; }
    catch (e) { return { rel, state: "drift", states: [], problem: e.message }; }
  });
}
/** the twins must be byte-equal (LF-normalised, as W1's own judge compares them) — before and after: [] or the problems */
function twinIssues(root = REPO, read = (f) => fs.readFileSync(f)) {
  const lf = (b) => b.toString("latin1").replace(/\r\n/g, "\n"), bad = [];
  for (const [a, b] of TWINS) { let x = null, y = null; try { x = read(path.join(root, a)); y = read(path.join(root, b)); } catch (e) { bad.push(`${a} / ${b}: cannot be read (${e.code || e.message})`); continue; } if (lf(x) !== lf(y)) bad.push(`${a} is not ${b} (W1's staged copy): W1's own judge would read DRIFT`); }
  return bad;
}
const writeExact = (dest, buf) => { const tmp = `${dest}.pa-tmp-${process.pid}`; const fd = fs.openSync(tmp, "w"); try { fs.writeFileSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } try { fs.renameSync(tmp, dest); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; } };
function nodeCheckText(text, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-check-")), f = path.join(dir, path.basename(name));
  try { fs.writeFileSync(f, text); const r = cp.spawnSync(process.execPath, ["--check", f], { encoding: "utf8", windowsHide: true }); return r.status === 0 ? null : String(r.stderr || "node --check failed").trim().split("\n").slice(0, 4).join(" | "); }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}
const isCode = (rel) => /\.c?js$/.test(rel);

// ───────────────────────────────────────────────────────────── fences ─────────────────────────────────────────────────────────────
function parts(tz, ms = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hour12: false }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, dow: p.weekday, mins: (+p.hour % 24) * 60 + +p.minute, hms: `${String(+p.hour % 24).padStart(2, "0")}:${p.minute}:${p.second}` };
}
const mtNow = (ms) => parts("America/Denver", ms);
/** Mon-Fri and not a full market holiday (backend/lib/run-window.js). A holiday table that cannot be read counts as a trading day (the stricter reading). */
function tradingWeekday(ms = Date.now(), holidays) {
  const mt = mtNow(ms); if (mt.dow === "Sat" || mt.dow === "Sun") return false;
  if (holidays) return !holidays[mt.date];
  try { return !require(path.join(REPO, "backend", "lib", "run-window.js")).marketHoliday(mt.date); } catch { return true; }
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
/** a node process that runs a file of the unit, or a script that loads one: the close chain (it runs ops-health.js and decay-monitor.js as
 *  steps), the Console's launchers (traids-cli.js and open-check.js load console.js), and any server package script (docs/server/<wave>/*.cjs:
 *  they load deploy/server/own.cjs, and the W3 ones load each other). cmd.exe: the chain's launchers. */
function busyPatterns(files) {
  const unit = files.filter(isCode).map((rel) => reEsc(rel).replace(/\//g, "[\\\\/]"));
  return { node: new RegExp(`(${[...unit, "automation[\\\\/]close-chain\\.cjs", "backend[\\\\/](traids-cli|open-check)\\.js", "docs[\\\\/]server[\\\\/][\\w-]+[\\\\/][\\w-]+\\.cjs"].join("|")})`, "i"), cmd: /(close-chain|daily-close\.bat)/i };
}
const WIN = { applyFrom: 5 * 60 + 30, applyTo: 16 * 60, chainFrom: 13 * 60 + 50, chainTo: 15 * 60 + 50 };
/** [] when a write may go ahead, else the reasons. `procList` and `holidays` are injectable (the selftest); by default the real ones are read.
 *  `ancestors`: pids to leave out besides this process (deploy.cjs runs this package's own selftest, which runs the touched files' selftests). */
function fences({ ms = Date.now(), files = UNIT, procList, self = process.pid, holidays, ownTree = [] } = {}) {
  const why = [], mt = mtNow(ms), td = tradingWeekday(ms, holidays);
  if (td && mt.mins >= WIN.applyFrom && mt.mins < WIN.applyTo) why.push(`${mt.hms} MT ${mt.dow} ${mt.date} is inside 05:30-16:00 MT on a trading weekday — apply after 16:00 MT or before 05:30 MT`);
  const rc = (files || []).filter((f) => CHAIN_RUN.includes(f));
  if (td && rc.length && mt.mins >= WIN.chainFrom && mt.mins < WIN.chainTo) why.push(`${mt.hms} MT is inside 13:50-15:50 MT on a trading day and the close chain runs file(s) of the unit: ${rc.join(", ")} — the chain owns that window`);
  try {
    const list = typeof procList === "function" ? procList() : procList || procs(), B = busyPatterns(files || []), skip = new Set([self, ...ownTree]);
    const hit = list.filter((p) => !skip.has(p.pid) && ((p.name === "node.exe" && B.node.test(p.cmd)) || (p.name === "cmd.exe" && B.cmd.test(p.cmd))));
    if (hit.length) why.push(`a file of the unit is running, or a script that loads one: ${hit.map((p) => `pid ${p.pid} ${p.cmd.replace(/\s+/g, " ").slice(0, 120)}`).join(" | ")}`);
  } catch (e) { why.push(`the process list cannot be read (${String(e.message).slice(0, 120)}) — refusing to replace files that may be running`); }
  return why;
}

// ───────────────────────────────────────────────────────── apply / rollback ─────────────────────────────────────────────────────────
function readState(file = STATE_FILE) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { package: PKG_NAME, log: [] }; } }
function writeState(st, file = STATE_FILE) { st.log = (st.log || []).slice(-200); atomic().writeJsonAtomic(file, st); }
function logRow(row, { stateful = true, stateFile = STATE_FILE } = {}) { if (!stateful) return; try { const st = readState(stateFile); (st.log = st.log || []).push({ at: new Date().toISOString(), mt: mtNow().hms, ...row }); writeState(st, stateFile); } catch (e) { console.error(`deploy-state.json could not be written: ${e.message}`); } }
const driftWhy = (f, tail) => `${f.rel}: ${f.problem || "DRIFT — " + f.states.filter((x) => x.state === "drift").map((x) => x.id).join(", ") + " " + tail + " [" + f.states.filter((x) => x.state === "drift").map((x) => `${x.id}: ${x.why}`).join("; ") + "]"}`;
/**
 * Apply every edit that is still base. All-or-nothing: every new text is built and syntax-checked in memory first; a failed write restores the
 * files already written from the bytes read at the start. `root` and the fence inputs are injectable so the selftest runs it on a temp copy.
 * `between` (called once every new text is built, before the second fence and sha check) and `write` (the forward write of one file; the
 * restore after a failed write always uses the real writeExact) are for the selftest only: deploy.cjs and rollback.cjs never pass them.
 * Returns { result: "applied" | "noop" | "refused" | "failed", ... } — it never throws for a refusal.
 */
function applyAll({ E = loadEdits(), root = REPO, ms, procList, holidays, backups = root === REPO, stateful = root === REPO, backupDir = BACKUP_DIR, stateFile = STATE_FILE, check = true, between, write = writeExact } = {}) {
  const files = filesOf(E), P = plan(E, root), bad = P.filter((f) => f.state === "drift");
  if (bad.length) return { result: "refused", why: bad.map((f) => driftWhy(f, "is neither base nor applied; read the change, then make-edits.cjs --restage")) };
  if (P.every((f) => f.state === "applied")) return { result: "noop", why: ["every edit is already applied"] };
  let fz = fences({ ms, files, procList, holidays }); if (fz.length) return { result: "refused", why: fz };
  const work = [];
  for (const f of P) {
    const file = path.join(root, f.rel), { buf, text, sha } = readText(file), next = applyText(text, editsFor(E, f.rel));
    if (check && isCode(f.rel)) { const err = nodeCheckText(next, f.rel); if (err) return { result: "refused", why: [`${f.rel}: the staged text fails node --check (${err})`] }; }
    work.push({ rel: f.rel, file, before: buf, beforeSha: sha, after: Buffer.from(next, "utf8"), afterSha: sha256(Buffer.from(next, "utf8")), was: f.state });
  }
  { const after = new Map(work.map((w) => [path.join(root, w.rel), w.after])), tw = twinIssues(root, (f) => after.get(f) || fs.readFileSync(f)); if (tw.length) return { result: "refused", why: tw.map((x) => `after the apply ${x} — nothing written`) }; }
  if (typeof between === "function") { const stop = between(work); if (stop) return { result: "refused", why: [].concat(stop) }; }
  fz = fences({ ms, files, procList, holidays }); if (fz.length) return { result: "refused", why: fz };
  for (const w of work) if (sha256(fs.readFileSync(w.file)) !== w.beforeSha) return { result: "refused", why: [`${w.rel} changed while this was running — nothing written`] };
  if (backups) { fs.mkdirSync(backupDir, { recursive: true }); for (const w of work) { const b = path.join(backupDir, `${w.rel.replace(/[\\/]/g, "__")}.pre-${PKG_NAME}-${w.beforeSha.slice(0, 12)}`); if (!fs.existsSync(b)) fs.copyFileSync(w.file, b); if (sha256(fs.readFileSync(b)) !== w.beforeSha) return { result: "refused", why: [`the backup of ${w.rel} does not verify — nothing written`] }; w.backup = (backupDir === BACKUP_DIR ? path.relative(REPO, b) : b).replace(/\\/g, "/"); } }
  const done = [];
  try {
    for (const w of work) { if (w.before.equals(w.after)) continue; write(w.file, w.after); done.push(w); if (sha256(fs.readFileSync(w.file)) !== w.afterSha) throw new Error(`${w.rel} does not verify after the write`); }
  } catch (e) {
    const left = []; for (const w of done.reverse()) { try { writeExact(w.file, w.before); if (sha256(fs.readFileSync(w.file)) !== w.beforeSha) left.push(w.rel); } catch { left.push(w.rel); } }
    return { result: "failed", why: [e.message], restored: !left.length, notRestored: left };
  }
  const rec = { at: new Date().toISOString(), files: Object.fromEntries(work.map((w) => [w.rel, { before: w.beforeSha, after: w.afterSha, was: w.was, backup: w.backup || null }])) };
  if (stateful) { const st = readState(stateFile); st.applied = rec; delete st.rolledBack; writeState(st, stateFile); }
  return { result: "applied", files: rec.files };
}
/** Put every applied edit back. Byte-exact: with nothing else changed since the apply each file returns to the sha recorded before it. */
function rollbackAll({ E = loadEdits(), root = REPO, ms, procList, holidays, stateful = root === REPO, stateFile = STATE_FILE, recorded, write = writeExact } = {}) {
  const files = filesOf(E), P = plan(E, root), bad = P.filter((f) => f.state === "drift");
  if (bad.length) return { result: "refused", why: bad.map((f) => driftWhy(f, "changed after the apply; put it back by hand from the backup")) };
  if (P.every((f) => f.state === "base")) return { result: "noop", why: ["no edit is applied"] };
  const fz = fences({ ms, files, procList, holidays }); if (fz.length) return { result: "refused", why: fz };
  const rec = recorded || (stateful ? (readState(stateFile).applied || {}).files : null) || {}, work = [];
  for (const f of P) { const file = path.join(root, f.rel), { buf, text, sha } = readText(file), prev = revertText(text, editsFor(E, f.rel)); work.push({ rel: f.rel, file, before: buf, beforeSha: sha, after: Buffer.from(prev, "utf8"), afterSha: sha256(Buffer.from(prev, "utf8")) }); }
  const done = [];
  try { for (const w of work) { if (w.before.equals(w.after)) continue; write(w.file, w.after); done.push(w); if (sha256(fs.readFileSync(w.file)) !== w.afterSha) throw new Error(`${w.rel} does not verify after the write`); } }
  catch (e) { const left = []; for (const w of done.reverse()) { try { writeExact(w.file, w.before); } catch { left.push(w.rel); } } return { result: "failed", why: [e.message], restored: !left.length, notRestored: left }; }
  const out = Object.fromEntries(work.map((w) => [w.rel, { now: w.afterSha, recordedBefore: (rec[w.rel] || {}).before || null, byteExact: rec[w.rel] ? rec[w.rel].before === w.afterSha : null }]));
  if (stateful) { const st = readState(stateFile); st.rolledBack = { at: new Date().toISOString(), files: out }; writeState(st, stateFile); }
  return { result: "rolled-back", files: out };
}
/**
 * What rollback.cjs says about a finished rollback (pure; `files` = rollbackAll's). A rollback is DONE only when every file is back to the
 * bytes recorded before the apply: code 0. A file that is not (every edit of this unit reads base in it, so what differs was changed
 * elsewhere in the file since the apply, and was kept) is said by name: code 1. A file with no record of the apply to compare with is not
 * confirmed: code 3 (never read as done).
 */
function rollbackReport(files) {
  const rows = Object.entries(files || {}).map(([rel, f]) => ({ rel, sha: f.now, recordedBefore: f.recordedBefore || null, exact: f.byteExact === true ? "yes" : f.byteExact === false ? "NO" : "unknown" }));
  const notExact = rows.filter((x) => x.exact === "NO").map((x) => x.rel), noRecord = rows.filter((x) => x.exact === "unknown").map((x) => x.rel);
  const code = notExact.length ? 1 : noRecord.length || !rows.length ? 3 : 0;
  const last = code === 0 ? `ROLLED BACK: all ${rows.length} files are byte for byte what they were before the apply.`
    : code === 1 ? `ROLLED BACK, BUT NOT BYTE-EXACT: ${notExact.length} of ${rows.length} file(s) are NOT the bytes recorded before the apply — ${notExact.join(", ")}. Every edit of this unit is out of them; what differs was changed elsewhere in the file since the apply, and was kept. Compare each with its copy in backups/ before relying on it.`
      : `ROLLED BACK, NOT CONFIRMED: there is no record of the apply to compare ${noRecord.length} file(s) with — ${noRecord.join(", ") || "no file listed"}. Every edit of this unit reads base in them; compare each with its copy in backups/.`;
  return { rows, notExact, noRecord, code, last };
}
/**
 * The write mode of deploy.cjs, start to finish, with its two child runs injectable (deploy.cjs passes the real selftest and verify-live; the
 * selftest drives this on a temp copy with stand-ins). Returns { code, result, why } — code 0 applied / nothing to do, 1 failed, undone, or
 * applied and NOT undone ("applied-not-undone": the check after the write failed and the rollback did not go through, so every file is STILL
 * its applied text — never reported as undone), 2 refused. Order: drift -> fences -> the selftest -> applyAll (its own second fence check, backups, atomic writes) -> node --check on each
 * written code file -> verify (exit 1 or anything unexpected: every edit is put back; exit 3 = UNKNOWN lines: applied, to be re-run).
 */
function deployApply({ E = loadEdits(), root = REPO, ms, procList, holidays, runSelftest, runVerify, backups, stateful, backupDir, stateFile, out = console.log } = {}) {
  const files = filesOf(E), P = plan(E, root), drift = P.filter((f) => f.state === "drift");
  if (drift.length) return { code: 2, result: "refused", why: drift.map((f) => driftWhy(f, "is neither base nor applied; read the change, then make-edits.cjs --restage")) };
  if (P.every((f) => f.state === "applied")) return { code: 0, result: "noop", why: ["every edit is already applied"] };
  const fz = fences({ ms, files, procList, holidays }); if (fz.length) return { code: 2, result: "refused", why: fz };
  const st = runSelftest(); if (!st || !st.ok) return { code: 2, result: "refused", why: ["the selftest did not pass:", ...((st && st.lines) || [])] };
  out(`  ${st.last}`);
  const opt = { E, root, ms, procList, holidays, ...(backups === undefined ? {} : { backups }), ...(stateful === undefined ? {} : { stateful }), ...(backupDir ? { backupDir } : {}), ...(stateFile ? { stateFile } : {}) };
  const r = applyAll(opt);
  if (r.result === "refused") return { code: 2, result: "refused", why: r.why };
  if (r.result === "noop") return { code: 0, result: "noop", why: r.why };
  if (r.result !== "applied") return { code: 1, result: "failed", why: r.why, restored: r.restored, notRestored: r.notRestored || [] };
  for (const [rel, f] of Object.entries(r.files)) out(`  written ${rel.padEnd(44)} ${f.before.slice(0, 12)} -> ${f.after.slice(0, 12)}${f.backup ? "   backup " + f.backup : ""}`);
  // the undo is a rollback with the rollback's own fences: it can be REFUSED (a file of the unit started running since the write, or the clock moved into a window) or FAIL. Only "rolled-back" is an undo.
  const undo = (why) => { const b = rollbackAll({ E, root, ms, procList, holidays, recorded: r.files, ...(stateful === undefined ? {} : { stateful }), ...(stateFile ? { stateFile } : {}) }); return { code: 1, result: b.result === "rolled-back" ? "undone" : "applied-not-undone", why: [why], rollback: b.result, rollbackWhy: b.why || [], rollbackRestored: b.restored, rollbackNotRestored: b.notRestored || [], files: r.files }; };
  for (const rel of Object.keys(r.files).filter(isCode)) { const c = cp.spawnSync(process.execPath, ["--check", path.join(root, rel)], { encoding: "utf8", windowsHide: true }); if (c.status !== 0) return undo(`node --check ${rel}: ${String(c.stderr).trim().split("\n")[0]}`); }
  const v = runVerify(); if (v && v.text) out(v.text);
  if (!v || (v.status !== 0 && v.status !== 3)) return undo(`verify-live.cjs ended ${v && v.status === 1 ? "with a FAIL" : "abnormally (exit " + (v && v.status) + ")"}`);
  return { code: 0, result: "applied", files: r.files, verify: v.status === 0 ? "pass" : "unknowns" };
}
/**
 * What deploy.cjs prints when the check after the write failed and the undo did NOT go through (pure; `res` = deployApply's
 * "applied-not-undone" answer, n = how many files were written). The files are then STILL the applied text, with a failed check: it is said
 * in those words, with why the undo was refused and what to run — never "undone", and never "restore by hand" while rollback.cjs can do it.
 */
function notUndoneWords(res, n = Object.keys((res && res.files) || {}).length) {
  const why = ((res && res.why) || []).join("; "), rw = ((res && res.rollbackWhy) || []).join("; ") || "no reason given";
  if (res && res.rollback === "refused") return `APPLIED — VERIFY FAILED — UNDO REFUSED: ${why}\n  the ${n} files are STILL the applied text. The undo was refused: ${rw}\n  Nothing was put back. Run node ${PKG_REL}/rollback.cjs (its plan mode first, then its write mode) once the named process has ended or the window has passed; it puts every file back byte for byte.`;
  return `APPLIED — VERIFY FAILED — UNDO ${String((res && res.rollback) || "failed").toUpperCase()}: ${why}\n  the undo did not go through: ${rw}. ${res && res.rollbackRestored === false ? `NOT RESTORED: ${(res.rollbackNotRestored || []).join(", ")} — compare each with its copy in backups/` : `The ${n} files are STILL the applied text`}\n  Run node ${PKG_REL}/rollback.cjs in its plan mode to see each file's state before anything else.`;
}

// ───────────────────────────────────────────────────────────── temp trees and the overlay ─────────────────────────────────────────────────────────────
/** a temp folder (always under the system temp dir) and its remover */
function tempDir(tag = "t") { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pa-${tag}-`)); return { dir, rm: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } }; }
const put = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
/** copy the unit's files (as they are under `from`) to the same relative paths under `to` */
function copyUnit(to, from = REPO, files = UNIT) { for (const rel of files) put(path.join(to, ...rel.split("/")), fs.readFileSync(path.join(from, ...rel.split("/")))); return to; }
/**
 * The OVERLAY: write `textsByRel` ({ rel: text }) into `dir` and return the environment that makes every node process started with it load
 * (require, readFileSync) those texts in place of the real files REPO/<rel>. Nothing in the repo is written. The preload is copied into
 * `dir` too, so NODE_OPTIONS carries a path under the temp folder.
 */
function overlayEnv(dir, textsByRel, baseEnv = process.env) {
  const map = {}; for (const [rel, text] of Object.entries(textsByRel)) map[path.resolve(REPO, ...rel.split("/")).toLowerCase()] = put(path.join(dir, "overlay", ...rel.split("/")), text);
  const mapFile = put(path.join(dir, "overlay-map.json"), JSON.stringify(map)), pre = put(path.join(dir, "overlay.cjs"), fs.readFileSync(path.join(PKG, "harness", "overlay.cjs")));
  const env = { ...baseEnv, PAUSE_AWARE_OVERLAY: mapFile, NODE_OPTIONS: `--require "${pre.replace(/\\/g, "/")}"` };
  return { env, map, mapFile };
}
/** count the "ok" / "FAIL" case lines of a house selftest's output (one line per case) */
function parseCases(status, stdout, stderr) {
  const out = String(stdout || ""), okNames = [], failNames = [];
  for (const l of out.split(/\r?\n/)) { const m = /^\s*(ok|FAIL)\s+(.*)$/.exec(l); if (m) (m[1] === "ok" ? okNames : failNames).push(m[2]); }
  return { status, out, err: String(stderr || ""), ok: okNames.length, fail: failNames.length, okNames, failNames };
}
/** run `node <args>` and count its case lines */
function runCases(args, { env = process.env, cwd = REPO, timeout = 900000 } = {}) {
  const r = cp.spawnSync(process.execPath, args, { encoding: "utf8", env, cwd, timeout, windowsHide: true, maxBuffer: 256 << 20 });
  return parseCases(r.status, r.stdout, r.stderr);
}
/** run several node commands at the same time (harness/par.cjs): jobs = [{ id, args, env, cwd }] -> { id: parseCases result } */
function runCasesTogether(jobs, dir) {
  const f = put(path.join(dir, `par-${process.pid}-${Date.now()}.json`), JSON.stringify(jobs.map((j) => ({ cwd: REPO, ...j }))));
  const r = cp.spawnSync(process.execPath, [path.join(PKG, "harness", "par.cjs"), f], { encoding: "utf8", cwd: REPO, timeout: 1500000, windowsHide: true, maxBuffer: 512 << 20 });
  const m = /^@@PAR (.*)$/m.exec(String(r.stdout || "")); if (!m) throw new Error(`harness/par.cjs gave no answer (exit ${r.status}): ${String(r.stderr || r.stdout).slice(0, 400)}`);
  return Object.fromEntries(JSON.parse(m[1]).map((x) => [x.id, { ...parseCases(x.status, x.stdout, x.stderr), seconds: x.seconds }]));
}

module.exports = { PKG_NAME, PKG, PKG_REL, REPO, EDITS_FILE, STATE_FILE, BACKUP_DIR, UNIT, TWINS, CHAIN_RUN, FORBIDDEN, sha256, atomic, forbidden, validateEdits, loadEdits, filesOf, editsFor,
  count, at, isInsert, MARK_LEN, marksOf, bothBlocks, marksIn, editState, driftWords, fileState, applyText, revertText, readText, texts, span, editLines, spanWords, plan, twinIssues, writeExact, nodeCheckText, isCode, parts, mtNow, tradingWeekday, procs, busyPatterns, WIN, fences,
  readState, writeState, logRow, applyAll, rollbackAll, rollbackReport, deployApply, notUndoneWords, tempDir, put, copyUnit, overlayEnv, parseCases, runCases, runCasesTogether };
