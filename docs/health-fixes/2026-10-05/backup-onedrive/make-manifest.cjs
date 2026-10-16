#!/usr/bin/env node
/**
 * MANIFEST for package "backup-onedrive" (2026-10-05). Records, per file, the LIVE bytes this package was built against
 * (baseSha) and the staged bytes (stagedSha). deploy.cjs refuses unless live == baseSha and staged == stagedSha.
 *
 *   node make-manifest.cjs
 *
 * BUILT_AGAINST is the live state the staged files were written from (2026-10-05 ~16:00 MT, tonight's OneDrive edit). If live
 * has changed since, this refuses: the staged files would silently revert someone's change — re-stage on top of the new live
 * file instead. Reads live + staged files; writes only manifest.json beside this script (atomic).
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const REPO = "C:\\Users\\joshc\\Downloads\\traids (2)\\traids-bundle";
const PKG = path.join(REPO, "docs", "health-fixes", "2026-10-05", "backup-onedrive");
const { writeJsonAtomic } = require(path.join(REPO, "backend", "lib", "atomic-write.js"));
const BUILT_AGAINST = {
  "automation\\backup.cjs": "bbb173141f0f174d4bc997f063bc39535b20b7caf8acb832b0e8eb9c7f1cca8c",
  "automation\\backup-secret-scan.cjs": "3feb99196a8c5406913f2dd96bd6ad3c29676df70c64b8acba315896c086d264",
};
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const files = [];
for (const [rel, base] of Object.entries(BUILT_AGAINST)) {
  const l = sha(path.join(REPO, rel)), s = sha(path.join(PKG, "staged", rel));
  if (l !== base) { console.error(`MANIFEST REFUSED: live ${rel} is ${l.slice(0, 12)}, not ${base.slice(0, 12)} (what this package was built against) — re-stage on top of it`); process.exit(1); }
  const txt = fs.readFileSync(path.join(PKG, "staged", rel), "utf8");
  if (/\r\n/.test(txt)) { console.error(`MANIFEST REFUSED: staged ${rel} has CRLF line endings (live is LF)`); process.exit(1); }
  files.push({ rel, baseSha: base, stagedSha: s, how: "full file (LF)" });
}
writeJsonAtomic(path.join(PKG, "manifest.json"), { package: "backup-onedrive", builtAt: new Date().toISOString(), files });
for (const f of files) console.log(`  ${f.rel}: base ${f.baseSha.slice(0, 12)} -> staged ${f.stagedSha.slice(0, 12)}`);
console.log("manifest.json written");
