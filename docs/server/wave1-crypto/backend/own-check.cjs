#!/usr/bin/env node
/**
 * OWN CHECK — systemd ExecCondition= for every migrated unit on the VPS. 2026-10-07 (server migration M2; docs/server/wave1-crypto).
 * Installed at /home/traids/traids/backend/own-check.cjs (repo copy: deploy/server/own-check.cjs). Read-only: it reads ONE file,
 * data/host-ownership.json beside it — home's map, pushed read-only (root:root 0444) by deploy/server/own.cjs — and writes nothing.
 *
 *   node own-check.cjs <unit> server     the real unit: run only while the map says "<unit>": "server"
 *   node own-check.cjs <unit> home       the SHADOW unit (dry nights): run only while home still owns the unit
 *   node own-check.cjs --selftest
 *
 * Exit codes (this script):
 *   0    the map names the wanted host -> run
 *   77   the map names the OTHER host  -> skip quietly
 *   255  the map is missing, unreadable, malformed, does not name the unit, or the arguments are wrong -> FAIL
 * The units never use these codes directly: their ExecCondition is the /bin/sh wrapper below (conditionCommand), which maps 0 -> 0
 * (run), 77 -> 1 (systemd: condition false, skipped, not failed) and EVERYTHING ELSE -> 255 (systemd: the unit FAILS, OnFailure= pages
 * the ops bot). Without the wrapper a crash of this script (missing file, syntax error, an uncaught throw: node exits 1) would read
 * to systemd as "condition false" and every W1 recorder would stop silently (review 2026-10-07). An unknown owner is never read as
 * either host.
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const MAP = path.join(__dirname, "data", "host-ownership.json");
const SKIP = 77;
const NODE = "/usr/local/bin/node", REAL_SCRIPT = "/home/traids/traids/backend/own-check.cjs";

/** Pure: (map text | null, unit, want) -> { code, why } */
function decide(text, unit, want) {
  if (!/^[a-z0-9-]+$/.test(String(unit || "")) || (want !== "server" && want !== "home")) return { code: 255, why: "usage: own-check.cjs <unit> server|home" };
  if (text == null) return { code: 255, why: `${MAP} is missing or unreadable — refusing to guess which host owns ${unit}` };
  let m; try { m = JSON.parse(text); } catch { return { code: 255, why: "host-ownership.json does not parse — refusing to guess" }; }
  if (!m || m.schema !== "host-ownership-v1" || !m.units || typeof m.units !== "object") return { code: 255, why: "host-ownership.json is not a host-ownership-v1 map" };
  const h = m.units[unit];
  if (h !== "home" && h !== "server") return { code: 255, why: `host-ownership.json does not name ${unit} (got ${JSON.stringify(h)})` };
  return h === want ? { code: 0, why: `${unit} is ${h}-owned — run` } : { code: SKIP, why: `${unit} is ${h}-owned — skipped (this unit runs only while ${want}-owned)` };
}

/**
 * The ExecCondition= value of a unit (as written in the unit file: "$$" is systemd's literal "$"). The single source for the units
 * (deploy.cjs's selftest compares every unit file with it) and for this file's selftest, which runs it under sh.
 */
function conditionCommand(unit, want, { node = NODE, script = REAL_SCRIPT } = {}) {
  if (!/^[a-z0-9-]+$/.test(unit) || (want !== "server" && want !== "home")) throw new Error("conditionCommand: bad unit / want");
  return `/bin/sh -c '${node} ${script} ${unit} ${want}; c=$$?; if [ $$c -eq 0 ]; then exit 0; elif [ $$c -eq ${SKIP} ]; then exit 1; else exit 255; fi'`;
}
/** the same command as a shell would receive it from systemd ($$ -> $), minus the "/bin/sh -c" wrapper: the inner script */
const innerScript = (cmd) => { const m = /^\/bin\/sh -c '(.*)'$/.exec(cmd); if (!m) throw new Error("not a /bin/sh -c '...' command"); return m[1].replace(/\$\$/g, "$"); };

