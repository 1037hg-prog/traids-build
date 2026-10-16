#!/usr/bin/env node
/**
 * R312 — US-vs-EUROPE RATE CARRY WITH A 12-MONTH TREND FILTER (registered 2026-10-02; operator: "test it").
 * The frozen spec is the R312 entry of data/test-registry.json (preregistered). This runner implements that entry and nothing else.
 * Harness pattern from r310-qs-rsi5.js: selftest -> controls run (scrambles + calibration only) -> one --read.
 *
 *   DATA     FRED fredgraph.csv (no key), cached ONCE under data/training/r312/raw/ (one CSV per series, byte-for-byte as served).
 *            The controls run and the read use the same bytes: a sha256 per file plus a combined sha over the sorted manifest is
 *            written into both outputs and the read refuses on a mismatch. The read never refetches. --refresh-cache (controls mode
 *            only) re-downloads every series (do it after the Monday H.10 release that carries the final month's last fixings).
 *              spot   DEXUSEU (USD per EUR), DEXUSUK (USD per GBP), DEXSZUS (CHF per USD -> inverted to USD per CHF)
 *                     reported pool only: DEXJPUS (inverted), DEXCAUS (inverted), DEXUSAL
 *              rates  OECD 3-month interbank, monthly averages: IR3TIB01{US,EZ,GB,CH}M156N; pool only {JP,CA,AU}
 *              fills  DTB3 (US), ECBDFR (EUR), IUDSOIA (GBP SONIA; per month, else carried flat); CHF flat; JP/CA/AU flat (pool only)
 *   MONTH    month-end spot = the last available daily fixing dated in the calendar month (blank rows skipped).
 *   FILL     a month with no OECD value AFTER the series has begun (after its end, or an interior hole — US 2020-04 is one) takes the
 *            last observed OECD value L shifted by the change in the country's daily rate since then, measured as
 *            mean(daily over month m) - mean(daily over month L) (calendar-month means, to match the OECD monthly averages).
 *            US/EUR: the daily rate is required (a month without it is UNKNOWN, never guessed); GBP: SONIA if both monthly means
 *            exist, else carried flat; CHF flat. Every filled month is listed with its method. (The registry says "after a rate
 *            series ends"; extending the same rule to an interior hole is this runner's reading — disclosed in every output.)
 *   RETURN   month i (decision at the end of i-1), F = S[i-1] * (1 + rUS[i-1]/1200) / (1 + rF[i-1]/1200) (the 1-month CIP forward):
 *            long foreign = S[i]/F - 1 (USD P&L per USD of forward notional). S = USD per foreign unit.
 *            short foreign, AS REGISTERED ("return:registered", the default) = F/S[i] - 1 = 1/(1 + long) - 1 — this is the long-USD
 *              return measured in FOREIGN currency; it exceeds the USD P&L of a short 6E/6B/6S future by (1-x)^2/x >= 0, x = S[i]/F,
 *              in every month (review 2026-10-02).
 *            short foreign under "return:usd-numeraire" (honoured only with a preEvidence registry amendment naming it) = -(long) =
 *              1 - S[i]/F: the USD P&L per USD of notional a short future earns. The trend filter compounds whichever returns are in force.
 *            The read always reports the registered-formula statistic beside the one in force.
 *   RULE     gap = rUS[i-1] - rF[i-1]; |gap| < 0.25 -> flat; gap > 0 -> candidate SHORT foreign; gap < 0 -> candidate LONG foreign.
 *            Trend filter: hold the candidate only if that same position's compounded excess return over months i-12..i-1 is > 0.
 *            Portfolio = mean of the three legs (a flat leg contributes 0 return). COST per leg-month: 0.03% x |p[i] - p[i-1]| +
 *            0.01% x |p[i]| (position before the first window month = flat; an exit is charged in the month the leg goes flat; no
 *            terminal exit charge).
 *   WINDOW   first return month at which all three legs have 12 prior months of returns (expected 2000-08, decided at the 2000-07
 *            month end) through 2026-09. nExpected 314.
 *   STAT     per month the portfolio net excess return; headline Newey-West t, lag 1 (the register's nwT, Bartlett 0.5 at lag 1).
 *   GATES    (registry decisionRule) >= 240 months, mean > 0, t_NW >= bar (READ FROM THE REGISTRY), random-direction placebo p95
 *            beaten (1,000 draws, seed 312), carry adds over trend-only (mean paired monthly difference > 0), both halves > 0,
 *            post-2008 (months from 2009-01) mean > 0. CANNOT MEASURE if < 240 months or any currency's decision-time rate is filled
 *            in > 10% of its window months (US counted as its own currency), or a return inside the window cannot be computed.
 *   READINGS (builder's, disclosed) (a) the registered placebo charges each random draw ITS OWN turnover cost (it is a strategy run
 *            the same way); a same-cost and a month-flip form are reported beside it. (b) "carry vs trend-only: the same legs" =
 *            the same three currency legs, every window month, direction = sign of the 12-month compounded long-foreign excess
 *            return, no rate gate, no dead zone, same cost model. (Read as "the same active leg-months" the control is identically
 *            zero — on an R312-active leg-month the trend sign always equals the carry sign — and the gate could never pass.)
 *   TOKENS   (review 2026-10-02) the gate set in force comes from preEvidence registry amendments (RUNNER_GATES): return:*, placebo:*,
 *            leak:*, calibration:accept. An amendment without runnerGates, or with [], changes nothing and lifts no hold. The read
 *            refuses until a return:* token is recorded (the registered short formula is in the wrong numeraire), and refuses unless
 *            the controls were run under exactly the registry's tokens, at the registry bar, by this runner, on this cache.
 *
 *   CALIBRATION (lesson of R310: a registered placebo that cannot fail). Before any read, the FULL decision rule IN FORCE (registry
 *   tokens at controls time) is run on no-edge scrambles and the false-pass rate of each gate and of the whole rule is written to
 *   data/r312-controls.json (and, while the registry carries no amendment, the PROPOSED gate set is calibrated beside it, reported):
 *     USD-FAIR NULL (primary when "return:usd-numeraire" is in force): per currency the realised simple long-foreign excess
 *       l = S[i]/F - 1 is demeaned, resampled (joint permutation / with replacement / shared sign flip), and S rebuilt as F(1 + l'),
 *       so E[S/F] = 1 in-sample: every USD position (long or short) has zero expected excess, no Jensen tilt. Power worlds use the
 *       same construction around S[i-1] * exp(theta * ln(F/S[i-1])): theta 0 = spot a martingale (carry earns the gap, Fama beta 0),
 *       theta -1 = 2x the gap, theta -2 = 3x.
 *     UIP-NULL (log-fair; primary for the registered formula): per currency the real monthly log spot changes over the window's return months are demeaned, shuffled
 *       across months with ONE seeded permutation shared by the three currencies (keeps their cross-correlation), then the rate gap
 *       is added back: ln S[i] - ln S[i-1] = eps + ln(1 + rUS[i-1]/1200) - ln(1 + rF[i-1]/1200), so every position's expected LOG
 *       excess return is exactly zero (the foreign currency depreciates by the differential on average). Rates as observed.
 *       An independent-permutation form is run beside it.
 *     REGISTERED LEAK SCRAMBLE: spot log changes shuffled across months within each currency (independently), not demeaned, rates
 *       kept — NOT a no-edge null for carry (the real rate income and the spot drift survive); its |t| distribution is reported.
 *     TREND-EDGE NULL: UIP-null plus a planted trend premium (each month's log excess += 0.4% x sign of its own past 12 months) —
 *       carry adds nothing; measures how often the rule credits carry for a trend edge.
 *     POWER: random-walk spot (UIP fails fully: carry earns the whole gap) and half-carry; share of seeds on which the rule PASSES.
 *   Positive control: positions = sign of the realised month's excess return (look-ahead), every leg every month — t >= 3 on the real
 *   panel and on UIP-null seed 1. Known-answer CIP arithmetic, DEXSZUS inversion, timing and fill checks are in the selftest.
 *
 *   node backend/r312-europe-carry.js --selftest | (no flag: controls run; prints READY / NOT READY) [--refresh-cache] | --read
 *   The forward futures record is backend/r312-forward-record.js (shares decideMonth/buildPanel/legReturns from this file).
 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const ID = "R312";
const ARGV = process.argv.slice(2);
const READ = ARGV.includes("--read"), SELFTEST_ONLY = ARGV.includes("--selftest"), REFRESH = ARGV.includes("--refresh-cache");
const OUT = D("r312-europe-carry.json"), CTRL = D("r312-controls.json");
const CACHE_DIR = path.join(__dirname, "data", "training", "r312", "raw"), CACHE_REL = "backend/data/training/r312/raw";
const FRED_URL = (id) => `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}`;

const US = { rate: "IR3TIB01USM156N", fill: "DTB3", fillPolicy: "required" };
const CCY = {
  EUR: { spot: "DEXUSEU", invert: false, rate: "IR3TIB01EZM156N", fill: "ECBDFR", fillPolicy: "required", root: "6E", micro: "M6E", microNotional: 12500 },
  GBP: { spot: "DEXUSUK", invert: false, rate: "IR3TIB01GBM156N", fill: "IUDSOIA", fillPolicy: "prefer", root: "6B", micro: "M6B", microNotional: 6250 },
  CHF: { spot: "DEXSZUS", invert: true, rate: "IR3TIB01CHM156N", fill: null, fillPolicy: "flat", root: "6S", micro: "MSF", microNotional: 12500 },
  JPY: { spot: "DEXJPUS", invert: true, rate: "IR3TIB01JPM156N", fill: null, fillPolicy: "flat" },
  CAD: { spot: "DEXCAUS", invert: true, rate: "IR3TIB01CAM156N", fill: null, fillPolicy: "flat" },
  AUD: { spot: "DEXUSAL", invert: false, rate: "IR3TIB01AUM156N", fill: null, fillPolicy: "flat" },
};
const TRIO = ["EUR", "GBP", "CHF"], POOL6 = ["EUR", "GBP", "CHF", "JPY", "CAD", "AUD"];
const SERIES = [...new Set([US.rate, US.fill, ...POOL6.flatMap((c) => [CCY[c].spot, CCY[c].rate, CCY[c].fill].filter(Boolean))])];
const PANEL_FROM = "1999-01", LAST_MONTH = "2026-09", N_EXPECTED = 314;
const DEAD_ZONE = 0.25, TREND_N = 12, COST_TRADE = 0.0003, COST_HOLD = 0.0001;
const MIN_MONTHS = 240, MAX_FILL_SHARE = 0.10, POST2008_FROM = "2009-01";
const PLACEBO_DRAWS = 1000, PLACEBO_SEED = 312;
// seed counts: >= 400 on every null and power world the tolerance or the fail-branch power figures rest on (review 2026-10-02: 60/100 seeds under-read power)
const CAL = { primary: 400, independent: 200, bootstrap: 400, flip: 400, registeredLeak: 200, trendEdge: 200, power: 400, powerExtra: 200, trendEdgeMu: 0.004 };
const CAL_TOLERANCE = 0.075;   // whole-rule false-pass share on any primary-family null (perm / with replacement / flip) above this holds the read
// Pre-read decision tokens this runner understands (R312 registry entry: amendments[] { date, preEvidence: true, field, was, becomes,
// why, runnerGates: [...] }). No runnerGates token = the registered design. At most one token per family; unknown -> read refused.
const RUNNER_GATES = {
  "leak:registered": "read precondition = the registered leak test (spot log changes shuffled across months within each currency, not demeaned, rates kept, seed 1): |t_NW| < 2",
  "leak:uip-null": "read precondition = the no-edge-null leak test (seed 1; the USD-fair null when return:usd-numeraire is in force, else the log-fair UIP-null; rates kept): |t_NW| < 2. The registered shuffle is reported only (it keeps the real rate income, so it measures carry, not a leak)",
  "leak:registered-else-uip-null": "read precondition = the registered leak test |t_NW| < 2; if it fails while the no-edge-null leak test (seed 1, the null in force) passes, that is the registered shuffle's construction bias (it separates each month's UIP depreciation from that month's rate gap: t centres near +0.5 with no premium and rises with the premium under test) and the read proceeds; if BOTH fail the read is held for code review",
  "placebo:registered": "random-direction placebo as registered: independent +-1 per active leg-month, each draw charged its own turnover cost; observed mean > p95",
  "placebo:same-cost": "random-direction placebo with every draw charged the OBSERVED cost series (direction only); observed mean > p95",
  "placebo:month-flip": "placebo = one random sign per month applied to every active leg's observed direction (keeps cross-currency structure), charged the observed cost series; observed mean > p95",
  "return:registered": "short foreign = F/S1 - 1 as registered (the long-USD return measured in FOREIGN currency); long foreign = S1/F - 1",
  "return:usd-numeraire": "short foreign = -(long foreign) = 1 - S1/F: the USD P&L per USD of notional a short 6E/6B/6S future earns; long unchanged (S1/F - 1); the trend filter compounds these returns; calibration primary = the USD-fair null (E[S1/F] = 1)",
  "calibration:accept": "lifts the whole-rule over-tolerance hold for ONE controls run only: the amendment carrying it must name that run's asOf in a controlsAsOf field (so it can only be written after the miscalibration was seen)",
};
const TOKEN_FAMILIES = ["leak", "placebo", "return", "calibration"];
const CTRL_SPEC = "r312-controls-v2";
// The gate set this review proposes (calibrated beside the in-force set while the registry carries no amendment; reported only).
const PROPOSED_TOKENS = ["return:usd-numeraire", "placebo:same-cost", "leak:registered-else-uip-null"];
const fin = Number.isFinite;
const r4 = (x) => (x == null || !fin(x) ? null : +x.toFixed(4)), r3 = (x) => (x == null || !fin(x) ? null : +x.toFixed(3)), r6 = (x) => (x == null || !fin(x) ? null : +x.toFixed(6));
const pc = (x) => (x == null || !fin(x) ? null : +(100 * x).toFixed(1));

// ── months ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
function addM(m, k) { let y = +m.slice(0, 4), mo = +m.slice(5, 7) + k; while (mo < 1) { mo += 12; y--; } while (mo > 12) { mo -= 12; y++; } return `${y}-${String(mo).padStart(2, "0")}`; }
function monthsBetween(a, b) { const out = []; for (let m = a; m <= b; m = addM(m, 1)) out.push(m); return out; }

// ── FRED parsing ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// fredgraph.csv: header "observation_date,<ID>", one row per date, a blank value for a missing observation. Returns [{ d, v }] of the
// non-blank numeric rows in date order. A header naming another series throws (fail closed).
function parseFred(text, id) {
  const lines = String(text).replace(/^﻿/, "").trim().split(/\r?\n/);
  const head = (lines[0] || "").split(",");
  if (head[0] !== "observation_date" || head[1] !== id) throw new Error(`FRED ${id}: unexpected header ${JSON.stringify(lines[0])}`);
  const out = [];
  for (let k = 1; k < lines.length; k++) {
    const [d, v] = lines[k].split(",");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`FRED ${id}: bad date row ${JSON.stringify(lines[k])}`);
    if (v === undefined || v === "" || v === ".") continue;
    const x = Number(v); if (!fin(x)) throw new Error(`FRED ${id}: non-numeric value ${JSON.stringify(lines[k])}`);
    out.push({ d, v: x });
  }
  for (let k = 1; k < out.length; k++) if (out[k].d <= out[k - 1].d) throw new Error(`FRED ${id}: dates not increasing at ${out[k].d}`);
  return out;
}
/** month -> { v, d } = the last non-blank fixing dated in that calendar month (inverted when the series is foreign per USD). */
function monthEndSpot(rows, invert) {
  const m = new Map();
  for (const r of rows) { if (!(r.v > 0)) continue; m.set(r.d.slice(0, 7), { v: invert ? 1 / r.v : r.v, d: r.d, raw: r.v }); }
  return m;
}
const monthlyOecd = (rows) => new Map(rows.map((r) => [r.d.slice(0, 7), r.v]));
function monthlyMean(rows) { const s = new Map(); for (const r of rows) { const k = r.d.slice(0, 7), a = s.get(k) || [0, 0]; a[0] += r.v; a[1]++; s.set(k, a); } return new Map([...s].map(([k, [x, n]]) => [k, x / n])); }

