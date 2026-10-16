#!/usr/bin/env node
// attack-universe-data-stale.cjs — how often a NAV value REPEATS, in the two places the drafts' stale screens leave open.
//
// OUTCOME FENCE: this reads the NAV series only, and only asks whether a value equals the row before. No price is loaded, no discount is
// formed, no change of any value is measured, no return is computed. It prints counts and dates. It makes no network request: it reads
// the data scout's cache (rebuilt by scout-coverage.cjs 1 if it is gone).
//
// Run (Git Bash):   CEF_SCOUT_CACHE="<the scout's cache folder>" node docs/fund-discounts/2026-10-12/attack-universe-data-stale.cjs
// PowerShell:       $env:CEF_SCOUT_CACHE='<folder>'; node docs/fund-discounts/2026-10-12/attack-universe-data-stale.cjs
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const CACHE = process.env.CEF_SCOUT_CACHE || path.join(os.tmpdir(), "traids-cef-scout");
if (!fs.existsSync(path.join(CACHE, "series"))) { console.log("no series cache at", CACHE, "- set CEF_SCOUT_CACHE or rebuild it with scout-coverage.cjs 1"); process.exit(0); }
const U = JSON.parse(fs.readFileSync(path.join(__dirname, "scout-universe.json"), "utf8")).funds;
const cal = JSON.parse(fs.readFileSync(path.join(CACHE, "calendar.json"), "utf8")).days;
const funds = U.filter((f) => f.bothRows > 0 && !f.navSymbolRejected && !f.termFund); // the clean draft's 298
const pct = (x, d = 1) => (100 * x).toFixed(d) + "%";
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

const valued = new Map(), repeat = new Map();   // per calendar index: funds with a valued NAV row that also had one the market day before; of those, how many repeat it
let rows = 0, inLong = 0, hole = 0, row2 = 0;   // fund-days; in a run of 5+; rows 2..4 of a run that goes on to 5+; row 2 of any run of 3+
const byYear = {};
// the drafts' weekly screen: more than 70 changes in the 252 rows ending at s. Count fund-days that PASS it while the last 21 rows hold 5 or fewer changes
let pass70 = 0, pass70ButWeeklyNow = 0; const weeklyNowFunds = new Map();
for (const f of funds) {
  const V = JSON.parse(fs.readFileSync(path.join(CACHE, "series", f.navSymbol + ".json"), "utf8")), n = V.idx.length, c = V.close;
  const same = new Array(n).fill(0); for (let k = 1; k < n; k++) same[k] = c[k] === c[k - 1] ? 1 : 0;
  for (let k = 1; k < n; k++) if (V.idx[k] - V.idx[k - 1] === 1) { valued.set(V.idx[k], (valued.get(V.idx[k]) || 0) + 1); if (same[k]) repeat.set(V.idx[k], (repeat.get(V.idx[k]) || 0) + 1); }
  let start = 0;
  for (let k = 1; k <= n; k++) if (k === n || !same[k]) { const len = k - start;
    for (let m = start; m < k; m++) { const y = cal[V.idx[m]].slice(0, 4), o = (byYear[y] = byYear[y] || { rows: 0, hole: 0 }); o.rows++; rows++; if (len >= 5) { if (m > start) inLong++; if (m - start >= 1 && m - start <= 3) { hole++; o.hole++; } } }
    if (len >= 3) row2++; start = k; }
  const chg = new Array(n + 1).fill(0); for (let k = 1; k < n; k++) chg[k + 1] = chg[k] + (same[k] ? 0 : 1); chg[1] = 0;
  for (let k = 252; k < n; k++) { const c252 = chg[k + 1] - chg[k - 251], c21 = chg[k + 1] - chg[k - 20];
    if (c252 > 70) { pass70++; if (c21 <= 5) { pass70ButWeeklyNow++; weeklyNowFunds.set(f.ticker, (weeklyNowFunds.get(f.ticker) || 0) + 1); } } }
}
console.log(`funds ${funds.length} | NAV fund-days ${rows}`);
console.log(`\nA. THE HOLE IN "not the fifth or later row of a run": rows 2, 3 and 4 of a run that goes on to five or more identical values`);
console.log(`   fund-days in that position: ${hole} = ${pct(hole / rows, 2)} of all NAV fund-days (rows 2 onward of such runs, the scout's measure: ${inLong} = ${pct(inLong / rows, 2)})`);
console.log(`   so of the stale fund-days inside long runs, the share the fifth-row rule lets through: ${pct(hole / inLong)}`);
console.log("   by year (share of that year's fund-days): " + Object.keys(byYear).sort().map((y) => `${y}:${pct(byYear[y].hole / byYear[y].rows, 1)}`).join(" "));

