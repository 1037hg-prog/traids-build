#!/usr/bin/env node
/**
 * ROLLBACK package "backup-git-bundle" (2026-10-05).
 *
 *   node rollback.cjs [--dry-run]    restore automation\backup.cjs and automation\backup-secret-scan.cjs from
 *                                    backups\*.pre-backup-git-bundle (package backup-onedrive as deployed: a5486b1a / 8e012686 —
 *                                    the OneDrive mirror + archive secret scan, no git bundle)
 *
 * Refuses a file whose live copy is neither this package's staged bytes nor the pre-deploy bytes (someone changed it after the
 * deploy: merge by hand), and refuses a backup that does not hash to the manifest's baseSha. All files are checked before any
 * is restored; node -c after. From there package backup-onedrive's own rollback.cjs works again (its live == stagedSha check
 * passes) if you need to go back further.
 *
 * Not undone (by design): backend\data\backup-status.json records (full.bundle stays until the next FULL run rewrites the
 * record), traids-git-*.bundle files already in DEST or the mirror (delete by hand if unwanted; nothing else reads them).
 */
const { spawnSync } = require("child_process");
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const REPO = "C:\\Users\\joshc\\Downloads\\traids (2)\\traids-bundle";
const PKG = path.join(REPO, "docs", "health-fixes", "2026-10-05", "backup-git-bundle");
const BACKUPS = path.join(REPO, "docs", "health-fixes", "2026-10-05", "backups");
const PACKAGE = "backup-git-bundle", SUFFIX = "pre-backup-git-bundle";
const { writeTextAtomic } = require(path.join(REPO, "backend", "lib", "atomic-write.js"));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PKG, "manifest.json"), "utf8"));
if (MANIFEST.package !== PACKAGE || !Array.isArray(MANIFEST.files)) { console.error("ROLLBACK REFUSED: manifest.json is not this package's"); process.exit(1); }
const FILES = MANIFEST.files;
const DRY = process.argv.slice(2).includes("--dry-run");
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const livePath = (f) => path.join(REPO, f.rel);
const backupPath = (f) => path.join(BACKUPS, `${f.rel.replace(/\\/g, "__")}.${SUFFIX}`);
const refuse = (m) => { console.error(`ROLLBACK REFUSED: ${m}. Nothing restored.`); process.exit(1); };
const LOG = path.join(PKG, "deploy-log.jsonl");
const log = (rec) => { if (DRY) return; try { let cur = ""; try { cur = fs.readFileSync(LOG, "utf8"); } catch { } writeTextAtomic(LOG, cur + JSON.stringify({ at: new Date().toISOString(), package: PACKAGE, ...rec }) + "\n"); } catch { } };

const todo = [];
for (const f of FILES) {
  const b = backupPath(f);
  if (!fs.existsSync(b)) refuse(`no backup at ${b} — was this package deployed?`);
  if (sha(b) !== f.baseSha) refuse(`${b} does not hash to baseSha ${f.baseSha.slice(0, 12)}`);
  const l = sha(livePath(f));
  if (l === f.baseSha) { console.log(`  skip ${f.rel}: already the pre-deploy bytes`); continue; }
  if (l !== f.stagedSha) refuse(`live ${f.rel} (${l.slice(0, 12)}) is neither this package's deploy nor the original — it changed after the deploy; merge by hand`);
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
log({ result: bad ? "rollback incomplete" : "rolled back", files: todo.map((f) => f.rel) });
console.log(bad ? `ROLLBACK INCOMPLETE (${bad} file(s)) — restore by hand from ${BACKUPS}` : `ROLLED BACK package "${PACKAGE}" (${todo.length} file(s)): no git bundle; the OneDrive mirror + archive scan stay as deployed by backup-onedrive`);
process.exit(bad ? 1 : 0);
