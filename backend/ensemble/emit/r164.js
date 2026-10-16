#!/usr/bin/env node
"use strict";
/**
 * EMITTER R164 — PENSION_REBAL: front-running month-end pension rebalancing, SPY vs TLT equal-dollar spread. READ-ONLY.
 *
 * backend/hunt/PENSION_REBAL.js runs its main on require() (no require.main guard), so the rule is COPIED verbatim:
 * constants (lines 56-59), mean/nwT/ok/ymOf (63-68), monthPlan (72-83), signals (85-93), simulate (95-110), loadReal (137-150),
 * and the monthly net/NW-t summary pieces of summarise (111-122). Both sealed windows are reproduced exactly as the script loads them:
 * DISCOVERY (prices 2016-10-01..2021-12-31, completeThrough 2021-12, returns realised 2017-01-01..2021-12-31) and HOLDOUT (prices
 * 2021-10-01..2026-09-22, returns realised 2022-01-01..2026-09-22). The two realisation windows are disjoint.
 *
 * Daily series: every trade record's NET return (pos x (TLT next-day return - SPY next-day return) - 0.0004 when pos != 0) booked on
 * its realisation date u — the position is opened at the signal-day close and closed at the next close, so it is a one-day hold.
 */
const fs = require("fs"), path = require("path");
const { writeEntry } = require("../lib-entry.js");

// ---- copied from backend/hunt/PENSION_REBAL.js ----
const COST_LEG = 0.0002, LEGS = 2, SIGNAL_DAYS = 5, NW_LAG = 3;
const DISC = ["2017-01-01", "2021-12-31"], HOLD = ["2022-01-01", "2026-09-22"];
const DISC_FETCH = { start: "2016-10-01", end: "2021-12-31T23:59:59Z", priceEnd: DISC[1], completeThrough: "2021-12" };
const HOLD_FETCH = { start: "2021-10-01", end: "2026-09-22T23:59:59Z", priceEnd: HOLD[1], completeThrough: null };
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
function nwT(a, L = NW_LAG) { const n = a.length; if (n < 6) return null; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n; for (let k = 1; k <= L; k++) { let c = 0; for (let i = k; i < n; i++) c += d[i] * d[i - k]; v += 2 * (1 - k / (L + 1)) * c / n; } return v > 0 ? m / Math.sqrt(v / n) : null; }
const ok = (x) => Number.isFinite(x) && x > 0;
const r3 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(3));
const ymOf = (d) => d.slice(0, 7);
function monthPlan(dates, completeThrough = null) {
  const plan = [];
  let a = 0;
  while (a < dates.length) {
    const ym = ymOf(dates[a]); let b = a; while (b + 1 < dates.length && ymOf(dates[b + 1]) === ym) b++;
    const complete = b + 1 < dates.length || (completeThrough != null && ym <= completeThrough);
    const pme = a - 1;
    if (complete && pme >= 0) for (let t = Math.max(a, b - SIGNAL_DAYS + 1); t <= b; t++) plan.push({ t, pme });
    a = b + 1;
  }
  return plan;
}
function signals(dates, S, T, completeThrough = null) {
  const out = [];
  for (const { t, pme } of monthPlan(dates, completeThrough)) {
    if (!(ok(S[t]) && ok(T[t]) && ok(S[pme]) && ok(T[pme]))) continue;
    const drift = (S[t] / S[pme] - 1) - (T[t] / T[pme] - 1);
    out.push({ t, u: t + 1, drift, pos: drift > 0 ? 1 : drift < 0 ? -1 : 0 });
  }
  return out;
}
function simulate(dates, S, T, win, { completeThrough = null, peek = false } = {}) {
  const recs = [];
  for (const sg of signals(dates, S, T, completeThrough)) {
    if (sg.u >= dates.length) continue;
    const d = dates[sg.u]; if (d < win[0] || d > win[1]) continue;
    if (!(ok(S[sg.u]) && ok(T[sg.u]))) continue;
    const spread = (T[sg.u] / T[sg.t] - 1) - (S[sg.u] / S[sg.t] - 1);
    const pos = peek ? Math.sign(spread) : sg.pos;
    const gross = pos * spread, net = gross - (pos ? LEGS * COST_LEG : 0);
    recs.push({ signalDate: dates[sg.t], date: d, drift: sg.drift, pos, gross, net });
  }
  const months = [...new Set(dates.filter((d, i) => d >= win[0] && d <= win[1] && ok(S[i]) && ok(T[i])).map(ymOf))].sort();
  const byM = new Map(months.map((m) => [m, { ym: m, net: 0, gross: 0, trades: 0 }]));
  for (const r of recs) { const m = byM.get(ymOf(r.date)); if (!m) continue; m.net += r.net; m.gross += r.gross; if (r.pos) m.trades++; }
  return { recs, monthly: months.map((m) => byM.get(m)) };
}
async function loadReal(F, minDaysInWindow, win) {
  const { fetchBars } = require("../../lib/alpaca-bars.js");
  const r = await fetchBars(["SPY", "TLT"], { start: F.start, end: F.end, timeframe: "1Day", feed: "sip", adjustment: "all", quiet: true, requireAll: true });
  const mk = (s) => new Map(r.bars[s].map((b) => [String(b.t).slice(0, 10), b.c]));
  const ms = mk("SPY"), mt = mk("TLT");
  const dates = [...ms.keys()].filter((d) => mt.has(d) && d <= F.priceEnd).sort();
  const S = dates.map((d) => ms.get(d)), T = dates.map((d) => mt.get(d));
  if (!S.every(ok) || !T.every(ok)) throw new Error("non-positive or missing close in loaded data");
  const inWin = dates.filter((d) => d >= win[0] && d <= win[1]).length;
  if (inWin < minDaysInWindow) throw new Error(`only ${inWin} common SPY/TLT days in ${win.join("..")}, need >= ${minDaysInWindow}`);
  for (let i = 1; i < dates.length; i++) { const gap = (Date.parse(dates[i]) - Date.parse(dates[i - 1])) / 864e5; if (gap > 5) throw new Error(`calendar gap ${dates[i - 1]} -> ${dates[i]} (${gap}d)`); }
  if (ms.size !== mt.size) throw new Error(`SPY ${ms.size} vs TLT ${mt.size} bars — unmatched calendars`);
  return { dates, S, T };
}
// ---- end copy ----

