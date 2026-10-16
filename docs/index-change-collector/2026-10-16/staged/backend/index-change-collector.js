#!/usr/bin/env node
"use strict";
/**
 * INDEX CHANGE COLLECTOR — backlog row 14, the first forced-flow collector. 2026-10-16.
 *
 * Records announced S&P 500 / MidCap 400 / SmallCap 600 and Nasdaq-100 ADDITIONS and DELETIONS, each
 * with its ANNOUNCEMENT date and its EFFECTIVE date, to a dated JSONL under
 * backend/data/index-changes/.
 *
 * It collects. It scores nothing, trades nothing, sends no order, and registers no test.
 *
 * ═══ THE THREE LAYERS, AND WHY THEY ARE THREE ═══
 *
 *   backend/lib/index-changes.js        PARSE: saved page text -> rows. No fs, no network, no clock.
 *                                       Every rule is provable on a saved page.
 *   backend/lib/index-changes-fetch.js  FETCH: text -> rows with provenance, through an INJECTED
 *                                       fetcher. It holds no network client at all.
 *   this file                           WIRING: builds a fetcher (saved directory, or the network when
 *                                       explicitly asked), writes the dated JSONL, prints the plan.
 *
 * So a test of the collection logic reaches no network because there is nothing in those two layers to
 * reach it with (AGENTS.md: tests make no network calls of any kind).
 *
 * ═══ THE TWO DATES ═══
 *
 * Every row carries `announced` and `effective` as separate blocks, plus `knownAt` (a labelled copy of
 * `announced`). There is no scalar `date` field. backend/lib/index-changes.js states the invariant and
 * the four mechanics that hold it; `--audit` runs the guard over a file that has already been written.
 *
 * ═══ USAGE ═══
 *
 *   node backend/index-change-collector.js --dir docs/.../fixtures/pages --dry
 *       READ-ONLY. Reads saved pages named by that directory's sources.json, prints every row it would
 *       write and every row it refused, writes nothing. This is the mode a cloud session runs.
 *
 *   node backend/index-change-collector.js --dir <saved pages>
 *       the same, and writes backend/data/index-changes/index-changes-<today>.jsonl
 *
 *   node backend/index-change-collector.js --network [--dry]
 *       fetches DEFAULT_SOURCES over https (global fetch), strips the HTML to text and goes on as
 *       above. Never the default: without --network or --dir the command refuses and says so.
 *
 *   node backend/index-change-collector.js --audit [--date YYYY-MM-DD]
 *       reads a written JSONL back and runs auditSeparation() over it: the announcement/effective
 *       separation, the row shape, and the counts a later reader must decide about.
 *
 *   node backend/index-change-collector.js --selftest
 *       known-answer checks on page text held in this file. Ends with "ALL n CHECKS PASSED".
 *
 *   --date YYYY-MM-DD   the collection date (the file name and the collectedAt stamp). Today in UTC
 *                       when omitted. An explicit date makes a run reproducible.
 *   --out <dir>         where the JSONL goes. backend/data/index-changes when omitted.
 *   --indexes A,B       keep only these indexes (SP500, SP400, SP600, NDX100).
 *
 * ═══ WHAT IS WRITTEN ═══
 *
 *   <out>/index-changes-<collection date>.jsonl   one JSON row per line, APPEND-ONLY: a row already on
 *        file (same index, action, symbol, announcement, effective and source) is reported as "already
 *        on file" and not written twice, so running twice in a day leaves one copy. Written through
 *        backend/lib/atomic-write.js (writeTextAtomic), never by shell redirection.
 *   <out>/index-changes-<collection date>.pages.json   the provenance of the run: every source, its
 *        sha256, byte length and fetch time, the counts, the problems, and every refused row with its
 *        reason. Written through writeJsonAtomic.
 *
 * A row's `collectedAt` is the run's stamp. It is NOT a knowledge date: `knownAt` is, and it reads the
 * announcement. --audit fails a row whose collectedAt precedes its announcement, which cannot happen.
 */
const fs = require("fs"), path = require("path");
const IC = require("./lib/index-changes.js");
const FETCH = require("./lib/index-changes-fetch.js");
const { writeJsonAtomic, writeTextAtomic } = require("./lib/atomic-write.js");

