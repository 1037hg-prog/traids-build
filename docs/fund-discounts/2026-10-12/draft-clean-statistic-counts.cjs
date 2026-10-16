#!/usr/bin/env node
// draft-clean-statistic-counts.cjs — the availability counts quoted in draft-clean-statistic.md.
//
// Reads ONE file, the data scout's scout-universe.json (counts and dates only). No network, no price, no NAV, no discount,
// no return. It answers: how many funds can the draft's rule use, in which cost group, and from when.
//
// Run:  node docs/fund-discounts/2026-10-12/draft-clean-statistic-counts.cjs
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const FILE = path.join(__dirname, "scout-universe.json");
const raw = fs.readFileSync(FILE), j = JSON.parse(raw), F = j.funds;

// the draft's four cost groups (Cherkes, Sagi and Stanton 2009 fund types) and its foreign-clock classes, by the list's class label
const GROUPS = {
  MUNI: ["Municipal", "Municipal-CA", "Municipal-NY", "Municipal-Single State"],
  TAXABLE_BOND: ["Investment Grade", "High Yield", "Senior Loans", "Limited Duration", "Multi-Sector", "Preferreds", "Convertibles", "Taxable Muni", "Global Income", "Emerging Market Income"],
  US_EQ: ["US Equity", "Sector Equity", "Covered Call", "US Allocation", "Real Estate", "MLP"],
  FOREIGN_EQ: ["Asia Equity", "Emerging Market Equity", "Single Country Equity", "Global Equity", "Global Allocation"],
};
const FOREIGN_CLOCK = ["Asia Equity", "Emerging Market Equity", "Single Country Equity", "Global Equity", "Global Allocation", "Global Income", "Emerging Market Income"];
const groupOf = (c) => Object.keys(GROUPS).find((g) => GROUPS[g].includes(c)) || null;

console.log("file", path.basename(FILE), "| sha256", crypto.createHash("sha256").update(raw).digest("hex"), "| bytes", raw.length, "| list as of", j.listAsOf);
const both = F.filter((f) => f.bothRows > 0 && !f.navSymbolRejected);
const base = both.filter((f) => !f.termFund);
console.log("funds on the list", F.length, "| with both series", both.length, "| of those, term funds (left out)", both.length - base.length, "| UNIVERSE", base.length);
const unmapped = base.filter((f) => !groupOf(f.assetClassIfKnown));
if (unmapped.length) throw new Error("class with no cost group: " + [...new Set(unmapped.map((f) => f.assetClassIfKnown))].join(", "));
const tally = (arr, key) => arr.reduce((o, f) => { const k = key(f); o[k] = (o[k] || 0) + 1; return o; }, {});
console.log("by cost group", JSON.stringify(tally(base, (f) => groupOf(f.assetClassIfKnown))));
console.log("foreign-clock classes", base.filter((f) => FOREIGN_CLOCK.includes(f.assetClassIfKnown)).length, "| US-clock", base.filter((f) => !FOREIGN_CLOCK.includes(f.assetClassIfKnown)).length);
console.log("funds the scout flagged with at least one weekly-value NAV year:", both.filter((f) => (f.navWeeklyValueYears || []).length).map((f) => f.ticker + ":" + f.navWeeklyValueYears.length).join(" "));

// earliest day a fund could signal, APPROXIMATED in calendar days: 252 market days of both series (about 366 calendar days), and a
// lookback that starts at least 126 market days (about 183 calendar days) after the later of inception and the first Yahoo price row
const add = (d, n) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const firstSignal = (f) => { const a = add(f.overlapFirst, 366), launch = [f.priceFirst, String(f.inception || "").slice(0, 10)].filter(Boolean).sort().pop(), b = add(launch, 183 + 366); return a > b ? a : b; };
console.log("\nfunds that could signal on a date (approximate, calendar-day conversion), all | US-clock | by cost group");
for (const d of ["2000-01-01", "2000-07-01", "2001-01-01", "2002-01-01", "2004-01-01", "2006-01-01", "2008-01-01", "2010-01-01", "2012-01-01", "2014-01-01", "2016-01-01", "2018-01-01", "2020-01-01", "2022-01-01", "2024-01-01", "2026-01-01", "2026-10-01"]) {
  const e = base.filter((f) => firstSignal(f) <= d);
  console.log("  " + d, String(e.length).padStart(4), "|", String(e.filter((f) => !FOREIGN_CLOCK.includes(f.assetClassIfKnown)).length).padStart(4), "|", JSON.stringify(tally(e, (f) => groupOf(f.assetClassIfKnown))));
}
