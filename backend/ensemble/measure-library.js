#!/usr/bin/env node
/**
 * MEASURE THE LIBRARY (ensemble-architect step 2, 2026-09-24). Evaluates NO combination for R201 — the R201 rule was registered
 * before this file ran. Writes:
 *   backend/data/strategy-library/index.json               — one row per library entry (status, window, stats, reproduction)
 *   backend/data/strategy-library/correlation-2026-09-24.json — correlation maps (daily full / by year / SPY worst-5% days / monthly),
 *                                                            effective N, diversification ratio, clusters, top diversifying pairs
 * Pairwise correlations use dates on which BOTH strategies are live (inside their windows and on their calendars; flat days = 0).
 * Pair Sharpe gains are IN-SAMPLE CONTEXT, never evidence.
 *   node backend/ensemble/measure-library.js
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const C = require("./common.js");
const OUT = path.join(C.LIB, "correlation-2026-09-24.json"), INDEX = path.join(C.LIB, "index.json");
const MIN_OVERLAP = 120, r3 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(3));
const reg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "test-registry.json"), "utf8"));
const R201 = reg.preregistered.find((t) => t.ensembleSpec === "ensemble-combo-v1");
const MECH = R201.ensembleSpecDetail.mechanism, NOTM = R201.ensembleSpecDetail.mechanismNotStated;
const testOf = (id) => id.split("-")[0];

(async () => {
  const lib = C.loadLibrary(), ok = lib.filter((e) => e.status === "ok");
  console.log(`library: ${lib.length} entries, ${ok.length} ok, ${lib.length - ok.length} unavailable`);
  const spy = await C.spyDaily(), btc = await C.btcDaily(), spyR = C.toRet(spy), btcR = C.toRet(btc), sessions = new Set(spy.map((x) => x.d));
  const live = new Map(ok.map((e) => [e.id, C.liveMap(e, sessions)]));
  const annF = (e) => (e.calendar === "crypto-24x7" ? 365 : 252);

  // ---- per-strategy stats ------------------------------------------------------------------------------------------------------
  const stats = {};
  for (const e of ok) {
    const m = live.get(e.id), ds = [...m.keys()], v = ds.map((d) => m.get(d)), pre = ds.filter((d) => d <= "2022-12-31").map((d) => m.get(d));
    const mu = C.mean(v), sd = C.sdOf(v), A = annF(e);
    let eq = 1, pk = 1, dd = 0; for (const x of v) { eq *= 1 + x; pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1); }
    const X = ds.map((d) => [1, spyR.get(d) || 0, btcR.get(d) || 0]), fit = C.ols(v, X);
    const mechanism = C.lookup(NOTM, e.id) ? null : C.lookup(MECH, e.id) || null;
    stats[e.id] = { test: testOf(e.id), calendar: e.calendar, window: e.window, liveDays: v.length, activeDays: e.series.length, annMeanPct: r3(100 * mu * A), annVolPct: r3(100 * sd * Math.sqrt(A)),
      sharpe: r3(mu / sd * Math.sqrt(A)), tNW: r3(C.nwT(v)), preT: pre.length >= 250 ? r3(C.nwT(pre)) : null, preDays: pre.length, maxDDPct: r3(100 * dd),
      betaSPY: r3(fit.b[1]), betaBTC: r3(fit.b[2]), alphaT: r3(fit.t[0]), reproduced: !!(e.reproduction && e.reproduction.match), mechanism };
  }

  // ---- pairwise correlation helper ------------------------------------------------------------------------------------------
  const ids = ok.map((e) => e.id);
  function matrix(filterDate, minOverlap = MIN_OVERLAP, src = live) {
    const M = ids.map(() => ids.map(() => null)), N = ids.map(() => ids.map(() => 0));
    for (let i = 0; i < ids.length; i++) { M[i][i] = 1; const a = src.get(ids[i]);
      for (let j = i + 1; j < ids.length; j++) { const b = src.get(ids[j]), xa = [], xb = [];
        for (const [d, v] of a) { if (!filterDate(d)) continue; const w = b.get(d); if (w === undefined) continue; xa.push(v); xb.push(w); }
        N[i][j] = N[j][i] = xa.length; if (xa.length >= minOverlap) { const c = C.corr(xa, xb); M[i][j] = M[j][i] = c == null ? null : c; } } }
    return { M, N };
  }
  const full = matrix(() => true);
  // residual (SPY + BTC) correlation, full sample and pre-2023
  const resid = new Map();
  for (const e of ok) { const m = live.get(e.id), ds = [...m.keys()], v = ds.map((d) => m.get(d)), fit = C.ols(v, ds.map((d) => [1, spyR.get(d) || 0, btcR.get(d) || 0])); resid.set(e.id, new Map(ds.map((d, i) => [d, fit.resid[i]]))); }
  const fullResid = matrix(() => true, MIN_OVERLAP, resid);
  // by year
  const years = []; for (let y = 2016; y <= 2026; y++) years.push(String(y));
  const byYear = {}; for (const y of years) byYear[y] = matrix((d) => d.startsWith(y), 60);
  // SPY worst 5% days (2016-01-01..2026-09-23)
  const spyDays = [...spyR.entries()].filter(([d]) => d >= "2016-01-01").sort((a, b) => a[1] - b[1]), k5 = Math.ceil(0.05 * spyDays.length), stressSet = new Set(spyDays.slice(0, k5).map(([d]) => d));
  const stress = matrix((d) => stressSet.has(d), 30);
  for (const e of ok) { const m = live.get(e.id), v = [...stressSet].filter((d) => m.has(d)).map((d) => m.get(d)); stats[e.id].stressDays = v.length; stats[e.id].stressMeanPct = v.length ? r3(100 * C.mean(v)) : null; stats[e.id].stressHitPct = v.length ? r3(100 * v.filter((x) => x > 0).length / v.length) : null; }
  // monthly (compounded within calendar month over live days)
  const monthly = new Map(); for (const e of ok) { const m = live.get(e.id), mm = new Map(); for (const [d, v] of m) { const k = d.slice(0, 7); mm.set(k, (mm.get(k) ?? 1) * (1 + v)); } monthly.set(e.id, new Map([...mm].map(([k, g]) => [k, g - 1]))); }
  const monthlyM = matrix(() => true, 24, monthly);

  // ---- effective N and diversification ratio ---------------------------------------------------------------------------------
  function effN(M, idxs) {
    const S = idxs.map((i) => idxs.map((j) => (M[i][j] == null ? 0 : M[i][j]))), ev = C.eigSym(S).map((x) => Math.max(0, x)), sum = ev.reduce((a, b) => a + b, 0);
    const pr = sum ** 2 / ev.reduce((a, b) => a + b * b, 0), p = ev.filter((x) => x > 0).map((x) => x / sum), ent = Math.exp(-p.reduce((a, b) => a + b * Math.log(b), 0));
    const drER = idxs.length / Math.sqrt(S.flat().reduce((a, b) => a + b, 0));   // inverse-vol weights: DR = n / sqrt(1'C1)
    return { n: idxs.length, participationRatio: r3(pr), entropyN: r3(ent), largestEigShare: r3(ev[0] / sum), diversificationRatioER: r3(drER), missingPairs: idxs.flatMap((i) => idxs.filter((j) => j > i && M[i][j] == null)).length };
  }
  const all = ids.map((_, i) => i), mech = all.filter((i) => stats[ids[i]].mechanism), pos = all.filter((i) => stats[ids[i]].sharpe > 0);
  // one per test: equal-weight composite of the test's members (dense over their union of live days)
  const tests = [...new Set(ids.map(testOf))], comp = new Map();
  for (const t of tests) { const mem = ids.filter((id) => testOf(id) === t), acc = new Map(); for (const id of mem) for (const [d, v] of live.get(id)) { const a = acc.get(d) || [0, 0]; a[0] += v; a[1]++; acc.set(d, a); } comp.set(t, new Map([...acc].sort().map(([d, [s, n]]) => [d, s / n]))); }
  const idsT = tests; const matT = (() => { const M = idsT.map(() => idsT.map(() => null)); for (let i = 0; i < idsT.length; i++) { M[i][i] = 1; for (let j = i + 1; j < idsT.length; j++) { const a = comp.get(idsT[i]), b = comp.get(idsT[j]), xa = [], xb = []; for (const [d, v] of a) { const w = b.get(d); if (w === undefined) continue; xa.push(v); xb.push(w); } if (xa.length >= MIN_OVERLAP) M[i][j] = M[j][i] = C.corr(xa, xb); } } return M; })();
  const eff = { allStrategies: effN(full.M, all), mechanismBacked: effN(full.M, mech), positiveSharpe: effN(full.M, pos), onePerTest: effN(matT, idsT.map((_, i) => i)),
    allStrategiesMonthly: effN(monthlyM.M, all), allStrategiesResidual: effN(fullResid.M, all), onStressDays: effN(stress.M, all) };
  const offDiag = (M, idxs) => { const v = []; for (const i of idxs) for (const j of idxs) if (j > i && M[i][j] != null) v.push(M[i][j]); v.sort((a, b) => a - b); return { pairs: v.length, mean: r3(C.mean(v)), median: r3(v[Math.floor(v.length / 2)]), meanAbs: r3(C.mean(v.map(Math.abs))), p90: r3(v[Math.floor(0.9 * v.length)]) }; };
  const summary = { full: offDiag(full.M, all), residual: offDiag(fullResid.M, all), monthly: offDiag(monthlyM.M, all), stress: offDiag(stress.M, all), byYear: Object.fromEntries(years.map((y) => [y, offDiag(byYear[y].M, all)])) };

  // ---- clusters (average linkage on 1 - rho) ---------------------------------------------------------------------------------
  function clusters(M, cut) { let cl = ids.map((_, i) => [i]); const link = (a, b) => { let s = 0, n = 0; for (const i of a) for (const j of b) if (M[i][j] != null) { s += M[i][j]; n++; } return n ? s / n : -Infinity; };
    for (;;) { let best = -Infinity, bi = -1, bj = -1; for (let i = 0; i < cl.length; i++) for (let j = i + 1; j < cl.length; j++) { const l = link(cl[i], cl[j]); if (l > best) { best = l; bi = i; bj = j; } } if (best < cut) break; cl[bi] = cl[bi].concat(cl[bj]); cl.splice(bj, 1); }
    return cl.filter((c) => c.length > 1).map((c) => c.map((i) => ids[i]).sort()); }
  const clusterMap = { rho050: clusters(full.M, 0.5), rho080: clusters(full.M, 0.8), residualRho080: clusters(fullResid.M, 0.8) };

  // ---- diversifying pairs (both with positive full-sample Sharpe; ER 50/50 pair Sharpe vs the better single = IN-SAMPLE CONTEXT)
  const pairs = [];
  for (const i of pos) for (const j of pos) { if (j <= i || full.M[i][j] == null) continue; const a = live.get(ids[i]), b = live.get(ids[j]), xa = [], xb = []; for (const [d, v] of a) { const w = b.get(d); if (w === undefined) continue; xa.push(v); xb.push(w); }
    const sa = C.sdOf(xa), sb = C.sdOf(xb), wa = (1 / sa) / (1 / sa + 1 / sb), p = xa.map((x, k) => wa * x + (1 - wa) * xb[k]), A = 252, sh = (z) => C.mean(z) / C.sdOf(z) * Math.sqrt(A);
    pairs.push({ a: ids[i], b: ids[j], rho: r3(full.M[i][j]), overlap: xa.length, sharpeA: r3(sh(xa)), sharpeB: r3(sh(xb)), sharpePairER: r3(sh(p)), gainVsBetter: r3(sh(p) - Math.max(sh(xa), sh(xb))) }); }
  const sameTest = (p) => testOf(p.a) === testOf(p.b);
  const topDiversifying = pairs.filter((p) => !sameTest(p)).sort((x, y) => x.rho - y.rho || (x.a + x.b < y.a + y.b ? -1 : 1)).slice(0, 15);
  const topGain = pairs.filter((p) => !sameTest(p)).sort((x, y) => y.gainVsBetter - x.gainVsBetter || (x.a + x.b < y.a + y.b ? -1 : 1)).slice(0, 15);
  const avgCorr = Object.fromEntries(ids.map((id, i) => { const v = all.filter((j) => j !== i && full.M[i][j] != null && testOf(ids[j]) !== testOf(id)).map((j) => full.M[i][j]); return [id, v.length ? r3(C.mean(v)) : null]; }));
  for (const id of ids) stats[id].avgCorrToOtherTests = avgCorr[id];

  const round = (M) => M.map((r) => r.map(r3));
  writeJsonAtomic(OUT, { spec: "strategy-library-correlation-v1", asOf: new Date().toISOString(), note: "Measurement only; R201 (ENSEMBLE-1) was registered before this ran. Pair Sharpe gains are in-sample context.",
    ids, stats, summary, effectiveN: eff, clusters: clusterMap, topDiversifyingPairs: topDiversifying, topPairSharpeGain: topGain,
    stressDays: { definition: "SPY's worst 5% daily returns 2016-01-01..2026-09-23 (Alpaca SIP adj=all)", count: k5, threshold: r3(spyDays[k5 - 1][1] * 100) },
    matrices: { dailyFull: round(full.M), dailyFullOverlap: full.N, dailyResidual: round(fullResid.M), monthly: round(monthlyM.M), stress: round(stress.M), byYear: Object.fromEntries(years.map((y) => [y, round(byYear[y].M)])),
      perTestComposite: { ids: idsT, M: round(matT) } } }, { pretty: 0 });
  writeJsonAtomic(INDEX, { spec: "strategy-library-index-v1", asOf: new Date().toISOString(), convention: "see backend/ensemble/lib-entry.js", counts: { entries: lib.length, ok: ok.length, unavailable: lib.length - ok.length, tests: new Set(lib.map((e) => e.source.registryId)).size },
    entries: lib.map((e) => ({ id: e.id, status: e.status, test: e.source.registryId, name: e.name, script: e.source.script, sha256: e.source.sha256, emitter: e.source.emitter, unit: e.unit, calendar: e.calendar || null, window: e.window || null,
      activeDays: e.stats ? e.stats.activeDays : null, reproduced: e.reproduction ? e.reproduction.match : null, reproduction: e.reproduction || null, reason: e.reason || null, verdict: e.verdict ? String(e.verdict).slice(0, 160) : null, ...(stats[e.id] ? { sharpe: stats[e.id].sharpe, tNW: stats[e.id].tNW, mechanism: stats[e.id].mechanism } : {}) })) });
  console.log(`effective N: ${JSON.stringify(eff)}`); console.log(`summary: ${JSON.stringify(summary.full)} residual ${JSON.stringify(summary.residual)} stress ${JSON.stringify(summary.stress)}`);
  console.log(`clusters rho>=0.5: ${JSON.stringify(clusterMap.rho050)}`); console.log(`clusters rho>=0.8: ${JSON.stringify(clusterMap.rho080)} residual: ${JSON.stringify(clusterMap.residualRho080)}`);
  console.log("top diversifying:"); for (const p of topDiversifying.slice(0, 10)) console.log(`  ${p.a} x ${p.b} rho ${p.rho} (${p.overlap}d) Sharpe ${p.sharpeA}/${p.sharpeB} -> pair ${p.sharpePairER}`);
  console.log("top pair Sharpe gain (in-sample):"); for (const p of topGain.slice(0, 10)) console.log(`  ${p.a} x ${p.b} rho ${p.rho} gain ${p.gainVsBetter} (pair ${p.sharpePairER})`);
})().catch((e) => { console.error("measure FAILED:", e.stack); process.exit(1); });