const REPO = path.resolve(__dirname, "..");
const OUT_DEFAULT = path.join(__dirname, "data", "index-changes");
const MANIFEST = "sources.json";
const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/* ════════════════════════════ html -> text ════════════════════════════ */

const ENTITIES = Object.freeze({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", reg: "®", trade: "™", middot: "·", bull: "•" });

/**
 * An announcement page as served -> the text the parse layer reads. The one thing it must get right is
 * the CELL BOUNDARY: a table cell end becomes two spaces, because the parse layer splits a table row on
 * two or more spaces. A cell end collapsed to one space would merge a company name into its ticker.
 */
function htmlToText(html) {
  let s = String(html == null ? "" : html);
  s = s.replace(/\r\n?/g, "\n");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(/<\/(?:td|th)\s*>/gi, "  ");
  s = s.replace(/<\/(?:p|div|tr|li|h[1-6]|table|thead|tbody|section|article|header|footer|blockquote)\s*>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&#(\d{1,6});/g, (_, n) => { const c = +n; return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : " "; });
  s = s.replace(/&#x([0-9a-f]{1,5});/gi, (_, n) => { const c = parseInt(n, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : " "; });
  s = s.replace(/&([a-z]+);/gi, (m0, n) => (Object.prototype.hasOwnProperty.call(ENTITIES, n.toLowerCase()) ? ENTITIES[n.toLowerCase()] : m0));
  s = s.replace(/ /g, " ");
  s = s.split("\n").map((l) => l.replace(/[ \t]+$/, "").replace(/^[ \t]+/, "")).join("\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim() + "\n";
}

/* ════════════════════════════ fetchers ════════════════════════════ */

/**
 * The saved-page fetcher: a directory holding page text and a sources.json manifest
 *   [{ "name": "...", "url": "...", "file": "page.txt", "indexes": ["SP500"], "announced": { "iso": "..." } }]
 * A .html file is run through htmlToText; a .txt file is read as it is.
 * -> { sources, fetcher, files } with `file` stripped from each source (the fetch layer refuses unknown fields).
 */
function savedPages(dir) {
  const mf = path.join(dir, MANIFEST);
  if (!fs.existsSync(mf)) throw new Error(`no ${MANIFEST} in ${dir} — the manifest says which file is which announcement page`);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(mf, "utf8")); } catch (e) { throw new Error(`${mf} is not JSON: ${e.message}`); }
  if (!Array.isArray(manifest) || !manifest.length) throw new Error(`${mf} is not a non-empty array of sources`);
  const byUrl = {}, sources = [], files = [];
  for (const [i, m] of manifest.entries()) {
    if (!m || !m.file) throw new Error(`${MANIFEST}[${i}] has no "file"`);
    const p = path.join(dir, m.file);
    if (!fs.existsSync(p)) throw new Error(`${MANIFEST}[${i}] names ${m.file}, which is not in ${dir}`);
    const raw = fs.readFileSync(p, "utf8");
    const text = /\.html?$/i.test(m.file) ? htmlToText(raw) : raw;
    const url = m.url || `file:${m.file}`;
    byUrl[url] = text;
    files.push({ file: m.file, url, bytes: Buffer.byteLength(text, "utf8"), html: /\.html?$/i.test(m.file) });
    const src = { name: m.name || m.file, url };
    if (m.indexes) src.indexes = m.indexes;
    if (m.announced) src.announced = m.announced;
    if (m.note) src.note = m.note;
    sources.push(src);
  }
  return { sources, fetcher: FETCH.textFetcher(byUrl), files };
}

/**
 * The network fetcher. Built only under --network, lives only here, and is the ONLY code in this change
 * that can open a socket. 20s timeout, one try, no retry loop, no cookie, no key: these are public
 * pages. A non-2xx comes back ok:false and the run goes on with the other sources.
 */
function networkFetcher({ timeoutMs = 20000 } = {}) {
  return async (url) => {
    try {
      const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { accept: "text/html,text/plain" } });
      const body = await r.text();
      const ct = String(r.headers.get("content-type") || "");
      const text = /html/i.test(ct) || /^\s*<(?:!doctype|html)/i.test(body) ? htmlToText(body) : body;
      return { ok: r.ok, status: r.status, text, finalUrl: r.url || url };
    } catch (e) {
      return { ok: false, status: null, text: "", error: String(e && e.message ? e.message : e).slice(0, 200) };
    }
  };
}

/* ════════════════════════════ the file ════════════════════════════ */

const jsonlPath = (outDir, date) => path.join(outDir, `index-changes-${date}.jsonl`);
const pagesPath = (outDir, date) => path.join(outDir, `index-changes-${date}.pages.json`);

/** the rows already on file -> { rows, problems }. A line that is not a row is a problem, never ignored. */
function readJsonl(file) {
  if (!fs.existsSync(file)) return { rows: [], problems: [], existed: false };
  const rows = [], problems = [];
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    let o; try { o = JSON.parse(l); } catch (e) { problems.push(`${path.basename(file)} line ${i + 1} is not JSON: ${e.message}`); return; }
    if (!o || o.schema !== IC.SCHEMA) { problems.push(`${path.basename(file)} line ${i + 1} is not a ${IC.SCHEMA} row`); return; }
    rows.push(o);
  });
  return { rows, problems, existed: true };
}

