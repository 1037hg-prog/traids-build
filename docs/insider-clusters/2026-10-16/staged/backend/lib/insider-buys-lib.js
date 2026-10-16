"use strict";
/**
 * INSIDER BUYS — the company-day record, and the dated JSONL it lives in. Pure: no clock, no disk, no network. 2026-10-16.
 *
 * THE RECORD. One line per COMPANY per TRANSACTION DAY: how many DISTINCT insiders bought on the open market that day, how many
 * dollars, and in what roles. The day is the day they BOUGHT (the Form 4's transactionDate), not the day the filing appeared —
 * a filing is allowed two business days, and three insiders buying on one Tuesday are one Tuesday's cluster however the paperwork
 * lands. The filing dates are kept on the record too (`firstFiledOn`, `lastFiledOn`, `filingLagDays`), because for anything that
 * TRADES on this the public moment is the filing, not the purchase: a reader that must not look ahead keys off the filing date, and
 * the record carries both rather than making one of them unavailable.
 *
 * DOLLARS ARE SUMMED OVER ACCESSIONS, INSIDERS ARE COUNTED OVER OWNERS. A Form 4 with two reporting owners (a trust and its trustee)
 * reports ONE set of purchases twice over; adding the filing's dollars once per owner doubles the money. So `usd` is the sum over
 * distinct ACCESSIONS and `insiders` is the count of distinct OWNER CIKs.
 *
 * EVERY PER-INSIDER FIGURE IS DERIVED, NEVER ACCUMULATED. `accessions` is the record's ledger: each entry carries the filing's own
 * dollars, shares and the owner CIKs that reported it. `byInsider[].usd` is then computed as the sum, over the filings that insider
 * reported, of that filing's dollars divided by its number of reporting owners. So:
 *   - the per-insider dollars always add back up to the day's `usd` (the selftest holds this),
 *   - a joint filing's even split is the record's ONE assumption, visible in `jointFilings`, and
 *   - merging is exact at any order and any number of runs: nothing is carried as a running total that a second look could
 *     double. Re-reading a filing already in the record adds nothing at all.
 *
 * MERGING IS IDEMPOTENT, AND THAT IS THE POINT. The same company-day is written by more than one run: the fourth insider's filing
 * arrives two days after the first three. `mergeDays` and `mergeJsonl` are what the collector and the cluster finder both use, so a
 * merged day reads the same whether it was built in one run or five.
 */

const SPEC = "insider-buys-v1", KIND_DAY = "company-day", KIND_RUN = "run";
const round = (n, p) => { const f = 10 ** p; return Math.round(n * f) / f; };
const isoDay = (v) => { const s = String(v || "").trim().slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s + "T12:00:00Z")) ? s : null; };
const dayDiff = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5);
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** the working shape one company-day is built in: a ledger of filings, and who reported each */
function emptyDay(cik, tradeDate) { return { cik, tradeDate, sym: null, issuer: null, acc: new Map(), ins: new Map() }; }

/**
 * Add one filing's purchases for one trade date into a working day.
 * `owners` are that filing's QUALIFYING owners only ({ cik, role, officerTitle }); `usd` and `shares` are the FILING's totals for
 * this date. An accession already in the day is skipped whole: that is what makes a second run of the same filing cost nothing.
 */
