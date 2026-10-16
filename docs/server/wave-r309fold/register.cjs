#!/usr/bin/env node
/**
 * REGISTER — the governance record of the R309 fold, run BY JOSH after the hourly task is retired (and after any rollback). Home only,
 * node + backend/lib/atomic-write.js; it appends ONE change-registry row and ONE agent-ledger GOVERNANCE row and changes no registry
 * entry, rule, bar, population or read condition of any registered test (R309's included: the pulled bytes are the same, proven by
 * parity.cjs, which this re-runs before writing). 2026-10-09 (docs/server/wave-r309fold). Every number in a row is computed from the
 * files when it is written.
 *
 *   node docs/server/wave-r309fold/register.cjs [--dry]              after `schtasks ... /disable`: the retirement row
 *   node docs/server/wave-r309fold/register.cjs --rollback [--dry]   after rollback.cjs --home: the rollback row
 *   node docs/server/wave-r309fold/register.cjs --selftest           temp copies only
 * The retirement row REFUSES until: deploy.cjs --retire passed (deploy-state.json retireGate); the home patch is applied; the retirement is
 * EVIDENCED — the hourly task's last own line in automation\r309-pull.log is more than 2 h old and at least 2 preflight fold runs came after
 * it (the PC was up and the task, which fires hourly at :25, did not run); the parity proof passes now; and no such row exists yet.
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const HERE = __dirname, REPO = path.resolve(HERE, "..", "..", "..");
const D = (f) => path.join(REPO, "backend", "data", f);
const HP = require(path.join(HERE, "home-patch.cjs")), DEP = require(path.join(HERE, "deploy.cjs"));
const AREA = "server — R309 home pull folded into pull-server; the hourly TRAIDS R309 Pull task retired (its alarm rides the preflight fires)";
const AREA_RB = "server — R309 fold rolled back (the hourly TRAIDS R309 Pull task pulls and alarms again)";
const mtDay = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(new Date(ms));
const FILES = () => ({ changeFile: D("change-registry.json"), ledgerFile: D("agent-ledger.jsonl"), registryFile: D("test-registry.json"), stateFile: path.join(HERE, "deploy-state.json"), foldFile: D("r309-fold-status.json"), logFile: path.join(REPO, "automation", "r309-pull.log"), root: REPO });
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
function tail(f, n = 4 * 1024 * 1024) { try { const s = fs.statSync(f), fd = fs.openSync(f, "r"), k = Math.min(s.size, n), b = Buffer.alloc(k); fs.readSync(fd, b, 0, k, s.size - k); fs.closeSync(fd); return b.toString("utf8"); } catch { return ""; } }
function mentions(file, words) { let t = ""; try { t = fs.readFileSync(file, "utf8"); } catch { return null; } return Object.fromEntries(words.map((w) => { let n = 0; for (let i = t.indexOf(w); i >= 0; i = t.indexOf(w, i + 1)) n++; return [w, n]; })); }
const defaultProve = () => require(path.join(HERE, "parity.cjs")).prove();

/** the retirement's evidence: the task's last own line and the preflight fold runs after it -> { ok, why, lastOld, after } */
function retiredEvidence(f, nowMs) {
  const ol = DEP.oldTaskLines(tail(f.logFile), 0), lastOld = ol.length ? ol[ol.length - 1] : null, lastMs = lastOld ? Date.parse(lastOld.at) : -Infinity;
  const st = readJson(f.foldFile, { runs: [] }), runs = Array.isArray(st && st.runs) ? st.runs : [];
  const after = runs.filter((r) => r.from === "preflight.bat" && r.mode === "alert" && r.interactive === false && Date.parse(r.at) > lastMs && Date.parse(r.at) <= nowMs);
  const why = [];
  if (lastOld && nowMs - lastMs < 2 * 3600000) why.push(`the hourly task logged ${Math.round((nowMs - lastMs) / 60000)} min ago (${lastOld.at}) — is it disabled? Wait 2 h of weekday preflight fires`);
  if (after.length < 2) why.push(`${after.length} preflight fold run(s) since the task's last line (${lastOld ? lastOld.at : "none in the log"}) — 2 are needed to show the PC was up while the task stayed silent`);
  return { ok: !why.length, why, lastOld, after: after.length };
}
function rowFor(f, nowMs, prove) {
  const st = readJson(f.stateFile, { steps: {} }), gate = st.steps && st.steps.retireGate, ev = gate && gate.evidence;
  const re = retiredEvidence(f, nowMs), pr = prove(), bad = pr.filter((x) => !x.c), m = mentions(f.registryFile, ["pull-r309", "TRAIDS R309 Pull", "r309-fold"]);
  const S = pr.summary || {};
  return { gate, ev, re, prOk: !bad.length && !!pr.summary, prBad: bad, row: { id: `r309-fold-retire-${mtDay(nowMs)}`, date: mtDay(nowMs), recordedAt: nowMs, area: AREA, category: "ops", breaksComparability: false,
    operator: "Josh (the clean-day gate docs/server/wave-r309fold/deploy.cjs --retire, then schtasks /change /tn \"TRAIDS R309 Pull\" /disable); assistant (package docs/server/wave-r309fold)",
    change: `R309's four run files (r309-ledger.jsonl, r309-cycles.jsonl, r309-surge-hold48.json, r309-interim.json) now reach home ONLY through deploy/server/pull-server.cjs under deploy/server/manifests/r309.json (pull-r309.cjs's rules as data), wrapped by deploy/server/r309-fold.cjs, which also runs pull-r309.cjs's own validate() on every fetched tar (it refuses whatever either rule set refuses). Where: every TRAIDS Preflight fire (Mon-Fri hourly, 06:00-18:00 MT; then the same r309-health --alert alarm the task ran, same debounce state), the keeper that fire and every TRAIDS Servers run (boot included) start (the same pull + alarm about hourly while the PC is awake outside those hours — the task's evening / weekend cadence, kept across reboots), the chain's 2nd step and the step before git snapshot. The hourly TRAIDS R309 Pull task was disabled by the operator after a clean day: the gate passed at ${gate ? gate.passedAt : "?"} over ${ev ? ev.window.join(" .. ") : "?"} with ${ev ? ev.preflightPulled : "?"} preflight fold pulls, ${ev ? (ev.keeperRuns == null ? "?" : ev.keeperRuns) : "?"} keeper runs, ${ev ? ev.chain : "?"} + ${ev ? ev.chainGit : "?"} chain pulls, 0 refused / failed, the task alongside ${ev ? ev.oldOk : "?"} time(s) with 0 refusals and ${ev ? (ev.uncovered == null ? "?" : ev.uncovered) : "?"} task hour(s) without a fold alarm within 70 min. The task's last own line: ${re.lastOld ? re.lastOld.at : "none in the log"}; ${re.after} preflight fold run(s) since. Parity, re-run at this write: ${S.total} scenarios on the recorded fixtures (A ${S.A && S.A.n}, B ${S.B && S.B.n}, C ${S.C && S.C.n}) decided alike by both rule sets with identical bytes; the ${S.D} pinned divergences (none a row the runner writes) refused by the fold.`,
    why: "Operator 2026-10-09 \"go on the one week server move\"; server migration plan v2 M3 (one pull script for every wave). The task was the only TRAIDS job on a weekend clock and a second, unlocked writer of the same four files.",
    doesNotEstablish: `Any R309 result. R309's rule, bar, population, evidence start and read condition are unchanged; the home copy is the same bytes. ALARM COVERAGE: the alarm keeps an hourly cadence wherever the task had one — preflight fires on weekdays 06:00-18:00 MT (S4U with WakeToRun: no longer only while Josh is logged on), the keeper about hourly while the PC is otherwise awake (restarted by the next TRAIDS Servers run after a reboot, at boot: no logon needed). Hours the PC sleeps (nights, weekends: no TRAIDS task wakes it) are covered, as before, only by the VPS's own OnFailure alerts; a dead VPS or VPS network then is noticed at the next hour the PC is awake. The external dead-man ping (plan G6) remains the operator's option. test-registry.json names pull-r309 ${m ? m["pull-r309"] : "?"}x, "TRAIDS R309 Pull" ${m ? m["TRAIDS R309 Pull"] : "?"}x and r309-fold ${m ? m["r309-fold"] : "?"}x (counted at this write).`,
    files: ["automation/preflight.bat", "automation/close-chain.cjs", "automation/ensure-servers.bat", "deploy/server/r309-fold.cjs", "docs/server/wave-r309fold/"] } };
}
function apply(f = FILES(), { dry = false, nowMs = Date.now(), prove = defaultProve } = {}) {
  const chg = JSON.parse(fs.readFileSync(f.changeFile, "utf8")); if (!Array.isArray(chg)) throw new Error("change-registry.json is not an array");
  const x = rowFor(f, nowMs, prove), why = [];
  if (!x.gate || !x.gate.passedAt) why.push("deploy.cjs --retire never passed (no retireGate in docs/server/wave-r309fold/deploy-state.json) — the clean day comes first");
  const pst = HP.ALL().map((e) => HP.stateOf(e, f.root).state); if (!pst.every((s) => s === "applied")) why.push(`the home patch is not applied (${pst.join(",")})`);
  if (!x.re.ok) why.push(...x.re.why);
  if (!x.prOk) why.push("the parity proof does not pass now: " + x.prBad.map((b) => b.n.slice(0, 120)).join(" | "));
  if (chg.some((c) => c && c.area === AREA)) why.push("already written — the retirement row exists");
  if (dry) return ["DRY — would append to change-registry.json:", `  + ${x.row.area}`, `      ${x.row.change}`, `      doesNotEstablish: ${x.row.doesNotEstablish}`, "and one GOVERNANCE row to agent-ledger.jsonl.", why.length ? "The write would be REFUSED: " + why.join(" | ") : "The write would proceed."];
  if (why.length) throw new Error("REFUSED (nothing written): " + why.join(" | "));
  require(path.join(REPO, "backend", "lib", "atomic-write.js")).writeJsonAtomic(f.changeFile, [...chg, x.row]);
  fs.appendFileSync(f.ledgerFile, JSON.stringify({ at: new Date(nowMs).toISOString(), agent: "assistant", kind: "GOVERNANCE", target: "server migration: R309 pull fold", what: `R309's home pull now runs only through pull-server (manifests/r309.json + the pull-r309 rules guard) from preflight and the chain; the hourly TRAIDS R309 Pull task was retired after the clean-day gate (${x.gate.passedAt}). Change-registry row ${x.row.id}. No registered rule, bar, population or read condition changed.` }) + "\n");
  return [`written: change-registry.json (+1 row: ${x.row.id}), agent-ledger.jsonl (+1 GOVERNANCE row)`];
}
function applyRollback(f = FILES(), { dry = false, nowMs = Date.now() } = {}) {
  const chg = JSON.parse(fs.readFileSync(f.changeFile, "utf8")); if (!Array.isArray(chg)) throw new Error("change-registry.json is not an array");
  const pst = HP.ALL().map((e) => HP.stateOf(e, f.root).state), why = [];
  if (!pst.every((s) => s === "base")) why.push(`the home patch is not reverted (${pst.join(",")}) — run node docs/server/wave-r309fold/rollback.cjs --home first`);
  const id = `r309-fold-rollback-${mtDay(nowMs)}`; if (chg.some((c) => c && c.id === id)) why.push(`already written today (${id})`);
  const ol = DEP.oldTaskLines(tail(f.logFile), nowMs - 24 * 3600000), last = ol.filter((x) => x.kind === "ok").pop();
  const row = { id, date: mtDay(nowMs), recordedAt: nowMs, area: AREA_RB, category: "ops", breaksComparability: false, operator: "Josh (rollback.cjs --home after schtasks ... /enable); assistant (package docs/server/wave-r309fold)",
    change: `At ${new Date(nowMs).toISOString()} the R309 fold's home patch was reverted (preflight.bat and the chain no longer pull r309; deploy/server/r309-fold.cjs removed). The hourly TRAIDS R309 Pull task's last own ok line: ${last ? last.at : "none in the last 24 h (reverted with --accept-no-r309-pull?)"}.`, why: "Operator rollback of the R309 fold.", doesNotEstablish: "Any result. The pulled bytes are the same either way." };
  if (dry) return ["DRY — would append to change-registry.json:", `  + ${row.area}`, `      ${row.change}`, why.length ? "The write would be REFUSED: " + why.join(" | ") : "The write would proceed."];
  if (why.length) throw new Error("REFUSED (nothing written): " + why.join(" | "));
  require(path.join(REPO, "backend", "lib", "atomic-write.js")).writeJsonAtomic(f.changeFile, [...chg, row]);
  fs.appendFileSync(f.ledgerFile, JSON.stringify({ at: new Date(nowMs).toISOString(), agent: "assistant", kind: "GOVERNANCE", target: "server migration: R309 pull fold rollback", what: `R309 fold reverted at home; change-registry row ${id}.` }) + "\n");
  return [`written: change-registry.json (+1 row: ${id}), agent-ledger.jsonl (+1 GOVERNANCE row)`];
}

