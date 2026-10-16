#!/usr/bin/env node
"use strict";
/**
 * FILING WORDING COLLECTOR — backlog row 25, 2026-10-16. Runs on the server.
 *
 * For every company it is given, it reads each 10-K and each 10-Q, splits it into the standard items the form prescribes, and
 * records ONE NUMBER PER SECTION: the cosine similarity between that section's word counts and the word counts of THE SAME SECTION
 * OF THE COMPANY'S PREVIOUS FILING OF THE SAME FORM — with the filing date beside it. 1.0 means the section was re-filed word for
 * word; a number well below the company's own history means the wording moved.
 *
 * ── THE TWO LAYERS ─────────────────────────────────────────────────────────────────────────────────────────────────────────
 *   PARSE (backend/lib/filing-sections.js)   saved filing text in, sections and numbers out. Pure: no clock, no disk, no network.
 *                                            Everything in this file that computes a score goes through it, so the scores can be
 *                                            reproduced from the saved text alone.
 *   FETCH (backend/lib/sec-fetch.js)         an INJECTED fetcher with SEC's fair-access limit (10 requests a second) and a declared
 *                                            User-Agent. Nothing in either layer calls the network by itself: --from-dir never
 *                                            touches it, and --fetch builds the transport only when the operator asks for it and
 *                                            SEC_USER_AGENT is set.
 *
 * ── WHAT "THE PREVIOUS FILING" MEANS ───────────────────────────────────────────────────────────────────────────────────────
 * The one before it OF THE SAME FORM, by filing date (accession breaking a tie): a 10-K is compared with the 10-K before it and a
 * 10-Q with the 10-Q before it. Comparing a 10-Q with a 10-K would score the difference between the forms, not a change of wording.
 * The first filing of a form on record has no previous one: it is stored with prev null and no scores, never with a score of 0.
 * A section that only one of the two filings has is listed by name (`onlyHere` / `onlyPrev`) and scored null: a section that did not
 * exist before has no similarity, which is not the same as having been rewritten.
 *
 * ── WHAT IS WRITTEN ────────────────────────────────────────────────────────────────────────────────────────────────────────
 * One file per company, <dataRoot>/filing-wording/<CIK>.json, through backend/lib/atomic-write.js (writeJsonAtomic) — the only way
 * JSON is written in this repository. Rows are keyed by accession, kept in filing-date order, and re-running is idempotent: the
 * same saved text gives the same row, byte for byte. Nothing else is written: this collector registers no test, writes no registry,
 * places no order and starts nothing.
 *
 *   node backend/filing-wording-collector.js --from-dir <folder> [--data <root>] [--dry]
 *        the parse layer on saved text. <folder>/filings.json lists the filings:
 *          [ { "cik": "0000000001", "symbol": "ZZZZ", "form": "10-K", "filingDate": "2025-02-18",
 *              "accession": "0000000001-25-000003", "file": "sample-10k-2025.txt" }, … ]
 *        --dry prints what it would write and writes nothing.
 *   node backend/filing-wording-collector.js --fetch <CIK> [<CIK> …] [--forms 10-K,10-Q] [--since YYYY-MM-DD] [--limit n] [--data <root>] [--dry]
 *        the fetch layer. Needs SEC_USER_AGENT in the environment; refuses without it.
 *   node backend/filing-wording-collector.js --show <CIK> [--data <root>]       what was recorded, as a table
 *   node backend/filing-wording-collector.js --selftest                          fixtures built in memory; no disk, no network
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const S = require("./lib/filing-sections.js");
const F = require("./lib/sec-fetch.js");
const { writeJsonAtomic } = require("./lib/atomic-write.js");

const SCHEMA = "filing-wording-v1";
const VERSION = "1.0.0";
const DEFAULT_DATA = path.join(__dirname, "data");
const storeDir = (dataRoot) => path.join(dataRoot || DEFAULT_DATA, "filing-wording");
const storePath = (dataRoot, cik) => path.join(storeDir(dataRoot), `${F.cik10(cik)}.json`);
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

// ── scoring ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * One filing, parsed. `text` is the filing's saved text exactly as it was read.
 *   parseFiling({ form, text }) -> { form, sections: Map id -> { title, text, words, counts }, warnings, found }
 */
function parseFiling({ form, text }) {
  const split = S.splitSections(text, { form });
  const sections = new Map();
  for (const s of split.sections) sections.set(s.id, { id: s.id, title: s.title, part: s.part, item: s.item, text: s.text, words: s.words, counts: S.countWords(s.text) });
  return { form: split.form, sections, found: split.found, warnings: split.warnings, textLength: split.textLength };
}
/**
 * The record for ONE filing: every section it has, each with its cosine against the same section of `prev` (null when there is no
 * previous filing, or when that filing did not have the section, or when either side has no words).
 *   score(curr, prev) -> { sections: [...], onlyHere: [...], onlyPrev: [...], overall, scored }
 * `overall` is the cosine over the sections the two filings SHARE, concatenated — one number for the filing, computed from the same
 * text as the per-section numbers, so a cover page or an exhibit index cannot move it.
 */
