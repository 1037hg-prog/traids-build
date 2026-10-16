"use strict";
// STEP 1b (the funds that died): is there a free source that (a) names closed-end funds that no longer exist and (b) still serves their history?
//   node scout-graveyard.cjs cdx                 -> which past copies of the public daily-pricing list the Internet Archive holds (1 request)
//   node scout-graveyard.cjs snap <timestamp>    -> one past copy: how many of its funds are gone from today's list (1 request)
//   node scout-graveyard.cjs yahoo <timestamp>   -> do Yahoo's price and NAV series still exist for a sample of the gone funds (2 requests)
// OUTCOME FENCE: a past copy carries that day's discounts and trailing returns. Only Ticker, Name, NavTicker, CategoryName and the date
// fields are kept; nothing else is printed or stored. Counts and names only.
const fs = require("fs"), path = require("path");
const { get, CACHE, readCount, day } = require("./scout-lib.cjs");
const KEEP = ["Ticker", "Name", "NavTicker", "CategoryName", "LastUpdated", "NAVPublished", "InceptionDate"];
const today = JSON.parse(fs.readFileSync(path.join(CACHE, "cefconnect-universe-slim.json"), "utf8"));
const snapFile = (ts) => path.join(CACHE, `wayback-dailypricing-${ts}.slim.json`);
(async () => {
  const mode = process.argv[2], ts = process.argv[3];
  if (mode === "cdx") {
    const r = await get("http://web.archive.org/cdx/search/cdx?url=cefconnect.com/api/v3/DailyPricing&output=json&fl=timestamp,statuscode,length,mimetype&filter=statuscode:200&collapse=timestamp:6", { timeoutMs: 60000 });
    console.log("HTTP", r.status, r.text.length, "bytes");
    const rows = JSON.parse(r.text).slice(1);
    console.log("monthly-collapsed copies with HTTP 200:", rows.length, "| first", rows[0] && rows[0][0], "| last", rows.length && rows[rows.length - 1][0]);
    const byYear = {}; for (const a of rows) byYear[a[0].slice(0, 4)] = (byYear[a[0].slice(0, 4)] || 0) + 1; console.log("copies per year:", JSON.stringify(byYear));
    console.log("timestamps (one per month):", rows.map((a) => a[0] + ":" + a[2]).join(" "));
    fs.writeFileSync(path.join(CACHE, "wayback-cdx.json"), JSON.stringify(rows));
  } else if (mode === "snap") {
    let slim;
    if (fs.existsSync(snapFile(ts))) slim = JSON.parse(fs.readFileSync(snapFile(ts), "utf8"));
    else {
      const r = await get(`http://web.archive.org/web/${ts}id_/https://www.cefconnect.com/api/v3/DailyPricing`, { timeoutMs: 90000 });
      console.log("HTTP", r.status, r.contentType, r.text.length, "bytes");
      if (r.status !== 200) { console.log(r.text.slice(0, 200)); return; }
      const rows = JSON.parse(r.text); slim = rows.map((x) => Object.fromEntries(KEEP.map((k) => [k, x[k]])));
      fs.writeFileSync(snapFile(ts), JSON.stringify(slim));
    }
    const now = new Set(today.map((r) => r.Ticker)), then = new Set(slim.map((r) => r.Ticker));
    const gone = slim.filter((r) => !now.has(r.Ticker)), born = today.filter((r) => !then.has(r.Ticker));
    const asOf = {}; for (const r of slim) { const k = String(r.LastUpdated).slice(0, 10); asOf[k] = (asOf[k] || 0) + 1; }
    console.log(`copy ${ts}: ${slim.length} funds, as of ${JSON.stringify(asOf)}`);
    console.log(`on that list and NOT on today's list: ${gone.length} of ${slim.length} (${(100 * gone.length / slim.length).toFixed(1)}%) | on today's list and not on that one: ${born.length}`);
    const cat = {}; for (const r of gone) { const k = String(r.CategoryName || "?").replace("Morningstar US CEF ", ""); cat[k] = (cat[k] || 0) + 1; } console.log("gone, by that list's category:", JSON.stringify(cat));
    console.log("gone tickers:", gone.map((r) => r.Ticker).join(" "));
  } else if (mode === "yahoo") {
    const slim = JSON.parse(fs.readFileSync(snapFile(ts), "utf8")), now = new Set(today.map((r) => r.Ticker));
    const gone = slim.filter((r) => !now.has(r.Ticker) && r.NavTicker && r.NavTicker !== r.Ticker);
    const step = Math.max(1, Math.floor(gone.length / 5)), pick = [0, 1, 2, 3, 4].map((k) => gone[k * step]).filter(Boolean); // an evenly spaced sample of five, not chosen by eye
    console.log("sample of gone funds:", pick.map((r) => `${r.Ticker} (${r.Name}) NAV symbol ${r.NavTicker}`).join(" | "));
    for (const syms of [pick.map((r) => r.Ticker), pick.map((r) => r.NavTicker)]) {
      const r = await get(`https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?period1=0&period2=${Math.floor(Date.now() / 1000)}&interval=1d&comparisons=${encodeURIComponent(syms.join(","))}`, { timeoutMs: 90000 });
      if (r.status !== 200) { console.log("HTTP", r.status); continue; }
      const res = JSON.parse(r.text).chart.result[0], tsA = res.timestamp, got = new Map((res.comparisons || []).map((c) => [c.symbol, c]));
      for (const s of syms) { const c = got.get(s); if (!c) { console.log(`  ${s}: NOT SERVED`); continue; } let n = 0, f = -1, l = -1; c.close.forEach((v, i) => { if (v != null) { n++; if (f < 0) f = i; l = i; } }); console.log(`  ${s}: ${n} rows ${n ? day(tsA[f]) + ".." + day(tsA[l]) : ""}`); }
    }
  }
  console.log("requests so far:", JSON.stringify(readCount()));
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
