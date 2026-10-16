#!/usr/bin/env node
/**
 * SELFTEST — every check of the R309-fold package, OFFLINE: no ssh, no network, no notification, no process scan, no Task Scheduler;
 * temp dirs, fake ssh / fake VPS answers and a stub alarm only. 2026-10-09 (docs/server/wave-r309fold).
 *   node docs/server/wave-r309fold/selftest.cjs               the recorded fixtures, the fold module, the PARITY proof on the recorded
 *                                                             fixtures, the home patch, deploy (in process: its guards, the clean-day
 *                                                             gate, the home step on temp roots, live parity on a fake VPS), rollback,
 *                                                             register, the parse check, then proof that the repo was not touched
 *   node docs/server/wave-r309fold/selftest.cjs --parse-only  node --check of every .cjs / .js file in the package and JSON.parse of every .json
 *   node docs/server/wave-r309fold/selftest.cjs --only <fixtures|fold|parity|home-patch|deploy|rollback|register>   one of them
 * The last line says "ALL ..." only when everything passed (failure output is printed with that word lower-cased).
 */
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
const H = __dirname, REPO = path.resolve(H, "..", "..", "..");
const quiet = (s) => String(s).replace(/ALL/g, "all");   // only the final success line may carry the word the checker looks for

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
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/ALPACA|TELEGRAM|SMTP|SCHWAB|TASTY|ANTHROPIC|NTFY|OPENAI|GEMINI|TWILIO|RESEND|MASSIVE|FINNHUB|DISCORD/i.test(k)));
/** [name, how] — how: [file, args] spawned, or "deploy" (in process: its selftest() is exported) */
const RUNS = [
  ["fixtures --selftest", [path.join(H, "fixtures.cjs"), ["--selftest"]], "fixtures"],
  ["r309-fold --selftest", [path.join(H, "deploy-server", "r309-fold.cjs"), ["--selftest"]], "fold"],
  ["parity --selftest", [path.join(H, "parity.cjs"), ["--selftest"]], "parity"],
  ["home-patch --selftest", [path.join(H, "home-patch.cjs"), ["--selftest"]], "home-patch"],
  ["deploy selftest()", "deploy", "deploy"],
  ["rollback --selftest", [path.join(H, "rollback.cjs"), ["--selftest"]], "rollback"],
  ["register --selftest", [path.join(H, "register.cjs"), ["--selftest"]], "register"],
];
function runOne([name, how]) {
  let out = "", status = 0;
  if (how === "deploy") {
    const orig = console.log, buf = []; console.log = (...a) => buf.push(a.map(String).join(" "));
    try { status = require(path.join(H, "deploy.cjs")).selftest() ? 0 : 1; } catch (e) { buf.push("  FAIL deploy selftest threw: " + e.message); status = 1; } finally { console.log = orig; }
    out = buf.join("\n") + "\n";
  } else {
    const r = cp.spawnSync(process.execPath, [how[0], ...how[1]], { cwd: path.dirname(how[0]), encoding: "utf8", timeout: 900000, windowsHide: true, env });
    out = String(r.stdout || "") + (r.stderr ? "\n" + String(r.stderr) : ""); status = r.status;
  }
  const okLines = (out.match(/^\s*ok\b/gm) || []).length, failLines = (out.match(/^\s+FAIL\b/gm) || []).length;
  const ok = status === 0 && / 0 failed/.test(out) && failLines === 0 && okLines > 0;
  return { ok, okLines, failLines, status, out };
}

const a = process.argv.slice(2);
if (a.join(" ") === "--parse-only") {
  const p = parseCheck();
  for (const b of p.bad) console.log("FAIL  " + quiet(b));
  console.log(p.bad.length ? `PARSE: ${p.bad.length} of ${p.n} package files FAILED` : `ALL ${p.n} PACKAGE FILES PARSE (node --check of every .cjs / .js, JSON.parse of every .json)`);
  process.exitCode = p.bad.length ? 1 : 0;
} else if (a.length === 2 && a[0] === "--only" && RUNS.some((r) => r[2] === a[1])) {
  const r = runOne(RUNS.find((x) => x[2] === a[1])); process.stdout.write(quiet(r.out)); console.log(`${r.ok ? "PASS" : "FAIL"} ${a[1]}: ${r.okLines} ok, ${r.failLines} failed, exit ${r.status}`); process.exitCode = r.ok ? 0 : 1;
} else if (a.length) { console.log("usage: node selftest.cjs [--parse-only | --only <fixtures|fold|parity|home-patch|deploy|rollback|register>]"); process.exitCode = 2; }
else {
  // every path this package (or a test of it gone wrong) could write. Live files other jobs write on their own clock (the R309 run
  // files, pull-server-status.json, r309-health-alert.json, agent-ledger.jsonl) are not watched: a pull or an alarm during this run is
  // not this package. r309-fold-status.json is watched only while the fold is not installed (afterwards every preflight fire writes it).
  const installed = fs.existsSync(path.join(REPO, "deploy", "server", "r309-fold.cjs"));
  const WATCH = ["automation/close-chain.cjs", "automation/preflight.bat", "automation/ensure-servers.bat", "automation/close-chain.cjs.pre-r309fold.bak", "automation/preflight.bat.pre-r309fold.bak", "automation/ensure-servers.bat.pre-r309fold.bak",
    "deploy/server/r309-fold.cjs", "deploy/server/pull-server.cjs", "deploy/server/pull-r309.cjs", "deploy/server/pull-r309.bat", "deploy/server/manifests/r309.json", "backend/lib/r309-health.cjs",
    "backend/data/host-ownership.json", "backend/data/r309-HALT", "backend/data/change-registry.json", "backend/data/pull-server.lock", "docs/server/wave-r309fold/deploy-state.json",
    ...(installed ? [] : ["backend/data/r309-fold-status.json", "backend/data/r309-keeper.lock", "automation/r309-keeper.log"])];
  const snap = () => WATCH.map((rel) => { const f = path.join(REPO, rel); if (!fs.existsSync(f)) return rel + ":absent"; return rel + ":" + crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex").slice(0, 16); }).join("\n");
  const before = snap();
  let bad = 0, total = 0;
  for (const run of RUNS) {
    const r = runOne(run); total += r.okLines; if (!r.ok) bad++;
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${run[0].padEnd(24)} ${r.okLines} ok, ${r.failLines} failed, exit ${r.status}${r.ok ? "" : "\n" + quiet(r.out.split("\n").filter((l) => /FAIL|Error|error|threw/.test(l)).slice(0, 12).join("\n"))}`);
  }
  const p = parseCheck(); if (p.bad.length) bad++;
  console.log(`${p.bad.length ? "FAIL" : "PASS"}  ${"parse (every file)".padEnd(24)} ${p.n} files${p.bad.length ? ":\n" + quiet(p.bad.join("\n")) : " — node --check / JSON.parse"}`);
  const after = snap(), same = before === after;
  if (!same) bad++;
  console.log(`${same ? "PASS" : "FAIL"}  ${"repo untouched".padEnd(24)} ${WATCH.length} watched paths ${same ? "identical before and after" : "CHANGED:\n" + after.split("\n").filter((l, i) => l !== before.split("\n")[i]).join("\n")}`);
  const checks = RUNS.length + 2;
  console.log(bad ? `SELFTEST: ${bad} of ${checks} checks FAILED` : `ALL ${checks} CHECKS PASSED (${total} selftest cases)`);
  process.exitCode = bad ? 1 : 0;
}
