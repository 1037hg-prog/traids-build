#!/usr/bin/env node
/**
 * ROLLBACK package "backup-onedrive" (2026-10-05).
 *
 *   node rollback.cjs [--dry-run]                      undo THIS package: restore automation\backup.cjs and
 *                                                      automation\backup-secret-scan.cjs from backups\*.pre-onedrive-fix
 *                                                      (tonight's live OneDrive edit, bbb17314 / 3feb9919)
 *   node rollback.cjs --to pre-onedrive [--dry-run]    undo the OneDrive mirror ENTIRELY: restore automation\backup.cjs from
 *                                                      backups\automation__backup.cjs.pre-onedrive (e6995692, the "backup"
 *                                                      package's deployed version: no default mirror, no secret scan)
 *
 * Default mode refuses a file whose live copy is neither this package's staged bytes nor the pre-fix bytes (someone changed it
 * after the deploy: merge by hand), and refuses a backup that does not hash to the manifest's baseSha. All files are checked
 * before any is restored; node -c after.
 *
 * --to pre-onedrive accepts a live backup.cjs that is this package's staged bytes or the pre-fix bytes. backup-secret-scan.cjs
 * is left in place (the pre-OneDrive backup.cjs never loads it; nothing else does). From there the "backup" package's own
 * rollback.cjs works again (its live == stagedSha check passes) if you need to go back further.
 *
 * Not undone (by design): backend\data\backup-status.json records, archives already written, files already in the OneDrive mirror.
 */
const { spawnSync } = require("child_process");
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const REPO = "C:\\Users\\joshc\\Downloads\\traids (2)\\traids-bundle";
const PKG = path.join(REPO, "docs", "health-fixes", "2026-10-05", "backup-onedrive");
const BACKUPS = path.join(REPO, "docs", "health-fixes", "2026-10-05", "backups");
const PACKAGE = "backup-onedrive", SUFFIX = "pre-onedrive-fix";
const PRE_ONEDRIVE = { rel: "automation\\backup.cjs", file: path.join(BACKUPS, "automation__backup.cjs.pre-onedrive"), sha: "e6995692a90692e3c44caff1c5d3c0cad425d2aba9e0250aadb475a4d04250de" };
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PKG, "manifest.json"), "utf8"));
if (MANIFEST.package !== PACKAGE || !Array.isArray(MANIFEST.files)) { console.error("ROLLBACK REFUSED: manifest.json is not this package's"); process.exit(1); }
const FILES = MANIFEST.files;
const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const ti = argv.indexOf("--to"), TO = ti >= 0 ? argv[ti + 1] : null;
if (TO && TO !== "pre-onedrive") { console.error("usage: rollback.cjs [--to pre-onedrive] [--dry-run]"); process.exit(2); }
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const livePath = (f) => path.join(REPO, f.rel);
const backupPath = (f) => path.join(BACKUPS, `${f.rel.replace(/\\/g, "__")}.${SUFFIX}`);
const refuse = (m) => { console.error(`ROLLBACK REFUSED: ${m}. Nothing restored.`); process.exit(1); };
const log = (rec) => { if (!DRY) try { fs.appendFileSync(path.join(PKG, "deploy-log.jsonl"), JSON.stringify({ at: new Date().toISOString(), package: PACKAGE, ...rec }) + "\n"); } catch { } };

if (TO === "pre-onedrive") {
  const f = FILES.find((x) => x.rel === PRE_ONEDRIVE.rel);
  if (!fs.existsSync(PRE_ONEDRIVE.file)) refuse(`no backup at ${PRE_ONEDRIVE.file}`);
  if (sha(PRE_ONEDRIVE.file) !== PRE_ONEDRIVE.sha) refuse(`${PRE_ONEDRIVE.file} does not hash to ${PRE_ONEDRIVE.sha.slice(0, 12)}`);
  const l = sha(livePath(f));
  if (l === PRE_ONEDRIVE.sha) { console.log("  skip automation\\backup.cjs: already the pre-OneDrive bytes"); process.exit(0); }
  if (l !== f.stagedSha && l !== f.baseSha) refuse(`live automation\\backup.cjs (${l.slice(0, 12)}) is neither this package's deploy nor tonight's OneDrive edit — merge by hand`);
  if (DRY) { console.log(`dry run: would restore automation\\backup.cjs from ${path.basename(PRE_ONEDRIVE.file)} (${PRE_ONEDRIVE.sha.slice(0, 12)}); backup-secret-scan.cjs left in place`); process.exit(0); }
  fs.copyFileSync(PRE_ONEDRIVE.file, livePath(f));
  const ok = sha(livePath(f)) === PRE_ONEDRIVE.sha && spawnSync(process.execPath, ["-c", livePath(f)]).status === 0;
  console.log(`  ${ok ? "ok  " : "FAIL"} restored automation\\backup.cjs to the pre-OneDrive version`);
  log({ result: ok ? "rolled back to pre-onedrive" : "rollback to pre-onedrive FAILED" });
  console.log(ok ? "ROLLED BACK to pre-OneDrive: no default mirror, no secret scan (backup-secret-scan.cjs is unused and left in place)" : `ROLLBACK INCOMPLETE — restore by hand from ${PRE_ONEDRIVE.file}`);
  process.exit(ok ? 0 : 1);
}

const todo = [];
for (const f of FILES) {
  const b = backupPath(f);
  if (!fs.existsSync(b)) refuse(`no backup at ${b} — was this package deployed?`);
  if (sha(b) !== f.baseSha) refuse(`${b} does not hash to baseSha`);
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
console.log(bad ? `ROLLBACK INCOMPLETE (${bad} file(s)) — restore by hand from ${BACKUPS}` : `ROLLED BACK package "${PACKAGE}" (${todo.length} file(s)) to tonight's OneDrive edit`);
process.exit(bad ? 1 : 0);
