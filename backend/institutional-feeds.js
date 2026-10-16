#!/usr/bin/env node
/**
 * INSTITUTIONAL FEEDS — the five models that were computed from ticker letters, wired to real data.
 *
 * ── WHAT THIS REPLACES ──────────────────────────────────────────────────────────────────────
 * src/App.jsx shipped seven "institutional signal models" whose output came from symSeed(sym) —
 * a hash of the characters in the ticker, run through Math.sin. AAPL's earnings-beat history was
 * a function of A, A, P, L. There were zero network calls in the engine and the APIs it needed
 * existed only in comments. Because the hash is deterministic it printed the same confident
 * number every session forever, so nothing ever looked wrong (defect D36).
 *
 * Worse, that fabricated composite was added into the AI Market Scanner's ranking score, so
 * fixing the scanner's PRICES still left its RANKING partly derived from ticker spelling.
 *
 * ── WHY SERVER-SIDE ─────────────────────────────────────────────────────────────────────────
 * The API keys live in backend/.env. Calling AlphaVantage from the browser would ship the key to
 * anyone who opens devtools. Everything is fetched here and served without credentials.
 *
 * ── THE RULE THAT MATTERS ───────────────────────────────────────────────────────────────────
 * Every model returns `available: false` when its feed fails. It NEVER substitutes an estimate,
 * a prior, or a hash. Downstream, an unavailable model is dropped from the confidence-weighted
 * composite entirely rather than contributing a zero — a model with no data has no vote, which
 * is different from a model voting neutral.
 *
 * Free-tier AlphaVantage is 25 requests/day. Results are cached to disk per symbol per day, and
 * the cache is checked before every call, because burning the quota on a re-render would take
 * the whole panel dark.
 *
 * Usage:  node backend/institutional-feeds.js AAPL HIMS      # fetch + print
 *         const { getInstitutional } = require("./institutional-feeds.js")
 */
const fs = require("fs"), path = require("path");
try { require("dotenv").config({ path: path.join(__dirname, ".env") }); } catch { }
const D = (f) => path.join(__dirname, "data", f);
const CACHE_DIR = D("institutional-cache");
const AV = process.env.ALPHAVANTAGE_KEY;
const FINNHUB = process.env.FINNHUB_API_KEY;
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
const nap = ms => new Promise(r => setTimeout(r, ms));
const cachePath = (sym) => path.join(CACHE_DIR, `${sym}-${today()}.json`);
const readCache = (sym) => { try { return JSON.parse(fs.readFileSync(cachePath(sym), "utf8")); } catch { return null; } };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const clamp = (v, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));

async function jget(url, timeout = 30000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  // AlphaVantage signals quota exhaustion with a 200 + a Note/Information field, not an error code.
  if (j.Note || j.Information) throw new Error("rate limited: " + String(j.Note || j.Information).slice(0, 80));
  return j;
}

// ── 1. EARNINGS ───────────────────────────────────────────────────────────
async function earnings(sym) {
  if (!AV) return { available: false, reason: "ALPHAVANTAGE_KEY not set" };
  try {
    const j = await jget(`https://www.alphavantage.co/query?function=EARNINGS&symbol=${sym}&apikey=${AV}`);
    const q = (j.quarterlyEarnings || []).slice(0, 8)
      .map(e => ({ q: e.fiscalDateEnding, est: +e.estimatedEPS, act: +e.reportedEPS, surprisePct: +e.surprisePercentage }))
      .filter(e => Number.isFinite(e.surprisePct));
    if (!q.length) return { available: false, reason: "no quarterly earnings returned" };
    const beats = q.filter(e => e.surprisePct > 0).length;
    const avgSurprise = mean(q.map(e => e.surprisePct));
    // Score blends how OFTEN it beats with how BIG the beats are; both are capped so one freak
    // quarter cannot dominate. Confidence rises with the number of quarters actually returned.
    const score = clamp(((beats / q.length) - 0.5) * 1.6 + clamp(avgSurprise / 20, -0.4, 0.4));
    return { available: true, score: +score.toFixed(3), confidence: +Math.min(0.9, 0.35 + q.length * 0.07).toFixed(2),
             beatRate: +(beats / q.length).toFixed(2), avgSurprisePct: +avgSurprise.toFixed(2), quarters: q.length, history: q };
  } catch (e) { return { available: false, reason: e.message }; }
}

