"use strict";
/**
 * INDEX CHANGE PARSE LAYER — backlog row 14, the first forced-flow collector. 2026-10-16.
 *
 * Saved announcement page TEXT in, index-change rows out. This file touches no filesystem, no network
 * and no clock: everything it needs arrives as an argument, so every rule in it is provable on a saved
 * page. The fetch layer (backend/lib/index-changes-fetch.js) brings the text through an INJECTED
 * fetcher; the collector (backend/index-change-collector.js) writes the dated JSONL.
 *
 * WHAT IS RECORDED: announced ADDITIONS and DELETIONS for the S&P 500, S&P MidCap 400, S&P SmallCap 600
 * and the Nasdaq-100, each with the date the change was ANNOUNCED and the date it becomes EFFECTIVE.
 * Nothing is scored, traded or registered here; this layer only turns a public page into rows.
 *
 * ═══ THE ONE INVARIANT THIS FILE EXISTS TO HOLD ═══
 *
 * backend/index-recon-test.js (#53) read a maintained list of EFFECTIVE dates and then assumed in a
 * comment that "announcements precede them by roughly a week". That assumption is the whole trade: the
 * concession is paid between the announcement and the effective date, so a window anchored on the wrong
 * date either misses the move or trades on information nobody had yet. A collector that writes one
 * `date` field hands the next reader that mistake for free.
 *
 * So the two times are never one field, and never one name:
 *   · `announced` — when the change became public. The ONLY field a point-in-time read may use.
 *   · `effective` — when index funds must transact. It IS known at the announcement (it is announced
 *      with it), but it is a FUTURE date, and it is never the date the row became knowable.
 *   · `knownAt`   — a labelled copy of `announced` with `basis: "announced"`. Nothing else may set it.
 *
 * Four mechanics hold it, each with a known-answer case in the package selftest:
 *   1. There is NO scalar `date` / `announcedDate` / `effectiveDate` key on a row. A consumer that
 *      reaches for `row.date` gets `undefined`, not a guess. auditSeparation() FAILS a row that grows
 *      one (FORBIDDEN_ROW_KEYS).
 *   2. A row with no announcement date is NOT PRODUCED. It is counted in `skipped` with the reason
 *      `no-announcement-date`, because a row that was knowable at no stated time cannot be used at any
 *      time — and the effective date must never stand in for it.
 *   3. ANNOUNCED_BASES is the closed list of ways `announced` may be set — `dateline`, `explicit-field`,
 *      `supplied`. None of them reads the effective date, and makeRow() throws on any other basis.
 *   4. visibleAsOf() is the sanctioned point-in-time reader and it looks ONLY at `announced`. Its
 *      same-day default is `exclude`: an announcement dated the day a reader asks about is treated as
 *      NOT yet known unless the caller says otherwise, because the announcement may have come after the
 *      close. effectiveOn() REFUSES to run without an explicit `asOf`, so a forced-flow date can never
 *      be selected without saying what was known when.
 *
 * ═══ THE PARSE RULES (each page may feed more than one) ═══
 *
 *   table            a self-describing table: Effective Date / Index Name / Action / Company / Ticker
 *                    columns, as in an S&P Dow Jones Indices press release. Column ORDER is read from
 *                    the header, not assumed. An Announcement Date column, when present, wins over the
 *                    page's dateline for those rows.
 *   sections         "The following … will be added to the Nasdaq-100 Index effective …:" followed by a
 *                    Company Name / Ticker list, as in the annual reconstitution release. The header
 *                    sets index + action + effective date for the rows under it.
 *   replace-sentence "A (NYSE: AAA) will replace B (Nasdaq: BBB) in the S&P 500 effective prior to the
 *                    opening of trading on …" — two rows, each carrying the other as `counterparty`.
 *   one-sided        "A (NYSE: AAA) will be added to the S&P MidCap 400 effective …" — one row.
 *
 * WHAT IS DELIBERATELY SKIPPED RATHER THAN GUESSED (all counted in `skipped`, never silent):
 *   · an index that is not one of the four (S&P 500 ESG, S&P Composite 1500, a sector index): the same
 *     release carries them and a collector that quietly folds them in poisons the population.
 *   · a row with no usable ticker, or a table row whose field count does not match its header.
 *   · a page with no announcement date (mechanic 2 above).
 *
 * WHY THE DELETION REASON IS CARRIED: #53's survivorship trap. A name leaves an index because it was
 * acquired (price ends near a bid) or because it fell out (series continues). `reason` keeps the two
 * apart at collection time, when the page still says which it was, instead of leaving a later reader to
 * infer it from whether a price series happens to exist.
 *
 * Exports are listed at the bottom. Nothing here is registered as a test (backlog row 14 is collection
 * only); registration, if it ever happens, is a separate step with its own rules.
 */

/* ════════════════════════════ frozen vocabulary ════════════════════════════ */

const SCHEMA = "index-change/1";
const INDEXES = Object.freeze(["SP500", "SP400", "SP600", "NDX100"]);
const INDEX_LABEL = Object.freeze({ SP500: "S&P 500", SP400: "S&P MidCap 400", SP600: "S&P SmallCap 600", NDX100: "Nasdaq-100" });
const ACTIONS = Object.freeze(["add", "delete"]);
/** the closed list of ways `announced` may be set. NONE of them reads the effective date. */
const ANNOUNCED_BASES = Object.freeze(["dateline", "explicit-field", "supplied"]);
const EFFECTIVE_TIMINGS = Object.freeze(["prior-to-open", "at-open", "after-close", "intraday"]);
const REASONS = Object.freeze(["acquisition", "merger", "spin-off", "bankruptcy", "delisting", "migration", "market-cap", "other"]);
const SKIP_REASONS = Object.freeze(["no-announcement-date", "unknown-index", "unknown-action", "no-ticker", "no-company", "not-requested-index", "unparsed-row"]);
/** a row that grows one of these has lost the separation this file exists for: auditSeparation() fails it. */
const FORBIDDEN_ROW_KEYS = Object.freeze(["date", "dt", "day", "announcedDate", "effectiveDate", "announced_date", "effective_date", "ts", "timestamp", "when"]);
const RULES = Object.freeze(["table", "sections", "replace-sentence", "one-sided"]);

/* ════════════════════════════ small helpers ════════════════════════════ */

