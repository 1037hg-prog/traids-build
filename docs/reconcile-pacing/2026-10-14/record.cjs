#!/usr/bin/env node
"use strict";
/**
 * RECONCILE PACING (2026-10-14) — RECORD the change: ONE change-registry row and ONE agent-ledger GOVERNANCE line.
 *
 *   node docs/reconcile-pacing/2026-10-14/record.cjs --dry    print the two records and whether the write would go through; write nothing,
 *                                                             take no lock (exit 0 unless a file cannot be read)
 *   node docs/reconcile-pacing/2026-10-14/record.cjs          write them — the main session's command, AFTER deploy.cjs --apply and
 *                                                             verify-live.cjs
 *
 * No test-registry note: the reconcile grades no registered test. The R355 draft (docs/wide-spread-twin/2026-10-14, not minted) names this
 * patch as its precondition; the row says which parts of it this package gives and which it does not (NOTES.md, "R355").
 * THE ROW (change-registry.json): id reconcile-pacing-2026-10-14, category measurement-fix, breaksComparability false (every answered row is
 * the row the old code wrote, byte for byte; a failed call is UNKNOWN where it was "no record", and the night of 2026-10-14 had none).
 * THE LINE (agent-ledger.jsonl): kind GOVERNANCE, naming the row.
 * REFUSED, nothing written: between 13:50 and 15:50 MT on a trading day (Mon-Fri, not a market holiday: the close chain owns these files
 * then); while home's file is not the staged one (deploy.cjs --apply first: a change is recorded after it is in); EITHER record already
 * there (both: "already recorded", exit 0; one: refused, saying which); backend/data/registry-write.lock held by another writer for more than
 * 120 s (the lock is created with flag wx; another writer's lock is never removed).
 * WRITES, under that lock, in this order: change-registry.json through backend/lib/atomic-write.js writeJsonAtomic (read back), then one
 * line appended to agent-ledger.jsonl (append-only, as every ledger writer does; read back). A failure after a write says what is owed.
 * Exit 0 written / already recorded / dry · 1 failed after a write · 2 refused or usage.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const D = require("./deploy.cjs");
const CR_ID = "reconcile-pacing-2026-10-14", KIND = "measurement-fix", LOCK_WAIT_MS = 120000;
class Refuse extends Error {}
const refuse = (m) => { throw new Refuse(m); };

/** the MT clock: no write to these files 13:50-15:50 MT on a trading day (Mon-Fri, not a market holiday) */
function mtClock(nowMs, holidays = D.HOLIDAYS) {
  const z = D.zoneParts(nowMs, "America/Denver"), tradingDay = D.tradingDay(z, holidays);
  return { mtDate: z.date, hhmm: z.hhmm, tradingDay, inWindow: tradingDay && z.hm >= 13 * 60 + 50 && z.hm < 15 * 60 + 50 };
}
/** the two records, from the package's own facts (the code before and after) */
function records({ nowMs, mtDate }) {
  const f = D.FILES[0], at = new Date(nowMs).toISOString(), files = { "backend/alpaca-reconcile.js": { before: f.baseSha, after: f.stagedSha } };
  const row = { id: CR_ID, date: mtDate, recordedAt: at, unit: "alpaca reconcile (close chain step, home)", tests: [], area: "broker record — backend/alpaca-reconcile.js (the nightly grade of the Alpaca paper mirror against our ledger, main paper account)", category: KIND, breaksComparability: false,
    change: "Every broker call goes through one limiter (110 a minute with a burst of 10: never more than 120 in any minute, against the account's 200 for every runner); a 429's Retry-After holds every call, and so does X-RateLimit-Remaining at or under 20; a 429, 5xx, timeout, no answer or an unreadable answer is retried with backoff (4 tries), all inside a 180 s budget. A call that still fails, or is not made because the budget or the key ran out, makes its ticket UNKNOWN (reconcileStatus, unknownReason, httpStatus) — never 'broker has no record', unfilled or missing — and the next run asks again; a 404 stays 'broker has no record of this order', now with httpStatus 404. New top-level failedCalls, unknown and calls; the reading starts 'UNKNOWN:' and the run exits 3 when any ticket is UNKNOWN. --dry-print <file> writes the output to a file outside backend/data.",
    why: "The registrar of the wide-spread twin (docs/wide-spread-twin/2026-10-14, attack 2 D1) found about 155 unpaced calls a night against the main paper account's 200 a minute, and every failed call (429, 5xx, timeout, network) written as 'broker has no record of this order': at the mirror's flow, within about six sessions real fills would have read as missing to every reader of the broker record.",
    doesNotChange: "Every row whose calls were answered (byte for byte: the package's replay of the night of 2026-10-14, 155 recorded answers), the calls made (the same two endpoints for the same tickets), the order rows, the ledger, the chain line (W3's anchor), W5's fix-4 edit (W5's judge still reads it applied), and any registered rule, bar, population or read condition.",
    notGiven: "R355's precondition also asks for brokerStatus and filledAt on every row it reads; this package keeps every answered row byte for byte, so those two fields are owed by a separate change (NOTES.md, 'R355').",
    operator: `assistant (main session), package ${D.PKG_REL}`, files, package: D.PKG_REL };
  const line = { at, agent: "assistant", kind: "GOVERNANCE", target: "backend/alpaca-reconcile.js — the Alpaca paper broker record", what: `Broker calls paced and retried; a failed call is UNKNOWN for its ticket, never 'no record' (every answered row unchanged). Change-registry row: ${CR_ID}. Rollback: node ${D.PKG_REL}/rollback.cjs --plan.`, changeRegistry: CR_ID };
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
function run({ dataDir = path.join(D.REPO, "backend", "data"), repo = D.REPO, pkg = D.PKG, dry = false, now = () => Date.now(), holidays = D.HOLIDAYS, lockWaitMs = LOCK_WAIT_MS, sleep, log = (s) => console.log(s) } = {}) {
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
    const c0 = mtClock(now(), holidays), Pl = D.plan({ repo, pkg }), R = records({ nowMs: now(), mtDate: c0.mtDate });
    say(`clock: ${c0.mtDate} ${c0.hhmm} MT, ${c0.tradingDay ? "a trading day" : "not a trading day"}${c0.inWindow ? " (INSIDE the 13:50-15:50 MT no-write window)" : ""}${dry ? " — --dry: nothing is written, no lock is taken" : ""}`);
    const f0 = load(), have = present(f0), why = [];
    if (c0.inWindow) why.push("inside the 13:50-15:50 MT no-write window on a trading day (the close chain owns these files then) — run it after 15:50 MT");
    if (Pl.problems.length || !Pl.applied) why.push(`home's file is not the staged one (${Pl.files.map((x) => `${x.rel} ${x.state}`).join(", ")}${Pl.problems.length ? "; " + Pl.problems.join("; ") : ""}) — the change is recorded after it is in: node ${D.PKG_REL}/deploy.cjs --apply first`);
    say(`home: ${Pl.files.map((x) => `${x.rel} ${x.state} (${String(x.home).slice(0, 12)})`).join(" · ")}`);
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
      const { writeJsonAtomic } = require(path.join(repo, "backend", "lib", "atomic-write.js"));
      const n0 = f.cr.length; f.cr.push(R.row); writeJsonAtomic(crFile, f.cr); stage = "the change-registry row is written";
      { const back = JSON.parse(fs.readFileSync(crFile, "utf8")); if (back.length !== n0 + 1 || back[n0].id !== CR_ID) throw new Error("change-registry.json does not read back as written"); }
      fs.appendFileSync(ledgerFile, (f.ledgerText.length && !f.ledgerText.endsWith("\n") ? "\n" : "") + JSON.stringify(R.line) + "\n"); stage = "both are written";
      { const tail = fs.readFileSync(ledgerFile, "utf8").trimEnd().split("\n").pop(); let ok = false; try { ok = JSON.parse(tail).changeRegistry === CR_ID; } catch { ok = false; } if (!ok) throw new Error("the ledger line does not read back as written"); }
      say(`WRITTEN: change-registry.json +1 row (${CR_ID}); agent-ledger.jsonl +1 GOVERNANCE line. Each read back.`);
      return { code: 0, result: "written", lines };
    } catch (e) {
      if (stage === "nothing written" || e instanceof Refuse) throw e;
      say(`${stage}, then FAILED (${e.message}). Still owed by hand: ${stage === "the change-registry row is written" ? "the GOVERNANCE line in agent-ledger.jsonl" : "nothing (check the ledger's last line)"} — the records printed above are the ones to add.`);
      return { code: 1, result: "failed", lines };
    } finally { lock.release(); }
  } catch (e) {
    if (!(e instanceof Refuse)) throw e;
    say(`REFUSED — nothing written: ${e.message}`);
    return { code: 2, result: "refused", lines };
  }
}

module.exports = { run, records, mtClock, present, takeLock, CR_ID, KIND, Refuse };

if (require.main === module) {
  const a = process.argv.slice(2);
  if (!(a.length === 0 || (a.length === 1 && a[0] === "--dry"))) { console.log("usage: node docs/reconcile-pacing/2026-10-14/record.cjs [--dry]\nNothing was done."); process.exit(2); }
  let r; try { r = run({ dry: a[0] === "--dry" }); } catch (e) { console.error(`record FAILED: ${e && e.stack ? e.stack : e}`); process.exit(1); }
  process.exit(r.code);
}
