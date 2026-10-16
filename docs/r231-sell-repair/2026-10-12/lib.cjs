"use strict";
/**
 * R231 SELL REPAIR, 2026-10-12 (operator: "repair") — shared library of make-edits / deploy / rollback / restate / evidence / selftest /
 * verify-live. A module: nothing happens on load. Clocks come from node's Intl (America/Denver), never the shell. The edit engine, the apply,
 * the rollback and the overlay are those of docs/pause-switches/2026-10-12/lib.cjs; the fences are new (see FENCES).
 *
 *   UNIT     ONE file: backend/r231-crypto-vote-sized-forward.js. The sleeve package (docs/server/wave3-sleeves) keeps no staged copy of it;
 *            it copies the live file to the server and records its sha256 (its deploy-state.json, steps.copy), so after the apply the
 *            server's two copies are stale until that package's copy step is run again (NOTES.md, the operator's command).
 *   EDITS    the staged change is a list of ANCHORED whole-line REPLACEMENTS (edits.json, written by make-edits.cjs from today's file). Per
 *            edit, against the file's text: "base" = the old block is there exactly once and the new block nowhere; "applied" = the new block
 *            exactly once and the old block nowhere; anything else is DRIFT and nothing is written. No new block holds its old block, so the
 *            two blocks alone tell every state apart. Apply and revert are exact inverses on the bytes.
 *   FENCES   the write modes (deploy --apply, rollback --apply, restate --apply) refuse
 *              · on a trading weekday 05:30-16:00 MT, and on any day inside 13:50-15:50 MT (the close chain's window);
 *              · while the close chain is NOT ON RECORD AS FINISHED for the last session (backend/data/chain-status.json: started at or after
 *                that session's close, and finished) — a chain that is running, or never ran, is a refusal;
 *              · while the runner is RUNNING, judged by what a process actually LOADS: a node process whose SCRIPT is the runner, the close
 *                chain (it runs the runner as a step) or the sleeve package's deploy.cjs (it copies the runner to the server); a node -e whose
 *                code require()s one of them; a cmd.exe whose COMMAND is automation\daily-close.bat. Words in a command line are never a
 *                match: a reminder whose text merely names one of these files, or this package's own deploy command, is not "running".
 *              · when the process list cannot be read.
 *   FEES     feeOfBuy / splitFee / restatePlan: the reading of the broker's CFEE rows shared by restate.cjs and the selftest. feeOfBuy is the
 *            same function, word for word in what it decides, as the one staged into the runner (the selftest runs both on the same rows).
 *            It reads rows BY TIME (created_at near the fill) and, only when a coin's rows carry a date and no time, BY DATE (the rows of the
 *            fill's day, when no other buy of the coin is on the account's files that day). restatePlan keeps, per buy, the broker's rows
 *            the fee came from (id, time or date, quantity): restate.cjs writes them on the order rows and names its source on every record.
 *            openBuys: which buys a restate may still take a fee off for — never one already counted net, never one before its coin's last
 *            flat (its fee went with that close). restate.cjs and verify-live.cjs both read the state through it.
 */
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto"), cp = require("child_process");
const PKG_NAME = "r231-sell-repair-2026-10-12", PKG = __dirname, REPO = path.resolve(PKG, "..", "..", "..");
const EDITS_FILE = path.join(PKG, "edits.json"), STATE_FILE = path.join(PKG, "deploy-state.json"), BACKUP_DIR = path.join(PKG, "backups");
const PKG_REL = path.relative(REPO, PKG).replace(/\\/g, "/");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const atomic = () => require(path.join(REPO, "backend", "lib", "atomic-write.js"));

