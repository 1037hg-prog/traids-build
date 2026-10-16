#!/usr/bin/env node
"use strict";
/**
 * INSIDER CLUSTERS (2026-10-16) — RECORD the change: ONE change-registry row and ONE agent-ledger GOVERNANCE line.
 *
 *   node docs/insider-clusters/2026-10-16/record.cjs --dry    print the two records and whether the write would go through; write
 *                                                            nothing, take no lock (exit 0 unless a file cannot be read)
 *   node docs/insider-clusters/2026-10-16/record.cjs          write them — the main session's command, AFTER deploy.cjs --apply
 *
 * NO TEST-REGISTRY NOTE, DELIBERATELY. This package grades nothing and registers nothing. It adds a collector and a cluster finder;
 * what they find is not a claim until a test over it is registered AT HOME, before any of this data is read. The row says so in
 * `notGiven`, so that a later reader cannot mistake "the collector shipped" for "the signal was tested".
 * THE ROW (change-registry.json): id insider-clusters-2026-10-16, category new-collector, breaksComparability false (it adds six new
 * files and changes none; no registered rule, bar, population or read condition is touched).
 * THE LINE (agent-ledger.jsonl): kind GOVERNANCE, naming the row.
 * REFUSED, nothing written: between 13:50 and 15:50 MT on a trading day (the close chain owns these files then); while home does not
 * hold the six staged files (deploy.cjs --apply first: a change is recorded after it is in); EITHER record already there (both:
 * "already recorded", exit 0; one: refused, saying which); backend/data/registry-write.lock held by another writer for more than
 * 120 s (the lock is created with flag wx; another writer's lock is never removed).
 * WRITES, under that lock, in this order: change-registry.json through backend/lib/atomic-write.js writeJsonAtomic (read back), then
 * one line appended to agent-ledger.jsonl (append-only, as every ledger writer does; read back). A failure after a write says what is
 * owed. Exit 0 written / already recorded / dry · 1 failed after a write · 2 refused or usage.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const D = require("./deploy.cjs");
const CR_ID = "insider-clusters-2026-10-16", KIND = "new-collector", LOCK_WAIT_MS = 120000;
class Refuse extends Error {}
const refuse = (m) => { throw new Refuse(m); };

/** the MT clock: no write to these files 13:50-15:50 MT on a trading day (Mon-Fri, not a market holiday) */
function mtClock(nowMs, holidays = D.HOLIDAYS) {
  const z = D.zoneParts(nowMs, "America/Denver"), tradingDay = D.tradingDay(z, holidays);
  return { mtDate: z.date, hhmm: z.hhmm, tradingDay, inWindow: tradingDay && z.hm >= 13 * 60 + 50 && z.hm < 15 * 60 + 50 };
}

