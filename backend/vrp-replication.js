#!/usr/bin/env node
/**
 * TEST #42 — REPLICATION of the 10-session short-vol premium on evidence NOT used in test #41.
 *
 * PRE-REGISTERED 2026-07-25, before this script was run against either evidence set.
 *
 * WHY THIS TEST EXISTS, AND WHY IT CANNOT USE THE OLD DATA
 *   Test #41 declared a family of 9 and adjudicated its PRIMARY cell (21 sessions, always-on)
 *   as NOT-ESTABLISHED: out-of-sample t = 2.65 against a pre-registered bar of 2.77. One
 *   non-primary cell — 10 sessions, always-on — cleared the corrected bar at t = 3.22.
 *
 *   That cell was chosen BECAUSE it scored highest. Re-running it on the same 2001–2026 data
 *   would not be a test: the answer is already known, and "pre-registering" a specification
 *   selected on its own result is circular no matter how the header is worded. The only honest
 *   way to promote it is to demand it REPLICATE on evidence that had no influence on its
 *   selection.
 *
 * SPECIFICATION — fixed, single, no family of horizons or filters this time
 *   Short a 10-session delta-neutral ATM straddle, priced at the index's own volatility index,
 *   always-on, cost 5% of premium collected. Identical payoff model to test #41:
 *       P&L% = 0.7979 · σ_impl · √(10/252)  −  |S_T/S_0 − 1|
 *   Non-overlapping episodes only. No parameter is free to move.
 *
 * EVIDENCE SETS — declared before running, family size 2, corrected bar t ≥ 2.24
 *   E1  SPX / VIX, 1990-01-02 → 2001-12-03. STRICTLY EARLIER than test #41's sample, which
 *       began 2001-12-04. Contains the 1997 Asian crisis, 1998 LTCM and the 2000 peak. This is
 *       the strong evidence set: it could not have influenced the choice of the 10-day horizon.
 *   E2  NDX / VXN, full history. A DIFFERENT UNDERLYING. Overlaps in time with test #41, so it
 *       is only partially independent — the same crashes hit both indices. Reported as
 *       corroboration, weighted below E1, and this limitation is stated rather than buried.
 *
 * KNOWN DATA CAVEAT, recorded before seeing any result
 *   CBOE's current VIX methodology dates from 2003 and was back-computed to 1990. The E1
 *   "implied vol" is therefore a RETROACTIVE RECONSTRUCTION from historical option prices, not
 *   a level a trader could have sold in real time. It is built from real quotes, so it is
 *   evidence — but a premium measured against a reconstructed index is weaker than one
 *   measured against a live tradable quote, and it is not treated as equivalent.
 *
 * DECISION RULE — replication demands BOTH sets, not the better of two
 *   PASS   if mean net P&L > 0 in BOTH sets AND t ≥ 2.24 in BOTH AND the worst single episode
 *          in each is < 25% of notional.
 *   FAIL   if either set is negative, or either worst episode exceeds 50% of notional.
 *   Otherwise NOT-ESTABLISHED.
 *   "At least one of two" is explicitly NOT the rule. Accepting the better of two sets would
 *   make this a search with n=2 rather than a replication, which is the exact error that put
 *   the 10-day cell in this position.
 *
 * ON A PASS: this becomes a candidate for a PAPER sleeve on forward-collected chains, still
 * not a funding decision. On a FAIL or NOT-ESTABLISHED the 10-day result is recorded as
 * non-replicating and the file closes.
 *
 * Usage:  node backend/vrp-replication.js
 */
const fs = require("fs");
const path = require("path");

const MKT = "http://localhost:3002/api/yahoo";
const H = 10;                        // sessions — FIXED
const COST = 0.05;                   // fraction of premium — FIXED baseline
const COST_GRID = [0, 0.02, 0.05, 0.10, 0.20];
const M = 2;                         // evidence sets
const Z_BAR = 2.24;                  // Φ⁻¹(1 − 0.025/2)
const PHI0 = 0.3989422804014327;
const STRADDLE_K = 2 * PHI0;
const T41_START = "2001-12-04";      // test #41's sample began here; E1 must end before it

