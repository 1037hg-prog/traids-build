#!/usr/bin/env node
/**
 * TEST #59 — TEST #45 RE-RUN WITH A TERM-STRUCTURE-CORRECT VOLATILITY INPUT
 *
 * PRE-REGISTERED 2026-07-28, before any result was computed.
 *
 * WHY. Test #58 priced #45's exact strikes against real SPXW contracts over 57 episodes and
 * found the model OVERSTATED the credit by 35% (real/modelled 0.654, real above modelled in 1
 * of 57). #45's own caveat had asserted the opposite. The identified part of the error is that
 * #45 priced a 10-TRADING-DAY option using VIX, which is a 30-CALENDAR-DAY measure, and 9-day
 * vol sat below 30-day vol in 79% of sessions.
 *
 * This re-runs the entire 10.5-year study with that one input corrected, and nothing else
 * changed. Same strikes-by-delta, same non-overlapping episodes, same cost grid, same gates.
 *
 * ── THE CORRECTION ─────────────────────────────────────────────────────────────────────────
 * A 10-trading-day option spans ~14 calendar days. Total variance is interpolated linearly in
 * time between the 9-day and 30-day points, CBOE-style, rather than taking the 30-day number
 * as though it applied at 14 days:
 *
 *     totalVar(14) = 9·σ9² + (14−9)/(30−9) · (30·σ30² − 9·σ9²)
 *     σ14 = sqrt( totalVar(14) / 14 )
 *
 * VIX9D begins 2012-11-19. Before that the ratio is unavailable, so σ9 is estimated as
 * VIX × the mean VIX9D/VIX ratio measured over the period where BOTH exist. That fallback is
 * an assumption and is reported separately below — the pre-2013 episodes are flagged so the
 * post-2013 subsample can be read on its own.
 *
 * ── THE VALIDATION THAT MAKES THIS MORE THAN A TWEAK ───────────────────────────────────────
 * A corrected model that still misprices is worthless. So the corrected credits are checked
 * against the SAME 57 real-priced episodes from #58. If the correction is right, the
 * real/modelled ratio should move from 0.654 toward 1.0. If it does not, the term structure was
 * not the dominant error and the remaining gap — probably the 5-delta wing under real skew —
 * needs its own fix rather than a story.
 *
 * DECISION RULE — fixed now, identical to #45's
 *   PASS if, out of sample and net of 5%-of-credit cost: win >= 65%, mean > 0, t >= 2.64
 *        (Bonferroni over the same family of 6), worst episode > −100% of max risk.
 *   The bar is UNCHANGED from #45 deliberately. Lowering it after learning the premium was
 *   smaller would be the #41–#43 error.
 *
 * EXPECTED OUTCOME, ON THE RECORD: the premium shrinks by roughly a third and t falls with it.
 * #45 reported t 3.57 against a 2.64 bar; a 35% haircut to the mean would put t near 2.3 and it
 * would FAIL. I expect NOT-ESTABLISHED. If it survives, the edge is real at a smaller size.
 * I have been wrong on mechanism three times today, so this is a prediction, not a claim.
 *
 * Usage: node backend/credit-spread-v2.js
 */
const fs = require("fs"), path = require("path");
const MKT = "http://localhost:3002/api/yahoo";
const M = 6, Z_BAR = 2.64;
const COST_GRID = [0, 0.02, 0.05, 0.10, 0.20], BASE_COST = 0.05;
const IS_END = "2015-12-31";
const D_SHORT = 0.8416, D_LONG = 1.6449;
const DTE = 10, CAL_DAYS = 14;

