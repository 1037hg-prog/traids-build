#!/usr/bin/env node
/**
 * MEASURE THE LIBRARY v2 (ensemble-architect, 2026-09-25). Measurement only — evaluates no registered combination.
 * Differences from measure-library.js (v1, kept unchanged as the R201-era record):
 *   - "monthly"-calendar entries (TSY-ZN1X / TSY-ZN5X) enter ONLY the monthly matrix and monthly effective N;
 *   - benchmark entries (notes "benchmark: true", i.e. CRYPTO-BH) are excluded from every strategy count, kept for reference rows;
 *   - VOID-for-combination entries (R212, R214, R227 — operator 2026-09-25) stay in the correlation structure (failures belong in the
 *     library) but are flagged; they are never combination candidates;
 *   - mechanism table = R201's frozen table + a v2 extension for the post-R201 tests (published citations from their registrations).
 * Writes backend/data/strategy-library/index.json and backend/data/strategy-library/correlation-2026-09-25.json.
 *   node backend/ensemble/measure-library-v2.js
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const C = require("./common.js");
const OUT = path.join(C.LIB, "correlation-2026-09-25.json"), INDEX = path.join(C.LIB, "index.json");
const MIN_OVERLAP = 120, r3 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(3));
const reg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "test-registry.json"), "utf8"));
const R201 = reg.preregistered.find((t) => t.ensembleSpec === "ensemble-combo-v1");
const MECH = { ...R201.ensembleSpecDetail.mechanism,
  "R197": "index-addition/deletion price pressure (Harris & Gurel 1986; Shleifer 1986)", "R199": "quarter-end window dressing (Lakonishok et al. 1991)",
  "R203": "month-end index-extension duration demand, international bonds (R180's mechanism)", "R204": "month-end index-extension duration demand, TIPS (R180's mechanism)",
  "R205": "quarter-end bank balance-sheet dollar demand", "R206": "mid-month coupon reinvestment flows", "R208": "crypto weekend liquidity / retail clientele",
  "R209": "lead-lag price discovery BTC -> alts", "R210": "stablecoin inflow as crypto demand", "R212": "FX hedge rebalancing at month end (Melvin & Prins 2015)",
  "R213": "FOMC-cycle even-week premium (Cieslak, Morse & Vissing-Jorgensen 2019)", "R214": "gold overnight drift", "R215": "pre-holiday effect (Ariel 1990)",
  "R225": "quad-witching hedging flows", "R226": "quad-witching hedging flows", "R227": "Russell reconstitution flows", "R228": "Russell reconstitution reversal",
  "TSY-*": "index-extension duration demand at month end (Hartley & Schwarz 2019) — R180 on ZN futures", "CRYPTO-T50*": "crypto time-series momentum (Liu & Tsyvinski 2021)" };
const NOTM = R201.ensembleSpecDetail.mechanismNotStated;
const VOID = new Set(["R212", "R214", "R227"]);
const testOf = (id) => (id.startsWith("TSY-") ? "R180" : id.startsWith("CRYPTO-") ? "R190" : id.split("-")[0]);

(async () => {
  const lib = C.loadLibrary(), okAll = lib.filter((e) => e.status === "ok");
  const isBench = (e) => /benchmark: true/.test(e.notes || "");
  const ok = okAll.filter((e) => !isBench(e)), daily = ok.filter((e) => e.calendar !== "monthly"), monthlyOnly = ok.filter((e) => e.calendar === "monthly");
  console.log(`library: ${lib.length} entries, ${okAll.length} ok (${ok.length} strategies, ${okAll.length - ok.length} benchmark), ${lib.length - okAll.length} unavailable; ${monthlyOnly.length} monthly-only`);
  const spy = await C.spyDaily(), btc = await C.btcDaily(), spyR = C.toRet(spy), btcR = C.toRet(btc), sessions = new Set(spy.map((x) => x.d));
  const live = new Map(daily.map((e) => [e.id, C.liveMap(e, sessions)]));
  const annF = (e) => (e.calendar === "crypto-24x7" ? 365 : 252);
  // monthly maps: daily entries compound live days within the month; monthly entries fill every window month (absent = 0)
  const monthly = new Map();
  for (const e of daily) { const mm = new Map(); for (const [d, v] of live.get(e.id)) { const k = d.slice(0, 7); mm.set(k, (mm.get(k) ?? 1) * (1 + v)); } monthly.set(e.id, new Map([...mm].map(([k, g]) => [k, g - 1]))); }
  for (const e of monthlyOnly) { const s = new Map(e.series.map((x) => [x.d.slice(0, 7), x.r])), mm = new Map(); for (let t = Date.parse(e.window[0].slice(0, 7) + "-01T00:00:00Z"); new Date(t).toISOString().slice(0, 7) <= e.window[1].slice(0, 7); t = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth() + 1, 1)) { const k = new Date(t).toISOString().slice(0, 7); mm.set(k, s.get(k) || 0); } monthly.set(e.id, mm); }
  const spyM = new Map(), btcM = new Map(); for (const [d, v] of spyR) spyM.set(d.slice(0, 7), (spyM.get(d.slice(0, 7)) ?? 1) * (1 + v)); for (const [d, v] of btcR) btcM.set(d.slice(0, 7), (btcM.get(d.slice(0, 7)) ?? 1) * (1 + v));
  for (const m of [spyM, btcM]) for (const [k, g] of m) m.set(k, g - 1);

  // ---- per-strategy stats (daily entries on days; monthly entries on months) ----
  const stats = {};
  for (const e of ok) {
    const mech = C.lookup(NOTM, e.id) ? null : C.lookup(MECH, e.id) || null;
    if (e.calendar === "monthly") { const mm = monthly.get(e.id), ks = [...mm.keys()], v = ks.map((k) => mm.get(k)), mu = C.mean(v), sd = C.sdOf(v); let eq = 1, pk = 1, dd = 0; for (const x of v) { eq *= 1 + x; pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1); }
      const ks16 = ks.filter((k) => k >= "2016-01"), fit = C.ols(ks16.map((k) => mm.get(k)), ks16.map((k) => [1, spyM.get(k) || 0, btcM.get(k) || 0]), 3);
      stats[e.id] = { test: testOf(e.id), calendar: "monthly", window: e.window, months: v.length, annMeanPct: r3(1200 * mu), annVolPct: r3(100 * sd * Math.sqrt(12)), sharpe: r3(mu / sd * Math.sqrt(12)), tNW: r3(C.nwT(v, 3)), maxDDPct: r3(100 * dd), betaSPY_2016: r3(fit.b[1]), betaBTC_2016: r3(fit.b[2]), alphaT_2016: r3(fit.t[0]), reproduced: !!(e.reproduction && e.reproduction.match), mechanism: mech, void: VOID.has(e.id) };
      continue; }
    const m = live.get(e.id), ds = [...m.keys()], v = ds.map((d) => m.get(d)), mu = C.mean(v), sd = C.sdOf(v), A = annF(e);
    let eq = 1, pk = 1, dd = 0; for (const x of v) { eq *= 1 + x; pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1); }
    const fit = C.ols(v, ds.map((d) => [1, spyR.get(d) || 0, btcR.get(d) || 0]));
    stats[e.id] = { test: testOf(e.id), calendar: e.calendar, window: e.window, liveDays: v.length, activeDays: e.series.length, annMeanPct: r3(100 * mu * A), annVolPct: r3(100 * sd * Math.sqrt(A)), sharpe: r3(mu / sd * Math.sqrt(A)), tNW: r3(C.nwT(v)), maxDDPct: r3(100 * dd),
      betaSPY: r3(fit.b[1]), betaBTC: r3(fit.b[2]), alphaT: r3(fit.t[0]), reproduced: !!(e.reproduction && e.reproduction.match), mechanism: mech, void: VOID.has(e.id), newInV2: /v2-|unavailable-v2/.test(e.source.emitter || "") };
  }

  // ---- matrices ----
  function matrix(ids, src, filterDate, minOverlap) {
    const M = ids.map(() => ids.map(() => null)), N = ids.map(() => ids.map(() => 0));
    for (let i = 0; i < ids.length; i++) { M[i][i] = 1; const a = src.get(ids[i]);
      for (let j = i + 1; j < ids.length; j++) { const b = src.get(ids[j]), xa = [], xb = []; for (const [d, v] of a) { if (!filterDate(d)) continue; const w = b.get(d); if (w === undefined) continue; xa.push(v); xb.push(w); }
        N[i][j] = N[j][i] = xa.length; if (xa.length >= minOverlap) { const c = C.corr(xa, xb); M[i][j] = M[j][i] = c; } } }
    return { M, N }; }
  const dIds = daily.map((e) => e.id), mIds = ok.map((e) => e.id);
  const full = matrix(dIds, live, () => true, MIN_OVERLAP);
  const resid = new Map(); for (const e of daily) { const m = live.get(e.id), ds = [...m.keys()], v = ds.map((d) => m.get(d)), fit = C.ols(v, ds.map((d) => [1, spyR.get(d) || 0, btcR.get(d) || 0])); resid.set(e.id, new Map(ds.map((d, i) => [d, fit.resid[i]]))); }
  const fullResid = matrix(dIds, resid, () => true, MIN_OVERLAP);
  const spyDays = [...spyR.entries()].filter(([d]) => d >= "2016-01-01").sort((a, b) => a[1] - b[1]), k5 = Math.ceil(0.05 * spyDays.length), stressSet = new Set(spyDays.slice(0, k5).map(([d]) => d));
  const stress = matrix(dIds, live, (d) => stressSet.has(d), 30);
  for (const e of daily) { const m = live.get(e.id), v = [...stressSet].filter((d) => m.has(d)).map((d) => m.get(d)); stats[e.id].stressDays = v.length; stats[e.id].stressMeanPct = v.length ? r3(100 * C.mean(v)) : null; }
  const years = []; for (let y = 2016; y <= 2026; y++) years.push(String(y));
  const byYear = {}; for (const y of years) byYear[y] = matrix(dIds, live, (d) => d.startsWith(y), 60);
  const mon = matrix(mIds, monthly, (k) => k >= "2016-01", 24);
  // crypto stress months: the 5% worst months of 50/50 BTC/ETH buy-and-hold, and SPY's worst 5% months (2016+)
  const cbh = okAll.find((e) => e.id === "CRYPTO-BH"), cbhM = new Map(); for (const x of cbh.series) cbhM.set(x.d.slice(0, 7), (cbhM.get(x.d.slice(0, 7)) ?? 1) * (1 + x.r));
  const worstM = (mm) => { const a = [...mm].filter(([k]) => k >= "2016-01" && k <= "2026-08").sort((x, y) => x[1] - y[1]); return new Set(a.slice(0, Math.ceil(0.05 * a.length)).map(([k]) => k)); };
  const spyWorstM = worstM(spyM), cryptoWorstM = worstM(new Map([...cbhM].map(([k, g]) => [k, g - 1])));
  for (const e of ok) { const mm = monthly.get(e.id); const f = (S) => { const v = [...S].filter((k) => mm.has(k)).map((k) => mm.get(k)); return v.length ? r3(100 * C.mean(v)) : null; }; stats[e.id].spyWorstMonthsMeanPct = f(spyWorstM); stats[e.id].cryptoWorstMonthsMeanPct = f(cryptoWorstM); }

  // ---- effective N ----
  function effN(M, idxs) { const S = idxs.map((i) => idxs.map((j) => (M[i][j] == null ? 0 : M[i][j]))), ev = C.eigSym(S).map((x) => Math.max(0, x)), sum = ev.reduce((a, b) => a + b, 0);
    const pr = sum ** 2 / ev.reduce((a, b) => a + b * b, 0), p = ev.filter((x) => x > 0).map((x) => x / sum), ent = Math.exp(-p.reduce((a, b) => a + b * Math.log(b), 0));
    return { n: idxs.length, participationRatio: r3(pr), entropyN: r3(ent), largestEigShare: r3(ev[0] / sum), diversificationRatioER: r3(idxs.length / Math.sqrt(S.flat().reduce((a, b) => a + b, 0))), missingPairs: idxs.flatMap((i) => idxs.filter((j) => j > i && M[i][j] == null)).length }; }
  const dAll = dIds.map((_, i) => i), mAll = mIds.map((_, i) => i);
  const dMech = dAll.filter((i) => stats[dIds[i]].mechanism), dPos = dAll.filter((i) => stats[dIds[i]].sharpe > 0);
  const mPosNonVoid = mAll.filter((i) => stats[mIds[i]].sharpe > 0 && !stats[mIds[i]].void && stats[mIds[i]].mechanism);
  const effective = { dailyAll: effN(full.M, dAll), dailyResidual: effN(fullResid.M, dAll), dailyStressDays: effN(stress.M, dAll), dailyMechanism: effN(full.M, dMech), dailyPositiveSharpe: effN(full.M, dPos),
    monthlyAll_2016plus: effN(mon.M, mAll), monthlyMechanismPositiveNonVoid_2016plus: { ...effN(mon.M, mPosNonVoid), ids: mPosNonVoid.map((i) => mIds[i]) } };
  const off = (M, idxs) => { const v = []; for (const i of idxs) for (const j of idxs) if (j > i && M[i][j] != null) v.push(M[i][j]); v.sort((a, b) => a - b); return { pairs: v.length, mean: r3(C.mean(v)), median: r3(v[Math.floor(v.length / 2)]), meanAbs: r3(C.mean(v.map(Math.abs))), p90: r3(v[Math.floor(0.9 * v.length)]) }; };
  const summary = { dailyFull: off(full.M, dAll), dailyResidual: off(fullResid.M, dAll), dailyStress: off(stress.M, dAll), monthly2016: off(mon.M, mAll), byYear: Object.fromEntries(years.map((y) => [y, off(byYear[y].M, dAll)])) };

  // ---- clusters ----
  function clusters(ids, M, cut) { let cl = ids.map((_, i) => [i]); const link = (a, b) => { let s = 0, n = 0; for (const i of a) for (const j of b) if (M[i][j] != null) { s += M[i][j]; n++; } return n ? s / n : -Infinity; };
    for (;;) { let best = -Infinity, bi = -1, bj = -1; for (let i = 0; i < cl.length; i++) for (let j = i + 1; j < cl.length; j++) { const l = link(cl[i], cl[j]); if (l > best) { best = l; bi = i; bj = j; } } if (best < cut) break; cl[bi] = cl[bi].concat(cl[bj]); cl.splice(bj, 1); }
    return cl.filter((c) => c.length > 1).map((c) => c.map((i) => ids[i]).sort()); }
  const clusterMap = { dailyRho050: clusters(dIds, full.M, 0.5), dailyRho080: clusters(dIds, full.M, 0.8), residualRho080: clusters(dIds, fullResid.M, 0.8), monthlyRho080: clusters(mIds, mon.M, 0.8) };

  // ---- the book-relevant rows: every strategy's correlation with the two book legs ----
  const legs = ["TSY-ZN1X", "CRYPTO-T50", "R180", "R196"], rowOf = (id) => Object.fromEntries(mIds.map((x, j) => [x, r3(mon.M[mIds.indexOf(id)][j])]));
  const bookRows = Object.fromEntries(legs.map((id) => [id, rowOf(id)]));
  const dRow = (id) => Object.fromEntries(dIds.map((x, j) => [x, r3(full.M[dIds.indexOf(id)][j])]));
  const newIds = ok.filter((e) => stats[e.id].newInV2).map((e) => e.id);

  writeJsonAtomic(OUT, { spec: "strategy-library-correlation-v2", asOf: new Date().toISOString(), note: "Measurement only. Monthly matrix uses 2016-01+ months (both legs live, >= 24 months). Pair statistics are in-sample context.",
    counts: { entries: lib.length, strategies: ok.length, daily: daily.length, monthlyOnly: monthlyOnly.length, benchmarks: okAll.length - ok.length, unavailable: lib.length - okAll.length, newInV2: newIds },
    stats, summary, effectiveN: effective, clusters: clusterMap, bookLegCorrelationsMonthly: bookRows, dailyRowCRYPTO_T50: dRow("CRYPTO-T50"), dailyRowR180: dRow("R180"),
    stress: { spyWorstMonths: [...spyWorstM].sort(), cryptoWorstMonths: [...cryptoWorstM].sort(), spyWorstDays: { count: k5, thresholdPct: r3(spyDays[k5 - 1][1] * 100) } },
    matrices: { daily: { ids: dIds, full: full.M.map((r) => r.map(r3)), residual: fullResid.M.map((r) => r.map(r3)), stress: stress.M.map((r) => r.map(r3)) }, monthly2016: { ids: mIds, M: mon.M.map((r) => r.map(r3)), N: mon.N } } }, { pretty: 0 });
  writeJsonAtomic(INDEX, { spec: "strategy-library-index-v2", asOf: new Date().toISOString(), convention: "see backend/ensemble/lib-entry.js", correlation: "correlation-2026-09-25.json",
    counts: { entries: lib.length, ok: okAll.length, strategies: ok.length, benchmarks: okAll.length - ok.length, unavailable: lib.length - okAll.length, tests: new Set(lib.map((e) => e.source.registryId)).size },
    entries: lib.map((e) => ({ id: e.id, status: e.status, test: e.source.registryId, name: e.name, script: e.source.script, sha256: e.source.sha256, emitter: e.source.emitter, unit: e.unit || null, calendar: e.calendar || null, window: e.window || null,
      activeDays: e.stats ? e.stats.activeDays : null, reproduced: e.reproduction ? e.reproduction.match : null, reproduction: e.reproduction || null, reason: e.reason || null, verdict: e.verdict ? String(e.verdict).slice(0, 160) : null, benchmark: isBench(e), void: VOID.has(e.id),
      ...(stats[e.id] ? { sharpe: stats[e.id].sharpe, tNW: stats[e.id].tNW, mechanism: stats[e.id].mechanism } : {}) })) });
  console.log("effective N:", JSON.stringify(effective, null, 0)); console.log("summary:", JSON.stringify(summary.dailyFull), "resid", JSON.stringify(summary.dailyResidual), "stress", JSON.stringify(summary.dailyStress), "monthly", JSON.stringify(summary.monthly2016));
  console.log("clusters rho>=0.8 daily:", JSON.stringify(clusterMap.dailyRho080)); console.log("monthly rho>=0.8:", JSON.stringify(clusterMap.monthlyRho080));
  for (const id of newIds) { const s = stats[id]; console.log(`  ${id.padEnd(16)} ${s.calendar.padEnd(11)} Sharpe ${s.sharpe} tNW ${s.tNW} maxDD ${s.maxDDPct} alphaT ${s.alphaT ?? s.alphaT_2016} rho(ZN1X,m) ${bookRows["TSY-ZN1X"][id]} rho(T50,m) ${bookRows["CRYPTO-T50"][id]} spyWorstM ${s.spyWorstMonthsMeanPct} cryptoWorstM ${s.cryptoWorstMonthsMeanPct}${s.void ? " VOID" : ""}`); }
})().catch((e) => { console.error("measure v2 FAILED:", e.stack); process.exit(1); });
