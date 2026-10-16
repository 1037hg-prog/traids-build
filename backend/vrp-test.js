#!/usr/bin/env node
/**
 * TEST #41 — S&P 500 VARIANCE RISK PREMIUM: is it HARVESTABLE, not just present?
 *
 * PRE-REGISTERED 2026-07-25, before any result of this script was examined. The exploratory
 * look that motivated it measured VIX minus subsequently-realised vol at +3.53 vol points mean,
 * 83.5% of days positive, with a −69 point cluster in February 2020. That the premium EXISTS is
 * not in question. This test asks the only question that matters: does harvesting it make money
 * net of costs at a size that survives its own worst episode.
 *
 * HYPOTHESIS
 *   Selling 21-session at-the-money index volatility earns a positive risk premium that
 *   survives transaction costs and, at a survivable position size, produces a better
 *   risk-adjusted return than holding cash.
 *
 * WHY IT MIGHT BE TRUE (written before testing, so it cannot be invented afterwards)
 *   Structural, not statistical. Investors persistently pay above expected value for downside
 *   protection — insurance demand, leverage aversion, and mandate-driven hedging all create
 *   price-insensitive buyers. That is a REASON a counterparty overpays, which is exactly what
 *   tests #39 and #40 lacked: a technical pattern has no counterparty who must lose.
 *
 * WHY IT MIGHT BE FALSE
 *   The premium is compensation for bearing crash risk, and compensation is not alpha. If the
 *   tail losses match the collected premium after realistic sizing, the trade is a fair bet
 *   with an ugly distribution, and 83.5% of days positive is precisely what a fair bet with
 *   negative skew looks like.
 *
 * PAYOFF MODEL — stated explicitly because "3.53 vol points" is not a return
 *   Short a delta-neutral ATM straddle, 21 sessions, priced at VIX. For an ATM option the
 *   Black-Scholes straddle premium is ≈ 2·S·σ·√T·φ(0) = 0.7979·S·σ·√T, and the payoff at
 *   expiry is |S_T − S_0|. So, as a fraction of notional:
 *       P&L% = 0.7979 · σ_implied · √T  −  |S_T/S_0 − 1|
 *   The premium leg uses VIX; the loss leg uses the ACTUAL terminal move, so real tails are
 *   felt rather than modelled. Sanity check: taking expectations of the loss leg under GBM
 *   gives 0.7979·σ_realised·√T, so E[P&L%] = 0.7979·√T·(σ_i − σ_r) — the vol-point premium,
 *   correctly scaled. This is an approximation of a real trade, not a real trade.
 *
 * VARIANT FAMILY — size 9, declared before running
 *   horizons {10, 21, 42 sessions} × entry rules {always, VIX above its trailing median,
 *   VIX above its trailing 75th percentile}. Percentiles use a 252-session TRAILING window so
 *   the rule is computable at decision time. Multiplicity-corrected two-sided bar for 9 cells:
 *   z = Φ⁻¹(1 − 0.025/9) ≈ 2.77.
 *
 * SAMPLE AND SPLIT
 *   ^VIX and ^GSPC daily, 2001-12 → present. IN-SAMPLE 2001–2015 (contains 2008).
 *   OUT-OF-SAMPLE 2016–2026 (contains February 2020). Chronological, split on a year boundary.
 *   The OOS deliberately holds the worst episode in the record: a rule fitted before COVID is
 *   tested through COVID.
 *
 * INFERENCE
 *   NON-OVERLAPPING windows only. Overlapping 21-session windows inflate the sample ~21× and
 *   would turn 294 real observations into 6,177 fake ones. Statistic: t on non-overlapping
 *   per-episode P&L. Benchmark: cash (zero). Reported net of a COST GRID rather than one
 *   assumed level.
 *
 * DECISION RULE — quoted verbatim at adjudication, fixed before any result was seen
 *   PASS  if, out of sample and net of the baseline 5%-of-premium cost, the primary cell
 *         (21 sessions, always-on) has t ≥ 2.77, Sharpe > 0.5, mean P&L > 0, AND its worst
 *         single episode loses less than 25% of the capital that must be posted to run it.
 *   FAIL  if OOS mean net P&L ≤ 0, or the worst episode exceeds 50% of posted capital.
 *   Otherwise NOT-ESTABLISHED — a real outcome, not a reason to keep testing.
 *
 * KILL-TESTS, to be run only on a PASS: cost escalation, drop 2020, drop 2008, halve and
 * double the size, and a straddle-approximation swap.
 *
 * Usage:  node backend/vrp-test.js
 */
