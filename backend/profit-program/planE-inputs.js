#!/usr/bin/env node
"use strict";
/**
 * PLAN E PROFIT PROGRAM - input cache. READ-ONLY on the repo. GETs only (Alpaca SIP daily bars + Alpaca /v2/calendar on the main data keys,
 * Coinbase public daily candles). Writes ONE file: backend/data/profit-program/planE-inputs.json (lib/atomic-write.js writeJsonAtomic).
 * Every other planE-*.js printer in this folder reads that file and needs no network, so the numbers they print are reproducible from it.
 *
 *   node backend/profit-program/planE-inputs.js            fetch (or report) - refuses to overwrite a cache younger than 6 hours unless --refresh
 *   node backend/profit-program/planE-inputs.js --refresh  re-fetch
 *   node backend/profit-program/planE-inputs.js --show     print what the cache holds
 *
 * Why a cache: SIP "adjustment=all" bars are re-adjusted for dividends on every fetch, so two fetches a month apart differ in the 4th decimal
 * of old history. The cache pins one fetch so a chain of printers agrees with itself.
 *
 * TWO crypto series are stored. `crypto` = midnight-aligned chunks (the planE-paper-scoreboard.js pattern), every completed UTC day present.
 * `cryptoRiskManagerStyle` = the fetch pattern of risk-manager.js / plan-years.js coinbase() (299-day chunks cut at now-minus-N-days, next chunk
 * ends one day before the previous start): it silently drops one candle at each chunk boundary (~every 300th day) - a defect, kept here only so
 * planE-baseline.js can measure what the holes do to the Plan E number.
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const { fetchBars } = require("../lib/alpaca-bars.js");
const OUT = path.join(__dirname, "..", "data", "profit-program", "planE-inputs.json");
const SYMS = ["QQQ", "SPY", "GLD", "EFA", "DBMF", "IEF", "TLT", "JAAA", "SGOV", "BIL", "FLOT", "USFR", "ICSH", "IBIT", "ETHA", "FBTC"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CB = (coin, s, e) => `https://api.exchange.coinbase.com/products/${coin}-USD/candles?granularity=86400&start=${new Date(s).toISOString()}&end=${new Date(e).toISOString()}`;

/** the repo's pattern (risk-manager.js): kept to measure its holes */
async function coinbaseRepoStyle(coin, fromIso) {
  const all = [], stop = Date.parse(fromIso); let end = Date.now();
  while (end > stop) {
    const s = Math.max(stop, end - 299 * 864e5);
    const r = await fetch(CB(coin, s, end), { headers: { "User-Agent": "TRAIDS planE-profit-program" } });
    const a = await r.json(); if (!Array.isArray(a)) throw new Error(`coinbase ${coin}: ${JSON.stringify(a).slice(0, 100)}`);
    all.push(...a); if (!a.length && all.length) break; end = s - 864e5; await sleep(350);
  }
  const m = {}; for (const [t, , , , c] of all) m[new Date(t * 1000).toISOString().slice(0, 10)] = c; return m;
}
/** midnight-aligned chunks: no day is dropped at a chunk boundary. Completed UTC days only. */
async function coinbaseAligned(coin, fromDay) {
  const todayUtc = new Date().toISOString().slice(0, 10), stop = Date.parse(todayUtc + "T00:00:00Z"), m = {};
  for (let s = Date.parse(fromDay + "T00:00:00Z"); s < stop;) {
    const e = Math.min(stop, s + 290 * 864e5);
    const r = await fetch(CB(coin, s, e), { headers: { "User-Agent": "TRAIDS planE-profit-program" } });
    const a = await r.json(); if (!Array.isArray(a)) throw new Error(`coinbase ${coin}: ${JSON.stringify(a).slice(0, 100)}`);
    for (const x of a) { const d = new Date(x[0] * 1000).toISOString().slice(0, 10); if (d < todayUtc) m[d] = x[4]; }
    s = e; if (s < stop) await sleep(350);
  }
  return m;
}
const nextYm = (ym) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7); };
async function calendar(startYm, endYm) {
  // Alpaca /v2/calendar via the same call R219's monthSessions makes (GET). Keys come from backend/.env; never printed.
  const H = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY };
  const out = {};
  for (let ym = startYm; ym <= endYm; ym = nextYm(ym)) {
    const [y, m] = ym.split("-").map(Number), end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const r = await fetch(`https://paper-api.alpaca.markets/v2/calendar?start=${ym}-01&end=${end}`, { headers: H });
    if (!r.ok) throw new Error(`calendar ${ym}: HTTP ${r.status}`);
    out[ym] = (await r.json()).map((x) => x.date);
  }
  return out;
}

(async () => {
  if (process.argv.includes("--show")) {
    const j = JSON.parse(fs.readFileSync(OUT, "utf8"));
    console.log(`planE-inputs.json fetched ${j.fetchedAt}`);
    for (const [s, b] of Object.entries(j.bars)) console.log(`  ${s.padEnd(5)} ${b.length} bars ${b[0].t.slice(0, 10)}..${b[b.length - 1].t.slice(0, 10)}`);
    for (const key of ["crypto", "cryptoRiskManagerStyle"]) for (const [c, m] of Object.entries(j[key])) { const k = Object.keys(m).sort(); console.log(`  ${key} ${c} ${k.length} UTC days ${k[0]}..${k[k.length - 1]}`); }
    console.log(`  calendar months: ${Object.keys(j.calendar).join(", ")}`);
    return;
  }
  if (fs.existsSync(OUT) && !process.argv.includes("--refresh")) {
    const age = (Date.now() - Date.parse(JSON.parse(fs.readFileSync(OUT, "utf8")).fetchedAt)) / 36e5;
    if (age < 6) { console.log(`cache is ${age.toFixed(1)}h old (< 6h) - use --refresh to re-fetch`); return; }
  }
  const end = new Date(Date.now() - 20 * 60e3).toISOString();
  const r = await fetchBars(SYMS, { start: "2018-06-01", end, feed: "sip", adjustment: "all", quiet: true, requireAll: false });
  const bars = {}; for (const s of Object.keys(r.bars)) bars[s] = r.bars[s].map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
  const missing = SYMS.filter((s) => !bars[s]);
  const crypto = { BTC: await coinbaseAligned("BTC", "2018-06-01"), ETH: await coinbaseAligned("ETH", "2018-06-01") };
  const cryptoRiskManagerStyle = { BTC: await coinbaseRepoStyle("BTC", "2018-06-01"), ETH: await coinbaseRepoStyle("ETH", "2018-06-01") };
  const cal = await calendar("2026-09", "2026-12");
  writeJsonAtomic(OUT, { spec: "planE-inputs-v1", fetchedAt: new Date().toISOString(), feed: "sip", adjustment: "all", missingSymbols: missing, truncatedStart: r.truncatedStart || [], bars, crypto, cryptoRiskManagerStyle, calendar: cal });
  console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${Object.keys(bars).length} symbols, missing: ${missing.join(",") || "none"}`);
})().catch((e) => { console.error("planE-inputs FAILED:", e.message); process.exit(1); });
