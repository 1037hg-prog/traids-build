#!/usr/bin/env node
"use strict";
/**
 * CAPITAL MODEL — MEASURED COST (2026-10-16) — stamp the STAGED sha256s into deploy.cjs (the two /*STAGED_SHA_*\/ slots) after an edit to
 * a staged file. READ-ONLY on the repo; writes only deploy.cjs here.
 *   node docs/capital-model-measured-cost/2026-10-16/stamp.cjs --check   say whether the slots match the staged files (exit 1 if not)
 *   node docs/capital-model-measured-cost/2026-10-16/stamp.cjs --write   put the current shas in
 * The base shas are never stamped: they are the bytes the package was built against and a change to one is a rebuild, not a stamp.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const PKG = __dirname, DEPLOY = path.join(PKG, "deploy.cjs");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const SLOTS = [["STAGED_SHA_MODEL", "staged/backend/profit-program/planE-model.js"], ["STAGED_SHA_BASELINE", "staged/backend/profit-program/planE-baseline.js"]];
const a = process.argv.slice(2), MODE = a.length === 1 && ["--check", "--write"].includes(a[0]) ? a[0] : null;
if (!MODE) { console.log("usage: node docs/capital-model-measured-cost/2026-10-16/stamp.cjs --check | --write\nNothing was done."); process.exit(2); }
let text = fs.readFileSync(DEPLOY, "utf8"); const bad = [];
for (const [slot, rel] of SLOTS) {
  const want = sha(fs.readFileSync(path.join(PKG, ...rel.split("/")))), re = new RegExp(`(/\\*${slot}\\*/")([0-9a-f]{64})("/\\*END\\*/)`);
  const m = re.exec(text); if (!m) { console.error(`the ${slot} slot is not in deploy.cjs`); process.exit(1); }
  if (m[2] !== want) { bad.push(`${rel}: deploy.cjs says ${m[2].slice(0, 12)}, the file is ${want.slice(0, 12)}`); text = text.replace(re, `$1${want}$3`); }
  console.log(`  ${slot.padEnd(20)} ${want}  ${rel}${m[2] === want ? "  (already stamped)" : "  (STALE)"}`);
}
if (!bad.length) { console.log("both staged shas are stamped."); process.exit(0); }
if (MODE === "--check") { console.error(`STALE:\n  - ${bad.join("\n  - ")}\nrun stamp.cjs --write`); process.exit(1); }
fs.writeFileSync(DEPLOY, text);
console.log(`deploy.cjs stamped:\n  - ${bad.join("\n  - ")}`);
