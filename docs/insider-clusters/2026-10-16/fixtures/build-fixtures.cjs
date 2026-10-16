#!/usr/bin/env node
"use strict";
/**
 * FIXTURE FILINGS — the saved SEC Form 4 submissions the package's selftest reads instead of the network. 2026-10-16.
 *
 *   node docs/insider-clusters/2026-10-16/fixtures/build-fixtures.cjs            check: every saved fixture matches this builder
 *   node docs/insider-clusters/2026-10-16/fixtures/build-fixtures.cjs --write    rewrite the fixture tree from this file
 *
 * WHY A BUILDER AND SAVED FILES BOTH. The tests read the SAVED files (fixtures/filings/*.txt, fixtures/daily-index/*.idx): that is
 * what a fixture is — the bytes a filing really has, including the SGML wrapper the SEC serves it in. This builder is how they were
 * made, kept so that the whole set is reproducible and REVIEWABLE in one place, and the selftest holds every saved file to it byte
 * for byte (check A). A fixture quietly edited to make a test pass therefore fails the selftest instead.
 *
 * EVERYTHING IN HERE IS PLAINLY FAKE and holds no personal detail: issuers are FIXTURE ALPHA CORP … FIXTURE ECHO PLC with tickers
 * AAAA … EEEE, and a reporting owner is "FIXTURE OWNER ONE", never a person. The CIKs are 00010000xx (issuers), 00020000xx (owners)
 * and 0009000001 (the filing agent in every accession number). No key, token, address or contact string appears anywhere.
 *
 * THE CAST, and what each filing is for (the expected answers live in selftest.cjs, not here):
 *   AAAA  the cluster that only exists because Thanksgiving is closed: OWNER ONE buys 2026-11-16, OWNER TWO 2026-11-16 and 11-17,
 *         OWNER NINE 2026-11-30 — ten trading days inclusive from 11-16 BECAUSE 2026-11-26 is a market holiday (eleven weekdays).
 *         OWNER TEN then buys 12-01, on a day the first cluster has spent, and starts no second cluster.
 *         OWNER ONE buys on two days, to prove "distinct insiders" counts people, not filings; OWNER TWO files as a director once
 *         and as an officer-and-director once, to prove the role is the union.
 *   BBBB  a cluster whose first buy is dated on a SATURDAY (placed on the next trading day), plus a ten-percent-owner-only filing
 *         that must not count.
 *   CCCC  a filing with sales, an award and an exercise but no purchase; one coded P but DISPOSED (not a purchase, whatever the
 *         code says); and a TRUNCATED filing that must read as unresolved.
 *   DDDD  a purchase with no price (a footnote instead of a number) and a purchase of preferred stock: both excluded.
 *   EEEE  a JOINT filing (two reporting owners, one set of purchases: the dollars count once, the insiders twice), and a third
 *         insider buying 2026-12-01 — eleven trading days from 11-16, so EEEE has three insiders and NO cluster.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const HERE = __dirname;
const AGENT = "0009000001";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

const ISSUERS = {
  AAAA: { cik: "0001000001", name: "FIXTURE ALPHA CORP" },
  BBBB: { cik: "0001000002", name: "FIXTURE BRAVO INC" },
  CCCC: { cik: "0001000003", name: "FIXTURE CHARLIE LTD" },
  DDDD: { cik: "0001000004", name: "FIXTURE DELTA CO" },
  EEEE: { cik: "0001000005", name: "FIXTURE ECHO PLC" },
};
const OWNERS = {
  ONE: { cik: "0002000001", name: "FIXTURE OWNER ONE" }, TWO: { cik: "0002000002", name: "FIXTURE OWNER TWO" },
  THREE: { cik: "0002000003", name: "FIXTURE OWNER THREE" }, FOUR: { cik: "0002000004", name: "FIXTURE OWNER FOUR" },
  FIVE: { cik: "0002000005", name: "FIXTURE OWNER FIVE" }, SIX: { cik: "0002000006", name: "FIXTURE OWNER SIX" },
  SEVEN: { cik: "0002000007", name: "FIXTURE OWNER SEVEN" }, EIGHT: { cik: "0002000008", name: "FIXTURE OWNER EIGHT" },
  NINE: { cik: "0002000009", name: "FIXTURE OWNER NINE" }, TEN: { cik: "0002000010", name: "FIXTURE OWNER TEN" },
  ELEVEN: { cik: "0002000011", name: "FIXTURE OWNER ELEVEN" }, TWELVE: { cik: "0002000012", name: "FIXTURE OWNER TWELVE" },
  THIRTEEN: { cik: "0002000013", name: "FIXTURE OWNER THIRTEEN" },
};

/** one <reportingOwner> block, as the SEC's own schema writes it */
function ownerXml(key, { director = false, officer = false, tenPercent = false, other = false, title = null }) {
  const o = OWNERS[key];
  return [
    "    <reportingOwner>",
    "        <reportingOwnerId>",
    `            <rptOwnerCik>${o.cik}</rptOwnerCik>`,
    `            <rptOwnerName>${o.name}</rptOwnerName>`,
    "        </reportingOwnerId>",
    "        <reportingOwnerRelationship>",
    `            <isDirector>${director ? 1 : 0}</isDirector>`,
    `            <isOfficer>${officer ? 1 : 0}</isOfficer>`,
    `            <isTenPercentOwner>${tenPercent ? 1 : 0}</isTenPercentOwner>`,
    `            <isOther>${other ? 1 : 0}</isOther>`,
    ...(title ? [`            <officerTitle>${title}</officerTitle>`] : []),
    "        </reportingOwnerRelationship>",
    "    </reportingOwner>",
  ].join("\n");
}

