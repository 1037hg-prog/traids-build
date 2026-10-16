#!/usr/bin/env node
"use strict";
/**
 * rollback.cjs — package "testmachinery" (health-fixes 2026-10-05).
 *
 *   node rollback.cjs                  restore all four files from docs/health-fixes/2026-10-05/backups/*.pre-testmachinery
 *   node rollback.cjs --only=backend/sector-momentum.js
 *   node rollback.cjs --dry-run
 *   --force-after-chain                override a NOT_FINISHED / UNKNOWN chain verdict (never RUNNING) — see tools/chain-guard.cjs
 *
 * Refuses a file whose live sha256 is neither the deployed (staged) version nor the base version — someone changed it after the
 * deploy, and restoring would silently discard that change. A file already at its baseSha is skipped. Each restore is verified
 * against the recorded baseSha and `node -c`. Refuses while the close chain is running, due or in an unknown state (the same
 * tools/chain-guard.cjs deploy.cjs uses: daily-run.log markers, a read-only process query, the clock — chain-status.json alone
 * cannot see a running chain because the chain writes it only at its end). Restarts and signals nothing.
 *
 * REGISTRY NOTE: rolling back backend/sector-momentum.js or backend/r147-earnings-momentum.js after the R22 amendment / R147 note
 * was recorded leaves the registry describing a rule the code no longer applies. This script says so and names the counter-note to
 * record; it never edits the registry.
 *
 * DATA NOTE (not undone by this script): after a deploy, tonight's chain may have written data in the new shapes — sector-momentum.json
 * picks carry `cashedOut` / `staleAtPick` / `endedGrades` stamps and graded rows count cashed-out names; r147-controls.json is spec
 * v2 with a `reproducibility` block; test-triage.json is spec v2 with `writers` / `decidedBy` / `wiring`; adjudicator.json rows may
 * carry `noReader`. The old code reads all of them without error (it ignores the extra fields), so a code rollback needs no data
 * rollback; R22's old grader simply stops counting the cashed-out sessions again.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto"), { spawnSync } = require("child_process");
const REPO = "C:\\Users\\joshc\\Downloads\\traids (2)\\traids-bundle";
const PKG = path.join(REPO, "docs", "health-fixes", "2026-10-05", "testmachinery");
const BACKUPS = path.join(REPO, "docs", "health-fixes", "2026-10-05", "backups");
const PACKAGE = "testmachinery";
const BASE = JSON.parse(fs.readFileSync(path.join(PKG, "base-shas.json"), "utf8"));
const guard = require(path.join(PKG, "tools", "chain-guard.cjs"));
const DRY = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force-after-chain");
const onlyArg = (process.argv.find((a) => a.startsWith("--only=")) || "").slice("--only=".length);
const ALL = Object.keys(BASE.files);
const SELECTED = onlyArg ? onlyArg.split(",").map((s) => s.trim().replace(/\\/g, "/")).filter(Boolean) : ALL;
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const backupPath = (rel) => path.join(BACKUPS, rel.replace(/[\\/]/g, "__") + ".pre-" + PACKAGE);
const log = (o) => { try { fs.appendFileSync(path.join(PKG, "deploy-log.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n"); } catch {} };
const die = (msg) => { console.error("ROLLBACK REFUSED — " + msg); log({ action: "rollback-refused", msg, dry: DRY }); process.exit(2); };

for (const rel of SELECTED) if (!BASE.files[rel]) die(`${rel} is not a target of this package`);
{ const g = guard.check(REPO, { force: FORCE });
  for (const i of g.info) console.log(`  chain guard: ${i}`);
  if (!g.ok) die(`close chain ${g.verdict}: ${g.reasons.join(" · ")}${g.overridable ? " — if you have confirmed the chain is not running, re-run with --force-after-chain" : " — not overridable; roll back after the chain has finished"}`);
  if (g.forced) { console.log(`  chain guard ${g.verdict} OVERRIDDEN by --force-after-chain: ${g.reasons.join(" · ")}`); log({ action: "chain-guard-overridden", verdict: g.verdict, reasons: g.reasons, dry: DRY, by: "rollback" }); } }

const plan = [];
for (const rel of SELECTED) {
  const live = path.join(REPO, rel), staged = path.join(PKG, "staged", rel), bp = backupPath(rel), base = BASE.files[rel].baseSha;
  const liveSha = sha(live);
  if (liveSha === base) { console.log(`  = ${rel} already at its base version — skipped`); continue; }
  if (!fs.existsSync(bp)) die(`${rel}: no backup at ${bp}`);
  if (sha(bp) !== base) die(`${rel}: backup sha ${sha(bp).slice(0, 12)} != recorded baseSha ${base.slice(0, 12)}`);
  if (liveSha !== sha(staged)) die(`${rel}: live sha ${liveSha.slice(0, 12)} is neither the deployed version nor the base — it was edited after the deploy; restoring would discard that edit`);
  plan.push({ rel, live, bp, base, liveSha });
}
if (!plan.length) { console.log("nothing to roll back"); process.exit(0); }
console.log(`${DRY ? "DRY RUN — " : ""}rolling back ${plan.length} file(s): ${plan.map((p) => p.rel).join(", ")}`);
const COUNTER = { "backend/sector-momentum.js": "R22 — the 2026-10-05 grading amendment is no longer applied by the code (record a dated note, or roll forward again)",
  "backend/r147-earnings-momentum.js": "R147 — the 2026-10-05 per-symbol seeded leak control is no longer applied; the old controls are order-dependent (record a dated note before any read)" };
for (const p of plan) if (COUNTER[p.rel]) console.log(`  REGISTRY: ${COUNTER[p.rel]}`);
if (DRY) { log({ action: "rollback-dry-run", files: plan.map((p) => p.rel) }); process.exit(0); }
let bad = 0;
for (const p of plan) {
  fs.copyFileSync(p.bp, p.live);
  const ok = sha(p.live) === p.base && spawnSync(process.execPath, ["-c", p.live], { encoding: "utf8" }).status === 0;
  if (!ok) bad++;
  console.log(`  ${ok ? "-" : "!"} ${p.rel} restored to ${p.base.slice(0, 12)}${ok ? "" : " — VERIFY FAILED"}`);
}
log({ action: bad ? "rollback-incomplete" : "rolled-back", forcedAfterChain: FORCE || undefined, files: plan.map((p) => p.rel) });
if (bad) { console.error(`ROLLBACK INCOMPLETE — ${bad} file(s) failed verification`); process.exit(1); }
console.log("ROLLED BACK.");
