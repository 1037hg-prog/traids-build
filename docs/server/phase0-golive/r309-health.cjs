#!/usr/bin/env node
/**
 * R309 HEALTH — is the VPS completing hourly R309 cycles? 2026-10-06 (review finding F8). Home side, read-only.
 *
 * One ssh (BatchMode, no prompt) runs a read-only probe on `traids`: the unit's last result and exit time (systemctl show,
 * unix timestamps), the timer's enabled/active state, the unit's ExecStart (--dry or --live) BOTH on disk and as systemd has it
 * loaded (NeedDaemonReload), the server's clock, the OFF / HALT switches and the tail of backend/data/r309-cycles.jsonl. Judged
 * here on node's Date.now() (the Git Bash clock has been hours wrong on this PC; never `date`). Plus one home check: once the
 * pulled config carries evidenceStart, R309's registry entry must hold the dated note for that day (register-evidence-start.cjs).
 *
 *   PASS     DRY unit: the timer is enabled and active, the last run ended Result=success within --max-age-min, the VPS ledger
 *            has no unfinished lot, and — if R309 has ever run live — data/r309-unflipped (rollback.cjs --unflip) is newer than
 *            the last live row (a DRY unit with live history and no such marker is an accidental un-flip: FAIL).
 *            LIVE unit: that, AND the last live cycle row has no errors, AND the last live row with coins.BTC.ok, coins.ETH.ok
 *            and account.ok is younger than --max-age-min (default 75 = the :02 cycle + an hour + slack). Within 75 min of the
 *            flip to --live with no live row yet: PASS "awaiting the first live cycle".
 *   WARN     the VPS is PASS, but the pulled evidenceStart has no dated registry note yet (less than 24 h since it was set).
 *   FAIL     anything else that was read: timer off, the unit failed, the last run too old, a live row with errors, no healthy
 *            live row inside the window, a corrupt cycle row, server clock > 5 min off, systemd still running another definition
 *            than the file (NeedDaemonReload=yes or the loaded ExecStart's mode differs from the file's: an interrupted flip /
 *            unflip / units step), the evidence-start registry note missing 24 h after the start was set (or naming another day).
 *   UNKNOWN  the server could not be read (ssh down, timeout, an incomplete probe), or the home note check could not run. As loud
 *            as FAIL (fail-open invariant): in preflight both are level warn, ok=false (DEGRADED, never NO-GO — R309 gates no home
 *            trading; its own --alert channel below is the loud one).
 *
 *   node docs/server/phase0-golive/r309-health.cjs [--json] [--host traids] [--max-age-min 75]
 *   node docs/server/phase0-golive/r309-health.cjs --selftest          (fixtures only; no ssh, no file)
 *   node backend/lib/r309-health.cjs --alert [--pull-rc N]   the hourly alarm, run by the pull task (deploy\server\pull-r309.bat
 *            passes the pull's exit code): a failing pull on TWO runs in a row is its own not-PASS reason. Debounced: NEW only on the
 *            SECOND consecutive not-PASS run; a different failure class seen twice in a row pages NEW at once (not a 6 h STILL);
 *            STILL every 6 h; RECOVERED only after a NEW / STILL was delivered. Through home backend/notify.js (Telegram, email
 *            off); state in backend/data/r309-health-alert.json, an alarm recorded only once delivered. Runs while the PC is awake
 *            and Josh is logged on (see NOTES: nights and weekends while the PC sleeps are covered by the VPS's own OnFailure alerts).
 * Exit 0 PASS · 5 WARN · 3 FAIL · 1 UNKNOWN. Installed at home as backend/lib/r309-health.cjs by deploy.cjs; preflight.js and
 * ops-health.js require it (check(), run()).
 */
"use strict";
const cp = require("child_process");

const NAME = "r309 server cycle";
const DATA = "/home/traids/traids/backend/data", UNIT = "traids-r309.service", TIMER = "traids-r309.timer", UNIT_FILE = "/etc/systemd/system/traids-r309.service";
const SKEW_MS = 5 * 60000, NOTE_FAIL_MS = 24 * 3600000;
const PROBE = [
  'echo "@@NOW"; date -u +%s',
  `echo "@@SHOW"; systemctl show ${UNIT} --timestamp=unix -p Result -p ExecMainStatus -p ExecMainExitTimestamp -p ActiveState -p NeedDaemonReload 2>&1`,
  `echo "@@LOADED"; systemctl show ${UNIT} -p ExecStart --no-pager 2>&1`,
  `echo "@@TIMERRELOAD"; systemctl show ${TIMER} -p NeedDaemonReload --no-pager 2>&1`,
  `echo "@@TIMER"; systemctl is-enabled ${TIMER} 2>&1; systemctl is-active ${TIMER} 2>&1`,
  `echo "@@EXEC"; grep -m1 '^ExecStart=' ${UNIT_FILE} 2>&1`,
  `echo "@@UNITMTIME"; stat -c %Y ${UNIT_FILE} 2>&1`,
  `echo "@@SWITCHES"; for f in r309-OFF r309-HALT; do [ -e "${DATA}/$f" ] && echo "$f"; done`,
  `echo "@@UNFLIPPED"; stat -c %Y "${DATA}/r309-unflipped" 2>/dev/null`,
  `echo "@@TAIL"; tail -n 300 "${DATA}/r309-cycles.jsonl" 2>/dev/null`,
  `echo "@@LEDGER"; cat "${DATA}/r309-ledger.jsonl" 2>/dev/null`,
  'echo "@@END"',
].join("; ");
const UNFINISHED = ["submitting", "submit-error", "submitted", "open", "exiting", "error"];
const CODE = { PASS: 0, WARN: 5, FAIL: 3, UNKNOWN: 1 };

function sections(text) {
  const out = {}; let cur = null;
  for (const ln of String(text || "").split(/\r?\n/)) { const m = /^@@([A-Z]+)$/.exec(ln.trim()); if (m) { cur = m[1]; out[cur] = []; continue; } if (cur) out[cur].push(ln); }
  return out;
}
const ago = (ms) => (ms < 90 * 60000 ? `${Math.round(ms / 60000)} min` : `${(ms / 3600000).toFixed(1)} h`);
/** mode of an ExecStart command line (the file's line, or the argv[] systemd has loaded): LIVE | DRY | null */
const modeOfCmd = (s) => { s = String(s || ""); return /\s--live(\s|$)/.test(s) && !/\s--dry(\s|$)/.test(s) ? "LIVE" : /\s--dry(\s|$)/.test(s) && !/\s--live(\s|$)/.test(s) ? "DRY" : null; };
/** the loaded ExecStart as `systemctl show -p ExecStart` prints it: "ExecStart={ path=... ; argv[]=<cmd> ; ... }" -> <cmd> */
const loadedArgv = (lines) => { const m = /argv\[\]=([^;]*)/.exec((lines || []).join(" ")); return m ? m[1].trim() : ""; };