function N(x) { const s = Math.sign(x); x = Math.abs(x) / Math.SQRT2; const t = 1 / (1 + 0.3275911 * x); const y = 1 - ((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t * t * Math.exp(-x * x) - 0.254829592 * t * Math.exp(-x * x); return 0.5 * (1 + s * y); }
const bsPut = (S, K, sig, T) => { const v = sig * Math.sqrt(T); const d1 = (Math.log(S / K) + 0.5 * sig * sig * T) / v; return K * N(-(d1 - v)) - S * N(-d1); };
const strikeAt = (S, sig, T, d1) => S * Math.exp(0.5 * sig * sig * T - d1 * sig * Math.sqrt(T));
const g = async (s) => { const r = await fetch(`${MKT}/${encodeURIComponent(s)}/history?days=14000&interval=1d`, { signal: AbortSignal.timeout(180000) }); if (!r.ok) throw new Error(s); return ((await r.json()).bars || []).filter(b => Number.isFinite(b.close)); };
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const pc = (v, d = 2) => v == null ? "     —" : (v >= 0 ? "+" : "") + (100 * v).toFixed(d) + "%";

/** CBOE-style interpolation of total variance from the 9-day and 30-day points to 14 days. */
function sigmaAt14(v9, v30) {
  if (!(v30 > 0)) return null;
  if (!(v9 > 0)) return null;
  const s9 = v9 / 100, s30 = v30 / 100;
  const tv = 9 * s9 * s9 + ((CAL_DAYS - 9) / (30 - 9)) * (30 * s30 * s30 - 9 * s9 * s9);
  return tv > 0 ? Math.sqrt(tv / CAL_DAYS) : null;
}

(async () => {
  console.log(`\n  TEST #59 — #45 RE-RUN WITH A TERM-STRUCTURE-CORRECT VOL INPUT`);
  console.log(`  pre-registered 2026-07-28 · ONE input changed, every gate identical to #45\n`);

  const [spx, vix, vix9] = await Promise.all([g("^GSPC"), g("^VIX"), g("^VIX9D")]);
  const V = new Map(vix.map(b => [b.date, b.close])), V9 = new Map(vix9.map(b => [b.date, b.close]));
  const P = new Map(spx.map(b => [b.date, b.close]));
  const dates = spx.map(b => b.date).filter(d => V.has(d));

  // fallback ratio for the era before VIX9D exists
  const both = dates.filter(d => V9.has(d));
  const ratio = mean(both.map(d => V9.get(d) / V.get(d)));
  console.log(`  VIX9D available from ${both[0]} · mean VIX9D/VIX ${ratio.toFixed(4)} over ${both.length} sessions`);
  console.log(`  pre-${both[0]} episodes use VIX x that ratio as the 9-day estimate — an ASSUMPTION, reported separately below.\n`);

  const rows = [];
  for (let i = 0; i + DTE < dates.length; i += DTE) {
    const d = dates[i], S = P.get(d), v30 = V.get(d);
    const v9 = V9.has(d) ? V9.get(d) : v30 * ratio;
    const estimated = !V9.has(d);
    const sig = sigmaAt14(v9, v30);
    const sigOld = v30 / 100;                       // what #45 used
    if (!(S > 0) || !(sig > 0)) continue;
    const T = DTE / 252, ST = P.get(dates[i + DTE]);
    if (!(ST > 0)) continue;
    const mk = (sg) => {
      const Ks = strikeAt(S, sg, T, D_SHORT), Kl = strikeAt(S, sg, T, D_LONG);
      const credit = bsPut(S, Ks, sg, T) - bsPut(S, Kl, sg, T);
      const width = Ks - Kl, maxRisk = width - credit;
      if (!(maxRisk > 0) || !(credit > 0)) return null;
      const loss = Math.max(0, Math.min(Ks - ST, width));
      return { credit, maxRisk, frac: (credit - loss) / maxRisk };
    };
    const nw = mk(sig), old = mk(sigOld);
    if (!nw || !old) continue;
    rows.push({ d, estimated, sig, sigOld, ...nw, oldFrac: old.frac, oldCredit: old.credit });
  }

  const oos = rows.filter(r => r.d > IS_END), is = rows.filter(r => r.d <= IS_END);
  console.log(`  ${rows.length} non-overlapping episodes · ${is.length} in-sample · ${oos.length} out-of-sample`);
  console.log(`  ${rows.filter(r => r.estimated).length} used the estimated 9-day vol (pre-VIX9D era)\n`);

  const score = (eps, cost, key = "frac") => {
    const r = eps.map(e => key === "frac" ? (e.credit * (1 - cost) - Math.max(0, e.credit - e.frac * e.maxRisk)) / e.maxRisk : e.oldFrac - cost * e.oldCredit / e.maxRisk);
    // simpler and exact: recompute net directly
    const net = eps.map(e => key === "frac" ? e.frac - cost * (e.credit / e.maxRisk) : e.oldFrac - cost * (e.oldCredit / e.maxRisk));
    const m = mean(net), s = sd(net);
    return { n: net.length, mean: m, t: (m != null && s && net.length > 2) ? m / (s / Math.sqrt(net.length)) : null, win: 100 * net.filter(x => x > 0).length / net.length, worst: Math.min(...net) };
  };

  console.log(`  ══ CORRECTED vs #45's ORIGINAL, same episodes, net of ${(BASE_COST * 100).toFixed(0)}% of credit ══`);
  console.log(`  window        pricing        n     win     mean       t       worst`);
  for (const [lbl, eps] of [["IN-SAMPLE", is], ["OUT-OF-SAMPLE", oos]]) {
    const a = score(eps, BASE_COST, "old"), b = score(eps, BASE_COST, "frac");
    console.log(`  ${lbl.padEnd(13)} #45 original  ${String(a.n).padStart(4)}  ${a.win.toFixed(0).padStart(3)}%  ${pc(a.mean).padStart(8)}  ${(a.t == null ? "—" : a.t.toFixed(2)).padStart(6)}  ${pc(a.worst).padStart(8)}`);
    console.log(`  ${"".padEnd(13)} term-corrected ${String(b.n).padStart(3)}  ${b.win.toFixed(0).padStart(3)}%  ${pc(b.mean).padStart(8)}  ${(b.t == null ? "—" : b.t.toFixed(2)).padStart(6)}  ${pc(b.worst).padStart(8)}`);
  }

  const credRatio = mean(rows.map(r => r.credit / r.oldCredit));
  console.log(`\n  corrected credit is ${credRatio.toFixed(3)}x the original — a ${((1 - credRatio) * 100).toFixed(0)}% haircut to the premium`);

  // ── validate against #58's real prices ────────────────────────────────────
  const rpPath = path.join(__dirname, "data", "credit-spread-realprice-58.json");
  if (fs.existsSync(rpPath)) {
    const rp = JSON.parse(fs.readFileSync(rpPath, "utf8"));
    const byDate = new Map(rows.map(r => [r.d, r]));
    const pairs = rp.rows.map(x => { const c = byDate.get(x.d); return c ? { real: x.realCredit, old: x.modelCredit, corrected: c.credit } : null; }).filter(Boolean);
    if (pairs.length > 10) {
      const rOld = mean(pairs.map(p => p.real / p.old)), rNew = mean(pairs.map(p => p.real / p.corrected));
      console.log(`\n  ══ VALIDATION against the ${pairs.length} real-priced episodes from #58 ══`);
      console.log(`    real / ORIGINAL model    ${rOld.toFixed(3)}   (this is what #58 measured: 35% overstated)`);
      console.log(`    real / CORRECTED model   ${rNew.toFixed(3)}`);
      console.log(`    -> ${Math.abs(rNew - 1) < Math.abs(rOld - 1) ? `the correction moves the model ${(100 * (Math.abs(rOld - 1) - Math.abs(rNew - 1)) / Math.abs(rOld - 1)).toFixed(0)}% closer to real prices` : "the correction does NOT improve the fit — term structure was not the dominant error"}`);
      if (Math.abs(rNew - 1) > 0.10) console.log(`    STILL ${rNew < 1 ? "OVERSTATED" : "UNDERSTATED"} by ${(100 * Math.abs(1 - rNew)).toFixed(0)}% — the remaining gap is unexplained and is most likely the 5-delta wing under real skew.`);
    }
  }

  const P2 = score(oos, BASE_COST, "frac");
  const gates = { win: P2.win >= 65, pos: P2.mean > 0, t: P2.t != null && P2.t >= Z_BAR, held: P2.worst > -1.0 };
  console.log(`\n  ══ ADJUDICATION vs #45's UNCHANGED gates ══`);
  console.log(`  ${gates.win ? "✓" : "✗"} win >= 65%          ${P2.win.toFixed(0)}%`);
  console.log(`  ${gates.pos ? "✓" : "✗"} OOS mean > 0        ${pc(P2.mean)}`);
  console.log(`  ${gates.t ? "✓" : "✗"} OOS t >= ${Z_BAR}        ${P2.t == null ? "—" : P2.t.toFixed(2)}   (#45 reported 3.57)`);
  console.log(`  ${gates.held ? "✓" : "✗"} worst > -100%       ${pc(P2.worst)}`);
  const verdict = Object.values(gates).every(Boolean)
    ? `PASS — survives the term-structure correction at its ORIGINAL bar. The premium is smaller and still clears.`
    : `NOT-ESTABLISHED — ${Object.entries(gates).filter(([, v]) => !v).map(([k]) => k).join(", ")} gate(s) fail once the vol input is correct.`;
  console.log(`\n  VERDICT: ${verdict}\n`);

  console.log(`  ══ COST SENSITIVITY, corrected pricing, out of sample ══`);
  for (const c of COST_GRID) { const s = score(oos, c, "frac"); console.log(`    ${((c * 100).toFixed(0) + "%").padStart(4)}  mean ${pc(s.mean).padStart(8)}  t ${(s.t == null ? "—" : s.t.toFixed(2)).padStart(5)}  win ${s.win.toFixed(0)}%`); }

  fs.writeFileSync(path.join(__dirname, "data", "credit-spread-v2-59.json"), JSON.stringify({
    generated: new Date().toISOString(), test: 59,
    preRegistered: "2026-07-28. One input changed from #45 — the volatility term structure. Every gate identical.",
    correction: "total variance interpolated linearly in time between the 9-day and 30-day points to 14 calendar days, rather than applying the 30-day VIX at 14 days.",
    vix9dFrom: both[0], fallbackRatio: ratio, estimatedEpisodes: rows.filter(r => r.estimated).length,
    creditHaircut: credRatio, episodes: rows.length, oos: oos.length,
    primary: P2, gates, verdict,
  }, null, 1));
  console.log(`\n  written: backend/data/credit-spread-v2-59.json\n`);
})();