// ───────────────────────────────────────────────────────────── the unit ─────────────────────────────────────────────────────────────
const R231 = "backend/r231-crypto-vote-sized-forward.js";
/** the file of the unit (edits.json may name this and no other) */
const UNIT = [R231];
/** files this package may never edit, whatever edits.json says */
const FORBIDDEN = [/(^|\/)\.env/i, /LIVE-ARMED/i, /^backend\/marks-live-watcher\.js$/, /^backend\/data\//, /(^|\/)node_modules\//, /^automation\/close-chain\.cjs$/, /(^|\/)marks-|(^|\/)cl-/, /-OFF$|-HALT(\.json)?$|TRAIDS_STOP$/, /\.json$/, /\.bat$/i, /^backend\/r191-/];
const forbidden = (rel) => FORBIDDEN.some((re) => re.test(rel));
/** the rules every edit list must meet (loadEdits and make-edits.cjs both go through it) */
function validateEdits(E) {
  if (!E || !Array.isArray(E.edits) || !E.edits.length) throw new Error("edits.json holds no edits");
  for (const e of E.edits) {
    if (!e.id || !e.file || typeof e.old !== "string" || typeof e.new !== "string") throw new Error(`edit ${e.id || "?"}: needs id, file, old, new`);
    if (forbidden(e.file)) throw new Error(`edit ${e.id}: ${e.file} is a file this package may never edit`);
    if (!UNIT.includes(e.file)) throw new Error(`edit ${e.id}: ${e.file} is not a file of this unit`);
    if (!e.old.endsWith("\n") || !e.new.endsWith("\n") || e.old === e.new || !e.old.trim() || !e.new.trim()) throw new Error(`edit ${e.id}: old and new must be different whole-line blocks`);
    if (e.old.includes("\r") || e.new.includes("\r")) throw new Error(`edit ${e.id}: blocks are LF text`);
    if (count(e.new, e.old) > 0 || count(e.old, e.new) > 0) throw new Error(`edit ${e.id}: one block sits inside the other — "base" and "applied" could not be told apart (this unit takes replacements only)`);
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
function editState(text, e) {
  const nNew = count(text, e.new), nOld = count(text, e.old);
  if (nNew === 1 && nOld === 0) return "applied";
  if (nNew === 0 && nOld === 1) return "base";
  return "drift";
}
/** why an edit reads drift, in words (for the plan and the refusals) */
function driftWords(text, e) {
  const nNew = count(text, e.new), nOld = count(text, e.old);
  if (nNew > 1) return `its new block is in the file ${nNew} times`;
  if (nNew === 1) return `its new block is there and so is its old block (${nOld} time${nOld === 1 ? "" : "s"})`;
  if (nOld > 1) return `its anchor is in the file ${nOld} times`;
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
    const { text, sha } = readText(path.join(root, ...rel.split("/"))), ed = editsFor(E, rel), st = fileState(text, ed);
    if (st.state === "drift") throw new Error(`${rel}: DRIFT on ${st.states.filter((x) => x.state === "drift").map((x) => x.id).join(", ")}`);
    out[rel] = { live: text, liveSha: sha, state: st.state, base: revertText(text, ed), staged: applyText(text, ed) };
  }
  return out;
}
function plan(E, root = REPO) {
  return filesOf(E).map((rel) => {
    const file = path.join(root, ...rel.split("/"));
    if (!fs.existsSync(file)) return { rel, missing: true, state: "drift", states: [], problem: "file missing" };
    try { const { text, sha } = readText(file), st = fileState(text, editsFor(E, rel)); return { rel, sha, bytes: Buffer.byteLength(text), ...st }; }
    catch (e) { return { rel, state: "drift", states: [], problem: e.message }; }
  });
}
const writeExact = (dest, buf) => { const tmp = `${dest}.rsr-tmp-${process.pid}`; const fd = fs.openSync(tmp, "w"); try { fs.writeFileSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } try { fs.renameSync(tmp, dest); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; } };
function nodeCheckText(text, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rsr-check-")), f = path.join(dir, path.basename(name).replace(/\.js$/, ".cjs"));   // .cjs: a .js in a temp folder must not depend on a package.json above it
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
/** is the MT calendar date `date` (YYYY-MM-DD) a trading weekday: Mon-Fri and not a full market holiday (backend/lib/run-window.js). A holiday
 *  table that cannot be read counts as a trading day (the stricter reading). `holidays`: a table { date: name }, or a LOADER (date) => truthy
 *  on a holiday, which may throw as the house table's own loader may; left out, the house table is loaded here, inside the same try. */
function tradingDate(date, holidays) {
  const dow = new Date(date + "T12:00:00Z").getUTCDay(); if (dow === 0 || dow === 6) return false;
  if (holidays && typeof holidays !== "function") return !holidays[date];
  const loader = holidays || ((d) => require(path.join(REPO, "backend", "lib", "run-window.js")).marketHoliday(d));
  try { return !loader(date); } catch { return true; }
}
const tradingWeekday = (ms = Date.now(), holidays) => tradingDate(mtNow(ms).date, holidays);
const WIN = { applyFrom: 5 * 60 + 30, applyTo: 16 * 60, chainFrom: 13 * 60 + 50, chainTo: 15 * 60 + 50, sessionClose: 14 * 60 };
/** the instant of `hh:mm` MT on the MT calendar date `date` (DST-safe: found by reading the zone's own clock) */
function mtInstant(date, mins) {
  let ms = Date.parse(`${date}T00:00:00Z`) + (mins + 7 * 60) * 60000;                       // a first guess at UTC-7
  for (let i = 0; i < 3; i++) { const p = mtNow(ms), dDays = Math.round((Date.parse(p.date + "T00:00:00Z") - Date.parse(date + "T00:00:00Z")) / 864e5); const off = dDays * 1440 + p.mins - mins; if (!off) break; ms -= off * 60000; }
  return ms;
}
/** the LAST SESSION as of `ms`: the latest trading weekday whose close (14:00 MT = 16:00 ET) is at or before `ms` -> { date, closeMs } */
function lastSession(ms = Date.now(), holidays) {
  let d = mtNow(ms).date;
  for (let i = 0; i < 12; i++) { if (tradingDate(d, holidays)) { const closeMs = mtInstant(d, WIN.sessionClose); if (closeMs <= ms) return { date: d, closeMs }; } d = new Date(Date.parse(d + "T12:00:00Z") - 864e5).toISOString().slice(0, 10); }
  throw new Error("no trading session found in the last 12 days");
}
/**
 * Is the close chain ON RECORD AS FINISHED for the last session? The chain writes backend/data/chain-status.json ONCE, when it ends
 * ({ started, finished, ... }); while it runs, the file still holds the night before. null = yes; else the reason. `chain`: the record itself
 * (the selftest), or left out to read the real file. Anything unreadable is a refusal.
 */
function chainWhy({ ms = Date.now(), holidays, chain, root = REPO } = {}) {
  let rec = chain, S;
  try { S = lastSession(ms, holidays); } catch (e) { return `the last session could not be worked out (${e.message})`; }
  if (rec === undefined) { try { rec = JSON.parse(fs.readFileSync(path.join(root, "backend", "data", "chain-status.json"), "utf8")); } catch (e) { return `the close chain's record (backend/data/chain-status.json) cannot be read (${String(e.code || e.message).slice(0, 80)}) — it is not on record as finished for the session of ${S.date}`; } }
  const st = Date.parse(rec && rec.started), fin = Date.parse(rec && rec.finished);
  if (!Number.isFinite(st) || !Number.isFinite(fin)) return `the close chain's record has no ${Number.isFinite(st) ? "finish" : "start"} time — it is not on record as finished for the session of ${S.date}`;
  if (st < S.closeMs) return `the close chain is not on record as finished for the last session (${S.date}): its record is of a run started ${new Date(st).toISOString()} (${mtNow(st).date} ${mtNow(st).hms} MT), before that session's close — tonight's chain has not run, or is running now`;
  if (fin < st) return `the close chain's record ends (${rec.finished}) before it starts (${rec.started}) — not trusted`;
  if (fin > ms + 60000) return `the close chain's record is finished in the future (${rec.finished}) — not trusted`;
  return null;
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
/** a Windows command line -> its arguments (the CommandLineToArgvW rules: quotes group, 2n backslashes before a quote are n, 2n+1 are n and a literal quote) */
function argvOf(cmd) {
  const out = []; let cur = "", inQ = false, has = false; const s = String(cmd || "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") { let n = 0; while (s[i] === "\\") { n++; i++; } if (s[i] === '"') { cur += "\\".repeat(Math.floor(n / 2)); if (n % 2) { cur += '"'; } else { inQ = !inQ; } has = true; } else { cur += "\\".repeat(n); has = true; i--; } continue; }
    if (ch === '"') { inQ = !inQ; has = true; continue; }
    if (!inQ && (ch === " " || ch === "\t")) { if (has) { out.push(cur); cur = ""; has = false; } continue; }
    cur += ch; has = true;
  }
  if (has) out.push(cur);
  return out;
}
const NODE_OPT_WITH_VALUE = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "--env-file", "--env-file-if-exists", "-C", "--conditions", "--title", "--input-type", "--inspect-port", "--watch-path", "--stack-trace-limit", "--secure-heap", "--secure-heap-min", "--diagnostic-dir", "--redirect-warnings", "--icu-data-dir", "--openssl-config", "--report-dir", "--report-filename", "--report-signal", "--max-http-header-size", "--unhandled-rejections", "--dns-result-order", "--cpu-prof-dir", "--cpu-prof-name", "--heap-prof-dir", "--heap-prof-name", "--test-name-pattern", "--test-reporter", "--test-reporter-destination", "--disable-warning", "--experimental-default-type"]);
/** what a node command line LOADS -> { script } (its main file), { evalText } (-e / -p code), or { nothing: why } (--check, a REPL, --version ...) */
function nodeLoads(cmd) {
  const a = argvOf(cmd).slice(1);
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (x === "--") return a[i + 1] ? { script: a[i + 1] } : { nothing: "no script" };
    if (x === "-e" || x === "--eval" || x === "-p" || x === "--print" || x === "-pe") return { evalText: a[i + 1] || "" };
    if (/^--(eval|print)=/.test(x)) return { evalText: x.slice(x.indexOf("=") + 1) };
    if (x === "-c" || x === "--check") return { nothing: "a syntax check loads no code to run" };
    if (x === "-v" || x === "--version" || x === "-h" || x === "--help" || x === "-i" || x === "--interactive") return { nothing: x };
    if (x.startsWith("-")) { if (NODE_OPT_WITH_VALUE.has(x)) i++; continue; }
    return { script: x };
  }
  return { nothing: "no script" };
}
const slash = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+/g, "/");
/** the files whose being LOADED by a running process means "the runner is running": the runner; the close chain (it runs the runner as a
 *  step); the sleeve package's deploy.cjs (its copy step sends the runner's bytes to the server). Repo-relative. */
const RUNS_THE_RUNNER = [R231, "automation/close-chain.cjs", "docs/server/wave3-sleeves/deploy.cjs"];
/** is `p` (a path as a process was given it: absolute, or relative to a folder we cannot see) one of RUNS_THE_RUNNER in THIS repo? An absolute
 *  path must be this repo's file; a relative one is taken as this repo's (a process's folder cannot be read, and the stricter reading refuses). */