const squeeze = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
const MONTHS = Object.freeze({ jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 });
const WEEKDAYS = Object.freeze(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun"]);
const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysIn = (y, m) => [31, leap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];

/** a real calendar date or null — no Date parsing anywhere, so no locale and no timezone can shift it */
function isoDate(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2200 || m < 1 || m > 12) return null;
  if (d < 1 || d > daysIn(y, m)) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "September 5, 2026" | "Dec. 12, 2025" | "09/22/2026" | "2026-09-22" | "22 September 2026" -> { iso, raw } | null */
function parseDateLoose(s) {
  const t = squeeze(s);
  let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t))) { const iso = isoDate(+m[1], +m[2], +m[3]); return iso ? { iso, raw: t } : null; }
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t))) {
    // US pages only. A first field above 12 is NOT read as a day: an ambiguous date is refused, not guessed.
    if (+m[1] > 12) return null;
    const iso = isoDate(+m[3], +m[1], +m[2]); return iso ? { iso, raw: t } : null;
  }
  if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(t))) { const mo = MONTHS[m[1].toLowerCase()]; if (!mo) return null; const iso = isoDate(+m[3], mo, +m[2]); return iso ? { iso, raw: t } : null; }
  if ((m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(t))) { const mo = MONTHS[m[2].toLowerCase()]; if (!mo) return null; const iso = isoDate(+m[3], mo, +m[1]); return iso ? { iso, raw: t } : null; }
  return null;
}

const DATE_IN_TEXT = /(\d{4}-\d{1,2}-\d{1,2})|(\d{1,2}\/\d{1,2}\/\d{4})|([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})|(\d{1,2}\s+[A-Za-z]{3,9}\.?,?\s+\d{4})/g;

/** the FIRST real date anywhere in a span -> { iso, raw, at } | null. Candidates that are not real dates are skipped, not fatal. */
function matchDate(span) {
  const s = String(span == null ? "" : span);
  const re = new RegExp(DATE_IN_TEXT.source, "g");
  let m;
  while ((m = re.exec(s))) { const d = parseDateLoose(m[0]); if (d) return { iso: d.iso, raw: squeeze(m[0]), at: m.index }; }
  return null;
}

