#!/usr/bin/env node
"use strict";
/**
 * SEAT-SDK FIX (2026-10-14, option B) — VERIFY LIVE. READ-ONLY for the repo: it reads files, runs the no-spend probe and the trial's
 * selftest, and prints one line per check (PASS / FAIL / UNKNOWN / INFO). It writes nothing in the repo, never touches the switch,
 * starts no seat and bills nothing: the probe's launcher runs on an invalid key with an empty credential store and is stopped at its
 * start-of-session report (probe-init.cjs); its runner's ledger rows land in a temp scratch tree that is removed. (The probe, as the
 * runner does, leaves session persistence on: the launcher may write a short transcript of that stopped session in the operator's
 * Claude project folder, as the 2026-10-14 probes did.)
 *
 *   node docs/seat-sdk-fix/2026-10-14/verify-live.cjs
 *
 * The checks:
 *   1. the three live files hold the staged bytes (deploy.cjs FILES)
 *   2. the seat definitions the wave launches can be read, and the live runner builds its gate on each one's own tool list
 *   3. the no-spend probe on news-trader with the LIVE runner: the launcher reports permission mode "default", the runner's own gate is
 *      in the options it handed the SDK, the SDK put --permission-prompt-tool stdio on the command line, and the runner's own start
 *      check PASSES on that report
 *   4. the trial's selftest (docs/seat-sdk-trial/2026-10-12/selftest.cjs, the live one): ALL 18 CHECKS PASSED, with no fewer than 647 cases
 *      — read from its exit code and the last line of its STDOUT; its stderr is shown in a FAIL, never judged
 *   INFO the switch backend/data/seat-provider.json, as it is (this package never writes it)
 * Exit 0 no FAIL and no UNKNOWN · 1 a FAIL · 3 no FAIL but an UNKNOWN (deploy.cjs keeps the apply on 3 and undoes it on 1).
 * A check that cannot be made is UNKNOWN, never PASS.
 */
const fs = require("fs"), path = require("path"), cp = require("child_process");
const D = require("./deploy.cjs");
const TRIAL_CASES_MIN = 647, TRIAL_CHECKS = 18, PROBE_SEAT = "news-trader";

/** 1 — the live files against the package's pins -> [verdict, detail] */
function filesLine(P) {
  if (P.problems.length) return ["FAIL", P.problems.join("; ")];
  if (P.applied) return ["PASS", P.files.map((x) => `${x.rel} ${x.live.slice(0, 12)}`).join(" · ")];
  return ["FAIL", `not applied: ${P.files.map((x) => `${x.rel} ${x.state}`).join(" · ")} — node ${D.PKG_REL}/deploy.cjs --apply first`];
}
/** 2 — every seat the wave launches has a readable definition, and the live runner's gate is built on its own tool list -> [verdict, detail] */
function defsLine({ repo = D.REPO } = {}) {
  const S = require(path.join(repo, "automation", "seat-sdk", "seats.cjs")), RUN = require(path.join(repo, "automation", "seat-sdk", "run-seat.cjs"));
  if (typeof RUN.makeGate !== "function") return ["FAIL", "the live runner has no permission gate (makeGate): it is not the staged runner"];
  const out = [];
  for (const seat of S.SEAT_NAMES) {
    const def = S.readDefinition(repo, seat), g = RUN.makeGate(def.tools);
    if (JSON.stringify(g.tools) !== JSON.stringify(def.tools)) return ["FAIL", `${seat}: the gate's list ${JSON.stringify(g.tools)} is not the definition's ${JSON.stringify(def.tools)}`];
    out.push(`${seat}: ${def.tools.join("+")}`);
  }
  return ["PASS", out.join(" · ")];
}
/** 3 — the probe's result (probe-init.cjs probe()) -> [verdict, detail] */
function probeLine(r) {
  if (!r || !r.init) return ["UNKNOWN", `no start-of-session report was read${r && r.problem ? ` (${String(r.problem).slice(0, 200)})` : ""}`];
  const I = r.init, bad = [];
  if (I.permissionMode !== "default") bad.push(`the launcher reports permission mode ${I.permissionMode}, not default`);
  if (!r.gate || r.gate.installed !== true) bad.push("the runner's gate is not in the options it handed the SDK");
  if (!r.gate || r.gate.promptTool !== "stdio") bad.push(`--permission-prompt-tool is ${r.gate && r.gate.promptTool != null ? r.gate.promptTool : "not"} on the launcher's command line (stdio expected)`);
  if (!r.start || r.start.pass !== true) bad.push(`the runner's start check STOPS: ${r.start ? r.start.reason : "it was not run"}`);
  return bad.length ? ["FAIL", bad.join("; ")] : ["PASS", `runner ${r.runnerFile} sha ${String(r.runnerSha).slice(0, 12)} · ${r.seat} · permissionMode ${I.permissionMode} · apiKeySource ${I.apiKeySource} · model ${I.model} · tools ${(I.tools || []).join(", ")} · Claude Code ${I.claude_code_version} · the gate in the options, --permission-prompt-tool stdio · start check: PASS`];
}
/**
 * 4 — the trial selftest's run -> [verdict, detail]: its exit code AND the last non-empty line of its STDOUT (D.lastLine); its stderr
 * never decides, and is shown in the detail of a FAIL (gate repair, 2026-10-15: a child's advisory warning on stderr is not its result).
 * A FAIL whose last line IS a result line says what fell short (review 2026-10-15, cycle 1): the count requirement only when the counts
 * fall short, "its exit code is not 0" only when it is not — never the count requirement for counts that hold.
 */
