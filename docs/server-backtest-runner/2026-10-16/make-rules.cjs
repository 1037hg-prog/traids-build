#!/usr/bin/env node
/**
 * MAKE-RULES — writes the staged rule file(s) of this package through backend/lib/atomic-write.js (JSON is never hand-written).
 *   node docs/server-backtest-runner/2026-10-16/make-rules.cjs --write | --check
 * FIRST USE: the dip-buy rule family (R313's IBS rule, verbatim parameters) on MORE COUNTRY ETFs — single-country funds that are in none of the
 * family's registered universes (R313's 20 hold EFA EEM EWJ EWG EWU EWC EWA). It is a DRAFT: it carries no `registration`, so bt-run.cjs runs it
 * only with --exploratory — and it is RESERVED FOR REGISTRATION, so not even that: its bars are not read before it is registered. To make it a test: register it at home (backend/data/test-registry.json: rule, universe, unit, bar, gates, read
 * condition frozen BEFORE any data is read), then add `registration` { id, registeredOn } and the registered `bar.tRequired` here.
 */
"use strict";
const fs = require("fs"), path = require("path");
const REPO = path.resolve(__dirname, "..", "..", ".."), OUT = path.join(__dirname, "staged", "backend", "bt", "rules", "dip-ibs-country-etfs.json");
const RULE = {
  schema: "bt-rule-v1", id: "DIP-IBS-COUNTRY-ETFS-DRAFT",
  title: "IBS dip-buy (R313's rule, unchanged) on 24 single-country ETFs outside the family's registered universes — DRAFT, not registered",
  family: "ibs-dip",
  universe: ["EWZ", "EWW", "EWY", "EWT", "EWH", "EWS", "EWL", "EWP", "EWQ", "EWI", "EWN", "EWD", "EWK", "EWO", "EWM", "EZA", "ECH", "TUR", "THD", "EIDO", "EPHE", "INDA", "FXI", "ENZL"],
  params: { entry: { ibsBelow: 0.1 }, exit: { ibsAbove: 0.9 }, maxHoldDays: null },
  window: { from: "2000-01-01", to: "2026-09-30", lastBar: "2026-10-01" },
  reservedForRegistration: true,
  costs: { roundTrip: 0.0012, stress: 0.0024, note: "country ETFs are wider than R313's sector ETFs: 0.12% round trip (2x R313's 0.06%), stress at 2x that" },
  unit: "month",
  bar: { variants: 1, note: "computed best-of-1 until registered; registration freezes bar.tRequired" },
  gates: { minTrades: 100, minMonths: 36 },
  controls: { placeboDraws: 500, placeboSeed: 313, floorSeeds: 60, leakSeeds: [1, 2] },
  provenance: "R313 (SEALED PASS 2026-10-03) rule text: ENTRY close of t when IBS[t] < 0.1; EXIT close of the first u > t with IBS[u] > 0.9; one position per ETF; no stop, no time cap",
};
const a = process.argv.slice(2);
if (a[0] === "--write") { const { writeJsonAtomic } = require("./aw.cjs").loadAtomicWrite(REPO); fs.mkdirSync(path.dirname(OUT), { recursive: true }); writeJsonAtomic(OUT, RULE); console.log("written " + path.relative(__dirname, OUT)); }
else if (a[0] === "--check") { let cur = null; try { cur = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch { cur = null; } const same = JSON.stringify(cur) === JSON.stringify(RULE); console.log(same ? "ok   the staged rule file is what this script writes" : "DIFF the staged rule file differs"); process.exitCode = same ? 0 : 1; }
else { console.log("usage: make-rules.cjs --write | --check"); process.exitCode = 2; }
module.exports = { RULE, OUT };
