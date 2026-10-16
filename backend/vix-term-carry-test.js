#!/usr/bin/env node
/**
 * TEST #51 (structural candidate S4) — VIX TERM-STRUCTURE CARRY
 *
 * PRE-REGISTERED 2026-07-28, before this script was run. Specification frozen in
 * backend/data/structural-register.json under id "S4" prior to writing this file.
 *
 * NUMBERING NOTE: the registry holds 47 adjudicated tests. #48 and #49 are pending TASKS,
 * not tests; #50 is the naked-vs-spread script, written and parked unrun. This is #51.
 *
 * WHY THIS ONE FIRST. It is the only structural candidate whose premium is ALREADY MEASURED.
 * Test #24 established the variance risk premium at +3.5 vol points per month, t=8.04, positive
 * in 84% of months. So this does NOT hunt a new edge — it tests a different VEHICLE for a known
 * one. Tests #41, #42 and #43 tried to harvest that premium through options and all three failed
 * their risk gates. Listed VIX futures, expressed through an ETP, is the remaining vehicle.
 *
 * WHO IS ON THE OTHER SIDE, AND WHY THEY PAY. Equity holders buy portfolio insurance. They need
 * the hedge more than they need the expected value, so they accept a worse price. The VIX futures
 * curve is in contango most of the time as a result, and a long-volatility ETP bleeds as it rolls
 * up that curve. Selling that bleed is selling the insurance.
 *
 * ── THE INSTRUMENT CHOICE IS THE WHOLE INTEGRITY OF THIS TEST ────────────────────────────────
 * The obvious way to test short volatility is to buy an inverse product. Both obvious choices
 * are traps, and this project has been caught by this exact class of bias three times already
 * (training data, odd-lot, merger arb):
 *
 *   XIV  — the −1x inverse ETN — TERMINATED on 2018-02-05 after losing ~96% in one session.
 *          It is not in any price feed. A backtest of "short volatility" that uses whatever
 *          inverse products still exist has ERASED THE EVENT THAT DEFINES THE STRATEGY.
 *   SVXY — survived only because ProShares cut it from −1x to −0.5x immediately afterwards.
 *          Its series spans that change, so any return computed across 2018-02 is splicing two
 *          different instruments and silently halves the disaster.
 *
 * So neither is used. The short is SYNTHESISED as −1 × the daily return of VIXY, the LONG-
 * volatility ETP, which has an unbroken 2012→present series precisely because the long side
 * never blows up — it only decays. Every day of the Feb-2018 and March-2020 spikes appears at
 * full magnitude as a loss on the short, which is the honest accounting and the entire point.
 *
 * SIGNAL. Contango state from the CBOE term-structure indices, which are free and published:
 *     ratio = VIX3M / VIX      ratio > 1 ⇒ contango ⇒ the roll pays the seller
 * Computed from the CLOSE of day t; the position is held over t→t+1. No look-ahead.
 *
 * VARIANT FAMILY — size 4, declared before running. Bonferroni bar t ≥ 2.50.
 *     always short · short when ratio > 1.00 · short when ratio > 1.05 · short when VIX9D/VIX < 1
 *
 * SAMPLE. 2012-11-19 → present (~13.7 years). Contains Feb 2018 and March 2020 — the two events
 * that have killed every short-volatility product ever launched.
 *     IN-SAMPLE ≤ 2019-12-31  ·  OUT-OF-SAMPLE 2020+ (so March 2020 is strictly OOS)
 *
 * COSTS. Shorting an ETP is not free and the borrow on volatility products is expensive and
 * spikes exactly when you least want it to. A grid is reported rather than one assumption:
 *     0% / 3% / 6% / 10% annualised borrow. VIXY's own 0.85% expense ratio accrues TO the short.
 *
 * DECISION RULE — fixed now, before any result
 *   PASS  if, out of sample and net of a 6% borrow: mean daily return > 0, t ≥ 2.50, AND
 *         account-level max drawdown at the tested sizing is no worse than −10%.
 *         The drawdown gate is the operator's own stated constraint, not one I chose.
 *   FAIL  if OOS mean ≤ 0.
 *   Otherwise NOT-ESTABLISHED.
 *
 * EXPECTED OUTCOME, WRITTEN DOWN SO A SURPRISE IS A REAL SURPRISE: the premium is real and will
 * show a positive mean. It will FAIL the drawdown gate, because the payoff shape of selling
 * insurance is many small gains and a rare catastrophic loss — the same shape that failed
 * #41/#42/#43 and the same shape that terminated XIV. I expect NOT-ESTABLISHED on drawdown.
 *
 * Usage: node backend/vix-term-carry-test.js
 */
