#!/usr/bin/env node
"use strict";
/**
 * PLAN E - what a 5% / 10% sleeve of an already-PASSED test would add. READ-ONLY on the repo; offline (cache + backend/data/strategy-library/*.json).
 *   node backend/profit-program/planE-added-legs.js
 *
 * DENOMINATOR: Plan E daily, risk-manager buildBook with the month-end window on the calendar (fixWindow) and the ZN proxy FINANCED (T-bill charged on the
 * notional), 2019-06-03..2026-09-30 - the daily family that lands within 0.3 pt/yr of the refereed real-ZN monthly 24.26 (planE-baseline.js).
 * SLEEVE: the library stream s_t (net of the test's own costs; zero days = cash) funded from idle cash: r = r_PlanE + w x (s_t - rf_t x [s_t != 0]).
 *   Plan E keeps >= 15% idle (weights sum to <= 85%) and ~12% of the paper book is a ZN margin reserve, so a 10% sleeve eats the JAAA / reserve buffer.
 * STREAMS: only what a long-only ETF / futures account can run and the library marks usable. EXCLUDED, with the reason printed: R180 (is the TSY leg),
 *   R192 (AGG/LQD/MUB month-end: same factor, rho 0.6 to Plan E), R214 / R227 (VOID for combination by the operator), R299 / R302 (not stand-alone),
 *   R150 / R152 single-name members and R187 (shorts / 1.5x crypto leverage / per-name stocks: not a Plan E ETF sleeve).
 * MULTIPLICITY: the library holds many PASS streams; ALL PASS streams are screened in the JSON (screened count printed). Everything here is IN-SAMPLE
 * context for a forward twin, never the evidence. t is the monthly improvement clustered by calendar month (88 months), not by day.
 */
const fs = require("fs"), path = require("path");
const M = require("./planE-model.js");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const LIB = path.join(M.BACKEND, "data", "strategy-library");
const usd = (x) => (x < 0 ? "-$" : "+$") + Math.abs(Math.round(x)).toLocaleString("en-US");
const mean = M.mean, sd = M.sd;

