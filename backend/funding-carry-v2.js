#!/usr/bin/env node
/**
 * TEST #55 (payment candidate P2) — CRYPTO PERP FUNDING CARRY, PROPERLY PRICED
 *
 * PRE-REGISTERED 2026-07-28, before any result was computed.
 *
 * WHY A REBUILD RATHER THAN A RE-RUN. Test #22 graded this PREMIUM on 2026-06-29. The
 * 2026-07-28 audit found two flattering defects in the instrument:
 *
 *   D28 — the reported sample window was computed from a CONSTANT, not from the response.
 *         The header printed "~1133d" while OKX returned 275 funding periods = 91 DAYS.
 *   D29 — it modelled the FUNDING ACCRUAL ONLY. It never priced the spot leg or the basis,
 *         which is why the basket printed a Sharpe of 24.75 on 0.1% volatility. That is the
 *         volatility of the funding RATE, not of the POSITION.
 *
 * THE PAYMENT IS REAL AND IS NOT IN QUESTION. OKX debits long accounts and credits short
 * accounts every 8 hours by published formula. No forecast enters the mechanism. What was never
 * established is whether it is HARVESTABLE, because a delta-neutral carry is long spot AND short
 * perp, and the basis between them moves.
 *
 * ── WHAT IS ACTUALLY MODELLED HERE ─────────────────────────────────────────────────────────
 * Per 8-hour funding period, holding notional N long spot and N short perp:
 *
 *     spot leg     +N · (S₁/S₀ − 1)
 *     perp leg     −N · (P₁/P₀ − 1)
 *     funding      +N · f        (the short RECEIVES when funding is positive)
 *     ───────────────────────────────────────────
 *     P&L/N     =  (S₁/S₀ − 1) − (P₁/P₀ − 1) + f
 *
 * The first two terms are the BASIS P&L that #22 omitted entirely. They are the reason this can
 * lose money while funding is positive.
 *
 * ── THE SAMPLE CEILING, AND WHY THIS ALSO WRITES A COLLECTOR ────────────────────────────────
 * OKX retains roughly 91 DAYS of funding history and no pagination parameter reaches past it —
 * verified 2026-07-28 against both `after` and `before`. Perp candles page back to 2024-09-30,
 * but candles without funding cannot measure a carry.
 *
 * So the payment data has a THREE-MONTH EXPIRY and every uncaptured day is lost permanently.
 * This script therefore appends every funding period it sees to an append-only store, so the
 * sample GROWS instead of rolling off. Reconstructing old funding from the observed basis was
 * considered and REJECTED as circular: OKX's funding formula is driven by the premium index, so
 * estimating funding from basis and then testing whether funding-plus-basis is profitable would
 * be assuming the answer.
 *
 * DECISION RULE — fixed now
 *   PASS   if the equal-weight basket shows mean > 0 with Newey-West t ≥ 2.24 (Bonferroni over
 *          the 2 declared variants) AND max drawdown ≤ 20% (risk-policy.json ceiling).
 *   FAIL   if the mean is ≤ 0 net of the base cost.
 *   Otherwise NOT-ESTABLISHED / PRELIMINARY.
 *
 * At ~91 days this CANNOT adjudicate and is not intended to. It establishes the sign and the
 * magnitude honestly, and starts the collector that makes adjudication possible later.
 *
 * EXPECTED OUTCOME, ON THE RECORD: funding stays positive most periods, but the basis P&L
 * offsets most or all of it, leaving something near zero — because if a delta-neutral,
 * mechanically-paid carry were freely profitable at retail size, it would be arbitraged. I
 * expect PRELIMINARY with a small positive gross and a much smaller net.
 *
 * Usage: node backend/funding-carry-v2.js          (also appends to the collector store)
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const STORE = D("funding-carry-store.json");
const RISK = JSON.parse(fs.readFileSync(D("risk-policy.json"), "utf8"));
const DD_CEILING = RISK.current.hardCeiling;
const INSTS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "LTC"];
const PERIODS_YR = 365 * 3;                  // funding every 8h
const T_BAR = 2.24;                          // Bonferroni over 2 declared variants
const COST_GRID = [0, 0.0002, 0.0005, 0.0010];   // per leg, per entry or exit
const BASE_COST = 0.0005;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const pc = (v, d = 3) => v == null ? "     —" : (v >= 0 ? "+" : "") + (v * 100).toFixed(d) + "%";

async function okx(url) { try { const r = await fetch(url, { signal: AbortSignal.timeout(25000) }); if (!r.ok) return null; return await r.json(); } catch { return null; } }

async function fundingHistory(inst) {
  const all = []; let after = "";
  for (let p = 0; p < 12; p++) {
    const j = await okx(`https://www.okx.com/api/v5/public/funding-rate-history?instId=${inst}&limit=100${after ? `&after=${after}` : ""}`);
    const d = j?.data || []; if (!d.length) break;
    for (const x of d) {
      // D22: `+a ?? +b` can never fall back, because +undefined is NaN and ?? only catches
      // null/undefined. Use an explicit finite check instead.
      const rr = Number(x.realizedRate), fr = Number(x.fundingRate);
      const rate = Number.isFinite(rr) ? rr : (Number.isFinite(fr) ? fr : null);
      if (rate != null) all.push({ t: +x.fundingTime, rate });
    }
    after = d[d.length - 1].fundingTime;
    await sleep(110);
  }
  return all.sort((a, b) => a.t - b.t);
}

async function candles(inst) {
  const all = []; let after = "";
  for (let p = 0; p < 30; p++) {
    const j = await okx(`https://www.okx.com/api/v5/market/history-candles?instId=${inst}&bar=1H&limit=100${after ? `&after=${after}` : ""}`);
    const d = j?.data || []; if (!d.length) break;
    for (const c of d) all.push({ t: +c[0], c: +c[4] });
    after = d[d.length - 1][0];
    await sleep(110);
  }
  return all.sort((a, b) => a.t - b.t);
}
/** closest close at or before ts, within 2h */
const priceAt = (arr, ts) => { let lo = 0, hi = arr.length - 1, best = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].t <= ts) { best = arr[m]; lo = m + 1; } else hi = m - 1; } return (best && ts - best.t <= 2 * 3600e3) ? best.c : null; };

