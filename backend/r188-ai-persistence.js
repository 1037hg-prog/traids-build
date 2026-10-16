#!/usr/bin/env node
/**
 * R188 — ALPHAINSIDER PERSISTENCE, RANKED AGAINST EACH STRATEGY'S OWN ASSET. Registered 2026-09-24 (family AI-PERSIST-4, best-of-4)
 * BEFORE this file existed; rule, statistic, bar (2.47), controls and read condition are frozen in data/test-registry.json
 * (preregistered[id=R188]). Built 2026-09-24. Nothing here was chosen after seeing a persistence statistic: none has been computed.
 *
 * RULE (registry text, summarised): each month-end, public AlphaInsider strategies with >= the formation period of history and at
 * least one trade. HISTORICAL LEG: single-symbol strategies only, marked to market daily from their timestamped trades (holdings from
 * new_holdings; Alpaca SIP daily for stocks, Coinbase daily for crypto). ASSET-RELATIVE score = formation return minus buy-and-hold of
 * the symbol over the same months; RAW score = formation return. Formation 3 and 6 months, hold 1 month. FORWARD LEG: every strategy
 * from our own dated values (values-<day>.json) once 6 months accrue. STATISTIC: top-minus-bottom decile of the NEXT month's
 * asset-relative return (both rankings judged on that outcome), t over months (Newey-West lag 1); also the top decile alone.
 * PRIMARY: asset-relative, 6-month formation. CONTROLS: shuffle (scores shuffled within month, 200 draws, |t| < 2); peek (rank by
 * the next month's return, must clear the bar); survivorship disclosed.
 *
 * DATA: data/alphainsider/ written nightly by alphainsider-record.js (official API, read-only allowlist). THIS FILE NEVER CALLS THE
 * ALPHAINSIDER API. Prices: lib/alpaca-bars.js fetchBars (feed sip, adjustment split) and Coinbase Exchange public daily candles,
 * cached in data/training/r188/.
 *
 * IMPLEMENTATION NOTES (fixed before any outcome was computed):
 *  N1. Trade events: the timeline rows the recorder stores. Rows whose payload is empty (no action/price/holdings — seen 2026-09-24
 *      on 2 strategies, 2,536 rows) are DATA-LESS; a strategy with any data-less row cannot be classified or marked and is excluded
 *      (counted). Events are ordered by `at`, then numeric timeline_id.
 *  N2. SINGLE-SYMBOL = exactly one distinct stock_id across the strategy's whole recorded trade history (stock_id is AlphaInsider's
 *      stable security id; `symbol` is used only to fetch prices). Classification uses the full history, including trades after a
 *      given formation end — that is what the registered population "single-symbol strategies only" means, and it is a disclosed
 *      look-ahead in the POPULATION filter (never in a score). The same holds for the N5 drift exclusion.
 *  N3. TRUNCATION GUARD: a complete history starts flat at value 1. The first held event must satisfy new_holdings = +/-amount
 *      (nothing held before it) and |strategy_value - 1| <= 2%; otherwise the history is TRUNCATED and excluded. (Reason: the
 *      recorder's backfill stops at the first already-held row, so a backfill interrupted by the nightly budget and resumed the next
 *      night keeps only its newest pages — reported to the operator 2026-09-24; not fixed here.)
 *  N4. LEDGER (independent of the recorded values): cash starts at 1.0 (AlphaInsider's normalised start); buy: cash -= price x amount
 *      + fee_total; sell: cash += price x amount - fee_total. `total` is NOT used: in older rows it excludes the fee, in newer rows
 *      (2026) it includes it. Holdings = new_holdings (registered). Shorts are negative holdings. Dividends and any other non-trade cash
 *      events are not in the trade timeline, so they are not in the reconstruction; buy-and-hold is price-only (split-adjusted), so the
 *      asset-relative score compares like with like.
 *  N5. RECONSTRUCTION CHECK: at every trade, err = (cash + holdings x trade price) / recorded strategy_value - 1. AlphaInsider values
 *      the held position at its own mark, which on partial trims can be a stale price (seen: AMD 2026-01-16, CRWD 2026-09-14, a
 *      2-5% gap on ONE row that is gone at the next row). A transient mark is not drift, so DRIFT = max |err| over the trades after
 *      which the strategy is FLAT (holdings 0: value = cash exactly, no mark involved); a strategy that is never flat is judged on
 *      max |err| over ALL its trades (stricter). DRIFT > 2% -> excluded. The all-trade max and the per-trade distribution are also
 *      reported.
 *  N6. PRICE-SOURCE CHECK (part of "check the reconstruction": the ledger check never touches our price series): each trade's price
 *      is compared with our daily bar for its day (stocks: ET date; crypto: UTC date); distance = how far outside [low, high] it
 *      lies. More than 10% of a strategy's checkable trades over 2% outside the bar -> PRICE MISMATCH, excluded (wrong series, symbol
 *      reuse, or a split AlphaInsider did not restate). No checkable trade at all -> UNPRICED, excluded.
 *  N7. MARKING: a value point per bar of the symbol's own series. Stocks: bar date = session date, value at 16:00 ET that day using
 *      every trade stamped at or before it (early closes not modelled). Crypto: Coinbase UTC-day candle, value at the candle's close
 *      (next 00:00 UTC). Value = cash + holdings x close.
 *  N8. MONTH-END POINT = the last value point dated on/before the calendar month-end; missing or more than 7 days stale -> no point.
 *      Month-ends run from 2020-01 to the last complete month that is also covered by the timelines (state.json asOf).
 *  N9. ELIGIBILITY at formation end m for formation F: created_at <= the formation-start point's close instant (>= F months of
 *      history), >= 1 trade at or before the formation-end point, points at m-F, m and m+1 for both strategy and symbol, and a positive
 *      strategy value at m-F and m (a leveraged strategy can go through zero; its return is undefined -> excluded, counted).
 *      Scores: RAW = V(m)/V(m-F) - 1; ASSET-RELATIVE = RAW - (P(m)/P(m-F) - 1). Outcome = (V(m+1)/V(m) - 1) - (P(m+1)/P(m) - 1).
 *  N10. DECILES: a month enters only with breadth N >= 50 names (5 per decile; fixed here, from no outcome); k = floor(N/10) at each
 *      end. Sort by score descending; ties broken by a seeded random key (mulberry32, seed from 18801 + variant + month), never row
 *      order. Spread = mean outcome of the top k minus mean outcome of the bottom k, equal weight.
 *  N11. t over months = Newey-West, lag 1 (Bartlett weight 1/2), long-run variance = gamma0 + 2 x 0.5 x gamma1 with 1/T autocovariances
 *      of the demeaned series; t = mean / sqrt(LRV / T). Applied to ALL FOUR variants: with monthly steps the 3-month formations overlap
 *      month to month as well as the 6-month ones. The plain t is reported beside it.
 *  N12. VERDICT is taken on the PRIMARY (asset-relative, 6-month): NW t >= 2.47 -> PASS, else DID NOT PASS. The 2.47 bar already
 *      prices four variants; the other three are reported, never promoted (conservative reading of "Primary").
 *  N13. SHUFFLE CONTROL: within each month the scores are permuted among that month's names (seeded Fisher-Yates, seed 18802), the
 *      spread series and NW t recomputed, 200 draws. The registered "|t| < 2" is read as the MEDIAN |t| over the 200 draws < 2 — a
 *      harness-validity check (a mechanical bias in the decile/tie/NW pipeline shows up as a shifted median; a single draw or the 95th
 *      percentile of a null would fail ~5% / by construction). The true t's rank in the shuffle distribution is reported too.
 *  N14. PEEK CONTROL: the score replaced by the month's own outcome, same universe, same deciles; NW t must be >= 2.47.
 *  N15. The read SEALS only if shuffle and peek pass on the primary. Fewer than 12 qualifying months (bar computed for n = 18) ->
 *      verdict INCONCLUSIVE (underpowered), sealed under the same control condition.
 *  N16. READ CONDITION. Single-symbol status can be known only AFTER a strategy's timeline is backfilled (the strategies file carries no
 *      symbols), so "every single-symbol strategy with trades is backfilled" is enforced as: every strategy in the latest
 *      strategies-<day>.json created on/before the LAST possible formation start (last formation end minus 3 months) is in
 *      state.json backfill — a later-created strategy cannot enter any historical month. Also: state.json asOf within 3 days, and
 *      R188 not already sealed. --read refuses otherwise.
 *  N17. FORWARD LEG: month-end snapshot = the last values-<day>.json on/before the month-end, within 3 days. The first 6-month
 *      observation needs 8 snapshots (7 points + the outcome month); the registered forward read is at 12 months. Asset-relative needs
 *      a symbol: single-symbol by trades up to the formation end. The registration does not define "its own asset" for a MULTI-symbol
 *      strategy — an amendment is needed before the forward read; until then the code ranks single-symbol strategies only.
 *  N18. Survivorship: deleted strategies are invisible to the API (registered known weakness); the forward leg removes it going forward.
 *
 *   node backend/r188-ai-persistence.js --status      coverage, months, breadth, reconstruction error (no persistence statistic)
 *   node backend/r188-ai-persistence.js --selftest    fabricated strategies with known values: marking, ledger, deciles, NW, controls
 *   node backend/r188-ai-persistence.js --read        the one read (refuses unless N16 holds); seals if controls pass
 *   node backend/r188-ai-persistence.js --forward     forward-leg accrual
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const AI = D("alphainsider"), TL = path.join(AI, "timelines"), CACHE = D(path.join("training", "r188"));
const ID = "R188", OUT = D("r188-ai-persistence.json");
const FORMATIONS = [6, 3], MIN_BREADTH = 50, MIN_MONTHS = 12, DRIFT_MAX = 0.02, PRICE_TOL = 0.02, PRICE_BAD_SHARE = 0.10, STALE_DAYS = 7, DRAWS = 200;
const VARIANTS = [
  { key: "AR-6", score: "ar", F: 6, primary: true }, { key: "AR-3", score: "ar", F: 3 },
  { key: "RAW-6", score: "raw", F: 6 }, { key: "RAW-3", score: "raw", F: 3 },
];
const DAY = 864e5;

// ── small maths ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const plainT = (a) => (a.length < 2 ? null : mean(a) / (sd(a) / Math.sqrt(a.length)));
function nwT(a, lag = 1) {
  const T = a.length; if (T < 3) return null;
  const m = mean(a), e = a.map((x) => x - m);
  let lrv = e.reduce((s, x) => s + x * x, 0) / T;
  for (let L = 1; L <= lag; L++) { let g = 0; for (let i = L; i < T; i++) g += e[i] * e[i - L]; lrv += 2 * (1 - L / (lag + 1)) * (g / T); }
  return lrv > 0 ? m / Math.sqrt(lrv / T) : null;
}
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const quant = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]; };
const r4 = (x) => (x == null || !Number.isFinite(x) ? x : +x.toFixed(4)), r6 = (x) => (x == null || !Number.isFinite(x) ? x : +x.toFixed(6));
const todayET = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const etDate = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const hourNY = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" });
function etCloseMs(d) {        // 16:00 America/New_York on session date d, as a UTC instant
  for (const off of [4, 5]) { const ms = Date.parse(`${d}T${String(16 + off).padStart(2, "0")}:00:00Z`); if (+hourNY.format(new Date(ms)) === 16) return ms; }
  throw new Error(`no 16:00 ET for ${d}`);
}
function monthEnds(fromYM, toYM) {   // inclusive, "YYYY-MM"
  const out = []; let [y, m] = fromYM.split("-").map(Number); const [ty, tm] = toYM.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) { out.push(new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)); m++; if (m > 12) { m = 1; y++; } }
  return out;
}

// ── data loading (never the API) ────────────────────────────────────────────────────────────────────────────────────────────────
function latestDated(prefix) {
  const f = fs.readdirSync(AI).filter((x) => x.startsWith(prefix + "-") && x.endsWith(".json")).sort();
  return f.length ? path.join(AI, f[f.length - 1]) : null;
}
// Amendment 2026-09-25 (pre-read, operator-approved line of work): strategies listed in data/r188-excluded.json (API cannot return their full
// history) are excluded ENTIRELY — from the gate count and from the sample — never entered truncated. Disclosed in every output.
const EXCLUDED = (() => { try { return new Set(JSON.parse(fs.readFileSync(D("r188-excluded.json"), "utf8")).excluded.map((x) => x.strategy_id)); } catch { return new Set(); } })();
function loadStrategies() { const f = latestDated("strategies"); if (!f) throw new Error("no strategies-<day>.json"); const j = JSON.parse(fs.readFileSync(f, "utf8")); return { day: j.day, list: j.strategies.filter((x) => !EXCLUDED.has(x.strategy_id)), excluded: [...EXCLUDED] }; }
function loadState() { return JSON.parse(fs.readFileSync(path.join(AI, "state.json"), "utf8")); }
function loadTimeline(id) {
  const f = path.join(TL, `${id}.jsonl`); if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
/** N1–N3: classify one strategy from its raw timeline rows. */
function classify(rows) {
  if (!rows.length) return { cls: "no-trades" };
  const dataless = rows.filter((e) => !e.action), ev = rows.filter((e) => e.action);
  if (dataless.length) return { cls: ev.length ? "partial-data" : "data-less", rows: rows.length, dataless: dataless.length };
  ev.sort((a, b) => a.at.localeCompare(b.at) || (+a.timeline_id) - (+b.timeline_id));
  const ids = new Set(ev.map((e) => e.stock_id));
  if (ids.size !== 1) return { cls: "multi-symbol", n: ev.length, symbols: ids.size };
  const e0 = ev[0], s0 = e0.action === "buy" ? 1 : -1, h0 = +e0.new_holdings;
  const truncated = Math.abs(h0 - s0 * (+e0.amount)) > 1e-9 * Math.max(1, Math.abs(h0)) || Math.abs(+e0.strategy_value - 1) > 0.02;
  const crypto = e0.security === "cryptocurrency";
  return { cls: truncated ? "truncated" : "single", ev, symbol: e0.symbol, crypto, stockId: e0.stock_id, n: ev.length };
}
/** N4–N5: the independent ledger and its drift from the recorded values. */
function ledger(ev) {
  let cash = 1, H = 0; const rows = [];
  for (const e of ev) {
    const s = e.action === "buy" ? 1 : -1, px = +e.price, amt = +e.amount, fee = +e.fee_total || 0, Hb = H;
    cash -= s * px * amt + fee; H = +e.new_holdings;
    const rec = cash + H * px, V = +e.strategy_value;
    rows.push({ t: Date.parse(e.at), cash, H, px, V, err: rec / V - 1, flat: Math.abs(H) < 1e-15, holdGap: Hb + s * amt - H });
  }
  const flat = rows.filter((r) => r.flat), basis = flat.length ? flat : rows;
  const maxAbs = (a) => a.reduce((m, r) => Math.max(m, Math.abs(r.err)), 0);
  return { rows, drift: maxAbs(basis), driftBasis: flat.length ? "flat-points" : "all-trades", driftAll: maxAbs(rows), flatPoints: flat.length };
}
/** N6: trade price against our bar for that day. bars: Map date -> {l,h,c,closeMs} */
function priceCheck(ev, bars, crypto) {
  let checked = 0, bad = 0; const dists = [];
  for (const e of ev) {
    const t = Date.parse(e.at), b = bars.get(crypto ? utcDate(t) : etDate(t)); if (!b) continue;
    const p = +e.price, d = p < b.l ? (b.l - p) / b.l : p > b.h ? (p - b.h) / b.h : 0;
    checked++; dists.push(d); if (d > PRICE_TOL) bad++;
  }
  return { checked, bad, badShare: checked ? bad / checked : null, medianDist: quant(dists, 0.5), ok: checked > 0 && bad / checked <= PRICE_BAD_SHARE };
}
/** N7: daily marked series from ledger rows over the symbol's bars (sorted [{d,c,closeMs}]). */
function markSeries(lrows, barList) {
  const out = []; let i = 0, cash = 1, H = 0;
  for (const b of barList) {
    while (i < lrows.length && lrows[i].t <= b.closeMs) { cash = lrows[i].cash; H = lrows[i].H; i++; }
    out.push({ d: b.d, closeMs: b.closeMs, v: cash + H * b.c, c: b.c, H });   // H = holdings at this close (R211 reads exposure from it)
  }
  return out;
}
/** N8: last point on/before month-end, not stale. */
function pointAt(series, me) {
  let lo = 0, hi = series.length - 1, k = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (series[mid].d <= me) { k = mid; lo = mid + 1; } else hi = mid - 1; }
  if (k < 0) return null;
  if (Date.parse(me) - Date.parse(series[k].d) > STALE_DAYS * DAY) return null;
  return series[k];
}

