#!/usr/bin/env node
/**
 * RESTAGE package "backup" (health sweep 2026-10-05) — (re)builds staged\ and manifest.json from the CURRENT live files.
 *
 *   node restage.cjs
 *
 * Why it exists: close-chain.cjs is shared ground — another 2026-10-05 package (or tonight's operator) may change it before
 * this one deploys, and deploy.cjs then refuses (live sha != baseSha). Re-running this applies the same two exact hunks on top
 * of whatever close-chain.cjs / power-calibration.js now hold and re-records baseSha, so the package rebases instead of being
 * rebuilt by hand. Each hunk must match EXACTLY ONCE or it refuses (a hunk that no longer applies needs a human merge).
 *
 * automation/backup.cjs is a full rewrite (staged\automation\backup.cjs is the authored file). It is only restaged while the
 * live backup.cjs is still the version it was written against (BACKUP_AUTHORED_ON); anything else is a manual merge.
 *
 * Never run this AFTER deploying: rollback.cjs reads manifest.json for the baseSha of the bytes it restores.
 * Reads live files only; writes staged\ and manifest.json (writeJsonAtomic) inside this package directory.
 */
const { spawnSync } = require("child_process");
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const REPO = "C:\\Users\\joshc\\Downloads\\traids (2)\\traids-bundle";
const PKG = path.join(REPO, "docs", "health-fixes", "2026-10-05", "backup");
const { writeJsonAtomic } = require(path.join(REPO, "backend", "lib", "atomic-write.js"));
const BACKUP_AUTHORED_ON = "9f5c34c3c6c2545c020e68ae994902614c9dc138d98bfd751684b99937e9a664";   // live automation/backup.cjs on 2026-10-05 (tar.exe, 30-min timeout, uncommitted)
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const die = (m) => { console.error(`RESTAGE REFUSED: ${m}`); process.exit(1); };

const HUNKS = {
  "automation\\close-chain.cjs": [
    ["power calibration step",
      `  ["power calibration (Sun)", "backend/power-calibration.js", 12],\n`,
      `  ["power calibration (Fri)", "backend/power-calibration.js", 12, { onlyOn: 5 }],   // 2026-10-05 health sweep BK4: was "(Sun)" behind a Sunday self-gate this Mon-Fri chain never reached (last measured 09-09); now Friday, declared here and gated in the script\n`],
    ["backup steps",
      `  ["backup", "automation/backup.cjs", 30],\n` +
      `  // FULL tier: everything incl. 10.3 GB of bar history. Self-skips six days a week; Sundays only.\n` +
      `  ["backup full (Sun)", "automation/backup.cjs", 45, { args: ["--full"] }],\n`,
      `  // 2026-10-05 health sweep: the nightly now also carries backend/data/training/futures-1m (BK3, irreplaceable) and no longer\n` +
      `  // carries video files (BK8, FULL only); TRAIDS_BACKUP_MIRROR adds a verified off-disk copy (BK1). See backup.cjs.\n` +
      `  ["backup", "automation/backup.cjs", 30],\n` +
      `  // FULL tier: everything incl. 10.3 GB of bar history. FRIDAYS (onlyOn: 5). 2026-10-05 health sweep BK4: this was "(Sun)" behind a\n` +
      `  // Sunday self-gate in backup.cjs, and this chain never runs on Sunday, so no FULL archive was ever written while the step\n` +
      `  // reported ok every night. backup.cjs keeps a Friday gate of its own as the second lock (--force overrides it by hand).\n` +
      `  ["backup full (Fri)", "automation/backup.cjs", 45, { args: ["--full"], onlyOn: 5 }],\n`],
  ],
  "backend\\power-calibration.js": [
    ["usage line",
      ` * Usage: node backend/power-calibration.js [--trials 4000] [--json]\n`,
      ` * Usage: node backend/power-calibration.js [--trials 4000] [--json] [--force] [--gate-only [--now <ISO>]]\n`],
    ["weekly gate",
      ` * session count does — one more session cannot meaningfully change an MDE built on 35. So it self-\n` +
      ` * skips six days a week, the same convention the full backup tier uses, and the chain can call it\n` +
      ` * unconditionally without anyone maintaining a second schedule. --force runs it any day.\n` +
      ` */\n` +
      `if (!argv.includes("--force") && !JSON_OUT) {\n` +
      `  const dowET = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short" });\n` +
      `  if (dowET !== "Sun") { console.log(\`  power-calibration: \${dowET} — weekly job, runs Sundays (use --force to run now)\`); process.exit(0); }\n` +
      `}\n`,
      ` * session count does — one more session cannot meaningfully change an MDE built on 35. So it self-\n` +
      ` * skips six days a week, the same convention the full backup tier uses. --force runs it any day.\n` +
      ` *\n` +
      ` * FRIDAY, NOT SUNDAY (2026-10-05, health sweep BK4). This gate said Sunday, but the close chain runs Monday-Friday only, so\n` +
      ` * the chain never ran this at all: the last measurement was 09-09 while chain-status showed "power calibration (Sun)" ok\n` +
      ` * every night. Same defect and same fix as the chain's onlyOn:0 -> 5 move on 2026-09-27. The chain now declares onlyOn: 5\n` +
      ` * for this step; this gate is the second lock. The chain takes its weekday once, at its own start, so a Friday chain that\n` +
      ` * ran past midnight ET still counts as Friday until 12:00 ET Saturday. --gate-only [--now <ISO>] prints the decision and\n` +
      ` * exits before reading anything ("will it run tonight?").\n` +
      ` */\n` +
      `function weeklyGateET(now) {\n` +
      `  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(now).map((x) => [x.type, x.value]));\n` +
      `  return { due: p.weekday === "Fri" || (p.weekday === "Sat" && Number(p.hour) < 12), dow: p.weekday };\n` +
      `}\n` +
      `if (argv.includes("--gate-only")) {\n` +
      `  const ni = argv.indexOf("--now"), now = ni >= 0 ? new Date(argv[ni + 1]) : new Date();\n` +
      `  if (Number.isNaN(now.getTime())) { console.log("power-calibration gate: UNKNOWN — --now is not a date"); process.exit(2); }\n` +
      `  const g = weeklyGateET(now);\n` +
      `  console.log(\`power-calibration gate: \${g.due ? "RUN" : "SKIP"} (\${g.dow} ET)\`);\n` +
      `  process.exit(0);\n` +
      `}\n` +
      `if (!argv.includes("--force") && !JSON_OUT) {\n` +
      `  const g = weeklyGateET(new Date());\n` +
      `  if (!g.due) { console.log(\`  power-calibration: \${g.dow} — weekly job, runs Fridays (use --force to run now)\`); process.exit(0); }\n` +
      `}\n`],
  ],
};

