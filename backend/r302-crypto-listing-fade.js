#!/usr/bin/env node
/**
 * R302 — New-listing fade on Coinbase (The TIE 2026): short each new USD pair vs BTC from the D+2 close to the D+14 close.
 * Registered 2026-10-01 (the registry wins: backend/data/test-registry.json, id R302; rule, statistic, unit, window, control, cost
 * and bar are FROZEN; bar.tRequired is read from the registry at run time, never hard-coded here).
 *
 *   node backend/r302-crypto-listing-fade.js --fetch      fill the per-product candle cache (resumable, throttled)
 *   node backend/r302-crypto-listing-fade.js --universe   list the events + exclusions BY NAME ONLY (no returns are computed)
 *   node backend/r302-crypto-listing-fade.js --selftest   known answers (hand-computable) — must pass before the read
 *   node backend/r302-crypto-listing-fade.js --read       the ONE registered read (refuses if sealed or the output exists)
 *
 * RULE (registry text): EVENTS = every Coinbase USD spot pair whose first daily candle falls in 2023-01..2026-09 (listing date = first
 * candle; announcement times unavailable: disclosed), excluding stablecoins and wrapped assets. SHORT the pair vs BTC (paper) from the
 * close of day +2 to the close of day +14 after the first candle. COST 25 bps per side on the pair AND on BTC (4 x 25 = 100 bps per
 * listing). Statistic: per-listing net excess return (BTC minus pair), clustered by listing MONTH; one-sample t over months with
 * listings. Control: the same pairs over a random 12-day window 60-180 days after listing (>= 500 draws).
 *
 * FIXED BEFORE ANY OUTCOME WAS COMPUTED (builder interpretations of registry wording; none changes the rule):
 *  B1 DATA = Coinbase Exchange public REST (api.exchange.coinbase.com /products and /products/{id}/candles, granularity 86400, UTC days,
 *     <= 299 candles per request, 250 ms between requests, 429/5xx back-off). /products still lists 88 delisted USD pairs and serves their
 *     history, so delisted listings stay in (no survivorship from the live list only). BTC benchmark = BTC-USD from the same feed.
 *  B2 FIRST CANDLE: a USD product is "pre-existing" (not an event) if ANY daily candle exists in 2020-01-01..2022-12-31; otherwise its
 *     first candle on/after 2023-01-01 is the listing date F (UTC day). Events need F in 2023-01-01..2026-09-30. Day k = F + k days.
 *  B3 PRICE at day d = close of the last candle dated <= d (forward-fill over no-trade days; stale days are counted and reported).
 *     An event needs a candle on/before F+2 (entry) and F+14 <= 2026-09-30 (last complete UTC day; today's forming candle is never used).
 *     If a product stops trading before F+14 (delisted), the last close is used as the exit (flagged and counted, never dropped).
 *  B4 RETURNS are simple: gross = (BTC_14/BTC_2 - 1) - (PAIR_14/PAIR_2 - 1); net = gross - 4 x 0.0025 = gross - 0.0100.
 *  B5 EXCLUSIONS are by BASE NAME ONLY (fx_stablecoin flag from /products + the EXCLUDE list below), fixed after reading the list of
 *     listing names and BEFORE any return was computed (--universe prints names and dates only).
 *  B5a AMENDMENT 2026-10-01 (second builder pass, made after --universe printed names and dates and BEFORE any return was computed): WRON
 *     (wrapped RON) and PAXG (gold-backed token) added to EXCLUDE as wrapped / asset-backed tokens, per the registry words "excluding
 *     stablecoins and wrapped assets". Name-based only; two of 242 events; the other six exclusions were already in the list.
 *  B6 STATISTIC = clusteredT over listing months of the net per-listing return (each month = the mean of its listings; t over those
 *     month means, df = months-1). Also reported: per-listing mean, the mean of month means, listing-weighted cluster-robust t.
 *  B7 PLACEBO = for every listing with data through F+180 (and a candle at/after F+180), a random window start s ~ U{60..168} so the
 *     12-day window [F+s, F+s+12] lies within day 60-180; same BTC-minus-pair excess, same 100 bps cost; statistic = per-listing mean net;
 *     1000 draws, seeded; p95 = 95th percentile of the draw means. "beats" requires observed meanNet > p95 for BOTH the full event set
 *     AND the like-for-like subset of events that are placebo-eligible (recent listings cannot be placebo-tested: disclosed).
 *  B8 HALVES = split at the calendar midpoint of the registered window (2023-01-01..2026-09-30); PASS needs both halves' mean net the
 *     same sign as the full-window mean net (and positive: a fade is a positive BTC-minus-pair excess).
 *  B9 dollarsAt10k = net $ per year with $10k notional on EACH leg per listing (gross exposure $20k per listing), listings/yr x mean net
 *     x $10k; maxDD = max peak-to-trough of the cumulative per-listing net in listing-exit order, in units of one $10k notional.
 *  B10 A pair that pumps >100% makes the short lose more than the notional (unbounded); returns are not capped. Outlier sensitivity
 *     (median, winsorised mean, top-5 removed) is DIAGNOSTIC and never decides.
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { clusterMeans, tOf: tOfOrNull, mean, sd } = require("./lib/clustered.js");

// ---------------------------------------------------------------- constants (fixed at the top)
const D = (f) => path.join(__dirname, "data", f);
const CACHE = D("training/r302"), CANDLES = path.join(CACHE, "candles");
const OUT = D("r302-crypto-listing-fade.json"), REG = D("test-registry.json"), SEALS = D("read-seals.json");
const ID = "R302", KEY = "CRYPTO_LISTING_FADE";
const COINBASE = "https://api.exchange.coinbase.com";
const WIN_START = "2023-01-01", LAST = "2026-09-30";          // registered window; LAST = last complete UTC day (read 2026-10-01)
const PRE_FLOOR = "2020-01-01";                               // pre-existing check reaches back to here
const ENTRY_DAY = 2, EXIT_DAY = 14, SPAN = EXIT_DAY - ENTRY_DAY;
const COST_SIDE = 0.0025, COST_RT = 4 * COST_SIDE;           // 25 bps x (entry+exit) x (pair+BTC)
const PL_LO = 60, PL_HI = 180, DRAWS = 1000, SEED = 302302;
const WIN_DAYS = 299, GAP_MS = 250, NOTIONAL = 10000;
const MID = "2024-11-15";                                     // calendar midpoint of 2023-01-01..2026-09-30
const mode = ["--fetch", "--universe", "--selftest", "--read"].find((m) => process.argv.includes(m)) || "--selftest";

// B5 — stablecoins / wrapped / liquid-staking receipt tokens, by base name only (fixed before any outcome; list is of names, not prices)
const EXCLUDE = new Set([
  // stablecoins and fiat-pegged
  "USDT", "USDC", "DAI", "PYUSD", "GUSD", "PAX", "USDP", "EURC", "UST", "USTC", "BUSD", "TUSD", "FRAX", "LUSD", "RLUSD", "USDS", "GYEN", "MUSD", "EUROC", "FDUSD", "USDD", "CUSD", "SUSD", "AUSD", "USD1", "USDG",
  // wrapped / bridged / staked-receipt versions of a base asset
  "WRON", "PAXG", "WBTC", "CBBTC", "WETH", "CBETH", "WSTETH", "STETH", "LSETH", "METH", "WEETH", "RETH", "MSOL", "JITOSOL", "BNSOL", "CBSOL", "WAXL", "WCFG", "WLUNA", "WNXM", "RENBTC", "TBTC", "WRBTC", "SOLVBTC", "LBTC",
]);

// ---------------------------------------------------------------- date helpers (UTC days as strings)
const DAY_MS = 86400000;
const toMs = (s) => Date.parse(s + "T00:00:00Z");
const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (s, n) => fromMs(toMs(s) + n * DAY_MS);
const diffDays = (a, b) => Math.round((toMs(a) - toMs(b)) / DAY_MS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- fetch layer (throttled, retrying, resumable)
let lastReq = 0;
async function cbGet(pq) {
  for (let a = 0; a < 10; a++) {
    const wait = lastReq + GAP_MS - Date.now(); if (wait > 0) await sleep(wait); lastReq = Date.now();
    try {
      const r = await fetch(COINBASE + pq, { headers: { "User-Agent": "traids-r302-research", Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
      if (r.status === 429 || r.status >= 500) { await sleep(Math.min(30000, 1000 * 2 ** a)); continue; }
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
      return await r.json();
    } catch (e) { if (a === 9) throw e; await sleep(Math.min(30000, 1000 * 2 ** a)); }
  }
  throw new Error("cbGet exhausted retries " + pq);
}
/** [startDay, endDay] inclusive, <= 299 days; returns [{d,o,h,l,c,v}] sorted ascending. */
async function candleWindow(id, startDay, endDay) {
  if (diffDays(endDay, startDay) > WIN_DAYS - 1) throw new Error("window too wide");
  const j = await cbGet(`/products/${id}/candles?granularity=86400&start=${startDay}T00:00:00Z&end=${endDay}T00:00:00Z`);
  if (!Array.isArray(j)) return [];
  const today = new Date().toISOString().slice(0, 10);
  return j.map(([t, l, h, o, c, v]) => ({ d: fromMs(t * 1000), o, h, l, c, v })).filter((b) => b.c > 0 && Number.isFinite(b.c) && b.d > "1970-01-02" && b.d < today && b.d <= LAST).sort((a, b) => a.d.localeCompare(b.d));
}
const fileOf = (id) => path.join(CANDLES, id + ".json");
const loadProd = (id) => (fs.existsSync(fileOf(id)) ? JSON.parse(fs.readFileSync(fileOf(id), "utf8")) : null);

