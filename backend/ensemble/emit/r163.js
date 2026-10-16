#!/usr/bin/env node
"use strict";
/**
 * EMITTER — R163 published intraday patterns (6 members) -> library entries R163-<PATTERN>.
 *   Run with a large heap (the cache is ~330 MB of JSON):  node --max-old-space-size=8192 backend/ensemble/emit/r163.js
 *
 * backend/r163-intraday.js is NOT require()-safe (top-level async main; default mode --build), so events / periodicity / dailyOf / summarise /
 * nwT are COPIED VERBATIM from it (lines cited) and driven on its own cache backend/data/r163-intraday-cache.json (read-only).
 *
 * Every pattern is intraday (flat at the close), so the day's net return is the script's own per-session value: mean over that pattern's
 * positions of pos*r - 0.05% (PERIODICITY: mean over intervals 1..12 of the top-minus-bottom quintile spread, minus 2 x 0.05%), booked on
 * the session date. Sessions where the pattern held no position are omitted (= cash 0).
 */
const fs = require("fs"), path = require("path");
const { writeEntry } = require("../lib-entry.js");
const DATA = path.join(__dirname, "..", "..", "data");
// constants: r163-intraday.js lines 21-23
const ETFS = ["SPY", "QQQ", "IWM", "DIA", "XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLU", "XLB", "XLRE", "XLC"], COST = 0.0005, DISC = ["2017-01-01", "2021-12-31"], HOLD = ["2022-01-01", "2026-09-22"];
const PATTERNS = ["INTRAMOM", "INTRAMOM_SPY", "ORB30", "VWAPREV", "GAPFADE", "PERIODICITY"];
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
// line 28
function nwT(a, L = 5) { const n = a.length; if (n < 10) return null; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n; for (let k = 1; k <= L; k++) { let c = 0; for (let i = k; i < n; i++) c += d[i] * d[i - k]; v += 2 * (1 - k / (L + 1)) * c / n; } return v > 0 ? m / Math.sqrt(v / n) : null; }
// lines 43-59 (verbatim)
function events(cache) {
  const ev = Object.fromEntries(PATTERNS.map((p) => [p, []]));
  for (const [s, days] of Object.entries(cache)) {
    const ds = Object.keys(days).sort(); let prevClose = null;
    for (const d of ds) { const b = days[d], full = b.every(Boolean), last = [...b].reverse().find(Boolean);
      if (full && prevClose) {
        const O = (k) => b[k][0], Hh = (k) => b[k][1], L = (k) => b[k][2], C = (k) => b[k][3];
        const s0 = C(0) / prevClose - 1, rl = C(12) / C(11) - 1; ev.INTRAMOM.push({ s, d, pos: Math.sign(s0), r: rl }); if (s === "SPY") ev.INTRAMOM_SPY.push({ s, d, pos: Math.sign(s0), r: rl });
        const orb = C(1) > Hh(0) ? 1 : C(1) < L(0) ? -1 : 0; ev.ORB30.push({ s, d, pos: orb, r: C(12) / C(1) - 1 });
        let pv = 0, vv = 0; for (let k = 0; k <= 3; k++) { pv += b[k][4] * b[k][5]; vv += b[k][5]; } const dev = vv > 0 ? C(3) / (pv / vv) - 1 : 0; ev.VWAPREV.push({ s, d, pos: Math.abs(dev) > 0.005 ? -Math.sign(dev) : 0, r: C(12) / C(3) - 1 });
        const gap = O(0) / prevClose - 1; ev.GAPFADE.push({ s, d, pos: Math.abs(gap) > 0.01 ? -Math.sign(gap) : 0, r: C(12) / O(0) - 1 });
      }
      if (last) prevClose = last[3]; }
  }
  return ev;
}
// lines 60-69 (verbatim; control arguments unused here)
function periodicity(cache, sessions, outcomeShuffle = null, peek = false) {
  const names = Object.keys(cache).filter((s) => !ETFS.includes(s)), dayIdx = new Map(sessions.map((d, i) => [d, i])), res = {};
  const ir = (s, d, k) => { const b = cache[s][d]; return b && b[k] && b[k - 1] ? b[k][3] / b[k - 1][3] - 1 : NaN; };
  for (let i = 5; i < sessions.length; i++) { const d = sessions[i], per = [];
    for (let k = 1; k <= 12; k++) { const xs = [];
      for (const s of names) { const hist = [1, 2, 3, 4, 5].map((j) => ir(s, sessions[i - j], k)).filter(Number.isFinite); if (hist.length < 4) continue; const od = outcomeShuffle ? outcomeShuffle(s, i) : d, out = ir(s, od, k); if (!Number.isFinite(out)) continue; xs.push({ v: peek ? out : mean(hist), out }); }
      if (xs.length < 40) continue; xs.sort((a, b) => a.v - b.v); const q = Math.floor(xs.length / 5), lo = xs.slice(0, q), hi = xs.slice(-q); per.push({ gross: mean(hi.map((x) => x.out)) - mean(lo.map((x) => x.out)) }); }
    if (per.length) res[d] = { gross: mean(per.map((x) => x.gross)), net: mean(per.map((x) => x.gross)) - 2 * COST }; }
  return res;
}
// lines 70-71 (verbatim)
function summarise(daily, from, to) { const ds = Object.keys(daily).filter((d) => d >= from && d <= to).sort(), net = ds.map((d) => daily[d].net), gross = ds.map((d) => daily[d].gross), h = Math.floor(net.length / 2);
  return { sessions: ds.length, netBpsPerDay: +(1e4 * mean(net)).toFixed(3), grossBpsPerDay: +(1e4 * mean(gross)).toFixed(3), tNW: nwT(net) == null ? null : +nwT(net).toFixed(3), tGrossNW: nwT(gross) == null ? null : +nwT(gross).toFixed(3), firstHalfBps: +(1e4 * mean(net.slice(0, h))).toFixed(3), secondHalfBps: +(1e4 * mean(net.slice(h))).toFixed(3), activeDaysPct: +(100 * ds.filter((d) => daily[d].n > 0).length / Math.max(1, ds.length)).toFixed(1) }; }
