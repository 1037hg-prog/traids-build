#!/usr/bin/env node
"use strict";
/**
 * CLOSED-END FUND PRICE AND PUBLISHED NAV — the nightly recorder.
 *
 * WHY IT EXISTS. R354's entry (backend/data/test-registry.json, preregistered[] id R354) puts three things to the operator, and this is
 * the first: "Start a nightly recorder now, whatever happens to this test? Each night for all 359 funds of the frozen list: the price,
 * the first value Yahoo shows for that day's NAV with the clock time it was first seen (appended, never overwritten; a later different
 * value appended as a revision), and the list's own row with its term date. It is the only cure for survivorship and for rewritten
 * history, and every week without it loses for good the history of whichever fund dies that week. IT BELONGS TO NO REGISTRATION AND
 * READS NO RESULT." That is exactly what this file does and all it does.
 *   - it is not R354's runner and computes nothing R354 reads: no discount, no z-score, no return, no statistic, no verdict;
 *   - it never places an order of any kind;
 *   - it writes ONE dated JSONL a day, APPEND-ONLY: a value already recorded for a (fund, date) is not written again, and a LATER
 *     DIFFERENT NAV for a date is appended as a revision (rev 1, 2, ...) beside the first one, which is never touched;
 *   - every fetch goes through an INJECTED fetcher, so the selftest runs the whole night on made-up answers with no network at all.
 *
 *   node backend/fund-nav-record.js --selftest     the known-answer cases on a fake fetcher and a scratch folder; ends "ALL n PASSED"
 *   node backend/fund-nav-record.js --dry          ONE look at the real endpoints, printing every row it WOULD write; writes nothing
 *   node backend/fund-nav-record.js --record       ONE look, appending what is new to backend/data/fund-nav/<ET date>.jsonl
 *   node backend/fund-nav-record.js --status       read-only: the files on disk, their rows, the funds last seen and when
 *
 * WHERE IT WRITES. backend/data/fund-nav/YYYY-MM-DD.jsonl, the ET date of the rows in it, through backend/lib/atomic-write.js
 * (writeTextAtomic: temp file, fsync, rename), so a kill mid-write leaves the old file whole. Rows, one JSON object a line:
 *   { k:"look",  at, etDate, etClock, looks, funds, priceRows, navFirstSeen, navRevisions, missingNav, source }   one a look
 *   { k:"price", t, d, c, v, o, h, l, seenAt, etClock }                                       the fund's close for the ET date d
 *   { k:"nav",   t, sym, d, c, rev, seenAt, etClock }                                         rev 0 = the FIRST value seen for d
 *   { k:"list",  t, asOf, name, sym, category, sponsor, term, termDate, inception, seenAt }    the list's own row, with its term date
 *   { k:"gone",  t, asOf, lastSeen, seenAt }                                                   a fund that was on the list and is not
 * A revision row carries the same d and a higher rev; nothing is ever edited or removed. The folder is the whole state: the recorder
 * keeps no index and no lock, and two looks in the same minute cannot write a half row.
 *
 * NO SECRETS, NO KEYS, NO PERSONAL DETAILS: the endpoints are public GETs with no login. The selftest's values are plainly made up.
 */
const fs = require("fs"), path = require("path");
const { writeTextAtomic } = require("./lib/atomic-write.js");

const OUT_DIR = path.join(__dirname, "data", "fund-nav");
const LIST_URL = "https://www.cefconnect.com/api/v3/DailyPricing";
const CHART_URL = (sym) => `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1mo&events=div%2Csplit`;
/** the descriptive fields of the list that are kept; its discount, z-score and return fields are NEVER read or stored */
const LIST_KEEP = Object.freeze(["Ticker", "Name", "NavTicker", "CategoryName", "SponsorName", "Term", "TermDate", "InceptionDate", "DistributionFrequency", "LastUpdated"]);
const fin = (x) => typeof x === "number" && Number.isFinite(x);

