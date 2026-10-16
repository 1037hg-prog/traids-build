#!/usr/bin/env node
/**
 * OP11 R21 SHADOW — ROLLBACK the unit from the backups deploy.cjs made.
 *   node docs/health-fixes/2026-10-05/op11-r21-shadow/rollback.cjs [--dry]
 * Per file, reverse deploy order: the backup must exist with the base sha; the live file must be EXACTLY what deploy.cjs wrote (the staged
 * sha) — anything else means it changed after the deploy and is refused (merge by hand); a live file already at the base sha is skipped.
 * Restored byte-exact (temp + rename), sha verified, node --check. The unit is restored whole or not at all.
 * Fences: the same as deploy (lib.cjs fences(): not 09:15-16:15 ET on a session day, close chain finished, no runner in progress).
 * What rollback does NOT undo: wings already posted as OP11 shadows stay shadows (the board's veto-shadow durability keeps them) and ride
 * to expiry, settled and graded as shadows; the next options-sleeve run after the rollback posts live wings again (OP4a labels its puts).
 */
"use strict";
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const L = require("./lib.cjs");
const DRY = process.argv.includes("--dry");
const LOG = path.join(L.PKG, "deploy-log.jsonl");
const logRow = (row) => { try { fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), et: L.etNow().hms, mt: L.mtNow().hms, script: "rollback", ...row }) + "\n"); } catch {} };
const refuse = (why) => { const w = [].concat(why); console.error(`REFUSED — nothing changed:\n  - ${w.join("\n  - ")}`); logRow({ result: "refused", why: w }); process.exit(2); };
const M = L.loadManifest();
const files = [...M.files].reverse(), todo = [], problems = [];
for (const f of files) {
  const bp = L.backupPathFor(f.live), ls = fs.existsSync(L.livePath(f.live)) ? L.shaFile(L.livePath(f.live)) : null;
  if (ls === f.baseSha) { console.log(`already at the pre-deploy version: ${f.live}`); continue; }
  if (!fs.existsSync(bp)) { problems.push(`${f.live}: no backup at ${path.relative(L.REPO, bp)}`); continue; }
  if (L.shaFile(bp) !== f.baseSha) { problems.push(`${path.relative(L.REPO, bp)}: backup sha is not the base — inspect it`); continue; }
  if (ls !== f.stagedSha) { problems.push(`${f.live}: live file is neither the deployed version nor the base (sha ${String(ls).slice(0, 12)}) — changed after the deploy; merge by hand`); continue; }
  todo.push(f);
}
if (!problems.length && todo.length && todo.length !== files.length) problems.push(`only ${todo.map((f) => f.live).join(", ")} is deployed — the unit is restored whole; inspect by hand`);
if (problems.length) refuse(problems);
if (!todo.length) { console.log("nothing to roll back"); logRow({ result: "noop" }); process.exit(0); }
const fz = L.fences(); if (fz.length) refuse(fz);
for (const f of todo) console.log(`  restore ${f.live.padEnd(34)} ${f.stagedSha.slice(0, 12)} -> ${f.baseSha.slice(0, 12)} from ${path.relative(L.REPO, L.backupPathFor(f.live))}`);
if (DRY) { console.log("DRY RUN — nothing written."); logRow({ result: "dry-ok" }); process.exit(0); }
const bad = [];
for (const f of todo) {
  try { L.writeExact(L.livePath(f.live), fs.readFileSync(L.backupPathFor(f.live)), "op11-rollback"); if (L.shaFile(L.livePath(f.live)) !== f.baseSha) bad.push(`${f.live}: does not verify`); }
  catch (e) { bad.push(`${f.live}: ${e.message}`); }
  const r = spawnSync(process.execPath, ["--check", L.livePath(f.live)], { encoding: "utf8", windowsHide: true }); if (r.status !== 0) bad.push(`${f.live}: node --check failed`);
}
logRow({ result: bad.length ? "rollback-problems" : "rolled-back", files: todo.map((f) => f.live), problems: bad });
if (bad.length) { console.error(`ROLLBACK PROBLEMS:\n  - ${bad.join("\n  - ")}`); process.exit(1); }
console.log(`ROLLED BACK: ${todo.map((f) => f.live).join(", ")}`);
console.log("  NOTE: wings already posted as OP11 shadows stay shadows to expiry. The next options-sleeve run posts live R21 wings again.");
