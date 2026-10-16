#!/usr/bin/env node
/**
 * NIGHTLY GIT SNAPSHOT (2026-08-03, "fix it all") — commit the day's ledgers and code.
 *
 * The evidentiary record's value is that it can't be quietly rewritten. A daily commit gives
 * every ledger file a tamper-evident history from tonight forward. .gitignore already excludes
 * secrets (all .env files), node_modules, training cache. If a remote named `origin` exists we push;
 * until the user sets one up this stays local (still protects against edits, not disk loss —
 * backup.cjs covers that).
 */
const { execFileSync } = require("child_process");
const path = require("path");
const ROOT = path.join(__dirname, "..");
// maxBuffer raised 2026-09-09 (audit): the 1MB default is the same trap that silently broke
// preflight's secrets check — a porcelain status over ~1300 changed files is not far off it.
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", timeout: 8 * 60000, maxBuffer: 64 * 1024 * 1024 });

try {
  const status = git("status", "--porcelain");
  if (!status.trim()) { console.log("git snapshot: nothing changed"); process.exit(0); }
  // Safety: refuse if any .env would be staged (belt-and-suspenders over .gitignore)
  git("add", "-A");
  const staged = git("diff", "--cached", "--name-only");
  if (/(^|\/)\.env$/m.test(staged)) {
    console.error("git snapshot REFUSED: a .env file is staged — check .gitignore");
    git("reset");
    process.exit(1);
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const n = staged.trim().split("\n").length;
  // 2026-09-22 (operator: hook option A): the pre-commit CI hook lets THIS commit through, so a red test can never stop the nightly evidence commit.
  process.env.TRAIDS_SNAPSHOT = "1";
  git("commit", "-m", `nightly snapshot ${stamp} — ${n} files\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>`);
  let pushed = "local only (no remote configured)";
  try {
    const remotes = git("remote").trim();
    if (remotes.split("\n").includes("origin")) { git("push", "origin", "HEAD"); pushed = "pushed to origin"; }
  } catch (e) { pushed = `push failed: ${e.message.slice(0, 120)}`; }
  console.log(`git snapshot ok: ${n} files committed · ${pushed}`);
} catch (e) {
  console.error("git snapshot FAILED:", e.message.slice(0, 300));
  process.exit(1);
}
