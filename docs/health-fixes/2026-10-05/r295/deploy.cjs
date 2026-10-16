#!/usr/bin/env node
/**
 * R295 v7 health-fix DEPLOY (docs/health-fixes/2026-10-05/r295; operator 2026-10-05: "fix them").
 * Usage (from anywhere): node "docs/health-fixes/2026-10-05/r295/deploy.cjs" [--dry] [--no-ft11]
 *  1 guards: refused on a weekday 07:50-17:45 ET (R295 session start 07:55, entries, 15:44 close-out, 15:41/15:47 ET close-arm, the close
 *    chain's R295 after-close); refused unless guard.cjs says the close chain has FINISHED after the newest R295 session and that session is
 *    reconciled (review fix: chain-status.json is written only at the END of a chain run, so "started > finished" never showed a running
 *    chain; on a weekday at/after 16:00 ET the chain must have started today; a visible close-chain.cjs process or a failed process scan
 *    refuses); refused while today's R295 session process is alive (checked with tasklist — never signalled); refused unless
 *    harness/guard-parity.cjs passes (guard.cjs applies the runner's own rule).
 *  2 the live runner's sha256 must equal manifest baseSha (v6). If it already equals stagedSha (v7 deployed earlier) steps 3-5 are skipped
 *    and the deploy resumes at 6 (idempotent). Anything else: refused, nothing written.
 *  3 backup live -> docs/health-fixes/2026-10-05/backups/backend__r295-orb-forward.js.pre-r295 (an existing backup must be v6 byte-for-byte)
 *  4 copy staged -> live byte-exact; sha re-checked; node -c on the runner and on every .cjs of this package
 *  5 node backend/r295-orb-forward.js --selftest must print "selftest passed" with no FAIL — else the backup is restored and checked (exit 1)
 *  6 FT-11 (unless --no-ft11): ledger backed up; for each required date: --resolve-overexit <d> (dry, GET only) must match the reviewed
 *    numbers in manifest.json, then --apply; the row is re-read and must carry overExitResolved with the same numbers
 *  6b queued FLATTENs (review fix; GET only, sends and cancels nothing): backend/r295-orb-forward.js --check-flattens holds every queued r295
 *    FLATTEN / CLEANUP against its symbol's position; one that would OPEN a position at the next open (the reversal was closed by hand) is
 *    printed with "cancel it before 09:30 ET"
 *  7 record (atomic, backed up first, idempotent): an R295 amendment in data/test-registry.json and an entry in data/change-registry.json
 *  8 deploy-result.json (deploy-dry.json with --dry: guards + shas + plan only; nothing copied, nothing written but that file)
 * Exit: 0 everything done · 1 refused or failed (live runner unchanged, or restored to v6) · 3 runner deployed but FT-11 / the record not complete
 *       (re-run resumes) · 4 deployed and recorded, but ACTION NEEDED: a queued r295 FLATTEN would not reduce its position, or the check could
 *       not run — read the "queued FLATTENs" lines.
 */
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
const PKG = __dirname, ROOT = path.resolve(PKG, "..", "..", "..", ".."), BK = path.join(ROOT, "backend");
const DRY = process.argv.includes("--dry"), NO_FT11 = process.argv.includes("--no-ft11");
const M = JSON.parse(fs.readFileSync(path.join(PKG, "manifest.json"), "utf8")), F = M.files[0];
const LIVE = path.join(ROOT, F.live), STAGED = path.join(PKG, F.staged), BACKUPS = path.join(ROOT, "docs", "health-fixes", "2026-10-05", "backups");
const bkOf = (rel) => path.join(BACKUPS, rel.replace(/[\\/]/g, "__") + ".pre-r295");
const RUNNER_BK = bkOf(F.live), LEDGER = path.join(BK, "data", "r295-ledger.jsonl"), LEDGER_BK = bkOf("backend/data/r295-ledger.jsonl");
const REG = path.join(BK, "data", "test-registry.json"), CHG = path.join(BK, "data", "change-registry.json");
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const R = { at: new Date().toISOString(), dry: DRY, package: M.package, steps: [] }; let exitCode = 0;
const step = (name, status, extra = {}) => { R.steps.push({ name, status, ...extra }); console.log(`${status === "ok" || status === "skipped" ? "ok  " : status === "warn" ? "warn" : "!!  "} ${name}${extra.detail ? " — " + extra.detail : ""}`); };
const finish = (code) => { R.exit = code; fs.writeFileSync(path.join(PKG, DRY ? "deploy-dry.json" : "deploy-result.json"), JSON.stringify(R, null, 1) + "\n"); process.exit(code); };
const refuse = (name, why) => { step(name, "REFUSED", { detail: why }); finish(1); };
const node = (args, opt = {}) => cp.spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", timeout: 300000, ...opt });

