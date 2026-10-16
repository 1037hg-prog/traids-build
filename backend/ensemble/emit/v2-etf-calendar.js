#!/usr/bin/env node
"use strict";
/**
 * Library emitter (v2, 2026-09-25) — the daily-ETF calendar/flow tests sealed after R201:
 *   R203 BNDX month-end · R204 TIP month-end · R205 UUP quarter-end squeeze · R206 IEF mid-month coupon window   (backend/r203-r206-flows5.js)
 *   R212 UUP month-end signed by SPY-EFA (VOID: scoring artifact) · R213 FOMC-cycle even weeks · R214 GLD overnight (VOID: gold beta)
 *   R215 pre-holiday SPY                                                                                           (backend/r212-r215-mine6.js)
 *   R225 SPY quad witching · R226 QQQ quad witching · R227 Russell recon run-up (VOID: June not distinctive) · R228 recon reversal
 *                                                                                                                  (backend/r225-r228-mine8.js)
 * READ-ONLY. None of those scripts is executed: each rewrites read-seals.json and test-registry.json from a copy read at start-up
 * (a concurrent-write hazard), so their window logic is re-implemented here line-for-line and checked by recomputing each sealed
 * statistic from the same rows (reproduction). Same data calls (Alpaca SIP daily, adjustment=all; Yahoo adjClose via :3002 for
 * R227/R228), same costs.
 *
 * LIBRARY SERIES = RAW TRADED NET P&L (the 2026-09-24 rule: never subtract a drift that shares days with a data-dependent signal).
 * Every sealed statistic above subtracts some baseline or hedge; the library holds the position's own marked-to-market net return:
 *   R203/R204  long BNDX/TIP over the month's last 5 sessions (the sealed stat further hedges beta x IEF; the hedge is NOT in the series)
 *   R205       long UUP last 5 sessions of the quarter, short UUP first 5 of the next; 4 bps per leg (the sealed formula nets only 4 bps
 *              across both legs because it negates a cost-inclusive leg — disclosed, the library charges 4 bps per leg)
 *   R206       long IEF the 3 sessions ending on the first session on/after the 15th
 *   R212       sign x UUP from the close of session L-4 to the open of L-1 (marked daily; the open leg booked on L-1)
 *   R213       long SPY on even FOMC-cycle weeks (the script's own evenDaily rows, cost 2 bps at each run's edges)
 *   R214       long GLD close -> next open, 2 bps per night
 *   R215       long SPY on the session before a market holiday, 4 bps
 *   R225/R226  long SPY/QQQ on the quad-witching 3rd Friday close-to-close, 4 bps (the LOSING side is the sealed finding)
 *   R227       long IWM / short SPY from eff-5 to eff (last Friday of June), 8 bps, booked on the exit session (no daily mark in the script)
 *   R228       long SPY / short IWM from eff to eff+5, 8 bps, booked on exit
 * Costs are charged on the exit day. Multi-day holds are marked close-to-close.
 *   node backend/ensemble/emit/v2-etf-calendar.js
 */
const fs = require("fs"), path = require("path");
const { writeEntry } = require("../lib-entry.js");
const { fetchBars } = require("../../lib/alpaca-bars.js");
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length, sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); }, tOf = (a) => mean(a) / (sd(a) / Math.sqrt(a.length));
const comp = (a) => a.reduce((p, x) => p * (1 + x), 1) - 1;
const OUT = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "data", f), "utf8"));
const F5 = OUT("r203-r206-flows5.json").results, M6 = OUT("r212-r215-mine6.json").results, M8 = OUT("r225-r228-mine8.json").results;
const r3 = (x) => +x.toFixed(3);
function book(series) { const m = new Map(); for (const { d, r } of series) m.set(d, (m.get(d) || 0) + r); return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, r]) => ({ d, r })).filter((x) => x.r !== 0); }
function rep(statistic, sealed, emitted, tol = 0.02) { return { statistic, sealed, emitted: r3(emitted), tolerance: tol, match: Math.abs(emitted - sealed) <= tol }; }

