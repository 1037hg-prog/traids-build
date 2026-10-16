#!/usr/bin/env node
/**
 * SELFTEST — every check of the W2b package (the Schwab recorders), OFFLINE: no ssh, no network; temp dirs, fake VPSes, a fake ssh and
 * a stub Schwab only. 2026-10-09 (docs/server/wave2b-schwab).
 *   node docs/server/wave2b-schwab/selftest.cjs               the unit generator check, every module's --selftest, the parse check, then
 *                                                             proof that the repo was not touched (the sha256 of every home file the package
 *                                                             edits, creates or writes is the same after the run as before)
 *   node docs/server/wave2b-schwab/selftest.cjs --parse-only  node --check of every .cjs / .js file in the package and JSON.parse of every .json
 * Known answers include: the prerequisite-wave refusal, the Schwab gate as the operator decided it on 2026-10-11 ("yes use the existing
 * app": ONE app, the app home uses — nothing refuses the VPS app for being home's) — a LIVE PERMISSION CHECK with a fake Schwab: the
 * accounts side answering 401 / 403 -> allowed; 200 -> every call refuses, the unit pages once, the token file untouched; no answer / 5xx
 * with a 'refused' verdict under 24 h old -> allowed, without one -> refused; the probe never reads the body (a marker in it appears
 * nowhere); the keys step sends exactly the two SCHWAB_MD_* names whichever home names supplied them, and nothing when home has neither;
 * the sign-in never stores a token the accounts side accepts (and deletes the token file); the share from home goes on stdin and is never
 * printed; --check-home reports both outcomes. Also: a secret never in any log line, each anchor found exactly once, idempotent re-apply,
 * the same change (gates + backups), rollback byte-exact, units equal their generator, the staged recorders RUN as processes (--schwab-md:
 * the gate, no dotenv, market holidays skipped; no flag: home, unchanged), the staged close-arm runner's own selftests in a patched tree,
 * the generated manifest through pull-server's own loader and applyUnit, every remote script under 5,000 characters (file lists in chunks),
 * the compare on home's real records.
 * RUN IT ON ITS OWN: two copies at the same time (or one beside another heavy job) can show a false FAIL — home-patch's cases run the
 * staged close-arm runner's selftests as child processes, and those are sensitive to load (seen once in review, 2026-10-11).
 * THE USER'S HOME FOLDER is watched too: the token library has no default path any more, and the "repo untouched" check also proves that
 * <home>/.traids (where that default used to point) is the same after the run as before — absent stays absent.
 * The last line says "ALL ..." only when everything passed (failure output is printed with that word lower-cased).
 */
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process"), crypto = require("crypto"), os = require("os");
const H = __dirname, REPO = path.resolve(H, "..", "..", "..");
/** <home>/.traids: "absent", or every entry's name, size and time — where lib/schwab-md.js's default token path used to point (a selftest once wrote there) */
const HOME_DOT = path.join(os.homedir(), ".traids");
function homeDotState(dir = HOME_DOT) {
  let names; try { names = fs.readdirSync(dir).sort(); } catch (e) { return e.code === "ENOENT" ? "absent" : "unreadable (" + e.code + ")"; }
  return "present: " + (names.map((n) => { try { const s = fs.statSync(path.join(dir, n)); return `${n} ${s.size} ${s.mtimeMs}`; } catch (e) { return `${n} ? (${e.code})`; } }).join(", ") || "(empty)");
}
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
    ["units.cjs --check", path.join(H, "units.cjs"), ["--check"], /ok\s+systemd\/traids-schwab-md-check\.timer/],
    ["md-guard --selftest", path.join(H, "md-guard.cjs"), ["--selftest"], / 0 failed/],
    ["schwab-md-auth --selftest", path.join(H, "vps", "schwab-md-auth.cjs"), ["--selftest"], / 0 failed/],
    ["w2b-manifest --selftest", path.join(H, "deploy-server", "w2b-manifest.cjs"), ["--selftest"], / 0 failed/],
    ["home-patch --selftest", path.join(H, "home-patch.cjs"), ["--selftest"], / 0 failed/],
    ["deploy --selftest", path.join(H, "deploy.cjs"), ["--selftest"], / 0 failed/],
    ["schwab-auth --selftest", path.join(H, "schwab-auth.cjs"), ["--selftest"], / 0 failed/],
    ["compare --selftest", path.join(H, "compare.cjs"), ["--selftest"], / 0 failed/],
    ["register --selftest", path.join(H, "register.cjs"), ["--selftest"], / 0 failed/],
    ["rollback --selftest", path.join(H, "rollback.cjs"), ["--selftest"], / 0 failed/],
  ];
  const WATCH = ["automation/close-chain.cjs", "automation/intraday.bat", "automation/close-arm-runner.cjs", "backend/gex-record.js", "backend/options-flow-record.js",
    "backend/lib/schwab-md.js", "deploy/server/w2b-manifest.cjs", "deploy/server/manifests/w2b.json", "deploy/server/home-gate.cjs", "deploy/server/own.cjs", "deploy/server/pull-server.cjs", "deploy/server/own-check.cjs",
    "backend/data/host-ownership.json", "backend/data/change-registry.json", "backend/data/test-registry.json", "backend/data/r309-HALT", "backend/.env",
    "backend/lib/schwab.js", "backend/data/schwab-auth-meta.json", "deploy/server/w3-sync.cjs",
    "automation/close-chain.cjs.pre-w2b.bak", "automation/intraday.bat.pre-w2b.bak", "automation/close-arm-runner.cjs.pre-w2b.bak", "docs/server/wave2b-schwab/deploy-state.json"];
  const snap = () => WATCH.map((rel) => { const f = path.join(REPO, rel); if (!fs.existsSync(f)) return rel + ":absent"; return rel + ":" + crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex").slice(0, 16); }).join("\n");
  const before = snap(), homeBefore = homeDotState();
  let bad = 0, total = 0;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/ALPACA|TELEGRAM|SMTP|SCHWAB|TASTY|ANTHROPIC|NTFY|OPENAI|GEMINI|TWILIO|RESEND|MASSIVE|FINNHUB/i.test(k)));
  for (const [name, file, args, re] of RUNS) {
    const r = cp.spawnSync(process.execPath, [file, ...args], { cwd: path.dirname(file), encoding: "utf8", timeout: 900000, windowsHide: true, env });
    const out = String(r.stdout || ""), okLines = (out.match(/^\s*ok\b/gm) || []).length, failLines = (out.match(/^\s+FAIL\b|^DIFF\b/gm) || []).length;
    const ok = r.status === 0 && re.test(out) && failLines === 0;
    total += okLines; if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(26)} ${okLines} ok, ${failLines} failed, exit ${r.status}${ok ? "" : "\n" + quiet((out + String(r.stderr || "")).split("\n").filter((l) => /FAIL|DIFF|Error|error/.test(l)).slice(0, 12).join("\n"))}`);
  }
  const p = parseCheck(); if (p.bad.length) bad++;
  console.log(`${p.bad.length ? "FAIL" : "PASS"}  ${"parse (every file)".padEnd(26)} ${p.n} files${p.bad.length ? ":\n" + quiet(p.bad.join("\n")) : " — node --check / JSON.parse"}`);
  const after = snap(), homeAfter = homeDotState(), same = before === after && homeBefore === homeAfter;
  if (!same) bad++;
  console.log(`${same ? "PASS" : "FAIL"}  ${"repo untouched".padEnd(26)} ${WATCH.length} watched paths ${same ? `identical before and after; <home>/.traids ${homeAfter === "absent" ? "absent" : "the same"} before and after (no selftest wrote under the user's home folder)` : "CHANGED:\n" + [...after.split("\n").filter((l, i) => l !== before.split("\n")[i]), ...(homeBefore === homeAfter ? [] : [quiet(`${HOME_DOT}: before ${homeBefore} · after ${homeAfter}`)])].join("\n")}`);
  const checks = RUNS.length + 2;
  console.log(bad ? `SELFTEST: ${bad} of ${checks} checks FAILED` : `ALL ${checks} CHECKS PASSED (${total} selftest cases)`);
  process.exitCode = bad ? 1 : 0;
}