// 1 guards ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const etp = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date()).map((x) => [x.type, x.value]));
const etDate = `${etp.year}-${etp.month}-${etp.day}`, hm = `${etp.hour === "24" ? "00" : etp.hour}:${etp.minute}`, weekday = !["Sat", "Sun"].includes(etp.weekday);
R.et = `${etp.weekday} ${etDate} ${hm} ET`;
const inBlackout = weekday && hm >= "07:50" && hm < "17:45";
if (inBlackout && !DRY) refuse("window", `${R.et} is inside the weekday 07:50-17:45 ET blackout (session, close-out, close-arm, close chain)`);
step("window", inBlackout ? "warn" : "ok", { detail: `${R.et}${inBlackout ? " — inside the blackout (a real deploy would refuse)" : ""}` });
if (M.review && M.review.guardCjsSha && sha(path.join(PKG, "guard.cjs")) !== M.review.guardCjsSha && !DRY) refuse("guard.cjs sha", "guard.cjs changed after review (manifest review.guardCjsSha)");
{ let g; try { g = require(path.join(PKG, "guard.cjs")).chainGuardNow(BK); } catch (e) { g = { ok: false, why: "guard failed: " + e.message }; }   // review fix: fail closed (see guard.cjs)
  R.chainGuard = g; if (!g.ok && !DRY) refuse("close chain", g.why); step("close chain", g.ok ? "ok" : "warn", { detail: g.why + (g.ok ? "" : " (a real deploy would refuse)") }); }
{ const gp = node([path.join(PKG, "harness", "guard-parity.cjs")]), gl = ((gp.stdout || "") + (gp.stderr || "")).trim().split("\n"), last = gl.filter((l) => /guard parity:/.test(l)).pop() || gl.pop();   // guard.cjs = the runner's rule, byte-for-byte
  if (gp.status !== 0 && !DRY) refuse("guard parity", last); step("guard parity", gp.status === 0 ? "ok" : "warn", { detail: last }); }
{ const lock = path.join(BK, "data", "training", "r295", `session-${etDate}.lock`); let alive = false, image = "";
  if (fs.existsSync(lock)) { const pid = Number(JSON.parse(fs.readFileSync(lock, "utf8")).pid); if (pid > 0) {
    const t = cp.spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], { encoding: "utf8" }); const line = (t.stdout || "").split(/\r?\n/).find((l) => l.includes(`"${pid}"`)) || "";
    alive = !!line; image = line.split(",")[0] || ""; } }
  if (alive && /node/i.test(image) && !DRY) refuse("R295 session process", `today's session lock pid is a live ${image} — wait until it exits (~15:46 ET)`);
  step("R295 session process", alive && /node/i.test(image) ? "warn" : "ok", { detail: alive ? `lock pid alive as ${image}${/node/i.test(image) ? "" : " (not node: a reused pid, ignored)"}` : "not running" }); }
{ const s = path.join(BK, "data", "training", "r295", `session-${etDate}.json`); if (fs.existsSync(s)) { const S = JSON.parse(fs.readFileSync(s, "utf8")); step("today's R295 state", "ok", { detail: `closedOutAt ${S.closedOutAt || "NONE"}; reconciled ${S.reconciled ? "yes (tonight's after-close ran under v6)" : "not yet"}` }); } }

