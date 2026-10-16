#!/usr/bin/env node
/**
 * MAKE PULL TASK — the Windows scheduled task "TRAIDS R309 Pull" as XML, built by node (house rule: task XML / .bat only from
 * node). 2026-10-06, R309 go-live package. REGISTERS NOTHING: it writes r309-pull-task.xml next to this file and prints the ONE
 * command Josh runs to create the task (persistent configuration is his call).
 *
 * The task runs deploy\server\pull-r309.bat (installed by `deploy.cjs --step home`): the VPS -> home pull of R309's four run files,
 * then `backend\lib\r309-health.cjs --alert --pull-rc <the pull's exit code>` — the hourly R309 alarm (debounced NEW / STILL /
 * RECOVERED through home notify.js). Two failing pulls in a row make the run FAIL ("R309 pull failing"); with the 2-run debounce
 * the page comes on the third consecutive failing pull (about 2 h) — sooner when the VPS check itself is not PASS (ssh down reads
 * UNKNOWN at once and pages on the second run).
 *   trigger    daily from 00:25 local, repeated every hour for the day (so hourly at :25, every day) — StartBoundary with NO time-
 *              zone offset (an offset pins it to UTC: the 2026-10-02 DST lesson)
 *   settings   StartWhenAvailable (a run missed while the PC slept runs once on wake), MultipleInstances IgnoreNew,
 *              ExecutionTimeLimit 10 min, runs on battery, NO WakeToRun (it never wakes the PC: the standing 2026-08-12 decision
 *              against round-the-clock wakes holds)
 *   principal  Josh's own account, InteractiveToken = "run only when the user is logged on": no password is stored or asked.
 *              The cost: it runs only while Josh is logged on (a locked screen counts), and a console window shows for a few seconds
 *              each hour. Nights and weekends while the PC sleeps are covered ONLY by the VPS's own OnFailure alerts (traids-alert,
 *              ops bot); an external heartbeat would close that gap and is Josh's option (NOTES).
 * Output: UTF-16 LE with BOM, CRLF — what `schtasks /create /xml` reads.
 *
 *   node docs/server/phase0-golive/make-pull-task.cjs             write r309-pull-task.xml, print the schtasks command
 *   node docs/server/phase0-golive/make-pull-task.cjs --selftest  build in memory with a fixed user and date; no file, no whoami
 */
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process");
const HERE = __dirname, TASK = "TRAIDS R309 Pull", OUT = path.join(HERE, "r309-pull-task.xml");
const REPO = (() => { for (let d = HERE; ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, "backend", "data")) && fs.existsSync(path.join(d, "deploy"))) return d; if (path.dirname(d) === d) throw new Error("repo root not found above " + HERE); } })();
const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const u16 = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s.replace(/\r?\n/g, "\r\n"), "utf16le")]);

