#!/usr/bin/env node
/**
 * SERVER LOAD LOG — a one-line-a-minute recorder on the VPS, so "can this server carry the load" is answered from what happened,
 * not from an estimate (operator 2026-10-11: "i want to see that the current server cannot handle the load ... after its built").
 * It records: memory available, swap in use, the 1/5/15-minute load, and the three largest processes. Nothing else; it trades
 * nothing, reads no secret, and no TRAIDS unit depends on it. Read it with `node docs/server/load-report.cjs`.
 *   node docs/server/load-log.cjs --install      writes deploy/server/load-log.sh and the traids-loadlog service + timer; starts it
 *   node docs/server/load-log.cjs --uninstall    stops and removes all three (the log file is kept)
 *   node docs/server/load-log.cjs --status       read-only
 */
"use strict";
const cp = require("child_process");
const HOST = "traids", RB = "/home/traids/traids", SH = `${RB}/deploy/server/load-log.sh`, LOG = `${RB}/backend/data/load-log.jsonl`, SYSD = "/etc/systemd/system";
const ssh = (script, input) => cp.spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", HOST, script], { input, encoding: "utf8", timeout: 120000, windowsHide: true });
const SCRIPT = `#!/bin/bash
# TRAIDS load log: one JSON line a minute (docs/server/load-log.cjs). Reads /proc only.
set -u
L=${LOG}
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mt=$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo)
ma=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)
st=$(awk '/^SwapTotal:/{print int($2/1024)}' /proc/meminfo)
sf=$(awk '/^SwapFree:/{print int($2/1024)}' /proc/meminfo)
read -r l1 l5 l15 _ < /proc/loadavg
top=$(ps -eo rss=,args= --sort=-rss | awk 'NR<=3{c=$2; for(i=3;i<=NF&&i<=4;i++)c=c" "$i; gsub(/[^A-Za-z0-9 ._\\/-]/,"",c); printf "%s{\\"mb\\":%d,\\"cmd\\":\\"%s\\"}", (NR>1?",":""), int($1/1024), substr(c,1,70)}')
printf '{"ts":"%s","memTotalMB":%s,"memAvailMB":%s,"swapUsedMB":%s,"load1":%s,"load5":%s,"load15":%s,"top":[%s]}\\n' "$ts" "$mt" "$ma" "$((st-sf))" "$l1" "$l5" "$l15" "$top" >> "$L"
sz=$(stat -c %s "$L" 2>/dev/null || echo 0)
if [ "$sz" -gt 52428800 ]; then mv -f "$L" "$L.1"; fi
exit 0
`;
const SERVICE = `[Unit]\nDescription=TRAIDS load log (one line a minute; docs/server/load-log.cjs)\n\n[Service]\nType=oneshot\nUser=traids\nExecStart=/bin/bash ${SH}\n`;
const TIMER = `[Unit]\nDescription=TRAIDS load log, every minute\n\n[Timer]\nOnCalendar=*:*:00\nAccuracySec=5s\nPersistent=false\n\n[Install]\nWantedBy=timers.target\n`;
const mode = process.argv[2];
const must = (r, what) => { if (r.status !== 0) { console.error(`${what} failed (exit ${r.status}): ${String(r.stderr || r.stdout).trim().slice(0, 300)}`); process.exit(1); } return r.stdout; };
if (mode === "--install") {
  must(ssh(`set -e; mkdir -p ${RB}/deploy/server; cat > ${SH}.tmp; chmod 755 ${SH}.tmp; mv -f ${SH}.tmp ${SH}; bash -n ${SH}`, SCRIPT), "script");
  must(ssh(`set -e; sudo -n tee ${SYSD}/traids-loadlog.service > /dev/null; sudo -n chmod 644 ${SYSD}/traids-loadlog.service`, SERVICE), "service");
  must(ssh(`set -e; sudo -n tee ${SYSD}/traids-loadlog.timer > /dev/null; sudo -n chmod 644 ${SYSD}/traids-loadlog.timer; sudo -n systemctl daemon-reload; sudo -n systemctl enable --now traids-loadlog.timer; sudo -n systemctl start traids-loadlog.service; sleep 1; tail -n 1 ${LOG}`, TIMER), "timer");
  const line = ssh(`tail -n 1 ${LOG}`).stdout.trim(); let ok = false; try { ok = !!JSON.parse(line).ts; } catch { }
  console.log(ok ? `installed and running; first line: ${line.slice(0, 220)}` : `installed, but the first line does not parse: ${line.slice(0, 220)}`); process.exit(ok ? 0 : 1);
} else if (mode === "--uninstall") {
  must(ssh(`sudo -n systemctl disable --now traids-loadlog.timer 2>/dev/null; sudo -n rm -f ${SYSD}/traids-loadlog.timer ${SYSD}/traids-loadlog.service; sudo -n systemctl daemon-reload; rm -f ${SH}; echo removed`), "uninstall");
  console.log(`removed the timer, the service and the script; ${LOG} is kept`);
} else if (mode === "--status") {
  console.log(must(ssh(`systemctl is-active traids-loadlog.timer 2>&1; systemctl is-enabled traids-loadlog.timer 2>&1; test -f ${LOG} && { wc -l < ${LOG}; head -n 1 ${LOG} | cut -c1-40; tail -n 1 ${LOG} | cut -c1-200; } || echo "no log yet"`), "status").trim());
} else { console.error("usage: load-log.cjs --install | --uninstall | --status"); process.exit(2); }
