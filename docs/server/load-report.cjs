#!/usr/bin/env node
/**
 * SERVER LOAD REPORT — read-only (operator 2026-10-11: "i want to see that the current server cannot handle the load ... after its
 * built"). One ssh call. Prints what the VPS has, what is in use now, and for every traids-* service systemd's own record of its
 * last run: peak memory (cgroup memory.peak), CPU time, wall time and result. Then the three numbers that decide whether more
 * slices are needed: the largest single job, everything that stays resident, and whether swap has been touched.
 * Nothing is written on either machine.
 *   node docs/server/load-report.cjs [--host traids] [--json]
 */
"use strict";
const cp = require("child_process");
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const HOST = arg("--host", "traids"); if (!/^[A-Za-z0-9._@-]+$/.test(HOST)) { console.error("bad --host"); process.exit(2); }
const REMOTE = [
  "echo @@SYS; nproc; free -m | sed -n 2,3p; df -BM --output=size,used,avail / | tail -1; cat /proc/loadavg; uptime -s",
  "echo @@VM; grep -E '^(pswpin|pswpout|oom_kill) ' /proc/vmstat",
  "echo @@UNITS; for u in $(systemctl list-units 'traids-*' --type=service --all --no-legend --plain | awk '{print $1}'); do echo \"@@U $u\"; systemctl show \"$u\" -p Type -p ActiveState -p Result -p MemoryPeak -p MemoryCurrent -p CPUUsageNSec -p ExecMainStartTimestampMonotonic -p ExecMainExitTimestampMonotonic -p ExecMainStartTimestamp; done",
  "echo @@TIMERS; systemctl list-timers 'traids-*' --all --no-legend --plain | wc -l",
].join("; ");
const r = cp.spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", HOST, REMOTE], { encoding: "utf8", timeout: 120000, windowsHide: true });
if (r.status !== 0) { console.error(`ssh failed (exit ${r.status}): ${String(r.stderr).trim().slice(0, 300)}`); process.exit(1); }
const out = r.stdout, sec = (name) => { const m = new RegExp(`@@${name}\\n([\\s\\S]*?)(?=\\n@@[A-Z]+\\n|$)`).exec(out); return m ? m[1].trim() : ""; };
const sys = sec("SYS").split("\n"), mem = sys[1].trim().split(/\s+/), swp = sys[2].trim().split(/\s+/), dsk = sys[3].trim().split(/\s+/).map((x) => parseInt(x, 10)), load = sys[4].split(" ");
const vm = Object.fromEntries(sec("VM").split("\n").filter(Boolean).map((l) => l.split(" ")));
const units = sec("UNITS").split(/^@@U /m).slice(1).map((b) => { const [name, ...kv] = b.trim().split("\n"); const p = Object.fromEntries(kv.map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; })); const num = (v) => (/^\d+$/.test(v || "") ? Number(v) : null);
  const peak = num(p.MemoryPeak), cur = num(p.MemoryCurrent), cpu = num(p.CPUUsageNSec), s = num(p.ExecMainStartTimestampMonotonic), e = num(p.ExecMainExitTimestampMonotonic);
  return { name: name.trim(), type: p.Type, state: p.ActiveState, result: p.Result, peakMB: peak == null ? null : peak / 1048576, nowMB: cur == null ? null : cur / 1048576, cpuSec: cpu == null ? null : cpu / 1e9, wallSec: s && e && e > s ? (e - s) / 1e6 : null, last: p.ExecMainStartTimestamp || "" }; });
