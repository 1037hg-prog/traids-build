#!/usr/bin/env node
"use strict";
/**
 * PROFIT FIXES B (Plan E) — ROLLBACK: put every applied edit back, byte-exact.
 *   node docs/profit-fixes/2026-10-12/b-plan-e/rollback.cjs --plan     READ-ONLY: what would be put back
 *   node docs/profit-fixes/2026-10-12/b-plan-e/rollback.cjs --apply    the write mode (same fences as deploy.cjs)
 * Each edit's new block is replaced by its old block, each found exactly once (anything else is DRIFT: refused whole, restore that file by hand
 * from backups/). With nothing else changed since the apply every file returns to the sha recorded before it (printed as "byte-exact: yes");
 * when another package has edited a different part of a file since, that edit is kept and the file returns to what it would be without this one.
 * What rollback does NOT undo: forward rows risk-manager.js wrote while the fix was in (they stay in risk-manager-forward.jsonl, on the calendar
 * window), and any scoreboard history rows rewritten on the financed model line — the next scoreboard run rewrites every row on whichever model
 * line the file then has. Exit 0 done / nothing to do · 1 failed · 2 refused or usage.
 */
const cp = require("child_process"), path = require("path");
const L = require("./lib.cjs");
const args = process.argv.slice(2), MODE = args.length === 1 && (args[0] === "--plan" || args[0] === "--apply") ? args[0] : null;
if (!MODE) { console.log("usage: node docs/profit-fixes/2026-10-12/b-plan-e/rollback.cjs --plan | --apply\nNothing was done."); process.exit(2); }
const E = L.loadEdits(), files = L.filesOf(E), P = L.plan(E), rec = (L.readState().applied || {}).files || {};
console.log(`ROLLBACK ${MODE === "--plan" ? "PLAN (nothing is written)" : ""} — profit fixes B (Plan E) — ${L.mtNow().dow} ${L.mtNow().date} ${L.mtNow().hms} MT`);
for (const f of P) console.log(`  ${f.rel.padEnd(42)} ${f.problem ? "PROBLEM: " + f.problem : f.state === "drift" ? "DRIFT (" + f.states.filter((x) => x.state === "drift").map((x) => x.id).join(", ") + ")" : f.state}${f.state === "applied" || f.state === "mixed" ? ` -> base${rec[f.rel] ? ` (recorded sha before the apply ${rec[f.rel].before.slice(0, 12)})` : ""}` : ""}`);
if (MODE === "--plan") { const fz = L.fences({ files }); console.log(`  fences now: ${fz.length ? "the write mode would be REFUSED:\n    - " + fz.join("\n    - ") : "clear"}\n  nothing was written.`); process.exit(0); }
const r = L.rollbackAll({ E });
if (r.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${r.why.join("\n  - ")}`); L.logRow({ script: "rollback", result: "refused", why: r.why }); process.exit(2); }
if (r.result === "noop") { console.log("nothing to roll back."); L.logRow({ script: "rollback", result: "noop" }); process.exit(0); }
if (r.result !== "rolled-back") { console.error(`ROLLBACK FAILED: ${r.why.join("; ")}${r.restored ? " — the files are as they were before this run" : " — NOT RESTORED: " + r.notRestored.join(", ")}`); L.logRow({ script: "rollback", result: "failed", why: r.why }); process.exit(1); }
let bad = 0;
for (const [rel, f] of Object.entries(r.files)) { const c = cp.spawnSync(process.execPath, ["--check", path.join(L.REPO, rel)], { encoding: "utf8", windowsHide: true }); if (c.status !== 0) bad++; console.log(`  restored ${rel.padEnd(42)} sha ${f.now.slice(0, 12)}   byte-exact: ${f.byteExact === true ? "yes" : f.byteExact === false ? "NO — the file was edited elsewhere since the apply; that edit is kept" : "no record of the apply to compare with"}${c.status !== 0 ? "   node --check FAILED" : ""}`); }
L.logRow({ script: "rollback", result: bad ? "rolled-back-with-problems" : "rolled-back", files: r.files });
console.log(bad ? "ROLLED BACK, but a file does not parse — inspect it." : "ROLLED BACK. Nothing to restart. If the board package's copy step ran while the fix was in, run it again (NOTES).");
process.exit(bad ? 1 : 0);