// ─────────────────────────────────────────────────────────── the ET clock ───────────────────────────────────────────────────────────
const ET = (ms, opts) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", ...opts }).format(new Date(ms));
/** the ET date and clock of an instant: { etDate, etClock } */
function etStamp(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { etDate: `${p.year}-${p.month}-${p.day}`, etClock: `${String(+p.hour % 24).padStart(2, "0")}:${p.minute} ET` };
}
/** the ET date a Yahoo daily timestamp belongs to (its rows are stamped at the session's open) */
const etDateOf = (epochSeconds) => etStamp(epochSeconds * 1000).etDate;

// ──────────────────────────────────────────── the fetch functions (every one takes the fetcher) ─────────────────────────────────────
/**
 * THE FETCHER a caller hands in: `async (url, { headers }) => ({ status, text })`. Nothing in this file calls the network any other
 * way, so the selftest's fetcher answers every URL from a table and no socket is opened.
 */
function httpFetcher({ minGapMs = 700, timeoutMs = 45000 } = {}) {
  let last = 0;
  return async (url, { headers = {} } = {}) => {
    const wait = last + minGapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    return { status: r.status, text: await r.text() };
  };
}
/** THE LIST: the public daily-pricing list, reduced to its descriptive fields in memory before anything is stored */
async function fetchList(fetcher, { url = LIST_URL } = {}) {
  const r = await fetcher(url, { headers: { Accept: "application/json, text/plain, */*" } });
  if (r.status !== 200) return { ok: false, why: `HTTP ${r.status} from the list`, rows: [] };
  let raw;
  try { raw = JSON.parse(r.text); } catch (e) { return { ok: false, why: `the list is not JSON (${e.message})`, rows: [] }; }
  if (!Array.isArray(raw)) return { ok: false, why: "the list is not an array of rows", rows: [] };
  const rows = raw.map((x) => {
    const o = {}; for (const k of LIST_KEEP) if (x[k] !== undefined) o[k] = x[k];
    return o;
  }).filter((x) => x.Ticker);
  return { ok: true, rows, asOf: String((rows[0] || {}).LastUpdated || "").slice(0, 10) || null };
}
/** ONE SYMBOL's daily rows: the raw closes, the volume, the events and what Yahoo says the symbol is. The adjusted close is not read. */
async function fetchChart(fetcher, symbol, { url = null } = {}) {
  const r = await fetcher(url || CHART_URL(symbol), {});
  if (r.status !== 200) return { ok: false, symbol, why: `HTTP ${r.status}`, rows: [] };
  let j;
  try { j = JSON.parse(r.text); } catch (e) { return { ok: false, symbol, why: `not JSON (${e.message})`, rows: [] }; }
  const res = j && j.chart && Array.isArray(j.chart.result) ? j.chart.result[0] : null;
  if (!res || !Array.isArray(res.timestamp)) return { ok: false, symbol, why: (j && j.chart && j.chart.error && (j.chart.error.description || j.chart.error.code)) || "no rows in the answer", rows: [] };
  const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
  const rows = res.timestamp.map((t, i) => ({
    d: etDateOf(t), c: fin(q.close && q.close[i]) ? q.close[i] : null, v: fin(q.volume && q.volume[i]) ? q.volume[i] : null,
    o: fin(q.open && q.open[i]) ? q.open[i] : null, h: fin(q.high && q.high[i]) ? q.high[i] : null, l: fin(q.low && q.low[i]) ? q.low[i] : null,
  }));
  const ev = res.events || {};
  return { ok: true, symbol, rows,
    type: (res.meta && res.meta.instrumentType) || null, exchange: (res.meta && res.meta.exchangeName) || null,
    dividends: Object.values(ev.dividends || {}).map((x) => ({ d: etDateOf(x.date), amount: x.amount })),
    splits: Object.values(ev.splits || {}).map((x) => ({ d: etDateOf(x.date), num: x.numerator, den: x.denominator })) };
}

// ───────────────────────────────────────────────── the dated JSONL, append-only ─────────────────────────────────────────────────────
const dayFile = (etDate, dir = OUT_DIR) => path.join(dir, `${etDate}.jsonl`);
/** every row of one day's file, in the order they were appended (a bad line is kept as { k:"bad" } and never silently dropped) */
function readDay(etDate, dir = OUT_DIR) {
  let text;
  try { text = fs.readFileSync(dayFile(etDate, dir), "utf8"); } catch { return []; }
  return text.split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return { k: "bad", line: l.slice(0, 120) }; } });
}
/**
 * APPEND rows to a day's file. It never rewrites a row: the file's own bytes are read, the new lines are added at the end and the
 * whole is written through writeTextAtomic (temp file, fsync, rename), so a kill leaves either the old file or the old file plus
 * these rows. An empty list writes nothing at all.
 */