const S = { host: HOST, cores: Number(sys[0]), memTotalMB: Number(mem[1]), memUsedMB: Number(mem[2]), memAvailableMB: Number(mem[6]), swapTotalMB: Number(swp[1]), swapUsedMB: Number(swp[2]), diskTotalMB: dsk[0], diskUsedMB: dsk[1], diskFreeMB: dsk[2], load1: Number(load[0]), load5: Number(load[1]), load15: Number(load[2]), upSince: sys[5], swapInPages: Number(vm.pswpin || 0), swapOutPages: Number(vm.pswpout || 0), oomKills: Number(vm.oom_kill || 0), timers: Number(sec("TIMERS")) };
const resident = units.filter((u) => u.state === "active"), ran = units.filter((u) => u.peakMB != null);
const residentMB = resident.reduce((a, u) => a + (u.nowMB || 0), 0), biggest = ran.slice().sort((a, b) => b.peakMB - a.peakMB)[0] || null;
if (argv.includes("--json")) { console.log(JSON.stringify({ system: S, units }, null, 1)); process.exit(0); }
const f = (v, d = 0) => (v == null ? "n/a" : v.toFixed(d));
console.log(`SERVER LOAD REPORT — ${HOST}, up since ${S.upSince}\n`);
console.log(`  cores ${S.cores}   memory ${S.memTotalMB} MB (used ${S.memUsedMB}, available ${S.memAvailableMB})   swap ${S.swapUsedMB} of ${S.swapTotalMB} MB in use   disk ${(S.diskUsedMB / 1024).toFixed(0)} of ${(S.diskTotalMB / 1024).toFixed(0)} GB used`);
console.log(`  load average ${S.load1} / ${S.load5} / ${S.load15} (1 / 5 / 15 min; ${S.cores}.00 = every core busy)   traids timers ${S.timers}   services seen ${units.length}`);
console.log(`  since boot: swapped out ${S.swapOutPages} pages, swapped in ${S.swapInPages}, out-of-memory kills ${S.oomKills}\n`);
console.log(`  ${"service (last run)".padEnd(44)} ${"peak MB".padStart(8)} ${"cpu s".padStart(7)} ${"wall s".padStart(7)}  result`);
for (const u of ran.slice().sort((a, b) => b.peakMB - a.peakMB).slice(0, 18)) console.log(`  ${u.name.replace(/\.service$/, "").padEnd(44)} ${f(u.peakMB).padStart(8)} ${f(u.cpuSec, 1).padStart(7)} ${f(u.wallSec, 1).padStart(7)}  ${u.state === "active" ? "running" : u.result}`);
if (ran.length > 18) console.log(`  ... and ${ran.length - 18} smaller`);
console.log(`\nWHAT DECIDES IT`);
console.log(`  largest single job so far: ${biggest ? `${biggest.name.replace(/\.service$/, "")} at ${f(biggest.peakMB)} MB` : "none recorded"} — that is ${biggest ? (100 * biggest.peakMB / S.memTotalMB).toFixed(1) : "0"}% of memory`);
console.log(`  always-running services now: ${resident.length}, ${f(residentMB)} MB together`);
console.log(`  swap touched since boot: ${S.swapOutPages > 0 ? "YES — memory has run short at least once" : "no"}   out-of-memory kills: ${S.oomKills}`);
console.log(`  more slices are needed when: swap is being used during sessions, an out-of-memory kill appears, the 15-minute load stays above ${S.cores}.0, or a timer runs late. None of that is judged from an estimate.`);

// the minute-by-minute record (docs/server/load-log.cjs): the worst minute of each day, in New York time
const lg = cp.spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", HOST, "tail -n 15000 /home/traids/traids/backend/data/load-log.jsonl 2>/dev/null || true"], { encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
const rows = String(lg.stdout || "").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x && x.ts);
if (!rows.length) console.log(`\nMINUTE-BY-MINUTE RECORD: none yet (install it with: node docs/server/load-log.cjs --install)`);
else {
  const et = (ts) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" }).formatToParts(new Date(ts)).map((x) => [x.type, x.value])); return { day: `${p.year}-${p.month}-${p.day} ${p.weekday}`, hm: `${p.hour === "24" ? "00" : p.hour}:${p.minute}` }; };
  const days = {}; for (const r of rows) { const e = et(r.ts); (days[e.day] ||= []).push({ ...r, hm: e.hm }); }
  console.log(`\nMINUTE-BY-MINUTE RECORD (${rows.length} minutes; times in New York)   memory total ${rows[rows.length - 1].memTotalMB} MB, ${S.cores} cores`);
  console.log(`  ${"day".padEnd(15)} ${"minutes".padStart(7)}  ${"least memory free".padStart(22)}  ${"most swap".padStart(10)}  ${"highest 15-min load".padStart(20)}  largest process seen`);
  for (const d of Object.keys(days).sort()) { const R = days[d], lo = R.reduce((a, b) => (b.memAvailMB < a.memAvailMB ? b : a)), sw = R.reduce((a, b) => (b.swapUsedMB > a.swapUsedMB ? b : a)), ld = R.reduce((a, b) => (b.load15 > a.load15 ? b : a));
    let big = { mb: 0, cmd: "" }, at = ""; for (const r of R) for (const t of r.top || []) if (t.mb > big.mb) { big = t; at = r.hm; }
    console.log(`  ${d.padEnd(15)} ${String(R.length).padStart(7)}  ${(`${lo.memAvailMB} MB at ${lo.hm}`).padStart(22)}  ${(`${sw.swapUsedMB} MB`).padStart(10)}  ${(`${ld.load15} at ${ld.hm}`).padStart(20)}  ${big.mb} MB ${String(big.cmd).split("/").pop().slice(0, 40)} (${at})`); }
  const worst = rows.reduce((a, b) => (b.memAvailMB < a.memAvailMB ? b : a)), maxSwap = Math.max(...rows.map((r) => r.swapUsedMB)), maxLoad = Math.max(...rows.map((r) => r.load15));
  console.log(`  VERDICT SO FAR: least memory free ${worst.memAvailMB} of ${worst.memTotalMB} MB (${(100 * worst.memAvailMB / worst.memTotalMB).toFixed(0)}% free at the worst minute); most swap ${maxSwap} MB; highest 15-minute load ${maxLoad} on ${S.cores} cores -> ${maxSwap > 0 || worst.memAvailMB < 0.15 * worst.memTotalMB || maxLoad > S.cores ? "UNDER STRAIN: more slices are justified" : "the server is carrying what runs on it today with room to spare"}`);
}