// ── prices (cached) ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
function readCache(name) { const f = path.join(CACHE, name); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : { symbols: {} }; }
function saveCache(name, c) { if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true }); c.savedAt = new Date().toISOString(); writeJsonAtomic(path.join(CACHE, name), c, { pretty: 0 }); }
async function stockBars(symbols, start, end) {
  const c = readCache("stock-bars.json"), need = symbols.filter((s) => { const x = c.symbols[s]; return !x || x.start > start || x.end < end; });
  if (need.length) {
    const { fetchBars } = require("./lib/alpaca-bars.js");
    const r = await fetchBars(need, { start, end, timeframe: "1Day", feed: "sip", adjustment: "split", requireAll: false, quiet: true });
    for (const s of need) c.symbols[s] = { start, end, fetchedAt: new Date().toISOString(), rows: (r.bars[s] || []).map((b) => [String(b.t).slice(0, 10), b.o, b.h, b.l, b.c]) };
    saveCache("stock-bars.json", c);
  }
  const out = {};
  for (const s of symbols) out[s] = c.symbols[s].rows.map(([d, o, h, l, cl]) => ({ d, o, h, l, c: cl, closeMs: etCloseMs(d) }));
  return out;
}
async function coinbaseDaily(product, start, end) {
  const rows = new Map(); let t = Date.parse(start + "T00:00:00Z"); const stop = Date.parse(end + "T00:00:00Z");
  while (t <= stop) {
    const e = Math.min(t + 299 * DAY, stop);
    const u = `https://api.exchange.coinbase.com/products/${encodeURIComponent(product)}/candles?granularity=86400&start=${new Date(t).toISOString()}&end=${new Date(e).toISOString()}`;
    let r, j;
    for (let k = 0; k < 4; k++) { r = await fetch(u, { headers: { "User-Agent": "traids-research" }, signal: AbortSignal.timeout(20000) }); if (r.ok) break; if (r.status === 404) return null; await nap(2000 * (k + 1)); }
    if (!r.ok) throw new Error(`Coinbase ${product} daily ${r.status}`);
    j = await r.json();
    for (const [ts, lo, hi, op, cl] of j) rows.set(ts, [utcDate(ts * 1000), op, hi, lo, cl]);
    t = e + DAY; await nap(350);
  }
  return [...rows.values()].sort((a, b) => a[0].localeCompare(b[0]));
}
async function cryptoBars(products, start, end) {
  const c = readCache("crypto-bars.json");
  for (const p of products) {
    const x = c.symbols[p]; if (x && x.start <= start && x.end >= end) continue;
    const rows = await coinbaseDaily(p, start, end);
    c.symbols[p] = { start, end, fetchedAt: new Date().toISOString(), rows: rows || [], missing: !rows };
    saveCache("crypto-bars.json", c);
  }
  const out = {};
  for (const p of products) out[p] = c.symbols[p].rows.map(([d, o, h, l, cl]) => ({ d, o, h, l, c: cl, closeMs: Date.parse(d + "T00:00:00Z") + DAY }));
  return out;
}

