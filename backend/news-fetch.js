#!/usr/bin/env node
/**
 * NEWS FETCH — per-symbol and per-sector news for every name the board holds. Finnhub.
 *
 * WHY IT LOOKS LIKE THIS. Three things were learned the hard way on 2026-08-26, and each one
 * deleted code rather than adding it:
 *
 * 1. THE TOPIC FEED WAS NOT LOOKING. `market-news-cycle.json` pulls by topic, so it covered 30 of
 *    170 held symbols and stamping from it recorded 83.5% of the book as "no news". The operator
 *    challenged that — if there is no news, there is no news — and the challenge was right: it was
 *    a query problem, not a quiet market.
 *
 * 2. ALPHAVANTAGE'S TICKER LIST IS AN AND, NOT AN OR.
 *        tickers=AXP,KO,MU,TSM,PYPL  ->  items: 0
 *        tickers=AXP                 ->  items: 50
 *    A comma list requires an article naming EVERY ticker. Batching to save calls silently
 *    manufactures silence for the whole book, and returns HTTP 200 with no error field.
 *
 * 3. WE ALREADY HAD FINNHUB. FINNHUB_API_KEY has been in backend/.env all along, used by ten other
 *    files. Finnhub's free tier is 60 calls per MINUTE against AlphaVantage's 25 per DAY — roughly
 *    3,400x — so the entire budget-rationing design (spend calls by descending position risk, mark
 *    the rest queried:false) was solving a problem we did not have. It is gone.
 *
 * ABSENCE IS STILL RECORDED AS A RESULT, NOT A GAP. A symbol QUERIED that returns nothing gets
 * `queried:true, n:0` — genuinely no news, and that is evidence. A symbol whose call FAILED gets
 * `queried:false`, which downstream must never read as quiet. Those two states are identical
 * downstream unless recorded differently, which is exactly how a starved observer hides.
 *
 * VINTAGE. Finnhub returns a unix `datetime` per article, so every article's publication time is
 * exact. `newestAt`/`oldestAt` are recorded per symbol so a later stamp can assert that an article
 * predates the entry it is being attached to — the discipline that R12 lost a verdict for missing.
 *
 * SENTIMENT is computed HERE with backend/news-sentiment.js, not taken from a vendor. The
 * market-news-cycle caveat states the reason: "AlphaVantage sentiment scores are vendor-computed.
 * They are an input to be measured, not a ground truth." Ours is auditable and versioned.
 *
 * SECTOR NEWS, on the operator's instruction, comes from each sector's ETF — sector-map.json
 * already carries {ind, etf} per symbol, so XLK news IS technology-sector news. One call per
 * sector, shared by its members, and no hand-rolled topic mapping to drop labels on the floor.
 *
 * Output: data/news-fetch.json  (consumed by backend/news-stamp.js)
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { scoreHeadline } = require("./news-sentiment.js");
const D = (f) => path.join(__dirname, "data", f);

const KEY = (() => {
  try { const m = fs.readFileSync(path.join(__dirname, ".env"), "utf8").match(/^FINNHUB_API_KEY=(.+)$/m); return m ? m[1].trim() : null; } catch { return null; }
})();
if (!KEY) { console.error("Missing FINNHUB_API_KEY in backend/.env"); process.exit(1); }

const LOOKBACK_D = Number(process.env.NEWS_LOOKBACK_DAYS || 7);
const THROTTLE_MS = Number(process.env.NEWS_THROTTLE_MS || 1100);   // 60/min free tier -> ~1/sec
const ymd = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const FROM = ymd(LOOKBACK_D), TO = ymd(0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let calls = 0, throttled = 0;
async function news(sym) {
  calls++;
  try {
    const r = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(sym)}&from=${FROM}&to=${TO}&token=${KEY}`);
    if (r.status === 429) { throttled++; return { rateLimited: true }; }
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    return Array.isArray(j) ? { feed: j } : { error: "unexpected body" };
  } catch (e) { return { error: e.message }; }
}

/** Reduce a Finnhub feed to the fields a ticket needs. Sentiment is OURS, from the lexicon. */
function summarise(feed) {
  if (!feed.length) return { n: 0, avg: null, pos: 0, neg: 0, newestAt: null, oldestAt: null };
  const scores = feed.map((a) => scoreHeadline(`${a.headline || ""} ${a.summary || ""}`)).map((s) => (typeof s === "number" ? s : (s && s.score) || 0));
  const times = feed.map((a) => a.datetime).filter(Number.isFinite).sort((a, b) => a - b);
  const m = scores.reduce((s, x) => s + x, 0) / scores.length;
  return { n: feed.length, avg: +m.toFixed(4),
    pos: scores.filter((x) => x > 0.15).length, neg: scores.filter((x) => x < -0.15).length,
    newestAt: times.length ? new Date(times[times.length - 1] * 1000).toISOString() : null,
    oldestAt: times.length ? new Date(times[0] * 1000).toISOString() : null,
    sources: [...new Set(feed.map((a) => a.source).filter(Boolean))].length };
}

