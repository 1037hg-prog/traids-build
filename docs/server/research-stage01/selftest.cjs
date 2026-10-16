#!/usr/bin/env node
/**
 * SELFTEST — every selftest in research-stage01, offline: no ssh, no network, no real Claude CLI, no repo file written (temp dirs
 * only; the real backend/data is only READ, and home-patch proves it unchanged). Children get no ANTHROPIC / ALPACA / TELEGRAM /
 * SMTP / SCHWAB / CLAUDE token values from this environment.
 *   node docs/server/research-stage01/selftest.cjs        exit 0 = all passed
 */
"use strict";
const path = require("path"), cp = require("child_process");
const H = __dirname;
const RUNS = [
  ["registry-view (staged home lib)", "home/backend/lib/registry-view.js", ["--selftest"]],
  ["registry-namespace-check (staged)", "home/backend/registry-namespace-check.js", ["--selftest"]],
  ["home-patch (byte-identical + F fixture +1)", "home-patch.cjs", ["--selftest"]],
  ["limit.cjs (corpus)", "server/factory/lib/limit.cjs", ["--selftest"]],
  ["budget.cjs (weekly cap, plan week)", "server/factory/lib/budget.cjs", ["--selftest"]],
  ["claude-run.cjs (argv, env, lanes)", "server/factory/bin/claude-run.cjs", ["--selftest"]],
  ["claude-run end-to-end (fake CLI)", "test/claude-run-e2e.cjs", []],
  ["place-claude-token", "place-claude-token.cjs", ["--selftest"]],
  ["make-avoid-list (IP rule)", "make-avoid-list.cjs", ["--selftest"]],
  ["push-inputs", "push-inputs.cjs", ["--selftest"]],
  ["pull-factory", "pull-factory.cjs", ["--selftest"]],
  ["install-server (units, scripts)", "install-server.cjs", ["--selftest"]],
  ["fable-trial", "fable-trial.cjs", ["--selftest"]],
  ["deploy", "deploy.cjs", ["--selftest"]],
  ["rollback", "rollback.cjs", ["--selftest"]],
];
let bad = 0, total = 0;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/ANTHROPIC|ALPACA|TELEGRAM|SMTP|SCHWAB|TASTY|NTFY|CLAUDE_CODE_OAUTH|CLAUDE_SERVER_OAUTH/i.test(k)));
for (const [name, rel, args] of RUNS) {
  const file = path.join(H, rel);
  const r = cp.spawnSync(process.execPath, [file, ...args], { cwd: path.dirname(file), encoding: "utf8", timeout: 900000, windowsHide: true, env });
  const out = String(r.stdout || ""), okLines = (out.match(/^\s+ok\b/gm) || []).length, failLines = (out.match(/^\s+FAIL\b/gm) || []).length;
  const ok = r.status === 0 && / 0 failed/.test(out) && failLines === 0;
  total += okLines; if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(44)} ${String(okLines).padStart(3)} ok, ${failLines} failed, exit ${r.status}${ok ? "" : "\n" + (out + String(r.stderr || "")).split("\n").filter((l) => /FAIL|Error|error/.test(l)).slice(0, 12).join("\n")}`);
}
console.log(bad ? `SELFTEST: ${bad} of ${RUNS.length} FAILED` : `ALL ${RUNS.length} SELFTESTS PASSED (${total} checks)`);
process.exitCode = bad ? 1 : 0;
