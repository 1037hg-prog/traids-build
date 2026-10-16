#!/usr/bin/env node
/**
 * R207 — CROSS, RETEST, HOLD: break-and-retest entries at four levels (registered 2026-09-24 before this file existed; rule
 * frozen in data/test-registry.json, preregistered[id=R207]). Family CRH-4 = level L in {session VWAP, 20-EMA of 5-minute
 * closes, prior session's high (longs) / low (shorts), 30-minute opening range high (longs) / low (shorts)}; each level pools
 * longs and mirrored shorts. Best-of-4 bar: a level PASSES if its HOLDOUT (2022-01-01..2026-08-31) net t_NW(lag 1) >= 2.225
 * AND it beats its own RANDOM-ENTRY control's 95th percentile (200 draws).
 *
 * USAGE
 *   node backend/r207-cross-retest-hold.js --selftest    synthetic-bar unit tests only
 *   node backend/r207-cross-retest-hold.js --fetch       download + cache SIP 5Min bars under data/training/r207 (resumable)
 *   node backend/r207-cross-retest-hold.js --discovery   pipeline sanity on DISCOVERY 2018-2021 only (no holdout number computed)
 *   node backend/r207-cross-retest-hold.js --read        THE one read: family (both splits, 2R/1R/3R, long/short), random-entry
 *                                                        (200 draws), bootstrap, peek, leak; writes data/r207-cross-retest-hold.json;
 *                                                        seals only if selftest, leak, bootstrap and peek pass and the random-entry
 *                                                        control was fully computed
 *
 * DATA. Alpaca SIP 5Min, adjustment "split", 2017-11-01..2026-08-31 via lib/alpaca-bars.js fetchBars (requireAll false; coverage
 * reported). Nov-Dec 2017 is warm-up only; nothing before 2018-01-02 is scored. SPY/QQQ/IWM are read from the R178 cache
 * (data/training/r178/etf-<SYM>-<YYYY>.json, same source/adjustment, all-hours rows) and cut to >= 2017-11-01 so every symbol
 * warms up from the same date. Regular session only: bar START in [open, close) ET per Alpaca /v2/calendar (lib/mine3-minute.js
 * calendar, its cached 2015-12-01..2026-08-31 file), so a half-day keeps 09:30-12:55 bars.
 * Split factors for the per-share cost (N12): Alpaca SIP 1Day closes with adjustment "split" and "raw", cached in
 * data/training/r207/daily-split-factors.json.
 *
 * IMPLEMENTATION NOTES (literal readings of the rule text, fixed before any result was seen):
 *  N1  Series = RTH 5-minute bars only, per symbol, continuous across sessions. ATR(14) Wilder (seed = mean of the first 14 TRs,
 *      then (13*prev + TR)/14); a session's first TR includes the overnight gap. 20-EMA of closes, seeded with the SMA of the first
 *      20 closes, alpha 2/21, continuous across sessions (it is "the 20-period EMA of 5-minute closes", not reset daily).
 *      Session VWAP = cumulative typical price (H+L+C)/3 x V / cumulative V from the session's first bar (the cached rows carry no
 *      per-bar vwap field), reset every session. Every level value at bar i is the value through bar i's CLOSE ("L evaluated at
 *      each bar"); indicator arrays read rows 0..i only (checked by the truncation test, N15).
 *  N2  Prior-day levels: the regular-hours high / low of the PREVIOUS CALENDAR session (the Alpaca calendar's prior trading day,
 *      its own half-day hours if shortened). If the symbol has no bars for that session, the level is undefined for the day.
 *      Longs use the prior high only, shorts the prior low only.
 *  N3  Opening range = max high / min low of the session's bars starting 09:30..09:55 (09:30-10:00 ET). The OR level is defined
 *      at bar i only once bar i ENDS at or after 10:00 (so the range is complete at i's close); the CROSS bar must start at or
 *      after 10:00 ("crosses only after 10:00"). The 09:55 bar can therefore be bar c-1 (its close is inside the range by
 *      construction). Longs use OR high, shorts OR low.
 *  N4  CROSS (long) at bar c: close[c] > L[c] and close[c-1] <= L[c-1], with c-1 in the SAME session as c for every level (VWAP
 *      and the day levels are session objects, and a gap open is not an observable intraday cross; applied uniformly to the EMA
 *      too so the four levels share one definition). Short mirror: close[c] < L[c] and close[c-1] >= L[c-1].
 *  N5  RETEST: scan bars c+1..c+12 of the series ("the next 12 bars" = next 12 RTH bars present in the data), stopping at the
 *      session end (the setup dies with its session). The first bar r with low[r] <= L[r] + 0.10 x ATR[r] (short: high[r] >=
 *      L[r] - 0.10 x ATR[r]) is THE retest. ATR is ATR(14) through bar r ("ATR" at the bar being tested; same ATR sets the stop).
 *      Void-between: a bar strictly between c and r closing below L[that bar] (short: above) voids the setup. Note: such a bar's
 *      low is below L, so it would itself be the first retest bar; the between-void is therefore implied by the retest + hold
 *      rules and can never fire on its own. It is implemented literally anyway. A bar in the window with an undefined level or
 *      ATR voids the setup (conservative; never occurs after warm-up for VWAP/EMA/day levels).
 *  N6  HOLD: close[r] >= L[r] (short: <= L[r]); otherwise the setup is void (no later bar is considered).
 *  N7  ENTRY at the OPEN of bar r+1, which must exist in the same session and START at or before 15:00 ET ("no new entries after
 *      15:00"). STOP = low[r] - 0.05 x ATR[r] (short: high[r] + 0.05 x ATR[r]). R = |entry - stop| from the ACTUAL entry (the
 *      open), so the target moves with a gapped open. If the r+1 open is already at/through the stop (R <= 0) the trade cannot be
 *      placed and the setup is void (counted). TARGET = entry +/- 2R (1R and 3R variants reported).
 *  N8  Exits. The entry is at bar r+1's OPEN, so the whole of bar r+1 lies after the entry and IS tested (unlike R178/R202, whose
 *      fills were intrabar). Per bar: open beyond stop -> exit at the open; stop touched -> exit at the stop; open beyond target ->
 *      exit at the open; target touched -> exit at the target. A bar touching both is a STOP (stop first). Then the time exit:
 *      flat at the CLOSE of the 15:50 bar (= 15:55 ET), or at the close of the session's last bar on a half-day.
 *      Sensitivity (report only, never a gate): the entry bar r+1 NOT tested for stop/target.
 *  N9  ONE OPEN TRADE PER SYMBOL PER LEVEL (longs and shorts of a level share it). All setups of a symbol-level are ordered by
 *      entry bar (ties — e.g. a long and a short entering on the same bar when close[r] == L — broken by a seeded random key,
 *      never row order); a setup is taken only if its entry bar is AFTER the exit bar of the open trade. Setups are detected
 *      regardless of an open position (the cross/retest is a chart event); the position rule only filters entries.
 *  N10 Session = ET date of the entry bar (always the setup's session). Statistic per level: per session the mean net R of all
 *      that session's trades (33 symbols, longs and shorts pooled); t over sessions with >= 1 trade, Newey-West lag 1 (Bartlett:
 *      var = g0 + g1, identical to r202's nwT). Trades per month = trades / calendar months (48 discovery, 56 holdout).
 *  N11 Windows by entry session: discovery 2018-01-02..2021-12-31 (pipeline sanity only), holdout 2022-01-01..2026-08-31 (verdict).
 *  N12 Cost in R = ($0.02 per ACTUAL share round trip + 0.0002 x entry + 0.0002 x exit) / R. Prices are split-adjusted, so the
 *      per-share term is applied on the unadjusted scale: $0.02 / f, f = raw close / split-adjusted close on the entry session
 *      (Alpaca daily bars; nearest earlier date if missing; 1 if unavailable, counted). The 0.02%-per-side term is scale-free.
 *      Reason: on split-adjusted prices a literal $0.02 would charge e.g. NVDA 2022-23 ten times its real per-share cost, a cost
 *      that depends on FUTURE splits. The literal adjusted-price net is also reported (sensitivity, not the statistic).
 *  N13 RANDOM-ENTRY control (bar.alsoRequired). For each level, cell = symbol x ET month of the entry x direction x time-of-day
 *      bucket of the entry bar (30-minute buckets 09:30-10:00 ... 14:30-15:00, plus the 15:00 bar alone). Pool = every RTH bar of
 *      that symbol-month-bucket that could be an entry (it has a prior bar in the same session with a finite ATR and starts at or
 *      before 15:00). Per draw, per cell: draw WITHOUT replacement as many pool bars as the level had real 2R TRADES in that cell
 *      (the pool always contains the real entry bars, so the count is always matched); the k-th drawn bar takes the k-th real
 *      trade's stop distance in ATR units d = R/ATR[r] (real trades ordered by entry bar; the pool shuffle is the randomness):
 *      entry = open[e], R = d x ATR[e-1], same 2R target, same exit rules (N8) and cost (N12). Random trades are evaluated
 *      independently (no one-open-trade filter, which would break the matched count). 200 seeded draws. Compared on the
 *      registered statistic (holdout net t_NW); session-mean net R also reported.
 *  N14 Bootstrap: demean the gross per-session R series, 2000 seeded iid resamples of the same n, t_NW of each; passes if the
 *      median |t| < 2 (fraction >= 2 reported). Peek: target-exit trades only; must reach t_NW >= 2.225. Both are gated on the
 *      HOLDOUT of all four levels (on discovery in --discovery).
 *  N15 Leak: (a) asserted per setup — the last bar any condition reads (c-1..r, the level's source bars, ATR[r]) is <= r, the
 *      entry index is r+1 and the entry price is open[r+1]; (b) truncation test — series, levels and setups are rebuilt on data cut
 *      at seeded random points and every level value and every setup with entry bar <= the cut must be identical.
 *  N16 Every draw / resample uses seeded mulberry32 streams (fnv hash of a label). sortTied() breaks every sort tie with a seeded
 *      random key, never row order.
 *
 * Paper only; no orders; this file never touches the broker or the server.
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const CACHE = path.join(__dirname, "data", "training", "r207");
const R178 = path.join(__dirname, "data", "training", "r178");
const UNIVERSE = ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "AMD", "AVGO", "NFLX", "JPM", "BAC", "XOM", "CVX", "UNH", "LLY", "COST", "WMT", "HD", "V", "MA", "ORCL", "CRM", "ADBE", "INTC", "CSCO", "PEP", "KO", "DIS", "BA"];
const R178_ETFS = new Set(["SPY", "QQQ", "IWM"]);
const WIN = { disc: ["2018-01-02", "2021-12-31"], hold: ["2022-01-01", "2026-08-31"] };
const MONTHS = { disc: 48, hold: 56 };
const START_MS = Date.parse("2017-11-01T00:00:00Z");
const BAR_T = 2.225, RETEST_BARS = 12, PROX = 0.10, PAD = 0.05, CPS = 0.02, PCT = 0.0002;
const OR_END = 600, LAST_ENTRY = 900, FLAT_BAR = 950;            // minutes of day ET: 10:00, 15:00, the 15:50 bar (closes 15:55)
const LEVELS = ["vwap", "ema20", "pdhl", "or30"];
const HOUR = 3600000;

// ── seeded randomness (as r178/r202) ────────────────────────────────────────────────────────────────────────────────────
function fnv(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function sortTied(arr, keyFn, seedLabel) {
  const r = mulberry32(fnv(seedLabel));
  return arr.map((x) => [keyFn(x), r(), x]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1])).map((z) => z[2]);
}

// ── ET time (offset memoised per UTC hour) ──────────────────────────────────────────────────────────────────────────────
const FMT = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const offCache = new Map();
function etOffsetMs(ms) { const hk = Math.floor(ms / HOUR); let o = offCache.get(hk); if (o === undefined) { const p = Object.fromEntries(FMT.formatToParts(new Date(hk * HOUR)).map((x) => [x.type, x.value])); o = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - hk * HOUR; offCache.set(hk, o); } return o; }
function etOf(ms) { const d = new Date(ms + etOffsetMs(ms)); return { date: d.toISOString().slice(0, 10), mod: d.getUTCHours() * 60 + d.getUTCMinutes() }; }

// ══ CALENDAR + FETCH ════════════════════════════════════════════════════════════════════════════════════════════════════
let CAL = null, PREV = null;
async function loadCalendar() {
  if (CAL) return CAL;
  const { calendar } = require("./lib/mine3-minute.js");
  const s = await calendar("2015-12-01", "2026-08-31");
  CAL = new Map(s.map((x) => [x.date, [x.open, x.close]]));
  const dates = [...CAL.keys()].sort();
  PREV = new Map(dates.map((d, i) => [d, i ? dates[i - 1] : null]));
  return CAL;
}
function isRth(ms, cal) { const { date, mod } = etOf(ms); const oc = cal.get(date); return !!oc && mod >= oc[0] && mod < oc[1]; }

async function fetchAll() {
  const FB = require("./lib/alpaca-bars.js").fetchBars;
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const fetchBars = async (syms, o) => { for (let k = 0; ; k++) { try { return await FB(syms, { retries: 10, minIntervalMs: 500, ...o }); } catch (e) { if (k >= 8 || !/429|5\d\d|failed/.test(String(e.message))) throw e; console.log("  shared rate limit hit; waiting 60s (attempt " + (k + 1) + ")"); await nap(60000); } } };
  const cal = await loadCalendar();
  fs.mkdirSync(CACHE, { recursive: true });
  const fd = path.join(CACHE, "daily-split-factors.json");
  if (!fs.existsSync(fd)) {
    const o = { start: "2017-11-01T00:00:00Z", end: "2026-08-31T23:59:59Z", timeframe: "1Day", feed: "sip", requireAll: false, quiet: true };
    const a = await fetchBars(UNIVERSE, { ...o, adjustment: "split" }), b = await fetchBars(UNIVERSE, { ...o, adjustment: "raw" });
    const out = {};
    for (const s of UNIVERSE) { const m = new Map((b.bars[s] || []).map((x) => [x.t.slice(0, 10), x.c])); out[s] = (a.bars[s] || []).map((x) => [x.t.slice(0, 10), x.c, m.get(x.t.slice(0, 10)) ?? null]); }
    writeJsonAtomic(fd, { source: "alpaca sip 1Day, adjustment split vs raw closes: [date, splitClose, rawClose]", fetchedAt: new Date().toISOString(), rows: out }, { pretty: 0 });
    console.log("  daily split/raw closes written");
  }
  const order = UNIVERSE.filter((s) => !R178_ETFS.has(s));
  if (process.argv.includes("--reverse")) order.reverse();
  const fromArg = process.argv.indexOf("--from");                        // a parallel fetch process may start mid-list (wraps)
  if (fromArg > 0) { const k = order.indexOf(process.argv[fromArg + 1]); if (k > 0) order.push(...order.splice(0, k)); }
  for (const sym of order) {
    for (let y = 2017; y <= 2026; y++) {
      const f = path.join(CACHE, `${sym}-${y}.json`);
      if (fs.existsSync(f)) continue;
      const start = y === 2017 ? "2017-11-01T00:00:00Z" : `${y}-01-01T00:00:00Z`;
      const end = y === 2026 ? "2026-08-31T23:59:59Z" : `${y}-12-31T23:59:59Z`;
      const r = await fetchBars([sym], { start, end, timeframe: "5Min", feed: "sip", adjustment: "split", requireAll: false, quiet: true });
      const raw = r.bars[sym] || [];
      const rows = raw.map((b) => [Date.parse(b.t), b.o, b.h, b.l, b.c, b.v]).filter((x) => isRth(x[0], cal));
      if (fs.existsSync(f)) continue;
      writeJsonAtomic(f, { source: "alpaca sip 5Min adjustment=split, RTH-filtered by /v2/calendar", sym, start, end, fetchedAt: new Date().toISOString(), pages: r.pages, rawBars: raw.length, rows }, { pretty: 0 });
      console.log(`  ${sym} ${y}: ${rows.length} RTH bars of ${raw.length} raw (${r.pages} pages)`);
    }
  }
}

function loadRows(sym) {
  const dir = R178_ETFS.has(sym) ? R178 : CACHE, pre = R178_ETFS.has(sym) ? `etf-${sym}-` : `${sym}-`;
  const re = R178_ETFS.has(sym) ? new RegExp(`^etf-${sym}-\\d{4}\\.json$`) : new RegExp(`^${sym}-\\d{4}\\.json$`);
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(pre) && re.test(f)).sort();
  const m = new Map();
  for (const f of files) for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).rows) if (r[0] >= START_MS && isRth(r[0], CAL)) m.set(r[0], r);
  return sortTied([...m.values()], (r) => r[0], `R207-rows-${sym}`);   // timestamps unique (map keys)
}
let SPLIT = null;
function splitFactorFn(sym) {
  if (!SPLIT) { const f = path.join(CACHE, "daily-split-factors.json"); SPLIT = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")).rows : {}; }
  const rows = (SPLIT[sym] || []).filter((r) => r[1] > 0 && r[2] > 0).map((r) => [r[0], Math.round((r[2] / r[1]) * 1000) / 1000]);
  const dates = rows.map((r) => r[0]), vals = rows.map((r) => r[1]);
  const memo = new Map();
  return (date) => {
    if (memo.has(date)) return memo.get(date);
    let lo = 0, hi = dates.length - 1, k = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (dates[mid] <= date) { k = mid; lo = mid + 1; } else hi = mid - 1; }
    const v = k >= 0 ? vals[k] : dates.length ? vals[0] : NaN;
    memo.set(date, v); return v;
  };
}

// ══ SERIES + LEVELS (strictly causal: value[i] reads rows 0..i only; day levels read only earlier sessions / OR bars) ═════
function buildSeries(name, rows, prevOf) {
  const N = rows.length;
  const t = new Float64Array(N), o = new Float64Array(N), h = new Float64Array(N), l = new Float64Array(N), c = new Float64Array(N), v = new Float64Array(N);
  const mod = new Int16Array(N), sess = new Array(N), last = new Uint8Array(N);
  for (let i = 0; i < N; i++) { const r = rows[i]; t[i] = r[0]; o[i] = r[1]; h[i] = r[2]; l[i] = r[3]; c[i] = r[4]; v[i] = r[5]; const e = etOf(r[0]); mod[i] = e.mod; sess[i] = e.date; }
  for (let i = 0; i < N; i++) last[i] = i === N - 1 || sess[i + 1] !== sess[i] ? 1 : 0;
  const atr = new Float64Array(N).fill(NaN), ema = new Float64Array(N).fill(NaN), vwap = new Float64Array(N).fill(NaN);
  const pdh = new Float64Array(N).fill(NaN), pdl = new Float64Array(N).fill(NaN), pdSrc = new Int32Array(N).fill(-1);
  const orh = new Float64Array(N).fill(NaN), orl = new Float64Array(N).fill(NaN), orSrc = new Int32Array(N).fill(-1);
  let acc = 0, es = 0, pv = 0, vv = 0;
  const dayHL = new Map();                                                  // session -> [high, low, lastIndex] (completed sessions)
  let curS = null, curH = -Infinity, curL = Infinity, oh = -Infinity, ol = Infinity, orLast = -1;
  for (let i = 0; i < N; i++) {
    const tr = i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    if (i < 14) { acc += tr; if (i === 13) atr[i] = acc / 14; } else atr[i] = (atr[i - 1] * 13 + tr) / 14;
    if (i < 20) { es += c[i]; if (i === 19) ema[i] = es / 20; } else ema[i] = ema[i - 1] + (2 / 21) * (c[i] - ema[i - 1]);
    if (sess[i] !== curS) {
      if (curS !== null) dayHL.set(curS, [curH, curL, i - 1]);
      curS = sess[i]; curH = -Infinity; curL = Infinity; pv = 0; vv = 0; oh = -Infinity; ol = Infinity; orLast = -1;
    }
    pv += ((h[i] + l[i] + c[i]) / 3) * v[i]; vv += v[i];
    vwap[i] = vv > 0 ? pv / vv : NaN;
    curH = Math.max(curH, h[i]); curL = Math.min(curL, l[i]);
    const p = prevOf(sess[i]), d = p ? dayHL.get(p) : null;                 // N2: previous CALENDAR session, completed
    if (d) { pdh[i] = d[0]; pdl[i] = d[1]; pdSrc[i] = d[2]; }
    if (mod[i] < OR_END) { oh = Math.max(oh, h[i]); ol = Math.min(ol, l[i]); orLast = i; }
    if (mod[i] + 5 >= OR_END && orLast >= 0) { orh[i] = oh; orl[i] = ol; orSrc[i] = orLast; }   // N3: range complete at i's close
  }
  return { name, N, t, o, h, l, c, v, mod, sess, last, atr, ema, vwap, pdh, pdl, pdSrc, orh, orl, orSrc };
}
/** level lines for longs / shorts, the earliest cross bar, and the index of the latest bar a level value was built from. */
function levelLines(S, lvl) {
  const src = (arr) => (i) => arr[i];
  if (lvl === "vwap") return { LL: S.vwap, LS: S.vwap, crossFrom: 0, srcOf: (i) => i };
  if (lvl === "ema20") return { LL: S.ema, LS: S.ema, crossFrom: 0, srcOf: (i) => i };
  if (lvl === "pdhl") return { LL: S.pdh, LS: S.pdl, crossFrom: 0, srcOf: src(S.pdSrc) };
  if (lvl === "or30") return { LL: S.orh, LS: S.orl, crossFrom: OR_END, srcOf: src(S.orSrc) };
  throw new Error("unknown level " + lvl);
}

