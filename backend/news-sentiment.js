#!/usr/bin/env node
/**
 * TRAIDS — News / Sentiment Signal (keyless lexicon scorer)
 *
 * Turns real headlines into a number in [-1, +1] using a finance-tuned word list
 * (no API key, no paid NLP). Exposes scoreHeadline()/scoreSymbol() so the board or a
 * validator can reuse it, and a CLI that pulls CURRENT headlines for the universe
 * (direct from Alpaca news) and prints a ranked sentiment table.
 *
 * HONEST LIMIT — why there's no out-of-sample table here:
 *   A signal is only worth trading if it PREDICTS forward returns. Proving that needs
 *   historical news aligned to the returns that followed. The free Alpaca/Yahoo news
 *   feeds only return RECENT headlines (no deep archive), so a proper backtest isn't
 *   possible from here. The honest path is FORWARD validation: log each setup's news
 *   score during the live test, then after the month correlate score vs realized R.
 *   This file builds the scorer + the logging-ready signal; it does NOT claim an edge.
 *
 * Usage:  node backend/news-sentiment.js                 (scores current universe news)
 *         node backend/news-sentiment.js AAPL NVDA TSLA  (specific symbols)
 *         echo "Nvidia crushes earnings, raises guidance" | node backend/news-sentiment.js -   (score stdin)
 */
const fs = require("fs");
const path = require("path");

// ── finance sentiment lexicon (weights roughly by strength) ───────────────────
const POS = {
  beat:2, beats:2, surge:2, surges:2, surged:2, soar:2, soars:2, soared:2, rally:2, rallies:2,
  jump:1.5, jumps:1.5, jumped:1.5, gain:1, gains:1, gained:1, rise:1, rises:1, rose:1, climb:1, climbs:1,
  upgrade:2, upgraded:2, outperform:2, outperforms:2, "buy":1, bullish:2, record:1.5, "high":1, highs:1.5,
  strong:1.5, stronger:1.5, growth:1.5, grew:1.5, profit:1.5, profits:1.5, beat_estimates:2, raises:1.5, raised:1.5,
  boost:1.5, boosts:1.5, boosted:1.5, top:1, tops:1.5, topped:1.5, win:1.5, wins:1.5, won:1.5, approval:1.5, approved:1.5,
  expand:1, expands:1, expansion:1, optimistic:1.5, accelerate:1.5, momentum:1, dividend:1, buyback:1.5, partnership:1,
};
const NEG = {
  miss:2, misses:2, missed:2, plunge:2, plunges:2, plunged:2, slump:2, slumps:2, tumble:2, tumbles:2, tumbled:2,
  fall:1.5, falls:1.5, fell:1.5, drop:1.5, drops:1.5, dropped:1.5, sink:1.5, sinks:1.5, slide:1.5, slides:1.5, slid:1.5,
  downgrade:2, downgraded:2, underperform:2, sell:1, bearish:2, "low":1, lows:1.5, weak:1.5, weaker:1.5, warning:2, warns:2,
  loss:1.5, losses:1.5, lawsuit:2, probe:1.5, investigation:1.5, recall:2, cut:1.5, cuts:1.5, slash:2, slashes:2, slashed:2,
  layoff:2, layoffs:2, bankruptcy:3, fraud:3, decline:1.5, declines:1.5, declined:1.5, fears:1.5, concern:1, concerns:1,
  halt:1.5, halts:1.5, halted:1.5, default:2.5, downturn:2, disappoint:2, disappoints:2, disappointing:2, sue:1.5, sued:1.5,
};
const NEGATORS = new Set(["not", "no", "never", "without", "fails", "fail", "failed", "despite"]);

// Score one headline → [-1, +1]. A negator within 2 words flips polarity.
function scoreHeadline(text) {
  if (!text) return 0;
  const words = String(text).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  let score = 0, hits = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    let val = POS[w] ? POS[w] : NEG[w] ? -NEG[w] : 0;
    if (!val) continue;
    const negated = words.slice(Math.max(0, i - 2), i).some(p => NEGATORS.has(p));
    if (negated) val = -val;
    score += val; hits++;
  }
  if (!hits) return 0;
  return Math.max(-1, Math.min(1, score / (hits + 1)));   // squash toward [-1,1]
}

// Aggregate a symbol's recent headlines → { score, n, label }
function scoreSymbol(headlines) {
  const arr = (headlines || []).map(h => scoreHeadline(typeof h === "string" ? h : (h.headline || h.title || "")));
  const n = arr.length;
  const score = n ? arr.reduce((s, v) => s + v, 0) / n : 0;
  const label = score > 0.15 ? "bullish" : score < -0.15 ? "bearish" : "neutral";
  return { score, n, label };
}

module.exports = { scoreHeadline, scoreSymbol };

// ── CLI ───────────────────────────────────────────────────────────────────────
function loadEnv() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
    for (const line of txt.split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
  } catch {}
}
async function alpacaNews(symbols) {
  const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY;
  if (!KEY || !SEC) return {};
  const r = await fetch(`https://data.alpaca.markets/v1beta1/news?symbols=${encodeURIComponent(symbols.join(","))}&limit=50&sort=desc`,
    { headers: { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" } });
  if (!r.ok) throw new Error(`Alpaca news ${r.status}`);
  const j = await r.json();
  const out = {}; symbols.forEach(s => out[s] = []);
  for (const n of (j.news || [])) for (const sym of (n.symbols || [])) { const u = String(sym).toUpperCase(); if (out[u] && out[u].length < 10) out[u].push(n.headline); }
  return out;
}

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (args[0] === "-") {   // score stdin
      const text = fs.readFileSync(0, "utf8").trim();
      console.log(`\n  "${text}"\n  → sentiment ${scoreHeadline(text).toFixed(3)}\n`);
      return;
    }
    loadEnv();
    const DEFAULT = ["AAPL","MSFT","NVDA","AMZN","META","TSLA","AMD","GOOGL","JPM","NFLX","AVGO","COST","LLY","XOM","WMT"];
    const symbols = args.length ? args.map(s => s.toUpperCase()) : DEFAULT;
    console.log(`\n  TRAIDS — News Sentiment (keyless lexicon) · ${symbols.length} symbols · CURRENT headlines`);
    console.log(`  Forward-validation only: this scores today's news; it does NOT claim a proven edge.\n`);
    let news;
    try { news = await alpacaNews(symbols); }
    catch (e) { console.error(`  Couldn't fetch news (${e.message}). Need ALPACA keys in backend/.env.\n`); process.exit(1); }
    const rows = symbols.map(s => ({ s, ...scoreSymbol(news[s]) })).sort((a, b) => b.score - a.score);
    const pad = (x, n) => String(x).padEnd(n);
    console.log("  " + pad("Symbol", 9) + pad("Headlines", 11) + pad("Score", 9) + "Read");
    console.log("  " + "─".repeat(42));
    for (const r of rows) {
      const bar = r.score === 0 ? "" : (r.score > 0 ? "+".repeat(Math.round(r.score * 5)) : "-".repeat(Math.round(-r.score * 5)));
      console.log("  " + pad(r.s, 9) + pad(r.n || "—", 11) + pad(r.score.toFixed(3), 9) + `${r.label} ${bar}`);
    }
    console.log(`\n  Next step (after the month): log each board setup's news score, then correlate score vs realized R.`);
    console.log(`  Only if higher score → higher forward R does this earn a slot. Built, not yet trusted.\n`);
  })().catch(e => { console.error(e); process.exit(1); });
}
