#!/usr/bin/env node
/**
 * SHORT-LEG, SKEPTIC CHECKS on lane 2 (backend/short-leg/short-leg.js). READ-ONLY, IN-SAMPLE, EXPLORATORY.
 * Loads short-leg.js's OWN engine (its source, minus the final main() call) so every number here comes from the same leg engine,
 * the same caches and the same rules; nothing is re-implemented except what is new (next-open daily book, entry filters, dividends).
 *   node backend/short-leg/skeptic-checks.js      -> prints, writes backend/data/short-leg/skeptic-checks.json (atomic)
 * NEW VARIANTS TRIED HERE (count them): 2 entry filters on the dip-buy book (F1 SPY above its 200-day, F2 the ETF above its own 200-day)
 * and 1 non-short mirror (long SPY+QQQ only above the 200-day). No other variant was run.
 */
"use strict";
const fs = require("fs"), path = require("path"), Module = require("module");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const FILE = path.join(__dirname, "short-leg.js");
let src = fs.readFileSync(FILE, "utf8").replace(/^#!.*\r?\n/, "");
if (!/\r?\nmain\(\);\s*$/.test(src)) throw new Error("short-leg.js no longer ends with main(); refusing");
src = src.replace(/\r?\nmain\(\);\s*$/, "\n") + "\nmodule.exports = { book, metrics, runAll, shortS1, shortS2, shortS3, shortS4, shortS5, shortS6, longR313, longR328, SPY, QQQ, SECT, CALD, NC, RS, WORST, NW, worstIdx, EPISODES, sma, calIdx, dayNum, MKEY, monthlySum, STAKE, START, END, YEARS, BASE_CARRY, mean, corr, clusterT, drawdown, topDrawdowns, A13, A28, idxLE, SIDE_US };\n";
const m = new Module(FILE, module); m.filename = FILE; m.paths = Module._nodeModulePaths(path.dirname(FILE)); m._compile(src, FILE);
const E = m.exports, { NC, CALD, RS, WORST, NW, worstIdx, STAKE, START, END, YEARS, MKEY, calIdx, mean } = E;
const r0 = (x) => (Number.isFinite(x) ? Math.round(x) : null), r2 = (x) => (Number.isFinite(x) ? +x.toFixed(2) : null), r3 = (x) => (Number.isFinite(x) ? +x.toFixed(3) : null);
const sum = (a) => { let s = 0; for (const x of a) s += x; return s; };
const sd = (a) => { const mu = mean(a); return Math.sqrt(sum(a.map((x) => (x - mu) ** 2)) / (a.length - 1)); };
const OUT = { spec: "short-leg-skeptic-v1", asOf: new Date().toISOString(), command: "node backend/short-leg/skeptic-checks.js", note: "IN-SAMPLE, EXPLORATORY, READ-ONLY. Engine = short-leg.js's own source. New variants tried: 2 dip-book entry filters + 1 trend-filtered long mirror." };

function lite(daily, set = WORST, nSet = NW) {
  let sw = 0, so = 0, no = 0, tot = 0; for (let i = 0; i < NC; i++) { tot += daily[i]; if (set[i]) sw += daily[i]; else { so += daily[i]; no++; } }
  const ms = [...E.monthlySum(daily).values()], dd = E.drawdown(daily);
  return { perYearUsd: r0(tot / YEARS), onWorstDaysUsd: r0(sw / nSet), onOtherDaysUsd: r2(so / no), tMonth: r2(E.clusterT(Array.from(daily), MKEY)), sharpeMonthly: r2(mean(ms) / sd(ms) * Math.sqrt(12)), maxDrawdownUsd: r0(dd.usd), ddPeak: dd.peak, ddTrough: dd.trough, worstDayUsd: r0(Math.min(...daily)), worstMonthUsd: r0(Math.min(...ms)) };
}
const add = (a, b, wa = 1, wb = 1) => Float64Array.from(a, (v, i) => wa * v + wb * b[i]);
function liteEra(daily, a, b) { let tot = 0, sw = 0, nw = 0, n = 0; const ms = new Map(); for (let i = 0; i < NC; i++) { if (CALD[i] < a || CALD[i] > b) continue; n++; tot += daily[i]; if (WORST[i]) { sw += daily[i]; nw++; } ms.set(MKEY[i], (ms.get(MKEY[i]) || 0) + daily[i]); }
  const v = [...ms.values()]; let cum = 0, pk = 0, dd = 0; for (let i = 0; i < NC; i++) { if (CALD[i] < a || CALD[i] > b) continue; cum += daily[i]; if (cum > pk) pk = cum; if (cum - pk < dd) dd = cum - pk; }
  return { perYearUsd: r0(tot / (n / 252)), worstDays: nw, onWorstDaysUsd: nw ? r0(sw / nw) : null, sharpeMonthly: r2(mean(v) / sd(v) * Math.sqrt(12)), maxDrawdownUsd: r0(dd) }; }

// A. reproduce lane 2
const base = E.runAll(E.BASE_CARRY), B = base.B, KS = ["S1", "S2", "S3", "S4", "S6"];
const saved = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "short-leg", "short-leg.json"), "utf8"));
OUT.reproduction = {}; let okAll = true;
for (const k of ["r313", "r328", "dip", "S1", "S2", "S3", "S4", "S5", "S6"]) { const mine = lite(B[k].daily), want = saved.standalone[k]; const ok = Math.abs(mine.perYearUsd - want.perYearUsd) < 1 && Math.abs(mine.onWorstDaysUsd - want.onWorstDaysUsd) < 1; okAll = okAll && ok; OUT.reproduction[k] = { mine: [mine.perYearUsd, mine.onWorstDaysUsd], saved: [want.perYearUsd, want.onWorstDaysUsd], ok }; }
console.log("A. REPRODUCTION of short-leg.json standalone ($/yr, worst-day avg):", okAll ? "ALL MATCH" : "MISMATCH", JSON.stringify(OUT.reproduction));
if (!okAll) process.exit(3);

