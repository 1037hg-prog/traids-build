#!/usr/bin/env node
"use strict";
/**
 * INSIDER CLUSTERS — three or more distinct insiders buying at one company inside ten TRADING days, from the collector's dated
 * JSONL. 2026-10-16. Reads files; asks nobody for anything; no network, no keys, no orders.
 *
 *   node backend/insider-clusters.js                               every dated file in backend/data/insider-buys
 *   node backend/insider-clusters.js --from 2026-11-01 --to 2026-12-31      only buys in that span
 *   node backend/insider-clusters.js --window 10 --min-insiders 3   the defaults, said out loud
 *   node backend/insider-clusters.js --min-usd-per-insider 10000    an insider under $10,000 that day does not count
 *   node backend/insider-clusters.js --dry                          print the clusters, write nothing
 *
 * WHAT IT WRITES: <out-dir>/insider-clusters-<as-of>.json through backend/lib/atomic-write.js (writeJsonAtomic), holding the run's
 * settings, the calendar it used, every cluster and the days it could not place. Nothing else is written and nothing is deleted.
 *
 * THE RULE, EXACTLY (and see backend/lib/insider-cluster-lib.js for why each part is written this way):
 *   - a cluster is `--min-insiders` DISTINCT insiders (by reporting-owner CIK) at ONE issuer whose buy days all fall inside
 *     `--window` TRADING days, counted inclusively against the desk's own holiday table — not ten weekdays;
 *   - the TRIGGER is the first day at which the window holds that many, and the company-days in that window are then spent: a run of
 *     five insiders over two weeks is one cluster, not four overlapping ones;
 *   - `publicOn` is the day the LAST of the cluster's filings appeared. Anything that trades on a cluster uses `publicOn`.
 *     `triggerBuy` is up to two business days earlier and using it is look-ahead.
 *
 * THIS GRADES NOTHING. It finds clusters and says what they are. No registered test is read, written or graded here, and no bar is
 * applied: registration happens at home, before any of this data is read. Exit 0 wrote (or --dry) · 2 refused or usage · 1 failed.
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const B = require("./lib/insider-buys-lib.js");
const C = require("./lib/insider-cluster-lib.js");
const { MARKET_HOLIDAYS } = require("./lib/run-window.js");

const IN_DIR_DEFAULT = path.join(__dirname, "data", "insider-buys");
const OUT_DIR_DEFAULT = path.join(__dirname, "data");
const FILE_RE = /^insider-buys-\d{4}-\d{2}-\d{2}\.jsonl$/;
const isoDay = B.isoDay;
const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");

/** every dated collector file in a directory, oldest first. A directory that is not there is an empty read, said out loud by the caller. */
function datedFiles(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  return names.filter((n) => FILE_RE.test(n)).sort().map((n) => path.join(dir, n));
}

/**
 * Read the dated files -> { records, runs, bad, files, incompleteDays }.
 * A file's unreadable lines are carried out, not swallowed; a filing day whose own run line said `complete: false` is named in
 * `incompleteDays`, because a cluster of three insiders is a different claim when one of the day's filings was never read.
 */
function readDays(files, { from = null, to = null } = {}) {
  const out = { records: [], runs: [], bad: [], files: [], incompleteDays: [] };
  for (const f of files) {
    const p = B.parseJsonl(fs.readFileSync(f, "utf8"));
    out.files.push({ file: path.basename(f), records: p.records.length, runs: p.runs.length, bad: p.bad.length });
    for (const b of p.bad) out.bad.push({ file: path.basename(f), ...b });
    for (const r of p.runs) { out.runs.push(r); if (r.complete === false) out.incompleteDays.push({ filingDay: r.filingDay, unresolved: (r.unresolved || []).length }); }
    for (const r of p.records) {
      if (from && r.tradeDate < from) continue;
      if (to && r.tradeDate > to) continue;
      out.records.push(r);
    }
  }
  return out;
}