// ── panel construction ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Build each single-symbol strategy's reconstruction and exclusion status. Returns { strategies:[...], counts, errors }. */
async function buildUniverse({ strategies, state, fetchPrices = true }) {
  const byCls = {}, singles = [];
  for (const s of strategies) {
    if (!state.backfill[s.strategy_id]) { byCls["not-backfilled"] = (byCls["not-backfilled"] || 0) + 1; continue; }
    const c = classify(loadTimeline(s.strategy_id)); byCls[c.cls] = (byCls[c.cls] || 0) + 1;
    if (c.cls === "single") singles.push({ id: s.strategy_id, name: s.name, created: s.created_at, type: s.type, ...c });
  }
  if (!fetchPrices) return { byCls, singles };
  // last COMPLETED ET session date (free SIP refuses today's data; a UTC "yesterday" is today in ET after 00:00 UTC)
  const endD = new Date(Date.parse(todayET() + "T12:00:00Z") - DAY).toISOString().slice(0, 10);
  const minStart = (a) => a.reduce((m, x) => (x.created < m ? x.created : m), "9999").slice(0, 10);
  const stk = singles.filter((x) => !x.crypto), cry = singles.filter((x) => x.crypto);
  const start = new Date(Date.parse(minStart(singles) || endD) - 10 * DAY).toISOString().slice(0, 10);
  const sBars = stk.length ? await stockBars([...new Set(stk.map((x) => x.symbol))], start, endD) : {};
  const cBars = cry.length ? await cryptoBars([...new Set(cry.map((x) => x.symbol))], start, endD) : {};
  for (const x of singles) {
    const list = (x.crypto ? cBars : sBars)[x.symbol] || [];
    x.bars = list; x.led = ledger(x.ev);
    x.price = priceCheck(x.ev, new Map(list.map((b) => [b.d, b])), x.crypto);
    x.exclude = !list.length ? "no-price-series" : !x.price.ok ? (x.price.checked ? "price-mismatch" : "unpriced") : x.led.drift > DRIFT_MAX ? "drift" : null;
    if (!x.exclude) x.series = markSeries(x.led.rows, list);
  }
  return { byCls, singles };
}
/** N9: the eligible cross-section for formation F at month-end index m (m-F >= 0, m+1 < ME.length). Values only — no ranking. */
function crossSection(singles, ME, m, F, counts, countOnly = false) {   // countOnly: eligibility only, no return is computed (--status)
  const out = [];
  for (const x of singles) {
    if (x.exclude) continue;
    const p0 = pointAt(x.series, ME[m - F]), p1 = pointAt(x.series, ME[m]), p2 = pointAt(x.series, ME[m + 1]);
    if (!p0 || !p1 || !p2) { if (counts) counts.noPoint = (counts.noPoint || 0) + 1; continue; }
    if (Date.parse(x.created) > p0.closeMs) continue;                               // < F months of history
    if (!(x.led.rows[0].t <= p1.closeMs)) continue;                                   // no trade by the formation end
    if (!(p0.v > 0 && p1.v > 0)) { if (counts) counts.nonPositive = (counts.nonPositive || 0) + 1; continue; }
    if (countOnly) { out.push({ id: x.id }); continue; }
    const raw = p1.v / p0.v - 1, bh = p1.c / p0.c - 1;
    out.push({ id: x.id, raw, ar: raw - bh, out: (p2.v / p1.v - 1) - (p2.c / p1.c - 1) });
  }
  return out;
}
/** N10: decile spread for one month. rows [{score,out}] */
function decileMonth(rows, seed) {
  const N = rows.length, k = Math.floor(N / 10); if (N < MIN_BREADTH || k < 1) return null;
  const rng = mulberry(seed), keyed = rows.map((r) => ({ ...r, tie: rng() }));
  keyed.sort((a, b) => b.score - a.score || a.tie - b.tie);
  const top = keyed.slice(0, k), bot = keyed.slice(N - k);
  const mt = mean(top.map((r) => r.out)), mb = mean(bot.map((r) => r.out));
  return { N, k, spread: mt - mb, top: mt, bottom: mb, topIds: top.map((r) => r.id) };
}
function shuffleWithin(rows, rng) {
  const sc = rows.map((r) => r.score);
  for (let i = sc.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [sc[i], sc[j]] = [sc[j], sc[i]]; }
  return rows.map((r, i) => ({ ...r, score: sc[i] }));
}
/** Full statistic for one variant over a panel { months:[{me, rows:[{id,raw,ar,out}]}] }. */
function variantStats(panel, v, vIdx, bar) {
  const pick = (rows) => rows.map((r) => ({ id: r.id, score: v.score === "ar" ? r.ar : r.raw, out: r.out }));
  const per = [];
  panel.forEach((mo, mi) => { const d = decileMonth(pick(mo.rows), 18801 + vIdx * 1000 + mi); if (d) per.push({ me: mo.me, ...d }); });
  const spreads = per.map((p) => p.spread), tops = per.map((p) => p.top);
  const res = { months: per.length, meanSpread: per.length ? mean(spreads) : null, nwT: nwT(spreads), plainT: plainT(spreads),
    topAlone: { mean: per.length ? mean(tops) : null, nwT: nwT(tops), plainT: plainT(tops) }, perMonth: per.map((p) => ({ me: p.me, N: p.N, k: p.k, spread: r6(p.spread), top: r6(p.top), bottom: r6(p.bottom) })) };
  // controls
  const rng = mulberry(18802 + vIdx);
  const shufT = [];
  for (let d = 0; d < DRAWS; d++) {
    const s = [];
    panel.forEach((mo, mi) => { const dm = decileMonth(shuffleWithin(pick(mo.rows), rng), 18801 + vIdx * 1000 + mi); if (dm) s.push(dm.spread); });
    shufT.push(nwT(s));
  }
  const absT = shufT.filter((x) => x != null).map(Math.abs);
  const peekSpreads = [];
  panel.forEach((mo, mi) => { const d = decileMonth(mo.rows.map((r) => ({ id: r.id, score: r.out, out: r.out })), 18801 + vIdx * 1000 + mi); if (d) peekSpreads.push(d.spread); });
  const peekT = nwT(peekSpreads);
  res.controls = {
    shuffle: { draws: DRAWS, seed: 18802 + vIdx, medianAbsT: r4(quant(absT, 0.5)), p95AbsT: r4(quant(absT, 0.95)), pass: absT.length === DRAWS && quant(absT, 0.5) < 2,
      trueTPercentile: res.nwT == null ? null : r4(shufT.filter((x) => x != null && x < res.nwT).length / DRAWS) },
    peek: { nwT: r4(peekT), bar, pass: peekT != null && peekT >= bar },
  };
  res.nwT = r4(res.nwT); res.plainT = r4(res.plainT); res.meanSpread = r6(res.meanSpread);
  res.topAlone = { mean: r6(res.topAlone.mean), nwT: r4(res.topAlone.nwT), plainT: r4(res.topAlone.plainT) };
  return res;
}

