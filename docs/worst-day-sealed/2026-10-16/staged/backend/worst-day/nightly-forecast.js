#!/usr/bin/env node
"use strict";
/**
 * WORST-DAY NIGHTLY FORECAST — the job that writes TOMORROW's row into the sealed ledger, BEFORE the open.
 *
 * WHAT ONE RUN DOES, in order, refusing rather than writing at every step:
 *   1. reads the SPY bar file (default the worst-day training cache) and keeps sessions only
 *   2. takes the LAST bar as the decision session and the next weekday that is not a market holiday as forDate
 *   3. refuses when forDate is already behind the ET clock, when the bars do not reach the previous session, or when forDate is
 *      already in the ledger
 *   4. builds the forecast from bars up to the decision bar and nothing after it (nightly-model.js)
 *   5. checks the ledger as it stands — a ledger that does not pass its own checker is never appended to
 *   6. appends the row, which the ledger refuses outright at or after 09:30 ET of forDate, and writes the tip file
 *   7. reads the whole ledger back and checks it again; a run that does not end with a passing ledger says so and exits non-zero
 *
 * THE DEADLINE IS THE POINT. The job is meant to fire in the evening after the close, but nothing here depends on that: the only
 * thing that makes the row a forecast is that it was written before 09:30 ET of the day it names, and that is enforced at the write
 * and re-checked for ever after. A late run writes NOTHING. It does not write a late row, it does not write a row for the day after,
 * and it does not quietly skip: it exits 3 and says the seal closed.
 *
 *   node backend/worst-day/nightly-forecast.js --plan             READ-ONLY: the row it would write and whether the write would go
 *                                                                 through. Writes nothing, takes no lock.
 *   node backend/worst-day/nightly-forecast.js --write            append the row.
 *     --bars <file>      the SPY bars (default backend/data/training/worst-day/yahoo-SPY.json)
 *     --ledger <file>    the sealed ledger (default backend/data/worst-day/sealed-forecasts.jsonl)
 *     --for <YYYY-MM-DD> state forDate instead of deriving it (it must still be after the decision bar and still be open)
 *   node backend/worst-day/nightly-forecast.js --selftest         known answers on synthetic bars; writes only under a temp dir
 *
 * Exit 0 written / nothing to do (the row is already there) · 1 failed · 2 usage or the bars cannot be read · 3 REFUSED (the seal is
 * closed, the ledger does not pass, or the clock is wrong). It sends no order, makes no network call, and writes only the two ledger
 * files it is pointed at (the tip file through backend/lib/atomic-write.js).
 */
const path = require("path");
const SL = require("./sealed-ledger.js");
const NM = require("./nightly-model.js");
const SC = require("./sealed-check.js");

const DEFAULT_BARS = path.join(__dirname, "..", "data", "training", "worst-day", "yahoo-SPY.json");
const DEFAULT_LEDGER = SC.DEFAULT_LEDGER;

/**
 * Build the row that WOULD be written, and say whether it would be. Pure apart from reading the two files.
 * Returns { ok, refusals: [...], body, forDate, asOfDate, ledger: { rows, check }, note }.
 */
