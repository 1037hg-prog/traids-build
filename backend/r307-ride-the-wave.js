#!/usr/bin/env node
/**
 * R307 — RIDE THE WAVE, BAIL BEFORE THE CREST: long crypto surges with mechanical early exits (TRAIL / FADE / T6).
 * Registered 2026-10-01 in backend/data/test-registry.json — the registry wins over anything written in this file.
 *
 * QUESTION. When a coin surges (a 3-sigma hourly return on 3x volume through its 24 h high), can a long entered at that hour's close
 * be ridden and bailed out of mechanically before the crest, profitably after 0.50% round-trip cost? Three exit cells, best-of-3.
 *
 * RULE (frozen; every parameter from the registration, none tuned here)
 *   UNIVERSE  the 32 non-stablecoin USD pairs Alpaca can trade on 2026-10-01 (parsed from the registry rule text and asserted = 32),
 *             priced from Coinbase Exchange public hourly candles X-USD. A coin Coinbase does not list (404), or any hour before its
 *             first Coinbase candle, simply has no events (reported).
 *   SURGE     on the close of hour t, all inputs from bars <= t: hourly return >= 3 x the trailing 7-day (168 h) hourly-return SD,
 *             AND hourly volume >= 3 x the trailing 7-day median hourly volume, AND close > the prior 24-hour high.
 *             At most one entry per coin per 24 hours. ENTER LONG at the close of hour t (taker).
 *   EXITS     hourly closes from t+1, hard cap 48 h:
 *             TRAIL  first close more than 1.5 x the entry-time 24 h ATR below the highest close since entry;
 *             FADE   first hour whose volume < 1.0 x the trailing 7-day median hourly volume, or TRAIL's stop if that comes first;
 *             T6     the close of t+6.
 *   COST      0.50% round trip per trade (Alpaca crypto taker 0.25%/side; spread not added separately — disclosed).
 *   STATISTIC per UTC day with entries: mean net trade return across all coins entering that day; one-sample t over days;
 *             registered window 2021-01-01..2026-09-30; best-of-3 cells; bar = registry bar.tRequired (2.127).
 *   DECISION  PASS iff better cell t >= bar AND random-entry placebo p95 beaten AND both halves positive.
 *             CANNOT MEASURE iff < 20 coins have Coinbase candles in the window, or < 300 days with entries.
 *
 *   node backend/r307-ride-the-wave.js --fetch      pull + cache candles (r307/<COIN>-USD-<year>.json; BTC/ETH reuse r306), ~3 req/s
 *   node backend/r307-ride-the-wave.js --selftest   known answers on synthetic paths (+ real-data look-ahead checks; --synthetic skips)
 *   node backend/r307-ride-the-wave.js --dry        coverage, surge/entry COUNTS per coin and year (no returns computed)
 *   node backend/r307-ride-the-wave.js --read       the ONE registered read (re-runs the selftest first; refuses if sealed / output exists)
 *
 * NOTES (implementation choices fixed before any return was computed)
 *  N1  Grid: UTC hours 2019-01-01T00 .. 2026-09-30T23 (the pull). Coinbase omits an hour with no trades; such an hour is a no-trade
 *      hour: its carried close is the last trade, its return is 0, its volume is 0 and its true range is 0. One principle, used by
 *      every input below (return SD, volume median, ATR, FADE volume).
 *  N2  Hourly return r_t = close_t / last close at or before t-1, minus 1 (simple). The surge hour itself must have a candle.
 *  N3  Trailing 7 days = the 168 grid hours t-168..t-1 (bar t excluded from its own baseline). SD = sample SD (n-1) of the 168
 *      returns; median = median of the 168 hourly volumes (average of the 84th and 85th). Guard: a surge is evaluated only when the
 *      coin's first candle is at or before t-169 (all 168 returns defined) and >= 84 of the 168 hours have a candle (listing /
 *      relisting / outage guard; it also keeps the median > 0). SD must be > 0. The carried close spans any gap, so the first
 *      return after a long gap (e.g. a delisting and relisting) is the whole gap's move and sits in that coin's SD window for 7 days.
 *  N4  Prior 24-hour high = max high over candles in t-24..t-1 (>= 1 candle needed); the close must be strictly above it.
 *      Return and volume thresholds are inclusive (>=), as registered.
 *  N5  One entry per coin per 24 hours, rolling from the last ENTRY: a surge at t' < t + 24 is not entered (it still counts as a
 *      surge hour for the placebo exclusion). The rule runs on the full pull, so a late-2020 entry can suppress an early-2021 surge.
 *  N6  ATR (entry-time) = mean of the 24 grid-hour true ranges t-23..t (bar t included: it is known at the entry close);
 *      TR = max(high, prior close) - min(low, prior close).
 *  N7  TRAIL: high-water mark starts at the entry close; exit at the first close c_k < HWM - 1.5 x ATR (strict "more than").
 *      FADE: volume at hour k (0 for a no-trade hour) < 1.0 x median of hours k-168..k-1 (the rolling trailing median AT that hour,
 *      inputs <= k) exits at hour k's carried close; TRAIL's stop is checked at the same hour; same hour = same close.
 *      Cap: no exit by t+48 -> exit at the carried close of t+48. T6: carried close of t+6.
 *  N8  Entries whose 48 h cap lies beyond the pull end (t + 48 > 2026-09-30T23) are dropped from every cell and counted.
 *  N9  Return = exit / entry - 1 (long), net = gross - 0.0050. Day = UTC date of the surge bar's start (the bar whose close is the
 *      entry). Day value = mean net over that day's entries (all coins pooled); days without entries do not enter (registered unit).
 *      Entries are identical across cells (only exits differ), so all three cells share the same days.
 *  N10 Better cell = the higher net t (ties: TRAIL, FADE, T6 order).
 *  N11 Placebo. The literal triple (coin, calendar day, hour-of-day) of a real entry IS a surge hour, so it cannot be redrawn as a
 *      non-surge hour; the placebo keeps the coin and the UTC calendar day of each real window entry and draws the hour uniformly
 *      from that coin's hours of that same day that were EVALUATED and did NOT meet the surge rule (suppressed surges excluded too),
 *      with a candle and a full 48 h inside the pull. One placebo entry per real entry (at most one real entry per coin per day,
 *      N5), the same exit rule per cell, the same cost, the same statistic (mean daily net). 500 draws, seeded; the observed cell
 *      mean must exceed the placebo p95. A real entry whose day has no eligible hour has no placebo twin (counted).
 *  N12 Halves: calendar split at the window midpoint (days before 2023-11-16 / from it); the better cell; both mean nets > 0.
 *  N13 Crest: the 48 h peak = highest carried close over t+1..t+48 (a close-based exit can at best reach it); capture = gross
 *      return / peak gain, over trades whose peak is above entry; also with the 48 h highest high, and exit-before/at/after-peak shares.
 *  N14 Concentration: per coin, per year, BTC+ETH-only vs alts; top-10-days share = sum of the 10 largest day values / sum of all
 *      day values (null when the total is not positive; the sums are reported either way).
 *  N15 CANNOT MEASURE checks: coins with >= 1 Coinbase candle in the window >= 20; days with entries in the window >= 300.
 *  N16 Tickers are taken literally as <COIN>-USD (RENDER, POL, SKY: predecessor products RNDR-USD, MATIC-USD, MKR-USD are NOT
 *      substituted — the registration names X-USD; their earlier history is therefore absent, reported in coverage).
 *  N17 Discovery 2019-01-01..2020-12-31 reported only. Research only — no orders anywhere in this file.
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { mean, sd, tOf } = require("./lib/clustered.js");

const D = (f) => path.join(__dirname, "data", f), TRAIN = D("training/r307"), TRAIN306 = D("training/r306"), OUT = D("r307-ride-the-wave.json");
const LISTING = path.join(TRAIN, "_listing.json");
const ID = "R307";
const REG = (require("./data/test-registry.json").preregistered || []).find((x) => x.id === ID);
if (!REG) throw new Error(`${ID} not found in test-registry.json preregistered`);
const BAR = REG.bar.tRequired;
const COINS = (() => {
  const m = /2026-10-01\s+—\s+([A-Z][A-Z ]+[A-Z])\s+—\s+priced/.exec(REG.rule);
  if (!m) throw new Error("universe not parseable from the registry rule text");
  const c = m[1].trim().split(/\s+/);
  if (c.length !== 32 || new Set(c).size !== 32) throw new Error(`universe must be 32 distinct coins, got ${c.length}`);
  return c;
})();
const R306_COINS = ["BTC", "ETH"];

const HOUR = 3600000, DAY = 86400000;
const WIN_H = 168, MIN_PRESENT = 84, HI_H = 24, ATR_H = 24, ONE_PER_H = 24;
const K_SIG = 3, K_VOL = 3, TRAIL_K = 1.5, FADE_K = 1.0, T6_H = 6, CAP_H = 48, COST_RT = 0.005;
const CELLS = ["TRAIL", "FADE", "T6"];
const PULL0 = Date.UTC(2019, 0, 1), PULL1 = Date.UTC(2026, 8, 30, 23);          // inclusive last hour
const NGRID = (PULL1 - PULL0) / HOUR + 1;
const WIN0 = "2021-01-01", WIN1 = "2026-09-30", DISC0 = "2019-01-01", DISC1 = "2020-12-31", HALF_SPLIT = "2023-11-16";
const DRAWS = 500, SEED = 307307;
const MIN_COINS = 20, MIN_DAYS = 300;
const API = "https://api.exchange.coinbase.com", PACE = 340;
const mode = ["--fetch", "--selftest", "--dry", "--read"].find((m) => process.argv.includes(m)) || "--selftest";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const f = (x, k = 4) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(k));
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pctile = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] : null; };
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// ════════════════════════════════════════════════════════════════════════════════ FETCH (public, no key)
async function getJson(url, { allow404 = false } = {}) {
  for (let attempt = 0; attempt <= 8; attempt++) {
    let r;
    try { r = await fetch(url, { headers: { "User-Agent": "traids-r307-research", Accept: "application/json" }, signal: AbortSignal.timeout(30000) }); }
    catch (e) { if (attempt === 8) throw e; await sleep(Math.min(60000, 1000 * 2 ** attempt)); continue; }
    if (r.ok) return await r.json();
    if (r.status === 404 && allow404) return { __404: true, body: (await r.text()).slice(0, 200) };
    if (r.status === 429 || r.status >= 500) { console.log(`  HTTP ${r.status}; backing off`); if (attempt === 8) throw new Error("coinbase " + r.status + " after retries"); await sleep(Math.min(60000, 1000 * 2 ** attempt)); continue; }
    throw new Error("coinbase " + r.status + " " + url + " " + (await r.text()).slice(0, 200));
  }
}
const candlesUrl = (coin, g, s, e) => `${API}/products/${coin}-USD/candles?granularity=${g}&start=${new Date(s).toISOString()}&end=${new Date(e).toISOString()}`;
const readListing = () => (fs.existsSync(LISTING) ? JSON.parse(fs.readFileSync(LISTING, "utf8")) : {});
async function fetchAll() {
  fs.mkdirSync(TRAIN, { recursive: true });
  const listing = readListing(), save = () => writeJsonAtomic(LISTING, listing);
  const DAY_LAST = Date.UTC(2026, 8, 30);
  for (const coin of COINS) {
    if (R306_COINS.includes(coin)) { listing[coin] = { status: "listed", product: `${coin}-USD`, source: "R306 cache backend/data/training/r306 (reused)" }; save(); continue; }
    if (!listing[coin] || !listing[coin].probedAt) {
      const prod = await getJson(`${API}/products/${coin}-USD`, { allow404: true }); await sleep(PACE);
      if (prod.__404) { listing[coin] = { status: "not listed (404)", product: `${coin}-USD`, body: prod.body, probedAt: new Date().toISOString() }; save(); console.log(`  ${coin}: NOT LISTED (404)`); continue; }
      const days = new Set(); let notFound = false;
      for (let s = PULL0; s <= DAY_LAST; s += 300 * DAY) {
        const e = Math.min(s + 299 * DAY, DAY_LAST), j = await getJson(candlesUrl(coin, 86400, s, e), { allow404: true }); await sleep(PACE);
        if (j.__404) { notFound = true; break; }
        if (!Array.isArray(j)) throw new Error("coinbase non-array: " + JSON.stringify(j).slice(0, 200));
        for (const c of j) { const t = c[0] * 1000; if (t >= PULL0 && t <= DAY_LAST) days.add(isoDay(t)); }
      }
      const dl = [...days].sort();
      listing[coin] = notFound ? { status: "not listed (candles 404)", product: `${coin}-USD`, probedAt: new Date().toISOString() }
        : { status: "listed", product: `${coin}-USD`, productStatus: prod.status ?? null, tradingDisabled: prod.trading_disabled ?? null, firstDay: dl[0] || null, lastDay: dl[dl.length - 1] || null,
          candleDays: dl.length, dayList: dl, probedAt: new Date().toISOString() };
      save(); console.log(`  ${coin}: ${listing[coin].status} first ${listing[coin].firstDay} last ${listing[coin].lastDay} days ${listing[coin].candleDays}`);
    }
    const L = listing[coin]; if (L.status !== "listed") continue;
    const daySet = new Set(L.dayList);
    for (let y = 2019; y <= 2026; y++) {
      const file = path.join(TRAIN, `${coin}-USD-${y}.json`);
      if (fs.existsSync(file)) continue;
      const ms0 = Date.UTC(y, 0, 1), ms1 = Math.min(Date.UTC(y + 1, 0, 1), PULL1 + HOUR), seen = new Map(); let req = 0, skipped = 0;
      for (let s = ms0; s < ms1; s += 300 * HOUR) {
        const e = Math.min(s + 299 * HOUR, ms1 - HOUR);                 // end inclusive (R306 probe: 300 rows for start..start+299h)
        let need = false; for (let d = Math.floor(s / DAY) * DAY - DAY; d <= Math.floor(e / DAY) * DAY + DAY; d += DAY) if (daySet.has(isoDay(d))) { need = true; break; }
        if (!need) { skipped++; continue; }                               // no daily candle within +/-1 day: no trades in this chunk
        const j = await getJson(candlesUrl(coin, 3600, s, e)); req++;
        if (!Array.isArray(j)) throw new Error("coinbase non-array: " + JSON.stringify(j).slice(0, 200));
        for (const c of j) { const t = c[0] * 1000; if (t >= ms0 && t < ms1) seen.set(t, [t, c[3], c[2], c[1], c[4], c[5]]); }   // [time, low, high, open, close, volume] -> [t, o, h, l, c, v]
        await sleep(PACE);
      }
      const rows = [...seen.values()].sort((p, q) => p[0] - q[0]), expected = (ms1 - ms0) / HOUR;
      writeJsonAtomic(file, { source: `coinbase exchange ${coin}-USD candles granularity=3600 (public, no key)`, product: `${coin}-USD`, year: y, from: new Date(ms0).toISOString(), toExclusive: new Date(ms1).toISOString(),
        fetchedAt: new Date().toISOString(), requests: req, chunksSkippedNoDailyCandle: skipped, expectedHours: expected, rows }, { pretty: 0 });
      console.log(`  ${coin} ${y}: ${rows.length}/${expected} hours, ${req} requests, ${skipped} empty chunks skipped`);
    }
  }
  console.log("fetch complete");
}

// ════════════════════════════════════════════════════════════════════════════════ SERIES + FEATURES
function blank(coin, t0, n) { return { coin, t0, n, o: new Float64Array(n).fill(NaN), h: new Float64Array(n).fill(NaN), l: new Float64Array(n).fill(NaN), c: new Float64Array(n).fill(NaN), v: new Float64Array(n).fill(NaN), has: new Uint8Array(n) }; }
function loadSeries(coin) {
  const S = blank(coin, PULL0, NGRID), dir = R306_COINS.includes(coin) ? TRAIN306 : TRAIN;
  for (let y = 2019; y <= 2026; y++) {
    const file = path.join(dir, `${coin}-USD-${y}.json`);
    if (!fs.existsSync(file)) throw new Error(`missing cache ${file} — run --fetch`);
    for (const [t, o, h, l, c, v] of JSON.parse(fs.readFileSync(file, "utf8")).rows) {
      const i = (t - PULL0) / HOUR; if (!Number.isInteger(i) || i < 0 || i >= NGRID) continue;
      S.o[i] = o; S.h[i] = h; S.l[i] = l; S.c[i] = c; S.v[i] = v; S.has[i] = 1;
    }
  }
  return features(S);
}
/** synthetic series for the selftest: bars = [{o,h,l,c,v} | null] */
function mkSeries(bars, t0 = PULL0, coin = "SYN") {
  const S = blank(coin, t0, bars.length);
  bars.forEach((b, i) => { if (!b) return; S.o[i] = b.o; S.h[i] = b.h; S.l[i] = b.l; S.c[i] = b.c; S.v[i] = b.v; S.has[i] = 1; });
  return features(S);
}
/** bars a..b of S re-gridded from S.t0 + a hours (everything outside deleted) */
function sliceSeries(S, a, b) {
  const St = blank(S.coin, S.t0 + a * HOUR, b - a + 1);
  for (let i = a; i <= b; i++) if (S.has[i]) { const j = i - a; St.o[j] = S.o[i]; St.h[j] = S.h[i]; St.l[j] = S.l[i]; St.c[j] = S.c[i]; St.v[j] = S.v[i]; St.has[j] = 1; }
  return features(St);
}
function lowerBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
/** every per-hour input; index t uses bars <= t only (med/sdr/hi24 use bars <= t-1, atr/ret use bars <= t) */
function features(S) {
  const n = S.n, lc = new Float64Array(n).fill(NaN), ret = new Float64Array(n).fill(NaN), vol0 = new Float64Array(n), tr = new Float64Array(n), pc = new Int32Array(n + 1);
  let last = NaN, first = -1;
  for (let i = 0; i < n; i++) { if (S.has[i]) { last = S.c[i]; if (first < 0) first = i; } lc[i] = last; }
  for (let i = 0; i < n; i++) {
    if (i > 0 && Number.isFinite(lc[i]) && Number.isFinite(lc[i - 1])) ret[i] = lc[i] / lc[i - 1] - 1;
    vol0[i] = S.has[i] ? S.v[i] : 0;
    if (S.has[i]) { const p = i > 0 ? lc[i - 1] : NaN; tr[i] = Number.isFinite(p) ? Math.max(S.h[i], p) - Math.min(S.l[i], p) : S.h[i] - S.l[i]; }
    pc[i + 1] = pc[i] + S.has[i];
  }
  const med = new Float64Array(n).fill(NaN);
  if (n > WIN_H) {
    const w = Array.from(vol0.subarray(0, WIN_H)).sort((a, b) => a - b);
    for (let t = WIN_H; t < n; t++) {
      med[t] = (w[WIN_H / 2 - 1] + w[WIN_H / 2]) / 2;
      w.splice(lowerBound(w, vol0[t - WIN_H]), 1);
      w.splice(lowerBound(w, vol0[t]), 0, vol0[t]);
    }
  }
  const sdr = new Float64Array(n).fill(NaN), hi24 = new Float64Array(n).fill(NaN), atr = new Float64Array(n).fill(NaN), state = new Uint8Array(n);
  for (let t = 0; t < n; t++) {
    if (t >= ATR_H - 1) { let s = 0; for (let j = t - ATR_H + 1; j <= t; j++) s += tr[j]; atr[t] = s / ATR_H; }
    if (first < 0 || t < first + WIN_H + 1) continue;
    let m = 0; for (let j = t - WIN_H; j < t; j++) m += ret[j]; m /= WIN_H;
    let q = 0; for (let j = t - WIN_H; j < t; j++) q += (ret[j] - m) ** 2;
    sdr[t] = Math.sqrt(q / (WIN_H - 1));
    let hh = -Infinity; for (let j = t - HI_H; j < t; j++) if (S.has[j] && S.h[j] > hh) hh = S.h[j];
    if (hh > -Infinity) hi24[t] = hh;
    if (!S.has[t] || pc[t] - pc[t - WIN_H] < MIN_PRESENT || !(sdr[t] > 0) || !Number.isFinite(hi24[t]) || !Number.isFinite(med[t])) continue;
    state[t] = ret[t] >= K_SIG * sdr[t] && vol0[t] >= K_VOL * med[t] && S.c[t] > hi24[t] ? 2 : 1;   // 0 not evaluated, 1 evaluated-not-surge, 2 surge
  }
  Object.assign(S, { lc, ret, vol0, tr, pc, med, sdr, hi24, atr, state, first });
  return S;
}
const dayOf = (S, h) => isoDay(S.t0 + h * HOUR);
function entriesOf(S) { const E = []; let last = -Infinity; for (let t = 0; t < S.n; t++) if (S.state[t] === 2 && t >= last + ONE_PER_H) { E.push(t); last = t; } return E; }

