#!/usr/bin/env node
/**
 * Builds the frozen fixtures used by the verification tests (2026-09-22). Run ONCE by hand; CI never runs this — CI only reads the output.
 * Fixtures are small slices of data we already hold under licence, for internal testing only (not for redistribution).
 *   node backend/test/build-fixtures.js
 */
const fs = require("fs"), path = require("path"); const tb = require("../futures-testbed");
const F = (f) => path.join(__dirname, "fixtures", f);
(async () => {
  const nq = await require("../lib/futures-bars.js").loadBars({ root: "NQ", resolution: "1minute", lookbackDays: 10, pages: 3, quiet: true });   // 2026-10-02 Massive exit
  const day = nq.filter((b) => b.date === "2026-09-21").map((b) => [Math.round(b.ns / 1e6), b.o, b.h, b.l, b.c]);
  fs.writeFileSync(F("nq-1m-2026-09-21.json"), JSON.stringify({ source: "Massive NQ front month, 1-minute, ET calendar date 2026-09-21", rows: day }));
  const aapl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "equity-1m", "AAPL", "2026-07.json"), "utf8"));
  const d0 = Date.parse("2026-07-01T13:30:00Z"), d1 = Date.parse("2026-07-01T20:00:00Z");
  fs.writeFileSync(F("aapl-1m-2026-07-01.json"), JSON.stringify({ source: "Alpaca SIP AAPL 1-minute raw, 2026-07-01 regular session", rows: aapl.rows.filter((r) => r[0] >= d0 && r[0] < d1).map((r) => r.slice(0, 5)) }));
  const csv = fs.readFileSync(path.join(process.env.USERPROFILE, "Downloads", "collective2_strategy_trading_record_for_ares.csv"), "utf8").trim().split(/\r?\n/);
  fs.writeFileSync(F("c2-sample.csv"), [csv[0], ...csv.slice(1).filter((l) => l.startsWith('"2026-09-21') || l.startsWith('"2026-09-15'))].join("\n") + "\n");
  console.log("fixtures:", day.length, "NQ bars ·", "AAPL bars written · c2 sample rows", csv.slice(1).filter((l) => l.startsWith('"2026-09-21') || l.startsWith('"2026-09-15')).length);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
