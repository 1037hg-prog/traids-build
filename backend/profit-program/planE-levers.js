#!/usr/bin/env node
"use strict";
/**
 * PLAN E LEVERS - each expressed as %/yr, $ per month on a $100,000 book, and the change in drawdown. READ-ONLY on the repo; offline (cache).
 *   node backend/profit-program/planE-levers.js [A|B|C|E|H]      (no argument = all parts)
 *   A  leverage placed ONLY in the futures (ZN) leg: x1.1 / x1.2 / x1.3 and whole contracts, with the T-bill charged on the notional
 *   B  real ZN future vs the 3.3x IEF proxy: what the headline overstates
 *   C  the cash sleeve: what idle cash earns now vs T-bills / JAAA / USFR / FLOT / ICSH
 *   E  crypto leg implementation: per-switch fee, execution lag, spot vs ETF
 *   F  ZN execution cost: the model charges 4 bps of notional per round trip; what a 1-tick market would cost
 *   H  how sure: leg t-stats, haircut scenarios, 12-month dispersion (block bootstrap)
 * Model = PY family (real ZN month-end windows, monthly, the refereed 24.2 %/yr) for returns and month-end drawdown; RM family (daily, calendar window,
 * ZN financed) for the daily drawdown. $ per month = change in CAGR x $100,000 / 12 unless a part says otherwise. All in-sample: 88 months, 2019-06..2026-09.
 */
const fs = require("fs"), path = require("path");
const M = require("./planE-model.js");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const only = (process.argv[2] || "ALL").toUpperCase(), want = (p) => only === "ALL" || only === p;
const usd = (x) => (x < 0 ? "-$" : "+$") + Math.abs(Math.round(x)).toLocaleString("en-US");
const f2 = (x) => (x >= 0 ? "+" : "") + x.toFixed(2);
const mean = M.mean, sd = M.sd, ANCH = 100000;
const OUT = {};

