#!/usr/bin/env node
/**
 * DEPLOY — research engine stage 0 + stage 1 (scout only), 2026-10-06. Run by Josh from the repo root on the PC. Ordered and
 * idempotent: every step re-reads the real state and skips what is done. Fail-closed: a refused or failed step stops the run and the
 * steps that remain are printed, in order. Nothing here places an order, registers a test, or touches R309.
 *
 *   node docs/server/research-stage01/deploy.cjs                 every step, in order
 *   node docs/server/research-stage01/deploy.cjs --step <name>   one step (it still runs the home precheck)
 *   node docs/server/research-stage01/deploy.cjs --status        read-only
 *   node docs/server/research-stage01/deploy.cjs --selftest      pure parts; no ssh
 * There is NO --dry: --dry and any unknown argument are refused (exit 2) before anything runs (use --status, home-patch.cjs --plan,
 * push-inputs.cjs --dry, pull-factory.cjs --dry, place-claude-token.cjs --dry).
 *
 * STEPS
 *   precheck  read-only. Home: every file home-patch.cjs edits is at its staged base sha (or already applied) — drift REFUSES; the
 *             package selftests pass (selftest.cjs). VPS: install-server precheck (ssh, sudo -n, Ubuntu 24.04, node, flock, systemd).
 *   home      REFUSED on a trading day from 14:00 MT until chain-status.json records today's finish (chainRefusal: the close chain runs
 *             the readers this step patches, and writes chain-status.json only when it ends). Then:
 *             home-patch applyAll (registry-view, registry-namespace-check, HOST_OF_RECORD.json through writeJsonAtomic, null-bar family
 *             counts, the atomic-write F#### guard, test-triage / adjudicator / claim-drift F listing, the registry lens scope, the
 *             register-test line); then backend/registry-namespace-check.js must PASS and backend/test-triage.js + adjudicator.js
 *             --selftest must pass in place.
 *   users · tree · cli · units      install-server.cjs (user scout, the factory tree, the CLI by the signed apt repo, slice + units)
 *   token     place-claude-token.cjs — SKIPPED (not failed) while CLAUDE_SERVER_OAUTH_TOKEN is absent from backend/.env; then smoke and
 *             scout-on are skipped too, with the command to resume.
 *   smoke     claude auth status = oauth_token; claude -p "reply ok" --model opus via claude-run.cjs as scout: exit 0, no ANTHROPIC vars
 *   inputs    make-avoid-list + push-inputs (avoid-list.json + the redacted registry -> factory/in, 0440)
 *   scout-on  enable traids-scout.timer (Mon-Fri 17:30 MT; the ramp holds scout runs until 2026-10-12). FIRST-RUN SHADOW: the home
 *             alpha-scout-internet task stays enabled — disabling it is Josh's yes at cutover (NOTES.md).
 *   pull      pull-factory.cjs once (proves the home pull path end-to-end; factory-pulled/ appears at home)
 * Exit 0 ok / skipped-with-reason · 1 a step failed or refused · 2 bad arguments (nothing done).
 */
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process");
const HERE = __dirname, REPO = path.resolve(HERE, "..", "..", "..");
const STEPS = ["precheck", "home", "users", "tree", "cli", "units", "token", "smoke", "inputs", "scout-on", "pull"];
const log = (s) => console.log(s);
const node = (file, args = [], opt = {}) => cp.spawnSync(process.execPath, [file, ...args], { cwd: REPO, encoding: "utf8", timeout: 900000, windowsHide: true, ...opt });