// ── 2. INSIDERS ───────────────────────────────────────────────────────────
async function insiders(sym) {
  if (!AV) return { available: false, reason: "ALPHAVANTAGE_KEY not set" };
  try {
    const j = await jget(`https://www.alphavantage.co/query?function=INSIDER_TRANSACTIONS&symbol=${sym}&apikey=${AV}`);
    const rows = (j.data || []).slice(0, 120);
    if (!rows.length) return { available: false, reason: "no insider transactions returned" };
    const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const recent = rows.filter(r => String(r.transaction_date || "") >= cutoff);
    const val = r => (+r.shares || 0) * (+r.share_price || 0);
    const buys = recent.filter(r => /A|P|acquisition|buy/i.test(r.acquisition_or_disposal || "")).reduce((s, r) => s + val(r), 0);
    const sells = recent.filter(r => /D|S|disposal|sell/i.test(r.acquisition_or_disposal || "")).reduce((s, r) => s + val(r), 0);
    const net = buys - sells, gross = buys + sells;
    if (!gross) return { available: false, reason: "no valued transactions in the last 90 days" };
    return { available: true, score: +clamp(net / gross).toFixed(3),
             confidence: +Math.min(0.8, 0.3 + recent.length * 0.02).toFixed(2),
             netUsd: Math.round(net), buysUsd: Math.round(buys), sellsUsd: Math.round(sells), n90d: recent.length };
  } catch (e) { return { available: false, reason: e.message }; }
}

// ── 3. SHORT INTEREST — already on disk, never read by the frontend ───────
function shortInterest(sym) {
  try {
    const dir = D("finra-cache");
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort().slice(-21);
    if (files.length < 12) return { available: false, reason: `only ${files.length} FINRA sessions cached (need 12)` };
    const series = [];
    for (const f of files) {
      try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); const e = j[sym];
        if (e && e.total > 0) series.push(e.short / e.total); } catch { }
    }
    if (series.length < 12) return { available: false, reason: `only ${series.length} sessions carry ${sym}` };
    const cur = series[series.length - 1], hist = series.slice(0, -1);
    const m = mean(hist), s = Math.sqrt(hist.reduce((a, v) => a + (v - m) ** 2, 0) / (hist.length - 1));
    if (!(s > 0)) return { available: false, reason: "zero variance in short-volume ratio" };
    const z = (cur - m) / s;
    /**
     * SIGN. Test #35 measured this: HIGH short-volume z-score precedes WORSE forward returns
     * (survives Bonferroni + OOS at t 3.32/3.09). The weighted board independently re-measured
     * it on the live ledger at t -3.64 with 0 of 5 sessions positive. So a high z is BEARISH and
     * the score is negated. Squeeze folklore points the other way and got no support (test #34).
     */
    return { available: true, score: +clamp(-z / 2.5).toFixed(3), confidence: 0.6,
             svrZ: +z.toFixed(2), ratio: +cur.toFixed(3), sessions: series.length,
             note: "high short-volume z is bearish (test #35, re-measured t -3.64)" };
  } catch (e) { return { available: false, reason: e.message }; }
}

// ── 4. NEWS SENTIMENT ─────────────────────────────────────────────────────
/**
 * MARKET-CYCLE FIRST (2026-07-29). The per-symbol NEWS_SENTIMENT call costs 1 of 25 daily
 * requests, which caps coverage at ~6 symbols — useless for "analyze everything possible."
 * market-news-cycle.js pulls the whole tape by TOPIC (5 calls → 4,301 articles → 2,337
 * tickers, each pre-scored), so any symbol the tape mentioned is served from that cache at
 * zero quota. The per-symbol AV call remains as the deep fallback for names the cycle missed.
 */
