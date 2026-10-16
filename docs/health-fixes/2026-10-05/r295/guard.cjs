#!/usr/bin/env node
/**
 * R295 v7 package guard (docs/health-fixes/2026-10-05/r295, review fix 2026-10-05): the "may the R295 runner or ledger be written by hand
 * now?" rule shared by deploy.cjs and rollback.cjs. et(), offset, etMs and chainSettled() below are COPIED byte-for-byte from the staged
 * runner, which applies the same rule to --resolve-overexit --apply; harness/guard-parity.cjs checks the copy and runs the case table.
 * chain-status.json is written ONCE, at the END of a close-chain run, so a running chain does not show in it: the rule asks whether a chain
 * that started after the newest R295 session's close has FINISHED and whether that session is reconciled (its after-close wrote the row);
 * on a weekday at/after 16:00 ET the chain must have started today. A visible close-chain.cjs / r295 --after-close process refuses too, and
 * a failed process scan refuses (fail closed). This file is a module: it starts nothing, signals nothing and writes nothing.
 */
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process");
function et(ms = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hms: `${p.hour === "24" ? "00" : p.hour}:${p.minute}:${p.second}` };
}
const offset = (date) => { const probe = new Date(`${date}T12:00:00Z`); const h = +new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(probe); return h === 8 ? "-04:00" : "-05:00"; };
const etMs = (date, hms) => Date.parse(`${date}T${hms}${offset(date)}`);
function chainSettled({ chain, latest, procs, nowMs }) {
  if (procs instanceof Error || !Array.isArray(procs)) return { ok: false, why: `process scan failed (${procs && procs.message ? procs.message.slice(0, 80) : "no result"}) — cannot tell whether the close chain is running` };
  const busy = procs.filter((c) => /close-chain\.cjs/i.test(c) || /r295-orb-forward\.js.*--after-close/i.test(c));
  if (busy.length) return { ok: false, why: `running now: ${busy.map((c) => c.replace(/\s+/g, " ").slice(-90)).join(" | ")}` };
  const st = chain && Date.parse(chain.started), fi = chain && Date.parse(chain.finished);
  if (!Number.isFinite(st) || !Number.isFinite(fi) || !(fi > st)) return { ok: false, why: `chain-status.json has no finished run (started ${chain && chain.started}, finished ${chain && chain.finished})` };
  const now = et(nowMs), dow = new Date(`${now.date}T12:00:00Z`).getUTCDay();
  if (latest) {
    if (!latest.reconciled) return { ok: false, why: `R295 session ${latest.date} is not reconciled — the close chain's R295 after-close has not written its row yet (if the chain has finished, its R295 step failed: run node backend/r295-orb-forward.js --after-close ${latest.date} --live first)` };
    if (st < etMs(latest.date, "16:00:00")) return { ok: false, why: `the last finished close chain started ${chain.started}, before R295 session ${latest.date} closed — that session's chain has not finished` };
  }
  if (dow >= 1 && dow <= 5 && now.hms >= "16:00:00" && et(st).date !== now.date) return { ok: false, why: `${now.date} ${now.hms} ET: today's close chain has not finished (last finished run started ${chain.started})` };
  return { ok: true, why: `close chain finished ${chain.finished} (started ${chain.started})${latest ? `; R295 ${latest.date} reconciled` : ""}` };
}
/** The inputs of chainSettled() for the backend dir bk: chain-status.json and the newest R295 session state at or before today (ET), plus
 *  scan() = the visible node.exe command lines (default psScan; a scan that throws is passed on as an Error and refuses). */
function chainGuardNow(bk, nowMs = Date.now(), scan = psScan) {
  let chain = null; try { chain = JSON.parse(fs.readFileSync(path.join(bk, "data", "chain-status.json"), "utf8")); } catch {}
  const cache = path.join(bk, "data", "training", "r295"), today = et(nowMs).date;
  const dates = (fs.existsSync(cache) ? fs.readdirSync(cache) : []).map((f) => /^session-(\d{4}-\d{2}-\d{2})\.json$/.exec(f)).filter(Boolean).map((m) => m[1]).filter((d) => d <= today).sort();
  let latest = null; if (dates.length) { const d = dates[dates.length - 1]; let rec = false; try { rec = !!JSON.parse(fs.readFileSync(path.join(cache, `session-${d}.json`), "utf8")).reconciled; } catch {} latest = { date: d, reconciled: rec }; }
  let procs; try { procs = scan(); } catch (e) { procs = e; }
  return { ...chainSettled({ chain, latest, procs, nowMs }), latest, visibleNodeProcesses: Array.isArray(procs) ? procs.length : null };
}
/** A read-only PowerShell CIM query of node.exe command lines (never signals anything). Command lines Windows hides (elevated processes) come
 *  back empty and are dropped — not evidence either way; the date rule in chainSettled() is the guard. Throws when the query fails. */
function psScan() {
  const r = cp.spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { [string]$_.CommandLine }"], { encoding: "utf8", timeout: 60000, windowsHide: true });
  if (r.error || r.status !== 0) throw new Error(r.error ? r.error.message : `powershell exit ${r.status}: ${String(r.stderr || "").slice(0, 80)}`);
  return String(r.stdout || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}
module.exports = { chainSettled, chainGuardNow, psScan, et, etMs };
