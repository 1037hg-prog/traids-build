#!/usr/bin/env node
/**
 * R196 — PRE-FOMC DRIFT (Lucca & Moench 2015). Registered 2026-09-24 (family MINE-3, best-of-5) BEFORE this file existed; rule,
 * statistic, bar and control are frozen in data/test-registry.json (preregistered[id=R196]); the bar is read from there at run time.
 *
 * RULE (registry): scheduled FOMC statement days 2015-07-01..2026-08-31 (unscheduled meetings excluded). Long SPY from 14:00 ET on
 * the prior trading day to 13:55 ET on statement day (Alpaca SIP 1-minute). Cost 1 bp per side.
 * STATISTIC: per meeting, the net window return minus SPY's average return over all other 24-hour 14:00-to-13:55 windows in the same
 * quarter; t over meetings. BAR: t >= ENTRY.bar.tRequired (2.368). CONTROL: placebo — the same window on random non-FOMC days
 * (200 draws); the true mean must beat the 95th percentile.
 *
 * FOMC DATES — read 2026-09-24 from the Federal Reserve's calendar pages and hard-coded below (statement = the LAST day of each
 * scheduled meeting; all statements in this span were released at 14:00 ET):
 *   https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm          (2021..2026)
 *   https://www.federalreserve.gov/monetarypolicy/fomchistorical2015.htm ... fomchistorical2020.htm   (2015..2020)
 * Excluded as not scheduled: 2019-10-04 (unscheduled call), 2020-03-03 (unscheduled call, listed by the Fed as March 2),
 * 2020-03-15 (unscheduled meeting, a Sunday), the cancelled 2020-03-17/18 meeting, and every notation vote (2020-03-19, 03-23,
 * 03-31, 08-27; 2025-08-22).
 *
 * IMPLEMENTATION NOTES (fixed before any outcome was computed):
 *  N1. Data: lib/mine3-minute.js — SIP 1Min, adjustment "split", regular-hours closes cached in data/training/mine3/; sessions and
 *      half-days from Alpaca /v2/calendar. Alpaca SIP minute history begins 2016-01-01 (probed 2026-09-24: 0 bars for 2015-07-28..30),
 *      so the four 2015 meetings (07-29, 09-17, 10-28, 12-16) CANNOT be priced from the registered source. They are listed as
 *      uncovered and not substituted from another source.
 *  N2. Price at HH:MM = close of the bar labelled HH:MM-1: 14:00 = the 13:59 bar close on the prior session, 13:55 = the 13:54 bar
 *      close on statement day; if missing, the last earlier in-session bar up to 5 minutes stale, else the window is invalid. A window
 *      whose start or end session closes before those minutes (half-days) is invalid.
 *  N3. A "24-hour 14:00-to-13:55 window" = a pair of consecutive trading sessions (p, d) whose calendar dates are one day apart
 *      (the literal 24-hour reading; Friday->Monday and holiday-spanning windows are excluded from the primary baseline and REPORTED
 *      as a variant). Every scheduled statement day in range is Tue-Thu with the prior session the day before; any that is not is
 *      listed and dropped. Window gross = P_d(13:55)/P_p(14:00) - 1; net = gross - 2 x 1 bp.
 *  N4. Quarter = the calendar quarter of the window's END date d. Baseline = the mean GROSS return of every other valid 24-hour
 *      window in that quarter (the meeting's own window excluded; cost belongs to the trade, not the drift baseline). The most literal
 *      "all other" keeps other windows that touch FOMC days; a variant excluding every FOMC-touching window is REPORTED.
 *  N5. t over meetings = plain one-sample t (meetings do not overlap). Reported: gross window, 2016-2019 vs 2020-2026 halves,
 *      all-consecutive-session baseline, FOMC-free baseline.
 *  N6. Placebo: pool = valid 24-hour windows whose start and end days are both non-statement days. Each draw samples N (= covered
 *      meetings) DISTINCT pool windows (seeded partial Fisher-Yates, seed 196) and computes the identical statistic (net minus its
 *      own quarter's baseline excluding itself); 200 draws. Beaten = true mean strictly > sorted[ceil(0.95*200)-1]. Numeric
 *      percentile sorts have no row-order tie dependence.
 *  N7. Seal gate (validity, the R180 convention): covered meetings >= 90% of the scheduled meetings in the registered span and the
 *      placebo computed. The placebo is a VERDICT input: PASS = t >= bar AND placebo beaten.
 *
 *   node backend/r196-pre-fomc.js [--dry]  -> data/r196-pre-fomc.json (refuses if R196 is already sealed)
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { calendar, minuteCloses, priceAt } = require("./lib/mine3-minute.js");
const D = (f) => path.join(__dirname, "data", f);
const DRY = process.argv.includes("--dry");
const ID = "R196", OUT = D("r196-pre-fomc.json");
{ const s = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (s.tests[ID]) { console.error(`${ID} already sealed — refusing`); process.exit(2); } }
const ENTRY = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")).preregistered.find((t) => t.id === ID);
if (!ENTRY) { console.error(`${ID} not registered`); process.exit(2); }
const BAR = ENTRY.bar.tRequired, START = "2015-07-01", END = "2026-08-31", COST = 0.0001, DRAWS = 200, SEED = 196;
const T_START = 840, T_END = 835;   // 14:00 and 13:55 ET in minutes

const FOMC_SOURCE = ["https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", "https://www.federalreserve.gov/monetarypolicy/fomchistorical2015.htm .. fomchistorical2020.htm"];
const FOMC = [
  "2015-07-29", "2015-09-17", "2015-10-28", "2015-12-16",
  "2016-01-27", "2016-03-16", "2016-04-27", "2016-06-15", "2016-07-27", "2016-09-21", "2016-11-02", "2016-12-14",
  "2017-02-01", "2017-03-15", "2017-05-03", "2017-06-14", "2017-07-26", "2017-09-20", "2017-11-01", "2017-12-13",
  "2018-01-31", "2018-03-21", "2018-05-02", "2018-06-13", "2018-08-01", "2018-09-26", "2018-11-08", "2018-12-19",
  "2019-01-30", "2019-03-20", "2019-05-01", "2019-06-19", "2019-07-31", "2019-09-18", "2019-10-30", "2019-12-11",
  "2020-01-29", "2020-04-29", "2020-06-10", "2020-07-29", "2020-09-16", "2020-11-05", "2020-12-16",
  "2021-01-27", "2021-03-17", "2021-04-28", "2021-06-16", "2021-07-28", "2021-09-22", "2021-11-03", "2021-12-15",
  "2022-01-26", "2022-03-16", "2022-05-04", "2022-06-15", "2022-07-27", "2022-09-21", "2022-11-02", "2022-12-14",
  "2023-02-01", "2023-03-22", "2023-05-03", "2023-06-14", "2023-07-26", "2023-09-20", "2023-11-01", "2023-12-13",
  "2024-01-31", "2024-03-20", "2024-05-01", "2024-06-12", "2024-07-31", "2024-09-18", "2024-11-07", "2024-12-18",
  "2025-01-29", "2025-03-19", "2025-05-07", "2025-06-18", "2025-07-30", "2025-09-17", "2025-10-29", "2025-12-10",
  "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29",
].filter((d) => d >= START && d <= END);
const FSET = new Set(FOMC);

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const tstat = (a) => mean(a) / (sd(a) / Math.sqrt(a.length));
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r3 = (x) => (x == null || !Number.isFinite(x) ? x : +x.toFixed(3)), bps = (x) => r3(x * 1e4);
const qOf = (d) => `${d.slice(0, 4)}Q${Math.floor((+d.slice(5, 7) - 1) / 3) + 1}`;
const dayGap = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
const todayET = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

(async () => {
  console.log(`${ID} — pre-FOMC drift · bar t >= ${BAR} · ${FOMC.length} scheduled statements in ${START}..${END}`);
  const cal = await calendar("2015-12-01", END);
  const spy = await minuteCloses("SPY", "2016-01-01", END);
  const firstData = [...spy.keys()].sort()[0];

  // ---- every consecutive-session window ---------------------------------------------------------------------------------------
  const windows = [], invalid = [];
  for (let i = 1; i < cal.length; i++) {
    const p = cal[i - 1], d = cal[i];
    if (p.date < firstData) continue;
    const a = p.close > T_START ? priceAt(spy.get(p.date), T_START, p.open) : null, b = d.close > T_END ? priceAt(spy.get(d.date), T_END, d.open) : null;
    if (!a || !b) { invalid.push({ p: p.date, d: d.date, reason: !a ? (p.close <= T_START ? "start half-day" : "start bars missing") : (d.close <= T_END ? "end half-day" : "end bars missing") }); continue; }
    const gross = b.p / a.p - 1;
    windows.push({ p: p.date, d: d.date, q: qOf(d.date), h24: dayGap(p.date, d.date) === 1, gross, net: gross - 2 * COST, fomc: FSET.has(d.date), touchesFomc: FSET.has(d.date) || FSET.has(p.date), stale: Math.max(a.stale, b.stale) });
  }
  const byQ = new Map(); for (const w of windows) { if (!byQ.has(w.q)) byQ.set(w.q, []); byQ.get(w.q).push(w); }
  const baseline = (w, filt) => { const o = byQ.get(w.q).filter((x) => x !== w && filt(x)); return { m: mean(o.map((x) => x.gross)), n: o.length }; };
  const B_PRIMARY = (x) => x.h24, B_ALLSESS = () => true, B_NOFOMC = (x) => x.h24 && !x.touchesFomc;

  // ---- meetings ---------------------------------------------------------------------------------------------------------------
  const wByEnd = new Map(windows.map((w) => [w.d, w]));
  const meetings = [], uncovered = [];
  for (const f of FOMC) {
    const w = wByEnd.get(f);
    if (f < firstData) { uncovered.push({ date: f, reason: `before Alpaca SIP minute history (${firstData})` }); continue; }
    if (!w) { uncovered.push({ date: f, reason: invalid.find((x) => x.d === f)?.reason || "no session / window" }); continue; }
    if (!w.h24) { uncovered.push({ date: f, reason: "prior session not the previous calendar day" }); continue; }
    meetings.push(w);
  }
  const stat = (ws, filt = B_PRIMARY, cost = true) => ws.map((w) => (cost ? w.net : w.gross) - baseline(w, filt).m);
  const adj = stat(meetings);
  const tPrim = r3(tstat(adj)), meanPrim = mean(adj);
  console.log(`  coverage: ${meetings.length}/${FOMC.length} meetings priced (${uncovered.length} uncovered: ${uncovered.map((u) => u.date).join(", ")}) · ${windows.length} valid windows, ${windows.filter((w) => w.h24).length} 24-hour`);
  console.log(`  PRIMARY ${meetings.length} meetings: net window minus quarter baseline ${bps(meanPrim)} bps, t ${tPrim} (bar ${BAR}) · raw net ${bps(mean(meetings.map((w) => w.net)))} bps`);

  const sub = (lo, hi) => { const ws = meetings.filter((w) => w.d >= lo && w.d <= hi), a = stat(ws); return { n: ws.length, meanBps: bps(mean(a)), t: r3(tstat(a)) }; };
  const variants = {
    grossMinusBaseline: { meanBps: bps(mean(stat(meetings, B_PRIMARY, false))), t: r3(tstat(stat(meetings, B_PRIMARY, false))) },
    rawNetWindow: { meanBps: bps(mean(meetings.map((w) => w.net))), t: r3(tstat(meetings.map((w) => w.net))) },
    baselineAllConsecutiveSessions: { meanBps: bps(mean(stat(meetings, B_ALLSESS))), t: r3(tstat(stat(meetings, B_ALLSESS))) },
    baselineExcludingFomcWindows: { meanBps: bps(mean(stat(meetings, B_NOFOMC))), t: r3(tstat(stat(meetings, B_NOFOMC))) },
    y2016_2019: sub("2016-01-01", "2019-12-31"),
    y2020_2026: sub("2020-01-01", "2026-12-31"),
    hitRate: r3(adj.filter((x) => x > 0).length / adj.length),
  };
  console.log(`  variants: gross-adj t ${variants.grossMinusBaseline.t} · raw net ${variants.rawNetWindow.meanBps} bps t ${variants.rawNetWindow.t} · all-session baseline t ${variants.baselineAllConsecutiveSessions.t} · FOMC-free baseline t ${variants.baselineExcludingFomcWindows.t} · 2016-19 t ${variants.y2016_2019.t} (${variants.y2016_2019.n}) · 2020-26 t ${variants.y2020_2026.t} (${variants.y2020_2026.n})`);

  // ---- placebo ----------------------------------------------------------------------------------------------------------------
  const pool = windows.filter((w) => w.h24 && !w.touchesFomc && w.p >= "2016-01-01"), N = meetings.length, rnd = mulberry(SEED), pm = [], pt = [];
  const poolAdj = pool.map((w) => w.net - baseline(w, B_PRIMARY).m);
  for (let k = 0; k < DRAWS; k++) {
    const ix = pool.map((_, i) => i);
    for (let i = 0; i < N; i++) { const j = i + Math.floor(rnd() * (ix.length - i)); [ix[i], ix[j]] = [ix[j], ix[i]]; }
    const a = ix.slice(0, N).map((i) => poolAdj[i]); pm.push(mean(a)); pt.push(tstat(a));
  }
  const sm = [...pm].sort((a, b) => a - b), st = [...pt].sort((a, b) => a - b), p95 = sm[Math.ceil(0.95 * DRAWS) - 1], placeboBeaten = meanPrim > p95;
  console.log(`  PLACEBO (${DRAWS} draws of ${N} non-FOMC windows from ${pool.length}): mean p50 ${bps(sm[Math.ceil(0.5 * DRAWS) - 1])} p95 ${bps(p95)} bps (t p95 ${r3(st[Math.ceil(0.95 * DRAWS) - 1])}) -> true ${bps(meanPrim)} ${placeboBeaten ? "BEATS" : "does NOT beat"} p95`);

  // ---- verdict ----------------------------------------------------------------------------------------------------------------
  const primaryClears = tPrim >= BAR, pass = primaryClears && placeboBeaten;
  const verdict = `${pass ? "PASS" : "DID NOT PASS"} — SPY 14:00->13:55 pre-FOMC window net minus quarter baseline ${bps(meanPrim)} bps, t ${tPrim} vs bar ${BAR} over ${meetings.length} meetings (2015 uncovered: no SIP minutes); placebo p95 ${bps(p95)} bps (${placeboBeaten ? "beaten" : "not beaten"}); 2016-19 t ${variants.y2016_2019.t}, 2020-26 t ${variants.y2020_2026.t}`;
  const controlsValid = meetings.length >= 0.9 * FOMC.length && Number.isFinite(p95);
  const out = { spec: "r196-pre-fomc-v1", test: ID, asOf: new Date().toISOString(), window: [START, END], bar: BAR, costPerSide: COST, fomcSource: FOMC_SOURCE, fomcScheduled: FOMC,
    coverage: { scheduledInSpan: FOMC.length, priced: meetings.length, uncovered, firstMinuteData: firstData, validWindows: windows.length, h24Windows: windows.filter((w) => w.h24).length, invalidWindows: invalid.length, maxStaleMin: Math.max(...windows.map((w) => w.stale)) },
    primary: { n: meetings.length, meanAdjBps: bps(meanPrim), t: tPrim, clearsBar: primaryClears }, variants,
    controls: { placebo: { draws: DRAWS, seed: SEED, poolSize: pool.length, p50Bps: bps(sm[Math.ceil(0.5 * DRAWS) - 1]), p95Bps: bps(p95), maxBps: bps(sm[DRAWS - 1]), tP95: r3(st[Math.ceil(0.95 * DRAWS) - 1]), trueBps: bps(meanPrim), beaten: placeboBeaten, allMeansBps: pm.map(bps) } },
    meetings: meetings.map((w, i) => { const b = baseline(w, B_PRIMARY); return { date: w.d, prior: w.p, grossBps: bps(w.gross), netBps: bps(w.net), quarterBaselineBps: bps(b.m), baselineWindows: b.n, adjBps: bps(adj[i]) }; }),
    verdict, pass, controlsValid };
  writeJsonAtomic(DRY ? OUT.replace(/.json$/, ".dry.json") : OUT, out);
  console.log(`\n  VERDICT: ${verdict}`);
  if (DRY) { console.log("  --dry: harness check only, NOT sealed"); return; }
  if (!controlsValid) { console.log("  controls invalid — NOT sealed"); return; }
  const today = todayET();
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests[ID]) throw new Error("sealed concurrently — not overwriting");
  seals.tests[ID] = { sealedOn: today, unit: "meetings", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E = reg.preregistered.find((t) => t.id === ID);
  E.status = `READ ${today} — ${verdict}`; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: ID, verdict }) + "\n");
  console.log(`  sealed ${ID} (${today})`);
})().catch((e) => { console.error(`${ID} FAILED (nothing sealed):`, e.message); process.exit(1); });
