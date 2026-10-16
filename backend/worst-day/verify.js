#!/usr/bin/env node
"use strict";
/**
 * WORST-DAY PREDICTOR, step 4: an INDEPENDENT re-computation (separate code path, straight loops, no dataset.js / lib.js statistics) of the
 * pieces that carry the headline: the 63rd-smallest-of-1,260 threshold, the worst-day labels, rule (a)'s flags and its catch counts, and
 * the two buy-and-hold / short-every-day twins in dollars. Compares each to backend/data/worst-day/worst-day.json and writes verify.json.
 *   node backend/worst-day/verify.js
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const TR = path.join(__dirname, "..", "data", "training", "worst-day"), OUT = path.join(__dirname, "..", "data", "worst-day");
const raw = JSON.parse(fs.readFileSync(path.join(TR, "yahoo-SPY.json"), "utf8")).rows;
const day = [], cl = [], ad = []; let last = "";
for (const x of raw) { const g = new Date(x.date + "T12:00:00Z").getUTCDay(); if (g === 0 || g === 6 || x.date <= last || !(x.close > 0) || !(x.adjClose > 0)) continue; last = x.date; day.push(x.date); cl.push(x.close); ad.push(x.adjClose); }
const n = day.length, ret = [NaN]; for (let i = 1; i < n; i++) ret.push(ad[i] / ad[i - 1] - 1);
const asc = (a) => a.slice().sort((p, q) => p - q);
let worstFlag = new Array(n).fill(null), ruleA = new Array(n).fill(null);
const rv20 = new Array(n).fill(NaN);
for (let i = 20; i < n; i++) { let m = 0; for (let k = i - 19; k <= i; k++) m += ret[k]; m /= 20; let v = 0; for (let k = i - 19; k <= i; k++) v += (ret[k] - m) ** 2; rv20[i] = Math.sqrt(v / 19) * Math.sqrt(252); }
for (let i = 1260; i < n - 1; i++) {
  const w = asc(ret.slice(i - 1259, i + 1)); if (w.length !== 1260) throw new Error("window");
  const thr = w[62];                                                  // the 63rd smallest of 1,260 = ceil(0.05 x 1260)
  worstFlag[i] = ret[i + 1] <= thr;
  let s = 0; for (let k = i - 199; k <= i; k++) s += cl[k]; const sma200 = s / 200;
  const rw = asc(rv20.slice(i - 1259, i + 1).filter((x) => !Number.isNaN(x))); const q80 = rw[Math.ceil(0.8 * rw.length) - 1];
  ruleA[i] = cl[i] < sma200 && rv20[i] >= q80;
}
// out-of-sample rows = decision rows whose target date is in 2005..2026
let N = 0, W = 0, F = 0, C = 0;
const oosRows = [];
for (let i = 1260; i < n - 1; i++) { const yy = +day[i + 1].slice(0, 4); if (yy < 2005) continue; oosRows.push(i); N++; if (worstFlag[i]) W++; if (ruleA[i]) { F++; if (worstFlag[i]) C++; } }
// dollars: long every day and short every day, 3 bp a side on the change in position, 1 bp per calendar day short, $100,000
const dn = (d) => Math.round(Date.parse(d + "T12:00:00Z") / 86400000);
let longTot = 0, shortTot = 0;
for (let j = 0; j < oosRows.length; j++) {
  const i = oosRows[j], r = ret[i + 1], cd = dn(day[i + 1]) - dn(day[i]);
  longTot += 100000 * r - (j === 0 ? 100000 * 0.0003 : 0);
  shortTot += -100000 * r - (j === 0 ? 100000 * 0.0003 : 0) - 100000 * 0.0001 * cd;
}
const years = (dn(day[oosRows[oosRows.length - 1] + 1]) - dn(day[oosRows[0]]) + 1) / 365.25;
const J = JSON.parse(fs.readFileSync(path.join(OUT, "worst-day.json"), "utf8"));
const mine = { decisions: N, worstDays: W, ruleAFlagged: F, ruleAWorstFlagged: C, longEveryDayPerYearUsd: +(longTot / years).toFixed(2), shortEveryDayPerYearUsd: +(shortTot / years).toFixed(2) };
const theirs = { decisions: J.oosWindow.decisions, worstDays: J.oosWindow.worstDays, ruleAFlagged: J.discrimination.a.all.flaggedDays, ruleAWorstFlagged: J.discrimination.a.all.worstDaysFlagged, longEveryDayPerYearUsd: J.twins.spyHalf.perYearUsd, shortEveryDayPerYearUsd: J.twins.short1.perYearUsd };
const match = Object.keys(mine).map((k) => ({ k, independent: mine[k], pipeline: theirs[k], same: Math.abs(mine[k] - theirs[k]) < 0.015 }));
const out = { spec: "worst-day-verify-v1", asOf: new Date().toISOString(), command: "node backend/worst-day/verify.js", allMatch: match.every((m) => m.same), match };
writeJsonAtomic(path.join(OUT, "verify.json"), out);
console.log(JSON.stringify(out, null, 1));