function appendRows(etDate, rows, dir = OUT_DIR) {
  if (!rows.length) return { written: 0, file: dayFile(etDate, dir) };
  fs.mkdirSync(dir, { recursive: true });
  const file = dayFile(etDate, dir);
  let before = "";
  try { before = fs.readFileSync(file, "utf8"); } catch { before = ""; }
  const text = (before && !before.endsWith("\n") ? before + "\n" : before) + rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeTextAtomic(file, text);
  return { written: rows.length, file };
}

// ───────────────────────────────────────────────────────────── one look ─────────────────────────────────────────────────────────────
/**
 * ONE LOOK at the list and at every fund's two symbols, turned into the rows that are NEW. This is the whole of the recorder's
 * judgement and it is pure: it takes what was fetched and what is already on disk, and returns rows.
 *   - a price row is new when the day's file holds no price row for that (fund, ET date) with the same close;
 *   - a NAV row is new when the file holds no NAV row for that (fund, ET date) at all (rev 0, the FIRST value seen, with the clock
 *     time), or holds one whose value DIFFERS from what is now shown (a revision, rev = the highest rev for that date plus one);
 *   - a list row is new when the file holds none for that fund today, or the fund's descriptive fields have changed;
 *   - a fund that was on the list yesterday and is not on it today is recorded once as "gone" — the survivorship cure.
 * It writes nothing; the caller does.
 */
function rowsOfLook({ nowMs, list, charts, priorDay = [], yesterdayTickers = [], source = "yahoo+list" }) {
  const { etDate, etClock } = etStamp(nowMs), at = new Date(nowMs).toISOString(), rows = [];
  const seenAt = at;
  const priceSeen = new Map(), navSeen = new Map(), listSeen = new Map(), goneSeen = new Set();
  for (const r of priorDay) {
    if (r.k === "price") priceSeen.set(`${r.t}|${r.d}`, r.c);
    if (r.k === "nav") { const key = `${r.t}|${r.d}`; const l = navSeen.get(key) || []; l.push(r); navSeen.set(key, l); }
    if (r.k === "list") listSeen.set(r.t, r);
    if (r.k === "gone") goneSeen.add(r.t);
  }
  const listRows = (list && list.ok ? list.rows : []) || [];
  const asOf = (list && list.asOf) || etDate;
  const tickers = new Set(listRows.map((x) => x.Ticker));
  for (const x of listRows) {
    const row = { k: "list", t: x.Ticker, asOf, name: x.Name || null, sym: x.NavTicker || null, category: x.CategoryName || null,
      sponsor: x.SponsorName || null, term: x.Term === true, termDate: x.TermDate ? String(x.TermDate).slice(0, 10) : null,
      inception: x.InceptionDate ? String(x.InceptionDate).slice(0, 10) : null, frequency: x.DistributionFrequency || null, seenAt };
    const had = listSeen.get(x.Ticker);
    const same = had && ["name", "sym", "category", "sponsor", "term", "termDate", "inception", "frequency", "asOf"].every((k) => had[k] === row[k]);
    if (!same) rows.push(row);
  }
  for (const t of yesterdayTickers) if (!tickers.has(t) && !goneSeen.has(t)) rows.push({ k: "gone", t, asOf, lastSeen: "the look before this one", seenAt });
  let priceRows = 0, navFirst = 0, navRev = 0, missingNav = 0;
  for (const [ticker, c] of Object.entries(charts)) {
    const price = c.price, nav = c.nav;
    if (price && price.ok) {
      for (const r of price.rows) {
        if (r.c == null) continue;
        if (priceSeen.get(`${ticker}|${r.d}`) === r.c) continue;
        if (priceSeen.has(`${ticker}|${r.d}`)) continue;                                  // a close already recorded for that date is left as it was
        rows.push({ k: "price", t: ticker, d: r.d, c: r.c, v: r.v, o: r.o, h: r.h, l: r.l, seenAt, etClock });
        priceSeen.set(`${ticker}|${r.d}`, r.c); priceRows++;
      }
    }
    if (nav && nav.ok) {
      const today = nav.rows.filter((r) => r.c != null);
      if (!today.some((r) => r.d === etDate)) missingNav++;
      for (const r of today) {
        const key = `${ticker}|${r.d}`, had = navSeen.get(key) || [];
        if (!had.length) { rows.push({ k: "nav", t: ticker, sym: nav.symbol, d: r.d, c: r.c, rev: 0, seenAt, etClock }); navSeen.set(key, [{ ...r, rev: 0 }]); navFirst++; continue; }
        if (had.some((x) => x.c === r.c)) continue;                                        // this value is already on file for that date
        const rev = Math.max(...had.map((x) => x.rev || 0)) + 1;
        rows.push({ k: "nav", t: ticker, sym: nav.symbol, d: r.d, c: r.c, rev, seenAt, etClock, revisionOf: had[0].c });
        navSeen.set(key, [...had, { ...r, rev }]); navRev++;
      }
    } else missingNav++;
  }
  const looks = priorDay.filter((r) => r.k === "look").length + 1;
  rows.unshift({ k: "look", at, etDate, etClock, looks, funds: Object.keys(charts).length, listRows: listRows.length,
    priceRows, navFirstSeen: navFirst, navRevisions: navRev, missingNav, source, listOk: !!(list && list.ok), listWhy: list && list.ok ? null : (list && list.why) || "the list was not fetched" });
  return { etDate, etClock, rows, counts: { priceRows, navFirstSeen: navFirst, navRevisions: navRev, missingNav, listRows: listRows.length } };
}
/**
 * THE NIGHT'S RUN: one look, fetched through the injected fetcher, written (or not, with dry) to the dated JSONL. The universe is the
 * list's own rows; a frozen list may be handed in instead (the operator's choice), and the NAV symbol is the list's own field, never
 * built as X + ticker + X.
 */
