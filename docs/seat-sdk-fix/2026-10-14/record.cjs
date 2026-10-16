#!/usr/bin/env node
"use strict";
/**
 * SEAT-SDK FIX (2026-10-14, option B) — RECORD the change of the trial's launcher: ONE change-registry row and ONE agent-ledger GOVERNANCE
 * line, "seats trial launcher: default mode with the runner approving exactly each seat's own tools; the key stays scrubbed from the
 * seats' commands".
 *
 *   node docs/seat-sdk-fix/2026-10-14/record.cjs --dry    print the two records and whether the write would go through; write nothing,
 *                                                         take no lock (exit 0 unless a file cannot be read)
 *   node docs/seat-sdk-fix/2026-10-14/record.cjs          write them — the main session's command, AFTER deploy.cjs --apply and
 *                                                         verify-live.cjs
 *
 * THE ROW (backend/data/change-registry.json): id seat-sdk-trial-launcher-option-b-2026-10-14, follows the row of the night that did not
 *   run (seat-sdk-trial-first-night-did-not-run-2026-10-13), breaksComparability false: no SDK-launched session holds evidence yet, and
 *   the launcher change itself was recorded as breaking comparability (seat-sdk-trial-first-night-2026-10-13). No registered rule, bar,
 *   population or read condition changes. THE LINE (backend/data/agent-ledger.jsonl): kind GOVERNANCE, naming the row.
 * REFUSED, nothing written: between 13:50 and 15:50 MT on a trading weekday (Mon-Fri, not a market holiday: the close chain owns these
 *   files then); while the live files are not the staged ones (deploy.cjs --apply first: a change is recorded after it is in); ANY of
 *   the two records already there (both: "already recorded", exit 0; one: refused, saying which); backend/data/registry-write.lock held
 *   by another writer for more than 120 s (created with flag wx; another writer's lock is never removed).
 * WRITES, under that lock, in this order: change-registry.json through backend/lib/atomic-write.js writeJsonAtomic (read back), then
 *   ONE line appended to agent-ledger.jsonl (an append never rewrites what other writers added; read back). A failure after the first
 *   write says what is still owed.
 * Exit 0 written / already recorded / dry · 1 failed after a write · 2 refused or usage.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const D = require("./deploy.cjs");
let HOLIDAYS = {}; try { HOLIDAYS = require(path.join(D.REPO, "backend", "lib", "run-window.js")).MARKET_HOLIDAYS || {}; } catch { HOLIDAYS = {}; }
const CR_ID = "seat-sdk-trial-launcher-option-b-2026-10-14", FOLLOWS = "seat-sdk-trial-first-night-did-not-run-2026-10-13", LOCK_WAIT_MS = 120000;
const TEXT = "seats trial launcher: default mode with the runner approving exactly each seat's own tools; the key stays scrubbed from the seats' commands";
class Refuse extends Error {}
const refuse = (m) => { throw new Refuse(m); };

/** the MT clock: no write to these files 13:50-15:50 MT on a trading weekday (Mon-Fri, not a market holiday) */
function mtClock(nowMs, holidays = HOLIDAYS) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", hourCycle: "h23", hour: "2-digit", minute: "2-digit", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(nowMs)).map((x) => [x.type, x.value]));
  const hh = +p.hour % 24, hm = hh * 60 + +p.minute, mtDate = `${p.year}-${p.month}-${p.day}`;
  const dow = new Date(mtDate + "T12:00:00Z").getUTCDay(), tradingDay = dow >= 1 && dow <= 5 && !holidays[mtDate];
  return { mtDate, hhmm: `${String(hh).padStart(2, "0")}:${p.minute}`, tradingDay, inWindow: tradingDay && hm >= 13 * 60 + 50 && hm < 15 * 60 + 50 };
}
/** the MT day the live runner got its staged bytes (the file's own time), or null when it does not hold them */
function appliedOn({ repo = D.REPO, pkg = D.PKG } = {}) {
  const f = D.FILES[0], x = D.fileState(f, { repo, pkg });
  if (x.state !== "applied") return null;
  try { return new Date(fs.statSync(path.join(repo, ...f.rel.split("/"))).mtimeMs).toLocaleDateString("en-CA", { timeZone: "America/Denver" }); } catch { return null; }
}
/** the two records, built from the package's own facts (the files before and after; affectedFrom: the day the runner was applied) */
function records({ nowMs, mtDate, affectedFrom = null }) {
  const at = new Date(nowMs).toISOString(), files = Object.fromEntries(D.FILES.map((f) => [f.rel, { before: f.baseSha, after: f.stagedSha }]));
  const row = { id: CR_ID, date: mtDate, recordedAt: at, area: "nightly seats: the seat-SDK trial (work order 4.31), the launcher's permissions", category: "ops", breaksComparability: false, affectedFrom: affectedFrom || mtDate,
    change: `${TEXT}. From this row, automation/seat-sdk/run-seat.cjs keeps CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 in the launcher's environment (Claude Code strips the API key from the environment of every command a seat runs while it is on) and the launcher therefore runs in the mode Claude Code allows with it, "default" (Claude Code 2.1.227 forces it; the request stays the command line's --permission-mode bypassPermissions, so the launcher's report of "default" witnesses the variable). The runner answers every permission question itself through the Agent SDK's permission callback (canUseTool; the SDK puts --permission-prompt-tool stdio on the launcher's command line): a tool use is allowed only when its name is exactly one of the seat definition's own tools (Read, Grep, Glob, Bash, Write for all six seats), after the start-of-session check has passed and before the run is stopped; every other name is denied with a message; and the one question of the seats' tools that the command line's bypassPermissions refused too is denied as it was there: the launcher's dangerous-removal check (rm / rmdir of the working directory or a folder above it, a critical system folder, or a target it cannot resolve; bypass-immune in Claude Code 2.1.227), known by its reason text; so is a question a settings ask rule forced (the launcher hands it over with matchedAskRule; the command line refused it too). Tool names and counts are recorded, never a tool's input or a request's reason. Two named differences remain, neither reached by the seats' work today (docs/seat-sdk-fix/2026-10-14/NOTES.md, cases 8 and 9): a settings ask rule on a call the tool itself did not ask about (the launcher sends that one without matchedAskRule; none in the setting sources the seats load), and a dangerous removal whose text a compound command hides behind another manual-approval check (no seat runs rm or rmdir). The start-of-session check now requires the key source exactly ANTHROPIC_API_KEY, the permission mode exactly default, the runner's own gate installed (no allowedTools, prompt tool, hooks or inline settings beside it) and the tool list exactly the definition's (no tool beyond it, none missing); anything else stops the seat before any work, as before. UNCHANGED: the prompt bytes, the seat definitions, the tools list handed over, the model tiers, no MCP server, the caps ($2.00-$4.00 a seat, $12 a night, $180 in all), the ledger rules and the end date (2026-11-14 00:00 UTC). The trial's selftest and its fake SDK were updated with it (the fake reports what the real launcher reports and knows canUseTool; five cases that asserted the old instrument assert the new one, and one case is added (a report without a model still runs, the model rule kept as before); none removed: 648 cases, 18 checks).`,
    why: "The first SDK night (2026-10-13) stopped at its start-of-session check: the launcher reported permission mode default because the runner itself sets CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1, which in Claude Code 2.1.227 forces that mode (docs/seat-sdk-fix/2026-10-14/NOTES.md: the launcher's own warning, its code, and a 19-row no-spend probe). Dropping the variable (option A) would have put the API key in the environment of the seats' commands; the main session chose option B on 2026-10-14 (the operator said \"keep working\").",
    comparabilityNote: "A change of instrument inside the SDK path (default mode with the runner's gate, where bypassPermissions was asked for and never ran). No SDK-launched session holds evidence yet (2026-10-13 stopped at its start), so no read spans the two; the launcher change itself was recorded as breaking comparability (seat-sdk-trial-first-night-2026-10-13), and its note applies to every SDK session from here: the seats' reads split or name the sessions by launcher.",
    doesNotChange: "Any registered rule, bar, population, statistic or read condition; the seats' authority (paper only, none over the board); which seats run on the SDK (the switch backend/data/seat-provider.json is not written by this package).",
    owed: "ONE real news-trader night (the switch set by the main session before the 16:15 MT wave: node automation/seat-sdk/set-provider.cjs sdk --seats news-trader --note ...), then the morning after: node automation/seat-sdk/run-seat.cjs --status (the last launch's report and the gate's counts), docs/seat-sdk-trial/2026-10-12/key-check.cjs, and the operator's look at the billing page. Back at any time: node automation/seat-sdk/set-provider.cjs cli; the files: node docs/seat-sdk-fix/2026-10-14/rollback.cjs --apply.",
    operator: "assistant (main session) on the operator's \"keep working\" (2026-10-14); option B chosen by the main session, package docs/seat-sdk-fix/2026-10-14",
    files, package: D.PKG_REL, follows: FOLLOWS };
  const line = { ts: at, kind: "GOVERNANCE", actor: "assistant (main session)", action: "seat-launcher-permissions", tests: ["R13-conditioned"], note: TEXT, changeRegistry: CR_ID };
  return { row, line };
}
function takeLock(lockFile, { waitMs = LOCK_WAIT_MS, sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), now = () => Date.now(), log = () => {} } = {}) {
  const token = `${process.pid}-${now()}-${crypto.randomBytes(4).toString("hex")}`, t0 = now(); let told = false;
  for (;;) {
    let fd;
    try { fd = fs.openSync(lockFile, "wx"); }
    catch (e) {
      if (e.code !== "EEXIST") refuse(`cannot create the lock file ${lockFile} (${e.code || e.message}) — nothing written`);
      if (now() - t0 >= waitMs) refuse(`${path.basename(lockFile)} was held by another writer for more than ${Math.round(waitMs / 1000)} s — nothing written; it is never removed here: re-run when it is gone`);
      if (!told) { log(`the registry lock is held by another writer — waiting up to ${Math.round(waitMs / 1000)} s`); told = true; }
      sleep(1000); continue;
    }
    try { fs.writeSync(fd, JSON.stringify({ token, pid: process.pid, by: `${D.PKG_REL}/record.cjs`, id: CR_ID, at: new Date(now()).toISOString() }) + "\n"); } finally { fs.closeSync(fd); }
    return { release() { try { const j = JSON.parse(fs.readFileSync(lockFile, "utf8")); if (j.token === token) fs.unlinkSync(lockFile); } catch { /* gone, or not ours: left alone */ } } };
  }
}
/** what of the two records is there already -> { row, line } booleans */
function present({ cr, ledgerText }) {
  return { row: cr.some((r) => r && r.id === CR_ID), line: ledgerText.split("\n").some((l) => l.includes(`"changeRegistry":"${CR_ID}"`) && l.includes('"kind":"GOVERNANCE"')) };
}

