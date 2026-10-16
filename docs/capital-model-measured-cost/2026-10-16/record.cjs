#!/usr/bin/env node
"use strict";
/**
 * CAPITAL MODEL — MEASURED COST (2026-10-16) — RECORD the change: ONE change-registry row and ONE agent-ledger GOVERNANCE line.
 *
 *   node docs/capital-model-measured-cost/2026-10-16/record.cjs --dry   print both records and say whether the write would go through;
 *                                                                      write nothing, take no lock, exit 0 even in a tree that has no
 *                                                                      registry files (this clean copy has none)
 *   node docs/capital-model-measured-cost/2026-10-16/record.cjs         write them — the operator's command, AFTER deploy.cjs --apply and
 *                                                                      after re-running planE-baseline.js once with no argument
 *
 * No test-registry note: this package grades no registered test. Its own selftest (selftest.cjs) is a package check, not a registered
 * test, and nothing here registers one — if it should become one, that is the operator's call and a separate row.
 * THE ROW (change-registry.json): id capital-model-measured-cost-2026-10-16, category measurement-tool, breaksComparability FALSE — with
 * no --measured-costs the baseline prints the same bytes and writes the same planE-baseline.json as before, so every number already
 * quoted from this model still stands and py.E (which risk-manager.js reads) is untouched.
 * THE LINE (agent-ledger.jsonl): kind GOVERNANCE, naming the row.
 * REFUSED, nothing written: between 13:50 and 15:50 MT on a trading day (the close chain owns these files then); while home's files are
 * not the staged ones (deploy.cjs --apply first); when EITHER record is already there (both: "already recorded", exit 0; one: refused,
 * saying which); when backend/data/registry-write.lock is held by another writer for more than 120 s (the lock is made with flag wx and
 * another writer's lock is never removed).
 * WRITES, under that lock, in this order: change-registry.json through backend/lib/atomic-write.js writeJsonAtomic (read back), then one
 * line appended to agent-ledger.jsonl (read back). A failure after a write says what is owed.
 * Exit 0 written / already recorded / dry · 1 failed after a write · 2 refused or usage.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const D = require("./deploy.cjs");
const CR_ID = "capital-model-measured-cost-2026-10-16", KIND = "measurement-tool", LOCK_WAIT_MS = 120000;
class Refuse extends Error {}
const refuse = (m) => { throw new Refuse(m); };

/** the MT clock: no write to these files 13:50-15:50 MT on a trading day */
function mtClock(nowMs, holidays = D.HOLIDAYS) {
  const z = D.zoneParts(nowMs, "America/Denver"), td = D.tradingDay(z, holidays);
  return { mtDate: z.date, hhmm: z.hhmm, tradingDay: td, inWindow: td && z.hm >= 13 * 60 + 50 && z.hm < 15 * 60 + 50 };
}
/** the two records, from the package's own facts */
function records({ nowMs, mtDate }) {
  const at = new Date(nowMs).toISOString(), files = Object.fromEntries(D.FILES.map((f) => [f.rel, { before: f.baseSha, after: f.stagedSha }]));
  const row = { id: CR_ID, date: mtDate, recordedAt: at, unit: "Plan E capital model (research, home only)", tests: [], area: "backend/profit-program/planE-model.js + planE-baseline.js — the PY (real-ZN, monthly) capital model and the script that prints it",
    category: KIND, breaksComparability: false, workOrder: "4.13",
    change: "The model's three assumed trading-cost rates are named in one place (ASSUMED_COSTS: 5 bps a side on a trend flip, 50 bps a crypto round trip = the 25 bps a switch it always paid, 4 bps a ZN round trip) and a measured set can now be read from a small JSON file. planE-baseline.js takes --measured-costs <file> and then prints one extra block: the yearly return, the worst month and the worst month-end drop of plans E and D2 under the assumed rates and under the measured ones, each at cost x1, x1.5 and x2, and adds one key (measuredCosts) at the end of planE-baseline.json. A file with a wrong spec, a missing, misspelled, negative, non-numeric or absurd rate is refused (exit 2) before anything is computed or written.",
    why: "Work order 4.13: the capital model priced every trade from assumed rates, so nobody could see how much of the stated 24.24 %/yr is an assumption about fills. The assumed and the measured cost now stand side by side, with a x1 / x1.5 / x2 sensitivity beside them.",
    doesNotChange: "Everything the model said before. With no --measured-costs the script prints the same bytes and writes the same planE-baseline.json, byte for byte (selftest.cjs runs the old script and the new one side by side on a synthetic fixture and compares both). py.E.annualReturnPct, which risk-manager.js reads, is untouched in either mode. The RM proxy family is NOT re-priced: its costs are inside risk-manager.js, which is not edited. No registered test's rule, bar, population or read condition is touched.",
    assumes: "Every stored month-end ZN window (futures-month-end.json rowsOut.tre, and the month znWindows() builds from the Schwab ZN store) carries 4 bps of round-trip trading cost, which is the figure futures-month-end.js subtracts; a measured ZN rate replaces that 4 bps and nothing else. futures-month-end.js also subtracts 0.0002 per roll-guard day in the window (tre = exp(sum) - 1 - 0.0004 - 0.0002 * tRolls): that is a splice-day penalty on a day whose price jump was replaced by the IEF-beta return, not a fill cost, and it is deliberately left in place.",
    operator: `assistant (cloud build session), package ${D.PKG_REL}`, files, package: D.PKG_REL };
  const line = { at, agent: "assistant", kind: "GOVERNANCE", target: "backend/profit-program/planE-model.js, backend/profit-program/planE-baseline.js — Plan E's capital model",
    what: `Measured trading cost can be priced beside the assumed rates (--measured-costs <file>; x1 / x1.5 / x2). The default run is byte-identical. Change-registry row: ${CR_ID}. Rollback: node ${D.PKG_REL}/rollback.cjs --plan.`, changeRegistry: CR_ID };
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
const present = ({ cr, ledgerText }) => ({ row: cr.some((r) => r && r.id === CR_ID), line: ledgerText.split("\n").some((l) => l.includes(`"changeRegistry":"${CR_ID}"`) && l.includes('"kind":"GOVERNANCE"')) });

/** dry or write -> { code, result, lines } (never throws on a refusal) */
function run({ dataDir = path.join(D.REPO, "backend", "data"), repo = D.REPO, pkg = D.PKG, dry = false, now = () => Date.now(), holidays = D.HOLIDAYS, lockWaitMs = LOCK_WAIT_MS, sleep, log = (s) => console.log(s) } = {}) {
  const lines = [], say = (s) => { lines.push(s); log(s); };
  const crFile = path.join(dataDir, "change-registry.json"), ledgerFile = path.join(dataDir, "agent-ledger.jsonl"), lockFile = path.join(dataDir, "registry-write.lock");
  /** soft = --dry: an unreadable registry is a reason the write would be refused, not a reason to print nothing */
  const load = (soft) => {
    let cr = null, ledgerText = null; const why = [];
    try { cr = JSON.parse(fs.readFileSync(crFile, "utf8")); } catch (e) { why.push(`change-registry.json cannot be read (${e.code || e.message})`); }
    if (cr !== null && !Array.isArray(cr)) { why.push("change-registry.json is not a list"); cr = null; }
    try { ledgerText = fs.readFileSync(ledgerFile, "utf8"); } catch (e) { why.push(`agent-ledger.jsonl cannot be read (${e.code || e.message})`); }
    if (why.length && !soft) refuse(why.join("; ") + " — nothing written");
    return { cr, ledgerText, why };
  };
  try {
    const c0 = mtClock(now(), holidays), Pl = D.plan({ repo, pkg }), R = records({ nowMs: now(), mtDate: c0.mtDate });
    say(`clock: ${c0.mtDate} ${c0.hhmm} MT, ${c0.tradingDay ? "a trading day" : "not a trading day"}${c0.inWindow ? " (INSIDE the 13:50-15:50 MT no-write window)" : ""}${dry ? " — --dry: nothing is written, no lock is taken" : ""}`);
    const f0 = load(dry), why = [...f0.why];
    const have = f0.cr && f0.ledgerText !== null ? present(f0) : { row: false, line: false };
    if (c0.inWindow) why.push("inside the 13:50-15:50 MT no-write window on a trading day (the close chain owns these files then) — run it after 15:50 MT");
    if (Pl.problems.length || !Pl.applied) why.push(`home does not hold the staged files (${Pl.files.map((x) => `${x.rel} ${x.state}`).join(", ")}${Pl.problems.length ? "; " + Pl.problems.join("; ") : ""}) — a change is recorded after it is in: node ${D.PKG_REL}/deploy.cjs --apply first`);
    say(`home: ${Pl.files.map((x) => `${x.rel} ${x.state} (${String(x.home).slice(0, 12)})`).join(" · ")}`);
    say(`already there: change-registry row ${have.row ? "YES" : "no"} · ledger line ${have.line ? "YES" : "no"}${f0.cr ? "" : " (the registry could not be read)"}`);
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
      const f = load(false), h = present(f); if (h.row || h.line) refuse(`a part of this record appeared while this ran (${["row", "line"].filter((k) => h[k]).join(", ")}) — nothing written`);
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
  if (!(a.length === 0 || (a.length === 1 && a[0] === "--dry"))) { console.log(`usage: node ${D.PKG_REL}/record.cjs [--dry]\nNothing was done.`); process.exit(2); }
  let r; try { r = run({ dry: a[0] === "--dry" }); } catch (e) { console.error(`record FAILED: ${e && e.stack ? e.stack : e}`); process.exit(1); }
  process.exit(r.code);
}