function plan({ bars, ledgerFile, now = Date.now(), forDate = null, holidays = SC.HOLIDAYS, opts = {} } = {}) {
  const refusals = [], today = SL.etDay(now);
  if (!bars || !bars.length) return { ok: false, refusals: ["the bar file holds no sessions"], body: null };
  const lastBar = bars[bars.length - 1].d;
  const want = forDate || NM.nextSessionAfter(lastBar, holidays);
  if (!SL.validDate(want)) return { ok: false, refusals: [`${want} is not a date`], body: null };
  if (SL.isWeekendDay(want)) refusals.push(`${want} is a weekend, not a session`);
  if (holidays[want]) refusals.push(`${want} is ${holidays[want]}, a market holiday`);
  if (!(want > lastBar)) refusals.push(`forDate ${want} is not after the last bar ${lastBar}`);
  if (want < today) refusals.push(`forDate ${want} is already behind the ET clock (today is ${today}) — the bars are stale: refresh them and run again`);
  const deadline = SL.sealDeadlineMs(want);
  if (!(now < deadline)) refusals.push(`THE SEAL IS CLOSED: ${new Date(now).toISOString()} is at or after 09:30 ET of ${want} (${new Date(deadline).toISOString()})`);

  let fc = null;
  try { fc = NM.forecastAsOf(bars, { ...opts, asOf: lastBar }); } catch (e) { refusals.push(`no forecast can be made at ${lastBar}: ${e.message}`); }

  const L = SL.readLedger(ledgerFile), tip = SL.readTip(SL.tipPathFor(ledgerFile));
  const v = SC.check({ rows: L.rows, now, tip, parseProblems: L.parseProblems, holidays });
  const already = L.rows.some((r) => r && r.forDate === want);
  if (!v.ok && !already) refusals.push(`the ledger does not pass its own checker (${v.failed.map((c) => c.id).join(", ")}) — nothing is appended to a ledger that is already refused`);
  const lastRow = L.rows.length ? L.rows[L.rows.length - 1] : null;
  if (lastRow && !already && !(want > lastRow.forDate)) refusals.push(`forDate ${want} is not after the ledger's last row (${lastRow.forDate})`);

  const body = fc ? {
    forDate: want, asOfDate: fc.asOfDate, p: round(fc.p, 12), score: round(fc.score, 12), storm: fc.storm, stormThr: round(fc.stormThr, 12),
    flagModel: fc.flagModel, flagRule: fc.flagRule, thr: round(fc.thr, 12), asOfAdj: round(fc.asOfAdj, 10), model: fc.model,
  } : null;
  return { ok: refusals.length === 0 && !!body, refusals, body, forDate: want, asOfDate: fc ? fc.asOfDate : null, already,
    ledger: { file: ledgerFile, rows: L.rows.length, check: v }, deadline: new Date(deadline).toISOString(), today,
    ruleReadable: fc ? fc.ruleReadable : null };
}
/** a fixed number of decimals, so the bytes of a row do not carry noise no model could reproduce */
const round = (x, k) => { const v = +Number(x).toFixed(k); return Object.is(v, -0) ? 0 : v; };