function precheck({ quick = false } = {}) {
  log("== precheck (read-only)");
  const HP = require(path.join(HERE, "home-patch.cjs"));
  const st = HP.MANIFEST.map((e) => ({ e, s: HP.stateOf(e) })), drift = st.filter((x) => x.s.state === "drift");
  if (drift.length) throw new Error("home files drifted since staging — REFUSED: " + drift.map((x) => x.s.why).join("; "));
  log(`   home: ${st.filter((x) => x.s.state === "base").length} files at their staged base, ${st.filter((x) => x.s.state === "applied").length} already applied, no drift`);
  if (!quick) {
    const r = node(path.join(HERE, "selftest.cjs"));
    if (r.status !== 0) throw new Error("package selftests FAILED — REFUSED:\n" + String(r.stdout).split("\n").filter((l) => /FAIL/.test(l)).slice(0, 12).join("\n"));
    log("   package selftests: " + String(r.stdout).trim().split("\n").pop());
  }
  require(path.join(HERE, "install-server.cjs")).precheck();
}
const CHAIN_WINDOW_FROM_MIN = 14 * 60;   // 14:00 MT: the "TRAIDS" close task fires 14:15 MT on weekdays (settle cycle, then close-chain.cjs)
const mtDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Denver" });
const mtMinutes = (ms) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return +p.hour * 60 + +p.minute; };
/**
 * Pure: refuse the home step while the close chain may be running (it runs test-triage / adjudicator / claim-drift; migration plan
 * M6). 2026-10-07 review fix: automation/close-chain.cjs writes chain-status.json ONCE, at the end (started and finished together),
 * so while a chain runs the file still holds the PREVIOUS run and "started, not finished" never appears. The guard is therefore
 * date-based, like backend/chain-wait.js: on a trading day, from 14:00 MT until chain-status.json records a finish on today's MT date,
 * the home step is refused. (The started-not-finished test stays as a second check, for a chain that ever writes a running marker.)
 * A trading day whose chain never finishes stays refused until midnight MT — fail-closed; the message says so.
 */
