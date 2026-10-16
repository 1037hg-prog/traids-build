#!/usr/bin/env node
/**
 * TRAIDS — Crypto Perpetual Funding-Rate Carry (a STRUCTURAL edge, not a price prediction)
 *
 * Perps pay "funding" every 8h to anchor to spot: when funding is positive (the usual case in
 * bull markets) leveraged LONGS pay SHORTS. The carry trade is DELTA-NEUTRAL — long spot, short
 * the perp — so you collect the funding with (almost) no directional exposure. This backtests
 * that yield on real OKX funding history across the major perps:
 *
 *   • ALWAYS-ON  — hold the neutral carry continuously; collect funding when positive, PAY when
 *     negative (the bear-market bleed). One round-trip fee, amortized.
 *   • LONG-FUNDING-ONLY — only hold when the (known, set-ahead) funding is positive; sit out when
 *     negative. Avoids the bleed, but pays a fee every time you flip in/out.
 *
 * Reports annualized carry, vol, Sharpe, max drawdown, and % of periods with positive funding.
 *
 * HONEST CAVEATS — this is a SHORT-VOLATILITY / carry premium, NOT alpha. It is REAL but: (1) it
 * has COMPRESSED as the trade got crowded; (2) it pays you pennies until a deleveraging cascade
 * makes funding go deeply negative (the tail that bites); (3) this models only the GROSS funding
 * yield — it ignores exchange/counterparty risk (see FTX), perp liquidation risk on the short leg,
 * spot-borrow cost if leveraged, and slippage on the two legs. Real net is LOWER than shown.
 *
 * Usage:  node backend/crypto-funding-carry-test.js     (no keys; OKX public data)
 */
const INSTS = ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP", "XRP-USDT-SWAP", "DOGE-USDT-SWAP", "LTC-USDT-SWAP"];
const PAGES = parseInt(process.env.PAGES || "34");          // 34×100×8h ≈ 1130 days ≈ 3.1y
const FLIP_FEE = parseFloat(process.env.FLIP_FEE || "0.0010");   // round-trip cost (both legs) when entering/exiting, 10bps
const PERIODS_YR = 365 * 3;                                 // funding every 8h
const sleep = ms => new Promise(r => setTimeout(r, ms));

let skippedRows = 0;
async function fetchFunding(instId) {
  const all = []; let after = "";
  for (let p = 0; p < PAGES; p++) {
    const url = `https://www.okx.com/api/v5/public/funding-rate-history?instId=${instId}&limit=100${after ? `&after=${after}` : ""}`;
    let j; try { const r = await fetch(url); if (!r.ok) break; j = await r.json(); } catch { break; }
    const data = j.data || []; if (!data.length) break;
    /**
     * D22 FIX (2026-08-06). This read `+d.realizedRate ?? +d.fundingRate`. Unary + binds tighter
     * than ??, so it parsed as `(+d.realizedRate) ?? (+d.fundingRate)` — and ?? only catches
     * null/undefined, while `+undefined` is NaN, which is neither. The fallback could therefore
     * NEVER fire, and a missing realizedRate silently produced NaN instead of the documented
     * backup field. Latent only: a live probe confirmed OKX returns realizedRate on every row,
     * so no published result was corrupted. Fixed anyway — a fallback that cannot fire is not a
     * fallback, and the next schema change would have poisoned the series silently.
     */
    for (const d of data) {
      const rate = Number.isFinite(+d.realizedRate) ? +d.realizedRate
        : Number.isFinite(+d.fundingRate) ? +d.fundingRate : null;
      if (rate === null) { skippedRows++; continue; }
      all.push({ t: +d.fundingTime, rate });
    }
    after = data[data.length - 1].fundingTime;
    await sleep(120);
  }
  return all.sort((a, b) => a.t - b.t);
}
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
function perf(rets) { const m = mean(rets), v = sd(rets); let eq = 1, pk = 1, dd = 0; for (const r of rets) { eq *= 1 + r; pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1); } return { ann: m * PERIODS_YR, vol: v * Math.sqrt(PERIODS_YR), sharpe: v > 0 ? m / v * Math.sqrt(PERIODS_YR) : 0, maxDD: dd, total: eq - 1 }; }