// ── rates with the registered fill rule ──────────────────────────────────────────────────────────────────────────────────
function rateSeries(raw, oecdId, fillId, policy, months) {
  const oecd = monthlyOecd(raw[oecdId] || []), keys = [...oecd.keys()].sort(), first = keys[0] || null;
  const avg = fillId && raw[fillId] && raw[fillId].length ? monthlyMean(raw[fillId]) : null;
  const r = [], filled = [], info = [];
  for (const m of months) {
    if (oecd.has(m)) { r.push(oecd.get(m)); filled.push(false); info.push(null); continue; }
    if (!first || m < first) { r.push(null); filled.push(false); info.push(null); continue; }          // before the series begins: absent, not filled
    let L = null; for (let k = keys.length - 1; k >= 0; k--) if (keys[k] < m) { L = keys[k]; break; }
    const base = oecd.get(L), haveShift = !!(avg && avg.has(m) && avg.has(L));
    if (policy === "required" && !haveShift) { r.push(null); filled.push(true); info.push({ month: m, from: L, method: "UNKNOWN", why: `${fillId} has no observation in ${avg && avg.has(L) ? m : L}` }); continue; }
    if ((policy === "required" || policy === "prefer") && haveShift) { const sh = avg.get(m) - avg.get(L); r.push(base + sh); filled.push(true); info.push({ month: m, from: L, method: `shift ${fillId}`, base: r6(base), shift: r6(sh), value: r6(base + sh) }); continue; }
    r.push(base); filled.push(true); info.push({ month: m, from: L, method: policy === "prefer" ? `flat (${fillId} absent)` : "flat", base: r6(base), value: r6(base) });
  }
  return { r, filled, info };
}

// ── panel ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const NUMERAIRES = ["registered", "usd"];
function buildPanel(raw, ccys, { from = PANEL_FROM, lastMonth = LAST_MONTH, numeraire = "registered" } = {}) {
  if (!NUMERAIRES.includes(numeraire)) throw new Error(`buildPanel: unknown numeraire ${numeraire}`);
  const months = monthsBetween(from, lastMonth), us = rateSeries(raw, US.rate, US.fill, US.fillPolicy, months), legs = {};
  for (const c of ccys) {
    const cfg = CCY[c]; if (!cfg) throw new Error(`unknown currency ${c}`);
    if (!raw[cfg.spot]) throw new Error(`series ${cfg.spot} missing from the raw set`);
    const sp = monthEndSpot(raw[cfg.spot], cfg.invert), rt = rateSeries(raw, cfg.rate, cfg.fill, cfg.fillPolicy, months);
    legs[c] = { S: months.map((m) => (sp.has(m) ? sp.get(m).v : null)), sDate: months.map((m) => (sp.has(m) ? sp.get(m).d : null)), rF: rt.r, rFfilled: rt.filled, rFinfo: rt.info };
  }
  return { months, rUS: us.r, rUSfilled: us.filled, rUSinfo: us.info, legs, ccys: [...ccys], numeraire };
}
/** Excess returns of month i for one leg (null where an input is missing). first = first computable i.
 *  long = S1/F - 1 (USD per USD of forward notional) in both numeraires; short = F/S1 - 1 as registered, or -long under "usd". */
function legReturns(panel, c) {
  const L = panel.legs[c], n = panel.months.length, long = new Array(n).fill(null), short = new Array(n).fill(null), usd = panel.numeraire === "usd"; let first = null;
  if (panel.numeraire != null && !NUMERAIRES.includes(panel.numeraire)) throw new Error(`legReturns: unknown numeraire ${panel.numeraire}`);
  for (let i = 1; i < n; i++) {
    const S0 = L.S[i - 1], S1 = L.S[i], rU = panel.rUS[i - 1], rF = L.rF[i - 1];
    if (!(S0 > 0 && S1 > 0 && fin(rU) && fin(rF))) continue;
    if (usd) { const lg = (S1 / S0) * (1 + rF / 1200) / (1 + rU / 1200) - 1; long[i] = lg; short[i] = -lg; }   // a short future earns -1 x the long
    else { const sh = (S0 / S1) * (1 + rU / 1200) / (1 + rF / 1200) - 1; short[i] = sh; long[i] = 1 / (1 + sh) - 1; }   // registered arithmetic, unchanged
    if (first === null) first = i;
  }
  return { long, short, first };
}
/** The rule's decision at the end of month i-1 for holding month i. null when an input is missing (never guessed). */
function decideAt(panel, rets, c, i) {
  const L = panel.legs[c];
  if (i < 1) return null;
  const rU = panel.rUS[i - 1], rF = L.rF[i - 1];
  if (!fin(rU) || !fin(rF)) return null;
  const gap = Math.round((rU - rF) * 1e9) / 1e9;                       // guards 0.25000000000000006-style float noise at the dead zone
  const cand = Math.abs(gap) < DEAD_ZONE ? 0 : gap > 0 ? -1 : 1;
  let pl = 1, ps = 1;
  for (let k = i - TREND_N; k <= i - 1; k++) { if (k < 1 || rets.long[k] == null || rets.short[k] == null) return null; pl *= 1 + rets.long[k]; ps *= 1 + rets.short[k]; }
  const cumLong = pl - 1, cumShort = ps - 1, cumCand = cand === 1 ? cumLong : cand === -1 ? cumShort : null;
  const pos = cand !== 0 && cumCand > 0 ? cand : 0;
  return { month: panel.months[i], decidedAtMonthEnd: panel.months[i - 1], rUS: rU, rF, gap, cand, cumLong, cumShort, pos,
    trendDir: cumLong > 0 ? 1 : cumLong < 0 ? -1 : 0, filledUS: !!panel.rUSfilled[i - 1], filledF: !!L.rFfilled[i - 1] };
}
/** Forward use: positions decided at the end of `decisionMonth` (YYYY-MM) for the following month. The panel must END at decisionMonth. */
function decideMonth(panel, ccys, decisionMonth) {
  const n = panel.months.length;
  if (panel.months[n - 1] !== decisionMonth) throw new Error(`decideMonth: panel ends ${panel.months[n - 1]}, decision month ${decisionMonth}`);
  // decideAt(i = n) reads only month n-1's rates and returns n-12..n-1 (spot through n-1); index n itself is never read
  const out = {};
  for (const c of ccys) {
    const rets = legReturns(panel, c), d = decideAt(panel, rets, c, n);
    out[c] = d ? { ...d, month: addM(decisionMonth, 1), decidedAtMonthEnd: decisionMonth, spotDate: panel.legs[c].sDate[n - 1], spot: panel.legs[c].S[n - 1] } : null;
  }
  return out;
}

// ── context: returns + decisions over the window ────────────────────────────────────────────────────────────────────────
function prepare(panel, ccys, { lastIndex = null } = {}) {
  const rets = {}, b = lastIndex == null ? panel.months.length - 1 : lastIndex;
  for (const c of ccys) rets[c] = legReturns(panel, c);
  const firsts = ccys.map((c) => rets[c].first);
  if (firsts.some((x) => x == null)) return { error: `no computable returns for ${ccys.filter((c, k) => firsts[k] == null).join(",")}` };
  const a = Math.max(...firsts), start = a + TREND_N, gaps = [];
  for (const c of ccys) for (let i = a; i <= b; i++) if (rets[c].long[i] == null) gaps.push(`${c} ${panel.months[i]}`);
  const dec = {}, idx = [];
  for (let i = start; i <= b; i++) idx.push(i);
  for (const c of ccys) { dec[c] = new Array(b + 1).fill(null); for (const i of idx) { dec[c][i] = decideAt(panel, rets[c], c, i); if (!dec[c][i]) gaps.push(`${c} decision ${panel.months[i]}`); } }
  return { panel, ccys, rets, dec, a, b, start, idx, keys: idx.map((i) => panel.months[i]), gaps };
}
const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
function posOf(ctx, c, i, mode) {
  const d = ctx.dec[c][i];
  if (mode === "carry") return d.pos;
  if (mode === "unfiltered") return d.cand;
  if (mode === "trend") return d.trendDir;
  if (mode === "oracle") return ctx.rets[c].long[i] > 0 ? 1 : -1;   // look-ahead (positive control only)
  throw new Error(`mode ${mode}`);
}
function runStrategy(ctx, mode, { costMult = 1 } = {}) {
  const legs = {};
  for (const c of ctx.ccys) {
    let prev = 0; const pos = [], gross = [], cost = [], net = [];
    for (const i of ctx.idx) {
      const p = posOf(ctx, c, i, mode), g = p === 1 ? ctx.rets[c].long[i] : p === -1 ? ctx.rets[c].short[i] : 0;
      const k = costMult * (COST_TRADE * Math.abs(p - prev) + COST_HOLD * Math.abs(p));
      pos.push(p); gross.push(g); cost.push(k); net.push(g - k); prev = p;
    }
    legs[c] = { pos, gross, cost, net };
  }
  const port = ctx.idx.map((_, j) => ctx.ccys.reduce((s, c) => s + legs[c].net[j], 0) / ctx.ccys.length);
  return { mode, costMult, legs, port };
}

// ── statistics ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
// the register's NW(lag 1) t: v = sum d^2 / n + sum d_i d_{i-1} / n (Bartlett 0.5 at lag 1, doubled); t = mean / sqrt(v / n)
function nwT(a) { const n = a.length; if (n < 3) return null; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n, c = 0; for (let i = 1; i < n; i++) c += d[i] * d[i - 1]; v += c / n; return v > 0 ? m / Math.sqrt(v / n) : null; }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hash = (s) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);
function nearestRank(sorted, q) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] : null; }
function seriesStats(series, keys) {
  const n = series.length; if (!n) return { n: 0, meanNet: null, meanNetPctPerMonth: null, tNet: null, winRate: null };
  const m = mean(series), t = nwT(series), h = Math.floor(n / 2), half = (s, k) => ({ meanNet: mean(s), meanNetPctPerMonth: r4(100 * mean(s)), months: s.length, from: k[0], to: k[k.length - 1] });
  const postIdx = keys.map((k, j) => (k >= POST2008_FROM ? j : -1)).filter((j) => j >= 0), post = postIdx.map((j) => series[j]);
  return { n, meanNet: m, meanNetPctPerMonth: r4(100 * m), tNet: t, winRate: series.filter((x) => x > 0).length / n,
    halves: { first: half(series.slice(0, h), keys.slice(0, h)), second: half(series.slice(h), keys.slice(h)) },
    post2008: { from: POST2008_FROM, months: post.length, meanNet: post.length ? mean(post) : null, meanNetPctPerMonth: post.length ? r4(100 * mean(post)) : null, positive: post.length ? mean(post) > 0 : false } };
}
// ── random-direction placebo (registered form + two reported forms, same draws) ─────────────────────────────────────────────
function placeboRun(ctx, base, { draws = PLACEBO_DRAWS, seed = PLACEBO_SEED, costMult = 1 } = {}) {
  const n = ctx.idx.length, L = ctx.ccys.length, denom = n * L;
  const legs = ctx.ccys.map((c) => ({ pos: base.legs[c].pos, long: ctx.idx.map((i) => ctx.rets[c].long[i]), short: ctx.idx.map((i) => ctx.rets[c].short[i]) }));
  let obsCost = 0; for (const c of ctx.ccys) for (const k of base.legs[c].cost) obsCost += k;
  const own = new Array(draws), same = new Array(draws), flip = new Array(draws);
  const rng = mulberry(seed);
  for (let k = 0; k < draws; k++) {
    let gross = 0, cost = 0;
    for (const lg of legs) { let prev = 0; for (let j = 0; j < n; j++) { const p0 = lg.pos[j]; let p = 0; if (p0 !== 0) { p = rng() < 0.5 ? 1 : -1; gross += p === 1 ? lg.long[j] : lg.short[j]; } cost += costMult * (COST_TRADE * Math.abs(p - prev) + COST_HOLD * Math.abs(p)); prev = p; } }
    own[k] = (gross - cost) / denom; same[k] = (gross - obsCost) / denom;
  }
  const rng2 = mulberry(seed * 7919 + 17);
  for (let k = 0; k < draws; k++) {
    let gross = 0;
    for (let j = 0; j < n; j++) { const s = rng2() < 0.5 ? 1 : -1; for (const lg of legs) { const p0 = lg.pos[j]; if (p0 === 0) continue; const p = s * p0; gross += p === 1 ? lg.long[j] : lg.short[j]; } }
    flip[k] = (gross - obsCost) / denom;
  }
  const q = (arr) => { const s = [...arr].sort((x, y) => x - y); return { p95: s[Math.floor(0.95 * draws)], p50: s[Math.floor(0.5 * draws)], p05: s[Math.floor(0.05 * draws)], meanOfDraws: mean(arr) }; };
  return { draws, seed, registered: q(own), sameCost: q(same), monthFlip: q(flip) };
}

// ── the full registered decision rule on one panel (pure; used by the read AND by every calibration scramble) ──────────────────
function fillShares(ctx) {
  const n = ctx.idx.length, out = { US: { filled: 0, months: n, list: [] } };
  for (const i of ctx.idx) if (ctx.panel.rUSfilled[i - 1]) { out.US.filled++; out.US.list.push({ heldMonth: ctx.panel.months[i], rateMonth: ctx.panel.months[i - 1], ...(ctx.panel.rUSinfo[i - 1] || {}) }); }
  for (const c of ctx.ccys) { out[c] = { filled: 0, months: n, list: [] }; for (const i of ctx.idx) if (ctx.panel.legs[c].rFfilled[i - 1]) { out[c].filled++; out[c].list.push({ heldMonth: ctx.panel.months[i], rateMonth: ctx.panel.months[i - 1], ...(ctx.panel.legs[c].rFinfo[i - 1] || {}) }); } }
  for (const k of Object.keys(out)) out[k].share = n ? out[k].filled / n : null;
  return out;
}
function evaluateRule(ctx, { bar, draws = PLACEBO_DRAWS, seed = PLACEBO_SEED, placeboForm = "registered" } = {}) {
  if (ctx.error) return { error: ctx.error, cannotMeasure: true, cannotMeasureWhy: [ctx.error], gates: null, wholeRulePass: false, S: null };
  if (ctx.gaps.length) return { error: `window returns/decisions not computable: ${ctx.gaps.slice(0, 6).join("; ")}`, cannotMeasure: true, cannotMeasureWhy: [`window returns/decisions not computable (${ctx.gaps.length})`], gates: null, wholeRulePass: false, S: null };
  const carry = runStrategy(ctx, "carry"), trend = runStrategy(ctx, "trend"), S = seriesStats(carry.port, ctx.keys), pl = placeboRun(ctx, carry, { draws, seed });
  const diff = carry.port.map((x, j) => x - trend.port[j]), diffMean = mean(diff), fills = fillShares(ctx);
  const overFill = Object.entries(fills).filter(([, v]) => v.share > MAX_FILL_SHARE).map(([k, v]) => `${k} ${pc(v.share)}%`);
  const unknownFill = Object.entries(fills).flatMap(([k, v]) => v.list.filter((x) => x.method === "UNKNOWN").map((x) => `${k} ${x.rateMonth}`));
  const cm = [];
  if (S.n < MIN_MONTHS) cm.push(`${S.n} months < ${MIN_MONTHS}`);
  if (overFill.length) cm.push(`rate filled in > 10% of months: ${overFill.join(", ")}`);
  if (unknownFill.length) cm.push(`fill rate unknown: ${unknownFill.join(", ")}`);
  const plForm = pl[placeboForm === "same-cost" ? "sameCost" : placeboForm === "month-flip" ? "monthFlip" : "registered"];
  const gates = {
    monthsAtLeast240: S.n >= MIN_MONTHS,
    meanNetPositive: S.meanNet != null && S.meanNet > 0,
    tAtLeastBar: S.tNet != null && fin(bar) && S.tNet >= bar,
    placeboP95Beaten: S.meanNet != null && S.meanNet > plForm.p95,
    carryAddsOverTrendOnly: diffMean != null && diffMean > 0,
    bothHalvesPositive: !!(S.halves && S.halves.first.meanNet > 0 && S.halves.second.meanNet > 0),
    post2008Positive: !!(S.post2008 && S.post2008.positive),
  };
  const wholeRulePass = !cm.length && Object.values(gates).every(Boolean);
  return { S, carry, trend, pl, placeboForm, diff, diffMean, diffT: nwT(diff), fills, cannotMeasure: cm.length > 0, cannotMeasureWhy: cm, gates, wholeRulePass,
    placeboAlt: { registered: S.meanNet > pl.registered.p95, sameCost: S.meanNet > pl.sameCost.p95, monthFlip: S.meanNet > pl.monthFlip.p95 } };
}
function verdictOf(ev) {
  if (ev.cannotMeasure) return `CANNOT MEASURE — ${ev.cannotMeasureWhy.join("; ") || ev.error}`;
  return ev.wholeRulePass ? "PASS" : "DID NOT PASS";
}

