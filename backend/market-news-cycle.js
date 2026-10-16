#!/usr/bin/env node
/**
 * MARKET-WIDE NEWS CYCLE SCAN
 *
 * ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────────────────────
 * institutional-feeds.js queries one symbol at a time. AlphaVantage free tier is 25 requests a
 * day and a full symbol costs 4, so that architecture tops out at roughly SIX names. It cannot
 * see the market, which makes it useless for the question "what moved today and why."
 *
 * The fix is not a bigger quota. It is that NEWS_SENTIMENT does not have to be asked per ticker.
 * Called with `topics` instead of `tickers` it returns the market-wide feed, and EVERY article
 * arrives pre-tagged with a ticker_sentiment[] array naming each symbol it concerns and scoring
 * sentiment for each one separately. So a handful of calls yields sentiment for hundreds of
 * tickers, and coverage is set by how much news exists rather than by the API budget.
 *
 * On 2026-07-29 the FTC sued Hims & Hers and the stock fell ~13%. Nothing in this system
 * surfaced it. A per-symbol scanner never would have — HIMS is not in SCAN_UNIVERSE, so it was
 * never going to be one of the six names asked about. A market-wide scan does not need to know
 * the name in advance, which is the whole point.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────────────────────
 * Not alpha. By the time an article is published the move has happened; this project has already
 * measured what reacting to public information is worth (test #32: 52,330 trades, all 60
 * multiplicity-corrected survivors negative). Ranking here is DESCRIPTIVE — it answers "what is
 * the market reacting to right now, and is anything I own or understand in it."
 *
 * Its value is coverage, not speed: it flags names you would otherwise never have looked at, and
 * it flags them without being told which names to watch. Whether that has predictive content is
 * an open question the weighted board will answer by measurement, like everything else.
 *
 * Usage: node backend/market-news-cycle.js [--limit 1000] [--min-articles 2]
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const AV = (() => {
  try { const t = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
        return (t.match(/^ALPHAVANTAGE_KEY=(.*)$/m) || [])[1]?.trim(); } catch { return null; }
})();

const argv = process.argv.slice(2);
const numArg = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 ? Number(argv[i + 1]) : dflt; };
const LIMIT = numArg("--limit", 1000);
const MIN_ARTICLES = numArg("--min-articles", 2);

/**
 * Topic slices. Each is ONE request returning up to `LIMIT` articles across all tickers those
 * articles mention. Chosen to span the tape rather than to match a watchlist — the point is to
 * see names nobody told us to look at.
 */
const TOPICS = ["financial_markets", "life_sciences", "technology", "earnings", "mergers_and_acquisitions"];

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const nap = ms => new Promise(r => setTimeout(r, ms));