// ── read condition (N16) ────────────────────────────────────────────────────────────────────────────────────────────────────────
function historyWindow(state) {
  const asOf = state.asOf ? state.asOf.slice(0, 10) : todayET();
  const cap = todayET() < asOf ? todayET() : asOf;               // the last complete month must be covered by the timelines
  const [y, m] = cap.split("-").map(Number), prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const ME = monthEnds("2020-01", prev);                        // ME[last] = last complete month-end (an outcome month)
  const lastFormEnd = ME[ME.length - 2], lastFormStart = ME[ME.length - 2 - Math.min(...FORMATIONS)];
  return { ME, lastFormEnd, lastFormStart };
}
function readGate(strategies, state) {
  const { lastFormStart } = historyWindow(state);
  const need = strategies.filter((s) => s.created_at.slice(0, 10) <= lastFormStart);
  const missing = need.filter((s) => !state.backfill[s.strategy_id]);
  const ageDays = state.asOf ? (Date.now() - Date.parse(state.asOf)) / DAY : Infinity;
  const sealed = !!JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")).tests[ID];
  return { lastFormStart, required: need.length, backfilled: need.length - missing.length, missing: missing.length, stateAgeDays: +ageDays.toFixed(2), sealed,
    allowed: !missing.length && ageDays <= 3 && !sealed };
}
function backfillProjection(strategies, state) {
  // calls a night: --budget=700 (close-chain). Fixed daily calls: enumerate ceil(N/100) + values ceil(N/25) + ranks 8; incremental
  // >= ceil(done/25); the rest backfills at the mean calls/strategy observed so far (floor(trades/100)+1 each, a lower bound).
  const N = strategies.length, ids = strategies.map((s) => s.strategy_id);
  let done = ids.filter((id) => state.backfill[id]).length, calls = 0, n = 0;
  for (const id of ids) if (state.backfill[id]) { const k = loadTimeline(id).length; calls += Math.floor(k / 100) + 1; n++; }
  const perStrat = n ? calls / n : 1.5, fixed = Math.ceil(N / 100) + Math.ceil(N / 25) + 8;
  let nights = 0; const start = done;
  while (done < N && nights < 400) { const avail = 700 - fixed - Math.ceil(done / 25); if (avail <= 0) return { nights: null, note: "budget exhausted by fixed + incremental calls" }; done = Math.min(N, done + Math.floor(avail / perStrat)); nights++; }
  return { budgetPerNight: 700, fixedCallsPerNight: fixed, meanCallsPerStrategy: +perStrat.toFixed(2), backfilledNow: start, total: N, nightsToFull: nights, note: "close-chain nights (trading days); new strategies (~10/day in 2026) add to the tail" };
}