/** the two records, from the package's own facts */
function records({ nowMs, mtDate }) {
  const at = new Date(nowMs).toISOString();
  const files = Object.fromEntries(D.FILES.map((f) => [f.rel, { before: null, after: f.stagedSha }]));
  const row = {
    id: CR_ID, date: mtDate, recordedAt: at, unit: "SEC Form 4 insider buys (a collector for the server) and the cluster finder over it",
    tests: [],
    area: "new files only — backend/lib/sec-fetch.js, backend/lib/form4-parse.js, backend/lib/insider-buys-lib.js, backend/lib/insider-cluster-lib.js, backend/insider-buys-collect.js, backend/insider-clusters.js",
    category: KIND, breaksComparability: false,
    change: "A collector that reads the SEC's daily Form 4 filings and records, per company per TRANSACTION day, the number of DISTINCT insiders (officers and directors, by reporting-owner CIK) who bought on the open market (non-derivative, transaction code P, acquired, priced, common stock), the total dollars and their roles, into one dated JSONL per filing day (backend/data/insider-buys/insider-buys-<day>.jsonl, written through writeTextAtomic; merging is keyed by accession, so re-running a day changes nothing and a later filing only adds). Dollars are summed over ACCESSIONS and insiders counted over OWNERS, so a joint filing's money is counted once while both filers count as insiders. A 4/A amendment restates a filing already counted and is not summed. Every read of sec.gov goes through one new fetch layer with an INJECTED fetcher, a REQUIRED declared User-Agent (no default: there is no contact string in the repository) and the SEC's own ten-requests-a-second limit as a ceiling, with retries, Retry-After and an SEC-hosts-only allowlist. A second entry point finds CLUSTERS: three or more distinct insiders at one issuer inside TEN TRADING DAYS counted inclusively against MARKET_HOLIDAYS, one company-day to at most one cluster, each cluster carrying both the trigger buy day and `publicOn` (the day its last filing appeared — the only date a reader may act on without look-ahead).",
    why: "R137 built its cluster signal once, by hand, from the SEC's quarterly bulk files, for a single six-month read. There was no daily collector and no record of what the filings said on the day they appeared, so nothing could be watched forward and no later test could be run over the same data without rebuilding it. This adds the record.",
    doesNotChange: "No existing file is touched (all six paths are new). No registered rule, bar, population or read condition is read or changed. No broker call, no order, no key, no schedule, no restart. R137's own files and store are untouched.",
    notGiven: "It registers NO test and grades nothing: what the collector finds is not a claim until a test over it is registered at home, before any of this data is read. It also does not separate an open-market purchase from a privately negotiated one (the SEC's code P covers both and the filing does not say which), does not read derivative transactions, and skips 4/A amendments rather than reconciling them against the originals.",
    operator: `assistant (main session), package ${D.PKG_REL}`,
    files, package: D.PKG_REL,
  };
  const line = {
    at, agent: "assistant", kind: "GOVERNANCE",
    target: "backend/insider-buys-collect.js and backend/insider-clusters.js — the SEC Form 4 insider-buy record",
    what: `A daily collector for Form 4 open-market purchases by officers and directors (distinct insiders, dollars and roles per company per day, to a dated JSONL) and a cluster finder over it (three or more insiders inside ten trading days). Six new files; nothing existing changed; no test registered and nothing graded. Change-registry row: ${CR_ID}. Rollback: node ${D.PKG_REL}/rollback.cjs --plan.`,
    changeRegistry: CR_ID,
  };
  return { row, line };
}

function takeLock(lockFile, { waitMs = LOCK_WAIT_MS, sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), now = () => Date.now(), log = () => {} } = {}) {
  const token = `${process.pid}-${now()}-${crypto.randomBytes(4).toString("hex")}`, t0 = now();
  let told = false;
  for (;;) {
    let fd;
    try { fd = fs.openSync(lockFile, "wx"); }
    catch (e) {
      if (e.code !== "EEXIST") refuse(`cannot create the lock file ${lockFile} (${e.code || e.message}) — nothing written`);
      if (now() - t0 >= waitMs) refuse(`${path.basename(lockFile)} was held by another writer for more than ${Math.round(waitMs / 1000)} s — nothing written; it is never removed here: re-run when it is gone`);
      if (!told) { log(`the registry lock is held by another writer — waiting up to ${Math.round(waitMs / 1000)} s`); told = true; }
      sleep(1000);
      continue;
    }
    try { fs.writeSync(fd, JSON.stringify({ token, pid: process.pid, by: `${D.PKG_REL}/record.cjs`, id: CR_ID, at: new Date(now()).toISOString() }) + "\n"); } finally { fs.closeSync(fd); }
    return { release() { try { const j = JSON.parse(fs.readFileSync(lockFile, "utf8")); if (j.token === token) fs.unlinkSync(lockFile); } catch { /* gone, or not ours: left alone */ } } };
  }
}

