#!/usr/bin/env node
/**
 * END-TO-END FIXTURE RUN for package "backup" (2026-10-05). Runs the WHOLE main() path of a backup.cjs — robocopy staging,
 * tar, probe, rotation, mirror, status file, exit codes — against a tiny fixture repo with USERPROFILE/TEMP pointed into a
 * fixture directory, so DEST, the temp folder and the status file are all fixture paths. No repo data is read or written
 * (the only repo files read are backup.cjs itself and backend/lib/atomic-write.js, which are copied into the fixture).
 *
 * Usage: node e2e-fixture.cjs [--script <backup.cjs to test>] [--dir <fixture base>]
 *   default script: the STAGED copy beside this file; default dir: the OS temp dir.
 *
 * It also runs check-status.cjs (beside this file) against the fixture's status file after the runs, so the reader of
 * backup-status.json is tested against what backup.cjs really writes, not against a hand-made record.
 */
const { spawnSync, execFileSync } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const REPO = "C:\\Users\\joshc\\Downloads\\traids (2)\\traids-bundle";
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SCRIPT = path.resolve(opt("--script", path.join(__dirname, "staged", "automation", "backup.cjs")));
const BASE = path.join(path.resolve(opt("--dir", os.tmpdir())), `traids-backup-e2e-${process.pid}`);
const rel = path.relative(REPO, BASE);
if (!rel.startsWith("..") && !path.isAbsolute(rel)) { console.error(`REFUSED: fixture ${BASE} is inside the repo`); process.exit(2); }

