#!/usr/bin/env node
/**
 * MEASURE the git bundle + history scan on the REAL repo, package "backup-git-bundle" (2026-10-05). READ-ONLY on the repo.
 *
 *   node measure-real.cjs [--live] [--no-clone] [--dir <base>]
 *
 * Uses the STAGED backup.cjs + backup-secret-scan.cjs (or the live ones with --live) by require() — both only export when
 * required; nothing runs. The bundle, its stage and a bare test clone go under <base>\traids-gb-measure-<pid> (default: the OS
 * temp dir) and are DELETED at the end. No mirror is configured, DEST and the OneDrive mirror are never written (their listings
 * are compared before/after), and the repo's refs and HEAD are compared before/after.
 * Prints names, paths, counts, sizes and times only. It holds the secret values in memory to prove that none of them is in its
 * own output (it prints only the yes/no), and never prints one.
 */
const { execFileSync } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const REPO = "C:\\Users\\joshc\\Downloads\\traids (2)\\traids-bundle";
const PKG = path.join(REPO, "docs", "health-fixes", "2026-10-05", "backup-git-bundle");
const argv = process.argv.slice(2);
const LIVE = argv.includes("--live");
const di = argv.indexOf("--dir");
const BASE = di >= 0 && argv[di + 1] ? path.resolve(argv[di + 1]) : os.tmpdir();
const HOME = process.env.USERPROFILE || "C:\\Users\\joshc";
const DEST = path.join(HOME, "Documents", "TRAIDS-backups"), OD = path.join(HOME, "OneDrive", "Documents", "TRAIDS-backups");
const OUT = path.join(BASE, `traids-gb-measure-${process.pid}`);
const insideOf = (p, d) => { const r = path.relative(d, p); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
for (const d of [REPO, DEST, path.join(HOME, "OneDrive")]) if (insideOf(OUT, d)) { console.error(`REFUSED: ${OUT} is inside ${d}`); process.exit(2); }
const dir = LIVE ? path.join(REPO, "automation") : path.join(PKG, "staged", "automation");
const bk = require(path.join(dir, "backup.cjs"));
const sc = require(path.join(dir, "backup-secret-scan.cjs"));
const g = sc.findGit();
if (!g.path) { console.error(`git not found: ${g.why}`); process.exit(2); }
const git = (...a) => execFileSync(g.path, a, { cwd: REPO, encoding: "utf8", env: sc.gitEnv(), maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
const ls = (d) => { try { return fs.readdirSync(d).map((f) => { const s = fs.statSync(path.join(d, f)); return `${f}:${s.size}:${s.mtimeMs}`; }).sort().join("|"); } catch { return "absent"; } };
const refsNow = () => crypto.createHash("sha256").update(git("for-each-ref", "--format=%(objectname) %(refname)") + git("rev-parse", "HEAD")).digest("hex");
const before = { dest: ls(DEST), od: ls(OD), refs: refsNow() };
const out = { files: LIVE ? "live" : "staged", git: g.path, gitHow: g.how };

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
  try {
    out.repo = { refs: git("for-each-ref").trim().split("\n").length, commits: Number(git("rev-list", "--all", "--count").trim()) };
    // 1. create + verify + place, exactly as the FULL tier does (no mirror: the scan is run separately below)
    let t = Date.now();
    const b = await bk.gitBundleStep({ root: REPO, dest: path.join(OUT, "dest"), stageDir: path.join(OUT, "stage"), mirrorStageDir: path.join(OUT, "mstage"), choice: { dir: "", source: "none" }, deadline: Date.now() + 40 * 60000 });
    out.bundle = { ok: b.ok, why: b.why, name: b.name, sizeBytes: b.sizeBytes, sizeGB: b.sizeBytes ? +(b.sizeBytes / 2 ** 30).toFixed(3) : null, objects: b.objects, refs: b.refs, placed: b.placed, verify: b.verify, phases: b.phases, secs: b.secs };
    // 2. the history scan, as the mirror gate runs it
    t = Date.now();
    const s = await bk.historyScanForMirror({ root: REPO, git: g.path, timeoutMs: 15 * 60000 });
    out.scan = { ok: s.ok, error: s.error, objects: s.objects, bytes: s.bytes, expected: s.expected, needles: s.needles, hitKeys: s.hitKeys, hitPaths: s.hitPaths, hitPathsTruncated: !!s.hitPathsTruncated,
      gitExit: s.gitExit, checkExit: s.checkExit, stderr: s.stderr, secs: s.secs, wallSecs: Math.round((Date.now() - t) / 100) / 10, sources: (s.sources || []).map((x) => `${x.file}:${x.values}`) };
    out.scan.complete = s.objects === (s.expected || {}).objects && s.bytes === (s.expected || {}).bytes && s.gitExit === 0 && s.checkExit === 0 && !s.stderr;
    out.scan.reportsAlphaVantageByName = (s.hitPaths || []).some((h) => h.keys.includes("ALPHAVANTAGE_KEY"));
    out.scan.wouldMirror = s.ok === true;
    // 3. an independent restore test: a bare clone of the bundle (index-pack re-verifies every object)
    if (!argv.includes("--no-clone") && b.path) {
      t = Date.now();
      execFileSync(g.path, ["clone", "--bare", "-q", b.path, path.join(OUT, "bare.git")], { env: sc.gitEnv(), stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 << 20 });
      const head = execFileSync(g.path, ["rev-parse", "HEAD"], { cwd: path.join(OUT, "bare.git"), encoding: "utf8", env: sc.gitEnv() }).trim();
      const n = execFileSync(g.path, ["rev-list", "--all", "--count"], { cwd: path.join(OUT, "bare.git"), encoding: "utf8", env: sc.gitEnv() }).trim();
      out.clone = { secs: Math.round((Date.now() - t) / 100) / 10, headMatches: head === git("rev-parse", "HEAD").trim(), commits: Number(n) };
    }
    // 4. no value in this output (checked in memory; only the yes/no is printed)
    const vals = sc.collectSecretValues(REPO, { secretFiles: bk.SECRET_FILES, skipDirs: [...bk.XD_ALWAYS, ...bk.XD_BULK] }).values.map((v) => v.value);
    const txt = JSON.stringify(out);
    out.noSecretValueInThisOutput = !vals.some((v) => txt.includes(v) || txt.includes(Buffer.from(v, "utf16le").toString("latin1")));
  } catch (e) { out.error = String(e.message).split("\n")[0].slice(0, 300); }
  finally {
    fs.rmSync(OUT, { recursive: true, force: true });
    out.tempDeleted = !fs.existsSync(OUT);
    const after = { dest: ls(DEST), od: ls(OD), refs: refsNow() };
    out.untouched = { dest: before.dest === after.dest, oneDriveMirror: before.od === after.od, repoRefsAndHead: before.refs === after.refs };
  }
  console.log(JSON.stringify(out, null, 1));
  process.exit(out.error ? 1 : 0);
})();
