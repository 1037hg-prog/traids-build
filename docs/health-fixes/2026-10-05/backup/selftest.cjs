#!/usr/bin/env node
/**
 * PACKAGE "backup" SELFTEST (health sweep 2026-10-05).
 *
 *   node selftest.cjs            tests the LIVE files (deploy.cjs runs this after the copy)
 *   node selftest.cjs --staged   tests the STAGED copies, compiled under their live filenames so __dirname-relative requires
 *                                resolve into the repo; nothing in the repo is written
 *   --dir <d>                    fixture base directory (default: the OS temp dir)
 *
 * It never runs a real backup, never runs power-calibration's computation, and never require()s close-chain.cjs (text checks
 * only). It also asserts that it left the live status file, DEST and the temp folder's archives exactly as it found them.
 * check-status.cjs (read-only) is exercised on synthetic records under --dir, and run once against the live status file.
 */
const { spawnSync } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const REPO = "C:\\Users\\joshc\\Downloads\\traids (2)\\traids-bundle";
const PKG = path.join(REPO, "docs", "health-fixes", "2026-10-05", "backup");
const argv = process.argv.slice(2);
const STAGED = argv.includes("--staged");
const di = argv.indexOf("--dir");
const DIR = di >= 0 && argv[di + 1] ? path.resolve(argv[di + 1]) : os.tmpdir();
const src = (rel) => (STAGED ? path.join(PKG, "staged", ...rel.split("/")) : path.join(REPO, ...rel.split("/")));
const live = (rel) => path.join(REPO, ...rel.split("/"));

// Compile `file`'s source as if it were `asFile` (same __dirname), with argv, in a child process.
const LOADER = `const Module=require("module"),fs=require("fs"),path=require("path");const [,file,asFile,...args]=process.argv;` +
  `process.argv=[process.argv[0],asFile,...args];const m=new Module(asFile,null);m.filename=asFile;m.paths=Module._nodeModulePaths(path.dirname(asFile));` +
  `m._compile(fs.readFileSync(file,"utf8"),asFile);`;