function score(curr, prev) {
  const sections = [], onlyHere = [], onlyPrev = [];
  let bothA = "", bothB = "";
  for (const [id, s] of curr.sections) {
    const p = prev ? prev.sections.get(id) : undefined;
    if (!prev) { sections.push({ id, title: s.title, words: s.words, prevWords: null, cosine: null, note: "no previous filing of this form on record" }); continue; }
    if (!p) { onlyHere.push(id); sections.push({ id, title: s.title, words: s.words, prevWords: null, cosine: null, note: "the previous filing has no such section" }); continue; }
    const c = S.round6(S.cosine(s.counts, p.counts));
    bothA += (bothA ? "\n" : "") + s.text;
    bothB += (bothB ? "\n" : "") + p.text;
    sections.push({ id, title: s.title, words: s.words, prevWords: p.words, cosine: c, note: c === null ? "one of the two sections has no words" : null });
  }
  if (prev) for (const id of prev.sections.keys()) if (!curr.sections.has(id)) onlyPrev.push(id);
  const overall = prev ? S.round6(S.cosine(S.countWords(bothA), S.countWords(bothB))) : null;
  return { sections, onlyHere, onlyPrev, overall, scored: sections.filter((x) => x.cosine !== null).length };
}
/** a real calendar date written YYYY-MM-DD — "2025-13-01" has the right shape and is not a date */
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
/** filing date, then accession — the order "the previous filing" is read in */
const byDate = (a, b) => (a.filingDate < b.filingDate ? -1 : a.filingDate > b.filingDate ? 1 : a.accession < b.accession ? -1 : a.accession > b.accession ? 1 : 0);
const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);

/**
 * Every filing of one company, scored against its own predecessor of the same form.
 *   collect([{ cik, symbol, form, filingDate, accession, text, url?, companyName? }, …]) -> { cik, symbol, companyName, rows }
 * Pure: no clock, no disk. The rows come back in filing-date order, each carrying its filing date, the date of the filing it was
 * compared against, and the per-section scores.
 */
function collect(filings) {
  const list = filings.slice().sort(byDate);
  const prevOfForm = new Map();
  const rows = [];
  for (const f of list) {
    const form = S.baseForm(f.form);
    if (!form) { rows.push({ accession: f.accession, form: String(f.form), filingDate: f.filingDate, skipped: `form ${f.form} is not a 10-K or a 10-Q` }); continue; }
    const parsed = parseFiling({ form, text: f.text });
    const last = prevOfForm.get(form) || null;
    const sc = score(parsed, last ? last.parsed : null);
    rows.push({
      accession: f.accession, form, filingDate: f.filingDate, reportDate: f.reportDate || null,
      source: { url: f.url || null, bytes: Buffer.byteLength(String(f.text), "utf8"), sha256: sha256(String(f.text)) },
      prev: last ? { accession: last.accession, filingDate: last.filingDate, daysBefore: daysBetween(last.filingDate, f.filingDate) } : null,
      overall: sc.overall, sectionsFound: parsed.found.length, sectionsScored: sc.scored,
      sections: sc.sections, onlyHere: sc.onlyHere, onlyPrev: sc.onlyPrev,
      warnings: parsed.warnings,
    });
    prevOfForm.set(form, { accession: f.accession, filingDate: f.filingDate, parsed });
  }
  const first = list[0] || {};
  return { cik: first.cik ? F.cik10(first.cik) : null, symbol: first.symbol || null, companyName: first.companyName || null, rows };
}

// ── the store ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const emptyStore = (cik, symbol, companyName) => ({ schema: SCHEMA, version: VERSION, cik: F.cik10(cik), symbol: symbol || null, companyName: companyName || null, updatedAt: null, filings: [] });
function readStore(dataRoot, cik) {
  try { return JSON.parse(fs.readFileSync(storePath(dataRoot, cik), "utf8")); } catch { return null; }
}
/**
 * The store with these rows in it: a row replaces the row with the same accession, a new row is inserted, and the file stays in
 * filing-date order. Pure — `updatedAt` is passed in, so the same inputs give the same bytes.
 */
function upsert(store, rows, { updatedAt, symbol = null, companyName = null } = {}) {
  const out = { ...store, filings: store.filings.slice() };
  for (const r of rows) {
    const i = out.filings.findIndex((x) => x.accession === r.accession);
    if (i >= 0) out.filings[i] = r; else out.filings.push(r);
  }
  out.filings.sort(byDate);
  if (symbol) out.symbol = symbol;
  if (companyName) out.companyName = companyName;
  out.updatedAt = updatedAt;
  out.schema = SCHEMA;
  out.version = VERSION;
  return out;
}
/** write one company's file through writeJsonAtomic — the only JSON writer this repository allows */
function writeStore(dataRoot, store) {
  fs.mkdirSync(storeDir(dataRoot), { recursive: true });
  writeJsonAtomic(storePath(dataRoot, store.cik), store);
  return storePath(dataRoot, store.cik);
}