const FX = path.join(BASE, "repo"), HOME = path.join(BASE, "home"), TMPD = path.join(BASE, "temp"), MIR = path.join(BASE, "mirror");
const DESTF = path.join(HOME, "Documents", "TRAIDS-backups");
const put = (r, body) => { const p = path.join(FX, r); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const TAR = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
const listZip = (z) => execFileSync(TAR, ["-tf", z], { encoding: "utf8", maxBuffer: 16 << 20 }).split(/\r?\n/).filter(Boolean).map((s) => s.replace(/\\/g, "/"));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : " — " + detail}`); };
const CHECK = path.join(__dirname, "check-status.cjs");
function chk(args) {
  const r = spawnSync(process.execPath, [CHECK, "--file", path.join(FX, "backend", "data", "backup-status.json"), "--json", ...args], { encoding: "utf8", timeout: 60000 });
  let j = null; try { j = JSON.parse(String(r.stdout || "")); } catch { }
  const v = (name) => ((j && j.items.find((i) => i.name === name)) || {}).verdict;
  return { code: r.status, j, v, raw: String(r.stdout || "") + String(r.stderr || "") };
}
function run(args, env = {}) {
  const r = spawnSync(process.execPath, [path.join(FX, "automation", "backup.cjs"), ...args], {
    cwd: FX, encoding: "utf8", timeout: 10 * 60000,
    env: { ...process.env, USERPROFILE: HOME, TEMP: TMPD, TMP: TMPD, TRAIDS_BACKUP_MIRROR: "", ...env },
  });
  return { code: r.status, out: String(r.stdout || ""), err: String(r.stderr || ""), all: String(r.stdout || "") + String(r.stderr || "") };
}

fs.rmSync(BASE, { recursive: true, force: true });
for (const d of [FX, HOME, TMPD, MIR]) fs.mkdirSync(d, { recursive: true });
try {
  fs.mkdirSync(path.join(FX, "automation"), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(FX, "automation", "backup.cjs"));
  { const sc = [path.join(path.dirname(SCRIPT), "backup-secret-scan.cjs"), path.join(REPO, "automation", "backup-secret-scan.cjs")].find((p) => fs.existsSync(p)); if (sc) fs.copyFileSync(sc, path.join(FX, "automation", "backup-secret-scan.cjs")); }   // 2026-10-05: the OneDrive mirror scans archives for secret values first
  fs.mkdirSync(path.join(FX, "backend", "lib"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "backend", "lib", "atomic-write.js"), path.join(FX, "backend", "lib", "atomic-write.js"));
  put("backend/data/trade_log.json", "[]"); put("backend/data/test-registry.json", "{}");
  put("backend/data/blob.bin", crypto.randomBytes(2 * 1024 * 1024));   // incompressible, so the archive clears the 1 MB floor
  put("backend/data/training/futures-1m/manifest.json", "{}"); put("backend/data/training/futures-1m/ES/ES-1m.json", "[]");
  put("backend/data/training/r267/x.json", "[]"); put("backend/data/intraday-history/SPY.json", "[]");
  put("Screen Recording fixture.mp4", "not really video"); put("backend/.env", "FIXTURE=1\n");
  console.log(`backup e2e — script ${SCRIPT}\n  fixture ${BASE}`);

  // 1. nightly, mirror unset
  fs.writeFileSync(path.join(TMPD, "traids-2020-01-01.zip"), "orphan from a killed run");
  let r = run([]);
  const nz = path.join(DESTF, `traids-${today}.zip`);
  check("nightly, mirror unset: exit 0", r.code === 0, `exit ${r.code}\n${r.all.slice(-600)}`);
  check("nightly: WARN backups are on the repo disk", /WARN backups are on the repo disk \(set TRAIDS_BACKUP_MIRROR\)/.test(r.err), r.err.slice(-300));
  check("nightly: offDisk=false printed", /offDisk=false/.test(r.out), r.out.slice(-300));
  check("nightly: WARN no recent FULL", /WARN no FULL archive newer than 8 days/.test(r.err), r.err.slice(-300));
  check("nightly: orphan temp zip reported, not deleted", /traids-2020-01-01\.zip/.test(r.err) && fs.existsSync(path.join(TMPD, "traids-2020-01-01.zip")), r.err.slice(-300));
  check("nightly: no temp zip or stage left in TEMP", !fs.existsSync(path.join(TMPD, `traids-${today}.zip`)) && !fs.existsSync(path.join(TMPD, "traids-backup-stage")), fs.readdirSync(TMPD).join(","));
  const ents = fs.existsSync(nz) ? listZip(nz) : [];
  check("nightly archive: futures-1m in, ledger in", ents.includes("backend/data/training/futures-1m/manifest.json") && ents.includes("backend/data/trade_log.json"), ents.join(","));
  check("nightly archive: no video, no .env, no other training, no bar history", !ents.some((e) => /\.mp4$|\.env$|training\/r267|intraday-history/.test(e)), ents.join(","));
  const st1 = JSON.parse(fs.readFileSync(path.join(FX, "backend", "data", "backup-status.json"), "utf8"));
  check("status file: nightly ok, offDisk false, sha recorded", st1.nightly && st1.nightly.ok === true && st1.nightly.offDisk === false && /^[0-9a-f]{64}$/.test(st1.nightly.sha256), JSON.stringify(st1).slice(0, 300));
  let c = chk([]);
  check("check-status after a good nightly with the mirror unset: FAIL (exit 1) on mirror, FULL age, orphan; record/step/archive/futures-1m PASS",
    c.code === 1 && c.v("record") === "PASS" && c.v("step") === "PASS" && c.v("archive") === "PASS" && c.v("futures-1m") === "PASS" &&
    c.v("off-disk mirror") === "FAIL" && c.v("FULL age") === "FAIL" && c.v("temp orphans") === "FAIL" && /traids-2020-01-01\.zip/.test(c.raw), c.raw.slice(0, 900));
  c = chk(["--date", "2099-01-01"]);
  check("check-status for a night with no record: UNKNOWN, exit 2", c.code === 2 && c.j && c.j.verdict === "UNKNOWN" && c.v("record") === "UNKNOWN", c.raw.slice(0, 400));
  c = spawnSync(process.execPath, [CHECK, "--file", path.join(BASE, "no-such-status.json")], { encoding: "utf8" });
  check("check-status with no status file: UNKNOWN, exit 2", c.status === 2 && /VERDICT UNKNOWN/.test(String(c.stdout)), String(c.stdout) + String(c.stderr));

  // 2. nightly, mirror set and reachable (same disk as the fixture)
  r = run([], { TRAIDS_BACKUP_MIRROR: MIR });
  check("nightly, mirror reachable: exit 0, mirror copy present and identical", r.code === 0 && fs.existsSync(path.join(MIR, `traids-${today}.zip`)) &&
    fs.readFileSync(path.join(MIR, `traids-${today}.zip`)).equals(fs.readFileSync(nz)), `exit ${r.code}\n${r.all.slice(-600)}`);
  check("nightly, same-disk mirror: offDisk=false with WARN", /offDisk=false/.test(r.out) && /not confirmed off the repo's disk/.test(r.err), r.all.slice(-400));
  c = chk([]);
  check("check-status, same-disk mirror: mirror FAIL (not confirmed on another disk)", c.code === 1 && c.v("off-disk mirror") === "FAIL" && /not confirmed on another physical disk/.test(c.raw), c.raw.slice(0, 600));

  // 3. nightly, mirror set but missing -> FAIL, local kept
  r = run([], { TRAIDS_BACKUP_MIRROR: path.join(BASE, "unplugged-drive") });
  check("nightly, mirror unreachable: exit 1, BACKUP MIRROR FAILED, local archive kept", r.code === 1 && /BACKUP MIRROR FAILED/.test(r.err) && fs.existsSync(nz), `exit ${r.code}\n${r.all.slice(-600)}`);
  const st3 = JSON.parse(fs.readFileSync(path.join(FX, "backend", "data", "backup-status.json"), "utf8"));
  check("status file: mirror failure recorded ok=false", st3.nightly.ok === false && /unreachable/.test(st3.nightly.why || ""), JSON.stringify(st3.nightly).slice(0, 300));
  c = chk([]);
  check("check-status, mirror unreachable: step FAIL and mirror FAIL", c.code === 1 && c.v("step") === "FAIL" && c.v("off-disk mirror") === "FAIL" && /unreachable/.test(c.raw), c.raw.slice(0, 600));

  // 4. --full on a non-Friday without --force -> skipped (only meaningful Mon-Thu/Sun/Sat pm)
  const dow = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date());
  if (!["Fri", "Sat"].includes(dow)) {
    r = run(["--full"]);
    check(`--full on ${dow}: skipped, exit 0, no FULL archive`, r.code === 0 && /runs Fridays only/.test(r.out) && !fs.readdirSync(DESTF).some((f) => /FULL/.test(f)), r.all.slice(-300));
  }

  // 5. --full --force with mirror
  r = run(["--full", "--force"], { TRAIDS_BACKUP_MIRROR: MIR });
  const fz = path.join(DESTF, `traids-FULL-${today}.zip`);
  const fents = fs.existsSync(fz) ? listZip(fz) : [];
  check("FULL --force: exit 0, archive + mirror copy", r.code === 0 && fs.existsSync(fz) && fs.existsSync(path.join(MIR, `traids-FULL-${today}.zip`)), `exit ${r.code}\n${r.all.slice(-600)}`);
  check("FULL archive: video + bar history + futures-1m in; .env and other training out", fents.some((e) => /\.mp4$/.test(e)) && fents.some((e) => /intraday-history\/SPY\.json$/.test(e)) &&
    fents.includes("backend/data/training/futures-1m/manifest.json") && !fents.some((e) => /\.env$|training\/r267/.test(e)), fents.join(","));

  c = chk(["--tier", "full"]);
  check("check-status --tier full after the FULL run: record/step/archive/futures-1m PASS, mirror FAIL (same disk)",
    c.code === 1 && c.v("record") === "PASS" && c.v("step") === "PASS" && c.v("archive") === "PASS" && c.v("futures-1m") === "PASS" && c.v("off-disk mirror") === "FAIL", c.raw.slice(0, 900));

  // 6a. futures-1m store present but its manifest.json is not in the archive -> exit 1 INCOMPLETE ("not in the archive"), archive kept
  fs.unlinkSync(path.join(FX, "backend", "data", "training", "futures-1m", "manifest.json"));
  r = run([]);
  check("futures-1m present but manifest not archived: exit 1, INCOMPLETE 'not in the archive', archive kept", r.code === 1 &&
    /BACKUP INCOMPLETE: futures 1m bar store[^\n]*manifest\.json is not in the archive/.test(r.err) && fs.existsSync(nz), `exit ${r.code}\n${r.all.slice(-600)}`);
  c = chk([]);
  check("check-status: futures-1m FAIL, FULL age PASS (a FULL now exists)", c.code === 1 && c.v("futures-1m") === "FAIL" && c.v("FULL age") === "PASS", c.raw.slice(0, 900));

  // 6. futures-1m store missing -> exit 1 INCOMPLETE, archive kept
  fs.rmSync(path.join(FX, "backend", "data", "training", "futures-1m"), { recursive: true, force: true });
  r = run([]);
  check("futures-1m missing: exit 1, BACKUP INCOMPLETE, archive kept", r.code === 1 && /BACKUP INCOMPLETE: futures 1m bar store/.test(r.err) && fs.existsSync(nz), `exit ${r.code}\n${r.all.slice(-600)}`);
} finally {
  fs.rmSync(BASE, { recursive: true, force: true });
}
const bad = results.filter((x) => !x).length;
console.log(`E2E ${bad ? "FAIL" : "PASS"} (${results.length - bad}/${results.length})`);
process.exit(bad ? 1 : 0);
