#!/usr/bin/env node
/**
 * TEST #60 — TEST #45 WITH PER-STRIKE IMPLIED VOL FROM REAL CHAINS
 *
 * PRE-REGISTERED 2026-07-28, before any result was computed. The final correction in the
 * sequence #45 → #58 → #59 → #60.
 *
 * THE STORY SO FAR.
 *   #45 measured short 20-delta put spreads at 91.3% win, +5.72%/episode, t 3.57 over 264
 *       out-of-sample episodes, pricing everything with Black-Scholes at the VIX level.
 *   #58 priced #45's exact strikes against real SPXW contracts: the model OVERSTATED credit
 *       by 35%. Real/modelled 0.654, real above modelled in 1 of 57 episodes.
 *   #59 tested whether the volatility TERM STRUCTURE explained it. It did not — worth 2%.
 *   A leg decomposition then found the cause: VIX is not ATM vol. It is a variance-swap-style
 *       measure that integrates the whole skewed surface and therefore sits ABOVE ATM implied
 *       vol. Applied flat it OVERSTATES near-the-money strikes (short leg real/model 0.808) and
 *       UNDERSTATES far-OTM strikes (wing real/model 1.731). A credit spread sells near and buys
 *       far, so both errors cut net credit.
 *
 * WHAT THIS TEST DOES DIFFERENTLY, AND WHY IT MATTERS MORE THAN #58.
 * #58 still used the MODEL'S strikes — it only replaced the prices. But if VIX overstates the
 * volatility used in the strike formula, the "20-delta" strike was placed FURTHER out of the
 * money than a true 20-delta. That would inflate the win rate for free, because a further-OTM
 * put expires worthless more often. So #45's 91% may be an artifact of selling something other
 * than what it believed it was selling.
 *
 * Here, every listed strike is priced from its OWN implied volatility, backed out of the real
 * market price by bisection. Delta is computed from that per-strike vol. The 20-delta short and
 * 5-delta wing are then chosen by REAL delta from the real surface — selection and pricing both
 * corrected, for the first time.
 *
 * THE DIAGNOSTIC THIS PRODUCES: the realised delta of the strike #45's formula would have
 * chosen. If it comes in well below 0.20, the 91% win rate was bought by unknowingly selling
 * further OTM, and the headline was measuring a different strategy than the one described.
 *
 * WINDOW. 2024-03 → 2026-07, ~57 non-overlapping 10-trading-day episodes — everything Alpaca
 * serves. This cannot adjudicate a crash-insurance strategy: there is no Feb 2018 or Mar 2020
 * in it. It measures the PRICE and the SELECTION honestly, which is what has been wrong.
 *
 * DECISION RULE — fixed now, gates unchanged from #45
 *   PASS if win >= 65%, mean > 0, t >= 2.64, worst > −100% of max risk.
 *   The bar stays where it was. Lowering it now would be the #41–#43 error.
 *
 * EXPECTED OUTCOME, ON THE RECORD: the true 20-delta strike sits CLOSER to the money than #45's
 * formula placed it, so the win rate falls toward 80% (the level delta implies) while the credit
 * per episode rises. Net expectancy lands near #58's +2.68%, and t stays below the 2.64 bar on
 * this short window. I have been wrong on mechanism four times today, so this is a prediction to
 * be checked, not a claim.
 *
 * Usage: node backend/credit-spread-v3.js
 */
const fs = require("fs"), path = require("path");
(function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} })();
const AH = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, Accept: "application/json" };
const MKT = "http://localhost:3002/api/yahoo";
const DTE = 10, STEP = 25, Z_BAR = 2.64, BASE_COST = 0.05;
const TARGET_SHORT = 0.20, TARGET_WING = 0.05;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const pc = (v, d = 2) => v == null ? "     —" : (v >= 0 ? "+" : "") + (100 * v).toFixed(d) + "%";