/** the row as it goes on file: schema, then the run's stamp, then the row. collectedAt is NOT a knowledge date. */
function withCollected(row, collectedAt) {
  const { schema, ...rest } = row;
  return { schema, collectedAt, ...rest };
}

/**
 * The whole run, on injected parts so the package selftest drives it with no disk and no network:
 *   collectRun({ sources, fetcher, now, outDir, date, wantIndexes })
 * -> { date, file, pagesFile, existing, added, already, rows, pages, problems, skipped, counts, audit }
 * It WRITES NOTHING. The caller decides (plan vs write).
 */
async function collectRun({ sources, fetcher, now = () => Date.now(), outDir = OUT_DEFAULT, date = null, wantIndexes = null } = {}) {
  const ms = now();
  const day = date || utcDate(ms);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !IC.parseDateLoose(day)) throw new Error(`index-change-collector: --date "${day}" is not a date`);
  const want = Array.isArray(wantIndexes) && wantIndexes.length ? wantIndexes : null;
  const srcs = want ? sources.map((s) => ({ ...s, indexes: (s.indexes || IC.INDEXES).filter((x) => want.includes(x)) })).filter((s) => s.indexes.length) : sources;
  if (want && !srcs.length) throw new Error(`index-change-collector: no source covers ${want.join(", ")}`);

  const got = await FETCH.collect({ sources: srcs, fetcher, now });
  const collectedAt = new Date(ms).toISOString();
  const incoming = got.rows.map((r) => withCollected(r, collectedAt));

  const file = jsonlPath(outDir, day), pagesFile = pagesPath(outDir, day);
  const on = readJsonl(file);
  const merged = IC.mergeRows(on.rows, incoming);
  const problems = [...got.problems, ...on.problems];
  const audit = IC.auditSeparation(merged.rows);
  for (const p of audit.problems) problems.push(`audit: ${p}`);
  for (const r of merged.rows) if (r.collectedAt && r.announced && r.announced.iso && r.collectedAt.slice(0, 10) < r.announced.iso) problems.push(`audit: ${r.symbol} was collected ${r.collectedAt.slice(0, 10)}, before it was announced ${r.announced.iso}`);

  return { date: day, collectedAt, file, pagesFile, existingCount: on.rows.length, existed: on.existed, added: merged.added, already: merged.already, rows: merged.rows, pages: got.pages, problems, skipped: got.skipped, counts: got.counts, audit };
}

/** the sidecar: what was read, from where, and what was refused */
function pagesRecord(run, sources) {
  return {
    schema: "index-change-pages/1",
    collectedAt: run.collectedAt,
    collectionDate: run.date,
    jsonl: path.relative(REPO, run.file).split(path.sep).join("/"),
    sources: sources.map((s) => ({ name: s.name, url: s.url, indexes: s.indexes || null, announcedSupplied: s.announced ? s.announced.iso : null, note: s.note || null })),
    pages: run.pages,
    counts: { ...run.counts, onFileBefore: run.existingCount, added: run.added.length, alreadyOnFile: run.already.length, onFileAfter: run.rows.length },
    audit: { ok: run.audit.ok, checked: run.audit.checked, counts: run.audit.counts, problems: run.audit.problems },
    problems: run.problems,
    skipped: run.skipped,
  };
}