console.log("\nB. HOW MANY FUNDS REPEAT YESTERDAY'S NAV ON ONE DAY (the base for a feed-freeze test that needs nothing from the future)");
const days = [...valued.entries()].filter(([, v]) => v >= 20).map(([i, v]) => ({ i, share: (repeat.get(i) || 0) / v, v })).sort((a, b) => a.i - b.i);
const sh = days.map((d) => d.share);
console.log(`   market days with 20 or more funds: ${days.length} | daily share repeating: median ${pct(q(sh, 0.5))}, 90th percentile ${pct(q(sh, 0.9))}, 99th ${pct(q(sh, 0.99))}, highest ${pct(Math.max(...sh))}`);
for (const th of [0.3, 0.4, 0.5]) { const hit = days.filter((d) => d.share >= th); console.log(`   days at ${pct(th, 0)} or more: ${hit.length} (${pct(hit.length / days.length, 2)} of days)`); }
// the causal rule proposed in the attack: share >= 30% AND >= twice the median of the daily share over the 252 market days before
const flagged = []; for (let k = 252; k < days.length; k++) { const med = q(sh.slice(k - 252, k), 0.5); if (sh[k] >= 0.3 && sh[k] >= 2 * med) flagged.push(days[k]); }
console.log(`   days flagged by "30% or more AND at least twice the median of the 252 days before": ${flagged.length} (${pct(flagged.length / days.length, 2)} of days)`);
const byY = {}; for (const d of flagged) byY[cal[d.i].slice(0, 4)] = (byY[cal[d.i].slice(0, 4)] || 0) + 1; console.log("   flagged days by year: " + Object.keys(byY).sort().map((y) => `${y}:${byY[y]}`).join(" "));
const holiday = flagged.filter((d) => { const dt = new Date(cal[d.i] + "T12:00:00Z"), m = dt.getUTCMonth() + 1, day = dt.getUTCDate(), wd = dt.getUTCDay(); return (m === 10 && wd === 1 && day >= 8 && day <= 14) || (m === 11 && (day === 11 || (day === 10 && wd === 5) || (day === 12 && wd === 1))); });
console.log(`   of those, on the two days a year the bond market is shut and the stock market is open (Columbus Day, Veterans Day): ${holiday.length}`);
console.log(`   the seven days the drafts already name (2021-09-24..30) flagged: ${flagged.filter((d) => cal[d.i] >= "2021-09-24" && cal[d.i] <= "2021-09-30").map((d) => cal[d.i]).join(" ") || "none"}`);
const isBondHoliday = (d) => { const dt = new Date(cal[d.i] + "T12:00:00Z"), m = dt.getUTCMonth() + 1, day = dt.getUTCDate(), wd = dt.getUTCDay(); return (m === 10 && wd === 1 && day >= 8 && day <= 14) || (m === 11 && (day === 11 || (day === 10 && wd === 5) || (day === 12 && wd === 1))); };
const bh = days.filter(isBondHoliday);
console.log(`   those two days a year, all ${bh.length} of them in the data: median share repeating ${pct(q(bh.map((d) => d.share), 0.5))} (every other day: ${pct(q(days.filter((d) => !isBondHoliday(d)).map((d) => d.share), 0.5))})`);
for (const th of [0.4, 0.5]) { const fl = []; for (let k = 252; k < days.length; k++) { const med = q(sh.slice(k - 252, k), 0.5); if (sh[k] >= th && sh[k] >= 2 * med) fl.push(days[k]); }
  console.log(`   variant "${pct(th, 0)} or more AND twice the trailing median": ${fl.length} days (${pct(fl.length / days.length, 2)}), of which bond-holiday days ${fl.filter(isBondHoliday).length}, days in 2021-09-24..30 ${fl.filter((d) => cal[d.i] >= "2021-09-24" && cal[d.i] <= "2021-09-30").length}`); }

console.log("\nC. THE WEEKLY SCREEN'S LAG: fund-days that pass \"more than 70 changes in 252 rows\" while the latest 21 rows hold 5 changes or fewer");
console.log(`   ${pass70ButWeeklyNow} of ${pass70} passing fund-days (${pct(pass70ButWeeklyNow / pass70, 2)}), in ${weeklyNowFunds.size} funds; most: ${[...weeklyNowFunds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t, v]) => t + " " + v).join(", ")}`);
