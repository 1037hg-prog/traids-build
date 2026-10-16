#!/usr/bin/env node
/**
 * UNIVERSE EXPANSION — Phase 2 testing, step 1. (2026-08-20, operator: "go")
 *
 * Expands the canonical equity universe from ~840 names to every US-listed equity that clears
 * a DECLARED liquidity floor — breadth of bets is the √N term in the operator's own thesis,
 * and it only counts if the added names are honestly tradeable.
 *
 * ═══ THE FLOOR, DECLARED BEFORE THE FIRST SCAN ═══
 *   - Alpaca active, tradable US equities on NYSE/NASDAQ/ARCA/BATS (no OTC)
 *   - price >= $3 (no sub-$3: spread fiction territory)
 *   - >= 20 completed daily bars in the last 30 sessions
 *   - median daily dollar volume >= $5M over those bars
 *   - common-stock-shaped symbols only (no units/warrants/rights suffixes)
 *
 * ═══ SURVIVORSHIP, STATED (the external review's point, adopted at birth) ═══
 * This universe is built from CURRENT listings, so any backtest run over it inherits
 * survivorship bias — names that died before today are absent. Forward tests are unaffected
 * (that is the point of forward tests). The build date is stamped in the output; historical
 * studies over this universe must state "current-membership universe, built 2026-08-20".
 *
 * SECTOR MAPPING: existing sector-map entries are preserved verbatim (comparability).
 * New names get sector ETFs from Finnhub profiles via universe-sector-backfill.js (rate-limited
 * background job); until mapped they carry "UNKNOWN" and are EXCLUDED from sector-relative
 * measurements — counted, never guessed.
 *
 * Output: data/universe-expanded.json (the roster + floor stats) and sector-map.json grows
 * (never shrinks — removals would break running tests' controls).
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { fetchBars } = require("./lib/alpaca-bars.js");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const D = (f) => path.join(__dirname, "data", f);
const HDRS = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, Accept: "application/json" };

// VOLUME PROXY CAVEAT: bars come from the IEX feed (~2-3% of consolidated tape), so the
// dollar-volume floor is stated in IEX-OBSERVED terms. 150k IEX-median ~ $5M consolidated.
// First run used 5e6 against IEX volume — an accidental ~$150M consolidated floor that
// passed only 1,215 names; corrected same hour, both runs stamped in the output.
const FLOOR = { minPrice: 3, minBars: 20, minMedDollarVol: 150e3, floorBasis: "IEX-observed (~3% of consolidated); 150k IEX ~ 5M consolidated" };
const EXCH = new Set(["NYSE", "NASDAQ", "ARCA", "BATS", "AMEX", "NYSEARCA"]);

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

(async () => {
  const t0 = Date.now();
  console.log("1/4 fetching active US equity assets from Alpaca…");
  const assets = await fetch("https://paper-api.alpaca.markets/v2/assets?status=active&asset_class=us_equity", { headers: HDRS, signal: AbortSignal.timeout(60000) }).then((r) => r.json());
  const candidates = assets
    .filter((a) => a.tradable && EXCH.has(a.exchange) && /^[A-Z]{1,5}$/.test(a.symbol))
    .map((a) => ({ sym: a.symbol, exchange: a.exchange }));
  console.log(`   ${assets.length} assets → ${candidates.length} exchange-listed common-shaped candidates`);

  // ── BAR FETCH, via lib/alpaca-bars.js (migrated 2026-08-27, morning integrity wave) ────────
  // This step used to hand-roll its own paginated fetch with `if (!r.ok) break` mid-pagination:
  // a 429 or 5xx on page 2 of a 200-name chunk silently dropped the remaining bars for every
  // symbol in that chunk, with no retry, no Retry-After handling and no rate limiter at all.
  // That under-counts s.n and s.dv, which can push a genuinely liquid name below minBars or
  // minMedDollarVol and drop it from the roster — recorded as an ordinary `dropped.bars` /
  // `dropped.vol`, indistinguishable from a name that is really illiquid. It is the same defect
  // class as the 2026-07-31 incident that lib/alpaca-bars.js was written to make impossible.
  // fetchBars retries 429/5xx with backoff, rate-limits, and reports `missing`/`short`
  // explicitly instead of losing rows quietly. requireAll:false because thousands of listed
  // candidates legitimately have no IEX bars — that is data, not failure, and it is counted.
  console.log("2/4 pulling 30 sessions of bars via lib/alpaca-bars.js (retried, rate-limited)…");
  const start = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
  const end = new Date().toISOString().slice(0, 10);
  const syms = candidates.map((c) => c.sym);
  const fetched = await fetchBars(syms, {
    start, end, timeframe: "1Day", feed: "iex",
    adjustment: "raw",        // roster liquidity screen — price series, NOT total return
    chunkSize: 200, limit: 10000, minBars: FLOOR.minBars, requireAll: false,
  });
  console.log(`   fetched ${fetched.returned.length}/${fetched.requested.length} symbols · ${fetched.pages} pages · ${fetched.requests} requests · ${fetched.missing.length} returned no bars · ${fetched.short.length} short of ${FLOOR.minBars} bars`);
  const stats = {};
  for (const [sym, bars] of Object.entries(fetched.bars)) {
    const s = (stats[sym] = { n: 0, dv: [], last: 0 });
    for (const b of bars) { s.n++; s.dv.push(b.c * b.v); s.last = b.c; }
  }

  console.log("3/4 applying the declared floor…");
  const passed = [], dropped = { price: 0, bars: 0, vol: 0, noData: 0 };
  for (const c of candidates) {
    const s = stats[c.sym];
    if (!s) { dropped.noData++; continue; }
    if (s.last < FLOOR.minPrice) { dropped.price++; continue; }
    if (s.n < FLOOR.minBars) { dropped.bars++; continue; }
    const mdv = median(s.dv);
    if (mdv < FLOOR.minMedDollarVol) { dropped.vol++; continue; }
    passed.push({ sym: c.sym, exchange: c.exchange, medDollarVol: Math.round(mdv), lastPx: s.last });
  }
  passed.sort((a, b) => b.medDollarVol - a.medDollarVol);
  console.log(`   ${passed.length} names clear the floor (dropped: ${JSON.stringify(dropped)})`);

  console.log("4/4 merging into sector-map (existing entries preserved; new names UNKNOWN until backfilled)…");
  const secMap = JSON.parse(fs.readFileSync(D("sector-map.json"), "utf8"));
  const before = Object.keys(secMap).length;
  let added = 0;
  // canonical shape {ind, etf} — consumers read v?.etf, so a bare string is invisible to them
  for (const p of passed) if (!(p.sym in secMap)) { secMap[p.sym] = { ind: null, etf: null }; added++; }
  writeJsonAtomic(D("sector-map.json"), secMap);
  writeJsonAtomic(D("universe-expanded.json"), {
    builtAt: new Date().toISOString(), floor: FLOOR,
    survivorshipNote: "current-membership universe — historical studies over it inherit survivorship bias and must say so; forward tests unaffected",
    count: passed.length, addedToSectorMap: added, priorSectorMap: before,
    names: passed,
  });
  console.log(`   sector-map: ${before} → ${Object.keys(secMap).length} (${added} new, pending sector backfill)`);
  console.log(`DONE in ${((Date.now() - t0) / 1000).toFixed(0)}s · universe-expanded.json written · run universe-sector-backfill.js for sectors`);
})();