/** a clock time with a zone, as announcement pages write it -> { time: "17:15", timezone: "ET" } (both null when absent) */
function timeOf(span) {
  const m = /\b(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\.?\s*([A-Z]{2,4})?\b|\b(\d{1,2}):(\d{2})\s+([A-Z]{2,4})\b/i.exec(String(span == null ? "" : span));
  if (!m) return { time: null, timezone: null };
  if (m[1] != null) {
    let h = +m[1]; const mi = +m[2], ap = m[3].toLowerCase();
    if (h < 1 || h > 12 || mi > 59) return { time: null, timezone: null };
    if (ap === "p" && h !== 12) h += 12;
    if (ap === "a" && h === 12) h = 0;
    return { time: `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`, timezone: m[4] ? m[4].toUpperCase() : null };
  }
  const h = +m[5], mi = +m[6];
  if (h > 23 || mi > 59) return { time: null, timezone: null };
  return { time: `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`, timezone: m[7].toUpperCase() };
}

/* ════════════════════════════ normalisation ════════════════════════════ */

/**
 * An index phrase -> one of INDEXES, or null when it is not one of the four. A release names several
 * indices we do not collect (S&P 500 ESG, S&P Composite 1500, sector and style indices); those return
 * null on purpose and the caller counts them as `unknown-index` rather than folding them in.
 */
function normalizeIndex(s) {
  const t = squeeze(s).replace(/\s+index(es)?$/i, "");
  if (!t) return null;
  if (/\b(esg|shariah|carbon|equal[- ]weight|growth|value|dividend|low volatility|buyback|high beta|momentum|quality|catholic|paris[- ]aligned)\b/i.test(t)) return null;
  if (/\bcomposite\s*1500\b|\bs\s*&\s*p\s*1500\b|\btotal market\b|\bs\s*&\s*p\s*900\b/i.test(t)) return null;
  if (/nasdaq[-\s]?100\b/i.test(t)) return "NDX100";
  if (/\bmidcap\s*400\b|\bmid[- ]cap\s*400\b|\bs\s*&\s*p\s*400\b/i.test(t)) return "SP400";
  if (/\bsmallcap\s*600\b|\bsmall[- ]cap\s*600\b|\bs\s*&\s*p\s*600\b/i.test(t)) return "SP600";
  if (/\bs\s*&\s*p\s*500\b/i.test(t)) return "SP500";
  return null;
}

/** an action word -> "add" | "delete" | null */
function normalizeAction(s) {
  const t = squeeze(s).toLowerCase();
  if (!t) return null;
  if (/\b(addition|additions|add|adds|added|adding|join|joins|joining|inclusion|include|included)\b/.test(t)) return "add";
  if (/\b(deletion|deletions|delete|deletes|deleted|removal|removals|remove|removes|removed|removing|drop|dropped|exclusion|excluded)\b/.test(t)) return "delete";
  return null;
}

const TICKER_RE = /^[A-Z][A-Z0-9]{0,5}(?:[.\-][A-Z]{1,2})?$/;
/**
 * A ticker as the page writes it -> the ticker, or null.
 *
 * A cell holding ANY lower-case letter is refused rather than upper-cased. These pages print tickers in
 * capitals, and the list rule takes "the cell that is a ticker" as the ticker — so upper-casing would
 * let a short prose word ("the", "and", "n/a") in the last column of a line become a constituent.
 */
function normalizeTicker(s) {
  const t = squeeze(s).replace(/[.,;]+$/, "");
  if (/[a-z]/.test(t)) return null;
  return TICKER_RE.test(t) ? t : null;
}

/** a company name, or null when the field is not one (too short, no letter, or plainly a sentence) */
function normalizeCompany(s) {
  const t = squeeze(s).replace(/\s*\((?:[A-Za-z][A-Za-z ]{1,24}:\s*)?[A-Z][A-Z0-9.\-]{0,7}\)\s*$/, "").replace(/[,;:]+$/, "");
  if (t.length < 2 || t.length > 90 || !/[A-Za-z]/.test(t)) return null;
  if (t.split(/\s+/).length > 12) return null;
  return t;
}

/**
 * The tail of an "effective …" phrase: as much of the line as belongs to that sentence. It stops at the
 * end of the line, at a trailing "." / ";" / ":", or at a full stop followed by a space and a capital —
 * which is a new sentence. A full stop inside "Dec. 21, 2026" is NOT a sentence end (the next character
 * is a digit), so an abbreviated month survives.
 */
const EFF_TAIL = "([^\\n]{3,200}?)(?=\\.[ \\t]+[A-Z]|[.;:]?[ \\t]*(?:\\n|$))";

const TIMING_RULES = Object.freeze([
  [/\b(?:prior to|before|ahead of)\s+(?:the\s+)?(?:market\s+)?open(?:ing)?/i, "prior-to-open"],
  [/\bat\s+(?:the\s+)?(?:market\s+)?open(?:ing)?/i, "at-open"],
  [/\b(?:after|at|as of)\s+(?:the\s+)?close(?:\s+of\s+trading)?/i, "after-close"],
  [/\bintraday\b/i, "intraday"],
]);

/**
 * An "effective …" phrase -> { iso, time, timing, qualifier, raw }. iso is null when the page has not
 * fixed the date yet (qualifier "to-be-announced") or when the phrase carries no date at all
 * ("no-date-in-text"); the row is still produced, with no effective date, rather than dropped.
 */
function parseEffectivePhrase(s) {
  const raw = squeeze(s).slice(0, 200);
  if (!raw) return null;
  let timing = null;
  for (const [re, t] of TIMING_RULES) if (re.test(raw)) { timing = t; break; }
  const d = matchDate(raw);
  const tbd = /\bto be (?:announced|determined|confirmed|set)\b|\bTBD\b|\bat a later date\b|\bnot yet (?:announced|determined)\b/i.test(raw);
  if (!d) return { iso: null, time: null, timing, qualifier: tbd ? "to-be-announced" : "no-date-in-text", raw };
  return { iso: d.iso, time: timeOf(raw).time, timing, qualifier: null, raw };
}

const REASON_RULES = Object.freeze([
  [/\bacquir\w*|\bacquisition\b|\bbeing (?:bought|purchased)\b|\btender offer\b/i, "acquisition"],
  [/\bmerg\w*\b/i, "merger"],
  [/\bspin[- ]?off\b|\bspun off\b|\bseparation\b/i, "spin-off"],
  [/\bbankrupt\w*|\bchapter 11\b|\breceivership\b/i, "bankruptcy"],
  [/\bdelist\w*|\bno longer (?:meets|satisfies) .{0,40}listing\b/i, "delisting"],
  [/\bmigrat\w*|\bmoving (?:from|to) the\b|\bmoves (?:from|to) the\b|\btransfer\w* (?:from|to) the\b/i, "migration"],
  [/\bmarket cap\w*|\bsize (?:criteri|requirement)\w*|\brepresentative of the\b|\bno longer representative\b/i, "market-cap"],
]);

/** the stated reason a name leaves (or joins) an index -> one of REASONS, or null when the page gives none */
function normalizeReason(span) {
  const t = String(span == null ? "" : span);
  if (!t.trim()) return null;
  for (const [re, r] of REASON_RULES) if (re.test(t)) return r;
  return null;
}

/* ════════════════════════════ the row ════════════════════════════ */

/**
 * TWO identities, because a postponement is not a second change and a re-listing is not the same one.
 *
 *   eventKey   index + action + symbol + the date funds must transact. What a flow study selects on:
 *              "everything that happens on 2026-09-22". A change whose effective date moves gets a new
 *              eventKey, which is right — the flow happens on a different day.
 *   changeKey  index + action + symbol. What a reader asking "what is the announced plan for ZETA"
 *              groups on: the September 5 announcement and the September 10 postponement of it share a
 *              changeKey, so latestByChange() gives the plan as last announced.
 */
function eventKey(row) {
  const eff = row && row.effective && row.effective.iso ? row.effective.iso : "effective-unknown";
  return `${row.index}|${row.action}|${row.symbol}|${eff}`;
}
function changeKey(row) { return `${row.index}|${row.action}|${row.symbol}`; }

/**
 * The one line that decides whether two rows are the same record. Deliberately NOT a function of
 * `fetchedAt`, the page's sha256 or the collection date: re-collecting the same page tomorrow, or
 * collecting a revised page that still says the same thing, must not write a second row.
 */
function fingerprint(row) {
  const a = row.announced || {}, e = row.effective || {};
  return [row.index, row.action, row.symbol, `${a.iso || "-"}T${a.time || "-"}`, e.iso || "-", e.timing || "-", (row.source && row.source.name) || "-"].join("|");
}

/** the only sanctioned read of "when did this become knowable" — `announced`, never `effective` */
function knownAt(row) {
  const a = row && row.announced;
  return a && a.iso ? { iso: a.iso, time: a.time || null, timezone: a.timezone || null, basis: "announced" } : null;
}

/**
 * Build one row, or refuse it with a reason. Refusing is the normal path for the parts of a release we
 * do not collect, so every refusal is returned (never thrown, never logged and dropped) and the caller
 * counts it.
 *
 * Throws only on a programming error inside this module: an announcement basis that is not in
 * ANNOUNCED_BASES. That is the guard against a future edit deriving `announced` from `effective`.
 */
function makeRow(spec) {
  const { indexPhrase, actionPhrase, ticker, company, announced, effective, source, parse, reasonSpan, counterparty, wantIndexes } = spec;
  const skip = (reason, detail) => ({ row: null, skip: { reason, detail: squeeze(detail).slice(0, 180), line: parse ? parse.line : null, raw: parse ? parse.raw : null } });

  if (!announced || !announced.iso) return skip("no-announcement-date", `no announcement date on the page for ${squeeze(ticker) || squeeze(company) || "this row"}`);
  if (!ANNOUNCED_BASES.includes(announced.basis)) throw new Error(`index-changes: announcement basis "${announced.basis}" is not one of ${ANNOUNCED_BASES.join(", ")} — an announcement date may never be derived from an effective date`);

  const index = INDEXES.includes(indexPhrase) ? indexPhrase : normalizeIndex(indexPhrase);
  if (!index) return skip("unknown-index", `"${squeeze(indexPhrase)}" is not one of ${INDEXES.join(", ")}`);
  if (Array.isArray(wantIndexes) && wantIndexes.length && !wantIndexes.includes(index)) return skip("not-requested-index", `${index} was not asked for`);

  const action = ACTIONS.includes(actionPhrase) ? actionPhrase : normalizeAction(actionPhrase);
  if (!action) return skip("unknown-action", `"${squeeze(actionPhrase)}" is neither an addition nor a deletion`);

  const symbol = normalizeTicker(ticker);
  if (!symbol) return skip("no-ticker", `"${squeeze(ticker)}" is not a ticker`);

  const co = normalizeCompany(company);
  const eff = effective || { iso: null, time: null, timing: null, qualifier: "no-date-in-text", raw: null };
  const flags = [];
  // the effective date came from the release's prose, not from this row's own column or section header:
  // recorded, because a reader asking "what did this page actually say about THIS name" must be able to see it
  if (eff.inherited) flags.push("effective-from-release-default");
  if (!eff.iso) flags.push("no-effective-date");
  if (eff.iso && eff.iso < announced.iso) flags.push("effective-before-announced");
  if (eff.iso && eff.iso === announced.iso) flags.push("effective-same-day");

  const reason = normalizeReason(reasonSpan);
  const row = {
    schema: SCHEMA,
    eventKey: null,
    changeKey: null,
    index,
    indexLabel: INDEX_LABEL[index],
    action,
    symbol,
    company: co,
    // ── the two times, never one field ──
    announced: Object.freeze({ iso: announced.iso, time: announced.time || null, timezone: announced.timezone || null, basis: announced.basis, raw: announced.raw || null }),
    effective: Object.freeze({ iso: eff.iso || null, time: eff.time || null, timing: eff.timing || null, qualifier: eff.qualifier || null, raw: eff.raw || null }),
    knownAt: null,
    reason,
    // the words the reason was read from, kept ONLY when there is a reason: the whole span otherwise is
    // noise an operator would have to re-read to learn nothing
    reasonRaw: reason ? squeeze(reasonSpan).slice(0, 220) : null,
    counterparty: counterparty && (counterparty.symbol || counterparty.company) ? Object.freeze({ symbol: counterparty.symbol || null, company: counterparty.company || null }) : null,
    flags,
    source: Object.freeze({ name: (source && source.name) || null, url: (source && source.url) || null, fetchedAt: (source && source.fetchedAt) || null, sha256: (source && source.sha256) || null, bytes: (source && source.bytes) == null ? null : source.bytes }),
    parse: Object.freeze({ rule: (parse && parse.rule) || null, line: (parse && parse.line) == null ? null : parse.line, raw: parse && parse.raw ? squeeze(parse.raw).slice(0, 240) : null }),
  };
  row.eventKey = eventKey(row);
  row.changeKey = changeKey(row);
  row.knownAt = Object.freeze(knownAt(row));
  Object.freeze(row.flags);
  return { row: Object.freeze(row), skip: null };
}

/* ════════════════════════════ page-level context ════════════════════════════ */

const DATELINE_RE = /(?:^|\n)[ \t]*([A-Z][A-Za-z.]*(?:[ \t]+[A-Z][A-Za-z.&]*){0,3}(?:,[ \t]*[A-Z]{2})?)[,—-]?[ \t]*((?:[A-Za-z]{3,9}\.?[ \t]+\d{1,2},[ \t]*\d{4})|(?:\d{1,2}\/\d{1,2}\/\d{4}))(?:[,—-]?[ \t]*\d{1,2}:\d{2}[ \t]*(?:[APap]\.?[ \t]*[Mm]\.?)?[ \t]*[A-Z]{2,4})?[ \t]*(?:[:–—]|--)/g;

/**
 * The page's ANNOUNCEMENT date — the date the page itself was published — from, in order:
 *   1. an announcement date SUPPLIED by the caller (basis "supplied": a listing page's own date column,
 *      recorded in the source manifest). Never taken from a row's effective date.
 *   2. an explicit field: "Announcement Date: September 5, 2026".
 *   3. the dateline at the start of a line: "NEW YORK, September 5, 2026:" / "NEW YORK, Dec. 12, 2025 --".
 *
 * A weekday or a month name as the "city" is refused, because "…on Monday, September 22, 2026:" at the
 * start of a line is an EFFECTIVE date in a sentence, not a dateline — exactly the confusion this
 * collector exists to prevent.
 *
 * Returns null when the page states none. The caller then produces NO rows.
 */
function findAnnounced(text, supplied = null) {
  if (supplied && supplied.iso) {
    const d = parseDateLoose(supplied.iso);
    if (!d) throw new Error(`index-changes: the supplied announcement date "${supplied.iso}" is not a date`);
    return { iso: d.iso, time: supplied.time || null, timezone: supplied.timezone || null, basis: "supplied", raw: squeeze(supplied.raw || `supplied: ${d.iso}`) };
  }
  const head = String(text || "").slice(0, 6000);
  // A LABELLED field only, at the start of a line, with its separator: "Announcement Date: …".
  // Deliberately NOT "announced on …" in prose — on an amendment page that phrase points at the
  // EARLIER announcement ("the addition …, announced on September 5, 2026, will now take place later"),
  // and reading it would date this page to the announcement it supersedes.
  const ex = /(?:^|\n)[ \t]*(?:announcement\s+date|date\s+of\s+announcement|press\s+release\s+date|release\s+date|date\s+published|published)[ \t]*[:–—-][ \t]*([^\n]{4,60})/i.exec(head);
  if (ex) { const d = matchDate(ex[1]); if (d) return { iso: d.iso, ...timeOf(ex[0]), basis: "explicit-field", raw: squeeze(ex[0]).slice(0, 120) }; }
  const re = new RegExp(DATELINE_RE.source, "g");
  let m;
  while ((m = re.exec(head))) {
    const city = squeeze(m[1]).toLowerCase().replace(/\.$/, "");
    if (WEEKDAYS.includes(city) || MONTHS[city]) continue;
    const d = parseDateLoose(m[2]);
    if (d) return { iso: d.iso, ...timeOf(m[0]), basis: "dateline", raw: squeeze(m[0]).slice(0, 120) };
  }
  return null;
}

/**
 * The page's default EFFECTIVE phrase — the one a release states once and then leaves out of its
 * sections ("…will make the following changes … effective prior to the open of trading on Monday,
 * September 22, 2026:"). A section or a column that states its own effective date always wins over it.
 *
 * Every "effective" on the page is tried and the FIRST ONE THAT CARRIES A DATE wins, so a table whose
 * header happens to read "Effective Date  Index Name  …" does not become the release's default.
 */
function findReleaseEffective(text) {
  const re = new RegExp("\\beffective\\b[ \\t]*" + EFF_TAIL, "gi");
  let m, first = null;
  while ((m = re.exec(String(text || "")))) {
    const e = parseEffectivePhrase(m[1]);
    if (!e) continue;
    if (!first) first = e;
    if (e.iso) return e;
  }
  return first;
}

/* ════════════════════════════ rule: table ════════════════════════════ */

const COLUMN_RULES = Object.freeze([
  [/announce(?:ment|d)\s*date|date\s*announced/i, "announced"],
  [/effective(?:\s*date)?$|effective\s*date/i, "effective"],
  [/^index(?:\s*name)?$|index\s*name/i, "index"],
  [/^action$|add\/delete|add or delete|change\s*type|^type$/i, "action"],
  [/gics|sector|sub-?industry/i, "sector"],
  [/ticker|symbol/i, "ticker"],
  [/company(?:\s*name)?|security(?:\s*name)?|constituent|issuer|^name$/i, "company"],
  [/reason|comment|note/i, "reason"],
]);

function classifyColumn(h) {
  const t = squeeze(h);
  for (const [re, name] of COLUMN_RULES) if (re.test(t)) return name;
  return null;
}

/** one line of a table into its cells: a pipe table keeps empty middle cells, a spaced table has none */
function splitRow(line) {
  if (line.includes("|")) {
    const f = line.split("|").map((s) => s.trim());
    if (f.length && f[0] === "") f.shift();
    if (f.length && f[f.length - 1] === "") f.pop();
    return f;
  }
  return line.trim().split(/\t+|\s{2,}/).map((s) => s.trim()).filter((s) => s !== "");
}

const looksTabular = (line) => splitRow(line).length >= 3;

/**
 * Tables that describe themselves: the header must carry a ticker column, an action column and an index
 * column, so the rows cannot be read the wrong way round. Column ORDER comes from the header.
 * A data row whose cell count does not match the header is counted as `unparsed-row`, never guessed at.
 */
function parseTables(lines, ctx) {
  const out = [], skipped = [];
  for (let i = 0; i < lines.length; i++) {
    const head = splitRow(lines[i]);
    if (head.length < 3) continue;
    const cols = head.map(classifyColumn);
    if (!(cols.includes("ticker") && cols.includes("action") && cols.includes("index"))) continue;
    const at = (name) => cols.indexOf(name);
    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j];
      if (!raw.trim()) { if (j + 1 < lines.length && looksTabular(lines[j + 1]) && splitRow(lines[j + 1]).length === head.length) continue; break; }
      if (/^[-=─_\s|+]+$/.test(raw)) continue;                               // a rule line under the header
      const cells = splitRow(raw);
      if (cells.length !== head.length) {
        // A row that does not match its header is COUNTED and skipped, and the table goes on: one
        // misaligned line (a company name with a single space before its ticker) must not cost the
        // rows under it. A line that is not tabular at all is the end of the table.
        if (!looksTabular(raw)) break;
        skipped.push({ reason: "unparsed-row", detail: `${cells.length} cells, the header has ${head.length}`, line: j + 1, raw: squeeze(raw).slice(0, 180) });
        i = j;
        continue;
      }
      const cell = (name) => { const k = at(name); return k < 0 ? null : cells[k]; };
      const annCell = cell("announced");
      let announced = ctx.announced;
      if (annCell) { const d = matchDate(annCell); if (d) announced = { iso: d.iso, time: null, timezone: null, basis: "explicit-field", raw: `Announcement Date column: ${d.raw}` }; }
      const effCell = cell("effective");
      let effective = effCell ? parseEffectivePhrase(effCell) : ctx.effective;
      // A date column says WHEN but not WHETHER it is at the open or the close; the release says that
      // once, in prose. Inherit the timing only when the two dates agree — a different date is a
      // different event and must not borrow the sentence's timing.
      if (effective && effective.iso && !effective.timing && ctx.effective && ctx.effective.timing && ctx.effective.iso === effective.iso) {
        effective = { ...effective, timing: ctx.effective.timing, raw: `${effective.raw} (timing from the release: ${ctx.effective.raw})` };
      }
      const r = makeRow({
        indexPhrase: cell("index"), actionPhrase: cell("action"), ticker: cell("ticker"), company: cell("company"),
        announced, effective, source: ctx.source, wantIndexes: ctx.wantIndexes,
        reasonSpan: cell("reason"), parse: { rule: "table", line: j + 1, raw },
      });
      if (r.row) out.push(r.row); else skipped.push(r.skip);
      i = j;
    }
  }
  return { rows: out, skipped };
}

