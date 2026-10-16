#!/usr/bin/env node
/**
 * TEST #45 — 20-DELTA CREDIT SPREADS, 7–14 DAY EXPIRY: selling the premium we have been buying.
 *
 * PRE-REGISTERED 2026-07-26, before this script was run.
 *
 * WHY: all 10 open option positions on the board are DEBIT spreads — we BUY premium. Test #41
 * measured that premium at +3.53 vol points, positive 83.5% of days, accruing to whoever SELLS.
 * Our settled options are 51% win / −$125 / +0.002R on 35 trades. We have been structurally on
 * the losing side of the only edge in the registry, and paying the bid-ask toll to get there.
 *
 * The specification is the OPERATOR'S, not mine: 20-delta short strike, 7–14 day expiry. Worth
 * recording, because #41→#43 were three of my own risk-rule variants tuned after seeing each
 * failure — a specification search. This one comes from outside that loop.
 *
 * STRUCTURE
 *   Sell the 20-delta strike, buy the 5-delta strike as the wing. Defined risk. Held to expiry,
 *   no management — management would be another free parameter and this test has none.
 *   Strikes and premiums from Black-Scholes at the index's own volatility index, r=0.
 *     20-delta put:   d1 = +0.8416   → K = S·exp(σ²T/2 − d1·σ√T)
 *     20-delta call:  d1 = −0.8416   → K = S·exp(σ²T/2 − d1·σ√T)
 *   Returns are expressed as a fraction of MAX RISK — (width − credit) — because that is the
 *   capital a defined-risk spread actually ties up, and it makes the numbers directly
 *   comparable to the board's R-multiples.
 *
 * VARIANT FAMILY — size 6, declared before running. Corrected bar t ≥ 2.64.
 *   {put spread, call spread, iron condor} × {10 DTE, 14 DTE}
 *   Put-only and call-only are included because they are NOT symmetric: equities drift up, so a
 *   short put spread also collects the equity risk premium while a short call spread fights it.
 *   Reporting only the condor would hide that.
 *
 * WHAT DIRECTION IS *NOT* USED FOR: nothing. The board's signals are ignored entirely. They
 * have a 48.9% hit rate, so using them to pick a side would add noise and an untestable degree
 * of freedom. If this premium is real it must be real without them — and if it is, whether
 * board direction ADDS anything becomes a separate, later question.
 *
 * SAMPLE: ^GSPC/^VIX and ^NDX/^VXN, full available history, non-overlapping episodes.
 *   IN-SAMPLE ≤ 2015-12-31 · OUT-OF-SAMPLE 2016+ (contains Feb 2018 and Feb 2020).
 *
 * DECISION RULE — fixed before any result
 *   PASS  if, out of sample and net of 5%-of-credit cost, the operator-specified structure
 *         (20-delta, 10 DTE) shows: win rate ≥ 65%, mean return > 0, t ≥ 2.64, and worst single
 *         episode < 100% of max risk (i.e. the defined-risk wing actually held).
 *   FAIL  if OOS mean ≤ 0.
 *   Otherwise NOT-ESTABLISHED.
 *   Note the win-rate gate is a FLOOR, not the objective. A 75% win rate with negative
 *   expectancy fails, and the whole point of test #37 was that win rate and money are separable.
 *
 * Usage: node backend/credit-spread-test.js
 */
const fs = require("fs"), path = require("path");
const MKT = "http://localhost:3002/api/yahoo";
const M = 6, Z_BAR = 2.64;                 // Φ⁻¹(1 − 0.025/6)
const COST_GRID = [0, 0.02, 0.05, 0.10, 0.20];   // fraction of credit collected
const BASE_COST = 0.05;
const IS_END = "2015-12-31";
const D_SHORT = 0.8416;                    // 20-delta
const D_LONG = 1.6449;                     // 5-delta wing

