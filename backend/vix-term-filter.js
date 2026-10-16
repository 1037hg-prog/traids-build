#!/usr/bin/env node
/**
 * TEST #47 — does the VIX TERM STRUCTURE filter the credit-spread sleeve's tail?
 *
 * PRE-REGISTERED 2026-07-27, before running.
 *
 * WHY THIS FILTER AND NOT ANOTHER. When spot VIX rises above 3-month VIX the term structure is
 * INVERTED — the market is paying more for immediate protection than for protection three
 * months out. That is the canonical stress signal for short-volatility positions, documented
 * long before this test and independently of our data. It is being tested BECAUSE the theory
 * names it, not because a scan found it worked. That distinction is the whole difference
 * between this and the specification search that produced #41→#43, and it is the reason a
 * single small family is declared rather than a sweep.
 *
 * BASE SPEC — unchanged from test #45. Nothing is re-optimised here.
 *   Short 20-delta put spread / 5-delta wing on SPX, 10 sessions to expiry, held to expiry,
 *   non-overlapping, 5% of account at risk per episode, cost 5% of credit plus a vol-scaled term.
 *
 * FAMILY — 3 cells, declared before running: skip the episode when VIX/VIX3M >= {0.95, 1.00, 1.05}.
 * Corrected two-sided bar z = Φ⁻¹(1 − 0.025/3) ≈ 2.39.
 *
 * THE DIAGNOSTIC THAT DECIDES IT. A filter that simply trades less will always reduce drawdown —
 * that is arithmetic, not skill. The real question is whether it preferentially avoids the
 * DISASTERS. So the primary diagnostic is: of the ten worst unfiltered episodes, how many does
 * the filter skip? A filter that skips 20% of episodes and 20% of the worst ten has told you
 * nothing. One that skips 20% of episodes and 70% of the worst ten is a genuine signal.
 *
 * DECISION RULE — fixed before any result
 *   PASS  if a cell cuts maximum drawdown by >=25% RELATIVE, retains >=75% of unfiltered CAGR,
 *         AND skips >=50% of the ten worst episodes.
 *   FAIL  if no cell reduces drawdown at all.
 *   Otherwise NOT-ESTABLISHED — including the case where drawdown falls only in proportion to
 *   the exposure removed, which is de-risking dressed as insight.
 *
 * Usage: node backend/vix-term-filter.js
 */
const fs = require("fs"), path = require("path");
const MKT = "http://localhost:3002/api/yahoo";
const DTE = 10, RISK = 0.05, COST_BASE = 0.05, COST_SLOPE = 0.004;
const THRESHOLDS = [0.95, 1.00, 1.05];
const M = THRESHOLDS.length, Z_BAR = 2.39;
const IS_END = "2015-12-31";
const PHI0 = 0.3989422804014327, K2 = 2 * PHI0;

function N(x) { const s = Math.sign(x); x = Math.abs(x) / Math.SQRT2; const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t * t * Math.exp(-x * x) - 0.254829592 * t * Math.exp(-x * x);
  return 0.5 * (1 + s * y); }
const bsPut = (S, Kk, sig, T) => { const v = sig * Math.sqrt(T); const d1 = (Math.log(S / Kk) + 0.5 * sig * sig * T) / v; return Kk * N(-(d1 - v)) - S * N(-d1); };
const strikeAt = (S, sig, T, d1) => S * Math.exp(0.5 * sig * sig * T - d1 * sig * Math.sqrt(T));
const g = async (s) => { const r = await fetch(`${MKT}/${encodeURIComponent(s)}/history?days=14000&interval=1d`, { signal: AbortSignal.timeout(180000) }); if (!r.ok) throw new Error(`${s} ${r.status}`); return (await r.json()).bars || []; };
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };

