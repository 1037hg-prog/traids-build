#!/usr/bin/env node
"use strict";
/**
 * WORST-DAY SEALED LEDGER — THE CHECKER. It answers one question with a yes or a no: can these forecasts be believed as forecasts?
 *
 * THE REFUSAL THAT MATTERS: `seal`. A row whose createdAt is at or after 09:30 ET of the day it forecasts was not written before that
 * session opened, so it is not a forecast of it, whatever it says. One such row refuses the WHOLE ledger — not the row — because a
 * ledger that accepts one late row is a ledger whose other rows cannot be told apart from late ones. sealed-grade.js grades nothing
 * while this refuses.
 *
 * THE ELEVEN CHECKS, each named, each reported whether it passed or not (no check is skipped because an earlier one failed, except
 * where a later check cannot be computed at all — it then reports as NOT RUN and the ledger is still refused):
 *   parse            every line of the file is one JSON object
 *   schema           every row carries exactly the row's keys, with the right types and ranges, and a storm state its own two flags agree with
 *   seq              seq runs 1, 2, 3 … with no gap and no repeat, in file order
 *   chain            row 1 carries GENESIS as prevHash; every later row carries the hash of the row before it
 *   hash             every row's hash is the sha256 of its own body (prevHash included) — one changed byte anywhere breaks it
 *   createdAtOrder   createdAt never goes backwards from one row to the next
 *   forDateOrder     forDate strictly increases: no repeat of a session, no row inserted behind another
 *   sessionDay       forDate is a weekday and not a market holiday (backend/lib/run-window.js MARKET_HOLIDAYS)
 *   seal             createdAt < 09:30 ET of forDate, for every row
 *   notFuture        no createdAt is after the moment of the check (a clock that ran ahead is not a forecast either)
 *   tip              the tip file beside the ledger names the last row's seq and hash — a ledger cut short no longer matches it
 *
 * WHAT IT DOES NOT PROVE. A hand that edits the ledger AND re-hashes every later row AND rewrites the tip leaves nothing here to find:
 * there is no signature and no outside witness. What the checks give is EVIDENCE — a single edit, a truncation, a reordering, an
 * inserted row or a late row is caught — not proof. The honest words for the ledger are append-only and tamper-evident.
 *
 *   node backend/worst-day/sealed-check.js                     check the live ledger; exit 0 passed, 1 refused
 *   node backend/worst-day/sealed-check.js --file <path>       check another ledger
 *   node backend/worst-day/sealed-check.js --json              the verdict as JSON on stdout
 *   node backend/worst-day/sealed-check.js --selftest          known answers on rows built here; writes nothing, reads no ledger
 * Read-only: it never writes a file and makes no network call.
 */
const path = require("path");
const S = require("./sealed-ledger.js");
let HOLIDAYS = {};
try { HOLIDAYS = require("../lib/run-window.js").MARKET_HOLIDAYS || {}; } catch { HOLIDAYS = {}; }

const DEFAULT_LEDGER = path.join(__dirname, "..", "data", "worst-day", "sealed-forecasts.jsonl");
const CHECK_IDS = ["parse", "schema", "seq", "chain", "hash", "createdAtOrder", "forDateOrder", "sessionDay", "seal", "notFuture", "tip"];

/**
 * The verdict on a ledger already read.
 *   rows   the parsed rows (a null entry marks a line that did not parse)
 *   now    the instant of the check (ms)
 *   tip    the tip file's contents, or null when there is none
 *   parseProblems  what readLedger found while parsing
 * Returns { ok, rows, checks: [{ id, ok, ran, detail, bad: [...] }], failed: [...], counts }
 */