function repoFileOf(p, root = REPO) {
  const s = slash(p), abs = /^[a-zA-Z]:\//.test(s) || s.startsWith("/");
  for (const rel of RUNS_THE_RUNNER) {
    if (abs) { if (slash(path.resolve(s)).toLowerCase() === slash(path.resolve(root, ...rel.split("/"))).toLowerCase()) return rel; }
    else { const t = s.replace(/^(\.\/)+/, "").toLowerCase(); if (t === rel.toLowerCase() || t.endsWith("/" + rel.toLowerCase())) return rel; }
  }
  return null;
}
/** the command a cmd.exe was started to run: the text after /c or /k, outer quotes off; "" when it has none */
function cmdCommand(cmd) {
  const m = /\s\/[ckCK]\s+(.*)$/.exec(" " + String(cmd || "")); if (!m) return "";
  let r = m[1].trim();
  if (r.startsWith('""')) r = r.slice(1, r.endsWith('"') ? -1 : undefined).trim();                         // cmd /c ""C:\a b\x.bat" args": cmd drops the outer pair
  else if (r.length > 1 && r.startsWith('"') && r.indexOf('"', 1) === r.length - 1) r = r.slice(1, -1).trim();   // cmd /c "one command line": the same
  return r;
}
/** the batch file a cmd.exe RUNS (its command itself, not a word after it): null when its command is anything else */
function cmdBatch(cmd) {
  let r = cmdCommand(cmd); if (!r) return null;
  r = r.replace(/^call\s+/i, "");
  const m = r.startsWith('"') ? /^"([^"]+\.(?:bat|cmd))"/i.exec(r) : /^([^&|<>"]*?\.(?:bat|cmd))(?=$|[\s&|<>"])/i.exec(r);
  return m ? slash(m[1]).trim() : null;
}
/** why a process counts as "the runner is running", or null. Judged by what it LOADS, never by a word in its command line. */
function busyWhy(p, root = REPO) {
  if (p.name === "node.exe") {
    const L = nodeLoads(p.cmd);
    if (L.script) { const rel = repoFileOf(L.script, root); return rel ? `its script is ${rel}` : null; }
    if (L.evalText != null) { for (const m of String(L.evalText).matchAll(/\b(?:require|import)\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g)) { const rel = repoFileOf(m[2], root); if (rel) return `its code loads ${rel}`; } return null; }
    return null;
  }
  if (p.name === "cmd.exe") { const b = cmdBatch(p.cmd); return b && /(^|\/)daily-close\.bat$/i.test(b) ? "it runs automation/daily-close.bat (the close chain's launcher)" : null; }
  return null;
}
/** [] when a write may go ahead, else the reasons. `ms`, `procList`, `holidays` and `chain` are injectable (the selftest); by default the real ones are read. */
function fences({ ms = Date.now(), procList, self = process.pid, holidays, chain, root = REPO } = {}) {
  const why = [], mt = mtNow(ms), td = tradingWeekday(ms, holidays);
  if (td && mt.mins >= WIN.applyFrom && mt.mins < WIN.applyTo) why.push(`${mt.hms} MT ${mt.dow} ${mt.date} is inside 05:30-16:00 MT on a trading weekday (the close chain runs the runner from 14:15 MT) — apply after 16:00 MT or before 05:30 MT`);
  if (mt.mins >= WIN.chainFrom && mt.mins < WIN.chainTo) why.push(`${mt.hms} MT is inside 13:50-15:50 MT — the close chain's window, refused on any day`);
  { const c = chainWhy({ ms, holidays, chain, root }); if (c) why.push(c); }
  try {
    const list = typeof procList === "function" ? procList() : procList || procs();
    const hit = list.filter((p) => p.pid !== self).map((p) => [p, busyWhy(p, root)]).filter(([, w]) => w);
    if (hit.length) why.push(`the runner is running, or a script that runs it: ${hit.map(([p, w]) => `pid ${p.pid} (${w}) ${p.cmd.replace(/\s+/g, " ").slice(0, 110)}`).join(" | ")}`);
  } catch (e) { why.push(`the process list cannot be read (${String(e.message).slice(0, 120)}) — refusing to replace a file that may be running`); }
  return why;
}

// ───────────────────────────────────────────────────────── apply / rollback ─────────────────────────────────────────────────────────
function readState(file = STATE_FILE) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { package: PKG_NAME, log: [] }; } }
function writeState(st, file = STATE_FILE) { st.log = (st.log || []).slice(-200); atomic().writeJsonAtomic(file, st); }
function logRow(row, { stateFile = STATE_FILE } = {}) { try { const st = readState(stateFile); (st.log = st.log || []).push({ at: new Date().toISOString(), mt: mtNow().hms, ...row }); writeState(st, stateFile); } catch (e) { console.error(`deploy-state.json could not be written: ${e.message}`); } }
const driftWhy = (f, tail) => `${f.rel}: ${f.problem || "DRIFT — " + f.states.filter((x) => x.state === "drift").map((x) => x.id).join(", ") + " " + tail + " [" + f.states.filter((x) => x.state === "drift").map((x) => `${x.id}: ${x.why}`).join("; ") + "]"}`;
/**
 * Apply every edit that is still base. All-or-nothing: the new text is built and syntax-checked in memory first; a failed write restores the
 * file from the bytes read at the start. `root` and the fence inputs are injectable so the selftest runs it on a temp copy. `write` (the
 * forward write; the restore after a failed write always uses the real writeExact) is for the selftest only: deploy.cjs and rollback.cjs
 * never pass it. Returns { result: "applied" | "noop" | "refused" | "failed", ... } — never throws for a refusal.
 */
function applyAll({ E = loadEdits(), root = REPO, ms, procList, holidays, chain, backups = root === REPO, stateful = root === REPO, backupDir = BACKUP_DIR, stateFile = STATE_FILE, check = true, write = writeExact } = {}) {
  const P = plan(E, root), bad = P.filter((f) => f.state === "drift");
  if (bad.length) return { result: "refused", why: bad.map((f) => driftWhy(f, "is neither base nor applied; read the change in the live file, then make-edits.cjs")) };
  if (P.every((f) => f.state === "applied")) return { result: "noop", why: ["every edit is already applied"] };
  let fz = fences({ ms, procList, holidays, chain, root }); if (fz.length) return { result: "refused", why: fz };
  const work = [];
  for (const f of P) {
    const file = path.join(root, ...f.rel.split("/")), { buf, text, sha } = readText(file), next = applyText(text, editsFor(E, f.rel));
    if (check && isCode(f.rel)) { const err = nodeCheckText(next, f.rel); if (err) return { result: "refused", why: [`${f.rel}: the staged text fails node --check (${err})`] }; }
    work.push({ rel: f.rel, file, before: buf, beforeSha: sha, after: Buffer.from(next, "utf8"), afterSha: sha256(Buffer.from(next, "utf8")), was: f.state });
  }
  fz = fences({ ms, procList, holidays, chain, root }); if (fz.length) return { result: "refused", why: fz };
  for (const w of work) if (sha256(fs.readFileSync(w.file)) !== w.beforeSha) return { result: "refused", why: [`${w.rel} changed while this was running — nothing written`] };
  if (backups) { fs.mkdirSync(backupDir, { recursive: true }); for (const w of work) { const b = path.join(backupDir, `${w.rel.replace(/[\\/]/g, "__")}.pre-${PKG_NAME}-${w.beforeSha.slice(0, 12)}`); if (!fs.existsSync(b)) fs.copyFileSync(w.file, b); if (sha256(fs.readFileSync(b)) !== w.beforeSha) return { result: "refused", why: [`the backup of ${w.rel} does not verify — nothing written`] }; w.backup = (backupDir === BACKUP_DIR ? path.relative(REPO, b) : b).replace(/\\/g, "/"); } }
  const done = [];
  try {
    for (const w of work) { if (w.before.equals(w.after)) continue; done.push(w); write(w.file, w.after); if (sha256(fs.readFileSync(w.file)) !== w.afterSha) throw new Error(`${w.rel} does not verify after the write`); }   // `done` first: a write that fails half-way is put back too
  } catch (e) {
    const left = []; for (const w of done.reverse()) { try { writeExact(w.file, w.before); if (sha256(fs.readFileSync(w.file)) !== w.beforeSha) left.push(w.rel); } catch { left.push(w.rel); } }
    return { result: "failed", why: [e.message], restored: !left.length, notRestored: left };
  }
  const rec = { at: new Date().toISOString(), files: Object.fromEntries(work.map((w) => [w.rel, { before: w.beforeSha, after: w.afterSha, was: w.was, backup: w.backup || null }])) };
  if (stateful) { const st = readState(stateFile); st.applied = rec; delete st.rolledBack; writeState(st, stateFile); }
  return { result: "applied", files: rec.files };
}
/** Put every applied edit back. Byte-exact: with nothing else changed since the apply the file returns to the sha recorded before it. */
function rollbackAll({ E = loadEdits(), root = REPO, ms, procList, holidays, chain, stateful = root === REPO, stateFile = STATE_FILE, recorded, write = writeExact } = {}) {
  const P = plan(E, root), bad = P.filter((f) => f.state === "drift");
  if (bad.length) return { result: "refused", why: bad.map((f) => driftWhy(f, "changed after the apply; put it back by hand from the backup")) };
  if (P.every((f) => f.state === "base")) return { result: "noop", why: ["no edit is applied"] };
  const fz = fences({ ms, procList, holidays, chain, root }); if (fz.length) return { result: "refused", why: fz };
  const rec = recorded || (stateful ? (readState(stateFile).applied || {}).files : null) || {}, work = [];
  for (const f of P) { const file = path.join(root, ...f.rel.split("/")), { buf, text, sha } = readText(file), prev = revertText(text, editsFor(E, f.rel)); work.push({ rel: f.rel, file, before: buf, beforeSha: sha, after: Buffer.from(prev, "utf8"), afterSha: sha256(Buffer.from(prev, "utf8")) }); }
  const done = [];
  try { for (const w of work) { if (w.before.equals(w.after)) continue; done.push(w); write(w.file, w.after); if (sha256(fs.readFileSync(w.file)) !== w.afterSha) throw new Error(`${w.rel} does not verify after the write`); } }
  catch (e) { const left = []; for (const w of done.reverse()) { try { writeExact(w.file, w.before); if (sha256(fs.readFileSync(w.file)) !== w.beforeSha) left.push(w.rel); } catch { left.push(w.rel); } } return { result: "failed", why: [e.message], restored: !left.length, notRestored: left }; }
  const out = Object.fromEntries(work.map((w) => [w.rel, { now: w.afterSha, recordedBefore: (rec[w.rel] || {}).before || null, byteExact: rec[w.rel] ? rec[w.rel].before === w.afterSha : null }]));
  if (stateful) { const st = readState(stateFile); st.rolledBack = { at: new Date().toISOString(), files: out }; writeState(st, stateFile); }
  return { result: "rolled-back", files: out };
}
/**
 * What rollback.cjs says about a finished rollback (pure; `files` = rollbackAll's). DONE only when the file is back to the bytes recorded
 * before the apply: code 0. A file that is not (every edit of this unit reads base in it, so what differs was changed elsewhere in the file
 * since the apply, and was kept) is said by name: code 1. A file with no record of the apply to compare with is not confirmed: code 3.
 */