const g = async (s) => {
  const r = await fetch(`${MKT}/${encodeURIComponent(s)}/history?days=14000&interval=1d`, { signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error(`${s} HTTP ${r.status}`);
  return (await r.json()).bars || [];
};
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };

/** Non-overlapping episodes for one (index, vol-index) pair inside a date window. */
function episodes(spot, vol, from, to) {
  const px = new Map(spot.map(b => [b.date, b.close]));
  const vx = new Map(vol.map(b => [b.date, b.close]));
  const dates = spot.map(b => b.date).filter(d => d >= from && d <= to && vx.has(d) && Number.isFinite(px.get(d)));
  const out = [];
  for (let i = 0; i + H < dates.length; i += H) {         // step H → no overlap
    const d = dates[i], s0 = px.get(d), sig = vx.get(d), sT = px.get(dates[i + H]);
    if (![s0, sig, sT].every(Number.isFinite) || s0 <= 0) continue;
    const premium = STRADDLE_K * (sig / 100) * Math.sqrt(H / 252);
    const loss = Math.abs(sT / s0 - 1);
    out.push({ date: d, vix: sig, premium, loss, gross: premium - loss });
  }
  return out;
}

function score(eps, cost) {
  const r = eps.map(e => e.gross - cost * e.premium);
  const m = mean(r), s = sd(r);
  return {
    n: r.length, mean: m, sd: s,
    t: (m != null && s && r.length > 2) ? m / (s / Math.sqrt(r.length)) : null,
    sharpe: (m != null && s) ? (m / s) * Math.sqrt(252 / H) : null,
    winPct: r.length ? 100 * r.filter(x => x > 0).length / r.length : null,
    worst: r.length ? Math.min(...r) : null,
    worstEp: eps.length ? eps.reduce((w, e) => (w && w.gross <= e.gross ? w : e), null) : null,
  };
}

(async () => {
  console.log(`\n  TEST #42 — REPLICATION: 10-session short-vol premium on untouched evidence`);
  console.log(`  specification FIXED before running · ${M} evidence sets · corrected bar t ≥ ${Z_BAR}`);
  console.log(`  replication rule: BOTH sets must pass. "Better of two" is not the rule.\n`);

  const [vix, spx, vxn, ndx] = await Promise.all([g("^VIX"), g("^GSPC"), g("^VXN"), g("^NDX")]);
  console.log(`  ^VIX  ${vix.length} bars ${vix[0]?.date} → ${vix[vix.length - 1]?.date}`);
  console.log(`  ^VXN  ${vxn.length} bars ${vxn[0]?.date} → ${vxn[vxn.length - 1]?.date}`);

  const E1 = episodes(spx, vix, "1900-01-01", "2001-12-03");     // strictly before test #41
  const E2 = episodes(ndx, vxn, "1900-01-01", "2100-01-01");

  // Assert the independence claim rather than trusting the comment.
  const e1Last = E1.length ? E1[E1.length - 1].date : null;
  const overlaps = e1Last != null && e1Last >= T41_START;
  console.log(`\n  E1 independence check: last E1 episode ${e1Last} vs test #41 sample start ${T41_START} → ${overlaps ? "✗ OVERLAP" : "✓ disjoint"}`);
  if (overlaps) { console.log(`\n  ✗ refusing to report a replication on overlapping data\n`); process.exit(1); }

  const sets = [
    { key: "E1", label: "SPX / VIX 1990–2001 (untouched by #41)", eps: E1, strong: true },
    { key: "E2", label: "NDX / VXN (different underlying)", eps: E2, strong: false },
  ];

  const pc = (v) => v == null ? "     —" : (v >= 0 ? "+" : "") + (v * 100).toFixed(2) + "%";
  console.log(`\n  ══ RESULTS — 10 sessions, always-on, net of ${(COST * 100)}% of premium ══`);
  console.log(`  set  evidence                                 n   mean P&L      t    Sharpe   win%     worst`);
  console.log(`  ──────────────────────────────────────────────────────────────────────────────────────────────`);
  const scored = sets.map(s => ({ ...s, s: score(s.eps, COST) }));
  for (const x of scored) {
    const v = x.s;
    console.log(`  ${x.key}   ${x.label.padEnd(38)} ${String(v.n).padStart(4)}   ${pc(v.mean).padStart(8)}   ${(v.t == null ? "—" : v.t.toFixed(2)).padStart(5)}   ${(v.sharpe == null ? "—" : v.sharpe.toFixed(2)).padStart(6)}   ${(v.winPct == null ? "—" : v.winPct.toFixed(0) + "%").padStart(5)}  ${pc(v.worst).padStart(8)}`);
  }

  console.log(`\n  ══ COST SENSITIVITY (both sets) ══`);
  console.log(`  cost      E1 mean     E1 t      E2 mean     E2 t`);
  console.log(`  ──────────────────────────────────────────────────`);
  for (const c of COST_GRID) {
    const a = score(E1, c), b = score(E2, c);
    console.log(`  ${((c * 100).toFixed(0) + "%").padStart(4)}    ${pc(a.mean).padStart(8)}   ${(a.t == null ? "—" : a.t.toFixed(2)).padStart(6)}    ${pc(b.mean).padStart(8)}   ${(b.t == null ? "—" : b.t.toFixed(2)).padStart(6)}`);
  }

  console.log(`\n  ══ WORST EPISODES — the entry conditions matter more than the losses ══`);
  for (const x of scored) {
    const w = x.s.worstEp;
    console.log(`  ${x.key}  ${pc(w?.gross)} on ${w?.date}, entered at vol index ${w?.vix?.toFixed(1)}`);
  }

  // ── adjudication ─────────────────────────────────────────────────────────
  const gate = (v) => ({ positive: v.mean != null && v.mean > 0, sig: v.t != null && v.t >= Z_BAR, survivable: v.worst != null && Math.abs(v.worst) < 0.25 });
  const g1 = gate(scored[0].s), g2 = gate(scored[1].s);
  const bothPositive = g1.positive && g2.positive;
  const bothSig = g1.sig && g2.sig;
  const bothSurvivable = g1.survivable && g2.survivable;
  const anyBlowup = [scored[0].s, scored[1].s].some(v => v.worst != null && Math.abs(v.worst) > 0.50);
  const anyNegative = !bothPositive;

  console.log(`\n  ══ ADJUDICATION vs THE PRE-REGISTERED RULE ══`);
  console.log(`  ${bothPositive ? "✓" : "✗"} mean net P&L > 0 in BOTH sets            E1 ${pc(scored[0].s.mean)} · E2 ${pc(scored[1].s.mean)}`);
  console.log(`  ${bothSig ? "✓" : "✗"} t ≥ ${Z_BAR} in BOTH sets                     E1 ${scored[0].s.t?.toFixed(2) ?? "—"} · E2 ${scored[1].s.t?.toFixed(2) ?? "—"}`);
  console.log(`  ${bothSurvivable ? "✓" : "✗"} worst episode < 25% of notional in BOTH  E1 ${pc(scored[0].s.worst)} · E2 ${pc(scored[1].s.worst)}`);

  const verdict = (bothPositive && bothSig && bothSurvivable)
    ? "REPLICATED — the 10-session specification holds on evidence that had no part in selecting it. Candidate for a PAPER sleeve on forward-collected chains. Still not a funding decision: the payoff remains a Black-Scholes approximation and real option costs are unmeasured."
    : (anyNegative || anyBlowup)
      ? `FAILED TO REPLICATE — ${anyNegative ? "at least one evidence set is not positive" : "an evidence set blows through 50% of notional"}. The 10-day result from test #41 is recorded as non-replicating; the file closes.`
      : `NOT-ESTABLISHED — positive and survivable, but ${!bothSig ? "significance is not reached in both sets" : "a survivability gate failed"}. Not promoted. Note this is the SECOND consecutive not-established on this premium, which is itself information: the effect is real and small enough that it keeps landing near the bar.`;
  console.log(`\n  VERDICT: ${verdict}\n`);

  fs.writeFileSync(path.join(__dirname, "data", "vrp-replication-42.json"), JSON.stringify({
    generated: new Date().toISOString(), test: 42,
    preRegistered: "2026-07-25, before this script was run against either evidence set",
    motivation: "Test #41's 10-session cell was selected on its own result; promoting it requires replication on evidence that did not influence that selection.",
    specification: { horizon: H, rule: "always-on", cost: COST, payoff: "0.7979·σ·√(H/252) − |S_T/S_0 − 1|", nonOverlapping: true },
    familySize: M, correctedBar: Z_BAR,
    evidence: scored.map(x => ({ key: x.key, label: x.label, independent: x.strong, n: x.s.n, mean: x.s.mean, t: x.s.t, sharpe: x.s.sharpe, winPct: x.s.winPct, worst: x.s.worst, worstDate: x.s.worstEp?.date, worstEntryVol: x.s.worstEp?.vix })),
    costGrid: COST_GRID.map(c => ({ cost: c, e1: score(E1, c).mean, e1t: score(E1, c).t, e2: score(E2, c).mean, e2t: score(E2, c).t })),
    gates: { E1: g1, E2: g2 }, verdict,
    caveats: [
      "E1's VIX values before 2003 are a retroactive reconstruction under the current CBOE methodology, not levels that were quoted live.",
      "E2 shares its era with test #41 and the same crashes hit both indices, so it is corroboration rather than independent evidence.",
      "The payoff is a Black-Scholes ATM-straddle approximation. Real XSP bid/ask, assignment and crash-margin behaviour are unmodelled and all subtract.",
    ],
  }, null, 1));
  console.log(`  written: backend/data/vrp-replication-42.json\n`);
})();