/** the whole run. write=false is --plan. Returns { code, result, lines, plan, row }. */
function run({ barsFile = DEFAULT_BARS, ledgerFile = DEFAULT_LEDGER, write = false, now = Date.now(), forDate = null, holidays = SC.HOLIDAYS, opts = {}, log = (s) => console.log(s) } = {}) {
  const lines = [], say = (s) => { lines.push(s); log(s); };
  let bars;
  try { bars = NM.readBars(barsFile); } catch (e) { say(`the bars cannot be read: ${barsFile} — ${e.message}`); return { code: 2, result: "no-bars", lines }; }
  const P = plan({ bars, ledgerFile, now, forDate, holidays, opts });
  say(`NIGHTLY WORST-DAY FORECAST — ${write ? "WRITE" : "PLAN (nothing is written)"} — now ${new Date(now).toISOString()} (${P.today} ET)`);
  say(`  bars    ${barsFile} — ${bars.length} session(s), ${bars[0] ? bars[0].d : "-"} .. ${bars.length ? bars[bars.length - 1].d : "-"}`);
  say(`  ledger  ${ledgerFile} — ${P.ledger.rows} row(s), ${P.ledger.check.ok ? "passes its checker" : "REFUSED: " + P.ledger.check.failed.map((c) => c.id).join(", ")}`);
  say(`  forDate ${P.forDate}   seal closes ${P.deadline}`);
  if (P.body) {
    say(`  row     p ${P.body.p.toFixed(4)}  storm ${P.body.storm.toUpperCase()} (model flag ${P.body.flagModel}, rule flag ${P.body.flagRule}, causal top-decile threshold ${P.body.stormThr.toFixed(4)})`);
    say(`          decided at the close of ${P.body.asOfDate} (adjusted ${P.body.asOfAdj}); tomorrow is a worst day when its total return is at or below ${(100 * P.body.thr).toFixed(4)}%`);
    say(`          ${P.body.model.id}: ${P.body.model.features.length} inputs, ${P.body.model.nTrain} labelled session(s) in the fit, window ${P.body.model.win}`);
    if (P.ruleReadable === false) say("          NOTE: rule of thumb (a) cannot be read at this bar (its own window is not full) — flagRule is 0 by default, not by measurement");
  }
  if (P.already) { say(`  a row for ${P.forDate} is already in the ledger — nothing to do.`); return { code: 0, result: "already", lines, plan: P }; }
  if (!write) {
    say(P.ok ? "  the write would go through." : `  the write would be REFUSED:\n    - ${P.refusals.join("\n    - ")}`);
    say("  nothing was written.");
    return { code: P.ok ? 0 : 3, result: P.ok ? "plan" : "would-refuse", lines, plan: P };
  }
  if (!P.ok) { say(`REFUSED — nothing written:\n  - ${P.refusals.join("\n  - ")}`); return { code: 3, result: "refused", lines, plan: P }; }

  let out;
  try { out = SL.appendRow(ledgerFile, P.body, { now, check: (a) => SC.check({ ...a, holidays }) }); }
  catch (e) {
    if (e instanceof SL.SealRefusal) { say(`REFUSED by the ledger — nothing written: ${e.message}`); return { code: 3, result: "refused", lines, plan: P }; }
    say(`WRITE FAILED: ${e.message}`); return { code: 1, result: "failed", lines, plan: P };
  }
  const after = SC.checkFile(ledgerFile, { now, holidays });
  say(`  WRITTEN: row ${out.seq} for ${out.row.forDate}, hash ${out.row.hash.slice(0, 12)}, prev ${out.row.prevHash.slice(0, 12)}`);
  say(`  the ledger now: ${after.rows} row(s), ${after.ok ? "passes every check" : "REFUSED: " + after.failed.map((c) => c.id + " (" + c.detail + ")").join("; ")}`);
  if (!after.ok) return { code: 1, result: "written-but-refused", lines, plan: P, row: out.row };
  say(`SEALED — the forecast for ${out.row.forDate} is on record, written ${Math.round((SL.sealDeadlineMs(out.row.forDate) - now) / 60000)} minute(s) before that session's open.`);
  return { code: 0, result: "written", lines, plan: P, row: out.row };
}

module.exports = { run, plan, round, DEFAULT_BARS, DEFAULT_LEDGER };

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.includes("--selftest")) { process.exitCode = require("./sealed-selftest.js").run(["nightly-forecast"]); return; }
  let write = null, barsFile = DEFAULT_BARS, ledgerFile = DEFAULT_LEDGER, forDate = null;
  const usage = (why) => { console.error(`${why}\nusage: node backend/worst-day/nightly-forecast.js --plan | --write [--bars <file>] [--ledger <file>] [--for <YYYY-MM-DD>]\n       node backend/worst-day/nightly-forecast.js --selftest\nNothing was done.`); process.exit(2); };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--plan") { if (write !== null) usage("give --plan or --write, once"); write = false; }
    else if (a[i] === "--write") { if (write !== null) usage("give --plan or --write, once"); write = true; }
    else if (a[i] === "--bars") { barsFile = a[++i] || usage("--bars needs a path"); }
    else if (a[i] === "--ledger") { ledgerFile = a[++i] || usage("--ledger needs a path"); }
    else if (a[i] === "--for") { forDate = a[++i] || usage("--for needs a date"); }
    else usage(`unknown argument ${a[i]}`);
  }
  if (write === null) usage("give --plan or --write");
  let r; try { r = run({ barsFile: path.resolve(barsFile), ledgerFile: path.resolve(ledgerFile), write, forDate }); } catch (e) { console.error(`nightly-forecast FAILED: ${e && e.stack ? e.stack : e}`); process.exit(1); }
  process.exit(r.code);
}
