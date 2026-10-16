#!/usr/bin/env node
"use strict";
/**
 * INSIDER BUYS COLLECT — the server's daily read of SEC Form 4 OPEN-MARKET PURCHASES by officers and directors. 2026-10-16.
 *
 *   node backend/insider-buys-collect.js                         the filings filed TODAY (ET)
 *   node backend/insider-buys-collect.js --date 2026-11-16        one filing day
 *   node backend/insider-buys-collect.js --from 2026-11-16 --to 2026-11-20
 *   node backend/insider-buys-collect.js --date 2026-11-16 --dry  read and parse, print the lines, write nothing
 * Settings (the SEC's two rules, both enforced in backend/lib/sec-fetch.js):
 *   SEC_USER_AGENT="<product> (<how to reach the operator>)"      REQUIRED. No default: there is no contact string in this repository,
 *                                                                 and an anonymous read is what gets the whole desk blocked.
 *                                                                 --user-agent "…" passes it on the command line instead.
 *   --rate N                                                      requests a second, 10 at most (the SEC's own limit) and the default.
 *   --out-dir DIR                                                 where the dated JSONL goes (default backend/data/insider-buys).
 *
 * WHAT IT WRITES. One file per FILING DAY: <out-dir>/insider-buys-<filing day>.jsonl, through backend/lib/atomic-write.js
 * (writeTextAtomic: a temp file, fsynced, renamed — a kill mid-write leaves the old file whole, never half a day's rows). One line per
 * COMPANY per TRANSACTION DAY — the distinct insiders who bought, the dollars, the roles — plus one `kind:"run"` line saying what was
 * asked, what was read, and what was NOT (see insider-buys-lib.js for the record and why dollars are summed over accessions while
 * insiders are counted over owners). Re-running a day MERGES: every sum is keyed by accession, so a second run of the same day
 * changes nothing and a later run adds only the filings that are new. A write that would LOSE a company-day already in the file is
 * refused outright.
 *
 * WHAT IT REFUSES TO GUESS:
 *   - a filing it could not fetch or could not parse is NOT a filing with no purchases. Each one is named in the run line
 *     (`unresolved`), the run says so on stdout, and it EXITS 3 so the nightly chain sees a partial read. Running the same day again
 *     retries them (the merge makes that free).
 *   - a filing day with no daily index: a 404 on a weekend or a market holiday is the expected answer and the run is clean; a 404 on
 *     a trading day is a FAILURE (exit 3), because "the SEC served nothing today" and "we read nothing today" must never look alike.
 *   - a 4/A amendment restates a filing already counted, so it is not summed; amendments are counted in the run line.
 *
 * NO ORDERS, NO BROKER, NO KEYS: this reads sec.gov and writes a file. It is a collector.
 */
const fs = require("fs"), path = require("path");
const { writeTextAtomic } = require("./lib/atomic-write.js");
const { makeSecFetcher, makeLimiter, MAX_PER_SECOND } = require("./lib/sec-fetch.js");
const { parseForm4 } = require("./lib/form4-parse.js");
const B = require("./lib/insider-buys-lib.js");
const { marketHoliday } = require("./lib/run-window.js");

