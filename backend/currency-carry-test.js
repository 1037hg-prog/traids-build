#!/usr/bin/env node
/**
 * TEST #54 (structural candidate S6) — CURRENCY CARRY
 *
 * PRE-REGISTERED 2026-07-28. Spec frozen in structural-register.json under "S6" before this
 * file existed: "the differential is contractual and known in advance, not forecast. Uncovered
 * interest parity is one of the most consistently violated relationships in finance."
 *
 * WHO IS ON THE OTHER SIDE. Borrowers who need funding in a low-rate currency, and hedgers who
 * pay to remove currency risk. The interest differential is CONTRACTUAL — set by central banks
 * and known before the position is opened — which is what makes this structural rather than a
 * forecast. Uncovered interest parity says the high-yielder should depreciate by exactly the
 * differential. It persistently doesn't.
 *
 * WHAT WOULD STOP IT (pre-registered): the payoff is short a crash. Carry pays steadily and then
 * returns years of gains in one deleveraging — the same inverted shape as premium selling, with
 * the same tail. That is why the drawdown gate matters more here than the mean.
 *
 * ── THE VEHICLE, AND WHY IT NEEDS NO POLICY-RATE DATA ──────────────────────────────────────
 * The FX currency trusts (FXA, FXB, FXC, FXE, FXF, FXY) hold interest-bearing deposits in the
 * foreign currency. Their USD net asset value therefore moves with BOTH the spot rate and the
 * accrued local interest. So:
 *
 *     ETF total return − spot FX return  ≈  the local deposit rate (net of the trust's expense)
 *
 * That identity recovers each currency's yield from price data alone, point-in-time, with no
 * paid rate feed. The script VERIFIES it before using it: implied rates are printed per era, and
 * if JPY does not come out near zero through the 2015-2021 ZIRP years the construction is wrong
 * and the test says so rather than proceeding.
 *
 * DESIGN
 *   · Rank the six currencies each month by trailing 63-session implied yield.
 *   · Long the top 2, short the bottom 2, equal weight, dollar-neutral.
 *   · Hold one month. NON-OVERLAPPING formations only — the #52 lesson: overlapping windows
 *     inflate t by roughly sqrt(overlap) and no clustering fixes it.
 *   · Costs charged both legs on every rebalance.
 *
 * DECISION RULE — fixed now
 *   PASS  if mean monthly return > 0, t ≥ 2.50 (Bonferroni over the 4 cost cells tested),
 *         AND max drawdown ≤ 20% (the ceiling set 2026-07-28 in risk-policy.json).
 *   FAIL  if the mean is ≤ 0.
 *   Otherwise NOT-ESTABLISHED.
 *
 * EXPECTED OUTCOME, ON THE RECORD: a positive mean that fails the drawdown gate, exactly as
 * #41/#42/#43/#51 did. Carry and short-vol are the same trade wearing different clothes, and
 * this project has now failed that shape four times. If it passes the drawdown gate, that is a
 * genuine surprise and the first structural PREDICTOR to survive here.
 *
 * Usage: node backend/currency-carry-test.js
 */
const fs = require("fs"), path = require("path");
const MKT = "http://localhost:3002/api/yahoo";
const LOOKBACK = 63, HOLD = 21;
const T_BAR = 2.50;
const COST_GRID = [0, 0.0005, 0.0010, 0.0020];     // per leg, per rebalance
const BASE_COST = 0.0010;
const RISK = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "risk-policy.json"), "utf8"));
const DD_CEILING = RISK.current.hardCeiling;

/**
 * Each trust, with the spot pair that isolates its FX move.
 * `invert` marks pairs quoted USD-base (USDJPY) rather than foreign-base (EURUSD): for those the
 * foreign currency's USD return is the RECIPROCAL of the quoted move. Getting this backwards
 * would flip every implied rate, which is why the verification step below exists.
 */
const CCY = [
  { etf: "FXA", pair: "AUDUSD=X", invert: false, name: "AUD" },
  { etf: "FXB", pair: "GBPUSD=X", invert: false, name: "GBP" },
  { etf: "FXE", pair: "EURUSD=X", invert: false, name: "EUR" },
  { etf: "FXC", pair: "USDCAD=X", invert: true, name: "CAD" },
  { etf: "FXF", pair: "USDCHF=X", invert: true, name: "CHF" },
  { etf: "FXY", pair: "USDJPY=X", invert: true, name: "JPY" },
];