// ── modes ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function status() {
  const { day, list } = loadStrategies(), state = loadState(), gate = readGate(list, state), { ME } = historyWindow(state);
  const U = await buildUniverse({ strategies: list, state });
  const sing = U.singles, used = sing.filter((x) => !x.exclude);
  const excl = {}; for (const x of sing) if (x.exclude) excl[x.exclude] = (excl[x.exclude] || 0) + 1;
  const errs = sing.flatMap((x) => x.led.rows.map((r) => Math.abs(r.err))), drift = sing.map((x) => x.led.drift), driftAll = sing.map((x) => x.led.driftAll);
  const dist = (a) => ({ n: a.length, p50: r4(quant(a, 0.5)), p90: r4(quant(a, 0.9)), p99: r4(quant(a, 0.99)), max: r4(a.length ? Math.max(...a) : null), over2pct: a.filter((x) => x > 0.02).length });
  const breadth = {};
  for (const F of FORMATIONS) {
    breadth[F] = [];
    for (let m = F; m + 1 < ME.length; m++) { const cs = crossSection(used, ME, m, F, null, true); if (cs.length) breadth[F].push({ formationEnd: ME[m], names: cs.length, qualifies: cs.length >= MIN_BREADTH }); }
  }
  const bf = list.filter((s) => state.backfill[s.strategy_id]).length, withTrades = Object.entries(U.byCls).filter(([k]) => !["no-trades", "not-backfilled"].includes(k)).reduce((s, [, v]) => s + v, 0);
  const out = {
    asOf: new Date().toISOString(), strategiesDay: day, timelinesAsOf: state.asOf,
    backfill: { strategies: list.length, backfilled: bf, pct: +(100 * bf / list.length).toFixed(1), classes: U.byCls, withTrades,
      singleSymbolShareOfTraded: withTrades ? +(100 * ((U.byCls.single || 0) + (U.byCls.truncated || 0)) / withTrades).toFixed(1) : null,
      projection: backfillProjection(list, state) },
    readGate: gate,
    reconstruction: { singleSymbol: sing.length, usable: used.length, excluded: excl, perTradeAbsErr: dist(errs), strategyDrift_flatPointsOrAll: dist(drift), strategyDrift_allTrades: dist(driftAll),
      priceCheck: { strategies: sing.length, ok: sing.filter((x) => x.price.ok).length, medianBadShare: r4(quant(sing.filter((x) => x.price.checked).map((x) => x.price.badShare), 0.5)) },
      worst: sing.filter((x) => x.exclude || x.led.driftAll > 0.02).map((x) => ({ id: x.id, symbol: x.symbol, trades: x.n, drift: r4(x.led.drift), basis: x.led.driftBasis, driftAll: r4(x.led.driftAll), priceBadShare: r4(x.price.badShare), exclude: x.exclude })) },
    months: { formationEnds: `${ME[0]}..${ME[ME.length - 2]}`, minBreadth: MIN_BREADTH, qualifying: Object.fromEntries(FORMATIONS.map((F) => [F, breadth[F].filter((b) => b.qualifies).length])), breadth },
  };
  writeJsonAtomic(path.join(CACHE, "status.json"), out);
  const p = out.backfill.projection;
  console.log(`R188 STATUS  strategies ${day} · timelines asOf ${state.asOf}`);
  console.log(`  backfill: ${bf}/${list.length} (${out.backfill.pct}%) · classes ${JSON.stringify(U.byCls)}`);
  console.log(`  projection: ~${p.nightsToFull} close-chain nights to full backfill (700 calls/night, ${p.fixedCallsPerNight} fixed, ${p.meanCallsPerStrategy} calls/strategy so far)`);
  console.log(`  read gate: ${gate.backfilled}/${gate.required} strategies created <= ${gate.lastFormStart} backfilled · state age ${gate.stateAgeDays}d · sealed ${gate.sealed} -> ${gate.allowed ? "READ ALLOWED" : "READ REFUSED"}`);
  console.log(`  single-symbol: ${sing.length} (usable ${used.length}) · excluded ${JSON.stringify(excl)}`);
  console.log(`  per-trade |err| p50 ${out.reconstruction.perTradeAbsErr.p50} p90 ${out.reconstruction.perTradeAbsErr.p90} p99 ${out.reconstruction.perTradeAbsErr.p99} max ${out.reconstruction.perTradeAbsErr.max} (${out.reconstruction.perTradeAbsErr.over2pct} trades >2%)`);
  console.log(`  strategy drift (flat points, else all) p50 ${out.reconstruction.strategyDrift_flatPointsOrAll.p50} p90 ${out.reconstruction.strategyDrift_flatPointsOrAll.p90} max ${out.reconstruction.strategyDrift_flatPointsOrAll.max}; all-trade max >2%: ${out.reconstruction.strategyDrift_allTrades.over2pct}`);
  console.log(`  price check ok ${out.reconstruction.priceCheck.ok}/${sing.length}`);
  for (const w of out.reconstruction.worst) console.log(`    ${w.id} ${w.symbol} n=${w.trades} drift ${w.drift} (${w.basis}) all ${w.driftAll} priceBad ${w.priceBadShare} -> ${w.exclude || "kept"}`);
  for (const F of FORMATIONS) console.log(`  F=${F}: ${out.months.qualifying[F]} months with >= ${MIN_BREADTH} names; breadth ${breadth[F].map((b) => `${b.formationEnd.slice(0, 7)}:${b.names}`).join(" ")}`);
  console.log(`  forward: ${JSON.stringify(forwardStatus())}`);
  console.log(`  -> data/training/r188/status.json`);
}

