"use strict";
/**
 * FORWARD CATCH-UP MARKS — FORWARDREC 2026-10-05 (health sweep FT-8).
 *
 * R191 and R231 trade crypto, which prices seven days a week, but their runners sit in the weekday close chain and wrote ONE mark per
 * run: the last completed UTC day. Friday's and Saturday's closes were never marked (the Monday run marks Sunday), so the registered
 * 365-day clocks ran at ~5/7 speed and every Sunday "daily" return was really a three-day return. This helper gives a forward test
 * exactly one row per UTC calendar day:
 *
 *   - from the coin's FIRST row through its last COMPLETED daily bar, every day with no row gets one now — a priced mark from that day's
 *     own daily close, with the book fields the caller says were in force that day;
 *   - a day with no completed bar in the series becomes a GAP row ({ gap: true, reason }) — never a quiet day, never a guessed close;
 *   - a day on/after `today` (the run's UTC date) is incomplete and is never marked;
 *   - a coin with no row yet gets only its last completed day (no backfill before a test's first mark);
 *   - rows already present are never touched, so a second run on the same day adds nothing (idempotent). A gap row stays a gap.
 *
 * Pure: no I/O, no clock. The caller appends the returned rows to its own state and saves it.
 */
const DAY = 864e5;
const isYmd = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);

/**
 * catchUpRows({ marks, coin, bars, today, fieldsFor, markedOn }) -> rows to APPEND (marks is not mutated)
 *   marks      the test's existing rows (any coin): { coin, d, close, ... } or gap rows { coin, d, gap: true, reason }
 *   bars       this coin's daily bars [{ d: "YYYY-MM-DD" (UTC day), c: close }], any order
 *   today      the run's UTC date; bars on/after it are ignored (an incomplete day is never marked)
 *   fieldsFor  (d, { isLast }) -> the book fields for day d (merged into the row), or null when the book on d cannot be known (gap row)
 *   markedOn   optional stamp written on catch-up and gap rows (the run's date) so a late mark is visible as late
 */
function catchUpRows({ marks, coin, bars, today, fieldsFor, markedOn = null }) {
  if (!isYmd(today)) throw new Error(`catchUpRows: today must be YYYY-MM-DD (got ${today})`);
  if (typeof fieldsFor !== "function") throw new Error("catchUpRows: fieldsFor is required");
  const done = new Set((marks || []).filter((m) => m && m.coin === coin && isYmd(m.d)).map((m) => m.d));
  const priced = (bars || []).filter((b) => b && isYmd(b.d) && b.d < today && Number.isFinite(b.c) && b.c > 0).sort((p, q) => (p.d < q.d ? -1 : p.d > q.d ? 1 : 0));
  if (!priced.length) return [];
  const last = priced[priced.length - 1], byD = new Map(priced.map((b) => [b.d, b]));
  const first = done.size ? [...done].sort()[0] : last.d;
  const stamp = markedOn ? { markedOn } : {};
  const rows = [];
  for (let d = first, guard = 0; d <= last.d; d = addDays(d, 1)) {
    if (++guard > 4000) throw new Error(`catchUpRows: ${coin} span from ${first} is over 4000 days — refusing`);
    if (done.has(d)) continue;
    const isLast = d === last.d, b = byD.get(d);
    if (!b) { rows.push({ coin, d, gap: true, reason: d < priced[0].d ? "before the fetched daily-bar window" : "no completed daily bar for this UTC day", ...stamp }); continue; }
    const f = fieldsFor(d, { isLast });
    if (!f) { rows.push({ coin, d, gap: true, reason: "the book held on this day is not known", ...stamp }); continue; }
    rows.push({ coin, d, close: b.c, ...f, ...(isLast ? {} : { catchUp: true, ...stamp }) });
  }
  return rows;
}

/** Rows that carry a price (gap rows and malformed rows excluded) — what a reader may compute returns from. */
const pricedMarks = (marks) => (marks || []).filter((m) => m && !m.gap && isYmd(m.d) && Number.isFinite(m.close) && m.close > 0);

module.exports = { catchUpRows, pricedMarks, addDays, isYmd };
