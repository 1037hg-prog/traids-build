#!/usr/bin/env node
// attack-universe-data-arith.cjs — every number quoted in attack-universe-data.md that is not a quotation.
//
// Reads ONE local file, the data scout's scout-universe.json (counts and dates only), and converts PUBLISHED figures.
// No network. No price, no NAV, no discount series, no return of any fund. Nothing here is an outcome of the rule.
//
// Run:  node docs/fund-discounts/2026-10-12/attack-universe-data-arith.cjs
"use strict";
const fs = require("fs"), path = require("path");
const j = JSON.parse(fs.readFileSync(path.join(__dirname, "scout-universe.json"), "utf8")), F = j.funds;
const both = F.filter((f) => f.bothRows > 0 && !f.navSymbolRejected), base = both.filter((f) => !f.termFund);
const pct = (x, d = 1) => (100 * x).toFixed(d) + "%", usd = (x) => "$" + Math.round(x);
const perMonth100k = (annualFraction) => 100000 * annualFraction / 12; // dollars a month per $100,000 held
const ms = (s) => new Date(String(s).slice(0, 10) + "T00:00:00Z").getTime();

console.log("1. ATTRITION OF THE PUBLIC LIST (data scout, scout-data.md section 1; list dates 2018-03-30, 2021-05-04, 2026-10-09)");
for (const [label, n, gone, from] of [["2018 copy", 528, 228, "2018-03-30"], ["2021 copy", 467, 143, "2021-05-04"]]) {
  const years = (ms("2026-10-09") - ms(from)) / (365.25 * 864e5), h = 1 - Math.pow(1 - gone / n, 1 / years);
  console.log(`   ${label}: ${gone} of ${n} gone (${pct(gone / n)}) over ${years.toFixed(2)} years = ${pct(h, 2)} of funds leaving a year; a one-year holding meets a departure with about that chance`);
}
const h = 0.064;
for (const y of [5, 10, 15, 20, 23]) console.log(`   at 6.4% a year, share of the funds alive on a date that is still listed ${y} years later: ${pct(Math.pow(1 - h, y))}`);

console.log("\n2. HOW MUCH OF EACH YEAR'S MARKET THE TEST CAN SEE");
console.log("   Published year-end counts of traditional closed-end funds (Investment Company Institute): 382 in 2024 and 401 in 2023 (read in the");
console.log("   April 2025 report); 494 in 2019, said to be 25% below 2007; 402 in 2023 said to be 36% below 2011 (the last two from search summaries");
console.log("   of ICI pages, not opened). Derived: 2007 = 494/0.75, 2011 = 402/0.64.");
const ici = { 2007: 494 / 0.75, 2011: 402 / 0.64, 2019: 494, 2023: 401, 2024: 382 };
for (const Y of Object.keys(ici)) {
  const e = Y + "-12-31", alive = F.filter((f) => String(f.inception || f.priceFirst).slice(0, 10) <= e).length;
  const b = both.filter((f) => f.overlapFirst <= e).length, u = base.filter((f) => f.overlapFirst <= e).length;
  console.log(`   ${Y}: industry count ${Math.round(ici[Y])} | on today's list and launched by then ${alive} (${pct(alive / ici[Y], 0)}) | with both series by then ${b} (${pct(b / ici[Y], 0)}) | in the clean draft's 298 by then ${u} (${pct(u / ici[Y], 0)})`);
}
console.log("   The clean draft's single haircut is 0.568 (the surviving share of the March 2018 list). The share at the START of its holdout (2011 row) is the figure above.");

console.log("\n3. THE OPEN-ENDING CHANNEL, FROM THE PUBLISHED RECORD (Bradley, Brav, Goldstein and Jiang, working-paper version of J. Financial Economics 2010;");
console.log("   142 US equity closed-end funds, 1988-2002; discount there is (NAV - price)/NAV)");
const attempt = 0.133, opened = 0.039; // share of fund-years with an open-ending attempt; with an actual open-ending, merger or liquidation
const T3 = { before: [18.34, 21.43, 19.92], attack: 14.53, allAfter: [11.33, 11.90, 10.34], survAfter: [17.39, 18.67, 16.21] };
console.log(`   fund-years with an open-ending attempt ${pct(attempt)}; with an actual open-ending, merger into an open fund or liquidation ${pct(opened)}`);
console.log(`   attacked funds' average discount: ${T3.before.join(", ")} in the three years before, ${T3.attack} in the attack year`);
T3.allAfter.forEach((a, i) => console.log(`   year +${i + 1}: ${a} counting the funds that opened at zero, ${T3.survAfter[i]} among the funds still closed: survivors-only understates the narrowing by ${(T3.survAfter[i] - a).toFixed(2)} points`));
const gap1 = T3.survAfter[0] - T3.allAfter[0];
const perFundYear = attempt * gap1 / 100, onPrice = perFundYear / (1 - T3.attack / 100);
console.log(`   route A (table route): ${pct(attempt)} x ${gap1.toFixed(2)} points = ${(100 * perFundYear).toFixed(2)} points of asset value per fund-year; on the price paid (divide by 1 - ${(T3.attack / 100).toFixed(4)}) ${pct(onPrice, 2)} a year = ${usd(perMonth100k(onPrice))} a month per $100,000 held`);
for (const d of [T3.attack / 100, T3.before[2] / 100]) { const g = opened * d / (1 - d); console.log(`   route B (event route): ${pct(opened)} x gain of ${pct(d / (1 - d))} when a fund bought at a ${pct(d)} discount pays asset value = ${pct(g, 2)} a year = ${usd(perMonth100k(g))} a month per $100,000 held`); }
for (const k of [2, 3]) console.log(`   if the rule's state (cheap against its own history) is attacked ${k} times as often as the average fund-year: route A ${usd(k * perMonth100k(onPrice))} a month per $100,000 held`);
console.log("   These are other people's funds and years (equity funds, 1988-2002). They size the channel; they are not a measurement of this universe.");

