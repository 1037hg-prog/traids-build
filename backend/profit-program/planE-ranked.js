#!/usr/bin/env node
"use strict";
/**
 * PLAN E - the ranked lever table. READ-ONLY; offline. It only READS the JSON the other planE-*.js printers wrote and lays the numbers side by side, so
 * every figure here is traceable to the script that made it. Run the chain first:
 *   node backend/planE-paper-scoreboard.js --print
 *   node backend/profit-program/planE-inputs.js [--refresh]
 *   node backend/profit-program/planE-baseline.js ; planE-buildbook-defect.js ; planE-paper-record.js ; planE-levers.js ; planE-rebalance.js ; planE-added-legs.js ; planE-tom-window.js
 *   node backend/profit-program/planE-ranked.js
 * $/month = change in net $ per month on the $100,000 paper anchor (CAGR change x $100k / 12), IN-SAMPLE 2019-06..2026-09 unless stated.
 */
const fs = require("fs"), path = require("path");
const P = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "profit-program", f), "utf8"));
const L = P("planE-levers.json"), RB = P("planE-rebalance.json"), AL = P("planE-added-legs.json"), TW = P("planE-tom-window.json"), BD = P("planE-buildbook-defect.json"), PR = P("planE-paper-record.json"), BL = P("planE-baseline.json");
const usd = (x) => (x < 0 ? "-$" : "+$") + Math.abs(Math.round(x)).toLocaleString("en-US");
const A = (c) => L.A.rows.find((r) => r.case.startsWith(c));
const R313 = AL.rows.find((r) => r.id === "R313"), DAV = AL.rows.find((r) => r.id === "R152-DAVIN");
const rows = [];
const add = (o) => rows.push(o);
const s110 = A("sleeves x1.10"), d2 = A("D2"), z5 = A("5 whole"), z4 = A("4 whole"), z12 = A("k 1.20");
const fee = (b) => L.E.rows.find((r) => r.feeBps === b), lag1 = L.E.rows.find((r) => r.lag === 1), band = L.E.rows.find((r) => r.bandRows).bandRows;

add({ rank: 1, name: "Scale the diversified sleeves x1.10 (keeps the 12% ZN reserve)", kind: "operator-call", usdMo: s110.usdPerMonthVsE, dd: `month-end ${s110.maxDDmonthEndPct}% vs ${A("E as").maxDDmonthEndPct}% (${(s110.maxDDmonthEndPct - A("E as").maxDDmonthEndPct).toFixed(2)} pt); daily ${s110.maxDDdailyPct}% vs ${A("E as").maxDDdailyPct}%`, evidence: "leverage on beta + trend exposure, not a new edge; in-sample Sharpe flat" , needs: "operator: the E/D/D2 scaling decision (early Jan 2027) after the 11-02 one-month review" });
add({ rank: 2, name: "ZN overlay 4 -> 5 whole contracts at $100k (x5.23 NAV)", kind: "operator-call", usdMo: z5.usdPerMonthVsE, dd: `month-end ${z5.maxDDmonthEndPct}% (${(z5.maxDDmonthEndPct - z4.maxDDmonthEndPct).toFixed(2)} pt); daily ${z5.maxDDdailyPct}% (${(z5.maxDDdailyPct - z4.maxDDdailyPct).toFixed(2)} pt); disaster-stop loss ${usd(-z5.stopLossUsd)} vs ${usd(-z4.stopLossUsd)}`, evidence: `weakest leg: real-ZN window t ${BL.znWindows.t} over 88 months; R180 PASS is on IEF; forward reads R186/R219 not until ~2027-09`, needs: "operator + a tastytrade dry-run for the margin (5 contracts ~ $15k vs the $12k reserve is an assumption)" });
add({ rank: 3, name: "ZN round-trip cost: the model charges 4 bps of notional; a 1-tick market is ~2 bps", kind: "needs-forward-test", usdMo: Math.round(L.F.modelUsdPerWindow - L.F.oneTickUsdPerWindow), dd: "none", evidence: "arithmetic on tick + R219's assumed $2.50/side; the live close-arm spread is not measured", needs: "R219's recorded asks and bids (read it after its own date) or a dry-run quote at 15:35-15:48 ET" });
add({ rank: 4, name: "Idle cash: the $12,000 ZN reserve earns SGOV-like yield (vs $0 if the futures broker pays nothing)", kind: "operator-call", usdMo: Math.round(L.C.usdPerYear.reserveAtSgov / 12), dd: "none", evidence: `SGOV trailing-12m ${L.C.rows.SGOV.trailing12mPct}% vs DTB3 ${L.C.tbill12mPct}%; the broker's sweep rate is NOT in the repo`, needs: "operator: read the futures broker's cash-interest term; park the reserve in SGOV / T-bills if it pays 0 (+$7/mo more if JAAA replaces SGOV on $8k)" });
add({ rank: 5, name: "10% sleeve of R313 (IBS dip-buy, 20 ETFs) funded from cash", kind: "needs-forward-test", usdMo: R313.add["0.1"].usdPerMonthPer100k, dd: `daily max DD ${R313.add["0.1"].maxDDdailyPct}% (${R313.add["0.1"].dMaxDDpt} pt WORSE)`, evidence: `t ${R313.add["0.1"].tMonthlyImprovement} on 88 months, screened among ${AL.screened} PASS streams (not significant after multiplicity); rho to Plan E ${R313.rhoPlanE}`, needs: "forward twin R316 (execution read at >= 60 round trips) before any sleeve" });
add({ rank: 6, name: "Crypto per-switch fee: the model assumes 25 bps; each +25 bps costs", kind: "needs-forward-test", usdMo: 0, dd: "none", evidence: `0 bps ${usd(fee(0).usd)}/mo, 10 bps ${usd(fee(10).usd)}, 50 bps ${usd(fee(50).usd)}, 100 bps ${usd(fee(100).usd)} vs the 25 bps model; ${L.E.switches.BTC + L.E.switches.ETH} switches since 2018-08`, needs: "a planE-tasty.js --dry crypto fee line and Alpaca's tier; use limit orders" });
add({ rank: 7, name: "Flip-only rebalance + 10% band instead of the monthly full reset", kind: "does-not-work", usdMo: Math.round(100000 * 0.73 * RB["flipMinusLive_5"] / 100 / 12), dd: "none (sub-book DD -8.0 vs -8.03)", evidence: `+${RB["flipMinusLive_5"]} pt on the $73k sub-book at 5 bp (record: +0.09, t 1.72)`, needs: "nothing worth an edit to book-etf-rebalancer.js on dollars alone" });
add({ rank: 8, name: "Hysteresis band on the crypto 50-day line", kind: "does-not-work", usdMo: Math.round(100000 * band.find((b) => b.band === 0.02).d25 / 100 / 12), dd: "none", evidence: `4 bands + base tried: 1% t ${band[1].t25}, 2% t ${band[2].t25}, 3% t ${band[3].t25}, 5% t ${band[4].t25} (5% is ${band[4].d25} pt worse)`, needs: "do not retry" });
add({ rank: 9, name: "Re-cut the ZN window (45 windows tried, select on 2002-2018, read once on 2019-2026)", kind: "does-not-work", usdMo: TW.selectThenTest.usdPerMonthPer100k, dd: "n/a", evidence: `discovery pick [${TW.selectThenTest.pick.a}..${TW.selectThenTest.pick.b}] holdout ${TW.selectThenTest.holdMeanPct}%/mo t ${TW.selectThenTest.holdT} vs the registered [-5..0] ${TW.selectThenTest.registeredHoldMeanPct}%/mo`, needs: "do not retry; extending into the next month does not help" });
add({ rank: 10, name: "Crypto leg through spot ETFs (IBIT / ETHA) instead of spot", kind: "does-not-work", usdMo: Math.round(100000 * (lag1.d - 0.25 * 0.15 * L.E.onSharePct / 100) / 100 / 12), dd: "none", evidence: `1-day lag ${lag1.d} pt plus 0.25%/yr expense on the held 15%; measured IBIT vs BTC gap in the cache is larger than the expense`, needs: "do not retry unless the spot venue's per-switch fee is > ~25 bps" });
add({ rank: 11, name: "R338 Treasury auction cycle on the full tenor ladder (third orthogonal leg candidate)", kind: "needs-forward-test", usdMo: 0, dd: "unknown", evidence: "registered 2026-10-07, historical read once, NOT read; the 10y/30y version R184 DID NOT PASS (t 0.53), S18 could not separate", needs: "the R338 read; no number is available or used here" });

