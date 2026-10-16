#!/usr/bin/env node
"use strict";
/**
 * DEPLOY — package "chainfix" (health-fixes 2026-10-05). Three close-chain steps and two recorders:
 *   backend/lib/git-grep-batch.js       NEW   BK6  one union `git grep -E` + exact attribution (lib)
 *   backend/lib/cache-save.js           NEW   BK7  writeJsonAtomic + retry on EBUSY/EPERM/EACCES/UNKNOWN + per-key merge (lib)
 *   backend/routine-necessity.js        EDIT  BK6  reader search + output history batched; failed search = UNKNOWN, exit 1
 *   backend/ats-cache-warm.js           EDIT  BK7  both cache saves through lib/cache-save.js; final-save failure exits 1
 *   backend/crypto-spread-snapshot.js   EDIT  FR-6 all symbols attempted (Alpaca, then Coinbase L1 where Alpaca has no live book); venue tag; --dry
 *   backend/data/macro-calendar.json    EDIT  FR-5 PCE 2026-10-29 / 11-25 / 12-23 from BEA + one dated note
 *
 *   node "docs/health-fixes/2026-10-05/chainfix/deploy.cjs" --check   verify hashes + run the selftest on the STAGED files; change nothing
 *   node "docs/health-fixes/2026-10-05/chainfix/deploy.cjs"           deploy
 *   --during-chain   allow a deploy while the close chain is likely running (16:10-18:30 ET weekdays); default refuses
 *
 * Refuses unless every live file still has the sha256 recorded when the package was built (baseSha; null = must not exist)
 * and every staged file still has its reviewed sha256 (stagedSha, manifest.cjs). Backs each existing live file up to
 * docs/health-fixes/2026-10-05/backups/<rel with \ and / -> __>.pre-chainfix, copies staged -> live byte-exact (temp + fsync +
 * rename in the target directory; libs first so a runner that starts mid-deploy never requires a missing lib), verifies every
 * live sha, runs `node -c` on every deployed .js and every package .cjs, parses the JSON, then runs
 * `node selftest.cjs --target=live` (stubbed network, writes only to os.tmpdir(); ~1-2 min, it includes one full
 * routine-necessity run with its output redirected). Any failure after the first copy rolls every file back and exits 1.
 * Restarts nothing, runs no runner for real, touches no broker.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto"), { spawnSync } = require("child_process");
const REPO = process.env.CHAINFIX_SANDBOX_REPO || "C:\\Users\\joshc\\Downloads\\traids (2)\\traids-bundle";   // env var: packaging sandbox test only (NOTES.md)
const PKG = path.join(REPO, "docs", "health-fixes", "2026-10-05", "chainfix");
const BACKUPS = path.join(REPO, "docs", "health-fixes", "2026-10-05", "backups");
const { PACKAGE, FILES } = require(path.join(PKG, "manifest.cjs"));
const ORDER = ["backend/lib/git-grep-batch.js", "backend/lib/cache-save.js", "backend/routine-necessity.js", "backend/ats-cache-warm.js", "backend/crypto-spread-snapshot.js", "backend/data/macro-calendar.json"];
const TARGETS = ORDER.map((rel) => { const t = FILES.find((f) => f.rel === rel); if (!t) throw new Error("manifest missing " + rel); return t; });
if (TARGETS.length !== FILES.length) throw new Error("manifest has files the deploy order does not name");
const CHECK_ONLY = process.argv.includes("--check");
const DURING_CHAIN = process.argv.includes("--during-chain");

const sha = (f) => { try { return crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex"); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
const live = (t) => path.join(REPO, ...t.rel.split("/")), staged = (t) => path.join(PKG, "staged", ...t.rel.split("/"));
const backup = (t) => path.join(BACKUPS, t.rel.replace(/[\\/]/g, "__") + ".pre-" + PACKAGE);
const crlf = (f) => fs.readFileSync(f).includes(Buffer.from("\r\n"));
const die = (msg) => { console.error("\nDEPLOY REFUSED: " + msg); process.exit(2); };
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function writeExact(dst, buf) {                                    // byte-exact, atomic in the target directory, retried on a sharing violation
  const tmp = path.join(path.dirname(dst), "." + path.basename(dst) + ".deploy-" + process.pid);
  let last;
  for (let i = 0; i < 6; i++) {
    try {
      const fd = fs.openSync(tmp, "w");
      try { fs.writeFileSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, dst);
      return;
    } catch (e) { last = e; if (!["EBUSY", "EPERM", "EACCES", "UNKNOWN"].includes(e.code)) break; sleepSync(250 * 2 ** i); }
  }
  try { fs.unlinkSync(tmp); } catch {}
  throw last;
}
const nodeCheck = (f) => { const r = spawnSync(process.execPath, ["-c", f], { encoding: "utf8", windowsHide: true }); return r.status === 0 ? null : (r.stderr || r.stdout || "node -c failed").trim().split("\n").slice(0, 4).join(" | "); };
const etNow = () => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date()).map((x) => [x.type, x.value])); return { dow: p.weekday, hm: `${p.hour === "24" ? "00" : p.hour}:${p.minute}` }; };

// ── 1. verify everything before touching anything ─────────────────────────────────────────────────────────────────────────────
console.log(`DEPLOY ${PACKAGE} · ${new Date().toISOString()}${CHECK_ONLY ? " · --check (no changes)" : ""}`);
const state = TARGETS.map((t) => ({ t, liveSha: sha(live(t)), stagedSha: sha(staged(t)) }));
for (const s of state) console.log(`  ${s.t.rel.padEnd(36)} live ${s.liveSha ? s.liveSha.slice(0, 12) : "(absent)    "}  base ${s.t.baseSha ? s.t.baseSha.slice(0, 12) : "(absent)    "}  staged ${String(s.stagedSha).slice(0, 12)}`);
for (const s of state) if (s.stagedSha !== s.t.stagedSha) die(`${s.t.rel}: the staged file changed after review (sha ${s.stagedSha} != ${s.t.stagedSha}). Re-review and re-pin.`);
if (state.every((s) => s.liveSha === s.t.stagedSha)) { console.log("\nalready deployed — every live file already matches its staged copy. Nothing to do."); process.exit(0); }
for (const s of state) if (s.liveSha !== s.t.baseSha) die(`${s.t.rel}: live sha ${s.liveSha || "(absent)"} != recorded base ${s.t.baseSha || "(absent)"} — the live file changed since this package was built (or a partial deploy). Merge first; nothing was changed.`);
for (const s of state) if (s.t.baseSha && crlf(live(s.t)) !== crlf(staged(s.t))) die(`${s.t.rel}: newline style differs between live and staged.`);
for (const s of state) if (!s.t.baseSha && crlf(staged(s.t))) die(`${s.t.rel}: a new backend file must be LF like its neighbours.`);
for (const s of state) if (s.t.baseSha && fs.existsSync(backup(s.t)) && sha(backup(s.t)) !== s.t.baseSha) die(`${path.basename(backup(s.t))} already exists with different content — refusing to overwrite an earlier backup.`);
console.log("\n  hashes verified: live = recorded base, staged = reviewed.");
if (CHECK_ONLY) {
  console.log("  --check: running the selftest against the STAGED files (nothing in the repo is changed)…\n");
  const r = spawnSync(process.execPath, [path.join(PKG, "selftest.cjs"), "--target=staged"], { stdio: "inherit", windowsHide: true, timeout: 20 * 60000 });
  process.exit(r.status === 0 ? 0 : 1);
}
const { dow, hm } = etNow();
if (!DURING_CHAIN && !["Sat", "Sun"].includes(dow) && hm >= "16:10" && hm <= "18:30")
  die(`it is ${dow} ${hm} ET — the close chain (16:15 ET) is probably running, and three of these files are its steps. Deploy before 16:10 or after it finishes, or pass --during-chain.`);

// ── 2. back up, copy (libs first) ───────────────────────────────────────────────────────────────────────────────────────────────
fs.mkdirSync(BACKUPS, { recursive: true });
for (const s of state) if (s.t.baseSha && !fs.existsSync(backup(s.t))) { writeExact(backup(s.t), fs.readFileSync(live(s.t))); if (sha(backup(s.t)) !== s.t.baseSha) die("backup verify failed for " + s.t.rel); }
console.log("  backups written: " + state.filter((s) => s.t.baseSha).map((s) => path.basename(backup(s.t))).join(", "));
const done = [];
function rollbackAll(reason) {
  console.error(`\nROLLING BACK (${reason})`);
  for (const s of done.slice().reverse()) {
    try {
      if (s.t.baseSha) { writeExact(live(s.t), fs.readFileSync(backup(s.t))); console.error(`  restored ${s.t.rel} -> ${String(sha(live(s.t))).slice(0, 12)}`); }
      else { fs.unlinkSync(live(s.t)); console.error(`  removed new ${s.t.rel}`); }
    } catch (e) { console.error(`  !! could not roll back ${s.t.rel}: ${e.message} — run rollback.cjs`); }
  }
  process.exit(1);
}
try {
  for (const s of state) { writeExact(live(s.t), fs.readFileSync(staged(s.t))); done.push(s); console.log(`  copied ${s.t.rel}`); }
} catch (e) { rollbackAll("copy failed: " + e.message); }

// ── 3. verify: shas, node -c, JSON parse ───────────────────────────────────────────────────────────────────────────────────────
for (const s of state) if (sha(live(s.t)) !== s.t.stagedSha) rollbackAll(`${s.t.rel}: live sha after copy is not the staged sha`);
const syntax = [];
for (const s of state) if (/\.(c?js)$/.test(s.t.rel)) syntax.push([s.t.rel, nodeCheck(live(s.t))]);
for (const f of fs.readdirSync(PKG).filter((f) => f.endsWith(".cjs"))) syntax.push([f, nodeCheck(path.join(PKG, f))]);
for (const [f, err] of syntax) console.log(`  node -c ${f.padEnd(36)} ${err ? "FAIL " + err : "ok"}`);
if (syntax.some(([, e]) => e)) rollbackAll("node -c failed");
for (const s of state) if (s.t.rel.endsWith(".json")) { try { JSON.parse(fs.readFileSync(live(s.t), "utf8")); console.log(`  JSON.parse ${s.t.rel} ok`); } catch (e) { rollbackAll(`${s.t.rel} does not parse: ${e.message}`); } }

// ── 4. selftest against the live files ─────────────────────────────────────────────────────────────────────────────────────────
console.log("\n  selftest --target=live …\n");
const st = spawnSync(process.execPath, [path.join(PKG, "selftest.cjs"), "--target=live"], { stdio: "inherit", windowsHide: true, timeout: 20 * 60000 });
if (st.status !== 0) rollbackAll(`selftest exit ${st.status}${st.error ? " " + st.error.message : ""}`);

// ── 5. record ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
try {
  const { writeJsonAtomic } = require(path.join(REPO, "backend", "lib", "atomic-write.js"));
  writeJsonAtomic(path.join(PKG, "deploy-record.json"), { package: PACKAGE, deployedAt: new Date().toISOString(), files: state.map((s) => ({ rel: s.t.rel, baseSha: s.t.baseSha, liveSha: sha(live(s.t)), backup: s.t.baseSha ? backup(s.t) : null })), selftest: "PASS (target=live)" });
} catch (e) { console.log("  (deploy record not written: " + e.message + ")"); }
console.log(`\nDEPLOYED ${PACKAGE}: ${state.length} files live, selftest PASS. Rollback: node "${path.join(PKG, "rollback.cjs")}"`);
console.log("Takes effect: routine-necessity next Friday chain; ats-cache-warm + event watch tonight's chain; crypto-spread-snapshot next hourly board-discipline run. Nothing to restart.");