// 2 shas ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const liveSha = sha(LIVE), stagedSha = sha(STAGED); R.liveShaBefore = liveSha; R.stagedSha = stagedSha;
if (stagedSha !== F.stagedSha) refuse("staged sha", `staged ${stagedSha} != manifest ${F.stagedSha} — the staged file changed after review`);
const resume = liveSha === F.stagedSha;
if (!resume && liveSha !== F.baseSha) refuse("live sha", `live ${liveSha} is neither v6 (${F.baseSha}) nor v7 — the live file changed since staging`);
step("live sha", "ok", { detail: resume ? "already v7 — resuming at FT-11" : "v6 (baseSha) as staged against" });
for (const f of [STAGED, ...fs.readdirSync(PKG).filter((x) => x.endsWith(".cjs")).map((x) => path.join(PKG, x)), ...fs.readdirSync(path.join(PKG, "harness")).filter((x) => x.endsWith(".cjs")).map((x) => path.join(PKG, "harness", x))]) {
  const r = node(["-c", f]); if (r.status !== 0) refuse("node -c", `${path.relative(ROOT, f)}: ${(r.stderr || "").split("\n").slice(0, 3).join(" ")}`); }
step("node -c (staged runner + package scripts)", "ok");
if (DRY) { R.plan = [resume ? "skip copy (already v7)" : `backup -> ${path.relative(ROOT, RUNNER_BK)}; copy staged -> ${F.live}; node -c; --selftest`, NO_FT11 ? "FT-11 skipped" : `FT-11 resolve ${M.ft11.required.join(", ")} (dry then --apply; ledger backup ${path.relative(ROOT, LEDGER_BK)})`, "--check-flattens (GET only): queued r295 FLATTENs vs positions", "record test-registry + change-registry"]; step("dry run", "ok", { detail: "nothing copied or written but deploy-dry.json" }); finish(0); }

// 3-5 backup, copy, node -c, selftest ──────────────────────────────────────────────────────────────────────────────────────────
fs.mkdirSync(BACKUPS, { recursive: true });
if (!resume) {
  if (fs.existsSync(RUNNER_BK) && sha(RUNNER_BK) !== F.baseSha) refuse("backup", `${path.relative(ROOT, RUNNER_BK)} exists and is not v6 — not overwritten`);
  if (!fs.existsSync(RUNNER_BK)) fs.copyFileSync(LIVE, RUNNER_BK);
  if (sha(RUNNER_BK) !== F.baseSha) refuse("backup", "backup sha mismatch after copy");
  step("backup", "ok", { detail: path.relative(ROOT, RUNNER_BK) });
  fs.copyFileSync(STAGED, LIVE);
  if (sha(LIVE) !== F.stagedSha) { fs.copyFileSync(RUNNER_BK, LIVE); refuse("copy", "live sha after copy != stagedSha — v6 restored"); }
  const c = node(["-c", LIVE]); if (c.status !== 0) { fs.copyFileSync(RUNNER_BK, LIVE); refuse("node -c live", (c.stderr || "").slice(0, 300) + " — v6 restored"); }
  step("copy staged -> live", "ok", { detail: `sha ${F.stagedSha}` });
  const st = node([LIVE, "--selftest"]), out = (st.stdout || "") + (st.stderr || ""), fails = (out.match(/^FAIL/gm) || []).length, oks = (out.match(/^ok /gm) || []).length;
  R.selftest = { status: st.status, ok: oks, fail: fails, tail: out.trim().split("\n").slice(-2).join(" | ") };
  if (st.status !== 0 || fails || !/selftest passed/.test(out)) {
    fs.copyFileSync(RUNNER_BK, LIVE); const back = sha(LIVE) === F.baseSha;
    step("selftest", "FAILED", { detail: `${oks} ok, ${fails} FAIL, exit ${st.status} — ${back ? "v6 restored (sha checked)" : "RESTORE FAILED: live sha " + sha(LIVE)}` }); finish(1); }
  step("selftest", "ok", { detail: `${oks} ok, 0 FAIL` });
}
R.liveShaAfter = sha(LIVE);