(async () => {
  const inp = M.loadInputs(); OUT.inputsFetchedAt = inp.fetchedAt;
  const base = (o = {}) => { const py = M.pyBuild(inp, { asOf: "2026-09-30", ...o }); const r = py.run("2019-06", "2026-09", M.PYW.E); return { py, r, st: M.monthlyStats(r.mo) }; };
  const B0 = base(); const zl = M.znWindows().find((x) => x.m === "2026-09");

  // ============================================================================================== A
  if (want("A")) {
    const rm = await M.rmRows(inp, { asOf: "2026-09-30", fixWindow: true });
    const znPx = JSON.parse(fs.readFileSync(path.join(M.BACKEND, "data", "futures-daily", "ZN.json"), "utf8")).bars, px = znPx[znPx.length - 1];
    const notional = 1000 * px.c;
    console.log(`A. LEVERAGE IN THE ZN LEG ONLY (E = 4.2x NAV notional on the last 5 sessions of each month; ZN ${px.c} on ${px.d} = $${notional.toFixed(0)} per contract)`);
    console.log("   real-ZN monthly (PY) for return and month-end DD; daily DD from the repo proxy with the T-bill charged on the notional (RM, calendar window)");
    console.log("   case                       ZN x NAV  contracts@$100k  CAGR%   dCAGR   $/mo vs E   mean mo%   mo-sd%  worst mo (month)    2022%  maxDD m-end  maxDD daily(RM fin)   window loss at the -2.5pt stop");
    const cases = [["E as designed (k 1.00)", 1.0], ["k 1.10", 1.1], ["k 1.20", 1.2], ["k 1.30", 1.3]];
    const whole = [3, 4, 5, 6].map((n) => [`${n} whole contracts`, n * notional / ANCH / 4.2]);
    const rowsA = [];
    let ref = null;
    for (const [lab, k] of [...cases, ...whole]) {
      const b = base({ znScale: k }), s = b.st, d = M.dailyStats(M.rmDaily(rm.rows, { w: M.E_W, zn: 4.2 * k }, { fin: true }));
      if (!ref) ref = { s, d };
      const n = 4.2 * k * ANCH / notional, stopLoss = Math.round(n) * 2500;
      const row = { case: lab, k: +k.toFixed(3), znTimesNav: +(4.2 * k).toFixed(2), contractsExact: +n.toFixed(2), cagrPct: s.annualReturnPct, dCagrPt: +(s.annualReturnPct - ref.s.annualReturnPct).toFixed(2), usdPerMonthVsE: Math.round(ANCH * (s.annualReturnPct - ref.s.annualReturnPct) / 100 / 12), meanMoPct: s.monthlyMeanPct, moSdPct: s.monthlySdPct, worstMonth: s.worstMonth, y2022: s.years["2022"], maxDDmonthEndPct: s.maxDDmonthEndPct, maxDDdailyPct: d.maxDDdailyPct, stopLossUsd: stopLoss };
      rowsA.push(row);
      console.log(`   ${lab.padEnd(26)} ${String(row.znTimesNav).padStart(6)}x   ${String(row.contractsExact).padStart(6)}        ${String(row.cagrPct).padStart(5)}  ${f2(row.dCagrPt).padStart(6)}  ${usd(row.usdPerMonthVsE).padStart(8)}   ${String(row.meanMoPct).padStart(6)}   ${String(row.moSdPct).padStart(6)}   ${(row.worstMonth.join(" ")).padEnd(16)} ${String(row.y2022).padStart(6)}   ${String(row.maxDDmonthEndPct).padStart(8)}   ${String(row.maxDDdailyPct).padStart(10)}            ${usd(-stopLoss)} (${(-100 * stopLoss / ANCH).toFixed(1)}% of NAV)`);
    }
    // comparators: scale the OTHER legs instead of ZN (funded from the idle 20% cash; no borrowing: gross <= 96%)
    console.log("   comparators (not ZN-only): scale the sleeves / DBMF / crypto instead, ZN stays 4.2x");
    const PW = { ...M.PYW, S110: Object.fromEntries(Object.entries(M.PYW.E).map(([k, v]) => [k, k === "L" ? v : +(1.1 * v).toFixed(6)])) };
    for (const [lab, id, kk] of [["D2 = sleeves x1.25, ZN 4.2x (100% invested)", "D2", 1.25], ["sleeves x1.10, ZN 4.2x (keeps 12% reserve)", "S110", 1.1], ["D = every leg x1.2 (ZN 5.04x)", "D", 1.2]]) {
      const b = base(), r2 = b.py.run("2019-06", "2026-09", PW[id]), s2 = M.monthlyStats(r2.mo);
      const w = M.scaleW(M.E_W, kk), d = M.dailyStats(M.rmDaily(rm.rows, { w, zn: id === "D" ? 5.04 : 4.2 }, { fin: true }));
      const row = { case: lab, cagrPct: s2.annualReturnPct, dCagrPt: +(s2.annualReturnPct - ref.s.annualReturnPct).toFixed(2), usdPerMonthVsE: Math.round(ANCH * (s2.annualReturnPct - ref.s.annualReturnPct) / 100 / 12), maxDDmonthEndPct: s2.maxDDmonthEndPct, maxDDdailyPct: d.maxDDdailyPct, moSdPct: s2.monthlySdPct, y2022: s2.years["2022"] };
      rowsA.push(row);
      console.log(`   ${lab.padEnd(34)} CAGR ${String(row.cagrPct).padStart(5)}  dCAGR ${f2(row.dCagrPt).padStart(5)}  ${usd(row.usdPerMonthVsE).padStart(6)}/mo   mo-sd ${row.moSdPct}   maxDD m-end ${row.maxDDmonthEndPct}   daily ${row.maxDDdailyPct}   2022 ${row.y2022}`);
    }
    OUT.A = { notionalPerContract: notional, rows: rowsA };
    const z = M.znWindows().filter((r) => r.m >= "2019-06" && r.m <= "2026-09"), tre = z.map((r) => r.tre);
    // close-to-close window losses vs the -2.5 pt stop (2.5 / ZN price)
    const stopPct = 2.5 / px.c, hit = tre.filter((t) => t <= -stopPct).length;
    console.log(`   ZN windows 2019-06..2026-09: ${tre.length}; close-to-close window loss beyond the 2.5-pt stop (${(100 * stopPct).toFixed(2)}% of price): ${hit}; worst ${(100 * Math.min(...tre)).toFixed(2)}%; losing windows ${tre.filter((t) => t < 0).length}/${tre.length}. (intra-window lows are not in this store)`);
    // intra-window low check on the Schwab daily store (2024-08..): entry = close of the 6th-to-last session
    const byM = {}; znPx.forEach((b) => (byM[b.d.slice(0, 7)] = byM[b.d.slice(0, 7)] || []).push(b));
    let nW = 0, nStop = 0, worstLow = 0; for (const [m, bs] of Object.entries(byM)) { if (bs.length < 15 || m >= "2026-10") continue; const w = bs.slice(-5), entry = bs[bs.length - 6].c; nW++; const low = Math.min(...w.map((b) => b.l)) - entry; worstLow = Math.min(worstLow, low); if (low <= -2.5) nStop++; }
    console.log(`   Schwab daily store ${znPx[0].d}..: ${nW} complete windows with an intra-window low: ${nStop} would have touched the -2.5pt stop; worst low vs entry ${worstLow.toFixed(2)} pts`);
    OUT.A.windowsVsStop = { closeToClose: { n: tre.length, hit }, schwab: { n: nW, touched: nStop, worstLowPts: +worstLow.toFixed(2) } };
    console.log("   margin: tastytrade ZN initial margin is NOT in the repo (variants scratch used $3,000/contract = an assumption); 5 contracts need ~$15k vs the $12k reserve - confirm with a tastytrade dry-run before sizing.");
    console.log("   note: a future's price return is already net of its financing (cash behind it stays in T-bills); the 'financed' RM column charges the T-bill explicitly because the repo proxy uses IEF TOTAL return.\n");
  }

  // ============================================================================================== B
  if (want("B")) {
    const rm = await M.rmRows(inp, { asOf: "2026-09-30", fixWindow: true });
    const z = M.znWindows(), real = new Map(z.map((x) => [x.m, x.tre]));
    // proxy window return per month = compound of ZN_BETA x IEF daily over the calendar window days, less 4 bps (unfinanced) ; financed also less beta x rf per day
    const byM = {}; rm.rows.forEach((r) => { if (r.win && r.ief != null) { const m = r.d.slice(0, 7); (byM[m] = byM[m] || { g: 1, gf: 1, n: 0 }); byM[m].g *= 1 + 0.79 * r.ief; byM[m].gf *= 1 + 0.79 * r.ief - 0.79 * r.rf; byM[m].n++; } });
    const ms = Object.keys(byM).filter((m) => byM[m].n === 5 && real.has(m) && m >= "2019-06" && m <= "2026-09").sort();
    const pr = ms.map((m) => byM[m].g - 1 - 0.0004), pf = ms.map((m) => byM[m].gf - 1 - 0.0004), rl = ms.map((m) => real.get(m));
    const mp = mean(pr), mf = mean(pf), mr = mean(rl);
    console.log(`B. REAL ZN FUTURE vs THE IEF PROXY, ${ms.length} complete month-end windows 2019-06..2026-09 (unlevered per-window, then x4.2)`);
    console.log(`   mean window return: real ZN ${(100 * mr).toFixed(3)}% | proxy 0.79 x IEF (unfinanced, the repo model) ${(100 * mp).toFixed(3)}% | proxy financed ${(100 * mf).toFixed(3)}%`);
    console.log(`   correlation real vs proxy ${M.corr(rl, pr).toFixed(3)}; windows where they disagree in sign ${ms.filter((m, i) => Math.sign(rl[i]) !== Math.sign(pr[i])).length}/${ms.length}; sd real ${(100 * sd(rl)).toFixed(3)}% proxy ${(100 * sd(pr)).toFixed(3)}%`);
    const ann = (x) => 100 * 12 * 4.2 * x;
    console.log(`   at 4.2x, arithmetic %/yr of NAV: real ${ann(mr).toFixed(2)} | proxy unfinanced ${ann(mp).toFixed(2)} | proxy financed ${ann(mf).toFixed(2)}  => the headline's overstatement ${ann(mp - mr).toFixed(2)} pt/yr = ${usd(ANCH * ann(mp - mr) / 100 / 12)}/month per $100k; financing alone explains ${ann(mp - mf).toFixed(2)} pt`);
    // total plan CAGR under each
    const dRaw = M.dailyStats(M.rmDaily(rm.rows, { w: M.E_W, zn: 4.2 }, {})), dFin = M.dailyStats(M.rmDaily(rm.rows, { w: M.E_W, zn: 4.2 }, { fin: true }));
    console.log(`   Plan E CAGR: repo model ${dRaw.cagrPct}% (daily, proxy unfinanced) | proxy financed ${dFin.cagrPct}% | real-ZN monthly ${B0.st.annualReturnPct}%  -> repo headline minus real = ${(dRaw.cagrPct - B0.st.annualReturnPct).toFixed(2)} pt = ${usd(ANCH * (dRaw.cagrPct - B0.st.annualReturnPct) / 100 / 12)}/month per $100k of expectation that real ZN does not pay`);
    // by year, real vs proxy ZN leg contribution
    const yr = {}; ms.forEach((m, i) => { const y = m.slice(0, 4); yr[y] = yr[y] || { real: 0, proxy: 0, fin: 0 }; yr[y].real += 4.2 * rl[i]; yr[y].proxy += 4.2 * pr[i]; yr[y].fin += 4.2 * pf[i]; });
    console.log("   ZN leg by year (sum of monthly NAV contributions, %): " + Object.entries(yr).map(([y, v]) => `${y} real ${(100 * v.real).toFixed(1)} / proxy ${(100 * v.proxy).toFixed(1)}`).join(" | "));
    OUT.B = { windows: ms.length, meanWindowPct: { real: +(100 * mr).toFixed(4), proxyUnfinanced: +(100 * mp).toFixed(4), proxyFinanced: +(100 * mf).toFixed(4) }, corr: +M.corr(rl, pr).toFixed(3), overstatePtPerYr: +ann(mp - mr).toFixed(2), cagr: { repoModel: dRaw.cagrPct, proxyFinanced: dFin.cagrPct, realZnMonthly: B0.st.annualReturnPct } };
    console.log();
  }

  // ============================================================================================== C
  if (want("C")) {
    const tb = M.tbillByMonth(), Bars = (s) => inp.bars[s];
    const tr = (s, a, b) => { const x = Bars(s).filter((q) => q.t.slice(0, 10) >= a && q.t.slice(0, 10) <= b); return x.length > 2 ? x[x.length - 1].c / x[0].c - 1 : NaN; };
    const dd = (s, a, b) => { let pk = 0, w = 0; for (const q of Bars(s).filter((z) => z.t.slice(0, 10) >= a && z.t.slice(0, 10) <= b)) { pk = Math.max(pk, q.c); w = Math.min(w, q.c / pk - 1); } return w; };
    const a1 = "2025-10-09", a2 = "2026-10-09", b1 = "2020-10-19", b2 = "2026-10-09";
    const tbAvg = (lo, hi) => { const ms = Object.keys(tb).filter((m) => m >= lo.slice(0, 7) && m <= hi.slice(0, 7)); return mean(ms.map((m) => tb[m])); };
    const yrs = (a, b) => (Date.parse(b) - Date.parse(a)) / 365.25 / 864e5;
    console.log(`C. THE CASH SLEEVE - total return (adjusted closes) of the cash-like instruments vs the 3-month T-bill (DTB3, the model's cash rate)`);
    console.log(`   DTB3 average: trailing 12m ${(100 * tbAvg(a1, "2026-09-30")).toFixed(2)}%/yr, since ${b1} ${(100 * tbAvg(b1, "2026-09-30")).toFixed(2)}%/yr; latest DTB3 month (2026-09) ${(100 * tb["2026-09"]).toFixed(2)}%`);
    console.log("   ticker  trailing-12m %/yr   since 2020-10-19 %/yr   worst drawdown since 2020-10-19   what it is");
    const desc = { SGOV: "0-3m Treasuries (the BOOK's parking)", BIL: "1-3m Treasuries", JAAA: "AAA CLO floating (the BOOK's cash buffer, 8%)", USFR: "floating-rate Treasuries", FLOT: "IG floating-rate notes", ICSH: "ultra-short active" };
    const rowsC = {};
    for (const s of ["SGOV", "BIL", "USFR", "JAAA", "ICSH", "FLOT"]) {
      const a = tr(s, a1, a2) / yrs(a1, a2), lo = s === "SGOV" ? "2020-10-19" : b1, c = Math.pow(1 + tr(s, lo, b2), 1 / yrs(lo, b2)) - 1;
      rowsC[s] = { trailing12mPct: +(100 * a).toFixed(2), since2020_10Pct: +(100 * c).toFixed(2), worstDDPct: +(100 * dd(s, b1, b2)).toFixed(2) };
      console.log(`   ${s.padEnd(6)} ${(100 * a).toFixed(2).padStart(10)}          ${(100 * c).toFixed(2).padStart(10)}               ${(100 * dd(s, b1, b2)).toFixed(2).padStart(8)}%                  ${desc[s]}`);
    }
    const sg = rowsC.SGOV.trailing12mPct, ja = rowsC.JAAA.trailing12mPct, tb12 = 100 * tbAvg(a1, "2026-09-30");
    const hold = { JAAA: 7984, SGOV: 9950, reserve: 12000 };   // paper holdings 2026-10-09 (planE-paper-scoreboard band table: JAAA $7,984, SGOV $9,950; $12,000 reserve)
    console.log(`   dollars at the paper book's holdings (JAAA $${hold.JAAA}, SGOV $${hold.SGOV}, reserve $${hold.reserve}): JAAA over SGOV = ${(ja - sg).toFixed(2)} pt x $${hold.JAAA} = ${usd(hold.JAAA * (ja - sg) / 100)}/yr (${usd(hold.JAAA * (ja - sg) / 100 / 12)}/mo); the $12,000 reserve at ${sg.toFixed(2)}% (SGOV-equivalent) = ${usd(hold.reserve * sg / 100)}/yr (${usd(hold.reserve * sg / 100 / 12)}/mo) - and exactly $0 if the futures broker pays nothing on idle cash (NOT MEASURED: the broker's sweep rate is not in the repo)`);
    const idle = 0.30; console.log(`   at today's signals (GLD OUT) ${(100 * idle).toFixed(0)}% of NAV is cash-like: that is ${usd(ANCH * idle * sg / 100)}/yr (${usd(ANCH * idle * sg / 100 / 12)}/mo) of Plan E's paper P&L at SGOV yield - the model's CASH leg is ${B0.r.months.length ? (100 * 12 * mean(B0.r.months.map((m) => B0.r.legs[m].CASH))).toFixed(2) : "n/a"} pt/yr averaged over 2019-2026 (T-bills were ~0% for 2 of those years)`);
    // value of moving all cash-like money SGOV -> JAAA
    OUT.C = { rows: rowsC, tbill12mPct: +tb12.toFixed(2), usdPerYear: { jaaaOverSgovOn7984: Math.round(hold.JAAA * (ja - sg) / 100), reserveAtSgov: Math.round(hold.reserve * sg / 100), allCashAt_sgov: Math.round(ANCH * idle * sg / 100) } };
    console.log();
  }

  // ============================================================================================== E
  if (want("E")) {
    console.log("E. CRYPTO LEG IMPLEMENTATION (BTC 7.5% + ETH 7.5% of NAV, 50-day rule; model charges 25 bps per switch, out = T-bill)");
    const sw = (m) => { const ds = Object.keys(m).sort(); let pos = 0, n = 0; const byY = {}; for (let i = 50; i < ds.length; i++) { const on = m[ds[i]] > mean(ds.slice(i - 49, i + 1).map((d) => m[d])) ? 1 : 0; if (on !== pos) { n++; byY[ds[i].slice(0, 4)] = (byY[ds[i].slice(0, 4)] || 0) + 1; } pos = on; } return { n, byY }; };
    const sb = sw(inp.crypto.BTC), se = sw(inp.crypto.ETH), yrsN = (Date.parse("2026-09-30") - Date.parse("2019-06-01")) / 365.25 / 864e5;
    console.log(`   switches over the model window: BTC ${sb.n}, ETH ${se.n} (${((sb.n + se.n) / 2 / (Date.parse("2026-10-09") - Date.parse("2018-08-01")) * 365.25 * 864e5).toFixed(1)} per coin-year since the first signal); each is a round trip of one side at 25 bps in the model`);
    console.log("   per-switch fee      CAGR%   dCAGR vs 25 bps   $/mo per $100k   crypto leg arith %/yr");
    const rowsE = [];
    for (const bpsFee of [0, 10, 25, 50, 100]) { const b = base({ switchCost: bpsFee / 10000 }), c = 100 * 12 * mean(b.r.months.map((m) => b.r.legs[m].CRYPTO)); const ref = B0.st.annualReturnPct; rowsE.push({ feeBps: bpsFee, cagr: b.st.annualReturnPct, d: +(b.st.annualReturnPct - ref).toFixed(2), usd: Math.round(ANCH * (b.st.annualReturnPct - ref) / 100 / 12), cryptoLeg: +c.toFixed(2) });
      console.log(`   ${String(bpsFee).padStart(4)} bps         ${String(b.st.annualReturnPct).padStart(6)}   ${f2(b.st.annualReturnPct - ref).padStart(8)}          ${usd(ANCH * (b.st.annualReturnPct - ref) / 100 / 12).padStart(8)}        ${c.toFixed(2)}`); }
    console.log("   (25 bps is the model; Alpaca spot-crypto taker tiers and tastytrade's crypto fee are NOT measured here - tastytrade's number is the one to get from a planE-tasty.js --dry fee line)");
    console.log("   execution lag (days between the UTC-close signal and the position change; an ETF fills at the next US open):");
    for (const lag of [0, 1, 2]) { const b = base({ lag }), ref = B0.st.annualReturnPct; rowsE.push({ lag, cagr: b.st.annualReturnPct, d: +(b.st.annualReturnPct - ref).toFixed(2) }); console.log(`     lag ${lag}d  CAGR ${b.st.annualReturnPct}%  (${f2(b.st.annualReturnPct - ref)} pt = ${usd(ANCH * (b.st.annualReturnPct - ref) / 100 / 12)}/mo)`); }
    // hysteresis band on the 50-day line: enter above SMA x (1+b), leave below SMA x (1-b). IN-SAMPLE: 4 bands tried + the base.
    const sigN = (m, band) => { const ds = Object.keys(m).sort(); let sg = 0, n = 0; for (let i = 50; i < ds.length; i++) { const sma = mean(ds.slice(i - 49, i + 1).map((d) => m[d])), px = m[ds[i]]; const on = band ? (sg ? (px > sma * (1 - band) ? 1 : 0) : (px > sma * (1 + band) ? 1 : 0)) : (px > sma ? 1 : 0); if (on !== sg) n++; sg = on; } return n; };
    console.log("   hysteresis band around the 50-day line (4 bands + base tried, in-sample; t = paired monthly improvement vs the base at the SAME fee, 88 months):");
    console.log("   band   switches BTC+ETH   CAGR@25bps  d vs base  $/mo     CAGR@50bps  d vs base  $/mo     t(25bps)   t(50bps)");
    const bandRows = [];
    for (const band of [0, 0.01, 0.02, 0.03, 0.05]) {
      const r25 = base({ band, switchCost: 0.0025 }), r50 = base({ band, switchCost: 0.005 }), b25 = base({ switchCost: 0.0025 }), b50 = base({ switchCost: 0.005 });
      const t = (x, y) => { const ms2 = x.r.months, d = ms2.map((m) => x.r.mo[m] - y.r.mo[m]); const sdv = sd(d); return sdv > 0 ? mean(d) / (sdv / Math.sqrt(d.length)) : NaN; };
      const swn = sigN(inp.crypto.BTC, band) + sigN(inp.crypto.ETH, band);
      const row = { band, switches: swn, cagr25: r25.st.annualReturnPct, d25: +(r25.st.annualReturnPct - b25.st.annualReturnPct).toFixed(2), cagr50: r50.st.annualReturnPct, d50: +(r50.st.annualReturnPct - b50.st.annualReturnPct).toFixed(2), t25: +t(r25, b25).toFixed(2), t50: +t(r50, b50).toFixed(2) };
      bandRows.push(row);
      console.log(`   ${(100 * band).toFixed(0).padStart(3)}%   ${String(swn).padStart(10)}         ${String(row.cagr25).padStart(6)}    ${f2(row.d25).padStart(6)}  ${usd(ANCH * row.d25 / 100 / 12).padStart(6)}     ${String(row.cagr50).padStart(6)}    ${f2(row.d50).padStart(6)}  ${usd(ANCH * row.d50 / 100 / 12).padStart(6)}     ${isNaN(row.t25) ? "  -" : String(row.t25).padStart(6)}     ${isNaN(row.t50) ? "  -" : String(row.t50).padStart(6)}`);
    }
    rowsE.push({ bandRows });
    // spot vs spot-ETF measured: IBIT / ETHA / FBTC total return vs spot over their common history
    const spot = (coin, a, b) => { const m = inp.crypto[coin], ks = Object.keys(m).filter((d) => d >= a && d <= b).sort(); return m[ks[ks.length - 1]] / m[ks[0]] - 1; };
    const etf = (s, a, b) => { const x = inp.bars[s].filter((q) => q.t.slice(0, 10) >= a && q.t.slice(0, 10) <= b); return x[x.length - 1].c / x[0].c - 1; };
    const win = [["IBIT", "BTC", "2024-01-12"], ["FBTC", "BTC", "2024-01-12"], ["ETHA", "ETH", "2024-07-24"]];
    console.log("   spot-ETF vs spot, same dates (ETF adjusted close; the gap is expense + premium/discount + the 4pm-vs-00:00-UTC mark):");
    for (const [e, c, a] of win) { const b = "2026-10-08", te = etf(e, a, b), ts = spot(c, a, b), yy = (Date.parse(b) - Date.parse(a)) / 365.25 / 864e5; rowsE.push({ etf: e, from: a, etfPct: +(100 * te).toFixed(1), spotPct: +(100 * ts).toFixed(1) }); console.log(`     ${e} vs ${c}: ${(100 * te).toFixed(1)}% vs ${(100 * ts).toFixed(1)}% over ${yy.toFixed(2)}y  (gap ${(100 * (te - ts)).toFixed(1)} pt; advertised expense 0.25%/yr is NOT in the repo - treat as an input to confirm)`); }
    // ETF route cost: 0.25%/yr on the 15% held when ON, plus 1-day lag; approximate as lag 1 and -0.25% x on-share x 15%
    const b1 = base({ lag: 1 }); const onShare = (() => { let on = 0, tot = 0; for (const coin of ["BTC", "ETH"]) { const m = inp.crypto[coin], ds = Object.keys(m).sort(); for (let i = 50; i < ds.length; i++) { if (ds[i] < "2019-06-01" || ds[i] > "2026-09-30") continue; tot++; if (m[ds[i]] > mean(ds.slice(i - 49, i + 1).map((d) => m[d]))) on++; } } return on / tot; })();
    const etfCagr = b1.st.annualReturnPct - 0.25 * 0.15 * onShare;
    console.log(`   ETF route (1-day lag, 0.25%/yr expense on the 15% while held; held ${(100 * onShare).toFixed(0)}% of days): CAGR ~${etfCagr.toFixed(2)}% = ${f2(etfCagr - B0.st.annualReturnPct)} pt vs the model's spot sleeve = ${usd(ANCH * (etfCagr - B0.st.annualReturnPct) / 100 / 12)}/mo. It trades only 09:30-16:00 ET, which the 24/7 UTC-close rule does not need; its edge is a lower per-switch cost than spot taker fees if those exceed ~25 bps.`);
    OUT.E = { rows: rowsE, switches: { BTC: sb.n, ETH: se.n }, onSharePct: +(100 * onShare).toFixed(1) };
    console.log();
  }

  // ============================================================================================== F
  if (want("F")) {
    const znPx = JSON.parse(fs.readFileSync(path.join(M.BACKEND, "data", "futures-daily", "ZN.json"), "utf8")).bars, px = znPx[znPx.length - 1].c, notional = 1000 * px;
    const n = 4, tick = 1000 / 64, feeSide = 2.5;       // 4 contracts at $100k; ZN tick 1/64 pt = $15.625; R219 assumes $2.50 per contract per side
    const model = 0.0004 * 4.2 * ANCH, oneTick = n * tick * 1 + n * feeSide * 2, twoTick = n * tick * 2 + n * feeSide * 2;
    console.log("F. ZN EXECUTION COST (entry at the ask, exit at the bid; 4 contracts at $100k; the model charges 4 bps of notional per round trip)");
    console.log(`   model: 4 bps x 4.2 x $100,000 = ${model.toFixed(0)} per window.  1-tick-wide market: ${n} x ${tick.toFixed(3)} + ${n} x 2 sides x ${feeSide} = ${oneTick.toFixed(1)} per window (${(1e4 * oneTick / (n * notional)).toFixed(2)} bps of notional); 2-tick-wide: ${twoTick.toFixed(1)} (${(1e4 * twoTick / (n * notional)).toFixed(2)} bps)`);
    console.log("   round-trip cost (bps of notional)   CAGR%   dCAGR vs model   $/mo per $100k");
    const rowsF = [];
    for (const c of [0, 1.5, 2.0, 4, 6, 8]) {
      const zr = M.znWindows().map((r) => ({ ...r, tre: r.tre + 0.0004 - c / 1e4 })), b = base({ znRows: zr }), d = b.st.annualReturnPct - B0.st.annualReturnPct;
      rowsF.push({ costBps: c, cagr: b.st.annualReturnPct, d: +d.toFixed(2), usd: Math.round(ANCH * d / 100 / 12) });
      console.log(`   ${String(c).padStart(8)}${c === 4 ? " (model)" : "        "}                    ${String(b.st.annualReturnPct).padStart(6)}   ${f2(d).padStart(8)}        ${usd(ANCH * d / 100 / 12).padStart(7)}`);
    }
    console.log(`   so: if the close-arm market is 1 tick wide the model overcharges ZN by ~${(model - oneTick).toFixed(0)} per window = ${usd(model - oneTick)}/month per $100k; the live spread at 15:35-15:48 ET is NOT measured in the repo (R219 records ask and bid per window - its forward record is the place to read it, after its own read date).`);
    OUT.F = { modelUsdPerWindow: +model.toFixed(1), oneTickUsdPerWindow: +oneTick.toFixed(1), twoTickUsdPerWindow: +twoTick.toFixed(1), rows: rowsF };
    console.log();
  }

  // ============================================================================================== H
  if (want("H")) {
    console.log("H. HOW SURE (in-sample 88 months; PY real-ZN model)");
    const ms = Object.keys(B0.r.legs).sort(), n = ms.length, rf = ms.map((m) => B0.py.TR.get(m).tb);
    console.log("   leg        mean %/mo   sd %/mo   t (mean/se, monthly)   share of 24.3% CAGR (arith pt/yr)");
    const legT = {};
    for (const k of ["ZN", "EQ", "GLD", "DBMF", "CRYPTO"]) { const x = ms.map((m) => B0.r.legs[m][k]), t = mean(x) / (sd(x) / Math.sqrt(n)); legT[k] = +t.toFixed(2); console.log(`   ${k.padEnd(8)} ${(100 * mean(x)).toFixed(3).padStart(8)}   ${(100 * sd(x)).toFixed(3).padStart(8)}   ${t.toFixed(2).padStart(10)}              ${(100 * 12 * mean(x)).toFixed(2)}`); }
    const tot = ms.map((m) => B0.r.mo[m]), ex = tot.map((x, i) => x - rf[i]);
    console.log(`   TOTAL    ${(100 * mean(tot)).toFixed(3).padStart(8)}   ${(100 * sd(tot)).toFixed(3).padStart(8)}   ${(mean(ex) / (sd(ex) / Math.sqrt(n))).toFixed(2).padStart(10)} (excess over T-bill)   months up ${tot.filter((x) => x > 0).length}/${n}`);
    // haircut scenarios (CAGR recomputed from monthly series with a leg replaced)
    const sc = (label, f) => { const mo = {}; ms.forEach((m, i) => { const L = B0.r.legs[m]; mo[m] = f(L, rf[i]); }); const s = M.monthlyStats(mo); console.log(`   ${label.padEnd(58)} CAGR ${String(s.annualReturnPct).padStart(6)}%  maxDD ${String(s.maxDDmonthEndPct).padStart(6)}%  ${usd(ANCH * s.annualReturnPct / 100 / 12)}/mo`); return s; };
    console.log("   scenarios (what Plan E would have paid if a leg had not delivered what 2019-2026 gave it):");
    const s0 = sc("as built", (L) => L.ZN + L.EQ + L.GLD + L.DBMF + L.CRYPTO + L.CASH);
    const s1 = sc("crypto leg earns only the T-bill (BTC/ETH trend pays 0)", (L, r) => L.ZN + L.EQ + L.GLD + L.DBMF + 0.15 * r + L.CASH);
    const s2 = sc("crypto leg at half its 2019-2026 return", (L) => L.ZN + L.EQ + L.GLD + L.DBMF + 0.5 * L.CRYPTO + L.CASH);
    const s3 = sc("ZN overlay earns 0 (month-end effect gone)", (L) => L.EQ + L.GLD + L.DBMF + L.CRYPTO + L.CASH);
    const s4 = sc("both crypto at half and ZN at half", (L) => 0.5 * L.ZN + L.EQ + L.GLD + L.DBMF + 0.5 * L.CRYPTO + L.CASH);
    const s5 = sc("neither leg: sleeves + DBMF + cash only", (L, r) => L.EQ + L.GLD + L.DBMF + 0.15 * r + L.CASH);
    // block bootstrap of 12-month return (3-month blocks), 10,000 draws
    let seed = 20261010; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const draws = 10000, out12 = [];
    for (let d = 0; d < draws; d++) { let g = 1, k = 0; while (k < 12) { const st = Math.floor(rnd() * (n - 2)); for (let j = 0; j < 3 && k < 12; j++, k++) g *= 1 + tot[st + j]; } out12.push(g - 1); }
    out12.sort((a, b) => a - b); const q = (p) => out12[Math.floor(p * (draws - 1))];
    console.log(`   12-month return, 3-month block bootstrap of the 88 months (${draws} draws, in-sample dispersion - optimistic because the sample is a bull run for the crypto leg): p5 ${(100 * q(0.05)).toFixed(1)}%  p25 ${(100 * q(0.25)).toFixed(1)}%  median ${(100 * q(0.5)).toFixed(1)}%  p75 ${(100 * q(0.75)).toFixed(1)}%  p95 ${(100 * q(0.95)).toFixed(1)}%;  P(12m < 0) ${(100 * out12.filter((x) => x < 0).length / draws).toFixed(1)}%  => on $100k: p5 ${usd(ANCH * q(0.05))}  median ${usd(ANCH * q(0.5))}  p95 ${usd(ANCH * q(0.95))}`);
    OUT.H = { legT, scenarios: { asBuilt: s0.annualReturnPct, cryptoZero: s1.annualReturnPct, cryptoHalf: s2.annualReturnPct, znZero: s3.annualReturnPct, bothHalf: s4.annualReturnPct, neither: s5.annualReturnPct }, bootstrap12m: { p5: +(100 * q(0.05)).toFixed(2), p50: +(100 * q(0.5)).toFixed(2), p95: +(100 * q(0.95)).toFixed(2), pNeg: +(100 * out12.filter((x) => x < 0).length / draws).toFixed(2) } };
    console.log();
  }
  writeJsonAtomic(path.join(M.BACKEND, "data", "profit-program", "planE-levers" + (only === "ALL" ? "" : "-" + only) + ".json"), OUT);
  console.log("wrote backend/data/profit-program/planE-levers" + (only === "ALL" ? "" : "-" + only) + ".json");
})().catch((e) => { console.error("planE-levers FAILED:", e.stack); process.exit(1); });
