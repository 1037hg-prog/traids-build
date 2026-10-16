#!/usr/bin/env node
"use strict";
/**
 * MAKE FIXTURES — writes fixtures/filings.json, the manifest the collector's --from-dir mode reads. 2026-10-16.
 *
 * It exists because JSON in this repository is only ever written by a node script through backend/lib/atomic-write.js, never by a
 * shell redirection or by hand. The filing texts beside it are plain text and are written as text.
 *
 *   node docs/wording-change/2026-10-16/fixtures/make-fixtures.cjs --write    (re)write filings.json
 *   node docs/wording-change/2026-10-16/fixtures/make-fixtures.cjs --check    exit 0 when the file on disk is what this generates
 *
 * EVERYTHING HERE IS INVENTED. The two companies do not exist, the CIKs are 1 and 2, the accession numbers are made up, and the
 * filing texts are a few paragraphs written for this package. Two sections carry the words alpha/beta/gamma/delta on purpose: their
 * cosine can be worked out by hand (see NOTES.md), which is what makes them a known answer rather than a recorded output.
 */
const fs = require("fs"), path = require("path");
const HERE = __dirname, REPO = path.resolve(HERE, "..", "..", "..", "..");
const { writeJsonAtomic } = require(path.join(REPO, "backend", "lib", "atomic-write.js"));
const FILE = path.join(HERE, "filings.json");

const FILINGS = [
  { cik: "0000000001", symbol: "ZZZZ", companyName: "SAMPLE WIDGETS INC", form: "10-K", filingDate: "2024-02-20", reportDate: "2023-12-31", accession: "0000000001-24-000002", file: "zzzz-10k-2024.txt" },
  { cik: "0000000001", symbol: "ZZZZ", companyName: "SAMPLE WIDGETS INC", form: "10-Q", filingDate: "2024-05-07", reportDate: "2024-03-31", accession: "0000000001-24-000006", file: "zzzz-10q-2024q1.txt" },
  { cik: "0000000001", symbol: "ZZZZ", companyName: "SAMPLE WIDGETS INC", form: "10-K", filingDate: "2025-02-18", reportDate: "2024-12-31", accession: "0000000001-25-000003", file: "zzzz-10k-2025.txt" },
  { cik: "0000000001", symbol: "ZZZZ", companyName: "SAMPLE WIDGETS INC", form: "10-Q", filingDate: "2025-05-06", reportDate: "2025-03-31", accession: "0000000001-25-000009", file: "zzzz-10q-2025q1.txt" },
  { cik: "0000000002", symbol: "YYYY", companyName: "SAMPLE GADGETS CORP", form: "10-K", filingDate: "2025-03-14", reportDate: "2024-12-31", accession: "0000000002-25-000004", file: "yyyy-10k-2025.htm" },
];

function missing() { return FILINGS.filter((f) => !fs.existsSync(path.join(HERE, f.file))).map((f) => f.file); }
function check() {
  const gone = missing();
  if (gone.length) { console.error("make-fixtures: filing text missing: " + gone.join(", ")); return false; }
  let have;
  try { have = fs.readFileSync(FILE, "utf8"); } catch { console.error(`make-fixtures: ${FILE} is missing — run --write`); return false; }
  const want = JSON.stringify(FILINGS, null, 1);
  if (have.trim() !== want.trim()) { console.error("make-fixtures: filings.json differs from what this script generates — run --write"); return false; }
  console.log(`make-fixtures: filings.json is current (${FILINGS.length} filings, ${new Set(FILINGS.map((f) => f.cik)).size} companies) — PASSED`);
  return true;
}
if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.length === 1 && a[0] === "--write") {
    const gone = missing();
    if (gone.length) { console.error("make-fixtures: filing text missing: " + gone.join(", ")); process.exitCode = 1; }
    else { writeJsonAtomic(FILE, FILINGS); console.log(`make-fixtures: wrote ${FILE} (${FILINGS.length} filings)`); process.exitCode = 0; }
  } else if (a.length === 1 && a[0] === "--check") process.exitCode = check() ? 0 : 1;
  else { console.log("usage: node docs/wording-change/2026-10-16/fixtures/make-fixtures.cjs --write | --check"); process.exitCode = 2; }
}
module.exports = { FILINGS, FILE, check };