const fs = require("fs"), path = require("path");
const MKT = "http://localhost:3002/api/yahoo";
const IS_END = "2019-12-31";
const M = 4, T_BAR = 2.50;                    // family of 4 → Bonferroni two-sided ≈ 2.50
const BORROW_GRID = [0, 0.03, 0.06, 0.10];
const BASE_BORROW = 0.06;
/**
 * DRAWDOWN CEILING — read from backend/data/risk-policy.json rather than hard-coded, so the
 * constraint has ONE version and ONE change history. Raised 10% → 20% on 2026-07-28 on an
 * independent empirical basis (max drawdown runs ~3x annual volatility; a 10% ceiling is
 * stricter than buy-and-hold SPY, whose MEDIAN 1-year drawdown is -10.4%).
 *
 * This test's verdict is UNCHANGED by that: -59.92% breaches either number. Recorded here so
 * nobody later mistakes the re-run for a re-grade.
 */
const RISK = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "risk-policy.json"), "utf8"));
const DD_CEILING = RISK.current.hardCeiling;
const DD_REVIEW = RISK.current.reviewTrigger;

const g = async (s) => {
  const r = await fetch(`${MKT}/${encodeURIComponent(s)}/history?days=6000&interval=1d`, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`${s} ${r.status}`);
  return ((await r.json()).bars || []).filter(b => Number.isFinite(b.close));
};
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const pc = (v, d = 2) => v == null ? "    —" : (v >= 0 ? "+" : "") + (v * 100).toFixed(d) + "%";

/** Equity path metrics. Drawdown is a PATH property — established in #46/#47 — so it is
 *  measured on the compounded curve, never inferred from any single day's loss. */
function pathStats(rets) {
  let eq = 1, peak = 1, dd = 0, ruined = false;
  const curve = [];
  for (const r of rets) {
    eq *= (1 + r);
    if (eq <= 0) { eq = 0; ruined = true; curve.push(0); break; }
    peak = Math.max(peak, eq);
    dd = Math.max(dd, (peak - eq) / peak);
    curve.push(eq);
  }
  const yrs = rets.length / 252;
  return { finalEq: eq, cagr: yrs > 0 && eq > 0 ? Math.pow(eq, 1 / yrs) - 1 : null, maxDD: dd, ruined, curve };
}

