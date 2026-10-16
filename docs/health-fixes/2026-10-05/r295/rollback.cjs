#!/usr/bin/env node
/**
 * R295 v7 health-fix ROLLBACK (docs/health-fixes/2026-10-05/r295). Usage: node ".../r295/rollback.cjs" [--dry] [--undo-ft11]
 *  1 guards as deploy.cjs: refused on a weekday 07:50-17:45 ET; refused unless guard.cjs says the close chain has FINISHED after the newest
 *    R295 session and that session is reconciled (review fix: the old "started > finished" test never saw a running chain — chain-status.json
 *    is written only when a chain ends); refused while today's R295 session process is alive
 *  WARNING (review): v6 does not know the v7 -CLEANUP order. Never re-run the restored v6 with --after-close for a date on which v7 sent a
 *    -CLEANUP (listed by this script from data/r295-defect-cleanup.jsonl): v6 would book the over-exit as still open and FLATTEN it at the
 *    next open WITHOUT a position check, opening a new position. The nightly chain only runs --after-close for its own date, and this
 *    script only runs after that date's after-close (the guard above), so only a manual re-run can do it.
 *  2 the live runner must be the v7 this package deployed (manifest stagedSha) — anything else is refused (someone changed it since)
 *  3 docs/health-fixes/2026-10-05/backups/backend__r295-orb-forward.js.pre-r295 -> live; sha must equal v6 (baseSha); node -c; --selftest
 *  4 --undo-ft11 only: every ledger row this package's resolver resolved (overExitResolution.by "R295 v7 --resolve-overexit") is put back —
 *    to its exact pre-deploy line when the ledger backup has one, else by restoring restated.was and dropping the resolution fields — and
 *    the resolver's defect rows ("resolved") are removed. Rows / defect rows the v7 runner wrote for its own orders are kept.
 *    Without --undo-ft11 the FT-11 resolution stays: it is broker-fill data, v6 reads it (read() needs overExitResolved), and only a v6
 *    re-run of --after-close for 10-01 / 10-02 would drop it.
 *  5 the registry amendment gets rolledBackAt and a change-registry entry records the rollback (atomic, idempotent)
 * Exit: 0 done · 1 refused / failed (live file as it was, or restored to v7 if the v6 checks failed).
 */
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
const PKG = __dirname, ROOT = path.resolve(PKG, "..", "..", "..", ".."), BK = path.join(ROOT, "backend");
const DRY = process.argv.includes("--dry"), UNDO_FT11 = process.argv.includes("--undo-ft11");
const M = JSON.parse(fs.readFileSync(path.join(PKG, "manifest.json"), "utf8")), F = M.files[0];
const LIVE = path.join(ROOT, F.live), STAGED = path.join(PKG, F.staged), BACKUPS = path.join(ROOT, "docs", "health-fixes", "2026-10-05", "backups");
const bkOf = (rel) => path.join(BACKUPS, rel.replace(/[\\/]/g, "__") + ".pre-r295");
const RUNNER_BK = bkOf(F.live), LEDGER = path.join(BK, "data", "r295-ledger.jsonl"), LEDGER_BK = bkOf("backend/data/r295-ledger.jsonl"), DEFECTS = path.join(BK, "data", "r295-defect-cleanup.jsonl");
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const R = { at: new Date().toISOString(), dry: DRY, undoFt11: UNDO_FT11, steps: [] }; let did = false;   // did: something was rolled back in THIS run (else no change-registry entry)
const step = (name, status, detail = "") => { R.steps.push({ name, status, detail }); console.log(`${status === "ok" || status === "skipped" ? "ok  " : status === "warn" ? "warn" : "!!  "} ${name}${detail ? " — " + detail : ""}`); };
const finish = (code) => { R.exit = code; fs.writeFileSync(path.join(PKG, DRY ? "rollback-dry.json" : "rollback-result.json"), JSON.stringify(R, null, 1) + "\n"); process.exit(code); };
const refuse = (name, why) => { step(name, "REFUSED", why); finish(1); };
const node = (args) => cp.spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", timeout: 300000 });

const etp = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date()).map((x) => [x.type, x.value]));
const etDate = `${etp.year}-${etp.month}-${etp.day}`, hm = `${etp.hour === "24" ? "00" : etp.hour}:${etp.minute}`, weekday = !["Sat", "Sun"].includes(etp.weekday);
if (weekday && hm >= "07:50" && hm < "17:45" && !DRY) refuse("window", `${etp.weekday} ${etDate} ${hm} ET is inside the weekday 07:50-17:45 ET blackout`);
{ let g; try { g = require(path.join(PKG, "guard.cjs")).chainGuardNow(BK); } catch (e) { g = { ok: false, why: "guard failed: " + e.message }; }   // review fix: fail closed (see guard.cjs)
  R.chainGuard = g; if (!g.ok && !DRY) refuse("close chain", g.why); if (!g.ok) step("close chain", "warn", g.why + " (a real rollback would refuse)"); }
{ const lock = path.join(BK, "data", "training", "r295", `session-${etDate}.lock`);
  if (fs.existsSync(lock)) { const pid = Number(JSON.parse(fs.readFileSync(lock, "utf8")).pid); const t = cp.spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], { encoding: "utf8" });
    const line = (t.stdout || "").split(/\r?\n/).find((l) => l.includes(`"${pid}"`)) || ""; if (line && /node/i.test(line.split(",")[0]) && !DRY) refuse("R295 session process", `today's session lock pid ${pid} is a live node process`); } }
