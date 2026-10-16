"use strict";
// STEP 4 (timing): when does today's NAV appear on Yahoo? One request. Run it a few times on a market evening (for example 17:30,
// 18:30, 20:30 New York time) and note the first run in which the latest NAV row carries today's date.
// Prints the New York clock and, for five NAV symbols, the date of the latest row that has a value. No value is printed.
const { get, readCount, day } = require("./scout-lib.cjs");
(async () => {
  const syms = (process.argv[2] || "XPDIX,XGAMX,XNUVX,XADEX,XUSAX").split(",").slice(0, 5), now = Math.floor(Date.now() / 1000);
  console.log("clock New York:", new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const r = await get(`https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?period1=${now - 20 * 86400}&period2=${now}&interval=1d&comparisons=${syms.join(",")}`);
  const res = JSON.parse(r.text).chart.result[0], ts = res.timestamp;
  console.log("latest market day on the calendar:", day(ts[ts.length - 1]));
  for (const c of res.comparisons || []) { let l = -1; c.close.forEach((v, i) => { if (v != null) l = i; }); console.log(`  ${c.symbol}: latest NAV row with a value is dated ${l >= 0 ? day(ts[l]) : "-"}`); }
  console.log("requests so far:", JSON.stringify(readCount()));
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
