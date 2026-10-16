#!/usr/bin/env node
/**
 * R195 — CRYPTO FUNDING EXTREMES: do extreme Hyperliquid perp funding rates predict BTC/ETH reversals? Registered 2026-09-24
 * (family MINE-3, best-of-5 bar) BEFORE this file ran; rule, statistic, bar and control frozen in data/test-registry.json.
 *
 *   node backend/r195-funding-extremes.js --fetch   -> fetch/cache data only, print coverage (no returns), write nothing else
 *   node backend/r195-funding-extremes.js           -> data/r195-funding-extremes.json; seals once (see "Sealing" below)
 *
 * DATA (cached under data/training/mine3/, ~1 call / 300 ms)
 *  - Funding: Hyperliquid public info API, POST https://api.hyperliquid.xyz/info {type:"fundingHistory", coin, startTime, endTime},
 *    ~500 rows a call, paged by advancing startTime past the last row's time. BTC and ETH, from 2023-01-01 to 2026-09-01 00:00 UTC.
 *  - Prices: Coinbase Exchange public daily candles (granularity 86400, <=300 per call) for BTC-USD and ETH-USD. A candle stamped
 *    day d opens 00:00 UTC d and closes 00:00 UTC d+1; "close of d" is that candle's close.
 *
 * IMPLEMENTATION NOTES (every choice below was fixed before the first read; none was chosen on results)
 *  - Daily funding for UTC day d = arithmetic mean of that day's hourly fundingRate rows (row time in [d 00:00, d+1 00:00) UTC);
 *    a day needs >= 12 rows, else it is missing. The last hourly row of day d is stamped <= 23:00 UTC, so the signal is known
 *    before the entry close at 00:00 UTC d+1 (no look-ahead).
 *  - Trailing distribution = the valid daily values of the 180 calendar days d-180..d-1 (d excluded); needs >= 150 valid days.
 *    TOP 10%  <=> #{trailing < f(d)} >= 0.9 * n  -> short-bias (contrarian)
 *    BOTTOM 10% <=> #{trailing > f(d)} >= 0.9 * n -> long-bias
 *    Strict inequalities: a value tied with its trailing values (e.g. funding pinned at the baseline interest rate) never counts as
 *    extreme. There is no sort in this test whose tie order could pick members (no row-order dependence); the only randomness is
 *    the placebo, which is seeded (mulberry32).
 *  - Return: entry at the Coinbase close of d, exit at the close of d+h; directional = dir * (close(d+h)/close(d) - 1); net =
 *    directional - 0.002 (10 bps a side). Signal days d <= 2026-08-31 (evidence window); exits may fall in early September.
 *  - "Per signal day": BTC and ETH signals on the same UTC day are AVERAGED into one observation for that day (they are one
 *    correlated bet; counting them twice would inflate n). t over signal days in date order, Newey-West (Bartlett) lag 2 for the
 *    3-day primary; reported variants use lag h-1 (1-day: lag 0, 7-day: lag 6). Momentum sign = -dir, same cost.
 *  - Placebo (registered): 200 seeded draws; each signal (coin, day, dir) is moved to a uniformly random day of the SAME calendar
 *    month on which that coin has both closes needed for the 3-day return (and the day <= 2026-08-31); the placebo signals are aggregated per day exactly as the real ones; statistic = mean net 3-day return.
 *    The true mean must exceed the placebo 95th percentile.
 *  - Verdict: PASS only if primary NW t >= bar (registry) AND true mean > placebo p95.
 *  - Sealing: the placebo here is a comparison control that enters the verdict (as in R192, same family), not a pipeline sanity
 *    check. The read seals when the placebo was computed validly (200 finite draws) and there is at least one signal day;
 *    otherwise it writes the JSON, exits 3 and does NOT seal.
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), CACHE = D("training/mine3"), ID = "R195", FETCH_ONLY = process.argv.includes("--fetch");
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")), SEALS = seals.tests || seals;
if (SEALS[ID] && !FETCH_ONLY) { console.error(`${ID} already sealed — refusing`); process.exit(2); }
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E = reg.preregistered.find((t) => t.id === ID);
if (!E) { console.error(`${ID} not registered`); process.exit(2); }
const BAR = E.bar.tRequired, COINS = ["BTC", "ETH"], COST = 0.002, LAST_SIGNAL = "2026-08-31";
const FUND_START = Date.UTC(2023, 0, 1), FUND_END = Date.UTC(2026, 8, 1), PX_START = Date.UTC(2023, 0, 1), PX_END = Date.UTC(2026, 8, 15);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function nwT(a, L) { const n = a.length, m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n; for (let l = 1; l <= L; l++) { let g = 0; for (let i = l; i < n; i++) g += d[i] * d[i - l]; v += 2 * (1 - l / (L + 1)) * g / n; } return m / Math.sqrt(v / n); }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10), addDays = (d, k) => dayOf(Date.parse(d + "T00:00:00Z") + k * 86400000);

// ---- fetch + cache ------------------------------------------------------------------------------------------------------------
async function fundingHistory(coin) {
  const f = path.join(CACHE, `hl-funding-${coin}.json`);
  if (fs.existsSync(f)) { const j = JSON.parse(fs.readFileSync(f, "utf8")); if (j.end === FUND_END) return j.rows; }
  const rows = []; let start = FUND_START, calls = 0;
  for (;;) {
    let res; for (let tries = 0; ; tries++) { res = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "fundingHistory", coin, startTime: start, endTime: FUND_END - 1 }) }); if (res.status !== 429 || tries >= 6) break; await sleep(15000 * (tries + 1)); }   // rate-limited: back off and retry the same page
    calls++; if (!res.ok) throw new Error(`hyperliquid ${coin} HTTP ${res.status}`);
    const page = await res.json(); if (!Array.isArray(page)) throw new Error(`hyperliquid ${coin}: non-array page`);
    for (const r of page) if (r.time >= start && r.time < FUND_END) rows.push({ time: r.time, rate: +r.fundingRate });
    await sleep(300);
    if (!page.length) break; const last = page[page.length - 1].time; if (last >= FUND_END - 1 || last < start) break; start = last + 1;
  }
  const seen = new Set(), uniq = rows.filter((r) => (seen.has(r.time) ? false : (seen.add(r.time), true))).sort((a, b) => a.time - b.time);
  writeJsonAtomic(f, { source: "api.hyperliquid.xyz/info fundingHistory", coin, start: FUND_START, end: FUND_END, fetchedAt: new Date().toISOString(), calls, rows: uniq }, { pretty: 0 });
  return uniq;
}
async function candles(product) {
  const f = path.join(CACHE, `coinbase-${product}-daily.json`);
  if (fs.existsSync(f)) { const j = JSON.parse(fs.readFileSync(f, "utf8")); if (j.end === PX_END) return j.rows; }
  const map = new Map(); let calls = 0;
  for (let s = PX_START; s < PX_END; s += 300 * 86400000) {
    const e = Math.min(PX_END, s + 299 * 86400000);
    const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=86400&start=${new Date(s).toISOString()}&end=${new Date(e).toISOString()}`;
    const res = await fetch(url, { headers: { "User-Agent": "traids-research/1.0", Accept: "application/json" } }); calls++;
    if (!res.ok) throw new Error(`coinbase ${product} HTTP ${res.status}`);
    for (const [t, lo, hi, op, cl, vol] of await res.json()) map.set(dayOf(t * 1000), { d: dayOf(t * 1000), o: op, h: hi, l: lo, c: cl, v: vol });
    await sleep(300);
  }
  const rows = [...map.values()].sort((a, b) => (a.d < b.d ? -1 : 1));
  writeJsonAtomic(f, { source: "api.exchange.coinbase.com candles 86400", product, start: PX_START, end: PX_END, fetchedAt: new Date().toISOString(), calls, rows }, { pretty: 0 });
  return rows;
}

(async () => {
  fs.mkdirSync(CACHE, { recursive: true });
  const fund = {}, px = {};
  for (const coin of COINS) { fund[coin] = await fundingHistory(coin); px[coin] = await candles(`${coin}-USD`); }
  // daily funding
  const daily = {}, coverage = {};
  for (const coin of COINS) {
    const by = new Map(); for (const r of fund[coin]) { const d = dayOf(r.time); if (!by.has(d)) by.set(d, []); by.get(d).push(r.rate); }
    const m = new Map(); let dropped = 0; for (const [d, a] of by) { if (a.length >= 12) m.set(d, mean(a)); else dropped++; }
    daily[coin] = m;
    const days = [...m.keys()].sort(), pdays = px[coin].map((x) => x.d);
    coverage[coin] = { fundingRows: fund[coin].length, fundingFirst: fund[coin].length ? new Date(fund[coin][0].time).toISOString() : null, fundingLast: fund[coin].length ? new Date(fund[coin][fund[coin].length - 1].time).toISOString() : null, validDays: days.length, daysDroppedUnder12Rows: dropped, firstDay: days[0], lastDay: days[days.length - 1], priceDays: pdays.length, priceFirst: pdays[0], priceLast: pdays[pdays.length - 1] };
  }
  // signals
  const close = {}; for (const coin of COINS) close[coin] = new Map(px[coin].map((x) => [x.d, x.c]));
  const signals = [], eligible = {};
  for (const coin of COINS) {
    const m = daily[coin], days = [...m.keys()].sort(); eligible[coin] = 0;
    for (const d of days) {
      if (d > LAST_SIGNAL) continue;
      const tr = []; for (let k = 1; k <= 180; k++) { const x = m.get(addDays(d, -k)); if (x !== undefined) tr.push(x); }
      if (tr.length < 150) continue; eligible[coin]++;
      const f = m.get(d), lt = tr.filter((x) => x < f).length, gt = tr.filter((x) => x > f).length;
      const dir = lt >= 0.9 * tr.length ? -1 : gt >= 0.9 * tr.length ? 1 : 0;
      if (dir) signals.push({ coin, d, dir, f });
    }
  }
  const ret = (coin, d, h) => { const a = close[coin].get(d), b = close[coin].get(addDays(d, h)); return a > 0 && b > 0 ? b / a - 1 : NaN; };
  if (FETCH_ONLY) { console.log(JSON.stringify({ coverage, eligibleDays: eligible, signals: signals.length, shortSignals: signals.filter((s) => s.dir < 0).length, longSignals: signals.filter((s) => s.dir > 0).length, signalDays: new Set(signals.map((s) => s.d)).size }, null, 1)); return; }

  // per-day aggregation: sig list -> sorted [{d, x}] of mean net directional returns
  function series(sigs, h, sign = 1) {
    const by = new Map(); for (const s of sigs) { const r = ret(s.coin, s.d, h); if (!Number.isFinite(r)) continue; const x = sign * s.dir * r - COST; if (!by.has(s.d)) by.set(s.d, []); by.get(s.d).push(x); }
    return [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, a]) => ({ d, x: mean(a) }));
  }
  const stat = (rows, L) => { const a = rows.map((r) => r.x); return { signalDays: a.length, meanNetPct: +(100 * mean(a)).toFixed(3), tNW: +nwT(a, L).toFixed(3), nwLag: L, winPct: +(100 * a.filter((x) => x > 0).length / a.length).toFixed(1) }; };
  const P = series(signals, 3), primary = stat(P, 2);
  const variants = { h1: stat(series(signals, 1), 0), h7: stat(series(signals, 7), 6), momentum3: stat(series(signals, 3, -1), 2), momentum1: stat(series(signals, 1, -1), 0), momentum7: stat(series(signals, 7, -1), 6) };
  const byCoin = Object.fromEntries(COINS.map((c) => [c, stat(series(signals.filter((s) => s.coin === c), 3), 2)]));
  const byDir = { shortBias_highFunding: stat(series(signals.filter((s) => s.dir < 0), 3), 2), longBias_lowFunding: stat(series(signals.filter((s) => s.dir > 0), 3), 2) };
  const byYear = {}; for (const y of [...new Set(P.map((r) => r.d.slice(0, 4)))]) byYear[y] = stat(P.filter((r) => r.d.startsWith(y)), 2);
  // placebo: same coin, same direction, random day in the same calendar month with both closes present and d <= LAST_SIGNAL
  const monthDays = (coin, ym) => { const out = []; for (let k = 1; k <= 31; k++) { const d = `${ym}-${String(k).padStart(2, "0")}`; if (d > LAST_SIGNAL || Number.isNaN(Date.parse(d + "T00:00:00Z")) || dayOf(Date.parse(d + "T00:00:00Z")) !== d) continue; if (Number.isFinite(ret(coin, d, 3))) out.push(d); } return out; };
  const md = new Map(), draws = [];
  for (let k = 0; k < 200; k++) {
    const rng = mulberry(1950000 + k);
    const moved = signals.map((s) => { const key = s.coin + s.d.slice(0, 7); if (!md.has(key)) md.set(key, monthDays(s.coin, s.d.slice(0, 7))); const pool = md.get(key); return { ...s, d: pool[Math.floor(rng() * pool.length)] }; }).filter((s) => s.d);
    const a = series(moved, 3).map((r) => r.x); draws.push(mean(a));
  }
  const ds = [...draws].sort((a, b) => a - b), p95 = ds[Math.floor(0.95 * ds.length)], placeboOk = draws.length === 200 && draws.every(Number.isFinite) && P.length > 0;
  const trueMean = mean(P.map((r) => r.x)), beats = trueMean > p95, pass = primary.tNW >= BAR && beats;
  const verdict = !placeboOk ? `CONTROLS FAILED — placebo not computable (signal days ${P.length})`
    : pass ? `PASS — contrarian funding-extreme 3-day net ${primary.meanNetPct}%, NW t ${primary.tNW} >= ${BAR}, above placebo p95 ${(100 * p95).toFixed(3)}% (${primary.signalDays} signal days)`
    : `DID NOT PASS — contrarian funding-extreme 3-day net ${primary.meanNetPct}% over ${primary.signalDays} signal days, NW t ${primary.tNW} vs ${BAR}; placebo p95 ${(100 * p95).toFixed(3)}% (${beats ? "beaten" : "not beaten"}); momentum sign t ${variants.momentum3.tNW}`;
  const out = { spec: "r195-funding-extremes-v1", test: ID, ranAt: new Date().toISOString(), bar: BAR, coverage, eligibleDays: eligible,
    signals: { total: signals.length, short: signals.filter((s) => s.dir < 0).length, long: signals.filter((s) => s.dir > 0).length, bothCoinsSameDay: signals.length - new Set(signals.map((s) => s.d)).size },
    primary, variants, byCoin, byDirection: byDir, byYear,
    controls: { placebo: { draws: draws.length, meanPct: +(100 * mean(draws)).toFixed(3), medianPct: +(100 * ds[100]).toFixed(3), p95Pct: +(100 * p95).toFixed(3), trueMeanPct: +(100 * trueMean).toFixed(3), beatsP95: beats, computed: placeboOk } },
    signalRows: signals.map((s) => ({ coin: s.coin, d: s.d, dir: s.dir, funding: s.f, r3: +(ret(s.coin, s.d, 3) || 0).toFixed(5) })),
    verdict };
  writeJsonAtomic(D("r195-funding-extremes.json"), out);
  console.log(JSON.stringify({ ...out, signalRows: `${out.signalRows.length} rows (in file)` }, null, 1));
  if (!placeboOk) { console.error("placebo not computable — NOT sealed"); process.exit(3); }
  const today = new Date().toISOString().slice(0, 10);
  SEALS[ID] = { sealedOn: today, unit: "signal days", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
  E.status = "READ " + today + " — " + verdict; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: ID, verdict }) + "\n");
  console.log("sealed", ID);
})().catch((e) => { console.error("FAILED:", e.stack); process.exit(1); });
