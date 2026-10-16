#!/usr/bin/env node
/**
 * R210 — STABLECOIN SUPPLY GROWTH -> BTC NEXT WEEK. Registered 2026-09-24 (family CRYPTO-3, bar at 4 variants) BEFORE this file
 * existed; rule, statistic, bar and controls are frozen in data/test-registry.json (preregistered[id=R210]); the bar is read from
 * there at run time.
 *
 * RULE (registry): total stablecoin circulating supply (USD-pegged), daily, from DefiLlama's public stablecoin API. Signal each UTC
 * day d: 7-day supply growth ranked against the trailing 180 days; HIGH = top 20%. Position: long BTC (Coinbase daily close) from
 * the close of d for 7 days on HIGH days; otherwise cash. Cost 10 bps per side per switch. Window 2020-01..2026-08.
 * STATISTIC: per non-overlapping 7-day block starting on a HIGH day: BTC return minus BTC's mean 7-day return over the sample (the
 * drift); t over blocks (Newey-West lag 1). Reported: the LOW (bottom 20%) mirror, and the long/cash strategy vs buy-and-hold.
 * BAR: t >= ENTRY.bar.tRequired (2.251). CONTROL: placebo — HIGH days replaced by random days (same count per quarter), 200 draws:
 * the true mean must beat the 95th percentile.
 *
 * IMPLEMENTATION NOTES (fixed before any outcome was computed):
 *  N1. Supply: GET https://stablecoins.llama.fi/stablecoincharts/all (no key). Response: a JSON array, one row per UTC day,
 *      { date: "<unix seconds, 00:00 UTC>", totalCirculating: {peggedUSD, peggedEUR, ...}, totalCirculatingUSD: {peggedUSD, ...} }.
 *      Field used: totalCirculatingUSD.peggedUSD (USD value of all USD-pegged stablecoins). Raw response cached verbatim to
 *      data/training/crypto3/defillama-stablecoincharts-all.json (reused if present). Observed on the first probe: daily rows
 *      2017-11-29 .. 2026-09-24 with no gaps; the latest row is the live (partial) day — it is outside the window.
 *  N2. Point-in-time: S_d = the row stamped day d. DefiLlama's latest row is live-updated through its day, so the row stamped d is
 *      treated as known at the close of d (24:00 UTC) — the same instant the position is entered. Vintage/revisions unknown
 *      (registered weakness). Reported robustness variant: signal from the row stamped d-1 (one extra day of lag).
 *  N3. g_d = S_d / S_(d-7) - 1. Rank against the trailing 180 days = the 180 values g_(d-180) .. g_(d-1) (d itself excluded):
 *      frac_d = (#{trailing < g_d} + u_d x #{trailing == g_d}) / 180, with u_d a seeded uniform (mulberry32 seed 2101, drawn in day
 *      order) so ties never break by row order. HIGH iff frac_d >= 0.8 (top 20%); LOW iff frac_d < 0.2 (bottom 20%).
 *  N4. BTC: Coinbase Exchange daily candles (granularity 86400, time = bucket start UTC), BTC-USD, 2019-06-01 .. 2026-09-15;
 *      close of d = close of the candle starting d 00:00 UTC. Cached to data/training/crypto3/coinbase-BTC-USD-1d.json.
 *  N5. Signal days d: 2020-01-01 .. 2026-08-31 (every block's exit d+7 <= 2026-09-07 is inside the BTC cache). Blocks: walk days
 *      ascending; a HIGH day d with d >= nextFree opens block [close d, close d+7] and sets nextFree = d+7. Block value =
 *      (C_(d+7)/C_d - 1) - 0.002 - drift, where 0.002 = 10 bps x (entry + exit) charged on every block (conservative: back-to-back
 *      blocks are also charged, although a live book would not switch), and drift = mean of C_(d+7)/C_d - 1 over ALL signal days
 *      of the window (overlapping, gross). NW t with lag 1 (Bartlett). Also reported: the gross block value (no cost).
 *  N6. Placebo: per calendar quarter q, n_q = number of HIGH days in q; one draw picks n_q days from q's signal days uniformly
 *      WITHOUT replacement (seeded partial Fisher-Yates, mulberry32 seed 210, day list in date order), then forms blocks by the
 *      N5 walk and scores them identically; statistic = mean block value. 200 draws. Beaten = true mean strictly >
 *      sorted[ceil(0.95*200)-1].
 *  N7. LOW mirror: the N5 blocks on LOW days (long BTC, same cost and drift). Long/cash strategy: day t's return (close t-1 ->
 *      close t) is held iff some HIGH day d in [t-7, t-1]; 10 bps charged on each change of position (incl. the first entry);
 *      compared with buy-and-hold over the same days (2020-01-02 .. 2026-09-07): total return, CAGR, max drawdown, exposure, and
 *      daily OLS alpha vs BTC (annualised x365, plain OLS t).
 *  N8. Seal gate (validity): >= 95% of signal days have S_d, S_(d-7), 180 trailing g and both BTC closes; 200 finite placebo draws;
 *      every quarter with HIGH days has at least n_q signal days. No peek control is registered for R210.
 *      VERDICT: PASS = primary t >= bar AND placebo beaten.
 *
 *   node backend/r210-stablecoin-flow.js [--dry]  -> data/r210-stablecoin-flow.json (refuses if R210 is already sealed)
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const DRY = process.argv.includes("--dry");
const ID = "R210", OUT = D("r210-stablecoin-flow.json"), CACHE = D(path.join("training", "crypto3"));
{ const s = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (s.tests[ID]) { console.error(`${ID} already sealed — refusing`); process.exit(2); } }
const ENTRY = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")).preregistered.find((t) => t.id === ID);
if (!ENTRY) { console.error(`${ID} not registered`); process.exit(2); }
const BAR = ENTRY.bar.tRequired, COST = 0.001, DRAWS = 200, SEED = 210, TIE_SEED = 2101, DAY = 86400e3, LOOK = 180, HOLD = 7;
const LLAMA = "https://stablecoins.llama.fi/stablecoincharts/all";
const BTC_START = Date.parse("2019-06-01T00:00:00Z"), BTC_END = Date.parse("2026-09-15T00:00:00Z");
const SIG_FIRST = Date.parse("2020-01-01T00:00:00Z"), SIG_LAST = Date.parse("2026-08-31T00:00:00Z");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function nwT(a, L = 1) { const n = a.length; if (n < 3) return null; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n; for (let l = 1; l <= L; l++) { let g = 0; for (let i = l; i < n; i++) g += d[i] * d[i - l]; v += 2 * (1 - l / (L + 1)) * g / n; } return m / Math.sqrt(v / n); }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r3 = (x) => (x == null || !Number.isFinite(x) ? x : +x.toFixed(3)), pct = (x) => r3(x * 100);
const todayET = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const quarterOf = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3) + 1}`; };

async function getJson(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": "traids-research/1.0", Accept: "application/json" }, signal: AbortSignal.timeout(60000) });
    if (res.status === 429 || res.status >= 500) { await sleep(1000 * 2 ** attempt); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res.json();
  }
  throw new Error(`failed after retries: ${url}`);
}
async function supply() {
  fs.mkdirSync(CACHE, { recursive: true });
  const f = path.join(CACHE, "defillama-stablecoincharts-all.json");
  if (!fs.existsSync(f)) { const raw = await getJson(LLAMA); if (!Array.isArray(raw)) throw new Error("DefiLlama: response is not an array"); writeJsonAtomic(f, { endpoint: LLAMA, field: "totalCirculatingUSD.peggedUSD", fetchedAt: new Date().toISOString(), raw }, { pretty: 0 }); }
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  const m = new Map(); for (const r of j.raw) { const v = r.totalCirculatingUSD && r.totalCirculatingUSD.peggedUSD; if (Number.isFinite(v) && v > 0) m.set(+r.date * 1000, v); }
  return { map: m, fetchedAt: j.fetchedAt, rows: j.raw.length };
}
async function btcDaily() {
  const f = path.join(CACHE, "coinbase-BTC-USD-1d.json");
  if (fs.existsSync(f)) { const j = JSON.parse(fs.readFileSync(f, "utf8")); if (j.startMs === BTC_START && j.endMs === BTC_END) return j.rows; }
  const map = new Map(); let calls = 0;
  for (let s = BTC_START; s < BTC_END; s += 300 * DAY) {
    const e = Math.min(BTC_END - DAY, s + 299 * DAY);
    const page = await getJson(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&start=${new Date(s).toISOString()}&end=${new Date(e).toISOString()}`); calls++;
    if (!Array.isArray(page)) throw new Error("coinbase daily: non-array page");
    for (const [t, lo, hi, op, cl, vol] of page) { const ms = t * 1000; if (ms >= s && ms <= e) map.set(ms, { t: ms, o: op, h: hi, l: lo, c: cl, v: vol }); }
    await sleep(350);
  }
  const rows = [...map.values()].sort((a, b) => a.t - b.t);
  writeJsonAtomic(f, { source: "api.exchange.coinbase.com candles 86400 (time = bucket start, UTC)", product: "BTC-USD", startMs: BTC_START, endMs: BTC_END, fetchedAt: new Date().toISOString(), calls, rows }, { pretty: 0 });
  return rows;
}

(async () => {
  console.log(`${ID} — stablecoin supply growth -> BTC 7d · bar t >= ${BAR}`);
  const S = await supply(), btcRows = await btcDaily(), C = new Map(btcRows.map((r) => [r.t, r.c]));
  const sKeys = [...S.map.keys()].sort((a, b) => a - b);
  console.log(`  DefiLlama: ${S.rows} rows (${iso(sKeys[0])} .. ${iso(sKeys[sKeys.length - 1])}), fetched ${S.fetchedAt}; BTC daily: ${btcRows.length} candles (${iso(btcRows[0].t)} .. ${iso(btcRows[btcRows.length - 1].t)})`);

  // ---- signal (N2/N3) -----------------------------------------------------------------------------------------------------------
  const g = (d) => { const a = S.map.get(d), b = S.map.get(d - 7 * DAY); return a != null && b != null ? a / b - 1 : null; };
  const tieRnd = mulberry(TIE_SEED);
  /** classify day d using the supply row stamped (d - lag) -> {frac, cls} or null */
  const classify = (d, lag, rnd) => {
    const s = d - lag * DAY, gd = g(s); if (gd == null) return null;
    let less = 0, eq = 0; for (let k = 1; k <= LOOK; k++) { const x = g(s - k * DAY); if (x == null) return null; if (x < gd) less++; else if (x === gd) eq++; }
    const frac = (less + rnd() * eq) / LOOK; return { frac, cls: frac >= 0.8 ? "HIGH" : frac < 0.2 ? "LOW" : "MID" };
  };
  const days = [], missing = []; const lagRnd = mulberry(TIE_SEED + 1);
  for (let d = SIG_FIRST; d <= SIG_LAST; d += DAY) {
    const c0 = C.get(d), c7 = C.get(d + HOLD * DAY), k = classify(d, 0, tieRnd), kLag = classify(d, 1, lagRnd);
    if (!k || c0 == null || c7 == null) { missing.push(iso(d)); continue; }
    days.push({ d, cls: k.cls, frac: k.frac, clsLag: kLag ? kLag.cls : null, r7: c7 / c0 - 1 });
  }
  const registered = days.length + missing.length, drift = mean(days.map((x) => x.r7));
  const nHigh = days.filter((x) => x.cls === "HIGH").length, nLow = days.filter((x) => x.cls === "LOW").length;
  console.log(`  signal days ${days.length}/${registered} (missing ${missing.length}); HIGH ${nHigh} (${pct(nHigh / days.length)}%), LOW ${nLow}; drift (mean 7d BTC return) ${pct(drift)}%`);

  const blocksOf = (sel, cost = 2 * COST) => { const out = []; let nextFree = -Infinity; for (const x of days) { if (!sel(x) || x.d < nextFree) continue; out.push({ d: x.d, v: x.r7 - cost - drift }); nextFree = x.d + HOLD * DAY; } return out; };
  const stat = (bl) => { const v = bl.map((b) => b.v); return { blocks: v.length, meanPct: pct(mean(v)), tNW1: r3(nwT(v, 1)), hitRate: r3(v.filter((x) => x > 0).length / v.length), _m: mean(v) }; };
  const strip = (o) => { const { _m, ...rest } = o; return rest; };
  const primBlocks = blocksOf((x) => x.cls === "HIGH"), prim = stat(primBlocks);
  console.log(`  PRIMARY ${prim.blocks} HIGH blocks: BTC 7d net excess over drift ${prim.meanPct}% per block, NW(1) t ${prim.tNW1} (bar ${BAR}), hit ${prim.hitRate}`);
  const variants = {
    grossHigh: strip(stat(blocksOf((x) => x.cls === "HIGH", 0))),
    lowMirror: strip(stat(blocksOf((x) => x.cls === "LOW"))),
    lowMirrorGross: strip(stat(blocksOf((x) => x.cls === "LOW", 0))),
    highLaggedOneDay: strip(stat(blocksOf((x) => x.clsLag === "HIGH"))),
  };
  const byYear = {}; for (const y of [...new Set(primBlocks.map((b) => iso(b.d).slice(0, 4)))]) byYear[y] = strip(stat(primBlocks.filter((b) => iso(b.d).startsWith(y))));
  console.log(`  variants: gross ${variants.grossHigh.meanPct}% t ${variants.grossHigh.tNW1} · LOW mirror ${variants.lowMirror.meanPct}% t ${variants.lowMirror.tNW1} (${variants.lowMirror.blocks}) · HIGH lagged 1d ${variants.highLaggedOneDay.meanPct}% t ${variants.highLaggedOneDay.tNW1}`);

  // ---- long/cash strategy vs buy-and-hold (N7) ----------------------------------------------------------------------------------
  const highSet = new Set(days.filter((x) => x.cls === "HIGH").map((x) => x.d));
  const sr = [], br = []; let pos = 0, missingDaily = 0;
  for (let t = SIG_FIRST + DAY; t <= SIG_LAST + HOLD * DAY; t += DAY) {
    const c1 = C.get(t), c0 = C.get(t - DAY); if (c1 == null || c0 == null) { missingDaily++; continue; }
    let want = 0; for (let k = 1; k <= HOLD; k++) if (highSet.has(t - k * DAY)) { want = 1; break; }
    const r = c1 / c0 - 1, cost = want !== pos ? COST : 0; pos = want; sr.push(want * r - cost); br.push(r);
  }
  const curve = (a) => { let eq = 1, pk = 1, dd = 0; for (const r of a) { eq *= 1 + r; pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1); } return { total: eq - 1, cagr: eq ** (365 / a.length) - 1, maxDD: dd }; };
  const ols = (y, x) => { const n = y.length, mx = mean(x), my = mean(y); let sxx = 0, sxy = 0; for (let i = 0; i < n; i++) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); } const b = sxy / sxx, a = my - b * mx; let sse = 0; for (let i = 0; i < n; i++) sse += (y[i] - a - b * x[i]) ** 2; const s2 = sse / (n - 2), seA = Math.sqrt(s2 * (1 / n + mx * mx / sxx)); return { alphaAnnPct: pct(a * 365), alphaT: r3(a / seA), beta: r3(b) }; };
  const cs = curve(sr), cb = curve(br);
  const strategy = { days: sr.length, missingDaily, exposure: null, longCash: { totalPct: pct(cs.total), cagrPct: pct(cs.cagr), maxDDPct: pct(cs.maxDD) }, buyHold: { totalPct: pct(cb.total), cagrPct: pct(cb.cagr), maxDDPct: pct(cb.maxDD) }, alphaVsBtc: ols(sr, br) };
  { let held = 0, p = 0; for (let t = SIG_FIRST + DAY; t <= SIG_LAST + HOLD * DAY; t += DAY) { if (C.get(t) == null || C.get(t - DAY) == null) continue; for (let k = 1; k <= HOLD; k++) if (highSet.has(t - k * DAY)) { held++; break; } p++; } strategy.exposure = r3(held / p); }
  console.log(`  long/cash: total ${strategy.longCash.totalPct}% CAGR ${strategy.longCash.cagrPct}% maxDD ${strategy.longCash.maxDDPct}% (exposure ${strategy.exposure}) vs buy-hold total ${strategy.buyHold.totalPct}% CAGR ${strategy.buyHold.cagrPct}% maxDD ${strategy.buyHold.maxDDPct}%; alpha ${strategy.alphaVsBtc.alphaAnnPct}%/yr t ${strategy.alphaVsBtc.alphaT} beta ${strategy.alphaVsBtc.beta}`);

  // ---- placebo (N6) -------------------------------------------------------------------------------------------------------------
  const byQ = new Map(); for (const x of days) { const q = quarterOf(x.d); if (!byQ.has(q)) byQ.set(q, []); byQ.get(q).push(x); }
  const nQ = new Map([...byQ].map(([q, arr]) => [q, arr.filter((x) => x.cls === "HIGH").length]));
  const shortQ = [...nQ].filter(([q, n]) => n > byQ.get(q).length).map(([q]) => q);
  const rnd = mulberry(SEED), draws = [];
  for (let k = 0; k < DRAWS; k++) {
    const picked = new Set();
    for (const [q, arr] of byQ) { const n = nQ.get(q); if (!n) continue; const pool = arr.slice(); for (let i = 0; i < n; i++) { const j = i + Math.floor(rnd() * (pool.length - i)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; picked.add(pool[i].d); } }
    draws.push(stat(blocksOf((x) => picked.has(x.d)))._m);
  }
  const ds = [...draws].sort((a, b) => a - b), p95 = ds[Math.ceil(0.95 * DRAWS) - 1], placeboBeaten = prim._m > p95, finiteDraws = draws.filter(Number.isFinite).length;
  console.log(`  PLACEBO (${DRAWS}, random days matched per quarter): p50 ${pct(ds[Math.ceil(0.5 * DRAWS) - 1])}% p95 ${pct(p95)}% -> true ${prim.meanPct}% ${placeboBeaten ? "BEATS" : "does NOT beat"} p95`);

  // ---- verdict ------------------------------------------------------------------------------------------------------------------
  const primaryClears = prim.tNW1 != null && prim.tNW1 >= BAR, pass = primaryClears && placeboBeaten;
  const verdict = `${pass ? "PASS" : "DID NOT PASS"} — long BTC 7d after a top-20% (vs trailing 180d) 7-day stablecoin supply growth day, net excess over the ${pct(drift)}% 7d drift ${prim.meanPct}% per block, NW(1) t ${prim.tNW1} vs bar ${BAR} over ${prim.blocks} blocks (2020-01..2026-08, 10bps/side); placebo p95 ${pct(p95)}% (${placeboBeaten ? "beaten" : "not beaten"}); LOW mirror t ${variants.lowMirror.tNW1}; 1d-lag t ${variants.highLaggedOneDay.tNW1}; long/cash CAGR ${strategy.longCash.cagrPct}% vs buy-hold ${strategy.buyHold.cagrPct}%, alpha t ${strategy.alphaVsBtc.alphaT}`;
  const gates = { signalDaysOk: days.length >= 0.95 * registered, placeboFinite: finiteDraws === DRAWS, quartersOk: shortQ.length === 0 };
  const controlsValid = Object.values(gates).every(Boolean);
  const out = { spec: "r210-stablecoin-flow-v1", test: ID, asOf: new Date().toISOString(), window: [iso(SIG_FIRST), iso(SIG_LAST)], bar: BAR, costPerSide: COST, holdDays: HOLD, lookbackDays: LOOK,
    source: { endpoint: LLAMA, field: "totalCirculatingUSD.peggedUSD", rows: S.rows, first: iso(sKeys[0]), last: iso(sKeys[sKeys.length - 1]), fetchedAt: S.fetchedAt, btcDaily: { candles: btcRows.length, first: iso(btcRows[0].t), last: iso(btcRows[btcRows.length - 1].t) } },
    coverage: { registeredSignalDays: registered, signalDays: days.length, missing, highDays: nHigh, lowDays: nLow, driftPct: pct(drift) },
    primary: { ...strip(prim), clearsBar: primaryClears }, variants, byYear, strategy,
    controls: { placebo: { draws: DRAWS, seed: SEED, finite: finiteDraws, p50Pct: pct(ds[Math.ceil(0.5 * DRAWS) - 1]), p95Pct: pct(p95), maxPct: pct(ds[DRAWS - 1]), truePct: prim.meanPct, beaten: placeboBeaten, allPct: draws.map(pct) } },
    blocks: primBlocks.map((b) => ({ start: iso(b.d), excessNetPct: pct(b.v) })),
    gates, verdict, pass, controlsValid };
  writeJsonAtomic(DRY ? OUT.replace(/.json$/, ".dry.json") : OUT, out);
  console.log(`\n  VERDICT: ${verdict}`);
  console.log(`  gates: ${JSON.stringify(gates)}`);
  if (DRY) { console.log("  --dry: harness check only, NOT sealed"); return; }
  if (!controlsValid) { console.log("  controls invalid — NOT sealed"); return; }
  const today = todayET();
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests[ID]) throw new Error("sealed concurrently — not overwriting");
  seals.tests[ID] = { sealedOn: today, unit: "7-day blocks", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E = reg.preregistered.find((t) => t.id === ID);
  E.status = `READ ${today} — ${verdict}`; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: ID, verdict }) + "\n");
  console.log(`  sealed ${ID} (${today})`);
})().catch((e) => { console.error(`${ID} FAILED (nothing sealed):`, e.message); process.exit(1); });