function N(x) { const s = Math.sign(x); x = Math.abs(x) / Math.SQRT2; const t = 1 / (1 + 0.3275911 * x); const y = 1 - ((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t * t * Math.exp(-x * x) - 0.254829592 * t * Math.exp(-x * x); return 0.5 * (1 + s * y); }
const bsPut = (S, K, sig, T) => { const v = sig * Math.sqrt(T); const d1 = (Math.log(S / K) + 0.5 * sig * sig * T) / v; return K * N(-(d1 - v)) - S * N(-d1); };
/** implied vol by bisection — robust where Newton diverges on deep OTM strikes */
function impliedVol(price, S, K, T) {
  const intrinsic = Math.max(0, K - S);
  if (!(price > intrinsic + 1e-6)) return null;
  let lo = 0.01, hi = 3.0;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (bsPut(S, K, mid, T) > price) hi = mid; else lo = mid; }
  const v = (lo + hi) / 2;
  return (v > 0.015 && v < 2.9) ? v : null;
}
const deltaPut = (S, K, sig, T) => { const v = sig * Math.sqrt(T); const d1 = (Math.log(S / K) + 0.5 * sig * sig * T) / v; return N(-d1); };   // magnitude
const occ = (exp, k) => `SPXW${exp}P${String(Math.round(k * 1000)).padStart(8, "0")}`;

const cache = new Map();
async function optBars(sym) {
  if (cache.has(sym)) return cache.get(sym);
  let out = [];
  try {
    const r = await fetch(`https://data.alpaca.markets/v1beta1/options/bars?symbols=${sym}&timeframe=1Day&start=2023-06-01&limit=1000`, { headers: AH, signal: AbortSignal.timeout(25000) });
    if (r.ok) { const j = await r.json(); out = (j.bars?.[sym] || []).map(b => ({ d: String(b.t).slice(0, 10), c: b.c })); }
  } catch {}
  cache.set(sym, out); await sleep(60);
  return out;
}
const g = async (s) => { const r = await fetch(`${MKT}/${encodeURIComponent(s)}/history?days=1400&interval=1d`, { signal: AbortSignal.timeout(120000) }); return ((await r.json()).bars || []).filter(b => Number.isFinite(b.close)); };

(async () => {
  console.log(`\n  TEST #60 — #45 WITH PER-STRIKE IMPLIED VOL FROM REAL CHAINS`);
  console.log(`  pre-registered 2026-07-28 · strikes chosen by REAL delta, priced at REAL prices\n`);

  const [spx, vix] = await Promise.all([g("^GSPC"), g("^VIX")]);
  const P = new Map(spx.map(b => [b.date, b.close])), V = new Map(vix.map(b => [b.date, b.close]));
  const dates = spx.map(b => b.date).filter(d => V.has(d));
  const start = dates.findIndex(d => d >= "2024-03-01");

  const rows = [];
  let skipped = 0;
  for (let i = start; i + DTE < dates.length; i += DTE) {
    const d = dates[i], S = P.get(d), T = DTE / 252;
    if (!(S > 0)) continue;
    const target = dates[i + DTE];

    // locate a listed expiry near the target using an ATM-ish probe strike
    const probe = Math.round(S / STEP) * STEP - 4 * STEP;
    let exp = null;
    for (let off = 0; off <= 4 && !exp; off++) {
      for (const s of (off === 0 ? [0] : [off, -off])) {
        const dt = new Date(target + "T00:00:00Z"); dt.setUTCDate(dt.getUTCDate() + s);
        const iso = dt.toISOString().slice(0, 10), e = iso.slice(2).replace(/-/g, "");
        const b = await optBars(occ(e, probe));
        if (b.some(x => x.d === d)) { exp = { iso, code: e }; break; }
      }
    }
    if (!exp) { skipped++; continue; }

    // walk the surface downward from just below spot, backing out IV and delta per strike
    const surface = [];
    let k = Math.round(S / STEP) * STEP;
    for (let n = 0; n < 40; n++, k -= STEP) {
      const b = await optBars(occ(exp.code, k));
      const px = b.find(x => x.d === d)?.c;
      if (!(px > 0)) continue;
      const iv = impliedVol(px, S, k, T);
      if (!iv) continue;
      const dl = deltaPut(S, k, iv, T);
      surface.push({ k, px, iv, delta: dl });
      if (dl < 0.02 && surface.length > 6) break;          // past the wing, stop walking
    }
    if (surface.length < 6) { skipped++; continue; }

    const pick = (t) => surface.reduce((a, b) => Math.abs(b.delta - t) < Math.abs(a.delta - t) ? b : a);
    const S20 = pick(TARGET_SHORT), W05 = pick(TARGET_WING);
    if (!(S20.k > W05.k)) { skipped++; continue; }

    const credit = S20.px - W05.px, width = S20.k - W05.k, maxRisk = width - credit;
    const ST = P.get(exp.iso) ?? P.get(target);
    if (!(maxRisk > 0) || !(credit > 0) || !(ST > 0)) { skipped++; continue; }
    const loss = Math.max(0, Math.min(S20.k - ST, width));

    // what would #45's formula have picked, and what was its REAL delta?
    const ivIdx = V.get(d) / 100;
    const kModel = Math.round((S * Math.exp(0.5 * ivIdx * ivIdx * T - 0.8416 * ivIdx * Math.sqrt(T))) / STEP) * STEP;
    const modelStrike = surface.find(x => x.k === kModel);

    rows.push({
      d, exp: exp.iso, S: +S.toFixed(0), ST: +ST.toFixed(0),
      kShort: S20.k, dShort: +S20.delta.toFixed(3), ivShort: +(100 * S20.iv).toFixed(1),
      kWing: W05.k, dWing: +W05.delta.toFixed(3), ivWing: +(100 * W05.iv).toFixed(1),
      credit: +credit.toFixed(2), width, maxRisk: +maxRisk.toFixed(2),
      frac: (credit - loss) / maxRisk,
      modelStrike: kModel, modelRealDelta: modelStrike ? +modelStrike.delta.toFixed(3) : null,
      surfaceN: surface.length,
    });
    process.stdout.write(".");
  }
  console.log("");
  if (!rows.length) { console.error("\n  no episodes could be built — aborting.\n"); process.exit(1); }

  console.log(`\n  ${rows.length} episodes built from real surfaces · ${skipped} skipped · ${mean(rows.map(r => r.surfaceN)).toFixed(0)} strikes priced per episode\n`);

  // ── the diagnostic: was #45 selling what it thought it was selling? ───────
  const md = rows.map(r => r.modelRealDelta).filter(Number.isFinite);
  console.log(`  ══ WAS #45 SELLING A 20-DELTA OPTION? ══`);
  if (md.length > 5) {
    console.log(`  #45's formula targeted 0.200 delta. Its chosen strike had a REAL delta of ${mean(md).toFixed(3)} (n=${md.length}).`);
    console.log(`  -> ${mean(md) < 0.16 ? `it was selling roughly a ${(100 * mean(md)).toFixed(0)}-DELTA option, materially further out of the money than described. A further-OTM put expires worthless more often, so part of the 91% win rate was bought by selling something other than what the test believed.` : mean(md) > 0.24 ? `it was selling CLOSER to the money than described.` : `close enough to 20-delta — the selection was fair and the error was purely in pricing.`}`);
  }
  console.log(`  realised deltas actually chosen here: short ${mean(rows.map(r => r.dShort)).toFixed(3)} · wing ${mean(rows.map(r => r.dWing)).toFixed(3)}`);
  console.log(`  implied vol by strike: short ${mean(rows.map(r => r.ivShort)).toFixed(1)}% · wing ${mean(rows.map(r => r.ivWing)).toFixed(1)}%  — the skew, measured`);

  const score = (cost) => {
    const net = rows.map(r => r.frac - cost * (r.credit / r.maxRisk));
    const m = mean(net), s = sd(net);
    return { n: net.length, mean: m, t: s ? m / (s / Math.sqrt(net.length)) : null, win: 100 * net.filter(x => x > 0).length / net.length, worst: Math.min(...net) };
  };
  const p = score(BASE_COST);
  console.log(`\n  ══ THE STRATEGY, SELECTION AND PRICING BOTH CORRECT ══`);
  console.log(`  cost   n     win     mean/episode    t       worst`);
  for (const c of [0, 0.02, 0.05, 0.10]) { const s = score(c); console.log(`  ${((c * 100).toFixed(0) + "%").padStart(4)}  ${String(s.n).padStart(3)}   ${s.win.toFixed(0).padStart(3)}%   ${pc(s.mean).padStart(9)}    ${(s.t == null ? "—" : s.t.toFixed(2)).padStart(5)}   ${pc(s.worst).padStart(9)}`);
  }
  console.log(`\n  for comparison on the SAME kind of window:`);
  console.log(`    #45 (modelled, 2016-2026, n=264):  91% win  +5.72%  t 3.57`);
  console.log(`    #58 (model strikes, real prices):  89% win  +2.68%  t 1.06`);
  console.log(`    #60 (real strikes, real prices):   ${p.win.toFixed(0)}% win  ${pc(p.mean)}  t ${p.t == null ? "—" : p.t.toFixed(2)}`);

  const gates = { win: p.win >= 65, pos: p.mean > 0, t: p.t != null && p.t >= Z_BAR, held: p.worst > -1.0 };
  console.log(`\n  ══ ADJUDICATION vs #45's UNCHANGED gates ══`);
  console.log(`  ${gates.win ? "✓" : "✗"} win >= 65%        ${p.win.toFixed(0)}%`);
  console.log(`  ${gates.pos ? "✓" : "✗"} mean > 0          ${pc(p.mean)}`);
  console.log(`  ${gates.t ? "✓" : "✗"} t >= ${Z_BAR}          ${p.t == null ? "—" : p.t.toFixed(2)}`);
  console.log(`  ${gates.held ? "✓" : "✗"} worst > -100%     ${pc(p.worst)}`);
  const verdict = Object.values(gates).every(Boolean) ? `PASS at its original bar, on real strikes and real prices.`
    : `NOT-ESTABLISHED — ${Object.entries(gates).filter(([, v]) => !v).map(([k]) => k).join(", ")} gate(s) fail. Note the window is ${rows.length} episodes over ~2.5 quiet years and cannot adjudicate a crash-insurance strategy either way.`;
  console.log(`\n  VERDICT: ${verdict}\n`);

  fs.writeFileSync(path.join(__dirname, "data", "credit-spread-v3-60.json"), JSON.stringify({
    generated: new Date().toISOString(), test: 60,
    preRegistered: "2026-07-28. Strikes chosen by REAL delta from per-strike implied vol; priced at real market closes.",
    method: "For each episode, every listed put strike from ATM downward is priced from its own implied vol (bisection), delta computed from that vol, and the 20-delta short and 5-delta wing selected by realised delta.",
    episodes: rows.length, skipped,
    modelStrikeRealDelta: md.length > 5 ? mean(md) : null,
    realisedDeltas: { short: mean(rows.map(r => r.dShort)), wing: mean(rows.map(r => r.dWing)) },
    skewMeasured: { shortIV: mean(rows.map(r => r.ivShort)), wingIV: mean(rows.map(r => r.ivWing)) },
    primary: p, gates, verdict, rows,
    caveats: [
      "2.5 quiet years. No Feb 2018, no Mar 2020 — the events this strategy exists to survive are absent.",
      "Entry at the contract's daily CLOSE; bid-ask is not crossed, so real execution is worse.",
      "25-point strike grid, so realised delta lands near but not exactly on target.",
      "SPX standard expiries settle AM against a special opening quotation; this settles against the index close.",
    ],
  }, null, 1));
  console.log(`  written: backend/data/credit-spread-v3-60.json\n`);
})();