console.log("PLAN E - RANKED LEVERS ($/month on the $100,000 paper anchor, in-sample; ranking: the two scale-up levers first (the most dollars; both are leverage on exposures already held, and rank 1 buys its dollars with a tenth of the drawdown rank 2 does), then the frictions that add no risk but rest on facts not in the repo, then the sleeve candidate, then what does not work)");
console.log("rank kind               $/mo     lever");
for (const r of rows) console.log(`${String(r.rank).padStart(3)}  ${r.kind.padEnd(18)} ${usd(r.usdMo).padStart(6)}   ${r.name}\n        dd: ${r.dd}\n        evidence: ${r.evidence}\n        needs: ${r.needs}`);
console.log("\nDEFECTS (not levers): " + [
  `buildBook window: forward rows 09-28..10-09 off by ${usd(BD.forward.defectUsdPer100k)} compounded, daily swings to ${usd(Math.max(...BD.forward.rows.map((r) => Math.abs(r.spurious)))* 100000)}; a 12-month forward file would read ${BD.hypotheticalYear.asWritten.cagrPct}% instead of ${BD.hypotheticalYear.fixed.cagrPct}% (R270 evidence); paper record unaffected (${BD.paperRecord.paperDollarEffect} $)`,
  `Coinbase fetch drops ${BL.coinbaseHoles.repoPatternHoles} candles: Plan E CAGR ${BL.coinbaseHoles.E_repoPattern}% vs ${BL.coinbaseHoles.E_complete}% (${usd(100000 * (BL.coinbaseHoles.E_repoPattern - BL.coinbaseHoles.E_complete) / 100 / 12)}/mo of irreproducibility)`,
  `ZN proxy unfinanced: the model overstates ZN by ${L.B.overstatePtPerYr} pt/yr = ${usd(100000 * L.B.overstatePtPerYr / 100 / 12)}/mo; the scoreboard's model line inherits it, so from the 2026-10-23 window the paper-vs-model line will drift negative by about that much without any real shortfall`,
].join("\n  - "));
require("../lib/atomic-write.js").writeJsonAtomic(path.join(__dirname, "..", "data", "profit-program", "planE-ranked.json"), { spec: "planE-ranked-v1", rows });
console.log("\nwrote backend/data/profit-program/planE-ranked.json");