// ════════════════════════════════════════════════════════════════════════════════ EXITS (bars t+1.. only)
function exitsAt(S, t) {
  const E = S.c[t], dist = TRAIL_K * S.atr[t], leg = (k, px, reason) => ({ k, hold: k - t, px, gross: px / E - 1, net: px / E - 1 - COST_RT, reason });
  const out = {};
  let H = E, done = null;
  for (let k = t + 1; k <= t + CAP_H; k++) if (S.has[k]) { if (S.c[k] < H - dist) { done = leg(k, S.c[k], "trail"); break; } if (S.c[k] > H) H = S.c[k]; }
  out.TRAIL = done || leg(t + CAP_H, S.lc[t + CAP_H], "cap");
  H = E; done = null;
  for (let k = t + 1; k <= t + CAP_H; k++) {
    const trail = S.has[k] === 1 && S.c[k] < H - dist, fade = S.vol0[k] < FADE_K * S.med[k];
    if (trail || fade) { done = leg(k, S.lc[k], trail && fade ? "both" : trail ? "trail" : "fade"); break; }
    if (S.has[k] && S.c[k] > H) H = S.c[k];
  }
  out.FADE = done || leg(t + CAP_H, S.lc[t + CAP_H], "cap");
  out.T6 = leg(t + T6_H, S.lc[t + T6_H], "t6");
  return out;
}
function crestAt(S, t) {
  const E = S.c[t]; let pk = -Infinity, pkH = -1, hh = -Infinity;
  for (let k = t + 1; k <= t + CAP_H; k++) { if (S.lc[k] > pk) { pk = S.lc[k]; pkH = k; } if (S.has[k] && S.h[k] > hh) hh = S.h[k]; }
  return { peakGain: pk / E - 1, peakHour: pkH - t, peakHighGain: hh > -Infinity ? hh / E - 1 : null };
}
function makeTrade(S, t) { return { coin: S.coin, t, day: dayOf(S, t), entry: S.c[t], atr: S.atr[t], cells: exitsAt(S, t), crest: crestAt(S, t) }; }