/** Walk back from 2022-12-31 to PRE_FLOOR; stop at the first window with any candle. */
async function preCheck(id) {
  let end = "2022-12-31";
  while (end >= PRE_FLOOR) {
    const start = addDays(end, -(WIN_DAYS - 1)), rows = await candleWindow(id, start, end);
    if (rows.length) return rows[0].d;
    end = addDays(start, -1);
  }
  return null;
}
async function fetchProduct(p) {
  const id = p.id; const have = loadProd(id); if (have && have.complete) return have;
  const rec = { id, base: p.base_currency, status: p.status, fxStable: !!p.fx_stablecoin, preExisting: false, preFirstSeen: null, first: null, rows: [], complete: false, fetchedAt: new Date().toISOString() };
  const pre = await preCheck(id);
  if (pre) { rec.preExisting = true; rec.preFirstSeen = pre; rec.complete = true; writeJsonAtomic(fileOf(id), rec, { pretty: 0 }); return rec; }
  let start = WIN_START;
  while (start <= LAST) {
    const end = [addDays(start, WIN_DAYS - 1), LAST].sort()[0], rows = await candleWindow(id, start, end);
    rec.rows.push(...rows);
    if (rec.rows.length && !rec.first) rec.first = rec.rows[0].d;
    if (rec.first && end >= [addDays(rec.first, 200), LAST].sort()[0]) break;     // enough post-listing history for the placebo
    start = addDays(end, 1);
  }
  rec.complete = true; writeJsonAtomic(fileOf(id), rec, { pretty: 0 }); return rec;
}
async function fetchBtc() {
  const f = path.join(CACHE, "BTC-USD.json");
  if (fs.existsSync(f)) { const j = JSON.parse(fs.readFileSync(f, "utf8")); if (j.complete) return j; }
  const rows = []; let start = "2022-12-01";
  while (start <= LAST) { const end = [addDays(start, WIN_DAYS - 1), LAST].sort()[0]; rows.push(...(await candleWindow("BTC-USD", start, end))); start = addDays(end, 1); }
  const rec = { id: "BTC-USD", complete: true, fetchedAt: new Date().toISOString(), rows }; writeJsonAtomic(f, rec, { pretty: 0 }); return rec;
}
async function fetchAll() {
  fs.mkdirSync(CANDLES, { recursive: true });
  const pf = path.join(CACHE, "products.json");
  let prods;
  if (fs.existsSync(pf)) prods = JSON.parse(fs.readFileSync(pf, "utf8")).products;
  else { const j = await cbGet("/products"); if (!Array.isArray(j)) throw new Error("products fetch failed"); prods = j.filter((p) => p.quote_currency === "USD").map(({ id, base_currency, quote_currency, status, fx_stablecoin, display_name }) => ({ id, base_currency, quote_currency, status, fx_stablecoin, display_name })); writeJsonAtomic(pf, { fetchedAt: new Date().toISOString(), products: prods }); }
  await fetchBtc();
  let n = 0, t0 = Date.now();
  for (const p of prods) { await fetchProduct(p); if (++n % 25 === 0) console.log(`fetched ${n}/${prods.length} products, ${((Date.now() - t0) / 1000).toFixed(0)}s`); }
  console.log(`fetch complete: ${prods.length} USD products cached in ${CANDLES}`);
}

