#!/usr/bin/env node
"use strict";
/**
 * SEAT-SDK TRIAL (2026-10-12) — VERIFY LIVE. READ-ONLY: it reads files and prints lines; it writes nothing, starts no seat, loads no SDK,
 * makes no network call, and prints no key (presence and length only).
 *
 *   node docs/seat-sdk-trial/2026-10-12/verify-live.cjs            every check below, one line each: PASS / FAIL / UNKNOWN / INFO
 *   node docs/seat-sdk-trial/2026-10-12/verify-live.cjs --quick    the same without the one slow line (hashing two 290 MB executables: the
 *                                                                  SDK's own, and the one the seat wave's resolver picks for the command line)
 *
 * Exit 0 no FAIL and no UNKNOWN · 1 a FAIL · 3 no FAIL but an UNKNOWN (read it; deploy.cjs leaves the edit applied on 3 and undoes it on 1).
 * A check that cannot be made is UNKNOWN, never PASS.
 */
const fs = require("fs"), path = require("path"), cp = require("child_process");
const L = require("./lib.cjs");
const SDKDIR = path.join(L.REPO, "automation", "seat-sdk");
const QUICK = process.argv.includes("--quick");
const rows = [], say = (verdict, name, detail) => { rows.push(verdict); console.log(`${verdict.padEnd(7)} ${name}${detail ? " — " + detail : ""}`); };
/** run one check: its function returns [verdict, detail]; a check that throws is UNKNOWN (it could not be made), never a pass */
const check = (name, fn) => { try { const [v, d] = fn(); say(v, name, d); } catch (e) { say("UNKNOWN", name, `the check itself could not be made (${String((e && e.message) || e).slice(0, 160)})`); } };

