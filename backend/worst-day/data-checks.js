#!/usr/bin/env node
"use strict";
/**
 * WORST-DAY PREDICTOR, step 2: data checks and the look-ahead proof. Read-only. Writes backend/data/worst-day/data-checks.json.
 *   node backend/worst-day/data-checks.js
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const L = require("./lib.js"), DS = require("./dataset.js");
const OUT = path.join(__dirname, "..", "data", "worst-day", "data-checks.json");
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const fin = Number.isFinite, r4 = (x) => (fin(x) ? +x.toFixed(4) : null);

const D = DS.build();
const out = { spec: "worst-day-data-checks-v1", asOf: new Date().toISOString(), command: "node backend/worst-day/data-checks.js" };

// 1. calendar and returns
const raw = JSON.parse(fs.readFileSync(path.join(L.TR, "yahoo-SPY.json"), "utf8")).rows;
let gaps = [], big = [];
for (let i = 1; i < D.n; i++) { const g = L.dayNum(D.d[i]) - L.dayNum(D.d[i - 1]); if (g > 5) gaps.push(`${D.d[i - 1]}->${D.d[i]} (${g}d)`); if (Math.abs(D.r[i]) > 0.08) big.push(`${D.d[i]} ${(100 * D.r[i]).toFixed(2)}%`); }
out.spy = { source: "Yahoo chart v8 via the repo's :3002 proxy (backend/data/training/worst-day/yahoo-SPY.json)", rowsServed: raw.length, rowsUsed: D.n, first: D.d[0], last: D.d[D.n - 1], gapsOver5Days: gaps, daysOver8pct: big,
  note: "returns are on dividend-adjusted closes (total return: a short owes the dividend). Means: total-return daily mean " + r4(100 * L.mean(Array.from(D.r.subarray(1)))) + "% vs price-only " + r4(100 * L.mean(Array.from(D.rRaw.subarray(1)))) + "%" };

// 2. Yahoo SPY raw close vs the Schwab r313 SPY close (the passed tests' source)
const sch = new Map(L.loadSchwab313("SPY").map((x) => [x.d, x.c]));
let common = 0, off = 0, maxRel = 0, offList = [];
for (let i = 0; i < D.n; i++) { const s = sch.get(D.d[i]); if (s === undefined) continue; common++; const rel = Math.abs(D.close[i] / s - 1); if (rel > maxRel) maxRel = rel; if (rel > 0.005) { off++; if (offList.length < 8) offList.push(`${D.d[i]} yahoo ${D.close[i]} schwab ${s}`); } }
// and the next-day returns agree where both exist
let rd = 0, rdN = 0; for (let i = 1; i < D.n; i++) { const a = sch.get(D.d[i]), b = sch.get(D.d[i - 1]); if (a && b) { rdN++; if (Math.abs((a / b - 1) - D.rRaw[i]) > 0.0005) rd++; } }
out.crossCheckSchwab = { commonDates: common, closesDifferingOver0p5pct: off, maxRelativeDiff: r4(maxRel), examples: offList, dailyPriceReturnsDifferingOver5bp: rd, of: rdN };

// 3. FRED VIX / VXV against the Yahoo caches the repo already holds (r291)
function cmp(fredId, yfile) {
  const fr = new Map(L.loadFred(fredId).map((x) => [x.d, x.v]));
  const yj = JSON.parse(fs.readFileSync(path.join(L.ROOT, "data", "training", "r291", yfile), "utf8")); const ys = Array.isArray(yj) ? yj : (yj.bars || yj.rows);
  let c = 0, bad = 0, maxd = 0; for (const y of ys) { const f = fr.get(y.d); if (f === undefined) continue; c++; const dd = Math.abs(f - y.c); if (dd > maxd) maxd = dd; if (dd > 0.5) bad++; }
  return { common: c, differingOver0p5pt: bad, maxAbsDiff: r4(maxd) };
}
out.crossCheckVix = { VIXCLS_vs_yahooVIX: cmp("VIXCLS", "yahoo-VIX.json"), VXVCLS_vs_yahooVIX3M: cmp("VXVCLS", "yahoo-VIX3M.json") };

// 4. FOMC lists
const F = D.FOMC, fedH2 = F.fedList.filter((x) => x >= "2015-07-01"), r196H2 = F.r196.filter((x) => x <= "2015-12-31");
const dset = new Set(D.d);
out.fomc = { fedPages2005_2015: F.nFed, repoR196List: F.nR196, repoMacroCalendar: F.nMacro, union: F.all.length, overlap2015H2Agrees: JSON.stringify(fedH2) === JSON.stringify(r196H2),
  datesNotASession: F.all.filter((x) => x >= "2005-01-01" && x <= D.d[D.n - 1] && !dset.has(x)),
  firstUsed: F.all.find((x) => x >= "2005-01-01"), note: "rows whose next session is before 2005-01-01 carry fomcTomorrow = missing, not 0 (no list exists before the Fed pages' first year); CPI/NFP dropped (repo calendar holds CPI 2021+, NFP 2024+)" };

// 5. the look-ahead proof: scramble EVERY series after 2015-06-30 and compare every feature on rows dated <= 2015-06-30
const T = "2015-06-30", P = DS.build({ perturbAfter: T });
let rows = 0, diffs = 0, firstDiff = null;
for (let i = 0; i < D.n; i++) {
  if (D.d[i] > T) break; rows++;
  for (let f = 0; f < D.FEATURES.length; f++) {
    const a = D.X[i][f], b = P.X[i][f];
    if (!((Number.isNaN(a) && Number.isNaN(b)) || a === b)) { diffs++; if (!firstDiff) firstDiff = `${D.d[i]} ${D.FEATURES[f]} ${a} vs ${b}`; }
  }
  // the rule-of-thumb flag and the label thresholds also use only the past
  if (D.flagA[i] !== P.flagA[i] || !((Number.isNaN(D.thr[i]) && Number.isNaN(P.thr[i])) || D.thr[i] === P.thr[i])) { diffs++; if (!firstDiff) firstDiff = `${D.d[i]} flagA/thr`; }
}
let futureMoved = 0; for (let i = 0; i < D.n; i++) if (D.d[i] > T && D.X[i][1] !== P.X[i][1]) futureMoved++;
out.lookAheadProof = { scrambledAfter: T, rowsChecked: rows, featuresChecked: D.FEATURES.length, cellsThatChanged: diffs, firstChange: firstDiff, rowsAfterThatDidMove: futureMoved, pass: diffs === 0 && futureMoved > 1000,
  note: "every price, VIX, VIX3M, HYG, LQD and sector series was scrambled by up to +-25% after the date; no feature, threshold or rule flag dated on or before it moved" };

// 6. labels and availability by year
const byYear = {};
for (let i = DS.WIN; i < D.n - 1; i++) { const y = D.d[i + 1].slice(0, 4); const o = (byYear[y] = byYear[y] || { n: 0, worst: 0, best: 0, thr: [], credit: 0, breadth: 0, ratio: 0, fomc: 0 }); o.n++; o.worst += D.y[i]; o.best += D.yb[i]; o.thr.push(D.thr[i]);
  if (fin(D.X[i][10])) o.credit++; if (fin(D.X[i][11])) o.breadth++; if (fin(D.X[i][9])) o.ratio++; if (fin(D.X[i][12])) o.fomc++; }
out.labelsByTargetYear = Object.fromEntries(Object.entries(byYear).map(([y, o]) => [y, { sessions: o.n, worstDays: o.worst, worstSharePct: r4(100 * o.worst / o.n), bestDays: o.best, medianThresholdPct: r4(100 * L.qLow(o.thr, 0.5)), haveCredit20: o.credit, haveBreadth50: o.breadth, haveVixRatio: o.ratio, haveFomc: o.fomc }]));
out.firstLabelledRow = D.d[DS.WIN];

writeJsonAtomic(OUT, out);
console.log(JSON.stringify({ spy: out.spy, crossCheckSchwab: out.crossCheckSchwab, crossCheckVix: out.crossCheckVix, fomc: out.fomc, lookAheadProof: out.lookAheadProof, firstLabelledRow: out.firstLabelledRow }, null, 1));
console.log("year  sessions worst% med-thr credit breadth ratio fomc");
for (const [y, o] of Object.entries(out.labelsByTargetYear)) console.log(y, String(o.sessions).padStart(4), String(o.worstSharePct).padStart(6), String(o.medianThresholdPct).padStart(7), o.haveCredit20, o.haveBreadth50, o.haveVixRatio, o.haveFomc);
