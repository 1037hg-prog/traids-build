#!/usr/bin/env node
/**
 * ROLLBACK package "backup" (health sweep 2026-10-05).
 *
 *   node rollback.cjs [--dry-run]
 *
 * Restores each live file from docs\health-fixes\2026-10-05\backups\<rel with \ -> __>.pre-backup. It refuses a file whose
 * live copy is no longer this package's staged bytes (someone changed it after the deploy — rolling back would erase their
 * change; merge by hand instead), and it refuses if a backup does not hash to the recorded baseSha. All files are checked
 * before any is restored. Then node -c on each restored file.
 *
 * Not undone (by design): backend/data/backup-status.json, written by the new backup.cjs, is left in place (a harmless status
 * record the old script never reads); archives already written are kept.
 */
const { spawnSync } = require("child_process");
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const REPO = "C:\\Users\\joshc\\Downloads\\traids (2)\\traids-bundle";
const BACKUPS = path.join(REPO, "docs", "health-fixes", "2026-10-05", "backups");
const PACKAGE = "backup";
const PKG = path.join(REPO, "docs", "health-fixes", "2026-10-05", "backup");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PKG, "manifest.json"), "utf8"));   // the same manifest deploy.cjs used
if (MANIFEST.package !== PACKAGE || !Array.isArray(MANIFEST.files)) { console.error("ROLLBACK REFUSED: manifest.json is not this package's"); process.exit(1); }
const FILES = MANIFEST.files;
const DRY = process.argv.includes("--dry-run");
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const livePath = (f) => path.join(REPO, f.rel);
const backupPath = (f) => path.join(BACKUPS, `${f.rel.replace(/\\/g, "__")}.pre-${PACKAGE}`);

const todo = [];
for (const f of FILES) {
  const b = backupPath(f);
  if (!fs.existsSync(b)) { console.error(`ROLLBACK REFUSED: no backup at ${b} — was this package deployed?`); process.exit(1); }
  if (sha(b) !== f.baseSha) { console.error(`ROLLBACK REFUSED: ${b} does not hash to baseSha`); process.exit(1); }
  const l = sha(livePath(f));
  if (l === f.baseSha) { console.log(`  skip ${f.rel}: already the pre-deploy bytes`); continue; }
  if (l !== f.stagedSha) { console.error(`ROLLBACK REFUSED: live ${f.rel} (${l.slice(0, 12)}) is neither this package's deploy nor the original — it changed after the deploy; merge by hand. Nothing restored.`); process.exit(1); }
  todo.push(f);
}
if (DRY) { console.log(`dry run: would restore ${todo.map((f) => f.rel).join(", ") || "nothing"}`); process.exit(0); }
let bad = 0;
for (const f of todo) {
  fs.copyFileSync(backupPath(f), livePath(f));
  const ok = sha(livePath(f)) === f.baseSha && spawnSync(process.execPath, ["-c", livePath(f)]).status === 0;
  console.log(`  ${ok ? "ok  " : "FAIL"} restored ${f.rel}`);
  if (!ok) bad++;
}
console.log(bad ? `ROLLBACK INCOMPLETE (${bad} file(s)) — restore by hand from ${BACKUPS}` : `ROLLED BACK package "${PACKAGE}" (${todo.length} file(s))`);
process.exit(bad ? 1 : 0);