console.log(`VERIFY LIVE — seat-SDK trial — ${L.mtNow().dow} ${L.mtNow().date} ${L.mtNow().hms} MT`);
let S = null, PROVIDER = null, LEDGER = null, RUN = null, wave = null;
check("the seat-sdk folder loads (seats, provider, ledger, runner, hook: modules, nothing runs on load)", () => {
  S = require(path.join(SDKDIR, "seats.cjs")); PROVIDER = require(path.join(SDKDIR, "provider.cjs")); LEDGER = require(path.join(SDKDIR, "ledger.cjs")); RUN = require(path.join(SDKDIR, "run-seat.cjs"));
  const H = require(path.join(SDKDIR, "wave-hook.cjs"));
  return typeof H.seat === "function" && typeof RUN.runSeat === "function" ? ["PASS", ""] : ["FAIL", "an entry point is missing"];
});
check(`the staged edit on ${L.TARGET}`, () => {
  const p = L.plan(L.loadEdit());
  if (p.state === "drift") return ["FAIL", `DRIFT: ${p.why || p.problem}`];
  return ["PASS", `${p.state} (sha ${p.sha.slice(0, 12)}${p.movedSinceStaging ? "; the file changed elsewhere since staging, the anchor still matches" : ""})`];
});
check(`${L.TARGET} parses (node --check)`, () => {
  const c = cp.spawnSync(process.execPath, ["--check", L.targetOf()], { encoding: "utf8", windowsHide: true });
  return c.status === 0 ? ["PASS", ""] : ["FAIL", String(c.stderr).trim().split("\n")[0]];
});
check("the seat table of the SDK path equals the wave's own (seats, minutes, caps, model, turn limit, permission mode, follow-up turn)", () => {
  wave = fs.readFileSync(L.targetOf(), "utf8");
  const d = S.driftFrom(wave);
  return d.length ? ["FAIL", d.join("; ")] : ["PASS", S.SEATS.map((s) => `${s.seat} $${s.budget}`).join(" · ")];
});
check("the house's own reader of the wave's seat list still finds the six seats (backend/seat-seal-accrual.js reads the wave's source)", () => {
  const src = wave || fs.readFileSync(L.targetOf(), "utf8"), block = src.slice(src.indexOf("const SEATS = ["), src.indexOf("];", src.indexOf("const SEATS = [")));
  const found = [...block.matchAll(/\{\s*seat:\s*"([^"]+)"/g)].map((m) => m[1]);
  return JSON.stringify(found) === JSON.stringify(S.SEAT_NAMES) ? ["PASS", found.join(", ")] : ["FAIL", `it reads ${JSON.stringify(found)}`];
});
check("the six seat definitions can be read: a tool list and a model tier each (.claude/agents/<seat>.md)", () => {
  const out = S.SEATS.map((s) => { const d = S.readDefinition(L.REPO, s.seat); return `${s.seat}: ${d.tools.join("+")} on ${s.model || d.model}`; });
  return ["PASS", out.join(" · ")];
});
check("the SDK: one exact version pinned, the lockfile agrees, that version is installed in automation/seat-sdk and nowhere else is asked for", () => {
  const info = RUN.sdkInfo();
  if (info.problem && !info.installed) return ["UNKNOWN", info.problem];
  if (info.problem) return ["FAIL", info.problem];
  if (info.fake) return ["FAIL", "the installed package is a selftest's fake"];
  const lock = JSON.parse(fs.readFileSync(path.join(SDKDIR, "package-lock.json"), "utf8")), e = (lock.packages || {})["node_modules/" + RUN.SDK_NAME];
  if (!e || e.version !== info.pinned || !/^sha512-/.test(String(e.integrity))) return ["FAIL", "package-lock.json does not hold the pinned version with its integrity hash"];
  return ["PASS", `${RUN.SDK_NAME}@${info.pinned}${info.pkg.claudeCodeVersion ? ", carrying Claude Code " + info.pkg.claudeCodeVersion : ""}`];
});
check("the switch backend/data/seat-provider.json", () => {
  const R = PROVIDER.read(L.REPO);
  if (R.state === "unreadable") return ["FAIL", `it is there and cannot be read (${R.why}): every seat takes the command line; write it again with automation/seat-sdk/set-provider.cjs`];
  if (R.state === "absent") return ["PASS", "absent: every seat on the command line (the default)"];
  return ["PASS", `provider "${R.provider}"${R.seats ? ", seats " + R.seats.join(", ") : R.provider === "sdk" ? ", every seat" : ""}; on the SDK now: ${S.SEAT_NAMES.filter((n) => PROVIDER.route(R, n) === "sdk").join(", ") || "none"}`];
});
check("the spend ledger backend/data/seat-sdk-ledger.jsonl can be read (the limits are computed from it)", () => {
  const sum = LEDGER.summary(L.REPO);
  if (sum.state === "unreadable") return ["FAIL", `${sum.why}: every SDK seat would be REFUSED`];
  // the ledger is held against the seat wave's own history: SDK spend shown there must have its run in the ledger ("absent" alone is not "nothing spent")
  const seen = LEDGER.witness(L.REPO);
  if (seen.state === "unreadable") return ["FAIL", `the ledger cannot be held against the wave's history (${seen.why}): every SDK seat would be REFUSED`];
  const gone = LEDGER.lost(LEDGER.read(L.REPO).rows, seen.launches);
  if (gone.length) return ["FAIL", `MISSING AFTER THE TRIAL BEGAN: ${LEDGER.WITNESS_REL} shows SDK spend on ${gone.length} seat-night(s) the ledger holds no run for (the first: ${gone[0].seat} on ${gone[0].session}): every SDK seat would be REFUSED until the ledger is put back from its backup`];
  if (sum.state === "absent") return ["PASS", "absent, and the wave's history shows no SDK spend: nothing has been spent on the SDK path"];
  return ["PASS", `$${sum.trialCountedUsd.toFixed(2)} counted in the trial over ${sum.nights.length} night(s); runs with an unknown cost: ${sum.unknownCostRuns}`];
});
check("the limits in force", () => {
  const Lm = PROVIDER.limitsOf(PROVIDER.read(L.REPO)), end = Date.parse(Lm.trialEnd + "T00:00:00Z"), left = Math.ceil((end - Date.now()) / 86400000);
  return [Date.now() >= end ? "INFO" : "PASS", `$${Lm.nightCapUsd.toFixed(2)} a night · $${Lm.trialCapUsd.toFixed(2)} for the trial · the SDK path refuses from ${Lm.trialEnd} 00:00 UTC (${Date.now() >= end ? "THE TRIAL HAS ENDED: every SDK seat is refused" : left + " day(s) left"})`];
});
check("a key for the SDK path (presence and length only)", () => {
  const copy = { ...process.env }, k = RUN.loadKey(L.REPO, copy);
  return k.ok ? ["PASS", `present (${k.source}), length ${k.length}`] : ["UNKNOWN", `no usable key: an SDK seat would end UNKNOWN (${k.reason.replace(/\s+/g, " ").slice(0, 160)})`];
});
check("whether the wave reads the switch", () => {
  const src = wave || fs.readFileSync(L.targetOf(), "utf8"), on = src.includes("seat-sdk/wave-hook.cjs"), R = PROVIDER.read(L.REPO), wantsSdk = R.state === "ok" && R.provider === "sdk";
  if (!on && wantsSdk) return ["FAIL", "the switch asks for the SDK but the wave does not read it (the staged edit is not applied): every seat runs on the command line"];
  return ["PASS", on ? "the staged lines are in the wave" : "the staged lines are not in the wave yet, and the switch does not ask for the SDK"];
});
// the command line does not run a fixed file: the comparison is made with what the seat wave's own resolver picks now, and the line names it (lib.cjs launcherExeLine)
if (QUICK) say("INFO", "the launcher's executable against the command line's", "skipped (--quick)");
else check("the SDK's own launcher executable against the one the seat wave's resolver picks for the command-line path (same bytes = the same Claude Code build)", () => L.launcherExeLine());

const fail = rows.filter((v) => v === "FAIL").length, unk = rows.filter((v) => v === "UNKNOWN").length;
console.log(fail ? `VERIFY LIVE: ${fail} FAIL${unk ? `, ${unk} UNKNOWN` : ""} of ${rows.length} lines` : unk ? `VERIFY LIVE: no FAIL, ${unk} UNKNOWN of ${rows.length} lines — read them` : `VERIFY LIVE: all ${rows.length} lines read PASS or INFO`);
process.exit(fail ? 1 : unk ? 3 : 0);