function forwardStatus() {
  const days = fs.readdirSync(AI).filter((f) => /^values-\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(7, 17)).sort();
  if (!days.length) return { state: "accruing", days: 0 };
  const first = days[0], last = days[days.length - 1];
  const snaps = monthEnds(first.slice(0, 7), last.slice(0, 7)).filter((me) => days.some((d) => d <= me && Date.parse(me) - Date.parse(d) <= 3 * DAY));
  return { state: snaps.length >= 8 ? "first 6-month observation available (read at 12 months; multi-symbol benchmark needs an amendment, N17)" : "accruing",
    firstDay: first, lastDay: last, days: days.length, monthEndSnapshots: snaps.length, snapshotsForFirstObservation: 8, readAt: "12 months of forward data" };
}
/** N17: forward panel from values files (built, not read until the registered forward condition). */
function forwardPanel(symbolSeries) {
  const days = fs.readdirSync(AI).filter((f) => /^values-\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(7, 17)).sort();
  const snap = {};
  for (const me of monthEnds(days[0].slice(0, 7), days[days.length - 1].slice(0, 7))) {
    const d = days.filter((x) => x <= me && Date.parse(me) - Date.parse(x) <= 3 * DAY).pop();
    if (d) snap[me] = { day: d, values: JSON.parse(fs.readFileSync(path.join(AI, `values-${d}.json`), "utf8")).values };
  }
  const ME = Object.keys(snap).sort(), months = [];
  for (let m = 6; m + 1 < ME.length; m++) {
    const rows = [];
    for (const [id, v0] of Object.entries(snap[ME[m - 6]].values)) {
      const v1 = snap[ME[m]].values[id], v2 = snap[ME[m + 1]].values[id], ss = symbolSeries(id, ME[m]);
      if (!(v0 > 0 && v1 > 0 && v2 > 0) || !ss) continue;
      const p0 = pointAt(ss, ME[m - 6]), p1 = pointAt(ss, ME[m]), p2 = pointAt(ss, ME[m + 1]); if (!p0 || !p1 || !p2) continue;
      const raw = v1 / v0 - 1; rows.push({ id, raw, ar: raw - (p1.c / p0.c - 1), out: (v2 / v1 - 1) - (p2.c / p1.c - 1) });
    }
    months.push({ me: ME[m], rows });
  }
  return months;
}

