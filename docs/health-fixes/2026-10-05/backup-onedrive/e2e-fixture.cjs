#!/usr/bin/env node
/**
 * END-TO-END FIXTURE RUN, package "backup-onedrive" (2026-10-05 review fix of the OneDrive mirror). Runs the WHOLE main() path of
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
const BASE = path.join(path.resolve(opt("--dir", os.tmpdir())), `traids-bkod-e2e-${process.pid}`);
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
    env: { ...process.env, USERPROFILE: HOME, TEMP: TMPD, TMP: TMPD, TRAIDS_BACKUP_MIRROR: "none", ...env },
  });
  const o = { code: r.status, out: String(r.stdout || ""), err: String(r.stderr || ""), all: String(r.stdout || "") + String(r.stderr || "") };
  seen.push(o.all);
  return o;
}
const status = (file = STATUS) => { const t = fs.readFileSync(file, "utf8"); seen.push(t); return JSON.parse(t); };
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
  console.log(`backup-onedrive e2e — script ${SCRIPT}\n  scanner ${SCANNER}\n  fixture ${BASE}`);

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
