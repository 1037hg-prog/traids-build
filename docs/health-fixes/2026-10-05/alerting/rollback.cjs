#!/usr/bin/env node
"use strict";
/**
 * ROLLBACK — package "alerting" (health-fixes 2026-10-05). Undoes deploy.cjs:
 *   backend/preflight.js     restored from backups/backend__preflight.js.pre-alerting      (first: it is the file that requires the lib)
 *   backend/schwab-auth.js   restored from backups/backend__schwab-auth.js.pre-alerting
 *   backend/lib/preflight-checks.js   removed (it did not exist before)
 *
 *   node "docs/health-fixes/2026-10-05/alerting/rollback.cjs" --check   say what would happen, change nothing
 *   node "docs/health-fixes/2026-10-05/alerting/rollback.cjs"           roll back
 *   ... --force   also restore/remove a file that was changed AFTER the deploy (that later change is discarded — say so first)
 *
 * All-or-nothing on refusals: every file is checked before any is touched. A file whose live copy is neither the deployed bytes nor
 * the pre-deploy bytes was edited by someone else after the deploy and is refused without --force. Restores are byte-exact and atomic
 * (temp + fsync + rename) and verified by sha256; restored .js files are `node -c` checked. data/schwab-auth-meta.json, if the operator
 * re-authorised in between, is left in place: it is non-secret, and the old preflight simply does not read it.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto"), { spawnSync } = require("child_process");
const REPO = "C:\\Users\\joshc\\Downloads\\traids (2)\\traids-bundle";
const PKG = path.join(REPO, "docs", "health-fixes", "2026-10-05", "alerting");
const BACKUPS = path.join(REPO, "docs", "health-fixes", "2026-10-05", "backups");
const PACKAGE = "alerting";
// Rollback order: the dependent file first, the new dependency last.
const TARGETS = [
  { rel: "backend\\preflight.js", baseSha: "e3a8a171632d5213c3b2350b823c3f11074459395ad979d8a3a779bb6ae705d2", deployedSha: "374ebdec939cae652a5ec84b55befe027dd57d2cde2f5be0a5ffb85638168af3" },
  { rel: "backend\\schwab-auth.js", baseSha: "27f9a683ef9b24db52dce3aab8e6f84a279d477d2104e319a710d4b2da07fd1b", deployedSha: "399b9a82f0fdd49b4d8020218e013c864ea9a0ef28686ac70684626b50e1695d" },
  { rel: "backend\\lib\\preflight-checks.js", baseSha: null, deployedSha: "94cd7a1f78d019e882107b6fbb0cf654d373a9a809d4994548a9b0cec697c9c5" },
];
const CHECK_ONLY = process.argv.includes("--check"), FORCE = process.argv.includes("--force");
const sha = (f) => { try { return crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex"); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
const live = (t) => path.join(REPO, t.rel), backup = (t) => path.join(BACKUPS, t.rel.replace(/[\\/]/g, "__") + ".pre-" + PACKAGE);
function writeExact(dst, buf) {
  const tmp = path.join(path.dirname(dst), "." + path.basename(dst) + ".rollback-" + process.pid);
  const fd = fs.openSync(tmp, "w");
  try { fs.writeFileSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, dst);
}

console.log(`ROLLBACK ${PACKAGE} · ${new Date().toISOString()}${CHECK_ONLY ? " · --check (no changes)" : ""}${FORCE ? " · --force" : ""}`);
const plan = [], refused = [];
for (const t of TARGETS) {
  const cur = sha(live(t));
  if (cur === t.baseSha) { plan.push({ t, act: "skip", why: t.baseSha ? "already the pre-deploy bytes" : "already absent" }); continue; }
  if (t.baseSha && sha(backup(t)) !== t.baseSha) { refused.push(`${t.rel}: backup ${path.basename(backup(t))} is missing or does not match the recorded base`); continue; }
  if (cur !== t.deployedSha && !FORCE) { refused.push(`${t.rel}: live sha ${cur || "(absent)"} is neither the deployed nor the pre-deploy bytes — changed after the deploy; re-run with --force to discard that change`); continue; }
  plan.push({ t, act: t.baseSha ? "restore" : "remove", why: cur === t.deployedSha ? "deployed bytes" : "CHANGED AFTER DEPLOY (--force)" });
}
for (const p of plan) console.log(`  ${p.act.padEnd(8)} ${p.t.rel.padEnd(36)} ${p.why}`);
if (refused.length) { console.error("\nROLLBACK REFUSED (nothing changed):\n  " + refused.join("\n  ")); process.exit(2); }
if (CHECK_ONLY) { console.log("\n--check: nothing changed."); process.exit(0); }

let bad = 0;
for (const p of plan) {
  if (p.act === "skip") continue;
  if (p.act === "restore") { writeExact(live(p.t), fs.readFileSync(backup(p.t))); const ok = sha(live(p.t)) === p.t.baseSha; bad += ok ? 0 : 1; console.log(`  restored ${p.t.rel} ${ok ? "(verified)" : "(SHA MISMATCH)"}`); }
  else { fs.unlinkSync(live(p.t)); console.log(`  removed  ${p.t.rel}`); }
}
for (const p of plan.filter((x) => x.act === "restore")) {
  const r = spawnSync(process.execPath, ["-c", live(p.t)], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) { bad++; console.error(`  node -c FAILED ${p.t.rel}: ${(r.stderr || "").trim().split("\n")[0]}`); } else console.log(`  node -c ok  ${p.t.rel}`);
}
try {
  require(path.join(REPO, "backend", "lib", "atomic-write.js")).writeJsonAtomic(path.join(BACKUPS, `${PACKAGE}.rollback-record.json`), {
    package: PACKAGE, rolledBackAt: new Date().toISOString(), forced: FORCE, actions: plan.map((p) => ({ rel: p.t.rel, act: p.act, why: p.why })), ok: bad === 0,
  });
} catch (e) { console.warn("  (rollback record not written: " + e.message + ")"); }
console.log(bad ? `\nROLLBACK finished with ${bad} problem(s) — check the files above by hand.` : `\nROLLED BACK ${PACKAGE}. preflight picks the old code up on its next scheduled run; nothing was restarted.`);
process.exit(bad ? 1 : 0);