// ── scrambles (calibration only; each returns a NEW panel, rates untouched) ────────────────────────────────────────────────
// All three operate on return months [from..b] of the given currencies; spot before from-1 is blanked so nothing real leaks in.
function rebuildSpot(L, from, b, logChanges) {
  const S = new Array(L.S.length).fill(null); S[from - 1] = L.S[from - 1];
  for (let i = from; i <= b; i++) S[i] = S[i - 1] * Math.exp(logChanges[i - from]);
  return S;
}
function permutation(len, rng) { const p = Array.from({ length: len }, (_, k) => k); for (let k = len - 1; k > 0; k--) { const j = Math.floor(rng() * (k + 1)); [p[k], p[j]] = [p[j], p[k]]; } return p; }
/** kind: "uip" (demean, shuffle, add theta x the rate gap back; theta 1 default = log-fair UIP-null), "leak" (registered: raw log changes shuffled, nothing added), "rw" (demean,
 *  shuffle, nothing added = random-walk spot: carry earns the whole gap), "half" (demean, shuffle, add half the gap back),
 *  "trend" (uip + planted trend premium mu x sign of the constructed past 12 months). joint: one permutation for every currency.
 *  bootstrap: months drawn WITH replacement (one index draw shared when joint) instead of a permutation — the demeaned changes then no
 *  longer sum to exactly zero over the sample, which removes the finite-population compression a permutation imposes on t.
 *  resample "flip": months in place, each shock times a random sign (shared when joint). "usd" / "usdTrend": see below. */
function resampleIdx(len, rng) { return Array.from({ length: len }, () => Math.floor(rng() * len)); }
// resample "flip": months stay in place (vol timing, 2008 in 2008), each month's shock multiplied by a random sign (shared when joint).
function flipSigns(len, rng) { return Array.from({ length: len }, () => (rng() < 0.5 ? -1 : 1)); }
/** kind "usd" (USD-fair family): l = S[i]/F[i] - 1 on the real data (F = the CIP forward), demeaned, resampled, then
 *  S[i] = S[i-1] * exp(theta * ln(F[i]/S[i-1])) * (1 + l' (+ mu * sign of the constructed past 12 l')). theta 1 = USD-fair null
 *  (E[S/F] = 1: long S/F - 1 and short 1 - S/F both have zero expected excess); 0 = spot a martingale (carry earns the gap); -1 = 2x
 *  the gap; -2 = 3x. */
function scramblePanel(panel, ccys, { seed, kind = "uip", joint = true, bootstrap = false, resample = null, from, b = panel.months.length - 1, mu = CAL.trendEdgeMu, theta = 1 } = {}) {
  const how = resample || (bootstrap ? "boot" : "perm");
  if (!["perm", "boot", "flip"].includes(how)) throw new Error(`scramble: resample ${how}`);
  const out = { ...panel, legs: { ...panel.legs } }, len = b - from + 1, draw = how === "boot" ? resampleIdx : how === "flip" ? flipSigns : permutation, shared = draw(len, mulberry(seed * 1000003 + 312));
  const apply = (arr, d) => (how === "flip" ? arr.map((x, k) => d[k] * x) : d.map((k) => arr[k]));
  for (const c of ccys) {
    const L = panel.legs[c], dl = [];
    for (let i = from; i <= b; i++) { if (!(L.S[i - 1] > 0 && L.S[i] > 0)) throw new Error(`scramble: ${c} spot missing at ${panel.months[i]}`); dl.push(Math.log(L.S[i] / L.S[i - 1])); }
    const carryLog = (i) => Math.log(1 + panel.rUS[i - 1] / 1200) - Math.log(1 + L.rF[i - 1] / 1200);   // ln(F/S[i-1]); ln S change that makes log excess = eps
    const d = joint ? shared : draw(len, mulberry(seed * 1000003 + hash(c)));
    if (kind === "usd" || kind === "usdTrend") {
      const l = []; for (let i = from; i <= b; i++) l.push(L.S[i] / (L.S[i - 1] * Math.exp(carryLog(i))) - 1);
      const m0 = mean(l), e = apply(l.map((x) => x - m0), d), lx = [], ch = [];
      for (let k = 0; k < len; k++) {
        let add = 0; if (kind === "usdTrend" && k >= TREND_N) { let s = 0; for (let q = k - TREND_N; q < k; q++) s += lx[q]; add = mu * sgn(s); }
        lx.push(e[k] + add); if (!(1 + lx[k] > 0)) throw new Error(`scramble: ${c} constructed 1 + l <= 0`);
        ch.push(theta * carryLog(from + k) + Math.log(1 + lx[k]));
      }
      out.legs[c] = { ...L, S: rebuildSpot(L, from, b, ch) };
      continue;
    }
    const mu0 = kind === "leak" ? 0 : mean(dl), eps = dl.map((x) => x - mu0);
    const e = apply(eps, d);
    const ch = [];
    if (kind === "trend") {
      const lx = [];                                                   // constructed log excess of long foreign, month by month
      for (let k = 0; k < len; k++) { let add = 0; if (k >= TREND_N) { let s = 0; for (let q = k - TREND_N; q < k; q++) s += lx[q]; add = mu * sgn(s); } lx.push(e[k] + add); ch.push(lx[k] + carryLog(from + k)); }
    } else {
      const th = kind === "uip" ? theta : kind === "half" ? 0.5 : kind === "rw" || kind === "leak" ? 0 : null;
      if (th == null) throw new Error(`scramble: kind ${kind}`);
      for (let k = 0; k < len; k++) { const i = from + k; ch.push(e[k] + th * carryLog(i)); }
    }
    out.legs[c] = { ...L, S: rebuildSpot(L, from, b, ch) };
  }
  return out;
}

// ── pre-read decision (from the registry entry; never inferred) ─────────────────────────────────────────────────────────────
// amended = at least one token in force. An amendment with no runnerGates field, or with runnerGates [], changes no gate and NEVER
// lifts a hold (review 2026-10-02: any runnerGates array used to set amended=true and switch the over-tolerance hold off).
function preReadDecision(entry) {
  const am = (entry && Array.isArray(entry.amendments) ? entry.amendments : []).filter((a) => a && a.runnerGates !== undefined);
  const dflt = { leak: "registered", placebo: "registered", return: "registered", calibration: null };
  if (am.some((a) => !Array.isArray(a.runnerGates) || a.runnerGates.some((g) => typeof g !== "string"))) return { decided: false, why: "an amendment's runnerGates is not an array of strings" };
  const withTokens = am.filter((a) => a.runnerGates.length);
  if (!withTokens.length) return { decided: true, amended: false, ...dflt, numeraire: "registered", tokens: [], calibrationAccept: null, meaning: ["no runnerGates token: the registered design is in force"] };
  if (withTokens.some((a) => a.preEvidence !== true)) return { decided: false, why: "a runnerGates amendment is not marked preEvidence: true" };
  const tokens = [...new Set(withTokens.flatMap((a) => a.runnerGates))], unknown = tokens.filter((g) => !Object.prototype.hasOwnProperty.call(RUNNER_GATES, g));
  if (unknown.length) return { decided: false, why: `unknown runnerGates ${JSON.stringify(unknown)}` };
  const out = { decided: true, amended: true, ...dflt, tokens, dates: withTokens.map((a) => a.date || null), meaning: tokens.map((g) => `${g}: ${RUNNER_GATES[g]}`), calibrationAccept: null };
  for (const f of TOKEN_FAMILIES) { const t = tokens.filter((g) => g.startsWith(f + ":")); if (t.length > 1) return { decided: false, why: `more than one ${f}:* token (${t.join(", ")})` }; if (t.length) out[f] = t[0].slice(f.length + 1); }
  if (out.calibration === "accept") {
    const src = withTokens.filter((a) => a.runnerGates.includes("calibration:accept"));
    if (src.length !== 1 || typeof src[0].controlsAsOf !== "string" || !src[0].controlsAsOf) return { decided: false, why: "calibration:accept must sit in exactly one amendment that names the accepted controls run in controlsAsOf" };
    out.calibrationAccept = { controlsAsOf: src[0].controlsAsOf, date: src[0].date || null };
  }
  out.numeraire = out.return === "usd-numeraire" ? "usd" : "registered";
  return out;
}
/** Tokens that define the rule as calibrated (calibration:* excluded: an accept is written after the controls it accepts). */
const gateTokensOf = (dec) => (dec && Array.isArray(dec.tokens) ? dec.tokens.filter((g) => !g.startsWith("calibration:")).sort() : []);
/** The over-tolerance hold: lifted only by a calibration:accept naming exactly this controls run. */
function toleranceHold(calibration, dec, controlsAsOf) {
  if (!calibration || calibration.wholeRuleWithinTolerance) return null;
  if (dec && dec.calibrationAccept && dec.calibrationAccept.controlsAsOf === controlsAsOf) return null;
  return `whole-rule false pass ${pc(calibration.wholeRuleFalsePassMax)}% on the ${calibration.primaryNull} family exceeds ${pc(CAL_TOLERANCE)}% — fix the design by a preEvidence amendment, or record calibration:accept with controlsAsOf "${controlsAsOf}"`;
}
/** The read's preconditions on the controls file + registry entry (pure). Returns { refuse } or { refuse: null, dec, bar }. */
function readPreconditions({ ctrl, entry, runnerSha }) {
  const R = (refuse) => ({ refuse });
  if (!ctrl || ctrl.spec !== CTRL_SPEC) return R(`no controls file (spec ${CTRL_SPEC}) — run the controls first`);
  if (!ctrl.calibration || !ctrl.calibration.ok) return R("controls file has no complete calibration — re-run the controls");
  if (!entry) return R("not registered");
  const bar = Number(entry.bar && entry.bar.tRequired); if (!fin(bar)) return R("registry entry has no numeric bar.tRequired");
  if (ctrl.calibration.barUsed !== bar) return R(`controls were calibrated at bar ${ctrl.calibration.barUsed}, the registry bar is ${bar} — re-run the controls`);
  const dec = preReadDecision(entry);   // the gates in force come from the REGISTRY at read time
  if (!dec.decided) return R(`read HELD — pre-read decision unreadable (${dec.why})`);
  if (!dec.tokens.some((g) => g.startsWith("return:"))) return R("read HELD — the return numeraire is undecided (no return:* token in the registry; see the controls holds)");
  const want = gateTokensOf(dec).join("|"), had = (Array.isArray(ctrl.gateTokens) ? [...ctrl.gateTokens].sort() : []).join("|");
  if (want !== had || !ctrl.calibration.gateSet || ctrl.calibration.gateSet.numeraire !== dec.numeraire || ctrl.calibration.gateSet.placebo !== dec.placebo) return R(`read HELD — the controls were calibrated under gate tokens [${had}] (${JSON.stringify(ctrl.calibration.gateSet)}), the registry now carries [${want}] — re-run the controls`);
  if (!ctrl.pass) return R(`controls have not passed (${(ctrl.holds || []).join(" | ")})`);
  const lk = leakInForce(dec, ctrl.leakTest && ctrl.leakTest.registered && ctrl.leakTest.registered.pass, ctrl.leakTest && ctrl.leakTest.uipNull && ctrl.leakTest.uipNull.pass);
  if (!lk.pass) return R(`the leak precondition in force (${dec.leak}) did not pass in the controls run: ${lk.why} — refusing`);
  const th = toleranceHold(ctrl.calibration, dec, ctrl.asOf); if (th) return R(`read HELD — ${th}`);
  if (!ctrl.coverage || !ctrl.coverage.finalMonthComplete) return R(`read HELD — final month ${LAST_MONTH} incomplete in the cache; --refresh-cache + controls first`);
  if (!ctrl.runner || ctrl.runner.sha256 !== runnerSha) return R(`controls were produced by a different runner (${ctrl.runner && ctrl.runner.sha256} vs ${runnerSha}) — re-run the controls`);
  return { refuse: null, dec, bar };
}
/** Leak precondition in force. Returns { pass, why }. */
function leakInForce(dec, regPass, nullPass) {
  if (!dec || !dec.decided) return { pass: false, why: "pre-read decision unreadable" };
  if (dec.leak === "uip-null") return { pass: !!nullPass, why: nullPass ? null : "the no-edge-null leak test failed" };
  if (dec.leak === "registered-else-uip-null") return { pass: !!(regPass || nullPass), why: regPass ? null : nullPass ? null : "BOTH the registered and the no-edge-null leak tests failed — hold for code review", via: regPass ? "registered" : nullPass ? "uip-null (registered shuffle failed: construction bias, pre-committed)" : null };
  return { pass: !!regPass, why: regPass ? null : "the registered leak test failed" };
}
// The register's own bar method at a given n: NW(lag 1) t on uniform noise, mulberry(312), 50,000 trials; iid nullBar beside it (seeded here;
// the register's iid draw used Math.random — the NW figure is the binding one and reproduces exactly).
function barAtN(n) {
  const rng = mulberry(312), T = 50000, mx = [];
  for (let t = 0; t < T; t++) { const s = []; for (let i = 0; i < n; i++) s.push(rng() * 2 - 1); mx.push(nwT(s)); }
  mx.sort((a, b) => a - b);
  const { nullBar } = require("./lib/null-bar.js"), iid = nullBar({ variants: 1, n, trials: 20000, rng: mulberry(312) }).p95, nw = mx[Math.floor(0.95 * T)];
  return { n, nwSim: r3(nw), iid: r3(iid), bar: r3(Math.max(nw, iid)) };
}

