#!/usr/bin/env node
// R316 TASKS (2026-10-02) — builds docs/r316/task-1354.xml and task-1357.xml and docs/r316/register-tasks-elevated.ps1 from the LIVE
// "TRAIDS Intraday" definition. REGISTERS NOTHING: the operator creates the tasks elevated (S4U).
//
//   node docs/r316/build-task-xml.cjs              re-captures the live definition (schtasks /query /tn "TRAIDS Intraday" /xml — read-only)
//                                                  into docs/r316/live-intraday.xml, then builds
//   node docs/r316/build-task-xml.cjs --from-file  builds from the saved capture
//
// Kept from the live task, verbatim: the principal (the operator's SID, LogonType S4U) and every setting (IgnoreNew, WakeToRun,
// StartWhenAvailable, batteries, idle) except ExecutionTimeLimit -> PT15M (a decide run ends by close-1; the lock wait is bounded).
// Changed on purpose:
//   - StartBoundary carries NO UTC offset (the 2026-10-02 DST lesson: an offset pins the trigger to UTC and fires an hour off after
//     2026-11-01). 13:54 MT is 15:54 ET all year — MT and ET change on the same dates.
//   - one-time TimeTriggers at 10:54 / 10:57 MT on the NYSE early-close dates (12:54 / 12:57 ET for a 13:00 close). Same dates as
//     automation/close-arm-runner.cjs EARLY_CLOSE_ET and backend/lib/futures-bars.js; extend each December.
//   - the action: cmd.exe /c ""<repo>\automation\r316.bat" <tag>" (tag 1354 / 1357), working directory = the repo (same as the live
//     task). The tag gives each fire its own log, automation\r316-<tag>.log (2026-10-02 review: cmd opens a >> target without write
//     sharing, so a shared log kept the backup from starting while the primary ran — reproduced with two real cmd.exe processes). The
//     outer quote pair is cmd's documented form for a quoted path followed by an argument (/c strips the first and the last quote).
// Output: UTF-16 LE with BOM, CRLF (what `schtasks /create /tn <name> /xml <file>` reads). Every backslash written from
// String.fromCharCode(92); never through a shell.
"use strict";
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const BS = String.fromCharCode(92), CRLF = String.fromCharCode(13, 10), HERE = __dirname, REPO = path.resolve(HERE, "..", "..");
const LIVE = path.join(HERE, "live-intraday.xml");
const EARLY_CLOSE_DATES = ["2026-11-27", "2026-12-24", "2027-11-26"];
const FIRST_DAY = "2026-10-05";
const TASKS = [{ hhmm: "13:54", early: "10:54", role: "primary: waits until close-5:00, decides once, sends" }, { hhmm: "13:57", early: "10:57", role: "backup: idempotent, completes what the primary did not send (adopts by client id)" }];
const utf16 = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]);
const one = (re, s, what) => { const all = s.match(new RegExp(re.source, "g")) || []; if (all.length !== 1) throw new Error(`live XML drift: ${what} found ${all.length} times`); return s.match(re); };

// 1. the live definition (read-only query) or the saved capture
let live;
if (process.argv.includes("--from-file")) {
  const buf = fs.readFileSync(LIVE); if (!(buf[0] === 0xff && buf[1] === 0xfe)) throw new Error("live-intraday.xml is not UTF-16 LE with BOM");
  live = buf.slice(2).toString("utf16le");
} else {
  const raw = execFileSync("schtasks", ["/query", "/tn", "TRAIDS Intraday", "/xml"], { windowsHide: true });
  live = raw[0] === 0xff && raw[1] === 0xfe ? raw.slice(2).toString("utf16le") : raw.toString("utf8");
  live = live.replace(/\r?\n/g, CRLF);
  fs.writeFileSync(LIVE, utf16(live));
  console.log(`captured the live "TRAIDS Intraday" definition -> ${path.relative(REPO, LIVE)} (read-only query)`);
}
one(/<URI>.TRAIDS Intraday<\/URI>/, live, "URI TRAIDS Intraday");
const principals = one(/<Principals>[\s\S]*?<\/Principals>/, live, "Principals")[0];
one(/<LogonType>S4U<\/LogonType>/, principals, "LogonType S4U");
const sid = one(/<UserId>(S-1-5-21-[\d-]+)<\/UserId>/, principals, "UserId SID")[1];
let settings = one(/<Settings>[\s\S]*?<\/Settings>/, live, "Settings")[0];
one(/<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/, settings, "IgnoreNew");
one(/<WakeToRun>true<\/WakeToRun>/, settings, "WakeToRun true");
const etl = one(/<ExecutionTimeLimit>[^<]*<\/ExecutionTimeLimit>/, settings, "ExecutionTimeLimit")[0];
settings = settings.replace(etl, "<ExecutionTimeLimit>PT15M</ExecutionTimeLimit>");
one(/<Command>cmd\.exe<\/Command>/, live, "Command cmd.exe");
const args = one(/<Arguments>\/c "(.+?)automation.intraday\.bat"<\/Arguments>/, live, "intraday.bat action")[1];
const wd = one(/<WorkingDirectory>(.+?)<\/WorkingDirectory>/, live, "WorkingDirectory")[1];
const repo = args.endsWith(BS) ? args.slice(0, -1) : args;
if (wd !== repo) throw new Error(`live XML drift: working directory ${wd} is not the repo ${repo}`);
if (path.resolve(repo).toLowerCase() !== REPO.toLowerCase()) throw new Error(`the live task's repo ${repo} is not this repo ${REPO}`);
for (const f of [path.join(REPO, "automation", "r316.bat"), path.join(REPO, "backend", "r316-ibs-forward.js")]) if (!fs.existsSync(f)) throw new Error(`${f} missing — build it first`);
const bat = repo + BS + "automation" + BS + "r316.bat";
const batText = fs.readFileSync(path.join(REPO, "automation", "r316.bat"), "latin1");

