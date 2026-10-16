#!/usr/bin/env node
"use strict";
/**
 * PLAN E BASELINE - rebuild the refereed numbers from the cache and assert them before any lever is measured. READ-ONLY on the repo; offline
 * (reads backend/data/profit-program/planE-inputs.json). Writes backend/data/profit-program/planE-baseline.json.
 *   node backend/profit-program/planE-baseline.js
 *   node backend/profit-program/planE-baseline.js --measured-costs <file>
 * Asserts (exit 1 on a miss): PY real-ZN family reproduces the refereed Plan E 24.24 %/yr and D2 28.16 %/yr over 2019-06..2026-09.
 *
 * MEASURED COST (work order 4.13, added 2026-10-16). Without --measured-costs this script does exactly what it did before, to the byte:
 * the same lines on stdout and the same planE-baseline.json. With it, ONE extra block is printed before the "wrote" line and ONE extra
 * key (measuredCosts) is added at the END of the JSON — every key that was there before keeps its value and its place. The block prices
 * the PY family at the model's assumed rates and at the measured ones side by side, each at x1 / x1.5 / x2, and reports the yearly
 * return, the worst month and the worst month-end drop of each. The file is a small JSON:
 *   { "spec": "planE-measured-costs-v1", "measuredAt": "...", "source": "...", "equityBpsPerSide": 5,
 *     "cryptoBpsPerRoundTrip": 50, "znBpsPerRoundTrip": 4 }
 * An unreadable file, a wrong spec, a missing, misspelled, negative or non-numeric rate is REFUSED (exit 2) before anything is computed
 * or written: a measured run never half-prices a leg. The assumed x1 rows reproduce the PY table above exactly - same rule, same windows,
 * same cost - so the measured rows differ from the model's own number by the cost and by nothing else.
 */
const path = require("path");
const M = require("./planE-model.js");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const OUT = path.join(M.BACKEND, "data", "profit-program", "planE-baseline.json");
const must = (c, m) => { if (!c) { console.error("ASSERT FAILED: " + m); process.exit(1); } };
const $mo = (pct) => Math.round((pct / 100) * 100000 / 12);   // %/yr on $100k -> $/month
const USAGE = "usage: node backend/profit-program/planE-baseline.js [--measured-costs <file>]\n  no argument          the refereed baseline, exactly as before\n  --measured-costs F   also price the PY family at the measured rates in F beside the assumed ones (x1 / x1.5 / x2)";
/** the only argument this script takes; nothing is read or computed before it parses */
function measuredArg(argv) {
  if (!argv.length) return null;
  if (argv.length === 2 && argv[0] === "--measured-costs" && argv[1] && !argv[1].startsWith("--")) return argv[1];
  console.error(`planE-baseline: ${argv.join(" ")} is not an argument this script takes.\n${USAGE}`); process.exit(2);
}
const MCFILE = measuredArg(process.argv.slice(2));
let MC = null;
if (MCFILE) { try { MC = M.loadMeasuredCosts(MCFILE); } catch (e) { console.error(`planE-baseline REFUSED — nothing computed, nothing written: ${e.message}`); process.exit(2); } }

