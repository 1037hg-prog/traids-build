#!/usr/bin/env node
/**
 * SELFTEST — every check of the W3 broker-sleeve cell package, OFFLINE: no ssh, no network; temp dirs, fake VPSes and a fake ssh only.
 * 2026-10-09 (docs/server/wave3-sleeves).
 *   node docs/server/wave3-sleeves/selftest.cjs               the generators (manifests, units), every module's --selftest, the parse
 *                                                         check, then proof that the repo was not touched (the sha256 of every home
 *                                                         file the package edits or creates, and of the data files it could write, is
 *                                                         the same after the run as before)
 *   node docs/server/wave3-sleeves/selftest.cjs --parse-only  node --check of every .cjs / .js file in the package and JSON.parse of every .json
 * The last line says "ALL ..." only when everything passed (failure output is printed with that word lower-cased).
 * A module's NOTE lines are printed once, under its line (review fix cycle 3, 2026-10-10): a sibling package that changed — W2b re-pinned, the
 * change NOTES requires before this package's home step — is REPORTED BY NAME here; it no longer fails a case (home-patch.cjs w2bNote).
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
if (process.argv.slice(2).join(" ") === "--parse-only") {
  const p = parseCheck();
  for (const b of p.bad) console.log("FAIL  " + quiet(b));
  console.log(p.bad.length ? `PARSE: ${p.bad.length} of ${p.n} package files FAILED` : `ALL ${p.n} PACKAGE FILES PARSE (node --check of every .cjs / .js, JSON.parse of every .json)`);
  process.exitCode = p.bad.length ? 1 : 0;
} else if (process.argv.length > 2) { console.log("usage: node selftest.cjs [--parse-only]"); process.exitCode = 2; }
else {
  const RUNS = [
    ["manifests.cjs --check", path.join(H, "manifests.cjs"), ["--check"], /ok\s+manifests\/w3-r346\.json/],
    ["units.cjs --check", path.join(H, "units.cjs"), ["--check"], /ok\s+systemd\/traids-w3s-after\.timer/],
    ["cell --selftest", path.join(H, "cell.cjs"), ["--selftest"], / 0 failed/],
    ["home-patch --selftest", path.join(H, "home-patch.cjs"), ["--selftest"], / 0 failed/],
    ["w3-run --selftest", path.join(H, "vps", "w3-run.cjs"), ["--selftest"], / 0 failed/],
    ["runner-vps --selftest", path.join(H, "vps", "close-arm-runner-vps.cjs"), ["--selftest"], / 0 failed/],
    ["w3-sync --selftest", path.join(H, "deploy-server", "w3-sync.cjs"), ["--selftest"], / 0 failed/],
    ["compare --selftest", path.join(H, "compare.cjs"), ["--selftest"], / 0 failed/],
    ["register --selftest", path.join(H, "register.cjs"), ["--selftest"], / 0 failed/],
    ["deploy --selftest", path.join(H, "deploy.cjs"), ["--selftest"], / 0 failed/],
    ["rollback --selftest", path.join(H, "rollback.cjs"), ["--selftest"], / 0 failed/],
  ];
  const HP = require(path.join(H, "home-patch.cjs"));
  const WATCH = [...new Set([...HP.ALL().map((e) => e.rel), ...HP.EDITS.map((e) => HP.BAK(e.rel)), "automation/intraday.bat",
    "backend/data/host-ownership.json", "backend/data/change-registry.json", "backend/data/r309-HALT", "backend/data/w3-sync-status.json", "backend/data/w3-inputs-ready.json",
    "deploy/server/own.cjs", "deploy/server/pull-server.cjs", "deploy/server/own-check.cjs", "docs/server/wave3-sleeves/deploy-state.json"])];
  const snap = () => WATCH.map((rel) => { const f = path.join(REPO, rel); if (!fs.existsSync(f)) return rel + ":absent"; return rel + ":" + crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex").slice(0, 16); }).join("\n");
  const before = snap();
  let bad = 0, total = 0; const noted = new Set();
  const env =Object.fromEntries(Object.entries(process.env).filter(([k]) => !/ALPACA|TELEGRAM|SMTP|SCHWAB|TASTY|ANTHROPIC|NTFY|OPENAI|GEMINI|TWILIO|RESEND|MASSIVE|FINNHUB|TRAIDS_ENV_FILE|W3_/i.test(k)));
  for (const [name, file, args, re] of RUNS) {
    const r = cp.spawnSync(process.execPath, [file, ...args], { cwd: path.dirname(file), encoding: "utf8", timeout: 900000, windowsHide: true, env });
    const out = String(r.stdout || ""), okLines = (out.match(/^\s*ok\b/gm) || []).length, failLines = (out.match(/^\s+FAIL\b|^DIFF\b/gm) || []).length;
    const ok = r.status === 0 && re.test(out) && failLines === 0;
    total += okLines; if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(24)} ${okLines} ok, ${failLines} failed, exit ${r.status}${ok ? "" : "\n" + quiet((out + String(r.stderr || "")).split("\n").filter((l) => /FAIL|DIFF|Error|error/.test(l)).slice(0, 12).join("\n"))}`);
    for (const n of out.split("\n").filter((l) => /^\s+NOTE\b/.test(l)).map((l) => l.trim())) if (!noted.has(n)) { noted.add(n); console.log("      " + quiet(n)); }
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