const files = [];
// backup.cjs — authored full file
{
  const rel = "automation\\backup.cjs", live = fs.readFileSync(path.join(REPO, rel)), staged = path.join(PKG, "staged", rel);
  if (sha(live) !== BACKUP_AUTHORED_ON) die(`${rel} changed since the rewrite was authored (${sha(live).slice(0, 12)} != ${BACKUP_AUTHORED_ON.slice(0, 12)}) — merge by hand`);
  if (!fs.existsSync(staged)) die(`authored ${staged} is missing`);
  const s = fs.readFileSync(staged);
  if (/\r\n/.test(live.toString("utf8")) !== /\r\n/.test(s.toString("utf8"))) die(`${rel}: staged newline style differs from live`);
  files.push({ rel, baseSha: sha(live), stagedSha: sha(s), how: "full rewrite" });
}
// hunk files
for (const [rel, hunks] of Object.entries(HUNKS)) {
  const liveBuf = fs.readFileSync(path.join(REPO, rel));
  let text = liveBuf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) die(`${rel} has a BOM — unexpected`);
  const crlf = /\r\n/.test(text);
  const nl = (s) => (crlf ? s.replace(/\n/g, "\r\n") : s);
  for (const [label, from, to] of hunks) {
    const n = text.split(nl(from)).length - 1;
    if (n !== 1) die(`${rel} hunk "${label}" matches ${n} times (expected exactly 1) — the file changed around it; merge by hand`);
    text = text.replace(nl(from), () => nl(to));
  }
  const out = path.join(PKG, "staged", rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text, "utf8");
  files.push({ rel, baseSha: sha(liveBuf), stagedSha: sha(Buffer.from(text, "utf8")), how: `${hunks.length} hunk(s), ${crlf ? "CRLF" : "LF"}` });
}
for (const f of files) {
  const r = spawnSync(process.execPath, ["-c", path.join(PKG, "staged", f.rel)], { encoding: "utf8" });
  if (r.status !== 0) die(`node -c failed on staged ${f.rel}: ${String(r.stderr).slice(0, 300)}`);
}
writeJsonAtomic(path.join(PKG, "manifest.json"), { package: "backup", builtAt: new Date().toISOString(), files });
for (const f of files) console.log(`  staged ${f.rel.padEnd(30)} base ${f.baseSha.slice(0, 12)} -> staged ${f.stagedSha.slice(0, 12)} (${f.how})`);
console.log("manifest.json written. Run selftest.cjs --staged, then deploy.cjs.");
