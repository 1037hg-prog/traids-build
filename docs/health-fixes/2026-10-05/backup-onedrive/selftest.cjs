#!/usr/bin/env node
/**
 * PACKAGE "backup-onedrive" SELFTEST (2026-10-05 review fix of the OneDrive mirror + secret scan).
 *
 *   node selftest.cjs            tests the STAGED copies: staged\automation\backup.cjs + backup-secret-scan.cjs are copied into a
 *                                shadow repo under --dir (with backend\lib\atomic-write.js) and run from there; nothing in the repo
 *                                is written
 *   node selftest.cjs --live     tests the LIVE automation\backup.cjs + backup-secret-scan.cjs (deploy.cjs runs this after the copy),
 *                                and checks they are byte-identical to the staged copies recorded in manifest.json
 *   --dir <d>                    fixture base directory (default: the OS temp dir)
 *
 * Steps: 1. backup.cjs --selftest (unit cases)  2. e2e-fixture.cjs (main() end to end on a fixture, with the review's new cases)
 * 3. check-status.cjs verdicts on synthetic records  4. text checks  5. check-status on the live status file (read-only)
 * 6. nothing live was touched: the live status file, DEST, TEMP's archives, the REAL OneDrive mirror folder, and the live
 * automation files are exactly as they were before the run.
 * It never runs a real backup, never writes into DEST or the real OneDrive folder, and never prints a secret value.
 */
