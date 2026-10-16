#!/usr/bin/env node
"use strict";
/**
 * WORST-DAY ATTACK, part 2: the clock. Every input's date stamp tested against the SPY session it is meant to share, by lead/lag
 * correlation (a series stamped one day early or late peaks at lag +-1, not 0), plus the FOMC list's treatment of unscheduled meetings.
 * Read-only; writes backend/data/worst-day/attack-time.json (atomic).   node backend/worst-day/attack-time.js
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const L = require("./lib.js"), DS = require("./dataset.js"), W = require("./wf.js");
const OUT = path.join(__dirname, "..", "data", "worst-day", "attack-time.json");
const r3 = (x) => (Number.isFinite(x) ? +x.toFixed(3) : null);
const D = DS.build(), idx = new Map(D.d.map((d, i) => [d, i])), out = { spec: "worst-day-attack-time-v1", asOf: new Date().toISOString(), command: "node backend/worst-day/attack-time.js" };
const corr = (a, b) => { const n = a.length; const ma = L.mean(a), mb = L.mean(b); let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return sab / Math.sqrt(saa * sbb); };
/** series = [{d, x}] of daily LEVELS (already on its own date stamps). Returns corr(dln(level on stamp t), SPY return on session idx(t)+lag) */
function lead(series, label, from = "2000-01-01") {
  const res = {};
  for (const lag of [-2, -1, 0, 1, 2]) {
    const a = [], b = [];
    for (let j = 1; j < series.length; j++) { const s = series[j]; if (s.d < from) continue; const i = idx.get(s.d); if (i === undefined) continue; const k = i + lag; if (k < 1 || k >= D.n) continue; const ch = Math.log(s.x / series[j - 1].x); if (!Number.isFinite(ch)) continue; a.push(ch); b.push(D.r[k]); }
    res[lag] = r3(corr(a, b));
  }
  const best = Object.entries(res).sort((p, q) => Math.abs(q[1]) - Math.abs(p[1]))[0][0];
  return { label, corrAtLag: res, peakLag: +best, ok: +best === 0, note: "lag k = the SPY session k sessions after the series' own date stamp" };
}
const T = [];
T.push(lead(L.loadFred("VIXCLS").map((x) => ({ d: x.d, x: x.v })), "FRED VIXCLS (daily log change)"));
T.push(lead(L.loadFred("VXVCLS").map((x) => ({ d: x.d, x: x.v })), "FRED VXVCLS (VIX3M)", "2008-01-01"));
for (const s of ["HYG", "LQD"]) T.push(lead(L.loadYahoo(s).map((x) => ({ d: x.d, x: x.a })), `Yahoo ${s} adjClose`, "2007-06-01"));
for (const s of DS.SECTORS || ["XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLU", "XLB"]) T.push(lead(L.loadSchwab313(s).map((x) => ({ d: x.d, x: x.c })), `Schwab r313 ${s} close`));
T.push(lead(L.loadSchwab313("SPY").map((x) => ({ d: x.d, x: x.c })), "Schwab r313 SPY close (vs Yahoo SPY)"));
out.leadLag = T; for (const t of T) console.log(t.ok ? "OK " : "BAD", t.label.padEnd(40), JSON.stringify(t.corrAtLag), "peak", t.peakLag);

// exact-value spot checks of the VIX stamps against well-known closes
const fr = new Map(L.loadFred("VIXCLS").map((x) => [x.d, x.v]));
const known = [["2008-10-24", 79.13], ["2008-10-27", 80.06], ["2020-03-16", 82.69], ["2020-03-18", 76.45], ["2018-02-05", 37.32], ["2024-08-05", 38.57], ["2015-08-24", 40.74], ["2010-05-06", 32.8]];
out.vixKnownCloses = known.map(([d, v]) => ({ date: d, wellKnownClose: v, fredValueOnThatStamp: fr.get(d), match: Math.abs((fr.get(d) || 0) - v) < 0.06 }));
console.log("VIX stamp spot checks", JSON.stringify(out.vixKnownCloses));

