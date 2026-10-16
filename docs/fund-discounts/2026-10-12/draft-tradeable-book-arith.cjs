"use strict";
// draft-tradeable-book-arith.cjs  (fund discounts, tradeable-book draft, 2026-10-12)
//
// Every converted figure in draft-tradeable-book.md that is not a published number or a bar comes from here.
// It reads ONE file, scout-universe.json (counts and dates only), and the constants of the draft. It reads no price, no NAV,
// no discount and no return, and makes no request.
//
// Run from the repo root:   node docs/fund-discounts/2026-10-12/draft-tradeable-book-arith.cjs
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const FILE = path.join(__dirname, "scout-universe.json");
const raw = fs.readFileSync(FILE), U = JSON.parse(raw.toString("utf8"));
console.log("scout-universe.json sha256", crypto.createHash("sha256").update(raw).digest("hex"), "| list as of", U.listAsOf, "| funds", U.funds.length);

// ---- the draft's constants ----
const BOOK = 100000, SLOTS = 20, POS = BOOK / SLOTS, TYPE_CAP = 8, GAP_MULT = 3;
// one-way cost by fund type: Cherkes, Sagi and Stanton 2009 (via scout-literature.md section 5); round trip = 2 x one-way
const ONE_WAY = { municipal: 0.40, "taxable bond": 0.54, "U.S. equity": 0.51, "foreign equity": 0.68 };
const TYPE_OF = {
  "Municipal": "municipal", "Municipal-Single State": "municipal", "Municipal-CA": "municipal", "Municipal-NY": "municipal",
  "High Yield": "taxable bond", "Senior Loans": "taxable bond", "Investment Grade": "taxable bond", "Multi-Sector": "taxable bond", "Limited Duration": "taxable bond",
  "Global Income": "taxable bond", "Emerging Market Income": "taxable bond", "Taxable Muni": "taxable bond", "Preferreds": "taxable bond", "Convertibles": "taxable bond",
  "US Equity": "U.S. equity", "Covered Call": "U.S. equity", "Sector Equity": "U.S. equity", "Real Estate": "U.S. equity", "MLP": "U.S. equity", "US Allocation": "U.S. equity",
  "Global Equity": "foreign equity", "Asia Equity": "foreign equity", "Emerging Market Equity": "foreign equity", "Single Country Equity": "foreign equity", "Global Allocation": "foreign equity",
};
const SPANS = { discovery: ["2003-01-01", "2011-12-31"], holdout: ["2012-01-01", "2026-09-30"] };

// ---- 1. the universe by cost type ----
const both = U.funds.filter((f) => f.overlapFirst && f.navRows > 0 && !f.navSymbolRejected);
const unmapped = [...new Set(both.map((f) => f.assetClassIfKnown).filter((c) => !TYPE_OF[c]))];
console.log("\n1. Funds with both series:", both.length, "| asset classes with no cost type:", unmapped.length ? unmapped.join(", ") : "none");
const types = Object.keys(ONE_WAY);
for (const t of types) console.log("  ", t.padEnd(15), String(both.filter((f) => TYPE_OF[f.assetClassIfKnown] === t).length).padStart(4), "funds");
console.log("   price-only funds left out:", U.funds.length - both.length, "(of them Commodity:", U.funds.filter((f) => f.assetClassIfKnown === "Commodity").length + ")");

// ---- 2. cost per round trip and the smallest gap the rule will buy ----
console.log("\n2. Registered round-trip cost, dollars on a $" + POS + " position, and the smallest gap the rule buys (" + GAP_MULT + " x cost):");
for (const t of types) { const rt = 2 * ONE_WAY[t]; console.log("  ", t.padEnd(15), "round trip", rt.toFixed(2) + "%", "= $" + (POS * rt / 100).toFixed(2), "| at 2x $" + (POS * 2 * rt / 100).toFixed(2), "| at 3x $" + (POS * 3 * rt / 100).toFixed(2), "| smallest gap", (GAP_MULT * rt).toFixed(2), "points"); }
const wAvg = types.reduce((s, t) => s + 2 * ONE_WAY[t] * both.filter((f) => TYPE_OF[f.assetClassIfKnown] === t).length, 0) / both.length;
console.log("   fund-count-weighted round trip across the", both.length, "funds:", wAvg.toFixed(3) + "%", "= $" + (POS * wAvg / 100).toFixed(2), "a position");

