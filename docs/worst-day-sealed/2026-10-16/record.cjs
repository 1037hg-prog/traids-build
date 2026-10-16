#!/usr/bin/env node
"use strict";
/**
 * WORST-DAY SEALED FORECAST LEDGER (2026-10-16) — RECORD. One change-registry row and one agent-ledger GOVERNANCE line.
 *
 * NO TEST REGISTRY ENTRY IS WRITTEN AND NO REGISTERED TEST CHANGES. What this package adds is the INSTRUMENT a forward test would
 * need — a sealed record of what was forecast and when — not the test. The bar, population and read condition of a forward test on
 * this forecaster are NOT set here and must be registered on their own, before the ledger is read for a verdict; sealed-grade.js
 * therefore prints `enoughToRead: false` until 252 matured rows and 20 worst days are in, and says in words that it is a scoreboard
 * and not a verdict. The preregistered form of that test is printed by --dry as `preregistrationOwed`, for the operator to register
 * by hand after reading it; this script never writes it.
 *
 *   node docs/worst-day-sealed/2026-10-16/record.cjs --dry   print both records and whether the write would go through; write
 *                                                            nothing, take no lock (exit 0 unless a file cannot be read)
 *   node docs/worst-day-sealed/2026-10-16/record.cjs         write them — AFTER deploy.cjs --apply
 *
 * REFUSED, nothing written: between 13:50 and 15:50 MT on a trading day · while the seven files are not all applied (a change is
 * recorded after it is in) · when a PART of the record is already there (both there: "already recorded", exit 0) · when
 * backend/data/registry-write.lock is held by another writer for more than 120 s (created with flag wx; another writer's lock is
 * never removed). WRITES, under that lock: change-registry.json through backend/lib/atomic-write.js writeJsonAtomic (read back),
 * then one line appended to agent-ledger.jsonl (read back).
 * Exit 0 written / already recorded / dry · 1 failed after a write · 2 refused or usage.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const L = require("./lib.cjs");

const CR_ID = "worst-day-sealed-2026-10-16", LOCK_WAIT_MS = 120000;
class Refuse extends Error {}
const refuse = (m) => { throw new Refuse(m); };

/** the two records, from the package's own facts */
function records({ nowMs, mtDate, U = L.unit() }) {
  const at = new Date(nowMs).toISOString();
  const files = Object.fromEntries(L.REL_PATHS.map((rel) => [rel, { before: null, after: U[rel].stagedSha }]));
  const row = {
    id: CR_ID, date: mtDate, recordedAt: at,
    area: "worst-day predictor — a sealed nightly forecast ledger, its checker and its grader (backend/worst-day/)",
    category: "new instrument", breaksComparability: false,
    change: `Seven NEW files under backend/worst-day/, none of the existing ones changed. sealed-ledger.js writes an append-only JSONL ledger of one row per session: the probability that the NEXT session is a worst-5% day, the storm state, the point-in-time 5% threshold the label will be read against, the decision close it was built on, the instant it was written, and the sha256 of the row before it. sealed-check.js runs eleven checks over the whole ledger and REFUSES it outright when any row's createdAt is at or after 09:30 ET of the session it forecasts, when the hash chain breaks, when the tip file no longer names the last row, or when a forDate is not a session. nightly-forecast.js is the job (--plan / --write); it refuses to write after the seal closes, onto a ledger that does not pass, or from stale bars. nightly-model.js is the forecaster: run.js's label (nearest-rank 5th percentile of the trailing 1,260 sessions) and the PRICE-ONLY SUBSET of its fifteen inputs (seven: lnRv5 lnRv20 lnRv60 ret1 ret5 dist50 dist200), a ridge logistic at lambda 10 refit on every labelled session known at the decision close, with the storm state formed from two causal flags (the model's own training top decile, and rule of thumb (a)). sealed-grade.js scores matured rows only: Brier against always-5% and against in-sample climatology, Murphy's decomposition, a six-bin calibration table fixed in advance, and a per-storm-state table. The known answers ship beside the code in sealed-selftest.js, on synthetic bars made by the seeded generator in sealed-fixtures.js.`,
    why: "forward-power.js sized a forward test of the worst-day forecaster and said what it would need: forecasts that were on record BEFORE the session they name. Nothing in the repo recorded one. Walk-forward numbers refit each January are not that evidence and say so. This is the instrument that makes a forward read possible later; it is not the read, and it is not a trading rule.",
    doesNotChange: "Any registered test's rule, bar, population, statistic or read condition. Any existing file: backend/worst-day/lib.js, dataset.js, wf.js, verify.js, forward-power.js and the rest are untouched. Nothing live loads the new files until the operator schedules the job; applying them changes no behaviour at all. No order of any kind; no broker call; no network call.",
    limits: "The nightly model is WEAKER than run.js's by construction (7 price-only inputs, not 15) so a row can be reproduced from one file. The ledger is tamper-EVIDENT, not tamper-proof: there is no signature and no outside witness, so a hand that rewrites a row, re-hashes every row after it and rewrites the tip leaves nothing to find. A score over a few dozen rows means nothing; the grader refuses to call it a read below 252 matured rows and 20 worst days.",
    operator: `assistant (cloud build session), package ${L.PKG_REL}`, files, package: L.PKG_REL,
    rollback: `node ${L.PKG_REL}/rollback.cjs --plan, then --apply (it removes exactly these seven files; the ledger it wrote is data and is never removed)`,
  };
  const line = { at, agent: "assistant", kind: "GOVERNANCE", target: "worst-day predictor — sealed nightly forecast ledger (backend/worst-day/sealed-*.js, nightly-*.js)",
    what: `Six new files: an append-only hash-chained ledger of tomorrow's worst-day probability and storm state written before 09:30 ET, a checker that refuses the whole ledger on any late or altered row, the nightly job, the price-only forecaster, and a grader (Brier + calibration table) that scores matured rows only. No existing file and no registered test's rule changes. Change-registry row: ${CR_ID}. Rollback: node ${L.PKG_REL}/rollback.cjs --plan.`,
    changeRegistry: CR_ID };
  const preregistrationOwed = {
    note: "NOT WRITTEN BY THIS SCRIPT. The forward test this ledger makes possible, in the form it would have to be registered in BEFORE any row of it is read for a verdict. Register it by hand, or not at all; the ledger accumulates either way.",
    title: "Worst-day nightly forecast — does a sealed, pre-open probability beat 'always 5%' out of sample?",
    runner: "backend/worst-day/sealed-grade.js",
    rule: "Each session, backend/worst-day/nightly-forecast.js --write states p, the probability that the next session's SPY close-to-close total return is at or below the nearest-rank 5th percentile of the trailing 1,260 sessions as of that close, and writes it into an append-only hash-chained ledger before 09:30 ET of that session. A row that sealed-check.js refuses is not in the population.",
    population: "every row of the ledger that has matured (the bar file holds its session and the session before it) and that sealed-check.js passes",
    bar: { fixedInAdvance: true, minSessions: 252, minWorstDays: 20, statistic: "Brier skill against the always-5% forecast, over matured rows",
      confirmIf: "the day-clustered t of per-session (always-5% squared miss minus model squared miss) is at or above 2.0, with at least 252 matured rows and at least 20 worst days",
      decisionRule: "CONFIRMED -> the nightly probability is worth reading; NOT CONFIRMED -> it is retired and the ledger stands as the record of why",
      formsSearched: 1, formsNote: "ONE form: the price-only logistic as shipped, graded by Brier against always-5%. The calibration table and the storm table are printed as description and carry no bar." },
    hypothesis: "NEUTRAL. forward-power.js's walk-forward sizing is in-sample and is not evidence for this test.",
  };
  return { row, line, preregistrationOwed };
}

