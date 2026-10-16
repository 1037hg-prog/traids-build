"use strict";
/**
 * PROFIT FIXES A (booking correctness) — the shared machinery of this package. 2026-10-12 (docs/profit-fixes/2026-10-12/a-booking).
 * A module: no side effects on load. deploy.cjs, rollback.cjs, selftest.cjs, verify-live.cjs, settle-expired-twelve.cjs and
 * record-stamp-gate-row.cjs use it.
 *
 * THE EDITS ARE ANCHORED, NEVER WHOLE FILES. staged/<path>.edits holds, for one live file, a list of edits: an ANCHOR (one whole line,
 * or a block of consecutive whole lines) and the lines that replace it. Each anchor must occur EXACTLY ONCE in the live file.
 *   base     every anchor occurs once and no replacement is in the file          -> the edit can be applied
 *   applied  every replacement occurs once (and its anchor only where the replacement itself repeats it) -> it can be reverted
 *   drift    anything else — refused, named, nothing written
 * New lines take the line ending of the line they replace, and before anything is written the engine proves that reverting the patched
 * text gives back the original bytes: that is what makes the rollback byte-exact, and what lets another package edit OTHER lines of the
 * same file (docs/server/wave5-board anchors four lines of backend/zero-dte-sleeve.js) without either reading the other as drift.
 *
 * THE FENCES OF THE APPLY (and of the rollback). Clocks come from node's Intl in America/Denver, never the shell.
 *   1. a trading weekday between 05:30 and 16:00 MT                                  -> refused (the session and its runners)
 *   2. a registry or chain file between 13:50 and 15:50 MT on a trading day          -> refused (the close chain owns that window)
 *   3. a .bat file outside :20-:50 past the hour, unless it is 18:00 MT or later     -> refused (the house rule for .bat files)
 *   4. a process that runs a file being edited (or the launcher of one) is running   -> refused; an unreadable process list refuses too
 *   5. backend/options-settle.js while any of the twelve expired spreads is still open on the board -> refused: the one-time settle
 *      (settle-expired-twelve.cjs) goes first, so the nightly settle never books them on a dividend-adjusted close and without a record
 *   6. THE PROCESS LIST IS NOT TRUSTED TO SHOW THE CLOSE CHAIN (review of 2026-10-12). On this machine a process the Task Scheduler
 *      launched shows NO command line to an ordinary session (the board server, and so the close chain too), so fence 4 cannot see it.
 *      The second signal is the chain's own record, backend/data/chain-status.json, which it writes once, at its end:
 *        - a file the close chain runs, and the data files it writes: refused until that record shows the chain of the most recent
 *          session finished (after 16:00 MT on a trading day that is TODAY's chain), whatever the process list shows
 *        - any other file that has a runner: refused when a node / cmd process shows no command line, unless that record shows the same
 *      A record that is missing, unreadable, without a finish time, or dated after this machine's clock is no signal: refused.
 * A day the calendar cannot classify is treated as a trading day. Nothing here starts, stops or signals a process, restarts a server,
 * places an order or sends a message. automation/close-chain.cjs is never loaded (this package does not edit it).
 */
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto"), cp = require("child_process");
const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", "..", "..");
const PKG_NAME = "profit-fixes-a-booking-2026-10-12";
const T = require("./twelve.cjs");
const FIXES = ["4.1", "4.2", "4.3", "4.7"];

/**
 * THE FILES THIS PACKAGE EDITS. busy = command-line patterns of the processes that run the file or launch it. needsSettled = the edit
 * waits for the one-time settle of the twelve (fence 5). restart = what must be restarted for the edit to take effect (never done here).
 * afterRestart = what is owed once that restart has happened (printed by the apply; never done here).
 * afterApply = the registry record owed once the file is applied (printed by the apply; this package's deploy writes no registry row).
 */
const ENTRIES = [
  { rel: "backend/proposals-sleeve.js", fixes: ["4.1"], check: "node", what: "a list this sleeve's own interim kill has stopped is no longer booked",
    afterApply: "a change-registry row for fix 4.1 (a list the sleeve's own look has killed is no longer booked), dated today — the main loop's write; the words are in NOTES.md, \"For the registrar\"",
    busy: [/proposals-sleeve\.js/i, /close-chain\.cjs/i, /intraday\.bat/i] },
  { rel: "backend/options-settle.js", fixes: ["4.2", "4.7"], check: "node", needsSettled: true, what: "a voided-and-restored wing and a verified debit vertical settle at expiry (4.2); the official close is recorded beside (4.7)",
    afterApply: "a change-registry row for the NEW rule that settles a board debit spread at its expiry every night, breaksComparability true from today — the main loop's write; the words are in NOTES.md, \"For the registrar\"",
    busy: [/options-settle\.js/i, /close-chain\.cjs/i] },
  { rel: "backend/lib/enforcement-gates.js", fixes: ["4.3"], check: "node", restart: "the board server (:3001) — the operator's restart, outside 06:45-14:15 MT; until then the running server keeps the gate it loaded", what: "an equity ticket that R49 and R53 let through is refused when its spread stamp is missing, empty, unparseable or stale (its own veto label; the two registered gates are asked first)",
    afterRestart: "the change-registry row of fix 4.3 is dated at that restart and is written after it: node docs/profit-fixes/2026-10-12/a-booking/record-stamp-gate-row.cjs --restarted YYYY-MM-DD (dry), then with its apply flag",
    busy: [] },
  { rel: "automation/daily-run.cjs", fixes: ["4.3"], check: "node", what: "the entry run prints how many tickets the stamp gate refused, and how many went through live with no stamp",
    busy: [/daily-run\.cjs/i, /daily-open\.bat/i, /daily-close\.bat/i] },
  { rel: "backend/options-sleeve.js", fixes: ["4.7"], check: "node", what: "the underlying's price at entry is recorded on every R21 wing (new fields; no gate reads them)",
    busy: [/options-sleeve\.(js|bat)/i] },
  { rel: "backend/zero-dte-sleeve.js", fixes: ["4.7"], check: "node", what: "the underlying's price at entry is recorded on every R25 wing (new fields; no gate reads them)",
    busy: [/zero-dte-sleeve\.(js|bat)/i] },
  { rel: "backend/wing-loss-cap.js", fixes: ["4.7"], check: "node", what: "an early close of a wing records its exit mid, the raw cross and the four leg quotes (new fields)",
    busy: [/wing-loss-cap\.js/i, /intraday\.bat/i, /board-discipline\.bat/i] },
];
const editsFile = (rel) => path.join(PKG, "staged", ...(rel + ".edits").split("/"));