// ---------------------------------------------------------------- pure logic (used by the selftest on synthetic series)
/** forward-filled close at day d: { px, stale } (stale = days since the candle used); null if no candle on/before d. */
function priceAt(rows, d) {
  let lo = 0, hi = rows.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (rows[m].d <= d) { k = m; lo = m + 1; } else hi = m - 1; }
  return k < 0 ? null : { px: rows[k].c, stale: diffDays(d, rows[k].d) };
}
/** excess of a short pair / long BTC over [F+a, F+b]; cost charged. */
function excess(pairRows, btcRows, F, a, b) {
  const p0 = priceAt(pairRows, addDays(F, a)), p1 = priceAt(pairRows, addDays(F, b)), b0 = priceAt(btcRows, addDays(F, a)), b1 = priceAt(btcRows, addDays(F, b));
  if (!p0 || !p1 || !b0 || !b1) return null;
  const gross = (b1.px / b0.px - 1) - (p1.px / p0.px - 1);
  return { gross, net: gross - COST_RT, staleEntry: p0.stale, staleExit: p1.stale };
}
/** t over month means (k = months, the effective N). */
function monthStat(evs, key) {
  const c = clusterMeans(evs, (e) => e.month, (e) => e[key]);
  const t = c.k >= 2 ? tOfOrNull(c.means) : null;
  return { t: t == null ? null : t, k: c.k, meanOfMonths: c.k ? mean(c.means) : null, means: c.means, keys: c.keys, sizes: c.sizes };
}
/** cluster-robust t of the listing-weighted mean (CR0 with a small-sample k/(k-1) factor), secondary. */
function robustT(evs, key) {
  const by = new Map(); for (const e of evs) (by.get(e.month) || by.set(e.month, []).get(e.month)).push(e[key]);
  const x = evs.map((e) => e[key]), n = x.length, m = mean(x), k = by.size;
  if (k < 2) return null; let s = 0; for (const v of by.values()) { const u = v.reduce((a, y) => a + (y - m), 0); s += u * u; }
  const se = Math.sqrt((s * k / (k - 1)) ) / n; return se > 0 ? m / se : null;
}
function maxDrawdown(nets) { let cum = 0, pk = 0, dd = 0; for (const x of nets) { cum += x; pk = Math.max(pk, cum); dd = Math.min(dd, cum - pk); } return dd; }
function rng32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
/** placebo distribution of per-listing mean net; `elig` = [{F, month, rows}], rnd a [0,1) generator. */
function placeboDraws(elig, btcRows, draws, rnd) {
  const out = [];
  for (let k = 0; k < draws; k++) {
    let s = 0, n = 0;
    for (const e of elig) { const st = PL_LO + Math.floor(rnd() * (PL_HI - SPAN - PL_LO + 1)); const r = excess(e.rows, btcRows, e.F, st, st + SPAN); if (r) { s += r.net; n++; } }
    out.push(n ? s / n : NaN);
  }
  return out.filter(Number.isFinite).sort((a, b) => a - b);
}
const q95 = (sorted) => sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))];