/** Pure: probe text + home clock -> { status: PASS|FAIL|UNKNOWN, code, klass, detail, mode }. klass names the failure (alarm de-dup). */
function evaluate(text, nowMs, { maxAgeMin = 75 } = {}) {
  const S = sections(text), maxMs = maxAgeMin * 60000;
  const R = (status, klass, detail, extra = {}) => ({ status, code: CODE[status], klass, detail, ...extra });
  if (!S.END || !S.NOW || !S.SHOW || !S.TIMER || !S.EXEC || !S.LOADED || !S.TIMERRELOAD) return R("UNKNOWN", "probe", "the server probe came back incomplete — R309's state on the VPS is unverified");
  const srvNow = Number((S.NOW[0] || "").trim()) * 1000;
  if (!Number.isFinite(srvNow) || srvNow <= 0) return R("UNKNOWN", "probe", "the server's clock could not be read");
  const sw = (S.SWITCHES || []).map((x) => x.trim()).filter(Boolean), swTxt = sw.length ? ` · server switches: ${sw.join(", ")}${sw.includes("r309-HALT") ? " (HALT: nothing is sent)" : ""}` : "";
  if (Math.abs(srvNow - nowMs) > SKEW_MS) return R("FAIL", "clock", `the VPS clock is ${ago(Math.abs(srvNow - nowMs))} ${srvNow > nowMs ? "ahead of" : "behind"} this PC — the cycle times cannot be trusted${swTxt}`);
  const show = Object.fromEntries(S.SHOW.map((l) => l.split("=")).filter((p) => p.length >= 2).map(([k, ...v]) => [k.trim(), v.join("=").trim()]));
  const [enabled, active] = S.TIMER.map((x) => x.trim()).filter(Boolean);
  const exec = (S.EXEC.find((l) => /^ExecStart=/.test(l.trim())) || "").trim();
  const mode = modeOfCmd(exec);
  if (!exec) return R("FAIL", "unit", `${UNIT_FILE} has no ExecStart line (unit missing?)${swTxt}`);
  if (!mode) return R("FAIL", "unit", `cannot tell DRY from LIVE in the unit's ExecStart (${exec.slice(0, 120)})${swTxt}`);
  // what systemd RUNS is the loaded definition, not the file: an interrupted flip / unflip / units step leaves them apart
  const loaded = modeOfCmd(loadedArgv(S.LOADED)), timerReload = /NeedDaemonReload=yes/.test((S.TIMERRELOAD || []).join(" "));
  if (show.NeedDaemonReload === "yes" || timerReload) return R("FAIL", "reload", `systemd has NOT loaded the unit files on disk (NeedDaemonReload=yes${timerReload ? " on the timer" : ""}): the file says ${mode}, systemd runs ${loaded || "?"} — an interrupted flip / unflip / units step; re-run it (it reloads)${swTxt}`, { mode: loaded || mode });
  if (!loaded) return R("FAIL", "unit", `systemd reports no loaded ExecStart for ${UNIT} (the file says ${mode})${swTxt}`, { mode });
  if (loaded !== mode) return R("FAIL", "reload", `systemd runs ${loaded} but the unit file says ${mode} — re-run the interrupted step (deploy --flip-live / rollback --unflip)${swTxt}`, { mode: loaded });
  const unitMtime = Number(((S.UNITMTIME || [])[0] || "").trim()) * 1000;
  const sinceFlip = Number.isFinite(unitMtime) && unitMtime > 0 ? nowMs - unitMtime : Infinity;
  if (enabled !== "enabled" || active !== "active") return R("FAIL", "timer", `${TIMER} is ${enabled || "?"} / ${active || "?"} — no hourly cycles are scheduled (${mode})${swTxt}`, { mode });
  const exitSec = /^@(\d+)$/.exec(show.ExecMainExitTimestamp || ""), lastRun = exitSec ? Number(exitSec[1]) * 1000 : null;
  if (lastRun == null) {
    if (sinceFlip <= maxMs) return R("PASS", null, `${mode}: the unit has not run since it was installed ${ago(sinceFlip)} ago — awaiting the first :02 UTC cycle${swTxt}`, { mode });
    return R("FAIL", "never-ran", `${mode}: ${UNIT} has never completed a run${swTxt}`, { mode });
  }
  // staleness BEFORE the result: a timer that stopped firing is its own failure class even when the last run failed (an 'error'
  // lot ends every hourly run Result=exit-code), so the alarm sees a class change and pages NEW in about 2 h, not a 6 h STILL
  const failed = !!show.Result && show.Result !== "success";
  if (nowMs - lastRun > maxMs) return R("FAIL", "stale", `${mode}: the last run ended ${ago(nowMs - lastRun)} ago (limit ${maxAgeMin} min) — the timer is not firing or the host was down${failed ? ` (that run ended Result=${show.Result} exit ${show.ExecMainStatus || "?"})` : ""}${swTxt}`, { mode });
  if (failed) return R("FAIL", "result", `${mode}: the last run ended Result=${show.Result} exit ${show.ExecMainStatus || "?"} (${ago(nowMs - lastRun)} ago) — journalctl -u ${UNIT} on the VPS${swTxt}`, { mode });
  const lines = (S.TAIL || []).map((l) => l.trim()).filter(Boolean), rows = [];
  for (let i = 0; i < lines.length; i++) { try { rows.push(JSON.parse(lines[i])); } catch { if (i < lines.length - 1) return R("FAIL", "corrupt", `r309-cycles.jsonl has a corrupt row ${lines.length - i} from the end${swTxt}`, { mode }); } }
  const live = rows.filter((r) => r && r.live);
  if (mode === "DRY") {
    // a DRY unit sends nothing — not even the SELL at 48 h. Before the first flip that is the plan; after live history it is a
    // hazard unless the operator un-flipped deliberately (rollback.cjs --unflip writes data/r309-unflipped) and nothing is open.
    const led = (S.LEDGER || []).map((l) => l.trim()).filter(Boolean), open = [];
    for (const l of led) { let r; try { r = JSON.parse(l); } catch { return R("FAIL", "corrupt", `DRY: r309-ledger.jsonl has an unreadable row — cannot tell whether a lot is left open${swTxt}`, { mode }); } if (r && r.kind === "lot" && UNFINISHED.includes(r.status)) open.push(`${r.id} ${r.status}`); }
    if (open.length) return R("FAIL", "dry-open", `DRY unit with ${open.length} unfinished R309 lot(s) (${open.slice(0, 3).join(", ")}) — a dry unit never sells at 48 h; flip back to --live or resolve them${swTxt}`, { mode });
    if (live.length) {
      const lastLive = live[live.length - 1], lastLiveMs = Date.parse(lastLive.ts), mk = Number(((S.UNFLIPPED || [])[0] || "").trim()) * 1000;
      if (!(mk > 0 && Number.isFinite(lastLiveMs) && mk >= lastLiveMs)) return R("FAIL", "dry-unflip", `the unit is DRY but R309 has run LIVE (last live row ${lastLive.ts}) and there is no deliberate-unflip marker newer than it (rollback.cjs --unflip writes data/r309-unflipped) — un-flipped by accident?${swTxt}`, { mode });
      return R("PASS", null, `DRY, un-flipped deliberately ${ago(nowMs - mk)} ago (data/r309-unflipped), no unfinished lot; last dry cycle ended ${ago(nowMs - lastRun)} ago, Result=success${swTxt}`, { mode });
    }
    return R("PASS", null, `DRY (not live yet): last dry cycle ended ${ago(nowMs - lastRun)} ago, Result=success; a dry run writes no cycle row by design${swTxt}`, { mode });
  }
  // LIVE: the cycle log is the evidence of work
  if (!live.length) {
    if (sinceFlip <= maxMs) return R("PASS", null, `LIVE since ${ago(sinceFlip)} ago — awaiting the first live cycle row${swTxt}`, { mode });
    return R("FAIL", "live-norow", `LIVE, but r309-cycles.jsonl has no live row (flipped ${Number.isFinite(sinceFlip) ? ago(sinceFlip) + " ago" : "at an unknown time"})${swTxt}`, { mode });
  }
  const last = live[live.length - 1];
  if (Array.isArray(last.errors) && last.errors.length) return R("FAIL", "live-errors", `LIVE: the last cycle (hour ${last.evaluatedHour}, ${last.ts}) recorded ${last.errors.length} error(s): ${String(last.errors[0]).slice(0, 160)}${swTxt}`, { mode, last: last.ts });
  const healthy = [...live].reverse().find((r) => r.coins && r.coins.BTC && r.coins.BTC.ok && r.coins.ETH && r.coins.ETH.ok && r.account && r.account.ok === true);
  if (!healthy) return R("FAIL", "live-unhealthy", `LIVE: no live cycle with BTC and ETH evaluated and the account check passed in the last ${live.length} live row(s)${swTxt}`, { mode });
  const age = nowMs - Date.parse(healthy.ts);
  if (!(age <= maxMs)) return R("FAIL", "live-stale", `LIVE: the last healthy cycle (hour ${healthy.evaluatedHour}) was ${Number.isFinite(age) ? ago(age) : "at an unknown time"} ago (limit ${maxAgeMin} min)${healthy !== last ? ` · the last row (hour ${last.evaluatedHour}) was not healthy` : ""}${swTxt}`, { mode });
  return R("PASS", null, `LIVE: last healthy cycle hour ${healthy.evaluatedHour}, ${ago(age)} ago (both coins evaluated, TV account ok, no errors)${swTxt}`, { mode, last: healthy.ts });
}