(async () => {
  /**
   * D28 FIX (2026-08-06). The header used to print `~${Math.round(PAGES*100/3)}d` — a window
   * computed from a CONSTANT, not from the response. It advertised ~1133 days regardless of what
   * OKX actually returned, and OKX now serves 275 funding periods (~91 days) per instrument. So
   * test #22 was graded PREMIUM on 2026-06-29 against a claimed 3.1-year window while running on
   * roughly 0.25 years. The window is now MEASURED from the returned timestamps and printed
   * after the fetch, and a window far short of the request is called out rather than absorbed.
   */
  console.log(`\n  TRAIDS — Crypto Funding-Carry (delta-neutral, OKX) · ${INSTS.length} perps · fees ${(FLIP_FEE * 10000).toFixed(0)}bps/flip\n`);
  process.stdout.write("  fetching funding history");
  const data = {}; for (const i of INSTS) { data[i] = await fetchFunding(i); process.stdout.write(`  ${i.split("-")[0]}(${data[i].length})`); }
  console.log("\n");

  const spans = INSTS.map(i => {
    const s = data[i]; if (!s || s.length < 2) return null;
    return { inst: i, n: s.length, days: (s[s.length - 1].t - s[0].t) / 86400000, from: new Date(s[0].t).toISOString().slice(0, 10), to: new Date(s[s.length - 1].t).toISOString().slice(0, 10) };
  }).filter(Boolean);
  const requestedDays = Math.round(PAGES * 100 / 3);
  const shortest = spans.length ? spans.reduce((a, b) => (a.days < b.days ? a : b)) : null;
  if (shortest) {
    console.log(`  MEASURED WINDOW (from the data, not the request):`);
    for (const s of spans) console.log(`    ${s.inst.split("-")[0].padEnd(6)} ${String(s.n).padStart(5)} periods · ${s.days.toFixed(0)}d · ${s.from} -> ${s.to}`);
    console.log(`    requested ~${requestedDays}d · shortest actual ${shortest.days.toFixed(0)}d`);
    if (shortest.days < requestedDays * 0.5) {
      console.log(`    *** THE ACTUAL WINDOW IS ${(100 * shortest.days / requestedDays).toFixed(0)}% OF WHAT WAS REQUESTED. Any annualized figure below`);
      console.log(`    *** rests on ${(shortest.days / 365).toFixed(2)} years, NOT ${(requestedDays / 365).toFixed(1)}. Treat Sharpe and maxDD accordingly.`);
    }
  }
  if (skippedRows) console.log(`  ${skippedRows} row(s) skipped — neither realizedRate nor fundingRate parsed`);
  console.log("");

  const pad = (s, n) => String(s).padEnd(n);
  console.log("  ALWAYS-ON carry (collect + pay funding; one round-trip fee):");
  console.log("    " + pad("perp", 8) + pad("ann carry", 11) + pad("vol", 9) + pad("Sharpe", 9) + pad("maxDD", 10) + "% periods +funding");
  const allOnSeries = [];
  for (const i of INSTS) {
    const rates = data[i].map(x => x.rate); if (rates.length < 50) { console.log("    " + pad(i.split("-")[0], 8) + "too little data"); continue; }
    const rets = rates.slice(); rets[0] -= FLIP_FEE; rets[rets.length - 1] -= FLIP_FEE;   // one round trip
    const p = perf(rets); const pos = rates.filter(r => r > 0).length / rates.length * 100;
    allOnSeries.push(rates);
    console.log("    " + pad(i.split("-")[0], 8) + pad((p.ann * 100).toFixed(1) + "%", 11) + pad((p.vol * 100).toFixed(1) + "%", 9) + pad(p.sharpe.toFixed(2), 9) + pad((p.maxDD * 100).toFixed(1) + "%", 10) + pos.toFixed(0) + "%");
  }

  console.log("\n  LONG-FUNDING-ONLY (hold only when funding > 0; fee each flip):");
  console.log("    " + pad("perp", 8) + pad("ann carry", 11) + pad("Sharpe", 9) + pad("maxDD", 10) + "flips");
  for (const i of INSTS) {
    const rates = data[i].map(x => x.rate); if (rates.length < 50) continue;
    let prevIn = false, flips = 0; const rets = [];
    for (const r of rates) { const inPos = r > 0; let pr = inPos ? r : 0; if (inPos !== prevIn) { pr -= FLIP_FEE; flips++; prevIn = inPos; } rets.push(pr); }
    const p = perf(rets);
    console.log("    " + pad(i.split("-")[0], 8) + pad((p.ann * 100).toFixed(1) + "%", 11) + pad(p.sharpe.toFixed(2), 9) + pad((p.maxDD * 100).toFixed(1) + "%", 10) + flips);
  }

  // equal-weight basket (always-on), aligned by index over the shortest series
  const minLen = Math.min(...allOnSeries.map(s => s.length));
  if (minLen > 50) {
    const basket = []; for (let k = 0; k < minLen; k++) basket.push(mean(allOnSeries.map(s => s[s.length - minLen + k])));
    const p = perf(basket);
    console.log(`\n  EQUAL-WEIGHT BASKET (always-on): ann ${(p.ann * 100).toFixed(1)}% · vol ${(p.vol * 100).toFixed(1)}% · Sharpe ${p.sharpe.toFixed(2)} · maxDD ${(p.maxDD * 100).toFixed(1)}%`);

    /**
     * D29 FIX (2026-08-06) — SAY WHAT THIS SHARPE ACTUALLY MEASURES.
     *
     * This line once read "Sharpe 24.75, vol 0.1%, maxDD -0.1%" and was allowed to stand. A
     * Sharpe of 25 is not a result, it is a symptom. The cause: this models the FUNDING ACCRUAL
     * ONLY. It never prices the spot leg or the spot-perp BASIS. A real delta-neutral carry is
     * long spot / short perp and the basis moves every day; modelling only the accrual produces
     * a near-deterministic series whose volatility is the volatility of the funding RATE rather
     * than of the POSITION. Dividing a real yield by a fictional volatility manufactures any
     * Sharpe you like.
     *
     * The project's own implied-Sharpe tripwire says anything above ~1.5 on public data is a
     * defect signal, not a discovery. So the number is now printed WITH that verdict attached
     * rather than left for a reader to mistake for an edge.
     */
    if (p.sharpe > 1.5) {
      console.log(`  *** THAT SHARPE IS NOT REAL. This models the FUNDING ACCRUAL ONLY — it never prices the`);
      console.log(`  *** spot leg or the spot-perp basis, so the denominator is the volatility of the funding`);
      console.log(`  *** RATE, not of the POSITION. A true carry book carries basis risk this series does not`);
      console.log(`  *** contain. Per significanceBar, an implied Sharpe above ~1.5 on public data is a DEFECT`);
      console.log(`  *** SIGNAL. Treat the ANN CARRY as the finding; discard the Sharpe, vol and maxDD entirely`);
      console.log(`  *** until both legs are priced.`);
    }
  }

  console.log(`\n  READ: a positive, steady carry with ugly NEGATIVE-funding drawdowns is the real "picking up`);
  console.log(`  pennies in front of the steamroller" signature. Diversifying across perps smooths it.`);
  console.log(`  This is GROSS ACCRUAL — subtract real fees, slippage, borrow, and the un-modeled tail`);
  console.log(`  (exchange blowups, liquidation, basis moves) → the net is materially lower.`);
  console.log(`  NOT ADJUDICABLE as an edge while only one leg is modelled.\n`);
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