// lines 72-76, real mode only
function dailyOf(list) {
  const out = {}; for (const e of list) { const pos = e.pos, r = e.r;
    const o = (out[e.d] ||= { g: 0, n: 0, all: 0 }); o.all++; if (!pos) continue; o.g += pos * r; o.n++; }
  return Object.fromEntries(Object.entries(out).map(([d, o]) => [d, { n: o.n, gross: o.n ? o.g / o.n : 0, net: o.n ? o.g / o.n - COST : 0 }])); }

console.log("  R163 loading cache ...");
const cache = JSON.parse(fs.readFileSync(path.join(DATA, "r163-intraday-cache.json"), "utf8")).bars;
const ev = events(cache), sessions = Object.keys(cache.SPY).sort();
const real = { ...Object.fromEntries(PATTERNS.filter((p) => p !== "PERIODICITY").map((p) => [p, dailyOf(ev[p])])), PERIODICITY: periodicity(cache, sessions) };
const disc = JSON.parse(fs.readFileSync(path.join(DATA, "r163-discovery.json"), "utf8")).results;
const hold = JSON.parse(fs.readFileSync(path.join(DATA, "r163-holdout.json"), "utf8")).contextAll;
const inWin = sessions.filter((d) => d >= DISC[0] && d <= HOLD[1]), window = [inWin[0], inWin[inWin.length - 1]];

for (const p of PATTERNS) {
  const daily = real[p], sd = summarise(daily, ...DISC), sh = summarise(daily, ...HOLD);
  const series = Object.keys(daily).filter((d) => d >= DISC[0] && d <= HOLD[1] && (p === "PERIODICITY" || daily[d].n > 0)).sort().map((d) => ({ d, r: daily[d].net }));
  const allDays = Object.keys(daily).filter((d) => d >= DISC[0] && d <= HOLD[1]).length, missing = inWin.length - allDays;
  const mD = Math.abs(sd.tNW - disc[p].tNW) <= 0.02, mH = Math.abs(sh.tNW - hold[p].tNW) <= 0.02;
  writeEntry({
    id: `R163-${p}`, name: `R163 intraday ${p} (30-min bars)`, registryId: "R163", script: "backend/r163-intraday.js", emitter: "backend/ensemble/emit/r163.js",
    unit: "daily", net: true, costModel: p === "PERIODICITY" ? "0.05% per round trip on both legs every interval (2 x 0.05% per session on the spread)" : "0.05% per round trip per position, charged every session with a position",
    window, calendar: "us-equity", series,
    reproduction: { statistic: "discovery Newey-West t (lag 5) of per-session net return, 2017-01..2021-12 (the sealed screen)", sealed: disc[p].tNW, emitted: sd.tNW, tolerance: 0.02, match: mD && mH,
      holdout: { statistic: "holdout NW t (lag 5), weightless context", sealed: hold[p].tNW, emitted: sh.tNW, match: mH } },
    construction: p === "PERIODICITY"
      ? "Per session: for each half-hour interval 1..12, long the top and short the bottom quintile of the 100 names by their mean interval return over the prior 5 sessions; day r = mean interval spread - 2 x 0.05%. Flat overnight; booked on the session date."
      : "Per session: equal weight across the pattern's positions that session (the script's mean over positions of pos x intraday return - 0.05%); all positions are closed at the 16:00 close, booked on the session date; sessions with no position are cash.",
    notes: `Discovery emitted net ${sd.netBpsPerDay} bps/day (sealed ${disc[p].netBpsPerDay}), ${sd.sessions} sessions (sealed ${disc[p].sessions}); holdout ${sh.netBpsPerDay} bps/day t ${sh.tNW}. Sessions in window with no event row at all (absent from the script's statistic, 0 here): ${missing}. Discovery carried 0 of 6; verdict DID NOT PASS.`,
  });
}
