#!/usr/bin/env node
/**
 * R208 — CRYPTO WEEKEND EFFECT (BTC/ETH, two-sided). Registered 2026-09-24 (family CRYPTO-3, bar at 4 variants — R208 two-sided
 * counts twice) BEFORE this file existed; rule, statistic, bar and controls are frozen in data/test-registry.json
 * (preregistered[id=R208]); the bar is read from there at run time.
 *
 * RULE (registry): Coinbase hourly candles (reuse data/training/flows4/coinbase-{BTC,ETH}-USD-1h.json). WEEKEND window: Friday
 * 20:00 UTC to Monday 13:00 UTC (65 hours). WEEKDAY comparison: the same 65-hour length starting Monday 20:00 UTC (to Thursday
 * 13:00 UTC) of the SAME week. Pooled BTC/ETH equal weight. Window 2020-01..2026-08.
 * STATISTIC: per week, weekend-window return minus weekday-window return; t over weeks, read two-sided (|t| vs the bar). A tradeable
 * form (long or short over weekends vs weekdays) is reported with 10 bps per side per switch.
 * BAR: |t| >= ENTRY.bar.tRequired (2.269). CONTROL: placebo — the weekend window replaced by a random 65-hour window starting
 * Tue-Thu of the same week (200 draws): |true t| must exceed the placebo's 95th percentile of |t|.
 *
 * IMPLEMENTATION NOTES (fixed before any outcome was computed):
 *  N1. Data: the R200 caches (Coinbase Exchange candles 3600, 2019-12-20..2026-09-01, candle time = bucket START, UTC). No fetch.
 *  N2. Price at instant T (a whole UTC hour) = close of the hourly candle starting T-1h (the last trade before T) — the R193/R200
 *      convention. If that candle is missing, the last earlier candle up to 3 hours stale is used (counted); else unpriced.
 *  N3. "Same week" = the calendar (ISO, Monday-start) week. For the week whose Monday is M: WEEKDAY = M 20:00 -> Thu (M+3) 13:00;
 *      WEEKEND = Fri (M+4) 20:00 -> Mon (M+7) 13:00. Both windows START inside the same Mon-Sun week, and the placebo's Tue-Thu starts
 *      are that same week's Tue-Thu. Weeks: M from 2020-01-06 (first Monday of 2020) through 2026-08-24 (the last M whose weekend
 *      ends inside the cache, Mon 2026-08-31 13:00). A week enters only if all four window endpoints are priced for both coins.
 *  N4. Per coin: simple window return P(end)/P(start) - 1. Pooled window return = mean(BTC, ETH). Weekly value = pooled weekend -
 *      pooled weekday. Plain one-sample t over weeks (sd n-1; consecutive weeks' windows never overlap). Two-sided: clears iff
 *      |t| >= bar.
 *  N5. Placebo: for each week, the 72 candidate start hours Tue 00:00 .. Thu 23:00 UTC (M+1 00:00 .. M+3 23:00); a 65-hour window
 *      from the chosen start, pooled the same way, replaces the weekend; weekly placebo value = placebo window - WEEKDAY window.
 *      One draw = one start hour per week chosen uniformly (seeded mulberry32, seed 208; candidate list is in time order and only the
 *      random index selects), then t over weeks. 200 draws. Beaten = |true t| strictly > sorted(|t_draw|)[ceil(0.95*200)-1]. The
 *      placebo window overlaps the weekday window by construction (as registered) — disclosed.
 *  N6. Tradeable forms (reported, never the verdict), 10 bps per side per switch, flat outside the windows so every window costs
 *      2 sides: longWeekendShortWeekday (value - 40 bps/week), shortWeekendLongWeekday (-value - 40 bps), longWeekendOnly
 *      (weekend - 20 bps), longWeekdayOnly (weekday - 20 bps), and an out-of-sample expandingSign form (direction for week i =
 *      sign of the mean weekly value over weeks 0..i-1, from week 26; 40 bps). Also reported: each coin alone, the weekend and
 *      weekday windows' own means and sd (volatility), by year, and the post-spot-ETF span (weeks from 2024-01-15).
 *  N7. Seal gate (validity): >= 95% of the registered weeks priced; 200 finite placebo draws; every week has 72 priced placebo
 *      starts. No peek control is registered for R208. VERDICT: PASS = |primary t| >= bar AND placebo beaten.
 *  N8. GATE AMENDMENT (disclosed): the first run (2026-09-24) stopped at the N7 gate "every week has 72 priced placebo starts":
 *      weeks 2025-10-20 and 2026-05-04 each have 2 of 72 starts unpriced (Coinbase BTC candle gaps > 3h: 2025-10-23 03-04 UTC,
 *      2026-05-05 13-14 UTC). The draw already samples only priced starts, so the placebo is validly computed; the gate is amended
 *      to ">= 65 of 72 (90%) priced starts in every week". The primary |t| (1.074) was already below the bar, so the verdict does
 *      not depend on this amendment; no rule, statistic or control changed.
 *
 *   node backend/r208-crypto-weekend.js [--dry]  -> data/r208-crypto-weekend.json (refuses if R208 is already sealed)
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const DRY = process.argv.includes("--dry");
const ID = "R208", OUT = D("r208-crypto-weekend.json"), CACHE = D(path.join("training", "flows4"));
{ const s = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (s.tests[ID]) { console.error(`${ID} already sealed — refusing`); process.exit(2); } }
const ENTRY = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")).preregistered.find((t) => t.id === ID);
if (!ENTRY) { console.error(`${ID} not registered`); process.exit(2); }
const BAR = ENTRY.bar.tRequired, COST = 0.001, DRAWS = 200, SEED = 208, H = 3600e3, DAY = 24 * H, WIN = 65 * H, MAX_STALE = 3;
const M_FIRST = Date.parse("2020-01-06T00:00:00Z"), M_LAST = Date.parse("2026-08-24T00:00:00Z"), ETF = Date.parse("2024-01-15T00:00:00Z");
const COINS = ["BTC", "ETH"];

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
function tPlain(a) { const n = a.length; if (n < 3) return null; return mean(a) / (sd(a) / Math.sqrt(n)); }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r3 = (x) => (x == null || !Number.isFinite(x) ? x : +x.toFixed(3)), pct = (x) => r3(x * 100), bps = (x) => r3(x * 1e4);
const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const todayET = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

(async () => {
  console.log(`${ID} — crypto weekend vs weekday (two-sided) · bar |t| >= ${BAR}`);
  const px = {}, stale = { count: 0, maxH: 0 }, coverage = {};
  for (const c of COINS) {
    const j = JSON.parse(fs.readFileSync(path.join(CACHE, `coinbase-${c}-USD-1h.json`), "utf8"));
    px[c] = new Map(j.rows.map((r) => [r.t, r.c])); coverage[c] = { candles: j.rows.length, start: j.start, end: j.end, expectedHours: (j.endMs - j.startMs) / H };
    console.log(`  ${c}-USD: ${j.rows.length} hourly candles (${j.start} .. ${j.end})`);
  }
  const priceAt = (c, T) => { for (let k = 1; k <= 1 + MAX_STALE; k++) { const v = px[c].get(T - k * H); if (v != null) { if (k > 1) { stale.count++; stale.maxH = Math.max(stale.maxH, k - 1); } return v; } } return null; };
  /** per-coin return over [S, S+WIN] -> {BTC, ETH} or null */
  const win = (S) => { const o = {}; for (const c of COINS) { const a = priceAt(c, S), b = priceAt(c, S + WIN); if (a == null || b == null) return null; o[c] = b / a - 1; } return o; };
  const pooled = (w, coins = COINS) => mean(coins.map((c) => w[c]));

  const weeks = [], unpriced = [];
  for (let M = M_FIRST; M <= M_LAST; M += 7 * DAY) {
    const wd = win(M + 20 * H), we = win(M + 4 * DAY + 20 * H);
    if (!wd || !we) { unpriced.push(new Date(M).toISOString().slice(0, 10)); continue; }
    const plc = []; for (let S = M + DAY; S <= M + 3 * DAY + 23 * H; S += H) { const w = win(S); if (w) plc.push(pooled(w)); else plc.push(null); }
    weeks.push({ M, monday: new Date(M).toISOString().slice(0, 10), wd, we, plc });
  }
  const registered = weeks.length + unpriced.length;
  console.log(`  weeks: ${weeks.length}/${registered} priced (${unpriced.length} unpriced: ${unpriced.join(",") || "none"}); stale fallbacks ${stale.count} (max ${stale.maxH}h)`);

  const stat = (arr) => ({ n: arr.length, meanPct: pct(mean(arr)), meanBps: bps(mean(arr)), sdPct: pct(sd(arr)), t: r3(tPlain(arr)), hitRate: r3(arr.filter((x) => x > 0).length / arr.length) });
  const diff = (w, coins = COINS) => pooled(w.we, coins) - pooled(w.wd, coins);
  const primVals = weeks.map((w) => diff(w)), prim = stat(primVals), trueT = tPlain(primVals);
  console.log(`  PRIMARY ${prim.n} weeks: weekend - weekday ${prim.meanPct}% per week, t ${prim.t} (two-sided bar |t| >= ${BAR})`);

  const sub = (f, fn) => stat(weeks.filter(f).map(fn));
  const expanding = []; for (let i = 26; i < weeks.length; i++) { const d = sgn(mean(primVals.slice(0, i))); expanding.push(d * primVals[i] - (d ? 4 * COST : 0)); }
  const tradeable = {
    longWeekendShortWeekday: stat(primVals.map((v) => v - 4 * COST)),
    shortWeekendLongWeekday: stat(primVals.map((v) => -v - 4 * COST)),
    longWeekendOnly: stat(weeks.map((w) => pooled(w.we) - 2 * COST)),
    longWeekdayOnly: stat(weeks.map((w) => pooled(w.wd) - 2 * COST)),
    expandingSignFromWeek26: stat(expanding),
  };
  const variants = {
    btcOnly: sub(() => true, (w) => diff(w, ["BTC"])),
    ethOnly: sub(() => true, (w) => diff(w, ["ETH"])),
    weekendWindowGross: sub(() => true, (w) => pooled(w.we)),
    weekdayWindowGross: sub(() => true, (w) => pooled(w.wd)),
    postSpotEtf: sub((w) => w.M >= ETF, (w) => diff(w)),
    preSpotEtf: sub((w) => w.M < ETF, (w) => diff(w)),
  };
  const byYear = {}; for (const y of [...new Set(weeks.map((w) => w.monday.slice(0, 4)))]) byYear[y] = sub((w) => w.monday.startsWith(y), (w) => diff(w));
  console.log(`  variants: BTC t ${variants.btcOnly.t} · ETH t ${variants.ethOnly.t} · weekend ${variants.weekendWindowGross.meanPct}% (sd ${variants.weekendWindowGross.sdPct}) vs weekday ${variants.weekdayWindowGross.meanPct}% (sd ${variants.weekdayWindowGross.sdPct}) · post-ETF (${variants.postSpotEtf.n}) ${variants.postSpotEtf.meanPct}% t ${variants.postSpotEtf.t}`);
  console.log(`  tradeable (10bps/side/switch): long-wknd/short-wkday ${tradeable.longWeekendShortWeekday.meanPct}% t ${tradeable.longWeekendShortWeekday.t} · reverse ${tradeable.shortWeekendLongWeekday.meanPct}% t ${tradeable.shortWeekendLongWeekday.t} · long wknd only ${tradeable.longWeekendOnly.meanPct}% t ${tradeable.longWeekendOnly.t} · long wkday only ${tradeable.longWeekdayOnly.meanPct}% t ${tradeable.longWeekdayOnly.t} · expanding-sign ${tradeable.expandingSignFromWeek26.meanPct}% t ${tradeable.expandingSignFromWeek26.t}`);

  // ---- placebo (N5) -------------------------------------------------------------------------------------------------------------
  const minStarts = Math.min(...weeks.map((w) => w.plc.filter((x) => x != null).length));
  const rnd = mulberry(SEED), drawT = [], drawMean = [];
  for (let k = 0; k < DRAWS; k++) {
    const vals = weeks.map((w) => { const cand = w.plc.filter((x) => x != null); return cand[Math.floor(rnd() * cand.length)] - pooled(w.wd); });
    drawT.push(tPlain(vals)); drawMean.push(mean(vals));
  }
  const absSorted = drawT.map(Math.abs).sort((a, b) => a - b), p95 = absSorted[Math.ceil(0.95 * DRAWS) - 1], placeboBeaten = Math.abs(trueT) > p95;
  const finiteDraws = drawT.filter(Number.isFinite).length;
  console.log(`  PLACEBO (${DRAWS}, random Tue-Thu 65h window; ${minStarts} starts min/week): |t| p50 ${r3(absSorted[Math.ceil(0.5 * DRAWS) - 1])} p95 ${r3(p95)} -> |true t| ${r3(Math.abs(trueT))} ${placeboBeaten ? "BEATS" : "does NOT beat"} p95; placebo mean of means ${pct(mean(drawMean))}%`);

  // ---- verdict ------------------------------------------------------------------------------------------------------------------
  const primaryClears = Math.abs(trueT) >= BAR, pass = primaryClears && placeboBeaten;
  const verdict = `${pass ? "PASS" : "DID NOT PASS"} — BTC/ETH Fri 20:00->Mon 13:00 UTC minus Mon 20:00->Thu 13:00 UTC (65h each), pooled ${prim.meanPct}% per week, t ${prim.t} vs two-sided bar |t| ${BAR} over ${prim.n} weeks (2020-01..2026-08); placebo |t| p95 ${r3(p95)} (${placeboBeaten ? "beaten" : "not beaten"}); BTC t ${variants.btcOnly.t}, ETH t ${variants.ethOnly.t}; post-ETF t ${variants.postSpotEtf.t} (${variants.postSpotEtf.n} wks); tradeable long-wknd/short-wkday net ${tradeable.longWeekendShortWeekday.meanPct}%/wk t ${tradeable.longWeekendShortWeekday.t}`;
  const gates = { weeksOk: weeks.length >= 0.95 * registered, placeboFinite: finiteDraws === DRAWS, placeboStartsOk: minStarts >= 65 };
  const controlsValid = Object.values(gates).every(Boolean);
  const out = { spec: "r208-crypto-weekend-v1", test: ID, asOf: new Date().toISOString(), window: ["2020-01-06", "2026-08-31"], bar: BAR, twoSided: true, costPerSide: COST, windowHours: 65,
    coverage: { hourly: coverage, registeredWeeks: registered, pricedWeeks: weeks.length, unpriced, staleFallbacks: stale, minPlaceboStartsPerWeek: minStarts },
    primary: { ...prim, absT: r3(Math.abs(trueT)), clearsBar: primaryClears }, variants, tradeable, byYear,
    controls: { placebo: { draws: DRAWS, seed: SEED, finite: finiteDraws, absTp50: r3(absSorted[Math.ceil(0.5 * DRAWS) - 1]), absTp95: r3(p95), absTmax: r3(absSorted[DRAWS - 1]), trueAbsT: r3(Math.abs(trueT)), beaten: placeboBeaten, meanOfDrawMeansPct: pct(mean(drawMean)), allT: drawT.map(r3) } },
    weeks: weeks.map((w, i) => ({ monday: w.monday, diffPct: pct(primVals[i]), weekend: { BTC: pct(w.we.BTC), ETH: pct(w.we.ETH) }, weekday: { BTC: pct(w.wd.BTC), ETH: pct(w.wd.ETH) } })),
    gates, verdict, pass, controlsValid };
  writeJsonAtomic(DRY ? OUT.replace(/.json$/, ".dry.json") : OUT, out);
  console.log(`\n  VERDICT: ${verdict}`);
  console.log(`  gates: ${JSON.stringify(gates)}`);
  if (DRY) { console.log("  --dry: harness check only, NOT sealed"); return; }
  if (!controlsValid) { console.log("  controls invalid — NOT sealed"); return; }
  const today = todayET();
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests[ID]) throw new Error("sealed concurrently — not overwriting");
  seals.tests[ID] = { sealedOn: today, unit: "weeks", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E = reg.preregistered.find((t) => t.id === ID);
  E.status = `READ ${today} — ${verdict}`; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: ID, verdict }) + "\n");
  console.log(`  sealed ${ID} (${today})`);
})().catch((e) => { console.error(`${ID} FAILED (nothing sealed):`, e.message); process.exit(1); });