(async () => {
  console.log(`\n  TEST #51 (S4) — VIX TERM-STRUCTURE CARRY`);
  console.log(`  pre-registered 2026-07-28 · family of ${M} · Bonferroni bar t ≥ ${T_BAR}`);
  console.log(`  short synthesised as −1 × VIXY (the LONG ETP) — XIV terminated and SVXY changed leverage;`);
  console.log(`  using either would erase the events this test exists to measure.\n`);

  const [vix, vix3m, vix9d, vixy] = await Promise.all([g("^VIX"), g("^VIX3M"), g("^VIX9D"), g("VIXY")]);
  const M_ = (a) => new Map(a.map(b => [b.date, b.close]));
  const V = M_(vix), V3 = M_(vix3m), V9 = M_(vix9d), Y = M_(vixy);
  const dates = vixy.map(b => b.date).filter(d => V.has(d) && V3.has(d) && V9.has(d)).sort();
  console.log(`  aligned series: ${dates.length} sessions · ${dates[0]} → ${dates[dates.length - 1]}\n`);

  // build daily short-VIXY returns with the signal known at the PRIOR close
  const rows = [];
  for (let i = 0; i < dates.length - 1; i++) {
    const d = dates[i], dn = dates[i + 1];
    const y0 = Y.get(d), y1 = Y.get(dn);
    if (!(y0 > 0 && y1 > 0)) continue;
    rows.push({
      date: dn,                                   // the day the return is EARNED
      ratio3: V3.get(d) / V.get(d),               // signal from close of d
      ratio9: V9.get(d) / V.get(d),
      shortRet: -(y1 / y0 - 1),                   // short the long ETP
      vix: V.get(d),
    });
  }

  const VARIANTS = [
    ["always short", () => true],
    ["ratio3 > 1.00 (contango)", (r) => r.ratio3 > 1.00],
    ["ratio3 > 1.05 (steep)", (r) => r.ratio3 > 1.05],
    ["VIX9D/VIX < 1 (front calm)", (r) => r.ratio9 < 1.00],
  ];

  const score = (rs, borrow) => {
    if (!rs.length) return null;
    const net = rs.map(r => r.on ? r.shortRet - borrow / 252 : 0);
    const active = net.filter((_, i) => rs[i].on);
    const m = mean(active), s = sd(active);
    const p = pathStats(net);
    return { n: active.length, exposure: active.length / rs.length, mean: m,
      t: (m != null && s && active.length > 2) ? m / (s / Math.sqrt(active.length)) : null,
      cagr: p.cagr, maxDD: p.maxDD, ruined: p.ruined,
      worst: active.length ? Math.min(...active) : null };
  };

  console.log(`  ══ VARIANT FAMILY, net of ${(BASE_BORROW * 100).toFixed(0)}% borrow ══`);
  console.log(`  variant                        window   days  expos   CAGR      maxDD    worst day   t`);
  console.log(`  ${"".padEnd(92, "─")}`);
  const results = {};
  for (const [name, fn] of VARIANTS) {
    results[name] = {};
    for (const [wLbl, filt] of [["IS ", r => r.date <= IS_END], ["OOS", r => r.date > IS_END]]) {
      const rs = rows.filter(filt).map(r => ({ ...r, on: fn(r) }));
      const s = score(rs, BASE_BORROW);
      results[name][wLbl.trim()] = s;
      if (!s) continue;
      console.log(`  ${name.padEnd(30)} ${wLbl}   ${String(s.n).padStart(4)}  ${(s.exposure * 100).toFixed(0).padStart(4)}%  ${pc(s.cagr).padStart(8)}  ${pc(-s.maxDD).padStart(8)}  ${pc(s.worst).padStart(9)}  ${(s.t == null ? "—" : s.t.toFixed(2)).padStart(6)}`);
    }
  }

  // ── the primary cell, across the borrow grid ────────────────────────────────
  const PRIMARY = "ratio3 > 1.00 (contango)";
  const primFn = VARIANTS.find(v => v[0] === PRIMARY)[1];
  const oos = rows.filter(r => r.date > IS_END).map(r => ({ ...r, on: primFn(r) }));
  console.log(`\n  ══ PRIMARY (${PRIMARY}) — borrow sensitivity, OUT OF SAMPLE ══`);
  console.log(`  borrow    CAGR      maxDD     t       verdict on the −${(DD_CEILING * 100).toFixed(0)}% ceiling (review trigger −${(DD_REVIEW * 100).toFixed(0)}%)`);
  console.log(`  ${"".padEnd(70, "─")}`);
  for (const b of BORROW_GRID) {
    const s = score(oos, b);
    console.log(`  ${((b * 100).toFixed(0) + "%").padStart(5)}   ${pc(s.cagr).padStart(8)}  ${pc(-s.maxDD).padStart(8)}  ${(s.t == null ? "—" : s.t.toFixed(2)).padStart(6)}   ${s.maxDD <= DD_CEILING ? "PASSES" : "BREACHES by " + ((s.maxDD - DD_CEILING) * 100).toFixed(1) + " points"}`);
  }

  // ── what the tails actually did ─────────────────────────────────────────────
  const worst = [...oos.filter(r => r.on)].sort((a, b) => (a.shortRet) - (b.shortRet)).slice(0, 5);
  const isWorst = [...rows.filter(r => r.date <= IS_END).map(r => ({ ...r, on: primFn(r) })).filter(r => r.on)].sort((a, b) => a.shortRet - b.shortRet).slice(0, 5);
  console.log(`\n  ══ THE TAIL — worst single sessions while positioned ══`);
  console.log(`  in sample : ${isWorst.map(r => `${r.date} ${pc(r.shortRet)}`).join(" · ")}`);
  console.log(`  out of sample: ${worst.map(r => `${r.date} ${pc(r.shortRet)}`).join(" · ")}`);

  const P = score(oos, BASE_BORROW);
  const gates = {
    pos: P.mean != null && P.mean > 0,
    t: P.t != null && P.t >= T_BAR,
    dd: P.maxDD <= DD_CEILING,
  };
  console.log(`\n  ══ ADJUDICATION vs THE PRE-REGISTERED RULE ══`);
  console.log(`  ${gates.pos ? "✓" : "✗"} OOS mean > 0                ${pc(P.mean, 4)} per active day`);
  console.log(`  ${gates.t ? "✓" : "✗"} OOS t ≥ ${T_BAR}                ${P.t == null ? "—" : P.t.toFixed(2)}`);
  console.log(`  ${gates.dd ? "✓" : "✗"} max drawdown ≤ ${(DD_CEILING * 100).toFixed(0)}%          ${pc(-P.maxDD)}`);
  const verdict = !gates.pos ? "FAIL — the premium does not show positive out of sample."
    : Object.values(gates).every(Boolean) ? "PASS — clears every pre-registered gate including the operator's drawdown ceiling. Promote to the forward registry as a PAPER sleeve; ETP mechanics are not futures mechanics and that gap must be closed before capital."
      : `NOT-ESTABLISHED — ${Object.entries(gates).filter(([, v]) => !v).map(([k]) => k).join(", ")} gate(s) failed.`;
  console.log(`\n  VERDICT: ${verdict}\n`);

  fs.writeFileSync(path.join(__dirname, "data", "vix-term-carry-51.json"), JSON.stringify({
    generated: new Date().toISOString(), test: 51, structuralCandidate: "S4",
    preRegistered: "2026-07-28, specification frozen in structural-register.json before this script existed.",
    instrument: "short synthesised as -1 x VIXY daily return. XIV terminated 2018-02-05 and is absent from all feeds; SVXY changed from -1x to -0.5x immediately after. Using either would erase or halve the defining event.",
    signal: "VIX3M/VIX from the prior close; position held over the following session. No look-ahead.",
    familySize: M, correctedBar: T_BAR, inSampleEnd: IS_END, borrowGrid: BORROW_GRID, baseBorrow: BASE_BORROW,
    drawdownCeiling: DD_CEILING, results, gates, verdict,
    caveats: [
      "ETP mechanics are not futures mechanics: VIXY holds a rolling M1/M2 position with its own rebalancing, and its 0.85% expense ratio accrues to the short.",
      "Borrow on volatility ETPs spikes precisely when the short is losing; a flat annualised rate understates that.",
      "A short position rebalanced to constant notional differs from a static short; the daily-return construction here implies daily rebalancing.",
      "Shorting has no cap on loss. The equity path can and does go to zero, and the script reports ruin rather than clipping it.",
    ],
  }, null, 1));
  console.log(`  written: backend/data/vix-term-carry-51.json\n`);
})();
