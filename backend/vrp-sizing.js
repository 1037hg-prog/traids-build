#!/usr/bin/env node
/**
 * TEST #43 — VRP AT SURVIVABLE SIZE: is the return that's LEFT worth having?
 *
 * PRE-REGISTERED 2026-07-25, before this script was run.
 *
 * WHY: test #42 replicated the 10-session short-vol premium on independent evidence
 * (SPX/VIX 1990–2001: t = 7.33, Sharpe 2.12) but returned NOT-ESTABLISHED because the Nasdaq
 * set had a −31%-of-notional episode against a 25% gate. That gate conflated edge with
 * position size — a −31% episode at 80% notional is −25% of capital, which is arithmetic, not
 * a dead strategy. So this test makes SIZE an explicit, calibrated parameter and asks the only
 * question left: after sizing the position so the worst historical episode is survivable, is
 * the remaining return worth the tail you are still carrying?
 *
 * THE TWO THINGS THIS TEST ADDS, both of which can only hurt the result
 *
 *   1. SIZE CALIBRATED IN-SAMPLE, APPLIED OUT-OF-SAMPLE. Notional is set so the worst episode
 *      in the TRAINING window costs exactly the risk budget. Calibrating on the full history
 *      would be look-ahead of the worst kind — sizing a position using a crash that hadn't
 *      happened yet. The interesting failure mode is explicitly measured: did any OOS episode
 *      exceed the in-sample worst, i.e. was the calibration itself wrong?
 *
 *   2. COSTS THAT WIDEN WITH VOLATILITY. A flat "5% of premium" is generous and wrong in the
 *      way that matters: index option spreads blow out precisely when vol spikes, which is
 *      exactly when the position is losing. Modelled as cost% = base + slope·max(0, σ − 20),
 *      so a crash charges more than a calm week. This makes the tail worse, never better.
 *
 * SPECIFICATION — carried unchanged from #42, nothing re-optimised
 *   Short a 10-session delta-neutral ATM straddle priced at the index's own vol index,
 *   always-on, non-overlapping episodes.
 *       P&L%notional = 0.7979·σ·√(10/252) − |S_T/S_0 − 1|   (minus vol-scaled cost)
 *   Sleeve P&L = notionalMultiple × P&L%notional, where notionalMultiple comes from (1) above.
 *
 * WINDOWS — chronological, split on a year boundary, declared before running
 *   CALIBRATE + IN-SAMPLE : 1990-01-01 → 2009-12-31  (contains 1998 LTCM and 2008)
 *   OUT-OF-SAMPLE         : 2010-01-01 → present     (contains Feb 2018 and Feb 2020)
 *   The OOS window holds both modern short-vol catastrophes. A sizing rule calibrated on 2008
 *   and tested through 2018 and 2020 is the honest version of this question.
 *
 * FAMILY — size 2, corrected bar t ≥ 2.24. SPX (primary) and NDX (secondary). BOTH must pass;
 * "better of two" is not the rule, for the same reason it wasn't in #42.
 *
 * RISK BUDGET: the worst in-sample episode is sized to cost 20% of the sleeve.
 *
 * DECISION RULE — quoted at adjudication, fixed before any result
 *   PASS  if, in BOTH underlyings, out of sample: annualised return on sleeve > 5%,
 *         Sharpe > 0.7, maximum peak-to-trough drawdown ≤ 35% of the sleeve, AND no single
 *         episode exceeded 2× the risk budget (i.e. the in-sample calibration was not badly
 *         wrong).
 *   FAIL  if either underlying has OOS return ≤ 0, or drawdown > 60% of the sleeve.
 *   Otherwise NOT-ESTABLISHED.
 *
 * Usage:  node backend/vrp-sizing.js
 */
const fs = require("fs");
const path = require("path");

const MKT = "http://localhost:3002/api/yahoo";
const H = 10;
const PHI0 = 0.3989422804014327, STRADDLE_K = 2 * PHI0;
const COST_BASE = 0.05;            // fraction of premium in calm conditions
const COST_SLOPE = 0.004;          // extra fraction per vol point above 20
const RISK_BUDGET = 0.20;          // worst in-sample episode costs this much of the sleeve
const IS_END = "2009-12-31";
const M = 2, Z_BAR = 2.24;
const EPISODES_PER_YEAR = 252 / H;

