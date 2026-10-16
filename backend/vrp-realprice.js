/**
 * TEST #83 — TEST #42's 10-DAY STRADDLE AT REAL OPTION PRICES
 *
 * WHY THIS EXISTS. #42's E1 cell is the best risk-adjusted number in the registry: SPX/VIX
 * 1990-2001, n=300 non-overlapping episodes, mean +0.73%/episode, t=7.33, Sharpe 2.12, worst
 * episode -6.85%. Two foundations under it are the weakest in the registry and BOTH are fixable
 * with data already on the existing free Alpaca key:
 *   (1) pre-2003 VIX is a retroactive RECONSTRUCTION, not a live quote;
 *   (2) the payoff is a BLACK-SCHOLES APPROXIMATION -- P&L% = 0.7979*sigma*sqrt(10/252) - |S_T/S_0-1|
 *       -- not a traded instrument. Real spreads, assignment and crash margin are unmodelled and
 *       every one of them SUBTRACTS.
 * #58 did exactly this for test #45 and found the answer #45 could not reach. Same method here.
 *
 * SPECIFICATION -- FROZEN BEFORE THE FIRST RUN. One cell. No grid. Nothing free to move.
 *   - Short a 10-TRADING-DAY ATM straddle on SPX, expressed in real SPXW contracts.
 *   - Strike K = spot rounded to the nearest listed 25-point strike. ATM, no delta targeting.
 *   - Entry credit = REAL SPXW call close + REAL SPXW put close at K, on the entry session.
 *   - Held to expiry. Terminal payoff is exact and needs no exit quote: |S_T - K|.
 *   - P&L as % of notional = (credit - |S_T - K|) / S_0 - COST, COST = 5% of premium (#42 baseline).
 *   - Non-overlapping episodes only: step 10 trading days. Overlapping would inflate n ~10x.
 *   - Window = whatever SPXW daily bars support (~2024-01 forward on this key).
 *
 * PRIMARY OUTPUT -- the PRICING RATIO, not the performance.  real credit / modelled credit.
 *   This is the question #42 could not answer: was its BS credit a fair stand-in for a tradeable
 *   one? A ratio near 1.0 means the Sharpe 2.12 is not a pricing artifact. A ratio well under 1.0
 *   means #42 was collecting a premium that does not exist at real prices, and the E1 result dies.
 *   The primary is chosen as the ratio BECAUSE the performance arm is structurally underpowered
 *   here: ~2.5 years of SPXW history yields ~60 non-overlapping episodes against #42's n=300.
 *
 * SECONDARY OUTPUT -- net performance, REPORTED WITH ITS SAMPLE STATED AND NOT GRADED.
 *   No bar is set on it and no funding decision may cite it. It is descriptive.
 *
 * WHAT THIS TEST CANNOT DO. It cannot resurrect #42 on its own -- ~60 episodes in a single
 * low-realised-vol regime is not evidence of a premium. It can only KILL the pricing objection
 * or CONFIRM it. If the ratio holds, the honest next step is a forward pre-registration with
 * vol-target sizing declared in advance (see #43's meta-multiplicity warning: three consecutive
 * not-establisheds on this premium, each after a post-hoc risk re-spec -- do NOT re-tune sizing
 * against the same 35 years).
 *
 * Usage: node backend/vrp-realprice.js
 */
const fs = require("fs"), path = require("path");
(function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} })();
const AH = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, Accept: "application/json" };
const MKT = "http://localhost:3002/api/yahoo";

const H = 10;                    // trading days -- FIXED, carried from #42
const COST = 0.05;               // fraction of premium -- FIXED, #42 baseline
const STRIKE_STEP = 25;
const PHI0 = 0.3989422804014327;
const STRADDLE_K = 2 * PHI0;     // 0.7979 -- #42's ATM straddle credit coefficient

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const pc = (v, d = 2) => v == null ? "     —" : (v >= 0 ? "+" : "") + (100 * v).toFixed(d) + "%";
const occ = (exp, cp, strike) => `SPXW${exp}${cp}${String(Math.round(strike * 1000)).padStart(8, "0")}`;

