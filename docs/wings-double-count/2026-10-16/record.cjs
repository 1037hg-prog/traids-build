#!/usr/bin/env node
"use strict";
/**
 * WINGS DOUBLE COUNT (2026-10-16) — RECORD the repair: ONE change-registry row, ONE GOVERNANCE line.
 *
 *   node docs/wings-double-count/2026-10-16/record.cjs --dry   print both records and whether the write
 *                                                              would go through. Writes nothing, takes no
 *                                                              lock. Exit 0 unless a file cannot be read.
 *   node docs/wings-double-count/2026-10-16/record.cjs         write them — AFTER deploy.cjs --apply, and
 *                                                              after the operator has read the new output.
 *
 * NO TEST-REGISTRY AMENDMENT IS WRITTEN HERE, on purpose. This package changes no test's rule, bar,
 * population definition, statistic or read condition. What it changes is a COUNTING DEFECT in the shared
 * canonical read: a ticket with two ledger rows under one id was entering every population twice. Which
 * registered reads that moves, and whether any of them needs a dated amendment of its own, is the
 * operator's call on the numbers at home — not a cloud session's to invent. The row below says so, names
 * the condition, and points at NOTES.md. breaksComparability is TRUE.
 *
 * REFUSED, nothing written:
 *   - between 13:50 and 15:50 MT on a trading day (Mon-Fri, not a market holiday): the close chain owns
 *     these files then
 *   - while home's files are not the staged ones (deploy.cjs --apply first — a repair is recorded once it
 *     is in, never before)
 *   - if the row is already in change-registry.json (exit 0, "already recorded")
 *   - if change-registry.json is not an array, or the lock is held by another writer for over 120 s
 *     (the lock is created with flag wx and another writer's lock is NEVER removed)
 * WRITES, under that lock: change-registry.json through backend/lib/atomic-write.js writeJsonAtomic and
 * read back, then one line appended to agent-ledger.jsonl.
 * Exit 0 written / already recorded / dry · 1 failed after a write · 2 refused or usage.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const L = require("./lib.cjs");
const D = (f) => path.join(L.REPO, "backend", "data", f);
const CR = D("change-registry.json"), LEDGER = D("agent-ledger.jsonl"), LOCK = D("registry-write.lock");
const CR_ID = "wings-double-count-2026-10-16", LOCK_WAIT_MS = 120000;
let HOLIDAYS = {}; try { HOLIDAYS = require(path.join(L.REPO, "backend", "lib", "run-window.js")).MARKET_HOLIDAYS || {}; } catch { HOLIDAYS = {}; }
class Refuse extends Error {}
const refuse = (m) => { throw new Refuse(m); };

/** the MT clock: no write to these files 13:50-15:50 MT on a trading day */
function mtClock(nowMs, holidays = HOLIDAYS) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", hourCycle: "h23", hour: "2-digit", minute: "2-digit", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(nowMs)).map((x) => [x.type, x.value]));
  const hh = +p.hour % 24, hm = hh * 60 + +p.minute, mtDate = `${p.year}-${p.month}-${p.day}`;
  const dow = new Date(mtDate + "T12:00:00Z").getUTCDay(), tradingDay = dow >= 1 && dow <= 5 && !holidays[mtDate];
  return { mtDate, hhmm: `${String(hh).padStart(2, "0")}:${p.minute}`, tradingDay, inWindow: tradingDay && hm >= 13 * 60 + 50 && hm < 15 * 60 + 50 };
}

