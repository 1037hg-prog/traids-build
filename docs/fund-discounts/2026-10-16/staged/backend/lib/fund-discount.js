"use strict";
/**
 * R354 — CLOSED-END FUND DISCOUNTS: the engine.
 *
 * WHAT THIS FILE IS. Every number of R354 (backend/data/test-registry.json, preregistered[] id R354) is computed here, as pure
 * functions over series handed in by the caller. It opens no file, makes no network call, reads no environment variable and asks no
 * clock: the runner (backend/r354-fund-discounts.js) does the reading and hands the bytes in, so that the same code runs on the real
 * frozen cache and on the selftest's small made-up series. Rule [14] of the entry: no flag, setting or environment variable changes a
 * number of the rule or of the statistic — there is nothing here to change one with.
 *
 * NOTHING HERE DECIDES WHEN A READ MAY HAPPEN. The read condition lives in the runner and is checked before any of this is called on
 * the holdout rows. This file will compute a statistic on whatever it is given, including made worlds; the runner is what refuses.
 *
 * THE SHAPES IT TAKES.
 *   series   { symbol, type, exchange, rows: [{ d:"YYYY-MM-DD", o, h, l, c, v }], dividends: [{ d, amount }],
 *              splits: [{ d, num, den }] }        — raw Yahoo chart v8 daily rows, split-adjusted closes (never the adjusted close)
 *   universe [ { ticker, navSymbol, categoryName, term, inceptionDate } ]            — the frozen list, descriptive fields only
 *   cache    { "^GSPC": series, "ABC": series, "XABCX": series, ... }
 *
 * k, THE SPLIT FACTOR. Yahoo multiplies every close BEFORE a split by den/num (a 2:1 split: 0.5). k = den/num throughout, exactly as
 * rule [4] uses it ("the factor Yahoo applies to earlier prices"), so a NAV history that was never adjusted shows a one-day step
 * q = N[t]/N[prev] close to k on the split date, and repairing it means multiplying every earlier NAV row by k.
 *
 * TWO READINGS ARE WRITTEN DOWN HERE AND IN THE PACKAGE'S NOTES.md; neither changes a number of the rule:
 *   - [3] decision mode says "a SUSPECT row is taken out of a window" once its undo row is dated s or earlier. Measurement mode says
 *     the wrong print "is removed with the rows between". We remove the episode (the suspect row and the rows between it and the undo
 *     row) in BOTH modes, so a two-row wrong print never leaves its second row in a window.
 *   - [7] asks that d[s] < 0 hold "whichever way every UNVERIFIED EVENT dated after s is resolved". d[s] = P[s]/(N[s]*m) - 1 falls as
 *     m rises, so the binding resolution is the smallest multiplier: m = 1 and m = the product of min(k,1) over the unverified events
 *     after s are both tested, and the second is the worst case over every combination.
 */

// ───────────────────────────────────────────────────────── small arithmetic ─────────────────────────────────────────────────────────
const fin = (x) => typeof x === "number" && Number.isFinite(x);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
/** sample standard deviation, n - 1 (rule [5]) */
function sdSample(a) { const n = a.length; if (n < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (n - 1)); }
function median(a) { if (!a.length) return null; const b = [...a].sort((x, y) => x - y), h = b.length >> 1; return b.length % 2 ? b[h] : (b[h - 1] + b[h]) / 2; }
/** the p-th percentile by the nearest-rank rule used across the house's null bars (p in 0..1) */
function pct(a, p) { if (!a.length) return null; const b = [...a].sort((x, y) => x - y), i = Math.min(b.length - 1, Math.max(0, Math.ceil(p * b.length) - 1)); return b[i]; }
/**
 * NEWEY-WEST t, Bartlett weights, lag L — the house formula (as in backend/hunt/*.js and backend/lib/tv-pit-panel.js nwT at home):
 *   v = g0 + 2 * sum_{k=1..L} (1 - k/(L+1)) * gk, every gk divided by n;  t = mean / sqrt(v / n).
 * Returns null when it cannot be formed (n < 6, or a variance that is not above zero): a null t never passes a bar.
 */
function nwT(a, L = 4) {
  const n = a.length; if (n < 6) return null;
  const m = mean(a), d = a.map((x) => x - m);
  let v = d.reduce((s, x) => s + x * x, 0) / n;
  for (let k = 1; k <= L; k++) { let c = 0; for (let i = k; i < n; i++) c += d[i] * d[i - k]; v += 2 * (1 - k / (L + 1)) * c / n; }
  return v > 0 ? m / Math.sqrt(v / n) : null;
}
/** mulberry32 — the house generator, bit for bit (backend/r307-ride-the-wave.js and others) */
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r3 = (x) => (fin(x) ? Math.round(x * 1000) / 1000 : null);
const r2 = (x) => (fin(x) ? Math.round(x * 100) / 100 : null);

// ───────────────────────────────────────────────────────────── the calendar ─────────────────────────────────────────────────────────
const monthKey = (d) => d.slice(0, 7);
/** the half-month a day belongs to: the 1st to the 15th, then the 16th to the end (rule [0]) */
const halfMonthKey = (d) => `${d.slice(0, 7)}-${+d.slice(8, 10) <= 15 ? "H1" : "H2"}`;
const dow = (d) => new Date(d + "T12:00:00Z").getUTCDay();
/** the second Monday of October of a year, as YYYY-MM-DD */
function secondMondayOfOctober(year) {
  for (let day = 8; day <= 14; day++) { const d = `${year}-10-${String(day).padStart(2, "0")}`; if (dow(d) === 1) return d; }
  return null;
}
/**
 * BOND HOLIDAY (rule [6](c)): the NYSE is open and the US bond market is closed — the second Monday of October, and 11 November, or
 * 12 November when the 11th is a Sunday. Whether the NYSE is open that day is the calendar's business (the day is in marketDays).
 */
function isBondHoliday(d) {
  const y = d.slice(0, 4);
  if (d === secondMondayOfOctober(+y)) return true;
  const nov11 = `${y}-11-11`;
  return d === (dow(nov11) === 0 ? `${y}-11-12` : nov11);
}
/** the market calendar: the dates ^GSPC has a row for (rule [1]) */
function makeCalendar(gspc) {
  if (!gspc || !Array.isArray(gspc.rows) || !gspc.rows.length) throw new Error("no ^GSPC rows: the market calendar cannot be built");
  const days = gspc.rows.map((r) => r.d).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const idx = new Map(); days.forEach((d, i) => idx.set(d, i));
  if (idx.size !== days.length) throw new Error("the ^GSPC rows hold the same date twice");
  return { days, idx, at: (i) => (i >= 0 && i < days.length ? days[i] : null), of: (d) => (idx.has(d) ? idx.get(d) : -1) };
}

// ───────────────────────────────────────────────── the registered constants (parameters{}) ─────────────────────────────────────────
/**
 * PARAMS — the runner's frozen constants. readCondition (1): a read refuses unless these equal the registry entry's parameters{},
 * field for field (paramsDiff below). They are frozen so that nothing can write one at run time.
 */
const PARAMS = Object.freeze({
  account: 100000, places: 24, stakeUsd: 4000, halfMonthSlots: 1,
  lookbackDays: 252, windowMinRows: 230, zEntry: -2, confirmDays: 2, historyRows: 756, holdDays: 252, entryWithinDays: 3,
  liquidityUsd: 400000, liquidityDays: 30, minPrice: 5, band: Object.freeze([0.5, 2]),
  staleRunRow: 3, navChangesOf252: 100, navChangesOf21: 8, feedFreezeShare: 0.4, feedFreezeTimesMedian: 2,
  suspectNav: 1.3, suspectPrice: 1.9, suspectOtherSeriesMax: 0.15, suspectReturnRows: 3, suspectReturnWithin: 0.15, suspectBlockDays: 3,
  unitLogTolerance: 0.1, unitSearchDays: 2,
  exDateBigPct: 1, exDateBigDays: 3, exDateAnyDays: 1, cleanStartWithinDays: 5, skipDays: 21,
  seenWindows: Object.freeze([Object.freeze(["2008-09-01", "2008-12-31"]), Object.freeze(["2020-02-01", "2020-04-30"])]),
  classCostPct: Object.freeze({ MUNI: 0.8, TAXABLE_BOND: 1.08, US_EQ: 1.02, FOREIGN_EQ: 1.36 }),
  ownSpreadTimes: 2, unquotedTimes: 1.5, spreadSessions: 10, spreadCoverage: 0.8,
  costGroups: Object.freeze({
    MUNI: Object.freeze(["Municipal", "Municipal-CA", "Municipal-NY", "Municipal-Single State"]),
    TAXABLE_BOND: Object.freeze(["Investment Grade", "High Yield", "Senior Loans", "Limited Duration", "Multi-Sector", "Preferreds", "Convertibles", "Taxable Muni", "Global Income", "Emerging Market Income"]),
    US_EQ: Object.freeze(["US Equity", "Sector Equity", "Covered Call", "US Allocation", "Real Estate", "MLP"]),
    FOREIGN_EQ: Object.freeze(["Asia Equity", "Emerging Market Equity", "Single Country Equity", "Global Equity", "Global Allocation"]),
  }),
  foreignClockClasses: Object.freeze(["Asia Equity", "Emerging Market Equity", "Single Country Equity", "Global Equity", "Global Allocation", "Global Income", "Emerging Market Income"]),
  spans: Object.freeze({
    discovery: Object.freeze({ first: "2003-01-02", last: "2011-12-30", months: 108, minMonthsWithPosition: 72, minRoundTrips: 60 }),
    holdout: Object.freeze({ first: "2012-01-03", last: "2026-09-30", months: 177, minMonthsWithPosition: 120, minRoundTrips: 100 }),
  }),
  neweyWestLag: 4, placeboDraws: 500, placeboSeed: 20261012, bootstrapTrials: 20000, bootstrapSeed: 20261012, bootstrapBlockMonths: 13,
  shiftedBooks: 500, shiftedBooksOnAWorld: 100, shiftSeed: 20266012, tRequired: 1.727,
  worlds: 200, worldsDecidingTMax: 16, worldsWholeRuleMax: 10, plantedWorlds: 20, plantedMin: 10, halfLifeDays: 162,
  plantedSizesPctPerMonth: Object.freeze([0.2, 0.34, 0.78]), tooGoodUsd: 1517, tooGoodT: 6, catalogueUsd: 500, maxNoCleanShare: 0.1,
  twinCaliper: 0.02, twinZ: 1, twinMinMatched: 0.5, peerMin: 3,
  lateDays: 3, lateOf: 2, lateAllShare: 0.05, replayPairs: 2000,
  secondSourceShare: 0.95, secondSourcePoints: 0.5, edgarFunds: 30, edgarPoints: 1, auditSignals: 40, auditPoints: 2, auditMaxVoid: 8,
  attritionPoints: 15, cacheNotBefore: "2026-10-15", settleDays: 10, lapse: "2027-01-31",
  universeFile: "docs/fund-discounts/2026-10-12/scout-universe.json",
  universeSha256: "9a5524e7e8f0ae299a4f18eb078adc0ae6c0f7ea54ed8d08ed6aba28b240fee8",
  listAsOf: "2026-10-09",
  universeCounts: Object.freeze({ list: 359, universe: 298, MUNI: 63, TAXABLE_BOND: 112, US_EQ: 85, FOREIGN_EQ: 38, foreignClock: 54 }),
});
/** every number the entry fixes beyond parameters{}: the registered bar and the span minimums it is read against */
const BAR = Object.freeze({ tRequired: 1.727, tRequiredDiscoveryReportedOnly: 1.73, unit: "months", variants: 1, lag: 4 });
const RULE_SHA256 = "82d7586f3c5d781244602bb1c6021937c5d29c92e5e23cd462859723ede00c39";
const RULE_SHA_KEYS = Object.freeze(["rule", "statistic", "definitions", "bar", "controls", "decisionRule"]);

/** deep compare of the runner's frozen constants with the registry's parameters{} -> [] or the differences, in words */
function paramsDiff(registered, frozen = PARAMS) {
  const out = [];
  const walk = (a, b, at) => {
    const ta = a === null ? "null" : Array.isArray(a) ? "array" : typeof a, tb = b === null ? "null" : Array.isArray(b) ? "array" : typeof b;
    if (ta !== tb) { out.push(`${at}: the registry has ${ta} ${JSON.stringify(a)}, the runner ${tb} ${JSON.stringify(b)}`); return; }
    if (ta === "array") { if (a.length !== b.length) { out.push(`${at}: the registry has ${a.length} entries, the runner ${b.length}`); return; } a.forEach((x, i) => walk(x, b[i], `${at}[${i}]`)); return; }
    if (ta === "object") {
      const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
      for (const k of ka) if (!kb.includes(k)) out.push(`${at}.${k}: the registry has it, the runner does not`);
      for (const k of kb) if (!ka.includes(k)) out.push(`${at}.${k}: the runner has it, the registry does not`);
      for (const k of ka) if (kb.includes(k)) walk(a[k], b[k], `${at}.${k}`);
      return;
    }
    if (a !== b) out.push(`${at}: the registry says ${JSON.stringify(a)}, the runner ${JSON.stringify(b)}`);
  };
  walk(registered, frozen, "parameters");
  return out;
}

// ──────────────────────────────────────────────── rule [4]: units, and rule [3]: suspect rows ──────────────────────────────────────
/** the split events of a price series, newest last, with k = den/num and whether rule [4] calls them LARGE */
function splitEvents(series, P = PARAMS) {
  const out = [];
  for (const s of series.splits || []) {
    const num = Number(s.num), den = Number(s.den);
    if (!fin(num) || !fin(den) || num <= 0 || den <= 0) continue;
    const k = den / num;
    out.push({ d: s.d, k, large: Math.abs(Math.log(k)) > P.unitLogTolerance });
  }
  return out.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
}
/**
 * RULE [4] UNITS. For each split event (date T, factor k) the one-day NAV step q = N[t]/N[previous valid row] is looked for on each of
 * the five market days T-2..T+2.
 *   LARGE (|ln k| > 0.10): exactly one of the five with |ln q - ln k| <= 0.10 -> REPAIR (every NAV row before that day times k);
 *                          none of the five with |ln q| > 0.10 -> already adjusted, nothing done; anything else -> UNVERIFIED at T.
 *   SMALL (|ln k| <= 0.10): always UNVERIFIED at T.
 * Returns { events, navMul } : events classified for V3, and navMul[i] = the factor the NAV row at calendar index i is multiplied by
 * (the product of the k of every repair whose matched day is after i).
 */