// ══ SETUPS (cross, retest, hold -> entry candidate) ═════════════════════════════════════════════════════════════════════
function findSetups(S, lines, { leakCheck = true } = {}) {
  const { N, o, h, l, c, mod, sess, atr } = S, { LL, LS, crossFrom, srcOf } = lines;
  const out = [], voids = { hold: 0, between: 0, noRetest: 0, undefinedLevel: 0, noEntryBar: 0, after1500: 0, gapThroughStop: 0 };
  for (const dir of [1, -1]) {
    const L = dir > 0 ? LL : LS;
    for (let x = 1; x < N; x++) {
      if (sess[x] !== sess[x - 1] || mod[x] < crossFrom) continue;
      const Lc = L[x], Lp = L[x - 1];
      if (!Number.isFinite(Lc) || !Number.isFinite(Lp)) continue;
      const cross = dir > 0 ? c[x] > Lc && c[x - 1] <= Lp : c[x] < Lc && c[x - 1] >= Lp;
      if (!cross) continue;
      let r = -1, maxSrc = Math.max(srcOf(x), srcOf(x - 1)), status = "noRetest";
      for (let k = x + 1; k <= x + RETEST_BARS && k < N && sess[k] === sess[x]; k++) {
        const Lk = L[k], A = atr[k];
        if (!Number.isFinite(Lk) || !Number.isFinite(A)) { status = "undefinedLevel"; break; }
        maxSrc = Math.max(maxSrc, srcOf(k));
        const touch = dir > 0 ? l[k] <= Lk + PROX * A : h[k] >= Lk - PROX * A;
        if (touch) {
          const hold = dir > 0 ? c[k] >= Lk : c[k] <= Lk;
          if (hold) { r = k; status = "ok"; } else status = "hold";
          break;
        }
        if (dir > 0 ? c[k] < Lk : c[k] > Lk) { status = "between"; break; }   // N5: implied, never fires on its own
      }
      if (status !== "ok") { voids[status]++; continue; }
      const e = r + 1;
      if (e >= N || sess[e] !== sess[r]) { voids.noEntryBar++; continue; }
      if (mod[e] > LAST_ENTRY) { voids.after1500++; continue; }
      const entry = o[e], stop = dir > 0 ? l[r] - PAD * atr[r] : h[r] + PAD * atr[r], R = dir * (entry - stop);
      if (!(R > 0)) { voids.gapThroughStop++; continue; }
      const maxRead = Math.max(r, maxSrc);
      if (leakCheck && !(maxRead <= r && e === r + 1 && entry === o[r + 1] && x < r)) throw new Error(`LEAK ${S.name} setup c${x} r${r} e${e}`);
      out.push({ dir, c: x, r, e, entry, stop, R, atrR: atr[r], dAtr: R / atr[r], maxRead });
    }
  }
  return { setups: out, voids };
}

