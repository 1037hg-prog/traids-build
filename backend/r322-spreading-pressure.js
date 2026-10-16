#!/usr/bin/env node
/**
 * R322 — SPECULATOR SPREADING PRESSURE, weekly commodity cross-section (Gozluklu et al.; registered 2026-10-03). The frozen spec is
 * the R322 entry of data/test-registry.json (preregistered); this runner implements that entry and nothing else. Harness pattern:
 * r313-ibs-etfs.js (selftest -> controls run -> one --read).
 *
 *   RULE (registered) Each COT report (legacy, futures only, as of Tuesday T, published Friday 15:30 ET): SP = noncommercial SPREADING
 *            / total open interest per commodity root. Rank SP ascending; LONG the bottom tercile, SHORT the top tercile (floor(N/3)
 *            each; ties by root id), equal-RISK inside each leg (w ∝ 1/sd of the 60 daily returns to the close before entry; each leg
 *            sums to $1), from the first session after the release (open) to the next week's entry open. Unit = week. Cost: 1 tick +
 *            $2.50 per side per contract change (|Δw| at each entry open, at that root's unadjusted open; final liquidation charged),
 *            plus a roll cost (2 sides x |w|) for every roll inside a holding window.
 *   STAT     mean weekly long-short net return; Newey-West t, lag 4 (Bartlett 1 - l/5). Bar READ FROM THE REGISTRY.
 *   GATES    PASS iff mean > 0 AND t_NW >= bar AND observed mean > placebo p95 (SP ranks shuffled across roots each week, 1,000
 *            draws, seed 322, p95 = sorted[floor(0.95 x draws)]) AND both halves (first floor(n/2) weeks / the rest) > 0.
 *            CANNOT MEASURE if < 15 roots have >= 8 years of continuous daily front/back history from free sources (Schwab
 *            pricehistory, CFTC COT).
 *
 *   DATA (cached once under data/training/r322/, sha256 in every output; the read never refetches)
 *            - Schwab marketdata/v1/pricehistory daily (lib/schwab.js token; read-only GET): every candidate /ROOT 1990-01-01 ..
 *              2026-10-02 (bars after 2026-10-02 dropped: forming-bar guard), plus TWO per-contract probes per root: an expired
 *              contract (<M>24) and a deferred one (<M>27).
 *            - CFTC public reporting (Socrata 6dca-aqww, legacy futures-only; no login): open_interest_all, noncomm_postions_spread_all
 *              (sic), noncomm long/short, per CFTC contract code.
 *
 *   FINDING THAT DECIDES THE REGISTERED PATH (probed 2026-10-03, re-checked by every controls run from the cache): Schwab pricehistory
 *            serves ONLY its own continuous front series. A contract-specific symbol (/CLZ26, /CLF27, /CLZ27, /GCG27 ...) returns the
 *            IDENTICAL candles as /ROOT, and an expired contract (/CLZ25) returns no candles. No back-month or expired-contract daily
 *            history exists in the registered free sources, so the registered construction ("continuous contracts back-adjusted by
 *            ratio at a fixed roll, 5 business days before first notice / last trade"; universe "roots with >= 8 years of continuous
 *            daily FRONT/BACK data") qualifies 0 roots -> the registered read is CANNOT MEASURE (decisionRule.cannotMeasure). The
 *            fixed-roll ratio back-adjustment itself is implemented (fixedRollContinuous) and selftested, for the day per-contract
 *            history is available; it is never fed real data here.
 *
 *   OPTIONAL PRE-EVIDENCE CONSTRUCTION (runnerGates token, honoured only via a preEvidence registry amendment):
 *            "construction:schwab-front-gap-ratio" (meaning revised by the 2026-10-03 audit repair; runner hash changed) — Schwab's own
 *            continuous front series, ratio back-adjusted at its rolls. A roll is declared only inside the ROLL SLOT of a listed
 *            contract (ROLL_SPEC, from the exchange contract specs): a front series must roll out of each listed contract after the
 *            previous listed contract's last trade and on or before its own, so each listed contract owns the sessions in
 *            (bound of the previous listed delivery month, bound of its own delivery month], bound = day `ltd` of the delivery month
 *            (an upper bound of the last trading day); every-month roots (CL NG HO RB BZ) use the calendar month restricted to the
 *            days before their last trading day (CL 10-25th, NG HO RB BZ 15-31st). At most one roll
 *            per slot: the session whose overnight gap |open_t / close_{t-1} - 1| is largest relative to the median gap of the same
 *            break type (1-day vs weekend/holiday) over the previous 250 sessions; a slot whose bound lies after the series' last
 *            bar is still open and gets none. Every earlier price is multiplied by open_t / close_{t-1} (the overnight gap is removed,
 *            the roll session's own open->close move is kept). Universe = candidate roots whose Schwab front series has a continuous
 *            run (no gap > 10 calendar days) of >= 8 years ending >= 2026-09-30 with >= 90% of the reference sessions, plus >= 8 years
 *            of legacy COT spreading overlapping it (a root whose COT stops leaves the cross-section at that date). Roll cost charged
 *            at each declared roll inside a holding window. Everything else exactly as registered. Detection quality (price gaps only)
 *            is reported per root (energies: share inside the exchange roll window; all: large gaps left undeclared).
 *            OPTIONAL "floor:drift-kept" (only with the construction token): + mean > p95 of the 60 drift-kept scramble means AND
 *            NW t of (net - their p50) >= bar — a timing hypothesis, not the registered cross-sectional one (operator's call).
 *
 *   CONTROLS (controls run; never computes the real SP book on the real path) depth table from the cache; structural leak checks +
 *            arithmetic-zero-drift scrambles seeds 1, 2 (t_NW < 2); look-ahead positive control (rank on the week's own return,
 *            t_NW >= 3); WHOLE-RULE false-pass calibration of both gate sets on: 200 SP-label derangements on the real path (deranged
 *            within each week's names: persistent no-edge signals), 200 placebo-family books (the registry's named family), 100
 *            arithmetic-zero-drift scrambles (each root's adjusted daily path shuffled, E[daily factor] = 1, real SP), 100 roll-leak
 *            worlds (the same scrambles with the real roll factors multiplied back in at their sessions, rolls re-detected and
 *            re-adjusted: the detector's misses and false rolls, SP-aligned; paired change in t vs the plain scramble reported),
 *            and 60 drift-kept scrambles (REPORTED for the registered gates: they keep the real SP's static alignment with each
 *            root's realised drift, i.e. the cross-sectional content of the hypothesis).
 *
 *   TIMING   release = Friday of T's week, 15:30 ET; moved to the next non-closure weekday >= Monday only when a US federal holiday /
 *            federal closure falls Wed..Fri of T's week (CFTC 2026 release schedule: Monday holidays keep the Friday release; CFTC
 *            2018-12-21 notice and the 2025 schedule table: Tuesday-holiday weeks publish Friday). A Friday without a reference
 *            session (Good Friday: CFTC publishes) does not move the release; entry is then the Monday session, as registered.
 *            Entry = first reference session dated AFTER the release (its open is the 17:00 CT Globex open, after 15:30 ET).
 *            Reports CFTC published late are not traded: the 2013, 2018-19 and 2025 shutdown catch-ups and the 2023 ION incident
 *            (CFTC Historical Special Announcements; 2025 catch-up ended with the as-of 2025-12-16 report, published 12-23).
 *            A --read with the registered construction is HELD while the controls file carries a construction amendment proposal,
 *            unless --accept-cannot-measure is passed (the CANNOT MEASURE read is permanent).
 *
 *   node backend/r322-spreading-pressure.js --selftest | (no flag: controls run, prints READY / NOT READY) | --read
 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const ID = "R322", STEM = "r322-spreading-pressure", READ = process.argv.includes("--read"), SELFTEST_ONLY = process.argv.includes("--selftest");
const OUT = D(`${STEM}.json`), CTRL = D(`${STEM}-controls.json`);
const CACHE_DIR = path.join(__dirname, "data", "training", "r322"), CACHE = path.join(CACHE_DIR, "cache-v1-19900101-20261002.json");
const CACHE_REL = "backend/data/training/r322/cache-v1-19900101-20261002.json";
const FETCH_START = "1990-01-01", LAST_BAR = "2026-10-02", START_MS = Date.parse("1990-01-01T00:00:00Z"), END_MS = Date.parse("2026-10-02T23:59:59Z");
const WINDOW_LAST_EXIT = "2026-09-30", READABLE_FROM = "2026-10-01", CURRENT_FROM = "2026-09-30";
const MIN_ROOTS = 15, MIN_YEARS = 8, MIN_COVERAGE = 0.90, MAX_GAP_DAYS = 10, VOLN = 60, NW_LAG = 4, SLACK_DAYS = 4, MIN_TRADED = 3;
const FEE_SIDE = 2.5, FALLBACK_COST = 0.001, PLACEBO_DRAWS = 1000, PLACEBO_SEED = 322;
const KEPT_SEEDS = 60, FREE_SEEDS = 100, ROLL_LEAK_SEEDS = 100, FORCED_MISS_SEEDS = 50, FORCED_MISS = 0.5, DERANGE_SEEDS = 200, PLACEBO_FAMILY_REPS = 200, MAX_WHOLE_RULE_FALSE_PASS = 0.05, PC_T = 3, LEAK_T = 2;
// root: [sector, CFTC legacy contract code, tick value $, $ per 1.0 of the quoted price, last active month code (probe symbols)].
// The registry's sectors: energy, metals, grains, softs, livestock; no financials (dairy and lumber are none of these: not candidates).
const CANDIDATES = {
  CL: ["energy", "067651", 10, 1000, "Z"], NG: ["energy", "023651", 10, 10000, "Z"], HO: ["energy", "022651", 4.2, 42000, "Z"], RB: ["energy", "111659", 4.2, 42000, "Z"], BZ: ["energy", "06765T", 10, 1000, "Z"],
  GC: ["metals", "088691", 10, 100, "Z"], SI: ["metals", "084691", 25, 5000, "Z"], HG: ["metals", "085692", 12.5, 25000, "Z"], PL: ["metals", "076651", 5, 50, "V"], PA: ["metals", "075651", 5, 100, "Z"],
  ZC: ["grains", "002602", 12.5, 50, "Z"], ZS: ["grains", "005602", 12.5, 50, "X"], ZW: ["grains", "001602", 12.5, 50, "Z"], KE: ["grains", "001612", 12.5, 50, "Z"], ZL: ["grains", "007601", 6, 600, "Z"],
  ZM: ["grains", "026603", 10, 100, "Z"], ZO: ["grains", "004603", 12.5, 50, "Z"], ZR: ["grains", "039601", 10, 2000, "X"], MWE: ["grains", "001626", 12.5, 50, "Z"],
  KC: ["softs", "083731", 18.75, 375, "Z"], SB: ["softs", "080732", 11.2, 1120, "V"], CT: ["softs", "033661", 5, 500, "Z"], CC: ["softs", "073732", 10, 10, "Z"], OJ: ["softs", "040701", 7.5, 150, "X"],
  LE: ["livestock", "057642", 10, 400, "Z"], HE: ["livestock", "054642", 10, 400, "Z"], GF: ["livestock", "061641", 12.5, 500, "X"],
};
const ROOTS_ALL = Object.keys(CANDIDATES);
// COT reports with these as-of dates were published late (CFTC Historical Special Announcements). Not traded. 2013 and 2018-19: shutdown
// catch-ups (conservative windows; the 2013 page has no entries). 2023: ION cyber incident — as-of 01-31..03-14 published 02-24..03-21.
// 2025: shutdown catch-up per the CFTC table of 2025-12-09 — as-of 09-30..12-16 published 11-19..12-23; as-of 12-23 on the normal schedule.
const SHUTDOWN_T = [["2013-10-01", "2013-11-05"], ["2018-12-24", "2019-03-05"], ["2023-01-31", "2023-03-14"], ["2025-09-30", "2025-12-16"]];
// Federal closures by executive order / national days of mourning (COT release slips like a holiday week).
const AD_HOC_CLOSURES = ["2004-06-11", "2007-01-02", "2012-12-24", "2014-12-26", "2018-12-05", "2018-12-24", "2019-12-24", "2020-12-24", "2024-12-24", "2025-01-09", "2025-12-24", "2025-12-26"];
// Pre-read amendment tokens (registry R322 entry: amendments[] { date, preEvidence: true, field, was, becomes, why, runnerGates }).
const TOKEN_CONSTRUCTION = "construction:schwab-front-gap-ratio", TOKEN_FLOOR = "floor:drift-kept";
const RUNNER_GATES = {
  [TOKEN_CONSTRUCTION]: "Schwab continuous front /ROOT daily (Schwab's own roll), ratio back-adjusted at its rolls. A roll is declared only inside a listed contract's roll slot (ROLL_SPEC, exchange specs): the sessions after the previous listed delivery month's last-trade bound up to its own (bound = day ltd of the delivery month: COMEX/NYMEX metals, LE, GF month end; CBOT/KC grains and oilseeds the 14th; HE the 17th); CL NG HO RB (every month listed) the calendar month restricted to the days before the last trading day (CL 10-25th, NG HO RB 15-31st). At most one per slot, at the session whose overnight gap |open/prev close - 1| is largest relative to the trailing-250 median gap of the same break type; a slot whose bound is after the last bar gets none. Every earlier price x open/prev close of that session. Roll cost 2 sides x (1 tick + $2.50) at each declared roll inside a holding window. Release = Friday 15:30 ET of T's week, moved to the next business day >= Monday only for a federal closure Wed-Fri; reports CFTC published late (shutdown catch-ups 2013, 2018-19, 2025 through as-of 2025-12-16; ION as-of 2023-01-31..03-14) are not traded. Universe = candidate roots with a >= 8-year continuous front run (no gap > 10 days, >= 90% of reference sessions, ending >= 2026-09-30) and >= 8 years of legacy COT spreading overlapping it; CANNOT MEASURE if < 15 qualify. Calibration: whole-rule false pass <= 5% on deranged SP labels (within each week's names), the placebo family, arithmetic-zero-drift scrambles and roll-leak worlds. Rule, statistic, bar, placebo, halves and cost otherwise as registered. Replaces the registered fixed-roll front/back construction, which the registered free sources cannot supply (Schwab serves no back-month or expired-contract history).",
  [TOKEN_FLOOR]: "OPTIONAL, only together with the construction token: two added gates — observed mean > the p95 of the controls run's 60 drift-kept scramble means (real SP, each root's adjusted daily path shuffled with its drift kept) AND NW(lag 4) t of (weekly net - their p50) >= the bar. It changes the hypothesis from the published cross-sectional premium (static SP-drift alignment counts) to 'SP beats its own static exposure' (timing); the operator's call.",
};
const fin = Number.isFinite;
const r4 = (x) => (x == null || !fin(x) ? null : +x.toFixed(4)), r3 = (x) => (x == null || !fin(x) ? null : +x.toFixed(3)), r2 = (x) => (x == null || !fin(x) ? null : +x.toFixed(2)), r1 = (x) => (x == null || !fin(x) ? null : +x.toFixed(1));
const pct = (x, k = 4) => (x == null || !fin(x) ? null : +(100 * x).toFixed(k));

// ── dates & calendars ────────────────────────────────────────────────────────────────────────────────────────────────────
const isoUTC = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d, n) => isoUTC(Date.parse(d + "T00:00:00Z") + n * 864e5);
const dow = (d) => new Date(d + "T00:00:00Z").getUTCDay();
const isWeekend = (d) => { const g = dow(d); return g === 0 || g === 6; };
const calDays = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
function nthWeekday(y, m, wd, n) {
  if (n > 0) { const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); return ymd(y, m, 1 + ((wd - first + 7) % 7) + 7 * (n - 1)); }
  const last = new Date(Date.UTC(y, m, 0)), ld = last.getUTCDate(), lw = last.getUTCDay(); return ymd(y, m, ld - ((lw - wd + 7) % 7));
}
function observedDate(y, m, d) { const t = Date.UTC(y, m - 1, d), g = new Date(t).getUTCDay(); return isoUTC(t + (g === 6 ? -1 : g === 0 ? 1 : 0) * 864e5); }
const _hol = new Map();
function federalHolidaysOfYear(y) {
  if (_hol.has(y)) return _hol.get(y);
  const s = new Set([observedDate(y, 1, 1), nthWeekday(y, 1, 1, 3), nthWeekday(y, 2, 1, 3), nthWeekday(y, 5, 1, -1), observedDate(y, 7, 4), nthWeekday(y, 9, 1, 1),
    nthWeekday(y, 10, 1, 2), observedDate(y, 11, 11), nthWeekday(y, 11, 4, 4), observedDate(y, 12, 25)]);
  if (y >= 2021) s.add(observedDate(y, 6, 19));
  _hol.set(y, s); return s;
}
const AD_HOC = new Set(AD_HOC_CLOSURES);
// a federal holiday's observed date can fall in the neighbouring year (New Year's Day on a Saturday -> Friday Dec 31)
function isFederalClosure(d) { const y = +d.slice(0, 4); return AD_HOC.has(d) || federalHolidaysOfYear(y).has(d) || federalHolidaysOfYear(y + 1).has(d) || federalHolidaysOfYear(y - 1).has(d); }
const inShutdown = (T) => SHUTDOWN_T.some(([a, b]) => T >= a && T <= b);
// Release of the report as of T: Friday of T's week 15:30 ET; delayed to the next non-closure weekday >= Monday only when a federal holiday
// or closure falls Wed..Fri of T's week (CFTC 2026 schedule: Monday holidays keep the Friday release; Tuesday-holiday weeks publish Friday
// per the CFTC 2018-12-21 notice and the 2025 table, e.g. as-of 2025-11-10 -> 11-14). A Friday without a reference session (Good Friday:
// CFTC publishes) does not move the release — entry is the next session, the Monday, as registered. Entry = first reference session AFTER it.
// (refSet is accepted for the caller's signature and reported only.)
function releaseOf(T, refSet) {
  const mon = addDays(T, -((dow(T) + 6) % 7)), fri = addDays(mon, 4);
  const hol = [2, 3, 4].map((k) => addDays(mon, k)).filter(isFederalClosure), noFriSession = refSet ? !refSet.has(fri) : false;
  if (!hol.length) return { release: fri, delayed: false, reason: null, noFriSession };
  let r = addDays(fri, 3); while (isWeekend(r) || isFederalClosure(r)) r = addDays(r, 1);
  return { release: r, delayed: true, reason: `federal closure ${hol.join(",")}`, noFriSession };
}
// first index i with arr[i] >= x (arr sorted), or arr.length
function lowerBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; }
function firstAfter(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= x) lo = m + 1; else hi = m; } return lo; }

// ── statistics ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
function sdS(a) { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }
// Newey-West t of the mean, Bartlett weights 1 - l/(L+1), autocovariances over n (R286's nwT); null when n < 3 or the variance <= 0
function nwT(a, L = NW_LAG) {
  const n = a.length; if (n < 3) return null;
  const m = mean(a), e = a.map((x) => x - m); let S = e.reduce((s, x) => s + x * x, 0) / n;
  for (let l = 1; l <= L; l++) { let g = 0; for (let i = l; i < n; i++) g += e[i] * e[i - l]; S += 2 * (1 - l / (L + 1)) * g / n; }
  return S > 0 ? m / Math.sqrt(S / n) : null;
}
function summarise(net) {
  if (!net.length) return { n: 0, meanNet: null, tNW: null, halfFirst: null, halfSecond: null, winRate: null };
  const h = Math.floor(net.length / 2);
  return { n: net.length, meanNet: mean(net), tNW: nwT(net), halfFirst: h ? mean(net.slice(0, h)) : null, halfSecond: mean(net.slice(h)), winRate: net.filter((x) => x > 0).length / net.length, halfN: [h, net.length - h] };
}
function nearestRank(sorted, q) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] : null; }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hash = (s) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);
// the register's bar method at the observed n for an NW(lag 4) t on iid uniform noise (seed 322, 20k trials) — REPORTED only
function barAtN(n, trials = 20000) {
  const rng = mulberry(322), mx = [];
  for (let t = 0; t < trials; t++) { const s = new Array(n); for (let i = 0; i < n; i++) s[i] = rng() * 2 - 1; mx.push(nwT(s)); }
  mx.sort((a, b) => a - b);
  return { n, trials, nwLag4P95: r3(mx[Math.floor(0.95 * trials)]), shareAtOrAbove1624: r4(mx.filter((x) => x >= 1.624).length / trials) };
}

// ── continuous-contract constructions ────────────────────────────────────────────────────────────────────────────────────
// REGISTERED: contracts [{ sym, bars: [{ d, o, c }] }] in roll order, rollDates[k] = the session on which the position moves from
// contract k to k+1 (fixed: 5 business days before FND/LTD, supplied by the caller). Through rollDates[k]'s PREVIOUS session the series
// is contract k; from rollDates[k] on it is contract k+1. Ratio back-adjustment: every price before the roll is multiplied by
// close_{k+1}(prev session) / close_k(prev session) — both contracts priced on the same session (the registered method). Returns
// { d, o, c, factor[] } with the last contract unadjusted. Never fed real data in R322 (no per-contract history in the free sources).
function fixedRollContinuous(contracts, rollDates) {
  if (contracts.length !== rollDates.length + 1) throw new Error("fixedRollContinuous: need one roll date per contract boundary");
  const segs = [];
  for (let k = 0; k < contracts.length; k++) {
    const from = k === 0 ? "0000-00-00" : rollDates[k - 1], to = k === rollDates.length ? "9999-99-99" : rollDates[k];
    segs.push(contracts[k].bars.filter((b) => b.d >= from && b.d < to));
  }
  const factors = new Array(rollDates.length);
  for (let k = 0; k < rollDates.length; k++) {
    const prev = segs[k][segs[k].length - 1]; if (!prev) throw new Error(`fixedRollContinuous: no session of ${contracts[k].sym} before ${rollDates[k]}`);
    const nb = contracts[k + 1].bars.find((b) => b.d === prev.d); if (!nb) throw new Error(`fixedRollContinuous: ${contracts[k + 1].sym} not priced on ${prev.d}`);
    factors[k] = nb.c / prev.c;
  }
  const d = [], o = [], c = [];
  for (let k = 0; k < segs.length; k++) { let f = 1; for (let j = k; j < factors.length; j++) f *= factors[j]; for (const b of segs[k]) { d.push(b.d); o.push(b.o * f); c.push(b.c * f); } }
  return { d, o, c, factors };
}
// TOKEN: rolls of Schwab's own continuous front series. Schwab switches contract at a session boundary, so a roll shows as the overnight
// gap |o_t / c_{t-1} - 1| of the switch session. Gaps after a 1-calendar-day break (Tue-Fri) and after a longer break (weekend, holiday)
// differ in scale, so each gap is scored z_t = |gap_t| / median |gap| of the SAME break type over the previous 250 sessions (>= 20 of
// that type; else the median of the root's first 250 gaps of that type). Per ROLL SLOT the session with the largest z is the roll
// (ties -> earliest; price gaps only — no signal, no strategy return).
// ROLL SLOTS (2026-10-03 audit repair). R286's one-roll-per-calendar-month rule forced a roll into every month although 14 of the 18
// roots roll 4-8 times a year (>= 84 false rolls a year, e.g. CL's +11.46% 2026-03-02 weekend gap erased as "the roll"). A continuous
// front series must roll out of each listed contract after the previous listed contract's last trade and on or before its own, so each
// listed contract owns ONE slot: the sessions in (bound of the previous listed delivery month, bound of its own delivery month], bound =
// day `ltd` of the delivery month, an upper bound of the contract's last trading day under the exchange spec. The auditor's proposed
// "month before delivery / contract month" table was checked against Schwab's gaps (price only) and misses Schwab's other conventions:
// LE rolls in the last days of the month BEFORE the contract month in about half the years (28 gaps of z >= 15 left in), HE rolled a
// month early in 2008-10 (+10-17% gaps left in), GC/HG/SI sometimes roll in the first days of the delivery month. The last-trade slots
// cover all of them with the same number of declared rolls (one per listed contract); on the 15 non-energy roots gaps of z >= 15 left
// undeclared 170 (vs 268 for the month table), declared rolls with z < 5 397 (vs 614). Every-month roots (the auditor's lead example, CL +11.46% on 2026-03-02, is
// one of them, so no month table can fix it): the roll falls on or before the last trading day, which lies in the month before delivery
// (CL <= the 22nd: 3 business days before the 25th; NG <= the 29th: 3 business days before the 1st; HO/RB the last business day; BZ the
// last business day of the second month before), and Schwab's front rolls within ~10 days before it (CL 15-19th, NG 24-29th, HO/RB
// 20-31st). The slot is the calendar month restricted to the days [dom] (CL 10-25, the others 15-31): the old every-day monthly slot
// erased the largest weekend news gaps of the sample as "rolls" and kept the real roll in the returns (CL 2020-03-09 -20.9%, 2022-03-07
// +5.5%, 2023-04-03 +5.8%, 2024-10-28 -3.8%; HO/RB 2021-05-10 Colonial pipeline; in each month the in-window maximum is a roll-sized gap
// in the roll days). A slot whose bound is after the series' last bar is still open (its roll may not have happened) and gets no roll.
const EVERY = (lo, hi) => ({ every: true, dom: [lo, hi] }), GENERIC_SLOT = EVERY(1, 31);
const ROLL_SPEC = {
  CL: EVERY(10, 25), NG: EVERY(15, 31), HO: EVERY(15, 31), RB: EVERY(15, 31), BZ: EVERY(15, 31),   // NYMEX / ICE: every month listed
  GC: { months: [2, 4, 6, 8, 10, 12], ltd: 31 },                                     // COMEX G J M Q V Z; LTD 3rd-last business day of the delivery month
  SI: { months: [3, 5, 7, 9, 12], ltd: 31 }, HG: { months: [3, 5, 7, 9, 12], ltd: 31 }, // COMEX H K N U Z; LTD 3rd-last business day
  PL: { months: [1, 4, 7, 10], ltd: 31 }, PA: { months: [3, 6, 9, 12], ltd: 31 },     // NYMEX F J N V / H M U Z; LTD 3rd-last business day
  ZC: { months: [3, 5, 7, 9, 12], ltd: 14 }, ZW: { months: [3, 5, 7, 9, 12], ltd: 14 }, KE: { months: [3, 5, 7, 9, 12], ltd: 14 },
  ZO: { months: [3, 5, 7, 9, 12], ltd: 14 }, MWE: { months: [3, 5, 7, 9, 12], ltd: 14 }, // H K N U Z; LTD business day before the 15th
  ZS: { months: [1, 3, 5, 7, 8, 9, 11], ltd: 14 },                                   // F H K N Q U X
  ZL: { months: [1, 3, 5, 7, 8, 9, 10, 12], ltd: 14 }, ZM: { months: [1, 3, 5, 7, 8, 9, 10, 12], ltd: 14 }, // F H K N Q U V Z
  ZR: { months: [1, 3, 5, 7, 9, 11], ltd: 14 },                                      // F H K N U X
  LE: { months: [2, 4, 6, 8, 10, 12], ltd: 31 },                                     // G J M Q V Z; LTD last business day of the contract month
  HE: { months: [2, 4, 5, 6, 7, 8, 10, 12], ltd: 17 },                               // G J K M N Q V Z; LTD 10th business day (<= 17th with a holiday)
  GF: { months: [1, 3, 4, 5, 8, 9, 10, 11], ltd: 31 },                               // F H J K Q U V X; LTD last Thursday (Nov: before Thanksgiving)
};
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
// the roll slot of session date d: { key, end } (end = the slot's bound), or null when d is outside every slot (every-month roots: a day
// outside [dom]); root == null -> the whole calendar month, the generic case
function rollSlot(root, d) {
  const sp = root == null ? GENERIC_SLOT : ROLL_SPEC[root];
  if (!sp) throw new Error(`R322: no roll spec for ${root} — refusing to guess its roll slots`);
  const y = +d.slice(0, 4), m = +d.slice(5, 7), dd = +d.slice(8, 10);
  if (sp.every) return dd < sp.dom[0] || dd > sp.dom[1] ? null : { key: d.slice(0, 7), end: ymd(y, m, Math.min(sp.dom[1], daysInMonth(y, m))) };
  for (const yy of [y, y + 1]) for (const M of sp.months) { const a = ymd(yy, M, Math.min(sp.ltd, daysInMonth(yy, M))); if (d <= a) return { key: a.slice(0, 7), end: a }; }
  throw new Error(`R322: no roll slot for ${root} ${d}`);
}
const SCALE_WIN = 250, SCALE_MIN = 20;
const gapTypes = (d) => d.map((x, t) => (t && calDays(d[t - 1], x) === 1 ? 0 : 1));
function medianLow(a) { const s = Array.from(a).sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; }
function gapScores(d, o, c) {
  const n = d.length, typ = gapTypes(d), ag = new Float64Array(n), z = new Float64Array(n);
  for (let t = 1; t < n; t++) ag[t] = Math.abs(o[t] / c[t - 1] - 1);
  const firstMed = [0, 1].map((k) => { const a = []; for (let t = 1; t < n && a.length < SCALE_WIN; t++) if (typ[t] === k) a.push(ag[t]); return medianLow(a); });
  for (let t = 1; t < n; t++) {
    const a = []; for (let j = Math.max(1, t - SCALE_WIN); j < t; j++) if (typ[j] === typ[t]) a.push(ag[j]);
    const sc = a.length >= SCALE_MIN ? medianLow(a) : firstMed[typ[t]];
    z[t] = ag[t] / (sc > 0 ? sc : 1e-6);
  }
  return { typ, ag, z };
}
function detectRolls(d, o, c, root) {
  const n = d.length, roll = new Uint8Array(n), best = new Map(), { z } = gapScores(d, o, c), last = d[n - 1];
  for (let t = 1; t < n; t++) { const s = rollSlot(root, d[t]); if (!s || s.end > last) continue; const b = best.get(s.key); if (!b || z[t] > b.z) best.set(s.key, { z: z[t], t }); }
  for (const { t } of best.values()) roll[t] = 1;
  return roll;
}
// REPORTED data-quality check of the detector (price gaps only): share of detected rolls after a long break; median |gap| at rolls vs
// the rest; declared rolls per year; gaps of z >= 15 left undeclared (news or missed rolls); for the four monthly energy roots, share of
// detections inside the exchange roll window (CL 14-22, NG 21-29, HO/RB 23-31)
const ROLL_WINDOWS = { CL: [14, 22], NG: [21, 29], HO: [23, 31], RB: [23, 31] };
function rollDiagnostics(s) {
  const { typ, ag, z } = gapScores(s.d, s.oRaw, s.cRaw), rolls = [], rest = [];
  for (let t = 1; t < s.n; t++) (s.roll[t] ? rolls : rest).push(t);
  const w = ROLL_WINDOWS[s.root], inW = w ? rolls.filter((t) => { const dd = +s.d[t].slice(8, 10); return dd >= w[0] && dd <= w[1]; }).length : null, yrs = calDays(s.d[0], s.d[s.n - 1]) / 365.25;
  return { rolls: rolls.length, rollsPerYear: r2(rolls.length / yrs), slots: ROLL_SPEC[s.root], shareAfterLongBreak: r3(rolls.filter((t) => typ[t] === 1).length / rolls.length),
    medianAbsGapAtRollPct: pct(medianLow(rolls.map((t) => ag[t])), 3), medianAbsGapElsewherePct: pct(medianLow(rest.map((t) => ag[t])), 3), declaredWithZBelow5: rolls.filter((t) => z[t] < 5).length, undeclaredZAtLeast15: rest.filter((t) => z[t] >= 15).length,
    ...(w ? { exchangeWindow: w, shareInsideWindow: r3(inW / rolls.length) } : {}) };
}
// ratio back-adjust: prices before roll session t are multiplied by f_t = o_t / c_{t-1}; the session's own prices are the new contract
function ratioAdjust(o, c, roll) {
  const n = o.length, oa = new Float64Array(n), ca = new Float64Array(n), f = new Float64Array(n).fill(1); let mult = 1;
  for (let j = n - 1; j >= 0; j--) { oa[j] = o[j] * mult; ca[j] = c[j] * mult; if (roll[j] && j > 0) { f[j] = o[j] / c[j - 1]; mult *= f[j]; } }
  return { oa, ca, f };
}

// ── data: Schwab daily (continuous front + per-contract probes) and CFTC legacy COT, cached once, hashed ─────────────────────────
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const CTF = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
// Schwab stamps a futures daily candle at 00:00 America/Chicago of its trade date. Any other stamp could shift the date -> throw.
function schwabFuturesDate(ms) {
  const p = Object.fromEntries(CTF.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  if (+p.hour !== 0) throw new Error(`candle stamped ${new Date(ms).toISOString()} (${p.hour}:00 CT) — not a midnight-CT daily stamp; refusing to guess its date`);
  return `${p.year}-${p.month}-${p.day}`;
}
function packFutures(root, candles) {
  let prev = "", droppedAfterLastBar = 0, droppedBeforeStart = 0, nonPositive = 0, weekend = 0; const rows = [], flags = { highBelowLow: 0, closeOutsideRange: 0, openOutsideRange: 0, zeroVolume: 0 };
  for (const x of candles) {
    const d = schwabFuturesDate(x.datetime);
    if (d <= prev) throw new Error(`${root}: dates not strictly increasing at ${d}`);
    prev = d;
    if (d < FETCH_START) { droppedBeforeStart++; continue; }
    if (d > LAST_BAR) { droppedAfterLastBar++; continue; }                       // forming-bar guard
    if (isWeekend(d)) { weekend++; continue; }
    if (![x.open, x.high, x.low, x.close].every((v) => fin(v) && v > 0)) { nonPositive++; continue; }
    if (x.high < x.low) flags.highBelowLow++; if (x.close > x.high || x.close < x.low) flags.closeOutsideRange++; if (x.open > x.high || x.open < x.low) flags.openOutsideRange++; if (!(x.volume > 0)) flags.zeroVolume++;
    rows.push([d, x.open, x.high, x.low, x.close, fin(x.volume) ? x.volume : null]);
  }
  return { rows, droppedAfterLastBar, droppedBeforeStart, nonPositive, weekend, flags };
}
async function schwabDaily(sym, tok, startMs, endMs) {
  const u = `https://api.schwabapi.com/marketdata/v1/pricehistory?symbol=${encodeURIComponent(sym)}&periodType=year&period=20&frequencyType=daily&frequency=1&startDate=${startMs}&endDate=${endMs}&needExtendedHoursData=false`;
  for (let a = 0; a < 4; a++) {
    const r = await fetch(u, { headers: { Authorization: "Bearer " + tok, Accept: "application/json" }, signal: AbortSignal.timeout(60000) });
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 15000 * (a + 1))); continue; }
    if (!r.ok) throw new Error(`${sym} pricehistory HTTP ${r.status}`);
    const j = await r.json();
    return { symbol: j.symbol || null, candles: Array.isArray(j.candles) ? j.candles : [] };
  }
  throw new Error(`${sym} pricehistory rate-limited 4 times`);
}
async function cotRows(code) {
  const sel = "report_date_as_yyyy_mm_dd,market_and_exchange_names,open_interest_all,noncomm_positions_long_all,noncomm_positions_short_all,noncomm_postions_spread_all";
  const u = `https://publicreporting.cftc.gov/resource/6dca-aqww.json?$select=${sel}&$where=${encodeURIComponent(`cftc_contract_market_code='${code}'`)}&$order=report_date_as_yyyy_mm_dd%20ASC&$limit=20000`;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(u, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error(`CFTC HTTP ${r.status}`);
      return await r.json();
    } catch (e) { if (a === 2) throw e; await new Promise((res) => setTimeout(res, 5000 * (a + 1))); }
  }
}
// [d, oi, nsp, nl, ns]; one row per as-of date (duplicates counted, the first kept); a row without a finite spreading/OI is dropped and counted
function packCot(raw) {
  const rows = [], names = new Set(); let duplicates = 0, invalid = 0, prev = "";
  for (const x of raw) {
    const d = String(x.report_date_as_yyyy_mm_dd || "").slice(0, 10); names.add(x.market_and_exchange_names);
    const oi = +x.open_interest_all, nsp = +x.noncomm_postions_spread_all, nl = +x.noncomm_positions_long_all, ns = +x.noncomm_positions_short_all;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { invalid++; continue; }
    if (d === prev) { duplicates++; continue; }
    if (d < prev) throw new Error(`COT rows not ascending at ${d}`);
    if (!(fin(oi) && oi > 0 && fin(nsp) && nsp >= 0)) { invalid++; continue; }
    prev = d; rows.push([d, oi, nsp, fin(nl) ? nl : null, fin(ns) ? ns : null]);
  }
  return { rows, names: [...names].filter(Boolean), duplicates, invalid };
}
async function loadOrFetch(allowFetch) {
  if (fs.existsSync(CACHE)) {
    const buf = fs.readFileSync(CACHE), j = JSON.parse(buf.toString("utf8"));
    if (j.spec !== "r322-cache-v1" || j.start !== FETCH_START || j.lastCompleteBar !== LAST_BAR || JSON.stringify(j.candidates) !== JSON.stringify(ROOTS_ALL)) throw new Error("cache metadata does not match the R322 spec — refusing to use it");
    return { cache: j, sha: sha256(buf), fetched: false };
  }
  if (!allowFetch) throw new Error(`cache missing (${CACHE_REL}) — the controls run creates it; the read never refetches`);
  const schwab = require("./lib/schwab.js"), tok = await schwab.token();          // loaded only here: the selftest never touches the network or .env
  const bars = {}, meta = {}, probes = {}, cot = {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const root of ROOTS_ALL) {
    try {
      const h = await schwabDaily("/" + root, tok, START_MS, END_MS), pk = packFutures(root, h.candles);
      bars[root] = pk.rows;
      meta[root] = { returnedSymbol: h.symbol, candles: h.candles.length, bars: pk.rows.length, firstBar: pk.rows.length ? pk.rows[0][0] : null, lastBar: pk.rows.length ? pk.rows[pk.rows.length - 1][0] : null,
        droppedAfterLastBar: pk.droppedAfterLastBar, droppedBeforeStart: pk.droppedBeforeStart, nonPositiveDropped: pk.nonPositive, weekendDropped: pk.weekend, flags: pk.flags };
    } catch (e) { bars[root] = []; meta[root] = { error: e.message }; }
    await sleep(700);
    // per-contract probes: an expired contract (no candles = no expired-contract history) and a deferred one (identical to the front = the
    // contract month is ignored, i.e. no back-month history)
    const M = CANDIDATES[root][4], pr = {};
    for (const [k, sym, s0] of [["expired", `/${root}${M}24`, Date.parse("2023-01-01T00:00:00Z")], ["deferred", `/${root}${M}27`, Date.parse("2026-07-01T00:00:00Z")]]) {
      try {
        const h = await schwabDaily(sym, tok, s0, END_MS), rows = h.candles.map((x) => [schwabFuturesDate(x.datetime), x.close]).filter((x) => x[0] <= LAST_BAR);
        const front = new Map((bars[root] || []).map((x) => [x[0], x[4]])), matched = rows.filter((x) => front.has(x[0])), same = matched.filter((x) => x[1] === front.get(x[0])).length;
        pr[k] = { symbol: sym, returnedSymbol: h.symbol, candles: rows.length, firstBar: rows.length ? rows[0][0] : null, lastBar: rows.length ? rows[rows.length - 1][0] : null,
          comparedWithFront: matched.length, identicalCloses: same, identicalToFront: matched.length >= 10 && same === matched.length };
      } catch (e) { pr[k] = { symbol: sym, error: e.message }; }
      await sleep(700);
    }
    probes[root] = pr;
    console.log(`  ${root.padEnd(4)} front ${meta[root].error ? `ERROR ${meta[root].error}` : `${meta[root].bars} bars ${meta[root].firstBar} .. ${meta[root].lastBar}`} · expired ${pr.expired.symbol} ${pr.expired.error || pr.expired.candles + " candles"} · deferred ${pr.deferred.symbol} ${pr.deferred.error || `${pr.deferred.candles} candles, identical to front ${pr.deferred.identicalToFront}`}`);
  }
  for (const root of ROOTS_ALL) {
    const code = CANDIDATES[root][1];
    if (!bars[root].length) { cot[root] = { code, skipped: "no Schwab price history — COT not needed" }; continue; }
    try { const pk = packCot(await cotRows(code)); cot[root] = { code, ...pk, first: pk.rows.length ? pk.rows[0][0] : null, last: pk.rows.length ? pk.rows[pk.rows.length - 1][0] : null }; console.log(`  COT ${root.padEnd(4)} ${code} ${pk.rows.length} rows ${cot[root].first} .. ${cot[root].last} ${JSON.stringify(pk.names)}`); }
    catch (e) { cot[root] = { code, error: e.message, rows: [] }; console.log(`  COT ${root} ${code} ERROR ${e.message}`); }
    await sleep(300);
  }
  const obj = { spec: "r322-cache-v1", id: ID, fetchedAt: new Date().toISOString(), start: FETCH_START, lastCompleteBar: LAST_BAR, candidates: ROOTS_ALL,
    schwab: { source: "Schwab marketdata/v1/pricehistory (lib/schwab.js token; read-only GET), daily, continuous front /ROOT, unadjusted", request: { periodType: "year", period: 20, frequencyType: "daily", frequency: 1, startDate: START_MS, endDate: END_MS, needExtendedHoursData: false },
      rowsFormat: "[date (America/Chicago trade date), o, h, l, c, v]", meta, bars },
    probes: { note: "per-contract history probes: expired <M>24 (from 2023-01-01) and deferred <M>27 (from 2026-07-01); closes compared with the front series on common dates", byRoot: probes },
    cot: { source: "CFTC public reporting Socrata 6dca-aqww (legacy futures-only), by cftc_contract_market_code", rowsFormat: "[report date, open_interest_all, noncomm_postions_spread_all, noncomm long, noncomm short]", byRoot: cot } };
  fs.mkdirSync(CACHE_DIR, { recursive: true }); writeJsonAtomic(CACHE, obj, { pretty: 0 });
  const buf = fs.readFileSync(CACHE);
  return { cache: JSON.parse(buf.toString("utf8")), sha: sha256(buf), fetched: true };
}

// ── depth table (registered and token universes) ─────────────────────────────────────────────────────────────────────────
// Reference calendar: weekdays on which more than half of the candidate roots alive on that date (first <= d <= last) have a bar.
function referenceCalendar(barsByRoot) {
  const roots = Object.keys(barsByRoot).filter((r) => barsByRoot[r].length), count = new Map(), spans = roots.map((r) => [barsByRoot[r][0][0], barsByRoot[r][barsByRoot[r].length - 1][0]]);
  for (const r of roots) for (const x of barsByRoot[r]) if (!isWeekend(x[0])) count.set(x[0], (count.get(x[0]) || 0) + 1);
  const dates = [...count.keys()].sort(), out = [];
  let lo = 0;  // alive count by date (spans sorted is not needed: count each date directly)
  for (const d of dates) { let alive = 0; for (const [f, l] of spans) if (f <= d && l >= d) alive++; if (2 * count.get(d) > alive) out.push(d); }
  void lo; return out;
}
// the continuous run ending at the last bar: walk back while consecutive bars are <= MAX_GAP_DAYS calendar days apart
function continuousRun(rows) {
  if (!rows.length) return null;
  let s = rows.length - 1; while (s > 0 && calDays(rows[s - 1][0], rows[s][0]) <= MAX_GAP_DAYS) s--;
  return { startIdx: s, first: rows[s][0], last: rows[rows.length - 1][0], bars: rows.length - s };
}
function depthTable(cache) {
  const bars = cache.schwab.bars, ref = referenceCalendar(bars), rows = [];
  for (const root of ROOTS_ALL) {
    const b = bars[root] || [], run = continuousRun(b), pr = (cache.probes.byRoot || {})[root] || {}, ct = (cache.cot.byRoot || {})[root] || {};
    let coverage = null, refSessions = 0, onRef = 0;
    if (run) { const a = lowerBound(ref, run.first), z = firstAfter(ref, run.last); refSessions = z - a; const have = new Set(b.slice(run.startIdx).map((x) => x[0])); for (let i = a; i < z; i++) if (have.has(ref[i])) onRef++; coverage = refSessions ? onRef / refSessions : null; }
    const years = run ? calDays(run.first, run.last) / 365.25 : 0, cotRowsN = (ct.rows || []).length;
    const frontOk = !!run && years >= MIN_YEARS && coverage != null && coverage >= MIN_COVERAGE && run.last >= CURRENT_FROM;
    // COT spreading must overlap the front run for >= 8 years. It need NOT reach the end of the window: a root whose report stops leaves the
    // cross-section at that date (weeks without its COT row already drop it) instead of vanishing from history (2026-10-03 audit: ZO's COT
    // ends 2026-09-01 and the old "reaches 2026-09-15" condition removed it from all 18 years — survivorship by end-of-sample data).
    const cotOk = !!run && cotRowsN > 0 && calDays(ct.first > run.first ? ct.first : run.first, ct.last < run.last ? ct.last : run.last) / 365.25 >= MIN_YEARS;
    const expiredServed = !!(pr.expired && pr.expired.candles > 0), deferredIdentical = !!(pr.deferred && pr.deferred.identicalToFront), deferredDistinct = !!(pr.deferred && pr.deferred.candles > 0 && !pr.deferred.identicalToFront);
    // registered: >= 8 years of continuous daily FRONT/BACK data -> needs expired-contract history (to roll through 8 years of contracts)
    // AND distinct back-month history; Schwab serves neither -> 0 years of front/back data for every root
    const frontBackYears = expiredServed && deferredDistinct ? years : 0;
    rows.push({ root, sector: CANDIDATES[root][0], cotCode: CANDIDATES[root][1],
      schwabFront: run ? { served: true, returnedSymbol: (cache.schwab.meta[root] || {}).returnedSymbol, firstBar: b[0][0], runFirst: run.first, runLast: run.last, runBars: run.bars, years: r2(years), coverage: r4(coverage), refSessions } : { served: false, error: (cache.schwab.meta[root] || {}).error || "no candles" },
      perContract: { expired: pr.expired ? { symbol: pr.expired.symbol, candles: pr.expired.candles != null ? pr.expired.candles : null, error: pr.expired.error } : null,
        deferred: pr.deferred ? { symbol: pr.deferred.symbol, candles: pr.deferred.candles != null ? pr.deferred.candles : null, identicalToFront: pr.deferred.identicalToFront, comparedWithFront: pr.deferred.comparedWithFront, error: pr.deferred.error } : null,
        expiredServed, deferredIdenticalToFront: deferredIdentical, backMonthHistory: deferredDistinct },
      cot: ct.skipped ? { skipped: ct.skipped } : { rows: cotRowsN, first: ct.first || null, last: ct.last || null, names: ct.names, duplicates: ct.duplicates, invalid: ct.invalid, error: ct.error },
      frontBackYears: r2(frontBackYears), qualifiesRegistered: frontBackYears >= MIN_YEARS && cotOk, qualifiesToken: frontOk && cotOk, runStartIdx: run ? run.startIdx : null });
  }
  const reg = rows.filter((r) => r.qualifiesRegistered).map((r) => r.root), tok = rows.filter((r) => r.qualifiesToken).map((r) => r.root);
  return { referenceSessions: ref.length, ref, rows, registeredQualifying: reg, tokenQualifying: tok,
    rule: `registered: >= ${MIN_YEARS} years of continuous daily FRONT/BACK history (expired + back-month contracts) + COT; token: a continuous front run (no gap > ${MAX_GAP_DAYS} days) of >= ${MIN_YEARS} years ending >= ${CURRENT_FROM} with >= ${100 * MIN_COVERAGE}% of reference sessions + >= ${MIN_YEARS} years of COT spreading overlapping it` };
}
const depthOut = (dp) => ({ referenceSessions: dp.referenceSessions, rule: dp.rule, registeredQualifying: dp.registeredQualifying, registeredQualifyingCount: dp.registeredQualifying.length, tokenQualifying: dp.tokenQualifying, tokenQualifyingCount: dp.tokenQualifying.length,
  table: dp.rows.map(({ runStartIdx, ...x }) => x) });

// ── the panel (token construction): skeleton is path-free; returns and vols come from a price path ────────────────────────
function buildSeries(rows, root) {
  const n = rows.length, d = rows.map((x) => x[0]), o = rows.map((x) => x[1]), c = rows.map((x) => x[4]), roll = detectRolls(d, o, c, root), { oa, ca, f } = ratioAdjust(o, c, roll);
  const [, , tick, mult] = CANDIDATES[root];
  return { root, n, d, oRaw: o, cRaw: c, roll, f, oa: Array.from(oa), ca: Array.from(ca), tick, mult, side: (px) => (tick + FEE_SIDE) / (px * mult) };
}
// skeleton: weeks [{ T, E, X, release, delayed, names: [{ ri, sp, i0, i1, cpsOut, rollCost }], cpsIn: Float64Array(R) }]
function buildSkeleton(series, cotByRoot, ref) {
  const R = series.length, refSet = new Set(ref), cotMaps = cotByRoot.map((rows) => new Map(rows.map((x) => [x[0], x])));
  const Tset = new Set(); for (const rows of cotByRoot) for (const x of rows) Tset.add(x[0]);
  const Ts = [...Tset].sort(), sched = Ts.map((T) => { const rl = releaseOf(T, refSet), ei = firstAfter(ref, rl.release); return { T, ...rl, E: ei < ref.length ? ref[ei] : null, shutdown: inShutdown(T) }; });
  const idxOn = (s, date) => { const i = lowerBound(s.d, date); return i < s.n && calDays(date, s.d[i]) <= SLACK_DAYS ? i : -1; };
  const all = [], drops = { shutdown: 0, noExit: 0, afterWindow: 0 };
  for (let k = 0; k < sched.length; k++) {
    const w = sched[k], nx = sched[k + 1];
    if (!w.E || !nx || !nx.E || nx.E <= w.E) { drops.noExit++; continue; }
    if (nx.E > WINDOW_LAST_EXIT) { drops.afterWindow++; continue; }
    if (w.shutdown) { drops.shutdown++; continue; }
    const names = [], cpsIn = new Float64Array(R).fill(NaN);
    for (let ri = 0; ri < R; ri++) {
      const s = series[ri], i0 = idxOn(s, w.E); if (i0 >= 0) cpsIn[ri] = s.side(s.oRaw[i0]);
      const row = cotMaps[ri].get(w.T); if (!row || i0 < 0) continue;
      const i1 = idxOn(s, nx.E); if (i1 < 0 || i1 <= i0 || i0 < VOLN + 1) continue;
      let rollCost = 0; for (let t = i0 + 1; t <= i1; t++) if (s.roll[t]) rollCost += 2 * s.side(s.cRaw[t - 1]);
      names.push({ ri, sp: row[2] / row[1], i0, i1, cpsOut: s.side(s.oRaw[i1]), rollCost });
    }
    all.push({ k, T: w.T, E: w.E, X: nx.E, release: w.release, delayed: w.delayed, names, cpsIn });
  }
  const first = all.findIndex((w) => w.names.length >= MIN_ROOTS);
  const weeks = first < 0 ? [] : all.slice(first).filter((w) => w.names.length >= MIN_TRADED);
  return { weeks, evidenceStart: first < 0 ? null : all[first].E, scheduled: sched.length, drops, belowMinTradedAfterStart: first < 0 ? 0 : all.slice(first).filter((w) => w.names.length < MIN_TRADED).length,
    below15AfterStart: first < 0 ? 0 : all.slice(first).filter((w) => w.names.length < MIN_ROOTS).length, delayedWeeks: weeks.filter((w) => w.delayed).length };
}
// path stats: weekly return o[i1]/o[i0]-1 and the 60-return sd to the close before entry, from a path { o[], c[] } per root
function pathStats(skel, paths) {
  const pre = paths.map((p) => { const n = p.c.length, S1 = new Float64Array(n + 1), S2 = new Float64Array(n + 1); for (let j = 1; j < n; j++) { const x = p.c[j] / p.c[j - 1] - 1; S1[j + 1] = S1[j] + x; S2[j + 1] = S2[j] + x * x; } return { S1, S2 }; });
  return skel.weeks.map((w) => {
    const r = new Float64Array(w.names.length), vol = new Float64Array(w.names.length);
    w.names.forEach((nm, j) => { const p = paths[nm.ri], P = pre[nm.ri], a = nm.i0 - VOLN, b = nm.i0;            // returns j in [i0-60, i0-1]
      const s1 = P.S1[b] - P.S1[a], s2 = P.S2[b] - P.S2[a], v = (s2 - s1 * s1 / VOLN) / (VOLN - 1);
      r[j] = p.o[nm.i1] / p.o[nm.i0] - 1; vol[j] = v > 0 ? Math.sqrt(v) : NaN; });
    return { r, vol };
  });
}
// terciles: names sorted by (score asc, root index asc); long = first floor(m/3), short = last floor(m/3); names with a non-finite score
// or vol are left out of that week's ranking
function terciles(w, score, vol) {
  const idx = []; for (let j = 0; j < w.names.length; j++) if (fin(score[j]) && fin(vol[j]) && vol[j] > 0) idx.push(j);
  idx.sort((a, b) => score[a] - score[b] || w.names[a].ri - w.names[b].ri);
  const q = Math.floor(idx.length / 3);
  return { L: idx.slice(0, q), S: q ? idx.slice(idx.length - q) : [] };
}
// the book: per week weights (long leg +1/vol normalised to $1, short leg -1/vol normalised to $1); gross = Σ w r; cost = Σ |Δw| x cost per
// side at the entry open (a root no longer priced -> FALLBACK_COST) + Σ |w| x roll cost; liquidation at the exit open when the next week
// is not traded contiguously (or after the last week). Returns weekly gross / net / legs / turnover (+ optional per-root contributions).
function runBook(skel, ps, sel, R, { contrib = false } = {}) {
  const W = skel.weeks, gross = new Float64Array(W.length), net = new Float64Array(W.length), longLeg = new Float64Array(W.length), shortLeg = new Float64Array(W.length), turnover = new Float64Array(W.length);
  let prev = new Float64Array(R), cur = new Float64Array(R); const by = contrib ? W.map(() => new Float64Array(R)) : null;
  for (let k = 0; k < W.length; k++) {
    const w = W[k], { r, vol } = ps[k], { L, S } = sel[k]; cur.fill(0);
    if (L.length && S.length) {
      let sl = 0, ss = 0; for (const j of L) sl += 1 / vol[j]; for (const j of S) ss += 1 / vol[j];
      for (const j of L) cur[w.names[j].ri] = (1 / vol[j]) / sl; for (const j of S) cur[w.names[j].ri] = -(1 / vol[j]) / ss;
    }
    let g = 0, gl = 0, gs = 0, cost = 0, to = 0;
    for (const j of L) { const v = cur[w.names[j].ri] * r[j]; g += v; gl += v; if (by) by[k][w.names[j].ri] = v; }
    for (const j of S) { const v = cur[w.names[j].ri] * r[j]; g += v; gs += v; if (by) by[k][w.names[j].ri] = v; }
    for (let ri = 0; ri < R; ri++) { const dw = Math.abs(cur[ri] - prev[ri]); if (dw) { to += dw; cost += dw * (fin(w.cpsIn[ri]) ? w.cpsIn[ri] : FALLBACK_COST); } }
    for (const j of L) cost += Math.abs(cur[w.names[j].ri]) * w.names[j].rollCost; for (const j of S) cost += Math.abs(cur[w.names[j].ri]) * w.names[j].rollCost;
    const contiguous = k + 1 < W.length && W[k + 1].E === w.X;
    if (!contiguous) { for (const j of L) cost += Math.abs(cur[w.names[j].ri]) * w.names[j].cpsOut; for (const j of S) cost += Math.abs(cur[w.names[j].ri]) * w.names[j].cpsOut; prev.fill(0); }
    else { const t = prev; prev = cur; cur = t; }
    gross[k] = g; net[k] = g - cost; longLeg[k] = gl; shortLeg[k] = gs; turnover[k] = to;
  }
  return { gross: Array.from(gross), net: Array.from(net), longLeg: Array.from(longLeg), shortLeg: Array.from(shortLeg), turnover: Array.from(turnover), by };
}
const spScores = (skel) => skel.weeks.map((w) => Float64Array.from(w.names, (nm) => nm.sp));
const selectionOf = (skel, ps, scores) => skel.weeks.map((w, k) => terciles(w, scores[k], ps[k].vol));
// REGISTERED PLACEBO: SP ranks shuffled across roots each week -> uniformly random disjoint q-subsets for the long and short legs
// (same eligible names, own vols, same costs); statistic = mean weekly net; p95 = sorted[floor(0.95 x draws)].
function placeboDist(skel, ps, R, { draws = PLACEBO_DRAWS, seed = PLACEBO_SEED } = {}) {
  const rng = mulberry(seed), means = new Float64Array(draws), gmeans = new Float64Array(draws), base = skel.weeks.map((w, k) => { const idx = []; for (let j = 0; j < w.names.length; j++) if (fin(ps[k].vol[j]) && ps[k].vol[j] > 0) idx.push(j); return idx; });
  for (let dI = 0; dI < draws; dI++) {
    const sel = base.map((idx) => { const a = idx.slice(), q = Math.floor(a.length / 3); for (let i = 0; i < 2 * q; i++) { const j = i + Math.floor(rng() * (a.length - i)); const t = a[i]; a[i] = a[j]; a[j] = t; } return { L: a.slice(0, q), S: a.slice(q, 2 * q) }; });
    const bk = runBook(skel, ps, sel, R); means[dI] = mean(bk.net); gmeans[dI] = mean(bk.gross);
  }
  const sorted = Array.from(means).sort((a, b) => a - b), gs = Array.from(gmeans).sort((a, b) => a - b);
  // grossP95 / grossP50: the same random books before costs — REPORTED only (the registered gate is on the net mean)
  return { draws, seed, p95: sorted[Math.floor(0.95 * draws)], p50: sorted[Math.floor(0.5 * draws)], p05: sorted[Math.floor(0.05 * draws)], meanOfDraws: mean(sorted), grossP95: gs[Math.floor(0.95 * draws)], grossP50: gs[Math.floor(0.5 * draws)] };
}
// REPORTED (2026-10-03 audit): the registered placebo reshuffles every week, so its books turn over ~2.8x a week against ~0.5 for a
// persistent signal and its net p95 sits near -cost: the placebo gate reduces to "mean > 0". This placebo holds ONE random score per root
// for the whole sample (terciles recomputed each week among that week's names; same weights, costs, eligibility) — does SP beat random
// PERSISTENT ranks, net and gross? p95 = sorted[floor(0.95 x draws)]. Never a gate.
function persistentPlaceboDist(skel, ps, R, { draws = PLACEBO_DRAWS, seed = PLACEBO_SEED + 1 } = {}) {
  const rng = mulberry(seed), net = new Float64Array(draws), gross = new Float64Array(draws), turn = new Float64Array(draws);
  for (let dI = 0; dI < draws; dI++) {
    const sc = new Float64Array(R); for (let i = 0; i < R; i++) sc[i] = rng();
    const scores = skel.weeks.map((w) => Float64Array.from(w.names, (nm) => sc[nm.ri])), bk = runBook(skel, ps, selectionOf(skel, ps, scores), R);
    net[dI] = mean(bk.net); gross[dI] = mean(bk.gross); turn[dI] = mean(bk.turnover);
  }
  const s = (a) => Array.from(a).sort((x, y) => x - y), sn = s(net), sg = s(gross);
  return { draws, seed, p95: sn[Math.floor(0.95 * draws)], p50: sn[Math.floor(0.5 * draws)], grossP95: sg[Math.floor(0.95 * draws)], grossP50: sg[Math.floor(0.5 * draws)], meanTurnover: mean(Array.from(turn)) };
}

// ── scrambles (no-edge data) ─────────────────────────────────────────────────────────────────────────────────────────────
// R150/R313 scramble on the ADJUSTED daily path of one root: shuffle (open/prev close, close/open) pairs; demean = drift-free in the
// ARITHMETIC sense, E[daily factor] = 1 (2026-10-03 audit: removing the log drift left +sigma^2/2 a day, which pushes a book short the
// high-vol roots negative — the old family's median t was -1.26 vs about -0.5 here). The first bar is kept; drift-kept ends at the real
// last close. Costs and roll costs stay on the real unadjusted prices (path-free skeleton).
function scramblePath(s, seed, demean) {
  const rng = mulberry(seed * 1000003 + hash(s.root)), n = s.n, p = [];
  for (let i = 1; i < n; i++) p.push([s.oa[i] / s.ca[i - 1], s.ca[i] / s.oa[i]]);
  if (demean && p.length) { const mx = p.reduce((a, x) => a + x[0] * x[1], 0) / p.length; for (const x of p) x[0] /= mx; }
  for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
  const o = new Array(n), c = new Array(n); o[0] = s.oa[0]; c[0] = s.ca[0];
  for (let i = 1; i < n; i++) { o[i] = c[i - 1] * p[i - 1][0]; c[i] = o[i] * p[i - 1][1]; }
  return { o, c };
}
// a random derangement of 0..R-1 (no fixed points), by rejection (R >= 2)
function derangement(R, rng) { if (R < 2) throw new Error("derangement needs >= 2 items"); for (;;) { const a = Array.from({ length: R }, (_, i) => i); for (let i = R - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } if (a.every((x, i) => x !== i)) return a; } }
// persistent no-edge signal: each root carries the SP series of ANOTHER root. The derangement is drawn per week COMPOSITION (memoised, so
// it persists while the set of names is unchanged) — never a global derangement cut down to the week, which can map a root back to itself
// (2026-10-03 audit: 6,256 name-weeks carried their own SP under the old cycle restriction)
function derangedScores(skel, seed) {
  const memo = new Map();
  return skel.weeks.map((w) => {
    const ids = w.names.map((nm) => nm.ri), key = ids.join(",");
    if (!memo.has(key)) { const p = derangement(ids.length, mulberry(seed * 100003 + hash(key))); memo.set(key, new Map(ids.map((ri, i) => [ri, ids[p[i]]]))); }
    const sig = memo.get(key), spBy = new Map(w.names.map((nm) => [nm.ri, nm.sp]));
    return Float64Array.from(w.names, (nm) => spBy.get(sig.get(nm.ri)));
  });
}
// ROLL-LEAK world of one root: its arithmetic-zero-drift scramble with the real roll factors f multiplied back in at their sessions (a
// synthetic UNADJUSTED path whose roll jumps are real and SP-aligned), then the same roll detector and ratio adjustment as the real series.
// Missed rolls leave their factor in the returns; false rolls erase a scrambled gap. The rule then runs on this path with the real SP.
// forcedMiss (REPORTED sensitivity only, the auditor's design): a random share of the re-detected real rolls is un-declared, so their factor
// stays in the returns — the size of the leak if the real detector itself missed that share (no calibration family can see its own misses).
function rollLeakPath(s, seed, forcedMiss = 0) {
  const sc = scramblePath(s, seed, true), n = s.n, o = new Array(n), c = new Array(n); o[0] = sc.o[0]; c[0] = sc.c[0];
  for (let t = 1; t < n; t++) { o[t] = c[t - 1] * (sc.o[t] / sc.c[t - 1]) * s.f[t]; c[t] = o[t] * (sc.c[t] / sc.o[t]); }
  const roll = detectRolls(s.d, o, c, s.root);
  if (forcedMiss > 0) { const rng = mulberry(seed * 7919 + hash(s.root) + 17); for (let t = 1; t < n; t++) if (s.roll[t] && roll[t] && rng() < forcedMiss) roll[t] = 0; }
  const { oa, ca } = ratioAdjust(o, c, roll);
  let hit = 0, real = 0; for (let t = 1; t < n; t++) if (s.roll[t]) { real++; if (roll[t]) hit++; }
  return { o: Array.from(oa), c: Array.from(ca), roll, redetected: hit, realRolls: real };
}

// ── decision rule (registry R322 decisionRule), one pure function for calibration and the read ───────────────────────────
function decide({ rootsQualifying, meanNet, tNW, placeboP95, halfFirst, halfSecond, bar, cannotWhy = null, floor = null }) {
  const gates = { rootsAtLeast15: rootsQualifying >= MIN_ROOTS, meanNetPositive: meanNet != null && meanNet > 0, tNWAtLeastBar: tNW != null && tNW >= bar,
    placeboP95Beaten: meanNet != null && placeboP95 != null && meanNet > placeboP95, bothHalvesPositive: halfFirst != null && halfSecond != null && halfFirst > 0 && halfSecond > 0 };
  if (floor) { gates.floorMeanAboveP95 = !!floor.meanAboveP95; gates.floorTVsP50AtLeastBar = !!floor.tVsP50AtLeastBar; }
  if (!gates.rootsAtLeast15) return { gates, failed: ["rootsAtLeast15"], verdictScript: `CANNOT MEASURE — ${cannotWhy || `${rootsQualifying} roots qualify (< ${MIN_ROOTS})`}` };
  const failed = Object.keys(gates).filter((k) => !gates[k]);
  return { gates, failed, verdictScript: failed.length ? "DID NOT PASS" : "PASS" };
}
// drift-kept floor (optional token): mean > floor p95 AND NW t of (weekly net - floor p50) >= bar
function floorGate(net, meanNet, fl, bar) {
  const t = fl && fin(fl.p50) && net && net.length ? nwT(net.map((x) => x - fl.p50)) : null;
  return { p50: fl ? fl.p50 : null, p95: fl ? fl.p95 : null, meanAboveP95: meanNet != null && fl != null && fin(fl.p95) && meanNet > fl.p95, tVsP50: t, tVsP50AtLeastBar: t != null && t >= bar };
}
const floorOf = (vals) => { const s = vals.filter(fin).sort((a, b) => a - b); return { seeds: s.length, p50: nearestRank(s, 0.5), p95: nearestRank(s, 0.95), p50PctPerWeek: pct(nearestRank(s, 0.5)), p95PctPerWeek: pct(nearestRank(s, 0.95)) }; };
// Pre-read amendments. None -> the registered construction (front/back fixed roll) and gates. A runnerGates amendment must be preEvidence
// and use only tokens this runner defines; an empty list is refused (it says nothing the registered entry does not).
function preReadDecision(entry) {
  const am = (entry && Array.isArray(entry.amendments) ? entry.amendments : []).filter((a) => a && Array.isArray(a.runnerGates));
  if (!am.length) return { decided: true, registered: true, construction: "registered", tokens: [], meaning: ["registered construction (continuous front/back contracts, fixed roll 5 business days before FND/LTD, ratio back-adjusted) and gates as written"] };
  if (am.some((a) => a.preEvidence !== true)) return { decided: false, why: "a runnerGates amendment is not marked preEvidence: true" };
  const tokens = [...new Set(am.flatMap((a) => a.runnerGates))].sort(), unknown = tokens.filter((g) => !Object.prototype.hasOwnProperty.call(RUNNER_GATES, g));
  if (!tokens.length) return { decided: false, why: "a runnerGates amendment lists no token" };
  if (unknown.length) return { decided: false, why: `unknown runnerGates ${JSON.stringify(unknown)} — this runner defines only ${JSON.stringify(Object.keys(RUNNER_GATES))}` };
  if (!tokens.includes(TOKEN_CONSTRUCTION)) return { decided: false, why: `${TOKEN_FLOOR} is defined only together with ${TOKEN_CONSTRUCTION}` };
  return { decided: true, registered: false, construction: "schwab-front-gap-ratio", floor: tokens.includes(TOKEN_FLOOR), tokens, dates: am.map((a) => a.date || null), meaning: tokens.map((g) => `${g}: ${RUNNER_GATES[g]}`) };
}
function registryEntry() { const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")); return [...(reg.preregistered || []), ...(reg.tests || [])].find((x) => x.id === ID) || null; }

// ── token-construction world (built once per run) ────────────────────────────────────────────────────────────────────────
function tokenWorld(cache, dp) {
  const roots = dp.tokenQualifying, byRoot = new Map(dp.rows.map((x) => [x.root, x]));
  const series = roots.map((root) => buildSeries(cache.schwab.bars[root].slice(byRoot.get(root).runStartIdx), root));
  const cotByRoot = roots.map((root) => cache.cot.byRoot[root].rows);
  const skel = buildSkeleton(series, cotByRoot, dp.ref);
  const realPaths = series.map((s) => ({ o: s.oa, c: s.ca }));
  return { roots, series, skel, R: roots.length, realPaths };
}
// one replicate of the WHOLE rule on a given path + scores (placebo computed on the same path unless supplied)
function replicate(world, paths, scores, { placebo = null, keep = false } = {}) {
  const ps = pathStats(world.skel, paths), sel = selectionOf(world.skel, ps, scores), bk = runBook(world.skel, ps, sel, world.R), sm = summarise(bk.net);
  const pl = placebo || placeboDist(world.skel, ps, world.R);
  return { ...sm, placeboP95: pl.p95, placeboP50: pl.p50, meanTurnover: mean(bk.turnover), ...(keep ? { _net: bk.net } : {}) };
}
// the placebo family as no-edge books: random disjoint terciles each week (own seed), judged against the registered placebo p95
function placeboFamilyReps(world, ps, placebo, count, seed) {
  const rng = mulberry(seed), base = world.skel.weeks.map((w, k) => { const idx = []; for (let j = 0; j < w.names.length; j++) if (fin(ps[k].vol[j]) && ps[k].vol[j] > 0) idx.push(j); return idx; }), out = [];
  for (let i = 0; i < count; i++) {
    const sel = base.map((idx) => { const a = idx.slice(), q = Math.floor(a.length / 3); for (let x = 0; x < 2 * q; x++) { const j = x + Math.floor(rng() * (a.length - x)); const t = a[x]; a[x] = a[j]; a[j] = t; } return { L: a.slice(0, q), S: a.slice(q, 2 * q) }; });
    const bk = runBook(world.skel, ps, sel, world.R); out.push({ seed: i + 1, ...summarise(bk.net), placeboP95: placebo.p95, meanTurnover: mean(bk.turnover), _net: bk.net });
  }
  return out;
}
function judge(rep, bar, rootsQualifying, fl = null) {
  const floor = fl ? floorGate(rep._net, rep.meanNet, fl, bar) : null;
  return decide({ rootsQualifying, meanNet: rep.meanNet, tNW: rep.tNW, placeboP95: rep.placeboP95, halfFirst: rep.halfFirst, halfSecond: rep.halfSecond, bar, floor });
}
// WHOLE-RULE calibration. Families (every rate is a false-pass rate on data with no SP edge):
//   derangedSignal  the real adjusted path, each root carrying ANOTHER root's SP series (deranged within each week's composition): a
//                   persistent no-edge signal with the real signal's persistence and turnover, real drifts, real correlations.
//   placeboFamily   the registered placebo family itself: random disjoint terciles every week on the real path (own seeds), judged
//                   against the registered placebo p95.
//   driftFree       each root's adjusted daily path scrambled (open-gap, open->close pairs shuffled) with E[daily factor] = 1, the real SP.
//   rollLeak        the driftFree scramble of the same seed with the real roll factors multiplied back in and the rolls re-detected
//                   (construction sensitivity: the detector's misses carry real, SP-aligned term-structure jumps into the returns).
//   driftKept       the same scramble with each root's drift KEPT, the real SP. REPORTED, not a no-edge family for this hypothesis: it
//                   destroys SP timing but keeps the real SP's static alignment with each root's realised drift — the cross-sectional
//                   content of the published premium. It is the no-edge family only for the optional floor gate set (timing hypothesis).
// Gate sets: "registered" (decisionRule.pass) and "floor" (registered + the drift-kept floor; drift-kept replicates judged against the
// leave-one-out floor of the other seeds). calibrated(registered) = derangedSignal, placeboFamily, driftFree, rollLeak <= 5%;
// calibrated(floor) = all five <= 5%.
const CAL_FAMILIES = ["derangedSignal", "placeboFamily", "driftFree", "rollLeak"], CAL_COUNTS = { driftKept: KEPT_SEEDS, driftFree: FREE_SEEDS, rollLeak: ROLL_LEAK_SEEDS, derangedSignal: DERANGE_SEEDS, placeboFamily: PLACEBO_FAMILY_REPS };
function calibrate(fams, bar, rootsQualifying) {
  const share = (rows, f) => (rows.length ? rows.filter(f).length / rows.length : null), srt = (a) => a.filter(fin).sort((x, y) => x - y);
  const dist = (a, k = (x) => x) => { const s = srt(a); return s.length ? { n: s.length, min: k(s[0]), p05: k(nearestRank(s, 0.05)), p50: k(nearestRank(s, 0.5)), p95: k(nearestRank(s, 0.95)), max: k(s[s.length - 1]) } : null; };
  const kept = fams.driftKept || [], floorAll = floorOf(kept.map((r) => r.meanNet)), out = {};
  for (const [name, reps] of Object.entries(fams)) {
    const J = reps.map((r) => judge(r, bar, rootsQualifying));
    const JF = reps.map((r, j) => judge(r, bar, rootsQualifying, name === "driftKept" ? floorOf(kept.filter((_, i) => i !== j).map((x) => x.meanNet)) : floorAll));
    const gateNames = Object.keys(J[0] ? J[0].gates : {}).filter((g) => g !== "rootsAtLeast15"), gateNamesF = Object.keys(JF[0] ? JF[0].gates : {}).filter((g) => g !== "rootsAtLeast15");
    out[name] = { replicates: reps.length,
      registered: { wholeRuleFalsePass: share(J, (x) => x.verdictScript === "PASS"), passes: J.filter((x) => x.verdictScript === "PASS").length, perGate: Object.fromEntries(gateNames.map((g) => [g, share(J, (x) => x.gates[g])])),
        gateSets: { tAndPositive: share(J, (x) => x.gates.meanNetPositive && x.gates.tNWAtLeastBar), tAndPlacebo: share(J, (x) => x.gates.tNWAtLeastBar && x.gates.placeboP95Beaten), allButHalves: share(J, (x) => x.gates.meanNetPositive && x.gates.tNWAtLeastBar && x.gates.placeboP95Beaten) } },
      floor: { wholeRuleFalsePass: share(JF, (x) => x.verdictScript === "PASS"), passes: JF.filter((x) => x.verdictScript === "PASS").length, perGate: Object.fromEntries(gateNamesF.map((g) => [g, share(JF, (x) => x.gates[g])])) },
      tNW: dist(reps.map((r) => r.tNW), r3), meanNetPctPerWeek: dist(reps.map((r) => r.meanNet), (x) => pct(x)), placeboP95PctPerWeek: dist(reps.map((r) => r.placeboP95), (x) => pct(x)), meanTurnover: dist(reps.map((r) => r.meanTurnover), r3),
      rows: reps.map((r, i) => ({ seed: r.seed, meanNetPctPerWeek: pct(r.meanNet), tNW: r3(r.tNW), halvesPctPerWeek: [pct(r.halfFirst), pct(r.halfSecond)], placeboP95PctPerWeek: pct(r.placeboP95), verdict: J[i].verdictScript, failed: J[i].failed, verdictFloor: JF[i].verdictScript })) };
  }
  const lim = (f, set) => out[f] && out[f][set].wholeRuleFalsePass != null && out[f][set].wholeRuleFalsePass <= MAX_WHOLE_RULE_FALSE_PASS;
  const ok = Object.entries(CAL_COUNTS).every(([f, k]) => out[f] && out[f].replicates === k);
  // construction sensitivity: rollLeak vs driftFree paired by seed (same scramble; only the re-inserted roll factors differ)
  let rollLeakPaired = null;
  if (fams.rollLeak && fams.driftFree) {
    const fb = new Map(fams.driftFree.map((r) => [r.seed, r])), dt = [], dm = [];
    for (const r of fams.rollLeak) { const b = fb.get(r.seed); if (b && fin(r.tNW) && fin(b.tNW)) { dt.push(r.tNW - b.tNW); dm.push(r.meanNet - b.meanNet); } }
    const sd = sdS(dt);
    rollLeakPaired = { pairs: dt.length, meanDeltaT: r3(mean(dt)), sdDeltaT: r3(sd), seDeltaT: sd != null ? r4(sd / Math.sqrt(dt.length)) : null, meanDeltaMeanPctPerWeek: pct(mean(dm)),
      redetectedShareOfRealRolls: fams.rollLeak.length && fams.rollLeak[0].redetectedShare != null ? r3(mean(fams.rollLeak.map((r) => r.redetectedShare))) : null,
      note: "rollLeak minus driftFree, same seed: the change in t and in the mean that the roll detector's misses and false rolls add on a no-edge path (positive = flatters SP)" };
  }
  return { ok, bar, limit: MAX_WHOLE_RULE_FALSE_PASS, families: out, floor: floorAll, rollLeakPaired,
    calibrated: ok && CAL_FAMILIES.every((f) => lim(f, "registered")),
    calibratedFloor: ok && [...CAL_FAMILIES, "driftKept"].every((f) => lim(f, "floor")),
    driftKeptRegisteredFalsePass: out.driftKept ? out.driftKept.registered.wholeRuleFalsePass : null,
    note: "calibrated = the registered gate set's whole-rule false pass <= 5% on derangedSignal, placeboFamily, driftFree and rollLeak; calibratedFloor = the floor gate set's <= 5% on all five families. driftKept under the registered gates is REPORTED (it keeps the static SP-drift alignment, i.e. the hypothesis' cross-sectional content)." };
}

// ── known-answer selftest (runs before any fetch, in every mode) ─────────────────────────────────────────────────────────
function selftest() {
  const checks = {}, detail = {};
  // (a) federal holidays (observed) and closures
  checks.a_federalHolidays = ["2024-01-01", "2024-01-15", "2024-02-19", "2024-05-27", "2024-06-19", "2024-07-04", "2024-09-02", "2024-10-14", "2024-11-11", "2024-11-28", "2024-12-25"].every(isFederalClosure)
    && isFederalClosure("2021-12-31") && isFederalClosure("2021-12-24") && isFederalClosure("2021-06-18") && !isFederalClosure("2020-06-19") && isFederalClosure("2020-07-03") && isFederalClosure("2023-01-02")
    && isFederalClosure("2025-01-09") && !isFederalClosure("2024-03-29") && !isFederalClosure("2024-01-16") && nthWeekday(2026, 11, 4, 4) === "2026-11-26" && nthWeekday(2026, 5, 1, -1) === "2026-05-25";
  // (b) release / entry: normal week -> Friday release, Monday entry; MLK week (Monday holiday) -> Friday release, Monday entry; Good Friday
  //     (no session, CFTC publishes) -> Friday release, Monday entry; Thanksgiving week -> Monday; Juneteenth 2025 (Thu) -> Monday 06-23;
  //     CFTC's published 2026 schedule: Presidents Day / Labor Day / Columbus Day weeks -> Friday, Veterans Day (Wed) -> Monday 11-16,
  //     New Year's Day (Thu) -> Monday 01-05; Tuesday-holiday week (as-of Mon 2025-11-10, Veterans Day Tue) -> Friday 11-14 (CFTC 2025 table)
  { const ref = new Set(["2024-01-19", "2024-01-22", "2024-01-23", "2024-01-26", "2024-01-29", "2024-03-28", "2024-04-01", "2024-04-02"]);
    const a = releaseOf("2024-01-23", ref), b = releaseOf("2024-01-16", ref), g = releaseOf("2024-03-26", ref), t = releaseOf("2024-11-26", null), j = releaseOf("2025-06-17", null), x = releaseOf("2024-12-24", null);
    checks.b_releaseSchedule = a.release === "2024-01-26" && !a.delayed && b.release === "2024-01-19" && !b.delayed && g.release === "2024-03-29" && !g.delayed && g.noFriSession === true
      && t.release === "2024-12-02" && j.release === "2025-06-23" && x.release === "2024-12-30" && x.delayed;
    const cftc2026 = [["2025-12-30", "2026-01-05"], ["2026-01-20", "2026-01-23"], ["2026-02-17", "2026-02-20"], ["2026-05-26", "2026-05-29"], ["2026-06-16", "2026-06-22"], ["2026-06-30", "2026-07-06"],
      ["2026-09-08", "2026-09-11"], ["2026-10-13", "2026-10-16"], ["2026-11-10", "2026-11-16"], ["2026-11-24", "2026-11-30"], ["2026-12-22", "2026-12-28"], ["2025-11-10", "2025-11-14"], ["2025-11-25", "2025-12-01"], ["2025-12-23", "2025-12-29"]];
    detail.b_cftcMismatches = cftc2026.filter(([T, r]) => releaseOf(T, null).release !== r).map(([T, r]) => [T, r, releaseOf(T, null).release]);
    checks.b_cftcPublishedSchedule = detail.b_cftcMismatches.length === 0;
    const refArr = [...ref].sort(); checks.b_entryAfterRelease = refArr[firstAfter(refArr, a.release)] === "2024-01-29" && refArr[firstAfter(refArr, b.release)] === "2024-01-22" && refArr[firstAfter(refArr, g.release)] === "2024-04-01"; }
  checks.b_shutdownWindows = inShutdown("2013-10-08") && inShutdown("2019-01-15") && inShutdown("2025-10-14") && !inShutdown("2013-09-24") && !inShutdown("2019-03-12") && !inShutdown("2026-02-03")
    && inShutdown("2023-01-31") && inShutdown("2023-02-14") && inShutdown("2023-03-14") && !inShutdown("2023-01-24") && !inShutdown("2023-03-21") && inShutdown("2025-12-16") && !inShutdown("2025-12-23");
  // (c) registered fixed-roll ratio back-adjustment: A rolls into B on 01-05 (prev session 01-04: A 100, B 102) -> A's prices x 1.02
  { const A = { sym: "A", bars: [{ d: "01-01", o: 98, c: 99 }, { d: "01-02", o: 99, c: 101 }, { d: "01-04", o: 101, c: 100 }, { d: "01-05", o: 100, c: 100.5 }] };
    const Bc = { sym: "B", bars: [{ d: "01-02", o: 101, c: 103 }, { d: "01-04", o: 103, c: 102 }, { d: "01-05", o: 102.5, c: 104 }, { d: "01-08", o: 104, c: 105 }] };
    const fr = fixedRollContinuous([A, Bc], ["01-05"]);
    checks.c_fixedRollRatioBackAdjust = Math.abs(fr.factors[0] - 1.02) < 1e-15 && JSON.stringify(fr.d) === '["01-01","01-02","01-04","01-05","01-08"]' && Math.abs(fr.c[0] - 99 * 1.02) < 1e-12 && Math.abs(fr.c[2] - 102) < 1e-12
      && fr.c[3] === 104 && fr.o[3] === 102.5 && fr.c[4] === 105 && Math.abs(fr.c[1] / fr.c[0] - 101 / 99) < 1e-12; let thr = false; try { fixedRollContinuous([A, Bc], []); } catch (e) { thr = true; } checks.c_fixedRollGuards = thr; }
  // (d) generic (calendar-month) slots: a roll jump of -5% at the second month's 3rd session is detected, its gap removed, its own open->close
  //     kept; prices after the last roll unchanged; a closed slot without a bigger gap still gets one, here a +0.1% gap; the March slot is still
  //     open at the last bar (2024-03-01) and gets none
  { const d = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-02-01", "2024-02-02", "2024-02-05", "2024-02-06", "2024-03-01"], o = [100, 100.1, 100.3, 101, 101.1, 96.0, 97, 97.6], c = [100, 100.2, 100.5, 101.2, 101.05, 96.5, 97.5, 97.7];
    const roll = detectRolls(d, o, c), adj = ratioAdjust(o, c, roll), f5 = 96.0 / 101.05;
    // January: gaps +0.1000% (t1) vs +0.0998% (t2) -> t1; February: t5 (-5.0%) beats t3 (+0.4975% vs Jan close) and t6 (+0.518%); March open
    const f1 = 100.1 / 100;
    checks.d_rollDetectAndAdjust = Array.from(roll).join("") === "01000100" && Math.abs(adj.oa[5] / adj.ca[4] - 1) < 1e-12 && Math.abs(adj.ca[5] / adj.oa[5] - 96.5 / 96) < 1e-12 && adj.ca[6] === 97.5 && adj.ca[7] === 97.7 && adj.oa[5] === 96
      && Math.abs(adj.f[5] - f5) < 1e-15 && Math.abs(adj.f[1] - f1) < 1e-15 && Math.abs(adj.ca[0] - 100 * f5 * f1) < 1e-9 && Math.abs(adj.oa[1] / adj.ca[0] - 1) < 1e-12 && Math.abs(adj.ca[3] / adj.ca[0] - 1.012 / f1) < 1e-12
      && Math.abs(adj.oa[3] / adj.ca[2] - 101 / 100.5) < 1e-12; detail.d_roll = Array.from(roll).join(""); }
  // (e) NW t lag 4 by hand: [2,0,2,0,2,0] -> mean 1, gamma0 1, gammas -5/6, 4/6, -3/6, 2/6, weights .8 .6 .4 .2 -> S = 0.2, t = sqrt(30); n < 3 -> null
  checks.e_nwTLag4HandComputed = Math.abs(nwT([2, 0, 2, 0, 2, 0]) - Math.sqrt(30)) < 1e-9 && nwT([1, 2]) === null && Math.abs(nwT([1, 3, 2, 4], 0) - 2.5 / Math.sqrt(1.25 / 4)) < 1e-9 && nwT([1, 1, 1]) === null;
  // (f) summary: halves split by count, win rate
  { const S = summarise([0.01, -0.02, 0.03, 0.04, -0.01]); checks.f_summaryHalves = S.n === 5 && Math.abs(S.halfFirst - (-0.005)) < 1e-15 && Math.abs(S.halfSecond - 0.02) < 1e-15 && S.winRate === 0.6 && Math.abs(S.meanNet - 0.01) < 1e-15; }
  // synthetic world: 7 roots, 2 cost specs, 120 sessions; weekly schedule by hand
  const mkSeries = (root, n, px, rollAt = []) => { const d = [], o = [], c = []; for (let i = 0; i < n; i++) { d.push(isoUTC(Date.UTC(2024, 0, 1) + i * 864e5)); o.push(px(i)); c.push(px(i) * 1.001); }
    const roll = new Uint8Array(n); for (const t of rollAt) roll[t] = 1; return { root, n, d, oRaw: o, cRaw: c, roll, f: new Float64Array(n).fill(1), oa: o, ca: c, tick: 10, mult: 100, side: (p) => (10 + FEE_SIDE) / (p * 100) }; };
  // (g) terciles + weights: 7 names, q = 2; SP ties broken by root index; long = lowest SP; weights 1/vol per leg sum to +1 / -1
  { const w = { names: [0, 1, 2, 3, 4, 5, 6].map((ri) => ({ ri })) }, sc = [0.3, 0.1, 0.1, 0.5, 0.2, 0.9, NaN], vol = [0.01, 0.02, 0.01, 0.01, 0.01, 0.04, 0.01];
    const t = terciles(w, sc, vol); checks.g_tercilesKnownAnswer = JSON.stringify(t.L) === "[1,2]" && JSON.stringify(t.S) === "[3,5]";
    const skel = { weeks: [{ E: "a", X: "b", names: w.names.map((x) => ({ ...x, cpsOut: 0, rollCost: 0 })), cpsIn: new Float64Array(7) }] }, ps = [{ r: Float64Array.from([0, 0.03, 0.06, 0.01, 0, 0.05, 0]), vol: Float64Array.from(vol) }];
    const bk = runBook(skel, ps, [t], 7);
    // long: w1 = (1/.02)/(50+100) = 1/3, w2 = 2/3 -> 0.01 + 0.04 = 0.05; short: w3 = -(100)/(100+25) = -0.8, w5 = -0.2 -> -0.008 - 0.01 = -0.018
    checks.g_weightsAndGross = Math.abs(bk.longLeg[0] - 0.05) < 1e-15 && Math.abs(bk.shortLeg[0] + 0.018) < 1e-15 && Math.abs(bk.gross[0] - 0.032) < 1e-15 && bk.net[0] === bk.gross[0] && Math.abs(bk.turnover[0] - 2) < 1e-12; }
  // (h) engine costs: constant book over 3 contiguous weeks: entry cost week 1 only, a roll inside week 2 charged 2 x side, liquidation in week 3;
  //     a non-contiguous gap liquidates and re-enters
  { const names = [{ ri: 0, cpsOut: 0.0003, rollCost: 0 }, { ri: 1, cpsOut: 0.0004, rollCost: 0 }, { ri: 2, cpsOut: 0.0005, rollCost: 0 }];
    const mkW = (E, X, rc) => ({ E, X, names: names.map((x, i) => ({ ...x, rollCost: i === 0 ? rc : 0 })), cpsIn: Float64Array.from([0.0001, 0.0002, 0.0003]) });
    const skel = { weeks: [mkW("w1", "w2", 0), mkW("w2", "w3", 0.0006), mkW("w3", "w4", 0)] }, ps = skel.weeks.map(() => ({ r: Float64Array.from([0.01, 0, -0.01]), vol: Float64Array.from([0.01, 0.01, 0.01]) }));
    const sel = skel.weeks.map(() => ({ L: [0], S: [2] })), bk = runBook(skel, ps, sel, 3);
    const c1 = 1 * 0.0001 + 1 * 0.0003, c2 = 0.0006, c3 = 0.0003 + 0.0005;
    checks.h_engineCostsContiguous = bk.gross.every((g) => Math.abs(g - 0.02) < 1e-15) && Math.abs(bk.gross[0] - bk.net[0] - c1) < 1e-15 && Math.abs(bk.gross[1] - bk.net[1] - c2) < 1e-15 && Math.abs(bk.gross[2] - bk.net[2] - c3) < 1e-15;
    const skel2 = { weeks: [mkW("w1", "w2", 0), mkW("w5", "w6", 0)] }, bk2 = runBook(skel2, ps.slice(0, 2), sel.slice(0, 2), 3);
    checks.h_engineGapLiquidates = Math.abs(bk2.gross[0] - bk2.net[0] - (c1 + 0.0003 + 0.0005)) < 1e-15 && Math.abs(bk2.gross[1] - bk2.net[1] - (c1 + 0.0003 + 0.0005)) < 1e-15;
    // a root that drops out of the book is exited at its own entry-day cost; unpriced -> fallback
    const skel3 = { weeks: [mkW("w1", "w2", 0), { ...mkW("w2", "w3", 0), cpsIn: Float64Array.from([NaN, 0.0002, 0.0003]) }] }, sel3 = [{ L: [0], S: [2] }, { L: [1], S: [2] }], bk3 = runBook(skel3, ps.slice(0, 2), sel3, 3);
    checks.h_engineExitUnpricedFallback = Math.abs(bk3.gross[1] - bk3.net[1] - (FALLBACK_COST + 0.0002 + 0.0004 + 0.0005)) < 1e-15; }
  // (i) skeleton + path stats on a synthetic world: entry = first ref session after release, exit = next week's entry, vol = sd of the 60 returns
  //     to the close before entry, roll cost charged for a roll in (i0, i1], weeks before the 15-root start excluded
  { const n = 140, ser = [];
    for (let k = 0; k < 16; k++) ser.push(mkSeries("S" + k, n, (i) => 100 + k + i * 0.1 * (1 + (i % 3)), k === 0 ? [92] : []));
    const ref = ser[0].d.filter((d) => !isWeekend(d)), refSet = new Set(ref);
    for (const s of ser) { const keep = s.d.map((d) => !isWeekend(d)); for (const key of ["d", "oRaw", "cRaw", "oa", "ca"]) s[key] = s[key].filter((_, i) => keep[i]); s.roll = Uint8Array.from(Array.from(s.roll).filter((_, i) => keep[i])); s.n = s.d.length; }
    ser[0].roll.fill(0); ser[0].roll[72] = 1; ser[1].roll[70] = 1;                 // root 0: a roll inside its first window (70, 75]; root 1: a roll ON the entry session (not charged)
    const Ts = ["2024-04-02", "2024-04-09", "2024-04-16", "2024-04-23", "2024-04-30"];
    const cot = ser.map((s, k) => Ts.filter((T) => k < 15 || T >= "2024-04-09").map((T, j) => [T, 1000, 100 + 10 * k + j, 0, 0]));
    const sk = buildSkeleton(ser, cot, ref), w0 = sk.weeks[0];
    const e0 = ref[firstAfter(ref, releaseOf("2024-04-02", refSet).release)], e1 = ref[firstAfter(ref, releaseOf("2024-04-09", refSet).release)];
    const ps = pathStats(sk, ser.map((s) => ({ o: s.oa, c: s.ca }))), nm = w0.names[0], s0 = ser[nm.ri], rets = []; for (let j = nm.i0 - 60; j < nm.i0; j++) rets.push(s0.ca[j] / s0.ca[j - 1] - 1);
    const rollIn = Array.from(s0.roll).findIndex((x) => x === 1);
    checks.i_skeletonTiming = sk.weeks.length === 4 && sk.drops.noExit === 1 && w0.E === e0 && w0.X === e1 && e0 === "2024-04-08" && w0.names.length === 15 && sk.weeks[1].names.length === 16 && sk.evidenceStart === "2024-04-08"
      && sk.weeks.every((w) => w.E > w.release && w.release > w.T) && sk.drops.afterWindow === 0 && s0.d[nm.i0] === e0 && s0.d[nm.i1] === e1;
    checks.i_pathStats = Math.abs(ps[0].vol[0] - sdS(rets)) < 1e-12 && Math.abs(ps[0].r[0] - (s0.oa[nm.i1] / s0.oa[nm.i0] - 1)) < 1e-15
      && nm.i0 === 70 && nm.i1 === 75 && rollIn === 72 && Math.abs(nm.rollCost - 2 * s0.side(s0.cRaw[71])) < 1e-15 && w0.names[1].ri === 1 && w0.names[1].i0 === 70 && w0.names[1].rollCost === 0; detail.i_rollIn = [rollIn, nm.i0, nm.i1];
    // placebo: when every name has the same weekly return, every random book has gross 0 exactly (net = -cost)
    const flat = ps.map((x) => ({ r: new Float64Array(x.r.length).fill(0.01), vol: x.vol })), pl = placeboDist(sk, flat, 16, { draws: 50, seed: 1 });
    let ok = true; { const rng = mulberry(9); for (let dI = 0; dI < 20; dI++) { const sel = sk.weeks.map((w) => { const a = w.names.map((_, j) => j), q = Math.floor(a.length / 3); for (let i = 0; i < 2 * q; i++) { const j = i + Math.floor(rng() * (a.length - i)); [a[i], a[j]] = [a[j], a[i]]; } return { L: a.slice(0, q), S: a.slice(q, 2 * q) }; }); const b = runBook(sk, flat, sel, 16); if (!b.gross.every((g) => Math.abs(g) < 1e-15)) ok = false; } }
    const ppl = persistentPlaceboDist(sk, flat, 16, { draws: 40, seed: 2 });
    checks.i_placeboFlatReturnsZeroGross = ok && pl.p95 <= 0 && pl.draws === 50 && Math.abs(pl.grossP95) < 1e-15 && Math.abs(pl.grossP50) < 1e-15 && ppl.draws === 40 && Math.abs(ppl.grossP95) < 1e-15 && ppl.p95 <= 0 && fin(ppl.meanTurnover);
    // the read computation runs end to end on this synthetic world (smoke test of the read path: reported placebos, leave-one-root-out, floor report)
    { let rd = null, err = null; try { rd = computeTokenRead({ world: { skel: sk, R: 16, roots: ROOTS_ALL.slice(0, 16), series: ser, realPaths: ser.map((s) => ({ o: s.oa, c: s.ca })) }, bar: 1.624, rootsQualifying: 16, floorReport: { p50: 0, p95: 0.001 } }); } catch (e) { err = e.message; }
      detail.i_readSmoke = err;
      checks.i_readPathSmoke = !err && rd.n === 4 && rd.reported.leaveOneRootOut.byRoot.length === 16 && rd.reported.placeboPersistent.draws === PLACEBO_DRAWS && rd.reported.driftKeptFloor && rd.reported.driftKeptFloor.inForce === false
        && typeof rd.reported.placeboGross.beats === "boolean" && ["PASS", "DID NOT PASS"].includes(rd.verdictScript) && Object.keys(rd.gates).length === 5; }
    // look-ahead positive control machinery: score = -r selects the top-r names as longs
    const la = selectionOf(sk, ps, ps.map((x) => x.r.map((v) => -v))), lw = sk.weeks[0];
    checks.i_lookAheadSelectsBest = la[0].L.every((j) => la[0].S.every((s) => ps[0].r[j] >= ps[0].r[s])) && la[0].L.length === Math.floor(lw.names.length / 3); }
  // (j) scramble: drift-free = arithmetic zero drift (mean daily close factor exactly 1, the log drift negative), drift-kept ends at the real
  //     last close, deterministic per seed
  { const g = mulberry(5), n = 300, o = [100], c = [100]; for (let i = 1; i < n; i++) { const oo = c[i - 1] * (1 + (g() - 0.5) * 0.004); o.push(oo); c.push(oo * (1 + (g() - 0.48) * 0.03)); }
    const s = { root: "X", n, oa: o, ca: c }, f1 = scramblePath(s, 1, true), f1b = scramblePath(s, 1, true), k1 = scramblePath(s, 1, false);
    let mf = 0; for (let i = 1; i < n; i++) mf += f1.c[i] / f1.c[i - 1]; mf /= n - 1;
    checks.j_scrambleDrift = Math.abs(mf - 1) < 1e-12 && f1.c[n - 1] < f1.c[0] && Math.abs(k1.c[n - 1] / c[n - 1] - 1) < 1e-9 && f1.c.every((x, i) => x === f1b.c[i]) && k1.c.some((x, i) => Math.abs(x - c[i]) > 1e-6); detail.j_meanFactorMinus1 = mf - 1; }
  // (k) derangements: no fixed points; derangedScores deranges WITHIN each week's names (no name keeps its own SP, even in a week missing roots),
  //     the values are a permutation of the week's SPs, and the mapping persists while the composition is unchanged
  { const rng = mulberry(3); let ok = true; for (let t = 0; t < 200; t++) { const pi = derangement(9, rng); if (pi.some((x, i) => x === i) || new Set(pi).size !== 9) ok = false; }
    const comp = [[0, 1, 2, 3, 4, 5], [0, 1, 2, 3, 4, 5], [0, 2, 3, 5], [0, 1, 2, 3, 4, 5], [1, 2, 4]], skel = { weeks: comp.map((ids, k) => ({ names: ids.map((ri) => ({ ri, sp: ri + 10 * k })) })) };
    let own = 0, perm = true, persist = true;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const sc = derangedScores(skel, seed), src = sc.map((a, k) => Array.from(a, (v) => v - 10 * k));     // the source root of each name's score
      sc.forEach((a, k) => { const w = skel.weeks[k]; a.forEach((v, j) => { if (v === w.names[j].sp) own++; }); if (JSON.stringify(Array.from(a).sort()) !== JSON.stringify(w.names.map((x) => x.sp).sort())) perm = false; });
      if (JSON.stringify(src[0]) !== JSON.stringify(src[1]) || JSON.stringify(src[0]) !== JSON.stringify(src[3])) persist = false;
    }
    checks.k_derangementWithinWeek = ok && own === 0 && perm && persist; }
  // (l) decision rule
  { const base = { rootsQualifying: 20, meanNet: 0.001, tNW: 1.624, placeboP95: 0.0005, halfFirst: 0.0001, halfSecond: 0.002, bar: 1.624 }, v = (o) => decide({ ...base, ...o });
    checks.l_decisionRule = v({}).verdictScript === "PASS" && Object.keys(v({}).gates).length === 5 && v({ tNW: 1.6239 }).verdictScript === "DID NOT PASS" && JSON.stringify(v({ tNW: 1.6239 }).failed) === '["tNWAtLeastBar"]'
      && v({ placeboP95: 0.001 }).verdictScript === "DID NOT PASS" && v({ halfFirst: 0 }).verdictScript === "DID NOT PASS" && v({ meanNet: -0.001, placeboP95: -0.01 }).verdictScript === "DID NOT PASS"
      && v({ rootsQualifying: 14 }).verdictScript.startsWith("CANNOT MEASURE") && v({ rootsQualifying: 0, cannotWhy: "x" }).verdictScript === "CANNOT MEASURE — x" && v({ tNW: null }).verdictScript === "DID NOT PASS"; }
  // (m) pre-read decision parser
  { const A = preReadDecision({}), B = preReadDecision({ amendments: [{ preEvidence: true, field: "x" }] }), C = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: [TOKEN_CONSTRUCTION] }] });
    const E = preReadDecision({ amendments: [{ preEvidence: false, runnerGates: [TOKEN_CONSTRUCTION] }] }), F = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: ["placebo:p975"] }] }), G = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: [] }] });
    const H = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: [TOKEN_CONSTRUCTION] }, { preEvidence: true, runnerGates: [TOKEN_FLOOR] }] }), I = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: [TOKEN_FLOOR] }] });
    checks.m_preReadDecisionParser = A.decided && A.registered && A.construction === "registered" && B.decided && B.registered && C.decided && !C.registered && C.construction === "schwab-front-gap-ratio" && C.floor === false && !E.decided && !F.decided && !G.decided
      && H.decided && H.floor === true && JSON.stringify(H.tokens) === JSON.stringify([TOKEN_CONSTRUCTION, TOKEN_FLOOR].sort()) && !I.decided; }
  // (n) Schwab futures dates: midnight CT stamps (CDT and CST) -> the CT date; any other stamp throws; forming-bar guard and weekend rows
  { let threw = false; try { schwabFuturesDate(Date.parse("2026-10-01T15:00:00Z")); } catch (e) { threw = true; }
    const cnd = (iso, px) => ({ datetime: Date.parse(iso), open: px, high: px + 1, low: px - 1, close: px, volume: 10 });
    const pk = packFutures("T", [cnd("1989-12-29T06:00:00Z", 9), cnd("2026-09-30T05:00:00Z", 10), cnd("2026-10-02T05:00:00Z", 11), cnd("2026-10-03T05:00:00Z", 12), cnd("2026-10-05T05:00:00Z", 13), { ...cnd("2026-09-29T05:00:00Z", 1), datetime: Date.parse("2026-10-06T05:00:00Z") }]);
    const pk2 = packFutures("T", [cnd("2020-04-17T05:00:00Z", 18), { ...cnd("2020-04-20T05:00:00Z", 1), close: -37.63, low: -40 }, cnd("2020-04-21T05:00:00Z", 11)]);
    checks.n_futuresDatesAndGuards = schwabFuturesDate(Date.parse("2026-10-02T05:00:00Z")) === "2026-10-02" && schwabFuturesDate(Date.parse("1990-01-02T06:00:00Z")) === "1990-01-02" && threw
      && pk.rows.length === 2 && pk.droppedBeforeStart === 1 && pk.droppedAfterLastBar === 3 && pk.rows[1][0] === "2026-10-02" && pk2.rows.length === 2 && pk2.nonPositive === 1; }
  // (o) COT packing: SP = nsp / oi; duplicates counted; invalid rows dropped; non-ascending throws
  { const raw = [{ report_date_as_yyyy_mm_dd: "2024-01-02T00:00:00.000", market_and_exchange_names: "X", open_interest_all: "1000", noncomm_postions_spread_all: "250", noncomm_positions_long_all: "1", noncomm_positions_short_all: "2" },
      { report_date_as_yyyy_mm_dd: "2024-01-02T00:00:00.000", market_and_exchange_names: "X", open_interest_all: "1000", noncomm_postions_spread_all: "999" },
      { report_date_as_yyyy_mm_dd: "2024-01-09T00:00:00.000", market_and_exchange_names: "X", open_interest_all: "0", noncomm_postions_spread_all: "1" },
      { report_date_as_yyyy_mm_dd: "2024-01-16T00:00:00.000", market_and_exchange_names: "Y", open_interest_all: "800", noncomm_postions_spread_all: "200" }];
    const pk = packCot(raw); let thr = false; try { packCot([raw[3], raw[0]]); } catch (e) { thr = true; }
    checks.o_cotPacking = pk.rows.length === 2 && pk.rows[0][2] / pk.rows[0][1] === 0.25 && pk.duplicates === 1 && pk.invalid === 1 && JSON.stringify(pk.names) === '["X","Y"]' && thr; }
  // (p) depth table: a root with a long front run but no per-contract history qualifies for the token, never for the registered construction
  { const days = []; for (let t = Date.UTC(2015, 0, 1); isoUTC(t) <= LAST_BAR; t += 864e5) { const d = isoUTC(t); if (!isWeekend(d)) days.push(d); }
    const rowsOf = (from) => days.filter((d) => d >= from).map((d, i) => [d, 10 + i * 1e-3, 11, 9, 10 + i * 1e-3, 5]);
    // COT: root 0's report stops 2026-09-01 (still >= 8 years of overlap -> qualifies: it leaves the cross-section then, it does not vanish);
    // root 1's COT overlaps the run for only ~5 years (2015-01 .. 2020-01) -> does not qualify
    const cotOf = (i) => (i === 0 ? { rows: [["2014-12-30", 1, 1]], first: "2014-12-30", last: "2026-09-01" } : i === 1 ? { rows: [["2014-12-30", 1, 1]], first: "2014-12-30", last: "2020-01-07" } : { rows: [["2014-12-30", 1, 1]], first: "2014-12-30", last: "2026-09-29" });
    const mkCache = (expired, deferred) => ({ schwab: { meta: {}, bars: Object.fromEntries(ROOTS_ALL.map((r, i) => [r, i < 17 ? rowsOf("2015-01-01") : i < 18 ? rowsOf("2021-01-01") : []])) },
      probes: { byRoot: Object.fromEntries(ROOTS_ALL.map((r) => [r, { expired: { candles: expired }, deferred: { candles: 50, identicalToFront: deferred } }])) },
      cot: { byRoot: Object.fromEntries(ROOTS_ALL.map((r, i) => [r, cotOf(i)])) } });
    const lastDay = days[days.length - 1], dp = depthTable(mkCache(0, true)), dp2 = depthTable(mkCache(400, false));
    checks.p_depthTable = lastDay >= CURRENT_FROM && dp.registeredQualifying.length === 0 && dp.tokenQualifying.length === 16 && dp2.registeredQualifying.length === 16 && dp.rows.find((r) => r.root === ROOTS_ALL[17]).qualifiesToken === false
      && dp.rows[0].qualifiesToken === true && dp.rows[1].qualifiesToken === false && dp.rows[16].qualifiesToken === true
      && dp.rows[0].perContract.deferredIdenticalToFront === true && dp.rows[0].frontBackYears === 0; detail.p_lastDay = lastDay; }
  // (q) calibration plumbing on fabricated replicate rows: whole-rule share per family and gate set, LOO floor, calibrated flags
  { const ser = (m) => Array.from({ length: 100 }, (_, i) => m + (i % 2 ? 0.002 : -0.002));
    const mk = (k, o) => Array.from({ length: k }, (_, i) => { const r = { seed: i + 1, meanNet: 0.0001, tNW: 0.5, placeboP95: 0.0002, halfFirst: 0.0001, halfSecond: 0.0001, meanTurnover: 1, ...(o ? o(i) : {}) }; r._net = ser(r.meanNet); return r; });
    const pass = { tNW: 2, placeboP95: 0 }, kept = mk(60, (i) => ({ meanNet: 0.0001 + i * 1e-6, ...(i < 3 ? pass : {}) }));
    const der = (k) => mk(200, (i) => (i === 0 ? { meanNet: 0.01, ...pass } : i < k ? pass : {}));
    const leakRows = (o) => mk(100, (i) => ({ tNW: 0.7, meanNet: 0.0003, ...(o ? o(i) : {}) }));
    const cal = calibrate({ driftKept: kept, driftFree: mk(100), rollLeak: leakRows(), derangedSignal: der(10), placeboFamily: mk(200) }, 1.624, 20), F = cal.families;
    checks.q_calibrationPlumbing = cal.ok && Math.abs(F.driftKept.registered.wholeRuleFalsePass - 0.05) < 1e-15 && F.derangedSignal.registered.passes === 10 && cal.calibrated === true && cal.calibratedFloor === true
      && F.derangedSignal.floor.passes === 1 && F.driftKept.floor.passes === 0 && Math.abs(cal.driftKeptRegisteredFalsePass - 0.05) < 1e-15 && Math.abs(cal.floor.p50 - (0.0001 + 29e-6)) < 1e-15 && Math.abs(cal.floor.p95 - (0.0001 + 56e-6)) < 1e-15
      && F.placeboFamily.registered.wholeRuleFalsePass === 0 && F.driftFree.registered.perGate.meanNetPositive === 1 && Object.keys(F.derangedSignal.floor.perGate).length === 6
      && cal.rollLeakPaired.pairs === 100 && cal.rollLeakPaired.meanDeltaT === 0.2 && cal.rollLeakPaired.sdDeltaT === 0 && cal.rollLeakPaired.meanDeltaMeanPctPerWeek === 0.02 && F.rollLeak.registered.passes === 0;
    const cal3 = calibrate({ driftKept: kept, driftFree: mk(100), rollLeak: leakRows(), derangedSignal: der(11), placeboFamily: mk(200) }, 1.624, 20), cal4 = calibrate({ driftKept: kept, driftFree: mk(99), rollLeak: leakRows(), derangedSignal: der(10), placeboFamily: mk(200) }, 1.624, 20);
    const cal5 = calibrate({ driftKept: kept, driftFree: mk(100), rollLeak: leakRows((i) => (i < 6 ? pass : {})), derangedSignal: der(10), placeboFamily: mk(200) }, 1.624, 20), cal6 = calibrate({ driftKept: kept, driftFree: mk(100), derangedSignal: der(10), placeboFamily: mk(200) }, 1.624, 20);
    checks.q_calibratedLimitAndCounts = cal3.calibrated === false && cal3.families.derangedSignal.registered.passes === 11 && cal4.ok === false && cal4.calibrated === false
      && cal5.ok && cal5.families.rollLeak.registered.passes === 6 && cal5.calibrated === false && cal5.calibratedFloor === false && cal6.ok === false && cal6.calibrated === false; }
  // (r) the type-normalised roll detector: weekday gaps 0.05%, Monday gaps 1.0%; in Feb 2025 (closed: the series runs to 2025-03-03) a 1.5% Monday
  //     gap (z 1.5) and a 0.5% Wednesday gap (z 10) -> the Wednesday is the roll (R286's raw max would take the Monday); one roll per closed
  //     calendar month, none in the open March slot
  { const d = []; for (let t = Date.UTC(2024, 0, 1); isoUTC(t) <= "2025-03-03"; t += 864e5) { const x = isoUTC(t); if (!isWeekend(x)) d.push(x); }
    const lastM = "2025-02", mons = d.map((x, i) => (x.slice(0, 7) === lastM && dow(x) === 1 ? i : -1)).filter((i) => i > 0), weds = d.map((x, i) => (x.slice(0, 7) === lastM && dow(x) === 3 ? i : -1)).filter((i) => i > 0);
    const o = [100], c = [100]; let k = 0;
    for (let t = 1; t < d.length; t++) { let g = dow(d[t]) === 1 ? ((k++ % 2) ? -0.01 : 0.01) : 0.0005; if (t === mons[0]) g = 0.015; if (t === weds[0]) g = 0.005; o.push(c[t - 1] * (1 + g)); c.push(o[t]); }
    const roll = detectRolls(d, o, c), rollsLast = d.map((x, i) => (x.slice(0, 7) === lastM && roll[i] ? i : -1)).filter((i) => i >= 0), months = new Set(d.slice(1).map((x) => x.slice(0, 7))).size;
    checks.r_typeNormalisedDetector = rollsLast.length === 1 && rollsLast[0] === weds[0] && Array.from(roll).reduce((a, x) => a + x, 0) === months - 1 && !roll[d.length - 1] && mons[0] < weds[0] && d[d.length - 1] === "2025-03-03"; detail.r_detector = { rollsLast, mon: mons[0], wed: weds[0] }; }
  // (t) roll slots from the exchange specs (known answers): grains bound the 14th, metals / LE month end, HE the 17th, monthly roots the calendar
  //     month; a root without a spec throws
  { let thr = false; try { rollSlot("KC", "2026-01-05"); } catch (e) { thr = true; }
    const S = (r, d) => { const s = rollSlot(r, d); return `${s.key}|${s.end}`; };
    checks.t_rollSlotsKnownAnswers = thr && S("ZC", "2026-04-28") === "2026-05|2026-05-14" && S("ZC", "2026-05-14") === "2026-05|2026-05-14" && S("ZC", "2026-05-15") === "2026-07|2026-07-14"
      && S("ZC", "2026-12-20") === "2027-03|2027-03-14" && S("ZS", "2026-07-28") === "2026-08|2026-08-14" && S("ZS", "2026-08-15") === "2026-09|2026-09-14" && S("LE", "2026-09-29") === "2026-10|2026-10-31"
      && S("LE", "2026-10-05") === "2026-10|2026-10-31" && S("GC", "2026-03-27") === "2026-04|2026-04-30" && S("GC", "2026-02-27") === "2026-02|2026-02-28" && S("HE", "2026-11-14") === "2026-12|2026-12-17"
      && S("HE", "2026-12-18") === "2027-02|2027-02-17" && S("HE", "2026-04-20") === "2026-05|2026-05-17" && S("PL", "2026-02-02") === "2026-04|2026-04-30" && S("GF", "2026-06-10") === "2026-08|2026-08-31"
      && S("NG", "2024-02-27") === "2024-02|2024-02-29" && S(undefined, "2025-02-03") === "2025-02|2025-02-28"
      && rollSlot("CL", "2026-03-02") === null && rollSlot("CL", "2026-03-26") === null && S("CL", "2026-03-16") === "2026-03|2026-03-25" && S("HO", "2026-03-30") === "2026-03|2026-03-31" && rollSlot("HO", "2026-03-02") === null
      && Object.keys(ROLL_SPEC).every((r) => (ROLL_SPEC[r].every ? ROLL_SPEC[r].dom[0] >= 1 && ROLL_SPEC[r].dom[0] <= ROLL_SPEC[r].dom[1] && ROLL_SPEC[r].dom[1] <= 31
        : ROLL_SPEC[r].months.every((m, i, a) => m >= 1 && m <= 12 && (!i || m > a[i - 1])) && ROLL_SPEC[r].ltd >= 1 && ROLL_SPEC[r].ltd <= 31)); }
  // (w) every-month root inside its day window: a +11% weekend news gap on the 2nd (outside CL's 10-25 window) stays in the returns, the
  //     +1% roll gap on the 16th is the roll; the generic calendar-month slot would have erased the news gap instead
  { const d = []; for (let t = Date.UTC(2026, 1, 2); isoUTC(t) <= "2026-03-31"; t += 864e5) { const x = isoUTC(t); if (!isWeekend(x)) d.push(x); }
    const o = [100], c = [100]; for (let t = 1; t < d.length; t++) { const g = d[t] === "2026-03-02" ? 0.11 : d[t] === "2026-03-16" ? 0.01 : (t % 2 ? 0.0004 : -0.0004); o.push(c[t - 1] * (1 + g)); c.push(o[t] * 1.0002); }
    const rc = detectRolls(d, o, c, "CL"), rg = detectRolls(d, o, c), i2 = d.indexOf("2026-03-02"), i16 = d.indexOf("2026-03-16");
    checks.w_energyDayWindow = rc[i16] === 1 && rc[i2] === 0 && rg[i2] === 1 && rg[i16] === 0 && Array.from(rc).reduce((a, x) => a + x, 0) === 2; }
  // (u) slot detector on an LE-like root: a big gap on the 30th of the month BEFORE a contract month and one early IN a contract month are both
  //     rolls (the auditor's contract-month table would miss the first), a mid-slot news gap smaller than its slot's roll stays in the
  //     returns, one roll per closed listed contract (6 in 2024), none in a slot still open at the last bar
  { const mk = (endIso) => { const d = []; for (let t = Date.UTC(2024, 0, 1); isoUTC(t) <= endIso; t += 864e5) { const x = isoUTC(t); if (!isWeekend(x)) d.push(x); }
      const big = { "2024-01-30": 0.03, "2024-03-12": 0.01, "2024-04-03": 0.02 }, o = [100], c = [100];
      for (let t = 1; t < d.length; t++) { const g = big[d[t]] != null ? big[d[t]] : (t % 2 ? 0.0005 : -0.0005); o.push(c[t - 1] * (1 + g)); c.push(o[t] * 1.0001); } return { d, o, c }; };
    const A = mk("2024-12-31"), rA = detectRolls(A.d, A.o, A.c, "LE"), at = (x) => rA[A.d.indexOf(x)] === 1, B = mk("2024-11-15"), rB = detectRolls(B.d, B.o, B.c, "LE"), sum = (r) => Array.from(r).reduce((a, x) => a + x, 0);
    checks.u_slotDetectorLE = at("2024-01-30") && at("2024-04-03") && !at("2024-03-12") && sum(rA) === 6 && sum(rB) === 5 && A.d[A.d.length - 1] === "2024-12-31"; detail.u_rollsA = A.d.filter((_, i) => rA[i]); }
  // (v) roll-leak world: one real roll factor of 1.2 in an otherwise quiet monthly root is re-detected and removed; all other gaps and every
  //     open->close move are the arithmetic-zero-drift scramble of the same seed
  { const d = []; for (let t = Date.UTC(2024, 0, 1); isoUTC(t) <= "2024-04-01"; t += 864e5) { const x = isoUTC(t); if (!isWeekend(x)) d.push(x); }
    const n = d.length, g = mulberry(11), oa = [100], ca = [100]; for (let i = 1; i < n; i++) { oa.push(ca[i - 1] * (1 + (g() - 0.5) * 0.002)); ca.push(oa[i] * (1 + (g() - 0.5) * 0.01)); }
    const ts = d.indexOf("2024-02-14"), f = new Float64Array(n).fill(1), roll = new Uint8Array(n); f[ts] = 1.2; roll[ts] = 1;
    const s = { root: "CL", n, d, oa, ca, f, roll }, lp = rollLeakPath(s, 7), sc = scramblePath(s, 7, true);
    let gapsOk = true, intraOk = true; for (let t = 1; t < n; t++) { if (Math.abs(lp.c[t] / lp.o[t] - sc.c[t] / sc.o[t]) > 1e-12) intraOk = false; if (!lp.roll[t] && Math.abs(lp.o[t] / lp.c[t - 1] - sc.o[t] / sc.c[t - 1]) > 1e-12) gapsOk = false; }
    const lm = rollLeakPath(s, 7, 1);                                                     // forced miss: the 1.2 factor stays in the returns
    checks.v_rollLeakPath = lp.roll[ts] === 1 && Math.abs(lp.o[ts] / lp.c[ts - 1] - 1) < 1e-12 && lp.realRolls === 1 && lp.redetected === 1 && gapsOk && intraOk && Array.from(lp.roll).reduce((a, x) => a + x, 0) === 3
      && lm.roll[ts] === 0 && lm.redetected === 0 && Math.abs(lm.o[ts] / lm.c[ts - 1] - 1.2 * sc.o[ts] / sc.c[ts - 1]) < 1e-12; }
  // (s) floor gate by hand (lag 4): [2,0,2,0,2,0] vs p50 0 -> t sqrt(30); vs p50 1 -> t 0; mean 1 > p95 0.9
  { const a = floorGate([2, 0, 2, 0, 2, 0], 1, { p50: 0, p95: 0.9 }, 1.624), b = floorGate([2, 0, 2, 0, 2, 0], 1, { p50: 1, p95: 1 }, 1.624);
    checks.s_floorGateHandComputed = a.meanAboveP95 && Math.abs(a.tVsP50 - Math.sqrt(30)) < 1e-9 && a.tVsP50AtLeastBar && !b.meanAboveP95 && b.tVsP50 === 0 && !b.tVsP50AtLeastBar
      && decide({ rootsQualifying: 20, meanNet: 1, tNW: 2, placeboP95: 0, halfFirst: 1, halfSecond: 1, bar: 1.624, floor: b }).verdictScript === "DID NOT PASS" && decide({ rootsQualifying: 20, meanNet: 1, tNW: 2, placeboP95: 0, halfFirst: 1, halfSecond: 1, bar: 1.624, floor: a }).verdictScript === "PASS"; }
  return { pass: Object.values(checks).every(Boolean), checks, detail };
}

// ── the read computation (token construction), pure; never run on the real path except by --read ─────────────────────────
function computeTokenRead({ world, bar, rootsQualifying, floor = null, floorReport = null }) {
  const { skel, R, roots, series, realPaths } = world, ps = pathStats(skel, realPaths), scores = spScores(skel), sel = selectionOf(skel, ps, scores);
  const bk = runBook(skel, ps, sel, R, { contrib: true }), sm = summarise(bk.net), pl = placeboDist(skel, ps, R);
  const fg = floor ? floorGate(bk.net, sm.meanNet, floor, bar) : null, fgRep = floorReport ? floorGate(bk.net, sm.meanNet, floorReport, bar) : null;
  // REPORTED beside the verdict (never gates unless a token says so): gross and persistent-rank placebos, leave-one-root-out t
  const ppl = persistentPlaceboDist(skel, ps, R), meanGross = mean(bk.gross);
  const loo = roots.map((root, ri) => { const sc = scores.map((a, k) => Float64Array.from(a, (v, j) => (skel.weeks[k].names[j].ri === ri ? NaN : v))), b = runBook(skel, ps, selectionOf(skel, ps, sc), R), s = summarise(b.net); return { dropped: root, meanNetPctPerWeek: pct(s.meanNet), tNW: r3(s.tNW) }; });
  const looT = loo.map((x) => x.tNW).filter(fin).sort((a, b) => a - b);
  const Dreg = decide({ rootsQualifying, meanNet: sm.meanNet, tNW: sm.tNW, placeboP95: pl.p95, halfFirst: sm.halfFirst, halfSecond: sm.halfSecond, bar });
  const D0 = fg ? decide({ rootsQualifying, meanNet: sm.meanNet, tNW: sm.tNW, placeboP95: pl.p95, halfFirst: sm.halfFirst, halfSecond: sm.halfSecond, bar, floor: fg }) : Dreg;
  const legs = { long: { meanPctPerWeek: pct(mean(bk.longLeg)), tNW: r3(nwT(bk.longLeg)) }, short: { meanPctPerWeek: pct(mean(bk.shortLeg)), tNW: r3(nwT(bk.shortLeg)), note: "P&L of the short positions (gross)" }, gross: { meanPctPerWeek: pct(mean(bk.gross)), tNW: r3(nwT(bk.gross)) } };
  const sectors = {}; for (const sec of [...new Set(roots.map((r) => CANDIDATES[r][0]))]) { const ix = roots.map((r, i) => (CANDIDATES[r][0] === sec ? i : -1)).filter((i) => i >= 0), s = bk.by.map((row) => ix.reduce((a, i) => a + row[i], 0)); sectors[sec] = { roots: ix.map((i) => roots[i]), meanGrossContributionPctPerWeek: pct(mean(s)), tNW: r3(nwT(s)) }; }
  // factor overlap (REPORTED): 52-week momentum and a roll-gap carry proxy, same names / weights / costs
  const mom = skel.weeks.map((w) => Float64Array.from(w.names, (nm) => { const s = series[nm.ri], a = nm.i0 - 1 - 252; return a >= 0 ? -(s.ca[nm.i0 - 1] / s.ca[a] - 1) : NaN; }));
  const carry = skel.weeks.map((w) => Float64Array.from(w.names, (nm) => { const s = series[nm.ri], a = nm.i0 - 252; if (a < 1) return NaN; let x = 0; for (let t = a; t < nm.i0; t++) if (s.roll[t]) x += Math.log(s.f[t]); return x; }));
  const mb = runBook(skel, ps, selectionOf(skel, ps, mom), R), cb = runBook(skel, ps, selectionOf(skel, ps, carry), R);
  const corr = (a, b) => { const ma = mean(a), mb2 = mean(b); let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb2); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb2) ** 2; } return sab / Math.sqrt(saa * sbb); };
  const ols = (y, X) => { const k = X[0].length, A = Array.from({ length: k }, () => new Array(k + 1).fill(0)); for (let i = 0; i < y.length; i++) for (let a = 0; a < k; a++) { for (let b = 0; b < k; b++) A[a][b] += X[i][a] * X[i][b]; A[a][k] += X[i][a] * y[i]; }
    for (let c = 0; c < k; c++) { let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r; [A[c], A[p]] = [A[p], A[c]]; for (let r = 0; r < k; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let cc = c; cc <= k; cc++) A[r][cc] -= f * A[c][cc]; } }
    const b = A.map((row, i) => row[k] / row[i]), res = y.map((v, i) => v - X[i].reduce((s, x, j) => s + x * b[j], 0)); return { b, res }; };
  const fit = ols(bk.net, bk.net.map((_, i) => [1, mb.net[i], cb.net[i]])), alpha = fit.b[0], alphaSeries = fit.res.map((e) => e + alpha);
  const perYear = {}; skel.weeks.forEach((w, k) => { const y = w.E.slice(0, 4); (perYear[y] || (perYear[y] = [])).push(bk.net[k]); });
  const nRoots = skel.weeks.map((w) => w.names.length).sort((a, b) => a - b);
  const out = {
    n: sm.n, unit: "weeks", meanNet: sm.meanNet, meanNetPctPerWeek: pct(sm.meanNet), tNet: r4(sm.tNW), tNetRaw: sm.tNW, winRatePct: r1(100 * sm.winRate),
    halves: { first: { weeks: sm.halfN[0], meanNetPctPerWeek: pct(sm.halfFirst), from: skel.weeks[0].E }, second: { weeks: sm.halfN[1], meanNetPctPerWeek: pct(sm.halfSecond), from: skel.weeks[sm.halfN[0]].E } },
    placebo: { draws: pl.draws, seed: pl.seed, p95: pl.p95, p95PctPerWeek: pct(pl.p95), observed: sm.meanNet, observedPctPerWeek: pct(sm.meanNet), beats: D0.gates.placeboP95Beaten, p50PctPerWeek: pct(pl.p50), meanOfDrawsPctPerWeek: pct(pl.meanOfDraws),
      method: "SP ranks shuffled across the week's eligible roots (uniform disjoint random terciles), same 1/vol weights and costs; statistic = mean weekly net; p95 = sorted[floor(0.95 x draws)]" },
    gates: D0.gates, failedGates: D0.failed, verdictScript: D0.verdictScript,
    ...(fg ? { floor: { p50PctPerWeek: pct(fg.p50), p95PctPerWeek: pct(fg.p95), meanAboveP95: fg.meanAboveP95, tVsP50: r4(fg.tVsP50), tVsP50AtLeastBar: fg.tVsP50AtLeastBar, source: "controls run: 60 drift-kept scramble means (real SP)" },
      registeredGates: { gates: Dreg.gates, failedGates: Dreg.failed, verdictScript: Dreg.verdictScript, note: "decisionRule.pass as registered, reported beside the floor-token verdict" } } : {}),
    reported: { legs, sectors,
      placeboGross: { p95PctPerWeek: pct(pl.grossP95), p50PctPerWeek: pct(pl.grossP50), observedGrossPctPerWeek: pct(meanGross), beats: meanGross > pl.grossP95, method: "the registered placebo's random books before costs vs the observed mean gross (same draws)" },
      placeboPersistent: { draws: ppl.draws, seed: ppl.seed, p95PctPerWeek: pct(ppl.p95), p50PctPerWeek: pct(ppl.p50), beats: sm.meanNet > ppl.p95, grossP95PctPerWeek: pct(ppl.grossP95), beatsGross: meanGross > ppl.grossP95, meanTurnover: r3(ppl.meanTurnover),
        method: "one random score per root held for the whole sample (terciles recomputed weekly among that week's names), same weights and costs: does SP beat random PERSISTENT ranks?" },
      leaveOneRootOut: { minTNW: looT.length ? looT[0] : null, medianTNW: nearestRank(looT, 0.5), maxTNW: looT.length ? looT[looT.length - 1] : null, byRoot: loo },
      ...(fgRep ? { driftKeptFloor: { inForce: !!fg, p50PctPerWeek: pct(fgRep.p50), p95PctPerWeek: pct(fgRep.p95), meanAboveP95: fgRep.meanAboveP95, tVsP50: r4(fgRep.tVsP50), tVsP50AtLeastBar: fgRep.tVsP50AtLeastBar, source: "controls run: 60 drift-kept scramble means (real SP)" } } : {}),
      factorOverlap: { momentum52w: { meanNetPctPerWeek: pct(mean(mb.net)), tNW: r3(nwT(mb.net)), corrWithSP: r3(corr(bk.net, mb.net)) }, carryRollGapProxy: { meanNetPctPerWeek: pct(mean(cb.net)), tNW: r3(nwT(cb.net)), corrWithSP: r3(corr(bk.net, cb.net)), note: "carry proxy = trailing-252-session sum of log roll factors (backwardation -> long); not a true front/back carry (no back-month history)" },
        spAlphaOverMomCarry: { alphaPctPerWeek: pct(alpha), tNW: r3(nwT(alphaSeries)), betaMom: r3(fit.b[1]), betaCarry: r3(fit.b[2]) } },
      rootsPerWeek: { min: nRoots[0], median: nearestRank(nRoots, 0.5), max: nRoots[nRoots.length - 1] }, meanWeeklyTurnover: r3(mean(bk.turnover)), meanGrossPctPerWeek: pct(mean(bk.gross)),
      perYear: Object.fromEntries(Object.entries(perYear).sort().map(([y, v]) => [y, { weeks: v.length, meanNetPctPerWeek: pct(mean(v)) }])), barAtObservedN: barAtN(sm.n, 5000) } };
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  let st; try { st = selftest(); } catch (e) { st = { pass: false, checks: {}, detail: { threw: e.message, stack: e.stack } }; }
  console.log(`R322 selftest ${st.pass ? "PASS" : "FAIL"} ${JSON.stringify(st.checks)}`);
  if (!st.pass) { console.log(`  detail ${JSON.stringify(st.detail)}`); process.exit(1); }
  if (SELFTEST_ONLY) return;
  const entry = registryEntry(), bar = entry && entry.bar ? Number(entry.bar.tRequired) : NaN, runnerSha = sha256(fs.readFileSync(__filename));

  if (!READ) {
    // CONTROLS RUN — depth table, leak test, look-ahead positive control, whole-rule calibration on no-edge data. The real SP book on the
    // real path is never computed.
    if (!entry) { console.error(`${ID} not registered — refusing`); process.exit(2); }
    if (!fin(bar)) { console.error(`${ID} registry entry has no numeric bar.tRequired — refusing`); process.exit(2); }
    const { cache, sha, fetched } = await loadOrFetch(true), dp = depthTable(cache), decision = preReadDecision(entry);
    console.log(`R322 data ${fetched ? "fetched + cached" : "from cache"} · sha256 ${sha}`);
    console.log(`  depth (reference sessions ${dp.referenceSessions}):`);
    for (const r of dp.rows) console.log(`    ${r.root.padEnd(4)} ${r.sector.padEnd(9)} front ${r.schwabFront.served ? `${r.schwabFront.runFirst}..${r.schwabFront.runLast} ${String(r.schwabFront.years).padStart(5)}y cov ${r.schwabFront.coverage}` : "NOT SERVED".padEnd(36)} · expired ${r.perContract.expiredServed ? "SERVED" : "none"} · deferred ${r.perContract.deferredIdenticalToFront ? "= front" : r.perContract.backMonthHistory ? "DISTINCT" : "none"} · COT ${r.cot.rows != null ? `${r.cot.rows} ${r.cot.first}..${r.cot.last}` : (r.cot.skipped || r.cot.error)} · registered ${r.qualifiesRegistered ? "Y" : "n"} token ${r.qualifiesToken ? "Y" : "n"}`);
    const regN = dp.registeredQualifying.length, regVerdict = regN < MIN_ROOTS ? `CANNOT MEASURE — ${regN} of ${ROOTS_ALL.length} candidate roots have >= ${MIN_YEARS} years of continuous daily front/back history from Schwab pricehistory (Schwab serves only its continuous front series: contract-specific symbols return the identical front candles, expired contracts return none)` : null;
    console.log(`  registered construction: ${regN} roots qualify -> ${regVerdict || "measurable (not implemented: would need a per-contract fetch)"}`);
    console.log(`  token construction (${TOKEN_CONSTRUCTION}): ${dp.tokenQualifying.length} roots qualify ${JSON.stringify(dp.tokenQualifying)}`);
    let token = { evaluated: false };
    if (dp.tokenQualifying.length >= MIN_ROOTS) {
      const world = tokenWorld(cache, dp), sk = world.skel, t0 = Date.now();
      console.log(`  token panel: ${sk.weeks.length} traded weeks from ${sk.evidenceStart} · scheduled reports ${sk.scheduled} · dropped ${JSON.stringify(sk.drops)} · delayed-release weeks ${sk.delayedWeeks} · weeks < 15 roots after start ${sk.below15AfterStart}`);
      const rollDiag = Object.fromEntries(world.series.map((x) => [x.root, rollDiagnostics(x)]));
      console.log(`  roll detector (price gaps only): ${world.series.map((x) => `${x.root} ${rollDiag[x.root].rolls}r long ${rollDiag[x.root].shareAfterLongBreak}${rollDiag[x.root].shareInsideWindow != null ? ` win ${rollDiag[x.root].shareInsideWindow}` : ""}`).join(" · ")}`);
      // structural leak checks: every week enters after its release, which is after T; exit after entry; no shutdown week
      const structural = { entryAfterRelease: sk.weeks.every((w) => w.E > w.release), releaseAtLeastTPlus3: sk.weeks.every((w) => calDays(w.T, w.release) >= 3), exitAfterEntry: sk.weeks.every((w) => w.X > w.E),
        entryAtOrAfterTPlus6: sk.weeks.every((w) => calDays(w.T, w.E) >= 6), noShutdownWeek: sk.weeks.every((w) => !inShutdown(w.T)) };
      const spSc = spScores(sk), free12 = [1, 2].map((seed) => replicate(world, world.series.map((x) => scramblePath(x, seed, true)), spSc, { placebo: { p95: null } }));
      const leakPass = Object.values(structural).every(Boolean) && free12.every((x) => x.tNW != null && x.tNW < LEAK_T);
      const psReal = pathStats(sk, world.realPaths), la = runBook(sk, psReal, selectionOf(sk, psReal, psReal.map((x) => x.r.map((v) => -v))), world.R), laS = summarise(la.net), pcPass = laS.tNW != null && laS.tNW >= PC_T;
      console.log(`  leak test ${leakPass ? "PASS" : "FAIL"} structural ${JSON.stringify(structural)} · drift-free seed 1 t ${r3(free12[0].tNW)} · seed 2 t ${r3(free12[1].tNW)} (< ${LEAK_T})`);
      console.log(`  positive control (look-ahead: rank on the week's own return) ${pcPass ? "PASS" : "FAIL"} t_NW ${r3(laS.tNW)} mean ${pct(laS.meanNet)}%/wk (>= ${PC_T})`);
      console.log(`  calibrating the WHOLE rule: ${DERANGE_SEEDS} deranged-signal + ${PLACEBO_FAMILY_REPS} placebo-family books on the real path, ${FREE_SEEDS} arithmetic-zero-drift + ${ROLL_LEAK_SEEDS} roll-leak + ${KEPT_SEEDS} drift-kept scrambles (placebo ${PLACEBO_DRAWS} draws each) ...`);
      const kept = [], free = [], der = [], leak = [];
      for (let x = 1; x <= KEPT_SEEDS; x++) { kept.push({ seed: x, ...replicate(world, world.series.map((y) => scramblePath(y, x, false)), spSc, { keep: true }) }); if (x % 20 === 0) console.log(`    drift-kept ${x}/${KEPT_SEEDS} (${((Date.now() - t0) / 1000).toFixed(0)} s)`); }
      for (let x = 1; x <= FREE_SEEDS; x++) free.push({ seed: x, ...replicate(world, world.series.map((y) => scramblePath(y, x, true)), spSc, { keep: true }) });
      for (let x = 1; x <= ROLL_LEAK_SEEDS; x++) {
        const lp = world.series.map((y) => rollLeakPath(y, x)), hit = lp.reduce((a, p) => a + p.redetected, 0), real = lp.reduce((a, p) => a + p.realRolls, 0);
        leak.push({ seed: x, redetectedShare: real ? hit / real : null, ...replicate(world, lp, spSc, { keep: true }) });
        if (x % 25 === 0) console.log(`    roll-leak ${x}/${ROLL_LEAK_SEEDS} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
      }
      // REPORTED sensitivity (never a gate): the roll-leak world with half of the re-detected real rolls forced to miss (the auditor's
      // 48%-miss design), paired with the arithmetic-zero-drift scramble of the same seed; statistic t only (no placebo)
      const sens = [];
      for (let x = 1; x <= FORCED_MISS_SEEDS; x++) { const r = replicate(world, world.series.map((y) => rollLeakPath(y, x, FORCED_MISS)), spSc, { placebo: { p95: null } }), b = free[x - 1]; if (fin(r.tNW) && fin(b.tNW)) sens.push({ dt: r.tNW - b.tNW, dm: r.meanNet - b.meanNet }); }
      const sdt = sdS(sens.map((x) => x.dt)), rollLeakSensitivity = { forcedMissShare: FORCED_MISS, pairs: sens.length, meanDeltaT: r3(mean(sens.map((x) => x.dt))), sdDeltaT: r3(sdt), seDeltaT: sdt != null ? r4(sdt / Math.sqrt(sens.length)) : null,
        meanDeltaMeanPctPerWeek: pct(mean(sens.map((x) => x.dm))), note: "REPORTED: change in t (vs the plain scramble, same seed) if half of the real rolls were missed by the detector — an upper-side size of the SP-aligned roll leak; positive = flatters SP" };
      console.log(`  roll-leak sensitivity (${100 * FORCED_MISS}% forced misses, reported): ${JSON.stringify(rollLeakSensitivity)}`);
      const plReal = placeboDist(sk, psReal, world.R);
      for (let x = 1; x <= DERANGE_SEEDS; x++) der.push({ seed: x, ...replicate(world, world.realPaths, derangedScores(sk, 322322 + x), { placebo: plReal, keep: true }) });
      const pfam = placeboFamilyReps(world, psReal, plReal, PLACEBO_FAMILY_REPS, 3220001);
      console.log(`    done (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
      const calibration = calibrate({ derangedSignal: der, placeboFamily: pfam, driftFree: free, rollLeak: leak, driftKept: kept }, bar, dp.tokenQualifying.length), fr = (x) => calibration.families[x];
      const pc1 = (v) => pct(v, 1);
      for (const x of [...CAL_FAMILIES, "driftKept"]) console.log(`  ${x.padEnd(15)} registered gates: WHOLE RULE ${fr(x).registered.passes}/${fr(x).replicates} = ${pc1(fr(x).registered.wholeRuleFalsePass)}% · per gate ${JSON.stringify(Object.fromEntries(Object.entries(fr(x).registered.perGate).map(([k, v]) => [k, pc1(v)])))} | floor gate set ${fr(x).floor.passes}/${fr(x).replicates} = ${pc1(fr(x).floor.wholeRuleFalsePass)}% · t_NW ${JSON.stringify(fr(x).tNW)}`);
      console.log(`  roll-leak vs arithmetic-zero-drift, paired by seed: ${JSON.stringify(calibration.rollLeakPaired)}`);
      const readyReg = leakPass && pcPass && calibration.ok && calibration.calibrated, readyFloor = leakPass && pcPass && calibration.ok && calibration.calibratedFloor;
      token = { evaluated: true, token: TOKEN_CONSTRUCTION, roots: world.roots, weeks: sk.weeks.length, evidenceStart: sk.evidenceStart, lastExit: sk.weeks.length ? sk.weeks[sk.weeks.length - 1].X : null, scheduledReports: sk.scheduled, dropped: sk.drops, delayedReleaseWeeks: sk.delayedWeeks, weeksBelow15RootsAfterStart: sk.below15AfterStart,
        rollDiagnostics: rollDiag, rollLeakSensitivity,
        leakTest: { pass: leakPass, structural, driftFreeSeeds: free12.map((x, i) => ({ seed: i + 1, tNW: r3(x.tNW), meanNetPctPerWeek: pct(x.meanNet) })), requirement: `structural checks all true AND t_NW < ${LEAK_T} on arithmetic-zero-drift scrambles seeds 1, 2` },
        positiveControl: { pass: pcPass, method: "rank on the week's own realised adjusted return (look-ahead; long the best tercile)", tNW: r3(laS.tNW), meanNetPctPerWeek: pct(laS.meanNet), requirement: `t_NW >= ${PC_T}` },
        calibration, barAtN: barAtN(sk.weeks.length, 5000), readyRegisteredGates: readyReg, readyFloorGates: readyFloor };
    }
    let ready = false, holdWhy = null;
    if (!decision.decided) holdWhy = `pre-read decision invalid (${decision.why})`;
    else if (decision.construction === "registered") { if (regN < MIN_ROOTS) ready = true; else holdWhy = "registered construction qualifies >= 15 roots but needs a per-contract fetch this runner does not implement — refuse (fail closed)"; }
    else if (!token.evaluated) holdWhy = "token construction qualifies < 15 roots";
    else if (decision.floor ? !token.readyFloorGates : !token.readyRegisteredGates) holdWhy = `token construction not READY for the gate set in force (${decision.floor ? "floor" : "registered"}): leak ${token.leakTest.pass}, positive ${token.positiveControl.pass}, calibrated ${decision.floor ? token.calibration.calibratedFloor : token.calibration.calibrated}`;
    else ready = true;
    const F = token.evaluated ? token.calibration.families : null, p1 = (v) => `${pct(v, 1)}%`, RLP = token.evaluated ? token.calibration.rollLeakPaired : null;
    const specTxt = Object.entries(ROLL_SPEC).filter(([r]) => token.evaluated && token.roots.includes(r)).map(([r, s]) => (s.every ? `${r} every month, days ${s.dom[0]}-${s.dom[1]}` : `${r} ${s.months.map((m) => "FGHJKMNQUVXZ"[m - 1]).join("")}/${s.ltd === 31 ? "end" : s.ltd}`)).join("; ");
    const proposedAmendment = token.evaluated ? { date: "2026-10-03", preEvidence: true, field: "rule (continuous-contract construction, release timing, not-traded report windows) / universe / decisionRule.cannotMeasure / controls.calibration",
      was: "Continuous contracts back-adjusted by ratio at a fixed roll (5 business days before first notice / last trade); universe = Schwab-available commodity roots with >= 8 years of continuous daily front/back data; CANNOT MEASURE if < 15 roots have >= 8 years of continuous daily history from free sources (Schwab pricehistory, CFTC COT); calibration on >= 60 scrambles or the placebo family.",
      becomes: `Schwab continuous front /ROOT daily (Schwab's own roll), ratio back-adjusted at its rolls. A roll is declared only inside a listed contract's roll slot: the sessions after the previous listed delivery month's last-trade bound up to its own, bound = an upper bound of the contract's last trading day under the exchange spec (COMEX/NYMEX metals, LE and GF the end of the delivery month; CBOT/KC grains and oilseeds the 14th; HE the 17th); CL NG HO RB (every month listed; last trade in the month before delivery: CL <= the 22nd, NG <= the 29th, HO/RB the last business day) use the calendar month restricted to the days CL 10-25th, NG HO RB 15-31st. Table fixed in the runner (ROLL_SPEC; listed months/bound): ${specTxt}. At most one roll per slot, at the session whose overnight gap |open/prev close - 1| is largest relative to the trailing-250 median gap of the same break type; a slot whose bound is after the last bar gets none. Every earlier price is multiplied by open/prev close of that session. Roll cost of 2 sides x (1 tick + $2.50) at each declared roll inside a holding window. Release = Friday 15:30 ET of T's week, moved to the next business day >= Monday only for a federal closure Wed-Fri (a Friday without a session — Good Friday — does not move it; entry is then the Monday session, as registered). Reports CFTC published late are not traded: as-of 2013-10-01..2013-11-05, 2018-12-24..2019-03-05, 2023-01-31..2023-03-14 (ION), 2025-09-30..2025-12-16. Universe = candidate roots with a >= ${MIN_YEARS}-year continuous front run (no gap > ${MAX_GAP_DAYS} days, >= ${100 * MIN_COVERAGE}% of reference sessions, ending >= ${CURRENT_FROM}) and >= ${MIN_YEARS} years of legacy COT spreading overlapping it; a root whose COT stops leaves the cross-section at that date (${token.roots.length}: ${token.roots.join(" ")}). CANNOT MEASURE if < 15 roots qualify. Calibration: whole-rule false pass <= 5% on each of deranged SP labels on the real path (deranged within each week's names, ${DERANGE_SEEDS}), the placebo family (${PLACEBO_FAMILY_REPS}), arithmetic-zero-drift scrambles (${FREE_SEEDS}) and a roll-leak family (${ROLL_LEAK_SEEDS}: the same scrambles with the real roll factors re-inserted and re-detected). Drift-kept scrambles (${KEPT_SEEDS}), the drift-kept floor, a gross placebo, a persistent-rank placebo and a leave-one-root-out t are reported beside the verdict. Rule, statistic, bar, placebo, halves and cost otherwise unchanged.`,
      why: `Schwab pricehistory serves only its continuous front series (probed 2026-10-03, cache sha256 ${sha.slice(0, 12)}): for every served root <M>27 returns closes identical to /ROOT and <M>24 returns no candles, so the registered construction qualifies ${regN} of ${ROOTS_ALL.length} roots and the registered read is CANNOT MEASURE. Audit of 2026-10-03 on the builder's front-series construction, repaired here: (a) the forced one-roll-per-calendar-month detector declared >= 84 false rolls/yr on 14 of 18 roots, erasing real overnight gaps (CL +11.46% on 2026-03-02) and over-charging roll cost (~0.011%/wk, ~0.17 t); the detected roll factors line up with SP (leaving 48% of them in moved t by +0.185, SE 0.018, across 100 paired no-edge worlds). The auditor's month-before-delivery table, checked against Schwab's gaps (price only), misses Schwab's other conventions (LE rolls in the last days of the month before the contract month in about half the years; HE rolled a month early in 2008-10; GC/HG/SI sometimes in the first days of the delivery month); last-trade-bounded slots cover them with the same count of declared rolls (one per listed contract) and leave fewer large gaps undeclared on the 15 non-energy roots (z >= 15: 170 vs 268 for the month table). No month table can fix the every-month energies (the lead example, CL +11.46% on 2026-03-02, is one): their slot is restricted to the days before the last trading day (CL 10-25th, NG HO RB 15-31st), so the largest weekend news gaps (CL 2020-03-09 -20.9%, 2022-03-07 +5.5%, 2023-04-03 +5.8%, 2026-03-02 +11.5%; HO/RB 2021-05-10) stay in the returns and the in-window roll-sized gap is removed. Roll-leak family, paired with the arithmetic-zero-drift scrambles: mean change in t ${RLP ? RLP.meanDeltaT : "n/a"} (SD ${RLP ? RLP.sdDeltaT : "n/a"}, SE ${RLP ? RLP.seDeltaT : "n/a"}), re-detected share of the real rolls ${RLP ? RLP.redetectedShareOfRealRolls : "n/a"}. Reported sensitivity: with half of the real roll factors forced to stay in the returns, t moves by ${token.rollLeakSensitivity ? token.rollLeakSensitivity.meanDeltaT : "n/a"} (SE ${token.rollLeakSensitivity ? token.rollLeakSensitivity.seDeltaT : "n/a"}) — the roll factors are anti-aligned with the SP book, so rolls the detector misses understate SP rather than flatter it. (b) CFTC published the as-of 2023-01-31..03-14 reports on 2023-02-24..03-21 (ION) and the runner traded them on their nominal Fridays. (c) CFTC does not delay the release for Monday or Tuesday holidays (2026 schedule; 2025 table: as-of 11-10 -> 11-14); 108 weeks entered a session late; Good Friday (CFTC publishes) also delayed entry a session. (d) The 2025 catch-up ended with the as-of 2025-12-16 report (CFTC table of 2025-12-09); as-of 12-23 was on the normal schedule. (e) ZO was dropped from all 18 years because its COT stops 2026-09-01. (f) Drift-free scrambles removed the log drift, leaving +sigma^2/2 a day against a book short the high-vol roots; derangements cut from a global permutation let 0.19% of name-weeks keep their own SP. Front-series universe ${dp.tokenQualifying.length} roots, ${token.weeks} weeks from ${token.evidenceStart}. Whole-rule false pass with the registered gates: deranged ${p1(F.derangedSignal.registered.wholeRuleFalsePass)}, placebo family ${p1(F.placeboFamily.registered.wholeRuleFalsePass)}, arithmetic-zero-drift ${p1(F.driftFree.registered.wholeRuleFalsePass)}, roll-leak ${p1(F.rollLeak.registered.wholeRuleFalsePass)} (drift-kept ${p1(F.driftKept.registered.wholeRuleFalsePass)}, reported; with the optional floor token every family <= 5%, drift-kept ${p1(F.driftKept.floor.wholeRuleFalsePass)}). Leak test ${token.leakTest.pass}, positive control t ${token.positiveControl.tNW}. Valid only for the runner that implements this text under the token below (RUNNER_GATES meaning updated, runner sha256 ${runnerSha.slice(0, 12)}) with the controls re-run.`,
      runnerGates: [TOKEN_CONSTRUCTION] } : null;
    writeJsonAtomic(CTRL, { spec: "r322-controls-v1", id: ID, asOf: new Date().toISOString(), runner: { file: `backend/${path.basename(__filename)}`, sha256: runnerSha },
      cache: { file: CACHE_REL, sha256: sha, fetchedAt: cache.fetchedAt }, selftest: st, bar, preReadDecision: decision, depth: depthOut(dp),
      registered: { qualifyingRoots: regN, verdictIfRead: regVerdict, note: "the registered read computes no statistic when < 15 roots qualify" }, token, ready, holdWhy,
      proposedAmendment, alternativeToken: token.evaluated ? { runnerGates: [TOKEN_CONSTRUCTION, TOKEN_FLOOR], meaning: RUNNER_GATES[TOKEN_FLOOR], calibratedFloor: token.calibration.calibratedFloor, readyFloorGates: token.readyFloorGates } : null,
      howToRecordTheDecision: { where: "backend/data/test-registry.json, the R322 entry: append proposedAmendment to amendments[] (create it) BEFORE the read, plus a dated change-registry entry; then re-run this controls mode", tokens: RUNNER_GATES },
      note: "The controls run summarises only scrambles, deranged-signal and placebo-family no-edge books and a look-ahead positive control; the real SP book on the real path is never computed." });
    console.log(ready ? `R322 READY — gate set in force: ${decision.construction}${decision.floor ? " + floor" : ""}${decision.construction === "registered" ? ` · the read will record: ${regVerdict}` : ""} · node backend/${path.basename(__filename)} --read` : `R322 NOT READY — ${holdWhy}`);
    if (token.evaluated) console.log(`  token ${TOKEN_CONSTRUCTION} (registered gates): ${token.readyRegisteredGates ? "READY if adopted by a pre-evidence amendment" : "NOT adoptable as is"} · with ${TOKEN_FLOOR}: ${token.readyFloorGates ? "READY if adopted" : "NOT adoptable"}`);
    return;
  }

  // ── THE READ (once) ──
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests && seals.tests[ID]) { console.error(`${ID} already sealed — refusing`); process.exit(2); }
  if (fs.existsSync(OUT) && JSON.parse(fs.readFileSync(OUT, "utf8")).read) { console.error(`${ID} already read — seal it, do not re-read`); process.exit(2); }
  if (!entry) { console.error(`${ID} not registered`); process.exit(2); }
  const today = new Date().toISOString().slice(0, 10); if (today < READABLE_FROM) { console.error(`${ID} not readable before ${READABLE_FROM} (window ends ${WINDOW_LAST_EXIT})`); process.exit(2); }
  if (!fin(bar)) { console.error(`${ID} registry entry has no numeric bar.tRequired`); process.exit(2); }
  const ctrl = fs.existsSync(CTRL) ? JSON.parse(fs.readFileSync(CTRL, "utf8")) : null;
  if (!ctrl || ctrl.spec !== "r322-controls-v1" || !ctrl.selftest || !ctrl.selftest.pass) { console.error(`${ID} no passing controls file — run the controls first`); process.exit(2); }
  if (!ctrl.runner || ctrl.runner.sha256 !== runnerSha) { console.error(`${ID} controls were produced by a different runner (${ctrl.runner && ctrl.runner.sha256} vs ${runnerSha}) — re-run the controls`); process.exit(2); }
  if (ctrl.bar !== bar) { console.error(`${ID} controls ran at bar ${ctrl.bar}, registry says ${bar} — re-run the controls`); process.exit(2); }
  const dec = preReadDecision(entry);
  if (!dec.decided) { console.error(`${ID} read HELD — ${dec.why}`); process.exit(2); }
  if (JSON.stringify(ctrl.preReadDecision && ctrl.preReadDecision.tokens) !== JSON.stringify(dec.tokens)) { console.error(`${ID} registry amendments changed since the controls run — re-run the controls`); process.exit(2); }
  if (!ctrl.ready) { console.error(`${ID} read HELD — controls not READY (${ctrl.holdWhy})`); process.exit(2); }
  // the registered read records CANNOT MEASURE permanently and blocks every later read: while the controls file carries a construction
  // amendment proposal the operator must choose explicitly (adopt it: registry amendments[] + controls re-run; or accept CANNOT MEASURE)
  if (dec.construction === "registered" && ctrl.proposedAmendment && !process.argv.includes("--accept-cannot-measure")) { console.error(`${ID} read HELD — a construction amendment is pending in the controls file; adopt it (registry amendments[] + controls re-run) or pass --accept-cannot-measure to record CANNOT MEASURE permanently`); process.exit(2); }
  const { cache, sha } = await loadOrFetch(false);
  if (!ctrl.cache || ctrl.cache.sha256 !== sha) { console.error(`${ID} cache sha256 ${sha} differs from the controls run's ${ctrl.cache && ctrl.cache.sha256} — refusing`); process.exit(2); }
  const dp = depthTable(cache), base = { id: ID, spec: "r322-read-v1", read: true, asOf: new Date().toISOString(), bar, barSource: "test-registry.json R322 bar.tRequired", preReadDecision: dec,
    cache: { file: CACHE_REL, sha256: sha }, controls: { file: `backend/data/${path.basename(CTRL)}`, asOf: ctrl.asOf }, depth: depthOut(dp) };
  let out;
  if (dec.construction === "registered") {
    const regN = dp.registeredQualifying.length;
    if (regN >= MIN_ROOTS) { console.error(`${ID} registered construction qualifies ${regN} roots but needs per-contract history this runner does not fetch — refusing (fail closed)`); process.exit(2); }
    const D0 = decide({ rootsQualifying: regN, meanNet: null, tNW: null, placeboP95: null, halfFirst: null, halfSecond: null, bar,
      cannotWhy: `${regN} of ${ROOTS_ALL.length} candidate roots have >= ${MIN_YEARS} years of continuous daily front/back history from the free sources (Schwab pricehistory serves only its continuous front series: contract-specific symbols return the identical front candles, expired contracts return none; CFTC COT carries no prices)` });
    out = { ...base, construction: "registered", unit: "weeks", n: 0, tNet: null, meanNet: null, winRatePct: null, placebo: null, halves: null, gates: D0.gates, failedGates: D0.failed, verdictScript: D0.verdictScript,
      reported: { note: "no statistic computed: the registered construction cannot be built from the registered free sources", tokenConstructionAvailable: ctrl.proposedAmendment ? { token: TOKEN_CONSTRUCTION, roots: dp.tokenQualifying.length, controlsReadyRegisteredGates: !!(ctrl.token && ctrl.token.readyRegisteredGates) } : null } };
  } else {
    const okCal = ctrl.token && ctrl.token.evaluated && (dec.floor ? ctrl.token.readyFloorGates : ctrl.token.readyRegisteredGates);
    if (!okCal) { console.error(`${ID} read HELD — the token construction is not READY for the gate set in force in the controls file`); process.exit(2); }
    const world = tokenWorld(cache, dp);
    if (world.skel.weeks.length !== ctrl.token.weeks || JSON.stringify(world.roots) !== JSON.stringify(ctrl.token.roots)) { console.error(`${ID} panel differs from the controls run — refusing`); process.exit(2); }
    const res = computeTokenRead({ world, bar, rootsQualifying: dp.tokenQualifying.length, floor: dec.floor ? ctrl.token.calibration.floor : null, floorReport: ctrl.token.calibration.floor });
    const cf = ctrl.token.calibration.families;
    out = { ...base, construction: "schwab-front-gap-ratio", gateSet: dec.floor ? "registered + drift-kept floor (pre-read amendment)" : "registered", roots: world.roots, evidenceStart: world.skel.evidenceStart, ...res,
      controlsSummary: { leakPass: ctrl.token.leakTest.pass, positiveT: ctrl.token.positiveControl.tNW, wholeRuleFalsePassRegisteredGates: Object.fromEntries(Object.entries(cf).map(([k, v]) => [k, v.registered.wholeRuleFalsePass])), wholeRuleFalsePassFloorGates: Object.fromEntries(Object.entries(cf).map(([k, v]) => [k, v.floor.wholeRuleFalsePass])) } };
  }
  writeJsonAtomic(OUT, out);
  console.log(`R322 READ — ${out.verdictScript} (construction ${out.construction}; bar t_NW >= ${bar})`);
  if (out.construction !== "registered") {
    console.log(`  weeks ${out.n} from ${out.evidenceStart} · net ${out.meanNetPctPerWeek}%/wk · t_NW ${out.tNet} · win ${out.winRatePct}% · placebo p95 ${out.placebo.p95PctPerWeek} ${out.placebo.beats ? "BEATEN" : "not beaten"} · halves ${out.halves.first.meanNetPctPerWeek}/${out.halves.second.meanNetPctPerWeek}`);
    console.log(`  gates ${JSON.stringify(out.gates)}`);
    const rp = out.reported;
    console.log(`  reported: gross ${rp.placeboGross.observedGrossPctPerWeek}%/wk vs gross placebo p95 ${rp.placeboGross.p95PctPerWeek} · persistent-rank placebo p95 ${rp.placeboPersistent.p95PctPerWeek} (net) ${rp.placeboPersistent.beats ? "BEATEN" : "not beaten"} · leave-one-root-out t ${rp.leaveOneRootOut.minTNW}..${rp.leaveOneRootOut.maxTNW}${rp.driftKeptFloor ? ` · drift-kept floor t ${rp.driftKeptFloor.tVsP50}` : ""}`);
  }
}
// Run only when invoked directly. A require() gets the pure functions and never reaches main: no fetch, no write.
if (require.main === module) main().catch((e) => { console.error("R322 FAILED:", e.message); process.exit(1); });
else module.exports = { selftest, decide, preReadDecision, nwT, summarise, releaseOf, isFederalClosure, inShutdown, fixedRollContinuous, detectRolls, ratioAdjust, depthTable, referenceCalendar, continuousRun,
  buildSeries, buildSkeleton, pathStats, terciles, runBook, placeboDist, persistentPlaceboDist, placeboFamilyReps, scramblePath, rollLeakPath, derangement, derangedScores, calibrate, floorGate, gapScores, rollDiagnostics, rollSlot, packFutures, packCot, schwabFuturesDate, barAtN, computeTokenRead,
  RUNNER_GATES, TOKEN_CONSTRUCTION, TOKEN_FLOOR, CANDIDATES, ROLL_SPEC, CACHE, MIN_ROOTS, fin };
