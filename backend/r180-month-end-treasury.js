#!/usr/bin/env node
/**
 * R180 — MONTH-END TREASURY DURATION DEMAND (Hartley & Schwarz 2019). Registered 2026-09-24 (family SCOUT-0924, best-of-5)
 * BEFORE this file ran; rule, statistic, bar and controls are frozen in data/test-registry.json (preregistered[id=R180]) and are
 * read from there at run time — nothing below re-states a parameter that could drift from the registry.
 *
 * RULE (registry text, summarised): IEF, Alpaca SIP daily, adjustment=all, 2019-07-01..2026-08-31. Long IEF from the close of the
 * 6th-to-last trading day through the close of the last trading day of each month (5 daily returns); flat otherwise. 2 bps per side.
 * STATISTIC: per month, window cumulative NET return minus 5 x IEF's mean daily return on the month's non-window days; t over months.
 * Also: the gross window return alone, and the window shifted one day earlier (closes -7..-2).
 * BAR: t >= ENTRY.bar.tRequired (2.352, nullBar({variants:5,n:86}).p95).
 * CONTROLS: placebo = the same 5-day window at a random offset inside each month (200 draws), true must beat its 95th percentile;
 * overlap = correlation of R180's monthly series with R164 (PENSION_REBAL, TLT leg) — REPORTED, not gated.
 * CROSS-CHECKS (reported, not gated): the same window on TLT, and on Schwab /ZN daily futures.
 *
 * IMPLEMENTATION NOTES (fixed before any outcome was computed):
 *  N1. Trading days = IEF's own daily bars inside 2019-07-01..2026-08-31, asserted equal to Alpaca's /v2/calendar sessions (a missing
 *      session throws; the read does not run on a holed series). Daily return r_d = close_d / close_{previous session} - 1.
 *  N2. Data are fetched for exactly the registered window. The first session (2019-07-01) therefore has no return; July 2019's
 *      non-window mean uses its remaining non-window days. (Most literal reading of "2019-07-01..2026-08-31".)
 *  N3. Window = the returns of the last 5 sessions of the month (entry at the close of session -6, exit at the close of session -1).
 *      Non-window days = every other session of the same calendar month that has a return. Net window = prod(1+r)-1 - 2 x 0.0002.
 *  N4. "t over months" = plain one-sample t, mean / (sd_{n-1} / sqrt n). No Newey-West (the months do not overlap).
 *  N5. Shifted window "(days -7..-2)" = closes -7..-2 = returns of sessions -6..-2; its non-window days are the month's other sessions
 *      (including the last). Reported only.
 *  N6. Placebo: for each month independently, a start offset k drawn uniformly from every position where 5 consecutive in-month
 *      returns fit (the true position included); the same net/drift-adjusted statistic; t over months; 200 draws, seed 180. "Beat its
 *      95th percentile" = true t strictly greater than the 95th percentile of the 200 placebo t's (sorted[ceil(0.95*200)-1]).
 *  N7. Overlap: (a) R164's persisted monthly NET series (data/hunt/PENSION_REBAL-discovery.json; the holdout file carries no monthly
 *      series) correlated on common calendar-month labels; (b) R164's TLT LEG rebuilt from its registered rule (SPY/TLT SIP adj=all,
 *      last 5 sessions of each month, drift sign from the previous month-end, next-day hold, summed by realisation month) — gross TLT
 *      leg = pos x TLT next-day return — correlated with R180 over every common month. The rebuild is validated by reproducing
 *      R164's persisted discovery GROSS spread on the overlapping months (max abs diff printed).
 *  N8. /ZN: Schwab pricehistory daily for the continuous front symbol (/ZN), sessions dated in America/Chicago. The continuous series
 *      is NOT back-adjusted, so contract rolls (late Feb/May/Aug/Nov, i.e. inside the month-end window) put price jumps into the
 *      window; it is reported for all months and excluding Feb/May/Aug/Nov. Same 2 bps per side for parity. Reported only.
 *  N9. Validity controls for sealing: data coverage (N1) and every control computed. The placebo is a verdict input, not a seal gate.
 *
 *   node backend/r180-month-end-treasury.js   -> data/r180-month-end-treasury.json (one read; refuses if R180 is already sealed)
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { fetchBars } = require("./lib/alpaca-bars.js");
const D = (f) => path.join(__dirname, "data", f);
const DRY = process.argv.includes("--dry");
const ID = "R180", OUT = D("r180-month-end-treasury.json");
{ const s = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (s.tests[ID]) { console.error(`${ID} already sealed — refusing`); process.exit(2); } }
const ENTRY0 = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")).preregistered.find((t) => t.id === ID);
if (!ENTRY0) { console.error(`${ID} not registered`); process.exit(2); }
const BAR = ENTRY0.bar.tRequired, START = "2019-07-01", END = "2026-08-31", COST_SIDE = 0.0002, WIN = 5, DRAWS = 200, SEED = 180;

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const tstat = (a) => mean(a) / (sd(a) / Math.sqrt(a.length));
const corr = (a, b) => { const ma = mean(a), mb = mean(b); let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return sab / Math.sqrt(saa * sbb); };
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r6 = (x) => (x == null || !Number.isFinite(x) ? x : +x.toFixed(6)), r3 = (x) => (x == null || !Number.isFinite(x) ? x : +x.toFixed(3));
const todayET = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

async function alpacaCalendar(start, end) {
  require("dotenv").config({ path: path.join(__dirname, ".env") });
  const h = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, Accept: "application/json" };
  const r = await fetch(`https://paper-api.alpaca.markets/v2/calendar?start=${start}&end=${end}`, { headers: h, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`alpaca calendar ${r.status}`);
  return (await r.json()).map((x) => x.date);
}

/** series: [{d, c}] sorted. Returns months [{ym, days:[{d, r}]}] with r = null for the very first session. */
function toMonths(series) {
  const byM = new Map();
  for (let i = 0; i < series.length; i++) {
    const ym = series[i].d.slice(0, 7), r = i === 0 ? null : series[i].c / series[i - 1].c - 1;
    if (!byM.has(ym)) byM.set(ym, []); byM.get(ym).push({ d: series[i].d, r });
  }
  return [...byM.entries()].map(([ym, days]) => ({ ym, days }));
}
/** stat for one month given the window as an index range [a, b) over days-with-returns (`rs`). */
function monthStat(rs, a, b, cost = 2 * COST_SIDE) {
  let g = 1; for (let i = a; i < b; i++) g *= 1 + rs[i]; g -= 1;
  const non = rs.filter((_, i) => i < a || i >= b);
  const drift = non.length ? WIN * mean(non) : 0;
  return { gross: g, net: g - cost, adj: g - cost - drift, nonDays: non.length };
}
/** the registered statistic over a month list; window = last 5 returns (shift 0) or shifted one day earlier (shift 1). */
function evaluate(months, shift = 0, cost = 2 * COST_SIDE) {
  const rows = [];
  for (const m of months) {
    const rs = m.days.filter((x) => x.r != null).map((x) => x.r);
    const lastIdx = m.days.length - 1;                    // the month's last session must carry a return for the window to exist
    if (m.days[lastIdx].r == null || rs.length < WIN + shift) continue;
    const b = rs.length - shift, a = b - WIN, s = monthStat(rs, a, b, cost);
    rows.push({ ym: m.ym, ...s });
  }
  const adj = rows.map((x) => x.adj), gross = rows.map((x) => x.gross);
  return { n: rows.length, meanAdjPct: r3(100 * mean(adj)), tAdj: r3(tstat(adj)), meanGrossPct: r3(100 * mean(gross)), tGross: r3(tstat(gross)), rows };
}
function placebo(months, draws, seed) {
  const rnd = mulberry(seed), ts = [];
  const prepared = months.map((m) => m.days.filter((x) => x.r != null).map((x) => x.r)).filter((rs) => rs.length >= WIN);
  for (let k = 0; k < draws; k++) {
    const adj = prepared.map((rs) => { const a = Math.floor(rnd() * (rs.length - WIN + 1)); return monthStat(rs, a, a + WIN).adj; });
    ts.push(tstat(adj));
  }
  const s = [...ts].sort((x, y) => x - y);
  return { draws, seed, p50: r3(s[Math.ceil(0.5 * draws) - 1]), p95: r3(s[Math.ceil(0.95 * draws) - 1]), max: r3(s[s.length - 1]), all: ts.map(r3) };
}