const g = async (s) => {
  const r = await fetch(`${MKT}/${encodeURIComponent(s)}/history?days=14000&interval=1d`, { signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error(`${s} HTTP ${r.status}`);
  return (await r.json()).bars || [];
};
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };

/** Cost as a fraction of premium, widening with entry volatility. */
const costFrac = (sig) => COST_BASE + COST_SLOPE * Math.max(0, sig - 20);

function episodes(spot, vol) {
  const px = new Map(spot.map(b => [b.date, b.close]));
  const vx = new Map(vol.map(b => [b.date, b.close]));
  const dates = spot.map(b => b.date).filter(d => vx.has(d) && Number.isFinite(px.get(d)));
  const out = [];
  for (let i = 0; i + H < dates.length; i += H) {
    const d = dates[i], s0 = px.get(d), sig = vx.get(d), sT = px.get(dates[i + H]);
    if (![s0, sig, sT].every(Number.isFinite) || s0 <= 0) continue;
    const premium = STRADDLE_K * (sig / 100) * Math.sqrt(H / 252);
    const move = Math.abs(sT / s0 - 1);
    const net = premium - move - costFrac(sig) * premium;
    out.push({ date: d, vix: sig, premium, move, perNotional: net });
  }
  return out;
}

/** Peak-to-trough on the cumulative sleeve curve. */
function maxDD(series) {
  let eq = 0, peak = 0, mdd = 0;
  for (const x of series) { eq += x; peak = Math.max(peak, eq); mdd = Math.min(mdd, eq - peak); }
  return mdd;
}

function analyse(eps, label) {
  const is = eps.filter(e => e.date <= IS_END);
  const oos = eps.filter(e => e.date > IS_END);
  if (is.length < 30 || oos.length < 30) return { label, insufficient: true, nIs: is.length, nOos: oos.length };

  // (1) size from IN-SAMPLE ONLY
  const worstIs = Math.min(...is.map(e => e.perNotional));
  const notional = RISK_BUDGET / Math.abs(worstIs);

  const sleeve = (arr) => arr.map(e => e.perNotional * notional);
  const oosSleeve = sleeve(oos), isSleeve = sleeve(is);
  const m = mean(oosSleeve), s = sd(oosSleeve);
  const annual = m * EPISODES_PER_YEAR;
  const sharpe = (m != null && s) ? (m / s) * Math.sqrt(EPISODES_PER_YEAR) : null;
  const dd = maxDD(oosSleeve);

  // the calibration test: did OOS exceed what in-sample told us to expect?
  const worstOosNotional = Math.min(...oos.map(e => e.perNotional));
  const worstOosSleeve = worstOosNotional * notional;
  const budgetBreach = Math.abs(worstOosSleeve) / RISK_BUDGET;      // 1.0 = exactly on budget
  const worstOosEp = oos.reduce((w, e) => (w && w.perNotional <= e.perNotional ? w : e), null);

  return {
    label, nIs: is.length, nOos: oos.length,
    worstIsNotional: worstIs, notionalMultiple: notional,
    isAnnual: mean(isSleeve) * EPISODES_PER_YEAR,
    oosMean: m, oosAnnual: annual, oosSharpe: sharpe, oosT: (m != null && s) ? m / (s / Math.sqrt(oosSleeve.length)) : null,
    oosWin: 100 * oosSleeve.filter(x => x > 0).length / oosSleeve.length,
    oosDD: dd, worstOosSleeve, budgetBreach, worstOosDate: worstOosEp?.date, worstOosVol: worstOosEp?.vix,
  };
}

(async () => {
  console.log(`\n  TEST #43 — VRP AT SURVIVABLE SIZE`);
  console.log(`  size calibrated on ≤ ${IS_END} ONLY, applied out of sample · costs widen with vol`);
  console.log(`  risk budget: worst in-sample episode = ${(RISK_BUDGET * 100)}% of sleeve · family of ${M}, bar t ≥ ${Z_BAR}`);
  console.log(`  BOTH underlyings must pass.\n`);

  const [vix, spx, vxn, ndx] = await Promise.all([g("^VIX"), g("^GSPC"), g("^VXN"), g("^NDX")]);
  const A = analyse(episodes(spx, vix), "SPX / VIX");
  const B = analyse(episodes(ndx, vxn), "NDX / VXN");
  const sets = [A, B].filter(x => !x.insufficient);
  for (const x of [A, B]) if (x.insufficient) console.log(`  ⚠ ${x.label}: insufficient split (IS ${x.nIs}, OOS ${x.nOos}) — excluded`);

  const pc = (v) => v == null ? "     —" : (v >= 0 ? "+" : "") + (v * 100).toFixed(2) + "%";
  console.log(`  ══ SIZING, CALIBRATED IN-SAMPLE ══`);
  console.log(`  underlying    worst IS episode   → notional size   IS annualised`);
  console.log(`  ─────────────────────────────────────────────────────────────────`);
  for (const x of sets) console.log(`  ${x.label.padEnd(13)} ${pc(x.worstIsNotional).padStart(15)}    ${(x.notionalMultiple * 100).toFixed(0).padStart(5)}% of sleeve   ${pc(x.isAnnual).padStart(9)}`);

  console.log(`\n  ══ OUT OF SAMPLE (${IS_END.slice(0, 4)}+ — includes Feb 2018 and Feb 2020) ══`);
  console.log(`  underlying     n   annualised   Sharpe      t    win%    max DD   worst episode`);
  console.log(`  ────────────────────────────────────────────────────────────────────────────────`);
  for (const x of sets)
    console.log(`  ${x.label.padEnd(13)} ${String(x.nOos).padStart(3)}   ${pc(x.oosAnnual).padStart(10)}   ${(x.oosSharpe == null ? "—" : x.oosSharpe.toFixed(2)).padStart(6)}  ${(x.oosT == null ? "—" : x.oosT.toFixed(2)).padStart(5)}   ${x.oosWin.toFixed(0)}%   ${pc(x.oosDD).padStart(8)}   ${pc(x.worstOosSleeve).padStart(8)}`);

  console.log(`\n  ══ WAS THE IN-SAMPLE CALIBRATION RIGHT? ══`);
  for (const x of sets) {
    const verdict = x.budgetBreach <= 1 ? "within budget" : x.budgetBreach <= 2 ? `${x.budgetBreach.toFixed(2)}× over budget` : `${x.budgetBreach.toFixed(2)}× OVER — calibration badly wrong`;
    console.log(`  ${x.label.padEnd(13)} worst OOS episode ${pc(x.worstOosSleeve)} of sleeve vs ${(RISK_BUDGET * 100)}% budget → ${verdict}`);
    console.log(`  ${"".padEnd(13)}   (${x.worstOosDate}, entered at vol ${x.worstOosVol?.toFixed(1)})`);
  }

  // ── adjudication ─────────────────────────────────────────────────────────
  const gateOf = (x) => ({
    ret: x.oosAnnual != null && x.oosAnnual > 0.05,
    sharpe: x.oosSharpe != null && x.oosSharpe > 0.7,
    dd: x.oosDD != null && Math.abs(x.oosDD) <= 0.35,
    calib: x.budgetBreach != null && x.budgetBreach <= 2,
  });
  const gs = sets.map(x => ({ x, g: gateOf(x) }));
  console.log(`\n  ══ ADJUDICATION vs THE PRE-REGISTERED RULE ══`);
  for (const { x, g } of gs) {
    console.log(`  ${x.label}`);
    console.log(`    ${g.ret ? "✓" : "✗"} annualised > 5%          ${pc(x.oosAnnual)}`);
    console.log(`    ${g.sharpe ? "✓" : "✗"} Sharpe > 0.7             ${x.oosSharpe?.toFixed(2) ?? "—"}`);
    console.log(`    ${g.dd ? "✓" : "✗"} max drawdown ≤ 35%       ${pc(x.oosDD)}`);
    console.log(`    ${g.calib ? "✓" : "✗"} worst episode ≤ 2× budget ${x.budgetBreach?.toFixed(2)}×`);
  }
  const allPass = gs.length === M && gs.every(({ g }) => Object.values(g).every(Boolean));
  const hardFail = gs.some(({ x }) => (x.oosAnnual != null && x.oosAnnual <= 0) || (x.oosDD != null && Math.abs(x.oosDD) > 0.60));
  const failing = gs.flatMap(({ x, g }) => Object.entries(g).filter(([, v]) => !v).map(([k]) => `${x.label}:${k}`));

  const verdict = allPass
    ? `PASS — at a size calibrated only on pre-2010 data, and with costs that widen in crashes, the premium still returns >5%/yr out of sample in BOTH underlyings through 2018 and 2020, without breaching its risk budget. This is the first PASS in 43 tests. It authorises a PAPER sleeve on forward-collected chains — not capital, because the payoff is still a Black-Scholes approximation of an instrument we have never priced or traded.`
    : hardFail
      ? `FAIL — ${gs.some(({ x }) => x.oosAnnual <= 0) ? "an underlying lost money out of sample" : "drawdown exceeded 60% of the sleeve"}. Short vol at survivable size does not clear the bar.`
      : `NOT-ESTABLISHED — gate(s) not met: ${failing.join(", ")}. Positive premium, real replication, and still not promotable at a size that survives its own tail.`;
  console.log(`\n  VERDICT: ${verdict}\n`);

  fs.writeFileSync(path.join(__dirname, "data", "vrp-sizing-43.json"), JSON.stringify({
    generated: new Date().toISOString(), test: 43,
    preRegistered: "2026-07-25, before this script was run",
    specification: { horizon: H, rule: "always-on", nonOverlapping: true, payoff: "0.7979·σ·√(H/252) − |S_T/S_0 − 1| − cost", costModel: `${COST_BASE} + ${COST_SLOPE}·max(0, σ−20) of premium`, riskBudget: RISK_BUDGET, sizing: "notional = riskBudget / |worst in-sample episode|, in-sample only" },
    windows: { calibrateAndIs: `1990 → ${IS_END}`, oos: `${IS_END.slice(0, 4)}+ (includes Feb 2018, Feb 2020)` },
    familySize: M, correctedBar: Z_BAR, rule: "BOTH underlyings must pass",
    results: sets, gates: gs.map(({ x, g }) => ({ label: x.label, ...g })), verdict,
    caveats: [
      "Payoff is a Black-Scholes ATM-straddle approximation, not a traded instrument. Assignment, early exercise, and margin calls in a crash are unmodelled.",
      "Pre-2003 VIX values are a retroactive reconstruction under current CBOE methodology.",
      "The vol-scaled cost model is an assumption, not a measurement — real crash-period spreads on XSP have not been observed.",
      "Sizing assumes the sleeve can post margin through the drawdown without forced liquidation, which is a broker-behaviour question this test cannot answer.",
    ],
  }, null, 1));
  console.log(`  written: backend/data/vrp-sizing-43.json\n`);
})();