// B. is the worst-day gain timing, or just being short on average?
const meanWorstRet = mean(worstIdx.map((i) => RS[i]));
OUT.exposureBenchmark = { note: "constant short of the rule's own AVERAGE net exposure, SPY-proxy dollars per worst day; ratio > 1 = the rule is short more than usual going into worst days, < 1 = less", meanWorstDayReturnPct: r3(100 * meanWorstRet) };
console.log("\nB. WORST-DAY GAIN vs A CONSTANT SHORT OF THE SAME AVERAGE SIZE (SPY-proxy $ per worst day)");
for (const k of KS) { const ex = B[k].expo, avg = mean(Array.from(ex)), constUsd = avg * meanWorstRet, obs = mean(worstIdx.map((i) => ex[Math.max(0, i - 1)] * RS[i]));
  let none = 0; for (const i of worstIdx) { if (Math.abs(ex[Math.max(0, i - 1)]) < 1) none++; }
  OUT.exposureBenchmark[k] = { avgNetExposureUsd: r0(avg), constantShortWorstDayUsd: r0(constUsd), ruleProxyWorstDayUsd: r0(obs), ratio: r2(obs / constUsd), worstDaysWithNoPosition: none, worstDays: NW };
  console.log(` ${k}: avg exposure ${r0(avg)}  constant-short ${r0(constUsd)}  rule ${r0(obs)}  ratio ${r2(obs / constUsd)}  worst days with NO position ${none}/${NW}`); }

// C. next-open fills as a DAILY series (the lane gave trade totals only)
function bookNO(legs, carryRate) {
  const daily = new Float64Array(NC);
  for (const L of legs) { const { A, t, dir, slot } = L, d = A.d, c = A.c, o = A.o, dn = A.dn, te = t + 1; if (te >= A.n || d[te] < START || d[te] > END) continue;
    const shares = slot / o[te], ps = L.perSide; let gi = calIdx(d[te]);
    if (gi >= 0) { daily[gi] += dir * shares * (c[te] - o[te]); if (!L.noEntryCost) daily[gi] -= slot * ps; }
    const last = L.u < 0 ? A.n - 1 : L.u;
    for (let k = te + 1; k <= last; k++) { if (d[k] > END) break; gi = calIdx(d[k]); let p = dir * shares * (c[k] - c[k - 1]); if (dir < 0 && carryRate > 0) p -= carryRate * shares * c[k - 1] * (dn[k] - dn[k - 1]) / 365; if (gi >= 0) daily[gi] += p; }
    if (L.u >= 0 && L.u + 1 < A.n && d[L.u + 1] <= END) { const x = L.u + 1; gi = calIdx(d[x]); let p = dir * shares * (o[x] - c[L.u]); if (dir < 0 && carryRate > 0) p -= carryRate * shares * c[L.u] * (dn[x] - dn[L.u]) / 365; if (gi >= 0) { daily[gi] += p; if (!L.noExitCost) daily[gi] -= shares * o[x] * ps; } } }
  return daily;
}
const CARRY = E.BASE_CARRY.borrow + E.BASE_CARRY.div, LEGS = { S1: E.shortS1(), S2: E.shortS2(), S3: E.shortS3(), S4: E.shortS4(), S6: E.shortS6() };
OUT.nextOpenDaily = { note: "signal at close t, fill at the open of t+1 (entry and exit); same costs and 2.5%/yr carry" };
console.log("\nC. NEXT-OPEN FILLS, daily series   close-fill [$/yr, worst-day avg, t]  ->  next-open [$/yr, worst-day avg, t]");
const NO = {};
for (const k of KS) { NO[k] = bookNO(LEGS[k], CARRY); const a = lite(B[k].daily), b = lite(NO[k]); OUT.nextOpenDaily[k] = { closeFill: a, nextOpen: b }; console.log(` ${k}: ${a.perYearUsd} / ${a.onWorstDaysUsd} / ${a.tMonth}   ->   ${b.perYearUsd} / ${b.onWorstDaysUsd} / ${b.tMonth}`); }

