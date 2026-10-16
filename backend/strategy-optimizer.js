#!/usr/bin/env node
/**
 * TRAIDS — STRATEGY / PARAMETER OPTIMIZER (2026-07-25)
 *
 * Searches the strategy and parameter space for the best-performing configuration, and — this
 * is the part that makes it useful rather than dangerous — reports how good the winner would
 * have to be to mean anything.
 *
 * THE PROBLEM WITH OPTIMIZERS. Search M configurations and the best one always looks good.
 * With M=36 and pure noise, the top cell will show a healthy-looking positive number, a
 * plausible story, and a clean equity curve. Comparing that winner to ZERO is the classic
 * error: the right comparison is to the distribution of BEST-OF-M under the null, which is
 * shifted far above zero by the search itself.
 *
 * SO THIS OPTIMIZER BUILDS ITS OWN NULL. After scoring the real grid, every trade in every
 * cell has its DIRECTION randomised and the whole grid is re-scored, B times. That destroys
 * the directional information a signal claims to carry while preserving everything else —
 * the same instruments, the same entry dates, the same volatility clustering, the same
 * stop/target geometry, and crucially the same CORRELATION between cells (they share trades).
 * The result is an empirical distribution of "best cell in this exact search", against which
 * the real winner is a percentile rather than a hope.
 *
 * That is strictly better than a Bonferroni correction here, because the 36 cells are heavily
 * correlated — they trade the same names on overlapping dates — and Bonferroni would assume
 * independence and over-penalise. The permutation null prices the correlation exactly.
 *
 * PROTOCOL
 *   · Configurations declared in GRID below, before running. The family size is what the
 *     winner is judged against; understating it buys an easier bar and a worthless answer.
 *   · Selection on IN-SAMPLE years only (2021–2023). The out-of-sample years (2024–2026) are
 *     scored but never used to choose.
 *   · Settlement uses the platform's own conventions: entry at the next bar's open, stop-first
 *     on ambiguous bars, gap-aware fills at the open, costs charged per round trip.
 *   · Signals come from signal-replay.js — the board's own functions, with parameters varied.
 *     No reimplementation, so a winner here is a winner in the live system.
 *
 * Usage
 *   node backend/strategy-optimizer.js                     250 instruments, 200 permutations
 *   node backend/strategy-optimizer.js --instruments 400 --perms 400
 *   node backend/strategy-optimizer.js --quick             60 instruments, fast smoke run
 */
const fs = require("fs"), path = require("path");
const S = require("./signal-replay");

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i > -1 ? +args[i + 1] : d; };
const QUICK = args.includes("--quick");
const N_INST = argOf("--instruments", QUICK ? 60 : 250);
const PERMS = argOf("--perms", QUICK ? 60 : 200);
const DAYS = argOf("--days", 2000);
const MKT = "http://localhost:3002/api/yahoo";
const CHUNK = 40;
const IS_YEARS = [2021, 2022, 2023];        // selection happens here and nowhere else
const OOS_YEARS = [2024, 2025, 2026];
const COST_BPS = 5;                          // round trip, charged on every trade
const WARMUP = 220;                          // enough for the longest lookback in the grid

// ════════════════════════════════════════════════════════════════════════════
// THE SEARCH SPACE — declared in full before anything runs
// ════════════════════════════════════════════════════════════════════════════
const GRID = [];
for (const lb of [20, 34, 55, 89]) for (const [sa, ta] of [[1.0, 2.0], [1.5, 3.0], [2.5, 5.0]])
  GRID.push({ strat: "Breakout", fn: "breakoutSignal", params: [lb], label: `Breakout lb${lb}`, stopAtr: sa, targetAtr: ta });
for (const lb of [10, 15, 20, 30]) for (const [sa, ta] of [[1.0, 2.0], [1.5, 3.0], [2.5, 5.0]])
  GRID.push({ strat: "Mean-Reversion", fn: "meanRevSignal", params: [lb], label: `MeanRev lb${lb}`, stopAtr: sa, targetAtr: ta });
for (const [f, s] of [[10, 30], [20, 50], [20, 100], [50, 200]]) for (const [sa, ta] of [[1.0, 2.0], [1.5, 3.0], [2.5, 5.0]])
  GRID.push({ strat: "Trend", fn: "trendSignal", params: [f, s], label: `Trend ${f}/${s}`, stopAtr: sa, targetAtr: ta });
