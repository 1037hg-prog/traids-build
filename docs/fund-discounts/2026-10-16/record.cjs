#!/usr/bin/env node
"use strict";
/**
 * R354 FUND DISCOUNTS (2026-10-16) — RECORD the build: ONE dated note in R354's entry, ONE change-registry row, ONE GOVERNANCE line.
 *
 *   node docs/fund-discounts/2026-10-16/record.cjs --dry    print the three records and whether the write would go through; write
 *                                                           nothing, take no lock
 *   node docs/fund-discounts/2026-10-16/record.cjs          write them — AFTER deploy.cjs --apply at home
 *
 * THE NOTE (R354.amendments): id R354-runner-built-2026-10-16, kind "build-note", ruleChange FALSE, preEvidence FALSE. It records
 * that the runner named in the entry (writerExists was false) now exists, with the sha256 of all three files and of the rule text
 * they were built against. IT CHANGES NO COMMITMENT: not the rule, not the bar (1.727), not the population, not the statistic, not
 * the read condition, not the evidence start, not the lapse. It is NOT the pre-read 'hash-note' of readCondition (3): that one is
 * written later, after the cache is fetched and frozen and --controls has run, and carries the cache and controls hashes.
 * THE ROW (change-registry.json): id r354-runner-2026-10-16, breaksComparability false. THE LINE (agent-ledger.jsonl): kind
 * GOVERNANCE, naming the row and the note.
 * REFUSED, nothing written: between 13:50 and 15:50 MT on a trading day (the close chain owns these files then); while home does not
 * hold the staged bytes (deploy.cjs --apply first); R354 missing, twice, or also in tests[]; the rule text no longer hashing to
 * ruleSha256 (something changed the registered rule: stop); ANY of the three records already there (all three: "already recorded",
 * exit 0); anything but R354.amendments and asOf changing in the registry; the write lock held by another writer for over 120 s.
 * Exit 0 written / already recorded / dry · 1 failed after a write · 2 refused or usage.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const D = require("./deploy.cjs");
let HOLIDAYS = {}; try { HOLIDAYS = require(path.join(D.REPO, "backend", "lib", "run-window.js")).MARKET_HOLIDAYS || {}; } catch { HOLIDAYS = {}; }
const ID = "R354", NOTE_ID = "R354-runner-built-2026-10-16", CR_ID = "r354-runner-2026-10-16", KIND = "build-note", LOCK_WAIT_MS = 120000;
const RULE_SHA = "82d7586f3c5d781244602bb1c6021937c5d29c92e5e23cd462859723ede00c39";
const RULE_KEYS = ["rule", "statistic", "definitions", "bar", "controls", "decisionRule"];
const TEXT = "the runner, its engine and the nightly recorder are built and tested on fixtures; no rule, bar, population, statistic or read condition changes, and no series has been read";
class Refuse extends Error {}
const refuse = (m) => { throw new Refuse(m); };
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

/** no write to the registry files between 13:50 and 15:50 MT on a trading day */
function mtClock(nowMs, holidays = HOLIDAYS) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", hourCycle: "h23", hour: "2-digit", minute: "2-digit", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(nowMs)).map((x) => [x.type, x.value]));
  const hh = +p.hour % 24, hm = hh * 60 + +p.minute, mtDate = `${p.year}-${p.month}-${p.day}`;
  const d = new Date(mtDate + "T12:00:00Z").getUTCDay(), tradingDay = d >= 1 && d <= 5 && !holidays[mtDate];
  return { mtDate, hhmm: `${String(hh).padStart(2, "0")}:${p.minute}`, tradingDay, inWindow: tradingDay && hm >= 13 * 60 + 50 && hm < 15 * 60 + 50 };
}
const others = (reg, entry) => JSON.stringify({ ...reg, asOf: null, preregistered: reg.preregistered.map((t) => (t === entry ? { ...t, amendments: null } : t)) });
function findEntry(reg) {
  if (!reg || !Array.isArray(reg.preregistered)) refuse("test-registry.json holds no preregistered[] list — nothing written");
  const hits = reg.preregistered.filter((t) => t && t.id === ID);
  if (hits.length !== 1) refuse(`${ID} is ${hits.length ? `in preregistered[] ${hits.length} times` : "not in preregistered[]"} — nothing written`);
  if (Array.isArray(reg.tests) && reg.tests.some((t) => t && String(t.id) === ID)) refuse(`${ID} is also in tests[] — an ambiguous entry, nothing written`);
  const e = hits[0], now = sha(JSON.stringify(Object.fromEntries(RULE_KEYS.map((k) => [k, e[k]]))));
  if (now !== e.ruleSha256 || now !== RULE_SHA) refuse(`${ID}'s rule text no longer hashes to its ruleSha256 (${now.slice(0, 12)} against ${String(e.ruleSha256).slice(0, 12)}) — something changed the registered rule: nothing written`);
  if (e.amendments != null && !Array.isArray(e.amendments)) refuse(`${ID}'s amendments is not a list — nothing written`);
  return e;
}
/** the three records, built from the package's own facts */
function records({ nowMs, mtDate }) {
  const at = new Date(nowMs).toISOString();
  const code = Object.fromEntries(D.FILES.map((f) => [f.rel, { before: "(absent)", after: f.stagedSha }]));
  const note = { id: NOTE_ID, date: mtDate, kind: KIND, preEvidence: false, ruleChange: false, text: TEXT,
    detail: "R354 was registered 2026-10-12 with writerExists false and the runner NAMED, not built. It is now built by the standard build loop (a builder, a separate checker running every check read-only, mutation tests on made-up series only; --read forbidden to the build): backend/r354-fund-discounts.js (the runner: --selftest, --status, --controls, --read, --dollar-table), backend/lib/fund-discount.js (the engine: pure functions over series handed in, no file, no network, no clock, no environment variable) and backend/fund-nav-record.js (the nightly price and published-NAV recorder of openOperatorItems[0], which belongs to no registration and reads no result). The runner's frozen constants equal parameters{} field for field and it REFUSES a read unless every item of readCondition holds; the rule text still hashes to ruleSha256. NO SERIES HAS BEEN READ: there is no cache, no controls file and no pre-read hash-note, and the build never ran --read. Nothing of the rule, the bar (1.727), the population, the statistic, the controls, the decision rule, the read condition, the evidence start or the lapse changes.",
    files: code, ruleSha256: RULE_SHA, package: D.PKG_REL, recordedBy: `${D.PKG_REL}/record.cjs`, recordedAt: at };
  const row = { id: CR_ID, date: mtDate, recordedAt: at, unit: "research", tests: [ID],
    area: "R354 closed-end fund discounts — the runner (backend/r354-fund-discounts.js), its engine (backend/lib/fund-discount.js) and the nightly recorder (backend/fund-nav-record.js)",
    category: KIND, breaksComparability: false,
    change: "Three new files. The runner computes R354's registered statistic (monthly gap dollars after costs against the no-cost placebo, Newey-West lag 4, clustered by calendar month), its sign gates S1-S5, its labels L1-L12 and its validity gates V1-V16, and refuses a read unless every item of readCondition holds. The nightly recorder appends each fund's price and the FIRST published NAV seen for a day, with the clock time, to a dated JSONL, never overwriting, a later different value appended as a revision.",
    why: "R354 was registered with its runner named and not built (writerExists false), and the nightly recorder is the first of its three open operator items: every week without it loses for good the history of whichever fund dies that week.",
    doesNotChange: "R354's rule, bar, population, statistic, controls, decision rule, read condition, evidence start and lapse; no live code path (all three files are new and nothing calls them yet); no order of any kind.",
    operator: "assistant (cloud build session), package docs/fund-discounts/2026-10-16", files: code, package: D.PKG_REL, amendment: NOTE_ID };
  const line = { at, agent: "assistant", kind: "GOVERNANCE", target: `${ID} — the fund-discount runner, its engine and the nightly recorder`,
    what: `Built and tested on fixtures; no commitment changed and no series read. Change-registry row: ${CR_ID}. ${ID} dated note: ${NOTE_ID}. Rollback: node ${D.PKG_REL}/rollback.cjs --plan.`,
    changeRegistry: CR_ID, amendment: NOTE_ID };
  return { note, row, line };
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
    try { fs.writeSync(fd, JSON.stringify({ token, pid: process.pid, by: `${D.PKG_REL}/record.cjs`, id: NOTE_ID, at: new Date(now()).toISOString() }) + "\n"); } finally { fs.closeSync(fd); }
    return { release() { try { const j = JSON.parse(fs.readFileSync(lockFile, "utf8")); if (j.token === token) fs.unlinkSync(lockFile); } catch { /* gone, or not ours */ } } };
  }
}
function present({ reg, cr, ledgerText }) {
  const e = findEntry(reg);
  return { note: (e.amendments || []).some((a) => a && a.id === NOTE_ID), row: cr.some((r) => r && r.id === CR_ID),
    line: ledgerText.split("\n").some((l) => l.includes(`"changeRegistry":"${CR_ID}"`) && l.includes('"kind":"GOVERNANCE"')) };
}
/** dry or write -> { code, result, lines }; it never throws on a refusal */
function run({ dataDir = path.join(D.REPO, "backend", "data"), repo = D.REPO, pkg = D.PKG, dry = false, now = () => Date.now(), holidays = HOLIDAYS, lockWaitMs = LOCK_WAIT_MS, sleep, log = (s) => console.log(s) } = {}) {
  const lines = [], say = (s) => { lines.push(s); log(s); };
  const regFile = path.join(dataDir, "test-registry.json"), crFile = path.join(dataDir, "change-registry.json"),
    ledgerFile = path.join(dataDir, "agent-ledger.jsonl"), lockFile = path.join(dataDir, "registry-write.lock");
  const load = () => {
    let reg, cr, ledgerText;
    try { reg = JSON.parse(fs.readFileSync(regFile, "utf8")); } catch (e) { refuse(`test-registry.json cannot be read (${e.code || e.message}) — nothing written`); }
    try { cr = JSON.parse(fs.readFileSync(crFile, "utf8")); } catch (e) { refuse(`change-registry.json cannot be read (${e.code || e.message}) — nothing written; it is not in this code-only copy, so a --dry here says so and the write happens at home`); }
    if (!Array.isArray(cr)) refuse("change-registry.json is not a list — nothing written");
    try { ledgerText = fs.readFileSync(ledgerFile, "utf8"); } catch (e) { refuse(`agent-ledger.jsonl cannot be read (${e.code || e.message}) — nothing written`); }
    return { reg, cr, ledgerText };
  };
  try {
    const c0 = mtClock(now(), holidays), P = D.plan({ repo, pkg }), R = records({ nowMs: now(), mtDate: c0.mtDate });
    say(`clock: ${c0.mtDate} ${c0.hhmm} MT, ${c0.tradingDay ? "a trading day" : "not a trading day"}${c0.inWindow ? " (INSIDE the 13:50-15:50 MT no-write window)" : ""}${dry ? " — --dry: nothing is written, no lock is taken" : ""}`);
    say(`home: ${P.files.map((x) => `${x.rel} ${x.state}`).join(" · ")}`);
    say(`${ID} dated note (test-registry.json, ${ID}.amendments):`); say(JSON.stringify(R.note, null, 1));
    say("change-registry.json row:"); say(JSON.stringify(R.row, null, 1));
    say("agent-ledger.jsonl line:"); say(JSON.stringify(R.line));
    const why = [];
    if (c0.inWindow) why.push("inside the 13:50-15:50 MT no-write window on a trading day — run it after 15:50 MT");
    if (P.problems.length || !P.applied) why.push(`home does not hold the staged bytes (${P.files.map((x) => `${x.rel} ${x.state}`).join(", ")}) — a build is recorded after it is in: node ${D.PKG_REL}/deploy.cjs --apply first`);
    let f0 = null, have = null;
    try { f0 = load(); have = present(f0); } catch (e) { if (!(e instanceof Refuse)) throw e; if (!dry) throw e; say(`(the registry files cannot all be read here: ${e.message})`); }
    if (have) {
      say(`already there: note ${have.note ? "YES" : "no"} · change-registry row ${have.row ? "YES" : "no"} · ledger line ${have.line ? "YES" : "no"}`);
      if (have.note && have.row && have.line) { say("ALREADY RECORDED — all three are there; nothing to do, nothing written"); return { code: 0, result: "already", lines }; }
      if (have.note || have.row || have.line) why.push(`a PART of this record is there already (${["note", "row", "line"].filter((k) => have[k]).join(", ")}) — look at the three files before anything is written`);
    }
    if (dry) { say(why.length ? `DRY — nothing written. The write would be REFUSED now:\n  - ${why.join("\n  - ")}` : "DRY — nothing written, no lock taken. The write would add the three records above."); return { code: 0, result: "dry", lines, wouldRefuse: why }; }
    if (why.length) refuse(why.join("; "));

    const lock = takeLock(lockFile, { waitMs: lockWaitMs, sleep, log: say });
    let stage = "nothing written";
    try {
      const c = mtClock(now(), holidays); if (c.inWindow) refuse("the clock entered the 13:50-15:50 MT no-write window while this waited for the lock — nothing written");
      const f = load(), h = present(f); if (h.note || h.row || h.line) refuse(`a part of this record appeared while this ran (${["note", "row", "line"].filter((k) => h[k]).join(", ")}) — nothing written`);
      const e = findEntry(f.reg), before = others(f.reg, e), n0 = (e.amendments || []).length;
      e.amendments = [...(e.amendments || []), R.note]; f.reg.asOf = new Date(now()).toISOString();
      if (others(f.reg, e) !== before) throw new Error(`internal: something other than ${ID}.amendments and asOf would change — nothing written`);
      const { writeJsonAtomic } = require(path.join(repo, "backend", "lib", "atomic-write.js"));
      writeJsonAtomic(regFile, f.reg); stage = "the registry note is written";
      { const back = findEntry(JSON.parse(fs.readFileSync(regFile, "utf8"))); if ((back.amendments || []).length !== n0 + 1 || back.amendments[n0].id !== NOTE_ID) throw new Error("the registry does not read back as written"); }
      const crBefore = f.cr.length; f.cr.push(R.row); writeJsonAtomic(crFile, f.cr); stage = "the registry note and the change-registry row are written";
      { const back = JSON.parse(fs.readFileSync(crFile, "utf8")); if (back.length !== crBefore + 1 || back[crBefore].id !== CR_ID) throw new Error("change-registry.json does not read back as written"); }
      fs.appendFileSync(ledgerFile, (f.ledgerText.length && !f.ledgerText.endsWith("\n") ? "\n" : "") + JSON.stringify(R.line) + "\n"); stage = "all three are written";
      { const tail = fs.readFileSync(ledgerFile, "utf8").trimEnd().split("\n").pop(); let ok = false; try { ok = JSON.parse(tail).changeRegistry === CR_ID; } catch { ok = false; } if (!ok) throw new Error("the ledger line does not read back as written"); }
      say(`WRITTEN: ${ID}.amendments ${n0} -> ${n0 + 1} (${NOTE_ID}) and asOf; change-registry.json +1 row (${CR_ID}); agent-ledger.jsonl +1 GOVERNANCE line. Each read back.`);
      return { code: 0, result: "written", lines };
    } catch (e) {
      if (stage === "nothing written" || e instanceof Refuse) throw e;
      say(`${stage}, then FAILED (${e.message}). Still owed by hand: ${stage === "the registry note is written" ? `the change-registry row ${CR_ID} and the ledger line` : "the GOVERNANCE line in agent-ledger.jsonl"} — the records printed above are the ones to add.`);
      return { code: 1, result: "failed", lines };
    } finally { lock.release(); }
  } catch (e) {
    if (!(e instanceof Refuse)) throw e;
    say(`REFUSED — nothing written: ${e.message}`);
    return { code: 2, result: "refused", lines };
  }
}

module.exports = { run, records, mtClock, present, takeLock, findEntry, NOTE_ID, CR_ID, KIND, TEXT, Refuse };

if (require.main === module) {
  const a = process.argv.slice(2);
  if (!(a.length === 0 || (a.length === 1 && a[0] === "--dry"))) { console.log(`usage: node ${D.PKG_REL}/record.cjs [--dry]\nNothing was done.`); process.exit(2); }
  let r; try { r = run({ dry: a[0] === "--dry" }); } catch (e) { console.error(`record FAILED: ${e && e.stack ? e.stack : e}`); process.exit(1); }
  process.exit(r.code);
}