function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + d : "")); } };
  const map = (units) => JSON.stringify({ schema: "host-ownership-v1", units });
  ok("server-owned: the real unit runs (0), the shadow unit skips (77)", decide(map({ "w1-whales": "server" }), "w1-whales", "server").code === 0 && decide(map({ "w1-whales": "server" }), "w1-whales", "home").code === SKIP);
  ok("home-owned: the real unit skips (77), the shadow unit runs (0)", decide(map({ "w1-whales": "home" }), "w1-whales", "server").code === SKIP && decide(map({ "w1-whales": "home" }), "w1-whales", "home").code === 0);
  ok("missing map -> 255 (fails loudly, never read as a host)", decide(null, "w1-whales", "server").code === 255);
  ok("torn / foreign / unit-less / bad-host maps -> 255", [decide("{ torn", "w1-whales", "server"), decide(JSON.stringify({ units: { "w1-whales": "server" } }), "w1-whales", "server"), decide(map({ other: "server" }), "w1-whales", "server"), decide(map({ "w1-whales": "Server" }), "w1-whales", "server")].every((r) => r.code === 255));
  ok("bad arguments -> 255", decide(map({ "w1-whales": "home" }), "w1-whales", "both").code === 255 && decide(map({}), "../x", "home").code === 255);
  ok("the unit-file command: /bin/sh wrapper, $$ escaped for systemd, 0 -> 0, 77 -> 1, anything else -> 255", conditionCommand("w1-social", "server") === "/bin/sh -c '/usr/local/bin/node /home/traids/traids/backend/own-check.cjs w1-social server; c=$$?; if [ $$c -eq 0 ]; then exit 0; elif [ $$c -eq 77 ]; then exit 1; else exit 255; fi'");
  // the real file path, in a temp tree (the script reads data/host-ownership.json beside itself)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "own-check-")), cp = require("child_process");
  try {
    fs.mkdirSync(path.join(tmp, "data")); const SCRIPT = path.join(tmp, "own-check.cjs"); fs.copyFileSync(__filename, SCRIPT);
    const run = (...a) => cp.spawnSync(process.execPath, [SCRIPT, ...a], { encoding: "utf8" }).status;
    const r0 = run("w1-social", "server");
    fs.writeFileSync(path.join(tmp, "data", "host-ownership.json"), map({ "w1-social": "server" }));
    ok("as a process: missing map 255, then server-owned 0 / shadow 77", r0 === 255 && run("w1-social", "server") === 0 && run("w1-social", "home") === SKIP, `${r0}`);
    // THE WRAPPER, as systemd runs it (sh -c), against this temp tree: a crash of own-check must FAIL the unit (255), never skip it.
    const sh = fs.existsSync("/bin/sh") ? "/bin/sh" : (cp.spawnSync("sh", ["-c", "exit 0"]).status === 0 ? "sh" : null);
    if (!sh && process.platform === "linux") ok("the ExecCondition wrapper runs under /bin/sh", false, "no /bin/sh on a Linux host");
    else if (!sh) console.log("  note the ExecCondition wrapper was not run here (no sh on PATH); the VPS copy step runs this selftest under /bin/sh");
    else {
      const posix = (p) => p.replace(/\\/g, "/");
      const wrap = (want, script = SCRIPT) => cp.spawnSync(sh, ["-c", innerScript(conditionCommand("w1-social", want, { node: `"${posix(process.execPath)}"`, script: `"${posix(script)}"` }))], { encoding: "utf8" }).status;
      ok("wrapper: server-owned -> 0 (run); the other host -> 1 (systemd skips, no alert)", wrap("server") === 0 && wrap("home") === 1, `${wrap("server")} ${wrap("home")}`);
      fs.writeFileSync(path.join(tmp, "data", "host-ownership.json"), "{ torn");
      ok("wrapper: a torn map -> 255 (the unit FAILS and pages)", wrap("server") === 255);
      fs.writeFileSync(path.join(tmp, "data", "host-ownership.json"), map({ "w1-social": "server" }));
      ok("wrapper: own-check.cjs MISSING (node exits 1) -> 255, never a quiet skip", wrap("server", path.join(tmp, "gone.cjs")) === 255);
      const corrupt = path.join(tmp, "corrupt.cjs"); fs.writeFileSync(corrupt, "this is not javascript (\n");
      ok("wrapper: own-check.cjs CORRUPT (a SyntaxError, node exits 1) -> 255", wrap("server", corrupt) === 255);
      const thrower = path.join(tmp, "throws.cjs"); fs.writeFileSync(thrower, "throw new Error('boom');\n");
      ok("wrapper: an uncaught throw (node exits 1) -> 255", wrap("server", thrower) === 255);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`own-check selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  process.on("uncaughtException", (e) => { try { console.error("own-check crashed: " + (e && e.message)); } catch {} process.exit(255); });
  if (a[0] === "--selftest") process.exitCode = selftest() ? 0 : 1;
  else {
    let text = null; try { text = fs.readFileSync(MAP, "utf8"); } catch { text = null; }
    const r = decide(text, a[0], a[1]);
    console.log(`own-check ${a[0] || "?"} ${a[1] || "?"}: ${r.why} (exit ${r.code})`);
    process.exitCode = r.code;
  }
}
module.exports = { decide, conditionCommand, innerScript, SKIP };
