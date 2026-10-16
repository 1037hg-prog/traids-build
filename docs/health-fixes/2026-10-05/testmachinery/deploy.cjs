#!/usr/bin/env node
"use strict";
/**
 * deploy.cjs — package "testmachinery" (health-fixes 2026-10-05): FT-5 test-triage, FT-3 adjudicator, FT-1 R22 grader, FT-6 R147 control.
 *
 *   node deploy.cjs --only=backend/test-triage.js,backend/adjudicator.js
 *                                      the two REPORT-ONLY files (labels, not measurement) — deployable once the chain is idle
 *   node deploy.cjs                    all four files — REFUSED until the R22 amendment and the R147 note are recorded (below)
 *   node deploy.cjs --dry-run          run every check, copy nothing
 *   --force-after-chain                override a NOT_FINISHED / UNKNOWN chain verdict after confirming the chain is not running;
 *                                      never overrides RUNNING (a visible chain process, a fresh unfinished cycle in the log, or the
 *                                      15:45-16:20 ET start window)
 *
 * Refusals, all checked before anything is copied:
 *   CHAIN     tools/chain-guard.cjs (round 2): the first version read only chain-status.json, which the chain writes once at its END,
 *             so it could never see a running chain. The guard now reads automation/daily-run.log (a CLOSE / CLOSE CHAIN start marker
 *             after the last "written: chain-status.json" line = running), a read-only process query, and the clock (trading day,
 *             15:45 ET until chain-status.json.finished is dated today).
 *   REGISTRY  backend/sector-momentum.js (R22) and backend/r147-earnings-momentum.js (R147) change how a REGISTERED test measures.
 *             Each is refused unless backend/data/test-registry.json (read-only) already records its dated entry:
 *               R22   an `amendments[]` item dated 2026-10-05 from this package (source "...testmachinery... (FT-1)", or a kind naming
 *                     the delisted/acquired grading rule)
 *               R147  an object anywhere in the entry dated 2026-10-05 with field "controls.leakTest.method" (or source "...(FT-6)")
 *             The JSON to record is in NOTES.md / evidence/proposed-registry-entries.json. This makes the house invariant a check,
 *             not prose.
 *   BASE      a live file whose sha256 is not the baseSha recorded when the package was built (someone changed it — merge first).
 *   STAGED    a staged file whose sha256 is not the stagedSha recorded in base-shas.json (edited after review), that fails
 *             `node -c`, or that changes the newline style / BOM.
 * Then: backs each live file up to docs/health-fixes/2026-10-05/backups/<relative path, \ and / -> __>.pre-testmachinery, copies
 * staged -> live byte-exact, verifies the sha256, runs `node -c`, and runs `node selftest.cjs --live` (or the staged-for-undeployed
 * mode after a partial deploy). If the selftest fails, every file this run copied is restored and the exit code is 1 (fail closed).
 * It never restarts or signals anything; none of these files is loaded by the :3001 server — each runs as a close-chain step.
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
const style = (buf) => ({ crlf: buf.includes(Buffer.from("\r\n")), bom: buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf });
const backupPath = (rel) => path.join(BACKUPS, rel.replace(/[\\/]/g, "__") + ".pre-" + PACKAGE);
const log = (o) => { try { fs.appendFileSync(path.join(PKG, "deploy-log.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n"); } catch {} };
const die = (msg) => { console.error("DEPLOY REFUSED — " + msg); log({ action: "deploy-refused", msg, dry: DRY }); process.exit(2); };

for (const rel of SELECTED) if (!BASE.files[rel]) die(`${rel} is not a target of this package (${ALL.join(", ")})`);

// ── CHAIN: never copy under a running (or due, or unknown-state) close chain ──
{ const g = guard.check(REPO, { force: FORCE });
  for (const i of g.info) console.log(`  chain guard: ${i}`);
  if (!g.ok) die(`close chain ${g.verdict}: ${g.reasons.join(" · ")}${g.overridable ? " — if you have confirmed the chain is not running, re-run with --force-after-chain" : " — not overridable; deploy after the chain has finished"}`);
  if (g.forced) { console.log(`  chain guard ${g.verdict} OVERRIDDEN by --force-after-chain: ${g.reasons.join(" · ")}`); log({ action: "chain-guard-overridden", verdict: g.verdict, reasons: g.reasons, dry: DRY }); }
  else console.log(`  chain guard: IDLE (ET ${g.facts.etDate} ${g.facts.etHM}; last chain finished ${g.facts.chainStatus && g.facts.chainStatus.finished})`); }

// ── REGISTRY: a measurement change ships only after its dated registry entry is recorded ──
const MEASUREMENT = {
  "backend/sector-momentum.js": { test: "R22", what: "the R22 dated amendment (cash-out / stale-at-pick grading rule) in R22.amendments[]",
    recorded: (t) => Array.isArray(t.amendments) && t.amendments.some((a) => a && /^2026-10-05/.test(String(a.date || "")) && (/testmachinery[\s\S]*FT-1/.test(String(a.source || "")) || /delist|acquired|cash(ed)?[- ]out/i.test(String(a.kind || "") + " " + String(a.becomes || "")))) },
  "backend/r147-earnings-momentum.js": { test: "R147", what: "the R147 control-procedure note (controls.leakTest.method, per-symbol seeded stream)",
    recorded: (t) => { const hit = (o) => o && typeof o === "object" && (Array.isArray(o) ? o.some(hit) : ((/^2026-10-05/.test(String(o.date || "")) && (o.field === "controls.leakTest.method" || /testmachinery[\s\S]*FT-6/.test(String(o.source || "")))) || Object.values(o).some(hit))); return hit(t); } },
};
{ const needs = SELECTED.filter((rel) => MEASUREMENT[rel]);
  if (needs.length) {
    let reg = null; try { reg = JSON.parse(fs.readFileSync(path.join(REPO, "backend", "data", "test-registry.json"), "utf8")); } catch (e) { die(`backend/data/test-registry.json could not be read (${e.message}) — cannot confirm the registry entries the measurement files require (UNKNOWN refuses)`); }
    const all = [].concat(...Object.values(reg).filter(Array.isArray));
    const missing = needs.filter((rel) => { const m = MEASUREMENT[rel]; const t = all.find((x) => x && String(x.id) === m.test); return !t || !m.recorded(t); });
    if (missing.length) die(`${missing.map((rel) => `${rel} changes how ${MEASUREMENT[rel].test} measures and the registry does not yet record ${MEASUREMENT[rel].what}`).join("; ")}. Record the JSON from NOTES.md (FT-1 / FT-6) first, or deploy only the report-only files: node "${path.join(PKG, "deploy.cjs")}" --only=backend/test-triage.js,backend/adjudicator.js`);
    for (const rel of needs) console.log(`  registry: ${MEASUREMENT[rel].test} records ${MEASUREMENT[rel].what} — ok`);
  } }

// ── checks: every target, before anything is copied ──
const plan = [];
for (const rel of SELECTED) {
  const live = path.join(REPO, rel), staged = path.join(PKG, "staged", rel), base = BASE.files[rel];
  if (!fs.existsSync(staged)) die(`staged copy missing: ${staged}`);
  if (!fs.existsSync(live)) die(`live file missing: ${live}`);
  const liveSha = sha(live), stagedSha = sha(staged);
  if (base.stagedSha && stagedSha !== base.stagedSha) die(`${rel}: staged sha256 ${stagedSha.slice(0, 12)} != the reviewed stagedSha ${base.stagedSha.slice(0, 12)} in base-shas.json — the staged copy changed after review`);
  if (liveSha === stagedSha) { console.log(`  = ${rel} already deployed (live sha == staged sha) — skipped`); continue; }
  if (liveSha !== base.baseSha) die(`${rel}: live sha256 ${liveSha.slice(0, 12)} != baseSha ${base.baseSha.slice(0, 12)} — the live file changed after this package was built; merge the change into the staged copy and re-record the baseSha`);
  const ls = style(fs.readFileSync(live)), ss = style(fs.readFileSync(staged));
  if (ls.crlf !== ss.crlf || ls.bom !== ss.bom) die(`${rel}: newline/BOM style differs (live crlf ${ls.crlf} bom ${ls.bom}; staged crlf ${ss.crlf} bom ${ss.bom})`);
  const c = spawnSync(process.execPath, ["-c", staged], { encoding: "utf8" });
  if (c.status !== 0) die(`${rel}: staged copy fails node -c: ${c.stderr.trim().slice(0, 300)}`);
  const bp = backupPath(rel);
  if (fs.existsSync(bp) && sha(bp) !== base.baseSha) die(`${rel}: a backup already exists at ${bp} and is not the baseSha version — inspect it before deploying`);
  plan.push({ rel, live, staged, liveSha, stagedSha, bp });
}
if (!plan.length) { console.log("nothing to deploy"); process.exit(0); }
console.log(`${DRY ? "DRY RUN — " : ""}deploying ${plan.length} file(s): ${plan.map((p) => p.rel).join(", ")}`);
if (DRY) { log({ action: "deploy-dry-run", files: plan.map((p) => p.rel) }); console.log("dry run: all checks passed; nothing copied"); process.exit(0); }

// ── backup, copy, verify ──
fs.mkdirSync(BACKUPS, { recursive: true });
const done = [];
const restore = (why) => {
  for (const p of done.reverse()) { try { fs.copyFileSync(p.bp, p.live); console.error(`  restored ${p.rel} from backup (${sha(p.live) === p.liveSha ? "sha ok" : "SHA MISMATCH"})`); } catch (e) { console.error(`  RESTORE FAILED for ${p.rel}: ${e.message} — copy ${p.bp} over ${p.live} by hand`); } }
  log({ action: "deploy-rolled-back", why, files: done.map((p) => p.rel) });
};
try {
  for (const p of plan) {
    if (!fs.existsSync(p.bp)) fs.copyFileSync(p.live, p.bp);
    if (sha(p.bp) !== p.liveSha) throw new Error(`${p.rel}: backup sha mismatch`);
    fs.copyFileSync(p.staged, p.live);
    done.push(p);
    if (sha(p.live) !== p.stagedSha) throw new Error(`${p.rel}: live sha after copy != staged sha`);
    const c = spawnSync(process.execPath, ["-c", p.live], { encoding: "utf8" });
    if (c.status !== 0) throw new Error(`${p.rel}: node -c failed after copy: ${c.stderr.trim().slice(0, 200)}`);
    console.log(`  + ${p.rel}  ${p.liveSha.slice(0, 12)} -> ${p.stagedSha.slice(0, 12)}  (backup ${path.basename(p.bp)})`);
  }
} catch (e) { console.error("DEPLOY FAILED — " + e.message); restore(e.message); process.exit(1); }

// ── package selftest on the live files ──
const deployedAll = ALL.every((rel) => { try { return sha(path.join(REPO, rel)) === sha(path.join(PKG, "staged", rel)); } catch { return false; } });
const st = spawnSync(process.execPath, [path.join(PKG, "selftest.cjs"), deployedAll ? "--live" : "--staged-for-undeployed"], { encoding: "utf8", stdio: "inherit", timeout: 20 * 60e3 });
if (!deployedAll) console.log("  (partial deploy: the selftest checked the staged versions of every file, which now include the deployed ones byte-for-byte)");
if (st.status !== 0) { console.error("SELFTEST FAILED after deploy — restoring every file this run copied"); restore("selftest failed"); process.exit(1); }
log({ action: "deployed", forcedAfterChain: FORCE || undefined, files: plan.map((p) => ({ rel: p.rel, from: p.liveSha, to: p.stagedSha, backup: p.bp })) });
console.log(`DEPLOYED ${plan.length} file(s); selftest PASS. Rollback: node "${path.join(PKG, "rollback.cjs")}"${onlyArg ? " --only=" + onlyArg : ""}`);
