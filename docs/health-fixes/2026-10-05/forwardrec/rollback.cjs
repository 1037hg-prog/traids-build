#!/usr/bin/env node
/**
 * forwardrec — ROLLBACK.
 *
 *   node rollback.cjs --dry     show what would be restored
 *   node rollback.cjs           restore every target that is still exactly this package's staged version
 *   node rollback.cjs --force   also restore a target that changed AFTER this deploy (overwrites that later change — only on purpose)
 *
 * Per target: live == stagedSha -> restore the backup (../backups/<rel, / -> __>.pre-forwardrec, which must hash to baseSha) or, for a
 * file this package created, delete it; live == baseSha (or a new file absent) -> already rolled back; anything else -> refused (someone
 * changed it after the deploy) unless --force. Restored files are re-hashed and node -c checked. Result: rollback-result.json.
 *
 * NOT undone (data, deliberately): catch-up / gap rows already written to data/r191-crypto-trend.json and data/r231-crypto-vote-sized.json,
 * data/r236-universe-bars.json and data/r236-tv-months.json. The pre-fix runners read the first two as before (one extra row per day) and
 * ignore the last two. Restore them from the nightly backup only if the operator wants the evidence itself rewound.
 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto"), { spawnSync } = require("child_process");
const ROOT = process.env.FORWARDREC_ROOT || "C:/Users/joshc/Downloads/traids (2)/traids-bundle", PKG = __dirname, NAME = "forwardrec";   // FORWARDREC_ROOT: a mock repo, for testing this script only
const BACKUPS = path.join(ROOT, "docs", "health-fixes", "2026-10-05", "backups");
const DRY = process.argv.includes("--dry"), FORCE = process.argv.includes("--force");
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const backupOf = (rel) => path.join(BACKUPS, rel.replace(/[\\/]/g, "__") + ".pre-" + NAME);
const man = JSON.parse(fs.readFileSync(path.join(PKG, "manifest.json"), "utf8"));
const out = []; let bad = 0;
for (const f of man.files) {
  const live = path.join(ROOT, f.rel), exists = fs.existsSync(live), now = exists ? sha(live) : null;
  let action;
  if (f.baseSha === null) action = !exists ? "absent (ok)" : now === f.stagedSha || FORCE ? "delete" : "REFUSED (changed after deploy)";
  else if (now === f.baseSha) action = "already base (ok)";
  else if (now === f.stagedSha || FORCE) action = fs.existsSync(backupOf(f.rel)) && sha(backupOf(f.rel)) === f.baseSha ? "restore" : "REFUSED (backup missing or not the base)";
  else action = "REFUSED (changed after deploy)";
  if (!DRY && action === "delete") fs.unlinkSync(live);
  if (!DRY && action === "restore") fs.copyFileSync(backupOf(f.rel), live);
  let verified = null;
  if (!DRY && (action === "delete" || action === "restore")) {
    verified = action === "delete" ? !fs.existsSync(live) : sha(live) === f.baseSha && spawnSync(process.execPath, ["-c", live]).status === 0;
    if (!verified) bad++;
  }
  if (/^REFUSED/.test(action)) bad++;
  out.push({ rel: f.rel, action, verified }); console.log(`${action.padEnd(36)} ${f.rel}${verified === false ? "  VERIFY FAILED" : ""}`);
}
fs.writeFileSync(path.join(process.env.FORWARDREC_ROOT || PKG, DRY ? "rollback-dry.json" : "rollback-result.json"), JSON.stringify({ package: NAME, at: new Date().toISOString(), dry: DRY, force: FORCE, ok: !bad, files: out }, null, 1) + "\n");
console.log(bad ? `rollback: ${bad} target(s) need attention` : `rollback${DRY ? " (dry)" : ""}: ok`);
process.exit(bad ? 1 : 0);