function check({ rows = [], now = Date.now(), tip = null, parseProblems = [], holidays = HOLIDAYS } = {}) {
  const checks = [], add = (id, ok, detail, bad = []) => checks.push({ id, ok, ran: true, detail, bad });
  const notRun = (id, why) => checks.push({ id, ok: false, ran: false, detail: why, bad: [] });
  const at = (i) => `row ${i + 1}`;

  // parse
  add("parse", parseProblems.length === 0, parseProblems.length ? parseProblems.slice(0, 5).join("; ") : `${rows.length} line(s) read as JSON objects`, parseProblems);
  if (parseProblems.length) { for (const id of CHECK_IDS.slice(1)) notRun(id, "the file does not read as rows"); return verdict(checks, rows, now); }

  // schema
  {
    const bad = [];
    rows.forEach((r, i) => { const p = S.rowProblems(r); if (p.length) bad.push(`${at(i)}: ${p.join("; ")}`); });
    add("schema", bad.length === 0, bad.length ? bad.slice(0, 5).join(" | ") : `${rows.length} row(s) carry exactly the row's keys`, bad);
    if (bad.length) { for (const id of CHECK_IDS.slice(2)) notRun(id, "a row is not a row"); return verdict(checks, rows, now); }
  }
  // seq
  {
    const bad = [];
    rows.forEach((r, i) => { if (r.seq !== i + 1) bad.push(`${at(i)}: seq ${r.seq}, expected ${i + 1}`); });
    add("seq", bad.length === 0, bad.length ? bad.slice(0, 5).join(" | ") : `seq runs 1..${rows.length}`, bad);
  }
  // chain
  {
    const bad = [];
    rows.forEach((r, i) => {
      const want = i === 0 ? S.GENESIS : rows[i - 1].hash;
      if (r.prevHash !== want) bad.push(`${at(i)}: prevHash ${r.prevHash.slice(0, 12)}, expected ${String(want).slice(0, 12)}${i === 0 ? " (GENESIS)" : ` (the hash of row ${i})`}`);
    });
    add("chain", bad.length === 0, bad.length ? bad.slice(0, 5).join(" | ") : rows.length ? `row 1 carries GENESIS and ${rows.length - 1} link(s) hold` : "an empty ledger has no links", bad);
  }
  // hash
  {
    const bad = [];
    rows.forEach((r, i) => { let h; try { h = S.hashBody(r); } catch (e) { bad.push(`${at(i)}: its body cannot be hashed (${e.message})`); return; } if (h !== r.hash) bad.push(`${at(i)}: hash ${r.hash.slice(0, 12)}, its body hashes to ${h.slice(0, 12)}`); });
    add("hash", bad.length === 0, bad.length ? bad.slice(0, 5).join(" | ") : `${rows.length} row hash(es) recomputed`, bad);
  }
  // createdAtOrder
  {
    const bad = [];
    for (let i = 1; i < rows.length; i++) if (!(Date.parse(rows[i].createdAt) >= Date.parse(rows[i - 1].createdAt))) bad.push(`${at(i)}: createdAt ${rows[i].createdAt} is before ${at(i - 1)}'s ${rows[i - 1].createdAt}`);
    add("createdAtOrder", bad.length === 0, bad.length ? bad.slice(0, 5).join(" | ") : "createdAt never goes backwards", bad);
  }
  // forDateOrder
  {
    const bad = [];
    for (let i = 1; i < rows.length; i++) if (!(rows[i].forDate > rows[i - 1].forDate)) bad.push(`${at(i)}: forDate ${rows[i].forDate} is not after ${at(i - 1)}'s ${rows[i - 1].forDate}`);
    add("forDateOrder", bad.length === 0, bad.length ? bad.slice(0, 5).join(" | ") : "forDate strictly increases", bad);
  }
  // sessionDay
  {
    const bad = [];
    rows.forEach((r, i) => { if (S.isWeekendDay(r.forDate)) bad.push(`${at(i)}: forDate ${r.forDate} is a weekend`); else if (holidays[r.forDate]) bad.push(`${at(i)}: forDate ${r.forDate} is ${holidays[r.forDate]}, a market holiday`); });
    add("sessionDay", bad.length === 0, bad.length ? bad.slice(0, 5).join(" | ") : "every forDate is a weekday that is not a market holiday", bad);
  }
  // seal — the one this ledger exists for
  {
    const bad = [];
    rows.forEach((r, i) => {
      const dl = S.sealDeadlineMs(r.forDate), made = Date.parse(r.createdAt);
      if (!(made < dl)) bad.push(`${at(i)}: WRITTEN AFTER THE OPEN — createdAt ${r.createdAt} is ${made === dl ? "exactly" : "after"} 09:30 ET of ${r.forDate} (${new Date(dl).toISOString()}), ${Math.round((made - dl) / 60000)} minute(s) late`);
    });
    add("seal", bad.length === 0, bad.length ? bad.slice(0, 5).join(" | ") : rows.length ? `every row was written before 09:30 ET of the session it forecasts (earliest lead ${minLeadMinutes(rows)} minute(s))` : "an empty ledger has nothing to seal", bad);
  }
  // notFuture
  {
    const bad = [];
    rows.forEach((r, i) => { const made = Date.parse(r.createdAt); if (made > now) bad.push(`${at(i)}: createdAt ${r.createdAt} is after the moment of this check (${new Date(now).toISOString()})`); });
    add("notFuture", bad.length === 0, bad.length ? bad.slice(0, 5).join(" | ") : "no row claims to have been written in the future", bad);
  }
  // tip
  {
    const last = rows.length ? rows[rows.length - 1] : null;
    if (!tip && !last) add("tip", true, "no ledger and no tip file");
    else if (!tip) add("tip", false, `${rows.length} row(s) but no tip file beside the ledger — a truncation could not be seen`, ["no tip file"]);
    else if (!last) add("tip", false, `a tip file names seq ${tip.seq} but the ledger is empty`, ["empty ledger with a tip"]);
    else {
      const bad = [];
      if (tip.seq !== last.seq) bad.push(`the tip names seq ${tip.seq}, the ledger ends at ${last.seq}${tip.seq > last.seq ? " — ROWS ARE MISSING FROM THE END" : ""}`);
      if (tip.hash !== last.hash) bad.push(`the tip names hash ${String(tip.hash).slice(0, 12)}, the last row is ${last.hash.slice(0, 12)}`);
      if (tip.forDate !== last.forDate) bad.push(`the tip names forDate ${tip.forDate}, the last row is ${last.forDate}`);
      add("tip", bad.length === 0, bad.length ? bad.join(" | ") : `the tip names the last row (seq ${last.seq}, ${last.hash.slice(0, 12)})`, bad);
    }
  }
  return verdict(checks, rows, now);
}
function minLeadMinutes(rows) { let m = Infinity; for (const r of rows) m = Math.min(m, (S.sealDeadlineMs(r.forDate) - Date.parse(r.createdAt)) / 60000); return Number.isFinite(m) ? Math.round(m) : null; }
function verdict(checks, rows, now) {
  const failed = checks.filter((c) => !c.ok);
  const real = rows.filter((r) => r && typeof r === "object");
  return { ok: failed.length === 0, at: new Date(now).toISOString(), rows: rows.length, checks, failed,
    counts: { rows: rows.length, first: real.length ? real[0].forDate : null, last: real.length ? real[real.length - 1].forDate : null,
      storm: S.STORM_STATES.map((s) => [s, real.filter((r) => r.storm === s).length]) } };
}
/** read a ledger from disk and check it */
function checkFile(file, { now = Date.now(), holidays = HOLIDAYS } = {}) {
  const L = S.readLedger(file), tip = S.readTip(S.tipPathFor(file));
  const v = check({ rows: L.rows, now, tip, parseProblems: L.parseProblems, holidays });
  return { ...v, file, exists: L.exists, tipFile: S.tipPathFor(file) };
}
function report(v) {
  const lines = [`SEALED LEDGER CHECK — ${v.file || "(rows in memory)"} — ${v.rows} row(s)${v.counts.first ? `, ${v.counts.first} .. ${v.counts.last}` : ""}`];
  for (const c of v.checks) lines.push(`  ${(c.ok ? "ok" : c.ran ? "REFUSED" : "NOT RUN").padEnd(8)} ${c.id.padEnd(15)} ${c.detail}`);
  lines.push(v.ok ? `PASSED — the ledger is append-only, its chain holds, and every row was sealed before 09:30 ET of the session it forecasts`
    : `REFUSED — ${v.failed.length} of ${v.checks.length} checks: ${v.failed.map((c) => c.id).join(", ")}. The ledger is not evidence of a forecast until this passes.`);
  return lines.join("\n");
}

module.exports = { check, checkFile, report, CHECK_IDS, DEFAULT_LEDGER, HOLIDAYS };

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.includes("--selftest")) { process.exitCode = require("./sealed-selftest.js").run(["sealed-check"]); return; }
  let file = DEFAULT_LEDGER, json = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--file") { file = a[++i]; if (!file) { console.error("--file needs a path"); process.exit(2); } }
    else if (a[i] === "--json") json = true;
    else { console.error(`usage: node backend/worst-day/sealed-check.js [--file <path>] [--json] [--selftest]\nunknown argument ${a[i]}`); process.exit(2); }
  }
  const v = checkFile(path.resolve(file));
  console.log(json ? JSON.stringify(v, null, 1) : report(v));
  process.exit(v.ok ? 0 : 1);
}