// D. the hedge, attributed: what S3 itself adds vs what holding less dip-buy adds
const dip = B.dip.daily, T = {};
T["dip-buy 100%"] = lite(dip); T["dip-buy 80% + 20% cash"] = lite(add(dip, dip, 0.8, 0));
for (const k of ["S2", "S3", "S4"]) { T[`dip 80% + ${k} 20% (their carve)`] = lite(add(dip, B[k].daily, 0.8, 0.2)); T[`dip 100% + ${k} 20% (120% gross)`] = lite(add(dip, B[k].daily, 1, 0.2)); }
T["dip 100% + S3 20%, S3 at NEXT-OPEN fills"] = lite(add(dip, NO.S3, 1, 0.2));
OUT.hedgeAttribution = T;
console.log("\nD. HEDGE ATTRIBUTION                              $/yr | worst-day avg | maxDD | Sharpe(monthly) | t | worst day | worst month");
for (const [k, v] of Object.entries(T)) console.log(` ${k.padEnd(44)} ${String(v.perYearUsd).padStart(6)} ${String(v.onWorstDaysUsd).padStart(7)} ${String(v.maxDrawdownUsd).padStart(8)} ${String(v.sharpeMonthly).padStart(6)} ${String(v.tMonth).padStart(6)} ${String(v.worstDayUsd).padStart(8)} ${String(v.worstMonthUsd).padStart(8)}  DD ${v.ddPeak}..${v.ddTrough}`);
OUT.hedgeByHalf = {}; console.log("   by half (2000-01..2013-05 | 2013-05..2026-09 | since 2009-03-10): $/yr, worst-day avg, Sharpe, maxDD");
for (const [lab, d] of [["dip-buy 100%", dip], ["dip 100% + S3 20%", add(dip, B.S3.daily, 1, 0.2)], ["dip 80% + S3 20%", add(dip, B.S3.daily, 0.8, 0.2)], ["S3 alone 100%", B.S3.daily]]) { const h1 = liteEra(d, "2000-01-01", "2013-05-16"), h2 = liteEra(d, "2013-05-17", "2026-12-31"), post = liteEra(d, "2009-03-10", "2026-12-31"); OUT.hedgeByHalf[lab] = { firstHalf: h1, secondHalf: h2, since2009_03_10: post }; console.log(`   ${lab.padEnd(20)} ${JSON.stringify(h1)} | ${JSON.stringify(h2)} | ${JSON.stringify(post)}`); }

// E. S3: concentration of its worst-day dollars, whipsaw, crash anatomy
{ const d = B.S3.daily, ep = E.EPISODES.map((e) => ({ from: CALD[e[0]], to: CALD[e[e.length - 1]], days: e.length, usd: sum(e.map((i) => d[i])) })).sort((a, b) => b.usd - a.usd), tot = sum(ep.map((x) => x.usd));
  const top = ep.slice(0, 4), closed = B.S3.trades.filter((t) => !t.open), wins = closed.filter((t) => t.netUsd > 0);
  const win = (a, b) => { let s = 0; for (let i = 0; i < NC; i++) if (CALD[i] >= a && CALD[i] <= b) s += d[i]; return r0(s); };
  const roll = (n) => { let w = 0, at = null, s = 0; for (let i = 0; i < NC; i++) { s += d[i]; if (i >= n) s -= d[i - n]; if (i >= n - 1 && s < w) { w = s; at = CALD[i]; } } return { usd: r0(w), ending: at }; };
  OUT.s3Anatomy = { worstDayDollarsTotal: r0(tot), episodes: ep.length, episodesPositive: ep.filter((x) => x.usd > 0).length, episodesExactlyZero: ep.filter((x) => x.usd === 0).length, top4Episodes: top.map((x) => ({ ...x, usd: r0(x.usd), share: r3(x.usd / tot) })), top4Share: r3(sum(top.map((x) => x.usd)) / tot),
    trades: closed.length, winners: wins.length, winnersUsd: r0(sum(wins.map((t) => t.netUsd))), losersUsd: r0(sum(closed.filter((t) => t.netUsd <= 0).map((t) => t.netUsd))), top5WinnersUsd: closed.slice().sort((a, b) => b.netUsd - a.netUsd).slice(0, 5).map((t) => `${t.sym} ${t.entryDate}..${t.exitDate} ${r0(t.netUsd)}`),
    covid_2020_02_19_to_2020_03_23: win("2020-02-19", "2020-03-23"), covid_2020_03_24_to_2020_12_31: win("2020-03-24", "2020-12-31"), year2020: win("2020-01-01", "2020-12-31"), bear2022: win("2022-01-01", "2022-12-31"), year2023: win("2023-01-01", "2023-12-31"), since_2009_03_10: win("2009-03-10", "2026-12-31"),
    worstSingleDay: (() => { let w = 0, at = null; for (let i = 0; i < NC; i++) if (d[i] < w) { w = d[i]; at = CALD[i]; } return { usd: r0(w), date: at }; })(), worst5Sessions: roll(5), worst21Sessions: roll(21), worst63Sessions: roll(63), worst252Sessions: roll(252) };
  console.log("\nE. S3 ANATOMY (standalone $100k; divide by 5 for the 20% size)"); console.log(JSON.stringify(OUT.s3Anatomy, null, 1)); }

