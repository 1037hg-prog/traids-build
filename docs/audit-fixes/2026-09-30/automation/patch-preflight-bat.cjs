#!/usr/bin/env node
// 2026-10-01 audit (ops#2): restore preflight.bat's self-heal gate to preflight.js's own exit code.
// Commit 40f500847 (09-29) put `node backend\ops-alert.js --preflight` between preflight.js and `if errorlevel 1`; ops-alert.js
// always exits 0 (ops-alert.js:46), so self-heal.js has not run since 09-29 08:10 MT. Fix: capture preflight's code into PFCODE
// right after it runs and gate on `not "%PFCODE%"=="0"` (fail closed: DEGRADED 1, NO-GO 2, a crash code or a negative code all heal).
// Usage: node docs/audit-fixes/2026-09-30/automation/patch-preflight-bat.cjs            dry run (prints the new block, writes nothing)
//        node docs/audit-fixes/2026-09-30/automation/patch-preflight-bat.cjs --apply    backup + atomic rename over automation/preflight.bat
// Only apply between :05 and :55 past the hour, with no cmd.exe executing preflight.bat (cmd re-reads a running batch by byte offset).
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..", "..", "..", ".."), F = path.join(ROOT, "automation", "preflight.bat");
const BAK = path.join(ROOT, "docs", "audit-fixes", "2026-09-30", "backups", "automation__preflight.bat.orig");
const APPLY = process.argv.includes("--apply");
const src = fs.readFileSync(F, "utf8"), EOL = src.includes("\r\n") ? "\r\n" : "\n";
if (src.includes("PFCODE")) { console.log("preflight.bat: already patched (PFCODE present) - nothing to do"); process.exit(0); }
const OLD = ["node backend\\preflight.js >> automation\\preflight.log 2>&1",
  ":: 2026-09-29: tell the operator (operator chat only) when preflight is NO-GO, once per day per failing set, plus a recovery note",
  "node backend\\ops-alert.js --preflight >> automation\\preflight.log 2>&1",
  "if errorlevel 1 ("].join(EOL);
const NEW = ["node backend\\preflight.js >> automation\\preflight.log 2>&1",
  ":: 2026-10-01 audit (ops): keep preflight's OWN exit code (0 GO, 1 DEGRADED, 2 NO-GO) - ops-alert.js below always exits 0, and from 09-29",
  ":: to 10-01 the `if errorlevel 1` gate read ops-alert's code, so self-heal never ran. Any non-zero code (incl. a crash) heals.",
  "set \"PFCODE=%errorlevel%\"",
  ":: 2026-09-29: tell the operator (operator chat only) when preflight is NO-GO, once per day per failing set, plus a recovery note",
  "node backend\\ops-alert.js --preflight >> automation\\preflight.log 2>&1",
  "if not \"%PFCODE%\"==\"0\" ("].join(EOL);
const n = src.split(OLD).length - 1;
if (n !== 1) { console.error(`preflight.bat: expected the 09-29 block exactly once, found ${n} - NOT patching (UNKNOWN)`); process.exit(2); }
const out = src.replace(OLD, NEW);
console.log(`--- new gate block (${EOL === "\r\n" ? "CRLF" : "LF"} kept) ---\n` + NEW);
if (!APPLY) { console.log("\n(dry run - pass --apply to write)"); process.exit(0); }
if (!fs.existsSync(BAK)) { fs.mkdirSync(path.dirname(BAK), { recursive: true }); fs.copyFileSync(F, BAK); console.log("backup ->", BAK); }
const tmp = F + ".tmp-" + process.pid;
const fd = fs.openSync(tmp, "w"); try { fs.writeFileSync(fd, out); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
fs.renameSync(tmp, F);
console.log("preflight.bat patched via atomic rename:", fs.readFileSync(F, "utf8").includes("PFCODE") ? "OK" : "FAILED");
