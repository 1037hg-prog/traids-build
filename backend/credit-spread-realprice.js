#!/usr/bin/env node
/**
 * TEST #58 — TEST #45 AT REAL OPTION PRICES
 *
 * PRE-REGISTERED 2026-07-28, before any result was computed.
 *
 * THE CAVEAT THIS EXISTS TO RESOLVE. Test #45 measured short 20-delta put spreads at 91.3% win,
 * t 3.57 over 264 out-of-sample episodes, and it has been the strongest result in this registry
 * since 2026-07-26. It has also carried one blocking caveat the entire time, in its own words:
 *
 *     "Strikes and premiums are Black-Scholes at the index vol index, r=0. Real chains have skew
 *      — a 20-delta PUT trades at higher implied vol than the index level, so real credit is
 *      LARGER than modelled and this understates the put side."
 *
 * That was an argument, not a measurement. Alpaca was found on 2026-07-28 to serve real historical
 * option bars for SPXW back to ~2024-01, free, on the existing key — so the argument can now be
 * settled with prices.
 *
 * ── WHAT THIS IS AND IS NOT ────────────────────────────────────────────────────────────────
 * It is NOT a replacement for #45. 2.5 years is not 10.5, and this window contains no event
 * remotely like Feb 2018 or Mar 2020 — the two episodes #45 was specifically built to survive.
 * A good result here does not confirm #45 and a bad one does not refute it.
 *
 * It IS two things #45 could never do:
 *   1. Measure the MODEL ERROR directly — what the Black-Scholes credit was versus what the
 *      contract actually traded at, per episode. That number either supports the skew argument
 *      or kills it.
 *   2. Run the strategy on prices nobody modelled, over a window that is out-of-sample relative
 *      to the 2016-2026 study in the only sense available: it was priced by the market, not by me.
 *
 * ── METHOD ─────────────────────────────────────────────────────────────────────────────────
 * Strike selection is IDENTICAL to #45 — same Black-Scholes inversion, same 20-delta short and
 * 5-delta wing — so the comparison isolates PRICING, not selection. Targets are then rounded to
 * the nearest listed 25-point strike, and the expiry is the listed date closest to 10 trading
 * days out. Entry is the contract's CLOSE on the episode date; settlement is intrinsic against
 * the actual index close at expiry, with the loss capped at the spread width as a defined-risk
 * spread requires.
 *
 * Episodes are NON-OVERLAPPING, stepping 10 trading days, exactly as in #45.
 *
 * DECISION RULE — fixed now
 *   The primary output is the CREDIT RATIO: real credit / modelled credit, per episode.
 *   · ratio > 1.05  -> Black-Scholes UNDERSTATED the premium. #45 is conservative and its
 *                      headline understates the edge.
 *   · ratio < 0.95  -> Black-Scholes OVERSTATED it. #45's edge shrinks by that factor and the
 *                      result needs restating.
 *   · 0.95 - 1.05   -> the approximation was fair and the caveat can be closed.
 *   Strategy performance on real prices is reported as SECONDARY, with its sample size stated,
 *   because 2.5 quiet years cannot adjudicate a crash-insurance strategy.
 *
 * EXPECTED OUTCOME, ON THE RECORD: ratio above 1, probably 1.1-1.3, because put skew is a
 * persistent feature of index options and the 20-delta strike sits well inside it. If the ratio
 * comes in BELOW 1, the caveat was backwards for two months and #45's headline is too high.
 *
 * Usage: node backend/credit-spread-realprice.js
 */
const fs = require("fs"), path = require("path");
(function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} })();
const AH = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, Accept: "application/json" };
const MKT = "http://localhost:3002/api/yahoo";
const DTE = 10, D_SHORT = 0.8416, D_LONG = 1.6449, STRIKE_STEP = 25;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const pc = (v, d = 2) => v == null ? "     —" : (v >= 0 ? "+" : "") + (100 * v).toFixed(d) + "%";