// F. what the lane did not try: the dip-buy book itself, flat below the 200-day (no short at all)
{ const smaSPY = E.sma(E.SPY.c, 200), own = new Map();
  const spyAbove = (date) => { const i = E.SPY.map.has(date) ? E.SPY.map.get(date) : E.idxLE(E.SPY, date); return i >= 0 && Number.isFinite(smaSPY[i]) && E.SPY.c[i] > smaSPY[i]; };
  const ownAbove = (L) => { if (!own.has(L.A)) own.set(L.A, E.sma(L.A.c, 200)); const s = own.get(L.A)[L.t]; return Number.isFinite(s) && L.A.c[L.t] > s; };
  const l13 = E.longR313().legs, l28 = E.longR328().legs, mk = (f) => { const a = E.book(l13.filter(f), 0, 1), b = E.book(l28.filter(f), 0, 1); return { daily: add(a.daily, b.daily, 0.5, 0.5), n13: a.trades.length, n28: b.trades.length, expo: add(a.expo, b.expo, 0.5, 0.5) }; };
  const all = mk(() => true), F1 = mk((L) => spyAbove(L.A.d[L.t])), F2 = mk(ownAbove), below = mk((L) => !spyAbove(L.A.d[L.t]));
  const rows = { "dip-buy as sealed (no filter)": all, "F1 entries only when SPY closed above its 200-day": F1, "F2 entries only when the ETF closed above its own 200-day": F2, "(the entries F1 removes: SPY below its 200-day)": below };
  OUT.dipBookTrendFilter = { note: "entry filter known at the entry close (same-close convention as the sealed rules); open positions run to their normal exit; slot sizes unchanged, unused capital in cash at 0%", rows: {} };
  console.log("\nF. DIP-BUY BOOK WITH A 200-DAY ENTRY FILTER (no short)        trades313/328 | $/yr | worst-day avg | maxDD | Sharpe | t | avg exposure %");
  for (const [k, v] of Object.entries(rows)) { const L = lite(v.daily); L.trades = [v.n13, v.n28]; L.avgExposurePct = r2(100 * mean(Array.from(v.expo)) / STAKE); L.h1 = liteEra(v.daily, "2000-01-01", "2013-05-16"); L.h2 = liteEra(v.daily, "2013-05-17", "2026-12-31"); OUT.dipBookTrendFilter.rows[k] = L;
    console.log(` ${k.padEnd(56)} ${v.n13}/${v.n28} ${String(L.perYearUsd).padStart(6)} ${String(L.onWorstDaysUsd).padStart(7)} ${String(L.maxDrawdownUsd).padStart(8)} ${String(L.sharpeMonthly).padStart(5)} ${String(L.tMonth).padStart(6)} ${String(L.avgExposurePct).padStart(6)}  h1 ${L.h1.perYearUsd}/${L.h1.sharpeMonthly} h2 ${L.h2.perYearUsd}/${L.h2.sharpeMonthly}  DD ${L.ddPeak}..${L.ddTrough}`); }
  const a = lite(all.daily), per = (x) => r2((a.perYearUsd - x.perYearUsd) / (x.onWorstDaysUsd - a.onWorstDaysUsd));
  OUT.dipBookTrendFilter.incomeGivenUpPerDollarOfWorstDayLossRemoved = { "80% dip + 20% cash": per(lite(add(dip, dip, 0.8, 0))), "100% dip + 20% S3": per(lite(add(dip, B.S3.daily, 1, 0.2))), "80% dip + 20% S3": per(lite(add(dip, B.S3.daily, 0.8, 0.2))), F1: per(lite(F1.daily)), F2: per(lite(F2.daily)) };
  console.log("   $/yr of income given up per $1 of average worst-day loss removed:", JSON.stringify(OUT.dipBookTrendFilter.incomeGivenUpPerDollarOfWorstDayLossRemoved)); }

