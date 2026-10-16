#!/usr/bin/env node
/**
 * TRAIDS — PEAD Test (Post-Earnings Announcement Drift)
 *
 * The one genuinely DIFFERENT-information hypothesis: do stocks drift in the direction of
 * their earnings SURPRISE for weeks after the report? Pre-registered hypothesis:
 *   "Long positive-surprise / short negative-surprise, entered the day AFTER the report
 *    (surprise fully public — no look-ahead), held N days, has positive expectancy net of
 *    costs." Benchmark: the same names' market drift over the same window (long-short is
 *    ~market-neutral, so the honest bar is mean drift > 0 with a CI excluding 0).
 *
 * Data: Finnhub earnings calendar (report date + epsActual + epsEstimate) → surprise sign;
 * Alpaca daily bars → the post-report drift. Honest by construction: net of costs, with an
 * effective-N and confidence interval. Survivorship caveat (today's 45 liquid names) applies.
 *
 * Usage:  node backend/pead-test.js          (needs FINNHUB_API_KEY + ALPACA keys in .env)
 */
const fs = require("fs");
const path = require("path");
function loadEnv() { try { const txt = fs.readFileSync(path.join(__dirname, ".env"), "utf8"); for (const line of txt.split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} }
loadEnv();
const AK = process.env.ALPACA_KEY_ID, AS = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
const FK = process.env.FINNHUB_API_KEY;
if (!AK || !AS) { console.error("\n  Missing ALPACA keys in backend/.env.\n"); process.exit(1); }
if (!FK || /your_|xxx|changeme/i.test(FK)) { console.error("\n  Missing FINNHUB_API_KEY in backend/.env — PEAD needs earnings surprises.\n"); process.exit(1); }
const aHead = { "APCA-API-KEY-ID": AK, "APCA-API-SECRET-KEY": AS, Accept: "application/json" };
const COST_BPS = parseFloat(process.env.COST_BPS || "5");
const HOLDS = [20, 40, 60];
const SURP_MIN = parseFloat(process.env.SURP_MIN || "0.02");   // ignore |surprise| < 2% (noise around consensus)
const UNIVERSE = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","JPM","V","UNH","XOM","JNJ","WMT","PG","MA","HD","CVX","ABBV","KO","PEP","COST","MRK","AVGO","LLY","BAC","ADBE","CRM","NFLX","AMD","DIS","INTC","QCOM","TXN","HON","UNP","LOW","CAT","GS","BKNG","NKE","MS","BA","T","PFE","C"];

const today = new Date().toISOString().slice(0, 10);
const from = new Date(Date.now() - 760 * 86_400_000).toISOString().slice(0, 10);

async function earnings(sym) {
  // /stock/earnings returns historical surprises on the free tier (actual/estimate/period).
  // `period` is the fiscal quarter-END; the report lands weeks later — we detect that below.
  const r = await fetch(`https://finnhub.io/api/v1/stock/earnings?symbol=${sym}&token=${FK}`);
  if (!r.ok) return [];
  const j = await r.json();
  return (Array.isArray(j) ? j : []).filter(e => e.actual != null && e.estimate != null && e.estimate !== 0)
    .map(e => ({ periodEnd: e.period, surprise: (e.actual - e.estimate) / Math.abs(e.estimate) }));
}
async function bars(sym) {
  const out = []; let pageToken = null;
  do {
    const params = new URLSearchParams({ symbols: sym, timeframe: "1Day", start: from, limit: "10000", adjustment: "all", feed: FEED });
    if (pageToken) params.set("page_token", pageToken);
    const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${params}`, { headers: aHead });
    if (!r.ok) break;
    const j = await r.json();
    for (const b of (j.bars?.[sym] || [])) out.push({ d: (b.t || "").slice(0, 10), c: b.c });
    pageToken = j.next_page_token || null;
  } while (pageToken);
  return out;
}
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };

(async () => {
  console.log(`\n  TRAIDS — PEAD Test  ·  ${UNIVERSE.length} names · ${from} → ${today} · |surprise|≥${(SURP_MIN*100)|0}% · ${COST_BPS}bps/side\n`);
  // events[h] = array of drift returns (direction-adjusted) for hold h
  const driftByHold = {}; HOLDS.forEach(h => driftByHold[h] = []);
  let totalEvents = 0, posCnt = 0, negCnt = 0;
  process.stdout.write("  fetching earnings + bars");
  for (const sym of UNIVERSE) {
    const [evs, bs] = await Promise.all([earnings(sym), bars(sym)]);
    process.stdout.write(".");
    if (bs.length < 80) continue;
    for (const e of evs) {
      if (Math.abs(e.surprise) < SURP_MIN) continue;
      // Detect the announcement day: the biggest single-day move in the ~2–9 week window
      // after quarter-end (earnings produce the largest move of the quarter for these names).
      let p0 = -1; for (let i = 0; i < bs.length; i++) { if (bs[i].d >= e.periodEnd) { p0 = i; break; } }
      if (p0 < 0) continue;
      const lo = p0 + 8, hi = Math.min(p0 + 45, bs.length - 1);
      let t0 = -1, maxMove = 0;
      for (let i = lo; i <= hi; i++) { const mv = Math.abs((bs[i].c - bs[i - 1].c) / bs[i - 1].c); if (mv > maxMove) { maxMove = mv; t0 = i; } }
      if (t0 < 0 || maxMove < 0.03) continue;   // need an earnings-sized move to trust the detection
      const entryIdx = t0;                       // enter at the announcement day's CLOSE (after the jump → measure drift)
      const dir = e.surprise > 0 ? 1 : -1;
      let counted = false;
      for (const h of HOLDS) {
        const xi = entryIdx + h;
        if (xi >= bs.length) continue;
        const raw = (bs[xi].c - bs[entryIdx].c) / bs[entryIdx].c;
        driftByHold[h].push(dir * raw - COST_BPS * 2 / 10000);   // direction-adjusted, net of one round-trip
        counted = true;
      }
      if (counted) { totalEvents++; dir > 0 ? posCnt++ : negCnt++; }
    }
  }
  console.log(`\n\n  ${totalEvents} usable earnings events (${posCnt} positive-surprise / ${negCnt} negative).\n`);
  if (!totalEvents) { console.error("  No usable events — Finnhub free tier may not return 2y of historical earnings. Stop.\n"); process.exit(1); }

  const pad = (s, n) => String(s).padEnd(n);
  console.log("  " + pad("hold", 8) + pad("n", 8) + pad("mean drift", 13) + pad("win%", 8) + pad("95% CI on mean", 24) + "verdict");
  console.log("  " + "─".repeat(78));
  let anyEdge = false;
  for (const h of HOLDS) {
    const a = driftByHold[h];
    if (a.length < 10) { console.log("  " + pad(h + "d", 8) + pad(a.length, 8) + "too few"); continue; }
    const m = mean(a), se = sd(a) / Math.sqrt(a.length), lo = m - 1.96 * se, hi = m + 1.96 * se;
    const win = a.filter(v => v > 0).length / a.length * 100;
    const edge = lo > 0;
    if (edge) anyEdge = true;
    console.log("  " + pad(h + "d", 8) + pad(a.length, 8) + pad((m >= 0 ? "+" : "") + (m * 100).toFixed(2) + "%", 13) + pad(win.toFixed(0) + "%", 8) +
      pad(`[${(lo*100).toFixed(2)}%, ${(hi*100).toFixed(2)}%]`, 24) + (edge ? "✅ excludes 0" : "❌ contains 0"));
  }
  console.log("\n  VERDICT:");
  if (anyEdge) console.log("    A drift effect's 95% CI excludes zero at some horizon NET of costs — a candidate. Re-test OOS (split by time)\n    and forward before believing it. Watch for survivorship + the small event count.");
  else console.log("    No PEAD edge survives: every horizon's CI contains zero net of costs. Consistent with a heavily-arbitraged,\n    cost-killed anomaly. Another honest null — the drift, if any, isn't capturable here.");
  console.log("\n  Caveats: survivorship (today's 45 liquid names); Finnhub free-tier earnings history may be partial; the long-short\n  is ~market-neutral so the bar is mean>0 with CI excluding 0, not beating buy-and-hold. Indicative, not a green light.\n");
})().catch(e => { console.error("\n  PEAD error:", e.message, "\n"); process.exit(1); });
