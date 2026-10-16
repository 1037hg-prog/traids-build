#!/usr/bin/env node
/**
 * OP11 R21 SHADOW — write manifest.json from base-shas.json (the live shas recorded when the staged copies were cut) and the staged files.
 * Refuses when: a base/ copy is not its recorded sha; the LIVE file has drifted from it (rebase the staged copy first); the staged newline
 * style / BOM / final newline differs from the base; a staged .js file fails node --check (in its CommonJS staging context).
 *   node docs/health-fixes/2026-10-05/op11-r21-shadow/make-manifest.cjs
 */
"use strict";
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const L = require("./lib.cjs");
const B = JSON.parse(fs.readFileSync(path.join(L.PKG, "base-shas.json"), "utf8"));
const problems = [], files = [];
for (const rel of L.FILES) {
  const rec = B.files[rel]; if (!rec) { problems.push(`${rel}: not in base-shas.json`); continue; }
  const bb = fs.readFileSync(L.basePath(rel)), sb = fs.readFileSync(L.stagedPath(rel)), lb = fs.readFileSync(L.livePath(rel));
  if (L.sha256(bb) !== rec.baseSha) problems.push(`${rel}: base/ copy is not the recorded base sha`);
  if (L.sha256(lb) !== rec.baseSha) problems.push(`${rel}: LIVE file drifted since staging (${L.sha256(lb).slice(0, 12)} != ${rec.baseSha.slice(0, 12)}) — read the change and rebase the staged copy`);
  if (L.eolOf(sb) !== L.eolOf(bb) || L.hasBom(sb) !== L.hasBom(bb) || (sb[sb.length - 1] === 10) !== (bb[bb.length - 1] === 10)) problems.push(`${rel}: staged newline style/BOM/final newline differs from the base (${L.eolOf(sb)} vs ${L.eolOf(bb)})`);
  const c = spawnSync(process.execPath, ["--check", L.stagedPath(rel)], { encoding: "utf8", windowsHide: true });
  if (c.status !== 0) problems.push(`${rel}: node --check failed: ${(c.stderr || "").trim().split("\n")[0]}`);
  files.push({ live: rel, staged: path.posix.join("staged", rel), base: path.posix.join("base", rel), baseSha: rec.baseSha, stagedSha: L.sha256(sb), eol: L.eolOf(bb), bom: L.hasBom(bb), backup: path.relative(L.REPO, L.backupPathFor(rel)).replace(/\\/g, "/") });
}
if (problems.length) { console.error(`REFUSED — manifest not written:\n  - ${problems.join("\n  - ")}`); process.exit(2); }
const out = { package: L.PKG_NAME, built: new Date().toISOString(), unit: "all four files deploy and roll back together", files };
fs.writeFileSync(L.MANIFEST, JSON.stringify(out, null, 2) + "\n");
for (const f of files) console.log(`  ${f.live.padEnd(34)} ${f.baseSha.slice(0, 12)} -> ${f.stagedSha.slice(0, 12)} (${f.eol})`);
console.log(`manifest.json written (${files.length} files)`);