function trialLine(status, stdout, stderr) {
  const last = D.lastLine(stdout), m = /^ALL (\d+) CHECKS PASSED \((\d+) selftest cases\)$/.exec(last.trim());
  if (status === 0 && m && Number(m[1]) === TRIAL_CHECKS && Number(m[2]) >= TRIAL_CASES_MIN) return ["PASS", last.trim()];
  const shown = D.stderrShown(stderr), countsShort = !!m && (Number(m[1]) !== TRIAL_CHECKS || Number(m[2]) < TRIAL_CASES_MIN);
  const short = m ? [countsShort ? `${TRIAL_CHECKS} checks and at least ${TRIAL_CASES_MIN} cases are required` : "", status !== 0 ? "its exit code is not 0" : ""].filter(Boolean).join("; ") : "";
  return ["FAIL", `exit ${status}; last line of its stdout: ${last.trim().slice(0, 200) || "(none)"}${short ? ` (${short})` : ""}${shown ? `; ${shown}` : ""}`];
}
/** INFO — the switch, read-only */
function switchLine({ repo = D.REPO } = {}) {
  const PR = require(path.join(repo, "automation", "seat-sdk", "provider.cjs")), R = PR.read(repo);
  return ["INFO", R.state === "absent" ? "absent: every seat on the command line" : R.state === "unreadable" ? `unreadable (${R.why}): every seat on the command line` : `provider "${R.provider}"${R.seats ? ", seats " + R.seats.join(", ") : R.provider === "sdk" ? ", every seat" : ""} (this package never writes it)`];
}

/** every check, with its inputs injectable (the selftest) -> { rows: [[verdict, name, detail]], code } */
async function run({ repo = D.REPO, pkg = D.PKG, probe, trial, log = (s) => console.log(s) } = {}) {
  const rows = [], say = (v, name, detail) => { rows.push([v, name, detail]); log(`${v.padEnd(7)} ${name}${detail ? " — " + detail : ""}`); };
  const check = async (name, fn) => { try { const [v, d] = await fn(); say(v, name, d); } catch (e) { say("UNKNOWN", name, `the check itself could not be made (${String((e && e.message) || e).slice(0, 200)})`); } };
  await check("the three live files hold the staged bytes (deploy.cjs FILES)", () => filesLine(D.plan({ repo, pkg })));
  await check("the seats the wave launches: each definition is read and the live runner's gate is built on its own tool list", () => defsLine({ repo }));
  await check(`the no-spend probe on ${PROBE_SEAT} with the LIVE runner (invalid key, empty credential store, stopped at its start-of-session report)`, async () => probeLine(await (probe || (() => require("./probe-init.cjs").probe({ runner: "live", seat: PROBE_SEAT })))()));
  await check(`the trial's selftest (docs/seat-sdk-trial/2026-10-12/selftest.cjs): ALL ${TRIAL_CHECKS} CHECKS PASSED, at least ${TRIAL_CASES_MIN} cases`, () => {
    const r = trial ? trial() : cp.spawnSync(process.execPath, [path.join(repo, "docs", "seat-sdk-trial", "2026-10-12", "selftest.cjs")], { cwd: repo, encoding: "utf8", timeout: 900000, windowsHide: true, maxBuffer: 256 << 20, env: require(path.join(repo, "docs", "seat-sdk-trial", "2026-10-12", "lib.cjs")).cleanEnv() });
    return trialLine(r.status, r.stdout, r.stderr);
  });
  await check(`the switch ${D.SWITCH_REL}`, () => switchLine({ repo }));
  const fail = rows.filter((r) => r[0] === "FAIL").length, unk = rows.filter((r) => r[0] === "UNKNOWN").length;
  log(fail ? `VERIFY LIVE: ${fail} FAIL${unk ? `, ${unk} UNKNOWN` : ""} of ${rows.length} lines` : unk ? `VERIFY LIVE: no FAIL, ${unk} UNKNOWN of ${rows.length} lines — read them` : `VERIFY LIVE: all ${rows.length} lines read PASS or INFO`);
  return { rows, code: fail ? 1 : unk ? 3 : 0 };
}

module.exports = { run, filesLine, defsLine, probeLine, trialLine, switchLine, TRIAL_CASES_MIN, TRIAL_CHECKS, PROBE_SEAT };

if (require.main === module) {
  if (process.argv.length > 2) { console.log("usage: node docs/seat-sdk-fix/2026-10-14/verify-live.cjs   (read-only; no arguments)\nNothing was done."); process.exit(2); }
  process.on("unhandledRejection", () => {});
  console.log(`VERIFY LIVE — seat-SDK fix, option B — ${D.mtWords(Date.now())} MT — read-only`);
  run().then((r) => process.exit(r.code), (e) => { console.log(`UNKNOWN verify-live itself failed — ${String((e && e.message) || e).slice(0, 200)}`); process.exit(3); });
}
