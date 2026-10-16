#!/usr/bin/env node
"use strict";
/**
 * KELLY COLUMN (2026-10-16) — rewrite the STAGED sha256 values inside deploy.cjs from the staged files on disk. Build-time only:
 * it exists so a staged file and the sha the deploy checks it against can never drift apart by hand. It never touches a baseSha
 * (a base copy is the bytes the change starts from: when that changes, the package is rebuilt, not re-stamped) and it writes
 * nothing outside this package.
 *
 *   node docs/kelly-column/2026-10-16/sync-shas.cjs --check    READ-ONLY: say whether each staged sha in deploy.cjs matches disk
 *   node docs/kelly-column/2026-10-16/sync-shas.cjs            rewrite the ones that do not
 * Exit 0 in step (or rewritten) · 1 out of step under --check · 2 usage or a marker that cannot be found.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const PKG = __dirname, DEPLOY = path.join(PKG, "deploy.cjs");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

/** every /*SHA <rel>*\/"<64 hex>"/*END*\/ marker in deploy.cjs, against the staged file it names */
function states(text = fs.readFileSync(DEPLOY, "utf8")) {
  const D = require("./deploy.cjs"), out = [];
  for (const f of D.FILES) {
    const re = new RegExp(`/\\*SHA ${f.rel.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\*/"([0-9a-f]{64})"/\\*END\\*/`);
    const m = re.exec(text), disk = sha(fs.readFileSync(path.join(PKG, ...f.staged.split("/"))));
    out.push({ rel: f.rel, re, inFile: m ? m[1] : null, disk, ok: !!m && m[1] === disk, found: !!m });
  }
  return out;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.length > 1 || (a.length === 1 && a[0] !== "--check")) { console.log("usage: node docs/kelly-column/2026-10-16/sync-shas.cjs [--check]"); process.exit(2); }
  let text = fs.readFileSync(DEPLOY, "utf8");
  const st = states(text), missing = st.filter((s) => !s.found);
  if (missing.length) { console.error(`no sha marker for ${missing.map((s) => s.rel).join(", ")} in deploy.cjs`); process.exit(2); }
  for (const s of st) console.log(`  ${s.ok ? "in step " : "DIFFERS"}  ${s.rel.padEnd(28)} deploy.cjs ${String(s.inFile).slice(0, 12)}  disk ${s.disk.slice(0, 12)}`);
  if (a[0] === "--check") { const bad = st.filter((s) => !s.ok); console.log(bad.length ? `OUT OF STEP: ${bad.map((s) => s.rel).join(", ")} — run it without --check` : "every staged sha in deploy.cjs matches disk"); process.exit(bad.length ? 1 : 0); }
  let n = 0;
  for (const s of st) if (!s.ok) { text = text.replace(s.re, `/*SHA ${s.rel}*/"${s.disk}"/*END*/`); n++; }
  if (n) fs.writeFileSync(DEPLOY, text);
  console.log(n ? `rewrote ${n} staged sha(s) in deploy.cjs` : "nothing to rewrite");
  process.exit(0);
}
module.exports = { states, sha, DEPLOY, PKG };