async function read() {
  const ENTRY = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")).preregistered.find((t) => t.id === ID);
  if (!ENTRY) throw new Error(`${ID} not registered`);
  const BAR = ENTRY.bar.tRequired;
  const { list } = loadStrategies(), state = loadState(), gate = readGate(list, state);
  if (!gate.allowed) {
    console.error(`${ID} --read REFUSED: ${gate.sealed ? "already sealed" : `${gate.missing} of ${gate.required} strategies that could enter the historical leg are not backfilled (state age ${gate.stateAgeDays}d)`}`);
    process.exit(2);
  }
  const { ME } = historyWindow(state);
  const U = await buildUniverse({ strategies: list, state });
  const used = U.singles.filter((x) => !x.exclude);
  const panels = {}, counts = {};
  for (const F of FORMATIONS) { counts[F] = {}; panels[F] = []; for (let m = F; m + 1 < ME.length; m++) panels[F].push({ me: ME[m], rows: crossSection(used, ME, m, F, counts[F]) }); }
  const results = {};
  VARIANTS.forEach((v, i) => { results[v.key] = variantStats(panels[v.F], v, i, BAR); });
  const P = results["AR-6"], ctrlOk = P.controls.shuffle.pass && P.controls.peek.pass;
  const verdict = P.months < MIN_MONTHS ? `INCONCLUSIVE (underpowered) — ${P.months} qualifying months (< ${MIN_MONTHS}); primary NW t ${P.nwT} vs bar ${BAR}`
    : P.nwT != null && P.nwT >= BAR ? `PASS — asset-relative 6-month top-minus-bottom next-month spread ${(100 * P.meanSpread).toFixed(2)}%/month, NW t ${P.nwT} >= ${BAR} over ${P.months} months`
    : `DID NOT PASS — asset-relative 6-month top-minus-bottom next-month spread ${P.meanSpread == null ? "n/a" : (100 * P.meanSpread).toFixed(2) + "%/month"}, NW t ${P.nwT} vs bar ${BAR} over ${P.months} months`;
  const out = { id: ID, readAt: new Date().toISOString(), bar: BAR, gate, universe: { classes: U.byCls, singleSymbol: U.singles.length, usable: used.length,
      excluded: U.singles.filter((x) => x.exclude).map((x) => ({ id: x.id, symbol: x.symbol, why: x.exclude, drift: r4(x.led.drift), priceBadShare: r4(x.price.badShare) })) },
    eligibilityCounts: counts, results, controlsPass: ctrlOk, verdict, notes: "see script header N1-N18" };
  writeJsonAtomic(OUT, out);
  for (const v of VARIANTS) { const r = results[v.key]; console.log(`  ${v.key}${v.primary ? " (primary)" : ""}: months ${r.months} spread ${r.meanSpread} NW t ${r.nwT} (plain ${r.plainT}) · top ${r.topAlone.mean} t ${r.topAlone.nwT} · shuffle med|t| ${r.controls.shuffle.medianAbsT} · peek t ${r.controls.peek.nwT}`); }
  console.log(`\n  VERDICT: ${verdict}`);
  if (!ctrlOk) { console.log("  controls FAILED on the primary — NOT sealed; investigate the harness"); return; }
  const today = todayET();
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests[ID]) throw new Error("sealed concurrently — not overwriting");
  seals.tests[ID] = { sealedOn: today, unit: "months (formation ends; asset-relative 6-month primary)", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E = reg.preregistered.find((t) => t.id === ID);
  E.status = `READ ${today} (historical leg) — ${verdict}; forward leg accruing`; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: ID, verdict }) + "\n");
  console.log(`  sealed ${ID} (${today})`);
}

