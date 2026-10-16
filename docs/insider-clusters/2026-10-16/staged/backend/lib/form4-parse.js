"use strict";
/**
 * FORM 4 PARSE — a filing's text in, its officer / director OPEN-MARKET PURCHASES out. Pure: no clock, no disk, no network. 2026-10-16.
 *
 * WHAT IT READS. The SEC serves a Form 4 as a full-submission text file (the SGML wrapper) holding the ownership XML. Both shapes are
 * accepted: the whole submission (`<DOCUMENT><TYPE>4 … <XML> … </XML>`) and a bare `<ownershipDocument>` (the .xml on its own).
 *
 * WHAT COUNTS AS A QUALIFYING PURCHASE, stated here because every number downstream rests on it:
 *   - the filing is an ORIGINAL Form 4 (documentType "4"). A "4/A" amendment RESTATES a filing already counted, so counting both
 *     double-counts the same purchase; amendments are returned separately (`amendment: true`) and counted, never silently dropped.
 *   - the transaction is NON-DERIVATIVE (an option exercise or a warrant is not an open-market buy; derivative tables are not read),
 *   - transactionCode is "P" and the acquired/disposed code is "A",
 *   - shares > 0 and pricePerShare > 0 (a P with no price — a footnote instead of a number — is counted as `noPrice`, not as $0),
 *   - the security is common / ordinary stock (or a Class A/B line of it) when `commonOnly` is on, which is the default; anything
 *     else is counted as `nonCommon`,
 *   - at least one REPORTING OWNER of the filing is an OFFICER or a DIRECTOR. A pure 10% holder, or a filer who is only "other",
 *     does not count (the question is what the people who run the company do with their own money); such filings are counted as
 *     `notOfficerOrDirector`.
 *
 * TRANSACTION CODE "P" — WHAT IT IS AND IS NOT. The SEC's code P is "open market OR PRIVATE purchase". The filing does not say which,
 * so a privately negotiated purchase is included here and cannot be told apart; that is a property of the SEC's own coding, and it is
 * said in the package's NOTES.md rather than implied away.
 *
 * JOINT FILINGS — THE DOLLAR TRAP. One Form 4 may carry several reporting owners (a trust and its trustee, two family members filing
 * together). Its transaction rows are ONE set of purchases, reported by each of them. Attributing the filing's dollars to every owner
 * would multiply the money by the number of filers, so: the filing's dollars are the filing's (`usd`, counted once per accession) and
 * the owners are the owners (`owners`, each one distinct insider). A caller that sums dollars sums ACCESSIONS; a caller that counts
 * insiders counts OWNERS. `jointFiling` is set when there is more than one qualifying owner, and `usdPerOwner` is the even split for a
 * reader that wants a per-insider figure and accepts that the split is an assumption.
 *
 * WHAT IT RETURNS. parseForm4(text) -> { ok, why?, documentType, amendment, periodOfReport, issuer, owners, qualifyingOwners,
 * nonDerivative: [...every non-derivative row…], buys: [ { tradeDate, shares, usd, rows } … one per transaction DATE … ],
 * excluded: { … counts … } }. An unreadable filing is `{ ok: false, why }` — never an empty filing, which would read as "nobody bought".
 */

const COMMON_RE = /\b(common|ordinary)\b|\bclass\s+[ab]\b/i;
const CODE_PURCHASE = "P", ACQUIRED = "A";
const round = (n, p) => { const f = 10 ** p; return Math.round(n * f) / f; };

/** &amp; &lt; &gt; &quot; &apos; and numeric entities -> their characters (what an XML text node means) */
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * The inner text of every <tag>…</tag> in `xml`, in order, by scanning (never a greedy regex: a 2 MB submission with a dozen
 * footnotes is where a backtracking pattern stops being a parser and becomes a hang).
 * Self-closing <tag/> yields "". Nested tags of the SAME name are not a thing in this schema and are not handled.
 */