// G. the non-short mirror of S3: long SPY+QQQ only above the 200-day (what a trend rule already does)
{ const legs = []; for (const [s, A] of [["SPY", E.SPY], ["QQQ", E.QQQ]]) { const mm = E.sma(A.c, 200); let pos = null; for (let i = 0; i < A.n; i++) { if (A.d[i] < START) continue; const cond = Number.isFinite(mm[i]) && A.c[i] >= mm[i]; if (cond && pos === null) pos = i; else if (!cond && pos !== null) { legs.push({ sym: s, A, t: pos, u: i, dir: 1, slot: STAKE / 2, perSide: E.SIDE_US }); pos = null; } } if (pos !== null) legs.push({ sym: s, A, t: pos, u: -1, dir: 1, slot: STAKE / 2, perSide: E.SIDE_US }); }
  const bh = []; for (const [s, A] of [["SPY", E.SPY], ["QQQ", E.QQQ]]) { let t0 = 0; while (A.d[t0] < START) t0++; bh.push({ sym: s, A, t: t0, u: -1, dir: 1, slot: STAKE / 2, perSide: E.SIDE_US }); }
  const tf = E.book(legs, 0, 1), hold = E.book(bh, 0, 1);
  OUT.trendFilteredLong = { note: "price only, no dividends credited, cash at 0%; $50k per ETF re-struck at each entry for the filtered book, fixed shares from 2000-01-03 for buy-and-hold, so the two are not the same dollar size after 2000 (read the filtered row against S3, not against buy-and-hold)", buyAndHoldFixedShares: lite(hold.daily), longOnlyAboveOwn200day: lite(tf.daily), s3ForReference: lite(B.S3.daily) };
  console.log("\nG. NON-SHORT MIRROR  $/yr | worst-day avg | maxDD | Sharpe"); for (const [k, v] of Object.entries(OUT.trendFilteredLong)) if (v && v.perYearUsd !== undefined) console.log(` ${k.padEnd(28)} ${v.perYearUsd} ${v.onWorstDaysUsd} ${v.maxDrawdownUsd} ${v.sharpeMonthly}`); }

// H. "pays when the rest lose": the dip book's OWN worst days and worst months, not SPY's
{ const ord = Array.from({ length: NC }, (_, i) => i).sort((a, b) => dip[a] - dip[b]), OWN = new Uint8Array(NC); for (let i = 0; i < NW; i++) OWN[ord[i]] = 1; let overlap = 0; for (let i = 0; i < NC; i++) if (OWN[i] && WORST[i]) overlap++;
  const mDip = E.monthlySum(dip), keys = [...mDip.keys()].sort(), nM = Math.ceil(0.10 * keys.length), wM = keys.slice().sort((a, b) => mDip.get(a) - mDip.get(b)).slice(0, nM);
  OUT.ownWorst = { days: NW, overlapWithSpyWorstDays: overlap, dipBookOnItsOwnWorstDaysUsd: r0(mean(ord.slice(0, NW).map((i) => dip[i]))), months: nM, dipBookOnItsWorstMonthsUsd: r0(mean(wM.map((k) => mDip.get(k)))), worstMonths: wM.slice(0, 8).map((k) => `${k} ${r0(mDip.get(k))}`), rules: {} };
  console.log(`\nH. THE DIP BOOK'S OWN worst ${NW} days (overlap with SPY's worst days: ${overlap}) and worst ${nM} months; rule at 100% of $100k`);
  console.log(`   dip book itself: ${OUT.ownWorst.dipBookOnItsOwnWorstDaysUsd} per own-worst day, ${OUT.ownWorst.dipBookOnItsWorstMonthsUsd} per worst month; worst months ${OUT.ownWorst.worstMonths.join(", ")}`);
  for (const k of ["S1", "S2", "S3", "S4", "S5", "S6"]) { const d = B[k].daily, mm = E.monthlySum(d), v = wM.map((x) => mm.get(x)); OUT.ownWorst.rules[k] = { perOwnWorstDayUsd: r0(mean(ord.slice(0, NW).map((i) => d[i]))), perWorstMonthUsd: r0(mean(v)), worstMonthsPositive: v.filter((x) => x > 0).length, corrMonthlyWithDip: r3(E.corr(keys.map((x) => mm.get(x)), keys.map((x) => mDip.get(x)))) };
    console.log(`   ${k}: ${OUT.ownWorst.rules[k].perOwnWorstDayUsd} per own-worst day | ${OUT.ownWorst.rules[k].perWorstMonthUsd} per worst month, positive in ${OUT.ownWorst.rules[k].worstMonthsPositive}/${nM} | monthly corr with dip ${OUT.ownWorst.rules[k].corrMonthlyWithDip}`); } }

