#!/usr/bin/env node
"use strict";
/**
 * Library emitter (v2, 2026-09-25) — sealed tests whose own output persists dated rows. READ-ONLY; no sealed script is executed.
 *   R197 S&P 500 index changes (data/r197-sp500-changes.json primaryRows {date=E, n, bp})
 *   R199 quarter-end window dressing (data/r199-window-dressing.json quarters {tq, exitB, aNet, bNet} in %)
 *   R208 crypto weekend vs weekday (data/r208-crypto-weekend.json weeks {monday, weekend{BTC,ETH}, weekday{BTC,ETH}} in %)
 *   R209 BTC leads alts (data/r209-btc-lead-alts.json events {hour, netBps})
 *   R210 stablecoin supply growth -> BTC 7d (data/r210-stablecoin-flow.json blocks {start, excessNetPct}; drift in coverage.driftPct)
 * Series are the RAW TRADED net (no drift subtracted):
 *   R197  per event date, the mean over positions of dir x (stock 10-session return - SPY's) - 20 bps, booked on the exit session E+10
 *         (SPY session calendar). This is the SPY-hedged form (the sealed script charges no hedge cost; disclosed).
 *   R199  Leg A net on the quarter's last session, Leg B net on its exit session (long/short deciles, 0.8% per leg as sealed).
 *   R208  the tradeable "long weekend / short weekday" form (10 bps per side per switch): the short weekday leg (Mon 20:00 -> Thu 13:00
 *         UTC) booked on Thursday, the long weekend leg (Fri 20:00 -> Mon 13:00 UTC) on the following Monday; 20 bps per leg.
 *   R209  per UTC day, the mean net of that day's events (the sealed day-clustered unit).
 *   R210  long BTC for 7 days after each HIGH block start (C_d -> C_d+7), marked daily with Coinbase daily closes, 10 bps on the first
 *         and last day. Raw net = excessNetPct + drift (the sealed statistic subtracts a constant in-sample 7d drift; the library does not).
 */
const fs = require("fs"), path = require("path");
const { writeEntry } = require("../lib-entry.js");
const D = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "data", f), "utf8"));
const BM = path.join(__dirname, "..", "..", "data", "strategy-library", "_cache", "benchmarks");
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length, sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); }, tOf = (a) => mean(a) / (sd(a) / Math.sqrt(a.length));
function nw1(a) { const n = a.length, m = mean(a); let g0 = 0, g1 = 0; for (let i = 0; i < n; i++) { const e = a[i] - m; g0 += e * e; if (i) g1 += e * (a[i - 1] - m); } g0 /= n; g1 /= n; return m / Math.sqrt((g0 + g1) / n); }
const r3 = (x) => +x.toFixed(3);
function book(series) { const m = new Map(); for (const { d, r } of series) m.set(d, (m.get(d) || 0) + r); return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, r]) => ({ d, r })).filter((x) => x.r !== 0); }
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const EM = "backend/ensemble/emit/v2-persisted-rows.js";

// ---- R197 ----
{ const J = D("r197-sp500-changes.json"), cal = JSON.parse(fs.readFileSync(path.join(BM, "SPY-2026-09-23.json"), "utf8")).map((x) => x.d), ix = new Map(cal.map((d, i) => [d, i]));
  const rows = J.primaryRows, miss = rows.filter((r) => !ix.has(r.date)).length; if (miss) throw new Error(`R197: ${miss} event dates not on the SPY calendar`);
  const series = rows.map((r) => ({ d: cal[ix.get(r.date) + 10], r: r.bp / 1e4 })), tE = nw1(rows.map((r) => r.bp / 1e4));
  writeEntry({ id: "R197", name: "S&P 500 index changes — directional 10-session excess vs SPY after the effective date (hedged form)", registryId: "R197", script: "backend/r197-sp500-changes.js", emitter: EM,
    unit: "per-event", net: true, costModel: "20 bps round trip per position, as sealed (SPY hedge cost not charged)", window: [J.coverage && J.coverage.window ? J.coverage.window[0] : "2016-01-04", "2026-08-31"].map((d, i) => (i ? d : cal.find((x) => x >= d))), calendar: "us-equity", series: book(series),
    reproduction: { statistic: "sealed primary Newey-West lag-1 t over event dates", sealed: J.primary.tNW, emitted: r3(tE), tolerance: 0.02, match: Math.abs(tE - J.primary.tNW) <= 0.02 },
    construction: "Each effective date's mean position excess (persisted to 0.1 bp) booked on the session 10 after the event session; SPY-hedged, so it is a long/short-vs-SPY stream.",
    notes: `${rows.length} event dates. Persisted bp are rounded to 0.1 bp; the reproduction therefore carries rounding noise.` }); }

// ---- R199 ----
{ const J = D("r199-window-dressing.json"), Q = J.quarters, series = [];
  for (const q of Q) { series.push({ d: q.tq, r: q.aNet / 100 }, { d: q.exitB, r: q.bNet / 100 }); }
  const tE = tOf(Q.map((q) => q.net / 100));
  writeEntry({ id: "R199", name: "Quarter-end window dressing — long top / short bottom QTD decile into quarter-end, reversed for 5 sessions after", registryId: "R199", script: "backend/r199-window-dressing.js", emitter: EM,
    unit: "per-event", net: true, costModel: "0.8% per leg per quarter (4 x 20 bps), as sealed", window: [Q[0].f, "2026-08-31"], calendar: "us-equity", series: book(series),
    reproduction: { statistic: "sealed primary t of quarterly net", sealed: J.primary.t, emitted: r3(tE), tolerance: 0.02, match: Math.abs(tE - J.primary.t) <= 0.02 },
    construction: "Leg A (6th-to-last session -> quarter end) booked on the quarter's last session; Leg B (quarter end -> +5 sessions) on its exit session. No daily marks persisted.", notes: `${Q.length} quarters.` }); }