(async () => {
  const inp = M.loadInputs(), cut = "2026-09-30";
  const r = await M.rmRows(inp, { asOf: cut, fixWindow: true });
  const pe = M.rmDaily(r.rows, { w: M.E_W, zn: 4.2 }, { fin: true }), rfBy = new Map(r.rows.map((x) => [x.d, x.rf]));
  const peS = M.dailyStats(pe);
  console.log(`PLAN E denominator (daily, calendar window, ZN financed) ${pe[0].d}..${pe[pe.length - 1].d}: CAGR ${peS.cagrPct}%  vol ${peS.volPct}%  Sharpe ${peS.sharpe}  max daily DD ${peS.maxDDdailyPct}% (${peS.ddAt})`);
  const stress = [...pe.map((x) => x.r)].sort((a, b) => a - b)[Math.floor(0.05 * pe.length)];

  const files = fs.readdirSync(LIB).filter((f) => /\.json$/.test(f) && !/^index|^correlation|^plan-e-correlation/.test(f));
  const entries = files.map((f) => JSON.parse(fs.readFileSync(path.join(LIB, f), "utf8")));
  const pass = entries.filter((e) => e.status === "ok" && /^PASS/.test(String(e.verdict || "")) && Array.isArray(e.series) && e.unit === "daily" && !e.id.startsWith("PLAN-E") && !/^TSY-/.test(e.id));
  console.log(`library: ${entries.length} entries, ${pass.length} daily PASS streams screened (this is the multiplicity: ${pass.length} candidate sleeves looked at)`);
  const USE = new Set(["R313", "R152-DAVIN"]);
  const WHY = { R180: "is the TSY leg already (double count)", R192: "month-end bonds: same factor as the TSY leg (rho 0.6 to Plan E)", R214: "VOID for combination (gold beta)", R227: "VOID for combination (one event a year)" };

  const rows = [];
  for (const e of pass) {
    const m = new Map(e.series.map((x) => [x.d, x.r]));
    const dates = pe.map((x) => x.d), s = dates.map((d) => m.get(d) ?? 0), active = s.map((x) => (x !== 0 ? 1 : 0));
    const first = e.series[0].d; const lo = Math.max(0, dates.findIndex((d) => d >= first));
    if (dates.length - lo < 500) continue;                     // needs >= 2 years of overlap
    const idx = []; for (let i = lo; i < dates.length; i++) idx.push(i);
    const a = idx.map((i) => pe[i].r), sv = idx.map((i) => s[i]);
    const rho = M.corr(a, sv), rhoStress = (() => { const A = [], B = []; idx.forEach((i) => { if (pe[i].r <= stress) { A.push(pe[i].r); B.push(s[i]); } }); return B.length > 20 ? M.corr(A, B) : NaN; })();
    const sleeve = (w) => idx.map((i) => w * (s[i] - rfBy.get(dates[i]) * active[i]));
    const res = { id: e.id, name: e.name.slice(0, 70), overlapDays: idx.length, from: dates[lo], activeSharePct: +(100 * mean(idx.map((i) => active[i]))).toFixed(1), rhoPlanE: +rho.toFixed(3), rhoWorst5pct: +rhoStress.toFixed(3), own: M.dailyStats(sv.map((x, k) => ({ d: dates[idx[k]], r: x }))) };
    const base = M.dailyStats(idx.map((i) => ({ d: dates[i], r: pe[i].r })));
    res.base = base; res.add = {};
    for (const w of [0.05, 0.10]) {
      const sl = sleeve(w), comb = idx.map((i, k) => ({ d: dates[i], r: pe[i].r + sl[k] })), st = M.dailyStats(comb);
      // monthly improvement, clustered by calendar month
      const mo = {}; idx.forEach((i, k) => { const ym = dates[i].slice(0, 7); mo[ym] = (mo[ym] || 0) + sl[k]; });
      const dm = Object.values(mo), tM = mean(dm) / (sd(dm) / Math.sqrt(dm.length));
      res.add[w] = { cagrPct: st.cagrPct, dCagrPt: +(st.cagrPct - base.cagrPct).toFixed(2), volPct: st.volPct, maxDDdailyPct: st.maxDDdailyPct, dMaxDDpt: +(st.maxDDdailyPct - base.maxDDdailyPct).toFixed(2), sharpe: st.sharpe, usdPerMonthPer100k: Math.round(100000 * (st.cagrPct - base.cagrPct) / 100 / 12), tMonthlyImprovement: +tM.toFixed(2), months: dm.length };
    }
    rows.push(res);
  }
  rows.sort((p, q) => q.add[0.1].dCagrPt - p.add[0.1].dCagrPt);

  console.log("\nIMPLEMENTABLE CANDIDATES (same window as the denominator where the stream allows; w = share of NAV moved from T-bills into the sleeve)");
  console.log("stream        from        days  active%  own CAGR  own vol  rho(PE)  rho(worst5%)   w     PE+sleeve CAGR   dCAGR   max DD (daily)   dDD    $/mo per $100k   t(months)");
  for (const x of rows.filter((q) => USE.has(q.id))) for (const w of [0.05, 0.10]) { const a = x.add[w]; console.log(`${x.id.padEnd(13)} ${x.from}  ${String(x.overlapDays).padStart(5)}  ${String(x.activeSharePct).padStart(6)}  ${String(x.own.cagrPct).padStart(7)}%  ${String(x.own.volPct).padStart(6)}%  ${String(x.rhoPlanE).padStart(6)}  ${String(x.rhoWorst5pct).padStart(10)}   ${(100 * w).toFixed(0).padStart(2)}%   ${String(a.cagrPct).padStart(9)}%     ${(a.dCagrPt >= 0 ? "+" : "") + a.dCagrPt}  ${String(a.maxDDdailyPct).padStart(10)}%   ${(a.dMaxDDpt >= 0 ? "+" : "") + a.dMaxDDpt}   ${usd(a.usdPerMonthPer100k).padStart(10)}      ${a.tMonthlyImprovement}`); }
  console.log("\nSCREEN OF EVERY daily PASS stream at w=10% (context only; excluded/unusable ones flagged), sorted by dCAGR:");
  for (const x of rows) { const a = x.add[0.1]; const tag = USE.has(x.id) ? "USABLE" : (WHY[x.id] ? "EXCL: " + WHY[x.id] : /^R187|^R150|^R152|^R189/.test(x.id) ? "not an ETF-long sleeve (shorts / crypto leverage / single names)" : "unclassified"); console.log(`  ${x.id.padEnd(18)} rho ${String(x.rhoPlanE).padStart(6)}  own Sharpe ${String(x.own.sharpe).padStart(5)}  dCAGR ${(a.dCagrPt >= 0 ? "+" : "") + String(a.dCagrPt).padStart(5)}  dDD ${(a.dMaxDDpt >= 0 ? "+" : "") + String(a.dMaxDDpt).padStart(5)}  t ${String(a.tMonthlyImprovement).padStart(5)}  ${tag}`); }
  const OUT = path.join(M.BACKEND, "data", "profit-program", "planE-added-legs.json");
  writeJsonAtomic(OUT, { spec: "planE-added-legs-v1", inputsFetchedAt: inp.fetchedAt, denominator: peS, screened: pass.length, rows });
  console.log("\nwrote " + path.relative(process.cwd(), OUT));
})().catch((e) => { console.error("planE-added-legs FAILED:", e.stack); process.exit(1); });