const SEC_ARCHIVES = "https://www.sec.gov/Archives/";
const OUT_DIR_DEFAULT = path.join(__dirname, "data", "insider-buys");
/** one filing day's own request budget: an ordinary day lists a few hundred Form 4s, which is about a minute at ten a second */
const DAY_BUDGET_MS = 900000;
const isoDay = B.isoDay;
const addDays = (iso, n) => new Date(Date.parse(iso + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const etToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const quarterOf = (day) => Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1;
const isWeekend = (day) => [0, 6].includes(new Date(Date.parse(day + "T12:00:00Z")).getUTCDay());

/** the SEC's pipe-delimited daily master index for one filing day */
const masterIndexUrl = (day) => `${SEC_ARCHIVES}edgar/daily-index/${day.slice(0, 4)}/QTR${quarterOf(day)}/master.${day.replace(/-/g, "")}.idx`;

/**
 * The daily master index text -> { form4: [ { cik, form, filedOn, file, accession } ], counts }.
 * master.idx is CIK|Company Name|Form Type|Date Filed|Filename, after a header the parser skips by SHAPE rather than by line count
 * (the header's own length has changed before now). A line that does not have five fields, or whose filename is not an
 * edgar/data/<cik>/<accession>.txt, is counted in `counts.unreadable` — never skipped quietly.
 */
function parseMasterIndex(text, { day = null } = {}) {
  const counts = { lines: 0, form4: 0, form4A: 0, otherForms: 0, unreadable: 0 };
  const form4 = [], seen = new Set(), seenA = new Set();
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^-{3,}$/.test(line) || !/^\d+\|/.test(line)) continue;      // the header, the rule line, the blank lines
    counts.lines++;
    const f = line.split("|");
    if (f.length < 5) { counts.unreadable++; continue; }
    const [cik, , form, filedOn, file] = f.map((x) => x.trim());
    if (form !== "4" && form !== "4/A") { counts.otherForms++; continue; }
    const m = /^edgar\/data\/(\d+)\/([\d-]+)\.txt$/.exec(file);
    if (!m || !/^\d{10}-\d{2}-\d{6}$/.test(m[2])) { counts.unreadable++; continue; }
    const accession = m[2];
    // the SEC lists a filing once per FILER and once for the issuer, so the same accession appears two or three times:
    // one filing is one read, and one count
    if (form === "4/A") { if (!seenA.has(accession)) { seenA.add(accession); counts.form4A++; } continue; }   // an amendment restates a filing already counted
    if (seen.has(accession)) continue;
    seen.add(accession);
    counts.form4++;
    form4.push({ cik: String(Number(cik)).padStart(10, "0"), form, filedOn: isoDay(filedOn) || isoDay(day), file, accession, url: SEC_ARCHIVES + file });
  }
  return { form4, counts };
}

/**
 * One filing day: fetch its index, fetch every Form 4 in it, parse, and build the company-day records.
 * `secGet(url, opts)` is sec-fetch's get (the only way out of this process). Returns everything the run line needs; it writes nothing.
 */
