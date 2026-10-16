#!/usr/bin/env node
/**
 * SELFTEST — every check of the W6 package (agents on any model), OFFLINE: no ssh, no network, no model; temp folders, a fake VPS and
 * fake provider executables only. 2026-10-11 (docs/server/wave6-agents).
 *   node docs/server/wave6-agents/selftest.cjs               the table, the generators (units, manifests), the jobs file's own check,
 *                                                         every module's --selftest — the adapter, the job runner and the orchestrator
 *                                                         outside this folder included, because this package ships or documents them —
 *                                                         the parse check, then proof that the repo was not touched (the sha256 of the
 *                                                         live files and data the package could reach is the same after as before)
 *   node docs/server/wave6-agents/selftest.cjs --parse-only  node --check of every .cjs / .js file in the package and JSON.parse of every .json
 * The last line says "ALL ..." only when everything passed (failure output is printed with that word lower-cased). Both forms of the
 * last line carry the case total, ok and failed together — "SELFTEST: n of m checks FAILED (k selftest cases)" on a red run — so the
 * build loop can tell a suite that was cut from one that was fixed; the two forms have their own row here ("last line").
 * The older, Claude-only draft that also sits in this folder (deploy-server/w6-claude.cjs, w6-workspace.cjs, server/, test/) is parsed
 * here and nothing more: this package does not install it. deploy-server/w6-ipscreen.cjs is reused, and its own selftest is run.
 */
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
const H = __dirname, REPO = path.resolve(H, "..", "..", "..");
const quiet = (s) => String(s).replace(/ALL/g, "all");   // only the final success line may carry the word the checker looks for
/** what one run printed: its ok lines and its failure lines */
const tally = (out) => ({ okLines: (String(out).match(/^\s*ok\b/gm) || []).length, failLines: (String(out).match(/^\s+FAIL\b|^DIFF\b|^PROBLEM\b/gm) || []).length });
/** the case total. A failing case is still a case: a red run and the green run after it give the same total unless a case was removed */
const caseTotal = (tallies) => tallies.reduce((n, t) => n + t.okLines + t.failLines, 0);
/** the last line. The case total stands on BOTH forms, so a red run gives the build loop (automation/orchestrate.cjs, stop rule 3: tests
 *  shrank) a count to hold the next run against — a suite cut between a red run and the first green one is then seen. */
const lastLine = (bad, checks, cases) => (bad ? `SELFTEST: ${bad} of ${checks} checks FAILED (${cases} selftest cases)` : `ALL ${checks} CHECKS PASSED (${cases} selftest cases)`);