function runScript(rel, args, timeoutMs = 10 * 60000) {
  const r = STAGED
    ? spawnSync(process.execPath, ["-e", LOADER, src(rel), live(rel), ...args], { cwd: REPO, encoding: "utf8", timeout: timeoutMs })
    : spawnSync(process.execPath, [live(rel), ...args], { cwd: REPO, encoding: "utf8", timeout: timeoutMs });
  return { code: r.status, out: String(r.stdout || ""), err: String(r.stderr || "") + (r.error ? String(r.error.message) : "") };
}

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : " — " + String(detail).slice(0, 800)}`); };

// ── snapshot what must not change ──
const DEST = path.join(process.env.USERPROFILE || "C:\\Users\\joshc", "Documents", "TRAIDS-backups");
const TEMPD = process.env.TEMP || os.tmpdir();
const STATUS = live("backend/data/backup-status.json");
const snap = () => {
  const ls = (d, rx) => { try { return fs.readdirSync(d).filter((f) => rx.test(f)).map((f) => { const s = fs.statSync(path.join(d, f)); return `${f}:${s.size}:${s.mtimeMs}`; }).sort().join("|"); } catch { return "absent"; } };
  let st = "absent"; try { st = crypto.createHash("sha256").update(fs.readFileSync(STATUS)).digest("hex"); } catch { }
  return { dest: ls(DEST, /./), temp: ls(TEMPD, /^traids-(FULL-)?\d{4}-\d{2}-\d{2}\.zip$/), status: st };
};
const before = snap();
console.log(`package backup selftest — ${STAGED ? "STAGED copies" : "LIVE files"}; fixtures under ${DIR}`);

// 1. backup.cjs --selftest (unit cases against a fixture)
let r = runScript("automation/backup.cjs", ["--selftest", "--dir", DIR]);
check("backup.cjs --selftest: every case PASS", r.code === 0 && /SELFTEST PASS/.test(r.out), r.out.split("\n").filter((l) => /FAIL/.test(l)).join(" | ") + r.err);

// 2. backup.cjs end to end on a fixture (main(): robocopy, tar, probe, rotation, mirror, status, exit codes)
const e2e = spawnSync(process.execPath, [path.join(PKG, "e2e-fixture.cjs"), "--script", src("automation/backup.cjs"), "--dir", DIR], { cwd: PKG, encoding: "utf8", timeout: 15 * 60000 });
check("backup.cjs end-to-end fixture run: every case PASS", e2e.status === 0 && /E2E PASS/.test(String(e2e.stdout)), String(e2e.stdout).split("\n").filter((l) => /FAIL/.test(l)).join(" | ") + String(e2e.stderr || ""));

// 3. power-calibration.js Friday gate (--gate-only exits before reading any data)
const cases = [["2026-10-09T20:30:00Z", "RUN", "Fri"], ["2026-10-10T07:00:00Z", "RUN", "Sat"], ["2026-10-10T17:00:00Z", "SKIP", "Sat"],
  ["2026-10-11T18:00:00Z", "SKIP", "Sun"], ["2026-10-05T20:30:00Z", "SKIP", "Mon"], ["2026-10-08T20:30:00Z", "SKIP", "Thu"], ["2026-11-06T21:30:00Z", "RUN", "Fri"]];
for (const [now, want, dow] of cases) {
  r = runScript("backend/power-calibration.js", ["--gate-only", "--now", now], 120000);
  check(`power-calibration gate ${now} -> ${want} (${dow} ET)`, r.code === 0 && r.out.includes(`power-calibration gate: ${want} (${dow} ET)`), r.out + r.err);
}
r = runScript("backend/power-calibration.js", ["--gate-only", "--now", "not-a-date"], 120000);
check("power-calibration gate: unparseable --now is UNKNOWN, exit 2", r.code === 2 && /UNKNOWN/.test(r.out), r.out + r.err);

// 3b. check-status.cjs verdicts on synthetic records (it reads only; the records are written with writeJsonAtomic under DIR)
{
  const { writeJsonAtomic } = require(path.join(REPO, "backend", "lib", "atomic-write.js"));
  const CK = path.join(DIR, `traids-backup-chk-${process.pid}`);
  fs.rmSync(CK, { recursive: true, force: true }); fs.mkdirSync(path.join(CK, "mirror"), { recursive: true });
  const arch = path.join(CK, "traids-2026-10-05.zip"), mfile = path.join(CK, "mirror", "traids-2026-10-05.zip");
  fs.writeFileSync(arch, Buffer.alloc(2048, 1)); fs.writeFileSync(mfile, Buffer.alloc(2048, 1));
  const good = {
    at: "2026-10-06T01:30:00.000Z", tier: "nightly", ok: true, out: arch, sizeBytes: 2048, offDisk: true,   // 21:30 ET on 10-05 (10-06 in UTC)
    carved: [{ rel: "backend/data/training/futures-1m", inArchive: true }],
    mirror: { configured: true, dir: path.dirname(mfile), ok: true, file: mfile, sameDisk: false, diskCheck: "C: disk 0 vs D: disk 1", error: null },
    fullNewest: "traids-FULL-2026-10-02.zip", fullAgeDays: 3, orphanTempZips: [], tempZipLeft: null, why: null,
  };
  const ck = (tier, rec, args = []) => {
    const f = path.join(CK, "status.json");
    writeJsonAtomic(f, { spec: "backup-status-v1", [tier]: rec });
    const x = spawnSync(process.execPath, [path.join(PKG, "check-status.cjs"), "--file", f, "--date", "2026-10-05", "--tier", tier, ...args], { encoding: "utf8", timeout: 60000 });
    return { code: x.status, out: String(x.stdout || "") + String(x.stderr || "") };
  };
  const want = (name, tier, rec, code, rx) => { const x = ck(tier, rec); check(`check-status: ${name}`, x.code === code && (!rx || rx.test(x.out)), `exit ${x.code}\n${x.out}`); };
  try {
    want("all items good (record dated by ET, not UTC) -> PASS, exit 0", "nightly", good, 0, /VERDICT PASS/);
    want("mirror not configured -> FAIL, exit 1", "nightly", { ...good, offDisk: false, mirror: { configured: false, dir: null, ok: true, file: null, error: null } }, 1, /FAIL\s+off-disk mirror\s+TRAIDS_BACKUP_MIRROR not set/);
    want("mirror on the repo's disk -> FAIL", "nightly", { ...good, offDisk: false, mirror: { ...good.mirror, sameDisk: true, diskCheck: "same volume C:" } }, 1, /not confirmed on another physical disk/);
    want("mirror copy failed -> FAIL", "nightly", { ...good, ok: false, offDisk: false, why: "mirror D:\\m unreachable (ENOENT)", mirror: { ...good.mirror, ok: false, error: "mirror D:\\m unreachable (ENOENT)" } }, 1, /FAIL\s+step/);
    want("futures-1m not in the archive -> FAIL", "nightly", { ...good, carved: [{ rel: "backend/data/training/futures-1m", inArchive: false }] }, 1, /FAIL\s+futures-1m/);
    want("no carve-in result recorded -> UNKNOWN, exit 2", "nightly", { ...good, carved: undefined }, 2, /UNKNOWN\s+futures-1m/);
    want("no FULL ever -> FAIL", "nightly", { ...good, fullNewest: null, fullAgeDays: null }, 1, /FAIL\s+FULL age/);
    want("FULL 9 days old -> FAIL", "nightly", { ...good, fullAgeDays: 9 }, 1, /FAIL\s+FULL age/);
    want("orphan temp zips -> FAIL", "nightly", { ...good, orphanTempZips: ["traids-2026-09-25.zip"] }, 1, /FAIL\s+temp orphans/);
    want("archive size differs from the record -> FAIL", "nightly", { ...good, sizeBytes: 9999 }, 1, /FAIL\s+archive/);
    want("record from the night before -> UNKNOWN, exit 2 (a killed run writes no record)", "nightly", { ...good, at: "2026-10-04T21:00:00.000Z" }, 2, /UNKNOWN\s+record/);
    want("FULL record 3 days old (Friday 20:30 ET) -> PASS", "full", { ...good, tier: "full", at: "2026-10-03T00:30:00.000Z", fullAgeDays: undefined, fullNewest: undefined }, 0, /VERDICT PASS/);
    want("FULL record 10 days old -> FAIL", "full", { ...good, tier: "full", at: "2026-09-25T21:00:00.000Z" }, 1, /FAIL\s+record/);
    fs.unlinkSync(mfile);
    want("mirror file gone while the mirror dir is reachable -> FAIL", "nightly", good, 1, /is gone from the mirror/);
  } finally { fs.rmSync(CK, { recursive: true, force: true }); }
  const lv = spawnSync(process.execPath, [path.join(PKG, "check-status.cjs")], { encoding: "utf8", timeout: 60000 });
  check("check-status on the live status file runs read-only and ends PASS/FAIL/UNKNOWN", [0, 1, 2].includes(lv.status) && /VERDICT (PASS|FAIL|UNKNOWN)/.test(String(lv.stdout)), String(lv.stdout) + String(lv.stderr));
}

// 4. text checks (close-chain.cjs is never required)
const cc = fs.readFileSync(src("automation/close-chain.cjs"), "utf8");
check("close-chain: power calibration is (Fri) with onlyOn: 5", cc.includes(`["power calibration (Fri)", "backend/power-calibration.js", 12, { onlyOn: 5 }]`));
check("close-chain: backup full is (Fri) with --full and onlyOn: 5", cc.includes(`["backup full (Fri)", "automation/backup.cjs", 45, { args: ["--full"], onlyOn: 5 }]`));
check("close-chain: nightly backup step unchanged (30 min)", cc.includes(`["backup", "automation/backup.cjs", 30],`));
check("close-chain: no step label still says (Sun)", !/\["[^"]*\(Sun\)"/.test(cc));
check("close-chain: LF line endings preserved", !/\r\n/.test(cc));
const bk = fs.readFileSync(src("automation/backup.cjs"), "utf8");
check("backup.cjs: no Sunday gate left", !/!== "Sun"/.test(bk) && /function fullTierDue/.test(bk));
check("backup.cjs: tar approach and 30-min tar timeout unchanged", bk.includes(`execFileSync(TAR, ["-a", "-c", "-f", localZip, "-C", stage, ...fs.readdirSync(stage)], { timeout: 30 * 60000, maxBuffer: 64 * 1024 * 1024 });`));
check("backup.cjs: DEST unchanged", bk.includes(`const DEST = path.join(process.env.USERPROFILE || "C:\\\\Users\\\\joshc", "Documents", "TRAIDS-backups");`));
check("backup.cjs: SECRET_FILES list intact", bk.includes(`const SECRET_FILES = [".env", ".schwab-token.json", "cdp_api_key.json", ".mcp.json"];`));
const pc = fs.readFileSync(src("backend/power-calibration.js"), "utf8");
check("power-calibration.js: no Sunday gate left", !/!== "Sun"/.test(pc) && /function weeklyGateET/.test(pc));
for (const [rel, s] of [["automation/backup.cjs", bk], ["backend/power-calibration.js", pc]]) check(`${rel}: LF line endings preserved`, !/\r\n/.test(s));

// 5. nothing live was touched
const after = snap();
check("live status file untouched", before.status === after.status, `${before.status} -> ${after.status}`);
check("DEST untouched", before.dest === after.dest);
check("temp-folder archives untouched", before.temp === after.temp);

const bad = results.filter((x) => !x).length;
console.log(`PACKAGE SELFTEST ${bad ? "FAIL" : "PASS"} (${results.length - bad}/${results.length})`);
process.exit(bad ? 1 : 0);