// ════════════════════════════════════════════════════════════════════════════════ STATISTICS
function dayStats(trades, cell) {
  const by = new Map();
  for (const x of trades) { const L = x.cells[cell]; let a = by.get(x.day); if (!a) by.set(x.day, (a = [])); a.push(L); }
  const days = [...by.keys()].sort(), dm = days.map((d) => mean(by.get(d).map((L) => L.net))), dg = days.map((d) => mean(by.get(d).map((L) => L.gross)));
  const legs = trades.map((x) => x.cells[cell]), nets = legs.map((L) => L.net), reasons = {};
  for (const L of legs) reasons[L.reason] = (reasons[L.reason] || 0) + 1;
  return { n: days.length, trades: legs.length, meanNet: dm.length ? mean(dm) : null, tNet: tOf(dm), meanGross: dg.length ? mean(dg) : null, tGross: tOf(dg),
    winRate: nets.length ? nets.filter((x) => x > 0).length / nets.length : null, dayWinRate: dm.length ? dm.filter((x) => x > 0).length / dm.length : null,
    avgHoldHours: legs.length ? mean(legs.map((L) => L.hold)) : null, meanTradeNet: nets.length ? mean(nets) : null, medianTradeNet: median(nets), exitReasons: reasons, days, dm };
}
const pub = (s) => ({ tNet: f(s.tNet, 3), meanNet: f(s.meanNet, 6), n: s.n, trades: s.trades, winRate: f(s.winRate, 4), avgHoldHours: f(s.avgHoldHours, 2),
  dayWinRate: f(s.dayWinRate, 4), meanGross: f(s.meanGross, 6), tGross: f(s.tGross, 3), meanTradeNet: f(s.meanTradeNet, 6), medianTradeNet: f(s.medianTradeNet, 6), exitReasons: s.exitReasons });
