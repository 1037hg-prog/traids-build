#!/usr/bin/env node
/**
 * UNITS — the five systemd units of W7 (R352's recorder, docs/server/wave7-pm). 2026-10-11. Generated here so the files in systemd/
 * can never drift from what was reviewed:
 *
 *   node docs/server/wave7-pm/units.cjs --write     (re)write systemd/*.service and systemd/*.timer
 *   node docs/server/wave7-pm/units.cjs --check     exit 0 when every file equals what this file generates and every rule below holds
 *
 *   traids-pm-book.service      ONE long-running process: backend/pm-book-recorder.js --run. Type=simple, Restart=on-failure; a crash loop
 *                               (5 starts in 15 min) ends "failed", which pages through OnFailure=traids-alert@. Enabled (starts at boot).
 *   traids-pm-nightly.service   oneshot, by its timer at 00:40 UTC every day: --compress closed (each archive verified by sha256 before
 *     + .timer                  its plain file goes), then --summarize recent (the small per-day record the home pull carries: counts,
 *                               archive hashes, coverage only). Persistent=false: a missed night is caught up by the next one ("closed" and
 *                               "recent" mean every day still owed), never replayed at boot.
 *   traids-pm-health.service    oneshot, every 5 minutes: --health. Any exit but 0 fails the unit, and OnFailure pages. This is how a
 *     + .timer                  BLOCKED venue, a silent feed, a hung recorder or a filling disk reaches the operator: the recorder
 *                               itself never sends anything anywhere but its three public reads. The alert path holds the SAME
 *                               exit status back for 3 hours, so a FAIL's exit code names what failed (16 + 1 a venue blocked,
 *                               2 a feed silent, 4 stopped or hung, 8 the disk guard, 16 under 24 h of disk, 32 a write error):
 *                               another kind of failure is another code and pages at once. 3 = UNKNOWN.
 * Every service follows the house rules (M5): User=traids, TZ, OnFailure=traids-alert@%n.service, NoNewPrivileges, and the SAME
 * ExecCondition ownership gate as every other server unit (deploy/server/own-check.cjs conditionCommand): it runs only while home's map
 * says "w7-pm": "server". There is no home version of this unit and no shadow: nothing here is a copy of something that runs at home.
 * No unit loads a key file (the recorder is keyless), names another user, or is called traids-w1* (W1's rollback counts those).
 */
"use strict";
const fs = require("fs"), path = require("path");
const HERE = __dirname, REPO = path.resolve(HERE, "..", "..", ".."), SD = path.join(HERE, "systemd");
const OC = require(path.join(REPO, "deploy", "server", "own-check.cjs"));
const UNIT = "w7-pm", RB = "/home/traids/traids/backend", NODE = "/usr/local/bin/node", REC = `${RB}/pm-book-recorder.js`;
const GATE = `ExecCondition=${OC.conditionCommand(UNIT, "server")}`;
const COMMON = ["User=traids", "Group=traids", `WorkingDirectory=${RB}`, "Environment=TZ=America/Denver"];
const HARDEN = ["NoNewPrivileges=yes", "PrivateTmp=yes", "ProtectSystem=full"];