function unitRepair({ cal, navRaw, splits, P = PARAMS }) {
  const events = [], repairs = [];
  for (const e of splits) {
    const T = cal.of(e.d);
    const classify = () => {
      if (T < 0) return { kind: "unverified-large", why: "the split date is not a market day of the calendar" };
      const hits = [], moves = [];
      for (let i = T - P.unitSearchDays; i <= T + P.unitSearchDays; i++) {
        if (i < 0 || i >= cal.days.length) continue;
        if (!fin(navRaw[i]) || navRaw[i] <= 0) continue;
        let j = i - 1; while (j >= 0 && !(fin(navRaw[j]) && navRaw[j] > 0)) j--;
        if (j < 0) continue;
        const q = navRaw[i] / navRaw[j];
        if (!fin(q) || q <= 0) continue;
        if (Math.abs(Math.log(q) - Math.log(e.k)) <= P.unitLogTolerance) hits.push(i);
        if (Math.abs(Math.log(q)) > P.unitLogTolerance) moves.push(i);
      }
      if (!e.large) return { kind: "unverified-small", why: "a ratio under 10% cannot be told from an ordinary NAV move" };
      if (hits.length === 1) return { kind: "repaired", at: cal.at(hits[0]), atIdx: hits[0] };
      if (moves.length === 0) return { kind: "adjusted", why: "no NAV step above 10% on the five days: the history was already in post-split units" };
      return { kind: "unverified-large", why: hits.length > 1 ? `${hits.length} of the five days show the split's own step` : "a NAV step above 10% on the five days that is not the split's" };
    };
    const c = classify();
    events.push({ d: e.d, k: e.k, large: e.large, ...c });
    if (c.kind === "repaired") repairs.push({ atIdx: c.atIdx, k: e.k });
  }
  const navMul = new Float64Array(cal.days.length).fill(1);
  for (const r of repairs) for (let i = 0; i < r.atIdx; i++) navMul[i] *= r.k;
  return { events, navMul };
}
/**
 * RULE [3] SUSPECT ROWS. A NAV row 1.3x or more (or 1/1.3 or less) of the previous valid NAV row, on a day the price changes by under
 * 15%, is SUSPECT; a price row 1.9x or more (or 1/1.9 or less) of the previous valid price row, on a day the NAV changes by under 15%,
 * that no split event dated within two market days explains, is SUSPECT. For each suspect row the UNDO row is the first of the next 3
 * valid rows of the same series that is within 15% of the value before the step; the suspect row and the rows between it and the undo
 * row are the episode. Returns [{ series, i, undoIdx, lastIdx, kind }] sorted by i (lastIdx = the last row of the episode).
 */
function suspectRows({ cal, price, nav, splits, P = PARAMS }) {
  const n = cal.days.length, out = [];
  const prevValid = (arr, i) => { let j = i - 1; while (j >= 0 && !(fin(arr[j]) && arr[j] > 0)) j--; return j; };
  const scan = (arr, other, factor, kind) => {
    for (let i = 0; i < n; i++) {
      if (!(fin(arr[i]) && arr[i] > 0)) continue;
      const j = prevValid(arr, i); if (j < 0) continue;
      const step = arr[i] / arr[j];
      if (!(step >= factor || step <= 1 / factor)) continue;
      // the other series must have moved by under 15% on the same day (null on either side = no move it can show)
      const o1 = fin(other[i]) && other[i] > 0 ? other[i] : null, oj = prevValid(other, i), o0 = oj >= 0 ? other[oj] : null;
      const otherMove = o1 != null && o0 != null ? Math.abs(o1 / o0 - 1) : 0;
      if (otherMove >= P.suspectOtherSeriesMax) continue;
      if (kind === "price") {
        const T = cal.at(i), explained = splits.some((e) => Math.abs(cal.of(e.d) - i) <= P.unitSearchDays && cal.of(e.d) >= 0 && Math.abs(Math.log(step) - Math.log(e.k)) <= P.unitLogTolerance);
        if (explained || T == null) continue;
      }
      // the undo row: the first of the next 3 valid rows within 15% of the value before the step
      let undoIdx = null, lastIdx = i, seen = 0, m = i + 1;
      for (; m < n && seen < P.suspectReturnRows; m++) {
        if (!(fin(arr[m]) && arr[m] > 0)) continue;
        seen++;
        if (Math.abs(arr[m] / arr[j] - 1) <= P.suspectReturnWithin) { undoIdx = m; break; }
        lastIdx = m;
      }
      out.push({ series: kind, i, undoIdx, lastIdx: undoIdx == null ? lastIdx : undoIdx - 1, step });
    }
  };
  scan(nav, price, P.suspectNav, "nav");
  scan(price, nav, P.suspectPrice, "price");
  return out.sort((a, b) => a.i - b.i);
}

// ──────────────────────────────────────────────────────── one fund, prepared ────────────────────────────────────────────────────────
/** which cost group a Morningstar category name belongs to (parameters.costGroups), or null */
function costGroupOf(categoryName, P = PARAMS) {
  const c = String(categoryName || "").replace(/^Morningstar US CEF /, "").trim();
  for (const [g, list] of Object.entries(P.costGroups)) if (list.includes(c)) return g;
  return null;
}
/**
 * PREPARE ONE FUND: the price and NAV series on the market calendar, the units repaired, the suspect rows found, the valid rows and
 * d[t] of rule [5], the as-traded close and volume of [6](e), and the distribution list of [11].
 * Rule [1]: a null row is a missing row and nothing is ever carried forward. The adjusted close is never read.
 */
function prepareFund({ cal, row, price, nav, P = PARAMS, navMulOverride = null }) {
  const n = cal.days.length;
  const Pz = new Float64Array(n).fill(NaN), V = new Float64Array(n).fill(NaN), Nraw = new Float64Array(n).fill(NaN);
  for (const r of price.rows || []) { const i = cal.of(r.d); if (i >= 0) { Pz[i] = fin(r.c) ? r.c : NaN; V[i] = fin(r.v) ? r.v : NaN; } }
  for (const r of nav.rows || []) { const i = cal.of(r.d); if (i >= 0) Nraw[i] = fin(r.c) ? r.c : NaN; }
  const splits = splitEvents(price, P);
  // navMulOverride: ONLY the as-of replay of V2 uses it. The replay cuts the rows at s but keeps the unit resolution of the events
  // dated after s, because the entry's timing[] calls a split ratio "used for unit conversion only" and announces ex-dates in advance;
  // everything that could carry a LEVEL from the future (prices, NAVs, volumes, wrong prints) is cut. Nothing else may pass it.
  const { events, navMul: navMulOwn } = unitRepair({ cal, navRaw: Nraw, splits, P });
  const navMul = navMulOverride || navMulOwn;
  const N = new Float64Array(n).fill(NaN); for (let i = 0; i < n; i++) if (fin(Nraw[i])) N[i] = Nraw[i] * navMul[i];
  const suspect = suspectRows({ cal, price: Pz, nav: N, splits, P });
  // as-traded (rule [6](e)): Yahoo's value with every LATER split ratio undone — close / prod(k), volume * prod(k)
  const asTradedClose = new Float64Array(n).fill(NaN), asTradedVol = new Float64Array(n).fill(NaN);
  { let f = 1, si = splits.length - 1;
    for (let i = n - 1; i >= 0; i--) {
      while (si >= 0 && cal.of(splits[si].d) > i) { f *= splits[si].k; si--; }
      if (fin(Pz[i])) asTradedClose[i] = Pz[i] / f;
      if (fin(V[i])) asTradedVol[i] = V[i] * f;
    } }
  // rule [5]: a row is VALID when both closes are finite and positive and 0.5 <= P/N <= 2.0; d = P/N - 1 on valid rows
  const valid = new Uint8Array(n), d = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!(fin(Pz[i]) && Pz[i] > 0 && fin(N[i]) && N[i] > 0)) continue;
    const q = Pz[i] / N[i];
    if (q < P.band[0] || q > P.band[1]) continue;
    valid[i] = 1; d[i] = q - 1;
  }
  // the NAV run of identical values: run[i] = how many-th row of its run this NAV row is (1 = the first)
  const navRun = new Int32Array(n); { let last = null, c = 0; for (let i = 0; i < n; i++) { if (!fin(N[i])) continue; if (last != null && N[i] === last) c++; else c = 1; navRun[i] = c; last = N[i]; } }
  // the index of the previous NAV row, for [6](d) and the clean start's "differs from the previous valid NAV row"
  const prevNavIdx = new Int32Array(n).fill(-1); { let p = -1; for (let i = 0; i < n; i++) { prevNavIdx[i] = p; if (fin(N[i])) p = i; } }
  const dists = (price.dividends || []).filter((x) => fin(Number(x.amount)) && Number(x.amount) > 0 && cal.of(x.d) >= 0)
    .map((x) => ({ d: x.d, i: cal.of(x.d), amount: Number(x.amount) })).sort((a, b) => a.i - b.i);
  const group = costGroupOf(row.categoryName, P);
  const category = String(row.categoryName || "").replace(/^Morningstar US CEF /, "").trim();
  return Object.freeze({
    ticker: row.ticker, navSymbol: row.navSymbol, category, group, term: !!row.term, termDate: row.termDate || null,
    inceptionDate: row.inceptionDate || null, foreignClock: P.foreignClockClasses.includes(category),
    cal, P: Pz, V, N, Nraw, navMul, valid, d, navRun, prevNavIdx, asTradedClose, asTradedVol, splits, events, suspect, dists,
    navType: nav.type || null, navExchange: nav.exchange || null,
    firstPriceRow: (price.rows || []).length ? price.rows[0].d : null, firstNavRow: (nav.rows || []).length ? nav.rows[0].d : null,
  });
}
/**
 * [1] A NAV SYMBOL IS ACCEPTED only if Yahoo types it MUTUALFUND on exchange NAS with zero volume and open = high = low = close on
 * every valued row. -> { ok, why }
 */
function navSymbolAccepted(nav) {
  if (!nav || !Array.isArray(nav.rows) || !nav.rows.length) return { ok: false, why: "no NAV rows" };
  if (String(nav.type || "").toUpperCase() !== "MUTUALFUND") return { ok: false, why: `Yahoo types it ${nav.type || "(nothing)"}, not MUTUALFUND` };
  if (String(nav.exchange || "").toUpperCase() !== "NAS") return { ok: false, why: `exchange ${nav.exchange || "(nothing)"}, not NAS` };
  for (const r of nav.rows) {
    if (!fin(r.c) || r.c <= 0) continue;                                                   // an unvalued row says nothing
    if (fin(r.v) && r.v !== 0) return { ok: false, why: `volume ${r.v} on ${r.d}` };
    for (const f of ["o", "h", "l"]) if (fin(r[f]) && r[f] !== r.c) return { ok: false, why: `${f} != close on ${r.d}` };
  }
  return { ok: true, why: null };
}

// ──────────────────────────────────── the episodes of rule [3], in the two modes it is run in ─────────────────────────────────────
/**
 * WRONG PRINTS (measurement mode): a suspect row followed within 3 valid rows by a row within 15% of the value before the step. The
 * episode (the suspect row and the rows between it and the undo row) is removed from the series. Returns Set of calendar indices.
 */
function wrongPrintSet(fund) {
  const s = new Set();
  for (const e of fund.suspect) if (e.undoIdx != null) for (let i = e.i; i <= e.lastIdx; i++) s.add(i);
  return s;
}
/**
 * REMOVED AS OF s (decision mode): the same episodes, but only those whose undo row is dated s or earlier ("nothing dated after s
 * decides anything on s"). Returns a predicate i -> boolean, built once per s from the fund's own list (it is short).
 */
function removedAsOf(fund, sIdx) {
  const s = new Set();
  for (const e of fund.suspect) if (e.undoIdx != null && e.undoIdx <= sIdx) for (let i = e.i; i <= e.lastIdx; i++) s.add(i);
  return s;
}
/** is there a SUSPECT row on s or within the given number of market days before s, from the series cut off at s? ([6](f), [3]) */
function suspectOnOrBefore(fund, sIdx, days) {
  for (const e of fund.suspect) if (e.i <= sIdx && e.i >= sIdx - days) return true;
  return false;
}
/** the UNVERIFIED EVENTS of a fund, as dates and calendar indices */
function unverifiedEvents(fund) {
  return fund.events.filter((e) => e.kind === "unverified-small" || e.kind === "unverified-large")
    .map((e) => ({ d: e.d, i: fund.cal.of(e.d), k: e.k, large: e.large }));
}

// ───────────────────────────────────────────────── rule [5]: the discount and its z-score ──────────────────────────────────────────
/**
 * z[s] = (d[s] - m[s]) / sd[s], where the window is the 252 market days strictly before s (s is not in its own window), at least 230
 * of them valid, sd the sample standard deviation (n - 1) and above zero. `removed` is the episode set for the mode being run.
 * -> { z, rows, m, sd, d } or null when the window cannot be formed or s itself is not usable.
 */
function zAt(fund, sIdx, removed, P = PARAMS) {
  if (sIdx <= 0 || sIdx >= fund.cal.days.length) return null;
  if (!fund.valid[sIdx] || removed.has(sIdx)) return null;
  const w = [];
  for (let i = Math.max(0, sIdx - P.lookbackDays); i < sIdx; i++) if (fund.valid[i] && !removed.has(i)) w.push(fund.d[i]);
  if (w.length < P.windowMinRows) return { z: null, rows: w.length, m: null, sd: null, d: fund.d[sIdx] };
  const m = mean(w), sd = sdSample(w);
  if (!fin(sd) || !(sd > 0)) return { z: null, rows: w.length, m, sd, d: fund.d[sIdx] };
  return { z: (fund.d[sIdx] - m) / sd, rows: w.length, m, sd, d: fund.d[sIdx] };
}
/** how many valid rows strictly before s ([6](a)) */
function validRowsBefore(fund, sIdx, removed) { let c = 0; for (let i = 0; i < sIdx; i++) if (fund.valid[i] && !removed.has(i)) c++; return c; }

// ─────────────────────────────────────────── the universe, and what only the universe knows ───────────────────────────────────────
/**
 * PREPARE THE UNIVERSE (rule [2]): the funds of the frozen list with both series, an accepted NAV symbol and no term date. Everything
 * the per-fund rules cannot see on their own is computed here: the FEED-FREEZE day of [6](c) (a share of the whole universe) and the
 * cost-group peer lists of S4.
 *   -> { cal, funds, dropped, freeze: { share, median252, isFreeze }, byTicker }
 */
