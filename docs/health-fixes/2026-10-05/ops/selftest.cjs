#!/usr/bin/env node
/**
 * OPS HEALTH FIX 2026-10-05 — package selftest. Writes nothing outside os.tmpdir(); never runs a runner in a live mode, never requires one.
 *   node selftest.cjs [--part breaker|selfheal|closearm|tasks|deploy|all] [--deployed]   (deploy = deploy-sandbox.cjs, temp mirror)
 *     default    : the STAGED copies, compared with the live files they were built from (base sha in manifest.json)
 *     --deployed : the LIVE files after deploy.cjs, compared with the backups deploy.cjs made
 * Exit 0 only when every check of the selected parts passes.
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), Module = require("module"), { spawnSync } = require("child_process");
const L = require("./lib.cjs");
const { PKG, REPO } = L;
const argv = process.argv.slice(2), DEPLOYED = argv.includes("--deployed");
const part = (argv.includes("--part") ? argv[argv.indexOf("--part") + 1] : "all") || "all";
const M = L.loadManifest();
const fileOf = (rel) => M.files.find((f) => f.live === rel);
const target = (rel) => (DEPLOYED ? path.join(REPO, rel) : path.join(PKG, fileOf(rel).staged));
const base = (rel) => (DEPLOYED ? L.backupPathFor(rel) : path.join(REPO, rel));
const results = []; const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + String(detail).slice(0, 220) : ""}`); };
const node = (args, opts = {}) => spawnSync(process.execPath, args, { encoding: "utf8", timeout: opts.timeout || 600000, cwd: opts.cwd || REPO, env: { ...process.env, ...(opts.env || {}) }, windowsHide: true });
function loadCjs(file, anchor) {             // compile a file's TEXT as CommonJS, resolving its requires as if it sat at `anchor` (no ESM detection)
  const m = new Module(anchor, null); m.filename = anchor; m.paths = Module._nodeModulePaths(path.dirname(anchor)); m._compile(fs.readFileSync(file, "utf8"), anchor); return m.exports;
}
const baseOk = (rel) => { const f = fileOf(rel), s = L.shaFile(base(rel)); check(`${rel}: the pre-change version is the recorded base (${f.baseSha.slice(0, 12)})`, s === f.baseSha, s.slice(0, 12)); return s === f.baseSha; };
const targetOk = (rel) => { const f = fileOf(rel), s = L.shaFile(target(rel)); check(`${rel}: ${DEPLOYED ? "live" : "staged"} copy is the manifest's staged sha (${f.stagedSha.slice(0, 12)})`, s === f.stagedSha, s.slice(0, 12)); };
const eolOk = (rel) => { const b = L.eolOf(fs.readFileSync(base(rel))), t = L.eolOf(fs.readFileSync(target(rel))); check(`${rel}: newline style preserved (${b})`, b === t && b === fileOf(rel).eol, `base ${b} target ${t}`); };
const syntaxOk = (rel) => { if (!/\.c?js$/.test(rel)) return; const r = node(["--check", target(rel)]); check(`${rel}: node --check`, r.status === 0, (r.stderr || "").trim().split("\n")[0]); };

function partBreaker() {
  for (const rel of ["backend/lib/risk-policy.js", "backend/traids-server-v2.js"]) { baseOk(rel); targetOk(rel); eolOk(rel); syntaxOk(rel); }
  const anchor = path.join(REPO, "backend", "lib", "risk-policy.js");
  const OLD = loadCjs(base("backend/lib/risk-policy.js"), anchor), NEW = loadCjs(target("backend/lib/risk-policy.js"), anchor);
  const keep = ["account", "baseRiskPct", "capR", "dailyLossHaltDollars", "worstCaseOpenCapPct", "maxConcurrentTickets", "effectiveFrom", "exemptSleeves", "boardClassesOff", "boardStrategiesOff", "familyStakeMult", "ratchet", "optionsSleeves", "proposalsSleeve", "r51Sleeve", "haltsAlterExits", "epochs"];
  const diff = keep.filter((k) => JSON.stringify(OLD.RISK_POLICY[k]) !== JSON.stringify(NEW.RISK_POLICY[k]));
  check("risk-policy: every threshold, sleeve and stake field unchanged", !diff.length, diff.join(", ") || "17 fields equal");
  check("risk-policy: breakerMode stays 'observe'", NEW.RISK_POLICY.breakerMode === "observe" && OLD.RISK_POLICY.breakerMode === "observe");
  const vh = NEW.RISK_POLICY.versionHistory || [];
  check("risk-policy: version bumped, history names OP8 + OP10 + this change", NEW.RISK_POLICY.version !== OLD.RISK_POLICY.version && vh.some((v) => /OP8/.test(v.change)) && vh.some((v) => /OP10/.test(v.change)) && vh.some((v) => v.version === NEW.RISK_POLICY.version), NEW.RISK_POLICY.version);
  const book = JSON.parse(fs.readFileSync(path.join(REPO, "backend", "data", "board_positions.json"), "utf8")), log = JSON.parse(fs.readFileSync(path.join(REPO, "backend", "data", "trade_log.json"), "utf8")), now = Date.now();
  const strip = (o) => JSON.stringify({ ...o, policyVersion: null });
  check("risk-policy: aggregate() default (dashboard / portfolio-risk.jsonl / R53-adjacent readers) identical on the live book + ledger", strip(OLD.aggregate(book, log, now)) === strip(NEW.aggregate(book, log, now)), `open ${NEW.aggregate(book, log, now).openTickets}`);
  check("risk-policy: isSleeve / isR51 / policyStakePct / worstCaseOpen identical on the live book", book.every((p) => OLD.isSleeve(p) === NEW.isSleeve(p) && OLD.isR51(p) === NEW.isR51(p) && OLD.worstCaseOpen(p) === NEW.worstCaseOpen(p)) && ["Equity", "Crypto", "FX", "Futures", "Options"].every((c) => OLD.policyStakePct(c) === NEW.policyStakePct(c)));
  const sig = NEW.aggregate(book, log, now, { basis: "signals" }), gross = NEW.aggregate(book, log, now);
  check("risk-policy: signals basis drops the controls from the live book (informational numbers)", sig.basis === "signals" && sig.openTickets === book.filter((p) => p && !NEW.isSleeve(p) && !p.vetoShadow && !p.ctrl).length && sig.openTickets <= gross.openTickets, `gross ${gross.openTickets} tickets $${gross.worstCaseOpenCurrentEpoch} · signals ${sig.openTickets} tickets $${sig.worstCaseOpenCurrentEpoch}`);
  // breakerEvaluate known answers on a synthetic book
  const T = Date.now(), st = NEW.policyStakePct("Equity"); let k = 0;
  const tk = (r, x = {}) => ({ id: `t${++k}`, cls: "Equity", sym: `S${k}`, dir: 1, addedAt: T, riskDollars: r, riskPctApplied: st, strategy: "Ensemble", ...x });
  const bk = Array.from({ length: 96 }, () => tk(250)), a = tk(250), b = tk(500), c = tk(300), d = tk(250);
  const E = NEW.breakerEvaluate(bk, [], [a, { ...a, id: "a-c", ctrl: true }, b, c, { ...c, id: "c-c", ctrl: true }, d], T);
  check("breakerEvaluate: breach at the ticket that reaches $25,000; it and every later ticket are hits", E.halted && !E.haltedBefore && E.breach && E.breach.id === c.id && JSON.stringify(E.wouldRefuse.map((h) => h.id)) === JSON.stringify([c.id, "c-c", d.id]) && E.prevExposure === 24000, E.reason);
  const E2 = NEW.breakerEvaluate([...bk, ...Array.from({ length: 40 }, () => tk(250, { ctrl: true }))], [], [tk(250, { cls: "FX", sym: "EURUSD" }), tk(900, { strategy: "Trend" }), tk(100)], T);
  check("breakerEvaluate: controls, OP8 FX and OP10 Trend add no exposure", !E2.halted && E2.prevExposure === 24000 && E2.exposureWithBatch === 24100, `exposure ${E2.exposureWithBatch}`);
  const E3 = NEW.breakerEvaluate([], [{ pnl: -2100, closedAt: new Date(T - 60e3).toISOString() }, { pnl: -5000, ctrl: true, closedAt: new Date(T - 60e3).toISOString() }], [tk(10), tk(10, { ctrl: true })], T);
  check("breakerEvaluate: a realized signals loss of $2,100 halts before the batch — every new ticket is a hit", E3.haltedBefore && E3.wouldRefuse.length === 2 && /signals only/.test(E3.reason), E3.reason);
  const E4 = NEW.breakerEvaluate([], [{ pnl: -5000, ctrl: true, closedAt: new Date(T - 60e3).toISOString() }], [tk(10)], T);
  check("breakerEvaluate: $5,000 of control losses do not halt", !E4.halted);
  // server text
  const S = fs.readFileSync(target("backend/traids-server-v2.js"), "utf8");
  check("server: the breaker reads RP.breakerEvaluate; the pre-batch aggregate and the per-ticket wouldRefuse increment are gone", /RP\.breakerEvaluate\(prevBook/.test(S) && !/const risk = RP\.aggregate\(prevBook/.test(S) && !/bst\.wouldRefuseToday = \(bst\.wouldRefuseToday \|\| 0\) \+ 1/.test(S) && /bst\.wouldRefuseToday = 0;/.test(S));
  check("server: breakerMode is still read from the policy (no hard-coded mode)", /const ENFORCE_BREAKER = RP\.RISK_POLICY\.breakerMode === "enforce";/.test(S) && !/breakerMode\s*=\s*"enforce"/.test(S));
  const h = node([path.join(PKG, "harness-breaker.cjs"), ...(DEPLOYED ? ["--deployed"] : [])], { timeout: 300000 });
  check(`board-POST harness on the ${DEPLOYED ? "live" : "staged"} server (17 scenarios, temp dir)`, h.status === 0, (h.stdout || "").trim().split("\n").pop() + (h.status ? " :: " + (h.stdout || "").split("\n").filter((l) => /^FAIL/.test(l)).join(" | ") + (h.stderr || "").slice(0, 200) : ""));
}

const PF_OLD = 'node backend\\preflight.js >> automation\\preflight.log 2>&1\n:: 2026-09-29: tell the operator (operator chat only) when preflight is NO-GO, once per day per failing set, plus a recovery note\nnode backend\\ops-alert.js --preflight >> automation\\preflight.log 2>&1\nif errorlevel 1 (\n  echo ---- not GO, invoking self-heal ---- >> automation\\preflight.log\n';
const PF_NEW = 'node backend\\preflight.js >> automation\\preflight.log 2>&1\nset "PFRC=%ERRORLEVEL%"\n:: 2026-10-05 (ops health fix): self-heal is gated on PREFLIGHT\'s exit code (0 GO, 1 DEGRADED, 2 NO-GO), captured on the line above.\n:: It used to test ERRORLEVEL after ops-alert.js, which always exits 0, so from 2026-09-29 self-heal ran only once (10-01).\n:: self-heal.js replays a failed chain step only on that chain\'s own evening (never 08:00-16:15 ET on session days) and restarts only a server that is down.\n:: 2026-09-29: tell the operator (operator chat only) when preflight is NO-GO, once per day per failing set, plus a recovery note\nnode backend\\ops-alert.js --preflight >> automation\\preflight.log 2>&1\nif not "%PFRC%"=="0" (\n  echo ---- not GO, preflight exit %PFRC%, invoking self-heal ---- >> automation\\preflight.log\n';
function simulate(batText, tmp, rc) {      // run the bat's preflight -> ops-alert -> self-heal block under cmd with stand-ins, in a temp dir
  const lines = batText.split("\n"), i0 = lines.findIndex((l) => /^node backend\\preflight\.js /.test(l)); if (i0 < 0) return null;
  let i1 = -1; for (let i = i0; i < lines.length; i++) if (/^\)\s*$/.test(lines[i])) { i1 = i; break; } if (i1 < 0) return null;
  const block = lines.slice(i0, i1 + 1).map((l) => l
    .replace(/^node backend\\preflight\.js .*$/, 'node -e "process.exit(+process.env.SIMRC)" >> sim.log 2>&1')
    .replace(/^node backend\\ops-alert\.js .*$/, 'node -e "process.exit(0)" >> sim.log 2>&1 & echo OPSALERT >> sim.log')   // like ops-alert.js: always exits 0
    .replace(/^(\s*)node backend\\self-heal\.js .*$/, "$1echo SELFHEAL >> sim.log")
    .replace(/automation\\preflight\.log/g, "sim.log"));
  if (block.some((l) => /backend\\/.test(l))) return null;   // nothing real may run
  const bat = path.join(tmp, `sim-${rc}.bat`), logf = path.join(tmp, "sim.log");
  fs.writeFileSync(bat, ["@echo off", `cd /d "${tmp}"`, ...block, ""].join(batText.includes("\r\n") ? "\r\n" : "\n"));
  try { fs.unlinkSync(logf); } catch {}
  const r = spawnSync("cmd.exe", ["/d", "/c", bat], { encoding: "utf8", env: { ...process.env, SIMRC: String(rc) }, timeout: 60000, windowsHide: true, cwd: tmp });
  return { status: r.status, log: (() => { try { return fs.readFileSync(logf, "utf8"); } catch { return ""; } })() };
}
function partSelfheal() {
  for (const rel of ["backend/self-heal.js", "automation/preflight.bat"]) { baseOk(rel); targetOk(rel); eolOk(rel); syntaxOk(rel); }
  const r = node([target("backend/self-heal.js"), "--selftest", path.join(REPO, "automation", "close-chain.cjs")], { timeout: 120000 });
  check("self-heal --selftest (session guard known answers; reads only the close-chain TEXT)", r.status === 0, (r.stdout || "").trim().split("\n").pop() + (r.status ? " :: " + (r.stdout || "").split("\n").filter((l) => /^FAIL/.test(l)).join(" | ") + (r.stderr || "").slice(0, 300) : ""));
  const SH = fs.readFileSync(target("backend/self-heal.js"), "utf8");
  check("self-heal: runs only as the main module (require() no longer starts it)", /if \(require\.main === module\) \{/.test(SH) && !/^const pf = rd\("preflight-status\.json"/m.test(SH));
  const bOld = fs.readFileSync(base("automation/preflight.bat"), "utf8"), bNew = fs.readFileSync(target("automation/preflight.bat"), "utf8");
  check("preflight.bat: the change is exactly the intended hunk (everything else byte-identical)", bOld.split(PF_OLD).length === 2 && bOld.replace(PF_OLD, () => PF_NEW) === bNew);
  check("preflight.bat: the new lines are ASCII; no CR introduced", [...PF_NEW].every((ch) => ch.charCodeAt(0) < 128) && !bNew.includes("\r"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ops-preflight-sim-"));
  try {
    const res = [0, 1, 2].map((rc) => ({ rc, n: simulate(bNew, tmp, rc), o: simulate(bOld, tmp, rc) }));
    const good = res.every(({ rc, n }) => n && /OPSALERT/.test(n.log) && (rc === 0 ? !/SELFHEAL/.test(n.log) : /SELFHEAL/.test(n.log) && new RegExp(`preflight exit ${rc}`).test(n.log)));
    check("preflight.bat under cmd (stand-ins): exit 0 -> no self-heal; exit 1 and 2 -> self-heal; ops-alert always runs", good, res.map(({ rc, n }) => `rc${rc}:${n ? n.log.replace(/\s+/g, " ").trim() : "no block"}`).join(" | "));
    const oldNever = res.every(({ o }) => o && !/SELFHEAL/.test(o.log));
    check("(defect shown) the old block never reaches self-heal, whatever preflight returns", oldNever, res.map(({ rc, o }) => `rc${rc}:${o ? o.log.replace(/\s+/g, " ").trim() : "no block"}`).join(" | "));
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
}

function mirrorRun(runner, args) {          // the staged runner reads REPO = its parent dir: run it from a temp mirror whose backend/ and docs/ are junctions
  const m = fs.mkdtempSync(path.join(os.tmpdir(), "ops-closearm-mirror-")), links = [];
  try {
    fs.mkdirSync(path.join(m, "automation"));
    for (const f of fs.readdirSync(path.join(REPO, "automation")).filter((x) => /\.bat$/i.test(x))) fs.copyFileSync(path.join(REPO, "automation", f), path.join(m, "automation", f));
    fs.copyFileSync(runner, path.join(m, "automation", "close-arm-runner.cjs"));
    fs.writeFileSync(path.join(m, "package.json"), '{"type":"commonjs"}');
    for (const d of ["backend", "docs"]) { fs.symlinkSync(path.join(REPO, d), path.join(m, d), "junction"); links.push(path.join(m, d)); }
    return node([path.join(m, "automation", "close-arm-runner.cjs"), ...args], { cwd: m, timeout: 600000 });
  } finally {
    for (const l of links) { try { fs.rmdirSync(l); } catch {} }                       // removes the junction itself (never recursive)
    if (links.every((l) => { try { fs.lstatSync(l); return false; } catch { return true; } })) { try { fs.rmSync(m, { recursive: true, force: true }); } catch {} }
    else console.log(`NOTE: left ${m} in place (a junction could not be removed; remove it with rmdir, never recursively)`);
  }
}
function partClosearm() {
  const rel = "automation/close-arm-runner.cjs"; baseOk(rel); targetOk(rel); eolOk(rel); syntaxOk(rel);
  const O = fs.readFileSync(base(rel), "utf8"), N = fs.readFileSync(target(rel), "utf8");
  const reg = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); return i >= 0 && j > i ? s.slice(i, j) : null; };
  const oldCore = reg(O, '"use strict";', "// ── --dry: the plan and the window arithmetic"), newCore = reg(N, '"use strict";', "// ── recorder backups (2026-10-05 ops health fix)");
  check("close-arm runner: the money-step code (STEPS, lock, status, runStep, main) is byte-identical", oldCore && oldCore === newCore, oldCore ? `${oldCore.length} chars` : "region not found");
  const oldSelf = reg(O, "// ── selftest (temp dir only)", "// ── entry"), newSelf = reg(N, "// ── selftest (temp dir only)", "// ── --selftest-backups");
  check("close-arm runner: the original selftest is byte-identical", oldSelf && oldSelf === newSelf);
  const runIt = (args) => (DEPLOYED ? node([path.join(REPO, rel), ...args], { timeout: 600000 }) : mirrorRun(target(rel), args));
  const a = runIt(["--selftest"]); check("close-arm runner --selftest (the original 71 known answers, temp dirs)", a.status === 0, (a.stdout || "").trim().split("\n")[0] + (a.status ? " :: " + (a.stdout || "").split("\n").filter((l) => /FAIL/.test(l)).join(" | ") + (a.stderr || "").slice(0, 300) : ""));
  const b = runIt(["--selftest-backups"]); check("close-arm runner --selftest-backups (recorder backups, temp dirs)", b.status === 0, (b.stdout || "").trim().split("\n")[0] + (b.status ? " :: " + (b.stdout || "").split("\n").filter((l) => /FAIL/.test(l)).join(" | ") + (b.stderr || "").slice(0, 300) : ""));
}

function partTasks() {
  const dir = path.join(PKG, "tasks");
  const read16 = (f) => { const b = fs.readFileSync(f); return b[0] === 0xff && b[1] === 0xfe ? b.slice(2).toString("utf16le") : null; };
  const norm = (s) => s.replace(/<\?xml[^>]*\?>/, "").replace(/<Enabled>true<\/Enabled>/g, "").replace(/>\s+</g, "><").trim();
  for (const [n, early] of [["1341", "10:41"], ["1347", "10:47"]]) {
    const x = read16(path.join(dir, `task-r295-${n}.xml`)), live = read16(path.join(dir, `live-r295-${n}.xml`));
    check(`task-r295-${n}.xml: UTF-16 LE BOM, CRLF only`, x && !/(^|[^\r])\n/.test(x));
    const bounds = x ? [...x.matchAll(/<StartBoundary>([^<]+)<\/StartBoundary>/g)].map((m) => m[1]) : [];
    check(`task-r295-${n}.xml: weekly 13:${n.slice(2)} + early-close ${early} triggers, no UTC offset`, JSON.stringify(bounds) === JSON.stringify([`2026-10-05T13:${n.slice(2)}:00`, ...L.EARLY_CLOSE.map((d) => `${d}T${early}:00`)]), bounds.join(", "));
    const strip = (s) => norm(s.replace(/<Description>[^<]*<\/Description>/, "").replace(/<TimeTrigger>[\s\S]*?<\/TimeTrigger>/g, ""));
    check(`task-r295-${n}.xml: identical to the captured live definition apart from the description and the TimeTriggers`, x && live && strip(x) === strip(live));
    let q = null; try { q = require("child_process").execFileSync("schtasks", ["/query", "/tn", `TRAIDS R295 close-arm ${n}`, "/xml"], { encoding: "utf8", windowsHide: true }); } catch {}
    const state = !q ? "UNREADABLE" : norm(q) === norm(x) ? "APPLIED" : norm(q) === norm(live) ? "matches the capture (ready for -Apply)" : "DRIFTED since the capture";
    check(`live task 'TRAIDS R295 close-arm ${n}' (read-only query): ${state}`, q && state !== "DRIFTED since the capture");
  }
  const ps = fs.readFileSync(path.join(dir, "register-tasks-elevated.ps1"));
  check("register-tasks-elevated.ps1: ASCII, CRLF, has -Apply and the drift + 13:35-13:55 refusals, no single-letter functions", ![...ps].some((b) => b > 127) && L.eolOf(ps) === "CRLF" && /param\(\[switch\]\$Apply\)/.test(ps) && /no longer matches live-r295/.test(ps) && /13 \* 60 \+ 35/.test(ps) && !/^function [A-Za-z]\b/m.test(String(ps)));
}

function partDeploy() {                    // deploy.cjs's per-part late re-check, run for real in a temp mirror (deploy-sandbox.cjs)
  const r = node([path.join(PKG, "deploy-sandbox.cjs")], { timeout: 600000 });
  check("deploy.cjs late re-check in a temp mirror (fence flips between parts; live file changed between parts; all clear)", r.status === 0, (r.stdout || "").trim().split("\n").pop() + (r.status ? " :: " + (r.stdout || "").split("\n").filter((l) => /^FAIL/.test(l)).join(" | ") + (r.stderr || "").slice(0, 200) : ""));
}

console.log(`ops selftest · ${DEPLOYED ? "DEPLOYED (live files vs backups)" : "STAGED (staged copies vs live base)"} · part ${part}\n`);
const map = { breaker: partBreaker, selfheal: partSelfheal, closearm: partClosearm, tasks: partTasks, deploy: partDeploy };
for (const p of part === "all" ? Object.keys(map) : [part]) { if (!map[p]) { console.error("unknown part " + p); process.exit(2); } console.log(`── ${p}`); try { map[p](); } catch (e) { check(`${p}: threw`, false, e.stack || e.message); } console.log(""); }
const fails = results.filter((r) => !r.ok).length;
console.log(`${fails ? "FAIL" : "PASS"} — ${results.length - fails}/${results.length}`);
process.exit(fails ? 1 : 0);
