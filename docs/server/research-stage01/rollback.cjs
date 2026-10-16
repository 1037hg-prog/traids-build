#!/usr/bin/env node
/**
 * ROLLBACK — undo research-stage01, one part at a time. 2026-10-06. Each part refuses rather than guess; --dry prints the plan only.
 * Every guard read is fail-closed (an ssh failure refuses; it is never read as "not running" or "absent").
 *
 *   node docs/server/research-stage01/rollback.cjs --timer     THE one-change rollback of stage 1: disable --now traids-scout.timer.
 *                                                              Then (Josh) re-enable the home alpha-scout-internet task if it was
 *                                                              disabled at cutover (Claude app -> scheduled tasks). Nothing else moves.
 *   node docs/server/research-stage01/rollback.cjs --server    timer off first; refused while a research run is active; removes the
 *                                                              three unit files (only versions this package wrote) + daemon-reload, and
 *                                                              the staged factory code (bin/lib/prompts/policy, only files whose sha
 *                                                              is the staged or last-installed one). KEPT: factory/var (budget.jsonl,
 *                                                              caps.json, jobs, runs), factory/out, factory/in — they are the record.
 *   node docs/server/research-stage01/rollback.cjs --token     removes /etc/traids/claude.env (refused while the timer is enabled)
 *   node docs/server/research-stage01/rollback.cjs --user      drops scout's ACLs (proved gone), userdel -r scout (proved: `id scout`
 *                                                              fails), and the traids-research group (after --server; refused while
 *                                                              any unit names User=scout, scout has a process, or a research unit runs)
 *   node docs/server/research-stage01/rollback.cjs --cli       apt-get remove claude-code + the repository list and key (after --server)
 *   node docs/server/research-stage01/rollback.cjs --home      home-patch revertAll: every patched home file restored from its
 *                                                              .pre-research-stage01-2026-10-06.bak if it is still exactly what the
 *                                                              package wrote; the new files removed AFTER every restore (registry-view.js
 *                                                              last: the patched readers load it). Refused file by file otherwise.
 *   add --dry to any of them for the plan only · --selftest (pure parts; no ssh)
 * Never touches R309 (traids-r309.*), /etc/traids/traids.env, backend/data/factory-pulled (home history), or any R file.
 */
"use strict";
const fs = require("fs"), path = require("path");
const HERE = __dirname, REPO = path.resolve(HERE, "..", "..", "..");
const PARTS = ["timer", "server", "token", "user", "cli", "home"];
const log = (s) => console.log(s);

/** Pure: argv -> { part, dry } ; unknown THROWS */
function parseArgs(argv) {
  const parts = argv.filter((a) => PARTS.includes(a.replace(/^--/, "")) && a.startsWith("--")).map((a) => a.slice(2)), dry = argv.includes("--dry");
  const unknown = argv.filter((a) => !(a === "--dry" || a === "--selftest" || (a.startsWith("--") && PARTS.includes(a.slice(2)))));
  if (unknown.length) throw new Error(`unknown argument ${JSON.stringify(unknown[0])} — nothing was done`);
  if (argv.includes("--selftest")) { if (argv.length > 1) throw new Error("--selftest goes alone"); return { selftest: true }; }
  if (parts.length !== 1) throw new Error(`give exactly one of ${PARTS.map((p) => "--" + p).join(" ")} (plus --dry for the plan) — nothing was done`);
  return { part: parts[0], dry };
}
/** Pure: may a unit file at this sha be removed? (only versions this package generates) */
function ourUnitShas() {
  const I = require(path.join(HERE, "install-server.cjs")), S = require(path.join(HERE, "lib", "ssh.cjs"));
  return { "traids-scout.service": [S.sha(Buffer.from(I.scoutServiceText({ alert: true }))), S.sha(Buffer.from(I.scoutServiceText({ alert: false })))], "traids-scout.timer": [S.sha(Buffer.from(I.TIMER_TEXT))], "traids-research.slice": [S.sha(Buffer.from(I.SLICE_TEXT))] };
}