// ── known-answer selftest (no network, no files) ─────────────────────────────────────────────────────────────────────────
function synthRaw({ months = monthsBetween("2000-01", "2004-12"), spot = {}, rates = {}, fills = {} } = {}) {
  // builds a raw set in parseFred's shape: one fixing on the 15th and one on the 28th of each month (the 28th is the month-end)
  const raw = {};
  for (const c of POOL6) {
    const cfg = CCY[c], f = spot[c] || ((k) => 1 + 0.001 * k);
    raw[cfg.spot] = months.flatMap((m, k) => [{ d: `${m}-15`, v: 999 }, { d: `${m}-28`, v: cfg.invert ? 1 / f(k) : f(k) }]);
    raw[cfg.rate] = months.map((m, k) => ({ d: `${m}-01`, v: (rates[c] || (() => 2))(k) }));
    if (cfg.fill) raw[cfg.fill] = months.map((m, k) => ({ d: `${m}-10`, v: (fills[c] || (() => 1))(k) }));
  }
  raw[US.rate] = months.map((m, k) => ({ d: `${m}-01`, v: (rates.US || (() => 4))(k) }));
  raw[US.fill] = months.map((m, k) => ({ d: `${m}-10`, v: (fills.US || (() => 3))(k) }));
  return raw;
}
function selftest() {
  const checks = {}, detail = {}, close = (a, b, e = 1e-12) => fin(a) && fin(b) && Math.abs(a - b) <= e;
  // (a) CIP known answer: S 1.10 -> 1.089, rUS 4.5, rF 2.0 (hand-computed)
  { const raw = synthRaw({ months: ["2001-01", "2001-02"], spot: { EUR: (k) => [1.10, 1.089][k] }, rates: { EUR: () => 2.0, US: () => 4.5 } });
    const P = buildPanel(raw, ["EUR"], { from: "2001-01", lastMonth: "2001-02" }), R = legReturns(P, "EUR");
    const F = 1.10 * (1 + 4.5 / 1200) / (1 + 2.0 / 1200);                // the 1-month forward: short foreign = F/S1 - 1, long = S1/F - 1
    checks.cipKnownAnswer = close(R.short[1], 0.012201885745979, 1e-14) && close(R.long[1], -0.012054794520548, 1e-14) && close(R.short[1], F / 1.089 - 1, 1e-14) && close(R.long[1], 1.089 / F - 1, 1e-14);
    // return:usd-numeraire: short = -(long) = 1 - S1/F (USD P&L of a short future per USD of notional); the registered short exceeds it by (1-x)^2/x
    const Pu = buildPanel(raw, ["EUR"], { from: "2001-01", lastMonth: "2001-02", numeraire: "usd" }), Ru = legReturns(Pu, "EUR"), x = 1.089 / F;
    let badNum = false; try { buildPanel(raw, ["EUR"], { from: "2001-01", lastMonth: "2001-02", numeraire: "eur" }); } catch { badNum = true; }
    checks.cipUsd = close(Ru.short[1], 0.012054794520548, 1e-14) && close(Ru.long[1], -0.012054794520548, 1e-14) && close(Ru.short[1], 1 - 1.089 / F, 1e-14) && close(Ru.long[1], R.long[1], 1e-15)
      && close(R.short[1] - Ru.short[1], (1 - x) ** 2 / x, 1e-15) && R.short[1] > Ru.short[1] && badNum && Pu.numeraire === "usd" && buildPanel(raw, ["EUR"], { from: "2001-01", lastMonth: "2001-02" }).numeraire === "registered";
    detail.cip = { short: R.short[1], long: R.long[1], shortUsd: Ru.short[1], numeraireGap: R.short[1] - Ru.short[1] }; }
  // (b) DEXSZUS inversion (CHF per USD -> USD per CHF) and month-end = last non-blank fixing of the month
  { const rows = parseFred("observation_date,DEXSZUS\n2026-09-24,0.8300\n2026-09-25,0.8282\n2026-09-28,\n2026-10-01,0.8290\n", "DEXSZUS"), sp = monthEndSpot(rows, true);
    checks.dexszusInverted = close(sp.get("2026-09").v, 1 / 0.8282) && close(sp.get("2026-09").v, 1.207437816952, 1e-11) && sp.get("2026-09").d === "2026-09-25" && sp.get("2026-10").d === "2026-10-01";
    let threw = false; try { parseFred("observation_date,DEXUSEU\n2026-09-25,1.14\n", "DEXSZUS"); } catch { threw = true; }
    checks.fredHeaderGuard = threw; }
  // (c) direction + dead zone
  { const mk = (rUS, rF, up) => { const raw = synthRaw({ months: monthsBetween("2000-01", "2001-02"), spot: { EUR: (k) => (up ? 1 + 0.01 * k : 1 - 0.005 * k) }, rates: { EUR: () => rF, US: () => rUS } }); const P = buildPanel(raw, ["EUR"], { from: "2000-01", lastMonth: "2001-02" }); return decideAt(P, legReturns(P, "EUR"), "EUR", 13); };
    const a = mk(5, 2, false), b = mk(2, 5, true), c = mk(3.2, 3.0, true), d = mk(3.25, 3.0, false), e = mk(3.0, 3.25, true), f = mk(5, 2, true), g = mk(2, 5, false);
    checks.directionAndDeadZone = a.cand === -1 && a.pos === -1 && b.cand === 1 && b.pos === 1 && c.cand === 0 && c.pos === 0 && d.cand === -1 && e.cand === 1 && f.cand === -1 && f.pos === 0 && g.cand === 1 && g.pos === 0;
    detail.direction = { a: [a.cand, a.pos], b: [b.cand, b.pos], c: [c.cand, c.pos], d: [d.cand, d.pos], e: [e.cand, e.pos], f: [f.cand, f.pos], g: [g.cand, g.pos] }; }
  // (d) timing / no look-ahead: the decision for month i is invariant to spot at i and later and to rates at i and later; it moves with month i-1
  { const months = monthsBetween("2000-01", "2001-06"), base = synthRaw({ months, spot: { EUR: (k) => 1 + 0.004 * Math.sin(k) + 0.002 * k }, rates: { EUR: (k) => 2 + 0.1 * k, US: (k) => 4 - 0.05 * k } });
    const P0 = buildPanel(base, ["EUR"], { from: "2000-01", lastMonth: "2001-06" }), i = 14, d0 = decideAt(P0, legReturns(P0, "EUR"), "EUR", i);
    const P1 = JSON.parse(JSON.stringify(P0)); for (let k = i; k < P1.months.length; k++) { P1.legs.EUR.S[k] *= 3; P1.legs.EUR.rF[k] = 50; P1.rUS[k] = -50; }
    const d1 = decideAt(P1, legReturns(P1, "EUR"), "EUR", i);
    const P2 = JSON.parse(JSON.stringify(P0)); P2.legs.EUR.S[i - 1] *= 0.5; const d2 = decideAt(P2, legReturns(P2, "EUR"), "EUR", i);
    const P3 = JSON.parse(JSON.stringify(P0)); P3.rUS[i - 1] = -10; const d3 = decideAt(P3, legReturns(P3, "EUR"), "EUR", i);
    checks.noLookAhead = JSON.stringify(d0) === JSON.stringify(d1) && d2.cumLong !== d0.cumLong && d3.cand !== d0.cand;
    // the held month's own return enters the trend filter only from the NEXT decision on
    const R0 = legReturns(P0, "EUR"); checks.trendWindowIsPrior12 = (() => { let p = 1; for (let k = i - 12; k <= i - 1; k++) p *= 1 + R0.long[k]; return close(p - 1, d0.cumLong); })(); }
  // (e) cost arithmetic: positions 0 -> +1 -> +1 -> -1 -> 0 cost 0.04%, 0.01%, 0.07%, 0.03%
  { const ctx = { ccys: ["EUR"], idx: [1, 2, 3, 4], rets: { EUR: { long: [0, 0.01, 0.02, -0.01, 0.005], short: [0, -0.0099, -0.0196, 0.0101, -0.00497] } }, dec: { EUR: [null, { pos: 1 }, { pos: 1 }, { pos: -1 }, { pos: 0 }] } };
    const r = runStrategy(ctx, "carry"), want = [0.0004, 0.0001, 0.0007, 0.0003];
    checks.costArithmetic = r.legs.EUR.cost.every((x, k) => close(x, want[k], 1e-15)) && close(r.legs.EUR.net[2], 0.0101 - 0.0007, 1e-15) && close(runStrategy(ctx, "carry", { costMult: 2 }).legs.EUR.cost[2], 0.0014, 1e-15); }
  // (f) the register's nwT on a fixed vector (hand-run value)
  checks.nwTKnownAnswer = close(nwT([0.01, -0.02, 0.03, 0.005, -0.01, 0.02, 0.0, 0.015]), 1.835325870964, 1e-11);
  // (g) fill rule: shift by the daily rate's month-mean change (required/prefer), flat for CHF, UNKNOWN when a required daily rate is absent
  { const months = monthsBetween("2020-01", "2020-06");
    const raw = { A: [{ d: "2020-01-01", v: 1.0 }, { d: "2020-02-01", v: 1.2 }, { d: "2020-04-01", v: 0.9 }], Dd: [{ d: "2020-02-10", v: 2.0 }, { d: "2020-02-20", v: 2.2 }, { d: "2020-03-05", v: 1.5 }, { d: "2020-05-03", v: 0.5 }, { d: "2020-06-03", v: 0.6 }] };
    const req = rateSeries(raw, "A", "Dd", "required", months), flat = rateSeries(raw, "A", null, "flat", months), pref = rateSeries(raw, "A", "Dd", "prefer", months);
    // 2020-03 interior hole: 1.2 + (1.5 - 2.1) = 0.6 ; 2020-05 after the end: L = 2020-04 (no daily obs in April) -> required UNKNOWN, prefer flat 0.9
    checks.fillRule = close(req.r[2], 0.6, 1e-12) && req.filled[2] && req.info[2].method === "shift Dd" && req.r[4] === null && req.info[4].method === "UNKNOWN"
      && close(flat.r[2], 1.2) && close(flat.r[5], 0.9) && flat.filled[5] && close(pref.r[4], 0.9) && /flat/.test(pref.info[4].method) && !req.filled[0] && req.r[0] === 1.0;
    detail.fill = { req: req.r, flat: flat.r, pref: pref.r }; }
  // (h) scrambles: UIP-null log excess = a permutation of the demeaned log changes (sums to 0); leak keeps the raw multiset; joint = one permutation
  { const months = monthsBetween("2000-01", "2003-12"), raw = synthRaw({ months, spot: { EUR: (k) => 1 + 0.01 * Math.sin(k / 3) + 0.003 * k, GBP: (k) => 1.5 + 0.02 * Math.cos(k / 5), CHF: (k) => 0.7 + 0.002 * k }, rates: { EUR: (k) => 2 + 0.05 * k, GBP: () => 5, CHF: () => 1, US: (k) => 4 - 0.02 * k } });
    const P = buildPanel(raw, TRIO, { from: "2000-01", lastMonth: "2003-12" }), from = 1, b = P.months.length - 1;
    const U = scramblePanel(P, TRIO, { seed: 5, kind: "uip", from }), K = scramblePanel(P, TRIO, { seed: 5, kind: "leak", joint: false, from });
    const lx = (Q, c) => { const R = legReturns(Q, c); const a = []; for (let i = from; i <= b; i++) a.push(Math.log(1 + R.long[i])); return a; };
    const dl = (Q, c) => { const a = []; for (let i = from; i <= b; i++) a.push(Math.log(Q.legs[c].S[i] / Q.legs[c].S[i - 1])); return a; };
    const srt = (a) => [...a].sort((x, y) => x - y), sameMultiset = (a, c) => srt(a).every((x, k) => close(x, srt(c)[k], 1e-12));
    const uipOk = TRIO.every((c) => { const e = lx(U, c), d = dl(P, c), m = mean(d); return close(e.reduce((s, x) => s + x, 0), 0, 1e-12) && sameMultiset(e, d.map((x) => x - m)); });
    const leakOk = TRIO.every((c) => sameMultiset(dl(K, c), dl(P, c)));
    const ratesKept = U.rUS === P.rUS && TRIO.every((c) => U.legs[c].rF === P.legs[c].rF);
    // joint: the same permutation index moves every currency (check through the rank of a planted outlier month)
    const Pj = JSON.parse(JSON.stringify(P)); for (const c of TRIO) Pj.legs[c].S = Pj.legs[c].S.map((x, i) => (i >= 20 ? x * 1.5 : x));
    const Uj = scramblePanel(Pj, TRIO, { seed: 9, kind: "uip", from }), where = (c) => { const e = lx(Uj, c); return e.indexOf(Math.max(...e)); };
    const U5 = scramblePanel(P, TRIO, { seed: 5, kind: "uip", from: 5 });      // spot before from-1 is blanked; from-1 is the real anchor
    checks.scrambles = uipOk && leakOk && ratesKept && where("EUR") === where("GBP") && where("GBP") === where("CHF") && U5.legs.EUR.S[3] === null && U5.legs.EUR.S[4] === P.legs.EUR.S[4] && U5.legs.EUR.S[5] !== P.legs.EUR.S[5]; }
  // (i) the forward path decides with the SAME function as the historical runner (decideMonth vs decideAt on the same panel)
  { const months = monthsBetween("2000-01", "2002-03"), raw = synthRaw({ months, spot: { EUR: (k) => 1 + 0.003 * k, GBP: (k) => 1.6 - 0.002 * k, CHF: (k) => 0.6 + 0.004 * Math.sin(k) }, rates: { EUR: () => 3, GBP: () => 5.5, CHF: () => 1, US: () => 4 } });
    const Pfull = buildPanel(raw, TRIO, { from: "2000-01", lastMonth: "2002-03" }), Pcut = buildPanel(raw, TRIO, { from: "2000-01", lastMonth: "2002-02" });
    const fw = decideMonth(Pcut, TRIO, "2002-02"), i = Pfull.months.indexOf("2002-03");
    checks.forwardParity = TRIO.every((c) => { const h = decideAt(Pfull, legReturns(Pfull, c), c, i); return fw[c] && h && fw[c].pos === h.pos && fw[c].cand === h.cand && close(fw[c].cumLong, h.cumLong) && close(fw[c].gap, h.gap); }); }
  // (j) placebo determinism and evaluateRule on a synthetic panel produce every gate key; trend-only = the same legs every month
  { const months = monthsBetween("2000-01", "2006-12"), raw = synthRaw({ months, spot: { EUR: (k) => 1 + 0.02 * Math.sin(k / 4), GBP: (k) => 1.6 + 0.03 * Math.cos(k / 7), CHF: (k) => 0.7 + 0.01 * Math.sin(k / 2) }, rates: { EUR: () => 2, GBP: () => 5.5, CHF: () => 0.5, US: () => 4 } });
    const ctx = prepare(buildPanel(raw, TRIO, { from: "2000-01", lastMonth: "2006-12" }), TRIO), e1 = evaluateRule(ctx, { bar: 1.682, draws: 200 }), e2 = evaluateRule(ctx, { bar: 1.682, draws: 200 });
    const tr = runStrategy(ctx, "trend");
    checks.ruleHarness = !e1.error && e1.pl.registered.p95 === e2.pl.registered.p95 && Object.keys(e1.gates).length === 7 && tr.legs.EUR.pos.length === ctx.idx.length && e1.S.n === ctx.idx.length && ctx.start === ctx.a + 12;
    detail.harness = { n: e1.S.n, start: ctx.keys[0], gates: e1.gates }; }
  // (k) pre-read decision parser
  { const a = preReadDecision({}), b = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: ["leak:uip-null"] }] }), c = preReadDecision({ amendments: [{ preEvidence: false, runnerGates: ["leak:uip-null"] }] });
    const d = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: ["leak:bogus"] }] }), e = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: ["placebo:same-cost", "placebo:month-flip"] }] });
    checks.preReadParser = a.decided && !a.amended && a.leak === "registered" && b.decided && b.leak === "uip-null" && b.placebo === "registered" && !c.decided && !d.decided && !e.decided; }
  // (h2) USD-fair family: theta 1 -> the simple long excess S/F - 1 over the window is a permutation of the real one, demeaned (sums to 0,
  //      so a long and a short both have zero mean excess); theta 0 -> the simple SPOT change is that permutation (carry earns the gap);
  //      flip keeps months in place with one shared sign per month
  { const months = monthsBetween("2000-01", "2003-12"), raw = synthRaw({ months, spot: { EUR: (k) => 1 + 0.01 * Math.sin(k / 3) + 0.003 * k, GBP: (k) => 1.5 + 0.02 * Math.cos(k / 5), CHF: (k) => 0.7 + 0.002 * k }, rates: { EUR: (k) => 2 + 0.05 * k, GBP: () => 5, CHF: () => 1, US: (k) => 4 - 0.02 * k } });
    const P = buildPanel(raw, TRIO, { from: "2000-01", lastMonth: "2003-12", numeraire: "usd" }), from = 1, b = P.months.length - 1;
    const srt = (a) => [...a].sort((x, y) => x - y), sameMultiset = (a, c) => srt(a).every((x, k) => close(x, srt(c)[k], 1e-12));
    const sl = (Q, c) => { const R = legReturns(Q, c); const a = []; for (let i = from; i <= b; i++) a.push(R.long[i]); return a; };
    const ds = (Q, c) => { const a = []; for (let i = from; i <= b; i++) a.push(Q.legs[c].S[i] / Q.legs[c].S[i - 1] - 1); return a; };
    const V = scramblePanel(P, TRIO, { seed: 5, kind: "usd", theta: 1, from }), W = scramblePanel(P, TRIO, { seed: 5, kind: "usd", theta: 0, from }), Fp = scramblePanel(P, TRIO, { seed: 5, kind: "usd", theta: 1, resample: "flip", from });
    const fairOk = TRIO.every((c) => { const e = sl(V, c), d = sl(P, c), m = mean(d); return close(e.reduce((s, x) => s + x, 0), 0, 1e-12) && sameMultiset(e, d.map((x) => x - m)) && V.numeraire === "usd"; });
    const shortFair = TRIO.every((c) => { const R = legReturns(V, c); let s = 0; for (let i = from; i <= b; i++) s += R.short[i]; return close(s, 0, 1e-12); });
    const rwOk = TRIO.every((c) => { const e = ds(W, c), d = sl(P, c), m = mean(d); return sameMultiset(e, d.map((x) => x - m)); });
    const flipOk = (() => { const ratio = (c) => { const e = sl(Fp, c), d = sl(P, c), m = mean(d); return e.map((x, k) => Math.round(x / (d[k] - m))); }; const r = ratio("EUR"); return r.every((s) => s === 1 || s === -1) && JSON.stringify(r) === JSON.stringify(ratio("GBP")) && JSON.stringify(r) === JSON.stringify(ratio("CHF")) && r.some((s) => s === -1); })();
    const ratesKept = V.rUS === P.rUS && TRIO.every((c) => V.legs[c].rF === P.legs[c].rF);
    let badKind = false; try { scramblePanel(P, TRIO, { seed: 1, kind: "nope", from }); } catch { badKind = true; }
    checks.usdFairScramble = fairOk && shortFair && rwOk && flipOk && ratesKept && badKind; }
  // (j2) known-answer gate boundaries on hand-built monthly series (kills: post-2008 from 2008-01, t bar 1.5, fill limit 20%, halves
  //      first-only, carry-adds >= -1, placebo at p50; plus the 239/240-month and 31/32-fill boundaries, US fills counted, UNKNOWN fill)
  { const synthCtx = ({ n = N_EXPECTED, start = "2000-08", long, pos = () => 1, trend = (j, c) => pos(j, c), fill = {} }) => {
      const months = monthsBetween(addM(start, -1), addM(start, n - 1)), idx = Array.from({ length: n }, (_, j) => j + 1), rets = {}, dec = {}, legs = {};
      const fl = (k, cnt) => k < cnt;
      for (const c of TRIO) {
        const lg = new Array(n + 1).fill(null), sh = new Array(n + 1).fill(null), d = new Array(n + 1).fill(null);
        for (let j = 0; j < n; j++) { const x = long(j, c); lg[j + 1] = x; sh[j + 1] = -x; d[j + 1] = { pos: pos(j, c), trendDir: trend(j, c) }; }
        rets[c] = { long: lg, short: sh, first: 1 }; dec[c] = d;
        const cnt = fill[c] || 0, unk = fill.unknown === c;
        legs[c] = { rFfilled: Array.from({ length: n + 1 }, (_, k) => fl(k, cnt) || (unk && k === 5)), rFinfo: Array.from({ length: n + 1 }, (_, k) => (unk && k === 5 ? { method: "UNKNOWN" } : fl(k, cnt) ? { method: "flat" } : null)) };
      }
      const cu = fill.US || 0;
      return { panel: { months, rUSfilled: Array.from({ length: n + 1 }, (_, k) => fl(k, cu)), rUSinfo: Array.from({ length: n + 1 }, (_, k) => (fl(k, cu) ? { method: "flat" } : null)), legs, numeraire: "usd" }, ccys: TRIO, rets, dec, a: 1, b: n, start: 1, idx, keys: idx.map((i) => months[i]), gaps: [] };
    };
    const BAR = 1.682, ev = (o, form = "registered") => evaluateRule(synthCtx(o), { bar: BAR, draws: 400, placeboForm: form });
    const dev = (j) => 0.02 * Math.sin(1.3 * j) + 0.01 * Math.cos(0.7 * j + 1);
    const g = {};
    // a full PASS, and the same series with each single gate broken
    const base = { long: (j) => 0.01 + dev(j), trend: (j) => (j % 5 === 0 ? -1 : 1) }, P0 = ev(base);
    g.fullPass = P0.wholeRulePass && verdictOf(P0) === "PASS" && Object.values(P0.gates).every(Boolean) && !P0.cannotMeasure;
    // t gate: series tuned so t_NW = target exactly (t is linear in a constant shift of the long return; the cost series is unchanged)
    const KEYS = synthCtx({ long: () => 0 }).keys, tAt = (k) => seriesStats(runStrategy(synthCtx({ long: (j) => dev(j) + k }), "carry").port, KEYS).tNet;
    const t1 = tAt(0), t2 = tAt(0.001), se = 0.001 / (t2 - t1), kFor = (target) => (target - t1) * se;
    const tCase = (target) => { const e = ev({ long: (j) => dev(j) + kFor(target) }); return { t: e.S.tNet, gate: e.gates.tAtLeastBar }; };
    const tA = tCase(1.60), tB = tCase(BAR + 1e-6), tC = tCase(BAR - 1e-6);
    g.tGate = Math.abs(tA.t - 1.6) < 1e-9 && !tA.gate && tB.gate && !tC.gate && Math.abs(tB.t - BAR) < 1e-5;
    // post-2008 = months from 2009-01 (213 of them): 2008 crushed, 2009+ positive -> true; 2009+ negative -> false
    const is2008 = KEYS.map((k) => k.startsWith("2008-")), is09 = KEYS.map((k) => k >= "2009-01");
    const pA = ev({ long: (j) => (is2008[j] ? -0.2 : 0.003) }), pB = ev({ long: (j) => (is09[j] ? -0.001 : 0.05) });
    g.post2008 = pA.gates.post2008Positive && pA.S.post2008.months === 213 && pA.S.post2008.from === "2009-01" && mean(pA.carry.port.slice(KEYS.indexOf("2008-01"))) < 0 && !pB.gates.post2008Positive;
    // halves: floor(314/2) = 157 each; first+ second- -> false, first- second+ -> false, both + -> true
    const hA = ev({ long: (j) => (j < 157 ? 0.02 : -0.01) }), hB = ev({ long: (j) => (j < 157 ? -0.01 : 0.02) }), hC = ev({ long: (j) => (j < 157 ? 0.02 : 0.005) });
    g.halves = !hA.gates.bothHalvesPositive && !hB.gates.bothHalvesPositive && hC.gates.bothHalvesPositive && hA.S.halves.first.months === 157 && hA.S.halves.second.months === 157;
    // carry-adds: trend right where carry is wrong -> diffMean < 0 -> false; trend wrong where carry is right -> true; identical -> exactly 0 -> false
    const lc = (j) => (j % 3 === 0 ? -0.01 : 0.012);
    const cA = ev({ long: lc, trend: (j) => (lc(j) < 0 ? -1 : 1) }), cB = ev({ long: lc, trend: (j) => (j % 3 === 1 ? -1 : 1) }), cC = ev({ long: lc });
    g.carryAdds = cA.diffMean < 0 && !cA.gates.carryAddsOverTrendOnly && cB.diffMean > 0 && cB.gates.carryAddsOverTrendOnly && cC.diffMean === 0 && !cC.gates.carryAddsOverTrendOnly;
    // placebo: carry right on 160 of 314 months per leg (observed between the placebo p50 and p95) -> false under EVERY form; right on 200 -> true
    const plCase = (k1, form) => { const e = ev({ long: (j) => (j < k1 ? 0.01 : -0.01) }, form), q = e.pl[form === "same-cost" ? "sameCost" : form === "month-flip" ? "monthFlip" : "registered"]; return { between: e.S.meanNet > q.p50 && e.S.meanNet <= q.p95, gate: e.gates.placeboP95Beaten }; };
    g.placebo = ["registered", "same-cost", "month-flip"].every((f) => { const a = plCase(160, f), b2 = plCase(200, f); return a.between && !a.gate && b2.gate; });
    // CANNOT MEASURE boundaries: 239 -> CM, 240 -> measurable; CHF 32 fills (10.19%) -> CM, 31 (9.87%) -> measurable; US 33 -> CM; one UNKNOWN EUR fill -> CM
    const m239 = ev({ ...base, n: 239 }), m240 = ev({ ...base, n: 240 });
    const f32 = ev({ ...base, fill: { CHF: 32 } }), f31 = ev({ ...base, fill: { CHF: 31 } }), fUS = ev({ ...base, fill: { US: 33 } }), fUnk = ev({ ...base, fill: { unknown: "EUR" } });
    g.cannotMeasure = m239.cannotMeasure && !m239.gates.monthsAtLeast240 && verdictOf(m239).startsWith("CANNOT MEASURE") && !m240.cannotMeasure && m240.gates.monthsAtLeast240
      && f32.cannotMeasure && /CHF 10\.2%/.test(f32.cannotMeasureWhy.join(";")) && !f31.cannotMeasure && fUS.cannotMeasure && /US 10\.5%/.test(fUS.cannotMeasureWhy.join(";")) && fUnk.cannotMeasure && /fill rate unknown: EUR/.test(fUnk.cannotMeasureWhy.join(";")) && !f32.wholeRulePass && !fUnk.wholeRulePass;
    checks.gateKnownAnswers = Object.values(g).every(Boolean); detail.gateKnownAnswers = g; }
  // (k2) pre-read decision: [] / no runnerGates change nothing and lift no hold; return/calibration families; leak fallback; tolerance hold
  { const P_ = (gs, extra = {}) => preReadDecision({ amendments: [{ date: "2026-10-02", preEvidence: true, ...(gs === undefined ? {} : { runnerGates: gs }), ...extra }] });
    const e0 = P_([]), e1 = P_(undefined), e2 = P_(["return:usd-numeraire"]), e3 = P_(["return:usd-numeraire", "return:registered"]), e4 = P_(["calibration:accept"]), e5 = P_(["calibration:accept"], { controlsAsOf: "2026-10-05T12:00:00.000Z" });
    const e6 = P_(PROPOSED_TOKENS), e7 = P_("leak:uip-null"), e8 = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: ["leak:registered", "placebo:registered"] }] });
    const cal = { wholeRuleWithinTolerance: false, wholeRuleFalsePassMax: 0.09, primaryNull: "USD-fair" }, ok = { wholeRuleWithinTolerance: true };
    checks.preReadTokens = e0.decided && !e0.amended && e0.numeraire === "registered" && e1.decided && !e1.amended && e2.decided && e2.amended && e2.numeraire === "usd" && e2.placebo === "registered" && !e3.decided && !e4.decided
      && e5.decided && e5.calibrationAccept && e5.calibrationAccept.controlsAsOf === "2026-10-05T12:00:00.000Z" && e6.decided && e6.numeraire === "usd" && e6.placebo === "same-cost" && e6.leak === "registered-else-uip-null" && !e7.decided
      && JSON.stringify(gateTokensOf(P_(["calibration:accept", "return:usd-numeraire"], { controlsAsOf: "x" }))) === JSON.stringify(["return:usd-numeraire"])
      && toleranceHold(cal, e8, "T1") !== null && toleranceHold(cal, e0, "T1") !== null && toleranceHold(cal, e2, "T1") !== null && toleranceHold(cal, e5, "2026-10-05T12:00:00.000Z") === null && toleranceHold(cal, e5, "T2") !== null && toleranceHold(ok, e0, "T1") === null
      && leakInForce(e6, false, true).pass && !leakInForce(e6, false, false).pass && leakInForce(e6, true, false).pass && !leakInForce(P_(["leak:uip-null"]), true, false).pass && !leakInForce(e0, false, true).pass && leakInForce(e0, true, false).pass; }
  // (l) the read's preconditions, every refusal on synthetic controls objects (the real read is never run here)
  { const entryOk = { bar: { tRequired: 1.682 }, amendments: [{ date: "2026-10-02", preEvidence: true, runnerGates: PROPOSED_TOKENS }] };
    const ctrlOk = { spec: CTRL_SPEC, asOf: "2026-10-06T12:00:00.000Z", calibration: { ok: true, barUsed: 1.682, gateSet: { numeraire: "usd", placebo: "same-cost" }, wholeRuleWithinTolerance: true }, gateTokens: [...PROPOSED_TOKENS].sort(), pass: true,
      leakTest: { registered: { pass: false }, uipNull: { pass: true } }, coverage: { finalMonthComplete: true }, runner: { sha256: "S" } };
    const rp = (c = {}, e = entryOk, sha = "S") => readPreconditions({ ctrl: { ...ctrlOk, ...c }, entry: e, runnerSha: sha }).refuse, has = (x, re) => typeof x === "string" && re.test(x);
    const outOfTol = { calibration: { ...ctrlOk.calibration, wholeRuleWithinTolerance: false, wholeRuleFalsePassMax: 0.09, primaryNull: "USD-fair" } };
    const accept = (asOf) => ({ ...entryOk, amendments: [...entryOk.amendments, { date: "2026-10-06", preEvidence: true, runnerGates: ["calibration:accept"], controlsAsOf: asOf }] });
    const regEntry = { bar: { tRequired: 1.682 }, amendments: [{ date: "2026-10-02", preEvidence: true, runnerGates: ["return:registered"] }] }, regCtrl = { gateTokens: ["return:registered"], calibration: { ...ctrlOk.calibration, gateSet: { numeraire: "registered", placebo: "registered" } }, leakTest: { registered: { pass: true }, uipNull: { pass: false } } };
    const r = {
      ok: rp() === null, okRegistered: rp(regCtrl, regEntry) === null,
      barUsed: has(rp({ calibration: { ...ctrlOk.calibration, barUsed: 1.2 } }), /bar 1.2/),
      emptyGates: has(rp({ gateTokens: [] }, { bar: { tRequired: 1.682 }, amendments: [{ preEvidence: true, runnerGates: [] }] }), /numeraire is undecided/),
      noAmendment: has(rp({ gateTokens: [] }, { bar: { tRequired: 1.682 } }), /numeraire is undecided/),
      tokensDiffer: has(rp({ gateTokens: ["return:usd-numeraire"] }), /calibrated under gate tokens/),
      gateSetDiffers: has(rp({ calibration: { ...ctrlOk.calibration, gateSet: { numeraire: "registered", placebo: "same-cost" } } }), /calibrated under gate tokens/),
      leakBothFail: has(rp({ leakTest: { registered: { pass: false }, uipNull: { pass: false } } }), /leak precondition/),
      tolerance: has(rp(outOfTol), /HELD — whole-rule/), toleranceAccepted: rp(outOfTol, accept(ctrlOk.asOf)) === null, toleranceWrongRun: has(rp(outOfTol, accept("2026-10-05T00:00:00.000Z")), /HELD — whole-rule/),
      finalMonth: has(rp({ coverage: { finalMonthComplete: false } }), /final month/), runner: has(rp({}, entryOk, "T"), /different runner/), notPassed: has(rp({ pass: false }), /not passed/),
      spec: has(rp({ spec: "r312-controls-v1" }), /no controls file/), noBar: has(rp({}, { amendments: entryOk.amendments }), /no numeric bar/), unknownToken: has(rp({}, { ...entryOk, amendments: [{ preEvidence: true, runnerGates: ["return:eur"] }] }), /unreadable/),
    };
    checks.readPreconditions = Object.values(r).every(Boolean); if (!checks.readPreconditions) detail.readPreconditions = r; }
  const pass = Object.values(checks).every(Boolean);
  return { pass, checks, detail };
}