/** Pure (N16): the registered dated evidence-start note. cfg = the PULLED config (backend/data/r309-surge-hold48.json), entry = R309's
 *  registry entry (or a function returning it, read only when needed). -> null (nothing owed / noted) | { level: WARN|FAIL, detail } */
function noteCheck(cfg, entry, nowMs) {
  const day = cfg && cfg.evidenceStart;
  if (!day) return null;
  const e = typeof entry === "function" ? entry() : entry;
  if (!e) return { level: "FAIL", detail: "R309 is not in backend/data/test-registry.json — the evidence-start note has nowhere to go" };
  const notes = (e.amendments || []).filter((a) => a && /evidence-start/.test(String(a.kind || "") + " " + String(a.id || "")) && a.evidenceStart);
  if (notes.some((a) => a.evidenceStart === day)) return null;
  if (notes.length) return { level: "FAIL", detail: `R309's registry notes evidence start ${notes.map((a) => a.evidenceStart).join(", ")} but the VPS config says ${day} — the start never changes; investigate before anything else` };
  const setMs = Date.parse(cfg.evidenceStartSetAt), age = nowMs - setMs;
  const what = `evidenceStart ${day} (set on the VPS ${Number.isFinite(age) ? ago(Math.max(0, age)) + " ago" : "at an unknown time"} by ${cfg.evidenceStartBy || "?"}) has no dated note in R309's registry entry — node docs/server/phase0-golive/register-evidence-start.cjs`;
  if (Number.isFinite(age) && age < NOTE_FAIL_MS) return { level: "WARN", detail: what };
  return { level: "FAIL", detail: `${what} (overdue: more than 24 h)` };
}
/** home files for noteCheck: the pulled config and (lazily) R309's registry entry. Throws when a present file cannot be read. */
function homeFacts() {
  const fs = require("fs"), path = require("path");
  const REPO = (() => { for (let d = __dirname; ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, "backend", "data")) && fs.existsSync(path.join(d, "deploy"))) return d; if (path.dirname(d) === d) throw new Error("repo root not found above " + __dirname); } })();
  const f = path.join(REPO, "backend", "data", "r309-surge-hold48.json");
  const cfg = fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")).config || null) : null;   // absent = not pulled yet = no start to note
  const entry = () => { const r = JSON.parse(fs.readFileSync(path.join(REPO, "backend", "data", "test-registry.json"), "utf8")); return [...(r.tests || []), ...(r.preregistered || [])].find((t) => t && t.id === "R309") || null; };
  return { cfg, entry };
}
/** Pure: the VPS verdict + the note check -> one verdict */
function combine(v, n) {
  if (!n) return v;
  if (v.status === "PASS") return { ...v, status: n.level, code: CODE[n.level], klass: "note", detail: `${n.detail} · VPS: ${v.detail}` };
  return { ...v, detail: `${v.detail} · also: ${n.detail}` };
}