// 6b queued FLATTENs (GET only) ───────────────────────────────────────────────────────────────────────────────────────────────────
let actionNeeded = false;
{ const cf = node([LIVE, "--check-flattens"]), out = ((cf.stdout || "") + (cf.stderr || "")).trim(), lines = out.split("\n"), summary = lines.filter((l) => /check-flattens:/.test(l)).pop() || lines.pop() || "";
  R.queuedFlattens = { exit: cf.status, lines: lines.filter((l) => /^(ok |!! )/.test(l) || /check-flattens:/.test(l)) };
  if (cf.status === 0) step("queued FLATTENs", "ok", { detail: summary.replace(/^.*check-flattens: /, "") });
  else if (cf.status === 2) { actionNeeded = true; step("queued FLATTENs", "ACTION", { detail: "a queued r295 FLATTEN would OPEN a position at the next open — cancel it before 09:30 ET (Alpaca paper, TV account)" }); for (const l of lines.filter((x) => /^!! /.test(x))) console.log("     " + l); }
  else { actionNeeded = true; step("queued FLATTENs", "UNKNOWN", { detail: `the check could not run (exit ${cf.status}): ${summary.slice(0, 160)} — check the queued r295 FLATTENs against the positions by hand before 09:30 ET` }); } }

// 6 FT-11 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const readLedger = () => fs.readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
R.ft11 = {};
if (NO_FT11) step("FT-11", "skipped", { detail: "--no-ft11" });
else {
  if (!fs.existsSync(LEDGER_BK)) fs.copyFileSync(LEDGER, LEDGER_BK);
  step("ledger backup", "ok", { detail: `${path.relative(ROOT, LEDGER_BK)} (sha ${sha(LEDGER_BK).slice(0, 12)}…)` });
  for (const d of M.ft11.required) {
    const want = M.ft11.expected[d], row0 = readLedger().find((r) => r.date === d);
    if (!row0) { R.ft11[d] = "no ledger row"; step(`FT-11 ${d}`, "FAILED", { detail: "no ledger row" }); exitCode = 3; continue; }
    if (row0.overExitResolved) { const ok = row0.netPnl === want.netPnlNow && row0.overExitResolution && row0.overExitResolution.defectPnl === want.defectPnl; R.ft11[d] = ok ? "already resolved (numbers match)" : "already resolved (numbers DIFFER from the review)"; step(`FT-11 ${d}`, ok ? "ok" : "FAILED", { detail: R.ft11[d] }); if (!ok) exitCode = 3; continue; }
    const dry = node([LIVE, "--resolve-overexit", d]), o = dry.stdout || "";
    const m = /(\d+) lot\(s\), (\d+) sh; defect P&L \$(-?[\d.]+) \(not evidence\); evidence restated by \$(-?[\d.]+) \(net \$(-?[\d.]+) -> \$(-?[\d.]+)\)/.exec(o);
    const match = dry.status === 0 && m && +m[1] === want.lots && +m[2] === want.overQty && +m[3] === want.defectPnl && +m[4] === want.evidenceDelta && +m[5] === want.netPnlWas && +m[6] === want.netPnlNow;
    if (!match) { R.ft11[d] = { status: "NOT applied — the dry run differs from the reviewed numbers or refused", dry: o.trim().split("\n").slice(0, 3).join(" | ") + (dry.stderr || "").slice(0, 200) }; step(`FT-11 ${d}`, "FAILED", { detail: R.ft11[d].status }); exitCode = 3; continue; }
    const ap = node([LIVE, "--resolve-overexit", d, "--apply"]), row = readLedger().find((r) => r.date === d);
    const good = ap.status === 0 && row && row.overExitResolved === true && row.netPnl === want.netPnlNow && row.overExitResolution.defectPnl === want.defectPnl && row.overExitResolution.overQty === want.overQty;
    R.ft11[d] = good ? { status: "resolved", netPnl: `${want.netPnlWas} -> ${row.netPnl}`, netRet: `${row.restated ? row.restated.was.netRet : row.netRet} -> ${row.netRet}`, defectPnl: row.overExitResolution.defectPnl } : { status: "apply did not verify", out: ((ap.stdout || "") + (ap.stderr || "")).slice(-300) };
    step(`FT-11 ${d}`, good ? "ok" : "FAILED", { detail: good ? `resolved; net ${want.netPnlWas} -> ${row.netPnl}; defect P&L ${row.overExitResolution.defectPnl} (not evidence)` : R.ft11[d].status }); if (!good) exitCode = 3;
  }
}