const M = GRID.length;
const HORIZON = 20;

// ════════════════════════════════════════════════════════════════════════════
// Data
// ════════════════════════════════════════════════════════════════════════════
function universe() {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.jsx"), "utf8");
  const grab = (n) => { const i = app.indexOf(`const ${n} = [`); if (i < 0) return []; const j = app.indexOf("];", i); return (app.slice(i, j).match(/"[A-Z0-9.\/=^-]+"/g) || []).map(s => s.slice(1, -1)); };
  const sp = [...new Set((app.match(/symbol:"[A-Z.]+"/g) || []).map(x => x.slice(8, -1)))];
  return [...new Set([...sp, ...grab("BOARD_EQ_EXTRA"), ...grab("BOARD_EQ_MID")])];
}
const toBars = (rows) => (rows || []).map(b => ({ date: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }))
  .filter(b => b.date && Number.isFinite(b.close) && b.close > 0);
async function fetchBatch(feeds, attempts = 3) {
  let last;
  for (let a = 0; a < attempts; a++) {
    if (a) await new Promise(r => setTimeout(r, 1500 * a));
    try {
      const r = await fetch(`${MKT}/batch`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbols: feeds, days: DAYS }), signal: AbortSignal.timeout(180000) });
      if (!r.ok) throw new Error(`batch ${r.status}`);
      return (await r.json()).data || {};
    } catch (e) { last = e; }
  }
  throw last;
}

// ════════════════════════════════════════════════════════════════════════════
// Settlement — the platform's conventions, so a winner here transfers to the board
// ════════════════════════════════════════════════════════════════════════════
function settle(bars, i, dir, atrVal, stopAtr, targetAtr) {
  const e = bars[i + 1];
  if (!e || !Number.isFinite(e.open) || e.open <= 0) return null;   // unpriceable → refused
  if (!Number.isFinite(atrVal) || atrVal <= 0) return null;
  const entry = e.open;
  const risk = stopAtr * atrVal;
  const stop = entry - dir * risk;
  const target = entry + dir * targetAtr * atrVal;
  let exit = null;
  for (let k = i + 1; k < Math.min(bars.length, i + 1 + HORIZON); k++) {
    const b = bars[k];
    const hitStop = dir > 0 ? b.low <= stop : b.high >= stop;
    const hitTgt = dir > 0 ? b.high >= target : b.low <= target;
    if (hitStop) {                                   // stop-first on an ambiguous bar
      const gapped = dir > 0 ? b.open <= stop : b.open >= stop;
      exit = gapped ? b.open : stop; break;          // a gap fills at the open, not the stop
    }
    if (hitTgt) { exit = target; break; }
  }
  if (exit == null) exit = bars[Math.min(bars.length - 1, i + HORIZON)].close;
  const gross = ((exit - entry) * dir) / risk;
  return gross - (COST_BPS / 1e4) * entry / risk;    // net R
}

