#!/usr/bin/env node
/**
 * IPO UNIVERSE (survivorship-free) — 2026-09-23, for the Payne "IPO reversal" rule. Pulls Alpha Vantage LISTING_STATUS for active AND
 * delisted US listings (two calls; each row carries ipoDate and delistingDate) and freezes the common stocks that listed 2016-01-01 ..
 * 2025-09-22, keeping the failures. Prices come later from Alpaca SIP, which still serves bars for delisted symbols (checked: IRNT, FSR,
 * RIDE, NKLA, SDC). Never prints the key. Refuses to overwrite a frozen universe.
 */
const fs = require("fs"), path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const OUT = path.join(__dirname, "data", "ipo-universe.json"), KEY = process.env.ALPHAVANTAGE_KEY || process.env.ALPHA_VANTAGE_KEY;
if (fs.existsSync(OUT)) { const j = JSON.parse(fs.readFileSync(OUT, "utf8")); console.log(`ipo-universe already frozen: ${j.names.length} names (sha ${j.sha}) — refusing to refetch`); process.exit(0); }
const FROM_FILES = process.argv.includes("--from-files");   // CSVs saved from the Alpha Vantage connector (data/av-listing-status-{active,delisted}-2026-09-23.csv)
if (!KEY && !FROM_FILES) { console.error("Alpha Vantage key not set"); process.exit(2); }
const parse = (csv) => { const [head, ...rows] = csv.trim().split(/\r?\n/); const h = head.split(","); return rows.map((r) => { const c = r.split(","); return Object.fromEntries(h.map((k, i) => [k, c[i]])); }); };
(async () => {
  const all = [];
  for (const state of ["active", "delisted"]) {
    if (FROM_FILES) { const rows = parse(fs.readFileSync(path.join(__dirname, "data", `av-listing-status-${state}-2026-09-23.csv`), "utf8")); console.log(`LISTING_STATUS ${state} (file): ${rows.length} rows`); all.push(...rows.map((x) => ({ ...x, state }))); continue; }
    const r = await fetch(`https://www.alphavantage.co/query?function=LISTING_STATUS&state=${state}&apikey=${KEY}`, { signal: AbortSignal.timeout(60000) });
    const txt = await r.text(); if (!r.ok || !txt.startsWith("symbol,")) { console.error(`LISTING_STATUS ${state}: unexpected response (${r.status}, ${txt.length} chars) — rate limit?`); process.exit(1); }
    const rows = parse(txt); console.log(`LISTING_STATUS ${state}: ${rows.length} rows`); all.push(...rows.map((x) => ({ ...x, state })));
    await new Promise((z) => setTimeout(z, 15000));
  }
  // common stocks only: drop ETFs, and SPAC shells / units / warrants / rights / preferreds by name and symbol pattern
  const bad = /acquisition|capital corp|holdings corp i+|merger|spac|\bunits?\b|warrant|rights?\b|preferred|depositary|trust\b|fund\b|etf|etn|notes?\b|%/i;
  const keep = all.filter((x) => x.assetType === "Stock" && (x.exchange === "NYSE" || x.exchange === "NASDAQ" || x.exchange === "NYSE MKT") && x.ipoDate >= "2016-01-01" && x.ipoDate <= "2025-09-22" && !bad.test(x.name || "") && /^[A-Z]{1,5}$/.test(x.symbol));
  const names = keep.map((x) => ({ symbol: x.symbol, name: x.name, exchange: x.exchange, ipoDate: x.ipoDate, delistingDate: x.delistingDate === "null" ? null : x.delistingDate, state: x.state })).sort((a, b) => a.ipoDate.localeCompare(b.ipoDate) || a.symbol.localeCompare(b.symbol));
  const sha = require("crypto").createHash("sha256").update(JSON.stringify(names)).digest("hex").slice(0, 12);
  writeJsonAtomic(OUT, { spec: "ipo-universe-v1", frozenAt: new Date().toISOString(), source: FROM_FILES ? "Alpha Vantage LISTING_STATUS active + delisted, full CSVs saved 2026-09-23 via the Alpha Vantage connector (data/av-listing-status-*.csv)" : "Alpha Vantage LISTING_STATUS active + delisted (2 calls)", filter: "assetType Stock, NYSE/NASDAQ/NYSE MKT, ipoDate 2016-01-01..2025-09-22, SPAC shells/units/warrants/rights/preferreds/funds removed by name, 1-5 letter symbols", counts: { raw: all.length, kept: names.length, delisted: names.filter((x) => x.state === "delisted").length }, sha, names });
  console.log(`ipo-universe frozen: ${names.length} names (${names.filter((x) => x.state === "delisted").length} since delisted), sha ${sha}`);
})().catch((e) => { console.error("ipo-universe-fetch FAILED:", String(e.message).replace(KEY, "<key>")); process.exit(1); });
