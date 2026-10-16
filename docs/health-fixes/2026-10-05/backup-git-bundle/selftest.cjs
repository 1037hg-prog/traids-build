#!/usr/bin/env node
/**
 * PACKAGE "backup-git-bundle" SELFTEST (2026-10-05, operator: "add the git bundle to the weekly backup").
 *
 *   node selftest.cjs            tests the STAGED copies: staged\automation\backup.cjs + backup-secret-scan.cjs are copied into a
 *                                shadow repo under --dir (with backend\lib\atomic-write.js) and run from there; nothing in the repo
 *                                is written
 *   node selftest.cjs --live     tests the LIVE automation\backup.cjs + backup-secret-scan.cjs (deploy.cjs runs this after the copy)
 *                                and checks they are byte-identical to the staged copies recorded in manifest.json
 *   --dir <d>                    fixture base directory (default: the OS temp dir)
 *
 * Steps: 1. backup.cjs --selftest (unit cases, incl. the git bundle and history scan on fixture git repos)  2. e2e-fixture.cjs
 * (main() end to end on a fixture git repo, incl. the nightly-unchanged twin comparison)  3. check-status.cjs verdicts on
 * synthetic records, incl. the new "git bundle" item  4. text checks  5. check-status on the live status file (read-only)
 * 6. nothing live was touched: the live status file, DEST, TEMP's archives and bundle stage, the REAL OneDrive mirror folder,
 * the live automation files, and the real repository's refs + HEAD are exactly as they were before the run.
 * It never runs a real backup, never runs git against the real repository except read-only (for-each-ref / rev-parse), never
 * writes into DEST or the real OneDrive folder, and never prints a secret value.
 */