/** one <nonDerivativeTransaction>. price === null writes a footnote where the number would be (a real filing's way of saying none) */
function transactionXml({ title = "COMMON STOCK", date, code, shares, price, ad = "A" }) {
  return [
    "        <nonDerivativeTransaction>",
    `            <securityTitle><value>${title}</value></securityTitle>`,
    `            <transactionDate><value>${date}</value></transactionDate>`,
    "            <transactionCoding>",
    "                <transactionFormType>4</transactionFormType>",
    `                <transactionCode>${code}</transactionCode>`,
    "                <equitySwapInvolved>0</equitySwapInvolved>",
    "            </transactionCoding>",
    "            <transactionAmounts>",
    `                <transactionShares><value>${shares}</value></transactionShares>`,
    price === null ? '                <transactionPricePerShare><footnoteId id="F1"/></transactionPricePerShare>'
      : `                <transactionPricePerShare><value>${price}</value></transactionPricePerShare>`,
    `                <transactionAcquiredDisposedCode><value>${ad}</value></transactionAcquiredDisposedCode>`,
    "            </transactionAmounts>",
    "            <postTransactionAmounts>",
    "                <sharesOwnedFollowingTransaction><value>10000</value></sharesOwnedFollowingTransaction>",
    "            </postTransactionAmounts>",
    "            <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature>",
    "        </nonDerivativeTransaction>",
  ].join("\n");
}

