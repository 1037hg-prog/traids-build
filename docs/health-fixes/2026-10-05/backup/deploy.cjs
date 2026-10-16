#!/usr/bin/env node
/**
 * DEPLOY package "backup" (health sweep 2026-10-05): BK1 mirror, BK3 futures-1m, BK4 Friday FULL + power calibration,
 * BK8 video to FULL, BK10 temp cleanup.
 *
 *   node deploy.cjs [--dry-run] [--no-process-check]
 *
 * 1. every staged file must match the sha256 recorded when it was built (no edits after review)
 * 2. every LIVE file must still match its baseSha (the bytes this package was built from) — otherwise REFUSE, copy nothing.
 *    close-chain.cjs is edited by several packages; if another one deployed first, re-stage this one on top of it.
 * 3. refuse while the close chain or a backup is running (a node process with close-chain.cjs / automation\backup.cjs)
 * 4. node -c on every staged .js/.cjs
 * 5. back up each live file to docs\health-fixes\2026-10-05\backups\<rel with \ -> __>.pre-backup (sha-checked)
 * 6. copy staged -> live byte-exact, verify sha256, node -c each live file
 * 7. run selftest.cjs against the live files; on ANY failure in 6-7 restore every file from its backup and exit 1
 *
 * Writes nothing outside the three live targets' paths and the backups folder. Never restarts anything (no process loads
 * these files persistently: the chain spawns backup.cjs and power-calibration.js fresh, and reads close-chain.cjs at start).
 */
const { spawnSync, execFileSync } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const REPO = "C:\\Users\\joshc\\Downloads\\traids (2)\\traids-bundle";
const PKG = path.join(REPO, "docs", "health-fixes", "2026-10-05", "backup");
const BACKUPS = path.join(REPO, "docs", "health-fixes", "2026-10-05", "backups");
const PACKAGE = "backup";
// baseSha / stagedSha per file, recorded by restage.cjs (as built 2026-10-05, revised after review: backup.cjs 9f5c34c3 -> e6995692,
// close-chain.cjs aa130355 -> 93a05078, power-calibration.js c8ff730b -> f903263e).
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PKG, "manifest.json"), "utf8"));
if (MANIFEST.package !== PACKAGE || !Array.isArray(MANIFEST.files) || MANIFEST.files.length !== 3) { console.error("DEPLOY REFUSED: manifest.json is not this package's"); process.exit(1); }
const FILES = MANIFEST.files;
const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const livePath = (f) => path.join(REPO, f.rel);
const stagedPath = (f) => path.join(PKG, "staged", f.rel);
const backupPath = (f) => path.join(BACKUPS, `${f.rel.replace(/\\/g, "__")}.pre-${PACKAGE}`);
const die = (msg) => { console.error(`DEPLOY REFUSED: ${msg}`); process.exit(1); };
const nodeCheck = (p) => spawnSync(process.execPath, ["-c", p], { encoding: "utf8" });

console.log(`deploy package "${PACKAGE}"${DRY ? " (dry run)" : ""}`);

// 1-2. staged integrity + live base check, all before anything is copied
for (const f of FILES) {
  if (!fs.existsSync(stagedPath(f))) die(`staged file missing: ${stagedPath(f)}`);
  const s = sha(stagedPath(f));
  if (s !== f.stagedSha) die(`${f.rel}: staged copy changed since it was built (${s.slice(0, 12)} != ${f.stagedSha.slice(0, 12)})`);
  if (!fs.existsSync(livePath(f))) die(`live file missing: ${livePath(f)}`);
  const l = sha(livePath(f));
  if (l === f.stagedSha) die(`${f.rel}: live already equals the staged copy — this package looks deployed already`);
  if (l !== f.baseSha) die(`${f.rel}: live sha256 ${l.slice(0, 12)} != baseSha ${f.baseSha.slice(0, 12)} — the live file changed after this package was built (another package deployed?). Re-stage on top of the current file; nothing was copied.`);
  console.log(`  ok   ${f.rel}: live = base, staged verified`);
}