/* ════════════════════════════ printing ════════════════════════════ */

const pad = (s, n) => String(s == null ? "" : s).padEnd(n);

function printRun(run, { dry }) {
  console.log(`\n  sources read: ${run.counts.pagesOk}/${run.counts.sources}`);
  for (const p of run.pages) console.log(`    ${p.ok ? "ok  " : "BAD "} ${pad(p.name, 30)} ${p.ok ? `${pad(p.rows + " row(s)", 12)} announced ${p.announced ? p.announced.iso + " (" + p.announced.basis + ")" : "—"}  sha ${String(p.sha256).slice(0, 12)}  ${p.bytes} bytes` : p.problems.join("; ")}`);
  console.log(`\n  rows ${dry ? "that WOULD be written" : "written"}: ${run.added.length} new, ${run.already.length} already on file, ${run.existingCount} on file before`);
  if (run.added.length) {
    console.log(`    ${pad("index", 7)} ${pad("action", 7)} ${pad("symbol", 8)} ${pad("announced", 11)} ${pad("effective", 11)} ${pad("timing", 14)} ${pad("reason", 12)} company`);
    for (const r of run.added) console.log(`    ${pad(r.index, 7)} ${pad(r.action, 7)} ${pad(r.symbol, 8)} ${pad(r.announced.iso, 11)} ${pad(r.effective.iso || "(none)", 11)} ${pad(r.effective.timing || "—", 14)} ${pad(r.reason || "—", 12)} ${r.company || "—"}${r.flags.length ? "   flags: " + r.flags.join(",") : ""}`);
  }
  if (run.skipped.length) {
    console.log(`\n  refused ${run.skipped.length} row(s) — counted, never silent:`);
    const by = {};
    for (const s of run.skipped) by[s.reason] = (by[s.reason] || 0) + 1;
    for (const [k, v] of Object.entries(by).sort()) console.log(`    ${pad(k, 22)} ${v}`);
    for (const s of run.skipped.slice(0, 12)) console.log(`      ${pad(s.source || "", 24)} ${pad(s.reason, 20)} ${s.detail || ""}`);
    if (run.skipped.length > 12) console.log(`      … ${run.skipped.length - 12} more in the sidecar`);
  }
  const c = run.audit.counts;
  console.log(`\n  the two dates, over all ${run.audit.checked} row(s) on file: ${run.audit.ok ? "separate and sound" : "PROBLEMS — see below"}`);
  console.log(`    no effective date yet ${c.noEffectiveDate} · effective = announcement day ${c.effectiveSameDay} · effective BEFORE announcement ${c.effectiveBeforeAnnounced} (flagged) · announcement clock time known ${c.withTime}`);
  if (run.problems.length) { console.log(`\n  problems (${run.problems.length}):`); for (const p of run.problems) console.log(`    - ${p}`); }
}

/* ════════════════════════════ selftest ════════════════════════════ */

const SELFTEST_PAGE = [
  "S&P Dow Jones Indices Announces Changes to the S&P 500 and S&P MidCap 400",
  "",
  "NEW YORK, September 5, 2026: S&P Dow Jones Indices will make the following changes effective prior to the open of trading on Monday, September 22, 2026:",
  "",
  "Effective Date  Index Name      Action    Company Name        Ticker  GICS Sector",
  "09/22/2026      S&P 500         Addition  Zeta Example Corp   ZETA    Information Technology",
  "09/22/2026      S&P 500         Deletion  Omicron Example Co  OMIC    Industrials",
  "09/22/2026      S&P MidCap 400  Addition  Omicron Example Co  OMIC    Industrials",
  "09/22/2026      S&P 500 ESG     Addition  Theta Example Inc   THET    Utilities",
  "",
  "Omicron Example Co is moving from the S&P 500 to the S&P MidCap 400.",
  "",
].join("\n");

/** the one page whose only dates are EFFECTIVE dates: it must produce nothing at all */
const SELFTEST_NO_ANNOUNCED = [
  "Index Changes",
  "",
  "Effective Date  Index Name  Action    Company Name       Ticker",
  "10/07/2026      S&P 500     Addition  Gamma Example Inc  GAMM",
  "",
].join("\n");

