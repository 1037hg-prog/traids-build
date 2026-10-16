#!/usr/bin/env node
/**
 * R202 — "G STREET TRADES" ONE-CANDLE EXHAUSTION (registered 2026-09-24 before this file existed; rule frozen in
 * data/test-registry.json, preregistered[id=R202]). A shooting star after a stretched run, short the break of its low,
 * stop one cent over the wick, target 2R; the mirrored hammer long. Family ONE-CANDLE-4 = timeframe {15m, 1h} x side
 * {short (the reel), mirrored long}. Primary: 15-minute shorts, HOLDOUT 2022-01-01..2026-08-31.
 * Bar: holdout primary net t_NW(lag 1) >= 2.237 AND above the RANDOM-CANDLE control's 95th percentile.
 *
 * USAGE
 *   node backend/r202-one-candle.js --selftest    synthetic-bar unit tests only (fill, gap, stop-first, 15:55, expiry, ...)
 *   node backend/r202-one-candle.js --fetch       download + cache SIP 15Min bars under data/training/r202 (resumable)
 *   node backend/r202-one-candle.js --discovery   pipeline sanity on DISCOVERY 2018-2021 only (no holdout number computed)
 *   node backend/r202-one-candle.js --read        THE one read: family (both splits), random-candle (200 draws), bootstrap,
 *                                                 peek, leak; writes data/r202-one-candle.json; seals only if the unit
 *                                                 tests, leak, bootstrap and peek controls pass
 *
 * DATA. Alpaca SIP 15Min, adjustment "split", 2017-10-01..2026-08-31 (Oct-Dec 2017 warm-up only; no trade before 2018-01-02 is
 * scored), via lib/alpaca-bars.js fetchBars (requireAll false; coverage reported). Regular session only: bar START in
 * [open, close) ET per Alpaca /v2/calendar (lib/mine3-minute.js calendar helper, its cached 2015-12-01..2026-08-31 file), so a
 * half-day keeps 09:30-12:45 bars. 1-hour bars are aggregated from the RTH 15-minute bars on the clock hour (ET offsets are
 * whole hours): the 09:00 hour holds only 09:30 and 09:45, so it is a 30-minute bar.
 *
 * IMPLEMENTATION NOTES (literal readings of the rule text, fixed before any result was seen):
 *  N1  Series per timeframe = RTH bars only, continuous across sessions. ATR(14) is Wilder (seed = mean of the first 14 TRs,
 *      then (13*prev + TR)/14); the first bar of a session's TR includes the overnight gap. EMA(9) of closes, seeded with the
 *      SMA of the first 9 closes, alpha 2/10, continuous across sessions. VWAP = cumulative (H+L+C)/3 x V / cumulative V from
 *      the session's first bar, reset every session.
 *  N2  All of Step 1-3 are evaluated at bar s's CLOSE and include bar s itself: "that bar's VWAP" and EMA(9) and ATR(14) are
 *      the values through bar s. "Highest high of the last 10 bars" = h[s] >= max(h[s-9..s-1]) (a tie counts as the highest;
 *      the 10 bars may span the prior session). Step 3's "prior 20 bars" = s-20..s-1 (may span sessions).
 *  N3  Shooting star: range = H-L > 0; body = |C-O|; upper wick = H - max(O,C); lower wick = min(O,C) - L. Requires
 *      upper >= 2*body, upper >= 0.5*range, lower <= 0.25*range. A doji (body 0) qualifies if the wick tests pass. Hammer =
 *      the reflection (lower wick >= 2*body, >= 50% of range; upper <= 25%). Mirror Step 1: VWAP - L >= 2*ATR and
 *      EMA9 - L >= 2*ATR and l[s] <= min(l[s-9..s-1]).
 *  N4  Entry order: placed at bar s's close; sell stop (buy stop) at L-0.01 (H+0.01) of bar s; live on bars s+1..s+3 AND only
 *      within bar s's session (the trade is flat by 15:55, so an intraday stop order never carries overnight). Trigger =
 *      the bar's low <= trigger (high >= for longs); if the bar OPENS at or beyond the trigger, the fill is the open.
 *  N5  "One open trade per symbol": while a position is open, signals are ignored. A signal that appears while an entry order
 *      is still pending (unfilled) REPLACES that order with its own (the newer candle's levels) — within a bar the resting
 *      order is tested for a fill first, so a signal on the bar that fills the old order is ignored.
 *  N6  Stop = H+0.01 of bar s (short) / L-0.01 (long). R = |stop - ACTUAL fill| ("R = stop - entry"), so a gap fill carries
 *      a larger R and the target moves with it. Target = entry -/+ 2R (3R variant: 3R).
 *  N7  Stop and target are tested only on bars AFTER the fill bar. Order within a bar: open beyond stop -> exit at the open;
 *      stop touched -> exit at the stop; open beyond target -> exit at the open; target touched -> exit at the target. So a bar
 *      touching both is a stop. Sensitivity (report only, never a gate): the fill bar also counts as a stop if it touched it.
 *  N8  "Flat at 15:55 ET": 15-minute and 1-hour bars have no boundary at 15:55. The position is closed at the CLOSE of the
 *      session's last bar (the 15:45 15m bar / the 15:00 hour, both end 16:00 — the bar containing 15:55) after that bar's
 *      stop/target test; on a half-day, the close of its last bar (12:45 / 12:00). A fill on the last bar exits at its close.
 *  N9  Cost per trade in R = ($0.02 + 0.0003*entry + 0.0003*exit) / R, per share on the split-adjusted series (literal).
 *  N10 Session = the ET date of the fill bar (always the signal's session, N4). Statistic: per session the mean net R of all
 *      that session's trades across the 33 symbols; t over sessions with >= 1 trade, Newey-West lag 1 (Bartlett:
 *      var = g0 + g1, same formula as r148). Trades per month = trades / calendar months in the window (48 / 56).
 *  N11 Random-candle control: pool = bars meeting Step 1 (same side, same timeframe) whose candle is NOT the shooting star
 *      (hammer) shape; Step 3 volume is not required (the registry names Step 1 + execution only). Per symbol x ET month of
 *      the signal bar, draw WITHOUT replacement as many pool bars as there are real Step 1-3 signal bars that symbol-month
 *      (all of the pool if it is smaller), seeded per draw. The drawn bars are run through the IDENTICAL simulator (N4-N10,
 *      2R). 200 draws per member. Compared on the registered statistic (holdout net t_NW); session-mean net R also reported.
 *  N12 Bootstrap: demean the gross per-session R series, 2000 seeded iid resamples of the same n, t_NW of each; passes if the
 *      median |t| < 2 (fraction >= 2 reported). Peek: target-exit trades only; must reach t_NW >= 2.237. Both are gated on
 *      the HOLDOUT of all four family members (as r178).
 *      AMENDMENT 2026-09-24, found in the --discovery pipeline-sanity run BEFORE any holdout number existed: the 1-hour members
 *      had ZERO target exits in discovery (19 and 53 trades, almost all flat at the close), so their peek series is empty and
 *      the peek cannot be computed at all. A peek with fewer than 3 target-exit sessions is recorded "not computable" and does
 *      not block the seal; every computable member must clear 2.237 and the PRIMARY (15m short) must be computable. The
 *      bootstrap still gates all four. Neither the verdict statistic nor its bar is touched by this.
 *  N13 Leak: (a) asserted per order in the simulator — signal index s is the last bar any condition reads (indicator arrays
 *      are built strictly causally) and the fill index > s; (b) truncation test — the series, indicators and both signal flags
 *      (real, random pool) are rebuilt on data cut at seeded random clock-hour boundaries and every bar at or before the cut
 *      must be identical to the full-data build.
 *  N14 Every draw / resample uses seeded mulberry32 streams (fnv hash of a label). No record sort in this file can tie on its
 *      key (bar indices and session dates are unique); sortTied() still breaks any tie with a seeded random key, never row order.
 *  N15 Discovery 2018-01-02..2021-12-31, holdout 2022-01-01..2026-08-31, by fill session.
 *
 * Paper only; no orders; this file never touches the broker or the server.
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const CACHE = path.join(__dirname, "data", "training", "r202");
const UNIVERSE = ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "AMD", "AVGO", "NFLX", "JPM", "BAC", "XOM", "CVX", "UNH", "LLY", "COST", "WMT", "HD", "V", "MA", "ORCL", "CRM", "ADBE", "INTC", "CSCO", "PEP", "KO", "DIS", "BA"];
const WIN = { disc: ["2018-01-02", "2021-12-31"], hold: ["2022-01-01", "2026-08-31"] };
const MONTHS = { disc: 48, hold: 56 };
const BAR_T = 2.237, TICK = 0.01, CPS = 0.02, SLIP = 0.0003;
const HOUR = 3600000;
const TFS = ["15m", "1h"], SIDES = [-1, 1];
const memberId = (tf, dir) => `${tf}-${dir < 0 ? "short" : "long"}`;

// ── seeded randomness (as r178) ─────────────────────────────────────────────────────────────────────────────────────────
function fnv(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
/** sort with a seeded random tie-break (N14) — never row order. */
function sortTied(arr, keyFn, seedLabel) {
  const r = mulberry32(fnv(seedLabel));
  return arr.map((x) => [keyFn(x), r(), x]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1])).map((z) => z[2]);
}

