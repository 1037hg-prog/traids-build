#!/usr/bin/env node
"use strict";
/**
 * PM SUMMARY MEMORY (2026-10-14) — RECORD the repair: ONE dated note in R352's entry, ONE change-registry row, ONE GOVERNANCE line.
 *
 *   node docs/pm-summary-memory/2026-10-14/record.cjs --dry    print the three records and whether the write would go through; write
 *                                                              nothing, take no lock (exit 0 unless a file cannot be read)
 *   node docs/pm-summary-memory/2026-10-14/record.cjs          write them — the main session's command, AFTER deploy.cjs --apply and
 *                                                              verify-live.cjs
 *
 * THE NOTE (R352.amendments): id R352-summary-memory-2026-10-14, kind "execution-repair", ruleChange false, preEvidence false, text
 *   "the coverage summary step made bounded in memory; content identical; nothing recorded changes" — with the code before and after
 *   (sha256) and where the proof is. It changes no rule, bar, population, statistic or read condition of R352: the summary is coverage
 *   only (rule[11]), its content is the same field for field, and nothing the recorder records changed.
 * THE ROW (change-registry.json): id pm-summary-memory-2026-10-14, breaksComparability false. THE LINE (agent-ledger.jsonl): kind
 *   GOVERNANCE, naming the row and the note.
 * REFUSED, nothing written: between 13:50 and 15:50 MT on a trading day (Mon-Fri, not a market holiday: the close chain owns these
 *   files then); while home's files are not the staged ones (deploy.cjs --apply first: a repair is recorded after it is in); R352 missing,
 *   twice, or also in tests[]; ANY of the three records already there (all three: "already recorded", exit 0; some: refused, with what is
 *   there); anything but R352.amendments and asOf would change in the registry; backend/data/registry-write.lock held by another writer
 *   for more than 120 s (created with flag wx; another writer's lock is never removed).
 * WRITES, under that lock, in this order: test-registry.json and change-registry.json through backend/lib/atomic-write.js
 *   writeJsonAtomic (each read back), then one line appended to agent-ledger.jsonl. A failure after a write says what is still owed.
 * Exit 0 written / already recorded / dry · 1 failed after a write · 2 refused or usage.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const D = require("./deploy.cjs");
let HOLIDAYS = {}; try { HOLIDAYS = require(path.join(D.REPO, "backend", "lib", "run-window.js")).MARKET_HOLIDAYS || {}; } catch { HOLIDAYS = {}; }
const ID = "R352", NOTE_ID = "R352-summary-memory-2026-10-14", CR_ID = "pm-summary-memory-2026-10-14", KIND = "execution-repair", LOCK_WAIT_MS = 120000;
const TEXT = "the coverage summary step made bounded in memory; content identical; nothing recorded changes";
class Refuse extends Error {}
const refuse = (m) => { throw new Refuse(m); };

/** the MT clock: no write to these files 13:50-15:50 MT on a trading day (Mon-Fri, not a market holiday) */
function mtClock(nowMs, holidays = HOLIDAYS) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", hourCycle: "h23", hour: "2-digit", minute: "2-digit", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(nowMs)).map((x) => [x.type, x.value]));
  const hh = +p.hour % 24, hm = hh * 60 + +p.minute, mtDate = `${p.year}-${p.month}-${p.day}`;
  const dow = new Date(mtDate + "T12:00:00Z").getUTCDay(), tradingDay = dow >= 1 && dow <= 5 && !holidays[mtDate];
  return { mtDate, hhmm: `${String(hh).padStart(2, "0")}:${p.minute}`, tradingDay, inWindow: tradingDay && hm >= 13 * 60 + 50 && hm < 15 * 60 + 50 };
}
const others = (reg, entry) => JSON.stringify({ ...reg, asOf: null, preregistered: reg.preregistered.map((t) => (t === entry ? { ...t, amendments: null } : t)) });
function findEntry(reg) {
  if (!reg || !Array.isArray(reg.preregistered)) refuse("test-registry.json holds no preregistered[] list — nothing written");
  const hits = reg.preregistered.filter((t) => t && t.id === ID);
  if (hits.length !== 1) refuse(`${ID} is ${hits.length ? "in preregistered[] " + hits.length + " times" : "not in preregistered[]"} — nothing written`);
  if (Array.isArray(reg.tests) && reg.tests.some((t) => t && String(t.id) === ID)) refuse(`${ID} is also in tests[] — an ambiguous entry, nothing written`);
  if (hits[0].amendments != null && !Array.isArray(hits[0].amendments)) refuse(`${ID}'s amendments is not a list — nothing written`);
  return hits[0];
}
/** the three records, built from the package's own facts (the code before and after) */
function records({ nowMs, mtDate }) {
  const rec = D.FILES[0], lib = D.FILES[1], at = new Date(nowMs).toISOString();
  const code = { "pm-book-recorder.js": { before: rec.baseSha, after: rec.stagedSha }, "lib/pm-feeds.js": { unchanged: lib.baseSha } };
  const note = { id: NOTE_ID, date: mtDate, kind: KIND, preEvidence: false, ruleChange: false, text: TEXT,
    detail: "R352's per-day summary (backend/pm-book-recorder.js --summarize, the nightly unit traids-pm-nightly.service on the server) ran out of memory on 2026-10-13 at 18:45 MT: the library's coverage kept every websocket trade hash as a piece of the file chunk it was read from, so a whole UTC day of the book stream stayed in memory. From this note the summary's coverage is read by coverDayBounded (backend/pm-book-recorder.js), which returns the library's coverDay object field for field (lib/pm-feeds.js is unchanged and stays the reference; the recorder's own selftest compares the two on every day it records). The summary is coverage only (rule[11]); no rule, bar, population, statistic or read condition changes, the evidence start does not move, and nothing the recorder records changed (no change to --run, the feeds, the rows written or VERSION).",
    code, package: D.PKG_REL, recordedBy: `${D.PKG_REL}/record.cjs`, recordedAt: at };
  const row = { id: CR_ID, date: mtDate, recordedAt: at, unit: "w7-pm", tests: [ID], area: "server — W7 R352 recorder (backend/pm-book-recorder.js): the nightly per-day summary (--summarize)", category: KIND, breaksComparability: false,
    change: "The per-day summary's coverage is read in bounded memory (coverDayBounded): spot times go into each window's running silence as they are read, websocket trade hashes are copied out of the read chunks and let go window by window, the tape is read in batches of windows, the Kalshi seconds sit in one fixed array per window. --summarize ends with one 'summarize memory:' line. backend/lib/pm-feeds.js is unchanged.",
    why: "The nightly summary died with 'JavaScript heap out of memory' at about 500 MB on 2026-10-13 18:45 MT (traids-pm-nightly.service, MemoryMax=1G): no day summary was written and the unit paged every night.",
    doesNotChange: "The summary's content (identical field for field to what the old code produced, generatedAt aside), anything the recorder records, R352's rules, bars, population and evidence start.",
    operator: "assistant (main session), package docs/pm-summary-memory/2026-10-14", files: code, package: D.PKG_REL, amendment: NOTE_ID };
  const line = { at, agent: "assistant", kind: "GOVERNANCE", target: "R352 — W7 nightly summary (pm-book-recorder.js --summarize)", what: `The coverage summary step was made bounded in memory (content identical; nothing recorded changes). Change-registry row: ${CR_ID}. ${ID} dated note: ${NOTE_ID}. Rollback: node ${D.PKG_REL}/rollback.cjs --plan.`, changeRegistry: CR_ID, amendment: NOTE_ID };
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
    return { release() { try { const j = JSON.parse(fs.readFileSync(lockFile, "utf8")); if (j.token === token) fs.unlinkSync(lockFile); } catch { /* gone, or not ours: left alone */ } } };
  }
}
/** what of the three records is there already -> { note, row, line } booleans */
function present({ reg, cr, ledgerText }) {
  const e = findEntry(reg);
  return { note: (e.amendments || []).some((a) => a && a.id === NOTE_ID), row: cr.some((r) => r && r.id === CR_ID), line: ledgerText.split("\n").some((l) => l.includes(`"changeRegistry":"${CR_ID}"`) && l.includes('"kind":"GOVERNANCE"')) };
}

