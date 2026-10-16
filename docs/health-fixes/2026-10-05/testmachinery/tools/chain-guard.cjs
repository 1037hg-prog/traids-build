"use strict";
/**
 * chain-guard.cjs — is the TRAIDS close chain running, due, or idle? (package testmachinery, review round 2, 2026-10-05)
 *
 * WHY THIS EXISTS. The first deploy.cjs / rollback.cjs looked only at backend/data/chain-status.json ("started and not finished").
 * automation/close-chain.cjs builds that status IN MEMORY and writes the file ONCE, as its very last act (close-chain.cjs: `const
 * status = {...}` at the start, `fs.writeFileSync(D("chain-status.json"), ...)` at the end). While the chain runs, the file still
 * holds the PREVIOUS night's {started, finished} with finished > started, so that check could never fire — a deploy at 16:30 ET
 * would have swapped files under a running chain (the 10-02 chain ran 20:15:47Z..21:37:31Z, about 80 minutes).
 *
 * EVIDENCE USED — all of it read-only:
 *   LOG      automation/daily-run.log. daily-close.bat appends "======== CLOSE <date> <time> ========" when the close cycle starts,
 *            close-chain.cjs prints "CLOSE CHAIN · <ISO> · ..." when it starts and "... · written: chain-status.json" as its LAST line.
 *            A start marker AFTER the last "written:" line means a close cycle is in progress (or died without finishing).
 *   PROCESS  Win32_Process command lines (PowerShell Get-CimInstance, a read-only query) naming close-chain.cjs or daily-close.bat.
 *            Command lines of elevated / other-user processes are hidden from a normal query, so ABSENCE proves nothing: this is
 *            positive evidence only, and a failed query is reported but decides nothing.
 *   CLOCK    on a trading day (weekday, not in lib/run-window.js MARKET_HOLIDAYS), from 15:45 ET until chain-status.json.finished is
 *            dated today (ET), tonight's chain is due, running or unfinished. 15:45-16:20 ET is the start window itself (the chain
 *            starts 16:15 ET; the margin lets a deploy's selftest — and its automatic restore — finish before it).
 *
 * VERDICT (fail closed — UNKNOWN refuses exactly like RUNNING, it is only overridable):
 *   RUNNING       hard refusal, NO override: a close-chain / daily-close process is visible, the log shows a cycle that started
 *                 less than 4 h ago and has not written chain-status.json, or it is 15:45-16:20 ET on a trading day.
 *   NOT_FINISHED  refusal; `--force-after-chain` overrides once the operator has confirmed the chain is not running (e.g. it did
 *                 not start tonight, or a missed start will not run).
 *   UNKNOWN       refusal; `--force-after-chain` overrides: the log or chain-status.json is unreadable, or a cycle started >= 4 h
 *                 ago and never wrote chain-status.json (died or hung).
 *   IDLE          go.
 *
 * assess() is PURE (inputs in, verdict out) so it is tested against real daily-run.log tails and real chain-status.json versions
 * from git (tests/chain-guard-real-log.cjs). probe() gathers the live inputs.
 */
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");

const HOUR = 3600e3;
const WINDOW_FROM = "15:45", WINDOW_TO = "16:20";   // ET, trading days: the chain starts 16:15 ET; 30 min margin for a deploy + its selftest
const etParts = (d) => {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" });
  const o = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
  const hh = o.hour === "24" ? "00" : o.hour;
  return { date: `${o.year}-${o.month}-${o.day}`, hm: `${hh}:${o.minute}`, weekday: o.weekday };
};

/** Last line index of each marker in a daily-run.log tail, and the start time of an unfinished cycle. Pure. */
function scanLog(text) {
  const lines = String(text).split(/\r?\n/);
  let closeAt = -1, chainAt = -1, writtenAt = -1, closeLine = null, chainLine = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^======== CLOSE\b/.test(l)) { closeAt = i; closeLine = l; }
    else if (/^CLOSE CHAIN · /.test(l)) { chainAt = i; chainLine = l; }
    else if (/· written: chain-status\.json\s*$/.test(l)) writtenAt = i;
  }
  const startAt = Math.max(closeAt, chainAt);
  const inProgress = startAt > writtenAt;
  let startedMs = null, startedText = null;
  if (inProgress) {
    if (chainAt > writtenAt && chainLine) {             // close-chain.cjs printed its ISO start
      const m = chainLine.match(/^CLOSE CHAIN · (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/);
      if (m) { startedMs = Date.parse(m[1]); startedText = m[1]; }
    }
    if (startedMs == null && closeAt > writtenAt && closeLine) {   // daily-close.bat marker: %DATE% %TIME% in the box's local time
      const m = closeLine.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
      if (m) { const d = new Date(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]); startedMs = d.getTime(); startedText = closeLine.trim(); }
    }
  }
  return { closeAt, chainAt, writtenAt, inProgress, startedMs, startedText, lines: lines.length };
}

/**
 * assess({ now, logText, chainStatus, procs, isHoliday }) -> { verdict, overridable, reasons[], facts }
 *   now          Date
 *   logText      tail of automation/daily-run.log (string) or null if unreadable
 *   chainStatus  parsed backend/data/chain-status.json or null if unreadable
 *   procs        { ok: boolean, lines: string[] } — process command lines (null = not queried)
 *   isHoliday    (etDate "YYYY-MM-DD") -> holiday name | null
 */
