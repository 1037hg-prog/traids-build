#!/usr/bin/env node
"use strict";
/**
 * SHORT LEG, LANE 1 — step 1: the price marks needed to put every settled ticket's dollars on the SPY session it was earned in.
 * READ-ONLY market data (Alpaca data API, GET only; no order path is touched). Writes ONE file: backend/data/short-leg/bars-cache.json
 * (lib/atomic-write.js). Every later script reads that file and never goes to the network, so a re-run is deterministic.
 *
 *   node backend/short-leg/fetch-bars.js          fetch + write
 *
 * What is fetched, and why it is enough:
 *   SPY daily (IEX feed, raw)  -> the session calendar and the day's close-to-close move that defines the worst days
 *   every Equity symbol on a clean-era SIGNAL ticket or an agent-book ticket, daily raw closes -> the mark at each SPY close
 *   every Crypto symbol, hourly closes -> the mark at 16:00 ET (the hourly bar that starts 15:00 ET), so a crypto ticket is cut at the
 *     same instant SPY's session is cut. Alpaca's own daily crypto bar ends at 00:00 UTC (20:00 ET), 4 hours later.
 * The SIP feed answers 403 for this key (checked 2026-10-11), so IEX is used. IEX closes differ from the consolidated close by up to
 * a few cents on SPY (e.g. 2026-10-09: 778.51 here against 778.57 in data/r316-bars.json). The effect on the ordering of worst days is
 * tested in lane1-own-shorts.js (it re-ranks the days on the r316 closes where they overlap and reports whether the worst-day set moves).
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const { fetchBars } = require("../lib/alpaca-bars.js");
const { fetchCryptoBars } = require("../lib/crypto-bars.js");
const REC = require("../lib/reconcile.js");
const OUT = path.join(__dirname, "..", "data", "short-leg", "bars-cache.json");

(async () => {
  const L = REC.cleanEraLedger();
  const A = fs.readFileSync(path.join(__dirname, "..", "data", "agent-book-ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const rows = [...L.signals, ...A];
  const eq = [...new Set(rows.filter((t) => t.cls === "Equity").map((t) => t.sym))].sort();
  const cx = [...new Set(rows.filter((t) => t.cls === "Crypto").map((t) => t.sym))].sort();
  console.log(`equity symbols ${eq.length}, crypto symbols ${cx.length}`);
  const start = "2026-07-08", end = "2026-10-12";
  const e = await fetchBars(["SPY", ...eq], { start, end, timeframe: "1Day", feed: "iex", adjustment: "raw", requireAll: false, quiet: true, chunkSize: 25 });
  const equityDaily = {};
  for (const [s, b] of Object.entries(e.bars)) equityDaily[s] = b.map((x) => [x.t.slice(0, 10), x.c]);
  console.log(`equity daily: ${Object.keys(equityDaily).length} returned, ${e.missing.length} missing (${e.missing.slice(0, 12).join(",")}${e.missing.length > 12 ? ",..." : ""})`);
  const c = await fetchCryptoBars(cx, "1Hour", start, end);
  const cryptoHourly = {};
  for (const [s, b] of Object.entries(c)) cryptoHourly[s] = b.map((x) => [Math.floor(Date.parse(x.t) / 1000), x.c]);
  console.log(`crypto hourly (Alpaca): ${Object.keys(cryptoHourly).length} of ${cx.length} returned`);
  // The rest of the crypto universe is not on Alpaca's crypto feed; Coinbase Exchange public candles (no key, GET only) carry them.
  const cryptoSource = {}; for (const s of Object.keys(cryptoHourly)) cryptoSource[s] = "alpaca";
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const sym of cx.filter((x) => !cryptoHourly[x])) {
    const prod = sym.replace("/", "-"), got = new Map();
    let ok = true;
    for (let a = Date.parse(start + "T00:00:00Z"); a < Date.parse(end + "T00:00:00Z"); a += 299 * 3600e3) {
      const b = Math.min(a + 299 * 3600e3, Date.parse(end + "T00:00:00Z"));
      const url = `https://api.exchange.coinbase.com/products/${prod}/candles?granularity=3600&start=${new Date(a).toISOString()}&end=${new Date(b).toISOString()}`;
      let arr = null;
      for (let k = 0; k < 3 && !arr; k++) { try { const r = await fetch(url, { headers: { "User-Agent": "TRAIDS short-leg bars (research, read-only)" } }); if (r.status === 404) { ok = false; break; } const j = await r.json(); if (Array.isArray(j)) arr = j; else await nap(800); } catch { await nap(800); } }
      if (!ok) break;
      for (const [t, , , , c] of (arr || [])) got.set(t, c);
      await nap(250);
    }
    if (ok && got.size > 24 * 30) { cryptoHourly[sym] = [...got.entries()].sort((x, y) => x[0] - y[0]); cryptoSource[sym] = "coinbase"; }
  }
  console.log(`crypto hourly (Alpaca + Coinbase): ${Object.keys(cryptoHourly).length} of ${cx.length}; still missing: ${cx.filter((x) => !cryptoHourly[x]).join(",") || "none"}`);
  writeJsonAtomic(OUT, { spec: "short-leg-bars-cache-v1", fetchedAt: new Date().toISOString(), feed: "iex (SIP answers 403 for this key)", adjustment: "raw", start, end,
    note: "equityDaily[sym] = [[YYYY-MM-DD, close]]; cryptoHourly[sym] = [[epochSeconds of the hour START, close]]. SPY is equityDaily.SPY.", equityMissing: e.missing, cryptoMissing: cx.filter((s) => !cryptoHourly[s]), cryptoSource, equityDaily, cryptoHourly });
  console.log("written", OUT);
})().catch((err) => { console.error("ERR", err.message); process.exitCode = 1; });
