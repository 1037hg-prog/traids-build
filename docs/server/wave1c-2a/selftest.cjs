#!/usr/bin/env node
/**
 * SELFTEST — every check of the W1c + W2a package, OFFLINE: no ssh, no network; temp dirs, fake VPSes and a fake ssh only. 2026-10-08
 * (docs/server/wave1c-2a).
 *   node docs/server/wave1c-2a/selftest.cjs               the generators (manifests, units), every module's --selftest, the parse check,
 *                                                         then proof that the repo was not touched (the sha256 of every home file the
 *                                                         package edits or creates is the same after the run as before)
 *   node docs/server/wave1c-2a/selftest.cjs --parse-only  node --check of every .cjs / .js file in the package and JSON.parse of every .json
 * Known answers include: W1-not-cut-over refusal, live-money key refusal, a secret never in any log line, each anchor found exactly
 * once, idempotent re-apply, rollback byte-exact, manifests / units equal their generators, the 24/7 flag for the TV account only
 * (pure, and the staged --tv-24x7 / --symbols-file scripts RUN as processes under a fake clock, WebSocket and fetch), and the cutover /
 * home / keys / copy / gate-proof guards driven through the steps themselves on temp roots and fake VPSes.
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
if (process.argv.slice(2).join(" ") === "--parse-only") {
  const p = parseCheck();
  for (const b of p.bad) console.log("FAIL  " + quiet(b));
  console.log(p.bad.length ? `PARSE: ${p.bad.length} of ${p.n} package files FAILED` : `ALL ${p.n} PACKAGE FILES PARSE (node --check of every .cjs / .js, JSON.parse of every .json)`);
  process.exitCode = p.bad.length ? 1 : 0;
} else if (process.argv.length > 2) { console.log("usage: node selftest.cjs [--parse-only]"); process.exitCode = 2; }
else {
  const RUNS = [
    ["manifests.cjs --check", path.join(H, "manifests.cjs"), ["--check"], /ok\s+manifests\/w2a\.json/],
    ["units.cjs --check", path.join(H, "units.cjs"), ["--check"], /ok\s+systemd\/traids-fills-shadow\.timer/],
    ["home-patch --selftest", path.join(H, "home-patch.cjs"), ["--selftest"], / 0 failed/],
    ["home-gate --selftest", path.join(H, "deploy-server", "home-gate.cjs"), ["--selftest"], / 0 failed/],
    ["w1c-symbols --selftest", path.join(H, "deploy-server", "w1c-symbols.cjs"), ["--selftest"], / 0 failed/],
    ["deploy --selftest", path.join(H, "deploy.cjs"), ["--selftest"], / 0 failed/],
    ["compare --selftest", path.join(H, "compare.cjs"), ["--selftest"], / 0 failed/],
    ["register --selftest", path.join(H, "register.cjs"), ["--selftest"], / 0 failed/],
    ["rollback --selftest", path.join(H, "rollback.cjs"), ["--selftest"], / 0 failed/],
  ];
  const WATCH = ["automation/close-chain.cjs", "automation/preflight.bat", "automation/board-discipline.bat", "backend/crypto-spread-snapshot.js", "backend/alpaca-fills-stream.js",
    "backend/data/host-ownership.json", "backend/data/change-registry.json", "backend/data/crypto-symbols.json", "backend/data/pull-server-status.json", "backend/data/r309-HALT",
    "deploy/server/manifests/w1c.json", "deploy/server/manifests/w2a.json", "deploy/server/home-gate.cjs", "deploy/server/w1c-symbols.cjs", "deploy/server/own.cjs", "deploy/server/pull-server.cjs", "deploy/server/own-check.cjs",
    "docs/server/wave1c-2a/deploy-state.json"];
  const snap = () => WATCH.map((rel) => { const f = path.join(REPO, rel); if (!fs.existsSync(f)) return rel + ":absent"; return rel + ":" + crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex").slice(0, 16); }).join("\n");
  const before = snap();
  let bad = 0, total = 0;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/ALPACA|TELEGRAM|SMTP|SCHWAB|TASTY|ANTHROPIC|NTFY|OPENAI|GEMINI|TWILIO|RESEND|MASSIVE|FINNHUB/i.test(k)));
  for (const [name, file, args, re] of RUNS) {
    const r = cp.spawnSync(process.execPath, [file, ...args], { cwd: path.dirname(file), encoding: "utf8", timeout: 600000, windowsHide: true, env });
    const out = String(r.stdout || ""), okLines = (out.match(/^\s*ok\b/gm) || []).length, failLines = (out.match(/^\s+FAIL\b|^DIFF\b/gm) || []).length;
    const ok = r.status === 0 && re.test(out) && failLines === 0;
    total += okLines; if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(24)} ${okLines} ok, ${failLines} failed, exit ${r.status}${ok ? "" : "\n" + quiet((out + String(r.stderr || "")).split("\n").filter((l) => /FAIL|DIFF|Error|error/.test(l)).slice(0, 12).join("\n"))}`);
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
