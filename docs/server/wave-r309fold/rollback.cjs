#!/usr/bin/env node
/**
 * ROLLBACK — undo the R309 fold, 2026-10-09 (docs/server/wave-r309fold). Each part refuses rather than guess; --dry prints the plan.
 * Nothing on the VPS was changed by this package, so there is nothing to undo there.
 *
 *   node docs/server/wave-r309fold/rollback.cjs --task      prints the ONE command that brings the hourly task back (Josh's: Task Scheduler
 *        is persistent configuration; an ADMIN PowerShell, the task was created elevated):  schtasks /change /tn "TRAIDS R309 Pull" /enable
 *        It runs deploy\server\pull-r309.bat again (pull-r309.cjs + r309-health --alert) from the next :25. Run it FIRST in any rollback:
 *        with the fold still installed both pull hourly and both feed the alarm, which is safe (that is how the clean day ran).
 *   node docs/server/wave-r309fold/rollback.cjs --home [--dry] [--accept-no-r309-pull]
 *        an EXACT restore of the home patch (home-patch revertAll: each anchor line back in place, byte for byte, in preflight.bat,
 *        close-chain.cjs and ensure-servers.bat; deploy/server/
 *        r309-fold.cjs removed, an edited one kept and named; each .pre-r309fold.bak record removed when byte-equal to the restored file,
 *        kept and named otherwise). REFUSED unless the hourly task is evidently running again — a "pull-r309 ok from" line of its own in
 *        automation\r309-pull.log within the last 75 min — because after the revert nothing else at home pulls R309's files or runs its
 *        alarm. --accept-no-r309-pull overrides that, knowingly: home then has NO R309 pull and NO hourly R309 alarm until the task is
 *        enabled (preflight's "r309 server cycle" line still probes the VPS on weekdays, and the VPS's own OnFailure alerts remain).
 *        Also REFUSED (M6) while the process scan fails, while preflight.bat / the chain / another server package's deploy or rollback runs,
 *        inside the chain window, outside the preflight.bat edit window (:20-:50 past an hour, or after 18:00 MT), and at :28-:34 past
 *        an hour from 05:00 to 17:34 MT (TRAIDS Servers' half-hour run of ensure-servers.bat, which the revert edits).
 *        A running KEEPER exits by itself within two minutes of the revert (its own file absent on 2 ticks in a row) and removes its lock
 *        (backend/data/r309-keeper.lock); it runs nothing more. It leaves backend/data/r309-fold-status.json (data: the record of the
 *        fold's runs), automation\r309-keeper.log and every R309 file. Run it BEFORE W1's own
 *        package removal (docs/server/wave1-crypto/rollback.cjs --home), whose pre-snapshot pull line anchors ours and whose pull-server.cjs
 *        the fold runs on. Then record it: node docs/server/wave-r309fold/register.cjs --rollback.
 *   node docs/server/wave-r309fold/rollback.cjs --selftest    temp roots and fakes only
 * Never touches home backend/data/r309-HALT, any switch, R309's run files, the W1 / W1c packages' lines, or a governance file.
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const HERE = __dirname, REPO = path.resolve(HERE, "..", "..", ".."), DS = path.join(REPO, "deploy", "server");
const OWN = require(path.join(DS, "own.cjs"));
const HP = require(path.join(HERE, "home-patch.cjs")), DEP = require(path.join(HERE, "deploy.cjs"));
const ACCEPT = "--accept-no-r309-pull", TASK_FRESH_MS = 75 * 60000;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
let log = (s) => console.log(s);

/** null when the hourly task has evidently run within 75 min (its own ok line in the log); else why not */
function taskGuard(logText, nowMs) {
  const ol = DEP.oldTaskLines(logText, nowMs - 24 * 3600000), okL = ol.filter((x) => x.kind === "ok" && Date.parse(x.at) <= nowMs + 5 * 60000), last = okL[okL.length - 1];   // a line from the future is no evidence
  if (last && nowMs - Date.parse(last.at) <= TASK_FRESH_MS) return null;
  return `the TRAIDS R309 Pull task has not evidently run in the last 75 min (${last ? "its last ok line: " + last.at : "no ok line of its own in automation\\r309-pull.log in 24 h"}) — after this revert nothing at home would pull R309's files or run its hourly alarm. Enable it first (node docs/server/wave-r309fold/rollback.cjs --task prints the command), wait for its next :25 run, then re-run; or add ${ACCEPT} to revert anyway, knowingly`;
}
function readTail(f, n = 2 * 1024 * 1024) { try { const s = fs.statSync(f), fd = fs.openSync(f, "r"), k = Math.min(s.size, n), b = Buffer.alloc(k); fs.readSync(fd, b, 0, k, s.size - k); fs.closeSync(fd); return b.toString("utf8"); } catch { return ""; } }
/** --home. deps (selftest): root, logFile, procs, chainStatus, nowMs */
function rollbackHome({ dry = false, accept = false, root = REPO, logFile = path.join(REPO, "automation", "r309-pull.log"), procs = undefined, chainStatus = undefined, nowMs = Date.now() } = {}) {
  log(`== rollback --home${dry ? " (DRY: nothing is changed)" : ""}`);
  const st = HP.ALL().map((e) => ({ e, s: HP.stateOf(e, root) }));
  if (st.every((x) => x.s.state === "base")) { log("   nothing to undo: every entry reads base"); return ["nothing to undo"]; }
  const drift = st.filter((x) => x.s.state === "drift" && !x.e.from);
  if (drift.length) throw new Error("REFUSED (nothing reverted): " + drift.map((x) => x.s.why).join(" | ") + " — revert by hand from the .pre-r309fold.bak records");
  const tg = taskGuard(readTail(logFile), nowMs);
  if (tg && !accept) throw new Error("REFUSED (nothing reverted): " + tg);
  if (tg) log(`   ${ACCEPT}: proceeding although ${tg.split(" — ")[0]} — home has NO R309 pull and NO hourly R309 alarm until the task is enabled`);
  else log("   the hourly task is running again (its own ok line within 75 min): it pulls and alarms after the revert");
  const P = procs === undefined ? OWN.procScan() : procs;
  let cs = chainStatus; if (cs === undefined) { try { cs = JSON.parse(fs.readFileSync(path.join(root, "backend", "data", "chain-status.json"), "utf8")); } catch { cs = null; } }
  const w = DEP.editWindow(nowMs, { procs: P, chainStatus: cs }); if (w) throw new Error("REFUSED (nothing reverted): " + w);
  const lines = HP.revertAll(root, { dry });
  for (const l of lines) log("   " + l);
  if (!dry) log("   reverted: preflight.bat and the chain no longer pull r309 through the fold, and neither preflight.bat nor ensure-servers.bat starts the keeper; a running keeper exits within two minutes (its file absent on 2 ticks in a row) and drops its lock; backend/data/r309-fold-status.json and every R309 file kept. Record it: node docs/server/wave-r309fold/register.cjs --rollback");
  return lines;
}