// ── the parse-layer run: saved filing text, no network ──────────────────────────────────────────────────────────────────────
/** read <dir>/filings.json and check every row before anything is parsed */
function readManifest(dir) {
  const file = path.join(dir, "filings.json");
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { throw new Error(`filing-wording: ${file} is missing — the folder must list its filings (see the header)`); }
  let list;
  try { list = JSON.parse(raw); } catch (e) { throw new Error(`filing-wording: ${file} is not JSON (${String(e.message).slice(0, 120)})`); }
  if (!Array.isArray(list) || !list.length) throw new Error(`filing-wording: ${file} must be a non-empty array of filings`);
  const problems = [];
  list.forEach((r, i) => {
    for (const k of ["cik", "form", "filingDate", "accession", "file"]) if (!r || !r[k]) problems.push(`row ${i}: ${k} is missing`);
    if (r && r.filingDate && !isDate(r.filingDate)) problems.push(`row ${i}: filingDate ${JSON.stringify(r.filingDate)} is not a date written YYYY-MM-DD`);
    if (r && r.form && !S.baseForm(r.form)) problems.push(`row ${i}: form ${JSON.stringify(r.form)} is not a 10-K or a 10-Q`);
    if (r && r.file && (path.isAbsolute(r.file) || r.file.split(/[\\/]/).includes(".."))) problems.push(`row ${i}: file ${JSON.stringify(r.file)} must be a name inside the folder`);
  });
  if (problems.length) throw new Error(`filing-wording: ${file} — ${problems.join("; ")}`);
  return list;
}
/**
 * The parse-layer run. Reads the saved text named by the manifest, scores it, and writes one file per company.
 *   runFromDir({ dir, dataRoot, dry, now, log }) -> { companies: [...], wrote: [...] }
 * It makes NO network call: there is no fetcher here to make one with.
 */
