#!/usr/bin/env node
/**
 * TRAIDS — KALSHI CALIBRATION STUDY (prediction markets, test #33)
 *
 * THE QUESTION: is the favorite-longshot bias — the most replicated anomaly in betting
 * markets (low-probability contracts systematically OVERPRICED, favorites underpriced) —
 * present and EXPLOITABLE NET OF COSTS on Kalshi (the venue behind Coinbase's prediction
 * markets)? This is the first square we've tested where the structural prior is POSITIVE:
 * institutions are absent by regulation, and retail size is an advantage.
 *
 * METHOD (all keyless — Kalshi's public market-data API):
 *   • Universe: settled markets from real, high-activity series (BTC/ETH price brackets,
 *     city high-temperature dailies) — ladders naturally span the full price spectrum.
 *   • For each settled market: minute candles around the MIDPOINT of its life (uniform
 *     rule across 1-hour crypto brackets and 1-day weather markets, fixed in advance).
 *     Take the quote there: mid = (yes_bid + yes_ask)/2. REQUIRE a real two-sided quote
 *     (bid > 0, ask < $1, spread ≤ 10¢) — this auto-filters the untradeable junk ladder
 *     rungs. No quote at midpoint = not a tradeable market = excluded.
 *   • Outcome = market result (yes/no). Calibration gap per price bucket =
 *     realized YES frequency − average implied probability.
 *   • CLUSTERED by event: strikes of one ladder resolve together and are mechanically
 *     correlated — treating them as independent would fake significance. Cluster-robust
 *     SEs by event_ticker.
 *   • COSTS: Kalshi taker fee ≈ $0.07 × P × (1−P) per contract, plus the observed
 *     half-spread in that bucket. A bias you can't clear costs with isn't an edge.
 *
 * PRE-REGISTERED VERDICT RULE (before running):
 *   A bucket is EXPLOITABLE only if (a) its event-clustered 95% CI for the gap excludes
 *   zero AND (b) |gap| > fee(P) + median half-spread of the bucket. Anything less =
 *   "bias may exist; not tradeable." Expected outcome, stated in advance: the classic
 *   pattern appears nominally (longshots resolve less often than priced) but survives
 *   costs marginally or not at all in these liquid series; the interesting result would
 *   be either tail.
 *
 * Usage: node backend/kalshi-calibration.js   (env: MAX_MARKETS=700)
 */
