#!/usr/bin/env node
/**
 * R200 — CRYPTO MONTHLY EXPIRY REVERSAL (BTC/ETH, dealer-hedge unwind). Registered 2026-09-24 (family FLOWS-4, best-of-4) BEFORE
 * this file existed; rule, statistic, bar and controls are frozen in data/test-registry.json (preregistered[id=R200]); the bar is
 * read from there at run time.
 *
 * RULE (registry): expiry E = the last Friday of each month, 08:00 UTC (Deribit monthly; CME monthly futures settle the same day).
 * Pre-window: E-72h -> E. Post-window: E -> E+72h. Position: at E take the OPPOSITE direction of the pre-window move, per coin
 * (BTC and ETH), hold 72 hours. Coinbase hourly candles. Cost 10 bps per side. Window 2020-01..2026-08.
 * STATISTIC: per expiry, the pooled (BTC, ETH equal weight) net post-window return in the reversal direction; t over expiries.
 * Reported: each coin alone, quarterly expiries (Mar/Jun/Sep/Dec) alone, and the continuation sign.
 * BAR: t >= ENTRY.bar.tRequired (2.303). CONTROL: placebo — the same rule anchored on a random non-expiry Friday 08:00 UTC in the
 * same month (200 draws); the true mean must beat the 95th percentile.
 *
 * IMPLEMENTATION NOTES (fixed before any outcome was computed):
 *  N1. Data: Coinbase Exchange public candles, BTC-USD and ETH-USD, granularity 3600, <=300 per call, ~350 ms between calls,
 *      2019-12-20T00:00Z .. 2026-09-01T00:00Z (covers the Jan-2020 first-Friday placebo pre-window and the Aug-2026 expiry's
 *      post-window, which ends 2026-08-31 08:00). Cached to data/training/flows4/coinbase-<PRODUCT>-1h.json. A candle's time is its
 *      bucket START (UTC).
 *  N2. Price at instant T (a whole UTC hour) = close of the hourly candle starting T-1h (the last trade before T) — the R193
 *      "price at HH:MM = close of the bar one unit earlier" convention. If that candle is missing, the last earlier candle up to
 *      3 hours stale is used (staleness counted); otherwise the coin is unpriced for that window. 08:00 UTC is an hour boundary,
 *      so the bracketing weakness reduces to "last trade in the 07:00 hour" vs the Deribit 30-minute TWAP settlement.
 *  N3. Per coin: pre = P(E)/P(E-72h) - 1, post = P(E+72h)/P(E) - 1, pos = -sign(pre) (0 -> flat, no cost),
 *      net = pos x post - 2 x 10 bps. Pooled expiry value = mean(BTC, ETH); an expiry enters only if both coins are priced.
 *  N4. The registry says "t over expiries" (no HAC; windows of consecutive expiries never overlap): plain one-sample t, sd n-1.
 *  N5. Quarterly = expiries in Mar/Jun/Sep/Dec. Continuation = pos = +sign(pre), same cost. Also reported: gross, by year,
 *      non-quarterly alone, pre-window/post-window correlation (Pearson, pooled coin-expiries).
 *  N6. Placebo: for every month in the primary sample, the candidate Fridays are that calendar month's other Fridays (08:00 UTC),
 *      each scored with the identical rule (both coins priced required). One draw = for each month, one candidate chosen uniformly
 *      at random (seeded mulberry32, seed 200; the candidate list is in date order and only the random index selects), then the
 *      mean across months. 200 draws. Beaten = true mean strictly > sorted[ceil(0.95*200)-1]. Every month has >= 3 candidates.
 *  N7. Seal gate (validity): >= 95% of the 80 registered expiries priced in both coins, placebo finite over every sampled month.
 *      No peek control is registered for R200. VERDICT: PASS = primary t >= bar AND placebo beaten.
 *
 *   node backend/r200-crypto-expiry.js [--dry]  -> data/r200-crypto-expiry.json (refuses if R200 is already sealed)
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const DRY = process.argv.includes("--dry");
const ID = "R200", OUT = D("r200-crypto-expiry.json"), CACHE = D(path.join("training", "flows4"));
{ const s = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (s.tests[ID]) { console.error(`${ID} already sealed — refusing`); process.exit(2); } }
const ENTRY = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")).preregistered.find((t) => t.id === ID);
if (!ENTRY) { console.error(`${ID} not registered`); process.exit(2); }
const BAR = ENTRY.bar.tRequired, COST = 0.001, DRAWS = 200, SEED = 200, H = 3600e3, WIN = 72 * H, MAX_STALE = 3;
const PX_START = Date.parse("2019-12-20T00:00:00Z"), PX_END = Date.parse("2026-09-01T00:00:00Z");
const COINS = ["BTC", "ETH"], FIRST_MONTH = "2020-01", LAST_MONTH = "2026-08";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function tPlain(a) { const n = a.length, m = mean(a); const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1); return m / Math.sqrt(v / n); }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r3 = (x) => (x == null || !Number.isFinite(x) ? x : +x.toFixed(3)), bps = (x) => r3(x * 1e4), pct = (x) => r3(x * 100);
const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const todayET = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

async function hourly(product) {
  fs.mkdirSync(CACHE, { recursive: true });
  const f = path.join(CACHE, `coinbase-${product}-1h.json`);
  if (fs.existsSync(f)) { const j = JSON.parse(fs.readFileSync(f, "utf8")); if (j.startMs === PX_START && j.endMs === PX_END) return j.rows; }
  const map = new Map(); let calls = 0;
  for (let s = PX_START; s < PX_END; s += 300 * H) {
    const e = Math.min(PX_END - H, s + 299 * H);
    const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=3600&start=${new Date(s).toISOString()}&end=${new Date(e).toISOString()}`;
    let page = null;
    for (let attempt = 0; attempt < 6 && page == null; attempt++) {
      const res = await fetch(url, { headers: { "User-Agent": "traids-research/1.0", Accept: "application/json" }, signal: AbortSignal.timeout(30000) }); calls++;
      if (res.status === 429 || res.status >= 500) { await sleep(1000 * 2 ** attempt); continue; }
      if (!res.ok) throw new Error(`coinbase ${product} HTTP ${res.status}`);
      const j = await res.json(); if (!Array.isArray(j)) throw new Error(`coinbase ${product}: non-array page`); page = j;
    }
    if (page == null) throw new Error(`coinbase ${product}: page ${new Date(s).toISOString()} failed after retries`);
    for (const [t, lo, hi, op, cl, vol] of page) { const ms = t * 1000; if (ms >= s && ms <= e) map.set(ms, { t: ms, o: op, h: hi, l: lo, c: cl, v: vol }); }
    await sleep(350);
  }
  const rows = [...map.values()].sort((a, b) => a.t - b.t);
  writeJsonAtomic(f, { source: "api.exchange.coinbase.com candles 3600 (time = bucket start, UTC)", product, startMs: PX_START, endMs: PX_END, start: new Date(PX_START).toISOString(), end: new Date(PX_END).toISOString(), fetchedAt: new Date().toISOString(), calls, rows }, { pretty: 0 });
  return rows;
}

/** Fridays of a month at 08:00 UTC (ms), ascending. */
function fridays(y, mo) {
  const out = []; for (let d = 1; d <= 31; d++) { const t = Date.UTC(y, mo - 1, d, 8); if (new Date(t).getUTCMonth() !== mo - 1) break; if (new Date(t).getUTCDay() === 5) out.push(t); }
  return out;
}

