#!/usr/bin/env node
"use strict";
/**
 * SKEPTIC - lane plan-e, second pass: is the "real ZN" series itself sound, and what the sizing levers are worth outside the best stretch.
 * READ-ONLY on the repo; offline (reads planE-inputs.json, futures-month-end.json, futures-daily/ZN.json, planE-tom-window.json).
 * Writes backend/data/profit-program/skeptic-planE-zn-instrument.json only.
 *   node backend/profit-program/skeptic-planE-zn-instrument.js
 * Everything is IN-SAMPLE. t by MONTH (one observation per month). Reads no registered forward outcome.
 */
const fs = require("fs");
const M = require("./planE-model.js");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const mean = M.mean, sd = M.sd, ANCH = 100000;
const tOf = (x) => (x.length > 2 && sd(x) > 0 ? mean(x) / (sd(x) / Math.sqrt(x.length)) : NaN);
const usd = (x) => (x < 0 ? "-$" : "+$") + Math.abs(Math.round(x)).toLocaleString("en-US");
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const OUT = { spec: "skeptic-planE-zn-instrument-v1" };

(async () => {
  const inp = M.loadInputs(), LO = "2019-06", HI = "2026-09";
  const fme = JSON.parse(fs.readFileSync(M.D("futures-month-end.json"), "utf8"));
  const store = JSON.parse(fs.readFileSync(M.D("futures-daily/ZN.json"), "utf8")), zb = store.bars;
  const ief = new Map(inp.bars.IEF.map((b) => [b.t.slice(0, 10), b.c]));

  // ---------------- Z1 what the "real ZN" series is
  console.log("Z1. WHAT THE REAL-ZN WINDOW SERIES IS");
  console.log(`   backend/data/futures-month-end.json: built ${fme.ranAt.slice(0, 10)} by futures-month-end.js from YAHOO ZN=F continuous front month, NOT back-adjusted (script header).`);
  console.log(`   roll guard: a day whose ZN-minus-${fme.out.znBetaOnIEF}xIEF residual exceeds 6 robust sd is REPLACED by ${fme.out.znBetaOnIEF} x IEF (the proxy) and charged 2 bps; days so replaced 2003-01..2026-08: ${fme.out.rollGuardDays.ZN} (quarterly rolls in ${fme.out.months} months: ${Math.round(fme.out.months / 3)}).`);
  console.log(`   Schwab store futures-daily/ZN.json: ${store.source}; symbol ${store.symbol}; ${zb.length} bars ${zb[0].d}..${zb[zb.length - 1].d}.`);
  OUT.Z1 = { yahooRollGuardDays: fme.out.rollGuardDays.ZN, months: fme.out.months, schwabSource: store.source, schwabBars: zb.length };

  // ---------------- Z2 roll jumps inside the Schwab continuous store: where do they fall relative to the month-end window?
  const byM = {}; zb.forEach((b, i) => (byM[b.d.slice(0, 7)] = byM[b.d.slice(0, 7)] || []).push(i));
  const offOf = (i) => { const a = byM[zb[i].d.slice(0, 7)]; return a.indexOf(i) - (a.length - 1); };
  const rows = [];
  for (let i = 1; i < zb.length; i++) { const d = zb[i].d, p = zb[i - 1].d; if (!ief.has(d) || !ief.has(p)) continue; const zr = Math.log(zb[i].c / zb[i - 1].c), ir = Math.log(ief.get(d) / ief.get(p)); rows.push({ i, d, zr, ir, res: zr - 0.79 * ir, off: offOf(i), monthComplete: zb[i].d.slice(0, 7) < "2026-10" }); }
  const m0 = med(rows.map((q) => q.res)), rs = 1.4826 * med(rows.map((r) => Math.abs(r.res - m0)));
  const big = rows.filter((r) => Math.abs(r.res) > 6 * rs).sort((a, b) => Math.abs(b.res) - Math.abs(a.res));
  console.log(`\nZ2. SCHWAB CONTINUOUS ZN vs 0.79 x IEF, ${rows.length} days: robust sd of the daily residual ${(1e4 * rs).toFixed(1)} bps; days beyond 6 robust sd (the Yahoo guard rule): ${big.length}`);
  console.log("   date        ZN %     0.79xIEF %   residual %   session offset (0 = last of month)   inside the last-5 window");
  for (const r of big) console.log(`   ${r.d}  ${(100 * r.zr).toFixed(3).padStart(7)}  ${(100 * 0.79 * r.ir).toFixed(3).padStart(8)}    ${(100 * r.res).toFixed(3).padStart(7)}        ${String(r.off).padStart(4)}                               ${r.off >= -4 ? "YES" : "no"}`);
  const inWinBig = big.filter((r) => r.off >= -4 && r.monthComplete), sumIn = inWinBig.reduce((a, r) => a + r.res, 0);
  console.log(`   of those, inside a month-end window: ${inWinBig.length} (${inWinBig.map((r) => r.d + " " + (100 * r.res).toFixed(2) + "%").join(", ") || "none"}); sum of their residuals ${(100 * sumIn).toFixed(3)}% of ZN notional = ${usd(4.2 * ANCH * sumIn)} per $100k at 4.2x`);
  const byMoY = {}; big.forEach((r) => { const k = r.d.slice(5, 7); byMoY[k] = (byMoY[k] || 0) + 1; });
  console.log(`   calendar months of the jumps: ${Object.entries(byMoY).sort().map(([k, v]) => k + " x" + v).join(", ")}`);
  OUT.Z2 = { days: rows.length, robustSdBps: +(1e4 * rs).toFixed(2), beyond6sd: big.map((r) => ({ d: r.d, resPct: +(100 * r.res).toFixed(3), off: r.off, inWindow: r.off >= -4 })), inWindowCount: inWinBig.length };

  // ---------------- Z3 the same months three ways: stored Yahoo-based window, Schwab-store window (raw), Schwab-store window with jumps replaced by the proxy
  const stored = new Map(fme.rowsOut.map((r) => [r.m, r.tre])), cmp = [], bigSet = new Set(big.map((r) => r.i));
  const lr = (i) => Math.log(zb[i].c / zb[i - 1].c), pr = (i) => { const d = zb[i].d, p = zb[i - 1].d; return ief.has(d) && ief.has(p) ? 0.79 * Math.log(ief.get(d) / ief.get(p)) : lr(i); };
  for (const [m, ix] of Object.entries(byM)) {
    if (ix.length < 15 || m >= "2026-10") continue; const L = ix.length, w = ix.slice(L - 5); if (w[0] < 1) continue;
    const jumps = w.filter((i) => bigSet.has(i)).length;
    const raw = Math.exp(w.reduce((s, i) => s + lr(i), 0)) - 1 - 0.0004;
    const guarded = Math.exp(w.reduce((s, i) => s + (bigSet.has(i) ? pr(i) : lr(i)), 0)) - 1 - 0.0004 - 0.0002 * jumps;
    cmp.push({ m, stored: stored.has(m) ? stored.get(m) : null, raw, guarded, jumps });
  }
  const both = cmp.filter((c) => c.stored != null);
  console.log(`\nZ3. THE SAME ${both.length} WINDOWS THREE WAYS (${both[0].m}..${both[both.length - 1].m}), % of ZN notional, net of 4 bps`);
  console.log("   month     stored (Yahoo, guarded)   Schwab raw   Schwab guarded   stored - Schwab guarded   jump days in window");
  for (const c of both) if (Math.abs(c.stored - c.guarded) > 0.0010 || c.jumps) console.log(`   ${c.m}        ${(100 * c.stored).toFixed(3).padStart(8)}            ${(100 * c.raw).toFixed(3).padStart(8)}      ${(100 * c.guarded).toFixed(3).padStart(8)}           ${(100 * (c.stored - c.guarded)).toFixed(3).padStart(8)}                 ${c.jumps}`);
  const d1 = both.map((c) => c.stored - c.guarded), d2 = both.map((c) => c.stored - c.raw);
  console.log("   (rows printed: |stored - Schwab guarded| > 10 bps or a jump day in the window)");
  console.log(`   mean per window: stored ${(100 * mean(both.map((c) => c.stored))).toFixed(3)}% | Schwab raw ${(100 * mean(both.map((c) => c.raw))).toFixed(3)}% | Schwab guarded ${(100 * mean(both.map((c) => c.guarded))).toFixed(3)}%`);
  console.log(`   stored minus Schwab guarded: mean ${(1e4 * mean(d1)).toFixed(1)} bps, sd ${(1e4 * sd(d1)).toFixed(1)} bps, max |diff| ${(1e4 * Math.max(...d1.map(Math.abs))).toFixed(1)} bps, corr ${M.corr(both.map((c) => c.stored), both.map((c) => c.guarded)).toFixed(3)}; at 4.2x the mean gap is ${usd(4.2 * ANCH * mean(d1))} per window per $100k`);
  console.log(`   stored minus Schwab RAW    : mean ${(1e4 * mean(d2)).toFixed(1)} bps, max |diff| ${(1e4 * Math.max(...d2.map(Math.abs))).toFixed(1)} bps; at 4.2x ${usd(4.2 * ANCH * mean(d2))} per window`);
  OUT.Z3 = { windows: both.length, meanStoredPct: +(100 * mean(both.map((c) => c.stored))).toFixed(4), meanSchwabRawPct: +(100 * mean(both.map((c) => c.raw))).toFixed(4), meanSchwabGuardedPct: +(100 * mean(both.map((c) => c.guarded))).toFixed(4), storedMinusGuardedBps: { mean: +(1e4 * mean(d1)).toFixed(2), sd: +(1e4 * sd(d1)).toFixed(2), maxAbs: +(1e4 * Math.max(...d1.map(Math.abs))).toFixed(1) }, rows: both.map((c) => ({ m: c.m, storedPct: +(100 * c.stored).toFixed(3), rawPct: +(100 * c.raw).toFixed(3), guardedPct: +(100 * c.guarded).toFixed(3), jumps: c.jumps })) };
  { const sep = cmp.find((c) => c.m === "2026-09"); if (sep) { console.log(`   2026-09 (the row the analyst model takes from the Schwab store): raw ${(100 * sep.raw).toFixed(3)}%, guarded ${(100 * sep.guarded).toFixed(3)}%, jump days in window ${sep.jumps}`); OUT.Z3.sep2026 = { rawPct: +(100 * sep.raw).toFixed(3), guardedPct: +(100 * sep.guarded).toFixed(3), jumps: sep.jumps }; } }

  // ---------------- Z4 real minus FINANCED proxy by calendar-month group, all 88 windows: do the gaps sit in roll months?
  const rm = await M.rmRows(inp, { asOf: "2026-09-30", fixWindow: true }), pm = {};
  rm.rows.forEach((x) => { if (x.win && x.ief != null) { const m = x.d.slice(0, 7); pm[m] = pm[m] || { g: 1, n: 0 }; pm[m].g *= 1 + 0.79 * x.ief - 0.79 * x.rf; pm[m].n++; } });
  const zw = new Map(M.znWindows().map((r) => [r.m, r.tre])), ms = Object.keys(pm).filter((m) => pm[m].n === 5 && zw.has(m) && m >= LO && m <= HI).sort();
  const gap = ms.map((m) => ({ m, g: zw.get(m) - (pm[m].g - 1 - 0.0004) }));
  const grp = { "Feb/May/Aug/Nov (first notice at month-end: the futures roll week)": ["02", "05", "08", "11"], "Mar/Jun/Sep/Dec (delivery months)": ["03", "06", "09", "12"], "Jan/Apr/Jul/Oct (no roll nearby)": ["01", "04", "07", "10"] };
  console.log(`\nZ4. REAL ZN minus FINANCED PROXY per window, ${ms.length} windows ${LO}..${HI}, by calendar-month group (3 groups looked at)`);
  OUT.Z4 = { groups: {} };
  for (const [lab, mm] of Object.entries(grp)) {
    const x = gap.filter((r) => mm.includes(r.m.slice(5, 7))).map((r) => r.g), realG = ms.filter((m) => mm.includes(m.slice(5, 7))).map((m) => zw.get(m));
    console.log(`   ${lab.padEnd(68)} n ${String(x.length).padStart(2)}  gap mean ${(1e4 * mean(x)).toFixed(1).padStart(6)} bps  sd ${(1e4 * sd(x)).toFixed(1).padStart(5)}  t ${tOf(x).toFixed(2).padStart(5)}  |  real ZN window mean ${(1e4 * mean(realG)).toFixed(1).padStart(5)} bps t ${tOf(realG).toFixed(2)} = ${(100 * 4.2 * 4 * mean(realG)).toFixed(2)} pt/yr of NAV from these 4 months`);
    OUT.Z4.groups[lab.slice(0, 15)] = { n: x.length, gapMeanBps: +(1e4 * mean(x)).toFixed(2), gapT: +tOf(x).toFixed(2), realMeanBps: +(1e4 * mean(realG)).toFixed(2), realT: +tOf(realG).toFixed(2), realPtYrNav: +(100 * 4.2 * 4 * mean(realG)).toFixed(2) };
  }
  const worst = [...gap].sort((a, b) => Math.abs(b.g) - Math.abs(a.g)).slice(0, 8);
  console.log(`   8 largest |gaps|: ${worst.map((r) => r.m + " " + (100 * r.g).toFixed(2) + "%").join(" | ")}`);
  const gsd = sd(gap.map((r) => r.g));
  console.log(`   gap sd across all ${gap.length} windows ${(1e4 * gsd).toFixed(1)} bps = ${usd(4.2 * ANCH * gsd).slice(1)} per window at 4.2x`);
  OUT.Z4.worst = worst.map((r) => ({ m: r.m, gapPct: +(100 * r.g).toFixed(3) })); OUT.Z4.gapSdBps = +(1e4 * gsd).toFixed(1);

  // ---------------- Z5 sizing levers by sub-period and at half the premium
  const py = M.pyBuild(inp, { asOf: "2026-09-30" }), px = zb[zb.length - 1].c, k5 = 5 * 1000 * px / ANCH / 4.2;
  const S110 = Object.fromEntries(Object.entries(M.PYW.E).map(([k, v]) => [k, k === "L" ? v : +(1.1 * v).toFixed(6)])), ZN5 = { ...M.PYW.E, L: 4.2 * k5 };
  const cagr = (lo, hi, w, f) => { const r = py.run(lo, hi, w), mo = {}; r.months.forEach((m) => { const L = f ? f(r.legs[m], py.TR.get(m).tb, w) : r.legs[m]; mo[m] = Object.values(L).reduce((a, b) => a + b, 0); }); return M.monthlyStats(mo); };
  const half = (L, r, w) => { const inv = w.q + w.s + w.e, h = (x, wt) => wt * r + 0.5 * (x - wt * r); return { ZN: w.L * (0.5 * (L.ZN / w.L + 0.0004) - 0.0004), EQ: h(L.EQ, inv), GLD: h(L.GLD, w.g), DBMF: h(L.DBMF, w.db), CRYPTO: h(L.CRYPTO, w.c), CASH: L.CASH }; };
  console.log("\nZ5. THE TWO SCALE-UPS BY SUB-PERIOD (change in CAGR vs Plan E inside the same period; $ per month per $100k) - 2 sub-periods + 1 haircut looked at");
  OUT.Z5 = [];
  for (const [lab, lo, hi, f] of [["2019-06..2026-09 (all 88 months)", LO, HI, null], ["2019-06..2021-12 (31 months)", LO, "2021-12", null], ["2022-01..2026-09 (57 months)", "2022-01", HI, null], ["all 88 months, every premium at HALF (risky legs excess over T-bill halved; ZN gross halved, costs paid in full)", LO, HI, half]]) {
    const e = cagr(lo, hi, M.PYW.E, f), a = cagr(lo, hi, S110, f), b = cagr(lo, hi, ZN5, f);
    const row = { period: lab, planE: e.annualReturnPct, sleeves110: +(a.annualReturnPct - e.annualReturnPct).toFixed(2), zn5: +(b.annualReturnPct - e.annualReturnPct).toFixed(2), usdSleeves: Math.round(ANCH * (a.annualReturnPct - e.annualReturnPct) / 1200), usdZn5: Math.round(ANCH * (b.annualReturnPct - e.annualReturnPct) / 1200), sharpeE: e.sharpe, sharpeS: a.sharpe, sharpeZ: b.sharpe };
    OUT.Z5.push(row);
    console.log(`   ${lab}\n      Plan E ${e.annualReturnPct}%/yr (Sharpe ${e.sharpe}) | sleeves x1.10 ${row.sleeves110 >= 0 ? "+" : ""}${row.sleeves110} pt = ${usd(row.usdSleeves)}/mo (Sharpe ${a.sharpe}) | ZN 5 contracts ${row.zn5 >= 0 ? "+" : ""}${row.zn5} pt = ${usd(row.usdZn5)}/mo (Sharpe ${b.sharpe})`);
  }

  // ---------------- Z6 R270: the as-coded writer and the direction of the bias in managed-minus-unmanaged (no forward outcome is read)
  {
    const fx = await M.rmRows(inp, { asOf: "2026-09-30", fixWindow: true, verbatim: true }), yr = fx.rows.filter((r) => r.d >= "2025-10-01" && r.d <= "2026-09-30");
    const edgeTrue = yr.filter((r) => r.edge).length, phantomRows = yr.length - edgeTrue, perDay = 0.0004 * fx.ZN_LEV / 2;
    const spur = yr.filter((r) => !r.win && r.ief != null).map((r) => fx.ZN_LEV * fx.ZN_BETA * r.ief);
    console.log("\nZ6. R270 - WHAT THE WINDOW DEFECT DOES TO managed-minus-unmanaged (arithmetic on the writer formula; the forward file managed column is not read)");
    console.log(`   2025-10-01..2026-09-30 (${yr.length} sessions): true window-edge days ${edgeTrue}; the nightly writer charges ${(1e4 * perDay).toFixed(1)} bps on EVERY row, so ${phantomRows} rows carry a phantom charge = ${(100 * phantomRows * perDay).toFixed(2)}%/yr = ${(100 * phantomRows * perDay / 12).toFixed(2)}%/month inside the risky leg`);
    console.log(`   the spurious ZN proxy on the ${spur.length} non-window rows: mean ${(1e4 * mean(spur)).toFixed(1)} bps/day, sd ${(1e4 * sd(spur)).toFixed(0)} bps/day (the window-fixed book has a daily sd of ${(1e4 * sd(yr.map((r) => r.book))).toFixed(0)} bps)`);
    console.log("   managed - unmanaged = (scale - 1) x risky + (1 - scale) x invested x T-bill, and scale <= 1 by rule (min of vol scale and drawdown scale, drawdown scale <= 1). So whenever the manager is scaled down, the phantom charge is credited to it:");
    for (const s of [0.75, 0.5]) console.log(`      scale ${s}: +${(100 * (1 - s) * phantomRows * perDay / 12).toFixed(2)}%/month in favour of managed from the phantom charge alone (${usd(ANCH * (1 - s) * phantomRows * perDay / 12)}/month per $100k of fictitious benefit), plus noise of ${(1e4 * (1 - s) * sd(spur)).toFixed(0)} bps/day`);
    console.log("   at scale 1.00 the two columns are identical and the defect cancels in the statistic; the ADOPTION gates (drawdown 20% shallower, CAGR within 10%) read the book level and cannot be interpreted on as-coded rows.");
    OUT.Z6 = { sessions: yr.length, trueEdgeDays: edgeTrue, phantomRows, phantomPctPerMonth: +(100 * phantomRows * perDay / 12).toFixed(3), biasPctPerMonthAtScale075: +(100 * 0.25 * phantomRows * perDay / 12).toFixed(3), biasPctPerMonthAtScale05: +(100 * 0.5 * phantomRows * perDay / 12).toFixed(3), spuriousSdBpsPerDay: +(1e4 * sd(spur)).toFixed(1) };
  }

  // ---------------- Z7 the month-end window table: which row is the registered rule?
  {
    const tw = JSON.parse(fs.readFileSync(M.D("profit-program/planE-tom-window.json"), "utf8")), g = (a, b) => tw.windows.find((w) => w.a === a && w.b === b), r5 = g(-4, 0), r6 = g(-5, 0), pick = g(-1, 0);
    console.log(`\nZ7. MONTH-END WINDOW TABLE. R180 registered rule = close of the 6th-to-last session through the last close (5 daily returns) = offsets [-4..0] (${r5.days} days). planE-tom-window.js labels [-5..0] (${r6.days} days) as registered.`);
    console.log(`   [-4..0] 5 days: discovery ${r5.disc.mean}%/mo t ${r5.disc.t} | holdout ${r5.hold.mean}%/mo t ${r5.hold.t} | all t ${r5.all.t}      [-5..0] 6 days: holdout ${r6.hold.mean}%/mo t ${r6.hold.t}`);
    console.log(`   discovery pick [-1..0] minus the true registered window on holdout: ${(pick.hold.mean - r5.hold.mean).toFixed(3)}%/mo x 3.318 = ${usd(3.318 * (pick.hold.mean - r5.hold.mean) * 1000)}/month per $100k (analyst line: -$411). Conclusion unchanged: do not re-cut.`);
    OUT.Z7 = { registered5day: r5, labelled6day: r6, pickMinusRegisteredUsd: Math.round(3.318 * (pick.hold.mean - r5.hold.mean) * 1000) };
  }

  // ---------------- Z8 the lever table added up (analyst figures as handed over; no new measurement)
  {
    const A = [["buildBook + Coinbase fix", 0, "defect"], ["ZN proxy financing", 0, "marking"], ["sleeves x1.10", 130, "sizing, uses the 8% JAAA buffer"], ["ZN 5 contracts", 134, "sizing, needs margin above the 12% reserve"], ["ZN cost 4 -> 2 bps", 86, "marking"], ["reserve in SGOV", 38, "already in the model and in the paper cash leg"], ["crypto fee", 0, "unknown"], ["R313 10% sleeve", 120, "uses the same 8% buffer + 2 pt of reserve"], ["R338", 0, "not read"], ["flip-only rebalance", 4, "noise"], ["crypto band", 0, "dead"], ["re-cut ZN window", 0, "dead"], ["crypto via ETFs", -9, "dead"]];
    const tot = A.reduce((s, r) => s + r[1], 0), levB = JSON.parse(fs.readFileSync(M.D("profit-program/planE-levers.json"), "utf8"));
    const markDown = -Math.round(ANCH * (levB.B.cagr.repoModel - levB.B.cagr.realZnMonthly) / 1200), markUp = 86;
    console.log(`\nZ8. THE LEVER TABLE ADDED UP: the analyst dollar column sums to ${usd(tot)}/month per $100k.`);
    console.log(`   marking items net: ZN cost if 1 tick ${usd(markUp)} (counted) vs headline-to-real-ZN ${usd(markDown)} (carried at $0) = ${usd(markUp + markDown)}/month of EXPECTATION, no dollar earned or lost by either.`);
    console.log("   cash budget: 20 pt of NAV sits outside the sleeves (JAAA 8 + ZN reserve 12). Asked for: sleeves x1.10 8 pt + R313 10 pt + reserve 12 pt + (5 contracts: more margin) = 30+ pt. Only ONE of the cash-funded levers fits.");
    OUT.Z8 = { analystSumUsd: tot, markingNetUsd: markUp + markDown };
  }

  writeJsonAtomic(M.D("profit-program/skeptic-planE-zn-instrument.json"), OUT); console.log("\nwrote backend/data/profit-program/skeptic-planE-zn-instrument.json");
})().catch((e) => { console.error("skeptic-planE-zn-instrument FAILED:", e.stack); process.exit(1); });