/* ════════════════════════════ rule: sections ════════════════════════════ */

const SECTION_RE = /\b(?:will\s+be|are\s+being|is\s+being|will|has\s+been|have\s+been)\s+(added\s+to|removed\s+from|deleted\s+from|dropped\s+from|joining)\s+(?:the\s+)?([^:\n]{3,80}?)(?:\s+(?:index|indices))?\s*(?:effective\b([^:\n]{0,160}))?:?\s*$/i;
const LIST_HEADER_RE = /^\s*(?:company(?:\s*name)?|security|constituent|issuer|name)\b.*\b(?:ticker|symbol)\b|^\s*(?:ticker|symbol)\b.*\b(?:company|name|security)\b/i;

/** "A (Nasdaq: AAA)" | "A  AAA" | "AAA  A" | "AAA - A" -> { ticker, company } | null */
function parseListRow(line) {
  const t = line.trim();
  if (!t) return null;
  let m = /^(.{2,90}?)\s*\((?:[A-Za-z][A-Za-z ]{1,24}:\s*)?([A-Z][A-Z0-9.\-]{0,7})\)\s*$/.exec(t);
  if (m && normalizeTicker(m[2])) return { ticker: normalizeTicker(m[2]), company: normalizeCompany(m[1]) };
  m = /^([A-Z][A-Z0-9]{0,5}(?:[.\-][A-Z]{1,2})?)\s*(?:[-–—]|•)\s*(.{2,90})$/.exec(t);
  if (m && normalizeTicker(m[1])) return { ticker: normalizeTicker(m[1]), company: normalizeCompany(m[2]) };
  const cells = splitRow(t);
  if (cells.length >= 2) {
    // the ticker is the last cell in a "Company Name  TICKER" list and the first in a "TICKER  Company
    // Name" one; the cell that is a ticker decides, and the rest of the line is the company.
    const last = normalizeTicker(cells[cells.length - 1]);
    if (last) return { ticker: last, company: normalizeCompany(cells.slice(0, -1).join(" ")) };
    const first = normalizeTicker(cells[0]);
    if (first) return { ticker: first, company: normalizeCompany(cells.slice(1).join(" ")) };
  }
  return null;
}