/** the print the operator reads */
function printClusters(res, read, { from, to }) {
  const s = res.summary;
  console.log(`insider clusters — ${s.minInsiders}+ distinct insiders inside ${s.windowTradingDays} trading days`);
  console.log(`  read ${read.files.length} dated file(s), ${read.records.length} company-day(s)${from || to ? ` in ${from || "the start"} .. ${to || "the end"}` : ""} at ${s.issuers} issuer(s); ${s.insiderCompanyPairs} insider-company pairs`);
  console.log(`  calendar ${s.calendar.from} .. ${s.calendar.to}: ${s.calendar.tradingDays} trading days, ${s.calendar.holidaysInRange} market holiday(s) in range${s.calendar.uncovered ? " — UNCOVERED: part of this range is outside the holiday table, so a holiday there counted as a trading day and those windows are measured too narrow" : ""}`);
  if (read.bad.length) console.log(`  ${read.bad.length} unreadable line(s) in the dated files: ${read.bad.slice(0, 3).map((b) => `${b.file} line ${b.line} (${b.why})`).join("; ")}`);
  if (read.incompleteDays.length) console.log(`  ${read.incompleteDays.length} filing day(s) did NOT read whole (${read.incompleteDays.slice(0, 5).map((d) => `${d.filingDay}: ${d.unresolved} unresolved`).join("; ")}) — re-run the collector for those days before this is read as a count of what happened`);
  if (res.skipped.length) console.log(`  ${res.skipped.length} company-day(s) not placed: ${res.skipped.slice(0, 3).map((x) => `${x.cik}/${x.tradeDate} (${x.why})`).join("; ")}`);
  console.log(`\n  ${s.clusters} cluster(s) at ${s.issuersWithCluster} issuer(s)`);
  for (const c of res.clusters) {
    console.log(`\n  ${c.sym || c.cik}  ${c.issuer || ""}`);
    console.log(`      ${c.insiders} insiders · ${money(c.usd)} · ${c.roleList.join(", ")} · buys ${c.firstBuy} .. ${c.lastBuy} (${c.spanTradingDays} trading days, ${c.buyDays} buy day${c.buyDays === 1 ? "" : "s"}, ${c.filings} filing${c.filings === 1 ? "" : "s"})`);
    console.log(`      trigger buy ${c.triggerBuy} · public ${c.publicOn || "UNKNOWN (a filing in this cluster carried no filing date)"}${c.publicOn ? ` (${c.publicLagTradingDays} trading day(s) after the trigger buy)` : ""}`);
    for (const i of c.insiderList) console.log(`        ${i.role.padEnd(20)} ${money(i.usd).padStart(12)}  ${i.days.join(", ")}${i.titles.length ? "  " + i.titles.join(" / ") : ""}`);
    if (c.offCalendarDays) console.log(`      ${c.offCalendarDays} buy day(s) dated on a closed day — placed on the next trading day`);
  }
}

/**
 * run(opts) -> { code, out, lines }. The CLI's whole job, on injected paths, so the package's selftest runs it over fixture files
 * in a scratch folder.
 */
