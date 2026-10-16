#!/usr/bin/env node
/**
 * DAILY PANEL BACKFILL — the missing prerequisite, not a test.
 *
 * ═══ WHY ═══
 * Every one of this shop's 114 registered tests lives between one bar and thirty sessions. The
 * multi-week equity cross-section — where most documented equity anomalies actually live — has been
 * touched once. That is not an oversight of imagination. It is that the daily panel built for #78 is
 * 164 sessions deep, which gives EIGHT independent observations at a 20-day horizon and TWO at 60.
 * No bar this shop uses can be cleared on eight observations, so the horizon was never testable.
 *
 * This fetches the depth that makes it testable. At ~2,500 sessions a 20-day horizon has ~125
 * independent periods, 60-day has ~41, 126-day has ~20.
 *
 * ═══ THE BIAS THIS DOES NOT FIX, STATED LOUDLY ═══
 * The symbol list comes from universe-expanded.json, whose own note reads: "current-membership
 * universe — historical studies over it inherit survivorship bias and must say so." Every company
 * that delisted, went to zero, or was acquired is ABSENT. Over 8 months that bias is small. Over 10
 * years it is severe, and it runs in exactly one direction: it manufactures apparent alpha, because
 * the losers were removed before the test began.
 *
 * So this panel is sufficient for DESCRIPTIVE work and for testing a signal's SHAPE, and it is NOT
 * sufficient to establish an edge at a multi-year horizon. The point-in-time universe (AlphaVantage
 * LISTING_STATUS, which returns delisted tickers with delisting dates) is the second half of this
 * job and is not done here. Any test run on this panel alone must carry the caveat, and the output
 * file stamps it so a later reader cannot miss it.
 *
 * ═══ STORAGE ═══
 * Parallel arrays per symbol rather than an object per bar — a bar as {t,o,h,l,c,v} costs ~60 bytes
 * of JSON, the same bar in parallel arrays costs ~25. At 2,000 names x 2,500 sessions that is the
 * difference between a 300 MB file and a 125 MB one.
 *
 * Usage: node backend/daily-panel-backfill.js [--start 2016-01-01] [--names 2000]
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { fetchBarsSip } = require("./lib/sip-fetch.js");
const D = (f) => path.join(__dirname, "data", f);
const OUT = D("daily-panel.json");

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const START = arg("--start", "2016-01-01");
const NAMES = +arg("--names", 2000);

const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };

(async () => {
  // rank by liquidity using the 8-month cache we already have; the top slice is the right universe
  // for cross-sectional work and keeps the fetch honest in size.
  const c = JSON.parse(fs.readFileSync(D("top-gainers-cache.json"), "utf8"));
  const mdv = {};
  for (const d of c.dates) for (const [s, v] of Object.entries(c.byDate[d])) if (Number.isFinite(v.mdv)) (mdv[s] ||= []).push(v.mdv);
  const ranked = Object.entries(mdv).map(([s, v]) => [s, median(v)]).sort((a, b) => b[1] - a[1]).map(([s]) => s);
  const syms = ranked.slice(0, NAMES);

  const today = new Date().toISOString().slice(0, 10);
  console.log(`DAILY PANEL BACKFILL — ${syms.length} names, ${START} -> ${today}`);
  console.log(`  survivorship: CURRENT-MEMBERSHIP universe. Delisted names are absent. This panel cannot`);
  console.log(`  establish a multi-year edge on its own; it makes the horizon testable, not the answer valid.\n`);

  const bySym = {};
  let effectiveEnd = null, bars = 0;
  const CH = 100;
  for (let i = 0; i < syms.length; i += CH) {
    const chunk = syms.slice(i, i + CH);
    let r;
    try { r = await fetchBarsSip(chunk, { start: START, end: today, timeframe: "1Day", adjustment: "split", minBars: 0 }); }
    catch (e) { console.error(`\n  chunk ${i} failed: ${e.message}`); continue; }
    effectiveEnd = r.effectiveEnd;
    for (const [sym, raw] of Object.entries(r.bars || {})) {
      if (!raw || raw.length < 250) continue;                 // need at least a year to be useful
      const s = raw.slice().sort((a, b) => (String(a.t) < String(b.t) ? -1 : 1));
      bySym[sym] = {
        d: s.map((b) => String(b.t).slice(0, 10)),
        o: s.map((b) => +b.o), h: s.map((b) => +b.h),
        l: s.map((b) => +b.l), c: s.map((b) => +b.c),
        v: s.map((b) => Math.round(b.v || 0)),
      };
      bars += s.length;
    }
    process.stdout.write(`\r  ${Math.min(i + CH, syms.length)}/${syms.length} names · ${(bars / 1e6).toFixed(2)}M bars`);
  }

  const sessions = new Set();
  for (const v of Object.values(bySym)) for (const d of v.d) sessions.add(d);
  const allDates = [...sessions].sort();

  writeJsonAtomic(OUT, {
    spec: "daily-panel v1 — infrastructure, not a test",
    builtAt: new Date().toISOString(), start: START, effectiveEnd,
    symbols: Object.keys(bySym).length, sessions: allDates.length, bars,
    from: allDates[0], to: allDates[allDates.length - 1],
    SURVIVORSHIP: "CURRENT-MEMBERSHIP universe from universe-expanded.json. Delisted, acquired and bankrupt names are ABSENT. The bias grows with lookback and runs one way: it MANUFACTURES apparent alpha. This panel makes a multi-week horizon testable; it does NOT make a multi-year result valid. Pair it with a point-in-time universe (AlphaVantage LISTING_STATUS) before any edge claim.",
    format: "bySym[sym] = { d:[dates], o:[], h:[], l:[], c:[], v:[] } — parallel arrays, index-aligned",
    bySym,
  });

  console.log(`\n\n  ${Object.keys(bySym).length} names · ${allDates.length} sessions · ${(bars / 1e6).toFixed(2)}M bars · ${allDates[0]} -> ${allDates[allDates.length - 1]}`);
  console.log(`  independent observations by horizon:`);
  for (const h of [5, 20, 60, 126]) console.log(`    ${String(h).padStart(3)}d  ${String(Math.floor(allDates.length / h)).padStart(4)}`);
  console.log(`\nwritten: daily-panel.json`);
})().catch((e) => { console.error("backfill failed:", e.message); process.exit(1); });
