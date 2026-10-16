#!/usr/bin/env node
/**
 * chainfix selftest. Runs each check in its own child process (selftest-child.cjs) and reports.
 *   node selftest.cjs                 checks the STAGED files (compiled as if at their live paths)
 *   node selftest.cjs --target=live   checks the LIVE files (deploy.cjs runs this after copying)
 *   --quick                           skips the full routine-necessity run (~1 min)
 * Writes nothing to backend/data, places no order, needs no network (crypto + cache checks are stubbed).
 * The `grep` and `rn` checks read the git tree (git grep / git log), exactly as the chain step does.
 * Exit 0 = every check PASS; 1 = any FAIL or UNKNOWN (a check that did not report is not a pass).
 */
"use strict";
const path = require("path"), cp = require("child_process");
const PKG = __dirname;
const target = (process.argv.find((a) => a.startsWith("--target=")) || "--target=staged").slice(9);
if (!["staged", "live"].includes(target)) { console.error("--target must be staged or live"); process.exit(2); }
const quick = process.argv.includes("--quick");
const MODES = [["calendar", 60e3], ["cache", 60e3], ["warm", 60e3], ["crypto", 90e3], ["grep", 300e3], ...(quick ? [] : [["rn", 600e3]])];

let allOk = true;
console.log(`chainfix selftest · target=${target}${quick ? " · quick" : ""} · ${new Date().toISOString()}`);
for (const [mode, timeout] of MODES) {
  const t0 = Date.now();
  const r = cp.spawnSync(process.execPath, [path.join(PKG, "selftest-child.cjs"), mode, target],
    { cwd: path.join(PKG, "..", "..", "..", ".."), encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 1 << 26, windowsHide: true });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const line = String(r.stdout || "").split("\n").reverse().find((l) => l.startsWith("@@RESULT "));
  let res = null; try { res = line ? JSON.parse(line.slice(9)) : null; } catch {}
  if (!res) {
    allOk = false;
    console.log(`  UNKNOWN ${mode.padEnd(9)} ${secs}s — no result (${r.error ? r.error.code || r.error.message : "exit " + r.status}) ${String(r.stderr || "").slice(-300)}`);
    continue;
  }
  if (!res.ok) allOk = false;
  console.log(`  ${res.ok ? "PASS   " : "FAIL   "} ${mode.padEnd(9)} ${secs}s${res.error ? " — ERROR " + res.error : ""}`);
  for (const c of res.checks) console.log(`      ${c.ok ? "ok  " : "FAIL"} ${c.name}${c.detail !== undefined && (!c.ok || mode === "grep" || mode === "rn") ? "  " + JSON.stringify(c.detail).slice(0, 300) : ""}`);
}
console.log(allOk ? "\nSELFTEST PASS" : "\nSELFTEST FAIL");
process.exit(allOk ? 0 : 1);
