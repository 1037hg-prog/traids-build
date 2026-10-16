#!/usr/bin/env node
/**
 * R319 — BITCOIN / ETHER WEEKDAY: NYSE-HOURS vs CLOSED-HOURS RETURNS, out of sample from the 2024-04-05 claim (Thielen / 10x
 * Research; SSRN 4779488), registered 2026-10-03. The frozen spec is the R319 entry of data/test-registry.json (preregistered);
 * this runner implements that entry and nothing else. Harness pattern copied from r313-ibs-etfs.js: selftest -> controls run -> one --read.
 *
 *   DATA     Coinbase Exchange public candles BTC-USD and ETH-USD, granularity 900 (15 minutes: the coarsest Coinbase grid on which
 *            every NYSE boundary — 13:30/14:30 UTC open, 20:00/21:00 UTC close, 17:00/18:00 UTC early close — is a candle start; the
 *            1-hour candles cached by R306-R308 cannot carry the :30 open), 2024-04-01T00:00Z .. 2026-10-01T00:00Z exclusive, 300
 *            candles per request, no key. NYSE sessions (date, open, close incl. early closes) from Alpaca paper-api /v2/calendar
 *            (read-only GET, the house pattern of r180/r184), 2024-03-01..2026-10-09, converted ET -> UTC with America/New_York (DST).
 *            Fetched ONCE into one file under data/training/r319/; its sha256 is written into the controls file and the read, and the
 *            read never refetches and refuses on a mismatch. The calendar is cross-checked against the mine3 calendar cache (overlap)
 *            and an independent NYSE holiday / early-close list for the window.
 *   PRICE    price at a boundary T = the OPEN of the 15-minute candle starting exactly at T (the first trade at or after T — what an
 *            order sent at T fills against). No such candle -> that boundary is MISSING. Interior grid points (used only by the
 *            placebo and the scrambles) without a candle take the close of the latest earlier candle (last trade before T; counted).
 *   DAYS     each NYSE session d in 2024-04-08..2026-09-30 with previous session p: span = [close(p), close(d)] on the 15-minute grid;
 *            OFF = ln P(open d) - ln P(close p); ON = ln P(close d) - ln P(open d). A gap whose dates (p, d) enclose a Saturday or a
 *            Sunday is EXCLUDED (Fri->Mon, Thu->Mon after Good Friday / July 3, Fri->Tue around Monday holidays — the registered
 *            "Friday-close -> Monday-open spans are EXCLUDED"); a weekday-holiday gap (Wed->Fri over Thanksgiving) is weekday-to-weekday
 *            and INCLUDED with its longer OFF. Early-close days are sessions and are INCLUDED with their actual 13:00 ET close.
 *            Population = days with candles for BOTH coins at all three boundaries (close p, open d, close d); CANNOT MEASURE < 400.
 *   STAT     unit DAY; per coin the mean daily (OFF - ON) log return, plain one-sample t (sd n-1). Selected coin = the higher t (best
 *            of 2; BTC on a tie). Bar READ FROM THE REGISTRY (bar.tRequired).
 *   GATES    (registry decisionRule.pass, all on the selected coin) mean(OFF-ON) > 0, t >= bar, mean > placebo p95, both calendar
 *            halves (..2025-06-30 / 2025-07-01..) mean > 0, long-OFF-only net mean > 0 (per day exp(OFF) - 1 - 0.0030).
 *   PLACEBO  per day one OFF-length and one ON-length contiguous window, each placed uniformly and independently on the 15-minute grid
 *            inside that day's own span [close p, close d] (no window can touch a weekend); draw value = mean over days of
 *            R(OFF') - R(ON'); 1,000 draws, seed 319, identical placements for both coins; p95 = sorted[floor(0.95 * 1000)].
 *   CONTROLS (controls run — only scrambles are summarised; no real statistic is computed or written)
 *            leak test (boundaryLeakTest, repair 2026-10-03): the REAL calendar with SYNTHETIC prices — every day's boundary instants vs
 *            an independent US-DST rule, and +1% steps one quarter either side of each open / previous close must land entirely in the
 *            right window through buildPopulation + evaluate. The old "leak test" (drift-free permutations centred at t ~0) is kept as
 *            a null-centring PLUMBING check: it cannot fail on a boundary bug.
 *            positive control: a planted +1.00% per OFF window on drift-free scrambles passes the whole rule on >= 90% of 20 seeds;
 *            the outcome look-ahead subset (scrambled days with OFF > ON, t >= 3) is a plumbing check only.
 *            calibration: the WHOLE decision rule on 200 drift-kept + 100 drift-free within-span permutations + 100 within-span
 *            circular rotations + 400 sign flips + 400 sign flips with the real drift added back (one shuffle / sign per quarter shared
 *            by both coins, so their correlation is kept); READY only if every family false-passes <= 5% under the gate set in force.
 *            The first three fix each day's span total (t spread ~0.8-0.9); the sign-flip families do not (unconditional variance).
 *            REPORTED: power on the sign-flip family for three effect shapes (OFF-only, ON->OFF redistribution, ON-only — the last is
 *            invisible to the long-OFF cost gate at any size), drift sensitivity (uniform drift, no hours effect), and every gate set
 *            the runner can put in force (placebo p95 / p97.5 x higher-t coin / either coin).
 *   REPORTED AT THE READ, never gated (repair 2026-10-03): verdictReason (fails ONLY the cost gate = split measured, not tradeable
 *            long-only; vs a statistical gate failed), drift-neutral D per coin, short-during-NYSE-hours leg per coin.
 *
 *   node backend/r319-btc-nyse-hours.js --selftest | (no flag: controls run, prints READY / NOT READY) | --read
 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const ID = "R319", STEM = "r319-btc-nyse-hours", READ = process.argv.includes("--read"), SELFTEST_ONLY = process.argv.includes("--selftest");
const OUT = D(`${STEM}.json`), CTRL = D(`${STEM}-controls.json`);
const CACHE_NAME = "cb15m-btc-eth-nyse-calendar-20240401-20261001.json";
const CACHE_DIR = path.join(__dirname, "data", "training", "r319"), CACHE = path.join(CACHE_DIR, CACHE_NAME), CACHE_REL = `backend/data/training/r319/${CACHE_NAME}`;
const MINE3_CAL = path.join(__dirname, "data", "training", "mine3", "calendar-2015-12-01-2026-09-25.json");
const COINS = ["BTC-USD", "ETH-USD"], Q = 900000, GRAN = 900;
const FETCH_FROM_MS = Date.UTC(2024, 3, 1), FETCH_TO_MS = Date.UTC(2026, 9, 1);      // [2024-04-01T00:00Z, 2026-10-01T00:00Z)
const CAL_START = "2024-03-01", CAL_END = "2026-10-09";
const WINDOW_FROM = "2024-04-08", WINDOW_TO = "2026-09-30", HALF1_TO = "2025-06-30", READABLE_FROM_ET = "2026-10-01";
const COST = 0.003, REPORTED_COSTS = [0, 0.001, 0.002, 0.003, 0.005], MIN_DAYS = 400, PLACEBO_DRAWS = 1000, PLACEBO_SEED = 319;
const KEPT_SEEDS = 200, FREE_SEEDS = 100, ROT_SEEDS = 100, FLIP_SEEDS = 400, FLIPDRIFT_SEEDS = 400, POS_SEEDS = 20, POS_PLANT = 0.01, POS_MIN_PASS = 0.9, POS_LOOKAHEAD_T = 3;
const LEAK_MEAN_T_MAX = 0.35, LEAK_BEST_SHARE_MAX = 0.10, MAX_WHOLE_RULE_FALSE_PASS = 0.05;
const MODE_SALT = { kept: 11, free: 23, rot: 37, flip: 53, flipDrift: 71 };
// the no-edge calibration families (repair 2026-10-03: flip / flipDrift added — they do NOT fix each day's span total, so their null
// variance is the unconditional one; kept / free / rot condition on the day total and understate the spread of t by ~10-20%)
const FAMILIES = [["kept", KEPT_SEEDS], ["free", FREE_SEEDS], ["rot", ROT_SEEDS], ["flip", FLIP_SEEDS], ["flipDrift", FLIPDRIFT_SEEDS]];
// power (REPORTED only): planted hours effects on the unconditional sign-flip family, three shapes. offX = added per OFF window,
// onX = added per ON window (spread evenly over its quarters). redistribute keeps the day total; onOnly is a split long-OFF never touches.
const POWER_SEEDS = 40;
const POWER_FORMS = [["offOnly", 0.002, 0], ["offOnly", 0.003, 0], ["offOnly", 0.004, 0], ["offOnly", 0.006, 0], ["redistribute", 0.002, -0.002], ["redistribute", 0.003, -0.003],
  ["redistribute", 0.004, -0.004], ["onOnly", 0, -0.006], ["onOnly", 0, -0.010]];
// drift sensitivity (REPORTED only): NO hours effect, a uniform drift per 15-minute quarter on the sign-flip family — every PASS is false
const DRIFT_PLANTS = [1e-5, 3e-5, 5e-5];
// NYSE weekday non-sessions and early closes inside 2024-04-08..2026-09-30 — an independent reference the fetched calendar must match
const REF_HOLIDAYS = ["2024-05-27", "2024-06-19", "2024-07-04", "2024-09-02", "2024-11-28", "2024-12-25", "2025-01-01", "2025-01-09", "2025-01-20", "2025-02-17", "2025-04-18",
  "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07"];
const REF_EARLY = ["2024-07-03", "2024-11-29", "2024-12-24", "2025-07-03", "2025-11-28", "2025-12-24"];
const CFG = { from: WINDOW_FROM, to: WINDOW_TO, half1To: HALF1_TO, minDays: MIN_DAYS, cost: COST, draws: PLACEBO_DRAWS, seed: PLACEBO_SEED };
// Pre-read decision tokens this runner honours (registry R319 entry: amendments[] { date, preEvidence: true, field, was, becomes, why,
// runnerGates }). No amendment -> the registered gates. Unknown / malformed / not preEvidence -> the read is refused (fail closed).
// The controls run calibrates the gate set IN FORCE (and reports the other); a changed token set needs a fresh controls run.
const RUNNER_GATES = {
  registered: "the registered decisionRule.pass as written (placebo gate: observed mean(OFF-ON) > placebo p95 of 1,000 draws)",
  "placebo:p975": "placebo gate = observed mean(OFF-ON) > the placebo p97.5 (sorted[floor(0.975 * draws)]) instead of p95; p95 still reported; every other gate unchanged",
  "variants:either": "PASS if ANY coin clears every gate, each judged on its own numbers (its own t must clear the best-of-2 bar); the higher-t-coin reading is reported beside it; every gate unchanged",
};
const fin = Number.isFinite;
const r4 = (x) => (x == null || !fin(x) ? null : +x.toFixed(4)), r3 = (x) => (x == null || !fin(x) ? null : +x.toFixed(3)), r1 = (x) => (x == null || !fin(x) ? null : +x.toFixed(1));
const pct = (x, k = 4) => (x == null || !fin(x) ? null : +(100 * x).toFixed(k));
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const iso = (ms) => new Date(ms).toISOString();

// ── time: ET <-> UTC, weekdays ───────────────────────────────────────────────────────────────────────────────────────────
const NYF = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function nyParts(ms) { const p = Object.fromEntries(NYF.formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, min: (+p.hour % 24) * 60 + +p.minute }; }
const todayET = () => nyParts(Date.now()).date;
const hhmm = (s) => { const m = /^(\d{2}):(\d{2})$/.exec(String(s)); if (!m) throw new Error(`bad HH:MM "${s}"`); return +m[1] * 60 + +m[2]; };
// the UTC instant of ET wall time (date, minutes) — exactly one of EDT (-4 h) / EST (-5 h) round-trips; anything else throws
function etToUtcMs(date, min) {
  const base = Date.parse(`${date}T00:00:00Z`) + min * 60000;
  const hits = [240, 300].map((off) => base + off * 60000).filter((ms) => { const p = nyParts(ms); return p.date === date && p.min === min; });
  if (hits.length !== 1) throw new Error(`ET ${date} ${min} min maps to ${hits.length} UTC instants`);
  return hits[0];
}
const dow = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
const isWeekendDate = (d) => { const g = dow(d); return g === 0 || g === 6; };
const addDays = (d, k) => new Date(Date.parse(`${d}T12:00:00Z`) + k * 864e5).toISOString().slice(0, 10);
function enclosesWeekend(p, d) { for (let x = addDays(p, 1); x < d; x = addDays(x, 1)) if (isWeekendDate(x)) return true; return false; }

// ── calendar -> session days ─────────────────────────────────────────────────────────────────────────────────────────────
function normalizeSessions(raw) {
  const out = []; let prev = "";
  for (const x of raw) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(x.date)) throw new Error(`bad session date ${x.date}`);
    if (x.date <= prev) throw new Error(`sessions not strictly increasing at ${x.date}`);
    if (isWeekendDate(x.date)) throw new Error(`weekend session ${x.date}`);
    prev = x.date;
    const openMin = hhmm(x.open), closeMin = hhmm(x.close);
    if (!(openMin < closeMin)) throw new Error(`session ${x.date} open >= close`);
    out.push({ date: x.date, openMin, closeMin, openMs: etToUtcMs(x.date, openMin), closeMs: etToUtcMs(x.date, closeMin) });
  }
  return out;
}
function buildDays(sessions, { from = WINDOW_FROM, to = WINDOW_TO } = {}) {
  const days = [], excluded = { weekendGap: [], noPrevSession: [] };
  for (let i = 0; i < sessions.length; i++) {
    const cur = sessions[i]; if (cur.date < from || cur.date > to) continue;
    if (i === 0) { excluded.noPrevSession.push(cur.date); continue; }
    const prev = sessions[i - 1];
    if (enclosesWeekend(prev.date, cur.date)) { excluded.weekendGap.push(cur.date); continue; }
    const t0 = prev.closeMs, N = (cur.closeMs - t0) / Q, kOpen = (cur.openMs - t0) / Q;
    if (!Number.isInteger(N) || !Number.isInteger(kOpen) || kOpen <= 0 || kOpen >= N) throw new Error(`session ${cur.date}: span not on the 15-minute grid (N ${N}, kOpen ${kOpen})`);
    days.push({ date: cur.date, prevDate: prev.date, t0, tOpen: cur.openMs, tClose: cur.closeMs, N, kOpen, early: cur.closeMin !== 960, prevEarly: prev.closeMin !== 960,
      gapDays: Math.round((Date.parse(cur.date) - Date.parse(prev.date)) / 864e5) });
  }
  return { days, excluded };
}

// ── candles -> span log prices ───────────────────────────────────────────────────────────────────────────────────────────
// Coinbase row [time s, low, high, open, close, volume] -> [ms, o, h, l, c, v]
const cbRow = (c) => [c[0] * 1000, c[3], c[2], c[1], c[4], c[5]];
function packRows(product, rawMap) {
  const rows = [...rawMap.values()].sort((a, b) => a[0] - b[0]), flags = { highBelowLow: 0, openOutsideRange: 0, closeOutsideRange: 0 };
  let prev = -Infinity;
  for (const r of rows) {
    if (r[0] % Q !== 0) throw new Error(`${product}: candle at ${iso(r[0])} is off the 15-minute grid`);
    if (!(r[0] > prev)) throw new Error(`${product}: candle times not strictly increasing at ${iso(r[0])}`);
    if (![r[1], r[2], r[3], r[4]].every((x) => fin(x) && x > 0)) throw new Error(`${product}: non-finite or non-positive price at ${iso(r[0])}`);
    if (r[0] < FETCH_FROM_MS || r[0] >= FETCH_TO_MS) throw new Error(`${product}: candle ${iso(r[0])} outside the fetch window`);
    prev = r[0];
    if (r[2] < r[3]) flags.highBelowLow++; if (r[1] > r[2] || r[1] < r[3]) flags.openOutsideRange++; if (r[4] > r[2] || r[4] < r[3]) flags.closeOutsideRange++;
  }
  return { rows, flags };
}
function indexRows(rows) { const m = new Map(); for (const r of rows) m.set(r[0], r); return m; }
// conv "open" (REGISTERED reading): price at T = open of the candle starting at T. conv "closeBefore" (REPORTED sensitivity): price at T
// = close of the candle starting at T - Q (the last trade before T). Missing -> null.
function priceAt(idx, T, conv) { const c = idx.get(conv === "closeBefore" ? T - Q : T); return c ? (conv === "closeBefore" ? c[4] : c[1]) : null; }
function spanLogPrices(day, idx, conv = "open") {
  const n = day.N, at = [[0, "prevClose"], [day.kOpen, "open"], [n, "close"]], missing = at.filter(([j]) => priceAt(idx, day.t0 + j * Q, conv) == null).map(([, k]) => k);
  if (missing.length) return { ok: false, missingBoundaries: missing };
  const lp = new Float64Array(n + 1); let stale = 0;
  for (let j = 0; j <= n; j++) {
    const T = day.t0 + j * Q, p = priceAt(idx, T, conv);
    if (p != null) { lp[j] = Math.log(p); continue; }
    // last trade before T: the close of the latest candle starting before T (and before T - Q under closeBefore); the j = 0 boundary
    // candle exists, so the walk ends inside the span
    let k = conv === "closeBefore" ? T - 2 * Q : T - Q; while (!idx.has(k)) k -= Q;
    lp[j] = Math.log(idx.get(k)[4]); stale++;
  }
  return { ok: true, lp, stale };
}
function buildPopulation(calSessions, candles, { conv = "open", from = WINDOW_FROM, to = WINDOW_TO } = {}) {
  const sessions = normalizeSessions(calSessions), { days, excluded } = buildDays(sessions, { from, to });
  const idx = Object.fromEntries(COINS.map((c) => [c, indexRows(candles[c] || [])]));
  const pop = { days: [], R: Object.fromEntries(COINS.map((c) => [c, []])) }, missingBoundaryDays = [], staleInterior = Object.fromEntries(COINS.map((c) => [c, 0]));
  for (const dy of days) {
    const sp = COINS.map((c) => spanLogPrices(dy, idx[c], conv));
    if (sp.some((s) => !s.ok)) { missingBoundaryDays.push({ date: dy.date, missing: Object.fromEntries(COINS.map((c, i) => [c, sp[i].ok ? [] : sp[i].missingBoundaries])) }); continue; }
    pop.days.push(dy);
    COINS.forEach((c, i) => { const lp = sp[i].lp, r = new Float64Array(dy.N); for (let j = 0; j < dy.N; j++) r[j] = lp[j + 1] - lp[j]; pop.R[c].push(r); staleInterior[c] += sp[i].stale; });
  }
  const sessionDaysInWindow = sessions.filter((s) => s.date >= from && s.date <= to).length;
  return { pop, sessions, days, excluded, missingBoundaryDays, staleInterior, sessionDaysInWindow, idx };
}

// ── statistics ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const mean = (a) => { let s = 0; for (const x of a) s += x; return s / a.length; };
function sdOf(a) { const n = a.length; if (n < 2) return null; const m = mean(a); let v = 0; for (const x of a) v += (x - m) ** 2; return Math.sqrt(v / (n - 1)); }
function tStat(a) { const n = a.length; if (n < 2) return null; const s = sdOf(a); return s > 0 ? mean(a) / (s / Math.sqrt(n)) : null; }
// Newey-West lag 1 (Bartlett 0.5), REPORTED only (R310/R313 nwT)
function nwT(a) { const n = a.length; if (n < 3) return null; const m = mean(a), d = Array.from(a, (x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n, c = 0; for (let i = 1; i < n; i++) c += d[i] * d[i - 1]; v += c / n; return v > 0 ? m / Math.sqrt(v / n) : null; }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function nearestRank(sorted, q) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] : null; }
function dayVals(pop, R, coin) {
  const n = pop.days.length, off = new Float64Array(n), on = new Float64Array(n);
  for (let i = 0; i < n; i++) { const r = R[coin][i], k = pop.days[i].kOpen; let a = 0, b = 0; for (let j = 0; j < k; j++) a += r[j]; for (let j = k; j < r.length; j++) b += r[j]; off[i] = a; on[i] = b; }
  return { off, on };
}
function coinSummary(pop, off, on, cfg = CFG) {
  const n = off.length, d = Array.from(off, (x, i) => x - on[i]), h1 = [], h2 = [];
  pop.days.forEach((dy, i) => (dy.date <= cfg.half1To ? h1 : h2).push(d[i]));
  const longOffNet = n ? mean(Array.from(off, (x) => Math.exp(x) - 1 - cfg.cost)) : null;
  // REPORTED ONLY, never gated (repair 2026-10-03): D is OFF - ON over windows of unequal length (70 vs 26 quarters on a normal day),
  // so with NO hours effect E[D | day total S] = (2K/N - 1) S — drift leaks into D. dAdj removes that expectation:
  // dAdj = D - (2K/N - 1)(OFF + ON) = 2K(N-K)/N x (OFF/K - ON/(N-K)), mean 0 under no hours effect for ANY drift.
  const dAdj = pop.days.every((dy) => fin(dy.N) && fin(dy.kOpen)) ? Array.from(off, (x, i) => driftNeutralOf(x, on[i], pop.days[i].kOpen, pop.days[i].N)) : null;
  return { n, mean: n ? mean(d) : null, t: tStat(d), halfFirst: h1.length ? mean(h1) : null, halfSecond: h2.length ? mean(h2) : null, nFirst: h1.length, nSecond: h2.length, longOffNet,
    driftNeutralMean: dAdj && n ? mean(dAdj) : null, driftNeutralT: dAdj ? tStat(dAdj) : null, _d: d, _dAdj: dAdj };
}
function driftNeutralOf(off, on, K, N) { return (off - on) - (2 * K / N - 1) * (off + on); }
// THE PLACEBO (registered): per day an OFF-length window (start a in [0, N-K]) and an ON-length window (start b in [0, K]) inside the
// day's own span, drawn uniformly and independently; draw value = mean over days of R(OFF') - R(ON'). Placements depend only on
// (N, K, seed), so both coins see identical placements.
function cumsOf(pop, R, coin) { return pop.days.map((dy, i) => { const r = R[coin][i], c = new Float64Array(dy.N + 1); for (let j = 0; j < dy.N; j++) c[j + 1] = c[j] + r[j]; return c; }); }
function placeboRun(pop, R, coin, { draws = PLACEBO_DRAWS, seed = PLACEBO_SEED, record = null } = {}) {
  const n = pop.days.length; if (!n) return null;
  const cums = cumsOf(pop, R, coin), Ns = Int32Array.from(pop.days, (x) => x.N), Ks = Int32Array.from(pop.days, (x) => x.kOpen), rng = mulberry(seed), st = new Float64Array(draws);
  for (let k = 0; k < draws; k++) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const N = Ns[i], K = Ks[i], c = cums[i], a = Math.floor(rng() * (N - K + 1)), b = Math.floor(rng() * (K + 1)), v = (c[a + K] - c[a]) - (c[b + N - K] - c[b]);
      s += v; if (record) record(k, i, a, b, v);
    }
    st[k] = s / n;
  }
  const sorted = Array.from(st).sort((x, y) => x - y), at = (q) => sorted[Math.min(draws - 1, Math.floor(q * draws))];
  return { draws, seed, p95: at(0.95), p975: at(0.975), p50: at(0.5), p05: at(0.05), meanOfDraws: mean(sorted) };
}
function evaluate(pop, R, { cfg = CFG, withPlacebo = true } = {}) {
  const E = {};
  for (const c of COINS) { const { off, on } = dayVals(pop, R, c), s = coinSummary(pop, off, on, cfg); E[c] = { ...s, placebo: withPlacebo ? placeboRun(pop, R, c, { draws: cfg.draws, seed: cfg.seed }) : null, _off: off, _on: on }; }
  return E;
}

// ── THE DECISION RULE (registry decisionRule.pass / cannotMeasure), one pure function for the calibration and the read ────
function selectCoin(E) { let best = null; for (const c of COINS) { const t = E[c] && E[c].t; if (t == null || !fin(t)) continue; if (best === null || t > E[best].t) best = c; } return best || COINS[0]; }
function gatesFor(s, nDays, bar, q, minDays = MIN_DAYS) {
  const pl = s && s.placebo ? (q === "p975" ? s.placebo.p975 : s.placebo.p95) : null;
  return { sessionDaysAtLeast400: nDays >= minDays, meanPositive: s.mean != null && s.mean > 0, tAtLeastBar: s.t != null && s.t >= bar, placeboBeaten: s.mean != null && pl != null && s.mean > pl,
    bothHalvesPositive: s.halfFirst != null && s.halfSecond != null && s.halfFirst > 0 && s.halfSecond > 0, longOffNetPositive: s.longOffNet != null && s.longOffNet > 0 };
}
// either = false (REGISTERED reading): every gate on the higher-t coin. either = true (token variants:either, only via a pre-evidence
// amendment): PASS if any coin clears every gate on its own numbers; the reading coin is then the higher-t coin among those clearing.
function decide(E, nDays, bar, q = "p95", minDays = MIN_DAYS, either = false) {
  const selected = selectCoin(E), clearing = COINS.filter((c) => E[c] && Object.values(gatesFor(E[c], nDays, bar, q, minDays)).every(Boolean));
  const reading = either && clearing.length && !clearing.includes(selected) ? clearing.reduce((b, c) => (b == null || (E[c].t != null && E[c].t > E[b].t) ? c : b), null) : selected;
  const gates = gatesFor(E[reading], nDays, bar, q, minDays), failed = Object.keys(gates).filter((k) => !gates[k]);
  const verdictScript = !gates.sessionDaysAtLeast400 ? `CANNOT MEASURE — ${nDays} session days have both coins' candles at all three boundaries (< ${minDays})` : failed.length ? "DID NOT PASS" : "PASS";
  return { selected: reading, higherTCoin: selected, either: !!either, gates, failed, verdictScript, anyVariantPass: clearing.length > 0, coinsClearingAllGates: clearing };
}
// REPORTED ONLY, never gated (repair 2026-10-03): says WHY a DID NOT PASS failed, so "split measured but not tradeable long-only" is
// not read as "no split". The registered fail text ("the NYSE-hours split is not a tradeable effect") covers both.
const STAT_GATES = ["meanPositive", "tAtLeastBar", "placeboBeaten", "bothHalvesPositive"];
function verdictReasonOf(J) {
  if (!J || !J.gates || !J.gates.sessionDaysAtLeast400) return null;
  if (!J.failed.length) return "every gate clears";
  if (J.failed.length === 1 && J.failed[0] === "longOffNetPositive") return "every statistical gate clears; fails ONLY the absolute long-OFF tradeability gate at 0.30% RT: the NYSE-hours split is measured, not tradeable long-only";
  return `failed: ${J.failed.join(", ")}${STAT_GATES.every((g) => !J.failed.includes(g)) ? "" : " (a statistical gate failed: the split itself is not established)"}`;
}
// gate sets the controls calibrate: placebo quantile x either-coin
const gateKey = (q, either) => `${q}${either ? "+either" : ""}`;
const GATE_KEYS = [["p95", false], ["p975", false], ["p95", true], ["p975", true]];
function preReadDecision(entry) {
  const am = (entry && Array.isArray(entry.amendments) ? entry.amendments : []).filter((a) => a && Array.isArray(a.runnerGates));
  if (!am.length) return { decided: true, amended: false, tokens: ["registered"], q: "p95", either: false, meaning: [`registered: ${RUNNER_GATES.registered}`] };
  if (am.some((a) => a.preEvidence !== true)) return { decided: false, why: "a runnerGates amendment is not marked preEvidence: true" };
  const tokens = [...new Set(am.flatMap((a) => a.runnerGates))].sort(), unknown = tokens.filter((g) => !Object.prototype.hasOwnProperty.call(RUNNER_GATES, g));
  if (!tokens.length) return { decided: false, why: "a runnerGates amendment lists no token" };
  if (unknown.length) return { decided: false, why: `unknown runnerGates ${JSON.stringify(unknown)} — this runner defines only ${JSON.stringify(Object.keys(RUNNER_GATES))}` };
  if (tokens.includes("registered") && tokens.length > 1) return { decided: false, why: "'registered' cannot be combined with another token" };
  const q = tokens.includes("placebo:p975") ? "p975" : "p95", either = tokens.includes("variants:either");
  return { decided: true, amended: q !== "p95" || either, tokens, q, either, dates: am.map((a) => a.date || null), meaning: tokens.map((g) => `${g}: ${RUNNER_GATES[g]}`) };
}

// ── no-edge scrambles (controls run only) ────────────────────────────────────────────────────────────────────────────────
// kept: shuffle the 15-minute log returns within each day's span (span total kept; drift kept); free: the same after subtracting each
// coin's mean 15-minute return over the population (drift-free); rot: rotate each span circularly by a random offset (keeps the
// within-day autocorrelation). One permutation / offset per day, shared by both coins.
// flip (repair 2026-10-03): every 15-minute return times an independent random sign, one sign per quarter shared by both coins — zero
// mean, the real volatility structure (incl. the NYSE-hours vol profile and the BTC/ETH correlation), day totals NOT fixed, so its null
// variance of mean(D) is the unconditional one. flipDrift: the same plus each coin's real mean 15-minute return added back to every
// quarter (real drift, no hours effect).
function scrambleR(pop, R0, seed, mode) {
  if (!Object.prototype.hasOwnProperty.call(MODE_SALT, mode)) throw new Error(`unknown scramble mode ${mode}`);
  const rng = mulberry(seed * 1000003 + MODE_SALT[mode]), mu = {}, out = {};
  for (const c of COINS) { out[c] = []; mu[c] = 0; if (mode === "free" || mode === "flipDrift") { let s = 0, n = 0; for (const r of R0[c]) { for (let j = 0; j < r.length; j++) s += r[j]; n += r.length; } mu[c] = s / n; } }
  for (let i = 0; i < pop.days.length; i++) {
    const N = pop.days[i].N, perm = new Int32Array(N);
    if (mode === "flip" || mode === "flipDrift") {
      const e = new Int8Array(N); for (let j = 0; j < N; j++) e[j] = rng() < 0.5 ? -1 : 1;
      for (const c of COINS) { const r = R0[c][i], o = new Float64Array(N), add = mode === "flipDrift" ? mu[c] : 0; for (let j = 0; j < N; j++) o[j] = r[j] * e[j] + add; out[c].push(o); }
      continue;
    }
    if (mode === "rot") { const k = Math.floor(rng() * N); for (let j = 0; j < N; j++) perm[j] = (j + k) % N; }
    else { for (let j = 0; j < N; j++) perm[j] = j; for (let j = N - 1; j > 0; j--) { const q = Math.floor(rng() * (j + 1)), t = perm[j]; perm[j] = perm[q]; perm[q] = t; } }
    for (const c of COINS) { const r = R0[c][i], o = new Float64Array(N); for (let j = 0; j < N; j++) o[j] = r[perm[j]] - mu[c]; out[c].push(o); }
  }
  return out;
}
// planted edge: + x per OFF window (x / K on each OFF quarter), ON untouched
function plantOff(pop, R, x) { return plantForm(pop, R, x, 0); }
// planted hours effect (repair 2026-10-03): + offX per OFF window (offX / K per OFF quarter) and + onX per ON window (onX / (N-K) per ON quarter)
function plantForm(pop, R, offX, onX) {
  const out = {};
  for (const c of COINS) out[c] = R[c].map((r, i) => { const K = pop.days[i].kOpen, N = r.length, o = Float64Array.from(r); for (let j = 0; j < K; j++) o[j] += offX / K; if (onX) for (let j = K; j < N; j++) o[j] += onX / (N - K); return o; });
  return out;
}
// NO hours effect: + mu on every 15-minute quarter (a uniform drift)
function plantDrift(R, mu) { const out = {}; for (const c of COINS) out[c] = R[c].map((r) => Float64Array.from(r, (x) => x + mu)); return out; }
function slimEval(E) { return Object.fromEntries(COINS.map((c) => [c, { mean: E[c].mean, t: E[c].t, halfFirst: E[c].halfFirst, halfSecond: E[c].halfSecond, longOffNet: E[c].longOffNet, driftNeutralT: E[c].driftNeutralT, placebo: E[c].placebo ? { p95: E[c].placebo.p95, p975: E[c].placebo.p975, p50: E[c].placebo.p50 } : null }])); }
// one calibration row: the slim per-coin numbers and the decision under every gate set the runner can put in force
function rowOf(seed, E, nDays, bar, minDays = MIN_DAYS) {
  const J = Object.fromEntries(GATE_KEYS.map(([q, ei]) => [gateKey(q, ei), decide(E, nDays, bar, q, minDays, ei)]));
  return { seed, E: E[COINS[0]] && E[COINS[0]]._d ? slimEval(E) : E, J, reg: J.p95, alt: J.p975 };
}
function runFamilyRow(pop, R, seed, bar, cfg = CFG) { return rowOf(seed, evaluate(pop, R, { cfg }), pop.days.length, bar, cfg.minDays); }
const srt = (a) => a.filter(fin).sort((x, y) => x - y);
function distOf(a, k = (x) => x) { const s = srt(a); if (!s.length) return null; const m = mean(s), sd = sdOf(s); return { n: s.length, min: k(s[0]), p05: k(nearestRank(s, 0.05)), p50: k(nearestRank(s, 0.5)), p95: k(nearestRank(s, 0.95)), max: k(s[s.length - 1]), mean: k(m), sd: sd == null ? null : k(sd) }; }
// key: a gate-set key ("p95", "p975", "p95+either", "p975+either"); the bare quantile names keep their old meaning
function familyStats(rows, key) {
  const J = rows.map((r) => r.J[key]), share = (f) => (J.length ? J.filter(f).length / J.length : null);
  const gateNames = J.length ? Object.keys(J[0].gates).filter((g) => g !== "sessionDaysAtLeast400") : [];
  const all = (x, names) => names.every((g) => x.gates[g]);
  return { seeds: rows.length, gateSet: key, q: key.split("+")[0], either: key.endsWith("+either"), passes: J.filter((x) => x.verdictScript === "PASS").length, wholeRuleFalsePass: share((x) => x.verdictScript === "PASS"),
    anyVariantFalsePass: share((x) => x.anyVariantPass && x.gates.sessionDaysAtLeast400), perGate: Object.fromEntries(gateNames.map((g) => [g, share((x) => x.gates[g])])),
    gateSets: { tOnly: share((x) => all(x, ["meanPositive", "tAtLeastBar"])), tAndPlacebo: share((x) => all(x, ["meanPositive", "tAtLeastBar", "placeboBeaten"])),
      tPlaceboHalves: share((x) => all(x, ["meanPositive", "tAtLeastBar", "placeboBeaten", "bothHalvesPositive"])), withoutCostGate: share((x) => all(x, gateNames.filter((g) => g !== "longOffNetPositive"))) },
    failsOnlyCostGate: share((x) => x.failed.length === 1 && x.failed[0] === "longOffNetPositive"),
    selectedBTCShare: share((x) => x.selected === "BTC-USD") };
}
function familyDists(rows) {
  const sel = (r) => r.E[r.reg.selected];
  return { bestT: distOf(rows.map((r) => sel(r).t), r3), tBTC: distOf(rows.map((r) => r.E["BTC-USD"].t), r3), tETH: distOf(rows.map((r) => r.E["ETH-USD"].t), r3),
    driftNeutralTBTC: distOf(rows.map((r) => r.E["BTC-USD"].driftNeutralT), r3), driftNeutralTETH: distOf(rows.map((r) => r.E["ETH-USD"].driftNeutralT), r3),
    selectedMeanPctPerDay: distOf(rows.map((r) => sel(r).mean), (x) => pct(x)), selectedPlaceboP95PctPerDay: distOf(rows.map((r) => sel(r).placebo && sel(r).placebo.p95), (x) => pct(x)),
    selectedMeanMinusPlaceboP95PctPerDay: distOf(rows.map((r) => (sel(r).placebo ? sel(r).mean - sel(r).placebo.p95 : NaN)), (x) => pct(x)),
    selectedLongOffNetPctPerDay: distOf(rows.map((r) => sel(r).longOffNet), (x) => pct(x)) };
}
function calibrate(fam, bar, q, expected = Object.fromEntries(FAMILIES), either = false) {
  const families = {}, inForceKey = gateKey(q, either);
  for (const [k, rows] of Object.entries(fam)) families[k] = { inForce: familyStats(rows, inForceKey), registeredP95: familyStats(rows, "p95"), placeboP975: familyStats(rows, "p975"),
    eitherP95: familyStats(rows, "p95+either"), eitherP975: familyStats(rows, "p975+either"), distributions: familyDists(rows) };
  const ok = Object.entries(expected).every(([k, n]) => fam[k] && fam[k].length === n && fam[k].every((r) => COINS.every((c) => fin(r.E[c].t) && fin(r.E[c].mean) && r.E[c].placebo && fin(r.E[c].placebo.p95))));
  const fpMax = (key) => Math.max(...Object.keys(expected).map((k) => families[k][key].wholeRuleFalsePass));
  const calibrated = ok && fpMax("inForce") <= MAX_WHOLE_RULE_FALSE_PASS;
  return { ok, bar, q, either: !!either, gateSet: inForceKey, calibrated, limit: MAX_WHOLE_RULE_FALSE_PASS, maxWholeRuleFalsePassInForce: fpMax("inForce"), maxWholeRuleFalsePassRegisteredP95: fpMax("registeredP95"),
    maxWholeRuleFalsePassP975: fpMax("placeboP975"), maxWholeRuleFalsePassEitherP95: fpMax("eitherP95"), maxWholeRuleFalsePassEitherP975: fpMax("eitherP975"),
    p975Calibrated: ok && fpMax("placeboP975") <= MAX_WHOLE_RULE_FALSE_PASS, eitherCalibrated: ok && fpMax("eitherP95") <= MAX_WHOLE_RULE_FALSE_PASS, families,
    note: "scrambles only — no hours edge by construction; every PASS rate below is a FALSE-pass rate. READY needs every family <= limit under the gate set in force. kept / free / rot fix each day's span total (their t spread is ~0.8-0.9, flattering); flip / flipDrift do not (unconditional variance; flipDrift carries the real drift)." };
}
// PLUMBING CHECK, not a leak test (relabelled 2026-10-03): drift-free within-span permutations have mean t ~0 by construction for any
// boundary timing, so this cannot fail on a boundary bug. The leak test is boundaryLeakTest below.
function leakTestOf(freeRows, bar) {
  const meanT = Object.fromEntries(COINS.map((c) => [c, mean(freeRows.map((r) => r.E[c].t))])), best = freeRows.map((r) => Math.max(...COINS.map((c) => r.E[c].t)));
  const bestShare = best.filter((t) => t >= bar).length / best.length;
  const pass = COINS.every((c) => fin(meanT[c]) && Math.abs(meanT[c]) <= LEAK_MEAN_T_MAX) && bestShare <= LEAK_BEST_SHARE_MAX;
  return { method: `drift-free within-span permutation family (${freeRows.length} seeds, one permutation per day shared by both coins), the rule unchanged`,
    label: "PLUMBING CHECK (null centring of the scramble path) — cannot detect a boundary-timing bug; the leak test is boundaryLeakTest",
    requirement: `per-coin mean t within +-${LEAK_MEAN_T_MAX} AND best-of-2 t >= bar (${bar}) on <= ${100 * LEAK_BEST_SHARE_MAX}% of seeds`, pass,
    meanT: Object.fromEntries(Object.entries(meanT).map(([k, v]) => [k, r3(v)])), bestOf2AtLeastBarShare: r3(bestShare), seed1BestT: r3(best[0]), seed2BestT: r3(best[1]) };
}
// THE LEAK TEST (repair 2026-10-03): the REAL calendar with SYNTHETIC prices (no real candle is read). (1) Every population day's three
// boundary instants are recomputed by an independent US-DST rule (2nd Sunday of March .. 1st Sunday of November; EDT open 13:30Z /
// EST 14:30Z) and must match. (2) A +x step planted in the quarter just BEFORE / just AFTER each open and each previous close, run
// through buildPopulation + evaluate (the read path), must move OFF / ON by exactly x or exactly 0 on every day, both coins.
function usDstOn(date) {
  const y = +date.slice(0, 4), nthSunday = (m, n) => { let d = 1; while (new Date(Date.UTC(y, m, d)).getUTCDay() !== 0) d++; return `${y}-${String(m + 1).padStart(2, "0")}-${String(d + 7 * (n - 1)).padStart(2, "0")}`; };
  return date >= nthSunday(2, 2) && date < nthSunday(10, 1);
}
function boundaryLeakTest(calSessions, { from = WINDOW_FROM, to = WINDOW_TO, x = 0.01, seed = 3190, swapExpected = false } = {}) {
  const S = normalizeSessions(calSessions), { days } = buildDays(S, { from, to }), byDate = Object.fromEntries(S.map((s) => [s.date, s]));
  const indep = (date, min) => Date.parse(`${date}T00:00:00Z`) + (min + (usDstOn(date) ? 240 : 300)) * 60000;
  const clockMismatch = days.filter((dy) => { const p = byDate[dy.prevDate], c = byDate[dy.date]; return dy.t0 !== indep(dy.prevDate, p.closeMin) || dy.tOpen !== indep(dy.date, c.openMin) || dy.tClose !== indep(dy.date, c.closeMin); }).map((dy) => dy.date);
  if (!days.length) return { pass: false, why: "no days" };
  const lo = days[0].t0 - 8 * Q, hi = days[days.length - 1].tClose + 8 * Q, nQ = (hi - lo) / Q, g = mulberry(seed), base = new Float64Array(nQ);
  for (let j = 0; j < nQ; j++) base[j] = 0.004 * (g() - 0.5);
  const run = (plantAt) => {
    const step = Float64Array.from(base); for (const T of plantAt) step[(T - lo) / Q] += x;
    const L = new Float64Array(nQ + 1); L[0] = Math.log(50000); for (let j = 0; j < nQ; j++) L[j + 1] = L[j] + step[j];
    const P = (t) => Math.exp(L[(Math.floor((t - lo) / Q) * Q + (t % Q === 0 ? 0 : Q)) / Q]), rows = synthCandles(lo, hi, P);
    const Bp = buildPopulation(calSessions, { "BTC-USD": rows, "ETH-USD": rows.map((r) => [r[0], r[1] / 20, r[2] / 20, r[3] / 20, r[4] / 20, r[5]]) }, { conv: "open", from, to });
    return { Bp, E: evaluate(Bp.pop, Bp.pop.R, { withPlacebo: false }) };
  };
  const b0 = run([]), n = b0.Bp.pop.days.length;
  const cases = { quarterBeforeOpen: [(dy) => dy.tOpen - Q, x, 0], quarterAfterOpen: [(dy) => dy.tOpen, 0, x], quarterBeforeClose: [(dy) => dy.tClose - Q, 0, x], quarterAfterPrevClose: [(dy) => dy.t0, x, 0] };
  const res = {};
  for (const [name, [at, dOff0, dOn0]] of Object.entries(cases)) {
    const [dOff, dOn] = swapExpected ? [dOn0, dOff0] : [dOff0, dOn0];   // selftest only: a wrong expectation must FAIL
    const r = run(b0.Bp.pop.days.map(at)), bad = [];
    for (const c of COINS) for (let i = 0; i < n; i++) {
      const eo = r.E[c]._off[i] - b0.E[c]._off[i] - dOff, en = r.E[c]._on[i] - b0.E[c]._on[i] - dOn;
      if (!(Math.abs(eo) < 1e-9 && Math.abs(en) < 1e-9) && bad.length < 5) bad.push({ coin: c, date: b0.Bp.pop.days[i].date, offErr: eo, onErr: en });
    }
    res[name] = { expected: { offShift: dOff, onShift: dOn }, pass: r.Bp.pop.days.length === n && !bad.length, firstMismatches: bad };
  }
  const pass = !clockMismatch.length && n === days.length && Object.values(res).every((v) => v.pass);
  return { method: "real calendar, synthetic random-walk prices (no real candle read); boundary instants vs an independent US-DST rule; +1% steps one quarter either side of each open and previous close through buildPopulation + evaluate",
    requirement: "every day's three boundary instants match the independent clock; every planted step lands entirely in the window it belongs to (|error| < 1e-9 on every day, both coins)",
    pass, days: n, clockMismatchDays: clockMismatch.slice(0, 10), clockMismatchCount: clockMismatch.length, cases: res };
}

// ── known-answer selftest (runs before any fetch, in every mode) ─────────────────────────────────────────────────────────
function synthCalendar(dates) { return dates.map((x) => (typeof x === "string" ? { date: x, open: "09:30", close: "16:00" } : x)); }
// candles on [from, to) from a price function P(t) (last trade at time t): candle at T: open = P(T), close = P(T + Q - 1)
function synthCandles(fromMs, toMs, P, drop = new Set()) { const rows = []; for (let T = fromMs; T < toMs; T += Q) if (!drop.has(T)) { const o = P(T), c = P(T + Q - 1); rows.push([T, o, Math.max(o, c), Math.min(o, c), c, 1]); } return rows; }
function selftest() {
  const checks = {}, detail = {}, Z = (s) => Date.parse(s);
  // (a) ET -> UTC with DST and early closes
  checks.a_etToUtc = etToUtcMs("2024-07-02", 570) === Z("2024-07-02T13:30:00Z") && etToUtcMs("2024-11-27", 960) === Z("2024-11-27T21:00:00Z") && etToUtcMs("2024-11-29", 780) === Z("2024-11-29T18:00:00Z")
    && etToUtcMs("2024-07-03", 780) === Z("2024-07-03T17:00:00Z") && etToUtcMs("2025-03-07", 960) === Z("2025-03-07T21:00:00Z") && etToUtcMs("2025-03-10", 570) === Z("2025-03-10T13:30:00Z")
    && etToUtcMs("2025-11-03", 570) === Z("2025-11-03T14:30:00Z") && etToUtcMs("2026-09-30", 960) === Z("2026-09-30T20:00:00Z") && hhmm("09:30") === 570 && hhmm("13:00") === 780;
  // (b) session days: weekend gaps excluded, weekday-holiday gaps included, early closes included, DST never inside a kept gap
  const CAL = synthCalendar(["2024-06-28", "2024-07-01", "2024-07-02", { date: "2024-07-03", open: "09:30", close: "13:00" }, "2024-07-05", "2024-07-08", "2024-07-09",
    "2024-11-22", "2024-11-25", "2024-11-26", "2024-11-27", { date: "2024-11-29", open: "09:30", close: "13:00" }, "2024-12-02", "2024-12-03", "2025-03-07", "2025-03-10", "2025-03-11"]);
  const S = normalizeSessions(CAL), BD = buildDays(S, { from: "2024-07-01", to: "2025-12-31" }), byD = Object.fromEntries(BD.days.map((x) => [x.date, x]));
  const exp = { "2024-07-02": ["2024-07-01T20:00:00Z", "2024-07-02T13:30:00Z", "2024-07-02T20:00:00Z", 96, 70], "2024-07-03": ["2024-07-02T20:00:00Z", "2024-07-03T13:30:00Z", "2024-07-03T17:00:00Z", 84, 70],
    "2024-07-05": ["2024-07-03T17:00:00Z", "2024-07-05T13:30:00Z", "2024-07-05T20:00:00Z", 204, 178], "2024-07-09": ["2024-07-08T20:00:00Z", "2024-07-09T13:30:00Z", "2024-07-09T20:00:00Z", 96, 70],
    "2024-11-26": ["2024-11-25T21:00:00Z", "2024-11-26T14:30:00Z", "2024-11-26T21:00:00Z", 96, 70], "2024-11-27": ["2024-11-26T21:00:00Z", "2024-11-27T14:30:00Z", "2024-11-27T21:00:00Z", 96, 70],
    "2024-11-29": ["2024-11-27T21:00:00Z", "2024-11-29T14:30:00Z", "2024-11-29T18:00:00Z", 180, 166], "2024-12-03": ["2024-12-02T21:00:00Z", "2024-12-03T14:30:00Z", "2024-12-03T21:00:00Z", 96, 70],
    "2025-03-11": ["2025-03-10T20:00:00Z", "2025-03-11T13:30:00Z", "2025-03-11T20:00:00Z", 96, 70] };
  checks.b_sessionDaysKnownAnswer = JSON.stringify(Object.keys(byD)) === JSON.stringify(Object.keys(exp)) && Object.entries(exp).every(([d, [a, o, c, N, K]]) => iso(byD[d].t0) === a.replace("Z", ".000Z")
    && iso(byD[d].tOpen) === o.replace("Z", ".000Z") && iso(byD[d].tClose) === c.replace("Z", ".000Z") && byD[d].N === N && byD[d].kOpen === K)
    && JSON.stringify(BD.excluded.weekendGap) === JSON.stringify(["2024-07-01", "2024-07-08", "2024-11-22", "2024-11-25", "2024-12-02", "2025-03-07", "2025-03-10"])
    && byD["2024-07-03"].early && !byD["2024-07-02"].early && byD["2024-07-05"].prevEarly && byD["2024-07-05"].gapDays === 2 && byD["2024-11-29"].early
    && JSON.stringify(buildDays(S, { from: "2024-06-28", to: "2024-06-28" }).excluded.noPrevSession) === JSON.stringify(["2024-06-28"]);
  // Thu -> Mon (Good Friday) and Fri -> Tue (Monday holiday) are weekend gaps; Wed -> Fri is not
  checks.b_enclosesWeekend = enclosesWeekend("2025-04-17", "2025-04-21") && enclosesWeekend("2025-05-23", "2025-05-27") && !enclosesWeekend("2024-11-27", "2024-11-29") && !enclosesWeekend("2024-07-08", "2024-07-09")
    && enclosesWeekend("2024-07-05", "2024-07-08") && isWeekendDate("2026-09-26") && !isWeekendDate("2026-09-30");
  { let threw = 0; for (const bad of [[{ date: "2024-07-06", open: "09:30", close: "16:00" }], [{ date: "2024-07-05", open: "9:30", close: "16:00" }], [{ date: "2024-07-05", open: "09:30", close: "16:00" }, { date: "2024-07-05", open: "09:30", close: "16:00" }]])
      try { normalizeSessions(bad); } catch (e) { threw++; }
    checks.b_normalizeSessionsRejects = threw === 3; }
  // (c) boundary attribution through the candle grid: a step to 110 exactly at the open instant goes to OFF under the registered
  //     convention (open of the candle starting at T) and to ON under the last-trade-before reading; a step one candle later is ON
  //     under both; a step exactly at the close is ON (and the next day starts from it); missing interior candles fall back to the
  //     last trade (counted); a missing boundary drops the day
  { const d2 = byD["2024-07-02"], from = d2.t0 - 4 * Q, to = d2.tClose + 4 * Q, step = (X) => (t) => (t < X ? 100 : 110), ln = Math.log(1.1);
    const one = (rows, conv) => { const sp = spanLogPrices(d2, indexRows(rows), conv); return sp.ok ? { off: sp.lp[d2.kOpen] - sp.lp[0], on: sp.lp[d2.N] - sp.lp[d2.kOpen], stale: sp.stale, lp: sp.lp } : sp; };
    const atOpen = synthCandles(from, to, step(d2.tOpen)), nextQ = synthCandles(from, to, step(d2.tOpen + Q)), atClose = synthCandles(from, to, step(d2.tClose));
    const o1 = one(atOpen, "open"), c1 = one(atOpen, "closeBefore"), o2 = one(nextQ, "open"), c2 = one(nextQ, "closeBefore"), o3 = one(atClose, "open"), c3 = one(atClose, "closeBefore");
    const near = (x, y) => Math.abs(x - y) < 1e-12;
    checks.c_boundaryAttribution = near(o1.off, ln) && near(o1.on, 0) && near(c1.off, 0) && near(c1.on, ln) && near(o2.off, 0) && near(o2.on, ln) && near(c2.off, 0) && near(c2.on, ln)
      && near(o3.on, ln) && near(o3.off, 0) && near(c3.on, 0) && o1.stale === 0;
    const midT = d2.tOpen + 6 * Q, gone = synthCandles(from, to, step(midT), new Set([midT, midT + Q])), og = one(gone, "open");
    // grid points midT and midT + Q have no candle -> both take the close of the candle starting at midT - Q (= P(midT - 1) = 100);
    // the step shows up at midT + 2Q
    checks.c_interiorFallbackLastTrade = og.stale === 2 && near(og.lp[d2.kOpen + 6], Math.log(100)) && near(og.lp[d2.kOpen + 7], Math.log(100)) && near(og.lp[d2.kOpen + 8], Math.log(110)) && near(og.on, ln);
    const noOpen = spanLogPrices(d2, indexRows(synthCandles(from, to, step(midT), new Set([d2.tOpen]))), "open"), noPrev = spanLogPrices(d2, indexRows(synthCandles(from, to, step(midT), new Set([d2.t0 - Q]))), "closeBefore");
    checks.c_missingBoundaryDropsDay = !noOpen.ok && JSON.stringify(noOpen.missingBoundaries) === '["open"]' && !noPrev.ok && JSON.stringify(noPrev.missingBoundaries) === '["prevClose"]';
    // buildPopulation end to end on the synthetic calendar: both coins needed at every boundary
    const lin = (t) => 100 * Math.exp(1e-4 * ((t - Z("2024-06-01T00:00:00Z")) / Q)), fromAll = Z("2024-06-27T00:00:00Z"), toAll = Z("2025-03-12T00:00:00Z");
    const btc = synthCandles(fromAll, toAll, lin), eth = synthCandles(fromAll, toAll, lin, new Set([byD["2024-11-27"].tOpen]));
    const BP = buildPopulation(CAL, { "BTC-USD": btc, "ETH-USD": eth }, { from: "2024-07-01", to: "2025-12-31" }), E = evaluate(BP.pop, BP.pop.R, { withPlacebo: false });
    const kk = BP.pop.days.map((x) => x.kOpen), NN = BP.pop.days.map((x) => x.N);
    checks.c_populationNeedsBothCoins = BP.pop.days.length === 8 && !BP.pop.days.some((x) => x.date === "2024-11-27") && BP.missingBoundaryDays.length === 1 && BP.missingBoundaryDays[0].date === "2024-11-27"
      && JSON.stringify(BP.missingBoundaryDays[0].missing) === '{"BTC-USD":[],"ETH-USD":["open"]}'
      && Array.from(E["BTC-USD"]._off).every((x, i) => near(x, 1e-4 * kk[i])) && Array.from(E["BTC-USD"]._on).every((x, i) => near(x, 1e-4 * (NN[i] - kk[i])))
      && near(E["BTC-USD"].mean, mean(kk.map((k, i) => 1e-4 * (2 * k - NN[i])))) && BP.sessionDaysInWindow === 16; detail.c_population = { n: BP.pop.days.length, sessionDaysInWindow: BP.sessionDaysInWindow }; }
  // (d) statistics by hand
  { const s = coinSummary({ days: [{ date: "2025-06-30" }, { date: "2025-07-01" }, { date: "2025-06-01" }] }, Float64Array.from([0.01, 0.02, -0.01]), Float64Array.from([0, 0.03, 0.01]));
    checks.d_statsHandComputed = Math.abs(tStat([1, 2, 3, 4, 5]) - 3 / (Math.sqrt(2.5) / Math.sqrt(5))) < 1e-12 && tStat([1]) === null && tStat([2, 2, 2]) === null
      && Math.abs(nwT([1.5, 0.5, 1.5, 0.5, 1.0]) - 10) < 1e-9 && Math.abs(s.mean - (0.01 - 0.01 - 0.02) / 3) < 1e-15 && Math.abs(s.halfFirst - (0.01 - 0.02) / 2) < 1e-15 && Math.abs(s.halfSecond - (-0.01)) < 1e-15
      && s.nFirst === 2 && s.nSecond === 1 && Math.abs(s.longOffNet - mean([Math.exp(0.01) - 1.003, Math.exp(0.02) - 1.003, Math.exp(-0.01) - 1.003])) < 1e-12; }
  // (e) placebo: bounds, lengths, exact window values, frequencies, determinism, identical placements across coins
  { const pop = { days: [{ date: "2025-01-02", N: 4, kOpen: 3 }, { date: "2025-01-03", N: 6, kOpen: 2 }] }, R = { "BTC-USD": [Float64Array.from([0, 0, 0, 1]), Float64Array.from([1, 2, 3, 4, 5, 6])], "ETH-USD": [Float64Array.from([0, 0, 0, 2]), Float64Array.from([0, 0, 0, 0, 0, 0])] };
    let ok = true; const cnt = { a1: 0, b3: 0, n0: 0 }, recB = [], recE = [];
    const plB = placeboRun(pop, R, "BTC-USD", { draws: 8000, seed: 7, record: (k, i, a, b, v) => { recB.push([k, i, a, b]); const N = pop.days[i].N, K = pop.days[i].kOpen, r = R["BTC-USD"][i];
      if (!(a >= 0 && a <= N - K && b >= 0 && b <= K)) ok = false; let off = 0, on = 0; for (let j = a; j < a + K; j++) off += r[j]; for (let j = b; j < b + N - K; j++) on += r[j]; if (Math.abs(v - (off - on)) > 1e-12) ok = false;
      if (i === 0) { cnt.n0++; if (a === 1) cnt.a1++; if (b === 3) cnt.b3++; } } });
    placeboRun(pop, R, "ETH-USD", { draws: 8000, seed: 7, record: (k, i, a, b) => recE.push([k, i, a, b]) });
    const again = placeboRun(pop, R, "BTC-USD", { draws: 8000, seed: 7 });
    checks.e_placeboWindowsExact = ok && recB.length === 16000 && JSON.stringify(recB) === JSON.stringify(recE) && Math.abs(cnt.a1 / cnt.n0 - 0.5) < 0.03 && Math.abs(cnt.b3 / cnt.n0 - 0.25) < 0.03
      && again.p95 === plB.p95 && again.meanOfDraws === plB.meanOfDraws && plB.p975 >= plB.p95 && plB.p95 >= plB.p50;
    // p95 index = sorted[floor(0.95 * draws)] on a one-day pop with a known value set {-1, 0, 1}: P(1) = 3/8 -> p95 = 1, p05 = -1
    const one = placeboRun({ days: [pop.days[0]] }, R, "BTC-USD", { draws: 4000, seed: 3 });
    checks.e_placeboQuantiles = one.p95 === 1 && one.p05 === -1 && Math.abs(one.meanOfDraws - (3 / 8 - 1 / 8)) < 0.03 && placeboRun({ days: [] }, R, "BTC-USD") === null; detail.e_oneDayMean = one.meanOfDraws; }
  // (f) scrambles: kept keeps each span's multiset and total, free sums to 0 over the population, rot is a rotation; one shuffle for both coins
  { const days = [{ date: "2025-01-02", N: 8, kOpen: 5 }, { date: "2025-01-03", N: 6, kOpen: 4 }], pop = { days };
    const R = { "BTC-USD": days.map((x, i) => Float64Array.from({ length: x.N }, (_, j) => 0.001 * (j + 1) + i)), "ETH-USD": days.map((x, i) => Float64Array.from({ length: x.N }, (_, j) => 1000 + 0.001 * (j + 1) + i)) };
    const k1 = scrambleR(pop, R, 1, "kept"), k1b = scrambleR(pop, R, 1, "kept"), f1 = scrambleR(pop, R, 1, "free"), ro = scrambleR(pop, R, 4, "rot");
    const sortS = (a) => Array.from(a).sort((x, y) => x - y).join(), sum = (a) => a.reduce((s, x) => s + x, 0);
    const keptOk = days.every((_, i) => sortS(k1["BTC-USD"][i]) === sortS(R["BTC-USD"][i]) && Math.abs(sum(k1["BTC-USD"][i]) - sum(R["BTC-USD"][i])) < 1e-9
      && Array.from(k1["ETH-USD"][i]).every((x, j) => Math.abs(x - k1["BTC-USD"][i][j] - 1000) < 1e-9) && k1["BTC-USD"][i].every((x, j) => x === k1b["BTC-USD"][i][j]));
    const moved = days.some((_, i) => Array.from(k1["BTC-USD"][i]).some((x, j) => x !== R["BTC-USD"][i][j]));
    const freeOk = COINS.every((c) => Math.abs(f1[c].reduce((s, a) => s + sum(a), 0)) < 1e-9);
    const rotOk = days.every((_, i) => { const a = Array.from(ro["BTC-USD"][i]), b = Array.from(R["BTC-USD"][i]), k = b.indexOf(a[0]); return k >= 0 && a.every((x, j) => x === b[(j + k) % b.length]) && Math.abs(sum(a) - sum(b)) < 1e-12; });
    const pl = plantOff(pop, R, 0.01), E0 = evaluate(pop, R, { withPlacebo: false }), E1 = evaluate(pop, pl, { withPlacebo: false });
    checks.f_scramblesAndPlant = keptOk && moved && freeOk && rotOk && Array.from(E1["BTC-USD"]._off).every((x, i) => Math.abs(x - E0["BTC-USD"]._off[i] - 0.01) < 1e-12)
      && Array.from(E1["ETH-USD"]._on).every((x, i) => x === E0["ETH-USD"]._on[i]);
    // flip: |r| kept quarter by quarter, one sign per quarter shared by both coins, deterministic, signs actually vary; flipDrift = its own
    // sign flip (own salt) + each coin's population mean quarter return
    const fl = scrambleR(pop, R, 5, "flip"), fl2 = scrambleR(pop, R, 5, "flip"), fd = scrambleR(pop, R, 5, "flipDrift");
    const muOf = (c) => R[c].reduce((s, a) => s + sum(a), 0) / R[c].reduce((s, a) => s + a.length, 0);
    let signs = new Set(); const flipOk = days.every((_, i) => Array.from(fl["BTC-USD"][i]).every((x, j) => { const rb = R["BTC-USD"][i][j], re = R["ETH-USD"][i][j], sb = x / rb, se = fl["ETH-USD"][i][j] / re; signs.add(sb);
      return Math.abs(Math.abs(sb) - 1) < 1e-12 && Math.abs(sb - se) < 1e-12 && x === fl2["BTC-USD"][i][j] && COINS.every((c) => Math.abs(Math.abs(fd[c][i][j] - muOf(c)) - Math.abs(R[c][i][j])) < 1e-12) && Math.abs((fd["BTC-USD"][i][j] - muOf("BTC-USD")) / rb - (fd["ETH-USD"][i][j] - muOf("ETH-USD")) / re) < 1e-9; }));
    let threwMode = false; try { scrambleR(pop, R, 1, "nope"); } catch (e) { threwMode = true; }
    // plantForm: OFF moves by exactly offX and ON by exactly onX on every day; plantDrift adds mu to every quarter
    const pf = plantForm(pop, R, 0.003, -0.002), Ef = evaluate(pop, pf, { withPlacebo: false }), pd = plantDrift(R, 1e-4), Ed = evaluate(pop, pd, { withPlacebo: false });
    // (ETH values ~1000 per quarter here, so the tolerance is 1e-9: sums near 5,000 carry ~1e-12 rounding)
    const formOk = COINS.every((c) => Array.from(Ef[c]._off).every((x, i) => Math.abs(x - E0[c]._off[i] - 0.003) < 1e-9) && Array.from(Ef[c]._on).every((x, i) => Math.abs(x - E0[c]._on[i] + 0.002) < 1e-9)
      && Array.from(Ed[c]._off).every((x, i) => Math.abs(x - E0[c]._off[i] - 1e-4 * days[i].kOpen) < 1e-9) && Array.from(Ed[c]._on).every((x, i) => Math.abs(x - E0[c]._on[i] - 1e-4 * (days[i].N - days[i].kOpen)) < 1e-9));
    checks.f_flipFormsDrift = flipOk && signs.size === 2 && threwMode && formOk;
    // drift-neutral D: the closed form, and exactly 0 for a constant per-quarter return (pure drift, no hours effect) while raw D is not
    const NK = [[96, 70], [84, 70], [204, 178]];
    const dnOk = NK.every(([N, K]) => [[0.01, -0.004], [-0.02, 0.003]].every(([o, n]) => Math.abs(driftNeutralOf(o, n, K, N) - (2 * K * (N - K) / N) * (o / K - n / (N - K))) < 1e-15))
      && NK.every(([N, K]) => Math.abs(driftNeutralOf(3e-5 * K, 3e-5 * (N - K), K, N)) < 1e-15 && Math.abs((3e-5 * K) - 3e-5 * (N - K)) > 1e-4);
    const Edn = evaluate({ days }, plantDrift({ "BTC-USD": days.map((x) => new Float64Array(x.N)), "ETH-USD": days.map((x) => new Float64Array(x.N)) }, 2e-5), { withPlacebo: false });
    checks.f_driftNeutral = dnOk && COINS.every((c) => Math.abs(Edn[c].driftNeutralMean) < 1e-15 && Edn[c].mean > 0) && E0["BTC-USD"]._dAdj.length === 2; }
  // (g) the decision rule: selection by max t, strict comparisons, t exactly at the bar passes, < 400 days -> CANNOT MEASURE
  { const pl = { p95: 0.001, p975: 0.002, p50: 0 }, mk = (o = {}) => ({ "BTC-USD": { mean: 0.003, t: 2.5, halfFirst: 0.002, halfSecond: 0.004, longOffNet: 0.0005, placebo: pl, ...(o.b || {}) },
      "ETH-USD": { mean: 0.002, t: 1.0, halfFirst: 0.001, halfSecond: 0.003, longOffNet: 0.001, placebo: pl, ...(o.e || {}) } });
    const v = (o, n = 500, q = "p95") => decide(mk(o), n, 1.958, q);
    checks.g_decisionRule = v({}).verdictScript === "PASS" && v({}).selected === "BTC-USD" && Object.keys(v({}).gates).length === 6 && v({ b: { t: 1.958 } }).verdictScript === "PASS"
      && v({ b: { t: 1.9579 } }).verdictScript === "DID NOT PASS" && JSON.stringify(v({ b: { t: 1.9579 } }).failed) === '["tAtLeastBar"]' && v({ b: { mean: 0.001 } }).verdictScript === "DID NOT PASS"
      && JSON.stringify(v({ b: { mean: 0.001 } }).failed) === '["placeboBeaten"]' && v({ b: { halfSecond: 0 } }).verdictScript === "DID NOT PASS" && v({ b: { longOffNet: 0 } }).verdictScript === "DID NOT PASS"
      && v({}, 399).verdictScript.startsWith("CANNOT MEASURE") && v({}, 400).verdictScript === "PASS" && v({ b: { mean: 0.0015 } }, 500, "p975").verdictScript === "DID NOT PASS" && v({ b: { mean: 0.0025 } }, 500, "p975").verdictScript === "PASS"
      && v({ b: { t: 1.0 }, e: { t: 1.0 } }).selected === "BTC-USD" && v({ b: { t: null } }).selected === "ETH-USD" && v({ b: { t: 1.5 }, e: { t: 2.2 } }).selected === "ETH-USD";
    const sel = v({ b: { longOffNet: -0.001 }, e: { t: 2.0 } });                                   // BTC selected (t 2.5) fails cost; ETH clears every gate
    checks.g_anyVariantReportedNotGated = sel.selected === "BTC-USD" && sel.verdictScript === "DID NOT PASS" && sel.anyVariantPass && JSON.stringify(sel.coinsClearingAllGates) === '["ETH-USD"]';
    // variants:either (only via amendment): the same case PASSes on ETH; nobody clearing -> DID NOT PASS on the higher-t coin; both clearing -> higher t
    const ve = (o, n = 500, q = "p95") => decide(mk(o), n, 1.958, q, MIN_DAYS, true), e1 = ve({ b: { longOffNet: -0.001 }, e: { t: 2.0 } }), e2 = ve({ b: { longOffNet: -0.001 }, e: { t: 1.0 } }), e3 = ve({ e: { t: 2.2 } });
    checks.g_eitherToken = e1.verdictScript === "PASS" && e1.selected === "ETH-USD" && e1.higherTCoin === "BTC-USD" && e1.either && e2.verdictScript === "DID NOT PASS" && e2.selected === "BTC-USD"
      && JSON.stringify(e2.failed) === '["longOffNetPositive"]' && e3.verdictScript === "PASS" && e3.selected === "BTC-USD" && ve({}, 399).verdictScript.startsWith("CANNOT MEASURE")
      && ve({ b: { t: 1.5 }, e: { t: 1.9 } }).verdictScript === "DID NOT PASS" && !v({}).either;
    // the REPORTED verdict reason separates "fails only the long-OFF cost gate" from "a statistical gate failed"
    checks.g_verdictReason = verdictReasonOf(v({ b: { longOffNet: -0.001 } })).startsWith("every statistical gate clears; fails ONLY") && verdictReasonOf(v({})) === "every gate clears"
      && verdictReasonOf(v({ b: { t: 1.0 } })) === "failed: tAtLeastBar (a statistical gate failed: the split itself is not established)"
      && verdictReasonOf(v({ b: { t: 1.0, longOffNet: -1 } })) === "failed: tAtLeastBar, longOffNetPositive (a statistical gate failed: the split itself is not established)" && verdictReasonOf(v({}, 10)) === null; }
  // (h) pre-read decision parser
  { const A = preReadDecision({}), B = preReadDecision({ amendments: [{ field: "x", preEvidence: true }] }), C = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: ["placebo:p975"] }] });
    const E = preReadDecision({ amendments: [{ preEvidence: false, runnerGates: ["placebo:p975"] }] }), F = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: ["placebo:p99"] }] });
    const G = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: [] }] }), H = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: ["registered", "placebo:p975"] }] }), I = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: ["registered"] }] });
    const K1 = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: ["variants:either"] }] }), K2 = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: ["placebo:p975"] }, { preEvidence: true, runnerGates: ["variants:either"] }] });
    const K3 = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: ["registered", "variants:either"] }] }), K4 = preReadDecision({ amendments: [{ preEvidence: false, runnerGates: ["variants:either"] }] });
    checks.h_preReadDecisionParser = A.decided && !A.amended && A.q === "p95" && !A.either && B.decided && B.q === "p95" && C.decided && C.amended && C.q === "p975" && !C.either && !E.decided && !F.decided && !G.decided && !H.decided && I.decided && !I.amended && I.q === "p95"
      && K1.decided && K1.amended && K1.either && K1.q === "p95" && K2.decided && K2.either && K2.q === "p975" && JSON.stringify(K2.tokens) === '["placebo:p975","variants:either"]' && !K3.decided && !K4.decided; }
  // (i) Coinbase rows: field order, grid, window, positivity
  { const m = new Map([[Z("2025-01-01T00:15:00Z"), cbRow([Z("2025-01-01T00:15:00Z") / 1000, 9, 12, 10, 11, 5])], [Z("2025-01-01T00:00:00Z"), cbRow([Z("2025-01-01T00:00:00Z") / 1000, 8, 11, 9, 10, 4])]]);
    const pk = packRows("T", m); let t1 = false, t2 = false, t3 = false;
    try { packRows("T", new Map([[1, [Z("2025-01-01T00:01:00Z"), 1, 1, 1, 1, 1]]])); } catch (e) { t1 = true; }
    try { packRows("T", new Map([[1, [Z("2025-01-01T00:00:00Z"), 0, 1, 1, 1, 1]]])); } catch (e) { t2 = true; }
    try { packRows("T", new Map([[1, [FETCH_TO_MS, 1, 1, 1, 1, 1]]])); } catch (e) { t3 = true; }
    checks.i_coinbaseRows = JSON.stringify(cbRow([1700000000, 1, 4, 2, 3, 9])) === JSON.stringify([1700000000000, 2, 4, 1, 3, 9]) && pk.rows.length === 2 && pk.rows[0][0] === Z("2025-01-01T00:00:00Z") && pk.rows[1][1] === 10 && t1 && t2 && t3; }
  // (j) calibration plumbing on fabricated rows: per-family false pass, per gate, the in-force quantile, READY condition
  { const pl = { p95: 0.001, p975: 0.002, p50: 0 }, row = (seed, bt, mean, cost, et = 0, ecost = -1) => { const E = { "BTC-USD": { mean, t: bt, halfFirst: 0.001, halfSecond: 0.001, longOffNet: cost, placebo: pl }, "ETH-USD": { mean: et ? 0.003 : 0, t: et, halfFirst: et ? 0.001 : 0, halfSecond: et ? 0.001 : 0, longOffNet: ecost, placebo: pl } };
      return rowOf(seed, E, 500, 1.958); };
    // kept: seeds 1-2 BTC t 3 (seed 2 fails p975 only); seed 3 BTC t 3 fails cost but ETH t 2.5 clears every gate (either-coin false pass only)
    const fam = { kept: Array.from({ length: 20 }, (_, i) => (i === 2 ? row(i + 1, 3, 0.003, -0.001, 2.5, 0.001) : row(i + 1, i < 2 ? 3 : 0.5, i === 1 ? 0.0015 : 0.003, 0.001))),
      free: Array.from({ length: 10 }, (_, i) => row(i + 1, 0.2, 0.003, -0.001)), rot: Array.from({ length: 10 }, (_, i) => row(i + 1, 0.2, 0.003, 0.001)) };
    const X = { kept: 20, free: 10, rot: 10 }, cal = calibrate(fam, 1.958, "p95", X), cal2 = calibrate(fam, 1.958, "p975", X), cal3 = calibrate(fam, 1.958, "p95", X, true), k = cal.families.kept;
    checks.j_calibrationPlumbing = cal.ok && k.inForce.passes === 2 && Math.abs(k.inForce.wholeRuleFalsePass - 0.1) < 1e-15 && Math.abs(k.inForce.perGate.tAtLeastBar - 0.15) < 1e-15 && Math.abs(k.inForce.perGate.longOffNetPositive - 0.95) < 1e-15
      && cal.families.free.inForce.perGate.longOffNetPositive === 0 && !cal.calibrated && cal2.families.kept.inForce.passes === 1 && Math.abs(cal2.maxWholeRuleFalsePassInForce - 0.05) < 1e-15 && cal2.calibrated
      && cal.p975Calibrated && Math.abs(cal.maxWholeRuleFalsePassRegisteredP95 - 0.1) < 1e-15 && !calibrate(fam, 1.958, "p95", { kept: 21, free: 10, rot: 10 }).ok && Math.abs(k.inForce.selectedBTCShare - 1) < 1e-15
      && cal3.gateSet === "p95+either" && cal3.families.kept.inForce.passes === 3 && Math.abs(cal3.maxWholeRuleFalsePassInForce - 0.15) < 1e-15 && Math.abs(cal.maxWholeRuleFalsePassEitherP95 - 0.15) < 1e-15
      && Math.abs(k.inForce.anyVariantFalsePass - 0.15) < 1e-15 && Math.abs(k.inForce.failsOnlyCostGate - 0.05) < 1e-15 && !cal.eitherCalibrated && cal.families.kept.eitherP975.passes === 2; }
  // (k) the read path end to end on a synthetic cache (no real data): a planted OFF edge PASSes, a flat path does not, n < minDays CANNOT MEASURE
  { const dates = []; for (let d = "2024-04-01"; d <= "2024-06-28"; d = addDays(d, 1)) if (!isWeekendDate(d) && d !== "2024-05-27") dates.push(d);
    const cal = synthCalendar(dates), Ss = normalizeSessions(cal), days = buildDays(Ss, { from: "2024-04-08", to: "2024-06-28" }).days, g = mulberry(99), lpAt = new Map();
    // a random walk on the 15-minute grid with +0.8% planted in every OFF window
    let lp = Math.log(60000); const t0 = Z("2024-03-31T00:00:00Z"), t1 = Z("2024-06-30T00:00:00Z"), offQ = new Set();
    for (const dy of days) for (let j = 0; j < dy.kOpen; j++) offQ.add(dy.t0 + j * Q);
    for (let T = t0; T <= t1; T += Q) { lpAt.set(T, lp); lp += 0.002 * (g() - 0.5) + (offQ.has(T) ? 0.008 / 70 : 0); }
    const P = (t) => Math.exp(lpAt.get(Math.floor(t / Q) * Q + (t % Q === 0 ? 0 : Q))), rows = synthCandles(t0, t1, P);
    const cache = { calendar: { sessions: cal }, candles: { "BTC-USD": rows, "ETH-USD": rows.map((r) => [r[0], r[1] * 0.05, r[2] * 0.05, r[3] * 0.05, r[4] * 0.05, r[5]]) } };
    const ctrl = { asOf: "x", leakTest: { pass: true }, positiveControl: { pass: true }, calibration: { calibrated: true, maxWholeRuleFalsePassInForce: 0, families: {} } };
    const cfg = { ...CFG, from: "2024-04-08", to: "2024-06-28", half1To: "2024-05-15", minDays: 20, draws: 200 };
    const rd = computeRead({ cache, sha: "synthetic", ctrl, entry: { nExpected: 640 }, dec: preReadDecision({}), bar: 1.958, cfg });
    const flat = { ...cache, candles: Object.fromEntries(COINS.map((c) => [c, cache.candles[c].map((r) => [r[0], 100, 100, 100, 100, 1])])) };
    const rf = computeRead({ cache: flat, sha: "synthetic", ctrl, entry: { nExpected: 640 }, dec: preReadDecision({}), bar: 1.958, cfg });
    const rc = computeRead({ cache, sha: "synthetic", ctrl, entry: { nExpected: 640 }, dec: preReadDecision({}), bar: 1.958, cfg: { ...cfg, minDays: 1000 } });
    const o = rd.out, keys = ["read", "unit", "n", "tNet", "meanNet", "winRatePct", "placebo", "gates", "verdictScript", "reported", "cache"];
    checks.k_readPathSynthetic = o.read === true && keys.every((k) => k in o) && o.unit === "days" && o.verdictScript === "PASS" && o.n === days.length
      && o.placebo.beats === true && o.cache.sha256 === "synthetic" && rf.out.verdictScript === "DID NOT PASS" && rf.out.gates.meanPositive === false && rc.out.verdictScript.startsWith("CANNOT MEASURE")
      && o.reported.boundaryConventionCloseBefore.perCoin["BTC-USD"].n === o.n && fin(o.reported.buyAndHold.perCoin["BTC-USD"].buyAndHoldSimple) && COINS.every((c) => Array.isArray(o.reported.timeOfDayProfile.utcQuarterOfDay[c]) && o.reported.timeOfDayProfile.utcQuarterOfDay[c].length === 96)
      && rd.lines.length > 3 && JSON.stringify(Object.keys(o.gates)) === JSON.stringify(["sessionDaysAtLeast400", "meanPositive", "tAtLeastBar", "placeboBeaten", "bothHalvesPositive", "longOffNetPositive"]);
    // the REPORTED fields of the 2026-10-03 repair: verdict reason (a 2% round trip makes the same planted split fail ONLY the cost gate),
    // the drift-neutral D (the planted split shows in it too), short-ON leg; the either token flows through to the read
    const rk = computeRead({ cache, sha: "synthetic", ctrl, entry: { nExpected: 640 }, dec: preReadDecision({}), bar: 1.958, cfg: { ...cfg, cost: 0.02 } });
    const re = computeRead({ cache, sha: "synthetic", ctrl, entry: { nExpected: 640 }, dec: preReadDecision({ amendments: [{ preEvidence: true, runnerGates: ["variants:either"] }] }), bar: 1.958, cfg });
    const pcB = o.reported.perCoin["BTC-USD"];
    checks.k_reportedRepairFields = rk.out.verdictScript === "DID NOT PASS" && JSON.stringify(rk.out.failedGates) === '["longOffNetPositive"]' && rk.out.verdictReason.startsWith("every statistical gate clears; fails ONLY")
      && o.verdictReason === "every gate clears" && rf.out.verdictReason.includes("a statistical gate failed") && pcB.driftNeutral && pcB.driftNeutral.t > 3 && fin(pcB.driftNeutral.meanPctPerDay)
      && fin(pcB.shortOnReported.netAtRegisteredCostMeanPctPerDay) && re.out.verdictScript === "PASS" && re.out.registeredGates && re.out.registeredGates.verdictScript === "PASS" && re.out.gatesInForce.includes("variants:either");
    detail.k_read = { n: o.n, verdict: o.verdictScript, t: o.tNet, flat: rf.out.verdictScript, costOnly: rk.out.verdictReason, driftNeutralT: pcB.driftNeutral.t }; }
  // (m) the boundary leak test itself: passes on a synthetic calendar (DST changes, early closes, a Wed->Fri gap), FAILS when the expected
  //     window is swapped (the comparator is not vacuous); the independent DST rule on known transition dates
  { const bl = boundaryLeakTest(CAL, { from: "2024-07-01", to: "2025-12-31" }), bw = boundaryLeakTest(CAL, { from: "2024-07-01", to: "2025-12-31", swapExpected: true });
    checks.m_boundaryLeakTest = bl.pass && bl.days === 9 && bl.clockMismatchCount === 0 && !bw.pass && Object.values(bw.cases).every((v) => !v.pass)
      && usDstOn("2024-03-10") && !usDstOn("2024-03-09") && usDstOn("2024-11-02") && !usDstOn("2024-11-03") && usDstOn("2025-03-09") && !usDstOn("2025-03-08") && usDstOn("2025-11-01") && !usDstOn("2025-11-02")
      && usDstOn("2026-03-08") && !usDstOn("2026-03-07") && usDstOn("2026-10-31") && !usDstOn("2026-11-01"); detail.m_boundaryLeak = { days: bl.days, swappedFails: !bw.pass }; }
  // (l) halves split and reference calendar lists are well formed
  checks.l_referenceLists = REF_HOLIDAYS.every((d) => !isWeekendDate(d) && d >= WINDOW_FROM && d <= WINDOW_TO) && REF_EARLY.every((d) => !isWeekendDate(d)) && HALF1_TO < WINDOW_TO && WINDOW_FROM < HALF1_TO
    && new Set(REF_HOLIDAYS).size === REF_HOLIDAYS.length && REF_HOLIDAYS.join() === [...REF_HOLIDAYS].sort().join();
  return { pass: Object.values(checks).every(Boolean), checks, detail };
}

// ── data: Coinbase 15-minute candles + the Alpaca calendar, fetched once, hashed ───────────────────────────────────────────
async function cbGet(url) {
  for (let attempt = 0; attempt <= 8; attempt++) {
    let r;
    try { r = await fetch(url, { headers: { "User-Agent": "traids-r319-research", Accept: "application/json" }, signal: AbortSignal.timeout(30000) }); }
    catch (e) { if (attempt === 8) throw e; await sleep(Math.min(60000, 1000 * 2 ** attempt)); continue; }
    if (r.ok) { const j = await r.json(); if (!Array.isArray(j)) throw new Error("coinbase non-array: " + JSON.stringify(j).slice(0, 200)); return j; }
    if (r.status === 429 || r.status >= 500) { console.log(`  HTTP ${r.status}; backing off`); if (attempt === 8) throw new Error("coinbase " + r.status + " after retries"); await sleep(Math.min(60000, 1000 * 2 ** attempt)); continue; }
    throw new Error("coinbase " + r.status + " " + (await r.text()).slice(0, 200));
  }
}
async function fetchCoin(product) {
  const seen = new Map(); let req = 0;
  for (let s = FETCH_FROM_MS; s < FETCH_TO_MS; s += 300 * Q) {
    const e = Math.min(s + 299 * Q, FETCH_TO_MS - Q);                          // end inclusive (R306 probe): 300 candles per request
    const j = await cbGet(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=${GRAN}&start=${iso(s)}&end=${iso(e)}`);
    req++;
    for (const c of j) { const r = cbRow(c); if (r[0] >= FETCH_FROM_MS && r[0] < FETCH_TO_MS) seen.set(r[0], r); }
    if (req % 50 === 0) console.log(`  ${product} ${req} requests, ${seen.size} candles (through ${iso(e).slice(0, 10)})`);
    await sleep(340);
  }
  return { ...packRows(product, seen), requests: req };
}
async function fetchCalendar() {
  require("dotenv").config({ path: path.join(__dirname, ".env") });
  const id = process.env.ALPACA_KEY_ID, secret = process.env.ALPACA_SECRET_KEY;
  if (!id || !secret) throw new Error("ALPACA_KEY_ID / ALPACA_SECRET_KEY not set in backend/.env");
  const r = await fetch(`https://paper-api.alpaca.markets/v2/calendar?start=${CAL_START}&end=${CAL_END}`, { headers: { "APCA-API-KEY-ID": id, "APCA-API-SECRET-KEY": secret, Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`alpaca calendar HTTP ${r.status}`);
  const j = await r.json(); if (!Array.isArray(j) || !j.length) throw new Error("alpaca calendar returned no sessions");
  return j.map((x) => ({ date: x.date, open: x.open, close: x.close }));
}
async function loadOrFetch(allowFetch) {
  if (fs.existsSync(CACHE)) {
    const buf = fs.readFileSync(CACHE), j = JSON.parse(buf.toString("utf8"));
    if (j.spec !== "r319-cache-v1" || j.fetch.fromMs !== FETCH_FROM_MS || j.fetch.toMsExclusive !== FETCH_TO_MS || j.fetch.granularity !== GRAN || JSON.stringify(j.coins) !== JSON.stringify(COINS)
      || j.calendar.start !== CAL_START || j.calendar.end !== CAL_END) throw new Error("cache metadata does not match the R319 spec — refusing to use it");
    return { cache: j, sha: sha256(buf), fetched: false };
  }
  if (!allowFetch) throw new Error(`cache missing (${CACHE_REL}) — the controls run creates it; the read never refetches`);
  console.log(`R319 fetching Alpaca /v2/calendar ${CAL_START}..${CAL_END} (read-only) and Coinbase 15-minute candles ${iso(FETCH_FROM_MS)} .. ${iso(FETCH_TO_MS)} (exclusive) ...`);
  const sessions = await fetchCalendar(), candles = {}, coinMeta = {};
  for (const c of COINS) { const f = await fetchCoin(c); candles[c] = f.rows; coinMeta[c] = { candles: f.rows.length, requests: f.requests, flags: f.flags, first: f.rows.length ? iso(f.rows[0][0]) : null, last: f.rows.length ? iso(f.rows[f.rows.length - 1][0]) : null }; console.log(`  ${c} ${f.rows.length} candles, ${f.requests} requests`); }
  const obj = { spec: "r319-cache-v1", id: ID, fetchedAt: new Date().toISOString(), coins: COINS,
    sources: { candles: "Coinbase Exchange public candles api.exchange.coinbase.com/products/<product>/candles granularity 900 (no key)", calendar: "Alpaca paper-api /v2/calendar (read-only GET; ET wall-clock open/close)" },
    fetch: { fromMs: FETCH_FROM_MS, toMsExclusive: FETCH_TO_MS, from: iso(FETCH_FROM_MS), toExclusive: iso(FETCH_TO_MS), granularity: GRAN, perRequest: 300 },
    calendar: { start: CAL_START, end: CAL_END, sessions }, coinMeta, rowsFormat: "[startMs UTC, open, high, low, close, base volume]", candles };
  fs.mkdirSync(CACHE_DIR, { recursive: true }); writeJsonAtomic(CACHE, obj, { pretty: 0 });
  const buf = fs.readFileSync(CACHE);
  return { cache: JSON.parse(buf.toString("utf8")), sha: sha256(buf), fetched: true };
}
function registryEntry() { const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")); return [...(reg.preregistered || []), ...(reg.tests || [])].find((x) => x.id === ID) || null; }

// ── coverage (counts only; no return statistic) ──────────────────────────────────────────────────────────────────────────
function coverageOf(cache, B) {
  const inWin = B.sessions.filter((s) => s.date >= WINDOW_FROM && s.date <= WINDOW_TO), wk = [];
  for (let d = WINDOW_FROM; d <= WINDOW_TO; d = addDays(d, 1)) if (!isWeekendDate(d)) wk.push(d);
  const have = new Set(inWin.map((s) => s.date)), nonSessions = wk.filter((d) => !have.has(d)), early = inWin.filter((s) => s.closeMin !== 960).map((s) => s.date);
  const oddHours = inWin.filter((s) => s.openMin !== 570 || (s.closeMin !== 960 && s.closeMin !== 780)).map((s) => `${s.date} ${s.openMin}-${s.closeMin}`);
  const calendarMatchesReference = JSON.stringify(nonSessions) === JSON.stringify(REF_HOLIDAYS) && JSON.stringify(early) === JSON.stringify(REF_EARLY) && !oddHours.length;
  let mine3 = { available: false };
  if (fs.existsSync(MINE3_CAL)) {
    const m = JSON.parse(fs.readFileSync(MINE3_CAL, "utf8")).sessions, last = m[m.length - 1].date, a = m.filter((s) => s.date >= CAL_START && s.date <= last), b = B.sessions.filter((s) => s.date <= last);
    const same = a.length === b.length && a.every((s, i) => s.date === b[i].date && s.open === b[i].openMin && s.close === b[i].closeMin);
    mine3 = { available: true, file: "backend/data/training/mine3/calendar-2015-12-01-2026-09-25.json", overlap: `${CAL_START}..${last}`, sessionsCompared: a.length, identical: same };
  }
  const first = B.pop.days[0], lastD = B.pop.days[B.pop.days.length - 1], coins = {};
  for (const c of COINS) {
    const rows = cache.candles[c] || [], lo = first ? first.t0 : FETCH_FROM_MS, hi = lastD ? lastD.tClose : FETCH_TO_MS;
    let inW = 0, longest = 0, run = 0; const idx = B.idx[c];
    for (let T = lo; T <= hi; T += Q) { if (idx.has(T)) { inW++; run = 0; } else { run++; if (run > longest) longest = run; } }
    const expectedIn = (hi - lo) / Q + 1;
    coins[c] = { candles: rows.length, expectedAll: (FETCH_TO_MS - FETCH_FROM_MS) / Q, first: rows.length ? iso(rows[0][0]) : null, last: rows.length ? iso(rows[rows.length - 1][0]) : null,
      inPopulationSpanPct: r3((100 * inW) / expectedIn), missingQuartersInSpan: expectedIn - inW, longestMissingRunMinutes: longest * 15, staleInteriorGridPoints: B.staleInterior[c], flags: (cache.coinMeta && cache.coinMeta[c] && cache.coinMeta[c].flags) || null };
  }
  const holidayGaps = B.pop.days.filter((x) => x.gapDays > 1).map((x) => `${x.prevDate}->${x.date} OFF ${(x.kOpen * 15) / 60} h`);
  const ok = calendarMatchesReference && mine3.available && mine3.identical && COINS.every((c) => coins[c].candles > 0 && coins[c].last === iso(FETCH_TO_MS - Q)) && B.pop.days.length > 0;
  return { calendar: { source: cache.sources && cache.sources.calendar, sessionsInWindow: inWin.length, weekdayNonSessions: nonSessions, earlyCloses: early, oddHours, calendarMatchesReference,
      reference: { holidays: REF_HOLIDAYS, earlyCloses: REF_EARLY }, mine3 },
    days: { sessionDaysInWindow: B.sessionDaysInWindow, excludedWeekendGap: B.excluded.weekendGap.length, excludedNoPrevSession: B.excluded.noPrevSession.length, eligibleWeekdayToWeekday: B.days.length,
      missingBoundaryDays: B.missingBoundaryDays, population: B.pop.days.length, populationFirst: first ? first.date : null, populationLast: lastD ? lastD.date : null,
      earlyCloseDaysIncluded: B.pop.days.filter((x) => x.early).map((x) => x.date), afterEarlyCloseIncluded: B.pop.days.filter((x) => x.prevEarly).map((x) => x.date), weekdayHolidayGapsIncluded: holidayGaps,
      halves: { first: B.pop.days.filter((x) => x.date <= HALF1_TO).length, second: B.pop.days.filter((x) => x.date > HALF1_TO).length }, cannotMeasureBelow: MIN_DAYS },
    coins, ok };
}

// ── the read computation, pure (main writes OUT once); never run on the real cache except by --read ─────────────────────
function computeRead({ cache, sha, ctrl, entry, dec, bar, cfg = CFG }) {
  const B = buildPopulation(cache.calendar.sessions, cache.candles, { conv: "open", from: cfg.from, to: cfg.to }), pop = B.pop, n = pop.days.length;
  const either = !!dec.either, E = evaluate(pop, pop.R, { cfg }), J = decide(E, n, bar, dec.q, cfg.minDays, either), Jreg = !dec.amended ? J : decide(E, n, bar, "p95", cfg.minDays, false);
  const sel = J.selected, S = E[sel];
  const coinBlock = (c) => {
    const s = E[c], d = s._d, off = Array.from(s._off), on = Array.from(s._on), net = off.map((x) => Math.exp(x) - 1 - cfg.cost), shortOn = on.map((x) => 1 - Math.exp(x) - cfg.cost);
    const costs = Object.fromEntries(REPORTED_COSTS.map((k) => { const a = off.map((x) => Math.exp(x) - 1 - k); return [`rt${(100 * k).toFixed(2)}pct`, { meanPctPerDay: pct(mean(a)), t: r4(tStat(a)), winRatePct: r1((100 * a.filter((x) => x > 0).length) / a.length) }]; }));
    return { n: s.n, meanOffMinusOnLogPctPerDay: pct(s.mean), t: r4(s.t), tNW1: r4(nwT(d)), dayWinRatePct: r1((100 * d.filter((x) => x > 0).length) / d.length),
      driftNeutral: s._dAdj ? { note: "REPORTED ONLY, never gated: D minus its uniform-allocation expectation given the day total, = 2K(N-K)/N x (OFF/K - ON/(N-K)); mean 0 under no hours effect for ANY drift. The drift-kept scramble family is its exact null (controls file distributions.driftNeutralT*). A registered t that clears the bar while this does not is drift, not hours.",
        meanPctPerDay: pct(s.driftNeutralMean), t: r4(s.driftNeutralT), tNW1: r4(nwT(s._dAdj)) } : null,
      shortOnReported: { note: "REPORTED ONLY, never gated, not the registered tradeable version (Alpaca crypto cannot short): short the coin during NYSE hours, per day 1 - exp(ON) - round trip. An ON-side split (BTC falls during NYSE hours) is invisible to the long-OFF gate.",
        netAtRegisteredCostMeanPctPerDay: pct(mean(shortOn)), t: r4(tStat(shortOn)), grossMeanPctPerDay: pct(mean(on.map((x) => 1 - Math.exp(x)))) },
      meanOffLogPctPerDay: pct(mean(off)), meanOnLogPctPerDay: pct(mean(on)), tOff: r4(tStat(off)), tOn: r4(tStat(on)),
      halves: { firstPctPerDay: pct(s.halfFirst), firstN: s.nFirst, secondPctPerDay: pct(s.halfSecond), secondN: s.nSecond, split: `..${cfg.half1To} / after` },
      placebo: s.placebo ? { p95PctPerDay: pct(s.placebo.p95), p975PctPerDay: pct(s.placebo.p975), p50PctPerDay: pct(s.placebo.p50), meanOfDrawsPctPerDay: pct(s.placebo.meanOfDraws) } : null,
      longOff: { netAtRegisteredCostMeanPctPerDay: pct(s.longOffNet), tNet: r4(tStat(net)), tradeWinRatePct: r1((100 * net.filter((x) => x > 0).length) / net.length), byRoundTrip: costs },
      gatesIfSelected: gatesFor(s, n, bar, dec.q, cfg.minDays) };
  };
  const perCoin = Object.fromEntries(COINS.map((c) => [c, coinBlock(c)]));
  // sensitivities (REPORTED, never gated)
  const subset = (keep) => { const idx = pop.days.map((x, i) => (keep(x) ? i : -1)).filter((i) => i >= 0); return Object.fromEntries(COINS.map((c) => { const d = idx.map((i) => E[c]._d[i]); return [c, { n: d.length, meanPctPerDay: d.length ? pct(mean(d)) : null, t: r4(tStat(d)) }]; })); };
  const Bc = buildPopulation(cache.calendar.sessions, cache.candles, { conv: "closeBefore", from: cfg.from, to: cfg.to }), Ec = evaluate(Bc.pop, Bc.pop.R, { cfg, withPlacebo: false });
  const perYear = {}, perDow = {};
  pop.days.forEach((x, i) => { const y = x.date.slice(0, 4), w = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow(x.date)]; for (const [m, k] of [[perYear, y], [perDow, w]]) { (m[k] || (m[k] = Object.fromEntries(COINS.map((c) => [c, []])))); for (const c of COINS) m[k][c].push(E[c]._d[i]); } });
  const fold = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Object.fromEntries(COINS.map((c) => [c, { n: v[c].length, meanPctPerDay: pct(mean(v[c])), t: r4(tStat(v[c])) }]))]));
  // buy-and-hold over the population's own span vs long-OFF / long-ON compounded
  const bh = Object.fromEntries(COINS.map((c) => {
    if (!n) return [c, null];
    const idx = B.idx[c], p0 = priceAt(idx, pop.days[0].t0, "open"), p1 = priceAt(idx, pop.days[n - 1].tClose, "open"), off = Array.from(E[c]._off), on = Array.from(E[c]._on);
    const comp = (a) => a.reduce((acc, x) => acc * (1 + x), 1) - 1;
    return [c, { from: iso(pop.days[0].t0), to: iso(pop.days[n - 1].tClose), buyAndHoldSimple: r4(p1 / p0 - 1), longOffGrossCompounded: r4(comp(off.map((x) => Math.exp(x) - 1))),
      longOffNetCompoundedAtRegisteredCost: r4(comp(off.map((x) => Math.exp(x) - 1 - cfg.cost))), longOffNetCompoundedAtTaker050: r4(comp(off.map((x) => Math.exp(x) - 1 - 0.005))), longOnGrossCompounded: r4(comp(on.map((x) => Math.exp(x) - 1))) }];
  }));
  // where the 15-minute returns accrue (UTC quarter of day), bps per quarter, population spans only
  const tod = Object.fromEntries(COINS.map((c) => { const s = new Float64Array(96), k = new Uint32Array(96); pop.days.forEach((x, i) => { const r = pop.R[c][i]; for (let j = 0; j < r.length; j++) { const q = (((x.t0 + j * Q) % 864e5) / Q) | 0; s[q] += r[j]; k[q]++; } }); return [c, Array.from(s, (v, q) => (k[q] ? +((1e4 * v) / k[q]).toFixed(3) : null))]; }));
  let barCheck = { registered: bar, registeredForN: entry && entry.nExpected, observedN: n };
  if (n >= 3) { const { nullBar } = require("./lib/null-bar.js"); barCheck = { ...barCheck, nullBarAtObservedN: r3(nullBar({ variants: 2, n, trials: 20000, rng: mulberry(319) }).p95) }; barCheck.borderline = S.t != null && S.t >= bar && barCheck.nullBarAtObservedN != null && S.t < barCheck.nullBarAtObservedN; }
  const reported = {
    perCoin, anyVariantReading: { anyCoinClearsAllGates: J.anyVariantPass, coins: J.coinsClearingAllGates, higherTCoin: J.higherTCoin, inForce: either,
      note: either ? "IN FORCE by pre-read amendment (variants:either): PASS if any coin clears every gate; the registered higher-t-coin reading is in registeredGates" : "REPORTED ONLY: the registered reading gates the higher-t coin (best of 2); this is the either-coin reading (runner token variants:either), calibrated beside it in the controls file" },
    costs: { note: "long-OFF per day: exp(OFF) - 1 - round trip; registered 0.30% (Alpaca maker 0.15%/side); taker 0.25%/side = 0.50%", selected: perCoin[sel].longOff.byRoundTrip },
    earlyCloseDaysAndNextDayExcluded: { note: "drops sessions that close at 13:00 ET and the session after one (their ON / OFF lengths differ)", perCoin: subset((x) => !x.early && !x.prevEarly) },
    weekdayHolidayGapsExcluded: { note: "drops weekday-to-weekday gaps longer than one day (Wed->Fri etc.)", perCoin: subset((x) => x.gapDays === 1) },
    boundaryConventionCloseBefore: { note: "price at a boundary = close of the candle ending at it (last trade before T) instead of the first trade at/after T", perCoin: Object.fromEntries(COINS.map((c) => [c, { n: Ec[c].n, meanPctPerDay: pct(Ec[c].mean), t: r4(Ec[c].t), longOffNetPctPerDay: pct(Ec[c].longOffNet) }])) },
    perYear: fold(perYear), perWeekday: fold(perDow),
    buyAndHold: { note: "first population span start (prev NYSE close) to the last population close; long-OFF holds only the included OFF windows (no Fri->Mon), long-ON only the NYSE sessions of the included days", perCoin: bh },
    timeOfDayProfile: { note: "mean 15-minute log return by UTC quarter of day (index 0 = 00:00-00:15 UTC), basis points, population spans only", utcQuarterOfDay: tod },
    etfFlowDays: { available: false, note: "not split: no public no-login API history of daily spot-ETF flows (register-crypto3.js 2026-09-24); nothing fetched" },
    barCheck: { ...barCheck, note: "the registered bar applies unchanged; a t in [registered bar, the same method's bar at the observed n) is flagged borderline for the seal note" },
  };
  const placebo = { form: "per-day random OFF-length and ON-length windows inside the day's own span (registered)", draws: cfg.draws, seed: cfg.seed, quantileInForce: dec.q,
    p95: S.placebo ? S.placebo.p95 : null, p975: S.placebo ? S.placebo.p975 : null, observed: S.mean, beats: J.gates.placeboBeaten, beatsP95: S.placebo != null && S.mean != null && S.mean > S.placebo.p95,
    p95PctPerDay: S.placebo ? pct(S.placebo.p95) : null, observedPctPerDay: pct(S.mean), p50: S.placebo ? S.placebo.p50 : null, p05: S.placebo ? S.placebo.p05 : null, meanOfDraws: S.placebo ? S.placebo.meanOfDraws : null,
    method: "per day: an OFF-length window (start uniform on the 15-minute grid in [0, N-K]) and an ON-length window (start uniform in [0, K]) inside [close(prev), close(d)], independent; draw = mean over days of R(OFF') - R(ON'); identical placements for both coins" };
  const net = Array.from(S._off, (x) => Math.exp(x) - 1 - cfg.cost);
  const out = {
    id: ID, spec: "r319-read-v1", read: true, asOf: new Date().toISOString(), unit: "days", n, selected: sel,
    statistic: "PRIMARY = mean daily (OFF - ON) log return of the selected coin (gross, before cost), plain one-sample t over days; meanNet/tNet carry it (house field names)",
    tNet: r4(S.t), tNetRaw: S.t, meanNet: S.mean, meanNetPctPerDay: pct(S.mean), winRatePct: n ? r1((100 * net.filter((x) => x > 0).length) / n) : null,
    winRateNote: "share of the selected coin's long-OFF windows with net > 0 at the registered 0.30% round trip", dayWinRatePct: perCoin[sel].dayWinRatePct,
    longOffNet: { meanPctPerDay: pct(S.longOffNet), t: r4(tStat(net)), cost: cfg.cost }, placebo,
    halves: { first: { meanPctPerDay: pct(S.halfFirst), n: S.nFirst, to: cfg.half1To }, second: { meanPctPerDay: pct(S.halfSecond), n: S.nSecond } },
    gates: J.gates, failedGates: J.failed, verdictScript: J.verdictScript,
    verdictReason: verdictReasonOf(J), verdictReasonNote: "REPORTED ONLY (repair 2026-10-03): separates 'every statistical gate clears, fails only the long-OFF cost gate' (split measured, not tradeable long-only) from 'a statistical gate failed' (split not established). The registered DID NOT PASS text covers both.",
    ...(dec.amended ? { registeredGates: { selected: Jreg.selected, gates: Jreg.gates, failedGates: Jreg.failed, verdictScript: Jreg.verdictScript, verdictReason: verdictReasonOf(Jreg), note: "the registered decisionRule.pass (placebo p95, higher-t coin), reported beside the amended verdict" } } : {}),
    bar, barSource: "test-registry.json R319 bar.tRequired", preReadDecision: dec, gatesInForce: dec.amended ? `pre-read amendment ${JSON.stringify(dec.tokens)}` : "registered",
    controls: { boundaryLeakPass: !!(ctrl.boundaryLeakTest && ctrl.boundaryLeakTest.pass), nullCentringPlumbingPass: !!(ctrl.leakTest && ctrl.leakTest.pass), positivePass: !!(ctrl.positiveControl && ctrl.positiveControl.pass), wholeRuleFalsePassMaxInForce: ctrl.calibration && ctrl.calibration.maxWholeRuleFalsePassInForce,
      file: `backend/data/${path.basename(CTRL)}`, asOf: ctrl.asOf },
    reported, cache: { file: CACHE_REL, sha256: sha },
    coverage: { population: n, sessionDaysInWindow: B.sessionDaysInWindow, excludedWeekendGap: B.excluded.weekendGap.length, missingBoundaryDays: B.missingBoundaryDays.length, staleInteriorGridPoints: B.staleInterior },
    implementationNotes: [
      "Coinbase 15-minute candles (granularity 900): every NYSE boundary is a candle start; price at a boundary = open of the candle starting there (first trade at/after T). The registry allows 1-hour or finer; 1-hour cannot carry 13:30/14:30.",
      "Weekend gaps: a day whose previous session is separated by a Saturday or Sunday has no OFF and is not a day of the population (Mondays, Tuesdays after Monday holidays, Mondays after Good Friday / July 3). Weekday-holiday gaps (e.g. Wed->Fri) are weekday-to-weekday and included.",
      "Early-close sessions (13:00 ET) are included with their actual close (the registered 'the NYSE close'); reported.earlyCloseDaysAndNextDayExcluded drops them.",
      "Population = days on which BOTH coins have candles at all three boundaries (prev close, open, close); the CANNOT MEASURE count uses the same set.",
      either ? "Best of 2 read EITHER-COIN by pre-read amendment (variants:either): PASS if any coin clears every gate on its own numbers; the registered higher-t-coin reading is in registeredGates."
        : "Best of 2: every gate is judged on the higher-t coin (BTC on a tie); the either-coin reading is reported (anyVariantReading) and calibrated in the controls file, never gated.",
      "D = OFF - ON compares windows of unequal length, so drift leaks into it (E[D | day total S] = (2K/N - 1) S, 0.458 S on a normal day); perCoin.driftNeutral removes that and is REPORTED only.",
      "Long-OFF net = exp(OFF) - 1 - 0.0030 per included OFF window (simple return per trade); Friday-close -> Monday-open is never held.",
      "Placebo: per-day independent OFF-length / ON-length windows inside the day's own span; p95 = sorted[floor(0.95 * draws)]. Its own false-pass rate on no-edge data is in the controls file.",
    ],
  };
  const lines = [
    `R319 READ — ${J.verdictScript} (bar t >= ${bar}; placebo ${dec.q}${either ? ", either coin" : ""}${dec.amended ? ` by pre-read amendment; registered-gate verdict ${Jreg.verdictScript}` : ", registered"})`,
    `  reason (reported): ${verdictReasonOf(J)}`,
    `  selected ${sel} · days ${n} · mean(OFF-ON) ${pct(S.mean)}%/day · t ${r4(S.t)} · placebo p95 ${placebo.p95PctPerDay}% · halves ${pct(S.halfFirst)} / ${pct(S.halfSecond)} · long-OFF net ${pct(S.longOffNet)}%/day`,
    ...COINS.map((c) => `  ${c}: mean ${perCoin[c].meanOffMinusOnLogPctPerDay}%/day t ${perCoin[c].t} (OFF ${perCoin[c].meanOffLogPctPerDay} / ON ${perCoin[c].meanOnLogPctPerDay}) · long-OFF net ${perCoin[c].longOff.netAtRegisteredCostMeanPctPerDay}%/day · drift-neutral t ${perCoin[c].driftNeutral && perCoin[c].driftNeutral.t} (reported)`),
    `  gates ${JSON.stringify(J.gates)}`,
  ];
  return { out, lines };
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  let st; try { st = selftest(); } catch (e) { st = { pass: false, checks: {}, detail: { threw: e.stack || e.message } }; }      // a throwing selftest is a FAIL
  console.log(`R319 selftest ${st.pass ? "PASS" : "FAIL"} ${JSON.stringify(st.checks)}`);
  if (!st.pass) { console.log(`  detail ${JSON.stringify(st.detail)}`); process.exit(1); }
  if (SELFTEST_ONLY) return;

  if (!READ) {
    // CONTROLS RUN — builds the real population's 15-minute returns only to scramble them; summarises scrambles and planted / look-ahead
    // controls on scrambles. No statistic of the real OFF / ON split is computed or written.
    const { cache, sha, fetched } = await loadOrFetch(true);
    console.log(`R319 data ${fetched ? "fetched + cached" : "from cache"} — sha256 ${sha}`);
    const entry = registryEntry(), bar = entry && entry.bar ? Number(entry.bar.tRequired) : NaN;
    if (!entry) { console.error(`${ID} not registered — refusing`); process.exit(2); }
    if (!fin(bar)) { console.error(`${ID} registry entry has no numeric bar.tRequired — refusing`); process.exit(2); }
    const dec = preReadDecision(entry), q = dec.decided ? dec.q : "p95", either = dec.decided ? !!dec.either : false, inKey = gateKey(q, either);
    const B = buildPopulation(cache.calendar.sessions, cache.candles, { conv: "open" }), cov = coverageOf(cache, B), pop = B.pop;
    console.log(`R319 coverage — population ${pop.days.length} days (of ${cov.days.sessionDaysInWindow} sessions; ${cov.days.excludedWeekendGap} weekend-gap days excluded; ${cov.days.missingBoundaryDays.length} missing a boundary) · calendar vs reference ${cov.calendar.calendarMatchesReference} · vs mine3 ${cov.calendar.mine3.identical} · ${COINS.map((c) => `${c} ${cov.coins[c].candles} candles, span ${cov.coins[c].inPopulationSpanPct}%, longest gap ${cov.coins[c].longestMissingRunMinutes} min, stale ${cov.coins[c].staleInteriorGridPoints}`).join(" · ")}`);
    if (!cov.ok) console.log(`  COVERAGE NOT OK — ${JSON.stringify({ calendarMatchesReference: cov.calendar.calendarMatchesReference, nonSessions: cov.calendar.weekdayNonSessions, early: cov.calendar.earlyCloses, oddHours: cov.calendar.oddHours, mine3: cov.calendar.mine3, last: COINS.map((c) => cov.coins[c].last) })}`);
    // THE LEAK TEST: the real calendar with synthetic prices (no real candle)
    const boundaryLeak = boundaryLeakTest(cache.calendar.sessions);
    const t0 = Date.now(), fam = Object.fromEntries(FAMILIES.map(([m]) => [m, []])), R0 = pop.R;
    console.log(`R319 boundary leak test ${boundaryLeak.pass ? "PASS" : "FAIL"} — ${boundaryLeak.days} days, clock mismatches ${boundaryLeak.clockMismatchCount}, ${Object.entries(boundaryLeak.cases || {}).map(([k, v]) => `${k} ${v.pass ? "ok" : "FAIL"}`).join(" · ")}`);
    console.log(`R319 calibrating the WHOLE decision rule (gate set in force ${inKey}) on ${FAMILIES.map(([m, k]) => `${k} ${m}`).join(" + ")} (placebo ${PLACEBO_DRAWS} draws per coin each) ...`);
    for (const [mode, k] of FAMILIES) {
      for (let s = 1; s <= k; s++) { fam[mode].push(runFamilyRow(pop, scrambleR(pop, R0, s, mode), s, bar)); if (s % 100 === 0) console.log(`  ${mode} ${s}/${k} (${((Date.now() - t0) / 1000).toFixed(0)} s)`); }
    }
    const calibration = calibrate(fam, bar, q, Object.fromEntries(FAMILIES), either), leak = leakTestOf(fam.free, bar);
    // positive controls on drift-free scrambles: a planted OFF edge through the whole rule (gate set in force); the outcome look-ahead
    // subset is kept as a PLUMBING check only (t of the D > 0 days is >= 3 for any data at all)
    const posRows = []; for (let s = 1; s <= POS_SEEDS; s++) posRows.push(runFamilyRow(pop, plantOff(pop, scrambleR(pop, R0, s, "free"), POS_PLANT), s, bar));
    const posPass = posRows.filter((r) => r.J[inKey].verdictScript === "PASS").length / posRows.length;
    const la = evaluate(pop, scrambleR(pop, R0, 1, "free"), { withPlacebo: false }), laT = Object.fromEntries(COINS.map((c) => [c, tStat(la[c]._d.filter((x) => x > 0))]));
    const laOk = COINS.every((c) => laT[c] != null && laT[c] >= POS_LOOKAHEAD_T);
    const positiveControl = { method: `drift-free scramble seeds 1..${POS_SEEDS} with +${pct(POS_PLANT, 2)}% planted in every OFF window (spread evenly over its 15-minute returns), the whole rule (gate set in force) unchanged; plus the outcome look-ahead subset (scramble seed 1 days with OFF > ON)`,
      requirement: `whole-rule PASS on >= ${100 * POS_MIN_PASS}% of seeds AND look-ahead t >= ${POS_LOOKAHEAD_T} for each coin`, pass: posPass >= POS_MIN_PASS && laOk,
      lookAheadLabel: "PLUMBING CHECK: the t of the D > 0 subset is >= 3 for any data; it cannot catch a look-ahead bug. Boundary timing is guarded by selftest (c) and boundaryLeakTest.",
      plantedPassShare: r3(posPass), plantedDistributions: familyDists(posRows), plantedPerGate: familyStats(posRows, inKey).perGate, lookAheadT: Object.fromEntries(Object.entries(laT).map(([k, v]) => [k, r3(v)])) };
    // POWER (REPORTED only): planted hours effects on the unconditional sign-flip family, three shapes, every gate set
    const powerRow = (rows) => { const st2 = Object.fromEntries(GATE_KEYS.map(([qq, ei]) => [gateKey(qq, ei), familyStats(rows, gateKey(qq, ei))])), d = familyDists(rows);
      return { seeds: rows.length, wholeRulePassShareInForce: st2[inKey].wholeRuleFalsePass, wholeRulePassShareRegistered: st2.p95.wholeRuleFalsePass, wholeRulePassShareEither: st2["p95+either"].wholeRuleFalsePass,
        statisticalGatesAllClearShare: st2[inKey].gateSets.withoutCostGate, failsOnlyCostGateShare: st2[inKey].failsOnlyCostGate, perGate: st2[inKey].perGate, meanBestT: d.bestT.mean, medianBestT: d.bestT.p50 }; };
    const power = POWER_FORMS.map(([form, ox, nx]) => { const rows = []; for (let s = 1; s <= POWER_SEEDS; s++) rows.push(runFamilyRow(pop, plantForm(pop, scrambleR(pop, R0, s, "flip"), ox, nx), s, bar));
      return { form, offPctPerWindow: pct(ox, 2), onPctPerWindow: pct(nx, 2), dPctPerDay: pct(ox - nx, 2), ...powerRow(rows) }; });
    const powerLegacy = [0.002, 0.003, 0.004].map((x) => { const rows = []; for (let s = 1; s <= POS_SEEDS; s++) rows.push(runFamilyRow(pop, plantOff(pop, scrambleR(pop, R0, s, "free"), x), s, bar));
      return { form: "offOnly", family: "free (day totals fixed)", offPctPerWindow: pct(x, 2), ...powerRow(rows) }; });
    // DRIFT SENSITIVITY (REPORTED only): no hours effect, a uniform drift per quarter on the sign-flip family — every PASS is false
    const driftSens = DRIFT_PLANTS.map((mu) => { const rows = []; for (let s = 1; s <= POWER_SEEDS; s++) rows.push(runFamilyRow(pop, plantDrift(scrambleR(pop, R0, s, "flip"), mu), s, bar));
      const pr = powerRow(rows), d = familyDists(rows); return { driftPerQuarter: mu, driftPctPerNormalSpan: pct(mu * 96, 3), ...pr, falsePassInForce: pr.wholeRulePassShareInForce, driftNeutralTMeanBTC: d.driftNeutralTBTC && d.driftNeutralTBTC.mean, driftNeutralTMeanETH: d.driftNeutralTETH && d.driftNeutralTETH.mean }; });
    const ready = st.pass && cov.ok && boundaryLeak.pass && leak.pass && positiveControl.pass && calibration.ok && calibration.calibrated && dec.decided;
    const holdWhy = !cov.ok ? "coverage / calendar check failed" : !boundaryLeak.pass ? "boundary leak test failed" : !leak.pass ? "null-centring plumbing check failed" : !positiveControl.pass ? "positive control failed" : !calibration.ok ? "calibration incomplete"
      : !calibration.calibrated ? `whole-rule false pass ${calibration.maxWholeRuleFalsePassInForce} > ${MAX_WHOLE_RULE_FALSE_PASS} on a no-edge family — the read is held for a pre-evidence amendment` : !dec.decided ? `pre-read decision invalid (${dec.why})` : null;
    const proposedAmendment = calibration.ok && !calibration.calibrated && q === "p95" && !either && calibration.p975Calibrated ? { date: "2026-10-03", preEvidence: true, field: "controls.placebo / decisionRule.pass (placebo quantile)",
      was: "observed mean(OFF-ON) must beat the placebo p95", becomes: "observed mean(OFF-ON) must beat the placebo p97.5 (p95 still reported); every other gate unchanged",
      why: `controls run ${todayET()} ET: the registered whole rule false-passes ${calibration.maxWholeRuleFalsePassRegisteredP95} of the worst no-edge family (> ${MAX_WHOLE_RULE_FALSE_PASS}); with the placebo at p97.5 the worst family is ${calibration.maxWholeRuleFalsePassP975}`, runnerGates: ["placebo:p975"] } : null;
    // OPTIONAL (operator's pre-read choice, NOT required — the registered reading is calibrated): the either-coin reading of best-of-2
    const pw = (form, off) => power.find((p) => p.form === form && p.offPctPerWindow === off);
    const optionalAmendment = calibration.ok && calibration.eitherCalibrated && !either ? { date: "2026-10-03", preEvidence: true, field: "decisionRule.pass (which coin the gates are judged on, best of 2)",
      was: "every gate judged on the higher-t coin (BTC on a tie)", becomes: "PASS if ANY coin clears every gate on its own numbers (its own t >= the best-of-2 bar 1.958); the higher-t-coin reading reported beside it",
      why: `controls run ${todayET()} ET: the best-of-2 bar already covers the max over both coins, so 'any coin clears every gate' cannot exceed P(max t >= bar); measured whole-rule false pass of the either reading ${calibration.maxWholeRuleFalsePassEitherP95} (worst of ${FAMILIES.length} no-edge families) vs ${calibration.maxWholeRuleFalsePassRegisteredP95} registered; power (sign-flip, ${POWER_SEEDS} seeds) redistribute 0.20% ${pw("redistribute", 0.2) && pw("redistribute", 0.2).wholeRulePassShareRegistered} -> ${pw("redistribute", 0.2) && pw("redistribute", 0.2).wholeRulePassShareEither}, 0.30% ${pw("redistribute", 0.3) && pw("redistribute", 0.3).wholeRulePassShareRegistered} -> ${pw("redistribute", 0.3) && pw("redistribute", 0.3).wholeRulePassShareEither}. Operator's choice before the read; the registered reading is also calibrated.`,
      runnerGates: ["variants:either"] } : null;
    writeJsonAtomic(CTRL, { spec: "r319-controls-v1", id: ID, asOf: new Date().toISOString(), runner: { file: `backend/${path.basename(__filename)}`, sha256: sha256(fs.readFileSync(__filename)) },
      cache: { file: CACHE_REL, sha256: sha, fetchedAt: cache.fetchedAt, sources: cache.sources }, coverage: cov, selftest: st, bar, preReadDecision: dec, gateSetInForce: inKey,
      boundaryLeakTest: boundaryLeak, leakTest: leak, positiveControl,
      power: { note: `REPORTED ONLY: share of ${POWER_SEEDS} sign-flip scrambles (zero mean, real vol structure, day totals NOT fixed) with a planted hours effect that pass the whole rule. offOnly = + per OFF window; redistribute = moves x from ON into OFF (day total unchanged; D = 2x); onOnly = the coin falls during NYSE hours, a split long-OFF never touches — the registered long-OFF cost gate CANNOT pass it at any size, so a DID NOT PASS does not mean 'no split'; read verdictReason. statisticalGatesAllClearShare = every gate but the cost gate. The registered placebo absorbs part of an OFF-only effect (its OFF-length window overlaps the true OFF window ~81% on average, so its centre moves ~0.51x), which is why OFF-only shapes clear the placebo less often than redistribute / ON-only shapes of the same t.`,
        rows: power, legacyConditional: { note: "the builder's original table: OFF-only plants on drift-free within-span permutations, which fix each day's total — overstates power; kept for comparison", rows: powerLegacy } },
      driftSensitivity: { note: "REPORTED ONLY: NO hours effect, a uniform drift added to every 15-minute quarter of the sign-flip family; every PASS is FALSE. D = OFF - ON is not drift-neutral (E[D|S] = (2K/N - 1) S) and the placebo is the only gate against drift. The real weekday-span drift is what the drift-kept family carries (its false pass is in calibration.families.kept).", rows: driftSens },
      calibration, pass: boundaryLeak.pass && leak.pass && positiveControl.pass && cov.ok, ready, holdWhy, proposedAmendment, optionalAmendment,
      operatorOption: { tokens: RUNNER_GATES, where: "backend/data/test-registry.json, the R319 entry: append to amendments[] (create it) BEFORE the read, plus a dated change-registry entry; then re-run this controls mode", p975Calibrated: calibration.p975Calibrated, eitherCalibrated: calibration.eitherCalibrated },
      note: "Only scrambles (drift-kept / drift-free permutations, rotations, sign flips with and without the real drift), planted effects on scrambles, the outcome look-ahead subset of a scramble and the real calendar with synthetic prices are summarised; no statistic of the real OFF / ON split is computed or written." });
    const c = calibration, pc = (x) => (x == null ? null : +(100 * x).toFixed(1));
    console.log(`R319 null-centring plumbing check ${leak.pass ? "PASS" : "FAIL"} — mean t ${JSON.stringify(leak.meanT)} · best-of-2 >= ${bar} on ${pc(leak.bestOf2AtLeastBarShare)}%`);
    console.log(`R319 positive control ${positiveControl.pass ? "PASS" : "FAIL"} — planted +${pct(POS_PLANT, 2)}%/OFF window passes ${pc(posPass)}% · look-ahead (plumbing) t ${JSON.stringify(positiveControl.lookAheadT)}`);
    for (const [k] of FAMILIES) {
      const f = c.families[k];
      console.log(`  ${k.padEnd(9)} WHOLE RULE false pass ${f.inForce.passes}/${f.inForce.seeds} = ${pc(f.inForce.wholeRuleFalsePass)}% (${inKey}) · p95 ${pc(f.registeredP95.wholeRuleFalsePass)}% · p975 ${pc(f.placeboP975.wholeRuleFalsePass)}% · either ${pc(f.eitherP95.wholeRuleFalsePass)}% · either+p975 ${pc(f.eitherP975.wholeRuleFalsePass)}%`);
      console.log(`            per gate ${JSON.stringify(Object.fromEntries(Object.entries(f.inForce.perGate).map(([g, v]) => [g, pc(v)])))} · sets ${JSON.stringify(Object.fromEntries(Object.entries(f.inForce.gateSets).map(([g, v]) => [g, pc(v)])))}`);
      console.log(`            best t mean ${f.distributions.bestT.mean} sd ${f.distributions.bestT.sd} · t BTC/ETH mean ${f.distributions.tBTC.mean}/${f.distributions.tETH.mean} sd ${f.distributions.tBTC.sd}/${f.distributions.tETH.sd} · drift-neutral t mean ${f.distributions.driftNeutralTBTC.mean}/${f.distributions.driftNeutralTETH.mean} · long-OFF net %/day p50 ${f.distributions.selectedLongOffNetPctPerDay.p50} p95 ${f.distributions.selectedLongOffNetPctPerDay.p95}`);
    }
    console.log(`  power (sign-flip, ${POWER_SEEDS} seeds; registered / either / statistical gates only): ${power.map((p) => `${p.form} OFF ${p.offPctPerWindow} ON ${p.onPctPerWindow} -> ${pc(p.wholeRulePassShareRegistered)}% / ${pc(p.wholeRulePassShareEither)}% / ${pc(p.statisticalGatesAllClearShare)}% (mean best t ${p.meanBestT})`).join(" · ")}`);
    console.log(`  legacy power (free, day totals fixed): ${powerLegacy.map((p) => `+${p.offPctPerWindow}% -> ${pc(p.wholeRulePassShareRegistered)}%`).join(" · ")}`);
    console.log(`  drift sensitivity (no hours effect, false pass registered / either): ${driftSens.map((p) => `${p.driftPerQuarter}/q (${p.driftPctPerNormalSpan}%/span) -> ${pc(p.wholeRulePassShareRegistered)}% / ${pc(p.wholeRulePassShareEither)}%`).join(" · ")}`);
    console.log(`  pre-read decision: ${dec.decided ? JSON.stringify(dec.tokens) : `INVALID — ${dec.why}`} · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    if (proposedAmendment) console.log(`  PROPOSED AMENDMENT ${JSON.stringify(proposedAmendment)}`);
    if (optionalAmendment) console.log(`  OPTIONAL AMENDMENT (operator's choice, not required) ${JSON.stringify(optionalAmendment)}`);
    console.log(ready ? `R319 READY — the one read is: node backend/${path.basename(__filename)} --read` : `R319 NOT READY — ${holdWhy}`);
    return;
  }

  // ── THE READ (once) ──
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if ((seals.tests || {})[ID]) { console.error(`${ID} already sealed — refusing`); process.exit(2); }
  if (fs.existsSync(OUT) && JSON.parse(fs.readFileSync(OUT, "utf8")).read) { console.error(`${ID} already read — seal it, do not re-read`); process.exit(2); }
  const entry = registryEntry(); if (!entry) { console.error(`${ID} not registered — refusing`); process.exit(2); }
  if (todayET() < READABLE_FROM_ET) { console.error(`${ID} not yet readable — the window ends ${WINDOW_TO}; readable from ${READABLE_FROM_ET} ET`); process.exit(2); }
  const ctrl = fs.existsSync(CTRL) ? JSON.parse(fs.readFileSync(CTRL, "utf8")) : null;
  if (!ctrl || ctrl.spec !== "r319-controls-v1" || !ctrl.pass || !ctrl.ready) { console.error(`${ID} controls not READY (or no controls file) — run the controls mode first`); process.exit(2); }
  const runnerSha = sha256(fs.readFileSync(__filename));
  if (!ctrl.runner || ctrl.runner.sha256 !== runnerSha) { console.error(`${ID} controls were produced by a different runner (${ctrl.runner && ctrl.runner.sha256} vs ${runnerSha}) — re-run the controls`); process.exit(2); }
  const bar = Number(entry.bar && entry.bar.tRequired); if (!fin(bar)) { console.error(`${ID} registry entry has no numeric bar.tRequired`); process.exit(2); }
  if (ctrl.bar !== bar || !ctrl.calibration || ctrl.calibration.bar !== bar) { console.error(`${ID} controls calibrated at bar ${ctrl.bar}, registry says ${bar} — re-run the controls`); process.exit(2); }
  const dec = preReadDecision(entry); if (!dec.decided) { console.error(`${ID} read HELD — ${dec.why}`); process.exit(2); }
  if (JSON.stringify(ctrl.preReadDecision && ctrl.preReadDecision.tokens) !== JSON.stringify(dec.tokens) || ctrl.calibration.q !== dec.q || !!ctrl.calibration.either !== !!dec.either || ctrl.calibration.gateSet !== gateKey(dec.q, !!dec.either)) { console.error(`${ID} the registry's gate tokens changed since the controls run — re-run the controls`); process.exit(2); }
  if (!ctrl.calibration.ok || !ctrl.calibration.calibrated) { console.error(`${ID} read HELD — the whole decision rule false-passes ${ctrl.calibration.maxWholeRuleFalsePassInForce} of a no-edge family (> ${MAX_WHOLE_RULE_FALSE_PASS}); a pre-evidence amendment is required`); process.exit(2); }
  const { cache, sha } = await loadOrFetch(false);
  if (!ctrl.cache || ctrl.cache.sha256 !== sha) { console.error(`${ID} cache sha256 ${sha} differs from the controls run's ${ctrl.cache && ctrl.cache.sha256} — refusing`); process.exit(2); }
  if (!COINS.every((c) => (cache.candles[c] || []).length && cache.candles[c][cache.candles[c].length - 1][0] === FETCH_TO_MS - Q)) { console.error(`${ID} not yet readable — the cache does not reach the last candle of ${WINDOW_TO}`); process.exit(2); }
  const { out, lines } = computeRead({ cache, sha, ctrl, entry, dec, bar });
  writeJsonAtomic(OUT, out);
  for (const l of lines) console.log(l);
}
// Run only when invoked directly. A require() gets the pure functions and never reaches main: no fetch, no write.
if (require.main === module) main().catch((e) => { console.error("R319 FAILED:", e.stack || e.message); process.exit(1); });
else module.exports = { etToUtcMs, normalizeSessions, buildDays, enclosesWeekend, spanLogPrices, buildPopulation, priceAt, cbRow, packRows, dayVals, coinSummary, placeboRun, evaluate, selectCoin,
  gatesFor, decide, preReadDecision, scrambleR, plantOff, plantForm, plantDrift, runFamilyRow, rowOf, calibrate, familyStats, familyDists, leakTestOf, boundaryLeakTest, usDstOn, verdictReasonOf, driftNeutralOf, gateKey,
  coverageOf, computeRead, selftest, tStat, nwT, mulberry, RUNNER_GATES, COINS, CFG, CACHE, COST, MIN_DAYS, FAMILIES, POWER_FORMS, fin };