// ── ET time (offset memoised per UTC hour, as r178) ─────────────────────────────────────────────────────────────────────
const FMT = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const offCache = new Map();
function etOffsetMs(ms) {
  const hk = Math.floor(ms / HOUR);
  let o = offCache.get(hk);
  if (o === undefined) {
    const p = Object.fromEntries(FMT.formatToParts(new Date(hk * HOUR)).map((x) => [x.type, x.value]));
    o = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - hk * HOUR;
    offCache.set(hk, o);
  }
  return o;
}
function etOf(ms) { const d = new Date(ms + etOffsetMs(ms)); return { date: d.toISOString().slice(0, 10), mod: d.getUTCHours() * 60 + d.getUTCMinutes() }; }

// ══ CALENDAR + FETCH ════════════════════════════════════════════════════════════════════════════════════════════════════
const CAL_RANGE = ["2015-12-01", "2026-08-31"];                       // the range mine3 already cached — reused, not refetched
let CAL = null;
async function loadCalendar() {
  if (CAL) return CAL;
  const { calendar } = require("./lib/mine3-minute.js");
  const sessions = await calendar(CAL_RANGE[0], CAL_RANGE[1]);
  CAL = new Map(sessions.map((s) => [s.date, [s.open, s.close]]));
  return CAL;
}
function isRth(ms, cal) { const { date, mod } = etOf(ms); const oc = cal.get(date); return !!oc && mod >= oc[0] && mod < oc[1]; }

async function fetchAll() {
  const { fetchBars } = require("./lib/alpaca-bars.js");
  const cal = await loadCalendar();
  fs.mkdirSync(CACHE, { recursive: true });
  const order = process.argv.includes("--reverse") ? [...UNIVERSE].reverse() : UNIVERSE;   // a second fetch process may walk from the end
  for (const sym of order) {
    for (let y = 2017; y <= 2026; y++) {
      const f = path.join(CACHE, `${sym}-${y}.json`);
      if (fs.existsSync(f)) continue;
      const start = y === 2017 ? "2017-10-01T00:00:00Z" : `${y}-01-01T00:00:00Z`;
      const end = y === 2026 ? "2026-08-31T23:59:59Z" : `${y}-12-31T23:59:59Z`;
      const r = await fetchBars([sym], { start, end, timeframe: "15Min", feed: "sip", adjustment: "split", requireAll: false, quiet: true, retries: 8, minIntervalMs: 500 });
      const raw = r.bars[sym] || [];
      const rows = raw.map((b) => [Date.parse(b.t), b.o, b.h, b.l, b.c, b.v]).filter((x) => isRth(x[0], cal));
      writeJsonAtomic(f, { source: "alpaca sip 15Min adjustment=split, RTH-filtered by /v2/calendar", sym, start, end, fetchedAt: new Date().toISOString(), pages: r.pages, rawBars: raw.length, rows }, { pretty: 0 });
      console.log(`  ${sym} ${y}: ${rows.length} RTH bars of ${raw.length} raw (${r.pages} pages)`);
    }
  }
}
function loadRows(sym) {
  const files = fs.readdirSync(CACHE).filter((f) => f.startsWith(sym + "-") && /^[A-Z]+-\d{4}\.json$/.test(f)).sort();
  const m = new Map();
  for (const f of files) for (const r of JSON.parse(fs.readFileSync(path.join(CACHE, f), "utf8")).rows) m.set(r[0], r);
  return sortTied([...m.values()], (r) => r[0], `R202-rows-${sym}`);  // timestamps unique (map keys)
}