function rollbackReport(files) {
  const rows = Object.entries(files || {}).map(([rel, f]) => ({ rel, sha: f.now, recordedBefore: f.recordedBefore || null, exact: f.byteExact === true ? "yes" : f.byteExact === false ? "NO" : "unknown" }));
  const notExact = rows.filter((x) => x.exact === "NO").map((x) => x.rel), noRecord = rows.filter((x) => x.exact === "unknown").map((x) => x.rel);
  const code = notExact.length ? 1 : noRecord.length || !rows.length ? 3 : 0;
  const last = code === 0 ? `ROLLED BACK: ${rows.length === 1 ? "the file is" : `all ${rows.length} files are`} byte for byte what ${rows.length === 1 ? "it was" : "they were"} before the apply.`
    : code === 1 ? `ROLLED BACK, BUT NOT BYTE-EXACT: ${notExact.length} of ${rows.length} file(s) are NOT the bytes recorded before the apply — ${notExact.join(", ")}. Every edit of this unit is out; what differs was changed elsewhere in the file since the apply, and was kept. Compare it with its copy in backups/ before relying on it.`
      : `ROLLED BACK, NOT CONFIRMED: there is no record of the apply to compare ${noRecord.length} file(s) with — ${noRecord.join(", ") || "no file listed"}. Every edit of this unit reads base; compare the file with its copy in backups/.`;
  return { rows, notExact, noRecord, code, last };
}
/**
 * The write mode of deploy.cjs, start to finish, with its two child runs injectable (deploy.cjs passes the real selftest and verify-live; the
 * selftest drives this on a temp copy with stand-ins). Returns { code, result, why } — code 0 applied / nothing to do, 1 failed, undone, or
 * applied and NOT undone, 2 refused. Order: drift -> fences -> the selftest -> applyAll (its own two fence checks, backup, atomic write) ->
 * node --check of the written file -> verify (exit 1 or anything unexpected: every edit is put back; exit 3 = UNKNOWN lines: applied, to be
 * re-run). THE PUT-BACK CAN BE REFUSED (it obeys the fences, and one can close between the write and the put-back), so what is reported is
 * READ BACK FROM THE FILE, never taken from the put-back's word: "undone" only when every edit reads base again, else "applied-verify-failed".
 */
function deployApply({ E = loadEdits(), root = REPO, ms, procList, holidays, chain, runSelftest, runVerify, backups, stateful, backupDir, stateFile, out = console.log } = {}) {
  const P = plan(E, root), drift = P.filter((f) => f.state === "drift");
  if (drift.length) return { code: 2, result: "refused", why: drift.map((f) => driftWhy(f, "is neither base nor applied; read the change in the live file, then make-edits.cjs")) };
  if (P.every((f) => f.state === "applied")) return { code: 0, result: "noop", why: ["every edit is already applied"] };
  const fz = fences({ ms, procList, holidays, chain, root }); if (fz.length) return { code: 2, result: "refused", why: fz };
  const st = runSelftest(); if (!st || !st.ok) return { code: 2, result: "refused", why: ["the selftest did not pass:", ...((st && st.lines) || [])] };
  out(`  ${st.last}`);
  const opt = { E, root, ms, procList, holidays, chain, ...(backups === undefined ? {} : { backups }), ...(stateful === undefined ? {} : { stateful }), ...(backupDir ? { backupDir } : {}), ...(stateFile ? { stateFile } : {}) };
  const r = applyAll(opt);
  if (r.result === "refused") return { code: 2, result: "refused", why: r.why };
  if (r.result === "noop") return { code: 0, result: "noop", why: r.why };
  if (r.result !== "applied") return { code: 1, result: "failed", why: r.why, restored: r.restored, notRestored: r.notRestored || [] };
  for (const [rel, f] of Object.entries(r.files)) out(`  written ${rel.padEnd(50)} ${f.before.slice(0, 12)} -> ${f.after.slice(0, 12)}${f.backup ? "   backup " + f.backup : ""}`);
  const undo = (why) => {
    const b = rollbackAll({ E, root, ms, procList, holidays, chain, recorded: r.files, ...(stateful === undefined ? {} : { stateful }), ...(stateFile ? { stateFile } : {}) });
    let left; try { left = plan(E, root).filter((f) => f.state !== "base").map((f) => (f.state === "applied" ? f.rel : `${f.rel} (${f.state})`)); } catch (e) { left = filesOf(E).map((rel) => `${rel} (could not be read back: ${String(e.message).slice(0, 80)})`); }
    return { code: 1, result: left.length ? "applied-verify-failed" : "undone", why: [why], rollback: b.result, rollbackWhy: b.why || [], rollbackLast: b.result === "rolled-back" ? rollbackReport(b.files).last : null, stillApplied: left, files: r.files };
  };
  for (const rel of Object.keys(r.files).filter(isCode)) { const c = cp.spawnSync(process.execPath, ["--check", path.join(root, ...rel.split("/"))], { encoding: "utf8", windowsHide: true }); if (c.status !== 0) return undo(`node --check ${rel}: ${String(c.stderr).trim().split("\n")[0]}`); }
  const v = runVerify(); if (v && v.text) out(v.text);
  if (!v || (v.status !== 0 && v.status !== 3)) return undo(`verify-live.cjs ended ${v && v.status === 1 ? "with a FAIL" : "abnormally (exit " + (v && v.status) + ")"}`);
  return { code: 0, result: "applied", files: r.files, verify: v.status === 0 ? "pass" : "unknowns" };
}
/** What deploy.cjs prints when a check AFTER the write failed (pure). Two outcomes, two headlines — the second can never be read as the first. */
function undoWords(res) {
  const why = (res.why || []).join("; "), left = res.stillApplied || [], rw = res.rollbackWhy || [];
  if (res.result === "undone") return `APPLIED THEN UNDONE: ${why}\n  ${res.rollbackLast || `every edit of this unit reads base again (the put-back answered "${res.rollback}")`}`;
  const how = res.rollback === "refused" ? "was REFUSED" : res.rollback === "failed" ? "was tried and FAILED" : `did not put it back (it answered "${res.rollback}")`;
  return [`APPLIED AND STILL APPLIED: ${why} — and the put-back ${how}${rw.length ? ":" : "."}`, ...rw.map((x) => `    - ${x}`),
    `  STILL APPLIED: ${left.join(", ")}`,
    `  This is NOT "undone". The repaired runner is in: its next run reads the account's positions before it sells, and cuts a sell to what the account has for this book.`,
    `  THE WAY OUT: node ${PKG_REL}/rollback.cjs --plan   and, when it says "fences now: clear",   node ${PKG_REL}/rollback.cjs --apply`,
    `  (the record of the apply is kept, so the rollback says byte-exact or names the file that is not). Or read the failing line above, put it right, and run   node ${PKG_REL}/verify-live.cjs`].join("\n");
}
/** deploy.cjs's READING of its two child runs, kept here as pure functions so the selftest types their answers. */
function selftestVerdict(status, stdout, stderr) {
  const out = String(stdout || ""), last = out.trim().split("\n").pop() || "";
  return { ok: status === 0 && /^ALL \d+ CHECKS PASSED/.test(last), last, lines: [...out.split("\n").filter((l) => /^\s+FAIL/.test(l)).slice(0, 12), String(stderr || "").slice(0, 300)].filter(Boolean) };
}
function verifyVerdict(status, stdout) { return { status, text: String(stdout || "").trim().split("\n").map((l) => "  " + l).join("\n") }; }
/** The two child runs deployApply takes, built from ONE spawner `run(script) -> { status, stdout, stderr }`. */
function deployChildren({ run, out = console.log }) {
  return {
    runSelftest: () => { out("\nselftest (a few minutes) ..."); const r = run("selftest.cjs"); return selftestVerdict(r.status, r.stdout, r.stderr); },
    runVerify: () => { out("verify-live ..."); const r = run("verify-live.cjs"); return verifyVerdict(r.status, r.stdout); },
  };
}