function partTimer(dry) {
  const S = require(path.join(HERE, "lib", "ssh.cjs"));
  const en = S.must(S.ssh("systemctl is-enabled traids-scout.timer 2>&1; systemctl is-active traids-scout.timer 2>&1; true"), "timer state").trim().split("\n");
  log(`traids-scout.timer: ${en.join(" / ")}`);
  if (dry) { log("DRY: would run sudo -n systemctl disable --now traids-scout.timer"); return; }
  if (/not-found|No such file/.test(en.join(" "))) { log("timer not installed — nothing to do"); return; }
  S.must(S.ssh("sudo -n systemctl disable --now traids-scout.timer"), "disable timer");
  const after = S.must(S.ssh("systemctl is-enabled traids-scout.timer 2>&1; systemctl is-active traids-scout.timer 2>&1; true"), "timer state").trim();
  if (!/disabled/.test(after) || /^active$/m.test(after)) throw new Error("the timer is still enabled/active:\n" + after);
  log("traids-scout.timer disabled and stopped. A run already in progress finishes on its own (or: ssh traids sudo systemctl stop traids-scout.service).");
  log("Josh: if the home alpha-scout-internet task was disabled at cutover, re-enable it now (Claude app -> scheduled tasks). That is the whole rollback.");
}
function researchActive(S) { return S.remoteYes("systemctl is-active --quiet traids-scout.service || systemctl list-units --no-legend 'traids-research-*' 2>/dev/null | grep -q .", "research unit active"); }
function partServer(dry) {
  const S = require(path.join(HERE, "lib", "ssh.cjs")), I = require(path.join(HERE, "install-server.cjs"));
  if (!dry) partTimer(false);
  if (researchActive(S)) throw new Error("a research run is active — wait for it (or stop traids-scout.service) and re-run");
  const known = ourUnitShas(), todo = [];
  for (const [u, shas] of Object.entries(known)) {
    const cur = S.remoteSha(`${S.SYSD}/${u}`);
    if (!cur) { log(`${u}: absent`); continue; }
    if (!shas.includes(cur)) throw new Error(`${S.SYSD}/${u} is not a version this package wrote (${cur.slice(0, 12)}) — REFUSED; remove it by hand after a look`);
    todo.push(`sudo -n rm -f ${S.q(`${S.SYSD}/${u}`)}`);
  }
  const rec = ((I.readState().steps || {}).tree || {}).files || {};
  for (const rel of I.STAGED) {
    const cur = S.remoteSha(`${S.FACTORY}/${rel}`), staged = S.sha(fs.readFileSync(path.join(HERE, "server", "factory", rel)));
    if (!cur) continue;
    if (cur !== staged && cur !== rec[rel]) throw new Error(`${S.FACTORY}/${rel} changed after install (${cur.slice(0, 12)}) — REFUSED; look before removing`);
    todo.push(`rm -f ${S.q(`${S.FACTORY}/${rel}`)}`);
  }
  log(`${dry ? "DRY: would run" : "running"}:\n  ` + (todo.length ? todo.join("\n  ") : "(nothing)") + "\n  sudo -n systemctl daemon-reload");
  log("KEPT: factory/var (budget.jsonl, caps.json, jobs, runs, park, breaker), factory/out, factory/in, factory/work — the record.");
  if (dry) return;
  if (todo.length) S.must(S.ssh(["set -eu", ...todo, "sudo -n systemctl daemon-reload", "sudo -n systemctl reset-failed 'traids-scout*' 2>/dev/null || true"].join("\n")), "remove units + code");
  log("server part rolled back. The scout user, the token, the CLI: --user, --token, --cli (each separate).");
}
function partToken(dry) {
  const S = require(path.join(HERE, "lib", "ssh.cjs"));
  if (S.remoteYes("systemctl is-enabled --quiet traids-scout.timer", "timer enabled")) throw new Error("traids-scout.timer is enabled — run --timer first (removing the token under a live timer makes every run fail auth)");
  const present = S.remoteYes("sudo -n test -e /etc/traids/claude.env", "claude.env present");
  if (!present) { log("/etc/traids/claude.env absent — nothing to do"); return; }
  if (dry) { log("DRY: would run sudo -n rm -f /etc/traids/claude.env (nothing else in /etc/traids)"); return; }
  S.must(S.ssh("sudo -n rm -f /etc/traids/claude.env"), "remove claude.env");
  log("/etc/traids/claude.env removed. The token itself stays valid until it expires — revoke it from your Claude account if it should die now.");
}
/**
 * Pure: the --user script. 2026-10-07 review fix: it used to run `userdel -r scout ... || true` and then report success — userdel
 * refuses while any scout process lives (a lingering transient traids-research-* unit), so "removed" could be false. Now: refuse while
 * scout has a process or a traids-research-* unit is loaded; drop the ACLs FIRST (setfacl needs the name to resolve) and prove none is
 * left; userdel WITHOUT `|| true`; then prove `id scout` fails. set -eu: any failure exits non-zero and the step reports FAILED.
 */
