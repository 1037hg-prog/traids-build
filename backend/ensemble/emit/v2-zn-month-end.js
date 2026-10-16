#!/usr/bin/env node
"use strict";
/**
 * Library emitter (v2, 2026-09-25) — month-end Treasuries on 10-year note futures (ZN), the R180 rule levered on futures. READ-ONLY.
 *
 * Source: backend/futures-month-end.js (EXPLORATORY study, seals nothing) persists data/futures-month-end.json rowsOut[] = {m, tb, tre}:
 *   tre = ZN return over the month's last 5 sessions (close of the 6th-to-last -> close of the last), roll-guarded against IEF,
 *         minus 4 bps round trip and 2 bps per guarded roll day (the script's own cost model);
 *   tb  = 3-month T-bill (FRED DTB3 month-average yield / 12).
 * That file holds MONTHLY rows only; the daily ZN path is not persisted, so these entries use the "monthly" calendar.
 *
 * Entries written:
 *   TSY-ZN1X   the per-window futures net return (tre), unlevered, no collateral interest — the traded bet, for correlation.
 *   TSY-ZN5X   the book the operator examined: whole account in T-bills + 5 x tre (tb + 5 * tre) — raw net, as a NAV return.
 * Reproduction: the script's own treasury t (plain t of tre over all months) and its "Treasury 5x" all-window CAGR / maxDD.
 */
const fs = require("fs"), path = require("path");
const { writeEntry } = require("../lib-entry.js");
const J = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "data", "futures-month-end.json"), "utf8"));
const rows = J.rowsOut, mean = (a) => a.reduce((x, y) => x + y, 0) / a.length, sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const monthEnd = (m) => { const [y, mo] = m.split("-").map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };
const tOf = (a) => mean(a) / (sd(a) / Math.sqrt(a.length));
const tEm = +tOf(rows.map((r) => r.tre)).toFixed(2), tSealed = J.out.perTrade.treasury.t;
const book = rows.map((r) => r.tb + 5 * r.tre); let v = 1, pk = 1, dd = 0; for (const x of book) { v *= 1 + x; pk = Math.max(pk, v); dd = Math.min(dd, v / pk - 1); }
const cagr = +(100 * (v ** (12 / book.length) - 1)).toFixed(2), dd1 = +(100 * dd).toFixed(1), S5 = J.out.books["Treasury 5x"].all;
const window = [monthEnd(rows[0].m), monthEnd(rows[rows.length - 1].m)];
const common = { registryId: "R180", script: "backend/futures-month-end.js", emitter: "backend/ensemble/emit/v2-zn-month-end.js", unit: "per-event", net: true,
  costModel: "4 bps of notional per round trip + 2 bps per roll-guarded window day (futures-month-end.js); T-bill collateral from FRED DTB3", window, calendar: "monthly" };
writeEntry({ ...common, id: "TSY-ZN1X", name: "Month-end Treasuries on ZN futures, per-window net (unlevered, no collateral)",
  series: rows.map((r) => ({ d: monthEnd(r.m), r: r.tre })),
  reproduction: { statistic: "plain t of per-window net over all months (futures-month-end.json out.perTrade.treasury.t)", sealed: tSealed, emitted: tEm, tolerance: 0.02, match: Math.abs(tEm - tSealed) <= 0.02 },
  construction: "One row per month = the month's last-5-session ZN futures net return, dated on the month's last calendar day (monthly calendar).",
  notes: `EXPLORATORY source (not a sealed script): the evidence is R180 (sealed PASS on IEF). Yahoo continuous front-month ZN, not back-adjusted; ${J.out.rollGuardDays.ZN} window days replaced by beta x IEF as roll jumps. 2003-01..2026-08, ${rows.length} months.` });
writeEntry({ ...common, id: "TSY-ZN5X", name: "Month-end Treasuries on ZN futures, 5x overlay on a T-bill account (NAV return)",
  series: rows.map((r) => ({ d: monthEnd(r.m), r: r.tb + 5 * r.tre })),
  reproduction: { statistic: "'Treasury 5x' book, all months: CAGR% / maxDD% (futures-month-end.json out.books)", sealed: `${S5.cagrPct} / ${S5.maxDDPct}`, emitted: `${cagr} / ${dd1}`, tolerance: "0.05 / 0.1", match: Math.abs(cagr - S5.cagrPct) <= 0.05 && Math.abs(dd1 - S5.maxDDPct) <= 0.1 },
  construction: "NAV return per month = T-bill yield on the whole account + 5 x the month-end ZN window net (futures margin only; monthly rebalance to 5x NAV).",
  notes: "Leverage is a sizing choice, not an edge; this is the book-level stream used in the 2026-09-25 book stress. Raw net P&L (includes whatever term premium ZN earns in those 5 sessions; no drift is subtracted)." });