const barCache = new Map();
async function optBars(sym) {
  if (barCache.has(sym)) return barCache.get(sym);
  let out = [];
  try {
    const r = await fetch(`https://data.alpaca.markets/v1beta1/options/bars?symbols=${sym}&timeframe=1Day&start=2023-06-01&limit=1000`, { headers: AH, signal: AbortSignal.timeout(25000) });
    if (r.ok) { const j = await r.json(); out = (j.bars?.[sym] || []).map(b => ({ d: String(b.t).slice(0, 10), c: b.c })); }
  } catch {}
  barCache.set(sym, out); await sleep(70);
  return out;
}
const g = async (s) => { const r = await fetch(`${MKT}/${encodeURIComponent(s)}/history?days=1400&interval=1d`, { signal: AbortSignal.timeout(120000) }); if (!r.ok) throw new Error(s); return ((await r.json()).bars || []).filter(b => Number.isFinite(b.close)); };

(async () => {
  console.log(`\n  TEST #83 — TEST #42's 10-DAY STRADDLE AT REAL SPXW PRICES`);
  console.log(`  spec frozen before first run · one cell · PRIMARY = real credit / modelled credit`);
  console.log(`  performance arm is underpowered by construction and is NOT graded\n`);

  const [spx, vix] = await Promise.all([g("^GSPC"), g("^VIX")]);
  const V = new Map(vix.map(b => [b.date, b.close]));
  const P = new Map(spx.map(b => [b.date, b.close]));
  const dates = spx.map(b => b.date).filter(d => V.has(d));
  const start = dates.findIndex(d => d >= "2024-01-02");
  console.log(`  index window ${dates[start]} → ${dates[dates.length - 1]} · stepping ${H} trading days, non-overlapping\n`);

  const rows = [];
  let noChain = 0;
  for (let i = start; i + H < dates.length; i += H) {
    const d = dates[i], S = P.get(d), iv = V.get(d) / 100, T = H / 252;
    if (!(S > 0 && iv > 0)) continue;
    const K = Math.round(S / STRIKE_STEP) * STRIKE_STEP;

    // locate a listed expiry near the H-day target date
    const targetDate = dates[i + H];
    const cands = [];
    for (let off = 0; off <= 4; off++) for (const s of (off === 0 ? [0] : [off, -off])) {
      const dt = new Date(targetDate + "T00:00:00Z"); dt.setUTCDate(dt.getUTCDate() + s);
      cands.push(dt.toISOString().slice(0, 10));
    }
    let expIso = null, callBars = null;
    for (const c of cands) {
      const exp = c.slice(2).replace(/-/g, "");
      const b = await optBars(occ(exp, "C", K));
      if (b.some(x => x.d === d)) { expIso = c; callBars = b; break; }
    }
    if (!expIso) { noChain++; continue; }
    const exp = expIso.slice(2).replace(/-/g, "");
    const putBars = await optBars(occ(exp, "P", K));
    const cEntry = callBars.find(x => x.d === d)?.c;
    const pEntry = putBars.find(x => x.d === d)?.c;
    if (!(cEntry > 0) || !(pEntry > 0)) { noChain++; continue; }

    const realCredit = cEntry + pEntry;
    const modelCredit = STRADDLE_K * iv * Math.sqrt(T) * S;   // #42's BS approximation, in points
    const ST = P.get(expIso) ?? P.get(dates[i + H]);
    if (!(ST > 0) || !(realCredit > 0) || !(modelCredit > 0)) { noChain++; continue; }

    const payoff = Math.abs(ST - K);
    const netReal = (realCredit * (1 - COST) - payoff) / S;
    const netModel = (modelCredit * (1 - COST) - Math.abs(ST - S)) / S;

    rows.push({
      d, exp: expIso, S: +S.toFixed(0), K, iv: +(100 * iv).toFixed(1),
      realCredit: +realCredit.toFixed(2), modelCredit: +modelCredit.toFixed(2),
      ratio: realCredit / modelCredit, ST: +ST.toFixed(0),
      move: +(100 * Math.abs(ST / S - 1)).toFixed(2), netReal, netModel,
    });
    process.stdout.write(".");
  }
  console.log(`\n\n  episodes priced: ${rows.length} · skipped for no listed chain: ${noChain}\n`);
  if (rows.length < 5) { console.log("  INSUFFICIENT CHAIN COVERAGE — nothing to report."); return; }

  const ratios = rows.map(r => r.ratio);
  const mR = mean(ratios), sdR = sd(ratios);
  console.log(`  ===== PRIMARY: PRICING =====`);
  console.log(`  real credit / modelled credit : mean ${mR.toFixed(4)}  sd ${sdR.toFixed(4)}  median ${[...ratios].sort((a,b)=>a-b)[Math.floor(ratios.length/2)].toFixed(4)}`);
  console.log(`  range ${Math.min(...ratios).toFixed(3)} – ${Math.max(...ratios).toFixed(3)}`);
  console.log(`  mean real credit ${mean(rows.map(r=>r.realCredit)).toFixed(1)} pts vs modelled ${mean(rows.map(r=>r.modelCredit)).toFixed(1)} pts`);
  console.log(`  INTERPRETATION: ratio < 1 means #42's BS credit OVERSTATED what the market pays.\n`);

  const nr = rows.map(r => r.netReal), nm = rows.map(r => r.netModel);
  const tOf = (a) => mean(a) / (sd(a) / Math.sqrt(a.length));
  const shOf = (a) => mean(a) / sd(a) * Math.sqrt(252 / H);
  console.log(`  ===== SECONDARY: PERFORMANCE (n=${rows.length}, NOT GRADED, NO BAR) =====`);
  console.log(`  at REAL prices  : mean ${pc(mean(nr))}/episode  t ${tOf(nr).toFixed(2)}  Sharpe ${shOf(nr).toFixed(2)}  win ${(100*nr.filter(x=>x>0).length/nr.length).toFixed(0)}%  worst ${pc(Math.min(...nr))}`);
  console.log(`  at MODEL prices : mean ${pc(mean(nm))}/episode  t ${tOf(nm).toFixed(2)}  Sharpe ${shOf(nm).toFixed(2)}  win ${(100*nm.filter(x=>x>0).length/nm.length).toFixed(0)}%  worst ${pc(Math.min(...nm))}`);
  console.log(`  #42 E1 for reference: mean +0.73%/episode  t 7.33  Sharpe 2.12  win 72%  worst -6.85%  (n=300, modelled)\n`);

  console.log(`  worst 5 episodes at real prices:`);
  for (const r of [...rows].sort((a,b)=>a.netReal-b.netReal).slice(0,5))
    console.log(`    ${r.d} → ${r.exp}  S ${r.S} K ${r.K} VIX ${r.iv}  credit ${r.realCredit} (model ${r.modelCredit}, ratio ${r.ratio.toFixed(2)})  move ${r.move}%  net ${pc(r.netReal)}`);

  const out = {
    test: 83, ranAt: new Date().toISOString(),
    spec: { horizonDays: H, cost: COST, strike: "ATM nearest 25", settle: "held to expiry, payoff |S_T-K|", nonOverlapping: true },
    window: { from: rows[0].d, to: rows[rows.length-1].exp }, n: rows.length, noChain,
    primary: { meanRatio: mR, sdRatio: sdR, meanRealCredit: mean(rows.map(r=>r.realCredit)), meanModelCredit: mean(rows.map(r=>r.modelCredit)) },
    secondary: { real: { mean: mean(nr), t: tOf(nr), sharpe: shOf(nr), worst: Math.min(...nr) }, model: { mean: mean(nm), t: tOf(nm), sharpe: shOf(nm), worst: Math.min(...nm) } },
    rows,
  };
  fs.writeFileSync(path.join(__dirname, "data", "vrp-realprice.json"), JSON.stringify(out, null, 2));
  console.log(`\n  written backend/data/vrp-realprice.json\n`);
})();