// ---------------------------------------------------------------- build events from the cache
function loadUniverse() {
  const pf = path.join(CACHE, "products.json"); if (!fs.existsSync(pf)) throw new Error("no products cache — run --fetch first");
  const prods = JSON.parse(fs.readFileSync(pf, "utf8")).products, btc = JSON.parse(fs.readFileSync(path.join(CACHE, "BTC-USD.json"), "utf8")).rows;
  const events = [], skipped = { notCached: 0, preExisting: 0, noCandleInWindow: 0, outsideWindow: 0, excluded: [], notMeasurable: [] };
  for (const p of prods) {
    const rec = loadProd(p.id); if (!rec || !rec.complete) { skipped.notCached++; continue; }
    if (rec.preExisting) { skipped.preExisting++; continue; }
    if (!rec.first) { skipped.noCandleInWindow++; continue; }
    if (rec.first < WIN_START || rec.first > LAST) { skipped.outsideWindow++; continue; }
    if (rec.fxStable || EXCLUDE.has(rec.base)) { skipped.excluded.push(`${rec.base}@${rec.first}`); continue; }
    events.push({ id: rec.id, base: rec.base, status: rec.status, F: rec.first, month: rec.first.slice(0, 7), rows: rec.rows, lastCandle: rec.rows.at(-1).d });
  }
  events.sort((a, b) => a.F.localeCompare(b.F) || a.id.localeCompare(b.id));
  return { events, skipped, btc };
}

