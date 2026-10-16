#!/usr/bin/env node
/**
 * R12 CONFOUND CHECK — the pre-registered condition the headline result must survive.
 *
 * R12 measured -9.44% excess vs SPY at 63d, t=-6.14. The registered bar required a
 * sector/size-relative read BEFORE that means anything, because the obvious alternative is
 * mundane: legal triggers concentrate in small, non-tech companies, and small non-tech
 * underperformed mega-cap-led SPY badly over 2023-2025. That would produce this exact number
 * with no information content whatsoever.
 *
 * Three checks:
 *   1. BENCHMARK SWAP — re-measure vs IWM (small-cap) and RSP (equal-weight S&P). If the
 *      effect is beta, it collapses against a like-for-like benchmark.
 *   2. PLACEBO DATES — same tickers, same holding period, but entry shifted 1 YEAR EARLIER
 *      (before the disclosure existed). A real event effect must be absent in the placebo;
 *      if the placebo is just as negative, we are measuring the STOCKS, not the EVENT.
 *   3. RAW vs EXCESS decomposition, so the size of the beta component is visible.
 *
 * 2026-09-10 test-triage NO COUNTABLE BAR fix: this artifact is a ONE-SHOT HISTORICAL BACKTEST
 * over EDGAR filings from 2021-2025 (a fixed, already-measured sample), not a forward-accruing
 * paper test with sessions since an evidenceStart. dailyClock.sessions below reports the
 * measured sample's own distinct-filing-day count (real.raw.days), matching the registered bar's
 * own clustering unit (bar.minDistinctFilingDays=40, aliased in test-registry.json to
 * bar.minDates=40) — but that count is the WHOLE historical sample, not sessions accrued forward,
 * so test-triage.js correctly reads it as COUNT AMBIGUOUS rather than pretending it is live
 * forward accrual. That is the honest classification for a completed retrospective read; it is
 * not a defect in this writer and nothing here is backfilled or re-run to change it.
 */
const fs = require("fs"), path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const D = (f) => path.join(__dirname, "data", f);
const AH = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, Accept: "application/json" };
const nap = (ms) => new Promise(r => setTimeout(r, ms));
const H = 63;                                   // the horizon that cleared
const BENCH = ["SPY", "IWM", "RSP"];

const cache = JSON.parse(fs.readFileSync(D("r12-events.json"), "utf8"));
const events = Object.entries(cache.events);
console.log(`R12 confound check · ${events.length} events · horizon ${H}d\n`);