function addFiling(day, { accession, filedOn, sym, issuer, owners, usd, shares }) {
  if (!accession) throw new Error("insider-buys: a filing must bring its accession number (the dollars are keyed by it)");
  if (!Array.isArray(owners) || !owners.length) throw new Error(`insider-buys: ${accession} has no qualifying owner — it should not have reached the record`);
  for (const o of owners) if (!o || !o.cik) throw new Error(`insider-buys: ${accession} has an owner with no CIK — refused (a nameless insider cannot be counted as distinct)`);
  if (day.acc.has(accession)) return { added: false };
  day.acc.set(accession, {
    accession, filedOn: isoDay(filedOn),
    usd: round(Number(usd) || 0, 2), shares: round(Number(shares) || 0, 6),
    owners: owners.map((o) => o.cik).sort(),
  });
  if (sym && !day.sym) day.sym = String(sym).toUpperCase();
  if (issuer && !day.issuer) day.issuer = String(issuer);
  for (const o of owners) {
    const cur = day.ins.get(o.cik) || { ownerCik: o.cik, isOfficer: false, isDirector: false, titles: new Set() };
    if (o.role === "officer" || o.role === "officer-and-director") cur.isOfficer = true;
    if (o.role === "director" || o.role === "officer-and-director") cur.isDirector = true;
    if (o.officerTitle) cur.titles.add(String(o.officerTitle).toUpperCase());
    day.ins.set(o.cik, cur);
  }
  return { added: true };
}

/** the working day -> the JSONL record, keys in one fixed order so two runs that found the same thing write the same bytes */
function finalizeDay(day, { collectedOn = null } = {}) {
  const accessions = [...day.acc.values()].sort((a, b) => byKey(a.accession, b.accession));
  const insiders = [...day.ins.values()].sort((a, b) => byKey(a.ownerCik, b.ownerCik)).map((i) => {
    const mine = accessions.filter((a) => a.owners.includes(i.ownerCik));
    return {
      ownerCik: i.ownerCik,
      role: i.isOfficer && i.isDirector ? "officer-and-director" : i.isOfficer ? "officer" : "director",
      titles: [...i.titles].sort(),
      usd: round(mine.reduce((s, a) => s + a.usd / a.owners.length, 0), 2),
      shares: round(mine.reduce((s, a) => s + a.shares / a.owners.length, 0), 6),
      accessions: mine.map((a) => a.accession),
    };
  });
  const roles = { officer: 0, director: 0, officerAndDirector: 0 };
  for (const i of insiders) roles[i.role === "officer-and-director" ? "officerAndDirector" : i.role]++;
  const filedDays = accessions.map((a) => a.filedOn).filter(Boolean).sort();
  return {
    spec: SPEC, kind: KIND_DAY,
    cik: day.cik, sym: day.sym || null, issuer: day.issuer || null,
    tradeDate: day.tradeDate,
    insiders: insiders.length,
    usd: round(accessions.reduce((s, a) => s + a.usd, 0), 2),
    shares: round(accessions.reduce((s, a) => s + a.shares, 0), 6),
    roles,
    roleList: Object.entries(roles).filter(([, n]) => n > 0).map(([k]) => (k === "officerAndDirector" ? "officer-and-director" : k)).sort(),
    titles: [...new Set(insiders.flatMap((i) => i.titles))].sort(),
    byInsider: insiders,
    accessions,
    filings: accessions.length,
    jointFilings: accessions.filter((a) => a.owners.length > 1).length,
    firstFiledOn: filedDays[0] || null,
    lastFiledOn: filedDays.length ? filedDays[filedDays.length - 1] : null,
    filingLagDays: filedDays.length ? dayDiff(day.tradeDate, filedDays[filedDays.length - 1]) : null,
    collectedOn: isoDay(collectedOn),
  };
}

