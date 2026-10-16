"use strict";
// STEP 1 PROBE: does Nasdaq's public symbol directory give a list of US closed-end funds with tickers?
// Files (public, no login): mfundslist.txt (Mutual Fund Quotation Service directory: every fund NAV symbol with Type and Category),
// nasdaqlisted.txt and otherlisted.txt (every exchange-listed symbol). Prints headers, counts and category tallies only.
const { cachedGet, readCount } = require("./scout-lib.cjs");
const BASE = "https://www.nasdaqtrader.com/dynamic/SymDir/";
(async () => {
  for (const f of ["mfundslist.txt", "nasdaqlisted.txt", "otherlisted.txt"]) {
    const r = await cachedGet("symdir-" + f, BASE + f);
    const lines = r.text.split(/\r?\n/).filter(Boolean);
    console.log(`\n== ${f}: HTTP ${r.status}${r.cached ? " (cache)" : ""}, ${lines.length} lines, ${r.text.length} bytes`);
    console.log("header: " + lines[0]);
    console.log("last line: " + lines[lines.length - 1]);
    if (f === "mfundslist.txt" && r.status === 200) {
      const H = lines[0].split("|"), rows = lines.slice(1).map((l) => l.split("|")).filter((a) => a.length === H.length);
      const iT = H.indexOf("Type"), iC = H.indexOf("Category"), iS = H.indexOf("Fund Symbol");
      const tally = {}; for (const a of rows) { const k = a[iT] + "/" + a[iC]; tally[k] = (tally[k] || 0) + 1; }
      console.log("Type/Category tally:", JSON.stringify(tally));
      const xx = rows.filter((a) => /^X[A-Z]{2,4}X$/.test(a[iS]));
      const t2 = {}; for (const a of xx) { const k = a[iT] + "/" + a[iC]; t2[k] = (t2[k] || 0) + 1; }
      console.log(`symbols shaped X....X: ${xx.length}; their Type/Category tally: ${JSON.stringify(t2)}`);
      console.log("three example rows:", rows.filter((a) => ["XPDIX", "XGAMX", "XADXX"].includes(a[iS])).map((a) => a.join("|")).join("  ##  "));
    }
  }
  console.log("\nrequests so far:", JSON.stringify(readCount()));
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
