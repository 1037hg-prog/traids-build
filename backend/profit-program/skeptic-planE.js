#!/usr/bin/env node
"use strict";
/**
 * SKEPTIC - lane plan-e. READ-ONLY on the repo; offline (reads backend/data/profit-program/planE-inputs.json, futures-month-end.json,
 * futures-daily/ZN.json, strategy-library/R313.json). Writes backend/data/profit-program/skeptic-planE.json only.
 *   node backend/profit-program/skeptic-planE.js
 * Everything is IN-SAMPLE (88 months 2019-06..2026-09 unless a line says otherwise). t-statistics are by MONTH (one observation per month).
 * It reads no registered test's forward outcome. Attacks: concentration, exposure-not-skill, placebo, sizing-as-edge, parameter selection.
 */
const fs = require("fs"), path = require("path");
const M = require("./planE-model.js");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const mean = M.mean, sd = M.sd, ANCH = 100000;
const tOf = (x) => mean(x) / (sd(x) / Math.sqrt(x.length));
const usd = (x) => (x < 0 ? "-$" : "+$") + Math.abs(Math.round(x)).toLocaleString("en-US");
const p2 = (x, n = 2) => (x >= 0 ? "+" : "") + x.toFixed(n);
function ols(y, x) {
  const n = y.length, mx = mean(x), my = mean(y); let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); }
  const b = sxy / sxx, a = my - b * mx; let sse = 0; for (let i = 0; i < n; i++) sse += (y[i] - a - b * x[i]) ** 2;
  const s2 = sse / (n - 2), seA = Math.sqrt(s2 * (1 / n + mx * mx / sxx)); return { alpha: a, beta: b, tAlpha: a / seA, n };
}
const ddOf = (x) => { let v = 1, pk = 1, w = 0; for (const q of x) { v *= 1 + q; pk = Math.max(pk, v); w = Math.min(w, v / pk - 1); } return w; };
const OUT = { spec: "skeptic-planE-v1" };