const { spawnSync, execFileSync } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const REPO = "C:\\Users\\joshc\\Downloads\\traids (2)\\traids-bundle";
const PKG = path.join(REPO, "docs", "health-fixes", "2026-10-05", "backup-git-bundle");
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
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : " — " + String(detail).slice(0, 1500)}`); };

// ── snapshot what must not change ──
const FILES = ["automation/backup.cjs", "automation/backup-secret-scan.cjs"];
const STATUS = live("backend/data/backup-status.json");
const gitRefs = () => {
  try {
    const env = { ...process.env }; for (const k of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR)$/i.test(k)) delete env[k];
    const g = (...a) => execFileSync("git", a, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 << 20, env });
    return crypto.createHash("sha256").update(g("for-each-ref", "--format=%(objectname) %(refname)") + g("rev-parse", "HEAD")).digest("hex");
  } catch (e) { return `unreadable (${String(e.message).slice(0, 60)})`; }
};
const snap = () => {
  const ls = (d, rx) => { try { return fs.readdirSync(d).filter((f) => rx.test(f)).map((f) => { const s = fs.statSync(path.join(d, f)); return `${f}:${s.size}:${s.mtimeMs}`; }).sort().join("|"); } catch { return "absent"; } };
  return {
    dest: ls(DEST, /./), temp: ls(TEMPD, /^traids-(FULL-)?\d{4}-\d{2}-\d{2}\.zip$|^traids-git-bundle-stage/), od: ls(REAL_OD_MIRROR, /./), status: sha(STATUS),
    code: FILES.map((f) => sha(live(f))).join(","), refs: gitRefs(),
  };
};
const before = snap();
console.log(`package backup-git-bundle selftest — ${LIVE ? "LIVE files" : "STAGED copies"}; fixtures under ${DIR}`);

// ── the files under test ──
let SHADOW = null, SCRIPT, SCANNER;
if (LIVE) { SCRIPT = live(FILES[0]); SCANNER = live(FILES[1]); }
else {
  SHADOW = path.join(DIR, `traids-bkgb-shadow-${process.pid}`);
  fs.rmSync(SHADOW, { recursive: true, force: true });
  fs.mkdirSync(path.join(SHADOW, "automation"), { recursive: true }); fs.mkdirSync(path.join(SHADOW, "backend", "lib"), { recursive: true });
  for (const f of FILES) fs.copyFileSync(staged(f), path.join(SHADOW, ...f.split("/")));
  fs.copyFileSync(live("backend/lib/atomic-write.js"), path.join(SHADOW, "backend", "lib", "atomic-write.js"));
  SCRIPT = path.join(SHADOW, "automation", "backup.cjs"); SCANNER = path.join(SHADOW, "automation", "backup-secret-scan.cjs");
}

try {
  if (LIVE) {
    let man = null; try { man = JSON.parse(fs.readFileSync(path.join(PKG, "manifest.json"), "utf8")); } catch { }
    const okMan = man && man.package === "backup-git-bundle" && Array.isArray(man.files) && FILES.every((f) => { const m = man.files.find((x) => x.rel === f.split("/").join("\\")); return m && sha(live(f)) === m.stagedSha; });
    check("live files are byte-identical to the staged copies recorded in manifest.json", okMan, man ? FILES.map((f) => `${f} ${sha(live(f)).slice(0, 12)}`).join(", ") : "no manifest");
  }
  for (const f of [SCRIPT, SCANNER]) { const r = spawnSync(process.execPath, ["-c", f], { encoding: "utf8" }); check(`node -c ${path.basename(f)}`, r.status === 0, r.stderr); }

  // 1. backup.cjs --selftest
  let r = spawnSync(process.execPath, [SCRIPT, "--selftest", "--dir", DIR], { cwd: path.dirname(path.dirname(SCRIPT)), encoding: "utf8", timeout: 15 * 60000 });
  const out1 = String(r.stdout || "");
  const n1 = (/SELFTEST (PASS|FAIL) \((\d+)\/(\d+)\)/.exec(out1) || []).slice(1).join(" ");
  check(`backup.cjs --selftest: every case PASS (${n1})`, r.status === 0 && /SELFTEST PASS/.test(out1), out1.split("\n").filter((l) => /FAIL/.test(l)).join(" | ") + String(r.stderr || ""));

  // 2. end to end on a fixture
  const e2e = spawnSync(process.execPath, [path.join(PKG, "e2e-fixture.cjs"), "--script", SCRIPT, "--scanner", SCANNER, "--dir", DIR], { cwd: PKG, encoding: "utf8", timeout: 30 * 60000 });
  const out2 = String(e2e.stdout || "");
  const n2 = (/E2E (PASS|FAIL) \((\d+)\/(\d+)\)/.exec(out2) || []).slice(1).join(" ");
  check(`e2e-fixture.cjs: every case PASS (${n2})`, e2e.status === 0 && /E2E PASS/.test(out2), out2.split("\n").filter((l) => /FAIL/.test(l)).join(" | ") + String(e2e.stderr || ""));

  // 3. check-status.cjs verdicts on synthetic records (written under DIR; check-status only reads)
  {
    const { writeJsonAtomic } = require(live("backend/lib/atomic-write.js"));
    const CK = path.join(DIR, `traids-bkgb-chk-${process.pid}`);
    fs.rmSync(CK, { recursive: true, force: true }); fs.mkdirSync(path.join(CK, "mirror"), { recursive: true });
    const arch = path.join(CK, "traids-2026-10-05.zip"), mfile = path.join(CK, "mirror", "traids-2026-10-05.zip");
    fs.writeFileSync(arch, Buffer.alloc(2048, 1)); fs.writeFileSync(mfile, Buffer.alloc(2048, 1));
    const bfile = path.join(CK, "traids-git-2026-10-09.bundle"), bmir = path.join(CK, "mirror", "traids-git-2026-10-09.bundle");
    fs.writeFileSync(bfile, Buffer.alloc(4096, 2)); fs.writeFileSync(bmir, Buffer.alloc(4096, 2));
    const cleanScan = { ok: true, scannedBytes: 4450950240, expectedBytes: 4450950240, needles: 72, hitKeys: [], error: null, tarExit: 0, secs: 24.1, sources: [{ file: "backend/.env", values: 24 }] };
    const cloudOk = { tonight: "pending", state: "confirmed", confirmedFile: "traids-2026-10-02.zip", confirmedDate: "2026-10-02", ageWeekdays: 1, maxAgeWeekdays: 2, account: "C:\\x\\OneDrive", checked: [{ file: "traids-2026-10-02.zip", cloud: true }], at: "2026-10-06T01:30:00.000Z", why: null };
    const good = {
      at: "2026-10-06T01:30:00.000Z", tier: "nightly", ok: true, out: arch, sizeBytes: 2048, offDisk: true,   // 21:30 ET on 10-05
      carved: [{ rel: "backend/data/training/futures-1m", inArchive: true }],
      mirror: { configured: true, dir: path.dirname(mfile), source: "default", ok: true, file: mfile, sameDisk: true, diskCheck: "same volume C:; OneDrive folder, sync confirmed", staged: "outside the mirror", cloudSynced: cloudOk, error: null },
      scan: cleanScan, fullNewest: "traids-FULL-2026-10-02.zip", fullAgeDays: 3, orphanTempZips: [], tempZipLeft: null, why: null,
    };
    const hScan = { ok: true, complete: true, objects: 120462, bytes: 13080066277, expected: { objects: 120462, bytes: 13080066277 }, needles: 72, hitKeys: [], hitPaths: [], error: null, gitExit: 0, checkExit: 0, secs: 89.4, sources: [] };
    const bOk = {
      state: "done", ok: true, name: "traids-git-2026-10-09.bundle", path: bfile, sizeBytes: 4096, sha256: "a".repeat(64), objects: 120455, refs: 6, git: "git.exe", placed: "renamed",
      verify: { ok: true, gitVerifyExit: 0, packChecksumOk: true, algo: "sha1", version: 2, refs: 6, objects: 120455, why: null }, scan: hScan, mirrored: true,
      mirror: { configured: true, dir: path.dirname(bmir), source: "default", ok: true, file: bmir, sameDisk: true, diskCheck: "x", staged: "outside the mirror", cloudSynced: cloudOk, error: null },
      retention: { kept: 4, deleted: [], error: null }, why: null, hitSummary: null, secs: 120, phases: {}, stageLeft: null,
    };
    const cloudFri = { ...cloudOk, confirmedFile: "traids-2026-10-08.zip", confirmedDate: "2026-10-08", checked: [{ file: "traids-2026-10-08.zip", cloud: true }] };
    const full = { ...good, tier: "full", at: "2026-10-10T00:30:00.000Z", mirror: { ...good.mirror, cloudSynced: cloudFri }, bundle: bOk };   // Fri 10-09 20:30 ET
    const hitsScan = { ...hScan, ok: false, hitKeys: [".mcp.json:mcpServers.alphavantage.url?apikey", "backend/.env:ALPHAVANTAGE_KEY"], hitPaths: [{ path: ".mcp.json", keys: ["ALPHAVANTAGE_KEY"], objects: 1, oid: "10549d6f4a35" }], error: "secret VALUES found in git history: .mcp.json -> ALPHAVANTAGE_KEY" };
    const ck = (tier, rec, date = "2026-10-05") => {
      const f = path.join(CK, "status.json");
      writeJsonAtomic(f, { spec: "backup-status-v1", [tier]: rec });
      const x = spawnSync(process.execPath, [path.join(PKG, "check-status.cjs"), "--file", f, "--date", date, "--tier", tier], { encoding: "utf8", timeout: 60000 });
      return { code: x.status, out: String(x.stdout || "") + String(x.stderr || "") };
    };
    const want = (name, tier, rec, code, rx, date, notRx) => { const x = ck(tier, rec, date); check(`check-status: ${name}`, x.code === code && (!rx || rx.test(x.out)) && (!notRx || !notRx.test(x.out)), `exit ${x.code}\n${x.out}`); };
    try {
      // the backup-onedrive verdicts, unchanged
      want("OneDrive mirror, sync confirmed 1 weekday back, clean scan -> PASS, exit 0", "nightly", good, 0, /VERDICT PASS/);
      want("Monday read of a Friday confirmation (1 weekday) -> PASS", "nightly", { ...good, at: "2026-10-05T21:30:00.000Z" }, 0, /VERDICT PASS/);
      want("OneDrive sync pending -> mirror FAIL with the reason", "nightly", { ...good, offDisk: false, mirror: { ...good.mirror, cloudSynced: { ...cloudOk, state: "pending", confirmedFile: null, confirmedDate: null, why: "no earlier archive in the mirror yet" } } }, 1, /FAIL\s+off-disk mirror\s+.*OneDrive sync is pending: no earlier archive/);
      want("record claims offDisk but sync not confirmed -> FAIL (inconsistent)", "nightly", { ...good, mirror: { ...good.mirror, cloudSynced: { ...cloudOk, state: "pending" } } }, 1, /inconsistent record/);
      want("secret hits -> secret scan FAIL naming the keys", "nightly", { ...good, ok: false, offDisk: false, why: "secret VALUES found", mirror: { ...good.mirror, ok: false, file: null, error: "secret VALUES found inside the archive (backend/.env:X_API_KEY) — not copied" }, scan: { ...cleanScan, ok: false, hitKeys: ["backend/.env:X_API_KEY"], error: "x" } }, 1, /FAIL\s+secret scan\s+secret VALUES inside the archive: backend\/\.env:X_API_KEY/);
      want("scan ok:true but bytes != expected -> FAIL (never trusts ok alone)", "nightly", { ...good, scan: { ...cleanScan, scannedBytes: 768890 } }, 1, /FAIL\s+secret scan\s+scan not complete/);
      want("record from the night before -> UNKNOWN, exit 2", "nightly", { ...good, at: "2026-10-04T21:00:00.000Z" }, 2, /UNKNOWN\s+record/);
      // the git bundle item (FULL only)
      want("nightly record: no 'git bundle' item at all (FULL night only)", "nightly", good, 0, /VERDICT PASS/, "2026-10-05", /git bundle/);
      want("FULL, bundle verified + history clean + mirrored -> git bundle PASS, VERDICT PASS", "full", full, 0, /PASS\s+git bundle\s+traids-git-2026-10-09\.bundle .*120455 objects.*history scan 120462 objects \/ 13\.08 GB.*72 needles, no hits.*mirrored to/, "2026-10-09");
      want("FULL, history hits -> git bundle FAIL naming '.mcp.json -> ALPHAVANTAGE_KEY', kept local", "full", { ...full, ok: false, bundle: { ...bOk, ok: false, mirrored: false, scan: hitsScan, mirror: { ...bOk.mirror, ok: false, file: null, error: "x" }, why: "bundle kept local" } }, 1, /FAIL\s+git bundle\s+secret VALUES in git history: \.mcp\.json -> ALPHAVANTAGE_KEY — bundle kept local .*NOT mirrored/, "2026-10-09");
      want("FULL, hits in an INCOMPLETE scan -> FAIL says 'NOT complete' first", "full", { ...full, ok: false, bundle: { ...bOk, ok: false, mirrored: false, scan: { ...hitsScan, complete: false, objects: 60000, error: "the cat-file --batch stream: truncated" }, why: "x" } }, 1, /FAIL\s+git bundle\s+history scan NOT complete \(the cat-file --batch stream: truncated\) and before it stopped found secret VALUES/, "2026-10-09");
      want("FULL, scan ok:true but objects != expected -> FAIL not complete (never trusts ok alone)", "full", { ...full, bundle: { ...bOk, scan: { ...hScan, objects: 120000 } } }, 1, /FAIL\s+git bundle\s+.*history scan not complete/, "2026-10-09");
      want("FULL, scan ok:true but bytes != expected -> FAIL", "full", { ...full, bundle: { ...bOk, scan: { ...hScan, bytes: 1 } } }, 1, /FAIL\s+git bundle\s+.*not complete/, "2026-10-09");
      want("FULL, 0 needles -> FAIL", "full", { ...full, bundle: { ...bOk, scan: { ...hScan, needles: 0 } } }, 1, /FAIL\s+git bundle/, "2026-10-09");
      want("FULL, bundle still 'running' (step killed mid-bundle) -> FAIL never finished", "full", { ...full, bundle: { state: "running", name: "traids-git-2026-10-09.bundle", startedAt: "2026-10-10T00:20:00.000Z" } }, 1, /FAIL\s+git bundle\s+started .* never finished/, "2026-10-09");
      want("FULL record with no bundle (older backup.cjs) -> UNKNOWN, exit 2", "full", { ...full, bundle: undefined }, 2, /UNKNOWN\s+git bundle/, "2026-10-09");
      want("FULL, git missing -> git bundle FAIL 'git not found'", "full", { ...full, ok: false, bundle: { ...bOk, ok: false, path: null, sizeBytes: null, verify: null, scan: null, mirrored: false, mirror: null, why: "git not found (x) — no bundle tonight; the FULL archive is unaffected" } }, 1, /FAIL\s+git bundle\s+failed: git not found/, "2026-10-09");
      want("FULL, bundle recorded ok but verify missing -> FAIL inconsistent", "full", { ...full, bundle: { ...bOk, verify: { ...bOk.verify, packChecksumOk: false } } }, 1, /FAIL\s+git bundle\s+recorded ok but not verified/, "2026-10-09");
      want("FULL, no mirror this run -> git bundle PASS 'kept local only'", "full", { ...full, offDisk: false, mirror: { configured: false, dir: null, source: "none", ok: true, file: null, error: null }, scan: { ok: null, skipped: "no mirror" }, bundle: { ...bOk, scan: { ok: null, skipped: "no mirror" }, mirrored: false, mirror: { configured: false, dir: null, source: "none", ok: true, file: null, error: null } } }, 1, /PASS\s+git bundle\s+.*kept local only/, "2026-10-09");
      want("FULL, mirror configured but bundle not mirrored -> FAIL", "full", { ...full, bundle: { ...bOk, mirrored: false, mirror: { ...bOk.mirror, ok: false, file: null, error: "mirror copy failed: sha256 mismatch after copy" } } }, 1, /FAIL\s+git bundle\s+.*NOT mirrored: mirror copy failed/, "2026-10-09");
      fs.unlinkSync(bmir);
      want("FULL, mirror copy of the bundle gone while the mirror is reachable -> FAIL", "full", full, 1, /FAIL\s+git bundle\s+.*is gone from the mirror/, "2026-10-09");
      fs.unlinkSync(bfile);
      want("FULL, the bundle in DEST is gone -> FAIL", "full", full, 1, /FAIL\s+git bundle\s+.*traids-git-2026-10-09\.bundle is gone/, "2026-10-09");
    } finally { fs.rmSync(CK, { recursive: true, force: true }); }
  }

  // 4. text checks on the files under test
  const bk = fs.readFileSync(SCRIPT, "utf8"), sc = fs.readFileSync(SCANNER, "utf8");
  for (const [n, s] of [["backup.cjs", bk], ["backup-secret-scan.cjs", sc]]) check(`${n}: LF line endings, no BOM`, !/\r\n/.test(s) && s.charCodeAt(0) !== 0xfeff);
  check("both files run only as the main module (require() only exports)", /\nif \(require\.main === module\) \{/.test(bk) && /\nif \(require\.main === module\) \{/.test(sc));
  check("backup.cjs: the nightly tier keeps its single status write and exit, before any bundle code", /  if \(!FULL\) \{\n    writeStatus\(STATUS_FILE, tier, record\);\n    process\.exit\(failed \? 1 : 0\);\n  \}\n/.test(bk) &&
    bk.indexOf("if (!FULL) {\n    writeStatus(STATUS_FILE, tier, record);") < bk.indexOf("await gitBundleStep({ stamp, choice"));
  check("backup.cjs: bundle constants (keep 4 DEST / 4 mirror; create 15 / verify 5 / scan 15 min; 43-min budget; 5-min minimum start)",
    bk.includes("const BUNDLE_KEEP = { dest: 4, mirror: 4 };") && bk.includes("const BUNDLE_TIMEOUT_MS = { create: 15 * 60000, verify: 5 * 60000, scan: 15 * 60000 };") &&
    bk.includes("const FULL_STEP_BUDGET_MS = 43 * 60000;") && bk.includes("const BUNDLE_MIN_START_MS = 5 * 60000;") && bk.includes("const BUNDLE_RX = /^traids-git-\\d{4}-\\d{2}-\\d{2}\\.bundle$/;"));
  check("backup.cjs: archive scan timeouts, DEST, SECRET_FILES, tar build line, MIRROR_KEEP unchanged",
    bk.includes("const SCAN_TIMEOUT_MS = { nightly: 5 * 60000, full: 15 * 60000 };") && bk.includes(`const DEST = path.join(process.env.USERPROFILE || "C:\\\\Users\\\\joshc", "Documents", "TRAIDS-backups");`) &&
    bk.includes(`const SECRET_FILES = [".env", ".schwab-token.json", "cdp_api_key.json", ".mcp.json"];`) && bk.includes("const MIRROR_KEEP = { nightly: 7, full: 4 };") &&
    bk.includes(`execFileSync(TAR, ["-a", "-c", "-f", localZip, "-C", stage, ...fs.readdirSync(stage)], { timeout: 30 * 60000, maxBuffer: 64 * 1024 * 1024 });`));
  check("scanner: history scan uses --batch-all-objects --batch(-check) --unordered, spawns git directly, never 'git show' / 'cat-file -p'",
    sc.includes(`["cat-file", "--batch-all-objects", "--batch-check", "--unordered"]`) && sc.includes(`["cat-file", "--batch-all-objects", "--batch", "--unordered"]`) &&
    !/["']show["']/.test(sc + bk) && !/cat-file", "-p"/.test(sc + bk) && /spawn\(cmd, args, \{ cwd, env, windowsHide: true, stdio: \["ignore", "pipe", "pipe"\] \}\)/.test(sc));
  check("scanner: the archive scan core is unchanged in default use (createScanner keeps 5 offsets per needle unless asked)", sc.includes("function createScanner(needles, { maxHitAt = 5 } = {}) {") && sc.includes("const scanner = createScanner(needles);"));
  check("scanner: secret-name regex unchanged", /const SECRET_NAME_RX = \/KEY\|SECRET\|TOKEN\|PASS\|PWD\|SID\|CLIENT\|AUTH\|CERT\|NTFY\|TOPIC\|WEBHOOK\|PRIVATE\|CRED\/i;/.test(sc));
  check("no file in this package require()s close-chain.cjs", !fs.readdirSync(PKG).filter((f) => /\.cjs$/.test(f)).some((f) => /require\([^)]*close-chain/.test(fs.readFileSync(path.join(PKG, f), "utf8"))) && !/require\([^)]*close-chain/.test(bk + sc));

  // 5. check-status on the live status file: read-only, ends PASS/FAIL/UNKNOWN (both tiers)
  for (const tier of ["nightly", "full"]) {
    const lv = spawnSync(process.execPath, [path.join(PKG, "check-status.cjs"), "--tier", tier], { encoding: "utf8", timeout: 60000 });
    check(`check-status --tier ${tier} on the live status file runs read-only and ends PASS/FAIL/UNKNOWN`, [0, 1, 2].includes(lv.status) && /VERDICT (PASS|FAIL|UNKNOWN)/.test(String(lv.stdout)), String(lv.stdout) + String(lv.stderr));
  }
} finally {
  if (SHADOW) fs.rmSync(SHADOW, { recursive: true, force: true });
}

// 6. nothing live was touched
const after = snap();
check("live status file untouched", before.status === after.status, `${before.status} -> ${after.status}`);
check("DEST untouched", before.dest === after.dest);
check("temp-folder archives and the real bundle stage untouched", before.temp === after.temp, `${before.temp}\n-> ${after.temp}`);
check("real OneDrive mirror folder untouched", before.od === after.od, `${before.od}\n-> ${after.od}`);
check("live automation files untouched by the test", before.code === after.code);
check("the real repository's refs and HEAD untouched", before.refs === after.refs && !/unreadable/.test(after.refs), `${before.refs} -> ${after.refs}`);

const bad = results.filter((x) => !x).length;
console.log(`PACKAGE SELFTEST ${bad ? "FAIL" : "PASS"} (${results.length - bad}/${results.length})`);
process.exit(bad ? 1 : 0);
