#!/usr/bin/env node
/**
 * W6 AGENT RUN — the seat wave and the nightly audit, headless on the VPS, in an IP-screened copy of the repo. 2026-10-09
 * (docs/server/wave6-agents). Runs as user scout from traids-w6-seats[-shadow].service / traids-w6-audit.service:
 *
 *   node /home/traids/w6/bin/w6-agent-run.cjs seats [--shadow]
 *   node /home/traids/w6/bin/w6-agent-run.cjs audit
 *   node /home/traids/w6/bin/w6-agent-run.cjs --selftest
 *
 * WHY A WORKSPACE. backend/data's home is the PC (house rule: one home for registry and ledger state; home stays the ONLY writer of the
 * R files, agent-ledger.jsonl and seat-claims.jsonl among them). So the agents never touch a real copy of it. After home's close chain,
 * home pushes an IP-screened WORKSPACE (deploy/server/w6-workspace.cjs) to /home/traids/w6/ws: the code the seats / the audit run, the
 * seat definitions and the server audit skill + workflow (in-house-only lines removed), and the data they read (in-house-only text
 * removed, proved number-for-number identical through reconcile.js and the agent book). Each run COPIES ws into run/<runId> and runs
 * there; the run's own writes stay in it. traids-w6-outbox (user traids, plain code) turns a finished run into ONE outbox record of
 * exactly the allowed deltas; home pulls it and applies it with home's own writers (deploy/server/w6-apply.cjs). Nothing here writes
 * a home file, an R file, or anything outside run/<runId>.
 *
 * seats   ET trading day only · waits (every 5 min) for TODAY's workspace (W6-INPUTS.json session = today, the chain finished today,
 *         kinds include seats) until 18:30 MT, else REFUSES (exit 3: the unit fails and pages) · never twice a session (run/<id>/DONE.json)
 *         · the copy is verified file by file against W6-INPUTS.json · the relayable files' bases kept in run/<id>/.w6-base/ · then the
 *         house's portable wave, automation/seat-wave.pending-server.cjs, UNCHANGED (its per-seat allow-list of entry points, its usage-
 *         limit stop, its never-twice guard), with TRAIDS_STATE_HOME=server: inside the run dir the run dir IS the state home, and the
 *         ownership map makes sure only one host's wave counts (home's evening.bat gates its wave on the same map).
 *         --shadow (the dry period, gated "home" by the unit): the same run, recorded as a shadow; its outbox is never applied.
 * audit   OFF unless /etc/traids/w6-agents.env says TRAIDS_NIGHTLY_AUDIT=on (the operator switched the audit off 2026-10-01) · refuses
 *         without TRAIDS_AUDIT_BUDGET_USD · Friday (ET) trading days only (evening.bat's weekly gate) · waits for today's workspace with
 *         the audit kind, and for today's seat run when the seats are server-owned (never beside the wave) · backend/audit-guard.js
 *         --check in the run dir · claude -p "/nightly-audit-server <series>" (the server skill: record only — no fix, no change-registry,
 *         no agent-ledger; filed items go in the record) with evening.bat's allow-list + deny rules, --max-budget-usd, --max-turns 400.
 * The child environment is an allowlist (HOME, PATH, LANG, TZ, the subscription token CLAUDE_CODE_OAUTH_TOKEN): no ANTHROPIC_* ever.
 * Exit: the wave's / the audit's own exit (0 ok; 1 a seat did not seal or a usage limit stopped it) · 0 nothing to do · 3 refused (no
 * workspace for today) · 2 bad arguments. Test mode (W6_TEST=1): W6_WS, W6_RUN, W6_MAP, W6_NOW, W6_POLL_MS, W6_WAVE_SCRIPT, W6_CLAUDE.
 */
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
const TEST = process.env.W6_TEST === "1";
const WS = TEST && process.env.W6_WS ? process.env.W6_WS : "/home/traids/w6/ws";
const RUN = TEST && process.env.W6_RUN ? process.env.W6_RUN : "/home/traids/w6/run";
const MAP = TEST && process.env.W6_MAP ? process.env.W6_MAP : "/home/traids/traids/backend/data/host-ownership.json";
const nowMs = () => (TEST && process.env.W6_NOW ? Date.parse(process.env.W6_NOW) + (Date.now() - T0) : Date.now());
const T0 = Date.now();
const POLL_MS = TEST && process.env.W6_POLL_MS ? Number(process.env.W6_POLL_MS) : 5 * 60000;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const readJ = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const etDow = (ms) => new Date(ms).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short" });
const mtMin = (ms) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return +p.hour * 60 + +p.minute; };
const DEADLINE_MT = 18 * 60 + 30;
/** the relayable files of a seat run (their bases are kept so the outbox never depends on tomorrow's workspace) */
const SEAT_APPENDS = ["seat-claims.jsonl", "agent-ledger.jsonl", "portfolio-manager-plans.jsonl", "agent-book-ledger.jsonl", "ht-memo-history.jsonl", "seat-wave-history.jsonl"];
const SEAT_REPLACES = ["risk-governor.json", "agent-book.json", "ht-memo-seal.json", "seat-wave-status.json"];
const log = (s) => console.log(`[${new Date().toISOString()}] w6-agent-run: ${s}`);