async function selftest() {
  const checks = [];
  const ok = (name, cond, got) => checks.push({ name, pass: !!cond, got });
  const src = { name: "selftest", url: "file:selftest", fetchedAt: "2026-10-16T00:00:00.000Z", sha256: "0".repeat(64), bytes: SELFTEST_PAGE.length };

  const p = IC.parsePage({ text: SELFTEST_PAGE, source: src });
  ok("the table gives 3 rows (the S&P 500 ESG row is refused)", p.rows.length === 3, p.rows.length);
  ok("the announcement date is the dateline, not the effective date in the same sentence", p.release.announced && p.release.announced.iso === "2026-09-05" && p.release.announced.basis === "dateline", p.release.announced);
  const zeta = p.rows.find((r) => r.symbol === "ZETA");
  ok("ZETA: add to SP500, announced 2026-09-05, effective 2026-09-22 prior-to-open", zeta && zeta.action === "add" && zeta.index === "SP500" && zeta.announced.iso === "2026-09-05" && zeta.effective.iso === "2026-09-22" && zeta.effective.timing === "prior-to-open", zeta && [zeta.action, zeta.index, zeta.announced.iso, zeta.effective.iso, zeta.effective.timing]);
  ok("ZETA: knownAt reads the announcement, with basis \"announced\"", zeta && zeta.knownAt.iso === "2026-09-05" && zeta.knownAt.basis === "announced", zeta && zeta.knownAt);
  ok("no row carries a scalar date key", p.rows.every((r) => !["date", "announcedDate", "effectiveDate"].some((k) => k in r)), Object.keys(p.rows[0] || {}).join(","));
  ok("the S&P 500 ESG row is refused as unknown-index", p.skipped.some((s) => s.reason === "unknown-index" && /ESG/.test(s.detail)), p.skipped.map((s) => s.reason));
  ok("OMIC leaves the S&P 500 and joins the S&P MidCap 400", p.rows.filter((r) => r.symbol === "OMIC").length === 2 && p.rows.some((r) => r.symbol === "OMIC" && r.index === "SP500" && r.action === "delete") && p.rows.some((r) => r.symbol === "OMIC" && r.index === "SP400" && r.action === "add"), p.rows.filter((r) => r.symbol === "OMIC").map((r) => `${r.index}:${r.action}`));

  const none = IC.parsePage({ text: SELFTEST_NO_ANNOUNCED, source: src });
  ok("a page whose only dates are effective dates produces NO rows", none.rows.length === 0, none.rows.length);
  ok("and says why: no-announcement-date", none.skipped.length === 1 && none.skipped[0].reason === "no-announcement-date", none.skipped);

  ok("visibleAsOf hides a row the day before it was announced", IC.visibleAsOf(p.rows, "2026-09-04").length === 0, IC.visibleAsOf(p.rows, "2026-09-04").length);
  ok("visibleAsOf hides a row on its own announcement day by default", IC.visibleAsOf(p.rows, "2026-09-05").length === 0, IC.visibleAsOf(p.rows, "2026-09-05").length);
  ok("visibleAsOf shows it the next day", IC.visibleAsOf(p.rows, "2026-09-06").length === 3, IC.visibleAsOf(p.rows, "2026-09-06").length);
  ok("visibleAsOf never shows a row because of its EFFECTIVE date", IC.visibleAsOf(p.rows, "2026-09-22", { sameDay: "include" }).length === 3 && IC.visibleAsOf(p.rows, "2026-09-04", { sameDay: "include" }).length === 0, "ok");
  ok("effectiveOn refuses to run without an explicit asOf", (() => { try { IC.effectiveOn(p.rows, "2026-09-22"); return false; } catch { return true; } })(), "threw");
  ok("effectiveOn with asOf = the day after the announcement finds all 3", IC.effectiveOn(p.rows, "2026-09-22", { asOf: "2026-09-06" }).length === 3, IC.effectiveOn(p.rows, "2026-09-22", { asOf: "2026-09-06" }).length);
  ok("effectiveOn with asOf before the announcement finds none", IC.effectiveOn(p.rows, "2026-09-22", { asOf: "2026-09-04" }).length === 0, "ok");
  ok("auditSeparation passes the parsed rows", IC.auditSeparation(p.rows).ok, IC.auditSeparation(p.rows).problems);
  ok("auditSeparation fails a row that grows a scalar date key", !IC.auditSeparation([{ ...p.rows[0], date: "2026-09-22" }]).ok, "ok");

  const f = FETCH.textFetcher({ "file:selftest": SELFTEST_PAGE });
  const got = await FETCH.collect({ sources: [{ name: "selftest", url: "file:selftest" }], fetcher: f, now: () => Date.parse("2026-10-16T12:00:00Z") });
  ok("the fetch layer gives the same 3 rows with provenance", got.rows.length === 3 && got.pages[0].sha256.length === 64 && got.rows.every((r) => r.source.name === "selftest"), got.rows.length);
  ok("the fetch layer throws without an injected fetcher", await (async () => { try { await FETCH.collect({ sources: [{ name: "x", url: "file:x" }] }); return false; } catch { return true; } })(), "threw");
  ok("re-collecting the same page adds nothing", IC.mergeRows(got.rows, got.rows).added.length === 0, "ok");

  const t = htmlToText("<table><tr><td>Zeta Example Corp</td><td>ZETA</td></tr></table>");
  ok("htmlToText keeps the cell boundary (two spaces)", /Zeta Example Corp {2}ZETA/.test(t), JSON.stringify(t));
  ok("htmlToText decodes S&amp;P", htmlToText("<p>S&amp;P 500</p>").trim() === "S&P 500", JSON.stringify(htmlToText("<p>S&amp;P 500</p>")));

  const bad = checks.filter((c) => !c.pass);
  for (const c of checks) console.log(`  ${c.pass ? "ok  " : "FAIL"} ${c.name}${c.pass ? "" : `   got: ${JSON.stringify(c.got)}`}`);
  if (bad.length) { console.log(`\n${bad.length} of ${checks.length} CHECKS FAILED`); return 1; }
  console.log(`\nALL ${checks.length} CHECKS PASSED`);
  return 0;
}

