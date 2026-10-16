#!/usr/bin/env node
"use strict";
/**
 * REFRESH THE STAGED SHAs (insider clusters package, 2026-10-16) — a build-time tool, not part of what ships.
 *
 *   node docs/insider-clusters/2026-10-16/harness/refresh-shas.cjs            report: does deploy.cjs name the staged bytes?
 *   node docs/insider-clusters/2026-10-16/harness/refresh-shas.cjs --write    rewrite each /*STAGED_SHA*​/"…" to the bytes on disk
 *
 * deploy.cjs names every staged file's sha256 so that an apply can refuse a staged copy that is not the one reviewed. While the
 * package is still being built, a change to a staged file has to be followed by a change to that number; this writes it, and the
 * selftest's check A1 is what holds them together afterwards. It touches deploy.cjs and nothing else.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const PKG = path.resolve(__dirname, "..");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const DEPLOY = path.join(PKG, "deploy.cjs");

function run({ write = false } = {}) {
  let text = fs.readFileSync(DEPLOY, "utf8");
  const rows = [];
  text = text.replace(/staged: "(staged\/[^"]+)", baseSha: null, stagedSha: \/\*STAGED_SHA\*\/"([0-9a-f]{64})"/g, (m, rel, had) => {
    const now = sha(fs.readFileSync(path.join(PKG, ...rel.split("/"))));
    rows.push({ rel, had, now, same: had === now });
    return m.replace(had, now);
  });
  if (write) fs.writeFileSync(DEPLOY, text);
  return rows;
}

module.exports = { run, DEPLOY };

if (require.main === module) {
  const write = process.argv.includes("--write"), rows = run({ write });
  for (const r of rows) console.log(`  ${r.same ? "same " : write ? "WROTE" : "STALE"} ${r.rel}  ${r.now.slice(0, 12)}${r.same ? "" : `  (deploy.cjs said ${r.had.slice(0, 12)})`}`);
  const stale = rows.filter((r) => !r.same).length;
  console.log(rows.length === 6 ? `${rows.length} staged files, ${stale} ${write ? "rewritten" : "stale"}` : `EXPECTED 6 staged entries in deploy.cjs, found ${rows.length}`);
  process.exit(rows.length === 6 && (write || !stale) ? 0 : 1);
}