// ───────────────────────────────────────────────────── temp trees, the overlay, case counting ─────────────────────────────────────────────────────
function tempDir(tag = "t") { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rsr-${tag}-`)); return { dir, rm: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } }; }
const put = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
function copyUnit(to, from = REPO, files = UNIT) { for (const rel of files) put(path.join(to, ...rel.split("/")), fs.readFileSync(path.join(from, ...rel.split("/")))); return to; }
/** The OVERLAY: write `textsByRel` ({ rel: text }) into `dir` and return the environment that makes every node process started with it load
 *  (require, readFileSync, copyFileSync) those texts in place of the real files REPO/<rel>. Nothing in the repo is written. */
function overlayEnv(dir, textsByRel, baseEnv = process.env) {
  const map = {}; for (const [rel, text] of Object.entries(textsByRel)) map[path.resolve(REPO, ...rel.split("/")).toLowerCase()] = put(path.join(dir, "overlay", ...rel.split("/")), text);
  const mapFile = put(path.join(dir, "overlay-map.json"), JSON.stringify(map)), pre = put(path.join(dir, "overlay.cjs"), fs.readFileSync(path.join(PKG, "harness", "overlay.cjs")));
  const env = { ...baseEnv, RSR_OVERLAY_MAP: mapFile, NODE_OPTIONS: `--require "${pre.replace(/\\/g, "/")}"` };
  return { env, map, mapFile };
}
/** an environment without any credential name (children of the selftest never inherit one from this process) */
const cleanEnv = (extra = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/KEY|SECRET|TOKEN|PASSWORD|ALPACA|SCHWAB|TASTY|TELEGRAM|SMTP|ANTHROPIC|NODE_OPTIONS|R231_|R191_/i.test(k))), ...extra });
function parseCases(status, stdout, stderr) {
  const out = String(stdout || ""), okNames = [], failNames = [];
  for (const l of out.split(/\r?\n/)) { const m = /^\s*(ok|FAIL)\s+(.*)$/.exec(l); if (m) (m[1] === "ok" ? okNames : failNames).push(m[2]); }
  return { status, out, err: String(stderr || ""), ok: okNames.length, fail: failNames.length, okNames, failNames };
}
function runCases(args, { env = process.env, cwd = REPO, timeout = 900000 } = {}) {
  const r = cp.spawnSync(process.execPath, args, { encoding: "utf8", env, cwd, timeout, windowsHide: true, maxBuffer: 256 << 20 });
  return parseCases(r.status, r.stdout, r.stderr);
}
function runNodeAsync(args, { env = process.env, cwd = REPO, timeout = 900000 } = {}) {
  return new Promise((resolve) => {
    const c = cp.spawn(process.execPath, args, { env, cwd, windowsHide: true }); let out = "", err = "", done = false;
    const t = setTimeout(() => { if (!done) { try { c.kill(); } catch {} } }, timeout);
    c.stdout.on("data", (d) => { out += d; }); c.stderr.on("data", (d) => { err += d; });
    c.on("error", (e) => { if (done) return; done = true; clearTimeout(t); resolve({ status: null, out, err: err + String(e.message) }); });
    c.on("close", (code) => { if (done) return; done = true; clearTimeout(t); resolve({ status: code, out, err }); });
  });
}

// ═════════════════════════════════════════════════════════ FEES AND THE RESTATE (pure) ═════════════════════════════════════════════════════════
const UNIVERSE = ["BTC", "ETH", "LTC", "BCH", "LINK", "ADA", "SOL", "DOGE", "AVAX", "DOT", "UNI", "AAVE", "XTZ"];
const NANO = 1e9, nano = (x) => Math.round(Number(x) * NANO), s9 = (n) => (n / NANO).toFixed(9), qn = (n) => +s9(n);
const FEE_BEFORE_MS = 5000, FEE_AFTER_MS = 120000, FEE_SHARE_MAX = 0.006;
const coinOf = (sym) => { const m = /^([A-Z0-9]+)\/?USD$/.exec(String(sym || "")); return m ? m[1] : null; };
const feeRowsOf = (rows, coin) => (rows || []).filter((r) => r && coinOf(r.symbol) === coin && Number(r.qty) < 0);
const dayUTC = (ms) => new Date(ms).toISOString().slice(0, 10), NY_DAY = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const dayNY = (ms) => { const p = {}; for (const x of NY_DAY.formatToParts(ms)) p[x.type] = x.value; return `${p.year}-${p.month}-${p.day}`; };
/** do the fee rows of `coin` carry a date and NO time? (then feeOfBuy reads them by date; splitFee cannot split them) */
const dateOnly = (rows, coin) => { const mine = feeRowsOf(rows, coin); return mine.length > 0 && !mine.some((r) => Number.isFinite(Date.parse(r.created_at))); };
/**
 * The fee of ONE filled buy from the broker's CFEE rows — the function staged into the runner (helpers.txt feeOfBuy), kept the same.
 * -> { fee: nano, rows, used: [the rows] } (and `byDate` when read by date) or { fee: null, why }.
 * BY TIME, when a fee row of the coin carries `created_at`: the rows created from 5 s before to 120 s after the fill.
 * BY DATE, only when NO fee row of the coin carries a time (the broker's published example of a CFEE row has `date` and no time; which of the two
 * the real rows carry was not read when this was staged): the rows dated the fill's day, and only when they can be nobody else's —
 *   · the fill's day is the same date in UTC and in New York, so the row is dated that day whichever of the two the broker dates by;
 *   · no other buy of the coin is on the account's files that day, by either clock: not this book's (`ownBuys`: [{ ms }], its OTHER buys of the
 *     coin) and not another sleeve's (`otherBuys`), and none of unknown time;
 *   · the rows come to no more than 0.6% of the fill.
 * Anything else is UNKNOWN, as before. The time reading does not use `ownBuys`.
 */
function feeOfBuy(rows, coin, fillMs, filledNano, otherBuys, ownBuys) {
  if (!Number.isFinite(fillMs)) return { fee: null, why: "the order has no fill time" };
  if (!(filledNano > 0)) return { fee: null, why: "the order has no filled quantity" };
  const near = (otherBuys || []).find((b) => b.coin === coin && (!Number.isFinite(b.ms) || Math.abs(b.ms - fillMs) <= FEE_BEFORE_MS + FEE_AFTER_MS));
  if (near) return { fee: null, why: `${near.by} bought ${coin} in the same two minutes: the fee rows cannot be told apart` };
  const mine = feeRowsOf(rows, coin);
  let m, day = null;
  if (mine.length && !mine.some((r) => Number.isFinite(Date.parse(r.created_at)))) {
    day = dayUTC(fillMs); const onDay = (ms) => dayUTC(ms) === day || dayNY(ms) === day;
    if (dayNY(fillMs) !== day) return { fee: null, why: `the broker's ${coin} fee rows carry a date and no time, and this fill's day is ${day} in UTC but ${dayNY(fillMs)} in New York: its rows cannot be told by date` };
    const also = (otherBuys || []).find((b) => b.coin === coin && onDay(b.ms));
    if (also) return { fee: null, why: `the broker's ${coin} fee rows carry a date and no time, and ${also.by} bought ${coin} on the same day (${day}): the fee rows cannot be told apart` };
    if ((ownBuys || []).some((b) => !Number.isFinite(b.ms) || onDay(b.ms))) return { fee: null, why: `the broker's ${coin} fee rows carry a date and no time, and this book has another buy of ${coin} on the same day (${day}), or one of unknown time: the fee rows cannot be told apart` };
    m = mine.filter((r) => String(r.date).slice(0, 10) === day);
    if (!m.length) return { fee: null, why: `the broker lists no fee row (CFEE) for ${coin} dated ${day} (${mine.length} ${coin} fee row${mine.length === 1 ? "" : "s"} read, with a date and no time)` };
  } else {
    m = mine.filter((r) => { const t = Date.parse(r.created_at); return t >= fillMs - FEE_BEFORE_MS && t <= fillMs + FEE_AFTER_MS; });
    if (!m.length) return { fee: null, why: `the broker lists no fee row (CFEE) for ${coin} from 5 s before to 120 s after its fill (${mine.length} ${coin} fee row${mine.length === 1 ? "" : "s"} read)` };
  }
  const fee = m.reduce((a, r) => a - nano(r.qty), 0);
  if (!(fee > 0) || fee > filledNano * FEE_SHARE_MAX) return { fee: null, why: `the fee rows ${day ? `dated ${day}` : "in its window"} come to ${(100 * fee / filledNano).toFixed(3)}% of the fill (over 0.6%: not this order's alone)` };
  return day ? { fee, rows: m.length, used: m, byDate: day } : { fee, rows: m.length, used: m };
}
/**
 * RESTATE ONLY — a buy whose two minutes ALSO hold a buy of the same coin by another sleeve (R231's BTC and ETH buys of 2026-09-25 went 3 s
 * after R191's). The fee rows of both orders sit in one window. They are told apart by the one thing the rows give: every order filled in
 * those seconds was charged in proportion to its filled quantity. So: T = all fee rows of the coin from 5 s before the first of the fills to
 * 120 s after the last; this order's share is T x q / (q + the other sleeves' quantities); the rows that belong to it are the ONE set of
 * whole rows whose sum is that share to within a rounding unit per row. No rate is typed anywhere. Anything else — a buy of unknown time or
 * size, no such set, more than one, more than 16 rows — is { fee: null, why }.
 *   clash: [{ ms, nano, by }]   the other sleeves' buys of the coin within the two minutes
 */