step("guards", "ok", `${etp.weekday} ${etDate} ${hm} ET`);
{ let cl = []; try { cl = fs.existsSync(DEFECTS) ? [...new Set(fs.readFileSync(DEFECTS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => /cleanup at the close-out/.test(r.kind || "")).map((r) => r.lotDate))].sort() : []; } catch (e) { cl = ["UNREADABLE: " + e.message.slice(0, 60)]; }
  R.cleanupDates = cl; if (cl.length) step("v7 -CLEANUP dates", "warn", `v7 sent a -CLEANUP on ${cl.join(", ")} — NEVER re-run v6 --after-close for ${cl.length > 1 ? "these dates" : "that date"}: v6 would FLATTEN the over-exit again without a position check and open a new position`); }

const liveSha = sha(LIVE); R.liveShaBefore = liveSha;
if (liveSha === F.baseSha) step("live sha", "skipped", "already v6 — code rollback not needed");
else if (liveSha !== F.stagedSha) refuse("live sha", `live ${liveSha} is not the v7 this package deployed (${F.stagedSha}) — refusing to overwrite an unknown version`);
if (!fs.existsSync(RUNNER_BK) || sha(RUNNER_BK) !== F.baseSha) refuse("backup", `${path.relative(ROOT, RUNNER_BK)} missing or not v6`);
if (DRY) { step("dry run", "ok", `would restore ${path.relative(ROOT, RUNNER_BK)} -> ${F.live}${UNDO_FT11 ? " and undo FT-11" : ""}`); finish(0); }

if (liveSha === F.stagedSha) {
  fs.copyFileSync(RUNNER_BK, LIVE);
  const ok6 = sha(LIVE) === F.baseSha && node(["-c", LIVE]).status === 0, st = ok6 ? node([LIVE, "--selftest"]) : null, out = st ? (st.stdout || "") + (st.stderr || "") : "";
  if (!ok6 || st.status !== 0 || /^FAIL/m.test(out) || !/selftest passed/.test(out)) { fs.copyFileSync(STAGED, LIVE); refuse("restore v6", `v6 checks failed (${ok6 ? "selftest" : "sha / node -c"}) — v7 put back (sha ${sha(LIVE).slice(0, 12)}…)`); }
  step("restore v6", "ok", `sha ${F.baseSha.slice(0, 12)}…; node -c ok; selftest ${(out.match(/^ok /gm) || []).length} ok`); did = true;
}
if (UNDO_FT11) {
  const { writeTextAtomic } = require(path.join(BK, "lib", "atomic-write.js"));
  const backupLines = fs.existsSync(LEDGER_BK) ? Object.fromEntries(fs.readFileSync(LEDGER_BK, "utf8").split("\n").filter(Boolean).map((l) => [JSON.parse(l).date, l])) : {};
  const undone = [], lines = fs.readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).map((l) => {
    const r = JSON.parse(l); if (!(r.overExitResolution && /^R295 v7 --resolve-overexit/.test(r.overExitResolution.by || ""))) return l;
    undone.push(r.date); const b = backupLines[r.date]; if (b && !JSON.parse(b).overExitResolved) return b;
    const x = { ...r }; if (x.restated) Object.assign(x, x.restated.was); delete x.overExitResolved; delete x.overExitResolution; delete x.restated; return JSON.stringify(x); });
  if (undone.length) { writeTextAtomic(LEDGER, lines.join("\n") + "\n"); did = true; }
  step("undo FT-11 ledger rows", "ok", undone.length ? undone.join(", ") : "none carried this package's resolution");
  if (fs.existsSync(DEFECTS)) { const all = fs.readFileSync(DEFECTS, "utf8").split("\n").filter(Boolean), keep = all.filter((l) => !/"source":"R295 v7 --resolve-overexit/.test(l)); if (keep.length !== all.length) writeTextAtomic(DEFECTS, keep.length ? keep.join("\n") + "\n" : ""); step("undo FT-11 defect rows", "ok", `${all.length - keep.length} removed, ${keep.length} kept`); }
} else step("FT-11 data", "skipped", "kept (pass --undo-ft11 to revert the resolved rows)");
try {
  const { writeJsonAtomic } = require(path.join(BK, "lib", "atomic-write.js"));
  const REG = path.join(BK, "data", "test-registry.json"), reg = JSON.parse(fs.readFileSync(REG, "utf8")), t = (reg.preregistered || []).find((e) => e.id === "R295");
  const a = t && [...(t.amendments || [])].reverse().find((x) => /^execution amendment v7/.test(x.kind || "") && !x.rolledBackAt);   // the newest ACTIVE v7 amendment
  if (a && did) { a.rolledBackAt = new Date().toISOString(); a.rolledBackNote = `v6 restored by rollback.cjs${UNDO_FT11 ? "; FT-11 resolution undone" : "; FT-11 resolution kept"}`; writeJsonAtomic(REG, reg); step("registry amendment", "ok", "rolledBackAt set"); } else step("registry amendment", "skipped", a ? "nothing rolled back in this run" : "no active v7 amendment");
  const CHG = path.join(BK, "data", "change-registry.json"), chg = JSON.parse(fs.readFileSync(CHG, "utf8"));
  if (!did) { step("change-registry", "skipped", "nothing rolled back in this run"); finish(0); }
  chg.push({ date: etDate, area: "R295 v7 ROLLED BACK to v6", category: "execution", breaksComparability: false, change: `backend/r295-orb-forward.js restored from ${path.relative(ROOT, RUNNER_BK).replace(/\\/g, "/")} (sha ${F.baseSha.slice(0, 12)}…)${UNDO_FT11 ? "; FT-11 rows and resolver defect rows reverted" : "; FT-11 resolution kept"}.`, why: "rollback.cjs run by the operator", doesNotEstablish: "Any result.", operator: "operator (rollback.cjs)" });
  writeJsonAtomic(CHG, chg); step("change-registry", "ok");
} catch (e) { step("record", "FAILED", e.message.slice(0, 200)); finish(1); }
finish(0);
