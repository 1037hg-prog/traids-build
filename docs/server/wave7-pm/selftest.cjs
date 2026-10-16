#!/usr/bin/env node
/**
 * SELFTEST — every check of the W7 package (R352's recorder and its server package), OFFLINE: no ssh, no network beyond the
 * loopback servers the recorder's own selftest opens; temp folders, a fake VPS in memory, sandbox copies. 2026-10-11
 * (docs/server/wave7-pm).
 *   node docs/server/wave7-pm/selftest.cjs               the generators (units, manifest), the recorder's --selftest, every module's
 *                                                        --selftest, a shell syntax check of every remote script, the parse check,
 *                                                        then proof that nothing outside temp folders was touched
 *   node docs/server/wave7-pm/selftest.cjs --parse-only  node --check of every .cjs / .js of the package and of the two files it
 *                                                        ships (the recorder and its library), JSON.parse of every .json
 * The last line says "ALL n CHECKS PASSED (m selftest cases)" only when everything passed; failure output is printed with those
 * words lower-cased, so a failing run can never be taken for a passing one.
 */
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
const H = __dirname, REPO = path.resolve(H, "..", "..", "..");
const quiet = (s) => String(s).replace(/ALL/g, "all").replace(/PASSED/g, "passed").replace(/PARSE/g, "parse");
const SHIPPED = ["backend/pm-book-recorder.js", "backend/lib/pm-feeds.js"];

function packageFiles(dir = H) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) { if (e.name !== "node_modules") out.push(...packageFiles(f)); } else out.push(f); }
  return out.sort();
}
function parseCheck() {
  const files = [...packageFiles(), ...SHIPPED.map((r) => path.join(REPO, ...r.split("/")))], bad = []; let n = 0;
  for (const f of files) {
    if (/\.(cjs|js)$/.test(f)) { n++; const r = cp.spawnSync(process.execPath, ["--check", f], { encoding: "utf8", windowsHide: true }); if (r.status !== 0) bad.push(`${path.relative(REPO, f)}: ${String(r.stderr).trim().split("\n").slice(0, 3).join(" ")}`); }
    else if (/\.json$/.test(f)) { n++; try { JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { bad.push(`${path.relative(REPO, f)}: ${e.message}`); } }
  }
  return { n, bad };
}
/** a POSIX shell to syntax-check the remote scripts with (the VPS runs them under bash): PATH first, then the one git ships */
function findSh() {
  const works = (c) => { try { const r = cp.spawnSync(c, ["-c", "exit 0"], { windowsHide: true, timeout: 15000 }); return !r.error && r.status === 0; } catch { return false; } };
  const cands = ["sh", "bash", "/bin/sh"];
  try { const r = cp.spawnSync("git", ["--exec-path"], { encoding: "utf8", windowsHide: true, timeout: 15000 }); if (r.status === 0) { let d = r.stdout.trim(); for (let i = 0; i < 4; i++) { d = path.dirname(d); cands.push(path.join(d, "bin", "sh.exe"), path.join(d, "usr", "bin", "sh.exe")); } } } catch { /* no git */ }
  for (const c of cands) if (works(c)) return c;
  return null;
}
/** every remote script this package sends, parsed (not run) by a real shell; a script that is deliberately broken must be refused */
function shellCheck() {
  const sh = findSh(); if (!sh) return { ran: false };
  const L = require(path.join(H, "w7-lib.cjs")), all = L.everyScript(), bad = [];
  const syn = (s) => cp.spawnSync(sh, ["-n"], { input: s, encoding: "utf8", windowsHide: true, timeout: 30000 });
  for (const [name, s] of Object.entries(all)) { const r = syn(s); if (r.status !== 0) bad.push(`${name}: ${String(r.stderr).trim().split("\n")[0]}`); }
  const control = syn('if [ "$x" = 1 ]; then echo unfinished').status !== 0;
  if (!control) bad.push("the control (an unfinished if) was NOT refused: this shell check proves nothing here");
  // ONE line is also RUN through the shell, in a temp folder: the live marker's (its program and its JSON argument are quoted for the
  // shell; a quoting slip would show only on the VPS). Only the node path is replaced by this machine's.
  const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "w7-sh-")), f = path.join(tmp, "data", "pm-book", "live.json");
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const line = L.REMOTE.liveMarker({ unit: L.SERVICE, by: "it's quoted for the shell", n: 1 }).split("\n").pop().replace(L.NODE, `"${process.execPath.replace(/\\/g, "/")}"`);
    const run = () => cp.spawnSync(sh, ["-c", line], { cwd: tmp, encoding: "utf8", windowsHide: true, timeout: 60000 }), r1 = run(), r2 = run(), a = L.parseLive(r1.stdout), b = L.parseLive(r2.stdout);
    if (!(r1.status === 0 && a && a.how === "written" && a.live.by === "it's quoted for the shell" && a.live.n === 1 && r2.status === 0 && b && b.how === "kept" && b.live.liveAt === a.live.liveAt)) bad.push(`the live marker's line did not run through the shell as written: ${String(r1.stderr || r1.stdout).trim().split("\n")[0]} / ${String(r2.stderr || r2.stdout).trim().split("\n")[0]}`);
  } finally { try { fs.chmodSync(f, 0o666); } catch { /* not written */ } fs.rmSync(tmp, { recursive: true, force: true }); }
  return { ran: true, sh, n: Object.keys(all).length, bad };
}

