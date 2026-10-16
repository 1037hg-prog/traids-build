#!/usr/bin/env node
/**
 * OPS HEALTH FIX 2026-10-05 — sandbox proof of deploy.cjs's per-part LATE re-check (adversarial review finding 3).
 * Builds a temp mirror of the repo in os.tmpdir(): copies of the five live files AT THEIR BASE sha (from the live tree, or from the
 * deploy backups once deployed), this package's deploy.cjs / manifest.json / staged copies, lib.cjs with fences() stubbed from env, and a
 * stub selftest.cjs (exit 0). Runs the REAL deploy.cjs --part all there. Never writes under the repo; removes the mirror afterwards.
 *   node docs/health-fixes/2026-10-05/ops/deploy-sandbox.cjs        (selftest.cjs --part deploy runs it)
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), { spawnSync } = require("child_process");
const L = require("./lib.cjs");
const M = L.loadManifest();
const STUB = `
;(() => { const calls = {};
  module.exports.fences = (part) => { calls[part] = (calls[part] || 0) + 1; const n = calls[part];
    const plan = JSON.parse(process.env.FENCE_PLAN || "{}"), mut = JSON.parse(process.env.FENCE_MUTATE || "null");
    if (mut && mut.part === part && mut.call === n) require("fs").appendFileSync(require("path").join(REPO, mut.file), "\\n:: concurrent change\\n");
    const seq = plan[part] || []; return seq[n - 1] || []; }; })();
`;
function baseCopyOf(f) {                     // the base version of a live file: the live file while undeployed, else the deploy backup
  const live = path.join(L.REPO, f.live), bp = L.backupPathFor(f.live);
  if (fs.existsSync(live) && L.shaFile(live) === f.baseSha) return live;
  if (fs.existsSync(bp) && L.shaFile(bp) === f.baseSha) return bp;
  throw new Error(`no copy of ${f.live} at its base sha (live or backup)`);
}
function mirror() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "ops-deploy-sandbox-")), pk = path.join(t, "docs", "health-fixes", "2026-10-05", "ops");
  const real = fs.realpathSync(os.tmpdir()); if (!fs.realpathSync(t).toLowerCase().startsWith(real.toLowerCase())) throw new Error("mirror outside the temp dir");
  fs.mkdirSync(pk, { recursive: true });
  for (const f of ["deploy.cjs", "manifest.json"]) fs.copyFileSync(path.join(L.PKG, f), path.join(pk, f));
  fs.writeFileSync(path.join(pk, "lib.cjs"), fs.readFileSync(path.join(L.PKG, "lib.cjs"), "utf8") + STUB);
  fs.writeFileSync(path.join(pk, "selftest.cjs"), 'console.log("PASS — sandbox stub"); process.exit(0);\n');
  fs.writeFileSync(path.join(t, "package.json"), '{"type":"commonjs"}');
  for (const f of M.files) {
    fs.mkdirSync(path.dirname(path.join(pk, f.staged)), { recursive: true }); fs.copyFileSync(path.join(L.PKG, f.staged), path.join(pk, f.staged));
    fs.mkdirSync(path.dirname(path.join(t, f.live)), { recursive: true }); fs.copyFileSync(baseCopyOf(f), path.join(t, f.live));
  }
  return { t, pk };
}
const results = [];
const ok = (n, v, d) => { results.push(!!v); console.log(`${v ? "ok  " : "FAIL"} ${n}${d ? "  — " + String(d).slice(0, 300) : ""}`); };
const state = (t) => Object.fromEntries(M.files.map((f) => { const s = L.shaFile(path.join(t, f.live)); return [f.live, s === f.stagedSha ? "staged" : s === f.baseSha ? "base" : "other"]; }));
const run = (pk, env) => spawnSync(process.execPath, [path.join(pk, "deploy.cjs"), "--part", "all"], { encoding: "utf8", env: { ...process.env, FENCE_PLAN: "", FENCE_MUTATE: "", ...env }, timeout: 180000, windowsHide: true, cwd: path.dirname(pk) });
const tmps = [];
try {
  { const { t, pk } = mirror(); tmps.push(t);
    const r = run(pk, { FENCE_PLAN: JSON.stringify({ selfheal: [[], [], ["[stub] a preflight run started meanwhile"]] }) }), s = state(t);
    let log = []; try { log = fs.readFileSync(path.join(pk, "deploy-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch {}
    ok("a fence that flips between parts: breaker deployed, selfheal refused late (exit 2), closearm not attempted", r.status === 2 && s["backend/lib/risk-policy.js"] === "staged" && s["backend/traids-server-v2.js"] === "staged" && s["backend/self-heal.js"] === "base" && s["automation/preflight.bat"] === "base" && s["automation/close-arm-runner.cjs"] === "base", `exit ${r.status} ${JSON.stringify(s)}`);
    const late = log.find((x) => x.result === "refused-late");
    ok("deploy-log: refused-late names the fence, the parts not attempted and the part deployed earlier", late && late.part === "selfheal" && /preflight run started/.test(late.why.join()) && JSON.stringify(late.notAttempted) === '["selfheal","closearm"]' && JSON.stringify(late.deployedEarlierThisRun) === '["breaker"]', JSON.stringify(late));
    ok("stderr names what was kept", /Already deployed in this run \(kept, logged\): breaker/.test(r.stderr || ""), (r.stderr || "").split("\n").slice(0, 3).join(" | ")); }
  { const { t, pk } = mirror(); tmps.push(t);
    const r = run(pk, { FENCE_MUTATE: JSON.stringify({ part: "selfheal", call: 3, file: "automation/preflight.bat" }) }), s = state(t);
    ok("preflight.bat changed by someone else between parts: not overwritten; selfheal refused (exit 2); self-heal.js untouched", r.status === 2 && s["automation/preflight.bat"] === "other" && s["backend/self-heal.js"] === "base" && s["backend/traids-server-v2.js"] === "staged" && /changed since the pre-deploy check/.test(r.stderr || ""), `exit ${r.status} ${JSON.stringify(s)}`); }
  { const { t, pk } = mirror(); tmps.push(t);
    const r = run(pk, {}), s = state(t);
    ok("every fence clear: all three parts deployed (exit 0)", r.status === 0 && Object.values(s).every((v) => v === "staged"), `exit ${r.status} ${JSON.stringify(s)} ${(r.stderr || "").slice(0, 200)}`); }
} catch (e) { ok("sandbox threw", false, e.stack || e.message); }
finally { for (const t of tmps) { try { fs.rmSync(t, { recursive: true, force: true }); } catch {} } }
const pass = results.length >= 5 && results.every(Boolean);
console.log(`deploy late re-check sandbox ${pass ? "PASS" : "FAIL"} (${results.filter(Boolean).length}/${results.length})`);
process.exit(pass ? 0 : 1);