// ══ SERIES + INDICATORS (strictly causal: value[i] reads rows 0..i only) ══════════════════════════════════════════════
function aggregateHourly(rows15) {
  const out = [];
  let cur = null, key = null;
  for (const r of rows15) {
    const k = Math.floor(r[0] / HOUR);
    if (k !== key) { if (cur) out.push(cur); key = k; cur = [r[0], r[1], r[2], r[3], r[4], r[5]]; }
    else { cur[2] = Math.max(cur[2], r[2]); cur[3] = Math.min(cur[3], r[3]); cur[4] = r[4]; cur[5] += r[5]; }
  }
  if (cur) out.push(cur);
  return out;
}
function buildSeries(name, rows) {
  const N = rows.length;
  const t = new Float64Array(N), o = new Float64Array(N), h = new Float64Array(N), l = new Float64Array(N), c = new Float64Array(N), v = new Float64Array(N);
  const mod = new Int16Array(N), sess = new Array(N), last = new Uint8Array(N);
  for (let i = 0; i < N; i++) { const r = rows[i]; t[i] = r[0]; o[i] = r[1]; h[i] = r[2]; l[i] = r[3]; c[i] = r[4]; v[i] = r[5]; const e = etOf(r[0]); mod[i] = e.mod; sess[i] = e.date; }
  for (let i = 0; i < N; i++) last[i] = i === N - 1 || sess[i + 1] !== sess[i] ? 1 : 0;
  // NOTE: last[] of the final row is 1 by construction; the truncation test compares signals, not last[].
  const atr = new Float64Array(N).fill(NaN), ema = new Float64Array(N).fill(NaN), vwap = new Float64Array(N).fill(NaN);
  let acc = 0, es = 0, pv = 0, vv = 0;
  for (let i = 0; i < N; i++) {
    const tr = i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    if (i < 14) { acc += tr; if (i === 13) atr[i] = acc / 14; } else atr[i] = (atr[i - 1] * 13 + tr) / 14;
    if (i < 9) { es += c[i]; if (i === 8) ema[i] = es / 9; } else ema[i] = ema[i - 1] + 0.2 * (c[i] - ema[i - 1]);
    if (i === 0 || sess[i] !== sess[i - 1]) { pv = 0; vv = 0; }
    pv += ((h[i] + l[i] + c[i]) / 3) * v[i]; vv += v[i];
    vwap[i] = vv > 0 ? pv / vv : NaN;
  }
  return { name, N, t, o, h, l, c, v, mod, sess, last, atr, ema, vwap };
}
/** candle shape for side dir: -1 shooting star, +1 hammer (N3) */
function candleShape(o, h, l, c, dir) {
  const range = h - l; if (!(range > 0)) return false;
  const body = Math.abs(c - o), up = h - Math.max(o, c), lo = Math.min(o, c) - l;
  const wick = dir < 0 ? up : lo, other = dir < 0 ? lo : up;
  return wick >= 2 * body && wick >= 0.5 * range && other <= 0.25 * range;
}
/** flags per bar for side dir: step1 (stretch), star (shape), vol (step 3). real = all three; pool = step1 && !star. */
function buildSignals(S, dir) {
  const { N, o, h, l, c, v, atr, ema, vwap } = S;
  const step1 = new Uint8Array(N), star = new Uint8Array(N), vol = new Uint8Array(N), real = new Uint8Array(N), pool = new Uint8Array(N);
  for (let s = 20; s < N; s++) {
    const a = atr[s]; if (!Number.isFinite(a) || !Number.isFinite(ema[s]) || !Number.isFinite(vwap[s])) continue;
    let ext = true;
    for (let k = s - 9; k < s; k++) if (dir < 0 ? h[k] > h[s] : l[k] < l[s]) { ext = false; break; }
    const st = ext && (dir < 0 ? h[s] - vwap[s] >= 2 * a && h[s] - ema[s] >= 2 * a : vwap[s] - l[s] >= 2 * a && ema[s] - l[s] >= 2 * a);
    let vs = 0; for (let k = s - 20; k < s; k++) vs += v[k];
    step1[s] = st ? 1 : 0; star[s] = candleShape(o[s], h[s], l[s], c[s], dir) ? 1 : 0; vol[s] = v[s] >= 1.5 * (vs / 20) ? 1 : 0;
    real[s] = step1[s] && star[s] && vol[s] ? 1 : 0; pool[s] = step1[s] && !star[s] ? 1 : 0;
  }
  return { step1, star, vol, real, pool };
}

// ══ SIMULATOR (event-driven over signal bars; equivalent to a bar scan under N4-N8) ════════════════════════════════════
/**
 * S series; isSig Uint8Array marking signal bars; dir -1 short / +1 long; mult target in R.
 * returns trades [{ sess, s, fi, xi, entry, exit, stop, R, gross, net, reason }]
 */