const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const pc = (v, d = 2) => v == null ? "     —" : (v >= 0 ? "+" : "") + (v * 100).toFixed(d) + "%";
const g = async (s) => { const r = await fetch(`${MKT}/${encodeURIComponent(s)}/history?days=9000&interval=1d`, { signal: AbortSignal.timeout(90000) }); if (!r.ok) throw new Error(`${s} ${r.status}`); return ((await r.json()).bars || []).filter(b => Number.isFinite(b.close)); };

function pathStats(rets) {
  let eq = 1, peak = 1, dd = 0;
  for (const r of rets) { eq *= (1 + r); if (eq <= 0) return { cagr: null, maxDD: 1, ruined: true }; peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak); }
  const yrs = rets.length * HOLD / 252;
  return { cagr: yrs > 0 ? Math.pow(eq, 1 / yrs) - 1 : null, maxDD: dd, ruined: false };
}

(async () => {
  console.log(`\n  TEST #54 (S6) — CURRENCY CARRY`);
  console.log(`  pre-registered 2026-07-28 · Bonferroni bar t ≥ ${T_BAR} · drawdown ceiling ${(DD_CEILING * 100).toFixed(0)}%`);
  console.log(`  yields recovered from price data: ETF total return − spot FX return ≈ local deposit rate\n`);

  const data = {};
  for (const c of CCY) {
    const [e, p] = await Promise.all([g(c.etf), g(c.pair)]);
    data[c.name] = { etf: new Map(e.map(b => [b.date, b.close])), spot: new Map(p.map(b => [b.date, b.close])), invert: c.invert };
    process.stdout.write(`  ${c.name}:${e.length}/${p.length}  `);
  }
  console.log("\n");

  // common calendar
  let dates = null;
  for (const c of CCY) { const d = new Set([...data[c.name].etf.keys()].filter(x => data[c.name].spot.has(x))); dates = dates ? new Set([...dates].filter(x => d.has(x))) : d; }
  dates = [...dates].sort();
  console.log(`  common calendar: ${dates.length} sessions · ${dates[0]} → ${dates[dates.length - 1]}`);

  /** annualised implied yield of `name` over the LOOKBACK ending at index i (uses only ≤ i) */
  const impliedYield = (name, i) => {
    const D = data[name], d0 = dates[i - LOOKBACK], d1 = dates[i];
    const e0 = D.etf.get(d0), e1 = D.etf.get(d1);
    let s0 = D.spot.get(d0), s1 = D.spot.get(d1);
    if (!(e0 > 0 && e1 > 0 && s0 > 0 && s1 > 0)) return null;
    if (D.invert) { s0 = 1 / s0; s1 = 1 / s1; }          // convert to foreign-per-USD terms
    const etfRet = e1 / e0 - 1, spotRet = s1 / s0 - 1;
    return (etfRet - spotRet) * (252 / LOOKBACK);
  };

  // ── VERIFY the construction before trusting it ────────────────────────────
  console.log(`\n  ══ CONSTRUCTION CHECK — implied yields by era (JPY must be ~0 through ZIRP) ══`);
  console.log(`  era            ${CCY.map(c => c.name.padStart(7)).join("")}`);
  const eras = [["2016-2019", "2016-01-01", "2019-12-31"], ["2020-2021", "2020-01-01", "2021-12-31"], ["2023-2026", "2023-01-01", "2026-12-31"]];
  const eraY = {};
  for (const [lbl, a, b] of eras) {
    const row = [];
    for (const c of CCY) {
      const v = [];
      for (let i = LOOKBACK; i < dates.length; i += HOLD) if (dates[i] >= a && dates[i] <= b) { const y = impliedYield(c.name, i); if (y != null) v.push(y); }
      const m = mean(v); row.push(m); (eraY[lbl] ||= {})[c.name] = m;
    }
    console.log(`  ${lbl.padEnd(14)} ${row.map(v => pc(v, 1).padStart(7)).join("")}`);
  }
  const jpyZirp = eraY["2020-2021"]?.JPY;
  const ok = jpyZirp != null && Math.abs(jpyZirp) < 0.02;
  console.log(`\n  JPY 2020-2021 implied yield ${pc(jpyZirp, 2)} — ${ok ? "consistent with ZIRP, construction VERIFIED" : "*** NOT near zero: the ETF/spot alignment is wrong, aborting ***"}`);
  if (!ok) { console.log(""); process.exit(1); }

  // ── the carry portfolio, non-overlapping monthly formations ───────────────
  const forms = [];
  for (let i = LOOKBACK; i + HOLD < dates.length; i += HOLD) {
    const ranks = CCY.map(c => ({ name: c.name, y: impliedYield(c.name, i) })).filter(x => x.y != null);
    if (ranks.length < 6) continue;
    ranks.sort((a, b) => b.y - a.y);
    const longs = ranks.slice(0, 2).map(x => x.name), shorts = ranks.slice(-2).map(x => x.name);
    const fwd = (name) => { const D = data[name], a = D.etf.get(dates[i]), b = D.etf.get(dates[i + HOLD]); return (a > 0 && b > 0) ? b / a - 1 : null; };
    const L = longs.map(fwd), S = shorts.map(fwd);
    if ([...L, ...S].some(v => v == null)) continue;
    forms.push({ date: dates[i], longs, shorts, gross: mean(L) - mean(S), spread: ranks[0].y - ranks[ranks.length - 1].y });
  }
  console.log(`\n  ${forms.length} NON-OVERLAPPING monthly formations (${forms[0].date} → ${forms[forms.length - 1].date})`);
  console.log(`  mean yield spread top-2 minus bottom-2: ${pc(mean(forms.map(f => f.spread)), 2)} annualised`);

  const score = (cost) => {
    const r = forms.map(f => f.gross - 4 * cost);        // 2 legs in, 2 out
    const m = mean(r), s = sd(r);
    const p = pathStats(r);
    return { n: r.length, mean: m, t: (m != null && s) ? m / (s / Math.sqrt(r.length)) : null, ...p, worst: Math.min(...r) };
  };

  console.log(`\n  ══ COST SENSITIVITY ══`);
  console.log(`  cost/leg   mean/mo     t       CAGR      maxDD     worst month`);
  for (const c of COST_GRID) { const s = score(c); console.log(`  ${((c * 1e4).toFixed(0) + "bp").padStart(7)}   ${pc(s.mean).padStart(8)}  ${(s.t == null ? "—" : s.t.toFixed(2)).padStart(6)}  ${pc(s.cagr).padStart(8)}  ${pc(-s.maxDD).padStart(8)}  ${pc(s.worst).padStart(8)}`); }

  const P = score(BASE_COST);
  const gates = { pos: P.mean > 0, t: P.t != null && P.t >= T_BAR, dd: P.maxDD <= DD_CEILING };
  console.log(`\n  ══ ADJUDICATION at ${(BASE_COST * 1e4).toFixed(0)}bp/leg ══`);
  console.log(`  ${gates.pos ? "✓" : "✗"} mean > 0                 ${pc(P.mean)} per month`);
  console.log(`  ${gates.t ? "✓" : "✗"} t ≥ ${T_BAR}                 ${P.t == null ? "—" : P.t.toFixed(2)}`);
  console.log(`  ${gates.dd ? "✓" : "✗"} maxDD ≤ ${(DD_CEILING * 100).toFixed(0)}%             ${pc(-P.maxDD)}`);
  const verdict = !gates.pos ? `FAIL — the carry mean is not positive.`
    : Object.values(gates).every(Boolean) ? `PASS — clears every pre-registered gate INCLUDING the drawdown ceiling. First structural predictor to survive in this project; forward confirmation required before any capital.`
      : `NOT-ESTABLISHED — ${Object.entries(gates).filter(([, v]) => !v).map(([k]) => k).join(", ")} gate(s) failed.`;
  console.log(`\n  VERDICT: ${verdict}\n`);

  const worst = [...forms].sort((a, b) => a.gross - b.gross).slice(0, 4);
  console.log(`  worst formations: ${worst.map(f => `${f.date} ${pc(f.gross)}`).join(" · ")}`);

  fs.writeFileSync(path.join(__dirname, "data", "currency-carry-54.json"), JSON.stringify({
    generated: new Date().toISOString(), test: 54, structuralCandidate: "S6",
    preRegistered: "2026-07-28, spec frozen in structural-register.json before this script existed.",
    vehicle: "FX currency trusts; yields recovered as ETF total return minus spot FX return, verified against JPY ZIRP before use.",
    nonOverlapping: true, lookback: LOOKBACK, hold: HOLD,
    impliedYieldsByEra: eraY, formations: forms.length, costGrid: COST_GRID, baseCost: BASE_COST,
    drawdownCeiling: DD_CEILING, primary: P, gates, verdict,
    caveats: [
      "Six developed currencies only — the classic carry basket includes higher-yielding EM, where the premium and the crash are both larger.",
      "Trust expense ratios are embedded in the implied yield, so yields read slightly low and the carry slightly conservative.",
      "Monthly rebalancing with no intramonth risk control; a real book would size on volatility.",
      "~20 years covers 2008 only partially depending on trust inception — the canonical carry unwind may be under-represented.",
    ],
  }, null, 1));
  console.log(`\n  written: backend/data/currency-carry-54.json\n`);
})();
