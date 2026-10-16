#!/usr/bin/env node
/**
 * END-TO-END FIXTURE RUN, package "backup-git-bundle" (2026-10-05, operator: "add the git bundle to the weekly backup").
 * Built on package backup-onedrive's e2e (every one of its cases is kept), plus:
 *   - the fixture repo is a real git repository (fixture commits only), so the FULL tier writes a real bundle;
 *   - FULL --force, clean history, explicit mirror: bundle verified, in DEST, history scan complete with 0 hits, mirrored,
 *     check-status --tier full "git bundle" PASS; FULL with TRAIDS_BACKUP_MIRROR=none: bundle local only, no scan, exit 0;
 *   - git missing (TRAIDS_BACKUP_GIT pointing nowhere): exit 1, the FULL archive is STILL written and recorded, bundle FAIL;
 *   - a fake secret committed and then deleted in a later commit: exit 1, bundle kept in DEST, NOT in the mirror, the key NAME
 *     and the history path in the step's last stderr line and in the record, check-status "git bundle" FAIL;
 *   - a truncated cat-file stream (a fake git in front of the real one), in-process through gitBundleStep: fail closed;
 *   - a FULL record whose bundle is still "running" (the step was killed) -> check-status FAIL;
 *   - NIGHTLY UNCHANGED: the same nightly runs (mirror none / explicit / default OneDrive / leaked secret / missing .env) on two
 *     identical twin fixtures, one with the BASE files (backup-onedrive's staged copies = live before this package, sha-checked),
 *     one with the files under test; exit codes, stdout, stderr, the status record (numbers and fixture paths normalised),
 *     the archive's entry list and the mirror listing must all be identical.
 * Usage: node e2e-fixture.cjs [--script <backup.cjs>] [--scanner <backup-secret-scan.cjs>] [--base-script <backup.cjs>] [--dir <base>]
 *
 * ORIGINAL HEADER (backup-onedrive): Runs the WHOLE main() path of
 * a backup.cjs — robocopy staging, tar, probe, rotation, secret scan, mirror, status file, exit codes — against a tiny fixture
 * repo with USERPROFILE/TEMP pointed into a fixture directory, so DEST, the OneDrive root, the mirror, the temp folder and the
 * status file are all fixture paths. The fixture repo sits at <home>\Downloads\traids (2)\traids-bundle, i.e. the CANONICAL
 * path for the fixture's USERPROFILE, so the default-OneDrive-mirror path is exercised for real; a second copy elsewhere checks
 * that a non-canonical copy is refused the default.
 *
 * Usage: node e2e-fixture.cjs [--script <backup.cjs>] [--scanner <backup-secret-scan.cjs>] [--dir <fixture base>]
 *   default script/scanner: the STAGED copies beside this file; default dir: the OS temp dir.
 *
 * The only real-system reads: HKCU\...\OneDrive\Accounts\Personal UserFolder and fsutil on fixture files (the cloud-sync check;
 * a fixture folder is never confirmed). The fixture's fake secret is random, is never printed (the run asserts it appears in no
 * output and no status record), and is deleted with the fixture.
 *
 * Cases added for the review (M4): default OneDrive mirror chosen + folder created; non-canonical copy refused the default;
 * TRAIDS_BACKUP_MIRROR=none; a leaked secret (UTF-8 and UTF-16LE) -> refusal, exit 1, no mirror file, status ok:false with
 * hitKeys; a missing .env and a .env with no secret values -> refusal; a corrupt-entry zip (tar fails mid-stream) -> refusal,
 * through the scanner CLI and through scanAndMirror (the function main() uses); cloudSynced pending / confirmed / stale — the
 * records produced by the real mirrorArchive with fake cloud probes — judged by check-status.cjs.
 */