(async () => {
  console.log(`\n  TEST #47 — VIX TERM-STRUCTURE FILTER on the credit-spread sleeve`);
  console.log(`  base spec unchanged from #45 · family of ${M} · corrected bar |t| >= ${Z_BAR}`);
  console.log(`  the deciding diagnostic is WHICH episodes it skips, not how many\n`);

  const [spx, vix, vix3m] = await Promise.all([g("^GSPC"), g("^VIX"), g("^VIX3M")]);
  const px = new Map(spx.map(b => [b.date, b.close]));
  const vx = new Map(vix.map(b => [b.date, b.close]));
  const v3 = new Map(vix3m.map(b => [b.date, b.close]));
  const dates = spx.map(b => b.date).filter(d => vx.has(d) && Number.isFinite(px.get(d)));
  console.log(`  ^VIX3M ${vix3m.length} bars from ${vix3m[0]?.date}`);

  const eps = [];
  for (let i = 0; i + DTE < dates.length; i += DTE) {
    const d = dates[i], S = px.get(d), iv = vx.get(d) / 100, ST = px.get(dates[i + DTE]);
    if (![S, iv, ST].every(Number.isFinite) || iv <= 0) continue;
    const T = DTE / 252, Ks = strikeAt(S, iv, T, 0.8416), Kl = strikeAt(S, iv, T, 1.6449);
    const credit = bsPut(S, Ks, iv, T) - bsPut(S, Kl, iv, T), width = Ks - Kl, maxRisk = width - credit;
    if (!(maxRisk > 0 && credit > 0)) continue;
    const cost = (COST_BASE + COST_SLOPE * Math.max(0, iv * 100 - 20)) * credit;
    const frac = (credit - Math.max(0, Math.min(Ks - ST, width)) - cost) / maxRisk;
    const t3 = v3.get(d);
    eps.push({ d, frac, vix: iv * 100, ratio: Number.isFinite(t3) && t3 > 0 ? (iv * 100) / t3 : null });
  }
  const oos = eps.filter(e => e.d > IS_END);
  const withRatio = oos.filter(e => e.ratio != null);
  const yrs = (new Date(oos[oos.length - 1].d) - new Date(oos[0].d)) / (365.25 * 864e5);
  console.log(`  ${oos.length} OOS episodes (${withRatio.length} with a term-structure reading), ${yrs.toFixed(1)} years\n`);

  const run = (keep) => {
    let eq = 1, peak = 1, mdd = 0; const rets = [];
    for (const e of oos) { if (!keep(e)) { continue; } const p = RISK * e.frac; rets.push(p); eq *= (1 + p); peak = Math.max(peak, eq); mdd = Math.min(mdd, eq / peak - 1); }
    const m = mean(rets), s = sd(rets);
    return { n: rets.length, cagr: Math.pow(eq, 1 / yrs) - 1, mdd, t: (m != null && s) ? m / (s / Math.sqrt(rets.length)) : null };
  };

  const base = run(() => true);
  // the ten worst UNFILTERED episodes — the ones a real filter must preferentially avoid
  const worst10 = [...oos].sort((a, b) => a.frac - b.frac).slice(0, 10);

  console.log(`  ══ RESULTS ══`);
  console.log(`  filter              n   skipped   CAGR      maxDD    DD cut   CAGR kept   worst-10 skipped`);
  console.log(`  ────────────────────────────────────────────────────────────────────────────────────────────`);
  console.log(`  none (baseline)  ${String(base.n).padStart(4)}       0%   ${((base.cagr * 100).toFixed(2) + "%").padStart(7)}  ${((base.mdd * 100).toFixed(1) + "%").padStart(7)}        —          —                  —`);
  const rows = [];
  for (const th of THRESHOLDS) {
    const keep = (e) => e.ratio == null || e.ratio < th;
    const r = run(keep);
    const skipped = 1 - r.n / base.n;
    const ddCut = base.mdd !== 0 ? 1 - (r.mdd / base.mdd) : 0;
    const cagrKept = base.cagr !== 0 ? r.cagr / base.cagr : 0;
    const w10 = worst10.filter(e => !keep(e)).length;
    rows.push({ th, ...r, skipped, ddCut, cagrKept, worst10Skipped: w10 });
    console.log(`  VIX/VIX3M>=${th.toFixed(2)} ${String(r.n).padStart(4)}   ${((skipped * 100).toFixed(0) + "%").padStart(6)}   ${((r.cagr * 100).toFixed(2) + "%").padStart(7)}  ${((r.mdd * 100).toFixed(1) + "%").padStart(7)}   ${((ddCut * 100).toFixed(0) + "%").padStart(6)}      ${((cagrKept * 100).toFixed(0) + "%").padStart(5)}          ${String(w10).padStart(2)} of 10`);
  }

  console.log(`\n  ══ IS IT A SIGNAL OR JUST LESS EXPOSURE? ══`);
  for (const r of rows) {
    const lift = r.skipped > 0 ? (r.worst10Skipped / 10) / r.skipped : 0;
    console.log(`  VIX/VIX3M>=${r.th.toFixed(2)}: skips ${(r.skipped * 100).toFixed(0)}% of episodes and ${r.worst10Skipped * 10}% of the worst ten -> lift ${lift.toFixed(2)}x  ${lift >= 1.8 ? "(preferentially avoids disasters)" : lift >= 1.2 ? "(mild selectivity)" : "(no better than trading less)"}`);
  }

  const pass = rows.filter(r => r.ddCut >= 0.25 && r.cagrKept >= 0.75 && r.worst10Skipped >= 5);
  const anyBetter = rows.some(r => r.ddCut > 0);
  const verdict = pass.length
    ? `PASS — ${pass.map(r => `VIX/VIX3M>=${r.th}`).join(", ")} cuts drawdown >=25% while keeping >=75% of return AND skipping >=5 of the ten worst episodes. Add to the credit-spread candidate as a declared entry condition and forward-test it; do NOT retrofit it to the existing forward record.`
    : !anyBetter ? `FAIL — no threshold reduces drawdown at all.`
      : `NOT-ESTABLISHED — drawdown falls, but no cell clears all three gates. Where the worst-ten skip rate is close to the overall skip rate, the improvement is de-risking dressed as insight: trading less always cuts drawdown.`;
  console.log(`\n  VERDICT: ${verdict}\n`);

  fs.writeFileSync(path.join(__dirname, "data", "vix-term-filter-47.json"), JSON.stringify({
    generated: new Date().toISOString(), test: 47, preRegistered: "2026-07-27, before running",
    rationale: "term-structure inversion is the canonical short-vol stress signal, named by theory rather than found by scanning",
    baseSpec: "test #45 unchanged: 20-delta put spread / 5-delta wing, 10 DTE, held to expiry, 5% risk/episode",
    familySize: M, correctedBar: Z_BAR, thresholds: THRESHOLDS,
    baseline: base, cells: rows, worst10Dates: worst10.map(e => ({ date: e.d, frac: e.frac, ratio: e.ratio })),
    verdict,
    caveats: [
      "Payoff remains a Black-Scholes approximation; real chains have skew and this understates put credit.",
      "^VIX3M begins 2006, so the filter is only testable on the post-2006 sample.",
      "A PASS must be forward-tested, not retrofitted: applying a filter chosen today to the existing forward record would be exactly the retrospective re-specification tests #41-43 fell into.",
    ],
  }, null, 1));
  console.log(`  written: backend/data/vix-term-filter-47.json\n`);
})();