async function runLook({ fetcher, dry = false, nowMs = Date.now(), dir = OUT_DIR, log = console.log, only = null, frozenList = null, concurrency = 4 }) {
  const { etDate, etClock } = etStamp(nowMs);
  log(`${dry ? "--dry: " : ""}one look at ${etDate} ${etClock} — the list, then each fund's price and NAV symbol${dry ? " (nothing will be written)" : ""}`);
  const list = frozenList ? { ok: true, rows: frozenList, asOf: etDate } : await fetchList(fetcher);
  if (!list.ok) log(`  the list could not be read: ${list.why} — the look goes on with the funds already on file`);
  let universe = (list.ok ? list.rows : []).map((x) => ({ ticker: x.Ticker, navSymbol: x.NavTicker }));
  const prior = readDay(etDate, dir);
  if (!universe.length) {
    const seen = new Map(); for (const r of prior) if (r.k === "list") seen.set(r.t, r.sym);
    universe = [...seen].map(([ticker, navSymbol]) => ({ ticker, navSymbol }));
  }
  if (only) universe = universe.filter((u) => only.includes(u.ticker));
  const charts = {};
  for (let i = 0; i < universe.length; i += concurrency) {
    const batch = universe.slice(i, i + concurrency);
    await Promise.all(batch.map(async (u) => {
      const price = await fetchChart(fetcher, u.ticker);
      const nav = u.navSymbol ? await fetchChart(fetcher, u.navSymbol) : { ok: false, symbol: null, why: "the list names no NAV symbol", rows: [] };
      charts[u.ticker] = { price, nav };
    }));
    if ((i / concurrency) % 10 === 0) log(`  ${Math.min(i + concurrency, universe.length)}/${universe.length} funds looked at`);
  }
  const yesterdayTickers = lastListTickers({ before: etDate, dir });
  const look = rowsOfLook({ nowMs, list, charts, priorDay: prior, yesterdayTickers });
  log(`  rows that are new: ${look.rows.length} (${look.counts.priceRows} price, ${look.counts.navFirstSeen} first-seen NAV, ${look.counts.navRevisions} revision(s), ${look.counts.listRows} list row(s) read, ${look.counts.missingNav} fund(s) with no NAV for today)`);
  if (dry) { for (const r of look.rows.slice(0, 40)) log(`    ${JSON.stringify(r)}`); if (look.rows.length > 40) log(`    … and ${look.rows.length - 40} more`); return { ...look, written: 0, file: dayFile(etDate, dir), dry: true }; }
  const w = appendRows(etDate, look.rows, dir);
  log(`  appended ${w.written} row(s) to ${w.file} (nothing in it was changed)`);
  return { ...look, ...w, dry: false };
}
/** the tickers of the last list row set recorded before a given ET date — what "gone" is measured against */
function lastListTickers({ before, dir = OUT_DIR }) {
  let days;
  try { days = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).map((n) => n.slice(0, 10)).sort(); } catch { return []; }
  const earlier = days.filter((d) => d < before);
  for (let i = earlier.length - 1; i >= 0; i--) {
    const t = readDay(earlier[i], dir).filter((r) => r.k === "list").map((r) => r.t);
    if (t.length) return [...new Set(t)];
  }
  return [];
}
/** --status: what is on disk, read-only */
function status({ dir = OUT_DIR, log = console.log } = {}) {
  let days = [];
  try { days = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort(); } catch { log(`no recordings yet: ${dir} does not exist`); return { days: [] }; }
  log(`the nightly recorder — ${days.length} day file(s) in ${dir}`);
  const out = [];
  for (const n of days.slice(-10)) {
    const rows = readDay(n.slice(0, 10), dir), by = {};
    for (const r of rows) by[r.k] = (by[r.k] || 0) + 1;
    const looks = rows.filter((r) => r.k === "look");
    out.push({ day: n.slice(0, 10), rows: rows.length, by });
    log(`  ${n}  ${String(rows.length).padStart(6)} rows  ${JSON.stringify(by)}${looks.length ? `  looks at ${looks.map((l) => l.etClock).join(", ")}` : ""}`);
  }
  if (days.length > 10) log(`  (the ${days.length - 10} earlier day file(s) are not listed)`);
  return { days: days.map((n) => n.slice(0, 10)), recent: out };
}

