"use strict";
/**
 * OPS HEALTH FIX 2026-10-05 — shared helpers for deploy.cjs / rollback.cjs / selftest.cjs (a module: no side effects on load).
 * Time decisions use node's Intl (America/New_York, America/Denver), never the shell clock.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto"), { execFileSync } = require("child_process");
const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", "..", "..");
const BACKUP_DIR = path.resolve(PKG, "..", "backups");
const MANIFEST = path.join(PKG, "manifest.json");
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const shaFile = (f) => sha256(fs.readFileSync(f));
const eolOf = (buf) => { let crlf = 0, lf = 0; for (let i = 0; i < buf.length; i++) if (buf[i] === 10) { if (i > 0 && buf[i - 1] === 13) crlf++; else lf++; } return crlf && !lf ? "CRLF" : lf && !crlf ? "LF" : crlf || lf ? "MIXED" : "NONE"; };
const backupPathFor = (rel, pkg = "ops") => path.join(BACKUP_DIR, rel.replace(/[\\/]/g, "__") + `.pre-${pkg}`);
function parts(tz, ms = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hour12: false }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, dow: p.weekday, mins: (+p.hour % 24) * 60 + +p.minute, hms: `${String(+p.hour % 24).padStart(2, "0")}:${p.minute}:${p.second}` };
}
const etNow = (ms) => parts("America/New_York", ms), mtNow = (ms) => parts("America/Denver", ms);
function sessionDay(et) {
  if (et.dow === "Sat" || et.dow === "Sun") return false;
  try { return !require(path.join(REPO, "backend", "lib", "run-window.js")).marketHoliday(et.date); } catch { return true; }   // unknown -> treat as a session day (stricter fences)
}
const EARLY_CLOSE = ["2026-11-27", "2026-12-24", "2027-11-26"];
/** node.exe / cmd.exe processes with command lines (read-only CIM query). Throws if the list cannot be read. */
function procs() {
  const ps = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='cmd.exe'\" | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 2";
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 60000, windowsHide: true, maxBuffer: 32 << 20 });
  const j = JSON.parse(String(out || "").trim() || "[]");
  const rows = (Array.isArray(j) ? j : [j]).filter(Boolean).map((p) => ({ pid: Number(p.ProcessId), ppid: Number(p.ParentProcessId), name: String(p.Name || "").toLowerCase(), cmd: String(p.CommandLine || "") }));
  if (!rows.some((p) => p.pid === process.pid)) throw new Error("process list does not contain this process — not trusted");
  return rows;
}
const pidAlive = (pid) => { if (!(Number.isInteger(pid) && pid > 0)) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
/**
 * FENCES. Each returns [] when clear, else the reasons. Any error reading the clock-independent state counts as NOT clear (fail closed).
 *   breaker  : not 09:15-16:15 ET on a session day (risk-policy.js is read by runners all session: no mid-session version change);
 *              not while tonight's close chain is due/running (session day >= 16:15 ET and chain-status.json not from today)
 *   selfheal : no preflight.bat / preflight.js / ops-alert.js / self-heal.js process running (cmd reads a .bat incrementally), and the
 *              Mountain minute is 01-49 (not within 10 minutes of the hourly :00 fire) — i.e. deploy right after an hourly run
 *   closearm : on a session day not before 13:48 MT (after the 13:37/13:44 task fires and their 13:47 tail), not 10:30-10:50 MT on an
 *              early-close date; no close-arm-runner.cjs process; close-arm.lock / close-arm-backups.lock absent or held by a dead pid
 */
function fences(part, { ms = Date.now(), forRollback = false } = {}) {
  const why = [], et = etNow(ms), mt = mtNow(ms), sess = sessionDay(et);
  let plist = null; const P = () => { if (plist) return plist; plist = procs(); return plist; };
  if (part === "breaker" && !forRollback) {
    if (sess && et.mins >= 9 * 60 + 15 && et.mins < 16 * 60 + 15) why.push(`${et.hms} ET is inside 09:15-16:15 ET on a session day — deploy the breaker part after the close chain`);
    if (sess && et.mins >= 16 * 60 + 15) { let ok = false; try { const c = JSON.parse(fs.readFileSync(path.join(REPO, "backend", "data", "chain-status.json"), "utf8")); ok = c.started && etNow(Date.parse(c.started)).date === et.date && !!c.finished; } catch {} if (!ok) why.push("tonight's close chain has not written chain-status.json yet (due or running) — wait for it to finish"); }
  }
  if (part === "selfheal") {
    try { const hit = P().filter((p) => (p.name === "cmd.exe" && /preflight\.bat/i.test(p.cmd)) || (p.name === "node.exe" && /backend[\\/](preflight|ops-alert|self-heal)\.js/i.test(p.cmd)));
      if (hit.length) why.push(`a preflight run is in progress (pid ${hit.map((p) => p.pid).join(", ")}) — cmd reads preflight.bat while it runs`); }
    catch (e) { why.push(`cannot read the process list (${String(e.message).slice(0, 80)}) — refusing to touch preflight.bat blind`); }
    if (mt.mins % 60 < 1 || mt.mins % 60 >= 50) why.push(`${mt.hms} MT is within 10 minutes of (or at) the hourly preflight fire — run right after an hourly run (minute 01-49)`);
  }
  if (part === "closearm") {
    if (!forRollback && sess && mt.mins < 13 * 60 + 48) why.push(`${mt.hms} MT on a session day is before 13:48 MT — today's close-arm fires (13:37/13:44, tail to 13:47) come first`);
    if (forRollback && sess && mt.mins >= 13 * 60 + 30 && mt.mins < 13 * 60 + 50) why.push(`${mt.hms} MT is inside the 13:30-13:50 close-arm fire window`);
    if (EARLY_CLOSE.includes(et.date) && mt.mins >= 10 * 60 + 30 && mt.mins < 10 * 60 + 50) why.push(`${mt.hms} MT on an early-close date is inside the 10:30-10:50 MT fire window`);
    try { const hit = P().filter((p) => p.name === "node.exe" && /close-arm-runner\.cjs/i.test(p.cmd)); if (hit.length) why.push(`close-arm-runner.cjs is running (pid ${hit.map((p) => p.pid).join(", ")})`); }
    catch (e) { why.push(`cannot read the process list (${String(e.message).slice(0, 80)}) — refusing to replace the runner blind`); }
    for (const lk of ["close-arm.lock", "close-arm-backups.lock"]) { try { const c = JSON.parse(fs.readFileSync(path.join(REPO, "backend", "data", lk), "utf8")); if (pidAlive(c.pid)) why.push(`backend/data/${lk} is held by live pid ${c.pid} (${c.by}) since ${c.startedAt}`); } catch (e) { if (e.code !== "ENOENT") why.push(`backend/data/${lk} unreadable (${e.code || e.message})`); } }
  }
  return why;
}
const loadManifest = () => JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
module.exports = { PKG, REPO, BACKUP_DIR, MANIFEST, sha256, shaFile, eolOf, backupPathFor, etNow, mtNow, sessionDay, procs, pidAlive, fences, loadManifest, EARLY_CLOSE };
