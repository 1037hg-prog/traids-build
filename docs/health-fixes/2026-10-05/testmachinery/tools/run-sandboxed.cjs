"use strict";
/**
 * runSandboxed({ rel, staged, args, out, timeoutMs }) — run backend/<rel> as the MAIN module under tools/sandbox-preload.cjs:
 * writes inside the repo are redirected to `out`, child processes are refused (except a read-only schtasks query), and when
 * `staged` is given the staged source is swapped in for the live file (same __dirname, same require resolution).
 * Returns { status, signal, stdout, stderr, writes[] }. Never require()s the target.
 */
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const REPO = "C:\\Users\\joshc\\Downloads\\traids (2)\\traids-bundle";
const PRELOAD = path.join(__dirname, "sandbox-preload.cjs");

function runSandboxed({ rel, staged = null, args = [], out, timeoutMs = 600000, env = {} }) {
  if (!rel || !out) throw new Error("runSandboxed needs { rel, out }");
  const live = path.join(REPO, rel);
  fs.mkdirSync(out, { recursive: true });
  const r = spawnSync(process.execPath, ["--require", PRELOAD, live, ...args], {
    cwd: REPO, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, ...env, SANDBOX_REPO: REPO, SANDBOX_OUT: out, ...(staged ? { SANDBOX_SWAP_FROM: live, SANDBOX_SWAP_TO: staged } : {}) },
  });
  let writes = [];
  try { writes = fs.readFileSync(path.join(out, "_sandbox-writes.log"), "utf8").trim().split(/\r?\n/).filter(Boolean); } catch {}
  return { status: r.status, signal: r.signal, error: r.error ? r.error.message : null, stdout: r.stdout || "", stderr: r.stderr || "", writes };
}
const sandboxPath = (out, rel) => path.join(out, rel.replace(/[\\/]/g, "__"));
module.exports = { runSandboxed, sandboxPath, REPO };
