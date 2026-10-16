#!/usr/bin/env node
/**
 * LOCAL CI GATE (2026-09-22). One command, three gates, a non-zero exit if any fails:
 *   1. SYNTAX   — `node --check` on every .js / .cjs / .mjs under backend/, automation/, assessment-agents/ (node_modules and data excluded).
 *                 --check parses without executing, so the close chain is never run by accident (see memory: never require a runner).
 *   2. SUITE    — backend/test/run.js (the defect-organised regression suite, incl. the verification fixtures).
 *   3. GUARD    — backend/feature-guard-scan.js: no script outside the audited manifest may read a post-entry input (PASS / FAIL / UNKNOWN).
 * The live-data leak tests (scrambled-price runs) need vendor data and minutes per run, so they stay per-test and nightly, not per change.
 * Writes data/ci-last.json. There is no git remote yet, so this runs locally; a pre-commit hook can call it once the operator approves one.
 *   node backend/ci.js            all gates
 *   node backend/ci.js --quick    syntax + suite only
 */
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const ROOT = path.join(__dirname, ".."), QUICK = process.argv.includes("--quick");
const SKIP = new Set(["node_modules", "data", "dist", ".git", "worktrees", "training"]);
function walk(dir, out = []) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (SKIP.has(e.name)) continue; const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (/\.(c|m)?js$/.test(e.name)) out.push(p); } return out; }
const gates = [];
const t0 = Date.now();
// 1. syntax
{ const files = ["backend", "automation", "assessment-agents"].filter((d) => fs.existsSync(path.join(ROOT, d))).flatMap((d) => walk(path.join(ROOT, d)));
  const bad = []; for (const f of files) { const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" }); if (r.status !== 0) bad.push({ file: path.relative(ROOT, f), error: (r.stderr || "").split("\n").find((l) => /Error/.test(l)) || "syntax error" }); }
  gates.push({ gate: "syntax", pass: !bad.length, detail: `${files.length} files checked, ${bad.length} failed`, failures: bad.slice(0, 30) }); }
// 2. regression suite
{ const r = spawnSync(process.execPath, [path.join(__dirname, "test", "run.js")], { encoding: "utf8", timeout: 300000 });
  const m = (r.stdout || "").match(/(\d+) passed, (\d+) failed/), fails = [...(r.stdout || "").matchAll(/^\s{4}(.+ :: .+)$/gm)].map((x) => x[1]);
  gates.push({ gate: "suite", pass: r.status === 0, detail: m ? `${m[1]} passed, ${m[2]} failed` : `runner exit ${r.status}`, failures: fails }); }
// 3. input-timing guard
if (!QUICK) { const r = spawnSync(process.execPath, [path.join(__dirname, "feature-guard-scan.js")], { encoding: "utf8", timeout: 120000 });
  gates.push({ gate: "feature-guard", pass: r.status === 0, detail: r.status === 0 ? "PASS" : r.status === 3 ? "UNKNOWN — the scan could not run (counts as a failure)" : "FAIL — a script reads a post-entry input", failures: r.status === 0 ? [] : [(r.stdout || r.stderr || "").trim().split("\n").slice(-3).join(" | ")] }); }
const pass = gates.every((g) => g.pass), out = { spec: "ci-v1", ranAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), pass, gates };
try { fs.writeFileSync(path.join(__dirname, "data", "ci-last.json"), JSON.stringify(out, null, 1)); } catch {}
console.log(`TRAIDS CI — ${pass ? "PASS" : "FAIL"} (${out.seconds}s)`);
for (const g of gates) { console.log(`  ${g.pass ? "ok  " : "FAIL"} ${g.gate.padEnd(14)} ${g.detail}`); for (const f of g.failures.slice(0, 8)) console.log(`        ${typeof f === "string" ? f : f.file + " — " + f.error}`); }
process.exit(pass ? 0 : 1);
