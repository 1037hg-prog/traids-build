#!/usr/bin/env node
/**
 * OPS HEALTH FIX 2026-10-05 — DEPLOY, one part at a time (or --part all when every part's fence is clear at once).
 *   node docs/health-fixes/2026-10-05/ops/deploy.cjs --part breaker|selfheal|closearm|all [--dry]
 * Parts (manifest.json, deploy order inside a part):
 *   breaker   backend/lib/risk-policy.js, backend/traids-server-v2.js   — server code is live only after the operator's :3001 restart
 *   selfheal  backend/self-heal.js, then automation/preflight.bat       — the guard lands before the gate opens
 *   closearm  automation/close-arm-runner.cjs
 * What it does, in order — any failure before step 5 changes NOTHING (exit 2); step 5's late re-check refuses that part and the later
 * ones (exit 2; parts deployed earlier in the run stay deployed); a failure after its copy started rolls the part back (exit 1):
 *   1. every selected live file still has the sha the staged copy was built from (baseSha), or is already the staged sha (skipped);
 *      every staged file still has its manifest stagedSha; newline style of staged == live
 *   2. the part's fences (lib.cjs fences(): RTH / close chain for breaker; no preflight run in progress and minute 01-49 MT for selfheal;
 *      after 13:48 MT on a session day, no runner process, no live lock for closearm)
 *   3. the STAGED selftest of the part passes (selftest.cjs --part <p>)
 *   4. fences again (time passed); backups: docs/health-fixes/2026-10-05/backups/<path with \ -> __>.pre-ops (byte-exact; an existing
 *      backup must have the base sha, never overwritten with something else)
 *   5. per part, IMMEDIATELY before its copy: that part's fences and every one of its live shas (== baseSha) are checked AGAIN — with
 *      --part all an earlier part's copy + deployed selftest takes time (e.g. preflight.bat must not be replaced after the :50 fence or
 *      while a preflight run started meanwhile). A failure refuses THAT part and every later one (exit 2); earlier parts stay deployed
 *      and logged. Then copy staged -> live byte-exact (temp file + rename in the live directory), verify the sha
 *   6. node --check every deployed .js/.cjs
 *   7. the DEPLOYED selftest of the part (selftest.cjs --part <p> --deployed) — on failure the part is rolled back from the backups
 * Every run appends a row to deploy-log.jsonl in this folder. --dry runs steps 1-2 and prints the plan.
 */
"use strict";
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const L = require("./lib.cjs");
const argv = process.argv.slice(2), DRY = argv.includes("--dry");
const partArg = argv.includes("--part") ? argv[argv.indexOf("--part") + 1] : null;
const PARTS = ["breaker", "selfheal", "closearm"];
if (!partArg || ![...PARTS, "all"].includes(partArg)) { console.error(`usage: node deploy.cjs --part ${PARTS.join("|")}|all [--dry]`); process.exit(2); }
const parts = partArg === "all" ? PARTS : [partArg];
const M = L.loadManifest();
const LOG = path.join(L.PKG, "deploy-log.jsonl");
const logRow = (row) => { try { fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), et: L.etNow().hms, mt: L.mtNow().hms, script: "deploy", ...row }) + "\n"); } catch (e) { console.error("deploy-log write failed:", e.message); } };
const refuse = (why) => { console.error(`REFUSED — nothing changed:\n  - ${[].concat(why).join("\n  - ")}`); logRow({ parts, result: "refused", why: [].concat(why) }); process.exit(2); };
const livePath = (f) => path.join(L.REPO, f.live), stagedPath = (f) => path.join(L.PKG, f.staged);
const writeExact = (dest, buf) => { const tmp = dest + ".ops-deploy-tmp-" + process.pid; fs.writeFileSync(tmp, buf); try { fs.renameSync(tmp, dest); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; } };

