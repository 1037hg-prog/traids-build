#!/usr/bin/env node
/**
 * ATS CACHE WARMER (2026-08-25, ml-improve-daily)
 *
 * WHY. obs.atsPct is stamped from /api/ats-weekly, which fetches FINRA one symbol at a time under a
 * 15-per-request cold-fetch budget (traids-server-v2.js — the budget exists because a cold serial
 * scan made the board look hung, and it stays). With the cache now disk-backed on a 7-day TTL that
 * budget ACCUMULATES, but it accumulates slowly: ~15 new names per scan against a traded universe of
 * 331 equity symbols is days of drip before coverage is usable.
 *
 * This warms the same cache file OUT OF BAND, after the close, so the observer starts a session with
 * the universe already resolved instead of learning it 15 names at a time during market hours.
 *
 * It writes ONLY data/ats-cache.json — the same shape and the same TTL the server reads. It does not
 * touch the ledger, and it does not stamp anything: a warm cache changes how many tickets can CARRY
 * the observer tomorrow, never what any settled row already recorded. Historical coverage is fixed;
 * there is no backfill here and there should not be one, because the FINRA week that was published
 * on a past signal date is not the week published now. Stamping today's week onto a July ticket
 * would be look-ahead, and it would be invisible once written.
 *
 * Symbols come from the clean-era ledger's equity names (what the board actually trades), not from
 * universe-expanded.json's 4,048 — warming the full membership list would spend an hour of requests
 * on names no ticket has ever referenced. That list is also current-membership, so it carries
 * survivorship bias; it is the wrong source for anything historical regardless.
 *
 * usage: node backend/ats-cache-warm.js [--limit N] [--force]
 */
const fs = require("fs"), path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });   // explicit path (2026-08-28):
// this runs standalone, cwd is not guaranteed to be backend/ (see coverage-monitor.js note) and the
// SIP volume fetch below needs ALPACA_KEY_ID/SECRET to be actually present, not silently undefined.
const { cleanEraLedger } = require("./lib/reconcile.js");
// 2026-10-05 (health sweep BK7): every save goes through lib/cache-save.js — atomic temp+rename, retried with
// backoff on EBUSY/EPERM/EACCES/UNKNOWN, merged per symbol (newer `at` wins) with what is on disk at that
// moment. The bare writeFileSync it replaces died on 2026-10-02 with UNKNOWN (-4094) at the first checkpoint
// on this file, which the :3001 server also rewrites whole. The SERVER's own bare write is unchanged until a
// :3001 restart picks up a matching fix; until then it can still overwrite this run's entries with its
// in-memory Map (the pre-existing NOTE printed at the end of every run).
const { saveMergedJson } = require("./lib/cache-save.js");

const CACHE = path.join(__dirname, "data", "ats-cache.json");
const TTL = 7 * 86400000;                       // matches ATS_TTL in traids-server-v2.js
const argv = process.argv.slice(2);
const LIMIT = (() => { const i = argv.indexOf("--limit"); return i >= 0 ? parseInt(argv[i + 1]) : Infinity; })();
const FORCE = argv.includes("--force");