function splitFee(rows, coin, fillMs, filledNano, clash) {
  if (!clash.length) return { fee: null, why: "no other buy to split with" };
  if (clash.some((b) => !Number.isFinite(b.ms) || !(b.nano > 0))) return { fee: null, why: `a buy of ${coin} by ${clash.find((b) => !Number.isFinite(b.ms) || !(b.nano > 0)).by} in the same two minutes has no known time or size` };
  if (dateOnly(rows, coin)) return { fee: null, why: `the broker's ${coin} fee rows carry a date and no time, and ${clash.map((b) => b.by).join(" and ")} bought ${coin} in the same two minutes: the fee rows cannot be told apart` };
  const lo = Math.min(fillMs, ...clash.map((b) => b.ms)) - FEE_BEFORE_MS, hi = Math.max(fillMs, ...clash.map((b) => b.ms)) + FEE_AFTER_MS;
  const win = feeRowsOf(rows, coin).filter((r) => { const t = Date.parse(r.created_at); return t >= lo && t <= hi; }), m = win.map((r) => -nano(r.qty));
  if (!m.length) return { fee: null, why: `the broker lists no fee row (CFEE) for ${coin} around the fills of that minute` };
  if (m.length > 16) return { fee: null, why: `${m.length} fee rows in the window: too many to tell apart` };
  const T = m.reduce((a, x) => a + x, 0), all = filledNano + clash.reduce((a, b) => a + b.nano, 0), want = (T * filledNano) / all;
  if (T > all * FEE_SHARE_MAX) return { fee: null, why: `the fee rows of the window come to ${(100 * T / all).toFixed(3)}% of the fills (over 0.6%)` };
  const sums = new Map();   // sum -> the sets of rows (masks) that give it: one sum is one fee; more than one set for it is said on the record (the rows named are then the first set)
  for (let mask = 1; mask < 1 << m.length; mask++) { let s = 0, k = 0; for (let i = 0; i < m.length; i++) if (mask & (1 << i)) { s += m[i]; k++; } if (Math.abs(s - want) <= k + 1) sums.set(s, [...(sums.get(s) || []), mask]); }
  if (sums.size !== 1) return { fee: null, why: sums.size ? `more than one set of fee rows fits this order's share (${[...sums.keys()].map(s9).join(", ")})` : `no set of whole fee rows is this order's share of the window (${s9(Math.round(want))} of ${s9(T)})` };
  const [fee, masks] = [...sums.entries()][0], used = win.filter((_, i) => masks[0] & (1 << i)), k = used.length;
  if (!(fee > 0) || fee > filledNano * FEE_SHARE_MAX) return { fee: null, why: "the rows picked are not a plausible fee for this order" };
  return { fee, rows: k, used, sets: masks.length, split: `${k} of the ${m.length} fee rows of that minute, told apart from ${clash.map((b) => b.by).join(" and ")} by filled quantity` };
}
/** the other sleeves' files in `dir` (the reading staged into the runner, helpers.txt otherSleeves, with each buy's size as well) */
function readOthers(dir) {
  const o = { n: {}, why: {}, unsettled: {}, unread: {}, notes: [], buys: [], everHeld: new Set() }, push = (m, k, v) => { (m[k] = m[k] || []).push(v); };
  const count = (c, id, n) => { o.n[c] = (o.n[c] || 0) + n; push(o.why, c, `${id} ${s9(n)}`); };
  const rows = (f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, "r191-crypto-trend.json"), "utf8")); if (!j || !j.coins || typeof j.coins !== "object") throw new Error("it has no coins table");
    const got = [];
    for (const [c, v] of Object.entries(j.coins)) { const n = v && typeof v === "object" ? nano(v.qty) : NaN; if (!Number.isFinite(n) || n < 0) throw new Error(`its count of ${c} is not a quantity`); got.push([c, n, v.pending]); o.everHeld.add(c); }
    for (const [c, n, pend] of got) { if (n > 0) count(c, "R191", n); if (pend) { push(o.unsettled, c, `R191 has an order of its own on ${c} that it has not booked yet (data/r191-crypto-trend.json)`); if (pend.side === "buy") o.buys.push({ coin: c, ms: null, nano: null, by: "R191" }); } }
    for (const x of Array.isArray(j.orders) ? j.orders : []) { const m = /^r191-([A-Z0-9]+)-/.exec(String((x && x.cid) || "")); if (m && x.side === "buy") o.buys.push({ coin: m[1], ms: Date.parse(x.at), nano: nano(x.qty), by: "R191", cid: x.cid }); }
  } catch (e) { const why = `data/r191-crypto-trend.json cannot be read (${String(e.message).slice(0, 80)})`; for (const c of ["BTC", "ETH"]) { push(o.unread, c, why); o.everHeld.add(c); } o.notes.push(`${why}: no sell of BTC, ETH until it can`); }
  try {
    const fin = new Set(), working = new Set(), open = [];
    for (const x of rows("alpaca-mirror-exits.jsonl")) if (x && x.ticketId) (x.final ? fin : working).add(x.ticketId);
    for (const r of rows("alpaca-mirror.jsonl")) {
      if (!r || r.cls !== "Crypto" || !r.orderId || !r.live) continue;
      const c = coinOf(r.sym), n = Math.ceil(Number(r.qty) * NANO - 1e-6);
      if (c) o.everHeld.add(c);
      if (c && r.side === "buy") o.buys.push({ coin: c, ms: Date.parse(r.ts), nano: n, by: "the board's mirror", cid: r.ticketId });
      if (fin.has(r.ticketId)) continue;
      if (!c || !Number.isFinite(n) || n <= 0) throw new Error(`ticket ${String(r.ticketId).slice(0, 40)} has no readable coin or quantity`);
      open.push([c, n, working.has(r.ticketId)]);
    }
    for (const [c, n, closing] of open) { count(c, "the board's mirror", n); if (closing) push(o.unsettled, c, `the board's mirror has a close order of its own on ${c} that is not final yet (data/alpaca-mirror-exits.jsonl)`); }
  } catch (e) { const why = `the board mirror's files (data/alpaca-mirror.jsonl, data/alpaca-mirror-exits.jsonl) cannot be read (${String(e.message).slice(0, 80)})`; for (const c of UNIVERSE) { push(o.unread, c, why); o.everHeld.add(c); } o.notes.push(`${why}: no sell of any coin until they can`); }
  return o;
}
/** the broker's own words about a balance, kept in R231's ledger: rows kind order-rejected whose error is "insufficient balance for <COIN>" -> [{ coin, available, ts }] */
function recordedBalances(ledgerRows) {
  const out = [];
  for (const r of ledgerRows || []) { if (!r || r.kind !== "order-rejected") continue; const e = String(r.error || ""), a = /"available":"([0-9.]+)"/.exec(e), c = /insufficient balance for ([A-Z0-9]+) /.exec(e); if (a && c) out.push({ coin: c[1], available: a[1], ts: r.ts, cid: r.cid }); }
  return out;
}
const RESTATE_ID = "r231-counts-net-of-buy-fees";
const R231_CID = /^r231-([A-Z0-9]+)-\d{8}-(buy|sell)(?:-\d+)?$/;
/**
 * R231's buys that are STILL IN A COUNT and not yet counted net — the only rows a restate may take a fee off for (pure).
 *   · A buy whose row carries its fee is already net (the repaired runner booked it so, or an earlier restate did): never taken off twice.
 *   · A buy BEFORE ITS COIN'S LAST FLAT is SETTLED. When the coin was closed, what was counted beyond what the account had — those buys' fees —
 *     went with the close: written off on the sell row by the repaired runner (`writtenOff`), or simply sold. Nothing of it is left in the count,
 *     so there is no fee of it to take off. A coin is flat where a sell row carries `writtenOff`, where the rows' own running count comes to
 *     zero, and NOW when its count on file is zero. Only the buys SINCE the last flat are still in the count.
 * -> { todo: [{ o, i, coin }] (in the order of the file), settled: [{ cid, coin, why }],
 *      unknown: [{ id, open }] (rows whose id this reading does not know; open = a buy with no fee on its row) }
 */