// ══ EXITS + SIMULATOR ═══════════════════════════════════════════════════════════════════════════════════════════════════
function exitFrom(S, e, dir, stop, tgt, testEntryBar = true) {
  const { N, o, h, l, c, mod, last } = S;
  for (let x = e; x < N; x++) {
    if (x > e || testEntryBar) {
      if (dir > 0) {
        if (x > e && o[x] <= stop) return [x, o[x], "stop"];
        if (l[x] <= stop) return [x, stop, "stop"];
        if (x > e && o[x] >= tgt) return [x, o[x], "target"];
        if (h[x] >= tgt) return [x, tgt, "target"];
      } else {
        if (x > e && o[x] >= stop) return [x, o[x], "stop"];
        if (h[x] >= stop) return [x, stop, "stop"];
        if (x > e && o[x] <= tgt) return [x, o[x], "target"];
        if (l[x] <= tgt) return [x, tgt, "target"];
      }
    }
    if (mod[x] >= FLAT_BAR || last[x]) return [x, c[x], "time"];
  }
  return null;
}
function costR(entry, exit, R, f) { return (CPS / (Number.isFinite(f) && f > 0 ? f : 1) + PCT * (entry + exit)) / R; }
function simulate(S, setups, mult, { testEntryBar = true, split = () => 1, tag = "" } = {}) {
  const ordered = sortTied(setups, (s) => s.e, `R207-order-${S.name}-${tag}`);
  const trades = [];
  let busy = -1;
  for (const s of ordered) {
    if (s.e <= busy) continue;                                                     // N9: one open trade per symbol per level
    const tgt = s.entry + s.dir * mult * s.R;
    const ex = exitFrom(S, s.e, s.dir, s.stop, tgt, testEntryBar);
    if (!ex) break;
    const [xi, X, reason] = ex, gross = s.dir * (X - s.entry) / s.R, sd = S.sess[s.e], f = split(sd);
    trades.push({ sym: S.name, sess: sd, dir: s.dir, e: s.e, xi, mod: S.mod[s.e], entry: s.entry, exit: X, R: s.R, dAtr: s.dAtr, gross, net: gross - costR(s.entry, X, s.R, f), netLiteral: gross - (CPS + PCT * (s.entry + X)) / s.R, reason });
    busy = xi;
  }
  return trades;
}