function assess({ now = new Date(), logText = null, chainStatus = null, procs = null, isHoliday = () => null } = {}) {
  const et = etParts(now);
  const trading = !["Sat", "Sun"].includes(et.weekday) && !isHoliday(et.date);
  const hard = [], soft = [], unknown = [], info = [];

  // PROCESS — positive evidence only
  if (procs && procs.ok) {
    const hit = (procs.lines || []).filter((l) => /close-chain\.cjs|daily-close\.bat/i.test(l));
    if (hit.length) hard.push(`a close-chain process is running: ${hit.map((l) => l.trim().slice(0, 140)).join(" | ")}`);
  } else if (procs) info.push("process list could not be read (positive-evidence check only; the log and clock checks still apply)");

  // LOG
  let scan = null;
  if (logText == null) unknown.push("automation/daily-run.log could not be read — cannot tell whether a close cycle is in progress");
  else {
    scan = scanLog(logText);
    if (scan.inProgress) {
      if (scan.startedMs == null) unknown.push(`daily-run.log shows a close cycle started (line ${Math.max(scan.closeAt, scan.chainAt) + 1} of the tail) with no "written: chain-status.json" after it, and its start time cannot be parsed`);
      else {
        const ageH = (now.getTime() - scan.startedMs) / HOUR;
        if (ageH < 4) hard.push(`daily-run.log: a close cycle started ${scan.startedText} (${(ageH * 60).toFixed(0)} min ago) and has not written chain-status.json yet — the chain is running`);
        else unknown.push(`daily-run.log: a close cycle started ${scan.startedText} (${ageH.toFixed(1)} h ago) and never wrote chain-status.json — it died or is hung; confirm no close-chain.cjs is running before overriding`);
      }
    }
  }

  // CLOCK
  if (trading && et.hm >= WINDOW_FROM && et.hm < WINDOW_TO) hard.push(`ET ${et.hm} on a trading day: the close chain starts at 16:15 ET — ${WINDOW_FROM}-${WINDOW_TO} ET is its start window (a deploy and its selftest must finish before it)`);
  if (trading && et.hm >= WINDOW_FROM) {
    if (!chainStatus || !chainStatus.finished) unknown.push("backend/data/chain-status.json is unreadable or has no `finished` — cannot confirm tonight's chain has finished");
    else {
      const fin = etParts(new Date(chainStatus.finished)).date;
      if (fin !== et.date) soft.push(`tonight's close chain (16:15 ET, ${et.date}) has not finished: chain-status.json.finished is ${chainStatus.finished} (ET ${fin}) — wait for it to finish, or deploy before ${WINDOW_FROM} ET tomorrow`);
    }
  }

  const verdict = hard.length ? "RUNNING" : unknown.length ? "UNKNOWN" : soft.length ? "NOT_FINISHED" : "IDLE";
  return { verdict, overridable: verdict === "UNKNOWN" || verdict === "NOT_FINISHED", reasons: [...hard, ...unknown, ...soft], info,
    facts: { etDate: et.date, etHM: et.hm, tradingDay: trading, log: scan && { inProgress: scan.inProgress, startedText: scan.startedText, lastClose: scan.closeAt, lastChainStart: scan.chainAt, lastWritten: scan.writtenAt }, chainStatus: chainStatus ? { started: chainStatus.started, finished: chainStatus.finished } : null } };
}

/** Live inputs, read-only. `repo` is the repo root. */
function probe(repo) {
  let logText = null;
  try {
    const p = path.join(repo, "automation", "daily-run.log");
    const fd = fs.openSync(p, "r");
    try { const size = fs.fstatSync(fd).size, n = Math.min(size, 4 * 1024 * 1024), buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, size - n); logText = buf.toString("utf8"); }
    finally { fs.closeSync(fd); }
  } catch { logText = null; }
  let chainStatus = null;
  try { chainStatus = JSON.parse(fs.readFileSync(path.join(repo, "backend", "data", "chain-status.json"), "utf8")); } catch { chainStatus = null; }
  let procs;
  try {
    // node.exe / cmd.exe command lines only; the filter on the strings happens in JS, so this query's own command line cannot match
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='cmd.exe'\" | ForEach-Object { [string]$_.ProcessId + ' ' + [string]$_.CommandLine }"],
      { encoding: "utf8", timeout: 30000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    procs = r.status === 0 && !r.error ? { ok: true, lines: String(r.stdout || "").split(/\r?\n/).filter(Boolean) } : { ok: false, lines: [] };
  } catch { procs = { ok: false, lines: [] }; }
  let isHoliday = () => null;
  try { const rw = require(path.join(repo, "backend", "lib", "run-window.js")); if (typeof rw.marketHoliday === "function") isHoliday = rw.marketHoliday; } catch { /* no holiday list: every weekday counts as a trading day (more refusals, never fewer) */ }
  return { logText, chainStatus, procs, isHoliday };
}

/** probe + assess; `force` = --force-after-chain. Returns { ok, verdict, reasons, info, facts, forced }. */
function check(repo, { force = false, now = new Date() } = {}) {
  const a = assess({ now, ...probe(repo) });
  const ok = a.verdict === "IDLE" || (force && a.overridable);
  return { ok, forced: ok && a.verdict !== "IDLE", ...a };
}

module.exports = { assess, scanLog, probe, check, etParts, WINDOW_FROM, WINDOW_TO };