/** ssh probe (async). Resolves { ok, text } or { ok:false, why }; never rejects. */
function probe({ host = "traids", timeoutMs = 30000 } = {}) {
  return new Promise((res) => {
    if (!/^[A-Za-z0-9._@-]+$/.test(host)) return res({ ok: false, why: "bad host name" });
    cp.execFile("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=12", host, PROBE], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err && !stdout) return res({ ok: false, why: `ssh ${host}: ${String(err.killed ? "timed out" : err.message || err).split("\n")[0].slice(0, 120)}${stderr ? " — " + String(stderr).trim().slice(0, 120) : ""}` });
      res({ ok: true, text: stdout });
    });
  });
}

/** One verdict: { status, code, klass, detail, mode }. */
async function run({ host = "traids", maxAgeMin = 75, nowImpl = Date.now, probeImpl = probe, homeImpl = homeFacts } = {}) {
  const p = await probeImpl({ host });
  let v;
  if (!p.ok) v = { status: "UNKNOWN", code: 1, klass: "ssh", detail: `the VPS could not be read (${p.why}) — R309's hourly cycle is unverified` };
  else { try { v = evaluate(p.text, nowImpl(), { maxAgeMin }); } catch (e) { v = { status: "UNKNOWN", code: 1, klass: "probe", detail: `the probe could not be judged (${String(e.message).slice(0, 100)})` }; } }
  let n = null;
  try { const h = homeImpl(); n = noteCheck(h.cfg, h.entry, nowImpl()); }
  catch (e) { n = { level: "UNKNOWN", detail: `the evidence-start registry-note check could not run (${String(e.message).slice(0, 100)})` }; }
  return combine(v, n);
}
/** Preflight-shaped result. Level WARN for FAIL and UNKNOWN alike (ok=false, as loud as each other): the line shows in the banner,
 *  daily-health and the evening report as DEGRADED, but R309 gates no home trading, so it never makes the home day NO-GO. */
async function check(opts = {}) {
  const v = await run(opts);
  const status = v.status === "PASS" ? "ok" : v.status === "FAIL" ? "CRITICAL" : v.status;   // WARN | UNKNOWN
  const detail = v.status === "PASS" ? v.detail : v.status === "UNKNOWN" ? (/^UNKNOWN/.test(v.detail) ? v.detail : `UNKNOWN — ${v.detail}`) : `${v.status} — ${v.detail}`;
  return { name: NAME, level: status === "ok" ? "info" : "warn", ok: status === "ok", detail, status };
}

/**
 * The alarm for the HOURLY PULL TASK (deploy\server\pull-r309.bat runs `r309-health.cjs --alert --pull-rc N` after each pull). Pure
 * on injected state. "bad" = FAIL or UNKNOWN (WARN pages nothing; its FAIL after 24 h does). class = status + klass.
 *   NEW        the SECOND consecutive bad run and nothing delivered yet in this episode (one bad hour pages nothing)
 *   NEW        a different class than the one last paged, seen on two runs in a row (a new failure is not held for a 6 h STILL)
 *   STILL      bad, the last delivered alarm >= reAlarmH hours ago
 *   RECOVERED  not bad after a DELIVERED alarm (an undelivered RECOVERED is retried)
 * The state records an alarm only once DELIVERED. Returns { send: null | { kind, title, body }, next(delivered) -> state }.
 */
const BAD = (s) => s !== "PASS" && s !== "WARN";
const LABEL = { pull: "the home pull is failing", note: "evidence-start registry note" };
function alarmPlan(v, prev, nowMs, { reAlarmH = 6 } = {}) {
  const p = prev && typeof prev === "object" ? prev : {}, bad = BAD(v.status), wasBad = !!p.status && BAD(p.status);
  const klass = bad ? `${v.status}:${v.klass || "?"}` : "ok";
  const base = { status: v.status, klass, detail: String(v.detail || "").slice(0, 300), checkedAt: new Date(nowMs).toISOString() };
  const msg = (kind, extra = "") => ({ kind, title: `R309 ${kind === "RECOVERED" ? "RECOVERED" : v.status}${kind === "STILL" ? " (still)" : ""} — ${LABEL[v.klass] || "VPS cycle"}`,
    body: `${v.detail}\n\n(hourly check from the PC after the pull: r309-health --alert. ${extra}Paged on the second bad run in a row. The VPS's own OnFailure alerts come on the ops bot.)` });
  if (bad) {
    const since = wasBad ? p.since || base.checkedAt : base.checkedAt;
    const badRuns = wasBad ? (p.badRuns || 1) + 1 : 1, klassRuns = wasBad && p.klass === klass ? (p.klassRuns || 1) + 1 : 1;
    const keep = { ...base, since, badRuns, klassRuns, alarmedAt: p.alarmedAt || null, alarmedKlass: p.alarmedKlass || null, lastAlarm: p.lastAlarm || null };
    let kind = null, extra = "";
    if (badRuns >= 2) {
      if (!p.alarmedAt) kind = "NEW";
      else if (klass !== p.alarmedKlass && klassRuns >= 2) { kind = "NEW"; extra = `A DIFFERENT failure than the one paged at ${p.alarmedAt} (${p.alarmedKlass}). `; }
      else if (nowMs - Date.parse(p.alarmedAt) >= reAlarmH * 3600000) { kind = "STILL"; extra = `Not PASS since ${since}. `; }
    }
    if (!kind) return { send: null, next: () => keep };
    const m = msg(kind, extra);
    return { send: m, next: (delivered) => (delivered ? { ...keep, alarmedAt: base.checkedAt, alarmedKlass: klass, lastAlarm: kind } : keep) };
  }
  if (wasBad && p.alarmedAt) { const m = msg("RECOVERED", `Not PASS from ${p.since} until now. `); return { send: m, next: (delivered) => (delivered ? { ...base, since: base.checkedAt, badRuns: 0, klassRuns: 0, alarmedAt: null, alarmedKlass: null, lastAlarm: "RECOVERED" } : { ...p, checkedAt: base.checkedAt, lastSeen: v.status }) }; }
  return { send: null, next: () => ({ ...base, since: wasBad || !p.status ? base.checkedAt : p.since || base.checkedAt, badRuns: 0, klassRuns: 0, alarmedAt: null, alarmedKlass: null, lastAlarm: p.lastAlarm || null }) };
}
/** Pure: the pull's exit code (from pull-r309.bat) -> the verdict the alarm judges, and the pull-failure streak. pullRc null = not
 *  given (an interactive run): the streak is left as it was. Two failing pulls in a row are their own not-PASS reason. */