// ── small helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const flat = (rel) => rel.replace(/[\\/]/g, "__");
const abs = (root, rel) => path.join(root, ...rel.split("/"));
function parts(tz, ms = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hour12: false }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const h = +p.hour % 24;
  return { date: `${p.year}-${p.month}-${p.day}`, dow: p.weekday, mins: h * 60 + +p.minute, hm: `${String(h).padStart(2, "0")}:${p.minute}`, hms: `${String(h).padStart(2, "0")}:${p.minute}:${p.second}` };
}
const mtNow = (ms) => parts("America/Denver", ms), etNow = (ms) => parts("America/New_York", ms);
/** is this calendar date a market holiday? true / false, or null when the house calendar cannot be read */
function houseHoliday(date) {
  try { return !!require(path.join(REPO, "backend", "lib", "run-window.js")).marketHoliday(date); } catch { return null; }
}
/** a trading day unless it is a weekend or a known market holiday; a date the calendar cannot classify IS a trading day (stricter) */
function isTradingDay(p, holiday = houseHoliday) {
  if (p.dow === "Sat" || p.dow === "Sun") return false;
  const h = holiday(p.date);
  return h !== true;
}
function writeJson(file, obj) { require(path.join(REPO, "backend", "lib", "atomic-write.js")).writeJsonAtomic(file, obj); }   // JSON only through the house's atomic writer
function writeBytes(dest, buf, tag = "pfa") { const tmp = `${dest}.${tag}-tmp-${process.pid}`; fs.writeFileSync(tmp, buf); try { fs.renameSync(tmp, dest); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; } }
function nodeCheckText(text, name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pfa-check-")), f = path.join(d, path.basename(name));
  try { fs.writeFileSync(f, text); const r = cp.spawnSync(process.execPath, ["--check", f], { encoding: "utf8", windowsHide: true }); return r.status === 0 ? null : String(r.stderr || "").trim().split("\n").slice(0, 4).join(" | ").slice(0, 300) || "node --check failed"; }
  finally { fs.rmSync(d, { recursive: true, force: true }); }
}
function nodeCheckFile(file) { const r = cp.spawnSync(process.execPath, ["--check", file], { encoding: "utf8", windowsHide: true }); return r.status === 0 ? null : String(r.stderr || "").trim().split("\n").slice(0, 4).join(" | ").slice(0, 300) || "node --check failed"; }

// ── the staged edits (staged/<path>.edits) ───────────────────────────────────────────────────────────────────────────────────
const M_ANCHOR = "=== ANCHOR ===", M_REPLACE = "=== REPLACE WITH ===", M_END = "=== END ===";
/** text of an .edits file -> [{ from: [lines], to: [lines] }]. Lines before the first edit that start with # are notes. */
function parseEdits(text, name = "edits") {
  const ops = []; let cur = null, mode = null;
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], at = `${name}:${i + 1}`;
    if (l === M_ANCHOR) { if (mode) throw new Error(`${at}: an edit starts inside another`); cur = { from: [], to: [] }; mode = "from"; continue; }
    if (l === M_REPLACE) { if (mode !== "from") throw new Error(`${at}: "${M_REPLACE}" without an anchor before it`); mode = "to"; continue; }
    if (l === M_END) { if (mode !== "to") throw new Error(`${at}: "${M_END}" without a replacement before it`); if (!cur.from.length || !cur.to.length) throw new Error(`${at}: an edit with an empty anchor or an empty replacement`); ops.push(cur); cur = null; mode = null; continue; }
    if (mode === "from") cur.from.push(l); else if (mode === "to") cur.to.push(l);
    else if (l.trim() && !l.startsWith("#")) throw new Error(`${at}: text outside an edit`);
  }
  if (mode) throw new Error(`${name}: the last edit is not closed`);
  if (!ops.length) throw new Error(`${name}: no edit in the file`);
  return ops;
}
const _ops = new Map();
function opsOf(entry) { if (!_ops.has(entry.rel)) _ops.set(entry.rel, parseEdits(fs.readFileSync(editsFile(entry.rel), "utf8"), path.basename(editsFile(entry.rel)))); return _ops.get(entry.rel); }

