#!/usr/bin/env node
"use strict";
/**
 * WORST-DAY SEALED FORECAST LEDGER — the fixture writer. It calls the SAME generator the shipped known answers use
 * (staged/backend/worst-day/sealed-fixtures.js syntheticBars) and writes its output to fixtures/synthetic-bars.json.
 *
 * WHY THE FIXTURE EXISTS AT ALL when the generator is deterministic: so that a change to the generator cannot quietly move every
 * pinned number at once. selftest.cjs compares the generator's output with these bytes and fails when they differ, which means a
 * generator change has to be made here, on purpose, in a diff someone can read.
 *
 *   node docs/worst-day-sealed/2026-10-16/fixtures/make-bars.cjs          write it (and say whether it changed)
 *   node docs/worst-day-sealed/2026-10-16/fixtures/make-bars.cjs --check  read-only: say whether it matches; exit 1 if not
 * It writes exactly one file, inside this package. No network, no live file, no data of any kind from the market.
 */
const fs = require("fs"), path = require("path");
const gen = require(path.join(__dirname, "..", "staged", "backend", "worst-day", "sealed-fixtures.js"));
const OUT = path.join(__dirname, "synthetic-bars.json");
const text = JSON.stringify(gen.syntheticBars(), null, 1) + "\n";
const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : null;
if (process.argv.includes("--check")) {
  console.log(have === text ? `fixtures/synthetic-bars.json matches the generator (${text.length} bytes)` : `fixtures/synthetic-bars.json does NOT match the generator (${have === null ? "it is missing" : `${have.length} bytes on disk, ${text.length} from the generator`})`);
  process.exit(have === text ? 0 : 1);
}
fs.writeFileSync(OUT, text);
console.log(`${have === text ? "unchanged" : have === null ? "written" : "REWRITTEN (it moved)"}: fixtures/synthetic-bars.json — ${JSON.parse(text).length} sessions, ${text.length} bytes`);