// 7 record ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
try {
  const { writeJsonAtomic } = require(path.join(BK, "lib", "atomic-write.js"));
  for (const [f, n] of [[REG, "backend/data/test-registry.json"], [CHG, "backend/data/change-registry.json"]]) if (!fs.existsSync(bkOf(n))) fs.copyFileSync(f, bkOf(n));
  const reg = JSON.parse(fs.readFileSync(REG, "utf8")), t = (reg.preregistered || []).find((e) => e.id === "R295"); if (!t) throw new Error("R295 not in test-registry preregistered");
  t.amendments ||= [];
  const ft = Object.entries(R.ft11).map(([d, v]) => `${d}: ${typeof v === "string" ? v : v.status}${v.netPnl ? ` (net ${v.netPnl}, defect P&L ${v.defectPnl} kept apart)` : ""}`).join("; ") || "not run";
  if (!t.amendments.some((a) => /^execution amendment v7/.test(a.kind || "") && !a.rolledBackAt)) {   // a rolled-back v7 amendment does not count: a re-deploy is recorded again
    t.amendments.push({ date: "2026-10-05", preEvidence: false, kind: "execution amendment v7 (health fix 2026-10-05)",
      change: "R295 v7 (operator 2026-10-05 'fix them'): every exit is sized from the broker. (1) Before a standalone stop or XSTOP the lot's exit orders are re-read (status and filled_qty — a filled or partially filled OTO leg reduces what is left) and the TV account position is read; the exit is the smaller of the two and can only move the position toward zero; a lot the broker shows flat is never exited again that session. (2) The 15:44 close-out and the after-close FLATTEN are capped by the broker's actual position (reduce-only); a reversal the lot's own over-exit created is closed at the close-out (client id r295-<SYM>-<YYYYMMDD>-CLEANUP) or by the FLATTEN, and recorded in data/r295-defect-cleanup.jsonl (evidence:false), never in the statistic. (3) An over-exited lot is booked at its first q exit shares in fill time (the rule's own exit); the over-exit fills are the defect, at their own prices (v4-v6 averaged them into the lot). (4) --resolve-overexit <date> [--apply] settles a session's over-exit lots from broker fills once final and only when the symbol's position is flat (no marks); the --live after-close runs it for unresolved evidence rows including its own session's, records a refusal on the row (overExitResolveCheck) and sends an earlier session's refusal to the operator (notify.js, new title 'R295 over-exit unresolved'); --apply by hand is refused unless the close chain has finished after the newest R295 session. (5) A stop capped by the broker position is re-sized when the position catches up; lots not settled at 09:40 are re-synced every 15 s until 10:00 ET. (6) --check-flattens (GET only) lists queued r295 FLATTENs that would no longer reduce their position.",
      why: "An OTO stop leg that had ALREADY FILLED read as not live, so a second exit for the whole lot (STOP1, or XSTOP when the stop was refused as through the price) was sent on top of it and the position reversed: 10-01 4 lots, 10-02 7 lots, 10-05 NU (short 284), CVE (long 150), UMC (long 153). The 15:44 close-out skipped such lots, so they rode overnight to the next open's FLATTEN.",
      verification: `staged --selftest 44/44 (mocked broker: today's NU/CVE/UMC leg-filled sequences -> no second exit; partial leg fill -> only the remainder; a working exit of the lot -> no new exit; a stop capped by the position re-sized when the position catches up; reversed position -> FLATTEN closes exactly it; normal lots unchanged; the hand-write chain guard); harness 46/46 on v6 vs v7 copies with a fake broker seeded from the real account (v7 CLOSE orders byte-identical to v6's, identical realized P&L on every normal lot, identical FLATTENs when the position equals the lot arithmetic, a CLEANUP-closed row resolves, a hand-closed reversal is refused, a smaller position caps the close-out); guard parity 12/12; 13 of 13 mutants of the safety lines caught; H0 reproduces v6's NU/CVE/UMC second exits from v6's own code; FT-11 dry run against the real account matched the harness. Adversarial review 2026-10-05: 3 major + 6 minor findings fixed before deploy. Deploy selftest: ${R.selftest ? `${R.selftest.ok} ok, ${R.selftest.fail} FAIL` : "(resumed; ran at the first deploy)"}.`,
      ft11: ft, sha256: F.stagedSha, previousSha256: F.baseSha, backup: path.relative(ROOT, RUNNER_BK).replace(/\\/g, "/"), package: "docs/health-fixes/2026-10-05/r295 (NOTES.md, v6-to-v7.diff)",
      unchanged: "Statistic, bar (t >= 1.657), sample size (60 evidence sessions), read point and evidence start unchanged. The 10-01 and 10-02 rows are restated from broker fills (old numbers kept under restated.was); the over-exit P&L stays apart from the statistic." });
    writeJsonAtomic(REG, reg); step("record test-registry (R295 amendment v7)", "ok");
  } else step("record test-registry (R295 amendment v7)", "skipped", { detail: "already recorded" });
  const chg = JSON.parse(fs.readFileSync(CHG, "utf8")); if (!Array.isArray(chg)) throw new Error("change-registry is not an array");
  const lastV7 = [...chg].reverse().find((e) => /^R295 v7 /.test(e.area || ""));   // the newest R295 v7 entry: a deploy, or a ROLLED BACK one
  if (!lastV7 || /ROLLED BACK/.test(lastV7.area)) {
    chg.push({ date: "2026-10-05", area: "R295 v7 — exits sized from the broker; over-exit reversals cleaned as defect, never evidence (health fix)", category: "execution", breaksComparability: false,
      change: `backend/r295-orb-forward.js v6 -> v7 (sha ${F.stagedSha.slice(0, 12)}…; backup ${path.relative(ROOT, RUNNER_BK).replace(/\\/g, "/")}). Before any standalone stop / XSTOP the lot's exit orders (status + filled_qty) and the TV position are re-read; exits, the 15:44 close-out and the FLATTEN are reduce-only against the broker position; a reversal the lot's own over-exit created is closed at the close-out (-CLEANUP) or by the FLATTEN and logged to data/r295-defect-cleanup.jsonl (evidence:false); over-exited lots are booked FIFO (first q exit shares, by parsed fill time); --resolve-overexit settles over-exits from broker fills (refused unless final, provable and flat; --apply by hand only after the close chain has finished); capped stops re-sized; unsettled lots re-synced to 10:00 ET; --check-flattens. FT-11: ${ft}.`,
      why: "10-01 / 10-02 / 10-05: a second exit was sent on top of an OTO stop leg that had already filled, reversing the position (10-05 NU short 284, CVE long 150, UMC long 153); the reversals rode overnight.",
      doesNotEstablish: "Any result. The defect P&L (10-01 +$561.24, 10-02 +$509.82) is not evidence.",
      operator: "Josh 2026-10-05 ('fix them')" });
    writeJsonAtomic(CHG, chg); step("record change-registry", "ok");
  } else step("record change-registry", "skipped", { detail: "already recorded" });
} catch (e) { step("record", "FAILED", { detail: e.message.slice(0, 200) }); exitCode = 3; }
R.liveShaFinal = sha(LIVE);
if (exitCode) step("result", "PARTIAL", { detail: `the v7 runner is live; see the FAILED step(s) — re-run deploy.cjs to resume (idempotent)${actionNeeded ? "; AND see the queued FLATTENs step" : ""}` });
else if (actionNeeded) { step("result", "ACTION", { detail: `v7 live; ${NO_FT11 ? "FT-11 skipped (--no-ft11)" : "FT-11 resolved"}; recorded — BUT a queued r295 FLATTEN needs you (see above) before 09:30 ET` }); exitCode = 4; }
else step("result", "ok", { detail: `v7 live; ${NO_FT11 ? "FT-11 skipped (--no-ft11)" : "FT-11 resolved"}; recorded; queued FLATTENs all reduce their positions` });
finish(exitCode);