/** Pure: is the workspace today's? -> null or why not */
function inputsProblem(inp, kind, today) {
  if (!inp || inp.spec !== "w6-inputs-v1") return "no workspace (W6-INPUTS.json absent or not w6-inputs-v1)";
  if (inp.session !== today) return `the workspace is for session ${inp.session}, not today's ${today}`;
  if (!Array.isArray(inp.kinds) || !inp.kinds.includes(kind)) return `the workspace was built without the ${kind} kind (${(inp.kinds || []).join(", ") || "none"})`;
  if (!inp.chainFinishedAt || etDay(Date.parse(inp.chainFinishedAt)) !== today) return `the workspace's close chain finished ${inp.chainFinishedAt || "never"}, not today`;
  if (!inp.files || typeof inp.files !== "object") return "W6-INPUTS.json lists no files";
  return null;
}
function isTradingDay(ms) {
  const d = etDow(ms); if (d === "Sat" || d === "Sun") return false;
  try { return !require(path.join(WS, "backend", "lib", "run-window.js")).marketHoliday(etDay(ms)); } catch { return true; }   // unknown -> the wave's own guard decides
}
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
/** wait for today's workspace until 18:30 MT -> the inputs or null */
function waitInputs(kind) {
  for (let first = true; ; first = false) {
    const inp = readJ(path.join(WS, "W6-INPUTS.json")), why = inputsProblem(inp, kind, etDay(nowMs()));
    if (!why) return inp;
    if (mtMin(nowMs()) >= DEADLINE_MT) { log(`REFUSED — ${why}; the deadline 18:30 MT has passed. No ${kind} run tonight (home pushes the workspace at the end of its close chain: deploy/server/w6-workspace.cjs)`); return null; }
    if (first) log(`waiting for today's workspace (${why}) — every ${Math.round(POLL_MS / 60000) || POLL_MS + " ms"} min until 18:30 MT`);
    sleep(POLL_MS);
  }
}
const walk = (d, base = d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, base, out); else if (e.isFile()) out.push(path.relative(base, p).replace(/\\/g, "/")); } return out; };
/** copy ws -> dir, verify every listed file by sha, keep the relayable bases */
function prepare(inp, runId, kind) {
  const dir = path.join(RUN, runId);
  if (fs.existsSync(path.join(dir, "DONE.json"))) return { done: true, dir };
  if (fs.existsSync(dir)) { const keep = `${dir}.crashed-${new Date(nowMs()).toISOString().replace(/[:.]/g, "")}`; fs.renameSync(dir, keep); log(`an unfinished run dir was kept as ${path.basename(keep)} (never relayed)`); }
  fs.cpSync(WS, dir, { recursive: true });
  const bad = Object.entries(inp.files).filter(([rel, h]) => { try { return sha(fs.readFileSync(path.join(dir, rel))) !== h; } catch { return true; } }).map(([rel]) => rel);
  if (bad.length) { fs.renameSync(dir, `${dir}.badcopy-${Date.now()}`); throw new Error(`the workspace copy does not match W6-INPUTS.json (${bad.slice(0, 5).join(", ")}${bad.length > 5 ? ", …" : ""}) — a push in progress? Nothing run`); }
  const base = path.join(dir, ".w6-base"); fs.mkdirSync(base, { recursive: true });
  if (kind === "seats") for (const f of [...SEAT_APPENDS, ...SEAT_REPLACES]) { const src = path.join(dir, "backend", "data", f); if (fs.existsSync(src)) fs.copyFileSync(src, path.join(base, f)); }
  fs.writeFileSync(path.join(dir, "W6-RUN.json"), JSON.stringify({ spec: "w6-run-v1", runId, kind, startedAt: new Date(nowMs()).toISOString(), inputsSha: sha(fs.readFileSync(path.join(WS, "W6-INPUTS.json"))), files: inp.files, session: inp.session }, null, 1));
  return { done: false, dir };
}
/** the child environment: an allowlist; never an ANTHROPIC_* name */
function childEnv(parent, extra = {}) {
  const e = {}; for (const k of ["HOME", "USER", "LOGNAME", "LANG", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_BIN"]) if (parent[k]) e[k] = parent[k];
  Object.assign(e, { PATH: "/usr/local/bin:/usr/bin:/bin", TZ: "UTC", DISABLE_AUTOUPDATER: "1", LANG: e.LANG || "C.UTF-8" }, extra);
  if (process.platform === "win32") for (const k of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "Path"]) if (parent[k]) e[k] = parent[k];   // test harness only
  if (!e.CLAUDE_BIN && fs.existsSync("/usr/bin/claude")) e.CLAUDE_BIN = "/usr/bin/claude";   // the apt binary research-stage01 installed
  const bad = Object.keys(e).filter((k) => /^(ANTHROPIC_|CLAUDE_CODE_USE_|AWS_|GOOGLE_|AZURE_)/i.test(k)); if (bad.length) throw new Error("child env would carry " + bad.join(", "));
  return e;
}
function finish(dir, o) { fs.writeFileSync(path.join(dir, "DONE.json"), JSON.stringify({ spec: "w6-done-v1", finishedAt: new Date(nowMs()).toISOString(), ...o }, null, 1)); }
function seats(shadow) {
  const now = nowMs(), today = etDay(now);
  if (!isTradingDay(now)) { log(`${today} is not a trading day (ET) — no seat wave`); return 0; }
  const inp = waitInputs("seats"); if (!inp) return 3;
  const runId = `seats-${today}${shadow ? "-shadow" : ""}`, P = prepare(inp, runId, "seats");
  if (P.done) { log(`${runId} already ran (DONE.json) — never twice a session`); return 0; }
  const script = TEST && process.env.W6_WAVE_SCRIPT ? process.env.W6_WAVE_SCRIPT : path.join(P.dir, "automation", "seat-wave.pending-server.cjs");
  log(`${runId}: the portable seat wave in ${P.dir}${shadow ? " (SHADOW: recorded, never applied)" : ""}`);
  const t0 = Date.now(), r = cp.spawnSync(process.execPath, [script], { cwd: P.dir, env: childEnv(process.env, { TRAIDS_STATE_HOME: "server", ...(TEST && process.env.W6_NOW ? { W6_NOW: process.env.W6_NOW } : {}) }), encoding: "utf8", timeout: 100 * 60000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  fs.writeFileSync(path.join(P.dir, "w6-run.log"), String(r.stdout || "") + String(r.stderr || ""));
  const status = readJ(path.join(P.dir, "backend", "data", "seat-wave-status.json"));
  finish(P.dir, { kind: "seats", shadow, exit: r.status, signal: r.signal || null, ms: Date.now() - t0, wave: status && status.session === today ? { sealedSeats: status.sealedSeats, ranSeats: status.ranSeats, stopped: status.stopped || null, totalCost: status.totalCost } : null });
  log(`${runId}: wave exit ${r.status}${status && status.session === today ? ` · sealed ${status.sealedSeats}/${status.ranSeats}` : " · no status for today"}`);
  return r.status == null ? 1 : r.status;
}
/** the audit's argv: evening.bat's allow-list, the kit's deny rules, the budget and turn caps (deploy/server/nightly-audit.sh) */
function auditArgv(series, budget) {
  return ["-p", `/nightly-audit-server ${series}`, "--output-format", "text", "--max-budget-usd", String(budget), "--max-turns", "400", "--setting-sources", "project", "--strict-mcp-config",
    "--allowedTools", "Read", "Glob", "Grep", "Skill", "Workflow", "Agent", "Write", "Edit", "Bash(node *)", "Bash(cd *)",
    "--disallowedTools", "WebFetch", "WebSearch", "Bash(node -e *)", "Bash(node --eval *)", "Bash(node -p *)", "Bash(node --print *)", "Bash(node -)", "Bash(node - *)",
    "Bash(node --input-type *)", "Bash(node -r *)", "Bash(node --require *)", "Bash(node --import *)", "Bash(node --loader *)", "Bash(NODE_OPTIONS=*)", "Bash(env *)",
    "Edit(.claude/**)", "Edit(automation/**)", "Edit(deploy/**)", "Edit(backend/*.js)", "Edit(backend/lib/**)", "Edit(~/.claude/**)", "Edit(~/.ssh/**)",
    "Read(~/.claude/.credentials.json)", "Read(~/.ssh/**)", "Read(//etc/traids/**)", "Read(//proc/**)"];
}
function audit() {
  const now = nowMs(), today = etDay(now);
  if (process.env.TRAIDS_NIGHTLY_AUDIT !== "on") { log("[audit OFF by operator 2026-10-01 — skipped] (/etc/traids/w6-agents.env TRAIDS_NIGHTLY_AUDIT=on turns it on)"); return 0; }
  const budget = String(process.env.TRAIDS_AUDIT_BUDGET_USD || "");
  if (!/^\d+(\.\d+)?$/.test(budget) || !(Number(budget) > 0)) { log(`[audit REFUSED: TRAIDS_AUDIT_BUDGET_USD is '${budget || "<unset>"}' — the operator names the spend cap first]`); return 1; }
  if (!isTradingDay(now)) { log(`${today} is not a trading day — audit skipped`); return 0; }
  if (etDow(now) !== "Fri") { log(`[audit weekly gate: ${etDow(now)} is not Friday — skipped]`); return 0; }
  const inp = waitInputs("audit"); if (!inp) return 3;
  const map = readJ(MAP), seatsServer = !!(map && map.units && map.units["w6-seats"] === "server");
  if (seatsServer) { const f = path.join(RUN, `seats-${today}`, "DONE.json"); for (let i = 0; !fs.existsSync(f); i++) { if (i >= 48) { log("[audit REFUSED: the seat wave has not finished after 4 h — never beside it]"); return 3; } if (i === 0) log("[waiting for the seat wave to finish]"); sleep(POLL_MS); } }
  const runId = `audit-${today}`, P = prepare(inp, runId, "audit");
  if (P.done) { log(`${runId} already ran`); return 0; }
  const g = cp.spawnSync(process.execPath, [path.join(P.dir, "backend", "audit-guard.js"), "--check"], { cwd: P.dir, encoding: "utf8", windowsHide: true });
  if (g.status >= 2) { log(`[audit skipped by the calendar guard] ${String(g.stdout).trim().slice(0, 200)}`); finish(P.dir, { kind: "audit", skipped: "calendar guard", exit: 0 }); return 0; }
  const series = fs.existsSync(path.join(P.dir, "backend", "data", "audit-nightly")) && fs.readdirSync(path.join(P.dir, "backend", "data", "audit-nightly")).some((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)) ? "all" : "defense";
  const bin = TEST && process.env.W6_CLAUDE ? JSON.parse(process.env.W6_CLAUDE) : [childEnv(process.env).CLAUDE_BIN || "claude"];
  log(`${runId}: series ${series} · budget $${budget}`);
  const t0 = Date.now(), r = cp.spawnSync(bin[0], [...bin.slice(1), ...auditArgv(series, budget)], { cwd: P.dir, env: childEnv(process.env, { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0" }), encoding: "utf8", timeout: 5 * 3600000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  fs.writeFileSync(path.join(P.dir, "w6-run.log"), String(r.stdout || "") + String(r.stderr || ""));
  if (r.status !== 0) cp.spawnSync(process.execPath, [path.join(P.dir, "backend", "audit-guard.js"), "--release"], { cwd: P.dir, windowsHide: true });
  finish(P.dir, { kind: "audit", exit: r.status, signal: r.signal || null, ms: Date.now() - t0, series, recorded: fs.existsSync(path.join(P.dir, "backend", "data", "audit-nightly", `${today}.json`)) });
  log(`${runId}: exit ${r.status}`);
  return r.status == null ? 1 : r.status;
}

function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + String(d).slice(0, 300) : "")); } };
  const good = { spec: "w6-inputs-v1", session: "2026-10-14", kinds: ["seats"], chainFinishedAt: "2026-10-14T21:40:00Z", files: {} };
  ok("inputs: today's seats workspace passes; yesterday's, one without the kind, one whose chain finished yesterday, none -> refused", inputsProblem(good, "seats", "2026-10-14") === null && /not today's/.test(inputsProblem({ ...good, session: "2026-10-13" }, "seats", "2026-10-14") || "") && /without the audit kind/.test(inputsProblem(good, "audit", "2026-10-14") || "") && /finished 2026-10-13/.test(inputsProblem({ ...good, chainFinishedAt: "2026-10-13T21:40:00Z" }, "seats", "2026-10-14") || "") && /no workspace/.test(inputsProblem(null, "seats", "2026-10-14") || ""));
  const e = childEnv({ HOME: "/home/scout", PATH: "/evil", CLAUDE_CODE_OAUTH_TOKEN: "x".repeat(40), ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "u", ALPACA_KEY_ID: "PK", TELEGRAM_BOT_TOKEN: "t", NODE_OPTIONS: "--require x" }, { TRAIDS_STATE_HOME: "server" });
  ok("child env: an allowlist — the token passes; ANTHROPIC_* / ALPACA / TELEGRAM / NODE_OPTIONS never; PATH fixed; TZ=UTC; the workspace state home", e.CLAUDE_CODE_OAUTH_TOKEN && !Object.keys(e).some((k) => /^ANTHROPIC|ALPACA|TELEGRAM|NODE_OPTIONS/.test(k)) && e.PATH === "/usr/local/bin:/usr/bin:/bin" && e.TZ === "UTC" && e.TRAIDS_STATE_HOME === "server");
  const a = auditArgv("defense", 25), allow = a.slice(a.indexOf("--allowedTools") + 1, a.indexOf("--disallowedTools")), deny = a.slice(a.indexOf("--disallowedTools") + 1);
  ok("audit argv: the server skill, the budget cap, project settings only, strict MCP; evening.bat's allow-list; web tools and every node eval form denied; no bypass", a[1] === "/nightly-audit-server defense" && a[a.indexOf("--max-budget-usd") + 1] === "25" && a.includes("--strict-mcp-config") && a[a.indexOf("--setting-sources") + 1] === "project" && JSON.stringify(allow) === JSON.stringify(["Read", "Glob", "Grep", "Skill", "Workflow", "Agent", "Write", "Edit", "Bash(node *)", "Bash(cd *)"]) && ["WebFetch", "WebSearch", "Bash(node -e *)", "Read(//etc/traids/**)", "Edit(backend/lib/**)"].every((d) => deny.includes(d)) && !a.some((x) => /bypass|dangerously/i.test(x)));
  ok("the relayable seat files are exactly the wave's own outputs (no R file, no measurement book)", ![...SEAT_APPENDS, ...SEAT_REPLACES].some((f) => /test-registry|read-seals|change-registry|board_positions|trade_log/.test(f)) && SEAT_APPENDS.includes("seat-claims.jsonl") && SEAT_APPENDS.includes("agent-ledger.jsonl"));
  console.log(`w6-agent-run selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}
if (require.main === module) {
  const a = process.argv.slice(2);
  try {
    if (a[0] === "--selftest" && a.length === 1) process.exitCode = selftest() ? 0 : 1;
    else if (a[0] === "seats" && (a.length === 1 || (a.length === 2 && a[1] === "--shadow"))) process.exitCode = seats(a[1] === "--shadow");
    else if (a[0] === "audit" && a.length === 1) process.exitCode = audit();
    else { console.error("usage: w6-agent-run.cjs seats [--shadow] | audit | --selftest"); process.exitCode = 2; }
  } catch (e) { log("FAILED — " + (e && e.message || e)); process.exitCode = 1; }
}
module.exports = { inputsProblem, childEnv, auditArgv, SEAT_APPENDS, SEAT_REPLACES };
