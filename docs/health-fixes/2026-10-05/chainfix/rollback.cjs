#!/usr/bin/env node
"use strict";
/**
 * ROLLBACK — package "chainfix". Puts every file back to its pre-package bytes:
 *   EDITED files  restored from docs/health-fixes/2026-10-05/backups/<rel with \ and / -> __>.pre-chainfix (backup sha must = baseSha)
 *   NEW files     (backend/lib/git-grep-batch.js, backend/lib/cache-save.js) removed
 * Only a file whose live sha is still the deployed (staged) sha is touched; a file already at its base is left alone; a file that
 * matches neither was changed by someone else after the deploy and is REFUSED (nothing is overwritten) unless --force.
 * Order: runners and data first, libs last (a runner that starts mid-rollback never finds its lib missing).
 *   node "docs/health-fixes/2026-10-05/chainfix/rollback.cjs" [--check] [--force]
 * Note: rows the new crypto recorder appended to data/crypto-spread-log.jsonl (venue "coinbase") stay — the log is append-only and
 * every row is venue-tagged; a reader that wants Alpaca-only filters on venue. Restarts nothing.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto"), { spawnSync } = require("child_process");
const REPO = process.env.CHAINFIX_SANDBOX_REPO || "C:\\Users\\joshc\\Downloads\\traids (2)\\traids-bundle";   // env var: packaging sandbox test only (NOTES.md)
const PKG = path.join(REPO, "docs", "health-fixes", "2026-10-05", "chainfix");
const BACKUPS = path.join(REPO, "docs", "health-fixes", "2026-10-05", "backups");
const { PACKAGE, FILES } = require(path.join(PKG, "manifest.cjs"));
const ORDER = ["backend/data/macro-calendar.json", "backend/crypto-spread-snapshot.js", "backend/ats-cache-warm.js", "backend/routine-necessity.js", "backend/lib/cache-save.js", "backend/lib/git-grep-batch.js"];
const TARGETS = ORDER.map((rel) => FILES.find((f) => f.rel === rel));
const CHECK_ONLY = process.argv.includes("--check"), FORCE = process.argv.includes("--force");
const sha = (f) => { try { return crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex"); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
const live = (t) => path.join(REPO, ...t.rel.split("/")), backup = (t) => path.join(BACKUPS, t.rel.replace(/[\\/]/g, "__") + ".pre-" + PACKAGE);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function writeExact(dst, buf) {
  const tmp = path.join(path.dirname(dst), "." + path.basename(dst) + ".rollback-" + process.pid);
  let last;
  for (let i = 0; i < 6; i++) {
    try { const fd = fs.openSync(tmp, "w"); try { fs.writeFileSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(tmp, dst); return; }
    catch (e) { last = e; if (!["EBUSY", "EPERM", "EACCES", "UNKNOWN"].includes(e.code)) break; sleepSync(250 * 2 ** i); }
  }
  try { fs.unlinkSync(tmp); } catch {}
  throw last;
}

console.log(`ROLLBACK ${PACKAGE} · ${new Date().toISOString()}${CHECK_ONLY ? " · --check" : ""}${FORCE ? " · --force" : ""}`);
const plan = [];
for (const t of TARGETS) {
  const now = sha(live(t));
  if (now === t.baseSha) { console.log(`  ${t.rel.padEnd(36)} already at base — leave`); continue; }
  if (now !== t.stagedSha && !FORCE) { console.log(`  ${t.rel.padEnd(36)} REFUSED: live ${String(now).slice(0, 12)} is neither the deployed ${t.stagedSha.slice(0, 12)} nor the base — changed after deploy; merge by hand or --force`); process.exitCode = 2; continue; }
  if (t.baseSha) {
    if (!fs.existsSync(backup(t)) || sha(backup(t)) !== t.baseSha) { console.log(`  ${t.rel.padEnd(36)} REFUSED: backup missing or not the base sha (${backup(t)})`); process.exitCode = 2; continue; }
    plan.push({ t, act: "restore" });
  } else plan.push({ t, act: "remove" });
  console.log(`  ${t.rel.padEnd(36)} will ${plan[plan.length - 1].act}`);
}
if (process.exitCode === 2) { console.error("\nROLLBACK REFUSED for the file(s) above; nothing was changed."); process.exit(2); }
if (CHECK_ONLY || !plan.length) { console.log(CHECK_ONLY ? "\n--check: nothing changed." : "\nnothing to roll back."); process.exit(0); }
for (const p of plan) {
  if (p.act === "restore") writeExact(live(p.t), fs.readFileSync(backup(p.t)));
  else fs.unlinkSync(live(p.t));
  const now = sha(live(p.t));
  if (now !== p.t.baseSha) { console.error(`  !! ${p.t.rel} is ${now} after rollback, expected ${p.t.baseSha}`); process.exitCode = 1; }
  else console.log(`  ${p.act === "restore" ? "restored" : "removed "} ${p.t.rel}`);
}
for (const p of plan) if (p.act === "restore" && /\.(c?js)$/.test(p.t.rel)) {
  const r = spawnSync(process.execPath, ["-c", live(p.t)], { encoding: "utf8", windowsHide: true });
  console.log(`  node -c ${p.t.rel.padEnd(36)} ${r.status === 0 ? "ok" : "FAIL " + (r.stderr || "").split("\n")[0]}`); if (r.status !== 0) process.exitCode = 1;
}
for (const p of plan) if (p.t.rel.endsWith(".json")) { try { JSON.parse(fs.readFileSync(live(p.t), "utf8")); console.log(`  JSON.parse ${p.t.rel} ok`); } catch (e) { console.error(`  !! ${p.t.rel} does not parse`); process.exitCode = 1; } }
try {
  const { writeJsonAtomic } = require(path.join(REPO, "backend", "lib", "atomic-write.js"));
  writeJsonAtomic(path.join(PKG, "rollback-record.json"), { package: PACKAGE, rolledBackAt: new Date().toISOString(), files: plan.map((p) => ({ rel: p.t.rel, act: p.act, liveSha: sha(live(p.t)) })) });
} catch {}
console.log(process.exitCode ? "\nROLLBACK finished WITH ERRORS — see above." : `\nROLLED BACK ${PACKAGE}: ${plan.length} file(s) at their pre-package bytes.`);
