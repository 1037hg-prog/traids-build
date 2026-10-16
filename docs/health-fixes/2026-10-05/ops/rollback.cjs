#!/usr/bin/env node
/**
 * OPS HEALTH FIX 2026-10-05 — ROLLBACK one part (or all) from the backups deploy.cjs made.
 *   node docs/health-fixes/2026-10-05/ops/rollback.cjs --part breaker|selfheal|closearm|all [--dry]
 * Per file, in reverse deploy order: the backup must exist with the base sha; the live file must be EXACTLY what deploy.cjs wrote (the
 * staged sha) — anything else means someone changed it after the deploy, and it is refused (merge by hand); a live file already at the
 * base sha is skipped. Restored byte-exact (temp + rename), sha verified, node --check. A part is restored as a unit.
 * Fences: selfheal — no preflight run in progress and minute 01-49 MT; closearm — no runner process, no live lock, not 13:30-13:50 MT on
 * a session day; breaker — none (but the running :3001 keeps the deployed code until the operator restarts it — say so).
 */
"use strict";
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const L = require("./lib.cjs");
const argv = process.argv.slice(2), DRY = argv.includes("--dry");
const partArg = argv.includes("--part") ? argv[argv.indexOf("--part") + 1] : null;
const PARTS = ["breaker", "selfheal", "closearm"];
if (!partArg || ![...PARTS, "all"].includes(partArg)) { console.error(`usage: node rollback.cjs --part ${PARTS.join("|")}|all [--dry]`); process.exit(2); }
const parts = partArg === "all" ? PARTS : [partArg];
const M = L.loadManifest(), LOG = path.join(L.PKG, "deploy-log.jsonl");
const logRow = (row) => { try { fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), et: L.etNow().hms, mt: L.mtNow().hms, script: "rollback", ...row }) + "\n"); } catch {} };
const refuse = (why) => { console.error(`REFUSED — nothing changed:\n  - ${[].concat(why).join("\n  - ")}`); logRow({ parts, result: "refused", why: [].concat(why) }); process.exit(2); };
const livePath = (f) => path.join(L.REPO, f.live);
const writeExact = (dest, buf) => { const tmp = dest + ".ops-rollback-tmp-" + process.pid; fs.writeFileSync(tmp, buf); try { fs.renameSync(tmp, dest); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; } };

const files = M.files.filter((f) => parts.includes(f.part)).reverse(), todo = [], problems = [];
for (const f of files) {
  const bp = L.backupPathFor(f.live), ls = fs.existsSync(livePath(f)) ? L.shaFile(livePath(f)) : null;
  if (ls === f.baseSha) { console.log(`already at the pre-deploy version: ${f.live}`); continue; }
  if (!fs.existsSync(bp)) { problems.push(`${f.live}: no backup at ${path.relative(L.REPO, bp)}`); continue; }
  if (L.shaFile(bp) !== f.baseSha) { problems.push(`${path.relative(L.REPO, bp)}: backup sha does not match the base — inspect it`); continue; }
  if (ls !== f.stagedSha) { problems.push(`${f.live}: live file is neither the deployed version nor the base (sha ${String(ls).slice(0, 12)}) — changed after the deploy; merge by hand`); continue; }
  todo.push(f);
}
for (const p of parts) { const all = M.files.filter((f) => f.part === p), mine = todo.filter((f) => f.part === p); if (mine.length && mine.length !== all.length) problems.push(`part ${p}: only ${mine.map((f) => f.live).join(", ")} is deployed — a part is restored as a unit; inspect by hand`); }
if (problems.length) refuse(problems);
if (!todo.length) { console.log("nothing to roll back"); logRow({ parts, result: "noop" }); process.exit(0); }
const fz = parts.flatMap((p) => todo.some((f) => f.part === p) ? L.fences(p, { forRollback: true }).map((w) => `[${p}] ${w}`) : []);
if (fz.length) refuse(fz);
for (const f of todo) console.log(`  restore ${f.live.padEnd(34)} ${f.stagedSha.slice(0, 12)} -> ${f.baseSha.slice(0, 12)} from ${path.relative(L.REPO, L.backupPathFor(f.live))}`);
if (DRY) { console.log("DRY RUN — nothing written."); logRow({ parts, result: "dry-ok" }); process.exit(0); }
const bad = [];
for (const f of todo) {
  try { writeExact(livePath(f), fs.readFileSync(L.backupPathFor(f.live))); if (L.shaFile(livePath(f)) !== f.baseSha) bad.push(`${f.live}: does not verify`); }
  catch (e) { bad.push(`${f.live}: ${e.message}`); }
  if (/\.c?js$/.test(f.live)) { const r = spawnSync(process.execPath, ["--check", livePath(f)], { encoding: "utf8", windowsHide: true }); if (r.status !== 0) bad.push(`${f.live}: node --check failed`); }
}
logRow({ parts, result: bad.length ? "rollback-problems" : "rolled-back", files: todo.map((f) => f.live), problems: bad });
if (bad.length) { console.error(`ROLLBACK PROBLEMS:\n  - ${bad.join("\n  - ")}`); process.exit(1); }
console.log(`ROLLED BACK: ${todo.map((f) => f.live).join(", ")}`);
if (todo.some((f) => f.part === "breaker")) console.log("  NOTE: the running :3001 process keeps the deployed breaker code until the operator restarts it.");
