#!/usr/bin/env node
/**
 * TRAIDS — THE PORTFOLIO AT A GIVEN SIZE, DAY BY DAY
 *
 * Takes the construction from portfolio-build.js (sleeve + #51 short-vol at risk-parity
 * weights, 100% gross) and shows what it actually looks like to hold — in dollars, at the
 * frequency you would experience it.
 *
 * WHY THE AVERAGE DAY IS THE LEAST USEFUL NUMBER. A 10%/yr portfolio at 15% volatility earns
 * about $106/day on $250k and moves about $2,400 on a typical day. The mean is roughly a
 * twentieth of the noise, which means the daily P&L tells you almost nothing about whether the
 * strategy is working — you would need months before the drift is visible above the wobble.
 * Reporting "$106/day" without that ratio is how a person ends up checking a screen every
 * afternoon and drawing conclusions from noise.
 *
 * So this reports the distribution, not the average: what a normal day looks like, what a bad
 * one looks like, how often you are underwater, and how long the worst stretch lasted.
 *
 * Usage:  node backend/portfolio-daily.js [capital]      default 250000
 */
const fs = require("fs"), path = require("path");
const MKT = "http://localhost:3002/api/yahoo";
const CAPITAL = Number(process.argv[2]) || 250000;
const TLH_LO = 0.0070, TLH_HI = 0.0103;          // measured, no market risk

const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const usd = (v) => (v < 0 ? "-" : "") + "$" + Math.abs(Math.round(v)).toLocaleString();
const pct = (v, d = 2) => (v >= 0 ? "+" : "") + (100 * v).toFixed(d) + "%";
const g = async (s) => { const r = await fetch(`${MKT}/${encodeURIComponent(s)}/history?days=3000&interval=1d`, { signal: AbortSignal.timeout(120000) }); return ((await r.json()).bars || []).filter(b => Number.isFinite(b.close)); };