// ── the line engine (pure on text) ───────────────────────────────────────────────────────────────────────────────────────────
/** text -> [[content, eol]] with eol "\r\n" | "\n" | "" (a last line without a newline) */
function splitLines(t) {
  const out = []; let i = 0;
  while (i < t.length) { const j = t.indexOf("\n", i); if (j < 0) { out.push([t.slice(i), ""]); break; } const raw = t.slice(i, j); out.push(raw.endsWith("\r") ? [raw.slice(0, -1), "\r\n"] : [raw, "\n"]); i = j + 1; }
  return out;
}
const joinLines = (L) => L.map(([c, e]) => c + e).join("");
/** start indexes of `block` (line contents) as consecutive whole lines of L */
function findBlock(L, block) { const hits = []; for (let i = 0; i + block.length <= L.length; i++) { let k = 0; while (k < block.length && L[i + k][0] === block[k]) k++; if (k === block.length) hits.push(i); } return hits; }
/**
 * One edit against a text: "applied", "base", or the reason it is neither. An edit that keeps its anchor line and adds lines beside it
 * would read as base again if only the block as a whole were looked for and one added line had been changed by hand; so base also
 * requires that NONE of the replacement's own lines (those not in the anchor, 25 characters or longer) is in the file.
 */
function opState(op, L) {
  const nf = findBlock(L, op.from).length, nt = findBlock(L, op.to).length, inTo = findBlock(op.to.map((c) => [c, ""]), op.from).length;
  if (nt === 1 && nf === inTo) return "applied";
  const own = op.to.filter((l) => !op.from.includes(l) && l.trim().length >= 25), have = new Set(L.map(([c]) => c)), left = own.filter((l) => have.has(l)).length;
  if (nf === 1 && nt === 0 && left === 0) return "base";
  const anchor = `anchor ${JSON.stringify(op.from[0].slice(0, 70))}${op.from.length > 1 ? ` (+${op.from.length - 1} more line(s))` : ""} found ${nf}x`;
  return nt === 0 && left ? `${anchor}; its replacement is only partly there (${left} of its ${own.length} own lines found, the block as a whole 0x) — changed by hand after an apply` : `${anchor}, its replacement ${nt}x`;
}
function textState(ops, t, rel = "file") {
  const L = splitLines(t), st = ops.map((op) => opState(op, L));
  if (st.every((s) => s === "base")) return { state: "base" };
  if (st.every((s) => s === "applied")) return { state: "applied" };
  const odd = st.map((s, i) => (s === "base" || s === "applied" ? null : `edit ${i + 1}: ${s}`)).filter(Boolean);
  return { state: "drift", why: `${rel}: ${odd.slice(0, 4).join("; ") || `partly applied (${st.filter((s) => s === "applied").length} of ${st.length} edits in)`}` };
}
function applyText(ops, t, rel = "file") {
  const L = splitLines(t);
  for (const op of ops) {
    const h = findBlock(L, op.from); if (h.length !== 1) throw new Error(`${rel}: anchor not found exactly once (${h.length}x): ${JSON.stringify(op.from[0].slice(0, 80))}`);
    const first = L[h[0]][1], last = L[h[0] + op.from.length - 1][1];
    L.splice(h[0], op.from.length, ...op.to.map((c, k) => [c, k === op.to.length - 1 ? last : first || "\n"]));
  }
  return joinLines(L);
}
function revertText(ops, t, rel = "file") {
  const L = splitLines(t);
  for (const op of [...ops].reverse()) {
    const h = findBlock(L, op.to); if (h.length !== 1) throw new Error(`${rel}: replacement not found exactly once (${h.length}x): ${JSON.stringify(op.to[0].slice(0, 80))}`);
    const first = L[h[0]][1], last = L[h[0] + op.to.length - 1][1];
    L.splice(h[0], op.to.length, ...op.from.map((c, k) => [c, k === op.from.length - 1 ? last : first || "\n"]));
  }
  return joinLines(L);
}
/** a live file read strictly: bytes, text, and proof that the text is those bytes (a file that is not clean UTF-8 is never edited) */
function readStrict(file) {
  const buf = fs.readFileSync(file), text = buf.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buf)) throw new Error(`${path.basename(file)} is not clean UTF-8 — it is not edited`);
  return { buf, text, sha: sha256(buf) };
}
/** the state of one entry under a root: { state, why?, sha, text } */
function stateOf(entry, root = REPO) {
  const f = abs(root, entry.rel);
  if (!fs.existsSync(f)) return { state: "drift", why: `${entry.rel} is missing` };
  let r; try { r = readStrict(f); } catch (e) { return { state: "drift", why: `${entry.rel}: ${e.message}` }; }
  let ops; try { ops = opsOf(entry); } catch (e) { return { state: "drift", why: `${entry.rel}: its staged edits do not load (${e.message})` }; }
  return { ...textState(ops, r.text, entry.rel), sha: r.sha, text: r.text, buf: r.buf };
}
/** the two sides of an entry from whatever state the live file is in: { base, patched } texts (throws on drift) */
function sidesOf(entry, root = REPO) {
  const s = stateOf(entry, root); if (s.state === "drift") throw new Error(s.why);
  const ops = opsOf(entry);
  return s.state === "applied" ? { base: revertText(ops, s.text, entry.rel), patched: s.text, state: s.state } : { base: s.text, patched: applyText(ops, s.text, entry.rel), state: s.state };
}
function selectEntries(only) {
  if (only == null) return ENTRIES.slice();
  const want = [].concat(only).map(String), bad = want.filter((x) => !FIXES.includes(x));
  if (bad.length || !want.length) throw new Error(`--only takes fix numbers from ${FIXES.join(", ")} (got ${JSON.stringify(only)})`);
  return ENTRIES.filter((e) => e.fixes.some((f) => want.includes(f)));
}

