#!/usr/bin/env node
/**
 * TRAIDS — Signal Turnover / Effective-N
 *
 * Daily-bar signals persist: the same names clear the same bar day after day, so the
 * "Track ALL daily" method logs the SAME setup many times. Those repeats are correlated,
 * not independent — so the raw trade count overstates how much evidence you actually have.
 * This quantifies that, to read the forward test honestly at the checkpoint:
 *   • distinct (symbol+direction) setups vs raw settled trades
 *   • day-over-day OVERLAP % (how much of the board repeats) and TURNOVER % (how much rotates)
 *   • a conservative EFFECTIVE-N (distinct setups) + the inflation factor (raw / effective)
 *   • the most-persistent setups (logged on the most days)
 *
 * Analysis only — never touches the board, the test, or selection.
 *
 * Usage:  node backend/signal-turnover.js
 *         node backend/signal-turnover.js path/to/trade_log.json
 */
const fs = require("fs");
const path = require("path");

const FILE = process.argv[2] || path.join(__dirname, "data", "trade_log.json");

const etFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const etDay = ts => etFmt.format(new Date(ts));
const setupKey = t => `${t.sym}|${t.dir > 0 ? "L" : "S"}`;

function load() {
  let arr;
  try { const d = JSON.parse(fs.readFileSync(FILE, "utf8")); arr = Array.isArray(d) ? d : (d.trades || d.log || []); }
  catch (e) { console.error(`\n  Could not read ${FILE}: ${e.message}\n`); process.exit(1); }
  return arr.filter(t => t && t.sym && t.dir != null && (t.openedAt || t.closedAt));
}

(async () => {
  const trades = load();
  console.log(`\n  TRAIDS — Signal Turnover / Effective-N  ·  ${trades.length} settled trades  (${FILE})\n`);
  if (!trades.length) { console.log("  No trades yet.\n"); return; }

  // group setups by ET trading day
  const byDay = {};                          // day -> Set(setupKey)
  const setupDays = {};                      // setupKey -> Set(day)
  for (const t of trades) {
    const day = etDay(t.openedAt || t.closedAt), k = setupKey(t);
    (byDay[day] ||= new Set()).add(k);
    (setupDays[k] ||= new Set()).add(day);
  }
  const days = Object.keys(byDay).sort();
  const distinct = Object.keys(setupDays).length;
  const inflation = distinct ? trades.length / distinct : 0;

  // day-over-day overlap across adjacent observed days.
  //  carryIn = share of TODAY's board that was also on yesterday's ("looks like yesterday")
  //  jaccard = intersection / union (symmetric persistence)
  const overlaps = [];
  for (let i = 1; i < days.length; i++) {
    const a = byDay[days[i - 1]], b = byDay[days[i]];
    const inter = [...b].filter(x => a.has(x)).length;
    const uni = new Set([...a, ...b]).size;
    overlaps.push({ from: days[i - 1], to: days[i], jaccard: uni ? inter / uni : 0, carryIn: b.size ? inter / b.size : 0, carried: inter, todayN: b.size });
  }
  const avgCarryIn = overlaps.length ? overlaps.reduce((s, o) => s + o.carryIn, 0) / overlaps.length : null;
  const avgJaccard = overlaps.length ? overlaps.reduce((s, o) => s + o.jaccard, 0) / overlaps.length : null;

  // ── report ──
  console.log(`  Trading days in log:        ${days.length}  (${days[0]} → ${days[days.length - 1]})`);
  console.log(`  Raw settled trades:         ${trades.length}`);
  console.log(`  Distinct setups (sym+dir):  ${distinct}   ← conservative EFFECTIVE-N`);
  console.log(`  Inflation factor:           ${inflation.toFixed(2)}x  (raw count overstates evidence by this much)`);
  if (avgCarryIn != null) {
    console.log(`  Avg CARRY-IN:               ${(avgCarryIn * 100).toFixed(0)}%   ← "today looks like yesterday" (share of today's board seen yesterday)`);
    console.log(`  Avg day-over-day TURNOVER:  ${((1 - avgCarryIn) * 100).toFixed(0)}%   (share of today's board that's new)`);
    console.log(`  Avg Jaccard (symmetric):    ${(avgJaccard * 100).toFixed(0)}%`);
  }

  if (overlaps.length) {
    console.log(`\n  Per-day carry-over:`);
    console.log(`  ${"day".padEnd(12)}${"setups".padEnd(9)}${"carried".padEnd(10)}carry-in vs prior`);
    console.log("  " + "─".repeat(48));
    console.log("  " + days[0].padEnd(12) + String(byDay[days[0]].size).padEnd(9) + "—".padEnd(10) + "—");
    for (const o of overlaps)
      console.log("  " + o.to.padEnd(12) + String(o.todayN).padEnd(9) + String(o.carried).padEnd(10) + (o.carryIn * 100).toFixed(0) + "%");
  }

  const persistent = Object.entries(setupDays).map(([k, s]) => [k, s.size]).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
  if (persistent.length) {
    console.log(`\n  Most-persistent setups (logged on multiple days):`);
    persistent.slice(0, 12).forEach(([k, n]) => console.log("  " + k.padEnd(16) + n + " days"));
  }

  console.log(`\n  How to read it: high overlap / high inflation = the system is making a FEW persistent bets,`);
  console.log(`  not many independent ones. Judge edge on the ~${distinct} distinct setups, not the ${trades.length} raw trades —`);
  console.log(`  and treat calibration/expectancy standard errors as WIDER than the trade count implies.\n`);
})();