function newsFromCycle(sym) {
  try {
    const j = JSON.parse(fs.readFileSync(D("market-news-cycle.json"), "utf8"));
    const ageH = (Date.now() - new Date(j.generated).getTime()) / 36e5;
    if (ageH > 30) return null;                        // stale cycle — fall through to AV
    const r = (j.rows || []).find(x => x.sym === sym);
    if (!r) return null;
    return { available: true, score: +clamp(r.avg * 2.5).toFixed(3),
             confidence: +Math.min(0.7, 0.25 + r.n * 0.01).toFixed(2),
             avgSentiment: r.avg, articleCount: r.n, bullish: r.pos, bearish: r.neg,
             // rel/intensity (2026-09-03): market-news-cycle.js has always computed these — a
             // relevance-weighted score and log1p(n)-scaled magnitude — but this function dropped
             // them before they ever reached obs.newsRel / obs.newsIntensity, which is why both
             // read DEAD in observer-liveness.json despite the upstream data existing.
             rel: Number.isFinite(r.rel) ? r.rel : null, intensity: Number.isFinite(r.intensity) ? r.intensity : null,
             headline: r.top?.title || null, source: "market-news-cycle" };
  } catch { return null; }
}
async function newsSentiment(sym) {
  const cycle = newsFromCycle(sym);
  if (cycle) return cycle;
  if (!AV) return { available: false, reason: "not in market cycle; ALPHAVANTAGE_KEY not set" };
  try {
    const j = await jget(`https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${sym}&limit=50&apikey=${AV}`);
    const feed = j.feed || [];
    if (!feed.length) return { available: false, reason: "no news returned" };
    const scores = [];
    for (const a of feed) {
      const t = (a.ticker_sentiment || []).find(x => x.ticker === sym);
      if (t && Number.isFinite(+t.ticker_sentiment_score)) scores.push(+t.ticker_sentiment_score);
    }
    if (scores.length < 5) return { available: false, reason: `only ${scores.length} scored articles` };
    const avg = mean(scores);
    return { available: true, score: +clamp(avg * 2.5).toFixed(3),
             confidence: +Math.min(0.7, 0.25 + scores.length * 0.01).toFixed(2),
             // Named articleCount, NOT `articles`: the frontend's seeded scaffolding uses
             // `articles` for an ARRAY of headlines it maps over, and a number under the same
             // key crashed the whole app when the live merge clobbered it (blank-tab regression,
             // 2026-07-29 evening).
             avgSentiment: +avg.toFixed(3), articleCount: scores.length,
             bullish: scores.filter(x => x > 0.15).length, bearish: scores.filter(x => x < -0.15).length };
  } catch (e) { return { available: false, reason: e.message }; }
}

// ── 5. OPTIONS FLOW ───────────────────────────────────────────────────────
async function optionsFlow(sym) {
  if (!AV) return { available: false, reason: "ALPHAVANTAGE_KEY not set" };
  try {
    const j = await jget(`https://www.alphavantage.co/query?function=HISTORICAL_OPTIONS&symbol=${sym}&apikey=${AV}`);
    const rows = (j.data || []).filter(r => r.type && Number.isFinite(+r.volume));
    if (rows.length < 20) return { available: false, reason: `only ${rows.length} option rows` };
    const callVol = rows.filter(r => /call/i.test(r.type)).reduce((s, r) => s + (+r.volume || 0), 0);
    const putVol = rows.filter(r => /put/i.test(r.type)).reduce((s, r) => s + (+r.volume || 0), 0);
    if (!(callVol + putVol)) return { available: false, reason: "zero option volume" };
    const pc = putVol / (callVol || 1);
    /**
     * Put/call is CONTRARIAN-ambiguous and this project has no measured result on it, so the
     * score is deliberately small and confidence deliberately low. It is here to be MEASURED by
     * the weighted board, not to be believed. A neutral P/C near 0.7-1.0 maps to ~0.
     */
    return { available: true, score: +clamp((0.85 - pc) * 0.8, -0.6, 0.6).toFixed(3), confidence: 0.35,
             putCall: +pc.toFixed(2), callVolume: callVol, putVolume: putVol, contracts: rows.length,
             note: "no measured predictive result for P/C in this project — low confidence on purpose" };
  } catch (e) { return { available: false, reason: e.message }; }
}

// ── 6. LEGAL / REGULATORY EXPOSURE — whole market, from EDGAR full-text ──
/**
 * Reads market-legal-scan.json (381 filers on the last run, no universe list, no API key).
 * A symbol ABSENT from the scan scores 0 with confidence 0.3 — "no trigger phrases filed" is
 * weak-positive information, distinct from unavailable. This is the model that would have put
 * HIMS at the top of the exposure list 79 days before the FTC suit (score 17, #1 of 12).
 */