(async () => {
  const raw = (() => { try { return JSON.parse(fs.readFileSync(D("board_positions.json"), "utf8")); } catch { return []; } })();
  const rows = Array.isArray(raw) ? raw : (raw.positions || raw.rows || []);
  const open = rows.filter((t) => t && t.sym && !t.closedAt);

  /**
   * INCREMENTAL MODE — for intraday runs. The stamp is append-only per ticket, so re-fetching a
   * symbol whose tickets are already stamped changes nothing and costs 1.1s. Intraday, fetch only
   * symbols carrying an UNSTAMPED open ticket; a full sweep still runs at the close.
   *
   * The point of running often is not fresher news on old tickets — it is a SHORTER LAG between a
   * ticket opening and its observation being taken. The first full run stamped at 186 minutes of
   * lag; a ticket opened at 09:40 and stamped at 12:45 has a news observation that partly postdates
   * its own entry, which is the look-ahead this file exists to avoid.
   *
   * Sector ETFs are always refreshed — 11 calls, and they are shared by every member.
   */
  const INCREMENTAL = process.env.NEWS_INCREMENTAL === "1";
  const prior = (() => { try { return JSON.parse(fs.readFileSync(D("news-fetch.json"), "utf8")); } catch { return null; } })();
  const CURRENT_SOURCE = "news-fetch-finnhub-v1";
  const needsStamp = new Set(open.filter((t) => !(t.obs && t.obs.newsSource === CURRENT_SOURCE)).map((t) => t.sym));
  const allSyms = [...new Set(open.map((t) => t.sym))];
  const syms = INCREMENTAL ? [...needsStamp] : allSyms;
  if (INCREMENTAL) console.log(`  INCREMENTAL: ${syms.length} of ${allSyms.length} symbols carry an unstamped ticket\n`);

  const smap = (() => { try { return JSON.parse(fs.readFileSync(D("sector-map.json"), "utf8")); } catch { return {}; } })();
  const etfOf = {}, indOf = {};
  // map over ALL held symbols, not just the ones being fetched — sector ETFs are refreshed every
  // run and must cover the whole book, or an incremental run would narrow the sector universe too
  for (const s of allSyms) { const v = smap[s]; if (v) { if (v.etf) etfOf[s] = v.etf; if (v.ind) indOf[s] = v.ind; } }
  const etfs = [...new Set(Object.values(etfOf))];

  console.log(`NEWS FETCH (finnhub) — ${syms.length} symbols · ${etfs.length} sector ETFs · lookback ${LOOKBACK_D}d\n`);

  // ── sector ETFs first: one call each, shared by every member of that sector ──────────────────
  const sectors = {};
  for (const etf of etfs) {
    const j = await news(etf);
    sectors[etf] = j.feed ? { queried: true, ...summarise(j.feed) }
      : { queried: false, reason: j.rateLimited ? "rate limited" : j.error };
    const s = sectors[etf];
    console.log(`  sector ${etf.padEnd(6)} ${s.queried ? `n=${String(s.n).padStart(3)}  avg ${s.avg >= 0 ? "+" : ""}${s.avg}` : "NOT QUERIED — " + s.reason}`);
    await sleep(THROTTLE_MS);
  }

  // ── every symbol. One call each — no batching, no rationing. ─────────────────────────────────
  const symbols_ = {};
  for (const sym of syms) {
    const j = await news(sym);
    symbols_[sym] = j.feed ? { queried: true, etf: etfOf[sym] || null, ind: indOf[sym] || null, ...summarise(j.feed) }
      : { queried: false, etf: etfOf[sym] || null, reason: j.rateLimited ? "rate limited" : j.error };
    await sleep(THROTTLE_MS);
  }

  // INCREMENTAL MERGE. A partial run must not shrink the file — a symbol absent from symbols_
  // reads downstream as "never queried", which is the one state that must never be manufactured.
  // Prior entries are carried forward and marked so their age is visible rather than assumed fresh.
  if (INCREMENTAL && prior && prior.symbols_) {
    for (const [sym, v] of Object.entries(prior.symbols_)) {
      if (symbols_[sym]) continue;
      symbols_[sym] = { ...v, carriedForward: true, carriedFrom: prior.asOf };
    }
  }

  const q = Object.values(symbols_).filter((v) => v.queried);
  const withNews = q.filter((v) => v.n > 0);
  const out = {
    spec: "news-fetch-finnhub-v1", asOf: new Date().toISOString(), source: "finnhub company-news",
    lookbackDays: LOOKBACK_D, from: FROM, to: TO, apiCalls: calls, rateLimitHits: throttled,
    // Counters describe the WHOLE BOOK, not the incremental subset — an incremental run that
    // reported "0 symbols" would read as a dead feed. `fetchedThisRun` is the subset.
    incremental: INCREMENTAL, symbols: allSyms.length, fetchedThisRun: syms.length,
    carriedForward: Object.values(symbols_).filter((v) => v.carriedForward).length,
    symbolsQueried: q.length, symbolsWithNews: withNews.length,
    symbolsGenuinelyQuiet: q.length - withNews.length,
    symbolsNotQueried: Math.max(0, allSyms.length - q.length),
    sectorEtfs: etfs.length,
    sentimentSource: "backend/news-sentiment.js lexicon — computed here, NOT vendor-supplied, so it is auditable",
    note: "queried:true with n:0 is GENUINELY no news and is evidence. queried:false means the call FAILED and must never be read as quiet.",
    sectors, symbols_,
  };
  writeJsonAtomic(D("news-fetch.json"), out);

  console.log(`\n  book ${allSyms.length} symbols · fetched this run ${syms.length}${out.carriedForward ? ` · carried forward ${out.carriedForward}` : ""}`);
  console.log(`  queried ${q.length}/${allSyms.length} · with news ${withNews.length} · genuinely quiet ${out.symbolsGenuinelyQuiet} · never queried ${out.symbolsNotQueried}`);
  console.log(`  API calls ${calls}${throttled ? `  (${throttled} rate-limited)` : ""}`);
  console.log("written: data/news-fetch.json");
})();