// ── the fences ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const isRegistryOrChain = (rel) => /(^|\/)(test-registry\.json|read-seals\.json|change-registry\.json|agent-ledger\.jsonl|close-chain\.cjs)$/i.test(rel);
const isBat = (rel) => /\.bat$/i.test(rel);
/** the time fences for a list of file paths at an instant -> [reasons] */
function windowRefusals(rels, nowMs = Date.now(), { holiday = houseHoliday } = {}) {
  const why = [], mt = mtNow(nowMs), td = isTradingDay(mt, holiday);
  if (td && mt.mins >= 5 * 60 + 30 && mt.mins < 16 * 60) why.push(`${mt.hm} MT on ${mt.dow} ${mt.date} is inside 05:30-16:00 MT on a trading weekday — wait until 16:00 MT, or a weekend or market holiday`);
  const reg = rels.filter(isRegistryOrChain);
  if (reg.length && td && mt.mins >= 13 * 60 + 50 && mt.mins < 15 * 60 + 50) why.push(`${mt.hm} MT is inside 13:50-15:50 MT on a trading day, when the close chain owns the registry and chain files (${reg.join(", ")})`);
  const bat = rels.filter(isBat);
  if (bat.length && !((mt.mins % 60 >= 20 && mt.mins % 60 <= 50) || mt.mins >= 18 * 60)) why.push(`${mt.hm} MT is outside :20-:50 past the hour and before 18:00 MT — .bat files are edited only then (${bat.join(", ")})`);
  return why;
}
/**
 * node / cmd processes with their command lines -> [{ pid, name, cmd }]. Read-only; throws when the list cannot be read or does not hold
 * this process. A process whose command line this session may not read (one the Task Scheduler launched) comes back with cmd "": it is
 * kept and counted, never dropped — see idleRefusals below for what an unreadable row means.
 */
function scanProcs() {
  let rows;
  if (process.platform === "win32") {
    const ps = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='cmd.exe'\" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 2";
    const out = cp.execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 60000, windowsHide: true, maxBuffer: 32 << 20 });
    const j = JSON.parse(String(out || "").trim() || "[]");
    rows = (Array.isArray(j) ? j : [j]).filter(Boolean).map((p) => ({ pid: Number(p.ProcessId), name: String(p.Name || ""), cmd: String(p.CommandLine || "") }));
  } else {
    const out = cp.execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8", timeout: 30000, maxBuffer: 32 << 20 });
    rows = out.split("\n").map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: Number(m[1]), name: path.basename(m[2].split(/\s+/)[0] || ""), cmd: m[2] }));
  }
  if (!rows.some((p) => p.pid === process.pid)) throw new Error("the process list does not contain this process — not trusted");
  return rows.filter((p) => p.pid !== process.pid);
}
const procRows = (procs) => procs.map((p) => (typeof p === "string" ? { pid: null, cmd: p } : { ...p, cmd: String((p && p.cmd) || "") }));
const unreadableRow = (p) => !p.cmd.trim();
/** how many rows a process list holds, and how many of them show no command line -> { total, unreadable } | { error } */
function procCount(procs) {
  if (!Array.isArray(procs)) return { error: procs && procs.error ? String(procs.error).slice(0, 100) : "no list" };
  const rows = procRows(procs);
  return { total: rows.length, unreadable: rows.filter(unreadableRow).length };
}
/** the running-process fence -> [reasons]. procs: [{ pid, cmd }] | [cmd strings] | anything else = unreadable (refused). */
function procRefusals(entries, procs) {
  if (!Array.isArray(procs)) return [`the process list could not be read${procs && procs.error ? ` (${String(procs.error).slice(0, 100)})` : ""} — refusing to edit files that may be running`];
  const rows = procRows(procs), why = [];
  for (const e of entries) {
    const hit = rows.filter((p) => (e.busy || []).some((re) => re.test(p.cmd)));
    if (hit.length) why.push(`${e.rel}: a process that runs it (or launches it) is in progress — ${hit.slice(0, 3).map((p) => `${p.pid != null ? "pid " + p.pid + " " : ""}${p.cmd.replace(/\s+/g, " ").slice(0, 110)}`).join(" | ")}`);
  }
  return why;
}

// ── the second signal: the close chain's own record (fence 6) ────────────────────────────────────────────────────────────────
const CHAIN_STATUS_REL = "backend/data/chain-status.json";
const DOWS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/**
 * The session day whose close chain must be on record as finished at an instant (America/Denver): TODAY once today's session window
 * has opened (a trading day, 05:30 MT or later), else the last trading day before today. So at 16:05 MT on a trading day it is today,
 * before dawn it is the previous session, and on a weekend or market holiday it is the last session before it.
 */
function lastSessionDay(nowMs = Date.now(), holiday = houseHoliday) {
  const mt = mtNow(nowMs);
  if (isTradingDay(mt, holiday) && mt.mins >= 5 * 60 + 30) return mt.date;
  let ms = Date.parse(mt.date + "T12:00:00Z");
  for (let i = 0; i < 14; i++) { ms -= 864e5; const d = new Date(ms), p = { date: d.toISOString().slice(0, 10), dow: DOWS[d.getUTCDay()] }; if (isTradingDay(p, holiday)) return p.date; }
  return mt.date;   // fourteen closed days in a row is not a calendar: the strictest answer
}
/**
 * HAS THE CLOSE CHAIN OF THE MOST RECENT SESSION FINISHED? -> { done: true, day, finishedAt, finDay } | { done: false, day, why }.
 * Read from the chain's own record, which it writes once, at its end (automation/close-chain.cjs; the file is never loaded here).
 * Until the chain of `day` has written it, the record still shows an EARLIER finish, and that is "not done": the chain has not run, is
 * still running, or did not reach its end. A record that cannot be read, holds no finish time, or is dated after this machine's clock
 * is no signal either. chain: the parsed record (the selftest passes one); left out, the file under root is read.
 */