function simulate(S, isSig, dir, mult, { stopOnFillBar = false, leakCheck = true } = {}) {
  const { N, o, h, l, c, sess, last } = S;
  const trades = [];
  let s = -1, freeFrom = 0;
  const nextSig = (from) => { for (let i = from; i < N; i++) if (isSig[i]) return i; return -1; };
  s = nextSig(0);
  while (s >= 0) {
    if (s < freeFrom) { s = nextSig(freeFrom); continue; }
    const trig = dir < 0 ? l[s] - TICK : h[s] + TICK, stop = dir < 0 ? h[s] + TICK : l[s] - TICK;
    let fi = -1, E = NaN, replacedBy = -1;
    for (let j = s + 1; j <= s + 3 && j < N && sess[j] === sess[s]; j++) {
      if (dir < 0) { if (o[j] <= trig) { fi = j; E = o[j]; } else if (l[j] <= trig) { fi = j; E = trig; } }
      else { if (o[j] >= trig) { fi = j; E = o[j]; } else if (h[j] >= trig) { fi = j; E = trig; } }
      if (fi >= 0) break;
      if (isSig[j]) { replacedBy = j; break; }                          // N5: newer signal replaces the pending order
    }
    if (fi < 0) { s = replacedBy >= 0 ? replacedBy : nextSig(s + 1); continue; }
    if (leakCheck && !(fi > s && sess[fi] === sess[s])) throw new Error(`LEAK ${S.name} fill ${fi} signal ${s}`);
    const R = dir < 0 ? stop - E : E - stop;
    if (!(R > 0)) throw new Error(`non-positive R ${S.name} ${s}`);
    const tgt = E + dir * mult * R;
    let xi = -1, X = NaN, reason = "";
    if (stopOnFillBar && (dir < 0 ? h[fi] >= stop : l[fi] <= stop)) { xi = fi; X = stop; reason = "stop"; }
    else if (last[fi]) { xi = fi; X = c[fi]; reason = "time"; }
    for (let x = fi + 1; xi < 0 && x < N; x++) {
      if (dir < 0) {
        if (o[x] >= stop) { xi = x; X = o[x]; reason = "stop"; }
        else if (h[x] >= stop) { xi = x; X = stop; reason = "stop"; }
        else if (o[x] <= tgt) { xi = x; X = o[x]; reason = "target"; }
        else if (l[x] <= tgt) { xi = x; X = tgt; reason = "target"; }
      } else {
        if (o[x] <= stop) { xi = x; X = o[x]; reason = "stop"; }
        else if (l[x] <= stop) { xi = x; X = stop; reason = "stop"; }
        else if (o[x] >= tgt) { xi = x; X = o[x]; reason = "target"; }
        else if (h[x] >= tgt) { xi = x; X = tgt; reason = "target"; }
      }
      if (xi < 0 && last[x]) { xi = x; X = c[x]; reason = "time"; }
    }
    if (xi < 0) break;                                                    // series ended mid-trade (never for closed windows)
    const gross = dir * (X - E) / R, cost = (CPS + SLIP * (E + X)) / R;
    trades.push({ sess: sess[fi], s, fi, xi, entry: E, exit: X, stop, R, gross, net: gross - cost, reason });
    freeFrom = xi;                                                        // flat after bar xi's test; a signal AT xi may place
    s = nextSig(Math.max(s + 1, freeFrom));
  }
  return trades;
}

// ══ STATISTICS ════════════════════════════════════════════════════════════════════════════════════════════════════════
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
function nwT(a) { const n = a.length; if (n < 3) return NaN; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n, cc = 0; for (let i = 1; i < n; i++) cc += d[i] * d[i - 1]; v += cc / n; return v > 0 ? m / Math.sqrt(v / n) : NaN; }
const r4 = (x) => (Number.isFinite(x) ? +x.toFixed(4) : null), r3 = (x) => (Number.isFinite(x) ? +x.toFixed(3) : null);
const inWin = (s, w) => s >= w[0] && s <= w[1];
function perSession(trades, key) {
  const m = new Map();
  for (const tr of trades) { const a = m.get(tr.sess); if (a) a.push(tr[key]); else m.set(tr.sess, [tr[key]]); }
  return sortTied([...m.entries()], (e) => e[0], "R202-sess").map(([, a]) => mean(a));   // session dates are unique keys
}
function summarize(trades, w) {
  const tr = trades.filter((x) => inWin(x.sess, w)), win = w === WIN.disc ? "disc" : "hold";
  const net = perSession(tr, "net"), gross = perSession(tr, "gross");
  const exits = {}; for (const x of tr) exits[x.reason] = (exits[x.reason] || 0) + 1;
  return {
    trades: tr.length, sessionsWithTrades: net.length, tradesPerMonth: r3(tr.length / MONTHS[win]),
    netRPerTrade: r4(mean(tr.map((x) => x.net))), grossRPerTrade: r4(mean(tr.map((x) => x.gross))), costRPerTrade: r4(mean(tr.map((x) => x.gross - x.net))),
    sessionMeanNetR: r4(mean(net)), sessionMeanGrossR: r4(mean(gross)), tNet: r3(nwT(net)), tGross: r3(nwT(gross)),
    winRate: r4(tr.filter((x) => x.net > 0).length / tr.length), medianRPct: r4(pctl(tr.map((x) => 100 * x.R / x.entry), 0.5)), exits,
  };
}
function pctl(arr, p) { const s = arr.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; }