// ══ STATISTICS ══════════════════════════════════════════════════════════════════════════════════════════════════════════
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
function nwT(a) { const n = a.length; if (n < 3) return NaN; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n, cc = 0; for (let i = 1; i < n; i++) cc += d[i] * d[i - 1]; v += cc / n; return v > 0 ? m / Math.sqrt(v / n) : NaN; }
const r4 = (x) => (Number.isFinite(x) ? +x.toFixed(4) : null), r3 = (x) => (Number.isFinite(x) ? +x.toFixed(3) : null);
const inWin = (s, w) => s >= w[0] && s <= w[1];
function perSession(trades, key) {
  const m = new Map();
  for (const tr of trades) { const a = m.get(tr.sess); if (a) a.push(tr[key]); else m.set(tr.sess, [tr[key]]); }
  return sortTied([...m.entries()], (e) => e[0], "R207-sess").map(([, a]) => mean(a));
}
function pctl(arr, p) { const s = arr.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; }
function summarize(trades, wk) {
  const tr = trades.filter((x) => inWin(x.sess, WIN[wk]));
  const net = perSession(tr, "net"), gross = perSession(tr, "gross"), lit = perSession(tr, "netLiteral");
  const exits = {}; for (const x of tr) exits[x.reason] = (exits[x.reason] || 0) + 1;
  return {
    trades: tr.length, sessionsWithTrades: net.length, tradesPerMonth: r3(tr.length / MONTHS[wk]),
    netRPerTrade: r4(mean(tr.map((x) => x.net))), grossRPerTrade: r4(mean(tr.map((x) => x.gross))), costRPerTrade: r4(mean(tr.map((x) => x.gross - x.net))),
    sessionMeanNetR: r4(mean(net)), sessionMeanGrossR: r4(mean(gross)), tNet: r3(nwT(net)), tGross: r3(nwT(gross)),
    winRate: r4(tr.filter((x) => x.net > 0).length / tr.length), exits,
    literalAdjustedCost: { netRPerTrade: r4(mean(tr.map((x) => x.netLiteral))), tNet: r3(nwT(lit)) },
  };
}
const brief = (s) => ({ trades: s.trades, tradesPerMonth: s.tradesPerMonth, netRPerTrade: s.netRPerTrade, grossRPerTrade: s.grossRPerTrade, tNet: s.tNet, tGross: s.tGross, winRate: s.winRate });