/** a finished record -> a working day again, so merging two records runs the same code that built them */
function thawDay(rec) {
  if (!rec || !rec.cik || !isoDay(rec.tradeDate)) throw new Error("insider-buys: thawDay was given something that is not a company-day record");
  const day = emptyDay(rec.cik, rec.tradeDate);
  day.sym = rec.sym || null; day.issuer = rec.issuer || null;
  for (const a of rec.accessions || []) {
    if (!a || !a.accession) throw new Error(`insider-buys: ${rec.cik}/${rec.tradeDate} has a filing entry with no accession — refused`);
    const owners = Array.isArray(a.owners) ? [...a.owners].sort() : [];
    if (!owners.length) throw new Error(`insider-buys: ${a.accession} in ${rec.cik}/${rec.tradeDate} names no reporting owner — refused (the per-insider dollars are derived from it)`);
    day.acc.set(a.accession, { accession: a.accession, filedOn: isoDay(a.filedOn), usd: round(Number(a.usd) || 0, 2), shares: round(Number(a.shares) || 0, 6), owners });
  }
  for (const i of rec.byInsider || []) day.ins.set(i.ownerCik, {
    ownerCik: i.ownerCik,
    isOfficer: i.role === "officer" || i.role === "officer-and-director",
    isDirector: i.role === "director" || i.role === "officer-and-director",
    titles: new Set(i.titles || []),
  });
  return day;
}

/** two records for the SAME company-day -> one. Keyed by accession throughout, so merging a record with itself returns it unchanged. */
function mergeDay(a, b, { collectedOn = null } = {}) {
  if (a.cik !== b.cik || a.tradeDate !== b.tradeDate) throw new Error(`insider-buys: mergeDay was given two different company-days (${a.cik}/${a.tradeDate} and ${b.cik}/${b.tradeDate})`);
  const day = thawDay(a), extra = thawDay(b);
  if (!day.sym) day.sym = extra.sym;
  if (!day.issuer) day.issuer = extra.issuer;
  for (const [acc, e] of extra.acc) if (!day.acc.has(acc)) day.acc.set(acc, e);
  for (const [cik, i] of extra.ins) {
    const cur = day.ins.get(cik);
    if (!cur) { day.ins.set(cik, { ownerCik: i.ownerCik, isOfficer: i.isOfficer, isDirector: i.isDirector, titles: new Set(i.titles) }); continue; }
    cur.isOfficer = cur.isOfficer || i.isOfficer; cur.isDirector = cur.isDirector || i.isDirector;
    for (const t of i.titles) cur.titles.add(t);
  }
  return finalizeDay(day, { collectedOn: collectedOn || a.collectedOn || b.collectedOn });
}

/** many records, in any order, from any number of runs -> one record per company-day, sorted by (cik, tradeDate) */
function mergeDays(records, { collectedOn = null } = {}) {
  const by = new Map();
  for (const r of records) {
    const k = `${r.cik}|${r.tradeDate}`;
    by.set(k, by.has(k) ? mergeDay(by.get(k), r, { collectedOn }) : r);
  }
  return [...by.values()].sort((x, y) => byKey(x.cik, y.cik) || byKey(x.tradeDate, y.tradeDate));
}

/**
 * The same merge, but a company-day that CANNOT be merged is set aside instead of throwing: a record damaged by hand (a filing
 * entry with no reporting owner, no accession) would otherwise take the whole run down, and the run would then be the only thing
 * that noticed. Set aside, it reaches `lostDaysOf` below, the collector refuses the write, and the file is left exactly as it is for
 * someone to look at.
 */