// ────────────────────────────────────────────────────────────── selftest ────────────────────────────────────────────────────────────
/** a fetcher that answers from a table and opens no socket; it counts what it was asked for */
function fakeFetcher(table) {
  const asked = [];
  const f = async (url) => { asked.push(url); const hit = Object.entries(table).find(([k]) => url.includes(k)); return hit ? hit[1] : { status: 404, text: "{}" }; };
  f.asked = asked;
  return f;
}
const chartAnswer = (symbol, rows, { type = "EQUITY", exchange = "NYQ", dividends = {}, splits = {} } = {}) => ({
  status: 200, text: JSON.stringify({ chart: { result: [{ meta: { instrumentType: type, exchangeName: exchange },
    timestamp: rows.map((r) => r.ts), events: { dividends, splits },
    indicators: { quote: [{ close: rows.map((r) => r.c), volume: rows.map((r) => r.v == null ? null : r.v), open: rows.map((r) => r.c), high: rows.map((r) => r.c), low: rows.map((r) => r.c) }] } }], error: null } }),
});
/** 13:00 ET of a date, as an epoch in seconds (the hour Yahoo stamps a US daily row inside) */
const ts = (etDate) => Math.floor(Date.parse(`${etDate}T17:00:00Z`) / 1000);

function selftest({ log = console.log, dir = null } = {}) {
  const os = require("os");
  const scratch = dir || fs.mkdtempSync(path.join(os.tmpdir(), "r354-nav-record-"));
  let passed = 0, failed = 0; const fails = [];
  const check = (name, fn) => {
    let ok = false, detail = "";
    try { const r = fn(); if (r === true) ok = true; else if (r && typeof r === "object") { ok = !!r.ok; detail = r.detail || ""; } else { ok = false; detail = `returned ${JSON.stringify(r)}`; } }
    catch (e) { ok = false; detail = `threw: ${e.message}`; }
    if (ok) passed++; else { failed++; fails.push(`${name}${detail ? " — " + detail : ""}`); }
    log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail && !ok ? " — " + detail : ""}`);
  };
  const run = (opts) => { let out = null; const p = runLook({ log: () => {}, ...opts }).then((r) => { out = r; }); return { p, get: () => out }; };
  const sync = async (opts) => await runLook({ log: () => {}, ...opts });
  log("FUND NAV RECORDER SELFTEST — made-up answers, a scratch folder, no network");

  check("the ET date and clock of an instant", () => {
    const a = etStamp(Date.parse("2026-10-16T21:43:00Z"));                                  // 17:43 ET
    const b = etStamp(Date.parse("2026-10-17T03:10:00Z"));                                  // 23:10 ET on the 16th
    return { ok: a.etDate === "2026-10-16" && a.etClock === "17:43 ET" && b.etDate === "2026-10-16" && b.etClock === "23:10 ET", detail: `${a.etDate} ${a.etClock} / ${b.etDate} ${b.etClock}` };
  });
  check("a Yahoo daily timestamp is placed on its ET date", () => etDateOf(ts("2026-10-16")) === "2026-10-16" && etDateOf(ts("2026-01-02")) === "2026-01-02");
  check("the list keeps only its descriptive fields, by name", () => {
    const bad = LIST_KEEP.filter((k) => /discount|zscore|return|yield|nav$/i.test(k));
    return { ok: bad.length === 0 && LIST_KEEP.includes("Ticker") && LIST_KEEP.includes("TermDate") && LIST_KEEP.includes("NavTicker"), detail: bad.join(",") };
  });

  // the fake night
  const LIST = { status: 200, text: JSON.stringify([
    { Ticker: "AAA", Name: "Made Up Fund A", NavTicker: "XAAAX", CategoryName: "US Equity", SponsorName: "Nobody", Term: false, TermDate: null, InceptionDate: "1998-01-02", DistributionFrequency: "Monthly", LastUpdated: "2026-10-16T00:00:00", Discount: -12.5, OneYearZScore: -2.4, NAV: 9.99 },
    { Ticker: "BBB", Name: "Made Up Fund B", NavTicker: "XBBBX", CategoryName: "Municipal", SponsorName: "Nobody", Term: true, TermDate: "2031-12-31", InceptionDate: "2001-05-05", DistributionFrequency: "Monthly", LastUpdated: "2026-10-16T00:00:00", Discount: -3.1, OneYearZScore: 0.2, NAV: 14.01 },
  ]) };
  const charts1 = {
    "chart/AAA": chartAnswer("AAA", [{ ts: ts("2026-10-15"), c: 8.5, v: 120000 }, { ts: ts("2026-10-16"), c: 8.74, v: 130000 }]),
    "chart/XAAAX": chartAnswer("XAAAX", [{ ts: ts("2026-10-15"), c: 9.9, v: 0 }, { ts: ts("2026-10-16"), c: 9.99, v: 0 }], { type: "MUTUALFUND", exchange: "NAS" }),
    "chart/BBB": chartAnswer("BBB", [{ ts: ts("2026-10-16"), c: 13.6, v: 40000 }]),
    "chart/XBBBX": chartAnswer("XBBBX", [{ ts: ts("2026-10-16"), c: 14.01, v: 0 }], { type: "MUTUALFUND", exchange: "NAS" }),
  };
  const nowMs = Date.parse("2026-10-16T21:43:00Z");
  let first = null, second = null, third = null, dryRun = null;

  const results = {};
  const doIt = async () => {
    const f1 = fakeFetcher({ DailyPricing: LIST, ...charts1 });
    results.dry = await sync({ fetcher: f1, dry: true, nowMs, dir: path.join(scratch, "dry") });
    results.dryAsked = f1.asked.length;
    results.dryFolderExists = fs.existsSync(path.join(scratch, "dry"));
    results.httpError = await fetchChart(fakeFetcher({ "chart/ZZZ": { status: 500, text: "oops" } }), "ZZZ");
    results.emptyChart = await fetchChart(fakeFetcher({ "chart/YYY": { status: 200, text: JSON.stringify({ chart: { result: [], error: { description: "No data found" } } }) } }), "YYY");
    results.first = await sync({ fetcher: fakeFetcher({ DailyPricing: LIST, ...charts1 }), nowMs, dir: path.join(scratch, "a") });
    results.second = await sync({ fetcher: fakeFetcher({ DailyPricing: LIST, ...charts1 }), nowMs: nowMs + 3600e3, dir: path.join(scratch, "a") });
    const charts2 = { ...charts1, "chart/XAAAX": chartAnswer("XAAAX", [{ ts: ts("2026-10-15"), c: 9.9, v: 0 }, { ts: ts("2026-10-16"), c: 10.07, v: 0 }], { type: "MUTUALFUND", exchange: "NAS" }) };
    results.third = await sync({ fetcher: fakeFetcher({ DailyPricing: LIST, ...charts2 }), nowMs: nowMs + 7200e3, dir: path.join(scratch, "a") });
    // the next day, with AAA gone from the list
    const LIST2 = { status: 200, text: JSON.stringify(JSON.parse(LIST.text).filter((x) => x.Ticker !== "AAA")) };
    results.nextDay = await sync({ fetcher: fakeFetcher({ DailyPricing: LIST2, ...charts1 }), nowMs: nowMs + 86400e3, dir: path.join(scratch, "a") });
    results.listFail = await sync({ fetcher: fakeFetcher({ ...charts1 }), nowMs: nowMs + 2 * 86400e3, dir: path.join(scratch, "b") });
  };

  return doIt().then(() => {
    const dayA = () => readDay("2026-10-16", path.join(scratch, "a"));
    check("--dry writes nothing at all — not even the folder — and still says what it would write", () => {
      return { ok: results.dry.dry === true && results.dry.written === 0 && results.dry.rows.length > 1 && results.dryFolderExists === false,
        detail: `--dry would have written ${results.dry.rows.length} row(s); the folder it was pointed at ${results.dryFolderExists ? "EXISTS" : "was not created"}` };
    });
    check("the first look writes one look row, the price and the FIRST NAV of the day with its clock time, and the list rows", () => {
      const rows = results.first.rows, look = rows[0];
      const nav = rows.filter((r) => r.k === "nav"), price = rows.filter((r) => r.k === "price"), list = rows.filter((r) => r.k === "list");
      const todayNav = nav.filter((r) => r.d === "2026-10-16");
      return { ok: look.k === "look" && look.looks === 1 && price.length === 3 && nav.length === 3 && list.length === 2
        && todayNav.every((r) => r.rev === 0 && r.etClock === "17:43 ET") && list.some((r) => r.t === "BBB" && r.term === true && r.termDate === "2031-12-31"),
        detail: `${price.length} price, ${nav.length} nav, ${list.length} list rows` };
    });
    check("the list's discount, z-score and NAV fields are never stored", () => {
      const text = fs.readFileSync(dayFile("2026-10-16", path.join(scratch, "a")), "utf8");
      return { ok: !/Discount|ZScore|zscore/i.test(text), detail: /Discount/i.test(text) ? "a discount field reached the file" : "" };
    });
    check("a second look at the same answers appends ONE look row and no duplicate value", () => {
      const rows = results.second.rows;
      return { ok: rows.length === 1 && rows[0].k === "look" && rows[0].looks === 2, detail: `${rows.length} row(s): ${rows.map((r) => r.k).join(",")}` };
    });
    check("a later DIFFERENT NAV for the day is appended as a revision; the first value is never touched", () => {
      const rows = results.third.rows, rev = rows.filter((r) => r.k === "nav");
      const onFile = dayA().filter((r) => r.k === "nav" && r.t === "AAA" && r.d === "2026-10-16");
      return { ok: rev.length === 1 && rev[0].rev === 1 && rev[0].c === 10.07 && rev[0].revisionOf === 9.99
        && onFile.length === 2 && onFile[0].rev === 0 && onFile[0].c === 9.99 && onFile[1].rev === 1,
        detail: `on file: ${JSON.stringify(onFile.map((r) => [r.rev, r.c, r.etClock]))}` };
    });
    check("nothing already written is ever rewritten: the file only grows, line for line", () => {
      const rows = dayA();
      const looks = rows.filter((r) => r.k === "look");
      return { ok: looks.length === 3 && rows[0].k === "look" && rows.filter((r) => r.k === "bad").length === 0 && rows.length > looks.length,
        detail: `${rows.length} rows, ${looks.length} looks` };
    });
    check("a fund that leaves the list is recorded once as gone (the survivorship cure)", () => {
      const rows = results.nextDay.rows.filter((r) => r.k === "gone");
      return { ok: rows.length === 1 && rows[0].t === "AAA", detail: JSON.stringify(rows) };
    });
    check("a list that cannot be read does not stop the look, and the look row says why", () => {
      const look = results.listFail.rows[0];
      return { ok: look.listOk === false && typeof look.listWhy === "string" && results.listFail.rows.length >= 1, detail: look.listWhy };
    });
    check("the fetch functions take the injected fetcher: nothing in the night opens a socket", () => {
      const src = fs.readFileSync(path.join(__dirname, path.basename(__filename)), "utf8");
      const needle = "await " + "fetch(";                                                    // built at run time so this case does not match itself
      const direct = src.split(needle).length - 1, inHelper = src.split("httpFetcher").length - 1;
      return { ok: direct === 1 && inHelper >= 2 && results.dryAsked > 0, detail: `one real fetch, inside httpFetcher only; the fake fetcher answered ${results.dryAsked} URL(s) in --dry` };
    });
    check("an HTTP error is a miss and never a made-up value", () => {
      const r = results.httpError;
      return { ok: r.ok === false && r.rows.length === 0 && /500/.test(r.why), detail: r.why };
    });
    check("an answer with no rows is a miss, and says what the endpoint said", () => {
      const r = results.emptyChart;
      return { ok: r.ok === false && r.rows.length === 0 && /No data found/.test(r.why), detail: r.why };
    });
    check("the recorder reads no result: it never loads R354's engine or its runner", () => {
      const src = fs.readFileSync(path.join(__dirname, path.basename(__filename)), "utf8");
      const bad = ["fund-discount.js", "r354-fund-discounts", "test-registry"].filter((s) => src.includes(s) && !src.includes(`"${s}"`) === false && new RegExp(`require\\([^)]*${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(src));
      return { ok: bad.length === 0, detail: bad.join(",") };
    });
    check("--status reads the folder and nothing else", () => {
      const s = status({ dir: path.join(scratch, "a"), log: () => {} });
      return { ok: s.days.length === 2 && s.recent.length === 2, detail: s.days.join(",") };
    });
    check("one dated JSONL a day, named by its ET date", () => {
      const names = fs.readdirSync(path.join(scratch, "a")).sort();
      return { ok: names.length === 2 && names[0] === "2026-10-16.jsonl" && names[1] === "2026-10-17.jsonl", detail: names.join(",") };
    });
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* a scratch folder */ }
    log(failed ? `\nSELFTEST: ${failed} of ${passed + failed} FAILED\n  - ${fails.join("\n  - ")}` : `\nALL ${passed} PASSED`);
    return { passed, failed, fails };
  });
}

module.exports = { OUT_DIR, LIST_URL, CHART_URL, LIST_KEEP, etStamp, etDateOf, httpFetcher, fetchList, fetchChart, dayFile, readDay, appendRows, rowsOfLook, runLook, lastListTickers, status, selftest, fakeFetcher, chartAnswer };

if (require.main === module) {
  const a = process.argv.slice(2), MODE = a.length === 1 && ["--selftest", "--dry", "--record", "--status"].includes(a[0]) ? a[0] : null;
  if (!MODE) { console.log("usage: node backend/fund-nav-record.js --selftest | --dry | --record | --status\nNothing was done."); process.exit(2); }
  (async () => {
    if (MODE === "--selftest") { const r = await selftest({ log: console.log }); process.exit(r.failed === 0 ? 0 : 1); }
    if (MODE === "--status") { status({ log: console.log }); process.exit(0); }
    const r = await runLook({ fetcher: httpFetcher(), dry: MODE === "--dry" });
    console.log(r.dry ? "--dry: nothing was written." : `written: ${r.written} row(s) to ${r.file}`);
    process.exit(0);
  })().catch((e) => { console.error(`FAILED: ${e && e.stack ? e.stack : e}`); process.exit(1); });
}
