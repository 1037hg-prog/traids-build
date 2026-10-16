#!/usr/bin/env node
"use strict";
/**
 * VERIFY (package "alerting", 2026-10-05) — run the STAGED preflight once, read-only, against the LIVE state, before deploy.
 *   node "docs/health-fixes/2026-10-05/alerting/verify-live.cjs" [--selftest]
 * Runs `backend/preflight.js --no-write` (or --selftest) as the main module under tools/harness-preload.cjs: the staged sources are
 * compiled in place of the live ones (live __dirname, live data/), every write inside the repo throws, off-box fetches are GET-only
 * (the existing Schwab OAuth POST probe is refused and reads "probe failed"), and only `git ls-files` may spawn. ops-alert is never run,
 * and with --no-write data/preflight-status.json is not touched, so nothing can page anyone.
 */
const path = require("path"), { spawnSync } = require("child_process");
const REPO = "C:\\Users\\joshc\\Downloads\\traids (2)\\traids-bundle";
const args = process.argv.includes("--selftest") ? ["--selftest"] : ["--no-write"];
const r = spawnSync(process.execPath, ["--require", path.join(__dirname, "tools", "harness-preload.cjs"), path.join(REPO, "backend", "preflight.js"), ...args], {
  cwd: REPO, encoding: "utf8", timeout: 180000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  env: { ...process.env, ALERTING_REPO: REPO, ALERTING_STAGED: path.join(__dirname, "staged") },
});
process.stdout.write(r.stdout || ""); process.stderr.write(r.stderr || "");
if (r.error) console.error("verify: spawn error " + r.error.message);
console.log(`\nverify: staged preflight ${args.join(" ")} exited ${r.status}${r.signal ? " (" + r.signal + ")" : ""}`);
process.exit(r.status == null ? 1 : 0);