const { spawnSync } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const REPO = "C:\\Users\\joshc\\Downloads\\traids (2)\\traids-bundle";
const PKG = path.join(REPO, "docs", "health-fixes", "2026-10-05", "backup-onedrive");
const argv = process.argv.slice(2);
const LIVE = argv.includes("--live");
const di = argv.indexOf("--dir");
const DIR = di >= 0 && argv[di + 1] ? path.resolve(argv[di + 1]) : os.tmpdir();
const HOME = process.env.USERPROFILE || "C:\\Users\\joshc";
const REAL_OD_MIRROR = path.join(HOME, "OneDrive", "Documents", "TRAIDS-backups");
const DEST = path.join(HOME, "Documents", "TRAIDS-backups");
const TEMPD = process.env.TEMP || os.tmpdir();
const live = (rel) => path.join(REPO, ...rel.split("/"));
const staged = (rel) => path.join(PKG, "staged", ...rel.split("/"));
const sha = (p) => { try { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); } catch { return "absent"; } };
const insideOf = (p, d) => { const r = path.relative(d, p); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
for (const d of [REPO, DEST, path.join(HOME, "OneDrive")]) if (insideOf(DIR, d)) { console.error(`SELFTEST REFUSED: --dir ${DIR} is inside ${d}`); process.exit(2); }

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : " — " + String(detail).slice(0, 1200)}`); };

// ── snapshot what must not change ──
const FILES = ["automation/backup.cjs", "automation/backup-secret-scan.cjs"];
const STATUS = live("backend/data/backup-status.json");
const snap = () => {
  const ls = (d, rx) => { try { return fs.readdirSync(d).filter((f) => rx.test(f)).map((f) => { const s = fs.statSync(path.join(d, f)); return `${f}:${s.size}:${s.mtimeMs}`; }).sort().join("|"); } catch { return "absent"; } };
  return {
    dest: ls(DEST, /./), temp: ls(TEMPD, /^traids-(FULL-)?\d{4}-\d{2}-\d{2}\.zip$/), od: ls(REAL_OD_MIRROR, /./), status: sha(STATUS),
    code: FILES.map((f) => sha(live(f))).join(","),
  };
};
const before = snap();
console.log(`package backup-onedrive selftest — ${LIVE ? "LIVE files" : "STAGED copies"}; fixtures under ${DIR}`);

// ── the files under test ──
let SHADOW = null, SCRIPT, SCANNER;
if (LIVE) { SCRIPT = live(FILES[0]); SCANNER = live(FILES[1]); }
else {
  SHADOW = path.join(DIR, `traids-bkod-shadow-${process.pid}`);
  fs.rmSync(SHADOW, { recursive: true, force: true });
  fs.mkdirSync(path.join(SHADOW, "automation"), { recursive: true }); fs.mkdirSync(path.join(SHADOW, "backend", "lib"), { recursive: true });
  for (const f of FILES) fs.copyFileSync(staged(f), path.join(SHADOW, ...f.split("/")));
  fs.copyFileSync(live("backend/lib/atomic-write.js"), path.join(SHADOW, "backend", "lib", "atomic-write.js"));
  SCRIPT = path.join(SHADOW, "automation", "backup.cjs"); SCANNER = path.join(SHADOW, "automation", "backup-secret-scan.cjs");
}

try {
  if (LIVE) {
    let man = null; try { man = JSON.parse(fs.readFileSync(path.join(PKG, "manifest.json"), "utf8")); } catch { }
    const okMan = man && Array.isArray(man.files) && FILES.every((f) => { const m = man.files.find((x) => x.rel === f.split("/").join("\\")); return m && sha(live(f)) === m.stagedSha; });
    check("live files are byte-identical to the staged copies recorded in manifest.json", okMan, man ? FILES.map((f) => `${f} ${sha(live(f)).slice(0, 12)}`).join(", ") : "no manifest");
  }
  for (const f of [SCRIPT, SCANNER]) { const r = spawnSync(process.execPath, ["-c", f], { encoding: "utf8" }); check(`node -c ${path.basename(f)}`, r.status === 0, r.stderr); }

  // 1. backup.cjs --selftest
  let r = spawnSync(process.execPath, [SCRIPT, "--selftest", "--dir", DIR], { cwd: path.dirname(path.dirname(SCRIPT)), encoding: "utf8", timeout: 15 * 60000 });
  const out1 = String(r.stdout || "");
  const n1 = (/SELFTEST (PASS|FAIL) \((\d+)\/(\d+)\)/.exec(out1) || []).slice(1).join(" ");
  check(`backup.cjs --selftest: every case PASS (${n1})`, r.status === 0 && /SELFTEST PASS/.test(out1), out1.split("\n").filter((l) => /FAIL/.test(l)).join(" | ") + String(r.stderr || ""));

  // 2. end to end on a fixture
  const e2e = spawnSync(process.execPath, [path.join(PKG, "e2e-fixture.cjs"), "--script", SCRIPT, "--scanner", SCANNER, "--dir", DIR], { cwd: PKG, encoding: "utf8", timeout: 20 * 60000 });
  const out2 = String(e2e.stdout || "");
  const n2 = (/E2E (PASS|FAIL) \((\d+)\/(\d+)\)/.exec(out2) || []).slice(1).join(" ");
  check(`e2e-fixture.cjs: every case PASS (${n2})`, e2e.status === 0 && /E2E PASS/.test(out2), out2.split("\n").filter((l) => /FAIL/.test(l)).join(" | ") + String(e2e.stderr || ""));

  // 3. check-status.cjs verdicts on synthetic records (written under DIR; check-status only reads)
  {
    const { writeJsonAtomic } = require(live("backend/lib/atomic-write.js"));
    const CK = path.join(DIR, `traids-bkod-chk-${process.pid}`);
    fs.rmSync(CK, { recursive: true, force: true }); fs.mkdirSync(path.join(CK, "mirror"), { recursive: true });
    const arch = path.join(CK, "traids-2026-10-05.zip"), mfile = path.join(CK, "mirror", "traids-2026-10-05.zip");
    fs.writeFileSync(arch, Buffer.alloc(2048, 1)); fs.writeFileSync(mfile, Buffer.alloc(2048, 1));
    const cleanScan = { ok: true, scannedBytes: 4450950240, expectedBytes: 4450950240, needles: 72, hitKeys: [], error: null, tarExit: 0, secs: 24.1, sources: [{ file: "backend/.env", values: 24 }] };
    const cloudOk = { tonight: "pending", state: "confirmed", confirmedFile: "traids-2026-10-02.zip", confirmedDate: "2026-10-02", ageWeekdays: 1, maxAgeWeekdays: 2, account: "C:\\x\\OneDrive", checked: [{ file: "traids-2026-10-02.zip", cloud: true }], at: "2026-10-06T01:30:00.000Z", why: null };
    const good = {
      at: "2026-10-06T01:30:00.000Z", tier: "nightly", ok: true, out: arch, sizeBytes: 2048, offDisk: true,   // 21:30 ET on 10-05
      carved: [{ rel: "backend/data/training/futures-1m", inArchive: true }],
      mirror: { configured: true, dir: path.dirname(mfile), source: "default", ok: true, file: mfile, sameDisk: true, diskCheck: "same volume C:; OneDrive folder, sync confirmed", staged: "outside the mirror", cloudSynced: cloudOk, error: null },
      scan: cleanScan, fullNewest: "traids-FULL-2026-10-02.zip", fullAgeDays: 3, orphanTempZips: [], tempZipLeft: null, why: null,
    };
    const ck = (tier, rec, date = "2026-10-05") => {
      const f = path.join(CK, "status.json");
      writeJsonAtomic(f, { spec: "backup-status-v1", [tier]: rec });
      const x = spawnSync(process.execPath, [path.join(PKG, "check-status.cjs"), "--file", f, "--date", date, "--tier", tier], { encoding: "utf8", timeout: 60000 });
      return { code: x.status, out: String(x.stdout || "") + String(x.stderr || "") };
    };
    const want = (name, tier, rec, code, rx, date) => { const x = ck(tier, rec, date); check(`check-status: ${name}`, x.code === code && (!rx || rx.test(x.out)), `exit ${x.code}\n${x.out}`); };
    try {
      want("OneDrive mirror, sync confirmed 1 weekday back, clean scan -> PASS, exit 0", "nightly", good, 0, /VERDICT PASS/);
      want("Monday read of a Friday confirmation (1 weekday) -> PASS", "nightly", { ...good, at: "2026-10-05T21:30:00.000Z" }, 0, /VERDICT PASS/);
      want("OneDrive sync pending -> mirror FAIL with the reason", "nightly", { ...good, offDisk: false, mirror: { ...good.mirror, cloudSynced: { ...cloudOk, state: "pending", confirmedFile: null, confirmedDate: null, why: "no earlier archive in the mirror yet" } } }, 1, /FAIL\s+off-disk mirror\s+.*OneDrive sync is pending: no earlier archive/);
      want("OneDrive sync stale -> mirror FAIL", "nightly", { ...good, offDisk: false, mirror: { ...good.mirror, cloudSynced: { ...cloudOk, state: "stale", ageWeekdays: 4, why: "the newest archive OneDrive has taken is traids-2026-09-29.zip, 4 weekday(s) before" } } }, 1, /OneDrive sync is stale/);
      want("OneDrive sync unconfirmed (account elsewhere) -> mirror FAIL", "nightly", { ...good, offDisk: false, mirror: { ...good.mirror, cloudSynced: { ...cloudOk, state: "unconfirmed", why: "the signed-in OneDrive folder is D:\\OneDrive" } } }, 1, /OneDrive sync is unconfirmed/);
      want("record claims offDisk but sync not confirmed -> FAIL (inconsistent)", "nightly", { ...good, mirror: { ...good.mirror, cloudSynced: { ...cloudOk, state: "pending" } } }, 1, /inconsistent record/);
      want("confirmation from a 5-weekday-old archive, record says confirmed -> FAIL stale (re-judged against --date)", "full", { ...good, tier: "full", mirror: { ...good.mirror, cloudSynced: { ...cloudOk, confirmedFile: "traids-2026-09-28.zip", confirmedDate: "2026-09-28" } } }, 1, /FAIL\s+off-disk mirror\s+.*stale/);
      want("secret hits -> secret scan FAIL naming the keys, step FAIL", "nightly", { ...good, ok: false, offDisk: false, why: "secret VALUES found", mirror: { ...good.mirror, ok: false, file: null, error: "secret VALUES found inside the archive (backend/.env:X_API_KEY) — not copied" }, scan: { ...cleanScan, ok: false, hitKeys: ["backend/.env:X_API_KEY"], error: "secret VALUES found inside the archive: backend/.env:X_API_KEY" } }, 1, /FAIL\s+secret scan\s+secret VALUES inside the archive: backend\/\.env:X_API_KEY/);
      want("short scan (tar failed mid-stream) -> secret scan FAIL 'scan not complete'", "nightly", { ...good, scan: { ...cleanScan, ok: false, scannedBytes: 768890, expectedBytes: 1612697, tarExit: 1, error: "tar exited 1: b.txt: ZIP decompression failed" } }, 1, /FAIL\s+secret scan\s+scan not complete: tar exited 1/);
      want("scan ok:true but bytes != expected -> FAIL (never trusts ok alone)", "nightly", { ...good, scan: { ...cleanScan, scannedBytes: 768890 } }, 1, /FAIL\s+secret scan\s+scan not complete/);
      want("scan with 0 needles -> FAIL", "nightly", { ...good, scan: { ...cleanScan, needles: 0 } }, 1, /FAIL\s+secret scan/);
      want("mirrored run with no scan recorded (older backup.cjs) -> UNKNOWN, exit 2", "nightly", { ...good, scan: undefined }, 2, /UNKNOWN\s+secret scan/);
      want("no mirror (=none) -> mirror FAIL naming =none, secret scan PASS (not run)", "nightly", { ...good, offDisk: false, mirror: { configured: false, dir: null, source: "none", ok: true, file: null, error: null }, scan: { ok: null, skipped: "no mirror" } }, 1, /TRAIDS_BACKUP_MIRROR=none[\s\S]*PASS\s+secret scan\s+not run/);
      want("default refused (non-canonical copy) -> mirror FAIL naming the refusal", "nightly", { ...good, offDisk: false, mirror: { configured: false, dir: null, source: "refused", ok: true, file: null, error: null }, scan: { ok: null, skipped: "no mirror" } }, 1, /default OneDrive mirror was refused/);
      want("explicit other-disk mirror (no cloud) -> PASS", "nightly", { ...good, mirror: { ...good.mirror, source: "env", sameDisk: false, diskCheck: "C: disk 0 vs D: disk 1", cloudSynced: null } }, 0, /VERDICT PASS/);
      want("legacy record (no scan, mirror not configured, no source) -> mirror FAIL, scan PASS (not run)", "nightly", { ...good, offDisk: false, mirror: { configured: false, dir: null, ok: true, file: null, error: null }, scan: undefined }, 1, /FAIL\s+off-disk mirror\s+TRAIDS_BACKUP_MIRROR not set[\s\S]*PASS\s+secret scan/);
      want("record from the night before -> UNKNOWN, exit 2", "nightly", { ...good, at: "2026-10-04T21:00:00.000Z" }, 2, /UNKNOWN\s+record/);
      fs.unlinkSync(mfile);
      want("mirror file gone while the mirror dir is reachable -> FAIL", "nightly", good, 1, /is gone from the mirror/);
    } finally { fs.rmSync(CK, { recursive: true, force: true }); }
  }

  // 4. text checks on the files under test
  const bk = fs.readFileSync(SCRIPT, "utf8"), sc = fs.readFileSync(SCANNER, "utf8");
  for (const [n, s] of [["backup.cjs", bk], ["backup-secret-scan.cjs", sc]]) check(`${n}: LF line endings, no BOM`, !/\r\n/.test(s) && s.charCodeAt(0) !== 0xfeff);
  check("backup.cjs: no cmd.exe pipeline for the scan; tar spawned directly by the scanner", !/cmd\.exe[^\n]*-xOf|-xOf[^\n]*\| /.test(bk) && /spawn\(tar, \["-xOf", file\]/.test(sc) && !/process\.stdin/.test(sc));
  check("backup.cjs: no 'no .env' pass-through left", !/skipped === "no \.env"/.test(bk) && !/skipped: "no \.env"/.test(sc));
  check("backup.cjs: runs only as the main module", /\nif \(require\.main === module\) \{/.test(bk) && /\nif \(require\.main === module\) \{/.test(sc));
  check("backup.cjs: scan timeouts 5 min nightly / 15 min FULL", bk.includes("const SCAN_TIMEOUT_MS = { nightly: 5 * 60000, full: 15 * 60000 };"));
  check("backup.cjs: DEST, SECRET_FILES, tar build line unchanged", bk.includes(`const DEST = path.join(process.env.USERPROFILE || "C:\\\\Users\\\\joshc", "Documents", "TRAIDS-backups");`) &&
    bk.includes(`const SECRET_FILES = [".env", ".schwab-token.json", "cdp_api_key.json", ".mcp.json"];`) &&
    bk.includes(`execFileSync(TAR, ["-a", "-c", "-f", localZip, "-C", stage, ...fs.readdirSync(stage)], { timeout: 30 * 60000, maxBuffer: 64 * 1024 * 1024 });`));
  check("scanner: secret-name regex carries NTFY|TOPIC|WEBHOOK|PRIVATE|CRED|PWD", /const SECRET_NAME_RX = \/KEY\|SECRET\|TOKEN\|PASS\|PWD\|SID\|CLIENT\|AUTH\|CERT\|NTFY\|TOPIC\|WEBHOOK\|PRIVATE\|CRED\/i;/.test(sc));

  // 5. check-status on the live status file: read-only, ends PASS/FAIL/UNKNOWN
  const lv = spawnSync(process.execPath, [path.join(PKG, "check-status.cjs")], { encoding: "utf8", timeout: 60000 });
  check("check-status on the live status file runs read-only and ends PASS/FAIL/UNKNOWN", [0, 1, 2].includes(lv.status) && /VERDICT (PASS|FAIL|UNKNOWN)/.test(String(lv.stdout)), String(lv.stdout) + String(lv.stderr));
} finally {
  if (SHADOW) fs.rmSync(SHADOW, { recursive: true, force: true });
}

// 6. nothing live was touched
const after = snap();
check("live status file untouched", before.status === after.status, `${before.status} -> ${after.status}`);
check("DEST untouched", before.dest === after.dest);
check("temp-folder archives untouched", before.temp === after.temp);
check("real OneDrive mirror folder untouched", before.od === after.od, `${before.od}\n-> ${after.od}`);
check("live automation files untouched by the test", before.code === after.code);

const bad = results.filter((x) => !x).length;
console.log(`PACKAGE SELFTEST ${bad ? "FAIL" : "PASS"} (${results.length - bad}/${results.length})`);
process.exit(bad ? 1 : 0);