async function pull(topic) {
  const u = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&topics=${topic}&limit=${LIMIT}&apikey=${AV}`;
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(60000) });
    const j = await r.json();
    if (j.Note || j.Information) return { topic, error: String(j.Note || j.Information).slice(0, 90), feed: [] };
    return { topic, feed: j.feed || [] };
  } catch (e) { return { topic, error: e.message, feed: [] }; }
}

(async () => {
  if (!AV) { console.error("  ALPHAVANTAGE_KEY not found in backend/.env"); process.exit(1); }
  console.log(`\n  MARKET-WIDE NEWS CYCLE · ${TOPICS.length} topic calls · up to ${LIMIT} articles each\n`);

  const seen = new Map();                 // article url -> article (dedupe across topics)
  const errors = [];
  for (const t of TOPICS) {
    const { feed, error } = await pull(t);
    if (error) { errors.push(`${t}: ${error}`); console.log(`  ${t.padEnd(26)} FAILED — ${error.slice(0, 60)}`); }
    else { feed.forEach(a => { if (a.url && !seen.has(a.url)) seen.set(a.url, a); });
           console.log(`  ${t.padEnd(26)} ${feed.length} articles`); }
    await nap(900);
  }
  const articles = [...seen.values()];
  console.log(`\n  ${articles.length} unique articles after dedupe`);
  if (!articles.length) { console.log(`  nothing retrieved — ${errors.join(" | ")}\n`); process.exit(0); }

  // ── aggregate by ticker ─────────────────────────────────────────────────
  const byTicker = new Map();
  for (const a of articles) {
    for (const t of (a.ticker_sentiment || [])) {
      const s = Number(t.ticker_sentiment_score);
      const rel = Number(t.relevance_score);
      if (!Number.isFinite(s)) continue;
      const cur = byTicker.get(t.ticker) || { sym: t.ticker, scores: [], rel: [], arts: [] };
      cur.scores.push(s); cur.rel.push(Number.isFinite(rel) ? rel : 0);
      cur.arts.push({ title: a.title, time: a.time_published, sent: s, rel, url: a.url });
      byTicker.set(t.ticker, cur);
    }
  }
  const rows = [...byTicker.values()]
    .filter(r => r.scores.length >= MIN_ARTICLES)
    .map(r => {
      const avg = mean(r.scores), avgRel = mean(r.rel);
      // Rank by how strongly the tape is talking about it: sentiment magnitude x coverage x
      // relevance. Sign is kept separately so the direction is never lost in the ranking.
      const intensity = Math.abs(avg) * Math.log1p(r.scores.length) * (0.5 + avgRel);
      return { sym: r.sym, n: r.scores.length, avg: +avg.toFixed(3), rel: +avgRel.toFixed(2),
               intensity: +intensity.toFixed(4), neg: r.scores.filter(x => x < -0.15).length,
               pos: r.scores.filter(x => x > 0.15).length,
               top: r.arts.sort((x, y) => Math.abs(y.sent) - Math.abs(x.sent))[0] };
    })
    .sort((a, b) => b.intensity - a.intensity);

  console.log(`  ${byTicker.size} distinct tickers tagged · ${rows.length} with >=${MIN_ARTICLES} articles\n`);
  console.log(`  ══ MOST INTENSELY COVERED, whole market ══`);
  console.log(`  ${"sym".padEnd(7)} ${"n".padStart(4)} ${"avg".padStart(7)} ${"rel".padStart(5)} ${"int".padStart(7)}  headline`);
  rows.slice(0, 25).forEach(r => console.log(
    `  ${r.sym.padEnd(7)} ${String(r.n).padStart(4)} ${((r.avg >= 0 ? "+" : "") + r.avg).padStart(7)} ${String(r.rel).padStart(5)} ${String(r.intensity).padStart(7)}  ${String(r.top?.title || "").slice(0, 62)}`));

  const worst = rows.filter(r => r.avg < -0.1).sort((a, b) => a.avg - b.avg).slice(0, 12);
  console.log(`\n  ══ MOST NEGATIVE (avg sentiment < -0.10) ══`);
  worst.forEach(r => console.log(`  ${r.sym.padEnd(7)} n=${String(r.n).padStart(3)} avg ${r.avg}  ${String(r.top?.title || "").slice(0, 70)}`));

  // domain-watchlist intersection — the operator's actual circle of competence
  const DOMAIN = ["LLY", "NVO", "AMGN", "MCK", "HIMS", "LFMD", "VKTX", "UNH", "CI", "TDOC", "DXCM", "PODD"];
  const dom = rows.filter(r => DOMAIN.includes(r.sym));
  console.log(`\n  ══ INSIDE YOUR CIRCLE OF COMPETENCE ══`);
  if (dom.length) dom.forEach(r => console.log(`  ${r.sym.padEnd(7)} n=${String(r.n).padStart(3)} avg ${((r.avg >= 0 ? "+" : "") + r.avg).padStart(7)}  ${String(r.top?.title || "").slice(0, 70)}`));
  else console.log(`  none of the 12 domain names appear in today's feed`);

  // 2026-09-03 coverage-mechanic fix: this used to persist rows.slice(0, 300), discarding up to
  // ~80% of the tickers that already passed the >=MIN_ARTICLES filter (1,603 tagged, only 300
  // kept). obs.newsCycle downstream (traids-server-v2.js /api/lite-scan -> src/App.jsx LITE.obs)
  // was measured THIN (14.5% of Equity tickets, under the 15% floor) for exactly this reason: the
  // cap, not the feed, was starving it. No extra API calls — the full byTicker map is already in
  // memory. See also institutional-feeds.js newsFromCycle(), which forwards rel/intensity again.
  fs.writeFileSync(D("market-news-cycle.json"), JSON.stringify({
    generated: new Date().toISOString(), topics: TOPICS, articles: articles.length,
    tickersTagged: byTicker.size, rows, domain: dom, errors,
    caveats: [
      "Descriptive, not predictive. Published news is public; test #32 measured what trading public information is worth and every corrected survivor was negative.",
      "Coverage is set by what the topic feeds carry, not by a universe list — that is the point, but it also means absence is not evidence of quiet.",
      "AlphaVantage sentiment scores are vendor-computed. They are an input to be measured, not a ground truth.",
    ],
  }, null, 1));
  console.log(`\n  written: backend/data/market-news-cycle.json\n`);
})();