(async () => {
  // ================= flows5: R203-R206 (data call identical to r203-r206-flows5.js) =================
  { const { bars } = await fetchBars(["IEF", "BNDX", "TIP", "UUP", "TLT"], { start: "2015-12-01", end: "2026-09-01", feed: "sip", adjustment: "all", quiet: true });
    const rets = {}; for (const s of Object.keys(bars)) { rets[s] = []; const b = bars[s]; for (let i = 1; i < b.length; i++) rets[s].push({ d: b[i].t.slice(0, 10), r: b[i].c / b[i - 1].c - 1 }); }
    const byPeriod = (s, key) => { const o = {}; for (const x of rets[s]) { const k = key(x.d); if (k) (o[k] = o[k] || []).push(x); } return o; };
    const month = (d) => (d >= "2016-01" && d.slice(0, 7) <= "2026-08" ? d.slice(0, 7) : null), COST = 0.0004;
    const meExcess = (arr, start, len = 5) => comp(arr.slice(start, start + len).map((x) => x.r)) - len * mean([...arr.slice(0, start), ...arr.slice(start + len)].map((x) => x.r)) - COST;
    for (const [id, sym] of [["R203", "BNDX"], ["R204", "TIP"]]) {
      const A = byPeriod(sym, month), I = byPeriod("IEF", month), months = Object.keys(A).filter((m) => I[m] && A[m].length >= 15 && I[m].length >= 15).sort();
      const a = months.map((m) => meExcess(A[m], A[m].length - 5)), b = months.map((m) => meExcess(I[m], I[m].length - 5));
      const ind = []; for (let k = 0; k < months.length; k++) { const lo = Math.max(0, k - 36); let xs = b.slice(lo, k), ys = a.slice(lo, k); if (xs.length < 12) { xs = b.slice(0, Math.max(12, k + 1)); ys = a.slice(0, Math.max(12, k + 1)); } const mx = mean(xs), my = mean(ys); let c = 0, v = 0; for (let i = 0; i < xs.length; i++) { c += (xs[i] - mx) * (ys[i] - my); v += (xs[i] - mx) ** 2; } ind.push(a[k] - (c / v) * b[k]); }
      const series = []; for (const m of months) { const w = A[m].slice(-5); w.forEach((x, j) => series.push({ d: x.d, r: x.r - (j === 4 ? COST : 0) })); }
      const rawTraded = months.map((m) => comp(A[m].slice(-5).map((x) => x.r)) - COST);
      writeEntry({ id, name: `${sym} month-end, long the last 5 sessions (raw traded; the IEF hedge of the sealed statistic is not applied)`, registryId: id, script: "backend/r203-r206-flows5.js", emitter: "backend/ensemble/emit/v2-etf-calendar.js",
        unit: "per-event", net: true, costModel: "4 bps round trip per window, as sealed", window: [months[0] + "-01", "2026-08-31"].map((d, i) => (i ? d : rets[sym].find((x) => x.d >= d).d)), calendar: "us-equity", series: book(series),
        reproduction: { ...rep("sealed primary t: IEF-beta-hedged (trailing 36m) month-end excess", F5[id].independentT, tOf(ind)), alsoRawExcessT: { sealed: F5[id].rawT, emitted: r3(tOf(a)) } },
        construction: "Long from the close of the month's 6th-to-last session to its last close, marked daily; 4 bps booked on the exit session.",
        notes: `Raw traded window t ${r3(tOf(rawTraded))} (${months.length} months). Same duration-demand bet as R180 (sealed corr with IEF ${F5[id].corrWithIEF}); counts inside the R180 cluster.` });
    }
    { const Q = byPeriod("UUP", (d) => (d >= "2016-01" && d.slice(0, 7) <= "2026-06" ? `${d.slice(0, 4)}Q${Math.floor((+d.slice(5, 7) - 1) / 3) + 1}` : null)), qs = Object.keys(Q).sort();
      const legEx = (arr, start) => comp(arr.slice(start, start + 5).map((x) => x.r)) - 5 * mean([...arr.slice(0, start), ...arr.slice(start + 5)].map((x) => x.r)) - COST;
      const sealedRows = [], series = [], raw = [];
      for (let k = 0; k + 1 < qs.length; k++) { const q = Q[qs[k]], n = Q[qs[k + 1]]; sealedRows.push(legEx(q, q.length - 5) + -legEx(n, 0) - COST);
        q.slice(-5).forEach((x, j) => series.push({ d: x.d, r: x.r - (j === 4 ? COST : 0) })); n.slice(0, 5).forEach((x, j) => series.push({ d: x.d, r: -x.r - (j === 4 ? COST : 0) }));
        raw.push(comp(q.slice(-5).map((x) => x.r)) - comp(n.slice(0, 5).map((x) => x.r)) - 2 * COST); }
      writeEntry({ id: "R205", name: "UUP quarter-end: long the last 5 sessions, short the first 5 of the next quarter (raw traded)", registryId: "R205", script: "backend/r203-r206-flows5.js", emitter: "backend/ensemble/emit/v2-etf-calendar.js",
        unit: "per-event", net: true, costModel: "4 bps round trip per leg (library); the sealed formula nets 4 bps across both legs", window: [series[0].d, "2026-07-31"], calendar: "us-equity", series: book(series),
        reproduction: rep("sealed primary t (drift-adjusted legs)", F5.R205.t, tOf(sealedRows)),
        construction: "Leg A long UUP close L-6 -> last close of the quarter; Leg B short UUP first 5 sessions of the next quarter (short marked as -daily return); each leg pays 4 bps on its exit day.",
        notes: `Raw traded per quarter t ${r3(tOf(raw))} over ${raw.length} quarters. Sealed formula quirk: -legEx(next) adds back the leg's cost, so the sealed rows carry 4 bps in total, not 8.` }); }
    { const M = byPeriod("IEF", month), ms = Object.keys(M).filter((m) => M[m].length >= 15).sort(); const sealedRows = [], series = [], raw = [];
      for (const m of ms) { const a = M[m]; const e = a.findIndex((x) => +x.d.slice(8, 10) >= 15); if (e < 2) continue; const s0 = e - 2, meIdx = a.length - 5;
        const base = a.filter((x, i) => (i < s0 || i >= s0 + 3) && i < meIdx).map((x) => x.r); sealedRows.push(comp(a.slice(s0, s0 + 3).map((x) => x.r)) - 3 * mean(base) - COST);
        a.slice(s0, s0 + 3).forEach((x, j) => series.push({ d: x.d, r: x.r - (j === 2 ? COST : 0) })); raw.push(comp(a.slice(s0, s0 + 3).map((x) => x.r)) - COST); }
      writeEntry({ id: "R206", name: "IEF mid-month coupon window (3 sessions ending the first session on/after the 15th), raw traded", registryId: "R206", script: "backend/r203-r206-flows5.js", emitter: "backend/ensemble/emit/v2-etf-calendar.js",
        unit: "per-event", net: true, costModel: "4 bps round trip, as sealed", window: [series[0].d, "2026-08-31"], calendar: "us-equity", series: book(series),
        reproduction: rep("sealed primary t (window minus 3 x non-window non-month-end mean)", F5.R206.t, tOf(sealedRows)),
        construction: "Long IEF over the 3 sessions ending on the first session dated >= the 15th, marked daily; 4 bps on the exit day.", notes: `Raw traded t ${r3(tOf(raw))} over ${raw.length} months.` }); }
  }

  // ================= mine6: R212-R215 (data call identical to r212-r215-mine6.js) =================
  { const START = "2016-01-01", END = "2026-08-31", inRange = (d) => d >= START && d <= END;
    const { bars } = await fetchBars(["SPY", "EFA", "UUP", "GLD", "SLV"], { start: "2015-11-01", end: END, feed: "sip", adjustment: "all", quiet: true });
    const B = {}; for (const s of Object.keys(bars)) B[s] = bars[s].map((b) => ({ d: b.t.slice(0, 10), o: b.o, c: b.c }));
    // R212
    { const idx = (s) => { const m = new Map(); B[s].forEach((b, i) => m.set(b.d, i)); return m; }; const iSPY = idx("SPY"), iEFA = idx("EFA"), U = B.UUP, months = {};
      U.forEach((b, i) => { (months[b.d.slice(0, 7)] = months[b.d.slice(0, 7)] || []).push(i); }); const ms = Object.keys(months).sort().filter((m) => m >= "2016-01" && m <= "2026-08");
      const mtd = (sym, im, prevLastDate, d) => { const a = B[sym][im.get(prevLastDate)], b = B[sym][im.get(d)]; return a && b ? b.c / a.c - 1 : null; };
      const sealedRows = [], series = [], raw = [];
      for (const m of ms) { const ix = months[m], prev = months[ms[ms.indexOf(m) - 1]] || months[Object.keys(months).sort().filter((x) => x < m).pop()]; if (!prev || ix.length < 15) continue;
        const k = ix.length - 4, e = ix[k], x = ix[k + 3]; if (x === undefined) continue; const prevLast = U[prev[prev.length - 1]].d, ed = U[e].d; const s1 = mtd("SPY", iSPY, prevLast, ed), s2 = mtd("EFA", iEFA, prevLast, ed); if (s1 == null || s2 == null) continue;
        const pos = s1 - s2 > 0 ? -1 : 1, win = U[x].o / U[e].c - 1, other = ix.filter((j, q) => q !== 0 && (q < k + 1 || q > k + 3)).map((j) => U[j].c / U[j - 1].c - 1);
        sealedRows.push(pos * (win - 3 * mean(other)) - 0.0004); raw.push(pos * win - 0.0004);
        series.push({ d: U[e + 1].d, r: pos * (U[e + 1].c / U[e].c - 1) }, { d: U[e + 2].d, r: pos * (U[e + 2].c / U[e + 1].c - 1) }, { d: U[x].d, r: pos * (U[x].o / U[e + 2].c - 1) - 0.0004 }); }
      writeEntry({ id: "R212", name: "VOID-FOR-COMBINATION — UUP month-end signed by SPY-minus-EFA MTD, raw traded", registryId: "R212", script: "backend/r212-r215-mine6.js", emitter: "backend/ensemble/emit/v2-etf-calendar.js",
        unit: "per-event", net: true, costModel: "4 bps round trip, as sealed", window: [series[0].d, END], calendar: "us-equity", series: book(series),
        reproduction: rep("sealed primary t (signed window minus 3 x other-day drift — the artifact form)", M6.R212.t, tOf(sealedRows)),
        construction: "Position sign fixed at the close of session L-4 from SPY-EFA month-to-date; held to the open of session L-1; marked close-to-close for two sessions then close-to-open; 4 bps on the exit day.",
        notes: `VOID per operator 2026-09-25 (signed position x drift subtraction sharing signal days). RAW traded t ${r3(tOf(raw))} over ${raw.length} months — the honest number; excluded from every combination.` }); }
    // R213
    { const src = fs.readFileSync(path.join(__dirname, "..", "..", "r196-pre-fomc.js"), "utf8"), blk = src.slice(src.indexOf("const FOMC = ["), src.indexOf("];", src.indexOf("const FOMC = [")));
      const FOMC = [...blk.matchAll(/"(\d{4}-\d{2}-\d{2})"/g)].map((m) => m[1]).filter(inRange);
      const S = B.SPY.filter((b) => b.d >= "2015-12-01"), di = new Map(S.map((b, i) => [b.d, i])), f0 = FOMC.map((d) => di.get(d)).filter((i) => i !== undefined);
      const out = [], evenDaily = [];
      for (let c = 0; c + 1 < f0.length; c++) { const a = f0[c], z = f0[c + 1]; const ev = [], od = [], days = [];
        for (let i = a - 1; i <= z - 2; i++) { if (i < 1) continue; const k = i - a, w = Math.floor((k + 1) / 5), even = w % 2 === 0; days.push({ i, even, r: S[i].c / S[i - 1].c - 1 }); }
        days.forEach((x, j) => { if (!x.even) { od.push(x.r); return; } let r = x.r; if (j === 0 || !days[j - 1].even) r -= 0.0002; if (j === days.length - 1 || !days[j + 1].even) r -= 0.0002; ev.push(r); evenDaily.push({ d: S[x.i].d, r }); });
        if (ev.length && od.length) out.push(5 * (mean(ev) - mean(od))); }
      const ser = book(evenDaily);
      writeEntry({ id: "R213", name: "SPY on even FOMC-cycle weeks (weeks 0,2,4,6), raw traded", registryId: "R213", script: "backend/r212-r215-mine6.js", emitter: "backend/ensemble/emit/v2-etf-calendar.js",
        unit: "daily", net: true, costModel: "2 bps at the first and last day of every contiguous even-week run, as sealed", window: [evenDaily[0].d, evenDaily[evenDaily.length - 1].d], calendar: "us-equity", series: ser,
        reproduction: rep("sealed primary t (5 x (even-day mean - odd-day mean) per cycle)", M6.R213.t, tOf(out)),
        construction: "The script's own evenDaily rows: SPY close-to-close on every even-week session, cost at run edges; odd weeks in cash.", notes: `${ser.length} long days; mostly SPY beta (buy-and-hold Sharpe ${M6.R213.buyHoldSharpe} vs even-only ${M6.R213.evenOnlySharpe}).` }); }
    // R214
    { const b = B.GLD, series = [], mon = {}; for (let i = 1; i < b.length; i++) if (inRange(b[i].d)) { const on = b[i].o / b[i - 1].c - 1 - 0.0002; series.push({ d: b[i].d, r: on }); mon[b[i].d.slice(0, 7)] = (mon[b[i].d.slice(0, 7)] || 0) + on; }
      writeEntry({ id: "R214", name: "VOID-FOR-COMBINATION — GLD overnight (close -> next open), raw traded", registryId: "R214", script: "backend/r212-r215-mine6.js", emitter: "backend/ensemble/emit/v2-etf-calendar.js",
        unit: "daily", net: true, costModel: "2 bps per night, as sealed", window: [series[0].d, series[series.length - 1].d], calendar: "us-equity", series: book(series),
        reproduction: rep("sealed primary t (monthly sums of net overnight returns)", M6.R214.t, tOf(Object.values(mon))),
        construction: "Each session: long GLD from the prior close to this open, booked on this session (the overnight ends at its open).", notes: "VOID per operator 2026-09-25: the result is gold beta (audit alpha on GLD t 0.84, beta 0.53). Excluded from every combination." }); }
    // R215
    { const S = B.SPY, set = new Set(S.map((b) => b.d)), addDay = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
      const nextWeekday = (d) => { let x = addDay(d, 1); while ([0, 6].includes(new Date(x + "T12:00:00Z").getUTCDay())) x = addDay(x, 1); return x; };
      const yr = {}; for (let i = 1; i < S.length; i++) if (inRange(S[i].d)) (yr[S[i].d.slice(0, 4)] = yr[S[i].d.slice(0, 4)] || []).push(S[i].c / S[i - 1].c - 1); const ym = Object.fromEntries(Object.entries(yr).map(([y, a]) => [y, mean(a)]));
      const ev = [], series = []; for (let i = 1; i + 1 < S.length; i++) { const d = S[i].d; if (!inRange(d)) continue; const nw = nextWeekday(d); if (!set.has(nw) && nw < S[S.length - 1].d) { const r = S[i].c / S[i - 1].c - 1 - 0.0004; ev.push(r - ym[d.slice(0, 4)]); series.push({ d, r }); } }
      writeEntry({ id: "R215", name: "SPY on the session before a market holiday, raw traded", registryId: "R215", script: "backend/r212-r215-mine6.js", emitter: "backend/ensemble/emit/v2-etf-calendar.js",
        unit: "per-event", net: true, costModel: "4 bps round trip, as sealed", window: ["2016-01-04", END], calendar: "us-equity", series: book(series),
        reproduction: rep("sealed primary t (day return minus 4 bps minus the same-year mean day)", M6.R215.t, tOf(ev)),
        construction: "Long SPY close-to-close on each pre-holiday session.", notes: `Raw traded t ${r3(tOf(series.map((x) => x.r)))} over ${series.length} events.` }); }
  }

  // ================= mine8: R225-R228 (data calls identical to r225-r228-mine8.js) =================
  { const START = "2016-01-01", END = "2026-08-31", inRange = (d) => d >= START && d <= END;
    const { bars } = await fetchBars(["SPY", "QQQ", "IWM", "IEF"], { start: "2015-11-01", end: END, feed: "sip", adjustment: "all", quiet: true });
    const B = {}; for (const s of Object.keys(bars)) B[s] = bars[s].map((b) => ({ d: b.t.slice(0, 10), c: b.c }));
    function thirdFriday(y, m) { const fr = []; for (let d = 1; d <= 31; d++) { const dt = new Date(Date.UTC(y, m - 1, d)); if (dt.getUTCMonth() !== m - 1) break; if (dt.getUTCDay() === 5) fr.push(dt.toISOString().slice(0, 10)); } return fr[2]; }
    for (const [id, sym] of [["R225", "SPY"], ["R226", "QQQ"]]) {
      const S = B[sym].filter((b) => inRange(b.d)), byYm = {}; S.forEach((b) => (byYm[b.d.slice(0, 7)] = byYm[b.d.slice(0, 7)] || []).push(b.d)); const rows = [];
      for (const ym of Object.keys(byYm).sort()) { const [y, m] = ym.split("-").map(Number); const f3 = thirdFriday(y, m); if (!f3) continue; let idx = -1; for (let i = 0; i < B[sym].length; i++) if (B[sym][i].d >= f3) { idx = i; break; } if (idx <= 0) continue;
        rows.push({ d: B[sym][idx].d, isQuad: [3, 6, 9, 12].includes(m), ret: B[sym][idx].c / B[sym][idx - 1].c - 1 - 0.0004 }); }
      const quad = rows.filter((r) => r.isQuad), base = mean(rows.filter((r) => !r.isQuad).map((r) => r.ret));
      writeEntry({ id, name: `${sym} long on the quad-witching 3rd Friday, raw traded (the sealed finding is the NEGATIVE side)`, registryId: id, script: "backend/r225-r228-mine8.js", emitter: "backend/ensemble/emit/v2-etf-calendar.js",
        unit: "per-event", net: true, costModel: "4 bps round trip, as sealed", window: ["2016-01-04", END], calendar: "us-equity", series: book(quad.map((r) => ({ d: r.d, r: r.ret }))),
        reproduction: rep("sealed primary t (quad-Friday net minus the non-quad 3rd-Friday mean)", id === "R225" ? -2.959 : -1.217, tOf(quad.map((r) => r.ret - base))),
        construction: "Long the ETF close-to-close on the first session on/after the 3rd Friday of Mar/Jun/Sep/Dec.", notes: `Raw traded t ${r3(tOf(quad.map((r) => r.ret)))} over ${quad.length} events. Sealed t read from the seal verdict text (the persisted JSON drops primaryT).` });
    }
    // R227 / R228 — Yahoo 2001-2026 for the reproduction; library series from the same Yahoo rows, restricted to 2016+ (library era)
    const yahoo = async (sym) => { const r = await fetch(`http://localhost:3002/api/yahoo/${sym}/history?days=20000&interval=1d`); if (!r.ok) throw new Error(`yahoo ${sym} ${r.status}`); const j = await r.json(); return j.bars.filter((b) => b.adjClose != null).map((b) => ({ d: b.date, c: b.adjClose })).sort((a, b) => (a.d < b.d ? -1 : 1)); };
    const yI = await yahoo("IWM"), yS = await yahoo("SPY"), iI = new Map(yI.map((b, i) => [b.d, i])), iS = new Map(yS.map((b, i) => [b.d, i]));
    const lastFri = (y, m) => { const last = new Date(Date.UTC(y, m, 0)); let d = last.getUTCDate(); while (new Date(Date.UTC(y, m - 1, d)).getUTCDay() !== 5) d--; return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10); };
    function ev(e0, x0, sign) { const out = []; for (let y = 2001; y <= 2026; y++) { const t = lastFri(y, 6); let eff = null; for (const b of yI) { if (b.d <= t) eff = b; else break; } if (!eff) continue; const g = iI.get(eff.d);
        const e = g + e0, x = g + x0; if (e < 0 || x >= yI.length) continue; const eS = iS.get(yI[e].d), xS = iS.get(yI[x].d); if (eS == null || xS == null) continue;
        out.push({ d: yI[x].d, r: sign * ((yI[x].c / yI[e].c - 1) - (yS[xS].c / yS[eS].c - 1)) - 0.0008 }); } return out; }
    const verdictT = (id) => +JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "data", "read-seals.json"), "utf8")).tests[id].verdict.match(/primary t (-?[\d.]+)/)[1];
    for (const [id, e0, x0, sign, nm, void_] of [["R227", -5, 0, 1, "VOID-FOR-COMBINATION — Russell recon run-up: long IWM / short SPY, eff-5 -> eff (last Friday of June)", true], ["R228", 0, 5, -1, "Russell recon reversal: long SPY / short IWM, eff -> eff+5", false]]) {
      const all = ev(e0, x0, sign), lib = all.filter((x) => x.d >= "2016-01-01" && x.d <= "2026-08-31");
      writeEntry({ id, name: nm, registryId: id, script: "backend/r225-r228-mine8.js", emitter: "backend/ensemble/emit/v2-etf-calendar.js", unit: "per-event", net: true, costModel: "8 bps round trip for the pair, as sealed",
        window: ["2016-01-04", "2026-08-31"], calendar: "us-equity", series: book(lib),
        reproduction: rep("sealed primary t over 2001-2026 (Yahoo adjClose), plain t of pair net", verdictT(id), tOf(all.map((x) => x.r))),
        construction: "One pair trade a year, booked on its exit session (the script has no daily mark). Library rows are the 2016-2026 events only (library era); the reproduction uses all years.",
        notes: `${void_ ? "VOID per operator 2026-09-25: month-of-year scan shows June not distinctive (May t 3.55, Sep t -2.87). Excluded from every combination. " : ""}${lib.length} library events of ${all.length}.` });
    }
  }
})().catch((e) => { console.error("FAILED:", e.stack); process.exit(1); });
