#!/usr/bin/env node
/**
 * R185 — LVN PULLBACK ON INDEX FUTURES (registered 2026-09-24 before this file existed; rule frozen in data/test-registry.json,
 * preregistered[id=R185]). R178's primary rule (k=3) run through R178's OWN code (backend/r178-lvn.js buildInstrument /
 * buildEvents / simulate / CHOOSERS — imported, not copied) on /NQ and /ES 5-minute bars; only the data and the cost model change.
 *
 * USAGE
 *   node backend/r185-lvn-futures.js --fetch   cache raw bars under data/training/r185 (Schwab market data, Alpaca calendar + SIP)
 *   node backend/r185-lvn-futures.js --read    THE one read; writes data/r185-lvn-futures.json; seals only if the controls pass
 *
 * DATA FOUND (inspected before the read; no rule output was computed before these notes were written):
 *  - Schwab now serves 5-minute /NQ and /ES only from 2026-03-04 23:10Z (a rolling ~40,000-bar retention). Requests for
 *    2025-12-17..2026-03-04 return empty, at 5-minute and at 10/15/30-minute alike. "Everything available" inside the registered
 *    window is therefore 2026-03-05..2026-09-23: 140 NYSE sessions, 78 RTH bars each, none missing (not the ~180 the bar assumed).
 *  - Schwab timestamps are bar STARTS (5-minute return correlation with Alpaca QQQ/SPY: 0.999 at lag 0, ~0 at +/-1).
 *  - Contract symbols (/NQZ26, /ESZ26) return the continuous series unchanged, so rolls are found from the continuous series itself:
 *    the futures/ETF close ratio at 15:55 steps ~0.75-1.0% on 2026-03-16, 06-15 and 09-14 (median daily change ~0.016%), and the
 *    switch sits at the Sunday 18:00 ET reopen before each (03-15, 06-14, 09-13). The script re-derives and reports them.
 *
 * IMPLEMENTATION NOTES
 *  F1  Rule: R178's primary exactly — imported code, k=3, ETF session mode (15:30 cancel, 15:55 flat, flat at session end).
 *      Instrument names "NQ"/"ES" seed R178's tie-break key. R178 notes N1-N18 apply unchanged.
 *  F2  Regular session = bar start in [open, close) of the NYSE calendar (Alpaca /v2/calendar): 09:30-16:00, 13:00 on early closes
 *      (none fall inside the served dates). Futures sessions on NYSE holidays are excluded (not NYSE sessions).
 *  F3  Rolls: a trade is excluded if its fill-to-exit interval contains a roll switch bar (literal "spanning"). Because orders never
 *      survive the session and positions are flat by 15:55, and every switch is at a Sunday reopen, this can exclude nothing; it is
 *      asserted and counted. The real exposure — swings, ATR and hourly EMA that straddle the overnight roll step on the RTH-only
 *      continuous series — is reported as a sensitivity (drop trades whose swing pivot A precedes the switch), not a gate.
 *  F4  Cost per contract round trip: $4.50; entry and target fills pay no spread (including gap fills at the open, which are limit
 *      fills at a better price); a stop exit or a time exit (15:55 flat, or session-end flat) pays 1 tick (NQ $5, ES $12.50).
 *      R$ = |limit - stop| x point value (NQ $20, ES $50). Net R = gross R - cost$/R$.
 *  F5  Statistic: per ET session (fill date), the mean net R of that session's NQ+ES trades; t over sessions with trades.
 *  F6  Controls as R178: random-level (entry bin uniform in bins 5..18 on the same qualifying swings, stop rule applied to the drawn
 *      bin, 200 seeded draws, compared on pooled net t); bootstrap (2000 draws of demeaned gross per-session R, median |t| < 2);
 *      peek (target-exit trades, pooled net t >= 1.675); leak (per-fill assertion + truncation rebuild at 8 seeded cuts).
 *  F7  Like-for-like: the same imported rule on QQQ and SPY over the same dates (first futures session .. 2026-09-23, identical
 *      warm-up), with R178's cost. Breakeven = the flat per-trade cost in R at which mean gross nets to zero, i.e. mean gross R per
 *      trade (session basis: session-mean gross R), shown beside the modelled mean cost.
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const R178 = require("./r178-lvn.js");
const D = (f) => path.join(__dirname, "data", f);
const CACHE = path.join(__dirname, "data", "training", "r185");
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

// ══ FETCH ══════════════════════════════════════════════════════════════════════════════════════════
const FUT_SYMS = ["/NQ", "/ES", "/NQZ26", "/ESZ26"];            // continuous front + the Dec-26 contract (roll detection only)
const tagOf = (s) => s.replace("/", "");
async function schwabBars(sym, startMs, endMs) {
  const S = require("./lib/schwab.js");
  const tok = await S.token();                                     // never printed
  const p = new URLSearchParams({ symbol: sym, periodType: "day", frequencyType: "minute", frequency: "5", startDate: String(startMs), endDate: String(endMs), needExtendedHoursData: "true" });
  for (let a = 0; a < 5; a++) {
    const r = await fetch("https://api.schwabapi.com/marketdata/v1/pricehistory?" + p, { headers: { Authorization: "Bearer " + tok, Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
    if (r.ok) { const j = await r.json(); return (j.candles || []).map((c) => [c.datetime, c.open, c.high, c.low, c.close, Number(c.volume) || 0]); }
    if (r.status === 429 || r.status >= 500) { await nap(5000 * (a + 1)); continue; }
    throw new Error(`schwab pricehistory ${sym} ${r.status}`);
  }
  throw new Error(`schwab pricehistory ${sym} retries exhausted`);
}
async function fetchAll() {
  fs.mkdirSync(CACHE, { recursive: true });
  // month chunks, 2025-12-17 .. 2026-09-23 ET (end = 2026-09-24 04:00Z = midnight ET)
  const chunks = [];
  let s = Date.parse("2025-12-17T05:00:00Z");
  const END = Date.parse("2026-09-24T04:00:00Z");
  while (s < END) { const d = new Date(s); const e = Math.min(END, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 5)); chunks.push([s, e]); s = e; }
  for (const sym of FUT_SYMS) {
    const f = path.join(CACHE, `fut-${tagOf(sym)}.json`);
    if (fs.existsSync(f)) continue;
    const m = new Map(), per = [];
    for (const [a, b] of chunks) { const rows = await schwabBars(sym, a, b); for (const r of rows) m.set(r[0], r); per.push({ from: new Date(a).toISOString(), to: new Date(b).toISOString(), bars: rows.length }); await nap(600); }
    const rows = [...m.values()].sort((x, y) => x[0] - y[0]);
    writeJsonAtomic(f, { source: "schwab pricehistory minute/5 needExtendedHoursData=true", sym, requested: ["2025-12-17", "2026-09-23"], fetchedAt: new Date().toISOString(), chunks: per, rows }, { pretty: 0 });
    console.log(`  ${sym}: ${rows.length} bars, ${rows.length ? new Date(rows[0][0]).toISOString() + " .. " + new Date(rows[rows.length - 1][0]).toISOString() : "none"}`);
  }
  const cf = path.join(CACHE, "calendar.json");
  if (!fs.existsSync(cf)) {
    require("dotenv").config({ path: path.join(__dirname, ".env") });
    const r = await fetch("https://paper-api.alpaca.markets/v2/calendar?start=2025-12-01&end=2026-09-30",
      { headers: { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, Accept: "application/json" } });
    if (!r.ok) throw new Error("alpaca calendar " + r.status);
    const days = (await r.json()).map((d) => ({ date: d.date, open: d.open, close: d.close }));
    writeJsonAtomic(cf, { source: "alpaca /v2/calendar (read-only GET)", fetchedAt: new Date().toISOString(), days });
    console.log(`  calendar: ${days.length} sessions, early closes ${days.filter((d) => d.close !== "16:00").map((d) => d.date).join(", ")}`);
  }
  const { fetchBars } = require("./lib/alpaca-bars.js");
  for (const sym of ["QQQ", "SPY"]) {
    const f = path.join(CACHE, `etf-${sym}.json`);
    if (fs.existsSync(f)) continue;
    const r = await fetchBars([sym], { start: "2025-12-01T00:00:00Z", end: "2026-09-24T03:59:59Z", timeframe: "5Min", feed: "sip", adjustment: "split", requireAll: true, quiet: true });
    const rows = r.bars[sym].map((b) => [Date.parse(b.t), b.o, b.h, b.l, b.c, b.v]);
    writeJsonAtomic(f, { source: "alpaca sip 5Min adjustment=split", sym, fetchedAt: new Date().toISOString(), rows }, { pretty: 0 });
    console.log(`  ${sym}: ${rows.length} raw bars`);
  }
}

// ══ READ ═══════════════════════════════════════════════════════════════════════════════════════════
const SCORE = ["2025-12-17", "2026-09-23"];
const SPEC = { NQ: { pv: 20, tick$: 5 }, ES: { pv: 50, tick$: 12.5 } };
const FEES = 4.5;
const LIKE = { NQ: "QQQ", ES: "SPY" };
const BAR5 = 300000;
function fnv(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const etOf = (ms) => { const s = FMT.format(new Date(ms)); return { date: s.slice(0, 10), hm: s.slice(12) }; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
function tOf(a) { const n = a.length; if (n < 3) return NaN; const m = mean(a); const s = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (n - 1)); return s > 0 ? m / (s / Math.sqrt(n)) : NaN; }
const r4 = (x) => (Number.isFinite(x) ? +x.toFixed(4) : null), r3 = (x) => (Number.isFinite(x) ? +x.toFixed(3) : null);
const pct = (arr, p) => { const s = [...arr].filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
function perSession(trades, key) { const m = new Map(); for (const t of trades) { const a = m.get(t.sess); if (a) a.push(t[key]); else m.set(t.sess, [t[key]]); } return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, a]) => mean(a)); }
function summarize(tr, sessionsInWindow) {
  const net = perSession(tr, "net"), gross = perSession(tr, "gross"), reasons = {};
  for (const x of tr) reasons[x.reason] = (reasons[x.reason] || 0) + 1;
  return { trades: tr.length, sessionsWithTrades: net.length, sessionsInWindow, tradesPerSession: r4(tr.length / sessionsInWindow), winRate: r4(tr.filter((x) => x.net > 0).length / tr.length),
    meanGrossR: r4(mean(tr.map((x) => x.gross))), meanNetR: r4(mean(tr.map((x) => x.net))), meanCostR: r4(mean(tr.map((x) => x.gross - x.net))),
    sessionMeanGrossR: r4(mean(gross)), sessionMeanNetR: r4(mean(net)), tGross: r3(tOf(gross)), tNet: r3(tOf(net)), exits: reasons };
}
function calendarMap() {
  const hm = (x) => x;
  return new Map(JSON.parse(fs.readFileSync(path.join(CACHE, "calendar.json"), "utf8")).days.map((d) => [d.date, [hm(d.open), hm(d.close)]]));
}
function rthRows(file, cal, fromDate) {
  return JSON.parse(fs.readFileSync(path.join(CACHE, file), "utf8")).rows.filter((r) => {
    const { date, hm } = etOf(r[0]); const oc = cal.get(date);
    return oc && date >= fromDate && date <= SCORE[1] && hm >= oc[0] && hm < oc[1];
  }).sort((a, b) => a[0] - b[0]);
}
// futures cost (registered): $4.50/contract round trip; limit entry/target no spread; stop or 15:55 flat pays 1 tick
const futNet = (t, sym) => { const R$ = t.risk * SPEC[sym].pv; return { ...t, net: t.gross - (FEES + (t.reason === "target" ? 0 : SPEC[sym].tick$)) / R$, riskUsd: R$, sym }; };

async function read() {
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
  const ENTRY = reg.preregistered.find((x) => x.id === "R185");
  if (!ENTRY) throw new Error("R185 not in registry");
  const BAR = ENTRY.bar.tRequired; if (BAR !== 1.675) throw new Error("registered bar changed: " + BAR);
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8"));
  if (seals.tests.R185) { console.error("R185 already sealed — refusing"); process.exit(2); }
  const cal = calendarMap();

  // ── data ── (futures: everything Schwab serves inside the registered window; ETFs: the SAME dates)
  const inst = {}, coverage = {};
  for (const s of ["NQ", "ES"]) {
    const rows = rthRows(`fut-${s}.json`, cal, SCORE[0]);
    inst[s] = R178.buildInstrument(s, rows, true);
    const ss = [...new Set(inst[s].sess)];
    coverage[s] = { rthBars: rows.length, sessions: ss.length, first: ss[0], last: ss[ss.length - 1] };
  }
  const firstFut = coverage.NQ.first;
  if (coverage.ES.first !== firstFut || coverage.NQ.sessions !== coverage.ES.sessions) throw new Error("NQ/ES coverage differs");
  for (const s of ["QQQ", "SPY"]) {
    const rows = rthRows(`etf-${s}.json`, cal, firstFut);
    inst[s] = R178.buildInstrument(s, rows, true);
    const ss = [...new Set(inst[s].sess)];
    coverage[s] = { rthBars: rows.length, sessions: ss.length, first: ss[0], last: ss[ss.length - 1] };
  }
  const sessionsInWindow = coverage.NQ.sessions;
  console.log("coverage", JSON.stringify(coverage));

  // ── rolls: continuous-front jumps, found as a step in the futures/ETF close ratio at 15:55, placed at the Sunday 18:00 reopen ──
  const rolls = [];
  for (const s of ["NQ", "ES"]) {
    const raw = JSON.parse(fs.readFileSync(path.join(CACHE, `fut-${s}.json`), "utf8")).rows;
    const etf = new Map(JSON.parse(fs.readFileSync(path.join(CACHE, `etf-${LIKE[s]}.json`), "utf8")).rows.map((r) => [r[0], r]));
    const daily = [];
    for (const r of raw) { const e = etOf(r[0]); if (e.hm !== "15:55") continue; const q = etf.get(r[0]); if (q) daily.push({ date: e.date, ratio: r[4] / q[4] }); }
    const ch = []; for (let i = 1; i < daily.length; i++) ch.push({ from: daily[i - 1].date, to: daily[i].date, pct: 100 * (daily[i].ratio / daily[i - 1].ratio - 1) });
    const med = pct(ch.map((x) => Math.abs(x.pct)), 0.5);
    for (const c of ch.filter((x) => Math.abs(x.pct) > 0.5)) {                     // 0.5% = ~30x the median daily ratio change
      // the switch bar: the first bar at/after a session reopen (gap > 30 min) between the two 15:55 closes with the largest open-vs-prior-close jump
      const t0 = raw.findIndex((r) => etOf(r[0]).date === c.from && etOf(r[0]).hm === "15:55"), t1 = raw.findIndex((r) => etOf(r[0]).date === c.to && etOf(r[0]).hm === "15:55");
      let best = null; for (let i = t0 + 1; i <= t1; i++) if (raw[i][0] - raw[i - 1][0] > 30 * 60000) { const j = Math.abs(raw[i][1] - raw[i - 1][4]); if (!best || j > best.j) best = { i, j }; }
      rolls.push({ sym: s, ratioStepPct: r3(c.pct), medianDailyRatioChangePct: r4(med), between: [c.from, c.to], switchBarET: FMT.format(new Date(raw[best.i][0])), switchMs: raw[best.i][0], reopenGapPts: r4(raw[best.i][1] - raw[best.i - 1][4]) });
    }
  }
  console.log("rolls", JSON.stringify(rolls));
  const rollMs = { NQ: rolls.filter((r) => r.sym === "NQ").map((r) => r.switchMs), ES: rolls.filter((r) => r.sym === "ES").map((r) => r.switchMs) };

  // ── events (R178 k=3) + leak ──
  const K = 3, EV = {};
  for (const s of Object.keys(inst)) EV[s] = R178.buildEvents(inst[s], K);
  let leakStatic = 0;
  for (const s of Object.keys(inst)) for (const e of EV[s].events) { leakStatic++; if (!(e.maxUsed <= e.i && e.iA < e.i && !(e.htfEnd > e.barEnd))) throw new Error(`LEAK event ${s} ${e.i}`); }
  const leakTrunc = { cuts: 0, eventsCompared: 0, mismatches: 0 };
  {
    const rng = mulberry32(185001);
    const cmp = (a, b) => a.i === b.i && a.iA === b.iA && a.dir === b.dir && a.A === b.A && a.B === b.B && a.lo === b.lo && a.w === b.w && a.atrB === b.atrB && a.htf === b.htf && a.lvnJ === b.lvnJ;
    for (const s of ["NQ", "ES"]) {
      const rows = rthRows(`fut-${s}.json`, cal, SCORE[0]);
      for (let q = 0; q < 4; q++) {
        const cut = Math.floor(rows.length * (0.2 + 0.7 * rng()));
        const Ec = R178.buildEvents(R178.buildInstrument(s, rows.slice(0, cut + 1), true), K), full = EV[s].events.filter((e) => e.i <= cut);
        leakTrunc.cuts++; if (Ec.events.length !== full.length) leakTrunc.mismatches++;
        for (let z = 0; z < Math.min(Ec.events.length, full.length); z++) { leakTrunc.eventsCompared++; if (!cmp(Ec.events[z], full[z])) leakTrunc.mismatches++; }
      }
    }
  }
  const leakOk = leakTrunc.mismatches === 0;

  // ── runs ──
  const spansRoll = (t, s) => rollMs[s].some((ms) => inst[s].t[t.fi] < ms && inst[s].t[t.xi] >= ms);            // fill .. exit contains the switch
  const swingSpansRoll = (t, s) => { const e = EV[s].events[EV[s].evAt[t.pi]]; return rollMs[s].some((ms) => inst[s].t[e.iA] < ms && inst[s].t[t.xi] >= ms); };
  const runFut = (chooserFor, opts = {}) => {
    const out = { NQ: [], ES: [], excludedRoll: 0 };
    for (const s of ["NQ", "ES"]) for (const t of R178.simulate(inst[s], EV[s], chooserFor(s), opts)) {
      if (!(t.sess >= SCORE[0] && t.sess <= SCORE[1])) continue;
      if (spansRoll(t, s)) { out.excludedRoll++; continue; }
      out[s].push(futNet(t, s));
    }
    out.pooled = [...out.NQ, ...out.ES];
    return out;
  };
  const lvn = runFut(() => R178.CHOOSERS.lvn(), { leakCheck: true });
  const main = { pooled: summarize(lvn.pooled, sessionsInWindow), NQ: summarize(lvn.NQ, sessionsInWindow), ES: summarize(lvn.ES, sessionsInWindow), excludedSpanningRoll: lvn.excludedRoll };
  console.log("LVN futures", JSON.stringify(main));

  // like-for-like: same rule on QQQ/SPY over the same dates, R178 cost (simulate's own net)
  const etfTr = { QQQ: R178.simulate(inst.QQQ, EV.QQQ, R178.CHOOSERS.lvn(), { leakCheck: true }), SPY: R178.simulate(inst.SPY, EV.SPY, R178.CHOOSERS.lvn(), { leakCheck: true }) };
  const like = { pooled: summarize([...etfTr.QQQ, ...etfTr.SPY], sessionsInWindow), QQQ: summarize(etfTr.QQQ, sessionsInWindow), SPY: summarize(etfTr.SPY, sessionsInWindow),
    costModel: "R178: $0.04/share round trip over the planned risk" };
  console.log("like-for-like ETFs", JSON.stringify(like));
  // breakeven: the flat per-trade cost (R) at which gross nets to zero = mean gross R per trade (per-trade basis) / session-mean gross (session basis)
  const be = (s) => ({ breakevenCostR_perTrade: s.meanGrossR, breakevenCostR_sessionBasis: s.sessionMeanGrossR, actualMeanCostR: s.meanCostR,
    costToBreakevenRatio: s.meanGrossR > 0 ? r3(s.meanCostR / s.meanGrossR) : null });
  const breakeven = { futuresPooled: be(main.pooled), NQ: be(main.NQ), ES: be(main.ES), etfPooled: be(like.pooled), QQQ: be(like.QQQ), SPY: be(like.SPY),
    note: "a negative breakeven means the gross itself is negative: no cost level nets it to zero" };
  const riskUsd = { NQ: { median: pct(lvn.NQ.map((t) => t.riskUsd), 0.5), p10: pct(lvn.NQ.map((t) => t.riskUsd), 0.1), p90: pct(lvn.NQ.map((t) => t.riskUsd), 0.9) },
    ES: { median: pct(lvn.ES.map((t) => t.riskUsd), 0.5), p10: pct(lvn.ES.map((t) => t.riskUsd), 0.1), p90: pct(lvn.ES.map((t) => t.riskUsd), 0.9) } };

  // sensitivities (report only)
  const swingClean = lvn.pooled.filter((t) => !swingSpansRoll(t, t.sym));
  const sensitivity = { excludeTradesWhoseSwingSpansRoll: { dropped: lvn.pooled.length - swingClean.length, ...pick(summarize(swingClean, sessionsInWindow)) },
    stopOnFillBar: pick(summarize(runFut(() => R178.CHOOSERS.lvn(), { stopOnFillBar: true }).pooled, sessionsInWindow)) };
  function pick(s) { return { trades: s.trades, meanGrossR: s.meanGrossR, meanNetR: s.meanNetR, tGross: s.tGross, tNet: s.tNet }; }
  const fib = runFut(() => R178.CHOOSERS.fib());
  const fib50 = { pooled: summarize(fib.pooled, sessionsInWindow), NQ: pick(summarize(fib.NQ, sessionsInWindow)), ES: pick(summarize(fib.ES, sessionsInWindow)) };

  // ── controls ──
  const g = perSession(lvn.pooled, "gross"), mu = mean(g), z = g.map((x) => x - mu), brng = mulberry32(fnv("R185-boot")), ts = [];
  for (let b = 0; b < 2000; b++) { const s = new Array(z.length); for (let q = 0; q < z.length; q++) s[q] = z[Math.floor(brng() * z.length)]; ts.push(Math.abs(tOf(s))); }
  const bootstrap = { sessions: g.length, draws: 2000, medianAbsT: r3(pct(ts, 0.5)), p95AbsT: r3(pct(ts, 0.95)), fracAbsTge2: r4(ts.filter((x) => x >= 2).length / ts.length), pass: pct(ts, 0.5) < 2 };
  const pk = (arr) => summarize(arr.filter((t) => t.reason === "target"), sessionsInWindow);
  const pkP = pk(lvn.pooled);
  const peek = { pooled: { trades: pkP.trades, sessions: pkP.sessionsWithTrades, meanNetR: pkP.meanNetR, tNet: pkP.tNet }, NQ: pick(pk(lvn.NQ)), ES: pick(pk(lvn.ES)), bar: BAR, pass: pkP.tNet >= BAR };
  const DRAWS = 200, rT = [], rM = [], rTG = [];
  for (let d = 0; d < DRAWS; d++) {
    const r = runFut((s) => R178.CHOOSERS.random(mulberry32(fnv(`R185-rand|${d}|${s}`))));
    const s = summarize(r.pooled, sessionsInWindow); rT.push(s.tNet); rM.push(s.sessionMeanNetR); rTG.push(s.tGross);
  }
  const below = (arr, x) => r4(arr.filter((y) => y < x).length / arr.length);
  const randomLevel = { draws: DRAWS, lvnTNet: main.pooled.tNet, randomTNetP50: r3(pct(rT, 0.5)), randomTNetP95: r3(pct(rT, 0.95)), lvnPercentileT: below(rT, main.pooled.tNet),
    lvnSessionMeanNetR: main.pooled.sessionMeanNetR, randomMeanP50: r4(pct(rM, 0.5)), randomMeanP95: r4(pct(rM, 0.95)), lvnPercentileMean: below(rM, main.pooled.sessionMeanNetR),
    lvnTGross: main.pooled.tGross, randomTGrossP50: r3(pct(rTG, 0.5)), randomTGrossP95: r3(pct(rTG, 0.95)), lvnPercentileTGross: below(rTG, main.pooled.tGross),
    beatsP95: main.pooled.tNet > pct(rT, 0.95) };
  console.log("controls", JSON.stringify({ leak: { leakStatic, leakTrunc, leakOk }, bootstrap, peek, randomLevel }));

  const controlsPass = leakOk && bootstrap.pass && peek.pass;
  const passes = main.pooled.tNet >= BAR && randomLevel.beatsP95;
  const verdict = (passes ? "PASS" : "DID NOT PASS") + ` — NQ+ES pooled net t ${main.pooled.tNet} vs bar ${BAR} (${main.pooled.sessionsWithTrades} sessions, ${main.pooled.trades} trades, mean net ${main.pooled.meanNetR}R/trade, gross ${main.pooled.meanGrossR}R); `
    + `random-level p95 t ${randomLevel.randomTNetP95}, LVN at pct ${randomLevel.lvnPercentileT}; data ${coverage.NQ.first}..${coverage.NQ.last} (Schwab 5-minute retention)`;
  const today = etOf(Date.now()).date;
  const out = {
    spec: "r185-lvn-futures-v1", test: "R185", asOf: new Date().toISOString(), script: "backend/r185-lvn-futures.js", ruleCode: "backend/r178-lvn.js (imported: buildInstrument, buildEvents, simulate, CHOOSERS), k=3", bar: BAR,
    window: { registered: SCORE, served: [coverage.NQ.first, coverage.NQ.last] }, coverage, rolls, costModel: { feesPerRoundTrip: FEES, spec: SPEC, rule: "entry/target limit fills pay no spread; stop or time exit pays 1 tick; R$ = |limit-stop| x point value" },
    futures: main, riskUsd, likeForLikeEtf: like, breakeven, fib50, sensitivity,
    controls: { leak: { staticEventsAsserted: leakStatic, truncation: leakTrunc, perOrderAssertion: "simulate(leakCheck) on every fill", pass: leakOk }, bootstrap, peek, randomLevel, pass: controlsPass },
    verdict, sealed: false,
  };
  if (!controlsPass) {
    out.notSealedBecause = `control failed: leak ${leakOk}, bootstrap ${bootstrap.pass}, peek ${peek.pass}`;
    writeJsonAtomic(D("r185-lvn-futures.json"), out);
    console.log("CONTROLS FAILED — written, NOT sealed:", out.notSealedBecause, "| verdict (unsealed):", verdict);
    return;
  }
  out.sealed = true;
  writeJsonAtomic(D("r185-lvn-futures.json"), out);
  const seals2 = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8"));
  if (seals2.tests.R185) throw new Error("R185 sealed concurrently — refusing");
  seals2.tests.R185 = { sealedOn: today, unit: `sessions (ET; NQ+ES pooled mean net R of the day's trades); ${main.pooled.sessionsWithTrades} with trades of ${sessionsInWindow}`, verdict };
  seals2.lastRun = new Date().toISOString();
  writeJsonAtomic(D("read-seals.json"), seals2);
  const reg2 = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E2 = reg2.preregistered.find((x) => x.id === "R185");
  E2.status = `READ ${today} — ${verdict}`; reg2.asOf = new Date().toISOString();
  writeJsonAtomic(D("test-registry.json"), reg2);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R185", verdict }) + "\n");
  console.log("SEALED:", verdict);
}

async function main() {
  const mode = process.argv[2];
  if (mode === "--fetch") { await fetchAll(); console.log("fetch complete"); return; }
  if (mode === "--read") return read();
  console.error("usage: --fetch | --read"); process.exit(1);
}
if (require.main === module) main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
