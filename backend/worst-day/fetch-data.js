#!/usr/bin/env node
"use strict";
/**
 * WORST-DAY PREDICTOR, step 1: fetch what the repo does not already hold. READ-ONLY market data (GET only). Fetches ONCE; a file that
 * exists is never refetched (delete it to refresh). Writes only under backend/data/training/worst-day/.
 *
 *   node backend/worst-day/fetch-data.js
 *
 * What and why (nothing here is in the r313 / r328 caches):
 *   yahoo-SPY / yahoo-HYG / yahoo-LQD   daily close + dividend-adjusted close via the repo's own :3002 Yahoo proxy (the route R285 / R291 used).
 *       SPY from 1993-01-29 (r313's Schwab SPY starts 1999-01-04 and is price-only: a short pays the dividend, so the P&L needs a total return,
 *       and a 2005 first fit needs labels from 1998). HYG from 2007-04-11, LQD from 2002-07-30.
 *   fred/VIXCLS.csv, fred/VXVCLS.csv    CBOE VIX and 3-month VIX closes, FRED fredgraph.csv (no key), as r312-europe-carry.js fetches FRED.
 *   fed-fomc-2005-2015.json             scheduled FOMC meetings 2005..2015 from federalreserve.gov/monetarypolicy/fomchistorical<year>.htm
 *       (the repo's own list starts 2015-07-29: backend/r196-pre-fomc.js; macro-calendar.json covers 2024+).
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { writeJsonAtomic, writeTextAtomic } = require("../lib/atomic-write.js");
const DIR = path.join(__dirname, "..", "data", "training", "worst-day");
fs.mkdirSync(path.join(DIR, "fred"), { recursive: true });
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

async function yahoo(sym) {
  const f = path.join(DIR, `yahoo-${sym}.json`);
  if (fs.existsSync(f)) { console.log(`  ${sym}: cached`); return; }
  const r = await fetch(`http://localhost:3002/api/yahoo/${sym}/history?days=12500&interval=1d`, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`yahoo ${sym} HTTP ${r.status}`);
  const body = await r.json(); const rows = Array.isArray(body) ? body : body.bars;
  if (!Array.isArray(rows) || rows.length < 1000) throw new Error(`yahoo ${sym}: unexpected shape`);
  writeJsonAtomic(f, { spec: "worst-day-yahoo-v1", symbol: sym, fetchedAt: new Date().toISOString(), source: "Yahoo chart v8 daily via http://localhost:3002/api/yahoo (the repo proxy); close = split-adjusted price, adjClose = dividend-adjusted", n: rows.length, first: rows[0].date, last: rows[rows.length - 1].date, rows }, { pretty: 0 });
  console.log(`  ${sym}: ${rows.length} rows ${rows[0].date}..${rows[rows.length - 1].date}`);
}
async function fred(id) {
  const f = path.join(DIR, "fred", `${id}.csv`);
  if (fs.existsSync(f)) { console.log(`  ${id}: cached`); return; }
  let last = null;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(90000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const t = await r.text(); const L = t.trim().split(/\r?\n/);
      if (L[0] !== `observation_date,${id}`) throw new Error(`unexpected header ${L[0]}`);
      writeTextAtomic(f, t); console.log(`  ${id}: ${L.length - 1} rows ${L[1].split(",")[0]}..${L[L.length - 1].split(",")[0]}`); return;
    } catch (e) { last = e; await nap(3000 * (a + 1)); }
  }
  throw new Error(`FRED ${id}: ${last && last.message}`);
}
const MONTHS = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 };
/** statement day (last day) of a meeting span: "January 26-27", "March 16", "April 30-May 1", "April/May 30-1" */
function statementDay(span) {
  let mm;
  if ((mm = span.match(/^([A-Za-z]+) (\d+)-([A-Za-z]+) (\d+)$/))) return [MONTHS[mm[3]], +mm[4]];
  if ((mm = span.match(/^([A-Za-z]+)\/([A-Za-z]+) (\d+)-(\d+)$/))) return [MONTHS[mm[2]], +mm[4]];
  if ((mm = span.match(/^([A-Za-z]+) (\d+)-(\d+)$/))) return [MONTHS[mm[1]], +mm[3]];
  if ((mm = span.match(/^([A-Za-z]+) (\d+)$/))) return [MONTHS[mm[1]], +mm[2]];
  return [null, null];
}
async function fomc() {
  const f = path.join(DIR, "fed-fomc-2005-2015.json");
  if (fs.existsSync(f)) { console.log("  FOMC: cached"); return; }
  const meetings = [], pages = [];
  for (let y = 2005; y <= 2015; y++) {
    const url = `https://www.federalreserve.gov/monetarypolicy/fomchistorical${y}.htm`;
    const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
    const html = await r.text();
    const heads = [...html.matchAll(/<h5[^>]*>([^<]*)<\/h5>/g)].map((m) => m[1].replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ").trim());
    let n = 0;
    for (const h of heads) {
      const m = h.match(/^(.+?) Meeting - (\d{4})$/); if (!m) continue;      // conference calls are unscheduled and excluded
      const yr = +m[2]; const [mon, day] = statementDay(m[1].trim());
      if (!mon || !day || yr !== y) throw new Error(`unparsed heading ${JSON.stringify(h)}`);
      meetings.push(`${yr}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`); n++;
    }
    pages.push({ year: y, url, bytes: html.length, sha256: sha(html), headings: heads.length, scheduledMeetings: n });
    console.log(`  FOMC ${y}: ${n} scheduled meetings (${heads.length} headings)`);
    await nap(500);
  }
  writeJsonAtomic(f, { spec: "worst-day-fomc-v1", fetchedAt: new Date().toISOString(), note: "statement day = last day of each scheduled meeting; conference calls excluded", pages, meetings: meetings.sort() }, { pretty: 1 });
}
(async () => {
  console.log("fetch-data: only what is missing");
  await yahoo("SPY"); await yahoo("HYG"); await yahoo("LQD");
  await fred("VIXCLS"); await fred("VXVCLS");
  await fomc();
  console.log("done");
})().catch((e) => { console.error("FETCH FAILED:", e.message); process.exit(1); });
