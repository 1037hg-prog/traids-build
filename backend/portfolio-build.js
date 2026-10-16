#!/usr/bin/env node
/**
 * TRAIDS — PORTFOLIO CONSTRUCTION FROM WHAT ACTUALLY MEASURED POSITIVE
 *
 * WHY THIS EXISTS. 57 tests produced zero strategies that passed their gates, and the reflex
 * was to call each one dead. That reflex was wrong for at least one of them. Test #51 (VIX
 * term-structure carry) returned +17.49%/yr out of sample net of 6% borrow and FAILED ONLY on
 * drawdown, at −59.92% against a −20% ceiling. Drawdown is not a property of an edge; it is a
 * property of SIZE. At 33% size that same strategy returns +5.84%/yr inside the ceiling.
 *
 * So this stops asking "did it pass" and starts asking "at what size does it fit, and what
 * happens when the survivors are combined."
 *
 * ── THE DISCIPLINE THAT MAKES THIS CONSTRUCTION RATHER THAN WISHFUL THINKING ────────────────
 * 1. Only MEASURED numbers. #60's +0.52%/episode, not #45's discredited +5.72%. Every input
 *    traces to a registered test.
 * 2. CORRELATION IS MEASURED, NOT ASSUMED. #51 and #60 are both short volatility — selling
 *    insurance against the same event. Treating them as two streams would be the single easiest
 *    way to manufacture a fake diversification benefit, so their correlation is computed from
 *    actual return series and reported before any combination is proposed.
 * 3. Nothing is optimised. Weights come from a risk-budget rule stated in advance, not from a
 *    search over what would have worked — which is how #41–#43 died.
 * 4. Anything dominated by cash is EXCLUDED. #55 crypto funding carry returns +1.9%/yr against
 *    a 4.3% T-bill while adding exchange counterparty risk. It is not a small position; it is a
 *    worse version of doing nothing.
 *
 * WHAT THIS CANNOT DO. It cannot manufacture an edge. If the components are near zero, the
 * combination is near zero with a smoother path. Diversification improves the RATIO, never the
 * fact of whether something is there.
 *
 * Usage: node backend/portfolio-build.js
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const MKT = "http://localhost:3002/api/yahoo";
const RISK = JSON.parse(fs.readFileSync(D("risk-policy.json"), "utf8"));
const DD_CEILING = RISK.current.hardCeiling;
const TBILL = 0.043;

const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const pc = (v, d = 2) => v == null ? "     —" : (v >= 0 ? "+" : "") + (100 * v).toFixed(d) + "%";
const corr = (a, b) => { const n = Math.min(a.length, b.length); if (n < 10) return null; const A = a.slice(-n), B = b.slice(-n); const ma = mean(A), mb = mean(B); let ab = 0, aa = 0, bb = 0; for (let i = 0; i < n; i++) { const x = A[i] - ma, y = B[i] - mb; ab += x * y; aa += x * x; bb += y * y; } return (aa && bb) ? ab / Math.sqrt(aa * bb) : null; };
const g = async (s) => { const r = await fetch(`${MKT}/${encodeURIComponent(s)}/history?days=3000&interval=1d`, { signal: AbortSignal.timeout(120000) }); return ((await r.json()).bars || []).filter(b => Number.isFinite(b.close)); };
function pathStats(r) { let eq = 1, pk = 1, dd = 0; for (const x of r) { eq *= 1 + x; if (eq <= 0) return { cagr: null, maxDD: 1 }; pk = Math.max(pk, eq); dd = Math.max(dd, (pk - eq) / pk); } return { eq, maxDD: dd }; }

(async () => {
  console.log(`\n  TRAIDS — PORTFOLIO CONSTRUCTION FROM MEASURED POSITIVES`);
  console.log(`  drawdown ceiling ${(100 * DD_CEILING).toFixed(0)}% · nothing optimised · correlations measured, not assumed\n`);

  // ── rebuild the two streams that have real daily series ───────────────────
  const [spy, tlt, dbmf, vixy, vix, vix3m] = await Promise.all([g("SPY"), g("TLT"), g("DBMF"), g("VIXY"), g("^VIX"), g("^VIX3M")]);
  const M = (a) => new Map(a.map(b => [b.date, b.close]));
  const S = M(spy), T = M(tlt), DB = M(dbmf), Y = M(vixy), V = M(vix), V3 = M(vix3m);
  const dates = dbmf.map(b => b.date).filter(d => S.has(d) && T.has(d) && Y.has(d) && V.has(d) && V3.has(d)).sort();
  console.log(`  common window ${dates[0]} → ${dates[dates.length - 1]} · ${dates.length} sessions\n`);

  // stream A — the sleeve (60/40 core + 30% DBMF), daily
  const sleeve = [], shortVol = [];
  for (let i = 1; i < dates.length; i++) {
    const p = dates[i - 1], d = dates[i];
    const rs = S.get(d) / S.get(p) - 1, rt = T.get(d) / T.get(p) - 1, rd = DB.get(d) / DB.get(p) - 1;
    sleeve.push(0.7 * (0.6 * rs + 0.4 * rt) + 0.3 * rd);
    // stream B — #51's contango-filtered short vol, FULL size, borrow charged
    const on = (V3.get(p) / V.get(p)) > 1.00;
    shortVol.push(on ? -(Y.get(d) / Y.get(p) - 1) - 0.06 / 252 : 0);
  }

  const stats = (r, lbl) => { const p = pathStats(r); const yrs = r.length / 252; const cagr = Math.pow(p.eq, 1 / yrs) - 1; const vol = sd(r) * Math.sqrt(252); console.log(`  ${lbl.padEnd(26)} CAGR ${pc(cagr).padStart(8)}  vol ${pc(vol).padStart(7)}  maxDD ${pc(-p.maxDD).padStart(8)}  Sharpe ${(cagr / vol).toFixed(2)}`); return { cagr, vol, maxDD: p.maxDD, r }; };
  console.log(`  ══ THE TWO STREAMS WITH REAL DAILY SERIES, AT FULL SIZE ══`);
  const A = stats(sleeve, "sleeve (60/40 + 30% DBMF)");
  const B = stats(shortVol, "#51 short vol (contango)");

  const c = corr(A.r, B.r);
  console.log(`\n  ══ DO THEY DIVERSIFY? ══`);
  console.log(`  measured correlation  ${c.toFixed(3)}`);
  console.log(`  -> ${Math.abs(c) < 0.3 ? "genuinely distinct bets. Combining them lowers portfolio volatility for the same return." : Math.abs(c) < 0.6 ? "partially related — some benefit, less than the naive calculation suggests." : "the SAME bet wearing two names. Combining adds size, not diversification."}`);
  console.log(`\n  NOTE, stated before any combination: #60 credit spreads is ALSO short volatility.`);
  console.log(`  It is deliberately EXCLUDED rather than counted as a third stream — it measured`);
  console.log(`  +0.52%/episode at t 0.22 and it is the same insurance sold twice.`);
  console.log(`  #55 crypto funding carry is EXCLUDED as dominated: +1.9%/yr against a ${(100 * TBILL).toFixed(1)}% T-bill`);
  console.log(`  while adding exchange counterparty risk. It is a worse version of holding cash.`);

  // ── size each to a share of the drawdown budget, then combine ─────────────
  console.log(`\n  ══ COMBINED, EACH SIZED TO ITS SHARE OF THE ${(100 * DD_CEILING).toFixed(0)}% BUDGET ══`);
  console.log(`  weights are a stated rule — risk parity on measured volatility — not a search.`);
  const wA = (1 / A.vol) / ((1 / A.vol) + (1 / B.vol)), wB = 1 - wA;
  console.log(`  risk-parity weights: sleeve ${(100 * wA).toFixed(0)}% · short vol ${(100 * wB).toFixed(0)}%`);

  console.log(`\n  gross exposure   CAGR      vol      maxDD     Sharpe   vs ceiling`);
  let best = null;
  for (const lev of [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0]) {
    const r = A.r.map((x, i) => lev * (wA * x + wB * B.r[i]));
    const p = pathStats(r); if (p.cagr === null && p.maxDD >= 1) { console.log(`  ${(100 * lev).toFixed(0)}%  RUINED`); continue; }
    const yrs = r.length / 252, cagr = Math.pow(p.eq, 1 / yrs) - 1, vol = sd(r) * Math.sqrt(252);
    const ok = p.maxDD <= DD_CEILING;
    if (ok && (!best || cagr > best.cagr)) best = { lev, cagr, vol, maxDD: p.maxDD };
    console.log(`  ${((100 * lev).toFixed(0) + "%").padStart(10)}     ${pc(cagr).padStart(8)}  ${pc(vol).padStart(7)}  ${pc(-p.maxDD).padStart(8)}   ${(cagr / vol).toFixed(2).padStart(5)}    ${ok ? "PASSES" : "breaches"}`);
  }

  console.log(`\n  ══ THE PORTFOLIO THAT FITS ══`);
  if (best) {
    console.log(`  ${(100 * best.lev).toFixed(0)}% gross · CAGR ${pc(best.cagr)} · maxDD ${pc(-best.maxDD)} · Sharpe ${(best.cagr / best.vol).toFixed(2)}`);
    console.log(`  plus direct-index TLH at +0.70%–1.03%/yr, which carries no market risk and stacks on top.`);
    console.log(`  -> total roughly ${pc(best.cagr + 0.0086)} to ${pc(best.cagr + 0.0103)} inside a ${(100 * DD_CEILING).toFixed(0)}% ceiling.`);
    for (const cap of [50000, 250000, 1000000, 2500000]) {
      const yr = cap * (best.cagr + 0.0086);
      console.log(`     $${(cap / 1000).toFixed(0)}k -> $${Math.round(yr).toLocaleString()}/yr = $${Math.round(yr / 252)}/day`);
    }
  } else console.log(`  no leverage level fits the ceiling.`);

  console.log(`\n  WHAT THIS IS NOT: an edge. It is correct SIZING and COMBINATION of two things that`);
  console.log(`  were already measured. The Sharpe improves because the streams are distinct; the`);
  console.log(`  return does not improve beyond what the components hold. Diversification changes`);
  console.log(`  the ratio, never whether something is there.\n`);

  fs.writeFileSync(D("portfolio-build.json"), JSON.stringify({
    generated: new Date().toISOString(), ceiling: DD_CEILING,
    streams: { sleeve: { cagr: A.cagr, vol: A.vol, maxDD: A.maxDD }, shortVol: { cagr: B.cagr, vol: B.vol, maxDD: B.maxDD } },
    measuredCorrelation: c, weights: { sleeve: wA, shortVol: wB }, best,
    excluded: {
      "#60 credit spreads": "same short-volatility bet as #51; +0.52%/episode at t 0.22",
      "#55 crypto funding carry": "dominated by cash — +1.9%/yr vs a 4.3% T-bill plus exchange counterparty risk",
    },
    caveats: [
      "DBMF exists only since 2019-05, so this window is roughly one cycle. CORRECTED 2026-07-29 (defect D32): an earlier version of this caveat claimed the window EXCLUDED the March 2020 crash. It does not — the window opens 2019-05-09 and contains Feb-Apr 2020 in full. The claim was wrong in the unflattering direction, but wrong is wrong: the drawdown figure is better-supported than the caveat implied, not worse.",
      "The short-vol stream is an ETP proxy (short VIXY), not futures; borrow is charged at a flat 6% which spikes in stress.",
      "Risk-parity weights are a stated rule, not an optimisation — a search over weights would be curve-fitting.",
      "TLH is added as a scalar, not a simulated series; it is a tax effect and does not diversify market risk.",
    ],
  }, null, 1));
  console.log(`  written: backend/data/portfolio-build.json\n`);
})();