const { spawnSync, execFileSync } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const REPO = "C:\\Users\\joshc\\Downloads\\traids (2)\\traids-bundle";
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SCRIPT = path.resolve(opt("--script", path.join(__dirname, "staged", "automation", "backup.cjs")));
const SCANNER = path.resolve(opt("--scanner", path.join(path.dirname(SCRIPT), "backup-secret-scan.cjs")));
// the BASE for the nightly-unchanged comparison: live before this package = backup-onedrive's staged copies (sha-checked below)
const BASE_SCRIPT = path.resolve(opt("--base-script", path.join(REPO, "docs", "health-fixes", "2026-10-05", "backup-onedrive", "staged", "automation", "backup.cjs")));
const BASE_SCANNER = path.join(path.dirname(BASE_SCRIPT), "backup-secret-scan.cjs");
const BASE_SHA = { script: "a5486b1a780de1015fa7516f5ca736468be896ab63c3e926ce0b6029f0393675", scanner: "8e012686653559a2e6a4ad294b14856aa97c18dc9e788186ea845029ea6272e2" };
const BASE = path.join(path.resolve(opt("--dir", os.tmpdir())), `traids-bkgb-e2e-${process.pid}`);
const insideOf = (p, d) => { const r = path.relative(d, p); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
const REAL_HOME = process.env.USERPROFILE || "C:\\Users\\joshc";
for (const d of [REPO, path.join(REAL_HOME, "OneDrive"), path.join(REAL_HOME, "Documents", "TRAIDS-backups")]) {
  if (insideOf(BASE, d)) { console.error(`REFUSED: fixture ${BASE} is inside ${d}`); process.exit(2); }
}
for (const f of [SCRIPT, SCANNER]) if (!fs.existsSync(f)) { console.error(`REFUSED: ${f} does not exist`); process.exit(2); }

const HOME = path.join(BASE, "home"), TMPD = path.join(BASE, "temp"), MIR = path.join(BASE, "mirror");
const FX = path.join(HOME, "Downloads", "traids (2)", "traids-bundle");
const DESTF = path.join(HOME, "Documents", "TRAIDS-backups"), STAGEF = path.join(DESTF, ".mirror-stage");
const ODR = path.join(HOME, "OneDrive"), ODM = path.join(ODR, "Documents", "TRAIDS-backups");
const STATUS = path.join(FX, "backend", "data", "backup-status.json");
const put = (root, r, body) => { const p = path.join(root, ...r.split("/")); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p; };
const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const TAR = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
const listZip = (z) => execFileSync(TAR, ["-tf", z], { encoding: "utf8", maxBuffer: 16 << 20 }).split(/\r?\n/).filter(Boolean).map((s) => s.replace(/\\/g, "/"));
const ls = (d) => { try { return fs.readdirSync(d).sort(); } catch { return []; } };
const sha256 = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : " — " + String(detail).slice(0, 900)}`); };
const CHECK = path.join(__dirname, "check-status.cjs");
const SECRET = crypto.randomBytes(20).toString("hex");   // never printed
const seen = [];   // every output and record, scanned at the end for SECRET
function chk(args, file = STATUS) {
  const r = spawnSync(process.execPath, [CHECK, "--file", file, "--json", ...args], { encoding: "utf8", timeout: 60000 });
  let j = null; try { j = JSON.parse(String(r.stdout || "")); } catch { }
  const v = (name) => ((j && j.items.find((i) => i.name === name)) || {}).verdict;
  const d = (name) => ((j && j.items.find((i) => i.name === name)) || {}).detail || "";
  const raw = String(r.stdout || "") + String(r.stderr || ""); seen.push(raw);
  return { code: r.status, j, v, d, raw };
}
function run(args, env = {}, script = path.join(FX, "automation", "backup.cjs")) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: path.dirname(path.dirname(script)), encoding: "utf8", timeout: 10 * 60000,
    env: { ...process.env, USERPROFILE: HOME, TEMP: TMPD, TMP: TMPD, TRAIDS_BACKUP_MIRROR: "none", TRAIDS_BACKUP_GIT: "", ...env },
  });
  const o = { code: r.status, out: String(r.stdout || ""), err: String(r.stderr || ""), all: String(r.stdout || "") + String(r.stderr || "") };
  seen.push(o.all);
  return o;
}
const status = (file = STATUS) => { const t = fs.readFileSync(file, "utf8"); seen.push(t); return JSON.parse(t); };
// git for the fixture repos (fixture commits only; no hooks, no signing, no CRLF rewriting)
const SC = require(SCANNER);
const GIT = SC.findGit().path;
const HOOKS = path.join(BASE, "no-hooks");
const gitIn = (cwd, ...a) => execFileSync(GIT, ["-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-c", "core.longpaths=true", "-c", `core.hooksPath=${HOOKS}`, ...a],
  { cwd, encoding: "utf8", env: SC.gitEnv(), stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
const gitCommitAll = (cwd, msg) => { gitIn(cwd, "add", "-A"); gitIn(cwd, "commit", "-q", "-m", msg); };
const lastErrLine = (s) => String(s).trim().split(/\r?\n/).filter(Boolean).pop() || "";
const FAKE_GIT_SRC = [
  "const { spawn } = require('child_process');",
  "const real = process.env.FAKE_GIT_REAL, mode = process.env.FAKE_GIT_MODE || '', args = process.argv.slice(2);",
  "const batch = args.includes('--batch');",
  "const hold = batch && mode === 'truncate', parts = [];",
  "const c = spawn(real, args, { stdio: ['ignore', 'pipe', 'inherit'] });",
  "c.stdout.on('data', (d) => { if (hold) parts.push(d); else process.stdout.write(d); });",
  "c.on('close', (code) => { if (hold) { const all = Buffer.concat(parts); process.stdout.write(all.subarray(0, Math.floor(all.length / 2))); } process.exitCode = code; });",
].join("\n") + "\n";
const prevWeekday = (d, n = 1) => { let t = Date.parse(`${d}T12:00:00Z`); let k = 0; while (k < n) { t -= 864e5; const w = new Date(t).getUTCDay(); if (w !== 0 && w !== 6) k++; } return new Date(t).toISOString().slice(0, 10); };
const nextWeekday = (d, n = 1) => { let t = Date.parse(`${d}T12:00:00Z`); let k = 0; while (k < n) { t += 864e5; const w = new Date(t).getUTCDay(); if (w !== 0 && w !== 6) k++; } return new Date(t).toISOString().slice(0, 10); };

fs.rmSync(BASE, { recursive: true, force: true });
for (const d of [FX, HOME, TMPD, MIR]) fs.mkdirSync(d, { recursive: true });
let asyncPart = Promise.resolve();
try {
  fs.mkdirSync(path.join(FX, "automation"), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(FX, "automation", "backup.cjs"));
  fs.copyFileSync(SCANNER, path.join(FX, "automation", "backup-secret-scan.cjs"));
  fs.mkdirSync(path.join(FX, "backend", "lib"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "backend", "lib", "atomic-write.js"), path.join(FX, "backend", "lib", "atomic-write.js"));
  put(FX, "backend/data/trade_log.json", "[]"); put(FX, "backend/data/test-registry.json", "{}");
  put(FX, "backend/data/blob.bin", crypto.randomBytes(2 * 1024 * 1024));   // incompressible, so the archive clears the 1 MB floor
  put(FX, "backend/data/training/futures-1m/manifest.json", "{}"); put(FX, "backend/data/training/futures-1m/ES/ES-1m.json", "[]");
  put(FX, "backend/data/training/r267/x.json", "[]"); put(FX, "backend/data/intraday-history/SPY.json", "[]");
  put(FX, "Screen Recording fixture.mp4", "not really video");
  const ENV_OK = `FIXTURE_API_KEY=${SECRET}\nPORT=3001\n`;
  put(FX, "backend/.env", ENV_OK);
  console.log(`backup-git-bundle e2e — script ${SCRIPT}\n  scanner ${SCANNER}\n  base ${BASE_SCRIPT}\n  fixture ${BASE}`);
  check("git found for the fixture repos", !!GIT, "git not found on PATH or the standard path");
  // the fixture repo is a git repository with a clean history (.env ignored, as in the real repo)
  put(FX, ".gitignore", "backend/.env\n");
  gitIn(FX, "init", "-q");
  gitCommitAll(FX, "fixture: first");
  put(FX, "docs/notes.md", "fixture notes, no secrets\n"); gitCommitAll(FX, "fixture: second");

  // 1. nightly, TRAIDS_BACKUP_MIRROR=none (explicit opt-out)
  fs.writeFileSync(path.join(TMPD, "traids-2020-01-01.zip"), "orphan from a killed run");
  let r = run([]);
  const nz = path.join(DESTF, `traids-${today}.zip`);
  check("nightly, mirror=none: exit 0", r.code === 0, `exit ${r.code}\n${r.all.slice(-600)}`);
  check("nightly, mirror=none: WARN mirror disabled, offDisk=false, no scan line", /WARN mirror disabled \(TRAIDS_BACKUP_MIRROR=none\)/.test(r.err) && /offDisk=false/.test(r.out) && !/secret scan:/.test(r.out), r.all.slice(-500));
  check("nightly: WARN no recent FULL; orphan temp zip reported, not deleted", /WARN no FULL archive newer than 8 days/.test(r.err) && /traids-2020-01-01\.zip/.test(r.err) && fs.existsSync(path.join(TMPD, "traids-2020-01-01.zip")), r.err.slice(-400));
  check("nightly: no temp zip or stage left in TEMP", !fs.existsSync(path.join(TMPD, `traids-${today}.zip`)) && !fs.existsSync(path.join(TMPD, "traids-backup-stage")), ls(TMPD).join(","));
  const ents = fs.existsSync(nz) ? listZip(nz) : [];
  check("nightly archive: futures-1m + ledger in; no video, .env, other training, bar history", ents.includes("backend/data/training/futures-1m/manifest.json") && ents.includes("backend/data/trade_log.json") &&
    !ents.some((e) => /\.mp4$|\.env$|training\/r267|intraday-history/.test(e)), ents.join(","));
  let st = status();
  check("status: nightly ok, offDisk false, mirror.source none, scan skipped", st.nightly.ok === true && st.nightly.offDisk === false && st.nightly.mirror?.source === "none" && st.nightly.mirror?.configured === false &&
    st.nightly.scan && st.nightly.scan.skipped === "no mirror" && /^[0-9a-f]{64}$/.test(st.nightly.sha256), JSON.stringify(st.nightly).slice(0, 500));
  let c = chk([]);
  check("check-status, mirror=none: off-disk mirror FAIL naming =none; secret scan PASS (not run); record/step/archive/futures-1m PASS; FULL age + orphans FAIL",
    c.code === 1 && c.v("record") === "PASS" && c.v("step") === "PASS" && c.v("archive") === "PASS" && c.v("futures-1m") === "PASS" &&
    c.v("off-disk mirror") === "FAIL" && /TRAIDS_BACKUP_MIRROR=none/.test(c.d("off-disk mirror")) && c.v("secret scan") === "PASS" && /not run/.test(c.d("secret scan")) &&
    c.v("FULL age") === "FAIL" && c.v("temp orphans") === "FAIL", c.raw.slice(0, 1200));
  c = chk(["--date", "2099-01-01"]);
  check("check-status for a night with no record: UNKNOWN, exit 2", c.code === 2 && c.j && c.j.verdict === "UNKNOWN" && c.v("record") === "UNKNOWN", c.raw.slice(0, 400));
  { const x = spawnSync(process.execPath, [CHECK, "--file", path.join(BASE, "no-such-status.json")], { encoding: "utf8" });
    check("check-status with no status file: UNKNOWN, exit 2", x.status === 2 && /VERDICT UNKNOWN/.test(String(x.stdout)), String(x.stdout) + String(x.stderr)); }

  // 1b. unset, and the fixture home has NO OneDrive folder -> no default, the old WARN
  r = run([], { TRAIDS_BACKUP_MIRROR: "" });
  check("nightly, mirror unset + no OneDrive root: exit 0, WARN backups are on the repo disk, source unset", r.code === 0 && /WARN backups are on the repo disk \(set TRAIDS_BACKUP_MIRROR\)/.test(r.err) && status().nightly.mirror.source === "unset", r.all.slice(-500));

  // 2. explicit mirror, reachable, same disk: scan runs clean, copy staged outside the mirror
  r = run([], { TRAIDS_BACKUP_MIRROR: MIR });
  check("nightly, explicit mirror: exit 0, mirror copy identical, secret scan clean", r.code === 0 && fs.existsSync(path.join(MIR, `traids-${today}.zip`)) &&
    fs.readFileSync(path.join(MIR, `traids-${today}.zip`)).equals(fs.readFileSync(nz)) && /secret scan: clean/.test(r.out), `exit ${r.code}\n${r.all.slice(-700)}`);
  check("explicit mirror: no partial left in the mirror or in DEST\\.mirror-stage", !ls(MIR).some((f) => /partial/.test(f)) && !ls(STAGEF).length, `${ls(MIR)} | ${ls(STAGEF)}`);
  st = status();
  const sc2 = st.nightly.scan || {};
  check("status: scan ok, scannedBytes == expectedBytes > 0, needles 2 (utf8 + utf16le), no hits; mirror staged outside", sc2.ok === true && sc2.scannedBytes === sc2.expectedBytes && sc2.expectedBytes > 0 &&
    sc2.needles === 2 && Array.isArray(sc2.hitKeys) && !sc2.hitKeys.length && sc2.tarExit === 0 && st.nightly.mirror?.staged === "outside the mirror" && st.nightly.mirror?.source === "env", JSON.stringify(st.nightly).slice(0, 700));
  check("same-disk mirror: offDisk=false with WARN", /offDisk=false/.test(r.out) && /not confirmed off the repo's disk/.test(r.err), r.all.slice(-400));
  c = chk([]);
  check("check-status, same-disk mirror: secret scan PASS, mirror FAIL (not confirmed on another physical disk)", c.code === 1 && c.v("secret scan") === "PASS" && c.v("off-disk mirror") === "FAIL" &&
    /not confirmed on another physical disk/.test(c.d("off-disk mirror")), c.raw.slice(0, 900));

  // 3. explicit mirror set but missing -> FAIL fast (no scan), local kept
  r = run([], { TRAIDS_BACKUP_MIRROR: path.join(BASE, "unplugged-drive") });
  check("nightly, mirror unreachable: exit 1, BACKUP MIRROR FAILED, no scan run, local archive kept", r.code === 1 && /BACKUP MIRROR FAILED/.test(r.err) && /unreachable/.test(r.err) && !/secret scan:/.test(r.out) && fs.existsSync(nz), `exit ${r.code}\n${r.all.slice(-600)}`);
  st = status();
  check("status file: mirror failure recorded ok=false", st.nightly.ok === false && /unreachable/.test(st.nightly.why || ""), JSON.stringify(st.nightly).slice(0, 300));
  c = chk([]);
  check("check-status, mirror unreachable: step FAIL and mirror FAIL", c.code === 1 && c.v("step") === "FAIL" && c.v("off-disk mirror") === "FAIL" && /unreachable/.test(c.raw), c.raw.slice(0, 600));

  // 4. --full: skipped Mon-Thu/Sun/Sat pm without --force; --force with the explicit mirror
  const dow = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date());
  if (!["Fri", "Sat"].includes(dow)) {
    r = run(["--full"]);
    check(`--full on ${dow}: skipped, exit 0, no FULL archive`, r.code === 0 && /runs Fridays only/.test(r.out) && !ls(DESTF).some((f) => /FULL/.test(f)), r.all.slice(-300));
  }
  r = run(["--full", "--force"], { TRAIDS_BACKUP_MIRROR: MIR });
  const fz = path.join(DESTF, `traids-FULL-${today}.zip`);
  const fents = fs.existsSync(fz) ? listZip(fz) : [];
  check("FULL --force: exit 0, archive + mirror copy, scan clean", r.code === 0 && fs.existsSync(fz) && fs.existsSync(path.join(MIR, `traids-FULL-${today}.zip`)) && /secret scan: clean/.test(r.out), `exit ${r.code}\n${r.all.slice(-600)}`);
  check("FULL archive: video + bar history + futures-1m in; .env and other training out", fents.some((e) => /\.mp4$/.test(e)) && fents.some((e) => /intraday-history\/SPY\.json$/.test(e)) &&
    fents.includes("backend/data/training/futures-1m/manifest.json") && !fents.some((e) => /\.env$|training\/r267/.test(e)), fents.join(","));
  c = chk(["--tier", "full"]);
  check("check-status --tier full: record/step/archive/futures-1m/secret scan PASS, mirror FAIL (same disk)",
    c.code === 1 && c.v("record") === "PASS" && c.v("step") === "PASS" && c.v("archive") === "PASS" && c.v("futures-1m") === "PASS" && c.v("secret scan") === "PASS" && c.v("off-disk mirror") === "FAIL", c.raw.slice(0, 900));

  // 4a. (git bundle) the same FULL run wrote, verified, scanned and mirrored the git bundle
  const gz = path.join(DESTF, `traids-git-${today}.bundle`), gzm = path.join(MIR, `traids-git-${today}.bundle`);
  st = status();
  let fb = (st.full && st.full.bundle) || {};
  check("FULL, clean history: bundle in DEST and in the mirror (byte-identical); 'git bundle:' and 'history scan: clean' printed; no bundle stage left in TEMP",
    fs.existsSync(gz) && fs.existsSync(gzm) && fs.readFileSync(gz).equals(fs.readFileSync(gzm)) && /git bundle: .*traids-git-/.test(r.out) && /history scan: clean/.test(r.out) &&
    !fs.existsSync(path.join(TMPD, "traids-git-bundle-stage")) && !ls(STAGEF).length, `${r.all.slice(-900)}\nDEST ${ls(DESTF)} | MIR ${ls(MIR)} | TEMP ${ls(TMPD)}`);
  check("status full.bundle: done+ok, git verify + pack checksum, scan complete (objects + bytes == --batch-check), 2 needles, 0 hits, mirrored, sha256 == the file",
    fb.state === "done" && fb.ok === true && fb.verify?.ok === true && fb.verify?.packChecksumOk === true && fb.verify?.gitVerifyExit === 0 && fb.scan?.ok === true &&
    fb.scan.objects > 0 && fb.scan.objects === fb.scan.expected?.objects && fb.scan.bytes === fb.scan.expected?.bytes && fb.scan.needles === 2 && fb.scan.hitKeys.length === 0 &&
    fb.mirrored === true && fs.existsSync(gz) && fb.sha256 === sha256(gz) && fb.path === gz && fb.mirror?.file === gzm, JSON.stringify(fb).slice(0, 900));
  check("check-status --tier full: git bundle PASS (history scan + mirror named)", c.v("git bundle") === "PASS" && /no hits/.test(c.d("git bundle")) && /mirrored to/.test(c.d("git bundle")), c.raw.slice(0, 900));
  c = chk([]);
  check("check-status nightly: no git bundle item (FULL night only)", c.j && !c.j.items.some((i) => i.name === "git bundle"), c.raw.slice(0, 500));
  { const cl = path.join(BASE, "clone-check");
    execFileSync(GIT, ["-c", "core.longpaths=true", "clone", "-q", gz, cl], { env: SC.gitEnv(), stdio: ["ignore", "pipe", "pipe"] });
    const head = (cwd) => execFileSync(GIT, ["rev-parse", "HEAD"], { cwd, encoding: "utf8", env: SC.gitEnv() }).trim();
    check("the bundle restores: git clone of it has the fixture repo's HEAD and its notes.md", head(cl) === head(FX) && fs.existsSync(path.join(cl, "docs", "notes.md")) && !fs.existsSync(path.join(cl, "backend", ".env")), head(cl));
    fs.rmSync(cl, { recursive: true, force: true }); }

  // 4b. FULL with TRAIDS_BACKUP_MIRROR=none: the bundle is kept local, no history scan is needed, the step passes
  r = run(["--full", "--force"]);
  st = status(); fb = st.full.bundle || {};
  c = chk(["--tier", "full"]);
  check("FULL, mirror=none: exit 0, bundle kept in DEST only, scan skipped 'no mirror', check-status git bundle PASS 'kept local only'",
    r.code === 0 && fs.existsSync(gz) && fb.ok === true && fb.scan?.skipped === "no mirror" && fb.mirrored === false && !/history scan:/.test(r.out) &&
    c.v("git bundle") === "PASS" && /kept local only/.test(c.d("git bundle")), `exit ${r.code}\n${r.all.slice(-600)}\n${JSON.stringify(fb).slice(0, 400)}\n${c.raw.slice(0, 500)}`);

  // 4c. git missing: fail closed, but the FULL archive itself is still written and recorded
  const fzMtime = fs.statSync(fz).mtimeMs;
  r = run(["--full", "--force"], { TRAIDS_BACKUP_MIRROR: MIR, TRAIDS_BACKUP_GIT: path.join(BASE, "no-such-git", "git.exe") });
  st = status(); fb = st.full.bundle || {};
  check("FULL, git missing: exit 1, the LAST stderr line is 'BACKUP GIT BUNDLE FAILED: git not found (TRAIDS_BACKUP_GIT=... does not exist)'",
    r.code === 1 && /^BACKUP GIT BUNDLE FAILED: git not found \(TRAIDS_BACKUP_GIT=.* does not exist\)/.test(lastErrLine(r.err)), `exit ${r.code}\n${r.all.slice(-600)}`);
  c = chk(["--tier", "full"]);
  check("FULL, git missing: the FULL archive is still written + mirrored + recorded (archive PASS, secret scan PASS); bundle FAIL; step FAIL",
    fs.statSync(fz).mtimeMs > fzMtime && st.full.sizeBytes === fs.statSync(fz).size && fs.existsSync(path.join(MIR, `traids-FULL-${today}.zip`)) && st.full.ok === false &&
    fb.ok === false && /git not found/.test(fb.why || "") && /git bundle: git not found/.test(st.full.why || "") &&
    c.v("archive") === "PASS" && c.v("secret scan") === "PASS" && c.v("git bundle") === "FAIL" && /git not found/.test(c.d("git bundle")) && c.v("step") === "FAIL", `${JSON.stringify(st.full).slice(0, 600)}\n${c.raw.slice(0, 700)}`);

  // 4d. a fake secret committed, then deleted in a later commit: the history scan hits -> local only, not mirrored, exit 1
  put(FX, "docs/leaked-note.txt", `pasted by mistake: ${SECRET}\n`); gitCommitAll(FX, "fixture: a leak");
  fs.unlinkSync(path.join(FX, "docs", "leaked-note.txt")); gitCommitAll(FX, "fixture: remove the leak");
  for (const f of ls(MIR)) if (/\.bundle$/.test(f)) fs.unlinkSync(path.join(MIR, f));
  const gzBefore = sha256(gz);
  r = run(["--full", "--force"], { TRAIDS_BACKUP_MIRROR: MIR });
  st = status(); fb = st.full.bundle || {};
  check("secret in git history: exit 1; the LAST stderr line names the history path and the KEY ('docs/leaked-note.txt -> FIXTURE_API_KEY'), bundle kept local, NOT mirrored",
    r.code === 1 && /^BACKUP GIT BUNDLE FAILED: bundle kept local \(.*\), NOT mirrored — secret VALUES in git history \(rotate those keys, then re-run\): docs\/leaked-note\.txt -> FIXTURE_API_KEY$/.test(lastErrLine(r.err)) &&
    lastErrLine(r.err).slice(-400).includes("docs/leaked-note.txt -> FIXTURE_API_KEY"), `exit ${r.code}\n${r.all.slice(-800)}`);
  check("secret in git history: tonight's NEW bundle is in DEST, NO bundle in the mirror; the FULL zip is still mirrored (its own scan is clean)",
    fs.existsSync(gz) && sha256(gz) !== gzBefore && !ls(MIR).some((f) => /bundle/.test(f)) && fs.existsSync(path.join(MIR, `traids-FULL-${today}.zip`)) && /secret scan: clean/.test(r.out), `${ls(MIR)}\n${r.out.slice(-500)}`);
  check("secret in git history: record bundle ok false, scan complete, hitKeys has backend/.env:FIXTURE_API_KEY, hitPaths docs/leaked-note.txt, mirrored false",
    fb.ok === false && fb.mirrored === false && fb.scan?.ok === false && fb.scan.hitKeys.includes("backend/.env:FIXTURE_API_KEY") && fb.scan.objects === fb.scan.expected?.objects &&
    fb.scan.bytes === fb.scan.expected?.bytes && fb.scan.hitPaths.some((h) => h.path === "docs/leaked-note.txt" && h.keys.includes("FIXTURE_API_KEY")) && fb.path === gz, JSON.stringify(fb).slice(0, 900));
  c = chk(["--tier", "full"]);
  check("check-status --tier full, secret in history: git bundle FAIL naming 'docs/leaked-note.txt -> FIXTURE_API_KEY'; step FAIL; archive PASS",
    c.v("git bundle") === "FAIL" && /secret VALUES in git history: docs\/leaked-note\.txt -> FIXTURE_API_KEY/.test(c.d("git bundle")) && c.v("step") === "FAIL" && c.v("archive") === "PASS", c.raw.slice(0, 900));

  // 5. the fixture home now HAS a OneDrive root; mirror unset -> the default OneDrive mirror is chosen and its folder created
  fs.mkdirSync(ODR, { recursive: true });
  r = run([], { TRAIDS_BACKUP_MIRROR: "" });
  const odz = path.join(ODM, `traids-${today}.zip`);
  check("default OneDrive mirror: exit 0, folder created, archive copied identical, scan clean", r.code === 0 && fs.existsSync(ODM) && fs.existsSync(odz) &&
    fs.readFileSync(odz).equals(fs.readFileSync(nz)) && /secret scan: clean/.test(r.out), `exit ${r.code}\n${r.all.slice(-700)}`);
  check("default OneDrive mirror: no partial ever left inside OneDrive; DEST\\.mirror-stage empty", !ls(ODM).some((f) => /partial/.test(f)) && !ls(STAGEF).length, `${ls(ODM)} | ${ls(STAGEF)}`);
  st = status();
  const cs5 = st.nightly.mirror?.cloudSynced || {};
  check("default OneDrive mirror: status source default, staged outside, cloudSynced tonight pending, NOT confirmed (fixture folder), offDisk=false",
    st.nightly.mirror?.source === "default" && st.nightly.mirror?.staged === "outside the mirror" && cs5.tonight === "pending" && cs5.state !== "confirmed" && st.nightly.offDisk === false && st.nightly.ok === true,
    JSON.stringify(st.nightly.mirror).slice(0, 700));
  check("default OneDrive mirror: WARN offDisk=false with the sync reason", /offDisk=false/.test(r.out) && /OneDrive folder, sync (pending|unconfirmed)/.test(r.err), r.all.slice(-500));
  c = chk([]);
  check("check-status, unconfirmed OneDrive: off-disk mirror FAIL 'OneDrive sync is ...', secret scan PASS", c.code === 1 && c.v("off-disk mirror") === "FAIL" && /OneDrive sync is (pending|unconfirmed)/.test(c.d("off-disk mirror")) && c.v("secret scan") === "PASS", c.raw.slice(0, 900));
  const rec5 = st.nightly;

  // 6. a NON-canonical copy of the repo is refused the default mirror
  const OTHER = path.join(BASE, "elsewhere", "traids-bundle");
  fs.cpSync(FX, OTHER, { recursive: true });
  const odBefore = ls(ODM).join(",");
  r = run([], { TRAIDS_BACKUP_MIRROR: "" }, path.join(OTHER, "automation", "backup.cjs"));
  const stO = status(path.join(OTHER, "backend", "data", "backup-status.json"));
  check("non-canonical copy, mirror unset: exit 0, WARN default refused, OneDrive mirror untouched, source refused", r.code === 0 && /WARN default OneDrive mirror refused/.test(r.err) &&
    ls(ODM).join(",") === odBefore && stO.nightly.mirror?.source === "refused" && stO.nightly.mirror?.configured === false, `exit ${r.code}\n${r.all.slice(-500)}`);
  fs.rmSync(path.join(BASE, "elsewhere"), { recursive: true, force: true });

  // 7. a leaked secret (UTF-8 + UTF-16LE) -> refusal, exit 1, no mirror file, status ok:false with hitKeys
  for (const f of ls(ODM)) fs.unlinkSync(path.join(ODM, f));
  put(FX, "backend/data/leak.log", `token in a log: ${SECRET}\n`);
  put(FX, "docs/leak16.txt", Buffer.from(`wide: ${SECRET}`, "utf16le"));
  r = run([], { TRAIDS_BACKUP_MIRROR: "" });
  check("leaked secret: exit 1, BACKUP MIRROR FAILED naming both key forms, local archive kept", r.code === 1 &&
    /BACKUP MIRROR FAILED: secret VALUES found inside the archive \(backend\/\.env:FIXTURE_API_KEY, backend\/\.env:FIXTURE_API_KEY\(utf16le\)\)/.test(r.err) && fs.existsSync(nz), `exit ${r.code}\n${r.all.slice(-700)}`);
  check("leaked secret: NO file in the OneDrive mirror, no partial in DEST\\.mirror-stage", ls(ODM).length === 0 && !ls(STAGEF).length, `${ls(ODM)} | ${ls(STAGEF)}`);
  { const lc = spawnSync(process.execPath, [path.join(FX, "automation", "backup-secret-scan.cjs"), nz, "--root", FX, "--locate"], { encoding: "utf8", timeout: 120000 });
    seen.push(String(lc.stdout) + String(lc.stderr)); let lj = {}; try { lj = JSON.parse(String(lc.stdout).trim()); } catch { }
    const he = lj.hitEntries || {};
    check("leaked secret: scanner CLI --locate names the entries (backend/data/leak.log, docs/leak16.txt), exit 1", lc.status === 1 &&
      JSON.stringify(he["backend/.env:FIXTURE_API_KEY"]) === '["backend/data/leak.log"]' && JSON.stringify(he["backend/.env:FIXTURE_API_KEY(utf16le)"]) === '["docs/leak16.txt"]', String(lc.stdout).slice(0, 500)); }
  st = status();
  check("leaked secret: status ok:false, scan.ok false, hitKeys recorded, offDisk false", st.nightly.ok === false && st.nightly.scan?.ok === false && st.nightly.offDisk === false &&
    JSON.stringify(st.nightly.scan?.hitKeys) === JSON.stringify(["backend/.env:FIXTURE_API_KEY", "backend/.env:FIXTURE_API_KEY(utf16le)"]) && /secret VALUES/.test(st.nightly.why || ""), JSON.stringify(st.nightly).slice(0, 700));
  c = chk([]);
  check("check-status, leaked secret: secret scan FAIL with key names, step FAIL, mirror FAIL", c.code === 1 && c.v("secret scan") === "FAIL" && /FIXTURE_API_KEY/.test(c.d("secret scan")) &&
    c.v("step") === "FAIL" && c.v("off-disk mirror") === "FAIL", c.raw.slice(0, 900));
  fs.unlinkSync(path.join(FX, "backend", "data", "leak.log")); fs.unlinkSync(path.join(FX, "docs", "leak16.txt"));

  // 8. missing backend/.env -> refusal; 9. .env with no secret values -> refusal
  fs.unlinkSync(path.join(FX, "backend", ".env"));
  r = run([], { TRAIDS_BACKUP_MIRROR: "" });
  st = status();
  check("missing backend/.env: exit 1, scan failed (backend/.env missing), no mirror file, status scan.error", r.code === 1 && /secret scan failed \(backend\/\.env missing or unreadable/.test(r.err) &&
    ls(ODM).length === 0 && st.nightly.ok === false && /backend\/\.env missing/.test(st.nightly.scan?.error || ""), `exit ${r.code}\n${r.all.slice(-600)}`);
  c = chk([]);
  check("check-status, missing .env: secret scan FAIL (scan not complete)", c.code === 1 && c.v("secret scan") === "FAIL" && /scan not complete/.test(c.d("secret scan")), c.raw.slice(0, 700));
  put(FX, "backend/.env", "PORT=3001\nFRONTEND_URL=http://localhost:5173\n");
  r = run([], { TRAIDS_BACKUP_MIRROR: "" });
  check(".env with zero secret values: exit 1, refusal (a scan for nothing proves nothing), no mirror file", r.code === 1 && /no secret values found/.test(r.err) && ls(ODM).length === 0, `exit ${r.code}\n${r.all.slice(-600)}`);
  put(FX, "backend/.env", ENV_OK);

  // 13. NIGHTLY UNCHANGED (git-bundle package): the same nightly runs on two identical twin fixtures — BASE files vs the files
  //     under test. Exit code, stdout, stderr, the status record (numbers and the twin's own path normalised), the archive's
  //     entry list and the mirror listings must be identical; entries, needles and kept are compared exactly.
  {
    const baseOk = fs.existsSync(BASE_SCRIPT) && sha256(BASE_SCRIPT) === BASE_SHA.script && fs.existsSync(BASE_SCANNER) && sha256(BASE_SCANNER) === BASE_SHA.scanner;
    check("nightly unchanged: the BASE files are the pre-package live bytes (a5486b1a / 8e012686)", baseOk, BASE_SCRIPT);
    if (baseOk) {
      const BLOB = crypto.randomBytes(2 * 1024 * 1024);
      const twinFiles = [["backend/data/trade_log.json", "[]"], ["backend/data/test-registry.json", "{}"], ["backend/data/blob.bin", BLOB],
        ["backend/data/training/futures-1m/manifest.json", "{}"], ["backend/data/training/futures-1m/ES/ES-1m.json", "[]"], ["backend/data/training/r267/x.json", "[]"],
        ["backend/data/intraday-history/SPY.json", "[]"], ["Screen Recording fixture.mp4", "not really video"], ["backend/.env", ENV_OK], [".gitignore", "backend/.env\n"], ["docs/notes.md", "twin\n"]];
      const makeTwin = (tag, script, scanner) => {
        const root = path.join(BASE, `twin-${tag}`), home = path.join(root, "home"), fx = path.join(home, "Downloads", "traids (2)", "traids-bundle");
        const tw = { tag, root, home, fx, tmp: path.join(root, "temp"), mir: path.join(root, "mirror"), dest: path.join(home, "Documents", "TRAIDS-backups"),
          od: path.join(home, "OneDrive", "Documents", "TRAIDS-backups"), status: path.join(fx, "backend", "data", "backup-status.json") };
        for (const d of [tw.tmp, tw.mir, path.join(fx, "automation"), path.join(fx, "backend", "lib")]) fs.mkdirSync(d, { recursive: true });
        fs.copyFileSync(script, path.join(fx, "automation", "backup.cjs")); fs.copyFileSync(scanner, path.join(fx, "automation", "backup-secret-scan.cjs"));
        fs.copyFileSync(path.join(REPO, "backend", "lib", "atomic-write.js"), path.join(fx, "backend", "lib", "atomic-write.js"));
        for (const [rel, body] of twinFiles) put(fx, rel, body);
        if (GIT) { gitIn(fx, "init", "-q"); gitCommitAll(fx, "twin"); }   // a git repository, like the real one: the nightly must not touch it
        return tw;
      };
      const runTwin = (tw, env) => {
        const r = spawnSync(process.execPath, [path.join(tw.fx, "automation", "backup.cjs")], { cwd: tw.fx, encoding: "utf8", timeout: 10 * 60000,
          env: { ...process.env, USERPROFILE: tw.home, TEMP: tw.tmp, TMP: tw.tmp, TRAIDS_BACKUP_MIRROR: "none", TRAIDS_BACKUP_GIT: "", ...(typeof env === "function" ? env(tw) : env) } });
        const o = { code: r.status, out: String(r.stdout || ""), err: String(r.stderr || "") }; seen.push(o.out + o.err); return o;
      };
      // the archive's sha256 differs by design (each twin's archive carries its own automation\backup.cjs); everything else must not
      const normFor = (tw) => (s) => String(s).split(tw.root).join("<TWIN>").split(JSON.stringify(tw.root).slice(1, -1)).join("<TWIN>").replace(/\b[0-9a-f]{64}\b/g, "<SHA256>").replace(/\d+/g, "#");
      const A = makeTwin("a", BASE_SCRIPT, BASE_SCANNER), B = makeTwin("b", SCRIPT, SCANNER);
      const zipIn = (tw) => path.join(tw.dest, `traids-${today}.zip`);
      const same = (label, env, prep) => {
        if (prep) { prep(A); prep(B); }
        const ra = runTwin(A, env), rb = runTwin(B, env), na = normFor(A), nb = normFor(B), diffs = [];
        const raw = (tw) => { try { const t = fs.readFileSync(tw.status, "utf8"); seen.push(t); return t; } catch { return ""; } };
        const ta = raw(A), tb = raw(B);
        if (ra.code !== rb.code) diffs.push(`exit ${ra.code} vs ${rb.code}`);
        if (na(ra.out) !== nb(rb.out)) diffs.push(`stdout:\n${na(ra.out)}\n--- vs ---\n${nb(rb.out)}`);
        if (na(ra.err) !== nb(rb.err)) diffs.push(`stderr:\n${na(ra.err)}\n--- vs ---\n${nb(rb.err)}`);
        if (na(ta) !== nb(tb)) diffs.push(`status record:\n${na(ta).slice(0, 1200)}\n--- vs ---\n${nb(tb).slice(0, 1200)}`);
        const ja = (ta && JSON.parse(ta).nightly) || {}, jb = (tb && JSON.parse(tb).nightly) || {};
        if (ja.entries !== jb.entries || (ja.scan || {}).needles !== (jb.scan || {}).needles || ja.kept !== jb.kept || "bundle" in jb) diffs.push(`entries/needles/kept/bundle: ${JSON.stringify([ja.entries, jb.entries, (ja.scan || {}).needles, (jb.scan || {}).needles, ja.kept, jb.kept, "bundle" in jb])}`);
        const ea = fs.existsSync(zipIn(A)) ? listZip(zipIn(A)).sort().join(",") : "none", eb = fs.existsSync(zipIn(B)) ? listZip(zipIn(B)).sort().join(",") : "none";
        if (ea !== eb) diffs.push(`archive entries differ:\n${ea}\n--- vs ---\n${eb}`);
        const ma = [ls(A.mir), ls(A.od), ls(A.dest)].map((x) => x.join(",")).join(" | "), mb = [ls(B.mir), ls(B.od), ls(B.dest)].map((x) => x.join(",")).join(" | ");
        if (ma !== mb) diffs.push(`mirror/DEST listings: ${ma} vs ${mb}`);
        check(`nightly unchanged — ${label}: exit ${rb.code}; stdout, stderr, status record, archive entries, mirror + DEST listings identical (BASE vs staged)`, !diffs.length, diffs.join("\n").slice(0, 2500));
      };
      same("mirror=none", {});
      same("explicit mirror (same disk, scan clean)", (tw) => ({ TRAIDS_BACKUP_MIRROR: tw.mir }));
      same("default OneDrive mirror", { TRAIDS_BACKUP_MIRROR: "" }, (tw) => fs.mkdirSync(path.join(tw.home, "OneDrive"), { recursive: true }));
      same("leaked secret refused", { TRAIDS_BACKUP_MIRROR: "" }, (tw) => put(tw.fx, "backend/data/leak.log", `token: ${SECRET}\n`));
      same("missing .env refused", { TRAIDS_BACKUP_MIRROR: "" }, (tw) => { fs.unlinkSync(path.join(tw.fx, "backend", "data", "leak.log")); fs.unlinkSync(path.join(tw.fx, "backend", ".env")); });
      same("futures-1m store missing (INCOMPLETE)", {}, (tw) => { put(tw.fx, "backend/.env", ENV_OK); fs.rmSync(path.join(tw.fx, "backend", "data", "training", "futures-1m"), { recursive: true, force: true }); });
      const bundlesA = ls(A.dest).filter((f) => /bundle/.test(f)), bundlesB = ls(B.dest).filter((f) => /bundle/.test(f));
      check("nightly unchanged: no git bundle was written by any nightly run (either twin)", !bundlesA.length && !bundlesB.length && !ls(A.tmp).concat(ls(B.tmp)).some((f) => /git-bundle/.test(f)), `${bundlesA} ${bundlesB}`);
    }
  }

  // 10/11 run in-process against the fixture's own backup.cjs (require() only exports since this fix)
  asyncPart = (async () => {
    // A backup.cjs without the require.main guard would START A BACKUP when required (TEMP here is the real one): never load it.
    if (!/\nif \(require\.main === module\) \{/.test(fs.readFileSync(SCRIPT, "utf8"))) {
      check("require() guard present (backup.cjs only exports when required) — in-process cases 10/11 skipped", false, "this backup.cjs runs main() on require; not loaded");
      return;
    }
    const savedHome = process.env.USERPROFILE;
    process.env.USERPROFILE = HOME;   // module constants (DEST, ONEDRIVE_ROOT, CANONICAL_ROOT) resolve into the fixture
    let mod;
    try { mod = require(path.join(FX, "automation", "backup.cjs")); } finally { process.env.USERPROFILE = savedHome; }
    check("require() of backup.cjs runs nothing and exports the mirror functions", typeof mod.scanAndMirror === "function" && typeof mod.mirrorArchive === "function" && mod.DEST === DESTF && mod.ONEDRIVE_ROOT === ODR, Object.keys(mod).join(","));

    // 10. corrupt-entry zip: tar fails mid-stream -> refusal (scanner CLI, and scanAndMirror as main() calls it)
    const cst = path.join(BASE, "corrupt-stage");
    const filler = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} ${i} ${crypto.randomBytes(12).toString("hex")}\n`).join("");
    put(cst, "a.txt", filler(14000, "first")); put(cst, "b.txt", filler(14000, "second")); put(cst, "c.txt", `${filler(500, "third")}leak=${SECRET}\n`);
    const cz = path.join(BASE, `traids-${today}.zip`);
    execFileSync(TAR, ["-a", "-c", "-f", cz, "-C", cst, "a.txt", "b.txt", "c.txt"]);
    const expected = mod.probeZip(cz).uncompressedBytes;
    mod.corruptZipEntry(cz, 1);
    const cli = spawnSync(process.execPath, [path.join(FX, "automation", "backup-secret-scan.cjs"), cz, "--root", FX, "--expected", String(expected)], { encoding: "utf8", timeout: 120000 });
    seen.push(String(cli.stdout) + String(cli.stderr));
    let cj = {}; try { cj = JSON.parse(String(cli.stdout).trim()); } catch { }
    check("corrupt-entry zip, scanner CLI: exit 1, ok:false, tar exit != 0, scanned < central-directory total", cli.status === 1 && cj.ok === false && cj.tarExit !== 0 && cj.scannedBytes < expected && /tar exited/.test(cj.error || ""),
      `exit ${cli.status} ${String(cli.stdout).slice(0, 400)}`);
    const odBefore10 = ls(ODM).join(",");
    const choice = mod.chooseMirror({ env: "" });
    const sm = await mod.scanAndMirror({ file: cz, sha: mod.sha256File(cz), expectedBytes: expected, full: false, choice, stageDir: path.join(DESTF, mod.MIRROR_STAGE) });
    check("corrupt-entry zip, scanAndMirror (default OneDrive choice): mirror refused 'secret scan failed (tar exited ...)', nothing copied",
      choice.source === "default" && sm.mirror.ok === false && /secret scan failed \(tar exited/.test(sm.mirror.error || "") && ls(ODM).join(",") === odBefore10 && !ls(STAGEF).length, JSON.stringify({ choice, m: sm.mirror }).slice(0, 600));
    const sfC = path.join(BASE, "status-corrupt.json");
    mod.writeStatus(sfC, "nightly", { ...rec5, ok: false, offDisk: false, mirror: mod.mirrorStatus(sm.mirror), scan: mod.scanStatus(sm.scan), why: sm.mirror.error });
    c = chk([], sfC);
    check("check-status on the corrupt-entry record: secret scan FAIL (scan not complete), step FAIL", c.code === 1 && c.v("secret scan") === "FAIL" && /scan not complete/.test(c.d("secret scan")) && c.v("step") === "FAIL", c.raw.slice(0, 800));

    // 11. cloudSynced pending / confirmed / stale: real mirrorArchive with fake cloud probes, judged by check-status
    const fakeCloud = (names) => ({ accountFolder: () => ODR, reparseTag: (f) => (names.includes(path.basename(f)) ? 0x9000601a : null) });
    const cloudCase = (label, prevFiles, cloudNames) => {
      for (const f of ls(ODM)) fs.unlinkSync(path.join(ODM, f));
      for (const f of prevFiles) fs.writeFileSync(path.join(ODM, f), "earlier archive");
      const m = mod.mirrorArchive({ file: nz, sha: mod.sha256File(nz), mirrorDir: ODM, full: false, repoRoot: FX, stageDir: STAGEF, cloud: fakeCloud(cloudNames), today, oneDriveRoot: ODR });
      const sf = path.join(BASE, `status-cloud-${label}.json`);
      const recC = { ...rec5, ok: m.ok, out: nz, sizeBytes: fs.statSync(nz).size, offDisk: m.offDisk, mirror: { ...mod.mirrorStatus({ ...m, source: "default" }) }, why: null };
      mod.writeStatus(sf, "nightly", recC); mod.writeStatus(sf, "full", { ...recC, tier: "full" });
      return { m, sf };
    };
    const y = prevWeekday(today), old = prevWeekday(today, 4);
    const p = cloudCase("pending", [], []);
    c = chk([], p.sf);
    check("cloud pending (first mirror run): offDisk=false; check-status off-disk mirror FAIL 'OneDrive sync is pending'", p.m.ok && p.m.offDisk === false && p.m.cloudSynced.state === "pending" &&
      c.v("off-disk mirror") === "FAIL" && /OneDrive sync is pending/.test(c.d("off-disk mirror")), `${JSON.stringify(p.m.cloudSynced)}\n${c.raw.slice(0, 600)}`);
    const cf = cloudCase("confirmed", [`traids-${y}.zip`], [`traids-${y}.zip`]);
    c = chk([], cf.sf);
    check(`cloud confirmed (traids-${y}.zip is a cloud placeholder): offDisk=true; check-status off-disk mirror PASS`, cf.m.ok && cf.m.offDisk === true && cf.m.cloudSynced.state === "confirmed" &&
      c.v("off-disk mirror") === "PASS" && /OneDrive took/.test(c.d("off-disk mirror")), `${JSON.stringify(cf.m.cloudSynced)}\n${c.raw.slice(0, 700)}`);
    const later = nextWeekday(today, 3);
    const laterOk = Math.round((Date.parse(later) - Date.parse(today)) / 864e5) <= 8;
    c = chk(["--tier", "full", "--date", later], cf.sf);
    check(`cloud confirmed on ${today}, read on ${later} (3 weekdays on): check-status re-judges it stale -> FAIL`, laterOk && c.v("off-disk mirror") === "FAIL" && /stale/.test(c.d("off-disk mirror")), c.raw.slice(0, 700));
    const sl = cloudCase("stale", [`traids-${old}.zip`], [`traids-${old}.zip`]);
    c = chk([], sl.sf);
    check(`cloud stale (newest taken archive traids-${old}.zip, 4 weekdays): offDisk=false; check-status FAIL 'OneDrive sync is stale'`, sl.m.ok && sl.m.offDisk === false && sl.m.cloudSynced.state === "stale" &&
      c.v("off-disk mirror") === "FAIL" && /OneDrive sync is stale/.test(c.d("off-disk mirror")), `${JSON.stringify(sl.m.cloudSynced)}\n${c.raw.slice(0, 600)}`);
    check("cloud cases: copies staged outside OneDrive, nothing left in DEST\\.mirror-stage", [p, cf, sl].every((x) => x.m.staged === "outside the mirror") && !ls(STAGEF).length, ls(STAGEF).join(","));

    // 14. (git bundle) a truncated cat-file stream — a fake git in front of the real one cuts the --batch stream in half and
    //     still exits 0 with nothing on stderr — through gitBundleStep as main() calls it: fail closed
    {
      const FAKE = path.join(BASE, "fake-git.cjs"); fs.writeFileSync(FAKE, FAKE_GIT_SRC);
      const mirT = path.join(BASE, "mirror-trunc"); fs.mkdirSync(mirT, { recursive: true });
      const b = await mod.gitBundleStep({ root: FX, dest: DESTF, stamp: "2026-01-02", stageDir: path.join(TMPD, "traids-git-bundle-stage"), choice: { dir: mirT, source: "env" },
        mirrorStageDir: STAGEF, git: [process.execPath, FAKE], env: { ...process.env, FAKE_GIT_REAL: GIT, FAKE_GIT_MODE: "truncate" }, today, oneDriveRoot: ODR });
      const st14 = mod.bundleStatus(b); seen.push(JSON.stringify(st14), String(b.why));
      check("truncated cat-file stream (fake git: exit 0, empty stderr), via gitBundleStep: 'history scan failed (... truncated)', bundle kept in DEST, nothing in the mirror",
        !b.ok && /^history scan failed \(the cat-file --batch stream: .*truncated/.test(b.why) && fs.existsSync(path.join(DESTF, "traids-git-2026-01-02.bundle")) && ls(mirT).length === 0 &&
        st14.scan.ok === false && st14.scan.complete === false && st14.mirrored === false && !fs.existsSync(path.join(TMPD, "traids-git-bundle-stage")), JSON.stringify(st14).slice(0, 800));
      const sfB = path.join(BASE, "status-bundle.json");
      mod.writeStatus(sfB, "full", { ...rec5, tier: "full", ok: false, bundle: st14, why: `git bundle: ${b.why}` });
      c = chk(["--tier", "full"], sfB);
      check("check-status on that record: git bundle FAIL (scan NOT complete / truncated), step FAIL", c.v("git bundle") === "FAIL" && /truncated/.test(c.d("git bundle")) && c.v("step") === "FAIL", c.raw.slice(0, 800));
      mod.writeStatus(sfB, "full", { ...rec5, tier: "full", ok: true, bundle: { state: "running", name: `traids-git-${today}.bundle`, startedAt: new Date().toISOString() } });
      c = chk(["--tier", "full"], sfB);
      check("check-status: a FULL record whose bundle is still 'running' (step killed mid-bundle) -> git bundle FAIL 'never finished'", c.v("git bundle") === "FAIL" && /never finished/.test(c.d("git bundle")), c.raw.slice(0, 600));
      mod.writeStatus(sfB, "full", { ...rec5, tier: "full" });
      c = chk(["--tier", "full"], sfB);
      check("check-status: a FULL record with no bundle at all (an older backup.cjs) -> git bundle UNKNOWN", c.v("git bundle") === "UNKNOWN", c.raw.slice(0, 600));
    }

    // 12. futures-1m (unchanged behaviour, run with the mirror off)
    fs.unlinkSync(path.join(FX, "backend", "data", "training", "futures-1m", "manifest.json"));
    r = run([]);
    check("futures-1m present but manifest not archived: exit 1, INCOMPLETE 'not in the archive', archive kept", r.code === 1 &&
      /BACKUP INCOMPLETE: futures 1m bar store[^\n]*manifest\.json is not in the archive/.test(r.err) && fs.existsSync(nz), `exit ${r.code}\n${r.all.slice(-600)}`);
    c = chk([]);
    check("check-status: futures-1m FAIL, FULL age PASS (a FULL now exists)", c.code === 1 && c.v("futures-1m") === "FAIL" && c.v("FULL age") === "PASS", c.raw.slice(0, 900));
    fs.rmSync(path.join(FX, "backend", "data", "training", "futures-1m"), { recursive: true, force: true });
    r = run([]);
    check("futures-1m missing: exit 1, BACKUP INCOMPLETE, archive kept", r.code === 1 && /BACKUP INCOMPLETE: futures 1m bar store/.test(r.err) && fs.existsSync(nz), `exit ${r.code}\n${r.all.slice(-600)}`);

    check("the fake secret VALUE appears in no output, no status record and no check-status report", !seen.some((t) => t.includes(SECRET)) && !seen.some((t) => t.includes(Buffer.from(SECRET, "utf16le").toString("latin1"))), "LEAKED");
  })();
} catch (e) {
  check(`e2e threw: ${e.message}`, false, e.stack);
}
asyncPart.catch((e) => check(`e2e threw: ${e.message}`, false, e.stack)).finally(() => {
  fs.rmSync(BASE, { recursive: true, force: true });
  if (fs.existsSync(BASE)) console.log(`  WARN fixture left at ${BASE}`);
  const bad = results.filter((x) => !x).length;
  console.log(`E2E ${bad ? "FAIL" : "PASS"} (${results.length - bad}/${results.length})`);
  process.exit(bad ? 1 : 0);
});