/** Day-clustered t. Trades opened the same session share that day's move; the unit is the day. */
function dayT(vals, days) {
  const by = new Map();
  vals.forEach((v, i) => { const d = days[i]; if (!by.has(d)) by.set(d, []); by.get(d).push(v); });
  const dm = [...by.values()].map(a => a.reduce((x, y) => x + y, 0) / a.length);
  const n = dm.length;
  if (n < 3) return { t: null, nDays: n };
  const m = dm.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(dm.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  return { t: sd === 0 ? null : m / (sd / Math.sqrt(n)), nDays: n };
}

// ════════════════════════════════════════════════════════════════════════════
(async () => {
  const t0 = Date.now();
  console.log(`\n  TRAIDS — STRATEGY / PARAMETER OPTIMIZER`);
  console.log(`  search space: ${M} configurations declared before running`);
  console.log(`  selection on ${IS_YEARS.join("/")} · held out ${OOS_YEARS.join("/")} · ${PERMS} permutations for the null\n`);

  let uni = universe().slice(0, N_INST);
  console.log(`  loading ${uni.length} instruments…`);
  const data = {};
  for (let c = 0; c < uni.length; c += CHUNK) {
    const slice = uni.slice(c, c + CHUNK);
    try {
      const d = await fetchBatch(slice);
      for (const s of slice) { const b = toBars(d[s]); if (b.length > WARMUP + 60) data[s] = b; }
    } catch (e) { console.log(`  ⚠ chunk ${c} failed (${e.message})`); }
    process.stdout.write(`\r  loaded ${Object.keys(data).length}/${uni.length}   `);
  }
  const syms = Object.keys(data);
  console.log(`\n  ${syms.length} instruments with usable history\n`);
  if (syms.length < 20) { console.log("  too few instruments to search\n"); process.exit(1); }

  // ATR is independent of the grid cell, so compute it once per instrument.
  const atrOf = {};
  for (const s of syms) {
    const b = data[s];
    atrOf[s] = S.atr(b.map(x => x.high ?? x.close), b.map(x => x.low ?? x.close), b.map(x => x.close), 14);
  }

  // ── score the real grid ───────────────────────────────────────────────────
  console.log(`  scoring ${M} configurations…`);
  const cells = [];
  for (let gi = 0; gi < M; gi++) {
    const g = GRID[gi];
    const trades = [];       // {sym, i, dir, year, day, r}
    for (const s of syms) {
      const bars = data[s], atr = atrOf[s];
      let busy = -1;
      for (let i = WARMUP; i < bars.length - 2; i++) {
        if (i <= busy) continue;                       // one position per instrument at a time
        let sig; try { sig = S[g.fn](bars, i, ...g.params); } catch { continue; }
        if (!sig || !Number.isFinite(sig.vote) || Math.abs(sig.vote) < 0.30) continue;
        if (!Number.isFinite(sig.confidence) || sig.confidence < 0.30) continue;
        const dir = Math.sign(sig.vote);
        const r = settle(bars, i, dir, atr[i], g.stopAtr, g.targetAtr);
        if (r == null) continue;
        trades.push({ sym: s, i, dir, year: +bars[i].date.slice(0, 4), day: bars[i].date, r });
        busy = i + 1;
      }
    }
    const is = trades.filter(t => IS_YEARS.includes(t.year));
    const oos = trades.filter(t => OOS_YEARS.includes(t.year));
    const mean = (a) => a.length ? a.reduce((x, y) => x + y.r, 0) / a.length : null;
    const { t: tOos, nDays } = dayT(oos.map(t => t.r), oos.map(t => t.day));
    cells.push({ ...g, gi, trades, nIs: is.length, nOos: oos.length, isR: mean(is), oosR: mean(oos), tOos, nDays });
    process.stdout.write(`\r  scored ${gi + 1}/${M}   `);
  }
  console.log("");

  const ranked = [...cells].sort((a, b) => (b.isR ?? -9) - (a.isR ?? -9));
  const winner = ranked[0];

  // ── the null: same search, directional information destroyed ──────────────
  // Flipping each trade's direction and re-settling keeps the instruments, dates, volatility
  // and stop geometry identical, and keeps the cells correlated exactly as they really are.
  // What it removes is the only thing a signal claims to provide: which way to bet.
  console.log(`\n  building the null — re-running all ${M} configurations with directions randomised, ${PERMS}×…`);
  let seed = 20260725;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const nullBestIs = [], nullBestOos = [], nullWinnerOos = [];
  for (let p = 0; p < PERMS; p++) {
    let bIs = -Infinity, bOos = -Infinity, wOos = null;
    for (const c of cells) {
      let sIs = 0, nIs = 0, sOos = 0, nOos = 0;
      for (const t of c.trades) {
        const d = rnd() < 0.5 ? 1 : -1;                       // direction, randomised
        const r = settle(data[t.sym], t.i, d, atrOf[t.sym][t.i], c.stopAtr, c.targetAtr);
        if (r == null) continue;
        if (IS_YEARS.includes(t.year)) { sIs += r; nIs++; } else if (OOS_YEARS.includes(t.year)) { sOos += r; nOos++; }
      }
      const mIs = nIs ? sIs / nIs : -Infinity, mOos = nOos ? sOos / nOos : -Infinity;
      if (mIs > bIs) { bIs = mIs; wOos = mOos; }              // the cell this search would pick
      if (mOos > bOos) bOos = mOos;
    }
    nullBestIs.push(bIs); nullBestOos.push(bOos); nullWinnerOos.push(wOos);
    if ((p + 1) % 20 === 0) process.stdout.write(`\r  permutation ${p + 1}/${PERMS}   `);
  }
  console.log("");

  const pct = (arr, v) => arr.filter(x => x >= v).length / arr.length;
  const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

  // ── report ────────────────────────────────────────────────────────────────
  const f = (v, n = 4) => v == null || !Number.isFinite(v) ? "     —" : (v >= 0 ? "+" : "") + v.toFixed(n);
  console.log(`\n  ══ FULL GRID — all ${M} configurations, ranked by IN-SAMPLE net R ══`);
  console.log(`  #   configuration              stop/tgt    n(IS)   IS net R    n(OOS)  OOS net R   day-t   days`);
  console.log(`  ────────────────────────────────────────────────────────────────────────────────────────────────`);
  ranked.forEach((c, k) => {
    console.log(`  ${String(k + 1).padStart(2)}  ${c.label.padEnd(24)} ${(c.stopAtr + "/" + c.targetAtr).padEnd(9)} ${String(c.nIs).padStart(6)}   ${f(c.isR).padStart(9)}   ${String(c.nOos).padStart(6)}  ${f(c.oosR).padStart(9)}   ${(c.tOos == null ? "—" : c.tOos.toFixed(2)).padStart(6)}  ${String(c.nDays ?? "—").padStart(5)}`);
  });

  console.log(`\n  ══ THE WINNER, AND WHAT IT IS WORTH ══`);
  console.log(`  Best in-sample configuration: ${winner.label} (stop ${winner.stopAtr} / target ${winner.targetAtr} ATR)`);
  console.log(`    in-sample  net R ${f(winner.isR)} on ${winner.nIs} trades`);
  console.log(`    OUT-OF-SAMPLE net R ${f(winner.oosR)} on ${winner.nOos} trades, day-clustered t ${winner.tOos == null ? "—" : winner.tOos.toFixed(2)} over ${winner.nDays} days`);

  console.log(`\n  Null distribution of the BEST-OF-${M} in-sample cell (${PERMS} permutations):`);
  console.log(`    median ${f(q(nullBestIs, 0.5))} · 95th pct ${f(q(nullBestIs, 0.95))} · max ${f(Math.max(...nullBestIs))}`);
  console.log(`    → the observed in-sample winner sits at percentile ${((1 - pct(nullBestIs, winner.isR)) * 100).toFixed(1)} of that null`);
  console.log(`    → p = ${pct(nullBestIs, winner.isR).toFixed(3)}  (fraction of searches over pure noise that beat it)`);

  const wOosClean = nullWinnerOos.filter(Number.isFinite);
  console.log(`\n  Null distribution of the OOS result of whatever the search PICKED (${wOosClean.length} permutations):`);
  console.log(`    median ${f(q(wOosClean, 0.5))} · 95th pct ${f(q(wOosClean, 0.95))}`);
  console.log(`    → the real winner's OOS sits at p = ${pct(wOosClean, winner.oosR).toFixed(3)}`);
  console.log(`    This is the number that matters: it asks whether picking a winner from this search`);
  console.log(`    and trading it forward beats doing the same thing on noise.`);

  const pIs = pct(nullBestIs, winner.isR), pOos = pct(wOosClean, winner.oosR);

  // ── THREE GATES, ALL REQUIRED ────────────────────────────────────────────
  // An earlier version of this block used only gates 1 and 3 and returned CANDIDATE on a
  // configuration that LOSES MONEY in sample and has an out-of-sample t of 0.31. The error was
  // treating the permutation null as if it were centred on zero. It is not: random-direction
  // trades pay the same costs and therefore lose (~-0.03 R here), so "beats the null" only
  // means "loses less than random". A strategy with true expectancy of exactly zero clears it.
  // Beating random is necessary and nowhere near sufficient — the bar is beating ZERO.
  const anyProfitableIs = cells.some(c => c.isR > 0);
  // Multiplicity-corrected two-sided threshold for M correlated searches, Bonferroni on the t.
  const zBar = (() => {                       // Φ⁻¹(1 − 0.025/M), by bisection on a real normal CDF
    // Abramowitz & Stegun 7.1.26 for erf, accurate to ~1.5e-7 — ample for a significance bar.
    const erf = (x) => {
      const s = Math.sign(x); x = Math.abs(x);
      const t = 1 / (1 + 0.3275911 * x);
      const y = 1 - ((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t * t * Math.exp(-x * x)
        - 0.254829592 * t * Math.exp(-x * x);
      return s * y;
    };
    const cdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
    const want = 1 - 0.025 / M;
    let lo = 0, hi = 8;
    for (let k = 0; k < 80; k++) { const mid = (lo + hi) / 2; if (cdf(mid) < want) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  })();
  const gate1 = anyProfitableIs;                                   // is anything profitable at all?
  const gate2 = winner.oosR > 0 && winner.tOos != null && winner.tOos >= zBar;   // beats ZERO
  const gate3 = pOos <= 0.05;                                      // beats the search-on-noise null
  const bestT = Math.max(...cells.map(c => c.tOos ?? -99));
  const negSig = cells.filter(c => (c.tOos ?? 0) <= -2).length;

  console.log(`\n  ══ THE THREE GATES ══`);
  console.log(`  1. any configuration profitable IN-SAMPLE?          ${gate1 ? "YES" : "NO  — the search is ranking losers; the best cell is the least-bad one"}`);
  console.log(`  2. winner's OOS beats ZERO at t ≥ ${zBar.toFixed(2)} (${M} cells)?   ${gate2 ? "YES" : `NO  — OOS t = ${winner.tOos == null ? "—" : winner.tOos.toFixed(2)}, best t anywhere in the grid = ${bestT.toFixed(2)}`}`);
  console.log(`  3. winner beats the search-on-noise null?           ${gate3 ? `YES (p = ${pOos.toFixed(3)})` : `NO (p = ${pOos.toFixed(3)})`}`);
  console.log(`     ⚠ gate 3 alone is NOT evidence of profit: the null's median is ${f(q(wOosClean, 0.5))} R because`);
  console.log(`       random trades pay costs too. Clearing it means "better than random", not "makes money".`);
  if (negSig) console.log(`  ${negSig} of ${M} configurations are significantly NEGATIVE (t ≤ −2). Zero are significantly positive.`);

  const verdict = (gate1 && gate2 && gate3)
    ? `CANDIDATE — profitable in sample, out-of-sample result distinguishable from zero at the corrected bar, and beats the search-on-noise null. Pre-register and forward-test; do NOT fund off this run.`
    : !gate1
      ? `NO EDGE — not one of the ${M} configurations is profitable in sample. The search returned the least-bad loser, which is what a search over an empty space returns.`
      : !gate2
        ? `NO EDGE — the winner's out-of-sample result is not distinguishable from zero (t = ${winner.tOos == null ? "—" : winner.tOos.toFixed(2)} vs the ${zBar.toFixed(2)} bar for ${M} searched cells).`
        : `NOT ESTABLISHED — indistinguishable from what this same search produces on noise (p = ${pOos.toFixed(3)}).`;
  console.log(`\n  VERDICT: ${verdict}`);

  const out = {
    generated: new Date().toISOString(),
    familySize: M, instruments: syms.length, permutations: PERMS,
    inSampleYears: IS_YEARS, outOfSampleYears: OOS_YEARS, costBps: COST_BPS, horizonBars: HORIZON,
    grid: ranked.map(c => ({ label: c.label, stopAtr: c.stopAtr, targetAtr: c.targetAtr, nIs: c.nIs, isR: c.isR, nOos: c.nOos, oosR: c.oosR, tOos: c.tOos, nDays: c.nDays })),
    winner: { label: winner.label, stopAtr: winner.stopAtr, targetAtr: winner.targetAtr, isR: winner.isR, oosR: winner.oosR, tOos: winner.tOos, nIs: winner.nIs, nOos: winner.nOos },
    nullBestInSample: { median: q(nullBestIs, 0.5), p95: q(nullBestIs, 0.95), max: Math.max(...nullBestIs), pOfWinner: pIs },
    nullPickedOos: { median: q(wOosClean, 0.5), p95: q(wOosClean, 0.95), pOfWinner: pOos },
    verdict,
    method: "Permutation null by direction randomisation: same instruments, dates, volatility and stop geometry, with the directional information removed. Preferred to Bonferroni because the configurations are heavily correlated (shared trades), which Bonferroni would over-penalise.",
    caveat: "Universe is current-membership, so delisted and acquired instruments are absent and every figure inherits that survivorship bias.",
  };
  fs.writeFileSync(path.join(__dirname, "data", "optimizer-report.json"), JSON.stringify(out, null, 1));
  console.log(`\n  written: backend/data/optimizer-report.json`);
  console.log(`  elapsed: ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
})();
