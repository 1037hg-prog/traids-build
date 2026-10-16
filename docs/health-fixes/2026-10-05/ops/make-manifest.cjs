#!/usr/bin/env node
/**
 * OPS HEALTH FIX 2026-10-05 — (re)writes manifest.json from base-shas.json (the live shas the staged copies were built from) and the
 * current staged copies. Run after any change to a staged file; deploy.cjs refuses when a staged file no longer matches its stagedSha.
 * Order inside a part is the deploy order (rollback runs it backwards).
 */
"use strict";
const fs = require("fs"), path = require("path");
const L = require("./lib.cjs");
const { writeJsonAtomic } = require(path.join(L.REPO, "backend", "lib", "atomic-write.js"));
const base = JSON.parse(fs.readFileSync(path.join(L.PKG, "base-shas.json"), "utf8"));
const FILES = [
  { part: "breaker", live: "backend/lib/risk-policy.js", note: "breaker basis + breakerEvaluate + version bump; default aggregate() unchanged" },
  { part: "breaker", live: "backend/traids-server-v2.js", note: "POST /api/board-positions breaker on signals + batch; /api/circuit-breaker live view; wouldRefuseToday reset; hits log. Live only after a :3001 restart." },
  { part: "selfheal", live: "backend/self-heal.js", note: "session guard; deployed BEFORE preflight.bat so the gate opens onto the guarded script" },
  { part: "selfheal", live: "automation/preflight.bat", note: "self-heal gated on preflight's own exit code (PFRC)" },
  { part: "closearm", live: "automation/close-arm-runner.cjs", note: "recorder backups for R272 options flow + GEX close slot after the money steps (task fires >= 15:43 ET)" },
];
const out = { package: "ops", date: "2026-10-05", builtAt: new Date().toISOString(), baseCapturedAt: base.capturedAt, files: [] };
for (const f of FILES) {
  const staged = path.posix.join("staged", f.live), sp = path.join(L.PKG, staged), lp = path.join(L.REPO, f.live);
  const baseSha = base.base[f.live]; if (!baseSha) throw new Error("no base sha for " + f.live);
  const sb = fs.readFileSync(sp), eol = L.eolOf(fs.readFileSync(lp)), seol = L.eolOf(sb);
  if (eol !== seol) throw new Error(`${f.live}: staged newline style ${seol} != live ${eol}`);
  out.files.push({ ...f, staged, baseSha, stagedSha: L.sha256(sb), eol, liveShaNow: L.shaFile(lp), liveUnchanged: L.shaFile(lp) === baseSha, backup: path.relative(L.REPO, L.backupPathFor(f.live)).replace(/\\/g, "/") });
}
writeJsonAtomic(L.MANIFEST, out);
for (const f of out.files) console.log(`${f.part.padEnd(9)} ${f.live.padEnd(34)} base ${f.baseSha.slice(0, 12)} -> staged ${f.stagedSha.slice(0, 12)} ${f.eol}${f.liveUnchanged ? "" : "   !! LIVE CHANGED SINCE STAGING"}`);