function expected() {
  const book = [
    "# TRAIDS W7 (docs/server/wave7-pm): backend/pm-book-recorder.js --run — R352's recorder. PUBLIC, KEYLESS, READ-ONLY market data:",
    "# Polymarket's bitcoin Up/Down 5-minute books (websocket), Kalshi KXBTC15M books (REST, never more than 2 requests a second) and",
    "# Coinbase BTC-USD trades -> data/pm-book/<venue>/<UTC date>/. No account, no key, no order; it scores nothing. ONE long-running",
    "# process. Runs ONLY while home's map says \"w7-pm\": \"server\" (checked at every start). A crash loop ends failed and pages through",
    "# traids-alert@; a blocked venue or a silent feed pages through traids-pm-health.service.",
    "[Unit]",
    "Description=TRAIDS W7 prediction-market book recorder for R352 (runs only while server-owned)",
    `Documentation=file://${REC}`,
    "After=network-online.target time-sync.target",
    "Wants=network-online.target",
    "OnFailure=traids-alert@%n.service",
    "StartLimitIntervalSec=900",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    ...COMMON,
    "Environment=PM_BOOK_RUN_HOST=server",
    GATE,
    `ExecStart=${NODE} ${REC} --run`,
    "Restart=on-failure",
    "RestartSec=15",
    "SyslogIdentifier=traids-pm-book",
    "TimeoutStopSec=30s",
    "KillMode=control-group",
    "MemoryMax=768M",
    ...HARDEN,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ];
  const nightly = [
    "# TRAIDS W7 nightly (docs/server/wave7-pm): gzip every CLOSED UTC day of data/pm-book (each archive unpacked and compared by sha256",
    "# before its plain file is removed), then write the small per-day summary the home pull carries (counts, archive hashes, coverage",
    "# as R352 rule[11] defines it — never a result). Low priority: it must not take the recorder's processor or disk.",
    "[Unit]",
    "Description=TRAIDS W7 pm-book nightly: compress closed days (verified), then the per-day summary",
    "OnFailure=traids-alert@%n.service",
    "",
    "[Service]",
    "Type=oneshot",
    ...COMMON,
    GATE,
    `ExecStart=${NODE} ${REC} --compress closed`,
    `ExecStart=${NODE} ${REC} --summarize recent`,
    "Nice=15",
    "IOSchedulingClass=idle",
    "SyslogIdentifier=traids-pm-nightly",
    "TimeoutStartSec=3h",
    "MemoryMax=1G",
    ...HARDEN,
    "",
  ];
  const nightlyTimer = [
    "# TRAIDS W7 nightly timer: 00:40 UTC every day, 40 minutes after the UTC day the recorder files by has closed.",
    "# Persistent=false: a missed night is not replayed at boot; the next run takes every closed day still owed.",
    "[Unit]",
    "Description=TRAIDS W7 pm-book nightly compress and summary, 00:40 UTC",
    "",
    "[Timer]",
    "OnCalendar=*-*-* 00:40:00 UTC",
    "AccuracySec=1s",
    "RandomizedDelaySec=0",
    "Persistent=false",
    "Unit=traids-pm-nightly.service",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ];
  const health = [
    "# TRAIDS W7 health (docs/server/wave7-pm): backend/pm-book-recorder.js --health, read-only. Exit 0 PASS; any other exit fails this",
    "# unit, and OnFailure pages the operator through traids-alert@. That path sends a NEW exit status at once and the SAME one again",
    "# only every 3 h (not every 5 minutes), so a FAIL's exit code names what failed: 16 + the sum of",
    "#    1  a venue BLOCKED (401 / 403 / a challenge page / a redirect elsewhere)     2  a feed silent for 2 minutes",
    "#    4  the recorder stopped or hung (a status file older than 90 s)              8  the disk guard refusing",
    "#   16  under 24 h of disk left                                                  32  a write error",
    "# (one more from 77 up: 77 is never used). 3 = UNKNOWN (no status file, or the disk could not be measured); 1 = the check crashed.",
    "[Unit]",
    "Description=TRAIDS W7 pm-book recorder health check",
    "OnFailure=traids-alert@%n.service",
    "",
    "[Service]",
    "Type=oneshot",
    ...COMMON,
    GATE,
    `ExecStart=${NODE} ${REC} --health`,
    "SyslogIdentifier=traids-pm-health",
    "TimeoutStartSec=60s",
    "MemoryMax=256M",
    ...HARDEN,
    "",
  ];
  const healthTimer = [
    "# TRAIDS W7 health timer: every 5 minutes (at :02, :07, ...), and 3 minutes after boot. Persistent=false: a check is about now.",
    "[Unit]",
    "Description=TRAIDS W7 pm-book recorder health check, every 5 minutes",
    "",
    "[Timer]",
    "OnCalendar=*-*-* *:02/5:00",
    "OnBootSec=3min",
    "AccuracySec=1s",
    "RandomizedDelaySec=0",
    "Persistent=false",
    "Unit=traids-pm-health.service",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ];
  return { "traids-pm-book.service": book.join("\n"), "traids-pm-nightly.service": nightly.join("\n"), "traids-pm-nightly.timer": nightlyTimer.join("\n"), "traids-pm-health.service": health.join("\n"), "traids-pm-health.timer": healthTimer.join("\n") };
}
const ALL_UNITS = Object.keys(expected());
const SERVICES = ALL_UNITS.filter((u) => u.endsWith(".service")), TIMERS = ALL_UNITS.filter((u) => u.endsWith(".timer"));
/** the units that are enabled (the recorder starts at boot; the two timers) — the oneshot services are started by their timers only */
const ENABLED = ["traids-pm-book.service", ...TIMERS];