const slim = (s) => ({ tNet: f(s.tNet, 3), meanNet: f(s.meanNet, 6), days: s.n, trades: s.trades, winRate: f(s.winRate, 4), meanGross: f(s.meanGross, 6) });
function top10(s) {
  const tot = s.dm.reduce((a, x) => a + x, 0), top = [...s.dm].sort((a, b) => b - a).slice(0, 10), ts = top.reduce((a, x) => a + x, 0);
  const idx = s.dm.map((x, i) => [x, s.days[i]]).sort((a, b) => b[0] - a[0]).slice(0, 10).map(([x, d]) => ({ day: d, net: f(x, 6) }));
  return { share: tot > 0 ? ts / tot : null, top10Sum: ts, totalSum: tot, meanWithoutTop10: s.dm.length > 10 ? (tot - ts) / (s.dm.length - 10) : null, top10Days: idx };
}
function decide({ coinsWithWindowCandles, days, tNet, beats, firstHalf, secondHalf, bar, better }) {
  if (!(coinsWithWindowCandles >= MIN_COINS)) return `CANNOT MEASURE — only ${coinsWithWindowCandles} coins have Coinbase candles in the registered window (fewer than ${MIN_COINS})`;
  if (!(days >= MIN_DAYS)) return `CANNOT MEASURE — ${days} days with entries in the registered window (fewer than ${MIN_DAYS})${better ? ` [cell ${better}]` : ""}`;
  return tNet != null && tNet >= bar && beats === true && firstHalf != null && secondHalf != null && firstHalf > 0 && secondHalf > 0 ? "PASS" : "DID NOT PASS";
}

