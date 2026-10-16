#!/usr/bin/env node
"use strict";
/**
 * R275 + R192 FORWARD SHADOWS (2026-10-16) — RECORD the change: ONE change-registry row and ONE agent-ledger
 * GOVERNANCE line. Nothing else: no read-seals.json entry and no test-registry.json note, because the two shadows
 * grade nothing and seal nothing. R275 and R192 are both READ AND SEALED; their entries, their rules, their bars
 * and their read conditions are untouched by this package and must stay that way.
 *
 *   node docs/r275-r192-shadows/2026-10-16/record.cjs --dry    print the two records and whether the write would go
 *                                                              through; write nothing, take no lock
 *   node docs/r275-r192-shadows/2026-10-16/record.cjs          write them — AFTER deploy.cjs --apply, after the two
 *                                                              runners are wired into the nightly chain, and after
 *                                                              the first night has written a row to each JSONL
 *
 * THE ROW (change-registry.json): id r275-r192-shadows-2026-10-16, category measurement-record,
 * breaksComparability false (nothing that already exists changes: three new files, no order, no position, no edit
 * to any ledger, board, seal or registry).
 * REFUSED, nothing written: between 13:50 and 15:50 MT on a trading day; while home does not hold the staged bytes
 * of all three files (record a change after it is in); EITHER record already there (both: "already recorded",
 * exit 0; one: refused, saying which); backend/data/registry-write.lock held by another writer for over 120 s.
 * Exit 0 written / already recorded / dry · 1 failed after a write · 2 refused or usage.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const D = require("./deploy.cjs");
const CR_ID = "r275-r192-shadows-2026-10-16", KIND = "measurement-record", LOCK_WAIT_MS = 120000;
class Refuse extends Error {}
const refuse = (m) => { throw new Refuse(m); };

/** the MT clock: no write to these files 13:50-15:50 MT on a trading day */
function mtClock(nowMs, holidays = D.HOLIDAYS) {
  const z = D.zoneParts(nowMs, "America/Denver"), td = D.tradingDay(z, holidays);
  return { mtDate: z.date, hhmm: z.hhmm, tradingDay: td, inWindow: td && z.hm >= 13 * 60 + 50 && z.hm < 15 * 60 + 50 };
}
/** the two records, from the package's own facts */
function records({ nowMs, mtDate }) {
  const at = new Date(nowMs).toISOString();
  const files = Object.fromEntries(D.FILES.map((f) => [f.rel, { before: null, after: f.stagedSha }]));
  const row = { id: CR_ID, date: mtDate, recordedAt: at, unit: "forward shadows for R275 and R192 (close chain, home)", tests: ["R275", "R192"], area: "measurement — two new weightless recorders beside the sealed reads", category: KIND, breaksComparability: false,
    change: "Three new files. backend/r275-release-shadow.js records, each session, what R275's release-day filter would have done to the two short-premium option sleeves: the session's CPI/NFP/FOMC classification, the 0DTE cell (tickets, mean R, P&L, and whether the filter would have skipped the session), every wing opened that session with the filter's verdict on it, and every wing that settled. backend/r192-month-end-shadow.js records, each session, whether R192's rule would have been long AGG/LQD/MUB into the month-end close, and at each month end the registered statistic for that month (each fund alone, HYG as the contrast, the month's daily returns kept in the row). backend/lib/shadow-ledger.js is the append-only record both write through: one row per kind+key, never rewritten, a gap row where a number could not be read.",
    why: "Both rules passed on history and were sealed, and nothing ran them forward: from the day they sealed they produced no new evidence at all. A shadow is the cheapest way to change that — it earns an out-of-sample record without risking a dollar.",
    doesNotChange: "No order of any kind is placed, no position is held, no board, ledger, seal or registry entry is written. R275's and R192's registry entries, rules, bars, populations and read conditions are untouched; both reads stay spent, and neither shadow is a second read of either. The registry's own audit note on R192 stands: it is not independent of R180.",
    notGiven: "R275's registry entry is redacted in the clean copy the package was built in (reduced to {id, screenRedacted}), so the rule text was taken from the sealed read itself, backend/r275-release-filter.js. Check it against the full registry entry at home before the forward record is believed (NOTES.md, 'The one thing to check first').",
    operator: `assistant (main session), package ${D.PKG_REL}`, files, package: D.PKG_REL };
  const line = { at, agent: "assistant", kind: "GOVERNANCE", target: "backend/r275-release-shadow.js, backend/r192-month-end-shadow.js, backend/lib/shadow-ledger.js", what: `Forward shadows for the sealed R275 and R192: each session they record what the rule would have done, to their own JSONL. No orders, no positions, no seals. Change-registry row: ${CR_ID}. Rollback: node ${D.PKG_REL}/rollback.cjs --plan.`, changeRegistry: CR_ID, tests: ["R275", "R192"] };
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
    if (c0.inWindow) why.push("inside the 13:50-15:50 MT no-write window on a trading day — run it after 15:50 MT");
    if (Pl.problems.length || !Pl.applied) why.push(`home does not hold the staged bytes of all three files (${Pl.files.map((x) => `${x.rel} ${x.state}`).join(", ")}${Pl.problems.length ? "; " + Pl.problems.join("; ") : ""}) — a change is recorded after it is in: node ${D.PKG_REL}/deploy.cjs --apply first`);
    say(`home: ${Pl.files.map((x) => `${x.rel} ${x.state}`).join(" · ")}`);
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
  if (!(a.length === 0 || (a.length === 1 && a[0] === "--dry"))) { console.log("usage: node docs/r275-r192-shadows/2026-10-16/record.cjs [--dry]\nNothing was done."); process.exit(2); }
  let r; try { r = run({ dry: a[0] === "--dry" }); } catch (e) { console.error(`record FAILED: ${e && e.stack ? e.stack : e}`); process.exit(1); }
  process.exit(r.code);
}