// ══ SELFTEST (synthetic bars; known answers) ════════════════════════════════════════════════════════════════════════════
function selftest() {
  const checks = {};
  const eq = (a, b) => Math.abs(a - b) < 1e-9;
  // synthetic sessions (EST): 09:30 ET = 14:30Z; 78 five-minute bars [o,h,l,c,v]
  const day = (date, bars) => bars.map((b, k) => [Date.parse(`${date}T14:30:00Z`) + k * 300000, b[0], b[1], b[2], b[3], b[4] ?? 1000]);
  const flat = (n, p) => Array.from({ length: n }, () => [p, p + 0.3, p - 0.3, p]);
  const noPrev = () => null;
  const mk = (bars, date = "2024-03-05") => { const S = buildSeries("SYN", day(date, bars), noPrev); S.atr.fill(1); return S; };
  const lvl100 = (S) => ({ LL: new Float64Array(S.N).fill(100), LS: new Float64Array(S.N).fill(100), crossFrom: 0, srcOf: (i) => i });
  const run = (S, mult = 2, opts = {}) => simulate(S, findSetups(S, lvl100(S)).setups, mult, opts);
  // base long: flat below 100 (highs 99.3 never retest a short at 99.9), cross at 10, retest at 12, entry at 13
  const base = () => { const b = flat(78, 99); b[10] = [99, 100.6, 98.9, 100.5]; b[11] = [100.5, 101, 100.3, 100.8]; b[12] = [100.8, 100.9, 100.05, 100.4];
    b[13] = [100.5, 100.7, 100.3, 100.6]; for (let k = 14; k < 78; k++) b[k] = [100.6, 100.8, 100.4, 100.6]; return b; };
  {
    const S = mk(base()), f = findSetups(S, lvl100(S));
    const s = f.setups.find((x) => x.dir === 1);
    checks.crossRetestHoldDetected = f.setups.length === 1 && s && s.c === 10 && s.r === 12 && s.e === 13;
    checks.entryAtOpenOfRPlus1 = s && eq(s.entry, 100.5);
    checks.stopBelowRetestLow = s && eq(s.stop, 100.05 - 0.05) && eq(s.R, 0.5);
    checks.leakFieldsBounded = s && s.maxRead <= s.r;
    const b = base(); b[14] = [100.6, 101.6, 100.4, 101.4];
    const tr = run(mk(b));
    checks.target2R = tr.length === 1 && tr[0].reason === "target" && eq(tr[0].exit, 101.5) && eq(tr[0].gross, 2) && tr[0].sess === "2024-03-05";
    const tr1 = run(mk(b), 1), tr3 = run(mk(b), 3);
    checks.oneAndThreeRVariants = tr1.length === 1 && eq(tr1[0].exit, 101) && tr1[0].xi === 14 && tr3.length === 1 && tr3[0].reason === "time";
    checks.costInR = tr.length === 1 && eq(tr[0].gross - tr[0].net, (0.02 + 0.0002 * (100.5 + 101.5)) / 0.5);
    const trf = simulate(mk(b), findSetups(mk(b), lvl100(mk(b))).setups, 2, { split: () => 4 });
    checks.costPerRawShare = trf.length === 1 && eq(trf[0].gross - trf[0].net, (0.005 + 0.0002 * (100.5 + 101.5)) / 0.5) && eq(trf[0].gross - trf[0].netLiteral, (0.02 + 0.0002 * (100.5 + 101.5)) / 0.5);
  }
  {
    // retest window: touch on c+12 counts, on c+13 does not
    const w = (k) => { const b = flat(78, 99); b[10] = [99, 100.6, 98.9, 100.5]; for (let j = 11; j < 40; j++) b[j] = [100.8, 101, 100.5, 100.8]; b[k] = [100.8, 100.9, 100.05, 100.4]; return b; };
    const a = findSetups(mk(w(22)), lvl100(mk(w(22)))).setups, z = findSetups(mk(w(23)), lvl100(mk(w(23)))).setups;
    checks.retestWithin12Bars = a.length === 1 && a[0].r === 22 && z.filter((x) => x.dir === 1).length === 0;
  }
  {
    // hold void: retest bar closes below L -> no long; close exactly at L -> holds
    const b = base(); b[12] = [100.8, 100.9, 99.5, 99.8]; for (let k = 13; k < 78; k++) b[k] = [99, 99.3, 98.7, 99];
    const f = findSetups(mk(b), lvl100(mk(b)));
    checks.voidWhenRetestClosesBelow = f.setups.filter((x) => x.dir === 1).length === 0 && f.voids.hold === 1;
    const b2 = base(); b2[12] = [100.8, 100.9, 99.9, 100];
    const f2 = findSetups(mk(b2), lvl100(mk(b2)));
    checks.holdAtExactlyL = f2.setups.filter((x) => x.dir === 1 && x.r === 12).length === 1;
    // between-void is implied (a close below L is itself a touch): the first sub-L close is the retest and voids on hold
    const b3 = base(); b3[11] = [100.5, 100.6, 99.4, 99.6]; b3[12] = [99.6, 100.9, 99.5, 100.4];
    const f3 = findSetups(mk(b3), lvl100(mk(b3)));
    checks.betweenVoidImpliedByRetest = f3.setups.filter((x) => x.dir === 1 && x.c === 10).length === 0 && f3.voids.between === 0;
  }
  {
    // gapped r+1 open: R from the actual open
    const b = base(); b[13] = [100.9, 101, 100.8, 100.9];
    const s = findSetups(mk(b), lvl100(mk(b))).setups.find((x) => x.dir === 1);
    checks.rFromActualOpen = s && eq(s.entry, 100.9) && eq(s.R, 0.9);
  }
  {
    // stop first when one bar touches both
    const b = base(); b[14] = [100.6, 101.6, 99.9, 100.6];
    const tr = run(mk(b));
    checks.stopFirstWhenBothTouched = tr.length === 1 && tr[0].reason === "stop" && eq(tr[0].exit, 100) && eq(tr[0].gross, -1);
    // gap through the stop at a later bar's open -> exit at the open
    const b2 = base(); b2[14] = [99.5, 99.8, 99.4, 99.6];
    const tr2 = run(mk(b2));
    checks.stopGapExitsAtOpen = tr2.length === 1 && tr2[0].reason === "stop" && eq(tr2[0].exit, 99.5);
    // the entry bar IS tested (entry at its open); sensitivity switch skips it
    const b3 = base(); b3[13] = [100.5, 100.7, 99.95, 100.6];
    const t3 = run(mk(b3)), t3s = run(mk(b3), 2, { testEntryBar: false });
    checks.entryBarTested = t3.length === 1 && t3[0].xi === 13 && t3[0].reason === "stop" && t3s.length === 1 && t3s[0].xi !== 13;
  }
  {
    // 15:55 flat: entry at the 15:00 bar (idx 66); nothing hit -> exit at the CLOSE of the 15:50 bar (idx 76)
    const b = flat(78, 99); b[63] = [99, 100.6, 98.9, 100.5]; b[64] = [100.5, 101, 100.3, 100.8]; b[65] = [100.8, 100.9, 100.05, 100.4];
    for (let k = 66; k < 78; k++) b[k] = [100.5, 100.8, 100.3, 100.5 + 0.01 * k];
    const S = mk(b), tr = run(S);
    checks.flatAt1555 = tr.length === 1 && tr[0].e === 66 && S.mod[66] === 900 && tr[0].reason === "time" && tr[0].xi === 76 && S.mod[76] === 950 && eq(tr[0].exit, 100.5 + 0.76);
    // retest one bar later -> entry would be 15:05 -> no entry
    const b2 = flat(78, 99); b2[64] = [99, 100.6, 98.9, 100.5]; b2[65] = [100.5, 101, 100.3, 100.8]; b2[66] = [100.8, 100.9, 100.05, 100.4];
    for (let k = 67; k < 78; k++) b2[k] = [100.5, 100.8, 100.3, 100.5];
    const f2 = findSetups(mk(b2), lvl100(mk(b2)));
    checks.noEntryAfter1500 = f2.setups.length === 0 && f2.voids.after1500 === 1;
  }
  {
    // mirrored short: reflect every price about 100 (h <-> l)
    const refl = (b) => b.map(([o, h, l, c]) => [200 - o, 200 - l, 200 - h, 200 - c]);
    const bl = base(); bl[14] = [100.6, 101.6, 100.4, 101.4];
    const S = mk(refl(bl)), f = findSetups(S, lvl100(S)), tr = run(S), trL = run(mk(bl));
    const s = f.setups.find((x) => x.dir === -1);
    checks.mirroredShort = f.setups.length === 1 && s && s.c === 10 && s.r === 12 && eq(s.entry, 99.5) && eq(s.stop, 200 - 100.05 + 0.05) && tr.length === 1 && tr[0].dir === -1 && eq(tr[0].gross, trL[0].gross) && eq(tr[0].exit, 98.5);
  }
  {
    // one open trade per symbol per level: a second setup entering while the first is open (stop 99.45, target 102.6) is skipped
    const b = base(); for (let k = 14; k < 78; k++) b[k] = [100.6, 100.9, 100.3, 100.6]; b[12] = [100.8, 100.9, 99.5, 100.4];
    b[20] = [100.6, 100.7, 99.6, 99.7]; b[21] = [99.7, 100.4, 99.6, 100.3]; b[22] = [100.3, 100.5, 100.08, 100.2]; b[23] = [100.3, 100.6, 100.2, 100.4];
    const S = mk(b), f = findSetups(S, lvl100(S)), tr = run(S);
    const longs = f.setups.filter((x) => x.dir === 1);
    checks.oneOpenTradePerSymbolLevel = longs.length === 2 && tr.length === 1 && tr[0].e === 13;
  }
  {
    // retest does not carry into the next session
    const b1 = flat(78, 99); b1[76] = [99, 100.6, 98.9, 100.5]; b1[77] = [100.5, 101, 100.3, 100.8];
    const b2 = flat(78, 100.8); b2[0] = [100.8, 100.9, 100.05, 100.4];
    const S = buildSeries("SYN2", [...day("2024-03-05", b1), ...day("2024-03-06", b2)], noPrev); S.atr.fill(1);
    checks.retestSameSessionOnly = findSetups(S, lvl100(S)).setups.filter((x) => x.dir === 1).length === 0;
  }
  {
    // day levels: prior-session high/low from the previous calendar session; OR from 09:30-09:55, crosses only from 10:00
    const b1 = flat(78, 99); b1[30] = [99, 101, 98, 99];
    const b2 = flat(78, 99); b2[2] = [99, 99.8, 98.5, 99.1]; b2[4] = [99, 99.2, 98.2, 99];
    const prev = (d) => (d === "2024-03-06" ? "2024-03-05" : null);
    const S = buildSeries("SYN3", [...day("2024-03-05", b1), ...day("2024-03-06", b2)], prev);
    checks.priorDayLevels = eq(S.pdh[78], 101) && eq(S.pdl[78], 98) && S.pdSrc[78] === 77 && Number.isNaN(S.pdh[0]) && Number.isNaN(S.pdh[77]);
    checks.openingRange = Number.isNaN(S.orh[78 + 4]) && eq(S.orh[78 + 5], 99.8) && eq(S.orl[78 + 5], 98.2) && S.orSrc[78 + 6] === 78 + 5 && S.mod[78 + 5] === 595;
    const lv = levelLines(S, "or30");
    const b3 = flat(78, 99); b3[5] = [99, 99.3, 98.7, 99]; b3[6] = [99, 99.6, 98.9, 99.5];   // OR high 99.3; 10:00 bar closes 99.5 -> cross
    const b4 = flat(78, 99); b4[4] = [99, 99.6, 98.9, 99.5];                                 // a 09:50 close above earlier highs is not a cross
    const S3 = buildSeries("SYN4", day("2024-03-06", b3), noPrev), S4 = buildSeries("SYN5", day("2024-03-06", b4), noPrev);
    S3.atr.fill(1); S4.atr.fill(1);
    const cr = (SS) => { const L = levelLines(SS, "or30"); let n = 0; for (let x = 1; x < SS.N; x++) if (SS.sess[x] === SS.sess[x - 1] && SS.mod[x] >= L.crossFrom && SS.c[x] > L.LL[x] && SS.c[x - 1] <= L.LL[x - 1]) n++; return n; };
    checks.orCrossOnlyFrom1000 = lv.crossFrom === 600 && cr(S3) === 1 && cr(S4) === 0;
  }
  {
    // VWAP (typical price, session reset) and EMA seed
    const rows = day("2024-03-05", [[10, 12, 8, 10, 100], [10, 13, 10, 13, 300], ...flat(76, 13)]);
    const S = buildSeries("SYN6", rows, noPrev);
    checks.vwapTypical = eq(S.vwap[0], 10) && eq(S.vwap[1], (10 * 100 + 12 * 300) / 400);
    checks.emaSeed = eq(S.ema[19], (10 + 13 + 13 * 18) / 20) && Number.isNaN(S.ema[18]);
  }
  checks.neweyWest = eq(nwT([1, 2, 3, 4]), 2.5 / Math.sqrt((1.25 + 0.3125) / 4));
  { const a = [{ k: 1, id: "a" }, { k: 1, id: "b" }, { k: 0, id: "c" }]; const s1 = sortTied(a, (x) => x.k, "x"), s2 = sortTied(a, (x) => x.k, "x"); checks.seededTieBreakDeterministic = s1[0].id === "c" && s1.map((x) => x.id).join() === s2.map((x) => x.id).join(); }
  return { pass: Object.values(checks).every(Boolean), checks };
}