// ---------------------------------------------------------------- selftest (hand-computable known answers)
function selftest() {
  let fail = 0; const ok = (name, cond, extra = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${name} ${extra}`); if (!cond) fail++; };
  const near = (a, b, e = 1e-12) => Math.abs(a - b) < e;
  const mk = (F, n, f) => Array.from({ length: n }, (_, i) => ({ d: addDays(F, i), c: f(i) }));
  const F = "2024-03-01";
  // T1 flat pair and flat BTC -> gross 0, net exactly -0.01
  let r = excess(mk(F, 30, () => 5), mk(F, 30, () => 60000), F, 2, 14);
  ok("T1 flat/flat gross=0, net=-cost", near(r.gross, 0) && near(r.net, -0.01), `gross ${r.gross} net ${r.net}`);
  // T2 pair +1%/day compounding, BTC flat -> gross = -(1.01^12-1)
  r = excess(mk(F, 30, (i) => 1.01 ** i), mk(F, 30, () => 60000), F, 2, 14);
  ok("T2 pair +1%/day vs flat BTC", near(r.gross, -(1.01 ** 12 - 1), 1e-12) && near(r.net, -(1.01 ** 12 - 1) - 0.01, 1e-12), `gross ${r.gross.toFixed(6)} (hand -0.126825)`);
  // T3 pair identical to BTC (rising 1%/day) -> gross 0 (the BTC-neutral known answer), net -0.01
  const btcUp = mk(F, 30, (i) => 60000 * 1.01 ** i);
  r = excess(btcUp, btcUp, F, 2, 14);
  ok("T3 pair==BTC gross=0, net=-cost", near(r.gross, 0) && near(r.net, -0.01), `net ${r.net}`);
  // T3b pair falls 2%/day, BTC flat -> short WINS: gross = 1-0.98^12
  r = excess(mk(F, 30, (i) => 0.98 ** i), mk(F, 30, () => 100), F, 2, 14);
  ok("T3b pair -2%/day: short profits 1-0.98^12", near(r.gross, 1 - 0.98 ** 12, 1e-12), `gross ${r.gross.toFixed(6)} (hand ${(1 - 0.98 ** 12).toFixed(6)})`);
  // T4 forward fill: no candle on day 2 and day 14
  const gap = mk(F, 30, (i) => 1 + i).filter((b) => ![2, 14].includes(diffDays(b.d, F)));
  r = excess(gap, mk(F, 30, () => 100), F, 2, 14);
  ok("T4 forward-fill uses day 1 and day 13 closes, stale 1/1", near(r.gross, -(14 / 2 - 1), 1e-12) && r.staleEntry === 1 && r.staleExit === 1, `gross ${r.gross} (hand ${-(14 / 2 - 1)}) stale ${r.staleEntry}/${r.staleExit}`);
  ok("T4b priceAt before first candle is null", priceAt(mk(F, 5, () => 1), addDays(F, -1)) === null);
  // T5 month clustering hand answer: months A {0.10,0.20} B {-0.05} C {0.05,0.05,0.05} -> month means .15,-.05,.05; mean .05, sd .1, t = .05/(.1/sqrt3) = 0.8660254
  const evs = [["2024-01", 0.10], ["2024-01", 0.20], ["2024-02", -0.05], ["2024-03", 0.05], ["2024-03", 0.05], ["2024-03", 0.05]].map(([month, net]) => ({ month, net, gross: net + 0.01 }));
  const ms = monthStat(evs, "net");
  ok("T5 month-clustered t hand answer 0.8660254", near(ms.t, 0.05 / (0.1 / Math.sqrt(3)), 1e-9) && ms.k === 3 && near(ms.meanOfMonths, 0.05, 1e-12), `t ${ms.t} k ${ms.k}`);
  ok("T5b per-listing mean 0.4/6", near(mean(evs.map((e) => e.net)), 0.4 / 6, 1e-12));
  ok("T5c gross = net + 0.01 carried through monthStat", near(monthStat(evs, "gross").meanOfMonths, 0.06, 1e-12));
  // T6 drawdown hand answer: 0.1,-0.2,-0.1,0.3 -> cum .1,-.1,-.2,.1 ; peak .1 -> trough -.2 => -0.3
  ok("T6 maxDrawdown hand answer -0.3", near(maxDrawdown([0.1, -0.2, -0.1, 0.3]), -0.3, 1e-12), `${maxDrawdown([0.1, -0.2, -0.1, 0.3])}`);
  // T7 placebo known answer: pair == BTC for all windows -> every placebo window gross 0 -> every draw mean = -0.01, p95 = -0.01
  const long = (F0) => Array.from({ length: 260 }, (_, i) => ({ d: addDays(F0, i), c: 100 * 1.003 ** i }));
  const btcL = long("2024-01-01").map((b) => ({ d: b.d, c: b.c }));
  const elig = ["2024-02-01", "2024-03-01", "2024-03-15"].map((f) => ({ F: f, month: f.slice(0, 7), rows: btcL }));
  const pd = placeboDraws(elig, btcL, 200, rng32(1));
  ok("T7 placebo pair==BTC => every draw = -cost", pd.length === 200 && pd.every((x) => near(x, -0.01, 1e-12)) && near(q95(pd), -0.01, 1e-12), `p95 ${q95(pd)}`);
  // T7b placebo window bounds: starts stay in [60,168] so the window ends by day 180
  let minS = 1e9, maxS = -1; const rnd = rng32(7); for (let i = 0; i < 20000; i++) { const s = PL_LO + Math.floor(rnd() * (PL_HI - SPAN - PL_LO + 1)); minS = Math.min(minS, s); maxS = Math.max(maxS, s); }
  ok("T7b placebo start in [60,168], end <=180", minS === 60 && maxS === 168 && maxS + SPAN === 180, `min ${minS} max ${maxS}`);
  // T8 shuffled/no-signal: independent symmetric random walks -> mean gross ~ 0 and |t over months| small (seeded, 3000 listings in 60 months)
  const g = rng32(99), walk = (n, sg) => { let p = 100; return Array.from({ length: n }, (_, i) => ({ d: addDays("2024-01-01", i), c: (p *= 1 + sg * (g() - 0.5)) })); };
  const evw = [];
  for (let i = 0; i < 3000; i++) { const rr = excess(walk(40, 0.08), walk(40, 0.04), "2024-01-01", 2, 14); evw.push({ month: "2024-" + String(1 + (i % 36)).padStart(2, "0"), net: rr.net, gross: rr.gross }); }
  const w = monthStat(evw, "gross");
  ok("T8 independent random walks: |t gross| < 3", Math.abs(w.t) < 3 && Math.abs(w.meanOfMonths) < 0.01, `t ${w.t.toFixed(3)} mean ${w.meanOfMonths.toFixed(5)} k ${w.k}`);
  // T9 constant-signal analogue: shorting the pair each time vs BTC with pair == 2 x BTC log growth loses exactly the hand amount in a flat-then-up tape
  r = excess(mk(F, 30, (i) => 100 * 1.02 ** i), mk(F, 30, (i) => 100 * 1.01 ** i), F, 2, 14);
  ok("T9 alt 2%/day vs BTC 1%/day: short loses (1.02^12-1)-(1.01^12-1)", near(r.gross, (1.01 ** 12 - 1) - (1.02 ** 12 - 1), 1e-12), `gross ${r.gross.toFixed(6)}`);
  // T10 real-data plumbing check (only if cached): pair = BTC itself gives gross 0 on every real listing date
  try {
    const { events, btc } = loadUniverse();
    if (events.length) { const bad = events.filter((e) => { const rr = excess(btc, btc, e.F, 2, 14); return !rr || !near(rr.gross, 0); }).length; ok("T10 real cache: BTC-vs-BTC gross=0 on every real listing date", bad === 0, `${events.length} events, ${bad} bad`); }
    else console.log("skip T10 (no cached events yet)");
  } catch (e) { console.log("skip T10:", e.message); }
  console.log(fail ? `SELFTEST FAILED (${fail})` : "SELFTEST PASSED"); process.exit(fail ? 1 : 0);
}

// ---------------------------------------------------------------- the read
function read() {
  if (fs.existsSync(OUT)) throw new Error(`${ID} output exists (${OUT}) — read-once`);
  const seals = JSON.parse(fs.readFileSync(SEALS, "utf8")); if (seals.tests && seals.tests[ID]) throw new Error(`${ID} already sealed — read-once`);
  const reg = JSON.parse(fs.readFileSync(REG, "utf8")).preregistered.find((x) => x.id === ID); if (!reg || !reg.bar) throw new Error("registry entry missing");
  const BAR = reg.bar.tRequired; if (!(BAR > 0)) throw new Error("registry bar.tRequired unreadable");
  const { events, skipped, btc } = loadUniverse();
  if (skipped.notCached) throw new Error(`${skipped.notCached} products are not cached — run --fetch to completion first`);
  const meas = [];
  for (const e of events) {
    const lastNeeded = addDays(e.F, EXIT_DAY);
    if (lastNeeded > LAST) { skipped.notMeasurable.push(`${e.base}@${e.F} (D+14 ${lastNeeded} > ${LAST})`); continue; }
    const r = excess(e.rows, btc, e.F, ENTRY_DAY, EXIT_DAY);
    if (!r) { skipped.notMeasurable.push(`${e.base}@${e.F} (no entry candle)`); continue; }
    const delistedEarly = e.lastCandle < addDays(e.F, EXIT_DAY);
    meas.push({ ...e, gross: r.gross, net: r.net, staleEntry: r.staleEntry, staleExit: r.staleExit, delistedEarly, exitDay: addDays(e.F, EXIT_DAY) });
  }
  meas.sort((a, b) => a.F.localeCompare(b.F) || a.id.localeCompare(b.id));
  const n = meas.length; if (n < 10) throw new Error(`only ${n} measurable listings`);
  const net = meas.map((e) => e.net), gross = meas.map((e) => e.gross);
  const mNet = monthStat(meas, "net"), mGross = monthStat(meas, "gross");
  const meanNet = mean(net), meanGross = mean(gross), winRate = net.filter((x) => x > 0).length / n;
  // placebo
  const elig = meas.filter((e) => addDays(e.F, PL_HI) <= LAST && e.lastCandle >= addDays(e.F, PL_HI));
  const rnd = rng32(SEED), draws = placeboDraws(elig, btc, DRAWS, rnd), p95 = q95(draws), pMean = mean(draws);
  const matchedObs = mean(elig.map((e) => e.net)), matchedMonth = monthStat(elig, "net");
  const beatsFull = meanNet > p95, beatsMatched = matchedObs > p95;
  // halves (calendar midpoint of the registered window)
  const half = (xs) => { const m = monthStat(xs, "net"); return { n: xs.length, months: m.k, meanNet: xs.length ? mean(xs.map((e) => e.net)) : null, meanNetMonthMeans: m.meanOfMonths, tNet: m.t }; };
  const h1 = half(meas.filter((e) => e.F < MID)), h2 = half(meas.filter((e) => e.F >= MID));
  const sameSign = h1.meanNet != null && h2.meanNet != null && h1.meanNet > 0 && h2.meanNet > 0;
  // dollars / drawdown
  const years = (toMs(LAST) - toMs(WIN_START) + DAY_MS) / (365.25 * DAY_MS);
  const dollarsAt10k = (net.reduce((s, x) => s + x, 0) * NOTIONAL) / years;
  const byExit = [...meas].sort((a, b) => a.exitDay.localeCompare(b.exitDay) || a.id.localeCompare(b.id)); const dd = maxDrawdown(byExit.map((e) => e.net));
  // diagnostics (never decide)
  const srt = [...net].sort((a, b) => a - b), med = (srt[(n - 1) >> 1] + srt[n >> 1]) / 2;
  const w5 = srt.map((x, i) => (i < Math.ceil(0.05 * n) ? srt[Math.ceil(0.05 * n)] : i >= n - Math.ceil(0.05 * n) ? srt[n - Math.ceil(0.05 * n) - 1] : x)), wMean = mean(w5);
  const worst5 = [...meas].sort((a, b) => a.net - b.net).slice(0, 5).map((e) => `${e.base}@${e.F}:${(100 * e.net).toFixed(1)}%`);
  const without5 = (() => { const drop = new Set([...meas].sort((a, b) => a.net - b.net).slice(0, 5).map((e) => e.id)); const rest = meas.filter((e) => !drop.has(e.id)); const m = monthStat(rest, "net"); return { n: rest.length, meanNet: mean(rest.map((e) => e.net)), tNet: m.t }; })();
  const byYear = {}; for (const e of meas) (byYear[e.F.slice(0, 4)] ||= []).push(e.net);
  const yearCells = Object.fromEntries(Object.entries(byYear).map(([y, xs]) => [y, { n: xs.length, meanNet: mean(xs) }]));
  const df = mNet.k - 1;
  const stale = { entryStale: meas.filter((e) => e.staleEntry > 0).length, exitStale: meas.filter((e) => e.staleExit > 0).length, delistedBeforeExit: meas.filter((e) => e.delistedEarly).length };
  const pass = mNet.t != null && mNet.t >= BAR && beatsFull && beatsMatched && sameSign;
  const cell = { id: "ALL", rule: "short pair / long BTC, close D+2 -> close D+14", n, months: mNet.k, tNet: mNet.t, meanNet, meanNetMonthMeans: mNet.meanOfMonths, tGross: mGross.t, meanGross, passesAllBar: pass };
  const verdictScript = pass ? "PASS" : "DID NOT PASS";
  const out = {
    id: ID, key: KEY, name: reg.name, rule: reg.rule, window: `${WIN_START}..${LAST} (first candle; D+14 must be <= ${LAST})`, unit: "listings (cluster = listing month)",
    n, months: mNet.k, df, statistic: reg.statistic, bar: BAR, tNet: mNet.t, tGross: mGross.t, meanNet, meanGross, meanNetMonthMeans: mNet.meanOfMonths, meanGrossMonthMeans: mGross.meanOfMonths,
    tNetListingWeightedClusterRobust: robustT(meas, "net"), winRate,
    placebo: { draws: DRAWS, windowDays: "60-180 after listing, 12-day", eligibleListings: elig.length, p95, meanOfDraws: pMean, observed: meanNet, observedMatched: matchedObs, observedMatchedTNet: matchedMonth.t, beats: beatsFull && beatsMatched, beatsFull, beatsMatched, note: "BTC-minus-pair net mean per listing; both full and like-for-like (placebo-eligible) comparisons must beat p95" },
    halves: { split: `calendar midpoint ${MID}`, first: h1, second: h2, sameSignPositive: sameSign },
    cells: [cell], dollarsAt10k, dollarsNote: "$10k notional on EACH leg per listing; gross exposure $20k per listing; listings/yr x mean net", maxDD: dd, maxDDDollarsAt10k: dd * NOTIONAL, maxDDNote: "cumulative per-listing net, exit order, units of one notional",
    costModel: "25 bps/side on the pair and on BTC; entry+exit both legs = 100 bps per listing; the short is paper (real execution needs a perp: funding/borrow not charged)",
    dataSources: ["Coinbase Exchange public REST /products + /products/{id}/candles (86400s, UTC days), BTC-USD benchmark", "cache: backend/data/training/r302/"],
    universe: { usdProducts: events.length + skipped.preExisting + skipped.noCandleInWindow + skipped.outsideWindow + skipped.excluded.length, preExisting: skipped.preExisting, eventsInWindow: events.length, excludedStableOrWrapped: skipped.excluded, notMeasurable: skipped.notMeasurable, noCandleInWindow: skipped.noCandleInWindow, outsideWindow: skipped.outsideWindow },
    stale, diagnostics: { medianNet: med, winsorised5pctMeanNet: wMean, worst5, withoutWorst5: without5, byYear: yearCells, criticalT95OneSidedAtDf: df > 0 ? "see knownWeaknesses" : null },
    events: meas.map((e) => ({ base: e.base, F: e.F, status: e.status, gross: +e.gross.toFixed(5), net: +e.net.toFixed(5), staleEntry: e.staleEntry, staleExit: e.staleExit })),
    knownWeaknesses: [
      "Listing date = first Coinbase Exchange daily candle; announcement timestamps are not available, so D+2 is measured from first trade, not from the announcement the buyers reacted to.",
      "The short is paper: a real short needs a perp or borrow (funding, borrow cost, and availability not modelled); the 100 bps cost is a spot round trip on both legs.",
      `Effective N is ${mNet.k} listing-months (df ${df}), not ${n} listings; the registered bar 1.662 was sized at n=80 listings, so it is lenient against ${mNet.k} clusters.`,
      "A pair-minus-BTC excess is not beta-neutral: alts carry beta > 1 to the crypto tape, so a falling tape pays the short whether or not the listing matters; the placebo (same pairs, day 60-180) is the only control for that.",
      `Placebo needs 180 days of history, so only ${elig.length} of ${n} listings can be placebo-tested; recent listings are scored but uncontrolled.`,
      "Delisted pairs are in (88 delisted USD products are still served), but products removed from /products entirely cannot be seen: residual survivorship is possible.",
      "Pumps above +100% make the short lose more than its notional and are not capped; a handful of listings can carry the mean (see diagnostics).",
      "Coinbase Exchange candles are single-venue and thin on new listings; forward-filled stale prices are counted (stale block) and illiquid first-days fills are not modelled beyond the flat 25 bps.",
    ],
    verdictScript, readAt: new Date().toISOString(), scriptPath: "backend/r302-crypto-listing-fade.js",
  };
  writeJsonAtomic(OUT, out);
  console.log(`R302 ${KEY}: ${verdictScript}`);
  console.log(`  n ${n} listings in ${mNet.k} months (df ${df}); net t ${mNet.t == null ? "n/a" : mNet.t.toFixed(3)} vs bar ${BAR}; gross t ${mGross.t == null ? "n/a" : mGross.t.toFixed(3)}`);
  console.log(`  meanNet ${(100 * meanNet).toFixed(2)}%/listing (month-mean ${(100 * mNet.meanOfMonths).toFixed(2)}%), meanGross ${(100 * meanGross).toFixed(2)}%, winRate ${(100 * winRate).toFixed(1)}%, median ${(100 * med).toFixed(2)}%`);
  console.log(`  placebo p95 ${(100 * p95).toFixed(2)}% (draw mean ${(100 * pMean).toFixed(2)}%, ${elig.length} eligible) vs observed ${(100 * meanNet).toFixed(2)}% / matched ${(100 * matchedObs).toFixed(2)}% => beats ${beatsFull && beatsMatched}`);
  console.log(`  halves: first n${h1.n} ${(100 * h1.meanNet).toFixed(2)}% | second n${h2.n} ${(100 * h2.meanNet).toFixed(2)}%`);
  console.log(`  $/yr at $10k/leg ${dollarsAt10k.toFixed(0)}, maxDD ${(100 * dd).toFixed(1)}% of one notional; output ${OUT}`);
}

(async () => {
  if (mode === "--selftest") return selftest();
  if (mode === "--fetch") return fetchAll();
  if (mode === "--universe") {
    const { events, skipped } = loadUniverse();
    console.log(`USD products pre-existing (before 2023): ${skipped.preExisting}; not cached: ${skipped.notCached}; no candle in window: ${skipped.noCandleInWindow}; first candle outside window: ${skipped.outsideWindow}`);
    console.log(`excluded by name (stable/wrapped): ${skipped.excluded.join(", ") || "none"}`);
    console.log(`EVENTS (${events.length}) — names and dates only, no returns computed:`);
    for (const e of events) console.log(`${e.F}  ${e.base.padEnd(10)} ${e.status}  candles ${e.rows.length}  last ${e.lastCandle}`);
    return;
  }
  return read();
})().catch((e) => { console.error(`${ID} FAILED:`, e.message); process.exit(1); });