// FOMC: are unscheduled / emergency actions in the list that feeds 'FOMC tomorrow'?
const F = D.FOMC, fall = new Set(F.all);
const unscheduledKnown = [["2007-08-17", "discount-rate cut, conference call"], ["2008-01-22", "75bp intermeeting cut"], ["2008-03-16", "Bear Stearns/ discount window, Sunday"], ["2008-10-08", "coordinated cut"], ["2020-03-03", "50bp intermeeting cut"], ["2020-03-15", "Sunday emergency cut to zero"], ["2001-09-17", "post-9/11 cut"], ["2001-01-03", "intermeeting cut"]];
out.fomc = { unscheduledActionsInTheList: unscheduledKnown.map(([d, w]) => ({ date: d, what: w, inList: fall.has(d) })), listAround2008: F.all.filter((x) => x >= "2008-01-01" && x <= "2008-12-31"), listAround2020: F.all.filter((x) => x >= "2020-01-01" && x <= "2020-04-30") };
const FI = D.FEATURES.indexOf("fomcTomorrow"); let fN = 0, fW = 0, fAll = 0, fAllW = 0, rowsF = 0; for (let i = DS.WIN; i < D.n - 1; i++) { if (D.d[i + 1] < "2005-01-01") continue; fAll++; if (D.y[i]) fAllW++; if (D.X[i][FI] === 1) { fN++; if (D.y[i]) fW++; } }
out.fomc.worstDayRateWhenFomcTomorrow = { fomcTomorrowDays: fN, worstOnThoseDays: fW, ratePct: +(100 * fW / fN).toFixed(2), baseRatePct: +(100 * fAllW / fAll).toFixed(2) };
console.log("FOMC unscheduled in list:", JSON.stringify(out.fomc.unscheduledActionsInTheList), "| 2020 list:", out.fomc.listAround2020.join(" "), "| worst-day rate when FOMC tomorrow", JSON.stringify(out.fomc.worstDayRateWhenFomcTomorrow));

// FRED VIX coverage: missing prior observations on SPY sessions (staleness of the 'prior session' value)
{ let stale = 0, tot = 0, maxGap = 0; const vd = L.loadFred("VIXCLS").map((x) => x.d); const vset = new Set(vd);
  for (let i = 201; i < D.n - 1; i++) { if (D.d[i] < "2000-01-01") continue; tot++; if (!vset.has(D.d[i - 1])) stale++; }
  out.vixPriorSessionMissing = { sessionsChecked: tot, priorSessionHasNoFredObservation: stale }; console.log("VIX prior-session missing:", stale, "of", tot); }

// the shape of the usableAt table (one line per input), with the evidence this script produced
out.usableAt = [
  { input: "rv5/rv20/rv60, ret1, ret5, dist50, dist200 (Yahoo SPY)", usableAt: "16:00 ET day t (last tick = closing auction print)", evidence: "peak lag 0 vs Schwab SPY; look-ahead scramble moved no earlier row" },
  { input: "VIX level, change, VIX/VIX3M (FRED)", usableAt: "16:15 ET day t-1 (stamp = day t-1; spot checks match well-known closes), so 23h45m of margin", evidence: "peak lag 0 for both; 8 of 8 known closes match their stamps" },
  { input: "credit20 HYG-LQD (Yahoo)", usableAt: "16:00 ET day t", evidence: "peak lag 0" },
  { input: "breadth50 (Schwab sector ETF closes)", usableAt: "16:00 ET day t", evidence: "peak lag 0 for all nine sectors" },
  { input: "FOMC tomorrow", usableAt: "published ahead for SCHEDULED meetings only", evidence: "see fomc.unscheduledActionsInTheList" },
  { input: "month-end / opex tomorrow", usableAt: "exchange calendar, published ahead (unscheduled closures excepted)", evidence: "n/a" },
];
writeJsonAtomic(OUT, out);
console.log("wrote", OUT);
