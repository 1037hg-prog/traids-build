#!/usr/bin/env node
/**
 * SELFTEST — every selftest in the R309 go-live package, offline (no ssh, no network, no repo data file written; temp dirs only).
 *   r309 --selftest (staged r309-v2) · pull-r309 · r309-health · place-secrets · traids-alert · home-patch (patches applied to temp
 *   copies of the CURRENT home files + the patched preflight-checks selftest) · deploy · rollback · register-tv-note (temp copies) ·
 *   register-evidence-start (temp copies) · make-pull-task (in memory).
 * The invariance proof (old vs new on real Coinbase hours, and the dry cycles) needs the network: invariance.cjs.
 *   node docs/server/phase0-golive/selftest.cjs        exit 0 = all passed
 */
"use strict";
const path = require("path"), cp = require("child_process");
const H = __dirname;
const RUNS = [
  ["r309 --selftest (staged r309-v2)", path.join(H, "backend", "r309-surge-hold48.js"), ["--selftest"], /SELFTEST PASSED/],
  ["pull-r309 --selftest", path.join(H, "pull-r309.cjs"), ["--selftest"], / 0 failed/],
  ["r309-health --selftest", path.join(H, "r309-health.cjs"), ["--selftest"], / 0 failed/],
  ["place-secrets --selftest", path.join(H, "place-secrets.cjs"), ["--selftest"], / 0 failed/],
  ["traids-alert --selftest", path.join(H, "backend", "traids-alert.cjs"), ["--selftest"], / 0 failed/],
  ["home-patch --selftest", path.join(H, "home-patch.cjs"), ["--selftest"], / 0 failed/],
  ["deploy --selftest", path.join(H, "deploy.cjs"), ["--selftest"], / 0 failed/],
  ["rollback --selftest", path.join(H, "rollback.cjs"), ["--selftest"], / 0 failed/],
  ["register-tv-note --selftest", path.join(H, "register-tv-note.cjs"), ["--selftest"], / 0 failed/],
  ["register-evidence-start --selftest", path.join(H, "register-evidence-start.cjs"), ["--selftest"], / 0 failed/],
  ["make-pull-task --selftest", path.join(H, "make-pull-task.cjs"), ["--selftest"], / 0 failed/],
];
let bad = 0;
for (const [name, file, args, re] of RUNS) {
  // the child gets no Alpaca / Telegram values: the selftests must not depend on (or touch) real keys
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/ALPACA|TELEGRAM|SMTP|SCHWAB|TASTY|ANTHROPIC|NTFY/i.test(k)));
  const r = cp.spawnSync(process.execPath, [file, ...args], { cwd: path.dirname(file), encoding: "utf8", timeout: 600000, windowsHide: true, env });
  const out = String(r.stdout || ""), okLines = (out.match(/^\s+(ok|PASS)\b/gm) || []).length, failLines = (out.match(/^\s+FAIL\b/gm) || []).length;
  const ok = r.status === 0 && re.test(out) && failLines === 0;
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(36)} ${okLines} ok, ${failLines} failed, exit ${r.status}${ok ? "" : "\n" + (out + String(r.stderr || "")).split("\n").filter((l) => /FAIL|Error|error/.test(l)).slice(0, 12).join("\n")}`);
}
console.log(bad ? `SELFTEST: ${bad} of ${RUNS.length} FAILED` : `ALL ${RUNS.length} SELFTESTS PASSED`);
process.exitCode = bad ? 1 : 0;