async function collectDay(secGet, day, { commonOnly = true, collectedOn = null, log = () => {}, maxFilings = Infinity } = {}) {
  const d = isoDay(day);
  if (!d) throw new Error(`insider-buys: --date ${JSON.stringify(day)} is not an ISO day`);
  const holiday = marketHoliday(d), weekend = isWeekend(d);
  const out = {
    filingDay: d, tradingDay: !holiday && !weekend, whyClosed: holiday ? `market holiday (${holiday})` : weekend ? "weekend" : null,
    index: { url: masterIndexUrl(d), found: false, counts: null },
    filings: { listed: 0, read: 0, purchases: 0, amendments: 0, noPurchase: 0, notOfficerOrDirector: 0, unreadable: 0, unfetched: 0 },
    excluded: { notPurchase: 0, disposed: 0, nonCommon: 0, noPrice: 0, noShares: 0, noDate: 0, notOfficerOrDirector: 0, amendment: 0, equitySwap: 0 },
    unresolved: [], records: [],
  };
  const idx = await secGet(out.index.url, { label: `index ${d}` });
  if (idx.notFound) {
    out.index.notFound = true;
    log(`${d}: no daily index (HTTP 404)${out.tradingDay ? " — and it is a TRADING day: that is a failed read, not an empty one" : ` — ${out.whyClosed}, as expected`}`);
    if (out.tradingDay) out.unresolved.push({ what: "daily index", url: out.index.url, why: "HTTP 404 on a trading day" });
    return out;
  }
  if (!idx.ok) { out.unresolved.push({ what: "daily index", url: out.index.url, why: idx.why || `HTTP ${idx.status}` }); log(`${d}: the daily index could not be read (${idx.why || idx.status}) — nothing is assumed about the day`); return out; }
  out.index.found = true;
  const { form4, counts } = parseMasterIndex(idx.text, { day: d });
  out.index.counts = counts;
  out.filings.amendments = counts.form4A;
  out.filings.listed = form4.length;
  if (counts.unreadable) log(`${d}: ${counts.unreadable} index line(s) could not be read`);
  log(`${d}: ${form4.length} original Form 4 filings listed (${counts.form4A} amendments, ${counts.otherForms} other forms)`);

  const days = new Map();                                           // "<issuerCik>|<tradeDate>" -> working day
  let n = 0;
  for (const f of form4) {
    if (++n > maxFilings) { out.unresolved.push({ what: "filing", accession: f.accession, url: f.url, why: `past --max-filings ${maxFilings}` }); continue; }
    const res = await secGet(f.url, { label: f.accession });
    if (!res.ok) {
      out.filings.unfetched++;
      out.unresolved.push({ what: "filing", accession: f.accession, url: f.url, why: res.notFound ? "HTTP 404" : (res.why || `HTTP ${res.status}`) });
      continue;
    }
    const p = parseForm4(res.text, { commonOnly });
    if (!p.ok) { out.filings.unreadable++; out.unresolved.push({ what: "filing", accession: f.accession, url: f.url, why: p.why }); continue; }
    out.filings.read++;
    for (const k of Object.keys(out.excluded)) out.excluded[k] += p.excluded[k] || 0;
    if (p.amendment) continue;                                      // counted from the index; never summed
    if (!p.qualifyingOwners.length) { out.filings.notOfficerOrDirector++; continue; }
    if (!p.buys.length) { out.filings.noPurchase++; continue; }
    out.filings.purchases++;
    for (const buy of p.buys) {
      const key = `${p.issuer.cik}|${buy.tradeDate}`;
      const day0 = days.get(key) || B.emptyDay(p.issuer.cik, buy.tradeDate);
      B.addFiling(day0, {
        accession: f.accession, filedOn: f.filedOn, sym: p.issuer.symbol, issuer: p.issuer.name,
        owners: p.qualifyingOwners.map((o) => ({ cik: o.cik, role: o.role, officerTitle: o.officerTitle })),
        usd: buy.usd, shares: buy.shares,
      });
      days.set(key, day0);
    }
  }
  out.records = [...days.values()].map((w) => B.finalizeDay(w, { collectedOn: collectedOn || etToday() }));
  return out;
}

/** the run line that goes into the dated file beside the company-days */
function runLine(day, res, stats, { collectedOn, userAgentSet, args }) {
  return {
    filingDay: day.filingDay, collectedOn, tradingDay: day.tradingDay, whyClosed: day.whyClosed,
    index: { url: day.index.url, found: day.index.found, notFound: Boolean(day.index.notFound), counts: day.index.counts },
    filings: day.filings, excluded: day.excluded,
    companyDays: res.after, added: res.added, updated: res.updated, unchanged: res.unchanged,
    unresolved: day.unresolved,
    complete: day.unresolved.length === 0 && (day.index.found || !day.tradingDay),
    requests: stats ? { made: stats.requests, retried: stats.retried, rateLimited: stats.rateLimited, serverErrors: stats.serverErrors, networkErrors: stats.networkErrors, notFound: stats.notFound, peakPerSecond: stats.peakPerSecond, perSecondLimit: stats.perSecond, waitedMs: stats.waitedMs, spentMs: stats.spentMs } : null,
    userAgentSet, args,
  };
}

/**
 * run(opts) -> { code, lines, days }. Everything the CLI does, on injected dependencies, so the package's selftest runs the whole
 * collector on saved fixture filings with no clock and no network: `fetchFn` is the one door out and the selftest holds the key.
 */