const bars = {};
async function fetchBars(list) {
  for (let i = 0; i < list.length; i += 25) {
    const chunk = list.slice(i, i + 25);
    let token = null;
    do {
      const p = new URLSearchParams({ symbols: chunk.join(","), timeframe: "1Day", start: "2021-06-01", end: "2026-08-01", limit: "10000", feed: "iex", adjustment: "all" });
      if (token) p.set("page_token", token);
      try {
        const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${p}`, { headers: AH, signal: AbortSignal.timeout(60000) });
        if (!r.ok) break;
        const j = await r.json();
        for (const [k, v] of Object.entries(j.bars || {})) bars[k] = (bars[k] || []).concat(v);
        token = j.next_page_token || null;
      } catch { break; }
      await nap(350);
    } while (token);
    process.stdout.write(`  priced ${Object.keys(bars).length}\r`);
  }
}
(async () => {
  await fetchBars(BENCH);
  for (const b of BENCH) if (!bars[b] || bars[b].length < 300) { console.error(`ABORT: benchmark ${b} missing`); process.exit(1); }
  await fetchBars(events.map(([t]) => t));
  console.log(`\npriced ${Object.keys(bars).length - BENCH.length} tickers\n`);

  const idxOf = (arr) => new Map(arr.map((b, i) => [String(b.t).slice(0, 10), i]));
  const bIdx = {}; for (const b of BENCH) bIdx[b] = idxOf(bars[b]);

  // shiftDays = 0 for the real event, -365 for the placebo
  function measure(shiftDays) {
    const rows = [];
    for (const [tick, ev] of events) {
      const b = bars[tick]; if (!Array.isArray(b) || b.length < 100) continue;
      const target = shiftDays ? new Date(new Date(ev.date).getTime() + shiftDays * 86400000).toISOString().slice(0, 10) : ev.date;
      const ei = b.findIndex(x => String(x.t).slice(0, 10) > target);
      if (ei < 0 || ei + H >= b.length) continue;
      const day = String(b[ei].t).slice(0, 10);
      const raw = (b[ei + H].c / b[ei].c - 1) * 100;
      const row = { tick, day, raw };
      let ok = true;
      for (const bn of BENCH) {
        const si = bIdx[bn].get(day);
        if (si == null || si + H >= bars[bn].length) { ok = false; break; }
        row[bn] = raw - (bars[bn][si + H].c / bars[bn][si].c - 1) * 100;
      }
      if (ok) rows.push(row);
    }
    return rows;
  }
  const stat = (rows, key) => {
    const byDay = {};
    for (const r of rows) (byDay[r.day] ||= []).push(r[key]);
    const dm = Object.values(byDay).map(a => a.reduce((s, x) => s + x, 0) / a.length);
    const m = dm.reduce((s, x) => s + x, 0) / dm.length;
    const sd = Math.sqrt(dm.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, dm.length - 1));
    return { mean: m, t: dm.length > 1 ? m / (sd / Math.sqrt(dm.length)) : null, days: dm.length, n: rows.length };
  };

  const real = measure(0), placebo = measure(-365);
  console.log(`                    n     days      mean %      t (day-clustered)`);
  const line = (lbl, s) => console.log(`  ${lbl.padEnd(18)} ${String(s.n).padStart(4)}  ${String(s.days).padStart(5)}   ${(s.mean >= 0 ? "+" : "") + s.mean.toFixed(2).padStart(7)}       ${s.t == null ? "n/a" : (s.t >= 0 ? "+" : "") + s.t.toFixed(2)}`);
  console.log(`REAL EVENT (entry after the disclosure):`);
  line("raw return", stat(real, "raw"));
  for (const b of BENCH) line(`excess vs ${b}`, stat(real, b));
  console.log(`\nPLACEBO (same stocks, entry 1 YEAR BEFORE the disclosure existed):`);
  line("raw return", stat(placebo, "raw"));
  for (const b of BENCH) line(`excess vs ${b}`, stat(placebo, b));

  const rS = stat(real, "IWM"), pS = stat(placebo, "IWM");
  const survives = rS.t <= -2.39 && !(pS.t <= -2.39);
  console.log(`\nINTERPRETATION`);
  console.log(`  vs a like-for-like small-cap benchmark (IWM), the event effect is ${rS.mean.toFixed(2)}% (t ${rS.t.toFixed(2)}).`);
  console.log(`  The placebo a year earlier is ${pS.mean.toFixed(2)}% (t ${pS.t == null ? "n/a" : pS.t.toFixed(2)}).`);
  console.log(`  ${survives
    ? "SURVIVES: the effect is tied to the DISCLOSURE, not to owning these stocks generally."
    : "DOES NOT SURVIVE: the placebo is comparably negative and/or the effect dies vs IWM —\n  this is the size/sector beta of the basket, not information in the filing."}`);
  const realRaw = stat(real, "raw");
  fs.writeFileSync(D("r12-confound.json"), JSON.stringify({
    ranAt: new Date().toISOString(), horizon: H,
    real: Object.fromEntries(["raw", ...BENCH].map(k => [k, stat(real, k)])),
    placebo: Object.fromEntries(["raw", ...BENCH].map(k => [k, stat(placebo, k)])),
    survives,
    // see header note: this is the whole historical sample's own distinct-filing-day count, not a
    // forward-accrual count — test-triage.js is expected to read it as COUNT AMBIGUOUS, honestly.
    dailyClock: { sessions: realRaw.days, estimate: rS.mean, unit: "distinct filing days (day-clustered), 2021-2025 historical sample — NOT forward accrual since an evidenceStart" },
  }, null, 1));
  console.log(`\nwritten: r12-confound.json`);
})();