function build({ hhmm, early, role }) {
  const tag = hhmm.replace(":", ""), name = `TRAIDS R316 ${tag}`, ind = (n) => "  ".repeat(n), et = `${String(+hhmm.slice(0, 2) + 2).padStart(2, "0")}:${hhmm.slice(3)}`;
  const argLine = `/c ""${bat}" ${tag}"`;
  if (!batText.includes(`if "%~1"=="${tag}" set "FIRE=${tag}"`)) throw new Error(`automation/r316.bat does not accept the fire tag ${tag} — rebuild it (docs/r316/build-bat.cjs) first`);
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((d) => `${ind(5)}<${d} />`);
  const lines = [
    `<?xml version="1.0" encoding="UTF-16"?>`,
    `<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`,
    `${ind(1)}<RegistrationInfo>`,
    `${ind(2)}<Description>TRAIDS R316 decision (2026-10-02, operator: run R313 forward), ${role}. ${hhmm} MT weekdays = ${et} ET (local-time trigger, follows DST); ${early} MT on NYSE early-close dates. Runs automation${BS}r316.bat ${tag} (log automation${BS}r316-${tag}.log): node backend${BS}r316-ibs-forward.js --decide --live --by task${tag} (refuses outside close-6..close-1 ET on Alpaca's calendar; DAY market orders on the Alpaca PAPER TV account).</Description>`,
    `${ind(2)}<URI>${BS}${name}</URI>`,
    `${ind(1)}</RegistrationInfo>`,
    principals.split(/\r?\n/).map((l, i) => (i === 0 ? ind(1) + l.trim() : l)).join(CRLF),
    settings.split(/\r?\n/).map((l, i) => (i === 0 ? ind(1) + l.trim() : l)).join(CRLF),
    `${ind(1)}<Triggers>`,
    `${ind(2)}<CalendarTrigger>`,
    `${ind(3)}<StartBoundary>${FIRST_DAY}T${hhmm}:00</StartBoundary>`,
    `${ind(3)}<Enabled>true</Enabled>`,
    `${ind(3)}<ScheduleByWeek>`,
    `${ind(4)}<WeeksInterval>1</WeeksInterval>`,
    `${ind(4)}<DaysOfWeek>`, ...days, `${ind(4)}</DaysOfWeek>`,
    `${ind(3)}</ScheduleByWeek>`,
    `${ind(2)}</CalendarTrigger>`,
    ...EARLY_CLOSE_DATES.flatMap((d) => [`${ind(2)}<TimeTrigger>`, `${ind(3)}<StartBoundary>${d}T${early}:00</StartBoundary>`, `${ind(3)}<Enabled>true</Enabled>`, `${ind(2)}</TimeTrigger>`]),
    `${ind(1)}</Triggers>`,
    `${ind(1)}<Actions Context="Author">`,
    `${ind(2)}<Exec>`,
    `${ind(3)}<Command>cmd.exe</Command>`,
    `${ind(3)}<Arguments>${argLine}</Arguments>`,
    `${ind(3)}<WorkingDirectory>${repo}</WorkingDirectory>`,
    `${ind(2)}</Exec>`,
    `${ind(1)}</Actions>`,
    `</Task>`,
  ];
  const xml = lines.join(CRLF) + CRLF;
  // proofs on the output
  if (/<StartBoundary>[^<]*(?:[+-]\d\d:\d\d|Z)<\/StartBoundary>/.test(xml)) throw new Error("an offset slipped into a StartBoundary");
  if ((xml.match(/<StartBoundary>/g) || []).length !== 1 + EARLY_CLOSE_DATES.length) throw new Error("trigger count");
  for (const m of ["<LogonType>S4U</LogonType>", `<UserId>${sid}</UserId>`, "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>", "<WakeToRun>true</WakeToRun>", "<ExecutionTimeLimit>PT15M</ExecutionTimeLimit>",
    `<URI>${BS}${name}</URI>`, `<Arguments>/c ""${bat}" ${tag}"</Arguments>`, `automation${BS}r316.bat`, `<StartBoundary>${FIRST_DAY}T${hhmm}:00</StartBoundary>`]) if (!xml.includes(m)) throw new Error("missing " + m);
  if ((xml.match(/<Arguments>/g) || []).length !== 1) throw new Error("Arguments count");
  if (/intraday\.bat/.test(xml)) throw new Error("intraday.bat leaked into the action");
  if (/[&]/.test(xml.replace(/&(amp|lt|gt|quot|apos);/g, ""))) throw new Error("an unescaped & in the XML");
  if (/[^\r]\n/.test(xml)) throw new Error("a bare LF in the XML");
  const file = path.join(HERE, `task-${hhmm.replace(":", "")}.xml`);
  fs.writeFileSync(file, utf16(xml));
  console.log(`wrote ${path.relative(REPO, file)} — ${name}: weekdays ${hhmm} local (= ${et} ET) + early-close ${EARLY_CLOSE_DATES.join(", ")} at ${early}; S4U ${sid}; IgnoreNew, WakeToRun, PT15M; ${bat}`);
  return { name, file };
}
const built = TASKS.map(build);

