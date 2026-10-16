/**
 * Price data for the verification library (2026-09-22). Builds the per-instrument minute-bar lookups that lib/verify.js checks against,
 * using the loaders the project already runs:
 *   futures — lib/futures-bars.loadBars (2026-10-02 Massive exit: local store = Massive archive + nightly Schwab appender for NQ ES RTY YM;
 *             any other root reads ~6 weeks of Schwab 1m, and coverage says so)
 *   stocks  — lib/equity-bars-1m.loadBars (Alpaca SIP 1-minute, raw, cached per symbol per month under data/equity-1m)
 * Trades older than the coverage come back NO-BAR in the check; they are never counted as clean. Limits keep one request from pulling
 * the whole market: at most MAX_STOCKS distinct stocks and MAX_FUT_DAYS of futures history per job.
 */
const V = require("./verify");
const MAX_STOCKS = 60, MAX_FUT_DAYS = 400;

async function lookupsFor(trades, { log = () => {} } = {}) {
  const lookups = {}, coverage = {}, notes = [];
  const fut = [...new Set(trades.filter((t) => t.assetClass === "future").map((t) => t.dataRoot))];
  if (fut.length) {
    const FB = require("./futures-bars.js");
    const earliest = Math.min(...trades.filter((t) => t.assetClass === "future").map((t) => t.openMs));
    const days = Math.min(MAX_FUT_DAYS, Math.ceil((Date.now() - earliest) / 864e5) + 3);
    if ((Date.now() - earliest) / 864e5 > MAX_FUT_DAYS) notes.push(`futures price coverage reaches back ${MAX_FUT_DAYS} days; older futures trades are reported NO-BAR`);
    for (const root of fut) {
      log(`loading ${root} 1-minute bars (${days} days)`);
      const inStore = FB.storeRoots().includes(root);
      const bars = await FB.loadBars({ root, resolution: "1minute", lookbackDays: days, pages: 14, quiet: true, schwabFallback: true });
      lookups[root] = V.makeLookup(bars.map((b) => [Math.round(b.ns / 1e6), b.o, b.h, b.l, b.c]));
      coverage[root] = bars.length ? { from: bars[0].date, to: bars[bars.length - 1].date, bars: bars.length, source: inStore ? "local futures store (Massive archive to 2026-10-02, Schwab pricehistory after), front month" : "Schwab pricehistory 1m continuous (~6 weeks retention)" } : { bars: 0 };
    }
  }
  const stocks = [...new Set(trades.filter((t) => t.assetClass === "stock").map((t) => t.dataRoot))];
  if (stocks.length) {
    const eq = require("./equity-bars-1m");
    if (stocks.length > MAX_STOCKS) notes.push(`${stocks.length} distinct stocks; only the ${MAX_STOCKS} with the most trades are checked, the rest are reported NO-BAR`);
    const counts = {}; for (const t of trades) if (t.assetClass === "stock") counts[t.dataRoot] = (counts[t.dataRoot] || 0) + 1;
    const pickList = stocks.sort((a, b) => counts[b] - counts[a]).slice(0, MAX_STOCKS);
    const day = (ms) => new Date(ms - 5 * 3600e3).toISOString().slice(0, 10);
    for (const sym of pickList) {
      const ts = trades.filter((t) => t.dataRoot === sym), from = day(Math.min(...ts.map((t) => t.openMs)) - 864e5), to = day(Math.max(...ts.map((t) => t.closeMs)) + 864e5);
      log(`loading ${sym} 1-minute bars ${from}..${to}`);
      try { const bars = await eq.loadBars({ symbol: sym, from, to, quiet: true }); lookups[sym] = V.makeLookup(bars.map((b) => [Math.round(b.ns / 1e6), b.o, b.h, b.l, b.c])); coverage[sym] = { from, to, bars: bars.length, source: "Alpaca SIP 1-minute, raw" }; }
      catch (e) { notes.push(`${sym}: price data unavailable (${String(e.message).slice(0, 80)}) — its trades are NO-BAR`); }
    }
  }
  return { lookupFor: (t) => lookups[t.dataRoot] || null, coverage, notes };
}

async function verifyText(text, opts = {}) {
  const parsed = V.parseTrackRecord(text);
  const { lookupFor, coverage, notes } = await lookupsFor(parsed.trades, opts);
  const out = V.verifyRecord(text, lookupFor, opts);
  return { ...out, priceCoverage: coverage, notes: [...(out.notes || []), ...notes] };
}

module.exports = { lookupsFor, verifyText, MAX_STOCKS, MAX_FUT_DAYS };
