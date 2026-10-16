#!/usr/bin/env node
// MOTIVATING-SAMPLE ONLY — not a registered test, not evidence. Feasibility + rough effect-size
// check for atsPct (FINRA weekly dark-pool/ATS share of volume) as a standalone hypothesis.
"use strict";
const path = require("path");
const REPO = "C:\\Users\\joshc\\Downloads\\traids (2)\\traids-bundle";

require("dotenv").config({ path: path.join(REPO, "backend", ".env") });
const { fetchBarsWithBenchmark } = require("./lib/alpaca-bars.js");

const SYMS = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AMD","NFLX","CRM",
              "ADBE","AVGO","INTC","QCOM","MU","TXN","ORCL","CSCO","IBM","NOW"];

async function atsWeekly(sym) {
  const r = await fetch("https://api.finra.org/data/group/otcMarket/name/weeklySummary", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ limit: 5000, compareFilters: [
      { compareType: "EQUAL", fieldName: "issueSymbolIdentifier", fieldValue: sym },
      { compareType: "EQUAL", fieldName: "summaryTypeCode", fieldValue: "ATS_W_SMBL" },
    ], dateRangeFilters: [{ fieldName: "weekStartDate", startDate: "2021-06-01", endDate: "2026-08-01" }] }),
  });
  if (!r.ok) return [];
  const rows = await r.json();
  if (!Array.isArray(rows)) return [];
  // keep the latest-published row per week (dedupe revisions)
  const byWeek = new Map();
  for (const row of rows) {
    const wk = row.weekStartDate, shares = parseFloat(row.totalWeeklyShareQuantity), pub = row.lastUpdateDate || row.initialPublishedDate;
    if (!wk || !Number.isFinite(shares) || !pub) continue;
    const prev = byWeek.get(wk);
    if (!prev || pub > prev.pub) byWeek.set(wk, { wk, shares, pub });
  }
  return [...byWeek.values()].sort((a, b) => a.wk.localeCompare(b.wk));
}

function isoMonday(dstr) {
  const d = new Date(dstr + "T00:00:00Z");
  const day = d.getUTCDay(); // 0 sun .. 6 sat
  const diff = (day === 0 ? -6 : 1 - day);
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

(async () => {
  // FEED FIXED 2026-08-28 (the join bug this file exists to surface): the wrapper defaults to
  // feed="iex" (a few percent of the true tape), while atsWeekly() above is FINRA's share of
  // the FULL consolidated tape. Dividing FINRA's shares by IEX-only volume inflated every ratio
  // 5-20x, which the atsPct<1.5 sanity filter below then (correctly) rejected -- for 11 of the
  // 20 names here it rejected EVERY week, looking exactly like a date-join failure. Reproduced
  // and confirmed live: feed=sip took usable weeks for those 11 names from 0 -> effectively all.
  // SIP has no same-day access on this account tier (confirmed live: end=today -> 403 "subscription
  // does not permit querying recent SIP data"; end=yesterday -> 200). The ATS join never needs today
  // anyway -- FINRA's own publication lag is 2-3 weeks -- so the end date is clamped one day back.
  const sipEnd = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  console.log("Fetching Alpaca daily bars, SIP/consolidated feed (SPY benchmark) 2021-01-01.." + sipEnd, "for", SYMS.length, "symbols...");
  const { bars } = await fetchBarsWithBenchmark("SPY", SYMS, { start: "2021-01-01", end: sipEnd, timeframe: "1Day", minBars: 200, feed: "sip", quiet: true });
  const spy = bars.SPY.map(b => ({ d: String(b.t).slice(0, 10), c: b.c }));
  const spyIdx = new Map(spy.map((b, i) => [b.d, i]));

  const rows = [];
  for (const sym of SYMS) {
    process.stdout.write(`  ${sym}... `);
    const weeks = await atsWeekly(sym);
    await new Promise(r => setTimeout(r, 150));
    const s = (bars[sym] || []).map(b => ({ d: String(b.t).slice(0, 10), c: b.c, v: b.v }));
    if (s.length < 200 || !weeks.length) { console.log(`skip (bars=${s.length}, weeks=${weeks.length})`); continue; }
    const dIdx = new Map(s.map((b, i) => [b.d, i]));
    // weekly volume = sum of daily volume for trading days whose ISO Monday == wk
    const volByWeek = new Map();
    for (const b of s) {
      const wk = isoMonday(b.d);
      volByWeek.set(wk, (volByWeek.get(wk) || 0) + b.v);
    }
    let used = 0;
    for (const w of weeks) {
      const wkVol = volByWeek.get(w.wk);
      if (!wkVol) continue;
      const atsPct = w.shares / wkVol;
      if (!(atsPct > 0 && atsPct < 1.5)) continue;
      // entry = first trading day strictly after publish date (lag honored)
      const pubDate = w.pub;
      let ei = s.findIndex(b => b.d > pubDate);
      if (ei < 0 || ei + 20 >= s.length) continue;
      const c0 = s[ei].c, c20 = s[ei + 20].c;
      const si0 = spyIdx.get(s[ei].d), si20 = spyIdx.get(s[ei + 20].d);
      if (si0 == null || si20 == null) continue;
      const symRet = c20 / c0 - 1, spyRet = spy[si20].c / spy[si0].c - 1;
      rows.push({ sym, wk: w.wk, pubDate, atsPct, fwd20mktAdj: symRet - spyRet });
      used++;
    }
    console.log(`weeks=${weeks.length} usable=${used}`);
  }

  console.log("\nTotal usable (sym,week) observations:", rows.length);
  const fs = require("fs");
  fs.writeFileSync(path.join(__dirname, "ats-motivating-rows.json"), JSON.stringify(rows));

  // Within-symbol percentile rank of atsPct, then pool into terciles
  const bySym = new Map();
  for (const r of rows) { if (!bySym.has(r.sym)) bySym.set(r.sym, []); bySym.get(r.sym).push(r); }
  for (const [sym, arr] of bySym) {
    const sorted = [...arr].sort((a, b) => a.atsPct - b.atsPct);
    sorted.forEach((r, i) => { r.pctile = i / (sorted.length - 1 || 1); });
  }
  const lo = rows.filter(r => r.pctile <= 1 / 3);
  const mid = rows.filter(r => r.pctile > 1 / 3 && r.pctile < 2 / 3);
  const hi = rows.filter(r => r.pctile >= 2 / 3);
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
  for (const [name, arr] of [["LOW ats tercile", lo], ["MID ats tercile", mid], ["HIGH ats tercile", hi]]) {
    const v = arr.map(r => r.fwd20mktAdj);
    const m = mean(v), s = sd(v), t = m / (s / Math.sqrt(v.length));
    console.log(`${name}: n=${v.length} mean fwd20 mkt-adj=${(m * 100).toFixed(2)}% (naive per-obs t=${t.toFixed(2)})`);
  }

  // week-clustered (episode) count for honest N
  const weeksSet = new Set(rows.map(r => r.wk));
  console.log("\nDistinct calendar weeks touched:", weeksSet.size, "— true effective N given 20-day overlapping windows is far below the row count (see #52 precedent: ~1 indep obs per ~4 calendar weeks per symbol at a 20-day horizon).");
})().catch(e => { console.error("ERROR", e); process.exit(1); });