// ══ SELFTEST (synthetic bars; known answers) ══════════════════════════════════════════════════════════════════════════
function selftest() {
  const checks = {};
  const eq = (a, b) => Math.abs(a - b) < 1e-9;
  // A synthetic session 2024-03-05 (EST): 09:30 ET = 14:30Z. bars: [o,h,l,c] at 15-min steps; volume 1000.
  const day = (date, bars, open = "14:30") => bars.map((b, k) => [Date.parse(`${date}T${open}:00Z`) + k * 900000, b[0], b[1], b[2], b[3], b[4] ?? 1000]);
  const flat = (n, p = 100) => Array.from({ length: n }, () => [p, p + 0.2, p - 0.2, p]);
  const mk = (bars, date = "2024-03-05") => buildSeries("SYN", day(date, bars));
  const sigAt = (N, ...idx) => { const a = new Uint8Array(N); for (const i of idx) a[i] = 1; return a; };
  // signal bar at index 2: H 101, L 99 -> short trigger 98.99, stop 101.01, R = 2.02, target 94.95
  {
    const b = flat(26); b[2] = [100, 101, 99, 99.5]; b[3] = [99.5, 99.6, 98.9, 99.0]; b[4] = [99.0, 99.2, 94.9, 95.0];
    const S = mk(b), tr = simulate(S, sigAt(26, 2), -1, 2);
    checks.fillAtStopPrice = tr.length === 1 && eq(tr[0].entry, 98.99) && tr[0].fi === 3;
    checks.targetTwoR = tr.length === 1 && tr[0].reason === "target" && eq(tr[0].exit, 98.99 - 2 * 2.02) && eq(tr[0].gross, 2);
    checks.costInR = tr.length === 1 && eq(tr[0].gross - tr[0].net, (0.02 + 0.0003 * (98.99 + tr[0].exit)) / 2.02);
    const tr3 = simulate(S, sigAt(26, 2), -1, 3);
    checks.threeRVariantNotReached = tr3.length === 1 && tr3[0].reason === "time";
  }
  {
    const b = flat(26); b[2] = [100, 101, 99, 99.5]; b[3] = [98.5, 98.7, 98.0, 98.2];     // gaps below the trigger
    const S = mk(b), tr = simulate(S, sigAt(26, 2), -1, 2);
    checks.gapFillAtOpen = tr.length === 1 && eq(tr[0].entry, 98.5) && eq(tr[0].R, 101.01 - 98.5);
  }
  {
    const b = flat(26, 99.5); b[2] = [100, 101, 99, 99.5]; b[3] = [99.5, 99.6, 98.9, 99.0]; b[4] = [99.0, 101.5, 94.0, 99];  // both
    const S = mk(b), tr = simulate(S, sigAt(26, 2), -1, 2);
    checks.stopFirstWhenBothTouched = tr.length === 1 && tr[0].reason === "stop" && eq(tr[0].exit, 101.01) && eq(tr[0].gross, -1);
  }
  {
    const b = flat(26, 99.5); b[2] = [100, 101, 99, 99.5]; b[3] = [99.5, 99.6, 98.9, 99.0]; b[4] = [102, 102.5, 101.8, 102];   // gap through stop
    const S = mk(b), tr = simulate(S, sigAt(26, 2), -1, 2);
    checks.stopGapExitsAtOpen = tr.length === 1 && tr[0].reason === "stop" && eq(tr[0].exit, 102);
  }
  {
    const b = flat(26, 99.5); b[2] = [100, 101, 99, 99.5]; b[3] = [99.5, 101.2, 98.9, 99.0];   // fill bar touches stop
    const S = mk(b);
    const tr = simulate(S, sigAt(26, 2), -1, 2), trS = simulate(S, sigAt(26, 2), -1, 2, { stopOnFillBar: true });
    checks.fillBarNotTested = tr.length === 1 && tr[0].reason !== "stop";
    checks.fillBarSensitivity = trS.length === 1 && trS[0].reason === "stop" && trS[0].xi === 3;
  }
  {
    // 15:55: 26 bars 09:30..15:45; fill at 15:30 (idx 24), nothing hit -> exit at close of the 15:45 bar (idx 25)
    const b = flat(26, 99.5); b[23] = [100, 101, 99, 99.5]; b[24] = [99.5, 99.6, 98.9, 99.0]; b[25] = [99.0, 99.3, 98.4, 98.6];
    const S = mk(b), tr = simulate(S, sigAt(26, 23), -1, 2);
    checks.flatAtSessionLastBar = tr.length === 1 && tr[0].reason === "time" && tr[0].xi === 25 && eq(tr[0].exit, 98.6) && S.mod[25] === 945;
  }
  {
    // order lives 3 bars only: fill-able on bar s+4 must NOT fill
    const b = flat(26, 99.5); b[2] = [100, 101, 99, 99.5]; b[6] = [99.5, 99.6, 98.0, 98.5];
    const S = mk(b);
    checks.orderExpiresAfterThreeBars = simulate(S, sigAt(26, 2), -1, 2).length === 0;
    const b2 = flat(26, 99.5); b2[2] = [100, 101, 99, 99.5]; b2[5] = [99.5, 99.6, 98.0, 98.5];
    checks.orderLiveOnThirdBar = simulate(mk(b2), sigAt(26, 2), -1, 2).length === 1;
  }
  {
    // no overnight: signal on the last bar of day 1; day 2 opens below the trigger -> no trade
    const rows = [...day("2024-03-05", (() => { const b = flat(26, 99.5); b[25] = [100, 101, 99, 99.5]; return b; })()), ...day("2024-03-06", flat(26, 97))];
    const S = buildSeries("SYN2", rows);
    checks.noOvernightOrder = simulate(S, sigAt(52, 25), -1, 2).length === 0 && S.sess[26] === "2024-03-06";
  }
  {
    // replacement: signal at 2 (L 99), new signal at 3 (H 101.5 L 99.4) before any fill -> order moves to 99.39
    const b = flat(26, 99.5); b[2] = [100, 101, 99, 99.5]; b[3] = [99.8, 101.5, 99.4, 99.6]; b[4] = [99.6, 99.7, 99.3, 99.35];
    const S = mk(b), tr = simulate(S, sigAt(26, 2, 3), -1, 2);
    checks.newerSignalReplacesPending = tr.length === 1 && tr[0].s === 3 && eq(tr[0].entry, 99.39) && eq(tr[0].stop, 101.51);
  }
  {
    // one open trade: second signal while in position is ignored
    const b = flat(26, 99.5); b[2] = [100, 101, 99, 99.5]; b[3] = [99.5, 99.6, 98.9, 99.0]; b[4] = [99, 99.5, 98.8, 99.2];
    const S = mk(b), tr = simulate(S, sigAt(26, 2, 4), -1, 2);
    checks.oneOpenTradePerSymbol = tr.length === 1 && tr[0].s === 2;
  }
  {
    // long mirror: hammer bar H 101 L 99; buy stop 101.01, stop 98.99, R 2.02, target 105.05
    const b = flat(26, 100.5); b[2] = [100, 101, 99, 100.5]; b[3] = [100.5, 101.2, 100.4, 101.1]; b[4] = [101.1, 105.2, 101, 105];
    const S = mk(b), tr = simulate(S, sigAt(26, 2), 1, 2);
    checks.longMirror = tr.length === 1 && eq(tr[0].entry, 101.01) && tr[0].reason === "target" && eq(tr[0].exit, 101.01 + 4.04);
  }
  // shape tests
  checks.shootingStar = candleShape(100, 103, 99.9, 100.2, -1) && !candleShape(100, 103, 98.5, 100.2, -1) && !candleShape(100, 101, 99, 100.9, -1);
  checks.hammer = candleShape(100.2, 100.3, 97, 100, 1) && !candleShape(100, 101, 99, 100.9, 1);
  checks.dojiStar = candleShape(100, 102, 100, 100, -1);
  // signal detection end to end: a steady climb then a spike shooting star on high volume
  {
    const b = []; let p = 100;
    for (let i = 0; i < 25; i++) { b.push([p, p + 0.1, p - 0.1, p + 0.05]); p += 0.05; }
    const last = b[24][3];
    const rows = day("2024-03-05", [...b, [last, last + 3, last - 0.02, last + 0.1, 5000], [last, last + 0.05, last - 0.5, last - 0.4]]);
    const S = buildSeries("SYN3", rows), sg = buildSignals(S, -1);
    checks.detectsShootingStar = sg.real[25] === 1 && sg.real.reduce((x, y) => x + y, 0) === 1;
    checks.poolExcludesStar = sg.pool[25] === 0;
  }
  // hourly aggregation: 09:30 + 09:45 -> the 09:00 hour; 10:00..10:45 -> the 10:00 hour
  {
    const rows = day("2024-03-05", [[1, 2, 0.5, 1.5, 10], [1.5, 3, 1, 2, 20], [2, 2.5, 1.8, 2.2, 5], [2.2, 2.4, 0.9, 1, 5], [1, 1.1, 1, 1.05, 5], [1.05, 1.2, 1, 1.1, 5]]);
    const hr = aggregateHourly(rows);
    checks.hourlyAggregation = hr.length === 2 && hr[0][1] === 1 && hr[0][2] === 3 && hr[0][3] === 0.5 && hr[0][4] === 2 && hr[0][5] === 30 && hr[1][3] === 0.9 && hr[1][4] === 1.1 && hr[1][5] === 20;
  }
  // NW lag-1 on a known series: [1,2,3,4] -> m 2.5, d [-1.5,-.5,.5,1.5]; g0 = 5/4; g1 = (0.75-0.25+0.75)/4 = 0.3125
  checks.neweyWest = eq(nwT([1, 2, 3, 4]), 2.5 / Math.sqrt((1.25 + 0.3125) / 4));
  // tie-break is seeded, not row order
  { const a = [{ k: 1, id: "a" }, { k: 1, id: "b" }, { k: 0, id: "c" }]; const s1 = sortTied(a, (x) => x.k, "x"), s2 = sortTied(a, (x) => x.k, "x"); checks.seededTieBreakDeterministic = s1[0].id === "c" && s1.map((x) => x.id).join() === s2.map((x) => x.id).join(); }
  return { pass: Object.values(checks).every(Boolean), checks };
}