/** dry or write -> { code, result, lines } (never throws on a refusal) */
function run({ dataDir = path.join(D.REPO, "backend", "data"), repo = D.REPO, pkg = D.PKG, dry = false, now = () => Date.now(), holidays = HOLIDAYS, lockWaitMs = LOCK_WAIT_MS, sleep, log = (s) => console.log(s) } = {}) {
  const lines = [], say = (s) => { lines.push(s); log(s); };
  const regFile = path.join(dataDir, "test-registry.json"), crFile = path.join(dataDir, "change-registry.json"), ledgerFile = path.join(dataDir, "agent-ledger.jsonl"), lockFile = path.join(dataDir, "registry-write.lock");
  const load = () => {
    let reg, cr, ledgerText;
    try { reg = JSON.parse(fs.readFileSync(regFile, "utf8")); } catch (e) { refuse(`test-registry.json cannot be read (${e.code || e.message}) — nothing written`); }
    try { cr = JSON.parse(fs.readFileSync(crFile, "utf8")); } catch (e) { refuse(`change-registry.json cannot be read (${e.code || e.message}) — nothing written`); }
    if (!Array.isArray(cr)) refuse("change-registry.json is not a list — nothing written");
    try { ledgerText = fs.readFileSync(ledgerFile, "utf8"); } catch (e) { refuse(`agent-ledger.jsonl cannot be read (${e.code || e.message}) — nothing written`); }
    return { reg, cr, ledgerText };
  };
  try {
    const c0 = mtClock(now(), holidays), P = D.plan({ repo, pkg }), R = records({ nowMs: now(), mtDate: c0.mtDate });
    say(`clock: ${c0.mtDate} ${c0.hhmm} MT, ${c0.tradingDay ? "a trading day" : "not a trading day"}${c0.inWindow ? " (INSIDE the 13:50-15:50 MT no-write window)" : ""}${dry ? " — --dry: nothing is written, no lock is taken" : ""}`);
    const f0 = load(), have = present(f0), why = [];
    if (c0.inWindow) why.push("inside the 13:50-15:50 MT no-write window on a trading day (the close chain owns these files then) — run it after 15:50 MT");
    if (P.problems.length || !P.applied) why.push(`home's files are not the staged ones (${P.files.map((x) => `${x.rel} ${x.state}`).join(", ")}) — the repair is recorded after it is in: node ${D.PKG_REL}/deploy.cjs --apply first`);
    say(`home: ${P.files.map((x) => `${x.rel} ${x.state} (${String(x.home).slice(0, 12)})`).join(" · ")}`);
    say(`already there: note ${have.note ? "YES" : "no"} · change-registry row ${have.row ? "YES" : "no"} · ledger line ${have.line ? "YES" : "no"}`);
    say(`${ID} dated note (test-registry.json, ${ID}.amendments):`); say(JSON.stringify(R.note, null, 1));
    say("change-registry.json row:"); say(JSON.stringify(R.row, null, 1));
    say("agent-ledger.jsonl line:"); say(JSON.stringify(R.line));
    if (have.note && have.row && have.line) { say("ALREADY RECORDED — all three are there; nothing to do, nothing written"); return { code: 0, result: "already", lines }; }
    if (have.note || have.row || have.line) why.push(`a PART of this record is there already (${["note", "row", "line"].filter((k) => have[k]).join(", ")}) — look at the three files before anything is written`);
    if (dry) { say(why.length ? `DRY — nothing written. The write would be REFUSED now:\n  - ${why.join("\n  - ")}` : "DRY — nothing written, no lock taken. The write would add the three records above."); return { code: 0, result: "dry", lines, wouldRefuse: why }; }
    if (why.length) refuse(why.join("; "));

    const lock = takeLock(lockFile, { waitMs: lockWaitMs, sleep, log: say });   // (the wait runs on the real clock, whatever clock the window is judged by)
    let stage = "nothing written";
    try {
      const c = mtClock(now(), holidays); if (c.inWindow) refuse("the clock entered the 13:50-15:50 MT no-write window while this waited for the lock — nothing written");
      const f = load(), h = present(f); if (h.note || h.row || h.line) refuse(`a part of this record appeared while this ran (${["note", "row", "line"].filter((k) => h[k]).join(", ")}) — nothing written`);
      const e = findEntry(f.reg), before = others(f.reg, e), n0 = (e.amendments || []).length;
      e.amendments = [...(e.amendments || []), R.note]; f.reg.asOf = new Date(now()).toISOString();
      if (others(f.reg, e) !== before) throw new Error("internal: something other than R352.amendments and asOf would change — nothing written");
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
      say(`${stage}, then FAILED (${e.message}). Still owed by hand: ${stage === "the registry note is written" ? `the change-registry row ${CR_ID} and the ledger line` : stage.startsWith("the registry note and") ? "the GOVERNANCE line in agent-ledger.jsonl" : "nothing (check the ledger's last line)"} — the records printed above are the ones to add.`);
      return { code: 1, result: "failed", lines };
    } finally { lock.release(); }
  } catch (e) {
    if (!(e instanceof Refuse)) throw e;
    say(`REFUSED — nothing written: ${e.message}`);
    return { code: 2, result: "refused", lines };
  }
}

module.exports = { run, records, mtClock, present, takeLock, NOTE_ID, CR_ID, KIND, TEXT, Refuse };

if (require.main === module) {
  const a = process.argv.slice(2);
  if (!(a.length === 0 || (a.length === 1 && a[0] === "--dry"))) { console.log("usage: node docs/pm-summary-memory/2026-10-14/record.cjs [--dry]\nNothing was done."); process.exit(2); }
  let r; try { r = run({ dry: a[0] === "--dry" }); } catch (e) { console.error(`record FAILED: ${e && e.stack ? e.stack : e}`); process.exit(1); }
  process.exit(r.code);
}