function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + String(d).slice(0, 500) : "")); } };
  const th = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r309fold-rollback-")), save = log, logs = [];
  log = (s) => logs.push(s);
  try {
    save("rollback selftest (" + tmp + ")");
    const R = path.join(tmp, "root"); for (const e of HP.EDITS) { fs.mkdirSync(path.dirname(path.join(R, e.rel)), { recursive: true }); fs.writeFileSync(path.join(R, e.rel), HP.baseText(e)); }
    fs.mkdirSync(path.join(R, "backend", "data"), { recursive: true }); fs.writeFileSync(path.join(R, "backend", "data", "r309-HALT"), "home backstop\n"); fs.writeFileSync(path.join(R, "backend", "data", "r309-fold-status.json"), '{"schema":"r309-fold-status-v1","runs":[]}');
    const B0 = Object.fromEntries(HP.EDITS.map((e) => [e.rel, fs.readFileSync(path.join(R, e.rel))]));
    const at = (iso) => Date.parse(iso), NOW = at("2026-10-14T00:30:00Z"), done = { started: "2026-10-13T20:15:00Z", finished: "2026-10-13T21:40:00Z", steps: [] };
    const L = path.join(tmp, "r309-pull.log"), taskLine = (iso) => `[${iso}] pull-r309 ok from traids:/home/traids/traids/backend/data — server files r309-ledger.jsonl, r309-cycles.jsonl: no change · home r309-HALT present`;
    const RF = require(path.join(HERE, "deploy-server", "r309-fold.cjs"));
    const go = (o = {}) => th(() => rollbackHome({ root: R, logFile: L, procs: [], chainStatus: done, nowMs: NOW, ...o }));
    ok("nothing applied -> 'nothing to undo', nothing written", go() === null && logs.some((l) => /nothing to undo/.test(l)));
    HP.applyAll(R);
    const snap = () => [...HP.EDITS.map((e) => e.rel), ...HP.NEW.map((e) => e.rel), "backend/data/r309-HALT", "backend/data/r309-fold-status.json"].map((rel) => { const f = path.join(R, rel); return fs.existsSync(f) ? sha(fs.readFileSync(f)) : "-"; }).join(",");
    // the task guard
    fs.writeFileSync(L, [RF.pullLine({ exit: 0, kind: "ok", why: null, changed: [], files: 3 }, "preflight.bat", "2026-10-14T00:00:05.000Z"), taskLine("2026-10-13T21:25:03.000Z")].join("\n") + "\n");
    let s0 = snap(), e = go();
    ok("the task's last own ok line 3 h old (only fold lines since) -> REFUSED, nothing reverted (home would have no R309 pull and no alarm)", /REFUSED \(nothing reverted\): the TRAIDS R309 Pull task has not evidently run/.test(e || "") && snap() === s0, e);
    fs.writeFileSync(L, RF.pullLine({ exit: 0, kind: "ok", why: null, changed: [], files: 3 }, "preflight.bat", "2026-10-14T00:00:05.000Z") + "\n");
    e = go(); ok("no task line at all (only the fold's) -> REFUSED", /no ok line of its own/.test(e || "") && snap() === s0, e);
    logs.length = 0; e = go({ dry: true, accept: true }); ok(`${ACCEPT} --dry -> the plan only ('would revert' x3: the chain, preflight.bat, ensure-servers.bat; 'would remove' the new file + 3 records), nothing written`, e === null && logs.filter((l) => /would revert/.test(l)).length === 3 && ["automation/close-chain.cjs", "automation/preflight.bat", "automation/ensure-servers.bat"].every((rel) => logs.some((l) => l.includes(`would revert     ${rel}`)) && logs.some((l) => l.includes(`would remove     ${rel}.pre-r309fold.bak`))) && logs.some((l) => /would remove\s+deploy\/server\/r309-fold\.cjs/.test(l)) && snap() === s0, e || logs.slice(-8).join(" | "));
    // the M6 window (each with the task's own ok line 40 min before)
    fs.writeFileSync(L, taskLine("2026-10-14T15:25:03.000Z") + "\n");
    e = go({ nowMs: at("2026-10-14T16:05:00Z") }); ok("the task running, 10:05 MT -> REFUSED (outside the preflight.bat window), nothing reverted", /outside the preflight\.bat edit window/.test(e || "") && snap() === s0, e);
    e = go({ nowMs: at("2026-10-14T16:30:00Z") }); ok("the task running, 10:30 MT (inside :20-:50, a clean process scan) -> REFUSED: TRAIDS Servers' half-hour run starts ensure-servers.bat, which the revert edits; nothing reverted. 10:35 MT is past it (the same call is not refused for the window)", /REFUSED \(nothing reverted\)[^]*inside TRAIDS Servers' half-hour run/.test(e || "") && snap() === s0 && DEP.editWindow(at("2026-10-14T16:35:00Z"), { procs: [], chainStatus: done }) === null, e);
    fs.writeFileSync(L, taskLine("2026-10-14T00:00:03.000Z") + "\n");
    e = go({ nowMs: at("2026-10-14T00:40:00Z"), procs: null }); ok("a failed process scan -> REFUSED (fail-closed)", /process scan failed/.test(e || "") && snap() === s0, e);
    e = go({ nowMs: at("2026-10-14T00:40:00Z"), procs: ["cmd /c automation\\preflight.bat"] }); ok("preflight.bat running -> REFUSED", /preflight\.bat/.test(e || "") && snap() === s0, e);
    fs.writeFileSync(L, taskLine("2026-10-13T20:00:03.000Z") + "\n" + taskLine("2026-10-14T00:25:03.000Z") + "\n");
    e = go({ nowMs: at("2026-10-13T20:40:00Z"), chainStatus: { started: "2026-10-12T20:15:00Z", finished: "2026-10-12T21:40:00Z" } }); ok("inside the chain window (Tue 14:40 MT, today's chain not finished) -> REFUSED (and a future-dated task line is no evidence: the 20:00Z line is what passes the task guard)", /close chain is due or running/.test(e || "") && snap() === s0, e);
    fs.writeFileSync(L, taskLine("2026-10-14T03:25:03.000Z") + "\n");
    e = go({ nowMs: at("2026-10-14T00:40:00Z") }); ok("a task line only from the FUTURE (clock skew) -> no evidence -> REFUSED", /has not evidently run/.test(e || "") && snap() === s0, e);
    fs.writeFileSync(L, taskLine("2026-10-14T00:25:03.000Z") + "\n");
    // the real revert
    e = go({ nowMs: at("2026-10-14T00:40:00Z") });
    ok("the task's own ok line 15 min old, Tue 18:40 MT -> REVERTED byte for byte: both files at base, the new file and both records removed", e === null && HP.EDITS.every((x) => fs.readFileSync(path.join(R, x.rel)).equals(B0[x.rel])) && !fs.existsSync(path.join(R, "deploy/server/r309-fold.cjs")) && HP.EDITS.every((x) => !fs.existsSync(path.join(R, HP.BAK(x.rel)))), e || logs.slice(-6).join(" | "));
    ok("r309-HALT and r309-fold-status.json untouched by the rollback", fs.readFileSync(path.join(R, "backend/data/r309-HALT"), "utf8") === "home backstop\n" && fs.readFileSync(path.join(R, "backend/data/r309-fold-status.json"), "utf8") === '{"schema":"r309-fold-status-v1","runs":[]}');
    e = go({ nowMs: at("2026-10-14T00:40:00Z") }); ok("again: nothing to undo", e === null && logs[logs.length - 1].includes("nothing to undo"));
    // accept without the task
    HP.applyAll(R); fs.writeFileSync(L, ""); e = go({ nowMs: at("2026-10-14T00:40:00Z"), accept: true });
    ok(`${ACCEPT} with no task line: reverted, and the consequence is printed (NO R309 pull, NO hourly alarm)`, e === null && HP.ALL().every((x) => HP.stateOf(x, R).state === "base") && logs.some((l) => /home has NO R309 pull and NO hourly R309 alarm/.test(l)), e);
    // drift
    HP.applyAll(R); { const f = path.join(R, "automation/preflight.bat"), t = fs.readFileSync(f, "utf8"); fs.writeFileSync(f, t.replace(HP.PF_LINE + "\n", "")); fs.writeFileSync(L, taskLine("2026-10-14T00:25:03.000Z") + "\n"); const s1 = snap(); e = go({ nowMs: at("2026-10-14T00:40:00Z") });
      ok("a hand-edited (drifted) preflight.bat -> REFUSED before anything, named, nothing reverted", /REFUSED \(nothing reverted\)[^]*preflight\.bat/.test(e || "") && snap() === s1, e); }
    // the --task command
    logs.length = 0; printTask();
    ok("--task prints exactly the enable command (and never runs it)", logs.some((l) => l.trim() === DEP.ENABLE_CMD) && !/(spawn|exec)\w*\([^)]*schtasks/.test(fs.readFileSync(__filename, "utf8").split("function selftest")[0]));
    ok("arguments: --home with an unknown flag, or --task with a flag -> refused", parseArgs(["--home", "--force"]).error && parseArgs(["--task", "--dry"]).error && !parseArgs(["--home", "--dry", ACCEPT]).error && parseArgs([]).error);
  } finally { log = save; fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`rollback selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}
function printTask() {
  log("Bring the hourly R309 pull + alarm back — ONE command, yours, in an ADMIN PowerShell (right-click PowerShell, Run as administrator: the task was created elevated):");
  log("");
  log("  " + DEP.ENABLE_CMD);
  log("");
  log("It runs deploy\\server\\pull-r309.bat again from the next :25. Check: a new 'pull-r309 ok from' line in automation\\r309-pull.log, or");
  log("node docs/server/wave-r309fold/deploy.cjs --status. The fold may stay installed beside it (both pull, both feed the alarm — the clean day ran so);");
  log("to remove the fold too: node docs/server/wave-r309fold/rollback.cjs --home (it needs the task's own ok line within 75 min).");
}
function parseArgs(a) {
  if (a.length === 1 && a[0] === "--selftest") return { mode: "selftest" };
  if (a.length === 1 && a[0] === "--task") return { mode: "task" };
  if (a[0] === "--home" && a.slice(1).every((x) => x === "--dry" || x === ACCEPT) && new Set(a).size === a.length) return { mode: "home", dry: a.includes("--dry"), accept: a.includes(ACCEPT) };
  return { error: `usage: rollback.cjs --task | --home [--dry] [${ACCEPT}] | --selftest` };
}
if (require.main === module) {
  const o = parseArgs(process.argv.slice(2));
  if (o.error) { console.error(o.error); process.exitCode = 2; }
  else if (o.mode === "selftest") process.exitCode = selftest() ? 0 : 1;
  else if (o.mode === "task") { printTask(); process.exitCode = 0; }
  else { try { rollbackHome({ dry: o.dry, accept: o.accept }); process.exitCode = 0; } catch (e) { console.error(e.message); process.exitCode = 1; } }
}
module.exports = { rollbackHome, taskGuard, printTask, parseArgs, ACCEPT };