(async () => {
  const inp = M.loadInputs(); console.log(`inputs fetched ${inp.fetchedAt}`);
  const out = { spec: "planE-baseline-v1", inputsFetchedAt: inp.fetchedAt };

  // ---- PY family (real ZN, monthly): the refereed model
  const py = M.pyBuild(inp, { asOf: "2026-09-30" }), res = {};
  for (const id of ["E", "D2", "D"]) { const r = py.run("2019-06", "2026-09", M.PYW[id]); res[id] = { ...M.monthlyStats(r.mo), legs: r.legs }; }
  console.log("\nPY family (real ZN windows, monthly), 2019-06..2026-09, 88 months");
  console.log("plan  CAGR%   mo-sd%  mo-mean%  maxDD(month-end)%  worstMonth        2022%   Sharpe  $/mo on $100k at CAGR");
  for (const id of ["E", "D2", "D"]) { const s = res[id]; console.log(`${id.padEnd(4)} ${String(s.annualReturnPct).padStart(6)} ${String(s.monthlySdPct).padStart(7)} ${String(s.monthlyMeanPct).padStart(8)} ${String(s.maxDDmonthEndPct).padStart(14)}      ${s.worstMonth.join(" ").padEnd(15)} ${String(s.years["2022"]).padStart(7)} ${String(s.sharpe).padStart(7)}   ${$mo(s.annualReturnPct)}`); }
  must(Math.abs(res.E.annualReturnPct - 24.24) < 0.05, "PY E must reproduce 24.24 within 0.05 (got " + res.E.annualReturnPct + ")");
  must(Math.abs(res.D2.annualReturnPct - 28.16) < 0.05, "PY D2 must reproduce 28.16 within 0.05 (got " + res.D2.annualReturnPct + ")");
  must(res.E.months === 88, "88 months");
  console.log("  reproduction OK within 0.05 pt: refereed 2026-10-05 E 24.24 / D2 28.16 (D 28.72)");
  // the repo's own coinbase() fetch drops ~every 300th candle; same model on that series:
  const pyH = M.pyBuild(inp, { asOf: "2026-09-30", cryptoKey: "cryptoRiskManagerStyle" }), resH = {};
  for (const id of ["E", "D2", "D"]) resH[id] = M.monthlyStats(pyH.run("2019-06", "2026-09", M.PYW[id]).mo);
  const holes = (k) => { const ks = Object.keys(inp[k].BTC).sort(); let n = 0; for (let i = 1; i < ks.length; i++) if ((Date.parse(ks[i]) - Date.parse(ks[i - 1])) / 864e5 !== 1) n++; return n; };
  console.log(`  Coinbase hole check: complete series has ${holes("crypto")} one-day holes in BTC, the risk-manager.js / plan-years.js fetch pattern has ${holes("cryptoRiskManagerStyle")}; Plan E CAGR on that series: E ${resH.E.annualReturnPct} (complete ${res.E.annualReturnPct}), D2 ${resH.D2.annualReturnPct} (${res.D2.annualReturnPct}), D ${resH.D.annualReturnPct} (${res.D.annualReturnPct})`);
  out.coinbaseHoles = { completeHoles: holes("crypto"), repoPatternHoles: holes("cryptoRiskManagerStyle"), E_complete: res.E.annualReturnPct, E_repoPattern: resH.E.annualReturnPct, D2_complete: res.D2.annualReturnPct, D2_repoPattern: resH.D2.annualReturnPct };

  // ---- leg shares of variance and of return (PY, E)
  const ms = res.E.legs ? Object.keys(res.E.legs).sort() : [];
  const tot = ms.map((m) => Object.values(res.E.legs[m]).reduce((a, b) => a + b, 0)), vt = M.sd(tot) ** 2;
  const share = {}, ann = {};
  for (const k of ["ZN", "EQ", "GLD", "DBMF", "CRYPTO", "CASH"]) {
    const x = ms.map((m) => res.E.legs[m][k]), mt = M.mean(tot), mx = M.mean(x); let c = 0; for (let i = 0; i < x.length; i++) c += (x[i] - mx) * (tot[i] - mt);
    share[k] = +(100 * (c / (x.length - 1)) / vt).toFixed(1); ann[k] = +(100 * 12 * mx).toFixed(2);
  }
  console.log("\nPlan E (PY) legs: arithmetic %/yr contribution | share of monthly variance %");
  for (const k of Object.keys(share)) console.log(`  ${k.padEnd(7)} ${String(ann[k]).padStart(6)} %/yr | ${String(share[k]).padStart(5)} % of variance`);
  // same decomposition at DAILY frequency on the repo's proxy model (calendar window, ZN financed): the brief's "ZN ~51% / crypto ~26%" is this one
  { const a = await M.rmRows(inp, { asOf: "2026-09-30", fixWindow: true }), d = M.rmDaily(a.rows, { w: M.E_W, zn: 4.2 }, { fin: true }), tot = d.map((x) => x.r), vt = M.sd(tot) ** 2;
    const cov = (x, y) => { const mx = M.mean(x), my = M.mean(y); let c = 0; for (let i = 0; i < x.length; i++) c += (x[i] - mx) * (y[i] - my); return c / (x.length - 1); };
    const dsh = {}; for (const k of ["ZN", "EQUITY", "GOLD", "DBMF", "CRYPTO"]) dsh[k] = +(100 * cov(d.map((z) => z.legs[k]), tot) / vt).toFixed(1);
    console.log(`  at DAILY frequency (repo proxy model, calendar window): ZN ${dsh.ZN}% | equity ${dsh.EQUITY}% | crypto ${dsh.CRYPTO}% | gold ${dsh.GOLD}% | DBMF ${dsh.DBMF}% of variance  -> the "ZN 51% / crypto 26%" reading; at the MONTHLY horizon (where drawdowns accumulate; real ZN) it is ZN ${share.ZN}% / crypto ${share.CRYPTO}% - the crypto trend leg is as big a bet as the Treasury overlay`);
    out.legVarianceShareDailyPct = dsh;
    // effective number of independent bets = 1 / sum(share^2) (participation ratio of the variance shares; cash excluded)
    const effN = (sh) => { const v = Object.values(sh).filter((x) => x > 0).map((x) => x / 100), t = v.reduce((a, b) => a + b, 0); return +(1 / v.reduce((a, b) => a + (b / t) ** 2, 0)).toFixed(2); };
    const shM = { ZN: share.ZN, EQ: share.EQ, GLD: share.GLD, DBMF: share.DBMF, CRYPTO: share.CRYPTO };
    out.effectiveBets = { monthly: effN(shM), daily: effN(dsh), positionsAndOverlays: 8, note: "8 = QQQ, SPY, EFA, GLD, DBMF, BTC, ETH + the ZN overlay" };
    console.log(`  EFFECTIVE N (1 / sum of squared variance shares): ${out.effectiveBets.monthly} independent bets at the monthly horizon, ${out.effectiveBets.daily} at the daily horizon, vs 8 positions (7 holdings + the ZN overlay)`); }
  out.py = { E: { ...res.E, legs: undefined }, D2: { ...res.D2, legs: undefined }, D: { ...res.D, legs: undefined }, legAnnualArithPct: ann, legVarianceSharePct: share };

  // ---- ZN real windows: what the leg actually is
  const z = M.znWindows().filter((r) => r.m >= "2019-06" && r.m <= "2026-09"), tre = z.map((r) => r.tre);
  const wz = tre.reduce((a, b) => Math.min(a, b), 1), tm = M.mean(tre), ts = M.sd(tre);
  console.log(`\nreal ZN month-end windows 2019-06..2026-09: n ${z.length}, mean ${(100 * tm).toFixed(3)}%/window, sd ${(100 * ts).toFixed(3)}%, worst ${(100 * wz).toFixed(2)}% (${z.find((r) => r.tre === wz).m}), t(window, by month) ${(tm / (ts / Math.sqrt(z.length))).toFixed(2)}; at 4.2x: mean ${(420 * tm).toFixed(2)}%/mo of NAV, worst ${(420 * wz).toFixed(1)}% of NAV`);
  console.log(`  Sept-2026 row source: ${z.find((r) => r.m === "2026-09").src}`);
  out.znWindows = { n: z.length, meanPct: +(100 * tm).toFixed(4), sdPct: +(100 * ts).toFixed(4), worstPct: +(100 * wz).toFixed(3), t: +(tm / (ts / Math.sqrt(z.length))).toFixed(2) };

  // ---- RM family daily (the repo model) with and without the month-end-window defect and with/without financing
  const cuts = ["2026-09-25", "2026-09-30", "2026-10-09"];
  console.log("\nRM family (risk-manager.js buildBook verbatim, daily) 2019-06-03 .. cut");
  console.log("variant                          cut         CAGR%   maxDD(daily)%  vol%   Sharpe  lastBar");
  out.rm = {};
  for (const cut of cuts) for (const fix of [false, true]) for (const fin of [false, true]) {
    const r = await M.rmRows(inp, { asOf: cut, fixWindow: fix }), d = M.rmDaily(r.rows, { w: M.E_W, zn: 4.2 }, { fin }), s = M.dailyStats(d);
    const key = `${fix ? "windowFixed" : "asCoded"}${fin ? "+financed" : ""}@${cut}`; out.rm[key] = s;
    console.log(`${(fix ? "window FIXED" : "as coded").padEnd(14)} ${(fin ? "ZN financed" : "ZN unfinanced").padEnd(17)} ${cut}  ${String(s.cagrPct).padStart(6)}  ${String(s.maxDDdailyPct).padStart(10)}   ${String(s.volPct).padStart(5)}  ${String(s.sharpe).padStart(6)}  ${r.lastBar}`);
  }
  console.log("  (the 09-25 / 09-30 rows are unaffected by the window defect - those months are complete; the 10-09 rows show the defect: the as-coded 10-09 CAGR carries 7 sessions of ZN proxy that the true window (10-26..10-30) does not.)");

  // ---- measured trading cost, side by side with the assumed rates (ONLY with --measured-costs; without it nothing below runs)
  if (MC) {
    const cmp = M.costCompare(inp, { measured: MC.costs, plans: ["E", "D2"], mults: M.COST_MULTS, asOf: "2026-09-30", znRows: M.znWindows() });
    console.log("");
    for (const l of M.costTableLines(cmp)) console.log(l);
    console.log(`  measured rates read from ${MCFILE} (spec ${MC.meta.spec}${MC.meta.measuredAt ? ", measured " + MC.meta.measuredAt : ""}${MC.meta.source ? ", " + MC.meta.source : ""})`);
    console.log(`  the "assumed x1" rows are the PY table above, re-run through the same code path: E ${res.E.annualReturnPct} / D2 ${res.D2.annualReturnPct}. The crypto rate is read per ROUND TRIP and the rule pays half of it at each switch; the equity rate is per SIDE and a flip is one side; the ZN rate replaces the ${M.ASSUMED_COSTS.znBpsPerRoundTrip} bps of round-trip cost already taken off each stored window (the 2 bps a roll-guard day that futures-month-end.js also subtracts is a splice-day penalty, not a fill cost, and stays). DBMF is held and pays nothing here, and the RM proxy table above is NOT re-priced (its costs live in risk-manager.js).`);
    out.measuredCosts = { spec: "planE-baseline-measured-cost-block-v1", file: MCFILE, read: MC.meta, assumedBps: cmp.assumed, measuredBps: cmp.measured, mults: cmp.mults, from: cmp.from, to: cmp.to,
      rows: cmp.rows.map((r) => ({ plan: r.plan, set: r.set, mult: r.mult, bps: r.costs, annualReturnPct: r.annualReturnPct, worstMonth: r.worstMonth, worstMonthPct: r.worstMonthPct, maxDDmonthEndPct: r.maxDDmonthEndPct, months: r.months, sharpe: r.sharpe, monthlySdPct: r.monthlySdPct })),
      note: "The PY (real-ZN, monthly) family only. assumed x1 reproduces py.E / py.D2 above exactly; the RM proxy family is not re-priced." };
  }
  writeJsonAtomic(OUT, out); console.log(`\nwrote ${path.relative(process.cwd(), OUT)}`);
})().catch((e) => { console.error("planE-baseline FAILED:", e.stack); process.exit(1); });