// ── cache ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
async function fetchFred(id) {
  let last = null;
  for (let a = 0; a < 3; a++) {
    try { const r = await fetch(FRED_URL(id), { signal: AbortSignal.timeout(90000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); const t = await r.text(); parseFred(t, id); return t; }
    catch (e) { last = e; await new Promise((res) => setTimeout(res, 3000 * (a + 1))); }
  }
  throw new Error(`FRED ${id}: ${last && last.message}`);
}
/** Reads every series from dir (fetching the missing ones when allowFetch, or all when refresh). Returns { raw, files, sha }. */
async function loadOrFetch(dir, { allowFetch, refresh = false, ids = SERIES } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const files = {}, raw = {}, fetched = [];
  for (const id of ids) {
    const f = path.join(dir, `${id}.csv`);
    if (refresh || !fs.existsSync(f)) {
      if (!allowFetch) throw new Error(`${id}.csv missing from ${dir} and this mode never fetches`);
      const t = await fetchFred(id); const tmp = f + ".tmp-" + process.pid; fs.writeFileSync(tmp, t); fs.renameSync(tmp, f); fetched.push(id);
    }
    const buf = fs.readFileSync(f); raw[id] = parseFred(buf.toString("utf8"), id);
    files[id] = { file: `${id}.csv`, sha256: sha256(buf), bytes: buf.length, first: raw[id].length ? raw[id][0].d : null, last: raw[id].length ? raw[id][raw[id].length - 1].d : null, obs: raw[id].length };
  }
  const manifest = Object.keys(files).sort().map((k) => `${k} ${files[k].sha256}`).join("\n");
  return { raw, files, sha: sha256(Buffer.from(manifest)), fetched };
}
const bizDaysBackFrom = (ym) => { const out = []; let d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)); while (out.length < 3) { const w = d.getUTCDay(); if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() - 864e5); } return out; };
function coverage(raw, files, panel, ctx) {
  const lastWeekdays = bizDaysBackFrom(LAST_MONTH), perSeries = {};
  for (const [id, f] of Object.entries(files)) perSeries[id] = { first: f.first, last: f.last, obs: f.obs, firstMonth: f.first && f.first.slice(0, 7), lastMonth: f.last && f.last.slice(0, 7) };
  const lastMonthSpot = {}; let complete = true;
  for (const c of panel.ccys) { const i = panel.months.length - 1, d = panel.legs[c].sDate[i]; const ok = !!d && d >= lastWeekdays[lastWeekdays.length - 1]; lastMonthSpot[c] = { month: LAST_MONTH, lastFixing: d, completeWithinLast3Weekdays: ok }; if (TRIO.includes(c) && !ok) complete = false; }
  const fills = ctx && !ctx.error ? fillShares(ctx) : null;
  return { perSeries, lastMonthSpot, finalMonthComplete: complete, finalMonthRule: `the ${LAST_MONTH} month-end fixing must fall in the month's last 3 weekdays (${[...lastWeekdays].reverse().join(", ")}); H.10 posts a week at a time on Mondays — refresh with --refresh-cache after it does`,
    window: ctx && !ctx.error ? { firstReturnMonthAllThree: panel.months[ctx.a], firstHeldMonth: ctx.keys[0], firstDecisionMonthEnd: panel.months[ctx.start - 1], lastHeldMonth: ctx.keys[ctx.keys.length - 1], n: ctx.idx.length, nExpected: N_EXPECTED, gaps: ctx.gaps } : null,
    filledRateMonths: fills ? Object.fromEntries(Object.entries(fills).map(([k, v]) => [k, { filled: v.filled, months: v.months, sharePct: pc(v.share), list: v.list.map((x) => ({ heldMonth: x.heldMonth, rateMonth: x.rateMonth, method: x.method, value: x.value })) }])) : null };
}
function registryEntry() { const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")); return [...(reg.preregistered || []), ...(reg.tests || [])].find((x) => x.id === ID) || null; }

// ── calibration (scrambles only) ───────────────────────────────────────────────────────────────────────────────────────────
function scrambleEval(panel, seed, opts, bar, placeboForm = "registered") {
  const P = scramblePanel(panel, TRIO, { seed, ...opts }), ev = evaluateRule(prepare(P, TRIO), { bar, placeboForm });
  return { seed, n: ev.S ? ev.S.n : null, meanNet: ev.S ? ev.S.meanNet : null, t: ev.S ? ev.S.tNet : null, gates: ev.gates, wholeRulePass: ev.wholeRulePass, cannotMeasure: ev.cannotMeasure,
    placeboAlt: ev.placeboAlt, diffT: ev.diffT, wholeRuleAlt: ev.gates ? altWhole(ev) : null };
}
// whole rule under each placebo form (other gates as in force)
function altWhole(ev) { const g = { ...ev.gates }, base = !ev.cannotMeasure && Object.entries(g).filter(([k]) => k !== "placeboP95Beaten").every(([, v]) => v); return { registered: base && ev.placeboAlt.registered, sameCost: base && ev.placeboAlt.sameCost, monthFlip: base && ev.placeboAlt.monthFlip, noPlacebo: base }; }
function summariseRuns(rows, label, description) {
  const share = (f, rs = rows) => (rs.length ? rs.filter(f).length / rs.length : null), srt = (a) => a.filter(fin).sort((x, y) => x - y);
  const dist = (a, k) => { const s = srt(a); return s.length ? { min: k(s[0]), p05: k(nearestRank(s, 0.05)), p50: k(nearestRank(s, 0.5)), p95: k(nearestRank(s, 0.95)), max: k(s[s.length - 1]) } : null; };
  const gateKeys = rows.length && rows[0].gates ? Object.keys(rows[0].gates) : [], tRows = rows.filter((r) => r.gates && r.gates.tAtLeastBar);
  return { label, description, seeds: rows.length, seedRange: rows.length ? [rows[0].seed, rows[rows.length - 1].seed] : null,
    gatePassShare: Object.fromEntries(gateKeys.map((k) => [k, share((r) => r.gates && r.gates[k])])),
    wholeRulePassShare: share((r) => r.wholeRulePass), wholeRulePassCount: rows.filter((r) => r.wholeRulePass).length, cannotMeasureShare: share((r) => r.cannotMeasure),
    wholeRuleByPlaceboForm: { registered: share((r) => r.wholeRuleAlt && r.wholeRuleAlt.registered), sameCost: share((r) => r.wholeRuleAlt && r.wholeRuleAlt.sameCost), monthFlip: share((r) => r.wholeRuleAlt && r.wholeRuleAlt.monthFlip), noPlaceboGate: share((r) => r.wholeRuleAlt && r.wholeRuleAlt.noPlacebo) },
    placeboBeatenShare: { registered: share((r) => r.placeboAlt && r.placeboAlt.registered), sameCost: share((r) => r.placeboAlt && r.placeboAlt.sameCost), monthFlip: share((r) => r.placeboAlt && r.placeboAlt.monthFlip) },
    givenTAtLeastBar: { seeds: tRows.length, gatePassShare: Object.fromEntries(gateKeys.filter((k) => k !== "tAtLeastBar").map((k) => [k, share((r) => r.gates[k], tRows)])), placeboFailedCount: tRows.filter((r) => !r.gates.placeboP95Beaten).length },
    shareAbsTAtLeast2: share((r) => r.t != null && Math.abs(r.t) >= 2), shareTAtLeastBar: share((r) => r.gates && r.gates.tAtLeastBar),
    tNW: dist(rows.map((r) => r.t), r3), meanNetPctPerMonth: dist(rows.map((r) => r.meanNet), (x) => r4(100 * x)), carryAddsPairedT: dist(rows.map((r) => r.diffT), r3) };
}
/** gate = { numeraire, placebo } — the rule as it will be read. The panel must be built with gate.numeraire. */
function calibrate(panel, from, bar, gate = { numeraire: "registered", placebo: "registered" }, log = () => {}) {
  if ((panel.numeraire || "registered") !== gate.numeraire) throw new Error(`calibrate: panel numeraire ${panel.numeraire} != gate ${gate.numeraire}`);
  const runs = {}, t0 = Date.now(), usd = gate.numeraire === "usd";
  const go = (key, count, opts, desc) => { const rows = []; for (let s = 1; s <= count; s++) rows.push(scrambleEval(panel, s, { from, ...opts }, bar, gate.placebo)); runs[key] = summariseRuns(rows, key, desc); runs[key]._rows = rows; log(`  ${key}: ${count} seeds, whole-rule PASS ${pc(runs[key].wholeRulePassShare)}% · t>=bar ${pc(runs[key].shareTAtLeastBar)}% (${((Date.now() - t0) / 1000).toFixed(0)}s)`); };
  const N = usd ? { kind: "usd", theta: 1 } : { kind: "uip", theta: 1 };
  const nullName = usd ? "USD-fair null (simple long-foreign excess S/F - 1 demeaned and resampled, S rebuilt as F(1 + l'): E[S/F] = 1, no Jensen tilt in either direction)" : "log-fair UIP-null (demeaned log spot changes resampled, rate gap added back: expected LOG excess 0; every simple-return position carries +sigma^2/2)";
  go("nullJoint", CAL.primary, { ...N, joint: true }, `PRIMARY: ${nullName}; ONE permutation shared by EUR/GBP/CHF; rates as observed`);
  go("nullBootstrap", CAL.bootstrap, { ...N, joint: true, resample: "boot" }, `${nullName}; months drawn WITH replacement (one draw shared): no finite-population compression of t`);
  go("nullFlip", CAL.flip, { ...N, joint: true, resample: "flip" }, `${nullName}; months in place, ONE random sign per month shared by the three currencies (keeps vol timing and cross-currency correlation)`);
  go("nullIndependent", CAL.independent, { ...N, joint: false }, `${nullName}; an independent permutation per currency (cross-currency correlation destroyed)`);
  if (usd) go("logUipJointReported", CAL.independent, { kind: "uip", joint: true }, "REPORTED: the log-fair UIP-null under the USD returns (long carries +sigma^2/2, short -sigma^2/2) — not a fair null for the USD statistic");
  go("registeredLeak", CAL.registeredLeak, { kind: "leak", joint: false }, "the REGISTERED leak scramble: raw spot log changes shuffled across months within each currency, not demeaned, rates kept (real rate income + spot drift survive: NOT a no-edge null for carry)");
  go("trendEdge", CAL.trendEdge, usd ? { kind: "usdTrend", theta: 1, joint: true, mu: CAL.trendEdgeMu } : { kind: "trend", joint: true, mu: CAL.trendEdgeMu }, `${usd ? "USD-fair" : "log-fair"} null + planted TREND premium ${100 * CAL.trendEdgeMu}%/month in the direction of each currency's own past 12 months; carry adds nothing — the rule should not PASS`);
  const P = (theta) => (usd ? { kind: "usd", theta } : theta === 0 ? { kind: "rw" } : theta === 0.5 ? { kind: "half" } : { kind: "uip", theta });
  go("powerGap1xPerm", CAL.power, { ...P(0), joint: true }, "POWER, carry earns exactly the rate gap (spot a martingale, Fama beta 0); joint permutation");
  go("powerGap1xBootstrap", CAL.power, { ...P(0), joint: true, resample: "boot" }, "POWER, carry earns the gap; months drawn with replacement");
  go("powerGap1xFlip", CAL.power, { ...P(0), joint: true, resample: "flip" }, "POWER, carry earns the gap; shared sign flip per month");
  go("powerGapHalfFlip", CAL.powerExtra, { ...P(0.5), joint: true, resample: "flip" }, "POWER, carry earns half the gap (beta 0.5); shared sign flip");
  go("powerGap2xFlip", CAL.powerExtra, { ...P(-1), joint: true, resample: "flip" }, "POWER, carry earns 2x the gap (Fama beta -1); shared sign flip");
  go("powerGap2xBootstrap", CAL.powerExtra, { ...P(-1), joint: true, resample: "boot" }, "POWER, carry earns 2x the gap; with replacement");
  go("powerGap3xFlip", CAL.powerExtra, { ...P(-2), joint: true, resample: "flip" }, "POWER, carry earns 3x the gap (Fama beta -2); shared sign flip");
  go("powerGap3xBootstrap", CAL.powerExtra, { ...P(-2), joint: true, resample: "boot" }, "POWER, carry earns 3x the gap; with replacement");
  const U = runs.nullJoint, B = runs.nullBootstrap, Fl = runs.nullFlip, I = runs.nullIndependent, K = runs.registeredLeak, Tr = runs.trendEdge;
  const nullKeys = ["nullJoint", "nullBootstrap", "nullFlip", "nullIndependent"], powKeys = Object.keys(runs).filter((k) => k.startsWith("power"));
  // the placebo once t has cleared: does it ever bind? (all seeds of every null and power world)
  let tCleared = 0, plFailedGivenT = 0; for (const k of [...nullKeys, ...powKeys, "trendEdge"]) for (const r of runs[k]._rows) if (r.gates && r.gates.tAtLeastBar) { tCleared++; if (!r.gates.placeboP95Beaten) plFailedGivenT++; }
  const findings = [], plKey = gate.placebo === "same-cost" ? "sameCost" : gate.placebo === "month-flip" ? "monthFlip" : "registered";
  const wmax = Math.max(U.wholeRulePassShare, B.wholeRulePassShare, Fl.wholeRulePassShare);
  findings.push(`gate set: return ${usd ? "usd-numeraire" : "registered"}, placebo ${gate.placebo}; primary null family = ${usd ? "USD-fair" : "log-fair UIP"}`);
  findings.push(`whole rule false pass: ${pc(U.wholeRulePassShare)}% permutation (${U.seeds}) / ${pc(B.wholeRulePassShare)}% with replacement (${B.seeds}) / ${pc(Fl.wholeRulePassShare)}% sign-flip (${Fl.seeds}) / ${pc(I.wholeRulePassShare)}% independent (${I.seeds}); tolerance ${pc(CAL_TOLERANCE)}%`);
  findings.push(`t >= bar alone: ${pc(U.shareTAtLeastBar)}% / ${pc(B.shareTAtLeastBar)}% / ${pc(Fl.shareTAtLeastBar)}% (perm / boot / flip); nominal 5%`);
  findings.push(`placebo (${gate.placebo}) beaten alone: ${pc(U.placeboBeatenShare[plKey])}% / ${pc(B.placeboBeatenShare[plKey])}% / ${pc(Fl.placeboBeatenShare[plKey])}% (registered own-turnover form ${pc(U.placeboBeatenShare.registered)}% / ${pc(B.placeboBeatenShare.registered)}% / ${pc(Fl.placeboBeatenShare.registered)}%); once t >= bar it failed on ${plFailedGivenT} of ${tCleared} seeds across every null and power world`);
  findings.push(`carry-adds passes on ${pc(U.givenTAtLeastBar.gatePassShare.carryAddsOverTrendOnly)}% / ${pc(B.givenTAtLeastBar.gatePassShare.carryAddsOverTrendOnly)}% / ${pc(Fl.givenTAtLeastBar.gatePassShare.carryAddsOverTrendOnly)}% of the null seeds where t cleared — the gate that turns the t-gate rate into the whole-rule rate`);
  findings.push(`registered leak scramble: |t| >= 2 on ${pc(K.shareAbsTAtLeast2)}% of seeds (t p50 ${K.tNW && K.tNW.p50}) — not a no-edge null (keeps the real rate income)`);
  findings.push(`trend-edge null (carry adds nothing): whole rule PASS ${pc(Tr.wholeRulePassShare)}%, carry-adds gate passed ${pc(Tr.gatePassShare.carryAddsOverTrendOnly)}%`);
  const p1 = [runs.powerGap1xPerm, runs.powerGap1xBootstrap, runs.powerGap1xFlip].map((r) => r.wholeRulePassShare);
  findings.push(`power (whole rule PASS): 1x gap ${pc(p1[0])}% perm / ${pc(p1[1])}% boot / ${pc(p1[2])}% flip (t p50 ${runs.powerGap1xFlip.tNW && runs.powerGap1xFlip.tNW.p50}); half gap ${pc(runs.powerGapHalfFlip.wholeRulePassShare)}% flip; 2x gap ${pc(runs.powerGap2xFlip.wholeRulePassShare)}% flip / ${pc(runs.powerGap2xBootstrap.wholeRulePassShare)}% boot; 3x gap ${pc(runs.powerGap3xFlip.wholeRulePassShare)}% flip / ${pc(runs.powerGap3xBootstrap.wholeRulePassShare)}% boot — ${Math.max(...p1) < 0.5 ? "UNDER-POWERED: a carry premium equal to the gap usually reads DID NOT PASS" : "adequate"}`);
  if (!usd) findings.push("log-fair null caveat: expected LOG excess 0 gives every simple-return position a +sigma^2/2 tilt (0.030-0.039%/leg-month), so false-pass figures are slightly conservative and power slightly generous");
  const out = { ok: true, seconds: +((Date.now() - t0) / 1000).toFixed(1), barUsed: bar, gateSet: { numeraire: gate.numeraire, placebo: gate.placebo }, primaryNull: usd ? "USD-fair" : "log-fair UIP", placeboDrawsPerSeed: PLACEBO_DRAWS, nulls: runs, findings,
    wholeRuleFalsePassPrimary: U.wholeRulePassShare, wholeRuleFalsePassBootstrap: B.wholeRulePassShare, wholeRuleFalsePassFlip: Fl.wholeRulePassShare, wholeRuleFalsePassMax: wmax,
    wholeRuleWithinTolerance: [U, B, Fl].every((r) => r.wholeRulePassShare != null && r.wholeRulePassShare <= CAL_TOLERANCE), tolerance: CAL_TOLERANCE,
    placeboGivenT: { tCleared, placeboFailed: plFailedGivenT, impliedByT: plFailedGivenT === 0 },
    powerFullCarry: p1[1], powerGap: { x1: { perm: p1[0], boot: p1[1], flip: p1[2] }, half: { flip: runs.powerGapHalfFlip.wholeRulePassShare }, x2: { flip: runs.powerGap2xFlip.wholeRulePassShare, boot: runs.powerGap2xBootstrap.wholeRulePassShare }, x3: { flip: runs.powerGap3xFlip.wholeRulePassShare, boot: runs.powerGap3xBootstrap.wholeRulePassShare } },
    underPowered: Math.max(...p1) < 0.5,
    registeredLeakMiscalibrated: K.shareAbsTAtLeast2 > 0.1, registeredPlaceboAntiConservative: U.placeboBeatenShare.registered > CAL_TOLERANCE || B.placeboBeatenShare.registered > CAL_TOLERANCE };
  for (const k of Object.keys(runs)) { const s1 = runs[k]._rows[0]; runs[k].seed1 = { t: r3(s1.t), meanNetPctPerMonth: r4(100 * s1.meanNet), wholeRulePass: s1.wholeRulePass, gates: s1.gates }; delete runs[k]._rows; }
  return out;
}

// ── the read (pure) ─────────────────────────────────────────────────────────────────────────────────────────────────────
function worst12(port, keys) { let best = null; for (let j = 11; j < port.length; j++) { let p = 1; for (let q = j - 11; q <= j; q++) p *= 1 + port[q]; if (!best || p - 1 < best.ret) best = { ret: p - 1, retPct: r4(100 * (p - 1)), from: keys[j - 11], to: keys[j] }; } return best; }
/** Mechanical meaning of a DID NOT PASS from which gate(s) failed (consolidated amendment 2026-10-02 proposal; reported, never a gate). */
function failReadingOf(ev, powerGap = null) {
  if (!ev || ev.cannotMeasure || !ev.gates) return null;
  if (ev.wholeRulePass) return null;
  const g = ev.gates, failed = Object.entries(g).filter(([, v]) => !v).map(([k]) => k);
  let reading;
  if (!g.meanNetPositive || !g.tAtLeastBar) reading = `(a) UNDER-POWERED, NOT DISPROVEN: the mean/t gate failed${powerGap ? `; pre-read power (whole rule PASS share on constructed worlds): carry = 1x the rate gap ${pc(powerGap.x1.perm)}/${pc(powerGap.x1.boot)}/${pc(powerGap.x1.flip)}% (perm/boot/flip), 2x ${pc(powerGap.x2.flip)}/${pc(powerGap.x2.boot)}% (flip/boot), 3x ${pc(powerGap.x3.flip)}/${pc(powerGap.x3.boot)}% — this outcome rules out only a premium several times the gap` : ""}`;
  else if (!g.carryAddsOverTrendOnly) reading = "(b) t cleared but carry-adds failed: the 12-month trend explains at least as much as the rate gap (trend-only on all three legs every month beat R312 on the leg-months R312 sits out) — not 'no carry premium'";
  else if (!g.bothHalvesPositive || !g.post2008Positive) reading = "(c) t cleared but a halves / post-2008 gate failed: regime-dependent, carried by one era";
  else reading = "t, carry-adds, halves and post-2008 cleared but the placebo p95 was not beaten (calibration: the placebo has not bound once t cleared — inspect before interpreting)";
  return { failedGates: failed, reading };
}
function computeRead({ panel, panel6, panelRegistered = null, files, sha, ctrl, entry, dec, bar, runnerSha, barCheck }) {
  if ((panel.numeraire || "registered") !== (dec.numeraire || "registered")) throw new Error(`computeRead: panel numeraire ${panel.numeraire} != decision ${dec.numeraire}`);
  const ctx = prepare(panel, TRIO), ev = evaluateRule(ctx, { bar, placeboForm: dec.placebo });
  if (ev.error || !ev.S) return { out: { id: ID, read: true, verdictScript: `CANNOT MEASURE — ${ev.error}` }, lines: [`R312 CANNOT MEASURE — ${ev.error}`] };
  // the registered formula (and registered placebo form), computed and reported beside the rule in force — never a gate when a token is in force
  let registeredFormula = null;
  if (panelRegistered && (dec.numeraire === "usd" || dec.placebo !== "registered")) {
    const evR = evaluateRule(prepare(panelRegistered, TRIO), { bar, placeboForm: "registered" });
    registeredFormula = evR.S ? { role: "REPORTED ONLY (registered short = F/S1 - 1, registered own-turnover placebo); the gates in force are above", meanNetPctPerMonth: evR.S.meanNetPctPerMonth, tNW: r3(evR.S.tNet), winRatePct: pc(evR.S.winRate), gates: evR.gates, verdictWouldBe: verdictOf(evR),
      numeraireGapPctPerMonth: r4(100 * (evR.S.meanNet - ev.S.meanNet)) } : { error: evR.error };
  }
  const S = ev.S, keys = ctx.keys, carry = ev.carry;
  const legStat = (c, run) => { const s = seriesStats(run.legs[c].net, keys); return { months: s.n, meanNetPctPerMonth: s.meanNetPctPerMonth, tNW: r3(s.tNet), winRatePct: pc(s.winRate), activeSharePct: pc(run.legs[c].pos.filter((p) => p !== 0).length / keys.length), longMonths: run.legs[c].pos.filter((p) => p === 1).length, shortMonths: run.legs[c].pos.filter((p) => p === -1).length }; };
  const unf = runStrategy(ctx, "unfiltered"), x2 = runStrategy(ctx, "carry", { costMult: 2 }), Su = seriesStats(unf.port, keys), S2 = seriesStats(x2.port, keys), St = seriesStats(ev.trend.port, keys);
  let pool = null;
  { const c6 = prepare(panel6, POOL6); if (c6.error || c6.gaps.length) pool = { error: c6.error || `gaps: ${c6.gaps.slice(0, 5).join("; ")}` };
    else { const r6 = runStrategy(c6, "carry"), s6 = seriesStats(r6.port, c6.keys); pool = { currencies: POOL6, from: c6.keys[0], to: c6.keys[c6.keys.length - 1], months: s6.n, meanNetPctPerMonth: s6.meanNetPctPerMonth, tNW: r3(s6.tNet), winRatePct: pc(s6.winRate), perCurrency: Object.fromEntries(POOL6.map((c) => [c, legStat(c, r6)])), note: "context only (reported, no gate); JPY/CAD/AUD rates carried flat after their OECD series end" }; } }
  const jW = carry.port.indexOf(Math.min(...carry.port)), named = ["2008-09", "2008-10", "2008-11", "2015-01", "2016-06"].map((m) => { const j = keys.indexOf(m); return j < 0 ? { month: m, inWindow: false } : { month: m, portfolioPct: r4(100 * carry.port[j]), legsPct: Object.fromEntries(TRIO.map((c) => [c, { pos: carry.legs[c].pos[j], netPct: r4(100 * carry.legs[c].net[j]) }])) }; });
  const y2008 = keys.map((k, j) => (k.startsWith("2008-") ? carry.port[j] : null)).filter((x) => x != null).reduce((p, x) => p * (1 + x), 1) - 1;
  const activeAny = keys.filter((_, j) => TRIO.some((c) => carry.legs[c].pos[j] !== 0)).length;
  const gates = { ...ev.gates }, verdict = verdictOf(ev);
  const out = {
    id: ID, read: true, asOf: new Date().toISOString(), unit: "months", n: S.n, nExpected: N_EXPECTED, from: keys[0], to: keys[keys.length - 1],
    tNet: r4(S.tNet), tNetRaw: S.tNet, meanNet: S.meanNet, meanNetPctPerMonth: S.meanNetPctPerMonth, winRate: S.winRate, winRatePct: pc(S.winRate),
    winRateNote: "share of ALL window months with net > 0 (an all-flat month is 0, not a win)", winRateActiveMonths: (() => { const a = carry.port.filter((_, j) => TRIO.some((c) => carry.legs[c].pos[j] !== 0)); return a.length ? a.filter((x) => x > 0).length / a.length : null; })(),
    placebo: { form: dec.placebo, draws: ev.pl.draws, seed: ev.pl.seed, p95: ev.pl[dec.placebo === "same-cost" ? "sameCost" : dec.placebo === "month-flip" ? "monthFlip" : "registered"].p95, observed: S.meanNet, beats: gates.placeboP95Beaten,
      forms: { registered: { p95: ev.pl.registered.p95, p50: ev.pl.registered.p50, beats: ev.placeboAlt.registered }, sameCost: { p95: ev.pl.sameCost.p95, p50: ev.pl.sameCost.p50, beats: ev.placeboAlt.sameCost }, monthFlip: { p95: ev.pl.monthFlip.p95, p50: ev.pl.monthFlip.p50, beats: ev.placeboAlt.monthFlip } } },
    carryAdds: { pairedDiffMean: ev.diffMean, pairedDiffMeanPctPerMonth: r4(100 * ev.diffMean), pairedDiffT: r3(ev.diffT), positive: gates.carryAddsOverTrendOnly, trendOnly: { meanNetPctPerMonth: St.meanNetPctPerMonth, tNW: r3(St.tNet) },
      reading: "trend-only = the same three currency legs every window month, direction = sign of the 12-month compounded long-foreign excess, no rate gate, same cost model" },
    halves: { first: S.halves.first, second: S.halves.second }, post2008: S.post2008,
    controls: ctrl ? { selftest: ctrl.selftest && ctrl.selftest.pass, leakRegistered: ctrl.leakTest && ctrl.leakTest.registered, leakUipNull: ctrl.leakTest && ctrl.leakTest.uipNull, leakInForce: dec.leak, leakVerdict: ctrl.leakTest && ctrl.leakTest.inForceResult, positiveControl: ctrl.positiveControl, preReadDecision: dec } : null,
    calibration: ctrl && ctrl.calibration ? { gateSet: ctrl.calibration.gateSet, primaryNull: ctrl.calibration.primaryNull, wholeRuleFalsePassPrimary: ctrl.calibration.wholeRuleFalsePassPrimary, wholeRuleFalsePassBootstrap: ctrl.calibration.wholeRuleFalsePassBootstrap, wholeRuleFalsePassFlip: ctrl.calibration.wholeRuleFalsePassFlip,
      underPowered: ctrl.calibration.underPowered, powerGap: ctrl.calibration.powerGap, placeboGivenT: ctrl.calibration.placeboGivenT, flags: ctrl.flags, findings: ctrl.calibration.findings,
      gatePassShareNullJoint: ctrl.calibration.nulls.nullJoint && ctrl.calibration.nulls.nullJoint.gatePassShare } : null,
    placeboNote: ctrl && ctrl.calibration && ctrl.calibration.placeboGivenT ? (ctrl.calibration.placeboGivenT.impliedByT ? `the placebo gate is implied by t >= bar: on the pre-read scrambles it failed on 0 of the ${ctrl.calibration.placeboGivenT.tCleared} seeds where t cleared — a PASS does not carry it as an independent second confirmation` : `on the pre-read scrambles the placebo failed on ${ctrl.calibration.placeboGivenT.placeboFailed} of ${ctrl.calibration.placeboGivenT.tCleared} seeds where t cleared`) : null,
    bar: { tRequired: bar, source: "registry bar.tRequired", atObservedN: barCheck },
    returnFormula: dec.numeraire === "usd" ? "return:usd-numeraire — short foreign = 1 - S1/F (USD P&L of a short future per USD notional)" : "return:registered — short foreign = F/S1 - 1",
    gates, cannotMeasure: ev.cannotMeasure ? ev.cannotMeasureWhy : null, verdictScript: verdict, failReading: failReadingOf(ev, ctrl && ctrl.calibration ? ctrl.calibration.powerGap : null), registeredFormula,
    reported: {
      eachCurrency: Object.fromEntries(TRIO.map((c) => [c, legStat(c, carry)])),
      unfilteredCarry: { meanNetPctPerMonth: Su.meanNetPctPerMonth, tNW: r3(Su.tNet), winRatePct: pc(Su.winRate), perCurrency: Object.fromEntries(TRIO.map((c) => [c, legStat(c, unf)])) },
      trendOnly: { meanNetPctPerMonth: St.meanNetPctPerMonth, tNW: r3(St.tNet) },
      pool6: pool,
      worstMonth: { month: keys[jW], portfolioPct: r4(100 * carry.port[jW]) }, worst12Months: worst12(carry.port, keys), namedCrashes: named, year2008CompoundedPct: r4(100 * y2008),
      costX2: { meanNetPctPerMonth: S2.meanNetPctPerMonth, tNW: r3(S2.tNet), winRatePct: pc(S2.winRate) },
      shareActive: { anyLegPct: pc(activeAny / keys.length), meanActiveLegs: r3(keys.reduce((s, _, j) => s + TRIO.filter((c) => carry.legs[c].pos[j] !== 0).length, 0) / keys.length), perCurrencyPct: Object.fromEntries(TRIO.map((c) => [c, pc(carry.legs[c].pos.filter((p) => p !== 0).length / keys.length)])) },
      filledRateMonths: Object.fromEntries(Object.entries(ev.fills).map(([k, v]) => [k, { filled: v.filled, sharePct: pc(v.share), list: v.list.map((x) => ({ heldMonth: x.heldMonth, rateMonth: x.rateMonth, method: x.method, value: x.value })) }])),
    },
    readings: ["fill rule applied to the interior US 2020-04 hole as well as to months after a series ends", `placebo form in force: ${dec.placebo} (the other forms are reported in placebo.forms)`, "carry-adds: trend-only on the same three legs every month (the 'same active leg-months' reading is identically zero)", `final month ${LAST_MONTH} month-end spot = the last fixing in the cache (see coverage)`, `return formula in force: ${dec.numeraire === "usd" ? "usd-numeraire" : "registered"}`],
    cache: { dir: CACHE_REL, sha256: sha, files }, runner: { file: "backend/r312-europe-carry.js", sha256: runnerSha },
  };
  const lines = [
    `R312 READ — ${verdict}`,
    `  ${S.n} months ${keys[0]}..${keys[keys.length - 1]} · mean ${S.meanNetPctPerMonth}%/month · t_NW ${r3(S.tNet)} (bar ${bar}) · win ${pc(S.winRate)}%`,
    `  placebo (${dec.placebo}) p95 ${r4(100 * out.placebo.p95)}% beaten ${out.placebo.beats} · carry adds ${r4(100 * ev.diffMean)}% (${gates.carryAddsOverTrendOnly}) · halves ${S.halves.first.meanNetPctPerMonth}/${S.halves.second.meanNetPctPerMonth}% · post-2008 ${S.post2008.meanNetPctPerMonth}%`,
    `  gates ${JSON.stringify(gates)}`,
  ];
  if (out.failReading) lines.push(`  reading: ${out.failReading.reading}`);
  if (out.placeboNote) lines.push(`  ${out.placeboNote}`);
  if (registeredFormula && !registeredFormula.error) lines.push(`  reported only — registered formula: mean ${registeredFormula.meanNetPctPerMonth}%/month · t_NW ${registeredFormula.tNW} · would read ${registeredFormula.verdictWouldBe}`);
  return { out, lines };
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const nullOptsFor = (numeraire) => (numeraire === "usd" ? { kind: "usd", theta: 1, joint: true } : { kind: "uip", joint: true });
const gateOf = (dec) => (dec && dec.decided ? { numeraire: dec.numeraire, placebo: dec.placebo } : { numeraire: "registered", placebo: "registered" });
/** The controls for one gate set on the cached data: leak tests (seed 1), positive control, dry read, calibration. Scrambles + oracle only. */
function controlsFor({ raw, files, sha, entry, dec, bar, runnerSha, barCheck, log }) {
  const gate = gateOf(dec), nullOpts = nullOptsFor(gate.numeraire);
  const panel = buildPanel(raw, TRIO, { numeraire: gate.numeraire }), ctx = prepare(panel, TRIO);
  if (ctx.error) throw new Error(`panel: ${ctx.error}`);
  const from = ctx.a;
  // registered leak test and the no-edge-null leak test (seed 1): the rule in force run unchanged on the scramble, |t| < 2 (a null t fails)
  const leakReg = scrambleEval(panel, 1, { from, kind: "leak", joint: false }, bar, gate.placebo), leakNull = scrambleEval(panel, 1, { from, ...nullOpts }, bar, gate.placebo);
  const leakRegPass = leakReg.t != null && Math.abs(leakReg.t) < 2, leakNullPass = leakNull.t != null && Math.abs(leakNull.t) < 2, leakRes = leakInForce(dec && dec.decided ? dec : { decided: true, leak: "registered" }, leakRegPass, leakNullPass);
  // positive control: look-ahead oracle (sign of the realised month's excess return) on every leg every month — real panel and null seed 1
  const oracle = (P) => { const c = prepare(P, TRIO), r = runStrategy(c, "oracle"), s = seriesStats(r.port, c.keys); return { months: s.n, meanNetPctPerMonth: s.meanNetPctPerMonth, tNW: r3(s.tNet) }; };
  const pcReal = oracle(panel), pcNull = oracle(scramblePanel(panel, TRIO, { seed: 1, ...nullOpts, from })), pcPass = pcReal.tNW >= 3 && pcNull.tNW >= 3;
  // dry read on null seed 1: the read's code path end to end (schema check only; scramble numbers, no real statistic)
  const panel6 = buildPanel(raw, POOL6, { numeraire: gate.numeraire }), ctx6 = prepare(panel6, POOL6);
  const dryP = scramblePanel(panel, TRIO, { seed: 1, ...nullOpts, from }), dryP6 = scramblePanel(scramblePanel(panel6, TRIO, { seed: 1, ...nullOpts, from }), ["JPY", "CAD", "AUD"], { seed: 1, ...nullOpts, joint: false, from: ctx6.a });
  const dryDec = dec && dec.decided ? dec : preReadDecision({});
  const dry = computeRead({ panel: dryP, panel6: dryP6, panelRegistered: { ...dryP, numeraire: "registered" }, files, sha, ctrl: null, entry, dec: dryDec, bar, runnerSha, barCheck }).out;
  const need = ["id", "read", "unit", "n", "tNet", "meanNet", "meanNetPctPerMonth", "winRate", "placebo", "carryAdds", "halves", "post2008", "bar", "gates", "verdictScript", "failReading", "returnFormula", "registeredFormula", "reported", "cache", "runner"];
  const dryMissing = need.filter((k) => dry[k] === undefined).concat(["draws", "p95", "observed", "beats"].filter((k) => dry.placebo && dry.placebo[k] === undefined).map((k) => `placebo.${k}`), ["eachCurrency", "unfilteredCarry", "pool6", "worstMonth", "worst12Months", "costX2", "shareActive", "filledRateMonths"].filter((k) => !dry.reported || dry.reported[k] === undefined).map((k) => `reported.${k}`));
  if ((dryDec.numeraire === "usd" || dryDec.placebo !== "registered") && !(dry.registeredFormula && !dry.registeredFormula.error)) dryMissing.push("registeredFormula (required when a token is in force)");
  const dryOk = !dryMissing.length && !(dry.reported.pool6 && dry.reported.pool6.error);
  log(`  [${gate.numeraire}/${gate.placebo}] dry read on null seed 1 (schema only): ${dryOk ? "complete" : `INCOMPLETE ${JSON.stringify(dryMissing)} ${dry.reported && dry.reported.pool6 && dry.reported.pool6.error || ""}`}`);
  const calibration = calibrate(panel, from, bar, gate, log);
  const nullName = gate.numeraire === "usd" ? "USD-fair null (simple long excess S/F - 1 demeaned, one shared permutation, S = F(1 + l'))" : "log-fair UIP-null (demeaned log changes, one shared permutation, rate gap added back)";
  return { gate, panel, ctx, from,
    leakTest: { registered: { method: "spot log changes shuffled across months within each currency (independent permutations), NOT demeaned, rates kept; seed 1; the R312 rule in force unchanged", requirement: "|t_NW| < 2 (a null t fails)", t: r3(leakReg.t), meanNetPctPerMonth: r4(100 * leakReg.meanNet), pass: leakRegPass },
      uipNull: { method: `${nullName}; seed 1; rates kept`, requirement: "|t_NW| < 2", t: r3(leakNull.t), meanNetPctPerMonth: r4(100 * leakNull.meanNet), pass: leakNullPass }, inForce: dec && dec.decided ? dec.leak : null, inForceResult: leakRes },
    positiveControl: { method: "position = sign of the realised month's excess return (look-ahead), every leg every month, registered costs", requirement: "t_NW >= 3 on the real panel and on null seed 1", real: pcReal, uipNullSeed1: pcNull, pass: pcPass },
    dryRead: { on: `${nullName} seed 1 (scramble, all six currencies)`, schemaComplete: dryOk, missing: dryMissing, verdictOnScramble: dry.verdictScript },
    calibration, dryOk, pcPass, leakRes };
}
async function main() {
  const st = selftest();
  console.log(`R312 selftest ${st.pass ? "PASS" : "FAIL"} ${JSON.stringify(st.checks)}`);
  if (!st.pass) { console.log(`  detail ${JSON.stringify(st.detail)}`); process.exit(1); }
  if (SELFTEST_ONLY) return;
  const runnerSha = sha256(fs.readFileSync(__filename));

  if (!READ) {
    // CONTROLS RUN — scrambles, the look-ahead positive control and coverage only. The real R312 statistic is never computed here.
    const entry = registryEntry(), bar = entry && entry.bar ? Number(entry.bar.tRequired) : NaN;
    if (!entry) { console.error(`${ID} not registered — refusing`); process.exit(2); }
    if (!fin(bar)) { console.error(`${ID} registry entry has no numeric bar.tRequired — refusing`); process.exit(2); }
    const asOf = new Date().toISOString(), decision = preReadDecision(entry), gate = gateOf(decision);
    const { raw, files, sha, fetched } = await loadOrFetch(CACHE_DIR, { allowFetch: true, refresh: REFRESH });
    console.log(`R312 FRED cache ${fetched.length ? `fetched ${fetched.join(",")}` : "read"} — ${Object.keys(files).length} series · sha256 ${sha}`);
    console.log(`R312 pre-read decision: ${decision.decided ? `${decision.amended ? `tokens ${JSON.stringify(decision.tokens)}` : "registered design (no runnerGates token)"} -> return ${gate.numeraire}, placebo ${gate.placebo}, leak ${decision.leak}` : `UNREADABLE (${decision.why})`}`);
    const panelChk = buildPanel(raw, TRIO, { numeraire: gate.numeraire }), ctxChk = prepare(panelChk, TRIO);
    if (ctxChk.error) { console.error(`${ID} panel: ${ctxChk.error}`); process.exit(2); }
    const cov = coverage(raw, files, panelChk, ctxChk), n = ctxChk.idx.length;
    const barCheck = barAtN(n); barCheck.registered = bar; barCheck.differs = Math.abs(barCheck.bar - bar) > 0.0005; barCheck.nDiffersFromExpected = n !== N_EXPECTED;
    console.log(`R312 window ${cov.window.firstHeldMonth}..${cov.window.lastHeldMonth} n ${n} (expected ${N_EXPECTED}) · bar at n ${barCheck.bar} (NW ${barCheck.nwSim}, iid ${barCheck.iid}; registry ${bar})${barCheck.differs ? " — DIFFERS" : ""} · gaps ${ctxChk.gaps.length}`);
    console.log(`R312 calibrating the gate set IN FORCE (${gate.numeraire}/${gate.placebo}; ${CAL.primary}/${CAL.bootstrap}/${CAL.flip} primary-family seeds, ${PLACEBO_DRAWS} placebo draws each) ...`);
    const C0 = controlsFor({ raw, files, sha, entry, dec: decision, bar, runnerSha, barCheck, log: (s) => console.log(s) });
    // the PROPOSED gate set (this review), calibrated beside the in-force set while the registry does not yet carry it — REPORTED ONLY
    let proposed = null;
    if (gateTokensOf(decision).join("|") !== [...PROPOSED_TOKENS].sort().join("|")) {
      const decP = preReadDecision({ amendments: [{ date: "proposed", preEvidence: true, runnerGates: PROPOSED_TOKENS }] });
      console.log(`R312 calibrating the PROPOSED gate set ${JSON.stringify(PROPOSED_TOKENS)} (reported only) ...`);
      const CP = controlsFor({ raw, files, sha, entry, dec: decP, bar, runnerSha, barCheck, log: (s) => console.log(s) });
      proposed = { role: "REPORTED ONLY — the gate set the 2026-10-02 review proposes; it binds only after the registry carries a preEvidence amendment naming these tokens (then re-run the controls)", tokens: PROPOSED_TOKENS, decision: decP,
        leakTest: CP.leakTest, positiveControl: CP.positiveControl, dryRead: CP.dryRead, calibration: CP.calibration, toleranceHold: toleranceHold(CP.calibration, decP, "(a future controls run)") };
    }
    const calibration = C0.calibration;
    const pass = st.pass && C0.pcPass && C0.leakRes.pass && C0.dryOk && decision.decided;
    const holds = [];
    if (!decision.decided) holds.push(`pre-read decision unreadable (${decision.why})`);
    if (decision.decided && !C0.leakRes.pass) holds.push(`leak precondition (${decision.leak}) FAILED: ${C0.leakRes.why} (registered t ${C0.leakTest.registered.t}, no-edge-null t ${C0.leakTest.uipNull.t})`);
    if (!C0.pcPass) holds.push("positive control failed");
    if (!C0.dryOk) holds.push("dry read schema incomplete");
    const th = toleranceHold(calibration, decision, asOf); if (th) holds.push(th);
    if (!cov.finalMonthComplete) holds.push(`final month ${LAST_MONTH} incomplete: ${TRIO.map((c) => `${c} last fixing ${cov.lastMonthSpot[c].lastFixing}`).join(", ")} — rerun with --refresh-cache after the next H.10 posting, then re-run the controls`);
    if (decision.decided && !decision.tokens.some((g) => g.startsWith("return:"))) holds.push(`the return numeraire is undecided: the registered short = F/S1 - 1 is the long-USD return in FOREIGN currency (exceeds a short future USD P&L by (1-x)^2/x every month) — record a preEvidence amendment carrying return:usd-numeraire (proposed set ${JSON.stringify(PROPOSED_TOKENS)}) or return:registered to read the formula as written, then re-run the controls`);
    const flags = [];
    if (barCheck.differs) flags.push(`bar at the observed n with the register's method, seed 312 (${barCheck.bar}: NW ${barCheck.nwSim}, iid ${barCheck.iid}) differs from the registry (${bar}); the registry's iid component was an unseeded Math.random draw — the registry bar stands (stricter)`);
    if (calibration.underPowered) flags.push(`UNDER-POWERED: a carry premium equal to the rate gap passes the rule on ${pc(calibration.powerGap.x1.perm)}% / ${pc(calibration.powerGap.x1.boot)}% / ${pc(calibration.powerGap.x1.flip)}% of seeds (perm / boot / flip) — a DID NOT PASS cannot distinguish 'no premium' from 'premium too small for 26 years of three correlated legs'`);
    const ready = pass && !holds.length;
    writeJsonAtomic(CTRL, { spec: CTRL_SPEC, id: ID, asOf, runner: { file: "backend/r312-europe-carry.js", sha256: runnerSha },
      cache: { dir: CACHE_REL, sha256: sha, files }, coverage: cov, barCheck, selftest: st,
      leakTest: C0.leakTest, positiveControl: C0.positiveControl, dryRead: C0.dryRead,
      calibration, preReadDecision: decision, gateTokens: gateTokensOf(decision), proposed, pass, ready, holds, flags,
      howToRecordADecision: { where: "backend/data/test-registry.json, the R312 entry: append to amendments[] (create it) BEFORE the read, plus a dated change-registry entry", shape: { date: "YYYY-MM-DD", preEvidence: true, field: "...", was: "...", becomes: "...", why: "...", runnerGates: PROPOSED_TOKENS }, tokens: RUNNER_GATES,
        rule: "at most one token per family (leak:*, placebo:*, return:*, calibration:*); unknown tokens refuse the read; no runnerGates token (absent or []) = the registered design and lifts no hold; the over-tolerance hold lifts only with calibration:accept in an amendment whose controlsAsOf equals this file's asOf; the read refuses unless these controls were run under the same gate tokens" },
      note: "Only scrambles, the look-ahead oracle and data coverage are computed here; the real R312 carry statistic is never computed or written by the controls run." });
    console.log(`R312 controls — selftest PASS · leak registered ${C0.leakTest.registered.pass ? "PASS" : "FAIL"} (t ${C0.leakTest.registered.t}) · leak no-edge-null ${C0.leakTest.uipNull.pass ? "PASS" : "FAIL"} (t ${C0.leakTest.uipNull.t}) · positive control ${C0.pcPass ? "PASS" : "FAIL"} (real t ${C0.positiveControl.real.tNW}, null t ${C0.positiveControl.uipNullSeed1.tNW})`);
    console.log("  IN FORCE:"); for (const f of calibration.findings) console.log(`    ${f}`);
    if (proposed) { console.log(`  PROPOSED (reported only): leak registered t ${proposed.leakTest.registered.t} (${proposed.leakTest.registered.pass ? "PASS" : "FAIL"}) · leak USD-fair t ${proposed.leakTest.uipNull.t} (${proposed.leakTest.uipNull.pass ? "PASS" : "FAIL"}) · precondition ${proposed.leakTest.inForceResult.pass ? "PASS" : "FAIL"} · positive control ${proposed.positiveControl.pass ? "PASS" : "FAIL"} · dry read ${proposed.dryRead.schemaComplete ? "complete" : "INCOMPLETE"} · tolerance ${proposed.calibration.wholeRuleWithinTolerance ? "within" : "EXCEEDED"}`); for (const f of proposed.calibration.findings) console.log(`    ${f}`); }
    console.log(`  coverage: ${TRIO.map((c) => `${c} ${CCY[c].spot} last fixing ${cov.lastMonthSpot[c].lastFixing}`).join(" · ")} · filled ${Object.entries(cov.filledRateMonths).map(([k, v]) => `${k} ${v.filled}`).join(" ")}`);
    for (const fl of flags) console.log(`  FLAG ${fl}`);
    console.log(ready ? "R312 READY — the one read is: node backend/r312-europe-carry.js --read" : `R312 NOT READY — ${holds.join(" | ")}`);
    return;
  }

  // ── THE READ (once) ──
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if ((seals.tests || {})[ID]) { console.error(`${ID} already sealed — refusing`); process.exit(2); }
  if (fs.existsSync(OUT) && JSON.parse(fs.readFileSync(OUT, "utf8")).read) { console.error(`${ID} already read — seal it, do not re-read`); process.exit(2); }
  const ctrl = fs.existsSync(CTRL) ? JSON.parse(fs.readFileSync(CTRL, "utf8")) : null;
  if (!ctrl || ctrl.spec !== CTRL_SPEC) { console.error(`${ID} no controls file (spec ${CTRL_SPEC}) — run the controls first`); process.exit(2); }
  const entry = registryEntry();
  const pre = readPreconditions({ ctrl, entry, runnerSha });   // pure; every refusal is selftested
  if (pre.refuse) { console.error(`${ID} ${pre.refuse}`); process.exit(2); }
  const { dec, bar } = pre;
  const { raw, files, sha } = await loadOrFetch(CACHE_DIR, { allowFetch: false });
  if (!ctrl.cache || ctrl.cache.sha256 !== sha) { console.error(`${ID} FRED cache sha256 ${sha} differs from the controls run's ${ctrl.cache && ctrl.cache.sha256} — refusing`); process.exit(2); }
  const { out, lines } = computeRead({ panel: buildPanel(raw, TRIO, { numeraire: dec.numeraire }), panel6: buildPanel(raw, POOL6, { numeraire: dec.numeraire }), panelRegistered: buildPanel(raw, TRIO, { numeraire: "registered" }), files, sha, ctrl, entry, dec, bar, runnerSha, barCheck: ctrl.barCheck });
  writeJsonAtomic(OUT, out);
  for (const l of lines) console.log(l);
}

// Run only when invoked directly. A require() (the forward recorder, tests) gets the pure functions and never reaches main.
if (require.main === module) main().catch((e) => { console.error("R312 FAILED:", e.message); process.exit(1); });
else module.exports = { ID, CCY, US, TRIO, POOL6, SERIES, DEAD_ZONE, TREND_N, COST_TRADE, COST_HOLD, LAST_MONTH, parseFred, monthEndSpot, rateSeries, buildPanel, legReturns, decideAt, decideMonth,
  prepare, runStrategy, seriesStats, placeboRun, evaluateRule, verdictOf, scramblePanel, preReadDecision, gateTokensOf, toleranceHold, leakInForce, readPreconditions, failReadingOf, registryEntry, barAtN, computeRead, selftest, nwT, mean, mulberry, addM, monthsBetween, loadOrFetch, fetchFred, sha256, RUNNER_GATES, PROPOSED_TOKENS, NUMERAIRES };