(async () => {
  console.log(`${ID} — crypto monthly-expiry reversal · bar t >= ${BAR}`);
  const px = {}, stale = { count: 0, maxH: 0 };
  for (const c of COINS) { px[c] = new Map((await hourly(`${c}-USD`)).map((r) => [r.t, r.c])); console.log(`  ${c}-USD: ${px[c].size} hourly candles cached`); }
  const expectedHours = (PX_END - PX_START) / H;
  const priceAt = (c, T) => { for (let k = 1; k <= 1 + MAX_STALE; k++) { const v = px[c].get(T - k * H); if (v != null) { if (k > 1) { stale.count++; stale.maxH = Math.max(stale.maxH, k - 1); } return v; } } return null; };
  /** per-coin legs for anchor A (ms). dir = -1 reversal, +1 continuation. */
  const legs = (A) => { const o = {}; for (const c of COINS) { const p0 = priceAt(c, A - WIN), p1 = priceAt(c, A), p2 = priceAt(c, A + WIN); if (p0 == null || p1 == null || p2 == null) return null; o[c] = { pre: p1 / p0 - 1, post: p2 / p1 - 1 }; } return o; };
  const legNet = (L, dir, cost = COST) => { const p = dir * sgn(L.pre); return p * L.post - (p ? 2 * cost : 0); };
  const pooled = (lg, dir = -1, cost = COST, coins = COINS) => mean(coins.map((c) => legNet(lg[c], dir, cost)));

  const months = [], unpriced = [];
  for (let y = 2020; y <= 2026; y++) for (let mo = 1; mo <= 12; mo++) {
    const key = `${y}-${String(mo).padStart(2, "0")}`; if (key < FIRST_MONTH || key > LAST_MONTH) continue;
    const fr = fridays(y, mo), E = fr[fr.length - 1], lg = legs(E);
    if (!lg) { unpriced.push(key); continue; }
    const placebos = fr.slice(0, -1).map((A) => ({ A, lg: legs(A) })).filter((x) => x.lg);
    months.push({ key, E, expiry: new Date(E).toISOString(), quarterly: mo % 3 === 0, lg, placebos });
  }
  const registered = months.length + unpriced.length;
  console.log(`  expiries: ${months.length}/${registered} priced in both coins (${unpriced.length} unpriced: ${unpriced.join(",") || "none"}); stale fallbacks ${stale.count} (max ${stale.maxH}h)`);

  const stat = (arr) => ({ n: arr.length, meanPct: pct(mean(arr)), meanBps: bps(mean(arr)), t: arr.length > 2 ? r3(tPlain(arr)) : null, hitRate: r3(arr.filter((x) => x > 0).length / arr.length) });
  const primVals = months.map((m) => pooled(m.lg)), prim = stat(primVals);
  console.log(`  PRIMARY ${prim.n} expiries: pooled net reversal ${prim.meanPct}% per expiry, t ${prim.t} (bar ${BAR}), hit ${prim.hitRate}`);
  const sub = (f, fn) => stat(months.filter(f).map(fn));
  const variants = {
    btcOnly: sub(() => true, (m) => pooled(m.lg, -1, COST, ["BTC"])),
    ethOnly: sub(() => true, (m) => pooled(m.lg, -1, COST, ["ETH"])),
    quarterlyOnly: sub((m) => m.quarterly, (m) => pooled(m.lg)),
    nonQuarterlyOnly: sub((m) => !m.quarterly, (m) => pooled(m.lg)),
    continuationSign: sub(() => true, (m) => pooled(m.lg, +1)),
    grossReversal: sub(() => true, (m) => pooled(m.lg, -1, 0)),
    quarterlyContinuation: sub((m) => m.quarterly, (m) => pooled(m.lg, +1)),
  };
  const xs = [], ys = []; for (const m of months) for (const c of COINS) { xs.push(m.lg[c].pre); ys.push(m.lg[c].post); }
  const mx = mean(xs), my = mean(ys), corr = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0) * ys.reduce((s, y) => s + (y - my) ** 2, 0));
  const byYear = {}; for (const y of [...new Set(months.map((m) => m.key.slice(0, 4)))]) byYear[y] = sub((m) => m.key.startsWith(y), (m) => pooled(m.lg));
  console.log(`  variants: BTC ${variants.btcOnly.meanPct}% t ${variants.btcOnly.t} · ETH ${variants.ethOnly.meanPct}% t ${variants.ethOnly.t} · quarterly (${variants.quarterlyOnly.n}) ${variants.quarterlyOnly.meanPct}% t ${variants.quarterlyOnly.t} · non-quarterly t ${variants.nonQuarterlyOnly.t} · continuation ${variants.continuationSign.meanPct}% t ${variants.continuationSign.t} · gross t ${variants.grossReversal.t} · corr(pre,post) ${r3(corr)}`);

  // ---- placebo ------------------------------------------------------------------------------------------------------------------------
  const minCand = Math.min(...months.map((m) => m.placebos.length));
  const placeboVals = months.map((m) => m.placebos.map((p) => pooled(p.lg)));
  const rnd = mulberry(SEED), draws = [];
  for (let k = 0; k < DRAWS; k++) { let s = 0; for (const pv of placeboVals) s += pv[Math.floor(rnd() * pv.length)]; draws.push(s / placeboVals.length); }
  const ds = [...draws].sort((a, b) => a - b), p95 = ds[Math.ceil(0.95 * DRAWS) - 1], trueMean = mean(primVals), placeboBeaten = trueMean > p95;
  const allPlacebo = stat(placeboVals.flat());
  console.log(`  PLACEBO (${DRAWS}, random non-expiry Friday in the same month; min ${minCand} candidates/month): p50 ${pct(ds[Math.ceil(0.5 * DRAWS) - 1])}% p95 ${pct(p95)}% -> true ${prim.meanPct}% ${placeboBeaten ? "BEATS" : "does NOT beat"} p95; all non-expiry Fridays pooled ${allPlacebo.meanPct}% t ${allPlacebo.t} (n ${allPlacebo.n})`);

  // ---- verdict ------------------------------------------------------------------------------------------------------------------------
  const primaryClears = prim.t >= BAR, pass = primaryClears && placeboBeaten;
  const verdict = `${pass ? "PASS" : "DID NOT PASS"} — BTC/ETH fade the 72h pre-expiry move for 72h after the last-Friday 08:00 UTC expiry, pooled net ${prim.meanPct}% per expiry, t ${prim.t} vs bar ${BAR} over ${prim.n} expiries (2020-01..2026-08, 10bps/side); placebo p95 ${pct(p95)}% (${placeboBeaten ? "beaten" : "not beaten"}); quarterly t ${variants.quarterlyOnly.t} (${variants.quarterlyOnly.n}); continuation t ${variants.continuationSign.t}; BTC t ${variants.btcOnly.t}, ETH t ${variants.ethOnly.t}`;
  const controlsValid = months.length >= 0.95 * registered && minCand >= 3 && Number.isFinite(p95);
  const out = { spec: "r200-crypto-expiry-v1", test: ID, asOf: new Date().toISOString(), window: [FIRST_MONTH, LAST_MONTH], bar: BAR, costPerSide: COST, windowHours: 72,
    coverage: { registeredExpiries: registered, pricedExpiries: months.length, unpriced, hourlyCandles: Object.fromEntries(COINS.map((c) => [c, px[c].size])), expectedHours, staleFallbacks: stale, minPlaceboCandidatesPerMonth: minCand },
    primary: { ...prim, clearsBar: primaryClears }, variants, corrPrePost: r3(corr), byYear,
    controls: { placebo: { draws: DRAWS, seed: SEED, p50Pct: pct(ds[Math.ceil(0.5 * DRAWS) - 1]), p95Pct: pct(p95), maxPct: pct(ds[DRAWS - 1]), truePct: prim.meanPct, beaten: placeboBeaten, allNonExpiryFridaysPooled: allPlacebo, allPct: draws.map(pct) } },
    expiries: months.map((m, i) => ({ month: m.key, expiry: m.expiry, quarterly: m.quarterly, netPct: pct(primVals[i]), legs: Object.fromEntries(COINS.map((c) => [c, { prePct: pct(m.lg[c].pre), postPct: pct(m.lg[c].post) }])) })),
    verdict, pass, controlsValid };
  writeJsonAtomic(DRY ? OUT.replace(/.json$/, ".dry.json") : OUT, out);
  console.log(`\n  VERDICT: ${verdict}`);
  if (DRY) { console.log("  --dry: harness check only, NOT sealed"); return; }
  if (!controlsValid) { console.log("  controls invalid — NOT sealed"); return; }
  const today = todayET();
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests[ID]) throw new Error("sealed concurrently — not overwriting");
  seals.tests[ID] = { sealedOn: today, unit: "events (expiries)", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E = reg.preregistered.find((t) => t.id === ID);
  E.status = `READ ${today} — ${verdict}`; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: ID, verdict }) + "\n");
  console.log(`  sealed ${ID} (${today})`);
})().catch((e) => { console.error(`${ID} FAILED (nothing sealed):`, e.message); process.exit(1); });