// ══ MAIN ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function main() {
  const mode = process.argv[2];
  const st = selftest();
  console.log(`R202 selftest ${st.pass ? "PASS" : "FAIL"} ${JSON.stringify(st.checks)}`);
  if (!st.pass) process.exit(1);
  if (mode === "--selftest") return;
  if (mode === "--fetch") { await fetchAll(); console.log("fetch complete"); return; }
  if (mode !== "--discovery" && mode !== "--read") { console.error("usage: --selftest | --fetch | --discovery | --read"); process.exit(1); }
  const READ = mode === "--read";

  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
  const ENTRY = reg.preregistered.find((x) => x.id === "R202");
  if (!ENTRY) throw new Error("R202 not in registry");
  if (ENTRY.bar.tRequired !== BAR_T) throw new Error("registered bar changed: " + ENTRY.bar.tRequired);
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8"));
  if (READ && seals.tests.R202) { console.error("R202 already sealed — refusing"); process.exit(2); }
  await loadCalendar();

  // ── data, series, signals ──
  const SER = { "15m": {}, "1h": {} }, SIG = { "15m": {}, "1h": {} }, coverage = {};
  for (const sym of UNIVERSE) {
    const rows = loadRows(sym);
    if (!rows.length) { coverage[sym] = { rthBars: 0 }; continue; }
    const byS = new Map(); for (const r of rows) { const d = etOf(r[0]).date; byS.set(d, (byS.get(d) || 0) + 1); }
    const scored = [...byS.keys()].filter((d) => d >= WIN.disc[0]);
    const full = scored.filter((d) => CAL.get(d) && CAL.get(d)[1] === 960);
    coverage[sym] = { rthBars: rows.length, first: etOf(rows[0][0]).date, last: etOf(rows[rows.length - 1][0]).date, sessions: byS.size, scoredSessions: scored.length,
      fullDaysUnder26Bars: full.filter((d) => byS.get(d) < 26).length, fullDaysUnder24Bars: full.filter((d) => byS.get(d) < 24).length };
    SER["15m"][sym] = buildSeries(sym, rows);
    SER["1h"][sym] = buildSeries(sym, aggregateHourly(rows));
    for (const tf of TFS) { SIG[tf][sym] = {}; for (const d of SIDES) SIG[tf][sym][d] = buildSignals(SER[tf][sym], d); }
  }
  const calScored = [...CAL.keys()].filter((d) => d >= WIN.disc[0] && d <= WIN.hold[1]).length;
  const syms = UNIVERSE.filter((s) => SER["15m"][s]);
  console.log("coverage", JSON.stringify({ calendarSessions2018to202608: calScored, perSymbol: coverage }));

  // ── leak (b): truncation test ──
  const leakTrunc = { cuts: 0, barsCompared: 0, mismatches: 0 };
  {
    const rng = mulberry32(fnv("R202-leak"));
    for (const sym of ["SPY", "NVDA", "KO"].filter((s) => SER["15m"][s])) {
      const rows = loadRows(sym);
      for (let q = 0; q < 3; q++) {
        let cut = Math.floor(rows.length * (0.2 + 0.7 * rng()));
        while (cut + 1 < rows.length && Math.floor(rows[cut + 1][0] / HOUR) === Math.floor(rows[cut][0] / HOUR)) cut++;   // hour end
        const part = rows.slice(0, cut + 1);
        for (const tf of TFS) {
          const Sc = buildSeries(sym, tf === "15m" ? part : aggregateHourly(part)), Sf = SER[tf][sym];
          for (const d of SIDES) {
            const a = buildSignals(Sc, d), b = SIG[tf][sym][d];
            leakTrunc.cuts++;
            for (let i = 0; i < Sc.N; i++) {
              leakTrunc.barsCompared++;
              if (Sc.t[i] !== Sf.t[i] || a.real[i] !== b.real[i] || a.pool[i] !== b.pool[i] || !Object.is(Sc.atr[i], Sf.atr[i]) || !Object.is(Sc.vwap[i], Sf.vwap[i]) || !Object.is(Sc.ema[i], Sf.ema[i])) leakTrunc.mismatches++;
            }
          }
        }
      }
    }
  }
  const leakOk = leakTrunc.mismatches === 0 && leakTrunc.cuts > 0;
  console.log(`leak truncation ${JSON.stringify(leakTrunc)} -> ${leakOk ? "PASS" : "FAIL"} (per-order assertion active in every simulate call)`);

  // ── signal counts ──
  const signalStats = {};
  for (const tf of TFS) for (const d of SIDES) {
    let s1 = 0, rl = 0, pl = 0;
    for (const sym of syms) { const g = SIG[tf][sym][d]; for (let i = 0; i < g.real.length; i++) { s1 += g.step1[i]; rl += g.real[i]; pl += g.pool[i]; } }
    signalStats[memberId(tf, d)] = { step1Bars: s1, realSignals: rl, randomPool: pl };
  }
  console.log("signals", JSON.stringify(signalStats));

  // ── family ──
  const splits = READ ? ["disc", "hold"] : ["disc"];
  const runMember = (tf, d, pick, mult, opts) => { const out = []; for (const sym of syms) for (const x of simulate(SER[tf][sym], pick(sym), d, mult, opts)) out.push({ sym, ...x }); return out; };
  const family = {}, TR = {};
  for (const tf of TFS) for (const d of SIDES) {
    const id = memberId(tf, d), real = (sym) => SIG[tf][sym][d].real;
    const tr2 = runMember(tf, d, real, 2), tr3 = runMember(tf, d, real, 3), trF = runMember(tf, d, real, 2, { stopOnFillBar: true });
    TR[id] = tr2;
    family[id] = { primary: tf === "15m" && d < 0 };
    for (const w of splits) {
      const s2 = summarize(tr2, WIN[w]), s3 = summarize(tr3, WIN[w]), sF = summarize(trF, WIN[w]);
      family[id][w] = { ...s2, threeR: { netRPerTrade: s3.netRPerTrade, grossRPerTrade: s3.grossRPerTrade, tNet: s3.tNet, winRate: s3.winRate, exits: s3.exits },
        sensitivityStopOnFillBar: { netRPerTrade: sF.netRPerTrade, tNet: sF.tNet } };
      console.log(`${id}${family[id].primary ? " (PRIMARY)" : ""} ${w}: ${JSON.stringify(family[id][w])}`);
    }
  }

  // ── bootstrap + peek ──
  const cs = READ ? "hold" : "disc";
  const bootstrap = {}, peek = {};
  for (const id of Object.keys(TR)) {
    const g = perSession(TR[id].filter((x) => inWin(x.sess, WIN[cs])), "gross"), mu = mean(g), z = g.map((x) => x - mu), rng = mulberry32(fnv("R202-boot-" + id)), ts = [];
    for (let b = 0; b < 2000; b++) { const s = new Array(z.length); for (let q = 0; q < z.length; q++) s[q] = z[Math.floor(rng() * z.length)]; ts.push(Math.abs(nwT(s))); }
    const med = pctl(ts, 0.5);
    bootstrap[id] = { split: cs, sessions: g.length, draws: 2000, medianAbsT: r3(med), p95AbsT: r3(pctl(ts, 0.95)), fracAbsTge2: r4(ts.filter((x) => x >= 2).length / ts.length), pass: med < 2 };
    const pk = summarize(TR[id].filter((x) => x.reason === "target"), WIN[cs]);
    const computable = pk.sessionsWithTrades >= 3 && Number.isFinite(pk.tNet);
    peek[id] = { split: cs, trades: pk.trades, sessions: pk.sessionsWithTrades, netRPerTrade: pk.netRPerTrade, tNet: pk.tNet, computable, pass: computable ? pk.tNet >= BAR_T : null };
  }
  const bootOk = Object.values(bootstrap).every((x) => x.pass), peekOk = peek["15m-short"].computable && Object.values(peek).every((x) => !x.computable || x.pass);
  console.log("bootstrap", JSON.stringify(bootstrap), bootOk ? "PASS" : "FAIL");
  console.log("peek", JSON.stringify(peek), peekOk ? "PASS" : "FAIL");
  if (!READ) { console.log(`DISCOVERY sanity only. leak ${leakOk}, bootstrap ${bootOk}, peek ${peekOk}. The one read: node backend/r202-one-candle.js --read`); return; }

  // ── random-candle control: 200 draws ──
  const DRAWS = 200, rand = {};
  const monthOf = (S, i) => S.sess[i].slice(0, 7);
  const plan = {};                                                        // per member x symbol: [{month, need, poolIdx[]}]
  for (const tf of TFS) for (const d of SIDES) {
    const id = memberId(tf, d); plan[id] = {};
    for (const sym of syms) {
      const S = SER[tf][sym], g = SIG[tf][sym][d], by = new Map();
      for (let i = 0; i < S.N; i++) {
        if (!g.real[i] && !g.pool[i]) continue;
        const m = monthOf(S, i); let e = by.get(m); if (!e) { e = { need: 0, pool: [] }; by.set(m, e); }
        if (g.real[i]) e.need++; if (g.pool[i]) e.pool.push(i);
      }
      plan[id][sym] = sortTied([...by.entries()].filter(([, e]) => e.need > 0), (x) => x[0], `R202-months-${id}-${sym}`).map(([m, e]) => ({ m, need: e.need, pool: e.pool }));
    }
    rand[id] = { holdT: [], holdMean: [], discT: [], discMean: [], drawnVsNeeded: [0, 0] };
  }
  for (let dr = 0; dr < DRAWS; dr++) {
    for (const tf of TFS) for (const d of SIDES) {
      const id = memberId(tf, d), marks = {};
      for (const sym of syms) {
        const S = SER[tf][sym], a = new Uint8Array(S.N);
        for (const e of plan[id][sym]) {
          const rng = mulberry32(fnv(`R202-rand|${dr}|${id}|${sym}|${e.m}`)), p = e.pool.slice(), k = Math.min(e.need, p.length);
          for (let q = 0; q < k; q++) { const j = q + Math.floor(rng() * (p.length - q)); [p[q], p[j]] = [p[j], p[q]]; a[p[q]] = 1; }
          if (dr === 0) { rand[id].drawnVsNeeded[0] += k; rand[id].drawnVsNeeded[1] += e.need; }
        }
        marks[sym] = a;
      }
      const tr = runMember(tf, d, (sym) => marks[sym], 2);
      const h = summarize(tr, WIN.hold), s = summarize(tr, WIN.disc);
      rand[id].holdT.push(h.tNet); rand[id].holdMean.push(h.sessionMeanNetR); rand[id].discT.push(s.tNet); rand[id].discMean.push(s.sessionMeanNetR);
    }
    if ((dr + 1) % 20 === 0) process.stdout.write(`  random-candle ${dr + 1}/${DRAWS}\r`);
  }
  process.stdout.write("\n");
  const randomCandle = {};
  for (const id of Object.keys(rand)) {
    const R = rand[id], L = family[id], rk = (arr, x) => r4(arr.filter((y) => y < x).length / arr.length);
    randomCandle[id] = { draws: DRAWS, drawnSignals: R.drawnVsNeeded[0], realSignals: R.drawnVsNeeded[1],
      hold: { realTNet: L.hold.tNet, randomTNetP50: r3(pctl(R.holdT, 0.5)), randomTNetP95: r3(pctl(R.holdT, 0.95)), realPercentileT: rk(R.holdT, L.hold.tNet),
        realSessionMeanNetR: L.hold.sessionMeanNetR, randomMeanP50: r4(pctl(R.holdMean, 0.5)), randomMeanP95: r4(pctl(R.holdMean, 0.95)), realPercentileMean: rk(R.holdMean, L.hold.sessionMeanNetR),
        beatsP95: L.hold.tNet > pctl(R.holdT, 0.95) },
      disc: { realTNet: L.disc.tNet, randomTNetP50: r3(pctl(R.discT, 0.5)), randomTNetP95: r3(pctl(R.discT, 0.95)), realPercentileT: rk(R.discT, L.disc.tNet),
        realSessionMeanNetR: L.disc.sessionMeanNetR, randomMeanP50: r4(pctl(R.discMean, 0.5)), randomMeanP95: r4(pctl(R.discMean, 0.95)) } };
  }
  console.log("randomCandle", JSON.stringify(randomCandle));

  // ── verdict + seal ──
  const P = family["15m-short"].hold, RC = randomCandle["15m-short"].hold;
  const controlsPass = st.pass && leakOk && bootOk && peekOk;
  const passes = P.tNet >= BAR_T && RC.beatsP95;
  const verdict = (passes ? "PASS" : "DID NOT PASS") + ` — primary 15m shorts holdout net t_NW ${P.tNet} vs bar ${BAR_T} (net ${P.netRPerTrade}R/trade, gross ${P.grossRPerTrade}R, ${P.trades} trades over ${P.sessionsWithTrades} sessions, win ${P.winRate}); `
    + `random-candle p95 t ${RC.randomTNetP95} (median ${RC.randomTNetP50}), real at pct ${RC.realPercentileT}; best other member ${Object.entries(family).filter(([k]) => k !== "15m-short").map(([k, v]) => `${k} t ${v.hold.tNet}`).join(", ")}`;
  const today = etOf(Date.now()).date;
  const out = { spec: "r202-one-candle-v1", test: "R202", asOf: new Date().toISOString(), script: "backend/r202-one-candle.js", bar: BAR_T, windows: WIN,
    coverage, signalStats, family, randomCandle,
    controls: { selftest: st, leak: { truncation: leakTrunc, perOrderAssertion: "every fill asserted: fill index > signal index, same session", pass: leakOk },
      bootstrap: { members: bootstrap, pass: bootOk }, peek: { members: peek, bar: BAR_T, pass: peekOk }, pass: controlsPass },
    verdict, sealed: false };
  if (!controlsPass) {
    out.notSealedBecause = `control failed: selftest ${st.pass}, leak ${leakOk}, bootstrap ${bootOk}, peek ${peekOk}`;
    writeJsonAtomic(D("r202-one-candle.json"), out);
    console.log("CONTROLS FAILED — written, NOT sealed:", out.notSealedBecause, "\nverdict (unsealed):", verdict);
    return;
  }
  out.sealed = true;
  writeJsonAtomic(D("r202-one-candle.json"), out);
  const seals2 = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8"));
  if (seals2.tests.R202) throw new Error("R202 sealed concurrently — refusing");
  seals2.tests.R202 = { sealedOn: today, unit: "holdout ET sessions with >= 1 trade (mean net R of the session's trades across 33 symbols), t Newey-West lag 1", verdict };
  seals2.lastRun = new Date().toISOString();
  writeJsonAtomic(D("read-seals.json"), seals2);
  const reg2 = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E2 = reg2.preregistered.find((x) => x.id === "R202");
  E2.status = `READ ${today} — ${verdict}`; reg2.asOf = new Date().toISOString();
  writeJsonAtomic(D("test-registry.json"), reg2);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R202", verdict }) + "\n");
  console.log("SEALED:", verdict);
}
if (require.main === module) main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
module.exports = { buildSeries, buildSignals, aggregateHourly, simulate, candleShape, summarize, nwT, selftest };
