"use strict";
/**
 * INDEX CHANGE FETCH LAYER — backlog row 14. 2026-10-16.
 *
 * Brings announcement page text to the parse layer (backend/lib/index-changes.js) and nothing else: it
 * does not read a file, does not know a URL scheme and CONTAINS NO NETWORK CLIENT. The fetcher is
 * injected by the caller, always:
 *
 *   collect({ sources, fetcher, now })
 *
 * There is no default fetcher. A call without one throws, by design — that is what makes every test of
 * this layer a test on saved page text with no network reachable (AGENTS.md: tests make no network calls
 * of any kind). The collector (backend/index-change-collector.js) is the only file that builds a real
 * one, and only when it is asked to.
 *
 * A fetcher is `async (url, src) -> { ok, status, text, finalUrl }`:
 *   ok        false means the page did not come back; the source is recorded as a problem and the run
 *             goes on with the others (one dead page must not lose four good ones)
 *   status    whatever the transport reports (an HTTP status, or null for a saved file)
 *   text      the page text. An empty body with ok:true is a problem, not zero changes.
 *   finalUrl  OPTIONAL, after redirects. Recorded so provenance is the page actually read.
 *
 * WHAT THIS LAYER ADDS TO EVERY ROW: provenance the operator can re-check at home — the source name,
 * the URL, the sha256 and byte length of the exact text that was parsed, and the fetch time. The sha256
 * is of the text, not of the row, so re-running the collector on a saved copy of the page proves the
 * rows came from those bytes.
 *
 * WHAT IT DOES NOT DO: it never supplies an announcement date of its own. A source MAY carry
 * `announced: { iso, ... }` in the manifest when the page itself has no dateline (a listing page with a
 * date column); that is passed through to the parse layer with basis "supplied" and is the operator's
 * statement, not an inference. An effective date is never promoted into it — the parse layer throws if
 * anything tries.
 */
const crypto = require("crypto");
const IC = require("./index-changes.js");

/** the sources this collector is pointed at. Each one is announcement pages for one provider. */
const DEFAULT_SOURCES = Object.freeze([
  Object.freeze({ name: "spdji-index-announcements", url: "https://www.spglobal.com/spdji/en/index-announcements/", indexes: Object.freeze(["SP500", "SP400", "SP600"]), note: "S&P Dow Jones Indices announcement listing: additions, deletions and their effective dates" }),
  Object.freeze({ name: "nasdaq-index-news", url: "https://www.nasdaq.com/solutions/global-indexes/index-news", indexes: Object.freeze(["NDX100"]), note: "Nasdaq index news: Nasdaq-100 additions, removals and the annual reconstitution" }),
]);

const sha256 = (s) => crypto.createHash("sha256").update(Buffer.from(String(s), "utf8")).digest("hex");

/** every field a source may carry, checked before a fetcher is called so a typo fails loudly and early */
const SOURCE_KEYS = Object.freeze(["name", "url", "indexes", "announced", "note"]);

function checkSource(src, i) {
  const where = `sources[${i}]`;
  if (!src || typeof src !== "object") return `${where} is not an object`;
  for (const k of Object.keys(src)) if (!SOURCE_KEYS.includes(k)) return `${where} has an unknown field "${k}" (allowed: ${SOURCE_KEYS.join(", ")})`;
  if (!src.name || typeof src.name !== "string") return `${where} has no name`;
  if (!src.url || typeof src.url !== "string") return `${where} (${src.name}) has no url`;
  if (src.indexes != null) {
    if (!Array.isArray(src.indexes)) return `${where} (${src.name}) indexes is not an array`;
    for (const x of src.indexes) if (!IC.INDEXES.includes(x)) return `${where} (${src.name}) asks for index "${x}", which is not one of ${IC.INDEXES.join(", ")}`;
  }
  if (src.announced != null) {
    if (typeof src.announced !== "object") return `${where} (${src.name}) announced is not an object`;
    if (!src.announced.iso || !IC.parseDateLoose(src.announced.iso)) return `${where} (${src.name}) announced.iso "${src.announced && src.announced.iso}" is not a date`;
  }
  return null;
}

/**
 * Fetch every source and parse it.
 *
 *   collect({ sources, fetcher, now })
 *     sources  array of { name, url, indexes?, announced?, note? }. DEFAULT_SOURCES when omitted.
 *     fetcher  REQUIRED, injected. async (url, src) -> { ok, status, text, finalUrl }
 *     now      OPTIONAL () -> ms, for the fetchedAt stamp. Date.now when omitted.
 *
 * -> { rows, pages, problems, skipped, counts }
 *    rows      every row from every page, deduplicated across pages by fingerprint()
 *    pages     one provenance record per source, whether it parsed or not
 *    problems  per-source trouble, each line naming the source
 *    skipped   everything the parse layer refused, with the source name added
 *
 * One bad source never throws: it lands in `problems` with `pages[i].ok === false`.
 */