(async () => {
  const Rd = await loadReal(DISC_FETCH, 1200, DISC), simD = simulate(Rd.dates, Rd.S, Rd.T, DISC, { completeThrough: DISC_FETCH.completeThrough });
  const Rh = await loadReal(HOLD_FETCH, 1100, HOLD), simH = simulate(Rh.dates, Rh.S, Rh.T, HOLD, { completeThrough: HOLD_FETCH.completeThrough });
  const tD = nwT(simD.monthly.map((x) => x.net)), tH = nwT(simH.monthly.map((x) => x.net));
  const recs = [...simD.recs, ...simH.recs].filter((r) => r.pos !== 0);
  const byD = new Map(); for (const r of recs) { if (byD.has(r.date)) throw new Error(`two trades realised on ${r.date}`); byD.set(r.date, r.net); }
  const series = [...byD.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, r]) => ({ d, r }));
  // cross-check against the persisted discovery monthly series
  let maxDiff = null; try { const disc = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "data", "hunt", "PENSION_REBAL-discovery.json"), "utf8")); const m = new Map(simD.monthly.map((x) => [x.ym, x.net])); maxDiff = Math.max(...disc.monthly.map((x) => Math.abs(x.net - (m.get(x.ym) ?? NaN)))); } catch {}
  console.log(`R164: discovery ${simD.monthly.length} months tNW ${r3(tD)} · holdout ${simH.monthly.length} months tNW ${r3(tH)} · ${series.length} trade days · persisted discovery monthly max|diff| ${maxDiff}`);
  const firstSession = Rd.dates.find((d) => d >= DISC[0]);
  const sH = 0.679, sD = 0.212, tol = 0.02, eH = r3(tH), eD = r3(tD);
  writeEntry({
    id: "R164", name: "Pension rebalancing SPY/TLT", registryId: "R164", script: "backend/hunt/PENSION_REBAL.js", emitter: "backend/ensemble/emit/r164.js",
    unit: "daily", net: true, costModel: "0.02% per leg per traded day, two legs -> 0.04% on every day with a non-zero position",
    window: [firstSession, HOLD[1]], calendar: "us-equity", series,
    reproduction: { statistic: "holdout net NW t (lag 3) of monthly summed daily net spread", sealed: sH, emitted: eH, tolerance: tol, match: Math.abs(eH - sH) <= tol && Math.abs(eD - sD) <= tol,
      discovery: { sealed: sD, emitted: eD, match: Math.abs(eD - sD) <= tol } },
    construction: "On each of the last 5 sessions of a month, sign of (SPY minus TLT return since the previous month-end) sets a one-day equal-dollar spread (drift>0: long TLT/short SPY; <0 the reverse) held close-to-close into the next session; that day's net spread return (gross minus 0.04%) is booked on the realisation date. Discovery (2017-2021) and holdout (2022-2026-09-22) sealed runs concatenated; no other days trade.",
    notes: `Returns are per unit of one leg's notional (equal-dollar long/short, as the script scores it). ${series.length} trade days. Persisted discovery monthly net max |diff| ${maxDiff == null ? "n/a" : maxDiff.toExponential(1)}.`,
  });
})().catch((e) => { console.error("R164 emitter FAILED:", e.message); process.exit(1); });