function openBuys(state) {
  const run = {}, flatAt = {}, rows = [], unknown = [], orders = (state && Array.isArray(state.orders) ? state.orders : []);
  orders.forEach((o, i) => {
    const m = R231_CID.exec(String((o && o.cid) || "")); if (!m) { unknown.push({ id: String(o && o.cid).slice(0, 40), open: !!o && o.side === "buy" && typeof o.fee !== "number" }); return; }
    const c = m[1];
    if (o.side === "buy") { run[c] = (run[c] || 0) + nano(typeof o.net === "number" ? o.net : o.qty); rows.push({ o, i, coin: c }); return; }
    run[c] = typeof o.writtenOff === "number" ? 0 : Math.max(0, (run[c] || 0) - nano(o.qty));
    if (run[c] === 0) flatAt[c] = i;
  });
  const todo = [], settled = [];
  for (const r of rows) {
    if (typeof r.o.fee === "number") continue;                                            // already counted net
    const st = ((state && state.coins) || {})[r.coin];
    if (st && nano(st.qty) === 0) settled.push({ cid: r.o.cid, coin: r.coin, why: `${r.coin} counts 0 now: it was closed, and this buy's fee went with the close` });
    else if (r.i < flatAt[r.coin]) settled.push({ cid: r.o.cid, coin: r.coin, why: `${r.coin} was closed flat after it (${orders[flatAt[r.coin]].cid}): its fee went with that close` });
    else todo.push(r);
  }
  return { todo, settled, unknown };
}
/**
 * THE RESTATE, worked out and not written (pure). R231's counts on file are GROSS: each buy was counted at its filled quantity. For every buy
 * in state.orders that is still in a count and carries no fee yet (openBuys: a buy before its coin's last flat is settled and left alone), the
 * fee the broker charged is read from `cfee` (feeOfBuy; splitFee for a buy that shares its two minutes with another sleeve's), and each coin's
 * count comes down by the fees of those buys. NOTHING ELSE moves a count: not what the account holds, not what another sleeve took. Returns
 * { rows: [per coin], buys: [per buy], settled: [buys left alone], problems: [why it must refuse], totals, checks }.
 * It REFUSES (problems) when a fee cannot be read, when a count would go below zero, or when a restated count is not the balance the broker
 * itself stated for that coin (recordedBalances) where that statement binds: a coin no other sleeve ever held, with no fill of ours since.
 */