// 1. shas
const files = M.files.filter((f) => parts.includes(f.part)), todo = [], problems = [];
for (const f of files) {
  if (!fs.existsSync(livePath(f))) { problems.push(`${f.live}: live file missing`); continue; }
  const sb = fs.readFileSync(stagedPath(f)), ls = L.shaFile(livePath(f));
  if (L.sha256(sb) !== f.stagedSha) problems.push(`${f.staged}: staged copy changed after manifest.json was written — re-run make-manifest.cjs and the selftest`);
  if (L.eolOf(sb) !== L.eolOf(fs.readFileSync(livePath(f)))) problems.push(`${f.live}: staged newline style ${L.eolOf(sb)} != live ${L.eolOf(fs.readFileSync(livePath(f)))}`);
  if (ls === f.stagedSha) { console.log(`already deployed: ${f.live}`); continue; }
  if (ls !== f.baseSha) { problems.push(`${f.live}: live file changed since staging (sha ${ls.slice(0, 12)}, staged from ${f.baseSha.slice(0, 12)}) — read the change, rebase the staged copy (patch-server.cjs --rebase / re-apply), make-manifest.cjs, selftest`); continue; }
  todo.push(f);
}
// a part is a unit: never deploy half of one (e.g. the server without the risk-policy it calls)
for (const p of parts) { const all = files.filter((f) => f.part === p), mine = todo.filter((f) => f.part === p); if (mine.length && mine.length !== all.length) problems.push(`part ${p} is half-deployed (${all.filter((f) => !mine.includes(f)).map((f) => f.live).join(", ")} already live) — inspect by hand`); }
if (problems.length) refuse(problems);
if (!todo.length) { console.log("nothing to deploy — every selected file is already the staged version"); logRow({ parts, result: "noop" }); process.exit(0); }
// 2. fences
const fenceAll = () => parts.flatMap((p) => todo.some((f) => f.part === p) ? L.fences(p).map((w) => `[${p}] ${w}`) : []);
let fz = fenceAll(); if (fz.length) refuse(fz);
console.log(`plan (${L.etNow().hms} ET / ${L.mtNow().hms} MT):`);
for (const f of todo) console.log(`  ${f.part.padEnd(9)} ${f.live.padEnd(34)} ${f.baseSha.slice(0, 12)} -> ${f.stagedSha.slice(0, 12)} (${f.eol}) · backup ${path.relative(L.REPO, L.backupPathFor(f.live))}`);
if (DRY) { console.log("DRY RUN — fences clear, nothing written. Without --dry: staged selftest, backups, copy, node -c, deployed selftest."); logRow({ parts, result: "dry-ok", files: todo.map((f) => f.live) }); process.exit(0); }
// 3. staged selftest
for (const p of parts.filter((p) => todo.some((f) => f.part === p))) {
  console.log(`staged selftest: ${p} …`);
  const r = spawnSync(process.execPath, [path.join(L.PKG, "selftest.cjs"), "--part", p], { encoding: "utf8", timeout: 900000, cwd: L.REPO, windowsHide: true });
  if (r.status !== 0) refuse([`staged selftest ${p} failed:`, ...String(r.stdout || "").split("\n").filter((l) => /^FAIL/.test(l)), String(r.stderr || "").slice(0, 300)]);
}
// 4. fences again + backups
fz = fenceAll(); if (fz.length) refuse(fz);
fs.mkdirSync(L.BACKUP_DIR, { recursive: true });
for (const f of todo) {
  const bp = L.backupPathFor(f.live);
  if (fs.existsSync(bp)) { if (L.shaFile(bp) !== f.baseSha) refuse(`${path.relative(L.REPO, bp)} exists with other content — it is never overwritten; inspect it`); }
  else { fs.copyFileSync(livePath(f), bp); if (L.shaFile(bp) !== f.baseSha) refuse(`backup of ${f.live} does not verify`); }
  if (L.shaFile(livePath(f)) !== f.baseSha) refuse(`${f.live} changed while deploying`);
}
// 5-7. copy, check, selftest — rollback the part on any failure
const restore = (list) => { const bad = []; for (const f of [...list].reverse()) { try { writeExact(livePath(f), fs.readFileSync(L.backupPathFor(f.live))); if (L.shaFile(livePath(f)) !== f.baseSha) bad.push(f.live); } catch (e) { bad.push(`${f.live} (${e.message})`); } } return bad; };
const deployedParts = [];
for (const p of parts) {
  const mine = todo.filter((f) => f.part === p); if (!mine.length) continue;
  // 5. re-check THIS part's fences and live shas right before its copy (time has passed since step 4 when an earlier part deployed)
  const late = [];
  try { late.push(...L.fences(p).map((w) => `[${p}] ${w}`)); } catch (e) { late.push(`[${p}] fences could not be evaluated (${String(e.message).slice(0, 100)})`); }
  for (const f of mine) { try { const s = L.shaFile(livePath(f)); if (s !== f.baseSha) late.push(`${f.live} changed since the pre-deploy check (sha ${s.slice(0, 12)}, expected ${f.baseSha.slice(0, 12)}) — not overwritten`); } catch (e) { late.push(`${f.live} unreadable (${e.code || e.message})`); } }
  if (late.length) {
    const rest = parts.slice(parts.indexOf(p)).filter((q) => todo.some((f) => f.part === q));
    console.error(`REFUSED part ${p}${rest.length > 1 ? ` (and the later part(s) ${rest.slice(1).join(", ")})` : ""} — nothing of it changed:\n  - ${late.join("\n  - ")}${deployedParts.length ? `\n  Already deployed in this run (kept, logged): ${deployedParts.join(", ")}` : ""}`);
    logRow({ part: p, result: "refused-late", why: late, notAttempted: rest, deployedEarlierThisRun: deployedParts });
    process.exit(2);
  }
  const done = []; let fail = null;
  try {
    for (const f of mine) { writeExact(livePath(f), fs.readFileSync(stagedPath(f))); done.push(f); if (L.shaFile(livePath(f)) !== f.stagedSha) throw new Error(`${f.live} does not verify after the copy`); console.log(`  deployed ${f.live}`); }
    for (const f of mine.filter((x) => /\.c?js$/.test(x.live))) { const r = spawnSync(process.execPath, ["--check", livePath(f)], { encoding: "utf8", windowsHide: true }); if (r.status !== 0) throw new Error(`node --check ${f.live}: ${(r.stderr || "").trim().split("\n")[0]}`); }
    console.log(`deployed selftest: ${p} …`);
    const r = spawnSync(process.execPath, [path.join(L.PKG, "selftest.cjs"), "--part", p, "--deployed"], { encoding: "utf8", timeout: 900000, cwd: L.REPO, windowsHide: true });
    if (r.status !== 0) throw new Error(`deployed selftest ${p} failed: ${String(r.stdout || "").split("\n").filter((l) => /^FAIL/.test(l)).join(" | ").slice(0, 600)} ${String(r.stderr || "").slice(0, 200)}`);
    console.log(String(r.stdout || "").trim().split("\n").pop());
  } catch (e) { fail = e.message; }
  if (fail) {
    const bad = restore(done);
    console.error(`DEPLOY FAILED (${p}): ${fail}\n  ${bad.length ? "ROLLBACK INCOMPLETE — restore by hand from the backups: " + bad.join(", ") : "rolled back: " + done.map((f) => f.live).join(", ") + " restored byte-exact from the backups"}`);
    logRow({ part: p, result: "failed", why: fail, rolledBack: !bad.length, rollbackProblems: bad, deployedEarlierThisRun: deployedParts });
    process.exit(1);
  }
  deployedParts.push(p);
  logRow({ part: p, result: "deployed", files: mine.map((f) => ({ live: f.live, from: f.baseSha, to: f.stagedSha })) });
  console.log(`PART ${p} DEPLOYED.`);
  if (p === "breaker") console.log("  NEXT: the server code is live only after the operator's :3001 restart (the /deploy skill: restart through the scheduled task, wait for health, run backend/terminal-smoke.js). risk-policy.js is read by every runner from now on (version 2026-10-05-OP10-breaker-signals).");
  if (p === "selfheal") console.log("  NEXT: the next hourly preflight runs self-heal whenever preflight is not GO; read the 'DEFER' / 'NOT NEEDED' lines in automation/preflight.log and backend/data/self-heal.json after it.");
  if (p === "closearm") console.log("  NEXT: the next 15:44 ET TRAIDS Close-Arm 1344 fire backs up the R272 options-flow and GEX close records if the 15:40 intraday fire missed them; `node automation/close-arm-runner.cjs --dry` shows today's state.");
}