function runFromDir({ dir, dataRoot = DEFAULT_DATA, dry = false, now = () => new Date(), log = console.log } = {}) {
  const list = readManifest(dir);
  const byCik = new Map();
  for (const r of list) {
    const key = F.cik10(r.cik);
    if (!byCik.has(key)) byCik.set(key, []);
    byCik.get(key).push({ ...r, cik: key, text: fs.readFileSync(path.join(dir, r.file), "utf8") });
  }
  const updatedAt = now().toISOString();
  const companies = [], wrote = [];
  for (const [cik, filings] of [...byCik.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const got = collect(filings);
    const store = upsert(readStore(dataRoot, cik) || emptyStore(cik, got.symbol, got.companyName), got.rows, { updatedAt, symbol: got.symbol, companyName: got.companyName });
    companies.push({ cik, symbol: got.symbol, filings: got.rows.length, scored: got.rows.filter((r) => r.prev).length, rows: got.rows });
    log(`  ${cik}${got.symbol ? " " + got.symbol : ""}: ${got.rows.length} filing(s), ${got.rows.filter((r) => r.prev).length} with a previous filing of the same form`);
    for (const r of got.rows) log(`      ${r.filingDate}  ${String(r.form).padEnd(5)}  ${r.accession}  ${r.sectionsFound} section(s), ${r.sectionsScored} scored, overall ${r.overall === null ? "—  (first of its form)" : r.overall.toFixed(6)}${(r.warnings || []).length ? "   warning: " + r.warnings.join("; ") : ""}`);
    if (dry) log(`      --dry: ${storePath(dataRoot, cik)} would be written (${store.filings.length} filing(s) after the merge)`);
    else wrote.push(writeStore(dataRoot, store));
  }
  return { companies, wrote, dry };
}

// ── the fetch-layer run ────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * The fetch-layer run, over an INJECTED fetcher.
 *   runFetch({ ciks, fetcher, userAgent, forms, since, limit, dataRoot, dry, now, log, maxPerSecond, sleep, clock })
 * Every request goes through backend/lib/sec-fetch.js, so SEC's 10-a-second limit and the declared User-Agent hold for all of them.
 * A document that comes back 404 is recorded as missing and does not stop the run.
 */
async function runFetch({ ciks, fetcher, userAgent = process.env.SEC_USER_AGENT, forms = ["10-K", "10-Q"], since = null, limit = 0, includeOlder = false, dataRoot = DEFAULT_DATA, dry = false, now = () => new Date(), clock = Date.now, sleep = undefined, maxPerSecond = F.DEFAULT_MAX_PER_SECOND, log = console.log } = {}) {
  if (!Array.isArray(ciks) || !ciks.length) throw new Error("filing-wording: --fetch needs at least one CIK");
  const sec = F.makeSecFetcher({ fetcher, userAgent, maxPerSecond, now: clock, ...(sleep ? { sleep } : {}) });
  const updatedAt = now().toISOString();
  const out = [], wrote = [], missing = [];
  for (const cik of ciks) {
    const { sub, extra } = await F.fetchSubmissions(sec, cik, { includeOlder });
    let rows = F.listFilings(sub, { forms, since, extra });
    if (limit > 0) rows = rows.slice(-limit);
    log(`  CIK ${F.cik10(cik)}${sub && sub.name ? " " + sub.name : ""}: ${rows.length} filing(s) to read`);
    const filings = [];
    for (const r of rows) {
      const got = await F.fetchFilingText(sec, r);
      if (got.text === null) { missing.push(`${r.accession} (${r.url})`); log(`      ${r.filingDate}  ${r.form}  ${r.accession}  MISSING (404)`); continue; }
      filings.push({ ...r, text: got.text });
    }
    if (!filings.length) { log("      nothing to score"); continue; }
    const got = collect(filings);
    const store = upsert(readStore(dataRoot, cik) || emptyStore(cik, got.symbol, got.companyName), got.rows, { updatedAt, symbol: got.symbol, companyName: got.companyName });
    for (const r of got.rows) log(`      ${r.filingDate}  ${String(r.form).padEnd(5)}  ${r.accession}  ${r.sectionsFound} section(s), ${r.sectionsScored} scored, overall ${r.overall === null ? "—  (first of its form)" : r.overall.toFixed(6)}`);
    out.push({ cik: F.cik10(cik), filings: got.rows.length });
    if (dry) log(`      --dry: ${storePath(dataRoot, cik)} would be written`);
    else wrote.push(writeStore(dataRoot, store));
  }
  log(`  requests: ${sec.stats().requests} (${sec.stats().retries} retried) at no more than ${sec.limiter.maxPerSecond} a second`);
  return { companies: out, wrote, missing, stats: sec.stats(), dry };
}

// ── reading what was recorded ──────────────────────────────────────────────────────────────────────────────────────────────
function show(dataRoot, cik, log = console.log) {
  const st = readStore(dataRoot, cik);
  if (!st) { log(`nothing recorded for CIK ${F.cik10(cik)} at ${storePath(dataRoot, cik)}`); return false; }
  log(`${st.cik}${st.symbol ? " " + st.symbol : ""}${st.companyName ? " — " + st.companyName : ""}   ${st.filings.length} filing(s), updated ${st.updatedAt}`);
  for (const r of st.filings) {
    log(`  ${r.filingDate}  ${String(r.form).padEnd(5)}  ${r.accession}  vs ${r.prev ? `${r.prev.filingDate} (${r.prev.daysBefore} days earlier)` : "— first of its form"}  overall ${r.overall === null ? "—" : r.overall.toFixed(6)}`);
    for (const s of r.sections || []) log(`        ${s.id.padEnd(10)} ${s.cosine === null ? "    —    " : s.cosine.toFixed(6)}  ${String(s.words).padStart(6)} words${s.note ? "   (" + s.note + ")" : ""}  ${s.title}`);
  }
  return true;
}

// ── command line ───────────────────────────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { mode: null, dir: null, ciks: [], dataRoot: null, dry: false, forms: ["10-K", "10-Q"], since: null, limit: 0, includeOlder: false, show: null };
  const need = (i, flag) => { const v = argv[i]; if (v === undefined || /^--/.test(v)) throw new Error(`${flag} needs a value`); return v; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--selftest") out.mode = "selftest";
    else if (a === "--from-dir") { out.mode = "from-dir"; out.dir = need(++i, "--from-dir"); }
    else if (a === "--fetch") { out.mode = "fetch"; while (argv[i + 1] !== undefined && !/^--/.test(argv[i + 1])) out.ciks.push(argv[++i]); if (!out.ciks.length) throw new Error("--fetch needs at least one CIK"); }
    else if (a === "--show") { out.mode = "show"; out.show = need(++i, "--show"); }
    else if (a === "--data") out.dataRoot = need(++i, "--data");
    else if (a === "--forms") out.forms = need(++i, "--forms").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--since") out.since = need(++i, "--since");
    else if (a === "--limit") { out.limit = Number(need(++i, "--limit")); if (!Number.isInteger(out.limit) || out.limit < 0) throw new Error("--limit needs a whole number"); }
    else if (a === "--include-older") out.includeOlder = true;
    else if (a === "--dry") out.dry = true;
    else throw new Error(`unknown argument ${JSON.stringify(a)} — nothing was done`);
  }
  if (!out.mode) throw new Error("give one of --from-dir <folder> · --fetch <CIK …> · --show <CIK> · --selftest");
  if (out.since && !/^\d{4}-\d{2}-\d{2}$/.test(out.since)) throw new Error("--since needs a date YYYY-MM-DD");
  return out;
}

// ── selftest ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * A 10-K whose sections are set by the caller, so a check can state the answer it expects. The argument is a LIST of
 * [item, body] pairs, not an object: an object with the keys "1", "1B", "3" lists them as "1", "3", "1B" (JavaScript puts
 * integer-like keys first, in numeric order), which would write a fixture whose items are out of the form's order.
 */