/** Pure: the task XML for a repo root, a user id (SID or DOMAIN\user) and a local start date YYYY-MM-DD */
function buildXml({ repo, userId, day }) {
  if (!/^\d{4}-\d\d-\d\d$/.test(day)) throw new Error("day must be YYYY-MM-DD");
  if (!userId) throw new Error("no user id");
  const bat = path.win32.join(repo, "deploy", "server", "pull-r309.bat");
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    `    <Description>${xmlEsc("R309 (VPS) -> home pull of the four run files, then r309-health --alert --pull-rc (the hourly R309 alarm: NEW on the 2nd bad run, STILL every 6 h, RECOVERED). Hourly at :25 every day while Josh is logged on; never wakes the PC. Built by docs/server/phase0-golive/make-pull-task.cjs (R309 go-live 2026-10-06).")}</Description>`,
    `    <URI>\\${xmlEsc(TASK)}</URI>`,
    "  </RegistrationInfo>",
    "  <Principals>",
    '    <Principal id="Author">',
    `      <UserId>${xmlEsc(userId)}</UserId>`,
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowHardTerminate>true</AllowHardTerminate>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
    "    <IdleSettings>",
    "      <StopOnIdleEnd>false</StopOnIdleEnd>",
    "      <RestartOnIdle>false</RestartOnIdle>",
    "    </IdleSettings>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "    <Hidden>false</Hidden>",
    "    <RunOnlyIfIdle>false</RunOnlyIfIdle>",
    "    <WakeToRun>false</WakeToRun>",
    "    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>",
    "    <Priority>7</Priority>",
    "  </Settings>",
    "  <Triggers>",
    "    <CalendarTrigger>",
    `      <StartBoundary>${day}T00:25:00</StartBoundary>`,
    "      <Enabled>true</Enabled>",
    "      <Repetition>",
    "        <Interval>PT1H</Interval>",
    "        <Duration>P1D</Duration>",
    "        <StopAtDurationEnd>false</StopAtDurationEnd>",
    "      </Repetition>",
    "      <ScheduleByDay>",
    "        <DaysInterval>1</DaysInterval>",
    "      </ScheduleByDay>",
    "    </CalendarTrigger>",
    "  </Triggers>",
    '  <Actions Context="Author">',
    "    <Exec>",
    "      <Command>cmd.exe</Command>",
    `      <Arguments>/c "${xmlEsc(bat)}"</Arguments>`,
    `      <WorkingDirectory>${xmlEsc(repo)}</WorkingDirectory>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\n");
}
/** Pure: what must hold in the XML (also the selftest) — throws naming the first violation */
function verifyXml(xml) {
  const need = [[/<LogonType>InteractiveToken<\/LogonType>/, "InteractiveToken (run only when logged on, no password)"], [/<WakeToRun>false<\/WakeToRun>/, "WakeToRun false"],
    [/<StartWhenAvailable>true<\/StartWhenAvailable>/, "StartWhenAvailable"], [/<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/, "IgnoreNew"],
    [/<ExecutionTimeLimit>PT10M<\/ExecutionTimeLimit>/, "ExecutionTimeLimit 10 min"], [/<Interval>PT1H<\/Interval>/, "hourly repetition"], [/<StartBoundary>\d{4}-\d\d-\d\dT00:25:00<\/StartBoundary>/, "start at :25 local"],
    [/<URI>\\TRAIDS R309 Pull<\/URI>/, "the TRAIDS-prefixed name (ops-health scans TRAIDS* tasks)"], [/<Arguments>\/c "[^"]+\\deploy\\server\\pull-r309\.bat"<\/Arguments>/, "the pull .bat action"]];
  if (/<WakeToRun>true/.test(xml)) throw new Error("task XML: WakeToRun must be false");
  if (/<StartBoundary>[^<]*([+-]\d\d:\d\d|Z)<\/StartBoundary>/.test(xml)) throw new Error("task XML: a time-zone offset in a StartBoundary");
  if (/<LogonType>(S4U|Password)<\/LogonType>|<Password>/.test(xml)) throw new Error("task XML: must not need a stored password");
  for (const [re, what] of need) if (!re.test(xml)) throw new Error("task XML: missing " + what);
  return true;
}
/** the current user's SID (read-only `whoami /user`); falls back to DOMAIN\user */
function currentUser() {
  try { const out = cp.execFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout: 15000 }); const m = /"(S-1-5-[\d-]+)"/.exec(out); if (m) return m[1]; } catch { /* fall through */ }
  if (process.env.USERNAME) return `${process.env.USERDOMAIN || "."}\\${process.env.USERNAME}`;
  throw new Error("cannot tell the current user (whoami /user failed, no USERNAME)");
}

function selftest() {
  let pass = 0, fail = 0;
  const ok = (name, cond, d) => { if (cond) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (d ? " — " + d : "")); } };
  const xml = buildXml({ repo: "C:\\Users\\joshc\\Downloads\\traids (2)\\traids-bundle", userId: "S-1-5-21-1-2-3-1004", day: "2026-10-07" });
  let v = null; try { v = verifyXml(xml); } catch (e) { v = e.message; }
  ok("the XML holds every required setting: InteractiveToken, NO WakeToRun, StartWhenAvailable, IgnoreNew, 10 min limit, hourly from :25, the TRAIDS name, the .bat action", v === true, String(v));
  ok("no time-zone offset in the StartBoundary; no stored password", /<StartBoundary>2026-10-07T00:25:00<\/StartBoundary>/.test(xml) && !/<Password>|S4U/.test(xml));
  ok("a path with spaces and parentheses is quoted in the action; & and < are escaped", /<Arguments>\/c "C:\\Users\\joshc\\Downloads\\traids \(2\)\\traids-bundle\\deploy\\server\\pull-r309\.bat"<\/Arguments>/.test(xml) && /&amp;|&lt;/.test(buildXml({ repo: "C:\\a&b<c", userId: "x", day: "2026-10-07" })));
  const b = u16(xml);
  ok("written as UTF-16 LE with BOM and CRLF (what schtasks /create /xml reads)", b[0] === 0xff && b[1] === 0xfe && b.slice(2).toString("utf16le").includes("\r\n") && !/[^\r]\n/.test(b.slice(2).toString("utf16le")));
  let w = null; try { verifyXml(xml.replace("<WakeToRun>false</WakeToRun>", "<WakeToRun>true</WakeToRun>")); } catch (e) { w = e.message; }
  let o = null; try { verifyXml(xml.replace("T00:25:00</StartBoundary>", "T00:25:00-06:00</StartBoundary>")); } catch (e) { o = e.message; }
  ok("verifyXml refuses WakeToRun true and an offset StartBoundary", /WakeToRun/.test(w || "") && /offset/.test(o || ""));
  console.log(`make-pull-task selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) {
  try {
    if (process.argv.includes("--selftest")) process.exitCode = selftest() ? 0 : 1;
    else {
      const day = new Date().toLocaleDateString("en-CA");   // the PC's local date (node, never the shell clock)
      const xml = buildXml({ repo: REPO, userId: currentUser(), day }); verifyXml(xml);
      fs.writeFileSync(OUT, u16(xml));
      const bat = path.join(REPO, "deploy", "server", "pull-r309.bat"), staged = path.join(HERE, "repo", "pull-r309.bat");
      const installed = fs.existsSync(bat) && fs.existsSync(staged) && fs.readFileSync(bat).equals(fs.readFileSync(staged));
      console.log(`wrote ${path.relative(REPO, OUT)} — "${TASK}": hourly from 00:25 local (every day), while you are logged on, no wake, no password, 10 min limit, IgnoreNew.`);
      if (!installed) console.log("NOTE: deploy\\server\\pull-r309.bat is not the package's version yet — run `node docs/server/phase0-golive/deploy.cjs --step home` BEFORE creating the task (the old bat exits 2).");
      console.log("To create it (your call — persistent configuration; nothing was registered), from a normal (non-elevated) prompt:");
      console.log(`  schtasks /create /tn "${TASK}" /xml "${OUT}"`);
      console.log(`Then once by hand to prove it:  schtasks /run /tn "${TASK}"   and check automation\\r309-pull.log and backend\\data\\r309-health-alert.json (pullRc 0).`);
      process.exitCode = 0;
    }
  } catch (e) { console.error("make-pull-task: " + e.message); process.exitCode = 1; }
}
module.exports = { buildXml, verifyXml, TASK };