const BASE = "https://api.elections.kalshi.com/trade-api/v2";
const H = { Accept: "application/json", "User-Agent": "Mozilla/5.0" };
const MAX_MARKETS = parseInt(process.env.MAX_MARKETS || "1400");
const SERIES = ["KXBTCD", "KXETHD", "KXHIGHNY", "KXHIGHCHI", "KXHIGHMIA", "KXHIGHAUS", "KXHIGHDEN", "KXHIGHLAX", "KXHIGHPHIL", "KXHIGHTDC"];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function get(url, tries = 4) {
  // Retries BOTH rate-limit responses AND thrown network errors (ECONNRESET etc.) —
  // a single dropped packet at market 5,250 of 5,616 killed run #3; one flaky fetch
  // must cost one market at most, never the run.
  for (let k = 0; k < tries; k++) {
    try {
      const r = await fetch(url, { headers: H });
      if (r.status === 429) { await sleep(2500); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch { await sleep(1500 * (k + 1)); }
  }
  return null;
}

(async () => {
  console.log(`\n  TRAIDS — KALSHI CALIBRATION STUDY (test #33) · favorite-longshot bias, net of costs`);
  console.log(`  midpoint-of-life sampling · two-sided-quote filter · event-clustered SEs · taker fee 0.07·P·(1−P) + half-spread\n`);

  // 1 — collect settled markets per series
  const markets = [];
  for (const s of SERIES) {
    let cursor = "", got = 0;
    for (let page = 0; page < 6; page++) {
      const j = await get(`${BASE}/markets?series_ticker=${s}&status=settled&limit=200${cursor ? "&cursor=" + cursor : ""}`);
      if (!j || !(j.markets || []).length) break;
      for (const m of j.markets) {
        if (m.result !== "yes" && m.result !== "no") continue;
        markets.push({ series: s, ticker: m.ticker, event: m.event_ticker, result: m.result === "yes" ? 1 : 0, open: m.open_time, close: m.close_time });
        got++;
      }
      cursor = j.cursor; if (!cursor) break;
      await sleep(120);
    }
    console.log(`  ${s.padEnd(12)} settled markets listed: ${got}`);
    await sleep(150);
  }
  // STRATIFIED round-robin across series (fix for run #1: slice(0,N) took only the first
  // series listed — 700 BTC hourly rungs from 4 ladders, 90% unquoted. Interleaving by
  // series gives the weather dailies — real traders, day-long books — their share, and
  // spreads the sample across many events instead of a handful of ladders.)
  const bySeries = {};
  for (const m of markets) (bySeries[m.series] = bySeries[m.series] || []).push(m);
  const pools = Object.values(bySeries);
  const sample = [];
  for (let i = 0; sample.length < MAX_MARKETS; i++) {
    let any = false;
    for (const p of pools) if (i < p.length && sample.length < MAX_MARKETS) { sample.push(p[i]); any = true; }
    if (!any) break;
  }
  const mix = {}; for (const m of sample) mix[m.series] = (mix[m.series] || 0) + 1;
  console.log(`\n  total listed: ${markets.length} · sampling ${sample.length} stratified: ${JSON.stringify(mix)}\n  fetching midpoint quotes`);

  // 2 — midpoint quote per market
  const obs = [];
  let done = 0, noQuote = 0;
  for (const m of sample) {
    const o = Math.floor(new Date(m.open).getTime() / 1000), c = Math.floor(new Date(m.close).getTime() / 1000);
    if (!(c > o)) { done++; continue; }
    const mid = Math.floor(o + (c - o) / 2);
    const j = await get(`${BASE}/series/${m.series}/markets/${m.ticker}/candlesticks?start_ts=${Math.max(o, mid - 7200)}&end_ts=${Math.min(c, mid + 7200)}&period_interval=1`);
    done++; if (done % 50 === 0) process.stdout.write(".");
    await sleep(140);
    const cs = j?.candlesticks || [];
    let best = null, bestD = Infinity;
    for (const k of cs) {
      const bid = parseFloat(k.yes_bid?.close_dollars ?? "0"), ask = parseFloat(k.yes_ask?.close_dollars ?? "0");
      if (!(bid > 0 && ask < 1 && ask > bid && (ask - bid) <= 0.10)) continue;   // real two-sided quote only
      const d = Math.abs(k.end_period_ts - mid);
      if (d < bestD) { bestD = d; best = { bid, ask }; }
    }
    if (!best) { noQuote++; continue; }
    obs.push({ series: m.series, event: m.event, p: (best.bid + best.ask) / 2, halfSpread: (best.ask - best.bid) / 2, y: m.result });
  }
  console.log(`\n\n  usable observations: ${obs.length} (${noQuote} markets had no tradeable quote at midpoint — junk rungs, excluded by rule)`);
  console.log(`  events: ${new Set(obs.map(o => o.event)).size} · window: recent settled history per series\n`);

  if (obs.length < 100) { console.log("  Too few observations for calibration — widen MAX_MARKETS or series list.\n"); return; }

  // 3 — calibration by price bucket, event-clustered
  const EDGES = [0, .05, .10, .20, .30, .40, .50, .60, .70, .80, .90, .95, 1.0001];
  const fee = (p) => 0.07 * p * (1 - p);
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  console.log("  bucket      n     events  implied  realized    gap    clust-t   fee    ½sprd   NET edge   verdict");
  console.log("  " + "-".repeat(102));
  const rows = [];
  for (let b = 0; b < EDGES.length - 1; b++) {
    const inB = obs.filter(o => o.p >= EDGES[b] && o.p < EDGES[b + 1]);
    if (inB.length < 30) continue;
    const imp = inB.reduce((s, o) => s + o.p, 0) / inB.length;
    const real = inB.reduce((s, o) => s + o.y, 0) / inB.length;
    const gap = real - imp;
    // cluster-robust SE by event
    const byEv = {}; for (const o of inB) (byEv[o.event] = byEv[o.event] || []).push(o.y - o.p);
    const sums = Object.values(byEv).map(a => a.reduce((s, v) => s + v, 0));
    const se = Math.sqrt(sums.reduce((s, v) => s + v * v, 0)) / inB.length;
    const t = se > 0 ? gap / se : 0;
    const f = fee(imp), hs = med(inB.map(o => o.halfSpread));
    const net = Math.abs(gap) - f - hs;
    const exploitable = Math.abs(t) >= 1.96 && net > 0;
    const label = `${(EDGES[b] * 100).toFixed(0)}–${(EDGES[b + 1] * 100).toFixed(0)}¢`;
    rows.push({ label, exploitable, gap, t, net });
    console.log("  " + label.padEnd(10) + String(inB.length).padStart(5) + String(Object.keys(byEv).length).padStart(9) + "   " +
      (imp * 100).toFixed(1).padStart(5) + "%" + (real * 100).toFixed(1).padStart(9) + "%" +
      ((gap >= 0 ? "+" : "") + (gap * 100).toFixed(1) + "¢").padStart(8) + t.toFixed(2).padStart(9) +
      ("" + (f * 100).toFixed(1) + "¢").padStart(7) + ("" + (hs * 100).toFixed(1) + "¢").padStart(8) +
      ((net >= 0 ? "+" : "") + (net * 100).toFixed(1) + "¢").padStart(9) + "    " +
      (exploitable ? "★ EXPLOITABLE" : Math.abs(t) >= 1.96 ? "bias real, inside costs" : "noise"));
  }

  // longshot summary
  const lo = obs.filter(o => o.p < 0.10), hi = obs.filter(o => o.p > 0.90);
  const f2 = (a) => a.length ? (a.reduce((s, o) => s + o.y, 0) / a.length * 100).toFixed(1) : "—";
  const i2 = (a) => a.length ? (a.reduce((s, o) => s + o.p, 0) / a.length * 100).toFixed(1) : "—";
  console.log(`\n  LONGSHOTS (<10¢): priced ${i2(lo)}% → resolved YES ${f2(lo)}%  (n ${lo.length})`);
  console.log(`  FAVORITES (>90¢): priced ${i2(hi)}% → resolved YES ${f2(hi)}%  (n ${hi.length})`);

  console.log("\n  ── PRE-REGISTERED VERDICT ──");
  const winners = rows.filter(r => r.exploitable);
  if (winners.length) {
    console.log(`    ★ ${winners.length} bucket(s) clear BOTH bars (clustered CI excludes zero AND |gap| > fee + ½spread):`);
    for (const w of winners) console.log(`      • ${w.label}: gap ${(w.gap * 100).toFixed(1)}¢, t ${w.t.toFixed(2)}, net edge ${(w.net * 100).toFixed(1)}¢ per contract`);
    console.log("    Candidates only → next step is a small forward paper test on live markets, not size.");
  } else {
    console.log("    ✕ No bucket is exploitable net of costs in these series. Any visible bias is inside");
    console.log("      the fee + spread. The pre-stated prior held.");
  }
  console.log("");
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