function fixture10K(pairs) {
  if (!Array.isArray(pairs)) throw new Error("fixture10K takes a list of [item, body] pairs, in the form's order");
  const order = pairs.map(([it]) => S.K_ORDER.indexOf(it));
  if (order.some((i, k) => i < 0 || (k > 0 && i <= order[k - 1]))) throw new Error(`fixture10K: ${JSON.stringify(pairs.map((p) => p[0]))} is not a rising run of 10-K items`);
  return [
    "SAMPLE WIDGETS INC", "FORM 10-K", "", "TABLE OF CONTENTS", "",
    ...pairs.map(([it], i) => `Item ${it}. ${S.K_TITLES[it]} ${(i + 1) * 3}`), "", "PART I", "",
    ...pairs.flatMap(([it, body]) => [`Item ${it}. ${S.K_TITLES[it]}`, body, ""]),
    "SIGNATURES", "", "Signed by the registrant.",
  ].join("\n");
}
async function selftest() {
  let pass = 0, fail = 0;
  const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail === undefined ? "" : " — " + detail)); } };
  const threw = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };
  /** cosine written a second time, differently, so a mistake in the library's version does not agree with itself */
  function refCosine(a, b) {
    const wa = S.tokenize(a), wb = S.tokenize(b);
    if (!wa.length || !wb.length) return null;
    const vocab = [...new Set(wa.concat(wb))].sort();
    const vec = (ws) => vocab.map((v) => ws.reduce((n, w) => n + (w === v ? 1 : 0), 0));
    const x = vec(wa), y = vec(wb);
    const dot = x.reduce((s, v, i) => s + v * y[i], 0);
    const mag = (v) => Math.sqrt(v.reduce((s, u) => s + u * u, 0));
    return Math.round((dot / (mag(x) * mag(y))) * 1e6) / 1e6;
  }

  // two 10-Ks of one company, with the answers set in the text
  const BUSINESS = "We make widgets for the widget trade and we have done so for many years in many places around the world.";
  const LEGAL = "There are no material pending legal proceedings against the company or any of its subsidiaries at this time.";
  const K2024 = fixture10K([
    ["1", BUSINESS],
    ["1B", "alpha beta beta gamma"],
    ["3", LEGAL],
    ["7", "Revenue rose because we sold more widgets than we sold in the year before this one, at a better price."],
  ]);
  const K2025 = fixture10K([
    ["1", BUSINESS],
    ["1B", "beta gamma gamma delta"],
    ["3", LEGAL],
    ["7", "Demand fell sharply; every regional market shrank and our distributors cancelled most of their standing orders."],
  ]);
  ok("the fixtures themselves are built in the form's item order, and fixture10K refuses a list that is not",
    S.splitSections(K2024, { form: "10-K" }).found.join() === "item1,item1b,item3,item7" && threw(() => fixture10K([["3", "x"], ["1", "y"]]), /rising run/) && threw(() => fixture10K({ 1: "x" }), /list of \[item, body\] pairs/),
    S.splitSections(K2024, { form: "10-K" }).found.join());
  const filings = [
    { cik: "1", symbol: "ZZZZ", companyName: "SAMPLE WIDGETS INC", form: "10-K", filingDate: "2024-02-20", accession: "0000000001-24-000002", text: K2024 },
    { cik: "1", symbol: "ZZZZ", companyName: "SAMPLE WIDGETS INC", form: "10-K", filingDate: "2025-02-18", accession: "0000000001-25-000003", text: K2025 },
  ];
  const got = collect(filings);
  const r0 = got.rows[0], r1 = got.rows[1];
  const sec = (row, id) => (row.sections.find((s) => s.id === id) || {});

  ok("the first filing of a form has no previous one: prev null, every score null, and a note saying so — never a score of 0",
    r0.prev === null && r0.overall === null && r0.sections.length === 4 && r0.sections.every((s) => s.cosine === null && /no previous filing/.test(s.note)), JSON.stringify(r0.sections.map((s) => s.cosine)));
  ok("the second filing is compared with the first, and carries both dates and the gap between them",
    r1.filingDate === "2025-02-18" && r1.prev.accession === "0000000001-24-000002" && r1.prev.filingDate === "2024-02-20" && r1.prev.daysBefore === 364, JSON.stringify(r1.prev));
  // Item 1B by hand: {alpha:1, beta:2, gamma:1} against {beta:1, gamma:2, delta:1}
  //   dot = 2*1 + 1*2 = 4;  |a| = sqrt(1+4+1) = sqrt 6;  |b| = sqrt 6;  4/6 = 0.666667
  ok("Item 1B, whose two texts are 'alpha beta beta gamma' and 'beta gamma gamma delta', scores 4/6 = 0.666667",
    sec(r1, "item1b").cosine === 0.666667, String(sec(r1, "item1b").cosine));
  ok("a section re-filed word for word scores exactly 1 (Item 1 and Item 3 were not touched)", sec(r1, "item1").cosine === 1 && sec(r1, "item3").cosine === 1);
  ok("a section that was rewritten scores well below 1 (Item 7)", sec(r1, "item7").cosine !== null && sec(r1, "item7").cosine < 0.3, String(sec(r1, "item7").cosine));
  ok("every section's score equals a cosine computed a second way, from the two section texts alone",
    r1.sections.every((s) => s.cosine === refCosine(S.splitSections(K2025, { form: "10-K" }).sections.find((x) => x.id === s.id).text, S.splitSections(K2024, { form: "10-K" }).sections.find((x) => x.id === s.id).text)),
    JSON.stringify(r1.sections.map((s) => [s.id, s.cosine])));
  ok("the filing's overall score is the cosine over the shared sections joined together, and lies between the lowest and the highest section score",
    r1.overall === refCosine(["item1", "item1b", "item3", "item7"].map((id) => S.splitSections(K2025, { form: "10-K" }).sections.find((x) => x.id === id).text).join("\n"), ["item1", "item1b", "item3", "item7"].map((id) => S.splitSections(K2024, { form: "10-K" }).sections.find((x) => x.id === id).text).join("\n")) &&
    r1.overall > Math.min(...r1.sections.map((s) => s.cosine)) && r1.overall < Math.max(...r1.sections.map((s) => s.cosine)), String(r1.overall));
  ok("each section records how many words it and its predecessor had",
    sec(r1, "item1b").words === 4 && sec(r1, "item1b").prevWords === 4 && sec(r1, "item1").words === S.tokenize(BUSINESS).length && sec(r1, "item1").words === 21 && sec(r1, "item7").prevWords === S.tokenize(S.splitSections(K2024, { form: "10-K" }).sections.find((x) => x.id === "item7").text).length,
    JSON.stringify(r1.sections.map((s) => [s.id, s.words, s.prevWords])));
  ok("the filing's own text is recorded by sha256 and length, so a score can be traced back to the bytes it came from",
    r1.source.sha256 === require("crypto").createHash("sha256").update(K2025, "utf8").digest("hex") && r1.source.bytes === Buffer.byteLength(K2025, "utf8"));

  // a section that appears or disappears
  const K2026 = fixture10K([
    ["1", BUSINESS],
    ["1A", "Widgets may go out of fashion and our suppliers may raise their prices without any warning at all."],
    ["3", LEGAL],
  ]);
  const three = collect(filings.concat([{ cik: "1", symbol: "ZZZZ", form: "10-K", filingDate: "2026-02-17", accession: "0000000001-26-000004", text: K2026 }]));
  const r2 = three.rows[2];
  ok("a section the previous filing did not have is listed in onlyHere and scored null, not 0",
    r2.onlyHere.join() === "item1a" && sec(r2, "item1a").cosine === null && /previous filing has no such section/.test(sec(r2, "item1a").note), JSON.stringify([r2.onlyHere, sec(r2, "item1a").cosine]));
  ok("a section the previous filing had and this one does not is listed in onlyPrev", r2.onlyPrev.sort().join() === "item1b,item7", JSON.stringify(r2.onlyPrev));
  ok("the sections the two filings share are still scored", sec(r2, "item1").cosine === 1 && sec(r2, "item3").cosine === 1 && r2.sectionsScored === 2);

  // a 10-Q is compared with the 10-Q before it, never with a 10-K
  const Q = (risk) => ["SAMPLE WIDGETS INC", "FORM 10-Q", "", "PART I — FINANCIAL INFORMATION", "",
    "Item 1. Financial Statements", "The unaudited statements of the quarter are set out on the pages that follow this one.", "",
    "Item 2. Management's Discussion and Analysis of Financial Condition and Results of Operations", "Revenue for the quarter rose on stronger widget demand across every region that we serve.", "",
    "PART II — OTHER INFORMATION", "", "Item 1. Legal Proceedings", "Nothing material is pending against us.", "",
    "Item 1A. Risk Factors", risk, "", "SIGNATURES"].join("\n");
  const mixed = collect([
    { cik: "1", form: "10-Q", filingDate: "2024-05-06", accession: "0000000001-24-000006", text: Q("alpha beta beta gamma") },
    { cik: "1", form: "10-K", filingDate: "2025-02-18", accession: "0000000001-25-000003", text: K2025 },
    { cik: "1", form: "10-Q", filingDate: "2025-05-05", accession: "0000000001-25-000009", text: Q("beta gamma gamma delta") },
  ]);
  const q1 = mixed.rows[2];
  ok("the filings are read in filing-date order whatever order they arrive in", mixed.rows.map((r) => r.filingDate).join(",") === "2024-05-06,2025-02-18,2025-05-05");
  ok("a 10-Q's previous filing is the 10-Q before it, not the 10-K that was filed in between",
    q1.form === "10-Q" && q1.prev.accession === "0000000001-24-000006" && q1.prev.filingDate === "2024-05-06", JSON.stringify(q1.prev));
  ok("the 10-K in between is still scored against the 10-K before it", mixed.rows[1].prev === null && mixed.rows[1].form === "10-K");
  ok("a 10-Q's Part II Item 1A scores 4/6 against the same section of the previous 10-Q", sec(q1, "p2item1a").cosine === 0.666667 && sec(q1, "p1item1").cosine === 1, JSON.stringify(q1.sections.map((s) => [s.id, s.cosine])));
  ok("Part I Item 1 and Part II Item 1 stay apart in the record", q1.sections.filter((s) => s.id === "p1item1").length === 1 && q1.sections.filter((s) => s.id === "p2item1").length === 1);

  // a form this collector does not take
  const other = collect([{ cik: "1", form: "8-K", filingDate: "2025-03-02", accession: "0000000001-25-000005", text: "Item 1.01 Entry into a Material Definitive Agreement" }]);
  ok("a form that is not a 10-K or a 10-Q is recorded as skipped, with the reason, and never scored", other.rows[0].skipped === "form 8-K is not a 10-K or a 10-Q" && other.rows[0].sections === undefined);

  // the store
  {
    const base = emptyStore("1", "ZZZZ", "SAMPLE WIDGETS INC");
    const s1 = upsert(base, got.rows, { updatedAt: "2026-10-16T00:00:00.000Z" });
    const s2 = upsert(s1, got.rows, { updatedAt: "2026-10-16T00:00:00.000Z" });
    ok("writing the same rows twice changes nothing: the store is keyed by accession and re-running is idempotent",
      JSON.stringify(s1) === JSON.stringify(s2) && s1.filings.length === 2, `${s1.filings.length} / ${s2.filings.length}`);
    const s3 = upsert(s1, [{ accession: "0000000001-23-000001", form: "10-K", filingDate: "2023-02-21" }], { updatedAt: "2026-10-16T00:00:00.000Z" });
    ok("a filing inserted out of order lands in filing-date order", s3.filings.map((f) => f.filingDate).join(",") === "2023-02-21,2024-02-20,2025-02-18");
    const s4 = upsert(s1, [{ ...got.rows[1], overall: 0.5 }], { updatedAt: "2026-10-16T00:00:00.000Z" });
    ok("a filing already in the store is replaced, not added again", s4.filings.length === 2 && s4.filings[1].overall === 0.5);
    ok("the store names its schema and version, and carries the time it was written", s1.schema === "filing-wording-v1" && s1.version === VERSION && s1.updatedAt === "2026-10-16T00:00:00.000Z" && s1.cik === "0000000001");
  }

  // the command line
  ok("the command line refuses what it does not know, and needs a mode",
    threw(() => parseArgs(["--wat"]), /unknown argument/) && threw(() => parseArgs([]), /give one of/) && threw(() => parseArgs(["--from-dir"]), /needs a value/) &&
    threw(() => parseArgs(["--fetch"]), /at least one CIK/) && threw(() => parseArgs(["--since", "last year"]), /give one of/) && threw(() => parseArgs(["--show", "1", "--since", "nope"]), /YYYY-MM-DD/) &&
    threw(() => parseArgs(["--fetch", "1", "--limit", "-2"]), /whole number/));
  ok("the command line reads the forms it is given", (() => { const a = parseArgs(["--fetch", "320193", "789019", "--forms", "10-K", "--since", "2020-01-01", "--limit", "4", "--dry"]); return a.mode === "fetch" && a.ciks.join() === "320193,789019" && a.forms.join() === "10-K" && a.since === "2020-01-01" && a.limit === 4 && a.dry === true; })());

  // the fetch layer, over a fake EDGAR — no network
  {
    const SUB = { cik: "1", name: "SAMPLE WIDGETS INC", tickers: ["ZZZZ"], filings: { recent: { form: ["10-K", "10-K"], filingDate: ["2024-02-20", "2025-02-18"], reportDate: ["2023-12-31", "2024-12-31"], accessionNumber: ["0000000001-24-000002", "0000000001-25-000003"], primaryDocument: ["k2023.htm", "k2024.htm"] } } };
    const docs = {
      "https://data.sec.gov/submissions/CIK0000000001.json": JSON.stringify(SUB),
      "https://www.sec.gov/Archives/edgar/data/1/000000000124000002/k2023.htm": K2024,
      "https://www.sec.gov/Archives/edgar/data/1/000000000125000003/k2024.htm": K2025,
    };
    const asked = [];
    const clk = F.fakeClock();
    const fetcher = async (url) => { asked.push(url); return docs[url] === undefined ? { status: 404, headers: {}, text: "" } : { status: 200, headers: {}, text: docs[url] }; };
    const res = await runFetch({ ciks: ["1"], fetcher, userAgent: "TRAIDS research collector (contact in the server environment)", dry: true, now: () => new Date("2026-10-16T00:00:00Z"), clock: clk.now, sleep: clk.sleep, log: () => { } });
    ok("the fetch layer reads the submissions document and then each filing, three requests in all, and scores them the same way the parse layer does",
      asked.length === 3 && res.stats.requests === 3 && res.companies[0].filings === 2 && res.dry === true && res.wrote.length === 0, JSON.stringify(asked));
    let why = null;
    await runFetch({ ciks: ["1"], fetcher, userAgent: "", log: () => { } }).catch((e) => { why = e.message; });
    ok("the fetch layer refuses to run without a declared User-Agent, before any request is made", /User-Agent/.test(why || "") && asked.length === 3, String(why));
    let why2 = null;
    await runFetch({ ciks: [], fetcher, userAgent: "TRAIDS research collector (contact in the server environment)", log: () => { } }).catch((e) => { why2 = e.message; });
    ok("--fetch with no CIK is refused", /at least one CIK/.test(why2 || ""));
    const missing = await runFetch({ ciks: ["1"], fetcher: async (url) => (url.endsWith("k2024.htm") ? { status: 404, headers: {}, text: "" } : { status: 200, headers: {}, text: docs[url] }), userAgent: "TRAIDS research collector (contact in the server environment)", dry: true, clock: F.fakeClock().now, sleep: async () => { }, log: () => { } });
    ok("a document that is not there is recorded as missing and does not stop the run", missing.missing.length === 1 && /0000000001-25-000003/.test(missing.missing[0]) && missing.companies[0].filings === 1, JSON.stringify(missing.missing));
  }

  // what this collector must never do
  {
    // the CODE of this file: its own selftest and its block comments are not code, and they name the very words being looked for
    const whole = fs.readFileSync(__filename, "utf8");
    const code = whole.replace(/\nasync function selftest\(\) \{[\s\S]*?\n\}\n/, "\n").replace(/\/\*[\s\S]*?\*\//g, "");
    ok("the scan really did cut the selftest out, and what is left is still the working code", code.length > 4000 && code.length < whole.length - 4000 && /function collect\(/.test(code) && !/alpha beta beta gamma/.test(code), `${whole.length} -> ${code.length} characters`);
    ok("this collector registers no test and writes no registry", !/register-test|registerTest|test-registry|read-seals|change-registry|agent-ledger/.test(code));
    ok("this collector places no order and starts nothing", !/alpaca|broker|placeOrder|submitOrder|schtasks|systemctl|close-chain/i.test(code));
    ok("JSON is written only through writeJsonAtomic, and the code writes no file any other way", /writeJsonAtomic/.test(code) && (code.match(/writeFileSync|appendFileSync|createWriteStream|writeTextAtomic/g) || []).length === 0);
    ok("no key, token or address is built in", !/api[_-]?key|secret|password|@[a-z0-9-]+\.(?:com|net|org)/i.test(code.replace(/SEC_USER_AGENT/g, "")));
  }

  console.log(`filing-wording-collector selftest: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASSED" : "FAILED"}`);
  return fail === 0;
}

module.exports = {
  SCHEMA, VERSION, DEFAULT_DATA, storeDir, storePath, sha256,
  parseFiling, score, collect, byDate, daysBetween, isDate,
  emptyStore, readStore, upsert, writeStore, readManifest,
  runFromDir, runFetch, show, parseArgs, fixture10K, selftest,
};

if (require.main === module) {
  let A = null;
  try { A = parseArgs(process.argv.slice(2)); } catch (e) { console.error("filing-wording-collector: " + e.message); process.exitCode = 2; }
  if (A) {
    const go = async () => {
      if (A.mode === "selftest") return (await selftest()) ? 0 : 1;
      if (A.mode === "show") return show(A.dataRoot || DEFAULT_DATA, A.show) ? 0 : 1;
      if (A.mode === "from-dir") {
        console.log(`filing wording — the parse layer on saved text in ${A.dir}${A.dry ? " (--dry)" : ""}`);
        const r = runFromDir({ dir: A.dir, dataRoot: A.dataRoot || DEFAULT_DATA, dry: A.dry });
        console.log(r.dry ? "  --dry: nothing was written" : `  wrote ${r.wrote.length} file(s): ${r.wrote.join(", ")}`);
        return 0;
      }
      console.log(`filing wording — the fetch layer for ${A.ciks.join(", ")}${A.dry ? " (--dry)" : ""}`);
      const r = await runFetch({ ciks: A.ciks, fetcher: F.nodeFetcher(), forms: A.forms, since: A.since, limit: A.limit, includeOlder: A.includeOlder, dataRoot: A.dataRoot || DEFAULT_DATA, dry: A.dry });
      console.log(r.dry ? "  --dry: nothing was written" : `  wrote ${r.wrote.length} file(s): ${r.wrote.join(", ")}`);
      if (r.missing.length) console.log(`  missing document(s): ${r.missing.join(", ")}`);
      return 0;
    };
    go().then((code) => { process.exitCode = code; }, (e) => { console.error("filing-wording-collector: " + (e && e.stack ? e.stack : e)); process.exitCode = 1; });
  }
}