// ---- 3. what trading costs a year, by how often the book turns over (arithmetic, not a forecast) ----
console.log("\n3. Yearly cost of a full book (" + SLOTS + " x $" + POS + ") at the weighted round trip, by average holding time:");
for (const months of [3, 6, 9, 12]) { const trips = SLOTS * 12 / months, usd = trips * POS * wAvg / 100; console.log("   average hold", String(months).padStart(2), "months ->", String(Math.round(trips * 10) / 10).padStart(4), "round trips a year -> $" + usd.toFixed(0), "a year = $" + (usd / 12).toFixed(0), "a month per $100,000"); }

// ---- 4. months in each span ----
const monthsIn = ([a, b]) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7)) + 1;
console.log("\n4. Calendar months: discovery", monthsIn(SPANS.discovery), "| holdout", monthsIn(SPANS.holdout), "| pooled", monthsIn(SPANS.discovery) + monthsIn(SPANS.holdout));

// ---- 5. how many funds are past the three-year history rule on a date (rough: three calendar years after the first day with both series;
//         ignores the liquidity floor, the stale and weekly screens and the unit quarantine, all of which can only lower it) ----
const plus3 = (d) => { const x = new Date(d + "T00:00:00Z"); x.setUTCFullYear(x.getUTCFullYear() + 3); return x.toISOString().slice(0, 10); };
console.log("\n5. Funds past the three-year history rule (every one alive in October 2026):");
console.log("   date        all  " + types.map((t) => t.padStart(15)).join(""));
for (const d of ["2003-01-02", "2005-01-03", "2007-01-03", "2009-01-02", "2011-01-03", "2012-01-03", "2015-01-02", "2018-01-02", "2021-01-04", "2024-01-02", "2026-09-30"]) {
  const el = both.filter((f) => plus3(f.overlapFirst) <= d);
  console.log("   " + d + " " + String(el.length).padStart(4) + "  " + types.map((t) => String(el.filter((f) => TYPE_OF[f.assetClassIfKnown] === t).length).padStart(15)).join(""));
}

// ---- 6. weekly-value and stale-feed facts the rule's screens rest on (from the scout's table) ----
const wk = both.filter((f) => (f.navWeeklyValueYears || []).length);
console.log("\n6. Funds with at least one year of weekly-value NAV (70 or fewer changes in a year of daily rows):", wk.length, "->", wk.map((f) => f.ticker).join(" "));
console.log("   funds whose longest flat NAV run is 5 rows or more:", both.filter((f) => f.navLongestFlatRun && f.navLongestFlatRun.rows >= 5).length, "| 20 rows or more:", both.filter((f) => f.navLongestFlatRun && f.navLongestFlatRun.rows >= 20).map((f) => f.ticker + "(" + f.navLongestFlatRun.rows + ")").join(" "));
console.log("   term funds on the list:", U.funds.filter((f) => f.termFund).length, "| with both series:", both.filter((f) => f.termFund).length);

// ---- 7. the size of one position against the liquidity floor ----
const FLOOR = 400000;
console.log("\n7. One $" + POS + " position is", (100 * POS / FLOOR).toFixed(2) + "% of a day's trading at the $" + FLOOR + " floor; a full type cap of", TYPE_CAP, "positions is $" + TYPE_CAP * POS, "(" + (100 * TYPE_CAP / SLOTS) + "% of the book)");

// ---- 8. the dollar lines of the decision rule ----
console.log("\n8. Decision lines: catalogue floor 6% a year on $100,000 = $" + (BOOK * 0.06 / 12).toFixed(0) + " a month | too-good line 18.2% a year (the largest published gross long-short figure) = $" + (BOOK * 0.182 / 12).toFixed(0) + " a month");