function restatePlan({ state, ledgerRows, cfee, others }) {
  const problems = [], buys = [], rows = [], checks = [];
  if (!state || !state.coins || !Array.isArray(state.orders) || !Array.isArray(state.marks)) return { rows, buys, checks, settled: [], problems: ["the state file has no coins / orders / marks"], totals: null };
  if (!Array.isArray(cfee)) return { rows, buys, checks, settled: [], problems: ["the broker's fee rows (CFEE) could not be read"], totals: null };
  const lastClose = {}; for (const m of state.marks) if (m && m.close != null && (!lastClose[m.coin] || m.d > lastClose[m.coin].d)) lastClose[m.coin] = { d: m.d, close: m.close };
  const OB = openBuys(state);
  for (const u of OB.unknown) problems.push(`an order row has an id this script does not know (${u.id})`);
  for (const { o, coin } of OB.todo) {                                                   // not a sell, not a buy already counted net, not a buy settled by its coin's close
    const t = Date.parse(o.at), q = nano(o.qty), clash = (others.buys || []).filter((b) => b.coin === coin && (!Number.isFinite(b.ms) || Math.abs(b.ms - t) <= FEE_BEFORE_MS + FEE_AFTER_MS));
    const own = state.orders.filter((x) => x && x !== o && x.side === "buy" && (R231_CID.exec(String(x.cid)) || [])[1] === coin).map((x) => ({ ms: Date.parse(x.at) }));   // this book's OTHER buys of the coin (a fee read by date must be the only buy of its day)
    const f = clash.length ? splitFee(cfee, coin, t, q, clash) : feeOfBuy(cfee, coin, t, q, others.buys || [], own);
    const basis = f.fee == null ? null : f.split ? f.split + (f.sets > 1 ? ` (${f.sets} sets of rows give that same sum; the rows named are one of them)` : "") : f.byDate ? `${f.rows} CFEE row${f.rows === 1 ? "" : "s"} dated ${f.byDate} — the rows carry a date and no time; no other buy of ${coin} is on the account's files that day` : `${f.rows} CFEE row${f.rows === 1 ? "" : "s"} created within 5 s before to 120 s after its fill`;
    // WHICH rows of the broker the figure came from, kept for the permanent records: each row's id, its time (or date) and its quantity, as the broker gave them
    const feeRows = f.fee == null ? [] : (f.used || []).map((r) => ({ id: r.id == null ? null : String(r.id), ...(r.created_at != null ? { created_at: r.created_at } : {}), ...(r.date != null ? { date: r.date } : {}), qty: String(r.qty) }));
    buys.push({ cid: o.cid, coin, at: o.at, qty: o.qty, fee: f.fee == null ? null : qn(f.fee), feeNano: f.fee, rows: f.rows || 0, basis, feeRows, why: f.why || null, share: f.fee == null ? null : f.fee / q });
    if (f.fee == null) problems.push(`${o.cid}: its fee cannot be read — ${f.why}`);
  }
  const said = recordedBalances(ledgerRows);
  for (const c of UNIVERSE) {
    const st = state.coins[c]; if (!st) { problems.push(`the state has no ${c}`); continue; }
    const mine = buys.filter((b) => b.coin === c), fee = mine.reduce((a, b) => a + (b.feeNano || 0), 0), before = nano(st.qty), after = before - fee, px = lastClose[c] ? lastClose[c].close : null;
    if (after < 0) problems.push(`${c}: the fees read (${s9(fee)}) are more than the count (${s9(before)})`);
    rows.push({ coin: c, before: qn(before), fee: qn(fee), after: qn(after), buys: mine.length, settled: OB.settled.filter((x) => x.coin === c).length, markDay: lastClose[c] ? lastClose[c].d : null, close: px, usdBefore: px == null ? null : +(qn(before) * px).toFixed(2), usdAfter: px == null ? null : +(qn(after) * px).toFixed(2),
      notionalBefore: st.notional, notionalAfter: before > 0 ? (st.notional * after) / before : st.notional, pending: !!st.pending });
    for (const s of said.filter((x) => x.coin === c)) {
      const later = state.orders.some((o) => new RegExp(`^r231-${c}-`).test(String(o.cid)) && Date.parse(o.at) > Date.parse(s.ts)), shared = others.everHeld.has(c), allRead = mine.every((b) => b.feeNano != null), noneNet = !state.orders.some((o) => new RegExp(`^r231-${c}-`).test(String(o.cid)) && (typeof o.fee === "number" || typeof o.writtenOff === "number"));
      const binds = !later && !shared && allRead && noneNet, same = nano(s.available) === after;
      checks.push({ coin: c, said: s.available, on: s.ts, restated: s9(after), binds, same, why: binds ? null : later ? "R231 has a fill of it after that statement" : shared ? "another sleeve has held it" : !allRead ? "a fee of it could not be read" : "part of its count is already net" });
      if (binds && !same) problems.push(`${c}: the restated count ${s9(after)} is not the ${s.available} the broker itself said the account held on ${String(s.ts).slice(0, 10)} — the fee rows read do not explain the account`);
    }
  }
  const sum = (k) => +rows.reduce((a, r) => a + (r[k] || 0), 0).toFixed(2);
  return { rows, buys, checks, settled: OB.settled, problems, totals: { usdBefore: sum("usdBefore"), usdAfter: sum("usdAfter"), coins: rows.filter((r) => r.fee > 0).length, buys: buys.length, read: buys.filter((b) => b.feeNano != null).length, settled: OB.settled.length } };
}
/**
 * the state as the restate leaves it (a NEW object; `state` is not touched): counts, notionals in proportion, each restated buy's fee on its row
 * WITH THE BROKER'S ROWS IT CAME FROM (`feeRows`: id, time or date, quantity), one note. `source` = where the fee rows were read from (restate.cjs
 * feeSource: the broker with the time of the read, or a file with its path — and the sha256 of the rows either way); it is kept in the note.
 */
function restateState(state, P, { at, id, date = at.slice(0, 10), source = null }) {
  const s = JSON.parse(JSON.stringify(state)), byCid = new Map(P.buys.map((b) => [b.cid, b]));
  for (const r of P.rows) { s.coins[r.coin].qty = r.after; s.coins[r.coin].notional = r.notionalAfter; }
  for (const o of s.orders) { const b = byCid.get(o.cid); if (b && b.feeNano != null) { o.fee = b.fee; o.net = qn(nano(o.qty) - b.feeNano); o.feeBasis = `restated ${date}: ${b.basis}`; o.feeRows = b.feeRows || []; } }
  s.netOfFee = { restatedAt: at, changeRegistry: id, by: `${PKG_REL}/restate.cjs`, ...(source ? { feeSource: source } : {}), note: "each coin's count is net of the fee the broker took in the coin on each of this book's buys; before this the counts were the filled quantities" };
  return s;
}
/** the smallest and the largest share of a fill that the fees READ come to, in percent with 4 decimals (from the rows, never typed) -> { n, min, max, words } */
function feeShares(P) {
  const sh = ((P && P.buys) || []).filter((b) => b.feeNano != null && b.share != null).map((b) => 100 * b.share);
  if (!sh.length) return { n: 0, min: null, max: null, words: "no fee was read" };
  const min = Math.min(...sh).toFixed(4), max = Math.max(...sh).toFixed(4);
  return { n: sh.length, min: +min, max: +max, words: min === max ? `${min}% of the filled quantity on each of the ${sh.length} buys restated` : `${min}% to ${max}% of the filled quantity (the smallest and the largest share among the ${sh.length} buys restated)` };
}

module.exports = { PKG_NAME, PKG, PKG_REL, REPO, EDITS_FILE, STATE_FILE, BACKUP_DIR, R231, UNIT, FORBIDDEN, sha256, atomic, forbidden, validateEdits, loadEdits, filesOf, editsFor,
  count, at, editState, driftWords, fileState, applyText, revertText, readText, texts, plan, writeExact, nodeCheckText, isCode, parts, mtNow, tradingDate, tradingWeekday, WIN, mtInstant, lastSession, chainWhy, procs, argvOf, nodeLoads, repoFileOf, cmdCommand, cmdBatch, busyWhy, RUNS_THE_RUNNER, fences,
  readState, writeState, logRow, applyAll, rollbackAll, rollbackReport, deployApply, undoWords, selftestVerdict, verifyVerdict, deployChildren, tempDir, put, copyUnit, overlayEnv, cleanEnv, parseCases, runCases, runNodeAsync,
  UNIVERSE, NANO, nano, s9, qn, FEE_BEFORE_MS, FEE_AFTER_MS, FEE_SHARE_MAX, coinOf, feeRowsOf, dayUTC, dayNY, dateOnly, feeOfBuy, splitFee, readOthers, recordedBalances, RESTATE_ID, openBuys, restatePlan, restateState, feeShares };
