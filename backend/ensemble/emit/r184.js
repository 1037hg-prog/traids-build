#!/usr/bin/env node
"use strict";
/**
 * EMITTER R184 — Treasury auction cycle V (short IEF/TLT into the 10y/30y auction, long out of it). READ-ONLY.
 *
 * backend/r184-auction-cycle.js has an unguarded main that seals, so nothing is required from it. The EVENT LIST is the script's own
 * persisted output backend/data/r184-auction-cycle.json `auctions` (the 257 auctions kept after its fiscaldata filter and session/edge
 * exclusion: date, tenor, sym). Prices are re-fetched exactly as the script (line 92: IEF/TLT Alpaca SIP 1Day adjustment=all,
 * 2016-01-01..2026-09-15) to get the DAILY marks the persisted rows lack; evalAt (line 104) is COPIED for the reproduction.
 *
 * Per auction (a = auction-day session): leg 1 SHORT one unit notional from close a-5 to close a; leg 2 LONG one unit notional from
 * close a to close a+5 (the script nets post - pre, both legs unit notional). Daily marks: short days a-4..a pnl = -(C_k - C_k-1)/C_a-5,
 * long days a+1..a+5 pnl = (C_k - C_k-1)/C_a; 2 bps per side per leg = 2 bps on a-4, a, a+1, a+5 (first/last return day of each leg).
 * Each day's P&L is divided by the event's running capital, so an event's 10 days compound exactly to post - pre - 8 bps (the script's
 * net). Concurrent auctions (10y and 30y in the same week) are equal-weighted across the events open that day.
 */
const fs = require("fs"), path = require("path");
const { fetchBars } = require("../../lib/alpaca-bars.js");
const { writeEntry } = require("../lib-entry.js");

const P_START = "2016-01-01", P_END = "2026-09-15", COST_LEG = 0.0004, K = 5, SIDE = COST_LEG / 2;   // script lines 44-45
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const tstat = (a) => mean(a) / (sd(a) / Math.sqrt(a.length));

(async () => {
  const persisted = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "data", "r184-auction-cycle.json"), "utf8"));
  const events = persisted.auctions;
  const { bars } = await fetchBars(["IEF", "TLT"], { start: P_START, end: P_END + "T23:59:59Z", feed: "sip", adjustment: "all", timeframe: "1Day", requireAll: true, quiet: true });
  const S = {};
  for (const sym of ["IEF", "TLT"]) { const x = bars[sym].map((b) => ({ d: b.t.slice(0, 10), c: b.c })).filter((b) => b.d >= P_START && b.d <= P_END); S[sym] = { d: x.map((b) => b.d), c: x.map((b) => b.c), idx: new Map(x.map((b, i) => [b.d, i])) }; }
  // copied from backend/r184-auction-cycle.js line 104
  const evalAt = (sym, a) => { const c = S[sym].c; if (a - K < 0 || a + K >= c.length) return null; const pre = c[a] / c[a - K] - 1, post = c[a + K] / c[a] - 1; return { pre, post, leg1: -pre - COST_LEG, leg2: post - COST_LEG, net: post - pre - 2 * COST_LEG, gross: post - pre }; };

  const nets = [], byDate = new Map(); let maxNetDiff = 0, maxCompDiff = 0;
  for (const ev of events) {
    const s = S[ev.sym], a = s.idx.get(ev.date); if (a == null) throw new Error(`${ev.date} not a ${ev.sym} session`);
    const e = evalAt(ev.sym, a); if (!e) throw new Error(`${ev.date} edge`);
    nets.push(e.net); maxNetDiff = Math.max(maxNetDiff, Math.abs(e.net - ev.net));
    const c = s.c, steps = [];
    for (let k = a - K + 1; k <= a; k++) steps.push({ k, p: -(c[k] - c[k - 1]) / c[a - K] - (k === a - K + 1 ? SIDE : 0) - (k === a ? SIDE : 0) });
    for (let k = a + 1; k <= a + K; k++) steps.push({ k, p: (c[k] - c[k - 1]) / c[a] - (k === a + 1 ? SIDE : 0) - (k === a + K ? SIDE : 0) });
    let cap = 1; for (const st of steps) { const r = st.p / cap; cap += st.p; const d = s.d[st.k]; if (!byDate.has(d)) byDate.set(d, []); byDate.get(d).push(r); }
    maxCompDiff = Math.max(maxCompDiff, Math.abs(cap - 1 - e.net));
  }
  const series = [...byDate.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([d, rs]) => ({ d, r: mean(rs) }));
  const overlapDays = [...byDate.values()].filter((v) => v.length > 1).length;
  const t = tstat(nets), emitted = +t.toFixed(3), sealed = 0.533, tol = 0.02;
  console.log(`R184: ${events.length} auctions, t ${t} · max |net - persisted| ${maxNetDiff.toExponential(2)} · max |compound - net| ${maxCompDiff.toExponential(2)} · ${series.length} days (${overlapDays} with >1 event)`);
  writeEntry({
    id: "R184", name: "Treasury auction cycle V", registryId: "R184", script: "backend/r184-auction-cycle.js", emitter: "backend/ensemble/emit/r184.js",
    unit: "daily", net: true, costModel: "2 bps per side per leg (4 bps round trip per leg, 8 bps per auction), charged on the first and last return day of each leg",
    window: [S.IEF.d[0], series[series.length - 1].d > "2026-08-31" ? series[series.length - 1].d : "2026-08-31"], calendar: "us-equity", series,
    reproduction: { statistic: "primary t over auctions of net V (post - pre - 8 bps)", sealed, emitted, tolerance: tol, match: Math.abs(emitted - sealed) <= tol },
    construction: "Per auction: short one unit of IEF (10y) / TLT (30y) from close a-5 to close a, then long one unit from close a to close a+5, marked close-to-close daily on the event's running capital with 2 bps on each leg's first and last day; days where several auctions are open take the equal-weight mean of their daily returns.",
    notes: `Event list = the sealed script's persisted auctions (257, from fiscaldata); prices re-fetched. Recomputed per-auction net vs persisted max |diff| ${maxNetDiff.toExponential(1)}. ${overlapDays} days have 2+ concurrent auctions (10y and 30y auctions often fall in the same week), so the equal-weight daily series is not a strict sum of per-auction nets.`,
  });
})().catch((e) => { console.error("R184 emitter FAILED:", e.message); process.exit(1); });