function run({
  inDir = IN_DIR_DEFAULT, outDir = OUT_DIR_DEFAULT, from = null, to = null, window = C.WINDOW_TRADING_DAYS,
  minInsiders = C.MIN_INSIDERS, minUsdPerInsider = 0, minUsdTotal = 0, allowUncovered = false, holidays = MARKET_HOLIDAYS,
  dry = false, asOf = null, log = (s) => console.log(s), print = true,
} = {}) {
  const lines = [], say = (s) => { lines.push(s); log(s); };
  const files = datedFiles(inDir);
  if (files === null) { say(`insider clusters: ${inDir} is not there — run backend/insider-buys-collect.js first. Nothing written.`); return { code: 2, lines, out: null }; }
  if (!files.length) { say(`insider clusters: no insider-buys-<date>.jsonl in ${inDir} — nothing to read, nothing written.`); return { code: 2, lines, out: null }; }
  const read = readDays(files, { from, to });
  if (!read.records.length) { say(`insider clusters: ${files.length} dated file(s) hold no company-day${from || to ? ` in ${from || "the start"} .. ${to || "the end"}` : ""} — nothing written.`); return { code: 2, lines, out: null, read }; }

  const calendar = C.calendarFor(read.records, { holidays, allowUncovered });
  const res = C.findClusters(read.records, { calendar, windowTradingDays: window, minInsiders, minUsdPerInsider, minUsdTotal });
  const on = isoDay(asOf) || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const out = {
    spec: C.SPEC, asOf: on, builtAt: new Date().toISOString(),
    rule: `${minInsiders} or more distinct insiders (reporting-owner CIK) buying on the open market (Form 4 non-derivative, transaction code P, acquired) at one issuer, inside ${window} trading days counted inclusively; officers and directors only; one company-day belongs to at most one cluster`,
    settings: { window, minInsiders, minUsdPerInsider, minUsdTotal, from, to, allowUncovered, inDir: path.basename(inDir) },
    summary: res.summary,
    source: { files: read.files, companyDays: read.records.length, unreadableLines: read.bad, incompleteFilingDays: read.incompleteDays },
    clusters: res.clusters, notPlaced: res.skipped,
    grades: "nothing — this finds clusters and says what they are; no registered test is read or graded here",
  };
  if (print) printClusters(res, read, { from, to });
  const file = path.join(outDir, `insider-clusters-${on}.json`);
  if (dry) { say(`\n--dry: would write ${file} (${res.clusters.length} cluster(s)); nothing written`); return { code: 0, lines, out, file, read }; }
  fs.mkdirSync(outDir, { recursive: true });
  writeJsonAtomic(file, out);
  const back = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(back.clusters) || back.clusters.length !== res.clusters.length) throw new Error(`${file} does not read back as written`);
  say(`\nwrote ${file} — ${res.clusters.length} cluster(s) over ${read.records.length} company-day(s)`);
  return { code: 0, lines, out, file, read };
}

function usage() {
  console.log(`usage: node backend/insider-clusters.js [--in-dir DIR] [--out-dir DIR] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
                                        [--window 10] [--min-insiders 3] [--min-usd-per-insider 0] [--min-usd 0]
                                        [--allow-uncovered-calendar] [--as-of YYYY-MM-DD] [--dry]
  --window counts TRADING days inclusively against backend/lib/run-window.js MARKET_HOLIDAYS. A range that table does not cover is
  REFUSED: outside it a market holiday counts as a trading day and every window comes out too narrow. --allow-uncovered-calendar runs
  anyway and marks the result uncovered.
  Exit 0 wrote (or --dry) · 2 refused or usage · 1 failed.`);
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const flag = (n, d = null) => { const i = a.indexOf(n); return i >= 0 && i + 1 < a.length ? a[i + 1] : d; };
  const num = (n, d) => { const v = flag(n); if (v === null) return d; const x = Number(v); if (!Number.isFinite(x)) { console.error(`insider clusters: ${n} needs a number, not ${JSON.stringify(v)}`); process.exit(2); } return x; };
  if (a.includes("--help") || a.includes("-h")) { usage(); process.exit(2); }
  for (const d of ["--from", "--to", "--as-of"]) if (flag(d) !== null && !isoDay(flag(d))) { console.error(`insider clusters: ${d} needs an ISO day (YYYY-MM-DD), not ${JSON.stringify(flag(d))}`); process.exit(2); }
  try {
    const r = run({
      inDir: flag("--in-dir", IN_DIR_DEFAULT), outDir: flag("--out-dir", OUT_DIR_DEFAULT),
      from: isoDay(flag("--from")), to: isoDay(flag("--to")), asOf: isoDay(flag("--as-of")),
      window: num("--window", C.WINDOW_TRADING_DAYS), minInsiders: num("--min-insiders", C.MIN_INSIDERS),
      minUsdPerInsider: num("--min-usd-per-insider", 0), minUsdTotal: num("--min-usd", 0),
      allowUncovered: a.includes("--allow-uncovered-calendar"), dry: a.includes("--dry"),
    });
    process.exit(r.code);
  } catch (e) {
    console.error(`insider clusters: ${e && e.message ? e.message : e}`);
    process.exit(/holiday table covers|must be|needs|refused|REFUSED/i.test(String(e && e.message)) ? 2 : 1);
  }
}

module.exports = { run, readDays, datedFiles, printClusters, IN_DIR_DEFAULT, OUT_DIR_DEFAULT, FILE_RE };