// the elevated registration script (ASCII, CRLF): creates the two tasks only; dry without -Apply
const ps = [
  "# TRAIDS R316 decision tasks (2026-10-02, operator: \"run R313 forward\"). Run ONCE in PowerShell opened AS ADMINISTRATOR (S4U tasks can",
  "# only be created elevated). Without -Apply it only prints what it would do. Creates \"TRAIDS R316 1354\" (primary) and \"TRAIDS R316 1357\"",
  "# (backup) from docs" + BS + "r316" + BS + "task-1354.xml / task-1357.xml; touches no other task. Generated by docs" + BS + "r316" + BS + "build-task-xml.cjs.",
  "param([switch]$Apply)",
  "$ErrorActionPreference = 'Stop'",
  `$repo = '${repo.replace(/'/g, "''")}'`,
  "$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
  "if ($Apply -and -not $isAdmin) { throw \"Run this in PowerShell opened as Administrator.\" }",
  "foreach ($n in '1354', '1357') {",
  "  $name = \"TRAIDS R316 $n\"; $xml = Join-Path $repo \"docs" + BS + "r316" + BS + "task-$n.xml\"",
  "  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { \"exists already: $name\" }",
  "  elseif ($Apply) { schtasks /create /tn $name /xml $xml | Out-Host; if ($LASTEXITCODE -ne 0) { throw \"could not create $name\" } }",
  "  else { \"would create: $name  <- $xml\" }",
  "}",
  "\"\"; \"TRAIDS R316 tasks now:\"",
  "Get-ScheduledTask -TaskName 'TRAIDS R316*' -ErrorAction SilentlyContinue | Sort-Object TaskName | ForEach-Object { \"{0,-20} {1}\" -f $_.TaskName, (($_.Triggers | ForEach-Object { $_.StartBoundary }) -join ', ') }",
  "if (-not $Apply) { \"\"; \"DRY RUN - nothing changed. Re-run with -Apply in an Administrator PowerShell.\" }",
];
const psText = ps.join(CRLF) + CRLF;
if (/[^\x00-\x7f]/.test(psText)) throw new Error("non-ASCII in the .ps1");
fs.writeFileSync(path.join(HERE, "register-tasks-elevated.ps1"), Buffer.from(psText, "latin1"));
console.log(`wrote docs/r316/register-tasks-elevated.ps1 (dry unless -Apply) for ${built.map((b) => b.name).join(", ")}`);
