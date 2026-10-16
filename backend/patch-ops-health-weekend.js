#!/usr/bin/env node
/**
 * 2026-09-21: ops-health judged writer and chain staleness in WALL hours, so every Monday's run (inside the chain, before the evening
 * writers) reported every daily writer ~72h stale — 17 "JUST BROKE" lines that were the weekend. A detector that fires every Monday hides
 * the Monday that is real. Age is now counted in WEEKDAY hours (Saturday and Sunday, machine-local, contribute nothing). Also: writers
 * whose chain step carries `suspended:` are skipped as quiet-on-purpose, not reported dead.
 */
const fs = require("fs"), path = require("path"); const f = path.join(__dirname, "ops-health.js"); let s = fs.readFileSync(f, "utf8");
if (s.includes("weekdayHrs")) { console.log("already patched"); process.exit(0); }
const rep = (a, b) => { if (s.split(a).length !== 2) { console.error("anchor missing/not unique:", a.slice(0, 60)); process.exit(2); } s = s.replace(a, () => b); };
const NL = String.fromCharCode(10);
rep("const hrs = (ms) => (now - ms) / 3600000;", [
  "const hrs = (ms) => (now - ms) / 3600000;",
  "// WEEKDAY hours only (2026-09-21): nothing writes on Saturday or Sunday, so those hours are not staleness. Machine-local days; stepped hourly, capped at 60 days.",
  "const weekdayHrs = (ms) => { let h = 0; for (let t = Math.max(ms, now - 60 * 86400000); t < now; t += 3600000) { const d = new Date(t).getDay(); if (d !== 0 && d !== 6) h += Math.min(1, (now - t) / 3600000); } return h; };",
  "// Writers whose chain step is suspended (the chain is read as TEXT — never require() it).",
  "const SUSPENDED_SCRIPTS = (() => { try { return fs.readFileSync(path.join(ROOT, 'automation', 'close-chain.cjs'), 'utf8').split(String.fromCharCode(10)).filter((l) => l.includes('suspended:') && l.includes('backend/')).map((l) => l.split('backend/')[1].split('.js')[0]); } catch { return []; } })();",
].join(NL));
rep("  const age = hrs(fs.statSync(D(f)).mtimeMs);" + NL + "  if (age <= STALE_FILE_H)", "  const age = weekdayHrs(fs.statSync(D(f)).mtimeMs);" + NL + "  if (age <= STALE_FILE_H)");
rep("  const cw = CONDITIONAL_WRITERS[f];" + NL, "  if (SUSPENDED_SCRIPTS.includes(f.split('.json')[0])) { writersFresh++; continue; }   // step suspended in the chain: quiet on purpose; feature-guard-scan lists the suspension" + NL + "  const cw = CONDITIONAL_WRITERS[f];" + NL);
fs.writeFileSync(f + ".tmp", s); fs.renameSync(f + ".tmp", f); console.log("ops-health.js patched");