console.log("\n4. A TENDER OFFER THE SERIES CANNOT SHOW (arithmetic; a holder who tenders is paid near asset value on part of the position)");
for (const [share, paid, disc] of [[0.05, 0.98, 0.10], [0.25, 0.98, 0.10], [0.25, 0.985, 0.08]]) { const g = share * (paid / (1 - disc) - 1); console.log(`   ${pct(share, 0)} of shares taken at ${pct(paid, 1)} of asset value while the market price is ${pct(disc, 0)} below it: +${pct(g, 2)} on the position`); }

console.log("\n5. THE COLLAPSE CHANNEL IN A DOLLAR BOOK (arithmetic, an illustration only)");
console.log(`   MLP funds among the 228 gone since 2018: 21 = ${pct(21 / 228)} of the gone, ${pct(21 / 528)} of the 2018 list`);
for (const [n, loss] of [[1, 0.6], [2, 0.7], [3, 0.8]]) console.log(`   ${n} of 20 places of $5,000 in a fund that then lost ${pct(loss, 0)}: $${Math.round(n * 5000 * loss)} once = ${usd(n * 5000 * loss / 177)} a month over the 177-month holdout`);

console.log("\n6. EXTRA YIELD FROM BUYING BELOW ASSET VALUE (in the clean excess with no move in the gap at all)");
for (const [pay, d] of [[0.08, 0.10], [0.09, 0.15]]) { const g = pay * (1 / (1 - d) - 1); console.log(`   fund paying ${pct(pay, 0)} of asset value a year, bought and held at a constant ${pct(d, 0)} discount: clean excess ${pct(g, 2)} a year = ${usd(perMonth100k(g))} a month per $100,000 held (registered cost drag: $67 to $113)`); }
{ const pay = 0.08, g = pay * (1 / (1 - 0.14) - 1 / (1 - 0.08)); console.log(`   signal bought at a 14% discount against a random day at 8%, same 8% payer: difference ${pct(g, 2)} a year = ${usd(perMonth100k(g))} a month per $100,000 held`); }

console.log("\n7. THE WEEKLY-VALUE SCREEN (more than 70 changes in the trailing 252 rows): how long a fund that turns weekly still passes");
const repeatMedian = [...base.map((f) => f.navRepeatShare)].sort((a, b) => a - b)[Math.floor(base.length / 2)];
const daily = Math.round(252 * (1 - repeatMedian)), wk = [];
for (const f of both) for (const s of f.navWeeklyValueYears || []) { const m = /:(\d+)chg\/(\d+)rows/.exec(s); if (m && +m[1] >= 40) wk.push(+m[1]); }
wk.sort((a, b) => a - b); const weekly = wk[Math.floor(wk.length / 2)];
console.log(`   median fund: NAV repeats on ${pct(repeatMedian)} of rows = about ${daily} changes in 252 rows; flagged weekly years: median ${weekly} changes, highest ${wk[wk.length - 1]} (the screen's line is 70)`);
console.log(`   after the switch the trailing count falls ${((daily - weekly) / 252).toFixed(3)} a day: it reaches 70 after about ${Math.round((daily - 70) / ((daily - weekly) / 252))} market days`);
const trans = both.filter((f) => (f.navWeeklyValueYears || []).length && +f.navWeeklyValueYears[0].slice(0, 4) - +f.navFirst.slice(0, 4) >= 2);
console.log(`   funds flagged weekly whose daily history begins two or more calendar years before the first weekly year (a real switch inside the data): ${trans.map((f) => f.ticker + " " + f.navWeeklyValueYears[0].slice(0, 4)).join(", ")}`);
console.log(`   flagged in a single year only (a stretch of stale values inside a daily history):${both.filter((f) => (f.navWeeklyValueYears || []).length === 1).map((f) => f.ticker + " " + f.navWeeklyValueYears[0]).join(", ")}`);
console.log(`   weekly rhythm in a 21-row window: 4 or 5 changes; a daily fund that repeats on half its rows: about ${(21 * 0.5).toFixed(1)}`);

console.log("\n8. STALENESS AND HISTORY START, FROM THE SCOUT'S TABLE (counts only)");
for (const th of [0.3, 0.4, 0.5]) console.log(`   funds of the 298 whose NAV repeats the row before on at least ${pct(th, 0)} of all rows: ${base.filter((f) => f.navRepeatShare >= th).length}`);
const runs = base.map((f) => (f.navLongestFlatRun ? f.navLongestFlatRun.rows : 0));
console.log(`   longest run of one NAV value: 10 rows or more in ${runs.filter((x) => x >= 10).length} of 298 funds, 20 or more in ${runs.filter((x) => x >= 20).length}`);
const lag = both.filter((f) => ms(f.navFirst) - Math.max(ms(f.priceFirst), ms(f.inception || f.priceFirst)) > 3 * 365.25 * 864e5 && String(f.inception || "").slice(0, 4) >= "1999");
console.log(`   funds launched in 1999 or later whose NAV history begins more than three years after both launch and first price row: ${lag.length} (${lag.map((f) => f.ticker).join(" ")})`);
const term = both.filter((f) => f.termFund);
console.log(`   term funds with both series: ${term.length}; launched 2015 or earlier: ${term.filter((f) => String(f.inception).slice(0, 4) <= "2015").map((f) => f.ticker + " " + String(f.inception).slice(0, 4)).join(", ")}`);