// 3. never during the close chain or a running backup
if (!argv.includes("--no-process-check")) {
  let lines;
  try {
    lines = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { $_.CommandLine }"], { encoding: "utf8", timeout: 60000, maxBuffer: 16 << 20 });
  } catch (e) { die(`could not list node processes (${e.message.slice(0, 120)}) — UNKNOWN whether the close chain is running. Re-run, or pass --no-process-check once you have confirmed it is not.`); }
  const busy = String(lines).split(/\r?\n/).filter((l) => /close-chain\.cjs|automation[\\/]+backup\.cjs|power-calibration\.js/i.test(l));
  if (busy.length) die(`${busy.length} running node process(es) are using these files (close chain / backup / power calibration). Deploy after the chain finishes.`);
  console.log("  ok   no close chain, backup or power calibration running");
}

// 4. syntax of the staged copies
for (const f of FILES) {
  const r = nodeCheck(stagedPath(f));
  if (r.status !== 0) die(`node -c failed on staged ${f.rel}: ${String(r.stderr).slice(0, 300)}`);
}
console.log("  ok   node -c on every staged file");
if (DRY) { console.log("dry run: every check passed; nothing copied"); process.exit(0); }

// 5. back up live files
fs.mkdirSync(BACKUPS, { recursive: true });
for (const f of FILES) {
  const b = backupPath(f);
  if (fs.existsSync(b) && sha(b) !== f.baseSha) die(`${b} exists with different content — refusing to overwrite an earlier backup`);
  if (!fs.existsSync(b)) fs.copyFileSync(livePath(f), b);
  if (sha(b) !== f.baseSha) die(`backup ${b} does not match baseSha after copy`);
  console.log(`  ok   backed up ${f.rel} -> ${path.relative(REPO, b)}`);
}

// 6-7. copy, verify, selftest; restore everything on any failure
function restoreAll(why) {
  console.error(`DEPLOY FAILED: ${why} — restoring every file from its backup`);
  let bad = 0;
  for (const f of FILES) {
    try { fs.copyFileSync(backupPath(f), livePath(f)); if (sha(livePath(f)) !== f.baseSha) throw new Error("sha mismatch after restore"); console.error(`  restored ${f.rel}`); }
    catch (e) { bad++; console.error(`  COULD NOT RESTORE ${f.rel}: ${e.message} — restore by hand from ${backupPath(f)}`); }
  }
  process.exit(bad ? 2 : 1);
}
for (const f of FILES) {
  try { fs.copyFileSync(stagedPath(f), livePath(f)); } catch (e) { restoreAll(`copy of ${f.rel} failed (${e.code || e.message})`); }
  if (sha(livePath(f)) !== f.stagedSha) restoreAll(`${f.rel}: live sha after copy is not the staged sha`);
  const r = nodeCheck(livePath(f));
  if (r.status !== 0) restoreAll(`node -c failed on live ${f.rel}: ${String(r.stderr).slice(0, 300)}`);
  console.log(`  ok   deployed ${f.rel} (${f.stagedSha.slice(0, 12)}), node -c clean`);
}
const scratch = "C:\\Users\\joshc\\AppData\\Local\\Temp\\claude\\C--Users-joshc-Downloads-traids--2--traids-bundle\\7f0996e1-32f0-428a-b708-56912c033489\\scratchpad";
const dir = fs.existsSync(scratch) ? scratch : os.tmpdir();
const st = spawnSync(process.execPath, [path.join(PKG, "selftest.cjs"), "--dir", dir], { cwd: PKG, encoding: "utf8", timeout: 20 * 60000 });
process.stdout.write(String(st.stdout || ""));
if (st.status !== 0) restoreAll(`package selftest failed (exit ${st.status}) ${String(st.stderr || "").slice(0, 300)}`);
console.log(`DEPLOYED package "${PACKAGE}": ${FILES.length} files. Rollback: node "${path.join(PKG, "rollback.cjs")}"`);
console.log("Next close chain: nightly carries futures-1m, no video. The chain log shows only ok/FAIL for backup; read the result with: node \"" + path.join(PKG, "check-status.cjs") + "\" (after the chain). FULL + power calibration run Friday.");