function packageFiles(dir = H) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) { if (e.name !== "node_modules") out.push(...packageFiles(f)); } else out.push(f); }
  return out.sort();
}
function parseCheck() {
  const files = packageFiles(), bad = []; let n = 0;
  for (const f of files) {
    if (/\.(cjs|js)$/.test(f)) { n++; const r = cp.spawnSync(process.execPath, ["--check", f], { encoding: "utf8", windowsHide: true }); if (r.status !== 0) bad.push(`${path.relative(H, f)}: ${String(r.stderr).trim().split("\n").slice(0, 3).join(" ")}`); }
    else if (/\.json$/.test(f)) { n++; try { JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { bad.push(`${path.relative(H, f)}: ${e.message}`); } }
  }
  return { n, bad };
}
if (process.argv.slice(2).join(" ") === "--parse-only") {
  const p = parseCheck();
  for (const b of p.bad) console.log("FAIL  " + quiet(b));
  console.log(p.bad.length ? `PARSE: ${p.bad.length} of ${p.n} package files FAILED` : `ALL ${p.n} PACKAGE FILES PARSE (node --check of every .cjs / .js, JSON.parse of every .json)`);
  process.exitCode = p.bad.length ? 1 : 0;
} else if (process.argv.length > 2) { console.log("usage: node selftest.cjs [--parse-only]"); process.exitCode = 2; }
else {
  const R = (...p) => path.join(REPO, ...p);
  const RUNS = [
    ["w6 table --selftest", path.join(H, "w6.cjs"), ["--selftest"], / 0 failed/],
    ["units.cjs --check", path.join(H, "units.cjs"), ["--check"], /^ok\s+\d+ job\(s\) -> \d+ service \+ \d+ timer files/m],
    ["manifests.cjs --check", path.join(H, "manifests.cjs"), ["--check"], /^ok\s+pull-server\.cjs's loader would refuse/m],
    ["agent-jobs.json --check", R("automation", "agent-job.cjs"), ["--check"], /\d+ job\(s\) — fine/],
    ["agent-cli --selftest", R("backend", "lib", "agent-cli.js"), ["--selftest"], / 0 failed/],
    ["agent-job --selftest", R("automation", "agent-job.cjs"), ["--selftest"], / 0 failed/],
    ["orchestrate --selftest", R("automation", "orchestrate.cjs"), ["--selftest"], / 0 failed/],
    ["w6-ipscreen --selftest", path.join(H, "deploy-server", "w6-ipscreen.cjs"), ["--selftest"], / 0 failed/],
    ["deploy --selftest", path.join(H, "deploy.cjs"), ["--selftest"], / 0 failed/],
    ["rollback --selftest", path.join(H, "rollback.cjs"), ["--selftest"], / 0 failed/],
  ];
  // what no selftest may touch: the log and the data folder a real run would write, the governance and ownership files, the live launchers
  // of today's AI jobs, the installed manifests, the package's own state file, and home's key file (its size and time only; never opened)
  const WATCH = ["automation/agent-job.log", "automation/agent-jobs.json", "backend/data/agent-jobs", "backend/data/host-ownership.json", "backend/data/audit-nightly.lock.json", "backend/data/audit-nightly",
    "backend/data/test-registry.json", "backend/data/read-seals.json", "backend/data/change-registry.json", "backend/data/agent-ledger.jsonl", "backend/data/seat-claims.jsonl", "backend/data/r309-HALT", "backend/.env",
    "deploy/server/manifests", "deploy/server/own.cjs", "deploy/server/own-check.cjs", "deploy/server/pull-server.cjs", "docs/server/wave6-agents/deploy-state.json",
    "automation/evening.bat", "automation/seat-wave.cjs", "automation/seat-wave.bat", "automation/progress-email.bat", "automation/close-chain.cjs", "backend/pipeline.js", "backend/progress-report.js", "backend/notify.js", "backend/audit-guard.js",
    ".claude/workflows/nightly-audit.js", ".claude/workflows/build-check-loop.js", ".claude/skills/nightly-audit/SKILL.md", ".claude/agents/ops-watchdog.md"];
  const h = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex").slice(0, 16);
  const one = (rel) => { const f = R(...rel.split("/")); if (!fs.existsSync(f)) return "absent"; if (rel === "backend/.env") { const s = fs.statSync(f); return `stat:${s.size}:${s.mtimeMs}`; }   // the key file is never opened here: its size and time only
    if (fs.statSync(f).isDirectory()) return "dir[" + fs.readdirSync(f).sort().map((n) => { const p = path.join(f, n); return n + ":" + (fs.statSync(p).isDirectory() ? "d" : h(p)); }).join(",") + "]"; return h(f); };
  const snap = () => WATCH.map(one);
  const before = snap();
  let bad = 0; const tallies = [];
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/ALPACA|TELEGRAM|SMTP|SCHWAB|TASTY|ANTHROPIC|NTFY|OPENAI|GEMINI|GOOGLE_API|CODEX|TWILIO|RESEND|MASSIVE|FINNHUB|TRAIDS_AGENT_|TRAIDS_ENV_FILE|CLAUDE_SERVER|CLAUDE_CODE_OAUTH/i.test(k)));
  for (const [name, file, args, re] of RUNS) {
    const r = cp.spawnSync(process.execPath, [file, ...args], { cwd: path.dirname(file), encoding: "utf8", timeout: 900000, windowsHide: true, env });
    const out = String(r.stdout || ""), t = tally(out), { okLines, failLines } = t;
    const ok = r.status === 0 && re.test(out) && failLines === 0;
    tallies.push(t); if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(26)} ${okLines} ok, ${failLines} failed, exit ${r.status}${ok ? "" : "\n" + quiet((out + String(r.stderr || "")).split("\n").filter((l) => /FAIL|DIFF|PROBLEM|Error|error/.test(l)).slice(0, 12).join("\n"))}`);
    for (const n of out.split("\n").filter((l) => /^\s+note\b/.test(l)).map((l) => l.trim())) console.log("      " + quiet(n));
  }
  { // this file's own last line, both forms — pure, so the red form is proved without a failing run
    const RED = "  ok   adds\n  FAIL rounds — expected 4, got 5\n  ok   sorts\nsuite: 2 passed, 1 failed\n", GREEN = "  ok   adds\n  ok   rounds\n  ok   sorts\nsuite: 3 passed, 0 failed\n";
    let count = () => null; try { count = require(R("automation", "orchestrate.cjs")).parseTestCount; } catch { /* the last case below fails */ }
    const cases = [
      ["a failing case is still a case: the red run and the green run of one suite give the same total (3), and two runs add up (6)", tally(RED).okLines === 2 && tally(RED).failLines === 1 && caseTotal([tally(RED)]) === 3 && caseTotal([tally(GREEN)]) === 3 && caseTotal([tally(RED), tally(GREEN)]) === 6 && caseTotal([]) === 0],
      ["the red last line carries the case total, and never the word the checker looks for", lastLine(2, 12, 556) === "SELFTEST: 2 of 12 checks FAILED (556 selftest cases)" && !/ALL/.test(lastLine(2, 12, 556))],
      ["the green last line", lastLine(0, 12, 556) === "ALL 12 CHECKS PASSED (556 selftest cases)"],
      ["the build loop reads the same case count from the red line as from the green one", count(lastLine(2, 12, 556)) === 556 && count(lastLine(0, 12, 556)) === 556],
    ];
    const failed = cases.filter((c) => !c[1]); if (failed.length) bad++;
    tallies.push({ okLines: cases.length - failed.length, failLines: failed.length });
    console.log(`${failed.length ? "FAIL" : "PASS"}  ${"last line (both forms)".padEnd(26)} ${cases.length - failed.length} ok, ${failed.length} failed${failed.length ? "\n" + quiet(failed.map((c) => "  FAIL " + c[0]).join("\n")) : ""}`);
  }
  const p = parseCheck(); if (p.bad.length) bad++;
  console.log(`${p.bad.length ? "FAIL" : "PASS"}  ${"parse (every file)".padEnd(26)} ${p.n} files${p.bad.length ? ":\n" + quiet(p.bad.join("\n")) : " — node --check / JSON.parse"}`);
  const after = snap(), changed = WATCH.filter((rel, i) => before[i] !== after[i]);
  if (changed.length) bad++;
  console.log(`${changed.length ? "FAIL" : "PASS"}  ${"repo untouched".padEnd(26)} ${WATCH.length} watched paths ${changed.length ? "CHANGED: " + changed.join(", ") : "identical before and after (no log line, no job output, no map / registry / manifest / launcher change)"}`);
  const checks = RUNS.length + 3;
  console.log(lastLine(bad, checks, caseTotal(tallies)));
  process.exitCode = bad ? 1 : 0;
}