/**
 * A section header sets the index, the action and (when it says so) the effective date for the list that
 * follows it; a section that states no effective date inherits the release's one. The list ends at the
 * first line that is neither a list header nor a list row — prose after a list closes it.
 */
function parseSections(lines, ctx) {
  const out = [], skipped = [];
  for (let i = 0; i < lines.length; i++) {
    const h = SECTION_RE.exec(lines[i]);
    if (!h) continue;
    const action = normalizeAction(h[1]);
    const indexPhrase = h[2];
    const effective = h[3] ? parseEffectivePhrase(h[3]) : (/\beffective\b/i.test(lines[i]) ? parseEffectivePhrase((/\beffective\b[ \t]*([^\n]{3,200})/i.exec(lines[i]) || [])[1]) : null) || ctx.effective;
    if (!action) continue;
    let j = i + 1, seen = 0;
    for (; j < lines.length; j++) {
      const raw = lines[j];
      if (!raw.trim()) { if (seen === 0) continue; if (j + 1 < lines.length && parseListRow(lines[j + 1])) continue; break; }
      if (LIST_HEADER_RE.test(raw)) continue;
      if (/^[-=─_\s|+]+$/.test(raw)) continue;
      if (SECTION_RE.test(raw)) break;
      const lr = parseListRow(raw);
      if (!lr) break;
      seen++;
      const r = makeRow({
        indexPhrase, actionPhrase: action, ticker: lr.ticker, company: lr.company,
        announced: ctx.announced, effective, source: ctx.source, wantIndexes: ctx.wantIndexes,
        reasonSpan: raw, parse: { rule: "sections", line: j + 1, raw },
      });
      if (r.row) out.push(r.row); else skipped.push(r.skip);
    }
    i = Math.max(i, j - 1);
  }
  return { rows: out, skipped };
}