function userScript(ROOT) {
  return ["set -eu",
    "if pgrep -u scout >/dev/null 2>&1; then echo 'scout still has running processes — REFUSED (wait, or stop the traids-research units)' >&2; exit 7; fi",
    "if systemctl list-units --no-legend 'traids-research-*' 2>/dev/null | grep -q . || systemctl is-active --quiet traids-scout.service; then echo 'a traids-research-* unit or traids-scout.service is still active — REFUSED' >&2; exit 7; fi",
    "if id scout >/dev/null 2>&1; then",
    `  for p in /home/traids ${ROOT} ${ROOT}/backend; do sudo -n setfacl -x u:scout "$p" 2>/dev/null || true; done`,
    `  for p in /home/traids ${ROOT} ${ROOT}/backend; do if getfacl -p "$p" 2>/dev/null | grep -q '^user:scout:'; then echo "an ACL entry for scout is left on $p — REFUSED" >&2; exit 8; fi; done`,
    "  sudo -n userdel -r scout",
    "fi",
    "if id scout >/dev/null 2>&1; then echo 'userdel did not remove scout' >&2; exit 8; fi",
    "if getent group traids-research >/dev/null; then sudo -n gpasswd -d traids traids-research >/dev/null 2>&1 || true; m=$(getent group traids-research | cut -d: -f4); if [ -z \"$m\" ]; then sudo -n groupdel traids-research; else echo \"traids-research still has members: $m (kept)\"; fi; fi",
    "echo USER_REMOVED"].join("\n");
}
function partUser(dry) {
  const S = require(path.join(HERE, "lib", "ssh.cjs"));
  if (S.remoteYes(`grep -lsq '^User=scout' ${S.SYSD}/*.service`, "units naming scout")) throw new Error("a unit still runs as scout — run --server first");
  const script = userScript(S.ROOT);
  log(`${dry ? "DRY: would run" : "running"}:\n  ` + script.split("\n").join("\n  "));
  if (dry) return;
  const out = S.must(S.ssh(script), "remove user");
  if (!/USER_REMOVED/.test(out)) throw new Error("the user step did not confirm (no USER_REMOVED line):\n" + out.slice(0, 400));
  log("user scout and its home (/home/scout: CLI sessions) removed — proved: `id scout` fails, no scout ACL entry left; the factory tree keeps group ownership by gid (harmless).");
}
function partCli(dry) {
  const S = require(path.join(HERE, "lib", "ssh.cjs"));
  if (S.remoteYes(`test -f ${S.SYSD}/traids-scout.service`, "scout unit present")) throw new Error("the scout unit is still installed — run --server first");
  const cmds = ["sudo -n env DEBIAN_FRONTEND=noninteractive apt-get remove -y -qq claude-code", "sudo -n rm -f /etc/apt/sources.list.d/claude-code.list /etc/apt/keyrings/claude-code.asc"];
  log(`${dry ? "DRY: would run" : "running"}:\n  ` + cmds.join("\n  ")); if (dry) return;
  S.must(S.ssh(cmds.join("\n"), { timeout: 600000 }), "remove CLI");
  log("claude-code removed with its apt repository and key.");
}
function partHome(dry) {
  const HP = require(path.join(HERE, "home-patch.cjs"));
  for (const l of HP.revertAll(REPO, { dry })) log("  " + l);
  if (!dry) log("home part rolled back (backend/data/factory-pulled and factory-push, if any, are kept as history; delete by hand if wanted).");
}
function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + d : "")); } };
  const P = (s) => { try { return parseArgs(s.split(" ").filter(Boolean)); } catch (e) { return { err: e.message }; } };
  ok("args: exactly one part (+ --dry); unknown refused; two parts refused", P("--timer").part === "timer" && P("--home --dry").dry === true && /exactly one/.test(P("--timer --server").err || "") && /unknown/.test(P("--force").err || "") && /exactly one/.test(P("").err || ""));
  const k = ourUnitShas();
  ok("only the unit versions this package generates are removable (2 service variants, 1 timer, 1 slice)", k["traids-scout.service"].length === 2 && k["traids-scout.timer"].length === 1 && k["traids-research.slice"].length === 1);
  const src = fs.readFileSync(__filename, "utf8").replace(/function selftest\(\) \{[\s\S]*?\n\}\n/, "").replace(/\/\*\*[\s\S]*?\*\//g, "");
  ok("rollback's code never names an R309 unit, traids.env as a target, or the R files", !/traids-r309|rm[^\n]*traids\.env|test-registry\.json|read-seals|agent-ledger|change-registry/.test(src));
  ok("--token and --user and --cli each refuse while something still depends on them (timer / scout units)", /run --timer first/.test(src) && /run --server first/.test(src));
  const us = userScript("/home/traids/traids");
  ok("--user: no `userdel ... || true`; refuses while scout has a process or a research unit is active; ACLs dropped (and proved gone) BEFORE userdel; `id scout` must fail after", /^set -eu$/m.test(us) && !/userdel[^\n]*\|\| true/.test(us) && /pgrep -u scout/.test(us) && /traids-research-\*/.test(us) && us.indexOf("setfacl -x u:scout") < us.indexOf("userdel -r scout") && /getfacl -p/.test(us) && us.lastIndexOf("if id scout") > us.indexOf("userdel -r scout") && /USER_REMOVED/.test(us) && us.includes("/home/traids/traids/backend") && /for p in \/home\/traids \/home\/traids\/traids \/home\/traids\/traids\/backend/.test(us));
  const HP = require(path.join(HERE, "home-patch.cjs"));
  ok("--home --dry on the real repo plans without writing (every entry 'nothing to undo' while the patch is not applied)", (() => { const l = HP.revertAll(REPO, { dry: true }); return l.length === HP.MANIFEST.length; })());
  console.log(`rollback selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) {
  let A; try { A = parseArgs(process.argv.slice(2)); } catch (e) { console.error("rollback: " + e.message); process.exitCode = 2; }
  if (A) try {
    if (A.selftest) process.exitCode = selftest() ? 0 : 1;
    else { ({ timer: partTimer, server: partServer, token: partToken, user: partUser, cli: partCli, home: partHome })[A.part](A.dry); process.exitCode = 0; }
  } catch (e) { console.error("rollback: " + e.message); process.exitCode = 1; }
}
module.exports = { parseArgs };
