"use strict";
/**
 * KNOWN-ANSWER + CALIBRATION TESTS for lib/selection-luck.js — synthetic data only, seeded, no I/O.
 *
 * The one that matters is CALIBRATION (R211 control "nullCalibration"): on a zero-skill universe — timing drawn independently of
 * the asset by a DIFFERENT process from the null's (Markov on/off, geometric run lengths), every strategy on its own asset path —
 * pLuck must be ~uniform (KS p > 0.05). Run for a long/flat universe and for a leveraged long/short/flat one.
 * PLANTED SKILL: 90 zero-skill strategies on hot/cold assets (big random drifts) + 10 skilled timers on the same kind of assets;
 * the skill score must put the skilled on top, and do it better than the raw leaderboard.
 *
 *   node backend/lib/selection-luck.test.js           (exit 1 on any failure)
 *   require("./selection-luck.test.js").run()         -> { passed, failed, lines, calibration }
 */
const L = require("./selection-luck.js");

function run({ quiet = false } = {}) {
  const lines = [], ok = [], bad = [], calibration = {};
  const check = (name, cond, detail) => { (cond ? ok : bad).push(name); lines.push(`${cond ? "  ok  " : "  FAIL"} ${name}${detail ? ` (${detail})` : ""}`); };
  const close = (a, b, tol) => Math.abs(a - b) <= tol;
  const g = L.mulberry(20260924), gauss = () => { let u = 0; for (let i = 0; i < 12; i++) u += g(); return u - 6; };

  // 1. probit / normCdf
  check("probit(0.975) = 1.95996", close(L.probit(0.975), 1.959964, 1e-5), L.probit(0.975).toFixed(6));
  check("probit(0.5) = 0", close(L.probit(0.5), 0, 1e-9));
  check("normCdf(probit(p)) = p", [0.001, 0.2, 0.9, 0.9999].every((p) => close(L.normCdf(L.probit(p)), p, 1e-6)));

  // 2. Storey q, hand example: p = [.01 .02 .03 .5 .9 .95], lambda .5 -> pi0 = 2/(6 x .5) = 2/3; q = [.04 .04 .04 .5 .6333 .6333]
  const sq = L.storeyQ([0.01, 0.02, 0.03, 0.5, 0.9, 0.95]), wantQ = [0.04, 0.04, 0.04, 0.5, 0.95 * 4 / 6, 0.95 * 4 / 6];
  check("storeyQ hand values", close(sq.pi0, 2 / 3, 1e-12) && sq.q.every((q, i) => close(q, wantQ[i], 1e-12)), sq.q.map((x) => x.toFixed(4)).join(","));
  check("storeyQ keeps nulls, no throw", (() => { const r = L.storeyQ([0.1, null, "x", 0.2]); return r.q[1] === null && r.q[2] === null && r.q[0] != null; })());

  // 3. randomTimingNull preserves time-in-market, switch count, exposure and asset-relative arithmetic
  const asset = Array.from({ length: 126 }, () => 0.02 * gauss());
  const N = L.randomTimingNull(asset, { inMarketFrac: 50 / 126, nSwitches: 7, sims: 200, seed: 5, shortFrac: 0.3, exposure: 1.5, returnPaths: 50 });
  const pathOk = N.paths.every((p) => p.filter((e) => e !== 0).length === 50 && p.slice(1).filter((e, t) => (e !== 0) !== (p[t] !== 0)).length === 7 && p.every((e) => e === 0 || Math.abs(e) === 1.5));
  check("null paths: exact in-market days and switches", pathOk);
  check("null paths: some short runs at shortFrac .3", N.paths.some((p) => p.some((e) => e < 0)) && N.paths.some((p) => p.some((e) => e > 0)));
  check("null assetRel = raw - buy-and-hold", N.assetRel.every((a, i) => close(a, N.raw[i] - N.bh, 1e-12)));
  check("null reproducible by seed", L.randomTimingNull(asset, { inMarketFrac: 0.4, nSwitches: 3, sims: 20, seed: 9 }).raw.join() === L.randomTimingNull(asset, { inMarketFrac: 0.4, nSwitches: 3, sims: 20, seed: 9 }).raw.join());
  check("infeasible -> null + reason, no throw", (() => { const r = L.randomTimingNull(asset, { inMarketFrac: 2 / 126, nSwitches: 10 }); return r.raw === null && /infeasible/.test(r.reason); })());
  check("bad input -> null + reason, no throw", [L.randomTimingNull(null, {}), L.skillScore([1, NaN], [1, 2]), L.luckLine([], 3), L.sharpeMaxNull("x"), L.marketRelative([1], [2]), L.ksUniform(null)].every((r) => r && r.reason));
  check("degenerate null (always in) -> pLuck .5, z 0", (() => { const r = L.skillScore(asset, asset, { positions: asset.map(() => 1), sims: 50 }); return r.pLuck === 0.5 && r.z === 0; })());
  check("z capped at +/-3.5", (() => { const r = L.skillScore(asset.map((x) => Math.max(x, 0)), asset, { positions: asset.map((x) => (x > 0 ? 1 : 0)), sims: 200 }); return r.z === 3.5 && r.pLuck === 0; })());

  // 4. CALIBRATION — zero-skill universe, Markov timing independent of the asset, each strategy on its own asset path
  const markovStrategy = (T, pStay, shortFrac, lev, rng) => {
    const asset = Array.from({ length: T }, () => 0.001 + 0.025 * gauss()), pos = new Array(T); let state = rng() < 0.5 ? 1 : 0, sign = 1;
    for (let t = 0; t < T; t++) { if (t && rng() > pStay) { state = 1 - state; if (state) sign = rng() < shortFrac ? -1 : 1; } if (!t && state) sign = rng() < shortFrac ? -1 : 1; pos[t] = state ? sign * lev : 0; }
    return { asset, pos, strat: asset.map((r, t) => pos[t] * r) };
  };
  for (const [name, shortFrac, lev] of [["long/flat", 0, 1], ["long/short/flat 1.5x", 0.4, 1.5]]) {
    const rng = L.mulberry(name.length * 7919), ps = [];
    for (let i = 0; i < 400; i++) { const s = markovStrategy(126, 0.85 + 0.13 * rng(), shortFrac, lev, rng); const r = L.skillScore(s.strat, s.asset, { positions: s.pos, sims: 500, seed: 1000 + i }); if (r.pLuck != null) ps.push(r.pLuck); }
    const ks = L.ksUniform(ps); calibration[name] = { n: ps.length, D: +ks.D.toFixed(4), p: +ks.p.toFixed(4), meanP: +(ps.reduce((a, b) => a + b, 0) / ps.length).toFixed(4) };
    check(`CALIBRATION ${name}: pLuck ~ U(0,1), KS p > 0.05`, ps.length >= 380 && ks.p > 0.05, `n ${ps.length}, D ${ks.D.toFixed(4)}, KS p ${ks.p.toFixed(3)}, mean p ${calibration[name].meanP}`);
  }

  // 5. PLANTED SKILL — hot/cold assets make the raw board a luck contest; 10 skilled timers see tomorrow with 62% accuracy
  {
    const rng = L.mulberry(4711), U = [];
    for (let i = 0; i < 100; i++) {
      const drift = 0.004 * gauss(), asset = Array.from({ length: 126 }, () => drift + 0.02 * gauss()), skilled = i % 10 === 3, pos = new Array(126);
      let state = 1;
      for (let t = 0; t < 126; t++) { if (skilled) state = (asset[t] > 0) === (rng() < 0.62) ? 1 : 0; else if (t && rng() > 0.9) state = 1 - state; pos[t] = state; }
      const strat = asset.map((r, t) => pos[t] * r), sc = L.skillScore(strat, asset, { positions: pos, sims: 500, seed: 500 + i });
      U.push({ skilled, z: sc.z, raw: sc.raw, tie: rng() });
    }
    const top = (key) => [...U].sort((a, b) => b[key] - a[key] || a.tie - b.tie).slice(0, 10).filter((x) => x.skilled).length;
    const zTop = top("z"), rawTop = top("raw");
    calibration.plantedSkill = { skilled: 10, inTopDecileByZ: zTop, inTopDecileByRaw: rawTop };
    check("planted skill: >= 7 of 10 skilled in the z top decile", zTop >= 7, `z ${zTop}/10, raw ${rawTop}/10`);
    check("planted skill: z beats the raw leaderboard", zTop > rawTop);
  }

  // 6. sign-flip max-Sharpe null on pure noise: 73 series x 2,500 days; one series' Sharpe sd = sqrt(252/2500) = .317
  {
    const list = Array.from({ length: 73 }, (_, i) => ({ id: "n" + i, r: Array.from({ length: 2500 }, () => 0.01 * gauss()), d: Array.from({ length: 2500 }, (_, t) => "d" + t), ann: 252 }));
    const M = L.sharpeMaxNull(list, 400, 3);
    check("max-Sharpe null median ~ E[max of 73] (.55-.95)", M.median > 0.55 && M.median < 0.95, `median ${M.median.toFixed(3)} p95 ${M.p95.toFixed(3)}`);
    const ks = L.ksUniform(M.pBySeries); calibration.signFlipPerSeries = { n: 73, p: +ks.p.toFixed(4) };
    check("per-series sign-flip p ~ uniform on noise (KS p > .05)", ks.p > 0.05, `KS p ${ks.p.toFixed(3)}`);
  }

  // 7. market-relative: r = .0002 + 1.2 m + e  -> beta 1.2, alpha .0002
  {
    const m = Array.from({ length: 3000 }, () => 0.0004 + 0.01 * gauss()), r = m.map((x) => 0.0002 + 1.2 * x + 0.002 * gauss());
    const mr = L.marketRelative(r, m);
    check("marketRelative beta 1.2, alpha .0002", close(mr.beta, 1.2, 0.02) && close(mr.alphaDaily, 0.0002, 0.0001), `beta ${mr.beta.toFixed(3)} alpha ${mr.alphaDaily.toExponential(2)} t ${mr.tAlphaNW.toFixed(1)}`);
    const pure = m.map((x) => 1.5 * x), mp = L.marketRelative(pure, m);
    check("pure beta -> alpha ~ 0 (drift not scored as skill)", Math.abs(mp.alphaDaily) < 1e-12);
  }

  // 8. luck line grows with N and N=1 is the member's own median
  {
    const mem = Array.from({ length: 50 }, () => ({ nullRaw: Array.from({ length: 500 }, () => 0.1 * gauss()) }));
    const a = L.luckLine(mem, 1, 2000, 1), b = L.luckLine(mem, 50, 2000, 1), c = L.luckLine(mem, 200, 2000, 1);
    check("luck line: N=1 median ~ 0, rises with N", Math.abs(a.median) < 0.02 && b.median > a.median && c.median > b.median, `N1 ${a.median.toFixed(3)} N50 ${b.median.toFixed(3)} N200 ${c.median.toFixed(3)}`);
  }

  if (!quiet) { console.log(`selection-luck tests: ${ok.length} passed, ${bad.length} failed`); for (const l of lines) console.log(l); }
  return { passed: ok.length, failed: bad.length, lines, calibration };
}

if (require.main === module) { const r = run(); if (r.failed) process.exit(1); }
module.exports = { run };