// Black-Scholes, identical to #45 so the comparison isolates pricing
function N(x) { const s = Math.sign(x); x = Math.abs(x) / Math.SQRT2; const t = 1 / (1 + 0.3275911 * x); const y = 1 - ((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t * t * Math.exp(-x * x) - 0.254829592 * t * Math.exp(-x * x); return 0.5 * (1 + s * y); }
const bsPut = (S, K, sig, T) => { const v = sig * Math.sqrt(T); const d1 = (Math.log(S / K) + 0.5 * sig * sig * T) / v; return K * N(-(d1 - v)) - S * N(-d1); };
const strikeAt = (S, sig, T, d1) => S * Math.exp(0.5 * sig * sig * T - d1 * sig * Math.sqrt(T));
const occ = (exp, strike) => `SPXW${exp}P${String(Math.round(strike * 1000)).padStart(8, "0")}`;

const barCache = new Map();
async function optBars(sym) {
  if (barCache.has(sym)) return barCache.get(sym);
  let out = [];
  try {
    const r = await fetch(`https://data.alpaca.markets/v1beta1/options/bars?symbols=${sym}&timeframe=1Day&start=2023-06-01&limit=1000`, { headers: AH, signal: AbortSignal.timeout(25000) });
    if (r.ok) { const j = await r.json(); out = (j.bars?.[sym] || []).map(b => ({ d: String(b.t).slice(0, 10), c: b.c, o: b.o })); }
  } catch {}
  barCache.set(sym, out); await sleep(70);
  return out;
}
const g = async (s) => { const r = await fetch(`${MKT}/${encodeURIComponent(s)}/history?days=1400&interval=1d`, { signal: AbortSignal.timeout(120000) }); if (!r.ok) throw new Error(s); return ((await r.json()).bars || []).filter(b => Number.isFinite(b.close)); };

(async () => {
  console.log(`\n  TEST #58 — TEST #45 AT REAL OPTION PRICES`);
  console.log(`  pre-registered 2026-07-28 · strike selection IDENTICAL to #45, so this isolates PRICING`);
  console.log(`  primary output: real credit / modelled credit. Secondary: performance, with its sample stated.\n`);

  const [spx, vix] = await Promise.all([g("^GSPC"), g("^VIX")]);
  const V = new Map(vix.map(b => [b.date, b.close]));
  const dates = spx.map(b => b.date).filter(d => V.has(d));
  const P = new Map(spx.map(b => [b.date, b.close]));
  const start = dates.findIndex(d => d >= "2024-03-01");
  console.log(`  index window ${dates[start]} → ${dates[dates.length - 1]} · stepping ${DTE} trading days, non-overlapping\n`);

  const rows = [];
  let noChain = 0;
  for (let i = start; i + DTE < dates.length; i += DTE) {
    const d = dates[i], S = P.get(d), iv = V.get(d) / 100, T = DTE / 252;
    if (!(S > 0 && iv > 0)) continue;
    const kShortT = strikeAt(S, iv, T, D_SHORT), kLongT = strikeAt(S, iv, T, D_LONG);
    const kShort = Math.round(kShortT / STRIKE_STEP) * STRIKE_STEP;
    const kLong = Math.round(kLongT / STRIKE_STEP) * STRIKE_STEP;
    if (!(kShort > kLong)) continue;

    // find a listed expiry near the DTE target: try the exact date then nearby calendar days
    const targetDate = dates[i + DTE];
    const cands = [];
    for (let off = 0; off <= 4; off++) {
      for (const s of (off === 0 ? [0] : [off, -off])) {
        const dt = new Date(targetDate + "T00:00:00Z"); dt.setUTCDate(dt.getUTCDate() + s);
        cands.push(dt.toISOString().slice(0, 10));
      }
    }
    let expIso = null, shortBars = null;
    for (const c of cands) {
      const exp = c.slice(2).replace(/-/g, "");
      const b = await optBars(occ(exp, kShort));
      if (b.some(x => x.d === d)) { expIso = c; shortBars = b; break; }
    }
    if (!expIso) { noChain++; continue; }
    const exp = expIso.slice(2).replace(/-/g, "");
    const longBars = await optBars(occ(exp, kLong));
    const sEntry = shortBars.find(x => x.d === d)?.c;
    const lEntry = longBars.find(x => x.d === d)?.c;
    if (!(sEntry > 0) || !(lEntry >= 0)) { noChain++; continue; }

    const realCredit = sEntry - lEntry;
    const modelCredit = bsPut(S, kShort, iv, T) - bsPut(S, kLong, iv, T);
    const width = kShort - kLong;
    const ST = P.get(expIso) ?? P.get(dates[i + DTE]);
    if (!(ST > 0) || !(realCredit > 0) || !(modelCredit > 0)) { noChain++; continue; }

    const loss = Math.max(0, Math.min(kShort - ST, width));
    rows.push({
      d, exp: expIso, S: +S.toFixed(0), iv: +(100 * iv).toFixed(1), kShort, kLong, width,
      realCredit: +realCredit.toFixed(2), modelCredit: +modelCredit.toFixed(2),
      ratio: realCredit / modelCredit,
      realFrac: (realCredit - loss) / (width - realCredit),
      modelFrac: (modelCredit - loss) / (width - modelCredit),
      ST: +ST.toFixed(0),
    });
    process.stdout.write(".");
  }
  console.log("");

  if (!rows.length) { console.error("\n  no episodes could be priced — aborting rather than reporting nothing as something.\n"); process.exit(1); }
  console.log(`\n  ${rows.length} episodes priced against real contracts · ${noChain} skipped (no listed chain at the modelled strike)\n`);

  const ratios = rows.map(r => r.ratio);
  const mR = mean(ratios), sR = sd(ratios);
  console.log(`  ══ PRIMARY — DID BLACK-SCHOLES UNDER- OR OVER-STATE THE CREDIT? ══`);
  console.log(`  mean real/modelled ratio   ${mR.toFixed(3)}   (sd ${sR.toFixed(3)}, median ${ratios.slice().sort((a, b) => a - b)[Math.floor(ratios.length / 2)].toFixed(3)})`);
  console.log(`  episodes where real > modelled: ${ratios.filter(x => x > 1).length}/${ratios.length}`);
  const verdictRatio = mR > 1.05 ? `BLACK-SCHOLES UNDERSTATED the premium by ${((mR - 1) * 100).toFixed(0)}%. #45's headline is CONSERVATIVE — the skew argument in its caveat was correct.`
    : mR < 0.95 ? `BLACK-SCHOLES OVERSTATED the premium by ${((1 - mR) * 100).toFixed(0)}%. #45's edge shrinks by that factor and the caveat was backwards.`
      : `the approximation was FAIR (within 5%). The caveat can be closed — neither optimistic nor conservative.`;
  console.log(`  -> ${verdictRatio}\n`);

  console.log(`  ══ SECONDARY — the strategy on real prices vs on the model ══`);
  const scoreOf = (key) => {
    const v = rows.map(r => r[key]).filter(Number.isFinite);
    const m = mean(v), s = sd(v);
    return { n: v.length, mean: m, t: s ? m / (s / Math.sqrt(v.length)) : null, win: 100 * v.filter(x => x > 0).length / v.length, worst: Math.min(...v) };
  };
  const real = scoreOf("realFrac"), model = scoreOf("modelFrac");
  console.log(`  pricing        n     win     mean/episode    t       worst`);
  console.log(`  REAL prices   ${String(real.n).padStart(3)}   ${real.win.toFixed(0).padStart(3)}%   ${pc(real.mean).padStart(9)}    ${(real.t == null ? "—" : real.t.toFixed(2)).padStart(5)}   ${pc(real.worst).padStart(9)}`);
  console.log(`  MODEL prices  ${String(model.n).padStart(3)}   ${model.win.toFixed(0).padStart(3)}%   ${pc(model.mean).padStart(9)}    ${(model.t == null ? "—" : model.t.toFixed(2)).padStart(5)}   ${pc(model.worst).padStart(9)}`);
  console.log(`\n  #45 for reference (2016-2026, modelled): 91.3% win, +5.72%/episode, t 3.57, n=264`);
  console.log(`  This window is ${rows.length} episodes over ~2.5 QUIET years. It contains nothing like`);
  console.log(`  Feb 2018 or Mar 2020, which are the events #45 was built to survive. A good number`);
  console.log(`  here does not confirm #45 and a bad one does not refute it.`);

  const worst = rows.slice().sort((a, b) => a.realFrac - b.realFrac).slice(0, 3);
  console.log(`\n  worst episodes on real prices: ${worst.map(r => `${r.d} ${pc(r.realFrac)}`).join(" · ")}`);

  fs.writeFileSync(path.join(__dirname, "data", "credit-spread-realprice-58.json"), JSON.stringify({
    generated: new Date().toISOString(), test: 58,
    preRegistered: "2026-07-28, before any result computed. Resolves the standing caveat on #45.",
    source: "Alpaca /v1beta1/options/bars, SPXW, real daily closes",
    strikeSelection: "IDENTICAL to #45 (Black-Scholes inversion at 20-delta / 5-delta), rounded to the nearest listed 25-point strike, so the comparison isolates PRICING not selection.",
    episodes: rows.length, skipped: noChain,
    creditRatio: { mean: mR, sd: sR, aboveOne: ratios.filter(x => x > 1).length, verdict: verdictRatio },
    realPricing: real, modelPricing: model, rows,
    caveats: [
      "2.5 years, and quiet ones. No event resembling Feb 2018 or Mar 2020 is in this window.",
      "Entry at the contract's daily CLOSE — not a modelled mid, but not a live fill either. Bid-ask is not crossed.",
      "Strikes rounded to the nearest listed 25-point increment, so the realised delta drifts slightly from exactly 20.",
      "Settlement is intrinsic against the index close; SPX settles AM on standard expiries, which this does not model.",
    ],
  }, null, 1));
  console.log(`\n  written: backend/data/credit-spread-realprice-58.json\n`);
})();
