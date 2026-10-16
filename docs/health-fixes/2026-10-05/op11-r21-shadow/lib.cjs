"use strict";
/**
 * OP11 R21 SHADOW (2026-10-05) — shared helpers for make-manifest.cjs / deploy.cjs / rollback.cjs / selftest.cjs.
 * A module: no side effects on load. Time decisions use node's Intl (America/New_York, America/Denver), never the shell clock.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto"), { execFileSync } = require("child_process");
const PKG_NAME = "op11-r21-shadow";
const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", "..", "..");
const BACKUP_DIR = path.resolve(PKG, "..", "backups");
const MANIFEST = path.join(PKG, "manifest.json");
/** the deploy unit, in deploy order (policy first: options-sleeve.js reads it; the readers last) */
const FILES = ["backend/lib/risk-policy.js", "backend/options-sleeve.js", "backend/r110-put-side-twin.js", "backend/r112-wing-cap-family.js"];
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const shaFile = (f) => sha256(fs.readFileSync(f));
const eolOf = (buf) => { let crlf = 0, lf = 0; for (let i = 0; i < buf.length; i++) if (buf[i] === 10) { if (i > 0 && buf[i - 1] === 13) crlf++; else lf++; } return crlf && !lf ? "CRLF" : lf && !crlf ? "LF" : crlf || lf ? "MIXED" : "NONE"; };
const hasBom = (buf) => buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
const backupPathFor = (rel) => path.join(BACKUP_DIR, rel.replace(/[\\/]/g, "__") + `.pre-${PKG_NAME}`);
const livePath = (rel) => path.join(REPO, rel), stagedPath = (rel) => path.join(PKG, "staged", rel), basePath = (rel) => path.join(PKG, "base", rel);
function parts(tz, ms = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hour12: false }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, dow: p.weekday, mins: (+p.hour % 24) * 60 + +p.minute, hms: `${String(+p.hour % 24).padStart(2, "0")}:${p.minute}:${p.second}` };
}
const etNow = (ms) => parts("America/New_York", ms), mtNow = (ms) => parts("America/Denver", ms);
function sessionDay(et) {
  if (et.dow === "Sat" || et.dow === "Sun") return false;
  try { return !require(path.join(REPO, "backend", "lib", "run-window.js")).marketHoliday(et.date); } catch { return true; }   // unknown -> a session day (stricter fences)
}
/** node.exe / cmd.exe processes with command lines (read-only CIM query). Throws if the list cannot be read or does not contain this process. */
function procs() {
  const ps = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='cmd.exe'\" | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 2";
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 60000, windowsHide: true, maxBuffer: 32 << 20 });
  const j = JSON.parse(String(out || "").trim() || "[]");
  const rows = (Array.isArray(j) ? j : [j]).filter(Boolean).map((p) => ({ pid: Number(p.ProcessId), ppid: Number(p.ParentProcessId), name: String(p.Name || "").toLowerCase(), cmd: String(p.CommandLine || "") }));
  if (!rows.some((p) => p.pid === process.pid)) throw new Error("process list does not contain this process — not trusted");
  return rows;
}
/**
 * Every runner that loads one of the four files, plus the batch files / chain that launch them. cmd.exe reads a .bat incrementally, and a
 * node process that is mid-run must finish on the file it started with.
 */
const BUSY_NODE = /(close-chain\.cjs|backend[\\/](options-sleeve|r110-put-side-twin|r112-wing-cap-family|wing-loss-cap|options-settle|r21-halfprofit|r50-limit-twin|r21-roll|zero-dte-sleeve|r51-book|preflight)\.js)/i;
const BUSY_CMD = /(options-sleeve\.bat|intraday\.bat|board-discipline\.bat|pre-close\.bat|r21-roll\.bat|zero-dte-sleeve\.bat|close-chain)/i;
/**
 * FENCES — [] when clear, else the reasons. Fail closed: an unreadable process list or chain status is NOT clear.
 *   1. not 09:15-16:15 ET on a session day: risk-policy.js is read by runners all session (no mid-session version change), the R21 sleeve
 *      fires at 08:30 MT (10:30 ET) and the R21 twins / wing marks run intraday. Deploying before 09:15 ET is what makes OP11 bind the
 *      NEXT options-sleeve run.
 *   2. on a session day at/after 16:15 ET: tonight's close chain must have finished (chain-status.json started today ET and finished) —
 *      it runs options-settle, r110 and r112.
 *   3. no close-chain / R21-family / options-sleeve process running (node or cmd).
 */
function fences({ ms = Date.now() } = {}) {
  const why = [], et = etNow(ms), sess = sessionDay(et);
  if (sess && et.mins >= 9 * 60 + 15 && et.mins < 16 * 60 + 15) why.push(`${et.hms} ET is inside 09:15-16:15 ET on a session day — deploy after tonight's close chain or before 09:15 ET (the R21 sleeve fires 10:30 ET / 08:30 MT)`);
  if (sess && et.mins >= 16 * 60 + 15) {
    let ok = false, note = "";
    try { const c = JSON.parse(fs.readFileSync(path.join(REPO, "backend", "data", "chain-status.json"), "utf8")); ok = !!(c.started && etNow(Date.parse(c.started)).date === et.date && c.finished && Date.parse(c.finished) >= Date.parse(c.started)); note = `started ${c.started || "-"}, finished ${c.finished || "-"}`; }
    catch (e) { note = `unreadable (${e.code || e.message})`; }
    if (!ok) why.push(`tonight's close chain has not finished (chain-status.json ${note}) — wait for it`);
  }
  try {
    const hit = procs().filter((p) => p.pid !== process.pid && ((p.name === "node.exe" && BUSY_NODE.test(p.cmd)) || (p.name === "cmd.exe" && BUSY_CMD.test(p.cmd))));
    if (hit.length) why.push(`runner(s) in progress: ${hit.map((p) => `pid ${p.pid} ${p.cmd.replace(/\s+/g, " ").slice(0, 110)}`).join(" | ")}`);
  } catch (e) { why.push(`cannot read the process list (${String(e.message).slice(0, 100)}) — refusing to replace runner files blind`); }
  return why;
}
const loadManifest = () => JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const writeExact = (dest, buf, tag) => { const tmp = `${dest}.${tag}-tmp-${process.pid}`; fs.writeFileSync(tmp, buf); try { fs.renameSync(tmp, dest); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; } };
module.exports = { PKG_NAME, PKG, REPO, BACKUP_DIR, MANIFEST, FILES, sha256, shaFile, eolOf, hasBom, backupPathFor, livePath, stagedPath, basePath, etNow, mtNow, sessionDay, procs, fences, loadManifest, writeExact };