function mtClock(nowMs) { const m = L.mtNow(nowMs); return { ...m, tradingDay: L.isTradingDay(m.date), inWindow: L.isTradingDay(m.date) && m.minutes >= 13 * 60 + 50 && m.minutes < 15 * 60 + 50 }; }
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
    try { fs.writeSync(fd, JSON.stringify({ token, pid: process.pid, by: `${L.PKG_REL}/record.cjs`, id: CR_ID, at: new Date(now()).toISOString() }) + "\n"); } finally { fs.closeSync(fd); }
    return { release() { try { const j = JSON.parse(fs.readFileSync(lockFile, "utf8")); if (j.token === token) fs.unlinkSync(lockFile); } catch { /* gone, or not ours */ } } };
  }
}
const present = ({ cr, ledgerText }) => ({ row: cr.some((r) => r && r.id === CR_ID), line: ledgerText.split("\n").some((l) => l.includes(`"changeRegistry":"${CR_ID}"`) && l.includes('"kind":"GOVERNANCE"')) });

function run({ dataDir = path.join(L.REPO, "backend", "data"), dry = false, now = () => Date.now(), lockWaitMs = LOCK_WAIT_MS, sleep, log = (s) => console.log(s), writeJson = null, appendLedger = (f, s) => fs.appendFileSync(f, s) } = {}) {
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
    const c0 = mtClock(now()), P = L.plan(), R = records({ nowMs: now(), mtDate: c0.date });
    say(`clock: ${c0.date} ${c0.hms} MT, ${c0.tradingDay ? "a trading day" : "not a trading day"}${c0.inWindow ? " (INSIDE the 13:50-15:50 MT no-write window)" : ""}${dry ? " — --dry: nothing is written, no lock is taken" : ""}`);
    say(`home: the package reads ${P.state} (${P.files.filter((f) => f.state === "applied").length} of ${P.files.length} files in place)`);
    say("change-registry.json row:"); say(JSON.stringify(R.row, null, 1));
    say("agent-ledger.jsonl line:"); say(JSON.stringify(R.line));
    say("NOT WRITTEN — the forward test this ledger would make possible, for the operator to register by hand if it is wanted:");
    say(JSON.stringify(R.preregistrationOwed, null, 1));
    const why = [];
    if (c0.inWindow) why.push("inside the 13:50-15:50 MT no-write window on a trading day — run it after 15:50 MT");
    if (P.state !== "applied") why.push(`the package reads ${P.state.toUpperCase()}, not applied — a change is recorded after it is in: node ${L.PKG_REL}/deploy.cjs --apply first`);
    const f0 = load(), have = present(f0);
    say(`already there: change-registry row ${have.row ? "YES" : "no"} · ledger line ${have.line ? "YES" : "no"}`);
    if (have.row && have.line) { say("ALREADY RECORDED — both are there; nothing to do, nothing written"); return { code: 0, result: "already", lines }; }
    if (have.row || have.line) why.push(`a PART of this record is there already (${have.row ? "the row" : "the line"}) — look at the two files before anything is written`);
    if (dry) { say(why.length ? `DRY — nothing written. The write would be REFUSED now:\n  - ${why.join("\n  - ")}` : "DRY — nothing written, no lock taken. The write would add the two records above."); return { code: 0, result: "dry", lines, wouldRefuse: why }; }
    if (why.length) refuse(why.join("; "));

    const lock = takeLock(lockFile, { waitMs: lockWaitMs, sleep, now, log: say });
    let stage = "nothing written";
    try {
      const c = mtClock(now()); if (c.inWindow) refuse("the clock entered the 13:50-15:50 MT no-write window while this waited for the lock — nothing written");
      const f = load(), h = present(f); if (h.row || h.line) refuse(`a part of this record appeared while this ran (${h.row ? "the row" : "the line"}) — nothing written`);
      const writeJsonAtomic = writeJson || require(path.join(L.REPO, "backend", "lib", "atomic-write.js")).writeJsonAtomic;
      const n0 = f.cr.length; writeJsonAtomic(crFile, [...f.cr, R.row]); stage = "change-registry.json is written";
      { const back = JSON.parse(fs.readFileSync(crFile, "utf8")); if (back.length !== n0 + 1 || back[n0].id !== CR_ID) throw new Error("change-registry.json does not read back as written"); }
      stage = "the change-registry row is written";
      appendLedger(ledgerFile, (f.ledgerText.length && !f.ledgerText.endsWith("\n") ? "\n" : "") + JSON.stringify(R.line) + "\n"); stage = "both are written";
      { const tail = fs.readFileSync(ledgerFile, "utf8").trimEnd().split("\n").pop(); let okLine = false; try { okLine = JSON.parse(tail).changeRegistry === CR_ID; } catch { okLine = false; } if (!okLine) throw new Error("the ledger line does not read back as written"); }
      say(`WRITTEN: change-registry.json +1 row (${CR_ID}); agent-ledger.jsonl +1 GOVERNANCE line. Each read back. No test-registry entry was written.`);
      return { code: 0, result: "written", lines };
    } catch (e) {
      if (stage === "nothing written" || e instanceof Refuse) throw e;
      const owed = stage === "change-registry.json is written" ? "the change-registry row (look at that file first) and the GOVERNANCE line" : stage === "the change-registry row is written" ? "the GOVERNANCE line in agent-ledger.jsonl" : "nothing (check the ledger's last line)";
      say(`${stage}, then FAILED (${e.message}). Still owed by hand: ${owed} — the record printed above is the one to add.`);
      return { code: 1, result: "failed", lines };
    } finally { lock.release(); }
  } catch (e) {
    if (!(e instanceof Refuse)) throw e;
    say(`REFUSED — nothing written: ${e.message}`);
    return { code: 2, result: "refused", lines };
  }
}

module.exports = { run, records, mtClock, present, takeLock, CR_ID, Refuse };

if (require.main === module) {
  const a = process.argv.slice(2);
  if (!(a.length === 0 || (a.length === 1 && a[0] === "--dry"))) { console.log(`usage: node ${L.PKG_REL}/record.cjs [--dry]\nNothing was done.`); process.exit(2); }
  let r; try { r = run({ dry: a[0] === "--dry" }); } catch (e) { console.error(`record FAILED: ${e && e.stack ? e.stack : e}`); process.exit(1); }
  process.exit(r.code);
}