(async () => {
  console.log(`\n  TRAIDS — PORTFOLIO AT ${usd(CAPITAL)}, DAY BY DAY\n`);
  const [spy, tlt, dbmf, vixy, vix, vix3m] = await Promise.all([g("SPY"), g("TLT"), g("DBMF"), g("VIXY"), g("^VIX"), g("^VIX3M")]);
  const M = (a) => new Map(a.map(b => [b.date, b.close]));
  const S = M(spy), T = M(tlt), DB = M(dbmf), Y = M(vixy), V = M(vix), V3 = M(vix3m);
  const dates = dbmf.map(b => b.date).filter(d => S.has(d) && T.has(d) && Y.has(d) && V.has(d) && V3.has(d)).sort();

  const sleeve = [], shortVol = [], days = [];
  for (let i = 1; i < dates.length; i++) {
    const p = dates[i - 1], d = dates[i];
    sleeve.push(0.7 * (0.6 * (S.get(d) / S.get(p) - 1) + 0.4 * (T.get(d) / T.get(p) - 1)) + 0.3 * (DB.get(d) / DB.get(p) - 1));
    shortVol.push((V3.get(p) / V.get(p)) > 1.00 ? -(Y.get(d) / Y.get(p) - 1) - 0.06 / 252 : 0);
    days.push(d);
  }
  const volA = sd(sleeve) * Math.sqrt(252), volB = sd(shortVol) * Math.sqrt(252);
  const wA = (1 / volA) / ((1 / volA) + (1 / volB)), wB = 1 - wA;
  const r = sleeve.map((x, i) => wA * x + wB * shortVol[i]);
  const tlhDaily = ((TLH_LO + TLH_HI) / 2) / 252;

  /**
   * D33 FIX (2026-08-06) — DRAWDOWN IS MEASURED ON MARKET RETURNS ONLY.
   *
   * The tax-loss-harvesting accrual used to be added into the DAILY return series before the
   * drawdown was computed, so a steady synthetic yield cushioned every peak-to-trough. Reported
   * maxDD was -19.16%; the same construction without the accrual is -19.80%.
   *
   * That is wrong in kind, not just in size. TLH is a TAX benefit realised at filing — it does
   * not arrive as a daily cash return and it cannot defend a portfolio during a drawdown. Baking
   * it into the equity path makes the strategy look structurally less risky than it is, which is
   * the flattering direction.
   *
   * So the equity path is built from market returns alone, and TLH is reported separately as an
   * additive annual yield. Both paths are computed here so the size of the distortion is visible
   * rather than asserted.
   */
  let eq = CAPITAL, peak = CAPITAL, maxDD = 0, ddStart = null, worstRun = 0, run = 0;
  const dollars = [];
  for (let i = 0; i < r.length; i++) {
    const pnl = eq * r[i];                       // MARKET ONLY — no TLH in the drawdown path
    dollars.push(pnl);
    eq += pnl;
    if (eq >= peak) { peak = eq; run = 0; } else { run++; worstRun = Math.max(worstRun, run); }
    maxDD = Math.max(maxDD, (peak - eq) / peak);
  }
  // the old (flattered) path, kept only to state the distortion
  let eqT = CAPITAL, peakT = CAPITAL, maxDDwithTLH = 0;
  for (let i = 0; i < r.length; i++) {
    eqT += eqT * (r[i] + tlhDaily);
    if (eqT >= peakT) peakT = eqT;
    maxDDwithTLH = Math.max(maxDDwithTLH, (peakT - eqT) / peakT);
  }
  const tlhAnnual = tlhDaily * 252;
  const yrs = r.length / 252;
  const cagr = Math.pow(eq / CAPITAL, 1 / yrs) - 1;

  console.log(`  window ${days[0]} → ${days[days.length - 1]} · ${days.length} sessions (${yrs.toFixed(1)} years)`);
  console.log(`  weights: sleeve ${(100 * wA).toFixed(0)}% · short-vol ${(100 * wB).toFixed(0)}% · plus TLH at ${pct((TLH_LO + TLH_HI) / 2)}/yr\n`);

  const sorted = [...dollars].sort((a, b) => a - b);
  const q = (p) => sorted[Math.floor(p * (sorted.length - 1))];
  console.log(`  ══ THE DAILY, AS YOU WOULD ACTUALLY EXPERIENCE IT ══`);
  console.log(`    average day            ${usd(mean(dollars)).padStart(9)}`);
  console.log(`    median day             ${usd(q(0.50)).padStart(9)}`);
  console.log(`    typical swing (1 sd)   ${usd(sd(dollars)).padStart(9)}   <- ${(sd(dollars) / Math.abs(mean(dollars))).toFixed(0)}x the average day`);
  console.log(`    days positive          ${(100 * dollars.filter(x => x > 0).length / dollars.length).toFixed(1)}%`);
  console.log("");
  console.log(`    a bad day (5th pct)    ${usd(q(0.05)).padStart(9)}`);
  console.log(`    a good day (95th pct)  ${usd(q(0.95)).padStart(9)}`);
  console.log(`    worst day observed     ${usd(sorted[0]).padStart(9)}`);
  console.log(`    best day observed      ${usd(sorted[sorted.length - 1]).padStart(9)}`);

  console.log(`\n  ══ WHAT IT ADDS UP TO ══`);
  console.log(`    per year               ${usd(CAPITAL * (cagr)).padStart(9)}   (${pct(cagr)})`);
  console.log(`    per month              ${usd(CAPITAL * cagr / 12).padStart(9)}`);
  console.log(`    per day (252)          ${usd(CAPITAL * cagr / 252).padStart(9)}`);
  console.log(`    ending equity          ${usd(eq).padStart(9)}   from ${usd(CAPITAL)}`);

  console.log(`\n  ══ THE DRAWDOWN, IN DOLLARS ══`);
  console.log(`    worst peak-to-trough   ${usd(-maxDD * peak).padStart(9)}   (${pct(-maxDD)})   <- MARKET ONLY, no TLH`);
  console.log(`      (with the TLH accrual folded in it would read ${pct(-maxDDwithTLH)} — ${pct(maxDDwithTLH - maxDD)} flattered.`);
  console.log(`       TLH is a tax benefit realised at filing, not daily cash, and cannot defend a drawdown.`);
  console.log(`       It is reported separately as +${pct(tlhAnnual)}/yr and deliberately excluded from this line. D33.)`);
  console.log(`    longest underwater     ${worstRun} sessions (~${(worstRun / 21).toFixed(1)} months)`);
  console.log(`    -> on the worst stretch you were down ${usd(maxDD * peak)} and it took ${(worstRun / 21).toFixed(1)} months to see a new high.`);

  // monthly view — the frequency at which the drift is actually visible
  const byMonth = new Map();
  days.forEach((d, i) => { const k = d.slice(0, 7); byMonth.set(k, (byMonth.get(k) || 0) + dollars[i]); });
  const months = [...byMonth.values()];
  console.log(`\n  ══ MONTHLY — the shortest window where the drift beats the noise ══`);
  console.log(`    average month          ${usd(mean(months)).padStart(9)}`);
  console.log(`    monthly swing (1 sd)   ${usd(sd(months)).padStart(9)}   <- ${(sd(months) / Math.abs(mean(months))).toFixed(1)}x the average month`);
  console.log(`    months positive        ${(100 * months.filter(x => x > 0).length / months.length).toFixed(0)}%  (${months.filter(x => x > 0).length}/${months.length})`);
  console.log(`    worst month            ${usd(Math.min(...months)).padStart(9)}`);

  console.log(`\n  ══ HOW LONG BEFORE THE DAILY MEANS ANYTHING ══`);
  const dailySharpe = mean(dollars) / sd(dollars);
  for (const t of [1, 2]) {
    const n = Math.ceil(Math.pow(t / dailySharpe, 2));
    console.log(`    to distinguish the drift from zero at t=${t}: ${n.toLocaleString()} sessions (~${(n / 252).toFixed(1)} years)`);
  }
  console.log(`    -> checking the daily P&L cannot tell you whether this is working. Only the`);
  console.log(`       drawdown behaving as expected can, and that is a monthly question at best.\n`);

  fs.writeFileSync(path.join(__dirname, "data", "portfolio-daily.json"), JSON.stringify({
    generated: new Date().toISOString(), capital: CAPITAL, weights: { sleeve: wA, shortVol: wB },
    window: [days[0], days[days.length - 1]], sessions: days.length, years: yrs,
    cagr, endingEquity: eq, maxDD, longestUnderwaterSessions: worstRun,
    daily: { mean: mean(dollars), sd: sd(dollars), median: q(0.50), p05: q(0.05), p95: q(0.95), worst: sorted[0], best: sorted[sorted.length - 1], pctPositive: dollars.filter(x => x > 0).length / dollars.length },
    monthly: { mean: mean(months), sd: sd(months), worst: Math.min(...months), pctPositive: months.filter(x => x > 0).length / months.length },
    caveats: [
      "DBMF exists only since 2019-05; this window is roughly one cycle. CORRECTED 2026-07-29 (D32): the prior wording claimed it excluded the March 2020 crash — it does not, the window opens 2019-05-09 and contains Feb-Apr 2020 in full.",
      "The short-vol leg is an ETP proxy (short VIXY) with borrow charged flat at 6%, which spikes in stress.",
      "TLH is added as a constant daily accrual — it is a tax effect, not a market return, and it does not diversify.",
      "The portfolio's own t is ~1.59 over this window. These dollars are an estimate from a sample that cannot yet distinguish Sharpe 0.65 from 0.4.",
    ],
  }, null, 1));
  console.log(`  written: backend/data/portfolio-daily.json\n`);
})();