/** rules every unit text must meet, whatever generated it -> [] or what is wrong */
function semanticIssues(units = expected()) {
  const bad = [], has = (t, l) => t.split("\n").includes(l), count = (t, re) => t.split("\n").filter((l) => re.test(l)).length;
  for (const [name, t] of Object.entries(units)) {
    if (/^traids-w1/.test(name)) bad.push(`${name}: named traids-w1* (W1's rollback counts those)`);
    if (/^EnvironmentFile=/m.test(t)) bad.push(`${name}: loads an environment file — the recorder is keyless`);
    if (/^Exec[A-Za-z]*=[-@:|]*[+!]|^User=(?!traids$)|AmbientCapabilities|CapabilityBoundingSet/m.test(t)) bad.push(`${name}: escalates or names another user`);
    if (/^Persistent=true/m.test(t)) bad.push(`${name}: Persistent=true (a missed slot must not be replayed at boot)`);
    if (name.endsWith(".service")) {
      if (!has(t, "User=traids") || !has(t, "Environment=TZ=America/Denver") || !has(t, "NoNewPrivileges=yes")) bad.push(`${name}: not User=traids / TZ / NoNewPrivileges (M5)`);
      if (!has(t, "OnFailure=traids-alert@%n.service")) bad.push(`${name}: no OnFailure=traids-alert@%n.service`);
      if (!has(t, GATE) || count(t, /^ExecCondition=/) !== 1) bad.push(`${name}: its ExecCondition is not exactly the ownership gate own-check.cjs gives for ${UNIT} server`);
      if (/pm-book-recorder\.js --(selftest|probe|ack|coverage)\b/.test(t)) bad.push(`${name}: runs a mode that is not a unit's`);
    } else {
      if (!has(t, "Persistent=false")) bad.push(`${name}: not Persistent=false`);
      if (!/^Unit=traids-pm-(nightly|health)\.service$/m.test(t)) bad.push(`${name}: does not start its own service`);
    }
  }
  const b = units["traids-pm-book.service"] || "", n = units["traids-pm-nightly.service"] || "";
  if (!has(b, "Type=simple") || !has(b, "Restart=on-failure") || !has(b, `ExecStart=${NODE} ${REC} --run`) || count(b, /^ExecStart=/) !== 1) bad.push("traids-pm-book.service: not ONE long-running --run process with Restart=on-failure");
  if (!has(b, "Environment=PM_BOOK_RUN_HOST=server")) bad.push("traids-pm-book.service: does not set PM_BOOK_RUN_HOST=server (the recorder refuses --run without it)");
  if (!has(b, "StartLimitBurst=5") || !has(b, "StartLimitIntervalSec=900") || b.indexOf("StartLimitBurst=5") > b.indexOf("[Service]")) bad.push("traids-pm-book.service: no start limit in [Unit] (a crash loop would restart forever and never page)");
  if (!has(b, "WantedBy=multi-user.target")) bad.push("traids-pm-book.service: not enabled at boot");
  const ex = n.split("\n").filter((l) => /^ExecStart=/.test(l));
  if (ex.length !== 2 || !/--compress closed$/.test(ex[0]) || !/--summarize recent$/.test(ex[1])) bad.push("traids-pm-nightly.service: not 'compress closed' THEN 'summarize recent'");
  if (!has(units["traids-pm-nightly.timer"] || "", "OnCalendar=*-*-* 00:40:00 UTC")) bad.push("traids-pm-nightly.timer: not daily at 00:40 UTC");
  if (!has(units["traids-pm-health.service"] || "", `ExecStart=${NODE} ${REC} --health`)) bad.push("traids-pm-health.service: does not run --health");
  return bad;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.length === 1 && a[0] === "--write") { fs.mkdirSync(SD, { recursive: true }); for (const [f, t] of Object.entries(expected())) { fs.writeFileSync(path.join(SD, f), t); console.log("written systemd/" + f); } process.exitCode = 0; }
  else if (a.length === 1 && a[0] === "--check") {
    let bad = 0;
    for (const [f, t] of Object.entries(expected())) { let cur = null; try { cur = fs.readFileSync(path.join(SD, f), "utf8"); } catch { cur = null; } const ok = cur === t; if (!ok) bad++; console.log(`  ${ok ? "ok  " : "DIFF"} systemd/${f}`); }
    const iss = semanticIssues(); for (const i of iss) { bad++; console.log("  FAIL " + i); }
    if (!iss.length) console.log("  ok   every unit meets the house rules (User=traids, the ownership gate, OnFailure, Persistent=false, keyless)");
    console.log(`units check: ${bad ? bad + " problem(s)" : "0 failed"}`);
    process.exitCode = bad ? 1 : 0;
  } else { console.log("usage: node units.cjs --write | --check"); process.exitCode = 2; }
}
module.exports = { expected, semanticIssues, ALL_UNITS, SERVICES, TIMERS, ENABLED, UNIT, RB, NODE, REC, GATE };