function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + String(d).slice(0, 500) : "")); } };
  const th = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r309fold-register-"));
  try {
    console.log("register selftest (" + tmp + ")");
    const R = path.join(tmp, "root"); for (const e of HP.EDITS) { fs.mkdirSync(path.dirname(path.join(R, e.rel)), { recursive: true }); fs.writeFileSync(path.join(R, e.rel), HP.baseText(e)); }
    const f = { changeFile: path.join(tmp, "change-registry.json"), ledgerFile: path.join(tmp, "agent-ledger.jsonl"), registryFile: path.join(tmp, "test-registry.json"), stateFile: path.join(tmp, "deploy-state.json"), foldFile: path.join(tmp, "r309-fold-status.json"), logFile: path.join(tmp, "r309-pull.log"), root: R };
    const reg0 = JSON.stringify({ tests: [{ id: "R309", readCondition: "--read once at 40 entry days; seals in read-seals.json." }] });
    fs.writeFileSync(f.changeFile, JSON.stringify([{ id: "x", area: "y" }], null, 1)); fs.writeFileSync(f.ledgerFile, ""); fs.writeFileSync(f.registryFile, reg0);
    const at = (iso) => Date.parse(iso), NOW = at("2026-10-13T17:30:00Z");   // Tue 11:30 MT
    const proveOk = () => Object.assign([{ n: "x", c: true }], { summary: { total: 679, A: { n: 12 }, B: { n: 96 }, C: { n: 563 }, D: 8 } }), proveBad = () => Object.assign([{ n: "(C) DISAGREE", c: false }], { summary: null });
    const taskLine = (iso) => `[${iso}] pull-r309 ok from traids:/home/traids/traids/backend/data — server files r309-cycles.jsonl: no change · home r309-HALT present`;
    const fold = (iso) => ({ at: iso, from: "preflight.bat", mode: "alert", interactive: false, pull: { exit: 0, kind: "ok" }, guard: "ok", alarm: { ran: true, exit: 0 } });
    const go = (o = {}) => th(() => apply(f, { nowMs: NOW, prove: proveOk, ...o }));
    // refusals, one at a time
    let e = go(); ok("no clean-day gate on record -> REFUSED, nothing written", /--retire never passed/.test(e || "") && fs.readFileSync(f.changeFile, "utf8").includes('"x"') && JSON.parse(fs.readFileSync(f.changeFile, "utf8")).length === 1 && fs.readFileSync(f.ledgerFile, "utf8") === "", e);
    fs.writeFileSync(f.stateFile, JSON.stringify({ steps: { retireGate: { passedAt: "2026-10-13T00:30:00.000Z", evidence: { window: ["2026-10-12T00:30:00.000Z", "2026-10-13T00:30:00.000Z"], preflightPulled: 12, keeperRuns: 4, chain: 1, chainGit: 1, oldOk: 11, uncovered: 0 } } } }));
    e = go(); ok("the home patch not applied -> REFUSED", /home patch is not applied/.test(e || ""), e);
    HP.applyAll(R);
    fs.writeFileSync(f.logFile, [taskLine("2026-10-13T16:25:03.000Z")].join("\n") + "\n"); fs.writeFileSync(f.foldFile, JSON.stringify({ runs: [fold("2026-10-13T17:00:05Z")] }));
    e = go(); ok("the task logged 65 min ago (still enabled?) and only 1 fold run since -> REFUSED, both reasons named", /logged 65 min ago/.test(e || "") && /1 preflight fold run\(s\) since/.test(e || ""), e);
    fs.writeFileSync(f.logFile, [taskLine("2026-10-13T00:25:03.000Z"), "[2026-10-13T00:25:04.000Z] R309 HEALTH PASS: x", "[2026-10-13T15:00:06.000Z] pull-r309 REFUSED (nothing written; r309 fold via pull-server, from preflight.bat): x"].join("\n") + "\n");
    fs.writeFileSync(f.foldFile, JSON.stringify({ runs: [fold("2026-10-13T12:00:05Z"), fold("2026-10-13T13:00:05Z"), { ...fold("2026-10-13T14:00:05Z"), interactive: true }, fold("2026-10-13T17:00:05Z")] }));
    e = go({ prove: proveBad }); ok("the parity proof failing at write time -> REFUSED (the row would claim parity)", /parity proof does not pass now/.test(e || ""), e);
    const before = fs.readFileSync(f.changeFile, "utf8"), dry = apply(f, { nowMs: NOW, prove: proveOk, dry: true });
    ok("--dry: prints the row and 'would proceed', writes nothing", /would proceed/.test(dry.join("\n")) && fs.readFileSync(f.changeFile, "utf8") === before && fs.readFileSync(f.ledgerFile, "utf8") === "", dry.join(" | "));
    e = go();
    const chg = JSON.parse(fs.readFileSync(f.changeFile, "utf8")), row = chg[chg.length - 1], led = fs.readFileSync(f.ledgerFile, "utf8").trim().split("\n");
    ok("evidenced (the task's last own line 17 h old; 3 non-interactive preflight fold runs after it; the fold's own REFUSED line is not the task's) -> ONE row + ONE ledger line", e === null && chg.length === 2 && led.length === 1 && JSON.parse(led[0]).kind === "GOVERNANCE", e);
    ok("the row: id r309-fold-retire-2026-10-13, ops, breaksComparability false, numbers from the files (12 preflight pulls, 4 keeper runs, 1 + 1 chain pulls, task alongside 11x, 0 uncovered task hours, last task line, 3 runs since, parity 679 / 8)", row.id === "r309-fold-retire-2026-10-13" && row.category === "ops" && row.breaksComparability === false && /12 preflight fold pulls, 4 keeper runs, 1 \+ 1 chain pulls/.test(row.change) && /alongside 11 time\(s\) with 0 refusals and 0 task hour\(s\) without a fold alarm within 70 min/.test(row.change) && /last own line: 2026-10-13T00:25:03\.000Z; 3 preflight fold run/.test(row.change) && /679 scenarios/.test(row.change) && /the 8 pinned divergences/.test(row.change), row.change);
    ok("the row's doesNotEstablish counts the registry's mentions at write time and states the alarm coverage change", /names pull-r309 0x, "TRAIDS R309 Pull" 0x and r309-fold 0x/.test(row.doesNotEstablish) && /ALARM COVERAGE/.test(row.doesNotEstablish), row.doesNotEstablish);
    ok("the row's files name every home file the patch edits and the new module (from home-patch.cjs, not a copy)", HP.EDITS.length === 3 && [...HP.EDITS, ...HP.NEW].every((x) => row.files.includes(x.rel)), JSON.stringify(row.files));
    e = go(); ok("again -> REFUSED 'already written', nothing appended", /already written/.test(e || "") && JSON.parse(fs.readFileSync(f.changeFile, "utf8")).length === 2 && fs.readFileSync(f.ledgerFile, "utf8").trim().split("\n").length === 1, e);
    ok("the test registry is only READ (a count), never written", fs.readFileSync(f.registryFile, "utf8") === reg0 && (() => { const code = fs.readFileSync(__filename, "utf8").split("function selftest")[0]; return !/(writeJsonAtomic|writeFileSync|appendFileSync|renameSync|unlinkSync)\(\s*f\.registryFile/.test(code) && (code.match(/writeJsonAtomic\(f\.changeFile/g) || []).length === 2 && (code.match(/appendFileSync\(f\.ledgerFile/g) || []).length === 2; })());
    // the rollback row
    e = th(() => applyRollback(f, { nowMs: NOW })); ok("--rollback while the patch is still applied -> REFUSED", /not reverted/.test(e || ""), e);
    HP.revertAll(R); e = th(() => applyRollback(f, { nowMs: NOW }));
    const c2 = JSON.parse(fs.readFileSync(f.changeFile, "utf8"));
    ok("--rollback after the revert -> one rollback row (id r309-fold-rollback-2026-10-13) + one ledger line; again the same day -> REFUSED", e === null && c2[c2.length - 1].id === "r309-fold-rollback-2026-10-13" && /already written today/.test(th(() => applyRollback(f, { nowMs: NOW })) || ""), e);
    ok("the default parity check is parity.cjs's prove() (re-run at write time, never a stored claim)", /require\(path\.join\(HERE, "parity\.cjs"\)\)\.prove\(\)/.test(fs.readFileSync(__filename, "utf8")));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`register selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) {
  const a = process.argv.slice(2), dry = a.includes("--dry");
  const known = new Set(["--dry", "--rollback", "--selftest"]);
  if (a.some((x) => !known.has(x)) || (a.includes("--selftest") && a.length > 1)) { console.error("usage: register.cjs [--dry] | --rollback [--dry] | --selftest"); process.exitCode = 2; }
  else if (a.includes("--selftest")) process.exitCode = selftest() ? 0 : 1;
  else { try { for (const l of (a.includes("--rollback") ? applyRollback(FILES(), { dry }) : apply(FILES(), { dry }))) console.log(l); process.exitCode = 0; } catch (e) { console.error(e.message); process.exitCode = 1; } }
}
module.exports = { apply, applyRollback, retiredEvidence, rowFor, AREA, AREA_RB };