// ---- R208 ----
{ const J = D("r208-crypto-weekend.json"), W = J.weeks, C = 0.001, series = [], diffs = [];
  const pooled = (o) => mean(Object.values(o));
  for (const w of W) { series.push({ d: addDays(w.monday, 3), r: -pooled(w.weekday) / 100 - 2 * C }, { d: addDays(w.monday, 7), r: pooled(w.weekend) / 100 - 2 * C }); diffs.push((pooled(w.weekend) - pooled(w.weekday)) / 100 - 4 * C); }
  const tE = tOf(diffs), want = J.tradeable.longWeekendShortWeekday.t;
  writeEntry({ id: "R208", name: "Crypto weekend minus weekday — long BTC/ETH over the weekend window, short over the weekday window", registryId: "R208", script: "backend/r208-crypto-weekend.js", emitter: EM,
    unit: "per-event", net: true, costModel: "10 bps per side per switch (20 bps per leg), the sealed tradeable form", window: [W[0].monday, addDays(W[W.length - 1].monday, 7)], calendar: "crypto-24x7", series: book(series),
    reproduction: { statistic: "sealed tradeable longWeekendShortWeekday t (the primary is the gross two-sided difference)", sealed: want, emitted: r3(tE), tolerance: 0.02, match: Math.abs(tE - want) <= 0.02 },
    construction: "Short weekday leg (Mon 20:00 -> Thu 13:00 UTC, 65h) booked on Thursday; long weekend leg (Fri 20:00 -> Mon 13:00 UTC, 65h) booked on the following Monday. BTC/ETH equal weight.",
    notes: `${W.length} weeks. Persisted leg returns are rounded to 0.001%. Sealed primary (gross difference) t ${J.primary ? J.primary.t : "n/a"}.` }); }

// ---- R209 ----
{ const J = D("r209-btc-lead-alts.json"), by = new Map(); for (const e of J.events) { const d = e.hour.slice(0, 10); if (!by.has(d)) by.set(d, []); by.get(d).push(e.netBps / 1e4); }
  const series = [...by.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, v]) => ({ d, r: mean(v) })), tE = tOf(series.map((x) => x.r));
  const want = +JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "data", "read-seals.json"), "utf8")).tests.R209.verdict.match(/t (-?[\d.]+) vs bar/)[1];
  writeEntry({ id: "R209", name: "BTC leads alts — after a >=1.5% BTC hour, alt basket vs opposite BTC leg for 2h", registryId: "R209", script: "backend/r209-btc-lead-alts.js", emitter: EM,
    unit: "per-event", net: true, costModel: "40 bps round trip total, as sealed", window: [J.window[0].slice(0, 10), J.window[1].slice(0, 10)], calendar: "crypto-24x7", series: book(series),
    reproduction: { statistic: "sealed primary t over event-days (day-clustered mean)", sealed: want, emitted: r3(tE), tolerance: 0.02, match: Math.abs(tE - want) <= 0.02 },
    construction: "Per UTC day, the mean net of that day's 2-hour events (the sealed day-clustered unit).", notes: `${J.events.length} events on ${series.length} days.` }); }

// ---- R210 ----
{ const J = D("r210-stablecoin-flow.json"), drift = J.coverage.driftPct / 100, btc = JSON.parse(fs.readFileSync(path.join(BM, "BTC-2026-09-23.json"), "utf8")), px = new Map(btc.map((x) => [x.d, x.c]));
  const series = [], diffs = [];
  for (const b of J.blocks) { const raw7 = b.excessNetPct / 100 + drift + 0.002; let g = 1;
    for (let k = 1; k <= 7; k++) { const d = addDays(b.start, k), p = addDays(b.start, k - 1); if (!px.has(d) || !px.has(p)) throw new Error(`R210: no BTC close ${d}`); const r = px.get(d) / px.get(p) - 1; g *= 1 + r; series.push({ d, r: r - (k === 1 || k === 7 ? 0.001 : 0) }); }
    diffs.push(Math.abs(g - 1 - raw7)); }
  const tE = nw1(J.blocks.map((b) => b.excessNetPct / 100)), maxDiff = Math.max(...diffs);
  writeEntry({ id: "R210", name: "Stablecoin supply growth — long BTC 7 days after a top-20% supply-growth day (raw traded)", registryId: "R210", script: "backend/r210-stablecoin-flow.js", emitter: EM,
    unit: "per-event", net: true, costModel: "10 bps per side, as sealed", window: [J.blocks[0].start, "2026-08-31"], calendar: "crypto-24x7", series: book(series),
    reproduction: { statistic: "sealed NW(1) t of block excess over the 7d drift; plus max |block 7d return (library BTC closes) - persisted (excess + drift + 20bps)|", sealed: J.primary.tNW1, emitted: r3(tE), tolerance: 0.02,
      maxBlockDiffPct: r3(100 * maxDiff), match: Math.abs(tE - J.primary.tNW1) <= 0.02 && maxDiff < 0.001 },
    construction: "Each HIGH block: long BTC from the close of the signal day for 7 UTC days, marked daily on Coinbase closes; 10 bps on the first and last day. Raw (no drift subtracted).",
    notes: `${J.blocks.length} blocks. The sealed statistic subtracted a constant ${J.coverage.driftPct}% 7d drift (in-sample, all signal days); the library stream is raw, so it carries BTC beta.` }); }