// I. dividends the shorts owed, MEASURED where a dividend-adjusted series is on disk
{ const adj = {}, srcs = {};
  const yf = path.join(__dirname, "..", "data", "training", "worst-day", "yahoo-SPY.json"), ef = path.join(__dirname, "..", "data", "strategy-library", "_cache", "R152", "bars-etfs.json");
  const C28 = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "training", "r328", "bars-schwab-daily-19930101-20261002.json"), "utf8")).rows;
  if (fs.existsSync(ef)) { const j = JSON.parse(fs.readFileSync(ef, "utf8")); for (const s of Object.keys(j)) { adj[s] = new Map(j[s].map((b) => [b.t.slice(0, 10), b.c])); srcs[s] = "Alpaca SIP adjustment=all 2016+ (strategy-library/_cache/R152/bars-etfs.json)"; } }
  if (fs.existsSync(yf)) { const j = JSON.parse(fs.readFileSync(yf, "utf8")); adj.SPY = new Map(j.rows.map((x) => [x.date, x.adjClose * 1])); srcs.SPY = "Yahoo adjClose 1993+ (training/worst-day/yahoo-SPY.json, the sister worst-day lane's cache)"; }
  const yld = (s, a, b) => { const P = (C28[s] || []).filter((x) => x[0] >= a && x[0] <= b && adj[s] && adj[s].has(x[0])); if (P.length < 200) return null; const d0 = P[0][0], d1 = P[P.length - 1][0], y = (Date.parse(d1) - Date.parse(d0)) / 864e5 / 365.25; return { from: d0, to: d1, yieldPctPerYear: r2(100 * Math.log((adj[s].get(d1) / adj[s].get(d0)) / (P[P.length - 1][4] / P[0][4])) / y) }; };
  OUT.dividends = { sources: srcs, measuredYield: { SPY_2000_2026: yld("SPY", "2000-01-03", "2026-09-30"), SPY_2016_2026: yld("SPY", "2016-01-04", "2026-09-22") } };
  for (const s of ["QQQ", "DIA", "IWM", "XLB", "XLE", "XLF", "XLI", "XLK", "XLP", "XLU", "XLV", "XLY"]) OUT.dividends.measuredYield[s + "_2016_2026"] = yld(s, "2016-01-04", "2026-09-22");
  function owed(legs, label) { let actual = 0, stand = 0, notionalDays = 0, legsUsed = 0; const events = [];
    for (const L of legs) { if (L.dir >= 0) continue; const M = adj[L.sym]; if (!M) continue; const { A, t } = L, d = A.d, c = A.c, dn = A.dn; if (d[t] < START || d[t] > END) continue; const e = L.u < 0 ? A.n - 1 : L.u, shares = L.slot / c[t]; let used = false;
      for (let k = t + 1; k <= e; k++) { if (d[k] > END) break; const a1 = M.get(d[k]), a0 = M.get(d[k - 1]); if (!(a1 > 0 && a0 > 0)) continue; const dr = a1 / a0 - c[k] / c[k - 1], days = dn[k] - dn[k - 1];
        if (Math.abs(dr) > 0.03) { events.push(`${L.sym} ${d[k]} ${(100 * dr).toFixed(1)}%`); continue; }
        actual += shares * c[k - 1] * dr; stand += E.BASE_CARRY.div * shares * c[k - 1] * days / 365; notionalDays += shares * c[k - 1] * days; used = true; }
      if (used) legsUsed++; }
    const o = { legsWithData: legsUsed, shortNotionalYearsUsd: r0(notionalDays / 365), dividendsOwedUsd: r0(actual), standInChargedUsd: r0(stand), actualYieldOnShortNotionalPct: notionalDays ? r2(100 * actual / (notionalDays / 365)) : null, underChargedUsd: r0(actual - stand), skippedGapsOver3pct: [...new Set(events)].slice(0, 6) };
    OUT.dividends[label] = o; console.log(`   ${label}: owed ${o.dividendsOwedUsd} vs stand-in charged ${o.standInChargedUsd} on ${o.shortNotionalYearsUsd} short-$-years -> actual ${o.actualYieldOnShortNotionalPct}%/yr (stand-in 1.5%), under-charged ${o.underChargedUsd}; legs ${o.legsWithData}; skipped ${JSON.stringify(o.skippedGapsOver3pct)}`); }
  console.log("\nI. DIVIDENDS OWED BY THE SHORTS, measured (adjusted minus price-only daily return on the days held short)"); console.log("   measured yields:", JSON.stringify(OUT.dividends.measuredYield));
  owed(LEGS.S3.filter((L) => L.sym === "SPY"), "S3 SPY leg, whole window (Yahoo)"); owed(LEGS.S4.filter((L) => L.sym === "SPY"), "S4 SPY leg, whole window (Yahoo)"); owed(LEGS.S6, "S6 SPY, whole window (Yahoo)");
  const from16 = (legs) => legs.filter((L) => L.A.d[L.t] >= "2016-01-05");
  owed(from16(LEGS.S3.filter((L) => L.sym === "QQQ")), "S3 QQQ leg, entries from 2016 (Alpaca)"); owed(from16(LEGS.S1), "S1 legs with data, entries from 2016 (13 of 20 ETFs)"); owed(from16(LEGS.S2), "S2 legs with data, entries from 2016 (13 of 20 ETFs)"); owed(from16(E.shortS5().legs), "S5 sector shorts, entries from 2016"); }