/* ════════════════════════════ rule: sentences ════════════════════════════ */

const PAREN_TICKER = "\\((?:[A-Za-z][A-Za-z ]{1,24}:\\s*)?([A-Z][A-Z0-9]{0,5}(?:[.\\-][A-Z]{1,2})?)\\)";
const REPLACE_RE = new RegExp("([A-Z][^()\\n]{1,70}?)\\s*" + PAREN_TICKER + "\\s+will\\s+replace\\s+([A-Z][^()\\n]{1,70}?)\\s*" + PAREN_TICKER + "\\s+in\\s+the\\s+([^\\n]{3,60}?)\\s+effective\\s+" + EFF_TAIL, "g");
const ONE_SIDED_RE = new RegExp("([A-Z][^()\\n]{1,70}?)\\s*" + PAREN_TICKER + "\\s+will\\s+(?:be\\s+)?(added\\s+to|removed\\s+from|deleted\\s+from|dropped\\s+from|join)\\s+(?:the\\s+)?([^\\n]{3,60}?)\\s+effective\\s+" + EFF_TAIL, "g");

const lineOf = (text, at) => text.slice(0, at).split("\n").length;
/**
 * The sentence and what FOLLOWS it, for the reason. Forward only: a release states why a name is
 * leaving after it says that it leaves ("… will replace X. X is being acquired by …"), and reading
 * backwards would pick up the previous row of the table above.
 */
const spanAfter = (text, at, len) => text.slice(at, at + len + 280);

/** "A (NYSE: AAA) will replace B (Nasdaq: BBB) in the S&P 500 effective …" -> an add row and a delete row */
function parseReplaceSentences(text, ctx) {
  const out = [], skipped = [];
  const re = new RegExp(REPLACE_RE.source, "g");
  let m;
  while ((m = re.exec(text))) {
    const [all, addCo, addTk, delCo, delTk, indexPhrase, effPhrase] = m;
    const effective = parseEffectivePhrase(effPhrase);
    const line = lineOf(text, m.index), raw = squeeze(all);
    const around = spanAfter(text, m.index, all.length);
    const pair = [
      { actionPhrase: "add", ticker: addTk, company: addCo, counterparty: { symbol: normalizeTicker(delTk), company: normalizeCompany(delCo) }, reasonSpan: null },
      { actionPhrase: "delete", ticker: delTk, company: delCo, counterparty: { symbol: normalizeTicker(addTk), company: normalizeCompany(addCo) }, reasonSpan: around },
    ];
    for (const p of pair) {
      const r = makeRow({ ...p, indexPhrase, announced: ctx.announced, effective, source: ctx.source, wantIndexes: ctx.wantIndexes, parse: { rule: "replace-sentence", line, raw } });
      if (r.row) out.push(r.row); else skipped.push(r.skip);
    }
  }
  return { rows: out, skipped };
}

/** "A (NYSE: AAA) will be added to the S&P MidCap 400 effective …" -> one row */
function parseOneSided(text, ctx) {
  const out = [], skipped = [];
  const re = new RegExp(ONE_SIDED_RE.source, "g");
  let m;
  while ((m = re.exec(text))) {
    const [all, company, ticker, actionPhrase, indexPhrase, effPhrase] = m;
    const r = makeRow({
      indexPhrase, actionPhrase, ticker, company,
      announced: ctx.announced, effective: parseEffectivePhrase(effPhrase), source: ctx.source, wantIndexes: ctx.wantIndexes,
      reasonSpan: spanAfter(text, m.index, all.length), parse: { rule: "one-sided", line: lineOf(text, m.index), raw: squeeze(all) },
    });
    if (r.row) out.push(r.row); else skipped.push(r.skip);
  }
  return { rows: out, skipped };
}

/* ════════════════════════════ the page ════════════════════════════ */

/** two rows describing the same record: the one parsed by the more specific rule wins */
const RULE_RANK = Object.freeze({ table: 0, sections: 1, "replace-sentence": 2, "one-sided": 3 });
/** fields a second rule may fill in on the kept row. Never a date and never a source: those decide identity. */
const FILLABLE = Object.freeze(["company", "reason", "reasonRaw", "counterparty"]);

/** the kept row, plus whatever only the duplicate knew */
function fillFrom(keep, other) {
  const fill = {};
  for (const k of FILLABLE) if (keep[k] == null && other[k] != null) fill[k] = other[k];
  return Object.keys(fill).length ? Object.freeze({ ...keep, ...fill }) : keep;
}

/**
 * Put a wrapped sentence back on one line, and leave everything else exactly where it was.
 *
 * Page text saved from a browser or stripped out of HTML wraps prose at some width, which would split
 * "…effective prior to the open of trading on Monday, / September 22, 2026" across two lines and hide
 * the date from the sentence that owns it. A continuation line is joined to the one above it only when
 * BOTH are prose: neither splits into table cells, neither is a list row or a list header, neither is a
 * bare ticker, and the line above does not already end a sentence. A table, a list and a blank line are
 * untouched, so the line-based rules below still see the page's own layout.
 */