// ════════════════════════════════════════════════════════════════════════════════ ANALYSIS (pure: series in, output object out)
function coverageOf(S, listingRow) {
  const w0 = (Date.parse(WIN0 + "T00:00:00Z") - S.t0) / HOUR, w1 = (Date.parse(WIN1 + "T23:00:00Z") - S.t0) / HOUR;
  const present = S.pc[w1 + 1] - S.pc[w0], fi = S.first, li = (() => { for (let i = S.n - 1; i >= 0; i--) if (S.has[i]) return i; return -1; })();
  const since = fi < 0 ? 0 : w1 - Math.max(w0, fi) + 1;
  let bad = 0; for (let i = 0; i < S.n; i++) if (S.has[i] && !(S.h[i] >= Math.max(S.o[i], S.c[i]) - 1e-12 * Math.abs(S.c[i]) && S.l[i] <= Math.min(S.o[i], S.c[i]) + 1e-12 * Math.abs(S.c[i]) && S.v[i] >= 0)) bad++;
  return { status: listingRow ? listingRow.status : "listed", productStatus: listingRow ? listingRow.productStatus ?? null : null, firstCandle: fi >= 0 ? new Date(S.t0 + fi * HOUR).toISOString() : null,
    lastCandle: li >= 0 ? new Date(S.t0 + li * HOUR).toISOString() : null, windowHoursPresent: present, windowPct: f(present / (w1 - w0 + 1), 5),
    windowPctSinceFirst: since > 0 ? f((S.pc[w1 + 1] - S.pc[Math.max(w0, fi)]) / since, 5) : null, hasWindowCandles: present > 0, badCandles: bad };
}
function analyze(series, listing, { bar, draws = DRAWS, seed = SEED, log = () => {} } = {}) {
  const t0 = Date.now(), coinsListed = Object.keys(series);
  const all = [], perCoinEntries = {}; let droppedNoExit = 0, surgeHours = 0, suppressed = 0, spacingViolations = 0;
  for (const coin of coinsListed) {
    const S = series[coin], E = entriesOf(S); let nS = 0; for (let t = 0; t < S.n; t++) if (S.state[t] === 2) nS++;
    surgeHours += nS; suppressed += nS - E.length;
    for (let i = 1; i < E.length; i++) if (E[i] - E[i - 1] < ONE_PER_H) spacingViolations++;
    perCoinEntries[coin] = { surgeHours: nS, entries: E.length };
    for (const t of E) { if (t + CAP_H > S.n - 1) { droppedNoExit++; continue; } all.push(makeTrade(S, t)); }
  }
  log(`  trades built ${((Date.now() - t0) / 1000).toFixed(1)}s (${all.length})`);
  const inWin = (x) => x.day >= WIN0 && x.day <= WIN1, inDisc = (x) => x.day >= DISC0 && x.day <= DISC1;
  const win = all.filter(inWin);
  const cells = {}; for (const c of CELLS) cells[c] = dayStats(win, c);
  const better = [...CELLS].sort((x, y) => (cells[y].tNet ?? -Infinity) - (cells[x].tNet ?? -Infinity))[0], B = cells[better];

  // ---- placebo (N11)
  const dayIdx = new Map(); for (const x of win) if (!dayIdx.has(x.day)) dayIdx.set(x.day, dayIdx.size);
  const pools = []; let noPool = 0, poolSurgeViolations = 0, poolHours = 0;
  for (const x of win) {
    const S = series[x.coin], d0 = Math.floor(x.t / 24) * 24, hrs = [];
    for (let h = d0; h < d0 + 24; h++) if (S.state[h] === 1 && S.has[h] && h + CAP_H <= S.n - 1) hrs.push(h);
    for (const h of hrs) if (S.state[h] === 2 || h === x.t || dayOf(S, h) !== x.day) poolSurgeViolations++;
    if (!hrs.length) { noPool++; continue; }
    poolHours += hrs.length;
    const nets = CELLS.map(() => new Float64Array(hrs.length));
    hrs.forEach((h, j) => { const ex = exitsAt(S, h); CELLS.forEach((c, ci) => { nets[ci][j] = ex[c].net; }); });
    pools.push({ d: dayIdx.get(x.day), nets, len: hrs.length });
  }
  const rng = mulberry32(seed), nD = dayIdx.size, drawsBy = CELLS.map(() => []);
  for (let k = 0; k < draws; k++) {
    const sums = new Float64Array(nD * 3), cnt = new Int32Array(nD);
    for (const p of pools) { const j = Math.floor(rng() * p.len); cnt[p.d]++; for (let ci = 0; ci < 3; ci++) sums[p.d * 3 + ci] += p.nets[ci][j]; }
    for (let ci = 0; ci < 3; ci++) { let s = 0, m = 0; for (let d = 0; d < nD; d++) if (cnt[d]) { s += sums[d * 3 + ci] / cnt[d]; m++; } drawsBy[ci].push(m ? s / m : null); }
  }
  const plc = {}; CELLS.forEach((c, ci) => { const dd = drawsBy[ci].filter((x) => x != null); const p95 = pctile(dd, 0.95);
    plc[c] = { p95, p50: pctile(dd, 0.5), observed: cells[c].meanNet, beats: cells[c].meanNet != null && p95 != null && cells[c].meanNet > p95 }; });
  log(`  placebo done ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // ---- halves, per coin, per year, BTC+ETH vs alts, concentration, crest, discovery
  const halvesOf = (c) => { const a = dayStats(win.filter((x) => x.day < HALF_SPLIT), c), b = dayStats(win.filter((x) => x.day >= HALF_SPLIT), c);
    return { first: { meanNet: f(a.meanNet, 6), tNet: f(a.tNet, 3), days: a.n, trades: a.trades, winRate: f(a.winRate, 4), from: WIN0, through: "2023-11-15" },
      second: { meanNet: f(b.meanNet, 6), tNet: f(b.tNet, 3), days: b.n, trades: b.trades, winRate: f(b.winRate, 4), from: HALF_SPLIT, through: WIN1 }, raw: [a.meanNet, b.meanNet] }; };
  const hv = {}; for (const c of CELLS) hv[c] = halvesOf(c);
  const halves = { first: hv[better].first, second: hv[better].second, cell: better, bothPositive: hv[better].raw[0] != null && hv[better].raw[1] != null && hv[better].raw[0] > 0 && hv[better].raw[1] > 0 };
  const halvesByCell = {}; for (const c of CELLS) halvesByCell[c] = { first: hv[c].first, second: hv[c].second, bothPositive: hv[c].raw[0] > 0 && hv[c].raw[1] > 0 };
  const covAll = {}; for (const coin of COINS) covAll[coin] = series[coin] ? coverageOf(series[coin], listing[coin]) : { status: listing[coin] ? listing[coin].status : "no data", hasWindowCandles: false };
  const perCoin = {}; for (const coin of COINS) { const tw = win.filter((x) => x.coin === coin); perCoin[coin] = { status: covAll[coin].status, firstCandle: covAll[coin].firstCandle || null, windowPct: covAll[coin].windowPct ?? null,
    surgeHoursAll: perCoinEntries[coin] ? perCoinEntries[coin].surgeHours : 0, entriesAll: perCoinEntries[coin] ? perCoinEntries[coin].entries : 0, tradesWindow: tw.length };
    for (const c of CELLS) perCoin[coin][c] = slim(dayStats(tw, c)); }
  const perYear = {}; for (let y = 2019; y <= 2026; y++) { const ty = all.filter((x) => x.day.startsWith(String(y))); perYear[y] = { period: y <= 2020 ? "discovery (reported only)" : "registered window" }; for (const c of CELLS) perYear[y][c] = slim(dayStats(ty, c)); }
  const isBE = (x) => R306_COINS.includes(x.coin), btcEthOnly = { coins: R306_COINS }, alts = { coins: COINS.filter((c) => !R306_COINS.includes(c)) };
  for (const c of CELLS) { btcEthOnly[c] = slim(dayStats(win.filter(isBE), c)); alts[c] = slim(dayStats(win.filter((x) => !isBE(x)), c)); }
  const conc = {}; for (const c of CELLS) { const t = top10(cells[c]); conc[c] = { share: f(t.share, 4), top10Sum: f(t.top10Sum, 6), totalSum: f(t.totalSum, 6), meanWithoutTop10: f(t.meanWithoutTop10, 6), top10Days: t.top10Days }; }
  const crestCapture = {}, crestDetail = {};
  for (const c of CELLS) {
    const up = win.filter((x) => x.crest.peakGain > 0), cap = up.map((x) => x.cells[c].gross / x.crest.peakGain), capH = win.filter((x) => x.crest.peakHighGain > 0).map((x) => x.cells[c].gross / x.crest.peakHighGain);
    const before = up.filter((x) => x.cells[c].hold < x.crest.peakHour).length, at = up.filter((x) => x.cells[c].hold === x.crest.peakHour).length;
    crestCapture[c] = f(median(cap), 4);
    crestDetail[c] = { medianCaptureOfPeakClose: f(median(cap), 4), meanCaptureOfPeakClose: f(cap.length ? mean(cap) : null, 4), medianCaptureOfPeakHigh: f(median(capH), 4),
      tradesPeakAboveEntry: up.length, tradesNeverAboveEntry: win.length - up.length, shareExitBeforePeak: f(up.length ? before / up.length : null, 4), shareExitAtPeak: f(up.length ? at / up.length : null, 4),
      shareExitAfterPeak: f(up.length ? (up.length - before - at) / up.length : null, 4), medianHoursToPeak: median(up.map((x) => x.crest.peakHour)), medianHoldHours: median(win.map((x) => x.cells[c].hold)),
      medianPeakGain: f(median(win.map((x) => x.crest.peakGain)), 5) };
  }
  const discovery = { window: `${DISC0}..${DISC1}`, note: "reported only, never used for the verdict" }; for (const c of CELLS) discovery[c] = pub(dayStats(all.filter(inDisc), c));
  const coinsWithWindowCandles = COINS.filter((c) => covAll[c].hasWindowCandles).length;
  const verdictScript = decide({ coinsWithWindowCandles, days: B.n, tNet: B.tNet, beats: plc[better].beats, firstHalf: hv[better].raw[0], secondHalf: hv[better].raw[1], bar, better });
  const ptx = (x) => (x == null ? "n/a" : (100 * x).toFixed(3) + "%");
  return {
    id: ID, name: REG.name, asOf: new Date().toISOString(), script: "backend/r307-ride-the-wave.js", statistic: REG.statistic, unit: "days", window: `${WIN0}..${WIN1}`,
    tNet: f(B.tNet, 3), meanNet: f(B.meanNet, 6), n: B.n, cell: better, winRate: f(B.winRate, 4), dayWinRate: f(B.dayWinRate, 4), trades: B.trades, avgHoldHours: f(B.avgHoldHours, 2), meanGross: f(B.meanGross, 6), tGross: f(B.tGross, 3),
    bar: { tRequired: bar, variants: REG.bar.variants, source: REG.bar.source },
    cells: Object.fromEntries(CELLS.map((c) => [c, pub(cells[c])])),
    placebo: { p95: f(plc[better].p95, 6), p50: f(plc[better].p50, 6), observed: f(plc[better].observed, 6), beats: plc[better].beats, draws, cell: better, seed,
      kind: "random entries (N11): same coin + same UTC day as each real window entry, hour drawn uniformly from that day's evaluated NON-surge hours (candle present, full 48 h inside the pull); same exits per cell, same cost, mean daily net",
      realEntriesWithoutPool: noPool, meanPoolHours: f(pools.length ? poolHours / pools.length : null, 2), poolSurgeViolations },
    placeboByCell: Object.fromEntries(CELLS.map((c) => [c, { p95: f(plc[c].p95, 6), p50: f(plc[c].p50, 6), observed: f(plc[c].observed, 6), beats: plc[c].beats }])),
    halves, halvesByCell, perCoin, perYear, btcEthOnly, alts,
    top10DaysShare: conc[better].share, concentration: { cell: better, byCell: conc },
    crestCapture, crestDetail, discovery,
    coverage: { coins: covAll, coinsInUniverse: COINS.length, coinsWithWindowCandles, coinsWithWindowTrades: COINS.filter((c) => perCoin[c].tradesWindow > 0).length,
      notListed: COINS.filter((c) => !series[c]), minCoinsRequired: MIN_COINS, minDaysRequired: MIN_DAYS },
    diagnostics: { surgeHoursAll: surgeHours, surgesSuppressedBy24hRule: suppressed, entriesAll: all.length + droppedNoExit, entriesDroppedNoExit: droppedNoExit, tradesWindow: win.length, tradesDiscovery: all.filter(inDisc).length,
      entrySpacingViolations: spacingViolations, runSeconds: f((Date.now() - t0) / 1000, 1) },
    verdictScript,
    verdictReasons: { better, tNetVsBar: `${f(B.tNet, 3)} vs ${bar}`, passT: B.tNet != null && B.tNet >= bar, placeboBeaten: plc[better].beats, halvesBothPositive: halves.bothPositive,
      coinsWithWindowCandles, daysWithEntries: B.n },
    costModel: "0.50% round trip per trade (Alpaca crypto taker 0.25%/side); spread not added separately (registered, disclosed); gross beside net",
    dataSources: ["Coinbase Exchange public hourly candles <COIN>-USD (api.exchange.coinbase.com, granularity 3600, no key); BTC/ETH reused from backend/data/training/r306, the rest cached in backend/data/training/r307 one file per coin per year; pull 2019-01-01..2026-09-30"],
    notes: [
      "Implementation choices N1-N17 are fixed in the header of backend/r307-ride-the-wave.js and were written before any return was computed.",
      "Win rate = share of trades with net > 0 (beside the mean); dayWinRate = share of entry-days with a positive mean net.",
      `Headline: ${better} mean ${ptx(B.meanNet)}/day net, win rate ${B.winRate == null ? "n/a" : (100 * B.winRate).toFixed(1) + "%"}, t ${f(B.tNet, 3)} vs bar ${bar}.`,
      "Placebo (N11): the registered triple 'same coin, same calendar day, same hour-of-day' is by construction the surge hour itself, so the hour is redrawn within the same coin-day from hours that did NOT meet the surge rule; disclosed reading, not a substitution of the control's purpose.",
      "Tickers literal <COIN>-USD (N16): RENDER/POL/SKY have no predecessor-ticker history here.",
      "Survivorship (registered weakness): today's Alpaca list; pumped-and-delisted coins are missing, which flatters a long-surge rule.",
      `Entries dropped for lack of a 48 h exit inside the pull: ${droppedNoExit}. Placebo pools containing a surge hour (must be 0): ${poolSurgeViolations}. Entry spacing violations (must be 0): ${spacingViolations}.`,
      "Research only; no orders.",
    ],
  };
}

// ════════════════════════════════════════════════════════════════════════════════ SELFTEST
/** alternating oscillation around a level: bar i close = level x (1.005 if i odd else 1); h/l 0.05% outside the body; volume 10 */
function osc(N, levels = [{ from: 0, level: 100 }], vol = 10) {
  const lv = (i) => { let L = levels[0].level; for (const x of levels) if (i >= x.from) L = x.level; return L; };
  const bars = []; let prev = null;
  for (let i = 0; i < N; i++) { const c = lv(i) * (i % 2 ? 1.005 : 1), o = prev == null ? c : prev; bars.push({ o, h: Math.max(o, c) * 1.0005, l: Math.min(o, c) * 0.9995, c, v: vol }); prev = c; }
  return bars;
}
function selftest({ real = true } = {}) {
  let fail = 0; const chk = (name, ok, extra = "") => { console.log(`  ${ok ? "OK  " : "FAIL"} ${name} ${extra}`); if (!ok) fail++; };
  console.log(`  registry: ${COINS.length} coins; bar ${BAR}; surge ${K_SIG} sd / ${K_VOL}x vol / >24h high; TRAIL ${TRAIL_K} ATR(${ATR_H}); FADE ${FADE_K}x median; T6 ${T6_H}h; cap ${CAP_H}h; cost ${COST_RT}`);
  chk("universe parsed from the registry = 32 coins incl. BTC, ETH, ONDO", COINS.length === 32 && COINS[0] === "BTC" && COINS[1] === "ETH" && COINS[31] === "ONDO");

  // ---- 1. surge trigger and each condition (independent SD arithmetic)
  const T = 250, base = () => osc(300);
  const sdIndep = (bars, t) => { const r = []; for (let j = t - 168; j < t; j++) r.push(bars[j].c / bars[j - 1].c - 1); const m = r.reduce((a, x) => a + x, 0) / r.length; return Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / (r.length - 1)); };
  const plant = (bars, t, ret, v) => { const p = bars[t - 1].c, c = p * (1 + ret); bars[t] = { o: p, h: c * 1.0005, l: p * 0.9995, c, v }; if (bars[t + 1]) bars[t + 1].o = c; return bars; };
  {
    const b = plant(base(), T, 0.03, 30), S = mkSeries(b);
    chk("surge: +3% on 3.0x volume through the 24h high -> surge (volume threshold inclusive)", S.state[T] === 2, `(state ${S.state[T]}, sd ${f(S.sdr[T], 6)}, med ${S.med[T]})`);
    chk("surge: median of the 168 prior volumes = 10; SD matches an independent computation", S.med[T] === 10 && Math.abs(S.sdr[T] - sdIndep(b, T)) < 1e-15);
    const b2 = plant(base(), T, 0.03, 29.9); chk("surge: 2.99x volume -> no surge", mkSeries(b2).state[T] === 1);
    const s3 = sdIndep(base(), T), b3 = plant(base(), T, 3 * s3 * (1 - 1e-9), 30), b4 = plant(base(), T, 3 * s3 * (1 + 1e-9), 30);
    chk("surge: return just below 3 sd -> no; just above -> yes", mkSeries(b3).state[T] === 1 && mkSeries(b4).state[T] === 2, `(3sd ${f(3 * s3, 6)})`);
    const b5 = plant(base(), T, 0.03, 30); b5[T - 24] = { ...b5[T - 24], h: 104 };
    chk("surge: a 104 high at t-24 (inside the prior 24h) blocks a 103.5 close", mkSeries(b5).state[T] === 1);
    const b6 = plant(base(), T, 0.03, 30); b6[T - 25] = { ...b6[T - 25], h: 104 };
    chk("surge: the same high at t-25 (outside) does not block", mkSeries(b6).state[T] === 2);
    const b7 = plant(base(), T, 0.03, 30); b7[T] = { ...b7[T], h: 110 };
    chk("surge: bar t's own high is not part of the prior 24h high", mkSeries(b7).state[T] === 2);
    const b8 = plant(base(), 150, 0.03, 30); chk("surge: hour 150 (< first candle + 169) is never evaluated", mkSeries(b8).state[150] === 0);
    const b9 = plant(base(), 169, 0.03, 30), S9 = mkSeries(b9); chk("surge: hour 169 (exactly 168 returns defined) is evaluated", S9.state[169] === 2 && S9.state[168] === 0);
    const b10 = plant(base(), T, 0.03, 30); for (let j = T - 168; j < T - 83; j++) b10[j] = null;               // 85 empty -> 83 present
    chk("surge: < 84 of the 168 trailing hours with candles -> not evaluated", mkSeries(b10).state[T] === 0);
    const b11 = plant(base(), T, 0.03, 30); for (let j = T - 168; j < T - 84; j++) b11[j] = null;              // 84 empty -> 84 present
    const S11 = mkSeries(b11); chk("surge: exactly 84 present -> evaluated; empty hours count as volume 0 (median = (0+10)/2)", S11.state[T] !== 0 && S11.med[T] === 5, `(med ${S11.med[T]})`);
    const b12 = plant(base(), T, 0.03, 30); b12[T - 1] = null; const S12 = mkSeries(b12);
    chk("surge: return measured from the last close at or before t-1 when t-1 has no candle", Math.abs(S12.ret[T] - (b12[T].c / b12[T - 2].c - 1)) < 1e-15);
  }
  // ---- 2. one entry per coin per 24 h (rolling from the last ENTRY)
  {
    const b = osc(400, [{ from: 0, level: 100 }, { from: 250, level: 110 }, { from: 260, level: 121 }, { from: 274, level: 133 }, { from: 280, level: 146 }, { from: 300, level: 161 }]);
    for (const t of [250, 260, 274, 280, 300]) b[t].v = 100;
    const S = mkSeries(b), E = entriesOf(S);
    chk("1-per-24h: surges at 250, 260, 274, 280, 300 (all meet the rule)", [250, 260, 274, 280, 300].every((t) => S.state[t] === 2), `(${[250, 260, 274, 280, 300].map((t) => S.state[t]).join(",")})`);
    chk("1-per-24h: entries = 250, 274, 300 (260 < 250+24, 280 < 274+24 suppressed; 274 = 250+24 allowed)", E.join(",") === "250,274,300", `(${E.join(",")})`);
    // placebo pool on this path: entry 250's day is hours 240..263; 260 (a suppressed surge) must never be drawable
    const d0 = 240, hrs = []; for (let h = d0; h < d0 + 24; h++) if (S.state[h] === 1 && S.has[h] && h + CAP_H <= S.n - 1) hrs.push(h);
    chk("placebo pool: same UTC day, excludes the entry hour 250 and the suppressed surge 260", hrs.length === 22 && !hrs.includes(250) && !hrs.includes(260) && hrs.every((h) => dayOf(S, h) === dayOf(S, 250)), `(${hrs.length} hours)`);
    const rng = mulberry32(1); let bad = 0; for (let k = 0; k < 5000; k++) { const h = hrs[Math.floor(rng() * hrs.length)]; if (S.state[h] === 2) bad++; }
    chk("placebo draws: 5000 draws never land on a surge hour", bad === 0);
  }
  // ---- 3. exits on synthetic paths (entry t = 200, ATR = 1 exactly, stop distance 1.5)
  const exitPath = (closes, vols, { missing = [] } = {}) => {
    const b = []; for (let i = 0; i < 300; i++) b.push({ o: 100, h: 100.5, l: 99.5, c: 100, v: 10 });
    closes.forEach((c, j) => { const k = 201 + j, p = b[k - 1].c; b[k] = { o: p, h: Math.max(p, c), l: Math.min(p, c), c, v: vols[j] ?? 30 }; });
    for (let k = 201 + closes.length; k < 300; k++) { const p = b[k - 1].c; b[k] = { o: p, h: p, l: p, c: p, v: vols[closes.length] ?? 30 }; }
    for (const k of missing) b[k] = null;
    return mkSeries(b);
  };
  {
    const S = exitPath([101, 102, 103, 102, 101.5, 101.4, 99], [30, 25, 9, 30, 30, 30, 30]);
    chk("ATR at entry = 1 exactly (24 true ranges of 1.0)", S.atr[200] === 1);
    const ex = exitsAt(S, 200);
    chk("TRAIL: HWM 103, stop 101.5; 101.5 is not 'more than' 1.5 below; exit at t+6 close 101.4", ex.TRAIL.k === 206 && ex.TRAIL.px === 101.4 && ex.TRAIL.reason === "trail", `(${ex.TRAIL.k} ${ex.TRAIL.px} ${ex.TRAIL.reason})`);
    chk("FADE: volume 9 < median 10 at t+3 -> exit at t+3 close 103", ex.FADE.k === 203 && ex.FADE.px === 103 && ex.FADE.reason === "fade", `(${ex.FADE.k} ${ex.FADE.px} ${ex.FADE.reason})`);
    chk("T6: exit at the close of t+6", ex.T6.k === 206 && ex.T6.px === 101.4);
    chk("cost: net = gross - 0.50%", Math.abs(ex.TRAIL.net - (101.4 / 100 - 1 - 0.005)) < 1e-15 && Math.abs(ex.TRAIL.gross - 0.014) < 1e-12);
    const cr = crestAt(S, 200);
    chk("crest: peak close 103 at +3h; TRAIL captures 1.4/3 of the peak gain", Math.abs(cr.peakGain - 0.03) < 1e-12 && cr.peakHour === 3 && Math.abs(ex.TRAIL.gross / cr.peakGain - 1.4 / 3) < 1e-9);
    const S2 = exitPath([101, 102, 103, 102, 101.5, 101.4, 99], [30, 25, 30, 30, 30, 30, 30]), ex2 = exitsAt(S2, 200);
    chk("FADE falls back to TRAIL's stop when volume stays up (exit t+6, reason trail)", ex2.FADE.k === 206 && ex2.FADE.px === 101.4 && ex2.FADE.reason === "trail", `(${ex2.FADE.k} ${ex2.FADE.reason})`);
    const S3 = exitPath([101, 102, 103], [30, 30, 30], { missing: [202] }), ex3 = exitsAt(S3, 200);
    chk("FADE: a no-trade hour (volume 0) exits at the carried close (t+2 -> 101)", ex3.FADE.k === 202 && ex3.FADE.px === 101 && ex3.FADE.reason === "fade");
    const S4 = exitPath([101, 102, 103, 104, 105, 106, 107], [], { missing: [206] }), ex4 = exitsAt(S4, 200);
    chk("T6 on a no-trade hour = carried close of t+5 (105)", ex4.T6.k === 206 && ex4.T6.px === 105);
    const up = Array.from({ length: 60 }, (_, j) => +(100 + 0.1 * (j + 1)).toFixed(1)), S5 = exitPath(up, []), ex5 = exitsAt(S5, 200);
    chk("48h cap: steady rise -> TRAIL and FADE exit at t+48 close 104.8 (reason cap); T6 at 100.6", ex5.TRAIL.k === 248 && ex5.TRAIL.px === 104.8 && ex5.TRAIL.reason === "cap" && ex5.FADE.k === 248 && ex5.FADE.reason === "cap" && ex5.T6.px === 100.6, `(${ex5.TRAIL.k} ${ex5.TRAIL.px} ${ex5.FADE.k} ${ex5.T6.px})`);
    const ex6 = exitsAt(exitPath([101, 102, 103, 102, 101.5, 101.4, 99], [30, 25, 9, 30, 30, 30, 30]), 200);
    let same = true; const Sx = exitPath([101, 102, 103, 102, 101.5, 101.4, 99], [30, 25, 9, 30, 30, 30, 30]); for (let k = 207; k < 300; k++) { Sx.c[k] = 1; Sx.lc[k] = 1; Sx.v[k] = 0; Sx.vol0[k] = 0; }
    const ex7 = exitsAt(Sx, 200); for (const c of CELLS) if (ex7[c].k !== ex6[c].k || ex7[c].px !== ex6[c].px) same = false;
    chk("exits use bars t+1..exit only: wrecking every bar after t+6 changes nothing", same);
  }
  // ---- 4. day clustering
  {
    const L = (net) => ({ net, gross: net + 0.005, hold: 1, reason: "x" });
    const tr = [{ day: "2021-01-01", cells: { T6: L(0.01) } }, { day: "2021-01-01", cells: { T6: L(0.03) } }, { day: "2021-01-02", cells: { T6: L(-0.01) } }, { day: "2021-01-03", cells: { T6: L(0.04) } }];
    const s = dayStats(tr, "T6"), dm = [0.02, -0.01, 0.04], m = (0.02 - 0.01 + 0.04) / 3, sdd = Math.sqrt(dm.reduce((a, x) => a + (x - m) ** 2, 0) / 2);
    chk("day clustering: 4 trades -> 3 days, mean of day means, t over days, trade win rate 0.75", s.n === 3 && s.trades === 4 && Math.abs(s.meanNet - m) < 1e-15 && Math.abs(s.tNet - m / (sdd / Math.sqrt(3))) < 1e-12 && s.winRate === 0.75);
    const t10 = top10({ dm: [5, 4, 3, 2, 1, 1, 1, 1, 1, 1, 1, -1], days: Array.from({ length: 12 }, (_, i) => "d" + i) });
    chk("top-10-days share = 20/20 with the 11th day +1 and 12th -1 -> 1.0", Math.abs(t10.share - 1) < 1e-12 && t10.top10Sum === 20 && t10.totalSum === 20);
  }
  // ---- 5. decision rule
  {
    const base = { coinsWithWindowCandles: 25, days: 400, tNet: 2.2, beats: true, firstHalf: 0.001, secondHalf: 0.002, bar: 2.127 };
    chk("decision: all hurdles -> PASS", decide(base) === "PASS");
    chk("decision: t 2.126 -> DID NOT PASS", decide({ ...base, tNet: 2.126 }) === "DID NOT PASS");
    chk("decision: placebo not beaten -> DID NOT PASS", decide({ ...base, beats: false }) === "DID NOT PASS");
    chk("decision: a half at exactly 0 -> DID NOT PASS (must be positive)", decide({ ...base, secondHalf: 0 }) === "DID NOT PASS");
    chk("decision: 19 coins -> CANNOT MEASURE", decide({ ...base, coinsWithWindowCandles: 19 }).startsWith("CANNOT MEASURE"));
    chk("decision: 299 days -> CANNOT MEASURE; 300 measurable", decide({ ...base, days: 299 }).startsWith("CANNOT MEASURE") && decide({ ...base, days: 300 }) === "PASS");
  }
  // ---- 6. end-to-end analyze() on synthetic coins over the full grid (shape + invariants; values meaningless)
  {
    const synth = (name, sv) => { const rng = mulberry32(sv), bars = []; let p = 100;
      for (let i = 0; i < NGRID; i++) { const jump = rng() < 0.004, r = (rng() - 0.5) * 0.01 + (jump ? 0.04 : 0), o = p; p *= 1 + r;
        bars.push(rng() < 0.01 ? null : { o, h: Math.max(o, p) * (1 + rng() * 0.002), l: Math.min(o, p) * (1 - rng() * 0.002), c: p, v: (jump ? 8 : 1) * (5 + rng() * 5) }); }
      return mkSeries(bars, PULL0, name); };
    const series = { BTC: synth("BTC", 11), SOL: synth("SOL", 22), ONDO: synth("ONDO", 33) }, out = analyze(series, {}, { bar: BAR, draws: 20 });
    const need = ["tNet", "meanNet", "n", "unit", "cell", "cells", "placebo", "halves", "perCoin", "perYear", "btcEthOnly", "top10DaysShare", "crestCapture", "discovery", "coverage", "verdictScript", "notes"];
    chk("analyze: every output field present", need.every((k) => k in out), `(missing ${need.filter((k) => !(k in out)).join(",") || "none"})`);
    chk("analyze: cells TRAIL/FADE/T6 carry tNet, meanNet, n, trades, winRate, avgHoldHours", CELLS.every((c) => ["tNet", "meanNet", "n", "trades", "winRate", "avgHoldHours"].every((k) => k in out.cells[c])));
    chk("analyze: the three cells share the same days and trades (entries are cell-independent)", new Set(CELLS.map((c) => out.cells[c].n + "|" + out.cells[c].trades)).size === 1 && out.n > 300, `(n ${out.n})`);
    chk("analyze: placebo has p95/observed/beats/draws, pools never contain a surge hour", ["p95", "observed", "beats", "draws"].every((k) => k in out.placebo) && out.placebo.poolSurgeViolations === 0 && out.placebo.draws === 20);
    chk("analyze: entry spacing violations 0; 3 coins -> CANNOT MEASURE (fewer than 20 coins)", out.diagnostics.entrySpacingViolations === 0 && out.verdictScript.startsWith("CANNOT MEASURE") && out.coverage.coinsWithWindowCandles === 3, `(${out.verdictScript})`);
    chk("analyze: halves first/second with meanNet,tNet,days; crestCapture per cell", ["first", "second"].every((k) => out.halves[k] && "meanNet" in out.halves[k] && "tNet" in out.halves[k] && "days" in out.halves[k]) && CELLS.every((c) => c in out.crestCapture));
  }

  // ---- real data: coverage, fast == slow median/SD, truncate-the-future, exits unchanged by later bars
  if (real) {
    const listing = readListing(); let have = true;
    for (const coin of COINS) { if (R306_COINS.includes(coin)) continue; const L = listing[coin]; if (!L || !L.probedAt) have = false; else if (L.status === "listed") for (let y = 2019; y <= 2026; y++) if (!fs.existsSync(path.join(TRAIN, `${coin}-USD-${y}.json`))) have = false; }
    if (!have) { console.log("  (real-data checks skipped: cache incomplete — run --fetch)"); fail++; }
    else for (const coin of ["BTC", "SOL", "DOGE", "XTZ"].filter((c) => listing[c] && listing[c].status === "listed")) {
      const S = loadSeries(coin), rng = mulberry32(307 + coin.length * 13);
      let dm = 0, ds = 0; for (let k = 0; k < 40; k++) { const t = S.first + 200 + Math.floor(rng() * (S.n - S.first - 300));
        const v = []; for (let j = t - WIN_H; j < t; j++) v.push(S.has[j] ? S.v[j] : 0); if (median(v) !== S.med[t]) dm++;
        if (Number.isFinite(S.sdr[t])) { const r = []; for (let j = t - WIN_H; j < t; j++) r.push(S.lc[j] / S.lc[j - 1] - 1); if (Math.abs(sd(r) - S.sdr[t]) > 1e-12 * Math.max(1e-6, S.sdr[t])) ds++; } }
      chk(`${coin}: rolling median and SD == direct recomputation at 40 random hours`, dm === 0 && ds === 0, `(${dm}, ${ds})`);
      const E = entriesOf(S), probes = [];
      for (let k = 0; k < 6 && E.length; k++) probes.push(E[Math.floor(rng() * E.length)]);
      for (let k = 0; k < 6; k++) probes.push(S.first + 300 + Math.floor(rng() * (S.n - S.first - 400)));
      let la = 0, lx = 0, nx = 0;
      for (const T of probes) {
        const St = sliceSeries(S, 0, T);                                   // every bar > T deleted
        for (const k of ["state", "sdr", "med", "hi24", "atr", "ret"]) if (!(St[k][T] === S[k][T] || (Number.isNaN(St[k][T]) && Number.isNaN(S[k][T])))) la++;
      }
      for (const t of E) {
        if (t + CAP_H > S.n - 1) continue; const ex = exitsAt(S, t), kMax = Math.max(...CELLS.map((c) => ex[c].k));
        if (CELLS.some((c) => !(ex[c].k > t))) nx++;
        const a = Math.max(0, t - 400), St = sliceSeries(S, a, kMax), ey = exitsAt(St, t - a);   // bars after the latest exit (and before t-400) deleted
        for (const c of CELLS) if (ey[c].k + a !== ex[c].k || ey[c].px !== ex[c].px) lx++;
      }
      chk(`${coin}: surge inputs at hour T unchanged when every bar > T is deleted (${probes.length} probes incl. entries)`, la === 0, `(${la} diffs)`);
      chk(`${coin}: every exit after t, and unchanged when every bar after the latest exit is deleted (${E.length} entries)`, lx === 0 && nx === 0, `(${lx}, ${nx})`);
      let sp = 0; for (let i = 1; i < E.length; i++) if (E[i] - E[i - 1] < ONE_PER_H) sp++; chk(`${coin}: entries >= 24 h apart`, sp === 0);
    }
  }
  console.log(fail ? `SELFTEST FAILED (${fail})` : "SELFTEST PASSED");
  return fail === 0;
}

// ════════════════════════════════════════════════════════════════════════════════ DRY (coverage + counts only, no returns)
function loadAll() {
  const listing = readListing(), series = {};
  for (const coin of COINS) { const L = listing[coin]; if (R306_COINS.includes(coin) || (L && L.status === "listed")) { const S = loadSeries(coin); if (S.first >= 0) series[coin] = S; } }
  return { listing, series };
}
function dry() {
  const { listing, series } = loadAll(), yrs = {}, dayset = new Set(); let withWin = 0;
  for (const coin of COINS) {
    if (!series[coin]) { console.log(`${coin.padEnd(7)} ${listing[coin] ? listing[coin].status : "no listing probe"}`); continue; }
    const S = series[coin], cov = coverageOf(S, listing[coin]), E = entriesOf(S); let nS = 0, nEval = 0; for (let t = 0; t < S.n; t++) { if (S.state[t] === 2) nS++; if (S.state[t]) nEval++; }
    const ew = E.filter((t) => { const d = dayOf(S, t); return d >= WIN0 && d <= WIN1 && t + CAP_H <= S.n - 1; });
    for (const t of ew) dayset.add(dayOf(S, t)); if (cov.hasWindowCandles) withWin++;
    const py = {}; for (const t of E) { const y = dayOf(S, t).slice(0, 4); py[y] = (py[y] || 0) + 1; } for (const [y, k] of Object.entries(py)) yrs[y] = (yrs[y] || 0) + k;
    console.log(`${coin.padEnd(7)} first ${cov.firstCandle ? cov.firstCandle.slice(0, 10) : "-"} winPct ${(100 * cov.windowPct).toFixed(1)}% sinceFirst ${cov.windowPctSinceFirst == null ? "-" : (100 * cov.windowPctSinceFirst).toFixed(1) + "%"} evalHours ${nEval} surgeHours ${nS} entries ${E.length} windowEntries ${ew.length}  ${JSON.stringify(py)}`);
  }
  console.log(`coins with window candles ${withWin}/32; window days with entries ${dayset.size}; entries per year ${JSON.stringify(yrs)}`);
}

// ════════════════════════════════════════════════════════════════════════════════ READ (once)
function read() {
  const seals = fs.existsSync(D("read-seals.json")) ? JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")) : {};
  if ((seals.tests && (seals.tests[ID] || seals.tests[ID.slice(1)])) || fs.existsSync(OUT)) throw new Error(`${ID} already read — read-once`);
  if (!selftest({ real: true })) throw new Error("selftest failed — no read");
  const t0 = Date.now(), { listing, series } = loadAll();
  console.log(`  loaded ${Object.keys(series).length} coins in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const out = analyze(series, listing, { bar: BAR, draws: DRAWS, seed: SEED, log: console.log });
  if (out.placebo.poolSurgeViolations !== 0 || out.diagnostics.entrySpacingViolations !== 0) throw new Error("invariant broken (placebo pool / entry spacing) — no write");
  out.readAt = new Date().toISOString();
  writeJsonAtomic(OUT, out);
  const pc = (x) => (x == null ? "n/a" : (100 * x).toFixed(3) + "%");
  console.log(`${ID}: ${out.verdictScript}`);
  for (const c of CELLS) { const s = out.cells[c]; console.log(`  ${c}: days ${s.n} trades ${s.trades} meanNet ${pc(s.meanNet)}/day winRate ${s.winRate} hold ${s.avgHoldHours}h | t net ${s.tNet} (gross ${s.tGross}) | placebo p95 ${pc(out.placeboByCell[c].p95)} beats=${out.placeboByCell[c].beats} | crest ${out.crestCapture[c]}`); }
  console.log(`  better ${out.cell}: t ${out.tNet} vs bar ${BAR}; halves ${pc(out.halves.first.meanNet)} | ${pc(out.halves.second.meanNet)}; top10 share ${out.top10DaysShare}; coins w/ candles ${out.coverage.coinsWithWindowCandles}`);
  console.log("  wrote " + OUT);
}

// ════════════════════════════════════════════════════════════════════════════════ MAIN
if (require.main === module) (async () => {
  if (mode === "--fetch") { await fetchAll(); return; }
  if (mode === "--selftest") { process.exit(selftest({ real: !process.argv.includes("--synthetic") }) ? 0 : 1); }
  if (mode === "--dry") { dry(); return; }
  if (mode === "--read") { read(); return; }
})().catch((e) => { console.error(`${ID} FAILED:`, e.stack || e.message); process.exit(1); });

module.exports = { features, mkSeries, entriesOf, exitsAt, crestAt, dayStats, decide, analyze };
