#!/usr/bin/env node
/**
 * WHOLE-MARKET LITE SCAN — every symbol the tape knows about, through the zero-quota models.
 *
 * Universe is assembled from the real market-wide sources, not a hand-picked list: every ticker
 * the news cycle tagged, every filer the legal scan flagged, every symbol in the FINRA
 * short-volume cache. Each runs through getInstitutional(lite) — short interest, cycle news,
 * legal exposure — none of which touch the AlphaVantage quota, so the whole market costs
 * nothing to score and can run nightly.
 *
 * Output ranks ATTENTION, not alpha. A symbol surfaces when independent real sources agree
 * something is happening: negative news + filed legal exposure + a short-volume extreme. That
 * is a reading list. Every score here enters the weighted board at ZERO and earns weight only
 * by measurement — the one lesson this project has paid for 57 times.
 *
 * Usage: node backend/market-lite-scan.js
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const { getInstitutional } = require("./institutional-feeds.js");

function universe() {
  const syms = new Set();
  try { JSON.parse(fs.readFileSync(D("market-news-cycle.json"), "utf8")).rows.forEach(r => syms.add(r.sym)); } catch { }
  try { JSON.parse(fs.readFileSync(D("market-legal-scan.json"), "utf8")).rows.forEach(r => { if (r.ticker) syms.add(r.ticker); }); } catch { }
  try {
    const dir = D("finra-cache");
    // newest PARSEABLE file — the newest one on disk was mid-write once and null-parsed
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith(".json")).sort().reverse()) {
      try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); if (j && Object.keys(j).length > 50) { Object.keys(j).forEach(s => syms.add(s)); break; } } catch { }
    }
  } catch { }
  return [...syms].filter(s => /^[A-Z]{1,5}$/.test(s)).sort();
}

(async () => {
  const syms = universe();
  console.log(`\n  WHOLE-MARKET LITE SCAN · ${syms.length} symbols · zero API quota\n`);
  const rows = [];
  let done = 0;
  for (const s of syms) {
    try {
      const r = await getInstitutional(s, { lite: true });
      const n = r.newsSentiment, l = r.legal, si = r.shortInterest;
      rows.push({
        sym: s,
        news: n?.available ? { score: n.score, n: n.articleCount, rel: n.rel ?? null, intensity: n.intensity ?? null, headline: (n.headline || "").slice(0, 90) } : null,
        legal: l?.available && l.exposureScore ? { score: l.score, exposure: l.exposureScore, triggers: l.triggers } : null,
        svrZ: si?.available ? si.svrZ : null,
        models: [n?.available, l?.available, si?.available].filter(Boolean).length,
      });
    } catch { }
    if (++done % 100 === 0) console.log(`  …${done}/${syms.length}`);
  }

  const withNews = rows.filter(r => r.news), withLegal = rows.filter(r => r.legal), withSvr = rows.filter(r => r.svrZ != null);
  console.log(`\n  coverage: news ${withNews.length} · legal exposure ${withLegal.length} · short-vol z ${withSvr.length} · total scored ${rows.length}\n`);

  // attention score: independent sources agreeing. Hand-set for READING ORDER, no predictive claim.
  for (const r of rows) {
    let a = 0, why = [];
    if (r.news && r.news.score <= -0.25) { a += Math.abs(r.news.score); why.push(`news ${r.news.score}`); }
    if (r.legal) { a += Math.min(1, r.legal.exposure / 20); why.push(`legal exp ${r.legal.exposure}`); }
    if (r.svrZ != null && Math.abs(r.svrZ) >= 2) { a += Math.abs(r.svrZ) / 4; why.push(`svrZ ${r.svrZ}`); }
    r.attention = +a.toFixed(3); r.why = why;
  }
  const hot = rows.filter(r => r.attention > 0 && r.why.length >= 2).sort((a, b) => b.attention - a.attention);
  const single = rows.filter(r => r.attention >= 0.5 && r.why.length === 1).sort((a, b) => b.attention - a.attention);

  console.log(`  ══ MULTI-SOURCE ATTENTION — independent real feeds agreeing ══`);
  if (hot.length) hot.slice(0, 20).forEach(r => console.log(`  ${r.sym.padEnd(7)} ${String(r.attention).padStart(6)}  ${r.why.join(" + ").padEnd(40)} ${r.news?.headline || ""}`.slice(0, 130)));
  else console.log(`  none — no symbol trips two independent sources today`);

  console.log(`\n  ══ SINGLE-SOURCE, STRONG ══`);
  single.slice(0, 15).forEach(r => console.log(`  ${r.sym.padEnd(7)} ${String(r.attention).padStart(6)}  ${r.why.join(" + ").padEnd(28)} ${r.news?.headline || (r.legal ? r.legal.triggers.join(", ") : "")}`.slice(0, 130)));

  fs.writeFileSync(D("market-lite-scan.json"), JSON.stringify({
    generated: new Date().toISOString(), universe: syms.length, scored: rows.length,
    coverage: { news: withNews.length, legal: withLegal.length, shortVol: withSvr.length },
    multiSource: hot, singleSourceStrong: single.slice(0, 50),
    rows: rows.filter(r => r.attention > 0 || r.models >= 2),
    caveats: [
      "Attention ranks reading order from hand-set thresholds — it carries no measured predictive claim and enters the weighted board at zero.",
      "Universe = tickers the tape itself surfaced (news cycle + legal scan + FINRA cache), not a curated list. Absence means the tape was quiet on the name, not that nothing is wrong.",
      "News coverage is bounded by the cycle cache's saved rows; legal by the 120-day scan window.",
    ],
  }, null, 1));
  console.log(`\n  written: backend/data/market-lite-scan.json\n`);
})();