async function run({
  dates, fetchFn, userAgent = process.env.SEC_USER_AGENT, perSecond = MAX_PER_SECOND, outDir = OUT_DIR_DEFAULT, dry = false,
  commonOnly = true, collectedOn = null, now = () => Date.now(), sleep, log = (s) => console.log(s), maxFilings = Infinity,
  args = [], budgetMs = DAY_BUDGET_MS, tries,
} = {}) {
  const lines = [], say = (s) => { lines.push(s); log(s); };
  if (!Array.isArray(dates) || !dates.length) return { code: 2, lines: ["insider-buys: no filing day to collect"], days: [] };
  // ONE limiter for the whole run (the SEC's 10 a second is the desk's, not each day's), a fetcher with its OWN budget per day:
  // a thirty-day backfill must not be cut off because day one spent the whole run's seconds.
  const limiter = makeLimiter({ perSecond, now, sleep });
  const makeDayFetcher = () => makeSecFetcher({ fetchFn, userAgent, perSecond, now, sleep, limiter, budgetMs, log: (s) => say("  " + s), ...(tries === undefined ? {} : { tries }) });
  const probe = makeDayFetcher();                                  // built first so a bad User-Agent or rate refuses before any write
  const on = isoDay(collectedOn) || etToday();
  say(`insider buys — filing day(s) ${dates.join(", ")} · ${perSecond}/s at most · User-Agent "${probe.userAgent}"${dry ? " · --dry: nothing is written" : ` · out ${outDir}`}`);
  if (!dry) fs.mkdirSync(outDir, { recursive: true });
  const done = [], total = { requests: 0, retried: 0, rateLimited: 0, serverErrors: 0, networkErrors: 0, notFound: 0, failed: 0 };
  let incomplete = 0;
  for (const day of dates) {
    const sec = makeDayFetcher();
    let d, dayStats;
    try { d = await collectDay(sec.get, day, { commonOnly, collectedOn: on, log: (s) => say("  " + s), maxFilings }); }
    finally { dayStats = sec.stats(); for (const k of Object.keys(total)) total[k] += dayStats[k] || 0; }
    const file = path.join(outDir, `insider-buys-${d.filingDay}.jsonl`);
    let existing = "";
    try { existing = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
    const merged = B.mergeJsonl(existing, d.records, { collectedOn: on });
    if (merged.bad.length) { say(`  REFUSED to write ${path.basename(file)}: ${merged.bad.length} line(s) of it cannot be read (${merged.bad.slice(0, 3).map((b) => `line ${b.line}: ${b.why}`).join("; ")}) — look at the file before it is rewritten`); incomplete++; done.push({ day: d, merged: null, file, refused: "unreadable lines" }); continue; }
    if (merged.lostDays.length) { say(`  REFUSED to write ${path.basename(file)}: the merge would lose ${merged.lostDays.length} company-day(s) already in it (${merged.lostDays.slice(0, 3).join(", ")}${merged.unmergeable.length ? `; unmergeable: ${merged.unmergeable.slice(0, 2).map((u) => `${u.key} — ${u.why}`).join("; ")}` : ""}) — a collector never shrinks its own history: the file is left exactly as it is`); incomplete++; done.push({ day: d, merged: null, file, refused: "would lose company-days" }); continue; }
    const line = runLine(d, merged, dayStats, { collectedOn: on, userAgentSet: true, args });
    const text = B.serializeJsonl(merged.records, line);
    if (!dry) {
      writeTextAtomic(file, text);
      const back = B.parseJsonl(fs.readFileSync(file, "utf8"));
      if (back.records.length !== merged.records.length || back.bad.length) throw new Error(`${file} does not read back as written (${back.records.length} of ${merged.records.length} rows, ${back.bad.length} unreadable)`);
    }
    say(`  ${d.filingDay}: ${merged.after} company-day${merged.after === 1 ? "" : "s"} (${merged.added} new, ${merged.updated} updated, ${merged.unchanged} unchanged) · ${d.filings.read}/${d.filings.listed} filings read, ${d.filings.purchases} with a qualifying purchase · ${dry ? "would write" : "wrote"} ${path.basename(file)}`);
    if (d.unresolved.length) { say(`  ${d.filingDay}: ${d.unresolved.length} UNRESOLVED — ${d.unresolved.slice(0, 5).map((u) => `${u.accession || u.what} (${u.why})`).join("; ")}${d.unresolved.length > 5 ? " …" : ""}`); incomplete++; }
    done.push({ day: d, merged, file, line });
  }
  const l = limiter.stats();
  say(`requests ${total.requests} (retried ${total.retried}, 429 ${total.rateLimited}, 5xx ${total.serverErrors}, no answer ${total.networkErrors}, 404 ${total.notFound}) · peak ${l.peakPerSecond}/s against a ${l.perSecond}/s limit · waited ${Math.round(l.waitedMs / 100) / 10}s`);
  if (incomplete) say(`INCOMPLETE: ${incomplete} filing day(s) did not read whole. Run the same day again — the merge is keyed by accession, so a re-run costs only the filings that are still missing.`);
  else say("complete: every listed filing was read.");
  return { code: incomplete ? 3 : 0, lines, days: done, stats: { ...total, ...l } };
}

function usage() {
  console.log(`usage: node backend/insider-buys-collect.js [--date YYYY-MM-DD | --from YYYY-MM-DD --to YYYY-MM-DD] [--rate N] [--out-dir DIR] [--user-agent "…"] [--max-filings N] [--dry]
  SEC_USER_AGENT (or --user-agent) is REQUIRED: the SEC asks every caller to declare itself, and nothing in this repository holds a
  contact string. --rate is 10 a second at most (the SEC's own limit) and 10 by default.
  Exit 0 every listed filing read · 3 a partial read (named in the run line; run the day again) · 2 refused or usage · 1 failed.`);
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const flag = (name, def = null) => { const i = a.indexOf(name); return i >= 0 && i + 1 < a.length ? a[i + 1] : def; };
  const has = (name) => a.includes(name);
  (async () => {
    if (has("--help") || has("-h")) { usage(); process.exit(2); }
    const from = isoDay(flag("--from")), to = isoDay(flag("--to")), one = isoDay(flag("--date"));
    let dates;
    if (from && to) { if (from > to) { console.error(`insider-buys: --from ${from} is after --to ${to}`); process.exit(2); } dates = []; for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d); }
    else if (one) dates = [one];
    else if (flag("--date") || flag("--from") || flag("--to")) { console.error("insider-buys: --date / --from / --to need an ISO day (YYYY-MM-DD)"); process.exit(2); }
    else dates = [etToday()];
    if (dates.length > 60) { console.error(`insider-buys: ${dates.length} filing days in one run — ask for 60 at most, so a run has a bounded length`); process.exit(2); }
    const rate = flag("--rate") === null ? MAX_PER_SECOND : Number(flag("--rate"));
    const r = await run({
      dates, fetchFn: globalThis.fetch, userAgent: flag("--user-agent", process.env.SEC_USER_AGENT), perSecond: rate,
      outDir: flag("--out-dir", OUT_DIR_DEFAULT), dry: has("--dry"), maxFilings: flag("--max-filings") === null ? Infinity : Number(flag("--max-filings")), args: a,
    });
    process.exit(r.code);
  })().catch((e) => { console.error(`insider-buys FAILED: ${e && e.message ? e.message : e}`); process.exit(/refused|REQUIRED|is not|above the SEC/i.test(String(e && e.message)) ? 2 : 1); });
}

module.exports = { run, collectDay, parseMasterIndex, masterIndexUrl, runLine, quarterOf, isWeekend, OUT_DIR_DEFAULT, SEC_ARCHIVES, DAY_BUDGET_MS };