/** what of the two records is there already -> { row, line } booleans */
function present({ cr, ledgerText }) {
  return {
    row: cr.some((r) => r && r.id === CR_ID),
    line: ledgerText.split("\n").some((l) => l.includes(`"changeRegistry":"${CR_ID}"`) && l.includes('"kind":"GOVERNANCE"')),
  };
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
    say(`home: ${Pl.files.map((x) => `${path.basename(x.rel)} ${x.state}`).join(" · ")}`);
    say("change-registry.json row:"); say(JSON.stringify(R.row, null, 1));
    say("agent-ledger.jsonl line:"); say(JSON.stringify(R.line));
    const why = [];
    if (c0.inWindow) why.push("inside the 13:50-15:50 MT no-write window on a trading day (the close chain owns these files then) — run it after 15:50 MT");
    if (Pl.problems.length || !Pl.applied) why.push(`home does not hold the six staged files (${Pl.files.map((x) => `${path.basename(x.rel)} ${x.state}`).join(", ")}${Pl.problems.length ? "; " + Pl.problems.join("; ") : ""}) — a change is recorded after it is in: node ${D.PKG_REL}/deploy.cjs --apply first`);
    let f0 = null, have = { row: false, line: false };
    if (dry) {
      const r = (() => { try { return load(); } catch (e) { if (e instanceof Refuse) { say(`the two files could not both be read (${e.message}) — the write would be refused`); return null; } throw e; } })();
      if (r) { have = present(r); say(`already there: change-registry row ${have.row ? "YES" : "no"} · ledger line ${have.line ? "YES" : "no"}`); }
      if (r && have.row && have.line) { say("ALREADY RECORDED — both are there; nothing to do, nothing written"); return { code: 0, result: "already", lines }; }
      if (r && (have.row || have.line)) why.push(`a PART of this record is there already (${["row", "line"].filter((k) => have[k]).join(", ")}) — look at the two files before anything is written`);
      say(why.length ? `DRY — nothing written. The write would be REFUSED now:\n  - ${why.join("\n  - ")}` : "DRY — nothing written, no lock taken. The write would add the two records above.");
      return { code: 0, result: "dry", lines, wouldRefuse: why };
    }
    f0 = load();
    have = present(f0);
    say(`already there: change-registry row ${have.row ? "YES" : "no"} · ledger line ${have.line ? "YES" : "no"}`);
    if (have.row && have.line) { say("ALREADY RECORDED — both are there; nothing to do, nothing written"); return { code: 0, result: "already", lines }; }
    if (have.row || have.line) why.push(`a PART of this record is there already (${["row", "line"].filter((k) => have[k]).join(", ")}) — look at the two files before anything is written`);
    if (why.length) refuse(why.join("; "));

    const lock = takeLock(lockFile, { waitMs: lockWaitMs, sleep, log: say });
    let stage = "nothing written";
    try {
      const c = mtClock(now(), holidays);
      if (c.inWindow) refuse("the clock entered the 13:50-15:50 MT no-write window while this waited for the lock — nothing written");
      const f = load(), h = present(f);
      if (h.row || h.line) refuse(`a part of this record appeared while this ran (${["row", "line"].filter((k) => h[k]).join(", ")}) — nothing written`);
      const { writeJsonAtomic } = require(path.join(repo, "backend", "lib", "atomic-write.js"));
      const n0 = f.cr.length;
      f.cr.push(R.row);
      writeJsonAtomic(crFile, f.cr);
      stage = "the change-registry row is written";
      { const back = JSON.parse(fs.readFileSync(crFile, "utf8")); if (back.length !== n0 + 1 || back[n0].id !== CR_ID) throw new Error("change-registry.json does not read back as written"); }
      fs.appendFileSync(ledgerFile, (f.ledgerText.length && !f.ledgerText.endsWith("\n") ? "\n" : "") + JSON.stringify(R.line) + "\n");
      stage = "both are written";
      { const tail = fs.readFileSync(ledgerFile, "utf8").trimEnd().split("\n").pop(); let good = false; try { good = JSON.parse(tail).changeRegistry === CR_ID; } catch { good = false; } if (!good) throw new Error("the ledger line does not read back as written"); }
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
  if (!(a.length === 0 || (a.length === 1 && a[0] === "--dry"))) { console.log(`usage: node ${D.PKG_REL}/record.cjs [--dry]\nNothing was done.`); process.exit(2); }
  let r;
  try { r = run({ dry: a[0] === "--dry" }); } catch (e) { console.error(`record FAILED: ${e && e.stack ? e.stack : e}`); process.exit(1); }
  process.exit(r.code);
}