function chainDone({ root = REPO, nowMs = Date.now(), holiday = houseHoliday, chain = undefined } = {}) {
  const day = lastSessionDay(nowMs, holiday), what = `the close chain's record (${CHAIN_STATUS_REL})`;
  let c = chain;
  if (c === undefined) { try { c = JSON.parse(fs.readFileSync(abs(root, CHAIN_STATUS_REL), "utf8")); } catch (e) { return { done: false, day, why: `${what} could not be read (${e.code || String(e.message).slice(0, 60)})` }; } }
  const fin = c && typeof c === "object" && typeof c.finished === "string" ? Date.parse(c.finished) : NaN;
  if (!Number.isFinite(fin)) return { done: false, day, why: `${what} holds no readable finish time` };
  if (fin > nowMs) return { done: false, day, why: `${what} says it finished at ${c.finished}, after this machine's clock — not trusted` };
  const finDay = mtNow(fin).date;
  if (finDay < day) return { done: false, day, why: `${what} shows its last finish on ${finDay} at ${mtNow(fin).hm} MT; the chain of ${day} has not recorded a finish (it has not run, is still running, or did not reach its end)` };
  return { done: true, day, finishedAt: c.finished, finDay };
}
const runsInChain = (e) => (e.busy || []).some((re) => re.test("automation\\close-chain.cjs"));
/**
 * FENCE 6 -> [reasons]. What the process list cannot say, asked of the second signal (idle = chainDone(...)):
 *   - a target the close chain runs or writes is refused until the chain of the most recent session is on record as finished, whatever
 *     the process list shows (the chain may not have started yet, or may show no command line);
 *   - any other target that has a runner is refused when the list holds a node / cmd row with no readable command line (UNKNOWN: it
 *     may be that runner), unless the same record shows the day's last job, the close chain, finished.
 * A target nothing runs (busy empty: the gate library, which the board server only loads at its start) is never refused here. An
 * unreadable LIST is procRefusals' refusal, not repeated. No signal given is no signal.
 */
function idleRefusals(targets, procs, idle) {
  if (!Array.isArray(procs)) return [];
  if (idle && idle.done === true) return [];
  const rows = procRows(procs), unread = rows.filter(unreadableRow).length, why = [];
  const signal = idle && idle.why ? idle.why : "no second signal was given";
  for (const e of targets) {
    if (!(e.busy || []).length) continue;
    if (runsInChain(e)) why.push(`${e.rel}: the close chain runs or writes it, and ${signal} — refused until that record shows the chain of ${(idle && idle.day) || "the most recent session"} finished (the process list is not what proves it: a process the Task Scheduler launched shows no command line here)`);
    else if (unread) why.push(`${e.rel}: ${unread} of ${rows.length} node/cmd process(es) show no command line to this session (scheduler-launched), so the process list cannot show that nothing is running it; the second signal is missing too: ${signal}`);
  }
  return why;
}
/** which of the twelve are still open on the board of a root -> { open: [ids] } | { unknown: why } */
function twelveOpen(root = REPO) {
  try { const b = JSON.parse(fs.readFileSync(abs(root, "backend/data/board_positions.json"), "utf8")); if (!Array.isArray(b)) return { unknown: "board_positions.json is not an array" }; const have = new Set(b.map((p) => p && p.id)); return { open: T.IDS.filter((id) => have.has(id)) }; }
  catch (e) { return { unknown: `board_positions.json could not be read (${e.code || String(e.message).slice(0, 60)})` }; }
}
/**
 * every fence for a set of entries -> { why: [reasons] ([] = clear), procs: { total, unreadable } | { error }, idle: chainDone(...) }.
 * procs and chain are read here (the process list, the chain's record under root) unless the selftest passes them.
 */
function fenceReport(entries, { root = REPO, nowMs = Date.now(), procs = undefined, holiday = houseHoliday, settledCheck = true, chain = undefined } = {}) {
  const why = windowRefusals(entries.map((e) => e.rel), nowMs, { holiday });
  let P = procs; if (P === undefined) { try { P = scanProcs(); } catch (e) { P = { error: e.message }; } }
  const idle = chainDone({ root, nowMs, holiday, chain });
  why.push(...procRefusals(entries, P), ...idleRefusals(entries, P, idle));
  if (settledCheck && entries.some((e) => e.needsSettled)) {
    const t = twelveOpen(root);
    if (t.unknown) why.push(`backend/options-settle.js: cannot tell whether the twelve expired spreads are settled (${t.unknown}) — refused`);
    else if (t.open.length) why.push(`backend/options-settle.js: ${t.open.length} of the twelve expired spreads are still open on the board — run the one-time settle first (node docs/profit-fixes/2026-10-12/a-booking/settle-expired-twelve.cjs, dry, then with its apply flag), so the nightly settle never books them on a dividend-adjusted close and without a record. To apply the other files now, name their fixes with --only`);
  }
  return { why, procs: procCount(P), idle };
}
const fences = (entries, opts) => fenceReport(entries, opts).why;
/** the two lines a plan prints about what the fences could see: the process list (how many rows it could not read) and the chain's record */
function fenceLines(fr) {
  return [
    fr.procs.error ? `  process list: could not be read (${fr.procs.error})` : `  process list: ${fr.procs.total} node/cmd process(es), ${fr.procs.unreadable} of them with a command line this session cannot read${fr.procs.unreadable ? " (scheduler-launched: the list cannot show what they run, so the close chain's own record decides)" : ""}`,
    `  the close chain, from its own record (${CHAIN_STATUS_REL}): ${fr.idle.done ? `the chain of ${fr.idle.day} is on record as finished (${fr.idle.finishedAt}, ${mtNow(Date.parse(fr.idle.finishedAt)).hm} MT on ${fr.idle.finDay})` : `NOT on record as finished for ${fr.idle.day} — ${fr.idle.why}`}`,
  ];
}