/** the two records, built from this package's own facts */
function records({ nowMs, mtDate }) {
  const at = new Date(nowMs).toISOString();
  const files = Object.fromEntries(L.FILES.map((f) => [f.rel, f.isNew ? { added: f.stagedSha } : { before: f.baseSha, after: f.stagedSha }]));
  const row = {
    date: mtDate, recordedAt: at, id: CR_ID, category: "accounting",
    area: "the canonical settled ledger (backend/lib/reconcile.js) and the three reports that read data/trade_log.json directly",
    breaksComparability: true,
    change: "The canonical read is ONE ROW PER TICKET. data/trade_log.json can hold two rows under one ticket id: a close that was voided for evidence and the later real close of the same ticket (six R21 weekly wings — loss cap 2026-09-14, voided, restored on the board under the same id, settled at expiry by a prepend that left the voided row in place). lib/reconcile.js cleanEraLedger() now collapses to one row per ticket id (new backend/lib/ticket-rows.js: the successor stamp first, then the latest close; an unexplained duplicate is kept at file order and REPORTED) before any filter runs, and returns tickets / duplicateTicketIds / supersededRowsDropped / unexplainedDuplicateTicketIds. journalLag() counts tickets on both sides and names any ticket the append-only journal sealed under a superseded close. daily-postmortem.js and integrity-audit.js count tickets (integrity-audit sections 1-2 still re-derive EVERY row, and its new section 2b reports duplicate ticket ids without touching the verdict). options-news-shadow.js is keyed on the ticket id instead of on arrival order.",
    why: "Every reader that summed ROWS counted each revoided-and-re-settled wing twice; the append-only journal is keyed on the ticket id and did not, so the ledger and the journal key disagreed by exactly the number of such wings. Six wings, -$3,000 counted where -$600 was earned, on this evening's rows.",
    doesNotChange: "No rule, bar, population definition, statistic, universe or read condition of any registered test. No row is edited, merged or re-summed. A ticket that had one row is untouched, byte for byte — the collapse is an exact no-op on a ledger where no ticket id appears twice.",
    doesNotEstablish: "Anything about any test's result. It corrects how many times a ticket enters a population; what the corrected populations say is to be read again from them.",
    comparability: "Any figure quoted from these readers BEFORE this date, over a window containing a duplicate ticket id, counted those tickets twice and is not comparable with a figure quoted after it. node backend/integrity-audit.js section 2b lists every duplicate ticket id at home; node backend/lib/reconcile.js prints the tickets line and the count dropped.",
    forOperator: "Decide whether any registered read whose window contains one of these tickets needs a dated amendment of its own. This package writes none and invents none. Also read the third known ambiguity now surfaced by lib/reconcile.js knownAmbiguities() — 'void-tag-on-surviving-close': if a surviving settle row inherited its predecessor's void tag from the board row, that ticket is now excluded as retired and counts ZERO times, which is a data repair with your word on it, not a reader's.",
    files, package: L.PKG_REL, proof: `${L.PKG_REL}/selftest.cjs (known-answer tests on fixtures; see ${L.PKG_REL}/NOTES.md)`,
    operator: "assistant (cloud build session), package " + L.PKG_REL + " — applied at home by the operator",
  };
  const line = { ts: at, kind: "GOVERNANCE", actor: "assistant", action: "accounting-repair",
    target: "the canonical settled ledger — one row per ticket (lib/reconcile.js, lib/ticket-rows.js)",
    changeRegistry: CR_ID, breaksComparability: true,
    detail: `A ticket with two ledger rows under one id counted twice in every reader on cleanEraLedger() and in daily-postmortem, integrity-audit and options-news-shadow. Now once, keyed on the ticket id. Six R21 wings. Rollback: node ${L.PKG_REL}/rollback.cjs --plan.` };
  return { row, line };
}

function takeLock({ waitMs = LOCK_WAIT_MS, now = () => Date.now(), sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), log = () => {} } = {}) {
  const token = `${process.pid}-${now()}-${crypto.randomBytes(4).toString("hex")}`, t0 = now(); let told = false;
  for (;;) {
    try { const fd = fs.openSync(LOCK, "wx"); fs.writeSync(fd, token); fs.closeSync(fd); return token; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (now() - t0 >= waitMs) refuse(`backend/data/registry-write.lock is held by another writer (over ${Math.round(waitMs / 1000)} s) — nothing written. Another writer's lock is never removed by this script.`);
      if (!told) { told = true; log("  waiting for backend/data/registry-write.lock …"); }
      sleep(500);
    }
  }
}
const dropLock = (token) => { try { if (fs.readFileSync(LOCK, "utf8") === token) fs.unlinkSync(LOCK); } catch {} };

