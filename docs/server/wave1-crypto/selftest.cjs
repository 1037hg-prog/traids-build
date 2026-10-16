#!/usr/bin/env node
/**
 * SELFTEST — every selftest in the W1 package, offline (no ssh, no network; temp dirs and fake VPSes only). 2026-10-07.
 *   generators (manifests.cjs --check, units.cjs --check) · pull-server (incl. R309 parity with pull-r309.cjs's own cases) · own · own-check ·
 *   w1-run · w1-probe · w1-health · home-patch (anchored edits on temp copies of the CURRENT home files + the patched runner on a
 *   SCRATCH copy of close-chain.cjs with a fake step list, run as a child — the real chain is never required or run) · compare-w1 ·
 *   register-w1 (temp copies) · deploy (pure parts) · rollback (pure parts, a fake VPS).
 * Then proves the repo was not touched: the sha256 of every home file the package edits and the absence of every file it would create
 * are the same after the run as before.
 *   node docs/server/wave1-crypto/selftest.cjs        exit 0 = all passed
 */
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
const H = __dirname, REPO = path.resolve(H, "..", "..", "..");
const RUNS = [
  ["manifests.cjs --check", path.join(H, "manifests.cjs"), ["--check"], /ok\s+manifests\/w1\.json/],
  ["units.cjs --check", path.join(H, "units.cjs"), ["--check"], /ok\s+systemd\/traids-w1s-social\.timer/],
  ["pull-server --selftest", path.join(H, "pull-server.cjs"), ["--selftest"], / 0 failed/],
  ["own --selftest", path.join(H, "own.cjs"), ["--selftest"], / 0 failed/],
  ["own-check --selftest", path.join(H, "backend", "own-check.cjs"), ["--selftest"], / 0 failed/],
  ["w1-run --selftest", path.join(H, "backend", "w1-run.cjs"), ["--selftest"], / 0 failed/],
  ["w1-probe --selftest", path.join(H, "backend", "w1-probe.cjs"), ["--selftest"], / 0 failed/],
  ["w1-health --selftest", path.join(H, "w1-health.cjs"), ["--selftest"], / 0 failed/],
  ["home-patch --selftest", path.join(H, "home-patch.cjs"), ["--selftest"], / 0 failed/],
  ["compare-w1 --selftest", path.join(H, "compare-w1.cjs"), ["--selftest"], / 0 failed/],
  ["register-w1 --selftest", path.join(H, "register-w1.cjs"), ["--selftest"], / 0 failed/],
  ["deploy --selftest", path.join(H, "deploy.cjs"), ["--selftest"], / 0 failed/],
  ["rollback --selftest", path.join(H, "rollback.cjs"), ["--selftest"], / 0 failed/],
];
const WATCH = ["automation/close-chain.cjs", "automation/preflight.bat", "backend/preflight.js", "backend/ops-health.js", "backend/data/change-registry.json", "backend/data/host-ownership.json", "backend/data/pull-server-status.json", "backend/lib/w1-health.cjs", "deploy/server/pull-server.cjs", "deploy/server/own.cjs", "deploy/server/manifests", "backend/data/r309-HALT"];
const snap = () => WATCH.map((rel) => { const f = path.join(REPO, rel); if (!fs.existsSync(f)) return rel + ":absent"; const s = fs.statSync(f); return rel + ":" + (s.isDirectory() ? "dir" : crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex").slice(0, 16)); }).join("\n");
const before = snap();
let bad = 0, total = 0;
for (const [name, file, args, re] of RUNS) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/ALPACA|TELEGRAM|SMTP|SCHWAB|TASTY|ANTHROPIC|NTFY|OPENAI|GEMINI/i.test(k)));
  const r = cp.spawnSync(process.execPath, [file, ...args], { cwd: path.dirname(file), encoding: "utf8", timeout: 600000, windowsHide: true, env });
  const out = String(r.stdout || ""), okLines = (out.match(/^\s+(ok|PASS)\b/gm) || []).length, failLines = (out.match(/^\s+FAIL\b|^DIFF\b/gm) || []).length;
  const ok = r.status === 0 && re.test(out) && failLines === 0;
  total += okLines; if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(26)} ${okLines} ok, ${failLines} failed, exit ${r.status}${ok ? "" : "\n" + (out + String(r.stderr || "")).split("\n").filter((l) => /FAIL|DIFF|Error|error/.test(l)).slice(0, 12).join("\n")}`);
}
const after = snap(), same = before === after;
if (!same) bad++;
console.log(`${same ? "PASS" : "FAIL"}  repo untouched             ${WATCH.length} watched paths ${same ? "identical before and after" : "CHANGED:\n" + after.split("\n").filter((l, i) => l !== before.split("\n")[i]).join("\n")}`);
console.log(bad ? `SELFTEST: ${bad} of ${RUNS.length + 1} FAILED` : `ALL ${RUNS.length + 1} CHECKS PASSED (${total} selftest cases)`);
process.exitCode = bad ? 1 : 0;
