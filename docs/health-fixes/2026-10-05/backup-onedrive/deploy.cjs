#!/usr/bin/env node
/**
 * DEPLOY package "backup-onedrive" (2026-10-05): review fix of tonight's OneDrive mirror + secret scan
 * (B1, M1-M4, m1-m5 — see NOTES.md).
 *
 *   node deploy.cjs [--dry-run] [--no-process-check] [--dir <fixture base>]
 *
 * 1. manifest.json must be this package's; every staged file must match its recorded stagedSha (no edits after the build)
 * 2. every LIVE file must still match its baseSha (the bytes this package was built from) — otherwise REFUSE, copy nothing
 * 3. refuse while the close chain, a backup or a secret scan is running (node close-chain.cjs / automation\backup.cjs /
 *    backup-secret-scan.cjs, or a tar.exe extracting a traids archive)
 * 4. node -c on every staged file, then the package selftest against the STAGED copies (selftest.cjs) — --dry-run stops here
 * 5. back up each live file to docs\health-fixes\2026-10-05\backups\<rel with \ -> __>.pre-onedrive-fix (sha-checked)
 * 6. copy staged -> live byte-exact, verify sha256, node -c each live file
 * 7. selftest.cjs --live; on ANY failure in 6-7 restore every file from its backup and exit 1
 * 8. append a record to deploy-log.jsonl beside this script
 *
 * Writes nothing outside the two live targets, the backups folder and this package folder. Never runs a real backup, never
 * restarts anything (the chain spawns backup.cjs fresh each run).
 */
const { spawnSync, execFileSync } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const REPO = "C:\\Users\\joshc\\Downloads\\traids (2)\\traids-bundle";
const PKG = path.join(REPO, "docs", "health-fixes", "2026-10-05", "backup-onedrive");
const BACKUPS = path.join(REPO, "docs", "health-fixes", "2026-10-05", "backups");
const PACKAGE = "backup-onedrive", SUFFIX = "pre-onedrive-fix";
let MANIFEST;
try { MANIFEST = JSON.parse(fs.readFileSync(path.join(PKG, "manifest.json"), "utf8")); } catch (e) { console.error(`DEPLOY REFUSED: manifest.json unreadable (${e.message}) — run make-manifest.cjs`); process.exit(1); }
if (MANIFEST.package !== PACKAGE || !Array.isArray(MANIFEST.files) || MANIFEST.files.length !== 2) { console.error("DEPLOY REFUSED: manifest.json is not this package's"); process.exit(1); }
const FILES = MANIFEST.files;
const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const di = argv.indexOf("--dir");
const scratch = "C:\\Users\\joshc\\AppData\\Local\\Temp\\claude\\C--Users-joshc-Downloads-traids--2--traids-bundle\\7f0996e1-32f0-428a-b708-56912c033489\\scratchpad";
const DIR = di >= 0 && argv[di + 1] ? path.resolve(argv[di + 1]) : fs.existsSync(scratch) ? scratch : os.tmpdir();
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const livePath = (f) => path.join(REPO, f.rel);
const stagedPath = (f) => path.join(PKG, "staged", f.rel);
const backupPath = (f) => path.join(BACKUPS, `${f.rel.replace(/\\/g, "__")}.${SUFFIX}`);
const logRec = (rec) => { try { fs.appendFileSync(path.join(PKG, "deploy-log.jsonl"), JSON.stringify({ at: new Date().toISOString(), package: PACKAGE, ...rec }) + "\n"); } catch { } };
const die = (msg) => { console.error(`DEPLOY REFUSED: ${msg}`); logRec({ result: "refused", dry: DRY, why: msg.slice(0, 300) }); process.exit(1); };
const nodeCheck = (p) => spawnSync(process.execPath, ["-c", p], { encoding: "utf8" });

console.log(`deploy package "${PACKAGE}"${DRY ? " (dry run)" : ""}`);

// 1-2. staged integrity + live base check, all before anything is copied
for (const f of FILES) {
  if (!fs.existsSync(stagedPath(f))) die(`staged file missing: ${stagedPath(f)}`);
  const s = sha(stagedPath(f));
  if (s !== f.stagedSha) die(`${f.rel}: staged copy changed since the manifest was made (${s.slice(0, 12)} != ${f.stagedSha.slice(0, 12)})`);
  if (!fs.existsSync(livePath(f))) die(`live file missing: ${livePath(f)}`);
  const l = sha(livePath(f));
  if (l === f.stagedSha) die(`${f.rel}: live already equals the staged copy — this package looks deployed already`);
  if (l !== f.baseSha) die(`${f.rel}: live sha256 ${l.slice(0, 12)} != baseSha ${f.baseSha.slice(0, 12)} — the live file changed after this package was built. Re-stage on top of the current file; nothing was copied.`);
  console.log(`  ok   ${f.rel}: live = base ${f.baseSha.slice(0, 12)}, staged ${f.stagedSha.slice(0, 12)} verified`);
}