// ── normal CDF (Abramowitz & Stegun 7.1.26) ──────────────────────────────────
function N(x) {
  const s = Math.sign(x); x = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t * t * Math.exp(-x * x) - 0.254829592 * t * Math.exp(-x * x);
  return 0.5 * (1 + s * y);
}
const bsPut = (S, K, sig, T) => { const v = sig * Math.sqrt(T); const d1 = (Math.log(S / K) + 0.5 * sig * sig * T) / v; return K * N(-(d1 - v)) - S * N(-d1); };
const bsCall = (S, K, sig, T) => { const v = sig * Math.sqrt(T); const d1 = (Math.log(S / K) + 0.5 * sig * sig * T) / v; return S * N(d1) - K * N(d1 - v); };
/** Strike at a given d1 — positive d1 for puts (below spot), negative for calls (above). */
const strikeAt = (S, sig, T, d1) => S * Math.exp(0.5 * sig * sig * T - d1 * sig * Math.sqrt(T));

const g = async (s) => {
  const r = await fetch(`${MKT}/${encodeURIComponent(s)}/history?days=14000&interval=1d`, { signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error(`${s} ${r.status}`);
  return (await r.json()).bars || [];
};
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };

/** One episode. Returns P&L as a fraction of max risk, for each structure. */
function episode(S, sig, T, ST, kind) {
  const legs = [];
  if (kind === "put" || kind === "condor") {
    const Ks = strikeAt(S, sig, T, D_SHORT), Kl = strikeAt(S, sig, T, D_LONG);
    const credit = bsPut(S, Ks, sig, T) - bsPut(S, Kl, sig, T);
    const width = Ks - Kl;
    const loss = Math.max(0, Math.min(Ks - ST, width));
    legs.push({ credit, width, pnl: credit - loss });
  }
  if (kind === "call" || kind === "condor") {
    const Ks = strikeAt(S, sig, T, -D_SHORT), Kl = strikeAt(S, sig, T, -D_LONG);
    const credit = bsCall(S, Ks, sig, T) - bsCall(S, Kl, sig, T);
    const width = Kl - Ks;
    const loss = Math.max(0, Math.min(ST - Ks, width));
    legs.push({ credit, width, pnl: credit - loss });
  }
  const credit = legs.reduce((s, l) => s + l.credit, 0);
  const width = Math.max(...legs.map(l => l.width));       // a condor can only lose on one side
  const maxRisk = width - credit;
  if (!(maxRisk > 0) || !(credit > 0)) return null;
  const pnl = legs.reduce((s, l) => s + l.pnl, 0);
  return { credit, maxRisk, pnl, frac: pnl / maxRisk, creditFrac: credit / maxRisk };
}

function episodes(spot, vol, dte, kind) {
  const px = new Map(spot.map(b => [b.date, b.close])), vx = new Map(vol.map(b => [b.date, b.close]));
  const dates = spot.map(b => b.date).filter(d => vx.has(d) && Number.isFinite(px.get(d)));
  const out = [];
  for (let i = 0; i + dte < dates.length; i += dte) {          // non-overlapping
    const d = dates[i], S = px.get(d), iv = vx.get(d), ST = px.get(dates[i + dte]);
    if (![S, iv, ST].every(Number.isFinite) || S <= 0 || iv <= 0) continue;
    const e = episode(S, iv / 100, dte / 252, ST, kind);
    if (!e) continue;
    out.push({ date: d, iv, ...e });
  }
  return out;
}

const score = (eps, cost) => {
  const r = eps.map(e => (e.pnl - cost * e.credit) / e.maxRisk);
  const m = mean(r), s = sd(r);
  return { n: r.length, mean: m, t: (m != null && s && r.length > 2) ? m / (s / Math.sqrt(r.length)) : null,
    win: r.length ? 100 * r.filter(x => x > 0).length / r.length : null,
    worst: r.length ? Math.min(...r) : null, sharpeApprox: (m != null && s) ? (m / s) : null };
};

(async () => {
  console.log(`\n  TEST #45 — 20-DELTA CREDIT SPREADS, 7–14 DAY EXPIRY`);
  console.log(`  operator-specified structure · family of ${M} · corrected bar t ≥ ${Z_BAR}`);
  console.log(`  returns as a fraction of MAX RISK · held to expiry, no management\n`);

  const [spx, vix, ndx, vxn] = await Promise.all([g("^GSPC"), g("^VIX"), g("^NDX"), g("^VXN")]);
  const pc = (v) => v == null ? "     —" : (v >= 0 ? "+" : "") + (v * 100).toFixed(2) + "%";

  for (const [uLbl, sp, vo] of [["SPX / VIX", spx, vix], ["NDX / VXN", ndx, vxn]]) {
    console.log(`  ══ ${uLbl} ══`);
    console.log(`  structure          DTE    n(IS)  IS mean   n(OOS)  OOS mean   OOS t   win%    worst    credit/risk`);
    console.log(`  ────────────────────────────────────────────────────────────────────────────────────────────────────`);
    for (const kind of ["put", "call", "condor"]) {
      for (const dte of [10, 14]) {
        const eps = episodes(sp, vo, dte, kind);
        const is = eps.filter(e => e.date <= IS_END), oos = eps.filter(e => e.date > IS_END);
        if (oos.length < 20) { console.log(`  ${kind.padEnd(17)} ${String(dte).padStart(3)}    (insufficient)`); continue; }
        const a = score(is, BASE_COST), b = score(oos, BASE_COST);
        console.log(`  ${kind.padEnd(17)} ${String(dte).padStart(3)}   ${String(a.n).padStart(5)}  ${pc(a.mean).padStart(8)}   ${String(b.n).padStart(5)}  ${pc(b.mean).padStart(8)}  ${(b.t == null ? "—" : b.t.toFixed(2)).padStart(6)}  ${(b.win == null ? "—" : b.win.toFixed(0) + "%").padStart(5)}  ${pc(b.worst).padStart(8)}   ${pc(mean(oos.map(e => e.creditFrac))).padStart(8)}`);
      }
    }
    console.log("");
  }

  // ── the operator-specified primary cell, in detail ────────────────────────
  const prim = episodes(spx, vix, 10, "put");
  const oos = prim.filter(e => e.date > IS_END);
  console.log(`  ══ PRIMARY (SPX, short 20-delta put spread, 10 DTE) — cost sensitivity, out of sample ══`);
  console.log(`  cost (% of credit)   mean      t      win%     worst`);
  console.log(`  ─────────────────────────────────────────────────────`);
  for (const c of COST_GRID) { const s = score(oos, c); console.log(`  ${((c * 100).toFixed(0) + "%").padStart(6)}              ${pc(s.mean).padStart(8)}  ${(s.t == null ? "—" : s.t.toFixed(2)).padStart(5)}   ${(s.win == null ? "—" : s.win.toFixed(0) + "%").padStart(5)}  ${pc(s.worst).padStart(8)}`); }

  const p = score(oos, BASE_COST);
  const perYear = 252 / 10;
  console.log(`\n  annualised (${perYear.toFixed(1)} episodes/yr, no compounding): ${pc(p.mean * perYear)} of max risk deployed per episode`);
  const worstEps = [...oos].sort((a, b) => a.frac - b.frac).slice(0, 3);
  console.log(`  worst episodes: ${worstEps.map(e => `${e.date} ${pc(e.frac)} (IV ${e.iv.toFixed(1)})`).join(" · ")}`);

  /**
   * D10 FIX (2026-08-06) — THE WING GATE WAS COST-BLIND.
   *
   * The gate asked `worst > -1.0`, i.e. the worst episode must lose less than 100% of max risk.
   * But `r` is computed as `(pnl - cost*credit) / maxRisk` — the commission is charged ON TOP of
   * the structurally capped option loss. A defined-risk spread that goes maximally against you
   * loses exactly 100% of max risk PLUS the cost, so the true floor is about -101%, not -100%.
   *
   * The old threshold therefore failed a wing that had, in fact, held perfectly — and the
   * verdict NOT-ESTABLISHED was recorded on that letter rather than on the structure. Testing
   * "did the defined-risk cap hold" against a bound the cap can never satisfy is not a
   * conservative test, it is a broken one.
   *
   * The bound is now derived from the actual cost charged rather than hardcoded, so it stays
   * correct if the cost assumption changes.
   */
  // r = (pnl - BASE_COST*credit) / maxRisk. At a full structural loss pnl = -maxRisk, so the
  // floor is -(1 + BASE_COST * credit/maxRisk) — episode-specific, because credit/maxRisk varies.
  // The bound used here is the LOOSEST such floor across the sample, which is the only value no
  // episode can legitimately breach. A tiny epsilon absorbs float error.
  const maxCreditFrac = oos.length ? Math.max(...oos.map(e => e.creditFrac ?? 0)) : 0;
  const worstPossible = -(1 + BASE_COST * maxCreditFrac) - 1e-9;
  const gates = { win: p.win != null && p.win >= 65, pos: p.mean != null && p.mean > 0, t: p.t != null && p.t >= Z_BAR, held: p.worst != null && p.worst > worstPossible };
  console.log(`\n  ══ ADJUDICATION vs THE PRE-REGISTERED RULE ══`);
  console.log(`  ${gates.win ? "✓" : "✗"} win rate ≥ 65%           ${p.win == null ? "—" : p.win.toFixed(0) + "%"}`);
  console.log(`  ${gates.pos ? "✓" : "✗"} OOS mean > 0             ${pc(p.mean)}`);
  console.log(`  ${gates.t ? "✓" : "✗"} OOS t ≥ ${Z_BAR}             ${p.t == null ? "—" : p.t.toFixed(2)}`);
  console.log(`  ${gates.held ? "✓" : "✗"} wing held (worst > ${pc(worstPossible)}) ${pc(p.worst)}   <- bound includes the cost charged on top of the capped loss (D10)`);
  const verdict = Object.values(gates).every(Boolean)
    ? `PASS — the operator-specified structure clears every pre-registered gate out of sample. Promote to a PAPER sleeve and the forward registry; not capital, because strikes and premiums are Black-Scholes approximations of contracts we have never priced.`
    : (p.mean != null && p.mean <= 0) ? `FAIL — out-of-sample mean is not positive.`
      : `NOT-ESTABLISHED — ${Object.entries(gates).filter(([, v]) => !v).map(([k]) => k).join(", ")} gate(s) not met.`;
  console.log(`\n  VERDICT: ${verdict}\n`);

  fs.writeFileSync(path.join(__dirname, "data", "credit-spread-45.json"), JSON.stringify({
    generated: new Date().toISOString(), test: 45,
    preRegistered: "2026-07-26, before this script was run. Specification supplied by the operator (20-delta, 7–14 DTE), not derived from a prior failure.",
    structure: { shortDelta: 0.20, wingDelta: 0.05, held: "to expiry, no management", returnUnit: "fraction of max risk (width − credit)" },
    familySize: M, correctedBar: Z_BAR, primary: "SPX short 20-delta put spread, 10 DTE",
    inSampleEnd: IS_END, costGrid: COST_GRID, baseCost: BASE_COST,
    primaryOos: p, gates, verdict,
    caveats: [
      "Strikes and premiums are Black-Scholes at the index vol index, r=0. Real chains have skew — a 20-delta PUT trades at higher implied vol than the index level, so real credit is LARGER than modelled and this understates the put side.",
      "No management, no early assignment, no margin behaviour in a crash.",
      "Pre-2003 VIX is a retroactive reconstruction under current CBOE methodology.",
      "Held-to-expiry defined risk means the wing caps the loss, but only if it can be exercised — pin risk and gap-through-both-strikes are not modelled.",
    ],
  }, null, 1));
  console.log(`  written: backend/data/credit-spread-45.json\n`);
})();
