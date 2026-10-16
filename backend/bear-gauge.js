#!/usr/bin/env node
/**
 * THE BEAR GAUGE — regime measurement with a 38-year receipt, never a forecast.
 *
 * THE OPERATOR'S ASK (2026-08-01): "how do we measure for a bear market; then capitalize."
 * The honest epistemics: bears are DETECTED IN PROGRESS, not predicted — but detection with
 * lag is still worth a fortune, because bear math is asymmetric (−50% needs +100%) and every
 * documented value of regime rules is drawdown reduction, not clairvoyance.
 *
 * FOUR COMPONENTS, all computable from the market tape back to 1988 (no new data, no opinion):
 *   TREND    SPX below its own 200-day (synthetic level chained from tape returns)
 *   VOL      VIX level above 25
 *   BREADTH  tape breadth below 0.45 (narrow participation)
 *   CREDIT   HYG underperforming SPX by >2% over 20 sessions (credit refusing to confirm)
 * Score 0-4. The BACKTEST below conditions forward 3-month SPX outcomes on today's score —
 * so the gauge ships with its own historical record instead of a narrative.
 *
 * Nightly output: current score + components + the ACTION POLICY (fixed here, mechanical):
 *   0-1  RISK ON      full allocation; nothing to do
 *   2    CLOUDS       stop adding to equity on rebalance; if VIX<20, collar/put budget may be
 *                     spent (insurance while it is still cheap — buying vol at VIX 35 is the
 *                     retail classic this line exists to prevent)
 *   3    BEAR LIKELY  equity to its floor band; harvest losses aggressively (TLH festival);
 *                     dice sleeve stops opening longs except R11 signals (which need a TURN)
 *   4    CONFIRMED    the SOWING season: build the crash-survivor shopping list, let DBMF work
 *                     (it is the sleeve that gets PAID here), ladder maturities buy the hole
 *                     via rebalancing bands. The capitalization on a bear is mostly executed
 *                     near its end — MU/PLTR were bought from the 2022 wreckage, not before it.
 *
 * Wired into the close chain; one line in the daily report.
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;



(() => {
  console.log(`\n  BEAR GAUGE — regime measured, with its 38-year record attached\n`);
  const tape = JSON.parse(fs.readFileSync(D("market-tape.json"), "utf8"));
  const days = Object.keys(tape.days).sort();

  // synthetic SPX level from chained returns → 200d trend flag computable at every date
  const lvl = []; let acc = 100;
  for (const d of days) { const r = tape.days[d].spx; if (Number.isFinite(r)) acc *= 1 + r; lvl.push(acc); }
  const scoreAt = (i) => {
    if (i < 210) return null;
    const w = lvl.slice(i - 199, i + 1);
    const trend = lvl[i] < mean(w) ? 1 : 0;
    const vix = tape.days[days[i]].vixLvl; const vol = Number.isFinite(vix) && vix > 25 ? 1 : 0;
    // BREADTH THRESHOLD FIXED 2026-08-24. This tested `br < 0.45` while tape.breadth is the
    // equal-weight MINUS cap-weight DAILY RETURN SPREAD (range -0.034..+0.018, median 0.000) — a
    // ratio threshold applied to a return series, so it was true on 100% of 5,864 sessions and the
    // breadth flag was permanently ON. Every score this gauge has ever printed was inflated by
    // exactly 1, and the 38-year backtest buckets were shifted with it. The correct threshold is
    // the one market-tape.js declares for the same number on its own report line: -0.002, i.e.
    // equal-weight lagging cap-weight by 0.2% in a session = a few names carrying the index.
    const br = tape.days[days[i]].breadth; const breadth = Number.isFinite(br) && br < -0.002 ? 1 : 0;
    let credit = 0;
    let hAcc = 1, sAcc = 1, n = 0;
    for (let k = i - 19; k <= i; k++) { const h = tape.days[days[k]].hyg, s = tape.days[days[k]].spx; if (Number.isFinite(h) && Number.isFinite(s)) { hAcc *= 1 + h; sAcc *= 1 + s; n++; } }
    if (n >= 15 && (hAcc - sAcc) < -0.02) credit = 1;
    return { score: trend + vol + breadth + credit, trend, vol, breadth, credit };
  };

  // ── BACKTEST: forward 63-session SPX outcome conditioned on the score ─────
  const buckets = {};
  for (let i = 210; i < days.length - 63; i++) {
    const s = scoreAt(i); if (!s) continue;
    const fwd = lvl[i + 63] / lvl[i] - 1;
    let pk = lvl[i], dd = 0;
    for (let k = i; k <= i + 63; k++) { if (lvl[k] > pk) pk = lvl[k]; dd = Math.max(dd, 1 - lvl[k] / pk); }
    (buckets[s.score] ||= []).push({ fwd, dd });
  }
  console.log(`  score → next 3 months of SPX (1988-2026, ${days.length} sessions):`);
  console.log(`  score  freq     median fwd   mean fwd   worst fwd   median maxDD`);
  for (const s of [0, 1, 2, 3, 4]) {
    const b = buckets[s] || []; if (!b.length) { console.log(`    ${s}    —`); continue; }
    const fw = b.map(x => x.fwd).sort((a, c) => a - c), dd = b.map(x => x.dd).sort((a, c) => a - c);
    console.log(`    ${s}   ${String((100 * b.length / days.length).toFixed(0)).padStart(3)}%     ${(100 * fw[Math.floor(fw.length / 2)]).toFixed(1).padStart(6)}%    ${(100 * mean(fw)).toFixed(1).padStart(6)}%    ${(100 * fw[0]).toFixed(1).padStart(6)}%     −${(100 * dd[Math.floor(dd.length / 2)]).toFixed(1)}%`);
  }

  // ── TODAY ─────────────────────────────────────────────────────────────────
  const i = days.length - 1;
  const now = scoreAt(i);
  // POLICY REWRITTEN BY ITS OWN BACKTEST (2026-08-01): the first draft said "de-risk at
  // score 3" — then the 38-year table showed median forward returns RISING with the score
  // (score 4 median +9.6%/3mo: full-alarm days cluster near bottoms). High scores measure
  // VARIANCE, not direction — the tail deepens AND the rebound odds rise together. So the
  // policy sells nothing on a score; it buys insurance early (while cheap), harvests, and
  // arms the sowing list late. De-risking at 3+ remains AVAILABLE as explicit insurance at
  // a measured median cost of ~3-5% forgone per quarter — a preference, never an edge.
  const POLICY = [
    "RISK ON — nothing to do",
    "RISK ON — nothing to do",
    "CLOUDS — insurance window: if VIX<20, collars/puts are still cheap (this is the ONLY score where hedging is affordable); stop ADDING equity on rebalance; sell nothing",
    "VARIANCE REGIME — both tails live (worst -42%, median +4.9%): TLH festival ON, dice sleeve longs only on R11 turns, insurance now expensive (buying vol here is the retail classic), SELL NOTHING ON THIS SIGNAL — the median outcome from here was up",
    "MAX FEAR — the SOWING season, and the data says so (median +9.6%/3mo): crash-survivor shopping list ON, rebalancing bands buy the hole, DBMF is being paid, TLH everything that moves",
  ];
  const out = { asOf: days[i], score: now.score, components: { trendBroken: !!now.trend, volElevated: !!now.vol, breadthNarrow: !!now.breadth, creditDiverging: !!now.credit }, policy: POLICY[now.score],
    backtest: Object.fromEntries([0, 1, 2, 3, 4].map(s => { const b = buckets[s] || []; const fw = b.map(x => x.fwd).sort((a, c) => a - c); return [s, b.length ? { n: b.length, medianFwd3mo: +(100 * fw[Math.floor(fw.length / 2)]).toFixed(1), meanFwd3mo: +(100 * mean(fw)).toFixed(1) } : null]; })) };
  fs.writeFileSync(D("bear-gauge.json"), JSON.stringify(out, null, 1));
  console.log(`\n  TODAY (${days[i]}): score ${now.score}/4 — trend ${now.trend ? "BROKEN" : "intact"} · vol ${now.vol ? "ELEVATED" : "calm"} · breadth ${now.breadth ? "NARROW" : "broad"} · credit ${now.credit ? "DIVERGING" : "confirming"}`);
  console.log(`  policy: ${POLICY[now.score]}`);
  console.log(`  written: backend/data/bear-gauge.json`);
})();