async function collect({ sources = DEFAULT_SOURCES, fetcher = null, now = () => Date.now() } = {}) {
  if (typeof fetcher !== "function") throw new Error("index-changes-fetch: a fetcher must be injected — this layer holds no network client, so a test runs on saved page text");
  if (!Array.isArray(sources) || !sources.length) throw new Error("index-changes-fetch: sources must be a non-empty array");
  const bad = sources.map(checkSource).filter(Boolean);
  if (bad.length) throw new Error(`index-changes-fetch: ${bad.join("; ")}`);

  const pages = [], problems = [], skipped = [], seen = new Map();
  const rows = [];

  for (const src of sources) {
    const fetchedAt = new Date(now()).toISOString();
    const page = { name: src.name, url: src.url, finalUrl: null, fetchedAt, ok: false, status: null, bytes: null, sha256: null, rows: 0, skipped: 0, announced: null, problems: [] };
    let res = null;
    try {
      res = await fetcher(src.url, src);
    } catch (e) {
      page.problems.push(`the fetcher threw: ${String(e && e.message ? e.message : e).slice(0, 200)}`);
      pages.push(page); problems.push(`${src.name}: ${page.problems[0]}`);
      continue;
    }
    if (!res || typeof res !== "object") { page.problems.push("the fetcher returned nothing"); pages.push(page); problems.push(`${src.name}: ${page.problems[0]}`); continue; }
    page.status = res.status == null ? null : res.status;
    page.finalUrl = res.finalUrl || null;
    if (!res.ok) { page.problems.push(`the page did not come back (status ${page.status == null ? "none" : page.status})`); pages.push(page); problems.push(`${src.name}: ${page.problems[0]}`); continue; }
    const text = typeof res.text === "string" ? res.text : "";
    page.bytes = Buffer.byteLength(text, "utf8");
    page.sha256 = sha256(text);
    if (!text.trim()) { page.problems.push("the page came back empty — recorded as a problem, NOT as zero changes"); pages.push(page); problems.push(`${src.name}: ${page.problems[0]}`); continue; }

    const source = { name: src.name, url: page.finalUrl || src.url, fetchedAt, sha256: page.sha256, bytes: page.bytes };
    let parsed;
    try {
      parsed = IC.parsePage({ text, source, announced: src.announced || null, wantIndexes: src.indexes ? src.indexes.slice() : null });
    } catch (e) {
      page.problems.push(`the parse layer threw: ${String(e && e.message ? e.message : e).slice(0, 200)}`);
      pages.push(page); problems.push(`${src.name}: ${page.problems[0]}`);
      continue;
    }
    page.ok = true;
    page.announced = parsed.release.announced ? { iso: parsed.release.announced.iso, basis: parsed.release.announced.basis } : null;
    page.rows = parsed.rows.length;
    page.skipped = parsed.skipped.length;
    page.counts = parsed.counts;
    for (const p of parsed.problems) { page.problems.push(p); problems.push(`${src.name}: ${p}`); }
    for (const s of parsed.skipped) skipped.push({ source: src.name, ...s });
    for (const r of parsed.rows) {
      const f = IC.fingerprint(r);
      if (seen.has(f)) continue;                                     // the same change announced on two pages
      seen.set(f, r); rows.push(r);
    }
    pages.push(page);
  }

  const counts = { sources: sources.length, pagesOk: pages.filter((p) => p.ok).length, rows: rows.length, skipped: skipped.length, problems: problems.length, byIndex: {}, byAction: {} };
  for (const r of rows) { counts.byIndex[r.index] = (counts.byIndex[r.index] || 0) + 1; counts.byAction[r.action] = (counts.byAction[r.action] || 0) + 1; }
  return { rows, pages, problems, skipped, counts };
}

/**
 * A fetcher over text already in hand: `{ "<url>": "<page text>" }`. This is what a test injects, and
 * what the collector uses for a directory of saved pages. A url that is not in the map comes back
 * ok:false with status 404 rather than throwing, so a manifest with a stale entry behaves like a dead
 * page instead of losing the run.
 */
function textFetcher(byUrl) {
  const map = new Map(Object.entries(byUrl || {}));
  return async (url) => (map.has(url) ? { ok: true, status: 200, text: map.get(url) } : { ok: false, status: 404, text: "" });
}

module.exports = { collect, textFetcher, checkSource, sha256, DEFAULT_SOURCES, SOURCE_KEYS };