/* ════════════════════════════ cli ════════════════════════════ */

function parseArgs(argv) {
  const a = { dir: null, network: false, dry: false, audit: false, selftest: false, date: null, out: null, indexes: null, bad: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--dry" || x === "--plan") a.dry = true;
    else if (x === "--network") a.network = true;
    else if (x === "--audit") a.audit = true;
    else if (x === "--selftest") a.selftest = true;
    else if (x === "--dir") a.dir = argv[++i] || null;
    else if (x === "--date") a.date = argv[++i] || null;
    else if (x === "--out") a.out = argv[++i] || null;
    else if (x === "--indexes") a.indexes = String(argv[++i] || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    else a.bad.push(x);
  }
  return a;
}

const USAGE = [
  "usage: node backend/index-change-collector.js <mode> [options]",
  "  --dir <path>        read saved announcement pages named by <path>/sources.json (no network)",
  "  --network           fetch DEFAULT_SOURCES over https (the only mode that opens a socket)",
  "  --audit             read a written JSONL back and check the announcement/effective separation",
  "  --selftest          known-answer checks on page text held in this file",
  "  --dry | --plan      read-only: print every row that would be written, write nothing",
  "  --date YYYY-MM-DD   the collection date (file name and collectedAt). Today in UTC when omitted.",
  "  --out <dir>         where the JSONL goes (default backend/data/index-changes)",
  "  --indexes A,B       keep only these: " + IC.INDEXES.join(", "),
  "One of --dir, --network, --audit or --selftest is required: there is no default that reaches the network.",
].join("\n");

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.bad.length) { console.error(`unknown argument(s): ${a.bad.join(" ")}\n${USAGE}\nNothing was done.`); return 2; }
  const modes = [a.dir ? "--dir" : null, a.network ? "--network" : null, a.audit ? "--audit" : null, a.selftest ? "--selftest" : null].filter(Boolean);
  if (modes.length !== 1) { console.error(`${modes.length ? "exactly one mode at a time, not " + modes.join(" + ") : "no mode given"}\n${USAGE}\nNothing was done.`); return 2; }
  if (a.indexes) { const bad = a.indexes.filter((x) => !IC.INDEXES.includes(x)); if (bad.length) { console.error(`--indexes: ${bad.join(", ")} is not one of ${IC.INDEXES.join(", ")}\nNothing was done.`); return 2; } }
  const outDir = a.out ? path.resolve(a.out) : OUT_DEFAULT;

  if (a.selftest) return await selftest();

  if (a.audit) {
    const day = a.date || utcDate(Date.now());
    const file = jsonlPath(outDir, day);
    const on = readJsonl(file);
    if (!on.existed) { console.error(`AUDIT: ${path.relative(REPO, file)} is not there. Nothing was done.`); return 2; }
    const au = IC.auditSeparation(on.rows);
    console.log(`AUDIT — ${path.relative(REPO, file).split(path.sep).join("/")} — ${on.rows.length} row(s)`);
    const c = au.counts;
    console.log(`  no effective date yet ${c.noEffectiveDate} · effective = announcement day ${c.effectiveSameDay} · effective BEFORE announcement ${c.effectiveBeforeAnnounced} (flagged) · announcement clock time known ${c.withTime}`);
    const byIndex = {}, byAction = {};
    for (const r of on.rows) { byIndex[r.index] = (byIndex[r.index] || 0) + 1; byAction[r.action] = (byAction[r.action] || 0) + 1; }
    console.log(`  by index: ${Object.entries(byIndex).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}`);
    console.log(`  by action: ${Object.entries(byAction).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}`);
    const all = [...on.problems, ...au.problems];
    if (all.length) { console.error(`  PROBLEMS (${all.length}):`); for (const p of all) console.error(`    - ${p}`); console.error("AUDIT FAILED."); return 1; }
    console.log("  the announcement date and the effective date are separate on every row, and every row is knowable at a stated time.");
    console.log("AUDIT PASSED.");
    return 0;
  }

  let sources, fetcher;
  if (a.dir) {
    const dir = path.resolve(a.dir);
    if (!fs.existsSync(dir)) { console.error(`--dir ${dir} is not there. Nothing was done.`); return 2; }
    try { ({ sources, fetcher } = savedPages(dir)); } catch (e) { console.error(`--dir: ${e.message}\nNothing was done.`); return 2; }
    console.log(`INDEX CHANGE COLLECTOR — saved pages from ${path.relative(REPO, dir).split(path.sep).join("/")} (no network)${a.dry ? " — DRY RUN, nothing is written" : ""}`);
  } else {
    sources = FETCH.DEFAULT_SOURCES.map((s) => ({ ...s, indexes: s.indexes.slice() }));
    fetcher = networkFetcher();
    console.log(`INDEX CHANGE COLLECTOR — ${sources.length} public announcement page(s) over https${a.dry ? " — DRY RUN, nothing is written" : ""}`);
  }

  let run;
  try { run = await collectRun({ sources, fetcher, outDir, date: a.date, wantIndexes: a.indexes }); } catch (e) { console.error(`FAILED: ${e.message}\nNothing was written.`); return 1; }
  console.log(`  collection date ${run.date}   file ${path.relative(REPO, run.file).split(path.sep).join("/")}`);
  printRun(run, { dry: a.dry });

  if (a.dry) { console.log(`\nDRY RUN — nothing was written. ${run.added.length} row(s) would be added to ${path.relative(REPO, run.file).split(path.sep).join("/")}.`); return run.problems.length ? 1 : 0; }
  if (!run.audit.ok) { console.error("\nREFUSED: the separation audit did not pass, so nothing was written. Read the problems above."); return 2; }
  fs.mkdirSync(outDir, { recursive: true });
  if (run.added.length || !run.existed) writeTextAtomic(run.file, run.rows.map((r) => JSON.stringify(r)).join("\n") + (run.rows.length ? "\n" : ""));
  writeJsonAtomic(run.pagesPath || run.pagesFile, pagesRecord(run, sources));
  console.log(`\nWROTE ${run.added.length} new row(s) to ${path.relative(REPO, run.file).split(path.sep).join("/")} (${run.rows.length} on file) and the provenance to ${path.basename(run.pagesFile)}.`);
  console.log(`  next: node backend/index-change-collector.js --audit --date ${run.date}`);
  return run.problems.length ? 1 : 0;
}

module.exports = { htmlToText, savedPages, networkFetcher, collectRun, readJsonl, withCollected, pagesRecord, jsonlPath, pagesPath, selftest, parseArgs, utcDate, OUT_DEFAULT, MANIFEST, IC, FETCH };

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => { console.error(`index-change-collector: ${e && e.stack ? e.stack : e}`); process.exit(1); });
}