/** dry or write -> { code, result, lines } (never throws on a refusal) */
function run({ dataDir = path.join(D.REPO, "backend", "data"), repo = D.REPO, pkg = D.PKG, dry = false, now = () => Date.now(), holidays = HOLIDAYS, lockWaitMs = LOCK_WAIT_MS, sleep, log = (s) => console.log(s), atomicFile = path.join(D.REPO, "backend", "lib", "atomic-write.js"), append = fs.appendFileSync } = {}) {
  const lines = [], say = (s) => { lines.push(s); log(s); };
  const crFile = path.join(dataDir, "change-registry.json"), ledgerFile = path.join(dataDir, "agent-ledger.jsonl"), lockFile = path.join(dataDir, "registry-write.lock");
  const load = () => {
    let cr, ledgerText;
    try { cr = JSON.parse(fs.readFileSync(crFile, "utf8")); } catch (e) { refuse(`change-registry.json cannot be read (${e.code || e.message}) — nothing written`); }
    if (!Array.isArray(cr)) refuse("change-registry.json is not a list — nothing written");
    try { ledgerText = fs.readFileSync(ledgerFile, "utf8"); } catch (e) { refuse(`agent-ledger.jsonl cannot be read (${e.code || e.message}) — nothing written`); }
    return { cr, ledgerText };
  };
  try {
    const c0 = mtClock(now(), holidays), P = D.plan({ repo, pkg }), R = records({ nowMs: now(), mtDate: c0.mtDate, affectedFrom: appliedOn({ repo, pkg }) });
    say(`clock: ${c0.mtDate} ${c0.hhmm} MT, ${c0.tradingDay ? "a trading weekday" : "not a trading weekday"}${c0.inWindow ? " (INSIDE the 13:50-15:50 MT no-write window)" : ""}${dry ? " — --dry: nothing is written, no lock is taken" : ""}`);
    const f0 = load(), have = present(f0), why = [];
    if (c0.inWindow) why.push("inside the 13:50-15:50 MT no-write window on a trading weekday (the close chain owns these files then) — run it after 15:50 MT");
    if (P.problems.length || !P.applied) why.push(`the live files are not the staged ones (${P.files.map((x) => `${x.rel} ${x.state}`).join(", ")}) — a change is recorded after it is in: node ${D.PKG_REL}/deploy.cjs --apply first`);
    say(`live: ${P.files.map((x) => `${x.rel} ${x.state}`).join(" · ")}`);
    say(`already there: change-registry row ${have.row ? "YES" : "no"} · ledger line ${have.line ? "YES" : "no"}`);
    say("change-registry.json row:"); say(JSON.stringify(R.row, null, 1));
    say("agent-ledger.jsonl line:"); say(JSON.stringify(R.line));
    if (have.row && have.line) { say("ALREADY RECORDED — both are there; nothing to do, nothing written"); return { code: 0, result: "already", lines }; }
    if (have.row || have.line) why.push(`a PART of this record is there already (${["row", "line"].filter((k) => have[k]).join(", ")}) — look at the two files before anything is written`);
    if (dry) { say(why.length ? `DRY — nothing written. The write would be REFUSED now:\n  - ${why.join("\n  - ")}` : "DRY — nothing written, no lock taken. The write would add the two records above."); return { code: 0, result: "dry", lines, wouldRefuse: why }; }
    if (why.length) refuse(why.join("; "));

    const lock = takeLock(lockFile, { waitMs: lockWaitMs, sleep, log: say });
    let stage = "nothing written";
    try {
      const c = mtClock(now(), holidays); if (c.inWindow) refuse("the clock entered the 13:50-15:50 MT no-write window while this waited for the lock — nothing written");
      const f = load(), h = present(f); if (h.row || h.line) refuse(`a part of this record appeared while this ran (${["row", "line"].filter((k) => h[k]).join(", ")}) — nothing written`);
      const { writeJsonAtomic } = require(atomicFile);
      const n0 = f.cr.length; f.cr.push(R.row); writeJsonAtomic(crFile, f.cr); stage = "the change-registry row is written";
      { const back = JSON.parse(fs.readFileSync(crFile, "utf8")); if (back.length !== n0 + 1 || back[n0].id !== CR_ID) throw new Error("change-registry.json does not read back as written"); }
      append(ledgerFile, (f.ledgerText.length && !f.ledgerText.endsWith("\n") ? "\n" : "") + JSON.stringify(R.line) + "\n"); stage = "the change-registry row is written and a line appended to agent-ledger.jsonl";
      { const tail = fs.readFileSync(ledgerFile, "utf8").trimEnd().split("\n").pop(); let ok = false; try { const j = JSON.parse(tail); ok = j.changeRegistry === CR_ID && j.kind === "GOVERNANCE"; } catch { ok = false; } if (!ok) throw new Error("the ledger line does not read back as written"); }
      say(`WRITTEN: change-registry.json +1 row (${CR_ID}); agent-ledger.jsonl +1 GOVERNANCE line. Each read back.`);
      return { code: 0, result: "written", lines };
    } catch (e) {
      if (stage === "nothing written" || e instanceof Refuse) throw e;
      say(`${stage}, then FAILED (${e.message}). Still owed by hand: ${stage === "the change-registry row is written" ? "the GOVERNANCE line in agent-ledger.jsonl" : "the GOVERNANCE line in agent-ledger.jsonl, unless its last lines hold it (its read-back failed: read them before adding it)"} — the record printed above is the one to add.`);
      return { code: 1, result: "failed", lines };
    } finally { lock.release(); }
  } catch (e) {
    if (!(e instanceof Refuse)) throw e;
    say(`REFUSED — nothing written: ${e.message}`);
    return { code: 2, result: "refused", lines };
  }
}

module.exports = { run, records, mtClock, present, takeLock, appliedOn, CR_ID, FOLLOWS, TEXT, Refuse };

if (require.main === module) {
  const a = process.argv.slice(2);
  if (!(a.length === 0 || (a.length === 1 && a[0] === "--dry"))) { console.log("usage: node docs/seat-sdk-fix/2026-10-14/record.cjs [--dry]\nNothing was done."); process.exit(2); }
  let r; try { r = run({ dry: a[0] === "--dry" }); } catch (e) { console.error(`record FAILED: ${e && e.stack ? e.stack : e}`); process.exit(1); }
  process.exit(r.code);
}