function main() {
  const dry = process.argv.includes("--dry");
  const extra = process.argv.slice(2).filter((a) => a !== "--dry");
  if (extra.length) { console.log(`usage: node ${L.PKG_REL}/record.cjs [--dry]\nNothing was done.`); process.exit(2); }
  const nowMs = Date.now(), clock = mtClock(nowMs), R = records({ nowMs, mtDate: clock.mtDate });

  console.log(`${dry ? "DRY — " : ""}RECORD — wings double count — ${new Date(nowMs).toISOString().slice(0, 16)}Z (${L.mtWords(nowMs)} MT)`);
  console.log(`\n  would append to backend/data/change-registry.json:\n${JSON.stringify(R.row, null, 1)}`);
  console.log(`\n  would append one line to backend/data/agent-ledger.jsonl:\n${JSON.stringify(R.line)}`);

  const P = L.plan(), refusals = [];
  if (clock.inWindow) refusals.push(`it is ${clock.hhmm} MT on a trading day, inside 13:50-15:50 MT — the close chain owns these files then; run it after 15:50 MT`);
  if (!P.applied) refusals.push(`home does not hold the staged bytes yet (${P.files.filter((x) => x.state !== "applied" && x.state !== "unchanged").map((x) => `${x.rel} is ${x.state}`).join(", ")}) — run deploy.cjs --apply first`);
  let cr = null;
  try { cr = JSON.parse(fs.readFileSync(CR, "utf8")); } catch (e) { refusals.push(`backend/data/change-registry.json could not be read (${e.message})`); }
  if (cr && !Array.isArray(cr)) refusals.push("backend/data/change-registry.json is not an array — append the row by hand");
  const already = Array.isArray(cr) && cr.some((x) => x && x.id === CR_ID);

  if (dry) {
    console.log(`\n  the write would ${already ? "do nothing: the row is ALREADY in change-registry.json" : refusals.length ? "be REFUSED:\n    - " + refusals.join("\n    - ") : "go through"}`);
    console.log(`  no test-registry amendment is written by this script — see its header for why.`);
    process.exit(0);
  }
  if (already) { console.log(`\nALREADY RECORDED — ${CR_ID} is in change-registry.json; nothing written.`); process.exit(0); }
  if (refusals.length) { console.error(`\nREFUSED — nothing written:\n  - ${refusals.join("\n  - ")}`); process.exit(2); }

  const { writeJsonAtomic } = require(path.join(L.REPO, "backend", "lib", "atomic-write.js"));
  const token = takeLock({ log: (s) => console.log(s) });
  try {
    const fresh = JSON.parse(fs.readFileSync(CR, "utf8"));
    if (!Array.isArray(fresh)) refuse("change-registry.json changed under the lock and is not an array — nothing written");
    if (fresh.some((x) => x && x.id === CR_ID)) { console.log(`\nALREADY RECORDED (written by another writer under the lock); nothing written.`); return 0; }
    fresh.push(R.row);
    writeJsonAtomic(CR, fresh);
    const back = JSON.parse(fs.readFileSync(CR, "utf8"));
    if (!back.some((x) => x && x.id === CR_ID)) { console.error(`\nFAILED — change-registry.json does not read back with ${CR_ID}. The GOVERNANCE line is NOT written.`); return 1; }
    console.log(`\n  change-registry.json: row ${CR_ID} appended and read back (${back.length} rows)`);
    fs.appendFileSync(LEDGER, JSON.stringify(R.line) + "\n");
    console.log(`  agent-ledger.jsonl: one GOVERNANCE line appended`);
    return 0;
  } finally { dropLock(token); }
}

module.exports = { mtClock, records, CR_ID };

if (require.main === module) {
  try { process.exit(main()); }
  catch (e) {
    if (e instanceof Refuse) { console.error(`\nREFUSED — nothing written:\n  - ${e.message}`); process.exit(2); }
    console.error(`\nFAILED: ${e && e.message}`); process.exit(1);
  }
}
