#!/usr/bin/env node
"use strict";
/** MASSIVE EXIT (2026-10-02) — runtime labels in the repointed research scripts that still named Massive as the source. Exact-anchor,
 *  once each; idempotent (skips a file whose new text is already present). `--check` verifies anchors only. */
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..", ".."), CHECK = process.argv.includes("--check");
const EDITS = [
  ["backend/futures-board-backtest.js", "~2yr Massive continuous (w/ volume)", "~2yr Schwab continuous daily from the nightly cache (w/ volume)"],
  ["backend/futures-board-backtest.js", " * Usage:  node backend/futures-board-backtest.js          (needs MASSIVE_API_KEY in backend/.env)", " * Usage:  node backend/futures-board-backtest.js          (2026-10-02: reads data/futures-daily — backend/futures-daily-cache.js)"],
  ["backend/futures-board-backtest.js", "No signals (check MASSIVE_API_KEY / data).", "No signals (check the data/futures-daily cache)."],
  ["backend/c2-ares-fill-check.js", 'source: "Collective2 CSV (operator download) vs Massive NQ 1-minute bars, front month by volume"', 'source: "Collective2 CSV (operator download) vs NQ 1-minute bars from the local futures store (Massive archive to 2026-10-02, Schwab pricehistory after), front month"'],
  ["backend/stoprun-gauntlet.js", "${ROOT} 5m continuous (Massive) · pre-registered spec", "${ROOT} 5m continuous (local futures store) · pre-registered spec"],
];
let bad = 0;
for (const [rel, find, repl] of EDITS) {
  const f = path.join(R, rel); let s = fs.readFileSync(f, "utf8");
  if (s.includes(repl)) { console.log(`skip  ${rel} (already)`); continue; }
  const n = s.split(find).length - 1;
  if (n !== 1) { bad++; console.log(`FAIL  ${rel}: anchor x${n}`); continue; }
  if (!CHECK) { s = s.replace(find, () => repl); fs.writeFileSync(f, s); }
  console.log(`${CHECK ? "ok   " : "done "} ${rel}`);
}
process.exit(bad ? 1 : 0);
