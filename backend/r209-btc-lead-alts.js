#!/usr/bin/env node
/**
 * R209 — BTC LEADS ALTCOINS (hourly catch-up, BTC-hedged). Registered 2026-09-24 (family CRYPTO-3, bar at 4 variants) BEFORE this
 * file existed; rule, statistic, bar and controls are frozen in data/test-registry.json (preregistered[id=R209]); the bar is read
 * from there at run time.
 *
 * RULE (registry): Coinbase hourly candles for BTC and the alt basket ETH, SOL, LTC, LINK, DOGE, ADA, AVAX, DOT (equal weight,
 * coins present that hour). Event: a completed hour where |BTC return| >= 1.5%. Position at that hour's close: the alt basket in the
 * direction of BTC's move, hedged by an equal-dollar opposite BTC position, held 2 hours. Cost 10 bps per side on each leg (40 bps
 * round trip total). Events within 3 hours of a prior event are skipped. Window 2021-06..2026-08.
 * STATISTIC: per event, net 2-hour hedged return; t over events clustered by UTC day (mean per day, t over days).
 * BAR: t >= ENTRY.bar.tRequired (2.246). CONTROLS: placebo — events at random hours with |BTC| < 0.3% (matched count per month),
 * same position rule, 200 draws, the true mean must beat the 95th percentile; peek — the sign of the realised hedged return must
 * clear the bar.
 *
 * IMPLEMENTATION NOTES (fixed before any outcome was computed):
 *  N1. Data: BTC-USD and ETH-USD reuse data/training/flows4/coinbase-{BTC,ETH}-USD-1h.json (R200 cache, 2019-12-20..2026-09-01,
 *      candle time = bucket START, UTC). SOL, LTC, LINK, DOGE, ADA, AVAX, DOT: Coinbase Exchange public candles, granularity 3600,
 *      <=300 per call, ~350 ms between calls, 2021-06-01T00:00Z .. 2026-09-01T00:00Z (pages before a coin's Coinbase listing come
 *      back empty, so each coin starts at its own listing). Cached to data/training/crypto3/coinbase-<PRODUCT>-1h.json.
 *  N2. BTC hourly return of candle h = close(h) / close(h-1H) - 1 (close-to-close); both candles must exist exactly, else the hour
 *      is not eligible (neither as an event nor as a placebo candidate). Entry instant = close of candle h (h + 1H).
 *  N3. "Coins present that hour" = alts with an exact candle h (entry price = its close). Exit instant = h + 3H; exit price = close
 *      of candle h+2H, falling back to candle h+1H's close (the last trade before exit); a coin with neither is dropped from that
 *      event's basket (recorded). BTC's exit uses the same rule; an event whose BTC exit is unpriced is dropped (recorded). An event
 *      with zero alts priced is dropped (recorded).
 *  N4. dir = sign(BTC return of h). Per event: net = dir x (mean_alt(exit/entry - 1) - (BTC exit/entry - 1)) - 0.004, a return per
 *      $1 of notional on each leg (long $1 alt basket / short $1 BTC for an up move, mirrored for a down move); 0.004 = 10 bps x
 *      2 sides x 2 legs.
 *  N5. Cooldown: an eligible hour with |r| >= 1.5% is TAKEN unless it starts <= 3 hours after the previously TAKEN event hour
 *      (h - prevTaken <= 3H -> skipped). Qualification uses only information up to the close of h, so dropping an event later for
 *      an unpriced exit does not change the cooldown chain. Reported variant: cooldown against ANY prior qualifying hour.
 *  N6. Window: event candle h from 2021-06-01T00:00Z through 2026-08-31T20:00Z (so every exit, close of h+2H, lies inside the
 *      caches, which end 2026-09-01T00:00Z). Day cluster = UTC date of candle h's start. Primary: mean of per-day means, plain
 *      one-sample t over days (sd n-1). Also reported: event-level mean and t, gross, up vs down moves, each alt alone vs BTC,
 *      the unhedged basket (alts only, 20 bps), by year.
 *  N7. Placebo: candidates = eligible hours in the window with 0 < |BTC r| < 0.3% (exact zero has no direction -> excluded), a
 *      priced BTC exit and >= 1 priced alt, grouped by UTC month of h. One draw = for each month, k_m hours sampled WITHOUT
 *      replacement (seeded partial Fisher-Yates, mulberry32 seed 209) where k_m = the number of priced true events that month; same
 *      position rule and cost; statistic = mean of per-day means (the same clustering as the primary). No cooldown applied to the
 *      placebo (sampled hours are distinct). 200 draws. Beaten = true mean of day-means strictly > sorted[ceil(0.95*200)-1].
 *  N8. Peek (validity gate, house convention R193/R197): each event's direction replaced by the sign of its own realised GROSS
 *      hedged return, net = |gross| - 0.004 (gross exactly 0 -> flat, 0, no cost), clustered the same way; its t must be >= bar,
 *      else the harness is not trusted and nothing is sealed.
 *  N9. Seal gates: peek clears; 200 finite placebo draws; >= 100 event-days; every month with true events has >= k_m placebo
 *      candidates. VERDICT: PASS = primary t >= bar AND placebo beaten.
 *
 *   node backend/r209-btc-lead-alts.js --fetch   -> fills the alt caches only (no statistics computed)
 *   node backend/r209-btc-lead-alts.js [--dry]   -> data/r209-btc-lead-alts.json (refuses if R209 is already sealed)
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const DRY = process.argv.includes("--dry"), FETCH_ONLY = process.argv.includes("--fetch");
const ID = "R209", OUT = D("r209-btc-lead-alts.json");
const FLOWS4 = D(path.join("training", "flows4")), CACHE = D(path.join("training", "crypto3"));
const ENTRY = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")).preregistered.find((t) => t.id === ID);
if (!ENTRY) { console.error(`${ID} not registered`); process.exit(2); }
const BAR = ENTRY.bar.tRequired, COST_RT = 0.004, DRAWS = 200, SEED = 209, H = 3600e3;
const THRESH = 0.015, PLACEBO_MAX = 0.003, COOLDOWN = 3 * H, HOLD = 2;
const ALT_START = Date.parse("2021-06-01T00:00:00Z"), ALT_END = Date.parse("2026-09-01T00:00:00Z");
const EV_FIRST = Date.parse("2021-06-01T00:00:00Z"), EV_LAST = Date.parse("2026-08-31T20:00:00Z");
const FETCHED = ["SOL", "LTC", "LINK", "DOGE", "ADA", "AVAX", "DOT"], ALTS = ["ETH", ...FETCHED];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function tPlain(a) { const n = a.length; if (n < 3) return null; const m = mean(a); const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1); return m / Math.sqrt(v / n); }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r3 = (x) => (x == null || !Number.isFinite(x) ? x : +x.toFixed(3)), bps = (x) => r3(x * 1e4);
const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const todayET = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10), monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);

async function fetchHourly(product, startMs, endMs) {
  fs.mkdirSync(CACHE, { recursive: true });
  const f = path.join(CACHE, `coinbase-${product}-1h.json`);
  if (fs.existsSync(f)) { const j = JSON.parse(fs.readFileSync(f, "utf8")); if (j.startMs === startMs && j.endMs === endMs) return j.rows; }
  const map = new Map(); let calls = 0;
  for (let s = startMs; s < endMs; s += 300 * H) {
    const e = Math.min(endMs - H, s + 299 * H);
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
  writeJsonAtomic(f, { source: "api.exchange.coinbase.com candles 3600 (time = bucket start, UTC)", product, startMs, endMs, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), fetchedAt: new Date().toISOString(), calls, rows }, { pretty: 0 });
  return rows;
}
function loadFlows4(product) {
  const j = JSON.parse(fs.readFileSync(path.join(FLOWS4, `coinbase-${product}-1h.json`), "utf8"));
  if (j.startMs > ALT_START || j.endMs < ALT_END) throw new Error(`${product} flows4 cache does not span the window`);
  return j.rows;
}

(async () => {
  const px = {}, coverage = {};
  for (const c of FETCHED) {
    const rows = await fetchHourly(`${c}-USD`, ALT_START, ALT_END); px[c] = new Map(rows.map((r) => [r.t, r.c]));
    coverage[c] = { candles: rows.length, first: rows.length ? new Date(rows[0].t).toISOString() : null, last: rows.length ? new Date(rows[rows.length - 1].t).toISOString() : null };
    console.log(`  ${c}-USD: ${rows.length} hourly candles (${coverage[c].first} .. ${coverage[c].last})`);
  }
  if (FETCH_ONLY) { console.log("--fetch: caches filled, no statistics computed"); return; }
  { const s = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (s.tests[ID]) { console.error(`${ID} already sealed — refusing`); process.exit(2); } }
  console.log(`${ID} — BTC leads altcoins (2h hedged catch-up) · bar t >= ${BAR}`);
  for (const c of ["BTC", "ETH"]) {
    const rows = loadFlows4(`${c}-USD`).filter((r) => r.t >= ALT_START && r.t < ALT_END); px[c] = new Map(rows.map((r) => [r.t, r.c]));
    coverage[c] = { candles: rows.length, first: new Date(rows[0].t).toISOString(), last: new Date(rows[rows.length - 1].t).toISOString(), source: "flows4 (R200 cache)" };
  }
  const exitPx = (c, h) => { const a = px[c].get(h + HOLD * H); if (a != null) return a; const b = px[c].get(h + (HOLD - 1) * H); return b != null ? b : null; };
  /** legs for event hour h: {rBtc, alts:{c:ret}} or {why} */
  const legs = (h) => {
    const b0 = px.BTC.get(h), b1 = exitPx("BTC", h); if (b0 == null || b1 == null) return { why: "BTC exit unpriced" };
    const alts = {}; for (const c of ALTS) { const a0 = px[c].get(h); if (a0 == null) continue; const a1 = exitPx(c, h); if (a1 == null) continue; alts[c] = a1 / a0 - 1; }
    if (!Object.keys(alts).length) return { why: "no alt priced" };
    return { rBtc: b1 / b0 - 1, alts };
  };
  const basket = (L) => mean(Object.values(L.alts));
  const netOf = (L, dir, cost = COST_RT) => (dir ? dir * (basket(L) - L.rBtc) - cost : 0);

  // ---- scan eligible hours ------------------------------------------------------------------------------------------------------
  const events = [], dropped = [], candidates = new Map(); let eligible = 0, qualifying = 0, skippedCooldown = 0, prevTaken = -Infinity, prevAny = -Infinity;
  const anyCooldownEvents = [];
  for (let h = EV_FIRST; h <= EV_LAST; h += H) {
    const c1 = px.BTC.get(h), c0 = px.BTC.get(h - H); if (c1 == null || c0 == null) continue;
    eligible++; const r = c1 / c0 - 1, a = Math.abs(r);
    if (a >= THRESH) {
      qualifying++;
      if (h - prevAny > COOLDOWN) { const L = legs(h); if (!L.why) anyCooldownEvents.push({ h, r, L }); }
      prevAny = h;
      if (h - prevTaken <= COOLDOWN) { skippedCooldown++; continue; }
      prevTaken = h; const L = legs(h);
      if (L.why) { dropped.push({ hour: new Date(h).toISOString(), why: L.why }); continue; }
      events.push({ h, r, L });
    } else if (a > 0 && a < PLACEBO_MAX) {
      const L = legs(h); if (L.why) continue;
      const m = monthOf(h); if (!candidates.has(m)) candidates.set(m, []); candidates.get(m).push({ h, r, L });
    }
  }
  console.log(`  eligible hours ${eligible}; |BTC| >= 1.5%: ${qualifying} qualifying, ${skippedCooldown} skipped by cooldown, ${events.length} priced events, ${dropped.length} dropped`);

  const dayClustered = (rows) => { const by = new Map(); for (const x of rows) { const d = dayOf(x.h); if (!by.has(d)) by.set(d, []); by.get(d).push(x.v); } const dm = [...by.values()].map(mean); return { days: dm.length, events: rows.length, meanBps: bps(mean(dm)), t: r3(tPlain(dm)), eventMeanBps: bps(mean(rows.map((x) => x.v))), eventT: r3(tPlain(rows.map((x) => x.v))), hitRate: r3(rows.filter((x) => x.v > 0).length / rows.length), _m: mean(dm) }; };
  const strip = (o) => { const { _m, ...rest } = o; return rest; };
  const primRows = events.map((e) => ({ h: e.h, v: netOf(e.L, sgn(e.r)) })), prim = dayClustered(primRows);
  console.log(`  PRIMARY ${prim.events} events on ${prim.days} days: net hedged ${prim.meanBps} bps per day-mean, t ${prim.t} (bar ${BAR}); event-level ${prim.eventMeanBps} bps t ${prim.eventT}; hit ${prim.hitRate}`);

  const V = (f, fn) => strip(dayClustered(events.filter(f).map((e) => ({ h: e.h, v: fn(e) }))));
  const variants = {
    gross: V(() => true, (e) => netOf(e.L, sgn(e.r), 0)),
    upMoves: V((e) => e.r > 0, (e) => netOf(e.L, 1)),
    downMoves: V((e) => e.r < 0, (e) => netOf(e.L, -1)),
    unhedgedBasket20bps: V(() => true, (e) => sgn(e.r) * basket(e.L) - 0.002),
    btcContinuation20bps: V(() => true, (e) => sgn(e.r) * e.L.rBtc - 0.002),
    cooldownVsAnyQualifying: strip(dayClustered(anyCooldownEvents.map((e) => ({ h: e.h, v: netOf(e.L, sgn(e.r)) })))),
    perAlt: Object.fromEntries(ALTS.map((c) => [c, V((e) => e.L.alts[c] != null, (e) => sgn(e.r) * (e.L.alts[c] - e.L.rBtc) - COST_RT)])),
  };
  const byYear = {}; for (const y of [...new Set(events.map((e) => dayOf(e.h).slice(0, 4)))]) byYear[y] = V((e) => dayOf(e.h).startsWith(y), (e) => netOf(e.L, sgn(e.r)));
  const basketSize = mean(events.map((e) => Object.keys(e.L.alts).length));
  console.log(`  variants: gross ${variants.gross.meanBps} bps t ${variants.gross.t} · up ${variants.upMoves.meanBps} t ${variants.upMoves.t} · down ${variants.downMoves.meanBps} t ${variants.downMoves.t} · unhedged ${variants.unhedgedBasket20bps.meanBps} t ${variants.unhedgedBasket20bps.t} · BTC continuation ${variants.btcContinuation20bps.meanBps} t ${variants.btcContinuation20bps.t} · mean basket ${r3(basketSize)} coins`);

  // ---- peek (N8) ----------------------------------------------------------------------------------------------------------------
  const peek = strip(dayClustered(events.map((e) => { const g = basket(e.L) - e.L.rBtc; return { h: e.h, v: g ? Math.abs(g) - COST_RT : 0 }; })));
  const peekClears = peek.t != null && peek.t >= BAR;
  console.log(`  PEEK (realised-sign): ${peek.meanBps} bps t ${peek.t} -> ${peekClears ? "clears" : "does NOT clear"} the bar`);

  // ---- placebo (N7) -------------------------------------------------------------------------------------------------------------
  const kByMonth = new Map(); for (const e of events) { const m = monthOf(e.h); kByMonth.set(m, (kByMonth.get(m) || 0) + 1); }
  const short = [...kByMonth].filter(([m, k]) => (candidates.get(m) || []).length < k).map(([m]) => m);
  const candNet = new Map([...candidates].map(([m, arr]) => [m, arr.map((x) => ({ h: x.h, v: netOf(x.L, sgn(x.r)) }))]));
  const rnd = mulberry(SEED), draws = [];
  for (let k = 0; k < DRAWS; k++) {
    const rows = [];
    for (const [m, km] of kByMonth) {
      const pool = (candNet.get(m) || []).slice(), n = Math.min(km, pool.length);
      for (let i = 0; i < n; i++) { const j = i + Math.floor(rnd() * (pool.length - i)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; rows.push(pool[i]); }
    }
    draws.push(dayClustered(rows)._m);
  }
  const ds = [...draws].sort((a, b) => a - b), p95 = ds[Math.ceil(0.95 * DRAWS) - 1], placeboBeaten = prim._m > p95;
  const finiteDraws = draws.filter(Number.isFinite).length;
  const allCand = strip(dayClustered([...candNet.values()].flat()));
  console.log(`  PLACEBO (${DRAWS}, random |BTC|<0.3% hours matched per month): p50 ${bps(ds[Math.ceil(0.5 * DRAWS) - 1])} bps p95 ${bps(p95)} bps -> true ${prim.meanBps} bps ${placeboBeaten ? "BEATS" : "does NOT beat"} p95; all candidates pooled ${allCand.meanBps} bps t ${allCand.t} (${allCand.events} hours)`);

  // ---- verdict ------------------------------------------------------------------------------------------------------------------
  const primaryClears = prim.t != null && prim.t >= BAR, pass = primaryClears && placeboBeaten;
  const verdict = `${pass ? "PASS" : "DID NOT PASS"} — after a >=1.5% BTC hour, long/short the alt basket vs an equal-dollar opposite BTC leg for 2h, net ${prim.meanBps} bps per event-day (40bps RT), t ${prim.t} vs bar ${BAR} over ${prim.days} event-days (${prim.events} events, 2021-06..2026-08); gross ${variants.gross.meanBps} bps t ${variants.gross.t}; placebo p95 ${bps(p95)} bps (${placeboBeaten ? "beaten" : "not beaten"}); peek t ${peek.t}; up t ${variants.upMoves.t}, down t ${variants.downMoves.t}`;
  const gates = { peekClears, placeboFinite: finiteDraws === DRAWS, eventDaysOk: prim.days >= 100, placeboCandidatesOk: short.length === 0 };
  const controlsValid = Object.values(gates).every(Boolean);
  const out = { spec: "r209-btc-lead-alts-v1", test: ID, asOf: new Date().toISOString(), window: [new Date(EV_FIRST).toISOString(), new Date(EV_LAST).toISOString()], bar: BAR, costRoundTripTotal: COST_RT, thresholdAbsBtc: THRESH, holdHours: HOLD,
    coverage: { hourlyCandles: coverage, eligibleHours: eligible, qualifying, skippedCooldown, pricedEvents: events.length, dropped, meanBasketSize: r3(basketSize), placeboCandidates: [...candidates.values()].reduce((s, a) => s + a.length, 0), monthsShortOfCandidates: short },
    primary: { ...strip(prim), clearsBar: primaryClears }, variants, byYear,
    controls: { peek: { ...peek, clearsBar: peekClears }, placebo: { draws: DRAWS, seed: SEED, finite: finiteDraws, p50Bps: bps(ds[Math.ceil(0.5 * DRAWS) - 1]), p95Bps: bps(p95), maxBps: bps(ds[DRAWS - 1]), trueBps: prim.meanBps, beaten: placeboBeaten, allCandidatesPooled: allCand, allBps: draws.map(bps) } },
    events: events.map((e, i) => ({ hour: new Date(e.h).toISOString(), btcRetPct: r3(e.r * 100), basketRetPct: r3(basket(e.L) * 100), btcHoldRetPct: r3(e.L.rBtc * 100), nAlts: Object.keys(e.L.alts).length, netBps: bps(primRows[i].v) })),
    gates, verdict, pass, controlsValid };
  writeJsonAtomic(DRY ? OUT.replace(/.json$/, ".dry.json") : OUT, out);
  console.log(`\n  VERDICT: ${verdict}`);
  console.log(`  gates: ${JSON.stringify(gates)}`);
  if (DRY) { console.log("  --dry: harness check only, NOT sealed"); return; }
  if (!controlsValid) { console.log("  controls invalid — NOT sealed"); return; }
  const today = todayET();
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests[ID]) throw new Error("sealed concurrently — not overwriting");
  seals.tests[ID] = { sealedOn: today, unit: "event-days", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E = reg.preregistered.find((t) => t.id === ID);
  E.status = `READ ${today} — ${verdict}`; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: ID, verdict }) + "\n");
  console.log(`  sealed ${ID} (${today})`);
})().catch((e) => { console.error(`${ID} FAILED (nothing sealed):`, e.message); process.exit(1); });