/** the whole submission: the SGML wrapper the SEC serves, with the ownership XML inside it */
function submission({ accession, filedOn, documentType = "4", issuer, period, owners, transactions, truncate = false, extraDocument = false }) {
  const iss = ISSUERS[issuer];
  const xml = [
    '<?xml version="1.0"?>',
    "<ownershipDocument>",
    "    <schemaVersion>X0508</schemaVersion>",
    `    <documentType>${documentType}</documentType>`,
    `    <periodOfReport>${period}</periodOfReport>`,
    ...(documentType === "4/A" ? ["    <notSubjectToSection16>0</notSubjectToSection16>"] : []),
    "    <issuer>",
    `        <issuerCik>${iss.cik}</issuerCik>`,
    `        <issuerName>${iss.name}</issuerName>`,
    `        <issuerTradingSymbol>${issuer}</issuerTradingSymbol>`,
    "    </issuer>",
    ...owners.map(([key, rel]) => ownerXml(key, rel)),
    "    <nonDerivativeTable>",
    ...transactions.map(transactionXml),
    "    </nonDerivativeTable>",
    '    <footnotes><footnote id="F1">No price is reported for this transaction.</footnote></footnotes>',
    "    <ownerSignature>",
    "        <signatureName>FIXTURE SIGNATURE</signatureName>",
    `        <signatureDate>${filedOn}</signatureDate>`,
    "    </ownerSignature>",
    "</ownershipDocument>",
  ].join("\n");
  const body = truncate ? xml.slice(0, Math.floor(xml.length / 2)) : xml;      // a filing cut off mid-document: unreadable, not empty
  const head = [
    `<SEC-DOCUMENT>${accession}.txt : ${filedOn.replace(/-/g, "")}`,
    `<SEC-HEADER>${accession}.hdr.sgml : ${filedOn.replace(/-/g, "")}`,
    "ACCESSION NUMBER:\t\t" + accession,
    "CONFORMED SUBMISSION TYPE:\t" + documentType,
    "PUBLIC DOCUMENT COUNT:\t\t1",
    "CONFORMED PERIOD OF REPORT:\t" + period.replace(/-/g, ""),
    "FILED AS OF DATE:\t\t" + filedOn.replace(/-/g, ""),
    "</SEC-HEADER>",
  ].join("\n");
  // an exhibit BEFORE the Form 4 document, so a parser that takes the first <XML> block in the file reads the wrong one
  const exhibit = extraDocument ? ["<DOCUMENT>", "<TYPE>EX-24", "<SEQUENCE>2", "<FILENAME>poa.xml", "<TEXT>", "<XML>",
    '<?xml version="1.0"?>', "<ownershipDocument><documentType>EXHIBIT</documentType></ownershipDocument>", "</XML>", "</TEXT>", "</DOCUMENT>"].join("\n") + "\n" : "";
  return [head, exhibit + "<DOCUMENT>", "<TYPE>" + documentType, "<SEQUENCE>1", "<FILENAME>form4.xml", "<DESCRIPTION>FORM " + documentType, "<TEXT>", "<XML>", body, "</XML>", "</TEXT>", "</DOCUMENT>", "</SEC-DOCUMENT>", ""].join("\n");
}

const acc = (n) => `${AGENT}-26-${String(n).padStart(6, "0")}`;