const read = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, "utf8")) ?? fb; } catch { return fb; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const etDay = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const isRealKey = (v) => typeof v === "string" && v.trim() !== "" && !/^your_|_here$/i.test(v.trim());

/**
 * TRUE (SIP/consolidated) weekly volume for the exact FINRA-published week — added 2026-08-28.
 * Mirrors traids-server-v2.js /api/ats-weekly exactly, because the same corruption applies here:
 * this file previously cached only { week, shares } and left the volume division to whatever bars
 * the live scan happened to have on hand, which is the free IEX feed (a few percent of the true
 * tape) whenever the Alpaca branch is hot. Dividing FINRA's full-market shares by IEX-only volume
 * does not shrink coverage, it CORRUPTS the ratio (measured: every finite obs.atsPct in the ledger
 * read 187%-750% of "volume"). Computing atsPct HERE, once, from the SIP feed, means the warm cache
 * and the live endpoint can never disagree about what the value means.
 */
async function sipWeeklyVolume(sym, weekStart) {
  if (!isRealKey(process.env.ALPACA_KEY_ID) || !isRealKey(process.env.ALPACA_SECRET_KEY)) return null;
  // SIP has no same-day access on this account tier (confirmed live: 403 "subscription does not
  // permit querying recent SIP data" for end=today, 200 for end=yesterday or earlier). Clamped
  // defensively even though FINRA's own 2-3 week publication lag already keeps every real week
  // well clear of this boundary.
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  let weekEnd = new Date(new Date(weekStart + "T12:00:00Z").getTime() + 7 * 86400000).toISOString().slice(0, 10);
  if (weekEnd > yesterday) weekEnd = yesterday;
  if (weekEnd <= weekStart) return null;
  try {
    const p = new URLSearchParams({ symbols: sym, timeframe: "1Day", start: weekStart, end: weekEnd, limit: "10", adjustment: "raw", feed: "sip" });
    const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${p.toString()}`, {
      headers: { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const vol = (j.bars?.[sym] || []).reduce((a, b) => a + (b.v || 0), 0);
    return vol > 0 ? vol : null;
  } catch { return null; }
}

(async () => {
  const L = cleanEraLedger();
  const syms = [...new Set([...L.signals, ...L.controls].filter((t) => t.cls === "Equity" && t.sym).map((t) => t.sym))].sort();
  const cache = read(CACHE, {});
  const now = Date.now();
  const start = new Date(now - 70 * 86400000).toISOString().slice(0, 10);
  const end = new Date(now).toISOString().slice(0, 10);
  const todo = syms.filter((s) => FORCE || !(cache[s] && Number.isFinite(cache[s].at) && now - cache[s].at < TTL)).slice(0, LIMIT);
  console.log(`ATS warm — ${syms.length} traded equity symbols · ${syms.length - todo.length} already fresh · fetching ${todo.length}`);

  let ok = 0, none = 0, fail = 0, n = 0;
  for (const sym of todo) {
    n++;
    try {
      const r = await fetch("https://api.finra.org/data/group/otcMarket/name/weeklySummary", {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ limit: 20, compareFilters: [
          { compareType: "EQUAL", fieldName: "issueSymbolIdentifier", fieldValue: sym },
          { compareType: "EQUAL", fieldName: "summaryTypeCode", fieldValue: "ATS_W_SMBL" },
        ], dateRangeFilters: [{ fieldName: "weekStartDate", startDate: start, endDate: end }] }),
      });
      // A non-OK response is TRANSIENT and is deliberately left UNCACHED so the next run retries it.
      // Caching a failure as "no data" would look identical to a name FINRA genuinely does not
      // publish, and the observer would go quietly blind on that name for a week.
      if (!r.ok) { fail++; await sleep(150); continue; }
      const rows = await r.json();
      let best = null;
      for (const row of (Array.isArray(rows) ? rows : [])) {
        const week = row.weekStartDate, shares = parseFloat(row.totalWeeklyShareQuantity);
        if (week && Number.isFinite(shares) && (!best || week > best.week)) best = { week, shares };
      }
      let weekVol = null, atsPct = null;
      if (best) {
        weekVol = await sipWeeklyVolume(sym, best.week);
        if (weekVol > 0) {
          const pct = +(best.shares / weekVol * 100).toFixed(2);
          if (pct > 0 && pct < 150) atsPct = pct;   // impossible-value guard, same convention as integrity-audit.js
        }
        await sleep(150);   // second Alpaca call — pace it too
      }
      // A resolved-but-empty name IS cached with week null — that is real information: FINRA does
      // not publish ATS volume for it. Re-asking every scan is what burned the live budget.
      cache[sym] = { at: Date.now(), day: etDay(), week: best ? best.week : null, shares: best ? best.shares : null, weekVol, atsPct };
      if (best) ok++; else none++;
    } catch { fail++; }
    if (n % 25 === 0) {
      // a checkpoint is progress insurance, not the result: if it still cannot be written after the
      // retries, say so and keep going — the names stay in memory for the next checkpoint / final save
      try { Object.assign(cache, await saveMergedJson(CACHE, cache, { label: `checkpoint ${n}` })); }
      catch (e) { console.log(`  WARN ${e.message} — continuing; the final save retries`); }
      console.log(`  ${n}/${todo.length} · resolved ${ok} · no-ats ${none} · transient ${fail}`);
    }
    await sleep(150);
  }
  try { Object.assign(cache, await saveMergedJson(CACHE, cache, { label: "final save" })); }
  catch (e) {   // FAIL LOUD: a run whose result never reached disk is a failed step, not a quiet one
    console.error(`ATS warm FAILED — ${e.message}. The ${n} name(s) fetched this run are NOT persisted.`);
    process.exitCode = 1;
    return;
  }

  const entries = Object.values(cache).filter((c) => c && Number.isFinite(c.at));
  const fresh = entries.filter((c) => Date.now() - c.at < TTL);
  const withWeek = fresh.filter((c) => c.week);
  const weeks = [...new Set(withWeek.map((c) => c.week))].sort();
  const withAts = withWeek.filter((c) => Number.isFinite(c.atsPct));
  console.log(`ATS warm done — cache holds ${Object.keys(cache).length} symbols, ${fresh.length} fresh, ${withWeek.length} with a published week, ${withAts.length} with a SANE atsPct (SIP-fed, 0-150%)`);
  console.log(`  resolved ${ok} · no ATS data ${none} · transient failures ${fail} (left uncached, retried next run)`);
  if (withAts.length) {
    const v = withAts.map((c) => c.atsPct).sort((a, b) => a - b);
    console.log(`  atsPct sanity: min ${v[0]}% · median ${v[Math.floor(v.length / 2)]}% · max ${v[v.length - 1]}% — all must sit under 150% or the impossible-value guard would have dropped them`);
  }
  console.log(`  FINRA weeks present: ${weeks.slice(-4).join(", ") || "none"} — publication lag is inherent and disclosed; the observer records the latest week that EXISTS`);
  console.log(`  ceiling for tomorrow's equity tickets: ${(100 * withWeek.length / Math.max(1, syms.length)).toFixed(1)}% of the ${syms.length} traded names`);
  console.log(`  NOTE: takes effect on the next traids-server-v2 restart — the running process holds the pre-patch in-memory Map.`);
})();