function prepareUniverse({ cache, universe, P = PARAMS }) {
  const cal = makeCalendar(cache["^GSPC"]);
  const funds = [], dropped = [];
  for (const row of universe) {
    const price = cache[row.ticker], nav = cache[row.navSymbol];
    if (!price || !Array.isArray(price.rows) || !price.rows.length) { dropped.push({ ticker: row.ticker, why: "no price series in the cache" }); continue; }
    if (!nav || !Array.isArray(nav.rows) || !nav.rows.length) { dropped.push({ ticker: row.ticker, why: "no NAV series in the cache" }); continue; }
    const acc = navSymbolAccepted(nav);
    if (!acc.ok) { dropped.push({ ticker: row.ticker, why: `the NAV symbol is not accepted under [1]: ${acc.why}` }); continue; }
    if (row.term) { dropped.push({ ticker: row.ticker, why: "a term date on the frozen list: it cannot be bought, be a placebo or be a control" }); continue; }
    if (!costGroupOf(row.categoryName, P)) { dropped.push({ ticker: row.ticker, why: `its category (${row.categoryName}) is in no cost group` }); continue; }
    funds.push(prepareFund({ cal, row, price, nav, P }));
  }
  const n = cal.days.length, share = new Float64Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    let valued = 0, same = 0;
    for (const f of funds) {
      const a = f.N[i], b = f.N[i - 1];
      if (!(fin(a) && a > 0 && fin(b) && b > 0)) continue;
      valued++; if (a === b) same++;
    }
    if (valued > 0) share[i] = same / valued;
  }
  const isFreeze = new Uint8Array(n), med252 = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const w = []; for (let j = Math.max(0, i - P.lookbackDays); j < i; j++) if (fin(share[j])) w.push(share[j]);
    if (!w.length || !fin(share[i])) continue;
    const m = median(w); med252[i] = m;
    if (share[i] >= P.feedFreezeShare && share[i] >= P.feedFreezeTimesMedian * m) isFreeze[i] = 1;
  }
  const byTicker = new Map(funds.map((f) => [f.ticker, f]));
  return { cal, funds, dropped, freeze: { share, median252: med252, isFreeze }, byTicker };
}

// ────────────────────────────────────────────── rule [6] ELIGIBLE, and rule [7] SIGNAL ─────────────────────────────────────────────
/** is s inside one of the two SEEN WINDOWS of [6](h)? */
const inSeenWindow = (day, P = PARAMS) => P.seenWindows.some(([a, b]) => day >= a && day <= b);
/** the quarantines a pre-read gate wrote: { ticker: [{ from, to, why }] } — from/to are dates, either may be null (open-ended) */
function quarantined(q, ticker, day) {
  const list = (q && q[ticker]) || [];
  return list.some((x) => (!x.from || day >= x.from) && (!x.to || day <= x.to));
}
/**
 * RULE [6] ELIGIBLE ON s, every clause, from the series cut off at s. ex-dates are allowed to look forward ("they are announced in
 * advance"), and so are later split ratios in [7]'s both-ways test; nothing else dated after s decides anything on s.
 *  -> { ok, why: [failed clause ids], z, d }
 */
function eligible({ uni, fund, sIdx, removed = null, controls = {}, P = PARAMS }) {
  const day = fund.cal.at(sIdx), why = [];
  const rm = removed || removedAsOf(fund, sIdx);
  if (day == null) return { ok: false, why: ["not a market day"], z: null };
  if (inSeenWindow(day, P)) why.push("h");                                                                   // (h) a seen window
  if (quarantined(controls.quarantines, fund.ticker, day)) why.push("i");                                    // (i) a pre-read gate's quarantine
  if (validRowsBefore(fund, sIdx, rm) < P.historyRows) why.push("a");                                        // (a) 756 valid rows of history
  const prev = sIdx - 1;
  if (!(fund.valid[sIdx] && !rm.has(sIdx) && prev >= 0 && fund.valid[prev] && !rm.has(prev) && fin(fund.V[sIdx]) && fund.V[sIdx] > 0)) why.push("b");  // (b)
  // (c) fresh NAV: not the third or later row of an identical run; not a feed-freeze day; not a bond holiday
  if (fund.navRun[sIdx] >= P.staleRunRow || uni.freeze.isFreeze[sIdx] || isBondHoliday(day)) why.push("c");
  // (d) daily NAV: the NAV differs from the previous row on at least 100 of the 252 rows ending at s, and 8 of the 21
  const navChanges = (win) => { let c = 0; for (let i = Math.max(0, sIdx - win + 1); i <= sIdx; i++) { const p = fund.prevNavIdx[i]; if (fin(fund.N[i]) && p >= 0 && fund.N[i] !== fund.N[p]) c++; } return c; };
  if (navChanges(P.lookbackDays) < P.navChangesOf252 || navChanges(21) < P.navChangesOf21) why.push("d");
  // (e) liquidity: the median of as-traded close x as-traded volume over the 30 market days ending at s, a missing row counting $0
  const dv = []; for (let i = Math.max(0, sIdx - P.liquidityDays + 1); i <= sIdx; i++) dv.push(fin(fund.asTradedClose[i]) && fin(fund.asTradedVol[i]) ? fund.asTradedClose[i] * fund.asTradedVol[i] : 0);
  const medDv = median(dv);
  if (!(medDv >= P.liquidityUsd) || !(fin(fund.asTradedClose[sIdx]) && fund.asTradedClose[sIdx] >= P.minPrice)) why.push("e");
  // (f) events: no unverified event in the 252 market days before s or on s; a LARGE one blocks the fund until 252 days after it;
  //     no suspect row on s or the 3 market days before it
  const uev = unverifiedEvents(fund);
  if (uev.some((e) => e.i >= 0 && e.i <= sIdx && e.i >= sIdx - P.lookbackDays)) why.push("f");
  else if (uev.some((e) => e.large && e.i >= 0 && e.i >= sIdx - P.lookbackDays)) why.push("f");               // a later LARGE one blocks from its own first row
  else if (suspectOnOrBefore(fund, sIdx, P.suspectBlockDays)) why.push("f");
  // (g) ex-dates: no distribution of 1% of the price or more within the 3 market days ending at s or the 3 after s
  const px = fin(fund.P[sIdx]) ? fund.P[sIdx] : null;
  if (px != null && fund.dists.some((x) => x.i >= sIdx - P.exDateBigDays && x.i <= sIdx + P.exDateBigDays && x.amount >= (P.exDateBigPct / 100) * px)) why.push("g");
  const zz = why.length ? null : zAt(fund, sIdx, rm, P);
  return { ok: why.length === 0, why, z: zz ? zz.z : null, d: fund.valid[sIdx] ? fund.d[sIdx] : null, medDv, zDetail: zz };
}
/**
 * d[s] < 0 WHICHEVER WAY every UNVERIFIED EVENT dated after s is resolved (rule [7]). The binding case is the smallest NAV multiplier
 * (see the header): m = 1 and m = prod(min(k,1)) over the unverified events after s.
 */
function belowValueBothWays(fund, sIdx, P = PARAMS) {
  if (!fund.valid[sIdx]) return false;
  let mMin = 1;
  for (const e of unverifiedEvents(fund)) if (e.i > sIdx && fin(e.k) && e.k > 0) mMin *= Math.min(e.k, 1);
  const p = fund.P[sIdx], n = fund.N[sIdx];
  return p / n - 1 < 0 && p / (n * mMin) - 1 < 0;
}
/**
 * RULE [7] SIGNAL ON s: eligible, z[s] < -2, z of the market day before s < -2, d[s] < 0 both ways, and the fund is neither held nor
 * pending. `held` is a predicate ticker -> boolean supplied by the book.
 *  -> { signal, z, zPrev, why } ; `why` names the first clause that failed, for the selftest and the counts.
 */
function signalAt({ uni, fund, sIdx, controls = {}, held = () => false, P = PARAMS }) {
  const e = eligible({ uni, fund, sIdx, controls, P });
  if (!e.ok) return { signal: false, why: `[6](${e.why.join(",")})`, z: null, zPrev: null };
  if (!(e.z != null && e.z < P.zEntry)) return { signal: false, why: "z[s]", z: e.z, zPrev: null };
  const rmPrev = removedAsOf(fund, sIdx - 1), zp = zAt(fund, sIdx - 1, rmPrev, P);
  const zPrev = zp ? zp.z : null;
  if (!(zPrev != null && zPrev < P.zEntry)) return { signal: false, why: "z[s-1]", z: e.z, zPrev };
  if (!belowValueBothWays(fund, sIdx, P)) return { signal: false, why: "d[s]<0 both ways", z: e.z, zPrev };
  if (held(fund.ticker)) return { signal: false, why: "held or pending", z: e.z, zPrev };
  return { signal: true, why: null, z: e.z, zPrev, medDv: e.medDv };
}
/** the placebo's and the shifted book's day conditions: eligible under [6] and d[t] < 0 — the signal's own conditions with the two z tests taken out */
function placeboDayOk({ uni, fund, sIdx, controls = {}, P = PARAMS }) {
  const e = eligible({ uni, fund, sIdx, controls, P });
  return e.ok && belowValueBothWays(fund, sIdx, P);
}

// ───────────────────────────────────────── rule [9] ENTRY, [10] EXIT, [11] MONEY, [12] COST ────────────────────────────────────────
/** a price row that money may be taken at: it exists, has volume above zero, and is not a wrong print ([5], [3], monthEndMark) */
function tradedAt(fund, i, wrong) { return i >= 0 && i < fund.cal.days.length && fin(fund.P[i]) && fund.P[i] > 0 && fin(fund.V[i]) && fund.V[i] > 0 && !wrong.has(i); }
/**
 * THE COST of one round trip (rule [12]): c = max(the fund's class cost, 2 x its own measured spread); a fund the house quote source
 * cannot quote — and every fund, if no table covering 80% of the universe exists — is charged 1.5 x its class cost. Half is charged at
 * each fill on that fill's dollar value. Returns the round-trip fraction (not a percentage).
 */
function roundTripCost(fund, costTable, P = PARAMS) {
  const cls = P.classCostPct[fund.group] / 100;
  const covered = costTable && costTable.coverage >= P.spreadCoverage && costTable.spreads && fin(Number(costTable.spreads[fund.ticker]));
  if (!covered) return { c: P.unquotedTimes * cls, basis: costTable && costTable.coverage >= P.spreadCoverage ? "1.5x class cost (this fund is not quoted)" : "1.5x class cost (no table covering 80% of the universe)" };
  const own = P.ownSpreadTimes * Number(costTable.spreads[fund.ticker]);
  return { c: Math.max(cls, own), basis: own > cls ? "twice its own measured spread" : "its class cost" };
}
/**
 * THE CLEAN START (definitions.cleanStart): the first market day c on or after `fromIdx` with a traded price row and a NAV row that
 * differs from the previous valid NAV row, that is not a bond holiday, not on or within 1 market day of ANY ex-date, and not within 3
 * market days of the ex-date of a distribution of 1% of the price or more; c must be within 5 market days of `fromIdx`.
 *  -> index, or null for NO CLEAN SERIES. Nothing ever moves a start back before `fromIdx`.
 */
function cleanStartIdx(fund, fromIdx, wrong, P = PARAMS) {
  for (let i = fromIdx; i <= fromIdx + P.cleanStartWithinDays && i < fund.cal.days.length; i++) {
    if (!tradedAt(fund, i, wrong)) continue;
    if (!fin(fund.N[i]) || fund.N[i] <= 0) continue;
    const p = fund.prevNavIdx[i]; if (!(p >= 0 && fund.N[i] !== fund.N[p])) continue;
    if (isBondHoliday(fund.cal.at(i))) continue;
    if (!exDateClear(fund, i, P)) continue;
    return i;
  }
  return null;
}
/** the ex-date margins the clean start and the clean end share */
function exDateClear(fund, i, P = PARAMS) {
  const px = fin(fund.P[i]) ? fund.P[i] : null;
  for (const x of fund.dists) {
    if (Math.abs(x.i - i) <= P.exDateAnyDays) return false;                                                  // any ex-date, 1 market day
    if (px != null && x.amount >= (P.exDateBigPct / 100) * px && Math.abs(x.i - i) <= P.exDateBigDays) return false;
  }
  return true;
}
/**
 * THE CLEAN END (definitions.cleanEnd): the exit day, moved BACK when needed to the last market day before it that has both rows, is
 * not the third or later row of an identical NAV run, is not a bond holiday and is clear of ex-dates by the clean start's margins.
 */
function cleanEndIdx(fund, exitIdx, wrong, P = PARAMS) {
  for (let i = exitIdx; i >= 0; i--) {
    if (!tradedAt(fund, i, wrong)) continue;
    if (!fin(fund.N[i]) || fund.N[i] <= 0) continue;
    if (fund.navRun[i] >= P.staleRunRow) continue;
    if (isBondHoliday(fund.cal.at(i))) continue;
    if (!exDateClear(fund, i, P)) continue;
    return i;
  }
  return null;
}
/** a month-end inside a holding (definitions.monthEnds): moved back to the last market day with both rows, a fresh NAV and no bond holiday */
function monthEndIdx(fund, atIdx, wrong, P = PARAMS) {
  for (let i = atIdx; i >= 0; i--) {
    if (!tradedAt(fund, i, wrong)) continue;
    if (!fin(fund.N[i]) || fund.N[i] <= 0) continue;
    if (fund.navRun[i] >= P.staleRunRow) continue;
    if (isBondHoliday(fund.cal.at(i))) continue;
    return i;
  }
  return null;
}
/** the last market day of a month that the position may be MARKED at (definitions.monthEndMark): the last traded row at or before it */
function priceMarkIdx(fund, atIdx, wrong) { for (let i = atIdx; i >= 0; i--) if (tradedAt(fund, i, wrong)) return i; return null; }
/** the distributions per share with ex-date after a and on or before b (rule [11], definitions.gapDollars) */
function distBetween(fund, aIdx, bIdx) { let s = 0; for (const x of fund.dists) if (x.i > aIdx && x.i <= bIdx) s += x.amount; return s; }

// ─────────────────────────────────────────────── the span, and the months it is read over ─────────────────────────────────────────
/** the span's first and last market day (rule [13]); it refuses a span the calendar cannot cover */
function spanBounds(cal, span) {
  let a = 0; while (a < cal.days.length && cal.days[a] < span.first) a++;
  let b = cal.days.length - 1; while (b >= 0 && cal.days[b] > span.last) b--;
  if (a > b || a >= cal.days.length || b < 0) throw new Error(`the calendar has no market day inside ${span.first}..${span.last}`);
  return [a, b];
}
/** every return month of a span, in order ("a month with no position counts": the statistic's unit) */
function spanMonths(span) {
  const out = []; let y = +span.first.slice(0, 4), m = +span.first.slice(5, 7);
  const ly = +span.last.slice(0, 4), lm = +span.last.slice(5, 7);
  while (y < ly || (y === ly && m <= lm)) { out.push(`${y}-${String(m).padStart(2, "0")}`); m++; if (m > 12) { m = 1; y++; } }
  return out;
}
/** monthKey -> the last calendar index of that month inside the span */
function monthLastIdx(cal, first, last) {
  const m = new Map(); for (let i = first; i <= last; i++) m.set(monthKey(cal.days[i]), i); return m;
}

// ───────────────────────────── rule [8] WHICH SIGNAL IS TAKEN, [9] ENTRY, [10] EXIT: the book itself ────────────────────────────
/**
 * THE BOOK. $100,000, at most 24 positions of $4,000, one purchase a half-month counted by the SIGNAL day, long only, nothing else
 * ends a position. Days are processed in order and, within a day, in this order: the exits scheduled for that close, then the entries
 * due at it, then the signals of that day (whose entry is the NEXT close, so the places are counted from the exits scheduled for it,
 * "as known the evening before").
 *
 * `signals` = null runs the registered rule [7]. A Map(dayIdx -> [{ ticker, z }]) runs a book on GIVEN signal days with the SAME
 * pacing, cap and money — that is what the month-shifted books of L12 and the gate S5 are.
 *  -> { positions, counts, failures }
 */