/** Newey-West t — funding regimes persist for days, so the plain t is inflated. */
function nwT(x, L) {
  const n = x.length, m = mean(x);
  if (!n || m == null) return null;
  let v = x.reduce((s, y) => s + (y - m) ** 2, 0) / n;
  for (let k = 1; k <= L; k++) { let g = 0; for (let i = k; i < n; i++) g += (x[i] - m) * (x[i - k] - m); g /= n; v += 2 * (1 - k / (L + 1)) * g; }
  return v > 0 ? m / Math.sqrt(v / n) : null;
}
function pathStats(r) { let eq = 1, pk = 1, dd = 0; for (const x of r) { eq *= 1 + x; if (eq <= 0) return { cagr: null, maxDD: 1, ruined: true }; pk = Math.max(pk, eq); dd = Math.max(dd, (pk - eq) / pk); } const y = r.length / PERIODS_YR; return { cagr: y > 0 ? Math.pow(eq, 1 / y) - 1 : null, maxDD: dd, ruined: false }; }

(async () => {
  console.log(`\n  TEST #55 (P2) — CRYPTO FUNDING CARRY, PROPERLY PRICED`);
  console.log(`  pre-registered 2026-07-28 · rebuild of #22 after defects D28 (fake window) and D29 (accrual-only)`);
  console.log(`  P&L = (spot leg) − (perp leg) + funding.  The basis terms are what #22 omitted.\n`);

  const per = {};
  for (const sym of INSTS) {
    const [f, sp, pp] = await Promise.all([
      fundingHistory(`${sym}-USDT-SWAP`), candles(`${sym}-USDT`), candles(`${sym}-USDT-SWAP`),
    ]);
    const rows = [];
    for (let i = 0; i + 1 < f.length; i++) {
      const t0 = f[i].t, t1 = f[i + 1].t;
      const s0 = priceAt(sp, t0), s1 = priceAt(sp, t1), p0 = priceAt(pp, t0), p1 = priceAt(pp, t1);
      if (![s0, s1, p0, p1].every(x => x > 0)) continue;
      const spotLeg = s1 / s0 - 1, perpLeg = p1 / p0 - 1;
      rows.push({ t: t1, funding: f[i].rate, basis: spotLeg - perpLeg, gross: spotLeg - perpLeg + f[i].rate });
    }
    per[sym] = rows;
    process.stdout.write(`  ${sym}:${rows.length}  `);
  }
  console.log("\n");

  const ns = Object.values(per).map(r => r.length);
  const days = Math.round(Math.min(...ns) / 3);
  console.log(`  ${Math.min(...ns)}–${Math.max(...ns)} priced funding periods per instrument ≈ ${days} days`);
  console.log(`  (OKX retains ~91 days of funding and no parameter reaches past it — verified 2026-07-28)\n`);

  console.log(`  ══ WHERE THE MONEY GOES — funding vs basis, per instrument ══`);
  console.log(`  perp    n     funding/period   basis/period    NET/period    ann(net, gross of cost)`);
  for (const sym of INSTS) {
    const r = per[sym]; if (!r.length) continue;
    const f = mean(r.map(x => x.funding)), b = mean(r.map(x => x.basis)), g = mean(r.map(x => x.gross));
    console.log(`  ${sym.padEnd(6)} ${String(r.length).padStart(4)}   ${pc(f, 4).padStart(10)}    ${pc(b, 4).padStart(10)}   ${pc(g, 4).padStart(10)}    ${pc(g * PERIODS_YR, 1).padStart(9)}`);
  }
  const fAll = mean(INSTS.flatMap(s => per[s].map(x => x.funding)));
  const bAll = mean(INSTS.flatMap(s => per[s].map(x => x.basis)));
  console.log(`\n  pooled: funding ${pc(fAll, 4)} per period, basis ${pc(bAll, 4)} per period`);
  console.log(`  -> the basis offsets ${bAll < 0 && fAll > 0 ? (100 * Math.min(1, -bAll / fAll)).toFixed(0) + "% of the funding" : "nothing; it adds"}. THIS IS THE TERM #22 DID NOT MODEL.`);

  // ── equal-weight basket, the declared primary ──────────────────────────────
  const times = [...new Set(INSTS.flatMap(s => per[s].map(x => x.t)))].sort((a, b) => a - b);
  const basket = [];
  for (const t of times) {
    const v = INSTS.map(s => per[s].find(x => x.t === t)).filter(Boolean);
    if (v.length < 4) continue;
    basket.push({ t, gross: mean(v.map(x => x.gross)), funding: mean(v.map(x => x.funding)) });
  }
  console.log(`\n  ══ EQUAL-WEIGHT BASKET (declared primary) — cost sensitivity ══`);
  console.log(`  cost/leg   mean/period    ann      NW t(24)   maxDD      % periods +`);
  const score = (cost, filt) => {
    // always-on: cost charged once in and once out over the whole sample (4 legs total)
    const rows = filt ? basket.filter(b => b.funding > 0) : basket;
    const flips = filt ? rows.length : 1;
    const drag = (4 * cost * flips) / Math.max(1, rows.length);
    const r = rows.map(b => b.gross - drag);
    const p = pathStats(r);
    return { n: r.length, mean: mean(r), t: nwT(r, 24), ...p, pos: 100 * r.filter(x => x > 0).length / r.length };
  };
  for (const c of COST_GRID) { const s = score(c, false); console.log(`  ${((c * 1e4).toFixed(0) + "bp").padStart(7)}   ${pc(s.mean, 4).padStart(10)}   ${pc(s.mean * PERIODS_YR, 1).padStart(8)}   ${(s.t == null ? "—" : s.t.toFixed(2)).padStart(7)}   ${pc(-s.maxDD, 2).padStart(8)}   ${s.pos.toFixed(0)}%`); }
  const filt = score(BASE_COST, true);
  console.log(`\n  variant 2 — hold only when funding > 0, cost every flip:`);
  console.log(`    n=${filt.n}  mean ${pc(filt.mean, 4)}  ann ${pc(filt.mean * PERIODS_YR, 1)}  NW t ${filt.t == null ? "—" : filt.t.toFixed(2)}  maxDD ${pc(-filt.maxDD, 2)}`);

  const P = score(BASE_COST, false);
  const gates = { pos: P.mean > 0, t: P.t != null && P.t >= T_BAR, dd: P.maxDD <= DD_CEILING };
  console.log(`\n  ══ ADJUDICATION at ${(BASE_COST * 1e4).toFixed(0)}bp/leg ══`);
  console.log(`  ${gates.pos ? "✓" : "✗"} mean > 0            ${pc(P.mean, 4)} per period (${pc(P.mean * PERIODS_YR, 1)} annualised)`);
  console.log(`  ${gates.t ? "✓" : "✗"} Newey-West t ≥ ${T_BAR}   ${P.t == null ? "—" : P.t.toFixed(2)}`);
  console.log(`  ${gates.dd ? "✓" : "✗"} maxDD ≤ ${(DD_CEILING * 100).toFixed(0)}%        ${pc(-P.maxDD, 2)}`);
  const verdict = !gates.pos ? `FAIL — negative net of ${(BASE_COST * 1e4).toFixed(0)}bp. The basis P&L consumes the funding.`
    : `PRELIMINARY — ${days} days cannot adjudicate a carry and this was never going to. Sign and magnitude are established; the collector below is what makes a verdict possible.`;
  console.log(`\n  VERDICT: ${verdict}\n`);

  // ── append-only collector: the payment data expires in 91 days ─────────────
  const store = (() => { try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return { started: "2026-07-28", note: "OKX retains ~91 days of funding history. Every uncaptured period is lost permanently. Append-only.", periods: {} }; } })();
  let added = 0;
  for (const sym of INSTS) { const m = store.periods[sym] ||= {}; for (const r of per[sym]) { if (!(r.t in m)) { m[r.t] = { f: +r.funding.toFixed(8), b: +r.basis.toFixed(8) }; added++; } } }
  fs.writeFileSync(STORE, JSON.stringify(store));
  const held = Object.values(store.periods).reduce((s, m) => s + Object.keys(m).length, 0);
  const span = (() => { const all = Object.values(store.periods).flatMap(m => Object.keys(m).map(Number)); return all.length ? Math.round((Math.max(...all) - Math.min(...all)) / 864e5) : 0; })();
  console.log(`  COLLECTOR: +${added} new periods · ${held} held · spanning ${span} days`);
  console.log(`  Run daily. Once the store exceeds OKX's 91-day window it holds data the API no longer serves.\n`);
})();
