#!/usr/bin/env node
"use strict";
/**
 * OPTIONS-VANISHED-SETTLES (2026-10-16) — RECORD the change: ONE change-registry row and ONE agent-ledger GOVERNANCE line.
 *
 *   node docs/options-vanished-settles/2026-10-16/record.cjs --dry    print the two records and whether the write would go through; write
 *                                                                    nothing, take no lock (exit 0 unless a file cannot be read)
 *   node docs/options-vanished-settles/2026-10-16/record.cjs          write them — AFTER deploy.cjs --apply and after the operator has read
 *                                                                    one live run of the settle step
 *
 * No test-registry note: no registered test's rule, bar, population or read condition is changed by this package. The rule it adds is NEW and
 * is the operator's to accept (NOTES.md, "The standing rule"), which is why the row below carries breaksComparability TRUE: from the night it
 * is applied, spreads that could never settle do settle, and every settled-options population gains rows it would never have had.
 * REFUSED, nothing written: between 13:50 and 15:50 MT on a trading day (the close chain owns these files then); while home's file is not the
 * staged one (deploy.cjs --apply first); EITHER record already there (both: "already recorded", exit 0; one: refused, saying which);
 * backend/data/registry-write.lock held by another writer for more than 120 s (the lock is made with flag wx; another writer's lock is never
 * removed here).
 * WRITES, under that lock, in this order: change-registry.json through backend/lib/atomic-write.js writeJsonAtomic (read back), then one line
 * appended to agent-ledger.jsonl (append-only, read back). A failure after a write says what is owed.
 * Exit 0 written / already recorded / dry · 1 failed after a write · 2 refused or usage.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const D = require("./deploy.cjs");
const CR_ID = "options-vanished-settles-2026-10-16", KIND = "booking-rule", LOCK_WAIT_MS = 120000;
class Refuse extends Error {}
const refuse = (m) => { throw new Refuse(m); };

/** the MT clock: no write to these files 13:50-15:50 MT on a trading day (Mon-Fri, not a market holiday) */
function mtClock(nowMs, holidays = D.HOLIDAYS) {
  const z = D.zoneParts(nowMs, "America/Denver"), tradingDay = D.tradingDay(z, holidays);
  return { mtDate: z.date, hhmm: z.hhmm, tradingDay, inWindow: tradingDay && z.hm >= 13 * 60 + 50 && z.hm < 15 * 60 + 50 };
}
/** the two records, from the package's own facts (the code before and after) */
function records({ nowMs, mtDate }) {
  const f = D.FILES[0], at = new Date(nowMs).toISOString(), files = { "backend/options-settle.js": { before: f.baseSha, after: f.stagedSha } };
  const row = { id: CR_ID, date: mtDate, recordedAt: at, unit: "options expiry settle (close chain step, home)", tests: [],
    area: "booking — backend/options-settle.js (the nightly sweep that closes the board's expired option spreads)", category: KIND, breaksComparability: true,
    change: "A NEW settle rule. A board option past its expiry that no rule above can price is settled at its intrinsic value at the expiry close when the broker NO LONGER REPORTS its two OCC legs, read only from the stored snapshot backend/data/alpaca-options-positions.json dated after the expiry. The price is a STORED close of the underlying on the expiry date (the position's own recorded close, then backend/data/underlying-closes.json, then the daily bar the same run already read) — never another day's close and never an estimate. The row carries reason \"expiry-vanished\", obs.settleKind \"vanished-legs\", obs.settleTag \"vanished-legs-2026-10-16\", obs.settleCloseSource, obs.brokerSnapshotAsOf and obs.brokerLegs, and its strategy is the one the position carried (never a default). A spread whose legs have vanished but which cannot be priced is NOT settled and NOT guessed: it is flagged on the board (vanishedUnknown: the reason, the expiry, the date it was first raised) and the run exits 2. Separately, a row of the options mirror's log still shown as \"sent\" past its expiry close is marked expired in backend/data/options-mirror-expired.json (idempotent; the mirror's append-only log is read, never rewritten).",
    why: "An expiry is not a fill. The broker reports no closing trade for an expired contract — the position simply stops being reported the next morning — so an expired spread this sweep could not price (anything that is neither a credit vertical nor a verified debit vertical, and any vertical whose underlying returned no completed bar) sat open on the board for good: marked at nothing, in no settled population, and with no fill downstream that could ever close it.",
    doesNotChange: "The credit-wing rule and fix 4.2's verified-debit rule (same arithmetic, same rows, same ledger order — the package's selftest runs the base and the staged file on the same fixtures and compares the three written files byte for byte), the bar calls those rules make, the idempotence rule (a row already in the ledger is never written twice), the exit codes they set, and any registered rule, bar, population or read condition.",
    newRule: "The vanished-legs rule is registered by no test. It is a standing rule from the night this file is applied and the operator's to accept. Every row it writes is tagged (obs.settleTag) so any analysis can include or exclude them, and so they can be found if the rule is withdrawn.",
    operator: `assistant (cloud build session), package ${D.PKG_REL}`, files, package: D.PKG_REL };
  const line = { at, agent: "assistant", kind: "GOVERNANCE", target: "backend/options-settle.js — the nightly options expiry settle",
    what: `NEW RULE: an expired spread whose legs the broker no longer reports settles at its expiry intrinsic from a stored close (tag vanished-legs-2026-10-16), or is flagged UNKNOWN and never guessed; a mirror order still shown as "sent" past its expiry is marked expired. Change-registry row: ${CR_ID}. Rollback: node ${D.PKG_REL}/rollback.cjs --plan.`,
    changeRegistry: CR_ID };
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
  if (!(a.length === 0 || (a.length === 1 && a[0] === "--dry"))) { console.log("usage: node docs/options-vanished-settles/2026-10-16/record.cjs [--dry]\nNothing was done."); process.exit(2); }
  let r; try { r = run({ dry: a[0] === "--dry" }); } catch (e) { console.error(`record FAILED: ${e && e.stack ? e.stack : e}`); process.exit(1); }
  process.exit(r.code);
}