// J. the same comparison by era: which protection is cheapest once 2000-02 and 2008 are not in the sample
{ const smaSPY = E.sma(E.SPY.c, 200), own = new Map();
  const spyAbove = (date) => { const i = E.SPY.map.has(date) ? E.SPY.map.get(date) : E.idxLE(E.SPY, date); return i >= 0 && Number.isFinite(smaSPY[i]) && E.SPY.c[i] > smaSPY[i]; };
  const ownAbove = (L) => { if (!own.has(L.A)) own.set(L.A, E.sma(L.A.c, 200)); const s = own.get(L.A)[L.t]; return Number.isFinite(s) && L.A.c[L.t] > s; };
  const l13 = E.longR313().legs, l28 = E.longR328().legs, mk = (f) => add(E.book(l13.filter(f), 0, 1).daily, E.book(l28.filter(f), 0, 1).daily, 0.5, 0.5);
  const rows = { "dip-buy 100%": dip, "80% dip + 20% cash": add(dip, dip, 0.8, 0), "100% dip + 20% S3": add(dip, B.S3.daily, 1, 0.2), "100% dip + 20% S3 (next-open)": add(dip, NO.S3, 1, 0.2), "100% dip + 20% S2 (next-open)": add(dip, NO.S2, 1, 0.2), "F1 dip, entries only SPY above 200-day": mk((L) => spyAbove(L.A.d[L.t])), "F2 dip, entries only ETF above own 200-day": mk(ownAbove) };
  const eras = [["whole 2000-01..2026-09", "2000-01-01", "2026-12-31"], ["2000-01..2009-03-09", "2000-01-01", "2009-03-09"], ["2009-03-10..2026-09", "2009-03-10", "2026-12-31"], ["2013-05-17..2026-09", "2013-05-17", "2026-12-31"]];
  OUT.byEra = {}; console.log("\nJ. BY ERA   $/yr | worst-day avg | Sharpe | maxDD   and (income given up per $1 of worst-day loss removed, vs dip-buy 100%)");
  for (const [lab, a, b] of eras) { OUT.byEra[lab] = {}; const ref = liteEra(dip, a, b); console.log(` ${lab}`);
    for (const [k, d] of Object.entries(rows)) { const x = liteEra(d, a, b); x.incomeGivenUpPerDollarProtected = k === "dip-buy 100%" ? null : r2((ref.perYearUsd - x.perYearUsd) / (x.onWorstDaysUsd - ref.onWorstDaysUsd)); OUT.byEra[lab][k] = x; console.log(`   ${k.padEnd(44)} ${String(x.perYearUsd).padStart(6)} ${String(x.onWorstDaysUsd).padStart(6)} ${String(x.sharpeMonthly).padStart(5)} ${String(x.maxDrawdownUsd).padStart(7)}   ${x.incomeGivenUpPerDollarProtected === null ? "" : "(" + x.incomeGivenUpPerDollarProtected + ")"}`); } } }

// K. the XLF 2016-09-19 spin-off day in the price-only cache (does a price-only short book a gain it would have owed?)
{ const A = E.SECT.XLF, i = A.map.get("2016-09-19"); const row = (j) => `${A.d[j]} ${A.c[j]}`; const legs = E.shortS5().legs.filter((L) => L.sym === "XLF" && L.A.d[L.t] <= "2016-09-16" && (L.u < 0 || L.A.d[L.u] >= "2016-09-19"));
  OUT.xlf2016 = { closes: [row(i - 2), row(i - 1), row(i), row(i + 1)], priceOnlyReturnPct: r2(100 * (A.c[i] / A.c[i - 1] - 1)), s5ShortLegsSpanningIt: legs.map((L) => `${L.A.d[L.t]}..${L.u < 0 ? "open" : L.A.d[L.u]} $${Math.round(L.slot)}`) };
  console.log("\nK. XLF around 2016-09-19 in the Schwab price-only cache:", JSON.stringify(OUT.xlf2016)); }