function allBlocks(xml, tag) {
  const s = String(xml || ""), out = [], open = `<${tag}`, close = `</${tag}>`;
  let i = 0;
  for (;;) {
    const a = s.indexOf(open, i);
    if (a < 0) return out;
    const nameEnd = a + open.length, after = s[nameEnd];
    if (after !== undefined && after !== ">" && after !== " " && after !== "\t" && after !== "\r" && after !== "\n" && after !== "/") { i = nameEnd; continue; }   // <transactionShares> is not <transactionSharesOwned>
    const gt = s.indexOf(">", nameEnd);
    if (gt < 0) return out;
    if (s[gt - 1] === "/") { out.push(""); i = gt + 1; continue; }
    const b = s.indexOf(close, gt + 1);
    if (b < 0) return out;
    out.push(s.slice(gt + 1, b));
    i = b + close.length;
  }
}
/** the first <tag>…</tag>'s inner text, or null */
function block(xml, tag) { const a = allBlocks(xml, tag); return a.length ? a[0] : null; }
/** the text of <tag> with the whitespace and any child element taken out: "2026-11-16" from <transactionDate><value>2026-11-16</value>… */
function textOf(xml, tag) {
  const b = block(xml, tag);
  if (b === null) return null;
  const v = block(b, "value");
  const raw = v === null ? b : v;
  return decodeEntities(String(raw).replace(/<[^>]*>/g, "")).trim();
}
const numOf = (xml, tag) => { const t = textOf(xml, tag); if (t === null || t === "") return null; const n = Number(String(t).replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
const flagOf = (xml, tag) => { const t = textOf(xml, tag); return t !== null && /^(1|true|y|yes)$/i.test(t.trim()); };
/** a CIK as the SEC writes it in an index: ten digits, no sign, no spaces. Anything else -> null (never a half-read id) */
const cik10 = (v) => { const d = String(v === null || v === undefined ? "" : v).trim().replace(/^0+(?=\d)/, ""); return /^\d{1,10}$/.test(d) ? d.padStart(10, "0") : null; };
/** an ISO day, or null */
const isoDay = (v) => { const s = String(v || "").trim().slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s + "T12:00:00Z")) ? s : null; };

/**
 * The ownership XML inside a full submission, or the text itself when it already is one.
 * Returns { xml, documentType } or null. The DOCUMENT whose <TYPE> is 4 or 4/A is the one read: a Form 4 submission may also carry
 * an exhibit or a cover letter, and reading the first <XML> block in the file is how an exhibit becomes "the filing".
 */
function extractOwnershipXml(text) {
  const s = String(text || "");
  if (!s.trim()) return null;
  const direct = s.indexOf("<ownershipDocument");
  if (!s.includes("<DOCUMENT")) {
    if (direct < 0) return null;
    const end = s.indexOf("</ownershipDocument>");
    return end < 0 ? null : { xml: s.slice(direct, end + "</ownershipDocument>".length), documentType: null };
  }
  for (const doc of allBlocks(s, "DOCUMENT")) {
    const typeLine = /<TYPE>([^\r\n<]*)/.exec(doc);
    const type = typeLine ? typeLine[1].trim() : "";
    if (type !== "4" && type !== "4/A") continue;
    const a = doc.indexOf("<ownershipDocument");
    if (a < 0) continue;
    const b = doc.indexOf("</ownershipDocument>", a);
    if (b < 0) continue;
    return { xml: doc.slice(a, b + "</ownershipDocument>".length), documentType: type };
  }
  return null;
}

/** every <reportingOwner> of the filing -> { cik, name, isDirector, isOfficer, isTenPercentOwner, isOther, officerTitle, qualifies } */
function ownersOf(xml) {
  return allBlocks(xml, "reportingOwner").map((o) => {
    const rel = block(o, "reportingOwnerRelationship") || "";
    const isDirector = flagOf(rel, "isDirector"), isOfficer = flagOf(rel, "isOfficer");
    const title = textOf(rel, "officerTitle");
    return {
      cik: cik10(textOf(o, "rptOwnerCik")),
      name: textOf(o, "rptOwnerName"),
      isDirector, isOfficer,
      isTenPercentOwner: flagOf(rel, "isTenPercentOwner"),
      isOther: flagOf(rel, "isOther"),
      officerTitle: title ? title.toUpperCase().slice(0, 80) : null,
      role: isOfficer && isDirector ? "officer-and-director" : isOfficer ? "officer" : isDirector ? "director" : null,
      qualifies: Boolean(isOfficer || isDirector),
    };
  });
}