function runBook({ uni, controls = {}, span, costTable = null, P = PARAMS, signals = null, wrongByTicker = null }) {
  const cal = uni.cal, [first, last] = spanBounds(cal, span);
  const wrong = wrongByTicker || new Map(uni.funds.map((f) => [f.ticker, wrongPrintSet(f)]));
  const lateAll = !!controls.lateReporterAll, lateSet = new Set(controls.lateReporters || []);
  const isLate = (t) => lateAll || lateSet.has(t);
  const open = [], pending = [], positions = [], halfMonths = new Map(), failures = [];
  const counts = { signalDays: 0, signalsTaken: 0, fillFailures: 0, carriedExits: 0, daysOver24: 0, soldAtSpanEnd: 0, noCleanSeries: 0, placesBlocked: 0, halfMonthsUsed: 0 };
  const heldOrPending = (t) => open.some((p) => p.ticker === t) || pending.some((q) => q.ticker === t);
  const hmState = (key) => { if (!halfMonths.has(key)) halfMonths.set(key, { opened: false, pending: false, reopenAfterIdx: -1 }); return halfMonths.get(key); };
  const sell = (p, atIdx, atSpanEnd) => {
    p.exitIdx = atIdx; p.exitPx = p.fund.P[atIdx]; p.soldAtSpanEnd = !!atSpanEnd;
    p.distTotal = distBetween(p.fund, p.eIdx, atIdx);
    p.costExit = (p.costFrac / 2) * (p.shares * p.exitPx);
    p.priceDollars = p.shares * (p.exitPx - p.entryPx) + p.shares * p.distTotal - p.costEntry - p.costExit;
    open.splice(open.indexOf(p), 1);
    if (atSpanEnd) counts.soldAtSpanEnd++;
  };
  for (let i = first; i <= last; i++) {
    // (a) the exits scheduled for this close
    for (const p of [...open]) {
      if (i >= p.targetExitIdx) {
        if (tradedAt(p.fund, i, wrong.get(p.ticker))) { sell(p, i, false); continue; }
        if (i === p.targetExitIdx) counts.carriedExits++;                                   // no traded close: the book may hold 25 until it finds one
      }
      if (i === last && open.includes(p)) { const m = priceMarkIdx(p.fund, i, wrong.get(p.ticker)); if (m != null) sell(p, m, true); else { p.exitIdx = null; sell(p, p.eIdx, true); } }
    }
    if (open.length > P.places) counts.daysOver24++;
    // (b) the entries due at this close
    for (const q of [...pending]) {
      if (i < q.firstEntryIdx) continue;
      const w = wrong.get(q.ticker);
      if (i <= q.lastEntryIdx && tradedAt(q.fund, i, w)) {
        const entryPx = q.fund.P[i], shares = P.stakeUsd / entryPx, cost = roundTripCost(q.fund, costTable, P);
        const p = { ticker: q.ticker, fund: q.fund, halfMonth: q.halfMonth, sIdx: q.sIdx, sDay: cal.at(q.sIdx), z: q.z, candidates: q.candidates, eIdx: i, eDay: cal.at(i),
          targetExitIdx: i + P.holdDays, exitIdx: null, entryPx, shares, costFrac: cost.c, costBasis: cost.basis,
          costEntry: (cost.c / 2) * P.stakeUsd, costExit: 0, late: isLate(q.ticker) };
        p.cleanStartIdx = cleanStartIdx(q.fund, i, w, P);
        p.noCleanSeries = p.cleanStartIdx == null;
        if (p.noCleanSeries) counts.noCleanSeries++;
        open.push(p); positions.push(p); pending.splice(pending.indexOf(q), 1);
        const st = hmState(q.halfMonth); st.pending = false; st.opened = true; counts.halfMonthsUsed++;
        continue;
      }
      if (i >= q.lastEntryIdx) {
        // the failure is known at the last close [9] allows, or at the row that proves a wrong print, whichever is later
        let knownIdx = q.lastEntryIdx;
        for (const e of q.fund.suspect) if (e.undoIdx != null && e.i <= q.lastEntryIdx && e.lastIdx >= q.firstEntryIdx) knownIdx = Math.max(knownIdx, e.undoIdx);
        const st = hmState(q.halfMonth); st.pending = false; st.reopenAfterIdx = Math.max(st.reopenAfterIdx, knownIdx);
        pending.splice(pending.indexOf(q), 1); counts.fillFailures++;
        failures.push({ ticker: q.ticker, sDay: cal.at(q.sIdx), knownOn: cal.at(knownIdx), halfMonth: q.halfMonth });
      }
    }
    // (c) the signals of this day — the entry is the next close (the second for a late reporter)
    const key = halfMonthKey(cal.days[i]), st = hmState(key);
    if (st.opened || st.pending || i <= st.reopenAfterIdx) continue;
    let cands;
    if (signals) cands = (signals.get(i) || []).filter((c) => !heldOrPending(c.ticker)).map((c) => ({ ...c, fund: uni.byTicker.get(c.ticker) })).filter((c) => c.fund);
    else {
      cands = [];
      for (const f of uni.funds) {
        const s = signalAt({ uni, fund: f, sIdx: i, controls, held: heldOrPending, P });
        if (s.signal) cands.push({ ticker: f.ticker, fund: f, z: s.z, medDv: s.medDv });
      }
    }
    if (!cands.length) continue;
    counts.signalDays++;
    // the free place is counted at the ENTRY close: the positions still held after the exits scheduled for it, plus the entries pending
    const firstEntry = (t) => i + (isLate(t) ? 2 : 1);
    const occupied = (e) => open.filter((p) => !(p.targetExitIdx <= e)).length + pending.length;
    cands = cands.filter((c) => occupied(firstEntry(c.ticker)) < P.places);
    if (!cands.length) { counts.placesBlocked++; continue; }
    // ties go to the larger 30-day median dollar volume, then to the ticker in alphabetical order
    cands.sort((a, b) => (a.z - b.z) || ((b.medDv || 0) - (a.medDv || 0)) || (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
    const take = cands[0];
    pending.push({ ticker: take.ticker, fund: take.fund, sIdx: i, z: take.z, halfMonth: key,
      candidates: cands.map((c) => ({ ticker: c.ticker, z: c.z, medDv: c.medDv })),      // the list [8] chose from, kept for the audit
      firstEntryIdx: firstEntry(take.ticker), lastEntryIdx: i + P.entryWithinDays });
    st.pending = true; counts.signalsTaken++;
  }
  // anything still pending at the span's end never became a position; every open position was sold on the last market day
  for (const q of pending) failures.push({ ticker: q.ticker, sDay: cal.at(q.sIdx), knownOn: "span end", halfMonth: q.halfMonth, atSpanEnd: true });
  counts.fillFailures += pending.length;
  for (const p of positions) { const w = wrong.get(p.ticker); p.cleanEndIdx = p.exitIdx == null ? null : cleanEndIdx(p.fund, p.exitIdx, w, P); if (p.cleanEndIdx != null && p.cleanStartIdx != null && p.cleanEndIdx <= p.cleanStartIdx) p.cleanEndIdx = null; }
  return { positions, counts, failures, first, last, wrong };
}

// ───────────────────────────── definitions.gapDollars: what the rule's days added in the gap, month by month ───────────────────────
/**
 * THE ANCHORS of a position's months. a = its CLEAN START if that falls in the month, else the last market day of the month before;
 * b = its CLEAN END if that falls in the month, else the last market day of the month — each month-end moved back by
 * definitions.monthEnds, so that the months still multiply to the whole and nothing is measured against a frozen value.
 *  -> [{ month, aIdx, bIdx }] ; [] for a position with NO CLEAN SERIES.
 */
function gapAnchors(p, { cal, monthLast, wrong, fromIdx = null, P = PARAMS }) {
  const startIdx = fromIdx == null ? p.cleanStartIdx : fromIdx, endIdx = p.cleanEndIdx;
  if (startIdx == null || endIdx == null || endIdx <= startIdx) return [];
  const out = []; let a = startIdx;
  for (const M of spanMonths({ first: cal.days[startIdx], last: cal.days[endIdx] })) {
    let b;
    if (M === monthKey(cal.days[endIdx])) b = endIdx;
    else { const li = monthLast.get(M); if (li == null) continue; b = monthEndIdx(p.fund, li, wrong, P); }
    if (b == null || b <= a || b > endIdx) continue;
    out.push({ month: M, aIdx: a, bIdx: b }); a = b;
  }
  return out;
}
/**
 * GAP DOLLARS over one month's anchors: shares x P[a] x [ (P[b] + Dist) / P[a] - (N[b] + Dist) / N[a] ] — the price return minus the
 * asset-value return over the same days, in dollars. definitions.unverifiedEventInAHolding: a position-month that contains an
 * UNVERIFIED EVENT is computed twice, with the NAV before the event multiplied by its k and not, and the LOWER figure is used.
 */
function gapOfMonth(p, aIdx, bIdx, P = PARAMS) {
  const f = p.fund, Dist = distBetween(f, aIdx, bIdx), Pa = f.P[aIdx], Pb = f.P[bIdx], Na = f.N[aIdx], Nb = f.N[bIdx];
  if (!(fin(Pa) && Pa > 0 && fin(Pb) && Pb > 0 && fin(Na) && Na > 0 && fin(Nb) && Nb > 0)) return { gap: 0, unverified: false, yield: 0 };
  let mul = 1, unverified = false;
  for (const e of unverifiedEvents(f)) if (e.i > aIdx && e.i <= bIdx && fin(e.k) && e.k > 0) { mul *= e.k; unverified = true; }
  const one = (na) => p.shares * Pa * ((Pb + Dist) / Pa - (Nb + Dist) / na);
  const gap = unverified ? Math.min(one(Na), one(Na * mul)) : one(Na);
  return { gap, unverified, yield: p.shares * Dist * (1 - Pa / Na) };
}
/** the price-dollar anchors: e to x, marked at the last traded row of each month (definitions.monthEndMark) */
function priceAnchors(p, { cal, monthLast, wrong }) {
  if (p.exitIdx == null) return [];
  const out = []; let a = p.eIdx;
  for (const M of spanMonths({ first: cal.days[p.eIdx], last: cal.days[p.exitIdx] })) {
    let b;
    if (M === monthKey(cal.days[p.exitIdx])) b = p.exitIdx;
    else { const li = monthLast.get(M); if (li == null) continue; b = priceMarkIdx(p.fund, li, wrong); }
    if (b == null || b <= a || b > p.exitIdx) continue;
    out.push({ month: M, aIdx: a, bIdx: b }); a = b;
  }
  if (!out.length || out[out.length - 1].bIdx !== p.exitIdx) out.push({ month: monthKey(cal.days[p.exitIdx]), aIdx: a, bIdx: p.exitIdx });
  return out;
}

/**
 * ONE BOOK'S MONTHLY SERIES. Every figure of the statistic and of the sign gates, month by month, for a set of positions:
 *   gap    definitions.gapDollars, after NOTHING (cost is added by the caller, so the placebo can be run at no cost)
 *   gap21  the same from the close of the 21st market day after entry (S2)
 *   gapPeer  with the fund's own asset-value return replaced by its cost group's eligible, unheld peers' mean (S4)
 *   price  the position's price dollars (definitions.priceDollarSeries), yield (definitions.priceDollarSeries YIELD)
 *   cost   the fills' cost: half in the month of each fill (the entry half in the month the measurement starts, for cost21)
 *  -> { gap, gap21, gapPeer, price, yieldS, cost, cost21, counts } each a Map(month -> dollars)
 */
function monthlyOf({ positions, uni, span, wrong, controls = {}, peer = null, P = PARAMS, withCost = true }) {
  const cal = uni.cal, [first, last] = spanBounds(cal, span), monthLast = monthLastIdx(cal, first, last);
  const z = () => new Map(), add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
  const out = { gap: z(), gap21: z(), gapPeer: z(), price: z(), yieldS: z(), cost: z(), cost21: z(),
    counts: { unverifiedMonths: 0, peerMissing: 0, noClean21: 0, positions: positions.length, noCleanSeries: 0 } };
  for (const p of positions) {
    const w = wrong.get(p.ticker);
    if (p.noCleanSeries || p.cleanEndIdx == null) out.counts.noCleanSeries++;
    for (const a of gapAnchors(p, { cal, monthLast, wrong: w, P })) {
      const g = gapOfMonth(p, a.aIdx, a.bIdx, P);
      add(out.gap, a.month, g.gap); add(out.yieldS, a.month, g.yield);
      if (g.unverified) out.counts.unverifiedMonths++;
      if (peer) {
        const pr = peer(p, a.aIdx, a.bIdx);
        if (pr == null) out.counts.peerMissing++;
        else {
          const f = p.fund, Dist = distBetween(f, a.aIdx, a.bIdx);
          add(out.gapPeer, a.month, p.shares * f.P[a.aIdx] * ((f.P[a.bIdx] + Dist) / f.P[a.aIdx] - pr));
        }
      }
    }
    // S2: the same, measured only from the close of the 21st market day after entry
    const from21 = cleanStartIdx(p.fund, p.eIdx + P.skipDays, w, P);
    if (from21 == null) out.counts.noClean21++;
    const an21 = from21 == null ? [] : gapAnchors(p, { cal, monthLast, wrong: w, fromIdx: from21, P });
    for (const a of an21) add(out.gap21, a.month, gapOfMonth(p, a.aIdx, a.bIdx, P).gap);
    for (const a of priceAnchors(p, { cal, monthLast, wrong: w })) {
      const f = p.fund, Dist = distBetween(f, a.aIdx, a.bIdx);
      if (fin(f.P[a.aIdx]) && fin(f.P[a.bIdx])) add(out.price, a.month, p.shares * (f.P[a.bIdx] - f.P[a.aIdx]) + p.shares * Dist);
    }
    if (withCost) {
      add(out.cost, monthKey(cal.days[p.eIdx]), p.costEntry);
      add(out.cost21, monthKey(cal.days[from21 == null ? p.eIdx : from21]), p.costEntry);
      if (p.exitIdx != null) { add(out.cost, monthKey(cal.days[p.exitIdx]), p.costExit); add(out.cost21, monthKey(cal.days[p.exitIdx]), p.costExit); }
    }
  }
  return out;
}
/**
 * S4's PEER YARDSTICK: the equal-weight mean asset-value return, over the same days, of the eligible funds of the position's cost
 * group that have no open real position (at least 3 of them, else the position-month is left out and counted).
 */
function makePeer({ uni, realPositions, controls = {}, P = PARAMS }) {
  const openByFund = new Map();
  for (const p of realPositions) { if (!openByFund.has(p.ticker)) openByFund.set(p.ticker, []); openByFund.get(p.ticker).push([p.eIdx, p.exitIdx == null ? p.eIdx : p.exitIdx]); }
  const elig = new Map();
  const eligAt = (f, i) => { const k = `${f.ticker}|${i}`; if (!elig.has(k)) elig.set(k, eligible({ uni, fund: f, sIdx: i, controls, P }).ok); return elig.get(k); };
  const holds = (t, a, b) => (openByFund.get(t) || []).some(([x, y]) => x <= b && y >= a);
  return (p, aIdx, bIdx) => {
    const rets = [];
    for (const f of uni.funds) {
      if (f.ticker === p.ticker || f.group !== p.fund.group) continue;
      if (holds(f.ticker, aIdx, bIdx)) continue;
      if (!(fin(f.N[aIdx]) && f.N[aIdx] > 0 && fin(f.N[bIdx]) && f.N[bIdx] > 0)) continue;
      if (!eligAt(f, bIdx)) continue;
      rets.push(f.N[bIdx] / f.N[aIdx]);
    }
    return rets.length >= P.peerMin ? mean(rets) : null;
  };
}

// ───────────────────────────────────────── definitions.placebo: the same funds, days picked by chance ──────────────────────────────
/** the days of a span on which a fund is eligible under [6] and d[t] < 0 — the signal's own conditions with the two z tests taken out */
function placeboDaysOf({ uni, fund, span, controls = {}, P = PARAMS }) {
  const [first, last] = spanBounds(uni.cal, span), out = [];
  for (let i = first; i <= last; i++) if (placeboDayOk({ uni, fund, sIdx: i, controls, P })) out.push(i);
  return out;
}
/**
 * ONE PLACEBO DRAW. For each real position of a fund f, one day t drawn evenly from f's placebo days of the span; the same entry rule
 * [9], exit rule [10], $4,000, clean start, clean end and month-ends, NO cost. Within a draw a fund's placebo positions never overlap
 * (redraw up to 200 times; else the slot is dropped in that draw and counted). It shares neither the half-month pacing nor the places.
 */
function placeboDraw({ uni, realPositions, span, days, drawNo, spanNo, controls = {}, wrong, P = PARAMS }) {
  const rng = mulberry32(P.placeboSeed + 1000 * spanNo + drawNo), cal = uni.cal, [first, last] = spanBounds(cal, span);
  const taken = new Map(), out = []; let dropped = 0;
  for (const rp of realPositions) {
    const pool = days.get(rp.ticker) || [];
    if (!pool.length) { dropped++; continue; }
    const mine = taken.get(rp.ticker) || [];
    let got = null;
    for (let tryNo = 0; tryNo < 200 && got == null; tryNo++) {
      const t = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
      const w = wrong.get(rp.ticker);
      let e = null;
      for (let i = t + (rp.late ? 2 : 1); i <= t + P.entryWithinDays && i <= last; i++) if (tradedAt(rp.fund, i, w)) { e = i; break; }
      if (e == null) continue;                                                                        // no fill: this draw tries another day
      const target = e + P.holdDays; let x = null;
      for (let i = target; i <= last; i++) if (tradedAt(rp.fund, i, w)) { x = i; break; }
      if (x == null) { const m = priceMarkIdx(rp.fund, last, w); if (m == null || m <= e) continue; x = m; }
      if (mine.some(([a, b]) => a <= x && b >= e)) continue;                                          // no overlap inside a draw
      const entryPx = rp.fund.P[e];
      const p = { ticker: rp.ticker, fund: rp.fund, sIdx: t, eIdx: e, exitIdx: x, entryPx, exitPx: rp.fund.P[x], shares: P.stakeUsd / entryPx,
        costFrac: 0, costEntry: 0, costExit: 0, late: rp.late, soldAtSpanEnd: x !== target };
      p.cleanStartIdx = cleanStartIdx(rp.fund, e, w, P); p.noCleanSeries = p.cleanStartIdx == null;
      p.cleanEndIdx = cleanEndIdx(rp.fund, x, w, P); if (p.cleanEndIdx != null && p.cleanStartIdx != null && p.cleanEndIdx <= p.cleanStartIdx) p.cleanEndIdx = null;
      p.distTotal = distBetween(rp.fund, e, x);
      p.priceDollars = p.shares * (p.exitPx - entryPx) + p.shares * p.distTotal;
      got = p; mine.push([e, x]); taken.set(rp.ticker, mine);
    }
    if (got) out.push(got); else dropped++;
  }
  return { positions: out, dropped };
}

// ───────────────────────────────────────────────────────── the statistic itself ─────────────────────────────────────────────────────
/**
 * THE STATISTIC (entry.statistic). Clustered by calendar month — one number per month, never per trade and never per fund:
 *   G(M) = [ the real positions' gap dollars in M, minus the costs of the real fills in M ] - [ the placebo's gap dollars in M, at NO
 *   cost, averaged over 500 seeded draws ].  HEADLINE = the mean of G over ALL the span's return months, with its Newey-West t
 *   (Bartlett, lag 4). Beside it: D (all price dollars after costs against the no-cost placebo), BOOK (the real book's price dollars
 *   after costs alone), YIELD, G21 (S2), GUS (S3), GPEER (S4).
 * `draws` lets a made world run the 100 draws V10 prescribes instead of the real read's 500.
 */
function statistic({ uni, span, spanNo, controls = {}, costTable = null, P = PARAMS, draws = null, book = null, keepDraws = 20, onProgress = null }) {
  const cal = uni.cal, months = spanMonths(span), nDraws = draws == null ? P.placeboDraws : draws;
  const B = book || runBook({ uni, controls, span, costTable, P });
  const wrong = B.wrong, real = B.positions;
  const peer = makePeer({ uni, realPositions: real, controls, P });
  const realM = monthlyOf({ positions: real, uni, span, wrong, controls, peer, P, withCost: true });
  const days = new Map(); for (const f of uni.funds) days.set(f.ticker, placeboDaysOf({ uni, fund: f, span, controls, P }));
  const sum = { gap: new Map(), gap21: new Map(), gapPeer: new Map(), price: new Map() };
  const sumUS = { gap: new Map() }, keep = [];
  let droppedSlots = 0, peerMissing = 0;
  const usReal = real.filter((p) => !p.fund.foreignClock);
  const realUS = monthlyOf({ positions: usReal, uni, span, wrong, controls, P, withCost: true });
  for (let dNo = 1; dNo <= nDraws; dNo++) {
    const d = placeboDraw({ uni, realPositions: real, span, days, drawNo: dNo, spanNo, controls, wrong, P });
    droppedSlots += d.dropped;
    const m = monthlyOf({ positions: d.positions, uni, span, wrong, controls, peer, P, withCost: false });
    peerMissing += m.counts.peerMissing;
    for (const k of ["gap", "gap21", "gapPeer", "price"]) for (const M of months) sum[k].set(M, (sum[k].get(M) || 0) + (m[k].get(M) || 0));
    const mUS = monthlyOf({ positions: d.positions.filter((p) => !p.fund.foreignClock), uni, span, wrong, controls, P, withCost: false });
    for (const M of months) sumUS.gap.set(M, (sumUS.gap.get(M) || 0) + (mUS.gap.get(M) || 0));
    if (keep.length < keepDraws) keep.push(months.map((M) => m.gap.get(M) || 0));
    if (onProgress) onProgress(dNo, nDraws);
  }
  const pm = (k, M) => (nDraws ? (sum[k].get(M) || 0) / nDraws : 0);
  const series = {
    G: months.map((M) => (realM.gap.get(M) || 0) - (realM.cost.get(M) || 0) - pm("gap", M)),
    G21: months.map((M) => (realM.gap21.get(M) || 0) - (realM.cost21.get(M) || 0) - pm("gap21", M)),
    GPEER: months.map((M) => (realM.gapPeer.get(M) || 0) - (realM.cost.get(M) || 0) - pm("gapPeer", M)),
    GUS: months.map((M) => (realUS.gap.get(M) || 0) - (realUS.cost.get(M) || 0) - (nDraws ? (sumUS.gap.get(M) || 0) / nDraws : 0)),
    D: months.map((M) => (realM.price.get(M) || 0) - (realM.cost.get(M) || 0) - pm("price", M)),
    BOOK: months.map((M) => (realM.price.get(M) || 0) - (realM.cost.get(M) || 0)),
    YIELD: months.map((M) => realM.yieldS.get(M) || 0),
    GAP_RAW: months.map((M) => realM.gap.get(M) || 0),
    COST: months.map((M) => realM.cost.get(M) || 0),
    PLACEBO_GAP: months.map((M) => pm("gap", M)),
  };
  const roundTrips = real.filter((p) => p.exitIdx != null).length;
  // a month HAS A POSITION when a real position was open on any of its market days (V13's count)
  const monthsWithPosition = months.filter((M) => real.some((p) => {
    const a = monthKey(cal.days[p.eIdx]), b = monthKey(cal.days[p.exitIdx == null ? p.eIdx : p.exitIdx]);
    return a <= M && M <= b;
  })).length;
  return {
    span, spanNo, months, series, positions: real, counts: { ...B.counts, roundTrips, monthsWithPosition, placeboDroppedSlots: droppedSlots, placeboPeerMissing: peerMissing, unverifiedMonths: realM.counts.unverifiedMonths, peerMissing: realM.counts.peerMissing, noCleanSeries: realM.counts.noCleanSeries, draws: nDraws },
    headline: mean(series.G), t: nwT(series.G, P.neweyWestLag), keptDraws: keep, failures: B.failures, book: B,
  };
}
/** the month-shifted books of L12 / S5: the real signal calendar moved by k whole months, wrapping inside the span */
function shiftedBook({ uni, span, realPositions, k, controls = {}, costTable = null, wrong, P = PARAMS }) {
  const cal = uni.cal, [first, last] = spanBounds(cal, span), months = spanMonths(span), signals = new Map();
  const shiftMonth = (M, by) => { let y = +M.slice(0, 4), m = +M.slice(5, 7) - 1 + by; y += Math.floor(m / 12); m = ((m % 12) + 12) % 12; return `${y}-${String(m + 1).padStart(2, "0")}`; };
  for (const p of realPositions) {
    const sDay = cal.days[p.sIdx], dom = sDay.slice(8, 10);
    let M = shiftMonth(monthKey(sDay), k);
    if (!months.includes(M)) M = months[(months.indexOf(monthKey(sDay)) + k) % months.length];       // wrapping inside the span
    // the first market day of that month on or after the same day of the month, then the next day of its half-month meeting the placebo's conditions
    let start = -1; for (let i = first; i <= last; i++) if (monthKey(cal.days[i]) === M && cal.days[i].slice(8, 10) >= dom) { start = i; break; }
    if (start < 0) { for (let i = last; i >= first; i--) if (monthKey(cal.days[i]) === M) { start = i; break; } }
    if (start < 0) continue;
    const want = halfMonthKey(cal.days[start]);
    let pick = -1;
    for (let i = start; i <= last && halfMonthKey(cal.days[i]) === want; i++) if (placeboDayOk({ uni, fund: p.fund, sIdx: i, controls, P })) { pick = i; break; }
    if (pick < 0) continue;                                                                           // dropped with its placebo slots
    if (!signals.has(pick)) signals.set(pick, []);
    signals.get(pick).push({ ticker: p.ticker, z: p.z, medDv: 0 });
  }
  return runBook({ uni, controls, span, costTable, P, signals, wrongByTicker: wrong });
}
/**
 * S5 / L12: the mean G per position opened of the real book against the 500 month-shifted books. Each shifted book is measured against
 * the SAME placebo mean as the real book (the yardstick is the funds held from random days; the shift moves the rule's calendar, not
 * the yardstick) — the reading is written down in the package's NOTES.md.
 */
function shiftedBooks({ uni, span, spanNo, stat, controls = {}, costTable = null, P = PARAMS, n = null }) {
  const N = n == null ? P.shiftedBooks : n, months = stat.months, rng = mulberry32(P.shiftSeed + spanNo);
  const wrong = stat.book.wrong, out = [];
  for (let i = 0; i < N; i++) {
    const k = 1 + Math.floor(rng() * (months.length - 1));
    const B = shiftedBook({ uni, span, realPositions: stat.positions, k, controls, costTable, wrong, P });
    const m = monthlyOf({ positions: B.positions, uni, span, wrong, controls, P, withCost: true });
    const G = months.map((M, j) => (m.gap.get(M) || 0) - (m.cost.get(M) || 0) - stat.series.PLACEBO_GAP[j]);
    const opened = B.positions.length;
    out.push({ k, opened, meanG: mean(G), perPosition: opened ? mean(G) / opened : null, t: nwT(G, P.neweyWestLag) });
  }
  const per = out.map((x) => x.perPosition).filter(fin);
  const realPer = stat.positions.length ? mean(stat.series.G) / stat.positions.length : null;
  const sorted = [...per].sort((a, b) => a - b);
  return { books: out, median: median(per), realPerPosition: realPer, pass: realPer != null && per.length > 0 && realPer > median(per),
    percentile: realPer == null || !sorted.length ? null : sorted.filter((x) => x < realPer).length / sorted.length };
}

// ──────────────────────────────────────────── the bar, and the bar in force at the read ─────────────────────────────────────────────
/**
 * bar.raisedInTheRead: the bar in force is the LARGEST of tRequired (1.727), the V10 worlds' 95th percentile and the 95th percentile of
 * the same Newey-West t over 20000 seeded resamples of that read's own months of G, drawn with replacement in BLOCKS OF 13 MONTHS
 * after their mean is subtracted. It can only raise the bar.
 */
function blockBootstrapP95({ G, spanNo, P = PARAMS }) {
  const n = G.length; if (n < P.bootstrapBlockMonths + 1) return null;
  const m = mean(G), c = G.map((x) => x - m), rng = mulberry32(P.bootstrapSeed + spanNo), L = P.bootstrapBlockMonths, ts = [];
  for (let trial = 0; trial < P.bootstrapTrials; trial++) {
    const s = new Array(n);
    for (let i = 0; i < n; i += L) { const start = Math.floor(rng() * n); for (let j = 0; j < L && i + j < n; j++) s[i + j] = c[(start + j) % n]; }
    const t = nwT(s, P.neweyWestLag); if (t != null) ts.push(t);
  }
  return pct(ts, 0.95);
}
/** the bar in force: the largest of the registered bar, the block-resampled 95th percentile and the V10 worlds' 95th percentile */
function barInForce({ registered = PARAMS.tRequired, bootstrapP95 = null, worldsP95 = null }) {
  const parts = [{ what: "the registered bar (bar.tRequired)", t: registered }];
  if (fin(bootstrapP95)) parts.push({ what: "the 95th percentile of 20000 block resamples of this read's own months", t: bootstrapP95 });
  if (fin(worldsP95)) parts.push({ what: "the 95th percentile of the deciding t over the V10 no-edge worlds", t: worldsP95 });
  const t = Math.max(...parts.map((x) => x.t));
  return { t, parts, binding: parts.find((x) => x.t === t).what };
}

// ───────────────────────────────────────── the sign gates S1-S5 and the labels L1-L12 ──────────────────────────────────────────────
/** S1-S4: each is the mean over the span's months and must be ABOVE $0. S5 is the rank gate against the month-shifted books. */
function signGates({ stat, shifted = null }) {
  const g = (k) => mean(stat.series[k]);
  return {
    S1: { what: "MONEY: all price dollars after costs against the no-cost placebo (D)", mean: g("D"), pass: g("D") > 0 },
    S2: { what: "AFTER THE FIRST MONTH: G measured from the 21st market day after entry (G21)", mean: g("G21"), pass: g("G21") > 0 },
    S3: { what: "US CLOCK: G without the funds priced on a foreign clock (GUS)", mean: g("GUS"), pass: g("GUS") > 0 },
    S4: { what: "WITHOUT THE FUND'S OWN ASSET VALUE: G against the cost group's peers (GPEER)", mean: g("GPEER"), pass: g("GPEER") > 0 },
    S5: { what: "CALENDAR: mean G per position opened above the median of the 500 month-shifted books", mean: shifted ? shifted.realPerPosition : null,
      median: shifted ? shifted.median : null, pass: shifted ? !!shifted.pass : false, ran: !!shifted },
  };
}
/**
 * THE LABELS. Printed with every read; none can change the verdict. Each returns its own numbers, or a line saying which input it
 * needs and has not got (a label that cannot be computed is never silently treated as absent evidence).
 */
function labels({ uni, span, spanNo, stat, shifted, controls = {}, costTable = null, extras = {}, P = PARAMS }) {
  const months = stat.months, out = {};
  // L1 WHICH FUND (the level twin): for each real position, the other funds of the same cost group, eligible, |z| <= 1, discount within
  // 0.02 of f's and no open real position, entered and sold at the same closes; the monthly series of the position's gap dollars minus
  // the mean of its controls', before cost.
  {
    const wrong = stat.book.wrong, cal = uni.cal, [first, last] = spanBounds(cal, span), monthLast = monthLastIdx(cal, first, last);
    const openByFund = new Map(); for (const p of stat.positions) { if (!openByFund.has(p.ticker)) openByFund.set(p.ticker, []); openByFund.get(p.ticker).push([p.eIdx, p.exitIdx ?? p.eIdx]); }
    const holds = (t, a, b) => (openByFund.get(t) || []).some(([x, y]) => x <= b && y >= a);
    const diff = new Map(); let matched = 0, gapOfMatched = 0, gapAll = 0;
    for (const p of stat.positions) {
      const s = p.sIdx, mine = [];
      for (const f of uni.funds) {
        if (f.ticker === p.ticker || f.group !== p.fund.group) continue;
        const e = eligible({ uni, fund: f, sIdx: s, controls, P });
        if (!e.ok || e.z == null || Math.abs(e.z) > P.twinZ) continue;
        if (!(fin(f.d[s]) && fin(p.fund.d[s]) && Math.abs(f.d[s] - p.fund.d[s]) <= P.twinCaliper)) continue;
        if (holds(f.ticker, p.eIdx, p.exitIdx ?? p.eIdx)) continue;
        if (!tradedAt(f, p.eIdx, wrong.get(f.ticker)) || p.exitIdx == null || !tradedAt(f, p.exitIdx, wrong.get(f.ticker))) continue;
        mine.push(f);
      }
      const mineAnchors = gapAnchors(p, { cal, monthLast, wrong: wrong.get(p.ticker), P });
      const own = new Map(); for (const a of mineAnchors) own.set(a.month, gapOfMonth(p, a.aIdx, a.bIdx, P).gap);
      for (const v of own.values()) gapAll += v;
      if (!mine.length) continue;
      matched++; for (const v of own.values()) gapOfMatched += v;
      for (const [M, v] of own) {
        const ctrl = [];
        for (const f of mine) {
          const q = { ...p, fund: f, shares: P.stakeUsd / f.P[p.eIdx] };
          const a = mineAnchors.find((x) => x.month === M);
          ctrl.push(gapOfMonth(q, a.aIdx, a.bIdx, P).gap);
        }
        diff.set(M, (diff.get(M) || 0) + v - mean(ctrl));
      }
    }
    const series = months.map((M) => diff.get(M) || 0);
    out.L1 = { matchedShare: stat.positions.length ? matched / stat.positions.length : null, mean: mean(series), t: nwT(series, P.neweyWestLag),
      shareOfGapFromMatched: gapAll !== 0 ? gapOfMatched / gapAll : null, cannotSeparate: stat.positions.length ? matched / stat.positions.length < P.twinMinMatched : true };
  }
  out.L2 = { what: "FIRST MONTH", t21: nwT(stat.series.G21, P.neweyWestLag), mean21: mean(stat.series.G21),
    firstMonthDollars: mean(stat.series.G) - mean(stat.series.G21) };
  out.L3 = { what: "COST", atTwice: null, atThrice: null };
  {
    // G and its t at twice and at three times the charged cost: the extra cost comes off the real book only (the placebo pays none)
    const extra = (mult) => months.map((M, i) => stat.series.G[i] - (mult - 1) * stat.series.COST[i]);
    out.L3.atTwice = { mean: mean(extra(2)), t: nwT(extra(2), P.neweyWestLag) };
    out.L3.atThrice = { mean: mean(extra(3)), t: nwT(extra(3), P.neweyWestLag) };
  }
  out.L4 = { what: "LAG", t0: nwT(stat.series.G, 0), t12: nwT(stat.series.G, 12) };
  out.L5 = extras.L5 || { what: "WITH THE SEEN EPISODES", note: "run with --controls --seen-episodes on the same cache; weightless" };
  out.L6 = extras.L6 || { what: "MIRROR", note: "the first 21 days after a rich reading (z above +2 for two days), sign reversed" };
  out.L7 = extras.L7 || { what: "AFTER A CUT", note: "signals within 63 market days after a regular distribution at least 10% below the one before it" };
  out.L8 = extras.L8 || { what: "THE OPERATOR'S EXIT", note: "the same entries sold the close after d[t] reaches the signal day's lookback mean, 252-day cap" };
  out.L9 = extras.L9 || { what: "SAME BET AS THE ETF DIP-BUY?", note: "R313's monthly net series is not in this tree: the correlation is printed at home" };
  out.L10 = { what: "SURVIVORSHIP TABLE", iciYearEnd: { 2007: 659, 2011: 628, 2019: 494, 2023: 401, 2024: 382 }, note: "straight-line between the years on file, marked approximate", ...(extras.L10 || {}) };
  out.L11 = extras.L11 || { what: "REGIMES AND BAD DAYS", note: "SPY is not in the cache: the regime split is printed at home" };
  out.L12 = { what: "SHAPE", shiftedPercentile: shifted ? shifted.percentile : null, byMonthSinceEntry: null, byCostGroup: null, best5pctShare: null };
  {
    const byGroup = {}; for (const p of stat.positions) byGroup[p.fund.group] = (byGroup[p.fund.group] || 0) + 1;
    out.L12.byCostGroup = byGroup;
    const g = [...stat.series.G].sort((a, b) => b - a), top = Math.max(1, Math.round(0.05 * g.length));
    const total = stat.series.G.reduce((s, x) => s + x, 0);
    out.L12.best5pctShare = total !== 0 ? g.slice(0, top).reduce((s, x) => s + x, 0) / total : null;
    const byM = {}; for (const p of stat.positions) { const n = p.exitIdx == null ? 0 : Math.min(12, Math.ceil((p.exitIdx - p.eIdx) / 21)); byM[n] = (byM[n] || 0) + 1; }
    out.L12.byMonthSinceEntry = byM;
  }
  return out;
}

// ──────────────────────────────────────────────────────── the made worlds (V10-V12) ────────────────────────────────────────────────
/**
 * A NO-EDGE WORLD (V10). For each market day ONE sign, +1 or -1 with equal chance (seeded), is drawn once and applied to every fund's
 * change in ln(P/N) on that day; nothing is shuffled; each path starts at the fund's real first value and is not pinned at its last; a
 * row that wanders outside the band of [5] is invalid, as in the real data (no reflecting wall); the NAV, the distributions and the
 * events are kept and the PRICE is rebuilt.
 *  -> a cache the universe can be prepared from again (the same shapes prepareUniverse takes).
 */
function noEdgeWorld({ cache, universe, seed, span = null, P = PARAMS }) {
  const rng = mulberry32(seed), cal = makeCalendar(cache["^GSPC"]);
  const sign = new Int8Array(cal.days.length); for (let i = 0; i < cal.days.length; i++) sign[i] = rng() < 0.5 ? -1 : 1;
  const out = { "^GSPC": cache["^GSPC"] };
  for (const row of universe) {
    const price = cache[row.ticker], nav = cache[row.navSymbol];
    if (!price || !nav) continue;
    out[row.navSymbol] = nav;
    const navAt = new Map((nav.rows || []).map((r) => [r.d, r.c]));
    const rows = [], byDate = new Map((price.rows || []).map((r) => [r.d, r]));
    let lastRatio = null, lastD = null;
    for (const r of price.rows || []) {
      const n = navAt.get(r.d);
      if (!(fin(r.c) && r.c > 0 && fin(n) && n > 0)) { rows.push({ ...r }); continue; }
      if (lastRatio == null) { lastRatio = r.c / n; rows.push({ ...r }); lastD = r.d; continue; }
      const nPrev = navAt.get(lastD), pPrev = byDate.get(lastD);
      const dln = fin(nPrev) && nPrev > 0 && pPrev && fin(pPrev.c) && pPrev.c > 0 ? Math.log(r.c / n) - Math.log(pPrev.c / nPrev) : 0;
      lastRatio = lastRatio * Math.exp(sign[cal.of(r.d) >= 0 ? cal.of(r.d) : 0] * dln);
      rows.push({ ...r, c: lastRatio * n }); lastD = r.d;
    }
    out[row.ticker] = { ...price, rows };
  }
  return out;
}
/**
 * A FAULT WORLD (V11): a no-edge world with faults put back by seed and no edge — (i) on 1.9% of fund-days the NAV is held at the
 * previous value for one to three further rows; (ii) for municipal, loan and foreign-clock funds, on days the price moves more than 2%
 * the NAV's own move is spread over the next three rows; (iii) 30 NAV prints per span 1.15 to 1.29 times the true value for one or two
 * rows; (iv) for 2% of distributions the NAV falls one market day after the price; (v) half the class one-way cost of bounce, with a
 * random sign, on every close.
 */
function faultWorld({ cache, universe, seed, P = PARAMS }) {
  const world = noEdgeWorld({ cache, universe, seed, P }), rng = mulberry32(seed ^ 0x5eed);
  const slowGroups = new Set(["MUNI", "TAXABLE_BOND"]);
  for (const row of universe) {
    const nav = world[row.navSymbol], price = world[row.ticker];
    if (!nav || !price) continue;
    const rows = (nav.rows || []).map((r) => ({ ...r })), group = costGroupOf(row.categoryName, P);
    for (let i = 1; i < rows.length; i++) {
      if (rng() < 0.019) { const hold = 1 + Math.floor(rng() * 3); for (let j = 0; j < hold && i + j < rows.length; j++) { rows[i + j].c = rows[i - 1].c; rows[i + j].o = rows[i + j].h = rows[i + j].l = rows[i - 1].c; } i += hold; continue; }
      if ((slowGroups.has(group) || P.foreignClockClasses.includes(String(row.categoryName || "").replace(/^Morningstar US CEF /, ""))) && i < rows.length - 3) {
        const p1 = price.rows[i] && price.rows[i].c, p0 = price.rows[i - 1] && price.rows[i - 1].c;
        if (fin(p1) && fin(p0) && p0 > 0 && Math.abs(p1 / p0 - 1) > 0.02) {
          const move = rows[i].c - rows[i - 1].c; rows[i].c = rows[i - 1].c + move / 3;
          for (let j = 1; j <= 2 && i + j < rows.length; j++) rows[i + j].c = rows[i + j].c - (move * (2 - j + 1)) / 3;
        }
      }
    }
    for (let k = 0; k < 30; k++) { const i = 1 + Math.floor(rng() * Math.max(1, rows.length - 3)), spike = 1.15 + rng() * 0.14, rowsOut = 1 + Math.floor(rng() * 2); for (let j = 0; j < rowsOut && i + j < rows.length; j++) rows[i + j].c *= spike; }
    for (const r of rows) { r.o = r.h = r.l = r.c; }
    world[row.navSymbol] = { ...nav, rows };
    const half = (P.classCostPct[group] / 100) / 2, pr = (price.rows || []).map((r) => ({ ...r, c: fin(r.c) ? r.c * (1 + (rng() < 0.5 ? -1 : 1) * half) : r.c }));
    world[row.ticker] = { ...price, rows: pr };
  }
  return world;
}
/**
 * A PLANTED WORLD (V12(a)): the no-edge world plus the published speed — each day each fund's gap is pulled toward its trailing
 * 252-day mean by 1 - 0.5^(1/162) of the distance (a half-life of 7.7 months).
 */
function plantedWorld({ cache, universe, seed, P = PARAMS }) {
  const world = noEdgeWorld({ cache, universe, seed, P }), pull = 1 - Math.pow(0.5, 1 / P.halfLifeDays);
  for (const row of universe) {
    const price = world[row.ticker], nav = world[row.navSymbol];
    if (!price || !nav) continue;
    const navAt = new Map((nav.rows || []).map((r) => [r.d, r.c])), rows = (price.rows || []).map((r) => ({ ...r })), hist = [];
    for (let i = 0; i < rows.length; i++) {
      const n = navAt.get(rows[i].d);
      if (!(fin(rows[i].c) && rows[i].c > 0 && fin(n) && n > 0)) continue;
      const d = rows[i].c / n - 1; hist.push(d);
      if (hist.length > P.lookbackDays) hist.shift();
      if (hist.length >= P.windowMinRows) { const m = mean(hist), target = d + pull * (m - d); rows[i].c = (1 + target) * n; }
    }
    world[row.ticker] = { ...price, rows };
  }
  return world;
}

// ────────────────────────────────────────────────────── the validity gates V1-V16 ──────────────────────────────────────────────────
/**
 * THE VALIDITY GATES. Each runs BEFORE the read it guards; a failure is CANNOT MEASURE for that span, recorded, never amended so that
 * it passes. Each prints counts, dates, lists and pass or fail — never a mean return of the real book.
 * EVERY GATE IS FAIL-CLOSED: a gate whose input is not in the tree FAILS (it does not pass quietly). V6, V7, V8 and V9 need a recording
 * or a second source the runner cannot make up; without them a read refuses, which is what readCondition (5) asks for.
 */
function gateV2({ uni, span, controls = {}, pairs = null, rng = null, P = PARAMS, cache = null, universe = null }) {
  // AS-OF REPLAY on the real series: the signal, z and eligibility computed from the series CUT OFF at that day equal those computed
  // as-of on the full series. The dividend and split lists are kept (announced in advance; a ratio is unit conversion only, timing[]),
  // and the unit resolution of events dated after the day is carried over — everything that could carry a LEVEL from the future is cut.
  if (!cache || !universe) return { id: "V2", pass: false, why: "the cache itself is needed for the as-of replay and was not handed in", pairsChecked: 0 };
  const want = pairs == null ? P.replayPairs : pairs, r = rng || mulberry32(777), [first, last] = spanBounds(uni.cal, span);
  const byTicker = new Map(universe.map((u) => [u.ticker, u]));
  let checked = 0, mismatches = [];
  for (let n = 0; n < want * 4 && checked < want; n++) {
    const f = uni.funds[Math.floor(r() * uni.funds.length)];
    const sIdx = first + Math.floor(r() * (last - first + 1));
    const row = byTicker.get(f.ticker); if (!row) continue;
    const day = uni.cal.days[sIdx];
    const cut = (s) => ({ ...s, rows: (s.rows || []).filter((x) => x.d <= day) });
    let tf;
    try { tf = prepareFund({ cal: uni.cal, row, price: cut(cache[f.ticker]), nav: cut(cache[row.navSymbol]), P, navMulOverride: f.navMul }); } catch { continue; }
    const a = eligible({ uni, fund: f, sIdx, controls, P }), b = eligible({ uni, fund: tf, sIdx, controls, P });
    const sa = signalAt({ uni, fund: f, sIdx, controls, P }), sb = signalAt({ uni, fund: tf, sIdx, controls, P });
    checked++;
    const same = a.ok === b.ok && a.why.join(",") === b.why.join(",") && String(r3(a.z)) === String(r3(b.z)) && sa.signal === sb.signal;
    if (!same) mismatches.push({ ticker: f.ticker, day, full: { ok: a.ok, why: a.why, z: r3(a.z), signal: sa.signal }, cut: { ok: b.ok, why: b.why, z: r3(b.z), signal: sb.signal } });
  }
  return { id: "V2", pass: mismatches.length === 0 && checked >= Math.min(want, 1), pairsChecked: checked, mismatches: mismatches.length, examples: mismatches.slice(0, 3),
    why: mismatches.length ? `${mismatches.length} of ${checked} sampled (fund, day) pairs differ between the cut-off series and the as-of computation` : checked < want ? `only ${checked} of ${want} pairs could be sampled` : null };
}
function gateV3({ uni, P = PARAMS }) {
  // DATA SCREENS: every split event classified; the unverified events listed with their size; the funds removed for a LATER event;
  // the funds more than 1% of rows outside the band; the funds whose NAV history starts more than three years after their launch.
  const classes = { repaired: [], adjusted: [], "unverified-small": [], "unverified-large": [] }, outOfBand = [], lateNav = [], volumeUnits = [];
  for (const f of uni.funds) {
    for (const e of f.events) (classes[e.kind] || (classes[e.kind] = [])).push({ ticker: f.ticker, d: e.d, k: r3(e.k) });
    let rows = 0, out = 0;
    for (let i = 0; i < f.cal.days.length; i++) { if (!(fin(f.P[i]) && f.P[i] > 0 && fin(f.N[i]) && f.N[i] > 0)) continue; rows++; const q = f.P[i] / f.N[i]; if (q < P.band[0] || q > P.band[1]) out++; }
    if (rows && out / rows > 0.01) outOfBand.push({ ticker: f.ticker, share: r3(out / rows) });
    if (f.inceptionDate && f.firstNavRow && f.firstNavRow > new Date(new Date(f.inceptionDate).getTime() + 3 * 365.25 * 864e5).toISOString().slice(0, 10)) lateNav.push({ ticker: f.ticker, inception: f.inceptionDate, firstNavRow: f.firstNavRow });
    // volume is in the price's split units: the 30-day median dollar volume within a factor of 2 across each large split
    for (const s of f.splits) {
      if (!s.large) continue;
      const i = f.cal.of(s.d); if (i < 31 || i + 31 >= f.cal.days.length) continue;
      const dv = (a, b) => { const v = []; for (let j = a; j <= b; j++) v.push(fin(f.asTradedClose[j]) && fin(f.asTradedVol[j]) ? f.asTradedClose[j] * f.asTradedVol[j] : 0); return median(v); };
      const before = dv(i - 30, i - 1), after = dv(i + 1, i + 30);
      if (before > 0 && after > 0 && (after / before > 2 || before / after > 2)) volumeUnits.push({ ticker: f.ticker, d: s.d, before: Math.round(before), after: Math.round(after) });
    }
  }
  const unverified = [...classes["unverified-small"], ...classes["unverified-large"]];
  // the funds and fund-days removed because of a LATER event ([6](f): a LARGE unverified event makes the fund not eligible from its
  // first row until 252 market days after it). Each read prints these two counts beside its headline (V3).
  const blockedFunds = new Set(); let blockedDays = 0;
  for (const f of uni.funds) {
    let firstRow = -1; for (let i = 0; i < f.cal.days.length; i++) if (fin(f.P[i])) { firstRow = i; break; }
    if (firstRow < 0) continue;
    for (const e of unverifiedEvents(f)) if (e.large && e.i > firstRow) { blockedFunds.add(f.ticker); blockedDays += e.i - firstRow; }
  }
  return { id: "V3", pass: true, classes: Object.fromEntries(Object.entries(classes).map(([k, v]) => [k, v.length])), unverified,
    fundsQuarantinedAroundASplit: volumeUnits, outOfBand, navHistoryStartsLate: lateNav,
    fundsRemovedForALaterEvent: [...blockedFunds], fundDaysRemovedForALaterEvent: blockedDays, why: null };
}
function gateV4({ uni, P = PARAMS }) {
  // EX-DATE ALIGNMENT: for every distribution of 1% of the price or more, whether the NAV fell by at least half the amount within one
  // market day of the price's ex-date. A fund with more than three misses is named and its signals within ten market days after any
  // distribution are void. Counts only.
  const named = [], perFund = {};
  for (const f of uni.funds) {
    let misses = 0, big = 0;
    for (const x of f.dists) {
      const i = x.i, px = fin(f.P[i]) ? f.P[i] : null;
      if (px == null || x.amount < (P.exDateBigPct / 100) * px) continue;
      big++;
      let ok = false;
      for (let j = i - 1; j <= i + 1; j++) { const p = f.prevNavIdx[j] ?? -1; if (j < 0 || j >= f.cal.days.length || !fin(f.N[j]) || p < 0 || !fin(f.N[p])) continue; if (f.N[p] - f.N[j] >= x.amount / 2) ok = true; }
      if (!ok) misses++;
    }
    perFund[f.ticker] = { big, misses };
    if (misses > 3) named.push({ ticker: f.ticker, misses, big });
  }
  return { id: "V4", pass: true, named, checked: Object.keys(perFund).length,
    quarantines: Object.fromEntries(named.map((x) => [x.ticker, [{ from: null, to: null, why: `V4: ${x.misses} ex-date misses; its signals within ten market days after any distribution are void` }]])), why: null };
}
function gateV5({ uni, secondSource = null, P = PARAMS }) {
  // IDENTITY: every fund whose price or NAV series begins more than 60 days before the list's inception date, whose first price row is
  // later than both 1999-01-01 and one year after that inception date, or whose NAV symbol is not X + ticker + X is named; each is set
  // against the second source, and a fund that cannot be confirmed is used only from the later of the inception date and the last
  // unexplained join.
  const named = [];
  for (const f of uni.funds) {
    const why = [];
    if (f.navSymbol !== `X${f.ticker}X`) why.push(`its NAV symbol is ${f.navSymbol}, not X${f.ticker}X`);
    if (f.inceptionDate && f.firstPriceRow && f.firstPriceRow < new Date(new Date(f.inceptionDate).getTime() - 60 * 864e5).toISOString().slice(0, 10)) why.push("its price series begins more than 60 days before the list's inception date");
    if (f.inceptionDate && f.firstNavRow && f.firstNavRow < new Date(new Date(f.inceptionDate).getTime() - 60 * 864e5).toISOString().slice(0, 10)) why.push("its NAV series begins more than 60 days before the list's inception date");
    if (f.inceptionDate && f.firstPriceRow && f.firstPriceRow > "1999-01-01" && f.firstPriceRow > new Date(new Date(f.inceptionDate).getTime() + 365 * 864e5).toISOString().slice(0, 10)) why.push("its first price row is later than both 1999-01-01 and one year after the inception date");
    if (why.length) named.push({ ticker: f.ticker, why });
  }
  const confirmed = new Set(((secondSource && secondSource.identityConfirmed) || []));
  const unconfirmed = named.filter((x) => !confirmed.has(x.ticker));
  return { id: "V5", pass: unconfirmed.length === 0, named, unconfirmed: unconfirmed.map((x) => x.ticker),
    quarantines: Object.fromEntries(unconfirmed.map((x) => [x.ticker, [{ from: null, to: null, why: "V5 IDENTITY: named and not confirmed against a second source" }]])),
    why: unconfirmed.length ? `${unconfirmed.length} named fund(s) are not confirmed against a second source (backend/data/r354-second-source.json identityConfirmed[]): ${unconfirmed.slice(0, 8).map((x) => x.ticker).join(", ")}` : null };
}
function gateV6({ publication = null, universeCount = 0, P = PARAMS }) {
  // PUBLICATION CHECK: the recorded looks per fund (17:30, 18:30, 20:30 New York and 08:30, 12:00, 15:30 the next market day, on 3
  // market days). A fund with no value for D at 15:30 on D+1 on 2 of the 3 days is a LATE REPORTER; more than 5% late moves every entry.
  if (!publication || !Array.isArray(publication.funds)) return { id: "V6", pass: false, why: "no publication-check recording (backend/data/r354-publication-check.json): V6 cannot be run, so the read refuses", lateReporters: [] };
  const late = publication.funds.filter((f) => (f.missingAt1530NextDay || 0) >= P.lateOf).map((f) => f.ticker);
  const share = universeCount ? late.length / universeCount : 0;
  return { id: "V6", pass: (publication.days || []).length >= 3, lateReporters: late, lateReporterAll: share > P.lateAllShare, share: r3(share),
    dateCheck: publication.dateCheck || "not run (the public list's terms are unread; the operator's yes is needed)",
    why: (publication.days || []).length >= 3 ? null : `the recording covers ${(publication.days || []).length} market day(s), not 3` };
}
function gateV7({ secondSource = null, uni, P = PARAMS }) {
  // SECOND SOURCE (levels only): every fund's gap on each Friday of the public list's weekly history against the runner's gap that day
  // (95% of Fridays within 0.5 point), and the earlier years against the funds' own shareholder reports on EDGAR.
  if (!secondSource) return { id: "V7", pass: false, why: "no second-source file (backend/data/r354-second-source.json): V7 cannot be run, so the read refuses", quarantines: {} };
  const bad = (secondSource.weekly || []).filter((x) => !(x.shareWithin <= 1 && x.shareWithin >= P.secondSourceShare)).map((x) => x.ticker);
  const edgarBad = (secondSource.edgar || []).filter((x) => !(x.shareWithin >= P.secondSourceShare)).map((x) => x.ticker);
  const funds = (secondSource.weekly || []).length;
  return { id: "V7", pass: funds > 0 && edgarBad.length === 0, quarantinedFunds: bad, edgarFailures: edgarBad,
    quarantines: Object.fromEntries(bad.map((t) => [t, [{ from: null, to: null, why: "V7 SECOND SOURCE: under 95% of Fridays within 0.5 point" }]])),
    oneSourceAfter2020: !!secondSource.listDeclined,
    why: funds === 0 ? "the second-source file holds no weekly comparison" : edgarBad.length ? `${edgarBad.length} fund(s) fail the shareholder-report sample: CANNOT MEASURE (data)` : null };
}
function gateV8({ audit = null, signals = [], P = PARAMS }) {
  // SUSPICIOUS-SIGNAL AUDIT (prints no return): the 40 real signals with the largest one-day change in the gap on the signal day, each
  // set against the second source. A signal whose gap that day is off by more than 2 points is void; more than 8 void of 40 is CANNOT MEASURE.
  if (!audit || !Array.isArray(audit.verdicts)) return { id: "V8", pass: false, why: "no hand-checked audit file (backend/data/r354-signal-audit.json): V8 cannot be run, so the read refuses", listed: signals.length };
  const void_ = audit.verdicts.filter((v) => v.offByPoints != null && v.offByPoints > P.auditPoints);
  return { id: "V8", pass: void_.length <= P.auditMaxVoid && audit.verdicts.length >= Math.min(P.auditSignals, signals.length),
    listed: signals.length, checked: audit.verdicts.length, void: void_.length, voidSignals: void_.map((v) => `${v.ticker} ${v.day}`),
    why: void_.length > P.auditMaxVoid ? `${void_.length} of ${audit.verdicts.length} audited signals are off by more than 2 points: CANNOT MEASURE (data)` : audit.verdicts.length < Math.min(P.auditSignals, signals.length) ? `only ${audit.verdicts.length} of the ${Math.min(P.auditSignals, signals.length)} listed signals were checked` : null };
}
function gateV9({ attrition = null, P = PARAMS }) {
  // ATTRITION BY STATE (counts only; wording, not a gate — but readCondition (5) asks for every gate to be written and passed, so a
  // missing recording refuses the read rather than passing quietly).
  if (!attrition || !Array.isArray(attrition.copies) || attrition.copies.length < 2) return { id: "V9", pass: false, why: "no attrition recording (backend/data/r354-attrition.json) for the two archived copies: V9 cannot be run, so the read refuses", wording: null };
  const lines = [];
  for (const c of attrition.copies) {
    const g = (k) => (c.states && c.states[k] ? c.states[k] : null);
    const rule = g("rule"), twin = g("twin");
    if (rule && twin && fin(rule.goneShare) && fin(twin.goneShare) && Math.abs(rule.goneShare - twin.goneShare) * 100 > P.attritionPoints)
      lines.push(`the placebo does not share the rule's survivorship; funds in the rule's state left the list ${rule.goneShare > twin.goneShare ? "more" : "less"} often (copy ${c.asOf})`);
  }
  return { id: "V9", pass: true, copies: attrition.copies.map((c) => c.asOf), wording: lines.length ? lines : null, why: null };
}
/**
 * ONE MADE WORLD, run end to end: the whole rule on a world's series, with the number of placebo draws and month-shifted books V10
 * prescribes for a world (100 of each, where a real read uses 500). -> { t, mean, sign, whole } ; `whole` = the WHOLE decision rule
 * (the deciding t at or above the bar AND every sign gate S1-S5) passed on that world.
 * The worlds are counted against the REGISTERED bar (1.727): their own 95th percentile is what feeds the bar in force, so counting
 * them against a bar they themselves raised would be circular.
 */
function runWorld({ cache, universe, span, spanNo, controls = {}, costTable = null, bar = PARAMS.tRequired, P = PARAMS, draws = null, shifts = null }) {
  const uni = prepareUniverse({ cache, universe, P });
  const stat = statistic({ uni, span, spanNo, controls, costTable, P, draws: draws == null ? P.shiftedBooksOnAWorld : draws, keepDraws: 0 });
  const sh = shiftedBooks({ uni, span, spanNo, stat, controls, costTable, P, n: shifts == null ? P.shiftedBooksOnAWorld : shifts });
  const sign = signGates({ stat, shifted: sh });
  const tOk = stat.t != null && stat.t >= bar;
  const whole = tOk && ["S1", "S2", "S3", "S4", "S5"].every((k) => sign[k].pass);
  return { t: stat.t, mean: stat.headline, sign, whole, tOk, positions: stat.positions.length, months: stat.months.length };
}
/**
 * V10 NO-EDGE WORLDS: 200 per span. Gate: the deciding t is at or above the bar in at most 16 of the 200 worlds, and the WHOLE
 * decision rule passes in at most 10. The 95th percentile of the deciding t over these worlds is written to the controls file and
 * enters the bar in force (bar.raisedInTheRead); it can only raise it.
 */
function gateV10({ cache, universe, span, spanNo, controls = {}, costTable = null, P = PARAMS, worlds = null, draws = null, shifts = null, onProgress = null }) {
  const N = worlds == null ? P.worlds : worlds, ts = [], results = [];
  for (let w = 0; w < N; w++) {
    const world = noEdgeWorld({ cache, universe, seed: 100000 * spanNo + w + 1, P });
    const r = runWorld({ cache: world, universe, span, spanNo, controls, costTable, P, draws, shifts });
    ts.push(r.t); results.push({ t: r3(r.t), whole: r.whole });
    if (onProgress) onProgress(w + 1, N, r);
  }
  const good = ts.filter(fin), overBar = good.filter((t) => t >= P.tRequired).length, whole = results.filter((r) => r.whole).length;
  return { id: "V10", pass: overBar <= P.worldsDecidingTMax && whole <= P.worldsWholeRuleMax && good.length === N,
    worlds: N, tOverBar: overBar, tOverBarMax: P.worldsDecidingTMax, wholeRulePassed: whole, wholeRuleMax: P.worldsWholeRuleMax,
    p95: pct(good, 0.95), formed: good.length,
    why: good.length !== N ? `only ${good.length} of ${N} worlds produced a t` : overBar > P.worldsDecidingTMax ? `the deciding t beat the bar in ${overBar} of ${N} worlds, ${P.worldsDecidingTMax} allowed` : whole > P.worldsWholeRuleMax ? `the whole rule passed in ${whole} of ${N} worlds, ${P.worldsWholeRuleMax} allowed` : null };
}
/**
 * V11 FAULT WORLDS: the whole decision rule passes in at most 10 of the 200 fault worlds, and the mean across them of the headline is
 * at or below $0 (with no edge the book should lose its costs; faults must not buy them back).
 */
function gateV11({ cache, universe, span, spanNo, controls = {}, costTable = null, P = PARAMS, worlds = null, draws = null, shifts = null, onProgress = null }) {
  const N = worlds == null ? P.worlds : worlds, means = [], results = [];
  for (let w = 0; w < N; w++) {
    const world = faultWorld({ cache, universe, seed: 200000 * spanNo + w + 1, P });
    const r = runWorld({ cache: world, universe, span, spanNo, controls, costTable, P, draws, shifts });
    means.push(r.mean); results.push({ t: r3(r.t), whole: r.whole });
    if (onProgress) onProgress(w + 1, N, r);
  }
  const whole = results.filter((r) => r.whole).length, m = mean(means.filter(fin));
  return { id: "V11", pass: whole <= P.worldsWholeRuleMax && fin(m) && m <= 0, worlds: N, wholeRulePassed: whole, meanHeadline: r2(m),
    why: whole > P.worldsWholeRuleMax ? `the whole rule passed in ${whole} of ${N} fault worlds, ${P.worldsWholeRuleMax} allowed` : !(fin(m) && m <= 0) ? `the mean headline across the fault worlds is $${r2(m)} a month, which is above $0: faults buy the costs back` : null };
}
/**
 * V12 POWER. (a) planted worlds: the deciding t is at or above the bar in at least 10 of 20 worlds carrying the published speed, else
 * CANNOT MEASURE (power) and the real book's dollars are not computed for that span. (c) inside the read, after the lock: sigma over
 * the month-shifted books, and the smallest effect found four times in five = (bar + 0.8416) x sigma / sqrt(months).
 */
function gateV12({ cache, universe, span, spanNo, controls = {}, costTable = null, P = PARAMS, worlds = null, draws = null, shifts = null, onProgress = null }) {
  const N = worlds == null ? P.plantedWorlds : worlds, ts = [];
  for (let w = 0; w < N; w++) {
    const world = plantedWorld({ cache, universe, seed: 300000 * spanNo + w + 1, P });
    const r = runWorld({ cache: world, universe, span, spanNo, controls, costTable, P, draws, shifts });
    ts.push(r.t);
    if (onProgress) onProgress(w + 1, N, r);
  }
  const found = ts.filter((t) => fin(t) && t >= P.tRequired).length;
  return { id: "V12", pass: found >= P.plantedMin, planted: N, found, needed: P.plantedMin, ts: ts.map(r3),
    why: found >= P.plantedMin ? null : `the published speed was found in ${found} of ${N} planted worlds, ${P.plantedMin} needed: CANNOT MEASURE (power)` };
}
/** V12(c): the smallest effect the single t finds four times in five, from the month-shifted books' own standard deviation */
function powerLine({ shifted, months, bar, P = PARAMS }) {
  const sigma = sdSample((shifted.books || []).map((b) => b.meanG).filter(fin));
  return { sigma: r2(sigma), smallestEffectFourInFive: fin(sigma) ? r2((bar + 0.8416) * sigma / Math.sqrt(months)) : null };
}
function gateV13({ stat, span, P = PARAMS }) {
  // SAMPLE: the span's round trips, the months with a position open, and the share of real positions without a clean series.
  // (a made-up span of the selftest carries its own minimums; the two registered spans take theirs from parameters.spans)
  const s = P.spans[span.name] || span, noClean = stat.positions.length ? stat.counts.noCleanSeries / stat.positions.length : 0;
  const okTrips = stat.counts.roundTrips >= s.minRoundTrips, okMonths = stat.counts.monthsWithPosition >= s.minMonthsWithPosition, okClean = noClean <= P.maxNoCleanShare;
  return { id: "V13", pass: okTrips && okMonths && okClean, roundTrips: stat.counts.roundTrips, minRoundTrips: s.minRoundTrips,
    monthsWithPosition: stat.counts.monthsWithPosition, minMonthsWithPosition: s.minMonthsWithPosition, months: stat.months.length,
    noCleanShare: r3(noClean), why: okTrips && okMonths && okClean ? null : [!okTrips && `${stat.counts.roundTrips} completed round trips, ${s.minRoundTrips} needed`, !okMonths && `a position open in ${stat.counts.monthsWithPosition} months, ${s.minMonthsWithPosition} needed`, !okClean && `${Math.round(noClean * 100)}% of positions have no clean series, 10% allowed`].filter(Boolean).join("; ") };
}
function gateV14({ stat, bar, P = PARAMS }) {
  // PLACEBO SANITY: one placebo draw against the mean of the others shows a t at or above the bar in at most 3 of 20 draws.
  const keep = stat.keptDraws || [];
  if (keep.length < 20) return { id: "V14", pass: false, why: `only ${keep.length} placebo draws were kept, 20 are needed`, over: null };
  let over = 0; const ts = [];
  for (let i = 0; i < 20; i++) {
    const others = keep.filter((_, j) => j !== i);
    const m = stat.months.map((M, k) => keep[i][k] - mean(others.map((o) => o[k])));
    const t = nwT(m, P.neweyWestLag); ts.push(r3(t));
    if (t != null && t >= bar) over++;
  }
  return { id: "V14", pass: over <= 3, over, draws: 20, ts, why: over > 3 ? `${over} of 20 placebo draws beat the bar against the mean of the others` : null };
}
function gateV15({ manifest = null, now = null, P = PARAMS }) {
  // CACHE: fetched on or after 2026-10-15; the last 10 market days of the span fetched a second time 10 market days later and the two
  // copies compared (count of changed rows, no values); a fund with a changed row is listed before the read.
  if (!manifest) return { id: "V15", pass: false, why: "no cache manifest (backend/data/r354-cache-manifest.json): V15 cannot be run, so the read refuses" };
  const fetchedAt = String(manifest.fetchedAt || "").slice(0, 10);
  const okDate = fetchedAt >= P.cacheNotBefore;
  const second = manifest.secondFetch || null;
  const okSecond = !!second && Array.isArray(second.changedRowFunds);
  return { id: "V15", pass: okDate && okSecond && !!manifest.sha256, fetchedAt, cacheSha256: manifest.sha256 || null,
    changedRowFunds: okSecond ? second.changedRowFunds : null, frozen: !!manifest.frozen,
    why: !okDate ? `the cache says it was fetched ${fetchedAt || "(no date)"} — not on or after ${P.cacheNotBefore}` : !okSecond ? "the manifest holds no second fetch of the span's last 10 market days" : !manifest.sha256 ? "the manifest holds no sha256 of itself" : null };
}
function gateV16({ discoveryMean = null, discoveryT = null, P = PARAMS }) {
  // TOO GOOD OR TOO BAD: a discovery mean of G or of D above $1,517 or below -$1,517 a month per $100,000, or a discovery t above 6 or
  // below -6, puts the read on HOLD for a hand check of the 20 largest positions.
  const big = fin(discoveryMean) && Math.abs(discoveryMean) > P.tooGoodUsd, bigT = fin(discoveryT) && Math.abs(discoveryT) > P.tooGoodT;
  return { id: "V16", pass: !(big || bigT), hold: big || bigT, mean: r2(discoveryMean), t: r3(discoveryT),
    why: big ? `the discovery mean $${r2(discoveryMean)} a month is outside +/-$${P.tooGoodUsd}: HOLD for a hand check` : bigT ? `the discovery t ${r3(discoveryT)} is outside +/-${P.tooGoodT}: HOLD for a hand check` : null };
}

// ──────────────────────────────────────────────────────── the decision rule ────────────────────────────────────────────────────────
/** DISCOVERY (decisionRule.discovery): PROCEED only if every validity gate passed and the mean of G over its 108 months is above $0. */
function decideDiscovery({ stat, gates, P = PARAMS }) {
  const failed = gates.filter((g) => !g.pass).map((g) => g.id);
  if (failed.length) return { verdict: "CANNOT MEASURE", why: `validity gate(s) ${failed.join(", ")} did not pass`, failedGates: failed, mean: stat ? r2(stat.headline) : null };
  if (!(stat.headline > 0)) return { verdict: "DID NOT PASS", why: "in 2003-2011, on survivors, the book did not earn its costs in the gap over holding", mean: r2(stat.headline), t: r3(stat.t) };
  return { verdict: "PROCEED", mean: r2(stat.headline), t: r3(stat.t), tAgainst: BAR.tRequiredDiscoveryReportedOnly, note: "the discovery t is printed and does not gate (decisionRule.discovery)" };
}
/**
 * HOLDOUT (decisionRule.pass / .fail / .nearMiss): PASS only if ALL hold — every validity gate passed in both spans; discovery sealed
 * PROCEED; the Newey-West lag-4 t of G is at or above the BAR IN FORCE; S1 D > 0; S2 G21 > 0; S3 GUS > 0; S4 GPEER > 0; S5 above the
 * median of the month-shifted books. A t below the bar in force BY ANY MARGIN is DID NOT PASS; the comparison is on the unrounded t.
 */
function decideHoldout({ stat, gates, gatesDiscovery = [], discovery = null, bar, sign, P = PARAMS }) {
  const failed = [...gates, ...gatesDiscovery].filter((g) => !g.pass).map((g) => g.id);
  const conditions = [
    { id: "(1) every validity gate passed, in both spans", ok: failed.length === 0, detail: failed.length ? `failed: ${[...new Set(failed)].join(", ")}` : "all passed" },
    { id: "(2) discovery sealed PROCEED", ok: !!discovery && discovery.verdict === "PROCEED", detail: discovery ? discovery.verdict : "no sealed discovery read" },
    { id: "(3) the holdout t is at or above the bar in force", ok: stat.t != null && stat.t >= bar.t, detail: `t ${r3(stat.t)} against ${r3(bar.t)} (${bar.binding})` },
    { id: "(4) S1: mean D above $0", ok: sign.S1.pass, detail: `$${r2(sign.S1.mean)}` },
    { id: "(5) S2: mean G21 above $0", ok: sign.S2.pass, detail: `$${r2(sign.S2.mean)}` },
    { id: "(6) S3: mean G on US-clock funds above $0", ok: sign.S3.pass, detail: `$${r2(sign.S3.mean)}` },
    { id: "(7) S4: mean GPEER above $0", ok: sign.S4.pass, detail: `$${r2(sign.S4.mean)}` },
    { id: "(8) S5: mean G per position opened above the median of the 500 month-shifted books", ok: sign.S5.pass, detail: sign.S5.ran ? `$${r3(sign.S5.mean)} against $${r3(sign.S5.median)}` : "the shifted books were not run" },
  ];
  if (failed.length) return { verdict: "CANNOT MEASURE", conditions, failedGates: [...new Set(failed)], why: `validity gate(s) ${[...new Set(failed)].join(", ")} did not pass`, mean: r2(stat.headline), t: r3(stat.t), bar: r3(bar.t) };
  const bad = conditions.filter((c) => !c.ok);
  return { verdict: bad.length ? "DID NOT PASS" : "PASS", conditions, failedConditions: bad.map((c) => c.id), mean: r2(stat.headline), t: r3(stat.t), bar: r3(bar.t),
    nearMiss: stat.t != null && stat.t < bar.t && bar.t - stat.t <= 0.05,
    why: bad.length ? `not demonstrated: ${bad.map((c) => c.id).join("; ")}` : null };
}

module.exports = { fin, mean, sdSample, median, pct, nwT, mulberry32, r2, r3, monthKey, halfMonthKey, dow, secondMondayOfOctober, isBondHoliday, makeCalendar, PARAMS, BAR, RULE_SHA256, RULE_SHA_KEYS, paramsDiff, splitEvents, unitRepair, suspectRows, costGroupOf, prepareFund, navSymbolAccepted, wrongPrintSet, removedAsOf, suspectOnOrBefore, unverifiedEvents, zAt, validRowsBefore, prepareUniverse, inSeenWindow, quarantined, eligible, belowValueBothWays, signalAt, placeboDayOk, tradedAt, roundTripCost, cleanStartIdx, exDateClear, cleanEndIdx, monthEndIdx, priceMarkIdx, distBetween,
  spanBounds, spanMonths, monthLastIdx, runBook, gapAnchors, gapOfMonth, priceAnchors, monthlyOf, makePeer, placeboDaysOf, placeboDraw, statistic, shiftedBook, shiftedBooks, blockBootstrapP95, barInForce, signGates, labels,
  noEdgeWorld, faultWorld, plantedWorld, runWorld, powerLine,
  gateV2, gateV3, gateV4, gateV5, gateV6, gateV7, gateV8, gateV9, gateV10, gateV11, gateV12, gateV13, gateV14, gateV15, gateV16, decideDiscovery, decideHoldout };