function withPull(v, pullRc, prevStreak, pullLine) {
  if (pullRc == null) return { v, streak: prevStreak || 0 };
  const streak = pullRc === 0 ? 0 : (prevStreak || 0) + 1;
  if (pullRc === 0 || streak < 2) return { v, streak };
  const pd = `R309 pull failing: exit ${pullRc} on ${streak} runs in a row (${pullRc === 4 ? "home backend/data/r309-HALT is missing — restore it" : "ssh failed or the pulled files were refused"})${pullLine ? ": " + String(pullLine).slice(0, 220) : ""} — the home copy of R309's ledger is frozen (automation\\r309-pull.log)`;
  if (!BAD(v.status)) return { v: { status: "FAIL", code: 3, klass: "pull", detail: `${pd} · VPS: ${v.detail}`, mode: v.mode }, streak };
  return { v: { ...v, detail: `${v.detail} · also: ${pd}` }, streak };
}
/** --alert: run, fold in the pull, plan, send through home backend/notify.js (email:false), write backend/data/r309-health-alert.json */
async function alertRun({ host = "traids", maxAgeMin = 75, pullRc = null } = {}) {
  const fs = require("fs"), path = require("path");
  const REPO = (() => { for (let d = __dirname; ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, "backend", "data")) && fs.existsSync(path.join(d, "deploy"))) return d; if (path.dirname(d) === d) throw new Error("repo root not found above " + __dirname); } })();
  const { writeJsonAtomic } = require(path.join(REPO, "backend", "lib", "atomic-write.js")), file = path.join(REPO, "backend", "data", "r309-health-alert.json");
  let prev = null; try { prev = JSON.parse(fs.readFileSync(file, "utf8")); } catch { prev = null; }
  let pullLine = null;
  if (pullRc != null && pullRc !== 0) { try { const t = fs.readFileSync(path.join(REPO, "automation", "r309-pull.log"), "utf8").slice(-65536).split(/\r?\n/).filter((l) => /pull-r309 (FAILED|REFUSED)/.test(l)); pullLine = t.length ? t[t.length - 1] : null; } catch { pullLine = null; } }
  const v0 = await run({ host, maxAgeMin }), now = Date.now(), { v, streak } = withPull(v0, pullRc, prev && prev.pullFailStreak, pullLine), plan = alarmPlan(v, prev, now);
  let delivered = false;
  if (plan.send) { try { delivered = !!(await require(path.join(REPO, "backend", "notify.js")).notify(plan.send.title, plan.send.body, { priority: plan.send.kind === "RECOVERED" ? "default" : "high", tags: "warning", email: false })); } catch (e) { delivered = false; console.log("r309-health: alarm threw: " + String(e.message).slice(0, 120)); } }
  writeJsonAtomic(file, { ...plan.next(delivered), pullRc, pullFailStreak: streak });
  return { v, sent: plan.send ? `${plan.send.kind} ${delivered ? "delivered" : "NOT delivered (retried next run)"}` : "no alarm due" };
}

