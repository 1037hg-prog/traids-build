#!/usr/bin/env node
/**
 * HOME GATE — the ownership gate of a home .bat line (server migration M2 for units that are not close-chain steps). 2026-10-08
 * (docs/server/wave1c-2a). Installed at home as deploy/server/home-gate.cjs by docs/server/wave1c-2a/deploy.cjs (step home). Read-only:
 * it reads backend/data/host-ownership.json (home's master map) and writes nothing but one log line.
 *
 *   node deploy\server\home-gate.cjs <unit> && node backend\<script>.js ...      (automation\board-discipline.bat, automation\preflight.bat)
 *
 *   exit 0  the map gives <unit> to home   -> the line runs, as before
 *   exit 1  the map gives <unit> to the VPS -> skipped (server-owned): the VPS runs it, "pull server files" brings its files home
 *   exit 2  the map is missing, torn, or does not name <unit>, or bad arguments -> NOT RUN, with a WARN line. An unknown owner is never
 *           guessed (W1's rule): running beside the VPS would grow home's copy of an append-only file and refuse every later pull.
 * The decision is own-check.cjs's decide() (the same function the VPS units' ExecCondition runs), asked for "home".
 *   node deploy/server/home-gate.cjs --selftest
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");
const findRepo = (from) => { for (let d = from; ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, "backend", "data")) && fs.existsSync(path.join(d, "deploy"))) return d; if (path.dirname(d) === d) return null; } };
const REPO = findRepo(__dirname);
const OC = require(fs.existsSync(path.join(__dirname, "own-check.cjs")) ? path.join(__dirname, "own-check.cjs") : path.join(REPO, "deploy", "server", "own-check.cjs"));

/** Pure: (map text | null, unit) -> { code: 0 run | 1 skip | 2 not run, line } */
function gate(text, unit) {
  const d = OC.decide(text, unit, "home");
  if (d.code === 0) return { code: 0, line: `${unit} is home-owned — run` };
  if (d.code === OC.SKIP) return { code: 1, line: `${unit} skipped (server-owned) — the VPS runs it; pull server files brings its files home` };
  return { code: 2, line: `WARN ${unit} NOT RUN — ${d.why} (refusing to guess the host)` };
}
function main(argv) {
  if (argv.length !== 1 || !/^[a-z0-9-]+$/.test(argv[0])) { console.log(`${new Date().toISOString()} home-gate: WARN NOT RUN — usage: home-gate.cjs <unit>`); return 2; }
  let text = null; try { text = REPO ? fs.readFileSync(path.join(REPO, "backend", "data", "host-ownership.json"), "utf8") : null; } catch { text = null; }
  const g = gate(text, argv[0]);
  console.log(`${new Date().toISOString()} home-gate: ${g.line}`);
  return g.code;
}

function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + d : "")); } };
  const map = (units) => JSON.stringify({ schema: "host-ownership-v1", units });
  ok("home-owned -> 0 (the line runs)", gate(map({ "w1c-spread": "home" }), "w1c-spread").code === 0);
  ok("server-owned -> 1 (skipped, says server-owned)", gate(map({ "w1c-spread": "server" }), "w1c-spread").code === 1 && /skipped \(server-owned\)/.test(gate(map({ "w1c-spread": "server" }), "w1c-spread").line));
  ok("missing / torn / unit-less / bad-host map -> 2, NOT RUN with a WARN (never guessed)", [gate(null, "w2a-fills"), gate("{ torn", "w2a-fills"), gate(map({ "w1-whales": "server" }), "w2a-fills"), gate(map({ "w2a-fills": "Server" }), "w2a-fills")].every((g) => g.code === 2 && /^WARN w2a-fills NOT RUN/.test(g.line)));
  // as a process, in a temp repo (deploy/server/{home-gate,own-check}.cjs + backend/data/host-ownership.json): the exit codes cmd sees
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "home-gate-"));
  try {
    const ds = path.join(tmp, "deploy", "server"), bd = path.join(tmp, "backend", "data"); fs.mkdirSync(ds, { recursive: true }); fs.mkdirSync(bd, { recursive: true });
    fs.copyFileSync(__filename, path.join(ds, "home-gate.cjs")); fs.copyFileSync(path.join(REPO, "deploy", "server", "own-check.cjs"), path.join(ds, "own-check.cjs"));
    const run = (...a) => cp.spawnSync(process.execPath, [path.join(ds, "home-gate.cjs"), ...a], { encoding: "utf8", windowsHide: true });
    const r0 = run("w1c-spread");
    fs.writeFileSync(path.join(bd, "host-ownership.json"), map({ "w1c-spread": "home", "w2a-fills": "server" }));
    const r1 = run("w1c-spread"), r2 = run("w2a-fills"), r3 = run("w9-none"), r4 = run(), r5 = run("../x");
    ok("process: no map -> exit 2; home -> 0; server -> 1; unit not named -> 2; no / bad argument -> 2", r0.status === 2 && r1.status === 0 && r2.status === 1 && r3.status === 2 && r4.status === 2 && r5.status === 2, [r0, r1, r2, r3, r4, r5].map((r) => r.status).join(","));
    ok("process: one log line each, the WARN names the reason", /home-gate: WARN w1c-spread NOT RUN — .*missing or unreadable/.test(r0.stdout) && /skipped \(server-owned\)/.test(r2.stdout) && r1.stdout.trim().split("\n").length === 1);
    // the cmd line form: `gate && script` runs the script only on exit 0 (Windows cmd; skipped where there is no cmd.exe)
    if (process.platform === "win32") {
      const line = (u) => cp.spawnSync("cmd.exe", ["/d", "/s", "/c", `""${process.execPath}" "${path.join(ds, "home-gate.cjs")}" ${u} >nul 2>&1 && echo RAN"`], { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true });
      const a = line("w1c-spread"), b = line("w2a-fills");
      ok("cmd: `home-gate <unit> && script` runs the script only when home-owned", /RAN/.test(a.stdout) && !/RAN/.test(b.stdout), `${a.stdout}|${b.stdout}`);
    } else ok("cmd: skipped (not Windows)", true);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`home-gate selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) {
  if (process.argv[2] === "--selftest" && process.argv.length === 3) process.exitCode = selftest() ? 0 : 1;
  else process.exitCode = main(process.argv.slice(2));
}
module.exports = { gate, main };