(async () => {
  console.log(`${ID} — month-end Treasury duration demand · bar t >= ${BAR}`);
  // ---- data -------------------------------------------------------------------------------------------------------------------
  const cal = await alpacaCalendar(START, END);
  const { bars } = await fetchBars(["IEF", "TLT"], { start: START, end: END + "T23:59:59Z", feed: "sip", adjustment: "all", timeframe: "1Day", requireAll: true, quiet: true });
  const ser = (s) => bars[s].map((b) => ({ d: b.t.slice(0, 10), c: b.c })).filter((x) => x.d >= START && x.d <= END);
  const IEF = ser("IEF"), TLT = ser("TLT");
  const cover = (x) => { const have = new Set(x.map((b) => b.d)); return { sessions: cal.length, bars: x.length, missing: cal.filter((d) => !have.has(d)), extra: x.filter((b) => !cal.includes(b.d)).map((b) => b.d) }; };
  const covIEF = cover(IEF), covTLT = cover(TLT);
  console.log(`  IEF ${covIEF.bars}/${covIEF.sessions} sessions (missing ${covIEF.missing.length}, extra ${covIEF.extra.length}) · TLT ${covTLT.bars}/${covTLT.sessions}`);
  if (covIEF.missing.length || covIEF.extra.length) throw new Error(`IEF coverage incomplete: missing ${covIEF.missing.slice(0, 5)} extra ${covIEF.extra.slice(0, 5)}`);

  // ---- primary ----------------------------------------------------------------------------------------------------------------
  const mIEF = toMonths(IEF);
  const prim = evaluate(mIEF, 0), shifted = evaluate(mIEF, 1);
  console.log(`  PRIMARY ${prim.n} months: net drift-adjusted ${prim.meanAdjPct}%/month, t ${prim.tAdj} (bar ${BAR}) · gross window ${prim.meanGrossPct}%/month t ${prim.tGross}`);
  console.log(`  shifted (-7..-2): adj ${shifted.meanAdjPct}%/month t ${shifted.tAdj} · gross ${shifted.meanGrossPct}% t ${shifted.tGross}`);

  // ---- placebo ----------------------------------------------------------------------------------------------------------------
  const pl = placebo(mIEF, DRAWS, SEED), placeboBeat = prim.tAdj > pl.p95;
  console.log(`  PLACEBO (random offset, ${DRAWS} draws): p50 ${pl.p50} p95 ${pl.p95} max ${pl.max} -> true t ${prim.tAdj} ${placeboBeat ? "BEATS" : "does NOT beat"} p95`);

  // ---- cross-check: TLT -------------------------------------------------------------------------------------------------------
  const tlt = evaluate(toMonths(TLT), 0), tltShift = evaluate(toMonths(TLT), 1);
  console.log(`  TLT cross-check: adj ${tlt.meanAdjPct}%/month t ${tlt.tAdj} · gross ${tlt.meanGrossPct}% t ${tlt.tGross} · shifted adj t ${tltShift.tAdj}`);

  // ---- cross-check: /ZN (Schwab) ----------------------------------------------------------------------------------------------
  let zn = { available: false };
  try {
    const schwab = require("./lib/schwab.js"), tok = await schwab.token();
    const u = `https://api.schwabapi.com/marketdata/v1/pricehistory?symbol=%2FZN&periodType=year&period=20&frequencyType=daily&frequency=1&startDate=${Date.parse(START + "T00:00:00Z")}&endDate=${Date.parse(END + "T23:59:59Z")}`;
    const r = await fetch(u, { headers: { Authorization: "Bearer " + tok }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`pricehistory ${r.status}`);
    const c = ((await r.json()).candles || []).map((x) => ({ d: new Date(x.datetime).toLocaleDateString("en-CA", { timeZone: "America/Chicago" }), c: x.close }))
      .filter((x) => x.d >= START && x.d <= END && x.c > 0).sort((a, b) => (a.d < b.d ? -1 : 1));
    const mZN = toMonths(c), all = evaluate(mZN, 0), noRoll = evaluate(mZN.filter((m) => !["02", "05", "08", "11"].includes(m.ym.slice(5))), 0);
    zn = { available: true, bars: c.length, first: c[0]?.d, last: c[c.length - 1]?.d, allMonths: { n: all.n, meanAdjPct: all.meanAdjPct, tAdj: all.tAdj, meanGrossPct: all.meanGrossPct, tGross: all.tGross },
      exRollMonths: { n: noRoll.n, meanAdjPct: noRoll.meanAdjPct, tAdj: noRoll.tAdj, meanGrossPct: noRoll.meanGrossPct, tGross: noRoll.tGross }, note: "continuous front /ZN, not back-adjusted; roll jumps fall in Feb/May/Aug/Nov windows" };
    console.log(`  /ZN cross-check (${c.length} bars): all ${all.n} months adj t ${all.tAdj} (${all.meanAdjPct}%) · ex-roll ${noRoll.n} months adj t ${noRoll.tAdj} (${noRoll.meanAdjPct}%)`);
  } catch (e) { zn = { available: false, reason: e.message }; console.log(`  /ZN cross-check skipped: ${e.message}`); }

  // ---- overlap with R164 ------------------------------------------------------------------------------------------------------
  const primByYm = new Map(prim.rows.map((x) => [x.ym, x.adj]));
  const overlap = { found: [], note: null };
  const discF = D("hunt/PENSION_REBAL-discovery.json"), holdF = D("hunt/PENSION_REBAL-holdout.json");
  let disc = null; try { disc = JSON.parse(fs.readFileSync(discF, "utf8")); overlap.found.push("PENSION_REBAL-discovery.json (monthly net/gross, 2017-01..2021-12)"); } catch {}
  try { const h = JSON.parse(fs.readFileSync(holdF, "utf8")); overlap.found.push(`PENSION_REBAL-holdout.json (summary only, monthly series ${Array.isArray(h.monthly) ? "present" : "ABSENT"})`); } catch {}
  if (disc?.monthly) {
    const common = disc.monthly.filter((m) => primByYm.has(m.ym));
    overlap.persistedNet = { months: common.length, first: common[0]?.ym, last: common[common.length - 1]?.ym, corr: r3(corr(common.map((m) => primByYm.get(m.ym)), common.map((m) => m.net))) };
  }
  // rebuild R164's TLT leg from its registered rule (N7b)
  const { bars: b2 } = await fetchBars(["SPY", "TLT"], { start: "2019-04-01", end: "2026-09-10T23:59:59Z", feed: "sip", adjustment: "all", timeframe: "1Day", requireAll: true, quiet: true });
  const sp = new Map(b2.SPY.map((b) => [b.t.slice(0, 10), b.c])), tl = new Map(b2.TLT.map((b) => [b.t.slice(0, 10), b.c]));
  const dates = [...sp.keys()].filter((d) => tl.has(d)).sort();
  const monthsOf = new Map(); for (const d of dates) { const ym = d.slice(0, 7); if (!monthsOf.has(ym)) monthsOf.set(ym, []); monthsOf.get(ym).push(d); }
  const yms = [...monthsOf.keys()], legByYm = new Map(), spreadByYm = new Map();
  for (let mi = 1; mi < yms.length - 1; mi++) {            // month complete only if a later month exists; needs a previous month-end
    const ds = monthsOf.get(yms[mi]), pmeArr = monthsOf.get(yms[mi - 1]), pme = pmeArr[pmeArr.length - 1];
    for (const t of ds.slice(-5)) {
      const drift = (sp.get(t) / sp.get(pme) - 1) - (tl.get(t) / tl.get(pme) - 1), pos = drift > 0 ? 1 : drift < 0 ? -1 : 0;
      const u = dates[dates.indexOf(t) + 1]; if (!u || pos === 0) continue;
      const rT = tl.get(u) / tl.get(t) - 1, rS = sp.get(u) / sp.get(t) - 1, ym = u.slice(0, 7);
      legByYm.set(ym, (legByYm.get(ym) || 0) + pos * rT); spreadByYm.set(ym, (spreadByYm.get(ym) || 0) + pos * (rT - rS));
    }
  }
  let maxDiff = null; if (disc?.monthly) { const ds = disc.monthly.filter((m) => spreadByYm.has(m.ym) && m.ym >= "2019-06"); maxDiff = ds.length ? Math.max(...ds.map((m) => Math.abs(m.gross - spreadByYm.get(m.ym)))) : null; overlap.rebuildValidation = { monthsCompared: ds.length, maxAbsDiffVsPersistedGross: r6(maxDiff) }; }
  const commonLeg = prim.rows.filter((x) => legByYm.has(x.ym));
  overlap.rebuiltTltLeg = { months: commonLeg.length, first: commonLeg[0]?.ym, last: commonLeg[commonLeg.length - 1]?.ym, corr: r3(corr(commonLeg.map((x) => x.adj), commonLeg.map((x) => legByYm.get(x.ym)))),
    corrWithRebuiltSpread: r3(corr(commonLeg.map((x) => x.adj), commonLeg.map((x) => spreadByYm.get(x.ym) ?? 0))) };
  console.log(`  OVERLAP R164: persisted net corr ${overlap.persistedNet?.corr} over ${overlap.persistedNet?.months} months · rebuilt TLT-leg corr ${overlap.rebuiltTltLeg.corr} over ${overlap.rebuiltTltLeg.months} months (rebuild max|diff| vs persisted gross ${r6(maxDiff)})`);

  // ---- verdict ------------------------------------------------------------------------------------------------------------
  const primaryClears = prim.tAdj >= BAR, pass = primaryClears && placeboBeat;
  const verdict = `${pass ? "PASS" : "DID NOT PASS"} — IEF month-end window net drift-adjusted ${prim.meanAdjPct}%/month, t ${prim.tAdj} vs bar ${BAR} over ${prim.n} months; placebo p95 ${pl.p95} (${placeboBeat ? "beaten" : "not beaten"}); gross window ${prim.meanGrossPct}% t ${prim.tGross}; TLT adj t ${tlt.tAdj}`;
  const controlsValid = covIEF.missing.length === 0 && Number.isFinite(pl.p95) && overlap.rebuiltTltLeg.months > 0;
  const out = { spec: "r180-month-end-treasury-v1", test: ID, asOf: new Date().toISOString(), window: [START, END], bar: BAR, costPerSide: COST_SIDE,
    coverage: { IEF: { sessions: covIEF.sessions, bars: covIEF.bars, missing: covIEF.missing }, TLT: { sessions: covTLT.sessions, bars: covTLT.bars, missing: covTLT.missing } },
    primary: { n: prim.n, meanAdjPctPerMonth: prim.meanAdjPct, tAdj: prim.tAdj, grossWindowPctPerMonth: prim.meanGrossPct, tGross: prim.tGross, clearsBar: primaryClears },
    shiftedMinus7toMinus2: { n: shifted.n, meanAdjPct: shifted.meanAdjPct, tAdj: shifted.tAdj, meanGrossPct: shifted.meanGrossPct, tGross: shifted.tGross },
    controls: { placebo: { ...pl, trueT: prim.tAdj, beaten: placeboBeat }, overlapR164: overlap },
    crossChecks: { TLT: { n: tlt.n, meanAdjPct: tlt.meanAdjPct, tAdj: tlt.tAdj, meanGrossPct: tlt.meanGrossPct, tGross: tlt.tGross, shiftedAdjT: tltShift.tAdj }, ZN: zn },
    monthly: prim.rows.map((x) => ({ ym: x.ym, gross: r6(x.gross), net: r6(x.net), adj: r6(x.adj), nonDays: x.nonDays })),
    verdict, pass, controlsValid };
  writeJsonAtomic(DRY ? OUT.replace(/.json$/, ".dry.json") : OUT, out);
  console.log(`\n  VERDICT: ${verdict}`);
  if (DRY) { console.log("  --dry: harness check only, NOT sealed"); return; }
  if (!controlsValid) { console.log("  controls invalid — NOT sealed"); return; }
  const today = todayET();
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests[ID]) throw new Error("sealed concurrently — not overwriting");
  seals.tests[ID] = { sealedOn: today, unit: "months", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E = reg.preregistered.find((t) => t.id === ID);
  E.status = `READ ${today} — ${verdict}`; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: ID, verdict }) + "\n");
  console.log(`  sealed ${ID} (${today})`);
})().catch((e) => { console.error(`${ID} FAILED (nothing sealed):`, e.message); process.exit(1); });