async function selftest() {
  let pass = 0, fail = 0;
  const chk = (name, cond, detail) => { if (cond) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail ? " — " + detail : "")); } };
  const NOW = Date.parse("2026-10-08T14:25:00Z"), s = (ms) => Math.floor(ms / 1000);
  const good = { BTC: { ok: true }, ETH: { ok: true } };
  const row = (ts, x = {}) => JSON.stringify({ ts, live: true, host: "vps", evaluatedHour: new Date(Date.parse(ts) - 62 * 60000).toISOString().slice(0, 13) + ":00:00Z", coins: good, account: { ok: true }, errors: [], ...x });
  const LIVE_EXEC = "ExecStart=/usr/bin/flock -n /home/traids/traids/backend/data/r309.flock /usr/local/bin/node r309-surge-hold48.js --cycle --live";
  const showLoaded = (execLine) => `ExecStart={ path=/usr/bin/flock ; argv[]=${String(execLine).replace(/^ExecStart=/, "")} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`;
  const P = ({ now = NOW, result = "success", status = "0", exitAt = NOW - 23 * 60000, timer = ["enabled", "active"], exec = LIVE_EXEC, loaded = null, need = "no", timerNeed = "no", mtime = NOW - 3 * 86400000, sw = [], unflipped = null, tail = [], ledger = [], end = true } = {}) =>
    ["@@NOW", String(s(now)), "@@SHOW", `Result=${result}`, `ExecMainStatus=${status}`, `ExecMainExitTimestamp=${exitAt == null ? "" : "@" + s(exitAt)}`, "ActiveState=inactive", `NeedDaemonReload=${need}`, "@@LOADED", loaded == null ? showLoaded(exec) : loaded, "@@TIMERRELOAD", `NeedDaemonReload=${timerNeed}`,
      "@@TIMER", ...timer, "@@EXEC", exec, "@@UNITMTIME", String(s(mtime)), "@@SWITCHES", ...sw,
      "@@UNFLIPPED", ...(unflipped == null ? [] : [String(s(unflipped))]), "@@TAIL", ...tail, "@@LEDGER", ...ledger, ...(end ? ["@@END"] : [])].join("\n");
  const E = (o) => evaluate(P(o), NOW);
  const fresh = [row("2026-10-08T13:02:05Z"), row("2026-10-08T14:02:09Z")];
  chk("LIVE: the last cycle 23 min ago, both coins, account ok, no errors -> PASS (exit 0)", E({ tail: fresh }).status === "PASS" && E({ tail: fresh }).code === 0);
  chk("LIVE: the last healthy row 3 h old -> FAIL (exit 3)", E({ tail: [row("2026-10-08T11:02:05Z")], exitAt: NOW - 20 * 60000 }).code === 3);
  chk("LIVE: the last row has an error -> FAIL, the error is named", /recorded 1 error\(s\): account: 401/.test(E({ tail: [...fresh, row("2026-10-08T14:02:59Z", { errors: ["account: 401 unauthorized"] })] }).detail));
  chk("LIVE: account not ok (unreadable keys) -> FAIL even though the cycle ran", E({ tail: [row("2026-10-08T14:02:09Z", { account: null })] }).status === "FAIL");
  chk("LIVE: Coinbase down (BTC not evaluated) -> FAIL", E({ tail: [row("2026-10-08T14:02:09Z", { coins: { BTC: { ok: false }, ETH: { ok: true } } })] }).status === "FAIL");
  chk("LIVE: a later DRY row does not count as a live cycle", E({ tail: [row("2026-10-08T11:02:05Z"), JSON.stringify({ ts: "2026-10-08T14:10:00Z", live: false, coins: good })] }).status === "FAIL");
  chk("LIVE: a torn LAST line (append in flight) is skipped, not a failure", E({ tail: [...fresh, '{"ts":"2026-10-08T15:0'] }).status === "PASS");
  chk("LIVE: a corrupt row in the middle -> FAIL", E({ tail: [fresh[0], "{bad", fresh[1]] }).status === "FAIL");
  chk("LIVE: flipped 20 min ago, no live row yet -> PASS awaiting; flipped 3 h ago and still none -> FAIL", /awaiting the first live cycle/.test(E({ tail: [], mtime: NOW - 20 * 60000 }).detail) && E({ tail: [] }).status === "FAIL");
  chk("the unit's last run failed (Result=exit-code) -> FAIL with the exit status", /Result=exit-code exit 2/.test(E({ tail: fresh, result: "exit-code", status: "2" }).detail) && E({ tail: fresh, result: "exit-code", status: "2" }).code === 3);
  chk("the last run ended 2 h ago (timer not firing / host down) -> FAIL", E({ tail: fresh, exitAt: NOW - 2 * 3600000 }).status === "FAIL");
  chk("the timer disabled or inactive -> FAIL", E({ tail: fresh, timer: ["disabled", "inactive"] }).status === "FAIL" && E({ tail: fresh, timer: ["enabled", "inactive"] }).status === "FAIL");
  const dry = "ExecStart=/usr/bin/flock -n /home/traids/traids/backend/data/r309.flock /usr/local/bin/node r309-surge-hold48.js --cycle --dry";
  chk("DRY: last dry run 23 min ago, success -> PASS (dry writes no rows by design)", E({ exec: dry }).status === "PASS" && /DRY/.test(E({ exec: dry }).detail));
  chk("DRY: the dry run failing -> FAIL", E({ exec: dry, result: "exit-code", status: "2" }).status === "FAIL");
  chk("DRY: never ran and installed 3 days ago -> FAIL; installed 10 min ago -> PASS awaiting", E({ exec: dry, exitAt: null }).status === "FAIL" && E({ exec: dry, exitAt: null, mtime: NOW - 10 * 60000 }).status === "PASS");
  chk("an ExecStart with both or neither flag -> FAIL", E({ exec: dry + " --live" }).status === "FAIL" && E({ exec: "ExecStart=/usr/local/bin/node r309-surge-hold48.js --cycle" }).status === "FAIL");
  // re-verification 2026-10-06: the file is not what runs — systemd keeps the loaded definition until daemon-reload
  const r1 = E({ tail: fresh, exec: dry, loaded: showLoaded(LIVE_EXEC), need: "yes" }), r2 = E({ tail: fresh, exec: dry, loaded: showLoaded(LIVE_EXEC) }), r3 = E({ tail: fresh, timerNeed: "yes" });
  chk("an interrupted unflip (file DRY, systemd still LIVE, NeedDaemonReload=yes) -> FAIL naming both; loaded mode differing without the flag -> FAIL; the timer needing a reload -> FAIL", r1.status === "FAIL" && r1.klass === "reload" && /file says DRY, systemd runs LIVE/.test(r1.detail) && r2.status === "FAIL" && /systemd runs LIVE but the unit file says DRY/.test(r2.detail) && r3.status === "FAIL" && /on the timer/.test(r3.detail), [r1.detail, r2.detail, r3.detail].join(" | "));
  chk("a probe without the loaded-state sections -> UNKNOWN (incomplete), never PASS", evaluate(P({ tail: fresh }).replace(/@@LOADED\n[^\n]*\n/, ""), NOW).status === "UNKNOWN");
  // review 2026-10-06 (fail-open): a silent un-flip (a failed read made a re-run install --dry over --live) used to read PASS "DRY"
  const lotRow = (status) => JSON.stringify({ kind: "lot", id: "r309-BTC-2026100813", coin: "BTC", status, exit: { legs: [{ status: "filled" }] } });
  chk("DRY with an unfinished lot on the ledger (open / exiting / error) -> FAIL (a dry unit never sells at 48 h); a closed lot does not count", ["open", "exiting", "error"].every((st) => /unfinished R309 lot/.test(E({ exec: dry, tail: fresh, ledger: [lotRow(st)], unflipped: NOW - 60000 }).detail)) && E({ exec: dry, tail: fresh, ledger: [lotRow("closed")], unflipped: NOW - 60000 }).status === "PASS");
  chk("DRY with live history and NO deliberate-unflip marker -> FAIL (un-flipped by accident?)", /un-flipped by accident/.test(E({ exec: dry, tail: fresh }).detail) && E({ exec: dry, tail: fresh }).code === 3);
  chk("DRY with live history and a marker OLDER than the last live row -> FAIL; NEWER -> PASS (deliberate)", E({ exec: dry, tail: fresh, unflipped: Date.parse("2026-10-08T13:30:00Z") }).status === "FAIL" && /un-flipped deliberately/.test(E({ exec: dry, tail: fresh, unflipped: Date.parse("2026-10-08T14:10:00Z") }).detail));
  chk("DRY with an unreadable ledger row -> FAIL (cannot tell whether a lot is open)", /unreadable row/.test(E({ exec: dry, ledger: ["{half"] }).detail));
  chk("the VPS clock 20 min off -> FAIL", E({ tail: fresh, now: NOW + 20 * 60000 }).status === "FAIL");
  chk("switches are named (HALT: nothing is sent)", /r309-HALT \(HALT: nothing is sent\)/.test(E({ tail: fresh, sw: ["r309-HALT"] }).detail));
  chk("an incomplete probe (no @@END) -> UNKNOWN (exit 1)", E({ tail: fresh, end: false }).status === "UNKNOWN" && E({ tail: fresh, end: false }).code === 1);
  const noHome = () => ({ cfg: null, entry: () => { throw new Error("must not read"); } });
  const down = await run({ probeImpl: async () => ({ ok: false, why: "ssh traids: timed out" }), nowImpl: () => NOW, homeImpl: noHome });
  chk("the VPS unreachable -> UNKNOWN (exit 1), never PASS", down.status === "UNKNOWN" && down.code === 1 && /could not be read/.test(down.detail));
  // N16: the registered dated evidence-start note (re-verification 2026-10-06: nothing produced or checked it)
  const cfg = (setAgoH) => ({ evidenceStart: "2026-10-07", evidenceStartSetAt: new Date(NOW - setAgoH * 3600000).toISOString(), evidenceStartBy: "runner (N16, automatic)" });
  const ent = (amend = []) => ({ id: "R309", amendments: [{ date: "2026-10-01" }, ...amend] }), noted = { id: "R309-evidence-start-2026-10-07", kind: "evidence-start — dated note", evidenceStart: "2026-10-07" };
  const okProbe = async () => ({ ok: true, text: P({ tail: fresh }) });
  const w1 = await run({ probeImpl: okProbe, nowImpl: () => NOW, homeImpl: () => ({ cfg: cfg(3), entry: () => ent() }) });
  const w2 = await run({ probeImpl: okProbe, nowImpl: () => NOW, homeImpl: () => ({ cfg: cfg(25), entry: () => ent() }) });
  const w3 = await run({ probeImpl: okProbe, nowImpl: () => NOW, homeImpl: () => ({ cfg: cfg(25), entry: () => ent([noted]) }) });
  const w4 = await run({ probeImpl: okProbe, nowImpl: () => NOW, homeImpl: () => ({ cfg: cfg(2), entry: () => ent([{ ...noted, evidenceStart: "2026-10-06" }]) }) });
  const w5 = await run({ probeImpl: okProbe, nowImpl: () => NOW, homeImpl: () => { throw new Error("test-registry.json: Unexpected token"); } });
  chk("evidence start set 3 h ago with no registry note -> WARN (exit 5, names register-evidence-start.cjs); 25 h -> FAIL; noted -> PASS; a note for another day -> FAIL; the check unable to run -> UNKNOWN", w1.status === "WARN" && w1.code === 5 && /register-evidence-start\.cjs/.test(w1.detail) && w2.status === "FAIL" && /overdue/.test(w2.detail) && w3.status === "PASS" && w4.status === "FAIL" && /another|says 2026-10-07/.test(w4.detail) && w5.status === "UNKNOWN", [w1.status, w2.status, w3.status, w4.status, w5.status].join(","));
  chk("no evidence start pulled yet -> the registry is not even read (PASS stays PASS)", (await run({ probeImpl: okProbe, nowImpl: () => NOW, homeImpl: noHome })).status === "PASS");
  // preflight coupling: WARN level for FAIL and UNKNOWN alike — DEGRADED, never NO-GO (re-verification 2026-10-06)
  const c1 = await check({ probeImpl: async () => ({ ok: false, why: "x" }), nowImpl: () => NOW, homeImpl: noHome }), c2 = await check({ probeImpl: async () => ({ ok: true, text: P({ tail: [row("2026-10-08T11:02:05Z")] }) }), nowImpl: () => NOW, homeImpl: noHome });
  const c3 = await check({ probeImpl: okProbe, nowImpl: () => NOW, homeImpl: noHome }), c4 = await check({ probeImpl: okProbe, nowImpl: () => NOW, homeImpl: () => ({ cfg: cfg(3), entry: () => ent() }) });
  chk("preflight shape: UNKNOWN, FAIL and WARN are all level WARN with ok=false (never critical, never NO-GO); PASS is info, ok=true", c1.level === "warn" && !c1.ok && c1.status === "UNKNOWN" && /^UNKNOWN — /.test(c1.detail) && c2.level === "warn" && !c2.ok && c2.status === "CRITICAL" && /^FAIL — /.test(c2.detail) && c4.level === "warn" && !c4.ok && c4.status === "WARN" && c3.ok && c3.level === "info" && c3.name === NAME && ![c1, c2, c3, c4].some((c) => c.level === "critical"));
  // the hourly alarm: debounced, class-aware, delivery-recorded
  const passV = { status: "PASS", detail: "ok" }, failV = { status: "FAIL", klass: "live-errors", detail: "LIVE: the last cycle recorded 1 error(s): r309-BTC-2026101413: ERROR (unresolved)" }, unk = { status: "UNKNOWN", klass: "ssh", detail: "the VPS could not be read" };
  const H = 3600000, step = (v, st, t) => { const p = alarmPlan(v, st, t); return { send: p.send, st: p.next(true) }; };
  let st = { status: "PASS", since: "x" }, a = step(failV, st, NOW); const b = step(failV, a.st, NOW + H), c = step(failV, b.st, NOW + 2 * H);
  chk("debounce: the FIRST bad run pages nothing; the SECOND consecutive one pages NEW; the third nothing", !a.send && b.send && b.send.kind === "NEW" && !c.send, JSON.stringify([a.send, b.send && b.send.kind, c.send]));
  const blip = step(passV, step(unk, { status: "PASS" }, NOW).st, NOW + H);
  chk("debounce: one bad hour then PASS -> no NEW and no RECOVERED (nothing was delivered)", !blip.send && !step(unk, { status: "PASS" }, NOW).send);
  // the review's case: an error lot (FAIL, paged), then the VPS dies (UNKNOWN): no longer hidden for 6 h
  const u1 = step(unk, c.st, NOW + 3 * H), u2 = step(unk, u1.st, NOW + 4 * H);
  chk("a change of failure class (FAIL error lot -> UNKNOWN VPS unreachable) pages NEW on its second run (2 h), not as a STILL at 6 h", !u1.send && u2.send && u2.send.kind === "NEW" && /UNKNOWN/.test(u2.send.title) && /DIFFERENT failure/.test(u2.send.body), JSON.stringify([u1.send, u2.send && u2.send.title]));
  let x = u2.st, kinds = []; for (let h = 5; h <= 10; h++) { const r = step(unk, x, NOW + h * H); x = r.st; kinds.push(r.send ? r.send.kind : "-"); }
  const rec = step(passV, x, NOW + 11 * H);
  chk("a steady UNKNOWN pages STILL every 6 h (UNKNOWN as loud as FAIL); then PASS -> RECOVERED", kinds.join("") === "-----STILL" && rec.send && rec.send.kind === "RECOVERED", kinds.join(","));
  // check round 2026-10-07: during an error lot every run ends Result=exit-code; a timer that then stops firing (host up) must
  // read as its own class ('stale', not 'result' for up to 6 h) so the class change pages NEW on its second check
  const sF = E({ tail: fresh, result: "exit-code", status: "2", exitAt: NOW - 2 * H }), rF = E({ tail: fresh, result: "exit-code", status: "2" });
  chk("a FAILED last run that is also older than the limit -> class 'stale' (naming the failed result); a fresh failed run stays 'result'", sF.status === "FAIL" && sF.klass === "stale" && /2\.0 h ago/.test(sF.detail) && /Result=exit-code exit 2/.test(sF.detail) && rF.klass === "result", [sF.klass, sF.detail, rF.klass].join(" | "));
  const lastErrRun = NOW - 23 * 60000, seen = [];   // the error lot's last run ended 14:02; the pull task checks at :25 each hour
  let es = { status: "FAIL", klass: "FAIL:result", since: "x", badRuns: 5, klassRuns: 5, alarmedAt: new Date(NOW - 3 * H).toISOString(), alarmedKlass: "FAIL:result", lastAlarm: "NEW" };
  for (let h = 0; h <= 3; h++) { const t = NOW + h * H, v = evaluate(P({ now: t, result: "exit-code", status: "2", exitAt: lastErrRun, tail: fresh }), t), p = alarmPlan(v, es, t); es = p.next(true); seen.push(v.klass + (p.send ? ":" + p.send.kind + (/DIFFERENT failure/.test(p.send.body) ? "(different)" : "") : "")); }
  chk("error lot paged (FAIL:result), then the timer stalls at 14:02: 14:25 result · 15:25 stale · 16:25 stale -> NEW 'a DIFFERENT failure' (about 2 h after the last run, not a STILL at 6 h) · 17:25 nothing", seen.join(",") === "result,stale,stale:NEW(different),stale", seen.join(","));
  const f1 = alarmPlan(failV, { status: "FAIL", klass: "FAIL:live-errors", badRuns: 1, klassRuns: 1, since: "x" }, NOW), sf = f1.next(false), f2 = alarmPlan(failV, sf, NOW + H);
  chk("alarm: a NEW that FAILED to send is not recorded as sent — the next run pages NEW again", f1.send && f1.send.kind === "NEW" && sf.alarmedAt == null && f2.send && f2.send.kind === "NEW");
  const r1a = alarmPlan(passV, b.st, NOW + 3 * H), rs = r1a.next(false), r2a = alarmPlan(passV, rs, NOW + 4 * H);
  chk("alarm: a RECOVERED that failed to send is retried; steady PASS (or a first run on PASS) sends nothing; WARN pages nothing", r1a.send && r1a.send.kind === "RECOVERED" && r2a.send && r2a.send.kind === "RECOVERED" && !alarmPlan(passV, null, NOW).send && !alarmPlan({ status: "WARN", klass: "note", detail: "w" }, alarmPlan({ status: "WARN", klass: "note", detail: "w" }, null, NOW).next(true), NOW + H).send);
  // the pull's exit code (re-verification 2026-10-06: a failing pull was never alarmed)
  const p1 = withPull(passV, 1, 0, "[t] pull-r309 REFUSED (nothing written): ledger: x status exiting -> open moves backward"), p2 = withPull(passV, 1, p1.streak, "[t] pull-r309 REFUSED (nothing written): ledger: x"), p3 = withPull(passV, 0, p2.streak, null), p4 = withPull(passV, null, 3, null);
  chk("pull exit code: one failing pull -> still PASS; two in a row -> FAIL 'R309 pull failing' (its own class, the log line named); a good pull resets; no --pull-rc leaves the streak", p1.v.status === "PASS" && p1.streak === 1 && p2.v.status === "FAIL" && p2.v.klass === "pull" && /pull failing: exit 1 on 2 runs/.test(p2.v.detail) && /moves backward|ledger: x/.test(p2.v.detail) && p3.streak === 0 && p3.v.status === "PASS" && p4.streak === 3, JSON.stringify([p1.v.status, p2.v.status, p2.v.detail.slice(0, 80)]));
  chk("pull exit 4 (home r309-HALT missing) names the HALT", /r309-HALT is missing/.test(withPull(passV, 4, 1, null).v.detail));
  chk("the probe is read-only (no write, remove, move, restart or sudo)", !/\bsudo\b|\brm\b|\bmv\b|>\s*[^&]|systemctl (start|stop|restart|enable|disable|daemon-reload)|tee /.test(PROBE.replace(/2>&1|2>\/dev\/null/g, "")));
  console.log(`r309-health selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) {
  const a = process.argv.slice(2), opt = (k, d) => { const i = a.indexOf("--" + k); return i >= 0 && a[i + 1] ? a[i + 1] : d; };
  (async () => {
    if (a.includes("--selftest")) { process.exitCode = (await selftest()) ? 0 : 1; return; }
    const maxAgeMin = Number(opt("max-age-min", "75"));
    if (a.includes("--alert")) {
      const rcTxt = opt("pull-rc", null), pullRc = rcTxt != null && /^\d{1,3}$/.test(rcTxt) ? Number(rcTxt) : null;
      if (rcTxt != null && pullRc == null) console.log(`r309-health: --pull-rc ${JSON.stringify(rcTxt)} is not a number — ignored`);
      const r = await alertRun({ host: opt("host", "traids"), maxAgeMin: Number.isFinite(maxAgeMin) && maxAgeMin > 0 ? maxAgeMin : 75, pullRc });
      console.log(`[${new Date().toISOString()}] R309 HEALTH ${r.v.status}: ${r.v.detail} · alarm: ${r.sent}`);
      process.exitCode = r.v.code; return;
    }
    const v = await run({ host: opt("host", "traids"), maxAgeMin: Number.isFinite(maxAgeMin) && maxAgeMin > 0 ? maxAgeMin : 75 });
    if (a.includes("--json")) console.log(JSON.stringify({ name: NAME, at: new Date().toISOString(), ...v }));
    else console.log(`R309 HEALTH ${v.status}: ${v.detail}`);
    process.exitCode = v.code;
  })().catch((e) => { console.error("r309-health crashed:", e && e.message); process.exitCode = 1; });
}
module.exports = { evaluate, run, check, probe, alarmPlan, withPull, noteCheck, combine, NAME, PROBE };