/** every <nonDerivativeTransaction> -> a plain row (nulls where the filing says nothing) */
function nonDerivativeRows(xml) {
  const table = block(xml, "nonDerivativeTable");
  if (table === null) return [];
  return allBlocks(table, "nonDerivativeTransaction").map((t) => {
    const coding = block(t, "transactionCoding") || "", amounts = block(t, "transactionAmounts") || "";
    return {
      securityTitle: textOf(t, "securityTitle"),
      tradeDate: isoDay(textOf(t, "transactionDate")),
      code: (textOf(coding, "transactionCode") || "").trim().toUpperCase() || null,
      formType: textOf(coding, "transactionFormType"),
      equitySwap: flagOf(coding, "equitySwapInvolved"),
      shares: numOf(amounts, "transactionShares"),
      pricePerShare: numOf(amounts, "transactionPricePerShare"),
      acquiredDisposed: (textOf(amounts, "transactionAcquiredDisposedCode") || "").trim().toUpperCase() || null,
    };
  });
}

/**
 * parseForm4(text, { commonOnly = true }) -> the filing's qualifying purchases, grouped by TRANSACTION DATE.
 * `buys` is empty for a filing with nothing qualifying — which is the common case and is not a failure. `{ ok: false, why }` is a
 * filing that could not be READ (no ownership document, no issuer CIK, no owners): the caller must treat that as an unread filing,
 * never as a filing with no purchases.
 */
function parseForm4(text, { commonOnly = true } = {}) {
  const found = extractOwnershipXml(text);
  if (!found) return { ok: false, why: "no Form 4 ownership document in this text" };
  const xml = found.xml;
  const documentType = (textOf(xml, "documentType") || found.documentType || "").trim() || null;
  const amendment = documentType === "4/A" || /\/A$/.test(String(documentType || ""));
  const issuerBlock = block(xml, "issuer") || "";
  const issuer = {
    cik: cik10(textOf(issuerBlock, "issuerCik")),
    name: textOf(issuerBlock, "issuerName"),
    symbol: (textOf(issuerBlock, "issuerTradingSymbol") || "").toUpperCase().trim() || null,
  };
  const owners = ownersOf(xml);
  if (!issuer.cik) return { ok: false, why: "no issuer CIK in the ownership document" };
  if (!owners.length) return { ok: false, why: "no reporting owner in the ownership document" };
  if (documentType !== "4" && documentType !== "4/A") return { ok: false, why: `documentType is ${documentType === null ? "absent" : `"${documentType}"`}, not a Form 4` };
  if (owners.some((o) => !o.cik)) return { ok: false, why: "a reporting owner has no readable CIK" };

  const rows = nonDerivativeRows(xml);
  const qualifyingOwners = owners.filter((o) => o.qualifies);
  const excluded = { notPurchase: 0, disposed: 0, nonCommon: 0, noPrice: 0, noShares: 0, noDate: 0, notOfficerOrDirector: 0, amendment: 0, equitySwap: 0 };
  if (amendment) excluded.amendment = 1;
  if (!qualifyingOwners.length) excluded.notOfficerOrDirector = 1;

  const byDate = new Map();
  for (const r of rows) {
    if (r.code !== CODE_PURCHASE) { excluded.notPurchase++; continue; }
    if (r.acquiredDisposed !== ACQUIRED) { excluded.disposed++; continue; }
    if (commonOnly && !COMMON_RE.test(String(r.securityTitle || ""))) { excluded.nonCommon++; continue; }
    if (!(r.shares > 0)) { excluded.noShares++; continue; }
    if (!(r.pricePerShare > 0)) { excluded.noPrice++; continue; }
    if (!r.tradeDate) { excluded.noDate++; continue; }
    if (r.equitySwap) excluded.equitySwap++;
    if (!qualifyingOwners.length || amendment) continue;              // read and counted above, never summed
    const d = byDate.get(r.tradeDate) || { tradeDate: r.tradeDate, shares: 0, usd: 0, rows: 0 };
    d.shares += r.shares; d.usd += r.shares * r.pricePerShare; d.rows++;
    byDate.set(r.tradeDate, d);
  }
  const buys = [...byDate.values()].sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : a.tradeDate > b.tradeDate ? 1 : 0))
    .map((d) => ({ ...d, shares: round(d.shares, 6), usd: round(d.usd, 2), usdPerOwner: round(d.usd / qualifyingOwners.length, 2) }));

  return {
    ok: true, documentType, amendment, periodOfReport: isoDay(textOf(xml, "periodOfReport")),
    issuer, owners, qualifyingOwners, jointFiling: qualifyingOwners.length > 1,
    nonDerivative: rows, buys, excluded,
  };
}

module.exports = { parseForm4, extractOwnershipXml, ownersOf, nonDerivativeRows, allBlocks, block, textOf, numOf, flagOf, decodeEntities, cik10, isoDay, COMMON_RE, CODE_PURCHASE, ACQUIRED };