/** every fixture filing: [ accession, issuer, filedOn, the submission's own settings ] */
const FILINGS = [
  // ── filed 2026-11-17 ─────────────────────────────────────────────────────────────────────────────────────────────────────
  { n: 1, issuer: "AAAA", filedOn: "2026-11-17", period: "2026-11-16", owners: [["ONE", { officer: true, title: "CHIEF FINANCIAL OFFICER" }]],
    transactions: [{ date: "2026-11-16", code: "P", shares: 1000, price: "10.00" }] },                                     // $10,000
  { n: 2, issuer: "AAAA", filedOn: "2026-11-17", period: "2026-11-16", owners: [["TWO", { director: true }]],
    transactions: [{ date: "2026-11-16", code: "P", shares: 500, price: "12.00" }] },                                      // $6,000
  { n: 3, issuer: "BBBB", filedOn: "2026-11-17", period: "2026-11-16", owners: [["THREE", { tenPercent: true }]],
    transactions: [{ date: "2026-11-16", code: "P", shares: 2000, price: "5.00" }] },                                      // a 10% holder: never counted
  { n: 4, issuer: "CCCC", filedOn: "2026-11-17", period: "2026-11-16", owners: [["FOUR", { officer: true, title: "CHIEF EXECUTIVE OFFICER" }]],
    transactions: [{ date: "2026-11-16", code: "S", shares: 100, price: "20.00", ad: "D" }, { date: "2026-11-16", code: "A", shares: 500, price: "0.00" },
      { date: "2026-11-16", code: "M", shares: 250, price: "1.00" }] },                                                    // a sale, an award, an exercise: no purchase
  { n: 5, issuer: "DDDD", filedOn: "2026-11-17", period: "2026-11-16", owners: [["FIVE", { director: true }]],
    transactions: [{ date: "2026-11-16", code: "P", shares: 100, price: null }, { title: "PREFERRED STOCK, SERIES A", date: "2026-11-16", code: "P", shares: 50, price: "100.00" }] },
  { n: 6, issuer: "AAAA", filedOn: "2026-11-17", period: "2026-11-16", documentType: "4/A", owners: [["ONE", { officer: true, title: "CHIEF FINANCIAL OFFICER" }]],
    transactions: [{ date: "2026-11-16", code: "P", shares: 1000, price: "10.00" }] },                                     // restates filing 1: never summed
  { n: 7, issuer: "EEEE", filedOn: "2026-11-17", period: "2026-11-16", extraDocument: true,
    owners: [["SIX", { officer: true, title: "CHIEF EXECUTIVE OFFICER" }], ["SEVEN", { director: true }]],
    transactions: [{ date: "2026-11-16", code: "P", shares: 800, price: "25.00" }] },                                      // $20,000 ONCE, two insiders
  { n: 8, issuer: "CCCC", filedOn: "2026-11-17", period: "2026-11-16", truncate: true, owners: [["FOUR", { officer: true }]],
    transactions: [{ date: "2026-11-16", code: "P", shares: 100, price: "9.00" }] },                                       // cut off: unresolved, never "no purchase"
  // ── filed 2026-11-18 ─────────────────────────────────────────────────────────────────────────────────────────────────────
  { n: 9, issuer: "AAAA", filedOn: "2026-11-18", period: "2026-11-17", owners: [["ONE", { officer: true, title: "CHIEF FINANCIAL OFFICER" }]],
    transactions: [{ date: "2026-11-17", code: "P", shares: 200, price: "11.00" }] },                                      // $2,200 — the same insider, a second day
  { n: 10, issuer: "AAAA", filedOn: "2026-11-18", period: "2026-11-17", owners: [["TWO", { director: true, officer: true, title: "CHIEF OPERATING OFFICER" }]],
    transactions: [{ date: "2026-11-17", code: "P", shares: 300, price: "11.00" }] },                                      // $3,300 — a director in filing 2, now also an officer
  { n: 11, issuer: "CCCC", filedOn: "2026-11-18", period: "2026-11-17", owners: [["FOUR", { officer: true, title: "CHIEF EXECUTIVE OFFICER" }]],
    transactions: [{ date: "2026-11-17", code: "P", shares: 100, price: "9.00", ad: "D" }] },                              // code P but DISPOSED: not a purchase, whatever the code says
  // ── filed 2026-11-25 ─────────────────────────────────────────────────────────────────────────────────────────────────────
  { n: 15, issuer: "BBBB", filedOn: "2026-11-25", period: "2026-11-21", owners: [["ELEVEN", { officer: true, title: "TREASURER" }]],
    transactions: [{ date: "2026-11-21", code: "P", shares: 100, price: "7.00" }] },                                       // dated on a SATURDAY: placed on 11-23
  { n: 16, issuer: "BBBB", filedOn: "2026-11-25", period: "2026-11-23", owners: [["TWELVE", { director: true }]],
    transactions: [{ date: "2026-11-23", code: "P", shares: 200, price: "7.00" }] },
  { n: 17, issuer: "BBBB", filedOn: "2026-11-25", period: "2026-11-24", owners: [["THIRTEEN", { officer: true, title: "GENERAL COUNSEL" }]],
    transactions: [{ date: "2026-11-24", code: "P", shares: 300, price: "7.00" }] },
  // ── filed 2026-12-01 ─────────────────────────────────────────────────────────────────────────────────────────────────────
  { n: 12, issuer: "AAAA", filedOn: "2026-12-01", period: "2026-11-30", owners: [["NINE", { officer: true, director: true, title: "PRESIDENT" }]],
    transactions: [{ date: "2026-11-30", code: "P", shares: 400, price: "13.00" }] },                                      // $5,200 — the third insider: the cluster triggers
  { n: 13, issuer: "EEEE", filedOn: "2026-12-01", period: "2026-12-01", owners: [["EIGHT", { officer: true, title: "CHIEF FINANCIAL OFFICER" }]],
    transactions: [{ date: "2026-12-01", code: "P", shares: 100, price: "26.00" }] },                                      // eleven trading days from 11-16: no cluster
  { n: 14, issuer: "AAAA", filedOn: "2026-12-01", period: "2026-12-01", owners: [["TEN", { director: true }]],
    transactions: [{ date: "2026-12-01", code: "P", shares: 150, price: "13.00" }] },                                      // a day the first cluster has spent
];