// ── deploy and rollback (against a root; the command-line tools pass no root, clock or process list — only the selftest does) ─
const stampOf = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
function readState(stateDir) { try { const j = JSON.parse(fs.readFileSync(path.join(stateDir, "deploy-state.json"), "utf8")); return j && typeof j === "object" ? j : null; } catch { return null; } }
function logRow(stateDir, row) { try { fs.appendFileSync(path.join(stateDir, "deploy-log.jsonl"), JSON.stringify({ at: new Date().toISOString(), mt: mtNow().hms, ...row }) + "\n"); } catch {} }

/**
 * deploy({ mode: "plan" | "apply", only }) -> { exit, status, lines }. exit 0 = done / nothing to do / plan printed; 2 = refused, nothing
 * changed; 1 = a write failed and every written file was put back (said if not).
 */
function deploy({ root = REPO, stateDir = PKG, mode = "plan", only = null, nowMs = undefined, procs = undefined, holiday = houseHoliday, chain = undefined, log = console.log } = {}) {
  const out = [], say = (l) => { out.push(l); log(l); };
  const done = (exit, status) => ({ exit, status, lines: out });
  const refuse = (why) => { say(`REFUSED — nothing changed:`); for (const w of [].concat(why)) say(`  - ${w}`); if (mode === "apply") logRow(stateDir, { script: "deploy", result: "refused", why: [].concat(why) }); return done(2, "refused"); };
  let entries; try { entries = selectEntries(only); } catch (e) { return refuse(e.message); }
  const now = () => (nowMs === undefined ? Date.now() : nowMs);
  // 1. every file's state, and every new text computed and checked before anything is written
  const st = entries.map((e) => ({ e, s: stateOf(e, root) })), drift = st.filter((x) => x.s.state === "drift");
  const plan = [], problems = drift.map((x) => `DRIFT (neither base nor applied): ${x.s.why}`);
  for (const { e, s } of st) {
    if (s.state !== "base") continue;
    try {
      const ops = opsOf(e), next = applyText(ops, s.text, e.rel);
      if (textState(ops, next, e.rel).state !== "applied") throw new Error("the patched text would not read as applied");
      if (revertText(ops, next, e.rel) !== s.text) throw new Error("reverting the patched text does not give back the original bytes");
      const bad = e.check === "node" ? nodeCheckText(next, e.rel) : null; if (bad) throw new Error(`the patched file does not parse (${bad})`);
      plan.push({ e, cur: s.buf, curSha: s.sha, next: Buffer.from(next, "utf8"), ops: ops.length, added: splitLines(next).length - splitLines(s.text).length });
    } catch (x) { problems.push(`${e.rel}: ${x.message}`); }
  }
  say(`${PKG_NAME} — ${mode === "apply" ? "APPLY" : "PLAN (read-only)"} — ${mtNow(now()).hms} MT ${mtNow(now()).dow} ${mtNow(now()).date}${only ? ` — only fix ${[].concat(only).join(", ")}` : ""}`);
  for (const { e, s } of st) {
    const p = plan.find((x) => x.e === e);
    say(`  ${String(s.state).padEnd(8)} ${e.rel.padEnd(34)} fix ${e.fixes.join("+").padEnd(8)} ${s.state === "base" && p ? `${p.ops} anchored edit(s), +${p.added} line(s)` : s.state === "applied" ? "already applied" : s.state === "drift" ? "REFUSED" : "not appliable"} — ${e.what}`);
  }
  if (problems.length) return refuse(problems);
  if (!plan.length) { say("nothing to apply — every selected file is already applied"); return done(0, "noop"); }
  // 2. the fences
  const fr = fenceReport(plan.map((p) => p.e), { root, nowMs: now(), procs, holiday, chain }), fz = fr.why;
  if (mode !== "apply") {
    for (const l of fenceLines(fr)) say(l);
    if (fz.length) { say("an apply NOW would be refused:"); for (const w of fz) say(`  - ${w}`); } else say("an apply NOW would pass the fences (time window, running processes, the close chain's record, the settle-first rule).");
    for (const p of plan) if (p.e.restart) say(`  note: ${p.e.rel} takes effect only after a restart of ${p.e.restart}`);
    say("PLAN ONLY — nothing was written.");
    return done(0, "plan");
  }
  if (fz.length) return refuse(fz);
  // 3. backups (byte-exact, verified), then a late re-check, then the writes
  const stamp = stampOf(now()), bdir = path.join(stateDir, "backups", `${stamp}-apply`);
  fs.mkdirSync(bdir, { recursive: true });
  for (const p of plan) { const b = path.join(bdir, flat(p.e.rel)); fs.writeFileSync(b, p.cur); if (sha256(fs.readFileSync(b)) !== p.curSha) return refuse(`the backup of ${p.e.rel} does not verify`); p.backup = b; }
  const late = [];
  for (const p of plan) { try { if (sha256(fs.readFileSync(abs(root, p.e.rel))) !== p.curSha) late.push(`${p.e.rel} changed while this ran`); } catch (x) { late.push(`${p.e.rel} unreadable (${x.code || x.message})`); } }
  late.push(...fences(plan.map((p) => p.e), { root, nowMs: now(), procs, holiday, chain }));
  if (late.length) return refuse(late);
  const written = []; let fail = null;
  try {
    for (const p of plan) {
      writeBytes(abs(root, p.e.rel), p.next); written.push(p);
      if (sha256(fs.readFileSync(abs(root, p.e.rel))) !== sha256(p.next)) throw new Error(`${p.e.rel} does not verify after the write`);
      const bad = p.e.check === "node" ? nodeCheckFile(abs(root, p.e.rel)) : null; if (bad) throw new Error(`node --check ${p.e.rel}: ${bad}`);
      say(`  wrote    ${p.e.rel}   ${p.curSha.slice(0, 12)} -> ${sha256(p.next).slice(0, 12)}   (pre-apply copy: ${path.relative(stateDir, p.backup).replace(/\\/g, "/")})`);
    }
  } catch (x) { fail = x.message; }
  if (fail) {
    const bad = [];
    for (const p of [...written].reverse()) { try { writeBytes(abs(root, p.e.rel), p.cur); if (sha256(fs.readFileSync(abs(root, p.e.rel))) !== p.curSha) bad.push(p.e.rel); } catch (x) { bad.push(`${p.e.rel} (${x.message})`); } }
    say(`APPLY FAILED: ${fail}`);
    say(bad.length ? `  PUT-BACK INCOMPLETE — restore by hand from ${bdir}: ${bad.join(", ")}` : `  every written file was put back byte for byte (${written.map((p) => p.e.rel).join(", ") || "none written"})`);
    logRow(stateDir, { script: "deploy", result: "failed", why: fail, putBack: !bad.length, problems: bad });
    return done(1, "failed");
  }
  // 4. the record
  const state = readState(stateDir) || { package: PKG_NAME, files: {}, history: [] };
  state.files = state.files || {}; state.history = state.history || [];
  for (const p of plan) state.files[p.e.rel] = { preSha: p.curSha, postSha: sha256(p.next), appliedAt: new Date(now()).toISOString(), backup: path.relative(stateDir, p.backup).replace(/\\/g, "/"), fixes: p.e.fixes };
  state.history.push({ at: new Date(now()).toISOString(), did: "apply", files: plan.map((p) => p.e.rel) });
  try { writeJson(path.join(stateDir, "deploy-state.json"), state); } catch (x) { say(`  WARNING: deploy-state.json could not be written (${x.message}) — the files ARE applied; the rollback still works from the anchors`); }
  logRow(stateDir, { script: "deploy", result: "applied", files: plan.map((p) => ({ rel: p.e.rel, from: p.curSha, to: sha256(p.next) })) });
  say(`APPLIED ${plan.length} file(s). No process was started, stopped or restarted, no order placed, no message sent.`);
  for (const p of plan) if (p.e.restart) say(`  RESTART OWED (the operator's): ${p.e.rel} takes effect only after a restart of ${p.e.restart}`);
  for (const p of plan) if (p.e.afterRestart) say(`  AFTER THAT RESTART: ${p.e.afterRestart}`);
  for (const p of plan) if (p.e.afterApply) say(`  OWED TO THE REGISTRY (this apply writes no registry row): ${p.e.afterApply}`);
  say("  NEXT: node docs/profit-fixes/2026-10-12/a-booking/verify-live.cjs   (read-only), then the re-copy for the server's shadow tree named in NOTES.md.");
  return done(0, "applied");
}