function chainRefusal(cs, nowMs, { tradingDay = true } = {}) {
  if (!cs || !cs.started) return "backend/data/chain-status.json unreadable — cannot tell whether the close chain is running; REFUSED (fail-closed)";
  const s = Date.parse(cs.started), f = cs.finished ? Date.parse(cs.finished) : NaN;
  if (!(f >= s) && nowMs - s < 6 * 3600000) return `the close chain is running (started ${cs.started}, not finished) — re-run --step home after it finishes`;
  if (!tradingDay || mtMinutes(nowMs) < CHAIN_WINDOW_FROM_MIN) return null;
  if (f >= s && mtDay(f) === mtDay(nowMs)) return null;
  return `today's close chain has not recorded a finish yet (chain-status.json: last finish ${cs.finished || "none"}, MT day ${mtDay(nowMs)}) — on a trading day the home step is refused from 14:00 MT until it does (chain-status.json is written only when the chain ends). Re-run --step home after the chain finishes (backend/chain-wait.js shows it), or before 14:00 MT`;
}
/** Is today (ET) a US equity trading day? Same rule as backend/trading-day.js (lib/run-window.js MARKET_HOLIDAYS). Unknown -> true (fail-closed). */
function isTradingDay(nowMs) {
  try {
    const et = new Date(nowMs).toLocaleDateString("en-CA", { timeZone: "America/New_York" }), dow = new Date(et + "T12:00:00Z").getUTCDay();
    if (dow === 0 || dow === 6) return false;
    return !require(path.join(REPO, "backend", "lib", "run-window.js")).marketHoliday(et);
  } catch { return true; }
}
function stepHome() {
  log("== home (registry-view, HOST_OF_RECORD, family counts, readers, F#### guard)");
  let cs = null; try { cs = JSON.parse(fs.readFileSync(path.join(REPO, "backend", "data", "chain-status.json"), "utf8")); } catch { cs = null; }
  const now = Date.now(), cr = chainRefusal(cs, now, { tradingDay: isTradingDay(now) }); if (cr) throw new Error(cr);
  const HP = require(path.join(HERE, "home-patch.cjs"));
  for (const l of HP.applyAll(REPO)) log("   " + l);
  for (const [f, args, re] of [["backend/registry-namespace-check.js", [], /PASS/], ["backend/lib/registry-view.js", ["--selftest"], / 0 failed/], ["backend/test-triage.js", ["--selftest"], /selftest PASS/], ["backend/adjudicator.js", ["--selftest"], /selftest PASS/]]) {
    const r = node(path.join(REPO, f), args, { cwd: path.join(REPO, "backend") });
    if (r.status !== 0 || !re.test(r.stdout)) throw new Error(`${f} ${args.join(" ")} did not pass after the patch (exit ${r.status}) — undo with: node docs/server/research-stage01/rollback.cjs --home\n${String(r.stdout + r.stderr).slice(-600)}`);
    log(`   ${f} ${args.join(" ")}: ${String(r.stdout).trim().split("\n").pop().slice(0, 140)}`);
  }
  require(path.join(HERE, "install-server.cjs")).record("home", { ok: true });
}
function stepInputs() {
  log("== inputs (avoid-list + redacted registry -> factory/in)");
  const r = node(path.join(HERE, "push-inputs.cjs"));
  log(String(r.stdout || "").trim().split("\n").map((l) => "   " + l).join("\n"));
  if (r.status !== 0) throw new Error("push-inputs FAILED: " + String(r.stderr || r.stdout).trim().slice(0, 400));
  require(path.join(HERE, "install-server.cjs")).record("inputs", { ok: true });
}
function stepPull() {
  log("== pull (factory/out + factory/var -> backend/data/factory-pulled)");
  const r = node(path.join(HERE, "pull-factory.cjs"));
  log(String(r.stdout || "").trim().split("\n").map((l) => "   " + l).join("\n"));
  if (r.status !== 0) throw new Error("pull-factory FAILED: " + String(r.stderr || r.stdout).trim().slice(0, 400));
  require(path.join(HERE, "install-server.cjs")).record("pull", { ok: true });
}
/** Pure: after a failure in `failed`, the commands that remain, in order. */
function remainingSteps(plan, failed) {
  const i = failed === "precheck" ? 0 : plan.indexOf(failed), left = i < 0 ? plan : plan.slice(i);
  return ["Fix the cause, then run, in order (each step re-reads the real state and skips what is done):", ...left.map((s) => `  node docs/server/research-stage01/deploy.cjs --step ${s}`)];
}
/** Pure: the command line -> { mode, step }. Unknown THROWS before anything runs; --dry is refused (no dry mode). */
function parseArgs(argv) {
  const out = { mode: "deploy", step: null }, modes = [];
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--dry") throw new Error("deploy.cjs has NO dry mode — nothing was done. Read-only views: --status, home-patch.cjs --plan, push-inputs.cjs --dry, pull-factory.cjs --dry, place-claude-token.cjs --dry");
    if (x === "--selftest" || x === "--status") modes.push(x);
    else if (x === "--step") { const v = argv[++i]; if (!STEPS.includes(v)) throw new Error(`--step needs one of ${STEPS.join(" | ")} (got ${JSON.stringify(v)})`); if (out.step) throw new Error("give --step once"); out.step = v; }
    else throw new Error(`unknown argument ${JSON.stringify(x)} — nothing was done. deploy.cjs takes: --step <${STEPS.join("|")}> · --status · --selftest`);
  }
  if (modes.length > 1 || (modes.length && out.step)) throw new Error("give --selftest or --status on its own — nothing was done");
  if (modes.length) out.mode = modes[0].slice(2);
  return out;
}
function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + d : "")); } };
  const P = (s) => { try { return parseArgs(s.split(" ").filter(Boolean)); } catch (e) { return { err: e.message }; } };
  ok("args: --dry refused everywhere; unknown flags refused; --step needs a known step; modes alone", /NO dry mode/.test(P("--dry").err || "") && /NO dry mode/.test(P("--step home --dry").err || "") && /unknown argument/.test(P("--force").err || "") && /--step needs/.test(P("--step bogus").err || "") && /on its own/.test(P("--status --step home").err || ""));
  ok("args: the valid forms parse", P("").mode === "deploy" && P("--step smoke").step === "smoke" && P("--status").mode === "status" && P("--selftest").mode === "selftest");
  ok("order: precheck, home, then the server (users before tree before cli), token before smoke, smoke before scout-on, pull last", STEPS.join() === "precheck,home,users,tree,cli,units,token,smoke,inputs,scout-on,pull");
  const rs = remainingSteps(STEPS.slice(1), "units").join("\n");
  ok("a failure prints the steps that remain, in order, starting at the failed one", /--step units\n\s+node \S+ --step token[\s\S]*--step pull$/.test(rs) && !/--step home/.test(rs), rs);
  // the REAL shape while a chain runs: chain-status.json still holds YESTERDAY's run, started and finished (close-chain writes it once,
  // at the end) — today 2026-10-07 15:00 MT (21:00Z) that must refuse
  const now = Date.parse("2026-10-07T21:00:00Z"), yesterday = { started: "2026-10-06T20:15:50.021Z", finished: "2026-10-06T21:32:06.966Z" };
  ok("home step: during today's chain window the file still shows yesterday's finished run -> REFUSED (the shape close-chain.cjs really writes)", /has not recorded a finish yet/.test(chainRefusal(yesterday, now) || ""), chainRefusal(yesterday, now));
  ok("home step: today's finish recorded -> allowed; before 14:00 MT -> allowed; a weekend / holiday -> allowed; unreadable -> REFUSED", chainRefusal({ started: "2026-10-07T20:15:00Z", finished: "2026-10-07T21:40:00Z" }, Date.parse("2026-10-07T22:00:00Z")) === null && chainRefusal(yesterday, Date.parse("2026-10-07T19:59:00Z")) === null && /has not recorded/.test(chainRefusal(yesterday, Date.parse("2026-10-07T20:00:00Z")) || "") && chainRefusal(yesterday, now, { tradingDay: false }) === null && /unreadable/.test(chainRefusal(null, now) || ""));
  ok("home step: a chain that never finishes keeps the step refused until midnight MT (23:59 MT), and allowed from 00:00 MT", /has not recorded/.test(chainRefusal(yesterday, Date.parse("2026-10-08T05:59:00Z")) || "") && chainRefusal(yesterday, Date.parse("2026-10-08T06:00:00Z")) === null);
  ok("home step: a running marker (started, no finish, < 6 h) is still refused", /running/.test(chainRefusal({ started: "2026-10-07T20:15:00Z" }, now) || ""));
  ok("trading day: 2026-10-07 (Wed) yes, 2026-10-10 (Sat) no, 2026-11-26 (Thanksgiving) no", isTradingDay(Date.parse("2026-10-07T18:00:00Z")) === true && isTradingDay(Date.parse("2026-10-10T18:00:00Z")) === false && isTradingDay(Date.parse("2026-11-26T18:00:00Z")) === false);
  const code = fs.readFileSync(__filename, "utf8").replace(/function selftest\(\) \{[\s\S]*?\n\}\n/, "").replace(/\/\*\*[\s\S]*?\*\//g, "");
  ok("deploy's code (comments and this selftest aside) never disables the home scout task, never registers, never names an R309 unit", !/schtasks|scheduled-tasks|register-test|traids-r309/.test(code));
  console.log(`deploy selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}
function status() {
  const HP = require(path.join(HERE, "home-patch.cjs"));
  for (const e of HP.MANIFEST) log(`home     ${HP.stateOf(e).state.padEnd(8)} ${e.rel}`);
  require(path.join(HERE, "install-server.cjs")).status();
  const st = require(path.join(HERE, "install-server.cjs")).readState().steps || {};
  for (const k of ["home", "inputs", "pull"]) log(`${k.padEnd(9)} ${st[k] ? `${st[k].ok ? "ok" : "NOT ok"} at ${st[k].at}` : "not run"}`);
}

if (require.main === module) {
  let A; try { A = parseArgs(process.argv.slice(2)); } catch (e) { console.error("deploy: " + e.message); process.exitCode = 2; }
  let RUNNING = null;
  if (A) try {
    if (A.mode === "selftest") process.exitCode = selftest() ? 0 : 1;
    else if (A.mode === "status") { status(); process.exitCode = 0; }
    else {
      const I = require(path.join(HERE, "install-server.cjs"));
      const fns = { home: stepHome, users: I.stepUsers, tree: I.stepTree, cli: I.stepCli, units: I.stepUnits, token: I.stepToken, smoke: I.stepSmoke, inputs: stepInputs, "scout-on": I.stepScoutOn, pull: stepPull };
      const plan = A.step ? [A.step] : STEPS.slice(1);
      RUNNING = "precheck"; precheck({ quick: !!A.step });
      if (A.step === "precheck") { log("deploy: precheck ok"); process.exitCode = 0; }
      else {
        let tokenPlaced = true;
        for (const s of plan) {
          if (!A.step && !tokenPlaced && (s === "smoke" || s === "scout-on")) { log(`== ${s} — SKIPPED until the token is placed (add CLAUDE_SERVER_OAUTH_TOKEN to backend/.env, then: --step token, --step smoke, --step scout-on)`); continue; }
          RUNNING = s; const r = fns[s](); if (s === "token") tokenPlaced = r !== false;
        }
        RUNNING = null;
        log(`deploy: done${A.step ? " (step " + A.step + ")" : ""}${tokenPlaced ? "" : " — token, smoke and scout-on still to run"}. Cutover of the home scout is Josh's yes (NOTES.md).`);
        process.exitCode = 0;
      }
    }
  } catch (e) {
    console.error("deploy: " + (RUNNING ? `step ${RUNNING} FAILED — ` : "") + e.message);
    if (A && A.mode === "deploy" && RUNNING) for (const l of remainingSteps(A.step ? [A.step] : STEPS.slice(1), RUNNING)) console.error(l);
    process.exitCode = 1;
  }
}
module.exports = { parseArgs, remainingSteps, STEPS };