// ── self-test: fabricated strategies with known values (no real data touched) ──────────────────────────────────────────────────
function selftest() {
  const ok = [], bad = [], check = (name, cond, detail) => (cond ? ok : bad).push(detail ? `${name} (${detail})` : name);
  const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
  // 1. MARKING. Symbol SYN, 6 sessions; closes known. Trades (intraday, ET):
  //    d1 10:00 buy 0.01 @100 fee 0.001      cash 1 - 1 - .001 = -0.001, H .01    -> V(close d1=102) = -0.001 + 1.02  = 1.019
  //    d2 11:00 sell 0.004 @105 fee 0.0005   cash -0.001 + .42 - .0005 = .4185, H .006 -> V(d2=104) = .4185 + .624 = 1.0425
  //    d3 (no trade)                                                                -> V(d3=110) = .4185 + .66  = 1.0785
  //    d4 17:30 sell 0.016 @108 (AFTER the 16:00 close): d4 still marks H .006 -> V(d4=107) = .4185 + .642 = 1.0605;
  //        from d5 cash .4185 + 1.728 = 2.1465, H -.01 (short)
  //    d5: short H -0.01 -> V(d5=100) = 2.1465 - 1.00 = 1.1465 ; d6 15:00 buy 0.01 @98 fee 0 -> flat, cash 2.1465 - .98 = 1.1665 = V(d6=97)
  const days = ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06", "2026-03-09"], closes = [102, 104, 110, 107, 100, 97];
  const bars = days.map((d, i) => ({ d, o: closes[i], h: closes[i] + 12, l: closes[i] - 12, c: closes[i], closeMs: etCloseMs(d) }));
  const at = (d, hh, mm) => new Date(etCloseMs(d) - (16 - hh) * 36e5 + mm * 6e4).toISOString();
  const mk = (id, d, hh, mm, action, price, amount, fee, H, V) => ({ timeline_id: String(id), at: at(d, hh, mm), action, price: String(price), amount: String(amount), fee_total: String(fee), new_holdings: String(H), strategy_value: String(V), stock_id: "SYN", symbol: "SYN", security: "stock" });
  const trades = [
    mk(1, days[0], 10, 0, "buy", 100, 0.01, 0.001, 0.01, -0.001 + 0.01 * 100),
    mk(2, days[1], 11, 0, "sell", 105, 0.004, 0.0005, 0.006, 0.4185 + 0.006 * 105),
    mk(3, days[3], 17, 30, "sell", 108, 0.016, 0, -0.01, 2.1465 - 0.01 * 108),
    mk(4, days[5], 15, 0, "buy", 98, 0.01, 0, 0, 1.1665),
  ];
  const c = classify([...trades].reverse());                     // the recorder stores newest first
  check("classify single", c.cls === "single" && c.symbol === "SYN");
  const L = ledger(c.ev);
  check("ledger drift 0 on exact values", L.drift < 1e-12 && L.driftAll < 1e-12, `drift ${L.drift}`);
  check("flat-point basis used", L.driftBasis === "flat-points" && L.flatPoints === 1);
  const S = markSeries(L.rows, bars), want = [1.019, 1.0425, 1.0785, 1.0605, 1.1465, 1.1665];
  check("daily marks equal hand values", S.every((p, i) => close(p.v, want[i])), S.map((p) => r6(p.v)).join(","));
  check("after-close trade applies next session", close(S[3].v, 1.0605) && close(S[4].v, 1.1465));
  check("price check in-range", priceCheck(c.ev, new Map(bars.map((b) => [b.d, b])), false).ok);
  // drift detection: drop trade 2 (a missing trade) -> the recorded values no longer reconcile
  const L2 = ledger(classify([trades[0], trades[2], trades[3]]).ev);
  check("missing trade -> drift > 2%", L2.drift > DRIFT_MAX, `drift ${r4(L2.drift)}`);
  // a stale mark on one row of a never-flat strategy counts; with a flat point it does not
  check("truncated history flagged", classify([trades[1], trades[2], trades[3]]).cls === "truncated");
  check("multi-symbol flagged", classify([trades[0], { ...trades[1], stock_id: "OTHER" }]).cls === "multi-symbol");
  check("data-less flagged", classify([{ timeline_id: "9", at: trades[0].at }]).cls === "data-less");
  // wrong price series (factor 4, e.g. an unrestated split) -> price mismatch
  const bars4 = new Map(bars.map((b) => [b.d, { ...b, l: b.l * 4, h: b.h * 4 }]));
  check("price mismatch flagged", !priceCheck(c.ev, bars4, false).ok);
  // month-end point and staleness
  const ser = [{ d: "2026-01-30", v: 1, c: 1, closeMs: 0 }, { d: "2026-02-27", v: 2, c: 2, closeMs: 0 }];
  check("pointAt last on/before month-end", pointAt(ser, "2026-02-28").v === 2 && pointAt(ser, "2026-01-31").v === 1);
  check("pointAt stale -> null", pointAt(ser, "2026-03-31") === null);
  // 2. DECILE MATHS. 100 names, score i, outcome i/1000: top 10 = .090..099 mean .0945, bottom .0045, spread .09
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: "s" + i, score: i, out: i / 1000 }));
  const dm = decileMonth(rows, 1);
  check("decile k=10, spread .09", dm.k === 10 && close(dm.spread, 0.09) && close(dm.top, 0.0945) && close(dm.bottom, 0.0045), `spread ${dm.spread}`);
  check("N=57 -> k=5", decileMonth(rows.slice(0, 57), 1).k === 5);
  check("N<50 -> month skipped", decileMonth(rows.slice(0, 49), 1) === null);
  // ties: every score equal, outcome = row index. Row-order tie-breaking would give a spread of -0.09 every time.
  const ties = rows.map((r) => ({ ...r, score: 0 }));
  const tieSpreads = Array.from({ length: 200 }, (_, s) => decileMonth(ties, 1000 + s).spread);
  check("ties broken randomly, not by row order", Math.abs(mean(tieSpreads)) < 0.01 && tieSpreads.some((x) => x > 0) && tieSpreads.some((x) => x < 0), `mean ${r6(mean(tieSpreads))}`);
  check("tie-break reproducible", decileMonth(ties, 7).spread === decileMonth(ties, 7).spread);
  // 3. NEWEY-WEST. [1,2,3,4,5]: gamma0 2, gamma1 .8, LRV 2 + 2(.5)(.8) = 2.8, t = 3 / sqrt(2.8/5) = 4.00891
  check("NW lag-1 t hand value", close(nwT([1, 2, 3, 4, 5]), 3 / Math.sqrt(2.8 / 5), 1e-12), `${nwT([1, 2, 3, 4, 5])}`);
  // 4. CONTROLS on fabricated panels: 24 months x 120 names. (a) planted persistence; (b) none.
  const g = mulberry(424242), gauss = () => { let u = 0; for (let i = 0; i < 12; i++) u += g(); return u - 6; };
  const panel = (beta) => Array.from({ length: 24 }, (_, m) => ({ me: `m${m}`, rows: Array.from({ length: 120 }, (_, i) => { const s = gauss(); return { id: "x" + i, ar: s, raw: s + gauss(), out: beta * s * 0.02 + 0.05 * gauss() }; }) }));
  const P1 = variantStats(panel(1), VARIANTS[0], 0, 2.47), P0 = variantStats(panel(0), VARIANTS[0], 0, 2.47);
  check("planted persistence clears bar", P1.nwT >= 2.47, `t ${P1.nwT}`);
  check("null panel does not", Math.abs(P0.nwT) < 2.47, `t ${P0.nwT}`);
  check("shuffle control passes (median |t| < 2)", P1.controls.shuffle.pass && P0.controls.shuffle.pass, `med ${P1.controls.shuffle.medianAbsT}/${P0.controls.shuffle.medianAbsT}, p95 ${P0.controls.shuffle.p95AbsT}`);
  check("peek control clears bar", P1.controls.peek.pass && P0.controls.peek.pass, `peek t ${P0.controls.peek.nwT}`);
  check("true t beats shuffles when planted", P1.controls.shuffle.trueTPercentile >= 0.95, `pct ${P1.controls.shuffle.trueTPercentile}`);
  console.log(`R188 SELF-TEST: ${ok.length} passed, ${bad.length} failed`);
  for (const x of ok) console.log("  ok   " + x);
  for (const x of bad) console.log("  FAIL " + x);
  if (bad.length) process.exit(1);
}

const argv = process.argv.slice(2);
if (require.main === module) (async () => {
  if (argv.includes("--selftest")) return selftest();
  if (argv.includes("--read")) return read();
  if (argv.includes("--forward")) return console.log(JSON.stringify(forwardStatus(), null, 1));
  return status();
})().catch((e) => { console.error(`${ID} FAILED (nothing sealed):`, e.message); process.exit(1); });

// Exported for R211 (backend/r211-luck-filter.js), which reuses this reconstruction rather than duplicating it.
module.exports = { classify, ledger, markSeries, pointAt, decileMonth, nwT, crossSection, forwardPanel, forwardStatus, buildUniverse, loadStrategies, loadState, loadTimeline,
  readGate, historyWindow, monthEnds, etCloseMs, mulberry, MIN_BREADTH, DRIFT_MAX, AI };