function dewrap(text) {
  const out = [];
  for (const raw of String(text == null ? "" : text).split("\n")) {
    const line = raw.replace(/[ \t]+$/, "");
    const prev = out.length ? out[out.length - 1] : null;
    const prose = (s) => s.trim() !== "" && splitRow(s).length < 3 && !parseListRow(s) && !LIST_HEADER_RE.test(s) && !/^[A-Z][A-Z0-9]{0,5}$/.test(s.trim()) && !/^[-=─_\s|+]+$/.test(s);
    if (prev !== null && prose(prev) && prose(line) && !/[.:;!?]["')\]]?$/.test(prev.trim())) out[out.length - 1] = `${prev} ${line.trim()}`;
    else out.push(line);
  }
  return out;
}

/**
 * Parse one saved page.
 *
 *   parsePage({ text, source, announced, wantIndexes })
 *     text        the saved page text (already fetched: this layer never fetches)
 *     source      { name, url, fetchedAt, sha256, bytes } — provenance, copied onto every row
 *     announced   OPTIONAL { iso, time, timezone, raw } when the page itself carries no date and the
 *                 manifest states one. Recorded with basis "supplied". NEVER an effective date.
 *     wantIndexes OPTIONAL subset of INDEXES to keep; the rest are counted `not-requested-index`.
 *
 * -> { ok, rows, skipped, problems, release, counts }
 *    rows      frozen index-change rows, deduplicated by fingerprint()
 *    skipped   every row this page offered and this layer refused, with the reason
 *    problems  page-level trouble (no announcement date, no rows, no index named)
 *    release   what the page said once: the announcement date and the default effective phrase
 */
function parsePage({ text, source = {}, announced = null, wantIndexes = null } = {}) {
  const raw = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
  const lines = dewrap(raw);                                         // a wrapped sentence back on one line
  const body = lines.join("\n");
  const problems = [], skipped = [];
  const ann = findAnnounced(body, announced);
  const release = { announced: ann, effective: findReleaseEffective(body) };

  if (!ann) {
    // MECHANIC 2 of the invariant at the top of this file: no announcement date, no rows. The effective
    // dates on the page are NOT promoted to stand in for it, however many of them there are.
    problems.push("no announcement date on the page: no rows are produced (an effective date is never read as an announcement date)");
    return { ok: false, rows: [], skipped: [{ reason: "no-announcement-date", detail: `the page states ${(body.match(new RegExp(DATE_IN_TEXT.source, "g")) || []).length} date(s), none of them an announcement date`, line: null, raw: null }], problems, release, counts: { rows: 0, skipped: 1, byRule: {}, byIndex: {}, byAction: {} } };
  }

  // the release's own effective phrase is the FALLBACK for a section or a table row that states none;
  // `inherited` marks it so every row that leans on it is flagged rather than looking first-hand.
  const ctx = { announced: ann, effective: release.effective ? { ...release.effective, inherited: true } : null, source, wantIndexes: Array.isArray(wantIndexes) && wantIndexes.length ? wantIndexes.slice() : null };
  const parts = [parseTables(lines, ctx), parseSections(lines, ctx), parseReplaceSentences(body, ctx), parseOneSided(body, ctx)];
  const all = [];
  for (const p of parts) { all.push(...p.rows); skipped.push(...p.skipped); }

  // dedupe: the same record often appears in both a sentence and the table under it. The row from the
  // more specific rule is kept, and anything only the other one knew (the company name, the reason, the
  // name on the other side of a replacement) is filled in from it rather than thrown away.
  const best = new Map();
  for (const r of all) {
    const f = fingerprint(r), had = best.get(f);
    if (!had) { best.set(f, r); continue; }
    const keep = RULE_RANK[r.parse.rule] < RULE_RANK[had.parse.rule] ? r : had;
    best.set(f, fillFrom(keep, keep === r ? had : r));
  }
  const rows = [...best.values()].sort((a, b) => (a.effective.iso || "9999").localeCompare(b.effective.iso || "9999") || a.index.localeCompare(b.index) || a.action.localeCompare(b.action) || a.symbol.localeCompare(b.symbol));

  const byRule = {}, byIndex = {}, byAction = {};
  for (const r of rows) { byRule[r.parse.rule] = (byRule[r.parse.rule] || 0) + 1; byIndex[r.index] = (byIndex[r.index] || 0) + 1; byAction[r.action] = (byAction[r.action] || 0) + 1; }
  if (!rows.length) problems.push("the page has an announcement date but no index change this collector recognises");
  const unparsed = skipped.filter((s) => s.reason === "unparsed-row").length;
  if (unparsed) problems.push(`${unparsed} table row(s) did not match their header and were not read`);

  return { ok: problems.length === 0, rows, skipped, problems, release, counts: { rows: rows.length, skipped: skipped.length, dropped: all.length - rows.length, byRule, byIndex, byAction } };
}

/* ════════════════════════════ reading rows safely ════════════════════════════ */

/** an ISO date, or an ISO timestamp -> { date, minutes|null } */
function splitAsOf(asOf) {
  const s = squeeze(asOf);
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s);
  if (!m) throw new Error(`index-changes: asOf "${asOf}" is not an ISO date or timestamp`);
  return { date: m[1], minutes: m[2] == null ? null : +m[2] * 60 + +m[3] };
}

/**
 * THE point-in-time reader. It looks at `announced` and at nothing else — never at `effective`, never at
 * the collection date, never at a file name.
 *
 * sameDay (default "exclude") decides what to do with a row announced ON the asOf date:
 *   "exclude"  the row is NOT known (the safe default: the announcement may have come after the close)
 *   "include"  the row is known (for a reader that acts on the next session's open)
 *   "time"     known only when both the row and asOf carry a clock time in the same zone and the row's
 *              is at or before asOf's; otherwise not known
 */
function visibleAsOf(rows, asOf, { sameDay = "exclude" } = {}) {
  if (!["exclude", "include", "time"].includes(sameDay)) throw new Error(`index-changes: sameDay "${sameDay}" is not exclude, include or time`);
  const A = splitAsOf(asOf);
  return (rows || []).filter((r) => {
    const a = r && r.announced;
    if (!a || !a.iso) return false;                                  // never usable point-in-time
    if (a.iso < A.date) return true;
    if (a.iso > A.date) return false;
    if (sameDay === "include") return true;
    if (sameDay === "exclude") return false;
    if (A.minutes == null || !a.time) return false;
    const [h, mi] = a.time.split(":").map(Number);
    return h * 60 + mi <= A.minutes;
  });
}

/** rows grouped by a key function (eventKey by default), each group in announcement order (oldest first) */
function groupByKey(rows, keyOf = eventKey) {
  const g = new Map();
  for (const r of rows || []) { const k = keyOf === eventKey ? (r.eventKey || eventKey(r)) : keyOf(r); if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
  for (const v of g.values()) v.sort((a, b) => (a.announced.iso || "").localeCompare(b.announced.iso || "") || (a.announced.time || "").localeCompare(b.announced.time || ""));
  return g;
}

const byEffectiveThenName = (a, b) => (a.effective.iso || "9999").localeCompare(b.effective.iso || "9999") || a.index.localeCompare(b.index) || a.action.localeCompare(b.action) || a.symbol.localeCompare(b.symbol);

/** one row per eventKey: the LAST announcement of it, so a re-announcement of the same date supersedes */
function latestByKey(rows) {
  const out = [];
  for (const v of groupByKey(rows).values()) out.push(v[v.length - 1]);
  return out.sort(byEffectiveThenName);
}

/**
 * One row per changeKey: the plan for that name as LAST announced. A September 10 postponement of a
 * September 5 addition supersedes it here, where latestByKey keeps both (two different effective dates).
 */
function latestByChange(rows) {
  const out = [];
  for (const v of groupByKey(rows, changeKey).values()) out.push(v[v.length - 1]);
  return out.sort(byEffectiveThenName);
}

/** latestByKey over what was known at asOf — the composition a point-in-time reader wants */
function latestKnownAsOf(rows, asOf, opts = {}) { return latestByKey(visibleAsOf(rows, asOf, opts)); }

/** latestByChange over what was known at asOf: "the announced plan for each name, as of that date" */
function planKnownAsOf(rows, asOf, opts = {}) { return latestByChange(visibleAsOf(rows, asOf, opts)); }

/**
 * The rows whose effective date is `dateIso`, out of what was KNOWN at `asOf`.
 * `asOf` is required and has no default: a forced-flow date may not be selected without saying what was
 * known when. Passing asOf = dateIso answers "what did the market know by the effective date".
 */
function effectiveOn(rows, dateIso, { asOf, sameDay = "exclude" } = {}) {
  if (!asOf) throw new Error("index-changes: effectiveOn() needs an explicit asOf — an effective date is not a knowledge date");
  const d = splitAsOf(dateIso).date;
  return latestKnownAsOf(rows, asOf, { sameDay }).filter((r) => r.effective.iso === d);
}

/**
 * The guard a consumer runs over rows it has read back from the JSONL. It fails on anything that would
 * let the effective date pass for the announcement date, and counts the data conditions a reader must
 * decide about rather than discover.
 */
function auditSeparation(rows) {
  const problems = [], counts = { rows: 0, effectiveBeforeAnnounced: 0, noEffectiveDate: 0, effectiveSameDay: 0, withTime: 0 };
  (rows || []).forEach((r, i) => {
    counts.rows++;
    const at = (what) => `row ${i + 1} (${r && r.symbol ? r.symbol : "?"}): ${what}`;
    if (!r || typeof r !== "object") { problems.push(at("is not an object")); return; }
    if (r.schema !== SCHEMA) problems.push(at(`schema is "${r.schema}", not "${SCHEMA}"`));
    for (const k of FORBIDDEN_ROW_KEYS) if (Object.prototype.hasOwnProperty.call(r, k)) problems.push(at(`has a scalar "${k}" key — the announcement and effective dates must stay in their own blocks`));
    if (!r.announced || !r.announced.iso) { problems.push(at("has no announcement date, so it is knowable at no time")); return; }
    if (!ANNOUNCED_BASES.includes(r.announced.basis)) problems.push(at(`announcement basis "${r.announced.basis}" is not one of ${ANNOUNCED_BASES.join(", ")}`));
    if (!r.effective || !("iso" in r.effective)) problems.push(at("has no effective block"));
    const k = knownAt(r);
    if (!r.knownAt || r.knownAt.basis !== "announced" || !k || r.knownAt.iso !== k.iso) problems.push(at("knownAt does not read the announcement date with basis \"announced\""));
    if (r.effective && r.effective.iso === null) counts.noEffectiveDate++;
    if (r.effective && r.effective.iso && r.effective.iso < r.announced.iso) { counts.effectiveBeforeAnnounced++; if (!(r.flags || []).includes("effective-before-announced")) problems.push(at("has an effective date before its announcement date and is not flagged")); }
    if (r.effective && r.effective.iso && r.effective.iso === r.announced.iso) counts.effectiveSameDay++;
    if (r.announced.time) counts.withTime++;
    if (!INDEXES.includes(r.index)) problems.push(at(`index "${r.index}" is not one of ${INDEXES.join(", ")}`));
    if (!ACTIONS.includes(r.action)) problems.push(at(`action "${r.action}" is not one of ${ACTIONS.join(", ")}`));
    if (!normalizeTicker(r.symbol)) problems.push(at(`symbol "${r.symbol}" is not a ticker`));
  });
  return { ok: problems.length === 0, checked: counts.rows, problems, counts };
}

/**
 * Fold new rows into rows already on file. Append-only in spirit: nothing is removed and nothing is
 * rewritten; a row whose fingerprint() is already there is reported as `already` and not written twice,
 * so running the collector twice on one day writes the file once.
 */
function mergeRows(existing, incoming) {
  const seen = new Map();
  for (const r of existing || []) seen.set(fingerprint(r), r);
  const added = [], already = [];
  for (const r of incoming || []) {
    const f = fingerprint(r);
    if (seen.has(f)) { already.push(r); continue; }
    seen.set(f, r); added.push(r);
  }
  return { rows: [...(existing || []), ...added], added, already };
}

module.exports = {
  // vocabulary
  SCHEMA, INDEXES, INDEX_LABEL, ACTIONS, ANNOUNCED_BASES, EFFECTIVE_TIMINGS, REASONS, SKIP_REASONS, FORBIDDEN_ROW_KEYS, RULES,
  // dates and normalisation
  isoDate, parseDateLoose, matchDate, timeOf, normalizeIndex, normalizeAction, normalizeTicker, normalizeCompany, normalizeReason, parseEffectivePhrase,
  // page level
  findAnnounced, findReleaseEffective, parsePage, splitRow, classifyColumn, parseListRow, dewrap,
  // rows
  makeRow, eventKey, changeKey, fingerprint, fillFrom, knownAt, mergeRows,
  // reading rows without a leak
  splitAsOf, visibleAsOf, groupByKey, latestByKey, latestByChange, latestKnownAsOf, planKnownAsOf, effectiveOn, auditSeparation,
};