// L. is S3 a NEW stream beside a trend rule already held (Plan E: SPY .15 + QQQ .15 on the 10-month rule, monthly)? And where S3 is absent.
{ const T10 = new Float64Array(NC), on10 = new Uint8Array(NC);            // the exposure a 10-month rule AVOIDS, booked as a short of $50k per ETF (no cost, no carry)
  for (const A of [E.SPY, E.QQQ]) { const me = []; for (let i = 0; i < A.n; i++) if (i === A.n - 1 || A.d[i].slice(0, 7) !== A.d[i + 1].slice(0, 7)) me.push(i);
    for (let q = 9; q < me.length - 1; q++) { let s = 0; for (let k = q - 9; k <= q; k++) s += A.c[me[k]]; const off = A.c[me[q]] < s / 10; if (!off) continue;
      for (let i = me[q] + 1; i <= me[q + 1]; i++) { const gi = E.CALD.indexOf(A.d[i]); if (gi < 0) continue; T10[gi] += -(STAKE / 2) * (A.c[i] / A.c[i - 1] - 1); on10[gi] = 1; } } }
  const g3 = E.book(E.shortS3(), 0, 0).daily, ex3 = B.S3.expo; let both = 0, s3on = 0, t10on = 0; for (let i = 1; i < NC; i++) { const a = Math.abs(ex3[i - 1]) > 1, b = on10[i] === 1; if (a) s3on++; if (b) t10on++; if (a && b) both++; }
  const m3 = E.monthlySum(g3), m10 = E.monthlySum(T10), keys = [...m3.keys()].sort();
  const flat = worstIdx.filter((i) => Math.abs(ex3[Math.max(0, i - 1)]) < 1), onD = worstIdx.filter((i) => Math.abs(ex3[Math.max(0, i - 1)]) >= 1);
  OUT.s3VsTenMonthRule = { note: "T10 = the SPY+QQQ exposure a 10-month month-end rule switches off, booked as a $50k-per-ETF short with no cost or carry (what the trend rule saves by being flat); S3 gross of cost and carry for a like-for-like comparison", dailyCorr: r3(E.corr(Array.from(g3), Array.from(T10))), monthlyCorr: r3(E.corr(keys.map((k) => m3.get(k)), keys.map((k) => m10.get(k)))), s3DaysOn: s3on, tenMonthDaysOff: t10on, bothOn: both, shareOfS3DaysAlsoOffInTenMonth: r3(both / s3on),
    tenMonthRuleSavedPerWorstDayUsd: r0(mean(worstIdx.map((i) => T10[i]))), s3GrossPerWorstDayUsd: r0(mean(worstIdx.map((i) => g3[i]))), tenMonthRuleSavedPerYearUsd: r0(sum(Array.from(T10)) / YEARS), s3GrossPerYearUsd: r0(sum(Array.from(g3)) / YEARS),
    worstDaysS3Flat: flat.length, dipBookOnThoseUsd: r0(mean(flat.map((i) => dip[i]))), spyOnThosePct: r2(100 * mean(flat.map((i) => RS[i]))), worstDaysS3On: onD.length, dipBookOnThoseOnDaysUsd: r0(mean(onD.map((i) => dip[i]))), s3OnThoseOnDaysUsd: r0(mean(onD.map((i) => B.S3.daily[i]))), flatByYear: flat.reduce((o, i) => { const y = CALD[i].slice(0, 4); o[y] = (o[y] || 0) + 1; return o; }, {}) };
  console.log("\nL. S3 vs A 10-MONTH TREND RULE ALREADY HELD, and the worst days S3 is absent"); console.log(JSON.stringify(OUT.s3VsTenMonthRule)); }
// M. the price of the overlay as a statistic: month-clustered t of each short's own daily dollars, by era (the paired difference book+overlay minus book is 0.2 x this series)
{ const tEra = (d, a, b) => { const x = [], k = []; for (let i = 0; i < NC; i++) if (CALD[i] >= a && CALD[i] <= b) { x.push(d[i]); k.push(MKEY[i]); } return { months: new Set(k).size, perYearUsd: r0(sum(x) / (x.length / 252)), tMonth: r2(E.clusterT(x, k)) }; };
  OUT.overlayCostT = {}; console.log("\nM. THE SHORT'S OWN $/yr AND MONTH-CLUSTERED t BY ERA (standalone $100k; close fills | next-open fills)");
  for (const k of KS) { OUT.overlayCostT[k] = {}; const parts = []; for (const [lab, a, b] of [["whole", "2000-01-01", "2026-12-31"], ["2000-01..2009-03-09", "2000-01-01", "2009-03-09"], ["2009-03-10..2026-09", "2009-03-10", "2026-12-31"], ["2013-05-17..2026-09", "2013-05-17", "2026-12-31"]]) { const c = tEra(B[k].daily, a, b), n = tEra(NO[k], a, b); OUT.overlayCostT[k][lab] = { closeFill: c, nextOpen: n }; parts.push(`${lab}: ${c.perYearUsd} t ${c.tMonth} | ${n.perYearUsd} t ${n.tMonth}`); } console.log(` ${k}  ${parts.join("   ")}`); }
  // cost per $1 of worst-day gain, each rule standalone, close and next-open; and the always-short reference
  OUT.costPerDollarOfWorstDayGain = {}; const ref = lite(B.spyShort.daily); OUT.costPerDollarOfWorstDayGain.alwaysShortSPY = r2(-ref.perYearUsd / ref.onWorstDaysUsd);
  for (const k of KS) { const c = lite(B[k].daily), n = lite(NO[k]); OUT.costPerDollarOfWorstDayGain[k] = { closeFill: r2(-c.perYearUsd / c.onWorstDaysUsd), nextOpen: r2(-n.perYearUsd / n.onWorstDaysUsd) }; }
  console.log("   $/yr lost per $1 earned on an average worst day (negative = the rule made money):", JSON.stringify(OUT.costPerDollarOfWorstDayGain)); }
writeJsonAtomic(path.join(__dirname, "..", "data", "short-leg", "skeptic-checks.json"), OUT, { pretty: 1 });
console.log("\nwrote backend/data/short-leg/skeptic-checks.json");