/** the daily master index, as the SEC serves it: CIK|Company Name|Form Type|Date Filed|Filename */
function masterIndex(day) {
  const mine = FILINGS.filter((f) => f.filedOn === day);
  const rows = [];
  for (const f of mine) {
    const iss = ISSUERS[f.issuer], a = acc(f.n), file = `edgar/data/${Number(iss.cik)}/${a}.txt`;
    for (const [key] of f.owners) rows.push([Number(OWNERS[key].cik), OWNERS[key].name, f.documentType || "4", day, file]);
    rows.push([Number(iss.cik), iss.name, f.documentType || "4", day, file]);     // the SEC lists a filing once per filer AND for the issuer
  }
  rows.push([1000099, "FIXTURE FOXTROT CORP", "8-K", day, `edgar/data/1000099/${AGENT}-26-000099.txt`]);
  rows.push([2000099, "FIXTURE OWNER NINETY-NINE", "3", day, `edgar/data/2000099/${AGENT}-26-000098.txt`]);
  return [
    // the real header also carries a contact address and an FTP path; this repository holds no address of any kind, so the
    // fixture header keeps only the lines a parser must step over
    "Description:           Daily Index of EDGAR Dissemination Feed",
    `Last Data Received:    ${day}`,
    "",
    " ",
    "CIK|Company Name|Form Type|Date Filed|File Name",
    "--------------------------------------------------------------------------------",
    ...rows.map((r) => r.join("|")),
    "",
  ].join("\n");
}

const FILING_DAYS = [...new Set(FILINGS.map((f) => f.filedOn))].sort();

/** every fixture file this builder stands behind: relative path -> its bytes */
function files() {
  const out = new Map();
  for (const f of FILINGS) out.set(path.posix.join("filings", `${acc(f.n)}.txt`), Buffer.from(submission({ accession: acc(f.n), ...f }), "utf8"));
  for (const day of FILING_DAYS) out.set(path.posix.join("daily-index", `master.${day.replace(/-/g, "")}.idx`), Buffer.from(masterIndex(day), "utf8"));
  return out;
}

/** check the saved tree against this builder -> { ok, same, differ, missing, extra } */
function check(root = HERE) {
  const want = files(), same = [], differ = [], missing = [];
  for (const [rel, buf] of want) {
    const p = path.join(root, ...rel.split("/"));
    let have = null;
    try { have = fs.readFileSync(p); } catch { /* missing */ }
    if (!have) missing.push(rel);
    else if (sha(have) === sha(buf)) same.push(rel);
    else differ.push(rel);
  }
  const extra = [];
  for (const dir of ["filings", "daily-index"]) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, dir)); } catch { names = []; }
    for (const n of names) if (!want.has(`${dir}/${n}`)) extra.push(`${dir}/${n}`);
  }
  return { ok: !differ.length && !missing.length && !extra.length, same, differ, missing, extra, total: want.size };
}

function write(root = HERE) {
  const want = files();
  for (const [rel, buf] of want) {
    const p = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
  }
  return want.size;
}

module.exports = { ISSUERS, OWNERS, FILINGS, FILING_DAYS, acc, files, check, write, masterIndex, submission, sha, AGENT };

if (require.main === module) {
  if (process.argv.includes("--write")) { const n = write(); console.log(`fixtures: wrote ${n} file(s) under ${HERE}`); process.exit(0); }
  const r = check();
  console.log(`fixtures: ${r.same.length} of ${r.total} saved file(s) match this builder${r.differ.length ? `; DIFFER: ${r.differ.join(", ")}` : ""}${r.missing.length ? `; MISSING: ${r.missing.join(", ")}` : ""}${r.extra.length ? `; EXTRA: ${r.extra.join(", ")}` : ""}`);
  process.exit(r.ok ? 0 : 1);
}