// 3. never during the close chain, a backup or a scan
function busyProcesses() {
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='tar.exe'\" | ForEach-Object { $_.Name + ' ' + $_.CommandLine }"], { encoding: "utf8", timeout: 60000, maxBuffer: 16 << 20 });
  return String(out).split(/\r?\n/).filter((l) => /close-chain\.cjs|automation[\\/]+backup\.cjs|backup-secret-scan\.cjs/i.test(l) || (/^tar\.exe /i.test(l) && /traids-(FULL-)?\d{4}-\d{2}-\d{2}\.zip/i.test(l)));
}
if (!argv.includes("--no-process-check")) {
  let busy;
  try { busy = busyProcesses(); } catch (e) { die(`could not list processes (${e.message.slice(0, 120)}) — UNKNOWN whether the close chain is running. Re-run, or pass --no-process-check once you have confirmed it is not.`); }
  if (busy.length) die(`${busy.length} running process(es) are using these files (close chain / backup / secret scan). Deploy after the chain finishes.`);
  console.log("  ok   no close chain, backup or secret scan running");
}

// 4. syntax + the package selftest against the STAGED copies
for (const f of FILES) {
  const r = nodeCheck(stagedPath(f));
  if (r.status !== 0) die(`node -c failed on staged ${f.rel}: ${String(r.stderr).slice(0, 300)}`);
}
console.log("  ok   node -c on every staged file");
{
  const st = spawnSync(process.execPath, [path.join(PKG, "selftest.cjs"), "--dir", DIR], { cwd: PKG, encoding: "utf8", timeout: 30 * 60000 });
  const last = String(st.stdout || "").trim().split(/\r?\n/).pop();
  if (st.status !== 0) { process.stdout.write(String(st.stdout || "")); die(`package selftest on the STAGED copies failed (exit ${st.status}) ${String(st.stderr || "").slice(0, 300)}`); }
  console.log(`  ok   staged selftest: ${last}`);
}
if (DRY) { console.log("dry run: every check passed; nothing copied"); logRec({ result: "dry-run ok", files: FILES.map((f) => ({ rel: f.rel, baseSha: f.baseSha, stagedSha: f.stagedSha })) }); process.exit(0); }

// re-check the process list and the live bytes: the staged selftest took a while
if (!argv.includes("--no-process-check")) { let busy; try { busy = busyProcesses(); } catch (e) { die(`could not list processes (${e.message.slice(0, 120)})`); } if (busy.length) die("the close chain / a backup started while the staged selftest ran"); }
for (const f of FILES) if (sha(livePath(f)) !== f.baseSha) die(`${f.rel} changed while the staged selftest ran`);

// 5. back up live files
fs.mkdirSync(BACKUPS, { recursive: true });
for (const f of FILES) {
  const b = backupPath(f);
  if (fs.existsSync(b) && sha(b) !== f.baseSha) die(`${b} exists with different content — refusing to overwrite an earlier backup`);
  if (!fs.existsSync(b)) fs.copyFileSync(livePath(f), b);
  if (sha(b) !== f.baseSha) die(`backup ${b} does not match baseSha after copy`);
  console.log(`  ok   backed up ${f.rel} -> ${path.relative(REPO, b)}`);
}

// 6-7. copy, verify, live selftest; restore everything on any failure
function restoreAll(why) {
  console.error(`DEPLOY FAILED: ${why} — restoring every file from its backup`);
  let bad = 0;
  for (const f of FILES) {
    try { fs.copyFileSync(backupPath(f), livePath(f)); if (sha(livePath(f)) !== f.baseSha) throw new Error("sha mismatch after restore"); console.error(`  restored ${f.rel}`); }
    catch (e) { bad++; console.error(`  COULD NOT RESTORE ${f.rel}: ${e.message} — restore by hand from ${backupPath(f)}`); }
  }
  logRec({ result: bad ? "failed, restore incomplete" : "failed, restored", why: String(why).slice(0, 300) });
  process.exit(bad ? 2 : 1);
}
for (const f of FILES) {
  try { fs.copyFileSync(stagedPath(f), livePath(f)); } catch (e) { restoreAll(`copy of ${f.rel} failed (${e.code || e.message})`); }
  if (sha(livePath(f)) !== f.stagedSha) restoreAll(`${f.rel}: live sha after copy is not the staged sha`);
  const r = nodeCheck(livePath(f));
  if (r.status !== 0) restoreAll(`node -c failed on live ${f.rel}: ${String(r.stderr).slice(0, 300)}`);
  console.log(`  ok   deployed ${f.rel} (${f.stagedSha.slice(0, 12)}), node -c clean`);
}
const st = spawnSync(process.execPath, [path.join(PKG, "selftest.cjs"), "--live", "--dir", DIR], { cwd: PKG, encoding: "utf8", timeout: 30 * 60000 });
process.stdout.write(String(st.stdout || ""));
if (st.status !== 0) restoreAll(`package selftest --live failed (exit ${st.status}) ${String(st.stderr || "").slice(0, 300)}`);
logRec({ result: "deployed", files: FILES.map((f) => ({ rel: f.rel, baseSha: f.baseSha, stagedSha: f.stagedSha })) });
console.log(`DEPLOYED package "${PACKAGE}": ${FILES.length} files. Rollback: node "${path.join(PKG, "rollback.cjs")}" (NOTES.md: how to go back further)`);
console.log(`After tomorrow's close chain: node "${path.join(PKG, "check-status.cjs")}"  — expect secret scan PASS and off-disk mirror PASS (OneDrive sync confirmed from traids-2026-10-05.zip).`);