// ══ MAIN ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function main() {
  const mode = process.argv[2];
  if (mode === "--fetch") { await fetchAll(); console.log("fetch complete"); return; }
  const st = selftest();
  console.log(`R207 selftest ${st.pass ? "PASS" : "FAIL"} ${JSON.stringify(st.checks)}`);
  if (!st.pass) process.exit(1);
  if (mode === "--selftest") return;
  if (mode !== "--discovery" && mode !== "--read") { console.error("usage: --selftest | --fetch | --discovery | --read"); process.exit(1); }
  const READ = mode === "--read";

  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
  const ENTRY = reg.preregistered.find((x) => x.id === "R207");
  if (!ENTRY) throw new Error("R207 not in registry");
  if (ENTRY.bar.tRequired !== BAR_T) throw new Error("registered bar changed: " + ENTRY.bar.tRequired);
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8"));
  if (READ && seals.tests.R207) { console.error("R207 already sealed — refusing"); process.exit(2); }
  await loadCalendar();
  const prevOf = (d) => PREV.get(d) || null;

  // ── data, series, setups ──
  const SER = {}, SPL = {}, coverage = {}, SET = {}, VOIDS = {};
  for (const L of LEVELS) { SET[L] = {}; VOIDS[L] = {}; }
  let splitMissing = 0;
  for (const sym of UNIVERSE) {
    const rows = loadRows(sym);
    if (!rows.length) { coverage[sym] = { rthBars: 0 }; continue; }
    const byS = new Map(); for (const r of rows) { const d = etOf(r[0]).date; byS.set(d, (byS.get(d) || 0) + 1); }
    const scored = [...byS.keys()].filter((d) => d >= WIN.disc[0]);
    const calScored = [...CAL.keys()].filter((d) => d >= WIN.disc[0] && d <= WIN.hold[1]);
    const full = scored.filter((d) => CAL.get(d)[1] === 960);
    coverage[sym] = { rthBars: rows.length, first: etOf(rows[0][0]).date, last: etOf(rows[rows.length - 1][0]).date, scoredSessions: scored.length,
      calendarSessionsMissing: calScored.filter((d) => !byS.has(d)).length, fullDaysUnder78Bars: full.filter((d) => byS.get(d) < 78).length, fullDaysUnder70Bars: full.filter((d) => byS.get(d) < 70).length };
    SER[sym] = buildSeries(sym, rows, prevOf);
    SPL[sym] = splitFactorFn(sym);
    if (!Number.isFinite(SPL[sym]("2026-08-31"))) splitMissing++;
    const facs = new Set(scored.filter((d, i) => i % 20 === 0).map((d) => SPL[sym](d)));
    coverage[sym].splitFactorsSeen = [...facs].filter(Number.isFinite).sort((a, b) => a - b);
    for (const L of LEVELS) { const f = findSetups(SER[sym], levelLines(SER[sym], L)); SET[L][sym] = f.setups; VOIDS[L][sym] = f.voids; }
  }
  const syms = UNIVERSE.filter((s) => SER[s]);
  const calSessions = [...CAL.keys()].filter((d) => d >= WIN.disc[0] && d <= WIN.hold[1]).length;
  console.log("coverage", JSON.stringify({ symbolsWithData: syms.length, calendarSessions2018to202608: calSessions, splitFactorUnavailable: splitMissing, perSymbol: coverage }));

  // ── leak (b): truncation test ──
  const leakTrunc = { cuts: 0, barsCompared: 0, setupsCompared: 0, mismatches: 0 };
  {
    const rng = mulberry32(fnv("R207-leak"));
    const key = (s) => `${s.dir}|${s.c}|${s.r}|${s.e}|${s.entry}|${s.stop}`;
    for (const sym of ["SPY", "NVDA", "KO"].filter((s) => SER[s])) {
      const rows = loadRows(sym);
      for (let q = 0; q < 3; q++) {
        const cut = Math.floor(rows.length * (0.2 + 0.7 * rng()));
        const Sc = buildSeries(sym, rows.slice(0, cut + 1), prevOf), Sf = SER[sym];
        leakTrunc.cuts++;
        for (let i = 0; i <= cut; i++) {
          leakTrunc.barsCompared++;
          for (const k of ["atr", "ema", "vwap", "pdh", "pdl", "orh", "orl"]) if (!Object.is(Sc[k][i], Sf[k][i])) { leakTrunc.mismatches++; break; }
        }
        for (const L of LEVELS) {
          const a = findSetups(Sc, levelLines(Sc, L)).setups.filter((s) => s.e <= cut).map(key).sort();
          const b = SET[L][sym].filter((s) => s.e <= cut).map(key).sort();
          leakTrunc.setupsCompared += b.length;
          if (a.length !== b.length || a.some((x, i) => x !== b[i])) leakTrunc.mismatches++;
        }
      }
    }
  }
  let leakStatic = 0; for (const L of LEVELS) for (const s of syms) for (const x of SET[L][s]) { leakStatic++; if (!(x.maxRead <= x.r && x.e === x.r + 1)) throw new Error("LEAK static"); }
  const leakOk = leakTrunc.mismatches === 0 && leakTrunc.cuts > 0;
  console.log(`leak: ${leakStatic} setups asserted; truncation ${JSON.stringify(leakTrunc)} -> ${leakOk ? "PASS" : "FAIL"}`);

  // ── family ──
  const splits = READ ? ["disc", "hold"] : ["disc"];
  const runLevel = (L, mult, opts = {}) => { const out = []; for (const s of syms) out.push(...simulate(SER[s], SET[L][s], mult, { ...opts, split: SPL[s], tag: `${L}-${mult}` })); return out; };
  const family = {}, TR = {}, setupStats = {};
  for (const L of LEVELS) {
    const tr2 = runLevel(L, 2), tr1 = runLevel(L, 1), tr3 = runLevel(L, 3), trS = runLevel(L, 2, { testEntryBar: false });
    TR[L] = tr2;
    const v = {}; for (const s of syms) for (const [k, n] of Object.entries(VOIDS[L][s])) v[k] = (v[k] || 0) + n;
    setupStats[L] = { setups: syms.reduce((a, s) => a + SET[L][s].length, 0), voids: v };
    family[L] = {};
    for (const w of splits) {
      const s2 = summarize(tr2, w);
      family[L][w] = { ...s2,
        long: brief(summarize(tr2.filter((x) => x.dir > 0), w)), short: brief(summarize(tr2.filter((x) => x.dir < 0), w)),
        oneR: brief(summarize(tr1, w)), threeR: brief(summarize(tr3, w)),
        sensitivityEntryBarNotTested: brief(summarize(trS, w)) };
      console.log(`${L} ${w}: ${JSON.stringify(family[L][w])}`);
    }
  }
  console.log("setups", JSON.stringify(setupStats));

  // ── bootstrap + peek ──
  const cs = READ ? "hold" : "disc";
  const bootstrap = {}, peek = {};
  for (const L of LEVELS) {
    const g = perSession(TR[L].filter((x) => inWin(x.sess, WIN[cs])), "gross"), mu = mean(g), z = g.map((x) => x - mu), rng = mulberry32(fnv("R207-boot-" + L)), ts = [];
    for (let b = 0; b < 2000; b++) { const s = new Array(z.length); for (let q = 0; q < z.length; q++) s[q] = z[Math.floor(rng() * z.length)]; ts.push(Math.abs(nwT(s))); }
    const med = pctl(ts, 0.5);
    bootstrap[L] = { split: cs, sessions: g.length, draws: 2000, medianAbsT: r3(med), p95AbsT: r3(pctl(ts, 0.95)), fracAbsTge2: r4(ts.filter((x) => x >= 2).length / ts.length), pass: med < 2 };
    const pk = summarize(TR[L].filter((x) => x.reason === "target"), cs);
    peek[L] = { split: cs, trades: pk.trades, sessions: pk.sessionsWithTrades, netRPerTrade: pk.netRPerTrade, tNet: pk.tNet, pass: pk.tNet >= BAR_T };
  }
  const bootOk = Object.values(bootstrap).every((x) => x.pass), peekOk = Object.values(peek).every((x) => x.pass);
  console.log("bootstrap", JSON.stringify(bootstrap), bootOk ? "PASS" : "FAIL");
  console.log("peek", JSON.stringify(peek), peekOk ? "PASS" : "FAIL");
  if (!READ) { console.log(`DISCOVERY sanity only. selftest ${st.pass}, leak ${leakOk}, bootstrap ${bootOk}, peek ${peekOk}. The one read: node backend/r207-cross-retest-hold.js --read`); return; }

  // ── random-entry control: 200 draws ──
  const DRAWS = 200;
  const bucketOf = (m) => (m >= LAST_ENTRY ? 11 : Math.floor((m - 570) / 30));
  const pools = {};                                                              // sym -> Map(month|bucket -> [e])
  for (const s of syms) {
    const S = SER[s], m = new Map();
    for (let e = 1; e < S.N; e++) {
      if (S.sess[e] !== S.sess[e - 1] || S.mod[e] > LAST_ENTRY || !Number.isFinite(S.atr[e - 1])) continue;
      const k = S.sess[e].slice(0, 7) + "|" + bucketOf(S.mod[e]);
      const a = m.get(k); if (a) a.push(e); else m.set(k, [e]);
    }
    pools[s] = m;
  }
  const cells = {};                                                              // level -> [{sym, pk, dir, d:[dAtr...]}]
  for (const L of LEVELS) {
    const by = new Map();
    for (const x of sortTied(TR[L], (t) => `${t.sym}|${String(t.e).padStart(9, "0")}`, `R207-cells-${L}`)) {
      const pk = x.sess.slice(0, 7) + "|" + bucketOf(x.mod), k = `${x.sym}|${pk}|${x.dir}`;
      let c = by.get(k); if (!c) { c = { sym: x.sym, pk, dir: x.dir, key: k, d: [] }; by.set(k, c); }
      c.d.push(x.dAtr);
    }
    cells[L] = sortTied([...by.values()], (c) => c.key, `R207-cellorder-${L}`);
  }
  const rand = {};
  for (const L of LEVELS) rand[L] = { holdT: [], holdMean: [], discT: [], discMean: [], matched: [0, 0] };
  for (let dr = 0; dr < DRAWS; dr++) {
    for (const L of LEVELS) {
      const tr = [];
      for (const cell of cells[L]) {
        const S = SER[cell.sym], pool = pools[cell.sym].get(cell.pk) || [], p = pool.slice(), k = Math.min(cell.d.length, p.length);
        const rng = mulberry32(fnv(`R207-rand|${dr}|${L}|${cell.key}`));
        for (let q = 0; q < k; q++) {
          const j = q + Math.floor(rng() * (p.length - q)); [p[q], p[j]] = [p[j], p[q]];
          const e = p[q], entry = S.o[e], R = cell.d[q] * S.atr[e - 1];
          if (!(R > 0)) continue;
          const stop = entry - cell.dir * R, tgt = entry + cell.dir * 2 * R, ex = exitFrom(S, e, cell.dir, stop, tgt, true);
          if (!ex) continue;
          const gross = cell.dir * (ex[1] - entry) / R;
          tr.push({ sess: S.sess[e], gross, net: gross - costR(entry, ex[1], R, SPL[cell.sym](S.sess[e])), netLiteral: 0 });
        }
        if (dr === 0) { rand[L].matched[0] += k; rand[L].matched[1] += cell.d.length; }
      }
      const h = summarize(tr, "hold"), s = summarize(tr, "disc");
      rand[L].holdT.push(h.tNet); rand[L].holdMean.push(h.sessionMeanNetR); rand[L].discT.push(s.tNet); rand[L].discMean.push(s.sessionMeanNetR);
    }
    if ((dr + 1) % 10 === 0) process.stdout.write(`  random-entry ${dr + 1}/${DRAWS}\r`);
  }
  process.stdout.write("\n");
  const randomEntry = {};
  let randomComplete = true;
  for (const L of LEVELS) {
    const R = rand[L], F = family[L], rk = (arr, x) => r4(arr.filter((y) => y < x).length / arr.length);
    if (R.holdT.length !== DRAWS || R.holdT.some((x) => !Number.isFinite(x)) || R.matched[0] !== R.matched[1]) randomComplete = false;
    randomEntry[L] = { draws: R.holdT.length, drawnEntries: R.matched[0], realTrades: R.matched[1],
      hold: { realTNet: F.hold.tNet, randomTNetP50: r3(pctl(R.holdT, 0.5)), randomTNetP95: r3(pctl(R.holdT, 0.95)), realPercentileT: rk(R.holdT, F.hold.tNet),
        realSessionMeanNetR: F.hold.sessionMeanNetR, randomMeanP50: r4(pctl(R.holdMean, 0.5)), randomMeanP95: r4(pctl(R.holdMean, 0.95)), realPercentileMean: rk(R.holdMean, F.hold.sessionMeanNetR),
        beatsP95: F.hold.tNet > pctl(R.holdT, 0.95) },
      disc: { realTNet: F.disc.tNet, randomTNetP50: r3(pctl(R.discT, 0.5)), randomTNetP95: r3(pctl(R.discT, 0.95)), realPercentileT: rk(R.discT, F.disc.tNet),
        realSessionMeanNetR: F.disc.sessionMeanNetR, randomMeanP50: r4(pctl(R.discMean, 0.5)), randomMeanP95: r4(pctl(R.discMean, 0.95)) } };
  }
  console.log("randomEntry", JSON.stringify(randomEntry));

  // ── verdict + seal ──
  const passing = LEVELS.filter((L) => family[L].hold.tNet >= BAR_T && randomEntry[L].hold.beatsP95);
  const controlsPass = st.pass && leakOk && bootOk && peekOk && randomComplete;
  const verdict = (passing.length ? `PASS (${passing.join(", ")})` : "DID NOT PASS") + ` — holdout net t_NW vs bar ${BAR_T} and random-entry p95: `
    + LEVELS.map((L) => `${L} t ${family[L].hold.tNet} (net ${family[L].hold.netRPerTrade}R/trade, gross ${family[L].hold.grossRPerTrade}R, ${family[L].hold.trades} trades) vs random p95 ${randomEntry[L].hold.randomTNetP95}`).join("; ");
  const today = etOf(Date.now()).date;
  const out = { spec: "r207-cross-retest-hold-v1", test: "R207", asOf: new Date().toISOString(), script: "backend/r207-cross-retest-hold.js", bar: BAR_T, windows: WIN,
    coverage, setupStats, family, randomEntry,
    controls: { selftest: st, leak: { staticSetupsAsserted: leakStatic, truncation: leakTrunc, perSetupAssertion: "every setup: last bar read <= r, entry index r+1 at open[r+1]", pass: leakOk },
      bootstrap: { members: bootstrap, pass: bootOk }, peek: { members: peek, bar: BAR_T, pass: peekOk }, randomEntryComplete: randomComplete, pass: controlsPass },
    passingLevels: passing, verdict, sealed: false };
  if (!controlsPass) {
    out.notSealedBecause = `control failed: selftest ${st.pass}, leak ${leakOk}, bootstrap ${bootOk}, peek ${peekOk}, randomEntryComplete ${randomComplete}`;
    writeJsonAtomic(D("r207-cross-retest-hold.json"), out);
    console.log("CONTROLS FAILED — written, NOT sealed:", out.notSealedBecause, "\nverdict (unsealed):", verdict);
    return;
  }
  out.sealed = true;
  writeJsonAtomic(D("r207-cross-retest-hold.json"), out);
  const seals2 = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8"));
  if (seals2.tests.R207) throw new Error("R207 sealed concurrently — refusing");
  seals2.tests.R207 = { sealedOn: today, unit: "holdout ET sessions with >= 1 trade (mean net R of the session's trades across 33 symbols, per level), t Newey-West lag 1", verdict };
  seals2.lastRun = new Date().toISOString();
  writeJsonAtomic(D("read-seals.json"), seals2);
  const reg2 = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E2 = reg2.preregistered.find((x) => x.id === "R207");
  E2.status = `READ ${today} — ${verdict}`; reg2.asOf = new Date().toISOString();
  writeJsonAtomic(D("test-registry.json"), reg2);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R207", verdict }) + "\n");
  console.log("SEALED:", verdict);
}
if (require.main === module) main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
module.exports = { buildSeries, levelLines, findSetups, exitFrom, simulate, summarize, nwT, selftest };