if (process.argv.slice(2).join(" ") === "--parse-only") {
  const p = parseCheck();
  for (const b of p.bad) console.log("FAIL  " + quiet(b));
  console.log(p.bad.length ? `parse check: ${p.bad.length} of ${p.n} files FAILED` : `ALL ${p.n} FILES PARSE (node --check of every .cjs / .js of the package and of the recorder and its library; JSON.parse of every .json)`);
  process.exitCode = p.bad.length ? 1 : 0;
} else if (process.argv.length > 2) { console.log("usage: node selftest.cjs [--parse-only]"); process.exitCode = 2; }
else {
  const RUNS = [
    ["units.cjs --check", path.join(H, "units.cjs"), ["--check"], /units check: 0 failed/],
    ["manifests.cjs --check", path.join(H, "manifests.cjs"), ["--check"], /manifests check: 0 failed/],
    ["recorder --selftest", path.join(REPO, "backend", "pm-book-recorder.js"), ["--selftest"], / 0 failed — ALL PASSED/],
    ["deploy --selftest", path.join(H, "deploy.cjs"), ["--selftest"], / 0 failed/],
    ["rollback --selftest", path.join(H, "rollback.cjs"), ["--selftest"], / 0 failed/],
    ["record-evidence-start --selftest", path.join(H, "record-evidence-start.cjs"), ["--selftest"], / 0 failed/],
    ["fetch-day --selftest", path.join(H, "fetch-day.cjs"), ["--selftest"], / 0 failed/],
  ];
  // what must be the same after the run as before: this package's own home-side effects, its staged files, and R352's registry entry
  const sha = (b) => crypto.createHash("sha256").update(b).digest("hex").slice(0, 16);
  const tree = (dir) => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out.push(path.relative(dir, f) + ":" + fs.statSync(f).size); } }; try { walk(dir); } catch { return "absent"; } return sha(out.sort().join("\n")) + " (" + out.length + " files)"; };
  const fileSha = (rel) => { const f = path.join(REPO, ...rel.split("/")); try { return sha(fs.readFileSync(f)); } catch { return "absent"; } };
  const r352 = () => { try { const r = JSON.parse(fs.readFileSync(path.join(REPO, "backend", "data", "test-registry.json"), "utf8")); const e = (r.preregistered || []).filter((t) => t && t.id === "R352"); return e.length === 1 ? sha(JSON.stringify(e[0])) : `${e.length} entries`; } catch { return "unreadable"; } };
  const WATCH = { "docs/server/wave7-pm/deploy-state.json": fileSha, "deploy/server/manifests/w7-pm.json": fileSha, "backend/data/host-ownership.json": fileSha, "backend/pm-book-recorder.js": fileSha, "backend/lib/pm-feeds.js": fileSha,
    "docs/server/wave7-pm/manifests/w7-pm.json": fileSha, "backend/data/pm-book (the record itself)": () => tree(path.join(REPO, "backend", "data", "pm-book")), "docs/server/wave7-pm/systemd (the staged units)": () => tree(path.join(H, "systemd")), "R352's entry in the registry": r352 };
  const snap = () => Object.entries(WATCH).map(([k, f]) => `${k}: ${f(k)}`);
  const before = snap();
  let bad = 0, total = 0, checks = 0;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/ALPACA|TELEGRAM|SMTP|SCHWAB|TASTY|ANTHROPIC|NTFY|OPENAI|GEMINI|TWILIO|RESEND|MASSIVE|FINNHUB|KALSHI|POLY|COINBASE|CDP|PM_BOOK_RUN_HOST/i.test(k)));
  for (const [name, file, args, re] of RUNS) {
    const r = cp.spawnSync(process.execPath, [file, ...args], { cwd: path.dirname(file), encoding: "utf8", timeout: 900000, windowsHide: true, env, maxBuffer: 1 << 28 });
    const out = String(r.stdout || ""), okLines = (out.match(/^\s*ok\b/gm) || []).length, failLines = (out.match(/^\s+FAIL\b|^\s*DIFF\b/gm) || []).length;
    const ok = r.status === 0 && re.test(out) && failLines === 0 && okLines > 0;
    total += okLines; checks++; if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(34)} ${okLines} ok, ${failLines} failed, exit ${r.status}${ok ? "" : "\n" + quiet((out + String(r.stderr || "")).split("\n").filter((l) => /FAIL|DIFF|Error|error/.test(l)).slice(0, 14).join("\n"))}`);
  }
  const s = shellCheck();
  if (s.ran) { checks++; if (s.bad.length) bad++; console.log(`${s.bad.length ? "FAIL" : "PASS"}  ${"remote scripts: shell syntax".padEnd(34)} ${s.n} scripts parsed by a real shell (-n: read, not run), a deliberately unfinished one refused, and the live marker's line run through it in a temp folder${s.bad.length ? ":\n" + quiet(s.bad.join("\n")) : ""}`); }
  else console.log(`note  ${"remote scripts: shell syntax".padEnd(34)} not run here (no POSIX shell found on PATH or beside git) — not counted`);
  const p = parseCheck(); checks++; if (p.bad.length) bad++;
  console.log(`${p.bad.length ? "FAIL" : "PASS"}  ${"parse (every file)".padEnd(34)} ${p.n} files${p.bad.length ? ":\n" + quiet(p.bad.join("\n")) : " — node --check / JSON.parse"}`);
  const after = snap(), same = before.join("\n") === after.join("\n"); checks++; if (!same) bad++;
  console.log(`${same ? "PASS" : "FAIL"}  ${"nothing real was touched".padEnd(34)} ${Object.keys(WATCH).length} watched paths ${same ? "identical before and after (no deploy state, no manifest installed at home, no pm-book folder, the map, the staged files and R352's entry unchanged)" : "CHANGED:\n" + after.filter((l, i) => l !== before[i]).join("\n")}`);
  console.log(bad ? `SELFTEST: ${bad} of ${checks} checks FAILED` : `ALL ${checks} CHECKS PASSED (${total} selftest cases)`);
  process.exitCode = bad ? 1 : 0;
}