const fs = require("fs");
const path = require("path");

const MKT = "http://localhost:3002/api/yahoo";
const DAYS = 9000;
const FAMILY = { horizons: [10, 21, 42], rules: ["always", "vix>median", "vix>p75"] };
const M = FAMILY.horizons.length * FAMILY.rules.length;      // 9
const Z_BAR = 2.77;                                          // Φ⁻¹(1 − 0.025/9)
const PRIMARY = { H: 21, rule: "always" };
const COST_GRID = [0, 0.02, 0.05, 0.10, 0.20];               // fraction of premium collected
const BASELINE_COST = 0.05;
const IS_END = "2015-12-31";
const PHI0 = 0.3989422804014327;
const STRADDLE_K = 2 * PHI0;                                 // 0.7979

const g = async (s) => {
  const r = await fetch(`${MKT}/${encodeURIComponent(s)}/history?days=${DAYS}&interval=1d`, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`${s} ${r.status}`);
  return (await r.json()).bars || [];
};
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const quant = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * p)))]; };

(async () => {
  console.log(`\n  TEST #41 — VARIANCE RISK PREMIUM: HARVESTABLE?`);
  console.log(`  pre-registered before any result · family of ${M} · corrected bar t ≥ ${Z_BAR}`);
  console.log(`  in-sample ≤ ${IS_END} (contains 2008) · out-of-sample after (contains Feb 2020)\n`);

  const [vix, spx] = await Promise.all([g("^VIX"), g("^GSPC")]);
  const px = new Map(spx.map(b => [b.date, b.close]));
  const dates = spx.map(b => b.date);
  const idx = new Map(dates.map((d, i) => [d, i]));
  const vixOn = new Map(vix.map(b => [b.date, b.close]));
  console.log(`  ^VIX ${vix.length} bars · ^GSPC ${spx.length} bars · ${dates[0]} → ${dates[dates.length - 1]}`);

  // trailing VIX percentiles, computable at decision time (252-session lookback, strictly past)
  const vixSeries = dates.map(d => vixOn.get(d)).map(v => Number.isFinite(v) ? v : null);
  const trailing = (i, p) => {
    const w = [];
    for (let k = Math.max(0, i - 252); k < i; k++) if (vixSeries[k] != null) w.push(vixSeries[k]);
    return w.length < 100 ? null : quant(w, p);
  };

  /** One non-overlapping episode: enter at i, settle H sessions later. */
  function episode(i, H) {
    const d = dates[i], s0 = px.get(d), sig = vixOn.get(d);
    if (!Number.isFinite(s0) || !Number.isFinite(sig) || i + H >= dates.length) return null;
    const sT = px.get(dates[i + H]);
    if (!Number.isFinite(sT)) return null;
    const T = H / 252;
    const premium = STRADDLE_K * (sig / 100) * Math.sqrt(T);      // fraction of notional
    const loss = Math.abs(sT / s0 - 1);
    return { date: d, year: +d.slice(0, 4), H, premium, loss, gross: premium - loss, vix: sig };
  }

  const cells = [];
  for (const H of FAMILY.horizons) {
    for (const rule of FAMILY.rules) {
      // NON-OVERLAPPING: step H sessions at a time. A skipped entry does not shift the grid,
      // so the calendar spacing of episodes is identical across rules and stays independent.
      const eps = [];
      for (let i = 252; i + H < dates.length; i += H) {
        const e = episode(i, H);
        if (!e) continue;
        if (rule === "vix>median") { const t = trailing(i, 0.5); if (t == null || e.vix <= t) continue; }
        if (rule === "vix>p75") { const t = trailing(i, 0.75); if (t == null || e.vix <= t) continue; }
        eps.push(e);
      }
      const score = (arr, cost) => {
        const r = arr.map(e => e.gross - cost * e.premium);
        const m = mean(r), s = sd(r);
        const t = (m != null && s && r.length > 2) ? m / (s / Math.sqrt(r.length)) : null;
        // Sharpe annualised by episodes-per-year, not by trading days
        const perYear = 252 / H;
        return { n: r.length, mean: m, sd: s, t, sharpe: (m != null && s) ? (m / s) * Math.sqrt(perYear) : null,
                 worst: r.length ? Math.min(...r) : null, best: r.length ? Math.max(...r) : null,
                 winPct: r.length ? 100 * r.filter(x => x > 0).length / r.length : null, rets: r };
      };
      const is = eps.filter(e => e.date <= IS_END), oos = eps.filter(e => e.date > IS_END);
      cells.push({ H, rule, label: `${H}d · ${rule}`, eps,
        isScore: score(is, BASELINE_COST), oosScore: score(oos, BASELINE_COST),
        costCurve: COST_GRID.map(c => ({ cost: c, ...score(oos, c) })) });
    }
  }

  const pc = (v) => v == null ? "     —" : (v * 100 >= 0 ? "+" : "") + (v * 100).toFixed(2) + "%";
  console.log(`\n  ══ FULL FAMILY — all ${M} cells, net of ${(BASELINE_COST * 100)}% of premium ══`);
  console.log(`  cell               n(IS)  IS mean   n(OOS)  OOS mean   OOS t   Sharpe   win%    worst`);
  console.log(`  ──────────────────────────────────────────────────────────────────────────────────────`);
  for (const c of cells) {
    const o = c.oosScore;
    console.log(`  ${c.label.padEnd(18)} ${String(c.isScore.n).padStart(5)}  ${pc(c.isScore.mean).padStart(8)}   ${String(o.n).padStart(5)}  ${pc(o.mean).padStart(8)}  ${(o.t == null ? "—" : o.t.toFixed(2)).padStart(6)}  ${(o.sharpe == null ? "—" : o.sharpe.toFixed(2)).padStart(6)}  ${(o.winPct == null ? "—" : o.winPct.toFixed(0) + "%").padStart(5)}  ${pc(o.worst).padStart(8)}`);
  }

  const prim = cells.find(c => c.H === PRIMARY.H && c.rule === PRIMARY.rule);
  const o = prim.oosScore;

  console.log(`\n  ══ PRIMARY CELL (${PRIMARY.H} sessions, ${PRIMARY.rule}) — cost sensitivity, out of sample ══`);
  console.log(`  cost (% of premium)   mean P&L    t      Sharpe    worst episode`);
  console.log(`  ─────────────────────────────────────────────────────────────────`);
  for (const cc of prim.costCurve)
    console.log(`  ${((cc.cost * 100).toFixed(0) + "%").padStart(6)}                ${pc(cc.mean).padStart(8)}  ${(cc.t == null ? "—" : cc.t.toFixed(2)).padStart(5)}   ${(cc.sharpe == null ? "—" : cc.sharpe.toFixed(2)).padStart(6)}    ${pc(cc.worst).padStart(8)}`);

  // ── survivability: the question that actually decides this ────────────────
  // A short straddle's loss is unbounded, so "capital posted" is set by the worst episode the
  // record contains. Sizing to survive it is the difference between a premium and a blow-up.
  const allEps = prim.eps;
  const worstEp = allEps.reduce((w, e) => (w && w.gross <= e.gross ? w : e), null);
  const worstOosEp = allEps.filter(e => e.date > IS_END).reduce((w, e) => (w && w.gross <= e.gross ? w : e), null);
  const drawdown = (() => { let eq = 0, peak = 0, mdd = 0; for (const e of allEps) { eq += e.gross - BASELINE_COST * e.premium; peak = Math.max(peak, eq); mdd = Math.min(mdd, eq - peak); } return mdd; })();
  const capitalMult = worstEp ? Math.abs(worstEp.gross) / 0.25 : null;   // worst episode ≤ 25% of posted capital

  console.log(`\n  ══ SURVIVABILITY ══`);
  console.log(`  worst episode ever      ${pc(worstEp?.gross)} of notional  (${worstEp?.date}, VIX ${worstEp?.vix?.toFixed(1)})`);
  console.log(`  worst episode OOS       ${pc(worstOosEp?.gross)} of notional  (${worstOosEp?.date})`);
  console.log(`  peak-to-trough (cum)    ${pc(drawdown)} of notional, full history`);
  console.log(`  to keep the worst episode ≤25% of posted capital, notional must be ≤ ${capitalMult ? (100 / capitalMult).toFixed(0) : "—"}% of the sleeve`);
  console.log(`  → at that size the mean OOS episode earns ${o.mean != null && capitalMult ? pc(o.mean / capitalMult) : "—"} of the sleeve, ~${o.mean != null && capitalMult ? ((o.mean / capitalMult) * (252 / PRIMARY.H) * 100).toFixed(2) : "—"}%/yr before compounding`);

  // ── adjudication against the stored rule ─────────────────────────────────
  const worstFrac = worstEp ? Math.abs(worstEp.gross) : null;
  const gates = {
    t: o.t != null && o.t >= Z_BAR,
    sharpe: o.sharpe != null && o.sharpe > 0.5,
    positive: o.mean != null && o.mean > 0,
    survivable: worstFrac != null && worstFrac < 0.25,
  };
  console.log(`\n  ══ ADJUDICATION vs THE PRE-REGISTERED RULE ══`);
  console.log(`  ${gates.positive ? "✓" : "✗"} OOS mean net P&L > 0                    ${pc(o.mean)}`);
  console.log(`  ${gates.t ? "✓" : "✗"} OOS t ≥ ${Z_BAR} (corrected for ${M} cells)        ${o.t == null ? "—" : o.t.toFixed(2)}`);
  console.log(`  ${gates.sharpe ? "✓" : "✗"} OOS Sharpe > 0.5                        ${o.sharpe == null ? "—" : o.sharpe.toFixed(2)}`);
  console.log(`  ${gates.survivable ? "✓" : "✗"} worst episode < 25% of notional         ${pc(worstEp?.gross)}`);

  const failHard = (o.mean != null && o.mean <= 0) || (worstFrac != null && worstFrac > 0.50);
  const verdict = Object.values(gates).every(Boolean)
    ? "PASS — every pre-registered gate met out of sample. Proceed to the kill-tests, then a paper sleeve. NOT a funding decision."
    : failHard
      ? `FAIL — ${o.mean <= 0 ? "out-of-sample mean is not positive" : "the worst episode exceeds 50% of notional"}.`
      : `NOT-ESTABLISHED — ${Object.entries(gates).filter(([, v]) => !v).map(([k]) => k).join(", ")} gate(s) not met. A real outcome, not a reason to keep testing.`;
  console.log(`\n  VERDICT: ${verdict}\n`);

  fs.writeFileSync(path.join(__dirname, "data", "vrp-test-41.json"), JSON.stringify({
    generated: new Date().toISOString(), test: 41,
    preRegistered: "2026-07-25, before any result of this script was examined",
    payoffModel: "short 21d ATM straddle: P&L% = 0.7979·σ_VIX·√T − |S_T/S_0 − 1|; premium from VIX, loss leg from the actual terminal move",
    familySize: M, correctedBar: Z_BAR, primary: PRIMARY, costGrid: COST_GRID, baselineCost: BASELINE_COST,
    inSampleEnd: IS_END, nonOverlapping: true,
    cells: cells.map(c => ({ label: c.label, H: c.H, rule: c.rule, nIs: c.isScore.n, isMean: c.isScore.mean, nOos: c.oosScore.n, oosMean: c.oosScore.mean, oosT: c.oosScore.t, oosSharpe: c.oosScore.sharpe, oosWin: c.oosScore.winPct, oosWorst: c.oosScore.worst })),
    primaryCostCurve: prim.costCurve.map(c => ({ cost: c.cost, mean: c.mean, t: c.t, sharpe: c.sharpe, worst: c.worst })),
    survivability: { worstEpisode: worstEp?.gross, worstEpisodeDate: worstEp?.date, worstOos: worstOosEp?.gross, cumulativeDrawdown: drawdown, maxNotionalPctOfSleeve: capitalMult ? 100 / capitalMult : null },
    gates, verdict,
    caveat: "The payoff is a Black-Scholes ATM-straddle approximation, not a traded instrument. Real implementation faces XSP bid/ask, assignment and margin behaviour in a crash — all of which take from the premium and none of which are modelled here.",
  }, null, 1));
  console.log(`  written: backend/data/vrp-test-41.json\n`);
})();
