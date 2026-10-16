#!/usr/bin/env node
/**
 * R324 — COUNTRY-ETF MOMENTUM (registered 2026-10-05; the frozen spec is the R324 entry of data/test-registry.json). This runner
 * implements that entry and nothing else. Harness discipline copied from r313-ibs-etfs.js: selftest -> controls run -> one --read.
 *
 *   UNIVERSE (fixed, 21) EWJ EWG EWU EWQ EWI EWP EWL EWN EWD EWK EWO EWC EWA EWH EWS EWT EWY EWM EWZ EWW EZA (checked against the
 *            registry rule text at every run; a mismatch refuses). EFA and SPY are fetched for the REPORTED vs-index block only.
 *   DATA     Schwab marketdata/v1/pricehistory, daily, one call per ETF (lib/schwab.js token, read-only GET), split-adjusted price
 *            only (no dividends). Requested 1999-01-01 .. 2026-10-02 (the last complete session before this build, Mon 2026-10-05
 *            10:14 ET); bars dated after 2026-10-02 are dropped (forming-bar guard) and counted. Cached ONCE under
 *            data/training/r324/; the cache sha256 is written into the controls file and the read refuses on a mismatch.
 *   MONTHS   Reference calendar = weekdays on which more than half of the 21 ETFs spanning that date have a bar (R313). The month-end
 *            of month M = the last reference session of M; M is complete only when a reference session exists in a later month
 *            (so 2026-10 is excluded). An ETF's month-end close = its last bar dated on or before that session INSIDE month M
 *            (a missing final session gives a stale close, counted); no bar in M after the ETF's first month-end = a gap.
 *   RULE     ELIGIBLE at month-end m: month-end closes at m-12 .. m (13 month-ends). MOM = close(m-1) / close(m-12) - 1.
 *            PORTFOLIO = the top floor(n/3) (at least 3; n if n < 3) eligible ETFs by MOM (ties: universe order), equal weight,
 *            bought at the close of m, held to the close of m+1. BENCHMARK = all eligible, equal weight, same month.
 *            Decisions 2000-12 .. 2026-08 -> holding months 2001-01 .. 2026-09 (309).
 *   COST     0.10% per unit of ONE-WAY turnover, tau = 0.5 * sum_i |w_target_i - w_drift_i| (the house convention of svrz-turnover.js:
 *            one-way tau = the fraction of the book replaced); w_drift = last month's weights grown by each ETF's return. The first
 *            month is bought from cash (tau = 1, identical for portfolio and benchmark). Charged to the holding month the rebalance
 *            starts: net = gross - 0.0010 * tau. The benchmark's own drift rebalance (and entries of newly eligible ETFs) is charged
 *            the same way. The per-side reading (0.10% on every unit bought AND sold = 0.20% per unit of tau) is the REPORTED
 *            "at 0.20% cost" block.
 *   STAT     monthly net excess = portfolio net - benchmark net; mean and Newey-West t, lag 3, Bartlett weights (the registry's own
 *            bar method: register-r324.js nwT(a, 3); the selftest reproduces its bar 1.662 from seed 324).
 *   GATES    (registry decisionRule) >= 240 months AND >= 15 of 21 ETFs with Schwab history from 2000 (else CANNOT MEASURE),
 *            mean > 0, t_NW >= bar (READ FROM THE REGISTRY), random-selection placebo p95 beaten (1,000 draws, seed 324, same k per
 *            month, same costs), both halves (holding months 2001-01..2013-12 / 2014-01..2026-09) > 0, post-2009 (holding months
 *            from 2009-07) mean > 0, calibration passed, positive control passed (a failed control = CANNOT MEASURE).
 *   CONTROLS positive control (top third by the NEXT month's realised return — look-ahead: t_NW >= 3), leak test (drift-free
 *            constructions seeds 1, 2: t_NW < 2; and a structural no-look-ahead check on a construction — the real leak guard), and the WHOLE decision
 *            rule calibrated on 400 registered no-edge constructions (>= 60 required): each ETF's monthly returns shuffled across
 *            months with the cross-section kept per month — one joint permutation of month vectors, applied within each
 *            availability stratum (months with the same set of ETFs priced) so that eligibility is identical to the real panel.
 *            The constructions keep each ETF's own mean (drift kept). 1,000 drift-free constructions (each ETF's log returns demeaned
 *            to the stratum's pooled mean WITHIN each availability stratum, then whole month vectors drawn WITH replacement inside
 *            the stratum — a permutation without replacement builds a negative autocorrelation into a 12-1 momentum statistic) and
 *            100 independent per-ETF shuffles (each ETF permuted on its own WITHIN each stratum; cross-section NOT kept) are
 *            REPORTED beside them. Whole-rule false pass on the registered constructions must be <= 5% or the read is held for a
 *            dated pre-evidence amendment. (Drift-free raised to 1,000 seeds 2026-10-05: at 100 seeds its reported rate sat on the
 *            5% line by sampling noise alone — 5/100 — against 3.8% over 1,000; REPORTED only, the gate is unchanged.)
 *   REPORTED (never gated; repair 2026-10-05) the ex-motivating window (holding months before 2026-01: the 2026 EWY/EWT run
 *            prompted the registration, weight zero by house rule), a turnover-matched random-selection p95 (random picks
 *            charged the momentum book's own tau; same rng stream, so the registered p95 is unchanged), and a seal-note block
 *            stating whether a PASS survives the ex-2026 cut and the 0.20% cost. Amendments without runnerGates hold the read
 *            unless marked runnerNoop: true (fail closed).
 *   FENCE    The controls run never computes the momentum strategy on the real panel: only constructions, the look-ahead positive
 *            control and the equal-weight benchmark it is measured against. The read computation is dry-run on a construction.
 *
 *   node backend/r324-country-momentum.js --selftest | (no flag: controls run, prints READY / NOT READY) | --read
 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const ID = "R324", STEM = "r324-country-momentum", READ = process.argv.includes("--read"), SELFTEST_ONLY = process.argv.includes("--selftest");
const OUT = D(`${STEM}.json`), CTRL = D(`${STEM}-controls.json`);
const CACHE_NAME = "bars-schwab-daily-19990101-20261002.json", CACHE_DIR = path.join(__dirname, "data", "training", "r324"), CACHE = path.join(CACHE_DIR, CACHE_NAME);
const CACHE_REL = `backend/data/training/r324/${CACHE_NAME}`;
const R313_CACHE = path.join(__dirname, "data", "training", "r313", "bars-schwab-daily-19990101-20261001.json");
const FETCH_START = "1999-01-01", LAST_BAR = "2026-10-02", START_MS = Date.parse("1999-01-01T00:00:00Z"), END_MS = Date.parse("2026-10-02T23:59:59Z");
const FIRST_DECISION = "2000-12", LAST_DECISION = "2026-08", FIRST_HOLD = "2001-01", LAST_HOLD = "2026-09", HALF2_FROM = "2014-01", POST2009_FROM = "2009-07";
const MOTIVATING_FROM = "2026-01";   // REPORTED ex-motivating cut: holding months >= this prompted the registration (EWY +97% YTD) — weight zero, never gated
const preMotivatingIdx = (holds) => holds.map((k, q) => (k < MOTIVATING_FROM ? q : -1)).filter((q) => q >= 0);
const LOOKBACK = 12, SKIP = 1, NEED = 13, NW_LAG = 3, N_EXPECTED = 309;
const COST = 0.0010, COST_2X = 0.0020, MIN_MONTHS = 240, MIN_ETFS_FROM_2000 = 15, HISTORY_FROM_2000_BY = "2000-12-31";
const PLACEBO_DRAWS = 1000, PLACEBO_SEED = 324, POSITIVE_T = 3, LEAK_T = 2;
const CAL_SEEDS = 400, FREE_SEEDS = 1000, INDEP_SEEDS = 100, MIN_CAL_SEEDS = 60, MAX_WHOLE_RULE_FALSE_PASS = 0.05;
const UNIVERSE = "EWJ EWG EWU EWQ EWI EWP EWL EWN EWD EWK EWO EWC EWA EWH EWS EWT EWY EWM EWZ EWW EZA".split(" ");
const REPORTED_ONLY = ["EFA", "SPY"];
// Pre-read amendment tokens this runner honours (registry R324 entry: amendments[] { date, preEvidence: true, field, was, becomes,
// why, runnerGates: [...] }). None is defined: with no runnerGates amendment the REGISTERED gates are in force. Any runnerGates
// amendment names a token this runner does not define and therefore HOLDS the read (fail closed).
const RUNNER_GATES = {};
const fin = Number.isFinite;
const r4 = (x) => (x == null || !fin(x) ? null : +x.toFixed(4)), r3 = (x) => (x == null || !fin(x) ? null : +x.toFixed(3)), r1 = (x) => (x == null || !fin(x) ? null : +x.toFixed(1));
const pct = (x) => (x == null || !fin(x) ? null : +(100 * x).toFixed(4));

// ── statistics ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const mean = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / a.length; };
// Newey-West t, Bartlett weights 1 - l/(L+1), variance divisor n — register-r324.js nwT(a, 3) verbatim plus null guards.
function nwT(a, L = NW_LAG) {
  const n = a.length; if (n < L + 2) return null;
  const m = mean(a), d = Array.from(a, (x) => x - m); let v = 0; for (let i = 0; i < n; i++) v += d[i] * d[i]; v /= n;
  for (let l = 1; l <= L; l++) { let c = 0; for (let i = l; i < n; i++) c += d[i] * d[i - l]; v += 2 * (1 - l / (L + 1)) * c / n; }
  return v > 0 ? m / Math.sqrt(v / n) : null;
}
function nearestRank(sorted, q) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] : null; }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hash = (s) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const srt = (a) => Array.from(a).filter(fin).sort((x, y) => x - y);
const nullRank = (vals, x) => { const v = vals.filter(fin); return x == null || !fin(x) || !v.length ? null : r3(v.filter((y) => y < x).length / v.length); };
// The registry's bar method at n (NW lag-3 t on uniform noise, seed 324, 50k trials — register-r324.js; iid nullBar beside it)
function nwSimP95(n, seed = 324, T = 50000) { const rng = mulberry(seed), mx = new Array(T); for (let k = 0; k < T; k++) { const s = new Array(n); for (let i = 0; i < n; i++) s[i] = rng() * 2 - 1; mx[k] = nwT(s, NW_LAG); } mx.sort((a, b) => a - b); return mx[Math.floor(0.95 * T)]; }
function barAtN(n) { const nw = nwSimP95(n), { nullBar } = require("./lib/null-bar.js"), iid = nullBar({ variants: 1, n, trials: 20000, rng: mulberry(324) }).p95; return { n, nwSim: r3(nw), iid: r3(iid), bar: r3(Math.max(nw, iid)) }; }

// ── data: Schwab daily, one call per ETF, cached once, hashed (R313 pattern) ──────────────────────────────────────────────
const NY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
// Schwab daily candles are stamped at local midnight (00:00 ET or 00:00 CT = 01:00 ET). Any other stamp could shift the date -> throw.
function schwabDate(ms) {
  const p = Object.fromEntries(NY.formatToParts(new Date(ms)).map((x) => [x.type, x.value])), hr = +p.hour;
  if (!(hr >= 0 && hr <= 1)) throw new Error(`candle stamped ${new Date(ms).toISOString()} (${hr}:00 ET) — not a midnight daily stamp; refusing to guess its date`);
  return `${p.year}-${p.month}-${p.day}`;
}
const isWeekend = (d) => { const g = new Date(String(d).slice(0, 10) + "T12:00:00Z").getUTCDay(); return g === 0 || g === 6; };
function packRows(sym, candles) {
  const bars = candles.map((x) => ({ d: schwabDate(x.datetime), o: x.open, h: x.high, l: x.low, c: x.close, v: x.volume }));
  let prev = "", droppedAfterLastBar = 0, droppedBeforeStart = 0, pc = null; const rows = [], flags = { highBelowLow: 0, closeOutsideRange: 0, zeroVolume: 0, weekend: 0, dailyMoveOver50pct: [] };
  for (const b of bars) {
    if (![b.o, b.h, b.l, b.c].every((x) => fin(x) && x > 0)) throw new Error(`${sym}: non-finite or non-positive price on ${b.d}`);
    if (b.d <= prev) throw new Error(`${sym}: dates not strictly increasing at ${b.d}`);
    prev = b.d;
    if (b.d < FETCH_START) { droppedBeforeStart++; continue; }                       // Schwab returns the 1998-12-31 session for a 1999-01-01 start
    if (b.d > LAST_BAR) { droppedAfterLastBar++; continue; }                        // forming-bar guard: never past the last complete bar
    if (b.h < b.l) flags.highBelowLow++; if (b.c > b.h || b.c < b.l) flags.closeOutsideRange++; if (!(b.v > 0)) flags.zeroVolume++; if (isWeekend(b.d)) flags.weekend++;
    if (pc != null && Math.abs(b.c / pc - 1) > 0.5) flags.dailyMoveOver50pct.push(b.d); pc = b.c;   // a gross one-session move is a data defect until shown otherwise
    rows.push([b.d, b.o, b.h, b.l, b.c, fin(b.v) ? b.v : null]);
  }
  return { rows, droppedAfterLastBar, droppedBeforeStart, flags };
}
async function fetchDaily(sym, tok) {
  const u = `https://api.schwabapi.com/marketdata/v1/pricehistory?symbol=${encodeURIComponent(sym)}&periodType=year&period=20&frequencyType=daily&frequency=1&startDate=${START_MS}&endDate=${END_MS}&needExtendedHoursData=false`;
  for (let a = 0; a < 4; a++) {
    const r = await fetch(u, { headers: { Authorization: "Bearer " + tok }, signal: AbortSignal.timeout(60000) });
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 15000 * (a + 1))); continue; }
    if (!r.ok) throw new Error(`${sym} pricehistory HTTP ${r.status}`);
    const j = await r.json();
    if (!Array.isArray(j.candles) || !j.candles.length) throw new Error(`${sym} pricehistory returned no candles`);
    return j.candles;
  }
  throw new Error(`${sym} pricehistory rate-limited 4 times`);
}
async function loadOrFetch(allowFetch) {
  if (fs.existsSync(CACHE)) {
    const buf = fs.readFileSync(CACHE), j = JSON.parse(buf.toString("utf8"));
    if (j.spec !== "r324-bars-cache-v1" || j.start !== FETCH_START || j.lastCompleteBar !== LAST_BAR || JSON.stringify(j.universe) !== JSON.stringify(UNIVERSE)) throw new Error("cache metadata does not match the R324 spec — refusing to use it");
    return { cache: j, sha: sha256(buf), fetched: false };
  }
  if (!allowFetch) throw new Error(`bar cache missing (${CACHE_REL}) — the controls run creates it; the read never refetches`);
  const schwab = require("./lib/schwab.js"), tok = await schwab.token();      // loaded only here: the selftest never touches the network or .env
  const rows = {}, coverage = {}, missing = [];
  for (const sym of [...UNIVERSE, ...REPORTED_ONLY]) {
    try {
      const pk = packRows(sym, await fetchDaily(sym, tok));
      if (!pk.rows.length) throw new Error("no bars on or before the last complete bar");
      rows[sym] = pk.rows;
      coverage[sym] = { firstBar: pk.rows[0][0], lastBar: pk.rows[pk.rows.length - 1][0], bars: pk.rows.length, droppedAfterLastBar: pk.droppedAfterLastBar, droppedBeforeStart: pk.droppedBeforeStart, flags: pk.flags };
      console.log(`  ${sym} ${pk.rows.length} bars ${coverage[sym].firstBar} .. ${coverage[sym].lastBar}${pk.droppedAfterLastBar ? ` · ${pk.droppedAfterLastBar} after ${LAST_BAR} dropped` : ""}`);
    } catch (e) { missing.push({ sym, error: e.message }); console.log(`  ${sym} MISSING — ${e.message}`); }
  }
  const gatedMissing = missing.filter((m) => UNIVERSE.includes(m.sym));        // fail closed: a partial universe is never cached
  if (gatedMissing.length) throw new Error(`universe ETFs not priced: ${gatedMissing.map((m) => m.sym).join(" ")} — nothing cached`);
  const obj = { spec: "r324-bars-cache-v1", id: ID, fetchedAt: new Date().toISOString(), source: "Schwab marketdata/v1/pricehistory (lib/schwab.js token; read-only GET), daily, split-adjusted, price only",
    request: { periodType: "year", period: 20, frequencyType: "daily", frequency: 1, startDate: START_MS, endDate: END_MS, needExtendedHoursData: false },
    start: FETCH_START, lastCompleteBar: LAST_BAR, universe: UNIVERSE, reportedOnly: REPORTED_ONLY, returned: Object.keys(rows), missing, coverage,
    rowsFormat: "[date (America/New_York), o, h, l, c, v]", rows };
  fs.mkdirSync(CACHE_DIR, { recursive: true }); writeJsonAtomic(CACHE, obj, { pretty: 0 });
  const buf = fs.readFileSync(CACHE);
  return { cache: JSON.parse(buf.toString("utf8")), sha: sha256(buf), fetched: true };
}

// ── month-end panel from daily bars ──────────────────────────────────────────────────────────────────────────────────────
// Reference sessions: weekdays on which more than half of the gated ETFs whose span covers that date have a bar (R313's calendar).
function referenceSessions(rowsBySym) {
  const syms = Object.keys(rowsBySym), count = new Map(), spans = syms.map((s) => [rowsBySym[s][0][0], rowsBySym[s][rowsBySym[s].length - 1][0]]);
  for (const s of syms) for (const x of rowsBySym[s]) if (!isWeekend(x[0])) count.set(x[0], (count.get(x[0]) || 0) + 1);
  return [...count.keys()].filter((d) => 2 * count.get(d) > spans.filter(([f, l]) => f <= d && l >= d).length).sort();
}
// rowsBySym: { sym: [[d,o,h,l,c,v], ...] } (raw; weekend rows are dropped here). gated: the symbols that define the calendar.
function buildPanel(rowsBySym, gated, all = Object.keys(rowsBySym)) {
  const clean = Object.fromEntries(all.map((s) => [s, rowsBySym[s].filter((x) => !isWeekend(x[0]))]));
  const ref = referenceSessions(Object.fromEntries(gated.map((s) => [s, clean[s]])));
  const lastMonth = ref[ref.length - 1].slice(0, 7), me = new Map();
  for (const d of ref) me.set(d.slice(0, 7), d);                                  // sorted: the last session of each month wins
  const keys = [...me.keys()].filter((k) => k < lastMonth).sort(), meDates = keys.map((k) => me.get(k));   // complete months only
  const C = {}, barDate = {}, stale = {}, gaps = {}, firstMonthEnd = {}, missingSessions = {}, weekendRows = {};
  for (const s of all) {
    const r = clean[s], c = new Float64Array(keys.length).fill(NaN), bd = new Array(keys.length).fill(null); let j = 0;
    for (let q = 0; q < keys.length; q++) {
      while (j < r.length && r[j][0] <= meDates[q]) j++;
      const last = j > 0 ? r[j - 1] : null;
      if (last && last[0].slice(0, 7) === keys[q]) { c[q] = last[4]; bd[q] = last[0]; }
    }
    C[s] = c; barDate[s] = bd;
    const f = c.findIndex((x) => fin(x)); firstMonthEnd[s] = f >= 0 ? keys[f] : null;
    stale[s] = keys.filter((k, q) => bd[q] !== null && bd[q] !== meDates[q]);
    gaps[s] = f < 0 ? [] : keys.filter((k, q) => q > f && !fin(c[q]));
    const have = new Set(r.map((x) => x[0])), f0 = r.length ? r[0][0] : "9999", l0 = r.length ? r[r.length - 1][0] : "0000";
    missingSessions[s] = ref.filter((d) => d >= f0 && d <= l0 && !have.has(d));
    weekendRows[s] = rowsBySym[s].filter((x) => isWeekend(x[0])).map((x) => x[0]);
  }
  return { keys, meDates, referenceSessions: ref.length, lastReferenceSession: ref[ref.length - 1], C, barDate, stale, gaps, firstMonthEnd, missingSessions, weekendRows };
}
// End of an additive price adjustment (R313 diagnostic): before it every close carries one constant sub-half-cent tail.
// LOWER BOUND: the tail is read modulo $0.005, so an offset that is a multiple of $0.005 is invisible to this detector.
const tailOf = (p) => Math.round(p * 1e6) % 5000;
const ADDITIVE_NOTE = "additiveAdjustmentEnds is a LOWER BOUND: the detector reads close tails modulo $0.005, so an additive offset that is a multiple of $0.005 is undetectable; offset sizes are known only modulo $0.005. An additive offset c scales every pre-boundary return by P/(P-c) — it amplifies whatever the rule earns on that ETF but creates no edge in expectation.";
// Gross one-session close-to-close moves (> 50%) on weekday rows of the cached bars — disclosure (e.g. EWM 1999 fractional prices).
function dailyMovesOf(rows, lim = 0.5) { const r = rows.filter((x) => !isWeekend(x[0])), out = []; for (let i = 1; i < r.length; i++) { const x = r[i][4] / r[i - 1][4] - 1; if (Math.abs(x) > lim) out.push({ d: r[i][0], prev: r[i - 1][0], closeRet: +x.toFixed(4) }); } return out; }
function modeShare(a) { const m = new Map(); let best = null, n = 0; for (const x of a) { const k = (m.get(x) || 0) + 1; m.set(x, k); if (k > n) { n = k; best = x; } } return { r: best, share: a.length ? n / a.length : 0 }; }
function additiveBreaksOf(rows, before = 60, after = 20) {
  const r = rows.filter((x) => !isWeekend(x[0])), c = r.map((x) => tailOf(x[4])), out = [];
  for (let i = before; i + after <= r.length; i++) {
    if (c[i] === c[i - 1]) continue;
    const A = modeShare(c.slice(i - before, i)), B = modeShare(c.slice(i, i + after));
    if (A.share >= 0.9 && B.share >= 0.9 && A.r !== B.r && c[i - 1] === A.r && c[i] === B.r) out.push({ lastOffsetBar: r[i - 1][0], nextBar: r[i][0], closeRet: +(r[i][4] / r[i - 1][4] - 1).toFixed(5) });
  }
  return out;
}

// ── the rule ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const kTop = (n) => Math.min(n, Math.max(3, Math.floor(n / 3)));            // top third: floor(n/3), at least 3 (n when n < 3)
const kTopQuintile = (n) => Math.min(n, Math.max(3, Math.floor(n / 5)));    // REPORTED quintile analogue
function eligibleAt(C, m, need = NEED) {
  const out = [];
  for (let i = 0; i < C.length; i++) { let ok = m - need + 1 >= 0; for (let t = m - need + 1; ok && t <= m; t++) ok = fin(C[i][t]) && C[i][t] > 0; if (ok) out.push(i); }
  return out;
}
const momOf = (C, i, m, L = LOOKBACK, skip = SKIP) => C[i][m - skip] / C[i][m - L] - 1;
// Per decision month m (from..to): eligible set, holding returns m -> m+1, MOM, rank order (MOM desc, ties by universe order).
function prepBook(C, keys, { L = LOOKBACK, skip = SKIP, need = NEED, from = FIRST_DECISION, to = LAST_DECISION } = {}) {
  if (!(L < need && skip >= 0 && skip < L)) throw new Error(`lookback ${L}-${skip} does not fit inside the ${need}-month eligibility window`);
  const N = C.length, m0 = keys.indexOf(from), m1 = keys.indexOf(to), months = [], defects = [];
  if (m0 < 0 || m1 < 0 || m1 < m0 || m1 + 1 >= keys.length) throw new Error(`decision months ${from}..${to} not inside the panel (${keys[0]}..${keys[keys.length - 1]})`);
  for (let m = m0; m <= m1; m++) {
    const elig = eligibleAt(C, m, need), ret = new Float64Array(N).fill(NaN), mom = new Float64Array(N).fill(NaN);
    for (const i of elig) { ret[i] = C[i][m + 1] / C[i][m] - 1; mom[i] = momOf(C, i, m, L, skip); if (!fin(ret[i])) defects.push({ i, decided: keys[m] }); }
    const order = elig.slice().sort((a, b) => mom[b] - mom[a] || a - b);
    months.push({ m, decided: keys[m], hold: keys[m + 1], elig: Int32Array.from(elig), n: elig.length, k: kTop(elig.length), ret, mom, order: Int32Array.from(order) });
  }
  return { N, months, defects };
}
// One book: equal weight over the picks, rebalanced every month-end; drifted weights carried; cost per unit of one-way turnover.
// pick(mo, sel, q) writes the picks into sel[0..k) and returns k. The first month is bought from cash (tau = 1).
function runBook(P, pick, cost, rec = null) {
  const N = P.N, M = P.months.length, wD = new Float64Array(N), mark = new Uint8Array(N), sel = new Int32Array(N), prev = new Int32Array(N);
  const net = new Float64Array(M), gross = new Float64Array(M), tau = new Float64Array(M), kk = new Int32Array(M); let kp = -1;
  for (let q = 0; q < M; q++) {
    const mo = P.months[q], k = pick(mo, sel, q);
    if (!(k >= 1 && k <= mo.n)) throw new Error(`pick returned ${k} of ${mo.n} eligible at ${mo.decided}`);
    const w = 1 / k; let t = 0;
    if (kp < 0) t = 1;
    else {
      for (let j = 0; j < k; j++) { const i = sel[j]; if (mark[i]) throw new Error(`duplicate pick ${i} at ${mo.decided}`); mark[i] = 1; t += Math.abs(w - wD[i]); }
      for (let j = 0; j < kp; j++) { const i = prev[j]; if (!mark[i]) t += wD[i]; }
      for (let j = 0; j < k; j++) mark[sel[j]] = 0;
      t /= 2;
    }
    let g = 0; for (let j = 0; j < k; j++) { const r = mo.ret[sel[j]]; if (!fin(r)) throw new Error(`no holding return for pick ${sel[j]} at ${mo.decided}`); g += w * r; }
    for (let j = 0; j < kp; j++) wD[prev[j]] = 0;
    for (let j = 0; j < k; j++) { const i = sel[j]; wD[i] = w * (1 + mo.ret[i]) / (1 + g); prev[j] = i; }
    kp = k; gross[q] = g; tau[q] = t; net[q] = g - cost * t; kk[q] = k;
    if (rec) rec(q, sel, k);
  }
  return { net, gross, tau, k: kk };
}
const pickTop = (mo, sel) => { const k = mo.k; for (let j = 0; j < k; j++) sel[j] = mo.order[j]; return k; };
const pickBottom = (mo, sel) => { const k = mo.k, n = mo.n; for (let j = 0; j < k; j++) sel[j] = mo.order[n - 1 - j]; return k; };
const pickAll = (mo, sel) => { for (let j = 0; j < mo.n; j++) sel[j] = mo.elig[j]; return mo.n; };
const pickLookahead = (mo, sel) => { const ord = Array.from(mo.elig).sort((a, b) => mo.ret[b] - mo.ret[a] || a - b); for (let j = 0; j < mo.k; j++) sel[j] = ord[j]; return mo.k; };
const pickTopQuintile = (mo, sel) => { const k = kTopQuintile(mo.n); for (let j = 0; j < k; j++) sel[j] = mo.order[j]; return k; };
const pickQuintileGroup = (g) => (mo, sel) => { const lo = Math.floor((g * mo.n) / 5), hi = Math.floor(((g + 1) * mo.n) / 5); for (let j = lo; j < hi; j++) sel[j - lo] = mo.order[j]; return hi - lo; };
// Monthly excess series statistics: mean, NW t lag 3, calendar halves (hold < 2014-01 / >= 2014-01), post-2009 (hold >= 2009-07).
function excessStats(holdKeys, ex) {
  const f = [], s = [], p = [];
  holdKeys.forEach((k, q) => { (k < HALF2_FROM ? f : s).push(ex[q]); if (k >= POST2009_FROM) p.push(ex[q]); });
  return { months: ex.length, meanNet: ex.length ? mean(ex) : null, tNW: nwT(ex), halfFirst: f.length ? mean(f) : null, halfSecond: s.length ? mean(s) : null, post2009: p.length ? mean(p) : null,
    halfMonths: [f.length, s.length], post2009Months: p.length, from: holdKeys[0], to: holdKeys[holdKeys.length - 1] };
}
const diff = (a, b) => Array.from(a, (x, q) => x - b[q]);
// RANDOM-SELECTION placebo (registered): per draw, each month the same NUMBER k of eligible ETFs drawn at random (partial
// Fisher-Yates, seeded), equal weight, same cost machinery; statistic = mean of (random net - benchmark net) over the months.
// tauMatch (REPORTED only): the same draws, each charged cost * tauMatch[q] (the momentum book's own one-way turnover) instead of
// its own — random books turn over ~3x more than momentum, so the registered placebo pays ~0.045%/mo more cost and cannot fail when
// the t gate passes. The rng stream is identical with or without tauMatch, so the registered p95 is unchanged.
function placeboRun(P, netB, { draws = PLACEBO_DRAWS, seed = PLACEBO_SEED, cost = COST, onPick = null, tauMatch = null } = {}) {
  const rng = mulberry(seed), scratch = new Int32Array(P.N), stat = new Float64Array(draws), statM = new Float64Array(draws), M = P.months.length; let d = 0;
  if (tauMatch && tauMatch.length !== M) throw new Error(`tauMatch has ${tauMatch.length} months, the book ${M}`);
  const pick = (mo, sel, q) => {
    const n = mo.n, k = mo.k; for (let j = 0; j < n; j++) scratch[j] = mo.elig[j];
    for (let j = 0; j < k; j++) { const r = j + Math.floor(rng() * (n - j)), x = scratch[r]; scratch[r] = scratch[j]; scratch[j] = x; sel[j] = x; }
    if (onPick) onPick(d, q, sel, k); return k;
  };
  let tauRand = 0;
  for (d = 0; d < draws; d++) {
    const b = runBook(P, pick, cost); let s = 0, sm = 0, tr = 0;
    for (let q = 0; q < M; q++) { s += b.net[q] - netB[q]; if (tauMatch) sm += b.gross[q] - cost * tauMatch[q] - netB[q]; if (q > 0) tr += b.tau[q]; }
    stat[d] = s / M; statM[d] = sm / M; tauRand += M > 1 ? tr / (M - 1) : 0;
  }
  const sorted = srt(stat), sm2 = tauMatch ? srt(statM) : null;
  return { draws, seed, p95: sorted[Math.floor(0.95 * sorted.length)], p50: sorted[Math.floor(0.5 * sorted.length)], p05: sorted[Math.floor(0.05 * sorted.length)], meanOfDraws: mean(sorted),
    p95TauMatched: sm2 ? sm2[Math.floor(0.95 * sm2.length)] : null, p50TauMatched: sm2 ? sm2[Math.floor(0.5 * sm2.length)] : null, meanTurnoverRandom: draws ? tauRand / draws : null };
}

// ── no-edge constructions (calibration) ──────────────────────────────────────────────────────────────────────────────────
function returnsOf(C) { return C.map((c) => { const r = new Float64Array(c.length).fill(NaN); for (let t = 1; t < c.length; t++) if (fin(c[t]) && fin(c[t - 1])) r[t] = c[t] / c[t - 1] - 1; return r; }); }
// availability strata: return months grouped by the exact set of ETFs with a return that month (first-seen order)
function strataOf(R) {
  const T = R[0].length, by = new Map();
  for (let t = 1; t < T; t++) { let key = ""; for (let i = 0; i < R.length; i++) key += fin(R[i][t]) ? "1" : "0"; if (key.includes("1")) (by.get(key) || by.set(key, []).get(key)).push(t); }
  return [...by.entries()].map(([mask, ts]) => ({ mask, ts }));
}
// Drift-free input: inside each availability stratum, each priced ETF's log returns shifted so its stratum mean equals the stratum's
// pooled mean (the mean of the ETF means; the stratum is balanced, so it is also the pooled mean). Demeaning over the full sample while
// drawing within strata left EWM's 1999-04 +616% bar inflating its full-sample mean, i.e. EWM ~1.7%/mo below its peers in the main
// stratum — a contaminated leak baseline.
function demeanWithinStrata(R0) {
  const N = R0.length, T = R0[0].length, R = R0.map(() => new Float64Array(T).fill(NaN));
  for (const { mask, ts } of strataOf(R0)) {
    const ids = []; for (let i = 0; i < N; i++) if (mask[i] === "1") ids.push(i);
    const mu = ids.map((i) => mean(ts.map((t) => Math.log1p(R0[i][t])))), G = mean(mu);
    ids.forEach((i, j) => ts.forEach((t) => { R[i][t] = Math.expm1(Math.log1p(R0[i][t]) - mu[j] + G); }));
  }
  return R;
}
// registered: joint permutation of month vectors within each stratum (cross-section kept, each ETF's own mean kept = drift kept).
// demean (REPORTED + leak test): demeanWithinStrata, then whole month vectors drawn WITH replacement inside each stratum (a permutation
// without replacement builds a negative autocorrelation into a 12-1 momentum statistic once the means are equal).
// independent (REPORTED): each ETF permuted on its own WITHIN each stratum (a whole-history shuffle moved EWM's 1999 bar into 2001+).
function constructPanel(C, seed, { demean = false, independent = false } = {}) {
  const N = C.length, T = C[0].length, R0 = returnsOf(C), fam = independent ? "independent-within-strata" : demean ? "joint-drift-free-strata-bootstrap" : "joint-drift-kept";
  const R = demean ? demeanWithinStrata(R0) : R0;
  const rng = mulberry(seed * 1000003 + hash(fam)), Rn = R.map((r) => new Float64Array(r.length).fill(NaN));
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)), x = a[i]; a[i] = a[j]; a[j] = x; } return a; };
  if (independent) for (const { mask, ts } of strataOf(R)) { for (let i = 0; i < N; i++) if (mask[i] === "1") { const p = shuffle(ts.slice()); for (let j = 0; j < ts.length; j++) Rn[i][ts[j]] = R[i][p[j]]; } }
  else if (demean) for (const { mask, ts } of strataOf(R)) { for (const t of ts) { const s = ts[Math.floor(rng() * ts.length)]; for (let i = 0; i < N; i++) if (mask[i] === "1") Rn[i][t] = R[i][s]; } }
  else for (const { mask, ts } of strataOf(R)) { const p = shuffle(ts.slice()); for (let j = 0; j < ts.length; j++) for (let i = 0; i < N; i++) if (mask[i] === "1") Rn[i][ts[j]] = R[i][p[j]]; }
  return C.map((c, i) => {
    const out = new Float64Array(T).fill(NaN); let started = false;
    for (let t = 0; t < T; t++) {
      if (!fin(c[t])) { if (started) throw new Error(`gap in construction input (ETF ${i}, month ${t})`); continue; }
      if (!started) { out[t] = c[t]; started = true; } else out[t] = out[t - 1] * (1 + Rn[i][t]);
    }
    return out;
  });
}
function strategyOn(C, keys, cost = COST) {
  const P = prepBook(C, keys); if (P.defects.length) throw new Error(`holding return missing for an eligible ETF: ${JSON.stringify(P.defects.slice(0, 3))}`);
  const bP = runBook(P, pickTop, cost), bB = runBook(P, pickAll, cost), ex = diff(bP.net, bB.net), S = excessStats(P.months.map((mo) => mo.hold), ex);
  return { P, bP, bB, ex, S };
}
function constructionRun(Cu, keys, seed, opts) {
  const { P, bP, bB, S } = strategyOn(constructPanel(Cu, seed, opts), keys), pl = placeboRun(P, bB.net, { tauMatch: bP.tau });
  return { seed, months: S.months, meanNet: S.meanNet, tNW: S.tNW, halfFirst: S.halfFirst, halfSecond: S.halfSecond, post2009: S.post2009, placeboP95: pl.p95, placeboP50: pl.p50,
    placeboBeaten: S.meanNet != null && S.meanNet > pl.p95, placeboP95TauMatched: pl.p95TauMatched, placeboTauMatchedBeaten: S.meanNet != null && fin(pl.p95TauMatched) && S.meanNet > pl.p95TauMatched,
    turnoverP: mean(bP.tau.slice(1)), turnoverB: mean(bB.tau.slice(1)), turnoverRandom: pl.meanTurnoverRandom };
}

// ── THE DECISION RULE (registry R324 decisionRule.pass / cannotMeasure), one pure function for the calibration and the read ──
function decide({ months, etfsFrom2000, meanNet, tNW, placeboP95, halfFirst, halfSecond, post2009, calibrationPass, positivePass, bar }) {
  const gates = {
    etfsWithHistoryFrom2000AtLeast15: etfsFrom2000 != null && etfsFrom2000 >= MIN_ETFS_FROM_2000, monthsAtLeast240: months != null && months >= MIN_MONTHS,
    meanNetPositive: fin(meanNet) && meanNet > 0, tAtLeastBar: fin(tNW) && fin(bar) && tNW >= bar, placeboP95Beaten: fin(meanNet) && fin(placeboP95) && meanNet > placeboP95,
    bothHalvesPositive: fin(halfFirst) && fin(halfSecond) && halfFirst > 0 && halfSecond > 0, post2009MeanPositive: fin(post2009) && post2009 > 0,
    calibrationPassed: !!calibrationPass, positiveControlPassed: !!positivePass };
  const why = [];
  if (!gates.etfsWithHistoryFrom2000AtLeast15) why.push(`${etfsFrom2000} ETFs with history from 2000 < ${MIN_ETFS_FROM_2000}`); if (!gates.monthsAtLeast240) why.push(`${months} months < ${MIN_MONTHS}`);
  if (!gates.calibrationPassed) why.push("calibration failed"); if (!gates.positiveControlPassed) why.push("positive control failed");
  const failed = Object.keys(gates).filter((k) => !gates[k]);
  return { gates, failed, verdictScript: why.length ? `CANNOT MEASURE — ${why.join("; ")}` : failed.length ? "DID NOT PASS" : "PASS" };
}
// Pre-read amendments from the R324 registry entry. No runnerGates amendment -> the registered gates. Any runnerGates amendment must
// be preEvidence and use only tokens this runner defines (none today) — otherwise the read is held.
// FAIL CLOSED: an amendment that carries no runnerGates must be marked runnerNoop: true by its author (the runner changes nothing for
// it); otherwise the read is held — a plain { field: "rule.COST", becomes: "per side" } clarification must never be silently ignored.
function preReadDecision(entry) {
  const all = (entry && Array.isArray(entry.amendments) ? entry.amendments : []).filter(Boolean);
  const silent = all.filter((a) => !Array.isArray(a.runnerGates) && a.runnerNoop !== true);
  if (silent.length) return { decided: false, why: `amendment(s) without runnerGates (${silent.map((a) => a.field || a.date || "?").join(", ")}) — mark runnerNoop: true or add a runner token` };
  const noops = all.filter((a) => !Array.isArray(a.runnerGates) && a.runnerNoop === true).map((a) => ({ date: a.date || null, field: a.field || null }));
  const am = all.filter((a) => Array.isArray(a.runnerGates));
  if (!am.length) return { decided: true, registered: true, tokens: [], noops, meaning: ["registered decisionRule.pass as written"] };
  if (am.some((a) => a.preEvidence !== true)) return { decided: false, why: "a runnerGates amendment is not marked preEvidence: true" };
  const tokens = [...new Set(am.flatMap((a) => a.runnerGates))], unknown = tokens.filter((g) => !Object.prototype.hasOwnProperty.call(RUNNER_GATES, g));
  if (!tokens.length) return { decided: false, why: "a runnerGates amendment lists no token" };
  if (unknown.length) return { decided: false, why: `unknown runnerGates ${JSON.stringify(unknown)} — this runner defines ${JSON.stringify(Object.keys(RUNNER_GATES))}` };
  return { decided: true, registered: false, tokens, noops, dates: am.map((a) => a.date || null), meaning: tokens.map((g) => `${g}: ${RUNNER_GATES[g]}`) };
}
// the registry's UNIVERSE text must be this runner's universe, in order
function universeOfEntry(entry) { const m = entry && typeof entry.rule === "string" ? entry.rule.match(/UNIVERSE \(fixed today\):\s*([A-Z ]+?)\s*—/) : null; return m ? m[1].trim().split(/\s+/) : null; }
function registryEntry() { const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")); return [...(reg.preregistered || []), ...(reg.tests || [])].find((x) => x.id === ID) || null; }

// ── calibration on no-edge constructions (controls run only) ─────────────────────────────────────────────────────────────
const judge = (r, bar, etfsFrom2000) => decide({ months: r.months, etfsFrom2000, meanNet: r.meanNet, tNW: r.tNW, placeboP95: r.placeboP95, halfFirst: r.halfFirst, halfSecond: r.halfSecond, post2009: r.post2009, calibrationPass: true, positivePass: true, bar });
function calibrate(kept, free, indep, bar, etfsFrom2000) {
  const share = (rows, f) => (rows.length ? rows.filter(f).length / rows.length : null);
  const dist = (a, k = (x) => x) => { const s = srt(a); return s.length ? { n: s.length, min: k(s[0]), p05: k(nearestRank(s, 0.05)), p50: k(nearestRank(s, 0.5)), p95: k(nearestRank(s, 0.95)), max: k(s[s.length - 1]), mean: k(mean(s)) } : null; };
  const jk = kept.map((r) => judge(r, bar, etfsFrom2000)), jf = free.map((r) => judge(r, bar, etfsFrom2000)), ji = indep.map((r) => judge(r, bar, etfsFrom2000));
  const gateNames = jk.length ? Object.keys(jk[0].gates).filter((g) => g !== "calibrationPassed" && g !== "positiveControlPassed") : [];
  const perGate = (J) => Object.fromEntries(gateNames.map((g) => [g, share(J, (x) => x.gates[g])]));
  const subset = (J, names) => share(J, (x) => names.every((g) => x.gates[g]));
  const core = ["etfsWithHistoryFrom2000AtLeast15", "monthsAtLeast240", "meanNetPositive", "tAtLeastBar"];
  const passes = (J) => J.filter((x) => x.verdictScript === "PASS").length;
  const wholeK = share(jk, (x) => x.verdictScript === "PASS"), first60 = share(jk.slice(0, MIN_CAL_SEEDS), (x) => x.verdictScript === "PASS");
  const ok = kept.length === CAL_SEEDS && kept.length >= MIN_CAL_SEEDS && kept.every((r) => fin(r.tNW) && fin(r.meanNet) && fin(r.placeboP95));
  const row = (r, J) => ({ seed: r.seed, meanNetPctPerMonth: pct(r.meanNet), tNW: r3(r.tNW), placeboP95PctPerMonth: pct(r.placeboP95), placeboP95TauMatchedPctPerMonth: pct(r.placeboP95TauMatched),
    halvesPctPerMonth: [pct(r.halfFirst), pct(r.halfSecond)], post2009PctPerMonth: pct(r.post2009), turnoverP: r4(r.turnoverP), verdict: J.verdictScript, failed: J.failed });
  const coreOf = (x) => core.every((g) => x.gates[g]);
  // REPORTED only: the turnover-matched placebo as if it were the placebo gate (never part of decide())
  const tauM = (rows, J) => ({ beatenShare: share(rows, (r) => !!r.placeboTauMatchedBeaten), coreAndTauMatchedBeaten: share(rows.map((r, j) => [r, J[j]]), ([r, x]) => coreOf(x) && !!r.placeboTauMatchedBeaten),
    wholeRuleWithTauMatchedPlacebo: share(rows.map((r, j) => [r, J[j]]), ([r, x]) => x.failed.every((g) => g === "placeboP95Beaten") && !!r.placeboTauMatchedBeaten) });
  const fam = (rows, J, note) => ({ seeds: rows.length, passes: passes(J), falsePass: share(J, (x) => x.verdictScript === "PASS"), perGate: perGate(J), note, tauMatchedPlaceboReported: tauM(rows, J),
    distributions: { tNW: dist(rows.map((r) => r.tNW), r3), meanNetPctPerMonth: dist(rows.map((r) => r.meanNet), pct), placeboP95PctPerMonth: dist(rows.map((r) => r.placeboP95), pct),
      placeboP95TauMatchedPctPerMonth: dist(rows.map((r) => r.placeboP95TauMatched), pct), turnoverP: dist(rows.map((r) => r.turnoverP), r4), turnoverB: dist(rows.map((r) => r.turnoverB), r4), turnoverRandom: dist(rows.map((r) => r.turnoverRandom), r4) } });
  return { ok, bar, asOfNote: "no-edge constructions only — every rate below is a FALSE-pass rate",
    wholeRule: { registeredFalsePass: wholeK, registeredPasses: passes(jk), registeredSeeds: kept.length, first60FalsePass: first60, limit: MAX_WHOLE_RULE_FALSE_PASS, minSeeds: MIN_CAL_SEEDS,
      calibrated: ok && wholeK != null && wholeK <= MAX_WHOLE_RULE_FALSE_PASS, driftFreeFalsePass: share(jf, (x) => x.verdictScript === "PASS"), independentFalsePass: share(ji, (x) => x.verdictScript === "PASS"),
      note: "the full registered decision rule (calibration and positive control taken as passed) on each construction, its own 1,000-draw random-selection placebo included" },
    registered: fam(kept, jk, "REGISTERED (gates the read): joint permutation of month vectors within availability strata — cross-section kept per month, each ETF's own mean kept (drift kept)"),
    driftFree: fam(free, jf, "REPORTED: each ETF's log returns demeaned to the stratum pooled mean WITHIN each availability stratum, then whole month vectors drawn WITH replacement inside the stratum (cross-section kept, no mean dispersion, no without-replacement autocorrelation artifact)"),
    independent: fam(indep, ji, "REPORTED: each ETF's months permuted on its own WITHIN each availability stratum (cross-section NOT kept; drift kept; a without-replacement permutation, so its t sits ~1 below zero by construction)"),
    gateSets: { coreOnly: subset(jk, core), corePlusPlacebo: subset(jk, [...core, "placeboP95Beaten"]), corePlusHalves: subset(jk, [...core, "bothHalvesPositive"]), corePlusPost2009: subset(jk, [...core, "post2009MeanPositive"]), core,
      note: "registered constructions: what each extra gate removes from the core (months, ETFs, mean > 0, t >= bar)" },
    rows: { registered: kept.map((r, j) => row(r, jk[j])), driftFree: free.map((r, j) => row(r, jf[j])), independent: indep.map((r, j) => row(r, ji[j])) } };
}

// ── known-answer selftest (runs before any fetch, in every mode) ─────────────────────────────────────────────────────────
function selftest() {
  const checks = {}, detail = {}, close = (a, b, tol = 1e-15) => Math.abs(a - b) <= tol;
  // (a) month-end selection from daily bars: last reference session per month; stale close when an ETF misses it; a month with no
  //     bar after the first month-end is a gap; weekend rows never count; the last (incomplete) month is excluded
  { const days = ["2001-01-29", "2001-01-30", "2001-01-31", "2001-02-26", "2001-02-27", "2001-02-28", "2001-03-29", "2001-03-30", "2001-04-02", "2001-04-03"];
    const row = (d, c) => [d, c, c + 1, c - 1, c, 100], px = (d) => 100 + days.indexOf(d);
    const A = [...days.slice(0, 8), "2001-03-31", ...days.slice(8)].map((d) => row(d, d === "2001-03-31" ? 999 : px(d)));
    const B = days.filter((d) => d !== "2001-02-28").map((d) => row(d, 2 * px(d))), Cc = days.filter((d) => d >= "2001-02-27").map((d) => row(d, 3 * px(d)));
    const Dd = days.filter((d) => !d.startsWith("2001-02")).map((d) => row(d, 4 * px(d))), E = days.map((d) => row(d, 5 * px(d)));
    const pn = buildPanel({ A, B, C: Cc, D: Dd, E }, ["A", "B", "C", "D", "E"]);
    checks.a_monthEndsFromDailyBars = JSON.stringify(pn.keys) === '["2001-01","2001-02","2001-03"]' && JSON.stringify(pn.meDates) === '["2001-01-31","2001-02-28","2001-03-30"]'
      && pn.C.A[0] === px("2001-01-31") && pn.C.A[1] === px("2001-02-28") && pn.C.A[2] === px("2001-03-30") && pn.C.B[1] === 2 * px("2001-02-27") && JSON.stringify(pn.stale.B) === '["2001-02"]'
      && !fin(pn.C.C[0]) && pn.C.C[1] === 3 * px("2001-02-28") && pn.firstMonthEnd.C === "2001-02" && pn.gaps.C.length === 0 && !fin(pn.C.D[1]) && JSON.stringify(pn.gaps.D) === '["2001-02"]'
      && JSON.stringify(pn.weekendRows.A) === '["2001-03-31"]' && pn.lastReferenceSession === "2001-04-03" && JSON.stringify(pn.missingSessions.B) === '["2001-02-28"]' && pn.stale.A.length === 0; }
  // synthetic monthly panel: ETF0 100+t, ETF1 starts at t=3 (50+2t), ETF2 200-t
  const T = 20, keysS = Array.from({ length: T }, (_, t) => `${2000 + Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`);
  const CS = [Float64Array.from({ length: T }, (_, t) => 100 + t), Float64Array.from({ length: T }, (_, t) => (t < 3 ? NaN : 50 + 2 * t)), Float64Array.from({ length: T }, (_, t) => 200 - t)];
  // (b) 12-1 momentum: close(m-1)/close(m-12) - 1, the month-end-m close never enters it
  { const m = 12, CS2 = CS.map((c) => Float64Array.from(c)); CS2[0][m] = 1e6;
    checks.b_momentum12minus1SkipMonth = momOf(CS, 0, m) === 111 / 100 - 1 && momOf(CS, 2, m) === 189 / 200 - 1 && momOf(CS, 1, 15) === 78 / 56 - 1 && momOf(CS2, 0, m) === momOf(CS, 0, m)
      && momOf(CS, 0, 15, 6) === 114 / 109 - 1; }
  // (c) eligibility from the first month-end with 13 month-ends of history (m-12 .. m)
  checks.c_eligibilityAfter13MonthEnds = JSON.stringify(eligibleAt(CS, 11)) === "[]" && JSON.stringify(eligibleAt(CS, 12)) === "[0,2]" && JSON.stringify(eligibleAt(CS, 14)) === "[0,2]" && JSON.stringify(eligibleAt(CS, 15)) === "[0,1,2]";
  // (d) top third floor(n/3), at least 3; quintile analogue
  checks.d_topThirdCount = kTop(21) === 7 && kTop(20) === 6 && kTop(17) === 5 && kTop(9) === 3 && kTop(8) === 3 && kTop(3) === 3 && kTop(2) === 2 && kTopQuintile(21) === 4 && kTopQuintile(14) === 3;
  // (e)+(f) equal weights, gross, drift, one-way turnover on BOTH books incl. the benchmark's drift rebalance — by hand
  { const mk = (ret, mom, k) => { const elig = Int32Array.from([0, 1, 2, 3]), order = Int32Array.from([...elig].sort((a, b) => mom[b] - mom[a] || a - b)); return { decided: "x", hold: "y", elig, n: 4, k, ret: Float64Array.from(ret), mom: Float64Array.from(mom), order }; };
    const P = { N: 4, months: [mk([0.1, -0.1, 0.2, 0], [0.3, 0.2, 0.1, 0], 2), mk([0.05, 0.1, -0.05, 0], [0, 0.3, 0.2, 0.1], 2)] }, c = 0.001, picks = [];
    const bP = runBook(P, pickTop, c, (q, sel, k) => picks.push(Array.from(sel.slice(0, k)))), bB = runBook(P, pickAll, c);
    checks.e_equalWeightTopPicksAndGross = JSON.stringify(picks) === "[[0,1],[1,2]]" && close(bP.gross[0], 0) && close(bP.gross[1], 0.025) && close(bB.gross[0], 0.05) && close(bB.gross[1], 0.025);
    checks.f_turnoverCostBothBooksInclDrift = bP.tau[0] === 1 && close(bP.tau[1], 0.55) && close(bP.net[0], -0.001) && close(bP.net[1], 0.025 - 0.00055)
      && bB.tau[0] === 1 && close(bB.tau[1], 1 / 21) && close(bB.net[0], 0.049) && close(bB.net[1], 0.025 - 0.001 / 21) && close(bP.net[1] - bB.net[1], -0.00055 + 0.001 / 21);
    // a book that holds the same names with no drift pays nothing; an all-cash -> all-in build pays tau 1
    const flat = { N: 3, months: [0, 1, 2].map(() => ({ decided: "x", hold: "y", elig: Int32Array.from([0, 1, 2]), n: 3, k: 3, ret: Float64Array.from([0.02, 0.02, 0.02]), mom: Float64Array.from([0, 0, 0]), order: Int32Array.from([0, 1, 2]) })) };
    const bf = runBook(flat, pickAll, c); checks.f_noDriftNoTurnover = bf.tau[0] === 1 && close(bf.tau[1], 0, 1e-15) && close(bf.tau[2], 0, 1e-15) && close(bf.net[1], 0.02); }
  // (g) prepBook on the synthetic panel: decision window, holding returns, rank order, k; no look-ahead (closes at m and later never
  //     change the picks at m; the m-1 close does)
  { const P = prepBook(CS, keysS, { from: keysS[12], to: keysS[18] }), m15 = P.months[3];
    checks.g_prepBookKnownAnswer = P.months.length === 7 && P.months[0].n === 2 && P.months[0].k === 2 && m15.n === 3 && m15.k === 3 && m15.ret[1] === 82 / 80 - 1 && m15.hold === keysS[16]
      && JSON.stringify(Array.from(P.months[0].order)) === "[0,2]" && JSON.stringify(Array.from(m15.order)) === "[1,0,2]" && P.defects.length === 0;
    const g = mulberry(77), N = 9, TT = 40, C = Array.from({ length: N }, (_, i) => { const c = new Float64Array(TT).fill(NaN); let p = 50 + i; for (let t = i === 8 ? 10 : 0; t < TT; t++) { p *= 1 + (g() - 0.5) * 0.2; c[t] = p; } return c; });
    const ks = Array.from({ length: TT }, (_, t) => `k${String(t).padStart(2, "0")}`), base = prepBook(C, ks, { from: ks[13], to: ks[38] }); let same = true, moved = 0;
    for (const mo of base.months) {
      const C2 = C.map((c) => Float64Array.from(c, (x, t) => (t >= mo.m && fin(x) ? x * (0.5 + g()) : x))), mo2 = prepBook(C2, ks, { from: mo.decided, to: mo.decided }).months[0];
      if (JSON.stringify(Array.from(mo2.order)) !== JSON.stringify(Array.from(mo.order)) || mo2.k !== mo.k) same = false;
      const C3 = C.map((c) => Float64Array.from(c, (x, t) => (t === mo.m - 1 && fin(x) ? x * (0.5 + g()) : x))), mo3 = prepBook(C3, ks, { from: mo.decided, to: mo.decided }).months[0];
      if (JSON.stringify(Array.from(mo3.order)) !== JSON.stringify(Array.from(mo.order))) moved++;
    }
    checks.g_noLookAheadTruncationInvariant = same && moved >= base.months.length / 2 && base.months.some((mo) => mo.n === 8) && base.months.some((mo) => mo.n === 9); detail.g_m1PerturbMovedOrder = moved; }
  // (h) Newey-West lag 3 by hand: [2,0,2,0,2,0,2,0] -> v = 1/8, t = 8; [1,1,1,1,0,0,0,0] -> v = 0.53125, t = 0.5/sqrt(0.53125/8)
  checks.h_nwLag3HandComputed = close(nwT([2, 0, 2, 0, 2, 0, 2, 0]), 8, 1e-12) && close(nwT([1, 1, 1, 1, 0, 0, 0, 0]), 0.5 / Math.sqrt(0.53125 / 8), 1e-12) && nwT([1, 2, 3, 4]) === null && nwT([1, 1, 1, 1, 1]) === null;
  // (h2) the registry's bar method reproduced: NW lag-3 p95 at n = 309, seed 324, 50k trials = 1.662 (bar.source)
  { const nw = nwSimP95(N_EXPECTED); checks.h_registryBarMethodReproduced = r3(nw) === 1.662; detail.h_nwSimP95 = nw; }
  // (i) placebo: every draw, every month, the SAME number k of DISTINCT eligible ETFs; deterministic per seed; p95 ordered
  { const g = mulberry(5), N = 10, TT = 30, C = Array.from({ length: N }, (_, i) => { const c = new Float64Array(TT).fill(NaN); let p = 20 + i; for (let t = i >= 8 ? 6 : 0; t < TT; t++) { p *= 1 + (g() - 0.48) * 0.1; c[t] = p; } return c; });
    const ks = Array.from({ length: TT }, (_, t) => `k${String(t).padStart(2, "0")}`), P = prepBook(C, ks, { from: ks[12], to: ks[28] }), bB = runBook(P, pickAll, COST); let ok = true, nRec = 0; const seen = new Set();
    const pl = placeboRun(P, bB.net, { draws: 200, seed: 9, onPick: (d, q, sel, k) => { nRec++; const mo = P.months[q], s = Array.from(sel.slice(0, k)); if (k !== mo.k || new Set(s).size !== k || !s.every((i) => Array.from(mo.elig).includes(i))) ok = false; seen.add(s.slice().sort().join(",")); } });
    const pl2 = placeboRun(P, bB.net, { draws: 200, seed: 9 }), pl3 = placeboRun(P, bB.net, { draws: 200, seed: 10 });
    checks.i_placeboSameCountDistinctEligible = ok && nRec === 200 * P.months.length && seen.size > 50 && P.months.some((mo) => mo.n === 8) && P.months.some((mo) => mo.n === 10)
      && pl.p95 === pl2.p95 && pl.p95 !== pl3.p95 && pl.p05 <= pl.p50 && pl.p50 <= pl.p95;
    // (i2) turnover-matched placebo (REPORTED): same rng stream -> registered p95 unchanged; at zero cost it equals the registered p95;
    //      charging every draw a constant tau x gives p95 = (zero-cost p95) - cost * mean(tau) exactly as each draw shifts by the same amount
    const bP = runBook(P, pickTop, COST), M = P.months.length, plM = placeboRun(P, bB.net, { draws: 200, seed: 9, tauMatch: bP.tau });
    const z0 = placeboRun(P, bB.net, { draws: 200, seed: 9, cost: 0, tauMatch: bP.tau }), flatTau = new Float64Array(M).fill(0.3), zF = placeboRun(P, bB.net, { draws: 200, seed: 9, cost: COST, tauMatch: flatTau });
    const g0 = placeboRun(P, bB.net, { draws: 200, seed: 9, cost: 0 });
    let badLen = false; try { placeboRun(P, bB.net, { draws: 2, tauMatch: new Float64Array(M - 1) }); } catch (e) { badLen = true; }
    checks.i_tauMatchedPlaceboSameStream = plM.p95 === pl.p95 && plM.p50 === pl.p50 && z0.p95TauMatched === z0.p95 && close(zF.p95TauMatched, g0.p95 - COST * 0.3, 1e-15) && pl.p95TauMatched === null
      && fin(plM.p95TauMatched) && plM.meanTurnoverRandom > mean(bP.tau.slice(1)) && badLen; }
  // (j) constructions: joint shuffle keeps every month's cross-section (a whole original month vector of the same stratum) and each
  //     ETF's multiset of returns; first close kept; deterministic; drift-free equalises mean log returns; independent breaks the cross-section
  { const g = mulberry(21), N = 4, TT = 30, C = Array.from({ length: N }, (_, i) => { const c = new Float64Array(TT).fill(NaN); let p = 10 + i; for (let t = i === 3 ? 10 : 0; t < TT; t++) { p *= 1 + (g() - 0.45) * 0.1; c[t] = p; } return c; });
    const R = returnsOf(C), st = strataOf(R), K = constructPanel(C, 3), K2 = constructPanel(C, 3), K3 = constructPanel(C, 4), RK = returnsOf(K);
    const vec = (RR, t) => RR.map((r) => (fin(r[t]) ? r[t].toPrecision(12) : "x")).join("|"), origByStratum = st.map((s) => new Set(s.ts.map((t) => vec(R, t))));
    const inStratum = (RR) => st.every((s, si) => s.ts.every((t) => origByStratum[si].has(vec(RR, t))));
    const multiset = (RR) => RR.map((r) => Array.from(r).filter(fin).map((x) => x.toPrecision(12)).sort().join(",")), msOK = (RR) => JSON.stringify(multiset(RR)) === JSON.stringify(multiset(R));
    const moved = st[1].ts.filter((t) => vec(RK, t) !== vec(R, t)).length;
    checks.j_jointShuffleKeepsCrossSection = st.length === 2 && st[0].ts.length === 10 && st[0].mask === "1110" && st[1].mask === "1111" && inStratum(RK) && msOK(RK) && moved > 10
      && K.every((c, i) => { const f = C[i].findIndex(fin); return c[f] === C[i][f] && !fin(c[f - 1] === undefined ? NaN : c[f - 1]); }) && K.every((c, i) => c.every((x, t) => x === K2[i][t] || (!fin(x) && !fin(K2[i][t]))))
      && K.some((c, i) => c.some((x, t) => fin(x) && x !== K3[i][t]));
    // drift-free: demeaned WITHIN each stratum (every priced ETF's mean log return = the stratum's pooled mean), same NaN pattern;
    // the construction draws whole demeaned month vectors of the same stratum WITH replacement (duplicates occur; deterministic)
    const DM = demeanWithinStrata(R), lmean = (RR, i, ts) => mean(ts.map((t) => Math.log1p(RR[i][t])));
    const eqOK = st.every((s) => { const ids = [0, 1, 2, 3].filter((i) => s.mask[i] === "1"), Gs = mean(ids.flatMap((i) => s.ts.map((t) => Math.log1p(R[i][t])))); return ids.every((i) => close(lmean(DM, i, s.ts), Gs, 1e-12)); });
    const sameNaN = DM.every((r, i) => r.every((x, t) => fin(x) === fin(R[i][t]))), dmMoves = DM.some((r, i) => r.some((x, t) => fin(x) && Math.abs(x - R[i][t]) > 1e-6));
    const F = constructPanel(C, 3, { demean: true }), F2 = constructPanel(C, 3, { demean: true }), RF = returnsOf(F), origDM = st.map((s) => new Set(s.ts.map((t) => vec(DM, t))));
    const inStratumDM = st.every((s, si) => s.ts.every((t) => origDM[si].has(vec(RF, t)))), dupDraws = st[1].ts.length - new Set(st[1].ts.map((t) => vec(RF, t))).size;
    checks.j_driftFreeWithinStrataBootstrap = eqOK && sameNaN && dmMoves && inStratumDM && dupDraws > 0 && F.every((c, i) => c.every((x, t) => x === F2[i][t] || (!fin(x) && !fin(F2[i][t]))))
      && RF.every((r, i) => Array.from(r).filter(fin).length === Array.from(R[i]).filter(fin).length);
    detail.j_driftFreeDuplicateDraws = dupDraws;
    // independent: each ETF permuted on its own WITHIN each stratum (its stratum-wise multiset kept; the cross-section is broken)
    const I = constructPanel(C, 3, { independent: true }), RI = returnsOf(I);
    const msStratum = (RR) => st.map((s) => RR.map((r) => s.ts.filter((t) => fin(r[t])).map((t) => r[t].toPrecision(12)).sort().join(",")).join("|")).join("#");
    checks.j_independentShuffleWithinStrata = msOK(RI) && msStratum(RI) === msStratum(R) && !inStratum(RI); }
  // (k) decision rule: all gates -> PASS; t exactly at the bar passes; each gate alone fails; < 240 months / < 15 ETFs / a failed
  //     control -> CANNOT MEASURE
  { const base = { months: 309, etfsFrom2000: 20, meanNet: 0.002, tNW: 1.662, placeboP95: 0.001, halfFirst: 0.001, halfSecond: 0.003, post2009: 0.001, calibrationPass: true, positivePass: true, bar: 1.662 };
    const v = (o) => decide({ ...base, ...o }), only = (o, g) => JSON.stringify(v(o).failed) === JSON.stringify([g]) && v(o).verdictScript === "DID NOT PASS";
    checks.k_decisionRule = v({}).verdictScript === "PASS" && Object.keys(v({}).gates).length === 9 && only({ tNW: 1.6619 }, "tAtLeastBar") && only({ placeboP95: 0.002 }, "placeboP95Beaten")
      && only({ halfFirst: -1e-9 }, "bothHalvesPositive") && only({ halfSecond: 0 }, "bothHalvesPositive") && only({ post2009: 0 }, "post2009MeanPositive") && v({ meanNet: 0, placeboP95: -1 }).failed.includes("meanNetPositive")
      && v({ months: 239 }).verdictScript.startsWith("CANNOT MEASURE") && v({ etfsFrom2000: 14 }).verdictScript.startsWith("CANNOT MEASURE") && v({ etfsFrom2000: 15 }).verdictScript === "PASS"
      && v({ calibrationPass: false }).verdictScript === "CANNOT MEASURE — calibration failed" && v({ positivePass: false }).verdictScript === "CANNOT MEASURE — positive control failed"
      && only({ tNW: null }, "tAtLeastBar") && v({ placeboP95: null }).failed.includes("placeboP95Beaten") && v({ bar: NaN }).failed.includes("tAtLeastBar"); }
  // (l) pre-read decision: none -> registered; an amendment without runnerGates -> HELD unless runnerNoop: true (fail closed); any
  //     token (none defined) / empty list / not preEvidence -> held
  { const A = preReadDecision({}), B = preReadDecision({ amendments: [{ field: "x", preEvidence: true }] }), Cx = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: ["bar:raise"] }] });
    const E = preReadDecision({ amendments: [{ preEvidence: false, runnerGates: ["bar:raise"] }] }), Z = preReadDecision({ amendments: [{ preEvidence: true, runnerGates: [] }] });
    const Bc = preReadDecision({ amendments: [{ date: "2026-10-05", preEvidence: true, field: "rule.COST", was: "one-way", becomes: "per side" }] });
    const Bn = preReadDecision({ amendments: [{ date: "2026-10-05", preEvidence: true, field: "knownWeaknesses", runnerNoop: true }] }), Bm = preReadDecision({ amendments: [{ field: "a", runnerNoop: true }, { field: "rule.COST" }] });
    const Bs = preReadDecision({ amendments: [{ field: "a", runnerNoop: "true" }] }), An = preReadDecision({ amendments: [] });
    checks.l_preReadDecisionParser = A.decided && A.registered && !B.decided && B.why.includes("without runnerGates (x)") && !Bc.decided && Bc.why.includes("without runnerGates (rule.COST)") && Bn.decided && Bn.registered && Bn.noops.length === 1
      && !Bm.decided && Bm.why.includes("without runnerGates (rule.COST)") && !Bs.decided && An.decided && An.registered && !Cx.decided && !E.decided && !Z.decided && Object.keys(RUNNER_GATES).length === 0
      && JSON.stringify(universeOfEntry({ rule: "UNIVERSE (fixed today): EWJ EWG EZA — each eligible" })) === '["EWJ","EWG","EZA"]' && universeOfEntry({}) === null; }
  // (m) Schwab dates: midnight ET / CT stamps map to the ET date; a mid-day stamp throws; bars after the last complete bar dropped
  { let threw = false; try { schwabDate(Date.parse("2026-10-01T15:00:00Z")); } catch (e) { threw = true; }
    const cnd = (iso, px) => ({ datetime: Date.parse(iso), open: px, high: px + 1, low: px - 1, close: px, volume: 10 });
    const pk = packRows("T", [cnd("1998-12-31T06:00:00Z", 9), cnd("2026-10-01T04:00:00Z", 10), cnd("2026-10-02T05:00:00Z", 11), cnd("2026-10-05T04:00:00Z", 12)]);
    let dupThrew = false; try { packRows("T", [cnd("2026-09-30T04:00:00Z", 10), cnd("2026-09-30T05:00:00Z", 10)]); } catch (e) { dupThrew = true; }
    checks.m_schwabDatesAndFormingBarGuard = schwabDate(Date.parse("2026-10-02T04:00:00Z")) === "2026-10-02" && schwabDate(Date.parse("2026-10-02T05:00:00Z")) === "2026-10-02" && threw
      && pk.rows.length === 2 && pk.droppedAfterLastBar === 1 && pk.droppedBeforeStart === 1 && pk.rows[1][0] === "2026-10-02" && dupThrew;
    // (m2) gross one-session moves flagged (> 50% either way; exactly 50% not), in packRows and on cached rows (weekend rows skipped)
    const pj = packRows("T", [cnd("2026-09-25T04:00:00Z", 10), cnd("2026-09-28T04:00:00Z", 15), cnd("2026-09-29T04:00:00Z", 30.5), cnd("2026-09-30T04:00:00Z", 15), cnd("2026-10-01T04:00:00Z", 20)]);
    const dm = dailyMovesOf([["2026-09-25", 0, 0, 0, 10], ["2026-09-26", 0, 0, 0, 100], ["2026-09-28", 0, 0, 0, 15], ["2026-09-29", 0, 0, 0, 30.5], ["2026-09-30", 0, 0, 0, 15.25]]);
    checks.m_dailyMoveOver50pctFlag = JSON.stringify(pj.flags.dailyMoveOver50pct) === '["2026-09-29","2026-09-30"]' && pk.flags.dailyMoveOver50pct.length === 0
      && JSON.stringify(dm.map((x) => x.d)) === '["2026-09-29"]'; }
  // (n2) the REPORTED ex-motivating cut keeps holding months before 2026-01 only
  checks.n_exMotivatingSplit = JSON.stringify(preMotivatingIdx(["2001-01", "2025-11", "2025-12", "2026-01", "2026-09"])) === "[0,1,2]" && preMotivatingIdx(["2026-02"]).length === 0;
  // (n) halves / post-2009 split by holding month
  { const S = excessStats(["2009-06", "2009-07", "2013-12", "2014-01"], [0.01, 0.02, 0.03, -0.04]);
    checks.n_halvesAndPost2009Split = close(S.halfFirst, 0.02) && close(S.halfSecond, -0.04) && close(S.post2009, (0.02 + 0.03 - 0.04) / 3) && JSON.stringify(S.halfMonths) === "[3,1]" && S.post2009Months === 3 && S.tNW === null; }
  // (o) whole-rule calibration plumbing on fabricated construction rows: j=58 passes everything; j=59 has t 2 but misses the placebo
  { const rows = Array.from({ length: CAL_SEEDS }, (_, j) => ({ seed: j + 1, months: 309, meanNet: 0.001, tNW: j === 58 || j === 59 ? 2 : 1, placeboP95: j === 59 ? 0.002 : 0, halfFirst: 0.001, halfSecond: 0.001, post2009: 0.001, placeboBeaten: j !== 59, turnoverP: 0.3, turnoverB: 0.02 }));
    const cal = calibrate(rows, rows.slice(0, 20), [], 1.662, 20), rows4 = rows.map((r, j) => (j < 21 ? { ...r, tNW: 2 } : r)), cal4 = calibrate(rows4, [], [], 1.662, 20);
    checks.o_calibrationPlumbing = cal.ok && cal.wholeRule.registeredPasses === 1 && close(cal.wholeRule.registeredFalsePass, 1 / CAL_SEEDS) && cal.wholeRule.calibrated && close(cal.registered.perGate.tAtLeastBar, 2 / CAL_SEEDS)
      && close(cal.registered.perGate.placeboP95Beaten, (CAL_SEEDS - 1) / CAL_SEEDS) && cal.wholeRule.driftFreeFalsePass === 0 && cal.wholeRule.independentFalsePass === null && close(cal.wholeRule.first60FalsePass, 1 / 60)
      && cal.rows.registered[58].verdict === "PASS" && cal.rows.registered[59].verdict === "DID NOT PASS" && close(cal.gateSets.coreOnly, 2 / CAL_SEEDS) && close(cal.gateSets.corePlusPlacebo, 1 / CAL_SEEDS)
      && cal4.wholeRule.registeredPasses === 22 && !cal4.wholeRule.calibrated && !calibrate(rows.slice(0, 59), [], [], 1.662, 20).ok; }
  return { pass: Object.values(checks).every(Boolean), checks, detail };
}

// ── coverage (closes only; never a strategy return) ──────────────────────────────────────────────────────────────────────
function coverageSummary(cache, panel) {
  const keys = panel.keys, perEtf = {}, idx = (k) => keys.indexOf(k);
  for (const s of [...UNIVERSE, ...REPORTED_ONLY]) {
    if (!cache.rows[s]) { perEtf[s] = { missing: true }; continue; }
    const cv = cache.coverage[s], f = panel.firstMonthEnd[s], fi = f ? idx(f) : -1;
    perEtf[s] = { firstBar: cv.firstBar, lastBar: cv.lastBar, bars: cv.bars, firstMonthEnd: f, firstEligibleMonthEnd: UNIVERSE.includes(s) && fi >= 0 && fi + NEED - 1 < keys.length ? keys[fi + NEED - 1] : null,
      historyFrom2000: cv.firstBar <= HISTORY_FROM_2000_BY, gapMonthEnds: panel.gaps[s], staleMonthEnds: panel.stale[s], missingSessions: panel.missingSessions[s].length,
      weekendRowsDropped: panel.weekendRows[s].length, droppedAfterLastBar: cv.droppedAfterLastBar, flags: Object.fromEntries(Object.entries(cv.flags).filter(([, v]) => (Array.isArray(v) ? v.length : v))),
      dailyMovesOver50pct: dailyMovesOf(cache.rows[s]), additiveAdjustmentEnds: additiveBreaksOf(cache.rows[s]) };
  }
  const gatedMissing = UNIVERSE.filter((s) => !cache.rows[s]), staleLast = [...UNIVERSE, ...REPORTED_ONLY].filter((s) => cache.rows[s] && cache.coverage[s].lastBar !== LAST_BAR);
  const withGaps = UNIVERSE.filter((s) => cache.rows[s] && panel.gaps[s].length), etfsFrom2000 = UNIVERSE.filter((s) => cache.rows[s] && cache.coverage[s].firstBar <= HISTORY_FROM_2000_BY).length;
  const etfsFromJan2000 = UNIVERSE.filter((s) => cache.rows[s] && cache.coverage[s].firstBar <= "2000-01-31").length;
  const lastKey = keys[keys.length - 1], hasWindow = keys.includes(FIRST_DECISION) && keys.includes(LAST_DECISION) && lastKey === LAST_HOLD;
  // eligible count per decision month, from closes existence only
  const Cu = UNIVERSE.map((s) => panel.C[s] || new Float64Array(keys.length).fill(NaN)), m0 = idx(FIRST_DECISION), m1 = idx(LAST_DECISION), nBy = [];
  if (m0 >= 0 && m1 >= 0) for (let m = m0; m <= m1; m++) nBy.push([keys[m], eligibleAt(Cu, m).length]);
  const nChanges = nBy.filter((x, j) => j === 0 || x[1] !== nBy[j - 1][1]).map(([k, n]) => ({ decided: k, eligible: n, k: kTop(n) }));
  return { universe: UNIVERSE.length, priced: UNIVERSE.length - gatedMissing.length, gatedMissing, lastBarNot: staleLast, monthKeys: { first: keys[0], last: lastKey, count: keys.length, lastReferenceSession: panel.lastReferenceSession },
    decisionWindow: { from: FIRST_DECISION, to: LAST_DECISION, holdFrom: FIRST_HOLD, holdTo: LAST_HOLD, months: nBy.length, present: hasWindow }, eligibleCountChanges: nChanges,
    etfsFrom2000, etfsFromJan2000, etfsFrom2000Rule: `first bar on or before ${HISTORY_FROM_2000_BY} (the stricter count, first bar by 2000-01-31, beside it)`, withGaps, perEtf,
    additiveAdjustmentNote: ADDITIVE_NOTE, dailyMovesNote: "dailyMovesOver50pct: weekday close-to-close moves > 50% in the cached bars — disclosed, not altered (the sha256 freeze means the read uses exactly these bars); EWM's 1999 bars are 1/8-fraction prices plus an offset, not a market move",
    dailyMovesOver50pctBySymbol: Object.fromEntries([...UNIVERSE, ...REPORTED_ONLY].filter((s) => cache.rows[s]).map((s) => [s, dailyMovesOf(cache.rows[s]).length]).filter(([, n]) => n)),
    ok: gatedMissing.length === 0 && staleLast.filter((s) => UNIVERSE.includes(s)).length === 0 && withGaps.length === 0 && hasWindow && nBy.length === N_EXPECTED && nBy.every(([, n]) => n >= 3) };
}
// R313's cache holds some of these ETFs (fetched 2026-10-03): closes compared on common dates (data consistency, REPORTED)
function crossCheckR313(cache) {
  if (!fs.existsSync(R313_CACHE)) return { note: "R313 cache absent" };
  const j = JSON.parse(fs.readFileSync(R313_CACHE, "utf8")), out = {};
  for (const s of [...UNIVERSE, ...REPORTED_ONLY]) {
    if (!j.rows[s] || !cache.rows[s]) continue;
    const mine = new Map(cache.rows[s].map((x) => [x[0], x[4]])); let n = 0, mism = 0, maxRel = 0;
    for (const x of j.rows[s]) if (mine.has(x[0])) { n++; const rel = Math.abs(mine.get(x[0]) / x[4] - 1); if (rel > 1e-9) mism++; if (rel > maxRel) maxRel = rel; }
    out[s] = { commonDates: n, closesDiffering: mism, maxRelDiff: +maxRel.toExponential(3) };
  }
  return { file: "backend/data/training/r313/bars-schwab-daily-19990101-20261001.json", note: "bars reused only as a cross-check; R324 uses its own fetch", symbols: out };
}

// ── the read computation, pure (main writes OUT once); --read passes the real panel; the controls run dry-runs it on a construction ──
function computeRead({ Cu, keys, idx, ctrl, entry, dec, bar, cov, sha, label = "REAL" }) {
  const cal = ctrl.calibration, P = prepBook(Cu, keys);
  if (P.defects.length) throw new Error(`holding return missing for an eligible ETF: ${JSON.stringify(P.defects.slice(0, 3))}`);
  const holds = P.months.map((mo) => mo.hold), picksBy = [];
  const bP = runBook(P, pickTop, COST, (q, sel, k) => picksBy.push(Array.from(sel.slice(0, k)).map((i) => UNIVERSE[i]))), bB = runBook(P, pickAll, COST);
  const ex = diff(bP.net, bB.net), S = excessStats(holds, ex), pl = placeboRun(P, bB.net, { tauMatch: bP.tau }), preQ = preMotivatingIdx(holds);
  const positivePass = !!(ctrl.positiveControl && ctrl.positiveControl.pass), calibrationPass = !!(cal && cal.ok && cal.wholeRule.calibrated);
  const D0 = decide({ months: S.months, etfsFrom2000: cov.etfsFrom2000, meanNet: S.meanNet, tNW: S.tNW, placeboP95: pl.p95, halfFirst: S.halfFirst, halfSecond: S.halfSecond, post2009: S.post2009, calibrationPass, positivePass, bar });
  // reported (never gated)
  const st = (a, keysA = holds) => { const s = excessStats(keysA, a); return { months: s.months, meanNetPctPerMonth: pct(s.meanNet), tNW: r3(s.tNW), halvesPctPerMonth: [pct(s.halfFirst), pct(s.halfSecond)], post2009PctPerMonth: pct(s.post2009) }; };
  const bP2 = runBook(P, pickTop, COST_2X), bB2 = runBook(P, pickAll, COST_2X), bBot = runBook(P, pickBottom, COST);
  const P6 = prepBook(Cu, keys, { L: 6 }), bP6 = runBook(P6, pickTop, COST), bB6 = runBook(P6, pickAll, COST);
  const bQ = runBook(P, pickTopQuintile, COST), qGroups = [0, 1, 2, 3, 4].map((g) => runBook(P, pickQuintileGroup(g), COST));
  const vsIndex = (sym) => {
    const c = idx[sym]; if (!c) return { note: `${sym} missing` };
    const kP = [], dP = [], dB = []; P.months.forEach((mo, q) => { const r = c[mo.m + 1] / c[mo.m] - 1; if (fin(r)) { kP.push(mo.hold); dP.push(bP.net[q] - r); dB.push(bB.net[q] - r); } });
    return { note: `portfolio (and benchmark) net minus ${sym} price return, months where ${sym} has both month-end closes`, from: kP[0], portfolio: st(dP, kP), benchmark: st(dB, kP) };
  };
  const minAt = (a) => { let j = 0; for (let q = 1; q < a.length; q++) if (a[q] < a[j]) j = q; return j; };
  const roll12 = (f) => { const out = []; for (let q = 11; q < P.months.length; q++) out.push(f(q - 11, q)); return out; };
  const prod = (a, lo, hi) => { let p = 1; for (let q = lo; q <= hi; q++) p *= 1 + a[q]; return p; };
  const rel12 = roll12((lo, hi) => prod(bP.net, lo, hi) / prod(bB.net, lo, hi) - 1), abs12 = roll12((lo, hi) => prod(bP.net, lo, hi) - 1);
  const crash = holds.map((k, q) => [k, q]).filter(([k]) => k >= "2009-03" && k <= "2009-12").map(([, q]) => q);
  const holdingsByYear = {}; picksBy.forEach((ps, q) => { const y = holds[q].slice(0, 4), h = holdingsByYear[y] || (holdingsByYear[y] = {}); for (const s of ps) h[s] = (h[s] || 0) + 1; });
  for (const y of Object.keys(holdingsByYear)) holdingsByYear[y] = Object.fromEntries(Object.entries(holdingsByYear[y]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  const perYear = {}; holds.forEach((k, q) => { const y = k.slice(0, 4); (perYear[y] || (perYear[y] = [])).push(ex[q]); });
  const cagr = (a) => Math.pow(prod(a, 0, a.length - 1), 12 / a.length) - 1, consK = cal.rows.registered.map((r) => r.tNW), consM = cal.rows.registered.map((r) => r.meanNetPctPerMonth);
  const barCheck = { registered: bar, registeredForN: entry.nExpected, observedN: S.months, ...(S.months >= 5 ? barAtN(S.months) : {}) };
  barCheck.borderline = barCheck.bar != null && S.tNW != null && S.tNW >= bar && S.tNW < barCheck.bar;
  const reported = {
    cost2x: { note: "0.20% per unit of one-way turnover on both books (also the per-side reading of the registered cost)", ...st(diff(bP2.net, bB2.net)) },
    longShort: { note: "top third net minus bottom third net (each its own 0.10% turnover cost)", ...st(diff(bP.net, bBot.net)), bottomThirdVsBenchmark: st(diff(bBot.net, bB.net)) },
    lookback6minus1: { note: "MOM = close(m-1)/close(m-6) - 1, same eligibility (13 month-ends), top third vs the same benchmark", ...st(diff(bP6.net, bB6.net)) },
    quintiles: { topQuintile: { note: "top floor(n/5), at least 3, vs the benchmark", ...st(diff(bQ.net, bB.net)) },
      byQuintile: { note: "Q1 = highest MOM; groups [floor(g n/5), floor((g+1) n/5)) of the rank order; each net of its own turnover cost minus the benchmark", rows: qGroups.map((b, g) => ({ quintile: `Q${g + 1}`, ...st(diff(b.net, bB.net)) })) } },
    vsEFA: vsIndex("EFA"), vsSPY: vsIndex("SPY"),
    worstMonth: { excess: { month: holds[minAt(ex)], pct: pct(ex[minAt(ex)]) }, portfolioNet: { month: holds[minAt(bP.net)], pct: pct(bP.net[minAt(bP.net)]) }, benchmarkNet: { month: holds[minAt(bB.net)], pct: pct(bB.net[minAt(bB.net)]) } },
    worst12Months: { relative: { note: "rolling 12 holding months, prod(1+portfolio net)/prod(1+benchmark net) - 1", endMonth: holds[minAt(rel12) + 11], pct: pct(rel12[minAt(rel12)]) },
      portfolioAbsolute: { endMonth: holds[minAt(abs12) + 11], pct: pct(abs12[minAt(abs12)]) } },
    momentumCrash2009: { months: crash.map((q) => holds[q]), excessSumPct: pct(crash.reduce((s, q) => s + ex[q], 0)), relativePct: crash.length ? pct(crash.reduce((p, q) => p * (1 + bP.net[q]), 1) / crash.reduce((p, q) => p * (1 + bB.net[q]), 1) - 1) : null },
    turnover: { unit: "one-way tau per month = 0.5 * sum |target - drifted|; month 1 (bought from cash, tau 1) excluded from the means", portfolioMean: r4(mean(bP.tau.slice(1))), benchmarkMean: r4(mean(bB.tau.slice(1))),
      portfolioAnnual: r3(12 * mean(bP.tau.slice(1))), costPctPerMonthPortfolio: pct(COST * mean(bP.tau.slice(1))), costPctPerMonthBenchmark: pct(COST * mean(bB.tau.slice(1))) },
    annualised: { portfolioNetCagrPct: pct(cagr(bP.net)), benchmarkNetCagrPct: pct(cagr(bB.net)), excessMonthsPositiveShare: r3(ex.filter((x) => x > 0).length / ex.length) },
    perYear: Object.fromEntries(Object.entries(perYear).map(([y, v]) => [y, { months: v.length, meanExcessPctPerMonth: pct(mean(v)) }])),
    holdingsByYear, picksByMonth: Object.fromEntries(holds.map((k, q) => [k, picksBy[q]])), eligibleByMonth: Object.fromEntries(P.months.map((mo) => [mo.hold, mo.n])),
    amongConstructions: { note: `REPORTED ONLY: share of the ${consK.length} registered no-edge constructions strictly below the observed value`, tNW: nullRank(consK, S.tNW), meanNet: nullRank(consM, pct(S.meanNet)) },
    barCheck: { ...barCheck, note: "The registered bar applies unchanged. A t in [registered bar, the same method's bar at the observed n) is flagged borderline for the seal note." },
    exMotivatingWindow: { note: `holding months ${FIRST_HOLD}..2025-12; the 2026 months (the EWY/EWT run) prompted the registration — weight zero by house rule; REPORTED, never gated`, from: holds[preQ[0]] || null, to: preQ.length ? holds[preQ[preQ.length - 1]] : null,
      ...st(preQ.map((q) => ex[q]), preQ.map((q) => holds[q])) },
  };
  const placebo = { form: "random selection, same k per month, equal weight, same costs (registered)", draws: pl.draws, seed: pl.seed, p95: pl.p95, observed: S.meanNet, beats: S.meanNet != null && S.meanNet > pl.p95,
    p95PctPerMonth: pct(pl.p95), observedPctPerMonth: pct(S.meanNet), p50PctPerMonth: pct(pl.p50), p05PctPerMonth: pct(pl.p05), meanOfDrawsPctPerMonth: pct(pl.meanOfDraws),
    p95TauMatchedPctPerMonth: pct(pl.p95TauMatched), p50TauMatchedPctPerMonth: pct(pl.p50TauMatched), beatsTauMatched: S.meanNet != null && fin(pl.p95TauMatched) && S.meanNet > pl.p95TauMatched,
    turnoverRandomMean: r4(pl.meanTurnoverRandom), turnoverPortfolioMean: r4(mean(bP.tau.slice(1))),
    tauMatchedNote: "REPORTED, never gated: the same 1,000 draws charged the momentum book's own one-way turnover each month instead of their own (random books turn over ~3x more, so the registered p95 is cost-handicapped)" };
  // seal-note block (REPORTED, never gated): does a PASS survive the ex-motivating cut and the 0.20% cost?
  const exm = reported.exMotivatingWindow, c2 = reported.cost2x, clears = (b) => b && b.meanNetPctPerMonth != null && b.meanNetPctPerMonth > 0 && b.tNW != null && b.tNW >= bar;
  const isPass = D0.verdictScript === "PASS", surEx = isPass ? clears(exm) : null, surC2 = isPass ? clears(c2) : null;
  reported.sealNote = { note: "REPORTED, never gated — robustness of the gated verdict, for the seal note; 'clears' = mean > 0 AND t_NW >= the registered bar", verdictScript: D0.verdictScript,
    gated: { meanNetPctPerMonth: pct(S.meanNet), tNW: r3(S.tNW) }, exMotivating: { meanNetPctPerMonth: exm.meanNetPctPerMonth, tNW: exm.tNW, months: exm.months, clears: clears(exm) },
    cost2x: { meanNetPctPerMonth: c2.meanNetPctPerMonth, tNW: c2.tNW, clears: clears(c2) }, placeboTauMatched: { p95PctPerMonth: placebo.p95TauMatchedPctPerMonth, beaten: placebo.beatsTauMatched },
    passSurvivesExMotivating: surEx, passSurvivesCost2x: surC2, passSurvivesTauMatchedPlacebo: isPass ? placebo.beatsTauMatched : null,
    statement: isPass ? `PASS at the registered gates; ex-2026 cut t ${exm.tNW} (${surEx ? "SURVIVES" : "does NOT survive"}); 0.20% cost t ${c2.tNW} (${surC2 ? "SURVIVES" : "does NOT survive"}); turnover-matched placebo p95 ${placebo.p95TauMatchedPctPerMonth}%/mo ${placebo.beatsTauMatched ? "beaten" : "NOT beaten"}`
      : `${D0.verdictScript} at the registered gates; the cuts are informational only` };
  const out = {
    id: ID, spec: "r324-read-v1", read: true, label, asOf: new Date().toISOString(), unit: "months", n: S.months, months: S.months, from: S.from, to: S.to,
    tNet: r4(S.tNW), tNetRaw: S.tNW, meanNet: S.meanNet, meanNetPctPerMonth: pct(S.meanNet),
    placebo, halves: { first: { meanNet: S.halfFirst, meanNetPctPerMonth: pct(S.halfFirst), months: S.halfMonths[0], from: FIRST_HOLD, to: "2013-12" }, second: { meanNet: S.halfSecond, meanNetPctPerMonth: pct(S.halfSecond), months: S.halfMonths[1], from: HALF2_FROM, to: LAST_HOLD } },
    post2009: { meanNet: S.post2009, meanNetPctPerMonth: pct(S.post2009), months: S.post2009Months, from: POST2009_FROM },
    controls: { calibrationPassed: calibrationPass, wholeRuleFalsePass: cal.wholeRule.registeredFalsePass, positiveControlPassed: positivePass, positiveControlT: ctrl.positiveControl ? ctrl.positiveControl.tNW : null, file: `backend/data/${path.basename(CTRL)}`, asOf: ctrl.asOf },
    bar, barSource: "test-registry.json R324 bar.tRequired", preReadDecision: dec, gates: D0.gates, failedGates: D0.failed, verdictScript: D0.verdictScript,
    cost: { perUnitOneWayTurnover: COST, definition: "tau = 0.5 * sum |w_target - w_drift| (fraction of the book replaced); first month from cash tau = 1; net = gross - cost * tau" },
    reported, cache: { file: CACHE_REL, sha256: sha },
    coverage: { etfsFrom2000: cov.etfsFrom2000, etfsFromJan2000: cov.etfsFromJan2000, eligibleCountChanges: cov.eligibleCountChanges, withGaps: cov.withGaps },
    implementationNotes: [
      "Month-end = the last reference session of each complete month (reference = weekdays on which more than half of the ETFs spanning the date have a bar); an ETF's close = its last bar on or before it inside the month.",
      "Eligible at m = month-end closes at m-12..m; MOM = close(m-1)/close(m-12) - 1; ties broken by the universe order; k = floor(n/3), at least 3.",
      "Equal weight bought at the close of m, held to the close of m+1 (buy and hold inside the month); benchmark = every eligible ETF, equal weight.",
      "Cost 0.10% per unit of one-way turnover on both books, the benchmark's drift rebalance and new entrants included; first month bought from cash on both books (tau 1 each, cancels in the excess).",
      "Schwab daily history is split-adjusted price only (no dividends) for every ETF, EFA and SPY alike.",
    ],
  };
  const lines = [
    `R324 READ${label === "REAL" ? "" : ` (${label})`} — ${D0.verdictScript} (bar t_NW lag 3 >= ${bar})`,
    `  months ${S.months} (${S.from}..${S.to}) · net excess %/month ${pct(S.meanNet)} · t_NW ${r3(S.tNW)} · random-selection p95 ${pct(pl.p95)} -> ${placebo.beats ? "beaten" : "NOT beaten"}`,
    `  halves ${pct(S.halfFirst)} / ${pct(S.halfSecond)} · post-2009 ${pct(S.post2009)} · 0.20% cost ${reported.cost2x.meanNetPctPerMonth} t ${reported.cost2x.tNW} · bar at n=${barCheck.observedN} ${barCheck.bar}${barCheck.borderline ? " — BORDERLINE" : ""} · ex-2026 ${reported.exMotivatingWindow.meanNetPctPerMonth} t ${reported.exMotivatingWindow.tNW}`,
    `  REPORTED (never gated): turnover-matched placebo p95 ${placebo.p95TauMatchedPctPerMonth} -> ${placebo.beatsTauMatched ? "beaten" : "NOT beaten"} (random tau ${placebo.turnoverRandomMean} vs portfolio ${placebo.turnoverPortfolioMean}) · seal note: ${reported.sealNote.statement}`,
    `  gates ${JSON.stringify(D0.gates)}`,
  ];
  return { out, lines };
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  let st; try { st = selftest(); } catch (e) { st = { pass: false, checks: {}, detail: { threw: e.stack || e.message } }; }     // a throwing selftest is a FAIL
  console.log(`R324 selftest ${st.pass ? "PASS" : "FAIL"} ${JSON.stringify(st.checks)}`);
  if (!st.pass) { console.log(`  detail ${JSON.stringify(st.detail)}`); process.exit(1); }
  if (SELFTEST_ONLY) return;

  const entry = registryEntry();
  if (!entry) { console.error(`${ID} not registered — refusing`); process.exit(2); }
  const bar = Number(entry.bar && entry.bar.tRequired);
  if (!fin(bar)) { console.error(`${ID} registry entry has no numeric bar.tRequired — refusing`); process.exit(2); }
  const regU = universeOfEntry(entry);
  if (JSON.stringify(regU) !== JSON.stringify(UNIVERSE)) { console.error(`${ID} registry universe ${JSON.stringify(regU)} differs from the runner's — refusing`); process.exit(2); }
  const runnerSha = sha256(fs.readFileSync(__filename));

  if (!READ) {
    // CONTROLS RUN — the momentum rule is run ONLY on no-edge constructions; on the real panel only the look-ahead positive control
    // and the equal-weight benchmark it is measured against are computed. No real strategy statistic is computed or written.
    const { cache, sha, fetched } = await loadOrFetch(true), panel = buildPanel(cache.rows, UNIVERSE, [...UNIVERSE, ...REPORTED_ONLY]), cov = coverageSummary(cache, panel);
    console.log(`R324 bars ${fetched ? "fetched + cached" : "from cache"} — ${cov.priced}/${cov.universe} ETFs priced; sha256 ${sha}`);
    for (const s of [...UNIVERSE, ...REPORTED_ONLY]) { const e = cov.perEtf[s]; console.log(`  ${s.padEnd(4)} ${e.missing ? "MISSING" : `bars ${e.firstBar}..${e.lastBar} (${e.bars}) · first month-end ${e.firstMonthEnd} · first eligible ${e.firstEligibleMonthEnd || "-"} · gaps ${e.gapMonthEnds.length ? e.gapMonthEnds.join(",") : "none"} · stale ${e.staleMonthEnds.length} · missing sessions ${e.missingSessions} · weekend rows ${e.weekendRowsDropped} · adj ends ${e.additiveAdjustmentEnds.length}`}`); }
    console.log(`  month-ends ${cov.monthKeys.first}..${cov.monthKeys.last} (${cov.monthKeys.count}) · decisions ${cov.decisionWindow.months} · ETFs with history from 2000 ${cov.etfsFrom2000} (by 2000-01-31: ${cov.etfsFromJan2000}) · eligible ${JSON.stringify(cov.eligibleCountChanges.map((x) => `${x.decided}:${x.eligible}/${x.k}`))}`);
    if (!cov.ok) { console.error(`${ID} coverage incomplete — missing ${JSON.stringify(cov.gatedMissing)}, last bar not ${LAST_BAR} ${JSON.stringify(cov.lastBarNot)}, gaps ${JSON.stringify(cov.withGaps)}, window ${JSON.stringify(cov.decisionWindow)}; R324 NOT READY`); process.exit(2); }
    const keys = panel.keys, Cu = UNIVERSE.map((s) => panel.C[s]), xc = crossCheckR313(cache);
    // POSITIVE CONTROL (registered): top third by the NEXT month's realised return (look-ahead), vs the equal-weight benchmark
    const Pr = prepBook(Cu, keys); if (Pr.defects.length) { console.error(`${ID} holding return missing for an eligible ETF ${JSON.stringify(Pr.defects.slice(0, 5))} — NOT READY`); process.exit(2); }
    const bLA = runBook(Pr, pickLookahead, COST), bBr = runBook(Pr, pickAll, COST), Sla = excessStats(Pr.months.map((mo) => mo.hold), diff(bLA.net, bBr.net)), peekOk = fin(Sla.tNW) && Sla.tNW >= POSITIVE_T;
    // LEAK TEST: drift-free constructions seeds 1, 2 (within-strata demean + with-replacement month-vector draws; t_NW < 2; a null t
    // fails) + structural no-look-ahead on construction seed 1 (the real leak guard)
    const leak = [1, 2].map((seed) => strategyOn(constructPanel(Cu, seed, { demean: true }), keys).S), leakOk = leak.every((s) => fin(s.tNW) && s.tNW < LEAK_T);
    const K1 = constructPanel(Cu, 1), PK = prepBook(K1, keys); let structOk = true;
    for (const mo of PK.months) { const C2 = K1.map((c) => Float64Array.from(c, (x, t) => (t >= mo.m && fin(x) ? x * (0.5 + ((t * 7919 + mo.m) % 997) / 997) : x))), mo2 = prepBook(C2, keys, { from: mo.decided, to: mo.decided }).months[0];
      if (JSON.stringify(Array.from(mo2.order)) !== JSON.stringify(Array.from(mo.order)) || mo2.k !== mo.k) { structOk = false; break; } }
    console.log(`R324 calibrating the WHOLE decision rule on ${CAL_SEEDS} registered constructions (+ ${FREE_SEEDS} drift-free, ${INDEP_SEEDS} independent; placebo ${PLACEBO_DRAWS} draws each) ...`);
    const t0 = Date.now(), kept = [], free = [], indep = [];
    for (let s = 1; s <= CAL_SEEDS; s++) { kept.push(constructionRun(Cu, keys, s, {})); if (s % 100 === 0) console.log(`  registered ${s}/${CAL_SEEDS} (${((Date.now() - t0) / 1000).toFixed(0)} s)`); }
    for (let s = 1; s <= FREE_SEEDS; s++) free.push(constructionRun(Cu, keys, s, { demean: true }));
    for (let s = 1; s <= INDEP_SEEDS; s++) indep.push(constructionRun(Cu, keys, s, { independent: true }));
    const calibration = calibrate(kept, free, indep, bar, cov.etfsFrom2000), decision = preReadDecision(entry);
    // dry run of the read computation on construction seed 1 (proves the read path end to end; never the real panel)
    let dry; try { const fakeCtrl = { calibration, positiveControl: { pass: peekOk, tNW: r3(Sla.tNW) }, asOf: "dry-run" }, idxR = Object.fromEntries(REPORTED_ONLY.map((s) => [s, panel.C[s]]));
      const r = computeRead({ Cu: K1, keys, idx: idxR, ctrl: fakeCtrl, entry, dec: decision, bar, cov, sha, label: "DRY RUN on registered construction seed 1" });
      dry = { ok: true, on: "registered construction seed 1 (no-edge)", verdictScript: r.out.verdictScript, gates: Object.keys(r.out.gates).length, reportedBlocks: Object.keys(r.out.reported) }; } catch (e) { dry = { ok: false, error: e.message }; }
    const pass = peekOk && leakOk && structOk && cov.ok && dry.ok, ready = pass && calibration.ok && calibration.wholeRule.calibrated && decision.decided;
    const holdWhy = !pass ? "a registered control, the leak test, coverage or the read dry run failed" : !calibration.ok ? "calibration incomplete" : !calibration.wholeRule.calibrated ? `whole-rule false pass ${calibration.wholeRule.registeredFalsePass} > ${MAX_WHOLE_RULE_FALSE_PASS} on the registered constructions — the read is held for a pre-evidence amendment` : !decision.decided ? `pre-read decision invalid (${decision.why})` : null;
    writeJsonAtomic(CTRL, { spec: "r324-controls-v1", id: ID, asOf: new Date().toISOString(), runner: { file: `backend/${path.basename(__filename)}`, sha256: runnerSha },
      cache: { file: CACHE_REL, sha256: sha, fetchedAt: cache.fetchedAt, source: cache.source }, registry: { bar, universe: regU, nExpected: entry.nExpected }, coverage: cov, crossCheckR313: xc, selftest: st,
      positiveControl: { method: "top third (floor(n/3), min 3) by the NEXT month's realised return — outcome look-ahead — vs the equal-weight benchmark, 0.10% turnover cost", requirement: `t_NW >= ${POSITIVE_T}`, pass: peekOk, tNW: r3(Sla.tNW), months: Sla.months, meanNetPctPerMonth: pct(Sla.meanNet) },
      leakTest: { method: "the momentum rule on drift-free constructions seeds 1, 2 (no edge by construction: each ETF demeaned to the stratum pooled mean WITHIN each availability stratum, whole month vectors drawn WITH replacement inside the stratum)", requirement: `t_NW < ${LEAK_T} on both (a null t fails)`, pass: leakOk, seeds: leak.map((s, j) => ({ seed: j + 1, months: s.months, meanNetPctPerMonth: pct(s.meanNet), tNW: r3(s.tNW) })),
        structural: { method: "registered construction seed 1: every close at month-end m and later rescaled -> the eligible set, k and rank order at m unchanged, for all 309 decisions", pass: structOk } },
      calibration, preReadDecision: decision, readDryRun: dry, pass, ready, holdWhy,
      note: "Only no-edge constructions, the look-ahead positive control and the equal-weight benchmark of the real panel are computed; no real momentum statistic is computed or written." });
    const c = calibration, pc = (x) => (x == null ? null : +(100 * x).toFixed(1)), dd = (f) => f.distributions;
    console.log(`R324 controls — positive control ${peekOk ? "PASS" : "FAIL"} t_NW ${r3(Sla.tNW)} (${pct(Sla.meanNet)}%/month) · leak ${leakOk ? "PASS" : "FAIL"} t ${leak.map((s) => r3(s.tNW)).join(" / ")} · structural no-look-ahead ${structOk ? "PASS" : "FAIL"} · read dry run ${dry.ok ? "OK" : `FAILED ${dry.error}`}`);
    console.log(`  R313 cross-check ${JSON.stringify(xc.symbols || xc.note)}`);
    for (const [name, f] of [["registered", c.registered], ["drift-free", c.driftFree], ["independent", c.independent]]) {
      console.log(`  ${name.padEnd(11)} whole rule ${f.passes}/${f.seeds} = ${pc(f.falsePass)}% · per gate ${JSON.stringify(Object.fromEntries(Object.entries(f.perGate).map(([k, v]) => [k, pc(v)])))}`);
      console.log(`              t ${JSON.stringify(dd(f).tNW)} · mean %/mo ${JSON.stringify(dd(f).meanNetPctPerMonth)} · placebo p95 %/mo p50 ${dd(f).placeboP95PctPerMonth && dd(f).placeboP95PctPerMonth.p50} (tau-matched ${dd(f).placeboP95TauMatchedPctPerMonth && dd(f).placeboP95TauMatchedPctPerMonth.p50}) · turnover P ${dd(f).turnoverP && dd(f).turnoverP.p50} B ${dd(f).turnoverB && dd(f).turnoverB.p50} random ${dd(f).turnoverRandom && dd(f).turnoverRandom.p50}`);
      console.log(`              REPORTED tau-matched placebo: beaten ${pc(f.tauMatchedPlaceboReported.beatenShare)}% · core+beaten ${pc(f.tauMatchedPlaceboReported.coreAndTauMatchedBeaten)}% · whole rule with it in place of the registered placebo ${pc(f.tauMatchedPlaceboReported.wholeRuleWithTauMatchedPlacebo)}%`);
    }
    console.log(`  data disclosure: daily moves > 50% ${JSON.stringify(cov.dailyMovesOver50pctBySymbol)} · additive-adjustment ends are a lower bound (offsets that are multiples of $0.005 are undetectable)`);
    console.log(`  gate sets (registered): core ${pc(c.gateSets.coreOnly)}% · +placebo ${pc(c.gateSets.corePlusPlacebo)}% · +halves ${pc(c.gateSets.corePlusHalves)}% · +post-2009 ${pc(c.gateSets.corePlusPost2009)}% · first-60 whole rule ${pc(c.wholeRule.first60FalsePass)}%`);
    console.log(`  WHOLE RULE false pass (registered constructions) ${c.wholeRule.registeredPasses}/${c.wholeRule.registeredSeeds} = ${pc(c.wholeRule.registeredFalsePass)}% (limit ${pc(MAX_WHOLE_RULE_FALSE_PASS)}%) -> ${c.wholeRule.calibrated ? "CALIBRATED" : "MISCALIBRATED"} · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    console.log(`  pre-read decision: ${decision.decided ? (decision.registered ? "registered gates (no amendment)" : JSON.stringify(decision.tokens)) : `INVALID — ${decision.why}`} · runner sha256 ${runnerSha}`);
    console.log(ready ? `R324 READY — the one read is: node backend/${path.basename(__filename)} --read` : `R324 NOT READY — ${holdWhy}`);
    return;
  }

  // ── THE READ (once) ──
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests && seals.tests[ID]) { console.error(`${ID} already sealed — refusing`); process.exit(2); }
  if (fs.existsSync(OUT) && JSON.parse(fs.readFileSync(OUT, "utf8")).read) { console.error(`${ID} already read — seal it, do not re-read`); process.exit(2); }
  const ctrl = fs.existsSync(CTRL) ? JSON.parse(fs.readFileSync(CTRL, "utf8")) : null;
  if (!ctrl || ctrl.spec !== "r324-controls-v1" || !ctrl.pass) { console.error(`${ID} controls have not passed (or no controls file)`); process.exit(2); }
  if (!ctrl.runner || ctrl.runner.sha256 !== runnerSha) { console.error(`${ID} controls were produced by a different runner (${ctrl.runner && ctrl.runner.sha256} vs ${runnerSha}) — re-run the controls`); process.exit(2); }
  if (!ctrl.calibration || !ctrl.calibration.ok) { console.error(`${ID} controls file has no complete calibration — re-run the controls`); process.exit(2); }
  if (ctrl.calibration.bar !== bar || !ctrl.registry || ctrl.registry.bar !== bar) { console.error(`${ID} controls calibrated at bar ${ctrl.calibration.bar}, registry says ${bar} — re-run the controls`); process.exit(2); }
  const dec = preReadDecision(entry);
  if (!dec.decided) { console.error(`${ID} read HELD — ${dec.why}`); process.exit(2); }
  if (!ctrl.calibration.wholeRule.calibrated) { console.error(`${ID} read HELD — the whole decision rule false-passes ${ctrl.calibration.wholeRule.registeredFalsePass} of the registered no-edge constructions (> ${MAX_WHOLE_RULE_FALSE_PASS}); a pre-evidence amendment is required`); process.exit(2); }
  if (!ctrl.ready) { console.error(`${ID} controls run says NOT READY (${ctrl.holdWhy}) — refusing`); process.exit(2); }
  const { cache, sha } = await loadOrFetch(false);
  if (!ctrl.cache || ctrl.cache.sha256 !== sha) { console.error(`${ID} bar cache sha256 ${sha} differs from the controls run's ${ctrl.cache && ctrl.cache.sha256} — refusing`); process.exit(2); }
  const panel = buildPanel(cache.rows, UNIVERSE, [...UNIVERSE, ...REPORTED_ONLY]), cov = coverageSummary(cache, panel);
  if (!cov.ok) { console.error(`${ID} coverage incomplete at read time — refusing`); process.exit(2); }
  const { out, lines } = computeRead({ Cu: UNIVERSE.map((s) => panel.C[s]), keys: panel.keys, idx: Object.fromEntries(REPORTED_ONLY.map((s) => [s, panel.C[s]])), ctrl, entry, dec, bar, cov, sha, label: "REAL" });
  writeJsonAtomic(OUT, out);
  for (const l of lines) console.log(l);
}
// Run only when invoked directly. A require() gets the pure functions and never reaches main: no fetch, no write.
if (require.main === module) main().catch((e) => { console.error("R324 FAILED:", e.message); process.exit(1); });
else module.exports = { buildPanel, referenceSessions, eligibleAt, momOf, kTop, kTopQuintile, prepBook, runBook, pickTop, pickBottom, pickAll, pickLookahead, excessStats, placeboRun, returnsOf, strataOf, constructPanel,
  strategyOn, constructionRun, decide, preReadDecision, calibrate, judge, nwT, nwSimP95, barAtN, schwabDate, packRows, coverageSummary, computeRead, selftest, mulberry, universeOfEntry,
  UNIVERSE, REPORTED_ONLY, COST, COST_2X, PLACEBO_DRAWS, PLACEBO_SEED, CAL_SEEDS, RUNNER_GATES, fin };