(async () => {
  const inp = M.loadInputs(), asOf = "2026-09-30", LO = "2019-06", HI = "2026-09";
  const py = M.pyBuild(inp, { asOf }), E = py.run(LO, HI, M.PYW.E), ms = E.months, n = ms.length, tb = ms.map((m) => py.TR.get(m).tb);
  const stE = M.monthlyStats(E.mo);
  console.log(`baseline reproduced: Plan E PY real-ZN ${stE.annualReturnPct}%/yr over ${n} months (analyst 24.26)\n`);

  // ---------------- S1 ZN: concentration + history outside the Plan E window
  {
    const z = M.znWindows(), inW = z.filter((r) => r.m >= LO && r.m <= HI), pre = z.filter((r) => r.m < LO);
    const st = (a) => ({ n: a.length, meanBps: +(1e4 * mean(a.map((r) => r.tre))).toFixed(1), t: +tOf(a.map((r) => r.tre)).toFixed(2) });
    console.log("S1. ZN LEG (real ZN month-end windows, net of the 4 bps round trip)");
    console.log(`   inside the Plan E window ${LO}..${HI}: ${JSON.stringify(st(inW))} | before it (${pre[0].m}..${pre[pre.length - 1].m}): ${JSON.stringify(st(pre))} | all ${z.length}: ${JSON.stringify(st(z))}`);
    const s = [...inW].sort((a, b) => b.tre - a.tre), tot = inW.reduce((a, r) => a + r.tre, 0);
    const share = (k) => 100 * s.slice(0, k).reduce((a, r) => a + r.tre, 0) / tot;
    const drop = (k) => { const rest = s.slice(k).map((r) => r.tre); return { meanBps: +(1e4 * mean(rest)).toFixed(1), t: +tOf(rest).toFixed(2), legPtYr: +(100 * 12 * 4.2 * mean(rest)).toFixed(2) }; };
    console.log(`   CONCENTRATION inside the window: sum of 88 windows ${(100 * tot).toFixed(2)}% (x4.2 = ${(420 * tot).toFixed(1)}% of NAV). top 2 = ${share(2).toFixed(0)}% of it (${s.slice(0, 2).map((r) => r.m + " " + (100 * r.tre).toFixed(2) + "%").join(", ")}); top 5 = ${share(5).toFixed(0)}%; top 10 = ${share(10).toFixed(0)}%`);
    console.log(`   without the top 2: ${JSON.stringify(drop(2))} | without the top 5: ${JSON.stringify(drop(5))}   (as built: leg ${(100 * 12 * 4.2 * mean(inW.map((r) => r.tre))).toFixed(2)} pt/yr)`);
    const yr = {}; inW.forEach((r) => (yr[r.m.slice(0, 4)] = (yr[r.m.slice(0, 4)] || 0) + 4.2 * r.tre)); const ys = Object.entries(yr).sort((a, b) => b[1] - a[1]);
    const two = ys[0][1] + ys[1][1];
    console.log(`   by calendar year (% of NAV at 4.2x): ${Object.entries(yr).map(([y, v]) => y + " " + (100 * v).toFixed(1)).join(" | ")}`);
    console.log(`   best two years (${ys[0][0]}, ${ys[1][0]}) = ${(100 * two / (4.2 * tot)).toFixed(0)}% of the 88-month total; the other ${ys.length - 2} years sum to ${(100 * (4.2 * tot - two)).toFixed(1)}% of NAV`);
    // the pre-window history split in two halves, as a stability read
    const h = Math.floor(pre.length / 2);
    console.log(`   pre-window halves: ${pre[0].m}..${pre[h - 1].m} ${JSON.stringify(st(pre.slice(0, h)))} | ${pre[h].m}..${pre[pre.length - 1].m} ${JSON.stringify(st(pre.slice(h)))}`);
    OUT.S1 = { inWindow: st(inW), before: st(pre), all: st(z), top2SharePct: +share(2).toFixed(1), top5SharePct: +share(5).toFixed(1), dropTop2: drop(2), dropTop5: drop(5), byYearPctNav: Object.fromEntries(Object.entries(yr).map(([y, v]) => [y, +(100 * v).toFixed(2)])), bestTwoYearsSharePct: +(100 * two / (4.2 * tot)).toFixed(1) };
  }

  // ---------------- S2 crypto: concentration, exposure-vs-timing, SMA length
  {
    const cl = ms.map((m) => E.legs[m].CRYPTO), tot = cl.reduce((a, b) => a + b, 0), srt = ms.map((m, i) => [m, cl[i]]).sort((a, b) => b[1] - a[1]);
    const share = (k) => 100 * srt.slice(0, k).reduce((a, r) => a + r[1], 0) / tot, rest = (k) => srt.slice(k).map((r) => r[1]);
    console.log("\nS2. CRYPTO LEG (15% of NAV, BTC/ETH 50-day rule, 25 bps per switch)");
    console.log(`   sum of 88 monthly contributions ${(100 * tot).toFixed(1)}% of NAV. top 3 months = ${share(3).toFixed(0)}% (${srt.slice(0, 3).map((r) => r[0] + " " + (100 * r[1]).toFixed(1)).join(", ")}); top 6 = ${share(6).toFixed(0)}%; top 9 = ${share(9).toFixed(0)}%`);
    console.log(`   without the top 6 months: ${(1200 * mean(rest(6))).toFixed(2)} pt/yr t ${tOf(rest(6)).toFixed(2)}   (as built ${(1200 * mean(cl)).toFixed(2)} pt/yr t ${tOf(cl).toFixed(2)})`);
    const yr = {}; ms.forEach((m, i) => (yr[m.slice(0, 4)] = (yr[m.slice(0, 4)] || 0) + cl[i]));
    const pair = ms.map((m, i) => [m, cl[i]]), a = pair.filter((x) => x[0] <= "2021-12").map((x) => x[1]), b = pair.filter((x) => x[0] >= "2022-01").map((x) => x[1]);
    console.log(`   by year (% of NAV): ${Object.entries(yr).map(([y, v]) => y + " " + (100 * v).toFixed(1)).join(" | ")}`);
    console.log(`   2019-06..2021-12 (${a.length} mo): ${(1200 * mean(a)).toFixed(2)} pt/yr t ${tOf(a).toFixed(2)}  |  2022-01..2026-09 (${b.length} mo): ${(1200 * mean(b)).toFixed(2)} pt/yr t ${tOf(b).toFixed(2)}`);
    // buy-and-hold 50/50 BTC/ETH daily-rebalanced, same UTC days
    const B = inp.crypto.BTC, Et = inp.crypto.ETH, ds = Object.keys(B).filter((d) => d <= asOf && Et[d] != null).sort(), bh = {};
    for (let i = 1; i < ds.length; i++) { const m = ds[i].slice(0, 7); bh[m] = (bh[m] || 1) * (1 + 0.5 * (B[ds[i]] / B[ds[i - 1]] - 1) + 0.5 * (Et[ds[i]] / Et[ds[i - 1]] - 1)); }
    const tr = ms.map((m) => py.C[m]), bhm = ms.map((m) => bh[m] - 1), o = ols(tr.map((x, i) => x - tb[i]), bhm.map((x, i) => x - tb[i]));
    const cum = (x) => x.reduce((p, v) => p * (1 + v), 1), cg = (x) => (100 * (cum(x) ** (12 / x.length) - 1)).toFixed(1);
    console.log(`   EXPOSURE vs TIMING (sleeve at 100%): trend arith ${(1200 * mean(tr)).toFixed(1)}%/yr, CAGR ${cg(tr)}%, month-end maxDD ${(100 * ddOf(tr)).toFixed(0)}%  |  buy-and-hold arith ${(1200 * mean(bhm)).toFixed(1)}%/yr, CAGR ${cg(bhm)}%, maxDD ${(100 * ddOf(bhm)).toFixed(0)}%`);
    console.log(`   trend monthly excess regressed on buy-and-hold excess: beta ${o.beta.toFixed(2)}, alpha ${(1200 * o.alpha).toFixed(1)} %/yr on the sleeve = ${(1200 * 0.15 * o.alpha).toFixed(2)} pt/yr of NAV = ${usd(ANCH * 0.15 * o.alpha)}/mo, t(alpha) ${o.tAlpha.toFixed(2)} over ${n} months`);
    const sub = (lo, hi) => { const ix = ms.map((m, i) => (m >= lo && m <= hi ? i : -1)).filter((i) => i >= 0), oo = ols(ix.map((i) => tr[i] - tb[i]), ix.map((i) => bhm[i] - tb[i])); return `${lo}..${hi}: beta ${oo.beta.toFixed(2)} alpha ${(1200 * oo.alpha).toFixed(1)}%/yr t ${oo.tAlpha.toFixed(2)} (buy-and-hold arith ${(1200 * mean(ix.map((i) => bhm[i]))).toFixed(0)}%/yr, trend ${(1200 * mean(ix.map((i) => tr[i]))).toFixed(0)}%/yr)`; };
    console.log(`   halves: ${sub("2019-06", "2022-12")}  |  ${sub("2023-01", "2026-09")}`);
    console.log("   SMA LENGTH - same model, only N changes (9 lengths tried here, in-sample):");
    const rowsN = [];
    for (const N of [20, 30, 40, 50, 60, 75, 100, 150, 200]) { const p = M.pyBuild(inp, { asOf, cryptoN: N }), r = p.run(LO, HI, M.PYW.E), s = M.monthlyStats(r.mo), c = r.months.map((m) => r.legs[m].CRYPTO); rowsN.push({ N, planCagr: s.annualReturnPct, cryptoPtYr: +(1200 * mean(c)).toFixed(2), t: +tOf(c).toFixed(2), maxDD: s.maxDDmonthEndPct }); }
    console.log("   " + rowsN.map((r) => `N${r.N}: plan ${r.planCagr}% crypto ${r.cryptoPtYr}pt t ${r.t}`).join(" | "));
    const cs = rowsN.map((r) => r.planCagr), c50 = rowsN.find((r) => r.N === 50).planCagr;
    console.log(`   range across lengths: plan CAGR ${Math.min(...cs)}..${Math.max(...cs)}% (N=50 is ${c50}%; rank ${[...cs].sort((x, y) => y - x).indexOf(c50) + 1} of ${cs.length}); mean of the 9 ${mean(cs).toFixed(2)}%`);
    OUT.S2 = { top3SharePct: +share(3).toFixed(1), top6SharePct: +share(6).toFixed(1), byYearPctNav: Object.fromEntries(Object.entries(yr).map(([y, v]) => [y, +(100 * v).toFixed(2)])), early: { ptYr: +(1200 * mean(a)).toFixed(2), t: +tOf(a).toFixed(2) }, late: { ptYr: +(1200 * mean(b)).toFixed(2), t: +tOf(b).toFixed(2) }, timing: { beta: +o.beta.toFixed(3), alphaPctYrSleeve: +(1200 * o.alpha).toFixed(2), alphaPtYrNav: +(1200 * 0.15 * o.alpha).toFixed(2), tAlpha: +o.tAlpha.toFixed(2) }, smaLength: rowsN };
  }

  // ---------------- S3 equity/gold trend sleeves vs buy-and-hold
  {
    console.log("\nS3. TREND SLEEVES vs BUY-AND-HOLD of the same ETF (is the equity leg t 3.20 skill or the index?)");
    const res = {}, blendT = ms.map(() => 0), blendB = ms.map(() => 0), wts = { QQQ: 0.15, SPY: 0.15, EFA: 0.10, GLD: 0.10 };
    for (const [s, T] of [["QQQ", py.Q], ["SPY", py.S], ["EFA", py.EF], ["GLD", py.G]]) {
      const me = M.monthEnds(inp.bars[s], asOf), bh = M.holdMonthly(me), t = ms.map((m) => T[m]), b = ms.map((m) => bh[m]), d = t.map((x, i) => x - b[i]);
      const all = Object.keys(me).sort(); let on = 0; for (const m of ms) { const i = all.indexOf(m); if (me[all[i - 1]] > mean(all.slice(i - 10, i).map((q) => me[q]))) on++; }
      res[s] = { trendPctYr: +(1200 * mean(t)).toFixed(2), holdPctYr: +(1200 * mean(b)).toFixed(2), diffPctYr: +(1200 * mean(d)).toFixed(2), tDiff: +tOf(d).toFixed(2), onPct: Math.round(100 * on / n), ddTrend: +(100 * ddOf(t)).toFixed(1), ddHold: +(100 * ddOf(b)).toFixed(1) };
      console.log(`   ${s}: trend ${res[s].trendPctYr}%/yr vs hold ${res[s].holdPctYr}%/yr -> trend minus hold ${p2(res[s].diffPctYr)} %/yr (t ${res[s].tDiff}); ON ${res[s].onPct}% of months; month-end maxDD trend ${res[s].ddTrend}% vs hold ${res[s].ddHold}%`);
      if (s !== "GLD") ms.forEach((m, i) => { blendT[i] += wts[s] * t[i]; blendB[i] += wts[s] * b[i]; });
    }
    const d = blendT.map((x, i) => x - blendB[i]), o = ols(blendT.map((x, i) => x - 0.4 * tb[i]), blendB.map((x, i) => x - 0.4 * tb[i]));
    console.log(`   EQUITY LEG (QQQ 15 + SPY 15 + EFA 10): trend ${(1200 * mean(blendT)).toFixed(2)} pt/yr of NAV (t ${tOf(blendT).toFixed(2)}) vs holding the same 40% ${(1200 * mean(blendB)).toFixed(2)} pt/yr (t ${tOf(blendB).toFixed(2)})`);
    console.log(`   trend minus hold ${p2(1200 * mean(d))} pt/yr = ${usd(ANCH * mean(d))}/mo (t ${tOf(d).toFixed(2)}); leg peak-to-trough: trend ${(100 * ddOf(blendT)).toFixed(1)}% of NAV vs hold ${(100 * ddOf(blendB)).toFixed(1)}%; alpha vs hold ${p2(1200 * o.alpha)} pt/yr t ${o.tAlpha.toFixed(2)} beta ${o.beta.toFixed(2)}`);
    OUT.S3 = { perEtf: res, equityLeg: { trendPtYr: +(1200 * mean(blendT)).toFixed(2), holdPtYr: +(1200 * mean(blendB)).toFixed(2), diffPtYr: +(1200 * mean(d)).toFixed(2), tDiff: +tOf(d).toFixed(2), ddTrendPct: +(100 * ddOf(blendT)).toFixed(2), ddHoldPct: +(100 * ddOf(blendB)).toFixed(2), alphaPtYr: +(1200 * o.alpha).toFixed(2), tAlpha: +o.tAlpha.toFixed(2), beta: +o.beta.toFixed(2) } };
  }

  // ---------------- S4 scale-up levers are sizing: value under each scenario; risk by sd / worst month / worst 12 months, not one drawdown
  {
    console.log("\nS4. SCALE-UPS ARE SIZING. Change vs Plan E inside the SAME scenario (per $100k)");
    const znPx = JSON.parse(fs.readFileSync(M.D("futures-daily/ZN.json"), "utf8")).bars, px = znPx[znPx.length - 1].c, k5 = 5 * 1000 * px / ANCH / 4.2;
    const S110 = Object.fromEntries(Object.entries(M.PYW.E).map(([k, v]) => [k, k === "L" ? v : +(1.1 * v).toFixed(6)])), ZN5 = { ...M.PYW.E, L: 4.2 * k5 };
    const scen = {
      "as built (2019-2026 repeats)": (L) => L,
      "crypto leg earns only T-bills": (L, r, w) => ({ ...L, CRYPTO: w.c * r }),
      "ZN month-end earns 0 gross (costs still paid)": (L, r, w) => ({ ...L, ZN: w.L * -0.0004 }),
      "neither crypto nor ZN": (L, r, w) => ({ ...L, CRYPTO: w.c * r, ZN: w.L * -0.0004 }),
    };
    const w12 = (x) => { let w = 9; for (let i = 0; i + 12 <= x.length; i++) w = Math.min(w, x.slice(i, i + 12).reduce((p, v) => p * (1 + v), 1) - 1); return w; };
    const rows = [];
    for (const [sl, f] of Object.entries(scen)) {
      const one = (w) => { const r = py.run(LO, HI, w), mo = {}; r.months.forEach((m, i) => { const L = f(r.legs[m], tb[i], w); mo[m] = Object.values(L).reduce((a, b) => a + b, 0); }); const s = M.monthlyStats(mo), x = r.months.map((m) => mo[m]); return { cagr: s.annualReturnPct, sd: s.monthlySdPct, dd: s.maxDDmonthEndPct, worstMo: s.worstMonth[1], w12: +(100 * w12(x)).toFixed(2), y22: s.years["2022"] }; };
      const e = one(M.PYW.E), a = one(S110), b = one(ZN5);
      const line = (lab, v) => `${lab}: ${p2(v.cagr - e.cagr)} pt = ${usd(ANCH * (v.cagr - e.cagr) / 100 / 12)}/mo | monthly sd ${p2(v.sd - e.sd, 3)} | worst month ${p2(v.worstMo - e.worstMo)} | worst 12m ${p2(v.w12 - e.w12)} | 2022 ${p2(v.y22 - e.y22)} | max month-end DD ${p2(v.dd - e.dd)}`;
      console.log(`   [${sl}] Plan E ${e.cagr}%/yr, sd ${e.sd}, worst 12m ${e.w12}%\n      ${line("sleeves x1.10 ", a)}\n      ${line("ZN 5 contracts", b)}`);
      rows.push({ scenario: sl, planE: e, sleeves110: a, zn5: b, usdSleeves: Math.round(ANCH * (a.cagr - e.cagr) / 100 / 12), usdZn5: Math.round(ANCH * (b.cagr - e.cagr) / 100 / 12) });
    }
    const r0 = rows[0], perS = (r0.sleeves110.sd - r0.planE.sd) / r0.usdSleeves, perZ = (r0.zn5.sd - r0.planE.sd) / r0.usdZn5;
    console.log(`   risk per +$100/mo (as built): sleeves x1.10 add ${(100 * perS).toFixed(3)} pt of monthly sd, ZN 5 contracts ${(100 * perZ).toFixed(3)} pt -> ${(perZ / perS).toFixed(1)}x, where the single max-drawdown figure says ${((r0.zn5.dd - r0.planE.dd) / (r0.sleeves110.dd - r0.planE.dd) * r0.usdSleeves / r0.usdZn5).toFixed(1)}x`);
    OUT.S4 = rows;
  }

  // ---------------- S5 R313 sleeve vs a plain index sleeve funded the same way
  {
    console.log("\nS5. R313 10% SLEEVE vs PLACEBO SLEEVES (same formula r = PlanE + w x (s - rf); same days; t by calendar month)");
    const r = await M.rmRows(inp, { asOf, fixWindow: true }), pe = M.rmDaily(r.rows, { w: M.E_W, zn: 4.2 }, { fin: true }), rf = new Map(r.rows.map((x) => [x.d, x.rf])), dates = pe.map((x) => x.d);
    const ret = (s) => { const m = new Map(), b = inp.bars[s]; for (let i = 1; i < b.length; i++) m.set(b[i].t.slice(0, 10), b[i].c / b[i - 1].c - 1); return m; };
    const lib = JSON.parse(fs.readFileSync(M.D("strategy-library/R313.json"), "utf8")), r313 = new Map(lib.series.map((x) => [x.d, x.r]));
    const spy = ret("SPY"), qqq = ret("QQQ"), efa = ret("EFA"), base = M.dailyStats(pe);
    const streams = { "R313 (library stream)": (d) => r313.get(d) ?? 0, "SPY buy-and-hold": (d) => spy.get(d) ?? 0, "QQQ buy-and-hold": (d) => qqq.get(d) ?? 0, "SPY/QQQ/EFA equal weight": (d) => ((spy.get(d) ?? 0) + (qqq.get(d) ?? 0) + (efa.get(d) ?? 0)) / 3 };
    const rows = {};
    for (const [lab, f] of Object.entries(streams)) {
      const sl = dates.map((d) => { const s = f(d); return 0.10 * (s - (s !== 0 ? rf.get(d) : 0)); }), st = M.dailyStats(pe.map((x, i) => ({ d: x.d, r: x.r + sl[i] })));
      const mo = {}; dates.forEach((d, i) => (mo[d.slice(0, 7)] = (mo[d.slice(0, 7)] || 0) + sl[i])); const dm = Object.values(mo), own = M.dailyStats(dates.map((d) => ({ d, r: f(d) })));
      rows[lab] = { ownCagr: own.cagrPct, ownVol: own.volPct, dCagr: +(st.cagrPct - base.cagrPct).toFixed(2), usd: Math.round(ANCH * (st.cagrPct - base.cagrPct) / 100 / 12), dDD: +(st.maxDDdailyPct - base.maxDDdailyPct).toFixed(2), t: +tOf(dm).toFixed(2) };
      console.log(`   +10% ${lab.padEnd(26)} own CAGR ${String(own.cagrPct).padStart(6)}% vol ${String(own.volPct).padStart(5)}%  -> Plan E ${p2(rows[lab].dCagr)} pt = ${usd(rows[lab].usd)}/mo, max daily DD ${p2(rows[lab].dDD)} pt, t(months) ${rows[lab].t}`);
    }
    const moOf = (f) => { const g = {}; dates.forEach((d) => (g[d.slice(0, 7)] = (g[d.slice(0, 7)] || 1) * (1 + f(d)))); return g; };
    const a = moOf(streams["R313 (library stream)"]), b = moOf(streams["SPY buy-and-hold"]), mm = Object.keys(a).sort();
    const reg = (lo) => { const k = mm.filter((m) => m >= lo), o = ols(k.map((m) => a[m] - 1), k.map((m) => b[m] - 1)), d = k.map((m) => a[m] - b[m]); return { months: k.length, beta: +o.beta.toFixed(2), alphaPctYr: +(1200 * o.alpha).toFixed(2), tAlpha: +o.tAlpha.toFixed(2), r313MinusSpyPctYr: +(1200 * mean(d)).toFixed(2), tDiff: +tOf(d).toFixed(2) }; };
    const full = reg("2019-06"), last3 = reg("2023-10");
    console.log(`   R313 vs SPY, monthly: ${LO}.. ${JSON.stringify(full)}`);
    console.log(`                         2023-10.. ${JSON.stringify(last3)}`);
    console.log("   cash budget: Plan E holds 20% outside the sleeves (JAAA 8% + ZN reserve 12%). Sleeves x1.10 wants 8 pt, an R313 10% sleeve 10 pt, the reserve 12 pt = 30 pt from 20 pt: both levers cannot be funded with the reserve intact.");
    OUT.S5 = { rows, r313VsSpy: { full, last3 } };
  }

  // ---------------- S6 the scoreboard's ZN proxy: bias today and the noise around it
  {
    const r = await M.rmRows(inp, { asOf, fixWindow: true }), real = new Map(M.znWindows().map((x) => [x.m, x.tre])), byM = {};
    r.rows.forEach((x) => { if (x.win && x.ief != null) { const m = x.d.slice(0, 7); byM[m] = byM[m] || { g: 1, gf: 1, n: 0 }; byM[m].g *= 1 + 0.79 * x.ief; byM[m].gf *= 1 + 0.79 * x.ief - 0.79 * x.rf; byM[m].n++; } });
    const k = Object.keys(byM).filter((m) => byM[m].n === 5 && real.has(m) && m >= LO && m <= HI).sort();
    const dU = k.map((m) => real.get(m) - (byM[m].g - 1 - 0.0004)), dF = k.map((m) => real.get(m) - (byM[m].gf - 1 - 0.0004));
    const TBY = M.tbillByMonth(), tm = Object.keys(TBY).sort(), last = TBY[tm[tm.length - 1]], t12 = mean(tm.slice(-12).map((m) => TBY[m]));
    const drift = (rfA) => 4.2 * 0.79 * rfA * 5 / 252 * ANCH, sdU = 4.2 * sd(dU) * ANCH, k24 = k.slice(-24), dU24 = k24.map((m) => real.get(m) - (byM[m].g - 1 - 0.0004));
    console.log("\nS6. THE SCOREBOARD MODEL'S ZN PROXY (4.2 x 0.79 x IEF total return): expected false shortfall per window and the noise around it, per $100k");
    console.log(`   real minus proxy per window, ${k.length} windows: mean ${usd(4.2 * mean(dU) * ANCH)} (analyst: -$198), sd ${usd(sdU).slice(1)}; with the T-bill charged on the proxy: mean ${usd(4.2 * mean(dF) * ANCH)}, sd ${usd(4.2 * sd(dF) * ANCH).slice(1)}; last 24 windows (${k24[0]}..) unfinanced: mean ${usd(4.2 * mean(dU24) * ANCH)}, sd ${usd(4.2 * sd(dU24) * ANCH).slice(1)}`);
    console.log(`   financing bias at today's bill rate: DTB3 ${tm[tm.length - 1]} ${(100 * last).toFixed(2)}% -> ${usd(-drift(last))} per window; trailing 12 months ${(100 * t12).toFixed(2)}% -> ${usd(-drift(t12))} per window`);
    console.log(`   NOISE: one window's paper-vs-model ZN line moves +/- ${usd(sdU).slice(1)} (1 sd) on proxy basis alone = ${(sdU / drift(t12)).toFixed(1)}x the bias; windows needed to see the bias at t=2: ${Math.ceil((2 * sdU / drift(t12)) ** 2)}. The 11-02 review will hold exactly 1 ZN window.`);
    OUT.S6 = { windows: k.length, meanRealMinusProxyUsd: Math.round(4.2 * mean(dU) * ANCH), sdUsd: Math.round(sdU), financedMeanUsd: Math.round(4.2 * mean(dF) * ANCH), financedSdUsd: Math.round(4.2 * sd(dF) * ANCH), last24MeanUsd: Math.round(4.2 * mean(dU24) * ANCH), driftAtLatestRfUsd: Math.round(drift(last)), driftAtTrailing12Usd: Math.round(drift(t12)), windowsToDetect: Math.ceil((2 * sdU / drift(t12)) ** 2) };
  }

  // ---------------- S7 ZN reserve vs margin: adverse excursion inside the window
  {
    const zn = JSON.parse(fs.readFileSync(M.D("futures-daily/ZN.json"), "utf8")).bars, byM = {}; zn.forEach((b) => (byM[b.d.slice(0, 7)] = byM[b.d.slice(0, 7)] || []).push(b));
    const ex = []; for (const [m, bs] of Object.entries(byM)) { if (bs.length < 15 || m >= "2026-10") continue; const w = bs.slice(-5), entry = bs[bs.length - 6].c; ex.push({ m, low: Math.min(...w.map((b) => b.l)) - entry }); }
    console.log(`\nS7. ZN RESERVE ($12,000 per $100k) vs MARGIN. ${ex.length} windows in the Schwab ZN store (${ex[0].m}..${ex[ex.length - 1].m}); intra-window low vs the entry close in points ($1,000 a point a contract). Margin per contract is NOT in the repo: it is a column here, not a fact.`);
    const srt = ex.map((x) => x.low).sort((a, b) => a - b); console.log(`   adverse excursion (pts): worst ${srt[0].toFixed(2)}, 2nd ${srt[1].toFixed(2)}, 3rd ${srt[2].toFixed(2)}, median ${srt[Math.floor(srt.length / 2)].toFixed(2)}`);
    const tab = [];
    for (const nC of [4, 5]) for (const mg of [2000, 2500, 3000]) {
      const cushion = 12000 - nC * mg, pts = cushion / (nC * 1000), hit = cushion <= 0 ? ex.length : ex.filter((x) => x.low <= -pts).length; tab.push({ contracts: nC, marginPerContract: mg, cushionUsd: cushion, cushionPts: +pts.toFixed(2), windowsBreached: hit, of: ex.length });
      console.log(`   ${nC} contracts at $${mg}/contract: requirement $${nC * mg}, cushion ${usd(cushion)} = ${pts.toFixed(2)} pt -> ${cushion <= 0 ? "cannot be held on the reserve alone" : hit + " of " + ex.length + " windows dipped past the cushion (a margin call before the -2.5 pt disaster stop)"}`);
    }
    OUT.S7 = { windows: ex.length, worstPts: +srt[0].toFixed(2), table: tab };
  }

  // ---------------- S8 the floor of the 'honest range'
  {
    const TBY = M.tbillByMonth(), tm = Object.keys(TBY).sort(), t12 = mean(tm.slice(-12).map((m) => TBY[m]));
    const sc = (f) => { const mo = {}; ms.forEach((m, i) => (mo[m] = f(E.legs[m], tb[i]))); return M.monthlyStats(mo).annualReturnPct; };
    const neither = sc((L, r) => L.EQ + L.GLD + L.DBMF + 0.15 * r + L.CASH), eqHalf = sc((L, r) => 0.5 * L.EQ + 0.5 * 0.4 * r + L.GLD + L.DBMF + 0.15 * r + L.CASH), tbOnly = sc((L, r) => r);
    console.log(`\nS8. THE FLOOR OF THE 'HONEST RANGE'. 'Neither leg' ${neither}%/yr = ${usd(ANCH * neither / 100 / 12)}/mo still assumes the equity sleeves repeat 2019-2026 (${(1200 * mean(ms.map((m) => E.legs[m].EQ)) / 0.4).toFixed(1)}%/yr on the 40% they hold).`);
    console.log(`   equity sleeves at half their in-sample excess as well: ${eqHalf}%/yr = ${usd(ANCH * eqHalf / 100 / 12)}/mo. T-bills alone over the same 88 months: ${tbOnly}%/yr = ${usd(ANCH * tbOnly / 100 / 12)}/mo; at the trailing-12-month bill rate ${(100 * t12).toFixed(2)}% = ${usd(ANCH * t12 / 12)}/mo.`);
    OUT.S8 = { neitherPct: neither, eqHalfPct: eqHalf, tbillOnlyPct: tbOnly, tbill12mUsdPerMonth: Math.round(ANCH * t12 / 12) };
  }

  // ---------------- S9 forward-file rows touched by the window defect (from the analyst's own output; book column only)
  {
    const f = M.D("profit-program/planE-buildbook-defect.json");
    if (fs.existsSync(f)) { const rows = JSON.parse(fs.readFileSync(f, "utf8")).forward.rows, bad = rows.filter((x) => Math.abs(x.spurious) > 1e-6);
      console.log(`\nS9. FORWARD FILE (book column only): ${bad.length} of ${rows.length} rows differ from the window-fixed rebuild (${bad.map((x) => x.d.slice(5)).join(", ")}), ${bad.filter((x) => x.d < "2026-10-01").length} of them in September (a phantom 8.4 bp edge cost): a rewrite starts at ${bad[0].d}, not 10-01.`);
      OUT.S9 = { rows: rows.length, differ: bad.length, first: bad[0].d }; }
  }

  writeJsonAtomic(M.D("profit-program/skeptic-planE.json"), OUT); console.log("\nwrote backend/data/profit-program/skeptic-planE.json");
})().catch((e) => { console.error("skeptic-planE FAILED:", e.stack); process.exit(1); });
