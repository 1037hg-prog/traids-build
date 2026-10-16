"use strict";
// STEP 1 (universe): the public daily-pricing list of US-listed closed-end funds that cefconnect.com's own page fetches as plain JSON
// (GET https://www.cefconnect.com/api/v3/DailyPricing, no login, no key). One request.
// OUTCOME FENCE: the raw response carries current discounts, z-scores and trailing returns. This script NEVER prints or stores them:
// it keeps the descriptive fields in KEEP only, in memory, and writes just that slim list to the cache folder.
const fs = require("fs"), path = require("path");
const { get, CACHE, readCount } = require("./scout-lib.cjs");
const KEEP = ["Ticker", "Name", "CategoryId", "CategoryName", "SponsorName", "Cusip", "NavTicker", "NAVPublished", "LastUpdated", "Strategy", "IsLeveraged", "Term",
  "DistributionFrequency", "IsManagedDistribution", "MarketCapUSDm", "TotalAssetsUSDm", "AvgDailyVolume", "InceptionDate", "InceptionDateString"];
const OUT = path.join(CACHE, "cefconnect-universe-slim.json");
(async () => {
  let slim;
  if (fs.existsSync(OUT)) { slim = JSON.parse(fs.readFileSync(OUT, "utf8")); console.log("using cached slim list:", OUT); }
  else {
    const r = await get("https://www.cefconnect.com/api/v3/DailyPricing", { headers: { Accept: "application/json, text/plain, */*" } });
    if (r.status !== 200 || !/json/.test(r.contentType)) { console.log("NOT SERVED AS JSON: HTTP", r.status, r.contentType, "- left alone"); process.exit(2); }
    const rows = JSON.parse(r.text);
    console.log("rows:", rows.length, "| field NAMES in the raw response:", Object.keys(rows[0] || {}).join(", "));
    slim = rows.map((x) => Object.fromEntries(KEEP.map((k) => [k, x[k]])));
    fs.writeFileSync(OUT, JSON.stringify(slim));
  }
  const tally = (k, fn = (x) => x) => { const t = {}; for (const r of slim) { const v = fn(r[k]); t[v] = (t[v] || 0) + 1; } return Object.entries(t).sort((a, b) => b[1] - a[1]); };
  console.log("funds:", slim.length, "unique tickers:", new Set(slim.map((r) => r.Ticker)).size);
  console.log("list as of (LastUpdated):", JSON.stringify(tally("LastUpdated", (v) => String(v).slice(0, 10))));
  console.log("date of each fund's latest published NAV:", JSON.stringify(tally("NAVPublished", (v) => String(v).slice(0, 10))));
  console.log("funds whose latest NAV is older than the list date:", slim.filter((r) => String(r.NAVPublished).slice(0, 10) !== String(r.LastUpdated).slice(0, 10)).map((r) => `${r.Ticker}(${String(r.NAVPublished).slice(0, 10)})`).join(" "));
  console.log("NAV symbol equals X+ticker+X:", slim.filter((r) => r.NavTicker === "X" + r.Ticker + "X").length, "| null:", slim.filter((r) => !r.NavTicker).map((r) => r.Ticker).join(","),
    "| different:", slim.filter((r) => r.NavTicker && r.NavTicker !== "X" + r.Ticker + "X").map((r) => r.Ticker + "->" + r.NavTicker).join(" "));
  console.log("categories:", JSON.stringify(tally("CategoryName", (v) => String(v).replace("Morningstar US CEF ", ""))));
  console.log("inception decade:", JSON.stringify(tally("InceptionDate", (v) => (v ? String(v).slice(0, 3) + "0s" : "null"))));
  console.log("term funds (a scheduled end date):", slim.filter((r) => r.Term === true).length, "| distribution frequency:", JSON.stringify(tally("DistributionFrequency")));
  console.log("requests so far:", JSON.stringify(readCount()));
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