/** rollback({ mode: "plan" | "apply", only }) -> { exit, status, lines }: each applied file's own lines are put back in place, byte-exact. */
function rollback({ root = REPO, stateDir = PKG, mode = "plan", only = null, nowMs = undefined, procs = undefined, holiday = houseHoliday, chain = undefined, log = console.log } = {}) {
  const out = [], say = (l) => { out.push(l); log(l); };
  const done = (exit, status) => ({ exit, status, lines: out });
  const refuse = (why) => { say(`REFUSED — nothing changed:`); for (const w of [].concat(why)) say(`  - ${w}`); if (mode === "apply") logRow(stateDir, { script: "rollback", result: "refused", why: [].concat(why) }); return done(2, "refused"); };
  let entries; try { entries = selectEntries(only).reverse(); } catch (e) { return refuse(e.message); }
  const now = () => (nowMs === undefined ? Date.now() : nowMs);
  const state = readState(stateDir) || { package: PKG_NAME, files: {}, history: [] }, rec = state.files || {};
  const st = entries.map((e) => ({ e, s: stateOf(e, root) })), problems = st.filter((x) => x.s.state === "drift").map((x) => `DRIFT (neither base nor applied — revert it by hand; the pre-apply copy is under backups/): ${x.s.why}`);
  const plan = [];
  for (const { e, s } of st) {
    if (s.state !== "applied") continue;
    try {
      const ops = opsOf(e), back = revertText(ops, s.text, e.rel);
      if (textState(ops, back, e.rel).state !== "base") throw new Error("the reverted text would not read as base");
      if (applyText(ops, back, e.rel) !== s.text) throw new Error("re-applying to the reverted text does not give back the current bytes");
      const bad = e.check === "node" ? nodeCheckText(back, e.rel) : null; if (bad) throw new Error(`the reverted file does not parse (${bad})`);
      const backBuf = Buffer.from(back, "utf8"), r = rec[e.rel] || null, exact = r ? sha256(backBuf) === r.preSha : null;
      if (r && s.sha === r.postSha && !exact) throw new Error("the file is exactly what the apply wrote, yet its revert is not the recorded pre-apply file — refusing");
      plan.push({ e, cur: s.buf, curSha: s.sha, back: backBuf, exact, untouched: r ? s.sha === r.postSha : null });
    } catch (x) { problems.push(`${e.rel}: ${x.message}`); }
  }
  say(`${PKG_NAME} — ROLLBACK ${mode === "apply" ? "(apply)" : "PLAN (read-only)"} — ${mtNow(now()).hms} MT ${mtNow(now()).dow} ${mtNow(now()).date}${only ? ` — only fix ${[].concat(only).join(", ")}` : ""}`);
  for (const { e, s } of st) {
    const p = plan.find((x) => x.e === e);
    say(`  ${String(s.state).padEnd(8)} ${e.rel.padEnd(34)} ${s.state === "applied" && p ? (p.exact === true ? "revert gives back the pre-apply file byte for byte" : p.exact === false ? "our lines are put back in place; the file was also edited elsewhere since the apply, and that edit is kept" : "our lines are put back in place (no apply record here to compare bytes with)") : s.state === "base" ? "nothing to undo" : "REFUSED"}`);
  }
  if (problems.length) return refuse(problems);
  if (!plan.length) { say("nothing to roll back — no selected file is applied"); return done(0, "noop"); }
  const fr = fenceReport(plan.map((p) => p.e), { root, nowMs: now(), procs, holiday, chain, settledCheck: false }), fz = fr.why;
  if (mode !== "apply") {
    for (const l of fenceLines(fr)) say(l);
    if (fz.length) { say("a rollback NOW would be refused:"); for (const w of fz) say(`  - ${w}`); } else say("a rollback NOW would pass the fences.");
    say("PLAN ONLY — nothing was written.");
    return done(0, "plan");
  }
  if (fz.length) return refuse(fz);
  const stamp = stampOf(now()), bdir = path.join(stateDir, "backups", `${stamp}-rollback`);
  fs.mkdirSync(bdir, { recursive: true });
  for (const p of plan) { const b = path.join(bdir, flat(p.e.rel)); fs.writeFileSync(b, p.cur); if (sha256(fs.readFileSync(b)) !== p.curSha) return refuse(`the backup of ${p.e.rel} does not verify`); p.backup = b; }
  const late = [];
  for (const p of plan) { try { if (sha256(fs.readFileSync(abs(root, p.e.rel))) !== p.curSha) late.push(`${p.e.rel} changed while this ran`); } catch (x) { late.push(`${p.e.rel} unreadable (${x.code || x.message})`); } }
  if (late.length) return refuse(late);
  const bad = [];
  for (const p of plan) {
    try {
      writeBytes(abs(root, p.e.rel), p.back);
      if (sha256(fs.readFileSync(abs(root, p.e.rel))) !== sha256(p.back)) bad.push(`${p.e.rel}: does not verify after the write`);
      const c = p.e.check === "node" ? nodeCheckFile(abs(root, p.e.rel)) : null; if (c) bad.push(`${p.e.rel}: node --check failed (${c})`);
      say(`  reverted ${p.e.rel}   ${p.curSha.slice(0, 12)} -> ${sha256(p.back).slice(0, 12)}${p.exact === true ? "   (the pre-apply file, byte for byte)" : ""}`);
      delete rec[p.e.rel];
    } catch (x) { bad.push(`${p.e.rel}: ${x.message}`); }
  }
  state.files = rec; state.history = (state.history || []).concat([{ at: new Date(now()).toISOString(), did: "rollback", files: plan.map((p) => p.e.rel), problems: bad }]);
  try { writeJson(path.join(stateDir, "deploy-state.json"), state); } catch {}
  logRow(stateDir, { script: "rollback", result: bad.length ? "problems" : "rolled-back", files: plan.map((p) => p.e.rel), problems: bad });
  if (bad.length) { say("ROLLBACK PROBLEMS:"); for (const b of bad) say(`  - ${b}`); say(`  the copies taken just before this rollback are in ${bdir}`); return done(1, "problems"); }
  say(`ROLLED BACK ${plan.length} file(s). Not undone, by design: the one-time settle of the twelve spreads (data, with its own record), tickets already refused or recorded, and the new fields already written on rows and stores (see NOTES.md).`);
  return done(0, "rolled-back");
}

module.exports = { PKG, REPO, PKG_NAME, FIXES, ENTRIES, T, editsFile, sha256, flat, abs, parts, mtNow, etNow, houseHoliday, isTradingDay, writeJson, writeBytes, nodeCheckText, nodeCheckFile,
  parseEdits, opsOf, splitLines, joinLines, findBlock, opState, textState, applyText, revertText, readStrict, stateOf, sidesOf, selectEntries,
  isRegistryOrChain, isBat, windowRefusals, scanProcs, procCount, procRefusals, CHAIN_STATUS_REL, lastSessionDay, chainDone, idleRefusals, twelveOpen, fenceReport, fences, fenceLines, deploy, rollback, readState };