function legalExposure(sym) {
  try {
    const j = JSON.parse(fs.readFileSync(D("market-legal-scan.json"), "utf8"));
    const ageD = (Date.now() - new Date(j.generated).getTime()) / 864e5;
    if (ageD > 8) return { available: false, reason: `market-legal-scan.json is ${ageD.toFixed(0)}d old — re-run backend/market-legal-scan.js` };
    const r = (j.rows || []).find(x => x.ticker === sym);
    if (!r) return { available: true, score: 0, confidence: 0.3, exposureScore: 0,
                     note: "no legal trigger phrases filed in the scan window", source: "market-legal-scan" };
    // Exposure is BEARISH: score maps 0..-1 as filings pile up. 39 (FirstEnergy) ≈ floor.
    return { available: true, score: +clamp(-r.score / 20, -1, 0).toFixed(3),
             confidence: +Math.min(0.75, 0.35 + r.triggers.length * 0.15).toFixed(2),
             exposureScore: r.score, triggers: r.triggers, latestFiling: r.latest, source: "market-legal-scan" };
  } catch { return { available: false, reason: "market-legal-scan.json not found — run backend/market-legal-scan.js" }; }
}

/**
 * lite=true serves only the zero-quota sources (short interest, cycle news, legal) — this is
 * the whole-market path, cheap enough to call for any list of symbols. The AV per-symbol
 * models (earnings, insiders, options flow) burn the 25/day budget and stay opt-in.
 */
async function getInstitutional(sym, { force = false, lite = false } = {}) {
  sym = String(sym).toUpperCase();
  if (!force) { const c = readCache(sym); if (c && (!lite || c.lite === lite)) return c; }
  const out = { symbol: sym, asOf: today(), fetchedAt: new Date().toISOString(), lite };
  out.shortInterest = shortInterest(sym);            // local, free, instant
  out.legal = legalExposure(sym);                    // local, free, whole market
  if (lite) {
    out.newsSentiment = newsFromCycle(sym) || { available: false, reason: "not in today's market cycle" };
    out.earnings = { available: false, reason: "lite mode — AV quota reserved; call with deep=1" };
    out.insiders = { available: false, reason: "lite mode — AV quota reserved; call with deep=1" };
    out.optionsFlow = { available: false, reason: "lite mode — AV quota reserved; call with deep=1" };
  } else {
    out.earnings = await earnings(sym);                await nap(900);
    out.insiders = await insiders(sym);                await nap(900);
    out.newsSentiment = await newsSentiment(sym);      await nap(900);
    out.optionsFlow = await optionsFlow(sym);
  }
  const models = ["earnings", "insiders", "shortInterest", "newsSentiment", "optionsFlow", "legal"];
  out.coverage = `${models.filter(m => out[m].available).length}/${models.length} on real data`;
  out.unavailable = models.filter(m => !out[m].available).map(m => ({ model: m, reason: out[m].reason }));
  fs.writeFileSync(cachePath(sym), JSON.stringify(out, null, 1));
  return out;
}

module.exports = { getInstitutional, shortInterest };

if (require.main === module) {
  (async () => {
    const syms = process.argv.slice(2).filter(a => !a.startsWith("--"));
    const force = process.argv.includes("--force");
    if (!syms.length) { console.log("usage: node backend/institutional-feeds.js AAPL HIMS [--force]"); process.exit(1); }
    for (const s of syms) {
      const r = await getInstitutional(s, { force });
      console.log(`\n  ${r.symbol} · ${r.coverage} · asOf ${r.asOf}`);
      for (const m of ["earnings", "insiders", "shortInterest", "newsSentiment", "optionsFlow"]) {
        const x = r[m];
        console.log(x.available
          ? `     ${m.padEnd(15)} score ${String(x.score).padStart(7)}  conf ${x.confidence}   ${Object.entries(x).filter(([k]) => !["available", "score", "confidence", "history", "note"].includes(k)).map(([k, v]) => `${k}=${v}`).join(" ").slice(0, 80)}`
          : `     ${m.padEnd(15)} UNAVAILABLE — ${x.reason}`);
      }
    }
    console.log("");
  })();
}
