#!/usr/bin/env node
/**
 * R36 — has the registered contract (rule, hypothesis, bar, evidenceStart, priorSample) moved since it first appeared in git?
 * Read-only; writes only r36-contract-history.json beside itself. Walks every committed version of backend/data/test-registry.json.
 *
 *   node docs/reads/2026-10-11/R36/r36-contract-history.cjs
 */
const { execFileSync } = require("child_process");
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const ROOT = path.join(__dirname, "..", "..", "..", "..");
const git = (args) => execFileSync("git", args, { cwd: ROOT, maxBuffer: 1 << 30 }).toString();
const fp = (v) => crypto.createHash("sha256").update(JSON.stringify(v === undefined ? null : v)).digest("hex").slice(0, 16);
const FIELDS = ["registered", "evidenceStart", "rule", "hypothesis", "bar", "priorSample", "knownWeaknesses", "amendments", "multiplicityFamily", "status", "read"];
const pick = (reg) => { for (const k of Object.keys(reg)) if (Array.isArray(reg[k])) { const e = reg[k].find((x) => x && x.id === "R36"); if (e) return { array: k, e }; } return null; };
const commits = git(["log", "--format=%h|%ad|%s", "--date=iso-strict", "--", "backend/data/test-registry.json"]).trim().split("\n").map((l) => { const [h, d, s] = l.split("|"); return { h, d, s }; }).reverse();
const rows = [];
for (const c of commits) {
  let reg; try { reg = JSON.parse(git(["show", `${c.h}:backend/data/test-registry.json`])); } catch { continue; }
  const p = pick(reg); if (!p) continue;
  rows.push({ commit: c.h, committed: c.d, array: p.array, fp: Object.fromEntries(FIELDS.map((f) => [f, p.e[f] === undefined ? null : fp(p.e[f])])), keys: Object.keys(p.e).sort().join(",") });
}
const now = pick(JSON.parse(fs.readFileSync(path.join(ROOT, "backend", "data", "test-registry.json"), "utf8")));
rows.push({ commit: "WORKTREE", committed: null, array: now.array, fp: Object.fromEntries(FIELDS.map((f) => [f, now.e[f] === undefined ? null : fp(now.e[f])])), keys: Object.keys(now.e).sort().join(",") });
const changes = [];
for (let i = 1; i < rows.length; i++) for (const f of FIELDS) if (rows[i].fp[f] !== rows[i - 1].fp[f]) changes.push({ field: f, from: rows[i - 1].commit, to: rows[i].commit, committed: rows[i].committed });
const CONTRACT = ["registered", "evidenceStart", "rule", "hypothesis", "bar", "priorSample"];
const out = {
  spec: "r36-contract-history", madeAt: new Date().toISOString(),
  versionsWithR36: rows.length, firstSeen: rows[0] && { commit: rows[0].commit, committed: rows[0].committed, array: rows[0].array },
  contractFields: CONTRACT, contractEverChanged: changes.some((c) => CONTRACT.includes(c.field)),
  changes, firstFingerprints: rows[0] && rows[0].fp, nowFingerprints: rows[rows.length - 1].fp,
};
fs.writeFileSync(path.join(__dirname, "r36-contract-history.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