function mergeDaysTolerant(records, { collectedOn = null } = {}) {
  const groups = new Map();
  for (const r of records) {
    const k = `${r && r.cik}|${r && r.tradeDate}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(r);
  }
  const merged = [], unmergeable = [];
  for (const [k, list] of groups) {
    try { merged.push(list.length === 1 ? verify(list[0]) : list.reduce((a, b) => mergeDay(a, b, { collectedOn }))); }
    catch (e) { unmergeable.push({ key: k, why: String(e && e.message || e).slice(0, 200) }); }
  }
  merged.sort((x, y) => byKey(x.cik, y.cik) || byKey(x.tradeDate, y.tradeDate));
  return { merged, unmergeable };
}
/** a lone record still has to be a record this library can read; thawDay is the reader, so it is the check */
function verify(rec) { thawDay(rec); return rec; }

/**
 * The company-days that were in a file and are NOT in what would replace it. A merge only adds, so this is empty — and the
 * collector REFUSES to write when it is not. A collector that silently shrinks its own history is the failure this exists for, and
 * it is a separate function so that the guard can be held to a known answer rather than only to a case that cannot happen.
 */
function lostDaysOf(oldRecords, mergedRecords) {
  const have = new Set((mergedRecords || []).map((r) => `${r.cik}|${r.tradeDate}`));
  return [...new Set((oldRecords || []).map((r) => `${r.cik}|${r.tradeDate}`))].filter((k) => !have.has(k));
}

/** the JSONL text for a set of records plus the run line that says how they were got (a reader filters on `kind`) */
function serializeJsonl(records, runLine = null) {
  const lines = mergeDays(records).map((r) => JSON.stringify(r));
  if (runLine) lines.push(JSON.stringify({ spec: SPEC, kind: KIND_RUN, ...runLine }));
  return lines.length ? lines.join("\n") + "\n" : "";
}

/**
 * JSONL text -> { records, runs, bad }. A line that will not parse, or that is not this spec, goes to `bad` with its number:
 * a torn tail (a crash mid-write cannot happen through writeTextAtomic, but a hand edit can) is REPORTED, never skipped quietly.
 */
function parseJsonl(text) {
  const out = { records: [], runs: [], bad: [] };
  const lines = String(text || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s) continue;
    let j;
    try { j = JSON.parse(s); } catch (e) { out.bad.push({ line: i + 1, why: `not JSON (${e.message.slice(0, 80)})` }); continue; }
    if (!j || typeof j !== "object") { out.bad.push({ line: i + 1, why: "not an object" }); continue; }
    if (j.spec !== SPEC) { out.bad.push({ line: i + 1, why: `spec "${j.spec}" is not ${SPEC}` }); continue; }
    if (j.kind === KIND_RUN) { out.runs.push(j); continue; }
    if (j.kind !== KIND_DAY) { out.bad.push({ line: i + 1, why: `kind "${j.kind}" is neither ${KIND_DAY} nor ${KIND_RUN}` }); continue; }
    if (!j.cik || !isoDay(j.tradeDate) || !Number.isFinite(j.insiders)) { out.bad.push({ line: i + 1, why: "a company-day with no cik, no readable tradeDate or no insider count" }); continue; }
    out.records.push(j);
  }
  return out;
}

/**
 * Merge new records into a dated file's existing text.
 * Returns { text, records, before, after, added, updated, unchanged, bad, runs, unmergeable, lostDays }. `lostDays` is the
 * company-days that were in the file and are NOT in the result — a day set aside as unmergeable is one of them, and the collector
 * refuses to write at all when the list is not empty, so a damaged file is never rewritten with one of its days gone.
 */
function mergeJsonl(existingText, newRecords, { runLine = null, collectedOn = null } = {}) {
  const old = parseJsonl(existingText);
  const { merged, unmergeable } = mergeDaysTolerant([...old.records, ...newRecords], { collectedOn });
  const oldByKey = new Map(old.records.map((r) => [`${r.cik}|${r.tradeDate}`, r]));
  let added = 0, updated = 0, unchanged = 0;
  for (const r of merged) {
    const before = oldByKey.get(`${r.cik}|${r.tradeDate}`);
    if (!before) added++;
    else if (JSON.stringify(before) === JSON.stringify(r)) unchanged++;
    else updated++;
  }
  return {
    text: serializeJsonl(merged, runLine), records: merged,
    before: old.records.length, after: merged.length, added, updated, unchanged,
    bad: old.bad, runs: old.runs, unmergeable,
    lostDays: lostDaysOf(old.records, merged),
  };
}

module.exports = { SPEC, KIND_DAY, KIND_RUN, emptyDay, addFiling, finalizeDay, thawDay, mergeDay, mergeDays, mergeDaysTolerant, lostDaysOf, serializeJsonl, parseJsonl, mergeJsonl, isoDay, dayDiff, round };
